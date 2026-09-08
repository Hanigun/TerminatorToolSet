/* TerminatorToolSet frontend — compare.js: страница сравнения целиком
   Вырезано из app.js без изменений логики. Классические скрипты,
   общий глобальный скоуп, порядок загрузки — FILES в templates/index.html. */
// ---------- compare page ----------
function openCompare() {
  if (!state.tabs.some(tb => tb.id === "compare")) {
    createTab("compare");
    renderTabBar();
  }
  activateTab("compare");
  updateCmpSrcSwitch(); // пути в настройках могли измениться
  // галка «аналогичный файл»: по умолчанию снята, состояние между сессиями
  const mb = $("#cmp-mirror");
  if (mb && !mb.dataset.wired) {
    mb.dataset.wired = "1";
    try { mb.checked = localStorage.getItem("tsh_cmp_mirror") === "1"; }
    catch (e) { /* приватный режим */ }
    mb.addEventListener("change", () => {
      try { localStorage.setItem("tsh_cmp_mirror", mb.checked ? "1" : "0"); }
      catch (e) { /* noop */ }
      // включение галки постфактум: потянуть аналоги уже выбранных файлов
      if (mb.checked) {
        cmpMirrorPick("left", cmpSideRel("left"));
        cmpMirrorPick("right", cmpSideRel("right"));
      }
      cmpPaintMirror();
    });
  }
  cmpPaintMirror();
  cmpPaintRun(); // возврат на вкладку посреди дифа — кнопка снова красная
  // prefill the left (base) side: currently open file, else the project
  // opened earlier (this session or the last one stored in the config)
  const lp = $("#cmp-left-path");
  if (!lp.value.trim()) {
    const cur = state.currentFile && state.currentFile.path;
    if (cur) lp.value = cur;
  }
  if (!lp.value.trim()) {
    const projRoot = (state.project && state.project.root) || state.config.last_project || "";
    if (projRoot) {
      lp.value = projRoot;
      cmpFillFolderList("left"); // fills the dropdown; nothing loads until a file is picked
    }
  }
}

const cmpSide = side => ({
  path: $("#cmp-" + side + "-path"),
  list: $("#cmp-" + side + "-list"),
  dd: $("#cmp-" + side + "-dd"),
  face: $("#cmp-" + side + "-dd-face"),
});

// per-side status line: shows loading spinner / loaded row count / error
function cmpStatus(side, text, loading, err) {
  const el = $("#cmp-" + side + "-status");
  if (!el) return;
  el.hidden = !text && !loading;
  el.classList.toggle("err", !!err);
  el.innerHTML = "";
  if (loading) {
    const sp = document.createElement("span");
    sp.className = "mini-spin";
    el.appendChild(sp);
  }
  if (text) el.appendChild(document.createTextNode(text));
}

// load one side as soon as a file is picked (no need to press "compare"):
// caches rows locally and shows the count under the path input.
// silent=true (auto-preselect on page open): a failed load clears the
// status line instead of showing an error.
async function cmpLoadSide(side, silent) {
  if (!state.cmpData) state.cmpData = {};
  const p = cmpResolved(side);
  if (!p) { state.cmpData[side] = null; cmpStatus(side, ""); return; }
  if (state.cmpData[side] && state.cmpData[side].path === p) return;
  cmpStatus(side, t("cmp_loading") || "Загрузка…", true);
  try {
    const r = await api("/api/file?path=" + encodeURIComponent(p));
    const j = await r.json();
    if (!j.ok) {
      state.cmpData[side] = null;
      cmpStatus(side, silent ? "" : (j.error || "error"), false, !silent);
      return;
    }
    state.cmpData[side] = { path: p, columns: j.columns || [],
      comments: j.comments || {}, rows: (j.rows || []).map(x => x.values) };
    cmpStatus(side, (j.rows || []).length + " " + (t("cmp_rows_loaded") || "строк загружено"));
  } catch (e) {
    state.cmpData[side] = null;
    if (!silent) cmpStatus(side, String((e && e.message) || e), false, true);
    else cmpStatus(side, "");
    return;
  }
  // picking a file just OPENS it in its own pane; the diff runs only when
  // the user presses "compare"
  cmpShowPreview();
}

// which compare file the next undo/redo/history action should target: the
// side the user last interacted with (both sides are editable), left fallback
function cmpUndoTarget() {
  const tab = state.tabs.find(tb => tb.id === state.activeTabId);
  if (!tab || tab.type !== "compare") return null;
  const order = state.cmpLastSide
    ? [state.cmpLastSide, state.cmpLastSide === "left" ? "right" : "left"]
    : ["left", "right"];
  for (const s of order) {
    const d = state.cmpData && state.cmpData[s];
    if (d && d.path) return { side: s, path: d.path };
  }
  return null;
}

// toolbar undo/redo state on the compare page: refresh the per-side flags
// from the server and show the ones for the side the user last touched
async function cmpSyncUndoButtons() {
  const sides = ["left", "right"].filter(s =>
    state.cmpData && state.cmpData[s] && state.cmpData[s].path);
  await Promise.all(sides.map(async s => {
    try {
      const r = await api("/api/history?path=" + encodeURIComponent(state.cmpData[s].path));
      const j = await r.json();
      if (j.ok) state.cmpData[s].flags = { can_undo: !!j.can_undo, can_redo: !!j.can_redo };
    } catch (e) { /* keep the cached flags on network errors */ }
  }));
  const tgt = cmpUndoTarget();
  const fl = tgt && state.cmpData[tgt.side] && state.cmpData[tgt.side].flags;
  setUndoRedoButtons(!!(fl && fl.can_undo), !!(fl && fl.can_redo));
}

// repaint after an undo/redo that touched one compare side's file:
// the diff re-runs on the server; a preview reloads just that side
async function cmpRepaintUndo(side, patch) {
  if (!side) return;
  if (state.compare) { await runCompare(); return; }
  const d = state.cmpData && state.cmpData[side];
  if (d && patch && patch.kind === "cell" &&
      d.rows[patch.row] && patch.col < d.rows[patch.row].length) {
    d.rows[patch.row][patch.col] = patch.value;
    const table = $("#cmp-table-" + side);
    const tr = table && table.querySelector(`tbody tr[data-row-index="${patch.row}"]`);
    const td = tr && tr.children[patch.col];
    if (td) cmpRenderCell(side, d, td, patch.row, patch.col, patch.value);
    return;
  }
  state.cmpData[side] = null;
  await cmpLoadSide(side); // structural patch: reload the side + repaint
}

// repaint the compare view after a server-side change (history restore)
async function cmpReloadSide(side) {
  if (!side) return;
  if (state.compare) { await runCompare(); return; }
  state.cmpData[side] = null;
  await cmpLoadSide(side);
}

// jump from a history record to a cell of a compare preview pane: extend the
// rendered chunks until the row exists, then focus + flash it. If the row is
// hidden by that side's search filter, the filter is lifted first.
function cmpFocusCell(side, ri, ci) {
  const d = state.cmpData && state.cmpData[side];
  if (!d || !d.rows || !d.rows[ri]) return false;
  let list = state.cmpVisIdx[side];
  if (list && !list.includes(ri)) {
    state.cmpSearch[side] = "";
    list = null;
    cmpFillPreviewPane(side, d);
  }
  const total = list || d.rows.map((_, i) => i);
  const pos = list ? list.indexOf(ri) : ri;
  while (state.cmpPrevLimit[side] <= pos && state.cmpPrevLimit[side] < total.length) {
    const from = state.cmpPrevLimit[side];
    const to = Math.min(from + CMP_CHUNK, total.length);
    state.cmpPrevLimit[side] = to;
    cmpAppendPreviewRows(side, from, to);
  }
  const table = $("#cmp-table-" + side);
  const tr = table && table.querySelector(`tbody tr[data-row-index="${ri}"]`);
  if (!tr) return false;
  cmpClearCellFocus(side);
  state.cmpSel[side] = { r: ri, c: ci };
  state.cmpLastSide = side;
  const prevSel = table.querySelector("tbody tr.sel");
  if (prevSel) prevSel.classList.remove("sel");
  tr.classList.add("sel");
  const td = tr.children[ci];
  if (td) { td.classList.add("cell-focus"); td.scrollIntoView({ block: "nearest" }); }
  tr.classList.remove("row-flash");
  void tr.offsetWidth;
  tr.classList.add("row-flash");
  setTimeout(() => tr.classList.remove("row-flash"), 1800);
  return true;
}

// preview mode: show the picked file's rows in its own pane as a plain
// table (no diff yet). No auto-compare - that only happens on "Сравнить".
function cmpShowPreview() {
  const data = state.cmpData || {};
  const L = data.left, R = data.right;
  state.compare = null;
  state.cmpCtx = null;
  state.cmpSel = { left: null, right: null };
  state.cmpLastSide = null;
  const empty = $("#cmp-empty");
  const fl = $("#cmp-filters");
  const lt = $("#cmp-table-left"), rt = $("#cmp-table-right");
  // попапы поиска/замены живут внутри своих панелей (Ctrl+F)
  const resetSearch = s => {
    state.cmpSearch[s] = "";
    state.cmpVisIdx[s] = null;
    cmpFindClose(s);
  };
  if (!L && !R) {
    // nothing picked on either side: reset to the empty hint
    empty.hidden = false; fl.hidden = true;
    resetSearch("left"); resetSearch("right");
    lt.querySelector("thead").innerHTML = ""; lt.querySelector("tbody").innerHTML = "";
    rt.querySelector("thead").innerHTML = ""; rt.querySelector("tbody").innerHTML = "";
    cmpClearPin();
    $("#cmp-merge").disabled = false;
    cmpPaintRun();
    return;
  }
  empty.hidden = true;
  fl.hidden = true; // filter chips belong to the diff, not to a plain preview
  if (!L) resetSearch("left");
  if (!R) resetSearch("right");
  cmpFillPreviewPane("left", L);
  cmpFillPreviewPane("right", R);
  cmpSyncUndoButtons();
  $("#cmp-merge").disabled = true; // nothing to merge from yet
  cmpPaintRun();
}

// plain single-side table: header + editable rows, exactly like the main
// grid (click selects, second click / dblclick / typing edits the cell)
function cmpFillPreviewPane(side, data) {
  const table = $(side === "left" ? "#cmp-table-left" : "#cmp-table-right");
  const thead = table.querySelector("thead"), tbody = table.querySelector("tbody");
  thead.innerHTML = ""; tbody.innerHTML = "";
  cmpSetupPreviewEvents(side);
  cmpSetupPairHL();
  cmpClearPin();
  state.cmpSel[side] = null;
  state.cmpPrevLimit[side] = 0;
  state.cmpVisIdx[side] = data ? cmpFilteredIdx(side) : null;
  if (!data) return;
  const cols = data.columns || [];
  const hr = document.createElement("tr");
  (cols || []).forEach((name, ci) => {
    const th = document.createElement("th");
    th.textContent = name;
    if (ci === 0) th.classList.add("sticky-col"); // sysname: same as the main grid
    const comment = data.comments && data.comments[ci];
    if (comment) {
      th.classList.add("has-comment");
      th.classList.add("col-comment");
    } else {
      th.title = name;
    }
    // built-in RU glossary under the header name, like the main grid
    const ru = HEADER_GLOSSARY[String(name).trim()];
    if (ru) {
      const subEl = document.createElement("div");
      subEl.className = "th-sub";
      subEl.textContent = ru;
      th.appendChild(subEl);
    }
    th.addEventListener("mouseenter", e => {
      if (comment) showTip(e, name + (ru ? " (" + ru + ")" : "") + " — " + comment);
    });
    th.addEventListener("mousemove", e => comment && moveTip(e));
    th.addEventListener("mouseleave", () => hideTip());
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  const list = state.cmpVisIdx[side] || (data.rows || []).map((_, i) => i);
  state.cmpPrevLimit[side] = Math.min(CMP_CHUNK, list.length);
  cmpAppendPreviewRows(side, 0, state.cmpPrevLimit[side]);
}

// rows of one side that match its own search box (null = no filter: all rows);
// same matching rule as the main grid filter (case-insensitive substring)
function cmpFilteredIdx(side) {
  const d = state.cmpData && state.cmpData[side];
  if (!d) return null;
  const q = (state.cmpSearch[side] || "").trim().toLowerCase();
  if (!q) return null;
  const rows = d.rows || [];
  const out = [];
  for (let ri = 0; ri < rows.length; ri++) {
    if (rows[ri].some(v => String(v).toLowerCase().includes(q))) out.push(ri);
  }
  return out;
}

// ---------- поиск и замена в панелях сравнения (копия find-bar главной) ----------
// попап живёт внутри своей .cmp-pane: в fullscreen-модалке переезжает вместе
// с таблицей; левый прижат к разделителю, правый - к правому краю
const cmpFindState = {
  left:  { q: "", idx: 0, matches: [], _t: null },
  right: { q: "", idx: 0, matches: [], _t: null },
};

function cmpFindTable(side) {
  return $(side === "left" ? "#cmp-table-left" : "#cmp-table-right");
}

// источник строк стороны: превью одного файла (cmpData) или парный диф
function cmpFindSource(side) {
  if (state.compare && state.compare.diff && state.cmpCtx) {
    const ctx = state.cmpCtx[side];
    if (!ctx) return null;
    return {
      mode: "diff",
      n: ctx.visible.length,
      cols: ctx.cols.length,
      val: (i, ci) => {
        const r = ctx.visible[i];
        if (!r) return "";
        const ri = side === "left" ? r.d.left_index : r.d.right_index;
        const src = ctx.src[ri];
        return src && ci < src.length ? String(src[ci] || "") : "";
      },
    };
  }
  const d = state.cmpData && state.cmpData[side];
  if (!d) return null;
  return {
    mode: "preview",
    n: (d.rows || []).length,
    cols: (d.columns || []).length,
    val: (i, ci) => {
      const row = d.rows[i];
      return row && ci < row.length ? String(row[ci] || "") : "";
    },
  };
}

function cmpFindCompute(side) {
  const f = cmpFindState[side];
  const src = cmpFindSource(side);
  f.matches = [];
  if (!src || !f.q) return;
  const q = f.q.toLowerCase();
  for (let i = 0; i < src.n; i++) {
    for (let ci = 0; ci < src.cols; ci++) {
      if (src.val(i, ci).toLowerCase().includes(q)) f.matches.push({ ri: i, ci });
    }
  }
  if (f.idx >= f.matches.length) f.idx = 0;
}

function cmpFindCount(side) {
  const b = cmpFindBar[side];
  const f = cmpFindState[side];
  if (b) b.setCount(f.idx, f.matches.length);
}

function cmpFindPaint(side) {
  const f = cmpFindState[side];
  const table = cmpFindTable(side);
  if (!table) return;
  $$(".find-cur", table).forEach(el => el.classList.remove("find-cur"));
  const m = f.matches[f.idx];
  if (!m) return;
  const src = cmpFindSource(side);
  if (!src) return;
  if (src.mode === "diff") {
    // диф рисуется чанками: дорисовать до нужной строки
    if (state.cmpPane && state.cmpPane[side] <= m.ri) {
      appendCmpRows(side, m.ri + 1 - state.cmpPane[side]);
    }
  } else {
    const data = state.cmpData[side];
    const list = state.cmpVisIdx[side] || data.rows.map((_, i) => i);
    const pos = list.indexOf(m.ri);
    while (pos >= state.cmpPrevLimit[side] && state.cmpPrevLimit[side] < list.length) {
      const from = state.cmpPrevLimit[side];
      const to = Math.min(from + CMP_CHUNK, list.length);
      cmpAppendPreviewRows(side, from, to);
      state.cmpPrevLimit[side] = to;
    }
  }
  const td = table.querySelector('td[data-row="' + m.ri + '"][data-col="' + m.ci + '"]');
  if (td) {
    td.classList.add("find-cur");
    td.scrollIntoView({ block: "nearest" });
  }
}

function cmpFindRefresh(side) {
  cmpFindCompute(side);
  cmpFindCount(side);
  cmpFindPaint(side);
}

function cmpFindStep(side, dir) {
  const f = cmpFindState[side];
  const n = f.matches.length;
  if (!n) return;
  f.idx = (f.idx + dir + n) % n;
  cmpFindCount(side);
  cmpFindPaint(side);
}

function cmpFindOpen(side) {
  const bar = cmpFindBar[side];
  if (!bar) return;
  bar.setQ(cmpFindState[side].q || "");
  bar.open(false);
  if (cmpFindState[side].q) cmpFindRefresh(side);
}

function cmpFindClose(side) {
  if (cmpFindBar[side]) cmpFindBar[side].close();
}

function cmpFindRepAvailable(side) {
  const src = cmpFindSource(side);
  return !!src && src.mode === "preview";
}

async function cmpReplaceOne(side, replArg) {
  if (!cmpFindRepAvailable(side)) {
    toast(t("cmp_rep_diff") || "Замена доступна только в предпросмотре файла", "err");
    return;
  }
  const f = cmpFindState[side];
  const m = f.matches[f.idx];
  if (!m || !f.q) return;
  const repl = replArg != null ? replArg : (cmpFindBar[side] ? cmpFindBar[side].replaceText() : "");
  const data = state.cmpData[side];
  const oldVal = String(data.rows[m.ri][m.ci] || "");
  const re = new RegExp(escapeRegExp(f.q), "gi");
  const newVal = oldVal.replace(re, repl);
  if (newVal !== oldVal) await cmpSetCell(side, m.ri, m.ci, newVal);
  cmpFindRefresh(side);
}

async function cmpReplaceAll(side, replArg) {
  if (!cmpFindRepAvailable(side)) {
    toast(t("cmp_rep_diff") || "Замена доступна только в предпросмотре файла", "err");
    return;
  }
  const f = cmpFindState[side];
  if (!f.q) return;
  cmpFindCompute(side);
  const cells = f.matches.slice();
  if (!cells.length) { toast(t("save_success"), "ok"); return; }
  const repl = replArg != null ? replArg : (cmpFindBar[side] ? cmpFindBar[side].replaceText() : "");
  const re = new RegExp(escapeRegExp(f.q), "gi");
  let changed = 0;
  for (const m of cells) {
    const oldVal = String(state.cmpData[side].rows[m.ri][m.ci] || "");
    const newVal = oldVal.replace(re, repl);
    if (newVal === oldVal) continue;
    await cmpSetCell(side, m.ri, m.ci, newVal);
    changed++;
  }
  toast((t("replace_all") || "Заменить все") + ": " + changed, "ok");
  cmpFindRefresh(side);
}

// попапы поиска/замены на обеих панелях — из общего ядра mkFindBar;
// стороны независимы: можно открыть оба сразу. Клик по панели делает её
// «выделенной», и Ctrl+F открывает поиск именно на ней.
const cmpFindBar = { left: null, right: null };

function setupCmpSearch() {
  ["left", "right"].forEach(side => {
    const pane = $("#cmp-pane-" + side);
    if (!pane) return;
    pane.addEventListener("mousedown", () => { state.cmpLastSide = side; });
    cmpFindBar[side] = mkFindBar({
      id: "cmp-find-" + side,
      host: pane,
      sticky: true,
      autoClose: false,
      withReplace: true,
      canReplace: () => cmpFindRepAvailable(side),
      onQuery: q => { const f = cmpFindState[side]; f.q = q; cmpFindRefresh(side); },
      onStep: d => cmpFindStep(side, d),
      onReplaceOne: repl => cmpReplaceOne(side, repl),
      onReplaceAll: repl => cmpReplaceAll(side, repl),
      onClose: () => {
        const f = cmpFindState[side];
        f.q = ""; f.idx = 0; f.matches = [];
        const table = cmpFindTable(side);
        if (table) $$(".find-cur", table).forEach(el => el.classList.remove("find-cur"));
      },
    });
  });
}

// ---------- полноэкранный режим панели сравнения ----------
// окно на весь монитор включает общий механизм (paneFsWinFs); модалка
// оставлена своя: панель переезжает в неё из двухколоночного вида
let cmpFsRestore = null;   // {side, pane} — куда вернуть таблицу

function cmpFullscreen(side) {
  const modal = $("#cmp-fs");
  const pane = $("#cmp-pane-" + side);
  if (!modal || !pane) return;
  if (!modal.hidden && cmpFsRestore && cmpFsRestore.side === side) { cmpFsClose(); return; }
  if (!modal.hidden && cmpFsRestore) cmpFsClose();
  cmpFsRestore = { side, pane };
  const tag = $("#cmp-fs-tag");
  tag.textContent = side === "left" ? (t("cmp_base") || "Основа") : (t("cmp_source") || "Источник");
  tag.className = "cmp-tag " + (side === "left" ? "base" : "src");
  const p = state.cmpData && state.cmpData[side];
  $("#cmp-fs-file").textContent = p ? (p.path || "")
    : (side === "left" ? $("#cmp-left-path").value : $("#cmp-right-path").value);
  $("#cmp-fs-body").appendChild(pane);
  // настоящий полноэкранный режим окна (весь монитор) - общий механизм;
  // в браузере недоступно - модалка и так на всю страницу
  paneFsWinFs(true);
  modal.hidden = false;
}

function cmpFsClose() {
  const modal = $("#cmp-fs");
  if (modal.hidden || !cmpFsRestore) return;
  const { side, pane } = cmpFsRestore;
  cmpFsRestore = null;
  if (side === "left") $("#cmp-grid-wrap").insertBefore(pane, $("#cmp-divider"));
  else $("#cmp-grid-wrap").appendChild(pane);
  modal.hidden = true;
  paneFsWinFs(false);
}

function setupCmpFs() {
  const modal = $("#cmp-fs");
  if (!modal) return;
  $("#cmp-fs-close").onclick = cmpFsClose;
  modal.addEventListener("mousedown", e => { if (e.target === modal) cmpFsClose(); });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !modal.hidden) cmpFsClose();
  });
}

// ---------- синхронная прокрутка панелей сравнения ----------
// галка над таблицами; работает в превью и в дифе, в fullscreen тоже
// (панель одна - вторая скрыта, зеркалить нечем, подписка просто молчит).
// Одна общая прокрутка по обеим осям: вертикаль держит строка-в-строку,
// горизонталь — колонка-в-колонку. Высота строк и шапок у сторон одинаковая
// (задана одним CSS), ширины могут различаться (разный набор колонок) —
// короткая сторона просто упирается в свой предел, ведущую назад не тянет.
// Никаких пропорций: они и давали вечное отставание/опережение сторон.
// Эхо давится меткой dataset.synced (одна на обе оси: записи идут парой
// в одном событии).
function setupCmpSyncScroll() {
  ["left", "right"].forEach(side => {
    const pane = $("#cmp-pane-" + side);
    if (!pane || pane.dataset.syncWired) return;
    pane.dataset.syncWired = "1";
    pane.addEventListener("scroll", () => {
      const box = $("#cmp-sync-scroll");
      if (!box || !box.checked) return;
      if (pane.dataset.synced === "1") { pane.dataset.synced = ""; return; }
      const other = $("#cmp-pane-" + (side === "left" ? "right" : "left"));
      if (!other) return;
      if (other.scrollTop === pane.scrollTop
          && other.scrollLeft === pane.scrollLeft) return;
      other.dataset.synced = "1";
      other.scrollTop = pane.scrollTop;
      other.scrollLeft = pane.scrollLeft;
      // если чужое событие не выстрелит (значение упёрлось в предел и не
      // изменилось) — метка снимется по таймеру и не проглотит живой скролл
      // той стороны: именно залипшая метка морозила панель и давала рассинхрон
      setTimeout(() => { other.dataset.synced = ""; }, 60);
    }, { passive: true });
  });
}

// ---------- переключатели источника сторон сравнения ----------
// У каждой стороны свой источник (Проект | Игра | Мод) тем же сегментом,
// что на карте. Пункт, выбранный на другой стороне, темнеет и не выбирается
// (пока есть альтернатива); пункты без путей в настройках тоже темнеют.
function paintCmpSrc() {
  // стороны НЕ подтягиваем автоматически: по умолчанию ни одна вкладка
  // не выбрана, выбор — только кликом; недоступное из localStorage — в null
  for (const side of ["left", "right"]) {
    if (state.cmpSrc[side] && !srcAvail(state.cmpSrc[side])) {
      state.cmpSrc[side] = null;
      try { localStorage.removeItem("tsh_cmp_" + side); } catch (e) { /* noop */ }
    }
  }
  for (const side of ["left", "right"]) {
    const seg = $("#cmp-" + side + "-src");
    if (!seg) continue;
    const other = state.cmpSrc[side === "left" ? "right" : "left"];
    const canElse = SRC_ORDER.some(s => srcAvail(s) && s !== other);
    seg.dataset.pos = srcAvail(state.cmpSrc[side])
      ? String(Math.max(0, SRC_ORDER.indexOf(state.cmpSrc[side]))) : "-1";
    $$(".src-seg-btn", seg).forEach(b => {
      const s = b.dataset.src;
      b.classList.toggle("active", s === state.cmpSrc[side] && srcAvail(s));
      // как на карте: без пути — серая кликабельная кнопка в настройки
      // (is-off вместо disabled); disabled — только конфликт сторон
      const off = !srcAvail(s);
      b.classList.toggle("is-off", off);
      b.disabled = !off && (s === other && canElse);
      b.setAttribute("aria-disabled", String(off || (s === other && canElse)));
      b.title = srcRoot(s) || "";
    });
  }
}

// сохранённые источники сторон (localStorage) применяются, когда
// доступность меняется: init отрабатывает ДО фоновой загрузки проекта,
// поэтому сохранённый «проект» тогда отбрасывается как недоступный —
// возвращаем его, как только проект приехал (loadProject), и перекрашиваем
// сегменты. Занятые в сессии стороны не трогаем, только пустые.
function cmpRestoreSides() {
  try {
    for (const side of ["left", "right"]) {
      if (state.cmpSrc[side]) continue;
      const v = localStorage.getItem("tsh_cmp_" + side);
      if (v && srcAvail(v)) state.cmpSrc[side] = v;
    }
  } catch (e) { /* приватный режим */ }
  paintCmpSrc();
}

async function cmpSetSideSrc(side, v) {
  if (!srcAvail(v)) return;
  const other = side === "left" ? "right" : "left";
  const canElse = SRC_ORDER.some(s => srcAvail(s) && s !== state.cmpSrc[other]);
  if (v === state.cmpSrc[other] && canElse) return;
  state.cmpSrc[side] = v;
  try { localStorage.setItem("tsh_cmp_" + side, v); } catch (e) { /* noop */ }
  paintCmpSrc();
  const root = srcRoot(v) || (v === "project" ? (state.config.last_project || "") : "");
  const els = cmpSide(side);
  const prevRel = els.list.dataset.value || "";
  els.path.value = root;
  await cmpFillFolderList(side);
  if (prevRel) {
    const item = [...els.list.children].find(x => {
      const rest = x.querySelector(".cmp-list-rest");
      return rest && rest.textContent === prevRel;
    });
    if (item) cmpSelectFile(side, prevRel, item, true);
  }
  cmpPaintMirror();
}

function setupCmpSrcSwitch() {
  for (const side of ["left", "right"]) {
    const seg = $("#cmp-" + side + "-src");
    if (!seg || seg.dataset.wired) continue;
    seg.dataset.wired = "1";
    seg.addEventListener("click", e => {
      const b = e.target.closest(".src-seg-btn");
      if (!b) return;
      if (b.classList.contains("is-off")) {
        const src = b.dataset.src;
        const id = src === "mod" ? "set-mod-path"
          : src === "game" ? "set-unpacked"
          : "set-project-path";
        openSettingsPaths(id);
        return;
      }
      if (b.disabled) return;
      // повторный клик по активной вкладке снимает выделение: сторону
      // можно перевыбрать заново (путь и файл стороны сбрасываются)
      if (b.classList.contains("active")) {
        cmpClearSideSrc(side);
        return;
      }
      cmpSetSideSrc(side, b.dataset.src);
    });
  }
  paintCmpSrc();
}

// снятие выделения источника стороны: забыть выбор, очистить путь,
// файл и дропдаун стороны, чтобы вкладки можно было перевыбирать
function cmpClearSideSrc(side) {
  state.cmpSrc[side] = null;
  try { localStorage.removeItem("tsh_cmp_" + side); } catch (e) { /* noop */ }
  paintCmpSrc();
  cmpClear(side);
  cmpShowPreview(); // перерисовать превью без сброшенной стороны
}

function updateCmpSrcSwitch() {
  paintCmpSrc();
}

// Ctrl+F на странице сравнения: попап поиска/замены у своей панели
// (лево/право независимы); в fullscreen-модалке попап тот же - он живёт
// внутри .cmp-pane и переезжает в модалку вместе с таблицей
function cmpFocusSearch(side) {
  cmpFindOpen(side);
}

// append the next chunk of editable preview rows to one side's pane
// (string-built, like the diff: thousands of createElement calls per chunk
// froze the mirrored pane mid-scroll and broke sync)
function cmpAppendPreviewRows(side, from, to) {
  const table = $("#cmp-table-" + side);
  const tbody = table.querySelector("tbody");
  const data = state.cmpData && state.cmpData[side];
  if (!data) return;
  const cols = data.columns || [];
  const rows = data.rows || [];
  const list = state.cmpVisIdx[side] || rows.map((_, i) => i);
  // the search filtered everything out: show a "no matches" placeholder
  if (!list.length && !tbody.children.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = Math.max(cols.length, 1);
    td.className = "cmp-search-none";
    td.textContent = t("cmp_search_none");
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  const esc = escapeHtml;
  const parts = new Array(to - from);
  for (let k = from; k < to && k < list.length; k++) {
    const ri = list[k];
    const row = rows[ri] || [];
    let h = '<tr data-row-index="' + ri + '">';
    for (let ci = 0; ci < cols.length; ci++) {
      const rawVal = ci < row.length ? row[ci] : "";
      h += ci === 0 ? '<td class="sticky-col"' : "<td";
      let sub = "";
      if (ci === 0 && rawVal) {
        const disp = state.nameMap[String(rawVal).trim()];
        if (disp && disp !== rawVal) {
          h += ' title="' + esc(disp + " (" + rawVal + ")") + '"';
          sub = '<div class="cell-sub">' + esc(disp) + "</div>";
        }
      }
      h += ' data-row="' + ri + '" data-col="' + ci + '">' + esc(rawVal) + sub + "</td>";
    }
    h += "</tr>";
    parts[k - from] = h;
  }
  tbody.insertAdjacentHTML("beforeend", parts.join(""));
  cmpSetupPaneScroll(side);
}

// lazy-append preview rows while scrolling (same idea as the main grid)
function cmpSetupPaneScroll(side) {
  const pane = $(side === "left" ? "#cmp-pane-left" : "#cmp-pane-right");
  if (!pane || pane.dataset.cmpPrevScroll) return;
  pane.dataset.cmpPrevScroll = "1";
  // проверка дна — внутри rAF, а не на каждое событие: чтение scrollHeight
  // форсирует reflow всей таблицы, на каждый тик колеса это морозит панель
  pane.addEventListener("scroll", () => {
    if (state.compare) return; // diff view handles its own rendering
    if (pane.dataset.cmpPrevQueued) return;
    pane.dataset.cmpPrevQueued = "1";
    requestAnimationFrame(() => {
      pane.dataset.cmpPrevQueued = "";
      const table = $(side === "left" ? "#cmp-table-left" : "#cmp-table-right");
      if (!table || !table.querySelector("thead tr")) return; // empty pane
      const data = state.cmpData && state.cmpData[side];
      if (!data) return;
      // только длины, без построения массива индексов: хендлер скролла
      // дёргается постоянно, аллокация на каждое событие даёт лаги
      const vis = state.cmpVisIdx[side];
      const total = vis ? vis.length : (data.rows || []).length;
      if (state.cmpPrevLimit[side] >= total) return;
      if (pane.scrollTop + pane.clientHeight < pane.scrollHeight - 400) return;
      const from = state.cmpPrevLimit[side];
      const to = Math.min(from + CMP_CHUNK, total);
      state.cmpPrevLimit[side] = to;
      cmpAppendPreviewRows(side, from, to);
    });
  }, { passive: true });
}

function cmpClearCellFocus(side) {
  const sel = state.cmpSel[side];
  if (sel) {
    const table = $(side === "left" ? "#cmp-table-left" : "#cmp-table-right");
    const tr = table && table.querySelector(`tbody tr[data-row-index="${sel.r}"]`);
    const td = tr && tr.children[sel.c];
    if (td) td.classList.remove("cell-focus");
  }
  state.cmpSel[side] = null;
}

// закреплённая кликом пара строк (подсветка сильнее ховера, на обеих панелях)
let cmpPinned = null; // { side, idx } — позиция строки в tbody своей панели
function cmpClearPin() {
  cmpPinned = null;
  $$(".cmp-grid tbody tr.row-pin").forEach(tr => tr.classList.remove("row-pin"));
}

// парный ховер гаснет, пока крутится колесо: при скролле под неподвижным
// курсором браузер шлёт mouseover по проезжающим строкам, и подсветка пары
// на каждую строку (поиск по документу + перекраска двух панелей) морозит
// именно ту сторону, где мышь
let cmpScrolling = false;
let cmpScrollIdleT = null;
function cmpNoteScrolling() {
  cmpScrolling = true;
  clearTimeout(cmpScrollIdleT);
  cmpScrollIdleT = setTimeout(() => { cmpScrolling = false; }, 120);
}

// общий ховер пары строк + закрепление пары кликом (обе панели):
// навёл на строку слева — подсветилась и парная справа (видно, куда
// встанет изменение); клик закрепляет всю строку целиком усиленной
// подсветкой (сильнее ховера), повторный клик по ней снимает закрепление.
// Выделения отдельной ячейки по клику нет — только строка целиком.
function cmpSetupPairHL() {
  ["left", "right"].forEach(side => {
    const table = $(side === "left" ? "#cmp-table-left" : "#cmp-table-right");
    if (!table || table.dataset.pairWired) return;
    table.dataset.pairWired = "1";
    const tbody = table.querySelector("tbody");
    const otherTbody = () => $(side === "left" ? "#cmp-table-right tbody" : "#cmp-table-left tbody");
    // только две панели сравнения, не весь документ: полнотекстовый поиск
    // по тысячам строк на каждый mouseover тоже давал лаги
    const clearPair = () => {
      tbody.querySelectorAll("tr.row-pair").forEach(tr => tr.classList.remove("row-pair"));
      const sib = otherTbody();
      if (sib) sib.querySelectorAll("tr.row-pair").forEach(tr => tr.classList.remove("row-pair"));
    };
    // лёгкая подписка без чтений геометрии: только взводит флаг паузы ховера
    const pane = $(side === "left" ? "#cmp-pane-left" : "#cmp-pane-right");
    if (pane && !pane.dataset.cmpHlScroll) {
      pane.dataset.cmpHlScroll = "1";
      pane.addEventListener("scroll", cmpNoteScrolling, { passive: true });
    }
    tbody.addEventListener("mouseover", e => {
      if (cmpScrolling) return; // колесо крутится — подсветку не трогаем
      const tr = e.target.closest("tr");
      if (!tr || tr.parentElement !== tbody) return;
      if (tr.classList.contains("row-pair")) return;
      clearPair();
      tr.classList.add("row-pair");
      const sib = otherTbody();
      const twin = sib && sib.children[Array.prototype.indexOf.call(tbody.children, tr)];
      if (twin && twin.tagName === "TR") twin.classList.add("row-pair");
    });
    tbody.addEventListener("mouseleave", clearPair);
    tbody.addEventListener("click", e => {
      const tr = e.target.closest("tr");
      if (!tr || tr.parentElement !== tbody) return;
      const idx = Array.prototype.indexOf.call(tbody.children, tr);
      // повторный клик по закреплённой строке — снять закрепление
      if (cmpPinned && cmpPinned.side === side && cmpPinned.idx === idx) {
        cmpClearPin();
        return;
      }
      cmpClearPin();
      cmpPinned = { side, idx };
      tr.classList.add("row-pin");
      const sib = otherTbody();
      const twin = sib && sib.children[idx];
      if (twin && twin.tagName === "TR") twin.classList.add("row-pin");
    });
  });
}

// один хендлер кликов/правки на tbody стороны вместо тысяч слушателей
// на ячейках: та же логика выбора и правки, что была у каждой td
function cmpSetupPreviewEvents(side) {
  const table = $(side === "left" ? "#cmp-table-left" : "#cmp-table-right");
  if (!table || table.dataset.prevWired) return;
  table.dataset.prevWired = "1";
  const tbody = table.querySelector("tbody");
  tbody.addEventListener("mousedown", ev => {
    const td = ev.target.closest("td");
    if (!td || td.dataset.row == null) return;
    const data = state.cmpData && state.cmpData[side];
    if (!data) return;
    const tr = td.parentElement;
    const ri = Number(td.dataset.row), ci = Number(td.dataset.col);
    // a second click on the already-focused cell enters edit mode right away
    if (state.cmpSel[side] && state.cmpSel[side].r === ri && state.cmpSel[side].c === ci) {
      cmpBeginEdit(side, tr, ri, ci);
      return;
    }
    cmpClearCellFocus(side);
    state.cmpSel[side] = { r: ri, c: ci };
    state.cmpLastSide = side;
    // без визуального выделения ячейки: клик подсвечивает строку целиком
    // (закрепление делает хендлер в cmpSetupPairHL); здесь только состояние
    // для правки вторым кликом / вводом с клавиатуры и стороны undo/redo
    const fl = state.cmpData[side] && state.cmpData[side].flags;
    if (fl) setUndoRedoButtons(!!fl.can_undo, !!fl.can_redo);
    // визуальную закреплённую пару mousedown не трогает — её ставит/снимает
    // click-хендлер выше, иначе фокус по ячейке снял бы подсветку строки
  });
  tbody.addEventListener("dblclick", ev => {
    const td = ev.target.closest("td");
    if (!td || td.dataset.row == null) return;
    cmpBeginEdit(side, td.parentElement, Number(td.dataset.row), Number(td.dataset.col));
  });
}

// repaint one preview cell after commit / cancel (keeps the friendly sub)
function cmpRenderCell(side, data, td, ri, ci, rawVal) {
  td.textContent = rawVal;
  if (ci === 0 && rawVal) {
    const disp = state.nameMap[String(rawVal).trim()];
    if (disp && disp !== rawVal) {
      td.title = disp + " (" + rawVal + ")";
      const sub = document.createElement("div");
      sub.className = "cell-sub";
      sub.textContent = disp;
      td.appendChild(sub);
    }
  }
}

// cell editing in a preview pane: same UX as the main grid, but the edit
// goes to THIS side's file (state.cmpData[side].path)
function cmpBeginEdit(side, tr, ri, ci, initVal) {
  const data = state.cmpData && state.cmpData[side];
  if (!data || !data.rows || !data.rows[ri]) return;
  const td = tr.children[ci];
  if (!td || td.querySelector(".cell-input")) return;
  const val = data.rows[ri][ci];
  const input = document.createElement("input");
  input.className = "cell-input";
  input.value = initVal != null ? String(initVal) : val;
  td.textContent = "";
  td.appendChild(input);
  // фокус через хелпер: голый focus() докручивает панель сам и прячет
  // ячейку под липкую колонку sysname (см. focusCellInput в grid.js)
  focusCellInput(input, td);
  let done = false;
  const commit = async () => {
    if (done) return; done = true;
    const newVal = input.value;
    cmpRenderCell(side, data, td, ri, ci, newVal);
    if (newVal !== val) {
      const r = await api("/api/edit", { method: "POST",
        body: JSON.stringify({ path: data.path, row: ri, col: ci, value: newVal }) });
      const j = await r.json();
      if (j.ok) {
        data.rows[ri][ci] = newVal;
        data.flags = { can_undo: !!j.can_undo, can_redo: !!j.can_redo };
        setUndoRedoButtons(!!j.can_undo, !!j.can_redo);
        if (j.saved) noteSaved(data.path);
      } else {
        toast(j.error || "edit error", "err");
      }
    }
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", ev => {
    if (ev.key === "Enter") { input.blur(); }
    else if (ev.key === "Escape") { done = true; cmpRenderCell(side, data, td, ri, ci, val); }
  });
}

// правка ячейки прямо в диф-режиме: изменение уходит в файл ЭТОЙ стороны,
// после ответа диф перезапускается (строки/колонки пересчитаются)
function cmpBeginDiffEdit(side, td, i, ci) {
  if (!state.compare || state.compare.preview || !state.cmpCtx) return;
  const ctx = state.cmpCtx[side];
  const item = state.cmpCtx.visible[i];
  if (!ctx || !item) return;
  const d = item.d;
  const ri = side === "left" ? d.left_index : d.right_index;
  if (ri == null) return;
  const j = state.compare;
  const fileCols = side === "left" ? (j.left_columns || []) : (j.right_columns || []);
  const filePath = side === "left" ? j.left : j.right;
  const colName = ctx.cols[ci];
  const fci = fileCols.indexOf(colName);
  if (fci < 0 || !filePath) return;
  const srcRow = ctx.src[ri] || [];
  const val = ci < srcRow.length ? String(srcRow[ci] ?? "") : "";
  const input = document.createElement("input");
  input.className = "cell-input";
  input.value = val;
  td.textContent = "";
  td.appendChild(input);
  // фокус через хелпер: голый focus() докручивает панель сам и прячет
  // ячейку под липкую колонку sysname (см. focusCellInput в grid.js)
  focusCellInput(input, td);
  let done = false;
  const commit = async () => {
    if (done) return; done = true;
    const nv = input.value;
    td.textContent = val;   // вернём старое значение; диф перерисуется
    if (nv === val) return;
    const r = await api("/api/edit", { method: "POST",
      body: JSON.stringify({ path: filePath, row: ri, col: fci, value: nv }) });
    const res = await r.json();
    if (!res.ok) { toast(res.error || "edit error", "err"); return; }
    if (res.saved) noteSaved(filePath);
    state.cmpLastSide = side;
    await runCompare();
    cmpSyncUndoButtons();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", ev => {
    if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
    else if (ev.key === "Escape") { done = true; td.textContent = val; }
  });
}

// правка ячейки превью-панели программно (контекстное меню «Вставить»/«Вырезать»)
async function cmpSetCell(side, ri, ci, newVal) {
  const data = state.cmpData && state.cmpData[side];
  if (!data || !data.rows || !data.rows[ri]) return;
  const r = await api("/api/edit", { method: "POST",
    body: JSON.stringify({ path: data.path, row: ri, col: ci, value: newVal }) });
  const j = await r.json();
  if (j.ok) {
    data.rows[ri][ci] = newVal;
    data.flags = { can_undo: !!j.can_undo, can_redo: !!j.can_redo };
    setUndoRedoButtons(!!j.can_undo, !!j.can_redo);
    if (j.saved) noteSaved(data.path);
    const table = $(side === "left" ? "#cmp-table-left" : "#cmp-table-right");
    const tr = table && table.querySelector(`tbody tr[data-row-index="${ri}"]`);
    if (tr && tr.children[ci]) cmpRenderCell(side, data, tr.children[ci], ri, ci, newVal);
  } else {
    toast(j.error || "edit error", "err");
  }
}

// перенос значения из источника (право) в основу (лево) по совпадающей колонке
async function cmpTransferCell(side, i, ci) {
  const j = state.compare;
  if (!j || j.preview || !state.cmpCtx || side !== "right") return;
  const d = state.cmpCtx.visible[i] && state.cmpCtx.visible[i].d;
  if (!d || d.left_index == null || d.right_index == null) {
    toast(t("cmp_no_base_row") || "Нет парной строки в основе", "err");
    return;
  }
  const name = state.cmpCtx.right.cols[ci];
  const lci = (j.left_columns || []).indexOf(name);
  if (lci < 0) { toast(t("cmp_no_base_col") || "Колонки нет в основе", "err"); return; }
  const val = (state.cmpCtx.right.src[d.right_index] || [])[ci];
  const r = await api("/api/edit", { method: "POST",
    body: JSON.stringify({ path: j.left, row: d.left_index, col: lci,
      value: String(val ?? ""), save: false }) }); // перенос не пишет на диск
  const res = await r.json();
  if (!res.ok) { toast(res.error || "edit error", "err"); return; }
  toast(t("cmp_moved_ok") || "Перенесено", "ok");
  state.cmpLastSide = "left"; // перенос значения пишет в основу
  await runCompare();
  cmpSyncUndoButtons();
}

// индекс строки в САМОМ файле для выбранной ячейки сравнения
function cmpCtxFileRow(side, c) {
  if (state.compare && !state.compare.preview && state.cmpCtx) {
    if (c.i == null || c.i < 0) return null;
    const d = state.cmpCtx.visible[c.i] && state.cmpCtx.visible[c.i].d;
    if (!d) return null;
    return side === "left" ? d.left_index : d.right_index;
  }
  return c.ri != null ? c.ri : null;
}

// структурная правка (добавить/удалить строку, добавить/удалить колонку)
// над файлом одной из панелей сравнения; превью перечитывает сторону,
// диф перезапускает сравнение
async function cmpStructOp(side, op, extra) {
  const path = state.compare && !state.compare.preview
    ? (side === "left" ? state.compare.left : state.compare.right)
    : (state.cmpData && state.cmpData[side] && state.cmpData[side].path);
  if (!path) return;
  const r = await api("/api/" + op, { method: "POST",
    body: JSON.stringify(Object.assign({ path }, extra)) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "error", "err"); return; }
  if (j.saved) noteSaved(path);
  toast(t("save_success"), "ok");
  state.cmpLastSide = side;
  if (state.compare && !state.compare.preview) await runCompare();
  else { state.cmpData[side] = null; await cmpLoadSide(side); }
  cmpSyncUndoButtons();
}

// перенос колонки из источника (право) в основу (лево) по имени колонки
// (в основе создаётся новая, если такой колонки там нет)
async function cmpTransferCol(srcCi) {
  const j = state.compare;
  if (!j || j.preview || !state.cmpCtx) return;
  const name = state.cmpCtx.right.cols[srcCi];
  if (name == null) return;
  const srcCol = (j.right_columns || []).indexOf(name);
  const dstCol = (j.left_columns || []).indexOf(name); // -1 -> добавить колонку
  const r = await api("/api/transfer_column", { method: "POST",
    body: JSON.stringify({ src: j.right, dst: j.left,
      src_col: srcCol, dst_col: dstCol, key_col: Math.max(j.key_col, 0) }) });
  const res = await r.json();
  if (!res.ok) { toast(res.error || "error", "err"); return; }
  toast(t("cmp_moved_ok") || "Перенесено", "ok");
  await runCompare();
}

// действия контекстного меню на панелях сравнения
// (c = снимок {side, ri, i, ci, onHead}, cellValue = чтение значения ячейки)
async function handleCmpCtxAction(act, c, cellValue) {
  const side = c && c.side;
  if (!side) return;
  if (act === "copy-cell") {
    const v = cellValue();
    if (v != null) { state.clipboard = String(v); copyText(state.clipboard); }
  } else if (act === "copy-row") {
    let vals = null;
    if (state.compare && !state.compare.preview && state.cmpCtx) {
      const d = state.cmpCtx.visible[c.i].d;
      const ri = side === "left" ? d.left_index : d.right_index;
      if (ri != null) vals = (state.cmpCtx[side].src[ri] || []).join("\t");
    } else {
      const d = state.cmpData && state.cmpData[side];
      if (d && d.rows && d.rows[c.ri]) vals = d.rows[c.ri].join("\t");
    }
    if (vals != null) copyText(vals);
  } else if (act === "copy-col") {
    const ci = c.ci;
    const out = [];
    if (state.compare && !state.compare.preview && state.cmpCtx) {
      for (const r of state.cmpCtx.visible) {
        const d = r.d;
        const ri = side === "left" ? d.left_index : d.right_index;
        if (ri == null) continue;
        const row = state.cmpCtx[side].src[ri] || [];
        out.push(ci < row.length ? String(row[ci] ?? "") : "");
      }
    } else {
      const d = state.cmpData && state.cmpData[side];
      if (d && d.rows) {
        const list = state.cmpVisIdx[side] || d.rows.map((_, i) => i);
        for (const ri of list) out.push(String(d.rows[ri][ci] ?? ""));
      }
    }
    copyText(out.join("\n"));
  } else if (act === "cut-cell") {
    const v = cellValue();
    if (v != null) {
      state.clipboard = String(v);
      copyText(state.clipboard);
      cmpSetCell(side, c.ri, c.ci, "");
    }
  } else if (act === "paste-cell") {
    if (state.clipboard != null) cmpSetCell(side, c.ri, c.ci, state.clipboard);
  } else if (act === "transfer-cell") {
    if (c.i != null) cmpTransferCell(side, c.i, c.ci);
  } else if (act === "transfer-row") {
    if (c.i != null) transferRow(state.cmpCtx.visible[c.i].d);
  } else if (act === "transfer-col") {
    await cmpTransferCol(c.ci);
  } else if (act === "add-row") {
    await cmpStructOp(side, "add_row", {});
  } else if (act === "del-row") {
    const ri = cmpCtxFileRow(side, c);
    if (ri != null) await cmpStructOp(side, "delete_row", { row: ri });
  } else if (act === "add-col") {
    await cmpStructOp(side, "add_column", {});
  } else if (act === "del-col") {
    await cmpStructOp(side, "delete_column", { col: c.ci });
  }
}

async function cmpPick(side, kind) {
  const els = cmpSide(side);
  if (kind === "folder") {
    const dir = await pickFolder();
    if (!dir) return;
    els.path.value = dir;
    await cmpFillFolderList(side);
  } else {
    const f = await pickFile();
    if (!f) return;
    els.path.value = f;
    els.dd.hidden = true;
    delete els.list.dataset.value;
    cmpLoadSide(side);
  }
}

async function cmpFillFolderList(side, silent) {
  const els = cmpSide(side);
  const root = els.path.value.trim();
  if (!root) return;
  const r = await api("/api/list_xml", { method: "POST", body: JSON.stringify({ path: root }) });
  const j = await r.json();
  if (!j.ok || !j.files.length) {
    if (!silent) toast(j.error || t("no_file"), "err");
    return;
  }
  els.list.innerHTML = "";
  delete els.list.dataset.value;
  // встроенная нескроллящаяся строка поиска (sticky, как у ключа сравнения)
  const search = document.createElement("input");
  search.type = "search";
  search.className = "cmp-list-search";
  search.placeholder = t("cmp_search_ph") || "Поиск файла…";
  search.spellcheck = false;
  search.setAttribute("aria-label", search.placeholder);
  search.addEventListener("click", e => e.stopPropagation());
  search.addEventListener("keydown", e => e.stopPropagation());
  search.addEventListener("input", () => cmpFilterFolderList(side, search.value));
  els.list.appendChild(search);
  // first item = the empty option: "no file selected" (clears the pick)
  const none = document.createElement("div");
  none.className = "cmp-list-item cmp-list-none";
  none.textContent = t("cmp_no_file") || "Файл не выбран";
  none.onclick = () => cmpNoneFile(side);
  els.list.appendChild(none);
  // компактное дерево: файлы группируются по папкам под заголовками
  let lastDir = null;
  const items = [];
  j.files.forEach(rel => {
    const cut = rel.lastIndexOf("\\");
    const dir = cut >= 0 ? rel.slice(0, cut) : "";
    if (dir !== lastDir) {
      lastDir = dir;
      if (dir) {
        const h = document.createElement("div");
        h.className = "cmp-list-dir";
        h.textContent = dir;
        h.title = dir;
        els.list.appendChild(h);
      }
    }
    const item = document.createElement("div");
    item.className = "cmp-list-item";
    const chip = cmpListChip(rel);
    if (chip) {
      const c = document.createElement("span");
      c.className = "cmp-chip " + chip.cls;
      c.textContent = chip.label;
      item.appendChild(c);
    }
    const rest = document.createElement("span");
    rest.className = "cmp-list-rest";
    rest.textContent = rel;
    item.appendChild(rest);
    item.title = rel;
    item.onclick = () => cmpSelectFile(side, rel, item);
    els.list.appendChild(item);
    items.push(item);
  });
  els.dd.hidden = false;
  els.list.hidden = true;
  // nothing is selected yet: the face shows the empty option and no side
  // loads until the user actually picks a file
  cmpNoneFile(side);
}

// фильтр выпадающего списка файлов сравнения: скрывает несовпадения,
// подсвечивает совпадение в имени и прокручивает к первому найденному
function cmpFilterFolderList(side, q) {
  const els = cmpSide(side);
  q = (q || "").trim().toLowerCase();
  let first = null;
  els.list.querySelectorAll(".cmp-list-item").forEach(it => {
    const rest = it.querySelector(".cmp-list-rest");
    const txt = ((rest && rest.textContent) || it.textContent || "").toLowerCase();
    const hit = !q || txt.includes(q);
    it.hidden = !hit;
    // подсветка найденного фрагмента (без неё поиск «ничего не ищет»)
    if (rest) {
      rest.innerHTML = "";
      const full = rest.dataset.full || it.title || "";
      if (!rest.dataset.full) rest.dataset.full = full;
      const src = rest.dataset.full || "";
      if (q && hit) {
        const i = src.toLowerCase().indexOf(q);
        if (i >= 0) {
          rest.append(document.createTextNode(src.slice(0, i)));
          const m = document.createElement("mark");
          m.className = "cmp-list-mark";
          m.textContent = src.slice(i, i + q.length);
          rest.append(m, document.createTextNode(src.slice(i + q.length)));
        } else rest.textContent = src;
      } else rest.textContent = src;
    }
    if (hit && q && !first && !it.classList.contains("cmp-list-none")) first = it;
  });
  els.list.querySelectorAll(".cmp-list-dir").forEach(h => {
    let n = h.nextElementSibling, vis = false;
    while (n && !n.classList.contains("cmp-list-dir")) {
      if (n.classList.contains("cmp-list-item") && !n.hidden) { vis = true; break; }
      n = n.nextElementSibling;
    }
    h.hidden = !vis;
  });
  if (first) first.scrollIntoView({ block: "nearest" });
}

// face + state for "no file selected" on one side
function cmpNoneFile(side) {
  const els = cmpSide(side);
  els.list.dataset.value = "";
  els.list.querySelectorAll(".cmp-list-item.selected")
    .forEach(x => x.classList.remove("selected"));
  els.face.innerHTML = "";
  const ph = document.createElement("span");
  ph.className = "cmp-dd-none";
  ph.textContent = t("cmp_no_file") || "Файл не выбран";
  els.face.appendChild(ph);
  if (state.cmpData) state.cmpData[side] = null;
  cmpStatus(side, "");
  cmpShowPreview(); // refresh: preview the remaining side or clear the page
  cmpPaintMirror();
}

// select a file in the dropdown: highlight + show it (with chip) in the face
function cmpSelectFile(side, rel, item, silent) {
  const els = cmpSide(side);
  els.list.dataset.value = rel;
  els.list.querySelectorAll(".cmp-list-item.selected")
    .forEach(x => x.classList.remove("selected"));
  item.classList.add("selected");
  els.face.innerHTML = "";
  const chip = item.querySelector(".cmp-chip");
  if (chip) els.face.appendChild(chip.cloneNode(true));
  const rest = document.createElement("span");
  rest.className = "cmp-list-rest";
  rest.textContent = item.querySelector(".cmp-list-rest").textContent;
  els.face.appendChild(rest);
  els.list.hidden = true;
  cmpLoadSide(side, silent); // the picked file starts loading immediately
  cmpMirrorPick(side, rel); // галка: потянуть аналог на вторую сторону
  cmpPaintMirror();
}

// --- галка «открыть аналогичный файл на другой стороне» (в обе стороны) ---
function cmpSideRel(side) {
  const els = cmpSide(side);
  return (els.list.dataset && els.list.dataset.value) || "";
}
function cmpFindListItem(side, rel) {
  const els = cmpSide(side);
  return [...els.list.children].find(x => {
    const rest = x.querySelector(".cmp-list-rest");
    return rest && rest.textContent === rel;
  }) || null;
}
function cmpMirrorOn() {
  const box = $("#cmp-mirror");
  if (!box) return false;
  return !box.disabled && box.checked;
}
// серая (неактивна), если вторая сторона без папки или аналога в ней нет
function cmpPaintMirror() {
  const box = $("#cmp-mirror");
  if (!box) return;
  const l = cmpSideRel("left"), r = cmpSideRel("right");
  let hasMirror = false;
  if (l || r) {
    const other = l ? "right" : "left";
    const els = cmpSide(other);
    if (els.dd && !els.dd.hidden) hasMirror = !!cmpFindListItem(other, l || r);
  }
  box.disabled = !hasMirror;
  const lab = $("#cmp-mirror-label");
  if (lab) lab.classList.toggle("is-off", !hasMirror);
}
// выбор файла на одной стороне тянет тот же rel на вторую (тихо, без рекурсии).
// Вторая сторона сама раскрывается в папку: прямой путь к файлу режется до
// его папки, пустой инпут — до корня своего источника; список подгружается
// молча и в нём выбирается аналог. Поэтому mirror открывает файл, а не
// молчит, когда вторая сторона ещё не раскрыта.
async function cmpMirrorPick(side, rel) {
  try {
    if (!rel || !cmpMirrorOn()) return;
    const other = side === "left" ? "right" : "left";
    if (cmpSideRel(other) === rel) return;
    let item = cmpFindListItem(other, rel);
    if (!item) {
      const els = cmpSide(other);
      let root = els.path.value.trim();
      if (root && els.dd && els.dd.hidden) {
        root = root.replace(/[\\/][^\\/]+$/, ""); // был файл — берём его папку
      }
      if (!root) root = srcRoot(state.cmpSrc[other]) || "";
      if (!root) return;
      els.path.value = root;
      await cmpFillFolderList(other, true);
      item = cmpFindListItem(other, rel);
    }
    if (item) cmpSelectFile(other, rel, item, true);
  } catch (e) { /* зеркало — best effort, молча */ }
}

// overlay label for a relative path: basis -> company chip (yellow),
// dlc\resistance -> purple chip, dlc\Legion -> red chip,
// dlc\evolution -> dark-blue chip; the path text keeps its full form
// (basis\... / dlc\...) so the origin stays readable
function cmpListChip(rel) {
  const p = rel.toLowerCase();
  if (p.startsWith("dlc\\legion\\"))
    return { cls: "chip-legion", label: "Legion", rest: rel };
  if (p.startsWith("dlc\\resistance\\"))
    return { cls: "chip-res", label: "Resistance", rest: rel };
  if (p.startsWith("dlc\\evolution\\"))
    return { cls: "chip-evo", label: "Evolution", rest: rel };
  if (p.startsWith("basis\\"))
    return { cls: "chip-base", label: t("overlay_basis") || "Компания", rest: rel };
  return null;
}

// clear one side: drop the picked file/folder and its dropdown
function cmpClear(side) {
  const els = cmpSide(side);
  els.path.value = "";
  els.dd.hidden = true;
  els.list.innerHTML = "";
  els.list.hidden = true;
  delete els.list.dataset.value;
  els.face.textContent = "\u0424\u0430\u0439\u043B\u2026"; // "Файл…"
  if (state.cmpData) state.cmpData[side] = null;
  cmpStatus(side, "");
  cmpPaintMirror();
}

// resolve a side input to a concrete xml file path (folder + selected relative file)
function cmpResolved(side) {
  const els = cmpSide(side);
  const p = els.path.value.trim();
  if (!p) return "";
  const rel = els.list.dataset && els.list.dataset.value;
  // a loaded folder dropdown stays collapsed after selection - check its
  // wrapper, not the popup visibility; while no file is picked in it,
  // the side is unresolved
  if (els.dd && !els.dd.hidden) {
    return rel ? p.replace(/[\\/]+$/, "") + "\\" + rel : "";
  }
  return p;
}

async function runCompare() {
  const left = cmpResolved("left"), right = cmpResolved("right");
  if (!left || !right) { toast(t("cmp_need_paths"), "err"); return; }
  const keyCol = state.cmpKeyCol == null || state.cmpKeyCol < 0 ? -1 : state.cmpKeyCol;
  const allMode = keyCol === -1; // "all keys": match by the default key, copy every column
  // метки перенесённых живут, пока сравнивается та же пара файлов тем же
  // ключом: смена входов их сбрасывает, а перезапуск после переноса — нет
  const movedFor = left + "|" + right + "|" + keyCol;
  if (state.cmpMovedFor !== movedFor) {
    state.cmpMovedFor = movedFor;
    state.cmpMoved = {};
    state.cmpMovedUndone = {};
  }
  // per-pane loading animation while the files are read on the server
  $("#cmp-loading-left").classList.remove("hidden");
  $("#cmp-loading-right").classList.remove("hidden");
  try {
    const r = await api("/api/compare", { method: "POST",
      body: JSON.stringify({ left, right, key_col: keyCol,
        default_key: state.config.default_key_column || "sysname" }) });
    const j = await r.json();
    if (!j.ok) { toast(j.error, "err"); return; }
    state.compare = j;
    state.cmpFilter = "all";
    // кнопки undo/redo — по стороне, с которой работали последней, а не
    // всегда левой (/api/compare возвращает флаги только левой)
    cmpSyncUndoButtons();
    $("#cmp-merge").disabled = false;
    // key dropdown options: "all keys" first, then columns A -> Z
    state.cmpKeyItems = [
      { v: -1, label: t("cmp_all_keys") },
      ...(j.left_columns || []).map((n, i) => ({ v: i, label: n }))
        .sort((a, b) => CMP_COLL.compare(a.label, b.label)),
    ];
    state.cmpKeyCol = allMode ? -1 : j.key_col;
    renderKeyDropdown();
    renderCompare();
  } finally {
    $("#cmp-loading-left").classList.add("hidden");
    $("#cmp-loading-right").classList.add("hidden");
  }
}

// переключатель кнопки запуска: вне дифа — «Сравнить», в дифе —
// красная «Отмена сравнения» (выход из режима + сброс всех изменений)
function cmpRunToggle() {
  if (state.compare && state.compare.diff) cancelCompare();
  else runCompare();
}

// выход из diff-режима: сбросить сравнение и все его метки,
// вернуться к превью сторон
function cancelCompare() {
  state.compare = null;
  state.cmpCtx = null;
  state.cmpPane = null;
  state.cmpMoved = {};
  state.cmpMovedFor = "";
  state.cmpMovedUndone = {};
  cmpClearPin();
  cmpShowPreview(); // перерисует панели в превью и вернёт кнопку «Сравнить»
}

// вид кнопки запуска: в diff-режиме — красная «Отмена сравнения»,
// иначе обычная «Сравнить»
function cmpPaintRun() {
  const btn = $("#cmp-run");
  if (!btn) return;
  const inDiff = !!(state.compare && state.compare.diff);
  btn.classList.toggle("danger", inDiff);
  const key = inDiff ? "cmp_cancel" : "compare";
  btn.dataset.i18n = key;
  btn.textContent = t(key) || btn.textContent;
}

const CMP_CHUNK = 400; // rows rendered per chunk (virtualization: more on scroll)
// один коллатор на все сортировки страницы: localeCompare в компараторе
// пересоздаёт коллатор на каждое сравнение и душит большие дифы
const CMP_COLL = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// ---------- выбор колонки-ключа: раскрывающееся окно с поиском ----------
function renderKeyDropdown() {
  const face = $("#cmp-key-face");
  const list = $("#cmp-key-list");
  if (!face || !list) return;
  const cur = state.cmpKeyItems.find(it => it.v === state.cmpKeyCol);
  face.textContent = cur ? cur.label : t("cmp_all_keys");
  const q = ($("#cmp-key-search").value || "").trim().toLowerCase();
  list.innerHTML = "";
  const items = state.cmpKeyItems.filter(it => !q || it.label.toLowerCase().includes(q));
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "key-dd-item" + (it.v === state.cmpKeyCol ? " active" : "");
    b.textContent = it.label;
    b.addEventListener("click", () => {
      state.cmpKeyCol = it.v;
      $("#cmp-key-pop").hidden = true;
      renderKeyDropdown();
      if (state.compare) runCompare();
    });
    list.appendChild(b);
  }
  if (!items.length) {
    const e = document.createElement("div");
    e.className = "key-dd-empty";
    e.textContent = t("cmp_search_none") || "—";
    list.appendChild(e);
  }
}

function setupKeyDropdown() {
  const pop = $("#cmp-key-pop");
  const btn = $("#cmp-key-btn");
  if (!pop || !btn) return;
  btn.addEventListener("click", e => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
    if (!pop.hidden) {
      $("#cmp-key-search").value = "";
      renderKeyDropdown();
      $("#cmp-key-search").focus();
      // широкое высокое окно выравнивается по кнопке, не вылезая за экран
      const r = btn.getBoundingClientRect();
      pop.style.left = Math.min(0, window.innerWidth - r.left - 460) + "px";
    }
  });
  pop.addEventListener("click", e => e.stopPropagation());
  $("#cmp-key-search").addEventListener("input", renderKeyDropdown);
  $("#cmp-key-search").addEventListener("keydown", e => {
    if (e.key === "Escape") { pop.hidden = true; e.stopPropagation(); }
  });
  document.addEventListener("mousedown", e => {
    if (!e.target.closest("#cmp-key-dd")) pop.hidden = true;
  });
}

function renderCompare() {
  const j = state.compare;
  const empty = $("#cmp-empty");
  const fl = $("#cmp-filters");
  const lt = $("#cmp-table-left"), rt = $("#cmp-table-right");
  if (!j || !j.diff) {
    empty.hidden = false; fl.hidden = true;
    lt.querySelector("thead").innerHTML = ""; lt.querySelector("tbody").innerHTML = "";
    rt.querySelector("thead").innerHTML = ""; rt.querySelector("tbody").innerHTML = "";
    cmpClearPin();
    state.cmpCtx = null;
    cmpPaintRun();
    return;
  }
  empty.hidden = true;
  fl.hidden = false;
  const lcols = j.left_columns || [], rcols = j.right_columns || [];
  const lnames = new Set(lcols), rnames = new Set(rcols);
  const rows = (j.diff || []).map(d => ({
    d,
    cls: d.status === "left_only" ? "row-left-only"
      : d.status === "right_only" ? "row-right-only"
      : (d.changes && d.changes.length) ? "row-changed" : "row-same",
  }));
  // keys in alphabetical order
  rows.sort((a, b) => CMP_COLL.compare(a.d.key, b.d.key));
  const st = { changed: 0, right_only: 0, left_only: 0 };
  rows.forEach(r => {
    if (r.cls === "row-changed") st.changed++;
    else if (r.cls === "row-right-only") st.right_only++;
    else if (r.cls === "row-left-only") st.left_only++;
  });
  // filter chips with counts
  fl.innerHTML = "";
  const mkFilter = (id, label, n) => {
    const b = document.createElement("button");
    b.className = "cmp-filter" + (state.cmpFilter === id ? " active" : "");
    b.innerHTML = escapeHtml(label) + ' <span class="n">' + n + "</span>";
    b.onclick = () => { state.cmpFilter = id; renderCompare(); };
    fl.appendChild(b);
  };
  mkFilter("all", t("cmp_all"), rows.length);
  mkFilter("changed", t("cmp_changed"), st.changed);
  mkFilter("right_only", t("cmp_new"), st.right_only);
  mkFilter("left_only", t("cmp_missing"), st.left_only);
  cmpPaintMerge();

  // per-side search boxes also filter the paired diff rows: a row stays
  // visible only if it matches every non-empty side's query
  const qs = {
    left: (state.cmpSearch.left || "").trim().toLowerCase(),
    right: (state.cmpSearch.right || "").trim().toLowerCase(),
  };
  const rowMatch = (side, d) => {
    const q = qs[side];
    if (!q) return true;
    const ri = side === "left" ? d.left_index : d.right_index;
    if (ri == null) return false;
    const src = side === "left" ? (j.left_rows || []) : (j.right_rows || []);
    const row = src[ri] || [];
    return row.some(v => String(v).toLowerCase().includes(q));
  };
  const keep = r => (state.cmpFilter === "all"
      || (state.cmpFilter === "changed" ? r.cls === "row-changed"
        : state.cmpFilter === "right_only" ? r.d.status === "right_only"
        : r.d.status === "left_only"))
    && rowMatch("left", r.d) && rowMatch("right", r.d);

  state.cmpCtx = {
    visible: rows.filter(keep),
    left: { cols: lcols, other: rnames, src: j.left_rows || [] },
    right: { cols: rcols, other: lnames, src: j.right_rows || [] },
  };
  state.cmpPane = { left: 0, right: 0 };
  buildCmpHead(lt, "left");
  buildCmpHead(rt, "right");
  lt.querySelector("tbody").innerHTML = "";
  rt.querySelector("tbody").innerHTML = "";
  cmpClearPin();
  appendCmpRows("left", CMP_CHUNK);
  appendCmpRows("right", CMP_CHUNK);
  // both panes filtered to nothing by the search boxes: say so instead of
  // silently empty tables
  if (!state.cmpCtx.visible.length && (qs.left || qs.right)) {
    [lt, rt].forEach((tbl, i) => {
      const tb = tbl.querySelector("tbody");
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 1 + (i === 0 ? lcols : rcols).length;
      td.className = "cmp-search-none";
      td.textContent = t("cmp_search_none");
      tr.appendChild(td);
      tb.appendChild(tr);
    });
  }
  cmpReconcileMoved();
  cmpSetupPairHL();
  cmpPaintRun();
}

// метки перенесённых сверяются с фактом после каждой перерисовки дифа:
// строка снова разъехалась — перенос отменён (метка паркуется под redo),
// снова сошлась — метка возвращается. Так отмена переноса гасит подсветку,
// а повтор — зажигает снова.
function cmpReconcileMoved() {
  const j = state.compare;
  const moved = state.cmpMoved || {};
  const stash = state.cmpMovedUndone || {};
  if (!j || !j.diff) return;
  const same = {};
  j.diff.forEach(d => {
    if (d.status === "both" && !(d.changes && d.changes.length)) same[d.key] = 1;
  });
  Object.keys(moved).forEach(k => {
    if (!same[k]) { stash[k] = moved[k]; delete moved[k]; }
  });
  Object.keys(stash).forEach(k => {
    if (same[k]) { moved[k] = stash[k]; delete stash[k]; }
  });
}

function buildCmpHead(table, side) {
  const ctx = state.cmpCtx[side];
  const thead = table.querySelector("thead");
  const hr = document.createElement("tr");
  const thSt = document.createElement("th");
  thSt.className = "td-st";
  thSt.textContent = side === "right" ? "\u27F5" : "";
  hr.appendChild(thSt);
  ctx.cols.forEach(name => {
    const th = document.createElement("th");
    th.textContent = name;
    th.title = name;
    if (!ctx.other.has(name)) th.classList.add("col-extra");
    hr.appendChild(th);
  });
  thead.innerHTML = "";
  thead.appendChild(hr);
}

// append the next chunk of rows to a pane's tbody (string-built for speed)
function appendCmpRows(side, count) {
  const ctxAll = state.cmpCtx;
  if (!ctxAll) return;
  const from = state.cmpPane[side];
  const visible = ctxAll.visible;
  if (from >= visible.length) return;
  const to = Math.min(from + count, visible.length);
  const ctx = ctxAll[side];
  const esc = escapeHtml;
  const parts = new Array(to - from);
  for (let i = from; i < to; i++) {
    const r = visible[i], d = r.d;
    const ri = side === "left" ? d.left_index : d.right_index;
    const changedMap = {};
    (d.changes || []).forEach(ch => { changedMap[ch[0]] = ch; });
    // перенеснная строка светится ярко: new — зелёным, changed — жёлтым
    const mv = state.cmpMoved && state.cmpMoved[d.key];
    let h = '<tr class="' + r.cls
      + (mv === "new" ? " row-moved-new" : mv === "changed" ? " row-moved-changed" : "") + '">';
    const needBtn = (d.status === "right_only"
      || (d.status === "both" && d.changes && d.changes.length));
    if (side === "right" && needBtn) {
      // the source table starts with the transfer arrow, then the status dot
      h += '<td class="td-st"><button class="cmp-copy" data-i="' + i + '">⟵</button>'
        + '<span class="dot ' + r.cls.replace("row-", "") + '"></span></td>';
    } else if (side === "left" && needBtn) {
      // same arrow box, invisible: left rows grow to the exact height of the
      // right ones, so row-to-row alignment holds down the whole table
      h += '<td class="td-st"><button class="cmp-copy cmp-copy-ph" tabindex="-1" aria-hidden="true">⟵</button>'
        + '<span class="dot ' + r.cls.replace("row-", "") + '"></span></td>';
    } else {
      h += '<td class="td-st"><span class="dot ' + r.cls.replace("row-", "") + '"></span></td>';
    }
    for (let ci = 0; ci < ctx.cols.length; ci++) {
      const name = ctx.cols[ci];
      const ch = changedMap[name];
      if (ri == null) {
        h += '<td class="cmp-absent"></td>';
      } else {
        const srcRow = ctx.src[ri];
        const v = srcRow && ci < srcRow.length ? srcRow[ci] : "";
        h += ch
          ? '<td class="cmp-diff" data-row="' + i + '" data-col="' + ci + '" title="' + esc(name + ": " + ch[1] + "  ->  " + ch[2]) + '">' + esc(v) + "</td>"
          : '<td data-row="' + i + '" data-col="' + ci + '">' + esc(v) + "</td>";
      }
    }
    h += "</tr>";
    parts[i - from] = h;
  }
  state.cmpPane[side] = to;
  const tbody = $(side === "left" ? "#cmp-table-left tbody" : "#cmp-table-right tbody");
  tbody.insertAdjacentHTML("beforeend", parts.join(""));
}

async function transferRow(d) {
  // copy one row FROM the source (right) INTO the base (left)
  const j = state.compare;
  if (!j || j.preview || !j.left || !j.right) return;
  const r = await api("/api/transfer_row", { method: "POST",
    body: JSON.stringify({ src: j.right, dst: j.left, row: d.right_index, key_col: j.key_col }) });
  const res = await r.json();
  if (res.ok) {
    toast(t("cmp_moved_ok") || "Перенесено", "ok");
    // пометить перенесённое, чтобы после пересчёта было явно видно:
    // новые — зелёным, изменённые — жёлтым
    state.cmpMoved[d.key] = d.status === "right_only" ? "new" : "changed";
  } else toast(res.error, "err");
  state.cmpLastSide = "left"; // перенос пишет в основу
  await runCompare();
  cmpSyncUndoButtons();
}

// ---------- сохранение сторон сравнения (кнопка шапки / Ctrl+S) ----------
// защищённый файл уходит в проект через тот же попап, что на главной;
// без пути проекта — уведомление «сначала укажите проект»
async function saveCompareGuarded(popup) {
  const seen = new Set();
  const queue = [];
  const push = (side, path) => {
    const p = String(path || "");
    if (!p || seen.has(p)) return;
    seen.add(p);
    queue.push({ side, path: p });
  };
  // сначала сторона, с которой работали последней
  const order = state.cmpLastSide === "right" ? ["right", "left"] : ["left", "right"];
  if (state.compare && !state.compare.preview) {
    for (const s of order) {
      push(s, s === "left" ? state.compare.left : state.compare.right);
    }
  } else {
    for (const s of order) {
      const d = state.cmpData && state.cmpData[s];
      if (d && d.path) push(s, d.path);
    }
  }
  if (!queue.length) { toast(t("no_file"), "err"); return; }
  for (const { path } of queue) {
    // проект обязателен для защищённых: тот же попап, но без проекта —
    // сразу уведомление, а не пустое меню
    let chk = null;
    try { chk = await guardCheck(path); } catch (e) { chk = null; }
    if (chk && chk.ok && chk.guarded && !chk.project) {
      toast(t("ctx_no_project_path") || "Укажите путь к проекту в настройках", "err");
      continue;
    }
    await guardedSave("file", path, async target => {
      if (target) {
        const j = await saveAsTo(path, "file", target);
        if (j.ok && j.saved) {
          noteSaved(j.dst);
          await noteExternalTreeChange(target);
          toast((t("save_success") || "Сохранено") + " → " + j.dst, "ok");
        } else toast((j.error || t("save_failed")), "err");
      } else {
        const r = await api("/api/save", { method: "POST",
          body: JSON.stringify({ path }) });
        const j = await r.json();
        if (j.ok) {
          if (j.saved) noteSaved(path);
          toast(t("save_success"), "ok");
          cmpSyncUndoButtons();
        } else toast((j.error || t("save_failed")), "err");
      }
    }, popup);
  }
}
// подпись кнопки слияния следует за активным фильтром: merge(filter) —
// «все» сливает новое+изменённое, «новые» только новые, «изменено» только
// изменённые; у фильтра «только слева» справа брать нечего — кнопка гаснет
function cmpPaintMerge() {
  const btn = $("#cmp-merge");
  if (!btn) return;
  const f = state.cmpFilter || "all";
  const key = f === "right_only" ? "cmp_merge_new"
    : f === "changed" ? "cmp_merge_edited" : "cmp_merge_all";
  btn.dataset.i18n = key;
  btn.textContent = t(key) || btn.textContent;
  btn.title = t("cmp_merge_t") || "";
  btn.disabled = f === "left_only";
}

// merge mode: auto-transfer everything new from the right source into the left base
async function mergeAll() {
  const j = state.compare;
  if (!j || !j.diff || j.preview) return;
  const mode = state.cmpFilter === "right_only" ? "new"
    : state.cmpFilter === "changed" ? "edited" : "all";
  const nNew = j.diff.filter(d => d.status === "right_only").length;
  const nChg = j.diff.filter(d => d.status === "both" && d.changes && d.changes.length).length;
  const n = mode === "new" ? nNew : mode === "edited" ? nChg : nNew + nChg;
  if (!n) { toast(t("cmp_search_none") || "—", "err"); return; }
  const choice = await askConfirm({
    title: t(mode === "new" ? "cmp_merge_new" : mode === "edited" ? "cmp_merge_edited" : "cmp_merge_all"),
    message: t("cmp_merge_confirm") + " (" + n + ")",
    buttons: [
      { id: "ok", label: t("cmp_merge") },
      { id: "cancel", label: t("cancel"), kind: "ghost" },
    ],
  });
  if (choice !== "ok") return;
  const r = await api("/api/merge_all", { method: "POST",
    body: JSON.stringify({ left: j.left, right: j.right, key_col: j.key_col, mode,
      default_key: state.config.default_key_column || "sysname" }) });
  const res = await r.json();
  if (!res.ok) { toast(res.error, "err"); return; }
  toast(t("cmp_created") + ": " + res.created + " · " + t("cmp_updated") + ": " + res.updated, "ok");
  // пометить всё перенесённое по активному режиму: новые — зелёным,
  // изменённые — жёлтым; видно сразу после пересчёта
  const wantNew = mode !== "edited", wantChg = mode !== "new";
  (j.diff || []).forEach(dd => {
    if (wantNew && dd.status === "right_only") state.cmpMoved[dd.key] = "new";
    else if (wantChg && dd.status === "both" && dd.changes && dd.changes.length) {
      state.cmpMoved[dd.key] = "changed";
    }
  });
  state.cmpLastSide = "left"; // слияние пишет в основу
  await runCompare();
  cmpSyncUndoButtons();
}

