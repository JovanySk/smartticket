"""Model loading, prediction and word-level explanations.

Explanations are computed from the fitted pipeline itself: for the predicted queue, each term in the
ticket contributes ``tfidf_value * coefficient[queue, term]`` to that class's logit. The terms with the
largest positive contribution are the words that pushed the model toward its answer.
"""
from __future__ import annotations

import threading
import time
from pathlib import Path

import joblib
import numpy as np
from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS

from .training import TARGETS, ticket_text


# Request boilerplate that appears in every ticket and explains nothing on its own.
FILLER = frozenset({"want", "know", "need", "like", "please", "thanks", "thank", "hello", "dear", "regards",
                    "would", "could", "just", "really", "also", "get", "got", "let", "make", "help", "able", "trying"})
STOP = ENGLISH_STOP_WORDS | FILLER


def is_meaningful(term: str) -> bool:
    """Hide filler terms ("when", "if it") from explanations; they still count in the model.

    A term is shown only if at least one of its words has 3+ letters and is not a stop or filler word.
    """
    return bool(content_words(term))


def content_words(term: str) -> frozenset[str]:
    return frozenset(w for w in term.split() if len(w) >= 3 and w not in STOP)


def pick_terms(ranked: list[tuple[str, float]], k: int = 3) -> list[tuple[str, float]]:
    """From (term, contribution) pairs sorted high to low, keep the first k positive, meaningful terms,
    skipping terms that only repeat words already shown ("invoice" then "the invoice")."""
    out, seen = [], set()
    for term, value in ranked:
        if len(out) == k or value <= 0:
            break
        words = content_words(term)
        if not words or words <= seen:
            continue
        seen |= words
        out.append((term, value))
    return out


class ModelUnavailable(RuntimeError):
    pass


class Classifier:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._bundle: dict | None = None
        self._features: dict[str, np.ndarray] = {}
        self._lock = threading.Lock()

    @property
    def available(self) -> bool:
        return self._bundle is not None or self.path.exists()

    def bundle(self) -> dict:
        if self._bundle is None:
            with self._lock:
                if self._bundle is None:
                    if not self.path.exists():
                        raise ModelUnavailable(
                            f"Model not found at {self.path}. Run `python -m smartticket.train` first.")
                    self._bundle = joblib.load(self.path)
        return self._bundle

    @property
    def metrics(self) -> dict:
        return self.bundle()["metrics"]

    def queue_labels(self) -> list[str]:
        return [str(c) for c in self.bundle()["models"]["queue"].classes_]

    def _feature_names(self, target: str) -> np.ndarray:
        if target not in self._features:
            tfidf = self.bundle()["models"][target].named_steps["tfidf"]
            self._features[target] = tfidf.get_feature_names_out()
        return self._features[target]

    def explain(self, text: str, target: str, label: str, k: int = 3) -> list[dict]:
        """Top-k terms with a positive contribution to ``label`` for ``target``."""
        pipe = self.bundle()["models"][target]
        tfidf, clf = pipe.named_steps["tfidf"], pipe.named_steps["clf"]
        row = tfidf.transform([text])
        if row.nnz == 0:
            return []
        classes = list(clf.classes_)
        idx = classes.index(label)
        if clf.coef_.shape[0] == 1:  # binary problems store a single row for the positive class
            coef = clf.coef_[0] if idx == 1 else -clf.coef_[0]
        else:
            coef = clf.coef_[idx]
        contrib = row.data * coef[row.indices]
        order = np.argsort(-contrib)
        names = self._feature_names(target)
        ranked = [(str(names[row.indices[i]]), float(contrib[i])) for i in order]
        return [{"word": t, "weight": round(v, 4)} for t, v in pick_terms(ranked, k)]

    def predict(self, subject: str, body: str, threshold: float) -> dict:
        started = time.perf_counter()
        bundle = self.bundle()
        text = ticket_text(subject, body)
        out: dict = {}
        for target in TARGETS:
            model = bundle["models"][target]
            proba = model.predict_proba([text])[0]
            ranked = sorted(zip(model.classes_, proba), key=lambda p: p[1], reverse=True)
            out[target] = {"label": str(ranked[0][0]), "confidence": round(float(ranked[0][1]), 4)}
            if target == "queue":
                out["queue_top3"] = [{"label": str(c), "confidence": round(float(p), 4)} for c, p in ranked[:3]]
        out["top_words"] = self.explain(text, "queue", out["queue"]["label"])
        out["needs_review"] = out["queue"]["confidence"] < threshold
        out["threshold"] = round(threshold, 2)
        out["latency_ms"] = round((time.perf_counter() - started) * 1000, 2)
        return out
