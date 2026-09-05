"""Byte-precise spine patcher for Excel-2003 XML (SpreadsheetML).

A small, single-pass scanner that finds the exact character offsets of the
elements we must edit (Worksheet / Table / Row / Cell / Data) inside the
ORIGINAL file text, together with their logical (ss:Index-aware) positions.
All edits are expressed as sub-string splices on a working copy of that text,
so every byte NOT targeted by an edit stays byte-identical on save.

This module is deliberately independent of lxml: it only manipulates text, so
the untouched structure (namespace declarations, attribute line-wrapping,
whitespace, comments, CDATA, processing instructions) is never re-serialized.
"""

from __future__ import annotations

import re

SS = "urn:schemas-microsoft-com:office:spreadsheet"

# Число без ведущих нулей ("0", "-12", "12.5" - да; "007", "1,5", "1e5" - нет).
# Ведущие нули оставляем строкой, чтобы значение ячейки не изменилось.
_NUMBER_RE = re.compile(r"^-?(0|[1-9]\d*)(\.\d+)?$")

# tags whose start-tag attributes we need to look at
_ATTR_TAGS = {"Worksheet", "Table", "Row", "Cell", "Data"}
_STRUCT = {"Workbook", "Worksheet", "Table", "Row", "Cell", "Data"}


def _skip_subtree(text: str, lt: int) -> int:
    """Return index just after the close of the (irrelevant) element at lt."""
    n = len(text)
    oend, sc = _scan_tag(text, lt)
    if sc:
        return oend
    depth = 1
    i = oend
    while i < n:
        lt2 = text.find("<", i)
        if lt2 == -1:
            return n
        c0 = text[lt2 + 1] if lt2 + 1 < n else ""
        if c0 == "!" or c0 == "?":
            if text.startswith("<!--", lt2):
                e = text.find("-->", lt2 + 4)
                i = (e + 3) if e != -1 else n
            elif text.startswith("<![CDATA[", lt2):
                e = text.find("]]>", lt2 + 9)
                i = (e + 3) if e != -1 else n
            elif text.startswith("<?", lt2):
                e = text.find("?>", lt2 + 2)
                i = (e + 2) if e != -1 else n
            else:
                e = text.find(">", lt2)
                i = (e + 1) if e != -1 else n
            continue
        if c0 == "/":
            ge = text.find(">", lt2)
            depth -= 1
            if depth <= 0:
                return ge + 1
            i = ge + 1
            continue
        oend, sc = _scan_tag(text, lt2)
        if not sc:
            depth += 1
        i = oend
    return n


class SpineError(Exception):
    pass


def _local(name: str) -> str:
    """Strip prefix + any whitespace from a (qualified) tag name."""
    base = name.split(None, 1)[0] if name else ""
    return base.rsplit(":", 1)[-1] if ":" in base else base


class C:
    __slots__ = ("local", "start", "open_end", "close_start", "end",
                 "self_close", "index", "data", "children", "attrs", "parent")

    def __init__(self, local, start, open_end, close_start, end, self_close):
        self.local = local
        self.start = start
        self.open_end = open_end
        self.close_start = close_start
        self.end = end
        self.self_close = self_close
        self.index = None
        self.data = None
        self.children = []
        self.attrs = None
        self.parent = None


def _scan_tag(text: str, i: int):
    """From index of '<', return (open_end, self_close)."""
    n = len(text)
    q = None
    j = i + 1
    while j < n:
        c = text[j]
        if q:
            if c == q:
                q = None
        elif c in "\"'":
            q = c
        elif c == ">":
            return j + 1, (text[j - 1] == "/")
        j += 1
    return n, False


def _parse_attrs(raw: str) -> dict:
    a = {}
    i = 0
    n = len(raw)
    while i < n:
        while i < n and raw[i].isspace():
            i += 1
        if i >= n or raw[i] == "/":
            break
        s = i
        while i < n and not raw[i].isspace() and raw[i] != "=":
            i += 1
        k = raw[s:i]
        while i < n and raw[i].isspace():
            i += 1
        if i < n and raw[i] == "=":
            i += 1
            while i < n and raw[i].isspace():
                i += 1
            v = ""
            if i < n and raw[i] in "\"'":
                q = raw[i]
                i += 1
                vs = i
                while i < n and raw[i] != q:
                    i += 1
                v = raw[vs:i]
                i += 1
            a[k] = v
    return a


def _split_name(raw: str):
    """Split '<name attrs>' content -> (name, attrs_raw). Robust to newlines."""
    n = len(raw)
    i = 0
    while i < n and raw[i].isspace():
        i += 1
    s = i
    while i < n and not raw[i].isspace() and raw[i] != "/" and raw[i] != ">":
        i += 1
    return raw[s:i], raw[i:]


def _node_from_start_tag(text: str, lt: int):
    """Return (local, self_close, open_end, attrs) for a start tag at lt."""
    oend, sc = _scan_tag(text, lt)
    raw = text[lt + 1:oend - 1]
    if raw.endswith("/"):
        raw = raw[:-1]
    name, rest = _split_name(raw)
    local = _local(name)
    attrs = None
    if local == "Cell":
        idx = _attr_get(rest, "ss:Index")
        sty = _attr_get(rest, "ss:StyleID")
        if idx is not None or sty is not None:
            attrs = {}
            if idx is not None:
                attrs["ss:Index"] = idx
            if sty is not None:
                attrs["ss:StyleID"] = sty
    elif local == "Row":
        idx = _attr_get(rest, "ss:Index")
        if idx is not None:
            attrs = {"ss:Index": idx}
    elif local == "Data":
        tt = _attr_get(rest, "ss:Type")
        if tt is not None:
            attrs = {"ss:Type": tt}
    elif local == "Worksheet":
        nm = _attr_get(rest, "ss:Name")
        if nm is not None:
            attrs = {"ss:Name": nm}
    elif local == "Table":
        ec = _attr_get(rest, "ss:ExpandedColumnCount")
        er = _attr_get(rest, "ss:ExpandedRowCount")
        if ec is not None or er is not None:
            attrs = {}
            if ec is not None:
                attrs["ss:ExpandedColumnCount"] = ec
            if er is not None:
                attrs["ss:ExpandedRowCount"] = er
    return local, sc, oend, attrs


def _tokenize(text: str) -> C:
    """Build a lightweight element tree with exact char spans."""
    n = len(text)
    root = C(None, 0, 0, n, n, False)
    stack = [root]
    i = 0
    while i < n:
        lt = text.find("<", i)
        if lt == -1:
            break
        c0 = text[lt + 1] if lt + 1 < n else ""
        if c0 == "!":
            if text.startswith("<!--", lt):
                e = text.find("-->", lt + 4)
                i = (e + 3) if e != -1 else n
                continue
            if text.startswith("<![CDATA[", lt):
                e = text.find("]]>", lt + 9)
                i = (e + 3) if e != -1 else n
                continue
            if text.startswith("<!DOCTYPE", lt, lt + 9):
                depth = 0
                q = None
                j = lt + 9
                while j < n:
                    cc = text[j]
                    if q:
                        if cc == q:
                            q = None
                    elif cc in "\"'":
                        q = cc
                    elif cc == "[":
                        depth += 1
                    elif cc == "]":
                        depth -= 1
                    elif cc == ">" and depth <= 0:
                        i = j + 1
                        break
                    j += 1
                else:
                    i = n
                continue
            e = text.find(">", lt)
            i = (e + 1) if e != -1 else n
            continue
        if c0 == "?":
            e = text.find("?>", lt + 2)
            i = (e + 2) if e != -1 else n
            continue
        if c0 == "/":
            ge = text.find(">", lt)
            nm = text[lt + 2:ge].strip()
            local = _local(nm)
            if stack[-1].local == local:
                stack[-1].close_start = lt
                stack[-1].end = ge + 1
                stack.pop()
            i = ge + 1
            continue
        local, sc, oend, attrs = _node_from_start_tag(text, lt)
        if local not in _STRUCT and not sc:
            i = _skip_subtree(text, lt)
            continue
        node = C(local, lt, oend, oend, oend, sc)
        node.attrs = attrs
        stack[-1].children.append(node)
        node.parent = stack[-1]
        if sc:
            node.close_start = oend
            node.end = oend
        else:
            stack.append(node)
        i = oend
    return root


def _iter_local(node: C, local: str):
    for ch in node.children:
        if ch.local == local:
            yield ch
        yield from _iter_local(ch, local)


def _to_sheets(root: C, text: str) -> "list[dict]":
    sheets = []
    for child in _iter_local(root, "Worksheet"):
        ws = {
            "name": (child.attrs or {}).get("ss:Name", ""),
            "ws_start": child.start, "ws_end": child.end,
            "table": None, "header": None, "rows": [],
        }
        for t in child.children:
            if t.local != "Table":
                continue
            ws["table"] = t
            break
        tbl = ws["table"]
        if tbl is None:
            continue
        ws["table_start"] = tbl.start
        ws["table_end"] = tbl.end
        ws["expanded_col"] = (tbl.attrs or {}).get("ss:ExpandedColumnCount", "0")
        ws["expanded_row"] = (tbl.attrs or {}).get("ss:ExpandedRowCount", "0")
        for r in tbl.children:
            if r.local != "Row":
                continue
            rec = _row_rec(r, text)
            if ws["header"] is None:
                ws["header"] = rec
            else:
                ws["rows"].append(rec)
        sheets.append(ws)
    return sheets


def _row_rec(row: C, text: str) -> dict:
    r = {
        "start": row.start, "end": row.end, "open_end": row.open_end,
        "close_start": row.close_start, "self_close": row.self_close,
        "index_attr": (row.attrs or {}).get("ss:Index"),
        "cells": [], "_cell": row,
    }
    seq = 1
    for c in row.children:
        if c.local != "Cell":
            continue
        idx = (c.attrs or {}).get("ss:Index")
        if idx is not None:
            seq = int(idx)
        crec = {
            "start": c.start, "end": c.end, "open_end": c.open_end,
            "close_start": c.close_start, "self_close": c.self_close,
            "index_attr": idx, "logical": seq,
            "data": None, "_cell": c,
        }
        for d in c.children:
            if d.local == "Data":
                crec["data"] = {
                    "start": d.start, "open_end": d.open_end,
                    "close_start": d.close_start, "end": d.end,
                    "self_close": d.self_close,
                    "type": (d.attrs or {}).get("ss:Type"),
                    "_elem": d,
                }
                break
        r["cells"].append(crec)
        seq += 1
    return r


def parse(text: str) -> "list[dict]":
    """Scan text -> list of worksheet dicts (see _to_sheets)."""
    root = _tokenize(text)
    return _to_sheets(root, text)


# ===========================================================================
#  Byte-splicing engine ("Spine")  — mutates the working text in place.
# ===========================================================================

def _esc(value: str) -> str:
    return (value.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;"))


def _esc_attr(value: str) -> str:
    """Экранирование значения XML-атрибута: текст + кавычки + пробельные."""
    return (_esc(value)
            .replace('"', "&quot;")
            .replace("'", "&apos;")
            .replace("\t", "&#9;")
            .replace("\n", "&#10;")
            .replace("\r", "&#13;"))


_ALLOWED_TYPES = frozenset(("String", "Number", "DateTime", "Boolean", "Error"))


def _safe_type(tt: "str | None") -> str:
    t = (tt or "String").strip() or "String"
    if t in _ALLOWED_TYPES:
        return t
    return _esc_attr(t)


def _guess_type(value: str) -> str:
    """Number для чисто числовых значений (как делает Excel), иначе String.

    Без этого пустая ячейка / self-closing <Data/> при вводе числа получали
    ss:Type="String" - WPS помечал такие файлы как "числа отформатированные
    как текст"."""
    return "Number" if _NUMBER_RE.match(value or "") else "String"


def _attr_get(seg: str, name: str) -> "str | None":
    """Read attribute `name` from a start-tag string (e.g. ' ss:Index="3"')."""
    p = seg.find(name + "=")
    if p == -1:
        return None
    q = p + len(name) + 1
    while q < len(seg) and seg[q].isspace():
        q += 1
    if q < len(seg) and seg[q] in "\"'":
        quote = seg[q]
        q += 1
        s = q
        while q < len(seg) and seg[q] != quote:
            q += 1
        return seg[s:q]
    return None


def _open_tag_end(seg: str) -> int:
    """Index just after the closing '>' of the leading start tag in `seg`."""
    q = None
    j = 0
    while j < len(seg):
        c = seg[j]
        if q:
            if c == q:
                q = None
        elif c in "\"'":
            q = c
        elif c == ">":
            return j + 1
        j += 1
    return len(seg)


def _with_type(seg: str, type_token: "str | None") -> str:
    """Return `seg` (a <Data ...> start tag, ends with '>' or '/>') with ss:Type set."""
    tt = _safe_type(type_token)
    if _attr_get(seg, "ss:Type") is not None:
        p = seg.find("ss:Type")
        q = p + len("ss:Type")
        while q < len(seg) and seg[q].isspace():
            q += 1
        if q < len(seg) and seg[q] == "=":
            q += 1
            while q < len(seg) and seg[q].isspace():
                q += 1
            if q < len(seg) and seg[q] in "\"'":
                quote = seg[q]
                q += 1
                s = q
                while q < len(seg) and seg[q] != quote:
                    q += 1
                return seg[:s] + tt + seg[q:]
        return seg
    body = seg.rstrip()
    if body.endswith("/>"):
        body = body[:-2] + ' ss:Type="%s"/>' % tt
    elif body.endswith(">"):
        body = body[:-1] + ' ss:Type="%s">' % tt
    return body


class Spine:
    """Owns the working text and its (recomputed) span index."""

    def __init__(self, text: str):
        self.text = text
        self.sheets = parse(text)

    def refresh(self):
        self.sheets = parse(self.text)

    def _apply(self, repls) -> None:
        if not repls:
            return
        for s, e, new in sorted((r for r in repls if r is not None),
                                key=lambda r: r[0], reverse=True):
            self.text = self.text[:s] + new + self.text[e:]
        self.refresh()

    def _ws(self, s: int) -> dict:
        return self.sheets[s]

    # -- value edit --------------------------------------------------------
    def set_cell(self, s: int, row: int, col0: int, value: str,
                 type_token: "str | None" = None):
        ws = self._ws(s)
        if not (0 <= row < len(ws["rows"])):
            raise SpineError("row out of range")
        rowrec = ws["rows"][row]
        repls = []
        cell = None
        for c in rowrec["cells"]:
            if c["logical"] == col0 + 1:
                cell = c
                break
        if cell is None:
            self._insert_cell(ws, rowrec, col0 + 1, value, type_token)
            return
        d = cell["data"]
        existing = d.get("type") if d else None
        if type_token:
            tt = _safe_type(type_token)
        elif existing:
            tt = _safe_type(existing)
        else:
            tt = _guess_type(value)
        if d is None:
            ins = '<Data ss:Type="%s">%s</Data>' % (tt, _esc(value))
            if cell["self_close"]:
                # <Cell .../> не может содержать детей: разворачиваем весь
                # тег в пару <Cell ...><Data>...</Data></Cell> (иначе <Data>
                # оказывается sibling'ом Cell внутри Row - значение теряется)
                seg = self.text[cell["start"]:cell["end"]]
                head = seg.rstrip()[:-2] + ">"   # <Cell .../> -> <Cell ...>
                repls.append((cell["start"], cell["end"],
                              head + ins + "</Cell>"))
            else:
                repls.append((cell["close_start"], cell["close_start"], ins))
        elif d["self_close"]:
            repls.append((d["start"], d["end"],
                          '<Data ss:Type="%s">%s</Data>' % (tt, _esc(value))))
        else:
            repls.append((d["open_end"], d["close_start"], _esc(value)))
            # тип меняем только осмысленно: явный запрос ИЛИ у ячейки не было
            # типа, а значение - число (лечит "числа как текст" в WPS)
            if tt != existing and (existing is not None or tt == "Number"):
                seg = self.text[d["start"]:d["open_end"]]
                repls.append((d["start"], d["open_end"], _with_type(seg, tt)))
        self._apply(repls)

    def _insert_cell(self, ws: dict, rowrec: dict, col1: int,
                     value: str, type_token: "str | None"):
        """Insert a new <Cell ss:Index=col1> keeping ss:Index ascending."""
        tt = _safe_type(type_token) if type_token else _guess_type(value)
        # styles: copy the style of the cell before us if any (keep geometry sane)
        style = ""
        for c in rowrec["cells"]:
            if c["logical"] == col1 - 1:
                st = c.get("_cell") and (c["_cell"].attrs or {}).get("ss:StyleID")
                if st:
                    style = ' ss:StyleID="%s"' % _esc_attr(st)
                break
        newcell = '<Cell%s ss:Index="%d"><Data ss:Type="%s">%s</Data></Cell>' % (
            style, col1, tt, _esc(value))
        # insert before the first cell whose logical >= col1
        pos = None
        for c in rowrec["cells"]:
            if c["logical"] >= col1:
                pos = c["start"]
                break
        if pos is None:
            pos = rowrec["close_start"]  # before </Row>
        self._apply([(pos, pos, newcell)])

    # -- row edits ---------------------------------------------------------
    def add_row(self, s: int, values: "list | None" = None):
        ws = self._ws(s)
        row = ws["rows"][-1] if ws["rows"] else ws["header"]
        if row is None:
            raise SpineError("No template row")
        repls = []
        prev_end = ws["header"]["end"] if ws["rows"] else row["start"]
        j = row["start"]
        while j > prev_end and self.text[j - 1].isspace():
            j -= 1
        leading = self.text[j:row["start"]]
        seg = self.text[row["start"]:row["end"]]
        newseg = _blank_row(seg)
        newseg = _strip_row_index(newseg)
        if values:
            newseg = _set_row_values(newseg, values)
        repls.append((row["end"], row["end"], leading + newseg))
        fact_after = _table_fact(ws, "ExpandedRowCount") + 1
        repls.append(_bump_table(ws, self.text, "ExpandedRowCount", +1,
                                 set_to=fact_after))
        self._apply(repls)

    def delete_row(self, s: int, row: int):
        ws = self._ws(s)
        if not (0 <= row < len(ws["rows"])):
            raise SpineError("row out of range")
        rec = ws["rows"][row]
        prev_end = ws["header"]["end"] if row == 0 else ws["rows"][row - 1]["end"]
        repls = [(prev_end, rec["end"], "")]
        # точный факт после удаления (а не -1: исходный счётчик мог быть битым)
        fact_after = len(ws["rows"]) - 1 + (1 if ws.get("header") is not None else 0)
        repls.append(_bump_table(ws, self.text, "ExpandedRowCount", -1,
                                 set_to=max(fact_after, 0)))
        self._apply(repls)

    def insert_row(self, s: int, row: int, cells: "list | None" = None,
                   row_index_attr: "str | None" = None,
                   raw_row: "str | None" = None):
        """Re-insert a data row at position `row` (history redo/undo).

        Pass `raw_row` to restore the row byte-for-byte (an undo of a row
        delete); otherwise rebuild cells from the template + `cells` payload."""
        ws = self._ws(s)
        template = (ws["rows"][row] if row < len(ws["rows"]) else
                    (ws["rows"][-1] if ws["rows"] else ws["header"]))
        if template is None:
            raise SpineError("No template row")
        cells = cells or []
        if raw_row is not None:
            newseg = raw_row
        else:
            seg = self.text[template["start"]:template["end"]]
            newseg = _blank_row(seg)
            newseg = _strip_row_index(newseg)
            if row_index_attr:
                newseg = _add_row_index(newseg, row_index_attr)
            newseg = _set_row_values_from_tuples(newseg, cells)
        if row < len(ws["rows"]):
            pos = ws["rows"][row]["start"]
            prev_end = (ws["header"]["end"] if row == 0 else ws["rows"][row - 1]["end"])
            j = ws["rows"][row]["start"]
            while j > prev_end and self.text[j - 1].isspace():
                j -= 1
            leading = self.text[j:ws["rows"][row]["start"]]
            fact_after = _table_fact(ws, "ExpandedRowCount") + 1
            repls = [(pos, pos, leading + newseg),
                     _bump_table(ws, self.text, "ExpandedRowCount", +1,
                                 set_to=fact_after)]
        else:
            last = ws["rows"][-1] if ws["rows"] else ws["header"]
            j = last["start"]
            while j > 0 and self.text[j - 1].isspace():
                j -= 1
            leading = self.text[j:last["start"]]
            fact_after = _table_fact(ws, "ExpandedRowCount") + 1
            repls = [(last["end"], last["end"], leading + newseg),
                     _bump_table(ws, self.text, "ExpandedRowCount", +1,
                                 set_to=fact_after)]
        self._apply(repls)

    # -- column edits ------------------------------------------------------
    def add_column(self, s: int, name: str):
        ws = self._ws(s)
        repls = []
        col1 = _next_logical(ws)
        repls.append(self._line_insert(ws["header"], col1,
                     "<Cell ss:Index=\"%d\"><Data ss:Type=\"String\">%s</Data></Cell>" % (col1, _esc(name))))
        for rowrec in ws["rows"]:
            repls.append(self._line_insert(rowrec, col1,
                         "<Cell ss:Index=\"%d\"/>" % col1))
        # факт после вставки: max(старый max, col1)
        fact_after = max(_next_logical(ws) - 1, col1, 1)
        repls.append(_bump_table(ws, self.text, "ExpandedColumnCount",
                                 +1, set_to=fact_after))
        self._apply(repls)

    def delete_column(self, s: int, col0: int):
        ws = self._ws(s)
        col1 = col0 + 1
        repls = []
        repls.append(self._line_delete(ws["header"], col1))
        for rowrec in ws["rows"]:
            repls.append(self._line_delete(rowrec, col1))
        # точный факт после удаления: max логическая колонка без col1
        repls.append(_bump_table(ws, self.text, "ExpandedColumnCount", -1,
                                 set_to=_max_logical_excluding(ws, col1)))
        self._apply(repls)

    def insert_column(self, s: int, col0: int, name: str,
                      cell_values: "dict | None" = None):
        """Re-insert a column at 0-based position col0 (history redo/undo)."""
        ws = self._ws(s)
        cell_values = cell_values or {}
        col1 = col0 + 1
        repls = [self._line_insert(ws["header"], col1,
                 "<Cell ss:Index=\"%d\"><Data ss:Type=\"String\">%s</Data></Cell>" % (col1, _esc(name)))]
        for r_idx, val in sorted(cell_values.items()):
            if 0 <= int(r_idx) < len(ws["rows"]):
                v = str(val[0])
                ttype = _safe_type(val[1] if len(val) > 1 and val[1] else "String")
                style = (val[2] if len(val) > 2 and val[2] else None)
                stxt = '<Data ss:Type="%s">%s</Data>' % (ttype, _esc(v))
                stag = '<Cell%s ss:Index="%d">%s</Cell>' % (
                    (' ss:StyleID="%s"' % _esc_attr(style)) if style else "", col1, stxt)
                repls.append(self._line_insert(ws["rows"][int(r_idx)], col1, stag))
        repls.append(_bump_table(ws, self.text, "ExpandedColumnCount", +1,
                                 set_to=max(_next_logical(ws) - 1, col1, 1)))
        self._apply(repls)

    # -- helpers -----------------------------------------------------------

    def _line_insert(self, rowrec: dict, col1: int, frag: str):
        """Insert `frag` after the cell at logical col1-1 (or at row end)."""
        if not rowrec["cells"]:
            return (rowrec["open_end"], rowrec["open_end"], frag)
        pos = rowrec["open_end"]
        for c in rowrec["cells"]:
            if c["logical"] >= col1:
                pos = c["start"]
                break
        else:
            pos = rowrec["close_start"]
        return (pos, pos, frag)

    def _line_delete(self, rowrec: dict, col1: int):
        for c in rowrec["cells"]:
            if c["logical"] == col1:
                # remove leading whitespace after previous cell to keep tidy
                prev_end = rowrec["open_end"]
                for c2 in rowrec["cells"]:
                    if c2["logical"] < col1:
                        prev_end = c2["end"]
                    else:
                        break
                j = c["start"]
                while j > prev_end and self.text[j - 1].isspace():
                    j -= 1
                return (j, c["end"], "")
        # not present: no-op
        return None


def _logical_row_count(ws: dict) -> int:
    """Номер последней ЛОГИЧЕСКОЙ строки (учёт разреженных ss:Index у <Row>).

    Excel-семантика ss:ExpandedRowCount: это позиция последней строки, а НЕ
    число элементов <Row>. Таблица из 16 <Row> с ss:Index="36" у последней
    требует ExpandedRowCount=36 - иначе Excel отказывается открывать файл
    ("ошибка в Таблица / ExpandedRowCount")."""
    pos = 0
    for rec in (ws["header"], *ws["rows"]):
        if rec is None:
            continue
        idx = rec.get("index_attr")
        try:
            pos = int(idx) if idx is not None else pos + 1
        except (TypeError, ValueError):
            pos += 1
    return pos


def fix_expanded_counts(spine: "Spine") -> "list[dict]":
    """Пересчитать ss:ExpandedRowCount / ss:ExpandedColumnCount по факту.

    Именно расхождение этих счётчиков с реальным числом <Row> (после правок
    вне программы) заставляет Excel отказываться открывать файл (WPS открывает).
    Меняется ТОЛЬКО значение атрибута в <Table ...> - точечная замена, остальной
    байтовый состав файла не трогается. Файлы без атрибутов не трогаются
    (Excel такие считает сам).

    Возвращает список правок: [{"sheet", "attr", "old", "new"}]."""
    repls: "list[tuple]" = []
    changed: "list[dict]" = []
    for ws in spine.sheets:
        start = ws["table_start"]
        oe = _open_tag_end(spine.text[start:])
        head = spine.text[start:start + oe]
        orig = head
        facts = (("ss:ExpandedRowCount", _logical_row_count(ws)),
                 ("ss:ExpandedColumnCount", max(_next_logical(ws) - 1, 0)))
        for attr, fact in facts:
            cur = _attr_get(head, attr)
            if cur is not None and cur.strip().isdigit() and int(cur) == fact:
                continue
            head = _set_attr(head, attr, str(fact))
            changed.append({"sheet": ws.get("name") or "",
                            "attr": attr.rsplit(":", 1)[-1],
                            "old": cur, "new": str(fact)})
        if head != orig:
            repls.append((start, start + oe, head))
    if repls:
        spine._apply(repls)
    return changed


def fix_missing_styles(spine: "Spine") -> "list[str]":
    """Добавить в <Styles> определения стилей, на которые ссылаются ячейки
    (ss:StyleID), но которые не объявлены. Excel такие ссылки считает ошибкой
    ("Атрибут: StyleID, Значение: s127") и отказывается открывать файл.

    Стиль добавляется ПУСТЫМ (<Style ss:ID="x"/>) - минимальная точечная
    правка, данные ячеек не трогаются. Возвращает список добавленных ID."""
    text = spine.text
    defined = set(re.findall(r'<Style\s[^>]*ss:ID="([^"]+)"', text))
    missing = sorted({sid for sid in re.findall(r'ss:StyleID="([^"]+)"', text)
                      if sid not in defined})
    if not missing:
        return []
    added = []
    m = re.search(r'<Styles\b[^>]*>.*?</Styles>', text, re.S)
    if m:
        block = "".join('<Style ss:ID="%s"/>' % _esc_attr(s) for s in missing)
        close = len("</Styles>")
        spine._apply([(m.start(), m.end(),
                       text[m.start():m.end() - close] + block + "</Styles>")])
        added = missing
        return added
    # <Styles> нет вовсе, но ссылки есть: создаём блок перед первым Worksheet
    ws_m = re.search(r'<Worksheet\b', text)
    if ws_m:
        block = ("<Styles>"
                 + "".join('<Style ss:ID="%s"/>' % _esc_attr(s) for s in missing)
                 + "</Styles>")
        spine._apply([(ws_m.start(), ws_m.start(), block)])
        added = missing
    return added


def _next_logical(ws: dict) -> int:
    n = 0
    for rec in (ws["header"], *ws["rows"]):
        if rec is None:
            continue
        for c in rec["cells"]:
            n = max(n, c["logical"])
    return n + 1


def _blank_row(seg: str) -> str:
    """Empty every <Data>...</Data> value inside a <Row> fragment."""
    spans = _row_data_spans(seg)
    out = []
    i = 0
    for (dst, doe, dcs, dend, logical) in spans:
        out.append(seg[i:dst])     # everything up to '<Data'
        head = seg[dst:doe]        # the start tag ('<'..'>' or '/>')
        out.append(head)
        if not head.rstrip().endswith("/>"):
            out.append(seg[dcs:dend])  # paired close tag ('</Data>')
        i = dend
    out.append(seg[i:])
    return "".join(out)


def _strip_row_index(seg: str) -> str:
    """Remove a row-level ss:Index attribute from the leading <Row ...> tag."""
    oe = _open_tag_end(seg)
    head = seg[:oe]
    if "ss:Index" in head:
        head = _remove_attr(head, "ss:Index")
        return head + seg[oe:]
    return seg


def _remove_attr(seg: str, name: str) -> str:
    p = seg.find(name + "=")
    if p == -1:
        return seg
    # remove preceding space and the value up to next space/'>'
    start = p
    while start > 0 and seg[start - 1].isspace():
        start -= 1
    q = p + len(name) + 1
    while q < len(seg) and seg[q].isspace():
        q += 1
    if q < len(seg) and seg[q] in "\"'":
        quote = seg[q]
        q += 1
        while q < len(seg) and seg[q] != quote:
            q += 1
        q += 1
    return seg[:start] + seg[q:]


def _add_row_index(seg: str, ri: str) -> str:
    oe = _open_tag_end(seg)
    head = seg[:oe]
    head = head.rstrip()
    if head.endswith(">"):
        head = head[:-1]
    return head + ' ss:Index="%s">' % _esc_attr(str(ri)) + seg[oe:]


def _set_row_values(seg: str, values: "list[str]") -> str:
    """Overwrite the Data values of cells at logical positions 1..len(values)."""
    cellspans = _row_data_spans(seg)
    out = []
    i = 0
    for (dst, doe, dcs, dend, logical) in cellspans:
        out.append(seg[i:dst])
        v = values[logical - 1] if 0 <= logical - 1 < len(values) else ""
        head = seg[dst:doe]
        if head.rstrip().endswith("/>"):   # self-closing <Data .../>
            out.append(head.rstrip()[:-2] + ">" + _esc(v) + "</Data>")
            i = dend
        else:
            out.append(head + _esc(v))
            i = dcs
    out.append(seg[i:])
    return "".join(out)


def _set_row_values_from_tuples(seg: str, cells: "list") -> str:
    """Rebuild Data values+types from [(logical, value, type), ...] on a row fragment."""
    maps = {}
    for c in cells:
        logical = int(c[0])
        value = str(c[1])
        ttype = (c[2] if len(c) > 2 and c[2] else None) or "String"
        maps[logical] = (value, ttype)
    spans = _row_data_spans(seg)
    out = []
    i = 0
    for (dst, doe, dcs, dend, logical) in spans:
        out.append(seg[i:dst])
        if logical in maps:
            value, ttype = maps[logical]
            head = _with_type(seg[dst:doe], ttype)
            if head.rstrip().endswith("/>"):
                out.append(head.rstrip()[:-2] + ">" + _esc(value) + "</Data>")
            else:
                out.append(head + _esc(value) + "</Data>")
        i = dend
    out.append(seg[i:])
    return "".join(out)


def _row_data_spans(seg: str):
    """[(data_start, data_open_end, data_close_start, data_end, logical_col), ...]."""
    spans = []
    root = _tokenize(seg)
    seq = 1
    for cellnode in _iter_local(root, "Cell"):
        idx = (cellnode.attrs or {}).get("ss:Index")
        if idx is not None:
            seq = int(idx)
        for d in cellnode.children:
            if d.local == "Data":
                spans.append((d.start, d.open_end, d.close_start, d.end, seq))
                break
        seq += 1
    return spans


def _table_fact(ws: dict, attr: str) -> int:
    """Фактическое число строк/колонок таблицы (последняя логическая строка с
    учётом разреженных ss:Index / максимальная логическая колонка)."""
    if attr == "ExpandedRowCount":
        return _logical_row_count(ws)
    return max(_next_logical(ws) - 1, 0)


def _bump_table(ws: dict, text: str, attr: str, delta: int,
                set_to: "int | None" = None) -> "tuple | None":
    """Return a replacement for the Table start tag updating an expanded count.

    Атрибут не задаётся, если его в теге не было (Excel/движок считают сами);
    нечисловое значение заменяется фактическим. None = правка не нужна."""
    start = ws["table_start"]
    oe = _open_tag_end(text[start:])
    head = text[start:start + oe]
    cur = _attr_get(head, "ss:" + attr)
    if cur is None:
        # атрибута не было: не добавляем свой, файл остаётся валидным как есть
        return None
    if set_to is not None:
        newval = set_to
    elif cur.strip().isdigit():
        newval = max(int(cur) + delta, 0)
    else:
        newval = max(_table_fact(ws, attr) + delta, 0)
    if newval < 0:
        newval = 0
    new_head = _set_attr(head, "ss:" + attr, str(newval))
    return (start, start + oe, new_head)


def _max_logical_excluding(ws: dict, col1: int) -> int:
    """Максимальная логическая колонка БЕЗ удаляемой col1 (ss:Index остальных
    ячеек при удалении колонки не сдвигаются - это и есть факт после правки)."""
    n = 0
    for rec in (ws.get("header"), *ws["rows"]):
        if rec is None:
            continue
        for c in rec["cells"]:
            if c["logical"] == col1:
                continue
            n = max(n, c["logical"])
    return n


def _set_attr(seg: str, name: str, value: str) -> str:
    value = _esc_attr(str(value))
    if _attr_get(seg, name) is None:
        seg = seg.rstrip()
        if seg.endswith(">"):
            seg = seg[:-1]
        return seg + ' %s="%s">' % (name, value)
    p = seg.find(name + "=")
    q = p + len(name) + 1
    while q < len(seg) and seg[q].isspace():
        q += 1
    if q < len(seg) and seg[q] in "\"'":
        quote = seg[q]
        q += 1
        s = q
        while q < len(seg) and seg[q] != quote:
            q += 1
        return seg[:s] + value + seg[q:]
    return seg
