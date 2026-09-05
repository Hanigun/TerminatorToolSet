"""Mod routes: game dir, icon preview, mod scaffolding."""
from __future__ import annotations

import os

from flask import jsonify, request


def register_mods(app, ctx):
    """Game-folder config, thumbnail preview, create/list/fill mod folders."""
    mods = ctx.mods

    # ---------- create mod ----------

    # (owned by Mods: game_dir)
    @app.route("/api/game_dir", methods=["GET", "POST"])
    def api_game_dir():
        """Store / return the game installation folder (config key game_dir)."""
        if request.method == "POST":
            data = request.get_json(silent=True) or {}
            return jsonify(mods.game_dir((data.get("path") or "").strip()))
        return jsonify(mods.game_dir())

    @app.route("/api/icon_preview")
    def api_icon_preview():
        """Serve a picked image so the form can preview it."""
        from flask import send_file
        p = request.args.get("p", "")
        if not p or not os.path.isfile(p):
            return jsonify({"ok": False, "error": "not found"})
        try:
            return send_file(p)
        except Exception as e:  # noqa: BLE001
            return jsonify({"ok": False, "error": str(e)})

    # (owned by Mods: copy_files_into / create_mod / list_mods / copy_mod_files)
    @app.route("/api/create_mod", methods=["POST"])
    def api_create_mod():
        """Create <game>/mods/<Name>/ with mod.json (+ optional thumbnail).

        Follows the official mod guide: latin folder name, mod.json with
        name / description / icon, icon preferably in basis/ as a dds.
        """
        data = request.get_json(silent=True) or {}
        return jsonify(mods.create_mod(data.get("name"), data.get("description"),
                                       data.get("icon"), data.get("files")))

    @app.route("/api/list_mods", methods=["GET"])
    def api_list_mods():
        """Existing mod folders under <game>/mods."""
        return jsonify(mods.list_mods())

    @app.route("/api/copy_mod_files", methods=["POST"])
    def api_copy_mod_files():
        """Copy dragged files into an existing mod, recreating structure."""
        data = request.get_json(silent=True) or {}
        return jsonify(mods.copy_mod_files(data.get("mod"), data.get("files")))
