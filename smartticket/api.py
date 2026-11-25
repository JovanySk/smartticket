"""SmartTicket web service: public triage API, landing page and the staff review panel."""
from __future__ import annotations

import json
import logging
import secrets
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import i18n
from .config import Settings
from .db import Store, iso, now, ticket_code, ticket_dict
from .demo import seed_tickets, seed_users
from .inference import Classifier, ModelUnavailable
from .security import (CSRF_COOKIE, CSRF_HEADER, DUMMY_HASH, EMAIL_RE, LANG_COOKIE, SESSION_COOKIE, RateLimiter,
                       hash_password, new_token, password_problem, same_token, temp_password, token_hash,
                       verify_password)

log = logging.getLogger("smartticket")
STATIC_DIR = Path(__file__).parent / "static"
THRESHOLD_MIN, THRESHOLD_MAX = 0.30, 0.90


# ----- schemas ------------------------------------------------------------------------------------
class Ticket(BaseModel):
    subject: str = Field(default="", max_length=300)
    body: str = Field(min_length=10, max_length=5000)


class Batch(BaseModel):
    tickets: list[Ticket] = Field(min_length=1, max_length=100)


class StoreBatch(BaseModel):
    tickets: list[Ticket] = Field(min_length=1, max_length=10)


class LabelScore(BaseModel):
    label: str
    confidence: float


class WordWeight(BaseModel):
    word: str = Field(description="Term (word or two-word phrase) from the TF-IDF vocabulary")
    weight: float = Field(description="tfidf value x model coefficient for the predicted queue")


class Prediction(BaseModel):
    type: LabelScore
    queue: LabelScore
    priority: LabelScore
    queue_top3: list[LabelScore]
    needs_review: bool
    top_words: list[WordWeight] = Field(
        default_factory=list, description="Up to 3 terms that pushed the model hardest toward the predicted queue")
    threshold: float = Field(description="Review threshold in force for this prediction")
    latency_ms: float = Field(description="Server-side inference time in milliseconds")


class StoredTicket(BaseModel):
    id: int
    code: str
    status: Literal["enviado", "revision"]
    prediction: Prediction


class Login(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=200)
    remember: bool = False


class PasswordChange(BaseModel):
    current: str = Field(max_length=200)
    new: str = Field(max_length=200)


class Assign(BaseModel):
    queue: str = Field(max_length=100)


class ThresholdIn(BaseModel):
    threshold: float


class NewMember(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    email: str = Field(max_length=254)
    role: Literal["admin", "agente"] = "agente"
    area: str | None = Field(default=None, max_length=100)


class Contact(BaseModel):
    name: str = Field(default="", max_length=200)
    email: str = Field(default="", max_length=254)
    topic: str = Field(default="general", max_length=40)
    message: str = Field(default="", max_length=5000)
    website: str = Field(default="", max_length=200)  # honeypot: hidden from humans, bots fill it in


# ----- app context -------------------------------------------------------------------------------
class Ctx:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.store = Store(settings.db_path)
        self.clf = Classifier(settings.model_path)
        self.limiter = RateLimiter()

    def threshold(self) -> float:
        return self.store.threshold(self.settings.review_threshold)

    def predict(self, subject: str, body: str) -> dict:
        try:
            return self.clf.predict(subject, body, self.threshold())
        except ModelUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    def sweep(self) -> list[dict]:
        try:
            return self.clf.metrics["targets"]["queue"].get("threshold_sweep", [])
        except (ModelUnavailable, KeyError):
            return []

    def queues(self) -> list[str]:
        try:
            return self.clf.queue_labels()
        except ModelUnavailable:
            return []


def ctx_of(request: Request) -> Ctx:
    return request.app.state.ctx


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def lang_of(request: Request) -> str:
    return i18n.normalize_lang(request.query_params.get("lang") or request.cookies.get(LANG_COOKIE))


# ----- security headers --------------------------------------------------------------------------
CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; "
       "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'")
# Swagger UI and ReDoc load their bundles from jsdelivr and boot with an inline script
DOCS_CSP = ("default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
            "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: https:; "
            "connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'")


def add_security_headers(app: FastAPI, settings: Settings) -> None:
    @app.middleware("http")
    async def headers(request: Request, call_next):
        response = await call_next(request)
        path = request.url.path
        docs = path in ("/docs", "/redoc")
        response.headers.setdefault("Content-Security-Policy", DOCS_CSP if docs else CSP)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        if not settings.dev:
            response.headers.setdefault("Strict-Transport-Security", "max-age=31536000")
        if path.startswith("/api/") or path == "/login" or path.startswith("/panel"):
            response.headers.setdefault("Cache-Control", "no-store")
        return response


# ----- auth dependencies -------------------------------------------------------------------------
def session_user(request: Request):
    raw = request.cookies.get(SESSION_COOKIE)
    if not raw:
        return None
    return ctx_of(request).store.session(token_hash(raw))


def require_user(request: Request):
    """Logged-in staff. Every state-changing request must carry the session's CSRF token."""
    user = session_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="auth_required")
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        if not same_token(request.headers.get(CSRF_HEADER), user["csrf_token"]):
            raise HTTPException(status_code=403, detail="csrf")
    return user


def require_ready_user(user=Depends(require_user)):
    """Like require_user, but blocks accounts that still have to replace a temporary password."""
    if user["must_change_password"]:
        raise HTTPException(status_code=403, detail="password_change_required")
    return user


def require_admin(user=Depends(require_ready_user)):
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="forbidden")
    return user


def require_anon_csrf(request: Request) -> None:
    """Double-submit check for forms posted before login (login, contact)."""
    if not same_token(request.headers.get(CSRF_HEADER), request.cookies.get(CSRF_COOKIE)):
        raise HTTPException(status_code=403, detail="csrf")


def rate_limit(request: Request, bucket: str, limit: int, window_s: float) -> None:
    if not ctx_of(request).limiter.hit(bucket, client_ip(request), limit, window_s):
        raise HTTPException(status_code=429, detail="rate_limited")


def set_cookie(response: Response, settings: Settings, key: str, value: str, *, max_age: int | None,
               samesite: str = "lax") -> None:
    response.set_cookie(key, value, max_age=max_age, httponly=True, samesite=samesite,
                        secure=not settings.dev, path="/")


# ----- serialisation -----------------------------------------------------------------------------
def user_public(row) -> dict:
    return {"id": row["id"], "name": row["name"], "email": row["email"], "role": row["role"],
            "area": row["area"], "active": bool(row["active"]),
            "must_change_password": bool(row["must_change_password"]), "last_login_at": row["last_login_at"]}


def ticket_summary(row) -> dict:
    d = ticket_dict(row)
    d.pop("body")
    return d


def stored(ctx: Ctx, subject: str, body: str, source: str) -> dict:
    pred = ctx.predict(subject, body)
    tid = ctx.store.add_ticket(subject.strip(), body.strip(), source, pred)
    return {"id": tid, "code": ticket_code(tid), "status": "revision" if pred["needs_review"] else "enviado",
            "prediction": pred}


# ----- app factory -------------------------------------------------------------------------------
def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    ctx = Ctx(settings)
    i18n.live_reload = settings.dev

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        ctx.store.init()
        if ctx.store.get_setting("review_threshold") is None:
            ctx.store.set_setting("review_threshold", f"{settings.review_threshold:.2f}")
        bootstrap_admin(ctx)
        if settings.dev:
            seed_users(ctx.store)
            if settings.seed_demo:
                seed_tickets(ctx.store, ctx.clf, ctx.threshold())
        yield

    app = FastAPI(
        title="SmartTicket", version="2.0.0", lifespan=lifespan,
        description=("Classifies support tickets by type, queue and priority (TF-IDF + Logistic Regression). "
                     "`POST /predict` is stateless. `POST /tickets` also stores the ticket and routes it: "
                     "`enviado` when the queue confidence reaches the review threshold, otherwise `revision` "
                     "(queued for a person). Every prediction includes the words that drove the queue decision."),
    )
    app.state.ctx = ctx
    add_security_headers(app, settings)
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    register_pages(app, ctx)
    app.include_router(public_router())
    app.include_router(auth_router())
    app.include_router(panel_router())
    register_errors(app)
    return app


def bootstrap_admin(ctx: Ctx) -> None:
    """Production: the first admin comes from env vars. There is never a built-in default password."""
    s = ctx.settings
    if ctx.store.count_admins():
        return
    if s.admin_email and s.admin_password:
        if password_problem(s.admin_password):
            log.error("SMARTTICKET_ADMIN_PASSWORD is too weak (min. 10 chars, letters and digits); admin not created")
            return
        if ctx.store.user_by_email(s.admin_email) is None:
            ctx.store.create_user(s.admin_email, "Admin", "admin", hash_password(s.admin_password))
    elif not s.dev:
        log.warning("No admin account. Set SMARTTICKET_ADMIN_EMAIL and SMARTTICKET_ADMIN_PASSWORD to create one.")


# ----- HTML pages --------------------------------------------------------------------------------
# Example tickets shown on the landing page; their numbers come from the live model on every render.
SHOWCASE = [
    ("Charged twice for my subscription",
     "Hello, I was billed twice for my monthly subscription this month. Both payments show on my credit card "
     "statement. Please refund the duplicate payment."),
    ("When is my vacation paid?",
     "Hi, I booked vacation for December and want to know if it is paid before I leave or in the normal pay "
     "cycle. Thanks."),
]
PANEL_SECTIONS = {"revision": False, "enviados": False, "todos": False, "cuenta": False,
                  "umbral": True, "equipo": True, "mensajes": True}  # section -> admin only
PAGES = {"/faq": "faq", "/privacy": "privacy", "/terms": "terms", "/contact": "contact"}


def html_page(request: Request, name: str, values: dict | None = None, status: int = 200) -> HTMLResponse:
    ctx = ctx_of(request)
    csrf = request.cookies.get(CSRF_COOKIE) or new_token()
    defaults = {"csrf": csrf, "dev": "1" if ctx.settings.dev else "0",
                "account_href": "/panel" if session_user(request) else "/login"}
    body = i18n.render(name, lang_of(request), {**defaults, **(values or {})})
    response = HTMLResponse(body, status_code=status)
    if request.cookies.get(CSRF_COOKIE) != csrf:
        set_cookie(response, ctx.settings, CSRF_COOKIE, csrf, max_age=60 * 60 * 24, samesite="strict")
    return response


def register_pages(app: FastAPI, ctx: Ctx) -> None:
    @app.get("/", response_class=HTMLResponse, include_in_schema=False)
    def landing(request: Request):
        threshold = ctx.threshold()
        showcase = []
        if ctx.clf.available:
            showcase = [{"subject": s, **ctx.clf.predict(s, b, threshold)} for s, b in SHOWCASE]
        rows = [r for r in ctx.sweep() if round(r["threshold"], 2) in (0.4, 0.5, 0.6, 0.7)]
        return html_page(request, "index", {
            "threshold": f"{threshold:.2f}",
            "showcase": json.dumps(showcase),
            "board": json.dumps({"threshold": round(threshold, 2), "rows": rows}),
        })

    @app.get("/login", response_class=HTMLResponse, include_in_schema=False)
    def login_page(request: Request):
        if session_user(request) is not None:
            return RedirectResponse("/panel", status_code=303)
        return html_page(request, "login")

    @app.get("/panel", response_class=HTMLResponse, include_in_schema=False)
    @app.get("/panel/{section}", response_class=HTMLResponse, include_in_schema=False)
    def panel_page(request: Request, section: str = "revision"):
        user = session_user(request)
        if user is None:
            return RedirectResponse("/login", status_code=303)
        if section not in PANEL_SECTIONS:
            return html_page(request, "error", {"code": "404"}, status=404)
        if PANEL_SECTIONS[section] and user["role"] != "admin":
            return html_page(request, "error", {"code": "403"}, status=403)
        return html_page(request, "panel", {"session_csrf": user["csrf_token"], "section": section})

    for path, name in PAGES.items():
        def page(request: Request, _name: str = name):
            return html_page(request, _name)
        app.add_api_route(path, page, methods=["GET"], response_class=HTMLResponse, include_in_schema=False)


def register_errors(app: FastAPI) -> None:
    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException):
        wants_html = request.method == "GET" and "text/html" in request.headers.get("accept", "")
        if exc.status_code == 404 and wants_html and not request.url.path.startswith(("/api/", "/static/")):
            return html_page(request, "error", {"code": "404"}, status=404)
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code,
                            headers=getattr(exc, "headers", None))


# ----- public API --------------------------------------------------------------------------------
def public_router() -> APIRouter:
    r = APIRouter()

    @r.get("/health")
    def health(request: Request) -> dict:
        return {"status": "ok", "model_loaded": ctx_of(request).clf.available}

    @r.get("/model-info")
    def model_info(request: Request) -> dict:
        ctx = ctx_of(request)
        try:
            m = ctx.clf.metrics
        except ModelUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {
            "trained_at": m["trained_at"],
            "n_tickets": m["n_tickets"],
            "review_threshold": ctx.threshold(),
            "targets": {
                t: {k: v[k] for k in ("classes", "accuracy", "macro_f1", "weighted_f1", "baseline_macro_f1")}
                for t, v in m["targets"].items()
            },
            "threshold_sweep": ctx.sweep(),
        }

    @r.post("/predict", response_model=Prediction)
    def predict(ticket: Ticket, request: Request) -> dict:
        """Classify one ticket without storing it."""
        return ctx_of(request).predict(ticket.subject, ticket.body)

    @r.post("/predict/batch", response_model=list[Prediction])
    def predict_batch(batch: Batch, request: Request) -> list[dict]:
        """Classify up to 100 tickets without storing them."""
        ctx = ctx_of(request)
        return [ctx.predict(t.subject, t.body) for t in batch.tickets]

    @r.post("/tickets", response_model=StoredTicket, status_code=201)
    def submit_ticket(ticket: Ticket, request: Request) -> dict:
        """Classify, store and route one ticket: `enviado` (auto-routed) or `revision` (queued for a person)."""
        rate_limit(request, "tickets", 30, 60)
        return stored(ctx_of(request), ticket.subject, ticket.body, "web")

    @r.post("/tickets/batch", response_model=list[StoredTicket], status_code=201)
    def submit_batch(batch: StoreBatch, request: Request) -> list[dict]:
        """Classify, store and route up to 10 tickets."""
        rate_limit(request, "tickets", 30, 60)
        ctx = ctx_of(request)
        return [stored(ctx, t.subject, t.body, "lote") for t in batch.tickets]

    @r.post("/api/contact", status_code=201, include_in_schema=False, dependencies=[Depends(require_anon_csrf)])
    def contact(msg: Contact, request: Request) -> dict:
        if msg.website.strip():  # a bot filled the honeypot: look successful, store nothing
            return {"ok": True}
        name, email, text = msg.name.strip(), msg.email.strip(), msg.message.strip()
        errors = {}
        if len(name) < 2:
            errors["name"] = "name_required"
        if not EMAIL_RE.match(email):
            errors["email"] = "email_invalid"
        if len(text) < 10:
            errors["message"] = "message_short"
        if errors:
            raise HTTPException(status_code=422, detail={"fields": errors})
        rate_limit(request, "contact", 3, 600)
        topic = msg.topic if msg.topic in ("general", "demo", "privacy", "bug") else "general"
        ctx_of(request).store.add_message(name[:120], email, topic, text)
        return {"ok": True}

    return r


# ----- auth --------------------------------------------------------------------------------------
def auth_router() -> APIRouter:
    r = APIRouter(prefix="/api/auth", include_in_schema=False)

    @r.post("/login", dependencies=[Depends(require_anon_csrf)])
    def login(body: Login, request: Request, response: Response) -> dict:
        ctx = ctx_of(request)
        s = ctx.settings
        rate_limit(request, "login", s.login_limit_per_minute, 60)
        user = ctx.store.user_by_email(body.email) if EMAIL_RE.match(body.email.strip()) else None
        locked = bool(user and user["locked_until"] and user["locked_until"] > iso(now()))
        if user is None or not user["active"] or locked:
            verify_password(body.password, DUMMY_HASH)  # same cost as a real check
            raise HTTPException(status_code=401, detail="invalid_credentials")
        if not verify_password(body.password, user["password_hash"]):
            failed = user["failed_attempts"] + 1
            if failed >= s.lockout_after:
                ctx.store.update_user(user["id"], failed_attempts=0,
                                      locked_until=iso(now() + timedelta(minutes=s.lockout_minutes)))
            else:
                ctx.store.update_user(user["id"], failed_attempts=failed)
            raise HTTPException(status_code=401, detail="invalid_credentials")

        ctx.store.update_user(user["id"], failed_attempts=0, locked_until=None, last_login_at=iso(now()))
        token = new_token()
        lifetime = timedelta(days=s.remember_days) if body.remember else timedelta(hours=s.session_hours)
        ctx.store.create_session(token_hash(token), user["id"], secrets.token_urlsafe(32), now() + lifetime)
        set_cookie(response, s, SESSION_COOKIE, token,
                   max_age=int(lifetime.total_seconds()) if body.remember else None)
        return {"ok": True, "must_change_password": bool(user["must_change_password"]), "redirect": "/panel"}

    @r.post("/logout")
    def logout(request: Request, response: Response, user=Depends(require_user)) -> dict:
        ctx_of(request).store.delete_session(token_hash(request.cookies[SESSION_COOKIE]))
        response.delete_cookie(SESSION_COOKIE, path="/")
        return {"ok": True, "redirect": "/login"}

    @r.post("/password")
    def change_password(body: PasswordChange, request: Request, user=Depends(require_user)) -> dict:
        ctx = ctx_of(request)
        if not verify_password(body.current, user["password_hash"]):
            raise HTTPException(status_code=400, detail="current_password_wrong")
        problem = password_problem(body.new)
        if problem:
            raise HTTPException(status_code=400, detail=problem)
        if body.new == body.current:
            raise HTTPException(status_code=400, detail="password_same")
        ctx.store.update_user(user["id"], password_hash=hash_password(body.new), must_change_password=0)
        # every other session of this account is signed out
        ctx.store.delete_user_sessions(user["id"], keep=token_hash(request.cookies[SESSION_COOKIE]))
        return {"ok": True}

    return r


# ----- staff panel API ---------------------------------------------------------------------------
def panel_router() -> APIRouter:
    r = APIRouter(prefix="/api/panel", include_in_schema=False)

    @r.get("/me")
    def me(request: Request, user=Depends(require_user)) -> dict:
        ctx = ctx_of(request)
        out = {"user": user_public(user), "counts": ctx.store.counts(), "threshold": ctx.threshold(),
               "queues": ctx.queues()}
        if user["role"] == "admin":
            out["unread_messages"] = ctx.store.unread_messages()
        return out

    @r.get("/tickets")
    def list_tickets(request: Request, view: Literal["revision", "enviados", "todos"] = "revision",
                     filter: Literal["todos", "urgentes", "antiguos"] = "todos", q: str = "",
                     user=Depends(require_ready_user)) -> dict:
        store = ctx_of(request).store
        return {"items": [ticket_summary(t) for t in store.tickets(view, filter, q[:100])],
                "counts": store.counts()}

    @r.get("/tickets/{ticket_id}")
    def get_ticket(ticket_id: int, request: Request, user=Depends(require_ready_user)) -> dict:
        row = ctx_of(request).store.ticket(ticket_id)
        if row is None:
            raise HTTPException(status_code=404, detail="not_found")
        return ticket_dict(row)

    @r.post("/tickets/{ticket_id}/assign")
    def assign(ticket_id: int, body: Assign, request: Request, user=Depends(require_ready_user)) -> dict:
        ctx = ctx_of(request)
        if body.queue not in ctx.queues():
            raise HTTPException(status_code=400, detail="unknown_queue")
        if not ctx.store.assign(ticket_id, body.queue, user["id"]):
            raise HTTPException(status_code=409, detail="not_in_review")
        return ticket_dict(ctx.store.ticket(ticket_id))

    @r.post("/tickets/{ticket_id}/defer")
    def defer(ticket_id: int, request: Request, user=Depends(require_ready_user)) -> dict:
        if not ctx_of(request).store.defer(ticket_id):
            raise HTTPException(status_code=409, detail="not_in_review")
        return {"ok": True}

    @r.get("/threshold")
    def get_threshold(request: Request, user=Depends(require_admin)) -> dict:
        ctx = ctx_of(request)
        confs = ctx.store.confidences()
        live = [{"threshold": t, "auto": sum(c >= t for c in confs)}
                for t in (round(0.30 + 0.05 * i, 2) for i in range(13))]
        return {"threshold": ctx.threshold(), "min": THRESHOLD_MIN, "max": THRESHOLD_MAX, "total": len(confs),
                "live": live, "sweep": ctx.sweep(), "areas": ctx.store.area_counts(), "queues": ctx.queues(),
                "counts": ctx.store.counts()}

    @r.post("/threshold")
    def set_threshold(body: ThresholdIn, request: Request, user=Depends(require_admin)) -> dict:
        value = round(body.threshold, 2)
        if not THRESHOLD_MIN <= value <= THRESHOLD_MAX:
            raise HTTPException(status_code=400, detail="threshold_range")
        ctx_of(request).store.set_setting("review_threshold", f"{value:.2f}")
        return {"threshold": value}

    @r.get("/team")
    def team(request: Request, user=Depends(require_admin)) -> dict:
        return {"items": [user_public(u) for u in ctx_of(request).store.users()], "me": user["id"]}

    @r.post("/team", status_code=201)
    def add_member(body: NewMember, request: Request, user=Depends(require_admin)) -> dict:
        ctx = ctx_of(request)
        email = body.email.strip()
        if not EMAIL_RE.match(email):
            raise HTTPException(status_code=400, detail="email_invalid")
        if ctx.store.user_by_email(email) is not None:
            raise HTTPException(status_code=409, detail="email_taken")
        if body.area and body.area not in ctx.queues():
            raise HTTPException(status_code=400, detail="unknown_queue")
        password = temp_password()
        uid = ctx.store.create_user(email, body.name, body.role, hash_password(password),
                                    area=body.area or None, must_change=True)
        return {"user": user_public(ctx.store.user_by_id(uid)), "temp_password": password}

    @r.post("/team/{user_id}/deactivate")
    def deactivate(user_id: int, request: Request, user=Depends(require_admin)) -> dict:
        ctx = ctx_of(request)
        if user_id == user["id"]:
            raise HTTPException(status_code=400, detail="cannot_deactivate_self")
        if ctx.store.user_by_id(user_id) is None:
            raise HTTPException(status_code=404, detail="not_found")
        ctx.store.update_user(user_id, active=0)
        ctx.store.delete_user_sessions(user_id)
        return {"ok": True}

    @r.post("/team/{user_id}/reset")
    def reset_password(user_id: int, request: Request, user=Depends(require_admin)) -> dict:
        ctx = ctx_of(request)
        target = ctx.store.user_by_id(user_id)
        if target is None or not target["active"]:
            raise HTTPException(status_code=404, detail="not_found")
        password = temp_password()
        ctx.store.update_user(user_id, password_hash=hash_password(password), must_change_password=1,
                              failed_attempts=0, locked_until=None)
        ctx.store.delete_user_sessions(user_id)
        return {"temp_password": password}

    @r.get("/messages")
    def messages(request: Request, user=Depends(require_admin)) -> dict:
        return {"items": [dict(m) for m in ctx_of(request).store.messages()]}

    @r.post("/messages/{message_id}/read")
    def message_read(message_id: int, request: Request, user=Depends(require_admin)) -> dict:
        if not ctx_of(request).store.mark_message_read(message_id):
            raise HTTPException(status_code=404, detail="not_found")
        return {"ok": True}

    return r


app = create_app()
