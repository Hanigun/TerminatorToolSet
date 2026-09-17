"""Фоновый прогрев текстур: старт/статус/стоп.

POST /api/warmup_start {root?}: прогон DDS->WebP по слоям корня
(у мода — плюс саб-пути). Без root — корень текущего древа
на фронте, сюда root обязателен явно: пустой запрос = 400.
GET /api/warmup_status: {running, phase, root, total, done,
current, failed, stopped} для прогресс-бара (опрос раз в секунду).
POST /api/warmup_stop: мягкая остановка после текущего файла.
"""
from __future__ import annotations

import os


def register_warmup(app, ctx):
    """Прогрев webp-кэша в фоне; менеджер — ctx.warmup (app.py)."""
    store = ctx.store

    @app.route("/api/warmup_start", methods=["POST"])
    def api_warmup_start():
        from flask import jsonify, request
        data = request.get_json(silent=True) or {}
        try:
            root = store.normal(str(data.get("root") or ""))
        except Exception:  # noqa: BLE001
            root = str(data.get("root") or "")
        if not root or not os.path.isdir(root):
            return jsonify({"ok": False, "error": "bad root"})
        try:
            st = ctx.warmup.start(root)
        except Exception:  # noqa: BLE001
            return jsonify({"ok": False, "error": "busy"})
        return jsonify({"ok": True, "status": st})

    @app.route("/api/warmup_status")
    def api_warmup_status():
        from flask import jsonify
        try:
            return jsonify({"ok": True, "status": ctx.warmup.status()})
        except Exception:  # noqa: BLE001
            return jsonify({"ok": False, "error": "busy"})

    @app.route("/api/warmup_stop", methods=["POST"])
    def api_warmup_stop():
        from flask import jsonify
        try:
            return jsonify({"ok": True,
                            "status": ctx.warmup.stop()})
        except Exception:  # noqa: BLE001
            return jsonify({"ok": False, "error": "busy"})
