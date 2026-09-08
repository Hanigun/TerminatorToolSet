"""Session cache: LRU store of open editing sessions (SpreadsheetML docs)."""
from __future__ import annotations

import os

from ..domain import spreadsheet_ml as spreadsheet_ml_mod
from ..domain.spreadsheet_ml import SpreadsheetML
from ..domain.xmlgrid import Session


# -- session store ------------------------------------------------------------
class SessionStore:
    """Owns the session containers (mutated in place, never rebound)."""

    def __init__(self, max_sessions: int = 20):
        self.sessions: "dict[str, Session]" = {}
        self.order: "list[str]" = []      # LRU: least recently used first
        self.dirty: "set[str]" = set()    # in-memory edits not yet saved to disk
        self.max = max_sessions

    # -- path helper ----------------------------------------------------------
    @staticmethod
    def normal(path_key: str) -> str:
        """Normalize a path key (tolerates bad input)."""
        try:
            return os.path.normpath(path_key)
        except Exception:  # noqa: BLE001
            return path_key

    # -- LRU cache --------------------------------------------------------------
    def evict(self):
        """Cap in-memory sessions (LRU). Sessions with unsaved edits are kept."""
        while len(self.sessions) > self.max:
            victim = next((p for p in self.order if p not in self.dirty), None)
            if victim is None:
                break  # all sessions dirty - keep them
            self.order.remove(victim)
            self.sessions.pop(victim, None)

    def drop(self, path_key: str) -> None:
        """Forget one session entirely (rollback / forced reopen)."""
        pk = self.normal(path_key)
        self.dirty.discard(pk)
        self.sessions.pop(pk, None)
        if pk in self.order:
            self.order.remove(pk)

    def get(self, path_key: str, recover: bool = False) -> Session:
        """Get or open the editing session for a file (LRU-cached)."""
        pk = self.normal(path_key)
        s = self.sessions.get(pk)
        if s is not None:
            if pk in self.order:
                self.order.remove(pk)
            self.order.append(pk)
            return s
        d = SpreadsheetML()
        d.load(pk, recover=recover)
        s = Session(d, 0)
        self.sessions[pk] = s
        self.order.append(pk)
        self.evict()
        return s

    # -- light grid --------------------------------------------------------------
    @staticmethod
    def minimal_grid(path: str) -> dict:
        """Streaming iterparse of the first worksheet -> logical row values.

        First yielded row is the header (matches Session.grid() column
        semantics: links index col 0 + sysname-titled columns); the rest
        are data rows. Honours sparse ss:Index cell positions without
        building the full lxml tree.
        """
        stream = spreadsheet_ml_mod.iter_rows_logical(path, skip_header=False)
        stream = iter(stream)
        try:
            header = next(stream)
        except StopIteration:
            header = []
        rows = [{"values": v} for v in stream]
        return {"rows": rows, "sheet_index": 0,
                "columns": [str(c or "") for c in header]}
