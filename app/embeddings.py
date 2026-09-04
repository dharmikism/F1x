"""Small, dependency-light semantic embedding and vector search service.

The default embedder is intentionally local so the MVP works offline. It uses
hashed word/character n-grams, a compact domain synonym lexicon, and explicit
issue fingerprints for common support problems. The fingerprints are useful
when two questions share very few words but describe the same situation, while
cosine similarity still keeps unrelated questions out. A hosted embedding
provider can be added behind this same interface later without changing API or
storage code.
"""

from __future__ import annotations

import hashlib
import math
import re
from collections import Counter
from typing import Iterable

DIMENSIONS = 384

SYNONYMS = {
    "wifi": {"wifi", "wi-fi", "wireless", "network", "internet", "websites", "browsing"},
    "internet": {"internet", "online", "websites", "browse", "browsing", "connectivity"},
    "vpn": {"vpn", "tunnel", "remote", "access", "dns"},
    "printer": {"printer", "printing", "print", "queue", "spooler"},
    "git": {"git", "github", "repository", "repo", "ssh", "authentication", "auth"},
    "install": {"install", "installation", "setup", "package", "dependency", "pip", "npm"},
    "certificate": {"certificate", "cert", "ssl", "tls", "browser", "security"},
    "deploy": {"deploy", "deployment", "hosting", "production", "build", "vercel"},
    "key": {"key", "token", "secret", "api", "environment", "env", "credential"},
    "blank": {"blank", "empty", "white", "ui", "screen", "page", "site", "app", "production"},
    "queue": {"queue", "stuck", "waiting", "frozen", "jobs", "documents"},
    "internal": {"internal", "intranet", "company", "corporate", "tools", "apps"},
}

STOPWORDS = {
    "a", "an", "and", "are", "but", "can", "cannot", "could", "do", "does", "for", "from",
    "get", "have", "i", "im", "in", "is", "it", "my", "no", "not", "of", "on", "or", "our",
    "the", "this", "to", "unable", "with", "without", "you", "your", "s", "t",
}

# These are phrases and concepts rather than a list of exact example
# questions. They let "wireless is connected but sites won't load" line up
# with "Wi-Fi works, however there is no internet" without making all
# networking questions equivalent.
CONCEPT_PHRASES = {
    "network": ("wifi", "wireless", "network", "internet", "online", "website", "websites", "web page", "web pages", "browse", "browsing", "connectivity", "connection"),
    "no_web_access": ("no internet", "cannot browse", "cannot access internet", "cannot access the internet", "cannot access websites", "cannot reach internet", "cannot reach the internet", "no access to internet", "will not load", "does not load", "do not load", "not loading", "will not open", "does not open", "do not open", "not open", "offline", "no web access", "no connectivity", "internet unavailable", "internet access unavailable", "internet not working", "web unavailable", "websites inaccessible", "nothing loads"),
    "vpn_remote": ("vpn", "virtual private network", "tunnel", "remote access", "remote network"),
    "internal_access": ("internal", "intranet", "company site", "company sites", "company tools", "corporate", "internal tools", "internal apps", "work apps"),
    "printer": ("printer", "printing", "print", "printer is on", "printer is online"),
    "print_queue": ("queue", "print job", "print jobs", "spooler", "stuck", "wait", "waits", "waiting", "wait forever", "never leaves", "never leave", "frozen", "nothing prints", "does not print", "will not print", "not printing", "never prints", "cannot print"),
    "git_repository": ("git", "github", "repository", "repo", "git remote", "ssh key"),
    "auth_failure": ("permission denied", "access denied", "not accepted", "unauthorized", "rejected", "rejecting", "credentials", "credential", "authenticate", "authentication", "ssh key", "403"),
    "installation": ("install", "installation", "setup", "package", "packages", "dependency", "dependencies", "pip", "npm", "virtual environment"),
    "deployment": ("deploy", "deployed", "deployment", "deployment succeeded", "hosted", "hosting", "hosted app", "production", "production app", "live site", "live website", "build"),
    "blank_ui": ("blank", "empty", "white page", "white screen", "no ui", "nothing on the page", "page is empty", "screen is empty"),
    "certificate_tls": ("certificate", "cert", "ssl", "tls", "https", "security warning"),
    "certificate_issue": ("invalid", "untrusted", "expired", "blocked", "warning", "not secure"),
}

INTENT_SIGNATURES = {
    "network_no_web": ("network", "no_web_access"),
    "vpn_internal": ("vpn_remote", "internal_access"),
    "printer_queue": ("printer", "print_queue"),
    "git_auth": ("git_repository", "auth_failure"),
    "install_dependency": ("installation",),
    "deploy_blank": ("deployment", "blank_ui"),
    "certificate_blocked": ("certificate_tls", "certificate_issue"),
}


def normalize(text: str) -> str:
    text = text.lower()
    # Preserve the meaning of common contractions before punctuation is
    # stripped ("can't browse" -> "cannot browse").
    for contraction, expanded in {
        "can't": "cannot",
        "won't": "will not",
        "isn't": "is not",
        "doesn't": "does not",
        "don't": "do not",
        "aren't": "are not",
        "i'm": "i am",
    }.items():
        text = text.replace(contraction, expanded)
    text = text.replace("wi-fi", "wifi")
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _tokens(text: str) -> list[str]:
    raw = normalize(text).split()
    expanded = list(raw)
    for token in raw:
        for concept, words in SYNONYMS.items():
            if token in words:
                expanded.append(concept)
                expanded.extend(words)
    return [token for token in expanded if token not in STOPWORDS and len(token) > 1]


def _bucket(value: str, salt: str = "") -> int:
    digest = hashlib.blake2b(f"{salt}:{value}".encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(digest, "big") % DIMENSIONS


def _semantic_concepts(normalized: str) -> set[str]:
    padded = f" {normalized} "
    concepts: set[str] = set()
    for concept, phrases in CONCEPT_PHRASES.items():
        if any(f" {normalize(phrase)} " in padded for phrase in phrases):
            concepts.add(concept)

    # A few natural-language versions of the same support intent do not have
    # a stable keyword, so add a small amount of contextual interpretation.
    words = set(normalized.split())
    if {"connected", "connects", "active", "on"} & words and {"unavailable", "unreachable", "timeout", "timeouts", "fails"} & words:
        concepts.add("no_web_access")
    if {"cannot", "unable"} & words and {"access", "reach"} & words and {"internet", "website", "websites", "web"} & words:
        concepts.add("no_web_access")
    if {"internal", "intranet", "corporate", "company"} & words and {"unavailable", "unreachable", "fails", "timeout", "timeouts"} & words:
        concepts.add("internal_access")
    return concepts


def embed(text: str) -> list[float]:
    """Create a normalized dense vector suitable for cosine retrieval."""
    tokens = _tokens(text)
    vector = [0.0] * DIMENSIONS
    counts = Counter(tokens)

    for token, count in counts.items():
        vector[_bucket(token, "word")] += 1.0 + math.log1p(count)
        # Character n-grams make paraphrases more resilient to morphology and typos.
        padded = f"^{token}$"
        for index in range(max(0, len(padded) - 2)):
            vector[_bucket(padded[index:index + 3], "tri")] += 0.18

    # Phrase-level intent anchors improve the important recurring-problem examples.
    normalized = normalize(text)
    anchors = (
        ("wifi", ("wifi", "wireless", "internet")),
        ("vpn", ("vpn", "tunnel", "remote access")),
        ("printer", ("printer", "printing")),
        ("git", ("git", "github", "repository")),
        ("install", ("install", "package", "dependency")),
        ("certificate", ("certificate", "ssl", "tls")),
        ("deploy", ("deploy", "deployment", "hosting")),
        ("blank", ("blank", "empty", "white page", "no ui")),
        ("api-key", ("api key", "token", "environment variable")),
    )
    for anchor, phrases in anchors:
        if any(phrase in normalized for phrase in phrases):
            vector[_bucket(anchor, "anchor")] += 3.0

    concepts = _semantic_concepts(normalized)
    for concept in concepts:
        # Semantic concepts have more weight than a single shared word, but
        # raw words and character n-grams still contribute to ranking.
        vector[_bucket(concept, "semantic")] += 4.0

    for signature, required_concepts in INTENT_SIGNATURES.items():
        if all(concept in concepts for concept in required_concepts):
            # A shared multi-part issue signature is the strongest signal for
            # paraphrases such as "VPN is on" vs "remote tunnel is active".
            vector[_bucket(signature, "intent")] += 7.0

    magnitude = math.sqrt(sum(value * value for value in vector)) or 1.0
    return [round(value / magnitude, 8) for value in vector]


def cosine(left: Iterable[float], right: Iterable[float]) -> float:
    return max(-1.0, min(1.0, sum(a * b for a, b in zip(left, right))))
