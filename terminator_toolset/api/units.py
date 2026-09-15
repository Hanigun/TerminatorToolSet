"""Маршруты вкладки Units: чтение species-файлов категорий и справочник sysname.

Чтение идёт через живые строки сессии (undo-aware, предпочтительно) либо
через Session-grid (terminator_toolset/domain/xmlgrid.py). Записи здесь нет:
фронт пишет через готовые /api/edit, /api/edit_cells и /api/species_stat
(см. terminator_toolset/api/sheets.py).
"""
from __future__ import annotations

import glob
import os


# категория вкладки -> species-файл (пять файлов из _ICON_FILES плюс
# humans.xml как справочник пехоты для связей squads -> humans)
_UNIT_FILES = {
    "squads": "squads.xml",
    "cars": "cars.xml",
    "tanks": "tanks.xml",
    "helicopters": "helicopters.xml",
    "inventory_items": "inventory_items.xml",
    "humans": "humans.xml",
}

# источники данных вкладки: src выбирает корень
_UNIT_SRCS = ("project", "game", "mod")


def _known_roots(ctx):
    """Известные корни источников {project, game, mod}.

    Проект — открытый проект, иначе project_path/last_project; игра —
    распакованные ассеты (unpacked_path); мод — основной мод (mod_path).
    Берутся только существующие папки.
    """
    roots = {}
    proj = ""
    try:
        ent = getattr(ctx.entities, "project", None)
        if ent is not None and getattr(ent, "root", None):
            proj = os.path.normpath(ent.root)
    except Exception:  # noqa: BLE001
        proj = ""
    if not proj:
        for key in ("project_path", "last_project"):
            try:
                val = ctx.config.get(key) or ""
            except Exception:  # noqa: BLE001
                continue
            if val and os.path.isdir(val):
                proj = os.path.normpath(val)
                break
    if proj and os.path.isdir(proj):
        roots["project"] = proj
    try:
        game = ctx.config.get("unpacked_path") or ""
    except Exception:  # noqa: BLE001
        game = ""
    if game and os.path.isdir(game):
        roots["game"] = os.path.normpath(game)
    try:
        mod = ctx.config.get("mod_path") or ""
    except Exception:  # noqa: BLE001
        mod = ""
    if mod and os.path.isdir(mod):
        roots["mod"] = os.path.normpath(mod)
    return roots


def _detect_src(root, roots):
    """Ключ источника по совпадению пути с известным корнем, иначе ''."""
    try:
        norm = os.path.normcase(os.path.normpath(root or ""))
    except Exception:  # noqa: BLE001
        return ""
    for key, val in roots.items():
        try:
            if norm == os.path.normcase(os.path.normpath(val)):
                return key
        except Exception:  # noqa: BLE001
            continue
    return ""


def _resolve_root(ctx, store, data):
    """Эффективный корень: src выбирает корень, явный root — запасной путь.

    Возвращает (root, src): пустой root — корень не найден.
    """
    src = str(data.get("src") or "").strip().lower()
    # пустой root нельзя нормализовывать: normpath("") даёт ".", а это
    # существующая папка (cwd) — ложный корень
    given = str(data.get("root") or "").strip()
    raw = store.normal(given) if given else ""
    roots = _known_roots(ctx)
    if src in _UNIT_SRCS:
        cand = roots.get(src, "")
        if cand and os.path.isdir(cand):
            return cand, src
        if raw and os.path.isdir(raw):
            return raw, src
        return "", src
    if raw and os.path.isdir(raw):
        return raw, _detect_src(raw, roots)
    return "", src


def _cat_paths(root, fn):
    """Файлы категории: база первой, затем DLC-оверлеи (как чтение цен
    и запись статов: basis + dlc/*/basis)."""
    paths = [os.path.join(root, "basis", "scripts", "species", fn)]
    try:
        paths.extend(sorted(glob.glob(os.path.join(
            root, "dlc", "*", "basis", "scripts", "species", fn))))
    except Exception:  # noqa: BLE001
        pass
    return [p for p in paths if os.path.isfile(p)]


def _units_grid(store, upr, path):
    """Строки species-файла как {columns, rows:[{values, key}]}.

    Сначала живые строки открытой сессии (undo-aware, с учётом неоткаченных
    правок), иначе Session-grid с открытием сессии.
    """
    try:
        live = upr._live_sheet_rows(path)
    except Exception:  # noqa: BLE001
        live = None
    if live:
        width = 0
        for row in live:
            try:
                width = max(width, max(row.keys(), default=-1) + 1)
            except (TypeError, ValueError):
                continue
        head = live[0] if live else {}
        columns = [str(head.get(i, "") or "") for i in range(width)]
        rows = []
        for row in live[1:]:
            vals = [str(row.get(i, "") or "") for i in range(width)]
            rows.append({"values": vals,
                         "key": vals[0] if vals else ""})
        return {"columns": columns, "rows": rows}
    try:
        grid = store.get(path).grid()
    except Exception:  # noqa: BLE001
        return None
    out_rows = []
    for row in grid.get("rows", []):
        vals = list(row.get("values", [])) if isinstance(row, dict) else []
        key = row.get("key", "") if isinstance(row, dict) else ""
        out_rows.append({"values": vals, "key": key})
    return {"columns": list(grid.get("columns", []) or []),
            "rows": out_rows}


def _units_pic_cands(value):
    """Кандидаты rel для сырого ключа картинки species-колонки.

    Ключ чистится от .. и повторов слэшей (файл может подсунуть путь
    наружу — наружу не выходим). Голый стем без папки ищется и в
    известных папках иконок (small/big обоих семейств).
    """
    v = str(value or "").replace("\\", "/").strip()
    parts = [p for p in v.split("/") if p not in ("", ".", "..")]
    if not parts:
        return []
    rel = "/".join(parts)
    out = [rel]
    if len(parts) == 1:
        stem = parts[0]
        for sub in ("vehicles_icons_small", "infantry_icons_small",
                    "vehicles_icons_big", "infantry_icons_big"):
            out.append(sub + "/" + stem)
    return out


def _units_pic_file(upr, root, value):
    """Исходник картинки по сырому ключу колонки (image/pic): путь или ''.

    Поиск — теми же машинами иконок, что /api/uprising_icon: rel через
    icon_file (поддерево tech_pic + CustomImages), голое имя — прямым
    поиском по папкам иконок. Модели, конфиги и мусор не находятся.
    """
    for rel in _units_pic_cands(value):
        try:
            p = upr.icon_file(root, rel, "unit")
        except Exception:  # noqa: BLE001
            p = ""
        if p and os.path.isfile(p):
            return p
    v = str(value or "").replace("\\", "/").strip().split("/")[-1]
    stem, _ = os.path.splitext(v)
    if stem and stem not in ("", ".", ".."):
        try:
            hit = upr._icon_direct_source(root, stem)
        except Exception:  # noqa: BLE001
            hit = None
        if hit and os.path.isfile(hit[0]):
            return hit[0]
    return ""


def _layer_of(root, path):
    """Слой файла внутри корня: 'basis', 'dlc' либо ''."""
    try:
        basis = os.path.normcase(os.path.normpath(os.path.join(root, "basis")))
        dlc = os.path.normcase(os.path.normpath(os.path.join(root, "dlc")))
        norm = os.path.normcase(os.path.normpath(path or ""))
    except Exception:  # noqa: BLE001
        return ""
    if norm.startswith(basis + os.sep):
        return "basis"
    if norm.startswith(dlc + os.sep):
        return "dlc"
    return ""


def register_units(app, ctx):
    """Бэкенд вкладки Units (только чтение species; запись — роуты sheets)."""
    store, upr = ctx.store, ctx.upr

    @app.route("/api/units_list", methods=["POST"])
    def api_units_list():
        """Строки species-файла категории: база первой, иначе первый
        DLC-оверлей. Ответ: {ok, path, src, cat, layer, overlays,
        columns, rows:[{values, key}]}."""
        from flask import jsonify, request
        data = request.get_json(silent=True) or {}
        cat = str(data.get("cat") or "").strip().lower()
        fn = _UNIT_FILES.get(cat)
        if not fn:
            return jsonify({"ok": False, "error": "bad_cat", "cat": cat})
        root, src = _resolve_root(ctx, store, data)
        if not root:
            return jsonify({"ok": False, "error": "no_root",
                            "cat": cat, "src": src})
        existing = _cat_paths(root, fn)
        if not existing:
            return jsonify({"ok": False, "error": "no_species_file",
                            "cat": cat, "src": src, "file": fn})
        path = existing[0]
        grid = _units_grid(store, upr, path)
        if grid is None:
            return jsonify({"ok": False, "error": "read_failed",
                            "cat": cat, "src": src, "path": path})
        return jsonify({"ok": True, "path": path, "src": src, "cat": cat,
                        "layer": _layer_of(root, path),
                        "overlays": existing[1:],
                        "columns": grid["columns"], "rows": grid["rows"]})

    @app.route("/api/units_pic")
    def api_units_pic():
        """Превью картинки species-колонки (image/pic) по сырому ключу
        (hover_image_*, tech_pic, status_pic, garrison_pic): исходник ищется
        теми же машинами иконок, .dds уходит в готовый webp-конвертер
        (dds_webp в CustomImages/<слой>, как состояния иконок); нет файла —
        плейсхолдер категории, в крайнем случае серая заглушка (не 404)."""
        from flask import request, send_file
        root = store.normal(request.args.get("root", ""))
        value = request.args.get("value") or ""
        cat = (request.args.get("cat") or "").strip()
        sys = (request.args.get("sys") or "").strip()
        p = _units_pic_file(upr, root, value)
        if p and p.lower().endswith(".dds"):
            try:
                p = upr.dds_webp(p, root=root) or ""
            except Exception:  # noqa: BLE001
                p = ""
        if p and os.path.isfile(p):
            mime = ("image/webp" if p.lower().endswith(".webp")
                    else "image/png")
            try:
                resp = send_file(p, mimetype=mime)
            except OSError:
                return ("", 404)
            resp.headers["Cache-Control"] = "public, max-age=3600"
            return resp
        try:
            ph = upr.category_placeholder(cat, sys)
        except Exception:  # noqa: BLE001
            ph = ""
        if ph:
            try:
                resp = send_file(ph, mimetype="image/webp")
            except OSError:
                pass
            else:
                resp.headers["Cache-Control"] = "public, max-age=3600"
                return resp
        try:
            p = upr.placeholder_png()
        except Exception:  # noqa: BLE001
            p = ""
        if not p:
            return ("", 404)
        try:
            resp = send_file(p, mimetype="image/png")
        except OSError:
            return ("", 404)
        resp.headers["Cache-Control"] = "public, max-age=3600"
        return resp

    @app.route("/api/units_refs", methods=["POST"])
    def api_units_refs():
        """Справочник sysname всех species-категорий для автокомплита связей
        (squads -> humans и др.; правила семейств — domain/links.REFERS_TO).
        Ответ: {ok, src, names, cats}. Живые строки сессий учитываются."""
        from flask import jsonify, request
        data = request.get_json(silent=True) or {}
        root, src = _resolve_root(ctx, store, data)
        if not root:
            return jsonify({"ok": False, "error": "no_root", "src": src})
        cats = {cat: set() for cat in _UNIT_FILES}
        for cat, fn in _UNIT_FILES.items():
            for path in _cat_paths(root, fn):
                grid = _units_grid(store, upr, path)
                if not grid:
                    continue
                for row in grid["rows"]:
                    vals = row.get("values", []) \
                        if isinstance(row, dict) else []
                    if not vals:
                        continue
                    name = str(vals[0] or "").strip()
                    # пропуски заглушек: пустые, комментарии и шапка
                    if name and not name.startswith("#") \
                            and name.lower() != "sysname":
                        cats[cat].add(name)
        names = sorted({n for vs in cats.values() for n in vs})
        return jsonify({"ok": True, "src": src, "names": names,
                        "cats": {k: sorted(v) for k, v in cats.items()}})
