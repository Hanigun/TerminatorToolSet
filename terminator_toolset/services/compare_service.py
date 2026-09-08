"""Compare / merge / transfer between two spreadsheet files + file repair."""
from __future__ import annotations

import os

from ..domain import comparator as comp_mod
from ..domain.spreadsheet_ml import SpreadsheetError


# -- compare ------------------------------------------------------------------
class Compare:
    """Owns the comparator page backend (diff, merge-all, row/column
    transfer, xml listing) and the fix-file repair action.

    store: SessionStore. config: domain Config (auto_save). saves:
    SavePipeline. hist: HistoryLog (undo flags). db: Database (change
    journal). log: api logger.
    """

    def __init__(self, store, config, saves, hist, db, log):
        self._store = store
        self._config = config
        self._saves = saves
        self._hist = hist
        self._db = db
        self._log = log

    # -- repair -----------------------------------------------------------------
    def fix_file(self, path: str) -> dict:
        """Fix ExpandedRow/ColumnCounts + missing Style defs, then save.
        A valid file returns changed=[] and is never rewritten."""
        path = self._store.normal(path or "")
        if not path or not os.path.isfile(path):
            return {"ok": False, "error": "not a file"}
        try:
            s = self._store.get(path)
            changed = s.doc.fix_expanded_counts()
            styles = s.doc.fix_missing_styles()
        except SpreadsheetError as e:
            return {"ok": False, "error": str(e)}
        changed_any = bool(changed or styles)
        saved = False
        err = None
        if changed_any:
            s.dirty = True
            res = self._saves.safe_save(s)
            saved = bool(res.get("saved"))
            err = res.get("error")
            self._log.info("fix_file %s: %s styles=%s (saved=%s)", path,
                           [(c["sheet"], c["attr"], c["old"], c["new"]) for c in changed],
                           styles, saved)
        else:
            self._log.info("fix_file %s: nothing to fix", path)
        return {"ok": not err, "changed": changed, "styles": styles,
                "saved": saved, "error": err}

    # -- key column ---------------------------------------------------------------
    def _key_col(self, worksheet, key_col, default_key) -> int:
        """Resolve the key column (negative = auto by header name)."""
        key_col = int(key_col)
        if key_col < 0:
            names = worksheet.column_names()
            default = default_key or "sysname"
            key_col = names.index(default) if default in names else 0
        return key_col

    @staticmethod
    def _rowvals(worksheet) -> list:
        n = worksheet.column_count()
        out = []
        for r in worksheet.rows:
            vals = [r.cell_value(c) for c in range(n)]
            while vals and vals[-1] == "":
                vals.pop()
            out.append(vals)
        return out

    # -- diff -----------------------------------------------------------------------
    def compare(self, left_path: str, right_path: str,
                key_col=0, default_key: str = "") -> dict:
        left = self._store.get(self._store.normal(left_path or ""))
        right = self._store.get(self._store.normal(right_path or ""))
        key_col = self._key_col(left.worksheet, key_col, default_key)
        try:
            diff = comp_mod.compute_diff_named(left.worksheet, right.worksheet, key_col)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}
        payload = [{"key": dr.key, "status": dr.status,
                    "left_index": dr.left_index, "right_index": dr.right_index,
                    "changes": dr.changes} for dr in diff]
        return {"ok": True, "diff": payload,
                "left": left.path, "right": right.path,
                "left_rows": self._rowvals(left.worksheet),
                "right_rows": self._rowvals(right.worksheet),
                "left_columns": left.worksheet.column_names(),
                "right_columns": right.worksheet.column_names(),
                "key_col": key_col,
                **self._hist.flags(left.path)}

    # -- merge ------------------------------------------------------------------------
    def merge_all(self, left_path: str, right_path: str,
                  key_col=0, default_key: str = "", mode: str = "all") -> dict:
        """Copy new/updated rows from the right (source) file into the left
        (base) file. Right wins on conflicts. Mode follows the compare
        filter: "all" (new + edited), "new" (only missing rows), "edited"
        (only changed rows)."""
        dst = self._store.get(self._store.normal(left_path or ""))
        src = self._store.get(self._store.normal(right_path or ""))
        key_col = self._key_col(dst.worksheet, key_col, default_key)
        dws = dst.worksheet
        sws = src.worksheet
        col_map = comp_mod.full_col_map(sws, dws, key_col)  # dst col -> src col
        src_idx = comp_mod._key_index(sws, key_col)
        dst_keys = {r.cell_value(key_col).strip() for r in dws.rows}
        created = updated = 0
        try:
            # 1) rows missing on the left -> append from the right
            if mode in ("all", "new"):
                for key, sri in src_idx.items():
                    if key in dst_keys:
                        continue
                    dst_row_i, _cr = comp_mod.transfer_row(sws, dws, sri, key_col, col_map)
                    created += 1
                    after = dws.row_payload(dws.rows[dst_row_i])
                    after_ri = dws.row_index_attr(dws.rows[dst_row_i])
                    self._db.log_change(dst.path, "row_set",
                                        {"r": dst_row_i, "existed": False, "ri_o": None,
                                         "cells_o": [], "ri_n": after_ri, "cells_n": after},
                                        "row %s created (merge)" % key)
            # 2) rows present on both -> right wins per mapped column
            if mode in ("all", "edited"):
                for dri, drow in enumerate(dws.rows):
                    key = drow.cell_value(key_col).strip()
                    if not key or key not in src_idx:
                        continue
                    srow = sws.rows[src_idx[key]]
                    before = dws.row_payload(drow)
                    before_ri = dws.row_index_attr(drow)
                    changed = False
                    for dcol, scol in col_map.items():
                        sv = srow.cell_value(scol)
                        if drow.cell_value(dcol) != sv:
                            stype = srow.cells[scol].type if scol < len(srow.cells) else None
                            drow.set_cell_value(dcol, sv, stype)
                            changed = True
                    if changed:
                        updated += 1
                        after = dws.row_payload(drow)
                        after_ri = dws.row_index_attr(drow)
                        self._db.log_change(dst.path, "row_set",
                                            {"r": dri, "existed": True, "ri_o": before_ri,
                                             "cells_o": before, "ri_n": after_ri, "cells_n": after},
                                            "row %s updated (merge)" % key)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}
        # переносы в сравнении не пишут на диск: правки живут в памяти,
        # пользователь сохраняет их сам (кнопка сохранения / Ctrl+S)
        dst.dirty = True
        self._store.dirty.add(dst.path)
        return {"ok": True, "created": created, "updated": updated,
                **self._hist.flags(dst.path)}

    # -- listing ----------------------------------------------------------------------
    @staticmethod
    def list_xml(root: str) -> dict:
        """List .xml files under a folder (compare page path pickers)."""
        if not root or not os.path.isdir(root):
            return {"ok": False, "error": "not a folder"}
        root_abs = os.path.abspath(root)
        base_depth = root_abs.rstrip(os.sep).count(os.sep)
        found: "list[str]" = []
        for dirpath, dirnames, filenames in os.walk(root_abs):
            dirnames[:] = [d for d in dirnames
                           if not d.startswith(".") and d != "__pycache__"]
            if dirpath.count(os.sep) - base_depth > 5:
                dirnames[:] = []
                continue
            for fn in filenames:
                if fn.lower().endswith(".xml"):
                    found.append(os.path.relpath(os.path.join(dirpath, fn), root_abs))
            if len(found) >= 4000:
                break
        found.sort()
        return {"ok": True, "files": found}

    # -- transfer -----------------------------------------------------------------------
    def transfer_row(self, src_path: str, dst_path: str, src_row=0,
                     key_col=0, col_map_data=None) -> dict:
        src = self._store.get(self._store.normal(src_path or ""))
        dst = self._store.get(self._store.normal(dst_path or ""))
        key_col = int(key_col)
        col_map = {int(k): int(v) for k, v in (col_map_data or {}).items()}
        if not col_map:
            col_map = comp_mod.full_col_map(src.worksheet, dst.worksheet, key_col)
        dws = dst.worksheet
        pre_payloads = [dws.row_payload(r) for r in dws.rows]
        pre_ri = [dws.row_index_attr(r) for r in dws.rows]
        dst_row, created = comp_mod.transfer_row(src.worksheet, dst.worksheet,
                                                 int(src_row),
                                                 max(key_col, 0), col_map)
        existed = not created and 0 <= dst_row < len(pre_payloads)
        before = pre_payloads[dst_row] if existed else []
        before_ri = pre_ri[dst_row] if existed else None
        after = dws.row_payload(dws.rows[dst_row])
        after_ri = dws.row_index_attr(dws.rows[dst_row])
        self._db.log_change(dst.path, "row_set",
                            {"r": dst_row, "existed": existed,
                             "ri_o": before_ri, "cells_o": before,
                             "ri_n": after_ri, "cells_n": after},
                            "row %s (r%d)" % ("created" if created else "transferred",
                                              dst_row))
        # перенос строки не пишет на диск — только в память (см. merge_all)
        dst.dirty = True
        self._store.dirty.add(dst.path)
        return {"ok": True, "dst_row": dst_row, "created": created,
                **self._hist.flags(dst.path)}

    def transfer_column(self, src_path: str, dst_path: str,
                        src_col=-1, dst_col=-1, key_col=0) -> dict:
        src = self._store.get(self._store.normal(src_path or ""))
        dst = self._store.get(self._store.normal(dst_path or ""))
        key_col = int(key_col)
        dws = dst.worksheet
        existed = 0 <= int(dst_col) < dws.column_count()
        if existed:
            col1 = int(dst_col) + 1
            name_o = dws.column_names()[int(dst_col)]
            cells_o = {}
            for i, r in enumerate(dws.rows):
                c = r.cell_by_logical(col1)
                if c is not None:
                    cells_o[i] = [c.value, dws.cell_type(c)]
        else:
            name_o, cells_o = "", {}
        try:
            dst_col = comp_mod.transfer_column(src.worksheet, dst.worksheet,
                                               int(src_col), int(dst_col),
                                               max(key_col, 0))
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}
        col1 = dst_col + 1
        name_n = dws.column_names()[dst_col]
        cells_n = {}
        for i, r in enumerate(dws.rows):
            c = r.cell_by_logical(col1)
            if c is not None:
                cells_n[i] = [c.value, dws.cell_type(c)]
        self._db.log_change(dst.path, "col_set",
                            {"c": dst_col, "existed": existed,
                             "name_o": name_o, "cells_o": cells_o,
                             "name_n": name_n, "cells_n": cells_n},
                            "column transferred (c%d)" % dst_col)
        # перенос колонки не пишет на диск — только в память (см. merge_all)
        dst.dirty = True
        self._store.dirty.add(dst.path)
        return {"ok": True, "dst_col": dst_col, **self._hist.flags(dst.path)}
