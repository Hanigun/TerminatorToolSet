"""Native window: pywebview/WebView2 frame, tray icon, file dialogs, DnD.

Moved verbatim out of main.py (Phase 3): geometry helpers, stale-WebView2
cleanup, the WM_DROPFILES filter, the boot watchdog and the js_api bridge
(Api), the splash launcher and the update-check stub.
"""
from __future__ import annotations

import os
import sys
import ctypes
import threading
import time
import webbrowser
from ctypes import wintypes

from ..application.bootstrap import boot_ping as _boot_ping
from ..application.state import add_pending_files
from ..services.update_service import Updates
from .filesystem import pick_app_dir as _pick_app_dir
from .logging import boot_log as _log
from .procutil import kill_child_processes as _kill_kids
from terminator_toolset import __version__ as _APP_VERSION


# GUI build has no console (spec console=False): powershell.exe is a
# console-subsystem binary and pops a visible console on every spawn unless
# told otherwise (the "second console" ghost at every app start).
def _nw_kwargs():
    import subprocess
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


def _clamp_to_workarea(w, h):
    """Never let the window exceed the visible screen work area (excludes the
    taskbar) - otherwise the bottom of the UI, including the table scrollbars,
    ends up outside the screen on smaller displays."""
    try:
        import ctypes
        import ctypes.wintypes
        rect = ctypes.wintypes.RECT()
        # SPI_GETWORKAREA = 0x0030
        if ctypes.windll.user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(rect), 0):
            avail_w = rect.right - rect.left
            avail_h = rect.bottom - rect.top
            return max(640, min(int(w), avail_w)), max(480, min(int(h), avail_h))
    except Exception as e:  # noqa: BLE001
        _log("workarea clamp: %s" % e)
    return int(w), int(h)


def _center_xy(w, h):
    """Логические координаты левого-верхнего угла, чтобы окно встало по центру
    рабочей области основного монитора. Нативный CenterScreen у pywebview не
    работает: дескриптор формы создаётся ДО присвоения StartPosition, и WinForms
    игнорирует его при показе. Поэтому включаем DPI-awareness сами, берём
    рабочую область (экран минус панель задач) и считаем центр явно; x/y при
    создании окна pywebview переводит в Location физически (логические*scale),
    а явная установка Location срабатывает даже после создания дескриптора."""
    try:
        import ctypes
        import ctypes.wintypes
        u32 = ctypes.windll.user32
        try:
            u32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        except Exception:  # noqa: BLE001
            try:
                ctypes.windll.shcore.SetProcessDpiAwareness(2)
            except Exception:  # noqa: BLE001
                pass
        dpi = 96
        try:
            dpi = int(u32.GetDpiForSystem()) or 96
        except Exception:  # noqa: BLE001
            pass
        scale = dpi / 96.0
        rect = ctypes.wintypes.RECT()
        # SPI_GETWORKAREA = 0x0030 (основной монитор, физические пиксели)
        if u32.SystemParametersInfoW(0x0030, 0, ctypes.byref(rect), 0):
            wa_w = (rect.right - rect.left) / scale
            wa_h = (rect.bottom - rect.top) / scale
            wa_x = rect.left / scale
            wa_y = rect.top / scale
            return (int(wa_x + max(0, (wa_w - w) / 2)),
                    int(wa_y + max(0, (wa_h - h) / 2)))
    except Exception as e:  # noqa: BLE001
        _log("center: %s" % e)
    return None


def _ps_like_escape(s: str) -> str:
    """Экранировать wildcard-символы -like (` * ? [ ])."""
    out = []
    for ch in s:
        if ch in ("`", "*", "?", "[", "]"):
            out.append("`")
        out.append(ch)
    return "".join(out)


def _kill_stale_webview(storage: str) -> None:
    """Убить осиротевшие msedgewebview2 ПРОШЛЫХ сессий нашего приложения.

    Один вызов powershell по cmdline-подстроке storage. Грубо (часть детей
    без пути в cmdline пропускает), но не висит: Restart Manager здесь был
    и умирал — RmGetList блокируется на hung-держателях ровно в нашем
    кейсе (занятый профиль). Остаток серого старта лечит вотчдог
    авто-рестартом процесса. Чужие приложения не трогаем (матч только по
    нашему storage-пути)."""
    try:
        import subprocess
        # БЕЗ .format: фигурные скобки PowerShell ({ ... }) ломали форматирование
        # ("unexpected '{' in field name") и роняли ВСЮ чистку на каждом запуске.
        # Конкатенация вместо.
        pat = _ps_like_escape(storage)
        ps = ("Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | "
              "Where-Object { $_.CommandLine -like '*" + pat.replace("'", "''") + "*' } | "
              "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }")
        subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                       capture_output=True, timeout=15, **_nw_kwargs())
    except Exception as e:  # noqa: BLE001
        _log("stale webview cleanup: %s" % e)


def _our_webview_count(storage: str) -> int:
    """Сколько живых msedgewebview2 ссылаются на НАШ storage-путь."""
    try:
        import subprocess
        pat = _ps_like_escape(storage)
        ps = ("Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | "
              "Where-Object { $_.CommandLine -like '*" + pat.replace("'", "''") + "*' } | "
              "Measure-Object | Select-Object -ExpandProperty Count")
        out = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                             capture_output=True, timeout=15, text=True,
                             **_nw_kwargs())
        return int((out.stdout or "0").strip() or 0)
    except Exception:  # noqa: BLE001
        return 0


def _wait_stale_webview_gone(storage: str, timeout: float = 10.0) -> None:
    """Пауза после чистки сирот: Edge-процессы дохнут асинхронно.

    Фиксированная пауза 2с + одна проверка для лога. Если профиль всё
    ещё занят — стартуем как есть, серый старт лечит вотчдог перезагрузкой."""
    if _our_webview_count(storage) == 0:
        return
    _log("stale webview: orphans found, waiting 2s for profile release")
    time.sleep(2.0)
    try:
        left = _our_webview_count(storage)
    except Exception:  # noqa: BLE001
        left = -1
    if left == 0:
        _log("stale webview: profile released")
    else:
        _log("stale webview: %s process(es) still alive, start anyway" % left)


def _on_dropfiles(hdrop: int) -> None:
    """Пути из нативного WM_DROPFILES -> mailbox (фронт заберёт poll'ом)."""
    try:
        import ctypes
        from ctypes import wintypes
        shell32 = ctypes.windll.shell32
        shell32.DragQueryFileW.argtypes = [wintypes.HANDLE, wintypes.UINT,
                                           wintypes.LPWSTR, wintypes.UINT]
        shell32.DragQueryFileW.restype = wintypes.UINT
        shell32.DragFinish.argtypes = [wintypes.HANDLE]
        try:
            n = int(shell32.DragQueryFileW(hdrop, 0xFFFFFFFF, None, 0))
        except Exception:  # noqa: BLE001
            return
        paths = []
        for i in range(min(n, 64)):
            buf = ctypes.create_unicode_buffer(32768)
            try:
                if shell32.DragQueryFileW(hdrop, i, buf, len(buf)) and buf.value:
                    paths.append(buf.value)
            except Exception:  # noqa: BLE001
                pass
        try:
            shell32.DragFinish(hdrop)
        except Exception:  # noqa: BLE001
            pass
        if paths:
            add_pending_files(paths)
            _log("drop: %d path(s) to mailbox" % len(paths))
    except Exception as e:  # noqa: BLE001
        _log("drop: %s" % e)


def _install_drop_filter(form):
    """Нативный приём файлов/папок, брошенных в окно (WM_DROPFILES).

    WebView2 НЕ отдаёт в JS пути дропа (только имена) — поэтому drop файла
    или папки вне известных корней молча не открывался, а кнопки (нативный
    диалог с полным путём) работали.     Дроп реально приземляется на дочерний
    HWND WebView2, а не на форму, причём WebView2 держит там свой OLE drop
    target (дроп уходит в Chromium без путей, WM_DROPFILES не возникает) —
    снять его нельзя (чужой COM-поток), поэтому ставим на потомков СВОЙ
    IDropTarget первым (см. _register_drop_target), а приёмник формы и
    подмену wndproc держим как запасные пути: пути уходят в mailbox,
    фронт забирает их штатным poll'ом (файл -> openFile, папка -> loadProject
    — ровно как кнопки). Возвращает True (держать нечего: ссылки на хуки
    живут в _DROP_HOOKS).
    IMessageFilter здесь НЕ используется: pythonnet не умеет реализовать
    интерфейс с одним byref-аргументом («interface takes exactly one
    argument»), поэтому этот путь всегда падал."""
    _install_drop_child_hook(form)
    return True


# -- перехват дропа на дочерних окнах ------------------------------------------
# Дроп реально приземляется НЕ на форму, а на дочерний HWND WebView2.
# WebView2 регистрирует на нём СВОЙ OLE drop target (причём из чужого
# COM-потока: RevokeDragDrop отдаёт RPC_E_WRONG_THREAD), поэтому дропы
# Проводника уходят в Chromium (там видны только имена, без путей),
# WM_DROPFILES вообще не возникает, а приёмник формы не вызывается
# (глубокое окно с целью всегда выигрывает у предков). Вытеснить цель
# Chromium нельзя — но можно ОБОГНАТЬ: окна рендера пересоздаются, цель
# периодически отсутствует (DRAGDROP_E_NOTREGISTERED), и тогда мы ставим
# СВОЙ IDropTarget первым (RegisterDragDrop, чистый ctypes без зависимостей);
# поздняя регистрация Chromium после этого падает с ALREADYREGISTERED и
# дропы идут к нам с полными путями. Сторож повторяет попытку каждый
# проход. Пути уходят в mailbox, фронт забирает их штатным poll'ом
# (файл -> openFile, папка -> loadProject — ровно как кнопки).
_DROP_HOOKS = {}  # hwnd -> (new_proc, old_proc): держать, иначе GC убьёт
_DROP_OLE_FORM = False  # DragEnter/DragDrop на форму уже подписаны
_DROP_TARGET_HWNDS = set()  # HWND, где стоит НАШ IDropTarget
_DRAGDROP_E_NOTREGISTERED = -2147221248  # 0x80040100
_DRAGDROP_E_ALREADYREGISTERED = -2147221247  # 0x80040101


class _DropFormatEtc(ctypes.Structure):
    _fields_ = [("cfFormat", wintypes.WORD),
                ("ptd", wintypes.LPVOID),
                ("dwAspect", wintypes.DWORD),
                ("lindex", wintypes.LONG),
                ("tymed", wintypes.DWORD)]


class _DropStgMedium(ctypes.Structure):
    _fields_ = [("tymed", wintypes.DWORD),
                ("hGlobal", wintypes.HGLOBAL),
                ("pUnkForRelease", wintypes.LPVOID)]


class _DropTargetObj(ctypes.Structure):
    _fields_ = [("lpVtbl", ctypes.POINTER(ctypes.c_void_p))]


def _hdrop_paths(pDataObj):
    """Полные пути из IDataObject дропа (CF_HDROP)."""
    ole32 = ctypes.windll.ole32
    shell32 = ctypes.windll.shell32
    CF_HDROP, DVASPECT_CONTENT, TYMED_HGLOBAL = 15, 1, 1
    GETDATA_T = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p,
                                   ctypes.POINTER(_DropFormatEtc),
                                   ctypes.POINTER(_DropStgMedium))
    vtable = ctypes.cast(
        ctypes.cast(pDataObj, ctypes.POINTER(ctypes.c_void_p)).contents,
        ctypes.POINTER(ctypes.c_void_p))
    fmt = _DropFormatEtc(CF_HDROP, None, DVASPECT_CONTENT, -1, TYMED_HGLOBAL)
    stg = _DropStgMedium()
    hr = GETDATA_T(vtable[3])(pDataObj, ctypes.byref(fmt), ctypes.byref(stg))
    _DROP_HOOKS.setdefault("getdata", (GETDATA_T,))  # тип держать живым
    if int(hr) != 0 or not stg.hGlobal:
        return []
    try:
        shell32.DragQueryFileW.argtypes = [wintypes.HGLOBAL, wintypes.UINT,
                                            wintypes.LPWSTR, wintypes.UINT]
        shell32.DragQueryFileW.restype = wintypes.UINT
        n = int(shell32.DragQueryFileW(stg.hGlobal, 0xFFFFFFFF, None, 0))
        out = []
        for i in range(min(n, 128)):
            buf = ctypes.create_unicode_buffer(32768 // 2)
            if shell32.DragQueryFileW(stg.hGlobal, i, buf, len(buf)):
                out.append(buf.value)
        return out
    finally:
        try:
            ole32.ReleaseStgMedium.argtypes = [
                ctypes.POINTER(_DropStgMedium)]
            ole32.ReleaseStgMedium.restype = None
            ole32.ReleaseStgMedium(ctypes.byref(stg))
        except Exception:  # noqa: BLE001
            pass


def _register_drop_target(hwnd, confirm=False, quiet=False):
    """Поставить НАШ IDropTarget на hwnd. True = дропы теперь идут к нам.

    confirm: hwnd уже в _DROP_TARGET_HWNDS — бесконтактная проверка жива ли
    цель через повторный RegisterDragDrop (ALREADYREGISTERED = стоит наша,
    S_OK = молча восстановили). Без revoke: зондировать отзывом нельзя —
    он же и убивает нашу цель (именно так сторож гасил сам себя)."""
    if hwnd in _DROP_TARGET_HWNDS and not confirm:
        return True
    try:
        ole32 = ctypes.windll.ole32
        ole32.RegisterDragDrop.argtypes = [wintypes.HWND, ctypes.c_void_p]
        ole32.RegisterDragDrop.restype = ctypes.c_long
    except Exception as e:  # noqa: BLE001
        if not quiet:
            _log("drop: target ole unavailable: %s" % e)
        return False
    if confirm:
        # COM-объекты построены и держатся списком в _DROP_HOOKS["targets"]
        try:
            punk = _DROP_HOOKS["targets"][0][3]
            hr = int(ole32.RegisterDragDrop(wintypes.HWND(hwnd),
                                            ctypes.c_void_p(punk)))
        except Exception:  # noqa: BLE001
            _DROP_TARGET_HWNDS.discard(hwnd)
            return False
        if hr == 0 or hr == _DRAGDROP_E_ALREADYREGISTERED:
            return True
        # цель потеряна (окно пересоздано? хэндл чужой) — снять метку,
        # следующий проход обработает как новое окно
        if not quiet:
            _log("drop: target confirm %d: hr=%d" % (hwnd, hr))
        _DROP_TARGET_HWNDS.discard(hwnd)
        return False
    try:
        QI_T = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p,
                                  ctypes.c_void_p,
                                  ctypes.POINTER(ctypes.c_void_p))
        REF_T = ctypes.WINFUNCTYPE(wintypes.ULONG, ctypes.c_void_p)
        ENTER_T = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p,
                                     ctypes.c_void_p, wintypes.UINT,
                                     wintypes.POINT,
                                     ctypes.POINTER(wintypes.DWORD))
        # DragOver БЕЗ pDataObj: (this, grfKeyState, pt, pdwEffect).
        # Общий тип с DragEnter здесь = разбаланс стека и падение процесса
        # при первом же наведении драга (именно так и крашилось).
        OVER_T = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p,
                                    wintypes.UINT, wintypes.POINT,
                                    ctypes.POINTER(wintypes.DWORD))
        LEAVE_T = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p)
        DROP_T = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p,
                                    ctypes.c_void_p, wintypes.UINT,
                                    wintypes.POINT,
                                    ctypes.POINTER(wintypes.DWORD))
        refcount = [1]

        def _qi(this, _riid, ppv):
            try:
                ppv[0] = this  # принимаем любой IID (нужен только IDropTarget)
                refcount[0] += 1
            except Exception:  # noqa: BLE001
                pass
            return 0

        def _addref(_this):
            refcount[0] += 1
            return refcount[0]

        def _release(_this):
            refcount[0] = max(0, refcount[0] - 1)
            return refcount[0]

        def _enter(_this, _data, _keys, _pt, effect):
            try:
                effect.contents.value = 1  # DROPEFFECT_COPY
            except Exception:  # noqa: BLE001
                pass
            return 0

        def _over(_this, _keys, _pt, effect):
            try:
                effect.contents.value = 1  # DROPEFFECT_COPY
            except Exception:  # noqa: BLE001
                pass
            return 0

        def _leave(_this):
            return 0

        def _drop(_this, data, _keys, _pt, effect):
            try:
                effect.contents.value = 1  # DROPEFFECT_COPY
            except Exception:  # noqa: BLE001
                pass
            try:
                paths = _hdrop_paths(int(data))
                if paths:
                    add_pending_files(paths)
                    _log("drop: target %d path(s) to mailbox" % len(paths))
                else:
                    _log("drop: target fired, no HDROP paths")
            except Exception as ex:  # noqa: BLE001
                _log("drop: target %s" % ex)
            return 0

        # vt: QI, AddRef, Release, DragEnter, DragOver, DragLeave, Drop
        cbs = (QI_T(_qi), REF_T(_addref), REF_T(_release),
               ENTER_T(_enter), OVER_T(_over), LEAVE_T(_leave),
               DROP_T(_drop))
        vtbl = (ctypes.c_void_p * 7)(*[ctypes.cast(cb, ctypes.c_void_p)
                                       for cb in cbs])
        obj = _DropTargetObj(ctypes.cast(vtbl, ctypes.POINTER(ctypes.c_void_p)))
        punk = ctypes.addressof(obj)
        hr = int(ole32.RegisterDragDrop(wintypes.HWND(hwnd),
                                        ctypes.c_void_p(punk)))
        if hr == 0:
            # держать ВСЁ живым, иначе GC убьёт COM-объект на первом дропе.
            # Целей НЕСКОЛЬКО (своя на каждое окно) — держим списком: прежний
            # setdefault хранил только первую, остальные окна указывали
            # в освобождённую память и дропы молча умирали.
            _DROP_HOOKS.setdefault("targets", []).append((cbs, vtbl, obj, punk))
            _DROP_TARGET_HWNDS.add(hwnd)
            return True
        if hr != _DRAGDROP_E_ALREADYREGISTERED and not quiet:
            _log("drop: target register %d: hr=%d" % (hwnd, hr))
        return False
    except Exception as e:  # noqa: BLE001
        _log("drop: target: %s" % e)
        return False


def _install_drop_ole_form(form):
    """AllowDrop + DragEnter/DragDrop на форме (GUI-поток).

    Вызывается КАЖДЫМ проходом: переподтверждает приёмник формы
    (AllowDrop False->True перерегистрирует OLE-цель), потому что его мог
    снять чужой RevokeDragDrop — включая наш собственный по корневому HWND
    до введения защиты. Подписки на события — один раз."""
    global _DROP_OLE_FORM
    try:
        from System.Windows.Forms import DataFormats, DragDropEffects
    except Exception as e:  # noqa: BLE001
        _log("drop: ole winforms unavailable: %s" % e)
        return
    try:
        if not _DROP_OLE_FORM:
            def _on_drag_enter(_sender, e):
                try:
                    if e.Data.GetDataPresent(DataFormats.FileDrop):
                        e.Effect = DragDropEffects.Copy
                    else:
                        # DragDropEffects.None — ключевое слово в Python
                        e.Effect = getattr(DragDropEffects, "None")
                except Exception:  # noqa: BLE001
                    pass

            def _on_drag_drop(_sender, e):
                try:
                    data = e.Data.GetData(DataFormats.FileDrop)
                    paths = [str(p) for p in data] if data else []
                    if paths:
                        add_pending_files(paths)
                        _log("drop: ole %d path(s) to mailbox" % len(paths))
                    else:
                        try:
                            fmts = [str(f) for f in e.Data.GetFormats()]
                        except Exception:  # noqa: BLE001
                            fmts = ["?"]
                        _log("drop: ole no FileDrop, formats=%s" % fmts)
                except Exception as ex:  # noqa: BLE001
                    _log("drop: ole %s" % ex)

            form.AllowDrop = True
            form.DragEnter += _on_drag_enter
            form.DragDrop += _on_drag_drop
            # держать делегаты на модуле, иначе GC убьёт подписки
            _DROP_HOOKS.setdefault("ole", (_on_drag_enter, _on_drag_drop))
            _DROP_OLE_FORM = True
            _log("drop: ole form drop installed")
        else:
            # переподтвердить цель (дешёво, чинит снятую регистрацию)
            form.AllowDrop = False
            form.AllowDrop = True
    except Exception as e:  # noqa: BLE001
        _log("drop: ole form: %s" % e)


def _install_drop_child_hook(form):
    """DragAcceptFiles + subclass на всех потомков формы (GUI-поток)."""
    try:
        import ctypes
        from ctypes import wintypes
    except Exception as e:  # noqa: BLE001
        _log("drop: ctypes unavailable: %s" % e)
        return
    try:
        root = int(form.Handle.ToInt64())
    except Exception as e:  # noqa: BLE001
        _log("drop: no form handle: %s" % e)
        return
    try:
        user32 = ctypes.windll.user32
        shell32 = ctypes.windll.shell32
        ole32 = ctypes.windll.ole32
        ole32.RevokeDragDrop.argtypes = [wintypes.HWND]
        ole32.RevokeDragDrop.restype = ctypes.c_long  # HRESULT
        WM_DROPFILES = 0x233
        GWLP_WNDPROC = -4
        # LRESULT = LONG_PTR: в ctypes.wintypes его нет, берём c_ssize_t
        WNDPROC_T = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, wintypes.HWND,
                                       wintypes.UINT, wintypes.WPARAM,
                                       wintypes.LPARAM)
        user32.SetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int,
                                             wintypes.LPVOID]
        user32.SetWindowLongPtrW.restype = wintypes.LPVOID
        user32.CallWindowProcW.argtypes = [wintypes.LPVOID, wintypes.HWND,
                                           wintypes.UINT, wintypes.WPARAM,
                                           wintypes.LPARAM]
        user32.CallWindowProcW.restype = ctypes.c_ssize_t

        def _wndproc(hwnd, msg, wparam, lparam):
            if int(msg) == WM_DROPFILES:
                try:
                    _on_dropfiles(int(wparam))
                except Exception as ex:  # noqa: BLE001
                    _log("drop: %s" % ex)
                return 0  # съели: Chromium свой drop уже не обработает
            old = _DROP_HOOKS.get(int(hwnd), (None, None))[1]
            if old:
                try:
                    return user32.CallWindowProcW(old, hwnd, msg, wparam, lparam)
                except Exception:  # noqa: BLE001
                    pass
            return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

        user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR,
                                         ctypes.c_int]
        user32.GetClassNameW.restype = ctypes.c_int

        def _cls(hwnd):
            try:
                buf = ctypes.create_unicode_buffer(256)
                n = user32.GetClassNameW(wintypes.HWND(hwnd), buf, 256)
                return buf.value if n else "?"
            except Exception:  # noqa: BLE001
                return "?"

        hooked = [0]
        revoked = [0]
        owned = [0]
        details = []

        def _hook_one(hwnd):
            hwnd = int(hwnd)
            cls = _cls(hwnd)
            # Наша цель стоит: НЕ зондировать отзывом (он её и убивает),
            # только бесконтактно подтвердить повторным RegisterDragDrop.
            if hwnd != root and hwnd in _DROP_TARGET_HWNDS:
                if _register_drop_target(hwnd, confirm=True, quiet=True):
                    owned[0] += 1
                    cls += "+OK"
                if len(details) < 16:
                    details.append("%s/hr=ok" % cls)
                return
            # OLE-приёмник снимаем у потомков, но НИКОГДА у корня: на корне
            # висит приёмник самой формы (AllowDrop) — его снятие убивает
            # наш приём дропа. S_OK=0 — сняли, иначе пишем hr.
            # Повторные проходы тоже снимают: WebView2 перерегистрирует свой
            # target поздно (после навигации/старта рендера).
            try:
                hr = (int(ole32.RevokeDragDrop(wintypes.HWND(hwnd)))
                      if hwnd != root else -999)
            except Exception:  # noqa: BLE001
                hr = -1
            if hr == 0:
                revoked[0] += 1
            # окно свободно (сняли чужой или ничего не было) — ставим СВОЙ
            # IDropTarget первым; поздняя регистрация Chromium упрётся в
            # ALREADYREGISTERED и дропы с полными путями пойдут к нам.
            # Корень пропускаем (там приёмник формы).
            if (hwnd != root and hwnd not in _DROP_TARGET_HWNDS
                    and hr in (0, _DRAGDROP_E_NOTREGISTERED)):
                if _register_drop_target(hwnd):
                    owned[0] += 1
                    cls += "+OWN"
            if len(details) < 16:
                details.append("%s/hr=%d" % (cls, hr))
            if hwnd in _DROP_HOOKS:
                return
            try:
                shell32.DragAcceptFiles(ctypes.c_void_p(hwnd), True)
            except Exception:  # noqa: BLE001
                pass
            try:
                new_proc = WNDPROC_T(_wndproc)
                old = user32.SetWindowLongPtrW(
                    wintypes.HWND(hwnd), GWLP_WNDPROC,
                    ctypes.cast(new_proc, wintypes.LPVOID))
                if old:
                    _DROP_HOOKS[hwnd] = (new_proc, old)
                    hooked[0] += 1
            except Exception as e:  # noqa: BLE001
                _log("drop: subclass %d: %s" % (hwnd, e))

        ENUMPROTO = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND,
                                       wintypes.LPARAM)

        def _enum_cb(hwnd, _lp):
            _hook_one(int(hwnd) if not hasattr(hwnd, "value") else hwnd.value)
            return True

        enum_cb = ENUMPROTO(_enum_cb)
        user32.EnumChildWindows.argtypes = [wintypes.HWND, ENUMPROTO,
                                            wintypes.LPARAM]
        user32.EnumChildWindows(wintypes.HWND(root), enum_cb, 0)
        # и саму форму тоже (рамка, кастомный титлбар)
        _hook_one(root)
        # ссылки держать на модуле, иначе GC убьёт колбэки
        _DROP_HOOKS.setdefault(0, (enum_cb, None))
        _install_drop_ole_form(form)
        try:
            elevated = bool(ctypes.windll.shell32.IsUserAnAdmin())
        except Exception:  # noqa: BLE001
            elevated = False
        _log("drop: child hooks installed: %d, ole revoked: %d, own target: %d, "
             "admin=%s; %s"
             % (hooked[0], revoked[0], owned[0], elevated, "; ".join(details)))
        if elevated:
            _log("drop: процесс с правами админа — UIPI режет дроп "
                 "из Проводника, запускай без повышения")
    except Exception as e:  # noqa: BLE001
        _log("drop: child hook: %s" % e)


def run_pywebview(config, url, app=None, app_dir=None):
    """pywebview-окно (WebView2): как в исходном TerminatorSheet. Отсутствие
    проблем с производительностью/драгом подтверждено эксплуатацией."""
    from config import WINDOW_SIZES
    try:
        import webview
    except Exception as e:  # noqa: BLE001
        _log("mode=browser-fallback (%s)" % e)
        print("pywebview unavailable (%s) - opening browser: %s" % (e, url))
        webbrowser.open(url)
        keep_alive()
        return

    # -- постоянный профиль WebView2 ------------------------------------------
    # private_mode=True (по умолчанию) создаёт temp-каталог на каждый запуск и
    # удаляет его при выходе; если файлы ещё заняты браузерным процессом,
    # сыпется "[WinError 32] Процесс не может получить доступ к файлу ...
    # EBWebView ...". Постоянный профиль ничего не удаляет (ошибки нет) и
    # заодно ускоряет повторный запуск (тёплый кэш).
    storage = os.path.join(
        os.environ.get("LOCALAPPDATA") or app_dir, "TerminatorToolSet", "WebView2")
    try:
        os.makedirs(storage, exist_ok=True)
    except Exception as e:  # noqa: BLE001
        _log("webview storage: %s" % e)
    _kill_stale_webview(storage)
    _wait_stale_webview_gone(storage)

    # -- вотчдог «серого старта» ----------------------------------------------
    # WebView2 иногда отдаёт страницу, но НЕ исполняет JS: main_ready не
    # приходит, окно остаётся скрытым ("запускается через раз"). Следим со
    # стороны сервера: фронт в init() первым делом шлёт POST /api/boot_progress
    # с pct=25. Не пришёл - проверяем жив ли фронт (window.__tshBooted) и перезагружаем.
    boot = {"seen": False}

    def _boot_request_hook():
        # booted = настоящий фронт и только он. GET /api/config НЕ годится:
        # его может прислать что угодно (диагностика, второй процесс) — был
        # случай: вотчдог принял чужой GET за оживший фронт и прекратил
        # лечение мёртвого окна.
        try:
            from flask import request as _req
            if _req.path == "/api/boot_progress" and _req.method == "POST":
                try:
                    pct = int((_req.get_json(silent=True) or {}).get("pct") or 0)
                except (TypeError, ValueError):
                    pct = 0
                if pct >= 25:
                    boot["seen"] = True
        except Exception:  # noqa: BLE001
            pass

    if app is not None:
        app.before_request(_boot_request_hook)

    def _boot_watchdog():
        import time as _t
        fails = 0  # подряд evaluate failed = контроллер мёртв, reload не лечит
        for attempt in range(6):
            _t.sleep(4)
            if boot["seen"]:
                if not boot.get("logged"):
                    boot["logged"] = True
                    _log("boot watchdog: booted (config seen)")
                return
            win = api._main
            if win is None:
                continue   # главное окно ещё не создано (проверка обновлений)
            try:
                alive = win.evaluate_js("!!window.__tshBooted")
                fails = 0
            except Exception as e:  # noqa: BLE001
                _log("boot watchdog: evaluate failed: %s" % e)
                alive = None
                fails += 1
                if fails >= 2:
                    # два провала подряд: контроллер мёртв (серый старт),
                    # load_url его не воскресит — сразу к self-restart
                    _log("boot watchdog: controller dead, skip reload")
                    break
            if alive:
                _log("boot watchdog: page alive w/o config request; skip reload")
                return
            _log("boot watchdog: no config request, reload (try %d)" % (attempt + 1))
            try:
                # load_url на мёртвом контроллере висит ~20с: в фоне + join
                # с таймаутом, вотчдог не должен ползти минуты
                box = []
                _t_done = threading.Event()

                def _reload():
                    try:
                        win.load_url(url)
                    except Exception as e:  # noqa: BLE001
                        box.append(str(e))
                    finally:
                        _t_done.set()

                threading.Thread(target=_reload, daemon=True,
                                 name="boot-reload").start()
                if not _t_done.wait(10):
                    _log("boot watchdog: load_url hung, continue watch")
                elif box:
                    _log("boot watchdog: load_url failed: %s" % box[0])
                    return
            except Exception as e:  # noqa: BLE001
                _log("boot watchdog: load_url failed: %s" % e)
                return
        # все попытки исчерпаны: мёртвый контроллер лечится только новым
        # процессом (сироты к этому моменту уже прибиты чисткой). До 2
        # авто-рестартов через TS_BOOT_TRY, дальше — текст в лаунчере.
        if not boot["seen"]:
            try:
                ntry = int(os.environ.get("TS_BOOT_TRY") or 0)
            except (TypeError, ValueError):
                ntry = 0
            if ntry < 2:
                _log("boot watchdog: window dead, self-restart (try %d)"
                     % (ntry + 1))
                try:
                    _kill_kids(log=_log)
                except Exception:  # noqa: BLE001
                    pass
                try:
                    import subprocess as _sp
                    if getattr(sys, "frozen", False):
                        cmd = [sys.executable] + sys.argv[1:]
                    else:
                        cmd = [sys.executable,
                               os.path.abspath(sys.argv[0])] + sys.argv[1:]
                    env = dict(os.environ)
                    env["TS_BOOT_TRY"] = str(ntry + 1)
                    _sp.Popen(cmd, env=env, close_fds=True)
                except Exception as e:  # noqa: BLE001
                    _log("boot watchdog: self-restart failed: %s" % e)
                    _boot_ping(app, 18,
                               "Окно не запустилось — закройте и запустите снова")
                    return
                os._exit(0)
                return
            _log("boot watchdog: window did not start, close and restart the app")
            _boot_ping(app, 18, "Окно не запустилось — закройте и запустите снова")

    class Api:
        # ВАЖНО: ссылки на окна хранятся ТОЛЬКО в атрибутах с подчёркиванием.
        # pywebview при инъекции моста рекурсивно обходит публичные атрибуты
        # js_api; объект Window тянет за собой .native/.NET-свойства - отсюда
        # были "Error while processing main.native..." и
        # "CoreWebView2Controller members can only be accessed from the UI
        # thread" при старте.
        _main = None      # главное окно (создаётся после проверки обновлений)
        _splash = None    # окно-лаунчер
        _ready = False    # main_ready пришёл раньше, чем создано главное окно
        _drop_filter = None  # маркер установки нативного дропа (хуки в _DROP_HOOKS)

        def _win(self):
            if self._main is not None:
                return self._main
            for w in webview.windows:
                if w is not None:
                    return w
            return None

        def main_ready(self):
            """Frontend signal: UI + project tree are fully loaded.
            Показываем главное окно и гасим лаунчер."""
            if self._main is None:
                # окно ещё не создано (проверка обновлений не кончилась):
                # запомним готовность, show() сделает _launch_main
                self._ready = True
                return True
            self._show_main()
            return True

        def _show_main(self):
            _boot_ping(app, 100)
            try:
                if self._main is not None:
                    self._main.show()
            except Exception:  # noqa: BLE001
                pass
            try:
                if self._splash is not None:
                    self._splash.destroy()
            except Exception:  # noqa: BLE001
                pass
            self._splash = None

        def _native_dialog(self, dialog_type, file_types=()):
            """Marshal WinForms file/folder dialog to the GUI thread.
            pywebview's js_api runs on a worker thread; ShowDialog must run
            on the UI thread."""
            win = self._win()
            if win is None:
                _log("picker: no window available")
                return None
            try:
                import clr
                from System import Action
                from webview.platforms.winforms import BrowserView
            except Exception as e:  # noqa: BLE001
                _log("picker: .NET bridge unavailable: %s" % e)
                return None

            form = BrowserView.instances.get(win.uid)
            if form is None:
                _log("picker: BrowserView not found for uid=%s" % win.uid)
                return None

            def _show():
                try:
                    return win.create_file_dialog(dialog_type, file_types=file_types)
                except Exception as e:  # noqa: BLE001
                    _log("picker: create_file_dialog error: %s" % e)
                    raise

            box = []
            done = threading.Event()

            def _run():
                try:
                    box.append(_show())
                except Exception as e:  # noqa: BLE001
                    box.append(("__error__", str(e)))
                finally:
                    done.set()

            try:
                if form.InvokeRequired:
                    form.Invoke(Action(_run))
                else:
                    _run()
                if not done.wait(30):
                    _log("picker: timeout waiting for dialog")
                    return None
            except Exception as e:  # noqa: BLE001
                _log("picker: Invoke error: %s" % e)
                return None

            if not box:
                return None
            val = box[0]
            if isinstance(val, tuple) and val and val[0] == "__error__":
                _log("picker: dialog returned error: %s" % val[1])
                return None
            _log("picker: success, result=%s" % (val if val else "None"))
            return val

        def pick_file(self):
            result = self._native_dialog(
                webview.FileDialog.OPEN, file_types=("XML (*.xml)", "All files (*.*)"))
            if not result:
                return None
            return result[0] if isinstance(result, (list, tuple)) else result

        def pick_file_save(self):
            result = self._native_dialog(
                webview.FileDialog.SAVE,
                file_types=("Balance config (*.cfg)", "All files (*.*)"))
            if not result:
                return None
            return result[0] if isinstance(result, (list, tuple)) else result

        def pick_cfg_file(self):
            result = self._native_dialog(
                webview.FileDialog.OPEN,
                file_types=("Balance config (*.cfg;*.txt)", "All files (*.*)"))
            if not result:
                return None
            return result[0] if isinstance(result, (list, tuple)) else result

        def pick_image(self):
            result = self._native_dialog(
                webview.FileDialog.OPEN,
                file_types=("Images (*.png;*.jpg;*.jpeg;*.bmp;*.webp;*.dds;*.tga)",
                            "All files (*.*)"))
            if not result:
                return None
            return result[0] if isinstance(result, (list, tuple)) else result

        def pick_folder(self):
            result = self._native_dialog(webview.FileDialog.FOLDER)
            if not result:
                return None
            return result[0] if isinstance(result, (list, tuple)) else result

        def _form(self):
            """Return (window, winforms Form); Form is None outside winforms."""
            win = self._win()
            if win is None:
                return None, None
            try:
                from webview.platforms.winforms import BrowserView
                return win, BrowserView.instances.get(win.uid)
            except Exception:  # noqa: BLE001
                return win, None

        def minimize(self):
            """Кнопка «Свернуть» кастомного тайтлбара. Напрямую Win32
            SW_MINIMIZE по хендлу формы: не зависит от маппинга
            BrowserView.instances/uid в pywebview (там тихий no-op при
            отсутствии uid). Фолбэк — штатный win.minimize(). Каждый шаг
            в лог: по boot.log видно, дошёл ли клик до бэкенда."""
            try:
                _log("minimize: called")
                _win, form = self._form()
                if form is not None:
                    try:
                        hwnd = int(form.Handle.ToInt64())
                        ctypes.windll.user32.ShowWindow(hwnd, 6)  # SW_MINIMIZE
                        _log("minimize: native SW_MINIMIZE ok")
                        return True
                    except Exception as e:  # noqa: BLE001
                        _log("minimize: native failed: %s" % e)
                if _win is not None:
                    _win.minimize()
                    _log("minimize: pywebview fallback")
                else:
                    _log("minimize: no window at all")
            except Exception as e:  # noqa: BLE001
                _log("minimize: %s" % e)
            return True

        # ---------- разворот на весь экран ----------
        # Безрамочная форма (FormBorderStyle=None) при WindowState=Maximized
        # перекрывает панель задач Windows. Поэтому «на весь экран» делаем
        # вручную: запоминаем текущие Bounds и растягиваем форму ровно на
        # WorkingArea (экран минус панель задач).
        _max_saved = None

        def _working_area(self):
            from System.Windows.Forms import Screen
            _, form = self._form()
            scr = Screen.FromControl(form) if form is not None else Screen.PrimaryScreen
            return scr.WorkingArea

        def is_maximized(self):
            return self._max_saved is not None

        def _form_invoke(self, fn, timeout=3.0):
            """Выполнить fn(form) строго в GUI-потоке WinForms и дождаться
            результата. js_api-методы pywebview приходят из рабочих потоков;
            прямое обращение к форме/контролам оттуда (SendMessage при смене
            Bounds) периодически мертво блокирует весь GUI. Тот же паттерн,
            что у трея: Invoke + Event."""
            win, form = self._form()
            if form is None:
                return None, False
            box = []
            done = threading.Event()

            def _wrap():
                try:
                    box.append(fn(form))
                except Exception as e:  # noqa: BLE001
                    _log("form invoke: %s" % e)
                    box.append(None)
                finally:
                    done.set()

            try:
                from System import Action
                form.Invoke(Action(_wrap))
            except Exception as e:  # noqa: BLE001
                _log("form invoke failed: %s" % e)
                return None, False
            done.wait(timeout)
            return (box[0] if box else None), done.is_set()

        def _apply_maximize(self):
            """Развернуть окно на рабочий стол (НЕ поверх панели задач)."""

            def job(form):
                if self._max_saved is not None:
                    return False
                from System.Drawing import Rectangle
                wa = self._working_area()
                self._max_saved = form.Bounds
                form.Bounds = Rectangle(wa.X, wa.Y, wa.Width, wa.Height)
                return True

            ok, _ = self._form_invoke(job)
            return bool(ok)

        def toggle_maximize(self):
            def job(form):
                if self._max_saved is not None:
                    form.Bounds = self._max_saved
                    self._max_saved = None
                    return False
                return True

            res, ok = self._form_invoke(job)
            if not ok:
                return False
            if res is True:
                return self._apply_maximize()
            return False

        def close_window(self):
            # Used for in-app close button (works even in fullscreen where the
            # title-bar X is hidden by pywebview's borderless fullscreen).
            try:
                self._tray_dispose()
            except Exception:  # noqa: BLE001
                pass
            # своих webview-призраков — насильно: иначе переживают выход,
            # держат профиль занятым и мешают следующему запуску/обновлению.
            # Детей бьём по pid, сирот прошлой жизни — по storage-пути
            try:
                _kill_kids(log=_log)
            except Exception:  # noqa: BLE001
                pass
            try:
                _storage = os.path.join(
                    os.environ.get("LOCALAPPDATA") or app_dir,
                    "TerminatorToolSet", "WebView2")
                _kill_stale_webview(_storage)
            except Exception:  # noqa: BLE001
                pass
            try:
                win = self._win()
                if win is not None:
                    win.destroy()
            except Exception as e:  # noqa: BLE001
                pass
            # safety net in case the webview loop does not exit on its own
            threading.Timer(2.0, lambda: os._exit(0)).start()
            return True

        # ---------- трей ----------
        # Иконка трея на WinForms NotifyIcon. Создаётся лениво, строго в
        # GUI-потоке (Invoke): js_api вызывается из рабочих потоков.
        _tray = None

        def _tray_dispose(self):
            ni, self._tray = self._tray, None
            if ni is not None:
                try:
                    ni.Visible = False
                    ni.Dispose()
                except Exception:  # noqa: BLE001
                    pass

        def _ensure_tray(self):
            """Create (once) the tray icon on the GUI thread and return it."""
            if self._tray is not None:
                return self._tray
            win = self._win()
            if win is None:
                return None
            try:
                import clr  # noqa: F401
                from System import Action
                from webview.platforms.winforms import BrowserView
            except Exception as e:  # noqa: BLE001
                _log("tray: .NET bridge unavailable: %s" % e)
                return None
            form = BrowserView.instances.get(win.uid)
            if form is None:
                return None
            box = []
            done = threading.Event()

            def _make():
                try:
                    from System import EventHandler
                    from System.Windows.Forms import (
                        NotifyIcon, ContextMenuStrip,
                        ToolStripMenuItem, MouseEventHandler, MouseButtons)
                    ni = NotifyIcon()
                    icon = self._app_icon()
                    if icon is None:
                        _log("tray: no icon source at all, abort create")
                        return
                    ni.Icon = icon
                    ni.Text = "Terminator ToolSet"
                    # ПКМ — контекстное меню; ЛКМ — показать окно
                    cms = ContextMenuStrip()
                    mi_open = ToolStripMenuItem("Открыть")
                    mi_open.add_Click(EventHandler(self._on_tray_open))
                    mi_browser = ToolStripMenuItem("Открывать в браузере")
                    try:
                        mi_browser.CheckOnClick = True
                        mi_browser.Checked = bool(config.get("open_in_browser"))
                    except Exception:  # noqa: BLE001
                        pass
                    mi_browser.add_CheckedChanged(
                        EventHandler(self._on_tray_browser_toggle))
                    mi_exit = ToolStripMenuItem("Закрыть")
                    mi_exit.add_Click(EventHandler(self._on_tray_exit))
                    cms.Items.Add(mi_open)
                    cms.Items.Add(mi_browser)
                    cms.Items.Add("-")
                    cms.Items.Add(mi_exit)
                    ni.ContextMenuStrip = cms
                    ni.add_MouseClick(MouseEventHandler(self._on_tray_mouse))
                    ni.Visible = True
                    box.append(ni)
                except Exception as e:  # noqa: BLE001
                    _log("tray: create error: %s" % e)
                finally:
                    done.set()

            try:
                if form.InvokeRequired:
                    form.Invoke(Action(_make))
                else:
                    _make()
                if not done.wait(10):
                    _log("tray: timeout creating icon")
                    return None
            except Exception as e:  # noqa: BLE001
                _log("tray: Invoke error: %s" % e)
                return None
            self._tray = box[0] if box else None
            return self._tray

        def _app_icon(self):
            """Иконка трея: assets/icons рядом с EXE, embedded-кэш
            (icons внутри frozen .exe), _MEIPASS, exe-иконка."""
            try:
                from System.Drawing import Icon
                cands = []
                base = _pick_app_dir()
                meipass = getattr(sys, "_MEIPASS", None)
                try:
                    from terminator_toolset.services import embedded_cache as _emb
                    emb_icons = _emb.ensure()[0]
                except Exception:  # noqa: BLE001
                    emb_icons = ""
                for root in filter(None, (base, emb_icons, meipass, app_dir)):
                    for name in ("app_icon.ico",
                                 os.path.join("assets", "icons", "app_icon.ico"),
                                 os.path.join("assets", "icons", "app_icon.png")):
                        cands.append(os.path.join(root, name))
                for p in cands:
                    if p and os.path.isfile(p):
                        try:
                            if p.lower().endswith(".ico"):
                                return Icon(p)
                            from System.Drawing import Bitmap
                            with Bitmap(p) as bmp:
                                h = bmp.GetHicon()
                                try:
                                    return Icon.FromHandle(h)
                                finally:
                                    pass
                        except Exception:  # noqa: BLE001
                            continue
                handle = __import__("ctypes").windll.kernel32.GetModuleHandleW(None)
                hicon = __import__("ctypes").windll.shell32.ExtractIconW(
                    handle, sys.executable, 0)
                if hicon:
                    try:
                        from System.Drawing import Icon
                        return Icon.FromHandle(hicon)
                    except Exception:  # noqa: BLE001
                        pass
                # последний рубеж: системная иконка есть всегда — лучше
                # дефолтная, чем отсутствие иконки (окно станет недостижимым)
                try:
                    from System.Drawing import SystemIcons
                    return SystemIcons.Application
                except Exception:  # noqa: BLE001
                    return None
            except Exception as e:  # noqa: BLE001
                _log("tray: icon error: %s" % e)
            return None

        def _on_tray_mouse(self, sender, event):
            # ЛКМ по иконке — показать окно; ПКМ отдана ContextMenuStrip
            try:
                from System.Windows.Forms import MouseButtons
                if event is not None and event.Button != MouseButtons.Left:
                    return
            except Exception:  # noqa: BLE001
                pass
            self.restore_from_tray()

        def _on_tray_open(self, sender, event):
            self.restore_from_tray()

        def _on_tray_browser_toggle(self, sender, event):
            try:
                config.set("open_in_browser", bool(sender.Checked))
                _log("tray: open_in_browser=%s" % sender.Checked)
            except Exception as e:  # noqa: BLE001
                _log("tray: browser toggle failed: %s" % e)

        def _on_tray_exit(self, sender, event):
            self.close_window()

        def minimize_to_tray(self):
            """Спрятать окно в трей (используется «Открыть в браузере»)."""
            win = self._win()
            if win is None:
                return False
            # без иконки не прячем: окно будет недостижимо.
            # Форма WinForms появляется асинхронно — одна повторная попытка
            # через полсекунды (транзиентный None BrowserView).
            tray = self._ensure_tray()
            if tray is None:
                try:
                    time.sleep(0.5)
                except Exception:  # noqa: BLE001
                    pass
                tray = self._ensure_tray()
            if tray is None:
                _log("tray: icon unavailable, window stays")
                return False
            try:
                win.hide()
            except Exception as e:  # noqa: BLE001
                _log("tray: hide error: %s" % e)
                return False
            _log("tray: window hidden to tray")
            return True

        def restore_from_tray(self):
            """Клик по иконке в трее: показать окно обратно."""
            try:
                win = self._win()
                if win is not None:
                    win.show()
            except Exception as e:  # noqa: BLE001
                pass
            # постоянная иконка не нужна, если пользователь не включил её в настройках
            if not config.get("tray_enabled"):
                self._tray_dispose()
            return True

        def toggle_fullscreen(self):
            """Полноэкранный режим окна (кнопка разворота таблицы сравнения).
            Системный fullscreen pywebview перекрывает панель задач — это
            ожидаемо только здесь, по явному запросу из fullscreen-модалки."""
            try:
                win = self._win()
                if win is not None:
                    win.toggle_fullscreen()
                    return True
            except Exception as e:  # noqa: BLE001
                _log("toggle_fullscreen: %s" % e)
            return False

        def apply_window_size(self, width, height):
            """Resize the window when the user picks a size preset in settings."""
            try:
                win = self._win()
                if win is not None:
                    w, h = _clamp_to_workarea(width, height)
                    win.resize(w, h)
                    _log("resize: %sx%s (asked %sx%s)" % (w, h, width, height))
                    return True
            except Exception as e:  # noqa: BLE001
                _log("resize: %s" % e)
            return False

    api = Api()

    def _browser_fallback(reason):
        """Нативное окно не поднялось (битый ToolSetLibs / нет .NET-хоста
        на машине): программа остаётся рабочей в обычном браузере вместо
        краша «Failed to execute script 'main'». Причина — в boot.log."""
        _log("mode=browser-fallback: %s" % reason)
        print("native window unavailable (%s) - opening browser: %s"
              % (reason, url))
        try:
            webbrowser.open(url)
        except Exception as e:  # noqa: BLE001
            _log("browser open failed: %s" % e)
        keep_alive()

    win_w, win_h = _clamp_to_workarea(
        *WINDOW_SIZES.get(config.get("window_size", "normal"), (1280, 800)))
    _log("mode=pywebview window=%s size=%sx%s" % (url, win_w, win_h))

    # пробный подъём .NET-моста ДО создания окон: если встроенного Framework
    # нет (выключен в компонентах / выпотрошенная сборка) или ToolSetLibs
    # бит — уходим в браузер сразу, с пометкой ветки в boot.log, а не падаем
    # в webview.start() необработанным исключением
    try:
        import clr  # noqa: E402
        clr.AddReference("System.Windows.Forms")
    except Exception as e:  # noqa: BLE001
        _browser_fallback("dotnet bridge (%s): %s"
                          % (os.environ.get("PYTHONNET_RUNTIME", "?"), e))
        return

    # -- лаунчер: маленькое окно с логотипом и прогрессом проверки обновлений.
    # Живёт до сигнала main_ready от фронтенда (интерфейс + дерево загружены).
    # background_color = цвет темы: без него форма вспыхивает белым до отрисовки
    # страницы; x/y — явное центрирование (CenterScreen pywebview сломан).
    splash_x, splash_y = _center_xy(420, 280) or (None, None)
    try:
        api._splash = webview.create_window(
            "Terminator ToolSet",
            url + "splash",
            width=420,
            height=280,
            x=splash_x,
            y=splash_y,
            resizable=False,
            frameless=True,
            on_top=True,
            background_color="#1d1f24",
            js_api=api,
        )
    except Exception as e:  # noqa: BLE001
        # бэкенд может грузиться уже здесь (зависит от версии pywebview)
        _browser_fallback("splash window: %s" % e)
        return

    def _launch_main():
        # проверка обновлений в лаунчере (быстрый опрос воркера; найденный
        # релиз докачивается фоном, установка — следующим перезапуском)
        try:
            _check_updates(config, app, app_dir)
        except Exception as e:  # noqa: BLE001
            _log("update check error: %s" % e)
        _boot_ping(app, 12)
        try:
            main_x, main_y = _center_xy(win_w, win_h) or (None, None)
            api._main = webview.create_window(
                "Terminator ToolSet",
                url,
                width=win_w,
                height=win_h,
                x=main_x,
                y=main_y,
                # «Полный экран» НЕ через pywebview (безрамочная форма при
                # Maximized перекрывает панель задач): после создания окна
                # применяем ручной разворот на WorkingArea (_apply_maximize).
                frameless=True,         # custom title bar (no native window frame)
                easy_drag=False,        # dragging only via .pywebview-drag-region
                resizable=False,        # fixed window size per spec
                min_size=(900, 600),
                hidden=True,            # видно только после main_ready (лаунчер первым)
                background_color="#1d1f24",
                js_api=api,
            )
        except Exception as e:  # noqa: BLE001
            _log("main window error: %s" % e)
            raise
        _boot_ping(app, 18)
        # нативный DnD в окно (точные пути дропа в mailbox): форма
        # появляется на GUI-потоке асинхронно — ждём её недолго, ставим
        # строго в GUI-потоке (_form_invoke); ссылки на хуки живут в
        # модуле _DROP_HOOKS, иначе GC убьёт колбэки. Поздние дочерние
        # HWND WebView2 довстановливаются фоновым _drop_rehook.
        _drop_form = None
        for _ in range(24):
            try:
                _w, _f = api._form()
            except Exception:  # noqa: BLE001
                _w, _f = None, None
            if _f is not None:
                _drop_form = _f
                break
            time.sleep(0.25)
        if _drop_form is not None:
            _drop_box: "list" = []

            def _drop_job(f):
                _drop_box.append(_install_drop_filter(f))
                return True

            api._form_invoke(_drop_job)
            api._drop_filter = _drop_box[0] if _drop_box else None
            # дочерние HWND WebView2 появляются/пересоздаются поздно, а свой
            # OLE-приёмник Chromium регистрирует после старта рендера —
            # поэтому сторож периодически повторяет revoke-проход (дешёво:
            # несколько RevokeDragDrop) и переподтверждает приёмник формы.
            # _hook_one пропускает уже подменённые wndproc, дубли безопасны.
            def _drop_rehook(delays=(6.0, 20.0, 45.0, 90.0, 180.0, 300.0,
                                     600.0)):
                try:
                    for d in delays:
                        time.sleep(d)
                        try:
                            api._form_invoke(
                                lambda f: _install_drop_child_hook(f))
                        except Exception as e:  # noqa: BLE001
                            _log("drop: rehook: %s" % e)
                except Exception:  # noqa: BLE001
                    pass

            threading.Thread(target=_drop_rehook, daemon=True).start()
        else:
            _log("drop: no form, native drop disabled")
        # «Полный экран» из настроек: ручной разворот на WorkingArea
        # (панель задач остаётся видимой). Форма появляется на GUI-потоке
        # асинхронно - ждём её недолго (до ~6с), иначе разворот молча
        # пропускается.
        if config.get("fullscreen", False):
            for _ in range(24):
                if api._apply_maximize():
                    break
                time.sleep(0.25)
        # main_ready мог прийти, пока окно создавалось (спрятанное окно всё
        # равно грузит страницу) - тогда показать немедленно
        if api._ready:
            api._show_main()

    threading.Thread(target=_launch_main, daemon=True, name="launcher").start()
    threading.Thread(target=_boot_watchdog, daemon=True, name="bootwatch").start()
    # постоянный профиль вместо private temp-режима (см. комментарий выше);
    # на старых pywebview без этих аргументов - обычный запуск.
    # ВАЖНО: WinForms-бэкенд (winforms → pythonnet/.NET) грузится ЛЕНИВО
    # именно в start(), а не на `import webview` выше: чистая Win11 без
    # совместимого .NET-хоста или битый ToolSetLibs дают
    # «Failed to resolve Python.Runtime.Loader.Initialize» — раньше это
    # было необработанным исключением, теперь уходим в браузер.
    try:
        try:
            webview.start(private_mode=False, storage_path=storage)
        except TypeError:
            webview.start()
    except Exception as e:  # noqa: BLE001
        _browser_fallback("webview backend: %s" % e)
        return
    # штатный выход через X: своих webview-призраков — насильно, чтобы не
    # висели в фоне и не держали профиль/файлы для следующего запуска.
    # Детей — по pid, сирот — по storage (пережили прошлый os._exit).
    try:
        _kill_kids(log=_log)
    except Exception:  # noqa: BLE001
        pass
    try:
        _kill_stale_webview(storage)
    except Exception:  # noqa: BLE001
        pass


def _check_updates(config, app=None, app_dir=None):
    """Startup update check (launcher stage): fast worker query, daily
    throttle inside. Runs ONLY when auto_update is on (default off) — else
    updates are manual from the settings tab. A newer release downloads in
    the background; the frontend auto-installs it on stage (same restart
    path as a manual download). Returns the check dict or None."""
    _boot_ping(app, 10)
    try:
        if not config.get("auto_update"):
            return None
    except Exception:  # noqa: BLE001
        return None
    try:
        prog = (os.path.dirname(os.path.abspath(sys.executable))
                if getattr(sys, "frozen", False)
                else (app_dir or _pick_app_dir()))
        svc = Updates(config, _log, prog, _APP_VERSION)
        res = svc.check()
    except Exception as e:  # noqa: BLE001
        _log("update check error: %s" % e)
        _boot_ping(app, 12)
        return None
    _boot_ping(app, 12)
    if not res.get("ok"):
        _log("updates: check failed (%s)" % res.get("error"))
        return res
    avail = res.get("available")
    if not avail:
        _log("updates: up to date (%s)" % res.get("current"))
        return res
    _log("updates: %s available (%s)"
         % (avail.get("version"), avail.get("name")))
    try:
        if (svc.pending() or {}).get("version") != avail.get("version"):
            svc.download()
        else:
            _log("updates: %s already staged, waiting for restart"
                 % avail.get("version"))
    except Exception as e:  # noqa: BLE001
        _log("update download error: %s" % e)
    return res


def keep_alive():
    try:
        while True:
            threading.Event().wait(1)
    except KeyboardInterrupt:
        pass


def _tray_icon():
    """Иконка трея без окна: файлы assets/icons, embedded-кэш, _MEIPASS,
    exe-иконка, в конце системная. Возвращает Icon или None."""
    try:
        from System.Drawing import Icon
        cands = []
        base = _pick_app_dir()
        meipass = getattr(sys, "_MEIPASS", None)
        try:
            from terminator_toolset.services import embedded_cache as _emb
            emb_icons = _emb.ensure()[0]
        except Exception:  # noqa: BLE001
            emb_icons = ""
        for root in filter(None, (base, emb_icons, meipass)):
            for name in ("app_icon.ico",
                         os.path.join("assets", "icons", "app_icon.ico"),
                         os.path.join("assets", "icons", "app_icon.png")):
                cands.append(os.path.join(root, name))
        for p in cands:
            if p and os.path.isfile(p):
                try:
                    if p.lower().endswith(".ico"):
                        return Icon(p)
                    from System.Drawing import Bitmap
                    with Bitmap(p) as bmp:
                        h = bmp.GetHicon()
                        try:
                            return Icon.FromHandle(h)
                        finally:
                            pass
                except Exception:  # noqa: BLE001
                    continue
        handle = __import__("ctypes").windll.kernel32.GetModuleHandleW(None)
        hicon = __import__("ctypes").windll.shell32.ExtractIconW(
            handle, sys.executable, 0)
        if hicon:
            try:
                return Icon.FromHandle(hicon)
            except Exception:  # noqa: BLE001
                pass
        from System.Drawing import SystemIcons
        return SystemIcons.Application
    except Exception as e:  # noqa: BLE001
        _log("tray: icon error: %s" % e)
    return None


def run_browser_tray(url):
    """Режим «запуск в браузере при старте»: окна нет, единственный пульт —
    иконка трея (открыть URL заново / закрыть сервер). Без неё процесс
    виден только в диспетчере задач. Отдельный STA-поток WinForms."""
    import webbrowser as _wb

    def _open_browser(_s=None, _e=None):
        try:
            _wb.open(url)
        except Exception as e:  # noqa: BLE001
            _log("tray: reopen browser failed: %s" % e)

    def _open_window(_s=None, _e=None):
        """«Открыть»: перезапуск в нативном окне. Новый процесс ждёт
        освобождения мьютекса (флаг window.request + TS_WINDOW=1),
        текущий гасит иконку и завершается."""
        try:
            import subprocess as _sp
            from .single_instance import request_window
            argv = [a for a in sys.argv[1:] if a != "--browser"]
            if getattr(sys, "frozen", False):
                cmd = [sys.executable] + argv
            else:
                script = os.path.abspath(sys.argv[0])
                if not script.lower().endswith(".py"):
                    script = os.path.join(_pick_app_dir(), "main.py")
                cmd = [sys.executable, script] + argv
            env = dict(os.environ)
            env["TS_WINDOW"] = "1"
            env.pop("TS_BROWSER", None)
            request_window()
            _sp.Popen(cmd, env=env, close_fds=True)
            _log("tray: respawn as window, exit browser process")
        except Exception as e:  # noqa: BLE001
            _log("tray: open window failed: %s" % e)
            return
        _exit()

    def _exit(_s=None, _e=None):
        try:
            if _exit.box:
                ni = _exit.box[0]
                try:
                    ni.Visible = False
                    ni.Dispose()
                except Exception:  # noqa: BLE001
                    pass
        finally:
            os._exit(0)
    _exit.box = []

    def _loop():
        _log("tray: browser-mode thread start")
        try:
            import clr  # noqa: F401
            clr.AddReference("System.Windows.Forms")
            from System import EventHandler
            from System.Windows.Forms import (
                NotifyIcon, ContextMenuStrip,
                ToolStripMenuItem, MouseEventHandler, MouseButtons,
                Application, ToolTipIcon)
            ni = NotifyIcon()
            icon = _tray_icon()
            if icon is None:
                _log("tray: no icon source at all")
                return
            ni.Icon = icon
            ni.Text = "Terminator ToolSet"
            cms = ContextMenuStrip()
            mi_open = ToolStripMenuItem("Открыть")
            mi_open.add_Click(EventHandler(_open_window))
            mi_browser = ToolStripMenuItem("Открыть в браузере")
            mi_browser.add_Click(EventHandler(_open_browser))
            mi_exit = ToolStripMenuItem("Закрыть")
            mi_exit.add_Click(EventHandler(_exit))
            cms.Items.Add(mi_open)
            cms.Items.Add(mi_browser)
            cms.Items.Add("-")
            cms.Items.Add(mi_exit)
            ni.ContextMenuStrip = cms

            def _click(sender, event):
                try:
                    if event is not None and event.Button != MouseButtons.Left:
                        return
                except Exception:  # noqa: BLE001
                    pass
                _open_window()
            ni.add_MouseClick(MouseEventHandler(_click))
            ni.Visible = True
            _exit.box.append(ni)
            _log("tray: browser-mode icon up")
            # Win10 прячет новые иконки в переполнение: balloon подсвечивает
            try:
                ni.BalloonTipTitle = "Terminator ToolSet"
                ni.BalloonTipText = "Сервер запущен. Открыть: пункт «Открыть»."
                ni.BalloonTipIcon = ToolTipIcon.Info
                ni.ShowBalloonTip(3000)
            except Exception:  # noqa: BLE001
                pass
            Application.Run()
        except Exception as e:  # noqa: BLE001
            _log("tray: browser-mode icon failed: %s" % e)

    try:
        from System.Threading import Thread, ThreadStart, ApartmentState
        th = Thread(ThreadStart(_loop))
        try:
            th.IsBackground = True
            th.SetApartmentState(ApartmentState.STA)
        except Exception:  # noqa: BLE001
            pass
        th.Start()
        _log("tray: browser-mode STA thread started")
    except Exception as e:  # noqa: BLE001
        # нет .NET — обычный python-поток (иконки не будет, сервер жив)
        _log("tray: STA start failed, fallback thread: %s" % e)
        threading.Thread(target=_loop, daemon=True, name="tray").start()
    keep_alive()


def watch_restore_requests():
    """Фоновый вотчер (первый процесс): второй запуск exe оставил флаг
    restore.flag — показать окно штатно (из трея через restore_from_tray:
    win.show + уборка иконки по настройкам). Win32-показ второго процесса
    окно уже дёрнул, вотчер докручивает состояние. Опрос раз в секунду —
    дешевле некуда (один stat несуществующего файла)."""
    try:
        from .single_instance import take_restore
    except Exception:  # noqa: BLE001
        return
    while True:
        try:
            time.sleep(1.0)
        except Exception:  # noqa: BLE001
            return
        try:
            if not take_restore():
                continue
        except Exception:  # noqa: BLE001
            continue
        _log("restore: second launch asks to show the window")
        try:
            api._form_invoke(lambda _f: api.restore_from_tray())
        except Exception:  # noqa: BLE001
            try:
                api.restore_from_tray()
            except Exception:  # noqa: BLE001
                pass
