"""Ассеты игры без скачивания: выборочная распаковка GameAssets из паков игры.

Состав — строго как эталонная папка GameAssets (никаких текстур/иконок:
их там нет): basis/{locale,scripts,spawns} + DLC-оверлеи + локализация.
- basis/scripts/* — species, ui, lboxes, json, invs, default_army и т.д.;
- basis/locale/*, basis/spawns/*.swt;
- locale/* и scripts/ui/* из паков локализации (языки выбираются).

Распаковка — 7z с фильтрами путей (тем же 7z и паролем, что у полной
распаковки), в <program_dir>/GameAssets. Успех ставит
game_assets_downloaded=1 — слой активируется как после скачивания.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import threading

from .archive_service import PAK_PASSWORD, Archive
from .archive_service import _NW

# фильтры 7z для главных паков (пути внутри пака — относительно basis/:
# пак базы распаковывается прямо в <dest>/basis/)
GA_MAIN_FILTERS = (
    "locale/*",
    "scripts/*",
    "spawns/*",
)
# фильтры для паков локализации (внутри — locale/ и scripts/ui/)
GA_LOC_FILTERS = ("locale/*", "scripts/ui/*")
# те же префиксы для loose-папки basis рядом с паками (копирование подмножества)
GA_LOOSE_PREFIXES = ("locale", "scripts", "spawns")

# папки для чипов попапа (показ состава, без кликов; языки — кликабельные)
GA_CHIPS = (
    "basis/locale/",
    "basis/scripts/",
    "basis/spawns/",
    "localization/<язык>/locale/",
    "localization/<язык>/scripts/ui/",
)

_GROUPS = ("base", "legion", "resistance", "evolution")


class GameAssets:
    """Выборочная распаковка архива GameAssets из паков игры."""

    def __init__(self, config, log, program_dir):
        self._config = config
        self._log = log
        self._program_dir = program_dir
        self._lock = threading.Lock()
        self._progress = {"state": "idle", "done": 0, "total": 0,
                          "current": "", "error": ""}

    # -- paths ------------------------------------------------------
    def target_dir(self):
        return os.path.normpath(os.path.join(self._program_dir or "", "GameAssets"))

    def has_dir(self):
        try:
            return bool(self.target_dir() and os.path.isdir(self.target_dir()))
        except OSError:
            return False

    # -- state ------------------------------------------------------
    def progress(self):
        with self._lock:
            return dict(self._progress)

    def _set_progress(self, **kw):
        with self._lock:
            self._progress.update(kw)

    def state(self):
        try:
            downloaded = 1 if int(
                self._config.get("game_assets_downloaded") or 0) == 1 else 0
        except (TypeError, ValueError):
            downloaded = 0
        try:
            version = str(self._config.get("game_assets_version") or "")
        except Exception:  # noqa: BLE001
            version = ""
        return {"ok": True, "downloaded": downloaded, "version": version,
                "has_dir": self.has_dir(), "progress": self.progress()}

    # -- scan -------------------------------------------------------
    def _arch(self):
        return Archive(self._log, self._program_dir)

    def scan(self, game_root):
        """Что будет распаковано: группы с паками + языки локализации.
        Чипы состава фиксированы (GA_CHIPS), языки выбираются на фронте."""
        root = (game_root or "").strip()
        if not root or not os.path.isdir(root):
            return {"ok": False, "error": "not a folder"}
        arch = self._arch()
        groups = []
        for key in _GROUPS:
            folder = root if key == "base" else Archive.dlc_dir(root, key)
            if not folder:
                continue
            paks = [os.path.basename(p) for p in arch.pak_plan(folder)]
            langs = {}
            try:
                for e in arch.loc_plan(folder):
                    langs.setdefault(str(e.get("lang") or "?"),
                                     []).append(e.get("name") or "")
            except Exception:  # noqa: BLE001
                pass
            loose = os.path.isdir(os.path.join(folder, "basis", "scripts",
                                               "species"))
            groups.append({"key": key, "paks": paks, "langs": langs,
                           "loose": bool(loose)})
        if not groups:
            return {"ok": False, "error": "no paks"}
        return {"ok": True, "sevenz": bool(arch.find_7z()), "groups": groups,
                "chips": list(GA_CHIPS)}

    # -- extract ----------------------------------------------------
    def extract(self, game_root, langs=None):
        with self._lock:
            if self._progress.get("state") == "working":
                return {"ok": False, "error": "already running"}
            self._progress = {"state": "working", "done": 0, "total": 0,
                              "current": "", "error": ""}
        root = (game_root or "").strip()
        if not root or not os.path.isdir(root):
            self._set_progress(state="error", error="not a folder")
            return {"ok": False, "error": "not a folder"}
        want = {str(x).lower() for x in (langs or []) if str(x).strip()}
        th = threading.Thread(target=self._extract_job, args=(root, want),
                              daemon=True, name="ga-local")
        th.start()
        return {"ok": True, "started": True}

    def _extract_job(self, root, want_langs):
        arch = self._arch()
        sevenz = arch.find_7z()
        if not sevenz:
            self._set_progress(state="error", error="7z not found")
            return
        # план: [(out_rel, pak, outdir, фильтры)] + [(src_basis, dst_basis)]
        steps = []
        for key in _GROUPS:
            folder = root if key == "base" else Archive.dlc_dir(root, key)
            if not folder:
                continue
            basis_rel = "basis" if key == "base" else \
                os.path.join("dlc", key, "basis")
            for p in arch.pak_plan(folder):
                steps.append(("pak", p, basis_rel, list(GA_MAIN_FILTERS)))
            try:
                locs = arch.loc_plan(folder)
            except Exception:  # noqa: BLE001
                locs = []
            for e in locs:
                lang = str(e.get("lang") or "")
                if want_langs and lang.lower() not in want_langs:
                    continue
                loc_rel = os.path.join(
                    "dlc", key, "localization", lang, e.get("stem") or "") \
                    if key != "base" else os.path.join(
                        "localization", lang, e.get("stem") or "")
                steps.append(("pak", e["path"], loc_rel, list(GA_LOC_FILTERS)))
            loose_basis = os.path.join(folder, "basis")
            if os.path.isdir(os.path.join(loose_basis, "scripts", "species")):
                steps.append(("loose", loose_basis, basis_rel, []))
        if not steps:
            self._set_progress(state="error", error="no paks")
            return
        target = self.target_dir()
        if not target:
            self._set_progress(state="error", error="no program dir")
            return
        # замена целиком, как было у скачивания
        try:
            shutil.rmtree(target, ignore_errors=True)
        except Exception:  # noqa: BLE001
            pass
        self._set_progress(total=len(steps), done=0)
        for kind, src, out_rel, filters in steps:
            outdir = os.path.join(target, out_rel)
            try:
                os.makedirs(outdir, exist_ok=True)
            except OSError:
                pass
            self._set_progress(current=os.path.basename(src))
            try:
                if kind == "pak":
                    self._extract_filtered(sevenz, src, outdir, filters)
                else:
                    self._copy_subset(src, outdir)
            except Exception as e:  # noqa: BLE001
                self._set_progress(state="error", error=str(e))
                return
            self._set_progress(done=self._progress.get("done", 0) + 1)
        try:
            self._config.set("game_assets_downloaded", 1)
        except Exception:  # noqa: BLE001
            pass
        try:
            self._config.set("game_assets_version", "local")
        except Exception:  # noqa: BLE001
            pass
        self._set_progress(state="done", current="",
                           done=self._progress.get("total", 0))

    @staticmethod
    def _extract_filtered(sevenz, pak, outdir, filters):
        """7z x только по фильтрам путей. Несовпадение фильтров — не ошибка
        (у патчей состава может не быть): 7z тогда без 'Everything is Ok'."""
        proc = subprocess.run(
            [sevenz, "x", "-y", "-aoa", "-bd", "-mmt=on",
             "-p" + PAK_PASSWORD, "-o" + outdir, pak] + list(filters),
            capture_output=True, text=True, errors="replace", **_NW)
        if proc.returncode != 0:
            tail = (proc.stdout or "")[-300:]
            raise OSError("7z failed on %s: %s"
                          % (os.path.basename(pak), tail))

    @staticmethod
    def _copy_subset(src_basis, dst_basis):
        """Копия loose-папки basis, но только префиксы GA_LOOSE_PREFIXES."""
        for dirpath, _dirs, files in os.walk(src_basis):
            rel = os.path.relpath(dirpath, src_basis)
            rel_norm = rel.replace(os.sep, "/")
            keep = rel_norm == "." or any(
                rel_norm == p or rel_norm.startswith(p.rstrip("*").rstrip("/"))
                or p.startswith(rel_norm + "/") or p == rel_norm
                for p in GA_LOOSE_PREFIXES)
            if not keep:
                # поддерево вне состава — срезать целиком, кроме корня
                if rel_norm != ".":
                    _dirs[:] = []
                continue
            for fn in files:
                f_rel = (rel_norm + "/" + fn) if rel_norm != "." else fn
                if not any(f_rel == p or f_rel.startswith(p.rstrip("*"))
                           for p in GA_LOOSE_PREFIXES):
                    continue
                dst = os.path.join(dst_basis, f_rel.replace("/", os.sep))
                try:
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    shutil.copy2(os.path.join(dirpath, fn), dst)
                except OSError:
                    pass
