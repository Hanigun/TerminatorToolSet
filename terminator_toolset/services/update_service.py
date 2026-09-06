"""Self-updates via a Cloudflare Worker over private GitHub releases.

Flow: worker (/release or /prerelease) -> pick the .zip asset -> compare
with the running version -> download to a staging dir -> write a pending
flag -> apply on the next boot (the running EXE is file-locked on Windows,
so files are replaced before the server/window starts, see main.py).

The release .zip must contain the release root: the EXE, ToolSetLibs/,
assets/ (without icons/), locales/, UprisingPresets/, swt_commands.json
and 7z/. configs/, Logs/, *.db, uprising_backups/ and UprisingCustomPresets/
are user data and are never overwritten.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import zipfile

CHECK_TTL = 24 * 3600  # auto-check at most once a day
CHECK_TIMEOUT = 15
DOWNLOAD_TIMEOUT = 30

# version tags, ordered: beta < rc < final (unknown tags sort as beta)
_TAG_RANK = {"beta": 0, "rc": 1}
_VER_RE = re.compile(r"^v?(\d+(?:\.\d+)*)(?:[-.]([A-Za-z]+)(\d*))?$")


def parse_version(s):
    """'v1.2.3-beta1' -> ((1,2,3), 0, 1); unparseable -> None."""
    m = _VER_RE.match(str(s or "").strip())
    if not m:
        return None
    nums = tuple(int(x) for x in m.group(1).split("."))
    tag = (m.group(2) or "").lower()
    if not tag:
        return (nums, 2, 0)
    return (nums, _TAG_RANK.get(tag, 0), int(m.group(3) or 0))


def _pad(nums, n):
    return tuple(list(nums) + [0] * max(0, n - len(nums)))


def is_newer(remote, current):
    """True when the remote version string is above the current one."""
    r, c = parse_version(remote), parse_version(current)
    if not r or not c:
        return False
    n = max(len(r[0]), len(c[0]))
    return (_pad(r[0], n), r[1], r[2]) > (_pad(c[0], n), c[1], c[2])


def fetch_release(server, channel, repo, timeout=CHECK_TIMEOUT):
    """Worker response -> dict. Raises OSError on transport problems."""
    base = (server or "").rstrip("/")
    if not base:
        raise OSError("no update server")
    path = "/prerelease" if channel == "beta" else "/release"
    url = base + path
    if (repo or "").strip():
        url += "?repo=" + urllib.parse.quote(repo.strip())
    req = urllib.request.Request(url, headers={"User-Agent": "TerminatorToolSet"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001 - network errors are all "try later"
        raise OSError("update server unreachable: %s" % e)
    try:
        data = json.loads(raw)
    except ValueError:
        raise OSError("bad update server response")
    if not isinstance(data, dict) or not data.get("ok"):
        raise OSError(str(data.get("error") or "update server error"))
    return data


def apply_pending_update(program_dir, cfg_dir, log=None):
    """Copy a staged release over the program dir (called before boot,
    when no process holds the files). Returns the applied version or ''."""
    pending_path = os.path.join(cfg_dir or "", "update_pending.json")
    try:
        with open(pending_path, "r", encoding="utf-8") as fh:
            pending = json.load(fh)
    except (OSError, ValueError):
        return ""
    if not isinstance(pending, dict):
        return ""
    staged = pending.get("staged") or ""
    version = pending.get("version") or ""
    if not staged or not os.path.isdir(staged):
        try:
            os.remove(pending_path)
        except OSError:
            pass
        return ""
    keep_top = {"configs", "Logs", "uprising_backups", "UprisingCustomPresets"}
    failures = 0
    for root, dirs, files in os.walk(staged):
        rel = os.path.relpath(root, staged)
        top = rel.split(os.sep)[0] if rel != "." else ""
        if top in keep_top:
            dirs[:] = []
            continue
        # never touch user data, even nested
        dirs[:] = [d for d in dirs if d not in keep_top
                   and not (d.lower().endswith(".db"))]
        dst_dir = program_dir if rel == "." else os.path.join(program_dir, rel)
        try:
            os.makedirs(dst_dir, exist_ok=True)
        except OSError:
            failures += 1
            continue
        for fn in files:
            if fn.lower().endswith((".db", ".log")):
                continue
            try:
                shutil.copy2(os.path.join(root, fn),
                             os.path.join(dst_dir, fn))
            except OSError:
                failures += 1
    if failures:
        if log:
            try:
                log("update apply: %d file(s) failed, keeping pending %s"
                    % (failures, version))
            except Exception:  # noqa: BLE001
                pass
        return ""
    try:
        shutil.rmtree(staged, ignore_errors=True)
    except Exception:  # noqa: BLE001
        pass
    try:
        os.remove(pending_path)
    except OSError:
        pass
    if log:
        try:
            log("update applied: %s" % version)
        except Exception:  # noqa: BLE001
            pass
    return version


class Updates:
    """Update state owned by one service (check/download/stage/apply)."""

    def __init__(self, config, log, program_dir, current_version):
        self._config = config
        self._log = log
        self._program_dir = program_dir
        self._current = current_version
        self._lock = threading.Lock()
        self._progress = {"state": "idle", "done": 0, "total": 0,
                          "version": "", "error": ""}

    # -- state ----------------------------------------------------------
    def _update_file(self):
        try:
            cfg_dir = self._config.cfg_dir
        except Exception:  # noqa: BLE001
            cfg_dir = self._config.dir
        return os.path.join(cfg_dir, "update.json")

    def _read_cached(self):
        try:
            with open(self._update_file(), "r", encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _write_cached(self, data):
        try:
            os.makedirs(os.path.dirname(self._update_file()), exist_ok=True)
            with open(self._update_file(), "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False)
        except OSError:
            pass

    def pending(self):
        try:
            cfg_dir = self._config.cfg_dir
        except Exception:  # noqa: BLE001
            cfg_dir = self._config.dir
        try:
            with open(os.path.join(cfg_dir, "update_pending.json"),
                      "r", encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def state(self):
        """Everything the UI needs: current/channel/last check/pending/
        cached available release."""
        try:
            channel = self._config.get("update_channel") or "release"
        except Exception:  # noqa: BLE001
            channel = "release"
        try:
            last = int(self._config.get("update_last_check") or 0)
        except (TypeError, ValueError):
            last = 0
        return {"ok": True, "current": self._current, "channel": channel,
                "last_check": last, "pending": self.pending(),
                "available": self._read_cached().get("available"),
                "progress": self.progress()}

    def progress(self):
        with self._lock:
            return dict(self._progress)

    # -- check ----------------------------------------------------------
    def check(self, force=False):
        """Ask the worker for the newest release on our channel. Daily
        throttle unless forced. Caches the available release (if any)."""
        try:
            last = int(self._config.get("update_last_check") or 0)
        except (TypeError, ValueError):
            last = 0
        now = int(time.time())
        if not force and now - last < CHECK_TTL:
            cached = self._read_cached().get("available")
            return {"ok": True, "cached": True, "available": cached,
                    "current": self._current}
        try:
            server = self._config.get("update_server") or ""
            channel = self._config.get("update_channel") or "release"
            repo = self._config.get("update_repo") or ""
        except Exception:  # noqa: BLE001
            return {"ok": False, "error": "no config"}
        try:
            data = fetch_release(server, channel, repo)
        except OSError as e:
            return {"ok": False, "error": str(e)}
        version = str(data.get("version") or "")
        assets = [a for a in (data.get("assets") or [])
                  if isinstance(a, dict)]
        zips = [a for a in assets
                if str(a.get("name") or "").lower().endswith(".zip")
                and a.get("url")]
        asset = zips[0] if zips else None
        available = None
        if version and is_newer(version, self._current) and asset:
            # The repo is private, so the asset's browser_download_url 404s
            # for anonymous downloads: fetch the binary through the worker
            # (/asset streams it with GH_TOKEN, the token never leaves the
            # server). ?pre=1 must match the channel the metadata came from,
            # otherwise the worker's membership check rejects the id.
            url = str(asset["url"])
            try:
                aid = int(asset.get("id") or 0)
            except (TypeError, ValueError):
                aid = 0
            if aid and server:
                q = "?repo=" + urllib.parse.quote(repo or "") + "&id=" + str(aid)
                if channel == "beta":
                    q += "&pre=1"
                url = server + "/asset" + q
            available = {"version": version,
                         "notes": str(data.get("notes") or ""),
                         "url": url, "name": asset.get("name") or "",
                         "size": asset.get("size") or 0,
                         "channel": channel}
        try:
            self._config.set("update_last_check", now)
        except Exception:  # noqa: BLE001
            pass
        self._write_cached({"available": available, "checked": now})
        return {"ok": True, "cached": False, "available": available,
                "current": self._current}

    # -- download + stage -----------------------------------------------
    def download(self, url="", version=""):
        """Start the download in a background thread (progress via
        progress()). Empty url = the cached available release, refreshed
        with a forced check first: the cache may predate the worker
        change (direct browser_download_url, 404 on a private repo)."""
        with self._lock:
            if self._progress["state"] == "downloading":
                return {"ok": False, "error": "already downloading"}
            if not url:
                try:
                    fresh = self.check(force=True)
                except Exception:  # noqa: BLE001
                    fresh = {}
                avail = (fresh.get("available") if isinstance(fresh, dict)
                         else None)
                if not avail:
                    avail = self._read_cached().get("available") or {}
                url = avail.get("url") or ""
                version = version or avail.get("version") or ""
            if not url:
                return {"ok": False, "error": "nothing to download"}
            self._progress = {"state": "downloading", "done": 0, "total": 0,
                              "version": version, "error": ""}
        th = threading.Thread(target=self._download_job, args=(url, version),
                              daemon=True, name="upd-dl")
        th.start()
        return {"ok": True, "started": True, "version": version}

    def _set_progress(self, **kw):
        with self._lock:
            self._progress.update(kw)

    def _download_job(self, url, version):
        staging = os.path.join(tempfile.gettempdir(), "tts_update",
                               re.sub(r"[^A-Za-z0-9._-]+", "_",
                                      version or "latest"))
        try:
            os.makedirs(staging, exist_ok=True)
            req = urllib.request.Request(
                url, headers={"User-Agent": "TerminatorToolSet"})
            with urllib.request.urlopen(req,
                                        timeout=DOWNLOAD_TIMEOUT) as resp:
                total = int(resp.headers.get("Content-Length") or 0)
                self._set_progress(total=total)
                zpath = os.path.join(staging, "release.zip")
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
            with zipfile.ZipFile(zpath) as zf:
                zf.extractall(staging)
            try:
                os.remove(zpath)
            except OSError:
                pass
            root = self._release_root(staging)
            if not root:
                raise OSError("no program files in the archive")
            try:
                cfg_dir = self._config.cfg_dir
            except Exception:  # noqa: BLE001
                cfg_dir = self._config.dir
            with open(os.path.join(cfg_dir, "update_pending.json"),
                      "w", encoding="utf-8") as fh:
                json.dump({"version": version, "staged": root}, fh)
            self._set_progress(state="staged", done=self._progress["total"])
        except Exception as e:  # noqa: BLE001
            try:
                shutil.rmtree(staging, ignore_errors=True)
            except Exception:  # noqa: BLE001
                pass
            self._set_progress(state="error", error=str(e))

    @staticmethod
    def _release_root(staging):
        """Archive root holding the program: the staging dir itself, or its
        single top-level folder (release zips often wrap everything once)."""
        exe_names = ("terminator toolset.exe",)
        try:
            names = os.listdir(staging)
        except OSError:
            return ""
        low = [n.lower() for n in names]
        if any(e in low for e in exe_names):
            return staging
        dirs = [n for n in names
                if os.path.isdir(os.path.join(staging, n))]
        if len(dirs) == 1:
            try:
                sub = os.listdir(os.path.join(staging, dirs[0]))
            except OSError:
                return ""
            if any(e in [s.lower() for s in sub] for e in exe_names):
                return os.path.join(staging, dirs[0])
        return ""
