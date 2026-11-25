"""Training pipeline: TF-IDF + Logistic Regression per target, evaluated against a majority-class baseline."""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import joblib
import pandas as pd
from sklearn.dummy import DummyClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline

TARGETS = ("type", "queue", "priority")
RANDOM_STATE = 42
# review thresholds evaluated on the held-out split (coverage = share auto-routed, accuracy = on that share)
SWEEP_THRESHOLDS = tuple(round(0.30 + 0.05 * i, 2) for i in range(13))


def ticket_text(subject: str | None, body: str) -> str:
    """Subject and body are joined so short subjects still contribute signal."""
    return f"{(subject or '').strip()} . {body.strip()}"


def build_pipeline() -> Pipeline:
    return Pipeline([
        ("tfidf", TfidfVectorizer(ngram_range=(1, 2), min_df=2, sublinear_tf=True)),
        ("clf", LogisticRegression(max_iter=2000, C=4.0, class_weight="balanced")),
    ])


def load_tickets(csv_path: Path, language: str = "en") -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    df = df[df["language"] == language].dropna(subset=["body"]).copy()
    df["text"] = [ticket_text(s, b) for s, b in zip(df["subject"].fillna(""), df["body"])]
    return df


@dataclass
class TrainResult:
    models: dict[str, Pipeline]
    metrics: dict


def threshold_sweep(proba, classes, y_true) -> list[dict]:
    """For each threshold: how many tickets would be auto-routed and how accurate those routes are."""
    conf = proba.max(axis=1)
    pred = classes[proba.argmax(axis=1)]
    rows = []
    for t in SWEEP_THRESHOLDS:
        mask = conf >= t
        n = int(mask.sum())
        rows.append({
            "threshold": t,
            "coverage": round(n / len(conf), 4),
            "accuracy": round(float((pred[mask] == y_true[mask]).mean()), 4) if n else None,
        })
    return rows


def train(df: pd.DataFrame, test_size: float = 0.2) -> TrainResult:
    models: dict[str, Pipeline] = {}
    metrics: dict = {"n_tickets": int(len(df)), "test_size": test_size, "targets": {}}
    for target in TARGETS:
        X_tr, X_te, y_tr, y_te = train_test_split(
            df["text"].values, df[target].values,
            test_size=test_size, random_state=RANDOM_STATE, stratify=df[target].values,
        )
        model = build_pipeline().fit(X_tr, y_tr)
        pred = model.predict(X_te)
        base = DummyClassifier(strategy="most_frequent").fit(X_tr, y_tr).predict(X_te)
        labels = sorted(set(y_te))
        metrics["targets"][target] = {
            "classes": labels,
            "accuracy": round(accuracy_score(y_te, pred), 4),
            "macro_f1": round(f1_score(y_te, pred, average="macro"), 4),
            "weighted_f1": round(f1_score(y_te, pred, average="weighted"), 4),
            "baseline_accuracy": round(accuracy_score(y_te, base), 4),
            "baseline_macro_f1": round(f1_score(y_te, base, average="macro"), 4),
            "per_class": classification_report(y_te, pred, output_dict=True, zero_division=0),
            "confusion_matrix": confusion_matrix(y_te, pred, labels=labels).tolist(),
        }
        if target == "queue":
            metrics["targets"][target]["threshold_sweep"] = threshold_sweep(
                model.predict_proba(X_te), model.classes_, y_te)
        # final model is refit on all data for serving; reported metrics come from the held-out split
        models[target] = build_pipeline().fit(df["text"].values, df[target].values)
    metrics["trained_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return TrainResult(models, metrics)


def save(result: TrainResult, model_path: Path, metrics_path: Path) -> None:
    model_path.parent.mkdir(parents=True, exist_ok=True)
    metrics_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({"models": result.models, "metrics": result.metrics}, model_path, compress=3)
    metrics_path.write_text(json.dumps(result.metrics, indent=2), encoding="utf-8")
