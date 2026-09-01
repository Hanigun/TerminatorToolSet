"""In-memory editing session over one loaded SpreadsheetML document.

Bridges the low-level lxml tree (spreadsheet_ml) and the web frontend:
  - exposes the workbook as JSON the JS grid renders,
  - applies value/row/column edits through the SpreadsheetML engine,
  - captures a diff payload for every edit (stored by app.py in SQLite),
  - re-applies any recorded change forward or inversely (undo/redo engine).

A "grid" is just a 2D array of strings aligned to ExpandedColumnCount, with the
sysname (row 0 of each data row) available for sticky-column display.
"""
from __future__ import annotations

from typing import Optional

from spreadsheet_ml import SpreadsheetML, Worksheet, Cell, SpreadsheetError, _SS


class Session:
    """One open file (or one worksheet of it) plus its diff journal."""

    def __init__(self, doc: SpreadsheetML, sheet_index: int = 0):
        self.doc = doc
        self.sheet_index = sheet_index
        self.path = doc.path
        self.dirty = False
        # serialization at load time: lets save() detect "nothing really
        # changed" (open -> save) and skip the disk write entirely
        self._snapshot = doc.to_string()

    # -- worksheet ----------------------------------------------------------
    @property
    def worksheet(self) -> Worksheet:
        return self.doc.worksheets[self.sheet_index]

    def worksheet_names(self):
        return [w.name for w in self.doc.worksheets]

    def switch_sheet(self, index: int):
        if 0 <= index < len(self.doc.worksheets):
            self.sheet_index = index

    # -- columns ------------------------------------------------------------
    def columns(self) -> dict:
        ws = self.worksheet
        names = ws.column_names()
        comments = ws.column_comments()
        while len(comments) < len(names):
            comments.append(None)
        return {
            "names": names,
            "comments": comments,
            "count": len(names),
            "expanded": ws.expanded_column_count(),
        }

    # -- grid ---------------------------------------------------------------
    def grid(self) -> dict:
        """Full worksheet grid for the frontend."""
        ws = self.worksheet
        cols = ws.column_names()
        data = []
        for r in ws.rows:
            row = {"values": [], "key": ""}
            for c in range(len(cols)):
                # cell_value addresses the 0-based LOGICAL column (honours ss:Index)
                v = r.cell_value(c)
                row["values"].append(v)
            row["key"] = row["values"][0] if row["values"] else ""
            data.append(row)
        return {
            "sheet_index": self.sheet_index,
            "sheet_name": ws.name,
            "sheets": self.worksheet_names(),
            "columns": cols,
            "comments": ws.column_comments(),
            "rows": data,
            "expanded_cols": ws.expanded_column_count(),
            "path": self.path,
        }

    # -- edits (each returns a diff payload for the history) -----------------
    def edit_cell(self, row_idx: int, col_idx: int, value: str,
                  type_token: Optional[str] = None) -> dict:
        ws = self.worksheet
        if row_idx >= len(ws.rows):
            return {"ok": False, "error": "row out of range"}
        r = ws.rows[row_idx]
        old = r.cell_value(col_idx)   # 0-based LOGICAL column
        old_t = ws.cell_type(r.cell(col_idx))
        # writing the same value (and type) is NOT an edit: no dirty flag,
        # no history record, no autosave
        if old == value and (old_t or None) == (type_token or None):
            return {"ok": True, "changed": False, "old": old, "payload": None}
        r.set_cell_value(col_idx, value, type_token)
        self.dirty = True
        return {"ok": True, "old": old,
                "payload": {"r": row_idx, "c": col_idx, "o": old, "ot": old_t,
                            "n": value, "nt": type_token or old_t}}

    def add_row(self, values: Optional[list] = None) -> dict:
        ws = self.worksheet
        idx = len(ws.rows)
        ws.add_data_row(values)
        row = ws.rows[idx]
        payload = {"r": idx, "ri": ws.row_index_attr(row), "cells": ws.row_payload(row)}
        self.dirty = True
        return {"ok": True, "row": idx, "payload": payload}

    def delete_row(self, row_idx: int) -> dict:
        ws = self.worksheet
        if not (0 <= row_idx < len(ws.rows)):
            return {"ok": False, "error": "row out of range"}
        row = ws.rows[row_idx]
        payload = {"r": row_idx, "ri": ws.row_index_attr(row), "cells": ws.row_payload(row)}
        ws.delete_row(row_idx)
        self.dirty = True
        return {"ok": True, "payload": payload}

    def add_column(self, name: str) -> dict:
        ws = self.worksheet
        col = ws.add_column(name)
        payload = {"c": col, "name": name, "cells": {}}
        self.dirty = True
        return {"ok": True, "col": col, "payload": payload}

    def delete_column(self, col_idx: int) -> dict:
        ws = self.worksheet
        if not (0 <= col_idx < ws.column_count()):
            return {"ok": False, "error": "column out of range"}
        name = ws.column_names()[col_idx] if ws.header else ""
        cells = {}
        col1 = col_idx + 1
        for i, r in enumerate(ws.rows):
            c = r.cell_by_logical(col1)
            if c is not None:
                cells[i] = [c.value, ws.cell_type(c), c.elem.get(_SS + "StyleID")]
        payload = {"c": col_idx, "name": name, "cells": cells}
        ws.delete_column(col_idx)
        self.dirty = True
        return {"ok": True, "payload": payload}

    # -- history engine -------------------------------------------------------
    def apply_history_op(self, action: str, payload: dict, forward: bool) -> dict:
        """Apply one recorded change in the given direction.

        forward=True re-applies the change (redo), forward=False undoes it.
        Returns a small patch the client can use for a fast in-place update."""
        ws = self.worksheet
        p = payload or {}
        try:
            if action == "edit":
                r, c = int(p["r"]), int(p["c"])
                v = str(p["n"] if forward else p["o"])
                t = (p.get("nt") if forward else p.get("ot")) or None
                ws.set_cell_value(r, c, v, t)
                return {"kind": "cell", "row": r, "col": c, "value": v}

            if action in ("add_row", "del_row"):
                r = int(p["r"])
                cells = [tuple(x) for x in (p.get("cells") or [])]
                ri = p.get("ri")
                do_insert = (action == "add_row") == forward
                if do_insert:
                    ws.insert_row_at(r, cells, ri)
                    return {"kind": "ins_row", "row": r}
                ws.delete_row(r)
                return {"kind": "del_row", "row": r}

            if action in ("add_col", "del_col"):
                c = int(p["c"])
                name = p.get("name", "")
                cells = {int(k): tuple(v) for k, v in (p.get("cells") or {}).items()}
                do_insert = (action == "add_col") == forward
                if do_insert:
                    ws.insert_column_at(c, name, cells)
                    return {"kind": "ins_col", "col": c}
                ws.delete_column(c)
                return {"kind": "del_col", "col": c}

            if action == "row_set":
                r = int(p["r"])
                existed = bool(p.get("existed"))
                cells = [tuple(x) for x in (p.get("cells_n") if forward else p.get("cells_o")) or []]
                ri = p.get("ri_n") if forward else p.get("ri_o")
                if existed:
                    ws.delete_row(r)
                elif not forward:
                    ws.delete_row(r)
                    return {"kind": "del_row", "row": r}
                ws.insert_row_at(r, cells, ri)
                return {"kind": "ins_row", "row": r}

            if action == "col_set":
                c = int(p["c"])
                existed = bool(p.get("existed"))
                name = p.get("name_n", "") if forward else p.get("name_o", "")
                cells = {int(k): tuple(v) for k, v in
                         ((p.get("cells_n") if forward else p.get("cells_o")) or {}).items()}
                if existed:
                    ws.delete_column(c)
                elif not forward:
                    ws.delete_column(c)
                    return {"kind": "del_col", "col": c}
                ws.insert_column_at(c, name, cells)
                return {"kind": "ins_col", "col": c}
        except (KeyError, ValueError, TypeError) as e:
            raise SpreadsheetError("bad history payload: %s" % e)
        raise SpreadsheetError("unknown history action %r" % action)

    # -- serialize ----------------------------------------------------------
    def to_string(self) -> str:
        return self.doc.to_string()

    def save(self, path: Optional[str] = None, validate: bool = True) -> dict:
        out = self.doc.to_string()
        if path is None and out == self._snapshot:
            # nothing really changed since load (or changes were undone):
            # do not touch the file on disk
            self.dirty = False
            return {"ok": True, "path": self.doc.path, "written": False}
        self.doc.save(path, validate=validate)
        self.dirty = False
        self._snapshot = out
        return {"ok": True, "path": path or self.doc.path, "written": True}
