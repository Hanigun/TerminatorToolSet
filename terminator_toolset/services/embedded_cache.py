"""Встроенные assets для frozen exe (п.6.1 ТЗ).

PyInstaller ONEDIR выносит datas рядом с exe (ToolSetLibs), внутрь самого
.exe попадают только python-модули (pyz). Поэтому assets/icons,
UprisingPresets и UprisingRandomizer пакуются сборкой
(compiler/embed_assets.py) в generated модуль _embedded_data (base64-zip
внутри pyz = физически внутри .exe), а здесь при первом обращении
распаковываются в локальный кэш
%LOCALAPPDATA%\\TerminatorToolSet\\_embedded\\<version>.

Из исходников (не frozen, sys.frozen отсутствует) — файлы читаются
напрямую из assets/icons, UprisingPresets и UprisingRandomizer,
кэш не используется.
"""
from __future__ import annotations

import base64
import io
import os
import sys
import zipfile

_CACHE_SUB = os.path.join("TerminatorToolSet", "_embedded")


def _cache_root() -> str:
    try:
        from terminator_toolset import __version__ as _ver
    except Exception:  # noqa: BLE001
        _ver = "0.0.0"
    base = os.environ.get("LOCALAPPDATA") or os.path.join(
        os.path.expanduser("~"), "AppData", "Local")
    return os.path.join(base, _CACHE_SUB, str(_ver))


def ensure() -> tuple:
    """(icons_dir, presets_dir, rnd_dir) из локального кэша или ("", "").

    Не frozen — всегда ("", ""): вызывающий код читает исходники напрямую.
    Кэш валиден, пока лежит маркер версии; первая распаковка — один раз.
    Кортеж из 3 элементов: старые вызовы ensure()[0]/[1] работают как раньше.
    """
    if not getattr(sys, "frozen", False):
        return ("", "")
    root = _cache_root()
    icons = os.path.join(root, "assets", "icons")
    presets = os.path.join(root, "UprisingPresets")
    rnd = os.path.join(root, "UprisingRandomizer")
    marker = os.path.join(root, ".ok")
    try:
        if os.path.isfile(marker):
            if (os.path.isdir(icons) and os.path.isdir(presets)
                    and os.path.isdir(rnd)):
                return (icons, presets, rnd)
    except OSError:
        return ("", "")
    try:
        from terminator_toolset import _embedded_data as _emb
        for attr, dest in (("ICONS_ZIP_B64", root),
                           ("PRESETS_ZIP_B64", root)):
            blob = getattr(_emb, attr, "")
            if not blob:
                return ("", "")
            with zipfile.ZipFile(io.BytesIO(base64.b64decode(blob))) as zf:
                zf.extractall(dest)
        if not (os.path.isdir(icons) and os.path.isdir(presets)
                and os.path.isdir(rnd)):
            return ("", "")
        os.makedirs(root, exist_ok=True)
        with open(marker, "w", encoding="utf-8") as fh:
            fh.write(getattr(_emb, "VERSION", ""))
        return (icons, presets, rnd)
    except Exception:  # noqa: BLE001 - битый кэш/модуль: молча мимо
        return ("", "")
