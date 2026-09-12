"""Save pipeline: disk writes, autosave policy, edited-file marks."""
from __future__ import annotations

import json
import os


# -- save pipeline ----------------------------------------------------------
class SavePipeline:
    """Owns disk writes, the autosave policy and green-dot edited marks.

    guarded: optional predicate fn(path) -> bool. Guarded files (unpacked
    game assets) are never autosaved - explicit save popup only.
    """

    def __init__(self, store, markers, config, guarded=None):
        self._store = store       # SessionStore: dirty-set lives here
        self._markers = markers   # Markers: configs/markers.json sections
        self._config = config
        self._guarded = guarded or (lambda p: False)

    # -- edited marks -------------------------------------------------------
    def path_edited(self, path: str) -> bool:
        """Was the file ever saved from the app (green dot on its tab)."""
        try:
            return os.path.normpath(path) in {
                os.path.normpath(f) for f in self._markers.all_files()}
        except Exception:  # noqa: BLE001
            return False

    def mark_edited(self, path: str) -> None:
        """Record a save in configs/markers.json (right section)."""
        try:
            self._markers.add(os.path.normpath(path))
            self.drop_legacy_markers()
        except Exception:  # noqa: BLE001
            pass

    def remove_edited_mark(self, path: str) -> None:
        """Drop the green mark (after a rollback to stock)."""
        try:
            markers = self._markers
            np = os.path.normpath(path)
            for sec in list(markers.data.keys()):
                if sec.startswith("_"):
                    continue
                lst = markers.data.get(sec) or []
                if np in {os.path.normpath(f) for f in lst}:
                    markers.data[sec] = [f for f in lst
                                         if os.path.normpath(f) != np]
            markers.save()
        except Exception:  # noqa: BLE001
            pass

    def drop_legacy_markers(self) -> None:
        """Remove stray root JSON markers (species etc.)."""
        try:
            d = self._config.cfg_dir if hasattr(self._config, "cfg_dir") \
                else self._config.dir
            for fn in os.listdir(d):
                if not fn.lower().endswith(".json"):
                    continue
                if fn in ("config.json", "markers.json"):
                    continue
                p = os.path.join(d, fn)
                try:
                    with open(p, "r", encoding="utf-8") as fh:
                        data = json.load(fh)
                    if isinstance(data, dict) and isinstance(data.get("files"), list):
                        os.remove(p)
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001
            pass

    # -- writes ---------------------------------------------------------------
    def safe_save(self, session, summary: str = "") -> dict:
        """Write the in-memory document to disk (history is stored as diffs,
        so saving no longer copies the whole file into the database).
        An unchanged document is NOT rewritten and gets NO edit mark."""
        try:
            res = session.save()
            written = bool(res.get("written", True))
            self._store.dirty.discard(session.path)
            if written:
                self.mark_edited(session.path)
            return {"ok": True, "saved": written}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def auto_save(self, data: dict) -> bool:
        """Per-request save flag wins, else the global auto_save setting."""
        if "save" in data:
            return bool(data.get("save"))
        return bool(self._config.get("auto_save", False))

    def autosaved(self, data: dict, session, summary: str = "") -> bool:
        """Save when autosave is on; True on a successful write.
        Recover sessions (broken XML) are never autosaved."""
        if getattr(session, "recovered", False):
            return False
        if not self.auto_save(data):
            return False
        # guarded files are never written silently - explicit popup only
        try:
            if self._guarded(getattr(session, "path", "")):
                return False
        except Exception:  # noqa: BLE001
            pass
        return bool(self.safe_save(session).get("ok"))

    def mark_dirty(self, session, saved: bool) -> None:
        """Track sessions with in-memory edits so LRU never evicts them."""
        if saved:
            self._store.dirty.discard(session.path)
        else:
            self._store.dirty.add(session.path)
