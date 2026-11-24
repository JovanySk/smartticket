"""Tests run offline on a small synthetic fixture, so CI never needs the real dataset."""
import json
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from smartticket import api
from smartticket.training import TARGETS, save, ticket_text, train

ROWS = {
    ("Incident", "Technical Support", "high"): [
        "Server crashed and the application is down for all users",
        "Database outage, production system not responding since morning",
        "Critical error: the platform crashes when saving data",
    ],
    ("Request", "Billing and Payments", "low"): [
        "Please send me a copy of last month invoice for my records",
        "I would like to update the billing address on my account",
        "Can you resend the payment receipt to my email",
    ],
    ("Change", "Product Support", "medium"): [
        "Requesting a configuration change to enable the new reporting module",
        "Please change the default language of the dashboard to Spanish",
        "We need to update the product settings for our team plan",
    ],
}


@pytest.fixture(scope="module")
def fixture_df() -> pd.DataFrame:
    records = []
    for (typ, queue, prio), bodies in ROWS.items():
        for rep in range(4):  # repeat so every class has enough samples for a stratified split
            for body in bodies:
                records.append({"subject": f"{queue} ticket", "body": f"{body} ({rep})", "type": typ, "queue": queue, "priority": prio})
    df = pd.DataFrame(records)
    df["text"] = [ticket_text(s, b) for s, b in zip(df.subject, df.body)]
    return df


@pytest.fixture(scope="module")
def trained(fixture_df, tmp_path_factory):
    out = tmp_path_factory.mktemp("model")
    result = train(fixture_df, test_size=0.25)
    save(result, out / "model.joblib", out / "metrics.json")
    return result, out


@pytest.fixture()
def client(trained, monkeypatch):
    _, out = trained
    monkeypatch.setattr(api, "MODEL_PATH", out / "model.joblib")
    api.load_bundle.cache_clear()
    monkeypatch.setattr(api, "load_bundle", lambda path=out / "model.joblib": __import__("joblib").load(path))
    return TestClient(api.app)


def test_ticket_text_joins_subject_and_body():
    assert ticket_text("  Login ", "cannot sign in ") == "Login . cannot sign in"
    assert ticket_text(None, "body") == " . body"


def test_training_reports_metrics_and_beats_baseline(trained):
    result, out = trained
    for target in TARGETS:
        m = result.metrics["targets"][target]
        assert 0 <= m["macro_f1"] <= 1
        assert m["macro_f1"] > m["baseline_macro_f1"]
        assert len(m["confusion_matrix"]) == len(m["classes"])
    saved = json.loads((out / "metrics.json").read_text())
    assert saved["n_tickets"] == result.metrics["n_tickets"]


def test_health(client):
    assert client.get("/health").json()["status"] == "ok"


def test_predict_returns_all_targets(client):
    res = client.post("/predict", json={"subject": "Outage", "body": "The server crashed and production is down for everyone"})
    assert res.status_code == 200
    body = res.json()
    assert body["type"]["label"] == "Incident"
    assert body["queue"]["label"] == "Technical Support"
    assert len(body["queue_top3"]) == 3
    assert all(0 <= x["confidence"] <= 1 for x in body["queue_top3"])
    assert body["needs_review"] == (body["queue"]["confidence"] < api.REVIEW_THRESHOLD)


def test_low_confidence_is_flagged_for_review(client, monkeypatch):
    monkeypatch.setattr(api, "REVIEW_THRESHOLD", 1.01)
    res = client.post("/predict", json={"body": "The server crashed and production is down for everyone"})
    assert res.json()["needs_review"] is True


def test_predict_billing_ticket(client):
    res = client.post("/predict", json={"body": "Please resend the invoice and payment receipt for my billing records"})
    assert res.json()["queue"]["label"] == "Billing and Payments"


@pytest.mark.parametrize("payload", [{}, {"body": "short"}, {"body": "x" * 5001}])
def test_predict_validates_input(client, payload):
    assert client.post("/predict", json=payload).status_code == 422


def test_batch(client):
    res = client.post("/predict/batch", json={"tickets": [{"body": "The server crashed again today"}, {"body": "Send me last month invoice please"}]})
    assert res.status_code == 200 and len(res.json()) == 2


def test_batch_limits(client):
    assert client.post("/predict/batch", json={"tickets": []}).status_code == 422
    assert client.post("/predict/batch", json={"tickets": [{"body": "valid ticket body"}] * 101}).status_code == 422


def test_model_info(client):
    info = client.get("/model-info").json()
    assert set(info["targets"]) == set(TARGETS)


def test_missing_model_returns_503(monkeypatch, tmp_path):
    monkeypatch.setattr(api, "MODEL_PATH", tmp_path / "nope.joblib")
    monkeypatch.setattr(api, "load_bundle", lambda path=tmp_path / "nope.joblib": (_ for _ in ()).throw(RuntimeError("Model not found")))
    res = TestClient(api.app).post("/predict", json={"body": "The server crashed again"})
    assert res.status_code == 503


REAL_METRICS = Path("reports/metrics.json")


@pytest.mark.skipif(not REAL_METRICS.exists(), reason="real model not trained in this environment")
def test_real_model_quality_gate():
    """Guards against regressions when retraining on the real dataset."""
    m = json.loads(REAL_METRICS.read_text())["targets"]
    assert m["type"]["macro_f1"] >= 0.80
    assert m["queue"]["macro_f1"] >= 0.45
    for t in TARGETS:
        assert m[t]["macro_f1"] > 2 * m[t]["baseline_macro_f1"]
