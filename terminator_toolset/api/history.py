"""History routes: undo/redo cursor, journal listing, wipe."""
from __future__ import annotations

import os

from flask import jsonify, request

from ..domain.spreadsheet_ml import SpreadsheetError


def register_history(app, ctx):
    """Undo/redo, history payload, clear."""
    store, hist, db, files = ctx.store, ctx.hist, ctx.db, ctx.files

    def _file_top(path, undone):
        """Top file_write record for this direction (whole-file writers:
        swt, configs, presets, randomizer modes, preview configs)."""
        _entries, applied, undone_recs = hist.state(path)
        pool = undone_recs if undone else applied
        if not pool:
            return None
        rec = pool[-1] if undone else pool[0]
        if rec is not None and rec.get("action") == "file_write":
            return rec
        return None

    # -- API: history / undo / redo ----------------------------------------------
    @app.route("/api/undo", methods=["POST"])
    def api_undo():
        """Undo exactly ONE recorded change (a fast cell/row/column patch)."""
        data = request.get_json(silent=True) or {}
        path = store.normal(data.get("path", ""))
        if not path or not os.path.isfile(path):
            return jsonify({"ok": False, "error": "not a file"})
        try:
            rec = _file_top(path, False)
            if rec is not None:
                patch = files.apply_file_record(path, rec, False)
                db.set_undone(rec["id"], True)
                return jsonify({"ok": True, "patch": patch,
                                "summary": rec.get("summary"),
                                **hist.flags(path)})
            s = store.get(path)
            patch, target = hist.undo_once(s)
        except SpreadsheetError as e:
            return jsonify({"ok": False, "error": str(e)})
        if target is None:
            return jsonify({"ok": False, "error": "nothing_to_undo",
                            **hist.flags(path)})
        return jsonify({"ok": True, "patch": patch,
                        "summary": target.get("summary"), **hist.flags(path)})

    @app.route("/api/redo", methods=["POST"])
    def api_redo():
        """Re-apply exactly ONE undone change."""
        data = request.get_json(silent=True) or {}
        path = store.normal(data.get("path", ""))
        if not path or not os.path.isfile(path):
            return jsonify({"ok": False, "error": "not a file"})
        try:
            rec = _file_top(path, True)
            if rec is not None:
                patch = files.apply_file_record(path, rec, True)
                db.set_undone(rec["id"], False)
                return jsonify({"ok": True, "patch": patch, **hist.flags(path)})
            s = store.get(path)
            patch, _rec = hist.redo_once(s)
        except SpreadsheetError as e:
            return jsonify({"ok": False, "error": str(e)})
        if patch is None:
            return jsonify({"ok": False, "error": "nothing_to_redo",
                            **hist.flags(path)})
        return jsonify({"ok": True, "patch": patch, **hist.flags(path)})

    @app.route("/api/history")
    def api_history():
        path = store.normal(request.args.get("path", ""))
        entries, _applied, _undone = hist.state(path)
        base = os.path.basename(path)
        records = [{"id": e["id"], "ts": e["ts"], "action": e["action"],
                    "summary": e["summary"], "payload": e["payload"], "file": base,
                    "undone": bool(e["undone"])}
                   for e in entries]
        return jsonify({"ok": True, "records": records, **hist.flags(path)})

    @app.route("/api/clear_history", methods=["POST"])
    def api_clear_history():
        """Delete every history record for one file (no undo)."""
        data = request.get_json(silent=True) or {}
        path = store.normal(data.get("path", ""))
        if not path or not os.path.isfile(path):
            return jsonify({"ok": False, "error": "not a file"})
        db.clear_history(path)
        return jsonify({"ok": True, "can_undo": False, "can_redo": False})
