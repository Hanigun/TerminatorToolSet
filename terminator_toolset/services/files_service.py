"""File lifecycle ops: save-as into project/mod, stock rollback, journal jump."""
from __future__ import annotations

import os
import shutil

from ..domain import swt_editor as swt_mod
from ..domain.spreadsheet_ml import SpreadsheetError


# -- files --------------------------------------------------------------------
class Files:
    """Owns cross-cutting file operations (save-as, stock restore, journal
    restore). Thin composition over the session store, save pipeline,
    history log, database and the open project.

    store: SessionStore. config: domain Config. saves: SavePipeline.
    hist: HistoryLog. db: Database (history wipe on stock rollback).
    entities: EntityIndex (open-project root). log: api logger.
    """

    def __init__(self, store, config, saves, hist, db, entities, log):
        self._store = store
        self._config = config
        self._saves = saves
        self._hist = hist
        self._db = db
        self._entities = entities
        self._log = log

    # -- save as ----------------------------------------------------------------
    def save_as(self, src: str, kind: str = "file", target: str = "project",
                doc=None, roots: dict = None) -> dict:
        """Save a session/doc into the project or the mod (unpacked-game
        guard applies). kind: file | swt | uprising. target: project | mod.
        Missing destination file -> the folder structure is recreated and
        the source bytes are copied first."""
        src = self._store.normal(src or "")
        if not src or not os.path.isfile(src):
            return {"ok": False, "error": "not_found"}
        roots = roots or {}
        root = roots.get("project") if target == "project" else roots.get("mod")
        if not root or root == "." or not os.path.isdir(root):
            return {"ok": False, "error": "need_config"}
        un = roots.get("unpacked")
        if un and un != "." and (src == un or src.startswith(un + os.sep)):
            rel = os.path.relpath(src, un)
        elif root != "." and (src == root or src.startswith(root + os.sep)):
            rel = os.path.relpath(src, root)
        else:
            rel = os.path.basename(src)
        dst = self._store.normal(os.path.join(root, rel))
        try:
            if not os.path.isfile(dst):
                parent = os.path.dirname(dst)
                if parent:
                    os.makedirs(parent, exist_ok=True)
                shutil.copy2(src, dst)
            if kind == "swt":
                if not isinstance(doc, dict):
                    return {"ok": False, "error": "bad_doc"}
                if not swt_mod.save_file(dst, doc):
                    return {"ok": False, "error": "write_failed"}
            else:
                s = self._store.get(src)
                res = s.save(dst)
                if isinstance(res, dict) and res.get("ok") is False:
                    return {"ok": False, "error": str(res.get("error", "write_failed"))}
            self._saves.mark_edited(dst)
            self._log.info("save_as %s -> %s", src, dst)
            return {"ok": True, "saved": True, "dst": dst}
        except Exception as e:  # noqa: BLE001
            self._log.info("save_as failed: %s -> %s: %s", src, dst, e)
            return {"ok": False, "error": str(e)}

    # -- stock rollback -----------------------------------------------------------
    def restore_stock(self, path: str) -> dict:
        """Roll a file back to the stock bytes from the main mod (mod_path).

        The path must sit inside the open project; the session is dropped,
        the file journal is wiped - it described edits of the old content
        and is meaningless after the swap."""
        path = self._store.normal(path or "")
        if not path or not os.path.isfile(path):
            return {"ok": False, "error": "not a file"}
        project = getattr(self._entities, "project", None)
        if project is None or not getattr(project, "root", None):
            return {"ok": False, "error": "no_project"}
        try:
            rel = os.path.relpath(path, project.root)
        except ValueError:
            return {"ok": False, "error": "outside_project"}
        if rel.startswith(".."):
            return {"ok": False, "error": "outside_project"}
        mod_root = self._config.get("mod_path") or ""
        if not mod_root or not os.path.isdir(mod_root):
            return {"ok": False, "error": "no_mod_path"}
        src = os.path.normpath(os.path.join(mod_root, rel))
        if not os.path.isfile(src):
            return {"ok": False, "error": "no_stock", "stock": src}
        try:
            with open(src, "rb") as fh:
                blob = fh.read()
            with open(path, "wb") as fh:
                fh.write(blob)
        except OSError as e:
            return {"ok": False, "error": str(e)}
        self._store.drop(path)
        self._db.clear_history(path)
        self._saves.remove_edited_mark(path)
        return {"ok": True, "stock": src}

    # -- original snapshot rollback ------------------------------------------------
    def origin_state(self, path: str) -> dict:
        """Does a pre-edit snapshot exist for this file (any location)?"""
        path = self._store.normal(path or "")
        if not path or not os.path.isfile(path):
            return {"ok": False, "error": "not a file"}
        return {"ok": True, "has_origin": self._saves.has_origin(path)}

    def origin_restore(self, path: str) -> dict:
        """Roll a file back to its pre-edit snapshot (first-save copy).

        Unlike the journal (rewinds logged edits only) and stock_restore
        (project files with a mod stock only), this works for ANY file and
        also covers edits that were never journaled - as long as the file
        was saved through the app at least once. Session dropped, journal
        wiped: it described the rolled-back content."""
        path = self._store.normal(path or "")
        if not path or not os.path.isfile(path):
            return {"ok": False, "error": "not a file"}
        blob = self._saves.origin_bytes(path)
        if blob is None:
            return {"ok": False, "error": "no_origin"}
        try:
            tmp = path + ".origin-tmp"
            with open(tmp, "wb") as fh:
                fh.write(blob)
            os.replace(tmp, path)
        except OSError as e:
            return {"ok": False, "error": str(e)}
        self._store.drop(path)
        self._db.clear_history(path)
        self._saves.remove_edited_mark(path)
        self._log.info("origin_restore %s (%d bytes)", path, len(blob))
        return {"ok": True}

    # -- journal jump ---------------------------------------------------------------
    def restore_record(self, path: str, rec_id: int) -> dict:
        """Move the file to the state recorded by one journal entry.

        Reverting to a past record undoes every newer change; 'reverting' to
        an undone record redoes the steps up to it. Moves the cursor only -
        records themselves are never created or destroyed. Memory only, no
        disk write: the session stays dirty until an explicit save."""
        path = self._store.normal(path or "")
        if not path or not os.path.isfile(path):
            return {"ok": False, "error": "not a file"}
        entries, _applied, _undone = self._hist.state(path)
        idx = next((i for i, e in enumerate(entries) if e["id"] == rec_id), -1)
        if idx < 0:
            return {"ok": False, "error": "record not found"}
        try:
            s = self._store.get(path)
            # records newer than the target that are still applied -> undo
            for e in entries[:idx]:
                if not e["undone"]:
                    self._hist.undo_once(s, save=False)
            # records at/older than the target still undone -> redo (oldest first)
            for e in reversed(entries[idx:]):
                if e["undone"]:
                    self._hist.redo_once(s, save=False)
            s.dirty = True
        except SpreadsheetError as e:
            return {"ok": False, "error": str(e)}
        self._store.dirty.add(s.path)
        return {"ok": True, "reload": True, **self._hist.flags(path)}

    # -- reset to beginning -------------------------------------------------------
    def restore_to_beginning(self, path: str) -> dict:
        """Undo every applied journal record: the file returns to the clean
        state before the first recorded change. Unlike restore_record() on
        the oldest entry - which keeps that first change applied - this
        also undoes the oldest record itself. Memory only, no disk write."""
        path = self._store.normal(path or "")
        if not path or not os.path.isfile(path):
            return {"ok": False, "error": "not a file"}
        try:
            entries, _applied, _undone = self._hist.state(path)
            s = self._store.get(path)
            n = 0
            for e in entries:  # newest-first: undo in reverse application order
                if not e["undone"]:
                    self._hist.undo_once(s, save=False)
                    n += 1
            s.dirty = True
        except SpreadsheetError as e:
            return {"ok": False, "error": str(e)}
        self._store.dirty.add(s.path)
        return {"ok": True, "undone": n, **self._hist.flags(path)}
