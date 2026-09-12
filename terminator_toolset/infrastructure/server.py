"""Embedded HTTP server: random localhost port, socket-bug workarounds.

Two live-stack workarounds (waitress hangs the same way, so the fault is in
the sockets layer, not the server):
  1) single body writes >64KB stall occasionally -> WSGI wrapper splits
     bodies into 4KB chunks + TCP_NODELAY;
  2) keep-alive connections stall after a big response (browser sends the
     next request but the handler never reads it -> page loads forever
     until F5) -> HTTP/1.0, connection closed after every response.
     Overhead on localhost is negligible.
"""
from __future__ import annotations


def _chunked(inner):
    def wsgi(environ, start_response):
        # БЕЗ wsgi.file_wrapper: через него werkzeug отдаёт статику одним
        # вызовом os.sendfile — мимо 4KB-нарезки ниже, а одиночные записи
        # >64KB именно так иногда и виснут (см. шапку). Обычной итерацией
        # читаем с диска чуть медленнее, на localhost незаметно.
        try:
            environ.pop("wsgi.file_wrapper", None)
        except Exception:  # noqa: BLE001
            pass
        it = inner(environ, start_response)
        for data in it:
            if len(data) > 4096:
                for i in range(0, len(data), 4096):
                    yield data[i:i + 4096]
            else:
                yield data
    return wsgi


# -- server factory -------------------------------------------------------------
def serve(app, host: str):
    """Bind a random port NOW and return the server (serve_forever runs on
    a background thread in the caller). Binding immediately (not picking a
    free port first) avoids the race where another process grabs the port
    between check and bind, leaving all frontend fetches hanging."""
    from werkzeug.serving import make_server, WSGIRequestHandler

    class _TSRequestHandler(WSGIRequestHandler):
        disable_nagle_algorithm = True
        protocol_version = "HTTP/1.0"   # no keep-alive (see module docstring)

    return make_server(host, 0, _chunked(app.wsgi_app), threaded=True,
                       request_handler=_TSRequestHandler)


def swap_app(srv, flask_app) -> None:
    """Hot-swap WSGI-приложения живого сервера (стадия boot_swap): лаунчер
    уже виден, boot-Flask отдаёт только splash/progress — подменяем callable
    на полное приложение без перебинда порта. werkzeug читает server.app
    на каждый запрос, подмена одного атрибута атомарна; запросы in-flight
    добиваются на старом callable."""
    srv.app = _chunked(flask_app.wsgi_app)


def wait_ready(url: str, timeout: float = 10.0):
    """Живой HTTP-самопробник сервера (стадия boot_health): настоящий GET
    /api/boot_progress через сокет, а не in-process вызов. Возвращает
    (ok, detail)."""
    import time as _t
    import urllib.request as _u
    t0 = _t.time()
    last = "timeout"
    while _t.time() - t0 < timeout:
        try:
            with _u.urlopen(url + "api/boot_progress", timeout=2) as r:
                body = r.read(512)
                if r.status == 200:
                    try:
                        import json as _j
                        if _j.loads(body.decode("utf-8", "replace")).get("ok"):
                            return True, "http ok"
                        last = "no ok flag"
                    except Exception as e:  # noqa: BLE001
                        last = "bad json: %s" % e
                else:
                    last = "status %s" % r.status
        except Exception as e:  # noqa: BLE001
            last = str(e)[:120]
        _t.sleep(0.15)
    return False, last
