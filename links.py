"""Cross-file links: navigate from a cell to the entity it references.

Some columns in cars.xml/tanks.xml/helicopters.xml/squads.xml reference entities
defined in OTHER files (ammunition sysnames, gun_mounts, modules, crew, joints,
models, etc.). When a cell's value matches a sysname/record that lives in another
project file, we show a navigable link: click -> open that file and scroll to the
matching row.

Match rules are heuristic and cheap (exact string equality against a lookup map
built once per project scan). No regex needed.
"""
from __future__ import annotations

from typing import Optional


def collect_entity_map(files_with_grids: "dict[str, object]") -> "dict[str, dict]":
    """Return { value: {file, sheet_index, row_index} }.

    grid_provider: file_path -> object exposing .grid() (a Session) or .rows
    with .cell_value(). We index row 0 (sysname) plus a few common key columns.
    """
    index: dict[str, dict] = {}
    for file_path, session in files_with_grids.items():
        try:
            grid = session.grid()
        except Exception:
            continue
        rows = grid.get("rows", [])
        for ri, row in enumerate(rows):
            vals = row.get("values", [])
            # key column is first; also index a few others for loose linking
            for col in (0,):
                if col < len(vals) and vals[col]:
                    v = str(vals[col]).strip()
                    if v:
                        index.setdefault(v, {"file": file_path,
                                             "sheet_index": grid.get("sheet_index", 0),
                                             "row_index": ri})
    return index


def collect_entity_from_paths(paths: "list[str]", load_fn, key_cols=(0,)) -> "dict[str, dict]":
    """Build { value: {file, sheet_index, row_index} } by parsing each file path.

    ``load_fn(path)`` must return a minimal grid dict: {"rows":[{"values":[...]}],
    "sheet_index": 0}. Each file is parsed transiently and discarded, keeping the
    index small even when a whole project (~60 species files) is linked.
    """
    index: dict[str, dict] = {}
    for p in paths:
        try:
            grid = load_fn(p)
        except Exception:  # noqa: BLE001
            continue
        rows = grid.get("rows", [])
        sheet_idx = grid.get("sheet_index", 0)
        for ri, row in enumerate(rows):
            vals = row.get("values", [])
            for col in key_cols:
                if col < len(vals) and vals[col]:
                    v = str(vals[col]).strip()
                    if v:
                        index.setdefault(v, {"file": p,
                                             "sheet_index": sheet_idx,
                                             "row_index": ri})
    return index


def link_targets(session, entity_map: dict) -> "list[dict]":
    """For the open session's grid, return which (row,col) cells are links.

    Returns [{row, col, value, target_file, target_row}] where target_file != this file.
    """
    this_path = session.path
    grid = session.grid()
    out = []
    rows = grid.get("rows", [])
    cols = len(grid.get("columns", []))
    for ri, row in enumerate(rows):
        vals = row.get("values", [])
        for ci in range(min(len(vals), cols)):
            v = vals[ci]
            if not v:
                continue
            hit = entity_map.get(str(v).strip())
            if hit and hit["file"] != this_path:
                out.append({
                    "row": ri,
                    "col": ci,
                    "value": v,
                    "target_file": hit["file"],
                    "target_row": hit["row_index"],
                    "target_sheet": hit["sheet_index"],
                })
    return out
