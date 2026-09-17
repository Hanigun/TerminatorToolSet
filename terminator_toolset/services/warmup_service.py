"""Фоновый прогрев текстур: анализ + DDS->WebP заранее, с прогрессом.

Задача: первое открытие модели/иконки из холодного кэша висит по
секундам на гигантских несжатых DDS (2K — ~7с декод + энкод).
WarmupManager в отдельном daemon-потоке проходит все .dds слоёв
корня (basis + DLC, у мода — плюс его саб-пути ассеты/модели) и
греет webp-кэш через upr.dds_webp: свежий кэш (не старше исходника)
не трогается, повторный прогон — дешёвый проход по mtime.

Раскладка кэша — CustomImages/<area>/<owner>/: иконки в icons/,
текстуры в textures/<модель-владелец> (без модели — shared).
Владельца текстур warmup вычисляет сам (фаза index): .material ->
текстуры, .model -> материалы (лёгкий байтовый regex, без полного
парсинга), инверсия texture -> первая модель (детерминированно).
Ручной просмотр передаёт модель запросом (&model=) — индекс там
не нужен.

Один прогон за раз (повторный start при running — просто статус).
Остановка — флагом, после текущего файла. Состояние потокобезопасно
(Lock), фронт опрашивает GET /api/warmup_status раз в секунду.
"""
from __future__ import annotations

import glob
import os
import re
import threading

_MODEL_MTRL_RX = re.compile(rb"materials/[ -~]{1,120}?\.material")


def _layer_dirs(root):
    """Папки слоёв данных корня: basis + dlc/*/basis (только живые)."""
    out = []
    try:
        b = os.path.join(root or "", "basis")
        if b and os.path.isdir(b):
            out.append(b)
        for d in sorted(glob.glob(os.path.join(root or "", "dlc", "*",
                                               "basis"))):
            try:
                if os.path.isdir(d) and d not in out:
                    out.append(d)
            except Exception:  # noqa: BLE001
                continue
    except Exception:  # noqa: BLE001
        pass
    return out


def _norm_rel(path, base):
    """Basis-относительный rel нижним регистром, прямые слеши."""
    try:
        rel = os.path.relpath(path, base).replace("\\", "/")
    except Exception:  # noqa: BLE001
        return ""
    if rel.startswith(".."):
        return ""
    return rel.lower()


def build_tex_owner_index(bases, stop_fn=None, progress_fn=None):
    """(owners, qualities): texture-rel -> стем модели-владельца
    и texture-rel -> WebP-качество (максимум по слотам, где текстура
    светится: albedo 80 держит верх над rough 75).

    bases — папки слоёв (basis/dlc). .material парсится целиком
    (мелкие файлы), из .model материалы дёргаются байтовым regex
    (полный парсинг тысяч моделей для индекса не нужен).
    Непокрытые текстуры зовутся shared с качеством по умолчанию."""
    mat_files, mod_files = [], []
    for b in bases or []:
        try:
            for dirpath, _dn, fns in os.walk(b):
                for fn in fns:
                    low = fn.lower()
                    if low.endswith(".material"):
                        mat_files.append(os.path.join(dirpath, fn))
                    elif low.endswith(".model"):
                        mod_files.append(os.path.join(dirpath, fn))
                if stop_fn is not None and stop_fn():
                    return {}, {}
        except Exception:  # noqa: BLE001
            continue
    mat_files.sort()
    mod_files.sort()
    total = len(mat_files) + len(mod_files)
    if progress_fn is not None:
        try:
            progress_fn(0, total)
        except Exception:  # noqa: BLE001
            pass
    mat_tex = {}
    mat_stem = {}
    tex_slots = {}
    try:
        from terminator_toolset.model3d.material_format import (
            read_material as _read_mat,
        )
        from terminator_toolset.services.dds_converter import (
            quality_for_slot as _q4s,
        )
    except Exception:  # noqa: BLE001
        _read_mat = None
        _q4s = None
    done = 0
    for p in mat_files:
        if stop_fn is not None and stop_fn():
            return {}, {}
        try:
            texs = set()
            if _read_mat is not None:
                m = _read_mat(p)
                for slot, v in (m.textures or {}).items():
                    v = str(v or "").replace("\\", "/").strip().lower()
                    if v:
                        texs.add(v)
                        tex_slots.setdefault(v, set()).add(slot)
            if texs:
                # ключ — normcase: rel из .model может отличаться
                # регистром от реального имени на диске
                mat_tex[os.path.normcase(p)] = texs
                try:
                    _ms = os.path.splitext(os.path.basename(p))[0]
                except Exception:  # noqa: BLE001
                    _ms = ""
                mat_stem[os.path.normcase(p)] = _ms
        except Exception:  # noqa: BLE001
            pass
        done += 1
        if progress_fn is not None and done % 25 == 0:
            try:
                progress_fn(done, total)
            except Exception:  # noqa: BLE001
                pass
    # кандидаты: текстура -> [(модель, материал)] (одну текстуру
    # делят десятки моделей: 33 ссылаются на fnd_abrams_new) —
    # владелец выбирается ниже по схожести имён
    cand = {}
    for p in mod_files:
        if stop_fn is not None and stop_fn():
            return {}, {}
        try:
            stem = os.path.splitext(os.path.basename(p))[0]
            # таблица материалов — в шапке или хвосте файла (у Abramса
            # все 6 ссылок в последних 2КБ 8.9МБ): читаем края вместо
            # полного разбора тысяч моделей (геометрия не нужна)
            with open(p, "rb") as f:
                try:
                    f.seek(0, 2)
                    size = f.tell()
                except OSError:
                    size = 0
                head = b""
                try:
                    f.seek(0)
                    head = f.read(65536)
                except OSError:
                    pass
                tail = b""
                if size > 65536:
                    try:
                        f.seek(max(0, size - 262144))
                        tail = f.read()
                    except OSError:
                        pass
            mats = sorted(set(_MODEL_MTRL_RX.findall(head + tail)))
            for mb in mats:
                mrel = mb.decode("ascii", "ignore").replace(
                    "\\", "/").lower()
                for b in bases or []:
                    mp = os.path.normpath(
                        os.path.join(b, *mrel.split("/")))
                    key = os.path.normcase(mp)
                    for t in mat_tex.get(key, ()):
                        cand.setdefault(t, []).append(
                            (stem, mat_stem.get(key, "")))
        except Exception:  # noqa: BLE001
            pass
        done += 1
        if progress_fn is not None and done % 25 == 0:
            try:
                progress_fn(done, total)
            except Exception:  # noqa: BLE001
                pass
    if progress_fn is not None:
        try:
            progress_fn(total, total)
        except Exception:  # noqa: BLE001
            pass
    owners = {}
    qualities = {}
    for t, pairs in cand.items():
        owners[t] = _best_owner(pairs)
    if _q4s is not None:
        for t, slots in tex_slots.items():
            try:
                qualities[t] = max(_q4s(s) for s in slots)
            except Exception:  # noqa: BLE001
                pass
    return owners, qualities


def _lcs_len(a, b):
    """Длина longest common substring (регистр уже нижний, стемы)."""
    if not a or not b:
        return 0
    if len(a) > len(b):
        a, b = b, a
    prev = [0] * (len(a) + 1)
    best = 0
    for cb in b:
        cur = [0]
        for i, ca in enumerate(a, 1):
            v = prev[i - 1] + 1 if ca == cb else 0
            cur.append(v)
            if v > best:
                best = v
        prev = cur
    return best


def _best_owner(pairs):
    """Владелец текстуры: модель, чьё имя ближе всего к имени
    материала (fnd_abrams_new -> fnd_abrams_chassis, а не случайный
    454534545_ap из 33 ссылающихся). Ничья — короткий стем, затем
    первый по сортировке: детерминированно."""
    best, best_key = "", None
    for stem, mstem in sorted(pairs):
        s = stem.lower()
        score = _lcs_len(s, (mstem or "").lower())
        key = (-score, len(s), s)
        if best_key is None or key < best_key:
            best_key, best = key, stem
    return best


class WarmupManager:
    """Один фоновый прогон прогрева; создаётся в фабрике (app.py)."""

    def __init__(self, upr):
        self._upr = upr
        self._lock = threading.Lock()
        self._state = {"running": False, "phase": "idle", "root": "",
                       "total": 0, "done": 0, "current": "",
                       "failed": 0, "stopped": False}
        self._stop = False

    def status(self):
        """Копия состояния для фронта."""
        try:
            with self._lock:
                return dict(self._state)
        except Exception:  # noqa: BLE001
            return {"running": False, "phase": "idle", "root": "",
                    "total": 0, "done": 0, "current": "",
                    "failed": 0, "stopped": False}

    def start(self, root):
        """Запустить прогон по корню; при running — текущий статус."""
        root = os.path.normpath(root or "")
        with self._lock:
            if self._state["running"]:
                return dict(self._state)
            if not root or not os.path.isdir(root):
                return dict(self._state)
            self._state.update(running=True, phase="scan", root=root,
                               total=0, done=0, current="", failed=0,
                               stopped=False)
            self._stop = False
        th = threading.Thread(target=self._run, args=(root,),
                              daemon=True, name="warmup")
        th.start()
        return self.status()

    def stop(self):
        """Попросить остановиться после текущего файла."""
        try:
            with self._lock:
                self._stop = True
        except Exception:  # noqa: BLE001
            pass
        return self.status()

    def _set(self, **kw):
        try:
            with self._lock:
                self._state.update(kw)
        except Exception:  # noqa: BLE001
            pass

    def _run(self, root):
        try:
            roots = [root]
            try:
                from . import model3d_service as _m3
                for ov in _m3.overlays_for(self._upr, root):
                    if ov not in roots:
                        roots.append(ov)
            except Exception:  # noqa: BLE001
                pass
            bases = []
            for r in roots:
                for b in _layer_dirs(r):
                    if b not in bases:
                        bases.append(b)
            # фаза 1: сбор списка (быстро, но на гигантских модах
            # видимая — фронт показывает scan)
            files = []
            for b in bases:
                try:
                    for dirpath, _dirnames, filenames in os.walk(b):
                        for fn in filenames:
                            if fn.lower().endswith(".dds"):
                                files.append((b, os.path.join(dirpath, fn)))
                        if self._stop:
                            break
                    if self._stop:
                        break
                except Exception:  # noqa: BLE001
                    continue
            files.sort(key=lambda t: t[1])
            self._set(phase="index", total=len(files))
            # фаза 2: владельцы текстур + качество по слотам
            # (фронт показывает тот же scan)
            owners, qualities = build_tex_owner_index(
                bases, stop_fn=lambda: self._stop,
                progress_fn=lambda d, t: self._set(done=d, total=t))
            if self._stop:
                self._set(phase="stopped", running=False, current="")
                return
            self._set(phase="convert", total=len(files), done=0)
            # фаза 3: прогрев (dds_webp сам пропускает свежий кэш)
            try:
                from . import dds_converter as _dc
            except Exception:  # noqa: BLE001
                _dc = None
            done, failed = 0, 0
            for b, p in files:
                if self._stop:
                    break
                try:
                    self._set(current=os.path.basename(p) or "")
                    nr, na = False, False
                    if _dc is not None:
                        try:
                            nr, na = _dc.normal_hints(p)
                        except Exception:  # noqa: BLE001
                            nr, na = False, False
                    rel = _norm_rel(p, b)
                    model = owners.get(rel, "") if rel else ""
                    q = qualities.get(rel) if rel else None
                    r = self._upr.dds_webp(p, root=root, normal_fix=nr,
                                          normal_auto=na, kind="texture",
                                          model=model or "shared",
                                          quality=q)
                    if not r:
                        failed += 1
                except Exception:  # noqa: BLE001
                    failed += 1
                done += 1
                if done % 5 == 0 or done == len(files):
                    self._set(done=done, failed=failed)
            self._set(done=done, failed=failed)
        finally:
            with self._lock:
                stopped = self._stop
            if self._state.get("running"):
                self._set(running=False,
                          phase="stopped" if stopped else "done", current="")
