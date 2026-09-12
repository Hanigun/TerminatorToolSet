"""Edit history: journal queries, undo/redo cursor, file payloads."""
from __future__ import annotations


# -- history log ------------------------------------------------------------
class HistoryLog:
    """Reads the change journal (db) and drives undo/redo on sessions.

    The journal is a linear timeline (newest first); undone records (all
    newer than the cursor) are the redoable future, applied ones the past.
    """

    def __init__(self, store, db):
        self._store = store   # SessionStore: dirty-set lives here
        self._db = db         # Database: history_for / set_undone

    # -- journal ------------------------------------------------------------
    def state(self, path: str):
        """(journal newest-first, applied records, undone records)."""
        entries = self._db.history_for(path)
        applied = [e for e in entries if not e["undone"]]
        undone = [e for e in entries if e["undone"]]
        return entries, applied, undone

    def flags(self, path: str) -> dict:
        """Undo/redo button state for a file."""
        _, applied, undone = self.state(path)
        return {"can_undo": bool(applied), "can_redo": bool(undone)}

    # -- cursor ---------------------------------------------------------------
    # Операции журнала никогда не пишут на диск сами: правки живут в памяти
    # (сессия помечается dirty), запись — только явным «Сохранить» / Ctrl+S.
    # save=True оставлен для редких внутренних вызовов, которым нужен
    # именно записанный файл.
    def undo_once(self, session, save: bool = False):
        """Revert the newest applied change (mark undone + inverse diff).
        Returns (client patch, record) or (None, None)."""
        _entries, applied, _undone = self.state(session.path)
        if not applied:
            return None, None
        target = applied[0]
        patch = session.apply_history_op(target["action"], target["payload"],
                                         forward=False)
        self._db.set_undone(target["id"], True)
        if save:
            session.save()
            self._store.dirty.discard(session.path)
        else:
            session.dirty = True
            self._store.dirty.add(session.path)
        return patch, target

    def redo_once(self, session, save: bool = False):
        """Re-apply the oldest undone change (redo walks forward).
        Returns (client patch, record)."""
        _entries, _applied, undone = self.state(session.path)
        if not undone:
            return None, None
        rec = undone[-1]   # journal is newest-first: oldest undone is last
        patch = session.apply_history_op(rec["action"], rec["payload"],
                                         forward=True)
        self._db.set_undone(rec["id"], False)
        if save:
            session.save()
            self._store.dirty.discard(session.path)
        else:
            session.dirty = True
            self._store.dirty.add(session.path)
        return patch, rec

    # -- payloads -------------------------------------------------------------
    @staticmethod
    def file_payload(session) -> dict:
        """Full grid payload for an open file response."""
        g = session.grid()
        return {
            "path": session.path,
            "sheet_index": session.sheet_index,
            "sheet_name": g["sheet_name"],
            "sheets": g["sheets"],
            "columns": g["columns"],
            "comments": g["comments"],
            "rows": g["rows"],
            "expanded_cols": g["expanded_cols"],
            "recovered": bool(session.recovered),
        }

    @staticmethod
    def short_val(v, n=24):
        """Truncate a value for the human-readable history summary."""
        t = str(v)
        return t if len(t) <= n else t[: n - 1] + "…"
