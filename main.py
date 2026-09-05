"""Launch Terminator ToolSet.

Runs the Flask backend on a random localhost port (background thread), then opens
a pywebview window (native WebView2) pointed at it. With --browser (dev mode) a
normal web browser is used instead.

Config + SQLite database live in the folder next to this file (source) or next
to the executable (frozen). Single instance: second launch forwards args to the
first and exits.
"""
from __future__ import annotations

import os
import sys
import threading
import time
import webbrowser

APP_DIR = os.path.dirname(os.path.abspath(__file__))
VERSION = "0.9.1"

# -- refactored modules (window/tray/webview live in infrastructure.window) ---
from terminator_toolset.application.bootstrap import build_app
from terminator_toolset.application.bootstrap import boot_ping as _boot_ping
from terminator_toolset.application.state import set_pending_files
from terminator_toolset.infrastructure.filesystem import pick_app_dir as _pick_app_dir
from terminator_toolset.infrastructure.logging import boot_log as _log
from terminator_toolset.infrastructure.logging import setup_logging as _setup_logging
from terminator_toolset.infrastructure.server import serve as _serve
from terminator_toolset.infrastructure.single_instance import (
    forward_to_first as _forward_to_first,
)
from terminator_toolset.infrastructure.single_instance import (
    single_instance_lock as _single_instance_lock,
)
from terminator_toolset.infrastructure.single_instance import take_pending as _take_pending
from terminator_toolset.infrastructure.window import keep_alive as _keep_alive
from terminator_toolset.infrastructure.window import run_pywebview as _run_pywebview


def main(browser: bool = False):
    # single-instance: второй запуск уходит к первому, нового процесса нет
    cli_args = [a for a in sys.argv[1:] if not a.startswith("-")]
    first, _mutex = _single_instance_lock()
    if not first:
        _forward_to_first(cli_args)
        try:
            print("Terminator ToolSet already running, args forwarded")
        except Exception:  # noqa: BLE001
            pass
        os._exit(0)
    _setup_logging(_pick_app_dir())
    # файлы из командной строки / Drag&Drop второго запуска -> mailbox
    for a in cli_args:
        if a and os.path.exists(a):
            _forward_to_first([a])
    app, config, db, base_dir = build_app()
    try:
        set_pending_files(_take_pending() + [a for a in cli_args if os.path.exists(a)])
    except Exception:  # noqa: BLE001
        pass
    host = "127.0.0.1"
    # стабильный старт: до 3 попыток bind, иначе понятная ошибка в лог
    srv = None
    last_err = None
    for _ in range(3):
        try:
            srv = _serve(app, host)
            break
        except Exception as e:  # noqa: BLE001
            last_err = e
            _log("server bind retry: %s" % e)
            time.sleep(0.5)
    if srv is None:
        _log("server bind failed: %s" % last_err)
        raise RuntimeError("server bind failed: %s" % last_err)
    port = srv.server_port
    threading.Thread(target=srv.serve_forever, daemon=True, name="flask").start()
    url = "http://%s:%d/" % (host, port)
    _log("server: %s (pid %s)" % (url, os.getpid()))
    if not getattr(sys, "frozen", False):
        print("Flask server: %s  (pid %s)" % (url, os.getpid()), flush=True)
    _boot_ping(app, 8)

    # автозапуск браузера из настроек (open_in_browser) + browser_to_tray
    want_browser = bool(browser or os.environ.get("TS_BROWSER")
                        or config.get("open_in_browser"))
    if want_browser:
        _log("mode=browser %s" % url)
        try:
            if config.get("browser_to_tray"):
                pass  # сворачивание выполнит фронт через minimize_to_tray
            webbrowser.open(url)
        except Exception as e:  # noqa: BLE001
            _log("browser open failed: %s" % e)
        if not getattr(sys, "frozen", False):
            print("Terminator ToolSet dev server: %s" % url)
        # в browser-режиме окно pywebview не создаём, но процесс живёт;
        # трей доступен через отдельный флаг? пока просто держим сервер
        if config.get("browser_to_tray"):
            _log("browser_to_tray: server only, window hidden")
        _keep_alive()
        return

    # Основной режим: pywebview-окно (нативный WebView2)
    _run_pywebview(config, url, app, APP_DIR)


if __name__ == "__main__":
    _log("starting")
    main(browser="--browser" in sys.argv)
    _log("exited")
