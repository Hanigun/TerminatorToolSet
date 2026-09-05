"""Native window: pywebview/WebView2 frame, tray icon, file dialogs, DnD.

Moved verbatim out of main.py (Phase 3): geometry helpers, stale-WebView2
cleanup, the WM_DROPFILES filter, the boot watchdog and the js_api bridge
(Api), the splash launcher and the update-check stub.
"""
from __future__ import annotations

import os
import sys
import threading
import time
import webbrowser

from ..application.bootstrap import boot_ping as _boot_ping
from ..application.state import add_pending_files
from ..services.update_service import Updates
from .filesystem import pick_app_dir as _pick_app_dir
from .logging import boot_log as _log
from terminator_toolset import __version__ as _APP_VERSION


# GUI build has no console (spec console=False): powershell.exe is a
# console-subsystem binary and pops a visible console on every spawn unless
# told otherwise (the "second console" ghost at every app start).
def _nw_kwargs():
    import subprocess
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


def _clamp_to_workarea(w, h):
    """Never let the window exceed the visible screen work area (excludes the
    taskbar) - otherwise the bottom of the UI, including the table scrollbars,
    ends up outside the screen on smaller displays."""
    try:
        import ctypes
        import ctypes.wintypes
        rect = ctypes.wintypes.RECT()
        # SPI_GETWORKAREA = 0x0030
        if ctypes.windll.user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(rect), 0):
            avail_w = rect.right - rect.left
            avail_h = rect.bottom - rect.top
            return max(640, min(int(w), avail_w)), max(480, min(int(h), avail_h))
    except Exception as e:  # noqa: BLE001
        _log("workarea clamp: %s" % e)
    return int(w), int(h)


def _center_xy(w, h):
    """Логические координаты левого-верхнего угла, чтобы окно встало по центру
    рабочей области основного монитора. Нативный CenterScreen у pywebview не
    работает: дескриптор формы создаётся ДО присвоения StartPosition, и WinForms
    игнорирует его при показе. Поэтому включаем DPI-awareness сами, берём
    рабочую область (экран минус панель задач) и считаем центр явно; x/y при
    создании окна pywebview переводит в Location физически (логические*scale),
    а явная установка Location срабатывает даже после создания дескриптора."""
    try:
        import ctypes
        import ctypes.wintypes
        u32 = ctypes.windll.user32
        try:
            u32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        except Exception:  # noqa: BLE001
            try:
                ctypes.windll.shcore.SetProcessDpiAwareness(2)
            except Exception:  # noqa: BLE001
                pass
        dpi = 96
        try:
            dpi = int(u32.GetDpiForSystem()) or 96
        except Exception:  # noqa: BLE001
            pass
        scale = dpi / 96.0
        rect = ctypes.wintypes.RECT()
        # SPI_GETWORKAREA = 0x0030 (основной монитор, физические пиксели)
        if u32.SystemParametersInfoW(0x0030, 0, ctypes.byref(rect), 0):
            wa_w = (rect.right - rect.left) / scale
            wa_h = (rect.bottom - rect.top) / scale
            wa_x = rect.left / scale
            wa_y = rect.top / scale
            return (int(wa_x + max(0, (wa_w - w) / 2)),
                    int(wa_y + max(0, (wa_h - h) / 2)))
    except Exception as e:  # noqa: BLE001
        _log("center: %s" % e)
    return None


def _kill_stale_webview(storage: str) -> None:
    """Убить осиротевшие msedgewebview2 ПРОШЛЫХ сессий нашего приложения.

    Такие процессы остаются после жёсткого завершения (kill python) и держат
    user-data-dir занятым - тогда новый запуск может не создать окружение
    WebView2 (окно «серое», запуск «через раз»). Чистим только те процессы,
    чья командная строка ссылается на НАШ storage-путь; чужие приложения,
    использующие WebView2 (Teams и т.п.), не трогаем."""
    try:
        import subprocess
        # БЕЗ .format: фигурные скобки PowerShell ({ ... }) ломали форматирование
        # ("unexpected '{' in field name") и роняли ВСЮ чистку на каждом запуске —
        # занятый user-data-dir давал «серое» окно через раз. Конкатенация вместо.
        ps = ("Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | "
              "Where-Object { $_.CommandLine -like '*" + storage.replace("'", "''") + "*' } | "
              "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }")
        subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                       capture_output=True, timeout=20, **_nw_kwargs())
    except Exception as e:  # noqa: BLE001
        _log("stale webview cleanup: %s" % e)


def _our_webview_count(storage: str) -> int:
    """Сколько живых msedgewebview2 ссылаются на НАШ storage-путь."""
    try:
        import subprocess
        ps = ("Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | "
              "Where-Object { $_.CommandLine -like '*" + storage.replace("'", "''") + "*' } | "
              "Measure-Object | Select-Object -ExpandProperty Count")
        out = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                             capture_output=True, timeout=20, text=True,
                             **_nw_kwargs())
        return int((out.stdout or "0").strip() or 0)
    except Exception:  # noqa: BLE001
        return 0


def _wait_stale_webview_gone(storage: str, timeout: float = 10.0) -> None:
    """Дождаться освобождения user-data-dir прошлой сессией.

    Прошлая сессия могла выйти секунды назад (быстрый перезапуск): её
    Edge-процессы ещё держат профиль, и новый контроллер тогда стартует
    мёртвым — страница грузится, а JS не исполняется («серый старт»,
    лечится только перезапуском с паузой). Ждём до timeout, иначе стартуем
    как есть (вотчдог уже умеет показывать причину в лаунчере)."""
    if _our_webview_count(storage) == 0:
        return
    _log("stale webview: waiting for previous session to release profile")
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(0.5)
        if _our_webview_count(storage) == 0:
            _log("stale webview: profile released")
            return
    _log("stale webview: processes still alive after wait")


def _on_dropfiles(hdrop: int) -> None:
    """Пути из нативного WM_DROPFILES -> mailbox (фронт заберёт poll'ом)."""
    try:
        import ctypes
        from ctypes import wintypes
        shell32 = ctypes.windll.shell32
        shell32.DragQueryFileW.argtypes = [wintypes.HANDLE, wintypes.UINT,
                                           wintypes.LPWSTR, wintypes.UINT]
        shell32.DragQueryFileW.restype = wintypes.UINT
        shell32.DragFinish.argtypes = [wintypes.HANDLE]
        try:
            n = int(shell32.DragQueryFileW(hdrop, 0xFFFFFFFF, None, 0))
        except Exception:  # noqa: BLE001
            return
        paths = []
        for i in range(min(n, 64)):
            buf = ctypes.create_unicode_buffer(32768)
            try:
                if shell32.DragQueryFileW(hdrop, i, buf, len(buf)) and buf.value:
                    paths.append(buf.value)
            except Exception:  # noqa: BLE001
                pass
        try:
            shell32.DragFinish(hdrop)
        except Exception:  # noqa: BLE001
            pass
        if paths:
            add_pending_files(paths)
            _log("drop: %d path(s) to mailbox" % len(paths))
    except Exception as e:  # noqa: BLE001
        _log("drop: %s" % e)


def _install_drop_filter(form):
    """Нативный приём файлов/папок, брошенных в окно (WM_DROPFILES).

    WebView2 НЕ отдаёт в JS пути дропа (только имена) — поэтому drop файла
    или папки вне известных корней молча не открывался, а кнопки (нативный
    диалог с полным путём) работали. Ловим дроп на уровне окна: срабатывает
    поверх любых контролов, пути уходят в mailbox, фронт забирает их штатным
    poll'ом (файл -> openFile, папка -> loadProject — ровно как кнопки).
    Возвращает объект фильтра (держать ссылку!) или None."""
    try:
        from System.Windows.Forms import Application, IMessageFilter
    except Exception as e:  # noqa: BLE001
        _log("drop: winforms unavailable: %s" % e)
        return None
    WM_DROPFILES = 0x233

    class _DropFilter(IMessageFilter):
        def PreFilterMessage(self, m):
            try:
                if int(m.Msg) == WM_DROPFILES:
                    try:
                        _on_dropfiles(int(m.WParam.ToInt64()))
                    except Exception as ex:  # noqa: BLE001
                        _log("drop: %s" % ex)
            except Exception:  # noqa: BLE001
                pass
            return False  # не съедаем: пусть и Chromium обработает drop

    try:
        filt = _DropFilter()
        Application.AddMessageFilter(filt)
    except Exception as e:  # noqa: BLE001
        _log("drop: filter: %s" % e)
        return None
    try:
        import ctypes
        ctypes.windll.shell32.DragAcceptFiles(
            ctypes.c_void_p(int(form.Handle.ToInt64())), True)
    except Exception as e:  # noqa: BLE001
        _log("drop: DragAcceptFiles: %s" % e)
        return None
    _log("drop: native filter installed")
    return filt


def run_pywebview(config, url, app=None, app_dir=None):
    """pywebview-окно (WebView2): как в исходном TerminatorSheet. Отсутствие
    проблем с производительностью/драгом подтверждено эксплуатацией."""
    from config import WINDOW_SIZES
    try:
        import webview
    except Exception as e:  # noqa: BLE001
        _log("mode=browser-fallback (%s)" % e)
        print("pywebview unavailable (%s) - opening browser: %s" % (e, url))
        webbrowser.open(url)
        keep_alive()
        return

    # -- постоянный профиль WebView2 ------------------------------------------
    # private_mode=True (по умолчанию) создаёт temp-каталог на каждый запуск и
    # удаляет его при выходе; если файлы ещё заняты браузерным процессом,
    # сыпется "[WinError 32] Процесс не может получить доступ к файлу ...
    # EBWebView ...". Постоянный профиль ничего не удаляет (ошибки нет) и
    # заодно ускоряет повторный запуск (тёплый кэш).
    storage = os.path.join(
        os.environ.get("LOCALAPPDATA") or app_dir, "TerminatorToolSet", "WebView2")
    try:
        os.makedirs(storage, exist_ok=True)
    except Exception as e:  # noqa: BLE001
        _log("webview storage: %s" % e)
    _kill_stale_webview(storage)
    _wait_stale_webview_gone(storage)

    # -- вотчдог «серого старта» ----------------------------------------------
    # WebView2 иногда отдаёт страницу, но НЕ исполняет JS: main_ready не
    # приходит, окно остаётся скрытым ("запускается через раз"). Следим со
    # стороны сервера: фронт в init() первым делом шлёт POST /api/boot_progress
    # с pct=25. Не пришёл - проверяем жив ли фронт (window.__tshBooted) и перезагружаем.
    boot = {"seen": False}

    def _boot_request_hook():
        # booted = настоящий фронт и только он. GET /api/config НЕ годится:
        # его может прислать что угодно (диагностика, второй процесс) — был
        # случай: вотчдог принял чужой GET за оживший фронт и прекратил
        # лечение мёртвого окна.
        try:
            from flask import request as _req
            if _req.path == "/api/boot_progress" and _req.method == "POST":
                try:
                    pct = int((_req.get_json(silent=True) or {}).get("pct") or 0)
                except (TypeError, ValueError):
                    pct = 0
                if pct >= 25:
                    boot["seen"] = True
        except Exception:  # noqa: BLE001
            pass

    if app is not None:
        app.before_request(_boot_request_hook)

    def _boot_watchdog():
        import time as _t
        for attempt in range(6):
            _t.sleep(4)
            if boot["seen"]:
                if not boot.get("logged"):
                    boot["logged"] = True
                    _log("boot watchdog: booted (config seen)")
                return
            win = api._main
            if win is None:
                continue   # главное окно ещё не создано (проверка обновлений)
            try:
                alive = win.evaluate_js("!!window.__tshBooted")
            except Exception as e:  # noqa: BLE001
                _log("boot watchdog: evaluate failed: %s" % e)
                alive = None
            if alive:
                _log("boot watchdog: page alive w/o config request; skip reload")
                return
            _log("boot watchdog: no config request, reload (try %d)" % (attempt + 1))
            try:
                win.load_url(url)
            except Exception as e:  # noqa: BLE001
                _log("boot watchdog: load_url failed: %s" % e)
                return
        # все попытки исчерпаны: окно не ожило - показать причину в лаунчере,
        # чтобы не висеть вечно на 18% без объяснений
        if not boot["seen"]:
            _log("boot watchdog: window did not start, close and restart the app")
            _boot_ping(app, 18, "Окно не запустилось — закройте и запустите снова")

    class Api:
        # ВАЖНО: ссылки на окна хранятся ТОЛЬКО в атрибутах с подчёркиванием.
        # pywebview при инъекции моста рекурсивно обходит публичные атрибуты
        # js_api; объект Window тянет за собой .native/.NET-свойства - отсюда
        # были "Error while processing main.native..." и
        # "CoreWebView2Controller members can only be accessed from the UI
        # thread" при старте.
        _main = None      # главное окно (создаётся после проверки обновлений)
        _splash = None    # окно-лаунчер
        _ready = False    # main_ready пришёл раньше, чем создано главное окно
        _drop_filter = None  # нативный WM_DROPFILES фильтр (держать ссылку)

        def _win(self):
            if self._main is not None:
                return self._main
            for w in webview.windows:
                if w is not None:
                    return w
            return None

        def main_ready(self):
            """Frontend signal: UI + project tree are fully loaded.
            Показываем главное окно и гасим лаунчер."""
            if self._main is None:
                # окно ещё не создано (проверка обновлений не кончилась):
                # запомним готовность, show() сделает _launch_main
                self._ready = True
                return True
            self._show_main()
            return True

        def _show_main(self):
            _boot_ping(app, 100)
            try:
                if self._main is not None:
                    self._main.show()
            except Exception:  # noqa: BLE001
                pass
            try:
                if self._splash is not None:
                    self._splash.destroy()
            except Exception:  # noqa: BLE001
                pass
            self._splash = None

        def _native_dialog(self, dialog_type, file_types=()):
            """Marshal WinForms file/folder dialog to the GUI thread.
            pywebview's js_api runs on a worker thread; ShowDialog must run
            on the UI thread."""
            win = self._win()
            if win is None:
                _log("picker: no window available")
                return None
            try:
                import clr
                from System import Action
                from webview.platforms.winforms import BrowserView
            except Exception as e:  # noqa: BLE001
                _log("picker: .NET bridge unavailable: %s" % e)
                return None

            form = BrowserView.instances.get(win.uid)
            if form is None:
                _log("picker: BrowserView not found for uid=%s" % win.uid)
                return None

            def _show():
                try:
                    return win.create_file_dialog(dialog_type, file_types=file_types)
                except Exception as e:  # noqa: BLE001
                    _log("picker: create_file_dialog error: %s" % e)
                    raise

            box = []
            done = threading.Event()

            def _run():
                try:
                    box.append(_show())
                except Exception as e:  # noqa: BLE001
                    box.append(("__error__", str(e)))
                finally:
                    done.set()

            try:
                if form.InvokeRequired:
                    form.Invoke(Action(_run))
                else:
                    _run()
                if not done.wait(30):
                    _log("picker: timeout waiting for dialog")
                    return None
            except Exception as e:  # noqa: BLE001
                _log("picker: Invoke error: %s" % e)
                return None

            if not box:
                return None
            val = box[0]
            if isinstance(val, tuple) and val and val[0] == "__error__":
                _log("picker: dialog returned error: %s" % val[1])
                return None
            _log("picker: success, result=%s" % (val if val else "None"))
            return val

        def pick_file(self):
            result = self._native_dialog(
                webview.FileDialog.OPEN, file_types=("XML (*.xml)", "All files (*.*)"))
            if not result:
                return None
            return result[0] if isinstance(result, (list, tuple)) else result

        def pick_file_save(self):
            result = self._native_dialog(
                webview.FileDialog.SAVE,
                file_types=("Balance config (*.cfg)", "All files (*.*)"))
            if not result:
                return None
            return result[0] if isinstance(result, (list, tuple)) else result

        def pick_cfg_file(self):
            result = self._native_dialog(
                webview.FileDialog.OPEN,
                file_types=("Balance config (*.cfg;*.txt)", "All files (*.*)"))
            if not result:
                return None
            return result[0] if isinstance(result, (list, tuple)) else result

        def pick_image(self):
            result = self._native_dialog(
                webview.FileDialog.OPEN,
                file_types=("Images (*.png;*.jpg;*.jpeg;*.bmp;*.webp;*.dds;*.tga)",
                            "All files (*.*)"))
            if not result:
                return None
            return result[0] if isinstance(result, (list, tuple)) else result

        def pick_folder(self):
            result = self._native_dialog(webview.FileDialog.FOLDER)
            if not result:
                return None
            return result[0] if isinstance(result, (list, tuple)) else result

        def _form(self):
            """Return (window, winforms Form); Form is None outside winforms."""
            win = self._win()
            if win is None:
                return None, None
            try:
                from webview.platforms.winforms import BrowserView
                return win, BrowserView.instances.get(win.uid)
            except Exception:  # noqa: BLE001
                return win, None

        def minimize(self):
            try:
                win = self._win()
                if win is not None:
                    win.minimize()
            except Exception as e:  # noqa: BLE001
                _log("minimize: %s" % e)
            return True

        # ---------- разворот на весь экран ----------
        # Безрамочная форма (FormBorderStyle=None) при WindowState=Maximized
        # перекрывает панель задач Windows. Поэтому «на весь экран» делаем
        # вручную: запоминаем текущие Bounds и растягиваем форму ровно на
        # WorkingArea (экран минус панель задач).
        _max_saved = None

        def _working_area(self):
            from System.Windows.Forms import Screen
            _, form = self._form()
            scr = Screen.FromControl(form) if form is not None else Screen.PrimaryScreen
            return scr.WorkingArea

        def is_maximized(self):
            return self._max_saved is not None

        def _form_invoke(self, fn, timeout=3.0):
            """Выполнить fn(form) строго в GUI-потоке WinForms и дождаться
            результата. js_api-методы pywebview приходят из рабочих потоков;
            прямое обращение к форме/контролам оттуда (SendMessage при смене
            Bounds) периодически мертво блокирует весь GUI. Тот же паттерн,
            что у трея: Invoke + Event."""
            win, form = self._form()
            if form is None:
                return None, False
            box = []
            done = threading.Event()

            def _wrap():
                try:
                    box.append(fn(form))
                except Exception as e:  # noqa: BLE001
                    _log("form invoke: %s" % e)
                    box.append(None)
                finally:
                    done.set()

            try:
                from System import Action
                form.Invoke(Action(_wrap))
            except Exception as e:  # noqa: BLE001
                _log("form invoke failed: %s" % e)
                return None, False
            done.wait(timeout)
            return (box[0] if box else None), done.is_set()

        def _apply_maximize(self):
            """Развернуть окно на рабочий стол (НЕ поверх панели задач)."""

            def job(form):
                if self._max_saved is not None:
                    return False
                from System.Drawing import Rectangle
                wa = self._working_area()
                self._max_saved = form.Bounds
                form.Bounds = Rectangle(wa.X, wa.Y, wa.Width, wa.Height)
                return True

            ok, _ = self._form_invoke(job)
            return bool(ok)

        def toggle_maximize(self):
            def job(form):
                if self._max_saved is not None:
                    form.Bounds = self._max_saved
                    self._max_saved = None
                    return False
                return True

            res, ok = self._form_invoke(job)
            if not ok:
                return False
            if res is True:
                return self._apply_maximize()
            return False

        def close_window(self):
            # Used for in-app close button (works even in fullscreen where the
            # title-bar X is hidden by pywebview's borderless fullscreen).
            try:
                self._tray_dispose()
            except Exception:  # noqa: BLE001
                pass
            try:
                win = self._win()
                if win is not None:
                    win.destroy()
            except Exception as e:  # noqa: BLE001
                pass
            # safety net in case the webview loop does not exit on its own
            threading.Timer(2.0, lambda: os._exit(0)).start()
            return True

        # ---------- трей ----------
        # Иконка трея на WinForms NotifyIcon. Создаётся лениво, строго в
        # GUI-потоке (Invoke): js_api вызывается из рабочих потоков.
        _tray = None

        def _tray_dispose(self):
            ni, self._tray = self._tray, None
            if ni is not None:
                try:
                    ni.Visible = False
                    ni.Dispose()
                except Exception:  # noqa: BLE001
                    pass

        def _ensure_tray(self):
            """Create (once) the tray icon on the GUI thread and return it."""
            if self._tray is not None:
                return self._tray
            win = self._win()
            if win is None:
                return None
            try:
                import clr  # noqa: F401
                from System import Action
                from webview.platforms.winforms import BrowserView
            except Exception as e:  # noqa: BLE001
                _log("tray: .NET bridge unavailable: %s" % e)
                return None
            form = BrowserView.instances.get(win.uid)
            if form is None:
                return None
            box = []
            done = threading.Event()

            def _make():
                try:
                    from System import EventHandler
                    from System.Windows.Forms import (
                        NotifyIcon, ContextMenuStrip,
                        ToolStripMenuItem, MouseEventHandler, MouseButtons)
                    ni = NotifyIcon()
                    ni.Icon = self._app_icon()
                    ni.Text = "Terminator ToolSet"
                    # ПКМ — контекстное меню; ЛКМ — показать окно
                    cms = ContextMenuStrip()
                    mi_open = ToolStripMenuItem("Открыть")
                    mi_open.add_Click(EventHandler(self._on_tray_open))
                    mi_browser = ToolStripMenuItem("Открывать в браузере")
                    try:
                        mi_browser.CheckOnClick = True
                        mi_browser.Checked = bool(config.get("open_in_browser"))
                    except Exception:  # noqa: BLE001
                        pass
                    mi_browser.add_CheckedChanged(
                        EventHandler(self._on_tray_browser_toggle))
                    mi_exit = ToolStripMenuItem("Закрыть")
                    mi_exit.add_Click(EventHandler(self._on_tray_exit))
                    cms.Items.Add(mi_open)
                    cms.Items.Add(mi_browser)
                    cms.Items.Add("-")
                    cms.Items.Add(mi_exit)
                    ni.ContextMenuStrip = cms
                    ni.add_MouseClick(MouseEventHandler(self._on_tray_mouse))
                    ni.Visible = True
                    box.append(ni)
                except Exception as e:  # noqa: BLE001
                    _log("tray: create error: %s" % e)
                finally:
                    done.set()

            try:
                if form.InvokeRequired:
                    form.Invoke(Action(_make))
                else:
                    _make()
                if not done.wait(10):
                    _log("tray: timeout creating icon")
                    return None
            except Exception as e:  # noqa: BLE001
                _log("tray: Invoke error: %s" % e)
                return None
            self._tray = box[0] if box else None
            return self._tray

        def _app_icon(self):
            """Иконка трея: assets/icons рядом с EXE, _MEIPASS, exe-иконка."""
            try:
                from System.Drawing import Icon
                cands = []
                base = _pick_app_dir()
                meipass = getattr(sys, "_MEIPASS", None)
                for root in filter(None, (base, meipass, app_dir)):
                    for name in ("app_icon.ico",
                                 os.path.join("assets", "icons", "app_icon.ico"),
                                 os.path.join("assets", "icons", "app_icon.png")):
                        cands.append(os.path.join(root, name))
                for p in cands:
                    if p and os.path.isfile(p):
                        try:
                            if p.lower().endswith(".ico"):
                                return Icon(p)
                            from System.Drawing import Bitmap
                            with Bitmap(p) as bmp:
                                h = bmp.GetHicon()
                                try:
                                    return Icon.FromHandle(h)
                                finally:
                                    pass
                        except Exception:  # noqa: BLE001
                            continue
                handle = __import__("ctypes").windll.kernel32.GetModuleHandleW(None)
                hicon = __import__("ctypes").windll.shell32.ExtractIconW(
                    handle, sys.executable, 0)
                if hicon:
                    from System.Drawing import Icon
                    return Icon.FromHandle(hicon)
            except Exception as e:  # noqa: BLE001
                _log("tray: icon error: %s" % e)
            return None

        def _on_tray_mouse(self, sender, event):
            # ЛКМ по иконке — показать окно; ПКМ отдана ContextMenuStrip
            try:
                from System.Windows.Forms import MouseButtons
                if event is not None and event.Button != MouseButtons.Left:
                    return
            except Exception:  # noqa: BLE001
                pass
            self.restore_from_tray()

        def _on_tray_open(self, sender, event):
            self.restore_from_tray()

        def _on_tray_browser_toggle(self, sender, event):
            try:
                config.set("open_in_browser", bool(sender.Checked))
                _log("tray: open_in_browser=%s" % sender.Checked)
            except Exception as e:  # noqa: BLE001
                _log("tray: browser toggle failed: %s" % e)

        def _on_tray_exit(self, sender, event):
            self.close_window()

        def minimize_to_tray(self):
            """Спрятать окно в трей (используется «Открыть в браузере»)."""
            win = self._win()
            if win is None:
                return False
            # без иконки не прячем: окно будет недостижимо
            if self._ensure_tray() is None:
                _log("tray: icon unavailable, window stays")
                return False
            try:
                win.hide()
            except Exception as e:  # noqa: BLE001
                _log("tray: hide error: %s" % e)
                return False
            _log("tray: window hidden to tray")
            return True

        def restore_from_tray(self):
            """Клик по иконке в трее: показать окно обратно."""
            try:
                win = self._win()
                if win is not None:
                    win.show()
            except Exception as e:  # noqa: BLE001
                pass
            # постоянная иконка не нужна, если пользователь не включил её в настройках
            if not config.get("tray_enabled"):
                self._tray_dispose()
            return True

        def toggle_fullscreen(self):
            """Полноэкранный режим окна (кнопка разворота таблицы сравнения).
            Системный fullscreen pywebview перекрывает панель задач — это
            ожидаемо только здесь, по явному запросу из fullscreen-модалки."""
            try:
                win = self._win()
                if win is not None:
                    win.toggle_fullscreen()
                    return True
            except Exception as e:  # noqa: BLE001
                _log("toggle_fullscreen: %s" % e)
            return False

        def apply_window_size(self, width, height):
            """Resize the window when the user picks a size preset in settings."""
            try:
                win = self._win()
                if win is not None:
                    w, h = _clamp_to_workarea(width, height)
                    win.resize(w, h)
                    _log("resize: %sx%s (asked %sx%s)" % (w, h, width, height))
                    return True
            except Exception as e:  # noqa: BLE001
                _log("resize: %s" % e)
            return False

    api = Api()
    win_w, win_h = _clamp_to_workarea(
        *WINDOW_SIZES.get(config.get("window_size", "normal"), (1280, 800)))
    _log("mode=pywebview window=%s size=%sx%s" % (url, win_w, win_h))

    # -- лаунчер: маленькое окно с логотипом и прогрессом проверки обновлений.
    # Живёт до сигнала main_ready от фронтенда (интерфейс + дерево загружены).
    # background_color = цвет темы: без него форма вспыхивает белым до отрисовки
    # страницы; x/y — явное центрирование (CenterScreen pywebview сломан).
    splash_x, splash_y = _center_xy(420, 280) or (None, None)
    api._splash = webview.create_window(
        "Terminator ToolSet",
        url + "splash",
        width=420,
        height=280,
        x=splash_x,
        y=splash_y,
        resizable=False,
        frameless=True,
        on_top=True,
        background_color="#1d1f24",
        js_api=api,
    )

    def _launch_main():
        # проверка обновлений в лаунчере (быстрый опрос воркера; найденный
        # релиз докачивается фоном, установка — следующим перезапуском)
        try:
            _check_updates(config, app, app_dir)
        except Exception as e:  # noqa: BLE001
            _log("update check error: %s" % e)
        _boot_ping(app, 12)
        try:
            main_x, main_y = _center_xy(win_w, win_h) or (None, None)
            api._main = webview.create_window(
                "Terminator ToolSet",
                url,
                width=win_w,
                height=win_h,
                x=main_x,
                y=main_y,
                # «Полный экран» НЕ через pywebview (безрамочная форма при
                # Maximized перекрывает панель задач): после создания окна
                # применяем ручной разворот на WorkingArea (_apply_maximize).
                frameless=True,         # custom title bar (no native window frame)
                easy_drag=False,        # dragging only via .pywebview-drag-region
                resizable=False,        # fixed window size per spec
                min_size=(900, 600),
                hidden=True,            # видно только после main_ready (лаунчер первым)
                background_color="#1d1f24",
                js_api=api,
            )
        except Exception as e:  # noqa: BLE001
            _log("main window error: %s" % e)
            raise
        _boot_ping(app, 18)
        # нативный DnD в окно (точные пути дропа в mailbox): форма
        # появляется на GUI-потоке асинхронно — ждём её недолго, ставим
        # строго в GUI-потоке (_form_invoke); ссылку на фильтр держим в
        # api._drop_filter, иначе GC убьёт колбэки
        _drop_form = None
        for _ in range(24):
            try:
                _w, _f = api._form()
            except Exception:  # noqa: BLE001
                _w, _f = None, None
            if _f is not None:
                _drop_form = _f
                break
            time.sleep(0.25)
        if _drop_form is not None:
            _drop_box: "list" = []

            def _drop_job(f):
                _drop_box.append(_install_drop_filter(f))
                return True

            api._form_invoke(_drop_job)
            api._drop_filter = _drop_box[0] if _drop_box else None
        else:
            _log("drop: no form, native drop disabled")
        # «Полный экран» из настроек: ручной разворот на WorkingArea
        # (панель задач остаётся видимой). Форма появляется на GUI-потоке
        # асинхронно - ждём её недолго (до ~6с), иначе разворот молча
        # пропускается.
        if config.get("fullscreen", False):
            for _ in range(24):
                if api._apply_maximize():
                    break
                time.sleep(0.25)
        # main_ready мог прийти, пока окно создавалось (спрятанное окно всё
        # равно грузит страницу) - тогда показать немедленно
        if api._ready:
            api._show_main()

    threading.Thread(target=_launch_main, daemon=True, name="launcher").start()
    threading.Thread(target=_boot_watchdog, daemon=True, name="bootwatch").start()
    # постоянный профиль вместо private temp-режима (см. комментарий выше);
    # на старых pywebview без этих аргументов - обычный запуск
    try:
        webview.start(private_mode=False, storage_path=storage)
    except TypeError:
        webview.start()


def _check_updates(config, app=None, app_dir=None):
    """Startup update check (launcher stage): fast worker query, daily
    throttle inside. A newer release downloads in the background (progress
    in the UI via /api/update_progress); install runs on the next restart
    from the pending flag. Returns the check dict or None on errors."""
    _boot_ping(app, 10)
    try:
        prog = (os.path.dirname(os.path.abspath(sys.executable))
                if getattr(sys, "frozen", False)
                else (app_dir or _pick_app_dir()))
        svc = Updates(config, _log, prog, _APP_VERSION)
        res = svc.check()
    except Exception as e:  # noqa: BLE001
        _log("update check error: %s" % e)
        _boot_ping(app, 12)
        return None
    _boot_ping(app, 12)
    if not res.get("ok"):
        _log("updates: check failed (%s)" % res.get("error"))
        return res
    avail = res.get("available")
    if not avail:
        _log("updates: up to date (%s)" % res.get("current"))
        return res
    _log("updates: %s available (%s)"
         % (avail.get("version"), avail.get("name")))
    try:
        if (svc.pending() or {}).get("version") != avail.get("version"):
            svc.download()
        else:
            _log("updates: %s already staged, waiting for restart"
                 % avail.get("version"))
    except Exception as e:  # noqa: BLE001
        _log("update download error: %s" % e)
    return res


def keep_alive():
    try:
        while True:
            threading.Event().wait(1)
    except KeyboardInterrupt:
        pass
