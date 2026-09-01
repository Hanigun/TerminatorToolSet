"""Launch Terminator Sheet.

Runs the Flask backend on a random localhost port (background thread), then opens
a pywebview window (native WebView2) pointed at it. With --browser (dev mode) a
normal web browser is used instead.

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
    from config import Config, WINDOW_SIZES
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

        def is_maximized(self):
            win, form = self._form()
            if form is None:
                return False
            try:
                from System.Windows.Forms import FormWindowState
                return form.WindowState == FormWindowState.Maximized
            except Exception as e:  # noqa: BLE001
                _log("is_maximized: %s" % e)
                return False

        def toggle_maximize(self):
            win, form = self._form()
            if form is None:
                return False
            try:
                from System.Windows.Forms import FormWindowState
                if form.WindowState == FormWindowState.Maximized:
                    win.restore()
                else:
                    win.maximize()
                return self.is_maximized()
            except Exception as e:  # noqa: BLE001
                _log("toggle_maximize: %s" % e)
                return False

        def close_window(self):
            # Used for in-app close button (works even in fullscreen where the
            # title-bar X is hidden by pywebview's borderless fullscreen).
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
