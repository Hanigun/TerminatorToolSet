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

import os


def _norm(path: str) -> str:
    """Канонический путь: разделители + регистр (Windows). Пути в проекте и
    в открытых сессиях могут отличаться разделителями ('/' vs '\\'), из-за
    чего один и тот же файл считался 'другим' и появлялись само-ссылки."""
    try:
        return os.path.normcase(os.path.normpath(path))
    except Exception:  # noqa: BLE001
        return path or ""


def collect_entity_map(files_with_grids: "dict[str, object]") -> "dict[str, list]":
    """Return { value: [ {file, sheet_index, row_index}, ... ] }.

    Один sysname может существовать в нескольких файлах (basis + dlc-оверлеи):
    храним ВСЕ вхождения, link_targets выбирает не-своё. grid_provider:
    file_path -> object exposing .grid() (a Session) or .rows with .cell_value().
    We index row 0 (sysname) plus a few common key columns."""
    index: "dict[str, list]" = {}
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
                        index.setdefault(v, []).append(
                            {"file": _norm(file_path),
                             "sheet_index": grid.get("sheet_index", 0),
                             "row_index": ri})
    return index


def collect_entity_from_paths(paths: "list[str]", load_fn,
                              key_cols=(0,)) -> "dict[str, list]":
    """Build { value: [ {file, sheet_index, row_index}, ... ] } by parsing
    each file path.

    ``load_fn(path)`` must return a minimal grid dict: {"rows":[{"values":[...]}],
    "sheet_index": 0}. Each file is parsed transiently and discarded, keeping the
    index small even when a whole project (~60 species files) is linked."""
    index: "dict[str, list]" = {}
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
                        index.setdefault(v, []).append(
                            {"file": _norm(p),
                             "sheet_index": sheet_idx,
                             "row_index": ri})
    return index


def link_targets(session, entity_map: dict) -> "list[dict]":
    """For the open session's grid, return which (row,col) cells are links.

    Returns [{row, col, value, target_file, target_row}]. Ссылка на ЭТОТ ЖЕ
    файл (в т.ч. на оверлей-копию того же sysname в другом файле, когда своё
    определение есть в текущем) не создаётся: если значение определено здесь,
    переходить некуда."""
    this_path = _norm(session.path)
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
            hits = entity_map.get(str(v).strip())
            if not hits:
                continue
            hit = next((h for h in hits if h["file"] == this_path), None)
            if hit is not None:
                continue    # значение определено в этом же файле - не ссылка
            hit = hits[0]
            out.append({
                "row": ri,
                "col": ci,
                "value": v,
                "target_file": hit["file"],
                "target_row": hit["row_index"],
                "target_sheet": hit["sheet_index"],
            })
    return out
