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
_SS_NS = "urn:schemas-microsoft-com:office:spreadsheet"
_ICON_FILES = ["tanks.xml", "cars.xml", "helicopters.xml",
               "squads.xml", "inventory_items.xml"]
_PRESET_FILES = ["squad_upgrade_presets.xml", "tank_upgrade_presets.xml",
                 "car_upgrade_presets.xml", "heli_upgrade_presets.xml"]
_CFG_CATS = ["squads", "tanks", "cars", "helicopters", "inventory_items"]
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


# -- uprising -----------------------------------------------------------------
class Uprising:
    """Species parsing, unit icons, balance configs and SWT dictionaries.

    Icon binding comes from the source-root species files:
      tanks/cars/helicopters.xml -> tech_pic (vehicles_icons_small\\name)
      squads.xml -> hover_image_player (infantry_icons_small\\name)
      inventory_items.xml -> icon (ui/pictures/inventory/name.dds)
    Upgrade presets (*_upgrade_presets.xml) point at a base unit
    (squad_sysname/unit_sysname) and inherit its icon.
    Icon files resolve: app assets -> source root (basis\\textures\\...)
    -> unpacked game -> DLC overlays. .dds converts to .png on the fly
    (Pillow) with a disk cache.
    """

    def __init__(self, store, config, entities, log, base_dir, app_dir):
        self._store = store
        self._config = config
        self._entities = entities
        self._log = log
        self._base = base_dir   # assets root (frozen: _MEIPASS, else repo)
        self._app_dir = app_dir  # folder with app.py (dev fallback)
        self.icon_dir = os.path.join(app_dir, "assets", "UprisingMap Editor")
        # release: full assets/ next to the EXE wins over the bundled one
        self.icon_dir_ext = os.path.join(config.dir, "assets",
                                         "UprisingMap Editor")
        if not os.path.isdir(self.icon_dir_ext):
            self.icon_dir_ext = os.path.join(os.path.dirname(config.dir),
                                             "assets", "UprisingMap Editor")
        self.png_cache = os.path.join(tempfile.gettempdir(), "tsh_upr_icons")
        self.webp_buckets = {
            "vehicles": os.path.join(self.icon_dir, "UnitIcons", "tech_pic",
                                     "vehicles_icons_small"),
            "infantry": os.path.join(self.icon_dir, "UnitIcons", "tech_pic",
                                     "infantry_icons_small"),
            "inventory": os.path.join(self.icon_dir, "inventory"),
        }
        self.webp_idx = {"mt": 0.0, "map": {}}  # stem.lower() -> (bucket, file)
        self.icon_cache = {}  # layers-key -> {"mt": float, "map": {...}}
        self.dlc_cache = {}   # root -> (dlc dir mtime, [dlc dirs])
        self.icon_lock = threading.Lock()  # one map rebuild per root
        self.conv_mem = {}    # (src.lower(), mtime) -> png; skips re-stat
        self.data_mem = {"mt": 0.0, "map": {}}  # bucket/file -> data-URL
        self.shields_mem = {"mt": -1.0, "map": {}}  # key -> data-URL
        self.placeholder = os.path.join(self.png_cache, "_placeholder.png")

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

    def _species_paths(self, root):
        """((name, path) base) + {name: [DLC overlay paths]} species files."""
        sp = os.path.join(root, "basis", "scripts", "species")
        base = []
        for fname in _ICON_FILES:
            p = os.path.join(sp, fname)
            if os.path.isfile(p):
                base.append((fname, p))
        overlay = {}
        for d in self._dlc_dirs(root):
            dsp = os.path.join(d, "basis", "scripts", "species")
            for fname in _ICON_FILES + _PRESET_FILES:
                p = os.path.join(dsp, fname)
                if os.path.isfile(p):
                    overlay.setdefault(fname, []).append(p)
        return base, overlay

    def _layer_roots(self, root):
        """Data lookup layers in order: unpacked game -> project -> mod.
        The game is the source of truth; project and mod fill the gaps
        (e.g. icons of a loaded mod). Ready-made app webp assets come
        even earlier, see icon_webp."""
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
        layers = []
        for cand in (game, proj, mod, os.path.normpath(root or "")):
            if not cand or not os.path.isdir(cand):
                continue
            p = os.path.normpath(cand)
            key = os.path.normcase(p)
            if all(os.path.normcase(x) != key for x in layers):
                layers.append(p)
        return layers

    def icon_map(self, root):
        """{sysname: (texture-relative icon path, kind: unit|item)} from
        species + upgrade presets. Layers game -> project -> mod: first wins
        (game is the source of truth, then additions). Cached over all
        layers, invalidated by file mtimes."""
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
            amap = {}
            for lay, base, overlay in per_layer:
                sub = self._icon_map_build(lay, base, overlay)
                for k, v in sub.items():
                    amap.setdefault(k, v)
            self.icon_cache[key] = {"mt": mt, "map": amap}
            return amap

    def _icon_map_build(self, root, base, overlay):
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

        return amap

    @staticmethod
    def _icon_variants(p):
        """File name variants: exact, then png/dds/tga extension swaps."""
        b, e = os.path.splitext(p)
        out = [p]
        for x in (".png", ".dds", ".tga"):
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

    def icon_file(self, root, rel, kind):
        """First existing icon file: app assets -> layers game -> project
        -> mod (each with its own DLC overlays). When the exact name is
        found nowhere (mod points at a missing texture), take a sibling
        icon of the same family from the same folder."""
        rel = (rel or "").replace("\\", "/").strip("/\\")
        if not rel:
            return ""
        base = os.path.basename(rel)
        rp = rel.replace("/", os.sep)
        cands = []
        for _idir in (self.icon_dir_ext, self.icon_dir):
            if kind == "item":
                # items live in assets as a flat file-name list
                inv = os.path.join(_idir, "inventory")
                cands += [os.path.join(inv, base), os.path.join(inv, rp)]
            else:
                unit = os.path.join(_idir, "UnitIcons")
                cands += [os.path.join(unit, rp),
                          os.path.join(unit, "tech_pic", rp)]
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
        Rebuilt on folder mtimes; *_preselected/*_selected are fallback
        only, when no base icon exists. No dds search or conversion."""
        try:
            mt = 0.0
            for bucket in list(self.webp_buckets.keys()):
                for _d in dict.fromkeys((self.webp_buckets.get(bucket, ""),
                                         self.webp_bucket_dir(bucket))):
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
        for _pass in (0, 1):
            for bucket in list(self.webp_buckets.keys()):
                # bundled first, external override (same order as serving)
                for _d in dict.fromkeys((self.webp_buckets.get(bucket, ""),
                                         self.webp_bucket_dir(bucket))):
                    if not _d:
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
        return idx

    @staticmethod
    def webp_asset_url(bucket, fn):
        from urllib.parse import quote as _q
        return "/assets/upr-webp/%s/%s" % (bucket, _q(fn))

    def icon_webp(self, root, name):
        """Ready-made webp icon for a sysname -> (bucket, file) | None.
        Direct name -> preset->base (via the species map) -> icon file
        name from species. No dds search."""
        idx = self.webp_index()
        key = (name or "").strip()
        if not key:
            return None
        hit = idx.get(key.lower())
        if not hit:
            try:
                ent = self.icon_map(root).get(key)
            except Exception:  # noqa: BLE001
                ent = None
            if ent:
                rel = (ent[0] or "").replace("\\", "/")
                stem = os.path.splitext(os.path.basename(rel))[0].lower()
                hit = idx.get(stem)
        return hit

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

    # category stubs for map chips (served as-is, no conversion)
    _UPR_PLACEHOLDERS = {
        "cars": ("vehicles", "placeholder_vehicle.webp"),
        "tanks": ("vehicles", "placeholder_vehicle.webp"),
        "helicopters": ("vehicles", "placeholder_vehicle.webp"),
        "squads": ("infantry", "placeholder.webp"),
        "inventory_items": ("inventory", "upgrd_placeholder.webp"),
    }

    def category_placeholder(self, cat):
        """Ready-made webp stub for a map category (as the frontend sends
        it), or ''. External assets next to the EXE win over bundled."""
        ent = self._UPR_PLACEHOLDERS.get((cat or "").strip().lower())
        if not ent:
            return ""
        bucket, fn = ent
        for _d in dict.fromkeys((self.webp_bucket_dir(bucket),
                                 self.webp_buckets.get(bucket, ""))):
            if not _d:
                continue
            p = os.path.join(_d, fn)
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

    def data_url(self, bucket, fn):
        """Ready-made webp as an in-memory data-URL (mtime-keyed cache)."""
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
            path = os.path.join(self.webp_bucket_dir(bucket), fn)
            try:
                if not os.path.isfile(path):
                    path = os.path.join(self.webp_buckets[bucket], fn)
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
                roots.append(os.path.join(r, "assets", "uprising", "shields"))
        roots.append(os.path.join(self._base, "assets", "uprising", "shields"))
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
            for cand in (self.unpacked_root(),
                         self._store.normal(self._config.get("mod_path") or "") or ""):
                try:
                    if cand and os.path.isdir(cand):
                        self.icon_map(cand)
                except Exception:  # noqa: BLE001
                    pass
            try:
                with open(os.path.join(self._base, "assets", "UprisingMap Editor",
                                       "global_map", "converted",
                                       "map.webp"), "rb") as f:
                    f.read()
            except OSError:
                pass
            self._log.info("upr warmup done in %.2fs", time.time() - t0)
        except Exception as e:  # noqa: BLE001
            self._log.warning("upr warmup failed: %s", e)

    def start_warmup(self):
        threading.Thread(target=self.warmup, daemon=True,
                         name="upr-warm").start()

    # -- icon operations (response payloads) ------------------------------------
    def icon_preload(self, root, names):
        """Warm up: convert/find icons in a batch (parallel) so the first
        <img> on the panel don't wait for one-by-one conversion."""
        names = [str(n) for n in (names or []) if str(n).strip()][:600]
        if not names:
            return {"ok": True, "missing": []}
        amap = self.icon_map(root)

        def warm(name):
            ent = amap.get(name)
            if not ent:
                return name
            icon_rel, kind = ent
            p = self.icon_file(root, icon_rel, kind)
            if not p:
                return name
            if p.lower().endswith(".dds"):
                return name if not self.dds_png(p) else None
            return None

        missing = []
        with ThreadPoolExecutor(max_workers=8) as ex:
            for res in ex.map(warm, names):
                if res:
                    missing.append(res)
        return {"ok": True, "missing": missing}

    def icon_urls(self, root, names):
        """sysname -> ready-made webp URL in one request. The frontend sets
        direct <img>: zero dds conversion and sprite assembly, then the
        browser cache does the work."""
        names = sorted({str(n).strip() for n in (names or [])
                        if str(n).strip()})[:800]
        icons = {}
        for n in names:
            hit = self.icon_webp(root, n)
            icons[n] = self.webp_asset_url(*hit) if hit else ""
        return {"ok": True, "icons": icons}

    def icons_data(self, root, names):
        """All icons in one request: {name: data:image/webp;base64,...}.
        The server speaks HTTP/1.0 without keep-alive - hundreds of separate
        <img> cost seconds of per-connection overhead (~5ms each); one
        response removes it: the frontend sets data-URLs, all from memory."""
        names = sorted({str(n).strip() for n in (names or [])
                        if str(n).strip()})[:1200]
        out = {}
        for n in names:
            hit = self.icon_webp(root, n)
            out[n] = self.data_url(*hit) if hit else ""
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
        """Built-in (next to exe + _MEIPASS + sources) and custom presets."""
        builtin = []
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

    # -- map backup / reset ---------------------------------------------------------
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
            if os.path.isfile(leg) and os.path.getsize(leg) > 100:
                try:
                    os.makedirs(primary, exist_ok=True)
                    shutil.copy2(leg, os.path.join(primary, "shop_presets.xml"))
                except OSError:
                    pass
        return primary

    def reset_map(self, root, path, cfg_path, ensure_only):
        """ensure_only: snapshot a clean map copy on first open from a root.
        Otherwise - reset: restore shop_presets.xml from the clean copy and
        delete the balance config. The copy predates the first edits, so
        rollback always lands on the pristine state."""
        if not path or not os.path.isfile(path):
            return {"ok": False, "error": "no file"}
        bpath = os.path.join(self.backup_dir(root), "shop_presets.xml")
        restored = False
        if not os.path.isfile(bpath):
            os.makedirs(os.path.dirname(bpath), exist_ok=True)
            shutil.copy2(path, bpath)
        elif not ensure_only:
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

    def find_shop(self, root):
        """Locate the Resistance DLC shop_presets.xml: mod project or the
        unpacked game (whichever root the frontend passed)."""
        if not root or not os.path.isdir(root):
            return {"ok": True, "path": ""}
        p = os.path.join(root, *_UPRISING_REL.split(os.sep))
        if os.path.isfile(p):
            return {"ok": True, "path": p}
        # tree fallback: unpacked-game layout may differ; prefer the
        # dlc/resistance variant, else the first one found
        best = ""
        for dirpath, dirnames, filenames in os.walk(root):
            if "shop_presets.xml" in (f.lower() for f in filenames):
                cand = os.path.join(dirpath, "shop_presets.xml")
                if "resistance" in dirpath.lower():
                    best = cand
                    break
                if not best:
                    best = cand
        return {"ok": True, "path": best}

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
        helicopters/inventory_items (for autocomplete)."""
        out = set()
        cats = {"squads": set(), "tanks": set(), "cars": set(),
                "helicopters": set(), "inventory_items": set()}
        cat_by_file = {"squads.xml": "squads", "tanks.xml": "tanks",
                       "cars.xml": "cars", "helicopters.xml": "helicopters",
                       "inventory_items.xml": "inventory_items",
                       "invs.xml": "inventory_items"}
        if root and os.path.isdir(root):
            paths = []
            for pattern in (os.path.join(root, "basis", "scripts", "species", "*.xml"),
                            os.path.join(root, "dlc", "*", "basis", "scripts",
                                         "species", "*.xml")):
                paths.extend(glob.glob(pattern))
            for extra in (os.path.join(root, "basis", "scripts", "invs.xml"),
                          os.path.join(root, "basis", "scripts", "inventory_items.xml")):
                if os.path.isfile(extra):
                    paths.append(extra)
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
        """Unit/item prices (cost column) by category: {cat: {sys: cost}}."""
        files = {"squads": "squads.xml", "tanks": "tanks.xml",
                 "cars": "cars.xml", "helicopters": "helicopters.xml",
                 "inventory_items": "inventory_items.xml"}
        out = {k: {} for k in files}
        if root and os.path.isdir(root):
            for cat, fn in files.items():
                paths = [os.path.join(root, "basis", "scripts", "species", fn)]
                paths.extend(sorted(glob.glob(
                    os.path.join(root, "dlc", "*", "basis", "scripts", "species", fn))))
                for p in paths:
                    if not os.path.isfile(p):
                        continue
                    try:
                        with open(p, "r", encoding="utf-8", errors="replace") as fh:
                            text = fh.read()
                    except OSError:
                        continue
                    rows = list(_SPECIES_ROW_RE.finditer(text))
                    if not rows:
                        continue
                    heads = _SPECIES_NAME_RE.findall(rows[0].group(1))
                    try:
                        ci = [h.strip().lower() for h in heads].index("cost")
                    except ValueError:
                        continue
                    for m in rows[1:]:
                        # cells with an ss:Index shift - positional parse
                        cells = {}
                        idx = 0
                        for cm in re.finditer(r"<Cell([^>]*)>(.*?)</Cell>",
                                              m.group(1), re.S):
                            im = re.search(r'ss:Index="(\d+)"', cm.group(1))
                            if im:
                                idx = int(im.group(1)) - 1
                            dm = re.search(r"<Data[^>]*>(.*?)</Data>",
                                           cm.group(2), re.S)
                            cells[idx] = dm.group(1).strip() if dm else ""
                            idx += 1
                        name = cells.get(0, "")
                        if not name or name.startswith("#"):
                            continue
                        out[cat].setdefault(name, cells.get(ci, ""))
        return {"ok": True, "prices": out}

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

    def swt_sources(self, project_root, unpacked):
        """Value dictionaries for SWT editor dropdown hints: unit sysnames,
        crew, upgrade presets (car/tank/squad/heli separately), items, shop
        presets from the open project AND/OR unpacked game species files.
        Neither available - empty lists, the editor just stays text-input
        (fallback without errors)."""
        units, crew, upgrades, items, presets = set(), set(), set(), set(), set()
        car_presets, tank_presets = set(), set()
        squad_presets, heli_presets = set(), set()
        try:
            roots = []
            for r in (project_root, unpacked):
                if r and os.path.isdir(r) and r not in roots:
                    roots.append(r)
            for root in roots:
                sp_dir = ("basis", "scripts", "species")
                sp_dlc = ("dlc", "*", "basis", "scripts", "species")
                for n in ("cars.xml", "tanks.xml", "squads.xml", "helicopters.xml"):
                    units |= self.scan_names(root, [sp_dir + (n,), sp_dlc + (n,)])
                crew |= self.scan_names(root, [sp_dir + ("humans.xml",),
                                               sp_dlc + ("humans.xml",)])
                upgrades |= self.scan_names(root, [sp_dir + ("*_upgrades.xml",),
                                                   sp_dlc + ("*_upgrades.xml",)])
                # upgrade presets: preset name depends on the unit type
                # (car/tank/squad/helicopter) - scan each file separately
                for key, fname in (("car", "car_upgrade_presets.xml"),
                                   ("tank", "tank_upgrade_presets.xml"),
                                   ("squad", "squad_upgrade_presets.xml"),
                                   ("heli", "heli_upgrade_presets.xml")):
                    names = self.scan_names(root, [sp_dir + (fname,),
                                                   sp_dlc + (fname,)])
                    if key == "car":
                        car_presets |= names
                    elif key == "tank":
                        tank_presets |= names
                    elif key == "squad":
                        squad_presets |= names
                    else:
                        heli_presets |= names
                items |= self.scan_names(root, [
                    ("basis", "scripts", "inventory_items.xml"),
                    ("dlc", "*", "basis", "scripts", "inventory_items.xml")])
                presets |= self.scan_names(root, [sp_dir + ("shop_presets.xml",),
                                                  sp_dlc + ("shop_presets.xml",)])
        except Exception:  # noqa: BLE001 - dicts must not break the editor
            pass
        cap = lambda s: sorted(s)[:5000]  # noqa: E731
        return {"ok": True,
                "units": cap(units), "crew": cap(crew),
                "upgrades": cap(upgrades), "items": cap(items),
                "presets": cap(presets),
                "car_presets": cap(car_presets),
                "tank_presets": cap(tank_presets),
                "squad_presets": cap(squad_presets),
                "heli_presets": cap(heli_presets),
                "teams": list(_SWT_TEAMS)}
