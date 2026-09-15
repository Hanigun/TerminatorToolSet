"""File routes: tree copies, save-as, rollbacks, recents, links."""
from __future__ import annotations

import os

from flask import jsonify, request


def register_files(app, ctx):
    """Tree context-menu copies, file lifecycle, recents, cross-file links."""
    mods, files, guard, db, entities = (
        ctx.mods, ctx.files, ctx.guard, ctx.db, ctx.entities)

    # -- API: файловые операции для контекстного меню дерева ------------------
    # (owned by Mods: fs_copy / copy_to_mod)
    @app.route("/api/fs_copy", methods=["POST"])
    def api_fs_copy():
        """Скопировать файл или папку в указанную папку (вставка/дублирование
        в дереве). Существующие имена не перезаписываются - добавляется
        суффикс (1), (2), ..."""
        d = request.get_json(silent=True) or {}
        return jsonify(mods.fs_copy(d.get("src"), d.get("dst_dir"), d.get("name")))

    @app.route("/api/copy_to_mod", methods=["POST"])
    def api_copy_to_mod():
        """Скопировать файл/папку в папку основного мода (путь в настройках,
        «Путь к основному моду»). Относительный путь внутри проекта
        сохраняется - структура мода повторяет структуру игры."""
        d = request.get_json(silent=True) or {}
        return jsonify(mods.copy_to_mod(d.get("src"), d.get("project_root")))

    @app.route("/api/copy_to_project", methods=["POST"])
    def api_copy_to_project():
        """Скопировать файл/папку в открытый проект (путь в настройках,
        «Путь к проекту»). Относительный путь внутри игры сохраняется -
        структура проекта повторяет структуру игры (зеркало copy_to_mod)."""
        d = request.get_json(silent=True) or {}
        return jsonify(mods.copy_to_project(d.get("src"), d.get("game_root")))

    # (owned by Files: save_as)
    @app.route("/api/save_as", methods=["POST"])
    def api_save_as():
        """Сохранить сессию/док в проект или мод (защита распакованной игры).
        kind: file | swt | uprising. target: project | mod.
        Нет файла — копируется структура (makedirs + копия исходника)."""
        data = request.get_json(silent=True) or {}
        return jsonify(files.save_as(data.get("src", "") or "",
                                     data.get("kind", "file"),
                                     data.get("target", "project"),
                                     data.get("doc"), guard.roots()))

    # (owned by Files: restore_stock)
    @app.route("/api/stock_restore", methods=["POST"])
    def api_stock_restore():
        """Полный откат файла к стоковой версии из главного мода (mod_path).

        Оригинальные байты копируются поверх файла проекта (путь файла
        должен лежать внутри открытого проекта); сессия сбрасывается,
        журнал изменений файла очищается - он описывал правки от старого
        контента и после подмены файла теряет смысл."""
        data = request.get_json(silent=True) or {}
        return jsonify(files.restore_stock(data.get("path", "")))

    # (owned by Files: restore_record)
    @app.route("/api/restore", methods=["POST"])
    def api_restore():
        """Move the file to the state recorded by one journal entry.

        Reverting to a past record undoes every newer change; 'reverting' to
        an undone record redoes the steps up to it. Moves the cursor only -
        records themselves are never created or destroyed."""
        data = request.get_json(silent=True) or {}
        return jsonify(files.restore_record(data.get("path", ""),
                                            int(data.get("backup_id", -1))))

    # (owned by Files: restore_to_beginning)
    @app.route("/api/reset_beginning", methods=["POST"])
    def api_reset_beginning():
        """Откат файла к чистому состоянию до первой записи журнала.

        В отличие от restore самой старой записи (оставляет первую правку
        применённой), отменяет вообще все применённые записи."""
        data = request.get_json(silent=True) or {}
        return jsonify(files.restore_to_beginning(data.get("path", "")))

    # (owned by Mods: reveal)
    @app.route("/api/reveal", methods=["POST"])
    def api_reveal():
        """Show a file in Explorer (select) or open a folder."""
        data = request.get_json(silent=True) or {}
        return jsonify(mods.reveal(data.get("path", "")))

    # (owned by Mods: reveal логи)
    @app.route("/api/open_logs", methods=["POST"])
    def api_open_logs():
        """Открыть папку Logs в проводнике (иконка в шапке категорий настроек)."""
        from ..infrastructure.filesystem import pick_app_dir
        logdir = os.path.join(pick_app_dir(), "Logs")
        try:
            os.makedirs(logdir, exist_ok=True)
        except OSError as e:  # noqa: BLE001
            return jsonify({"ok": False, "error": str(e)})
        return jsonify(mods.reveal(logdir))

    @app.route("/api/recents")
    def api_recents():
        out = []
        for r in db.recents():
            d = dict(r)
            p = d.get("path", "")
            try:
                st = os.stat(p)
                d["exists"] = True
                d["mtime"] = st.st_mtime
                d["size"] = st.st_size if os.path.isfile(p) else None
            except OSError:
                d["exists"] = False
            out.append(d)
        return jsonify(out)

    @app.route("/api/recents/clear", methods=["POST"])
    def api_recents_clear():
        db.clear_recents()
        return jsonify({"ok": True})

    # (owned by EntityIndex: links)
    @app.route("/api/links")
    def api_links():
        path = request.args.get("path", "")
        try:
            return jsonify(entities.links(path))
        except Exception:  # noqa: BLE001
            return jsonify({"ok": False, "error": "open file first"})

    # (owned by EntityIndex: analyze)
    @app.route("/api/analyze_links", methods=["POST"])
    def api_analyze_links():
        """Кнопка «Анализ» открытого xml: пересчитать зависимости сейчас.

        Возвращает ссылки ячеек (фронт подставляет сразу) + исходящие
        («ссылается на») и входящие («ссылаются») группы файлов.
        Синхронный проход по проекту — фронт держит кнопку занятой."""
        data = request.get_json(silent=True) or {}
        try:
            return jsonify(entities.analyze(data.get("path", "") or ""))
        except Exception as e:  # noqa: BLE001
            return jsonify({"ok": False, "error": str(e)})
