"""SWT mission scripts: open (parse + guid fix) and guarded save."""
from __future__ import annotations

import os

from ..domain import swt_editor as swt_mod


# -- swt ----------------------------------------------------------------------
class Swt:
    """Owns .swt open/save (mission Trigger/Action scripts).

    store: SessionStore (path normalization). saves: SavePipeline (edited
    marks). log: api logger (unused, kept for service symmetry).
    """

    def __init__(self, store, saves, log):
        self._store = store
        self._saves = saves
        self._log = log

    # -- open -------------------------------------------------------------------
    def open(self, path: str) -> dict:
        """Parse an .swt file + auto-fix duplicate guids + command dict."""
        path = self._store.normal(path or "")
        if not path or not os.path.isfile(path):
            return {"ok": False, "error": "not_found"}
        try:
            doc = swt_mod.parse_file(path)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e), "recoverable": True}
        fixed = swt_mod.fix_duplicate_guids(doc)
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            mtime = 0
        return {"ok": True, "path": path, "doc": doc, "mtime": mtime,
                "fixed": fixed, "cmds": swt_mod.SWT_CMDS}

    # -- save ---------------------------------------------------------------------
    def save(self, path: str, doc, mtime=0, force: bool = False) -> dict:
        """Write an .swt file (byte-compatible game format). mtime-guard: a
        file changed on disk after opening (external editor) is never
        silently overwritten without an explicit force - that would lose
        someone else's edits."""
        path = self._store.normal(path or "")
        if not path or not isinstance(doc, dict) or not isinstance(doc.get("triggers"), list):
            return {"ok": False, "error": "bad_request"}
        if not os.path.isfile(path):
            return {"ok": False, "error": "not_found"}
        try:
            base_mtime = float(mtime or 0)
        except (TypeError, ValueError):
            base_mtime = 0
        try:
            cur_mtime = os.path.getmtime(path)
        except OSError:
            cur_mtime = 0
        if not force and base_mtime and cur_mtime != base_mtime:
            return {"ok": False, "error": "swt_changed_on_disk",
                    "changed": True, "mtime": cur_mtime}
        try:
            written = swt_mod.save_file(path, doc)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}
        if written:
            self._saves.mark_edited(path)
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            mtime = cur_mtime
        return {"ok": True, "written": written, "mtime": mtime}
