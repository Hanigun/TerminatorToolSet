"""Фоновый прогрев текстур: анализ + DDS->WebP заранее, с прогрессом.

Задача: первое открытие модели/иконки из холодного кэша висит по
секундам на гигантских несжатых DDS (2K — ~7с декод + энкод).
WarmupManager в отдельном daemon-потоке проходит все .dds слоёв
корня (basis + DLC, у мода — плюс его саб-пути ассеты/модели) и
греет webp-кэш через upr.dds_webp: свежий кэш (не старше исходника)
не трогается, повторный прогон — дешёвый проход по mtime.

Один прогон за раз (повторный start при running — просто статус).
Остановка — флагом, после текущего файла. Состояние потокобезопасно
(Lock), фронт опрашивает GET /api/warmup_status раз в секунду.
"""
from __future__ import annotations

import glob
import os
import threading


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
                                files.append(os.path.join(dirpath, fn))
                        if self._stop:
                            break
                    if self._stop:
                        break
                except Exception:  # noqa: BLE001
                    continue
            files.sort()
            self._set(phase="convert", total=len(files))
            # фаза 2: прогрев (dds_webp сам пропускает свежий кэш)
            try:
                from . import dds_converter as _dc
            except Exception:  # noqa: BLE001
                _dc = None
            done, failed = 0, 0
            for p in files:
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
                    r = self._upr.dds_webp(p, root=root, normal_fix=nr,
                                          normal_auto=na)
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
            self._set(running=False,
                      phase="stopped" if stopped else "done", current="")
