"""Featherless AI integration kept independent from the web layer."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
import logging
import json
import re

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
    "workplace IT": {"title": "Reconnect and isolate the connection", "why": "A connected status can remain while the session, DNS, or client route is stale.", "steps": ["Reconnect the affected app or device.", "Sign out and back in to refresh the session.", "Retry the smallest internal action and capture the exact error.", "If the issue persists, switch networks once and retry."], "verify": "The original internal page or action works twice in a row.", "if_not_working": "Keep the exact error, timestamp, and network used, then escalate to the service owner."},
    "software setup": {"title": "Reset the project environment", "why": "Fresh environments often fail when the active runtime does not match the project dependencies.", "steps": ["Create and activate a project virtual environment.", "Upgrade the package manager.", "Install from the lockfile or requirements file.", "Restart the terminal or IDE so it uses the new interpreter."], "verify": "Run the project’s smallest install or test command successfully.", "if_not_working": "Copy the first dependency error and check the required runtime version before retrying."},
    "developer tools": {"title": "Refresh the repository credentials", "why": "Push failures usually come from a stale remote URL or credential that no longer matches the repository.", "steps": ["Confirm the remote URL and repository access.", "Test the connection with verbose output.", "Refresh the approved SSH key or token in your credential manager.", "Retry the smallest push or read operation."], "verify": "A read-only repository command and then the intended operation both succeed.", "if_not_working": "Share the non-secret error and remote hostname with the repository owner."},
    "hackathon": {"title": "Reproduce the deployed failure", "why": "A green build does not guarantee that production has the right output path or environment variables.", "steps": ["Open the deployment runtime logs.", "Confirm the production build command and output directory.", "Add required environment variables in the hosting platform.", "Redeploy and test the production URL in a private window."], "verify": "The deployed page loads and the primary user action works.", "if_not_working": "Save the deployment log link and exact production URL for the next troubleshooting pass."},
    "general": {"title": "Make the problem reproducible", "why": "A small repeatable test reveals whether the issue is caused by state, configuration, or the service itself.", "steps": ["Write down the smallest action that fails.", "Check the most recent configuration change.", "Restart only the affected client and retry.", "Keep the exact error message if you need to ask for help."], "verify": "The same small test passes twice without an unexplained workaround.", "if_not_working": "Record what changed, what you tried, and the exact error before escalating."},
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


def _structured_solution(content: str, category: str) -> str:
    """Normalize Featherless JSON (or plain text) into a practical playbook."""
    raw = content.strip()
    candidate = raw.strip("`").strip()
    if not candidate.startswith("{"):
        match = re.search(r"\{.*\}", candidate, re.DOTALL)
        candidate = match.group(0) if match else ""
    try:
        data = json.loads(candidate)
        title = str(data.get("title") or "Suggested troubleshooting fix").strip()
        why = str(data.get("why") or "").strip()
        steps = [str(step).strip() for step in (data.get("steps") or []) if str(step).strip()]
        verify = str(data.get("verify") or "Retry the original action and confirm it works twice.").strip()
        alternate = str(data.get("if_not_working") or "Capture the exact error and try an alternate path.").strip()
        if len(steps) >= 2:
            parts = [title]
            if why:
                parts.append(f"Why this helps: {why}")
            parts.append("Steps:\n" + "\n".join(f"{index}. {step}" for index, step in enumerate(steps, 1)))
            parts.append(f"Verify: {verify}")
            parts.append(f"If it doesn't work: {alternate}")
            return "\n\n".join(parts)
    except (AttributeError, TypeError, ValueError, json.JSONDecodeError):
        pass
    return _clean_solution(content)


def _fallback_solution(category: str, alternative: bool = False) -> str:
    data = FALLBACKS.get(category, FALLBACKS["general"])
    title = f"Alternative path: {data['title']}" if alternative else data["title"]
    return "\n\n".join([
        title,
        f"Why this helps: {data['why']}",
        "Steps:\n" + "\n".join(f"{index}. {step}" for index, step in enumerate(data["steps"], 1)),
        f"Verify: {data['verify']}",
        f"If it doesn't work: {data['if_not_working']}",
    ])


def generate_solution(problem: str, previous_solution: str | None = None, failure_note: str | None = None) -> Generation:
    started = time.perf_counter()
    api_key = os.getenv("FEATHERLESS_API_KEY", "").strip()
    model = os.getenv("FEATHERLESS_MODEL", "Qwen/Qwen2.5-7B-Instruct")
    base_url = os.getenv("FEATHERLESS_BASE_URL", "https://api.featherless.ai/v1").rstrip("/")
    category = _category(problem)

    if api_key:
        context = ""
        if previous_solution:
            context = f"\nA previous community fix was tried but did not work:\n{previous_solution}\nFailure note: {failure_note or 'The user reported that it did not solve the problem.'}"
        prompt = (
            "You are generating a concise, practical troubleshooting playbook for a community knowledge base. "
            "This is not a conversation. Return valid JSON only with exactly these keys: title, why, steps, verify, if_not_working. "
            "steps must contain 3 to 5 safe, numbered-action strings. Do not request passwords or private data. "
            "Make the alternative genuinely different from the previous fix when one is provided. Problem: " + problem + context
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
                solution=_structured_solution(content, category),
                category=category,
                latency_ms=max(1, round((time.perf_counter() - started) * 1000)),
                provider=f"Featherless · {model.split('/')[-1]}",
            )
        except Exception as error:
            # The app remains usable during a provider outage; the UI makes the
            # provider fallback explicit instead of presenting a false API claim.
            logger.warning("Featherless request failed; using local fallback: %s", type(error).__name__)

    return Generation(
        solution=_fallback_solution(category, alternative=bool(previous_solution)),
        category=category,
        latency_ms=max(1, round((time.perf_counter() - started) * 1000)),
        provider="Featherless AI · demo fallback",
        used_fallback=True,
    )
