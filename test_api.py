"""Integration test via Flask test client (no window needed).

NEVER writes to the real mod files: edits run with autosave disabled, and the
only /api/save is performed against a temporary copy of the sample.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import Config
from database import Database
from app import create_app

SAMPLE = r"D:\Games\Terminator Project\TERMINATOR_OVERHAUL_MAIN\TERMINATOR_OVERHAUL\basis\scripts\species\tanks.xml"
PROJECT_ROOT = r"D:\Games\Terminator Project\TERMINATOR_OVERHAUL_MAIN\TERMINATOR_OVERHAUL"


def test_cross_file_links():
    """After opening a project, /api/links must resolve references into OTHER
    files (this was broken when api_open_file cleared all sessions)."""
    tmp = tempfile.mkdtemp()
    cfg = Config(tmp)
    cfg.set("auto_save", False)
    db = Database(os.path.join(tmp, "t.db"))
    app = create_app(cfg, db)
    c = app.test_client()

    r = c.post("/api/open_project", json={"path": PROJECT_ROOT})
    assert r.get_json()["ok"], r.get_json()
    r = c.post("/api/open_file", json={"path": SAMPLE})
    assert r.get_json()["ok"], r.get_json()

    r = c.get("/api/links", query_string={"path": SAMPLE})
    j = r.get_json()
    assert j.get("ok"), j
    links = j.get("links", [])
    assert links, "expected cross-file links from tanks.xml"
    cross = {os.path.basename(l["target_file"]) for l in links
             if os.path.basename(l["target_file"]) != "tanks.xml"}
    assert cross, "expected links pointing to files OTHER than the open one"
    print("cross-file links ok; total:", len(links), "targets:", sorted(cross))


def main():
    tmp = tempfile.mkdtemp()
    cfg = Config(tmp)
    cfg.set("auto_save", False)
    db = Database(os.path.join(tmp, "t.db"))
    app = create_app(cfg, db)
    c = app.test_client()

    r = c.get("/api/config")
    assert r.status_code == 200, r
    print("config ok:", r.get_json()["theme"])

    r = c.get("/api/i18n")
    assert "open_file" in r.get_json()
    print("i18n ok")

    r = c.post("/api/open_file", json={"path": SAMPLE})
    j = r.get_json()
    assert j["ok"], j
    path = j["file"]["path"]
    print("open_file ok; sheets:", j["file"]["sheets"], "rows:", len(j["file"]["rows"]))

    r = c.get("/api/file", query_string={"path": path})
    j = r.get_json()
    assert len(j["columns"]) > 0
    assert j["rows"][0]["values"][0] == "Lgn_spider"
    print("grid ok; first key:", j["rows"][0]["values"][0], "ncols:", len(j["columns"]))

    r = c.post("/api/edit", json={"path": path, "row": 0, "col": 1, "value": "12345"})
    assert r.get_json()["ok"]
    r = c.get("/api/file", query_string={"path": path})
    assert r.get_json()["rows"][0]["values"][1] == "12345"
    print("edit cell ok")

    r = c.post("/api/add_row", json={"path": path, "values": None, "save": False})
    j = r.get_json()
    assert j["ok"], j
    r = c.get("/api/file", query_string={"path": path})
    assert len(r.get_json()["rows"]) == j["row"] + 1
    print("add_row ok; rows ->", len(r.get_json()["rows"]))

    r = c.post("/api/add_column", json={"path": path, "name": "test_col", "save": False})
    j = r.get_json()
    assert j["ok"], j
    r = c.get("/api/file", query_string={"path": path})
    assert "test_col" in r.get_json()["columns"]
    print("add_column ok -> total cols", len(r.get_json()["columns"]))

    r = c.post("/api/compare", json={"left": path, "right": path, "key_col": 0})
    j = r.get_json()
    assert j["ok"], j
    print("compare ok; diff rows:", len(j["diff"]))

    # SAVE against a TEMP COPY (never the real mod file)
    tmp_copy = os.path.join(tmp, "tanks_copy.xml")
    with open(SAMPLE, "rb") as fh:
        open(tmp_copy, "wb").write(fh.read())
    r = c.post("/api/open_file", json={"path": tmp_copy})
    assert r.get_json()["ok"]
    c.post("/api/edit", json={"path": tmp_copy, "row": 0, "col": 0, "value": "TEMP_UNIT"})
    r = c.post("/api/save", json={"path": tmp_copy})
    assert r.get_json()["ok"], r.get_json()
    import spreadsheet_ml as sml
    d = sml.SpreadsheetML().load(tmp_copy)
    assert d.worksheets[0].rows[0].cell_value(0) == "TEMP_UNIT"
    print("save to temp copy + re-read ok")

    r = c.get("/api/history", query_string={"path": tmp_copy})
    assert len(r.get_json()) >= 1
    print("history records:", len(r.get_json()))

    # links engine
    c.post("/api/open_file", json={"path": tmp_copy})
    c.post("/api/open_file", json={"path": SAMPLE})
    r = c.get("/api/links", query_string={"path": tmp_copy})
    j = r.get_json()
    print("links engine ok =", j.get("ok"), "links:", len(j.get("links", [])))

    test_cross_file_links()

    print("INTEGRATION TESTS PASSED")


if __name__ == "__main__":
    main()
