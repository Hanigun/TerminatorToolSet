"""SpreadsheetML parse/serialize with minimal-invasive rewriting (lxml).

Terminator: Dark Fate - Defiance reads unit XML files (Excel-2003 SpreadsheetML /
SpreadsheetML, urn:schemas-microsoft-com:office:spreadsheet) directly from disk.
The #1 hard requirement: every file we write must remain 100% structurally
compatible with the game engine.

Why lxml, not stdlib ElementTree:
  - These files carry namespace prefixes that the engine depends on: the default
    namespace (unprefixed <Workbook>/<Worksheet>/<Table>/<Cell>/<Data>) plus
    `ss:`, `x:`, `o:`, `html:`. ElementTree re-serializes everything as ns0:/ns1:
    which would break the game's reader. lxml preserves the original prefixes,
    attribute order and (with remove_blank_text=False) whitespace.

Strategy ("minimal-invasive rewrite"):
  - Parse once, keep the live lxml tree.
  - Editing a value replaces ONLY the text of the existing <Data> element (or
    adds/removes <Data> for a <Cell .../>). Nothing else changes.
  - Adding a data row clones an existing <Row> element (styles + types) then
    blanks/overwrites its <Data> text; ss:ExpandedRowCount is updated.
  - Adding a column clones the header cell + inserts matching cells into every
    row and updates ss:ExpandedColumnCount.

All writes flow through SpreadsheetML.save() which validates the produced XML by
re-parsing BEFORE anything touches the target file.
"""

from __future__ import annotations

import io
from typing import Optional

from lxml import etree

SS_NS = "urn:schemas-microsoft-com:office:spreadsheet"
X_NS = "urn:schemas-microsoft-com:office:excel"
O_NS = "urn:schemas-microsoft-com:office:office"
HTML_NS = "http://www.w3.org/TR/REC-html40"

_SS = "{%s}" % SS_NS
_H = "{%s}" % HTML_NS

_HEADER = '<?xml version="1.0"?>\n'
_MSO = '<?mso-application progid="Excel.Sheet"?>\n'


class SpreadsheetError(Exception):
    """Structural/validation problem. The target file is never touched."""


def iter_rows_logical(path: str, skip_header: bool = False):
    """Stream the first worksheet's rows as logical value lists (ss:Index-aware).

    Memory-light (iterparse, elements cleared as we go) - used for the entity
    index and the localization name map where the full lxml tree is not needed.
    """
    header_skipped = not skip_header
    for _event, elem in etree.iterparse(path, events=("end",), tag=_SS + "Row"):
        if not header_skipped:
            header_skipped = True
            elem.clear()
            continue
        vals: "list[str]" = []
        seq = 1
        for ch in elem:
            if ch.tag != _SS + "Cell":
                continue
            idx = ch.get(_SS + "Index")
            if idx:
                try:
                    seq = int(idx)
                except ValueError:
                    pass
            text = ""
            for d in ch:
                if d.tag == _SS + "Data":
                    text = "".join(d.itertext())
                    break
            pos = seq - 1
            if pos < len(vals):
                vals[pos] = text
            else:
                vals.extend([""] * (pos - len(vals)))
                vals.append(text)
            seq += 1
        yield vals
        elem.clear()


class Cell:
    """Convenient read/write view over a single <Cell> element."""

    __slots__ = ("elem",)

    def __init__(self, elem: etree._Element):
        self.elem = elem

    # -- attributes --------------------------------------------------------
    @property
    def index(self) -> Optional[int]:
        v = self.elem.get(_SS + "Index")
        try:
            return int(v) if v else None
        except ValueError:
            return None

    @index.setter
    def index(self, value: Optional[int]):
        if value is None:
            self.elem.attrib.pop(_SS + "Index", None)
        else:
            self.elem.set(_SS + "Index", str(value))

    @property
    def style_id(self) -> Optional[str]:
        return self.elem.get(_SS + "StyleID")

    @property
    def type(self) -> Optional[str]:
        d = self._data()
        return d.get(_SS + "Type") if d is not None else None

    # -- data --------------------------------------------------------------
    def _data(self) -> Optional[etree._Element]:
        for ch in self.elem:
            if ch.tag == _SS + "Data":
                return ch
        return None

    @property
    def has_data(self) -> bool:
        return self._data() is not None

    @property
    def value(self) -> str:
        d = self._data()
        return "".join(d.itertext()) if d is not None else ""

    def set_value(self, value: str, type_token: Optional[str] = None):
        """Set text, replacing the <Data> child (creating it if absent)."""
        d = self._data()
        if d is None:
            d = etree.SubElement(self.elem, _SS + "Data")
        # replace all children with a single text node (preserves nothing but
        # plain cell text; comments live in a sibling <Comment>, not <Data>).
        for ch in list(d):
            d.remove(ch)
        if type_token:
            d.set(_SS + "Type", type_token)
        elif d.get(_SS + "Type") is None:
            d.set(_SS + "Type", "String")
        d.text = value

    def clear(self):
        """Revert to the empty <Cell .../> form (remove <Data> and <Comment>)."""
        for ch in list(self.elem):
            if ch.tag in (_SS + "Data", _SS + "Comment"):
                self.elem.remove(ch)

    def clone_for_row(self) -> "Cell":
        """Deep-clone this cell's <Cell> element (style preserved, data kept)."""
        new = etree.fromstring(etree.tostring(self.elem))
        return Cell(new)


class Row:
    """Read/write view over a <Row> element."""

    __slots__ = ("elem", "is_header")

    def __init__(self, elem: etree._Element, is_header: bool = False):
        self.elem = elem
        self.is_header = is_header

    @property
    def cells(self) -> "list[Cell]":
        out = []
        for ch in self.elem:
            if ch.tag == _SS + "Cell":
                out.append(Cell(ch))
        return out

    def _logical_positions(self) -> "list[int]":
        """1-based LOGICAL column position of each physical cell, honouring
        ss:Index. Data rows are often sparse in their trailing columns, so the
        physical list index can diverge from the logical column the game reads."""
        out = []
        seq = 1
        for c in self.cells:
            i = c.index
            if i is not None:
                seq = i
            out.append(seq)
            seq += 1
        return out

    def cell_by_logical(self, col1: int) -> Optional[Cell]:
        """Return the cell occupying 1-based logical column col1 (None if absent)."""
        target = int(col1)
        seq = 1
        for c in self.cells:
            i = c.index
            if i is not None:
                seq = i
            if seq == target:
                return c
            seq += 1
        return None

    def cell_value(self, col_0based: int) -> str:
        c = self.cell_by_logical(col_0based + 1)
        return c.value if c is not None else ""

    def cell(self, col_0based: int) -> Optional[Cell]:
        return self.cell_by_logical(col_0based + 1)

    def set_cell_value(self, col_0based: int, value: str,
                       type_token: Optional[str] = None):
        col1 = col_0based + 1
        c = self.cell_by_logical(col1)
        if c is None:
            c = self.insert_logical_cell(col1)
        c.set_value(value, type_token)

    def insert_logical_cell(self, col1: int, style_id: Optional[str] = None) -> Cell:
        """Insert an empty <Cell ss:Index=col1> keeping cells in ascending
        logical order (the game depends on ordered ss:Index)."""
        c = etree.Element(_SS + "Cell")
        if style_id:
            c.set(_SS + "StyleID", style_id)
        Cell(c).index = col1
        insert_before: Optional[etree._Element] = None
        seq = 1
        for ch in self.elem:
            if ch.tag != _SS + "Cell":
                continue
            i = ch.get(_SS + "Index")
            if i is not None:
                seq = int(i)
            # insert before the cell currently occupying (or passing) col1 so
            # later cells keep their meaning after the shift
            if seq >= col1:
                insert_before = ch
                break
            seq += 1
        if insert_before is not None:
            insert_before.addprevious(c)
        else:
            self.elem.append(c)
        return Cell(c)

    def append_blank_cell(self, style_id: Optional[str] = None) -> Cell:
        c = etree.SubElement(self.elem, _SS + "Cell")
        if style_id:
            c.set(_SS + "StyleID", style_id)
        return Cell(c)

    def max_logical(self) -> int:
        pos = self._logical_positions()
        return max(pos) if pos else 0


class Worksheet:
    """One <Worksheet ss:Name> with its <Table>."""

    __slots__ = ("name", "sheet_elem", "table", "header", "rows")

    def __init__(self, sheet_elem: etree._Element):
        self.sheet_elem = sheet_elem
        self.name = sheet_elem.get(_SS + "Name", "")
        self.table = None
        self.header: Optional[Row] = None
        self.rows: list[Row] = []
        self._extract()

    def _extract(self):
        for ch in self.sheet_elem:
            if ch.tag == _SS + "Table":
                self.table = ch
                break
        if self.table is None:
            raise SpreadsheetError("Worksheet %r has no <Table>" % self.name)
        for ch in self.table:
            if ch.tag == _SS + "Row":
                if self.header is None:
                    self.header = Row(ch, is_header=True)
                else:
                    self.rows.append(Row(ch))

    # -- geometry ----------------------------------------------------------
    def _table_attr_float(self, local) -> int:
        v = self.table.get(_SS + local)
        try:
            return int(v) if v else 0
        except ValueError:
            return 0

    def expanded_column_count(self) -> int:
        return self._table_attr_float("ExpandedColumnCount")

    def expanded_row_count(self) -> int:
        return self._table_attr_float("ExpandedRowCount")

    def column_count(self) -> int:
        """Number of logical columns, honouring sparse ss:Index cells/rows."""
        n = self.expanded_column_count()
        if self.header is not None:
            n = max(n, self.header.max_logical())
        for r in self.rows:
            n = max(n, r.max_logical())
        return n

    def _col1_items(self, row: Row) -> "list[tuple[int, Cell]]":
        return [(pos, c) for pos, c in zip(row._logical_positions(), row.cells)]

    def column_names(self) -> "list[str]":
        """Logical-aligned header names (index i == logical column i+1)."""
        n = self.column_count()
        names: "list[str]" = [""] * n
        if self.header is not None:
            for pos, c in self._col1_items(self.header):
                if 1 <= pos <= n:
                    names[pos - 1] = c.value
        return names

    def column_comments(self) -> "list[Optional[str]]":
        n = self.column_count()
        out: "list[Optional[str]]" = [None] * n
        if self.header is not None:
            for pos, c in self._col1_items(self.header):
                if 1 <= pos <= n:
                    out[pos - 1] = self._cell_comment(c)
        return out

    def _cell_comment(self, cell: Cell) -> Optional[str]:
        for ch in cell.elem:
            if ch.tag == _SS + "Comment":
                author = ch.get(_SS + "Author", "").strip()
                textparts = []
                for sub in ch.iter():
                    if sub.text:
                        textparts.append(sub.text)
                body = "".join(textparts).lstrip("\n")
                # Excel already renders the author as the first bolded line in the
                # comment body; only prepend ss:Author when it is not already there.
                if author and not body.lstrip().startswith(author):
                    body = author + ":\n" + body
                return body
        return None

    # -- mutation ----------------------------------------------------------
    def add_data_row(self, values: Optional["list[str]"] = None) -> Row:
        """Append a new data row modelled on the last data row (styles/types)
        or the header (column count). Returns the new Row."""
        template = self.rows[-1] if self.rows else self.header
        if template is None:
            raise SpreadsheetError("No template row available")
        new = etree.fromstring(etree.tostring(template.elem))
        row = Row(new, is_header=False)
        # A cloned last row keeps any sparse ss:Index, which would collide with the
        # row it was copied from (game reads these). A freshly appended row is an
        # implicit trailing row, so its index must be cleared.
        new.attrib.pop(_SS + "Index", None)
        self.table.append(new)
        self.rows.append(row)
        # reset cell values, keeping each cell's logical ss:Index position
        for c in row.cells:
            c.clear()
        if values:
            for pos, c in self._col1_items(row):
                if 1 <= pos <= len(values):
                    c.set_value(str(values[pos - 1]), "String")
        self._bump_row_count()
        return row

    def set_cell_value(self, row_idx: int, col_idx: int, value: str,
                       type_token: Optional[str] = None):
        # col_idx is 0-based LOGICAL column (Row.set_cell_value maps it to ss:Index)
        rows = self.rows
        while len(rows) <= row_idx:
            self.add_data_row()
            rows = self.rows
        rows[row_idx].set_cell_value(col_idx, value, type_token)

    def add_column(self, name: str) -> int:
        """Append a logical column (header + blank cells in every row). Returns
        the new 0-based LOGICAL column index."""
        new_col_0 = self.column_count()
        col1 = new_col_0 + 1
        if self.header is not None:
            hc = self.header.elem.makeelement(_SS + "Cell", {})
            self.header.elem.append(hc)
            ch = Cell(hc)
            ch.index = col1
            ch.set_value(name, "String")
        else:
            raise SpreadsheetError("No header row to add a column to")
        for r in self.rows:
            nc = r.append_blank_cell()
            nc.index = col1
        self._bump_column_count()
        return new_col_0

    def delete_column(self, col: int):
        """Delete the 0-based LOGICAL column (honours sparse ss:Index)."""
        col1 = col + 1
        if self.header is not None:
            c = self.header.cell_by_logical(col1)
            if c is not None:
                self.header.elem.remove(c.elem)
        for r in self.rows:
            c = r.cell_by_logical(col1)
            if c is not None:
                r.elem.remove(c.elem)
        self._bump_column_count()

    def delete_row(self, row_idx: int):
        if 0 <= row_idx < len(self.rows):
            self.table.remove(self.rows[row_idx].elem)
            del self.rows[row_idx]
        self._bump_row_count()

    def insert_row_at(self, row_idx: int, cells: "list" = None,
                      row_index_attr: Optional[str] = None) -> Row:
        """Insert a data row at position row_idx (0-based, header excluded).

        cells is a [(1-based logical column, value, ss:Type, StyleID), ...]
        list captured from the row model. The cloned template keeps only its
        row-level attributes and is stripped of cells - the captured cells are
        rebuilt in ascending order (explicit ss:Index only where the logical
        position is not sequential), restoring sparse geometry exactly."""
        cells = cells or []
        template = self.rows[row_idx] if row_idx < len(self.rows) else (
            self.rows[-1] if self.rows else self.header)
        if template is None:
            raise SpreadsheetError("No template row available")
        new = etree.fromstring(etree.tostring(template.elem))
        new.attrib.pop(_SS + "Index", None)
        if row_index_attr is not None:
            new.set(_SS + "Index", row_index_attr)
        for ch in list(new):
            if ch.tag == _SS + "Cell":
                new.remove(ch)
        seq = 1
        for item in sorted(cells, key=lambda x: int(x[0])):
            pos, val = int(item[0]), str(item[1])
            ttype = item[2] if len(item) > 2 and item[2] else "String"
            style = item[3] if len(item) > 3 and item[3] else None
            c = etree.SubElement(new, _SS + "Cell")
            if pos != seq:
                c.set(_SS + "Index", str(pos))
            if style:
                c.set(_SS + "StyleID", str(style))
            Cell(c).set_value(val, ttype)
            seq = pos + 1
        if row_idx < len(self.rows):
            self.rows[row_idx].elem.addprevious(new)
        else:
            self.table.append(new)
        row = Row(new)
        self.rows.insert(row_idx, row)
        self._bump_row_count()
        return row

    def insert_column_at(self, col: int, name: str,
                         cell_values: "dict" = None):
        """Insert a logical column at 0-based position col (the inverse of
        delete_column). cell_values maps data-row index -> (text, type, style);
        only rows listed get a cell, matching a sparse delete exactly."""
        cell_values = cell_values or {}
        col1 = col + 1
        if self.header is not None:
            hc = self.header.insert_logical_cell(col1)
            hc.set_value(name, "String")
        else:
            raise SpreadsheetError("No header row to add a column to")
        for r_idx in sorted(cell_values, key=int):
            if 0 <= int(r_idx) < len(self.rows):
                val = cell_values[r_idx]
                ttype = val[1] if len(val) > 1 and val[1] else "String"
                style = val[2] if len(val) > 2 and val[2] else None
                c = self.rows[int(r_idx)].insert_logical_cell(col1, style)
                c.set_value(str(val[0]), ttype)
        self._bump_column_count()

    @staticmethod
    def row_payload(row: Row) -> "list[tuple[int, str, str, str]]":
        """[(1-based logical column, value, ss:Type, StyleID), ...] for history."""
        out = []
        for pos, c in zip(row._logical_positions(), row.cells):
            data = c._data()
            ttype = data.get(_SS + "Type") if data is not None else None
            out.append((pos, c.value, ttype, c.elem.get(_SS + "StyleID")))
        return out

    @staticmethod
    def cell_type(cell: Optional[Cell]) -> str:
        if cell is None:
            return "String"
        data = cell._data()
        return (data.get(_SS + "Type") if data is not None else None) or "String"

    @staticmethod
    def row_index_attr(row: Row) -> Optional[str]:
        """The row's own sparse ss:Index attribute (None when implicit)."""
        return row.elem.get(_SS + "Index")

    def _bump_row_count(self):
        self.table.set(_SS + "ExpandedRowCount", str(len(self.rows) + (1 if self.header else 0)))

    def _bump_column_count(self):
        n = 0
        if self.header is not None:
            n = max(n, self.header.max_logical())
        for r in self.rows:
            n = max(n, r.max_logical())
        self.table.set(_SS + "ExpandedColumnCount", str(n))


class SpreadsheetML:
    """One parsed .xml spreadsheet file (live lxml tree)."""

    def __init__(self):
        self.path: Optional[str] = None
        self.tree: Optional[etree._ElementTree] = None
        self.worksheets: list[Worksheet] = []

    # -- parsing ----------------------------------------------------------
    def load(self, path: str) -> "SpreadsheetML":
        self.path = path
        parser = etree.XMLParser(remove_blank_text=False, recover=True,
                                 resolve_entities=False)
        self.tree = etree.parse(path, parser)
        self._collect()
        return self

    def from_string(self, data: str) -> "SpreadsheetML":
        parser = etree.XMLParser(remove_blank_text=False, recover=True,
                                 resolve_entities=False)
        self.tree = etree.fromstring(data.encode("utf-8"), parser)  # type: ignore[assignment]
        # wrap in an ElementTree-like for uniform access
        self.tree = etree.ElementTree(self.tree)
        self._collect()
        return self

    def _collect(self):
        self.worksheets = []
        root = self.tree.getroot() if self.tree is not None else None
        if root is None or root.tag != _SS + "Workbook":
            # не Excel-2003: обычный xml / текст / пустой файл. Вместо
            # AttributeError (HTTP 500) даём внятную ошибку, которую
            # api_open_file перехватывает и показывает пользователю.
            raise SpreadsheetError(
                "%s: это не таблица Excel (нет <Workbook>)" % (self.path or ""))
        for ws_elem in root.iter(_SS + "Worksheet"):
            self.worksheets.append(Worksheet(ws_elem))
        if not self.worksheets:
            raise SpreadsheetError(
                "%s: нет листов <Worksheet>" % (self.path or ""))

    # -- serialization ----------------------------------------------------
    def to_bytes(self) -> bytes:
        if self.tree is None:
            raise SpreadsheetError("No document loaded")
        body = etree.tostring(self.tree.getroot(), encoding="utf-8")
        header = _HEADER.encode("utf-8") + _MSO.encode("utf-8")
        return header + body

    def to_string(self) -> str:
        return self.to_bytes().decode("utf-8")

    def save(self, path: Optional[str] = None, validate: bool = True):
        target = path or self.path
        if target is None:
            raise SpreadsheetError("No target path")
        data = self.to_bytes()
        if validate:
            self._validate(data.decode("utf-8"))
        with io.open(target, "wb") as fh:
            fh.write(data)

    def _validate(self, text: str):
        try:
            etree.fromstring(text.encode("utf-8"))
        except etree.XMLSyntaxError as e:
            raise SpreadsheetError("Refusing to write: invalid XML: %s" % e) from e
        try:
            s2 = SpreadsheetML()
            s2.from_string(text)
        except Exception as e:  # noqa: BLE001
            raise SpreadsheetError("Refusing to write: unreadable output: %s" % e) from e
