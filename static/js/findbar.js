/* TerminatorToolSet frontend — findbar.js: mkFindBar, файловый find, zoom шрифтов
   Вырезано из app.js без изменений логики. Классические скрипты,
   общий глобальный скоуп, порядок загрузки — FILES в templates/index.html. */
// ---------- Общий попап поиска/замены (ядро) ----------
// Один и тот же механизм для вкладок файлов (XML), SWT-редактора и обеих
// панелей сравнения. Внешний вид и поведение взяты с поиска XML-вкладок:
// ввод с задержкой 150 мс, Enter/Shift+Enter — вниз/вверх, Esc — закрыть,
// опциональная строка замены. Логика конкретной вкладки подключается хуками
// onQuery/onStep/onReplaceOne/onReplaceAll/onClose/onOpen.
const FP_SVG = {
  prev: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 15l-6-6-6 6"/></svg>',
  next: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>',
  rep: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>',
  close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>',
};

function mkFindBar(opts) {
  const pop = document.createElement("div");
  pop.className = "cmp-find-pop" + (opts.cls ? " " + opts.cls : "");
  if (opts.id) pop.id = opts.id;
  pop.innerHTML = `
    <div class="find-row">
      <input type="text" class="fp-input" spellcheck="false" data-i18n-ph="find_ph">
      <span class="find-count fp-count">0/0</span>
      <button class="icon-btn fp-prev" data-i18n-title="find_prev_t">${FP_SVG.prev}</button>
      <button class="icon-btn fp-next" data-i18n-title="find_next_t">${FP_SVG.next}</button>
      <button class="icon-btn fp-tglrep" data-i18n-title="find_rep_t">${FP_SVG.rep}</button>
      <button class="icon-btn fp-close danger" data-i18n-title="find_close_t">${FP_SVG.close}</button>
    </div>
    <div class="find-row fp-rep-row" hidden>
      <input type="text" class="fp-rep-input" spellcheck="false" data-i18n-ph="replace_ph">
      <button class="btn sm fp-rep-one" data-i18n="replace_one"></button>
      <button class="btn sm ghost fp-rep-all" data-i18n="replace_all"></button>
    </div>`;
  pop.hidden = true; // попап скрыт до первого Ctrl+F
  if (opts.sticky) {
    // sticky-обёртка нулевой высоты: попап прибит к верху прокручиваемой
    // панели и остаётся видимым при скролле и переходах по совпадениям;
    // в начало контейнера, чтобы pin стоял до таблицы (иначе после длинной
    // таблицы он «внизу страницы»)
    const pin = document.createElement("div");
    pin.className = "fp-pin";
    pin.appendChild(pop);
    opts.host.insertBefore(pin, opts.host.firstChild);
  } else {
    opts.host.appendChild(pop);
  }
  applyI18n();
  const inp = pop.querySelector(".fp-input");
  const repInp = pop.querySelector(".fp-rep-input");
  const repRow = pop.querySelector(".fp-rep-row");
  const count = pop.querySelector(".fp-count");
  const withRep = !!opts.withReplace;
  pop.querySelector(".fp-tglrep").hidden = !withRep;
  let timer = null;
  inp.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (opts.onQuery) opts.onQuery(inp.value); }, 150);
  });
  inp.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); opts.onStep && opts.onStep(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); bar.close(); }
  });
  repInp.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); opts.onReplaceOne && opts.onReplaceOne(repInp.value); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); bar.close(); }
  });
  // клики внутри попапа не закрывают его через outside-обработчик
  pop.addEventListener("mousedown", e => e.stopPropagation());
  pop.querySelector(".fp-prev").onclick = () => opts.onStep && opts.onStep(-1);
  pop.querySelector(".fp-next").onclick = () => opts.onStep && opts.onStep(1);
  pop.querySelector(".fp-close").onclick = () => bar.close();
  pop.querySelector(".fp-tglrep").onclick = () => {
    repRow.hidden = !repRow.hidden;
    if (!repRow.hidden) repInp.focus();
  };
  pop.querySelector(".fp-rep-one").onclick = () => opts.onReplaceOne && opts.onReplaceOne(repInp.value);
  pop.querySelector(".fp-rep-all").onclick = () => opts.onReplaceAll && opts.onReplaceAll(repInp.value);
  // клик мимо попапа закрывает его (autoClose: false — закрывается только
  // по ✕/Esc, так два поиска сравнения живут одновременно)
  if (opts.autoClose !== false) {
    document.addEventListener("mousedown", e => {
      if (pop.hidden || pop.contains(e.target)) return;
      if (e.target.closest && e.target.closest(".cmp-find-pop")) return;
      bar.close();
    });
  }
  const bar = {
    el: pop,
    open(showRep) {
      pop.hidden = false;
      repRow.hidden = !(withRep && showRep && (!opts.canReplace || opts.canReplace()));
      inp.focus();
      inp.select();
      if (opts.onOpen) opts.onOpen();
    },
    close() {
      if (pop.hidden) return;
      pop.hidden = true;
      inp.value = ""; repInp.value = ""; repRow.hidden = true;
      count.textContent = "0/0";
      if (opts.onClose) opts.onClose();
    },
    isOpen: () => !pop.hidden,
    get q() { return inp.value; },
    setQ(v) { inp.value = v || ""; },
    replaceText: () => repInp.value,
    setCount(i, n) { count.textContent = n ? (i + 1) + "/" + n : "0/0"; },
    showRepRow() { repRow.hidden = false; repInp.focus(); },
  };
  return bar;
}

// ---------- Find & Replace (вкладки файлов, поверх общего ядра) ----------
let findTimer = null;
let fileFind = null;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function computeFindMatches() {
  const f = state.currentFile;
  const q = state.find.q.toLowerCase();
  state.find.matches = [];
  state.find.keySet = new Set();
  if (!f || !q) return;
  f.rows.forEach((row, ri) => {
    row.values.forEach((v, ci) => {
      if (String(v).toLowerCase().includes(q)) {
        state.find.matches.push({ ri, ci });
        state.find.keySet.add(ri + ":" + ci);
      }
    });
  });
}

function updateFindCount() {
  if (fileFind) fileFind.setCount(state.find.idx, state.find.matches.length);
}

function refreshFind(keepIdx) {
  computeFindMatches();
  if (!keepIdx || state.find.idx >= state.find.matches.length) state.find.idx = 0;
  renderGrid();
  updateFindCount();
  paintCurrentMatch();
}

function paintCurrentMatch() {
  const table = getActiveGridTable();
  if (!table) return;
  $$(".find-cur", table).forEach(el => el.classList.remove("find-cur"));
  const m = state.find.matches[state.find.idx];
  if (!m) return;
  let td = table.querySelector(`td[data-row="${m.ri}"][data-col="${m.ci}"]`);
  if (!td && state.visRows.length) {
    // virtualized row not rendered yet - append up to it, then scroll both axes
    const k = state.visRows.findIndex(v => v.ri === m.ri);
    if (k >= state.gridRenderLimit) {
      const to = Math.min(k + 1, state.visRows.length);
      appendGridRows(table, state.gridRenderLimit, to);
      state.gridRenderLimit = to;
    }
    td = table.querySelector(`td[data-row="${m.ri}"][data-col="${m.ci}"]`);
  }
  if (td) {
    td.classList.add("find-cur");
    ensureCellVisible(td);
  }
}

function findStep(dir) {
  const n = state.find.matches.length;
  if (!n) return;
  state.find.idx = (state.find.idx + dir + n) % n;
  updateFindCount();
  paintCurrentMatch();
}

function openFind(showReplace) {
  if (!fileFind) return;
  fileFind.setQ(state.find.q || "");
  fileFind.open(showReplace);
  if (state.find.q) refreshFind();
}

function closeFind() {
  if (fileFind) fileFind.close();
  state.find.active = false;
  state.find.q = "";
  renderGrid();
}

async function replaceCurrent() {
  const f = state.currentFile;
  const m = state.find.matches[state.find.idx];
  if (!f || !m) return;
  const q = state.find.q;
  const repl = fileFind ? fileFind.replaceText() : "";
  const oldVal = String(f.rows[m.ri].values[m.ci] || "");
  const re = new RegExp(escapeRegExp(q), "gi");
  const newVal = oldVal.replace(re, repl);
  const r = await api("/api/edit", { method: "POST",
    body: JSON.stringify({ path: f.path, row: m.ri, col: m.ci, value: newVal, save: false }) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "edit error", "err"); return; }
  f.rows[m.ri].values[m.ci] = newVal;
  state.dirty = true;
  const activeTab = state.tabs.find(tb => tb.id === state.activeTabId);
  if (activeTab) activeTab.dirty = true;
  updateDirty();
  renderTabBar();
  refreshFind(true);
}

async function replaceAll() {
  const f = state.currentFile;
  if (!f) return;
  const q = state.find.q;
  const repl = fileFind ? fileFind.replaceText() : "";
  if (!q) return;
  computeFindMatches();
  const hits = [...state.find.keySet].map(k => k.split(":").map(Number));
  if (!hits.length) { toast(t("save_success"), "ok"); return; }
  const re = new RegExp(escapeRegExp(q), "gi");
  // вся замена — одна пачка: один запрос, одна запись истории, один undo-шаг
  const cells = [];
  for (const [ri, ci] of hits) {
    const oldVal = String(f.rows[ri].values[ci] || "");
    const newVal = oldVal.replace(re, repl);
    if (newVal === oldVal) continue;
    cells.push({ row: ri, col: ci, value: newVal });
  }
  let changed = 0;
  for (let i = 0; i < cells.length; i += 2000) {
    const chunk = cells.slice(i, i + 2000);
    const r = await api("/api/edit_cells", { method: "POST",
      body: JSON.stringify({ path: f.path, cells: chunk, save: false,
        summary: `${t("replace_all") || "Замена"} '${q}' → '${repl}' (${cells.length})` }) });
    const j = await r.json();
    if (j.ok && j.changed) {
      for (const c of chunk) f.rows[c.row].values[c.col] = c.value;
      changed += (j.n || chunk.length);
    }
  }
  // one save for the whole batch
  const sr = await api("/api/save", { method: "POST", body: JSON.stringify({ path: f.path }) });
  const sj = await sr.json();
  if (sj.saved) noteSaved(f.path);
  state.dirty = false;
  const activeTab = state.tabs.find(tb => tb.id === state.activeTabId);
  if (activeTab) activeTab.dirty = false;
  updateDirty();
  renderTabBar();
  refreshFind();
  toast(`${t("replace_all")}: ${changed}`, "ok");
}

function setupFindBars() {
  fileFind = mkFindBar({
    host: $("#tab-panels"),
    cls: "find-bar-pop",
    withReplace: true,
    onQuery: q => { state.find.q = q; state.find.active = !!q; refreshFind(); },
    onStep: d => findStep(d),
    onReplaceOne: () => replaceCurrent(),
    onReplaceAll: () => replaceAll(),
    onClose: () => { state.find.active = false; state.find.q = ""; renderGrid(); },
  });
}

// ---------- grid font size (Ctrl +/- and settings) ----------
// ---------- ядро масштаба ----------
// Два независимых масштаба: текст/контент страниц (contentZoom) и общий
// интерфейс (uiZoom). Двигаются горячими клавишами (контент) и селектами
// в настройках; хранятся в localStorage, применяются CSS-переменными
// --content-zoom / --ui-zoom (см. style.css, zoom на контейнерах).
const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.4];

function loadZoom(key) {
  const v = parseFloat(localStorage.getItem(key) || "1");
  return Number.isFinite(v) ? v : 1;
}
function applyZooms() {
  document.documentElement.style.setProperty("--content-zoom", String(loadZoom("contentZoom")));
  document.documentElement.style.setProperty("--ui-zoom", String(loadZoom("uiZoom")));
}
function snapZoom(v) {
  return ZOOM_STEPS.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a, ZOOM_STEPS[0]);
}
function setZoom(key, v) {
  localStorage.setItem(key, String(snapZoom(v)));
  applyZooms();
}
function zoomScale(key, dir) {
  const steps = ZOOM_STEPS;
  const i = steps.indexOf(loadZoom(key));
  setZoom(key, steps[Math.min(steps.length - 1, Math.max(0, (i < 0 ? 2 : i) + dir))]);
}

