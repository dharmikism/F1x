"""Small, dependency-light semantic embedding and vector search service.

The default embedder is intentionally local so the MVP works offline. It uses
hashed word/character n-grams plus a compact domain synonym lexicon, then
cosine similarity for retrieval. A hosted embedding provider can be added
behind this same interface later without changing API or storage code.
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


def normalize(text: str) -> str:
    text = text.lower().replace("wi-fi", "wifi")
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

    magnitude = math.sqrt(sum(value * value for value in vector)) or 1.0
    return [round(value / magnitude, 8) for value in vector]


def cosine(left: Iterable[float], right: Iterable[float]) -> float:
    return max(-1.0, min(1.0, sum(a * b for a, b in zip(left, right))))
