"""Game archive unpacker: ordered .pak extraction with progress."""
from __future__ import annotations

import collections
import os
import re
import shutil
import subprocess
import threading


# -- constants ------------------------------------------------------------------
PAK_PASSWORD = "oKoo$]bnGTKJLMNBA9A"
_RE_PATCH_NUM = re.compile(r"patch_(\d+)")
# GUI build has no console: console-subsystem children (7z.exe) must not pop
# a visible console window on every spawn (the "second console" ghost).
_NW = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


# -- archive --------------------------------------------------------------------
class Archive:
    """Unpacks the game .pak queue in a background thread.

    ALL paks of a group extract into ONE folder so later patches overwrite
    earlier files: game base -> <dest>\\basis\\ (basis.pak first, then
    patch_* by number), Legion -> <dest>\\dlc\\legion\\basis\\, Resistance
    -> <dest>\\dlc\\resistance\\basis\\, Evolution ->
    <dest>\\dlc\\evolution\\basis\\.
    """

    def __init__(self, log, base_dir):
        self._log = log
        self._base_dir = base_dir  # create_app param (bundled 7z lookup)
        self.job = {"running": False, "done": False, "lines": [], "error": "",
                    "total": 0, "done_n": 0, "current": "", "pct": 0,
                    "cancel": False, "proc": None}
        self._size_cache: "dict[tuple, int]" = {}

    # -- discovery ----------------------------------------------------------------
    def find_7z(self):
        # 1) bundled 7z next to the app (packed into the exe build)
        for cand in (os.path.join(self._base_dir, "7z", "x64", "7z.exe"),
                     os.path.join(self._base_dir, "7z", "x86", "7z.exe")):
            if os.path.isfile(cand):
                return cand
        exe = shutil.which("7z") or shutil.which("7za")
        if exe:
            return exe
        for cand in (r"C:\Program Files\7-Zip\7z.exe",
                     r"C:\Program Files (x86)\7-Zip\7z.exe"):
            if os.path.isfile(cand):
                return cand
        return ""

    def pak_plan(self, folder: str) -> "list[str]":
        """basis.pak first, then every patch_* sorted by its numeric id -
        later patches overwrite earlier ones while extracting."""
        if not folder or not os.path.isdir(folder):
            return []
        paks = [f for f in os.listdir(folder) if f.lower().endswith(".pak")]
        base = [f for f in paks if f.lower() == "basis.pak"]
        patches = []
        for f in paks:
            lf = f.lower()
            if lf == "basis.pak" or not lf.startswith("patch_"):
                continue
            m = _RE_PATCH_NUM.search(lf)
            patches.append((int(m.group(1)) if m else 10 ** 6, f))
        patches.sort()
        return ([os.path.join(folder, f) for f in base]
                + [os.path.join(folder, f) for _n, f in patches])

    @staticmethod
    def dlc_dir(root: str, name: str) -> str:
        d = os.path.join(root, "dlc")
        if not os.path.isdir(d):
            return ""
        for e in os.listdir(d):
            if e.lower() == name:
                return os.path.join(d, e)
        return ""

    # -- operations ---------------------------------------------------------------
    def scan(self, root: str):
        """Find every .pak of the game root and order the extraction queue."""
        if not root or not os.path.isdir(root):
            return {"ok": False, "error": "not a folder"}

        def grp(folder):
            return [{"name": os.path.basename(x), "path": x}
                    for x in self.pak_plan(folder)]

        return {"ok": True, "sevenz": self.find_7z(),
                "base": grp(root),
                "legion": grp(self.dlc_dir(root, "legion")),
                "resistance": grp(self.dlc_dir(root, "resistance")),
                "evolution": grp(self.dlc_dir(root, "evolution"))}

    def run(self, game_root: str, dest: str):
        """Unpack the whole found queue in a background thread."""
        root = (game_root or "").strip()
        dest = (dest or "").strip()
        if not root or not os.path.isdir(root):
            return {"ok": False, "error": "not a folder"}
        if not dest:
            return {"ok": False, "error": "no dest"}
        sevenz = self.find_7z()
        if not sevenz:
            return {"ok": False, "error": "7z not found"}
        if self.job["running"]:
            return {"ok": False, "error": "already running"}
        plan = [("base", "basis", self.pak_plan(root))]
        legion = self.dlc_dir(root, "legion")
        if legion:
            plan.append(("legion", os.path.join("dlc", "legion", "basis"),
                         self.pak_plan(legion)))
        resistance = self.dlc_dir(root, "resistance")
        if resistance:
            plan.append(("resistance", os.path.join("dlc", "resistance", "basis"),
                         self.pak_plan(resistance)))
        evolution = self.dlc_dir(root, "evolution")
        if evolution:
            plan.append(("evolution", os.path.join("dlc", "evolution", "basis"),
                         self.pak_plan(evolution)))
        if not any(paks for _g, _r, paks in plan):
            return {"ok": False, "error": "no paks"}
        self.job.update({"running": True, "done": False, "lines": [], "error": "",
                         "total": sum(len(paks) for _g, _r, paks in plan),
                         "done_n": 0, "current": "", "pct": 0,
                         "cancel": False, "proc": None})
        threading.Thread(target=self._worker,
                         args=(plan, os.path.normpath(dest), sevenz),
                         daemon=True).start()
        return {"ok": True}

    def status(self):
        return {"ok": True,
                **{k: v for k, v in self.job.items() if k != "proc"}}

    def abort(self):
        if not self.job["running"]:
            return {"ok": False, "error": "not running"}
        self.job["cancel"] = True
        proc = self.job.get("proc")
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:  # noqa: BLE001
                pass
        return {"ok": True}

    # -- worker ---------------------------------------------------------------------
    @staticmethod
    def _dir_size(folder: str) -> int:
        total = 0
        try:
            for root_d, _dirs, files in os.walk(folder):
                for fn in files:
                    try:
                        total += os.path.getsize(os.path.join(root_d, fn))
                    except OSError:
                        pass
        except OSError:
            pass
        return total

    def _pak_total_size(self, pak: str, sevenz: str) -> int:
        """Sum of the uncompressed file sizes inside the pak (0 if unknown).
        Cached by (pak, mtime): listing a big pak takes десятки секунд,
        a rerun of the same archive never repeats it."""
        try:
            mt = os.path.getmtime(pak)
        except OSError:
            mt = -1.0
        key = (pak, sevenz, mt)
        if key in self._size_cache:
            return self._size_cache[key]
        try:
            p = subprocess.run(
                [sevenz, "l", "-slt", "-p" + PAK_PASSWORD, pak],
                capture_output=True, text=True, errors="replace", timeout=120,
                **_NW)
        except Exception:  # noqa: BLE001
            return 0
        total = 0
        for line in (p.stdout or "").splitlines():
            if line.strip().startswith("Size = "):
                try:
                    total += int(line.split("=", 1)[1].strip())
                except ValueError:
                    pass
        self._size_cache[key] = total
        return total

    def _watch(self, outdir: str, total: int, stop: threading.Event,
               base: int = 0):
        """Poll the outdir and set job['pct'] = extracted bytes %.
        'base' is the byte snapshot taken before this pak started, so files
        left by earlier paks of the same group don't skew the percentage.

        Rare polling (1s): frequent full walks of a growing tree on HDD
        fight 7z's writes for the disk head and DIRECTLY slow unpacking.
        Low thread priority - progress matters less than 7z."""
        try:
            import ctypes
            ctypes.windll.kernel32.SetThreadPriority(
                ctypes.windll.kernel32.GetCurrentThread(), -1)
        except Exception:  # noqa: BLE001
            pass
        while not stop.wait(1.0):
            got = 0
            try:
                for root_d, _dirs, files in os.walk(outdir):
                    for fn in files:
                        try:
                            got += os.path.getsize(os.path.join(root_d, fn))
                        except OSError:
                            pass
            except OSError:
                pass
            got -= base
            self.job["pct"] = (min(99, int(got * 100 / total))
                               if total and got > 0 else 0)

    def _worker(self, plan, dest: str, sevenz: str):
        job = self.job
        try:
            os.makedirs(dest, exist_ok=True)
            cancelled = False
            for _group, out_rel, paks in plan:
                if job.get("cancel"):
                    cancelled = True
                    break
                # ALL paks of a group extract into ONE folder: the game base
                # paks go to <dest>\basis\ (basis.pak first, then patches
                # overwrite), each DLC -> <dest>\dlc\<name>\basis\
                outdir = os.path.join(dest, out_rel)
                os.makedirs(outdir, exist_ok=True)
                for pak in paks:
                    if job.get("cancel"):
                        cancelled = True
                        break
                    job["current"] = os.path.basename(pak)
                    job["pct"] = 0
                    job["lines"].append(
                        ">> " + pak + "  ->  " + os.path.relpath(outdir, dest))
                    # per-pak progress: watcher polls freshly extracted bytes
                    # (on top of the snapshot) against the pak's own
                    # uncompressed size (7z -bsp1 gives no pct through a pipe)
                    pak_total = self._pak_total_size(pak, sevenz)
                    snap = self._dir_size(outdir)
                    stop = threading.Event()
                    watcher = threading.Thread(target=self._watch,
                                               args=(outdir, pak_total, stop, snap),
                                               daemon=True)
                    watcher.start()
                    proc = subprocess.Popen(
                        [sevenz, "x", "-y", "-bd", "-mmt=on",
                         "-p" + PAK_PASSWORD, "-o" + outdir, pak],
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        text=True, errors="replace", **_NW)
                    job["proc"] = proc
                    # drain 7z output: read in CHUNKS, not char by char.
                    # Was: -bsp1 (progress spam into the pipe) + `for ch`
                    # loop with `buf += ch` (quadratic concat under GIL).
                    # Python couldn't drain fast enough - the pipe buffer
                    # (64KB) filled and 7z BLOCKED on write, i.e. the app
                    # itself slowed unpacking. -bd instead of -bsp1: progress
                    # goes through the watcher, the pipe stays near-empty.
                    # The last-lines tail is for nonzero-exit diagnosis.
                    tail: "collections.deque[str]" = collections.deque(maxlen=5)
                    tail_buf = ""
                    while True:
                        chunk = proc.stdout.read(65536)
                        if not chunk:
                            break
                        tail_buf += chunk
                        if len(tail_buf) > 65536:
                            tail_buf = tail_buf[-65536:]
                    for part in tail_buf.replace("\r", "\n").split("\n"):
                        part = part.strip()
                        if part:
                            tail.append(part)
                    proc.wait()
                    stop.set()
                    job["pct"] = 100
                    if job.get("cancel"):
                        cancelled = True
                        break
                    if proc.returncode != 0:
                        errtxt = " | ".join(tail)[-300:]
                        job["lines"].append("!! 7z exit %d: %s" % (proc.returncode, errtxt))
                        job["error"] = "7z failed on %s" % os.path.basename(pak)
                        return
                    job["done_n"] += 1
                    job["current"] = ""
            if cancelled:
                job["lines"].append("!! Прервано пользователем")
                job["error"] = "cancelled"
            else:
                job["lines"].append("OK")
        except Exception as e:  # noqa: BLE001
            job["error"] = str(e)
            job["lines"].append("!! " + str(e))
        finally:
            job["running"] = False
            job["done"] = True
            job["proc"] = None
            job["current"] = ""
