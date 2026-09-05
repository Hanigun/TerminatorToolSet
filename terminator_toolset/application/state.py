"""Shared runtime state: pending-files mailbox (second launch / drag&drop)."""
from __future__ import annotations

# -- pending-files mailbox ------------------------------------------------------
_PENDING_FILES: "list[str]" = []


def set_pending_files(files: "list[str]"):
    """Replace mailbox contents (startup / second-launch forward).

    Mutates in place: readers hold a reference to this list object, so it
    must never be rebound (imported names would keep the stale list)."""
    _PENDING_FILES[:] = [str(f) for f in (files or []) if f]


def add_pending_files(files: "list[str]"):
    """Append paths without wiping queued ones (native drop during a second-
    launch forward must not lose files). Capped with dedup."""
    global _PENDING_FILES
    for f in (files or []):
        sf = str(f)
        if sf and sf not in _PENDING_FILES:
            _PENDING_FILES.append(sf)
    del _PENDING_FILES[:-64]
