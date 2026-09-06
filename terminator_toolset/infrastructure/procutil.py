"""Добивка своих дочерних процессов (осиротевшие WebView2).

msedgewebview2-процессы переживают жёсткий выход (os._exit) и держат
профиль WebView2 занятым — следующий запуск тогда стартует «серым».
Чистим только ПРЯМЫХ детей нашего pid по имени бинарника: чужие
приложения (Teams и т.п.) не трогаем. Без зависимостей от пакета —
модуль используют и window, и update_service (иначе цикл импорта).
"""
from __future__ import annotations

import os

_WEBVIEW_NAMES = ("msedgewebview2.exe",)


def _log_silent(log, msg):
    try:
        if log is not None:
            log(msg)
    except Exception:  # noqa: BLE001
        pass


def _kill_children_ctypes(pid, names):
    """Детки pid с именами из names через Toolhelp-снапшот. Возвращает
    число прибитых или None, если ctypes-путь недоступен."""
    try:
        import ctypes
        from ctypes import wintypes
    except Exception:  # noqa: BLE001
        return None
    try:
        k32 = ctypes.windll.kernel32
        TH32CS_SNAPPROCESS = 0x00000002
        MAX_PATH = 260

        class _PE(ctypes.Structure):
            _fields_ = [("dwSize", wintypes.DWORD),
                        ("cntUsage", wintypes.DWORD),
                        ("th32ProcessID", wintypes.DWORD),
                        ("th32DefaultHeapID", ctypes.c_size_t),
                        ("th32ModuleID", wintypes.DWORD),
                        ("cntThreads", wintypes.DWORD),
                        ("th32ParentProcessID", wintypes.DWORD),
                        ("pcPriClassBase", wintypes.LONG),
                        ("dwFlags", wintypes.DWORD),
                        ("szExeFile", ctypes.c_wchar * MAX_PATH)]

        snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        if snap == wintypes.HANDLE(-1).value:
            return None
        try:
            pe = _PE()
            pe.dwSize = ctypes.sizeof(_PE)
            if not k32.Process32FirstW(snap, ctypes.byref(pe)):
                return None
            kids = []
            while True:
                try:
                    ppid = int(pe.th32ParentProcessID)
                    name = str(pe.szExeFile or "")
                except Exception:  # noqa: BLE001
                    ppid, name = 0, ""
                if ppid == pid and name.lower() in names:
                    kids.append(int(pe.th32ProcessID))
                if not k32.Process32NextW(snap, ctypes.byref(pe)):
                    break
            dead = 0
            for cpid in kids:
                try:
                    h = k32.OpenProcess(0x0001, False, cpid)  # PROCESS_TERMINATE
                    if not h:
                        continue
                    try:
                        if k32.TerminateProcess(h, 0):
                            dead += 1
                    finally:
                        k32.CloseHandle(h)
                except Exception:  # noqa: BLE001
                    continue
            return dead
        finally:
            k32.CloseHandle(snap)
    except Exception:  # noqa: BLE001
        return None


def _kill_children_ps(pid, names):
    """Запасной путь через CIM по ParentProcessId. Число прибитых."""
    try:
        import subprocess
        cond = " OR ".join(
            "Name='" + n.replace("'", "''") + "'" for n in names)
        ps = ("Get-CimInstance Win32_Process -Filter \"ParentProcessId="
              + str(int(pid)) + " AND (" + cond + ")\" | "
              + "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; "
              + "'done'")
        subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                       capture_output=True, timeout=20,
                       creationflags=0x08000000)  # CREATE_NO_WINDOW
        return 0
    except Exception:  # noqa: BLE001
        return 0


def kill_child_processes(names=_WEBVIEW_NAMES, pid=0, log=None):
    """Прибить дочерние процессы pid (по умолчанию свои) с именами names.
    Возвращает число прибитых (powershell-путь точное число не знает)."""
    try:
        pid = int(pid) or os.getpid()
    except (TypeError, ValueError):
        pid = os.getpid()
    want = tuple(n.lower() for n in (names or ()))
    if os.name != "nt" or not want:
        return 0
    dead = _kill_children_ctypes(pid, want)
    if dead is None:
        dead = _kill_children_ps(pid, want)
    if dead:
        _log_silent(log, "webview children killed: %d (pid %d)"
                    % (dead, pid))
    return int(dead or 0)
