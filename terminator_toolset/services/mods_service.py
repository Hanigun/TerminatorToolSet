"""Mod scaffolding: game-dir config, mod creation, file copying, reveal."""
from __future__ import annotations

import json
import os
import shutil
import subprocess


# GUI build has no console: keep console-subsystem children from popping
# a visible console window (the "second console" ghost).
_NW = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


# -- mods ---------------------------------------------------------------------
class Mods:
    """Owns mod-folder workflows (creation, listing, file drops) plus the
    tree context-menu copies and the Explorer reveal helper.

    config: domain Config (keys game_dir / mod_path). log: api logger.
    """

    def __init__(self, config, log):
        self._config = config
        self._log = log

    # -- tree context-menu copies ---------------------------------------------
    def fs_copy(self, src: str, dst_dir: str, name: str = "") -> dict:
        """Copy a file or folder into a folder (tree paste/duplicate).
        Existing names are never overwritten - a (1), (2), ... suffix wins."""
        src = (src or "").strip()
        dst_dir = (dst_dir or "").strip()
        if not src or not dst_dir or not os.path.exists(src):
            return {"ok": False, "error": "bad_src"}
        if not os.path.isdir(dst_dir):
            return {"ok": False, "error": "bad_dst"}
        base = (name or "").strip() or os.path.basename(src.rstrip("\\/")) or "copy"
        dst = os.path.join(dst_dir, base)
        if os.path.abspath(dst) == os.path.abspath(src):
            return {"ok": False, "error": "same_path"}
        if os.path.exists(dst):
            stem, ext = os.path.splitext(base)
            n = 1
            while os.path.exists(os.path.join(dst_dir, "%s(%d)%s" % (stem, n, ext))):
                n += 1
            dst = os.path.join(dst_dir, "%s(%d)%s" % (stem, n, ext))
        try:
            if os.path.isdir(src):
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)
        except Exception as e:  # noqa: BLE001
            self._log.info("fs_copy failed: %s -> %s: %s", src, dst, e)
            return {"ok": False, "error": str(e)}
        self._log.info("fs_copy: %s -> %s", src, dst)
        return {"ok": True, "path": dst}

    def copy_to_mod(self, src: str, project_root: str = "") -> dict:
        """Copy a file/folder into the main mod folder (config key mod_path).
        The relative path inside the project is preserved - the mod mirrors
        the game structure."""
        src = os.path.normpath((src or "").strip())
        if not src or not os.path.exists(src):
            return {"ok": False, "error": "bad_src"}
        mod_root = (self._config.get("mod_path") or "").strip()
        if not mod_root:
            return {"ok": False, "error": "no_mod_path"}
        proj = os.path.normpath((project_root or "").strip().rstrip("\\/"))
        try:
            if proj and src.lower().startswith(proj.lower() + os.sep):
                rel = os.path.relpath(src, proj)
            else:
                rel = os.path.basename(src)
            dst = os.path.normpath(os.path.join(mod_root, rel))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if os.path.isdir(src):
                shutil.copytree(src, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(src, dst)
        except Exception as e:  # noqa: BLE001
            self._log.info("copy_to_mod failed: %s: %s", src, e)
            return {"ok": False, "error": str(e)}
        self._log.info("copy_to_mod: %s -> %s", src, dst)
        return {"ok": True, "path": dst}

    # -- explorer ---------------------------------------------------------------
    def reveal(self, path: str) -> dict:
        """Show a file in Explorer (select) or open a folder."""
        if not path or not os.path.exists(path):
            return {"ok": False, "error": "not found"}
        try:
            if os.path.isdir(path):
                os.startfile(path)  # noqa: S606
            else:
                subprocess.Popen(["explorer", "/select,", os.path.normpath(path)],  # noqa: S603,S607
                                 **_NW)
            return {"ok": True}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}

    # -- game dir ---------------------------------------------------------------
    def game_dir(self, path: "str | None" = None) -> dict:
        """Store (path given) / return the game install folder."""
        if path is not None:
            if not path or not os.path.isdir(path):
                return {"ok": False, "error": "not a folder"}
            self._config.set("game_dir", os.path.normpath(path))
        gd = self._config.get("game_dir", "")
        return {
            "ok": True,
            "game_dir": gd,
            "has_mods": bool(gd) and os.path.isdir(os.path.join(gd, "mods")),
        }

    # -- mod scaffolding ----------------------------------------------------------
    def copy_files_into(self, mod_dir: str, files) -> tuple:
        """Copy dragged files into the mod folder, recreating the folder
        structure. files = [{"path": abs, "rel": rel-from-project-root}]."""
        copied, skipped = [], []
        for item in files or []:
            src = (item.get("path") or "").strip()
            rel = (item.get("rel") or "").strip()
            if not src or not os.path.isfile(src):
                skipped.append(os.path.basename(src) if src else "?")
                continue
            # sanitize the relative path: no drives, no traversal
            rel = rel.replace("\\", "/").strip("/")
            parts = [p for p in rel.split("/") if p and p not in (".", "..")
                     and ":" not in p]
            if not parts:
                parts = ["basis", "scripts", os.path.basename(src)]
            dest = os.path.join(mod_dir, *parts)
            try:
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                shutil.copy2(src, dest)
                copied.append("/".join(parts))
            except Exception:  # noqa: BLE001
                skipped.append(os.path.basename(src))
        return copied, skipped

    def create_mod(self, name: str, description: str = "",
                   icon: str = "", files=None) -> dict:
        """Create <game>/mods/<Name>/ with mod.json (+ optional thumbnail).

        Follows the official mod guide: latin folder name, mod.json with
        name / description / icon, icon preferably in basis/ as a dds.
        """
        name = (name or "").strip()
        desc = description or ""
        icon = (icon or "").strip()
        files = files or []
        gd = self._config.get("game_dir", "")
        if not gd or not os.path.isdir(gd):
            return {"ok": False, "error": "no game dir"}
        if not name:
            return {"ok": False, "error": "no name"}
        # the guide asks for a latin-only folder name (no special chars)
        safe = "".join(c for c in name if (c.isascii() and (c.isalnum() or c in " _-"))).strip()
        if not safe:
            return {"ok": False, "error": "bad name"}
        mods = os.path.join(gd, "mods")
        mod_dir = os.path.join(mods, safe)
        if os.path.exists(mod_dir):
            return {"ok": False, "error": "exists", "path": mod_dir}
        try:
            os.makedirs(os.path.join(mod_dir, "basis"), exist_ok=True)

            icon_rel = ""
            if icon and os.path.isfile(icon):
                ext = os.path.splitext(icon)[1].lower()
                dest = os.path.join(mod_dir, "basis", "THUMBNAIL.dds")
                made_dds = False
                if ext != ".dds":
                    try:
                        from PIL import Image
                        img = Image.open(icon).convert("RGBA")
                        # normalize to 16:9 (guide requirement), 512x288
                        tw, th = 512, 288
                        sw, sh = img.size
                        scale = min(tw / sw, th / sh)
                        nw, nh = max(1, int(sw * scale)), max(1, int(sh * scale))
                        img = img.resize((nw, nh))
                        canvas = Image.new("RGBA", (tw, th), (0, 0, 0, 255))
                        canvas.paste(img, ((tw - nw) // 2, (th - nh) // 2))
                        canvas.save(dest, format="DDS")
                        made_dds = True
                    except Exception:  # noqa: BLE001 - Pillow missing / bad image
                        made_dds = False
                if not made_dds:
                    if ext == ".dds":
                        dest = os.path.join(mod_dir, "basis", "THUMBNAIL.dds")
                        with open(icon, "rb") as src, open(dest, "wb") as out:
                            out.write(src.read())
                        made_dds = True
                    else:
                        # keep the original file and reference it as-is
                        fname = "THUMBNAIL" + ext
                        dest = os.path.join(mod_dir, "basis", fname)
                        with open(icon, "rb") as src, open(dest, "wb") as out:
                            out.write(src.read())
                if os.path.isfile(dest):
                    icon_rel = "basis/" + os.path.basename(dest)

            mod_json = {
                "name": name,
                "description": desc.replace("\r\n", "\n"),
                "icon": icon_rel,
            }
            with open(os.path.join(mod_dir, "mod.json"), "w", encoding="utf-8") as f:
                json.dump(mod_json, f, ensure_ascii=False, indent=4)
            copied, skipped = self.copy_files_into(mod_dir, files)
            return {"ok": True, "path": mod_dir,
                    "copied": copied, "skipped": skipped}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def list_mods(self) -> dict:
        """Existing mod folders under <game>/mods."""
        gd = self._config.get("game_dir", "")
        mods = os.path.join(gd, "mods") if gd else ""
        out = []
        if mods and os.path.isdir(mods):
            for n in sorted(os.listdir(mods)):
                if os.path.isdir(os.path.join(mods, n)):
                    out.append(n)
        return {"ok": True, "mods": out}

    def copy_mod_files(self, mod: str, files=None) -> dict:
        """Copy dragged files into an existing mod, recreating structure."""
        mod = (mod or "").strip()
        gd = self._config.get("game_dir", "")
        if not gd or not os.path.isdir(gd):
            return {"ok": False, "error": "no game dir"}
        mod_dir = os.path.normpath(os.path.join(gd, "mods", mod))
        mods_root = os.path.normpath(os.path.join(gd, "mods"))
        if (not mod or not mod_dir.startswith(mods_root + os.sep)
                or not os.path.isdir(mod_dir)):
            return {"ok": False, "error": "no such mod"}
        copied, skipped = self.copy_files_into(mod_dir, files or [])
        return {"ok": True, "path": mod_dir,
                "copied": copied, "skipped": skipped}
