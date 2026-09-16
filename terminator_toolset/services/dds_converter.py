"""DDS -> WebP конвертер на Pillow.

Чистый модуль: ничего не знает о программе, вызывается как независимая
функция (вручную, из icon_preload или bulk-эндпоинтом «Анализ» карты).
Качество WebP по умолчанию 85. Возвращает True/False вместо исключений,
чтобы пакетная конвертация не падала на одном битом файле.
"""
from __future__ import annotations

import os

QUALITY = 85


def dds_fourcc(path):
    """FourCC DDS-файла (b'DXT1'/b'BC5U'/...) по заголовку, иначе b''.

    Дешево (первые 128 байт): признак двухканальных нормалей —
    по содержимому, а не по суффиксу имени (*_normal_v2.dds —
    тоже BC5, а маска имени его пропускала и давала чёрные
    поверхности).
    """
    try:
        with open(path, "rb") as f:
            head = f.read(128)
        if len(head) < 88 or head[:4] != b"DDS ":
            return b""
        return head[84:88]
    except OSError:
        return b""


def _rebuilt_bc5_blue(im):
    """Восстановить B-канал двухканальной (BC5) normal-карты.

    Игровой движок хранит нормали в двух каналах (R,G), а Z
    восстанавливает в шейдере: z = sqrt(1-x^2-y^2). Pillow отдаёт
    такие DDS с нулевым B, и three.js получает касательный вектор
    (x, y, -1) — освещение инвертируется: крыша чёрная, дно светлое.
    Пересчёт целочисленный (numpy нет): 6 итераций Ньютона в 'I'.
    Возвращает RGB(A)-образ или None при любой проблеме.
    """
    try:
        from PIL import Image, ImageMath
        has_a = im.mode == "RGBA"
        rgb = im if im.mode in ("RGB", "RGBA") else im.convert("RGB")
        bands = rgb.split()
        if bands[2].getextrema()[1] >= 8:
            return None  # B на месте — не BC5-пустышка
        w, h = im.size
        ev = ImageMath.lambda_eval
        mn = ImageMath.imagemath_min

        def _c(v):
            return Image.new("I", (w, h), v)

        # Прямые операторы на Image не поддерживаются — всё через
        # lambda_eval (внутри лямбды операнды обёрнуты и умеют +,-,*,/).
        x = ev(lambda a: a["v"] - a["c"], v=bands[0].convert("I"),
               c=_c(127))
        y = ev(lambda a: a["v"] - a["c"], v=bands[1].convert("I"),
               c=_c(127))
        s = ev(lambda a: mn(a["x"] * a["x"] + a["y"] * a["y"], 16256),
               x=x, y=y)
        t = ev(lambda a: a["c"] - a["s"], c=_c(16256), s=s)
        z = _c(127)
        for _ in range(6):
            z = ev(lambda a: (a["z"] + a["t"] / a["z"]) / a["two"],
                   z=z, t=t, two=_c(2))
        b = ev(lambda a: mn(a["z"] * a["k"] / a["d"], 255),
               z=z, k=_c(255), d=_c(127)).convert("L")
        out = Image.merge("RGBA" if has_a else "RGB",
                          (bands[0], bands[1], b) +
                          ((bands[3],) if has_a else ()))
        return out
    except Exception:  # noqa: BLE001 - тихо: caller сохранит как есть
        return None


def convert_file(src: str, dst: str, quality: int = QUALITY,
                 normal_fix: bool = False) -> bool:
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
        if normal_fix:
            fixed = _rebuilt_bc5_blue(im)
            if fixed is not None:
                im = fixed
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
