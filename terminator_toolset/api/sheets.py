"""Spreadsheet routes: open/edit/structure/save + unpacked-game guard."""
from __future__ import annotations

import os
import time

from flask import jsonify, request

from ..domain.spreadsheet_ml import SpreadsheetError


def register_sheets(app, ctx):
    """File sessions, cell/row/column edits, guard, save."""
    store, db, hist, saves, guard, entities, log = (
        ctx.store, ctx.db, ctx.hist, ctx.saves, ctx.guard, ctx.entities, ctx.log)

    @app.route("/api/open_file", methods=["POST"])
    def api_open_file():
        data = request.get_json(silent=True) or {}
        path = data.get("path", "")
        recover = bool(data.get("recover"))
        reset = bool(data.get("reset"))   # «Отменить все изменения»: сбросить
        # кэшированную сессию и перечитать файл с диска (правки в памяти теряются)
        t0 = time.time()
        log.info("open_file: %s (recover=%s)", path, recover)
        if not path or not os.path.isfile(path):
            return jsonify({"ok": False, "error": "not a file"})
        pk = store.normal(path)
        if reset:
            store.drop(pk)
        try:
            s = store.get(path, recover=recover)
        except SpreadsheetError as e:
            # recoverable=True -> фронт предлагает аварийное открытие
            return jsonify({"ok": False, "error": str(e),
                            "recoverable": not recover})
        log.info("open_file done in %.2fs: %s (%d rows)",
                 time.time() - t0, path, len(s.worksheet.rows))
        db.add_recent("file", path)
        entities.rebuild(s)
        return jsonify({"ok": True, "file": hist.file_payload(s),
                        "edited": saves.path_edited(path), **hist.flags(s.path)})

    @app.route("/api/file")
    def api_file():
        path = request.args.get("path", "")
        if not path or not os.path.isfile(path):
            return jsonify({"ok": False, "error": "not a file"})
        try:
            s = store.get(path)
        except SpreadsheetError as e:
            return jsonify({"ok": False, "error": str(e)})
        return jsonify({"ok": True, **hist.file_payload(s)})

    @app.route("/api/switch_sheet")
    def api_switch_sheet():
        path = request.args.get("path", "")
        idx = int(request.args.get("index", "0"))
        s = store.get(path)
        s.switch_sheet(idx)
        return jsonify(hist.file_payload(s))

    # -- API: edits ------------------------------------------------------------
    @app.route("/api/edit", methods=["POST"])
    def api_edit():
        data = request.get_json(silent=True) or {}
        path = store.normal(data.get("path", ""))
        s = store.get(path)
        row = int(data.get("row", -1))
        col = int(data.get("col", -1))
        if not (0 <= row < len(s.worksheet.rows)):
            return jsonify({"ok": False, "error": "row out of range"})
        res = s.edit_cell(row, col, data.get("value", ""), data.get("type"))
        if not res["ok"]:
            return jsonify(res)
        names = s.worksheet.column_names()
        colname = names[col] if 0 <= col < len(names) else "c%d" % col
        # row identity for the history: the sysname (first column), e.g.
        # "shell_120heat bulding_miss_factor: 0.1 -> 5"
        rowkey = hist.short_val(s.worksheet.rows[row].cell_value(0), 24) or ("r%d" % row)
        summary = "%s %s: %s -> %s" % (rowkey, colname,
                                       hist.short_val(res["old"]), hist.short_val(data.get("value", "")))
        db.log_change(s.path, "edit", res["payload"], summary)
        saved = saves.autosaved(data, s, None)
        saves.mark_dirty(s, saved)
        return jsonify({"ok": True, "old": res["old"], "new": data.get("value", ""),
                         "saved": saved, **hist.flags(s.path)})

    @app.route("/api/edit_cells", methods=["POST"])
    def api_edit_cells():
        """Пачка правок ячеек ОДНОЙ записью истории.

        Вставка/перенос на карте Uprising трогает десятки ячеек: раньше
        каждая шла отдельным /api/edit (своя запись, свой undo-шаг + гонка
        параллельных правок одного файла). Теперь вся команда — один шаг
        отмены и один запрос."""
        data = request.get_json(silent=True) or {}
        path = store.normal(data.get("path", ""))
        s = store.get(path)
        cells = data.get("cells") or []
        if not isinstance(cells, list) or not cells:
            return jsonify({"ok": False, "error": "no cells"})
        if len(cells) > 2000:
            return jsonify({"ok": False, "error": "too many"})
        names = s.worksheet.column_names()
        done = []
        for ce in cells:
            if not isinstance(ce, dict):
                continue
            try:
                row = int(ce.get("row", -1))
                col = int(ce.get("col", -1))
            except (TypeError, ValueError):
                continue
            if not (0 <= row < len(s.worksheet.rows)):
                continue
            if not (0 <= col < len(names)):
                continue
            res = s.edit_cell(row, col, ce.get("value", ""), ce.get("type"))
            if res["ok"] and res.get("payload"):
                done.append(res["payload"])
        if not done:
            return jsonify({"ok": True, "changed": False, "n": 0,
                            **hist.flags(s.path)})
        first = done[0]
        rowkey = hist.short_val(s.worksheet.rows[first["r"]].cell_value(0), 24) \
            or ("r%d" % first["r"])
        colname = names[first["c"]] if 0 <= first["c"] < len(names) \
            else "c%d" % first["c"]
        if len(done) == 1:
            summary = "%s %s: %s -> %s" % (
                rowkey, colname, hist.short_val(first["o"]), hist.short_val(first["n"]))
        else:
            summary = "%s %s (+%d)" % (rowkey, colname, len(done) - 1)
        # фронт может дать готовую подпись (напр. «замена 'a' → 'b' (N)»):
        # вся пачка всё равно пишется одной записью
        try:
            custom = str(data.get("summary") or "").strip()
        except Exception:  # noqa: BLE001
            custom = ""
        if custom:
            summary = custom[:160]
        db.log_change(s.path, "edit_cells", {"cells": done}, summary)
        saved = saves.autosaved(data, s, None)
        saves.mark_dirty(s, saved)
        return jsonify({"ok": True, "changed": True, "n": len(done),
                        "saved": saved, **hist.flags(s.path)})

    @app.route("/api/add_row", methods=["POST"])
    def api_add_row():
        data = request.get_json(silent=True) or {}
        s = store.get(data.get("path", ""))
        res = s.add_row(data.get("values"))
        if res.get("ok"):
            db.log_change(s.path, "add_row", res["payload"],
                          "row added (%d)" % (res["row"] + 1))
            saved = saves.autosaved(data, s, None)
            saves.mark_dirty(s, saved)
        return jsonify({**res, "saved": res.get("ok") and saved, **hist.flags(s.path)})

    @app.route("/api/delete_row", methods=["POST"])
    def api_delete_row():
        data = request.get_json(silent=True) or {}
        s = store.get(data.get("path", ""))
        row = int(data.get("row", -1))
        res = s.delete_row(row)
        if res.get("ok"):
            db.log_change(s.path, "del_row", res["payload"], "row deleted (r%d)" % row)
            saved = saves.autosaved(data, s, None)
            saves.mark_dirty(s, saved)
        return jsonify({**res, "saved": res.get("ok") and saved, **hist.flags(s.path)})

    @app.route("/api/add_column", methods=["POST"])
    def api_add_column():
        data = request.get_json(silent=True) or {}
        s = store.get(data.get("path", ""))
        name = data.get("name", "new")
        res = s.add_column(name)
        if res.get("ok"):
            db.log_change(s.path, "add_col", res["payload"], "column added: %s" % name)
            saved = saves.autosaved(data, s, None)
            saves.mark_dirty(s, saved)
        return jsonify({**res, "saved": res.get("ok") and saved, **hist.flags(s.path)})

    @app.route("/api/delete_column", methods=["POST"])
    def api_delete_column():
        data = request.get_json(silent=True) or {}
        s = store.get(data.get("path", ""))
        col = int(data.get("col", -1))
        res = s.delete_column(col)
        if res.get("ok"):
            db.log_change(s.path, "del_col", res["payload"], "column deleted (c%d)" % col)
            saved = saves.autosaved(data, s, None)
            saves.mark_dirty(s, saved)
        return jsonify({**res, "saved": res.get("ok") and saved, **hist.flags(s.path)})

    # -- edited-files marks (configs/markers.json, секции) --------
    # (owned by SavePipeline: saves.mark_edited / remove_edited_mark)

    # -- защита распакованной игры ------------------------------------------
    # (owned by Guard: guard.roots / guard.guarded)

    @app.route("/api/guard_check", methods=["POST"])
    def api_guard_check():
        """Защищён ли путь + куда можно сохранить (имена проекта/мода)."""
        data = request.get_json(silent=True) or {}
        g = guard.roots()
        proj = g["project"] if g["project"] and g["project"] != "." \
            and os.path.isdir(g["project"]) else ""
        mod = g["mod"] if g["mod"] and g["mod"] != "." \
            and os.path.isdir(g["mod"]) else ""
        return jsonify({
            "ok": True,
            "guarded": guard.guarded(data.get("path", "")),
            "project": {"root": proj, "name": os.path.basename(proj)} if proj else None,
            "mod": {"root": mod, "name": os.path.basename(mod)} if mod else None,
        })

    @app.route("/api/save", methods=["POST"])
    def api_save():
        data = request.get_json(silent=True) or {}
        path = store.normal(data.get("path", ""))
        s = store.get(path)
        res = saves.safe_save(s)
        return jsonify(res)
