"""GameAssets routes: state/check/download/progress (owned by GameAssets)."""
from __future__ import annotations

from flask import jsonify


def register_game_assets(app, ctx):
    """Состояние архива GameAssets, проверка и фоновое скачивание."""
    ga = ctx.ga

    @app.route("/api/game_assets_state")
    def api_game_assets_state():
        """Флаг скачивания, версия, наличие папки на диске, прогресс."""
        return jsonify(ga.state())

    @app.route("/api/game_assets_check", methods=["POST"])
    def api_game_assets_check():
        """Спросить воркер /gameassets о свежем архиве."""
        return jsonify(ga.check())

    @app.route("/api/game_assets_download", methods=["POST"])
    def api_game_assets_download():
        """Скачать и распаковать архив в фоне (прогресс через polling)."""
        return jsonify(ga.download())

    @app.route("/api/game_assets_progress")
    def api_game_assets_progress():
        """Прогресс скачивания/распаковки для прогресс-бара."""
        return jsonify({"ok": True, "progress": ga.progress()})
