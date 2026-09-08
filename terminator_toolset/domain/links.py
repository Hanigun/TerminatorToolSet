"""Cross-file links: navigate from a cell to the entity it references.

Some columns in cars.xml/tanks.xml/helicopters.xml/squads.xml reference entities
defined in OTHER files (ammunition sysnames, gun_mounts, modules, crew, joints,
models, etc.). When a cell's value matches a sysname/record that lives in another
project file, we show a navigable link: click -> open that file and scroll to the
matching row.

Match rules are heuristic and cheap (exact string equality against a lookup map
built once per project scan). No regex needed.

Зависимости семейств файлов (кто на кого ссылается sysname):
  car_*_upgrades.xml + car_upgrade_presets.xml -> cars.xml
  heli_*_upgrades.xml + heli_upgrade_presets.xml -> helicopters.xml
  squads.xml + squad_upgrades.xml + squad_upgrade_presets.xml -> humans.xml
  tank_*_upgrades.xml + tank_upgrade_presets.xml -> tanks.xml
Файлы семейства могут ссылаться друг на друга в отдельных пунктах, но
никогда на самого себя. Остальные (ammunition/modules/missiles/guns/
weapon_slots/shop_presets/spawns/airstrikes/...) связываются общим
совпадением значений без явных правил.
"""
from __future__ import annotations

import os
import re


# -- cell value tokenization ------------------------------------------------
# Ячейки игровых таблиц — это списки через запятую/точку с запятой
# («bmp1_gun_hor,bmp1_gun_ver») и композиты «имя:количество» («Lgn_wolf:4»):
# точное совпадение ЦЕЛОЙ ячейки находит меньше половины ссылок (guns,
# gun_mounts и т.п. живут почти целиком в списках). Пробелы НЕ разделитель:
# в комментариях («120мм пушка танковая») их нарезка дала бы ложные связи.
_TOKEN_SEP = re.compile(r"[,;|\n\r\t]+")
_COUNT_SUFFIX = re.compile(r"^(.*\S)\s*:\d+$")


def split_refs(value) -> list:
    """Ячейка -> кандидаты sysname (порядок, без дублей)."""
    s = str(value or "")
    if not s.strip():
        return []
    out = []
    for part in _TOKEN_SEP.split(s):
        p = part.strip()
        if not p:
            continue
        m = _COUNT_SUFFIX.match(p)
        # «12:30» (время) не трогаем: имя обязано содержать букву/подчёркивание
        if m and re.search(r"[A-Za-z_]", m.group(1)):
            p = m.group(1).strip()
        if p and p not in out:
            out.append(p)
    return out


def _key_indexes(grid: dict) -> list:
    """Колонки-определения: 0 всегда + колонки с заголовком sysname."""
    cols = grid.get("columns", []) or []
    idx = [0]
    for i, name in enumerate(cols):
        if i != 0 and str(name or "").strip().lower() == "sysname":
            idx.append(i)
    return idx


def defs_from_grid(grid: dict, path: str) -> dict:
    """Определения файла: {значение: [{file, sheet_index, row_index}]}."""
    norm = _norm(path or "")
    sheet_idx = grid.get("sheet_index", 0)
    key_cols = _key_indexes(grid)
    out: dict = {}
    for ri, row in enumerate(grid.get("rows", [])):
        vals = row.get("values", []) if isinstance(row, dict) else []
        for col in key_cols:
            if col < len(vals) and vals[col]:
                v = str(vals[col]).strip()
                if v:
                    out.setdefault(v, []).append(
                        {"file": norm, "sheet_index": sheet_idx,
                         "row_index": ri})
    return out


# -- file dependency rules --------------------------------------------------
# referrer basename (lower) -> target basenames (lower). Явная карта семейств:
# апгрейды и пресеты ссылаются sysname на базовый файл техники/пехоты.
REFERS_TO = {
    "car_armor_upgrades.xml": ["cars.xml"],
    "car_engine_upgrades.xml": ["cars.xml"],
    "car_gun_upgrades.xml": ["cars.xml"],
    "car_upgrade_presets.xml": ["cars.xml"],
    "heli_armor_upgrades.xml": ["helicopters.xml"],
    "heli_engine_upgrades.xml": ["helicopters.xml"],
    "heli_gun_upgrades.xml": ["helicopters.xml"],
    "heli_upgrade_presets.xml": ["helicopters.xml"],
    "squads.xml": ["humans.xml"],
    "squad_upgrades.xml": ["humans.xml"],
    "squad_upgrade_presets.xml": ["humans.xml"],
    "tank_armor_upgrades.xml": ["tanks.xml"],
    "tank_engine_upgrades.xml": ["tanks.xml"],
    "tank_gun_upgrades.xml": ["tanks.xml"],
    "tank_upgrade_presets.xml": ["tanks.xml"],
}

# fallback для будущих файлов семейства (базовые cars/humans/... сами под
# префиксы не попадают, самовыбор невозможен и здесь).
_PREFIX_FALLBACK = (
    ("car_", ["cars.xml"]),
    ("heli_", ["helicopters.xml"]),
    ("tank_", ["tanks.xml"]),
    ("squad", ["humans.xml"]),
)


def dep_targets_for(file_name: str) -> list:
    """Базовые файлы, на которые ссылается referrer (имена, lower)."""
    low = (file_name or "").lower()
    if low in REFERS_TO:
        return list(REFERS_TO[low])
    for prefix, targets in _PREFIX_FALLBACK:
        if low.startswith(prefix) and low not in targets:
            return list(targets)
    return []


def _overlay_key(path: str) -> str:
    """basis vs dlc: цель предпочитаем из того же оверлея, что referrer."""
    parts = (path or "").replace("\\", "/").lower().split("/")
    return "dlc" if "dlc" in parts else "basis"


def pick_target(hits: list, this_path: str, dep_basenames) -> dict:
    """Выбор цели среди всех вхождений значения: сначала файлы правил,
    затем та же папка, затем тот же оверлей. Сам файл уже исключён."""
    dep = set(dep_basenames or [])
    this_dir = os.path.dirname(this_path or "")
    this_ov = _overlay_key(this_path or "")

    def score(h):
        f = h.get("file", "")
        bn = os.path.basename(f).lower()
        return (0 if bn in dep else 1,
                0 if os.path.dirname(f) == this_dir else 1,
                0 if _overlay_key(f) == this_ov else 1)

    return sorted(hits, key=score)[0]


def _norm(path: str) -> str:
    """Канонический путь: разделители + регистр (Windows). Пути в проекте и
    в открытых сессиях могут отличаться разделителями ('/' vs '\\'), из-за
    чего один и тот же файл считался 'другим' и появлялись само-ссылки."""
    try:
        return os.path.normcase(os.path.normpath(path))
    except Exception:  # noqa: BLE001
        return path or ""


def collect_entity_map(files_with_grids: "dict[str, object]") -> "dict[str, list]":
    """Return { value: [ {file, sheet_index, row_index}, ... ] }.

    Один sysname может существовать в нескольких файлах (basis + dlc-оверлеи):
    храним ВСЕ вхождения, link_targets выбирает не-своё. grid_provider:
    file_path -> object exposing .grid() (a Session) or .rows with .cell_value().
    We index row 0 (sysname) plus a few common key columns."""
    index: "dict[str, list]" = {}
    for file_path, session in files_with_grids.items():
        try:
            grid = session.grid()
        except Exception:
            continue
        for v, locs in defs_from_grid(grid, file_path).items():
            index.setdefault(v, []).extend(locs)
    return index


def collect_entity_from_paths(paths: "list[str]", load_fn) -> "dict[str, list]":
    """Build { value: [ {file, sheet_index, row_index}, ... ] } by parsing
    each file path.

    ``load_fn(path)`` must return a minimal grid dict: {"rows":[{"values":[...]}],
    "sheet_index": 0} (+ optional "columns": [...] for sysname headers).
    Each file is parsed transiently and discarded, keeping the index small
    even when a whole project (~60 species files) is linked."""
    index: "dict[str, list]" = {}
    for p in paths:
        try:
            grid = load_fn(p)
        except Exception:  # noqa: BLE001
            continue
        for v, locs in defs_from_grid(grid, p).items():
            index.setdefault(v, []).extend(locs)
    return index


def link_targets(session, entity_map: dict, dep_targets=None) -> "list[dict]":
    """For the open session's grid, return which (row,col) cells are links.

    Returns [{row, col, value, target_file, target_row}]. Ссылка на ЭТОТ ЖЕ
    файл (в т.ч. на оверлей-копию того же sysname в другом файле, когда своё
    определение есть в текущем) не создаётся: если значение определено здесь,
    переходить некуда. При нескольких вхождениях цель выбирает pick_target:
    файлы правил семейства -> та же папка -> тот же оверлей."""
def _cell_refs(session, entity_map: dict, dep_targets=None):
    """Все разрешённые ссылки ячеек: (ri, ci, value, ref, hit).

    Значение ячейки режется на токены (split_refs): список «a,b:3» даёт
    отдельные ссылки на a и b. Один токен — одна ссылка; повторы ячейка+цель
    не дублируются."""
    this_path = _norm(session.path)
    if dep_targets is None:
        dep_targets = dep_targets_for(os.path.basename(session.path or ""))
    grid = session.grid()
    rows = grid.get("rows", [])
    cols = len(grid.get("columns", []))
    seen = set()
    for ri, row in enumerate(rows):
        vals = row.get("values", []) if isinstance(row, dict) else []
        for ci in range(min(len(vals), cols)):
            v = vals[ci]
            if not v:
                continue
            for ref in split_refs(v):
                hits = entity_map.get(ref)
                if not hits:
                    continue
                if any(h["file"] == this_path for h in hits):
                    continue    # определено в этом же файле - не ссылка
                hit = pick_target(hits, this_path, dep_targets)
                key = (ri, ci, hit["file"], hit["row_index"])
                if key in seen:
                    continue
                seen.add(key)
                yield ri, ci, v, ref, hit


def link_targets(session, entity_map: dict, dep_targets=None) -> "list[dict]":
    """For the open session's grid, return which (row,col) cells are links.

    Returns [{row, col, value, ref, target_file, target_row}]: value — вся
    ячейка, ref — разрешённый токен. На ячейку одна ссылка (первая): кнопка
    связи в гриде одиночная, все токены видны в отчёте «Анализа». Ссылка на
    ЭТОТ ЖЕ файл не создаётся; при нескольких вхождениях цель выбирает
    pick_target: файлы правил семейства -> та же папка -> тот же оверлей."""
    out = []
    done_cells = set()
    for ri, ci, v, ref, hit in _cell_refs(session, entity_map, dep_targets):
        if (ri, ci) in done_cells:
            continue
        done_cells.add((ri, ci))
        out.append({
            "row": ri,
            "col": ci,
            "value": v,
            "ref": ref,
            "target_file": hit["file"],
            "target_row": hit["row_index"],
            "target_sheet": hit["sheet_index"],
        })
    return out


def all_refs(session, entity_map: dict, dep_targets=None) -> "list[dict]":
    """Все разрешённые токены (для отчёта «Анализа», без схлопывания)."""
    return [{
        "row": ri,
        "col": ci,
        "value": v,
        "ref": ref,
        "target_file": hit["file"],
        "target_row": hit["row_index"],
        "target_sheet": hit["sheet_index"],
    } for ri, ci, v, ref, hit in _cell_refs(session, entity_map, dep_targets)]


def own_sysnames(session) -> set:
    """Sysnames открытого файла (ключи определений) — якоря входящих ссылок."""
    try:
        grid = session.grid()
    except Exception:  # noqa: BLE001
        return set()
    try:
        return set(defs_from_grid(grid, session.path or "").keys())
    except Exception:  # noqa: BLE001
        return set()


def collect_incoming(paths: "list[str]", load_fn, own_sysnames: set,
                     own_path: str) -> dict:
    """Входящие ссылки одним проходом: {файл: [{row, col, value, ref}]}.

    Токены sysname открытого файла, встреченные в чужих ячейках (списки
    и :count режутся split_refs). Свой файл исключён."""
    own = _norm(own_path or "")
    incoming: dict = {}
    for p in paths or []:
        if _norm(p) == own or not own_sysnames:
            continue
        try:
            grid = load_fn(p)
        except Exception:  # noqa: BLE001
            continue
        rows = grid.get("rows", [])
        cols = len(grid.get("columns", []) or [])
        for ri, row in enumerate(rows):
            vals = row.get("values", []) if isinstance(row, dict) else []
            for ci in range(min(len(vals), cols) if cols else len(vals)):
                for ref in split_refs(vals[ci]):
                    if ref in own_sysnames:
                        incoming.setdefault(_norm(p), []).append(
                            {"row": ri, "col": ci, "value": vals[ci],
                             "ref": ref})
    if own in incoming:
        incoming.pop(own, None)
    return incoming
