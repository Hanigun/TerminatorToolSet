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

from .spreadsheet_ml import SpreadsheetML, Worksheet, Cell, SpreadsheetError, _SS


class Session:
    """One open file (or one worksheet of it) plus its diff journal."""

    def __init__(self, doc: SpreadsheetML, sheet_index: int = 0):
        self.doc = doc
        self.sheet_index = sheet_index
        self.path = doc.path
        self.dirty = False
        # аварийный recover-режим (файл был битым XML): автосохранение
        # отключено на стороне app.py, запись только явным «Сохранить»
        self.recovered = bool(getattr(doc, "recovered", False))
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
        ncols = len(cols)
        data = []
        for r in ws.rows:
            # один проход на строку (см. Row.values_row): поштучный
            # cell_value пересобирал cells на каждую ячейку из 276
            vals = r.values_row(ncols)
            row = {"values": vals, "key": vals[0] if vals else ""}
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
        cobj = r.cell(col_idx)
        has_data = cobj is not None and cobj.has_data
        old_t = ws.cell_type(cobj)
        # writing the same value (and type) is NOT an edit: no dirty flag,
        # no history record, no autosave
        if old == value and (old_t or None) == (type_token or None):
            return {"ok": True, "changed": False, "old": old, "payload": None}
        if not has_data and value == "" and type_token is None:
            # пустая absent-ячейка уже пуста: создавать <Data> ради пустой
            # строки нельзя (меняло бы структуру без смысла)
            return {"ok": True, "changed": False, "old": old, "payload": None}
        pre_cell = self.doc.cell_raw(self.sheet_index, row_idx, col_idx)
        self.doc.set_cell_value(self.sheet_index, row_idx, col_idx,
                                value, type_token)
        post_cell = self.doc.cell_raw(self.sheet_index, row_idx, col_idx)
        if pre_cell == post_cell:
            # байты не изменились (spine no-op guard): не dirty, не журнал
            return {"ok": True, "changed": False, "old": old, "payload": None}
        self.dirty = True
        return {"ok": True, "old": old,
                "payload": {"r": row_idx, "c": col_idx, "o": old, "ot": old_t,
                            "n": value, "nt": type_token or old_t,
                            "pre": pre_cell, "post": post_cell}}

    def add_row(self, values: Optional[list] = None) -> dict:
        idx = len(self.worksheet.rows)
        self.doc.add_data_row(self.sheet_index, values)
        ws = self.worksheet
        if idx >= len(ws.rows):
            return {"ok": False, "error": "add row failed"}
        row = ws.rows[idx]
        payload = {"r": idx, "ri": ws.row_index_attr(row), "cells": ws.row_payload(row),
                   "row_xml": self.doc.row_raw(self.sheet_index, idx)}
        self.dirty = True
        return {"ok": True, "row": idx, "payload": payload}

    def delete_row(self, row_idx: int) -> dict:
        ws = self.worksheet
        if not (0 <= row_idx < len(ws.rows)):
            return {"ok": False, "error": "row out of range"}
        row = ws.rows[row_idx]
        payload = {"r": row_idx, "ri": ws.row_index_attr(row), "cells": ws.row_payload(row),
                   "row_xml": self.doc.row_raw(self.sheet_index, row_idx)}
        self.doc.delete_row(self.sheet_index, row_idx)
        self.dirty = True
        return {"ok": True, "payload": payload}

    def add_column(self, name: str) -> dict:
        self.doc.add_column(self.sheet_index, name)
        ws = self.worksheet
        col = max(ws.column_count() - 1, 0)
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
                # [значение, тип, стиль, явный ss:Index]: нужно для
                # побайтового отката (undo восстанавливает ячейку как была).
                # Тип — как в row_payload (None, если <Data> нет), а не
                # нормализованный cell_type: иначе пустой <Cell/> при
                # откате превращался бы в <Data ss:Type="String">
                _d = c._data()
                _t = _d.get(_SS + "Type") if _d is not None else None
                cells[i] = [c.value, _t, c.elem.get(_SS + "StyleID"),
                            c.elem.get(_SS + "Index")]
        payload = {"c": col_idx, "name": name, "cells": cells}
        self.doc.delete_column(self.sheet_index, col_idx)
        self.dirty = True
        return {"ok": True, "payload": payload}

    # -- history engine -------------------------------------------------------
    @staticmethod
    def _apply_cell_image(doc, si: int, item: dict, forward: bool):
        """Инверсия одной ячейки (edit): новые журналы несут pre/post —
        сырые байты <Cell> (побайтовый откат: создание убирается, форма
        <Cell/> и комментарии сохраняются); старые — перезапись значения."""
        r, c = int(item["r"]), int(item["c"])
        if "pre" in item or "post" in item:
            raw = item.get("post") if forward else item.get("pre")
            if raw is None:
                doc.remove_cell(si, r, c)
                return {"kind": "cell", "row": r, "col": c, "value": ""}
            doc.swap_cell(si, r, c, raw)
            v = str(item.get("n") if forward else item.get("o"))
            return {"kind": "cell", "row": r, "col": c, "value": v}
        v = str(item["n"] if forward else item["o"])
        t = (item.get("nt") if forward else item.get("ot")) or None
        doc.set_cell_value(si, r, c, v, t)
        return {"kind": "cell", "row": r, "col": c, "value": v}

    @staticmethod
    def _apply_row_image(doc, si: int, item: dict, forward: bool):
        """Инверсия одной строки (row_set): existed — пересборка строки,
        новая строка — удаление при откате / вставка при повторе."""
        r = int(item["r"])
        existed = bool(item.get("existed"))
        cells = [tuple(x) for x in
                 (item.get("cells_n") if forward else item.get("cells_o")) or []]
        ri = item.get("ri_n") if forward else item.get("ri_o")
        if existed:
            doc.delete_row(si, r)
        elif not forward:
            doc.delete_row(si, r)
            return {"kind": "del_row", "row": r}
        doc.insert_row_at(si, r, cells, ri)
        return {"kind": "ins_row", "row": r}

    @staticmethod
    def _apply_col_image(doc, si: int, item: dict, forward: bool):
        """Инверсия одной колонки (col_set): существовавшая — пересборка,
        новая — удаление при откате / вставка при повторе."""
        c = int(item["c"])
        existed = bool(item.get("existed"))
        name = item.get("name_n", "") if forward else item.get("name_o", "")
        cells = {int(k): tuple(v) for k, v in
                 ((item.get("cells_n") if forward else item.get("cells_o")) or {}).items()}
        if existed:
            doc.delete_column(si, c)
        elif not forward:
            doc.delete_column(si, c)
            return {"kind": "del_col", "col": c}
        doc.insert_column_at(si, c, name, cells)
        return {"kind": "ins_col", "col": c}

    def apply_history_op(self, action: str, payload: dict, forward: bool) -> dict:
        """Apply one recorded change in the given direction.

        forward=True re-applies the change (redo), forward=False undoes it.
        Returns a small patch the client can use for a fast in-place update."""
        p = payload or {}
        si = self.sheet_index
        try:
            if action == "edit":
                return self._apply_cell_image(self.doc, si, p, forward)

            if action == "edit_cells":
                # пачка ячеек одной записью (карта Uprising): откат/повтор
                # идёт всей пачкой атомарно
                out = []
                for ce in (p.get("cells") or []):
                    try:
                        r, c = int(ce["r"]), int(ce["c"])
                    except (TypeError, ValueError, KeyError):
                        continue
                    out.append(self._apply_cell_image(self.doc, si, ce, forward))
                return {"kind": "cells", "cells": out}

            if action in ("add_row", "del_row"):
                r = int(p["r"])
                cells = [tuple(x) for x in (p.get("cells") or [])]
                ri = p.get("ri")
                do_insert = (action == "add_row") == forward
                if do_insert:
                    self.doc.insert_row_at(si, r, cells, ri, p.get("row_xml"))
                    return {"kind": "ins_row", "row": r}
                self.doc.delete_row(si, r)
                return {"kind": "del_row", "row": r}

            if action in ("add_col", "del_col"):
                c = int(p["c"])
                name = p.get("name", "")
                cells = {int(k): tuple(v) for k, v in (p.get("cells") or {}).items()}
                do_insert = (action == "add_col") == forward
                if do_insert:
                    self.doc.insert_column_at(si, c, name, cells)
                    return {"kind": "ins_col", "col": c}
                self.doc.delete_column(si, c)
                return {"kind": "del_col", "col": c}

            if action == "row_set":
                return self._apply_row_image(self.doc, si, p, forward)

            if action == "col_set":
                return self._apply_col_image(self.doc, si, p, forward)

            if action == "merge_rows":
                # пакетное слияние (кнопка «Слить всё»): одна запись журнала
                # на всё слияние — один клик undo откатывает его целиком.
                # Откат и повтор идут одним текстовым проходом (unmerge_rows
                # / merge_rows — один refresh): поштучные delete+insert на
                # сотне строк висли на минуты и раздували текст.
                rows = list(p.get("rows") or [])
                cols = list(p.get("cols") or [])
                if forward:
                    for cp in cols:
                        self._apply_col_image(self.doc, si, cp, True)
                    updates = [(int(it["r"]),
                                [tuple(x) for x in (it.get("cells_n") or [])],
                                it.get("ri_n")) for it in rows
                               if it.get("existed")]
                    appends = [([tuple(x) for x in (it.get("cells_n") or [])],
                                it.get("ri_n")) for it in
                               sorted(rows, key=lambda it: int(it["r"]))
                               if not it.get("existed")]
                    if updates or appends:
                        self.doc.merge_rows(si, updates, appends)
                else:
                    if rows:
                        self.doc.unmerge_rows(si, rows)
                    for cp in reversed(cols):
                        self._apply_col_image(self.doc, si, cp, False)
                return {"kind": "merge", "rows": len(rows), "cols": len(cols)}
        except (KeyError, ValueError, TypeError) as e:
            raise SpreadsheetError("bad history payload: %s" % e)
        raise SpreadsheetError("unknown history action %r" % action)

    # -- serialize ----------------------------------------------------------
    def to_string(self) -> str:
        return self.doc.to_string()

    def save(self, path: Optional[str] = None, validate: bool = True) -> dict:
        out = self.doc.to_string()
        if (path is None and out == self._snapshot and not self.recovered):
            # nothing really changed since load (or changes were undone):
            # do not touch the file on disk. Recover-сессии исключение: файл
            # на диске битый, явное «Сохранить» обязано записать восстановленный
            # текст даже без правок.
            self.dirty = False
            return {"ok": True, "path": self.doc.path, "written": False}
        self.doc.save(path, validate=validate)
        self.dirty = False
        self._snapshot = out
        return {"ok": True, "path": path or self.doc.path, "written": True}
