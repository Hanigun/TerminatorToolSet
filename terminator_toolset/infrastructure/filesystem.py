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

# Древо проекта: 5 уровней папок от выбранного корня — хватает и на
# basis/scripts/species (3), и на DLC-оверлеи dlc/<Имя>/basis/scripts/species
# (5), и на модели basis/models (3) / dlc/<Имя>/basis/models (5),
# и на пехоту basis/animations/new/skin (4).
# Файлы — только открываемые расширения (.model — 3D-превью вкладкой).
# Глубже/шире не лезем: scandir
# по текстурам/аудио распакованной игры и гигантский JSON тормозили открытие
# папки. Правило ADR-001 §14: поддержка нового расширения = добавить его в
# TREE_KEEP_EXTS И в дефолты фильтров фронта (static/js/tree.js
# TREE_FILTER_DEFAULTS).
TREE_MAX_DEPTH = 5
TREE_KEEP_EXTS = ("xml", "swt", "model")


def _tree_keep_file(name: str) -> bool:
    i = name.rfind(".")
    ext = name[i + 1:].lower() if i > 0 else ""
    return ext in TREE_KEEP_EXTS


def walk_tree(d: str, _depth: int = 0) -> "dict | None":
    """Pruned os.scandir walk -> compact nested tree
    {"n": name, "d": [subdirs], "f": [filenames]} (dirs first, both sorted).
    Pruning (perf после выбора папки): подпапки глубже TREE_MAX_DEPTH не
    проходятся вовсе, файлы не из TREE_KEEP_EXTS отбрасываются, пустые узлы
    (без файлов и подпапок) возвращают None и выкидываются родителем."""
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
                        if _depth + 1 > TREE_MAX_DEPTH:
                            continue
                        sub = walk_tree(e.path, _depth + 1)
                        if sub is not None:
                            dirs.append(sub)
                    elif _tree_keep_file(e.name):
                        files.append(e.name)
                except OSError:
                    continue
    except OSError:
        pass
    if not dirs and not files and _depth > 0:
        return None
    dirs.sort(key=lambda x: x["n"].lower())
    files.sort(key=str.lower)
    return {"n": name, "d": dirs, "f": files}
