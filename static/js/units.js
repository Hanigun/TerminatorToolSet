/* TerminatorToolSet frontend — units.js: вкладка «Редактор юнитов» (S5+S6).
   Классический скрипт, общий глобальный скоуп, порядок загрузки — FILES в templates/index.html.
   S5: чтение и витрина (пулы, шапка). S6: попап-редактор, CRUD, контекстные меню. */
// Категории-классы вкладки: пять species-файлов + humans как справочник пехоты.
// Порядок — как найм в кампании: сначала отряды и техника, затем предметы и пехота.
var UNT_CATS = ["squads", "cars", "tanks", "helicopters", "inventory_items", "humans"];
// Техника рисуется слотом (фон + sysname), остальное — чистой иконкой.
var UNT_VEH_CATS = { cars: true, tanks: true, helicopters: true };
// Белые колонки статов species (_STAT_COLS, api/sheets.py): только их правит
// попап-редактор; произвольные колонки писать нельзя.
var UNT_STAT_COLS = ["cost", "cp_cost", "supply_consumption", "people_capacity", "unit_set"];

// Единственный дефолт состояния вкладки (старт + закрытие вкладки):
// cats[cat] = {path, columns, overlays, items:[{sys, src, path}]}, src — источник загрузки,
// clip — буфер обмена таба {op, items:[{cat, sys, path, values?}]} или null,
// cat — выбранный класс селектора, sel — выбранный юнит (sysname) для тела,
// iconMap — свои иконки категории (sysname -> data-URL webp, НЕ карта uprising),
// iconsReady/iconsLoading/iconSeq — готовность/загрузка/поколение своего батча,
// detSeq — поколение тела (защита от гонки чтений при быстрых кликах).
function untFreshState() {
  return { src: "", cats: {}, loading: false, loadSeq: 0, analyzing: false, clip: null,
    cat: "squads", sel: null, iconMap: {}, iconsReady: false, iconsLoading: false,
    iconSeq: 0, detSeq: 0 };
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
        overlays: (j.overlays || []).slice(),
        items: Array.from(bySys.values()) };
    }
    if (!fresh()) return;
    // Смена источника — чужие иконки и тело недействительны; внутри одного
    // источника карту копим (батч добирает только недостающее, как кампания).
    const srcChanged = state.units.src !== src;
    state.units.src = src;
    state.units.cats = cats;
    if (srcChanged) {
      state.units.iconMap = {};
      state.units.iconsReady = false;
    }
    // Выбор живёт по sysname: класс чиним на первый непустой, sel сбрасываем
    // только если строка пропала (CRUD/зеркало), иначе тело держит старое.
    if (UNT_CATS.indexOf(state.units.cat) === -1 || !cats[state.units.cat])
      state.units.cat = UNT_CATS.find(c => cats[c] && (cats[c].items || []).length) || "squads";
    const curItems = ((cats[state.units.cat] || {}).items) || [];
    if (state.units.sel && !curItems.some(x => x.sys === state.units.sel))
      state.units.sel = null;
    if (!state.units.sel && curItems.length) state.units.sel = curItems[0].sys;
    untPaintHeader(root, src);
    untPaint();
    // Иконки текущего класса — своим батчем (карту uprising не трогаем).
    untEnsureIcons(state.units.cat).catch(() => {});
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

// Витрина master-detail (как найм в кампании): сверху селектор класса
// (один открытый класс за раз, выбор — в state.units.cat), ниже слева
// вертикальный список юнитов класса, справа — тело с параметрами.
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
  if (UNT_CATS.indexOf(state.units.cat) === -1 || !cats[state.units.cat])
    state.units.cat = UNT_CATS.find(c => cats[c]) || "squads";
  const cat = state.units.cat;
  main.appendChild(untCatBar(cats, total));
  const wrap = document.createElement("div");
  wrap.className = "unt-wrap";
  const pane = document.createElement("div");
  pane.className = "unt-list-pane";
  const head = document.createElement("div");
  head.className = "unt-list-head";
  const title = document.createElement("span");
  title.className = "unt-list-title";
  title.id = "unt-list-title";
  pane.appendChild(head);
  head.appendChild(title);
  // Кнопка «+» в шапке списка — добавление в текущий класс.
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
    untAddUnit(cat).catch(() => {});
  };
  head.appendChild(add);
  // Правая кнопка по шапке — меню сектора, по фону списка — меню категории.
  head.oncontextmenu = e => untSecCtx(e);
  const list = document.createElement("div");
  list.className = "unt-list";
  list.id = "unt-list";
  list.oncontextmenu = e => {
    if (e.target.closest && e.target.closest(".unt-row")) return;
    untCatCtx(e, cat);
  };
  pane.appendChild(list);
  const detail = document.createElement("div");
  detail.className = "unt-detail";
  detail.id = "unt-detail";
  wrap.appendChild(pane);
  wrap.appendChild(detail);
  main.appendChild(wrap);
  untPaintList();
  untPaintDetail();
}

// Селектор класса: выпадающий список шести species-классов
// (подписи — unt_class_*, как заголовки старой витрины).
function untCatBar(cats, total) {
  const bar = document.createElement("div");
  bar.className = "unt-catbar";
  bar.oncontextmenu = e => untSecCtx(e);
  const lab = document.createElement("span");
  lab.className = "unt-catbar-label";
  lab.textContent = (t("unt_pool_all") || "Общий пул") + " · " + total;
  bar.appendChild(lab);
  const sel = document.createElement("select");
  sel.className = "unt-cat-sel";
  sel.title = lab.textContent;
  UNT_CATS.forEach(c => {
    if (!cats[c]) return;
    const o = document.createElement("option");
    o.value = c;
    o.textContent = (t("unt_class_" + c) || c) + " · " + ((cats[c].items || []).length);
    if (c === state.units.cat) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = () => {
    if (!state.units) return;
    state.units.cat = sel.value;
    state.units.sel = null;
    state.units.iconsReady = false;
    untPaint();
    untEnsureIcons(state.units.cat).catch(() => {});
  };
  bar.appendChild(sel);
  return bar;
}

// Список юнитов выбранного класса: строка = слот/иконка + sysname + бейдж
// basis/DLC. Выбор — клик, попап — двойной клик, меню — правая кнопка.
function untPaintList() {
  const list = $("#unt-list");
  if (!list) return;
  const st = list.scrollTop;
  list.innerHTML = "";
  const cat = state.units.cat;
  const data = untCatData(cat);
  const items = ((data && data.items) || []).slice();
  if (state.units.sel && !items.some(x => x.sys === state.units.sel))
    state.units.sel = null;
  if (!state.units.sel && items.length) state.units.sel = items[0].sys;
  const title = $("#unt-list-title");
  if (title) title.textContent = (t("unt_class_" + cat) || cat) + " · " + items.length;
  items.forEach(it => list.appendChild(untRow(it, cat)));
  list.scrollTop = st;
}

// Строка списка: иконка через общий хелпер карты (мгновенный плейсхолдер
// категории + спиннер upr-loading + подмена реальной из СВОЕЙ карты
// state.units.iconMap — карту uprising не трогаем). Техника — слот veh,
// сквады — слот inf (подложка unitslot_main_inf.webp, как слоты техники).
function untRow(it, cat) {
  const row = document.createElement("div");
  row.className = "unt-row unt-chip unt-card"
    + (UNT_VEH_CATS[cat] ? " veh" : cat === "squads" ? " inf" : "");
  if (it.sys === state.units.sel) row.classList.add("sel");
  row.dataset.sys = it.sys;
  row.title = it.sys + "\n" + (it.path || "");
  const img = document.createElement("img");
  img.className = "unt-chip-icon";
  img.draggable = false;
  img.loading = "lazy";
  img.alt = it.sys;
  if (typeof uprChipIcon === "function")
    uprChipIcon(img, row, it.sys, cat,
      { map: state.units.iconMap, ready: state.units.iconsReady });
  else if (typeof uprPlaceholderUrl === "function") {
    img.src = uprPlaceholderUrl(cat, it.sys) || "";
    if (!img.src) img.classList.add("noicon");
  } else img.classList.add("noicon");
  row.appendChild(img);
  const nm = document.createElement("span");
  nm.className = "unt-row-sys";
  nm.textContent = it.sys;
  row.appendChild(nm);
  const badge = document.createElement("span");
  badge.className = "unt-src-badge";
  badge.textContent = it.src || "basis";
  row.appendChild(badge);
  // Клик — выбор и тело; двойной клик и кнопка в теле — попап untEditUnit.
  row.addEventListener("click", ev => {
    ev.stopPropagation();
    untSelect(cat, it.sys);
  });
  row.addEventListener("dblclick", ev => {
    ev.stopPropagation();
    untEditUnit(cat, it.sys, row).catch(() => {});
  });
  row.addEventListener("contextmenu", e => untChipCtx(e, cat, it.sys));
  return row;
}

// Выбор строки: подсветка без полной перерисовки списка (иконки
// не перезапрашиваются) + перерисовка тела.
function untSelect(cat, sys) {
  if (!state.units) return;
  if (state.units.cat === cat && state.units.sel === sys) return;
  state.units.cat = cat;
  state.units.sel = sys;
  document.querySelectorAll("#unt-list .unt-row").forEach(r => {
    r.classList.toggle("sel", r.dataset.sys === sys);
  });
  untPaintDetail();
}

// Иконки текущего класса своим батчем (образец cmpEnsureIcons): имена без
// иконок — одним запросом /api/uprising_icons_data, затем только перерисовка
// списка (тело от иконок не зависит). Флаг готовности свой — uprIconsReady
// и uprIconMap карты не трогаем.
async function untEnsureIcons(cat) {
  if (!state.units) return;
  const my = ++state.units.iconSeq;
  const data = untCatData(cat);
  const map = state.units.iconMap || {};
  const names = (((data && data.items) || []).map(x => x.sys) || [])
    .filter(s => s && !map[s]);
  if (!names.length) {
    state.units.iconsReady = true;
    untPaintList();
    return;
  }
  state.units.iconsLoading = true;
  const root = untSrcRoot();
  try {
    const r = await api("/api/uprising_icons_data", { method: "POST",
      body: JSON.stringify({ root, names }), timeout: 60000 });
    const j = await r.json();
    if (my !== state.units.iconSeq) return;
    if (!state.units || state.units.cat !== cat) return;
    if (j && j.ok) {
      Object.assign(state.units.iconMap, j.icons || {});
      state.units.iconsReady = true;
      untPaintList();
    }
  } catch (e) { /* чипы добирают одиночными через uprChipIcon */ }
  finally {
    if (state.units && my === state.units.iconSeq) state.units.iconsLoading = false;
  }
}

// Тело справа: ВСЕ параметры выбранного юнита из species-строки без
// исключений (колонка: значение по всем колонкам файла, включая sysname).
// Строка читается из выигравшего файла витрины (basis/DLC-зеркало уже смёржено).
async function untPaintDetail() {
  const box = $("#unt-detail");
  if (!box || !state.units) return;
  const my = ++state.units.detSeq;
  const cat = state.units.cat;
  const sys = state.units.sel;
  box.innerHTML = "";
  const item = sys ? untFindItem(cat, sys) : null;
  if (!item) {
    const d = document.createElement("div");
    d.className = "swt-empty";
    d.textContent = t("cpg_pick") || t("unt_sub") || "";
    box.appendChild(d);
    return;
  }
  // Шапка тела: sysname + бейдж источника + кнопка «Редактировать».
  const head = document.createElement("div");
  head.className = "unt-detail-head";
  const nm = document.createElement("span");
  nm.className = "unt-detail-name";
  nm.textContent = item.sys;
  nm.title = item.path || "";
  head.appendChild(nm);
  const badge = document.createElement("span");
  badge.className = "unt-src-badge unt-detail-badge";
  badge.textContent = item.src || "basis";
  head.appendChild(badge);
  const editB = document.createElement("button");
  editB.type = "button";
  editB.className = "btn sm accent";
  editB.textContent = t("unt_edit") || "Редактировать";
  editB.onclick = ev => {
    ev.stopPropagation();
    untEditUnit(cat, item.sys, editB).catch(() => {});
  };
  head.appendChild(editB);
  head.oncontextmenu = e => untChipCtx(e, cat, item.sys);
  box.appendChild(head);
  const pathRow = document.createElement("div");
  pathRow.className = "unt-detail-path";
  pathRow.textContent = item.path || "";
  pathRow.title = item.path || "";
  box.appendChild(pathRow);
  // Параметры: читаем строку выигравшего файла (без побочных эффектов,
// как добор оверлеев в renderUnits).
  const got = await untReadRows(item.path);
  if (my !== state.units.detSeq || state.units.sel !== sys || state.units.cat !== cat)
    return;
  const data = untCatData(cat);
  const columns = (got && got.columns && got.columns.length)
    ? got.columns : ((data && data.columns) || []);
  let values = [];
  if (got) {
    const ri = untFindRow(got.rows, sys);
    if (ri !== -1) values = (got.rows[ri].values || []).slice();
  }
  const kv = document.createElement("div");
  kv.className = "unt-kv";
  columns.forEach((c, i) => {
    const r = document.createElement("div");
    r.className = "unt-kv-row";
    const k = document.createElement("span");
    k.className = "unt-kv-key";
    k.textContent = String(c);
    const v = document.createElement("span");
    v.className = "unt-kv-val";
    const s = (i < values.length && values[i] !== undefined && values[i] !== null)
      ? String(values[i]) : "";
    v.textContent = s;
    v.title = s;
    r.appendChild(k);
    r.appendChild(v);
    kv.appendChild(r);
  });
  box.appendChild(kv);
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

// Пачка правок ячеек одной записью истории (редактор и CRUD S6):
// cells = [{row, col, value, type?}] — строки species-файла, row включая шапку.
// path — ТОЛЬКО реальный путь из state.units.cats (на несуществующем пути
// бэкенд отвечает 500, а не JSON).
async function untWriteCells(path, cells, summary) {
  if (!path) {
    toast(t("unt_sub") || "error", "err");
    return { ok: false, error: "no path" };
  }
  try {
    const body = { path, cells: cells || [], save: true };
    if (summary) body.summary = String(summary).slice(0, 160);
    const r = await api("/api/edit_cells", { method: "POST",
      body: JSON.stringify(body) });
    const j = await r.json();
    if (!j || !j.ok) toast((j && j.error) || "error", "err");
    else {
      // Открытые вкладки-таблицы того же файла: подменить значения, иначе
      // таблица покажет старое до переоткрытия (образец uprSyncFileTabs).
      try {
        if (typeof syncFileTabsCells === "function" && j.changed)
          syncFileTabsCells(path, cells || [], 0);
      } catch (e) { /* таблица обновится при открытии */ }
    }
    return j;
  } catch (e) {
    toast(String((e && e.message) || e), "err");
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ==================== S6: редактор, CRUD, меню ====================
// Витрина читается мимо живых сессий (оверлеи — через /api/file без побочных
// эффектов): после каждой записи витрину категории перечитываем renderUnits(true).

// Данные категории из витрины (реальные пути!) или null.
function untCatData(cat) {
  const c = (state.units && state.units.cats) || {};
  return c[cat] || null;
}

// Элемент витрины {sys, src, path} или null.
function untFindItem(cat, sys) {
  const d = untCatData(cat);
  if (!d) return null;
  return (d.items || []).find(x => x.sys === sys) || null;
}

// Все sysname витрины (для проверки уникальности).
function untAllSys() {
  const out = new Set();
  const cats = (state.units && state.units.cats) || {};
  UNT_CATS.forEach(c => {
    ((cats[c] && cats[c].items) || []).forEach(x => { if (x.sys) out.add(x.sys); });
  });
  return out;
}

// Свободное имя на основе желаемого (суффиксы _2, _3, …).
function untUniqueSys(base) {
  const busy = untAllSys();
  let v = String(base || "unit_new").trim() || "unit_new";
  if (!busy.has(v)) return v;
  let n = 2;
  while (busy.has(v + "_" + n)) n++;
  return v + "_" + n;
}

// Индекс колонки по имени заголовка или -1.
function untColIdx(columns, name) {
  for (let i = 0; i < (columns || []).length; i++) {
    if (String(columns[i]).trim() === name) return i;
  }
  return -1;
}

// Строки species-файла чтением без побочных эффектов (образец добора оверлеев
// в renderUnits): {columns, rows} или null. rows включают шапку (индекс 0).
async function untReadRows(path) {
  if (!path) return null;
  try {
    const r = await api("/api/file?path=" + encodeURIComponent(path));
    const j = await r.json();
    if (!j || !j.ok || !Array.isArray(j.rows)) return null;
    return { columns: j.columns || [], rows: j.rows };
  } catch (e) { return null; }
}

// Индекс строки с sysname в rows (шапка и мусор пропускаются) или -1.
function untFindRow(rows, sys) {
  for (let i = 0; i < (rows || []).length; i++) {
    const vals = (rows[i] && rows[i].values) || [];
    const v = String(vals.length ? vals[0] : "").trim();
    if (untSysJunk(v)) continue;
    if (v === sys) return i;
  }
  return -1;
}

// Пути-кандидаты категории, где реально лежит строка sys: сначала basis,
// затем оверлеи (зеркало вниз: правка basis при дубле в DLC пишется в оба).
// Возвращает [{path, row, columns}] — только существующие файлы и строки.
async function untResolveTargets(cat, sys) {
  const d = untCatData(cat);
  if (!d) return [];
  const paths = [];
  if (d.path) paths.push(d.path);
  (d.overlays || []).forEach(p => { if (p && paths.indexOf(p) === -1) paths.push(p); });
  const it = untFindItem(cat, sys);
  if (it && it.path && paths.indexOf(it.path) === -1) paths.push(it.path);
  const out = [];
  for (const p of paths) {
    const got = await untReadRows(p);
    if (!got) continue;
    const ri = untFindRow(got.rows, sys);
    if (ri === -1) continue;
    const cols = (got.columns && got.columns.length) ? got.columns : (d.columns || []);
    out.push({ path: p, row: ri, columns: cols, values: (got.rows[ri].values || []).slice() });
  }
  return out;
}

// Текущий открытый элемент попапа-редактора (один за раз, как у кампании).
var untEditPopEl = null;

// Попап-редактор строки/чипа (образец cmpEditPop): sysname + поля класса из
// белых колонок _STAT_COLS, присутствующих в файле. Статы пишутся через
// /api/species_stat (первый файл со строкой — basis при дубле), затем зеркало
// вниз в DLC-копии через untWriteCells; переименование — батчем edit_cells по
// всем копиям (одна запись истории на файл). После — перечитать витрину.
async function untEditUnit(cat, sys, anchorEl) {
  if (untEditPopEl) { try { untEditPopEl.remove(); } catch (e) {} untEditPopEl = null; }
  const item = untFindItem(cat, sys);
  if (!item || !item.path) { toast(t("unt_sub") || "error", "err"); return; }
  const targets = await untResolveTargets(cat, sys);
  if (!targets.length) { toast(sys, "err"); return; }
  const base = targets[0];
  const cols = base.columns || [];
  // Редактируемые статы: белые колонки, реально существующие в файле.
  const statCols = UNT_STAT_COLS.filter(c => untColIdx(cols, c) !== -1);
  const curVal = c => {
    const ci = untColIdx(cols, c);
    return ci === -1 ? "" : String((base.values[ci] !== undefined && base.values[ci] !== null)
      ? base.values[ci] : "");
  };
  const pop = document.createElement("div");
  pop.className = "upr-edit-pop";
  const mkRow = (title, desc) => {
    const row = document.createElement("div");
    row.className = "upr-edit-row";
    const lab = document.createElement("div");
    lab.className = "upr-edit-lab";
    const b = document.createElement("b");
    b.textContent = title;
    const s = document.createElement("span");
    s.textContent = desc;
    lab.append(b, s);
    row.appendChild(lab);
    pop.appendChild(row);
    return row;
  };
  // Системное имя (переименование — батчем по всем копиям).
  const rowS = mkRow(t("upr_f_sysname") || "Системное имя", (cat || "") + ".xml");
  const nm = document.createElement("input");
  nm.type = "text";
  nm.className = "upr-chip-name";
  nm.value = sys;
  nm.spellcheck = false;
  rowS.appendChild(nm);
  try {
    if (typeof swtAutocomplete === "function")
      swtAutocomplete(nm, () => Array.from(untAllSys()),
        v => { nm.value = v; }, { openOnFocus: false });
  } catch (e) { /* без автокомплита тоже правится */ }
  // Поля класса + cost/cp_cost/supply_consumption/people_capacity/unit_set.
  const inputs = {};
  statCols.forEach(c => {
    const r = mkRow(c, (t("unt_class_" + cat) || cat) + " · " + ((item.src) || "basis"));
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "mini";
    inp.spellcheck = false;
    inp.value = curVal(c);
    // Класс техники — то же комбо, что в кампании и таблице.
    if (c === "unit_set" && typeof makeUnitSetCombo === "function"
        && typeof unitSetChoices === "function") {
      const hold = document.createElement("div");
      hold.className = "upr-edit-set";
      hold.appendChild(inp);
      try { makeUnitSetCombo(hold, inp, unitSetChoices([inp.value]), "unit_set"); }
      catch (e) { r.appendChild(inp); return; }
      r.appendChild(hold);
    } else r.appendChild(inp);
    inputs[c] = inp;
  });
  const btns = document.createElement("div");
  btns.className = "upr-edit-btns";
  const delB = document.createElement("button");
  delB.className = "btn sm danger";
  delB.textContent = t("unt_delete") || t("delete") || "Удалить";
  const canB = document.createElement("button");
  canB.className = "btn sm ghost";
  canB.textContent = t("cancel") || "Отмена";
  const okB = document.createElement("button");
  okB.className = "btn sm accent";
  okB.textContent = t("save") || "Сохранить";
  btns.append(delB, canB, okB);
  pop.appendChild(btns);
  // Позиция — у якоря (чипа), иначе по центру вьюпорта.
  document.body.appendChild(pop);
  untEditPopEl = pop;
  try {
    const vw = window.innerWidth, vh = window.innerHeight;
    pop.style.position = "fixed";
    pop.style.zIndex = 60;
    if (anchorEl && anchorEl.getBoundingClientRect) {
      const rc = anchorEl.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(rc.left, vw - pop.offsetWidth - 8)) + "px";
      pop.style.top = Math.max(8, Math.min(rc.bottom + 6, vh - pop.offsetHeight - 8)) + "px";
    } else {
      pop.style.left = Math.max(8, (vw - pop.offsetWidth) / 2) + "px";
      pop.style.top = Math.max(8, (vh - pop.offsetHeight) / 2) + "px";
    }
  } catch (e) { /* поверх всё равно видно */ }
  let closed = false;
  const close = () => {
    closed = true;
    document.removeEventListener("mousedown", outside, true);
    if (untEditPopEl === pop) untEditPopEl = null;
    try { pop.remove(); } catch (e) {}
  };
  const outside = e => {
    if (e.target.closest && (e.target.closest(".swt-ac-panel") ||
        e.target.closest(".unit-combo-pop"))) return;
    if (untEditPopEl === pop && !pop.contains(e.target)) close();
  };
  document.addEventListener("mousedown", outside, true);
  pop.addEventListener("mousedown", ev => ev.stopPropagation());
  delB.onclick = e => {
    e.stopPropagation();
    close();
    untDelUnit(cat, sys).catch(() => {});
  };
  canB.onclick = e => { e.stopPropagation(); close(); };
  okB.onclick = e => { e.stopPropagation(); commit().catch(() => {}); };
  [nm].concat(Object.keys(inputs).map(k => inputs[k])).forEach(el => {
    if (!el) return;
    el.addEventListener("keydown", ev => {
      if (ev.key === "Enter") { ev.preventDefault(); commit().catch(() => {}); }
      else if (ev.key === "Escape") { ev.preventDefault(); close(); }
    });
    el.addEventListener("mousedown", ev => ev.stopPropagation());
  });
  async function commit() {
    if (closed) return;
    const newSys = nm.value.trim();
    if (!newSys) { close(); return; }
    if (newSys !== sys && untAllSys().has(newSys)) {
      toast(newSys, "err");
      return;
    }
    // Изменившиеся статы (непустые и отличные от текущих).
    const diff = {};
    statCols.forEach(c => {
      const v = inputs[c].value.trim();
      if (v !== "" && v !== curVal(c)) diff[c] = v;
    });
    let ok = true;
    // Переименование — батчем по всем копиям (одна запись истории на файл).
    if (newSys !== sys) {
      for (const tg of targets) {
        const j = await untWriteCells(tg.path,
          [{ row: tg.row, col: 0, value: newSys, type: "String" }],
          sys + " → " + newSys);
        if (!j || !j.ok) ok = false;
      }
    }
    // Статы — через /api/species_stat (первый файл со строкой), затем зеркало
    // вниз в остальные копии (правка basis при дубле в DLC).
    const statNames = Object.keys(diff);
    if (statNames.length) {
      const effName = newSys;
      let sj = null;
      try {
        const r = await api("/api/species_stat", { method: "POST",
          body: JSON.stringify({ root: untSrcRoot(), cat,
            name: (newSys !== sys ? newSys : sys), stats: diff, save: true }) });
        sj = await r.json();
      } catch (e) { sj = null; }
      if (!sj || !sj.ok) {
        // species_stat не нашёл строку (переименование уже ушло вниз):
        // пишем статы напрямую батчем по копиям с новым именем.
        if (sj && sj.error === "no_such_unit") sj = null;
        else { toast((sj && sj.error) || "error", "err"); ok = false; }
      }
      if (sj && sj.ok) {
        if (sj.skipped && sj.skipped.length)
          toast((sj.path || "").split(/[\\/]/).pop() + ": " + sj.skipped.join(", "), "err");
        try {
          if (typeof syncFileTabsCells === "function" && sj.path)
            syncFileTabsCells(sj.path, sj.cells || [], 0);
        } catch (e) {}
        // Зеркало вниз: остальные копии с той же строкой.
        for (const tg of targets) {
          if (sj.path && tg.path === sj.path) continue;
          const fresh = await untReadRows(tg.path);
          if (!fresh) continue;
          const rcols = (fresh.columns && fresh.columns.length) ? fresh.columns : tg.columns;
          const ri = untFindRow(fresh.rows, effName);
          if (ri === -1) continue;
          const cells = [];
          statNames.forEach(c => {
            const ci = untColIdx(rcols, c);
            if (ci !== -1) cells.push({ row: ri, col: ci, value: diff[c] });
          });
          if (cells.length) {
            const mj = await untWriteCells(tg.path, cells, effName + " " + statNames[0]);
            if (!mj || !mj.ok) ok = false;
          }
        }
      } else if (sj === null && statNames.length) {
        // Запасной путь: пишем статы батчем напрямую по копиям.
        for (const tg of targets) {
          const cells = [];
          statNames.forEach(c => {
            const ci = untColIdx(tg.columns, c);
            if (ci !== -1) cells.push({ row: tg.row, col: ci, value: diff[c] });
          });
          if (cells.length) {
            const dj = await untWriteCells(tg.path, cells, effName + " " + statNames[0]);
            if (!dj || !dj.ok) ok = false;
          }
        }
      }
    }
    close();
    // Переименование ушло вниз — выбор едет на новое имя, иначе валидация
    // renderUnits сбросит тело на первую строку класса.
    if (newSys !== sys && state.units) state.units.sel = newSys;
    // Оверлеи читались мимо живых сессий — перечитать витрину категории.
    await renderUnits(true).catch(() => {});
    if (ok) toast(t("saved") || "Сохранено", "ok");
  }
  try { nm.focus(); nm.select(); } catch (e) {}
}

// Проверка связей squads→humans справочником /api/units_refs: предупреждает,
// каких sysname из строки нет среди известных (эвристика: числа пропускаем).
async function untCheckSquadRefs(values) {
  try {
    const r = await api("/api/units_refs", { method: "POST",
      body: JSON.stringify({ root: untSrcRoot(), src: state.treeView }) });
    const j = await r.json();
    if (!j || !j.ok) return;
    const known = new Set(j.names || []);
    const missing = [];
    (values || []).slice(1).forEach(v => {
      const s = String(v === undefined || v === null ? "" : v).trim();
      if (!s || /^-?\d+(\.\d+)?$/.test(s)) return;
      if (!known.has(s) && missing.indexOf(s) === -1) missing.push(s);
    });
    if (missing.length)
      toast("squads→humans: " + missing.slice(0, 5).join(", "), "err");
  } catch (e) { /* справочник необязателен */ }
}

// Добавление новой строки (клонированием Row — правило spreadsheet_ml, бэкенд
// /api/add_row): path — только реальный путь basis-файла категории из витрины.
// preset — готовые значения (вставка из буфера) или null (чистая строка).
async function untAddUnit(cat, preset) {
  const d = untCatData(cat);
  const path = d && d.path;
  if (!path) { toast(t("unt_sub") || "error", "err"); return null; }
  const width = Math.max((d.columns || []).length, 1);
  let vals = null;
  if (preset && preset.length) {
    vals = preset.slice(0, width);
    while (vals.length < width) vals.push("");
    vals[0] = untUniqueSys(String(vals[0] || "").trim() || "unit_new");
  } else {
    const v = await askPrompt({
      title: (t("unt_add") || "Добавить") + " · " + (t("unt_class_" + cat) || cat),
      value: untUniqueSys("unit_new"), placeholder: "sysname",
      okLabel: t("unt_add") || "Добавить",
    });
    if (v === null) return null;
    const name = String(v || "").trim();
    if (!name) return null;
    if (untAllSys().has(name)) { toast(name, "err"); return null; }
    vals = [name];
    while (vals.length < width) vals.push("");
  }
  let j = null;
  try {
    const r = await api("/api/add_row", { method: "POST",
      body: JSON.stringify({ path, values: vals, save: true }) });
    j = await r.json();
  } catch (e) { j = null; }
  if (!j || !j.ok) { toast((j && j.error) || "error", "err"); return null; }
  if (cat === "squads") await untCheckSquadRefs(vals, d.columns);
  // Выбор — на добавленную строку (валидация renderUnits его сохранит).
  if (state.units) { state.units.cat = cat; state.units.sel = vals[0]; }
  await renderUnits(true).catch(() => {});
  toast(t("saved") || "Сохранено", "ok");
  return vals[0];
}

// Удаление строки ВО ВСЕХ копиях (basis + DLC-оверлеи, зеркало вниз):
// одиночка с дублем sysname иначе всплывает обратно после перечитывания.
// Цели — через untResolveTargets (как untReplaceSys), подтверждение одно,
// сообщение перечисляет файлы-копии.
async function untDelUnit(cat, sys) {
  const item = untFindItem(cat, sys);
  if (!item || !item.path) { toast(t("unt_sub") || "error", "err"); return false; }
  const targets = await untResolveTargets(cat, sys);
  if (!targets.length) { toast(sys, "err"); return false; }
  const c = await askConfirm({
    title: (t("unt_delete") || "Удалить") + ": " + sys,
    message: targets.map(tg => tg.path).join("\n"),
    buttons: [
      { id: "ok", label: t("unt_delete") || t("delete") || "Удалить", kind: "danger" },
      { id: "cancel", label: t("cancel") || "Отмена", kind: "ghost" },
    ],
  });
  if (c !== "ok") return false;
  let ok = true;
  for (const tg of targets) {
    const got = await untReadRows(tg.path);
    if (!got) { ok = false; continue; }
    const ri = untFindRow(got.rows, sys);
    if (ri === -1) continue;
    let j = null;
    try {
      const r = await api("/api/delete_row", { method: "POST",
        body: JSON.stringify({ path: tg.path, row: ri, save: true }) });
      j = await r.json();
    } catch (e) { j = null; }
    if (!j || !j.ok) {
      toast((j && j.error) || tg.path, "err");
      ok = false;
    }
  }
  await renderUnits(true).catch(() => {});
  if (ok) toast(t("saved") || "Сохранено", "ok");
  return ok;
}

// Копировать/вырезать в буфер таба. Вырезание удаляет строку сразу (образец
// карты); значения резов храним в буфере, копии подтягиваем лениво при вставке.
async function untCopyUnit(cat, sys, cut) {
  const item = untFindItem(cat, sys);
  if (!item || !item.path) { toast(t("unt_sub") || "error", "err"); return; }
  const got = await untReadRows(item.path);
  if (!got) { toast(item.path, "err"); return; }
  const ri = untFindRow(got.rows, sys);
  if (ri === -1) { toast(sys, "err"); return; }
  const vals = (got.rows[ri].values || []).slice();
  if (!state.units) state.units = untFreshState();
  state.units.clip = { op: cut ? "cut" : "copy",
    items: [{ cat, sys, path: item.path, values: vals }] };
  if (cut) {
    let j = null;
    try {
      const r = await api("/api/delete_row", { method: "POST",
        body: JSON.stringify({ path: item.path, row: ri, save: true }) });
      j = await r.json();
    } catch (e) { j = null; }
    if (!j || !j.ok) {
      toast((j && j.error) || "error", "err");
      state.units.clip = null;
      return;
    }
    await renderUnits(true).catch(() => {});
  }
  toast(t("ctx_copied") || "Скопировано", "ok");
}

// Вставить буфер: targetCat — конкретная категория (меню чипа/категории) или
// null (меню сектора: каждый элемент в свою категорию). Имена уникализируем,
// ширину подгоняем под файл-приёмник, связи squads→humans проверяем.
async function untPasteClip(targetCat) {
  const clip = state.units && state.units.clip;
  const entries = (clip && clip.items) || [];
  if (!entries.length) return;
  let n = 0;
  for (const en of entries) {
    const tcat = targetCat || en.cat;
    const d = untCatData(tcat);
    const path = d && d.path;
    if (!path) continue;
    // Значения: срез при вырезании либо ленивое чтение копии-источника.
    let vals = (en.values || []).slice();
    if (!vals.length && en.path) {
      const got = await untReadRows(en.path);
      if (got) {
        const ri = untFindRow(got.rows, en.sys);
        if (ri !== -1) vals = (got.rows[ri].values || []).slice();
      }
    }
    if (!vals.length) {
      const w0 = Math.max((d.columns || []).length, 1);
      vals = [en.sys];
      while (vals.length < w0) vals.push("");
    }
    const width = Math.max((d.columns || []).length, 1);
    vals = vals.slice(0, width);
    while (vals.length < width) vals.push("");
    vals[0] = untUniqueSys(String(vals[0] || en.sys || "unit_new").trim() || "unit_new");
    let j = null;
    try {
      const r = await api("/api/add_row", { method: "POST",
        body: JSON.stringify({ path, values: vals, save: true }) });
      j = await r.json();
    } catch (e) { j = null; }
    if (!j || !j.ok) { toast((j && j.error) || "error", "err"); continue; }
    if (tcat === "squads") await untCheckSquadRefs(vals, d.columns);
    n++;
  }
  await renderUnits(true).catch(() => {});
  if (n) toast(t("saved") || "Сохранено", "ok");
}

// Очистка категории: удалить все строки категории (каждая — из своего файла).
async function untClearCat(cat) {
  const d = untCatData(cat);
  const items = ((d && d.items) || []).slice();
  if (!items.length) return;
  const c = await askConfirm({
    title: (t("unt_class_" + cat) || cat) + ": " + items.length,
    message: t("upr_sec_clear_m") || "Всё наполнение будет удалено.",
    buttons: [
      { id: "ok", label: t("delete") || "Удалить", kind: "danger" },
      { id: "cancel", label: t("cancel") || "Отмена", kind: "ghost" },
    ],
  });
  if (c !== "ok") return;
  // Пути группируем: строки одного файла удаляем снизу вверх (индексы не плывут).
  const byPath = new Map();
  items.forEach(it => {
    if (!it.path) return;
    if (!byPath.has(it.path)) byPath.set(it.path, []);
    byPath.get(it.path).push(it.sys);
  });
  for (const entry of byPath) {
    const path = entry[0];
    const got = await untReadRows(path);
    if (!got) continue;
    const rows = [];
    entry[1].forEach(sys => {
      const ri = untFindRow(got.rows, sys);
      if (ri !== -1) rows.push(ri);
    });
    rows.sort((a, b) => b - a);
    for (const ri of rows) {
      try {
        await api("/api/delete_row", { method: "POST",
          body: JSON.stringify({ path, row: ri, save: true }) });
      } catch (e) { /* пропускаем, идём дальше */ }
    }
  }
  await renderUnits(true).catch(() => {});
  toast(t("saved") || "Сохранено", "ok");
}

// Замена sysname (меню сектора): переименование батчем по всем копиям.
async function untReplaceSys() {
  const all = Array.from(untAllSys()).sort();
  if (!all.length) return;
  const old = await askPrompt({
    title: (t("unt_edit") || "Редактировать"),
    value: "", placeholder: all.slice(0, 8).join(", "),
    options: all, okLabel: t("unt_edit") || "Редактировать",
  });
  if (old === null) return;
  const from = String(old || "").trim();
  let cat = null, sys = from;
  UNT_CATS.forEach(c => { if (untFindItem(c, from)) cat = c; });
  if (!cat) { toast(from, "err"); return; }
  const nv = await askPrompt({
    title: from + " → ?",
    value: untUniqueSys(from + "_2"), placeholder: "sysname",
    okLabel: t("save") || "Сохранить",
  });
  if (nv === null) return;
  const to = String(nv || "").trim();
  if (!to || untAllSys().has(to)) { toast(to || from, "err"); return; }
  const targets = await untResolveTargets(cat, sys);
  if (!targets.length) { toast(sys, "err"); return; }
  let ok = true;
  for (const tg of targets) {
    const j = await untWriteCells(tg.path,
      [{ row: tg.row, col: 0, value: to, type: "String" }], sys + " → " + to);
    if (!j || !j.ok) ok = false;
  }
  await renderUnits(true).catch(() => {});
  if (ok) toast(t("saved") || "Сохранено", "ok");
}

// Меню чипа (образец uprChipCtx): добавить/править/копировать/вырезать/
// удалить/вставить + открыть в таблице.
function untChipCtx(e, cat, sys) {
  const hasClip = !!((state.units && state.units.clip && state.units.clip.items || []).length);
  openCtxMenu(e, [
    { label: t("unt_add") || "Добавить", icon: "add",
      fn: () => { untAddUnit(cat).catch(() => {}); } },
    { label: t("unt_edit") || "Редактировать", icon: "edit",
      fn: () => { untEditUnit(cat, sys, null).catch(() => {}); } },
    { label: t("unt_copy") || "Копировать", icon: "copy",
      fn: () => { untCopyUnit(cat, sys, false).catch(() => {}); } },
    { label: t("ctx_cut") || "Вырезать", icon: "cut",
      fn: () => { untCopyUnit(cat, sys, true).catch(() => {}); } },
    { sep: true },
    { label: t("unt_delete") || "Удалить", icon: "delete", danger: true,
      fn: () => { untDelUnit(cat, sys).catch(() => {}); } },
    { label: t("unt_paste") || "Вставить", icon: "paste", disabled: !hasClip,
      fn: () => { untPasteClip(cat).catch(() => {}); } },
    { sep: true },
    { label: t("upr_open_grid") || "Открыть в таблице", icon: "grid",
      fn: () => {
        const it = untFindItem(cat, sys);
        if (it && it.path && typeof openFile === "function") openFile(it.path);
      } },
  ]);
}

// Меню категории (фон ряда/заголовок): добавить, копировать всё, вставить, очистить.
function untCatCtx(e, cat) {
  const d = untCatData(cat);
  const n = ((d && d.items) || []).length;
  const hasClip = !!((state.units && state.units.clip && state.units.clip.items || []).length);
  openCtxMenu(e, [
    { label: t("unt_add") || "Добавить", icon: "add",
      fn: () => { untAddUnit(cat).catch(() => {}); } },
    { label: t("unt_copy") || "Копировать", icon: "copy", disabled: !n,
      fn: () => {
        if (!state.units) state.units = untFreshState();
        state.units.clip = { op: "copy",
          items: (d.items || []).map(x => ({ cat, sys: x.sys, path: x.path })) };
        toast(t("ctx_copied") || "Скопировано", "ok");
      } },
    { label: t("unt_paste") || "Вставить", icon: "paste", disabled: !hasClip,
      fn: () => { untPasteClip(cat).catch(() => {}); } },
    { sep: true },
    { label: t("upr_sec_clear") || "Очистить", icon: "delete", danger: true, disabled: !n,
      fn: () => { untClearCat(cat).catch(() => {}); } },
  ]);
}

// Меню сектора (образец uprSectorCtx): заменить/копировать/вставить/очистить.
function untSecCtx(e) {
  const cats = (state.units && state.units.cats) || {};
  let total = 0;
  UNT_CATS.forEach(c => { total += ((cats[c] && cats[c].items) || []).length; });
  const hasClip = !!((state.units && state.units.clip && state.units.clip.items || []).length);
  openCtxMenu(e, [
    { label: t("unt_edit") || "Редактировать", icon: "swap", disabled: !total,
      fn: () => { untReplaceSys().catch(() => {}); } },
    { label: t("unt_copy") || "Копировать", icon: "copy", disabled: !total,
      fn: () => {
        if (!state.units) state.units = untFreshState();
        const items = [];
        UNT_CATS.forEach(c => {
          (((cats[c] || {}).items) || []).forEach(x =>
            items.push({ cat: c, sys: x.sys, path: x.path }));
        });
        state.units.clip = { op: "copy", items };
        toast(t("ctx_copied") || "Скопировано", "ok");
      } },
    { label: t("unt_paste") || "Вставить", icon: "paste", disabled: !hasClip,
      fn: () => { untPasteClip(null).catch(() => {}); } },
    { sep: true },
    { label: t("upr_sec_clear") || "Очистить", icon: "delete", danger: true, disabled: !total,
      fn: async () => {
        const c = await askConfirm({
          title: (t("unt_pool_all") || "Общий пул") + ": " + total,
          message: t("upr_sec_clear_m") || "Всё наполнение будет удалено.",
          buttons: [
            { id: "ok", label: t("delete") || "Удалить", kind: "danger" },
            { id: "cancel", label: t("cancel") || "Отмена", kind: "ghost" },
          ],
        });
        if (c !== "ok") return;
        for (const cat of UNT_CATS) {
          const d = cats[cat];
          if (!((d && d.items) || []).length) continue;
          const byPath = new Map();
          d.items.forEach(it => {
            if (!it.path) return;
            if (!byPath.has(it.path)) byPath.set(it.path, []);
            byPath.get(it.path).push(it.sys);
          });
          for (const entry of byPath) {
            const got = await untReadRows(entry[0]);
            if (!got) continue;
            const rows = [];
            entry[1].forEach(sys => {
              const ri = untFindRow(got.rows, sys);
              if (ri !== -1) rows.push(ri);
            });
            rows.sort((a, b) => b - a);
            for (const ri of rows) {
              try {
                await api("/api/delete_row", { method: "POST",
                  body: JSON.stringify({ path: entry[0], row: ri, save: true }) });
              } catch (ex) { /* пропускаем, идём дальше */ }
            }
          }
        }
        await renderUnits(true).catch(() => {});
        toast(t("saved") || "Сохранено", "ok");
      } },
  ]);
}
