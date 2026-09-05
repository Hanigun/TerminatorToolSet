"""Filesystem helpers: app directories, external assets, project tree walk."""
from __future__ import annotations

import os
import sys

# -- app directories -------------------------------------------------------
# OUTER_DIR = folder holding main.py, templates/, static/, assets/, locales/.
OUTER_DIR = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))))


def pick_app_dir() -> str:
    """Writable folder for config.json + sqlite db."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return OUTER_DIR


# -- external asset resolution ----------------------------------------------
def resolve_external(dirs: "list[str]", *rel: str) -> str:
    """File next to EXE/config wins over _MEIPASS (external assets/locales)."""
    for d in dirs:
        if not d:
            continue
        p = os.path.join(d, *rel)
        try:
            if os.path.isfile(p):
                return p
        except Exception:  # noqa: BLE001
            pass
    return ""


# -- project tree walk -------------------------------------------------------
_TREE_SKIP_DIRS = {".git", "__pycache__", ".codebase-memory", ".codegraph",
                   "node_modules", "$recycle.bin", "system volume information"}


def walk_tree(d: str) -> dict:
    """Recursive os.scandir walk -> compact nested tree
    {"n": name, "d": [subdirs], "f": [filenames]} (dirs first, both sorted)."""
    name = os.path.basename(d.rstrip("\\/")) or d
    dirs, files = [], []
    try:
        with os.scandir(d) as it:
            for e in it:
                try:
                    if e.is_symlink():
                        continue
                    if e.is_dir(follow_symlinks=False):
                        if e.name.lower() in _TREE_SKIP_DIRS:
                            continue
                        dirs.append(walk_tree(e.path))
                    else:
                        files.append(e.name)
                except OSError:
                    continue
    except OSError:
        pass
    dirs.sort(key=lambda x: x["n"].lower())
    files.sort(key=str.lower)
    return {"n": name, "d": dirs, "f": files}
