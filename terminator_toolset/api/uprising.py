"""Uprising routes: sector rewards, icons, balance configs, SWT dictionaries."""
from __future__ import annotations

import os

from flask import jsonify, request


def register_uprising(app, ctx):
    """Uprising map backend (all logic in the Uprising service)."""
    store, upr, files, saves = ctx.store, ctx.upr, ctx.files, ctx.saves

    def _journaled(path, summary, call):
        """Whole-file write with a file_write journal record: stash the
        pre-write bytes first, commit the record on success (plus the
        first-save origin snapshot). Returns the service result (dict or
        (ok, value) tuple — both shapes are used here)."""
        snap = saves.stash_file(path or "")
        res = call()
        ok = (res.get("ok") if isinstance(res, dict)
              else bool(res and res[0]))
        if ok:
            saves.snapshot_origin(path or "")
            files.commit_file_write(path or "", summary, snap)
        return res

    # ---------- Карта Uprising (награды секторов в shop_presets.xml) ----------

    @app.route("/api/uprising_find", methods=["POST"])
    def api_uprising_find():
        """Найти файл карты по содержимому (награды секторов): проект мода
        или распакованная игра (кто чей root передал фронт). Путь файла
        ничего не решает — только содержимое."""
        data = request.get_json(silent=True) or {}
        root = store.normal(data.get("root", ""))
        return jsonify(upr.find_shop(root))

    @app.route("/api/uprising_sniff", methods=["POST"])
    def api_uprising_sniff():
        """Контентный детект для дабл-клика в древе: этот shop_presets.xml —
        файл карты (секторы -> открыть картой) или обычная таблица?
        Файл с рабочего стола, лежащий где угодно, опознаётся так же.
        Кроме флага uprising отдаёт счётчики sector/shop/named: чисто
        секторный открывает карта, чисто магазинный — кампания, смешанный
        (есть и те, и другие) решает приоритет пути."""
        data = request.get_json(silent=True) or {}
        path = store.normal(data.get("path", ""))
        return jsonify({"ok": True, **upr.sniff_shop(path)})

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

    # ЭКСПЕРИМЕНТ «слот техники» (откат: удалить роут + capacity в сервисе
    # + vehDecor на фронте)
    @app.route("/api/unit_capacity", methods=["POST"])
    def api_unit_capacity():
        """Пассажирские места техники: {sysname: people_capacity}
        из cars/tanks/helicopters.xml — для полосы 0/N на слоте."""
        data = request.get_json(silent=True) or {}
        root = store.normal(data.get("root", ""))
        return jsonify(upr.capacity(root))

    # ЭКСПЕРИМЕНТ «слот пехоты» (откат: удалить роут + squad_size в сервисе)
    @app.route("/api/squad_size", methods=["POST"])
    def api_squad_size():
        """Размер отряда: {sysname: members-total} из squads.xml —
        для шильдика N/N слева внизу слота."""
        data = request.get_json(silent=True) or {}
        root = store.normal(data.get("root", ""))
        return jsonify(upr.squad_size(root))

    # ---------- Иконки юнитов/предметов для карты Uprising ----------
    # (owned by Uprising: species parsing, icon cache, dds conversion)
    @app.route("/api/uprising_icon")
    def api_uprising_icon():
        """PNG-иконка юнита/предмета карты Uprising по sysname. Сначала готовая
        webp (без конвертации), затем старый поиск dds; если файла иконки нет
        нигде - плейсхолдер категории (?cat=cars|tanks|helicopters|squads|
        inventory_items), в крайнем случае серая заглушка с «?» (не 404)."""
        from flask import send_file
        root = store.normal(request.args.get("root", ""))
        name = (request.args.get("name") or "").strip()
        cat = (request.args.get("cat") or "").strip()
        if name:
            hit = upr.icon_webp(root, name)
            if hit:
                try:
                    resp = send_file(
                        os.path.join(upr.webp_bucket_dir(hit[0]),
                                     *hit[1].split("/")),
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
                    # Мисс пишет в ОБЩИЙ persistent-кэш
                    # CustomImages/<area>/<owner>/icons/{stem}.webp, а не
                    # в temp-png: иначе каждая холодная загрузка гонит сотни
                    # одноразовых конвертаций и ничего не хранит.
                    p = upr.dds_webp(p, root=root, kind="icon") or ""
        if not p and cat:
            ph = upr.category_placeholder(cat, name)
            if ph:
                try:
                    resp = send_file(ph, mimetype="image/webp")
                except OSError:
                    pass
                else:
                    resp.headers["Cache-Control"] = "public, max-age=3600"
                    return resp
        if not p:
            p = upr.placeholder_png()
        if not p:
            return ("", 404)
        try:
            # p — готовый файл: dds уже ушёл в png-кэш выше, но через
            # webp-вариант icon_file может вернуть bundled .webp напрямую
            mime = ("image/webp" if p.lower().endswith(".webp")
                    else "image/png")
            resp = send_file(p, mimetype=mime)
        except OSError:
            return ("", 404)
        resp.headers["Cache-Control"] = "public, max-age=3600"
        return resp

    @app.route("/api/uprising_species_file", methods=["POST"])
    def api_uprising_species_file():
        """Species XML с нужным sysname для «Открыть в таблице» с карты:
        базовый файл категории, затем DLC-оверлеи (первый содержащий имя)."""
        data = request.get_json(silent=True) or {}
        root = store.normal(data.get("root", ""))
        return jsonify(upr.species_file(root, data.get("cat", ""),
                                        data.get("name", "")))

    @app.route("/api/uprising_convert", methods=["POST"])
    def api_uprising_convert():
        """Bulk DDS -> CustomImages WebP (кнопка «Анализ» на карте): один
        запрос вместо сотен одиночных конвертаций. Возвращает счётчики
        {converted, ready, missing, failed}."""
        data = request.get_json(silent=True) or {}
        root = store.normal(data.get("root", ""))
        return jsonify(upr.convert_missing(root, data.get("names")))

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

    @app.route("/api/uprising_icon_states", methods=["POST"])
    def api_uprising_icon_states():
        """Состояния иконок {name: {hover, selected}} одним запросом:
        сиблинги исходника (_preselected/_selected, _o/_s) тем же dds->webp
        в CustomImages; URL готовых webp (кэш браузера). Нет сиблинга —
        ключа нет, фронт оставляет базовую иконку."""
        data = request.get_json(silent=True) or {}
        root = store.normal(data.get("root", ""))
        return jsonify(upr.icon_states(root, data.get("names")))

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
        res = _journaled(path, "balance config written",
                         lambda: upr.cfg_write_file(path, data))
        ok, val = res
        if not ok:
            return jsonify({"ok": False, "error": val})
        return jsonify({"ok": True, "path": path, "units": val})

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

    # -- режимы рандомайзера v2 -------------------------------------------
    # (owned by Uprising: rnd_dirs / rnd_mode_get / rnd_mode_save /
    # rnd_mode_delete / rnd_mode_duplicate / rnd_convert_v1)
    @app.route("/api/uprising_rnd_modes", methods=["POST"])
    def api_uprising_rnd_modes():
        """Список режимов рандомайзера v2: встроенные + пользовательские."""
        return jsonify(upr.rnd_list())

    @app.route("/api/uprising_rnd_mode_get", methods=["POST"])
    def api_uprising_rnd_mode_get():
        """Прочитать режим: v2 парсингом, v1 — как есть (только чтение)."""
        data = request.get_json(silent=True) or {}
        return jsonify(upr.rnd_mode_get(data.get("kind", "any"),
                                        data.get("name", "")))

    @app.route("/api/uprising_rnd_mode_save", methods=["POST"])
    def api_uprising_rnd_mode_save():
        """Сохранить режим: пишет только в Custom, встроенные не трогаем."""
        data = request.get_json(silent=True) or {}
        return jsonify(upr.rnd_mode_save(data))

    @app.route("/api/uprising_rnd_mode_delete", methods=["POST"])
    def api_uprising_rnd_mode_delete():
        """Удалить только свой режим (встроенные удалять нельзя)."""
        data = request.get_json(silent=True) or {}
        return jsonify(upr.rnd_mode_delete(data.get("name", "")))

    @app.route("/api/uprising_rnd_mode_duplicate", methods=["POST"])
    def api_uprising_rnd_mode_duplicate():
        """Дублировать режим в Custom под новым именем."""
        data = request.get_json(silent=True) or {}
        return jsonify(upr.rnd_mode_duplicate(data.get("src", ""),
                                              data.get("name", "")))

    @app.route("/api/uprising_rnd_convert_v1", methods=["POST"])
    def api_uprising_rnd_convert_v1():
        """Преобразовать v1-пресет (ZONE) в режим v2 (копия в Custom)."""
        data = request.get_json(silent=True) or {}
        return jsonify(upr.rnd_convert_v1(data.get("kind", "built-in"),
                                          data.get("name", ""),
                                          data.get("new_name", "")))

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
        юнитов (общий + строго по типам car/tank/squad/heli), экипажа,
        пресетов улучшений (отдельно car/tank/squad/heli), предметов,
        пресетов магазинов из species-файлов открытого проекта
        И/ИЛИ распакованной игры. Скоп по пути файла: DLC .swt видит
        ТОЛЬКО свой DLC-оверлей, базовый .swt - только базу. Нет ни того,
        ни другого - пустые списки, редактор просто остаётся с текстовым
        вводом (фолбек без ошибок)."""
        data = request.get_json(silent=True) or {}
        return jsonify(upr.swt_sources(store.normal(data.get("project_root", "")),
                                       store.normal(data.get("unpacked_path", "")),
                                       store.normal(data.get("path", ""))))
