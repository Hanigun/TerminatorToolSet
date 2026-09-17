"""DDS -> WebP конвертер на Pillow.

Чистый модуль: ничего не знает о программе, вызывается как независимая
функция (вручную, из icon_preload или bulk-эндпоинтом «Анализ» карты).
Качество WebP по умолчанию 85. Возвращает True/False вместо исключений,
чтобы пакетная конвертация не падала на одном битом файле.
"""
from __future__ import annotations

import os

QUALITY = 85

# Качество WebP по слоту материала (замер на 2K-текстурах Абрамса):
# albedo q80 −21% файла при −1.7 дБ (глазом неотличимо на модели),
# normal q75 −47% при −0.5 дБ (шейдинг идентичен), rough q75 −36%.
# method всегда 4: method 6 даёт +13с энкода ради −4% (ловушка).
# Неизвестный слот и иконки — 85.
QUALITY_BY_SLOT = {"albedo": 80, "normal": 75, "rough": 75}


def quality_for_slot(slot):
    """WebP-качество для слота материала (albedo|normal|rough)."""
    try:
        return int(QUALITY_BY_SLOT.get((slot or "").strip().lower(),
                                       QUALITY))
    except (TypeError, ValueError):
        return QUALITY


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


def normal_hints(path):
    """Подсказки нормали по дешёвым признакам (без декода пикселей):
    (normal_fix, normal_auto). fix — BC5U по FourCC (первые 128 байт);
    auto — имя похоже на нормаль (normal/normaal): контент-проверка
    едет внутри convert_file на уже декодированном кадре. Общее для
    /api/model_tex и фонового прогрева, чтобы не разъехаться."""
    try:
        if dds_fourcc(path) == b"BC5U":
            return (True, False)
    except Exception:  # noqa: BLE001
        pass
    try:
        stem = os.path.basename(path or "").lower()
    except Exception:  # noqa: BLE001
        stem = ""
    if "normal" in stem or "normaal" in stem:
        return (False, True)
    return (False, False)


def _bands_need_blue(rgb):
    """Контент-признак двухканальной normal-карты по готовым каналам:
    B плоский (~0), R/G разбросаны (XY нормалей). Без открытия файла —
    вызывается на уже декодированном изображении, чтобы не платить
    второй полный декод гигантских DDS (2K несжатый — секунды)."""
    try:
        r, g, b = rgb.split()[:3]
        if b.getextrema()[1] >= 8:
            return False
        rlo, rhi = r.getextrema()
        glo, ghi = g.getextrema()
        return (rhi - rlo) > 32 and (ghi - glo) > 32
    except Exception:  # noqa: BLE001
        return False


def dds_needs_blue_rebuild(path):
    """Контент-признак двухканальной normal-карты в любом контейнере.

    B-канал плоский (~0), а R/G разбросаны (XY нормалей):
    int_small_tug_normal.dds — DXT1 с нулевым B, FourCC BC5U её
    не ловит, и three.js нормализует (x, y, 0) — свет гаснет,
    модель «тёмная» при живых текстурах. Порог B<8 тот же, что
    и сторож внутри _rebuilt_bc5_blue; разброс R/G отсекает
    просто тёмные картинки. Отдельный проход — только для малых
    файлов; большие проверять через normal_auto в convert_file
    (там проверка едет на уже декодированном кадре)."""
    try:
        from PIL import Image
        with Image.open(path) as im:
            rgb = (im if im.mode in ("RGB", "RGBA")
                   else im.convert("RGB"))
            return _bands_need_blue(rgb)
    except Exception:  # noqa: BLE001
        return False


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
                 normal_fix: bool = False, normal_auto: bool = False) -> bool:
    """Сконвертировать один .dds в .webp. True при успехе.

    normal_fix — двухканальная нормаль точно (BC5 по FourCC):
    B пересобрать безусловно. normal_auto — «похоже на нормаль»
    по имени (normal/normaal): признак проверить на уже
    декодированном кадре, без второго открытия файла."""
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
        elif normal_auto:
            try:
                rgb = (im if im.mode in ("RGB", "RGBA")
                       else im.convert("RGB"))
                if _bands_need_blue(rgb):
                    fixed = _rebuilt_bc5_blue(im)
                    if fixed is not None:
                        im = fixed
            except Exception:  # noqa: BLE001
                pass
        im.save(dst, "WEBP", quality=q)
        return os.path.isfile(dst)
    except Exception:  # noqa: BLE001 - битый dds = False, не падение
        return False


def convert_task(job) -> tuple:
    """Одна задача для executor.map: (src, dst, quality[, ...]) -> (dst, ok).

    Модульная функция (picklable): отдельный процесс маппит её напрямую.
    Хвост кортежа (normal_fix, normal_auto) — опционален."""
    try:
        src, dst, quality = job[0], job[1], job[2]
        rest = tuple(job[3:])
    except (TypeError, ValueError, IndexError):
        return ("", False)
    nfix = bool(rest[0]) if len(rest) > 0 else False
    nauto = bool(rest[1]) if len(rest) > 1 else False
    ok = convert_file(src, dst, quality,
                      normal_fix=nfix, normal_auto=nauto)
    return (dst, ok)
