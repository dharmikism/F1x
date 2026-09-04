"""Featherless AI integration kept independent from the web layer."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
import logging

import httpx

logger = logging.getLogger("fixonce.featherless")


@dataclass
class Generation:
    solution: str
    category: str
    latency_ms: int
    provider: str
    used_fallback: bool = False


FALLBACKS = {
    "workplace IT": "Start with the least disruptive checks: reconnect the affected app or device, confirm the account/network state, then restart the relevant client. If the issue persists, capture the exact error and escalate with those details.",
    "software setup": "Confirm the required runtime is installed, refresh the package index, and install dependencies from the project lockfile. Restart the terminal or IDE after changing environment variables.",
    "developer tools": "Confirm the remote URL and credentials, then retry with verbose output. Refresh the credential or SSH key in your approved credential manager and test the connection before repeating the operation.",
    "hackathon": "Check the submission requirements and deployment logs, then reproduce the issue with the smallest possible request. Confirm environment variables are configured in the deployment platform rather than only on your laptop.",
    "general": "Break the problem into a small reproducible test, check the most recent configuration change, and retry after restarting the affected client. Keep the exact error message if you need to ask for help.",
}


def _category(problem: str) -> str:
    text = problem.lower()
    if any(word in text for word in ("git", "github", "repository", "ssh")):
        return "developer tools"
    if any(word in text for word in ("install", "package", "dependency", "npm", "pip")):
        return "software setup"
    if any(word in text for word in ("submission", "hackathon", "deploy", "deployment", "vercel")):
        return "hackathon"
    if any(word in text for word in ("wifi", "vpn", "printer", "network", "internet")):
        return "workplace IT"
    return "general"


def _clean_solution(content: str) -> str:
    content = content.strip()
    if content.startswith("```"):
        content = content.strip("`").strip()
    return content


def generate_solution(problem: str) -> Generation:
    started = time.perf_counter()
    api_key = os.getenv("FEATHERLESS_API_KEY", "").strip()
    model = os.getenv("FEATHERLESS_MODEL", "Qwen/Qwen2.5-7B-Instruct")
    base_url = os.getenv("FEATHERLESS_BASE_URL", "https://api.featherless.ai/v1").rstrip("/")
    category = _category(problem)

    if api_key:
        prompt = (
            "You are generating a concise, practical troubleshooting fix for a community knowledge base. "
            "This is not a conversation. Return a short title on the first line, then 3 to 5 numbered steps. "
            "Do not request passwords or private data. Problem: " + problem
        )
        try:
            response = httpx.post(
                f"{base_url}/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": model,
                    "messages": [
                        {"role": "system", "content": "You write verified-looking drafts that must be tested by a human before sharing."},
                        {"role": "user", "content": prompt},
                    ],
                    "temperature": 0.2,
                    "max_tokens": 280,
                },
                timeout=18.0,
            )
            response.raise_for_status()
            body = response.json()
            content = body["choices"][0]["message"]["content"]
            return Generation(
                solution=_clean_solution(content),
                category=category,
                latency_ms=max(1, round((time.perf_counter() - started) * 1000)),
                provider=f"Featherless · {model.split('/')[-1]}",
            )
        except Exception as error:
            # The app remains usable during a provider outage; the UI makes the
            # provider fallback explicit instead of presenting a false API claim.
            logger.warning("Featherless request failed; using local fallback: %s", type(error).__name__)

    return Generation(
        solution=FALLBACKS.get(category, FALLBACKS["general"]),
        category=category,
        latency_ms=max(1, round((time.perf_counter() - started) * 1000)),
        provider="Featherless AI · demo fallback",
        used_fallback=True,
    )
