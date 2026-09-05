"""Logging setup: rotating app/errors logs + append-only boot log."""
from __future__ import annotations

import logging
import os
import sys
import threading
import time


# -- root logging --------------------------------------------------------------
def setup_logging(base_dir: str):
    """Rotating logs without duplicates, one file per severity:
    Logs/app.log = INFO+ events; Logs/errors.log = WARNING+ only."""
    try:
        import logging.handlers
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
        fh = logging.handlers.RotatingFileHandler(
            os.path.join(logdir, "app.log"),
            maxBytes=1_000_000, backupCount=3, encoding="utf-8")
        fh.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)s %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S"))
        fh.addFilter(lambda r: not str(getattr(r, "name", "")).startswith(
            ("terminatorsheet.boot", "terminatorsheet.crash")))
        eh = logging.handlers.RotatingFileHandler(
            os.path.join(logdir, "errors.log"),
            maxBytes=1_000_000, backupCount=3, encoding="utf-8")
        eh.setFormatter(logging.Formatter(
            "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S"))
        eh.setLevel(logging.WARNING)
        root = logging.getLogger()
        # drop stale handlers on re-start in one process (tests)
        for h in list(root.handlers):
            try:
                if isinstance(h, logging.handlers.RotatingFileHandler):
                    root.removeHandler(h)
            except Exception:  # noqa: BLE001
                pass
        root.setLevel(logging.INFO)
        root.addHandler(fh)
        root.addHandler(eh)
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
    """Startup events -> Logs/boot.log, human-readable, no duplicates."""
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
        with open(os.path.join(logdir, "boot.log"), "a", encoding="utf-8") as fh:
            fh.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:  # noqa: BLE001
        pass
