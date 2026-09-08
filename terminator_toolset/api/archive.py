"""Archive routes: game .pak scan / unpack / progress."""
from __future__ import annotations

from flask import jsonify, request


def register_archive(app, ctx):
    """Ordered .pak extraction queue + background worker."""
    arch = ctx.arch

    # ---------- archive unpacker ----------
    # (owned by Archive: find_7z / pak_plan / dlc_dir / unpack job)
    @app.route("/api/unpack_scan", methods=["POST"])
    def api_unpack_scan():
        """Find every .pak of the game root and order the extraction queue;
        plus loose basis//localization folders copied before the paks."""
        data = request.get_json(silent=True) or {}
        root = (data.get("path") or "").strip()
        return jsonify(arch.scan(root))

    # (unpack worker owned by Archive: arch.run / status / abort)
    @app.route("/api/unpack_run", methods=["POST"])
    def api_unpack_run():
        """Unpack the whole found queue in a background thread; per group
        loose basis//localization copies first, then ALL paks extract into
        ONE folder so later patches overwrite earlier files: game base ->
        dest\\basis\\ (basis.pak first, then patch_* by number),
        Legion -> dest\\dlc\\legion\\basis\\,
        Resistance -> dest\\dlc\\resistance\\basis\\,
        Evolution -> dest\\dlc\\evolution\\basis\\."""
        data = request.get_json(silent=True) or {}
        root = (data.get("game_root") or "").strip()
        dest = (data.get("dest") or "").strip()
        skip = data.get("skip") or []
        return jsonify(arch.run(root, dest, skip))

    @app.route("/api/unpack_status")
    def api_unpack_status():
        return jsonify(arch.status())

    @app.route("/api/unpack_abort", methods=["POST"])
    def api_unpack_abort():
        return jsonify(arch.abort())
