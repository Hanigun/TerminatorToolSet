"""Unlazy oracle: diff-based history + undo/redo engine checks.

Prints HISTORY DIFF GATE PASSED after the storage assertions, then
UNDO ENGINE GATE PASSED after the behaviour/timing assertions.
Run from the TerminatorSheet directory:  python scripts\\verify_history.py
"""
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import create_app          # noqa: E402
from config import Config           # noqa: E402
from database import Database       # noqa: E402

SRC = r"D:\Games\Terminator Project\TERMINATOR_OVERHAUL_MAIN\TERMINATOR_OVERHAUL\basis\scripts\species\tanks.xml"

failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)
        print("FAIL:", msg)


def build(tmp):
    work = os.path.join(tmp, "tanks.xml")
    shutil.copy(SRC, work)
    cfg = Config(tmp)
    db = Database(os.path.join(tmp, "app.db"))
    app = create_app(cfg, db)
    return work, app.test_client(), db


def _close(db):
    try:
        db.conn.close()
    except Exception:  # noqa: BLE001
        pass


def cell(cl, path):
    return cl.get("/api/file", query_string={"path": path}).get_json()["rows"][0]["values"][1]


def nrows(cl, path):
    return len(cl.get("/api/file", query_string={"path": path}).get_json()["rows"])


with tempfile.TemporaryDirectory() as tmp:
    work, cl, db = build(tmp)
    cl.post("/api/open_file", json={"path": work})
    cl.post("/api/config", json={"auto_save": True})

    # ---------------- G3: diff storage + informative records ----------------
    cl.post("/api/edit", json={"path": work, "row": 0, "col": 1, "value": "H1"})
    cl.post("/api/add_row", json={"path": work})
    cl.post("/api/delete_row", json={"path": work, "row": 3})
    cl.post("/api/add_column", json={"path": work, "name": "zz_gate_col"})
    cl.post("/api/delete_column", json={"path": work, "col": 4})
    cl.post("/api/edit", json={"path": work, "row": 0, "col": 1, "value": "H2"})

    j = cl.get("/api/history", query_string={"path": work}).get_json()
    records = j.get("records") if isinstance(j, dict) else j
    check(isinstance(records, list) and len(records) >= 6,
          "history must contain every change record, got %r" % (len(records) if isinstance(records, list) else records))
    for rec in records:
        check(bool(rec.get("summary")), "record %s must have a summary" % rec.get("id"))
        check(os.path.basename(work) in rec.get("file", ""), "record must report the file name")
        check(rec.get("action") in ("edit", "edit_cells", "add_row", "del_row",
                                       "add_col", "del_col", "row_set",
                                       "col_set", "redo"),
              "unexpected action %r" % rec.get("action"))
        if rec.get("action") != "redo":
            check(bool(rec.get("payload")), "record must carry a diff payload")

    # no snapshot blobs: no backups table, tiny DB
    tables = {row[0] for row in db.conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    check("backups" not in tables, "snapshot storage (backups table) must be gone")
    dbfile = os.path.join(tmp, "app.db")
    check(os.path.getsize(dbfile) < 512 * 1024,
          "history DB must stay small without snapshots (got %d bytes)" % os.path.getsize(dbfile))

    if not failures:
        print("HISTORY DIFF GATE PASSED")
    if failures:
        _close(db)
        sys.exit(1)

    # ---------------- G4: undo/redo engine behaviour + speed ----------------
    n = len(failures)

    def timed(post, what):
        t = time.perf_counter()
        out = cl.post(post, json={"path": work}).get_json()
        dt = time.perf_counter() - t
        check(out.get("ok"), "%s must succeed: %r" % (what, out))
        check(dt < 1.0, "%s took %.2fs - must stay under 1s (no full-file snapshots)" % (what, dt))
        return out

    def undo():
        return timed("/api/undo", "undo")

    def redo():
        return timed("/api/redo", "redo")

    # six changes on the stack (newest first): edit H2, del_col, add_col,
    # del_row, add_row, edit H1 - each undo must revert exactly one of them
    undo();  check(cell(cl, work) == "H1", "undo #1 must revert only the last edit, got %r" % cell(cl, work))
    undo();  check(cell(cl, work) == "H1", "undo #2 must not touch cell (0,1)")
    undo();  undo();  undo()
    check(cell(cl, work) == "H1", "after 5 undos only the first edit remains, got %r" % cell(cl, work))
    undo();  check(cell(cl, work) == "2", "6th undo must restore the opened value, got %r" % cell(cl, work))
    check(cl.post("/api/undo", json={"path": work}).get_json().get("error") == "nothing_to_undo",
          "undo stack must be empty after reverting all changes")

    for _ in range(6):
        redo()
    check(cell(cl, work) == "H2", "6 redos must re-apply everything, got %r" % cell(cl, work))
    check(cl.post("/api/redo", json={"path": work}).get_json().get("error") == "nothing_to_redo",
          "redo stack must be exhausted")

    undo();  check(cell(cl, work) == "H1", "undo after full redo cycle must step back exactly once")
    redo();  check(cell(cl, work) == "H2", "redo must step forward exactly once")

    # row ops roundtrip through undo
    before = nrows(cl, work)
    cl.post("/api/add_row", json={"path": work})
    check(nrows(cl, work) == before + 1, "add_row must add a row")
    undo()
    check(nrows(cl, work) == before, "undo must remove the added row")

    rowvals = cl.get("/api/file", query_string={"path": work}).get_json()["rows"][5]["values"]
    cl.post("/api/delete_row", json={"path": work, "row": 5})
    undo()
    got = cl.get("/api/file", query_string={"path": work}).get_json()["rows"][5]["values"]
    check(got == rowvals, "undo of delete_row must restore the row content")

    # delete a column, undo must restore name + values
    f = cl.get("/api/file", query_string={"path": work}).get_json()
    colname, colvals = f["columns"][7], [r["values"][7] for r in f["rows"]]
    cl.post("/api/delete_column", json={"path": work, "col": 7})
    check(cl.get("/api/file", query_string={"path": work}).get_json()["columns"][7] != colname,
          "delete_column must remove the column")
    undo()
    f3 = cl.get("/api/file", query_string={"path": work}).get_json()
    check(f3["columns"][7] == colname, "undo of delete_column must restore the header")
    check([r["values"][7] for r in f3["rows"]] == colvals, "undo of delete_column must restore cell values")

    # revert-to-step: land on the state after the very first edit (H1)
    j = cl.get("/api/history", query_string={"path": work}).get_json()
    applied = j.get("records", [])
    check(all(isinstance(r.get("undone"), bool) for r in applied),
          "every history record must carry its applied/undone state")
    first_edit = [x for x in applied if x["action"] == "edit" and x["summary"].endswith("-> H1")][-1]
    rr = cl.post("/api/restore", json={"backup_id": first_edit["id"], "path": work}).get_json()
    check(rr.get("ok"), "revert-to-step must succeed: %r" % rr)
    check(cell(cl, work) == "H1", "revert-to-step must land on the recorded state")
    # redo walks forward chronologically until the newest state is back
    while True:
        out = cl.post("/api/redo", json={"path": work}).get_json()
        if not out.get("ok"):
            break
    check(cell(cl, work) == "H2", "redoing all reverted steps must return to the newest state")

    # ---------------- G4b: reset to beginning = clean file ----------------
    # (restore самой старой записи первую правку оставляет — здесь отдельный
    # эндпоинт, обязан вернуть значение до всех правок и всё сделать redoable)
    workR = os.path.join(tmp, "reset.xml")
    shutil.copy(SRC, workR)
    cl.post("/api/open_file", json={"path": workR})
    orig = cell(cl, workR)
    cl.post("/api/edit", json={"path": workR, "row": 0, "col": 1, "value": "RST1"})
    cl.post("/api/edit", json={"path": workR, "row": 0, "col": 1, "value": "RST2"})
    rj = cl.post("/api/reset_beginning", json={"path": workR}).get_json()
    check(rj.get("ok"), "reset to beginning must succeed: %r" % (rj,))
    check(cell(cl, workR) == orig,
          "reset to beginning must restore the pre-edit value, got %r" % cell(cl, workR))
    hj = cl.get("/api/history", query_string={"path": workR}).get_json()
    check(hj.get("can_undo") is False and hj.get("can_redo") is True,
          "after reset nothing to undo, everything redoable, got %r" % (hj,))
    check(all(r.get("undone") for r in hj.get("records", [])),
          "reset must park every record as undone")

    # ---------------- G4c: row_set (transfer) undo keeps every cell ----------------
    # (откат обновления жёлтой строки пересобирал её из payload по шаблону
    # соседней строки и терял ячейки разреженных строк — проверка круговым
    # переносом строки в тот же файл)
    workT = os.path.join(tmp, "trow.xml")
    shutil.copy(SRC, workT)
    cl.post("/api/open_file", json={"path": workT})
    before = cl.get("/api/file", query_string={"path": workT}).get_json()["rows"][0]["values"]
    tj = cl.post("/api/transfer_row", json={"src": workT, "dst": workT, "row": 0, "key_col": 0}).get_json()
    check(tj.get("ok"), "self transfer must succeed: %r" % (tj,))
    check(cl.post("/api/undo", json={"path": workT}).get_json().get("ok"),
          "row_set undo must succeed")
    after = cl.get("/api/file", query_string={"path": workT}).get_json()["rows"][0]["values"]
    check(after == before,
          "row_set undo must restore every cell, lost at %r"
          % ([i for i, (a, b) in enumerate(zip(after, before)) if a != b],))

    # ---------------- G5: edit_cells batch = one record, one undo ----------------
    # (карта Uprising: обмен секторов и другие команды — одна запись журнала)
    work2 = os.path.join(tmp, "batch.xml")
    shutil.copy(SRC, work2)
    cl.post("/api/open_file", json={"path": work2})
    f0 = cl.get("/api/file", query_string={"path": work2}).get_json()
    cols = list(range(1, min(len(f0["columns"]), 4)))
    old_vals = [f0["rows"][1]["values"][c] for c in cols]
    new_vals = ["G5B%d" % c for c in cols]
    bj = cl.post("/api/edit_cells", json={
        "path": work2,
        "cells": [{"row": 1, "col": c, "value": v, "type": "String"}
                  for c, v in zip(cols, new_vals)],
        "summary": "Test batch (%d cells)" % len(cols)}).get_json()
    check(bj.get("ok") and bj.get("n") == len(cols),
          "edit_cells must apply the whole batch: %r" % (bj,))
    got = cl.get("/api/file", query_string={"path": work2}).get_json()["rows"][1]["values"]
    check(all(got[c] == v for c, v in zip(cols, new_vals)),
          "batch must land in every cell, got %r" % ([got[c] for c in cols],))
    recs = cl.get("/api/history", query_string={"path": work2}).get_json().get("records", [])
    batch_recs = [r for r in recs if r.get("action") == "edit_cells"]
    check(len(batch_recs) == 1,
          "one batch must be exactly one record, got %d" % len(batch_recs))
    check(batch_recs and batch_recs[0].get("summary") == "Test batch (%d cells)" % len(cols),
          "custom summary must survive, got %r"
          % (batch_recs[0].get("summary") if batch_recs else None))
    check(cl.post("/api/undo", json={"path": work2}).get_json().get("ok"),
          "batch undo must succeed")
    got2 = cl.get("/api/file", query_string={"path": work2}).get_json()["rows"][1]["values"]
    check(all(got2[c] == v for c, v in zip(cols, old_vals)),
          "one undo must revert the whole batch, got %r" % ([got2[c] for c in cols],))
    check(cl.post("/api/redo", json={"path": work2}).get_json().get("ok"),
          "batch redo must succeed")
    got3 = cl.get("/api/file", query_string={"path": work2}).get_json()["rows"][1]["values"]
    check(all(got3[c] == v for c, v in zip(cols, new_vals)),
          "redo must re-apply the whole batch, got %r" % ([got3[c] for c in cols],))
    big = cl.post("/api/edit_cells", json={
        "path": work2,
        "cells": [{"row": 0, "col": 1, "value": "x"}] * 2001}).get_json()
    check(big.get("ok") is False, "2001 cells must be rejected: %r" % (big,))

    if len(failures) == n:
        print("UNDO ENGINE GATE PASSED")

    _close(db)   # release app.db before TemporaryDirectory cleanup (Windows)

if failures:
    print("HISTORY/UNDO CHECK FAILED: %d assertion(s)" % len(failures))
    sys.exit(1)
