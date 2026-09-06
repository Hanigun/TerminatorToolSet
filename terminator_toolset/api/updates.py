"""Update routes: check/download/stage/restart self-updates (owned by Updates)."""
from __future__ import annotations

from flask import jsonify, request


def register_updates(app, ctx):
    """Update state, manual check, background download with progress."""
    upd = ctx.upd

    @app.route("/api/update_state")
    def api_update_state():
        """Current version, channel, pending/staged update, cached release."""
        return jsonify(upd.state())

    @app.route("/api/update_check", methods=["POST"])
    def api_update_check():
        """Ask the worker for the newest release (daily throttle unless
        forced)."""
        data = request.get_json(silent=True) or {}
        return jsonify(upd.check(force=bool(data.get("force"))))

    @app.route("/api/update_channel", methods=["POST"])
    def api_update_channel():
        """Switch release/beta channel (applies to the next check)."""
        data = request.get_json(silent=True) or {}
        channel = str(data.get("channel") or "").strip().lower()
        if channel not in ("release", "beta"):
            return jsonify({"ok": False, "error": "bad channel"})
        try:
            ctx.config.set("update_channel", channel)
            ctx.config.set("update_last_check", 0)
        except Exception as e:  # noqa: BLE001
            return jsonify({"ok": False, "error": str(e)})
        return jsonify({**upd.check(force=True), "channel": channel})

    @app.route("/api/update_download", methods=["POST"])
    def api_update_download():
        """Download + stage the cached release in the background."""
        data = request.get_json(silent=True) or {}
        return jsonify(upd.download(url=str(data.get("url") or ""),
                                    version=str(data.get("version") or "")))

    @app.route("/api/update_progress")
    def api_update_progress():
        """Download staging progress for the progress bar."""
        return jsonify({"ok": True, "progress": upd.progress()})

    @app.route("/api/update_restart", methods=["POST"])
    def api_update_restart():
        """Relaunch into the staged update (applied on boot)."""
        return jsonify(upd.restart())
