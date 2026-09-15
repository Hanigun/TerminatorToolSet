/* TerminatorToolSet frontend — units.js: вкладка «Редактор юнитов» (S5: списки, пулы, шапка).
   Классический скрипт, общий глобальный скоуп, порядок загрузки — FILES в templates/index.html.
   Здесь только чтение и витрина: редактор строки, CRUD и контекстные меню — в T6 (S6). */
// Категории-классы вкладки: пять species-файлов + humans как справочник пехоты.
// Порядок — как найм в кампании: сначала отряды и техника, затем предметы и пехота.
var UNT_CATS = ["squads", "cars", "tanks", "helicopters", "inventory_items", "humans"];
// Техника рисуется слотом (фон + sysname), остальное — чистой иконкой.
var UNT_VEH_CATS = { cars: true, tanks: true, helicopters: true };

// Единственный дефолт состояния вкладки (старт + закрытие вкладки):
// cats[cat] = {path, columns, items:[{sys, src, path}]}, src — источник загрузки.
function untFreshState() {
  return { src: "", cats: {}, loading: false, loadSeq: 0, analyzing: false };
}

// Корень текущего глобального источника (Проект | Игра | Мод), как у карты и кампании.
function untSrcRoot() {
  try {
    if (typeof srcRoot === "function") return srcRoot(state.treeView);
  } catch (e) { /* древо ещё не готово */ }
  return "";
}

// Переключение источника — через глобальный источник приложения:
// setSrc сам перечитает открытую вкладку юнитов (см. tree.js), здесь только зовём.
async function untSwitchSrc(v) {
  if (typeof setSrc === "function") await setSrc(v);
}

// Открытие вкладки (шаблон openUprising/openCampaign: вкладка → таббар → активация → загрузка).
async function openUnits(opts) {
  if (!state.units) state.units = untFreshState();
  if (!state.tabs.some(tb => tb.id === "units")) {
    createTab("units");
    renderTabBar();
  }
  if (!opts || opts.activate !== false) activateTab("units");
  // Источник сменили мимо вкладки (сегмент карты/кампании) — перечитать.
  if (state.units.src && state.units.src !== state.treeView) {
    renderUnits(true).catch(() => {});
    return;
  }
  if (!state.units.src) {
    renderUnits().catch(() => {});
  }
}

// Привязка кнопок шапки и сегмента-источника (зовётся из init один раз).
function setupUnits() {
  const rel = $("#unt-reload");
  if (rel) rel.onclick = () => { renderUnits(true).catch(() => {}); };
  const ana = $("#unt-analyze");
  if (ana) ana.onclick = () => { untAnalyze().catch(() => {}); };
  const grd = $("#unt-open-grid");
  if (grd) grd.onclick = () => { untOpenGrid(); };
  const fsb = $("#unt-fs");
  if (fsb) fsb.onclick = () => {
    try {
      if (typeof paneFsToggle === "function") paneFsToggle($("#units-tab .swt-page"));
    } catch (e) { /* полноэкранный механизм ещё не загружен */ }
  };
  // Сегмент Проект|Игра|Мод — тот же глобальный переключатель, что на карте
  // и в кампании (клик по серой кнопке ведёт в настройки на строку пути).
  const seg = $("#unt-src");
  if (seg) seg.addEventListener("click", e => {
    const b = e.target.closest(".src-seg-btn");
    if (!b) return;
    if (b.classList.contains("is-off")) {
      if (typeof openSettingsPaths === "function") {
        openSettingsPaths(b.dataset.src === "mod" ? "set-mod-path"
          : b.dataset.src === "game" ? "set-unpacked" : undefined);
      }
      return;
    }
    untSwitchSrc(b.dataset.src).catch(() => {});
  });
}

// sysname строки ответа units_list/open_file: первая колонка, мусор отсекаем
// (пустые, комментарии, шапка — как справочник units_refs на бэкенде).
function untRowSys(row) {
  const vals = (row && row.values) || [];
  return String(vals.length ? vals[0] : "").trim();
}
function untSysJunk(sys) {
  if (!sys) return true;
  if (sys.charAt(0) === "#") return true;
  return sys.toLowerCase() === "sysname";
}

// Имя DLC-оверлея из пути (…/dlc/<Имя>/basis/…); нет совпадения — общее «DLC».
function untDlcName(path) {
  const m = String(path || "").match(/dlc[\\/]+([^\\/]+)[\\/]+basis/i);
  return (m && m[1]) || "DLC";
}

// Загрузка всех категорий через /api/units_list (api-хелпер из core.js):
// база — сразу, DLC-оверлеи — добором чтением файлов (бейдж источника на чипе).
async function renderUnits(force) {
  if (!state.units) state.units = untFreshState();
  if (state.units.loading && !force) return;
  const my = ++state.units.loadSeq;
  state.units.loading = true;
  const fresh = () => my === state.units.loadSeq;
  const root = untSrcRoot();
  const src = state.treeView;
  const cats = {};
  try {
    for (const cat of UNT_CATS) {
      if (!fresh()) return;
      let j = null;
      try {
        const r = await api("/api/units_list", { method: "POST",
          body: JSON.stringify({ root: root || "", cat, src }) });
        j = await r.json();
      } catch (e) { j = null; }
      if (!j || !j.ok || !Array.isArray(j.rows)) continue;
      // Единый список: сначала база, поверх — оверлеи (DLC выигрывает
      // у basis при том же sysname, порядок первого появления сохраняем).
      const bySys = new Map();
      (j.rows || []).forEach(row => {
        const sys = untRowSys(row);
        if (untSysJunk(sys) || bySys.has(sys)) return;
        bySys.set(sys, { sys, src: "basis", path: j.path || "" });
      });
      for (const op of (j.overlays || [])) {
        if (!fresh()) return;
        try {
          const or = await api("/api/file?path=" + encodeURIComponent(op));
          const oj = await or.json();
          if (!oj || !oj.ok || !Array.isArray(oj.rows)) continue;
          const dlc = untDlcName(op);
          (oj.rows || []).forEach(row => {
            const sys = untRowSys(row);
            if (untSysJunk(sys)) return;
            // Повтор sysname из DLC затирает basis-версию (зеркало вниз).
            bySys.delete(sys);
            bySys.set(sys, { sys, src: dlc, path: op });
          });
        } catch (e) { /* оверлей не прочитался — остаётся база */ }
      }
      cats[cat] = { path: j.path || "", columns: j.columns || [],
        items: Array.from(bySys.values()) };
    }
    if (!fresh()) return;
    state.units.src = src;
    state.units.cats = cats;
    untPaintHeader(root, src);
    untPaint();
  } finally {
    if (fresh()) state.units.loading = false;
  }
}

// Шапка после загрузки: путь корня в субтитле, кнопки видны при наличии данных.
function untPaintHeader(root, src) {
  const fp = $("#unt-file");
  if (fp) {
    const has = Object.keys(state.units.cats || {}).length > 0;
    fp.textContent = has && root ? root : (t("unt_sub") || "");
    fp.title = has && root ? root : "";
  }
  const has = Object.keys(state.units.cats || {}).length > 0;
  ["#unt-reload", "#unt-analyze", "#unt-open-grid", "#unt-fs"].forEach(s => {
    const el = $(s);
    if (el) el.hidden = !has;
  });
  try {
    if (typeof paintSrcSwitches === "function") paintSrcSwitches();
  } catch (e) { /* переключатели красит древо */ }
}

// Витрина: сектор 0 «Общий пул», внутри категории-классы друг под другом.
function untPaint() {
  const main = $("#unt-main");
  if (!main) return;
  main.innerHTML = "";
  const cats = (state.units && state.units.cats) || {};
  const total = UNT_CATS.reduce((a, c) => a + ((cats[c] && cats[c].items.length) || 0), 0);
  if (!total) {
    const d = document.createElement("div");
    d.className = "tree-empty";
    d.textContent = t("unt_sub") || "";
    main.appendChild(d);
    return;
  }
  main.appendChild(untSecBlock(total, cats));
}

// Сектор-пул (образец edSecBlock): заголовок + категории друг под другом.
function untSecBlock(total, cats) {
  const wrap = document.createElement("div");
  wrap.className = "unt-sec";
  wrap.dataset.sec = "0";
  const head = document.createElement("div");
  head.className = "unt-sector-head";
  const name = document.createElement("span");
  name.className = "unt-sector-name";
  name.textContent = (t("unt_pool_all") || "Общий пул") + " · " + total;
  head.appendChild(name);
  wrap.appendChild(head);
  UNT_CATS.forEach(cat => {
    const data = cats[cat];
    if (!data) return;
    wrap.appendChild(untCatBlock(cat, data.items));
  });
  return wrap;
}

// Блок категории-класса (образец edCatBlock): заголовок + чипы + «+» последней.
function untCatBlock(cat, items) {
  const sec = document.createElement("div");
  sec.className = "unt-cat";
  const title = document.createElement("div");
  title.className = "unt-cat-title";
  // Заголовки — иконками UnitSet, как карта и кампания; нет хелпера — текстом.
  if (typeof uprCatTitle === "function") uprCatTitle(title, cat, " · " + items.length);
  else title.textContent = (t("unt_class_" + cat) || cat) + " · " + items.length;
  sec.appendChild(title);
  const bwrap = document.createElement("div");
  bwrap.className = "unt-cat-body";
  bwrap.dataset.cat = cat;
  items.forEach(it => bwrap.appendChild(untChip(it, cat)));
  // Кнопка «+» всегда последняя в ряду (добавление строк — в T6).
  const add = document.createElement("button");
  add.type = "button";
  add.className = "unt-chip-add";
  add.title = t("unt_add") || "Добавить";
  const addImg = document.createElement("img");
  addImg.className = "unt-chip-add-icon";
  addImg.src = "/assets/UprisingMap/add_unit.webp";
  addImg.alt = "";
  addImg.draggable = false;
  addImg.onerror = () => { add.textContent = "+"; };
  add.appendChild(addImg);
  add.onclick = ev => {
    ev.stopPropagation();
    toast((t("unt_add") || "Добавить") + " — T6");
  };
  bwrap.appendChild(add);
  sec.appendChild(bwrap);
  return sec;
}

// Чип юнита: иконка через общий хелпер карты (мгновенный плейсхолдер
// категории + фоновая подмена реальной) + бейдж источника (basis/DLC).
function untChip(it, cat) {
  const chip = document.createElement("span");
  chip.className = "unt-chip unt-card" + (UNT_VEH_CATS[cat] ? " veh" : "");
  chip.title = it.sys + "\n" + (it.path || "");
  const img = document.createElement("img");
  img.className = "unt-chip-icon";
  img.draggable = false;
  img.loading = "lazy";
  img.alt = it.sys;
  if (typeof uprChipIcon === "function") uprChipIcon(img, chip, it.sys, cat);
  else if (typeof uprPlaceholderUrl === "function") {
    img.src = uprPlaceholderUrl(cat, it.sys) || "";
    if (!img.src) img.classList.add("noicon");
  } else img.classList.add("noicon");
  chip.appendChild(img);
  // Слот техники: sysname поверх фона (классы и раскладка — из units.css).
  if (UNT_VEH_CATS[cat]) {
    const sys = document.createElement("span");
    sys.className = "unt-chip-veh-sys";
    sys.textContent = it.sys;
    chip.appendChild(sys);
  }
  const badge = document.createElement("span");
  badge.className = "unt-src-badge";
  badge.textContent = it.src || "basis";
  chip.appendChild(badge);
  return chip;
}

// Анализ: сводка-счётчики по классам (без конвертации иконок — это T5-витрина).
async function untAnalyze() {
  if (!state.units) state.units = untFreshState();
  if (state.units.analyzing) return;
  state.units.analyzing = true;
  const btn = $("#unt-analyze");
  const label = t("unt_analyze") || "Анализ";
  if (btn) { btn.disabled = true; btn.textContent = label + "…"; }
  try {
    if (!state.units.src) await renderUnits();
    const cats = state.units.cats || {};
    const parts = [];
    UNT_CATS.forEach(cat => {
      const n = (cats[cat] && cats[cat].items.length) || 0;
      if (n > 0) parts.push((t("unt_class_" + cat) || cat) + ": " + n);
    });
    toast(parts.length ? parts.join(" · ") : label, parts.length ? "ok" : "");
  } catch (e) { toast(String((e && e.message) || e), "err"); }
  finally {
    state.units.analyzing = false;
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

// Открыть species-файл в гриде через существующий механизм (первый загруженный класс).
function untOpenGrid() {
  const cats = (state.units && state.units.cats) || {};
  for (const cat of UNT_CATS) {
    const p = cats[cat] && cats[cat].path;
    if (p && typeof openFile === "function") { openFile(p); return; }
  }
  toast(t("unt_sub") || "", "err");
}

// Пачка правок ячеек одной записью истории (заготовка под редактор T6):
// cells = [{row, col, value, type?}] — строки species-файла, row включая шапку.
async function untWriteCells(path, cells, summary) {
  try {
    const r = await api("/api/edit_cells", { method: "POST",
      body: JSON.stringify({ path, cells: cells || [], summary: summary || "" }) });
    const j = await r.json();
    if (!j || !j.ok) toast((j && j.error) || "error", "err");
    return j;
  } catch (e) {
    toast(String((e && e.message) || e), "err");
    return { ok: false, error: String((e && e.message) || e) };
  }
}
