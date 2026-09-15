"""Скачивание архива GameAssets из релиза (скрипты/локализация стоковой игры).

Упрощённый аналог Updates: мета через воркер /gameassets, скачивание
бинаря через /asset?kind=gameassets, распаковка в <program_dir>/GameAssets.
Без рестарта, без pending: успех сразу ставит game_assets_downloaded=1.
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
import urllib.parse
import urllib.request
import zipfile

CHECK_TIMEOUT = 15
DOWNLOAD_TIMEOUT = 30


def fetch_game_assets_meta(server, repo, timeout=CHECK_TIMEOUT):
    """Ответ воркера /gameassets -> dict. Ошибка -> OSError."""
    base = (server or "").rstrip("/")
    if not base:
        raise OSError("no update server")
    url = base + "/gameassets"
    if (repo or "").strip():
        url += "?repo=" + urllib.parse.quote(repo.strip())
    req = urllib.request.Request(url, headers={"User-Agent": "TerminatorToolSet"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        raise OSError("update server unreachable: %s" % e)
    try:
        data = json.loads(raw)
    except ValueError:
        raise OSError("bad update server response")
    if not isinstance(data, dict) or not data.get("ok"):
        raise OSError(str(data.get("error") or "update server error"))
    return data


class GameAssets:
    """Состояние архива GameAssets (проверка/скачивание/распаковка)."""

    def __init__(self, config, log, program_dir):
        self._config = config
        self._log = log
        self._program_dir = program_dir
        self._lock = threading.Lock()
        self._progress = {"state": "idle", "done": 0, "total": 0, "error": ""}
        self._meta = None

    # -- paths ------------------------------------------------------
    def target_dir(self):
        return os.path.normpath(os.path.join(self._program_dir or "", "GameAssets"))

    def has_dir(self):
        try:
            return bool(self.target_dir() and os.path.isdir(self.target_dir()))
        except OSError:
            return False

    # -- state ------------------------------------------------------
    def progress(self):
        with self._lock:
            return dict(self._progress)

    def _set_progress(self, **kw):
        with self._lock:
            self._progress.update(kw)

    def state(self):
        try:
            downloaded = 1 if int(
                self._config.get("game_assets_downloaded") or 0) == 1 else 0
        except (TypeError, ValueError):
            downloaded = 0
        try:
            version = str(self._config.get("game_assets_version") or "")
        except Exception:  # noqa: BLE001
            version = ""
        return {"ok": True, "downloaded": downloaded, "version": version,
                "has_dir": self.has_dir(), "progress": self.progress()}

    # -- check ------------------------------------------------------
    def check(self):
        try:
            server = self._config.get("update_server") or ""
            repo = self._config.get("update_repo") or ""
        except Exception:  # noqa: BLE001
            return {"ok": False, "error": "no config"}
        try:
            data = fetch_game_assets_meta(server, repo)
        except OSError as e:
            return {"ok": False, "error": str(e)}
        version = str(data.get("version") or "")
        assets = [a for a in (data.get("assets") or [])
                  if isinstance(a, dict)]
        zips = [a for a in assets
                if str(a.get("name") or "").lower().endswith(".zip")
                and a.get("url")]
        asset = zips[0] if zips else None
        if not version or not asset:
            return {"ok": False, "error": "archive not found"}
        try:
            aid = int(asset.get("id") or 0)
        except (TypeError, ValueError):
            aid = 0
        if not aid:
            return {"ok": False, "error": "archive not found"}
        url = server.rstrip("/") + "/asset?repo=" \
            + urllib.parse.quote(repo or "") + "&id=" + str(aid) \
            + "&kind=gameassets"
        meta = {"version": version, "name": asset.get("name") or "",
                "size": asset.get("size") or 0, "id": aid, "url": url}
        self._meta = meta
        return {"ok": True, "available": meta}

    # -- download ---------------------------------------------------
    def download(self):
        # POST отвечает сразу: и проверка воркера, и скачивание идут
        # в фоне, фронт кажет прогресс через polling (иначе кнопка висит
        # на статичной «Проверке...», пока сеть думает).
        with self._lock:
            if self._progress.get("state") in ("checking", "downloading",
                                               "extracting"):
                return {"ok": False, "error": "already downloading"}
            self._progress = {"state": "checking", "done": 0, "total": 0,
                              "error": ""}
        th = threading.Thread(target=self._check_and_download_job,
                              daemon=True, name="ga-dl")
        th.start()
        return {"ok": True, "started": True}

    def _check_guarded(self, timeout=25):
        """Проверка воркера с жёстким лимитом по wall-clock.

        getaddrinfo на Windows не уважает timeout urlopen: при битом
        DNS поток виснет внутри check() навсегда и прогресс стоит на
        «Проверке...» вечно. Ждём не дольше timeout — иначе бросаем
        ожидание и отдаём ошибку (висящий поток-демон умрёт с процессом).
        """
        box = {}

        def _run():
            try:
                box["res"] = self.check()
            except Exception as e:  # noqa: BLE001
                box["res"] = {"ok": False, "error": str(e)}

        th = threading.Thread(target=_run, daemon=True, name="ga-check")
        th.start()
        th.join(timeout)
        if th.is_alive():
            return {"ok": False,
                    "error": "update server unreachable (timeout)"}
        return box.get("res") or {"ok": False, "error": "check failed"}

    def _check_and_download_job(self):
        """Фон: спросить воркер о свежем архиве, затем скачать/распаковать."""
        meta = self._meta
        if not (isinstance(meta, dict) and meta.get("url")):
            fresh = self._check_guarded()
            if not (isinstance(fresh, dict) and fresh.get("ok")):
                err = str(fresh.get("error") or "check failed")
                try:
                    self._log.error("game_assets check failed: %s", err)
                except Exception:  # noqa: BLE001
                    pass
                self._set_progress(state="error", error=err)
                return
            meta = fresh.get("available") or {}
        url = str(meta.get("url") or "")
        version = str(meta.get("version") or "")
        if not url:
            try:
                self._log.error("game_assets download failed: nothing to download")
            except Exception:  # noqa: BLE001
                pass
            self._set_progress(state="error", error="nothing to download")
            return
        self._download_job(url, version)

    def _download_job(self, url, version):
        staging = tempfile.mkdtemp(prefix="tts_gameassets_")
        self._set_progress(state="downloading", done=0)
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "TerminatorToolSet"})
            with urllib.request.urlopen(req,
                                        timeout=DOWNLOAD_TIMEOUT) as resp:
                total = int(resp.headers.get("Content-Length") or 0)
                self._set_progress(total=total)
                zpath = os.path.join(staging, "gameassets.zip")
                done = 0
                with open(zpath, "wb") as fh:
                    while True:
                        chunk = resp.read(1024 * 256)
                        if not chunk:
                            break
                        fh.write(chunk)
                        done += len(chunk)
                        self._set_progress(done=done)
            self._set_progress(state="extracting")
            extr = os.path.join(staging, "extract")
            os.makedirs(extr, exist_ok=True)
            with zipfile.ZipFile(zpath) as zf:
                zf.extractall(extr)
            root = self._assets_root(extr)
            if not root:
                raise OSError("no files in the archive")
            target = self.target_dir()
            if not target:
                raise OSError("no program dir")
            # замена целиком: старый GameAssets сносим, кладём свежий
            # (содержимое root, не сам root — иначе GameAssets/GameAssets).
            # Повторное скачивание падало с WinError 183: rmtree с
            # ignore_errors молча не удалял занятую папку, а copytree без
            # dirs_exist_ok отказывался класть в существующую.
            try:
                shutil.rmtree(target, ignore_errors=True)
            except Exception:  # noqa: BLE001
                pass
            if os.path.isdir(target):
                # Windows держит файлы (открыты/лок): снос не удался —
                # докладываем поверх, а не падаем «уже существует»
                shutil.copytree(root, target, dirs_exist_ok=True)
            else:
                try:
                    os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
                except OSError:
                    pass
                shutil.copytree(root, target)
            try:
                self._config.set("game_assets_downloaded", 1)
            except Exception:  # noqa: BLE001
                pass
            try:
                self._config.set("game_assets_version", version or "")
            except Exception:  # noqa: BLE001
                pass
            self._set_progress(state="done", done=self._progress.get("total", 0))
        except Exception as e:  # noqa: BLE001
            # текст ошибки видит и попап, и шильдик-тост: дублируем в лог,
            # иначе причина видна только на экране (Logs/errors.log)
            try:
                self._log.error("game_assets download failed: %s", e)
            except Exception:  # noqa: BLE001
                pass
            self._set_progress(state="error", error=str(e))
        finally:
            try:
                shutil.rmtree(staging, ignore_errors=True)
            except Exception:  # noqa: BLE001
                pass

    @staticmethod
    def _assets_root(staging):
        """Корень архива: сам каталог или его единственная верхняя папка
        (ZIP часто заворачивают всё один раз; схлопываем и GameAssets/)."""
        try:
            names = os.listdir(staging)
        except OSError:
            return ""
        if not names:
            return ""
        # эвристика содержимого: корень GameAssets держит basis/ или GameScripts-подобное
        low = [n.lower() for n in names]
        if "basis" in low:
            return staging
        dirs = [n for n in names
                if os.path.isdir(os.path.join(staging, n))]
        if len(dirs) == 1:
            sub = os.path.join(staging, dirs[0])
            try:
                sub_names = [n.lower() for n in os.listdir(sub)]
            except OSError:
                return ""
            if "basis" in sub_names or sub_names:
                return sub
        return staging
