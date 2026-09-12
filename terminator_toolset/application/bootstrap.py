"""Bootstrap: build config + database + Flask app (composition root)."""
from __future__ import annotations

import os
import sys

from ..domain.config import Config
from ..domain.database import Database
from ..infrastructure.filesystem import OUTER_DIR, pick_app_dir


# -- app factory -----------------------------------------------------------------
def build_app(on_stage=None, boot_progress=None):
    """Create (flask_app, config, db, base_dir). app.create_app is a thin
    factory now: services are composed there, routes live in api/ groups.
    on_stage(key) — пинги тяжёлых кусков (Config/Database дёргает вызывающий
    код сам: здесь ещё нет ни app, ни общего прогресса на руках — хотя
    boot_progress уже создан, так что можно и напрямую).
    Вызывается ПОСЛЕ показа лаунчера: первый старт пишет конфиги/БД уже
    при видимом баре."""
    from app import create_app  # noqa: E402  (outer monolith, Phase 4 moves it)

    base_dir = pick_app_dir()          # writable: config + db live here
    if callable(on_stage):
        try:
            on_stage("boot_cfg")
        except Exception:  # noqa: BLE001
            pass
    config = Config(base_dir)
    if callable(on_stage):
        try:
            on_stage("boot_db")
        except Exception:  # noqa: BLE001
            pass
    db = Database(os.path.join(base_dir, "terminator_sheet.db"))

    # when frozen, templates/static/locales live in sys._MEIPASS
    assets_dir = getattr(sys, "_MEIPASS", None) or OUTER_DIR
    app = create_app(config, db, base_dir=assets_dir, on_stage=on_stage,
                     boot_progress=boot_progress)
    return app, config, db, base_dir


# -- launch progress --------------------------------------------------------------
def boot_ping(app, pct, label=""):
    """Launch progress for the splash (see /api/boot_progress in app.py).
    Silently tolerates a missing app (tests)."""
    try:
        fn = getattr(app, "boot_ping", None)
        if callable(fn):
            fn(pct, label)
    except Exception:  # noqa: BLE001
        pass
