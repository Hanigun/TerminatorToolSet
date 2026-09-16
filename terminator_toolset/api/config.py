"""Config routes: read + validated write, mod sub-paths."""
from __future__ import annotations

from flask import jsonify, request

from ..domain.modroots import check_mod_structure as _check_mod
from ..domain.modroots import mod_subpaths as _mod_subpaths


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
        # Путь мода без ожидаемой структуры не принимаем: папка вида
        # «голые текстуры» вместо корня мода молча ломала бы древо «Мод»,
        # копирование в мод и превью. Пустое значение — отвязка (крестик),
        # она всегда разрешена. Саб-пути мягче: чистые текстуры/модели
        # могут лежать и голыми папками без basis/. Ответ несёт key+kind,
        # чтобы фронт показал попап и откатил именно это поле.
        if "mod_path" in data:
            mp = (data.get("mod_path") or "").strip()
            if mp:
                chk = _check_mod(mp)
                if not chk["ok"]:
                    return jsonify({"ok": False,
                                    "error": "bad_mod_structure",
                                    "key": "mod_path", "kind": "mod",
                                    "path": mp,
                                    "expected": chk["expected"],
                                    "found": chk["found"]})
        for key in ("mod_assets_path", "mod_models_path"):
            if key in data:
                ov = (data.get(key) or "").strip()
                if ov:
                    chk = _check_mod(ov, overlay=True)
                    if not chk["ok"]:
                        return jsonify({"ok": False,
                                        "error": "bad_overlay_structure",
                                        "key": key, "kind": "overlay",
                                        "path": ov,
                                        "expected": chk["expected"],
                                        "found": chk["found"]})
        for k, v in data.items():
            if k in config.data or k in ("theme", "language", "fullscreen", "auto_save",
                                         "default_key_column", "window_width", "window_height",
                                         "project_path", "guard_unpacked"):
                config.set(k, v)
        if "language" in data:
            i18n.switch(config.get("language"))
        # путь проекта стёрли в настройках — автооткрытие прошлого запуска
        # тоже гаснет, иначе last_project воскресит удалённый путь при рестарте
        if "project_path" in data and not config.get("project_path"):
            config.set("last_project", "")
        return jsonify({"ok": True})

    @app.route("/api/mod_subpaths")
    def api_mod_subpaths():
        """Саб-пути мода для саб-меню настроек: {textures, models} —
        [{rel, exists, where}]. ?root/?assets/?models — живой предпросмотр
        при наборе путей, иначе значения из конфига."""
        root = (request.args.get("root", "") or "").strip() \
            or (config.get("mod_path") or "")
        try:
            assets = (request.args.get("assets", "") or "").strip() \
                or (config.get("mod_assets_path")
                    or config.get("mod_overlay_path") or "").strip()
            models = (request.args.get("models", "") or "").strip() \
                or (config.get("mod_models_path") or "").strip()
        except Exception:  # noqa: BLE001
            assets, models = "", ""
        import os as _os
        if not root or not _os.path.isdir(root):
            return jsonify({"ok": False, "error": "no mod path"})
        return jsonify({"ok": True, "root": root,
                        "assets": assets, "models": models,
                        "groups": _mod_subpaths(root, assets, models)})
