"""Flask backend for Terminator Sheet.

Exposes a small JSON API the browser grid calls. All the real work happens on
the python side; the JS frontend is pure UI.

Thin factory: services are composed here, HTTP routes live in
terminator_toolset.api (one register_* group per area).
"""
from __future__ import annotations

import logging
import os
import time
from types import SimpleNamespace
from typing import Optional

from flask import Flask, request

log = logging.getLogger("terminatorsheet.api")

# -- domain + package imports (refactored layout) ---------------------------
from terminator_toolset import __version__ as VERSION
from terminator_toolset.api.archive import register_archive
from terminator_toolset.api.compare import register_compare
from terminator_toolset.api.config import register_config
from terminator_toolset.api.files import register_files
from terminator_toolset.api.history import register_history
from terminator_toolset.api.mods import register_mods
from terminator_toolset.api.project import register_project
from terminator_toolset.api.shell import register_shell
from terminator_toolset.api.sheets import register_sheets
from terminator_toolset.api.swt import register_swt
from terminator_toolset.api.uprising import register_uprising
from terminator_toolset.api.updates import register_updates
from terminator_toolset.domain import swt_editor as swt_mod
from terminator_toolset.domain.config import Config, Markers
from terminator_toolset.domain.database import Database
from terminator_toolset.domain.i18n import I18n
from terminator_toolset.infrastructure.filesystem import resolve_external as _resolve_external
from terminator_toolset.infrastructure.filesystem import walk_tree as _walk_tree
from terminator_toolset.services.archive_service import Archive
from terminator_toolset.services.compare_service import Compare
from terminator_toolset.services.entity_service import EntityIndex
from terminator_toolset.services.files_service import Files
from terminator_toolset.services.guard_service import Guard
from terminator_toolset.services.history_service import HistoryLog
from terminator_toolset.services.mods_service import Mods
from terminator_toolset.services.save_service import SavePipeline
from terminator_toolset.services.session_store import SessionStore
from terminator_toolset.services.swt_service import Swt
from terminator_toolset.services.uprising_service import Uprising
from terminator_toolset.services.update_service import Updates

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def create_app(config: Config, db: Database, base_dir: Optional[str] = None) -> Flask:
    _base = base_dir or BASE_DIR
    app = Flask(__name__,
                template_folder=os.path.join(_base, "templates"),
                static_folder=os.path.join(_base, "static"))
    app.config["JSON_AS_ASCII"] = False
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

    # -- deploy-aware resource dirs (mirror the /locales route priority) ------
    # Domain modules must not resolve deploy paths themselves: the app injects
    # them here (external copy next to EXE/config wins, then _base).
    _lang = config.get("language", "ru")
    _loc_file = _resolve_external([config.dir,
                                   os.path.dirname(config.dir),
                                   os.getcwd()],
                                  "locales", "%s.json" % _lang)
    _loc_dir = os.path.dirname(_loc_file) if _loc_file else os.path.join(_base, "locales")
    i18n = I18n(_lang, _loc_dir)
    _cmds_file = _resolve_external([config.dir,
                                    os.path.dirname(config.dir),
                                    os.getcwd()],
                                   "swt_commands.json")
    swt_mod.CMDS_PATH = _cmds_file or os.path.join(_base, "swt_commands.json")
    swt_mod.SWT_CMDS = swt_mod._load_cmds()
    # -- session store (single owner of session containers) ------------------
    store = SessionStore()
    # -- entity index (owns the open project + background entity map) --------
    entities = EntityIndex(store)
    # -- history log (journal queries, undo/redo cursor, file payloads) ------
    hist = HistoryLog(store, db)
    # -- unpacked-game guard (stock assets are read-only) ---------------------
    guard = Guard(store, config)
    # -- mod scaffolding (game dir, mod folders, tree copies, reveal) ----
    mods = Mods(config, log)
    # -- game archive unpacker (ordered .pak extraction + progress) ---------
    arch = Archive(log, base_dir)
    # -- uprising map (species parsing, icons, balance configs) ---------------
    upr = Uprising(store, config, entities, log, _base, BASE_DIR)
    markers = Markers(config.cfg_dir if hasattr(config, "cfg_dir") else config.dir)
    # -- save pipeline (disk writes, autosave, edited marks) ------------------
    saves = SavePipeline(store, markers, config, guarded=guard.guarded)
    # -- file lifecycle (save-as, stock rollback, journal jump) --------------
    files = Files(store, config, saves, hist, db, entities, log)
    # -- compare / merge / transfer between two spreadsheet files -----------
    cmp = Compare(store, config, saves, hist, db, log)
    # -- swt mission scripts (parse + guarded save) --------------------------
    swt = Swt(store, saves, log)
    # -- self-updates (worker over GitHub releases; program dir next to the
    # exe when frozen, sources root in dev)
    import sys as _sys
    _program_dir = (os.path.dirname(os.path.abspath(_sys.executable))
                    if getattr(_sys, "frozen", False) else _base)
    upd = Updates(config, log, _program_dir, VERSION)

    # -- route context (services + deploy values shared by api groups) -------
    ctx = SimpleNamespace(config=config, db=db, i18n=i18n, store=store,
                          entities=entities, hist=hist, guard=guard,
                          saves=saves, mods=mods, arch=arch, upr=upr, cmp=cmp,
                          files=files, swt=swt, markers=markers, log=log,
                          upd=upd,
                          base=_base, version=VERSION)
    register_shell(app, ctx)
    register_config(app, ctx)
    register_project(app, ctx)
    register_sheets(app, ctx)
    register_files(app, ctx)
    register_compare(app, ctx)
    register_history(app, ctx)
    register_swt(app, ctx)
    register_uprising(app, ctx)
    register_updates(app, ctx)
    register_mods(app, ctx)
    register_archive(app, ctx)
    upr.start_warmup()

    @app.after_request
    def _no_cache(resp):
        """Always revalidate HTML/CSS/JS: a packaged WebView2 build must
        never serve stale assets from its cache after an update.
        Исключение: /assets/* и /locales/* — у этих маршрутов свой явный
        Cache-Control (карта, webp-иконки, щиты): их кэш и даёт скорость."""
        try:
            p = request.path or ""
        except Exception:  # noqa: BLE001
            p = ""
        if p.startswith("/assets/") or p.startswith("/locales/"):
            return resp
        resp.headers["Cache-Control"] = "no-cache, max-age=0"
        return resp

    @app.after_request
    def _log_requests(resp):
        """Медленные и упавшие запросы - в лог (диагностика «вечной загрузки»)."""
        try:
            t0 = getattr(request, "_tsh_t0", None)
            dur = (time.time() - t0) if t0 else 0
            if resp.status_code >= 400 or dur > 2.0:
                log.warning("http %s %s -> %d (%.2fs)",
                            request.method, request.path,
                            resp.status_code, dur)
        except Exception:  # noqa: BLE001
            pass
        return resp

    @app.before_request
    def _t0_marker():
        request._tsh_t0 = time.time()  # noqa: B010

    return app
