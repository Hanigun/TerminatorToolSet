"""DDS -> WebP конвертер на Pillow.

Чистый модуль: ничего не знает о программе, вызывается как независимая
функция (вручную, из icon_preload или bulk-эндпоинтом «Анализ» карты).
Качество WebP по умолчанию 85. Возвращает True/False вместо исключений,
чтобы пакетная конвертация не падала на одном битом файле.
"""
from __future__ import annotations

import os

QUALITY = 85


def convert_file(src: str, dst: str, quality: int = QUALITY) -> bool:
    """Сконвертировать один .dds в .webp. True при успехе."""
    try:
        if not src or not dst:
            return False
        if not os.path.isfile(src):
            return False
        try:
            q = int(quality)
        except (TypeError, ValueError):
            q = QUALITY
        q = max(1, min(100, q))
        parent = os.path.dirname(os.path.abspath(dst))
        try:
            os.makedirs(parent, exist_ok=True)
        except OSError:
            return False
        from PIL import Image
        im = Image.open(src)
        im.load()
        if im.mode not in ("RGBA", "RGB"):
            im = im.convert("RGBA")
        im.save(dst, "WEBP", quality=q)
        return os.path.isfile(dst)
    except Exception:  # noqa: BLE001 - битый dds = False, не падение
        return False


def convert_task(job) -> tuple:
    """Одна задача для executor.map: (src, dst, quality) -> (dst, ok).

    Модульная функция (picklable): отдельный процесс маппит её напрямую.
    """
    try:
        src, dst, quality = job
    except (TypeError, ValueError):
        return ("", False)
    ok = convert_file(src, dst, quality)
    return (dst, ok)
