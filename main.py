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

# Guarded: классы PySide6 нужны только для Bridge/окна. Если PySide6 нет,
# модуль остаётся импортируемым (dev --browser / запасной pywebview).
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
  var __drag = { on: false, lx: 0, ly: 0 };
  function __noDrag(t) { return t.closest && t.closest('.pywebview-no-drag'); }
  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    var region = e.target.closest ? e.target.closest('.pywebview-drag-region') : null;
    if (!region || __noDrag(e.target)) return;
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
        threading.Timer(2.0, lambda: os._exit(0)).start()
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

    # Отладочный хук: при TS_DIAG=1 снять состояние фронта и завершиться.
    if os.environ.get("TS_DIAG"):
        def _diag():
            js = ("(function(){"
                  " var c=document.getElementById('window-controls');"
                  " var sb=document.getElementById('sidebar');"
                  " var pt=document.getElementById('project-tree');"
                  " var gl=document.createElement('canvas').getContext('webgl');"
                  " var ren='?'; try{ ren=gl?gl.getParameter(gl.RENDERER):'no-gl'; }catch(e){ren='err';}"
                  " return JSON.stringify({api:(window.pywebview&&typeof window.pywebview.api),"
                  "  hidden:c?c.hidden:'no-el',"
                  "  sbHidden:sb?sb.hidden:'no-el',"
                  "  treeChildren:pt?pt.children.length:'no-el',"
                  "  treeHtmlLen:pt?pt.innerHTML.length:-1, renderer:String(ren)});})()")
            def cb(v):
                _log("diag: %s" % v)
                QTimer.singleShot(200, lambda: os._exit(0))
            page.runJavaScript(js, cb)
        QTimer.singleShot(4000, _diag)

    if config.get("fullscreen"):
        win.showFullScreen()
    else:
        win.show()
    _log("mode=qt window=%s size=%sx%s" % (url, w, h))

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
    if _qt_available():
        try:
            _run_qt(app, config, url, base_dir)
        except Exception as e:  # noqa: BLE001
            _log("qt window error: %s" % e)
            print("PySide6 window failed (%s) - fallback to browser" % e)
        return

    # Запасной режим: pywebview/WebView2
    try:
        import webview
    except Exception as e:  # noqa: BLE001
        _log("mode=browser-fallback (%s)" % e)
        print("pywebview unavailable (%s) - opening browser: %s" % (e, url))
        webbrowser.open(url)
        _keep_alive()
        return

    class Api:
        def _win(self):
            for w in webview.windows:
                if w is not None:
                    return w
            return None

        def _native_dialog(self, dialog_type, file_types=()):
            """
            Marshal WinForms file/folder dialog to the GUI thread.
            pywebview's js_api runs on a worker thread; ShowDialog must run on UI thread.
            """
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

        def minimize(self):
            try:
                win = self._win()
                if win is not None:
                    win.minimize()
            except Exception as e:  # noqa: BLE001
                _log("minimize: %s" % e)
            return True

        def toggle_maximize(self):
            win = self._win()
            if win is None:
                return False
            try:
                if win.maximized:
                    win.restore()
                else:
                    win.maximize()
                return bool(win.maximized)
            except Exception as e:  # noqa: BLE001
                _log("toggle_maximize: %s" % e)
                return False

        def close_window(self):
            try:
                win = self._win()
                if win is not None:
                    win.destroy()
            except Exception:  # noqa: BLE001
                pass
            # safety net in case the webview loop does not exit on its own
            threading.Timer(2.0, lambda: os._exit(0)).start()
            return True

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
    _log("mode=pywebview window=%s" % url)
    win_w, win_h = _clamp_to_workarea(*WINDOW_SIZES.get(config.get("window_size", "normal"), (1280, 800)))
    webview.create_window(
        "Terminator Sheet",
        url,
        width=win_w,
        height=win_h,
        fullscreen=bool(config.get("fullscreen", False)),
        frameless=True,         # custom title bar (no native window frame)
        easy_drag=False,        # dragging only via .pywebview-drag-region
        resizable=False,        # fixed window size per spec
        min_size=(900, 600),
        js_api=api,
    )
    webview.start()


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
