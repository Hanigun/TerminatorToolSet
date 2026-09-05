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

    def _chunked(inner):
        def wsgi(environ, start_response):
            it = inner(environ, start_response)
            for data in it:
                if len(data) > 4096:
                    for i in range(0, len(data), 4096):
                        yield data[i:i + 4096]
                else:
                    yield data
        return wsgi

    return make_server(host, 0, _chunked(app.wsgi_app), threaded=True,
                       request_handler=_TSRequestHandler)
