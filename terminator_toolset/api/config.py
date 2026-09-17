"""Config routes: read + validated write."""
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
        # галка фонового прогрева: только что подключённый проект/мод
        # греем один раз (once-учёт в warmup_done); повторные сейвы тех
        # же путей молчат, ручной прогон — кнопкой в шапке в любой момент
        try:
            if config.get("warmup_auto"):
                try:
                    done = list(config.get("warmup_done") or [])
                except Exception:  # noqa: BLE001
                    done = []
                import os as _os
                for _key in ("project_path", "mod_path"):
                    if _key not in data:
                        continue
                    _v = (config.get(_key) or "").strip()
                    if not _v or not _os.path.isdir(_v):
                        continue
                    try:
                        _n = _os.path.normcase(_os.path.normpath(_v))
                    except Exception:  # noqa: BLE001
                        continue
                    if _n in done:
                        continue
                    try:
                        ctx.warmup.start(_v)
                    except Exception:  # noqa: BLE001
                        continue
                    done.append(_n)
                config.set("warmup_done", done)
        except Exception:  # noqa: BLE001
            pass
        return jsonify({"ok": True})

    @app.route("/api/mod_subpaths")
    def api_mod_subpaths():
        """Саб-пути мода: {textures, models} — [{rel, exists, where}].
        Currently unused (статус-лист из настроек убран) — оставить
        для будущего. ?root/?assets/?models, иначе значения из конфига."""
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
