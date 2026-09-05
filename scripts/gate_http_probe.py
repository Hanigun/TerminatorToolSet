# -*- coding: utf-8 -*-
"""Gate G4: HTTP-зонд страницы и загрузочных эндпоинтов.

Воспроизводит продовый стек целиком (werkzeug make_server + _chunked обёртка
и NODELAY из main._serve) и читает ответы ДО КОНЦА с таймаутом: любой подвисший
или обрезанный ответ (симптом «страница в браузере грузится бесконечно»)
роняет гейт.
"""
import json
import os
import socket
import sys
import tempfile
import threading
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

from config import Config  # noqa: E402
from database import Database  # noqa: E402
from app import create_app  # noqa: E402
from main import _serve  # noqa: E402

tmp = tempfile.mkdtemp()
app = create_app(Config(tmp), Database(os.path.join(tmp, "t.db")))

srv = _serve(app, "127.0.0.1")
host, port = srv.server_address[0], srv.server_address[1]
t = threading.Thread(target=srv.serve_forever, daemon=True)
t.start()

socket.setdefaulttimeout(20)


def fetch(path):
    url = "http://%s:%d%s" % (host, port, path)
    with urllib.request.urlopen(url, timeout=20) as resp:
        return resp.status, resp.read()


try:
    st, body = fetch("/")
    assert st == 200 and b"</html>" in body[-200:], "FAIL: / incomplete"
    html = body.decode("utf-8", "replace")
    # страницы-оверлеи на месте
    for token in ("id=\"compare-tab\"", "id=\"swt-tab\"", "id=\"uprising-tab\"",
                  "id=\"welcome-tab\""):
        assert token in html, "FAIL: / missing %s" % token

    st, body = fetch("/api/config")
    assert st == 200 and isinstance(json.loads(body.decode("utf-8")), dict), \
        "FAIL: /api/config"

    st, body = fetch("/api/i18n")
    assert st == 200 and isinstance(json.loads(body.decode("utf-8")), dict), \
        "FAIL: /api/i18n"

    # большой статический файл: полный ответ без обрыва (баг >64КБ),
    # повторно + параллельно — эпизодические зависания роняют гейт
    st, body = fetch("/static/js/app.js")
    assert st == 200 and len(body) > 100000, "FAIL: app.js truncated (%d)" % len(body)
    assert b"cmpFocusSearch" in body, "FAIL: app.js content missing"
    expected = len(body)
    threads = []
    results = []

    def _worker():
        try:
            _, b2 = fetch("/static/js/app.js")
            results.append(len(b2))
        except Exception as e:  # noqa: BLE001
            results.append(str(e))

    for _ in range(8):
        th = threading.Thread(target=_worker)
        th.start()
        threads.append(th)
    for th in threads:
        th.join(30)
    for r in results:
        assert r == expected, "FAIL: parallel app.js fetch broken: %r" % (r,)

    st, body = fetch("/api/game_tree")
    assert st == 200, "FAIL: /api/game_tree status"
    j = json.loads(body.decode("utf-8"))
    assert "ok" in j, "FAIL: /api/game_tree json"
finally:
    srv.shutdown()

print("HTTP PROBE OK")
