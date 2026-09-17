"""Маршруты 3D-превью .model: геометрия JSON и раздача текстур.

POST /api/model_preview {root, value, turret}: поиск модели
по значению колонки mesh (basis + DLC-оверлеи), парсинг и запечённая
геометрия для three.js. Варианты башен и стороны брони — из шиппящихся
пресетов сервиса (species-XML не читаются); turret:
отсутствует/'@@auto@@' — автоподбор, '' — без башни, иначе явный rel.
GET /api/model_tex?root=&rel=: текстура материала (dds через готовый
webp-конвертер в CustomImages, png напрямую). Чужие пути за пределы
корня не обслуживаются (проверка в model3d_service.find_file).
"""
from __future__ import annotations

import os


def register_model3d(app, ctx):
    """Бэкенд 3D-превью моделей юнитов.

    Самодостаточен: сервис берёт варианты башен и стороны брони
    из шиппящихся пресетов — species-XML здесь НЕ читаются.
    cat/sys от фронта игнорируются (оставлены в запросе
    для совместимости).
    """
    store, upr = ctx.store, ctx.upr
    from terminator_toolset.services import model3d_service as m3

    @app.route("/api/model_preview", methods=["POST"])
    def api_model_preview():
        """Геометрия модели для вьюера. Ответ: {ok, path, value,
        version, meshes, materials, turret} либо {ok: False, error}."""
        from flask import jsonify, request
        data = request.get_json(silent=True) or {}
        root = store.normal(str(data.get("root") or ""))
        value = str(data.get("value") or "")
        turret = data.get("turret", "@@auto@@")
        mg = data.get("mg", "@@auto@@")
        return jsonify(m3.preview_payload(
            upr, root, value,
            turret="@@auto@@" if turret is None else str(turret),
            mg="@@auto@@" if mg is None else str(mg)))

    @app.route("/api/model_turret", methods=["POST"])
    def api_model_turret():
        """Только башня для смены варианта: корпус не трогаем, сцена
        не мигает. Ответ: {ok, rel, mount, anchor, meshes, materials}."""
        from flask import jsonify, request
        data = request.get_json(silent=True) or {}
        root = store.normal(str(data.get("root") or ""))
        value = str(data.get("value") or "")
        turret = str(data.get("turret") or "")
        slot = str(data.get("slot") or "")
        raw_mg = data.get("mg", "@@auto@@")
        mg = "@@auto@@" if raw_mg is None else str(raw_mg)
        return jsonify(m3.turret_payload(
            upr, root, value, turret, turret_slot=slot, mg=mg))

    @app.route("/api/model_tex")
    def api_model_tex():
        """WebP/PNG текстуры материала по basis-пути rel внутри root.
        &model= — стем модели-владельца (кладём в textures/<модель>);
        без него — textures/shared. Чужие пути за пределы корня не
        обслуживаются (проверка в model3d_service.find_file)."""
        from flask import request, send_file
        root = store.normal(request.args.get("root", ""))
        rel = m3.safe_rel(request.args.get("rel") or "")
        model = str(request.args.get("model") or "")
        slot = str(request.args.get("slot") or "")
        try:
            ovl = upr.unpacked_root() if upr is not None else ""
        except Exception:  # noqa: BLE001
            ovl = ""
        try:
            sub = m3.overlays_for(upr, root)
        except Exception:  # noqa: BLE001
            sub = ()
        p = m3.find_file(root, rel, ovl, sub) if rel else ""
        if p and p.lower().endswith(".dds"):
            try:
                # Двухканальные нормали: Z чинить по содержимому, не по
                # контейнеру — FourCC ловит BC5U, а DXT1-пустышки с
                # нулевым B (int_small_tug_normal.dds — «тёмный» трактор)
                # чинятся контент-проверкой. Маска 'normal' в имени:
                # albedo с плоским B под пересчёт не подставлять.
                # Проверка едет ВНУТРИ конвертации на уже декодированном
                # кадре (normal_auto): отдельный проход dds_needs_blue_
                # rebuild здесь — второй полный декод гигантских DDS,
                # секунды на файл. 'normaal' — голландское normal
                # (US_Abrams_normaal.dds): без него свет на броне врёт.
                # Признаки — из dds_converter.normal_hints (общие
                # с фоновым прогревом, чтобы не разъехаться).
                from terminator_toolset.services import dds_converter as _dc
                nr, na = _dc.normal_hints(p)
                p = upr.dds_webp(p, root=root, normal_fix=nr,
                                 normal_auto=na, kind="texture",
                                 model=model,
                                 quality=_dc.quality_for_slot(slot)) or ""
            except Exception:  # noqa: BLE001
                p = ""
        if not p or not os.path.isfile(p):
            return ("", 404)
        mime = ("image/webp" if p.lower().endswith(".webp")
                else "image/png")
        try:
            resp = send_file(p, mimetype=mime)
        except OSError:
            return ("", 404)
        resp.headers["Cache-Control"] = "public, max-age=3600"
        return resp
