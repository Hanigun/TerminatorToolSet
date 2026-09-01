"""Project Registry: understands the Terminator: Dark Fate - Defiance mod layout.

When the user opens a whole mod folder, we enumerate every species/*.xml and map
families of files to friendly category names so the UI can present a clean tree
(Гуннемы/Юниты/Модификации/Патроны/…).

This is a BUILT-IN registry (the user can also override via a JS/JSON config
later, but the defaults live here and cover the stock files).
"""
from __future__ import annotations

import os
from typing import Optional

from spreadsheet_ml import iter_rows_logical

# friendly-name handlers: category name -> predicate(file_name). Locale-aware
# labels are provided by i18n; here we use stable category keys.
FAMILIES: "list[dict]" = [
    {"key": "humans",       "match": lambda f: f == "humans.xml"},
    {"key": "squads",       "match": lambda f: f == "squads.xml"},
    {"key": "squad_upgrades", "match": lambda f: f in ("squad_upgrades.xml", "squad_upgrade_presets.xml")},
    {"key": "cars",         "match": lambda f: f == "cars.xml"},
    {"key": "car_upgrades", "match": lambda f: f.startswith("car_") and f.endswith("_upgrades.xml") and f != "cars.xml"},
    {"key": "tanks",        "match": lambda f: f == "tanks.xml"},
    {"key": "tank_upgrades","match": lambda f: f.startswith("tank_") and f.endswith("_upgrades.xml") and f != "tanks.xml"},
    {"key": "helicopters",  "match": lambda f: f == "helicopters.xml"},
    {"key": "heli_upgrades","match": lambda f: f.startswith("heli_") and f.endswith("_upgrades.xml")},
    {"key": "guns",         "match": lambda f: f in ("guns.xml", "gun_mounts.xml")},
    {"key": "ammunition",   "match": lambda f: f in ("ammunition.xml",)},
    {"key": "modules",      "match": lambda f: f in ("modules.xml", "gun_slots.xml", "crew.xml", "joints.xml")},
    {"key": "animations",   "match": lambda f: f.startswith("animations_")},
    {"key": "exp",          "match": lambda f: f in ("exp_levels.xml",)},
    {"key": "reinforcements", "match": lambda f: f == "reinforcements.xml"},
    {"key": "spawns_sheet", "match": lambda f: f == "spawns.xml"},
    {"key": "misc",         "match": lambda f: True},
]


def _categorize(file_name: str) -> str:
    for fam in FAMILIES:
        if fam["match"](file_name):
            return fam["key"]
    return "misc"


def _overlay_key(rel_path: str) -> str:
    """Classify a project-relative path into an overlay group.

    basis/...                     -> 'basis' (base game / Company)
    dlc/Resistance/...            -> 'dlc_resistance'
    dlc/Legion/...                -> 'dlc_legion'
    dlc/Evolution/...             -> 'dlc_evolution'
    dlc/<other>/...               -> 'dlc'
    """
    parts = [p.lower() for p in rel_path.split(os.sep)]
    if parts and parts[0] == "dlc":
        for p in parts[1:]:
            if "resistance" in p:
                return "dlc_resistance"
            if "legion" in p:
                return "dlc_legion"
            if "evolution" in p:
                return "dlc_evolution"
        return "dlc"
    return "basis"


class ProjectFile:
    """A single .xml file in the project, with its friendly category."""

    __slots__ = ("path", "rel_path", "file_name", "category", "overlay",
                 "sheet_count", "row_count")

    def __init__(self, path: str, root: str, category: str,
                 sheet_count: int = 0, row_count: int = 0):
        self.path = path
        self.rel_path = os.path.relpath(path, root) if root else path
        self.file_name = os.path.basename(path)
        self.category = category
        self.overlay = _overlay_key(self.rel_path)
        self.sheet_count = sheet_count
        self.row_count = row_count

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "rel_path": self.rel_path,
            "file_name": self.file_name,
            "category": self.category,
            "overlay": self.overlay,
            "sheet_count": self.sheet_count,
            "row_count": self.row_count,
        }


class Project:
    """An opened mod folder (or single file)."""

    def __init__(self, root: Optional[str] = None):
        self.root = root
        self.files: list[ProjectFile] = []
        self._names: Optional[dict] = None
        self._names_lang: Optional[str] = None

    # -- loading ------------------------------------------------------------
    def scan(self, root: str, max_files: int = 2000) -> "Project":
        """Walk a mod folder collecting species/*.xml (and dlc overlays)."""
        self.root = root
        self.files = []
        self._names = None
        self._names_lang = None
        seen: set[str] = set()
        for dirpath, dirnames, filenames in os.walk(root):
            # skip heavy non-species directories but keep species paths
            dirnames[:] = [d for d in dirnames
                           if d not in (".codebase-memory", ".git", "__pycache__", "spawns")]
            for fn in filenames:
                if not fn.endswith(".xml"):
                    continue
                full = os.path.join(dirpath, fn)
                if full.lower() in seen:
                    continue
                seen.add(full.lower())
                # Accept only files whose parent dir is named "species"
                # (covers basis/scripts/species and dlc overlays).
                if os.path.basename(dirpath) != "species":
                    continue
                cat = _categorize(fn)
                self.files.append(ProjectFile(full, root, cat))
                if len(self.files) >= max_files:
                    break
            if len(self.files) >= max_files:
                break
        self.files.sort(key=lambda f: (f.category, f.file_name))
        return self

    # -- query ---------------------------------------------------------------
    def by_category(self) -> dict:
        groups: dict[str, list] = {}
        for f in self.files:
            groups.setdefault(f.category, []).append(f.to_dict())
        return groups

    def by_overlay_category(self) -> dict:
        """Tree model: {overlay: {rel_dir, categories: {category: [file,…]}}}."""
        tree: dict[str, dict] = {}
        for f in self.files:
            node = tree.setdefault(f.overlay, {"rel_dir": "", "categories": {}})
            if not node["rel_dir"]:
                node["rel_dir"] = os.path.dirname(f.rel_path)
            node["categories"].setdefault(f.category, []).append(f.to_dict())
        return tree

    # -- friendly names -------------------------------------------------------
    def display_names(self, lang: str = "ru") -> dict:
        """{sysname: display_name} from localization/<lang>/.../locale/*.xml.

        Locale files map sysname (col 1) -> content (col 2); the first
        non-empty content wins. Cached per (root, lang)."""
        if self._names is not None and self._names_lang == lang:
            return self._names
        names: dict[str, str] = {}
        if self.root and os.path.isdir(self.root):
            root_norm = os.path.normpath(self.root).lower() + os.sep
            for dirpath, dirnames, filenames in os.walk(self.root):
                dirnames[:] = [d for d in dirnames
                               if d not in (".git", "__pycache__")]
                dnorm = os.path.normpath(dirpath).lower()
                if os.path.basename(dnorm) != "locale":
                    continue
                # must live under localization/<lang>/
                parts = dnorm[len(root_norm):].split(os.sep) if dnorm.startswith(root_norm) else []
                if "localization" not in parts:
                    continue
                if lang not in parts:
                    continue
                for fn in filenames:
                    if not fn.endswith(".xml"):
                        continue
                    try:
                        for vals in iter_rows_logical(os.path.join(dirpath, fn),
                                                      skip_header=True):
                            if len(vals) >= 2 and vals[0] and vals[1]:
                                v = vals[1].strip()
                                # keep short labels only - locale files also
                                # carry long description blobs in `content`
                                if len(v) <= 60 and "\n" not in v:
                                    names.setdefault(vals[0].strip(), v)
                    except Exception:  # noqa: BLE001
                        continue
        self._names = names
        self._names_lang = lang
        return names

    def to_dict(self, lang: str = "ru") -> dict:
        return {
            "root": self.root,
            "files": [f.to_dict() for f in self.files],
            "categories": self.by_category(),
            "overlays": self.by_overlay_category(),
            "display_names": self.display_names(lang),
        }
