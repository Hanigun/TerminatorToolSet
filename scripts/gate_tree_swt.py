# -*- coding: utf-8 -*-
"""Gate G1: API-дерево должно возвращать файлы .swt из реального мода.

Раньше дефолтные фильтры дерева (exts=["xml"], folders=["scripts"]) прятали
сценарии миссий basis/spawns/*.swt — проверяем, что _walk_tree (общий для
/api/project_tree и /api/game_tree) их отдаёт, и что новые дефолты фронтенда
их пропускают.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROOT_CANDIDATES = [
    r"D:\CloudLayer\Projects\Terminator Project\TERMINATOR_OVERHAUL_MAIN\TERMINATOR_OVERHAUL",
    r"D:\Games\Terminator Project\TERMINATOR_OVERHAUL_MAIN\TERMINATOR_OVERHAUL",
]

ROOT = next((c for c in ROOT_CANDIDATES if os.path.isdir(c)), None)
if not ROOT:
    raise SystemExit("FAIL: mod root not found: %r" % ROOT_CANDIDATES)

from app import _walk_tree  # noqa: E402


def count_swt(node):
    n = sum(1 for f in node.get("f", []) if f.lower().endswith(".swt"))
    for d in node.get("d", []):
        n += count_swt(d)
    return n


def has_dir_named(node, name):
    for d in node.get("d", []):
        if d.get("n", "").lower() == name or has_dir_named(d, name):
            return True
    return False


tree = _walk_tree(ROOT)
n_swt = count_swt(tree)
assert n_swt > 0, "FAIL: no .swt files in API tree of %s" % ROOT
assert has_dir_named(tree, "spawns"), "FAIL: spawns folder missing from API tree"

# фильтры фронтенда: дефолт должен пропускать swt и папку spawns
import re  # noqa: E402
js = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "static", "js", "app.js"), encoding="utf-8").read()
m = re.search(r"TREE_FILTER_DEFAULTS = \{([^}]*)\}", js)
assert m, "FAIL: TREE_FILTER_DEFAULTS not found"
body = m.group(1)
assert re.search(r"""\bexts:\s*\[[^\]]*"swt"[^\]]*\]""", body), \
    "FAIL: default ext filter does not include 'swt'"
assert re.search(r"""\bfolders:\s*\[[^\]]*"spawns"[^\]]*\]""", body), \
    "FAIL: default folder filter does not include 'spawns'"

print("TREE SWT OK (%d .swt files in %s)" % (n_swt, ROOT))
