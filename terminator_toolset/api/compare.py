"""Comparator routes: diff, merge, transfer, listing, repair."""
from __future__ import annotations

from flask import jsonify, request

from ..services.compare_service import Compare


def register_compare(app, ctx):
    """Fix-file repair + two-file diff/merge/transfer."""
    cmp = ctx.cmp

    # (owned by Compare: fix_file)
    @app.route("/api/fix_file", methods=["POST"])
    def api_fix_file():
        """Кнопка «исправить файл»: пересчитать ss:ExpandedRowCount/ColumnCount
        по факту (логическая последняя строка/колонка) и добавить определения
        отсутствующих <Style> (лечит отказ Excel открывать файл), записать
        результат. Для валидного файла возвращает changed=[] и ничего не пишет."""
        data = request.get_json(silent=True) or {}
        return jsonify(cmp.fix_file(data.get("path", "")))

    # -- API: comparator ---------------------------------------------------------
    # (owned by Compare: compare / merge_all / list_xml / transfers)
    @app.route("/api/compare", methods=["POST"])
    def api_compare():
        data = request.get_json(silent=True) or {}
        return jsonify(cmp.compare(data.get("left", ""), data.get("right", ""),
                                   data.get("key_col", 0), data.get("default_key")))

    @app.route("/api/merge_all", methods=["POST"])
    def api_merge_all():
        """Merge mode: copy everything new/updated from the right (source)
        file into the left (base) file. Right wins on conflicts."""
        data = request.get_json(silent=True) or {}
        return jsonify(cmp.merge_all(data.get("left", ""), data.get("right", ""),
                                     data.get("key_col", 0), data.get("default_key")))

    @app.route("/api/list_xml", methods=["POST"])
    def api_list_xml():
        """List .xml files under a folder (for the compare page path pickers)."""
        data = request.get_json(silent=True) or {}
        return jsonify(Compare.list_xml(data.get("path", "")))

    @app.route("/api/transfer_row", methods=["POST"])
    def api_transfer_row():
        data = request.get_json(silent=True) or {}
        return jsonify(cmp.transfer_row(data.get("src", ""), data.get("dst", ""),
                                        data.get("row", -1), data.get("key_col", 0),
                                        data.get("col_map")))

    @app.route("/api/transfer_column", methods=["POST"])
    def api_transfer_column():
        data = request.get_json(silent=True) or {}
        return jsonify(cmp.transfer_column(data.get("src", ""), data.get("dst", ""),
                                           data.get("src_col", -1),
                                           data.get("dst_col", -1),
                                           data.get("key_col", 0)))
