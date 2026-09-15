"""GameAssets routes: state/scan/extract/progress (owned by GameAssets)."""
from __future__ import annotations

from flask import jsonify, request


def register_game_assets(app, ctx):
    """Состояние ассетов, сканирование паков игры и фоновая выборочная
    распаковка (никакого скачивания — только локальные паки)."""
    ga = ctx.ga

    @app.route("/api/game_assets_state")
    def api_game_assets_state():
        """Флаг готовности, версия, наличие папки на диске, прогресс."""
        return jsonify(ga.state())

    @app.route("/api/game_assets_scan", methods=["POST"])
    def api_game_assets_scan():
        """Что будет распаковано из папки игры: группы, паки, языки."""
        body = request.get_json(silent=True, force=True) or {}
        return jsonify(ga.scan(body.get("path") or ""))

    @app.route("/api/game_assets_extract", methods=["POST"])
    def api_game_assets_extract():
        """Выборочно распаковать ассеты из паков в фоне (polling прогресса)."""
        body = request.get_json(silent=True, force=True) or {}
        return jsonify(ga.extract(body.get("path") or "",
                                  body.get("langs") or []))

    @app.route("/api/game_assets_progress")
    def api_game_assets_progress():
        """Прогресс распаковки для мини-бара попапа."""
        return jsonify({"ok": True, "progress": ga.progress()})
