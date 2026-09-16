"""Саб-пути мода: текстуры/модели, проверка структуры, оверлей _ASSETS.

Мод (mod_path) — корень с basis/... Рядом может лежать папка вида
<МОД>_ASSETS с чистыми текстурами: её подключают саб-путём (конфиг
mod_overlay_path), и программа видит оба корня как одно целое —
поиск моделей/текстур идёт по слоям мода, затем оверлея (symlink-like
union на уровне basis-слоёв, без слияния деревьев и правок на диске).
"""
from __future__ import annotations

import glob
import os

# Канонические саб-пути внутри basis-слоя (плюс dlc/<Имя>/basis/... —
# те же хвосты, префикс подставляется при сканировании).
TEX_SUBPATHS = ("basis/textures", "basis/animations/new/skin")
MODEL_SUBPATHS = ("basis/models",)
# Хвосты без префикса basis/: так лежат DLC-оверлеи после обрезки.
_TEX_TAILS = ("textures", "animations/new/skin")
_MODEL_TAILS = ("models",)
# Ожидаемое содержимое корня мода: basis/ хотя бы с одной известной
# подпапкой либо DLC-оверлеи. basis/animations — пехота (new/skin),
# basis/preview_config — позы камеры превью.
MOD_BASIS_DIRS = ("scripts", "models", "textures", "spawns",
                  "preview_config", "animations")


def _isdir(*parts: str) -> bool:
    try:
        return bool(parts[0]) and os.path.isdir(os.path.join(*parts))
    except Exception:  # noqa: BLE001
        return False


def check_mod_structure(path: str, overlay: bool = False) -> dict:
    """Папка годится корнем мода (overlay=False) или саб-путём (True).

    Строгое правило мода: внутри basis/ или dlc/. Оверлей мягче: чистые
    текстуры могут лежать и голыми папками textures//models//animations.
    Возвращает {ok, expected:[...], found:[...]} для попапа настроек.
    """
    root = os.path.normpath((path or "").strip())
    expected = ["basis/"] if not overlay else ["basis/", "dlc/",
                                               "textures/", "models/"]
    if not root or not os.path.isdir(root):
        return {"ok": False, "expected": expected, "found": []}
    found = []
    basis = os.path.join(root, "basis")
    if os.path.isdir(basis):
        found.append("basis/")
        for sub in MOD_BASIS_DIRS:
            if _isdir(basis, sub):
                found.append("basis/%s/" % sub)
    dlc = sorted(glob.glob(os.path.join(root, "dlc", "*", "basis")))
    if any(os.path.isdir(d) for d in dlc):
        found.append("dlc/")
    if overlay:
        for sub in ("textures", "models", "animations"):
            if _isdir(root, sub):
                found.append("%s/" % sub)
    ok = ("basis/" in found and len(found) > 1) or "dlc/" in found
    if overlay:
        ok = ok or any(f in found
                       for f in ("textures/", "models/", "animations/"))
    return {"ok": ok, "expected": expected, "found": found}


def layer_bases_union(mod_root: str, overlay: str = "") -> "list[str]":
    """basis-слои мода + оверлея: basis, dlc/*/basis каждого корня.

    Порядок: слои мода первые (свои файлы побеждают), затем оверлей.
    Дубли и несуществующие каталоги выкинуты.
    """
    bases: "list[str]" = []
    for root in (mod_root, overlay):
        if not root or not os.path.isdir(root):
            continue
        try:
            cands = [os.path.join(root, "basis")]
            cands += sorted(glob.glob(os.path.join(root, "dlc", "*", "basis")))
        except Exception:  # noqa: BLE001
            continue
        for b in cands:
            try:
                nb = os.path.normpath(b)
                if os.path.isdir(nb) and nb not in bases:
                    bases.append(nb)
            except Exception:  # noqa: BLE001
                continue
    return bases


def mod_subpaths(mod_root: str, overlay: str = "") -> dict:
    """Саб-пути для дропдауна настроек: {textures:[...], models:[...]}.

    Каждый элемент {rel, exists, where}: rel — путь вида
    basis/textures или dlc/<Имя>/basis/models; where — "mod"/"overlay"
    (где физически найден) либо "" (нет ни там, ни там).
    """
    groups = {"textures": [], "models": []}
    try:
        roots = []
        if mod_root and os.path.isdir(mod_root):
            roots.append((os.path.normpath(mod_root), "mod"))
        if overlay and os.path.isdir(overlay) and \
                os.path.normcase(os.path.normpath(overlay)) != \
                os.path.normcase(os.path.normpath(mod_root or "")):
            roots.append((os.path.normpath(overlay), "overlay"))
    except Exception:  # noqa: BLE001
        roots = []
    seen: "set[str]" = set()

    def add(rel: str, tails: tuple) -> None:
        if rel in seen:
            return
        seen.add(rel)
        try:
            tail = rel.split("basis/", 1)[1] if "basis/" in rel else rel
        except Exception:  # noqa: BLE001
            tail = ""
        if tail not in tails:
            return
        where, exists = "", False
        for root, tag in roots:
            try:
                if os.path.isdir(os.path.join(root, *rel.split("/"))):
                    where, exists = tag, True
                    break
            except Exception:  # noqa: BLE001
                continue
        groups["textures" if tails is _TEX_TAILS else "models"].append(
            {"rel": rel, "exists": exists, "where": where})

    for rel in TEX_SUBPATHS:
        add(rel, _TEX_TAILS)
    for rel in MODEL_SUBPATHS:
        add(rel, _MODEL_TAILS)
    # DLC-варианты: только реально существующие на диске (обоих корней).
    for root, _tag in roots:
        try:
            dlcs = sorted(glob.glob(os.path.join(root, "dlc", "*")))
        except Exception:  # noqa: BLE001
            continue
        for d in dlcs:
            try:
                name = os.path.basename(d.rstrip("\\/"))
                if not os.path.isdir(d):
                    continue
                for tail in _TEX_TAILS:
                    if os.path.isdir(os.path.join(d, "basis",
                                                  *tail.split("/"))):
                        add("dlc/%s/basis/%s" % (name, tail), _TEX_TAILS)
                for tail in _MODEL_TAILS:
                    if os.path.isdir(os.path.join(d, "basis",
                                                  *tail.split("/"))):
                        add("dlc/%s/basis/%s" % (name, tail), _MODEL_TAILS)
            except Exception:  # noqa: BLE001
                continue
    return groups
