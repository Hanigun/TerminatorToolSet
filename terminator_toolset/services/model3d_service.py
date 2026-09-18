"""3D-превью .model: поиск файла, запекание в JSON для three.js.

Мировые матрицы — строго как в Blender-плагине (коммит 0eb57e4):
row-vector конвенция файла (перенос в последней строке матрицы),
W = L @ P через skeleton.compose_world_matrices + resolve_node_parents.
Вершины запекаются как v_world = v_local @ W (перенос из элементов
12,13,14) — column-применение с переносом из 3,7,11 роняло перенос
и складывало части в одну точку под моделью.
Родитель меша при extras-интерливе (пехота) — parent // 2, как
в импорте плагина; скиннинг не трогаем (bind-pose уже собран).
Игровые координаты (X вперёд, Y влево, Z вверх) переводятся в
систему three.js (X вправо, Y вверх, Z на камеру): (-y, z, -x).
UV переворачиваем так же, как импорт в Blender (flip_uv).
Модуль самодостаточен: варианты башен и стороны брони берутся
из шиппящихся пресетов model3d/presets/*.json (сгенерированы
scripts/gen_preview_presets.py из species-XML один раз) —
рантайм никаких XML не читает. Нет записи в пресете —
эвристика по имени файла (без XML).
"""
from __future__ import annotations

import fnmatch
import glob
import json
import os
import time

from terminator_toolset.model3d import read_model
from terminator_toolset.model3d.binary_io import BinaryIOError
from terminator_toolset.model3d.coord_space import flip_uv
from terminator_toolset.model3d.material_format import MaterialError, read_material
from terminator_toolset.model3d.mount_points import (
    find_host_mounts, find_module_root, find_module_roots)
from terminator_toolset.model3d.part_groups import (
    classify_armor_detail, classify_detailed)
from terminator_toolset.model3d.skeleton import (
    compose_world_matrices, resolve_node_parents)
from terminator_toolset.domain.modroots import (
    layer_bases_union as _overlay_bases)

ROOT_PARENT = 0xFFFFFFFF

_IDENT = (1.0, 0.0, 0.0, 0.0,
          0.0, 1.0, 0.0, 0.0,
          0.0, 0.0, 1.0, 0.0,
          0.0, 0.0, 0.0, 1.0)

# Кэш разобранных моделей: ключ (путь, размер, mtime) — повторное
# открытие превью мгновенное, парсинг заново не нужен.
_MODEL_CACHE = {}
_MODEL_CACHE_MAX = 8

_PRESETS_DIR = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "model3d",
    "presets"))
_PRESETS = {}


def _preset(name):
    """Шиппящийся пресет {name}.json (кэш в памяти, {} при отсутствии)."""
    if name not in _PRESETS:
        try:
            with open(os.path.join(_PRESETS_DIR, name + ".json"),
                      "r", encoding="utf-8") as f:
                _PRESETS[name] = json.load(f)
        except (OSError, ValueError):
            _PRESETS[name] = {}
    return _PRESETS[name]


def safe_rel(value):
    """Чистка сырого пути из колонки mesh: без .. и повторов слэшей."""
    v = str(value or "").replace("\\", "/").strip()
    parts = [p for p in v.split("/") if p not in ("", ".", "..")]
    return "/".join(parts)


def layer_bases(root, overlay=()):
    """Корни слоёв данных: basis первым, затем DLC-оверлеи.

    overlay — саб-пути мода (строка или список): их basis-слои
    идут следом, файлы мода побеждают (symlink-like union, domain/modroots).
    """
    bases = []
    try:
        b = os.path.join(root or "", "basis")
        if b and os.path.isdir(b):
            bases.append(b)
        dlc = sorted(glob.glob(os.path.join(root or "", "dlc", "*", "basis")))
        for d in dlc:
            if os.path.isdir(d):
                bases.append(d)
    except Exception:  # noqa: BLE001
        pass
    try:
        ovs = [overlay] if isinstance(overlay, str) else list(overlay or [])
        for ov in ovs:
            for b in _overlay_bases("", ov or ""):
                if b not in bases:
                    bases.append(b)
    except Exception:  # noqa: BLE001
        pass
    return bases


def _same_root(a, b):
    """Один и тот же корень (без дубля поиска)."""
    try:
        return os.path.normcase(os.path.normpath(a or "")) == \
            os.path.normcase(os.path.normpath(b or "")) and bool(a)
    except Exception:  # noqa: BLE001
        return False


def find_file(root, rel, fallback="", overlay=()):
    """Первый существующий файл rel по слоям, иначе ''.

    Мод — оверлей поверх базовой игры: чего нет в root, ищем
    в fallback (распакованная база). Свои файлы мода — первые.
    overlay — саб-пути мода (ассеты, модели): их слои между root
    и fallback, все корни видны как одно целое.
    """
    rel = safe_rel(rel)
    if not rel or not root:
        return ""
    for base in layer_bases(root, overlay):
        p = os.path.normpath(os.path.join(base, *rel.split("/")))
        # Не выходим за пределы слоя, только файлы
        try:
            ok = os.path.isfile(p) and os.path.normcase(p).startswith(
                os.path.normcase(base) + os.sep)
        except Exception:  # noqa: BLE001
            ok = False
        if ok:
            return p
    if fallback and not _same_root(fallback, root):
        for base in layer_bases(fallback):
            p = os.path.normpath(os.path.join(base, *rel.split("/")))
            try:
                ok = os.path.isfile(p) and os.path.normcase(p).startswith(
                    os.path.normcase(base) + os.sep)
            except Exception:  # noqa: BLE001
                ok = False
            if ok:
                return p
    return ""


def _base_fallback(upr, root):
    """База для оверлея: распакованная игра, если root — не она."""
    try:
        base = upr.unpacked_root() if upr is not None else ""
    except Exception:  # noqa: BLE001
        base = ""
    if not base or _same_root(base, root):
        return ""
    return base


def overlays_for(upr, root):
    """Саб-пути мода для поиска: (assets, models), пустые выкинуты.

    Отдаём, только если root — корень мода из конфига; чужие корни
    (проект, игра) саб-пути не затрагивают. mod_overlay_path —
    старое имя пути ассетов, подхватывается для совместимости."""
    try:
        cfg = getattr(upr, "_config", None)
        store = getattr(upr, "_store", None)
        if cfg is None:
            return ()
        mod = cfg.get("mod_path") or ""
        assets = cfg.get("mod_assets_path") or cfg.get("mod_overlay_path") or ""
        models = cfg.get("mod_models_path") or ""

        def _norm(v):
            try:
                v = store.normal(v) if store is not None else v
            except Exception:  # noqa: BLE001
                pass
            return v or ""
        mod, assets, models = _norm(mod), _norm(assets), _norm(models)
        if not _same_root(mod, root):
            return ()
        out = []
        for cand in (assets, models):
            try:
                if cand and os.path.isdir(cand) and \
                        not _same_root(cand, root) and \
                        os.path.normpath(cand) not in out:
                    out.append(os.path.normpath(cand))
            except Exception:  # noqa: BLE001
                continue
        return tuple(out)
    except Exception:  # noqa: BLE001
        return ()


def _file_key(path):
    try:
        st = os.stat(path)
        return (os.path.abspath(path), st.st_size, st.st_mtime_ns)
    except OSError:
        return None


def _model_worlds(model):
    """Мировые матрицы узлов по-плагинному (W = L @ P, row-vector)."""
    has_extras = bool(model.nods_extras)
    try:
        resolved, _ = resolve_node_parents(model.nodes, has_extras)
    except Exception:  # noqa: BLE001
        resolved = None
    try:
        worlds, _ = compose_world_matrices(model.nodes, resolved)
    except Exception:  # noqa: BLE001
        worlds = [tuple(n.matrix) for n in model.nodes]
    return worlds, has_extras


def _cached_model(path):
    """Разобранная модель + мировые матрицы из кэша (или парсинг)."""
    key = _file_key(path)
    if key is not None and key in _MODEL_CACHE:
        ent = _MODEL_CACHE.pop(key)
        _MODEL_CACHE[key] = ent
        return ent
    model = read_model(path)
    worlds, has_extras = _model_worlds(model)
    ent = {"model": model, "worlds": worlds, "has_extras": has_extras,
           "baked": None}
    if key is not None:
        _MODEL_CACHE[key] = ent
        while len(_MODEL_CACHE) > _MODEL_CACHE_MAX:
            _MODEL_CACHE.pop(next(iter(_MODEL_CACHE)))
    return ent


def mesh_target_index(model, has_extras, parent):
    """Узел-подвес меша, как в импорте плагина (extras: parent // 2)."""
    try:
        p = int(parent)
    except (TypeError, ValueError):
        return None
    if p == ROOT_PARENT:
        return None
    n = len(model.nodes or [])
    if has_extras:
        t = p // 2
        return t if 0 <= t < n else None
    return p if 0 <= p < n else None


def _apply_point_row(world, v):
    """v_local @ W (row-vector, перенос из 12,13,14)."""
    x, y, z = v
    return (
        x * world[0] + y * world[4] + z * world[8] + world[12],
        x * world[1] + y * world[5] + z * world[9] + world[13],
        x * world[2] + y * world[6] + z * world[10] + world[14],
    )


def _apply_normal_row(world, v):
    """Нормаль через 3x3 row-vector + нормировка (без переноса)."""
    x, y, z = v
    nx = x * world[0] + y * world[4] + z * world[8]
    ny = x * world[1] + y * world[5] + z * world[9]
    nz = x * world[2] + y * world[6] + z * world[10]
    n = (nx * nx + ny * ny + nz * nz) ** 0.5
    if n == 0.0:
        return (0.0, 0.0, 1.0)
    return (nx / n, ny / n, nz / n)


def bake_mesh(model, mesh, worlds=None, has_extras=False, offset=None,
               mtrl_rels=None, part="hull", armor_nodes=None):
    """Меш в мировые координаты three.js + классификация детали.

    offset — сдвиг пристыковки модуля (башня на маунт корпуса).
    armor_nodes — пресет {node: [side, layers]} для этого файла:
    уточняет сторону и слой только настоящей брони. Вид брони
    (tusk/ceramic/...) из classify_detailed — первичен
    и стороной не затирается.
    Пустые маунты (кость armor_base_*, кузовной материал, вида
    в меше/материале нет) и цельный корпус пресетными armor-нодами
    броней не делаются — это детали самой модели.
    """
    if worlds is None:
        worlds, has_extras = _model_worlds(model)
    target = mesh_target_index(model, has_extras, mesh.parent)
    world = worlds[target] if target is not None else _IDENT
    node_name = ""
    try:
        if target is not None:
            node_name = model.nodes[target].name or ""
    except (IndexError, AttributeError):
        pass
    pos, nor, uv = [], [], []
    for v in mesh.verts or []:
        if len(v) == 3:
            v = _apply_point_row(world, v)
            if offset is not None:
                v = (v[0] + offset[0], v[1] + offset[1], v[2] + offset[2])
        # Игра (X вперёд, Y влево, Z вверх) -> three.js
        # (X вправо, Y вверх, Z на камеру)
        pos += [round(-v[1], 4), round(v[2], 4), round(-v[0], 4)]
    for n in mesh.normals or []:
        if len(n) == 3:
            n = _apply_normal_row(world, n)
        nor += [round(-n[1], 4), round(n[2], 4), round(-n[0], 4)]
    for t in mesh.uvs or []:
        if len(t) == 2:
            u, vv = flip_uv(t)
            uv += [round(u, 5), round(vv, 5)]
    idx = []
    for i in mesh.indices or []:
        try:
            idx.append(int(i))
        except (TypeError, ValueError):
            continue
    try:
        mi = int(mesh.material_id)
    except (TypeError, ValueError):
        mi = -1
    mat_path = None
    if mtrl_rels and 0 <= mi < len(mtrl_rels):
        mat_path = mtrl_rels[mi]
    else:
        mi = -1
    mesh_name = mesh.material_type or ""
    layer = ""
    try:
        group, detail, explicit = classify_detailed(
            mesh_name, mat_path, node_name)
    except Exception:  # noqa: BLE001
        group, detail, explicit = "hull", "", False
    kind = detail if group == "armor" else ""
    if group == "armor":
        # Пустой маунт — не броня: кость семейства armor_base_*,
        # кузовной материал (без armor в имени) и никакого вида
        # в самом меше/материале. Как в плагине: armor_base с
        # body-материалом — крепёж, а не плита; в превью это
        # цельная деталь корпуса (M109, Abrams, Bradley).
        try:
            mat_base = str(mat_path or "").lower().replace(
                "\\", "/").rsplit("/", 1)[-1]
            kind_self = classify_armor_detail(mesh_name, mat_path, "")
        except Exception:  # noqa: BLE001
            mat_base, kind_self = "", ""
        if "armor_base" in (node_name or "").lower() \
                and "armor" not in mat_base and not kind_self:
            group, detail, kind = "hull", "", ""
    if group == "armor" and not kind:
        # Без вида — броня, только если нода подтверждена пресетом
        # (игровая бронезона); иначе цельная деталь модели — чаще
        # всего тело орудия с armor-материалом (twinplasma).
        hit = _armor_node_hit(armor_nodes, node_name) \
            if armor_nodes else None
        if hit is not None:
            side, layers = hit
            detail = side or "armor"
            layer = _short_layer(layers)
        elif "armor" in (mesh_name or "").lower() \
                and "armor" in (node_name or "").lower():
            # Именная броня на броне-кости — плита комплекта,
            # а не тело: имя меша и кость оба говорят armor
            # (buldozer_armor на armor_steel_*, towed_truck_armor,
            # fnd_abrams_armor). Вид — с кости, иначе базовый
            # комплект: в селекте брони это плиты и кронштейны.
            try:
                bone_kind = classify_armor_detail("", "", node_name)
            except Exception:  # noqa: BLE001
                bone_kind = ""
            detail = bone_kind or "base"
        else:
            group, detail = "hull", ""
    elif armor_nodes and group == "armor":
        # Пресет уточняет только настоящую броню: вид
        # (tusk/ceramic/...) — первичен, сторона — вторична.
        # Цельный корпус пресетные armor-ноды броней не делают.
        hit = _armor_node_hit(armor_nodes, node_name)
        if hit is not None:
            side, layers = hit
            detail = kind or side or "armor"
            layer = _short_layer(layers)
    return {"positions": pos, "normals": nor, "uvs": uv, "indices": idx,
            "material": mi, "name": mesh_name, "node": node_name,
            "group": group, "detail": detail, "layer": layer,
            "part": part}


def material_payload(upr, root, mtrl_rel, fallback="", overlay=()):
    """Материал по basis-пути .material: rel текстур для /api/model_tex.

    DDS заранее НЕ греем: прогрев всех текстур синхронно вешал ответ
    на десятки секунд. Текстуры догружаются лениво через /api/model_tex
    (там свой mtime-кэш), сцена со светом и сеткой встаёт сразу.
    overlay — слои саб-пути _ASSETS мода между root и fallback.
    """
    out = {"name": mtrl_rel, "albedo": "", "normal": "", "rough": "",
            "emission": "", "transparent": False, "double_sided": False,
            "missing": True}
    p = find_file(root, mtrl_rel, fallback, overlay)
    if not p:
        return out
    try:
        mat = read_material(p)
    except (MaterialError, OSError):
        return out
    out["missing"] = False
    tex = mat.textures or {}
    for slot, key in (("albedo", "albedo"), ("normal", "normal"),
                      ("rough", "rough"), ("emission", "emission")):
        rel = safe_rel(tex.get(slot) or "")
        # Текстура реально лежит в слоях — иначе битая ссылка
        out[key] = rel if rel and find_file(root, rel, fallback,
                                            overlay) else ""
    out["transparent"] = bool(mat.is_transparent)
    out["double_sided"] = (mat.rasterizer_state == "CullNone")
    return out


def _clean_node(name):
    """Имя ноды из species: префикс static: срезать, нижний регистр."""
    n = str(name or "").strip()
    if ":" in n and not any(c in n for c in ("*", "?", "[")):
        n = n.split(":")[-1]
    return n.lower()


def _mount_candidates(root, mount_rows, sets, chassis_stem=""):
    """[Генератор пресетов] Башни и пулемёты точно по gun_mounts: mesh + slot каждой маунты.

    mount_rows: {sysname: {col: val}} (база + DLC, DLC поверх).
    sets: [(mounts, is_base)] — базовый сет + сеты апгрейдов.
    Башенные слоты — варианты в выпадашку (подпись короткая,
    как раньше, без лишнего); плюс любые именные гнёзда
    *mount_point* с файлом модели: пушки пауков, мадробота,
    артиллерии (mount_point_guns/cannons_main/miniguns_*);
    дымовые (smoke в слоте) пропускаем, как раньше.
    Пулемётные слоты — оверлей поверх башни своего сета. Пулемёт на башенном слоте —
    вариант, только если других башен нет (хамви/M113: браунинг
    и есть башня). Шкурки (burn/damaged/desert) отсекаются везде.
    Возвращает (choices, mg_sets): [{rel, label, slot, set}],
    {set_idx: [{rel, slot}]}.
    """
    choices, mg_sets = [], {}
    seen_rel = set()
    for sidx, (mounts, is_base) in enumerate(sets):
        for mount in mounts or []:
            row = (mount_rows or {}).get(str(mount or "").strip())
            if not row:
                continue
            mesh = str(row.get("mesh") or "").strip().replace("\\", "/")
            slot = str(row.get("slot") or "").strip()
            if not mesh or _is_skin_mesh(mesh):
                continue
            rel = safe_rel(mesh)
            if not rel or not find_file(root, rel):
                continue
            slow = slot.lower()
            if slow in _MG_SLOTS:
                lst = mg_sets.setdefault(sidx, [])
                if not any(m["rel"] == rel and m["slot"] == slot
                           for m in lst):
                    lst.append({"rel": rel, "slot": slot})
            elif slow in _TURRET_SLOTS or (
                    "mount_point" in slow and "smoke" not in slow):
                if rel not in seen_rel:
                    seen_rel.add(rel)
                    choices.append({
                        "rel": rel,
                        "label": _short_turret_label(
                            chassis_stem, os.path.basename(rel)),
                        "slot": slot,
                        "mg": _is_mg_mesh(mesh),
                        "set": sidx,
                        "base": bool(is_base)})
            # Прочие слоты (дымы, ракеты) — не башни, пропускаем.
    # Пулемёт на башенном слоте — вариант, только если в его сете
    # нет настоящих башен (сток хамви/M113: браунинг и есть башня).
    by_set = {}
    for c in choices:
        by_set.setdefault(c.get("set", 0), []).append(c)
    keep = []
    for sidx in sorted(by_set):
        group = by_set[sidx]
        if any(not c.get("mg") for c in group):
            group = [c for c in group if not c.get("mg")]
        keep += group
    choices = [c for c in choices if c in keep]
    for c in choices:
        c.pop("mg", None)
    return choices, mg_sets


_ARMOR_SIDES = ("left", "right", "top", "bottom", "forward", "backward")


def _armor_side_maps(module_rows, modules_list):
    """[Генератор пресетов] Броня по данным игры: {side: {nodes:set, layers:str}}.

    Источник — modules.xml: <side>_armor_nodes (имена нод, static:
    срезается, '*' — маска) + <side>_armor_layers (тип:толщина).
    unarmoured — не броня, такие ноды пропускаются. Маски armor_* из
    affected_nodes — в side '' (сторона неизвестна).
    """
    maps = {s: {"nodes": set(), "layers": ""} for s in _ARMOR_SIDES}
    maps[""] = {"nodes": set(), "layers": ""}
    for mod in modules_list:
        row = (module_rows or {}).get(str(mod or "").strip())
        if not row:
            continue
        for side in _ARMOR_SIDES:
            layers = str(row.get(side + "_armor_layers") or "").strip()
            if not layers or layers.lower().startswith("unarmoured"):
                continue
            maps[side]["layers"] = layers
            for raw in str(row.get(side + "_armor_nodes") or "").split(","):
                n = _clean_node(raw)
                if n:
                    maps[side]["nodes"].add(n)
        for raw in str(row.get("affected_nodes") or "").split(","):
            n = _clean_node(raw)
            if n and "armor" in n and "*" in n:
                maps[""]["nodes"].add(n)
    return maps


def _armor_node_hit(table, node_name):
    """(side, layers) из пресетной таблицы {node: [side, layers]}.

    Точное имя, иначе маска ('*' — как в _armor_hit).
    """
    node = str(node_name or "").lower()
    if not node or not table:
        return None
    try:
        hit = table.get(node)
    except AttributeError:
        return None
    if hit:
        return hit[0], hit[1] if len(hit) > 1 else ""
    for pat, val in table.items():
        if "*" in pat and fnmatch.fnmatchcase(node, pat):
            return val[0], val[1] if len(val) > 1 else ""
    return None


def _armor_hit(armor_maps, node_name):
    """(side, layer) для ноды или None. Точное имя, иначе маска."""
    node = str(node_name or "").lower()
    if not node or not armor_maps:
        return None
    for side, info in armor_maps.items():
        nodes = info.get("nodes") or set()
        if node in nodes:
            return side, info.get("layers") or ""
        for pat in nodes:
            if "*" in pat and fnmatch.fnmatchcase(node, pat):
                return side, info.get("layers") or ""
    return None


def _short_layer(layers):
    """Короткое имя слоя: 'vehicle_steel_armor:90' -> 'steel'."""
    first = str(layers or "").split(",")[0].strip().lower()
    first = first.split(":")[0].strip()
    for cut in ("_armor", "vehicle_", "tank_"):
        first = first.replace(cut, "")
    return first.strip("_") or first


def _short_turret_label(chassis_stem, turret_fn):
    """Короткая подпись варианта: общий префикс с корпусом срезается
    (fnd_abrams_chassis + fnd_abrams_turret_cannon -> turret_cannon)."""
    a = str(chassis_stem or "").split("_")
    b = os.path.splitext(os.path.basename(turret_fn))[0].split("_")
    i = 0
    while i < len(a) and i < len(b) and a[i].lower() == b[i].lower():
        i += 1
    short = "_".join(b[i:]) if i else "_".join(b)
    return short or turret_fn


# Слоты маунтов gun_mounts.xml: башенные — настоящие башни,
# пулемётные — оверлей поверх башни (в выбор вариантов не входят).
_TURRET_SLOTS = ("tower_mount_point", "turret_mount_point",
                 "turret_mount_point_1", "turret_mount_point_2",
                 "turret_main_mount_point")

_MG_SLOTS = ("gunnerturret_mount_point", "gunnerturret_mount_point1",
             "turret_machinegun_mount_point")

_MG_MESH_HINTS = ("browning", "smocked_grenade")

_SKIN_HINTS = ("_burn", "_damaged", "_desert", "_rust")


def _is_mg_mesh(mesh):
    """Файл пулемёта: семейство small_turret / browning / дымовые."""
    fn = os.path.basename(str(mesh or "")).lower()
    return fn.startswith("small_turret") or \
        any(h in fn for h in _MG_MESH_HINTS)


def _is_skin_mesh(mesh):
    """Шкурка (burn/damaged/desert): в варианты не входит."""
    fn = os.path.basename(str(mesh or "")).lower()
    return any(h in fn for h in _SKIN_HINTS)


def _upgrade_mounts(upgrade_rows, sys, mounts_list):
    """[Генератор пресетов] Сеты маунтов: базовый + по одному на апгрейд юнита.

    *gun_upgrades по unit_sysname: в игре апгрейд ЗАМЕНЯет комплект
    маунтов, поэтому пулемёты берутся из активного сета, а не все
    скопом. Возвращает [(mounts, is_base)] — базовый первым.
    """
    sets = [([m for m in (mounts_list or []) if m], True)]
    if upgrade_rows and sys:
        for row in (upgrade_rows or {}).values():
            if not isinstance(row, dict):
                continue
            if str(row.get("unit_sysname") or "") != str(sys):
                continue
            mounts = [m.strip() for m in
                      str(row.get("gun_mounts") or "").split(",") if m.strip()]
            if mounts and mounts != sets[0][0]:
                sets.append((mounts, False))
    return sets


def _preset_mg_sets(root, chassis_rel, fallback="", overlay=()):
    """MG-сеты корпуса из пресета {turret_rel: [{rel, slot}]}.

    Отсутствующие файлы отсекаются; spare-сет (пулемёты сетов
    без башен) — последним под ключом '@@spare@@': в выбор входит,
    автоподбор его не берёт, пока есть башенные.
    """
    entry = _preset("turret_variants").get(chassis_rel) or {}
    mg_sets = {}

    def _good(items):
        good = []
        for m in items or []:
            rel = safe_rel(m.get("rel") or "")
            if rel and find_file(root, rel, fallback, overlay):
                good.append({"rel": rel, "slot": m.get("slot") or ""})
        return good

    for trel, items in (entry.get("mg") or {}).items():
        good = _good(items)
        if good:
            mg_sets[trel] = good
    spare = _good(entry.get("mg_spare"))
    if spare:
        mg_sets["@@spare@@"] = spare
    return mg_sets


def _turret_candidates(root, chassis_path, chassis_rel, fallback="",
                       overlay=()):
    """Варианты башни из пресета (без XML).

    turret_variants.json по rel корпуса: {choices, mg, default}.
    Файлы проверяются вживую (моддер мог не подгрузить DLC) —
    отсутствующие отсекаются. Нет записи — эвристика по имени
    файла в папке корпуса (без XML): корень + _turret_.
    Возвращает (choices, mg_sets)."""
    stem = os.path.splitext(os.path.basename(chassis_path))[0]
    entry = _preset("turret_variants").get(chassis_rel) or {}
    choices = []
    for c in entry.get("choices") or []:
        rel = safe_rel(c.get("rel") or "")
        if not rel or not find_file(root, rel, fallback, overlay):
            continue
        if any(x["rel"] == rel for x in choices):
            continue
        choices.append({"rel": rel,
                        "label": c.get("label") or _short_turret_label(
                            stem, os.path.basename(rel)),
                        "slot": c.get("slot") or ""})
    mg_sets = _preset_mg_sets(root, chassis_rel, fallback, overlay)
    if choices:
        default = entry.get("default") or ""
        for c in choices:
            c["selected"] = (c["rel"] == default)
        if not any(c["selected"] for c in choices):
            choices[0]["selected"] = True
        return choices, mg_sets
    try:
        names = os.listdir(os.path.dirname(chassis_path))
    except OSError:
        return [], {}
    # Без modules: любой файл папки с тем же корнем и куском _turret_
    base = stem[:-len("_chassis")] if stem.endswith("_chassis") else stem
    needle = "_" + base.lower().strip("_") + "_turret_"
    rel_dir = chassis_rel.rsplit("/", 1)[0] if "/" in chassis_rel else ""
    out = []
    seen = set()
    for fn in names:
        low = fn.lower()
        if not low.endswith(".model") or fn in seen:
            continue
        fstem = "_" + os.path.splitext(fn)[0].lower() + "_"
        if needle not in fstem or "chassis" in fstem:
            continue
        if os.path.join(os.path.dirname(chassis_path), fn) == chassis_path:
            continue
        seen.add(fn)
        rel = (rel_dir + "/" + fn) if rel_dir else fn
        score = 0
        if any(b in low for b in ("_burn", "_damaged", "_rust")):
            score += 10
        out.append({"rel": rel,
                    "label": _short_turret_label(stem, fn),
                    "slot": "",
                    "score": score})
    out.sort(key=lambda c: (c["score"], c["rel"]))
    for c in out:
        c["selected"] = False
        del c["score"]
    if out and any(not _is_mg_mesh(c["rel"]) for c in out):
        out = [c for c in out if not _is_mg_mesh(c["rel"])]
    if out:
        out[0]["selected"] = True
    return out, {}


def _origin_root(mod_ent):
    """Корень модуля: кандидат в начале координат файла, иначе первый.

    Игровое соглашение (док плагина): корень арматуры модуля сидит
    в origin. Без этого жадный паттерн 'turret' ловит пулемётное
    гнездо (integrator, towed_heavy) и башня едет не туда.
    Последний шанс — беспредковая нода (parent 0xFFFFFFFF):
    оружие пауков/вертолётов (hellfire, missle_launcher,
    spider_machineguns) не подходит ни под один именной паттерн.
    Возвращает имя ноды или None.
    """
    try:
        names = [n.name or "" for n in mod_ent["model"].nodes]
        cands = find_module_roots(names)
        if not cands:
            solo = find_module_root(names)
            if solo:
                return solo
            try:
                nodes = mod_ent["model"].nodes or []
                for n in nodes:
                    p = getattr(n, "parent", -1)
                    if p == 0xFFFFFFFF or p < 0 or p >= len(nodes):
                        return n.name or ""
            except Exception:  # noqa: BLE001
                pass
            return None
        for c in cands:
            p = _node_pos(mod_ent, c)
            if p is not None and abs(p[0]) + abs(p[1]) + abs(p[2]) < 0.01:
                return c
        return cands[0]
    except Exception:  # noqa: BLE001
        return None


def _stock_turret_bone(host_ent, mount_name):
    """Кость штатной башни шасси: прямой родитель маунта с 'turret' в имени.

    Шасси возит геометрию штатной башни (integrator_transport_v1:
    spiders_turret — родитель mount_point_guns и mount_point_rocket_pods).
    При монтировании варианта она заменяется (меши прячутся), при
    turret='' остаётся штатной комплектацией. Имя строго с 'turret':
    'gun' в имени кузова (towed_gun_chassis — родитель
    turret_mount_point) — не признак, там лафет со щитом, а не башня
    (рендер-проверка 09.2026). Возвращает имя кости или ''.
    """
    try:
        if not mount_name:
            return ""
        nodes = host_ent["model"].nodes or []
        idx = None
        for i, n in enumerate(nodes):
            if (getattr(n, "name", "") or "") == mount_name:
                idx = i
                break
        if idx is None:
            return ""
        try:
            par = int(getattr(nodes[idx], "parent", -1))
        except (TypeError, ValueError):
            return ""
        if par == ROOT_PARENT or not 0 <= par < len(nodes):
            return ""
        bone = getattr(nodes[par], "name", "") or ""
        return bone if "turret" in bone.lower() else ""
    except Exception:  # noqa: BLE001
        return ""


def _muzzle_keep(meshes):
    """Дульные устройства — телу башни, а не броне (глобально).

    Кончик ствола (надульник, кожух) автор кладёт на armor-кость
    (armor_ceramic_turret_23 у всех башен абрамса) — тумблер брони
    отрывал пушку. Правило геометрическое: armor-меш башни, целиком
    лежащий за лобовым срезом тела вдоль орудийной оси (длинная
    горизонтальная ось тела, запас 0.3), — дульное устройство.
    Накладные блоки пересекают тело и остаются бронёй.
    Работает in place, возвращает число переведённых.
    """
    body_min, body_max = None, None
    for m in meshes or []:
        if m.get("part") != "turret" or m.get("group") == "armor":
            continue
        p = m.get("positions") or []
        xs, zs = p[0::3], p[2::3]
        if not xs:
            continue
        lo = (min(xs), min(zs))
        hi = (max(xs), max(zs))
        if body_min is None:
            body_min, body_max = list(lo), list(hi)
        else:
            body_min[0] = min(body_min[0], lo[0])
            body_min[1] = min(body_min[1], lo[1])
            body_max[0] = max(body_max[0], hi[0])
            body_max[1] = max(body_max[1], hi[1])
    if body_min is None:
        return 0
    spans = (body_max[0] - body_min[0], body_max[1] - body_min[1])
    ax = 0 if spans[0] >= spans[1] else 1
    edge = body_max[ax] if abs(body_max[ax]) >= abs(body_min[ax]) \
        else body_min[ax]
    sgn = 1.0 if edge >= 0 else -1.0
    moved = 0
    for m in meshes or []:
        if m.get("part") != "turret" or m.get("group") != "armor":
            continue
        p = m.get("positions") or []
        vals = p[0::3] if ax == 0 else p[2::3]
        if not vals:
            continue
        past = (min(vals) * sgn) > (edge * sgn - 0.3)
        if past:
            m["group"] = "turret"
            m["detail"] = ""
            m["layer"] = ""
            moved += 1
    return moved


def _gun_keep(meshes):
    """Казённик с обвесом — телу башни, а не броне (глобально).

    Тумблер брони раздевал орудие до голой трубы: кожух казенника
    и плитки вокруг него автор кладёт на armor-кости. Правило:
    ствол — вытянутая (длина >= 3x ширины, длина >= 0.5м) не-броня
    башни на орудийной кости/меше (gun/cannon/barrel/mantlet,
    turret01/turret02 — антенны и тросы мимо); armor-меши с центром
    ближе min(0.5 длины, 1.8м) от казённого среза (конец ствола
    у центра тела) — обвес орудия, всегда с башней. Бортовые
    и кормовые блоки дальше радиуса остаются бронёй.
    Работает in place, возвращает число переведённых.
    """
    gun_hit = ("gun", "cannon", "barrel", "mantlet", "turret01",
               "turret02")
    tubes = []
    for m in meshes or []:
        if m.get("part") != "turret" or m.get("group") == "armor":
            continue
        hay = ((m.get("name") or "") + " " + (m.get("node") or "")
               ).lower()
        if not any(h in hay for h in gun_hit):
            continue
        p = m.get("positions") or []
        xs, ys, zs = p[0::3], p[1::3], p[2::3]
        if not xs:
            continue
        spans = (max(xs) - min(xs), max(ys) - min(ys),
                 max(zs) - min(zs))
        long_side = max(range(3), key=lambda i: spans[i])
        width = max(spans[i] for i in range(3) if i != long_side)
        if spans[long_side] >= 0.5 and width > 0 and \
                spans[long_side] / width >= 3.0:
            tubes.append((spans[long_side], m))
    if not tubes:
        return 0
    tube_len, tube = max(tubes, key=lambda t: t[0])[0], \
        max(tubes, key=lambda t: t[0])[1]
    tp = tube.get("positions") or []
    body_c = []
    for m in meshes or []:
        if m.get("part") != "turret" or m.get("group") == "armor":
            continue
        p = m.get("positions") or []
        if p:
            body_c.append((sum(p[0::3]) / len(p[0::3]),
                           sum(p[2::3]) / len(p[2::3])))
    if not body_c:
        return 0
    bcx = sum(c[0] for c in body_c) / len(body_c)
    bcz = sum(c[1] for c in body_c) / len(body_c)
    txs, tzs = tp[0::3], tp[2::3]
    ends = [(min(txs), min(tzs)), (max(txs), max(tzs))]
    Kend = 0 if ((ends[0][0] - bcx) ** 2 + (ends[0][1] - bcz) ** 2) < (
        (ends[1][0] - bcx) ** 2 + (ends[1][1] - bcz) ** 2) else 1
    mx, mz = ends[Kend]
    rad = min(tube_len * 0.5, 1.8)
    moved = 0
    for m in meshes or []:
        if m.get("part") != "turret" or m.get("group") != "armor":
            continue
        if m.get("layer"):
            # Подтверждена пресетом игры — настоящая бронезона.
            continue
        p = m.get("positions") or []
        xs, zs = p[0::3], p[2::3]
        if not xs:
            continue
        cx = sum(xs) / len(xs)
        cz = sum(zs) / len(zs)
        if (cx - mx) ** 2 + (cz - mz) ** 2 <= rad * rad:
            m["group"] = "turret"
            m["detail"] = ""
            m["layer"] = ""
            moved += 1
    return moved


def _mount_offset(host_ent, mod_ent, prefer=""):
    """Сдвиг пристыковки: голова маунта корпуса минус голова корня модуля.

    Маунт — prefer (slot из пресета) либо tower_mount_point первым
    по правилам плагина; корень модуля — _origin_root (кандидат
    в начале координат). Головы — переносы мировых матриц
    (элементы 12,13,14, row-vector).
    Возвращает (offset, mount, anchor) либо (None, '', '').
    """
    try:
        host_names = [n.name or "" for n in host_ent["model"].nodes]
        mod_names = [n.name or "" for n in mod_ent["model"].nodes]
        mounts = find_host_mounts(host_names)
        if prefer:
            low = {n.lower(): n for n in host_names}
            hit = low.get(str(prefer).strip().lower())
            if hit:
                mounts = [hit] + [m for m in mounts if m != hit]
        anchor_name = _origin_root(mod_ent)
        if not mounts or not anchor_name:
            return None, "", ""
        mount_idx = host_names.index(mounts[0])
        anchor_idx = mod_names.index(anchor_name)
        mw = host_ent["worlds"][mount_idx]
        aw = mod_ent["worlds"][anchor_idx]
        off = (mw[12] - aw[12], mw[13] - aw[13], mw[14] - aw[14])
        return off, mounts[0], anchor_name
    except Exception:  # noqa: BLE001
        return None, "", ""


def _mg_union(mg_sets, stem=""):
    """Все пулемёты корпуса одним списком [{rel, slot, label}]."""
    out = []
    for lst in (mg_sets or {}).values():
        for m in lst or []:
            rel = safe_rel(m.get("rel") or "")
            if not rel or any(x["rel"] == rel for x in out):
                continue
            out.append({"rel": rel, "slot": m.get("slot") or "",
                        "label": _short_turret_label(stem, rel)})
    return out


def _resolve_mg(mg_sets, want, mg_param, stem=""):
    """Пулемёты под вариант башни: (mg_list, mg_choices, active_rel).

    mg_param: '@@auto@@' — из своего сета, иначе сток первого
    варианта (место под гнездо есть на каждой башне); '' — без
    пулемёта; иначе явный rel (слот ищется в общем списке).
    """
    union = _mg_union(mg_sets, stem)
    if mg_param == "":
        return [], union, ""
    if mg_param not in (None, "@@auto@@", ""):
        rel = safe_rel(mg_param)
        slot = next((m["slot"] for m in union if m["rel"] == rel), "")
        return ([{"rel": rel, "slot": slot}] if rel else [],
                union, rel)
    sero = (mg_sets or {}).get(want) or []
    if not sero and mg_sets:
        # Сток первого (базового) варианта: гнездо есть на каждой
        # башне, свой сет апгрейд мог не описать.
        sero = next(iter(mg_sets.values())) or []
    active = sero[0]["rel"] if sero else ""
    return sero, union, active


def _node_pos(ent, name):
    """Позиция ноды в мировых матрицах файла (12,13,14) или None."""
    try:
        names = [n.name or "" for n in ent["model"].nodes]
        low = {n.lower(): i for i, n in enumerate(names)}
        idx = low.get(str(name or "").strip().lower())
        if idx is None:
            return None
        w = ent["worlds"][idx]
        return (w[12], w[13], w[14])
    except Exception:  # noqa: BLE001
        return None


def _bake_mg_meshes(root, mod_ent, turret_off, mg_list, tmtrl_base,
                    fallback="", overlay=()):
    """Пулемёты поверх башни: корень MG-модели — на ноду-слот башни.

    mod_ent — закэшированная башня, turret_off — её сдвиг на корпусе
    (игровые координаты). Броня — из пресетной таблицы своего файла.
    Возвращает (meshes, materials).
    """
    meshes, materials = [], []
    for item in mg_list or []:
        mrel = safe_rel(item.get("rel") or "")
        mpath = find_file(root, mrel, fallback, overlay) if mrel else ""
        if not mpath:
            continue
        try:
            mg_ent = _cached_model(mpath)
        except (BinaryIOError, OSError, ValueError):
            continue
        # Гнездо из сета, иначе любое пулемётное гнездо башни:
        # апгрейдные MG описаны под чужой слот, место одно.
        anchor, slot = None, ""
        for cand in [item.get("slot") or ""] + [s for s in _MG_SLOTS]:
            if not cand or cand == slot:
                continue
            anchor = _node_pos(mod_ent, cand)
            if anchor is not None:
                slot = cand
                break
        if anchor is None:
            continue
        mg_root = _origin_root(mg_ent)
        origin = _node_pos(mg_ent, mg_root or "") or (0.0, 0.0, 0.0)
        ox = (turret_off[0] if turret_off else 0.0) + anchor[0] - origin[0]
        oy = (turret_off[1] if turret_off else 0.0) + anchor[1] - origin[1]
        oz = (turret_off[2] if turret_off else 0.0) + anchor[2] - origin[2]
        mmtrl = list(mg_ent["model"].mtrl or [])
        base = tmtrl_base + len(materials)
        materials += [material_payload(None, root, m, fallback, overlay)
                        for m in mmtrl]
        mtable = _preset("node_armor").get(mrel) or {}
        for m in mg_ent["model"].meshes or []:
            b = bake_mesh(mg_ent["model"], m, mg_ent["worlds"],
                          mg_ent["has_extras"], offset=(ox, oy, oz),
                          mtrl_rels=mmtrl, part="mg",
                          armor_nodes=mtable)
            if b["material"] >= 0:
                b["material"] += base
            meshes.append(b)
    return meshes, materials


def preview_payload(upr, root, value, turret="@@auto@@", mg="@@auto@@"):
    """JSON для вьюера по сырому значению колонки mesh.

    Самодостаточен: варианты башен — из пресета turret_variants
    по rel корпуса, стороны брони — из пресета node_armor по rel
    файла. Никаких XML рантайм не читает. turret: '@@auto@@' —
    автоподбор (default пресета), '' — без башни, иначе явный rel.
    mg: '@@auto@@' — из сета башни (иначе сток), '' — без пулемёта,
    иначе явный rel.
    Ответ: {ok, path, meshes:[bake + material/group/detail/layer/part],
    materials, turret:{rel, mount, anchor, choices}|None}.
    Пулемёты (part 'mg') пекутся поверх башни на ноду-слот.
    Ошибка чтения/отсутствия файла — {ok: False, error}.
    srv_ms — разбивка времени сервера для диагностики зависаний.
    """
    t_all = time.perf_counter()
    rel = safe_rel(value)
    if not rel:
        return {"ok": False, "error": "bad_value"}
    if not root or not os.path.isdir(root):
        return {"ok": False, "error": "no_root"}
    ovl = _base_fallback(upr, root)
    sub = overlays_for(upr, root)
    armor_table = _preset("node_armor").get(rel) or {}
    path = find_file(root, rel, ovl, sub)
    if not path:
        return {"ok": False, "error": "no_file", "value": rel}
    t0 = time.perf_counter()
    try:
        host_ent = _cached_model(path)
    except (BinaryIOError, OSError, ValueError) as e:
        return {"ok": False, "error": "parse_failed",
                "detail": str(e)[:200]}
    ms_parse = round((time.perf_counter() - t0) * 1000)
    host = host_ent["model"]
    t0 = time.perf_counter()
    if host_ent["baked"] is None and not armor_table:
        mtrl_rels = list(host.mtrl or [])
        host_ent["baked"] = [bake_mesh(
            host, m, host_ent["worlds"], host_ent["has_extras"],
            mtrl_rels=mtrl_rels) for m in host.meshes or []]
    if armor_table:
        # Таблица брони своя у каждого файла — общий кэш корпуса
        # нельзя переиспользовать, печём свежо (дешево).
        mtrl_rels = list(host.mtrl or [])
        meshes = [bake_mesh(
            host, m, host_ent["worlds"], host_ent["has_extras"],
            mtrl_rels=mtrl_rels, armor_nodes=armor_table)
            for m in host.meshes or []]
    else:
        meshes = [dict(b, material=(b["material"]))
                  for b in host_ent["baked"]]
    ms_bake = round((time.perf_counter() - t0) * 1000)
    mtrl_rels = list(host.mtrl or [])
    t0 = time.perf_counter()
    materials = [material_payload(upr, root, m, ovl, sub)
                 for m in mtrl_rels]
    ms_mats = round((time.perf_counter() - t0) * 1000)
    turret_info = None
    want = turret if turret != "@@auto@@" else None
    choices = []
    mg_sets = {}
    if turret != "":
        explicit = turret not in (None, "@@auto@@", "")
        # Полный список вариантов всегда — иначе после ручного выбора
        # выпадашка схлопывается до одного пункта и прячется.
        choices, mg_sets = _turret_candidates(root, path, rel, ovl, sub)
        if explicit:
            want = safe_rel(turret)
            if not any(c["rel"] == want for c in choices):
                choices.insert(0, {"rel": want,
                                   "label": want.rsplit("/", 1)[-1],
                                   "slot": ""})
        elif choices:
            want = next((c["rel"] for c in choices
                         if c.get("selected")), choices[0]["rel"])
        if want:
            tpath = find_file(root, want, ovl, sub)
            if tpath and tpath != path:
                try:
                    mod_ent = _cached_model(tpath)
                except (BinaryIOError, OSError, ValueError):
                    mod_ent = None
                if mod_ent is not None:
                    mod = mod_ent["model"]
                    want_slot = ""
                    for c in choices:
                        if c["rel"] == want:
                            want_slot = c.get("slot") or ""
                            break
                    off, mount, anchor = _mount_offset(
                        host_ent, mod_ent, prefer=want_slot)
                    tmtrl = list(mod.mtrl or [])
                    base = len(materials)
                    materials += [material_payload(upr, root, m, ovl, sub)
                                  for m in tmtrl]
                    tarmor = _preset("node_armor").get(want) or {}
                    for m in mod.meshes or []:
                        b = bake_mesh(mod, m, mod_ent["worlds"],
                                      mod_ent["has_extras"], offset=off,
                                      mtrl_rels=tmtrl, part="turret",
                                      armor_nodes=tarmor)
                        if b["material"] >= 0:
                            b["material"] += base
                        meshes.append(b)
                    mg_list, mg_union, mg_rel = _resolve_mg(
                        mg_sets, want, mg,
                        os.path.splitext(os.path.basename(path))[0])
                    mg_meshes, mg_mats = _bake_mg_meshes(
                        root, mod_ent, off, mg_list,
                        base + len(tmtrl), ovl, sub)
                    materials += mg_mats
                    meshes += mg_meshes
                    stock = _stock_turret_bone(host_ent, mount)
                    if stock:
                        # Штатная башня заменена вариантом: её геометрия
                        # шасси прячется, иначе с любым вариантом
                        # стоят сдвоенные пушки (Int_heavy_guntruck).
                        meshes = [
                            m for m in meshes
                            if not (m.get("part") == "hull"
                                    and m.get("group") == "turret"
                                    and m.get("node") == stock)]
                    _muzzle_keep(meshes)
                    _gun_keep(meshes)
                    for c in choices:
                        c["selected"] = (c["rel"] == want)
                    turret_info = {"rel": want, "mount": mount,
                                   "anchor": anchor, "choices": choices,
                                   "mat_base": base, "mg": mg_rel,
                                   "mg_choices": mg_union}
    else:
        # Штатная комплектация (turret=''): геометрия штатной башни —
        # часть башни (тумблер и обмен её видят), а не неснимаемый
        # корпус. Кости строго с 'turret' в имени.
        for m in meshes:
            if (m.get("part") == "hull"
                    and m.get("group") == "turret"
                    and "turret" in str(m.get("node") or "").lower()):
                m["part"] = "turret"
    ms_total = round((time.perf_counter() - t_all) * 1000)
    return {"ok": True, "path": path, "value": rel,
            "version": host.version, "meshes": meshes,
            "materials": materials, "turret": turret_info,
            "srv_ms": {"parse": ms_parse, "bake": ms_bake,
                       "mats": ms_mats, "total": ms_total}}


def turret_payload(upr, root, chassis_value, turret_rel, turret_slot="",
                   mg="@@auto@@"):
    """Только башня для смены варианта без перезагрузки корпуса.

    Самодостаточен: слот из пресета (turret_slot — запасной путь),
    броня — из пресетной таблицы файла башни, пулемёты — из пресета
    корпуса под этот вариант (mg — выбор/выключение). Никаких XML
    рантайм не читает.
    Маунт считается по кэшированному корпусу, индексы материалов уже
    сдвинуты на число материалов корпуса (base) — фронт просто
    дописывает materials и меняет меши part == 'turret'/'mg'.
    Ответ: {ok, rel, mount, anchor, meshes, materials, srv_ms}.
    """
    t_all = time.perf_counter()
    crel = safe_rel(chassis_value)
    trel = safe_rel(turret_rel)
    if not crel or not trel:
        return {"ok": False, "error": "bad_value"}
    if not root or not os.path.isdir(root):
        return {"ok": False, "error": "no_root"}
    ovl = _base_fallback(upr, root)
    sub = overlays_for(upr, root)
    cpath = find_file(root, crel, ovl, sub)
    if not cpath:
        return {"ok": False, "error": "no_file", "value": crel}
    tpath = find_file(root, trel, ovl, sub)
    if not tpath or tpath == cpath:
        return {"ok": False, "error": "no_file", "value": trel}
    t0 = time.perf_counter()
    try:
        host_ent = _cached_model(cpath)
        mod_ent = _cached_model(tpath)
    except (BinaryIOError, OSError, ValueError) as e:
        return {"ok": False, "error": "parse_failed",
                "detail": str(e)[:200]}
    ms_parse = round((time.perf_counter() - t0) * 1000)
    mod = mod_ent["model"]
    off, mount, anchor = _mount_offset(host_ent, mod_ent,
                                       prefer=turret_slot)
    tmtrl = list(mod.mtrl or [])
    base = len(list(host_ent["model"].mtrl or []))
    t0 = time.perf_counter()
    materials = [material_payload(upr, root, m, ovl, sub) for m in tmtrl]
    ms_mats = round((time.perf_counter() - t0) * 1000)
    t0 = time.perf_counter()
    meshes = []
    tarmor = _preset("node_armor").get(trel) or {}
    for m in mod.meshes or []:
        b = bake_mesh(mod, m, mod_ent["worlds"],
                      mod_ent["has_extras"], offset=off,
                      mtrl_rels=tmtrl, part="turret",
                      armor_nodes=tarmor)
        if b["material"] >= 0:
            b["material"] += base
        meshes.append(b)
    mg_sets = _preset_mg_sets(root, crel, ovl, sub)
    mg_list, mg_union, mg_rel = _resolve_mg(
        mg_sets, trel, mg,
        os.path.splitext(os.path.basename(cpath))[0])
    mg_meshes, mg_mats = _bake_mg_meshes(
        root, mod_ent, off, mg_list,
        base + len(tmtrl), ovl, sub)
    materials += mg_mats
    meshes += mg_meshes
    _muzzle_keep(meshes)
    _gun_keep(meshes)
    ms_bake = round((time.perf_counter() - t0) * 1000)
    choices, _ = _turret_candidates(root, cpath, crel, ovl, sub)
    for c in choices:
        c["selected"] = (c["rel"] == trel)
    return {"ok": True, "rel": trel, "mount": mount, "anchor": anchor,
            "meshes": meshes, "materials": materials,
            "choices": choices, "mg": mg_rel, "mg_choices": mg_union,
            "srv_ms": {"parse": ms_parse, "bake": ms_bake,
                        "mats": ms_mats,
                        "total": round((time.perf_counter() - t_all) * 1000)}}
