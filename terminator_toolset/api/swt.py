"""SWT routes: mission-script open + guarded save."""
from __future__ import annotations

from flask import jsonify, request


def register_swt(app, ctx):
    """Parse/fix and byte-compatible save of .swt files."""
    swt = ctx.swt

    # (owned by Swt: open / save)
    @app.route("/api/swt_open", methods=["POST"])
    def api_swt_open():
        """Открыть .swt: разбор + авто-фикс повторных guid + словарь команд."""
        data = request.get_json(silent=True) or {}
        return jsonify(swt.open(data.get("path", "")))

    @app.route("/api/swt_save", methods=["POST"])
    def api_swt_save():
        """Записать .swt (формат игры, побайтово совместимый). mtime-guard:
        файл, изменённый на диске после открытия (внешний редактор), без
        явного force не перезаписываем — иначе тихая потеря чужих правок."""
        data = request.get_json(silent=True) or {}
        return jsonify(swt.save(data.get("path", ""), data.get("doc"),
                                data.get("mtime"), data.get("force")))
