# -*- coding: utf-8 -*-
"""Gate G1: древо проекта обрезано бэкендом (5 уровней — хватает на DLC,
только xml/swt), дефолты фильтров фронта совпадают с бэкендом
(правило ADR-001 §14: новое расширение = TREE_KEEP_EXTS +
TREE_FILTER_DEFAULTS.exts).
"""
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TS = os.path.dirname(HERE)
sys.path.insert(0, TS)

from terminator_toolset.infrastructure.filesystem import (  # noqa: E402
    TREE_KEEP_EXTS, TREE_MAX_DEPTH, walk_tree,
)

assert TREE_MAX_DEPTH == 5, "FAIL: TREE_MAX_DEPTH=%r, want 5" % (TREE_MAX_DEPTH,)
assert set(TREE_KEEP_EXTS) == {"xml", "swt"}, \
    "FAIL: TREE_KEEP_EXTS=%r, want {xml, swt}" % (TREE_KEEP_EXTS,)


def touch(p):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write("x")


def flat_names(node, depth=0, out=None):
    out = out if out is not None else {"dirs": [], "files": []}
    out["dirs"].append((node.get("n", ""), depth))
    out["files"].extend(node.get("f", []))
    for d in node.get("d", []):
        flat_names(d, depth + 1, out)
    return out


with tempfile.TemporaryDirectory() as root:
    # 1 basis > 2 scripts > 3 species > 4 deep (входит) > 5 deeper (входит) >
    # 6 gone (отрезается); + DLC-ветка 1 dlc > 2 Legion > 3 basis > 4 scripts
    # > 5 species (входит)
    touch(os.path.join(root, "basis", "scripts", "species", "units.xml"))
    touch(os.path.join(root, "basis", "scripts", "species", "old.set"))
    touch(os.path.join(root, "basis", "scripts", "species", "readme.txt"))
    touch(os.path.join(root, "basis", "scripts", "species", "deep", "deeper",
                       "gone", "hidden.xml"))
    touch(os.path.join(root, "basis", "spawns", "mission.swt"))
    touch(os.path.join(root, "basis", "spawns", "shot.png"))
    touch(os.path.join(root, "dlc", "Legion", "basis", "scripts", "species",
                       "legion.xml"))
    touch(os.path.join(root, "dlc", "Legion", "basis", "spawns", "legion.swt"))
    touch(os.path.join(root, "basis", "notes.txt"))  # только мусор -> папки нет
    os.makedirs(os.path.join(root, "empty"), exist_ok=True)
    tree = walk_tree(root)
    got = flat_names(tree)
    dirnames = [n for n, _ in got["dirs"]]
    assert "gone" not in dirnames, "FAIL: level-6 dir leaked: %r" % (dirnames,)
    assert max(d for _, d in got["dirs"]) <= 5, "FAIL: depth>5: %r" % (got["dirs"],)
    assert "hidden.xml" not in got["files"], "FAIL: deep file leaked"
    for good in ("units.xml", "mission.swt", "legion.xml", "legion.swt"):
        assert good in got["files"], "FAIL: %s lost: %r" % (good, got["files"],)
    for bad in ("old.set", "readme.txt", "shot.png", "notes.txt"):
        assert bad not in got["files"], "FAIL: non-keep file leaked: %s" % bad
    assert "empty" not in dirnames, "FAIL: empty dir leaked: %r" % (dirnames,)

# фронт: дефолты фильтров = набор бэкенда (иначе файлы есть, но скрыты)
js = open(os.path.join(TS, "static", "js", "tree.js"), encoding="utf-8").read()
m = re.search(r"TREE_FILTER_DEFAULTS\s*=\s*\{([^}]*)\}", js)
assert m, "FAIL: TREE_FILTER_DEFAULTS not found in tree.js"
body = m.group(1)
exts = set(re.findall(r'"([a-z0-9]+)"', body.split("folders")[0]))
assert exts == set(TREE_KEEP_EXTS), \
    "FAIL: frontend default exts=%r, backend keep=%r" % (exts, set(TREE_KEEP_EXTS))
assert '"scripts"' in body and '"spawns"' in body, \
    "FAIL: default folder filter lost scripts/spawns"

# живой мод (если рядом): swt видны, глубина и расширения в норме
checked = ""
for cand in (r"D:\CloudLayer\Projects\Terminator Project\TERMINATOR_OVERHAUL_MAIN\TERMINATOR_OVERHAUL",
             r"D:\Games\Terminator Project\TERMINATOR_OVERHAUL_MAIN\TERMINATOR_OVERHAUL"):
    if os.path.isdir(cand):
        live = flat_names(walk_tree(cand))
        n_swt = sum(1 for f in live["files"] if f.lower().endswith(".swt"))
        assert n_swt > 0, "FAIL: no .swt in pruned tree of %s" % cand
        assert max((d for _, d in live["dirs"]), default=0) <= 5
        bad = [f for f in live["files"]
               if f.rsplit(".", 1)[-1].lower() not in set(TREE_KEEP_EXTS)]
        assert not bad, "FAIL: non-keep files in live tree: %r" % (bad[:5],)
        checked = " + live %s (%d .swt)" % (cand, n_swt)
        break

print("TREE FILTERS OK (depth<=5, keep=%s%s)" % (sorted(TREE_KEEP_EXTS), checked))
