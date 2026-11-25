"""Tests run offline on a small synthetic fixture, so CI never needs the real dataset."""
import html as htmllib
import json
import re
import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from smartticket import api
from smartticket.config import Settings
from smartticket.db import Store
from smartticket.inference import is_meaningful, pick_terms
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
ADMIN = ("admin@smartticket.test", "Admin123!")
AGENT = ("agente@smartticket.test", "Agente123!")
CRASH = "The server crashed and production is down for everyone"
LOCALES = Path(__file__).resolve().parents[1] / "smartticket" / "static" / "i18n"


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
def settings(trained, tmp_path) -> Settings:
    _, out = trained
    return Settings(env="dev", model_path=out / "model.joblib", db_path=tmp_path / "test.db", seed_demo=False)


@pytest.fixture()
def client(settings):
    with TestClient(api.create_app(settings)) as c:
        yield c


def ctx(c: TestClient) -> api.Ctx:
    return c.app.state.ctx


def csrf(c: TestClient) -> dict:
    """Pre-login double-submit token: the page sets the cookie and exposes the same value in a meta tag."""
    page = c.get("/login")
    token = re.search(r'<meta name="csrf-token" content="([^"]+)"', page.text).group(1)
    assert token == c.cookies.get("st_csrf")
    return {"X-CSRF-Token": token}


def login(c: TestClient, who=ADMIN, remember=False):
    return c.post("/api/auth/login", json={"email": who[0], "password": who[1], "remember": remember}, headers=csrf(c))


def session_csrf(c: TestClient) -> dict:
    page = c.get("/panel")
    return {"X-CSRF-Token": re.search(r'<meta name="session-csrf" content="([^"]+)"', page.text).group(1)}


def review_ticket(c: TestClient) -> int:
    ctx(c).store.set_setting("review_threshold", "1.01")  # nothing reaches this, so the ticket lands in review
    tid = c.post("/tickets", json={"subject": "Outage", "body": CRASH}).json()["id"]
    ctx(c).store.set_setting("review_threshold", "0.50")
    return tid


# ----- model and public API ---------------------------------------------------------------------
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
    sweep = result.metrics["targets"]["queue"]["threshold_sweep"]
    assert [r["threshold"] for r in sweep] == sorted(r["threshold"] for r in sweep)
    assert all(0 <= r["coverage"] <= 1 for r in sweep)
    saved = json.loads((out / "metrics.json").read_text())
    assert saved["n_tickets"] == result.metrics["n_tickets"]


def test_health(client):
    assert client.get("/health").json() == {"status": "ok", "model_loaded": True}


def test_predict_returns_all_targets(client):
    res = client.post("/predict", json={"subject": "Outage", "body": CRASH})
    assert res.status_code == 200
    body = res.json()
    assert body["type"]["label"] == "Incident"
    assert body["queue"]["label"] == "Technical Support"
    assert len(body["queue_top3"]) == 3
    assert all(0 <= x["confidence"] <= 1 for x in body["queue_top3"])
    assert body["needs_review"] == (body["queue"]["confidence"] < body["threshold"])
    assert body["latency_ms"] >= 0


def test_low_confidence_is_flagged_for_review(client):
    ctx(client).store.set_setting("review_threshold", "1.01")
    res = client.post("/predict", json={"body": CRASH})
    assert res.json()["needs_review"] is True


def test_predict_billing_ticket(client):
    res = client.post("/predict", json={"body": "Please resend the invoice and payment receipt for my billing records"})
    assert res.json()["queue"]["label"] == "Billing and Payments"


def test_explanation_words_come_from_the_model(client):
    body = "Please resend the invoice and payment receipt for my billing records"
    res = client.post("/predict", json={"body": body}).json()
    words = res["top_words"]
    assert 1 <= len(words) <= 3
    pipe = ctx(client).clf.bundle()["models"]["queue"]
    tfidf, clf = pipe.named_steps["tfidf"], pipe.named_steps["clf"]
    row = tfidf.transform([ticket_text("", body)])
    coef = clf.coef_[list(clf.classes_).index(res["queue"]["label"])]
    contrib = dict(zip(tfidf.get_feature_names_out()[row.indices], row.data * coef[row.indices]))
    # the reported words are exactly the top positive tfidf x coefficient terms (filler hidden), in order
    expected = pick_terms(sorted(contrib.items(), key=lambda p: -p[1]))
    assert [w["word"] for w in words] == [w for w, _ in expected]
    assert np.allclose([w["weight"] for w in words], [round(v, 4) for _, v in expected])
    assert all(w["word"] in body.lower() for w in words)


def test_explanations_hide_filler_words():
    assert not is_meaningful("when") and not is_meaningful("if it") and not is_meaningful("my")
    assert is_meaningful("invoice") and is_meaningful("the invoice") and is_meaningful("vpn")
    ranked = [("invoice", .5), ("the invoice", .4), ("want to", .3), ("refund", .2), ("invoice refund", .1), ("vpn", -.1)]
    assert [t for t, _ in pick_terms(ranked)] == ["invoice", "refund"]


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
    assert info["threshold_sweep"]


def test_missing_model_returns_503(settings, tmp_path):
    settings.model_path = tmp_path / "nope.joblib"
    with TestClient(api.create_app(settings)) as c:
        assert c.post("/predict", json={"body": "The server crashed again"}).status_code == 503
        assert c.get("/health").json()["model_loaded"] is False


REAL_METRICS = Path("reports/metrics.json")


@pytest.mark.skipif(not REAL_METRICS.exists(), reason="real model not trained in this environment")
def test_real_model_quality_gate():
    """Guards against regressions when retraining on the real dataset."""
    m = json.loads(REAL_METRICS.read_text())["targets"]
    assert m["type"]["macro_f1"] >= 0.80
    assert m["queue"]["macro_f1"] >= 0.45
    for t in TARGETS:
        assert m[t]["macro_f1"] > 2 * m[t]["baseline_macro_f1"]


# ----- persistence and routing ------------------------------------------------------------------
def test_tickets_are_stored_and_routed_by_threshold(client):
    store = ctx(client).store
    store.set_setting("review_threshold", "0.30")
    sent = client.post("/tickets", json={"subject": "Outage", "body": CRASH})
    assert sent.status_code == 201
    conf = sent.json()["prediction"]["queue"]["confidence"]
    assert conf >= 0.30 and sent.json()["status"] == "enviado"

    store.set_setting("review_threshold", f"{min(conf + 0.01, 0.99):.2f}")
    held = client.post("/tickets", json={"subject": "Outage", "body": CRASH}).json()
    assert held["status"] == "revision" and held["code"].startswith("ST-")
    rows = {r["id"]: r for r in store.tickets("todos")}
    assert rows[sent.json()["id"]]["status"] == "enviado"
    assert rows[held["id"]]["status"] == "revision"


def test_batch_submission_is_stored(client):
    res = client.post("/tickets/batch", json={"tickets": [{"body": CRASH}, {"body": "Please resend my invoice for last month"}]})
    assert res.status_code == 201 and len(res.json()) == 2
    assert ctx(client).store.counts()["total"] == 2
    assert client.post("/tickets/batch", json={"tickets": [{"body": CRASH}] * 11}).status_code == 422


# ----- auth -------------------------------------------------------------------------------------
def test_login_success_sets_hardened_session_cookie(client):
    res = login(client)
    assert res.status_code == 200 and res.json()["redirect"] == "/panel"
    cookie = res.headers["set-cookie"]
    assert "st_session=" in cookie and "HttpOnly" in cookie and "samesite=lax" in cookie.lower()
    assert "Max-Age" not in cookie  # no "remember me": the cookie ends with the browser session
    me = client.get("/api/panel/me").json()
    assert me["user"]["email"] == ADMIN[0] and me["user"]["role"] == "admin"


def test_remember_me_makes_cookie_persistent(client):
    assert "Max-Age" in login(client, remember=True).headers["set-cookie"]


def test_secure_cookie_outside_dev(settings):
    settings.env = "production"
    settings.admin_email, settings.admin_password = "boss@example.com", "Sup3rSecretPass"
    with TestClient(api.create_app(settings), base_url="https://testserver") as c:
        res = c.post("/api/auth/login", json={"email": "boss@example.com", "password": "Sup3rSecretPass"}, headers=csrf(c))
        assert res.status_code == 200
        assert "Secure" in res.headers["set-cookie"]
        assert "Strict-Transport-Security" in res.headers


def test_login_failure_is_generic(client):
    wrong_pw = login(client, (ADMIN[0], "nope-nope-1"))
    no_user = login(client, ("ghost@smartticket.test", "nope-nope-1"))
    assert wrong_pw.status_code == no_user.status_code == 401
    assert wrong_pw.json() == no_user.json() == {"detail": "invalid_credentials"}
    assert client.get("/api/panel/me").status_code == 401


def test_login_rate_limit_per_ip(client):
    codes = [login(client, (ADMIN[0], f"wrong-{i}")).status_code for i in range(6)]
    assert codes[:5] == [401] * 5 and codes[5] == 429


def test_lockout_after_repeated_failures(client):
    for i in range(5):
        assert login(client, (AGENT[0], f"wrong-{i}")).status_code == 401
    ctx(client).limiter.reset()  # isolate the account lockout from the per-IP rate limit
    assert login(client, AGENT).status_code == 401  # right password, but the account is locked
    ctx(client).store.update_user(ctx(client).store.user_by_email(AGENT[0])["id"], locked_until=None)
    assert login(client, AGENT).status_code == 200


def test_logout_is_post_only_and_ends_session(client):
    login(client)
    headers = session_csrf(client)
    assert client.get("/api/auth/logout").status_code == 405
    assert client.post("/api/auth/logout").status_code == 403  # missing CSRF token
    assert client.post("/api/auth/logout", headers=headers).status_code == 200
    assert client.get("/api/panel/me").status_code == 401
    assert client.get("/panel", follow_redirects=False).status_code == 303


def test_passwords_are_hashed_with_scrypt(client, settings):
    con = sqlite3.connect(settings.db_path)
    hashes = [r[0] for r in con.execute("SELECT password_hash FROM users")]
    con.close()
    assert hashes and all(h.startswith("scrypt$") for h in hashes)
    assert not any(pw in h for h in hashes for pw in (ADMIN[1], AGENT[1]))


def test_production_never_creates_a_default_admin(settings):
    settings.env = "production"
    with TestClient(api.create_app(settings), base_url="https://testserver") as c:
        assert ctx(c).store.users() == []
        assert c.post("/api/auth/login", json={"email": ADMIN[0], "password": ADMIN[1]}, headers=csrf(c)).status_code == 401


def test_csrf_is_required(client):
    # pre-login form without, or with a forged, double-submit token
    client.get("/login")
    assert client.post("/api/auth/login", json={"email": ADMIN[0], "password": ADMIN[1]}).status_code == 403
    assert client.post("/api/auth/login", json={"email": ADMIN[0], "password": ADMIN[1]},
                       headers={"X-CSRF-Token": "forged"}).status_code == 403
    # logged-in panel action without / with a wrong session token
    login(client)
    tid = review_ticket(client)
    url = f"/api/panel/tickets/{tid}/assign"
    assert client.post(url, json={"queue": "Technical Support"}).status_code == 403
    assert client.post(url, json={"queue": "Technical Support"}, headers={"X-CSRF-Token": "x" * 43}).status_code == 403
    assert client.post(url, json={"queue": "Technical Support"}, headers=session_csrf(client)).status_code == 200


# ----- roles and panel ---------------------------------------------------------------------------
def test_admin_pages_are_forbidden_for_agents(client):
    login(client, AGENT)
    headers = session_csrf(client)
    assert client.get("/api/panel/threshold").status_code == 403
    assert client.post("/api/panel/threshold", json={"threshold": 0.6}, headers=headers).status_code == 403
    assert client.get("/api/panel/team").status_code == 403
    assert client.get("/api/panel/messages").status_code == 403
    assert client.get("/panel/umbral").status_code == 403
    assert client.get("/panel/equipo").status_code == 403
    assert client.get("/panel").status_code == 200
    assert client.get("/api/panel/tickets").status_code == 200


def test_panel_requires_login(client):
    assert client.get("/panel", follow_redirects=False).headers["location"] == "/login"
    assert client.get("/api/panel/tickets").status_code == 401


def test_assign_flow(client):
    tid = review_ticket(client)
    login(client, AGENT)
    headers = session_csrf(client)
    inbox = client.get("/api/panel/tickets", params={"view": "revision"}).json()["items"]
    assert [t["id"] for t in inbox] == [tid]
    detail = client.get(f"/api/panel/tickets/{tid}").json()
    assert detail["top_words"] and detail["status"] == "revision"

    assert client.post(f"/api/panel/tickets/{tid}/assign", json={"queue": "Nope"}, headers=headers).status_code == 400
    res = client.post(f"/api/panel/tickets/{tid}/assign", json={"queue": "Product Support"}, headers=headers)
    assert res.status_code == 200
    done = res.json()
    assert done["status"] == "asignado" and done["assigned_queue"] == "Product Support"
    assert done["assigned_by"] == "Ana Robles" and done["assigned_at"]
    assert client.get("/api/panel/tickets", params={"view": "revision"}).json()["items"] == []
    # a ticket can only be stamped once
    assert client.post(f"/api/panel/tickets/{tid}/assign", json={"queue": "Technical Support"}, headers=headers).status_code == 409


def test_defer_moves_ticket_to_the_end(client):
    first, second = review_ticket(client), review_ticket(client)
    login(client, AGENT)

    def order():
        return [t["id"] for t in client.get("/api/panel/tickets").json()["items"]]

    assert order() == [second, first]  # newest first
    assert client.post(f"/api/panel/tickets/{second}/defer", headers=session_csrf(client)).status_code == 200
    assert order() == [first, second]


def test_filters_and_search(client):
    review_ticket(client)
    login(client, AGENT)
    assert len(client.get("/api/panel/tickets", params={"filter": "urgentes"}).json()["items"]) == 1  # predicted high
    assert client.get("/api/panel/tickets", params={"q": "zzz-not-there"}).json()["items"] == []
    assert len(client.get("/api/panel/tickets", params={"q": "crashed"}).json()["items"]) == 1


def test_threshold_is_admin_controlled_and_used_for_routing(client):
    login(client)
    headers = session_csrf(client)
    assert client.post("/api/panel/threshold", json={"threshold": 0.95}, headers=headers).status_code == 400
    assert client.post("/api/panel/threshold", json={"threshold": 0.2}, headers=headers).status_code == 400
    assert client.post("/api/panel/threshold", json={"threshold": 0.9}, headers=headers).json() == {"threshold": 0.9}
    assert client.get("/api/panel/threshold").json()["threshold"] == 0.9
    res = client.post("/predict", json={"body": CRASH}).json()
    assert res["threshold"] == 0.9 and res["needs_review"] == (res["queue"]["confidence"] < 0.9)


def test_team_member_gets_temp_password_and_must_change_it(client):
    login(client)
    res = client.post("/api/panel/team", json={"name": "Luis Pérez", "email": "luis@smartticket.test", "role": "agente"},
                      headers=session_csrf(client))
    assert res.status_code == 201
    temp = res.json()["temp_password"]
    assert client.post("/api/panel/team", json={"name": "Dup", "email": "luis@smartticket.test"},
                       headers=session_csrf(client)).status_code == 409

    client.cookies.clear()
    assert login(client, ("luis@smartticket.test", temp)).json()["must_change_password"] is True
    assert client.get("/api/panel/tickets").json() == {"detail": "password_change_required"}
    headers = session_csrf(client)
    weak = client.post("/api/auth/password", json={"current": temp, "new": "short"}, headers=headers)
    assert weak.status_code == 400 and weak.json()["detail"] == "password_short"
    ok = client.post("/api/auth/password", json={"current": temp, "new": "NuevaClave2026"}, headers=headers)
    assert ok.status_code == 200
    assert client.get("/api/panel/tickets").status_code == 200


def test_deactivated_member_cannot_log_in(client):
    login(client)
    headers = session_csrf(client)
    agent_id = ctx(client).store.user_by_email(AGENT[0])["id"]
    me_id = client.get("/api/panel/me").json()["user"]["id"]
    assert client.post(f"/api/panel/team/{me_id}/deactivate", headers=headers).status_code == 400
    assert client.post(f"/api/panel/team/{agent_id}/deactivate", headers=headers).status_code == 200
    client.cookies.clear()
    assert login(client, AGENT).status_code == 401


# ----- contact form ------------------------------------------------------------------------------
def test_contact_form_validates_stores_and_admin_reads(client):
    msg = {"name": "Laura", "email": "laura@example.com", "topic": "demo", "message": "I would like a demo for my team."}
    assert client.post("/api/contact", json=msg).status_code == 403  # CSRF
    headers = csrf(client)
    bad = client.post("/api/contact", json={**msg, "email": "not-an-email", "message": "hi"}, headers=headers)
    assert bad.status_code == 422 and set(bad.json()["detail"]["fields"]) == {"email", "message"}
    assert client.post("/api/contact", json=msg, headers=headers).status_code == 201
    # honeypot filled: looks fine to the bot, nothing is stored
    assert client.post("/api/contact", json={**msg, "website": "http://spam"}, headers=headers).status_code == 201
    assert len(ctx(client).store.messages()) == 1

    login(client)
    items = client.get("/api/panel/messages").json()["items"]
    assert [m["email"] for m in items] == ["laura@example.com"]
    assert client.post(f"/api/panel/messages/{items[0]['id']}/read", headers=session_csrf(client)).status_code == 200
    assert client.get("/api/panel/me").json()["unread_messages"] == 0


def test_contact_form_is_rate_limited(client):
    headers = csrf(client)
    msg = {"name": "Laura", "email": "laura@example.com", "message": "Hello there, a question about the API."}
    codes = [client.post("/api/contact", json=msg, headers=headers).status_code for _ in range(4)]
    assert codes == [201, 201, 201, 429]


# ----- pages, headers and i18n -------------------------------------------------------------------
def test_pages_are_served(client):
    res = client.get("/")
    assert res.status_code == 200 and res.headers["content-type"].startswith("text/html")
    assert "SmartTicket" in res.text and "{{" not in res.text and '<html lang="es"' in res.text
    for path in ("/login", "/faq", "/privacy", "/terms", "/contact"):
        page = client.get(path)
        assert page.status_code == 200 and "{{" not in page.text, path
    for asset in ("/static/js/i18n.js", "/static/js/landing.js", "/static/css/base.css", "/static/img/clasificador.webp"):
        assert client.get(asset).status_code == 200, asset
    assert client.get("/docs").status_code == 200
    assert client.get("/no-such-page", headers={"accept": "text/html"}).status_code == 404


def test_footer_links_resolve(client):
    page = client.get("/").text
    footer = page[page.index('<footer class="footer">'):]
    for href in set(re.findall(r'href="(/[^"#]*)', footer)):
        assert client.get(href).status_code == 200, href


def test_security_headers(client):
    headers = client.get("/").headers
    assert "script-src 'self'" in headers["content-security-policy"]
    assert "unsafe-inline" not in headers["content-security-policy"]
    assert "frame-ancestors 'none'" in headers["content-security-policy"]
    assert headers["x-content-type-options"] == "nosniff"
    assert headers["referrer-policy"] == "strict-origin-when-cross-origin"


@pytest.mark.parametrize("lang,attr", [("en", "en"), ("pt", "pt"), ("zh", "zh-Hans"), ("fr", "fr"), ("ja", "ja")])
def test_pages_render_in_chosen_language(client, lang, attr):
    loc = json.loads((LOCALES / f"{lang}.json").read_text(encoding="utf-8"))
    client.cookies.set("st_lang", lang)
    page = client.get("/").text
    assert f'<html lang="{attr}"' in page
    assert htmllib.escape(loc["nav.how"], quote=False) in page
    assert htmllib.escape(loc["hero.lede"], quote=False) in page


def test_every_locale_has_every_key():
    es = json.loads((LOCALES / "es.json").read_text(encoding="utf-8"))
    markers = re.compile(r"\{\w+\}|\[\[|\]\]|\*\*")
    for code in ("en", "pt", "zh", "fr", "ja"):
        loc = json.loads((LOCALES / f"{code}.json").read_text(encoding="utf-8"))
        assert set(loc) == set(es), f"{code}: missing {set(es) - set(loc)}, extra {set(loc) - set(es)}"
        for key, text in es.items():
            assert loc[key].strip(), f"{code}:{key} is empty"
            assert sorted(markers.findall(loc[key])) == sorted(markers.findall(text)), f"{code}:{key}"


def test_every_template_key_is_in_the_locale():
    es = json.loads((LOCALES / "es.json").read_text(encoding="utf-8"))
    used = set()
    for page in (LOCALES.parent / "pages").rglob("*.html"):
        text = page.read_text(encoding="utf-8")
        used |= set(re.findall(r'data-i18n(?:-html)?="([^"]+)"', text))
        for attr in re.findall(r'data-i18n-attr="([^"]+)"', text):
            used |= {pair.split(":", 1)[1] for pair in attr.split(";")}
    assert used - set(es) == set()


def test_store_initialises_schema(tmp_path):
    store = Store(tmp_path / "x" / "new.db")
    store.init()
    assert store.counts()["total"] == 0


# ----- self-registration -------------------------------------------------------------------------
NEW = {"name": "Marta Ruiz", "email": "marta@smartticket.test", "area": "Billing and Payments",
       "password": "Facturas2026", "confirm": "Facturas2026"}


def register(c: TestClient, **changes):
    return c.post("/api/auth/register", json={**NEW, **changes}, headers=csrf(c))


def test_register_page_is_linked_from_login(client):
    assert 'href="/registro"' in client.get("/login").text
    page = client.get("/registro")
    assert page.status_code == 200 and "{{" not in page.text and "Billing and Payments" in page.text


def test_registration_creates_a_pending_agent_that_cannot_log_in(client):
    res = register(client)
    assert res.status_code == 202 and res.json() == {"ok": True}
    user = ctx(client).store.user_by_email(NEW["email"])
    assert user["status"] == "pendiente" and user["role"] == "agente" and user["area"] == NEW["area"]
    assert user["password_hash"].startswith("scrypt$")
    # the pending state is only revealed once the password is right
    assert login(client, (NEW["email"], "wrong-pass-1")).json() == {"detail": "invalid_credentials"}
    pending = login(client, (NEW["email"], NEW["password"]))
    assert pending.status_code == 403 and pending.json() == {"detail": "pending_approval"}
    assert "st_session" not in pending.headers.get("set-cookie", "")


def test_registration_does_not_reveal_existing_emails(client):
    fresh = register(client, email="someone.new@smartticket.test")
    taken = register(client, email=AGENT[0], name="Impostor")
    assert fresh.status_code == taken.status_code == 202 and fresh.json() == taken.json()
    agent = ctx(client).store.user_by_email(AGENT[0])
    assert agent["name"] == "Ana Robles" and agent["status"] == "aprobado"  # existing account untouched
    assert login(client, AGENT).status_code == 200


def test_registration_validates_csrf_honeypot_and_password_rules(client):
    client.get("/registro")
    assert client.post("/api/auth/register", json=NEW).status_code == 403
    bad = register(client, password="short", confirm="short", area="Nope", email="x")
    assert bad.status_code == 422
    assert bad.json()["detail"]["fields"] == {"email": "email_invalid", "area": "area_required", "password": "password_short"}
    assert register(client, password="onlyletters", confirm="onlyletters").json()["detail"]["fields"] == {"password": "password_mix"}
    assert register(client, confirm="Different2026").json()["detail"]["fields"] == {"confirm": "password_mismatch"}
    assert register(client, website="http://spam").status_code == 202
    assert ctx(client).store.user_by_email(NEW["email"]) is None


def test_registration_is_rate_limited(client):
    codes = [register(client, email=f"user{i}@smartticket.test").status_code for i in range(4)]
    assert codes == [202, 202, 202, 429]


def test_admin_approves_or_rejects_requests(client):
    register(client)
    register(client, email="other@smartticket.test", name="Otro Nombre")
    login(client)
    headers = session_csrf(client)
    assert client.get("/api/panel/me").json()["pending_requests"] == 2
    team = client.get("/api/panel/team").json()
    reqs = {r["email"]: r["id"] for r in team["requests"]}
    assert set(reqs) == {NEW["email"], "other@smartticket.test"}
    assert NEW["email"] not in [u["email"] for u in team["items"]]

    assert client.post(f"/api/panel/team/{reqs[NEW['email']]}/approve").status_code == 403  # CSRF
    assert client.post(f"/api/panel/team/{reqs[NEW['email']]}/approve", headers=headers).status_code == 200
    assert client.post(f"/api/panel/team/{reqs['other@smartticket.test']}/reject", headers=headers).status_code == 200
    assert client.post(f"/api/panel/team/{reqs['other@smartticket.test']}/approve", headers=headers).status_code == 404
    assert client.get("/api/panel/me").json()["pending_requests"] == 0

    client.cookies.clear()
    assert login(client, (NEW["email"], NEW["password"])).status_code == 200
    client.cookies.clear()
    rejected = login(client, ("other@smartticket.test", NEW["password"]))
    assert rejected.status_code == 401 and rejected.json() == {"detail": "invalid_credentials"}


def test_agents_cannot_approve_requests(client):
    register(client)
    uid = ctx(client).store.user_by_email(NEW["email"])["id"]
    login(client, AGENT)
    headers = session_csrf(client)
    assert client.post(f"/api/panel/team/{uid}/approve", headers=headers).status_code == 403
    assert client.post(f"/api/panel/team/{uid}/reject", headers=headers).status_code == 403
    assert ctx(client).store.user_by_id(uid)["status"] == "pendiente"
