"""Durable attempt reservations, not a promise about the provider's invoice."""
from contextlib import contextmanager
import fcntl
import os
import sqlite3
import time
import uuid
from .config import PilotError


@contextmanager
def reserve(settings):
    path = settings.state_dir
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or path.stat().st_mode & 0o077:
        raise PilotError("STATE_DIRECTORY_MUST_BE_PRIVATE")
    # A single pilot on this host; flock also releases on process death.
    fd = os.open(path / "worker.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    db = None
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise PilotError("PILOT_ALREADY_RUNNING") from None
        db_path = path / "reservations.sqlite3"
        if db_path.is_symlink():
            raise PilotError("INVALID_LEDGER")
        db = sqlite3.connect(db_path, timeout=3)
        os.chmod(db_path, 0o600)
        db.execute("CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, at INTEGER NOT NULL, cents INTEGER NOT NULL, status TEXT NOT NULL)")
        db.execute("BEGIN IMMEDIATE")
        total = db.execute("SELECT COALESCE(SUM(cents), 0) FROM attempts").fetchone()[0]
        if total + settings.reservation_cents > settings.budget_cents:
            db.rollback()
            raise PilotError("PILOT_RESERVATION_BUDGET_EXHAUSTED")
        run_id = str(uuid.uuid4())
        db.execute("INSERT INTO attempts VALUES (?, ?, ?, 'reserved')",
                   (run_id, int(time.time()), settings.reservation_cents))
        db.commit()
        try:
            yield run_id
        except BaseException:
            db.execute("UPDATE attempts SET status='failed' WHERE id=?", (run_id,))
            db.commit()
            raise
        else:
            db.execute("UPDATE attempts SET status='completed' WHERE id=?", (run_id,))
            db.commit()
        # Never refund automatically: even a failed/cancelled request may be billed.
    finally:
        if db is not None:
            db.close()
        os.close(fd)
