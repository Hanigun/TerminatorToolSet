/* TerminatorToolSet frontend — history.js: undo/redo + панель истории
   Вырезано из app.js без изменений логики. Классические скрипты,
   общий глобальный скоуп, порядок загрузки — FILES в templates/index.html. */
// ---------- undo / redo (diff-journal based, like the History panel) ----------
async function reloadActiveFile() {
  const tab = state.tabs.find(tb => tb.id === state.activeTabId);
  if (!tab || tab.type !== "file") return;
  try {
    const r = await api("/api/file?path=" + encodeURIComponent(tab.path));
    const f = await r.json();
    tab.fileData = f;
    tab.dirty = false;
    if (state.activeTabId === tab.id) {
      state.currentFile = f;
      state.selectedRow = null;
      state.dirty = false;
      updateDirty();
      renderTabBar();
      renderGrid();
      loadLinks();
    }
  } catch (e) { /* keep the old grid on network errors */ }
}

function setUndoRedoButtons(canUndo, canRedo) {
  const bu = $("#btn-undo"), br = $("#btn-redo");
  if (bu) bu.disabled = !canUndo;
  if (br) br.disabled = !canRedo;
}

// ---------- реестр страниц истории (глобально для любых страниц) ----------
// Новая страница одним вызовом получает undo/redo, журнал и кнопки без
// правок ядра: registerHistPage("units", { paths: untHistPaths,
// repaint: untRepaintUndo, hint: () => state.units,
// sync: untSyncUndoButtons, clean: untMarkClean }).
// paths() — файлы страницы для журнала и undo; repaint() — перекрасить
// страницу после серверного изменения; hint() — объект под redoHint;
// sync() — обновить кнопки undo/redo; clean() — снять грязность.
const histPageProviders = {};
function registerHistPage(id, provider) {
  if (id && provider) histPageProviders[id] = provider;
}
function histPageProvider() {
  try {
    const tab = state.tabs.find(tb => tb.id === state.activeTabId);
    if (tab) {
      if (histPageProviders[tab.id]) return histPageProviders[tab.id];
      if (histPageProviders[tab.type]) return histPageProviders[tab.type];
    }
    if (histPageProviders[state.activeTabId]) return histPageProviders[state.activeTabId];
  } catch (e) { /* без поставщика — штатные ветки ниже */ }
  return null;
}

// Fast in-place application of an undo/redo patch: only cell patches skip
// the full re-render; structural ones (row/column) reload the grid;
// whole-file patches (swt saves, configs) reload the open file.
async function applyUndoPatch(patch) {
  if (!patch) { await reloadActiveFile(); return; }
  if (patch.kind === "file") { await reloadActiveFile(); return; }
  if (patch.kind === "cell") {
    const f = state.currentFile;
    const row = f && f.rows[patch.row];
    if (!row || row.values[patch.col] === undefined) { await reloadActiveFile(); return; }
    row.values[patch.col] = patch.value;
    if (patch.col === 0) row.key = patch.value;
    const table = getActiveGridTable();
    const tr = table && table.querySelector(`tbody tr[data-row-index="${patch.row}"]`);
    const td = tr && tr.children[patch.col];
    if (td) {
      renderCellContent(td, patch.row, patch.col, patch.value);
      if (state.find.active && state.find.keySet.has(patch.row + ":" + patch.col)) {
        td.classList.add("find-hit");
      }
    } else {
      renderGrid(); // row not virtualized - repaint
    }
  } else {
    await reloadActiveFile();
  }
}

// флаги undo/redo для файлов страницы одним запросом (вместо веера
// GET /api/history на каждый клик и каждую перерисовку кнопок)
async function histFlagsBatch(paths) {
  const out = {};
  const list = (paths || []).filter(Boolean);
  if (!list.length) return out;
  try {
    const r = await api("/api/history_flags", { method: "POST",
      body: JSON.stringify({ paths: list }) });
    const j = await r.json();
    if (j && j.ok && j.flags) return j.flags;
  } catch (e) { /* кнопки останутся как были */ }
  return out;
}

// кнопки тулбара — ИЛИ по флагам файлов страницы
function histApplyFlags(flags) {
  try {
    const list = Object.values(flags || {});
    if (!list.length) return;
    setUndoRedoButtons(list.some(f => f && f.can_undo),
      list.some(f => f && f.can_redo));
  } catch (e) {}
}

// карты правят два файла (карта + species-правки попапа): один клик —
// одно действие на сервере (файл с самой свежей записью, redo — redoHint),
// кнопки и флаги едут в том же ответе
async function mapUndoRedo(endpoint, st, pathsFn, repaintFn, okMsg, noneMsg) {
  const forward = endpoint.indexOf("/api/redo") !== -1;
  const paths = pathsFn();
  if (!paths.length) { toast(t("no_file")); return; }
  if (state.histBusy) return;
  state.histBusy = true;
  try {
    const r = await api(forward ? "/api/page_redo" : "/api/page_undo",
      { method: "POST",
        body: JSON.stringify({ paths, hint: forward ? (st.redoHint || "") : "" }) });
    const j = await r.json();
    const target = j && j.path;
    if (!j.ok) {
      if (j.error === "nothing_to_undo" || j.error === "nothing_to_redo") {
        toast(noneMsg);
      } else {
        toast(j.error || "error", "err");
      }
      histApplyFlags(j.flags);
      try { await repaintFn(); } catch (e) {}
      return;
    }
    // чужой файл (species): открытые вкладки — точечно или stale-метка
    try {
      if (target !== paths[0]) {
        if (j.patch && j.patch.kind === "cell" && j.patch.row != null)
          syncFileTabsCells(target, [{ row: j.patch.row, col: j.patch.col,
            value: j.patch.value }]);
        else if (typeof markFileTabsStale === "function")
          markFileTabsStale(target);
      }
    } catch (e) {}
    st.redoHint = forward ? "" : target;
    await repaintFn();
    // чужой файл страницы (конфиг/режим рандомайзера): открытый редактор
    // этого файла перечитывает диск, остальные редакторы не трогаем
    try {
      if (typeof uprCfgEdRefreshIf === "function") uprCfgEdRefreshIf(target);
    } catch (e) {}
    histApplyFlags(j.flags);
    toast(okMsg, "ok");
  } finally {
    state.histBusy = false;
  }
}

// открытый попап превью-конфига поверх страницы: его файл — тоже цель
// undo/redo и журнала (тулбар иначе бил бы по файлу под попапом)
function pv3PopupTarget() {
  try {
    const pop = (typeof m3dPopEl !== "undefined" && m3dPopEl) || null;
    const pv3 = pop && pop.isConnected && pop._pv3;
    if (pv3 && pv3.cfgPath) return { pop, pv3, path: pv3.cfgPath };
  } catch (e) { /* попапа нет — штатные ветки ниже */ }
  return null;
}

async function pv3PopupUndoRedo(endpoint, okMsg, noneMsg) {
  const tgt = pv3PopupTarget();
  if (!tgt) { toast(t("no_file")); return; }
  if (state.histBusy) return;
  state.histBusy = true;
  try {
    const r = await api(endpoint, { method: "POST",
      body: JSON.stringify({ path: tgt.path }) });
    const j = await r.json();
    if (!j.ok) {
      setUndoRedoButtons(!!j.can_undo, !!j.can_redo);
      if (j.error === "nothing_to_undo" || j.error === "nothing_to_redo") {
        toast(noneMsg);
      } else {
        toast(j.error || "error", "err");
      }
      return;
    }
    // диск под попапом сменился — перечитать конфиг
    try {
      if (typeof pv3LoadConfig === "function") pv3LoadConfig(tgt.pv3, tgt.pv3.config);
    } catch (e) {}
    setUndoRedoButtons(!!j.can_undo, !!j.can_redo);
    toast(okMsg, "ok");
  } finally {
    state.histBusy = false;
  }
}

async function runUndoRedo(endpoint, okMsg, noneMsg) {
  // работает везде, где происходят правки: попап превью-конфига — свой
  // файл поверх страницы, файловые вкладки — свой файл, сравнение —
  // сторона последнего касания, карты — мультиистория через роутер
  const pv3t = pv3PopupTarget();
  if (pv3t) { await pv3PopupUndoRedo(endpoint, okMsg, noneMsg); return; }
  const tab = state.tabs.find(tb => tb.id === state.activeTabId);
  let path = null, isCompare = false, isUprising = false, isCampaign = false;
  let cmpPaths = null; // [{side, path}] в порядке фокуса — для page_undo
  if (tab && tab.type === "file") path = tab.path;
  else if (tab && tab.type === "compare") {
    cmpPaths = cmpOrderedPaths();
    if (cmpPaths.length) isCompare = true;
  }
  else if (state.activeTabId === "uprising" && state.uprising.path) {
    path = state.uprising.path;
    isUprising = true;
  }
  else if (state.activeTabId === "campaign" && state.campaign.path) {
    path = state.campaign.path;
    isCampaign = true;
  }
  // страницы из реестра (юниты и любые будущие): мультиистория через общий
  // роутер — файл с самой свежей записью, кнопки — ИЛИ по файлам страницы
  const prov = histPageProvider();
  if (prov && typeof prov.paths === "function" && typeof prov.repaint === "function") {
    await mapUndoRedo(endpoint,
      (typeof prov.hint === "function" && prov.hint()) || {},
      prov.paths, prov.repaint, okMsg, noneMsg);
    return;
  }
  if (!path && !isCompare) { toast(t("no_file")); return; }
  // карты — мультиистория (карта + species): свой роутер, общий POST ниже
  // им не нужен (иначе один клик отменял бы сразу две записи)
  if (isUprising) { await mapUndoRedo(endpoint, state.uprising, uprHistPaths, uprRepaintUndo, okMsg, noneMsg); return; }
  if (isCampaign) { await mapUndoRedo(endpoint, state.campaign, cmpHistPaths, cmpRepaintUndo, okMsg, noneMsg); return; }
  if (state.histBusy) return;   // one request at a time (no repeat pile-up)
  state.histBusy = true;
  try {
    // сравнение: один page-запрос (выбор стороны — на сервере по фокусу),
    // флаги обеих сторон едут в том же ответе
    if (isCompare) {
      const forward = endpoint.indexOf("/api/redo") !== -1;
      const r = await api(forward ? "/api/page_redo" : "/api/page_undo",
        { method: "POST", body: JSON.stringify({
          paths: cmpPaths.map(x => x.path), prefer: cmpPaths[0].path }) });
      const j = await r.json();
      const hit = (cmpPaths || []).find(x => x.path === (j && j.path));
      const cmpSide = hit && hit.side;
      const d = cmpSide && state.cmpData && state.cmpData[cmpSide];
      if (j.flags && j.flags[j.path]) {
        const fl = { can_undo: !!j.flags[j.path].can_undo,
          can_redo: !!j.flags[j.path].can_redo };
        if (d) d.flags = fl;
      }
      if (!j.ok) {
        histApplyFlags(j.flags);
        if (j.error === "nothing_to_undo" || j.error === "nothing_to_redo") {
          toast(noneMsg);
        } else {
          toast(j.error || "error", "err");
        }
        return;
      }
      // правка на сервере уже отменена/возвращена: экран обязан показать
      // новое состояние даже если штатная перерисовка упадёт (иначе строка
      // визуально остаётся, а кнопки врут) — кнопки и тост ниже идут всегда
      try {
        await compareRepaintUndo(cmpSide, j.patch);
      } catch (e) {
        try {
          if (state.compare) { state.compare = null; await refreshCompareSilent(); }
          else if (d) { state.cmpData[cmpSide] = null; await cmpLoadSide(cmpSide); }
        } catch (e2) {
          toast(String((e2 && e2.message) || e2), "err");
        }
      }
      histApplyFlags(j.flags);
      toast(okMsg, "ok");
      return;
    }
    const r = await api(endpoint, { method: "POST", body: JSON.stringify({ path }) });
    const j = await r.json();
    if (!j.ok) {
      setUndoRedoButtons(!!j.can_undo, !!j.can_redo);
      if (j.error === "nothing_to_undo" || j.error === "nothing_to_redo") {
        toast(noneMsg);   // boundary reached - informational, not an error
      } else {
        toast(j.error || "error", "err");
      }
      return;
    }
    if (isUprising) await uprRepaintUndo();
    else if (isCampaign) await cmpRepaintUndo();
    else await applyUndoPatch(j.patch);
    setUndoRedoButtons(!!j.can_undo, !!j.can_redo);
    toast(okMsg, "ok");
  } finally {
    state.histBusy = false;
  }
}

async function undoCurrent() {
  // SWT-редактор: сначала локальный пошаговый undo (стек правок doc),
  // за дном стека — серверный журнал сейвов (файл целиком за сейв)
  if (state.activeTabId === "swt") {
    if (swtUndo()) return;
    await swtServerUndoRedo("/api/undo", t("undo"), t("undo_none"));
    return;
  }
  await runUndoRedo("/api/undo", t("undo"), t("undo_none"));
}

async function redoCurrent() {
  if (state.activeTabId === "swt") {
    if (swtRedo()) return;
    await swtServerUndoRedo("/api/redo", t("redo"), t("redo_none"));
    return;
  }
  await runUndoRedo("/api/redo", t("redo"), t("redo_none"));
}

// ---------- history ----------
// Ядро истории: какие файлы попадают в журнал для активной страницы
// (SWT-вкладка, сравнение с двумя панелями или открытый файл-вкладка)
// Ядро истории: какие файлы попадают в журнал для активной страницы
// (карты — карта + species-правки попапа, иначе их откат к началу
// и журнал молча пропускали бы unit_set/cost)
function histTargets() {
  // страницы из реестра — первыми: журнал видит их файлы без правок ядра
  const prov = histPageProvider();
  if (prov && typeof prov.paths === "function") {
    try {
      return (prov.paths() || []).map(p => ({ side: null, path: p }));
    } catch (e) { return []; }
  }
  // попап превью-конфига поверх любой страницы
  const pv3t = pv3PopupTarget();
  if (pv3t) return [{ side: null, path: pv3t.path }];
  if (state.activeTabId === "uprising" && state.uprising.path) {
    return [{ side: null, path: state.uprising.path }].concat(
      Object.keys(state.uprising.statPaths || {})
        .filter(p => p && p !== state.uprising.path)
        .map(p => ({ side: null, path: p })));
  }
  if (state.activeTabId === "campaign" && state.campaign.path) {
    return [{ side: null, path: state.campaign.path }].concat(
      Object.keys(state.campaign.statPaths || {})
        .filter(p => p && p !== state.campaign.path)
        .map(p => ({ side: null, path: p })));
  }
  if (state.activeTabId === "swt" && state.swt.path) {
    return [{ side: null, path: state.swt.path }];
  }
  if (state.activeTabId === "compare") {
    const sides = state.cmpLastSide
      ? [state.cmpLastSide, state.cmpLastSide === "left" ? "right" : "left"]
      : ["left", "right"];
    const targets = [];
    for (const s of sides) {
      const d = state.cmpData && state.cmpData[s];
      if (d && d.path) targets.push({ side: s, path: d.path });
    }
    return targets;
  }
  if (state.currentFile && state.currentFile.path) {
    return [{ side: null, path: state.currentFile.path }];
  }
  return [];
}

// перерисовать активную страницу после серверного изменения файла
// (восстановление записи истории, полный откат к стоку)
async function histRepaintContext(path, side) {
  // страницы из реестра: перекрасить своим repaint, журнал правил диск —
  // память перечитана = чисто
  const prov = histPageProvider();
  if (prov && typeof prov.repaint === "function") {
    try { await prov.repaint(); } catch (e) {}
    try { if (typeof prov.clean === "function") prov.clean(); } catch (e) {}
    return;
  }
  // восстановление записи попапа превью-конфига — перечитать конфиг
  const pv3t = pv3PopupTarget();
  if (pv3t && path && normPath(pv3t.path) === normPath(path)) {
    try {
      if (typeof pv3LoadConfig === "function") pv3LoadConfig(pv3t.pv3, pv3t.pv3.config);
    } catch (e) {}
    return;
  }
  if (state.activeTabId === "uprising" && path) {
    // restore из журнала пишет файл на диск: память перечитана = чисто
    await uprRepaintUndo();
    uprMarkClean();
    // откатили конфиг/пресет/режим, а не карту — открытый редактор тоже
    try {
      if (typeof uprCfgEdRefreshIf === "function") uprCfgEdRefreshIf(path);
    } catch (e) {}
    return;
  }
  if (state.activeTabId === "campaign" && path) {
    await cmpRepaintUndo();
    cmpMarkClean();
    return;
  }
  if (state.activeTabId === "swt" && path) {
    // сброс пути: openSwt с тем же путём вышел бы по early-return
    state.swt.dirty = false;
    state.swt.path = "";
    await openSwt(path);
    return;
  }
  if (side) {
    const d = state.cmpData && state.cmpData[side];
    if (d) d.flags = { can_undo: false, can_redo: false };
    await cmpReloadSide(side);
    const tgt = cmpUndoTarget();
    const fl = tgt && state.cmpData[tgt.side] && state.cmpData[tgt.side].flags;
    setUndoRedoButtons(!!(fl && fl.can_undo), !!(fl && fl.can_redo));
    return;
  }
  await reloadActiveFile();
}

// несохранённые правки SWT перед серверной подменой файла: сохранить/отбросить
async function histConfirmSwtDirty() {
  if (state.activeTabId !== "swt" || !state.swt.dirty) return true;
  const choice = await askConfirm({
    title: t("unsaved_changes"),
    message: t("close_dirty_confirm"),
    buttons: [
      { id: "save", label: t("save_close") },
      { id: "discard", label: t("close_wo_save"), kind: "danger" },
      { id: "cancel", label: t("cancel"), kind: "ghost" },
    ],
  });
  if (choice === "cancel") return false;
  if (choice === "save") return swtSaveGuarded(false);
  state.swt.dirty = false;
  return true;
}

const HIST_ACTION_KEYS = {
  edit: "hist_edit",
  edit_cells: "hist_edit_cells",
  add_row: "hist_add_row",
  del_row: "hist_del_row",
  add_col: "hist_add_col",
  del_col: "hist_del_col",
  row_set: "hist_row_set",
  col_set: "hist_col_set",
  merge_rows: "hist_merge_rows",
};

function fmtDate(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString().slice(0, 5);
}

function fmtSize(n) {
  if (n == null) return "";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " " + t("kb");
  return (n / 1048576).toFixed(1) + " " + t("mb");
}

async function openHistory() {
  // ядро истории работает на любой странице: SWT-вкладка - файл .swt,
  // сравнение - обе панели одним журналом, иначе - открытый файл
  const targets = histTargets();
  if (!targets.length) { toast(t("no_file")); return; }
  $("#history-clear").onclick = async () => {
    const choice = await askConfirm({
      title: t("hist_clear"),
      message: t("hist_clear_confirm"),
      buttons: [
        { id: "ok", label: t("hist_clear"), kind: "danger" },
        { id: "cancel", label: t("cancel"), kind: "ghost" },
      ],
    });
    if (choice !== "ok") return;
    for (const tg of targets) {
      const rr = await api("/api/clear_history", { method: "POST",
        body: JSON.stringify({ path: tg.path }) });
      const jj = await rr.json();
      if (!jj.ok) { toast(jj.error || "error", "err"); return; }
    }
    if (state.currentFile) setUndoRedoButtons(false, false);
    else if (state.activeTabId === "uprising") {
      uprRepaintUndo();
      setUndoRedoButtons(false, false);
    }
    else {
      const prov0 = histPageProvider();
      if (prov0 && typeof prov0.sync === "function") await prov0.sync();
      else await cmpSyncUndoButtons();
    }
    toast(t("hist_cleared"), "ok");
    openHistory(); // refresh the list in place
  };
  // fetch every file's journal in parallel and tag records with their side
  let list, flags;
  try {
    const results = await Promise.all(targets.map(async tg => {
      const r = await api("/api/history?path=" + encodeURIComponent(tg.path));
      return r.json();
    }));
    list = [];
    results.forEach((j, i) => {
      const tg = targets[i];
      ((j && j.records) || []).forEach(h => {
        h.__side = tg.side;
        h.__path = tg.path;
        list.push(h);
      });
    });
    flags = results.map(j => ({ can_undo: !!(j && j.can_undo), can_redo: !!(j && j.can_redo) }));
  } catch (e) {
    toast(String((e && e.message) || e), "err");
    return;
  }
  list.sort((a, b) => b.ts - a.ts); // newest first across both files
  // toolbar buttons reflect the preferred side (the one the user last touched)
  if (flags[0]) setUndoRedoButtons(flags[0].can_undo, flags[0].can_redo);
  // per-file "current state" marker: the newest applied record of that file
  const currentKey = new Set();
  targets.forEach(tg => {
    const cur = list.find(h => h.__path === tg.path && !h.undone);
    if (cur) currentKey.add(tg.path + ":" + cur.id);
  });
  const body = $("#history-body");
  body.innerHTML = `<div class="hist-hint">${escapeHtml(t("hist_hint"))}</div>`;
  if (!list.length) {
    body.insertAdjacentHTML("beforeend",
      `<div class="recents-empty">${escapeHtml(t("history_empty"))}</div>`);
  }
  list.forEach(h => {
    const isCurrent = currentKey.has(h.__path + ":" + h.id);
    const isUndone = !!h.undone;
    const item = document.createElement("div");
    item.className = "history-item" + (isCurrent ? " current" : "") + (isUndone ? " undone" : "");
    const tm = new Date(h.ts * 1000).toLocaleString();
    const actLabel = t(HIST_ACTION_KEYS[h.action] || "hist_edit");
    item.innerHTML = `
      ${h.__side ? `<span class="h-side ${h.__side}"></span>` : ""}
      <span class="h-badge ${isUndone ? "h-undone" : ""}">${escapeHtml(actLabel)}</span>
      <span class="h-main">
        <span class="h-sum"></span>
        <span class="h-meta"></span>
      </span>
      ${isCurrent
        ? ""
        : `<span class="h-go">${escapeHtml(isUndone ? t("hist_redo_to") : t("hist_revert"))}</span>`}`;
    if (h.__side) {
      item.querySelector(".h-side").textContent =
        t(h.__side === "left" ? "cmp_base" : "cmp_source");
    }
    const sumEl = item.querySelector(".h-sum");
    const s = h.summary || "—";
    // "sysname colname: old -> new" → sysname as a yellow badge, column name
    // as a yellow button that jumps to the changed cell (single-cell batches
    // carry the same summary shape and jump via cells[0])
    const splittable = h.action === "edit" || (h.action === "edit_cells"
      && h.payload && (h.payload.cells || []).length === 1);
    const sp = splittable ? s.indexOf(" ") : -1;
    const colon = sp > 0 ? s.indexOf(":", sp) : -1;
    if (sp > 0 && colon > sp) {
      const keyEl = document.createElement("span");
      keyEl.className = "h-key";
      keyEl.textContent = s.slice(0, sp);
      const colEl = document.createElement("button");
      colEl.className = "h-col";
      colEl.textContent = s.slice(sp + 1, colon);
      colEl.addEventListener("click", ev => { ev.stopPropagation(); jumpToHistoryChange(h); });
      sumEl.append(keyEl, document.createTextNode(" "), colEl, s.slice(colon));
    } else if (h.action === "row_set") {
      // "row <key> created|transferred|updated ..." -> the key as a yellow chip
      const m = /^row (.+?) (created|transferred|updated)(.*)$/.exec(s);
      if (m) {
        const keyEl = document.createElement("span");
        keyEl.className = "h-key";
        keyEl.textContent = m[1];
        sumEl.append(keyEl, document.createTextNode(" " + m[2] + m[3]));
      } else {
        sumEl.textContent = s;
      }
    } else {
      sumEl.textContent = s;
    }
    // file name + what changed + when; the "current state" marker is compact
    // and lives at the end of the meta line
    const metaEl = item.querySelector(".h-meta");
    metaEl.textContent = (h.file || "") + " · " + tm + (isCurrent ? " · " : "");
    if (isCurrent) {
      const cur = document.createElement("span");
      cur.className = "h-current";
      cur.textContent = t("hist_current_short");
      metaEl.appendChild(cur);
    }
    // full change description on hover (the one-liner may be truncated)
    item.title = s + "\n" + (h.__path || h.file || "") + " · " + tm +
      (isCurrent ? "" : "\n" + (isUndone ? t("hist_redo_to") : t("hist_revert")));
    if (!isCurrent) {
      item.addEventListener("click", async () => {
        if (!await histConfirmSwtDirty()) return;
        const rr = await api("/api/restore", { method: "POST",
          body: JSON.stringify({ backup_id: h.id, path: h.__path }) });
        const jj = await rr.json();
        if (!jj.ok) { toast(jj.error || "error", "err"); return; }
        await histRepaintContext(h.__path, h.__side);
        toast(t("hist_restored"), "ok");
        openHistory(); // refresh the list in place
      });
    }
    body.appendChild(item);
  });
  // откат всего к чистому состоянию до первой записи журнала:
  // настоящий сброс каждой стороны (restore самой старой записи оставлял
  // бы первую правку применённой, поэтому здесь отдельный эндпоинт)
  if (targets.length) {
    const allRow = document.createElement("div");
    allRow.className = "hist-stock";
    const allBtn = document.createElement("button");
    allBtn.className = "btn";
    allBtn.textContent = t("hist_reset_all") || "Откатить всё к началу";
    allBtn.onclick = async () => {
      const choice = await askConfirm({
        title: t("hist_reset_all") || "Откат к началу",
        message: t("hist_reset_all_confirm") ||
          "Все изменения из журнала будут отменены.",
        buttons: [
          { id: "ok", label: t("hist_reset_all") || "Откатить", kind: "danger" },
          { id: "cancel", label: t("cancel"), kind: "ghost" },
        ],
      });
      if (choice !== "ok") return;
      if (!await histConfirmSwtDirty()) return;
      for (const tg of targets) {
        const rr = await api("/api/reset_beginning", { method: "POST",
          body: JSON.stringify({ path: tg.path }) });
        const jj = await rr.json();
        if (!jj.ok) { toast(jj.error || "error", "err"); return; }
        await histRepaintContext(tg.path, tg.side);
      }
      setUndoRedoButtons(false, true);
      toast(t("hist_reset_all_done") || "Откачено к началу изменений", "ok");
      openHistory();
    };
    allRow.appendChild(allBtn);
    body.appendChild(allRow);
  }
  // Работает только для файлов ВНУТРИ открытого проекта (сервер копирует
  // сток поверх файла проекта): стороны сравнения вне проекта молча
  // пропускаются, а если таких файлов нет вообще — кнопки нет.
  // полный откат к стоковой версии (из главного мода) — в самом низу журнала.
  // Работает только для файлов ВНУТРИ открытого проекта (сервер копирует
  // сток поверх файла проекта): стороны сравнения вне проекта молча
  // пропускаются, а если таких файлов нет вообще — кнопки нет.
  const stockTargets = targets.filter(tg => histInProject(tg.path));
  if (stockTargets.length) {
  const stockRow = document.createElement("div");
  stockRow.className = "hist-stock";
  const stockBtn = document.createElement("button");
  stockBtn.className = "btn danger";
  stockBtn.textContent = t("hist_stock") || "Откатить к стоковой версии";
  stockBtn.onclick = async () => {
    const choice = await askConfirm({
      title: t("hist_stock") || "Откат к стоку",
      message: t("hist_stock_confirm") ||
        "Файлы будут перезаписаны оригиналами из главного мода, журнал изменений очищен.",
      buttons: [
        { id: "ok", label: t("hist_stock") || "Откатить", kind: "danger" },
        { id: "cancel", label: t("cancel"), kind: "ghost" },
      ],
    });
    if (choice !== "ok") return;
    if (!await histConfirmSwtDirty()) return;
    let fails = 0;
    for (const tg of stockTargets) {
      const rr = await api("/api/stock_restore", { method: "POST",
        body: JSON.stringify({ path: tg.path }) });
      const jj = await rr.json();
      if (!jj.ok) {
        fails++;
        const key = { no_stock: "hist_stock_no", no_mod_path: "hist_stock_nomod",
          outside_project: "hist_stock_outside", no_project: "hist_stock_outside" }[jj.error];
        toast((key ? t(key) : (jj.error || "error")) + (jj.stock ? "\n" + jj.stock : ""), "err");
      }
    }
    if (fails === stockTargets.length) return;
    for (const tg of stockTargets) await histRepaintContext(tg.path, tg.side);
    if (stockTargets.length < targets.length) {
      toast(t("hist_stock_skip") || "Файлы вне проекта пропущены", "warn");
    }
    setUndoRedoButtons(false, false);
    toast(t("hist_stock_done") || "Восстановлена стоковая версия", "ok");
    openHistory();
  };
  stockRow.appendChild(stockBtn);
  body.appendChild(stockRow);
  }
  // откат к досейвовому снимку оригинала: работает для любого файла
  // (не только внутри проекта) и покрывает даже незалогированные правки —
  // снимок делается при первой записи файла из приложения
  try {
    const origins = await Promise.all(targets.map(async tg => {
      try {
        const r = await api("/api/origin_state?path=" + encodeURIComponent(tg.path));
        const j = await r.json();
        return (j && j.ok && j.has_origin) ? tg : null;
      } catch (e) { return null; }
    }));
    for (const tg of origins) {
      if (!tg) continue;
      const orgRow = document.createElement("div");
      orgRow.className = "hist-stock";
      const orgBtn = document.createElement("button");
      orgBtn.className = "btn";
      const base = String(tg.path || "").split(/[\\/]/).pop();
      orgBtn.textContent = (t("hist_origin") || "Откатить к оригиналу")
        + (base ? " · " + base : "");
      orgBtn.onclick = async () => {
        const choice = await askConfirm({
          title: t("hist_origin") || "Откат к оригиналу",
          message: t("hist_origin_confirm") ||
            "Файл будет перезаписан версией до первой записи из приложения, журнал очищен.",
          buttons: [
            { id: "ok", label: t("hist_origin") || "Откатить", kind: "danger" },
            { id: "cancel", label: t("cancel"), kind: "ghost" },
          ],
        });
        if (choice !== "ok") return;
        if (!await histConfirmSwtDirty()) return;
        const rr = await api("/api/origin_restore", { method: "POST",
          body: JSON.stringify({ path: tg.path }) });
        const jj = await rr.json();
        if (!jj.ok) { toast(jj.error || "error", "err"); return; }
        await histRepaintContext(tg.path, tg.side);
        setUndoRedoButtons(false, false);
        toast(t("hist_origin_done") || "Восстановлен оригинал", "ok");
        openHistory();
      };
      orgRow.appendChild(orgBtn);
      body.appendChild(orgRow);
    }
  } catch (e) { /* без снимка — просто нет кнопки */ }
  $("#history-modal").hidden = false;
}

// файл внутри открытого проекта (для стокового отката)
function histInProject(path) {
  const root = (state.project && state.project.root) || "";
  if (!root || !path) return false;
  const np = normPath(path).toLowerCase();
  const nr = normPath(root).toLowerCase().replace(/[\\/]+$/, "");
  return np === nr || np.startsWith(nr + "\\");
}

