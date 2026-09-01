"""Launch Terminator Sheet.

Runs the Flask backend on a random localhost port (background thread), then opens
a window pointed at it. Default mode is a native PySide6 frameless window
(QtWebEngineView + QWebChannel native bridge). With --browser (dev mode) a normal
web browser is used instead.

Config + SQLite database live in the folder next to this file (source) or next
to the executable (frozen).
"""
from __future__ import annotations

import os
import signal
import socket
import sys
import threading
import webbrowser

APP_DIR = os.path.dirname(os.path.abspath(__file__))

# QTWEBENGINE должен видеть эти флаги ДО создания QApplication, иначе Chromium:
#  - ошибочно считает видимое окно перекрытым (CalculateNativeWinOcclusion) и
#    троттлит отрисовку -> "низкая герцовка", ощущение замершего интерфейса;
#  - троттлит фоновые таймеры рендера.
# Ставим в самом начале модуля (до инициализации QtWebEngine).
os.environ.setdefault(
    "QTWEBENGINE_CHROMIUM_FLAGS",
    "--disable-background-timer-throttling --disable-renderer-backgrounding "
    "--disable-features=CalculateNativeWinOcclusion",
)


def _apply_chromium_flags(config):
    """Добавить к флагам QtWebEngine/Chromium доп. настройки из config
    (chromium_flags). Должно вызываться ДО инициализации QtWebEngine."""
    extra = config.get("chromium_flags", "") if config else ""
    if not extra:
        return
    cur = os.environ.get("QTWEBENGINE_CHROMIUM_FLAGS", "")
    os.environ["QTWEBENGINE_CHROMIUM_FLAGS"] = (cur + " " + extra).strip()

# Guarded: классы PySide6 нужны только для Bridge/окна. Если PySide6 нет,
# модуль остаётся импортируемым (dev --browser / браузер-fallback).
try:
    from PySide6.QtCore import QObject, Slot
    from PySide6.QtWidgets import QFileDialog
    ALLOW_QTSLOT = True
except Exception:  # noqa: BLE001
    QObject = object

    def Slot(*_a, **_k):
        def _decorator(fn):
            return fn
        return _decorator

    QFileDialog = None
    ALLOW_QTSLOT = False


def _exit_timeout(delay: float = 2.0) -> None:
    """Daemon-таймер принудительного выхода.

    НЕ блокирует чистую остановку QtWebEngine (не даёт процессу зависнуть в
    ожидании не-daemon потока), но гарантирует выход, если событийный цикл
    реально завис. Иначе os._exit(0) жёстко убивает WebEngine, не давая
    DXGI/композитору финализироваться -> "QDxgiVSyncService not destroyed in time".
    """
    t = threading.Timer(delay, lambda: os._exit(0))
    t.daemon = True
    t.start()


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _pick_app_dir() -> str:
    """Writable folder for config.json + sqlite db."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return APP_DIR


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


def build_app():
    from config import Config
    from database import Database
    from app import create_app

    base_dir = _pick_app_dir()          # writable: config + db live here
    config = Config(base_dir)
    db = Database(os.path.join(base_dir, "terminator_sheet.db"))

    # when frozen, templates/static/locales live in sys._MEIPASS
    assets_dir = getattr(sys, "_MEIPASS", None) or APP_DIR
    app = create_app(config, db, base_dir=assets_dir)
    return app, config, db, base_dir


def _serve(app, host: str, port: int):
    from werkzeug.serving import make_server
    srv = make_server(host, port, app, threaded=True)
    srv.serve_forever()


# ---------------------------------------------------------------------------
# PySide6 window (frameless QWebEngineView + QWebChannel native bridge)
# ---------------------------------------------------------------------------
def _qt_available() -> bool:
    try:
        from PySide6.QtCore import QObject, Slot  # noqa: F401
        from PySide6.QtWidgets import QApplication, QMainWindow, QFileDialog  # noqa: F401
        from PySide6.QtWebEngineWidgets import QWebEngineView  # noqa: F401
        from PySide6.QtWebEngineCore import QWebEngineScript  # noqa: F401
        from PySide6.QtWebChannel import QWebChannel  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


def _qt_shim_source() -> str:
    """JS for the pywebview-compatible bridge: qwebchannel.js + window.pywebview.api.

    Injected at DocumentCreation so index.html/app.js stay byte-identical. The
    JS already treats pywebview.api.* calls as promises, and QWebChannel resolves
    them with the slot's return value."""
    # qwebchannel.js is a Qt resource; importing QtWebChannel registers it
    from PySide6.QtCore import QFile
    qwc = ""
    f = QFile(":/qtwebchannel/qwebchannel.js")
    if f.open(QFile.ReadOnly):
        try:
            qwc = bytes(f.readAll()).decode("utf-8", "replace")
        finally:
            f.close()
    shim = r"""
;(function () {
  // Создаём фейк pywebview и его api; реально это мост QWebChannel.
  try {
    window.pywebview = window.pywebview || {};
    new QWebChannel(qt.webChannelTransport, function (channel) {
      if (channel.objects && channel.objects.bridge) {
        window.pywebview.api = channel.objects.bridge;
      }
      var ev = new Event('pywebviewready');
      window.dispatchEvent(ev);
      document.dispatchEvent(ev);
    });
  } catch (e) {
    console.error('PySide6 bridge init failed:', e);
  }

  // ---------- перетаскивание frameless-окна за шапку ----------
  // Тащим из любой точки шапки (.pywebview-drag-region), кроме интерактивных
  // элементов (кнопки, поля, вкладки-переключатели). Ярлыки no-drag на
  // контейнерах (brand/center/right) умышленно НЕ считаются препятствием —
  // иначе тащить не за что.
  var __drag = { on: false, lx: 0, ly: 0 };
  function __isCtl(t) {
    if (!t || !t.closest) return false;
    return !!t.closest(
      'button, input, select, textarea, a, label, [contenteditable="true"], ' +
      '.wc-btn, .window-controls, .tab-bar, [data-i18n-title]');
  }
  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    var region = e.target.closest ? e.target.closest('.pywebview-drag-region') : null;
    if (!region || __isCtl(e.target)) return;
    __drag.on = true;
    __drag.lx = e.screenX;
    __drag.ly = e.screenY;
    e.preventDefault();
  });
  document.addEventListener('mousemove', function (e) {
    if (!__drag.on) return;
    var dx = e.screenX - __drag.lx;
    var dy = e.screenY - __drag.ly;
    if (dx === 0 && dy === 0) return;
    __drag.lx = e.screenX;
    __drag.ly = e.screenY;
    if (window.pywebview && window.pywebview.api && window.pywebview.api.move_window) {
      try { window.pywebview.api.move_window(dx, dy); } catch (ke) { /* noop */ }
    }
  });
  document.addEventListener('mouseup', function () { __drag.on = false; });
  document.addEventListener('mouseleave', function () { __drag.on = false; });
})();
"""
    return qwc + "\n" + shim


class Bridge(QObject):
    """Native window + dialogs exposed to JS as window.pywebview.api."""

    def __init__(self, win):
        super().__init__()
        self._win = win

    @Slot(result=bool)
    def minimize(self):
        self._win.showMinimized()
        return True

    @Slot(result=bool)
    def toggle_maximize(self):
        w = self._win
        if w.isMaximized():
            w.showNormal()
            return False
        w.showMaximized()
        return True

    @Slot(result=bool)
    def is_maximized(self):
        return self._win.isMaximized()

    @Slot(result=bool)
    def close_window(self):
        try:
            self._win.close()
        except Exception:  # noqa: BLE001
            pass
        # safety net in case the Qt event loop does not exit on its own
        _exit_timeout()
        return True

    @Slot(int, int, result=bool)
    def apply_window_size(self, width, height):
        w = self._win
        if w.isMaximized():
            w.showNormal()
        ww, hh = _clamp_to_workarea(width, height)
        w.resize(ww, hh)
        _log("resize: %sx%s (asked %sx%s)" % (ww, hh, width, height))
        return True

    @Slot(int, int, result=bool)
    def move_window(self, dx, dy):
        w = self._win
        if w.isMaximized():
            return True
        w.move(w.x() + int(dx), w.y() + int(dy))
        return True

    @Slot(result=str)
    def pick_file(self):
        path, _ = QFileDialog.getOpenFileName(
            self._win, "Открыть XML", "", "XML (*.xml);;Все файлы (*.*)")
        return path or None

    @Slot(result=str)
    def pick_image(self):
        path, _ = QFileDialog.getOpenFileName(
            self._win, "Выбрать изображение", "",
            "Изображения (*.png;*.jpg;*.jpeg;*.bmp;*.webp;*.dds;*.tga);;Все файлы (*.*)")
        return path or None

    @Slot(result=str)
    def pick_folder(self):
        path = QFileDialog.getExistingDirectory(self._win, "Выбрать папку проекта")
        return path or None


def _run_qt(app, config, url, base_dir):
    from config import WINDOW_SIZES
    from PySide6.QtCore import Qt, QUrl, QTimer
    from PySide6.QtGui import QIcon
    from PySide6.QtWidgets import QApplication, QMainWindow
    from PySide6.QtWebEngineWidgets import QWebEngineView
    from PySide6.QtWebEngineCore import QWebEngineScript, QWebEnginePage
    from PySide6.QtWebChannel import QWebChannel

    class _Page(QWebEnginePage):
        """Печатает JS-ошибки в консоль, чтобы видеть сбои фронтенда."""

        def javaScriptConsoleMessage(self, level, message, lineNumber, sourceId):
            try:
                if int(level) >= 2:  # 2=warning, 3=error
                    print("[JS:%s] %s" % (lineNumber, message), file=sys.stderr)
            except Exception:  # noqa: BLE001
                pass

    qt_app = QApplication.instance() or QApplication(sys.argv)
    qt_app.setQuitOnLastWindowClosed(True)

    win = QMainWindow()
    win.setWindowTitle("Terminator Sheet")
    win.setWindowFlags(Qt.Window | Qt.FramelessWindowHint)
    win.setMinimumSize(900, 600)
    icon_path = os.path.join(base_dir, "assets", "icons", "app_icon.ico")
    if os.path.isfile(icon_path):
        icon = QIcon(icon_path)
        win.setWindowIcon(icon)
        qt_app.setWindowIcon(icon)

    view = QWebEngineView()
    win.setCentralWidget(view)
    page = _Page(view)
    view.setPage(page)

    # нативный мост: window.pywebview.api
    channel = QWebChannel()
    bridge = Bridge(win)
    channel.registerObject("bridge", bridge)
    page.setWebChannel(channel)

    # JS-шим (qwebchannel + мост + drag) на этапе DocumentCreation, main world
    script = QWebEngineScript()
    script.setName("pywebview-shim")
    script.setInjectionPoint(QWebEngineScript.DocumentCreation)
    script.setWorldId(QWebEngineScript.MainWorld)
    script.setRunsOnSubFrames(False)
    script.setSourceCode(_qt_shim_source())
    page.scripts().insert(script)

    size = WINDOW_SIZES.get(config.get("window_size", "normal"), (1280, 800))
    w, h = _clamp_to_workarea(*size)
    win.resize(w, h)
    view.setUrl(QUrl(url))

    # ---- Защита от «серого старта» QtWebEngine -----------------------------
    # Chromium иногда отдаёт страницу (HTML + статические ресурсы), но НЕ
    # исполняет JS: init() не доходит до /api/config, окно остаётся пустым,
    # нет даже кнопок окна (⌄ ▢ ✕ остаются hidden). Это и есть «через раз»,
    # «не запоминает проект» и «не закрывается».
    #
    # Решение не зависит от loadFinished/runJavaScript — в зависшем рендере
    # они молчат. Следим со стороны самого сервера: фронт в init() первым
    # делом шлёт GET /api/config. Если он не пришёл через пару секунд —
    # перезагружаем страницу (обычно 1-2 попытки лечатся).
    boot = {"seen": False, "tries": 0, "max": 6, "done": False}

    def _boot_request_hook():
        try:
            from flask import request as _req
            if _req.path == "/api/config":
                boot["seen"] = True
        except Exception:  # noqa: BLE001
            pass

    app.before_request(_boot_request_hook)

    def _watchdog():
        if boot["seen"]:
            if not boot["done"]:
                boot["done"] = True
                _log("boot watchdog: booted (config seen)")
            _boot_timer.stop()
            return
        if boot["tries"] >= boot["max"]:
            _log("boot watchdog: give up after %d reloads" % boot["tries"])
            _boot_timer.stop()
            return
        boot["tries"] += 1
        _log("boot watchdog: no config request, reload (try %d)" % boot["tries"])
        view.reload()

    _boot_timer = QTimer()
    _boot_timer.setInterval(2500)
    _boot_timer.timeout.connect(_watchdog)
    _boot_timer.start()

    # Отладочный хук: при TS_DIAG=1 снять состояние фронта, GPU и FPS и завершиться.
    if os.environ.get("TS_DIAG"):
        def _diag():
            # 1) Считаем FPS через requestAnimationFrame за ~1.2с (кладу в window.__fps)
            js1 = ("(function(){var s=0;var t0=performance.now();"
                   "function f(){s++;var e=performance.now();if(e-t0<1200){requestAnimationFrame(f);}"
                   "else{window.__fps=Math.round(s*1000/(e-t0));}};requestAnimationFrame(f);})()")
            # 2) Читаем unscoped renderer + fps + состояние
            js2 = ("(function(){var r='?';try{var cv=document.createElement('canvas');"
                   "var g=cv.getContext('webgl');"
                   "if(g){var ext=g.getExtension('WEBGL_debug_renderer_info');"
                   "r=(ext&&ext.UNMASKED_RENDERER_WEBGL)?String(g.getParameter(ext.UNMASKED_RENDERER_WEBGL)):String(g.getParameter(g.RENDERER));"
                   "}}catch(e){r='err';}"
                   "return JSON.stringify({fps:window.__fps||-1,renderer:r});})()")

            def step1(v):
                QTimer.singleShot(1500, _read)
            def _read():
                page.runJavaScript(js2, lambda v: (_log("diag: %s" % v),
                                                   QTimer.singleShot(200, lambda: os._exit(0))))
            page.runJavaScript(js1, step1)
        QTimer.singleShot(4000, _diag)

    if config.get("fullscreen"):
        win.showFullScreen()
    else:
        win.show()
    _log("mode=qt window=%s size=%sx%s" % (url, w, h))

    # Ctrl+C в консоли: закрыть окно так же чисто, как кнопка ✕, вместо
    # KeyboardInterrupt-трейсбека из exec() (PySide6 свой обработчик не ставит).
    def _sigint_handler(signum, frame):
        try:
            win.close()
            qt_app.quit()
        except Exception:  # noqa: BLE001
            pass
        # страховка: если событийный цикл QtWebEngine не выйдет сам
        _exit_timeout()

    signal.signal(signal.SIGINT, _sigint_handler)

    qt_app.exec()


def main(browser: bool = False):
    from config import WINDOW_SIZES
    app, config, db, base_dir = build_app()
    host = "127.0.0.1"
    port = _free_port()
    threading.Thread(target=_serve, args=(app, host, port), daemon=True).start()
    url = "http://%s:%d/" % (host, port)

    if browser or os.environ.get("TS_BROWSER"):
        _log("mode=browser %s" % url)
        webbrowser.open(url)
        print("Terminator Sheet dev server: %s" % url)
        _keep_alive()
        return

    # Основной режим: PySide6 frameless-окно (встроенный Chromium -> одинаковый вид)
    _apply_chromium_flags(config)
    if _qt_available():
        try:
            _run_qt(app, config, url, base_dir)
        except Exception as e:  # noqa: BLE001
            _log("qt window error: %s" % e)
            print("PySide6 window failed (%s) - fallback to browser" % e)
        return

    # Запасной режим: обычный браузер (PySide6/QtWebEngine недоступен)
    _log("mode=browser window=%s" % url)
    print("QtWebEngine unavailable - opening browser: %s" % url)
    webbrowser.open(url)
    _keep_alive()
    return




def _keep_alive():
    try:
        while True:
            threading.Event().wait(1)
    except KeyboardInterrupt:
        pass


def _log(msg: str):
    """Write a tiny boot/mode log next to the app (helps debug the frozen exe)."""
    try:
        with open(os.path.join(_pick_app_dir(), "boot.log"), "a", encoding="utf-8") as fh:
            fh.write("%s %s\n" % (__import__("time").strftime("%H:%M:%S"), msg))
    except Exception:  # noqa: BLE001
        pass


if __name__ == "__main__":
    _log("starting")
    main(browser="--browser" in sys.argv)
    _log("exited")
