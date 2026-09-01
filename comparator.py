"""Comparator: diff two worksheets by a user-chosen key column, plus transfer.

Because new units/upgrades arrive as rows that should be merged into the main
files, we compare (usually source vs main) by an arbitrary key column (default
"sysname"). Results:
  - only left  -> red (missing on the right / deleted)
  - only right -> green (new on the right)
  - both       -> white/gray, with changed cells highlighted

Transfer operations:
  - copy a row from side A to side B (insert unless key already exists);
  - copy a column value from side A to side B for rows sharing the key;
  - copy a full column (add it to the target if absent).
"""
from __future__ import annotations


class DiffRow:
    __slots__ = ("key", "status", "left_index", "right_index", "changes")

    def __init__(self, key, status, left_index, right_index, changes):
        self.key = key
        self.status = status  # 'both' | 'left_only' | 'right_only'
        self.left_index = left_index
        self.right_index = right_index
        self.changes = changes  # list of (col, left, right) for 'both'


def _key_index(ws, col: int) -> "dict[str, int]":
    idx: dict[str, int] = {}
    for ri, row in enumerate(ws.rows):
        v = row.cell_value(col).strip()
        if v:
            idx.setdefault(v, ri)
    return idx


def compute_diff(left_ws, right_ws, key_col: int, max_cols: int = 800) -> "list[DiffRow]":
    li = _key_index(left_ws, key_col)
    ri = _key_index(right_ws, key_col)
    result: list[DiffRow] = []
    seen_right: set[str] = set()

    for key, lrow in li.items():
        if key in ri:
            seen_right.add(key)
            changes = _diff_row_values(left_ws.rows[lrow], right_ws.rows[ri[key]], max_cols)
            result.append(DiffRow(key, "both", lrow, ri[key], changes))
        else:
            result.append(DiffRow(key, "left_only", lrow, None, []))

    for key, rrow in ri.items():
        if key not in seen_right:
            result.append(DiffRow(key, "right_only", None, rrow, []))

    # stable: keep order by left index then right index
    result.sort(key=lambda d: (d.left_index if d.left_index is not None else 10**9,
                               d.right_index if d.right_index is not None else 10**9))
    return result


def compute_diff_named(left_ws, right_ws, key_col: int, max_cols: int = 800) -> "list[DiffRow]":
    """Like compute_diff, but cell changes are matched by column NAME:
    changes come back as [name, left_value, right_value], so files with
    different column order / extra columns still diff correctly."""
    li = _key_index(left_ws, key_col)
    ri = _key_index(right_ws, key_col)
    lnames = left_ws.column_names()
    r_by_name: dict[str, int] = {}
    for ci, name in enumerate(right_ws.column_names()):
        if name and name not in r_by_name:
            r_by_name[name] = ci
    result: list[DiffRow] = []
    seen_right: set[str] = set()

    for key, lrow in li.items():
        if key in ri:
            seen_right.add(key)
            lr = left_ws.rows[lrow]
            rr = right_ws.rows[ri[key]]
            changes = []
            for lc, name in enumerate(lnames):
                if lc >= max_cols:
                    break
                rc = r_by_name.get(name)
                if rc is None:
                    continue
                lv = lr.cell_value(lc)
                rv = rr.cell_value(rc)
                if lv != rv:
                    changes.append([name, lv, rv])
            result.append(DiffRow(key, "both", lrow, ri[key], changes))
        else:
            result.append(DiffRow(key, "left_only", lrow, None, []))

    for key in ri:
        if key not in seen_right:
            result.append(DiffRow(key, "right_only", None, ri[key], []))

    result.sort(key=lambda d: (d.left_index if d.left_index is not None else 10**9,
                               d.right_index if d.right_index is not None else 10**9))
    return result


def _diff_row_values(left_row, right_row, max_cols) -> list:
    changes = []
    n = min(max(len(left_row.cells), len(right_row.cells)), max_cols)
    for c in range(n):
        lv = left_row.cell_value(c)
        rv = right_row.cell_value(c)
        if lv != rv:
            changes.append([c, lv, rv])
    return changes


# -- transfer ---------------------------------------------------------------

def transfer_row(src_ws, dst_ws, src_row_idx: int, key_col: int,
                 dst_col_map: dict) -> tuple[int, bool]:
    """Copy a source row into dst_ws.

    dst_col_map: dst column index -> src column index (alignment). The source
    key value is written to dst key_col. Returns (dst_row_index, created).
    """
    src_row = src_ws.rows[src_row_idx]
    key = src_row.cell_value(key_col)
    # find existing dst row by key
    existing = None
    for i, r in enumerate(dst_ws.rows):
        if r.cell_value(key_col).strip() == key.strip():
            existing = i
            break
    if existing is not None:
        dst_row_idx = existing
        dst_row = dst_ws.rows[dst_row_idx]
        created = False
    else:
        dst_row_idx = len(dst_ws.rows)
        dst_row = dst_ws.add_data_row()
        created = True

    for dst_col, src_col in dst_col_map.items():
        value = src_row.cell_value(src_col)
        # copy type too when possible
        src_type = src_row.cells[src_col].type if src_col < len(src_row.cells) else None
        dst_row.set_cell_value(dst_col, value, src_type)
    return dst_row_idx, created


def build_col_map(src_ws, dst_ws, key_col: int) -> dict:
    """Map dst column index -> src column index by identical header name."""
    src_names = src_ws.column_names()
    dst_names = dst_ws.column_names()
    # also map by name for all columns
    name_to_src = {name: i for i, name in enumerate(src_names)}
    mapping: dict[int, int] = {}
    for dj, name in enumerate(dst_names):
        if name in name_to_src:
            mapping[dj] = name_to_src[name]
    return mapping


def full_col_map(src_ws, dst_ws, key_col: int) -> dict:
    """dst column -> src column mapping by header name; source columns that
    have no counterpart in dst are ADDED to dst first, so a row copy
    transfers ALL data, not only the shared columns."""
    col_map = build_col_map(src_ws, dst_ws, key_col)
    mapped_src = set(col_map.values())
    dst_names = set(dst_ws.column_names())
    for sci, name in enumerate(src_ws.column_names()):
        if not name or sci in mapped_src or name in dst_names:
            continue
        try:
            new_dst = dst_ws.add_column(name)
        except Exception:  # noqa: BLE001
            continue
        dst_names.add(name)
        col_map[new_dst] = sci
        mapped_src.add(sci)
    return col_map


def transfer_column(src_ws, dst_ws, src_col: int, dst_col: int, key_col: int) -> int:
    """Copy src_col values onto dst_col for every row sharing the key.

    If dst_col is out of range (no such column), add it. Returns dst_col."""
    if dst_col < 0 or dst_col >= dst_ws.column_count():
        # add a column with the source header name
        name = src_ws.column_names()[src_col] if src_ws.column_names() else "new"
        try:
            dst_col = dst_ws.add_column(name)
        except Exception:  # noqa: BLE001
            dst_col = dst_ws.column_count() - 1
    # copy src_col onto dst_col for every dst row whose key has a source row
    for dr, row in enumerate(dst_ws.rows):
        key = row.cell_value(key_col).strip()
        for sr, srow in enumerate(src_ws.rows):
            if srow.cell_value(key_col).strip() == key:
                val = srow.cell_value(src_col)
                row.set_cell_value(dst_col, val)
                break
    return dst_col
