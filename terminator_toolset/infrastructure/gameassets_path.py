"""Корень скачанных GameAssets: только чтение, последний слой данных.

Папка <program_dir>/GameAssets рядом с exe (dev — корень исходников).
Возвращается только при game_assets_downloaded == 1 и существующей папке.
"""
from __future__ import annotations

import os


def game_assets_root(config, program_dir: str) -> str:
    """Путь к GameAssets или '' (флаг не стоит / папки нет)."""
    try:
        flag = int(config.get("game_assets_downloaded") or 0)
    except (TypeError, ValueError):
        return ""
    if flag != 1:
        return ""
    try:
        base = os.path.normpath(program_dir or "")
    except Exception:  # noqa: BLE001
        return ""
    if not base:
        return ""
    cand = os.path.join(base, "GameAssets")
    try:
        if os.path.isdir(cand):
            return os.path.normpath(cand)
    except OSError:
        pass
    return ""
