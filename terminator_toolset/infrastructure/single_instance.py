"""Single-instance guard: named mutex + pending-files mailbox on disk."""
from __future__ import annotations

import json
import os

from .filesystem import pick_app_dir


# -- mailbox directory -------------------------------------------------------
def instance_dir() -> str:
    """Folder holding lock + pending.json (second-launch file mailbox)."""
    base = os.environ.get("LOCALAPPDATA") or pick_app_dir()
    p = os.path.join(base, "TerminatorToolSet", "instance")
    try:
        os.makedirs(p, exist_ok=True)
    except Exception:  # noqa: BLE001
        pass
    return p


# -- mutex -------------------------------------------------------------------
def single_instance_lock():
    """Windows named mutex. True = first instance, False = already running."""
    try:
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.windll.kernel32
        h = k32.CreateMutexW(None, False, "TerminatorToolSet-v091-single-instance")
        if not h:
            return True, None
        already = k32.GetLastError() == 183  # ERROR_ALREADY_EXISTS
        if already:
            k32.CloseHandle(h)
            return False, None
        return True, h
    except Exception:  # noqa: BLE001
        # non-Windows / no ctypes: file-lock fallback
        try:
            import fcntl  # type: ignore
            fp = open(os.path.join(instance_dir(), "lock"), "w")
            try:
                fcntl.flock(fp, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return True, fp
            except OSError:
                return False, None
        except Exception:  # noqa: BLE001
            return True, None


# -- second-launch forwarding -------------------------------------------------
def forward_to_first(args: "list[str]"):
    """Second launch: append file args to the first instance mailbox, exit."""
    try:
        box = os.path.join(instance_dir(), "pending.json")
        files = [a for a in args if a and os.path.exists(a)]
        if files:
            cur = []
            try:
                if os.path.isfile(box):
                    with open(box, "r", encoding="utf-8") as fh:
                        cur = json.load(fh) or []
            except Exception:  # noqa: BLE001
                cur = []
            cur.extend(files)
            with open(box, "w", encoding="utf-8") as fh:
                json.dump(cur[-32:], fh, ensure_ascii=False)
        bring_first_to_front()
    except Exception:  # noqa: BLE001
        pass


def bring_first_to_front():
    """Raise the first instance window (title: Terminator ToolSet)."""
    try:
        import ctypes
        u32 = ctypes.windll.user32
        hwnd = u32.FindWindowW(None, "Terminator ToolSet")
        if hwnd:
            u32.ShowWindow(hwnd, 9)  # SW_RESTORE
            u32.SetForegroundWindow(hwnd)
    except Exception:  # noqa: BLE001
        pass


def take_pending() -> "list[str]":
    """Drain the second-launch mailbox (existing paths only)."""
    box = os.path.join(instance_dir(), "pending.json")
    try:
        if not os.path.isfile(box):
            return []
        with open(box, "r", encoding="utf-8") as fh:
            data = json.load(fh) or []
        try:
            os.remove(box)
        except Exception:  # noqa: BLE001
            pass
        return [str(x) for x in data if isinstance(x, str) and os.path.exists(x)]
    except Exception:  # noqa: BLE001
        return []
