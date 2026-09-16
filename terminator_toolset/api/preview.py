"""Маршруты редактора preview_config: чтение и запись поз камеры.

GET /api/preview_configs?root=: имена *.config из basis/preview_config.
GET /api/preview_config?root=&name=: содержимое одного конфига JSON.
POST /api/preview_config_save {root, name, data}: запись конфига
(имя — безопасный стем, data.camera — числа как в игре).
Пути — внутри корня проекта, наружу не выходим.
"""
from __future__ import annotations

import json
import os
import re

_NAME_RE = re.compile(r"[A-Za-z0-9_\-]+(?:\.config)?")


def _cfg_dir(root: str) -> str:
    return os.path.join(root or "", "basis", "preview_config")


def _safe_name(name: str) -> str:
    n = str(name or "").strip()
    # Слэши запрещены в любом виде: только голое имя, наружу не выходим
    if not n or "/" in n or "\\" in n:
        return ""
    if not _NAME_RE.fullmatch(n):
        return ""
    return n if n.endswith(".config") else n + ".config"


def _num(x, default=0.0) -> float:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    return v if v == v and abs(v) != float("inf") else default


def _vec(x) -> dict:
    x = x if isinstance(x, dict) else {}
    return {"x": _num(x.get("x")), "y": _num(x.get("y")), "z": _num(x.get("z"))}


def _quat(x) -> dict:
    x = x if isinstance(x, dict) else {}
    return {"w": _num(x.get("w"), 1.0), "x": _num(x.get("x")),
            "y": _num(x.get("y")), "z": _num(x.get("z"))}


def register_preview(app, ctx):
    """Бэкенд редактора поз камеры для превью юнитов."""
    store = ctx.store

    @app.route("/api/preview_configs")
    def api_preview_configs():
        """Список конфигов превью в проекте."""
        from flask import jsonify, request
        root = store.normal(str(request.args.get("root") or ""))
        d = _cfg_dir(root)
        names = []
        try:
            if root and os.path.isdir(d):
                names = sorted(f for f in os.listdir(d)
                               if f.endswith(".config") and os.path.isfile(
                                   os.path.join(d, f)))
        except OSError:
            names = []
        return jsonify({"ok": True, "names": names})

    @app.route("/api/preview_config")
    def api_preview_config():
        """Содержимое одного конфига превью."""
        from flask import jsonify, request
        root = store.normal(str(request.args.get("root") or ""))
        name = _safe_name(request.args.get("name") or "")
        if not root or not name:
            return jsonify({"ok": False, "error": "bad_name"})
        p = os.path.join(_cfg_dir(root), name)
        if not os.path.isfile(p):
            return jsonify({"ok": False, "error": "no_file"})
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return jsonify({"ok": False, "error": "parse_failed"})
        return jsonify({"ok": True, "name": name, "data": data})

    @app.route("/api/preview_config_save", methods=["POST"])
    def api_preview_config_save():
        """Запись конфига превью (перезапись или новый файл)."""
        from flask import jsonify, request
        data = request.get_json(silent=True) or {}
        root = store.normal(str(data.get("root") or ""))
        name = _safe_name(data.get("name") or "")
        body = data.get("data")
        if not root or not name or not isinstance(body, dict):
            return jsonify({"ok": False, "error": "bad_name"})
        cam = body.get("camera")
        if not isinstance(cam, dict):
            return jsonify({"ok": False, "error": "bad_camera"})
        clean = {
            "camera": {
                "fov": _num(cam.get("fov"), 0.49),
                "origin": _vec(cam.get("origin")),
                "position": _vec(cam.get("position")),
                "rotation": _quat(cam.get("rotation")),
                "zoom": _num(cam.get("zoom"), 20.0),
            },
        }
        # Свет — из присланного (редактор его не трогает, но файл
        # обязан остаться полным): чистим только числа тем же фильтром.
        for key in ("directLight", "indirectLight"):
            if isinstance(body.get(key), dict):
                clean[key] = body[key]
        d = _cfg_dir(root)
        try:
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, name), "w", encoding="utf-8") as f:
                json.dump(clean, f, indent=4)
        except OSError:
            return jsonify({"ok": False, "error": "write_failed"})
        return jsonify({"ok": True, "name": name})
