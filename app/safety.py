from __future__ import annotations

import re


SENSITIVE_TERMS = (
    "password", "passcode", "bank account", "credit card", "social security", "private message",
    "medical record", "diagnosis", "patient", "hr complaint", "salary", "personal data",
)
DYNAMIC_TERMS = (
    "today", "right now", "current", "latest", "live", "stock price", "weather", "meeting schedule",
    "sports score", "news", "election",
)


def classify(text: str) -> dict[str, object]:
    lowered = re.sub(r"\s+", " ", text.lower()).strip()
    sensitive = any(term in lowered for term in SENSITIVE_TERMS)
    dynamic = any(term in lowered for term in DYNAMIC_TERMS)
    return {
        "safe_to_reuse": not sensitive and not dynamic,
        "sensitive": sensitive,
        "dynamic": dynamic,
        "reason": "This looks personal or sensitive, so it will not be saved to community memory." if sensitive else
        "This looks time-sensitive, so it will not be reused as a community fix." if dynamic else None,
    }

