"""Compare / merge / transfer between two spreadsheet files + file repair."""
from __future__ import annotations

import os

from ..domain import comparator as comp_mod
from ..domain.spreadsheet_ml import SpreadsheetError


# -- compare ------------------------------------------------------------------
class Compare:
    """Owns the comparator page backend (diff, merge-all, row/column
    transfer, xml listing) and the fix-file repair action.

    store: SessionStore. config: domain Config (auto_save). saves:
    SavePipeline. hist: HistoryLog (undo flags). db: Database (change
    journal). log: api logger.
    """

    def __init__(self, store, config, saves, hist, db, log):
        self._store = store
        self._config = config
        self._saves = saves
        self._hist = hist
        self._db = db
        self._log = log

    # -- repair -----------------------------------------------------------------
    def fix_file(self, path: str) -> dict:
        """Fix ExpandedRow/ColumnCounts + missing Style defs, then save.
        A valid file returns changed=[] and is never rewritten."""
        path = self._store.normal(path or "")
        if not path or not os.path.isfile(path):
            return {"ok": False, "error": "not a file"}
        try:
            s = self._store.get(path)
            changed = s.doc.fix_expanded_counts()
            styles = s.doc.fix_missing_styles()
        except SpreadsheetError as e:
            return {"ok": False, "error": str(e)}
        changed_any = bool(changed or styles)
        saved = False
        err = None
        if changed_any:
            s.dirty = True
            res = self._saves.safe_save(s)
            saved = bool(res.get("saved"))
            err = res.get("error")
            self._log.info("fix_file %s: %s styles=%s (saved=%s)", path,
                           [(c["sheet"], c["attr"], c["old"], c["new"]) for c in changed],
                           styles, saved)
        else:
            self._log.info("fix_file %s: nothing to fix", path)
        return {"ok": not err, "changed": changed, "styles": styles,
                "saved": saved, "error": err}

    # -- key column ---------------------------------------------------------------
    def _key_col(self, worksheet, key_col, default_key) -> int:
        """Resolve the key column (negative = auto by header name)."""
        key_col = int(key_col)
        if key_col < 0:
            names = worksheet.column_names()
            default = default_key or "sysname"
            key_col = names.index(default) if default in names else 0
        return key_col

    @staticmethod
    def _rowvals(worksheet) -> list:
        n = worksheet.column_count()
        out = []
        for r in worksheet.rows:
            vals = [r.cell_value(c) for c in range(n)]
            while vals and vals[-1] == "":
                vals.pop()
            out.append(vals)
        return out

    # -- diff -----------------------------------------------------------------------
    def compare(self, left_path: str, right_path: str,
                key_col=0, default_key: str = "") -> dict:
        left = self._store.get(self._store.normal(left_path or ""))
        right = self._store.get(self._store.normal(right_path or ""))
        key_col = self._key_col(left.worksheet, key_col, default_key)
        try:
            diff = comp_mod.compute_diff_named(left.worksheet, right.worksheet, key_col)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}
        payload = [{"key": dr.key, "status": dr.status,
                    "left_index": dr.left_index, "right_index": dr.right_index,
                    "changes": dr.changes} for dr in diff]
        return {"ok": True, "diff": payload,
                "left": left.path, "right": right.path,
                "left_rows": self._rowvals(left.worksheet),
                "right_rows": self._rowvals(right.worksheet),
                "left_columns": left.worksheet.column_names(),
                "right_columns": right.worksheet.column_names(),
                "key_col": key_col,
                **self._hist.flags(left.path)}

    # -- merge ------------------------------------------------------------------------
    @staticmethod
    def _plan_col_map(sws, dws, key_col, col_map_data=None):
        """Карта dst col -> src col по именам заголовков + недостающие
        колонки источника (индекс, имя) для добавления в конец dst.

        col_map_data (явная карта из UI) используется как есть, без
        достройки колонок."""
        if col_map_data:
            return ({int(k): int(v) for k, v in col_map_data.items()}, [])
        col_map = comp_mod.build_col_map(sws, dws, key_col)
        mapped_src = set(col_map.values())
        have = set(dws.column_names())
        new_cols: "list[tuple[int, str]]" = []
        nxt = dws.column_count()
        for sci, name in enumerate(sws.column_names()):
            if not name or sci in mapped_src or name in have:
                continue
            new_cols.append((nxt, name))
            col_map[nxt] = sci
            nxt += 1
            mapped_src.add(sci)
            have.add(name)
        return col_map, new_cols

    @staticmethod
    def _src_cell_type(srow, scol):
        """Тип src-ячейки по ЛОГИЧЕСКОЙ колонке (sparse-safe)."""
        c = srow.cell_by_logical(scol + 1)
        return c.type if c is not None else None

    def _transfer_rows(self, dst, src, key_col, col_map_data, src_rows):
        """Spine-ядро переноса строк из src в dst.

        Все чтения — из lxml-видов ДО пакета, все записи — doc-операциями
        (спайн) в одном batch: содержимое сразу в сериализуемом тексте
        (save его запишет) и видно движку undo/redo. Возвращает
        (created, updated, steps, new_cols): steps — инверсии в порядке
        применения, new_cols — [(индекс, имя)] добавленных колонок."""
        dws = dst.worksheet
        sws = src.worksheet
        si = dst.sheet_index
        col_map, new_cols = self._plan_col_map(sws, dws, key_col, col_map_data)
        n_dst = len(dws.rows)
        tpl = dws.row_payload(dws.rows[-1]) if dws.rows else []
        created = updated = 0
        steps: "list[dict]" = []
        ops: "list[tuple]" = []  # ("new", r, cells) | ("upd", r, after, ri)
        for sri in src_rows:
            if not (0 <= sri < len(sws.rows)):
                continue
            srow = sws.rows[sri]
            key = srow.cell_value(key_col)
            dri = None
            for i, r in enumerate(dws.rows):
                if r.cell_value(key_col).strip() == key.strip():
                    dri = i
                    break
            if dri is None:
                # новая строка: геометрия по образцу последней строки dst
                # (позиции+стили), значения — из источника. Группы по
                # позициям: ручные файлы содержат дубли ss:Index
                # (две ячейки на одной logical) — схлопывать в dict нельзя,
                # иначе ячейка и её комментарий молча теряются
                groups = {}
                for c in tpl:
                    groups.setdefault(c[0], []).append(["", None, c[3], c[4]])
                for dcol, scol in col_map.items():
                    sv = srow.cell_value(scol)
                    st = self._src_cell_type(srow, scol)
                    lst = groups.get(dcol + 1)
                    if lst is None:
                        groups[dcol + 1] = [[sv, st, None, None]]
                    else:
                        for ent in lst:
                            ent[0], ent[1] = sv, st
                cells = [(p, e[0], e[1], e[2], e[3])
                         for p, lst in sorted(groups.items()) for e in lst]
                ops.append(("new", n_dst, cells))
                steps.append({"r": n_dst, "existed": False, "ri_o": None,
                              "cells_o": [], "ri_n": None, "cells_n": cells})
                n_dst += 1
                created += 1
            else:
                drow = dws.rows[dri]
                before = dws.row_payload(drow)
                bri = dws.row_index_attr(drow)
                groups = {}
                for c in before:
                    groups.setdefault(c[0], []).append([c[1], c[2], c[3], c[4]])
                changed = False
                for dcol, scol in col_map.items():
                    sv = srow.cell_value(scol)
                    if drow.cell_value(dcol) != sv:
                        lst = groups.get(dcol + 1)
                        if lst is None:
                            groups[dcol + 1] = [[sv, self._src_cell_type(srow, scol),
                                                 None, None]]
                        else:
                            # дубли logical: правится первое вхождение
                            # (его видит игра через cell_by_logical),
                            # остальные сохраняются как были
                            lst[0][0], lst[0][1] = (
                                sv, self._src_cell_type(srow, scol))
                        changed = True
                if not changed:
                    continue
                after = [(p, e[0], e[1], e[2], e[3])
                         for p, lst in sorted(groups.items()) for e in lst]
                ops.append(("upd", dri, after, bri))
                steps.append({"r": dri, "existed": True, "ri_o": bri,
                              "cells_o": before, "ri_n": bri, "cells_n": after})
                updated += 1
        with dst.doc.batch():
            for _c, name in new_cols:
                dst.doc.add_column(si, name)
            updates = [(o[1], o[2], o[3]) for o in ops if o[0] == "upd"]
            appends = [(o[2], None) for o in ops if o[0] == "new"]
            if updates or appends:
                dst.doc.merge_rows(si, updates, appends)
        return created, updated, steps, new_cols

    def _added_cols_payload(self, dws, new_cols):
        """Снапшот добавленных колонок из свежего вида (после пакета) для
        журнала: откат их убирает, повтор возвращает (формат col_set)."""
        out = []
        names = dws.column_names()
        for c, _name in new_cols:
            if not (0 <= c < len(names)):
                continue
            cells_n = {}
            for i, r in enumerate(dws.rows):
                cc = r.cell_by_logical(c + 1)
                if cc is not None:
                    cells_n[i] = [cc.value, dws.cell_type(cc), cc.style_id]
            out.append({"c": c, "existed": False, "name_o": "", "cells_o": {},
                        "name_n": names[c], "cells_n": cells_n})
        return out

    def merge_all(self, left_path: str, right_path: str,
                  key_col=0, default_key: str = "", mode: str = "all") -> dict:
        """Copy new/updated rows from the right (source) file into the left
        (base) file. Right wins on conflicts. Mode follows the compare
        filter: "all" (new + edited), "new" (only missing rows), "edited"
        (only changed rows).

        Пишет spine-операциями (содержимое сразу в сериализуемом тексте —
        save его сохранит) и одной записью журнала merge_rows: один клик
        undo откатывает всё слияние целиком."""
        dst = self._store.get(self._store.normal(left_path or ""))
        src = self._store.get(self._store.normal(right_path or ""))
        key_col = self._key_col(dst.worksheet, key_col, default_key)
        sws = src.worksheet
        all_src = list(range(len(sws.rows)))
        dst_keys = {r.cell_value(key_col).strip() for r in dst.worksheet.rows}
        wanted = []
        if mode in ("all", "new"):
            wanted.extend(sri for sri in all_src
                          if sws.rows[sri].cell_value(key_col).strip() not in dst_keys)
        if mode in ("all", "edited"):
            wanted.extend(sri for sri in all_src
                          if sws.rows[sri].cell_value(key_col).strip() in dst_keys)
        if mode not in ("all", "new", "edited"):
            wanted = all_src
        try:
            created, updated, steps, new_cols = self._transfer_rows(
                dst, src, key_col, None, wanted)
            added = self._added_cols_payload(dst.worksheet, new_cols)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}
        if steps or added:
            self._db.log_change(dst.path, "merge_rows",
                                {"mode": mode, "rows": steps, "cols": added},
                                "merge: %d created, %d updated (%s)"
                                % (created, updated, mode))
        # переносы в сравнении не пишут на диск: правки живут в памяти,
        # пользователь сохраняет их сам (кнопка сохранения / Ctrl+S)
        dst.dirty = True
        self._store.dirty.add(dst.path)
        return {"ok": True, "created": created, "updated": updated,
                **self._hist.flags(dst.path)}

    # -- listing ----------------------------------------------------------------------
    @staticmethod
    def list_xml(root: str) -> dict:
        """List .xml files under a folder (compare page path pickers)."""
        if not root or not os.path.isdir(root):
            return {"ok": False, "error": "not a folder"}
        root_abs = os.path.abspath(root)
        base_depth = root_abs.rstrip(os.sep).count(os.sep)
        found: "list[str]" = []
        for dirpath, dirnames, filenames in os.walk(root_abs):
            dirnames[:] = [d for d in dirnames
                           if not d.startswith(".") and d != "__pycache__"]
            if dirpath.count(os.sep) - base_depth > 5:
                dirnames[:] = []
                continue
            for fn in filenames:
                if fn.lower().endswith(".xml"):
                    found.append(os.path.relpath(os.path.join(dirpath, fn), root_abs))
            if len(found) >= 4000:
                break
        found.sort()
        return {"ok": True, "files": found}

    # -- transfer -----------------------------------------------------------------------
    def transfer_row(self, src_path: str, dst_path: str, src_row=0,
                     key_col=0, col_map_data=None) -> dict:
        """Одна строка стрелкой ⟵: тот же spine-перенос, что merge_all, но
        с одной записью row_set (один клик undo = одна строка)."""
        src = self._store.get(self._store.normal(src_path or ""))
        dst = self._store.get(self._store.normal(dst_path or ""))
        key_col = int(key_col)
        src_row = int(src_row)
        if not (0 <= src_row < len(src.worksheet.rows)):
            return {"ok": False, "error": "row out of range"}
        try:
            _c, _u, steps, _nc = self._transfer_rows(
                dst, src, max(key_col, 0), col_map_data or None, [src_row])
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}
        if steps:
            st = steps[0]
            created = not st["existed"]
            dst_row = st["r"]
        else:
            # строка-источник побайтово равна приёмнику: журнал всё равно
            # фиксирует перенос (как раньше), инверсия — тождественная
            dws = dst.worksheet
            key = src.worksheet.rows[src_row].cell_value(max(key_col, 0))
            dst_row = next((i for i, r in enumerate(dws.rows)
                            if r.cell_value(max(key_col, 0)).strip() == key.strip()),
                           -1)
            if dst_row < 0:
                return {"ok": False, "error": "row not found"}
            payload = dws.row_payload(dws.rows[dst_row])
            ri = dws.row_index_attr(dws.rows[dst_row])
            st = {"r": dst_row, "existed": True, "ri_o": ri,
                  "cells_o": payload, "ri_n": ri, "cells_n": payload}
            created = False
        self._db.log_change(dst.path, "row_set", st,
                            "row %s (r%d)" % ("created" if created else "transferred",
                                              dst_row))
        # перенос строки не пишет на диск — только в память (см. merge_all)
        dst.dirty = True
        self._store.dirty.add(dst.path)
        return {"ok": True, "dst_row": dst_row, "created": created,
                **self._hist.flags(dst.path)}

    def transfer_column(self, src_path: str, dst_path: str,
                        src_col=-1, dst_col=-1, key_col=0) -> dict:
        """Колонка стрелкой: значения src_col поверх dst_col по совпадению
        ключей. Пишет spine-операциями (пакетом), журнал — одна запись
        col_set. Тип ячеек не трогает (как раньше): только значения."""
        src = self._store.get(self._store.normal(src_path or ""))
        dst = self._store.get(self._store.normal(dst_path or ""))
        key_col = int(key_col)
        src_col, dst_col = int(src_col), int(dst_col)
        sws = src.worksheet
        dws = dst.worksheet
        si = dst.sheet_index
        if not (0 <= src_col < len(sws.column_names())):
            return {"ok": False, "error": "column out of range"}
        existed = 0 <= dst_col < dws.column_count()
        if existed:
            col1 = dst_col + 1
            name_o = dws.column_names()[dst_col]
            cells_o = {}
            for i, r in enumerate(dws.rows):
                c = r.cell_by_logical(col1)
                if c is not None:
                    cells_o[i] = [c.value, dws.cell_type(c)]
        else:
            name_o, cells_o = "", {}
            names = sws.column_names()
            name = names[src_col] if names else "new"
            try:
                with dst.doc.batch():
                    dst.doc.add_column(si, name)
                dws = dst.worksheet
                dst_col = dws.column_count() - 1
            except Exception as e:  # noqa: BLE001
                return {"ok": False, "error": str(e)}
        first_by_key = {}
        for sr, srow in enumerate(sws.rows):
            first_by_key.setdefault(srow.cell_value(key_col).strip(), sr)
        writes = []  # (dst_row, value)
        for dr, row in enumerate(dws.rows):
            sr = first_by_key.get(row.cell_value(key_col).strip())
            if sr is None:
                continue
            writes.append((dr, sws.rows[sr].cell_value(src_col)))
        try:
            with dst.doc.batch():
                for dr, val in writes:
                    dst.doc.set_cell_value(si, dr, dst_col, val, None)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}
        dws = dst.worksheet
        col1 = dst_col + 1
        name_n = dws.column_names()[dst_col]
        cells_n = {}
        for i, r in enumerate(dws.rows):
            c = r.cell_by_logical(col1)
            if c is not None:
                cells_n[i] = [c.value, dws.cell_type(c)]
        self._db.log_change(dst.path, "col_set",
                            {"c": dst_col, "existed": existed,
                             "name_o": name_o, "cells_o": cells_o,
                             "name_n": name_n, "cells_n": cells_n},
                            "column transferred (c%d)" % dst_col)
        # перенос колонки не пишет на диск — только в память (см. merge_all)
        dst.dirty = True
        self._store.dirty.add(dst.path)
        return {"ok": True, "dst_col": dst_col, **self._hist.flags(dst.path)}
