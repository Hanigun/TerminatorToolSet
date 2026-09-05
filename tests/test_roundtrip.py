"""Byte-preserving round-trip + mutation verification for spreadsheet_ml.py.

The #1 hard requirement: saving must NEVER change the structure of untouched
parts of a file. Editing a cell writes only that cell's bytes; adding/removing
rows/columns splices whole blocks and updates the Expanded counts; everything
else stays byte-identical.

Run: python -m test_roundtrip  (cwd = TerminatorSheetQt/)
"""
import io
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from spreadsheet_ml import SpreadsheetML, SpreadsheetError
from xmlgrid import Session

SAMPLE = r"D:\CloudLayer\Projects\Terminator Project\TERMINATOR_OVERHAUL_MAIN\TestProject\basis\scripts\species\tanks.xml"

SS = "{urn:schemas-microsoft-com:office:spreadsheet}"


def val(text, row1, col0):
    """Cell value at (row index including header, 0-based column) from XML text."""
    from lxml import etree
    tree = etree.fromstring(text.encode("utf-8"), etree.XMLParser(recover=False))
    w = tree.findall(SS + "Worksheet")[0]
    rows = w.find(SS + "Table").findall(SS + "Row")
    c = rows[row1].findall(SS + "Cell")[col0]
    for d in c.findall(SS + "Data"):
        return "".join(d.itertext())
    return ""


def val_type(text, row1, col0):
    """ss:Type of the cell's <Data> (None when there is no <Data>)."""
    from lxml import etree
    tree = etree.fromstring(text.encode("utf-8"), etree.XMLParser(recover=False))
    w = tree.findall(SS + "Worksheet")[0]
    rows = w.find(SS + "Table").findall(SS + "Row")
    c = rows[row1].findall(SS + "Cell")[col0]
    for d in c.findall(SS + "Data"):
        return d.get(SS + "Type")
    return None


def main():
    orig = open(SAMPLE, "rb").read().decode("utf-8")

    # -- 0) open with no edits -> Session.save must NOT touch the file -----
    d = SpreadsheetML().load(SAMPLE)
    s = Session(d, 0)
    assert s.save()["written"] is False, "open->save must not write"
    print("OK: open->save does not touch a pristine file")

    # -- 1) edit a cell: only that cell's bytes change ---------------------
    d = SpreadsheetML().load(SAMPLE)
    s = Session(d, 0)
    old_val = val(orig, 1, 0)
    # capture the ORIGINAL data span of the edited cell (byte-coordinates)
    old_cell = [c for c in d._spine.sheets[0]["rows"][0]["cells"] if c["logical"] == 1][0]
    bodystart, bodyend = old_cell["data"]["open_end"], old_cell["data"]["close_start"]
    new_val = "LYCH_spider_EDITED"
    res = s.edit_cell(0, 0, new_val, "String")
    out = d.to_string()
    delta = len(new_val) - (bodyend - bodystart)
    assert out[:bodystart] == orig[:bodystart], "prefix changed"
    assert out[bodyend + delta:] == orig[bodyend:], "tail changed after the edit"
    assert val(out, 1, 0) == new_val
    d2 = SpreadsheetML().from_string(out)
    assert d2.worksheets[0].rows[0].cell_value(0) == new_val
    print("OK: edit cell is byte-localized (untouched bytes identical)")

    # -- 2) add row: untouched rows keep their exact bytes -----------------
    d = SpreadsheetML().load(SAMPLE)
    s = Session(d, 0)
    # capture the text of the row just BEFORE the insertion target
    s.add_row(["BRAND_NEW", "1", "2"])
    out = d.to_string()
    d3 = SpreadsheetML().from_string(out)
    assert d3.worksheets[0].rows[-1].cell_value(0) == "BRAND_NEW"
    # the first data row (row[0]) must remain byte-identical
    sp3 = d3._spine.sheets[0]
    row0_span_new = (sp3["rows"][0]["start"], sp3["rows"][0]["end"])
    orig_rows = SpreadsheetML().load(SAMPLE)._spine.sheets[0]["rows"]
    o_start = orig_rows[0]["start"]
    o_end = orig_rows[0]["end"]
    # the original row[0] span text should appear verbatim in the new text's row[0]
    orig_row0 = orig[o_start:o_end]
    assert out[row0_span_new[0]:row0_span_new[1]] == orig_row0, "untouched row[0] changed"
    print("OK: add row keeps existing rows byte-identical")

    # -- 3) delete row -----------------------------------------------------
    d = SpreadsheetML().load(SAMPLE)
    s = Session(d, 0)
    n = len(d.worksheets[0].rows)
    s.delete_row(1)
    out = d.to_string()
    d4 = SpreadsheetML().from_string(out)
    assert len(d4.worksheets[0].rows) == n - 1
    # row[1] became the old row[2]; old row[2] text must be at row[1]
    orig_row2 = orig[orig_rows[2]["start"]:orig_rows[2]["end"]]
    sp4 = d4._spine.sheets[0]
    new_row1 = out[sp4["rows"][1]["start"]:sp4["rows"][1]["end"]]
    assert new_row1 == orig_row2, "row content shifted but not altered"
    print("OK: delete row shifts content without re-serializing it")

    # -- 4) add / delete column --------------------------------------------
    d = SpreadsheetML().load(SAMPLE)
    s = Session(d, 0)
    nc0 = d.worksheets[0].column_count()
    s.add_column("BANANA_COL")
    out = d.to_string()
    d5 = SpreadsheetML().from_string(out)
    assert len(d5.worksheets[0].header.cells) == nc0 + 1
    assert "BANANA_COL" in d5.worksheets[0].column_names()
    s2 = Session(d5, 0)
    s2.delete_column(d5.worksheets[0].column_count() - 1)
    out6 = d5.to_string()
    d6 = SpreadsheetML().from_string(out6)
    assert "BANANA_COL" not in d6.worksheets[0].column_names()
    print("OK: add/delete column splice correctly")

    # -- 5) save + validate ------------------------------------------------
    d = SpreadsheetML().load(SAMPLE)
    s = Session(d, 0)
    s.edit_cell(0, 0, "FINAL_VALUE", "String")
    tmp = os.path.join(os.path.dirname(__file__), "_roundtrip_out.xml")
    r = s.save(tmp, validate=True)
    assert r["written"] is True
    d7 = SpreadsheetML().load(tmp)
    assert d7.worksheets[0].rows[0].cell_value(0) == "FINAL_VALUE"
    os.remove(tmp)
    print("OK: save+validate writes a readable file")

    # -- comments preserved (never re-serialized away) ---------------------
    c = d7.worksheets[0].column_comments()
    assert any(x is not None for x in c), "column comments lost"
    print("OK: column comments preserved")

    # -- non-Workbook file -> clean error (no silent mutation) -------------
    bad = os.path.join(os.path.dirname(__file__), "mod.json")
    if os.path.isfile(bad):
        try:
            SpreadsheetML().load(bad)
            raise SystemExit("FAIL: non-Workbook file should raise")
        except SpreadsheetError as e:
            print("OK: non-Workbook raises clean error: %s" % str(e)[:50])

    # -- 6) autotype: число в пустую ячейку -> ss:Type="Number" ------------
    # (раньше тип принудительно был String -> WPS: "числа отформатированные
    # как текст или с предшествующим апострофом")
    d = SpreadsheetML().load(SAMPLE)
    s = Session(d, 0)
    # найдём пустую ячейку (без <Data>) в первой строке
    empty_col = None
    for c in d._spine.sheets[0]["rows"][0]["cells"]:
        if c["data"] is None:
            empty_col = c["logical"] - 1
            break
    if empty_col is not None:
        s.edit_cell(0, empty_col, "0.5")
        out = d.to_string()
        t = val_type(out, 1, empty_col)
        assert t == "Number", "numeric value into empty cell must become Number, got %s" % t
        print("OK: numeric value into empty cell -> ss:Type=Number")
    else:
        print("SKIP: no empty cell in row 0 for autotype test")

    # -- 7) автотип не меняет существующие типы ----------------------------
    d = SpreadsheetML().load(SAMPLE)
    s = Session(d, 0)
    r0 = d._spine.sheets[0]["rows"][0]
    num_col = None
    for c in r0["cells"]:
        if c["data"] and c["data"].get("type") == "String":
            num_col = c["logical"] - 1
            break
    if num_col is not None:
        s.edit_cell(0, num_col, "12345")
        out = d.to_string()
        t = val_type(out, 1, num_col)
        assert t == "String", "existing String cell must stay String, got %s" % t
        print("OK: existing String cell keeps its type when edited with a number")

    # -- 8) fix_expanded_counts: битый счётчик чинится точечной заменой -----
    d = SpreadsheetML().load(SAMPLE)
    broken = d.to_string().replace('ss:ExpandedRowCount="31"', 'ss:ExpandedRowCount="4"', 1)
    d = SpreadsheetML().from_string(broken)
    changed = d.fix_expanded_counts()
    assert changed and any(c["attr"] == "ExpandedRowCount" for c in changed), \
        "broken row count must be detected: %r" % changed
    out = d.to_string()
    from lxml import etree
    root = etree.fromstring(out.encode("utf-8"))
    tbl = root.find(SS + "Worksheet").find(SS + "Table")
    fact_rows = len(tbl.findall(SS + "Row"))
    assert int(tbl.get(SS + "ExpandedRowCount")) == fact_rows
    # вне <Table ...> всё по-прежнему байт-в-байт
    d9 = SpreadsheetML().from_string(broken)
    sp = d9._spine.sheets[0]
    tail_orig = broken[sp["table_end"]:]
    sp10 = d._spine.sheets[0]
    tail_new = out[sp10["table_end"]:]
    assert tail_orig == tail_new, "fix must touch only the Table start tag"
    print("OK: fix_expanded_counts rewrites only the counters")

    # -- 9) open->save битого-по-счётчику файла НЕ чинит и не пишет ---------
    d = SpreadsheetML().from_string(broken)
    s = Session(d, 0)
    assert s.save()["written"] is False, "fix only by explicit button"
    print("OK: pristine save does not fix counters silently")

    # -- 10) _bump_table: файл без атрибутов счётчиков остаётся валидным -----
    noattr = broken.replace('ss:ExpandedColumnCount="113" ss:ExpandedRowCount="31" ', "", 1)
    if 'ss:ExpandedColumnCount' not in noattr.split("<Table", 1)[1].split(">", 1)[0]:
        d = SpreadsheetML().from_string(noattr)
        s = Session(d, 0)
        s.add_row(["AFTER_NOATTR", "1"])
        out = d.to_string()
        root = etree.fromstring(out.encode("utf-8"))
        tbl = root.find(SS + "Worksheet")[0].find(SS + "Table")
        assert tbl.get(SS + "ExpandedRowCount") is None, \
            "must not invent an ExpandedRowCount attribute"
        assert len(tbl.findall(SS + "Row")) == fact_rows + 1
        print("OK: tables without Expanded* attributes stay valid on add_row")

    # -- 11) recover: битый XML открывается в аварийном режиме --------------
    broken_truncated = orig[:orig.rfind("</Row>")] + "   <Cell ss:StyleID=\"s88\"><Data ss:Type=\"String\">12</Data><Comment\n</Table>\n</Worksheet>\n</Workbook>\n"
    dbrk = os.path.join(os.path.dirname(__file__), "_broken_recover.xml")
    with io.open(dbrk, "wb") as fh:
        fh.write(broken_truncated.encode("utf-8"))
    try:
        try:
            SpreadsheetML().load(dbrk)
            raise SystemExit("FAIL: broken XML should raise in strict mode")
        except SpreadsheetError:
            pass
        d = SpreadsheetML().load(dbrk, recover=True)
        s = Session(d, 0)
        assert s.recovered and d.recovered
        assert s.grid()["rows"], "recover must salvage rows"
        # аварийное сохранение перезаписывает файл явно
        r = s.save()
        assert r["written"] is True
        # сохранённый файл теперь валиден и читается в строгом режиме
        d = SpreadsheetML().load(dbrk)
        assert d.worksheets[0].rows
        print("OK: recover mode salvages a truncated XML")
    finally:
        os.remove(dbrk)

    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
