"""Config routes: read + validated write."""
from __future__ import annotations

from flask import jsonify, request


def register_config(app, ctx):
    """GET/POST /api/config (i18n switch on language change)."""
    config, i18n = ctx.config, ctx.i18n

    # -- API: config / i18n ---------------------------------------------------
    @app.route("/api/config")
    def api_config():
        return jsonify(config.data)

    @app.route("/api/config", methods=["POST"])
    def api_config_set():
        data = request.get_json(silent=True) or {}
        for k, v in data.items():
            if k in config.data or k in ("theme", "language", "fullscreen", "auto_save",
                                         "default_key_column", "window_width", "window_height",
                                         "project_path", "guard_unpacked"):
                config.set(k, v)
        if "language" in data:
            i18n.switch(config.get("language"))
        return jsonify({"ok": True})
