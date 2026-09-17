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

    def _apply_top(path, forward):
        """Apply the newest applied (undo) or oldest undone (redo) record
        of one file, grid diff or whole-file byte swap alike.
        Returns (patch, record) or (None, None)."""
        rec = _file_top(path, not forward)
        if rec is not None:
            patch = files.apply_file_record(path, rec, forward)
            db.set_undone(rec["id"], not forward)
            return patch, rec
        s = store.get(path)
        if forward:
            patch, rec = hist.redo_once(s)
        else:
            patch, rec = hist.undo_once(s)
        return patch, rec

    def _flags_many(paths):
        out = {}
        for p in paths or []:
            try:
                out[p] = hist.flags(p)
            except Exception:  # noqa: BLE001
                out[p] = {"can_undo": False, "can_redo": False}
        return out

    def _page_top(paths, undone, hint, prefer=""):
        """Pick the file to undo/redo across a page: the redo hint first
        (redo walks back where the last undo came from), then the focus file
        (the side the user last touched — a click without edits must not
        bury the other side's undo), else the newest record top (ts, id) —
        one deterministic server-side pick instead of N client fetches
        plus a fetch-apply race."""
        cands = []
        for p in paths or []:
            try:
                entries, applied, undone_recs = hist.state(p)
            except Exception:  # noqa: BLE001
                continue
            pool = undone_recs if undone else applied
            if not pool:
                continue
            top = pool[-1] if undone else pool[0]
            cands.append((p, top))
        if not cands:
            return None, None
        if undone and hint:
            for p, top in cands:
                if p == hint:
                    return p, top
        if prefer:
            for p, top in cands:
                if p == prefer:
                    return p, top
        cands.sort(key=lambda t: (t[1].get("ts") or 0, t[1].get("id") or 0),
                   reverse=True)
        return cands[0]

    # -- API: history / undo / redo ----------------------------------------------
    @app.route("/api/undo", methods=["POST"])
    def api_undo():
        """Undo exactly ONE recorded change (a fast cell/row/column patch)."""
        data = request.get_json(silent=True) or {}
        path = store.normal(data.get("path", ""))
        if not path or not os.path.isfile(path):
            return jsonify({"ok": False, "error": "not a file"})
        try:
            patch, target = _apply_top(path, False)
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
            patch, _rec = _apply_top(path, True)
        except SpreadsheetError as e:
            return jsonify({"ok": False, "error": str(e)})
        if patch is None:
            return jsonify({"ok": False, "error": "nothing_to_redo",
                            **hist.flags(path)})
        return jsonify({"ok": True, "patch": patch, **hist.flags(path)})

    # -- API: multi-file page undo/redo + batch flags ---------------------------
    @app.route("/api/history_flags", methods=["POST"])
    def api_history_flags():
        """Undo/redo button state for many files in one round-trip
        (page routers used to fan out one GET per file per click)."""
        data = request.get_json(silent=True) or {}
        paths = [store.normal(p or "") for p in (data.get("paths") or [])]
        paths = [p for p in paths if p and os.path.isfile(p)]
        return jsonify({"ok": True, "flags": _flags_many(paths)})

    def _page_endpoint(forward):
        data = request.get_json(silent=True) or {}
        raw = data.get("paths") or []
        hint = store.normal(data.get("hint") or "")
        prefer = store.normal(data.get("prefer") or "")
        paths = [store.normal(p or "") for p in raw]
        paths = [p for p in paths if p and os.path.isfile(p)]
        if not paths:
            return jsonify({"ok": False, "error": "no_file", "flags": {}})
        try:
            picked, _top = _page_top(paths, forward,
                                     hint if forward else "", prefer)
            if picked is None:
                return jsonify({"ok": False,
                                "error": "nothing_to_redo" if forward
                                else "nothing_to_undo",
                                "flags": _flags_many(paths)})
            patch, rec = _apply_top(picked, forward)
        except SpreadsheetError as e:
            return jsonify({"ok": False, "error": str(e),
                            "flags": _flags_many(paths)})
        if rec is None:
            return jsonify({"ok": False,
                            "error": "nothing_to_redo" if forward
                            else "nothing_to_undo",
                            "flags": _flags_many(paths)})
        return jsonify({"ok": True, "path": picked, "patch": patch,
                        "summary": rec.get("summary"),
                        "flags": _flags_many(paths)})

    @app.route("/api/page_undo", methods=["POST"])
    def api_page_undo():
        """One click across a page's files: the server picks the file with
        the newest applied record (redo hint wins for redo) and applies
        exactly one step. Button flags for every page file ride along."""
        return _page_endpoint(False)

    @app.route("/api/page_redo", methods=["POST"])
    def api_page_redo():
        """Re-apply one undone step across a page's files (see page_undo)."""
        return _page_endpoint(True)

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
