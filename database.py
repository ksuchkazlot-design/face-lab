"""SQLite database for Face Lab Telegram bot.

Stores users, subscriptions and analysis history.
"""

import os
import sqlite3
import time
from contextlib import contextmanager
from typing import Any, Dict, List, Optional

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "face_lab.db")


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=20.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=20000")
    return conn


@contextmanager
def get_db():
    conn = _connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_db() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                user_id      INTEGER PRIMARY KEY,
                username     TEXT,
                first_name   TEXT,
                created_at   REAL,
                free_used    INTEGER DEFAULT 0,
                paid_analyses INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS subscriptions (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     INTEGER NOT NULL,
                type        TEXT NOT NULL,
                expires_at  REAL NOT NULL,
                created_at  REAL,
                payment_id  TEXT
            );

            CREATE TABLE IF NOT EXISTS payments (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     INTEGER NOT NULL,
                amount      INTEGER NOT NULL,
                currency    TEXT NOT NULL,
                product     TEXT NOT NULL,
                payment_id  TEXT,
                status      TEXT DEFAULT 'pending',
                created_at  REAL
            );

            CREATE TABLE IF NOT EXISTS analyses (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     INTEGER NOT NULL,
                created_at  REAL,
                overall     REAL,
                gender      TEXT,
                ethnicity   TEXT
            );
        """)


# --- Users ---

def upsert_user(user_id: int, username: str = "", first_name: str = ""):
    with get_db() as db:
        row = db.execute("SELECT user_id FROM users WHERE user_id = ?", (user_id,)).fetchone()
        if row:
            db.execute(
                "UPDATE users SET username = ?, first_name = ? WHERE user_id = ?",
                (username, first_name, user_id),
            )
        else:
            db.execute(
                "INSERT INTO users (user_id, username, first_name, created_at) VALUES (?, ?, ?, ?)",
                (user_id, username, first_name, time.time()),
            )


def get_user(user_id: int) -> Optional[Dict[str, Any]]:
    with get_db() as db:
        row = db.execute("SELECT * FROM users WHERE user_id = ?", (user_id,)).fetchone()
        return dict(row) if row else None


def mark_free_used(user_id: int):
    with get_db() as db:
        db.execute("UPDATE users SET free_used = 1 WHERE user_id = ?", (user_id,))


def has_free_analysis(user_id: int) -> bool:
    user = get_user(user_id)
    return user is not None and not user["free_used"]


def grant_analysis_credit(user_id: int):
    """Add one paid analysis credit to the user."""
    with get_db() as db:
        db.execute(
            "UPDATE users SET paid_analyses = paid_analyses + 1 WHERE user_id = ?",
            (user_id,),
        )


def consume_analysis_credit(user_id: int) -> bool:
    """Consume one paid analysis credit. Returns True if a credit was available."""
    with get_db() as db:
        row = db.execute(
            "SELECT paid_analyses FROM users WHERE user_id = ?", (user_id,)
        ).fetchone()
        if not row or row["paid_analyses"] <= 0:
            return False
        db.execute(
            "UPDATE users SET paid_analyses = paid_analyses - 1 WHERE user_id = ?",
            (user_id,),
        )
        return True


def has_paid_credit(user_id: int) -> bool:
    with get_db() as db:
        row = db.execute(
            "SELECT paid_analyses FROM users WHERE user_id = ?", (user_id,)
        ).fetchone()
        return row is not None and row["paid_analyses"] > 0


# --- Subscriptions ---

def add_subscription(user_id: int, sub_type: str, duration_secs: int, payment_id: str = ""):
    now = time.time()
    with get_db() as db:
        # Extend from now or from existing expiry
        row = db.execute(
            "SELECT expires_at FROM subscriptions WHERE user_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1",
            (user_id, now),
        ).fetchone()
        base = max(row["expires_at"], now) if row else now
        expires = base + duration_secs
        db.execute(
            "INSERT INTO subscriptions (user_id, type, expires_at, created_at, payment_id) VALUES (?, ?, ?, ?, ?)",
            (user_id, sub_type, expires, now, payment_id),
        )


def is_subscribed(user_id: int) -> bool:
    now = time.time()
    with get_db() as db:
        row = db.execute(
            "SELECT id FROM subscriptions WHERE user_id = ? AND expires_at > ? LIMIT 1",
            (user_id, now),
        ).fetchone()
        return row is not None


def get_subscription_info(user_id: int) -> Optional[Dict[str, Any]]:
    now = time.time()
    with get_db() as db:
        row = db.execute(
            "SELECT * FROM subscriptions WHERE user_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1",
            (user_id, now),
        ).fetchone()
        return dict(row) if row else None


# --- Payments ---

def add_payment(user_id: int, amount: int, currency: str, product: str,
                payment_id: str = "", status: str = "completed"):
    with get_db() as db:
        db.execute(
            "INSERT INTO payments (user_id, amount, currency, product, payment_id, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (user_id, amount, currency, product, payment_id, status, time.time()),
        )


# --- Analyses ---

def add_analysis(user_id: int, overall: float, gender: str, ethnicity: str):
    with get_db() as db:
        db.execute(
            "INSERT INTO analyses (user_id, created_at, overall, gender, ethnicity) VALUES (?, ?, ?, ?, ?)",
            (user_id, time.time(), overall, gender, ethnicity),
        )


def get_analyses(user_id: int, limit: int = 10) -> List[Dict[str, Any]]:
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]


def can_analyse(user_id: int) -> bool:
    """User can analyse ONLY if they have paid credit or an active subscription."""
    return has_paid_credit(user_id) or is_subscribed(user_id)


# Initialize on import
init_db()
