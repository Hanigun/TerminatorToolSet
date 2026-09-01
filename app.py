"""Flask backend for Terminator Sheet.

Exposes a small JSON API the browser grid calls. All the real work happens on
the python side; the JS frontend is pure UI.
"""
from __future__ import annotations

import collections
import json
import os
import re
import shutil
import subprocess
import threading
import time
from typing import Optional

from flask import Flask, render_template, request, jsonify, send_from_directory

from spreadsheet_ml import SpreadsheetML, SpreadsheetError
import spreadsheet_ml as spreadsheet_ml_mod
from xmlgrid import Session
from project import Project
from database import Database
from config import Config
from i18n import I18n
import links as links_mod
import comparator as comp_mod

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

_TREE_SKIP_DIRS = {".git", "__pycache__", ".codebase-memory", ".codegraph",
                   "node_modules", "$recycle.bin", "system volume information"}


def _walk_tree(d: str) -> dict:
    """Recursive os.scandir walk -> compact nested tree
    {"n": name, "d": [subdirs], "f": [filenames]} (dirs first, both sorted)."""
    name = os.path.basename(d.rstrip("\\/")) or d
    dirs, files = [], []
    try:
        with os.scandir(d) as it:
            for e in it:
                try:
                    if e.is_symlink():
                        continue
                    if e.is_dir(follow_symlinks=False):
                        if e.name.lower() in _TREE_SKIP_DIRS:
                            continue
                        dirs.append(_walk_tree(e.path))
                    else:
                        files.append(e.name)
                except OSError:
                    continue
    except OSError:
        pass
    dirs.sort(key=lambda x: x["n"].lower())
    files.sort(key=str.lower)
    return {"n": name, "d": dirs, "f": files}


def create_app(config: Config, db: Database, base_dir: Optional[str] = None) -> Flask:
    _base = base_dir or BASE_DIR
    app = Flask(__name__,
                template_folder=os.path.join(_base, "templates"),
                static_folder=os.path.join(_base, "static"))
    app.config["JSON_AS_ASCII"] = False
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

    i18n = I18n(config.get("language", "ru"))
    sessions: "dict[str, Session]" = {}
    session_order: "list[str]" = []       # LRU: least recently used first
    dirty_sessions: "set[str]" = set()    # in-memory edits not yet saved to disk
    MAX_SESSIONS = 20
    project: Optional[Project] = None
    entity_map: dict = {}
    entity_map_lock = threading.Lock()
    _ent_snapshot: Optional[frozenset] = None
    entity_ready = threading.Event()
    entity_building = threading.Event()

    # -- helpers ------------------------------------------------------------
    def _normal(path_key: str) -> str:
        try:
            return os.path.normpath(path_key)
        except Exception:  # noqa: BLE001
            return path_key

    def _evict_sessions():
        """Cap in-memory sessions (LRU). Sessions with unsaved edits are kept."""
        while len(sessions) > MAX_SESSIONS:
            victim = next((p for p in session_order if p not in dirty_sessions), None)
            if victim is None:
                break  # all sessions dirty - keep them
            session_order.remove(victim)
            sessions.pop(victim, None)

    def _get_session(path_key: str) -> Session:
        pk = _normal(path_key)
        s = sessions.get(pk)
        if s is not None:
            if pk in session_order:
                session_order.remove(pk)
            session_order.append(pk)
            return s
        d = SpreadsheetML()
        d.load(pk)
        s = Session(d, 0)
        sessions[pk] = s
        session_order.append(pk)
        _evict_sessions()
        return s

    def _project_paths() -> list:
        """Absolute paths of every indexed project file (empty when no project)."""
        if project is None or not project.files:
            return []
        return [f.path for f in project.files]

    def _minimal_grid(path: str) -> dict:
        """Streaming iterparse of the first worksheet -> logical row values.

        Skips the header row (matches Session.grid() rows semantics); honours
        sparse ss:Index cell positions without building the full lxml tree.
        """
        rows = [{"values": v} for v in spreadsheet_ml_mod.iter_rows_logical(
            path, skip_header=True)]
        return {"rows": rows, "sheet_index": 0}

    def _mtime(path: str):
        try:
            return os.path.getmtime(path)
        except OSError:
            return -1

    def _snapshot_key(paths: "list[str]") -> frozenset:
        return frozenset((p, _mtime(p)) for p in paths)

    def _snapshot_stale() -> bool:
        paths = _project_paths()
        if not paths:
            return False
        with entity_map_lock:
            return _snapshot_key(paths) != _ent_snapshot

    def _build_entity_map_bg():
        nonlocal entity_map, _ent_snapshot
        paths = _project_paths()
        if paths:
            new_map = links_mod.collect_entity_from_paths(paths, _minimal_grid)
            with entity_map_lock:
                entity_map = new_map
                _ent_snapshot = _snapshot_key(paths)
        entity_ready.set()

    def _kick_entity_rebuild():
        """Start a background entity-map build when the snapshot is stale."""
        if not _project_paths():
            entity_ready.set()
            return
        if entity_building.is_set():
            return
        if not _snapshot_stale():
            entity_ready.set()
            return
        entity_building.set()
        entity_ready.clear()

        def _worker():
            try:
                _build_entity_map_bg()
            except Exception:  # noqa: BLE001
                entity_ready.set()
            finally:
                entity_building.clear()

        threading.Thread(target=_worker, daemon=True, name="entity-map").start()

    def _rebuild_entity_map(open_session: Optional[Session] = None):
        """Project mode: ensure the background build is running (non-blocking).
        No project: build inline from currently open sessions."""
        nonlocal entity_map
        if _project_paths():
            _kick_entity_rebuild()
            return entity_map
        with entity_map_lock:
            with_db = {}
            for s in list(sessions.values()):
                with_db[s.path] = s
            entity_map = links_mod.collect_entity_map(with_db)
            return entity_map

    # -- pages ---------------------------------------------------------------
    @app.route("/")
    def index():
        build_id = str(int(time.time()))  # cache-busting for static assets
        return render_template("index.html", title=i18n.t("app_title"), v=build_id)

    @app.route("/locales/<lang>.json")
    def locales(lang):
        path = os.path.join(BASE_DIR, "locales", "%s.json" % lang)
        if os.path.isfile(path):
            return send_from_directory(os.path.join(BASE_DIR, "locales"), "%s.json" % lang)
        return jsonify({})

    @app.route("/assets/icons/<path:filename>")
    def icon_assets(filename):
        # file-format icons + faction/app logos (packed into assets/icons)
        return send_from_directory(os.path.join(_base, "assets", "icons"), filename)

    # -- API: config / i18n ---------------------------------------------------
    @app.route("/api/config")
    def api_config():
        return jsonify(config.data)

    @app.route("/api/config", methods=["POST"])
    def api_config_set():
        data = request.get_json(silent=True) or {}
        for k, v in data.items():
            if k in config.data or k in ("theme", "language", "fullscreen", "auto_save",
                                         "default_key_column", "window_width", "window_height"):
                config.set(k, v)
        if "language" in data:
            i18n.switch(config.get("language"))
        return jsonify({"ok": True})

    @app.route("/api/i18n")
    def api_i18n():
        return jsonify(i18n.list())

# -- API: project / files -------------------------------------------------
    @app.route("/api/open_project", methods=["POST"])
    def api_open_project():
        nonlocal project
        data = request.get_json(silent=True) or {}
        root = data.get("path", "")
        print(f"[API] open_project: received path={repr(root)}")
        if not root or not os.path.isdir(root):
            print(f"[API] open_project: NOT A FOLDER - exists={os.path.exists(root)}, isdir={os.path.isdir(root)}")
            return jsonify({"ok": False, "error": "not a folder"})
        project = Project()
        try:
            project.scan(root)
        except Exception as e:  # noqa: BLE001
            return jsonify({"ok": False, "error": str(e)})
        db.add_recent("project", root)
        config.set("last_project", root)
        _kick_entity_rebuild()   # start indexing in the background right away
        return jsonify({"ok": True,
                        "project": project.to_dict(config.get("language", "ru"))})

    @app.route("/api/close_project", methods=["POST"])
    def api_close_project():
        """Forget the loaded project: clear the tree source, the entity map,
        the auto-reopen pointer and the change history of all its files."""
        nonlocal project, entity_map, _ent_snapshot
        if project is not None and getattr(project, "files", None):
            for f in project.files:
                try:
                    db.clear_history(os.path.normpath(f.path))
                except Exception:  # noqa: BLE001
                    pass
        project = None
        with entity_map_lock:
            entity_map = {}
            _ent_snapshot = None
        config.set("last_project", "")
        return jsonify({"ok": True})

    @app.route("/api/project_tree")
    def api_project_tree():
        """Full folder/file tree of the OPEN project: everything on disk,
        any extension. The frontend filters what to display."""
        if project is None or not getattr(project, "root", None) \
                or not os.path.isdir(project.root):
            return jsonify({"ok": False, "error": "no project"})
        return jsonify({"ok": True, "root": project.root,
                        "tree": _walk_tree(project.root)})

    @app.route("/api/edited_marks")
    def api_edited_marks():
        """Absolute paths of the project files edited & saved by this app
        (read from <project_name>.json; empty when the marks file is absent)."""
        root = request.args.get("path", "")
        if not root or not os.path.isdir(root):
            return jsonify({"ok": False, "error": "not a folder"})
        data = _load_edited_marks(root)
        rootn = os.path.normpath(root)
        files = [os.path.normpath(os.path.join(rootn, rel)) for rel in data.get("files", [])]
        return jsonify({"ok": True, "files": files})

    @app.route("/api/edited_marks/clear", methods=["POST"])
    def api_edited_marks_clear():
        """Delete the marks file itself (the tiny broom button in the sidebar)."""
        root = (request.get_json(silent=True) or {}).get("path", "")
        if not root:
            return jsonify({"ok": False, "error": "no path"})
        p = _edited_marks_path(root)
        deleted = False
        if os.path.isfile(p):
            try:
                os.remove(p)
                deleted = True
            except Exception as e:  # noqa: BLE001
                return jsonify({"ok": False, "error": str(e)})
        return jsonify({"ok": True, "deleted": deleted})

    @app.route("/api/open_file", methods=["POST"])
    def api_open_file():
        data = request.get_json(silent=True) or {}
        path = data.get("path", "")
        print(f"[API] open_file: received path={repr(path)}")
        if not path or not os.path.isfile(path):
            print(f"[API] open_file: NOT A FILE - exists={os.path.exists(path)}, isfile={os.path.isfile(path)}")
            return jsonify({"ok": False, "error": "not a file"})
        pk = _normal(path)
        try:
            s = _get_session(path)
        except SpreadsheetError as e:
            return jsonify({"ok": False, "error": str(e)})
        db.add_recent("file", path)
        _rebuild_entity_map(s)
        return jsonify({"ok": True, "file": _file_payload(s), **_hist_flags(s.path)})

    @app.route("/api/file")
    def api_file():
        path = request.args.get("path", "")
        if not path or not os.path.isfile(path):
            return jsonify({"ok": False, "error": "not a file"})
        try:
            s = _get_session(path)
        except SpreadsheetError as e:
            return jsonify({"ok": False, "error": str(e)})
        return jsonify({"ok": True, **_file_payload(s)})

    def _file_payload(s: Session) -> dict:
        g = s.grid()
        return {
            "path": s.path,
            "sheet_index": s.sheet_index,
            "sheet_name": g["sheet_name"],
            "sheets": g["sheets"],
            "columns": g["columns"],
            "comments": g["comments"],
            "rows": g["rows"],
            "expanded_cols": g["expanded_cols"],
        }

    @app.route("/api/switch_sheet")
    def api_switch_sheet():
        path = request.args.get("path", "")
        idx = int(request.args.get("index", "0"))
        s = _get_session(path)
        s.switch_sheet(idx)
        return jsonify(_file_payload(s))

    # -- API: edits ------------------------------------------------------------
    def _short_val(v, n=24):
        """Truncate a value for the human-readable history summary."""
        t = str(v)
        return t if len(t) <= n else t[: n - 1] + "…"

    @app.route("/api/edit", methods=["POST"])
    def api_edit():
        data = request.get_json(silent=True) or {}
        path = _normal(data.get("path", ""))
        s = _get_session(path)
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
        rowkey = _short_val(s.worksheet.rows[row].cell_value(0), 24) or ("r%d" % row)
        summary = "%s %s: %s -> %s" % (rowkey, colname,
                                       _short_val(res["old"]), _short_val(data.get("value", "")))
        db.log_change(s.path, "edit", res["payload"], summary)
        saved = _autosaved(data, s, None)
        _mark_dirty(s, saved)
        return jsonify({"ok": True, "old": res["old"], "new": data.get("value", ""),
                        "saved": saved, **_hist_flags(s.path)})

    @app.route("/api/add_row", methods=["POST"])
    def api_add_row():
        data = request.get_json(silent=True) or {}
        s = _get_session(data.get("path", ""))
        res = s.add_row(data.get("values"))
        if res.get("ok"):
            db.log_change(s.path, "add_row", res["payload"],
                          "row added (%d)" % (res["row"] + 1))
            saved = _autosaved(data, s, None)
            _mark_dirty(s, saved)
        return jsonify({**res, "saved": res.get("ok") and saved, **_hist_flags(s.path)})

    @app.route("/api/delete_row", methods=["POST"])
    def api_delete_row():
        data = request.get_json(silent=True) or {}
        s = _get_session(data.get("path", ""))
        row = int(data.get("row", -1))
        res = s.delete_row(row)
        if res.get("ok"):
            db.log_change(s.path, "del_row", res["payload"], "row deleted (r%d)" % row)
            saved = _autosaved(data, s, None)
            _mark_dirty(s, saved)
        return jsonify({**res, "saved": res.get("ok") and saved, **_hist_flags(s.path)})

    @app.route("/api/add_column", methods=["POST"])
    def api_add_column():
        data = request.get_json(silent=True) or {}
        s = _get_session(data.get("path", ""))
        name = data.get("name", "new")
        res = s.add_column(name)
        if res.get("ok"):
            db.log_change(s.path, "add_col", res["payload"], "column added: %s" % name)
            saved = _autosaved(data, s, None)
            _mark_dirty(s, saved)
        return jsonify({**res, "saved": res.get("ok") and saved, **_hist_flags(s.path)})

    @app.route("/api/delete_column", methods=["POST"])
    def api_delete_column():
        data = request.get_json(silent=True) or {}
        s = _get_session(data.get("path", ""))
        col = int(data.get("col", -1))
        res = s.delete_column(col)
        if res.get("ok"):
            db.log_change(s.path, "del_col", res["payload"], "column deleted (c%d)" % col)
            saved = _autosaved(data, s, None)
            _mark_dirty(s, saved)
        return jsonify({**res, "saved": res.get("ok") and saved, **_hist_flags(s.path)})

    # -- edited-files marks (<project_name>.json next to config.json) --------
    def _edited_marks_path(root: str) -> str:
        name = os.path.basename(os.path.normpath(root or "")) or "project"
        safe = "".join(c for c in name if c not in '\\/:*?"<>|').strip() or "project"
        if safe.lower() == "config":          # never touch config.json itself
            safe = "config_project"
        return os.path.join(config.dir, safe + ".json")

    def _load_edited_marks(root: str) -> dict:
        p = _edited_marks_path(root)
        if os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                if isinstance(data, dict) and isinstance(data.get("files"), list):
                    return data
            except Exception:  # noqa: BLE001
                pass
        return {"project": os.path.normpath(root or ""), "files": []}

    def _mark_edited_file(path: str):
        """Record that a file of the OPEN project was edited & saved by us.
        The mark lives in <project_name>.json next to config.json (external
        data file, never packed into the exe) until the user clears it."""
        if project is None or not getattr(project, "root", None) or not path:
            return
        root = os.path.normpath(project.root)
        np = os.path.normpath(path)
        try:
            rel = os.path.relpath(np, root)
        except ValueError:
            return
        if rel.startswith(".."):              # file outside the project
            return
        data = _load_edited_marks(root)
        files = data.setdefault("files", [])
        if rel not in files:
            files.append(rel)
            data["project"] = root
            try:
                with open(_edited_marks_path(root), "w", encoding="utf-8") as fh:
                    json.dump(data, fh, ensure_ascii=False, indent=2)
            except Exception:  # noqa: BLE001
                pass

    def _safe_save(s: Session, summary: str = ""):
        """Write the in-memory document to disk (history is stored as diffs,
        so saving no longer copies the whole file into the database).
        An unchanged document is NOT rewritten and does NOT get an edit mark."""
        try:
            res = s.save()
            written = bool(res.get("written", True))
            dirty_sessions.discard(s.path)
            if written:
                _mark_edited_file(s.path)
            return {"ok": True, "saved": written}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def _autosaved(data: dict, s: Session, summary: str = "") -> bool:
        """Save when autosave is on; return True on a successful write."""
        if not _auto_save(data):
            return False
        return bool(_safe_save(s).get("ok"))

    def _mark_dirty(s: Session, saved: bool):
        """Track sessions with in-memory edits so LRU never evicts them."""
        if saved:
            dirty_sessions.discard(s.path)
        else:
            dirty_sessions.add(s.path)

    def _auto_save(data: dict) -> bool:
        if "save" in data:
            return bool(data.get("save"))
        return bool(config.get("auto_save", True))

    @app.route("/api/save", methods=["POST"])
    def api_save():
        data = request.get_json(silent=True) or {}
        path = _normal(data.get("path", ""))
        s = _get_session(path)
        res = _safe_save(s)
        return jsonify(res)

    # -- API: comparator ---------------------------------------------------------
    @app.route("/api/compare", methods=["POST"])
    def api_compare():
        data = request.get_json(silent=True) or {}
        left = _get_session(_normal(data.get("left", "")))
        right = _get_session(_normal(data.get("right", "")))
        key_col = int(data.get("key_col", 0))
        if key_col < 0:
            names = left.worksheet.column_names()
            default = data.get("default_key") or "sysname"
            key_col = names.index(default) if default in names else 0
        d = left.worksheet
        try:
            diff = comp_mod.compute_diff_named(left.worksheet, right.worksheet, key_col)
        except Exception as e:  # noqa: BLE001
            return jsonify({"ok": False, "error": str(e)})
        payload = []
        for dr in diff:
            payload.append({
                "key": dr.key,
                "status": dr.status,
                "left_index": dr.left_index,
                "right_index": dr.right_index,
                "changes": dr.changes,
            })

        def _rowvals(ws):
            n = ws.column_count()
            out = []
            for r in ws.rows:
                vals = [r.cell_value(c) for c in range(n)]
                while vals and vals[-1] == "":
                    vals.pop()
                out.append(vals)
            return out

        return jsonify({"ok": True, "diff": payload,
                        "left": left.path, "right": right.path,
                        "left_rows": _rowvals(left.worksheet),
                        "right_rows": _rowvals(right.worksheet),
                        "left_columns": left.worksheet.column_names(),
                        "right_columns": right.worksheet.column_names(),
                        "key_col": key_col,
                        **_hist_flags(left.path)})

    @app.route("/api/merge_all", methods=["POST"])
    def api_merge_all():
        """Merge mode: copy everything new/updated from the right (source)
        file into the left (base) file. Right wins on conflicts."""
        data = request.get_json(silent=True) or {}
        dst = _get_session(_normal(data.get("left", "")))
        src = _get_session(_normal(data.get("right", "")))
        key_col = int(data.get("key_col", 0))
        if key_col < 0:
            names = dst.worksheet.column_names()
            default = data.get("default_key") or "sysname"
            key_col = names.index(default) if default in names else 0
        dws = dst.worksheet
        sws = src.worksheet
        col_map = comp_mod.full_col_map(sws, dws, key_col)  # dst col -> src col
        src_idx = comp_mod._key_index(sws, key_col)
        dst_keys = {r.cell_value(key_col).strip() for r in dws.rows}
        created = updated = 0
        try:
            # 1) rows missing on the left -> append from the right
            for key, sri in src_idx.items():
                if key in dst_keys:
                    continue
                dst_row_i, _cr = comp_mod.transfer_row(sws, dws, sri, key_col, col_map)
                created += 1
                after = dws.row_payload(dws.rows[dst_row_i])
                after_ri = dws.row_index_attr(dws.rows[dst_row_i])
                db.log_change(dst.path, "row_set",
                              {"r": dst_row_i, "existed": False, "ri_o": None,
                               "cells_o": [], "ri_n": after_ri, "cells_n": after},
                              "row %s created (merge)" % key)
            # 2) rows present on both -> right wins per mapped column
            for dri, drow in enumerate(dws.rows):
                key = drow.cell_value(key_col).strip()
                if not key or key not in src_idx:
                    continue
                srow = sws.rows[src_idx[key]]
                before = dws.row_payload(drow)
                before_ri = dws.row_index_attr(drow)
                changed = False
                for dcol, scol in col_map.items():
                    sv = srow.cell_value(scol)
                    if drow.cell_value(dcol) != sv:
                        stype = srow.cells[scol].type if scol < len(srow.cells) else None
                        drow.set_cell_value(dcol, sv, stype)
                        changed = True
                if changed:
                    updated += 1
                    after = dws.row_payload(drow)
                    after_ri = dws.row_index_attr(drow)
                    db.log_change(dst.path, "row_set",
                                  {"r": dri, "existed": True, "ri_o": before_ri,
                                   "cells_o": before, "ri_n": after_ri, "cells_n": after},
                                  "row %s updated (merge)" % key)
        except Exception as e:  # noqa: BLE001
            return jsonify({"ok": False, "error": str(e)})
        if config.get("auto_save", True):
            _safe_save(dst)
        return jsonify({"ok": True, "created": created, "updated": updated,
                        **_hist_flags(dst.path)})

    @app.route("/api/list_xml", methods=["POST"])
    def api_list_xml():
        """List .xml files under a folder (for the compare page path pickers)."""
        data = request.get_json(silent=True) or {}
        root = data.get("path", "")
        if not root or not os.path.isdir(root):
            return jsonify({"ok": False, "error": "not a folder"})
        root_abs = os.path.abspath(root)
        base_depth = root_abs.rstrip(os.sep).count(os.sep)
        found: "list[str]" = []
        for dirpath, dirnames, filenames in os.walk(root_abs):
            dirnames[:] = [d for d in dirnames
                           if not d.startswith(".") and d != "__pycache__"]
            if dirpath.count(os.sep) - base_depth > 5:
                dirnames[:] = []
                continue
            for fn in filenames:
                if fn.lower().endswith(".xml"):
                    found.append(os.path.relpath(os.path.join(dirpath, fn), root_abs))
            if len(found) >= 4000:
                break
        found.sort()
        return jsonify({"ok": True, "files": found})

    @app.route("/api/transfer_row", methods=["POST"])
    def api_transfer_row():
        data = request.get_json(silent=True) or {}
        src = _get_session(_normal(data.get("src", "")))
        dst = _get_session(_normal(data.get("dst", "")))
        src_row = int(data.get("row", -1))
        key_col = int(data.get("key_col", 0))
        col_map_data = data.get("col_map") or {}
        col_map = {int(k): int(v) for k, v in col_map_data.items()}
        if not col_map:
            col_map = comp_mod.full_col_map(src.worksheet, dst.worksheet, key_col)
        dws = dst.worksheet
        pre_payloads = [dws.row_payload(r) for r in dws.rows]
        pre_ri = [dws.row_index_attr(r) for r in dws.rows]
        dst_row, created = comp_mod.transfer_row(src.worksheet, dst.worksheet, src_row,
                                                 max(key_col, 0), col_map)
        existed = not created and 0 <= dst_row < len(pre_payloads)
        before = pre_payloads[dst_row] if existed else []
        before_ri = pre_ri[dst_row] if existed else None
        after = dws.row_payload(dws.rows[dst_row])
        after_ri = dws.row_index_attr(dws.rows[dst_row])
        db.log_change(dst.path, "row_set",
                      {"r": dst_row, "existed": existed,
                       "ri_o": before_ri, "cells_o": before,
                       "ri_n": after_ri, "cells_n": after},
                      "row %s (r%d)" % ("created" if created else "transferred", dst_row))
        if config.get("auto_save", True):
            _safe_save(dst)
        return jsonify({"ok": True, "dst_row": dst_row, "created": created,
                        **_hist_flags(dst.path)})

    @app.route("/api/transfer_column", methods=["POST"])
    def api_transfer_column():
        data = request.get_json(silent=True) or {}
        src = _get_session(_normal(data.get("src", "")))
        dst = _get_session(_normal(data.get("dst", "")))
        src_col = int(data.get("src_col", -1))
        dst_col = int(data.get("dst_col", -1))
        key_col = int(data.get("key_col", 0))
        dws = dst.worksheet
        existed = 0 <= dst_col < dws.column_count()
        if existed:
            col1 = dst_col + 1
            name_o = dws.column_names()[dst_col]
            cells_o = {}
            for i, r in enumerate(dws.rows):
                c = r.cell_by_logical(col1)
                if c is not None:
                    cells_o[i] = [c.value, dws.cell_type(c)]
        else:
            name_o, cells_o = "", {}
        try:
            dst_col = comp_mod.transfer_column(src.worksheet, dst.worksheet,
                                               src_col, dst_col, max(key_col, 0))
        except Exception as e:  # noqa: BLE001
            return jsonify({"ok": False, "error": str(e)})
        col1 = dst_col + 1
        name_n = dws.column_names()[dst_col]
        cells_n = {}
        for i, r in enumerate(dws.rows):
            c = r.cell_by_logical(col1)
            if c is not None:
                cells_n[i] = [c.value, dws.cell_type(c)]
        db.log_change(dst.path, "col_set",
                      {"c": dst_col, "existed": existed,
                       "name_o": name_o, "cells_o": cells_o,
                       "name_n": name_n, "cells_n": cells_n},
                      "column transferred (c%d)" % dst_col)
        if config.get("auto_save", True):
            _safe_save(dst)
        return jsonify({"ok": True, "dst_col": dst_col, **_hist_flags(dst.path)})

    # -- API: history / undo / redo ----------------------------------------------
    def _hist_state(path: str):
        """(journal newest-first, applied records, undone records).

        The journal is a linear timeline; undone records (all newer than the
        cursor) are the redoable future, applied ones are the past."""
        entries = db.history_for(path)
        applied = [e for e in entries if not e["undone"]]
        undone = [e for e in entries if e["undone"]]
        return entries, applied, undone

    def _hist_flags(path: str) -> dict:
        _, applied, _undone = _hist_state(path)
        return {"can_undo": bool(applied), "can_redo": bool(_undone)}

    def _undo_once(s: Session, save: bool = True):
        """Revert the newest applied change (mark it undone + apply the
        inverse diff). Returns (client patch, record) or (None, None)."""
        _entries, applied, _undone = _hist_state(s.path)
        if not applied:
            return None, None
        target = applied[0]
        patch = s.apply_history_op(target["action"], target["payload"], forward=False)
        db.set_undone(target["id"], True)
        if save:
            s.save()
        dirty_sessions.discard(s.path)
        return patch, target

    def _redo_once(s: Session, save: bool = True):
        """Re-apply the oldest undone change (redo walks the timeline forward).
        Returns (client patch, record)."""
        _entries, _applied, undone = _hist_state(s.path)
        if not undone:
            return None, None
        rec = undone[-1]   # journal is newest-first: the oldest undone is last
        patch = s.apply_history_op(rec["action"], rec["payload"], forward=True)
        db.set_undone(rec["id"], False)
        if save:
            s.save()
        dirty_sessions.discard(s.path)
        return patch, rec

    def _hist_error(error: str, path: str):
        return jsonify({"ok": False, "error": error, **_hist_flags(path)})

    @app.route("/api/undo", methods=["POST"])
    def api_undo():
        """Undo exactly ONE recorded change (a fast cell/row/column patch)."""
        data = request.get_json(silent=True) or {}
        path = _normal(data.get("path", ""))
        if not path or not os.path.isfile(path):
            return jsonify({"ok": False, "error": "not a file"})
        try:
            s = _get_session(path)
            patch, target = _undo_once(s)
        except SpreadsheetError as e:
            return jsonify({"ok": False, "error": str(e)})
        if target is None:
            return _hist_error("nothing_to_undo", path)
        return jsonify({"ok": True, "patch": patch,
                        "summary": target.get("summary"), **_hist_flags(path)})

    @app.route("/api/redo", methods=["POST"])
    def api_redo():
        """Re-apply exactly ONE undone change."""
        data = request.get_json(silent=True) or {}
        path = _normal(data.get("path", ""))
        if not path or not os.path.isfile(path):
            return jsonify({"ok": False, "error": "not a file"})
        try:
            s = _get_session(path)
            patch, _rec = _redo_once(s)
        except SpreadsheetError as e:
            return jsonify({"ok": False, "error": str(e)})
        if patch is None:
            return _hist_error("nothing_to_redo", path)
        return jsonify({"ok": True, "patch": patch, **_hist_flags(path)})

    @app.route("/api/history")
    def api_history():
        path = _normal(request.args.get("path", ""))
        entries, _applied, _undone = _hist_state(path)
        base = os.path.basename(path)
        records = [{"id": e["id"], "ts": e["ts"], "action": e["action"],
                    "summary": e["summary"], "payload": e["payload"], "file": base,
                    "undone": bool(e["undone"])}
                   for e in entries]
        return jsonify({"ok": True, "records": records, **_hist_flags(path)})

    @app.route("/api/clear_history", methods=["POST"])
    def api_clear_history():
        """Delete every history record for one file (no undo)."""
        data = request.get_json(silent=True) or {}
        path = _normal(data.get("path", ""))
        if not path or not os.path.isfile(path):
            return jsonify({"ok": False, "error": "not a file"})
        db.clear_history(path)
        return jsonify({"ok": True, "can_undo": False, "can_redo": False})

    @app.route("/api/restore", methods=["POST"])
    def api_restore():
        """Move the file to the state recorded by one journal entry.

        Reverting to a past record undoes every newer change; 'reverting' to
        an undone record redoes the steps up to it. Moves the cursor only -
        records themselves are never created or destroyed."""
        data = request.get_json(silent=True) or {}
        rec_id = int(data.get("backup_id", -1))
        path = _normal(data.get("path", ""))
        if not path or not os.path.isfile(path):
            return jsonify({"ok": False, "error": "not a file"})
        entries, _applied, _undone = _hist_state(path)
        idx = next((i for i, e in enumerate(entries) if e["id"] == rec_id), -1)
        if idx < 0:
            return jsonify({"ok": False, "error": "record not found"})
        try:
            s = _get_session(path)
            # records newer than the target that are still applied -> undo
            for e in entries[:idx]:
                if not e["undone"]:
                    _undo_once(s, save=False)
            # records at/older than the target still undone -> redo (oldest first)
            for e in reversed(entries[idx:]):
                if e["undone"]:
                    _redo_once(s, save=False)
            s.save()
        except SpreadsheetError as e:
            return jsonify({"ok": False, "error": str(e)})
        dirty_sessions.discard(s.path)
        return jsonify({"ok": True, "reload": True, **_hist_flags(path)})

    @app.route("/api/reveal", methods=["POST"])
    def api_reveal():
        """Show a file in Explorer (select) or open a folder."""
        data = request.get_json(silent=True) or {}
        path = data.get("path", "")
        if not path or not os.path.exists(path):
            return jsonify({"ok": False, "error": "not found"})
        try:
            if os.path.isdir(path):
                os.startfile(path)  # noqa: S606
            else:
                subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])  # noqa: S603,S607
            return jsonify({"ok": True})
        except Exception as e:  # noqa: BLE001
            return jsonify({"ok": False, "error": str(e)})

    # ---------- create mod ----------

    @app.route("/api/game_dir", methods=["GET", "POST"])
    def api_game_dir():
        """Store / return the game installation folder (config key game_dir)."""
        if request.method == "POST":
            data = request.get_json(silent=True) or {}
            path = (data.get("path") or "").strip()
            if not path or not os.path.isdir(path):
                return jsonify({"ok": False, "error": "not a folder"})
            config.set("game_dir", os.path.normpath(path))
        gd = config.get("game_dir", "")
        return jsonify({
            "ok": True,
            "game_dir": gd,
            "has_mods": bool(gd) and os.path.isdir(os.path.join(gd, "mods")),
        })

    @app.route("/api/icon_preview")
    def api_icon_preview():
        """Serve a picked image so the form can preview it."""
        from flask import send_file
        p = request.args.get("p", "")
        if not p or not os.path.isfile(p):
            return jsonify({"ok": False, "error": "not found"})
        try:
            return send_file(p)
        except Exception as e:  # noqa: BLE001
            return jsonify({"ok": False, "error": str(e)})

    def _copy_files_into(mod_dir, files):
        """Copy dragged files into the mod folder, recreating the folder
        structure. files = [{"path": abs, "rel": rel-from-project-root}]."""
        copied, skipped = [], []
        for item in files or []:
            src = (item.get("path") or "").strip()
            rel = (item.get("rel") or "").strip()
            if not src or not os.path.isfile(src):
                skipped.append(os.path.basename(src) if src else "?")
                continue
            # sanitize the relative path: no drives, no traversal
            rel = rel.replace("\\", "/").strip("/")
            parts = [p for p in rel.split("/") if p and p not in (".", "..")
                     and ":" not in p]
            if not parts:
                parts = ["basis", "scripts", os.path.basename(src)]
            dest = os.path.join(mod_dir, *parts)
            try:
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                shutil.copy2(src, dest)
                copied.append("/".join(parts))
            except Exception:  # noqa: BLE001
                skipped.append(os.path.basename(src))
        return copied, skipped

    @app.route("/api/create_mod", methods=["POST"])
    def api_create_mod():
        """Create <game>/mods/<Name>/ with mod.json (+ optional thumbnail).

        Follows the official mod guide: latin folder name, mod.json with
        name / description / icon, icon preferably in basis/ as a dds.
        """
        data = request.get_json(silent=True) or {}
        name = (data.get("name") or "").strip()
        desc = data.get("description") or ""
        icon = (data.get("icon") or "").strip()
        files = data.get("files") or []
        gd = config.get("game_dir", "")
        if not gd or not os.path.isdir(gd):
            return jsonify({"ok": False, "error": "no game dir"})
        if not name:
            return jsonify({"ok": False, "error": "no name"})
        # the guide asks for a latin-only folder name (no special chars)
        safe = "".join(c for c in name if (c.isascii() and (c.isalnum() or c in " _-"))).strip()
        if not safe:
            return jsonify({"ok": False, "error": "bad name"})
        mods = os.path.join(gd, "mods")
        mod_dir = os.path.join(mods, safe)
        if os.path.exists(mod_dir):
            return jsonify({"ok": False, "error": "exists", "path": mod_dir})
        try:
            os.makedirs(os.path.join(mod_dir, "basis"), exist_ok=True)

            icon_rel = ""
            if icon and os.path.isfile(icon):
                ext = os.path.splitext(icon)[1].lower()
                dest = os.path.join(mod_dir, "basis", "THUMBNAIL.dds")
                made_dds = False
                if ext != ".dds":
                    try:
                        from PIL import Image
                        img = Image.open(icon).convert("RGBA")
                        # normalize to 16:9 (guide requirement), 512x288
                        tw, th = 512, 288
                        sw, sh = img.size
                        scale = min(tw / sw, th / sh)
                        nw, nh = max(1, int(sw * scale)), max(1, int(sh * scale))
                        img = img.resize((nw, nh))
                        canvas = Image.new("RGBA", (tw, th), (0, 0, 0, 255))
                        canvas.paste(img, ((tw - nw) // 2, (th - nh) // 2))
                        canvas.save(dest, format="DDS")
                        made_dds = True
                    except Exception:  # noqa: BLE001 - Pillow missing / bad image
                        made_dds = False
                if not made_dds:
                    if ext == ".dds":
                        dest = os.path.join(mod_dir, "basis", "THUMBNAIL.dds")
                        with open(icon, "rb") as src, open(dest, "wb") as out:
                            out.write(src.read())
                        made_dds = True
                    else:
                        # keep the original file and reference it as-is
                        fname = "THUMBNAIL" + ext
                        dest = os.path.join(mod_dir, "basis", fname)
                        with open(icon, "rb") as src, open(dest, "wb") as out:
                            out.write(src.read())
                if os.path.isfile(dest):
                    icon_rel = "basis/" + os.path.basename(dest)

            mod_json = {
                "name": name,
                "description": desc.replace("\r\n", "\n"),
                "icon": icon_rel,
            }
            with open(os.path.join(mod_dir, "mod.json"), "w", encoding="utf-8") as f:
                json.dump(mod_json, f, ensure_ascii=False, indent=4)
            copied, skipped = _copy_files_into(mod_dir, files)
            return jsonify({"ok": True, "path": mod_dir,
                            "copied": copied, "skipped": skipped})
        except Exception as e:  # noqa: BLE001
            return jsonify({"ok": False, "error": str(e)})

    @app.route("/api/list_mods", methods=["GET"])
    def api_list_mods():
        """Existing mod folders under <game>/mods."""
        gd = config.get("game_dir", "")
        mods = os.path.join(gd, "mods") if gd else ""
        out = []
        if mods and os.path.isdir(mods):
            for n in sorted(os.listdir(mods)):
                if os.path.isdir(os.path.join(mods, n)):
                    out.append(n)
        return jsonify({"ok": True, "mods": out})

    @app.route("/api/copy_mod_files", methods=["POST"])
    def api_copy_mod_files():
        """Copy dragged files into an existing mod, recreating structure."""
        data = request.get_json(silent=True) or {}
        mod = (data.get("mod") or "").strip()
        gd = config.get("game_dir", "")
        if not gd or not os.path.isdir(gd):
            return jsonify({"ok": False, "error": "no game dir"})
        mod_dir = os.path.normpath(os.path.join(gd, "mods", mod))
        mods_root = os.path.normpath(os.path.join(gd, "mods"))
        if (not mod or not mod_dir.startswith(mods_root + os.sep)
                or not os.path.isdir(mod_dir)):
            return jsonify({"ok": False, "error": "no such mod"})
        copied, skipped = _copy_files_into(mod_dir, data.get("files") or [])
        return jsonify({"ok": True, "path": mod_dir,
                        "copied": copied, "skipped": skipped})


    @app.route("/api/recents")
    def api_recents():
        out = []
        for r in db.recents():
            d = dict(r)
            p = d.get("path", "")
            try:
                st = os.stat(p)
                d["exists"] = True
                d["mtime"] = st.st_mtime
                d["size"] = st.st_size if os.path.isfile(p) else None
            except OSError:
                d["exists"] = False
            out.append(d)
        return jsonify(out)

    @app.route("/api/recents/clear", methods=["POST"])
    def api_recents_clear():
        db.clear_recents()
        return jsonify({"ok": True})

    @app.route("/api/links")
    def api_links():
        path = request.args.get("path", "")
        try:
            s = sessions.get(_normal(path)) or _get_session(path)
        except Exception:  # noqa: BLE001
            return jsonify({"ok": False, "error": "open file first"})
        _rebuild_entity_map(s)
        if _project_paths() and not entity_ready.wait(15):
            # background index still building - report pending, frontend retries
            return jsonify({"ok": True, "links": [], "pending": True})
        with entity_map_lock:
            targets = links_mod.link_targets(s, entity_map)
        return jsonify({"ok": True, "links": targets})

    # ---------- archive unpacker ----------

    PAK_PASSWORD = "oKoo$]bnGTKJLMNBA9A"
    _RE_PATCH_NUM = re.compile(r"patch_(\d+)")

    def _find_7z():
        exe = shutil.which("7z") or shutil.which("7za")
        if exe:
            return exe
        for cand in (r"C:\Program Files\7-Zip\7z.exe",
                     r"C:\Program Files (x86)\7-Zip\7z.exe"):
            if os.path.isfile(cand):
                return cand
        return ""

    def _pak_plan(folder: str) -> "list[str]":
        """basis.pak first, then every patch_* sorted by its numeric id -
        later patches overwrite earlier ones while extracting."""
        if not folder or not os.path.isdir(folder):
            return []
        paks = [f for f in os.listdir(folder) if f.lower().endswith(".pak")]
        base = [f for f in paks if f.lower() == "basis.pak"]
        patches = []
        for f in paks:
            lf = f.lower()
            if lf == "basis.pak" or not lf.startswith("patch_"):
                continue
            m = _RE_PATCH_NUM.search(lf)
            patches.append((int(m.group(1)) if m else 10 ** 6, f))
        patches.sort()
        return ([os.path.join(folder, f) for f in base]
                + [os.path.join(folder, f) for _n, f in patches])

    def _dlc_dir(root: str, name: str) -> str:
        d = os.path.join(root, "dlc")
        if not os.path.isdir(d):
            return ""
        for e in os.listdir(d):
            if e.lower() == name:
                return os.path.join(d, e)
        return ""

    @app.route("/api/unpack_scan", methods=["POST"])
    def api_unpack_scan():
        """Find every .pak of the game root and order the extraction queue."""
        data = request.get_json(silent=True) or {}
        root = (data.get("path") or "").strip()
        if not root or not os.path.isdir(root):
            return jsonify({"ok": False, "error": "not a folder"})

        def grp(folder):
            return [{"name": os.path.basename(x), "path": x} for x in _pak_plan(folder)]

        return jsonify({"ok": True, "sevenz": _find_7z(),
                        "base": grp(root),
                        "legion": grp(_dlc_dir(root, "legion")),
                        "resistance": grp(_dlc_dir(root, "resistance")),
                        "evolution": grp(_dlc_dir(root, "evolution"))})

    _unpack_job = {"running": False, "done": False, "lines": [], "error": "",
                   "total": 0, "done_n": 0, "current": "", "pct": 0,
                   "cancel": False, "proc": None}

    def _dir_size(folder: str) -> int:
        total = 0
        try:
            for root_d, _dirs, files in os.walk(folder):
                for fn in files:
                    try:
                        total += os.path.getsize(os.path.join(root_d, fn))
                    except OSError:
                        pass
        except OSError:
            pass
        return total

    def _pak_total_size(pak: str, sevenz: str) -> int:
        """Sum of the uncompressed file sizes inside the pak (0 if unknown)."""
        try:
            p = subprocess.run(
                [sevenz, "l", "-slt", "-p" + PAK_PASSWORD, pak],
                capture_output=True, text=True, errors="replace", timeout=120)
        except Exception:  # noqa: BLE001
            return 0
        total = 0
        for line in (p.stdout or "").splitlines():
            if line.strip().startswith("Size = "):
                try:
                    total += int(line.split("=", 1)[1].strip())
                except ValueError:
                    pass
        return total

    def _watch_pct(outdir: str, total: int, stop: threading.Event, base: int = 0):
        """Poll the outdir and set _unpack_job['pct'] = extracted bytes %.
        'base' is the byte snapshot taken before this pak started, so files
        left by earlier paks of the same group don't skew the percentage."""
        while not stop.wait(0.35):
            got = 0
            try:
                for root_d, _dirs, files in os.walk(outdir):
                    for fn in files:
                        try:
                            got += os.path.getsize(os.path.join(root_d, fn))
                        except OSError:
                            pass
            except OSError:
                pass
            got -= base
            _unpack_job["pct"] = (min(99, int(got * 100 / total))
                                  if total and got > 0 else 0)

    def _unpack_worker(plan, dest: str, sevenz: str):
        try:
            os.makedirs(dest, exist_ok=True)
            cancelled = False
            for _group, out_rel, paks in plan:
                if _unpack_job.get("cancel"):
                    cancelled = True
                    break
                # ALL paks of a group extract into ONE folder: the game base
                # paks go to <dest>\basis\ (basis.pak first, then patches
                # overwrite), each DLC -> <dest>\dlc\<name>\basis\
                outdir = os.path.join(dest, out_rel)
                os.makedirs(outdir, exist_ok=True)
                for pak in paks:
                    if _unpack_job.get("cancel"):
                        cancelled = True
                        break
                    _unpack_job["current"] = os.path.basename(pak)
                    _unpack_job["pct"] = 0
                    _unpack_job["lines"].append(
                        ">> " + pak + "  ->  " + os.path.relpath(outdir, dest))
                    # per-pak progress: watcher polls freshly extracted bytes
                    # (on top of the snapshot) against the pak's own
                    # uncompressed size (7z -bsp1 gives no pct through a pipe)
                    pak_total = _pak_total_size(pak, sevenz)
                    snap = _dir_size(outdir)
                    stop = threading.Event()
                    watcher = threading.Thread(target=_watch_pct,
                                               args=(outdir, pak_total, stop, snap),
                                               daemon=True)
                    watcher.start()
                    proc = subprocess.Popen(
                        [sevenz, "x", "-y", "-bsp1",
                         "-p" + PAK_PASSWORD, "-o" + outdir, pak],
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        text=True, errors="replace")
                    _unpack_job["proc"] = proc
                    tail: "collections.deque[str]" = collections.deque(maxlen=5)
                    # drain 7z output (its "Everything is Ok"/errors go here)
                    buf = ""
                    for ch in proc.stdout:
                        buf += ch
                        if ch not in "\r\n":
                            continue
                        part = buf.strip()
                        buf = ""
                        if part:
                            tail.append(part)
                    if buf.strip():
                        tail.append(buf.strip())
                    proc.wait()
                    stop.set()
                    _unpack_job["pct"] = 100
                    if _unpack_job.get("cancel"):
                        cancelled = True
                        break
                    if proc.returncode != 0:
                        errtxt = " | ".join(tail)[-300:]
                        _unpack_job["lines"].append("!! 7z exit %d: %s" % (proc.returncode, errtxt))
                        _unpack_job["error"] = "7z failed on %s" % os.path.basename(pak)
                        return
                    _unpack_job["done_n"] += 1
                    _unpack_job["current"] = ""
            if cancelled:
                _unpack_job["lines"].append("!! Прервано пользователем")
                _unpack_job["error"] = "cancelled"
            else:
                _unpack_job["lines"].append("OK")
        except Exception as e:  # noqa: BLE001
            _unpack_job["error"] = str(e)
            _unpack_job["lines"].append("!! " + str(e))
        finally:
            _unpack_job["running"] = False
            _unpack_job["done"] = True
            _unpack_job["proc"] = None
            _unpack_job["current"] = ""

    @app.route("/api/unpack_run", methods=["POST"])
    def api_unpack_run():
        """Unpack the whole found queue in a background thread; ALL paks of a
        group extract into ONE folder so later patches overwrite earlier
        files: game base -> dest\\basis\\ (basis.pak first, then patch_* by
        number), Legion -> dest\\dlc\\legion\\basis\\,
        Resistance -> dest\\dlc\\resistance\\basis\\,
        Evolution -> dest\\dlc\\evolution\\basis\\."""
        data = request.get_json(silent=True) or {}
        root = (data.get("game_root") or "").strip()
        dest = (data.get("dest") or "").strip()
        if not root or not os.path.isdir(root):
            return jsonify({"ok": False, "error": "not a folder"})
        if not dest:
            return jsonify({"ok": False, "error": "no dest"})
        sevenz = _find_7z()
        if not sevenz:
            return jsonify({"ok": False, "error": "7z not found"})
        if _unpack_job["running"]:
            return jsonify({"ok": False, "error": "already running"})
        plan = [("base", "basis", _pak_plan(root))]
        legion = _dlc_dir(root, "legion")
        if legion:
            plan.append(("legion", os.path.join("dlc", "legion", "basis"),
                         _pak_plan(legion)))
        resistance = _dlc_dir(root, "resistance")
        if resistance:
            plan.append(("resistance", os.path.join("dlc", "resistance", "basis"),
                         _pak_plan(resistance)))
        evolution = _dlc_dir(root, "evolution")
        if evolution:
            plan.append(("evolution", os.path.join("dlc", "evolution", "basis"),
                         _pak_plan(evolution)))
        if not any(paks for _g, _r, paks in plan):
            return jsonify({"ok": False, "error": "no paks"})
        _unpack_job.update({"running": True, "done": False, "lines": [], "error": "",
                            "total": sum(len(paks) for _g, _r, paks in plan),
                            "done_n": 0, "current": "", "pct": 0,
                            "cancel": False, "proc": None})
        threading.Thread(target=_unpack_worker,
                         args=(plan, os.path.normpath(dest), sevenz),
                         daemon=True).start()
        return jsonify({"ok": True})

    @app.route("/api/unpack_status")
    def api_unpack_status():
        return jsonify({"ok": True,
                        **{k: v for k, v in _unpack_job.items()
                           if k not in ("proc",)}})

    @app.route("/api/unpack_abort", methods=["POST"])
    def api_unpack_abort():
        if not _unpack_job["running"]:
            return jsonify({"ok": False, "error": "not running"})
        _unpack_job["cancel"] = True
        proc = _unpack_job.get("proc")
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:  # noqa: BLE001
                pass
        return jsonify({"ok": True})

    @app.after_request
    def _no_cache(resp):
        """Always revalidate HTML/CSS/JS: a packaged WebView2 build must
        never serve stale assets from its cache after an update."""
        resp.headers["Cache-Control"] = "no-cache, max-age=0"
        return resp

    return app

