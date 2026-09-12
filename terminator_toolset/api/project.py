"""Project routes: open/close, trees, display names, edited marks."""
from __future__ import annotations

import os

from flask import jsonify, request

from ..infrastructure.filesystem import walk_tree as _walk_tree

# Кэш имён по (нормированный корень, язык) для корней игра/мод: у них нет
# живого Project-инстанса с собственным кэшем, а walk+парсинг всех
# locale-XML на холодном HDD — секунды на каждый запрос. Сбрасывается
# в /api/tree_rescan (там же фронт перечитывает деревья).
_NAMES_CACHE: dict[tuple[str, str], dict] = {}


def _names_for(root: str, lang: str) -> dict:
    key = (os.path.normpath(root).lower(), lang)
    hit = _NAMES_CACHE.get(key)
    if hit is not None:
        return hit
    from ..domain.project import Project as _Proj
    names = _Proj(root).display_names(lang) or {}
    _NAMES_CACHE[key] = names
    return names


def register_project(app, ctx):
    """Project lifecycle + trees + markers."""
    config, db, entities, markers, saves, log = (
        ctx.config, ctx.db, ctx.entities, ctx.markers, ctx.saves, ctx.log)
    watch = getattr(ctx, "watch", None)

    def _tree_for(role: str, root: str):
        """Древо из фонового снапшота вотчера (без своего walk по диску):
        второй параллельный walk душил холодный HDD до 14с (см. app.log).
        Снапшота нет / корень сменился — честный walk_tree как раньше."""
        try:
            if watch is not None and root and os.path.isdir(root):
                hit = watch.tree(role)
                if hit and os.path.normpath(hit[0]) == os.path.normpath(root):
                    return hit[1]
        except Exception:  # noqa: BLE001
            pass
        return _walk_tree(root)
    # -- API: project / files -------------------------------------------------
    @app.route("/api/open_project", methods=["POST"])
    def api_open_project():
        data = request.get_json(silent=True) or {}
        root = data.get("path", "")
        log.info("open_project: %s", root)
        return jsonify(entities.open(root, db=db, config=config))

    @app.route("/api/close_project", methods=["POST"])
    def api_close_project():
        """Forget the loaded project: clear the tree source, the entity map,
        the auto-reopen pointer and the change history of all its files."""
        entities.close(db=db, config=config)
        return jsonify({"ok": True})

    @app.route("/api/display_names")
    def api_display_names():
        """sysname -> локализованное имя отдельным фоновым запросом.

        Раньше имена ехали внутри /api/open_project: второй полный walk
        дерева + парсинг всех locale-XML. На холодном HDD это минуты, и всё
        это время висел лаунчер (фронт ждал open_project до main_ready).
        Теперь open_project лёгкий, а имена дотягиваются фоном после старта.
        Кэш на открытом проекте: повторный запрос того же корня/языка —
        из памяти без walk.

        Корней может быть несколько (повторяющийся ?root=): фронт шлёт
        первым корень открытой карты (её источник: проект/мод/игра),
        дальше остальные по порядку — побеждает первый, остальные
        добивают только недостающие sysname. Слои: источник карты >
        остальные > GameAssets (архив — только недостающее)."""
        roots = [r for r in request.args.getlist("root") if r]
        root = roots[0] if roots else (request.args.get("root", "") or "")
        lang = request.args.get("lang", "") or config.get("language", "ru")
        if not root or not os.path.isdir(root):
            return jsonify({"ok": False, "error": "no root"})
        try:
            if entities.project is not None and getattr(entities.project, "root", None) \
                    and os.path.normpath(entities.project.root) == os.path.normpath(root):
                names = dict(entities.project.display_names(lang) or {})
            else:
                # тоже через модульный кэш: новый инстанс Project каждый
                # запрос иначе повторяет полный проход locale (открытие карты
                # со своим корнем после старта — тот же walk заново)
                names = dict(_names_for(root, lang) or {})
            # остальные корни (мод, игра) — только недостающие sysname
            for extra in roots[1:]:
                try:
                    if not extra or not os.path.isdir(extra):
                        continue
                    if os.path.normpath(extra) == os.path.normpath(root):
                        continue
                    for k, v in _names_for(extra, lang).items():
                        names.setdefault(k, v)
                except Exception:  # noqa: BLE001
                    continue
            # GameAssets последним слоем не перекрывают проект: только
            # недостающие sysname из localization/.../locale/*.xml архива
            try:
                from ..infrastructure.gameassets_path import (
                    game_assets_root as _ga_root,
                )
                ga = _ga_root(config, getattr(config, "dir", ""))
                if ga and os.path.isdir(ga):
                    from ..domain.project import Project as _GaProj
                    for k, v in _GaProj(ga).display_names(lang).items():
                        names.setdefault(k, v)
            except Exception:  # noqa: BLE001
                pass
        except Exception as e:  # noqa: BLE001
            return jsonify({"ok": False, "error": str(e)})
        return jsonify({"ok": True, "names": names})

    @app.route("/api/project_tree")
    def api_project_tree():
        """Pruned folder/file tree of the OPEN project: max TREE_MAX_DEPTH
        levels, only TREE_KEEP_EXTS files (see infrastructure.filesystem).
        The frontend filters what to display on top."""
        if entities.project is None or not getattr(entities.project, "root", None) \
                or not os.path.isdir(entities.project.root):
            return jsonify({"ok": False, "error": "no project"})
        return jsonify({"ok": True, "root": entities.project.root,
                        "tree": _tree_for("project", entities.project.root)})

    @app.route("/api/game_tree")
    def api_game_tree():
        """Pruned tree of the unpacked game assets (config: unpacked_path).
        Used by the «Игра» tab in the project sidebar."""
        root = config.get("unpacked_path") or ""
        if not root or not os.path.isdir(root):
            return jsonify({"ok": False, "error": "no unpacked game"})
        return jsonify({"ok": True, "root": root,
                        "tree": _tree_for("game", root)})

    @app.route("/api/mod_tree")
    def api_mod_tree():
        """Pruned tree of the main mod folder (config: mod_path).
        Used by the «Мод» tab in the project sidebar."""
        root = config.get("mod_path") or ""
        if not root or not os.path.isdir(root):
            return jsonify({"ok": False, "error": "no mod path"})
        return jsonify({"ok": True, "root": root,
                        "tree": _tree_for("mod", root)})

    @app.route("/api/tree_watch")
    def api_tree_watch():
        """External-change generations for project/game/mod trees
        (TreeWatch polling thread). The frontend reloads only the tree
        whose generation outruns the applied one."""
        if watch is None:
            return jsonify({"ok": True, "v": 0,
                            "roots": {"project": 0, "game": 0, "mod": 0}})
        return jsonify(watch.state())

    @app.route("/api/tree_rescan", methods=["POST"])
    def api_tree_rescan():
        """«Пересканировать»: drop watcher baselines, bump every live root.
        The frontend then force-reloads all three trees itself."""
        if watch is None:
            return jsonify({"ok": False, "error": "no watcher"})
        # locale-файлы могли правиться снаружи — кэш имён игры/мода сбросить,
        # у открытого проекта тоже (Project.display_names кэширует инстанс)
        _NAMES_CACHE.clear()
        try:
            if entities.project is not None:
                entities.project._names = None
        except Exception:  # noqa: BLE001
            pass
        return jsonify(watch.rescan())

    @app.route("/api/edited_marks")
    def api_edited_marks():
        """Файлы с зелёной точкой из configs/markers.json (все секции)."""
        root = request.args.get("path", "")
        section = (request.args.get("section", "") or "").strip()
        if section:
            files = [f for f in (markers.data.get(section) or []) if os.path.exists(f)]
            return jsonify({"ok": True, "files": files, "section": section})
        if not root or not os.path.isdir(root):
            files = [f for f in markers.all_files() if os.path.exists(f)]
            return jsonify({"ok": True, "files": files})
        rootn = os.path.normpath(root)
        out = []
        for f in markers.all_files():
            try:
                af = os.path.normpath(f)
                if af == rootn or af.startswith(rootn + os.sep):
                    out.append(af)
            except Exception:  # noqa: BLE001
                pass
        return jsonify({"ok": True, "files": out})

    @app.route("/api/edited_marks/clear", methods=["POST"])
    def api_edited_marks_clear():
        """Очистка только нужной секции markers.json (не всего файла)."""
        body = request.get_json(silent=True) or {}
        section = (body.get("section") or body.get("path") or "").strip()
        # старый фронт шлёт path=корень проекта: чистим секции его файлов
        if section and section in markers.data and section != "":
            # явная секция
            pass
        elif section and os.path.isdir(section):
            rootn = os.path.normpath(section)
            for sec in list(markers.data.keys()):
                if sec.startswith("_"):
                    continue
                kept = []
                for f in (markers.data.get(sec) or []):
                    try:
                        af = os.path.normpath(f)
                        if not (af == rootn or af.startswith(rootn + os.sep)):
                            kept.append(f)
                    except Exception:  # noqa: BLE001
                        kept.append(f)
                markers.data[sec] = kept
            markers.save()
            # legacy root json-маркеры удалить
            saves.drop_legacy_markers()
            return jsonify({"ok": True, "deleted": True})
        if section in markers.data:
            markers.clear_section(section)
            saves.drop_legacy_markers()
            return jsonify({"ok": True, "deleted": True})
        # по умолчанию чистим все секции файлов проекта path
        saves.drop_legacy_markers()
        return jsonify({"ok": True, "deleted": True})
