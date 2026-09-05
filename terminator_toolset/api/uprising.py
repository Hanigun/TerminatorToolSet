"""Uprising routes: sector rewards, icons, balance configs, SWT dictionaries."""
from __future__ import annotations

import os

from flask import jsonify, request


def register_uprising(app, ctx):
    """Uprising map backend (all logic in the Uprising service)."""
    store, upr = ctx.store, ctx.upr

    # ---------- Карта Uprising (награды секторов в shop_presets.xml) ----------

    @app.route("/api/uprising_find", methods=["POST"])
    def api_uprising_find():
        """Найти shop_presets.xml DLC Resistance: проект мода или распакованная
        игра (кто чей root передал фронт)."""
        data = request.get_json(silent=True) or {}
        root = store.normal(data.get("root", ""))
        return jsonify(upr.find_shop(root))

    @app.route("/api/uprising_sysnames", methods=["POST"])
    def api_uprising_sysnames():
        """Справочник sysname всех юнитов/предметов проекта: первый столбец
        species-файлов basis + DLC-оверлеев (+ инвентарь). Для валидации чипов.
        cats: разбивка по категориям строго из своих файлов —
        cars/squads/tanks/helicopters/inventory_items (для автокомплита)."""
        data = request.get_json(silent=True) or {}
        root = store.normal(data.get("root", ""))
        return jsonify(upr.sysnames(root))

    @app.route("/api/uprising_prices", methods=["POST"])
    def api_uprising_prices():
        """Цены юнитов/предметов (колонка cost) по категориям: {cat: {sys: cost}}."""
        data = request.get_json(silent=True) or {}
        root = store.normal(data.get("root", ""))
        return jsonify(upr.prices(root))

    # ---------- Иконки юнитов/предметов для карты Uprising ----------
    # (owned by Uprising: species parsing, icon cache, dds conversion)
    @app.route("/api/uprising_icon")
    def api_uprising_icon():
        """PNG-иконка юнита/предмета карты Uprising по sysname. Сначала готовая
        webp (без конвертации), затем старый поиск dds; если файла иконки нет
        нигде - заглушка с «?»."""
        from flask import send_file
        root = store.normal(request.args.get("root", ""))
        name = (request.args.get("name") or "").strip()
        if name:
            hit = upr.icon_webp(root, name)
            if hit:
                try:
                    resp = send_file(
                        os.path.join(upr.webp_bucket_dir(hit[0]), hit[1]),
                        mimetype="image/webp")
                except OSError:
                    # файл есть в индексе, но отдать не смог (блокировка
                    # записью, удаление между listdir и send): транзиент, а не
                    # «иконки нет» — 503, фронт повторит по onerror; молча
                    # отдавать заглушку здесь было потерей иконки навсегда
                    return ("", 503)
                else:
                    resp.headers["Cache-Control"] = "public, max-age=86400, immutable"
                    return resp
        p = ""
        if name:
            ent = upr.icon_map(root).get(name)
            if ent:
                icon_rel, kind = ent
                p = upr.icon_file(root, icon_rel, kind)
                if p and p.lower().endswith(".dds"):
                    p = upr.dds_png(p) or ""
        if not p:
            p = upr.placeholder_png()
        if not p:
            return ("", 404)
        try:
            resp = send_file(p, mimetype="image/png")
        except OSError:
            return ("", 404)
        resp.headers["Cache-Control"] = "public, max-age=3600"
        return resp

    @app.route("/api/uprising_icon_preload", methods=["POST"])
    def api_uprising_icon_preload():
        """Прогрев: сконвертировать/найти иконки пачкой (параллельно), чтобы
        первые <img> на панели не ждали конвертации по одной."""
        data = request.get_json(silent=True) or {}
        root = store.normal(data.get("root", ""))
        return jsonify(upr.icon_preload(root, data.get("names")))

    @app.route("/api/uprising_icon_map", methods=["POST"])
    def api_uprising_icon_map():
        """sysname -> URL готовой webp-иконки одним запросом. Фронт ставит
        прямые <img>: ноль конвертации dds и сборки спрайта, дальше работает
        кэш браузера."""
        data = request.get_json(silent=True) or {}
        root = store.normal(data.get("root", ""))
        return jsonify(upr.icon_urls(root, data.get("names")))

    @app.route("/api/uprising_icons_data", methods=["POST"])
    def api_uprising_icons_data():
        """Все иконки одним запросом: {name: data:image/webp;base64,...}.
        Сервер отдаёт HTTP/1.0 без keep-alive — сотни отдельных <img> дают
        секунды оверхеда на соединения (≈5мс/шт); один ответ снимает
        проблему: фронт ставит data-URL напрямую, дальше всё из памяти."""
        data = request.get_json(silent=True) or {}
        root = store.normal(data.get("root", ""))
        return jsonify(upr.icons_data(root, data.get("names")))

    @app.route("/api/uprising_sprite", methods=["POST"])
    def api_uprising_sprite():
        """Спрайт иконок карты: одна PNG-полоса + раскладка {name: [x,y,w,h]}.
        Один запрос вместо сотен <img> — иконки видны сразу после открытия.
        Файл кэшируется на диске, ключ включает mtime исходников: повторное
        открытие той же карты — только stat-проверки, без конвертации."""
        data = request.get_json(silent=True) or {}
        root = store.normal(data.get("root", ""))
        return jsonify(upr.sprite(root, data.get("names")))

    @app.route("/api/uprising_sprite_file")
    def api_uprising_sprite_file():
        """Отдача закэшированного спрайта по ключу (hex 24)."""
        from flask import send_file
        p = upr.sprite_path(request.args.get("key"))
        if not p:
            return ("", 404)
        try:
            resp = send_file(p, mimetype="image/png")
        except OSError:
            return ("", 404)
        resp.headers["Cache-Control"] = "public, max-age=86400"
        return resp

    # ---------- Баланс-конфиг карты Uprising (.cfg) ----------
    # (owned by Uprising: cfg_write_file / cfg_read)
    @app.route("/api/uprising_cfg_write", methods=["POST"])
    def api_uprising_cfg_write():
        """Записать баланс-конфиг карты (.cfg). Формат остаётся строчным
        «Token - Key=Value - ...» (парсер совместим со старыми файлами), но
        колонки выровнены пробелами, зоны — секции с шапками, категории —
        подзаголовки. Разделители — строки комментариев, читатель их пропускает."""
        data = request.get_json(silent=True) or {}
        path = store.normal(data.get("path", ""))
        if not path:
            return jsonify({"ok": False, "error": "no path"})
        ok, res = upr.cfg_write_file(path, data)
        if not ok:
            return jsonify({"ok": False, "error": res})
        return jsonify({"ok": True, "path": path, "units": res})

    # -- пресеты карты Uprising -------------------------------------------
    # (owned by Uprising: preset_dirs / preset_find / preset_list / preset_save)
    @app.route("/api/uprising_presets", methods=["POST"])
    def api_uprising_presets():
        """Список пресетов: встроенные (из exe) + пользовательские."""
        return jsonify(upr.preset_list())

    @app.route("/api/uprising_preset_get", methods=["POST"])
    def api_uprising_preset_get():
        """Путь к файлу пресета — дальше читается тем же cfg_read."""
        data = request.get_json(silent=True) or {}
        return jsonify(upr.preset_get(data.get("kind", "built-in"),
                                      data.get("name", "")))

    @app.route("/api/uprising_preset_save", methods=["POST"])
    def api_uprising_preset_save():
        """Создать пользовательский пресет из текущего payload карты.
        Пишется тем же сериализатором, что баланс-конфиг."""
        data = request.get_json(silent=True) or {}
        return jsonify(upr.preset_save(data))

    @app.route("/api/uprising_cfg_read", methods=["POST"])
    def api_uprising_cfg_read():
        """Прочитать баланс-конфиг: зоны + юниты (структурированно)."""
        data = request.get_json(silent=True) or {}
        path = store.normal(data.get("path", ""))
        return jsonify(upr.cfg_read(path))

    # (owned by Uprising: program_dir / backup_dir / reset_map)
    @app.route("/api/uprising_reset", methods=["POST"])
    def api_uprising_reset():
        """ensure_only: снять чистую копию карты при первом открытии от корня.
        Иначе — сброс: восстановить shop_presets.xml из чистой копии и удалить
        баланс-конфиг. Копия снимается до первых правок, поэтому откат всегда
        в исходное состояние."""
        data = request.get_json(silent=True) or {}
        root = store.normal(data.get("root", ""))
        path = store.normal(data.get("path", ""))
        cfg_path = store.normal(data.get("cfg_path", ""))
        ensure_only = bool(data.get("ensure_only"))
        return jsonify(upr.reset_map(root, path, cfg_path, ensure_only))

    # ---------- Словари для подсказок SWT-редактора ----------
    # (owned by Uprising: scan_names / read_meta / swt_sources / unit_meta)
    @app.route("/api/upr_unit_meta", methods=["POST"])
    def api_upr_unit_meta():
        """Метаданные юнитов для рандомайзера Uprising: фракция (только
        squads.xml, колонка category, whitelist _UPR_FACTIONS; остальное —
        без фракции) и стоимость (cost из cars/tanks/squads/helicopters).
        Источники — открытый проект И/ИЛИ распакованная игра, как swt_sources."""
        data = request.get_json(silent=True) or {}
        return jsonify(upr.unit_meta(store.normal(data.get("project_root", "")),
                                     store.normal(data.get("unpacked_path", ""))))

    @app.route("/api/swt_sources", methods=["POST"])
    def api_swt_sources():
        """Словари значений для выпадающих подсказок SWT-редактора: sysname
        юнитов, экипажа, пресетов улучшений (отдельно car/tank/squad/heli),
        предметов, пресетов магазинов из species-файлов открытого проекта
        И/ИЛИ распакованной игры. Нет ни того, ни другого - пустые списки,
        редактор просто остаётся с текстовым вводом (фолбек без ошибок)."""
        data = request.get_json(silent=True) or {}
        return jsonify(upr.swt_sources(store.normal(data.get("project_root", "")),
                                       store.normal(data.get("unpacked_path", ""))))
