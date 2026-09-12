/* TerminatorToolSet frontend — findbar.js: mkFindBar, файловый find, zoom шрифтов
   Вырезано из app.js без изменений логики. Классические скрипты,
   общий глобальный скоуп, порядок загрузки — FILES в templates/index.html. */
// ---------- Общий попап поиска/замены (ядро) ----------
 // Один и тот же механизм для вкладок файлов (XML), SWT-редактора и обеих
// панелей сравнения. Внешний вид и поведение взяты с поиска XML-вкладок:
// ввод с задержкой 150 мс, Enter/Shift+Enter — вниз/вверх, Esc — закрыть,
// опциональная строка замены. Логика конкретной вкладки подключается хуками
// onQuery/onStep/onReplaceOne/onReplaceAll/onClose/onOpen.
// Память запроса общая на всё приложение: переживает закрытие попапа,
// смену файлов и рестарт программы (localStorage tsh_find_q). Попап сам
// по клику мимо больше не закрывается — только по ✕/Esc. Закрытие ничего
// не трогает: текст, подсветка и скролл остаются,
// найденное остаётся в поле зрения; сброс подсветки — только ручной очисткой
// поля (пустой запрос).
function fpSaveQ(q) {
  try {
    fpSaveQ.val = q || "";
    localStorage.setItem("tsh_find_q", fpSaveQ.val);
  } catch (e) { fpSaveQ.val = q || ""; }
}
function fpLastQ() {
  if (fpLastQ.val === undefined) {
    try { fpLastQ.val = localStorage.getItem("tsh_find_q") || ""; }
    catch (e) { fpLastQ.val = ""; }
  }
  return fpLastQ.val;
}
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
    timer = setTimeout(() => {
      fpSaveQ(inp.value);
      if (opts.onQuery) opts.onQuery(inp.value);
    }, 150);
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
  // самозакрытия по клику мимо больше нет вообще: все поиски живут
  // до ручного закрытия (крестик/Esc) — клик по любому полю таблицы
  // попап не трогает (наружный mousedown-обработчик удалён полностью)
  const bar = {
    el: pop,
    open(showRep) {
      pop.hidden = false;
      repRow.hidden = !(withRep && showRep && (!opts.canReplace || opts.canReplace()));
      // пустой ввод после рестарта/первого открытия — подтягиваем общий
      // запомненный запрос и сразу ищем (файловый openFind свой рефреш
      // делает сам, потому здесь — только когда текст восстановили мы)
      let restored = false;
      if (!inp.value && fpLastQ()) { inp.value = fpLastQ(); restored = true; }
      inp.focus();
      inp.select();
      if (opts.onOpen) opts.onOpen();
      if (restored && inp.value && opts.onQuery) opts.onQuery(inp.value);
    },
    close() {
      if (pop.hidden) return;
      pop.hidden = true;
      repRow.hidden = true;
      // текст, счётчик, подсветку и скролл НЕ трогаем: запрос переживает
      // закрытие, найденное остаётся подсвеченным и в поле зрения
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
  // ключи колонок ищутся тоже (ri:-1): sysname/cost/cp_cost живут в шапке,
  // в значениях их может не быть вообще. Заголовки — первыми, чтобы навигация
  // с "cost" сразу вставала на колонку, а не на её сотое вхождение в ячейках
  (f.columns || []).forEach((name, ci) => {
    if (String(name).toLowerCase().includes(q)) {
      state.find.matches.push({ ri: -1, ci });
      state.find.keySet.add("h:" + ci);
    }
  });
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
  // совпадение в шапке (ri:-1): подсвечиваем th и докручиваем по горизонтали;
  // вертикаль не трогаем — шапка и так сверху (centerCellVert её бы угнал вниз)
  if (m.ri === -1) {
    const th = table.querySelector(`thead th[data-col="${m.ci}"]`);
    if (th) {
      th.classList.add("find-cur");
      ensureCellVisible(th);
    }
    return;
  }
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
    centerCellVert(td);
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
  // текст пережил закрытие в поле или в общей памяти (рестарт) —
  // подхватываем, иначе повторное открытие было бы пустым
  if (!state.find.q) state.find.q = fileFind.q || fpLastQ();
  fileFind.setQ(state.find.q || "");
  fileFind.open(showReplace);
  if (state.find.q) refreshFind();
}

// закрытие — только прячем попап: запрос, подсветка и скролл живут дальше
// (найденное остаётся в поле зрения); сброс — ручной очисткой поля
function closeFind() {
  if (fileFind) fileFind.close();
}

async function replaceCurrent() {
  const f = state.currentFile;
  const m = state.find.matches[state.find.idx];
  if (!f || !m) return;
  if (m.ri === -1) return;   // ключ колонки не заменяется — только ячейки
  const q = state.find.q;
  const repl = fileFind ? fileFind.replaceText() : "";
  const oldVal = String(f.rows[m.ri].values[m.ci] || "");
  const re = new RegExp(escapeRegExp(q), "gi");
  const newVal = oldVal.replace(re, repl);
  const r = await api("/api/edit", { method: "POST",
    body: JSON.stringify({ path: f.path, row: m.ri, col: m.ci, value: newVal, save: false,
      ...syncFlags() }) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "edit error", "err"); return; }
  await handleSyncResult(j, f.path);
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
  // замена — только ячейки: ключи колонок ("h:ci") отфильтровываем
  const hits = [...state.find.keySet]
    .filter(k => k[0] !== "h")
    .map(k => k.split(":").map(Number));
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
        ...syncFlags(),
        summary: `${t("replace_all") || "Замена"} '${q}' → '${repl}' (${cells.length})` }) });
    const j = await r.json();
    if (j.ok && j.changed) {
      await handleSyncResult(j, f.path);
      for (const c of chunk) f.rows[c.row].values[c.col] = c.value;
      changed += (j.n || chunk.length);
    }
  }
  // one save for the whole batch
  const sr = await api("/api/save", { method: "POST",
    body: JSON.stringify({ path: f.path, ...syncFlags() }) });
  const sj = await sr.json();
  if (sj.saved) noteSaved(f.path);
  if (typeof markSyncTabsSaved === "function") markSyncTabsSaved(sj.sync_saved);
  state.dirty = false;
  const activeTab = state.tabs.find(tb => tb.id === state.activeTabId);
  if (activeTab) activeTab.dirty = false;
  updateDirty();
  renderTabBar();
  refreshFind();
  let doneMsg = `${t("replace_all")}: ${changed}`;
  if (typeof syncSavedLines === "function") {
    const lines = syncSavedLines(sj.sync_saved);
    if (lines.length) doneMsg += "\n" + lines.join("\n");
  }
  toast(doneMsg, "ok");
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

