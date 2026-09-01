"""Round-trip + mutation verification for spreadsheet_ml.py.

Run: python -m test_roundtrip  (cwd = TerminatorSheet/)
"""
import io
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
import spreadsheet_ml as sml

SAMPLE = r"D:\Games\Terminator Project\TERMINATOR_OVERHAUL_MAIN\TERMINATOR_OVERHAUL\basis\scripts\species\tanks.xml"


def snapshot(d: sml.SpreadsheetML):
    out = []
    for ws in d.worksheets:
        data = []
        for r in ws.rows:
            data.append([c.value for c in r.cells])
        out.append((ws.name, ws.column_names(), data,
                    ws.expanded_column_count(), ws.expanded_row_count()))
    return out


def main():
    d = sml.SpreadsheetML().load(SAMPLE)
    snap = snapshot(d)
    out = d.to_string()
    d2 = sml.SpreadsheetML().from_string(out)
    assert snapshot(d2) == snap, "ROUND TRIP MISMATCH"
    print("OK: round-trip is value-identical")

    # --- edit a value ------------------------------------------------------
    ws = d.worksheets[0]
    ws.set_cell_value(0, 0, "Lgn_spider_EDITED")
    assert ws.rows[0].cell_value(0) == "Lgn_spider_EDITED"
    out2 = d.to_string()
    d3 = sml.SpreadsheetML().from_string(out2)
    assert d3.worksheets[0].rows[0].cell_value(0) == "Lgn_spider_EDITED"
    # other cells unchanged
    assert d3.worksheets[0].rows[1].cell_value(0) == snap[0][2][1][0]
    print("OK: edit value is localized, neighbours untouched")

    # --- delete then re-add a data row -------------------------------------
    ws.delete_row(3)
    nrows = len(ws.rows)
    ws.add_data_row(["NEW_UNIT", "1", "2"])
    assert len(ws.rows) == nrows + 1, (len(ws.rows), nrows)
    assert ws.rows[-1].cell_value(0) == "NEW_UNIT"
    d4 = sml.SpreadsheetML().from_string(d.to_string())
    assert d4.worksheets[0].rows[-1].cell_value(0) == "NEW_UNIT"
    print("OK: add/delete data row + ExpandedRowCount")

    # --- add column ---------------------------------------------------------
    col = ws.add_column("my_new_column")
    assert ws.header.cells[col].value == "my_new_column"
    assert ws.expanded_column_count() == len(ws.header.cells)
    # logical access to the new column is empty on every row
    assert all(r.cell_value(col) == "" for r in ws.rows)
    d5 = sml.SpreadsheetML().from_string(d.to_string())
    assert d5.worksheets[0].header.cells[col].value == "my_new_column"
    print("OK: add column, counts and row alignment")

    # --- delete column ------------------------------------------------------
    ws.delete_column(col)
    assert ws.expanded_column_count() == len(ws.header.cells)
    assert "my_new_column" not in ws.column_names()  # gone
    print("OK: delete column")

    # now save to a temp file (validates on write)
    tmp = os.path.join(os.path.dirname(__file__), "_roundtrip_out.xml")
    d.save(tmp, validate=True)
    print("OK: save+validate to", tmp)
    os.remove(tmp)

    # comments preserved
    comments = ws.column_comments()
    has_any = any(c is not None for c in comments)
    print("has column comments:", has_any)
    # show first comment
    for idx, c in enumerate(comments):
        if c:
            print("  comment[%d]='%s'..." % (idx, c[:80].replace(chr(10), ' ')))
            break

    # --- sparse row ss:Index must not be duplicated by add_data_row ---------
    _SS = "{urn:schemas-microsoft-com:office:spreadsheet}"
    sparse = ('<?xml version="1.0"?>'
              '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" '
              'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'
              '<Worksheet ss:Name="S"><Table ss:ExpandedRowCount="3" '
              'ss:ExpandedColumnCount="1">'
              '<Row><Cell><Data ss:Type="String">hdr</Data></Cell></Row>'
              '<Row><Cell><Data ss:Type="String">a</Data></Cell></Row>'
              '<Row ss:Index="77"><Cell><Data ss:Type="String">z</Data></Cell></Row>'
              '</Table></Worksheet></Workbook>')
    ds = sml.SpreadsheetML().from_string(sparse)
    ws_s = ds.worksheets[0]
    assert ws_s.rows[-1].elem.get(_SS + "Index") == "77"
    new_r = ws_s.add_data_row()
    assert new_r.elem.get(_SS + "Index") is None, "clone kept stale ss:Index"
    idxs = [r.elem.get(_SS + "Index") for r in ws_s.rows]
    assert idxs.count("77") == 1, "duplicate row ss:Index"
    print("OK: add_data_row does not duplicate sparse row ss:Index")

    # --- logical column addressing (sparse trailing cells) -----------------
    # tanks.xml row 0 has 110 physical cells but max logical column 112; the
    # header is dense 1..114. Editing the LAST columns by physical position used
    # to hit the WRONG logical column (the bug being fixed).
    dt = sml.SpreadsheetML().load(SAMPLE)
    wst = dt.worksheets[0]
    r0 = wst.rows[0]
    ncells = len(r0.cells)
    assert wst.column_count() >= 114
    # a logical column beyond the physical cell count (e.g. 0-based 112 == logical 113)
    wst.set_cell_value(0, 112, "LOGICAL_END", "String")
    c113 = r0.cell_by_logical(113)
    assert c113 is not None and c113.value == "LOGICAL_END"
    assert r0.cell_value(112) == "LOGICAL_END"
    # an absent middle logical column (logical 101) inserted in ascending order
    wst.set_cell_value(0, 100, "LOGICAL_MID", "String")
    seq = 1; order = []
    for c in r0.cells:
        i = c.index
        if i is not None: seq = i
        order.append(seq); seq += 1
    assert order == sorted(order), "ss:Index must stay ascending for the game"
    assert r0.cell_by_logical(101).value == "LOGICAL_MID"
    print("OK: edit/add on sparse trailing columns targets the correct logical column")
    assert len(r0.cells) > ncells

    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
