"""Launch Terminator ToolSet.

Boot order (the launcher must appear BEFORE the heavy init):
  1. single-instance lock + logging (fast, synchronous);
  2. minimal boot-Flask (/splash + /api/boot_progress) -> bind -> serve
     thread -> real HTTP self-probe. Only now the progress bar exists;
  3. splash window FIRST, then the heavy build (Config/Database/services,
     WSGI hot-swap, updates, main window) runs in the launcher thread
     while the bar moves through named stages (see
     terminator_toolset.application.boot_stages).

Config + SQLite database live in the folder next to this file (source) or next
to the executable (frozen). Single instance: second launch forwards args to the
first and exits.
"""
from __future__ import annotations

import os
import sys

# Жёсткая ветка .NET для нативного окна (pywebview → pythonnet):
# дефолт pythonnet на Windows и так netfx (встроенный .NET Framework),
# но фиксируем явно — иначе при первой неудаче `import clr` сам pywebview
# (webview/platforms/winforms.py) молча переключается на coreclr, которому
# нужен внешний .NET Desktop Runtime. Встроенных Framework 4.8 + WebView2
# достаточно. Ставится ДО любых импортов, способных дёрнуть clr.
os.environ.setdefault("PYTHONNET_RUNTIME", "netfx")

import threading
import time
import webbrowser

APP_DIR = os.path.dirname(os.path.abspath(__file__))

# Nuitka-шим (эксперимент compiler_nuitka/build_nuitka.bat): Nuitka не
# выставляет sys.frozen/sys._MEIPASS, а весь код ищет datas через них.
# В Nuitka-сборке (__compiled__ есть только в скомпилированном коде)
# притворяемся frozen: _MEIPASS = каталог exe (standalone раскладывает
# datas рядом с exe). Строго ДО первого импорта пакета —
# terminator_toolset/__init__ уже читает pyproject через _MEIPASS.
# В dev (python main.py) и под PyInstaller (_MEIPASS уже есть) — no-op.
if "__compiled__" in globals():
    if not getattr(sys, "frozen", False):
        sys.frozen = True
    if not getattr(sys, "_MEIPASS", None):
        sys._MEIPASS = os.path.dirname(os.path.abspath(sys.executable))

from terminator_toolset import __version__ as VERSION  # noqa: E402

# -- refactored modules (window/tray/webview live in infrastructure.window) ---
from terminator_toolset.application.bootstrap import build_app
from terminator_toolset.application.boot_stages import STAGES
from terminator_toolset.application.boot_stages import stage as _stage
from terminator_toolset.application.state import set_pending_files
from terminator_toolset.infrastructure.filesystem import pick_app_dir as _pick_app_dir
from terminator_toolset.infrastructure.logging import boot_log as _log
from terminator_toolset.infrastructure.logging import setup_logging as _setup_logging
from terminator_toolset.infrastructure.server import serve as _serve
from terminator_toolset.infrastructure.server import swap_app as _swap_app
from terminator_toolset.infrastructure.server import wait_ready as _wait_ready
from terminator_toolset.infrastructure.single_instance import (
    forward_to_first as _forward_to_first,
)
from terminator_toolset.infrastructure.single_instance import (
    single_instance_lock as _single_instance_lock,
)
from terminator_toolset.infrastructure.single_instance import (
    write_first_pid as _write_first_pid,
)
from terminator_toolset.infrastructure.single_instance import (
    take_window_request as _take_window_request,
)
from terminator_toolset.infrastructure.single_instance import take_pending as _take_pending
from terminator_toolset.infrastructure.window import keep_alive as _keep_alive
from terminator_toolset.infrastructure.window import run_pywebview as _run_pywebview
from terminator_toolset.infrastructure.window import (
    run_browser_tray as _run_browser_tray,
)
from terminator_toolset.infrastructure.window import (
    watch_restore_requests as _watch_restore_requests,
)

_PCT = {key: pct for pct, key in STAGES}


def _light_branch_hint():
    """Ветка browser/window ДО тяжёлого билда: лёгкое чтение open_in_browser
    прямо из config.json (без создания Config/файлов — их время придёт
    на стадии boot_cfg при видимом лаунчере)."""
    try:
        import json as _json
        cfg = os.path.join(_pick_app_dir(), "configs", "config.json")
        with open(cfg, "r", encoding="utf-8") as fh:
            return bool((_json.load(fh) or {}).get("open_in_browser"))
    except Exception:  # noqa: BLE001
        return False


def main(browser: bool = False):
    # single-instance: второй запуск уходит к первому, нового процесса нет.
    # Исключение: флаг window.request (трей browser-режима, «Открыть») —
    # новый процесс ждёт выхода старого и стартует первым в оконном режиме.
    cli_args = [a for a in sys.argv[1:] if not a.startswith("-")]
    first, _mutex = _single_instance_lock()
    if not first and _take_window_request():
        for _ in range(20):
            time.sleep(0.5)
            first, _mutex = _single_instance_lock()
            if first:
                break
    if not first:
        _forward_to_first(cli_args)
        try:
            print("Terminator ToolSet already running, args forwarded")
        except Exception:  # noqa: BLE001
            pass
        os._exit(0)
    # общий прогресс 0-100: его же опрашивает splash и позже заберёт
    # полное приложение (hot-swap без сброса бара)
    progress = {"pct": 0, "label": ""}
    lang = ["ru"]

    def _ping(pct, key):
        _stage(progress, _log, lang[0], pct, key)

    _ping(2, "boot_lock")
    _setup_logging(_pick_app_dir())
    _ping(4, "boot_log")
    # pid первого процесса: второй запуск проверяет жив ли он, флаг
    # restore.flag + вотчер возвращают спрятанное в трей окно
    _write_first_pid()

    # -- ранний сервер: только splash + прогресс, без Config/Database --------
    from app import create_boot_app  # noqa: E402  (тяжёлый app — позже)

    _ping(6, "boot_core")
    _base = getattr(sys, "_MEIPASS", None) or APP_DIR
    boot_app = create_boot_app(_base, progress)
    host = "127.0.0.1"
    # стабильный старт: до 3 попыток bind, иначе понятная ошибка в лог.
    # Чувствительный этап отдельно: свой ретрай, свой пинг.
    srv = None
    last_err = None
    for _ in range(3):
        try:
            _ping(10, "boot_port")
            srv = _serve(boot_app, host)
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
    _ping(14, "boot_up")
    # живой самопробник отдельным этапом: реальный GET по сокету
    _ping(18, "boot_health")
    _ok, _detail = _wait_ready(url, timeout=10.0)
    if not _ok:
        _log("server self-probe failed: %s" % _detail)
        raise RuntimeError("server self-probe failed: %s" % _detail)

    # файлы из командной строки / Drag&Drop второго запуска -> mailbox
    for a in cli_args:
        if a and os.path.exists(a):
            _forward_to_first([a])

    # -- тяжёлый билд: идёт ПОСЛЕ показа лаунчера (в браузере — после
    # готовности ждёт главный поток, в окне — поток launcher) --------------
    built = {}

    def _build_heavy():
        """Config/Database/services + hot-swap WSGI. Возвращает dict
        (config/app/db/error); ошибку не бросает — её покажет лаунчер."""
        try:
            # staged self-update from the previous run: apply before anything
            # holds files (a running EXE cannot replace itself on Windows)
            try:
                from terminator_toolset.services.update_service import (
                    apply_pending_update as _apply_pending)
                _prog = (os.path.dirname(os.path.abspath(sys.executable))
                         if getattr(sys, "frozen", False) else APP_DIR)
                _applied = _apply_pending(
                    _prog, os.path.join(_prog, "configs"), _log)
                if _applied:
                    _log("update applied at boot: %s" % _applied)
            except Exception as e:  # noqa: BLE001
                _log("update apply failed: %s" % e)
            app, config, db, base_dir = build_app(
                on_stage=lambda key: _ping(_PCT.get(key, 0), key),
                boot_progress=progress)
            try:
                lang[0] = config.get("language", "ru") or "ru"
            except Exception:  # noqa: BLE001
                pass
            try:
                set_pending_files(_take_pending()
                                  + [a for a in cli_args if os.path.exists(a)])
            except Exception:  # noqa: BLE001
                pass
            _swap_app(srv, app)
            _ping(46, "boot_swap")
            built.update(config=config, app=app, db=db, base_dir=base_dir,
                         error="")
        except Exception as e:  # noqa: BLE001
            _log("heavy build failed: %s" % e)
            try:
                progress["label"] = "Ошибка запуска: %s" % e
            except Exception:  # noqa: BLE001
                pass
            built.update(error=str(e))
        return built

    # автозапуск браузера: явный флаг/env — сразу; open_in_browser из
    # настроек — лёгким чтением (полный Config ещё не создан)
    want_browser = bool(browser or os.environ.get("TS_BROWSER")
                        or _light_branch_hint()) \
        and not os.environ.get("TS_WINDOW")
    if want_browser:
        _log("mode=browser %s" % url)
        config = _build_heavy().get("config")
        if not config:
            raise RuntimeError("heavy build failed: %s"
                               % built.get("error", "?"))
        try:
            if config.get("browser_to_tray"):
                pass  # сворачивание выполнит фронт через minimize_to_tray
            webbrowser.open(url)
        except Exception as e:  # noqa: BLE001
            _log("browser open failed: %s" % e)
        if not getattr(sys, "frozen", False):
            print("Terminator ToolSet dev server: %s" % url)
        # в browser-режиме окна нет: единственный пульт (открыть URL
        # заново / закрыть сервер) — иконка трея, иначе процесс виден
        # только в диспетчере задач
        if config.get("browser_to_tray"):
            _log("browser_to_tray: server only, window hidden")
        _run_browser_tray(url)
        return

    # Основной режим: pywebview-окно (нативный WebView2).
    # Вотчер повторного запуска: второй exe просит показать окно из трея.
    threading.Thread(target=_watch_restore_requests, daemon=True,
                     name="restore-watch").start()
    _run_pywebview(url, APP_DIR, _build_heavy, _ping)


if __name__ == "__main__":
    _log("starting")
    main(browser="--browser" in sys.argv)
    _log("exited")
