"""Project routes: open/close, trees, display names, edited marks."""
from __future__ import annotations

import os

from flask import jsonify, request

from ..infrastructure.filesystem import walk_tree as _walk_tree


def register_project(app, ctx):
    """Project lifecycle + trees + markers."""
    config, db, entities, markers, saves, log = (
        ctx.config, ctx.db, ctx.entities, ctx.markers, ctx.saves, ctx.log)

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
        из памяти без walk."""
        root = request.args.get("root", "") or ""
        lang = request.args.get("lang", "") or config.get("language", "ru")
        if not root or not os.path.isdir(root):
            return jsonify({"ok": False, "error": "no root"})
        try:
            if entities.project is not None and getattr(entities.project, "root", None) \
                    and os.path.normpath(entities.project.root) == os.path.normpath(root):
                names = entities.project.display_names(lang)
            else:
                from project import Project as _Proj
                names = _Proj(root).display_names(lang)
        except Exception as e:  # noqa: BLE001
            return jsonify({"ok": False, "error": str(e)})
        return jsonify({"ok": True, "names": names})

    @app.route("/api/project_tree")
    def api_project_tree():
        """Full folder/file tree of the OPEN project: everything on disk,
        any extension. The frontend filters what to display."""
        if entities.project is None or not getattr(entities.project, "root", None) \
                or not os.path.isdir(entities.project.root):
            return jsonify({"ok": False, "error": "no project"})
        return jsonify({"ok": True, "root": entities.project.root,
                        "tree": _walk_tree(entities.project.root)})

    @app.route("/api/game_tree")
    def api_game_tree():
        """Full tree of the unpacked game assets (config: unpacked_path).
        Used by the «Игра» tab in the project sidebar."""
        root = config.get("unpacked_path") or ""
        if not root or not os.path.isdir(root):
            return jsonify({"ok": False, "error": "no unpacked game"})
        return jsonify({"ok": True, "root": root,
                        "tree": _walk_tree(root)})

    @app.route("/api/mod_tree")
    def api_mod_tree():
        """Full tree of the main mod folder (config: mod_path).
        Used by the «Мод» tab in the project sidebar."""
        root = config.get("mod_path") or ""
        if not root or not os.path.isdir(root):
            return jsonify({"ok": False, "error": "no mod path"})
        return jsonify({"ok": True, "root": root,
                        "tree": _walk_tree(root)})

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
