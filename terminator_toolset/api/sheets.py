"""Spreadsheet routes: open/edit/structure/save + unpacked-game guard."""
from __future__ import annotations

import glob
import os
import time

from flask import jsonify, request

from ..domain.spreadsheet_ml import SpreadsheetError

# species-файлы категорий + белые колонки статов для /api/species_stat
# (правка cost/потребления/вместимости из попапа кампании; произвольные
# колонки писать нельзя)
_STAT_FILES = {"squads": "squads.xml", "tanks": "tanks.xml",
               "cars": "cars.xml", "helicopters": "helicopters.xml",
               "inventory_items": "inventory_items.xml"}
_STAT_COLS = ("cost", "cp_cost", "supply_consumption", "people_capacity")

# -- синхронизация basis -> DLC внутри своего корня -----------------------
# Две галочки на вкладке таблицы («⇄ DLC Legion», «⇄ DLC Resistance»)
# зеркалят правку basis-файла в одноимённые species-файлы DLC-оверлеев
# ТОГО ЖЕ корня, где лежит открытый файл (проект — в проект, мод — в мод).
# Через корни (проект↔мод, игра→мод) зеркала нет; направление только вниз:
# правка DLC-файла никуда не зеркалится. Распакованная игра — не корень
# (сток не правим): для файлов вне проекта/мода галочки скрыты.
# Матчинг — ПО ИМЕНИ файла внутри оверлея: basis/scripts/species/<fn> ->
# dlc/<Legion|Resistance>/basis/scripts/species/<fn>. Сопоставление строк —
# по sysname (колонка 0), колонок — по имени заголовка. Спавны (.swt/.set)
# уникальны по режимам — сюда не входят. Каждый файл пишет СВОЮ запись
# истории (откат — отдельно по файлам). Несуществующие файлы не создаём.
_SYNC_SCOPES = ("legion", "resistance")


def _sync_scope_roots(ctx_entities, ctx_config):
    """{scope: root} подключённых разделов (существующие папки)."""
    roots = {}
    proj_root = ""
    try:
        proj = getattr(ctx_entities, "project", None)
        if proj is not None and getattr(proj, "root", None):
            proj_root = os.path.normpath(proj.root)
    except Exception:  # noqa: BLE001
        pass
    if not proj_root:
        for key in ("project_path", "last_project"):
            try:
                v = ctx_config.get(key) or ""
                if v and os.path.isdir(v):
                    proj_root = os.path.normpath(v)
                    break
            except Exception:  # noqa: BLE001
                continue
    try:
        if proj_root and os.path.isdir(proj_root):
            roots["project"] = proj_root
    except Exception:  # noqa: BLE001
        pass
    try:
        mod = ctx_config.get("mod_path") or ""
        if mod and os.path.isdir(mod):
            roots["mod"] = os.path.normpath(mod)
    except Exception:  # noqa: BLE001
        pass
    return roots


def _sync_own_root(source_path, roots):
    """(kind, root) корня, внутри которого лежит исходник, либо (None, None).

    kind — 'project'/'mod' (для подписи, куда уходит зеркало). Файлы
    распакованной игры и внешние файлы с диска — вне обоих корней: внутри
    своего пути им зеркалить некуда.
    """
    try:
        src = os.path.normcase(os.path.normpath(source_path or ""))
    except Exception:  # noqa: BLE001
        return None, None
    if not src:
        return None, None
    for kind in ("project", "mod"):
        root = roots.get(kind)
        if not root:
            continue
        try:
            if src.startswith(os.path.normcase(os.path.normpath(root))
                               + os.sep):
                return kind, root
        except Exception:  # noqa: BLE001
            continue
    return None, None


def _sync_source_state(source_path, root):
    """'basis'/'dlc'/'foreign' — где лежит исходник внутри СВОЕГО корня."""
    try:
        src = os.path.normcase(os.path.normpath(source_path or ""))
        basis = os.path.normcase(os.path.normpath(os.path.join(root, "basis")))
        dlc = os.path.normcase(os.path.normpath(os.path.join(root, "dlc")))
    except Exception:  # noqa: BLE001
        return "foreign"
    if src.startswith(basis + os.sep):
        return "basis"
    if src.startswith(dlc + os.sep):
        return "dlc"
    return "foreign"


def _sync_overlay_dir(root, scope):
    """Папка species DLC-оверлея (legion/resistance) корня либо None."""
    try:
        dlc = os.path.join(root, "dlc")
        for d in sorted(os.listdir(dlc)):
            if scope not in d.lower():
                continue
            cand = os.path.join(dlc, d, "basis", "scripts", "species")
            try:
                if os.path.isdir(cand):
                    return cand
            except Exception:  # noqa: BLE001
                continue
    except OSError:
        pass
    return None


def _sync_scope(source_path, roots, scopes):
    """[(scope, root, [sibling, ...])] для зеркала ВНИЗ внутри своего корня:
    одноимённые файлы в отмеченных DLC-оверлеях того же корня, где лежит
    исходник. Исходник обязан лежать в basis (правка DLC никуда не
    зеркалится), сам исходник из целей исключён."""
    fname = os.path.basename(source_path or "")
    if not fname:
        return []
    try:
        excl = os.path.normcase(os.path.normpath(source_path))
    except Exception:  # noqa: BLE001
        return []
    _kind, root = _sync_own_root(source_path, roots)
    if not root:
        return []
    if _sync_source_state(source_path, root) != "basis":
        return []
    scope = []
    for sc in scopes:
        if sc not in _SYNC_SCOPES:
            continue
        sibs = []
        d = _sync_overlay_dir(root, sc)
        if d:
            p = os.path.join(d, fname)
            try:
                if os.path.isfile(p) and os.path.normcase(
                        os.path.normpath(p)) != excl:
                    sibs.append(p)
            except Exception:  # noqa: BLE001
                pass
        if sibs:
            scope.append((sc, root, sibs))
    return scope


def _sync_row_index(session, sysname):
    """Индекс строки с таким sysname (strip-сравнение) либо None."""
    want = str(sysname or "").strip()
    try:
        rows = session.worksheet.rows
    except Exception:  # noqa: BLE001
        return None
    for i, r in enumerate(rows):
        try:
            if str(r.cell_value(0) or "").strip() == want:
                return i
        except Exception:  # noqa: BLE001
            continue
    return None


def _sync_col_index(session, header):
    """Индекс колонки с таким именем либо None."""
    want = str(header or "").strip()
    try:
        names = session.worksheet.column_names()
    except Exception:  # noqa: BLE001
        return None
    for i, h in enumerate(names):
        if str(h or "").strip() == want:
            return i
    return None


def register_sheets(app, ctx):
    """File sessions, cell/row/column edits, guard, save."""
    store, db, hist, saves, guard, entities, log, config = (
        ctx.store, ctx.db, ctx.hist, ctx.saves, ctx.guard, ctx.entities,
        ctx.log, ctx.config)

    def _sync_scopes(data):
        """Какие галочки («⇄ DLC Legion»/«⇄ DLC Resistance») включены в запросе."""
        try:
            return [sc for sc in _SYNC_SCOPES if (data or {}).get("sync_" + sc)]
        except Exception:  # noqa: BLE001
            return []

    @app.route("/api/sync_info", methods=["POST"])
    def api_sync_info():
        """Для вкладки таблицы: свой корень файла и цели зеркала вниз.

        Фронт показывает галочку оверлея, только если файл лежит внутри
        проекта/мода (свой корень есть). Галочка активна, только если
        исходник — basis-файл, а одноимённый файл есть в этом DLC-оверлее
        того же корня."""
        data = request.get_json(silent=True) or {}
        path = data.get("path", "")
        fname = os.path.basename(path or "")
        roots = _sync_scope_roots(entities, config)
        kind, root = _sync_own_root(path, roots)
        st = _sync_source_state(path, root) if root else "foreign"
        out = {"ok": True, "basis": st == "basis",
               "from_dlc": st == "dlc", "root": kind or "",
               "scopes": {}}
        for sc in _SYNC_SCOPES:
            target = None
            if root and fname:
                d = _sync_overlay_dir(root, sc)
                if d:
                    cand = os.path.join(d, fname)
                    try:
                        if os.path.isfile(cand):
                            target = cand
                    except Exception:  # noqa: BLE001
                        target = None
            sibs = []
            if target:
                sibs.append({"path": target,
                             "label": _sync_label(root, target)})
            out["scopes"][sc] = {
                "connected": bool(root),
                "eligible": bool(target),
                "siblings": sibs,
            }
        return jsonify(out)

    def _sync_label(root, sib):
        try:
            rel = os.path.relpath(sib, root).split(os.sep)
            if len(rel) > 1 and rel[0].lower() == "dlc":
                return "DLC " + rel[1]
        except Exception:  # noqa: BLE001
            pass
        return "base"

    def _sync_mirror(data, main, op, scopes, **kw):
        """Отразить операцию species-файла в сиблинги выбранных scope.

        Возвращает (synced, missing): synced — [{scope, path, label,
        applied, skipped, guarded, cells, structural}], missing —
        [{scope, path, label, sysnames}] (строки, которых нет в сиблинге —
        фронт спросит, копировать ли целиком). Защищённые (guard)
        сиблинги пропускаются.
        """
        synced, missing = [], []
        roots = _sync_scope_roots(entities, config)
        scope = _sync_scope(getattr(main, "path", ""), roots, scopes)
        for sc, root, sibs in scope:
            for sib in sibs:
                label = _sync_label(root, sib)
                entry = {"scope": sc, "path": sib, "label": label,
                         "applied": 0, "skipped": [], "guarded": False,
                         "cells": [], "structural": False}
            try:
                if guard.guarded(sib):
                    entry["guarded"] = True
                    entry["skipped"].append("guarded")
                    synced.append(entry)
                    continue
                s2 = store.get(sib)
            except SpreadsheetError as e:
                entry["skipped"].append("unreadable: %s" % e)
                synced.append(entry)
                continue
            except Exception as e:  # noqa: BLE001
                entry["skipped"].append(str(e))
                synced.append(entry)
                continue
            try:
                if op == "cells":
                    miss = []
                    for it in kw.get("items") or []:
                        ri = _sync_row_index(s2, it.get("sysname"))
                        if ri is None:
                            if it.get("sysname") not in miss:
                                miss.append(it.get("sysname"))
                            continue
                        ci = _sync_col_index(s2, it.get("header"))
                        if ci is None:
                            entry["skipped"].append(
                                "%s: no column %s" % (it.get("sysname"),
                                                      it.get("header")))
                            continue
                        res = s2.edit_cell(ri, ci, it.get("value", ""),
                                           it.get("type"))
                        if res["ok"] and res.get("payload"):
                            db.log_change(
                                s2.path, "edit", res["payload"],
                                "⇄ %s %s: %s -> %s" % (
                                    it.get("sysname"), it.get("header"),
                                    hist.short_val(res["old"]),
                                    hist.short_val(it.get("value", ""))))
                            entry["applied"] += 1
                            entry["cells"].append(
                                {"row": ri, "col": ci,
                                 "value": it.get("value", "")})
                    if miss:
                        missing.append({"scope": sc, "path": sib,
                                        "label": label, "sysnames": miss})
                elif op == "add_row":
                    sysname = kw.get("sysname") or ""
                    if _sync_row_index(s2, sysname) is not None:
                        entry["skipped"].append("%s: exists" % sysname)
                    else:
                        by_head = kw.get("by_header") or {}
                        names2 = s2.worksheet.column_names()
                        vals = [by_head.get(str(h or "").strip(), "")
                                for h in names2]
                        res = s2.add_row(vals)
                        if res.get("ok"):
                            db.log_change(
                                s2.path, "add_row", res["payload"],
                                "⇄ row added (%s)" % sysname)
                            entry["applied"] += 1
                            entry["structural"] = True
                elif op == "del_row":
                    sysname = kw.get("sysname") or ""
                    ri = _sync_row_index(s2, sysname)
                    if ri is None:
                        entry["skipped"].append("%s: no such row" % sysname)
                    else:
                        res = s2.delete_row(ri)
                        if res.get("ok"):
                            db.log_change(
                                s2.path, "del_row", res["payload"],
                                "⇄ row deleted (%s)" % sysname)
                            entry["applied"] += 1
                            entry["structural"] = True
                elif op == "add_col":
                    name = kw.get("name") or ""
                    if _sync_col_index(s2, name) is not None:
                        entry["skipped"].append("%s: exists" % name)
                    else:
                        res = s2.add_column(name)
                        if res.get("ok"):
                            db.log_change(
                                s2.path, "add_col", res["payload"],
                                "⇄ column added: %s" % name)
                            entry["applied"] += 1
                            entry["structural"] = True
                elif op == "del_col":
                    name = kw.get("name") or ""
                    ci = _sync_col_index(s2, name)
                    if ci is None:
                        entry["skipped"].append("%s: no such column" % name)
                    else:
                        res = s2.delete_column(ci)
                        if res.get("ok"):
                            db.log_change(
                                s2.path, "del_col", res["payload"],
                                "⇄ column deleted: %s" % name)
                            entry["applied"] += 1
                            entry["structural"] = True
                saved2 = saves.autosaved(data, s2, None)
                saves.mark_dirty(s2, saved2)
                entry["saved"] = bool(saved2)
            except Exception as e:  # noqa: BLE001
                entry["skipped"].append(str(e))
            synced.append(entry)
        return synced, missing

    @app.route("/api/open_file", methods=["POST"])
    def api_open_file():
        data = request.get_json(silent=True) or {}
        path = data.get("path", "")
        recover = bool(data.get("recover"))
        reset = bool(data.get("reset"))   # «Отменить все изменения»: сбросить
        # кэшированную сессию и перечитать файл с диска (правки в памяти теряются)
        t0 = time.time()
        log.info("open_file: %s (recover=%s)", path, recover)
        if not path or not os.path.isfile(path):
            return jsonify({"ok": False, "error": "not a file"})
        pk = store.normal(path)
        if reset:
            store.drop(pk)
        try:
            s = store.get(path, recover=recover)
        except SpreadsheetError as e:
            # recoverable=True -> фронт предлагает аварийное открытие
            return jsonify({"ok": False, "error": str(e),
                            "recoverable": not recover})
        log.info("open_file done in %.2fs: %s (%d rows)",
                 time.time() - t0, path, len(s.worksheet.rows))
        db.add_recent("file", path)
        entities.rebuild(s)
        return jsonify({"ok": True, "file": hist.file_payload(s),
                        "edited": saves.path_edited(path), **hist.flags(s.path)})

    @app.route("/api/file")
    def api_file():
        path = request.args.get("path", "")
        if not path or not os.path.isfile(path):
            return jsonify({"ok": False, "error": "not a file"})
        try:
            s = store.get(path)
        except SpreadsheetError as e:
            return jsonify({"ok": False, "error": str(e)})
        return jsonify({"ok": True, **hist.file_payload(s)})

    @app.route("/api/switch_sheet")
    def api_switch_sheet():
        path = request.args.get("path", "")
        idx = int(request.args.get("index", "0"))
        s = store.get(path)
        s.switch_sheet(idx)
        return jsonify(hist.file_payload(s))

    # -- API: edits ------------------------------------------------------------
    @app.route("/api/edit", methods=["POST"])
    def api_edit():
        data = request.get_json(silent=True) or {}
        path = store.normal(data.get("path", ""))
        s = store.get(path)
        row = int(data.get("row", -1))
        col = int(data.get("col", -1))
        if not (0 <= row < len(s.worksheet.rows)):
            return jsonify({"ok": False, "error": "row out of range"})
        res = s.edit_cell(row, col, data.get("value", ""), data.get("type"))
        if not res["ok"]:
            return jsonify(res)
        names = s.worksheet.column_names()
        colname = names[col] if 0 <= col < len(names) else "c%d" % col
        # row identity for the history: the sysname (first column), e.g.
        # "shell_120heat bulding_miss_factor: 0.1 -> 5"
        rowkey = hist.short_val(s.worksheet.rows[row].cell_value(0), 24) or ("r%d" % row)
        summary = "%s %s: %s -> %s" % (rowkey, colname,
                                       hist.short_val(res["old"]), hist.short_val(data.get("value", "")))
        db.log_change(s.path, "edit", res["payload"], summary)
        saved = saves.autosaved(data, s, None)
        saves.mark_dirty(s, saved)
        out = {"ok": True, "old": res["old"], "new": data.get("value", ""),
               "saved": saved, **hist.flags(s.path)}
        # галочки «⇄ DLC Legion»/«⇄ DLC Resistance»: зеркало вниз в свой корень
        if res.get("payload") and _sync_scopes(data):
            # правка самого sysname: сиблинги искать по СТАРОМУ имени
            sysname = res["old"] if col == 0 \
                else s.worksheet.rows[row].cell_value(0)
            synced, missing = _sync_mirror(
                data, s, "cells", _sync_scopes(data),
                items=[{"sysname": sysname, "header": colname,
                        "value": data.get("value", ""),
                        "type": data.get("type")}])
            out["synced"] = synced
            out["missing"] = missing
        return jsonify(out)

    @app.route("/api/edit_cells", methods=["POST"])
    def api_edit_cells():
        """Пачка правок ячеек ОДНОЙ записью истории.

        Вставка/перенос на карте Uprising трогает десятки ячеек: раньше
        каждая шла отдельным /api/edit (своя запись, свой undo-шаг + гонка
        параллельных правок одного файла). Теперь вся команда — один шаг
        отмены и один запрос."""
        data = request.get_json(silent=True) or {}
        path = store.normal(data.get("path", ""))
        s = store.get(path)
        cells = data.get("cells") or []
        if not isinstance(cells, list) or not cells:
            return jsonify({"ok": False, "error": "no cells"})
        if len(cells) > 2000:
            return jsonify({"ok": False, "error": "too many"})
        names = s.worksheet.column_names()
        done = []
        ctypes = []
        # ячейки мимо строк/колонок больше не теряются молча: счётчик
        # уезжает фронту, он решает, предупреждать ли пользователя
        skipped = 0
        for ce in cells:
            if not isinstance(ce, dict):
                skipped += 1
                continue
            try:
                row = int(ce.get("row", -1))
                col = int(ce.get("col", -1))
            except (TypeError, ValueError):
                skipped += 1
                continue
            if not (0 <= row < len(s.worksheet.rows)):
                skipped += 1
                continue
            if not (0 <= col < len(names)):
                skipped += 1
                continue
            res = s.edit_cell(row, col, ce.get("value", ""), ce.get("type"))
            if res["ok"] and res.get("payload"):
                done.append(res["payload"])
                ctypes.append(ce.get("type"))
            else:
                skipped += 1
        if not done:
            return jsonify({"ok": True, "changed": False, "n": 0,
                            "skipped": skipped,
                            **hist.flags(s.path)})
        first = done[0]
        rowkey = hist.short_val(s.worksheet.rows[first["r"]].cell_value(0), 24) \
            or ("r%d" % first["r"])
        colname = names[first["c"]] if 0 <= first["c"] < len(names) \
            else "c%d" % first["c"]
        if len(done) == 1:
            summary = "%s %s: %s -> %s" % (
                rowkey, colname, hist.short_val(first["o"]), hist.short_val(first["n"]))
        else:
            summary = "%s %s (+%d)" % (rowkey, colname, len(done) - 1)
        # фронт может дать готовую подпись (напр. «замена 'a' → 'b' (N)»):
        # вся пачка всё равно пишется одной записью
        try:
            custom = str(data.get("summary") or "").strip()
        except Exception:  # noqa: BLE001
            custom = ""
        if custom:
            summary = custom[:160]
        db.log_change(s.path, "edit_cells", {"cells": done}, summary)
        saved = saves.autosaved(data, s, None)
        saves.mark_dirty(s, saved)
        out = {"ok": True, "changed": True, "n": len(done),
               "saved": saved, "skipped": skipped,
               **hist.flags(s.path)}
        # пачка тоже зеркалится вниз (замена через поиск в species-таблице):
        # item ищется по sysname+header, как одиночный /api/edit
        if _sync_scopes(data):
            items = []
            for p, tp in zip(done, ctypes):
                try:
                    sysname = p["o"] if p["c"] == 0 \
                        else s.worksheet.rows[p["r"]].cell_value(0)
                    items.append({"sysname": sysname,
                                  "header": names[p["c"]]
                                  if 0 <= p["c"] < len(names)
                                  else "c%d" % p["c"],
                                  "value": p["n"], "type": tp})
                except Exception:  # noqa: BLE001
                    continue
            if items:
                synced, missing = _sync_mirror(
                    data, s, "cells", _sync_scopes(data), items=items)
                out["synced"] = synced
                out["missing"] = missing
        return jsonify(out)

    @app.route("/api/species_stat", methods=["POST"])
    def api_species_stat():
        """Запись статов юнита/предмета (cost/cp_cost/supply_consumption/
        people_capacity) из попапа кампании — в species-файл, одной записью
        истории (как edit_cells). Файл — первый (base, затем DLC), где есть
        строка sysname: тот же порядок, что чтение цен, иначе шильдик
        и попап разъедутся с записью. В ответе path + cells — фронт обновляет
        шильдик и открытые таблицы того же файла."""
        data = request.get_json(silent=True) or {}
        root = store.normal(data.get("root", ""))
        cat = str(data.get("cat", ""))
        name = str(data.get("name", "")).strip()
        stats = data.get("stats") or {}
        fn = _STAT_FILES.get(cat)
        cols = [c for c in _STAT_COLS
                if isinstance(stats, dict) and c in stats]
        if not fn or not name or not cols \
                or not root or not os.path.isdir(root):
            return jsonify({"ok": False, "error": "bad request"})
        paths = [os.path.join(root, "basis", "scripts", "species", fn)]
        paths.extend(sorted(glob.glob(os.path.join(
            root, "dlc", "*", "basis", "scripts", "species", fn))))
        existing = [p for p in paths if os.path.isfile(p)]
        # файла категории нет вообще (ни base, ни DLC): сообщить, какой
        # файл ожидался, а не молчать — иначе цена «сохраняется» в никуда
        if not existing:
            return jsonify({"ok": False, "error": "no_species_file",
                            "file": fn, "cat": cat, "name": name})
        target = None
        for p in existing:
            try:
                s = store.get(p)
            except SpreadsheetError:
                continue
            names = s.worksheet.column_names()
            try:
                ri = next(i for i, r in enumerate(s.worksheet.rows)
                          if str(r.cell_value(0) or "").strip() == name)
            except StopIteration:
                continue
            target = (p, s, ri, names)
            break
        # файлы есть, а строки с таким sysname ни в одном нет: отдать имя
        # юнита и первый проверенный файл для понятного сообщения
        if not target:
            return jsonify({"ok": False, "error": "no_such_unit",
                            "file": os.path.basename(existing[0]),
                            "cat": cat, "name": name})
        p, s, ri, names = target
        done = []
        cells = []
        skipped = []
        for c in cols:
            try:
                ci = next(i for i, h in enumerate(names)
                          if str(h).strip() == c)
            except StopIteration:
                # колонки нет в файле: не молчим — фронт предупредит,
                # какое значение куда не записалось
                skipped.append(c)
                continue
            val = str(stats[c]).strip()
            res = s.edit_cell(ri, ci, val, None)
            if res["ok"] and res.get("payload"):
                done.append(res["payload"])
                cells.append({"row": ri, "col": ci, "value": val})
        # ни одна колонка не записалась: все запрошенные отсутствуют
        # в файле — это ошибка, а не «без изменений»
        if not done:
            return jsonify({"ok": False, "error": "no_stat_column",
                            "file": os.path.basename(p), "cat": cat,
                            "name": name, "columns": skipped})

        first = done[0]
        colname = names[first["c"]] if 0 <= first["c"] < len(names) \
            else "c%d" % first["c"]
        if len(done) == 1:
            summary = "%s %s: %s -> %s" % (
                name, colname, hist.short_val(first["o"]),
                hist.short_val(first["n"]))
        else:
            summary = "%s %s (+%d)" % (name, colname, len(done) - 1)
        db.log_change(s.path, "edit_cells", {"cells": done}, summary)
        saved = saves.autosaved(data, s, None)
        saves.mark_dirty(s, saved)
        return jsonify({"ok": True, "changed": True, "path": p,
                        "cells": cells, "saved": saved,
                        "skipped": skipped,
                        **hist.flags(s.path)})

    @app.route("/api/add_row", methods=["POST"])
    def api_add_row():
        data = request.get_json(silent=True) or {}
        s = store.get(data.get("path", ""))
        res = s.add_row(data.get("values"))
        if res.get("ok"):
            db.log_change(s.path, "add_row", res["payload"],
                          "row added (%d)" % (res["row"] + 1))
            saved = saves.autosaved(data, s, None)
            saves.mark_dirty(s, saved)
        out = {**res, "saved": res.get("ok") and saved, **hist.flags(s.path)}
        if res.get("ok") and _sync_scopes(data):
            names = s.worksheet.column_names()
            vals = data.get("values") or []
            by_header = {}
            for i, h in enumerate(names):
                if i < len(vals):
                    by_header[str(h or "").strip()] = vals[i]
            sysname = by_header.get(str(names[0]).strip() if names else "", "")
            synced, _missing = _sync_mirror(data, s, "add_row",
                                            _sync_scopes(data),
                                            sysname=sysname,
                                            by_header=by_header)
            out["synced"] = synced
            out["missing"] = []
        return jsonify(out)

    @app.route("/api/delete_row", methods=["POST"])
    def api_delete_row():
        data = request.get_json(silent=True) or {}
        s = store.get(data.get("path", ""))
        row = int(data.get("row", -1))
        sysname = ""
        if 0 <= row < len(s.worksheet.rows):
            sysname = s.worksheet.rows[row].cell_value(0)
        res = s.delete_row(row)
        if res.get("ok"):
            db.log_change(s.path, "del_row", res["payload"], "row deleted (r%d)" % row)
            saved = saves.autosaved(data, s, None)
            saves.mark_dirty(s, saved)
        out = {**res, "saved": res.get("ok") and saved, **hist.flags(s.path)}
        if res.get("ok") and _sync_scopes(data):
            synced, _missing = _sync_mirror(data, s, "del_row",
                                            _sync_scopes(data),
                                            sysname=sysname)
            out["synced"] = synced
            out["missing"] = []
        return jsonify(out)

    @app.route("/api/add_column", methods=["POST"])
    def api_add_column():
        data = request.get_json(silent=True) or {}
        s = store.get(data.get("path", ""))
        name = data.get("name", "new")
        res = s.add_column(name)
        if res.get("ok"):
            db.log_change(s.path, "add_col", res["payload"], "column added: %s" % name)
            saved = saves.autosaved(data, s, None)
            saves.mark_dirty(s, saved)
        out = {**res, "saved": res.get("ok") and saved, **hist.flags(s.path)}
        if res.get("ok") and _sync_scopes(data):
            synced, _missing = _sync_mirror(data, s, "add_col",
                                            _sync_scopes(data), name=name)
            out["synced"] = synced
            out["missing"] = []
        return jsonify(out)

    @app.route("/api/delete_column", methods=["POST"])
    def api_delete_column():
        data = request.get_json(silent=True) or {}
        s = store.get(data.get("path", ""))
        col = int(data.get("col", -1))
        name = ""
        try:
            names = s.worksheet.column_names()
            if 0 <= col < len(names):
                name = names[col]
        except Exception:  # noqa: BLE001
            pass
        res = s.delete_column(col)
        if res.get("ok"):
            db.log_change(s.path, "del_col", res["payload"], "column deleted (c%d)" % col)
            saved = saves.autosaved(data, s, None)
            saves.mark_dirty(s, saved)
        out = {**res, "saved": res.get("ok") and saved, **hist.flags(s.path)}
        if res.get("ok") and _sync_scopes(data):
            synced, _missing = _sync_mirror(data, s, "del_col",
                                            _sync_scopes(data), name=name)
            out["synced"] = synced
            out["missing"] = []
        return jsonify(out)

    @app.route("/api/sync_copy_rows", methods=["POST"])
    def api_sync_copy_rows():
        """Второй шаг галочек «⇄ DLC Legion»/«⇄ DLC Resistance»:
        пользователь подтвердил копирование строк, которых нет в сиблингах,
        — дописать их целиком (покарточно по заголовкам) в указанных
        оверлеях. Возвращает synced в том же формате, что правки."""
        data = request.get_json(silent=True) or {}
        s = store.get(data.get("path", ""))
        scopes = [sc for sc in (data.get("scopes") or [])
                  if sc in _SYNC_SCOPES] or _sync_scopes(data)
        want = [str(x or "").strip() for x in (data.get("sysnames") or [])]
        want = [w for w in want if w]
        if not want:
            return jsonify({"ok": False, "error": "no rows"})
        try:
            names = s.worksheet.column_names()
        except Exception as e:  # noqa: BLE001
            return jsonify({"ok": False, "error": str(e)})
        by_sys = {}
        for r in s.worksheet.rows:
            try:
                key = str(r.cell_value(0) or "").strip()
            except Exception:  # noqa: BLE001
                continue
            if key in want and key not in by_sys:
                by_sys[key] = [r.cell_value(i)
                               for i in range(len(names))]
        if not by_sys:
            return jsonify({"ok": False, "error": "no such rows"})
        synced_all, missing_all = [], []
        for key, vals in by_sys.items():
            by_header = {}
            for i, h in enumerate(names):
                if i < len(vals):
                    by_header[str(h or "").strip()] = vals[i]
            synced, _missing = _sync_mirror(data, s, "add_row", scopes,
                                            sysname=key,
                                            by_header=by_header)
            synced_all.extend(synced)
        return jsonify({"ok": True, "synced": synced_all,
                        "missing": missing_all,
                        **hist.flags(s.path)})

    # -- edited-files marks (configs/markers.json, секции) --------
    # (owned by SavePipeline: saves.mark_edited / remove_edited_mark)

    # -- защита распакованной игры ------------------------------------------
    # (owned by Guard: guard.roots / guard.guarded)

    @app.route("/api/guard_check", methods=["POST"])
    def api_guard_check():
        """Защищён ли путь + куда можно сохранить (имена проекта/мода)."""
        data = request.get_json(silent=True) or {}
        g = guard.roots()
        proj = g["project"] if g["project"] and g["project"] != "." \
            and os.path.isdir(g["project"]) else ""
        mod = g["mod"] if g["mod"] and g["mod"] != "." \
            and os.path.isdir(g["mod"]) else ""
        return jsonify({
            "ok": True,
            "guarded": guard.guarded(data.get("path", "")),
            "project": {"root": proj, "name": os.path.basename(proj)} if proj else None,
            "mod": {"root": mod, "name": os.path.basename(mod)} if mod else None,
        })

    @app.route("/api/save", methods=["POST"])
    def api_save():
        data = request.get_json(silent=True) or {}
        path = store.normal(data.get("path", ""))
        s = store.get(path)
        res = saves.safe_save(s)
        # «Сохранить» главного с включёнными галками дописывает и зеркало:
        # без автосейва сиблинг висел dirty в памяти и терялся при рестарте
        scopes = _sync_scopes(data)
        if scopes and res.get("ok"):
            roots = _sync_scope_roots(entities, config)
            saved_labels = []
            try:
                dirty = {os.path.normcase(os.path.normpath(p))
                         for p in (store.dirty or set())}
            except Exception:  # noqa: BLE001
                dirty = set()
            for sc, root, sibs in _sync_scope(path, roots, scopes):
                for sib in sibs:
                    try:
                        key = os.path.normcase(os.path.normpath(sib))
                    except Exception:  # noqa: BLE001
                        continue
                    if key not in dirty or guard.guarded(sib):
                        continue
                    try:
                        if saves.safe_save(store.get(sib)).get("ok"):
                            saved_labels.append(
                                {"label": _sync_label(root, sib),
                                 "path": sib})
                    except Exception:  # noqa: BLE001
                        continue
            if saved_labels:
                res["sync_saved"] = saved_labels
        return jsonify(res)
