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
# Порядок шагов группы: СНАЧАЛА loose-папка basis из корня игры (если найдена
# рядом с .pak), ПОТОМ распаковка всех .pak поверх (basis.pak первым, дальше
# patch_* по номеру, затем паки локализации каждый в свою папку). Так
# перевыпущенные файлы из паков всегда побеждают старые loose-файлы.
# localization больше НЕ копируется: внутри лежат только паки языков
# (localization/<lang>/basis_<lang>.pak) — их распаковываем, а не тащим
# как есть, иначе в распакованной игре лежали бы сами архивы.
_LOOSE_COPY_ORDER = ("basis",)
class Archive:
    """Unpacks the game .pak queue in a background thread.

    Per group: loose basis/ copy first, then ALL paks extract on top:
    game base -> <dest>\\basis\\ (basis.pak first, then patch_* by number),
    Legion -> <dest>\\dlc\\legion\\basis\\, Resistance
    -> <dest>\\dlc\\resistance\\basis\\, Evolution ->
    <dest>\\dlc\\evolution\\basis\\. Localization paks
    (<src>\\localization\\<lang>\\basis_<lang>.pak) each extract into
        their OWN folder <dest>\\localization\\<lang>\\<stem>\\ (e.g.
        localization\\en\\basis_en\\ with locale/ inside) — the loose
        localization/ folder itself is NOT copied (it holds only the paks).
    """

    def __init__(self, log, base_dir):
        self._log = log
        self._base_dir = base_dir  # create_app param (bundled 7z lookup)
        self.job = {"running": False, "done": False, "lines": [], "error": "",
                    "total": 0, "done_n": 0, "done_files": [], "current": "",
                    "pct": 0, "cancel": False, "proc": None}
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

    def pak_skipped(self, folder: str) -> "list[str]":
        """.pak-файлы, не вошедшие в очередь (не basis.pak и не patch_*):
        их никто не распаковывает — показываем отдельной секцией,
        а не молчим."""
        if not folder or not os.path.isdir(folder):
            return []
        out = []
        for f in os.listdir(folder):
            lf = f.lower()
            if not lf.endswith(".pak"):
                continue
            if lf == "basis.pak" or lf.startswith("patch_"):
                continue
            out.append(os.path.join(folder, f))
        out.sort()
        return out

    def loc_plan(self, folder: str) -> "list[dict]":
        """Паки локализации: <folder>/localization/<lang>/basis_<lang>.pak
        (en, de, cn, ...) — так у базы и у каждого DLC (dlc/<name>/
        localization/<lang>/). Каждый пак — со своим путём:
        распаковывается в СВОЮ папку <dest>/localization/<lang>/<stem>/
        (например localization/en/basis_en/ с locale/ внутри), поверх
        ничего чужого не ложится. Порядок внутри языка: basis_* первым,
        остальное по имени."""
        if not folder:
            return []
        loc = os.path.join(folder, "localization")
        if not os.path.isdir(loc):
            return []
        out = []
        try:
            langs = sorted(os.listdir(loc))
        except OSError:
            return []
        for lang in langs:
            ldir = os.path.join(loc, lang)
            if not os.path.isdir(ldir):
                continue
            try:
                files = [f for f in os.listdir(ldir)
                         if f.lower().endswith(".pak")]
            except OSError:
                continue

            def key(f):
                lf = f.lower()
                return (0 if lf.startswith("basis") else 1, lf)

            for f in sorted(files, key=key):
                out.append({"lang": lang, "name": f,
                            "path": os.path.join(ldir, f),
                            "stem": os.path.splitext(f)[0]})
        return out

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
    @staticmethod
    def loose_copies(folder: str) -> "list[dict]":
        """Loose game folder beside the .paks (basis): copied BEFORE
        any .pak extraction. localization сюда НЕ входит — её паки
        распаковываются (loc_plan), а не копируются."""
        out = []
        if not folder or not os.path.isdir(folder):
            return out
        for name in _LOOSE_COPY_ORDER:
            p = os.path.join(folder, name)
            if os.path.isdir(p):
                out.append({"name": name, "path": p})
        return out

    def scan(self, root: str):
        """Find every .pak of the game root and order the extraction queue.
        Plus loose basis/ copied before the paks, localization .paks
        (loc_plan) extracted each into its own folder, plus skipped .paks
        (not basis/patch_*) the queue ignores."""
        if not root or not os.path.isdir(root):
            return {"ok": False, "error": "not a folder"}

        def grp(folder):
            return [{"name": os.path.basename(x), "path": x}
                    for x in self.pak_plan(folder)]

        def skp(folder):
            return [{"name": os.path.basename(x), "path": x}
                    for x in self.pak_skipped(folder)]

        def loc(folder, *rel):
            """Паки локализации + их папка назначения (своя на каждый пак:
            localization/<lang>/<stem>/)."""
            items = []
            for e in self.loc_plan(folder):
                o = os.path.join(*rel, "localization",
                                 e["lang"], e["stem"]) if rel \
                    else os.path.join("localization", e["lang"], e["stem"])
                items.append({**e, "out": o})
            return items

        legion = self.dlc_dir(root, "legion")
        resistance = self.dlc_dir(root, "resistance")
        evolution = self.dlc_dir(root, "evolution")
        return {"ok": True, "sevenz": self.find_7z(),
                "base": grp(root),
                "legion": grp(legion),
                "resistance": grp(resistance),
                "evolution": grp(evolution),
                "loc": {"base": loc(root),
                        "legion": loc(legion, "dlc", "legion"),
                        "resistance": loc(resistance, "dlc", "resistance"),
                        "evolution": loc(evolution, "dlc", "evolution")},
                "skipped": {"base": skp(root),
                            "legion": skp(legion),
                            "resistance": skp(resistance),
                            "evolution": skp(evolution)},
                "copy": {"base": self.loose_copies(root),
                         "legion": self.loose_copies(legion),
                         "resistance": self.loose_copies(resistance),
                         "evolution": self.loose_copies(evolution)}}

    def run(self, game_root: str, dest: str, skip=()):
        """Unpack the whole found queue in a background thread.

        Per group: loose basis/ copy first, then localization .paks (each
        into its OWN folder localization/<lang>/<stem>/), then main .paks
        extract into ONE folder. skip: full .pak AND loose-folder
        src paths (case-insensitive) excluded by the GUI - the user
        clicked their chips off."""
        root = (game_root or "").strip()
        dest = (dest or "").strip()
        if not root or not os.path.isdir(root):
            return {"ok": False, "error": "not a folder"}
        if not dest:
            return {"ok": False, "error": "no dest"}
        if self.job["running"]:
            return {"ok": False, "error": "already running"}
        skipped = {os.path.normcase(os.path.normpath(s))
                   for s in (skip or []) if isinstance(s, str) and s}

        def kept(folder):
            return [p for p in self.pak_plan(folder)
                    if os.path.normcase(p) not in skipped]

        def copies(src, *rel):
            """[(folder_name, src_path, dest_rel)] for found loose folders,
            minus the ones the user clicked off (their src paths ride in
            the same skip list as the .paks)."""
            base = os.path.join(dest, *rel) if rel else dest
            return [(c["name"], c["path"],
                     os.path.join(base, c["name"]))
                    for c in self.loose_copies(src)
                    if os.path.normcase(c["path"]) not in skipped]

        def locjobs(src, *rel):
            """[(pak_path, outdir)] for the group's localization paks —
            each into its OWN folder, minus clicked-off chips."""
            base = os.path.join(dest, *rel) if rel else dest
            return [(e["path"], os.path.join(base, "localization",
                                             e["lang"], e["stem"]))
                    for e in self.loc_plan(src)
                    if os.path.normcase(e["path"]) not in skipped]

        plan = [("base", root, "basis", copies(root), kept(root),
                 locjobs(root))]
        legion = self.dlc_dir(root, "legion")
        if legion:
            plan.append(("legion", legion,
                         os.path.join("dlc", "legion", "basis"),
                         copies(legion, "dlc", "legion"), kept(legion),
                         locjobs(legion, "dlc", "legion")))
        resistance = self.dlc_dir(root, "resistance")
        if resistance:
            plan.append(("resistance", resistance,
                         os.path.join("dlc", "resistance", "basis"),
                         copies(resistance, "dlc", "resistance"),
                         kept(resistance),
                         locjobs(resistance, "dlc", "resistance")))
        evolution = self.dlc_dir(root, "evolution")
        if evolution:
            plan.append(("evolution", evolution,
                         os.path.join("dlc", "evolution", "basis"),
                         copies(evolution, "dlc", "evolution"), kept(evolution),
                         locjobs(evolution, "dlc", "evolution")))
        if not any(paks for _g, _s, _r, _c, paks, _l in plan) \
                and not any(cp for _g, _s, _r, cp, _p, _l in plan) \
                and not any(lj for _g, _s, _r, _c, _p, lj in plan):
            return {"ok": False, "error": "no paks"}
        # 7z нужен только под паки: копирование-only прогон идёт без него
        sevenz = ""
        if any(paks for _g, _s, _r, _c, paks, _l in plan) \
                or any(lj for _g, _s, _r, _c, _p, lj in plan):
            sevenz = self.find_7z()
            if not sevenz:
                return {"ok": False, "error": "7z not found"}
        self.job.update({"running": True, "done": False, "lines": [], "error": "",
                         "total": sum(len(paks) + len(cp) + len(lj)
                                      for _g, _s, _r, cp, paks, lj in plan),
                         "done_n": 0, "done_files": [], "current": "", "pct": 0,
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

    @staticmethod
    def _tree_stat(folder: str) -> tuple:
        """(число файлов, суммарный размер) — снимок до/после пака:
        доказывает, что пак реально что-то распаковал."""
        n = 0
        total = 0
        try:
            for root_d, _dirs, files in os.walk(folder):
                for fn in files:
                    try:
                        total += os.path.getsize(os.path.join(root_d, fn))
                        n += 1
                    except OSError:
                        pass
        except OSError:
            pass
        return (n, total)

    @staticmethod
    def _fmt_size(n: int) -> str:
        """байты — в читаемый вид для строки итога пака."""
        try:
            f = float(n)
        except (TypeError, ValueError):
            return "0 B"
        for unit in ("B", "KB", "MB", "GB"):
            if f < 1024 or unit == "GB":
                return ("%d %s" % (round(f), unit)) if unit == "B" \
                    else ("%.1f %s" % (f, unit))
            f /= 1024
        return "%d B" % n

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

    def _copy_dir(self, src: str, dst: str) -> str:
        """Merge-copy a loose game folder with byte progress + cancel checks.
        Returns "ok" | "cancelled"; a disk error sets job["error"]."""
        job = self.job
        label = os.path.basename(src.rstrip("\\/")) + "\\"
        job["current"] = label
        job["pct"] = 0
        job["lines"].append(">> copy " + src + "  ->  " + dst)
        total = self._dir_size(src)
        done = 0
        try:
            for root_d, _dirs, files in os.walk(src):
                if job.get("cancel"):
                    return "cancelled"
                rel = os.path.relpath(root_d, src)
                out_d = dst if rel == "." else os.path.join(dst, rel)
                os.makedirs(out_d, exist_ok=True)
                for fn in files:
                    if job.get("cancel"):
                        return "cancelled"
                    s = os.path.join(root_d, fn)
                    try:
                        shutil.copy2(s, os.path.join(out_d, fn))
                        try:
                            done += os.path.getsize(s)
                        except OSError:
                            pass
                    except OSError as e:
                        job["lines"].append("!! copy %s: %s" % (s, e))
                    if total:
                        job["pct"] = min(99, int(done * 100 / total))
        except Exception as e:  # noqa: BLE001
            job["lines"].append("!! copy " + label + ": " + str(e))
            job["error"] = "copy failed: " + label
            return "ok"
        job["pct"] = 100
        job["done_n"] += 1
        job["current"] = ""
        # фронт красит чип папки зелёным: ключ — src-путь, как у чипа
        job["done_files"].append(src)
        return "ok"

    def _extract_pak(self, pak: str, outdir: str, sevenz: str,
                       dest: str) -> "str | None":
        """Extract ONE pak into outdir with per-file progress, the 7z
        marker check and the file/byte delta log line. Returns "ok" |
        "cancelled"; a 7z failure sets job["error"] and returns None
        (the worker must stop the whole run). Shared by the main queue
        (ONE folder per group) and the localization paks (OWN folder
        per pak)."""
        job = self.job
        if job.get("cancel"):
            return "cancelled"
        os.makedirs(outdir, exist_ok=True)
        job["current"] = os.path.basename(pak)
        job["pct"] = 0
        job["lines"].append(
            ">> " + pak + "  ->  " + os.path.relpath(outdir, dest))
        # per-pak progress: watcher polls freshly extracted bytes
        # (on top of the snapshot) against the pak's own
        # uncompressed size (7z -bsp1 gives no pct through a pipe)
        pak_total = self._pak_total_size(pak, sevenz)
        snap_n, snap_b = self._tree_stat(outdir)
        stop = threading.Event()
        watcher = threading.Thread(target=self._watch,
                                   args=(outdir, pak_total, stop, snap_b),
                                   daemon=True)
        watcher.start()
        proc = subprocess.Popen(
            # -aoa: перезаписывать существующие БЕЗ спроса (патчи
            # поверх базы/ранних патчей); -y — на прочие запросы
            [sevenz, "x", "-y", "-aoa", "-bd", "-mmt=on",
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
            return "cancelled"
        if proc.returncode != 0:
            errtxt = " | ".join(tail)[-300:]
            job["lines"].append("!! 7z exit %d: %s" % (proc.returncode, errtxt))
            job["error"] = "7z failed on %s" % os.path.basename(pak)
            return None
        job["done_n"] += 1
        # итог пака в лог: маркер 7z + прирост файлов/байт —
        # видно, что пак реально распаковался и лёг поверх
        got_n, got_b = self._tree_stat(outdir)
        ok_mark = any("Everything is Ok" in t for t in tail)
        job["lines"].append(
            "<< %s: %s (+%d файлов, +%s)" % (
                os.path.basename(pak),
                "OK" if ok_mark else "exit 0 без маркера",
                max(0, got_n - snap_n),
                self._fmt_size(max(0, got_b - snap_b))))
        if not ok_mark:
            job["lines"].append(
                "!! %s: нет строки 'Everything is Ok' — проверь итог вручную"
                % os.path.basename(pak))
        # фронт красит чип пака зелёным сразу, не дожидаясь конца;
        # ключ — ПОЛНЫЙ путь (basename дублируются между группами)
        job["done_files"].append(pak)
        job["current"] = ""
        return "ok"

    def _worker(self, plan, dest: str, sevenz: str):
        job = self.job
        try:
            os.makedirs(dest, exist_ok=True)
            cancelled = False
            for _group, _src, out_rel, cpies, paks, locjobs in plan:
                if job.get("cancel"):
                    cancelled = True
                    break
                # сначала loose-папка basis, потом паки поверх:
                # перевыпущенные файлы из паков побеждают старые
                for _name, src, dst_rel in cpies:
                    if job.get("cancel"):
                        cancelled = True
                        break
                    if job.get("error"):
                        return
                    st = self._copy_dir(src, os.path.join(dest, dst_rel))
                    if st == "cancelled":
                        cancelled = True
                        break
                    if job.get("error"):
                        return
                if cancelled:
                    break
                # ALL main paks of a group extract into ONE folder: the game
                # base paks go to <dest>\basis\ (basis.pak first, then patches
                # overwrite), each DLC -> <dest>\dlc\<name>\basis\
                outdir = os.path.join(dest, out_rel)
                # паки локализации — ВТОРЫМИ, сразу после loose-копии: каждый
                # в СВОЮ папку <dest>\localization\<lang>\<stem>\ (DLC — под
                # своей веткой); путей друг друга не касаются
                for pak, locdir in locjobs:
                    st = self._extract_pak(pak, locdir, sevenz, dest)
                    if st == "cancelled":
                        cancelled = True
                        break
                    if st is None:
                        return
                if cancelled:
                    break
                for pak in paks:
                    st = self._extract_pak(pak, outdir, sevenz, dest)
                    if st == "cancelled":
                        cancelled = True
                        break
                    if st is None:
                        return
                if cancelled:
                    break
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
