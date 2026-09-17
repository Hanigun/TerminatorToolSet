"""Save pipeline: disk writes, autosave policy, edited-file marks."""
from __future__ import annotations

import hashlib
import json
import os
import random
import shutil
import time


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
    def _snap_dir(self) -> str:
        """Central originals vault (NOT the SQLite DB: the history gate
        forbids blob snapshots there, and a byte copy restores even files
        whose edits were never journaled)."""
        try:
            base = getattr(self._config, "cfg_dir", None) \
                or getattr(self._config, "dir", "") or ""
        except Exception:  # noqa: BLE001
            base = ""
        d = os.path.join(base, "origin_snaps") if base else ""
        return d

    @staticmethod
    def _snap_key(path: str) -> str:
        return hashlib.sha1(os.path.normpath(path).lower()
                            .encode("utf-8", "replace")).hexdigest()[:16]

    def snap_paths(self, path: str):
        """(bytes path, meta path) for a snapshot, or (None, None)."""
        d = self._snap_dir()
        if not d or not path:
            return None, None
        key = self._snap_key(path)
        safe = "".join(c if (c.isalnum() or c in "._-") else "_"
                       for c in os.path.basename(path))[:60] or "file"
        return (os.path.join(d, "%s_%s.bin" % (key, safe)),
                os.path.join(d, "%s_%s.json" % (key, safe)))

    def has_origin(self, path: str) -> bool:
        """Is there a pre-edit snapshot for this file?"""
        blob, _meta = self.snap_paths(path or "")
        try:
            return bool(blob) and os.path.isfile(blob)
        except Exception:  # noqa: BLE001
            return False

    def snapshot_origin(self, path: str) -> bool:
        """Copy the current disk bytes aside ONCE (first save wins).

        Called before the first overwrite: disk still holds the pre-session
        content because edits live in memory until save. Later saves never
        replace the snapshot, so 'restore original' is a real guarantee -
        unlike the journal, which only rewinds logged edits."""
        blob, meta = self.snap_paths(path or "")
        if not blob or self.has_origin(path):
            return False
        try:
            if not os.path.isfile(path):
                return False
            os.makedirs(os.path.dirname(blob), exist_ok=True)
            tmp = blob + ".tmp"
            shutil.copy2(path, tmp)
            os.replace(tmp, blob)
            st = os.stat(path)
            with open(meta, "w", encoding="utf-8") as fh:
                json.dump({"path": os.path.normpath(path),
                           "mtime": st.st_mtime, "size": st.st_size}, fh)
        except Exception:  # noqa: BLE001
            return False
        return True

    def origin_bytes(self, path: str):
        """Raw snapshot bytes, or None."""
        blob, _meta = self.snap_paths(path or "")
        try:
            if blob and os.path.isfile(blob):
                with open(blob, "rb") as fh:
                    return fh.read()
        except Exception:  # noqa: BLE001
            pass
        return None

    # -- per-write stash for non-grid files -------------------------------------
    # Grid sessions journal diffs; dedicated writers (swt, balance configs,
    # presets, randomizer modes, preview configs) overwrite whole files, so
    # their undo unit is "one write": the pre-write bytes go to the vault,
    # the journal only references them (DB stays tiny, per the history gate).
    _STASH_TTL = 30 * 24 * 3600  # orphan stash (failed write) older -> pruned

    def stash_file(self, path: str):
        """Copy current disk bytes to the vault under a unique name.
        Returns the stash file name, or None (nothing to stash)."""
        path = os.path.normpath(path or "")
        if not path or not os.path.isfile(path):
            return None
        d = self._snap_dir()
        if not d:
            return None
        try:
            os.makedirs(d, exist_ok=True)
            try:
                now = time.time()
                for fn in os.listdir(d):
                    if not fn.startswith("w_"):
                        continue
                    try:
                        if now - os.path.getmtime(os.path.join(d, fn)) > self._STASH_TTL:
                            os.remove(os.path.join(d, fn))
                    except OSError:  # noqa: BLE001
                        pass
            except OSError:  # noqa: BLE001
                pass
            name = "w_%d_%s.bin" % (int(time.time() * 1000),
                                    "%04x" % random.randrange(65536))
            tmp = os.path.join(d, name + ".tmp")
            shutil.copy2(path, tmp)
            os.replace(tmp, os.path.join(d, name))
        except Exception:  # noqa: BLE001
            return None
        return name

    def stash_bytes(self, name: str):
        """Raw bytes of a stash entry, or None."""
        if not name or os.path.basename(name) != name:
            return None
        d = self._snap_dir()
        try:
            p = os.path.join(d, name) if d else ""
            if p and os.path.isfile(p):
                with open(p, "rb") as fh:
                    return fh.read()
        except Exception:  # noqa: BLE001
            pass
        return None

    def safe_save(self, session, summary: str = "") -> dict:
        """Write the in-memory document to disk (history is stored as diffs,
        so saving no longer copies the whole file into the database).
        An unchanged document is NOT rewritten and gets NO edit mark."""
        try:
            # first overwrite of the session: stash the disk original first
            try:
                if getattr(session, "dirty", False):
                    self.snapshot_origin(getattr(session, "path", ""))
            except Exception:  # noqa: BLE001
                pass
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
