"""Фоновый прогрев текстур: старт/статус/стоп.

POST /api/warmup_start {root?}: прогон DDS->WebP по слоям корня
(у мода — плюс саб-пути). Пустой/битый root — не 400, а первый доступный
корень из настроек (мод → проект → игра): кнопка в шапке обязана
работать, даже если древо ещё не поднялось. Совсем нечего греть —
{ok: False, error: bad root} как раньше.
GET /api/warmup_status: {running, phase, root, total, done,
current, failed, stopped} для прогресс-бара (опрос раз в секунду).
POST /api/warmup_stop: мягкая остановка после текущего файла.
"""
from __future__ import annotations

import os


def _fallback_root(ctx, store):
    """Первый живой корень (мод → проект → игра) для старта без root."""
    try:
        from .units import _known_roots as _roots
        known = _roots(ctx) or {}
    except Exception:  # noqa: BLE001
        known = {}
    for key in ("mod", "project", "game"):
        try:
            r = store.normal(known.get(key) or "")
        except Exception:  # noqa: BLE001
            r = known.get(key) or ""
        if r and os.path.isdir(r):
            return r
    return ""


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
        # normpath("") даёт "." — а isdir(".") правда всегда (cwd):
        # точку считаем пустым запросом, иначе грелась бы папка программы
        if root in ("", ".") or not os.path.isdir(root):
            root = _fallback_root(ctx, store)
        if root in ("", ".") or not os.path.isdir(root):
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
