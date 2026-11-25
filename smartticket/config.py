"""Runtime configuration, read from environment variables once at app creation."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except ValueError:
        return default


@dataclass
class Settings:
    env: str = "production"  # "dev" enables demo accounts, demo tickets and non-Secure cookies
    model_path: Path = Path("models/model.joblib")
    db_path: Path = Path("data/smartticket.db")
    # initial review threshold; admins can change it later from the panel (stored in the database)
    review_threshold: float = 0.5
    admin_email: str | None = None
    admin_password: str | None = None
    seed_demo: bool = False
    session_hours: int = 12
    remember_days: int = 30
    login_limit_per_minute: int = 5
    lockout_after: int = 5
    lockout_minutes: int = 15

    @property
    def dev(self) -> bool:
        return self.env == "dev"

    @classmethod
    def from_env(cls) -> "Settings":
        env = os.getenv("SMARTTICKET_ENV", "production").strip().lower()
        return cls(
            env=env,
            model_path=Path(os.getenv("SMARTTICKET_MODEL", "models/model.joblib")),
            db_path=Path(os.getenv("SMARTTICKET_DB", "data/smartticket.db")),
            review_threshold=_float("SMARTTICKET_REVIEW_THRESHOLD", 0.5),
            admin_email=os.getenv("SMARTTICKET_ADMIN_EMAIL") or None,
            admin_password=os.getenv("SMARTTICKET_ADMIN_PASSWORD") or None,
            seed_demo=os.getenv("SMARTTICKET_SEED_DEMO", "1" if env == "dev" else "0") == "1",
        )
