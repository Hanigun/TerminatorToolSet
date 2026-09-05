# -*- coding: utf-8 -*-
"""Gate G3: бэкенд-поведение для нового батча фиксов.

- config: ключ browser_to_tray есть в DEFAULTS и сохраняется через /api/config
- window: окно создаётся hidden + maximized (панель задач не перекрывается),
  есть minimize_to_tray / restore_from_tray / toggle_fullscreen
  (оконный код живёт в terminator_toolset/infrastructure/window.py;
  main.py — тонкий запуск)
- регресс: py_compile, test_api, test_roundtrip, verify_history
"""
import os
import py_compile
import subprocess
import sys
import tempfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

from config import Config, DEFAULTS  # noqa: E402
from database import Database  # noqa: E402
from app import create_app  # noqa: E402

assert "browser_to_tray" in DEFAULTS, "FAIL: browser_to_tray missing from DEFAULTS"

tmp = tempfile.mkdtemp()
cfg = Config(tmp)
db = Database(os.path.join(tmp, "t.db"))
app = create_app(cfg, db)
c = app.test_client()

r = c.post("/api/config", json={"browser_to_tray": True})
assert r.get_json().get("ok"), r.get_json()
r = c.get("/api/config")
assert r.get_json().get("browser_to_tray") is True, \
    "FAIL: /api/config did not persist browser_to_tray"

win_py = open(os.path.join(BASE, "terminator_toolset", "infrastructure",
                             "window.py"), encoding="utf-8").read()
for token in ("hidden=True", "def minimize_to_tray", "def restore_from_tray",
              "def toggle_fullscreen", "_apply_maximize", "WorkingArea"):
    assert token in win_py, "FAIL: window.py missing %r" % token
# безрамочное окно: ни pywebview-fullscreen/maximized, ни showMaximized/
# showFullScreen — все они перекрывают панель задач Windows
for bad in ("maximized=bool(", "fullscreen=bool(config.get",
            "win.showMaximized()", "win.showFullScreen()"):
    assert bad not in win_py, "FAIL: window.py uses %r (covers the taskbar)" % bad

for mod in ("app.py", "main.py", "config.py", "swt_editor.py"):
    py_compile.compile(os.path.join(BASE, mod), doraise=True)

for args in (["-m", "tests.test_api"], ["-m", "tests.test_roundtrip"],
             ["scripts/verify_history.py"]):
    p = subprocess.run([sys.executable] + args, cwd=BASE,
                       capture_output=True, text=True)
    assert p.returncode == 0, "FAIL: %s\n%s\n%s" % (args, p.stdout[-2000:], p.stderr[-2000:])

print("BACKEND OK")
