"""SQLite persistence (stdlib sqlite3). One short-lived connection per operation keeps it thread-safe."""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'agente')),
    area TEXT,
    password_hash TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    created_at TEXT NOT NULL,
    last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    type_label TEXT NOT NULL, type_conf REAL NOT NULL,
    queue_label TEXT NOT NULL, queue_conf REAL NOT NULL,
    priority_label TEXT NOT NULL, priority_conf REAL NOT NULL,
    top3_json TEXT NOT NULL,
    words_json TEXT NOT NULL,
    threshold REAL NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('enviado', 'revision', 'asignado')),
    assigned_queue TEXT,
    assigned_by INTEGER REFERENCES users(id),
    assigned_at TEXT,
    deferred_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status, created_at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contact_messages (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    topic TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT
);
"""

TICKET_CODE_OFFSET = 20400  # human-friendly codes: ticket 1 -> ST-20401


def now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def ticket_code(ticket_id: int) -> str:
    return f"ST-{TICKET_CODE_OFFSET + ticket_id}"


class Store:
    def __init__(self, path: Path):
        self.path = Path(path)

    @contextmanager
    def conn(self) -> Iterator[sqlite3.Connection]:
        con = sqlite3.connect(self.path, timeout=10)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys = ON")
        try:
            yield con
            con.commit()
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()

    def init(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.conn() as c:
            c.execute("PRAGMA journal_mode = WAL")
            c.executescript(SCHEMA)

    # ----- settings -------------------------------------------------------------------------------
    def get_setting(self, key: str, default: str | None = None) -> str | None:
        with self.conn() as c:
            row = c.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default

    def set_setting(self, key: str, value: str) -> None:
        with self.conn() as c:
            c.execute("INSERT INTO settings(key, value) VALUES (?, ?) "
                      "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))

    def threshold(self, default: float) -> float:
        return float(self.get_setting("review_threshold", str(default)))

    # ----- users ----------------------------------------------------------------------------------
    def user_by_email(self, email: str) -> sqlite3.Row | None:
        with self.conn() as c:
            return c.execute("SELECT * FROM users WHERE email = ?", (email.strip(),)).fetchone()

    def user_by_id(self, user_id: int) -> sqlite3.Row | None:
        with self.conn() as c:
            return c.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()

    def users(self) -> list[sqlite3.Row]:
        with self.conn() as c:
            return c.execute("SELECT * FROM users ORDER BY active DESC, role, name").fetchall()

    def count_admins(self) -> int:
        with self.conn() as c:
            return c.execute("SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1").fetchone()[0]

    def create_user(self, email: str, name: str, role: str, password_hash: str, *,
                    area: str | None = None, must_change: bool = False) -> int:
        with self.conn() as c:
            cur = c.execute(
                "INSERT INTO users(email, name, role, area, password_hash, must_change_password, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (email.strip(), name.strip(), role, area, password_hash, int(must_change), iso(now())))
            return int(cur.lastrowid)

    def update_user(self, user_id: int, **fields) -> None:
        cols = ", ".join(f"{k} = ?" for k in fields)
        with self.conn() as c:
            c.execute(f"UPDATE users SET {cols} WHERE id = ?", (*fields.values(), user_id))

    # ----- sessions -------------------------------------------------------------------------------
    def create_session(self, token_hash: str, user_id: int, csrf: str, expires: datetime) -> None:
        with self.conn() as c:
            c.execute("DELETE FROM sessions WHERE expires_at < ?", (iso(now()),))
            c.execute("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)",
                      (token_hash, user_id, csrf, iso(now()), iso(expires)))

    def session(self, token_hash: str) -> sqlite3.Row | None:
        with self.conn() as c:
            return c.execute(
                "SELECT s.csrf_token, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id "
                "WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1",
                (token_hash, iso(now()))).fetchone()

    def delete_session(self, token_hash: str) -> None:
        with self.conn() as c:
            c.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))

    def delete_user_sessions(self, user_id: int, keep: str | None = None) -> None:
        with self.conn() as c:
            c.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash IS NOT ?", (user_id, keep))

    # ----- tickets --------------------------------------------------------------------------------
    def add_ticket(self, subject: str, body: str, source: str, pred: dict, created: datetime | None = None) -> int:
        status = "revision" if pred["needs_review"] else "enviado"
        with self.conn() as c:
            cur = c.execute(
                "INSERT INTO tickets(subject, body, source, created_at, type_label, type_conf, queue_label, "
                "queue_conf, priority_label, priority_conf, top3_json, words_json, threshold, status) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (subject, body, source, iso(created or now()),
                 pred["type"]["label"], pred["type"]["confidence"],
                 pred["queue"]["label"], pred["queue"]["confidence"],
                 pred["priority"]["label"], pred["priority"]["confidence"],
                 json.dumps(pred["queue_top3"]), json.dumps(pred["top_words"]), pred["threshold"], status))
            return int(cur.lastrowid)

    def ticket(self, ticket_id: int) -> sqlite3.Row | None:
        with self.conn() as c:
            return c.execute("SELECT t.*, u.name AS assigned_by_name FROM tickets t "
                             "LEFT JOIN users u ON u.id = t.assigned_by WHERE t.id = ?", (ticket_id,)).fetchone()

    def tickets(self, view: str, flt: str = "todos", q: str = "", limit: int = 200) -> list[sqlite3.Row]:
        where, args = [], []
        if view == "revision":
            where.append("t.status = 'revision'")
        elif view == "enviados":
            where.append("t.status = 'enviado'")
        if flt == "urgentes":
            where.append("t.priority_label = 'high'")
        if q:
            like = f"%{q.strip()}%"
            where.append("(t.subject LIKE ? OR t.body LIKE ? OR ('ST-' || (t.id + ?)) LIKE ?)")
            args += [like, like, TICKET_CODE_OFFSET, like]
        sql = ("SELECT t.*, u.name AS assigned_by_name FROM tickets t LEFT JOIN users u ON u.id = t.assigned_by"
               + (" WHERE " + " AND ".join(where) if where else ""))
        if flt == "antiguos":
            sql += " ORDER BY t.created_at ASC, t.id ASC"
        elif view == "revision":
            # deferred tickets ("Dejar para después") sink to the bottom of the queue
            sql += " ORDER BY t.deferred_at IS NOT NULL, t.deferred_at, t.created_at DESC, t.id DESC"
        else:
            sql += " ORDER BY t.created_at DESC, t.id DESC"
        sql += " LIMIT ?"
        with self.conn() as c:
            return c.execute(sql, (*args, limit)).fetchall()

    def counts(self) -> dict:
        with self.conn() as c:
            row = c.execute(
                "SELECT COUNT(*) AS total, "
                "SUM(status = 'revision') AS revision, SUM(status = 'enviado') AS enviado, "
                "SUM(status = 'asignado') AS asignado, "
                "SUM(status = 'revision' AND priority_label = 'high') AS urgentes FROM tickets").fetchone()
        return {k: int(row[k] or 0) for k in row.keys()}

    def confidences(self) -> list[float]:
        with self.conn() as c:
            return [r[0] for r in c.execute("SELECT queue_conf FROM tickets")]

    def area_counts(self) -> dict[str, dict]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT COALESCE(assigned_queue, queue_label) AS area, status, COUNT(*) AS n FROM tickets "
                "GROUP BY area, status").fetchall()
        out: dict[str, dict] = {}
        for r in rows:
            out.setdefault(r["area"], {"enviado": 0, "revision": 0, "asignado": 0})[r["status"]] = r["n"]
        return out

    def assign(self, ticket_id: int, queue: str, user_id: int) -> bool:
        with self.conn() as c:
            cur = c.execute(
                "UPDATE tickets SET status = 'asignado', assigned_queue = ?, assigned_by = ?, assigned_at = ?, "
                "deferred_at = NULL WHERE id = ? AND status = 'revision'", (queue, user_id, iso(now()), ticket_id))
            return cur.rowcount == 1

    def defer(self, ticket_id: int) -> bool:
        with self.conn() as c:
            cur = c.execute("UPDATE tickets SET deferred_at = ? WHERE id = ? AND status = 'revision'",
                            (iso(now()), ticket_id))
            return cur.rowcount == 1

    # ----- contact --------------------------------------------------------------------------------
    def add_message(self, name: str, email: str, topic: str, message: str) -> int:
        with self.conn() as c:
            cur = c.execute("INSERT INTO contact_messages(name, email, topic, message, created_at) "
                            "VALUES (?, ?, ?, ?, ?)", (name, email, topic, message, iso(now())))
            return int(cur.lastrowid)

    def messages(self) -> list[sqlite3.Row]:
        with self.conn() as c:
            return c.execute("SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 500").fetchall()

    def mark_message_read(self, message_id: int) -> bool:
        with self.conn() as c:
            cur = c.execute("UPDATE contact_messages SET read_at = COALESCE(read_at, ?) WHERE id = ?",
                            (iso(now()), message_id))
            return cur.rowcount == 1

    def unread_messages(self) -> int:
        with self.conn() as c:
            return c.execute("SELECT COUNT(*) FROM contact_messages WHERE read_at IS NULL").fetchone()[0]


def ticket_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "code": ticket_code(row["id"]),
        "subject": row["subject"],
        "body": row["body"],
        "source": row["source"],
        "created_at": row["created_at"],
        "type": {"label": row["type_label"], "confidence": row["type_conf"]},
        "queue": {"label": row["queue_label"], "confidence": row["queue_conf"]},
        "priority": {"label": row["priority_label"], "confidence": row["priority_conf"]},
        "queue_top3": json.loads(row["top3_json"]),
        "top_words": json.loads(row["words_json"]),
        "threshold": row["threshold"],
        "status": row["status"],
        "assigned_queue": row["assigned_queue"],
        "assigned_by": row["assigned_by_name"] if "assigned_by_name" in row.keys() else None,
        "assigned_at": row["assigned_at"],
        "deferred": row["deferred_at"] is not None,
    }


def ago(minutes: float) -> datetime:
    return now() - timedelta(minutes=minutes)
