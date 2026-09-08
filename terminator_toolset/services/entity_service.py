"""Project entity index: open project + background cross-file link map."""
from __future__ import annotations

import os
import threading
import time

from ..domain import links as links_mod
from ..domain.project import Project


# группы отчёта режем для фронта: cells первые N + total (модалка кажет N)
_GROUP_CAP = 200


# -- entity index -----------------------------------------------------------
class EntityIndex:
    """Single owner of the open project and its entity map.

    The map is built on a low-priority daemon thread (streaming, one file
    at a time) so indexing never blocks request threads; readers get the
    last finished map under a lock.
    """

    def __init__(self, store):
        self._store = store     # SessionStore: sessions + minimal_grid
        self.project = None     # open Project or None
        self.map: dict = {}
        self.lock = threading.Lock()
        self._snapshot = None   # frozenset of (path, mtime), None when empty
        self.ready = threading.Event()
        self.building = threading.Event()
        # per-file defs cache: normpath -> (mtime, {value: [locs]}).
        # Повторные проходы (фон/Анализ) парсят только изменённые файлы —
        # на BaseGame это секунды вместо полного рескана.
        self._file_defs: dict = {}

    # -- project lifecycle --------------------------------------------------
    def open(self, root: str, *, db, config) -> dict:
        """Scan a project folder and kick off background indexing."""
        if not root or not os.path.isdir(root):
            return {"ok": False, "error": "not a folder"}
        proj = Project()
        try:
            proj.scan(root)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}
        self.project = proj
        db.add_recent("project", root)
        config.set("last_project", root)
        self.kick()   # start indexing in the background right away
        return {"ok": True,
                "project": proj.to_dict(config.get("language", "ru"))}

    def close(self, *, db, config) -> None:
        """Forget the project: map, snapshot, reopen pointer, file history."""
        if self.project is not None and getattr(self.project, "files", None):
            for f in self.project.files:
                try:
                    db.clear_history(os.path.normpath(f.path))
                except Exception:  # noqa: BLE001
                    pass
        self.project = None
        with self.lock:
            self.map = {}
            self._snapshot = None
        # оба ключа: иначе project_path воскрешает проект при рестарте,
        # а поле в настройках показывает удалённый путь
        config.set("last_project", "")
        config.set("project_path", "")

    # -- snapshot -----------------------------------------------------------
    def paths(self) -> list:
        """Absolute paths of every indexed project file (empty if none)."""
        p = self.project
        if p is None or not p.files:
            return []
        return [f.path for f in p.files]

    @staticmethod
    def _mtime(path: str):
        try:
            return os.path.getmtime(path)
        except OSError:
            return -1

    def _key(self, paths: "list[str]") -> frozenset:
        return frozenset((p, self._mtime(p)) for p in paths)

    def stale(self) -> bool:
        """True when project files changed since the last finished build."""
        paths = self.paths()
        if not paths:
            return False
        with self.lock:
            return self._key(paths) != self._snapshot

    # -- builds ---------------------------------------------------------------
    def _cached_defs(self, paths: "list[str]", load_fn) -> dict:
        """Merged defs map with per-file mtime cache (incremental).

        Неизменённые файлы не парсятся повторно; удалённые выкидываются."""
        merged: dict = {}
        live = set()
        # гонка фон/Анализ по _file_defs безопасна: худший исход — лишний
        # парсинг одного файла, содержимое детерминировано.
        for p in paths or []:
            key = links_mod._norm(p)
            live.add(key)
            mt = self._mtime(p)
            ent = self._file_defs.get(key)
            if ent is not None and ent[0] == mt:
                fdefs = ent[1]
            else:
                try:
                    grid = load_fn(p)
                except Exception:  # noqa: BLE001
                    self._file_defs.pop(key, None)
                    continue
                fdefs = links_mod.defs_from_grid(grid, p)
                self._file_defs[key] = (mt, fdefs)
            for v, locs in fdefs.items():
                merged.setdefault(v, []).extend(locs)
        for key in list(self._file_defs):
            if key not in live:
                del self._file_defs[key]
        return merged

    def _store_map(self, new_map, paths) -> None:
        with self.lock:
            self.map = new_map
            self._snapshot = self._key(paths)
        self.ready.set()

    def _build_bg(self) -> None:
        # yield the GIL between files + low thread priority: indexing must
        # not hurt UI latency or werkzeug request threads
        try:
            import ctypes
            ctypes.windll.kernel32.SetThreadPriority(
                ctypes.windll.kernel32.GetCurrentThread(), -1)
        except Exception:  # noqa: BLE001
            pass

        store = self._store

        def _load_yield(p):
            time.sleep(0.001)
            return store.minimal_grid(p)

        paths = self.paths()
        if paths:
            self._store_map(self._cached_defs(paths, _load_yield), paths)

    def kick(self) -> None:
        """Start a background entity-map build when the snapshot is stale."""
        if not self.paths():
            self.ready.set()
            return
        if self.building.is_set():
            return
        if not self.stale():
            self.ready.set()
            return
        self.building.set()
        self.ready.clear()

        def _worker():
            try:
                self._build_bg()
            except Exception:  # noqa: BLE001
                self.ready.set()
            finally:
                self.building.clear()

        threading.Thread(target=_worker, daemon=True, name="entity-map").start()

    def rebuild(self, open_session=None):
        """Project mode: ensure the background build runs (non-blocking).
        No project: build inline from currently open sessions."""
        if self.paths():
            self.kick()
            return self.map
        with self.lock:
            with_db = {}
            for s in list(self._store.sessions.values()):
                with_db[s.path] = s
            self.map = links_mod.collect_entity_map(with_db)
            return self.map

    def link_targets(self, session) -> list:
        """Cross-file link targets for a session (locked read)."""
        with self.lock:
            return links_mod.link_targets(session, self.map)

    def analyze(self, path_key: str) -> dict:
        """Кнопка «Анализ» открытого файла: синхронный пересчёт зависимостей.

        Строит свежую карту определений одним проходом и кладёт в общий
        индекс — пропавшие ссылки чинятся детерминированно, без ожидания
        фона. Исходящие ссылки — с приоритетом правил семейства и запретом
        само-ссылки; входящие — файлы, чьи ячейки ссылаются на sysname
        этого файла. Без проекта — только по открытым сессиям."""
        s = (self._store.sessions.get(self._store.normal(path_key))
             or self._store.get(path_key))
        paths = self.paths()
        own_names = links_mod.own_sysnames(s)
        if paths:
            # defs — из mtime-кэша (повторный Анализ почти бесплатный);
            # incoming — полный проход: якоря свои, искать надо везде
            defs = self._cached_defs(paths, self._store.minimal_grid)
            incoming = links_mod.collect_incoming(
                paths, self._store.minimal_grid, own_names, s.path)
            self._store_map(defs, paths)
            files_n = len(paths)
        else:
            with self.lock:
                with_db = {}
                for sess in list(self._store.sessions.values()):
                    with_db[sess.path] = sess
                defs = links_mod.collect_entity_map(with_db)
            incoming = {}
            files_n = len(with_db)
        deps = links_mod.dep_targets_for(os.path.basename(s.path or ""))
        links = links_mod.link_targets(s, defs, deps)
        refs = links_mod.all_refs(s, defs, deps)
        by_count = lambda kv: (-len(kv[1]), kv[0].lower())
        # группы режем для фронта: cells первые N + total (модалка кажет N)
        grouped = {}
        for link in refs:
            grouped.setdefault(link["target_file"], []).append(link)
        outgoing = [{"file": f, "cells": c[:_GROUP_CAP], "total": len(c)}
                    for f, c in sorted(grouped.items(), key=by_count)]
        inc = [{"file": f, "cells": c[:_GROUP_CAP], "total": len(c)}
               for f, c in sorted(incoming.items(), key=by_count)]
        return {"ok": True, "links": links, "outgoing": outgoing,
                "incoming": inc, "files": files_n}

    def links(self, path_key: str) -> dict:
        """Link-target payload for a file (rebuilds the index first).

        Reuses the cached session when present so merely asking for links
        never opens the file. While the background index is still building,
        answers pending:true and the frontend retries itself - a werkzeug
        thread must never block here (Chrome keeps 6 conns/host; a long
        wait used to hang open_file/edit into 'infinite loading')."""
        s = (self._store.sessions.get(self._store.normal(path_key))
             or self._store.get(path_key))
        self.rebuild(s)
        if self.paths() and not self.ready.is_set():
            return {"ok": True, "links": [], "pending": True}
        return {"ok": True, "links": self.link_targets(s)}
