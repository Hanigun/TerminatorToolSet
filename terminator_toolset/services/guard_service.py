"""Unpacked-game guard: keep the stock assets read-only."""
from __future__ import annotations

import os

from ..domain.project import Project


# -- guard ------------------------------------------------------------------
class Guard:
    """Protects the unpacked game folder: files under unpacked_path that
    are outside the project and the mod are never written silently."""

    def __init__(self, store, config):
        self._store = store     # SessionStore: normal()
        self._config = config

    # -- roots ----------------------------------------------------------------
    def roots(self) -> dict:
        """Normalized project/mod/unpacked roots (persisted defaults)."""
        proj = ""
        try:
            proj = getattr(Project(), "root", "") or ""
        except Exception:  # noqa: BLE001
            pass
        return {
            "project": self._store.normal(proj or self._config.get("project_path")
                                          or self._config.get("last_project") or ""),
            "mod": self._store.normal(self._config.get("mod_path") or ""),
            "unpacked": self._store.normal(self._config.get("unpacked_path") or ""),
        }

    def guarded(self, path: str) -> bool:
        """True when the path is protected stock content."""
        if not bool(self._config.get("guard_unpacked", True)):
            return False
        p = self._store.normal(path or "")
        if not p:
            return False
        g = self.roots()
        un = g["unpacked"]
        if not un or un == "." or not (p == un or p.startswith(un + os.sep)):
            return False
        for key in ("project", "mod"):
            r = g[key]
            if r and r != "." and (p == r or p.startswith(r + os.sep)):
                return False
        return True
