"""Single-instance guard: named mutex + pending-files mailbox on disk."""
from __future__ import annotations

import json
import os

from .filesystem import pick_app_dir


# -- mailbox directory -------------------------------------------------------
def instance_dir() -> str:
    """Folder holding lock + pending.json (second-launch file mailbox)."""
    base = os.environ.get("LOCALAPPDATA") or pick_app_dir()
    p = os.path.join(base, "TerminatorToolSet", "instance")
    try:
        os.makedirs(p, exist_ok=True)
    except Exception:  # noqa: BLE001
        pass
    return p


# -- mutex -------------------------------------------------------------------
def single_instance_lock():
    """Windows named mutex. True = first instance, False = already running."""
    try:
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.windll.kernel32
        h = k32.CreateMutexW(None, False, "TerminatorToolSet-v091-single-instance")
        if not h:
            return True, None
        already = k32.GetLastError() == 183  # ERROR_ALREADY_EXISTS
        if already:
            k32.CloseHandle(h)
            return False, None
        return True, h
    except Exception:  # noqa: BLE001
        # non-Windows / no ctypes: file-lock fallback
        try:
            import fcntl  # type: ignore
            fp = open(os.path.join(instance_dir(), "lock"), "w")
            try:
                fcntl.flock(fp, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return True, fp
            except OSError:
                return False, None
        except Exception:  # noqa: BLE001
            return True, None


# -- second-launch forwarding -------------------------------------------------
# Флаг restore.flag: второй процесс просит первый показаться из трея.
# Чистый Win32-показ (bring_first_to_front) ненадёжен для спрятанного окна:
# pywebview hide() + иконка трея требуют штатного restore_from_tray внутри
# первого процесса — его будит вотчер watch_restore_requests (window.py).
RESTORE_FLAG = "restore.flag"
FIRST_PID = "first.pid"
# Флаг window.request: трей browser-режима просит нативное окно. Текущий
# процесс завершается, новый ждёт освобождения мьютекса и стартует первым
# в оконном режиме (TS_WINDOW=1 перекрывает open_in_browser).
WINDOW_FLAG = "window.request"


def request_window() -> None:
    """Попросить нативное окно: оставить флаг для следующего процесса."""
    try:
        with open(os.path.join(instance_dir(), WINDOW_FLAG),
                  "w", encoding="utf-8") as fh:
            fh.write("window")
    except Exception:  # noqa: BLE001
        pass


def take_window_request() -> bool:
    """Забрать флаг window.request, True = просили стартовать окном."""
    box = os.path.join(instance_dir(), WINDOW_FLAG)
    try:
        if not os.path.isfile(box):
            return False
        try:
            os.remove(box)
        except Exception:  # noqa: BLE001
            pass
        return True
    except Exception:  # noqa: BLE001
        return False


def write_first_pid() -> None:
    """Первый процесс записывает свой pid: второй проверяет жив ли он."""
    try:
        with open(os.path.join(instance_dir(), FIRST_PID),
                  "w", encoding="utf-8") as fh:
            fh.write(str(os.getpid()))
    except Exception:  # noqa: BLE001
        pass


def first_alive() -> bool:
    """PID-файл + процесс с таким pid реально жив."""
    try:
        with open(os.path.join(instance_dir(), FIRST_PID),
                  "r", encoding="utf-8") as fh:
            pid = int((fh.read() or "").strip())
    except Exception:  # noqa: BLE001
        return False
    if pid <= 0:
        return False
    try:
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.windll.kernel32
        # QUERY_LIMITED_INFORMATION: GetExitCodeProcess по SYNCHRONIZE-only
        # хендлу падает с ACCESS_DENIED (ошибка 5)
        QUERY_LIMITED = 0x1000
        SYNCHRONIZE = 0x00100000
        h = k32.OpenProcess(QUERY_LIMITED | SYNCHRONIZE, False, pid)
        if not h:
            return False
        try:
            code = wintypes.DWORD()
            if not k32.GetExitCodeProcess(h, ctypes.byref(code)):
                return False
            return code.value == 259  # STILL_ACTIVE
        finally:
            k32.CloseHandle(h)
    except Exception:  # noqa: BLE001
        return False


def request_restore() -> None:
    """Второй процесс: оставить флаг показа + сразу дёрнуть окно Win32."""
    try:
        with open(os.path.join(instance_dir(), RESTORE_FLAG),
                  "w", encoding="utf-8") as fh:
            fh.write("show")
    except Exception:  # noqa: BLE001
        pass
    bring_first_to_front()


def take_restore() -> bool:
    """Первый процесс (вотчер): забрать флаг показа, True = просили окно."""
    box = os.path.join(instance_dir(), RESTORE_FLAG)
    try:
        if not os.path.isfile(box):
            return False
        try:
            os.remove(box)
        except Exception:  # noqa: BLE001
            pass
        return True
    except Exception:  # noqa: BLE001
        return False


def forward_to_first(args: "list[str]"):
    """Second launch: append file args to the first instance mailbox, exit."""
    try:
        box = os.path.join(instance_dir(), "pending.json")
        files = [a for a in args if a and os.path.exists(a)]
        if files:
            cur = []
            try:
                if os.path.isfile(box):
                    with open(box, "r", encoding="utf-8") as fh:
                        cur = json.load(fh) or []
            except Exception:  # noqa: BLE001
                cur = []
            cur.extend(files)
            with open(box, "w", encoding="utf-8") as fh:
                json.dump(cur[-32:], fh, ensure_ascii=False)
        # окно первого (особенно спрятанное в трей) — показать всегда,
        # даже без файлов: повторный запуск exe = «где программа»
        request_restore()
    except Exception:  # noqa: BLE001
        pass


def bring_first_to_front():
    """Raise the first instance window (title: Terminator ToolSet).

    Спрятанное в трей окно скрыто (hidden): SW_RESTORE его не всегда
    поднимает — сначала явный SW_SHOW, потом фокус. Штатное состояние
    (убрать иконку трея) докрутит вотчер первого по restore.flag."""
    try:
        import ctypes
        u32 = ctypes.windll.user32
        hwnd = u32.FindWindowW(None, "Terminator ToolSet")
        if hwnd:
            try:
                IsVisible = u32.IsWindowVisible(hwnd)
            except Exception:  # noqa: BLE001
                IsVisible = 0
            if not IsVisible:
                u32.ShowWindow(hwnd, 5)  # SW_SHOW — скрытое показать
            u32.ShowWindow(hwnd, 9)  # SW_RESTORE — развёрнутое вернуть
            u32.SetForegroundWindow(hwnd)
    except Exception:  # noqa: BLE001
        pass


def take_pending() -> "list[str]":
    """Drain the second-launch mailbox (existing paths only)."""
    box = os.path.join(instance_dir(), "pending.json")
    try:
        if not os.path.isfile(box):
            return []
        with open(box, "r", encoding="utf-8") as fh:
            data = json.load(fh) or []
        try:
            os.remove(box)
        except Exception:  # noqa: BLE001
            pass
        return [str(x) for x in data if isinstance(x, str) and os.path.exists(x)]
    except Exception:  # noqa: BLE001
        return []
