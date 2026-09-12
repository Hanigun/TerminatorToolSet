"""Campaign routes: base-game settlement shops (shop_presets.xml).

Отличие от Uprising: файл кампании — ПЕРВЫЙ shop_presets.xml, который НЕ
является файлом карты (is_uprising_shop == False). Приоритет — фиксированный
базовый путь basis/scripts/species/shop_presets.xml, дальше — все точные
shop_presets.xml под root по сортированному пути.
"""
from __future__ import annotations

import os


def register_campaign(app, ctx):
    """Campaign editor backend (logic reused from the Uprising service)."""
    store, upr = ctx.store, ctx.upr

    @app.route("/api/campaign_find", methods=["POST"])
    def api_campaign_find():
        """Найти базовый shop_presets.xml (магазины кампании) под root."""
        from flask import jsonify, request
        data = request.get_json(silent=True) or {}
        root = store.normal(data.get("root", ""))
        if not root or not os.path.isdir(root):
            return jsonify({"ok": True, "path": ""})
        fixed = os.path.join(root, "basis", "scripts", "species",
                              "shop_presets.xml")
        cands = []
        if os.path.isfile(fixed):
            cands.append(fixed)
        extra = []
        for dirpath, _dirnames, filenames in os.walk(root):
            for f in filenames:
                if f.lower() == "shop_presets.xml":
                    p = os.path.join(dirpath, f)
                    if p != fixed:
                        extra.append(p)
        cands.extend(sorted(extra))
        for p in cands:
            try:
                if not upr.is_uprising_shop(p):
                    return jsonify({"ok": True, "path": p})
            except Exception:  # noqa: BLE001
                continue
        return jsonify({"ok": True, "path": ""})
