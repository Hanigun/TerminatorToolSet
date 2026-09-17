"""Uprising map support: species parsing, icons, balance configs, SWT dicts."""
from __future__ import annotations

import base64
import glob
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor


# -- module constants (game data layout) --------------------------------------
# OUTER = папка с main.py (исходники) — рядом лежит GameScripts
_OUTER_DIR = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))))
_SS_NS = "urn:schemas-microsoft-com:office:spreadsheet"
_ICON_FILES = ["tanks.xml", "cars.xml", "helicopters.xml",
               "squads.xml", "inventory_items.xml"]
_PRESET_FILES = ["squad_upgrade_presets.xml", "tank_upgrade_presets.xml",
                 "car_upgrade_presets.xml", "heli_upgrade_presets.xml"]
# detail upgrade files (guns/armor/engines/squads): their sysname rows carry
# a tech_pic/hover_image_player/icon column like species do — parsed into
# the same icon map. New units/guns/icons from mods are picked up
# automatically, no name lists anywhere.
_GUN_FILES = ["car_gun_upgrades.xml", "car_armor_upgrades.xml",
              "car_engine_upgrades.xml", "tank_gun_upgrades.xml",
              "tank_armor_upgrades.xml", "tank_engine_upgrades.xml",
              "heli_gun_upgrades.xml", "heli_armor_upgrades.xml",
              "heli_engine_upgrades.xml", "squad_upgrades.xml"]
_CFG_CATS = ["squads", "tanks", "cars", "helicopters", "inventory_items"]
# -- рандомайзер v2 -----------------------------------------------------------
# Папки режимов: встроенные (в exe/рядом) + пользовательские (перекрытия).
_RND_DIR_BUILTIN = "UprisingRandomizer"
_RND_DIR_CUSTOM = "UprisingCustomRandomizer"
_RND_NAMES = ("easy", "balanced", "hard", "chaos")
# Фракции v2 (конфиг) -> имя щита/меты. neutral из v1 тоже принимаем (=grey).
_RND_FACTIONS = ("player", "legion", "integrators", "founders", "grey",
                 "yellow", "neutral")
_RND_FACTION_MAP = {"player": "player", "legion": "legion",
                    "integrators": "integrators", "founders": "movement",
                    "grey": "marauders", "neutral": "marauders",
                    "yellow": "cartel"}
# Стартовые сектора игрока и столицы (UPR_CAPITALS в uprising.js).
_RND_STARTS = (1, 2, 22)
_RND_CAPITALS = (1, 4, 12, 18, 22)
_RND_MODES = ("own", "mix", "free")
# Правила по умолчанию на режим: Легко/Баланс с ±1, Сложно/Хаос строго;
# free только через Эксперт/свои пресеты (в 4 базовых не используется).
_RND_DEFAULTS = {
    "easy": {"faction_mode": "own", "chaos_k": 0.4, "count_heads": True,
             "diff_soft_pm": True, "no_origin": False,
             "no_neighbours": False, "cap_heads": 20, "seed_default": 12345},
    "balanced": {"faction_mode": "own", "chaos_k": 1.0, "count_heads": True,
                 "diff_soft_pm": True, "no_origin": False,
                 "no_neighbours": False, "cap_heads": 0, "seed_default": 12345},
    "hard": {"faction_mode": "own", "chaos_k": 1.2, "count_heads": True,
             "diff_soft_pm": False, "no_origin": False,
             "no_neighbours": False, "cap_heads": 20, "seed_default": 12345},
    "chaos": {"faction_mode": "mix", "chaos_k": 2.0, "count_heads": True,
              "diff_soft_pm": False, "no_origin": True,
              "no_neighbours": False, "cap_heads": 0, "seed_default": 12345},
}
_RND_WEIGHTS_DFLT = {"squads": 1.0, "cars": 2.0, "tanks": 3.0,
                     "helicopters": 3.0, "inventory_items": 0.2}
_RND_LOOT_DFLT = {"rare_min_cost": 1500, "rare_only_diff": 4,
                  "rare_in_capital": True, "common_free": True}
_SWT_TEAMS = ["player", "founders", "legion", "marauders", "cartel",
              "integrators", "resistance", "mercenaries", "neutral",
              "player_ally", "founders_ally", "integrators_ally",
              "total_marauders"]
_UPR_FACTIONS = ("legion", "founders", "resistance", "marauders",
                 "cartel", "integrators")
_SPECIES_NAME_RE = re.compile(r"<Data[^>]*>(.*?)</Data>", re.S)
_SPECIES_ROW_RE = re.compile(r"<Row[^>]*>(.*?)</Row>", re.S)
_UPRISING_REL = os.path.join("dlc", "Resistance", "basis", "scripts",
                             "species", "shop_presets.xml")
# Маркер файла карты: sysname наград секторов (DLC Resistance). Тот же
# паттерн, что группировка секторов на фронте (uprGroups в uprising.js):
# детект срабатывает ровно тогда, когда карта покажет секторы.
_UPR_SECTOR_RE = re.compile(r"^sector_\d+_reward")
# Карта — если сектор-строк не меньше минимума И не меньше половины
# именованных строк (DLC: 39/39; базовый файл: 0/27 -> таблица).
_UPR_SECTOR_MIN = 2
# Маркер магазинных строк кампании (вторая сторона смешанного файла):
# test_shop_* — тестовые, vega_*/tortuga_* — поселения, resistance_dlc_shop*
# — демо. Тот же набор, что фильтрует cmpPresets в campaign.js.
_UPR_SHOP_RE = re.compile(r"^(test_shop|vega_|tortuga_|resistance_dlc_shop)")


# -- uprising -----------------------------------------------------------------
class Uprising:
    """Species parsing, unit icons, balance configs and SWT dictionaries.

    Icon binding comes from the source-root species files:
      tanks/cars/helicopters.xml -> tech_pic (vehicles_icons_small\\name)
      squads.xml -> hover_image_player (infantry_icons_small\\name)
      inventory_items.xml -> icon (ui/pictures/inventory/name.dds)
    Upgrade presets (*_upgrade_presets.xml) point at a base unit
    (squad_sysname/unit_sysname) and inherit its icon.
    Icon files resolve: готовые webp из CustomImages/<слой> ->
    source root (basis\\textures\\...) -> unpacked game -> DLC overlays.
    Встроенных иконок юнитов в программе нет. .dds конвертируется в
    CustomImages/<слой>/{stem}.webp (слой: игра=BaseGame, проект/мод=
    имя папки корня) через dds_converter (Pillow), существующий файл
    просто перезаписывается.
    """

    def __init__(self, store, config, entities, log, base_dir, app_dir,
                 program_dir=""):
        self._store = store
        self._config = config
        self._entities = entities
        self._log = log
        self._base = base_dir   # assets root (frozen: _MEIPASS, else repo)
        self._app_dir = app_dir  # folder with app.py (dev fallback)
        # program dir для GameAssets (frozen — рядом с exe, dev — корень
        # исходников); совпадает с config.dir, фолбэк — он же
        try:
            _cdir = (config.dir or "") if hasattr(config, "dir") else ""
        except Exception:  # noqa: BLE001
            _cdir = ""
        self._program_dir = program_dir or _cdir
        self.icon_dir = os.path.join(app_dir, "assets", "UprisingMap")
        # release: full assets/ next to the EXE wins over the bundled one
        self.icon_dir_ext = os.path.join(config.dir, "assets",
                                         "UprisingMap")
        if not os.path.isdir(self.icon_dir_ext):
            self.icon_dir_ext = os.path.join(os.path.dirname(config.dir),
                                             "assets", "UprisingMap")
        self.png_cache = os.path.join(tempfile.gettempdir(), "tsh_upr_icons")
        self.webp_buckets = {
            "vehicles": os.path.join(self.icon_dir, "UnitIcons", "tech_pic",
                                     "vehicles_icons_small"),
            "infantry": os.path.join(self.icon_dir, "UnitIcons", "tech_pic",
                                     "infantry_icons_small"),
            "inventory": os.path.join(self.icon_dir, "inventory"),
            # готовые webp из .dds (плоско): второе место поиска иконок
            "custom": os.path.join(app_dir, "assets", "CustomImages"),
        }
        # релиз: внешние assets/ рядом с EXE выигрывают у встроенных
        self.custom_dir_ext = os.path.join(config.dir, "assets",
                                           "CustomImages")
        if not os.path.isdir(self.custom_dir_ext):
            self.custom_dir_ext = os.path.join(os.path.dirname(config.dir),
                                               "assets", "CustomImages")
        self.webp_idx = {"mt": 0.0, "map": {}}  # stem.lower() -> (bucket, file)
        self.icon_cache = {}  # layers-key -> {"mt": float, "map": {...}}
        self.icon_low_cache = {}  # layers-key -> пониженный индекс карты
        # мемо поиска исходников состояний: (layers-key, species-mt, имя) ->
        # {hover/selected: path}. Повторные открытия страниц звали
        # icon_state_sources на каждое имя заново (десятки stat на имя,
        # 400+ имён — под секунду каждый раз); пути от wepb-кэша не зависят,
        # валидность — по mt species-карты.
        self._state_src_memo = {}
        # (состояния иконок: запрос любым регистром при регистрозависимых
        # ключах species; строится один раз на поколение icon_cache)
        self.dlc_cache = {}   # root -> (dlc dir mtime, [dlc dirs])
        self.icon_lock = threading.Lock()  # one map rebuild per root
        self.conv_mem = {}    # (src.lower(), mtime) -> png; skips re-stat
        self.data_mem = {"mt": 0.0, "map": {}}  # bucket/file -> data-URL
        self.sysn_cache = {}  # root-key -> {"mt": float, "res": {...}}
        self.find_cache = {}  # root -> (path, ts): мемоизация find_shop,
        # иначе каждый openUprising — полный os.walk по root (секунды)
        self.price_cache = {}  # root-key -> {"mt": float, "res": {...}}
        # ЭКСПЕРИМЕНТ «слот техники» (откат: удалить поле + capacity/_capacity_build)
        self.cap_cache = {}  # root-key -> {"mt": float, "res": {...}}
        self.shields_mem = {"mt": -1.0, "map": {}}  # key -> data-URL
        self.placeholder = os.path.join(self.png_cache, "_placeholder.png")
        # кэш иконок в релиз не пакуется (как Logs): папка создаётся
        # при первом старте, webp кладёт туда конвертер
        self.ensure_custom_images()
        # дисковый кэш species-карты иконок: память процесса умирает при
        # каждом выходе, а парсинг всех species холодным стоил ~1с — первый
        # батч иконок любого редактора после запуска снова крутил спиннеры.
        # mtime-ключ тот же, что у памяти: правим species — пересобирается.
        try:
            base = os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()
            self.icon_disk_dir = os.path.join(base, "TerminatorToolSet",
                                              "upr_iconmap")
            os.makedirs(self.icon_disk_dir, exist_ok=True)
        except Exception:  # noqa: BLE001
            try:
                self.icon_disk_dir = self.png_cache
            except Exception:  # noqa: BLE001
                self.icon_disk_dir = ""

    def ensure_custom_images(self):
        """Создать корни CustomImages (внешний рядом с EXE + встроенный),
        если их нет: свежий релиз приезжает без этой папки вообще.
        Важно: primary (config.dir) создаём первым и перепривязываем ext
        на него — иначе isdir-фолбэк из __init__ увёл бы кэш в родителя
        каталога программы. Подпапки слоёв дожарит сам конвертер
        (_custom_target)."""
        try:
            primary = os.path.join(self._config.dir, "assets",
                                   "CustomImages")
        except Exception:  # noqa: BLE001
            primary = ""
        if primary:
            try:
                os.makedirs(primary, exist_ok=True)
            except OSError:
                pass
            try:
                if os.path.isdir(primary):
                    self.custom_dir_ext = primary
            except Exception:  # noqa: BLE001
                pass
        for d in dict.fromkeys((self.custom_dir_ext,
                                self.webp_buckets.get("custom", ""))):
            if not d:
                continue
            try:
                os.makedirs(d, exist_ok=True)
            except OSError:
                pass

    # -- species parsing --------------------------------------------------------
    @staticmethod
    def _parse_sheet(path):
        """Excel-XML rows as {column index -> text}, honouring ss:Index
        (empty cells shift indexes - naive parsing lies)."""
        try:
            import xml.etree.ElementTree as ET
            tbl_root = ET.parse(path).getroot()
            tbl = tbl_root.find(".//{%s}Table" % _SS_NS)
            if tbl is None:
                return []
            rows = []
            for r in tbl.findall("{%s}Row" % _SS_NS):
                cells = {}
                idx = 0
                for c in r.findall("{%s}Cell" % _SS_NS):
                    si = c.get("{%s}Index" % _SS_NS)
                    if si:
                        idx = int(si) - 1
                    d = c.find("{%s}Data" % _SS_NS)
                    cells[idx] = (d.text or "") if d is not None else ""
                    idx += 1
                rows.append(cells)
            return rows
        except Exception:  # noqa: BLE001
            return []

    def _live_sheet_rows(self, path):
        """Живые строки species-файла из открытой сессии, а не с диска.

        prices()/capacity() парсят файлы напрямую — после undo/redo
        (только память, без записи на диск) они показывали бы неоткаченные
        значения. Сессии нет — None, вызывающий читает диск как раньше."""
        try:
            s = self._store.sessions.get(self._store.normal(path or ""))
        except Exception:  # noqa: BLE001
            return None
        if s is None:
            return None
        try:
            names = s.worksheet.column_names() or []
            rows = [{i: str(h or "") for i, h in enumerate(names)}]
            # один проход на строку (Row.values_row): поштучный cell_value
            # пересобирал cells на каждую ячейку из сотен колонок
            for r in s.worksheet.rows:
                try:
                    vals = r.values_row(len(names))
                except Exception:  # noqa: BLE001
                    vals = []
                cells = {}
                for i, v in enumerate(vals):
                    try:
                        cells[i] = str(v or "")
                    except Exception:  # noqa: BLE001
                        cells[i] = ""
                rows.append(cells)
            return rows
        except Exception:  # noqa: BLE001
            return None

    def _paths_dirty(self, paths):
        """Есть ли среди путей сессии с незаписанными правками: их mtime
        на диске врёт, кэш по mtime отдавал бы дооткатное."""
        try:
            dirty = self._store.dirty
            return any(self._store.normal(p or "") in dirty for p in paths)
        except Exception:  # noqa: BLE001
            return False

    def _species_paths(self, root):
        """((name, path) base) + {name: [DLC overlay paths]} species files
        (units, items, upgrade presets and gun/armor/engine details)."""
        sp = os.path.join(root, "basis", "scripts", "species")
        base = []
        for fname in _ICON_FILES + _GUN_FILES:
            p = os.path.join(sp, fname)
            if os.path.isfile(p):
                base.append((fname, p))
        overlay = {}
        for d in self._dlc_dirs(root):
            dsp = os.path.join(d, "basis", "scripts", "species")
            for fname in _ICON_FILES + _PRESET_FILES + _GUN_FILES:
                p = os.path.join(dsp, fname)
                if os.path.isfile(p):
                    overlay.setdefault(fname, []).append(p)
        return base, overlay

    def _layer_roots(self, root):
        """Data lookup layers in order: the map's own source root first,
        then unpacked game -> project -> mod -> GameAssets. The source the
        map was opened from wins (e.g. a map from the mod sees mod icons
        first), the rest fill the gaps. Ready-made app webp assets come even
        earlier, see icon_webp."""
        try:
            game = self.unpacked_root()
        except Exception:  # noqa: BLE001
            game = ""
        try:
            proj = (self._entities.project.root
                    if self._entities.project is not None else "") or ""
        except Exception:  # noqa: BLE001
            proj = ""
        try:
            mod = self._store.normal(self._config.get("mod_path") or "") or ""
        except Exception:  # noqa: BLE001
            mod = ""
        try:
            ga = self._ga_root()
        except Exception:  # noqa: BLE001
            ga = ""
        layers = []
        for cand in (os.path.normpath(root or ""), game, proj, mod, ga,
                     self._gamescripts_dir()):
            if not cand or not os.path.isdir(cand):
                continue
            p = os.path.normpath(cand)
            key = os.path.normcase(p)
            if all(os.path.normcase(x) != key for x in layers):
                layers.append(p)
        return layers

    def _ga_root(self):
        """Корень GameAssets (только чтение): <program_dir>/GameAssets при
        game_assets_downloaded == 1 и существующей папке, иначе ''."""
        try:
            from ..infrastructure.gameassets_path import (
                game_assets_root as _ga,
            )
            return _ga(self._config, self._program_dir) or ""
        except Exception:  # noqa: BLE001
            return ""

    def _gamescripts_dir(self):
        """Bundled GameScripts (stock game scripts + helpers): last-resort
        fallback when a file is missing in project/game/mod. Used for unit
        icons and sysname autocomplete."""
        cands = [os.path.join(_OUTER_DIR, "GameScripts")]
        try:
            cdir = (self._config.dir or "") if hasattr(self._config, "dir") else ""
        except Exception:  # noqa: BLE001
            cdir = ""
        if cdir:
            cands.append(os.path.join(cdir, "GameScripts"))
            cands.append(os.path.join(os.path.dirname(cdir), "GameScripts"))
        for c in cands:
            try:
                if c and os.path.isdir(c):
                    return os.path.normpath(c)
            except OSError:
                pass
        return ""

    def icon_map(self, root):
        """{sysname: (texture-relative icon path, kind: unit|item)} from
        species + upgrade presets. Layers, map source first: first wins
        (the source the map was opened from, then the rest). Cached over
        all layers, invalidated by file mtimes."""
        layers = self._layer_roots(root)
        if not layers:
            return {}
        per_layer = []
        all_paths = []
        for lay in layers:
            try:
                base, overlay = self._species_paths(lay)
            except OSError:
                continue
            paths = [p for _, p in base]
            for name in _PRESET_FILES:
                p = os.path.join(lay, "basis", "scripts", "species", name)
                if os.path.isfile(p):
                    paths.append(p)
            for ps in overlay.values():
                paths.extend(ps)
            per_layer.append((lay, base, overlay))
            all_paths.extend(paths)
        mt = 0.0
        for p in all_paths:
            try:
                mt = max(mt, os.path.getmtime(p))
            except OSError:
                pass
        key = "|".join(layers)
        ent = self.icon_cache.get(key)
        if ent and ent["mt"] == mt:
            return ent["map"]
        # herd rebuild: dozens of parallel /api/uprising_icon on map open
        # used to parse every species file each (GIL) - seconds
        with self.icon_lock:
            ent = self.icon_cache.get(key)
            if ent and ent["mt"] == mt:
                return ent["map"]
            disk = self._icon_disk_load(key, mt)
            if disk is not None:
                self.icon_cache[key] = disk
                return disk["map"]
            amap = {}
            gun_acc = {}
            for lay, base, overlay in per_layer:
                sub_acc = {}
                sub = self._icon_map_build(lay, base, overlay, sub_acc)
                for k, v in sub.items():
                    amap.setdefault(k, v)
                for u, gs in sub_acc.get("unit_guns", {}).items():
                    dst = gun_acc.setdefault("unit_guns", {}).setdefault(u, [])
                    for g in gs:
                        if g not in dst:
                            dst.append(g)
                for p, u in sub_acc.get("preset_unit", {}).items():
                    gun_acc.setdefault("preset_unit", {}).setdefault(p, u)
            self.icon_cache[key] = {"mt": mt, "map": amap, "guns": gun_acc}
            self._icon_disk_save(key, mt, amap, gun_acc)
            return amap

    def _icon_disk_path(self, key):
        """Путь дискового кэша species-карты по ключу слоёв."""
        try:
            if not self.icon_disk_dir:
                return ""
            fp = hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]
            return os.path.join(self.icon_disk_dir, "map_" + fp + ".json")
        except Exception:  # noqa: BLE001
            return ""

    def _icon_disk_load(self, key, mt):
        """Готовая карта с диска (память процесса переживает перезапуски):
        {"mt", "map", "guns"} или None. Без валидации схемы — битый файл
        просто игнорируется и пересобирается ниже."""
        try:
            p = self._icon_disk_path(key)
            if not p or not os.path.isfile(p):
                return None
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict) or data.get("mt") != mt:
                return None
            raw = data.get("map") or {}
            guns = data.get("guns") or {}
            if not isinstance(raw, dict) or not isinstance(guns, dict):
                return None
            amap = {}
            for k, v in raw.items():
                if isinstance(v, (list, tuple)) and len(v) == 2:
                    amap[str(k)] = (str(v[0]), str(v[1]))
            return {"mt": mt, "map": amap, "guns": guns}
        except Exception:  # noqa: BLE001
            return None

    def _icon_disk_save(self, key, mt, amap, gun_acc):
        """Записать карту на диск (best-effort, через tmp+replace)."""
        try:
            p = self._icon_disk_path(key)
            if not p:
                return
            tmp = p + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"mt": mt, "map": amap, "guns": gun_acc}, f)
            os.replace(tmp, p)
        except Exception:  # noqa: BLE001
            pass

    def gun_index(self, root):
        """Preset->unit / unit->guns companion of icon_map(), same cache
        entry (built from the same files, same mtime key)."""
        try:
            self.icon_map(root)
        except Exception:  # noqa: BLE001
            return {}
        try:
            layers = self._layer_roots(root)
            if not layers:
                return {}
            ent = self.icon_cache.get("|".join(layers)) or {}
            return ent.get("guns") or {}
        except Exception:  # noqa: BLE001
            return {}

    def _icon_map_build(self, root, base, overlay, gun_acc):
        """Heavy half of icon_map: parse all species + preset files.
        Runs under icon_lock, never writes the cache (caller does)."""
        amap = {}

        def add_rows(path, kind):
            rows = self._parse_sheet(path)
            if not rows:
                return
            head = rows[0]
            sys_idx = 0
            icon_idx = None
            for idx, val in head.items():
                v = str(val).strip()
                if v == "sysname":
                    sys_idx = idx
                elif v in ("tech_pic", "hover_image_player", "icon"):
                    icon_idx = idx
            if icon_idx is None:
                return
            for r in rows[1:]:
                sys = str(r.get(sys_idx, "")).strip()
                if not sys or sys.startswith("#"):
                    continue
                rel = str(r.get(icon_idx, "")).strip().replace("\\", "/")
                if rel:
                    amap[sys] = (rel, kind)

        # base files, then DLC overlays on top (same sysname is overridden)
        for fname, p in base:
            add_rows(p, "item" if fname == "inventory_items.xml" else "unit")
        for fname, _ in base:
            for p in overlay.get(fname, []):
                add_rows(p, "item" if fname == "inventory_items.xml" else "unit")
        # upgrade presets: sysname -> base unit, icon is inherited
        sp = os.path.join(root, "basis", "scripts", "species")
        for fname in _PRESET_FILES:
            paths = [os.path.join(sp, fname)] + overlay.get(fname, [])
            for p in paths:
                if not os.path.isfile(p):
                    continue
                for r in self._parse_sheet(p)[1:]:
                    if not r:
                        continue
                    sys = str(r.get(0, "")).strip()
                    base_unit = (str(r.get(1, "")).strip()
                                 if len(r) > 1 else "")
                    if sys and not sys.startswith("#") and base_unit in amap:
                        amap[sys] = amap[base_unit]
        # preset->gun match data (unit_sysname + gun rows of the same unit):
        # filled into gun_acc, cached together with the map
        self._acc_gun_rows(root, overlay, gun_acc)

        return amap

    @staticmethod
    def _unit_col(rows):
        """Column index of unit_sysname by header name (mods may shift
        columns — never assume a position)."""
        if not rows:
            return None
        for idx, val in rows[0].items():
            if str(val).strip() == "unit_sysname":
                return idx
        return None

    def _acc_gun_rows(self, root, overlay, gun_acc):
        """Collect {unit -> [gun sysnames]} and {preset -> unit} for the
        preset-to-gun match (see match_preset_gun). Base first, DLC
        overlays add rows (same sysname is overridden)."""
        sp = os.path.join(root, "basis", "scripts", "species")
        unit_guns = gun_acc.setdefault("unit_guns", {})
        preset_unit = gun_acc.setdefault("preset_unit", {})

        def add(path, store_presets):
            try:
                rows = self._parse_sheet(path)
            except Exception:  # noqa: BLE001
                return
            uidx = self._unit_col(rows)
            if uidx is None:
                return
            # в матче участвуют только орудия (*gun_upgrades): броня/двигатели
            # — тоже строки улучшений, но иконку задаёт именно орудие
            is_gun = "gun" in os.path.basename(path).lower()
            for r in rows[1:]:
                if not r:
                    continue
                try:
                    sys = str(r.get(0, "")).strip()
                    unit = str(r.get(uidx, "")).strip()
                except Exception:  # noqa: BLE001
                    continue
                if not sys or sys.startswith("#") or not unit:
                    continue
                if store_presets:
                    preset_unit.setdefault(sys.lower(), unit)
                elif is_gun:
                    unit_guns.setdefault(unit.lower(), [])
                    if sys not in unit_guns[unit.lower()]:
                        unit_guns[unit.lower()].append(sys)

        for fname in _PRESET_FILES:
            p = os.path.join(sp, fname)
            if os.path.isfile(p):
                add(p, True)
            for p in overlay.get(fname, []):
                add(p, True)
        for fname in _GUN_FILES:
            p = os.path.join(sp, fname)
            if os.path.isfile(p):
                add(p, False)
            for p in overlay.get(fname, []):
                add(p, False)

    @staticmethod
    def _tokens(s):
        return [w for w in re.split(r"[^a-z0-9]+", (s or "").lower()) if w]

    # родовые слова номенклатуры орудий: в sysname есть (recoilless_gun),
    # в именах пресетов их нет (steel_recoilless) — при сравнении выкидываем
    _GUN_STOPWORDS = frozenset({"gun", "upgrade"})

    def match_preset_gun(self, guns, preset, unit=""):
        """Gun sysname for an upgrade preset name (Res_guntruck_steel_gl_mk19
        -> res_guntruck_gl_mk19): among the *gun_upgrades of the same unit
        (by unit_sysname) the longest one whose non-unit tokens all appear
        in the preset name. Pure data match — new mod units/guns just work."""
        ug = (guns or {}).get("unit_guns", {})
        pu = (guns or {}).get("preset_unit", {})
        pl = (preset or "").strip().lower()
        if not pl:
            return ""
        u = (pu.get(pl, "") or unit or "").strip().lower()
        if not u:
            return ""
        u_toks = set(self._tokens(u))
        p_toks = set(self._tokens(pl)) - u_toks
        best = ""
        for g in ug.get(u, []):
            g_toks = (set(self._tokens(g)) - u_toks - self._GUN_STOPWORDS)
            if g_toks and g_toks <= p_toks and len(g) > len(best):
                best = g
        return best

    @staticmethod
    def _icon_variants(p):
        """File name variants: exact, then png/dds/tga extension swaps,
        ready-made webp last (bundled app assets are webp; the ready index
        is checked first, this is only the file fallback)."""
        b, e = os.path.splitext(p)
        out = [p]
        for x in (".png", ".dds", ".tga", ".webp"):
            if x != e.lower():
                out.append(b + x)
        return out

    def _dlc_dirs(self, root):
        """DLC overlay folders (sorted); cached by dlc-folder mtime -
        otherwise every one of hundreds of icon resolves listed the dir."""
        dlc = os.path.join(root or "", "dlc")
        try:
            mt = os.path.getmtime(dlc)
        except OSError:
            return []
        ent = self.dlc_cache.get(root)
        if ent and ent[0] == mt:
            return ent[1]
        try:
            dirs = sorted(glob.glob(os.path.join(dlc, "*")))
        except OSError:
            dirs = []
        self.dlc_cache[root] = (mt, dirs)
        return dirs

    def icon_file(self, root, rel, kind, custom_first=True):
        """First existing icon file: готовые webp из CustomImages/<слой>
        (плоско по имени + {stem}.webp в подпапках) -> the map's own
        source root -> unpacked game -> project -> mod (each with its own
        DLC overlays). Встроенных иконок юнитов/предметов в программе
        больше нет (только плейсхолдеры/щиты/карта), их проверка убрана.
        custom_first=False — только исходник из слоёв (для решений
        о переконвертации: stale-webp не должен прятать свежий .dds).
        When the exact name is found nowhere (mod points at
        a missing texture), take a sibling icon of the same family from
        the same folder."""
        rel = (rel or "").replace("\\", "/").strip("/\\")
        if not rel:
            return ""
        base = os.path.basename(rel)
        rp = rel.replace("/", os.sep)
        cands = []
        # новая раскладка — первой: слот корня детерминирован
        # (<area>/<owner>/icons), без обхода дерева
        try:
            _area, _own = self._cache_slot(root, root)
            _ipref = "%s/%s/icons" % (
                self._clean_part(_area) or "other",
                self._clean_part(_own) or "shared")
        except Exception:  # noqa: BLE001
            _ipref = ""
        # готовые webp из CustomImages (новая раскладка + плоский legacy
        # + старые подпапки слоёв)
        if custom_first:
            for _cdir in (self.custom_dir_ext,
                          self.webp_buckets.get("custom", "")):
                if not _cdir:
                    continue
                stem, _ = os.path.splitext(base)
                if _ipref and stem:
                    for _fn in (stem + ".webp", stem + ".nrm.webp"):
                        cands.append(os.path.join(
                            _cdir, *_ipref.split("/"), _fn))
                cands.append(os.path.join(_cdir, base))
                if stem:
                    cands.append(os.path.join(_cdir, stem + ".webp"))
                    try:
                        subs = sorted(os.listdir(_cdir))
                    except OSError:
                        continue
                    for sub in subs:
                        _p = os.path.join(_cdir, sub)
                        try:
                            isdir = os.path.isdir(_p)
                        except OSError:
                            continue
                        if isdir:
                            cands.append(os.path.join(_p, base))
                            cands.append(os.path.join(_p, stem + ".webp"))
        roots = self._layer_roots(root)
        for rt in roots:
            if kind == "item":
                cands.append(os.path.join(rt, "basis", "textures", rp))
            else:
                cands.append(os.path.join(rt, "basis", "textures", "ui",
                                          "pictures", "tech_pic", rp))
            for d in self._dlc_dirs(rt):
                if kind == "item":
                    cands.append(os.path.join(d, "basis", "textures", rp))
                else:
                    cands.append(os.path.join(d, "basis", "textures", "ui",
                                              "pictures", "tech_pic", rp))
        for c in cands:
            for v in self._icon_variants(c):
                try:
                    if os.path.isfile(v):
                        return v
                except OSError:
                    pass
        return ""

    # -- ready-made webp --------------------------------------------------------
    def webp_bucket_dir(self, bucket: str) -> str:
        """External (next to EXE) bucket wins over the bundled one."""
        if bucket == "custom":
            try:
                if self.custom_dir_ext and os.path.isdir(self.custom_dir_ext):
                    return self.custom_dir_ext
            except Exception:  # noqa: BLE001
                pass
            return self.webp_buckets.get(bucket, "")
        ext = os.path.join(self.icon_dir_ext, "UnitIcons", "tech_pic",
                           "vehicles_icons_small" if bucket == "vehicles"
                           else "infantry_icons_small" if bucket == "infantry"
                           else "")
        if bucket == "inventory":
            ext = os.path.join(self.icon_dir_ext, "inventory")
        try:
            if ext and os.path.isdir(ext):
                return ext
        except Exception:  # noqa: BLE001
            pass
        return self.webp_buckets.get(bucket, "")

    def webp_index(self):
        """Ready-made webp icon index: stem.lower() -> (bucket, file).
        Both the bundled dir and the external one (next to the EXE, which
        wins at serve time) are indexed; external files override bundled.
        Custom индексируется рекурсивно (раскладка area/owner/icons…):
        mtime — максимум по всем подпапкам (getmtime самой папки не видит
        записи внутри подпапок); *_preselected/*_selected are fallback
        only, when no base icon exists. Custom: новый префикс бьёт
        плоский legacy, выбор между слоями — по _custom_preference
        в icon_webp. No dds search or conversion."""
        try:
            mt = 0.0
            for bucket in list(self.webp_buckets.keys()):
                dirs = [self.webp_buckets.get(bucket, ""),
                        self.webp_bucket_dir(bucket)]
                if bucket == "custom":
                    for _d in list(dict.fromkeys(dirs)):
                        if not _d:
                            continue
                        try:
                            for _dp, _dn, _fn in os.walk(_d):
                                try:
                                    mt = max(mt, os.path.getmtime(_dp))
                                except OSError:
                                    pass
                        except OSError:
                            pass
                for _d in dict.fromkeys(dirs):
                    if not _d:
                        continue
                    try:
                        mt = max(mt, os.path.getmtime(_d))
                    except OSError:
                        pass
        except OSError:
            mt = 0.0
        if self.webp_idx["map"] and self.webp_idx["mt"] == mt:
            return self.webp_idx["map"]
        idx = {}
        custom = {}
        for _pass in (0, 1):
            for bucket in list(self.webp_buckets.keys()):
                # bundled first, external override (same order as serving)
                for _d in dict.fromkeys((self.webp_buckets.get(bucket, ""),
                                         self.webp_bucket_dir(bucket))):
                    if not _d:
                        continue
                    if bucket == "custom":
                        self._index_custom_tree(_d, idx, custom, _pass)
                        continue
                    try:
                        files = os.listdir(_d)
                    except OSError:
                        continue
                    for fn in files:
                        if not fn.lower().endswith(".webp"):
                            continue
                        stem = fn[:-5].lower()
                        base = stem
                        for suf in ("_preselected", "_selected"):
                            if base.endswith(suf):
                                base = base[: -len(suf)]
                                break
                        if (base != stem) == (_pass == 0):
                            continue  # pass 0: base only; pass 1: variants
                        if _pass == 0:
                            idx[base] = (bucket, fn)  # external wins
                        else:
                            idx.setdefault(base, (bucket, fn))
        self.webp_idx["mt"] = mt
        self.webp_idx["map"] = idx
        self.webp_idx["custom"] = custom
        return idx

    @staticmethod
    def _index_custom_tree(_d, idx, custom, _pass):
        """Всё дерево custom-корзины: relfn — относительный путь
        с прямыми слешами (mods/X/icons/f.webp, BaseGame/f.webp,
        плоский f.webp). Новый формат строгий ({stem}.webp);
        legacy плоский конвертер писал {stem}_{hash8}.webp —
        хеш strip'ается только у плоских. Приоритет в idx:
        external wins; вложенный (с '/') бьёт плоский legacy."""
        try:
            for _dp, _dn, _fns in os.walk(_d):
                try:
                    _rel = os.path.relpath(_dp, _d).replace("\\", "/")
                except Exception:  # noqa: BLE001
                    continue
                _dn.sort()
                for fn in sorted(_fns):
                    if not fn.lower().endswith(".webp"):
                        continue
                    stem = fn[:-5].lower()
                    if _rel in (".", ""):
                        base = stem
                        # legacy плоский конвертер писал {stem}_{hash8}.webp
                        m = re.match(r"^(.*)_[0-9a-f]{8}$", base)
                        if m:
                            base = m.group(1)
                        relfn = fn
                    else:
                        base = stem  # новый формат: строго {stem}.webp
                        relfn = _rel + "/" + fn
                    ent = custom.setdefault(base, [])
                    if relfn not in ent:
                        ent.append(relfn)
                    if (base != stem) == (_pass == 0):
                        continue
                    if _pass == 0:
                        prev = idx.get(base)
                        if (prev is None or prev[0] != "custom"
                                or ("/" in prev[1]) <= ("/" in relfn)):
                            # external wins; вложенный бьёт плоский legacy
                            idx[base] = ("custom", relfn)
                    else:
                        idx.setdefault(base, ("custom", relfn))
        except OSError:
            return

    @staticmethod
    def webp_asset_url(bucket, fn):
        from urllib.parse import quote as _q
        return "/assets/upr-webp/%s/%s" % (bucket, _q(fn))

    @staticmethod
    def _icon_name_candidates(key):
        """Fallback lookup names for one sysname: unit@preset (X@Y from
        *_upgrade_presets: preset first, then base unit)."""
        out = [key]
        if "@" in key:
            left, _, right = key.partition("@")
            if right.strip():
                out.append(right.strip())
            if left.strip():
                out.append(left.strip())
        seen = set()
        return [c for c in out
                if c and not (c.lower() in seen or seen.add(c.lower()))]

    def icon_webp(self, root, name, _idx=None, _amap=None, _guns=None,
                    _pref=None):
        """Ready-made webp icon for a sysname -> (bucket, file) | None.
        Direct name -> @-preset/base and preset->gun fallbacks -> preset->base
        (via the species map) -> icon file name from species. Custom: из всех
        подпапок слоя выбирается та, что выше в _custom_preference (тот же
        порядок, что icon_file). No dds search.
        _idx/_amap/_guns/_pref — готовые снепшоты для батчей (icon_urls и
        icons_data снимают один раз на все имена, иначе каждое имя повторяло
        бы stat-проверки webp_index/icon_map и слоёв _custom_preference:
        сотни лишних сисколов на запрос)."""
        idx = _idx if _idx is not None else self.webp_index()
        key = (name or "").strip()
        if not key:
            return None
        try:
            amap = _amap if _amap is not None else self.icon_map(root)
        except Exception:  # noqa: BLE001
            amap = {}
        cands = self._icon_name_candidates(key)
        if "@" in key:
            left, _, right = key.partition("@")
            try:
                guns = _guns if _guns is not None else self.gun_index(root)
            except Exception:  # noqa: BLE001
                guns = {}
            g = self.match_preset_gun(guns, right.strip(), left.strip())
            if g and g.lower() not in {c.lower() for c in cands}:
                # gun of the upgrade right after the exact name: its tech_pic
                # shows the fitted weapon; preset->base unit icon stays next
                cands.insert(1, g)
        for cand in cands:
            hit = idx.get(cand.lower())
            base = cand.lower()
            if not hit:
                ent = amap.get(cand) or amap.get(cand.lower())
                if ent:
                    rel = (ent[0] or "").replace("\\", "/")
                    stem = os.path.splitext(os.path.basename(rel))[0].lower()
                    hit = idx.get(stem)
                    base = stem
            if hit and hit[0] == "custom":
                pick = self._custom_pick(root, base, _pref)
                if pick:
                    return ("custom", pick)
            elif hit:
                return hit
        return None

    def _custom_pick(self, root, base, _pref=None):
        """Лучший relfn custom-слоя для base: первая подпапка из
        _custom_preference, где файл есть; иначе плоский legacy; иначе ''.
        Зеркалит порядок слоёв icon_file. _pref — готовый снепшот
        (батчи снимают один раз, иначе stat-обход слоёв на каждый хит)."""
        try:
            cands = self.webp_idx.get("custom", {}).get(base, [])
        except Exception:  # noqa: BLE001
            cands = []
        if not cands:
            return ""
        if _pref is not None:
            pref = _pref
        else:
            try:
                pref = self._custom_preference(root)
            except Exception:  # noqa: BLE001
                pref = []
        for nm in pref:
            want = nm + "/"
            for relfn in cands:
                if relfn.startswith(want):
                    return relfn
        for relfn in cands:
            if "/" in relfn:
                return relfn
        return cands[0]

    def placeholder_png(self):
        """Missing-icon stub: grey square with a '?'.
        Generated once and cached on disk."""
        try:
            if os.path.isfile(self.placeholder):
                return self.placeholder
            os.makedirs(self.png_cache, exist_ok=True)
            from PIL import Image, ImageDraw, ImageFont
            im = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
            dr = ImageDraw.Draw(im)
            dr.rounded_rectangle([1, 1, 62, 62], radius=10,
                                 fill=(52, 56, 62, 150),
                                 outline=(150, 156, 164, 200), width=2)
            try:
                fnt = ImageFont.load_default(size=34)
            except TypeError:  # old Pillow without size
                fnt = ImageFont.load_default()
            dr.text((32, 33), "?", font=fnt, fill=(200, 205, 212, 230),
                    anchor="mm")
            im.save(self.placeholder, "PNG")
            return self.placeholder
        except Exception as e:  # noqa: BLE001
            self._log.warning("uprising placeholder failed: %s", e)
            return ""

    # category stubs for map chips (served as-is, no conversion).
    # Плоский assets/UprisingMap (ext рядом с EXE выигрывает); legacy-пары
    # (подпапки UnitIcons/.../inventory) — запасной вариант ниже.
    _UPR_PLACEHOLDERS = {
        "cars": "placeholder_vehicle.webp",
        "tanks": "placeholder_vehicle.webp",
        "helicopters": "placeholder_vehicle.webp",
        "squads": "placeholder_Squads_items.webp",
        "inventory_items": "placeholder_Squads_items.webp",
    }
    _UPR_PLACEHOLDERS_LEGACY = {
        "cars": ("vehicles", "placeholder_vehicle.webp"),
        "tanks": ("vehicles", "placeholder_vehicle.webp"),
        "helicopters": ("vehicles", "placeholder_vehicle.webp"),
        "squads": ("infantry", "placeholder.webp"),
        "inventory_items": ("inventory", "upgrd_placeholder.webp"),
    }

    def _flat_upr_dirs(self):
        """Плоский assets/UprisingMap: сначала внешний (рядом с EXE)."""
        try:
            ext = (self.icon_dir_ext
                   if self.icon_dir_ext and os.path.isdir(self.icon_dir_ext)
                   else "")
        except Exception:  # noqa: BLE001
            ext = ""
        return [d for d in dict.fromkeys((ext, self.icon_dir)) if d]

    def category_placeholder(self, cat, name=""):
        """Ready-made webp stub for a map category (as the frontend sends
        it), or ''. External assets next to the EXE win over bundled.
        Items with the wpn_ prefix get their own wpn_placeholder.webp."""
        if (name or "").strip().lower().startswith("wpn_"):
            for _d in self._flat_upr_dirs():
                p = os.path.join(_d, "wpn_placeholder.webp")
                try:
                    if os.path.isfile(p):
                        return p
                except OSError:
                    pass
            for _d in dict.fromkeys((self.webp_bucket_dir("inventory"),
                                     self.webp_buckets.get("inventory", ""))):
                if not _d:
                    continue
                p = os.path.join(_d, "wpn_placeholder.webp")
                try:
                    if os.path.isfile(p):
                        return p
                except OSError:
                    pass
        fn = self._UPR_PLACEHOLDERS.get((cat or "").strip().lower())
        if not fn:
            return ""
        for _d in self._flat_upr_dirs():
            p = os.path.join(_d, fn)
            try:
                if os.path.isfile(p):
                    return p
            except OSError:
                pass
        ent = self._UPR_PLACEHOLDERS_LEGACY.get((cat or "").strip().lower())
        if not ent:
            return ""
        bucket, legacy = ent
        for _d in dict.fromkeys((self.webp_bucket_dir(bucket),
                                 self.webp_buckets.get(bucket, ""))):
            if not _d:
                continue
            p = os.path.join(_d, legacy)
            try:
                if os.path.isfile(p):
                    return p
            except OSError:
                pass
        return ""

    def unpacked_root(self):
        try:
            return self._store.normal(self._config.get("unpacked_path") or "") or ""
        except Exception:  # noqa: BLE001
            return ""

    def dds_png(self, src):
        """DDS -> PNG with a disk cache in temp. None on failure."""
        try:
            mt = os.path.getmtime(src)
            mem_key = (src.lower(), mt)
            hit = self.conv_mem.get(mem_key)
            if hit and os.path.isfile(hit):
                return hit
            key = hashlib.sha1(src.lower().encode("utf-8")).hexdigest()[:16]
            out = os.path.join(self.png_cache, key + "_" + str(int(mt)) + ".png")
            if os.path.isfile(out):
                self.conv_mem[mem_key] = out
                return out
            os.makedirs(self.png_cache, exist_ok=True)
            from PIL import Image
            im = Image.open(src)
            im.load()
            if im.mode not in ("RGBA", "RGB"):
                im = im.convert("RGBA")
            im.save(out, "PNG")
            self.conv_mem[mem_key] = out
            if len(self.conv_mem) > 4096:
                self.conv_mem.clear()
            return out
        except Exception as e:  # noqa: BLE001
            self._log.warning("uprising icon convert failed %s: %s", src, e)
            return None

    def _custom_subdir_for(self, src, root):
        """LEGACY (только чтение старого кэша): подпапка CustomImages
        до раскладки projects|game|mods (BaseGame/имя корня/плоско).
        Новые записи — через _cache_subdir; старые файлы отдаются
        как есть (без реконвертации), пока лежат свежими."""
        try:
            ap = os.path.normcase(os.path.abspath(src or ""))
        except Exception:  # noqa: BLE001
            return ""
        if not ap:
            return ""
        try:
            game = os.path.normcase(os.path.abspath(self.unpacked_root()
                                                    or ""))
        except Exception:  # noqa: BLE001
            game = ""
        try:
            proj = os.path.normcase(os.path.abspath(
                (self._entities.project.root
                 if self._entities.project is not None else "") or ""))
        except Exception:  # noqa: BLE001
            proj = ""
        try:
            mod = os.path.normcase(os.path.abspath(
                self._store.normal(self._config.get("mod_path") or "") or ""))
        except Exception:  # noqa: BLE001
            mod = ""
        try:
            ovs = []
            for _k in ("mod_assets_path", "mod_overlay_path",
                       "mod_models_path"):
                try:
                    _v = self._store.normal(
                        self._config.get(_k) or "") or ""
                except Exception:  # noqa: BLE001
                    _v = ""
                if _v:
                    ovs.append(os.path.normcase(os.path.abspath(_v)))
        except Exception:  # noqa: BLE001
            ovs = []
        try:
            own = os.path.normcase(os.path.abspath(root or ""))
        except Exception:  # noqa: BLE001
            own = ""

        def inside(base):
            return bool(base) and (ap == base
                                   or ap.startswith(base + os.sep))

        if mod and inside(mod):
            return os.path.basename(os.path.normpath(mod)) or ""
        for _ov in ovs:
            if _ov and inside(_ov):
                return os.path.basename(os.path.normpath(_ov)) or ""
        if proj and inside(proj):
            return os.path.basename(os.path.normpath(proj)) or ""
        if game and inside(game):
            return "BaseGame"
        if own and inside(own):
            return os.path.basename(os.path.normpath(own)) or ""
        return ""

    @staticmethod
    def _clean_part(value):
        """Безопасный кусок пути кэша: без сепараторов, точек и пустот."""
        v = str(value or "").replace("\\", "/").strip().strip(".")
        v = v.split("/")[-1].strip()
        if v in ("", ".", ".."):
            return ""
        return v[:64]

    def _mod_overlay_roots(self):
        """Саб-пути мода из конфига (тот же мод, не отдельные корни)."""
        out = []
        try:
            for _k in ("mod_assets_path", "mod_overlay_path",
                       "mod_models_path"):
                try:
                    _v = self._store.normal(
                        self._config.get(_k) or "") or ""
                except Exception:  # noqa: BLE001
                    _v = ""
                if _v:
                    out.append(os.path.normcase(os.path.abspath(_v)))
        except Exception:  # noqa: BLE001
            pass
        return out

    def _cache_slot(self, src, root):
        """Слот кэша (area, owner) для исходного .dds.

        Раскладка CustomImages/<area>/<owner>/: projects (корень
        проекта), game (распакованная игра), mods (корень мода —
        саб-пути ассеты/модели кладутся в папку ОСНОВНОГО мода,
        это один мод, а не три), other (всё остальное). Owner —
        имя папки корня в исходном регистре (должен совпадать
        с префиксами _custom_preference, иначе startswith промахнётся).
        Возвращает ('other', '') при неудаче."""
        try:
            ap = os.path.abspath(src or "")
        except Exception:  # noqa: BLE001
            return ("other", "")
        if not ap:
            return ("other", "")
        ncap = os.path.normcase(ap)

        def _abs(v):
            try:
                return os.path.normcase(os.path.abspath(v or ""))
            except Exception:  # noqa: BLE001
                return ""

        try:
            mod = _abs(self._store.normal(
                self._config.get("mod_path") or "") or "")
        except Exception:  # noqa: BLE001
            mod = ""
        ovs = self._mod_overlay_roots()
        try:
            game = _abs(self.unpacked_root() or "")
        except Exception:  # noqa: BLE001
            game = ""
        try:
            proj = _abs((self._entities.project.root
                         if self._entities.project is not None else "")
                        or "")
        except Exception:  # noqa: BLE001
            proj = ""

        def inside(base):
            return bool(base) and (ncap == base
                                   or ncap.startswith(base + os.sep))

        def owner(real_base, fallback=""):
            try:
                nm = os.path.basename(os.path.normpath(real_base)) or ""
            except Exception:  # noqa: BLE001
                nm = ""
            return self._clean_part(nm) or fallback
        # сравнения — normcase, имена — исходный регистр: нужны оба
        try:
            mod_real = os.path.abspath(self._store.normal(
                self._config.get("mod_path") or "") or "")
        except Exception:  # noqa: BLE001
            mod_real = ""
        try:
            game_real = os.path.abspath(self.unpacked_root() or "")
        except Exception:  # noqa: BLE001
            game_real = ""
        try:
            proj_real = os.path.abspath(
                (self._entities.project.root
                 if self._entities.project is not None else "") or "")
        except Exception:  # noqa: BLE001
            proj_real = ""
        try:
            own_real = os.path.abspath(root or "")
        except Exception:  # noqa: BLE001
            own_real = ""
        if mod and (inside(mod) or any(inside(o) for o in ovs)):
            return ("mods", owner(mod_real, "mod"))
        if game and inside(game):
            return ("game", owner(game_real, "BaseGame"))
        if proj and inside(proj):
            return ("projects", owner(proj_real, "project"))
        own = os.path.normcase(own_real)
        if own and inside(own):
            return ("other", owner(own_real, "root"))
        return ("other", "")

    def _cache_subdir(self, src, root, kind="texture", model=""):
        """Подпапка CustomImages для записи/чтения:
        <area>/<owner>/icons (иконки — все в одну папку) или
        <area>/<owner>/textures/<модель> (текстуры — по папкам моделей,
        чьих; без модели — textures/shared). Только прямые слеши."""
        try:
            area, own = self._cache_slot(src, root)
        except Exception:  # noqa: BLE001
            area, own = ("other", "")
        area = self._clean_part(area) or "other"
        own = self._clean_part(own) or "shared"
        if (kind or "") == "icon":
            return "%s/%s/icons" % (area, own)
        m = self._clean_part(model) or "shared"
        return "%s/%s/textures/%s" % (area, own, m)

    def _custom_preference(self, root):
        """Префиксы CustomImages в порядке слоёв _layer_roots: сначала
        новая раскладка (<area>/<owner>/icons — иконки все в одну папку),
        затем старые имена подпапок (BaseGame/имя корня — для legacy-файлов).
        _custom_pick матчит relfn через startswith(префикс + '/'), так что
        порядок здесь = порядок победы слоёв. Без дублей и пустот."""
        try:
            layers = self._layer_roots(root)
        except Exception:  # noqa: BLE001
            layers = []
        try:
            game = os.path.normpath(self.unpacked_root() or "")
        except Exception:  # noqa: BLE001
            game = ""
        try:
            proj = os.path.normpath(
                (self._entities.project.root
                 if self._entities.project is not None else "") or "")
        except Exception:  # noqa: BLE001
            proj = ""
        try:
            mod = os.path.normpath(
                self._store.normal(self._config.get("mod_path") or "") or "")
        except Exception:  # noqa: BLE001
            mod = ""

        def slot(layer):
            key = os.path.normcase(layer)
            if mod and key == os.path.normcase(mod):
                quan = self._clean_part(os.path.basename(mod)) or "mod"
                return ("mods/" + quan + "/icons", quan)
            if game and key == os.path.normcase(game):
                quan = self._clean_part(os.path.basename(game)) or "BaseGame"
                return ("game/" + quan + "/icons", "BaseGame")
            if proj and key == os.path.normcase(proj):
                quan = self._clean_part(os.path.basename(proj)) or "project"
                return ("projects/" + quan + "/icons", quan)
            quan = self._clean_part(os.path.basename(layer)) or ""
            if quan:
                return ("other/" + quan + "/icons", quan)
            return ("", "")
        names = []
        for layer in layers:
            new_pref, old_nm = slot(layer)
            for nm in (new_pref, old_nm):
                if nm and nm not in names:
                    names.append(nm)
        return names

    def _custom_target(self, subdir=""):
        """Папка CustomImages для записи: внешняя рядом с EXE (релиз),
        иначе встроенная. С подпапкой слоя (BaseGame/проект/мод).
        Создаётся при необходимости."""
        for d in (self.custom_dir_ext,
                  self.webp_buckets.get("custom", "")):
            if not d:
                continue
            try:
                target = os.path.join(d, subdir) if subdir else d
                os.makedirs(target, exist_ok=True)
            except OSError:
                continue
            if os.path.isdir(target):
                return target
        return ""

    @staticmethod
    def _legacy_flat_re(stem):
        return re.compile(r"^%s_[0-9a-f]{8}\.webp$" %
                          re.escape(stem), re.IGNORECASE)

    def _drop_legacy_flat(self, stem):
        """Удалить старые плоские {stem}_{hash8}.webp после переезда
        иконки в подпапку слоя: stale-дубликат больше не зашедоуит."""
        if not stem:
            return
        rx = self._legacy_flat_re(stem)
        for d in (self.custom_dir_ext,
                  self.webp_buckets.get("custom", "")):
            if not d:
                continue
            try:
                names = os.listdir(d)
            except OSError:
                continue
            for fn in names:
                if rx.match(fn):
                    try:
                        os.remove(os.path.join(d, fn))
                    except OSError:
                        pass

    def dds_webp(self, src, subdir=None, root=None, normal_fix=False,
                 normal_auto=False, kind="texture", model="", quality=None):
        """DDS -> WebP в assets/CustomImages/<area>/<owner>/ (качество 85).

        Раскладка: projects|game|mods/<имя>/icons (иконки — все в одну)
        или .../textures/<модель> (текстуры — по папкам моделей-владельцев;
        без модели — textures/shared). Мод и его саб-пути — один owner
        по имени ОСНОВНОГО мода. kind: 'icon' | 'texture' (иначе texture).
        Имя строго {stem}.webp (marder.dds -> marder.webp); при normal_fix
        (BC5 точно) или normal_auto (имя похоже на нормаль — проверка
        внутри конвертации на декодированном кадре) — {stem}.nrm.webp.
        Старый кэш (плоско + подпапки BaseGame/имя корня) сначала
        читается как есть — без массовой реконвертации; новые записи
        только в новую раскладку. Свежий (не старше исходника) файл
        не переконвертируется. Путь к готовому файлу или ''.
        subdir — явная подпапка (совместимость): задана — пишется туда.
        quality — WebP-качество (None = 85): у текстур моделей — по слоту
        (albedo 80 / normal 75 / rough 75, замер), у иконок — всегда 85.
        Качество в имени файла не сидит: готовый свежий файл не
        переконвертируется, смешанный кэш сходится сам (новые и
        изменившиеся — уже ужатые)."""
        try:
            if not src or not os.path.isfile(src):
                return ""
            if subdir is None:
                try:
                    subdir = self._cache_subdir(src, root, kind, model)
                except Exception:  # noqa: BLE001
                    subdir = ""
            stem = os.path.splitext(os.path.basename(src))[0]
            if not stem:
                return ""
            nrm = bool(normal_fix or normal_auto)
            fn = stem + (".nrm.webp" if nrm else ".webp")
            mt = os.path.getmtime(src)
            dirs = [d for d in (self.custom_dir_ext,
                                self.webp_buckets.get("custom", "")) if d]
            # новая раскладка — первой (туда же пишем)
            for d in dirs:
                dst = os.path.join(d, *subdir.split("/"), fn) \
                    if subdir else os.path.join(d, fn)
                if os.path.isfile(dst):
                    try:
                        if os.path.getmtime(dst) >= mt:
                            return dst
                    except OSError:
                        pass
            # legacy: плоский корень + старая подпапка слоя
            try:
                legacy_sub = self._custom_subdir_for(src, root) or ""
            except Exception:  # noqa: BLE001
                legacy_sub = ""
            for d in dirs:
                cand = os.path.join(d, fn)
                if os.path.isfile(cand):
                    try:
                        if os.path.getmtime(cand) >= mt:
                            return cand
                    except OSError:
                        pass
                if legacy_sub:
                    cand = os.path.join(d, legacy_sub, fn)
                    if os.path.isfile(cand):
                        try:
                            if os.path.getmtime(cand) >= mt:
                                return cand
                        except OSError:
                            pass
            # shared: общая папка текстур того же owner (игровые текстуры,
            # гретые без модели) — serving без дублирования под каждую
            # модель; новые записи всё равно идут в папку модели
            if subdir and (kind or "") != "icon":
                try:
                    parts = subdir.split("/")
                    if len(parts) == 4 and parts[2] == "textures" and \
                            parts[3] != "shared":
                        for d in dirs:
                            shared = os.path.join(
                                d, parts[0], parts[1], "textures",
                                "shared", fn)
                            if os.path.isfile(shared):
                                try:
                                    if os.path.getmtime(shared) >= mt:
                                        return shared
                                except OSError:
                                    pass
                except Exception:  # noqa: BLE001
                    pass
            dst_dir = self._custom_target(subdir or "")
            if not dst_dir:
                return ""
            from . import dds_converter as _dc
            try:
                q = int(quality) if quality is not None else _dc.QUALITY
            except (TypeError, ValueError):
                q = _dc.QUALITY
            if _dc.convert_file(src, os.path.join(dst_dir, fn),
                                quality=q,
                                normal_fix=bool(normal_fix),
                                normal_auto=bool(normal_auto)):
                self._drop_legacy_flat(stem)
                # индекс webp перестроится по mtime папки сам
                return os.path.join(dst_dir, fn)
            return ""
        except Exception as e:  # noqa: BLE001
            self._log.warning("uprising dds->webp failed %s: %s", src, e)
            return ""

    def icon_source_file(self, root, name):
        """Source icon file for a sysname through the same fallback chain
        as icon_webp (exact, preset->gun, @-preset/base, preset->base unit):
        (path, kind) | None. Bulk conversion and preload go through it, so
        mod guns and unit@preset entries convert like plain species names."""
        key = (name or "").strip()
        if not key:
            return None
        try:
            amap = self.icon_map(root)
        except Exception:  # noqa: BLE001
            amap = {}
        cands = self._icon_name_candidates(key)
        if "@" in key:
            left, _, right = key.partition("@")
            try:
                guns = self.gun_index(root)
            except Exception:  # noqa: BLE001
                guns = {}
            g = self.match_preset_gun(guns, right.strip(), left.strip())
            if g and g.lower() not in {c.lower() for c in cands}:
                cands.insert(1, g)
        for cand in cands:
            ent = amap.get(cand) or amap.get(cand.lower())
            if not ent:
                continue
            try:
                p = self.icon_file(root, ent[0], ent[1],
                                   custom_first=False)
            except Exception:  # noqa: BLE001
                continue
            if p:
                return (p, ent[1])
        return None

    # суффиксы файлов-состояний иконок: ховер/выбранное лежат сиблингами
    # исходника в слоях проект|игра|мод/GameAssets. Техника и пехота
    # (tech_pic): <stem>_preselected/_selected; предметы (inventory):
    # <stem>_o/_s. Конверт — тем же dds->webp в CustomImages/<слой>/.
    _ICON_STATE_SUFFIXES = {
        "item": (("_o", "hover"), ("_s", "selected")),
        "unit": (("_preselected", "hover"), ("_selected", "selected")),
    }

    def icon_state_sources(self, root, name):
        """Файлы-состояния иконки {hover, selected}: мемо поверх скана.

        Горячий путь повторных открытий: скан — десятки stat на имя,
        мемо отдаёт готовые пути (валидность по mt species-карты —
        пути исходников от webp-кэша не зависят)."""
        key = (name or "").strip()
        if not key:
            return {}
        mkey = None
        try:
            layers = self._layer_roots(root)
            lkey = "|".join(layers)
            mt = (self.icon_cache.get(lkey) or {}).get("mt")
            if mt is None:
                try:
                    self.icon_map(root)
                except Exception:  # noqa: BLE001
                    pass
                mt = (self.icon_cache.get(lkey) or {}).get("mt")
            mkey = (lkey, mt, key.lower())
            hit = self._state_src_memo.get(mkey)
            if hit is not None:
                return dict(hit)
        except Exception:  # noqa: BLE001
            mkey = None
        out = self._icon_state_sources_scan(root, key)
        if mkey is not None:
            try:
                if len(self._state_src_memo) > 20000:
                    self._state_src_memo.clear()
                self._state_src_memo[mkey] = dict(out)
            except Exception:  # noqa: BLE001
                pass
        return out

    def _icon_state_sources_scan(self, root, name):
        """Файлы-состояния иконки {hover, selected}: сиблинги исходника
        со сменой стема (тот же фолбэк-цепочка слоёв, что icon_source_file).
        Ключи species-карты регистрозависимы (Fnd_abrams), запрос может
        прийти любым регистром — сводим через пониженный индекс.
        Нет сиблинга — состояния нет (пусто)."""
        key = (name or "").strip()
        if not key:
            return {}
        hit = None
        try:
            hit = self.icon_source_file(root, key)
        except Exception:  # noqa: BLE001
            hit = None
        if not hit or not hit[0]:
            # регистр ключа не совпал (Fnd_abrams vs fnd_abrams):
            # тот же поиск, но по пониженному индексу карты (один на
            # поколение кэша, не скан на каждое имя)
            try:
                layers = self._layer_roots(root)
                lkey = "|".join(layers)
                amap = self.icon_map(root)
                mt = (self.icon_cache.get(lkey) or {}).get("mt")
                cached = self.icon_low_cache.get(lkey)
                if cached is None or cached[0] != mt:
                    low = {}
                    for k, v in amap.items():
                        low.setdefault(k.lower(), v)
                    self.icon_low_cache[lkey] = (mt, low)
                else:
                    low = cached[1]
            except Exception:  # noqa: BLE001
                return {}
            ent = low.get(key.lower())
            if not ent:
                # имени нет в species (апгрейды upgrd_* идут только
                # через готовый webp-индекс): прямой поиск dds-исходника
                # в стандартных папках слоёв + DLC-оверлеев
                hit = self._icon_direct_source(root, key)
                if not hit:
                    return {}
            else:
                try:
                    p = self.icon_file(root, ent[0], ent[1],
                                       custom_first=False)
                except Exception:  # noqa: BLE001
                    return {}
                if not p:
                    return {}
                hit = (p, ent[1])
        src, kind = hit
        suffs = self._ICON_STATE_SUFFIXES.get(
            "item" if kind == "item" else "unit")
        out = {}
        d = os.path.dirname(src)
        stem, _ = os.path.splitext(os.path.basename(src))
        if not stem:
            return {}
        for suf, role in suffs:
            for v in self._icon_variants(os.path.join(d, stem + suf)):
                try:
                    if os.path.isfile(v):
                        out[role] = v
                        break
                except OSError:
                    pass
        return out

    # стандартные папки прямого поиска dds-исходника (слой/оверлей + sub):
    # предметы — inventory, юниты — tech_pic (мелкие/средние иконки) и
    # раскладка GameAssets (UnitIcons/..., inventory)
    _ICON_DIRECT_SUBS = (
        ("basis/textures/ui/pictures/inventory", "item"),
        ("basis/textures/ui/pictures/tech_pic/infantry_icons_small", "unit"),
        ("basis/textures/ui/pictures/tech_pic/vehicles_icons_small", "unit"),
        ("basis/textures/ui/pictures/tech_pic/infantry_icons_big", "unit"),
        ("basis/textures/ui/pictures/tech_pic/vehicles_icons_big", "unit"),
        ("UnitIcons/tech_pic/infantry_icons_small", "unit"),
        ("UnitIcons/tech_pic/vehicles_icons_small", "unit"),
        ("inventory", "item"),
    )

    def _icon_direct_source(self, root, key):
        """Прямой поиск dds-исходника по имени без species-карты:
        (path, kind) | None. Только точные имена файлов (через
        _icon_variants — png/dds/tga/webp), без рекурсии: десятки stat
        на имя, не walk."""
        try:
            layers = self._layer_roots(root)
        except Exception:  # noqa: BLE001
            return None
        dirs = list(layers)
        try:
            for rt in layers:
                dirs.extend(self._dlc_dirs(rt))
        except Exception:  # noqa: BLE001
            pass
        for d in dirs:
            if not d:
                continue
            for sub, kind in self._ICON_DIRECT_SUBS:
                base = os.path.join(d, sub, key)
                for v in self._icon_variants(base):
                    try:
                        if os.path.isfile(v):
                            return (os.path.normpath(v), kind)
                    except OSError:
                        pass
        return None

    def icon_states(self, root, names):
        """{name: {hover: url, selected: url}} состояний иконок одним
        запросом. Сиблинги конвертируются тем же dds->webp в CustomImages,
        URL — готовых webp (дальше кэш браузера); нет сиблинга — ключа нет.
        Защита от фолбэка индекса на базовую иконку — сравнением стема."""
        names = sorted({str(n).strip() for n in (names or [])
                        if str(n).strip()})[:800]
        want = {}
        # поиск исходников — пулом (icon_source_file на имя: десятки stat
        # по слоям/DLC; последовательно 400+ имён давали секунды,
        # I/Ostat'ы GIL не держат). Кэши внутри потокобезопасны
        # (icon_map — под icon_lock + дисковый, остальные — чтение).
        def _src(n):
            try:
                srcs = self.icon_state_sources(root, n)
            except Exception:  # noqa: BLE001
                return (n, None)
            return (n, srcs or None)

        if len(names) > 8:
            try:
                with ThreadPoolExecutor(max_workers=8) as ex:
                    for n, srcs in ex.map(_src, names):
                        if srcs:
                            want[n] = srcs
            except Exception:  # noqa: BLE001
                for n in names:
                    _, srcs = _src(n)
                    if srcs:
                        want[n] = srcs
        else:
            for n in names:
                _, srcs = _src(n)
                if srcs:
                    want[n] = srcs
        # конверт вариантов — пулом (последовательно сотни dds давали
        # 10+с на запрос состояний и тормозили первый ховер)
        jobs = []
        for srcs in want.values():
            for p in srcs.values():
                if p.lower().endswith(".dds"):
                    jobs.append(p)
        if jobs:
            def _one(p):
                try:
                    self.dds_webp(p, root=root, kind="icon")
                except Exception:  # noqa: BLE001
                    pass
            try:
                with ThreadPoolExecutor(max_workers=8) as ex:
                    list(ex.map(_one, dict.fromkeys(jobs)))
            except Exception:  # noqa: BLE001
                for p in dict.fromkeys(jobs):
                    _one(p)
        try:
            idx = self.webp_index()
        except Exception:  # noqa: BLE001
            idx = {}
        try:
            _pref = self._custom_preference(root)
        except Exception:  # noqa: BLE001
            _pref = []
        out = {}
        for n, srcs in want.items():
            st = {}
            for role, p in srcs.items():
                stem = os.path.splitext(os.path.basename(p))[0].lower()
                hit = (idx or {}).get(stem)
                if not hit:
                    continue
                fn = hit[1].replace("\\", "/").split("/")[-1]
                if os.path.splitext(fn)[0].lower() != stem:
                    continue
                if hit[0] == "custom":
                    try:
                        pick = self._custom_pick(root, stem, _pref)
                    except Exception:  # noqa: BLE001
                        pick = ""
                    if not pick:
                        continue
                    st[role] = self.webp_asset_url("custom", pick)
                else:
                    st[role] = self.webp_asset_url(*hit)
            out[n] = st
        return {"ok": True, "states": out}

    def convert_missing(self, root, names):
        """Bulk DDS -> CustomImages/<слой>/ WebP одним запросом
        (кнопка «Анализ»). Имя строго {stem}.webp, существующий
        перезаписывается; свежий пропускается. Отдельный пул: процессы
        в исходниках, потоки в frozen exe (spawn из сборки небезопасен).
        Возвращает счётчики."""
        from concurrent.futures import ThreadPoolExecutor
        names = [str(n) for n in (names or []) if str(n).strip()][:600]
        out = {"ok": True, "converted": 0, "ready": 0,
               "missing": 0, "failed": 0}
        if not names:
            return out
        tasks = []
        for n in names:
            hit = self.icon_source_file(root, n)
            if not hit:
                # sysname нет в species, но прямой webp мог уже лежать
                if self.icon_webp(root, n):
                    out["ready"] += 1
                else:
                    out["missing"] += 1
                continue
            p = hit[0]
            if not p:
                out["missing"] += 1
                continue
            if not p.lower().endswith(".dds"):
                out["ready"] += 1
                continue
            stem = os.path.splitext(os.path.basename(p))[0]
            if not stem:
                out["missing"] += 1
                continue
            subdir = self._custom_subdir_for(p, root) or ""
            fn = stem + ".webp"
            tasks.append((n, p, subdir, fn))
            # состояния иконки (ховер/выбранное) — тем же конвертом, счёт
            # общий: Анализ греет и их, иначе первый ховер ждал бы dds
            try:
                for _pp in self.icon_state_sources(root, n).values():
                    if not _pp.lower().endswith(".dds"):
                        continue
                    _stem = os.path.splitext(os.path.basename(_pp))[0]
                    if not _stem:
                        continue
                    tasks.append((n, _pp,
                                  self._custom_subdir_for(_pp, root) or "",
                                  _stem + ".webp"))
            except Exception:  # noqa: BLE001
                pass
        if not tasks:
            try:
                self.webp_index()
            except Exception:  # noqa: BLE001
                pass
            return out
        targets = {}
        jobs = []
        for _n, src, subdir, fn in tasks:
            if subdir not in targets:
                targets[subdir] = self._custom_target(subdir)
            dst_dir = targets[subdir]
            if not dst_dir:
                out["failed"] += 1
                continue
            dst = os.path.join(dst_dir, fn)
            try:
                fresh = (os.path.isfile(dst) and os.path.getmtime(dst)
                         >= os.path.getmtime(src))
            except OSError:
                fresh = False
            if fresh:
                out["ready"] += 1
            else:
                jobs.append((src, dst, 85))
        if jobs:
            ex = None
            try:
                if not getattr(sys, "frozen", False):
                    from concurrent.futures import ProcessPoolExecutor
                    import multiprocessing as _mp
                    ex = ProcessPoolExecutor(
                        max_workers=max(1, min(4, (_mp.cpu_count() or 2))))
                else:
                    ex = ThreadPoolExecutor(max_workers=8)
                from . import dds_converter as _dc
                for _dst, ok in ex.map(_dc.convert_task, jobs):
                    if ok:
                        out["converted"] += 1
                    else:
                        out["failed"] += 1
            except Exception as e:  # noqa: BLE001 - процессы не взлетели
                self._log.warning("upr convert pool failed (%s), threads", e)
                try:
                    from . import dds_converter as _dc2
                    with ThreadPoolExecutor(max_workers=8) as tex:
                        for _dst, ok in tex.map(_dc2.convert_task, jobs):
                            if ok:
                                out["converted"] += 1
                            else:
                                out["failed"] += 1
                except Exception:  # noqa: BLE001
                    out["failed"] += len(jobs) - out["converted"]
            finally:
                try:
                    if ex is not None:
                        ex.shutdown(wait=True)
                except Exception:  # noqa: BLE001
                    pass
        try:
            for _src, dst, _q in jobs:
                stem = os.path.splitext(os.path.basename(dst))[0]
                if stem:
                    self._drop_legacy_flat(stem)
            self.webp_index()
        except Exception:  # noqa: BLE001
            pass
        return out

    def data_url(self, bucket, fn):
        """Ready-made webp as an in-memory data-URL (mtime-keyed cache).
        fn custom может включать подпапку слоя (Sub/stem.webp)."""
        idx_mt = self.webp_idx["mt"]  # current after webp_index()
        ent = self.data_mem
        if ent["mt"] != idx_mt:
            ent["mt"] = idx_mt
            ent["map"] = {}
        key = bucket + "/" + fn
        hit = ent["map"].get(key)
        if hit is None:
            # the hit may come from the external dir (next to the EXE);
            # bundled is the fallback, not the only source
            path = os.path.join(self.webp_bucket_dir(bucket),
                                *fn.split("/"))
            try:
                if not os.path.isfile(path):
                    path = os.path.join(self.webp_buckets[bucket],
                                        *fn.split("/"))
                with open(path, "rb") as f:
                    raw = f.read()
            except OSError:
                return ""
            hit = ("data:image/webp;base64,"
                   + base64.b64encode(raw).decode("ascii"))
            ent["map"][key] = hit
            if len(ent["map"]) > 4096:
                ent["map"].clear()
        return hit

    def shields_data(self):
        """All map shield badges in one response: {key: data-URL}.

        One response instead of dozens of HTTP/1.0 <img> without keep-alive
        (?v=Date.now bypassing the cache): on a cold HDD some shields never
        finished loading. key = file name without .webp."""
        roots = []
        for r in (self._config.dir, os.path.dirname(self._config.dir), os.getcwd()):
            if r:
                roots.append(os.path.join(r, "assets", "UprisingMap", "shields"))
        roots.append(os.path.join(self._base, "assets", "UprisingMap", "shields"))
        seen, mts = {}, []
        for root in roots:
            try:
                mts.append(os.path.getmtime(root))
            except OSError:
                continue
            try:
                names = sorted(os.listdir(root))
            except OSError:
                continue
            for fn in names:
                if not fn.lower().endswith(".webp"):
                    continue
                key = fn[:-5]
                if key not in seen:
                    seen[key] = os.path.join(root, fn)
        mt = max(mts) if mts else 0.0
        ent = self.shields_mem
        if ent["mt"] != mt:
            ent["mt"] = mt
            ent["map"] = {}
        out = {}
        for key, path in seen.items():
            hit = ent["map"].get(key)
            if hit is None:
                try:
                    with open(path, "rb") as f:
                        raw = f.read()
                except OSError:
                    continue
                hit = ("data:image/webp;base64,"
                       + base64.b64encode(raw).decode("ascii"))
                ent["map"][key] = hit
            out[key] = hit
        return {"ok": True, "shields": out}

    def warmup(self):
        """Icon warmup at launcher stage (background): webp index +
        species maps of the game and the mod + map.webp bytes into the OS
        cache, so the first map open pays no cold start."""
        try:
            t0 = time.time()
            self.webp_index()
            # карту уже открывали (кэши набиты по требованию) — тяжёлый
            # icon_map пропускаем: прогрев опоздал и будет только душить
            # GIL ровно когда пользователь работает с картой
            if self.icon_cache or self.sysn_cache:
                self._log.info("upr warmup skipped (caches already warm)")
                return
            # сплэш/boot_progress отвечают тем же GIL: паузы между тяжёлыми
            # кусками, иначе /splash и статика висят десятки секунд (18%).
            time.sleep(0.3)
            for cand in (self.unpacked_root(),
                         self._store.normal(self._config.get("mod_path") or "") or ""):
                try:
                    if cand and os.path.isdir(cand):
                        self.icon_map(cand)
                except Exception:  # noqa: BLE001
                    pass
                time.sleep(0.3)
            try:
                for cand in (os.path.join(self.icon_dir_ext, "global_map.webp"),
                             os.path.join(self._base, "assets",
                                           "UprisingMap",
                                          "global_map.webp")):
                    try:
                        with open(cand, "rb") as f:
                            f.read()
                        break
                    except OSError:
                        pass
            except OSError:
                pass
            self._log.info("upr warmup done in %.2fs", time.time() - t0)
        except Exception as e:  # noqa: BLE001
            self._log.warning("upr warmup failed: %s", e)

    def start_warmup(self, delay: float = 40.0):
        """Фоновый прогрев после старта. Задержка 40с: сплэш,
        boot_progress, display_names и первое открытие карты проходят
        первыми — иначе холодный старт душит GIL и сплэш висит на 18%
        (см. app.log: /splash 124с). Карту уже открыли — warmup скипается
        сам (см. warmup: кэши уже набиты по требованию)."""
        def _delayed():
            try:
                if delay and delay > 0:
                    time.sleep(delay)
            except Exception:  # noqa: BLE001
                pass
            try:
                self.warmup()
            except Exception:  # noqa: BLE001
                pass
        threading.Thread(target=_delayed, daemon=True,
                         name="upr-warm").start()

    # -- icon operations (response payloads) ------------------------------------
    def icon_preload(self, root, names):
        """Warm up: convert/find icons in a batch (parallel) so the first
        <img> on the panel don't wait for one-by-one conversion."""
        names = [str(n) for n in (names or []) if str(n).strip()][:600]
        if not names:
            return {"ok": True, "missing": []}

        def warm(name):
            hit = self.icon_source_file(root, name)
            if not hit:
                return name
            p = hit[0]
            if not p:
                return name
            if p.lower().endswith(".dds"):
                try:
                    self.dds_webp(p, root=root, kind="icon")  # persistent webp,
                    # best-effort: подпапка слоя, имя {stem}.webp
                except Exception:  # noqa: BLE001
                    pass
                try:
                    for _pp in self.icon_state_sources(root, name).values():
                        if _pp.lower().endswith(".dds"):
                            self.dds_webp(_pp, root=root, kind="icon")
                except Exception:  # noqa: BLE001
                    pass
                try:
                    return None if self.icon_webp(root, name) else name
                except Exception:  # noqa: BLE001
                    return name
            return None

        missing = []
        with ThreadPoolExecutor(max_workers=8) as ex:
            for res in ex.map(warm, names):
                if res:
                    missing.append(res)
        try:
            self.webp_index()  # сконвертированное точно видно дальше
        except Exception:  # noqa: BLE001
            pass
        return {"ok": True, "missing": missing}

    def icon_urls(self, root, names):
        """sysname -> ready-made webp URL in one request. The frontend sets
        direct <img>: zero dds conversion and sprite assembly, then the
        browser cache does the work.
        Снепшоты один раз на батч (как icons_data): иначе каждое имя
        повторяло бы stat-обходы webp_index/icon_map/_custom_preference —
        тёплый батч 827 имён стоил 1.3с чистого CPU."""
        names = sorted({str(n).strip() for n in (names or [])
                        if str(n).strip()})[:800]
        try:
            _idx = self.webp_index()
        except Exception:  # noqa: BLE001
            _idx = {}
        try:
            _amap = self.icon_map(root)
        except Exception:  # noqa: BLE001
            _amap = {}
        try:
            _guns = self.gun_index(root)
        except Exception:  # noqa: BLE001
            _guns = {}
        try:
            _pref = self._custom_preference(root)
        except Exception:  # noqa: BLE001
            _pref = []
        icons = {}
        for n in names:
            hit = self.icon_webp(root, n, _idx, _amap, _guns, _pref)
            icons[n] = self.webp_asset_url(*hit) if hit else ""
        return {"ok": True, "icons": icons}

    def icons_data(self, root, names):
        """All icons in one request: {name: data:image/webp;base64,...}.
        The server speaks HTTP/1.0 without keep-alive - hundreds of separate
        <img> cost seconds of per-connection overhead (~5ms each); one
        response removes it: the frontend sets data-URLs, all from memory.
        Чтение сотен webp — пулом потоков (I/O ждёт без GIL): холодный
        первый запрос карты в разы быстрее последовательного."""
        names = sorted({str(n).strip() for n in (names or [])
                        if str(n).strip()})[:1200]
        out = {}
        # снепшоты один раз на батч: иначе каждое имя повторяло бы
        # stat-проверки webp_index/icon_map (сотни лишних сисколов)
        try:
            _idx = self.webp_index()
        except Exception:  # noqa: BLE001
            _idx = {}
        try:
            _amap = self.icon_map(root)
        except Exception:  # noqa: BLE001
            _amap = {}
        try:
            _guns = self.gun_index(root)
        except Exception:  # noqa: BLE001
            _guns = {}
        try:
            _pref = self._custom_preference(root)
        except Exception:  # noqa: BLE001
            _pref = []

        def one(n):
            try:
                hit = self.icon_webp(root, n, _idx, _amap, _guns, _pref)
            except Exception:  # noqa: BLE001
                return (n, "")
            if not hit:
                return (n, "")
            try:
                return (n, self.data_url(*hit))
            except Exception:  # noqa: BLE001
                return (n, "")

        if len(names) > 24:
            with ThreadPoolExecutor(max_workers=8) as ex:
                for n, u in ex.map(one, names):
                    out[n] = u
        else:
            for n in names:
                _n, u = one(n)
                out[_n] = u
        return {"ok": True, "icons": out}

    def sprite(self, root, names):
        """Icon sprite for the map: one PNG strip + {name: [x,y,w,h]} layout.
        One request instead of hundreds of <img> - icons show right after
        opening. Cached on disk, the key includes source mtimes: reopening
        the same map is stat-checks only, no conversion."""
        names = sorted({str(n).strip() for n in (names or [])
                        if str(n).strip()})[:600]
        if not names:
            return {"ok": True, "url": "", "sprites": {}}
        amap = self.icon_map(root)

        def resolve(name):
            ent = amap.get(name)
            if not ent:
                return (name, "", 0.0)
            rel, kind = ent
            p = self.icon_file(root, rel, kind)
            if not p:
                return (name, "", 0.0)
            if p.lower().endswith(".dds"):
                # SOURCE mtime: one shared dds converts in parallel into one
                # png, the product mtime floats mid-race (rewrite races)
                try:
                    src_mt = os.path.getmtime(p)
                except OSError:
                    src_mt = 0.0
                p = self.dds_png(p) or ""
                if not p:
                    return (name, "", 0.0)
                return (name, p, src_mt)
            try:
                mt = os.path.getmtime(p)
            except OSError:
                mt = 0.0
            return (name, p, mt)

        with ThreadPoolExecutor(max_workers=8) as ex:
            resolved = list(ex.map(resolve, names))

        h = hashlib.sha1()
        h.update(b"sprite-grid-v2")  # bump when packing/layout changes
        h.update(os.path.normcase(root).encode("utf-8", "ignore"))
        for name, p, mt in resolved:
            h.update(name.encode("utf-8", "ignore"))
            h.update(os.path.normcase(p).encode("utf-8", "ignore"))
            h.update(str(mt).encode("ascii"))
        fp = h.hexdigest()[:24]
        spr_file = os.path.join(self.png_cache, "spr_" + fp + ".png")
        meta_file = os.path.join(self.png_cache, "spr_" + fp + ".json")
        layout = None
        if os.path.isfile(spr_file) and os.path.isfile(meta_file):
            try:
                with open(meta_file, "r", encoding="utf-8") as f:
                    layout = json.load(f)
            except (OSError, ValueError):
                layout = None
        if layout is None:
            try:
                from PIL import Image
                tiles = []
                for name, p, _mt in resolved:
                    im = None
                    if p:
                        try:
                            im = Image.open(p)
                            im.load()
                            if im.mode not in ("RGBA", "RGB"):
                                im = im.convert("RGBA")
                        except Exception:  # noqa: BLE001
                            im = None
                    tiles.append((name, im))
                ph_path = self.placeholder_png()
                ph = Image.open(ph_path) if ph_path else None
                if ph is not None:
                    ph.load()
                    if ph.mode not in ("RGBA", "RGB"):
                        ph = ph.convert("RGBA")
                else:
                    ph = Image.new("RGBA", (64, 64), (52, 56, 62, 150))
                layout = {}
                # grid, rows no wider than 2048: browsers downsample wider
                # images ~16k - icons went dark and blurry; missing names share
                # one stub cell (shorter strip, faster to fetch)
                max_w = x = y = row_h = 0
                placements = []
                ph_xy = None
                for name, im in tiles:
                    if im is None:
                        if ph_xy is None:
                            placements.append((ph, x, y))
                            ph_xy = (x, y)
                            x += ph.width
                            max_w = max(max_w, x)
                            row_h = max(row_h, ph.height)
                        layout[name] = [ph_xy[0], ph_xy[1], ph.width, ph.height]
                        continue
                    w, hgt = im.size
                    if x > 0 and x + w > 2048:
                        x = 0
                        y += row_h
                        row_h = 0
                    placements.append((im, x, y))
                    layout[name] = [x, y, w, hgt]
                    x += w
                    max_w = max(max_w, x)
                    row_h = max(row_h, hgt)
                strip = Image.new("RGBA", (max_w or 1, y + row_h or 1), (0, 0, 0, 0))
                for tile, px, py in placements:
                    # NO mask: cells never overlap, exact copy is needed
                    # (a mask from the image itself applied alpha twice:
                    # rgb*a, a^2 - semi-transparent edges went dark)
                    strip.paste(tile, (px, py))
                os.makedirs(self.png_cache, exist_ok=True)
                strip.save(spr_file, "PNG")
                with open(meta_file, "w", encoding="utf-8") as f:
                    json.dump(layout, f)
                # prune old sprites (7+ days), except the current one
                try:
                    now = time.time()
                    for fn in os.listdir(self.png_cache):
                        if (fn.startswith("spr_") and fn != os.path.basename(spr_file)
                                and fn != os.path.basename(meta_file)):
                            fp2 = os.path.join(self.png_cache, fn)
                            try:
                                if now - os.path.getmtime(fp2) > 7 * 86400:
                                    os.remove(fp2)
                            except OSError:
                                pass
                except OSError:
                    pass
            except Exception as e:  # noqa: BLE001
                self._log.warning("uprising sprite build failed: %s", e)
                return {"ok": False, "error": "sprite failed"}
        return {"ok": True,
                "url": "/api/uprising_sprite_file?key=" + fp,
                "sprites": layout}

    def sprite_path(self, key):
        """Cached sprite PNG path by key (hex 24), or ''."""
        key = (key or "").strip()
        if not key or not re.fullmatch(r"[0-9a-f]{24}", key):
            return ""
        p = os.path.join(self.png_cache, "spr_" + key + ".png")
        return p if os.path.isfile(p) else ""

    # -- balance config (.cfg) ----------------------------------------------------
    @staticmethod
    def _cfg_int(v, dflt):
        try:
            return int(str(v).strip().lstrip("x") or dflt)
        except (TypeError, ValueError):
            return dflt

    def cfg_write_file(self, path: str, data: dict):
        """Balance-config serialization (one shape for .cfg and presets):
        returns (ok, units|error)."""
        lines = ["# Terminator Overhaul - Uprising balance config v1"]
        # map binding: a foreign map's config never applies on read
        mp = str(data.get("map", "")).strip()
        if mp:
            lines.append("# Map=" + mp)
        lines.append("# Format: Sysname - Count=xN - difficulty=1..6|a-b - Cat=category"
                     " - Sector=zone - Variant=issue (zone attrs live in the ZONE row)")

        rows = []
        for u in (data.get("units") or []):
            rows.append({
                "sys": str(u.get("sys", "")).strip(),
                "count": self._cfg_int(u.get("count", 1), 1),
                "diff": str(u.get("diff", "") or "").strip() or "1",
                "cat": str(u.get("cat", "")).strip(),
                "sector": self._cfg_int(u.get("sector", 0), 0),
                "variant": self._cfg_int(u.get("variant", 0), 0),
            })
        # column widths across all file units - perfect alignment
        w = {
            "sys": max([len(r["sys"]) for r in rows] + [1]),
            "count": max([len(str(r["count"])) for r in rows] + [1]),
            "diff": max([len(r["diff"]) for r in rows] + [1]),
            "cat": max([len(r["cat"]) for r in rows] + [1]),
            "sector": max([len(str(r["sector"])) for r in rows] + [1]),
            "variant": max([len(str(r["variant"])) for r in rows] + [1]),
        }

        def unit_line(r):
            # numbers right-aligned, text left-aligned; Sector/Variant route
            # the unit on import, zone attrs (SectorDifficulty, faction) only
            # in the ZONE row, no repeats
            return " - ".join([
                r["sys"].ljust(w["sys"]),
                "Count=x" + str(r["count"]).rjust(w["count"]),
                "difficulty=" + r["diff"].ljust(w["diff"]),
                "Cat=" + r["cat"].ljust(w["cat"]),
                "Sector=" + str(r["sector"]).rjust(w["sector"]),
                "Variant=" + str(r["variant"]).rjust(w["variant"]),
            ]).rstrip()

        # grouping: zone -> (variant, category) -> rows
        groups = {}
        for r in rows:
            groups.setdefault(r["sector"], {}).setdefault(
                (r["variant"], r["cat"]), []).append(r)
        zmap = {}
        for z in (data.get("zones") or []):
            num = self._cfg_int(z.get("num", 0), 0)
            if num:
                zmap[num] = z
        rail = "=" * 66
        cat_rank = {c: i for i, c in enumerate(_CFG_CATS)}
        for num in sorted(set(zmap) | set(groups)):
            z = zmap.get(num, {})
            zd = max(1, self._cfg_int(z.get("diff", 1), 1))
            fac = str(z.get("faction", "")).strip()
            lines.append("")
            lines.append("# " + rail)
            lines.append("# ZONE %d | %s | difficulty %d" % (num, fac or "?", zd))
            lines.append("# " + rail)
            lines.append("ZONE - Sector=%d - SectorDifficulty=%d - faction=%s"
                         % (num, zd, fac))
            for vi, cat in sorted(groups.get(num, {}),
                                  key=lambda k: (k[0], cat_rank.get(k[1], 99))):
                lines.append("")
                lines.append("# ---- %s%s ----" %
                             (cat, "" if vi == 0 else " | variant %d" % vi))
                for r in sorted(groups[num][(vi, cat)],
                                key=lambda x: x["sys"].lower()):
                    lines.append(unit_line(r))
        try:
            d = os.path.dirname(path)
            if d and not os.path.isdir(d):
                os.makedirs(d, exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("\n".join(lines) + "\n")
        except OSError as e:
            return False, str(e)
        return True, len(rows)

    def cfg_read(self, path: str):
        """Read a balance config: zones + units (structured)."""
        if not path or not os.path.isfile(path):
            return {"ok": True, "exists": False}
        try:
            with open(path, "r", encoding="utf-8-sig", errors="replace") as fh:
                text = fh.read()
        except OSError as e:
            return {"ok": False, "error": str(e)}
        units, zones = [], []
        map_path = ""
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                if line[1:].strip().lower().startswith("map="):
                    map_path = line.split("=", 1)[1].strip()
                continue
            toks = [t.strip() for t in line.split(" - ")]
            if not toks or not toks[0]:
                continue
            kv = {}
            for tok in toks[1:]:
                if "=" in tok:
                    k, v = tok.split("=", 1)
                    kv[k.strip().lower()] = v.strip()
            if toks[0].upper() == "ZONE":
                num = self._cfg_int(kv.get("sector", 0), 0)
                if num:
                    zones.append({"num": num,
                                  "diff": max(1, self._cfg_int(kv.get("sectordifficulty", 1), 1)),
                                  "faction": kv.get("faction", "")})
                continue
            if "=" in toks[0]:
                continue  # junk row without a sysname
            units.append({"sys": toks[0],
                          "count": max(1, self._cfg_int(kv.get("count", 1), 1)),
                          "diff": kv.get("difficulty", ""),
                          "cat": kv.get("cat", ""),
                          "sector": self._cfg_int(kv.get("sector", 0), 0),
                          "variant": self._cfg_int(kv.get("variant", 0), 0),
                          "zdiff": max(1, self._cfg_int(kv.get("sectordifficulty", 1), 1)),
                          "faction": kv.get("faction", "")})
        return {"ok": True, "exists": True, "map": map_path,
                "units": units, "zones": zones}

    # -- presets ------------------------------------------------------------------
    def program_dir(self) -> str:
        """Program folder: next to the exe when frozen, next to app.py
        when running from sources."""
        if getattr(sys, "frozen", False):
            return os.path.dirname(os.path.abspath(sys.executable))
        return self._app_dir

    def preset_dirs(self):
        """Built-in (embedded-кэш frozen exe + рядом с exe + _MEIPASS +
        исходники) and custom presets."""
        builtin = []
        try:
            from . import embedded_cache as _emb
            emb_presets = _emb.ensure()[1]
        except Exception:  # noqa: BLE001
            emb_presets = ""
        if emb_presets and os.path.isdir(emb_presets):
            builtin.append(emb_presets)
        for r in (os.path.join(self.program_dir(), "UprisingPresets"),
                  os.path.join(self._app_dir, "UprisingPresets")):
            if os.path.isdir(r) and r not in builtin:
                builtin.append(r)
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            p = os.path.join(meipass, "UprisingPresets")
            if os.path.isdir(p) and p not in builtin:
                builtin.append(p)
        custom = os.path.join(self.program_dir(), "UprisingCustomPresets")
        return builtin, custom

    def preset_find(self, kind: str, name: str):
        base = (name or "").strip()
        if not base or "/" in base or "\\" in base or base.startswith("."):
            return None
        if not base.lower().endswith(".cfg"):
            base += ".cfg"
        builtin, custom = self.preset_dirs()
        dirs = [custom] if kind == "custom" else builtin
        for d in dirs:
            p = os.path.join(d, base)
            if os.path.isfile(p):
                return p
        return None

    def preset_list(self):
        """Built-in (from the exe) + custom presets."""
        builtin, custom = self.preset_dirs()
        out_b, seen = [], set()
        for d in builtin:
            try:
                for fn in sorted(os.listdir(d)):
                    if fn.lower().endswith(".cfg") and fn not in seen:
                        seen.add(fn)
                        out_b.append(fn)
            except OSError:
                pass
        out_c = []
        try:
            if os.path.isdir(custom):
                out_c = sorted(f for f in os.listdir(custom)
                               if f.lower().endswith(".cfg"))
        except OSError:
            pass
        return {"ok": True, "built_in": out_b, "custom": out_c}

    def preset_get(self, kind, name):
        """Preset file path - then read with the same cfg_read."""
        p = self.preset_find(kind, name)
        if not p:
            return {"ok": False, "error": "not_found"}
        return {"ok": True, "path": p}

    def preset_save(self, data: dict):
        """Create a custom preset from the current map payload.
        Written with the same serializer as the balance config."""
        base = (data.get("name", "") or "").strip()
        if not base or "/" in base or "\\" in base or base.startswith("."):
            return {"ok": False, "error": "bad_name"}
        if not base.lower().endswith(".cfg"):
            base += ".cfg"
        _, custom = self.preset_dirs()
        try:
            os.makedirs(custom, exist_ok=True)
        except OSError as e:
            return {"ok": False, "error": str(e)}
        p = self._store.normal(os.path.join(custom, base))
        if os.path.isfile(p) and not data.get("overwrite"):
            return {"ok": False, "error": "exists"}
        ok, res = self.cfg_write_file(p, data)
        if not ok:
            return {"ok": False, "error": res}
        self._log.info("uprising preset saved: %s", p)
        return {"ok": True, "path": p, "units": res}

    # -- режимы рандомайзера v2 -----------------------------------------------------
    def rnd_dirs(self):
        """Встроенные режимы (embedded-кэш frozen exe + рядом с exe +
        _MEIPASS + исходники) и пользовательские перекрытия."""
        builtin = []
        try:
            from . import embedded_cache as _emb
            emb = _emb.ensure()
            emb_rnd = emb[2] if len(emb) > 2 else ""
        except Exception:  # noqa: BLE001
            emb_rnd = ""
        if emb_rnd and os.path.isdir(emb_rnd):
            builtin.append(emb_rnd)
        for r in (os.path.join(self.program_dir(), _RND_DIR_BUILTIN),
                  os.path.join(self._app_dir, _RND_DIR_BUILTIN)):
            if os.path.isdir(r) and r not in builtin:
                builtin.append(r)
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            p = os.path.join(meipass, _RND_DIR_BUILTIN)
            if os.path.isdir(p) and p not in builtin:
                builtin.append(p)
        custom = os.path.join(self.program_dir(), _RND_DIR_CUSTOM)
        return builtin, custom

    @staticmethod
    def _rnd_name_ok(name: str):
        """Санитизация имени режима: та же строгость, что preset_find."""
        base = (name or "").strip()
        if not base or "/" in base or "\\" in base or base.startswith("."):
            return ""
        if ".." in base or len(base) > 64:
            return ""
        base = base.strip()
        if not base:
            return ""
        if not base.lower().endswith(".cfg"):
            base += ".cfg"
        stem = base[:-4]
        if not re.fullmatch(r"[A-Za-z0-9_\- ]+", stem):
            return ""
        return base

    def rnd_find(self, kind: str, name: str):
        base = self._rnd_name_ok(name)
        if not base:
            return None
        builtin, custom = self.rnd_dirs()
        if kind == "custom":
            dirs = [custom]
        elif kind == "built-in":
            dirs = builtin
        else:  # any: сначала своё перекрытие, затем встроенные
            dirs = [custom] + builtin
        for d in dirs:
            p = os.path.join(d, base)
            if os.path.isfile(p):
                return p
        return None

    def rnd_list(self):
        """Режимы: встроенные + пользовательские (свой перекрывает)."""
        builtin, custom = self.rnd_dirs()
        out_b, seen = [], set()
        for d in builtin:
            try:
                for fn in sorted(os.listdir(d)):
                    if fn.lower().endswith(".cfg") and fn not in seen:
                        seen.add(fn)
                        out_b.append(fn)
            except OSError:
                pass
        out_c = []
        try:
            if os.path.isdir(custom):
                out_c = sorted(f for f in os.listdir(custom)
                               if f.lower().endswith(".cfg"))
        except OSError:
            pass
        return {"ok": True, "built_in": out_b, "custom": out_c}

    @staticmethod
    def rnd_detect(path: str):
        """v2, если есть секция [MODE]; иначе v1 (ZONE-формат)."""
        try:
            with open(path, "r", encoding="utf-8-sig",
                      errors="replace") as fh:
                for raw in fh.read().splitlines():
                    if raw.strip().upper() == "[MODE]":
                        return "v2"
        except OSError:
            pass
        return "v1"

    @staticmethod
    def _rnd_norm_diff(val: str):
        """N или N-M -> (a, b) в 1..6 с нормализацией; None при мусоре."""
        m = re.match(r"^\s*([0-9]+)(?:\s*-\s*([0-9]+))?\s*$",
                     str(val or ""))
        if not m:
            return None
        a = int(m.group(1))
        b = int(m.group(2)) if m.group(2) is not None else a
        if a > b:
            a, b = b, a
        clip = a != max(1, min(6, a)) or b != max(1, min(6, b))
        a, b = max(1, min(6, a)), max(1, min(6, b))
        return (a, b, clip)

    def rnd_parse_v2(self, path: str):
        """Парсинг конфига v2 с номерами строк: ошибки/предупреждения."""
        try:
            with open(path, "r", encoding="utf-8-sig",
                      errors="replace") as fh:
                lines = fh.read().splitlines()
        except OSError as e:
            return {"ok": False, "error": str(e)}
        sect, data = "", {}
        warns, errs = [], []
        sect_lines = {}
        # сырые строки для round-trip (неизвестное не теряем)
        raw_tail = []
        mode = {"name": ""}
        rules = dict(_RND_DEFAULTS.get("balanced", {}))
        weights = dict(_RND_WEIGHTS_DFLT)
        loot = dict(_RND_LOOT_DFLT)
        sectors, units = {}, []
        seen_num = {}
        cur = None
        known_rule_keys = set(rules)
        known_loot_keys = set(loot)
        for i, raw in enumerate(lines, 1):
            line = raw.strip()
            if not line or line.startswith("#") or line.startswith(";"):
                raw_tail.append((cur, raw))
                continue
            m = re.match(r"^\[(.+)\]$", line)
            if m:
                sect = m.group(1).strip().upper()
                cur = sect
                sect_lines.setdefault(sect, i)
                if sect not in ("MODE", "RULES", "WEIGHTS", "SECTORS",
                                "UNITS", "LOOT"):
                    warns.append({"line": i,
                                  "text": "неизвестная секция [%s]" % sect})
                    cur = None
                continue
            if "=" not in line:
                errs.append({"line": i, "text": "нет знака ="})
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip()
            if cur == "MODE":
                if k.lower() == "name":
                    mode["name"] = v
                else:
                    warns.append({"line": i,
                                  "text": "неизвестный ключ MODE.%s" % k})
            elif cur == "RULES":
                kl = k.lower()
                if kl not in known_rule_keys:
                    warns.append({"line": i,
                                  "text": "неизвестный ключ RULES.%s" % k})
                    continue
                if kl in ("count_heads", "diff_soft_pm", "no_origin",
                          "no_neighbours"):
                    lv = v.lower()
                    if lv in ("1", "true", "yes", "да"):
                        rules[kl] = True
                    elif lv in ("0", "false", "no", "нет"):
                        rules[kl] = False
                    else:
                        errs.append({"line": i,
                                     "text": "RULES.%s: нужно true/false" % k})
                elif kl == "faction_mode":
                    if v.lower() in _RND_MODES:
                        rules[kl] = v.lower()
                    else:
                        errs.append({"line": i,
                                     "text": "faction_mode: own|mix|free"})
                elif kl in ("chaos_k",):
                    try:
                        f = float(v.replace(",", "."))
                    except ValueError:
                        errs.append({"line": i,
                                     "text": "chaos_k: число 0..2"})
                        continue
                    if not 0.0 <= f <= 2.0:
                        errs.append({"line": i,
                                     "text": "chaos_k: число 0..2"})
                    else:
                        rules[kl] = f
                else:
                    try:
                        rules[kl] = int(v)
                    except ValueError:
                        errs.append({"line": i,
                                     "text": "RULES.%s: целое число" % k})
            elif cur == "WEIGHTS":
                kl = k.lower()
                if kl not in weights:
                    warns.append({"line": i,
                                  "text": "неизвестная категория %s" % k})
                    continue
                try:
                    weights[kl] = float(v.replace(",", "."))
                except ValueError:
                    errs.append({"line": i,
                                 "text": "WEIGHTS.%s: число" % k})
            elif cur == "SECTORS":
                try:
                    num = int(k)
                except ValueError:
                    errs.append({"line": i,
                                 "text": "сектор: номер 1..22"})
                    continue
                if not 1 <= num <= 22:
                    errs.append({"line": i,
                                 "text": "сектор вне 1..22"})
                    continue
                parts = v.split()
                if len(parts) != 3:
                    errs.append({"line": i,
                                 "text": "формат: difficulty faction protect"})
                    continue
                nd = self._rnd_norm_diff(parts[0])
                if nd is None:
                    errs.append({"line": i,
                                 "text": "сложность: N или N-M (1..6)"})
                    continue
                # в секторах диапазон схлопываем до одиночного: зона одна
                diff = nd[0] if nd[0] == nd[1] else nd[0]
                if nd[0] != nd[1]:
                    warns.append({"line": i, "text":
                                  "сектор %d: диапазон схлопнут до %d"
                                  % (num, diff)})
                if nd[2]:
                    warns.append({"line": i, "text":
                                  "сектор %d: обрезано до 1..6" % num})
                fac = parts[1].lower()
                if fac not in _RND_FACTIONS:
                    errs.append({"line": i,
                                 "text": "фракция: %s" % "/".join(
                                     _RND_FACTIONS)})
                    continue
                prot = parts[2].lower()
                if prot in ("-", "нет", "none"):
                    prot = "-"
                elif prot not in ("start", "capital"):
                    errs.append({"line": i,
                                 "text": "защита: -|start|capital"})
                    continue
                if prot == "start" and num not in _RND_STARTS:
                    warns.append({"line": i, "text":
                                  "сектор %d: start вне стартовой карты "
                                  "(сохраняется как есть)" % num})
                if num in seen_num:
                    warns.append({"line": i, "text":
                                  "сектор %d: дубликат строки %d, "
                                  "берётся последняя"
                                  % (num, seen_num[num])})
                seen_num[num] = i
                sectors[str(num)] = {"difficulty": diff, "faction": fac,
                                     "protect": prot}
            elif cur == "UNITS":
                sysname = k.strip()
                if not sysname or "=" in sysname or " " in sysname:
                    errs.append({"line": i, "text": "пустой sysname"})
                    continue
                parts = v.split()
                if len(parts) not in (2, 3, 4):
                    errs.append({"line": i, "text":
                                 "формат: difficulty category "
                                 "[sector] [count]"})
                    continue
                nd = self._rnd_norm_diff(parts[0])
                if nd is None:
                    errs.append({"line": i,
                                 "text": "сложность: N или N-M (1..6)"})
                    continue
                diff = str(nd[0]) if nd[0] == nd[1] else "%d-%d" % (nd[0],
                                                                   nd[1])
                if nd[2]:
                    warns.append({"line": i, "text":
                                  "%s: обрезано до 1..6" % sysname})
                cat = parts[1].lower()
                if cat not in _CFG_CATS:
                    errs.append({"line": i, "text":
                                 "категория: %s" % "/".join(_CFG_CATS)})
                    continue
                # сектор привязки: 0/пропуск = общий пул, 1..22 = свой сектор
                sector = 0
                if len(parts) >= 3:
                    try:
                        sector = int(parts[2].lstrip("sS"))
                    except ValueError:
                        errs.append({"line": i,
                                     "text": "сектор: 1..22 (0 = общий пул)"})
                        continue
                    if not 0 <= sector <= 22:
                        errs.append({"line": i, "text":
                                     "сектор вне 0..22"})
                        continue
                # количество: N, xN или ×N (по умолчанию 1)
                count = 1
                if len(parts) >= 4:
                    mc = re.match(r"^[x×]?([0-9]+)$",
                                  parts[3].strip().lower())
                    if not mc:
                        errs.append({"line": i,
                                     "text": "количество: 1..99"})
                        continue
                    count = int(mc.group(1))
                    if not 1 <= count <= 99:
                        errs.append({"line": i,
                                     "text": "количество: 1..99"})
                        continue
                units.append({"sys": sysname, "diff": diff, "cat": cat,
                              "sector": sector, "count": count})
            elif cur == "LOOT":
                kl = k.lower()
                if kl not in known_loot_keys:
                    warns.append({"line": i,
                                  "text": "неизвестный ключ LOOT.%s" % k})
                    continue
                if kl in ("rare_in_capital", "common_free"):
                    lv = v.lower()
                    if lv in ("1", "true", "yes", "да"):
                        loot[kl] = True
                    elif lv in ("0", "false", "no", "нет"):
                        loot[kl] = False
                    else:
                        errs.append({"line": i,
                                     "text": "LOOT.%s: нужно true/false" % k})
                else:
                    try:
                        loot[kl] = int(v)
                    except ValueError:
                        errs.append({"line": i,
                                     "text": "LOOT.%s: целое число" % k})
            else:
                warns.append({"line": i, "text": "строка вне секций"})
        if errs:
            return {"ok": False, "errors": errs, "warnings": warns}
        if "SECTORS" not in sect_lines:
            return {"ok": False,
                    "errors": [{"line": 0, "text": "нет секции [SECTORS]"}],
                    "warnings": warns}
        if "UNITS" not in sect_lines:
            return {"ok": False,
                    "errors": [{"line": 0, "text": "нет секции [UNITS]"}],
                    "warnings": warns}
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            mtime = 0
        return {"ok": True, "version": "v2", "mode": mode, "rules": rules,
                "weights": weights, "sectors": sectors, "units": units,
                "loot": loot, "warnings": warns, "mtime": mtime,
                "path": path}

    @staticmethod
    def rnd_serialize_v2(data: dict):
        """Сериализация v2 с русскими комментариями (для Блокнота)."""
        mode = str((data.get("mode") or {}).get("name")
                   or data.get("name") or "custom").strip() or "custom"
        rules = data.get("rules") or {}
        weights = data.get("weights") or {}
        sectors = data.get("sectors") or {}
        units = data.get("units") or []
        loot = data.get("loot") or {}

        def _b(v):
            return "true" if v else "false"

        L = ["# Terminator Overhaul - Uprising randomizer config v2",
             "# Названия режимов — в locales (здесь не править)",
             "# Числа и sysname правятся руками: # — комментарий",
             "[MODE]", "name = " + mode, "",
             "# --- Правила: как мешать ---",
             "# faction_mode: own — свои по фракциям, mix — вперемешку,",
             "#   free — без ограничений (только Эксперт/свои пресеты)",
             "# chaos_k: 0..2 сила перемешивания;",
             "#   в Хаосе сложность игнорируется, k мешает только позиции",
             "# diff_soft_pm: галка «±1» — регион 4 берёт юниты 3-5",
             "#   (края с половинным весом), выкл — строгое попадание",
             "[RULES]",
             "faction_mode = " + str(rules.get(
                 "faction_mode",
                 _RND_DEFAULTS["balanced"]["faction_mode"])),
             "chaos_k = " + str(rules.get(
                 "chaos_k", _RND_DEFAULTS["balanced"]["chaos_k"])),
             "count_heads = " + _b(rules.get(
                 "count_heads",
                 _RND_DEFAULTS["balanced"]["count_heads"])),
             "diff_soft_pm = " + _b(rules.get(
                 "diff_soft_pm",
                 _RND_DEFAULTS["balanced"]["diff_soft_pm"])),
             "no_origin = " + _b(rules.get(
                 "no_origin", _RND_DEFAULTS["balanced"]["no_origin"])),
             "no_neighbours = " + _b(rules.get(
                 "no_neighbours",
                 _RND_DEFAULTS["balanced"]["no_neighbours"])),
             "cap_heads = " + str(rules.get(
                 "cap_heads", _RND_DEFAULTS["balanced"]["cap_heads"])),
             "seed_default = " + str(rules.get(
                 "seed_default",
                 _RND_DEFAULTS["balanced"]["seed_default"])), "",
             "# --- Веса категорий при подборе ---",
             "[WEIGHTS]"]
        for c in _CFG_CATS:
            L.append("%s = %s" % (c, weights.get(c,
                                                 _RND_WEIGHTS_DFLT[c])))
        L += ["",
              "# --- Секторы: num = difficulty faction protect ---",
              "# difficulty 1..6 обязательна; protect: - | start | capital",
              "# стартовые игрока: 1, 2, 22; столицы: 1, 4, 12, 18, 22",
              "# пропущенная зона при сохранении дописывается явно",
              "[SECTORS]"]
        for n in range(1, 23):
            s = sectors.get(str(n)) or sectors.get(n) or {}
            L.append("%d = %s %s %s" % (
                n, s.get("difficulty", 1), s.get("faction", "player"),
                s.get("protect", "-")))
        L += ["",
              "# --- Юниты: sysname = difficulty category [sector] [count] ---",
              "# difficulty: N или N-M (1..6); sector 1..22 = свой сектор,",
              "#   пропуск = общий пул; count по умолчанию ×1",
              "# юнита нет в списке — наследует сложность зоны-источника",
              "[UNITS]"]
        # общий пул — группировкой по категориям, как раньше;
        # сектора — блоками «сектор N» с подгруппами категорий
        try:
            sec_of = lambda u: int(u.get("sector", 0) or 0)
        except (TypeError, ValueError):
            sec_of = lambda u: 0
        try:
            cnt_of = lambda u: max(1, min(99, int(u.get("count", 1) or 1)))
        except (TypeError, ValueError):
            cnt_of = lambda u: 1

        def _tail(u):
            s, c = sec_of(u), cnt_of(u)
            t = ""
            if s:
                t += " %d" % s
                if c != 1:
                    t += " %d" % c
            elif c != 1:
                t += " 0 %d" % c
            return t

        pool = [u for u in units if not sec_of(u)]
        by_cat = {}
        for u in pool:
            by_cat.setdefault(str(u.get("cat", "")), []).append(u)
        if pool:
            L.append("")
            L.append("# ---- общий пул ----")
        for c in _CFG_CATS:
            rows = sorted(by_cat.get(c, []),
                          key=lambda x: str(x.get("sys", "")).lower())
            if not rows and c not in by_cat:
                continue
            L.append("")
            L.append("# ---- %s ----" % c)
            for u in rows:
                L.append("%s = %s %s%s" % (u.get("sys", ""),
                                           u.get("diff", "1"), c,
                                           _tail(u)))
        for n in range(1, 23):
            su = sorted((u for u in units if sec_of(u) == n),
                        key=lambda x: (str(x.get("cat", "")),
                                       str(x.get("sys", "")).lower()))
            if not su:
                continue
            L.append("")
            L.append("# ---- сектор %d ----" % n)
            last_c = None
            for u in su:
                c = str(u.get("cat", ""))
                if c != last_c:
                    L.append("# -- %s --" % c)
                    last_c = c
                L.append("%s = %s %s%s" % (u.get("sys", ""),
                                           u.get("diff", "1"), c,
                                           _tail(u)))
        L += ["",
              "# --- Лут: редкие предметы отдельно от юнитов ---",
              "# редкие (cost >= rare_min_cost) только в сложных",
              "# секторах (diff >= rare_only_diff) и столицах",
              "[LOOT]",
              "rare_min_cost = " + str(loot.get(
                  "rare_min_cost", _RND_LOOT_DFLT["rare_min_cost"])),
              "rare_only_diff = " + str(loot.get(
                  "rare_only_diff", _RND_LOOT_DFLT["rare_only_diff"])),
              "rare_in_capital = " + _b(loot.get(
                  "rare_in_capital", _RND_LOOT_DFLT["rare_in_capital"])),
              "common_free = " + _b(loot.get(
                  "common_free", _RND_LOOT_DFLT["common_free"]))]
        # неизвестные сырые строки дописываем хвостом (round-trip не теряет)
        for extra in (data.get("extra_lines") or []):
            L.append(str(extra))
        return "\n".join(L) + "\n"

    def rnd_mode_get(self, kind, name):
        """Прочитать режим: v2 парсингом, v1 — как есть (только чтение)."""
        p = self.rnd_find(kind, name)
        if not p:
            # встроенных может не быть в dev-окружении — смотрим пресеты v1?
            # нет: режимы и пресеты — разные папки, пусто так пусто
            return {"ok": False, "error": "not_found"}
        ver = self.rnd_detect(p)
        if ver == "v1":
            r = self.cfg_read(p)
            if not r.get("ok"):
                return r
            try:
                mtime = os.path.getmtime(p)
            except OSError:
                mtime = 0
            r.update({"version": "v1", "mtime": mtime, "path": p,
                      "legacy": True})
            return r
        r = self.rnd_parse_v2(p)
        if not r.get("ok"):
            return r
        _, custom = self.rnd_dirs()
        r["is_custom"] = os.path.isfile(
            os.path.join(custom, os.path.basename(p)))
        return r

    def rnd_mode_save(self, payload: dict):
        """Сохранить режим: пишет ТОЛЬКО в Custom (встроенные не трогаем).

        Проверяет mtime от клиента против диска (параллельная правка).
        """
        name = self._rnd_name_ok(payload.get("name", ""))
        if not name:
            return {"ok": False, "error": "bad_name"}
        _, custom = self.rnd_dirs()
        try:
            os.makedirs(custom, exist_ok=True)
        except OSError as e:
            return {"ok": False, "error": str(e)}
        p = self._store.normal(os.path.join(custom, name))
        if os.path.isfile(p) and not payload.get("overwrite"):
            return {"ok": False, "error": "exists"}
        if os.path.isfile(p):
            try:
                cur_mt = os.path.getmtime(p)
            except OSError:
                cur_mt = 0
            want = payload.get("mtime") or 0
            try:
                want = float(want)
            except (TypeError, ValueError):
                want = 0
            if want and abs(cur_mt - want) > 1.5:
                return {"ok": False, "error": "conflict", "mtime": cur_mt}
        text = self.rnd_serialize_v2(payload.get("data") or payload)
        try:
            with open(p, "w", encoding="utf-8") as fh:
                fh.write(text)
        except OSError as e:
            return {"ok": False, "error": str(e)}
        # валидация записанного: что сохранили, то и читается
        chk = self.rnd_parse_v2(p)
        if not chk.get("ok"):
            return {"ok": False, "error": "saved_invalid",
                    "details": chk.get("errors")}
        self._log.info("uprising rnd mode saved: %s", p)
        try:
            mtime = os.path.getmtime(p)
        except OSError:
            mtime = 0
        return {"ok": True, "path": p, "mtime": mtime,
                "warnings": chk.get("warnings", [])}

    def rnd_mode_delete(self, name):
        """Удалить только свой режим (встроенные удалять нельзя)."""
        base = self._rnd_name_ok(name)
        if not base:
            return {"ok": False, "error": "bad_name"}
        _, custom = self.rnd_dirs()
        p = os.path.join(custom, base)
        if not os.path.isfile(p):
            return {"ok": False, "error": "not_found"}
        try:
            os.remove(p)
        except OSError as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True}

    def rnd_mode_duplicate(self, src, name):
        """Дублировать режим в Custom под новым именем."""
        dest = self._rnd_name_ok(name)
        if not dest:
            return {"ok": False, "error": "bad_name"}
        p = self.rnd_find("any", src)
        if not p:
            return {"ok": False, "error": "not_found"}
        if self.rnd_detect(p) == "v1":
            return {"ok": False, "error": "legacy_src"}
        r = self.rnd_parse_v2(p)
        if not r.get("ok"):
            return r
        _, custom = self.rnd_dirs()
        dp = os.path.join(custom, dest)
        if os.path.isfile(dp):
            return {"ok": False, "error": "exists"}
        data = {"mode": {"name": dest[:-4]}, "rules": r["rules"],
                "weights": r["weights"], "sectors": r["sectors"],
                "units": r["units"], "loot": r["loot"]}
        return self.rnd_mode_save({"name": dest, "data": data})

    def rnd_convert_v1(self, kind, name, new_name):
        """Преобразовать v1-пресет (ZONE) в режим v2 (копия в Custom)."""
        dest = self._rnd_name_ok(new_name)
        if not dest:
            return {"ok": False, "error": "bad_name"}
        # v1 ищем среди режимов И среди пресетов (старые UprisingPresets)
        p = self.rnd_find(kind, name)
        if not p or self.rnd_detect(p) != "v1":
            p = self.preset_find(kind if kind in ("custom",
                                                  "built-in") else "built-in",
                                 name)
        if not p:
            return {"ok": False, "error": "not_found"}
        r = self.cfg_read(p)
        if not r.get("ok"):
            return r
        zmap = {}
        for z in (r.get("zones") or []):
            try:
                n = int(z.get("num", 0))
            except (TypeError, ValueError):
                continue
            if 1 <= n <= 22:
                zmap[n] = z
        sectors = {}
        for n in range(1, 23):
            z = zmap.get(n) or {}
            try:
                d = int(z.get("diff", 1) or 1)
            except (TypeError, ValueError):
                d = 1
            d = max(1, min(6, d))
            fac = str(z.get("faction", "") or "player").strip().lower()
            if fac not in _RND_FACTIONS:
                fac = "player"
            if n in _RND_CAPITALS:
                prot = "capital"
            elif n in _RND_STARTS:
                prot = "start"
            else:
                prot = "-"
            sectors[str(n)] = {"difficulty": d, "faction": fac,
                               "protect": prot}
        # v1 хранит сектор и количество в каждой строке — переносим как есть;
        # один sysname в разных секторах = разные записи (не сливаем),
        # в одном секторе — сливаем сложности в диапазон, количество — максимум
        bucket = {}
        for u in (r.get("units") or []):
            sysname = str(u.get("sys", "")).strip()
            if not sysname:
                continue
            diff = str(u.get("diff", "") or "").strip() or "1"
            nd = self._rnd_norm_diff(diff)
            if nd is None:
                nd = (1, 1, False)
            cat = str(u.get("cat", "") or "").strip().lower()
            if cat not in _CFG_CATS:
                cat = "squads"
            try:
                sec = int(u.get("sector", 0) or 0)
            except (TypeError, ValueError):
                sec = 0
            sec = max(0, min(22, sec))
            try:
                cnt = int(u.get("count", 1) or 1)
            except (TypeError, ValueError):
                cnt = 1
            cnt = max(1, min(99, cnt))
            key = (sysname, cat, sec)
            if key in bucket:
                old = bucket[key]
                bucket[key] = (min(old[0], nd[0]), max(old[1], nd[1]),
                               max(old[2], cnt))
            else:
                bucket[key] = (nd[0], nd[1], cnt)
        units = []
        for (sysname, cat, sec), (a, b, cnt) in sorted(bucket.items()):
            diff = str(a) if a == b else "%d-%d" % (a, b)
            units.append({"sys": sysname, "diff": diff, "cat": cat,
                          "sector": sec, "count": cnt})
        data = {"mode": {"name": dest[:-4]},
                "rules": dict(_RND_DEFAULTS["balanced"]),
                "weights": dict(_RND_WEIGHTS_DFLT),
                "sectors": sectors, "units": units,
                "loot": dict(_RND_LOOT_DFLT)}
        return self.rnd_mode_save({"name": dest, "data": data})

    # -- map backup / reset ---------------------------------------------------------
    _UPR_BACKUP_KEEP = 5    # generations per source root, newest wins
    _UPR_BACKUP_MIN = 100   # smaller files are failed writes, never restore

    def prune_backups(self, key_dir):
        """Generations per root: newest 5 shop_presets*.xml survive; tiny
        failed writes and top-level strays (old test junk, never referenced
        by any code path) are removed."""
        try:
            names = os.listdir(key_dir)
        except OSError:
            return
        cands = []
        for fn in names:
            if not (fn == "shop_presets.xml"
                    or (fn.startswith("shop_presets.")
                        and fn.endswith(".xml"))):
                continue
            p = os.path.join(key_dir, fn)
            try:
                if os.path.isfile(p):
                    cands.append((os.path.getmtime(p), os.path.getsize(p), p))
            except OSError:
                pass
        for _mt, size, p in cands:
            if size < self._UPR_BACKUP_MIN:
                try:
                    os.remove(p)
                except OSError:
                    pass
        cands = [c for c in cands if c[1] >= self._UPR_BACKUP_MIN]
        cands.sort()
        for _mt, _sz, p in cands[:-self._UPR_BACKUP_KEEP]:
            try:
                os.remove(p)
            except OSError:
                pass
        top = os.path.dirname(key_dir)
        try:
            top_names = os.listdir(top)
        except OSError:
            return
        for fn in top_names:
            low = fn.lower()
            if not (low.endswith(".xml") and ("shop_presets" in low
                                              or low.startswith("polluted_"))):
                continue
            try:
                if os.path.isfile(os.path.join(top, fn)):
                    os.remove(os.path.join(top, fn))
            except OSError:
                pass

    def _rotate_backup(self, key_dir, bpath):
        """Shift generations (.3->.4 … live->.1) before a fresh snapshot;
        prune keeps the newest 5 total."""
        try:
            if not os.path.isfile(bpath):
                return
            if os.path.getsize(bpath) < self._UPR_BACKUP_MIN:
                os.remove(bpath)
                return
        except OSError:
            return
        base = os.path.join(key_dir, "shop_presets")
        try:
            for i in range(self._UPR_BACKUP_KEEP - 1, 0, -1):
                src = bpath if i == 1 else base + ".%d.xml" % (i - 1)
                dst = base + ".%d.xml" % i
                if os.path.isfile(src):
                    try:
                        if os.path.isfile(dst):
                            os.remove(dst)
                    except OSError:
                        pass
                    try:
                        os.rename(src, dst)
                    except OSError:
                        pass
        except OSError:
            pass

    @staticmethod
    def _same_file(a, b):
        try:
            if os.path.getsize(a) != os.path.getsize(b):
                return False
            with open(a, "rb") as fa, open(b, "rb") as fb:
                while True:
                    ca, cb = fa.read(65536), fb.read(65536)
                    if ca != cb:
                        return False
                    if not ca:
                        return True
        except OSError:
            return False

    def backup_dir(self, root: str) -> str:
        """Clean shop_presets.xml copy per source (mod project and unpacked
        game have their own files): key = normalized root. The reserve
        folder lives next to the exe; old BASE_DIR copies are picked up as
        fallback and carried forward."""
        key = hashlib.md5(os.path.normcase(os.path.normpath(root or "unknown"))
                          .encode("utf-8")).hexdigest()[:16]
        primary = os.path.join(self.program_dir(), "uprising_backups", key)
        legacy = os.path.join(self._app_dir, "uprising_backups", key)
        if primary != legacy and not os.path.isfile(os.path.join(primary, "shop_presets.xml")):
            leg = os.path.join(legacy, "shop_presets.xml")
            if os.path.isfile(leg) and os.path.getsize(leg) >= self._UPR_BACKUP_MIN:
                try:
                    os.makedirs(primary, exist_ok=True)
                    shutil.copy2(leg, os.path.join(primary, "shop_presets.xml"))
                except OSError:
                    pass
        return primary

    def reset_map(self, root, path, cfg_path, ensure_only):
        """ensure_only: snapshot a clean map copy on first open from a root
        (a changed file re-snapshots with rotation, newest 5 survive).
        Otherwise - reset: restore shop_presets.xml from the clean copy and
        delete the balance config. Tiny failed writes are never restored."""
        if not path or not os.path.isfile(path):
            return {"ok": False, "error": "no file"}
        key_dir = self.backup_dir(root)
        try:
            self.prune_backups(key_dir)
        except Exception:  # noqa: BLE001
            pass
        bpath = os.path.join(key_dir, "shop_presets.xml")
        restored = False
        if not os.path.isfile(bpath):
            os.makedirs(key_dir, exist_ok=True)
            shutil.copy2(path, bpath)
            try:
                self.prune_backups(key_dir)
            except Exception:  # noqa: BLE001
                pass
        elif ensure_only:
            # file changed since the snapshot (root re-added, external edit):
            # rotate generations and snapshot the current state
            try:
                cur_ok = os.path.getsize(path) >= self._UPR_BACKUP_MIN
            except OSError:
                cur_ok = False
            if cur_ok and not self._same_file(path, bpath):
                self._rotate_backup(key_dir, bpath)
                try:
                    shutil.copy2(path, bpath)
                except OSError as e:
                    return {"ok": False, "error": str(e)}
                try:
                    self.prune_backups(key_dir)
                except Exception:  # noqa: BLE001
                    pass
        else:
            try:
                tiny = os.path.getsize(bpath) < self._UPR_BACKUP_MIN
            except OSError:
                return {"ok": False, "error": "no backup"}
            if tiny:
                try:
                    os.remove(bpath)
                except OSError:
                    pass
                return {"ok": False, "error": "backup broken, removed"}
            shutil.copy2(bpath, path)
            restored = True
        cfg_removed = False
        if not ensure_only and cfg_path and os.path.isfile(cfg_path):
            try:
                os.remove(cfg_path)
                cfg_removed = True
            except OSError as e:
                return {"ok": False, "error": str(e)}
        return {"ok": True, "restored": restored, "cfg_removed": cfg_removed}

    def sniff_shop_counts(self, path):
        """Счётчики строк shop_presets.xml за один проход: sector (награды
        секторов sector_N_reward), shop (магазины кампании), named (всего
        именованных). Ошибка чтения — нули."""
        sector = shop = named = 0
        try:
            with open(path, "r", encoding="utf-8",
                       errors="replace") as fh:
                text = fh.read(4 << 20)
        except (OSError, ValueError):
            return {"sector": 0, "shop": 0, "named": 0}
        for i, m in enumerate(_SPECIES_ROW_RE.finditer(text)):
            if i == 0:
                continue  # header
            mm = _SPECIES_NAME_RE.search(m.group(1))
            if not mm:
                continue
            name = mm.group(1).strip()
            if not name:
                continue
            named += 1
            if _UPR_SECTOR_RE.match(name):
                sector += 1
            elif _UPR_SHOP_RE.match(name):
                shop += 1
        return {"sector": sector, "shop": shop, "named": named}

    def sniff_shop(self, path):
        """Счётчики + legacy-флаг uprising (правило карты не меняется).
        Нужно дабл-клику: чисто секторный -> карта, чисто магазинный ->
        кампания, смешанный (есть и те, и другие) -> решает путь."""
        c = self.sniff_shop_counts(path)
        c["uprising"] = (c["sector"] >= _UPR_SECTOR_MIN
                         and c["sector"] * 2 >= c["named"])
        return c

    def is_uprising_shop(self, path):
        """Контентный детект файла карты: sysname строк — награды секторов
        (sector_N_reward[_variant]). Путь НЕ участвует: DLC-файл с рабочего
        стола, лежащий в корне проекта, опознаётся так же, как из
        dlc/Resistance. Базовый shop_presets (магазины кампании test_shop_*,
        vega_*, tortuga_*...) сектор-строк не имеет -> False (таблица)."""
        return self.sniff_shop(path)["uprising"]

    def find_shop(self, root):
        """Найти файл карты по СОДЕРЖИМОМУ: первый shop_presets.xml
        с наградами секторов. Фиксированный DLC-путь — лишь первый
        кандидат (стабильность старого поведения); дальше — все точные
        shop_presets.xml под root по сортированному пути. Путь сам по
        себе ничего не решает: базовый файл из dlc-папки картой не
        станет, а секторный из корня проекта — станет. '' вместо
        базового файла: пустая карта с тостом больше не открывается.

        Перф: каждый вызов раньше делал полный os.walk по root (на
        распакованной игре — 5-12с под GIL-давлением параллельных
        game_tree/warmup, см. app.log) и стоял на критическом пути до
        первой отрисовки карты. Теперь: мемоизация (валидация — мс),
        затем прямые кандидаты basis/DLC без walk, полный walk —
        лишь фолбэк для нестандартных раскладок."""
        if not root or not os.path.isdir(root):
            return {"ok": True, "path": ""}
        # 1. мемоизация: положительный хит валидируем дешёвым сниффом
        # (файл маленький, мс); отрицательный живёт 30с, чтобы серия
        # кликов «карты нет» не устраивала walk-шторм
        hit = self.find_cache.get(root)
        if hit is not None:
            hp, hts = hit
            if hp:
                try:
                    if os.path.isfile(hp) and self.is_uprising_shop(hp):
                        return {"ok": True, "path": hp}
                except Exception:  # noqa: BLE001
                    pass
            elif time.time() - hts < 30:
                return {"ok": True, "path": ""}
        # 2. прямые кандидаты без walk: фикс, базовый species, DLC-оверлеи
        quick = []
        fixed = os.path.join(root, *_UPRISING_REL.split(os.sep))
        if os.path.isfile(fixed):
            quick.append(fixed)
        spec_rel = os.path.join("basis", "scripts", "species",
                                "shop_presets.xml")
        base = os.path.join(root, spec_rel)
        if os.path.isfile(base) and base not in quick:
            quick.append(base)
        try:
            dlc = sorted(glob.glob(os.path.join(
                root, "dlc", "*", "basis", "scripts", "species",
                "shop_presets.xml")))
        except Exception:  # noqa: BLE001
            dlc = []
        for p in dlc:
            if p not in quick:
                quick.append(p)
        for p in quick:
            try:
                if self.is_uprising_shop(p):
                    self.find_cache[root] = (p, time.time())
                    return {"ok": True, "path": p}
            except Exception:  # noqa: BLE001
                continue
        # 3. фолбэк: полный walk для нестандартных раскладок
        cands = []
        extra = []
        for dirpath, dirnames, filenames in os.walk(root):
            for f in filenames:
                if f.lower() == "shop_presets.xml":
                    p = os.path.join(dirpath, f)
                    if p != fixed:
                        extra.append(p)
        cands.extend(sorted(extra))
        for p in cands:
            try:
                if self.is_uprising_shop(p):
                    self.find_cache[root] = (p, time.time())
                    return {"ok": True, "path": p}
            except Exception:  # noqa: BLE001
                continue
        self.find_cache[root] = ("", time.time())
        return {"ok": True, "path": ""}

    # -- species file lookup («Открыть в таблице» с карты) ---------------------
    _SPECIES_BY_CAT = {
        "squads": "squads.xml",
        "tanks": "tanks.xml",
        "cars": "cars.xml",
        "helicopters": "helicopters.xml",
        "inventory_items": "inventory_items.xml",
    }

    def species_file(self, root, cat, name):
        """Species XML holding a sysname: base file, then DLC overlays
        (first containing the name wins); fallback — the existing base
        file so the grid still opens. '' when nothing exists on disk."""
        fname = self._SPECIES_BY_CAT.get((cat or "").strip().lower(), "")
        want = (name or "").strip()
        if not fname or not root or not os.path.isdir(root):
            return {"ok": True, "path": ""}
        cands = [os.path.join(root, "basis", "scripts", "species", fname)]
        for d in self._dlc_dirs(root):
            cands.append(os.path.join(d, "basis", "scripts", "species", fname))
        try:
            ga = self._ga_root()
        except Exception:  # noqa: BLE001
            ga = ""
        if ga and os.path.isdir(ga):
            cands.append(os.path.join(ga, "basis", "scripts", "species", fname))
            for d in self._dlc_dirs(ga):
                cands.append(os.path.join(d, "basis", "scripts", "species",
                                          fname))
        gs = self._gamescripts_dir()
        if gs:
            cands.append(os.path.join(gs, "basis", "scripts", "species", fname))
            for d in self._dlc_dirs(gs):
                cands.append(os.path.join(d, "basis", "scripts", "species", fname))
        existing = [p for p in cands
                    if os.path.isfile(p)]
        if not existing:
            return {"ok": True, "path": ""}
        if want:
            for p in existing:
                try:
                    with open(p, "r", encoding="utf-8",
                              errors="replace") as fh:
                        text = fh.read()
                except OSError:
                    continue
                hit = False
                for i, m in enumerate(_SPECIES_ROW_RE.finditer(text)):
                    if i == 0:
                        continue  # header
                    mm = _SPECIES_NAME_RE.search(m.group(1))
                    if mm and mm.group(1).strip() == want:
                        hit = True
                        break
                if hit:
                    return {"ok": True, "path": p}
        return {"ok": True, "path": existing[0]}

    # -- sysname dictionaries ---------------------------------------------------------
    def scan_names(self, root: str, subpatterns, cap: int = 5000) -> set:
        """sysname (first data cell) from species XMLs by masks.
        Missing/unreadable files are not an error: skipped silently."""
        out = set()
        if not root or not os.path.isdir(root):
            return out
        paths = []
        for sp in subpatterns:
            paths.extend(glob.glob(os.path.join(root, *sp)))
        for p in paths:
            try:
                with open(p, "r", encoding="utf-8", errors="replace") as fh:
                    text = fh.read()
            except OSError:
                continue
            for i, m in enumerate(_SPECIES_ROW_RE.finditer(text)):
                if i == 0:
                    continue  # header
                mm = _SPECIES_NAME_RE.search(m.group(1))
                if mm:
                    name = (mm.group(1).strip()
                            .replace("&amp;", "&").replace("&lt;", "<")
                            .replace("&gt;", ">").replace("&quot;", '"'))
                    if name and not name.startswith("#"):
                        out.add(name)
        return out

    def read_meta(self, path, factions, costs, read_faction):
        """sysname -> {faction, cost} from one species XML. Faction only
        from the squads.xml category (whitelist, lower, 'marouders'->marauders);
        cost - first numeric cost* column of any species file."""
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            return
        rows = list(_SPECIES_ROW_RE.finditer(text))
        if not rows:
            return
        hdr = [m.group(1).strip().lower()
               for m in _SPECIES_NAME_RE.finditer(rows[0].group(1))]
        i_cat = next((i for i, h in enumerate(hdr) if h == "category"), -1)
        i_cost = next((i for i, h in enumerate(hdr)
                       if h == "cost" or h.startswith("cost_") or
                       h == "cp_cost"), -1)
        for m in rows[1:]:
            cells = [c.group(1).strip()
                     for c in _SPECIES_NAME_RE.finditer(m.group(1))]
            if not cells or not cells[0] or cells[0].startswith("#"):
                continue
            sys = cells[0]
            if read_faction and i_cat >= 0 and len(cells) > i_cat:
                f = cells[i_cat].strip().lower()
                if f == "marouders":
                    f = "marauders"
                if f in _UPR_FACTIONS:
                    factions[sys] = f
            if i_cost >= 0 and len(cells) > i_cost and sys not in costs:
                try:
                    costs[sys] = float(cells[i_cost].replace(",", "."))
                except ValueError:
                    pass

    def sysnames(self, root):
        """sysname reference of every unit/item in the project: first column
        of basis + DLC overlay species files (+ inventory). cats: split by
        category strictly from their own files - cars/squads/tanks/
        helicopters/inventory_items (for autocomplete). Bundled GameScripts
        is unioned as a fallback for names missing in the source root.
        Результат кэшируется по max mtime сканируемых файлов: повторное
        открытие карты — только stat-проверки, без чтения десятков XML."""
        scan_roots = [root] if (root and os.path.isdir(root)) else []
        try:
            ga = self._ga_root()
        except Exception:  # noqa: BLE001
            ga = ""
        if ga and all(os.path.normcase(ga) != os.path.normcase(r)
                      for r in scan_roots):
            scan_roots.append(ga)
        gs = self._gamescripts_dir()
        if gs and all(os.path.normcase(gs) != os.path.normcase(r)
                      for r in scan_roots):
            scan_roots.append(gs)
        paths = []
        for r in scan_roots:
            for pattern in (os.path.join(r, "basis", "scripts", "species", "*.xml"),
                            os.path.join(r, "dlc", "*", "basis", "scripts",
                                         "species", "*.xml")):
                paths.extend(glob.glob(pattern))
            for extra in (os.path.join(r, "basis", "scripts", "invs.xml"),
                          os.path.join(r, "basis", "scripts", "inventory_items.xml")):
                if os.path.isfile(extra):
                    paths.append(extra)
        paths = sorted(set(paths))
        mt = 0.0
        for p in paths:
            try:
                mt = max(mt, os.path.getmtime(p))
            except OSError:
                pass
        key = "|".join(os.path.normcase(p) for p in
                       ([os.path.normcase(root or "")] + paths))
        ent = self.sysn_cache.get(key)
        if ent and ent["mt"] == mt:
            return ent["res"]
        res = self._sysnames_build(paths)
        self.sysn_cache[key] = {"mt": mt, "res": res}
        if len(self.sysn_cache) > 32:
            self.sysn_cache.clear()
        return res

    def _sysnames_build(self, paths):
        """Тяжёлая половина sysnames: чтение и regex-разбор файлов.
        Чистая функция от списка путей — кэш выше решает, звать ли её."""
        out = set()
        cats = {"squads": set(), "tanks": set(), "cars": set(),
                "helicopters": set(), "inventory_items": set()}
        cat_by_file = {"squads.xml": "squads", "tanks.xml": "tanks",
                       "cars.xml": "cars", "helicopters.xml": "helicopters",
                       "inventory_items.xml": "inventory_items",
                       "invs.xml": "inventory_items"}
        for p in paths:
            try:
                with open(p, "r", encoding="utf-8", errors="replace") as fh:
                    text = fh.read()
            except OSError:
                continue
            cat = cat_by_file.get(os.path.basename(p).lower())
            for i, m in enumerate(_SPECIES_ROW_RE.finditer(text)):
                if i == 0:
                    continue  # header
                mm = _SPECIES_NAME_RE.search(m.group(1))
                if mm:
                    name = (mm.group(1).strip()
                            .replace("&amp;", "&").replace("&lt;", "<")
                            .replace("&gt;", ">").replace("&quot;", '"'))
                    if name and not name.startswith("#"):
                        out.add(name)
                        if cat:
                            cats[cat].add(name)

        return {"ok": True, "names": sorted(out),
                "cats": {k: sorted(v) for k, v in cats.items()}}

    def prices(self, root):
        """Unit/item prices (cost column) by category: {cat: {sys: cost}}.

        Плюс stats: {cat: {sys: {cost, cp_cost, supply_consumption,
        people_capacity, unit_set}}} — для попапа кампании (правка cost/
        потребления/вместимости/класса с записью в species).
        Порядок base -> DLC и setdefault — как у цен: шильдик, попап
        и запись смотрят на одну и ту же строку.
        Результат кэшируется по max mtime species-файлов: повторное
        открытие карты/кампании — только stat-проверки без парсинга."""
        files = {"squads": "squads.xml", "tanks": "tanks.xml",
                 "cars": "cars.xml", "helicopters": "helicopters.xml",
                 "inventory_items": "inventory_items.xml"}
        all_paths = []
        if root and os.path.isdir(root):
            for _fn in files.values():
                all_paths.append(os.path.join(
                    root, "basis", "scripts", "species", _fn))
                all_paths.extend(sorted(glob.glob(
                    os.path.join(root, "dlc", "*", "basis", "scripts",
                                 "species", _fn))))
        all_paths = sorted(set(all_paths))
        mt = 0.0
        for p in all_paths:
            try:
                mt = max(mt, os.path.getmtime(p))
            except OSError:
                pass
        key = os.path.normcase(root or "") + "|" + "|".join(
            os.path.normcase(p) for p in all_paths)
        ent = self.price_cache.get(key)
        if ent and ent["mt"] == mt and not self._paths_dirty(all_paths):
            return ent["res"]
        res = self._prices_build(root, files)
        self.price_cache[key] = {"mt": mt, "res": res}
        if len(self.price_cache) > 32:
            self.price_cache.clear()
        return res

    def _prices_build(self, root, files):
        """Тяжёлая половина prices: ElementTree-парсинг species-файлов.
        Чистая функция от корня — кэш выше решает, звать ли её."""
        stat_cols = ("cost", "cp_cost", "supply_consumption",
                     "people_capacity", "unit_set")
        out = {k: {} for k in files}
        stats = {k: {} for k in files}
        if root and os.path.isdir(root):
            for cat, fn in files.items():
                paths = [os.path.join(root, "basis", "scripts", "species", fn)]
                paths.extend(sorted(glob.glob(
                    os.path.join(root, "dlc", "*", "basis", "scripts", "species", fn))))
                for p in paths:
                    if not os.path.isfile(p):
                        continue
                    # через _parse_sheet (ElementTree): самозакрытые
                    # <Cell/> без Data — пустые ячейки, regex-вариант глотал
                    # их вместе со следующей ячейкой и колонки съезжали
                    # (у inventory_items cost читался пустым — без шильдика).
                    # Живая сессия первее диска: иначе undo/redo species
                    # (память без записи) не было бы видно в ценах/статах.
                    rows = self._live_sheet_rows(p) or self._parse_sheet(p)
                    if not rows:
                        continue
                    heads = rows[0]
                    try:
                        ci = next(i for i, h in heads.items()
                                  if h.strip().lower() == "cost")
                    except StopIteration:
                        ci = None
                    sidx = {}
                    for sc in stat_cols:
                        try:
                            sidx[sc] = next(
                                i for i, h in heads.items()
                                if h.strip().lower() == sc)
                        except StopIteration:
                            pass
                    if ci is None and not sidx:
                        continue
                    for cells in rows[1:]:
                        name = (cells.get(0, "") or "").strip()
                        if not name or name.startswith("#"):
                            continue
                        if ci is not None:
                            out[cat].setdefault(
                                name, (cells.get(ci, "") or "").strip())
                        if sidx:
                            st = stats[cat].setdefault(name, {})
                            for sc, si in sidx.items():
                                st.setdefault(
                                    sc, (cells.get(si, "") or "").strip())
        return {"ok": True, "prices": out, "stats": stats}

    # ЭКСПЕРИМЕНТ «слот техники» (откат: удалить метод + роут /api/unit_capacity
    # + vehDecor): пассажирские места техники (people_capacity) из species.
    def capacity(self, root):
        """{sysname: people_capacity} для cars/tanks/helicopters.xml
        (base -> DLC, первое вхождение побеждает — как у цен).
        Кэш по max mtime species-файлов, как у prices."""
        files = {"tanks": "tanks.xml", "cars": "cars.xml",
                 "helicopters": "helicopters.xml"}
        all_paths = []
        if root and os.path.isdir(root):
            for _fn in files.values():
                all_paths.append(os.path.join(
                    root, "basis", "scripts", "species", _fn))
                all_paths.extend(sorted(glob.glob(
                    os.path.join(root, "dlc", "*", "basis", "scripts",
                                 "species", _fn))))
        all_paths = sorted(set(all_paths))
        mt = 0.0
        for p in all_paths:
            try:
                mt = max(mt, os.path.getmtime(p))
            except OSError:
                pass
        key = os.path.normcase(root or "") + "|" + "|".join(
            os.path.normcase(p) for p in all_paths)
        ent = self.cap_cache.get(key)
        if ent and ent["mt"] == mt and not self._paths_dirty(all_paths):
            return ent["res"]
        res = self._capacity_build(root, files)
        self.cap_cache[key] = {"mt": mt, "res": res}
        if len(self.cap_cache) > 32:
            self.cap_cache.clear()
        return res

    def _capacity_build(self, root, files):
        """Тяжёлая половина capacity: ElementTree через _parse_sheet.
        Чистая функция от корня — кэш выше решает, звать ли её."""
        out = {}
        if root and os.path.isdir(root):
            for cat, fn in files.items():
                paths = [os.path.join(root, "basis", "scripts", "species", fn)]
                paths.extend(sorted(glob.glob(
                    os.path.join(root, "dlc", "*", "basis", "scripts", "species", fn))))
                for p in paths:
                    if not os.path.isfile(p):
                        continue
                    # живая сессия первее диска (см. _prices_build)
                    rows = self._live_sheet_rows(p) or self._parse_sheet(p)
                    if not rows:
                        continue
                    heads = rows[0]
                    try:
                        ci = next(i for i, h in heads.items()
                                  if h.strip().lower() == "people_capacity")
                    except StopIteration:
                        continue
                    for cells in rows[1:]:
                        name = (cells.get(0, "") or "").strip()
                        if not name or name.startswith("#"):
                            continue
                        try:
                            cap = int(float((cells.get(ci, "") or "").strip() or 0))
                        except (TypeError, ValueError):
                            continue
                        out.setdefault(name, cap)
        return {"ok": True, "capacity": out}

    # ЭКСПЕРИМЕНТ «слот пехоты» (откат: удалить метод + роут /api/squad_size):
    # размер отряда (members) из squads.xml — шильдик N/N слева внизу.
    def squad_size(self, root):
        """{sysname: members-total} для squads.xml. Форматы members:
        'Lgn_wolf:4' -> 4; 'A, B, C' -> 3; 'A:2, C' -> 3.
        Кэш по max mtime, как у capacity (ключи — по путям, коллизий нет)."""
        files = {"squads": "squads.xml"}
        all_paths = []
        if root and os.path.isdir(root):
            for _fn in files.values():
                all_paths.append(os.path.join(
                    root, "basis", "scripts", "species", _fn))
                all_paths.extend(sorted(glob.glob(
                    os.path.join(root, "dlc", "*", "basis", "scripts",
                                 "species", _fn))))
        all_paths = sorted(set(all_paths))
        mt = 0.0
        for p in all_paths:
            try:
                mt = max(mt, os.path.getmtime(p))
            except OSError:
                pass
        key = os.path.normcase(root or "") + "|" + "|".join(
            os.path.normcase(p) for p in all_paths)
        ent = self.cap_cache.get(key)
        if ent and ent["mt"] == mt:
            return ent["res"]
        res = self._squad_size_build(root, files)
        self.cap_cache[key] = {"mt": mt, "res": res}
        if len(self.cap_cache) > 32:
            self.cap_cache.clear()
        return res

    def _squad_size_build(self, root, files):
        """Тяжёлая половина squad_size: ElementTree через _parse_sheet."""
        import re as _re
        out = {}
        if root and os.path.isdir(root):
            for cat, fn in files.items():
                paths = [os.path.join(root, "basis", "scripts", "species", fn)]
                paths.extend(sorted(glob.glob(
                    os.path.join(root, "dlc", "*", "basis", "scripts", "species", fn))))
                for p in paths:
                    if not os.path.isfile(p):
                        continue
                    rows = self._parse_sheet(p)
                    if not rows:
                        continue
                    heads = rows[0]
                    try:
                        ci = next(i for i, h in heads.items()
                                  if h.strip().lower() == "members")
                    except StopIteration:
                        continue
                    for cells in rows[1:]:
                        name = (cells.get(0, "") or "").strip()
                        if not name or name.startswith("#"):
                            continue
                        total = 0
                        for part in str(cells.get(ci, "") or "").split(","):
                            part = part.strip()
                            if not part:
                                continue
                            m = _re.match(r"^(.*\S)\s*:(\d+)$", part)
                            total += int(m.group(2)) if m else 1
                        out.setdefault(name, total)
        return {"ok": True, "squad": out}

    def unit_meta(self, project_root, unpacked):
        """Unit metadata for the Uprising randomizer: faction (squads.xml
        only, category column, _UPR_FACTIONS whitelist; the rest have no
        faction) and cost (cost from cars/tanks/squads/helicopters).
        Sources - open project AND/OR unpacked game, like swt_sources."""
        factions, costs = {}, {}
        try:
            roots = []
            for r in (project_root, unpacked):
                if r and os.path.isdir(r) and r not in roots:
                    roots.append(r)
            try:
                ga = self._ga_root()
            except Exception:  # noqa: BLE001
                ga = ""
            if ga and os.path.isdir(ga) and ga not in roots:
                roots.append(ga)
            for root in roots:
                sp = lambda *p: os.path.join(  # noqa: E731
                    root, "basis", "scripts", "species", *p)
                dlc = lambda *p: sorted(glob.glob(  # noqa: E731
                    os.path.join(root, "dlc", "*", "basis", "scripts",
                                 "species", *p)))
                for fname in ("squads.xml",):
                    for p in [sp(fname)] + dlc(fname):
                        self.read_meta(p, factions, costs, True)
                for fname in ("cars.xml", "tanks.xml", "helicopters.xml"):
                    for p in [sp(fname)] + dlc(fname):
                        self.read_meta(p, factions, costs, False)
        except Exception:  # noqa: BLE001 - meta must not break the editor
            pass
        return {"ok": True, "factions": factions, "costs": costs}

    def _swt_scope(self, swt_path):
        """Скоп редактируемого .swt: имя DLC-оверлея, если путь идёт через
        папку dlc/<name>/, иначе '' (файлы базовой игры)."""
        try:
            parts = re.split(r"[\\/]+", str(swt_path or ""))
        except Exception:  # noqa: BLE001
            return ""
        for i, p in enumerate(parts):
            if p.lower() == "dlc" and i + 1 < len(parts) and parts[i + 1]:
                return parts[i + 1]
        return ""

    def swt_sources(self, project_root, unpacked, swt_path=""):
        """Value dictionaries for SWT editor dropdown hints: unit sysnames
        (merged AND per type: cars/tanks/squads/heli separately), crew,
        upgrade presets (car/tank/squad/heli separately), items, shop
        presets from the open project AND/OR unpacked game species files.
        Scope: an edited DLC .swt sees ONLY its own DLC overlay (a unit
        added to base files is not suggested there until added to the
        DLC); a base .swt sees base files only. Neither available -
        empty lists, the editor just stays text-input (fallback
        without errors)."""
        units, crew, upgrades, items, presets = set(), set(), set(), set(), set()
        units_car, units_tank = set(), set()
        units_squad, units_heli = set(), set()
        car_presets, tank_presets = set(), set()
        squad_presets, heli_presets = set(), set()
        dlc = self._swt_scope(swt_path)
        try:
            roots = []
            for r in (project_root, unpacked):
                if r and os.path.isdir(r) and r not in roots:
                    roots.append(r)
            try:
                ga = self._ga_root()
            except Exception:  # noqa: BLE001
                ga = ""
            if ga and os.path.isdir(ga) and ga not in roots:
                roots.append(ga)
            for root in roots:
                if dlc:
                    # только оверлей редактируемого DLC (имя папки - без
                    # учёта регистра: Resistance ~= resistance); нет такой
                    # папки в корне - корень ничего не даёт
                    try:
                        names = [d for d in os.listdir(os.path.join(root, "dlc"))
                                 if d.lower() == dlc.lower()]
                    except OSError:
                        continue
                    if not names:
                        continue
                    bases = [("dlc", d, "basis") for d in names]
                else:
                    bases = [("basis",)]
                for b in bases:
                    sp = b + ("scripts", "species")
                    # юниты: общий словарь + строго по типам (cars.xml и т.д.)
                    for key, n in (("car", "cars.xml"),
                                   ("tank", "tanks.xml"),
                                   ("squad", "squads.xml"),
                                   ("heli", "helicopters.xml")):
                        found = self.scan_names(root, [sp + (n,)])
                        units |= found
                        if key == "car":
                            units_car |= found
                        elif key == "tank":
                            units_tank |= found
                        elif key == "squad":
                            units_squad |= found
                        else:
                            units_heli |= found
                    crew |= self.scan_names(root, [sp + ("humans.xml",)])
                    upgrades |= self.scan_names(root, [sp + ("*_upgrades.xml",)])
                    # upgrade presets: preset name depends on the unit type
                    # (car/tank/squad/helicopter) - scan each file separately
                    for key, fname in (("car", "car_upgrade_presets.xml"),
                                       ("tank", "tank_upgrade_presets.xml"),
                                       ("squad", "squad_upgrade_presets.xml"),
                                       ("heli", "heli_upgrade_presets.xml")):
                        names = self.scan_names(root, [sp + (fname,)])
                        if key == "car":
                            car_presets |= names
                        elif key == "tank":
                            tank_presets |= names
                        elif key == "squad":
                            squad_presets |= names
                        else:
                            heli_presets |= names
                    items |= self.scan_names(root, [
                        b + ("scripts", "inventory_items.xml")])
                    presets |= self.scan_names(root, [sp + ("shop_presets.xml",)])
        except Exception:  # noqa: BLE001 - dicts must not break the editor
            pass
        cap = lambda s: sorted(s)[:5000]  # noqa: E731
        return {"ok": True,
                "units": cap(units), "crew": cap(crew),
                "units_car": cap(units_car), "units_tank": cap(units_tank),
                "units_squad": cap(units_squad), "units_heli": cap(units_heli),
                "upgrades": cap(upgrades), "items": cap(items),
                "presets": cap(presets),
                "car_presets": cap(car_presets),
                "tank_presets": cap(tank_presets),
                "squad_presets": cap(squad_presets),
                "heli_presets": cap(heli_presets),
                "teams": list(_SWT_TEAMS),
                "scope_label": ("DLC " + dlc) if dlc else "base"}
