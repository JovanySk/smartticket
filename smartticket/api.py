"""FastAPI inference service for support-ticket triage."""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import joblib
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .training import TARGETS, ticket_text

MODEL_PATH = Path(os.getenv("SMARTTICKET_MODEL", "models/model.joblib"))
# below this queue confidence the ticket is flagged for a human instead of being auto-routed
REVIEW_THRESHOLD = float(os.getenv("SMARTTICKET_REVIEW_THRESHOLD", "0.5"))
STATIC_DIR = Path(__file__).parent / "static"


class Ticket(BaseModel):
    subject: str = Field(default="", max_length=300)
    body: str = Field(min_length=10, max_length=5000)


class Batch(BaseModel):
    tickets: list[Ticket] = Field(min_length=1, max_length=100)


class LabelScore(BaseModel):
    label: str
    confidence: float


class Prediction(BaseModel):
    type: LabelScore
    queue: LabelScore
    priority: LabelScore
    queue_top3: list[LabelScore]
    needs_review: bool


@lru_cache(maxsize=1)
def load_bundle(path: Path = MODEL_PATH) -> dict:
    if not path.exists():
        raise RuntimeError(f"Model not found at {path}. Run `python -m smartticket.train` first.")
    return joblib.load(path)


def predict_one(bundle: dict, ticket: Ticket) -> Prediction:
    text = [ticket_text(ticket.subject, ticket.body)]
    out: dict = {}
    for target in TARGETS:
        model = bundle["models"][target]
        proba = model.predict_proba(text)[0]
        ranked = sorted(zip(model.classes_, proba), key=lambda p: p[1], reverse=True)
        out[target] = LabelScore(label=str(ranked[0][0]), confidence=round(float(ranked[0][1]), 4))
        if target == "queue":
            out["queue_top3"] = [LabelScore(label=str(c), confidence=round(float(p), 4)) for c, p in ranked[:3]]
    out["needs_review"] = out["queue"].confidence < REVIEW_THRESHOLD
    return Prediction(**out)


app = FastAPI(title="SmartTicket", version="1.0.0",
              description="Classifies support tickets by type, queue and priority (TF-IDF + Logistic Regression).")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", response_class=HTMLResponse, include_in_schema=False)
def web_demo() -> HTMLResponse:
    """Single-page demo UI. The review threshold is injected so the page shows the live value."""
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    return HTMLResponse(html.replace("__REVIEW_THRESHOLD__", f"{REVIEW_THRESHOLD:g}"))


def bundle_or_503() -> dict:
    try:
        return load_bundle()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model_loaded": MODEL_PATH.exists()}


@app.get("/model-info")
def model_info() -> dict:
    m = bundle_or_503()["metrics"]
    return {
        "trained_at": m["trained_at"],
        "n_tickets": m["n_tickets"],
        "targets": {
            t: {k: v[k] for k in ("classes", "accuracy", "macro_f1", "weighted_f1", "baseline_macro_f1")}
            for t, v in m["targets"].items()
        },
    }


@app.post("/predict", response_model=Prediction)
def predict(ticket: Ticket) -> Prediction:
    return predict_one(bundle_or_503(), ticket)


@app.post("/predict/batch", response_model=list[Prediction])
def predict_batch(batch: Batch) -> list[Prediction]:
    bundle = bundle_or_503()
    return [predict_one(bundle, t) for t in batch.tickets]
