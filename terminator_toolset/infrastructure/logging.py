"""Logging setup: one fresh log per launch, human-readable, no rotation chain."""
from __future__ import annotations

import glob
import logging
import os
import sys
import threading
import time


# криптичные имена логгеров -> понятные (видно в каждой строке лога)
_LOGGER_NAMES = {
    "werkzeug": "server",
}

_BOOT_FRESH = False  # первый boot_log процесса затирает файл прошлого запуска


def _readable_name(record: logging.LogRecord) -> bool:
    try:
        record.name = _LOGGER_NAMES.get(record.name, record.name)
    except Exception:  # noqa: BLE001
        pass
    return True


# -- root logging --------------------------------------------------------------
def setup_logging(base_dir: str):
    """Один запуск — один лог: app.log (INFO+) и errors.log (WARNING+)
    пересоздаются на старте, цепочка ротации app.log.1/.2/.3 больше не
    собирается (хвосты от старых версий удаляем здесь же)."""
    try:
        logdir = os.path.join(base_dir, "Logs")
        os.makedirs(logdir, exist_ok=True)
        # legacy logs/ -> Logs/ migration
        for _oldn in ("app.log", "errors.log", "boot.log"):
            _oldp = os.path.join(base_dir, "logs", _oldn)
            _newp = os.path.join(logdir, _oldn)
            try:
                if os.path.isfile(_oldp) and not os.path.isfile(_newp):
                    os.replace(_oldp, _newp)
            except Exception:  # noqa: BLE001
                pass
        # хвосты ротации прошлых версий: один запуск — один лог, их не храним
        for _tail in glob.glob(os.path.join(logdir, "app.log.*")) + \
                glob.glob(os.path.join(logdir, "errors.log.*")):
            try:
                os.remove(_tail)
            except Exception:  # noqa: BLE001
                pass
        fmt = logging.Formatter(
            "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S")
        # свежие файлы на каждый запуск (mode="w"), без ротации
        fh = logging.FileHandler(
            os.path.join(logdir, "app.log"), mode="w", encoding="utf-8")
        fh.setFormatter(fmt)
        fh.addFilter(lambda r: not str(getattr(r, "name", "")).startswith(
            ("terminatorsheet.boot", "terminatorsheet.crash")))
        fh.addFilter(_readable_name)
        eh = logging.FileHandler(
            os.path.join(logdir, "errors.log"), mode="w", encoding="utf-8")
        eh.setFormatter(fmt)
        eh.setLevel(logging.WARNING)
        eh.addFilter(_readable_name)
        root = logging.getLogger()
        # drop stale handlers on re-start in one process (tests)
        for h in list(root.handlers):
            try:
                if isinstance(h, logging.FileHandler) and getattr(
                        h, "baseFilename", "") in (
                        os.path.join(logdir, "app.log"),
                        os.path.join(logdir, "errors.log")):
                    root.removeHandler(h)
            except Exception:  # noqa: BLE001
                pass
        root.setLevel(logging.INFO)
        root.addHandler(fh)
        root.addHandler(eh)
        # серверный access-лог (127.0.0.1 - - "GET /static/..." 200) — только
        # проблемы: сотни строк про каждый чих статики читать невозможно,
        # медленные/упавшие запросы и так пишет _log_requests в app.py
        # понятной строкой "http GET /path -> 404 (0.00s)"
        try:
            logging.getLogger("werkzeug").setLevel(logging.WARNING)
        except Exception:  # noqa: BLE001
            pass
        # uncaught exceptions -> errors.log only
        def _excepthook(etype, value, tb):
            try:
                import traceback as _tb
                logging.getLogger("terminatorsheet.crash").critical(
                    "UNCAUGHT %s: %s\n%s", etype.__name__, value,
                    "".join(_tb.format_exception(etype, value, tb)))
            except Exception:  # noqa: BLE001
                pass
        sys.excepthook = _excepthook

        def _threadhook(args):
            _excepthook(args.exc_type, args.exc_value, args.exc_traceback)
        threading.excepthook = _threadhook
    except Exception as e:  # noqa: BLE001
        print("logging setup failed: %s" % e, file=sys.stderr)


# -- boot log ------------------------------------------------------------------
def _boot_dir() -> str:
    from .filesystem import pick_app_dir
    return os.path.join(pick_app_dir(), "Logs")


def boot_log(msg: str):
    """Startup events -> Logs/boot.log, human-readable. Файл свежий на
    каждый запуск: первый вызов процесса затирает лог прошлого."""
    global _BOOT_FRESH
    try:
        logdir = _boot_dir()
        os.makedirs(logdir, exist_ok=True)
        # legacy boot.log in root -> Logs/
        try:
            from .filesystem import pick_app_dir
            _old = os.path.join(pick_app_dir(), "boot.log")
            if os.path.isfile(_old):
                _new = os.path.join(logdir, "boot.log")
                if not os.path.isfile(_new):
                    os.replace(_old, _new)
                else:
                    os.remove(_old)
        except Exception:  # noqa: BLE001
            pass
        mode = "a"
        if not _BOOT_FRESH:
            _BOOT_FRESH = True
            mode = "w"
        with open(os.path.join(logdir, "boot.log"), mode,
                  encoding="utf-8") as fh:
            fh.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:  # noqa: BLE001
        pass
