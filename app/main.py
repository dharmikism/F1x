from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

# Must run before importing modules that read configuration at import time.
from . import config  # noqa: F401
from .db import Database
from .embeddings import cosine, embed
from .featherless import generate_solution
from .safety import classify


ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
THRESHOLD = float(os.getenv("SIMILARITY_THRESHOLD", "0.64"))
ALLOWED_ORIGINS = [origin.strip() for origin in os.getenv("ALLOWED_ORIGINS", "*").split(",") if origin.strip()]

app = FastAPI(title="FixOnce API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS or ["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
db = Database()
db.seed()


class FindFixRequest(BaseModel):
    problem: str = Field(min_length=3, max_length=1000)


class SaveSolutionRequest(BaseModel):
    problem: str = Field(min_length=3, max_length=1000)
    solution: str = Field(min_length=10, max_length=15000)
    category: str = Field(default="general", max_length=80)
    source: str = Field(default="User saved from an AI answer", max_length=120)


class AutoCaptureRequest(BaseModel):
    problem: str = Field(min_length=3, max_length=1000)
    solution: str = Field(min_length=10, max_length=15000)
    capture_key: str = Field(min_length=8, max_length=500)
    source: str = Field(default="Automatically captured from ChatGPT or Claude", max_length=120)


class DeleteAllKnowledgeRequest(BaseModel):
    confirmation: str = Field(min_length=10, max_length=20)


class VerifyRequest(BaseModel):
    solved: bool


class FeedbackRequest(BaseModel):
    helpful: bool
    note: str | None = Field(default=None, max_length=500)


class AlternativeRequest(BaseModel):
    problem: str = Field(min_length=3, max_length=1000)
    note: str | None = Field(default=None, max_length=500)


def format_knowledge(row: Any, similarity: float | None = None) -> dict[str, Any]:
    data = db.public_knowledge(row)
    data["similarity"] = round(similarity, 3) if similarity is not None else None
    data["confidence_percent"] = round(float(data.get("confidence", 0.8)) * 100)
    return data


def find_match(problem: str) -> tuple[Any | None, float, int]:
    started = time.perf_counter()
    query_vector = embed(problem)
    best_row = None
    best_score = -1.0
    for row in db.all_shared_vectors():
        score = cosine(query_vector, json.loads(row["embedding"]))
        if score > best_score:
            best_row, best_score = row, score
    latency = max(1, round((time.perf_counter() - started) * 1000))
    return (best_row if best_score >= THRESHOLD else None), max(0.0, best_score), latency


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "service": "fixonce",
        "threshold": THRESHOLD,
        "featherless_configured": bool(os.getenv("FEATHERLESS_API_KEY", "").strip()),
        "featherless_model": os.getenv("FEATHERLESS_MODEL", "Qwen/Qwen2.5-7B-Instruct"),
    }


@app.post("/api/search-memory")
def search_memory(payload: FindFixRequest):
    """Lookup-only endpoint used while a supported AI prompt is being typed.

    It never calls Featherless, creates a draft, or increments reuse. This is
    what lets the original ChatGPT/Claude request continue normally on a miss.
    """
    problem = payload.problem.strip()
    if not problem:
        raise HTTPException(status_code=422, detail="Describe the problem first.")
    safety = classify(problem)
    if not safety["safe_to_reuse"]:
        return {"result_type": "blocked", "problem": problem, "safety": safety}
    row, similarity, search_latency = find_match(problem)
    if not row:
        return {"result_type": "miss", "problem": problem, "search_latency_ms": search_latency, "safety": safety}
    return {
        "result_type": "known",
        "problem": problem,
        "knowledge": format_knowledge(row, similarity),
        "search_latency_ms": search_latency,
        "ai_called": False,
        "safety": safety,
    }


@app.post("/api/find-fix")
def find_fix(payload: FindFixRequest):
    problem = payload.problem.strip()
    if not problem:
        raise HTTPException(status_code=422, detail="Describe the problem first.")
    safety = classify(problem)
    started = time.perf_counter()

    if not safety["safe_to_reuse"]:
        generation = generate_solution(problem)
        latency = max(1, round((time.perf_counter() - started) * 1000))
        db.record_query(problem, "blocked", None, None, latency, generation.latency_ms)
        return {
            "result_type": "blocked",
            "problem": problem,
            "safety": safety,
            "suggestion": generation.solution,
            "provider": generation.provider,
            "latency_ms": latency,
            "ai_latency_ms": generation.latency_ms,
        }

    row, similarity, search_latency = find_match(problem)
    if row:
        db.record_use(row["id"])
        total_latency = max(1, round((time.perf_counter() - started) * 1000))
        db.record_query(problem, "known", row["id"], similarity, total_latency)
        return {
            "result_type": "known",
            "problem": problem,
            "knowledge": format_knowledge(row, similarity),
            "search_latency_ms": search_latency,
            "latency_ms": total_latency,
            "ai_called": False,
            "ai_generations_avoided": 1,
            "safety": safety,
        }

    generation = generate_solution(problem)
    draft_id = db.create_draft(problem, generation.solution, generation.category, generation.provider)
    total_latency = max(1, round((time.perf_counter() - started) * 1000))
    db.record_query(problem, "new", draft_id, similarity, total_latency, generation.latency_ms)
    return {
        "result_type": "new",
        "problem": problem,
        "draft_id": draft_id,
        "suggestion": generation.solution,
        "category": generation.category,
        "provider": generation.provider,
        "search_latency_ms": search_latency,
        "latency_ms": total_latency,
        "ai_latency_ms": generation.latency_ms,
        "ai_called": not generation.used_fallback,
        "fallback": generation.used_fallback,
        "safety": safety,
    }


@app.post("/api/knowledge/save")
def save_solution(payload: SaveSolutionRequest):
    problem = payload.problem.strip()
    solution = payload.solution.strip()
    if not problem or not solution:
        raise HTTPException(status_code=422, detail="Both the problem and solution are required.")
    draft_id = db.create_draft(problem, solution, payload.category.strip() or "general", payload.source.strip() or "User saved solution")
    return {
        "result_type": "new",
        "draft_id": draft_id,
        "problem": problem,
        "suggestion": solution,
        "category": payload.category.strip() or "general",
        "provider": payload.source.strip() or "User saved solution",
        "message": "Solution saved as a private draft. Verify it before sharing.",
    }


@app.post("/api/knowledge/auto-save")
def auto_save_solution(payload: AutoCaptureRequest):
    problem = payload.problem.strip()
    solution = payload.solution.strip()
    capture_key = payload.capture_key.strip()
    safety = classify(problem)
    if not safety["safe_to_reuse"]:
        return {
            "result_type": "blocked",
            "problem": problem,
            "message": "This response was not saved because the problem looks personal or time-sensitive.",
            "safety": safety,
        }
    draft_id, updated = db.save_auto_capture(
        problem,
        solution,
        "general",
        payload.source.strip() or "Automatically captured from ChatGPT or Claude",
        capture_key,
    )
    return {
        "result_type": "new",
        "auto_captured": True,
        "updated": updated,
        "draft_id": draft_id,
        "problem": problem,
        "suggestion": solution,
        "category": "general",
        "provider": payload.source.strip() or "Automatically captured from ChatGPT or Claude",
        "message": "Latest AI response saved as a private draft. Verify it before sharing.",
    }


@app.post("/api/knowledge/{knowledge_id}/alternative")
def alternative_solution(knowledge_id: int, payload: AlternativeRequest):
    original = db.get_knowledge(knowledge_id)
    if not original:
        raise HTTPException(status_code=404, detail="That solution no longer exists.")
    started = time.perf_counter()
    failure_note = payload.note.strip() if payload.note else "The previous fix did not solve the problem on this device."
    generation = generate_solution(payload.problem.strip(), previous_solution=original["solution"], failure_note=failure_note)
    draft_id = db.create_draft(
        payload.problem.strip(),
        generation.solution,
        original["category"],
        generation.provider,
        related_knowledge_id=knowledge_id,
    )
    db.record_feedback(knowledge_id, False, failure_note)
    latency = max(1, round((time.perf_counter() - started) * 1000))
    db.record_query(payload.problem.strip(), "new", draft_id, None, latency, generation.latency_ms)
    return {
        "result_type": "new",
        "alternative": True,
        "draft_id": draft_id,
        "problem": payload.problem.strip(),
        "suggestion": generation.solution,
        "category": original["category"],
        "provider": generation.provider,
        "latency_ms": latency,
        "ai_latency_ms": generation.latency_ms,
        "ai_called": not generation.used_fallback,
        "fallback": generation.used_fallback,
        "related_knowledge_id": knowledge_id,
    }


@app.post("/api/knowledge/{knowledge_id}/verify")
def verify(knowledge_id: int, payload: VerifyRequest):
    row = db.verify(knowledge_id, payload.solved)
    if not row:
        raise HTTPException(status_code=404, detail="That solution no longer exists.")
    if not payload.solved:
        return {"verified": False, "message": "Kept private. It was not added as a verified fix."}
    return {"verified": True, "knowledge": format_knowledge(row), "message": "Solution verified. Sharing is still optional."}


@app.post("/api/knowledge/{knowledge_id}/share")
def share(knowledge_id: int):
    row = db.share(knowledge_id)
    if not row or not row["verified"]:
        raise HTTPException(status_code=409, detail="Verify the solution before sharing it.")
    return {"shared": True, "knowledge": format_knowledge(row), "message": "Added to Community Memory"}


@app.post("/api/knowledge/{knowledge_id}/feedback")
def feedback(knowledge_id: int, payload: FeedbackRequest):
    if not db.get_knowledge(knowledge_id):
        raise HTTPException(status_code=404, detail="That solution no longer exists.")
    db.record_feedback(knowledge_id, payload.helpful, payload.note)
    return {"ok": True}


@app.get("/api/knowledge")
def knowledge():
    return {"items": db.list_knowledge()}


@app.delete("/api/knowledge")
def delete_all_knowledge(payload: DeleteAllKnowledgeRequest):
    if payload.confirmation.strip() != "DELETE ALL":
        raise HTTPException(status_code=400, detail='Type "DELETE ALL" to permanently remove all saved solutions.')
    deleted_count = db.delete_all_knowledge()
    return {
        "deleted_count": deleted_count,
        "message": f"Deleted {deleted_count} saved solution(s). Query analytics were preserved.",
    }


@app.get("/api/stats")
def stats():
    return db.stats()


SIMULATION_GROUPS = [
    {
        "root": "wifi",
        "canonical": "Office Wi-Fi connected but internet is unavailable",
        "variants": ["Wi-Fi says connected but I cannot browse", "Laptop is on wireless but websites will not load", "Connected to office network, no internet access", "Wireless works but there is no web connectivity", "My office internet stopped while Wi-Fi still shows connected"],
    },
    {
        "root": "vpn",
        "canonical": "VPN connects but internal tools are unreachable",
        "variants": ["Remote tunnel is on but I cannot open internal tools", "VPN says connected and company sites time out", "Internal access fails even though the VPN is active", "The remote network is connected but intranet pages do not load", "I am on the VPN but internal apps are unavailable"],
    },
    {
        "root": "git",
        "canonical": "Git push is rejected because authentication fails",
        "variants": ["I cannot push to the repository with my SSH key", "GitHub keeps rejecting my credentials", "Repository push says permission denied", "My Git remote will not authenticate", "SSH works locally but Git push is denied"],
    },
    {
        "root": "printer",
        "canonical": "Printer is online but documents are stuck in the queue",
        "variants": ["The office printer is available but nothing prints", "Print jobs keep waiting even though the printer is on", "Printer queue is frozen", "Documents never leave the shared printer queue", "I sent a file and the printer does not process it"],
    },
    {
        "root": "install",
        "canonical": "Package installation fails in a new project environment",
        "variants": ["Pip cannot install this dependency", "The npm setup breaks on a fresh project", "My project packages will not install", "Dependency installation throws an error", "A clean environment cannot resolve the packages"],
    },
    {
        "root": "deploy",
        "canonical": "Deployment succeeds but production shows a blank page",
        "variants": ["The hosted app is white after a successful build", "Production deploy is green but the page is empty", "My deployed site loads no UI", "Build passes, yet the live app is blank", "The production URL has a blank screen"],
    },
]


@app.post("/api/demo/reset")
def demo_reset():
    db.reset()
    db.seed()
    return {"ok": True, "message": "Demo memory reset to the starter community."}


@app.post("/api/demo/run")
def demo_run():
    started = time.perf_counter()
    simulated_memory: list[list[float]] = []
    total = 0
    ai_generations = 0
    community_resolutions = 0
    search_times: list[int] = []
    for group in SIMULATION_GROUPS:
        all_questions = [group["canonical"], *group["variants"]]
        anchor = None
        for question in all_questions:
            total += 1
            query_started = time.perf_counter()
            vector = embed(question)
            score = max((cosine(vector, item) for item in simulated_memory), default=-1)
            search_times.append(max(1, round((time.perf_counter() - query_started) * 1000)))
            if score >= THRESHOLD:
                community_resolutions += 1
            else:
                ai_generations += 1
                anchor = vector
                simulated_memory.append(vector)
    elapsed = max(1, round((time.perf_counter() - started) * 1000))
    return {
        "label": "Controlled simulation",
        "total_questions": total,
        "without_fixonce": {"problems": total, "ai_generations": total},
        "with_fixonce": {"ai_generations": ai_generations, "community_resolutions": community_resolutions, "ai_generations_avoided": community_resolutions},
        "reuse_rate": round(community_resolutions / total * 100, 1),
        "elapsed_ms": elapsed,
        "avg_semantic_search_ms": round(sum(search_times) / len(search_times), 1),
    }


@app.get("/", include_in_schema=False)
def serve_app():
    return FileResponse(FRONTEND / "index.html")


@app.get("/{path:path}", include_in_schema=False)
def serve_frontend(path: str):
    target = (FRONTEND / path).resolve()
    if FRONTEND.resolve() in target.parents and target.exists() and target.is_file():
        return FileResponse(target)
    return FileResponse(FRONTEND / "index.html")
