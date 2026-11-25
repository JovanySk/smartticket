"""Password hashing, sessions, CSRF tokens and in-memory rate limiting."""
from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import threading
import time
from collections import defaultdict, deque

# scrypt: memory-hard KDF from the standard library (~16 MiB per hash with these parameters)
SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_LEN = 2 ** 14, 8, 1, 32

SESSION_COOKIE = "st_session"
CSRF_COOKIE = "st_csrf"  # double-submit token for forms used before login (login, contact)
CSRF_HEADER = "x-csrf-token"
LANG_COOKIE = "st_lang"

EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,24}$")


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=SCRYPT_LEN)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${_b64(salt)}${_b64(dk)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, dk = stored.split("$")
        if algo != "scrypt":
            return False
        expected = _unb64(dk)
        got = hashlib.scrypt(password.encode(), salt=_unb64(salt), n=int(n), r=int(r), p=int(p),
                             dklen=len(expected))
        return hmac.compare_digest(got, expected)
    except (ValueError, TypeError):
        return False


# Used when the e-mail does not exist so a failed login costs the same time either way.
DUMMY_HASH = hash_password(secrets.token_urlsafe(16))


def password_problem(password: str) -> str | None:
    """Return an error code if the password is too weak, else None."""
    if len(password) < 10:
        return "password_short"
    if len(password) > 200:
        return "password_long"
    if not (re.search(r"[A-Za-z]", password) and re.search(r"\d", password)):
        return "password_mix"
    return None


def temp_password() -> str:
    # readable but strong: 4 groups, always contains letters and digits
    alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    while True:
        pw = "-".join("".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(4))
        if password_problem(pw) is None:
            return pw


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    """Session tokens are stored hashed, so a leaked database cannot be replayed as cookies."""
    return hashlib.sha256(token.encode()).hexdigest()


def same_token(a: str | None, b: str | None) -> bool:
    return bool(a) and bool(b) and hmac.compare_digest(a, b)


class RateLimiter:
    """Sliding-window limiter keyed by (bucket, client). Process-local, which is enough for one instance."""

    def __init__(self) -> None:
        self._hits: dict[tuple[str, str], deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def hit(self, bucket: str, key: str, limit: int, window_s: float) -> bool:
        """Record a hit; return False if the limit for the window is already used up."""
        t = time.monotonic()
        with self._lock:
            q = self._hits[(bucket, key)]
            while q and q[0] <= t - window_s:
                q.popleft()
            if len(q) >= limit:
                return False
            q.append(t)
            return True

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()
