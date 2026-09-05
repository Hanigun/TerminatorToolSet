"""SQLite persistence: linear change journal + undo/redo cursor + recents.

Every user action is one small change record (a cell edit, a row or column
addition/removal) - never a full file copy. The journal is chronological and
acts like Photoshop's history timeline: a cursor separates applied records
from undone ones. Undo marks the newest applied record as undone (after
applying its inverse diff), redo re-applies the newest undone record, and a
new change purges everything after the cursor. All three are instant
single-cell/row/column patches - no snapshot writes anywhere.

History persists across restarts (DB lives next to the executable/config).
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from typing import Optional

# per-file history cap: enough for long editing sessions, tiny on disk
HISTORY_CAP = 400


class Database:
    """SQLite store for the change history and the recents list."""

    def __init__(self, db_path: str):
        self.path = db_path
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        # Allow multi-threaded access with a lock
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        self._init_schema()

    def _init_schema(self):
        with self._lock:
            cur = self.conn.cursor()
            # migration from the old snapshot-based schema: drop the blob
            # table and any history rows that predate the diff journal
            cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='backups'")
            if cur.fetchone() is not None:
                cur.execute("DROP TABLE backups")
            cur.execute("PRAGMA table_info(history)")
            cols = {r[1] for r in cur.fetchall()}
            if cols and "undone" not in cols:
                cur.execute("DROP TABLE history")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    file_path TEXT NOT NULL,
                    ts REAL NOT NULL,
                    action TEXT NOT NULL,
                    summary TEXT,
                    payload TEXT,
                    undone INTEGER NOT NULL DEFAULT 0
                )""")
            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_history_path ON history(file_path)""")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS recents (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    kind TEXT NOT NULL,
                    path TEXT NOT NULL,
                    last_opened REAL
                )""")
            self.conn.commit()

    def close(self):
        try:
            self.conn.close()
        except Exception:  # noqa: BLE001
            pass

    # -- history ---------------------------------------------------------------
    def log_change(self, file_path: str, action: str, payload: dict, summary: str) -> int:
        """Append one real change to the journal.

        Everything after the cursor (undone records) is discarded first -
        a new action makes the redoable future obsolete."""
        with self._lock:
            cur = self.conn.cursor()
            cur.execute("DELETE FROM history WHERE file_path=? AND undone=1", (file_path,))
            cur.execute(
                "INSERT INTO history (file_path, ts, action, summary, payload, undone) "
                "VALUES (?,?,?,?,?,0)",
                (file_path, time.time(), action, summary,
                 json.dumps(payload, ensure_ascii=False)))
            rid = cur.lastrowid
            self._trim(cur, file_path)
            self.conn.commit()
            return rid

    def set_undone(self, record_id: int, undone: bool):
        """Move the cursor over one record (the inverse diff was already
        applied to the document by the caller)."""
        with self._lock:
            self.conn.execute("UPDATE history SET undone=? WHERE id=?",
                              (1 if undone else 0, record_id))
            self.conn.commit()

    def _trim(self, cur, file_path: str):
        cur.execute(
            "DELETE FROM history WHERE file_path=? AND undone=0 AND id NOT IN "
            "(SELECT id FROM history WHERE file_path=? AND undone=0 "
            " ORDER BY id DESC LIMIT ?)", (file_path, file_path, HISTORY_CAP))

    def history_for(self, file_path: str, limit: int = HISTORY_CAP) -> list[dict]:
        """Chronological journal, newest first, with the undone flag."""
        with self._lock:
            cur = self.conn.cursor()
            rows = cur.execute(
                "SELECT id, file_path, ts, action, summary, payload, undone "
                "FROM history WHERE file_path=? ORDER BY id DESC LIMIT ?",
                (file_path, limit)).fetchall()
            out = []
            for r in rows:
                d = dict(r)
                try:
                    d["payload"] = json.loads(d["payload"]) if d["payload"] else {}
                except (TypeError, ValueError):
                    d["payload"] = {}
                out.append(d)
            return out

    def clear_history(self, file_path: str):
        """Delete every journal record for one file."""
        with self._lock:
            cur = self.conn.cursor()
            cur.execute("DELETE FROM history WHERE file_path=?", (file_path,))
            self.conn.commit()

    # -- recents -------------------------------------------------------------
    def add_recent(self, kind: str, path: str):
        with self._lock:
            cur = self.conn.cursor()
            cur.execute("DELETE FROM recents WHERE kind=? AND path=?", (kind, path))
            cur.execute(
                "INSERT INTO recents (kind, path, last_opened) VALUES (?,?,?)",
                (kind, path, time.time()))
            self.conn.commit()

    def recents(self, limit: int = 20) -> list[dict]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT kind, path, last_opened FROM recents ORDER BY last_opened DESC "
                "LIMIT ?", (limit,)).fetchall()
            return [dict(r) for r in rows]

    def clear_recents(self):
        """Drop the whole recent files/projects list."""
        with self._lock:
            self.conn.execute("DELETE FROM recents")
            self.conn.commit()
