"""External-change watcher for the three tree roots (project/game/mod).

Polling snapshots instead of watchdog: no new dependency, works on network
drives where inotify/ReadDirectoryChanges go blind. Optimized: the walk uses
the same pruning as walk_tree (TREE_MAX_DEPTH, TREE_KEEP_EXTS, skip dirs),
one stat per file via the scandir cache, single daemon thread for all roots.

The frontend polls /api/tree_watch and reloads only the changed tree;
«Пересканировать» (/api/tree_rescan) bumps every generation at once.
"""
from __future__ import annotations

import os
import threading
import time

from .filesystem import _TREE_SKIP_DIRS, TREE_KEEP_EXTS, TREE_MAX_DEPTH

_INTERVAL = 2.5
# игра/мод почти не меняются извне во время работы, а их снапшот — это
# полный scandir-walk (десятки тысяч файлов распакованной игры): опрашивать
# их каждые 2.5с — вечная фоновая нагрузка на диск, душащая параллельный
# /api/game_tree до 14с на холодном HDD (см. app.log). Проект — часто.
_ROLE_INTERVAL = {"project": 2.5, "game": 10.0, "mod": 10.0}


def _keep_file(name: str) -> bool:
    i = name.rfind(".")
    ext = name[i + 1:].lower() if i > 0 else ""
    return ext in TREE_KEEP_EXTS


def _snapshot(root: str):
    """{relpath: (size, mtime_ns)} + dir set, pruned like walk_tree."""
    files = {}
    dirs = set()
    try:
        stack = [(root, 0, "")]
        while stack:
            d, depth, rel = stack.pop()
            try:
                with os.scandir(d) as it:
                    entries = list(it)
            except OSError:
                continue
            for e in entries:
                try:
                    if e.is_symlink():
                        continue
                    if e.is_dir(follow_symlinks=False):
                        if e.name.lower() in _TREE_SKIP_DIRS:
                            continue
                        if depth + 1 > TREE_MAX_DEPTH:
                            continue
                        r = (rel + "/" + e.name) if rel else e.name
                        dirs.add(r)
                        stack.append((e.path, depth + 1, r))
                    elif _keep_file(e.name):
                        try:
                            st = e.stat(follow_symlinks=False)
                        except OSError:
                            continue
                        r = (rel + "/" + e.name) if rel else e.name
                        files[r] = (st.st_size, st.st_mtime_ns)
                except OSError:
                    continue
    except Exception:  # noqa: BLE001 - snapshot must never kill the thread
        pass
    return files, dirs


class TreeWatch:
    """Polling watcher over project/game/mod roots.

    config: domain Config (unpacked_path / mod_path). entities: EntityIndex
    (current .project.root). log: api logger. All state under a lock;
    the thread is daemon and exception-proof per root.
    """

    def __init__(self, config, entities, log, interval: float = _INTERVAL):
        self._config = config
        self._entities = entities
        self._log = log
        self._interval = interval
        self._lock = threading.Lock()
        self._snaps = {}  # role -> (root_path, files, dirs)
        self._quiet = set()  # roles rebaselining after rescan: no bump
        self._gens = {"project": 0, "game": 0, "mod": 0}
        self._version = 0
        self._last_poll = {}  # role -> monotonic ts (per-role интервал)
        self._thread = None

    # -- roots ------------------------------------------------------------
    def _roots(self):
        try:
            proj = ""
            ent_proj = getattr(self._entities, "project", None)
            if ent_proj is not None:
                proj = getattr(ent_proj, "root", "") or ""
        except Exception:  # noqa: BLE001
            proj = ""
        try:
            game = self._config.get("unpacked_path") or ""
        except Exception:  # noqa: BLE001
            game = ""
        try:
            mod = self._config.get("mod_path") or ""
        except Exception:  # noqa: BLE001
            mod = ""
        return {"project": proj, "game": game, "mod": mod}

    def _bump(self, role):
        self._gens[role] = self._gens.get(role, 0) + 1
        self._version += 1

    # -- loop ---------------------------------------------------------------
    def start(self):
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, daemon=True,
                                        name="treewatch")
        self._thread.start()

    def _loop(self):
        while True:
            try:
                self._poll()
            except Exception as e:  # noqa: BLE001
                try:
                    self._log.info("treewatch poll failed: %s", e)
                except Exception:  # noqa: BLE001
                    pass
            time.sleep(self._interval)

    def _poll(self):
        now = time.monotonic()
        for role, root in self._roots().items():
            try:
                iv = _ROLE_INTERVAL.get(role, self._interval)
                if now - self._last_poll.get(role, 0.0) < iv:
                    continue
                self._last_poll[role] = now
                self._poll_root(role, root)
            except Exception:  # noqa: BLE001
                continue

    def _poll_root(self, role, root):
        if not root or not os.path.isdir(root):
            with self._lock:
                if role in self._snaps:
                    del self._snaps[role]
            return
        files, dirs = _snapshot(root)
        with self._lock:
            prev = self._snaps.get(role)
            if role in self._quiet:
                # ручной рескан уже поднял поколение и фронт сам
                # перечитал деревья — только новая база, без бампа
                self._quiet.discard(role)
                self._snaps[role] = (os.path.normpath(root), files, dirs)
            elif prev is None or prev[0] != os.path.normpath(root):
                # first sight or root switched: baseline, but the tree the
                # frontend holds may predate us — bump so it reloads once
                self._snaps[role] = (os.path.normpath(root), files, dirs)
                self._bump(role)
            elif prev[1] != files or prev[2] != dirs:
                self._snaps[role] = (prev[0], files, dirs)
                self._bump(role)

    # -- api ------------------------------------------------------------------
    def state(self) -> dict:
        with self._lock:
            return {"ok": True, "v": self._version,
                    "roots": dict(self._gens)}

    def tree(self, role: str):
        """Готовое древо {n, d, f} из фонового снапшота (без своего walk):
        (root_path, tree) или None, если снапшота ещё нет. Формат — как
        walk_tree: файлы только из снапшота (уже pruned), пустые узлы
        отсутствуют по построению, сортировка та же. /api/game_tree забирает
        отсюда вместо второго параллельного walk по диску."""
        with self._lock:
            snap = self._snaps.get(role)
            if not snap:
                return None
            root, files, _dirs = snap
            items = list(files)
        node = {"n": os.path.basename(root.rstrip("\\/")) or root,
                "d": [], "f": []}
        by_path = {"": node}
        for rel in sorted(items):
            parts = rel.split("/")
            cur = ""
            for part in parts[:-1]:
                nxt = cur + "/" + part if cur else part
                sub = by_path.get(nxt)
                if sub is None:
                    sub = {"n": part, "d": [], "f": []}
                    by_path[nxt] = sub
                    by_path[cur]["d"].append(sub)
                cur = nxt
            by_path[cur]["f"].append(parts[-1])
        def _sort(nd):
            nd["d"].sort(key=lambda x: x["n"].lower())
            nd["f"].sort(key=str.lower)
            for sub in nd["d"]:
                _sort(sub)
        _sort(node)
        return root, node

    def rescan(self) -> dict:
        """Manual «Пересканировать»: drop baselines, bump every live root."""
        with self._lock:
            self._snaps = {}
            self._quiet = set()
            for role, root in self._roots().items():
                if root and os.path.isdir(root):
                    self._quiet.add(role)
                    self._bump(role)
        return self.state()
