/* TerminatorToolSet frontend — units.js: вкладка «Редактор юнитов» (S5+S6).
   Классический скрипт, общий глобальный скоуп, порядок загрузки — FILES в templates/index.html.
   S5: чтение и витрина (слои, шапка). S6: попап-редактор, CRUD, контекстные меню. */
// Категории-классы вкладки: пять species-файлов. Пехоты (humans) здесь нет —
// это не юниты, а солдаты внутри отрядов (связи squads→humans проверяет
// untCheckSquadRefs справочником). Порядок — как найм в кампании: сначала
// отряды и техника, затем предметы.
var UNT_CATS = ["squads", "cars", "tanks", "helicopters", "inventory_items"];
// Иконки классов — РОВНО как заголовки секций кампании (CMP_CAT_ICONS,
// campaign.js): infantry/light_vehicle/tank/heli/supply_vehicle из
// assets/campaign/UnitSet.
var UNT_CAT_ICONS = {
  squads: "infantry.webp",
  cars: "light_vehicle.webp",
  tanks: "tank.webp",
  helicopters: "heli.webp",
  inventory_items: "supply_vehicle.webp",
};
function untCatIcon(cat) {
  return "/assets/campaign/UnitSet/" + (UNT_CAT_ICONS[cat] || "infantry.webp");
}
// Шеврон сворачивания — РОВНО как в SWT (swt.js:1239, swtItemCard:855).
var UNT_CHEV_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
// Иконки pill-кнопок «развернуть/свернуть всё» слоя: стрелки вниз
// (разложить) и вверх (сложить).
var UNT_ALL_EXPAND_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>';
var UNT_ALL_COLLAPSE_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
// Иконка кнопки разворота длинного значения в многострочное поле.
var UNT_EXPAND_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
// Иконка кнопки предпросмотра картинки поля (колонки image/pic).
var UNT_EYE_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
// Иконка кнопки 3D-превью модели (колонка mesh): куб.
var UNT_M3D_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7l8.7 5 8.7-5M12 22V12"/></svg>';
// Кнопка поля в стиле разворота: та же геометрия и то же место (справа
// от поля). title — ключ локали; новые кнопки по запросу — той же
// фабрикой, в тот же ряд после поля.
function untFieldBtn(svg, key) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "unt-kv-expand";
  const title = t(key);
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = svg;
  return b;
}
// Колонка картинки: имя содержит image или pic (hover_image_*,
// tech_pic, status_pic, garrison_pic).
function untIsPicCol(c) {
  return /(image|pic)/i.test(String(c || ""));
}
// Колонки-перечисления с выпадающим меню (как unit_set): unit_set и
// unit_class — проверенными наборами игры/мода из grid.js, экипаж —
// динамически из отрядов витрины (все слои), остальные очевидные
// (driving_class, category, проходимость, спрайт, защита, шасси, тип,
// уровни) — всеми встреченными значениями колонки в файле слоя.
// Крашеров (crusher_*/crushable_*) в меню нет — обычные поля.
// Ввод везде свободный.
var UNT_COMBO_COLS = ["unit_set", "unit_class", "driving_class", "category",
  "passable_type", "sprite_type", "defence", "chassis_type", "crew",
  "unit_type", "exp_levels"];
// Экипаж — динамическое меню из отрядов витрины (все слои: basis и DLC) +
// встреченное в файле (свой экипаж мода тоже попадает в список).
// Печать в поле фильтрует список (автозаполнение комбо).
function untCrewChoices(extraVals) {
  const seen = new Set();
  try {
    ((state.units && state.units.layers) || []).forEach(L => {
      (((L.cats || {}).squads || {}).items || []).forEach(x => {
        if (x && x.sys) seen.add(x.sys);
      });
    });
    (extraVals || []).forEach(v => {
      v = String(v ?? "").trim();
      if (v) seen.add(v);
    });
  } catch (e) { /* меню без значений */ }
  return [...seen].sort();
}
// Все значения колонки в файле слоя для меню (комментарии-строки мимо).
function untColValues(got, i) {
  const out = [];
  const seen = new Set();
  try {
    ((got && got.rows) || []).forEach(row => {
      const vs = (row && row.values) || [];
      const v = String(i < vs.length && vs[i] !== undefined && vs[i] !== null
        ? vs[i] : "").trim();
      if (!v || v.charAt(0) === "#" || seen.has(v)) return;
      seen.add(v);
      out.push(v);
    });
  } catch (e) { /* меню без значений файла */ }
  return out;
}
// {choices, title} меню колонки-перечисления либо null (обычное поле).
function untComboFor(c, fileVals) {
  const name = String(c || "");
  if (UNT_COMBO_COLS.indexOf(name) === -1) return null;
  try {
    if (name === "unit_set" && typeof unitSetChoices === "function")
      return { choices: unitSetChoices(fileVals), title: name };
    if (name === "unit_class" && typeof unitClassChoices === "function")
      return { choices: unitClassChoices(fileVals), title: name };
    if (name === "crew")
      return { choices: untCrewChoices(fileVals), title: name };
  } catch (e) { /* ниже — только значения файла */ }
  // Проверенного набора игры для колонки нет — только встреченные в файле;
  // меню из одного текущего значения не строим.
  const uniq = [...new Set((fileVals || []).map(v => String(v)))];
  if (uniq.length < 2) return null;
  return { choices: uniq.sort(), title: name };
}
// Тон слоя по имени DLC (подстрока, регистр не важен — папки называются
// вольно: Legion, "We are legion", Resistance, Evolution…): legion —
// красный, resistance — тёмно-оранжевый, evolution — фиолетовый (как SWT);
// basis — акцент. Списка DLC в коде нет: всё найденное в dlc/*/basis
// подхватывается слоями динамически, неизвестные — нейтрально (фиолет SWT).
function untLayerTone(L) {
  if (!L) return "";
  if (L.key === "basis") return "base";
  const s = ((L.label || "") + " " + (L.key || "")).toLowerCase();
  if (s.indexOf("legion") !== -1) return "legion";
  if (s.indexOf("resistance") !== -1) return "resistance";
  if (s.indexOf("evolution") !== -1) return "evolution";
  return "";
}
// Значок источника для шапок слоёв и типов — РОВНО значки вкладок дерева
// и таббара (FOLDER_SVG/GAMEPAD_SVG/MOD_SVG, grid.js): папка, геймпад, куб.
function untSrcBadge() {
  const v = (state && state.treeView) || "project";
  const el = document.createElement("span");
  el.className = "unt-src-ico unt-src-" + v;
  try {
    el.innerHTML = v === "game" ? GAMEPAD_SVG : v === "mod" ? MOD_SVG : FOLDER_SVG;
  } catch (e) { /* без иконки — только подпись в title */ }
  const lab = t("tree_tab_" + v) || v;
  el.title = lab;
  el.setAttribute("aria-label", lab);
  return el;
}
// Короткий путь слоя: последние 3 сегмента (.../basis/scripts/species).
function untShortPath(path) {
  const parts = String(path || "").split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return "";
  return parts.slice(-3).join("/");
}
// Первый путь файлов слоя для шапки (коротко).
function untLayerShortPath(L) {
  let p = "";
  UNT_CATS.forEach(cat => {
    if (!p && L && L.cats && L.cats[cat] && L.cats[cat].path)
      p = L.cats[cat].path;
  });
  return untShortPath(p);
}
// Иконки строк и тела — РОВНО чипы кампании (cmpChip, campaign.js):
// чистая иконка .upr-chip.upr-card + .upr-chip-icon, шильдик цены
// и декор слота vehDecor (без шильдика basis/DLC).

// Единственный дефолт состояния вкладки (старт + закрытие вкладки):
// layers = [{key:'basis'|'dlc:<Имя>', label, open, cats:{cat:{path, columns,
// items:[{sys, path}], _open}}}] — каждый слой хранит ТОЛЬКО строки своего
// файла (basis и DLC-оверлеи рядом, без слияния); src — источник загрузки,
// clip — буфер обмена таба {op, items:[{cat, sys, path, values?}]} или null,
// cat/sel/selLayer — выбранный юнит (тройка: слой, класс, sysname), один на
// вкладку; iconMap — свои иконки (sysname -> data-URL webp, НЕ карта uprising),
// iconsReady/iconsLoading/iconSeq — готовность/загрузка/поколение батча,
// поколение чтения тела — своё на каждой карточке (box.__detSeq, защита
// от гонки параллельных чтений строк).
function untFreshState() {
  return { src: "", layers: [], loading: false, loadSeq: 0, analyzing: false, clip: null,
    cat: "squads", sel: null, selLayer: null, iconMap: {}, iconsReady: false, iconsLoading: false,
    iconSeq: 0, prices: {}, stats: {}, pricesReady: false, pricesLoading: false,
    dirty: false, dirtyPaths: {}, redoHint: "" };
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

// Вкладка юнитов в таб-баре (дискета красится через неё).
function untTab() {
  try { return state.tabs.find(tb => tb.id === "units"); }
  catch (e) { return null; }
}
// Грязность страницы (образец uprMarkDirty/uprMarkClean): правка идёт
// в память — на вкладке красная дискета; явное сохранение гасит
// (таб-бар сам даёт зелёную вспышку).
function untMarkDirty(path) {
  if (!state.units) state.units = untFreshState();
  state.units.dirty = true;
  if (path) state.units.dirtyPaths[path] = true;
  const tb = untTab();
  if (tb && !tb.dirty) { tb.dirty = true; renderTabBar(); }
}
function untMarkClean() {
  if (state.units) { state.units.dirty = false; state.units.dirtyPaths = {}; }
  const tb = untTab();
  if (tb) { tb.dirty = false; tb.saved = true; renderTabBar(); }
}
// Файлы истории страницы — все species-файлы слоёв (basis + DLC-оверлеи):
// undo/redo берут файл с самой свежей записью, кнопки — ИЛИ.
function untHistPaths() {
  try {
    const out = [];
    const push = p => { if (p && out.indexOf(p) === -1) out.push(p); };
    ((state.units && state.units.layers) || []).forEach(L => {
      UNT_CATS.forEach(c => {
        const ld = ((L.cats || {})[c]) || {};
        push(ld.path);
        (((ld.items) || [])).forEach(x => { if (x) push(x.path); });
      });
    });
    return out;
  } catch (e) { return []; }
}
async function untSyncUndoButtons() {
  try {
    const rs = await Promise.all(untHistPaths().map(p =>
      api("/api/history?path=" + encodeURIComponent(p))
        .then(r => r.json()).catch(() => null)));
    setUndoRedoButtons(rs.some(j => j && j.ok && j.can_undo),
      rs.some(j => j && j.ok && j.can_redo));
  } catch (e) {}
}
// Перечитать витрину после undo/redo (dirty не трогаем: откат — тоже
// несохранённое изменение); кнопки — ИЛИ по всем файлам страницы.
async function untRepaintUndo() {
  await renderUnits(true).catch(() => {});
  await untSyncUndoButtons();
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
// Обновить — как кампания (#cmp-reload): досмотр недогруженных иконок
// на месте + добивка цен + перечитывание слоёв.
function setupUnits() {
  // реестр истории — здесь же (init бежит после всех скриптов): страница
  // в ядре undo/redo и журнала без правок history.js
  untRegisterHistPage();
  const rel = $("#unt-reload");
  if (rel) rel.onclick = () => {
    untReloadImages();
    untEnsurePrices().catch(() => {});
    renderUnits(true).catch(() => {});
  };
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
// Папка на диске бывает строчной (resistance) — чип показываем с заглавной.
function untDlcName(path) {
  const m = String(path || "").match(/dlc[\\/]+([^\\/]+)[\\/]+basis/i);
  const raw = (m && m[1]) || "DLC";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// Загрузка всех категорий через /api/units_list (api-хелпер из core.js):
// basis — ответом units_list, DLC-оверлеи — добором чтением файлов.
// Слои хранят ТОЛЬКО строки своего файла: basis-слой — базу, каждый
// DLC-слой — свой оверлей (один sysname виден в двух слоях, если файл
// оверлея его переопределяет — зеркало вниз чинится записью в оба).
// Оверлей загрузки вкладки — как cmpSetLoading/upr-loading у карт:
// затемнение + спиннер поверх витрины, пока слои читаются.
function untSetLoading(on) {
  const el = $("#unt-loading");
  if (el) el.hidden = !on;
}

async function renderUnits(force) {
  if (!state.units) state.units = untFreshState();
  if (state.units.loading && !force) return;
  const my = ++state.units.loadSeq;
  state.units.loading = true;
  untSetLoading(true);
  const fresh = () => my === state.units.loadSeq;
  const root = untSrcRoot();
  const src = state.treeView;
  const basisByCat = {};
  const ovByCat = {};
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
      basisByCat[cat] = { path: j.path || "", columns: j.columns || [],
        rows: j.rows || [] };
      for (const op of (j.overlays || [])) {
        if (!fresh()) return;
        try {
          const or = await api("/api/file?path=" + encodeURIComponent(op));
          const oj = await or.json();
          if (!oj || !oj.ok || !Array.isArray(oj.rows)) continue;
          if (!ovByCat[cat]) ovByCat[cat] = [];
          ovByCat[cat].push({ path: op, dlc: untDlcName(op),
            columns: oj.columns || [], rows: oj.rows || [] });
        } catch (e) { /* оверлей не прочитался — слоя не будет */ }
      }
    }
    if (!fresh()) return;
    // Порядок слоёв: basis, затем DLC по первому появлению в классах.
    const dlcOrder = [];
    UNT_CATS.forEach(cat => {
      (ovByCat[cat] || []).forEach(o => {
        if (dlcOrder.indexOf(o.dlc) === -1) dlcOrder.push(o.dlc);
      });
    });
    // Флаги раскрытия переживают перезагрузку (как condOpen/actOpen в SWT).
    const prev = new Map(((state.units && state.units.layers) || [])
      .map(L => [L.key, L]));
    const prevOpen = key => {
      const p = prev.get(key);
      return !p || p.open !== false;
    };
    const prevTypeOpen = (key, cat) => {
      const p = prev.get(key);
      const t = p && p.cats && p.cats[cat];
      return !t || t._open !== false;
    };
    // Строки файла в элементы слоя (дубли sysname внутри файла — первый).
    const mkItems = (rows, path) => {
      const out = [];
      (rows || []).forEach(row => {
        const sys = untRowSys(row);
        if (untSysJunk(sys) || out.some(x => x.sys === sys)) return;
        out.push({ sys, path: path || "" });
      });
      return out;
    };
    const layers = [];
    const basisL = { key: "basis", label: "basis", open: prevOpen("basis"), cats: {} };
    UNT_CATS.forEach(cat => {
      const b = basisByCat[cat];
      if (!b) return;
      basisL.cats[cat] = { path: b.path, columns: b.columns,
        items: mkItems(b.rows, b.path), _open: prevTypeOpen("basis", cat) };
    });
    layers.push(basisL);
    dlcOrder.forEach(dlc => {
      const key = "dlc:" + dlc;
      const L = { key, label: dlc, open: prevOpen(key), cats: {} };
      UNT_CATS.forEach(cat => {
        const o = (ovByCat[cat] || []).find(x => x.dlc === dlc);
        if (!o) return;
        L.cats[cat] = { path: o.path, columns: o.columns,
          items: mkItems(o.rows, o.path), _open: prevTypeOpen(key, cat) };
      });
      layers.push(L);
    });
    if (!prev.size) {
      // Первый вход на вкладку: всё сложено, кроме 3 верхних слоёв
      // (базовая игра и DLC-оверлеи); карточки типов сложены все.
      layers.forEach((L, i) => {
        L.open = i < 3;
        Object.keys((L && L.cats) || {}).forEach(c => {
          if (L.cats[c]) L.cats[c]._open = false;
        });
      });
    }
    // Смена источника — чужие иконки и тело недействительны; внутри одного
    // источника карту копим (батч добирает только недостающее, как кампания).
    const srcChanged = state.units.src !== src;
    state.units.src = src;
    state.units.layers = layers;
    if (srcChanged) {
      state.units.iconMap = {};
      state.units.iconsReady = false;
      state.units.prices = {};
      state.units.stats = {};
      state.units.pricesReady = false;
    }
    // Выбор — тройка (слой, класс, sysname): чиним класс на первый непустой
    // тип, sel сбрасываем только если строка пропала, иначе тело держит старое.
    if (!untLayerCatData(state.units.selLayer, state.units.cat) ||
        !untFindLayerItem(state.units.selLayer, state.units.cat, state.units.sel)) {
      state.units.sel = null;
      state.units.selLayer = null;
    }
    let catOk = false;
    layers.forEach(L => {
      if (((L.cats[state.units.cat] || {}).items || []).length) catOk = true;
    });
    if (!catOk) {
      const fst = untFirstSlot();
      state.units.cat = (fst && fst.cat) || "squads";
    }
    if (!state.units.sel) {
      const fst = untFirstSlot(state.units.cat);
      if (fst) {
        state.units.selLayer = fst.layerKey;
        state.units.sel = fst.sys;
      }
    }
    untPaintHeader(root, src);
    untPaint();
    // Иконки всех слоёв — своим батчем (карту uprising не трогаем);
    // цены (cost) — тем же /api/uprising_prices, что кампания.
    untEnsureIcons().catch(() => {});
    untEnsurePrices().catch(() => {});
    // Досмотр зависших иконок (рваный коннект без error): один проход
    // через 5с после отрисовки, как cmpImgSweepT у кампании.
    try {
      if (untImgSweepT) clearTimeout(untImgSweepT);
      untImgSweepT = setTimeout(() => { untImgSweepT = 0; untReloadImages(); }, 5000);
    } catch (e) {}
  } finally {
    if (fresh()) {
      state.units.loading = false;
      untSetLoading(false);
    }
  }
}

// Шапка после загрузки: путь корня в субтитле, кнопки видны при наличии данных.
function untPaintHeader(root, src) {
  const fp = $("#unt-file");
  if (fp) {
    const has = ((state.units && state.units.layers) || []).length > 0;
    fp.textContent = has && root ? root : (t("unt_sub") || "");
    fp.title = has && root ? root : "";
  }
  const has = ((state.units && state.units.layers) || []).length > 0;
  ["#unt-reload", "#unt-analyze", "#unt-open-grid", "#unt-fs"].forEach(s => {
    const el = $(s);
    if (el) el.hidden = !has;
  });
  try {
    if (typeof paintSrcSwitches === "function") paintSrcSwitches();
  } catch (e) { /* переключатели красит древо */ }
}

// Витрина в три уровня по структуре SWT-редактора:
// уровень 1 — слои-источники (basis + DLC-оверлеи), каждый — collapsible-
// секция РОВНО классами SWT (swt-sec-head/swt-sec-closed/swt-sec-chev/
// swt-sec-body, образец mkSec в swt.js:1221-1250);
// уровень 2 — типы внутри слоя, каждый — карточка РОВНО классами SWT
// (swt-item/swt-item-closed/swt-item-head/swt-item-chev/swt-item-body,
// образец swtItemCard/swtApplyItemOpen в swt.js:834-1026);
// уровень 3 — внутри тела карточки типа: master-detail (слева чипы найма
// кампании, справа тело параметров) без изменений логики.
function untPaint() {
  const main = $("#unt-main");
  if (!main) return;
  main.innerHTML = "";
  // ПКМ по пустому месту вкладки — меню сектора (весь пул).
  main.oncontextmenu = e => {
    if (e.target === main) untSecCtx(e);
  };
  const layers = (state.units && state.units.layers) || [];
  const total = layers.reduce((a, L) => a + untLayerTotal(L), 0);
  if (!total) {
    const d = document.createElement("div");
    d.className = "tree-empty";
    d.textContent = t("unt_sub") || "";
    main.appendChild(d);
    return;
  }
  layers.forEach(L => {
    if (!untLayerTotal(L)) return;
    const sec = untLayerSec(L);
    main.appendChild(sec.headEl);
    main.appendChild(sec.bodyEl);
    UNT_CATS.forEach(cat => {
      const data = (L.cats || {})[cat];
      if (!data || !((data.items || []).length)) return;
      sec.bodyEl.appendChild(untTypeCard(L, cat, data));
    });
  });
}

// Сводка слоя: сколько юнитов всего.
function untLayerTotal(L) {
  let n = 0;
  UNT_CATS.forEach(cat => {
    n += ((((L && L.cats) || {})[cat] || {}).items || []).length;
  });
  return n;
}

// Секция слоя — механика mkSec (swt.js:1221-1250): шапка
// .swt-sec-head (+.swt-sec-closed), шеврон-кнопка .swt-sec-chev, тело
// .swt-sec-body; флаг раскрытия — L.open; клик по шапке — тоггл.
// Шапка слоя: [шеврон] [чип Base Game / имя DLC] [короткий путь] [счётчик]
// [иконка источника Проект|Игра|Мод]. Кнопок «развернуть/свернуть всё» нет.
// Базовая игра — акцентная полоса (.unt-layer-base), DLC — фиолетовая SWT.
function untLayerSec(L) {
  let open = L.open !== false;
  const isBase = L.key === "basis";
  const tone = untLayerTone(L);
  const headEl = document.createElement("div");
  headEl.className = "swt-sec-head unt-layer-head" + (open ? "" : " swt-sec-closed")
    + (tone ? " unt-layer-" + tone : "");
  headEl.dataset.layer = L.key;
  const chev = document.createElement("button");
  chev.className = "icon-btn swt-sec-chev";
  const bodyEl = document.createElement("div");
  bodyEl.className = "swt-sec-body";
  const apply = () => {
    headEl.classList.toggle("swt-sec-closed", !open);
    bodyEl.hidden = !open;
    chev.title = open ? (t("swt_collapse") || "Свернуть")
                      : (t("swt_expand") || "Развернуть");
  };
  const flip = () => {
    open = !open;
    L.open = open;
    apply();
  };
  chev.innerHTML = UNT_CHEV_SVG;
  chev.onclick = e => { e.stopPropagation(); flip(); };
  const chip = document.createElement("span");
  chip.className = "unt-layer-chip" + (tone ? " unt-layer-chip-" + tone : "");
  chip.textContent = isBase ? "Base Game" : (L.label || L.key);
  chip.title = isBase ? "Base Game" : (L.label || L.key);
  headEl.append(chev, chip);
  // Счётчик и иконка — слева вплотную к чипу, путь — вправо во всю
  // оставшуюся ширину (flex:1 в CSS).
  const sum = document.createElement("span");
  sum.className = "unt-layer-sum";
  sum.textContent = "· " + untLayerTotal(L);
  sum.title = chip.textContent;
  headEl.appendChild(sum);
  headEl.appendChild(untSrcBadge());
  const short = untLayerShortPath(L);
  if (short) {
    const p = document.createElement("span");
    p.className = "unt-layer-path";
    p.textContent = short;
    p.title = short;
    headEl.appendChild(p);
  }
  // Pill «развернуть/свернуть всё» — в правом крайнем углу шапки, только
  // на свои подменю (карточки типов этого слоя).
  headEl.appendChild(untLayerAllWrap(L, bodyEl));
  headEl.addEventListener("click", e => {
    if (e.target.closest("input, select, button, label, .swt-cmd-combo")) return;
    flip();
  });
  // ПКМ по шапке слоя — меню слоя (копировать/вставить/очистить слой).
  headEl.addEventListener("contextmenu", e => untLayerCtx(e, L.key));
  apply();
  return { headEl, bodyEl };
}

// Pill «развернуть/свернуть всё» слоя: две кнопки в одну линию на одном
// уровне; действуют только на карточки типов СВОЕГО слоя (флаги _open +
// синхронизация открытых карточек через card.__item, без перерисовки).
function untLayerAllWrap(L, bodyEl) {
  const wrap = document.createElement("span");
  wrap.className = "unt-all-wrap";
  const mk = expand => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "unt-all-btn";
    b.title = expand ? (t("swt_expand_all") || "Развернуть все")
                     : (t("swt_collapse_all") || "Свернуть все");
    b.setAttribute("aria-label", b.title);
    b.innerHTML = expand ? UNT_ALL_EXPAND_SVG : UNT_ALL_COLLAPSE_SVG;
    b.onclick = e => {
      e.stopPropagation();
      UNT_CATS.forEach(cat => {
        const data = (L.cats || {})[cat];
        if (data) data._open = expand;
      });
      if (bodyEl) bodyEl.querySelectorAll(".swt-item").forEach(c => {
        if (c.__item) untApplyTypeOpen(c, c.__item);
      });
    };
    return b;
  };
  wrap.append(mk(true), mk(false));
  return wrap;
}

// Применение флага раскрытия карточки типа — РОВНО swtApplyItemOpen
// (swt.js:834-842): класс .swt-item-closed + hidden тела + подсказка шеврона.
function untApplyTypeOpen(card, data) {
  const o = !!data._open;
  card.classList.toggle("swt-item-closed", !o);
  const body = card.querySelector(".swt-item-body");
  if (body) body.hidden = !o;
  const chev = card.querySelector(".swt-item-chev");
  if (chev) chev.title = o ? (t("swt_collapse") || "Свернуть")
                           : (t("swt_expand") || "Развернуть");
}

// Карточка типа внутри слоя — механика swtItemCard (swt.js:844-954):
// .swt-item (+.swt-item-closed), шапка .swt-item-head (шеврон .swt-item-chev,
// иконка класса, название, счётчик, иконка источника), тело .swt-item-body.
// Иконка класса — РОВНО файлы кампании (UNT_CAT_ICONS, как CMP_CAT_ICONS).
// Базовая игра — акцентная полоса (.unt-type-base), DLC — родной accent SWT.
function untTypeCard(L, cat, data) {
  const tone = untLayerTone(L);
  const card = document.createElement("div");
  card.className = "swt-item unt-type-card" + (data._open ? "" : " swt-item-closed")
    + (tone ? " unt-type-" + tone : "");
  card.__item = data;
  card.dataset.layer = L.key;
  card.dataset.cat = cat;
  const head = document.createElement("div");
  head.className = "swt-item-head unt-type-head";
  const chev = document.createElement("button");
  chev.className = "icon-btn swt-item-chev";
  chev.title = data._open ? (t("swt_collapse") || "Свернуть")
                          : (t("swt_expand") || "Развернуть");
  chev.innerHTML = UNT_CHEV_SVG;
  chev.onclick = e => {
    e.stopPropagation();
    data._open = !data._open;
    untApplyTypeOpen(card, data);
  };
  const label = t("unt_class_" + cat) || cat;
  const ico = document.createElement("img");
  ico.className = "unt-type-icon";
  ico.src = untCatIcon(cat);
  ico.alt = label;
  ico.draggable = false;
  ico.onerror = () => {
    try {
      const fb = document.createElement("span");
      fb.className = "unt-type-icon-fb";
      fb.textContent = label.slice(0, 1).toUpperCase();
      ico.replaceWith(fb);
    } catch (e) { /* оставили битую иконку */ }
  };
  const nm = document.createElement("span");
  nm.className = "unt-type-name";
  nm.textContent = label;
  nm.title = label;
  const cnt = document.createElement("span");
  cnt.className = "unt-type-count";
  cnt.textContent = "· " + ((data.items || []).length);
  head.append(chev, ico, nm, cnt);
  head.appendChild(untSrcBadge());
  head.addEventListener("click", e => {
    // клик по свободному месту шапки тоже сворачивает карточку
    if (e.target.closest("input, select, button, label")) return;
    data._open = !data._open;
    untApplyTypeOpen(card, data);
  });
  // ПКМ по шапке — меню категории слоя (как было по шапке списка).
  head.addEventListener("contextmenu", e => untCatCtx(e, L.key, cat));
  card.appendChild(head);
  const body = document.createElement("div");
  body.className = "swt-item-body";
  if (!data._open) body.hidden = true;
  // Уровень 3 — master-detail как боковая панель кампании: слева список
  // чипов (сетка кампании), справа тело параметров; между ними ресайзер
  // ширины списка (клон cmp-resizer).
  const wrap = document.createElement("div");
  wrap.className = "unt-wrap";
  const pane = document.createElement("div");
  pane.className = "unt-list-pane";
  try {
    const w = parseInt(localStorage.getItem("tsh_unt_list_w") || "0", 10);
    if (w >= 200 && w <= 700) pane.style.flex = "0 0 " + w + "px";
  } catch (e) { /* дефолт из CSS */ }
  const list = document.createElement("div");
  list.className = "upr-cat-body unt-list";
  list.dataset.layer = L.key;
  list.dataset.cat = cat;
  // ПКМ по пустому месту ряда — меню категории слоя.
  list.oncontextmenu = e => {
    if (e.target === list) untCatCtx(e, L.key, cat);
  };
  pane.appendChild(list);
  const rz = document.createElement("button");
  rz.className = "unt-resizer";
  rz.type = "button";
  rz.title = t("cmp_resizer_reset") || "";
  untBindResizer(rz, pane);
  const detail = document.createElement("div");
  detail.className = "unt-detail";
  detail.dataset.layer = L.key;
  detail.dataset.cat = cat;
  wrap.appendChild(pane);
  wrap.appendChild(rz);
  wrap.appendChild(detail);
  body.appendChild(wrap);
  card.appendChild(body);
  untPaintTypeList(list);
  untPaintTypeDetail(detail);
  return card;
}

// Ресайзер ширины списка чипов — клон cmp-resizer (campaign.js):
// тяга ставит фикс поверх дефолта, даблклик сбрасывает к дефолту CSS.
function untBindResizer(rz, pane) {
  if (!rz || !pane) return;
  rz.addEventListener("dblclick", () => {
    pane.style.flex = "";
    try { localStorage.removeItem("tsh_unt_list_w"); } catch (e) {}
  });
  rz.addEventListener("mousedown", e => {
    if (e.button !== 0) return;
    e.preventDefault();
    document.body.classList.add("unt-resizing");
    const startX = e.clientX;
    const startW = pane.getBoundingClientRect().width;
    const move = ev => {
      const nw = Math.min(700, Math.max(200, startW + (ev.clientX - startX)));
      pane.style.flex = "0 0 " + Math.round(nw) + "px";
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("unt-resizing");
      try {
        localStorage.setItem("tsh_unt_list_w",
          String(Math.round(pane.getBoundingClientRect().width)));
      } catch (ex) {}
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

// Первый непустой слот (слой, класс, sysname): optCat ограничивает классом.
// Порядок — basis первым, классы — порядком UNT_CATS.
function untFirstSlot(optCat) {
  const layers = (state.units && state.units.layers) || [];
  const cats = optCat ? [optCat] : UNT_CATS;
  for (const L of layers) {
    for (const cat of cats) {
      const items = (((L.cats || {})[cat] || {}).items) || [];
      if (items.length) return { layerKey: L.key, cat, sys: items[0].sys };
    }
  }
  return null;
}

// Список юнитов карточки типа — РОВНО ряд найма кампании
// (campaign.js:810-839): чипы + кнопка «+» последней в ряду.
// Выбор — клик, меню — правая кнопка
// (чип — untChipCtx, пустое место ряда — untCatCtx); попапа нет.
function untPaintTypeList(list) {
  if (!list) return;
  const st = list.scrollTop;
  const layerKey = list.dataset.layer;
  const cat = list.dataset.cat;
  list.innerHTML = "";
  const data = untLayerCatData(layerKey, cat);
  const items = ((data && data.items) || []).slice();
  items.forEach(it => list.appendChild(untRow(layerKey, it, cat)));
  // Плюс последним в ряду — как .upr-chip-add на карте Uprising и в кампании.
  const add = document.createElement("button");
  add.className = "upr-chip-add";
  add.title = t("unt_add") || "Добавить";
  add.setAttribute("aria-label", t("unt_add") || "Добавить");
  const addImg = document.createElement("img");
  addImg.className = "upr-chip-add-icon";
  addImg.src = "/assets/UprisingMap/add_unit.webp";
  addImg.alt = "";
  addImg.draggable = false;
  add.appendChild(addImg);
  if (typeof uprAddBtn === "function") uprAddBtn(add, addImg);
  add.onclick = ev => {
    ev.stopPropagation();
    untAddUnit(cat, null, layerKey).catch(() => {});
  };
  list.appendChild(add);
  list.scrollTop = st;
}

// Все списки вкладки (после батча иконок): скролл каждого сохраняем.
function untPaintAllLists() {
  document.querySelectorAll("#unt-main .unt-list").forEach(untPaintTypeList);
}

// Чип списка — РОВНО чип кампании (cmpChip, campaign.js:901-969):
// чистая иконка .upr-chip.upr-card + .upr-chip-icon через общий хелпер
// карты (мгновенный плейсхолдер категории + спиннер upr-loading +
// подмена реальной из СВОЕЙ карты state.units.iconMap — карту uprising
// не трогаем), шильдик цены .cmp-price-badge (монетка + cost) и декор
// слота vehDecor (подложка unitslot, sysname, полоса мест 0/N у техники,
// численность N/N у отрядов). Своё здесь только состояние списка:
// .unt-row/.sel/dataset.sys. Шильдика basis/DLC на иконках нет.
// Имя — только в подсказке (sysname + цена + путь).
function untRow(layerKey, it, cat) {
  const row = document.createElement("span");
  // Рамки выделения на юнитах нет: выбранный виден только в теле справа.
  row.className = "upr-chip upr-card unt-row";
  row.dataset.sys = it.sys;
  row.dataset.layer = layerKey || "";
  row.dataset.cat = cat;
  const pv = untPrice(cat, it.sys);
  const dn = (typeof uprUnitName === "function") ? uprUnitName(it.sys) : it.sys;
  // Подсказка чипа — только имя и цена, без пути файла.
  row.title = (dn !== it.sys ? dn + "\n" : "") + it.sys
    + (pv === "" ? "" : "\n" + (t("cpg_cost") || "Cost") + ": " + pv);
  const img = document.createElement("img");
  img.className = "upr-chip-icon";
  img.draggable = false;
  img.loading = "lazy";
  img.alt = "";
  // спиннером владеет общий хелпер uprChipIcon (ставит только при реальном
  // ожидании иконки) — без дубля здесь, иначе мигание при каждом рендере
  if (typeof uprChipIcon === "function")
    uprChipIcon(img, row, it.sys, cat,
      { map: state.units.iconMap, ready: state.units.iconsReady });
  else if (typeof uprIconUrl === "function") img.src = uprIconUrl(it.sys, cat);
  if (img.complete && img.naturalWidth && typeof cmpSpanChip === "function")
    cmpSpanChip(row, img);
  row.appendChild(img);
  if (pv !== "") {
    const badge = document.createElement("span");
    badge.className = "cmp-price-badge";
    const coin = document.createElement("img");
    coin.className = "cmp-price-coin";
    coin.src = "/assets/campaign/glbmp_resource_goodwill_credits.webp";
    coin.alt = "";
    coin.draggable = false;
    const bt = document.createElement("span");
    bt.textContent = pv;
    badge.append(coin, bt);
    row.appendChild(badge);
  }
  // Подложка слота + sysname + полоса вместимости — как найм кампании.
  if (typeof vehDecor === "function") vehDecor(row, it.sys, cat, untSrcRoot());
  // Клик — выбор и тело; попапа редактирования нет (всё правится в теле);
  // ПКМ — меню чипа (добавить/копировать/вырезать/удалить/вставить/таблица).
  row.addEventListener("click", ev => {
    ev.stopPropagation();
    untSelect(layerKey, cat, it.sys);
  });
  row.addEventListener("contextmenu", e => untChipCtx(e, layerKey, cat, it.sys));
  // подсветка перехода «Расширенные» (untOpenUnit): переживает перерисовки
  // списков — батч иконок пересоздаёт чипы, метка живёт в state до сброса
  const fl = state.units && state.units.flashSys;
  if (fl && fl.layer === layerKey && fl.cat === cat && fl.sys === it.sys) {
    row.classList.add("unt-row-flash");
    setTimeout(() => { try { row.classList.remove("unt-row-flash"); } catch (e) {} }, 3000);
  }
  return row;
}

// Цена юнита (колонка cost) — свой кэш через тот же /api/uprising_prices,
// что кампания (cmpLoadMeta): read-only шильдик на чипе, записи нет.
function untPrice(cat, name) {
  try {
    const v = ((state.units.prices || {})[cat] || {})[name || ""];
    return (v === undefined || v === null) ? "" : String(v).trim();
  } catch (e) { return ""; }
}
async function untEnsurePrices() {
  if (!state.units || state.units.pricesLoading || state.units.pricesReady) return;
  const root = untSrcRoot();
  if (!root) return;
  state.units.pricesLoading = true;
  try {
    const r = await api("/api/uprising_prices", { method: "POST",
      body: JSON.stringify({ root }) });
    const j = await r.json();
    if (!state.units) return;
    if (j && j.ok) {
      state.units.prices = j.prices || {};
      state.units.stats = j.stats || {};
      state.units.pricesReady = true;
      untPaintAllLists();
    }
  } catch (e) { /* чипы живут без цен */ }
  finally {
    if (state.units) state.units.pricesLoading = false;
  }
}

// Выбор чипа: тройка (слой, класс, sysname) — одна на вкладку; чипы не
// трогаем вообще (рамок выделения и подмены selected-иконки нет —
// selected-пара могла быть другого размера и «сжимала» иконку),
// перерисовываем только тела карточек (тело показывает только свой слот).
function untSelect(layerKey, cat, sys) {
  if (!state.units) return;
  if (state.units.selLayer === layerKey && state.units.cat === cat
      && state.units.sel === sys) return;
  state.units.selLayer = layerKey;
  state.units.cat = cat;
  state.units.sel = sys;
  document.querySelectorAll("#unt-main .unt-detail").forEach(untPaintTypeDetail);
}

// Переход из попапа карт («Расширенные» в cmpEditPop/uprEditPop): открыть
// вкладку, выбрать юнит, раскрыть его слой и категорию, докрутить список
// до чипа и подсветить вспышкой (как set-flash пути мода в настройках).
async function untOpenUnit(cat, sys) {
  if (!cat || !sys) return;
  try { await openUnits(); } catch (e) { return; }
  if (!state.units) return;
  // openUnits не ждёт загрузку — ждём готовых слоёв (с таймаутом)
  let guard = 0;
  while (state.units.loading && guard++ < 150) {
    await new Promise(r => setTimeout(r, 100));
  }
  if (!(state.units.layers || []).length) {
    try { await renderUnits(); } catch (e) { /* вкладка уже открыта */ }
  }
  const layers = state.units.layers || [];
  let layerKey = null;
  for (const L of layers) {
    let hit = null;
    try { hit = untFindLayerItem(L.key, cat, sys); } catch (e) { /* слой битый — дальше */ }
    if (hit) { layerKey = L.key; break; }
  }
  // юнита нет в редакторе (битый sysname на карте) — вкладка уже открыта,
  // молча выходим без выбора
  if (!layerKey) return;
  const L = layers.find(x => x.key === layerKey);
  const data = L && (L.cats || {})[cat];
  if (L) L.open = true;
  if (data) data._open = true;
  untPaint();
  untSelect(layerKey, cat, sys);
  // чип — перебором по dataset (sysname в селектор не экранируем)
  let list = null, row = null;
  document.querySelectorAll(".unt-list").forEach(li => {
    if (row || li.dataset.layer !== layerKey || li.dataset.cat !== cat) return;
    li.querySelectorAll(".unt-row").forEach(r => {
      if (!row && r.dataset.sys === sys) { list = li; row = r; }
    });
  });
  if (!row) return;
  row.classList.remove("unt-row-flash");
  void row.offsetWidth;   // перезапуск анимации при повторных кликах
  row.classList.add("unt-row-flash");
  // метка для untRow: батч иконок пересоздаёт чипы — вспышка должна
  // пережить перерисовки списков
  state.units.flashSys = { layer: layerKey, cat, sys };
  setTimeout(() => {
    try { row.classList.remove("unt-row-flash"); } catch (e) {}
    try { if (state.units) state.units.flashSys = null; } catch (e) {}
  }, 3000);
  // докрутка с повторами: в момент перехода иконки ещё не встали (lazy +
  // подмена реальной), геометрия списка плывёт — крутить надо и страницу,
  // и сам список, пока чип не окажется в зоне видимости обоих
  const scrollRow = () => {
    let box = null, lbox = null;
    try {
      if (!row.isConnected) return true;
      box = row.getBoundingClientRect();
      lbox = list.getBoundingClientRect();
    } catch (e) { return true; }
    const inList = box.top >= lbox.top - 4 && box.bottom <= lbox.bottom + 4;
    const inView = box.top >= 0 && box.bottom <= window.innerHeight;
    if (inList && inView) return true;
    try { row.scrollIntoView({ block: "center" }); } catch (e) { /* уже виден */ }
    return false;
  };
  scrollRow();
  try {
    requestAnimationFrame(() => {
      if (scrollRow()) return;
      setTimeout(scrollRow, 400);
      setTimeout(scrollRow, 1500);
    });
  } catch (e) { /* rAF недоступен — первый скролл уже сделан */ }
}

// Иконки всех слоёв своим батчем (образец cmpEnsureIcons): имена без
// иконок — одним запросом /api/uprising_icons_data, затем только перерисовка
// списков (тела от иконок не зависят). Флаг готовности свой — uprIconsReady
// и uprIconMap карты не трогаем.
async function untEnsureIcons() {
  if (!state.units) return;
  const my = ++state.units.iconSeq;
  const map = state.units.iconMap || {};
  const seen = new Set();
  const names = [];
  ((state.units && state.units.layers) || []).forEach(L => {
    UNT_CATS.forEach(cat => {
      ((((L.cats || {})[cat] || {}).items) || []).forEach(x => {
        if (x && x.sys && !map[x.sys] && !seen.has(x.sys)) {
          seen.add(x.sys);
          names.push(x.sys);
        }
      });
    });
  });
  if (!names.length) {
    state.units.iconsReady = true;
    if (typeof uprEnsureIconStates === "function") {
      try { uprEnsureIconStates(root, []); } catch (e) {}
    }
    untPaintAllLists();
    return;
  }
  state.units.iconsLoading = true;
  const root = untSrcRoot();
  try {
    const r = await api("/api/uprising_icons_data", { method: "POST",
      body: JSON.stringify({ root, names }), timeout: 60000 });
    const j = await r.json();
    if (my !== state.units.iconSeq) return;
    if (!state.units) return;
    if (j && j.ok) {
      Object.assign(state.units.iconMap, j.icons || {});
      state.units.iconsReady = true;
      // ховер/selected-пары иконок — тем же батчем, что карты.
      if (typeof uprEnsureIconStates === "function") {
        try { uprEnsureIconStates(root, names); } catch (e) {}
      }
      untPaintAllLists();
    }
  } catch (e) { /* чипы добирают одиночными через uprChipIcon */ }
  finally {
    if (state.units && my === state.units.iconSeq) state.units.iconsLoading = false;
  }
}

// Тело карточки типа: ВСЯ строка species-файла своего слоя без исключений
// (все колонки файла, кроме sysname — он правится полем в шапке рядом
// с иконкой) — каждый параметр сразу в своём поле ввода, кнопки
// «Редактировать» нет. Тело показывает только свой
// слот: если глобальный выбор (слой, класс, sysname) попал в эту карточку —
// разбор строки, иначе подсказка. Строка читается и пишется в файл своего
// слоя (basis или DLC-оверлей, без побочных эффектов и без зеркала вниз).
async function untPaintTypeDetail(box) {
  if (!box || !state.units) return;
  const layerKey = box.dataset.layer;
  const cat = box.dataset.cat;
  const mine = state.units.sel && state.units.selLayer === layerKey
    && state.units.cat === cat;
  // Поколение чтения — своё на каждую карточку: общий счётчик на вкладку
  // гасил все тела, кроме последнего (параллельные чтения строк), и тело
  // показывало только иконку без параметров.
  box.__detSeq = (box.__detSeq || 0) + 1;
  const my = box.__detSeq;
  const sys = mine ? state.units.sel : null;
  box.innerHTML = "";
  const item = sys ? untFindLayerItem(layerKey, cat, sys) : null;
  if (!item) {
    const d = document.createElement("div");
    d.className = "unt-empty-hint";
    d.textContent = t("cpg_pick") || t("unt_sub") || "";
    box.appendChild(d);
    return;
  }
  // Шапка тела: только иконка (без подложки карточки и декора слота —
  // компактно) + редактируемый sysname + короткий путь. sysname из общего
  // списка параметров убран — правится здесь, в шапке рядом с иконкой.
  const head = document.createElement("div");
  head.className = "unt-detail-head";
  // Иконка тела — та же иконка кампании через uprChipIcon + cmpSpanChip,
  // но голая: подложка .upr-card гасится в units.css (.unt-detail-icon).
  const dicho = document.createElement("span");
  dicho.className = "upr-chip upr-card unt-detail-icon";
  const diimg = document.createElement("img");
  diimg.className = "upr-chip-icon";
  diimg.draggable = false;
  diimg.loading = "lazy";
  diimg.alt = item.sys;
  dicho.classList.add("upr-loading");
  if (typeof uprChipIcon === "function")
    uprChipIcon(diimg, dicho, item.sys, cat,
      { map: state.units.iconMap, ready: state.units.iconsReady });
  else if (typeof uprIconUrl === "function") diimg.src = uprIconUrl(item.sys, cat);
  if (diimg.complete && diimg.naturalWidth && typeof cmpSpanChip === "function")
    cmpSpanChip(dicho, diimg);
  dicho.appendChild(diimg);
  head.appendChild(dicho);
  // sysname — поле ввода в шапке (переименование едет выбором и списком,
  // как col 0 в untDetailCommit); проводка — после чтения строки файла.
  const nm = document.createElement("input");
  nm.className = "unt-detail-sys";
  nm.type = "text";
  nm.spellcheck = false;
  nm.autocomplete = "off";
  nm.value = item.sys;
  nm.placeholder = "sysname";
  head.appendChild(nm);
  head.oncontextmenu = e => untChipCtx(e, layerKey, cat, item.sys);
  box.appendChild(head);
  const pathRow = document.createElement("div");
  pathRow.className = "unt-detail-path";
  pathRow.textContent = item.path || "";
  box.appendChild(pathRow);
  // Параметры: читаем строку файла своего слоя (без побочных эффектов,
  // как добор оверлеев в renderUnits).
  const got = await untReadRows(item.path);
  if (my !== box.__detSeq || state.units.sel !== sys
      || state.units.cat !== cat || state.units.selLayer !== layerKey)
    return;
  const data = untLayerCatData(layerKey, cat);
  const columns = (got && got.columns && got.columns.length)
    ? got.columns : ((data && data.columns) || []);
  let values = [];
  let rowIdx = -1;
  if (got) {
    rowIdx = untFindRow(got.rows, sys);
    if (rowIdx !== -1) values = (got.rows[rowIdx].values || []).slice();
  }
  if (rowIdx === -1) {
    const d = document.createElement("div");
    d.className = "unt-empty-hint";
    d.textContent = sys;
    box.appendChild(d);
    return;
  }
  // Индекс колонки sysname — она правится полем в шапке, из списка пропускаем.
  const sysIdx = columns.findIndex(c => String(c).trim().toLowerCase() === "sysname");
  // Проводка поля шапки: переименование через тот же untDetailCommit.
  if (sysIdx === -1) {
    nm.disabled = true;
  } else {
    let headLast = sys;
    nm.addEventListener("change", () => {
      if (nm.value === headLast) return;
      headLast = nm.value;
      untDetailCommit(box, layerKey, cat, sys, rowIdx, sysIdx, nm).catch(() => {});
    });
    nm.addEventListener("keydown", ev => {
      if (ev.key === "Enter") { ev.preventDefault(); nm.blur(); }
      else if (ev.key === "Escape") {
        ev.preventDefault();
        nm.value = headLast;
        nm.blur();
      }
    });
  }
  const kv = document.createElement("div");
  kv.className = "unt-kv";
  columns.forEach((c, i) => {
    if (i === sysIdx) return; // sysname — поле в шапке рядом с иконкой
    const r = document.createElement("div");
    r.className = "unt-kv-row";
    const k = document.createElement("span");
    k.className = "unt-kv-key";
    k.textContent = String(c);
    const s = (i < values.length && values[i] !== undefined && values[i] !== null)
      ? String(values[i]) : "";
    // Меню перечисления для колонки (комбо важнее чипов: колонка из
    // UNT_COMBO_COLS со списком — всегда комбо, даже со запятой).
    const combo = (typeof makeUnitSetCombo === "function")
      ? untComboFor(c, untColValues(got, i)) : null;
    // Контекст строки: последнее закоммиченное значение (коммит только при
    // отличии — change+blur иначе пишут дважды) и превращения поля.
    const ctx = { box, layerKey, cat, sys, rowIdx, got, c, i, lastVal: s };
    ctx.commit = el => {
      if (el.value === ctx.lastVal) return;
      ctx.lastVal = el.value;
      untDetailCommit(box, layerKey, cat, sys, rowIdx, i, el).catch(() => {});
    };
    r.appendChild(k);
    if (combo) {
      // Колонка-перечисление — то же комбо, что в кампании и таблице, но
      // в своём держателе: makeUnitSetCombo чистит переданный контейнер
      // (textContent="") — раньше туда уходила вся строка вместе с именем
      // параметра, и меню выглядело криво.
      const inp = document.createElement("input");
      inp.className = "unt-kv-inp";
      inp.type = "text";
      inp.spellcheck = false;
      inp.autocomplete = "off";
      inp.value = s;
      inp.dataset.col = String(i);
      inp.addEventListener("change", () => ctx.commit(inp));
      inp.addEventListener("keydown", ev => {
        // Переносы строк в значения species не пишем: Enter всегда коммитит.
        if (ev.key === "Enter") { ev.preventDefault(); inp.blur(); }
        else if (ev.key === "Escape") {
          ev.preventDefault();
          inp.value = ctx.lastVal;
          inp.blur();
        }
      });
      const hold = document.createElement("span");
      hold.className = "unt-kv-combo";
      hold.appendChild(inp);
      r.appendChild(hold);
      try { makeUnitSetCombo(hold, inp, combo.choices, combo.title); }
      catch (e) { /* обычное поле без комбо */ }
    } else {
      // Обычное поле: текст, чипы и превращения между ними.
      untPaintRowField(r, ctx, s);
    }
    kv.appendChild(r);
  });
  box.appendChild(kv);
}

// Поле обычной строки-параметра (не комбо): текст, чипы и превращения
// между ними. r — строка (первый ребёнок — имя k, дальше только поле:
// всё после имени здесь сносится и строится заново); ctx — контекст строки
// (cat/sys/c/i/lastVal/commit); s — значение.
function untPaintRowField(r, ctx, s) {
  while (r.children.length > 1) {
    try { r.lastChild.remove(); } catch (e) { break; }
  }
  const { cat, sys, c, i } = ctx;
  ctx.lastVal = s;
  // Перечисление — чипами (запятая возвращается в файл при записи).
  if (s.indexOf(",") !== -1) {
    untChipsField(r, ctx, s, false);
    return;
  }
  const inp = document.createElement("input");
  inp.className = "unt-kv-inp";
  inp.type = "text";
  inp.spellcheck = false;
  inp.autocomplete = "off";
  inp.value = s;
  inp.dataset.col = String(i);
  let longTa = null;
  const collapseLong = () => {
    if (!longTa) return;
    inp.value = longTa.value;
    // change сам закоммитит, если значение правили
    try { inp.dispatchEvent(new Event("change")); } catch (e2) {}
    try { r.replaceChild(inp, longTa); } catch (e2) {}
    longTa = null;
    r.classList.remove("unt-kv-open");
  };
  // Запятая + пробел в обычном поле — превращение в перечисление с чипами:
  // значение пишется, строка перестраивается чипами, фокус — в добавление
  // следующего пункта (набираешь «пункт, » — и дальше набираешь уже в чипах).
  const toChips = el => {
    if (el.value.indexOf(", ") === -1) return;
    ctx.commit(el);
    untPaintRowField(r, ctx, el.value);
    untChipsFocusAdd(r);
  };
  const wireField = el => {
    el.addEventListener("change", () => ctx.commit(el));
    // blur добивает правки многострочного поля (у однострочника change
    // уже сработал раньше — повтор гасится проверкой lastVal).
    el.addEventListener("blur", () => ctx.commit(el));
    el.addEventListener("input", ev => {
      if (ev.isComposing) return; // IME-набор не рвём превращением
      toChips(el);
    });
    el.addEventListener("keydown", ev => {
      // Переносы строк в значения species не пишем: Enter всегда коммитит.
      if (ev.key === "Enter") { ev.preventDefault(); el.blur(); }
      else if (ev.key === "Escape") {
        ev.preventDefault();
        el.value = ctx.lastVal;
        el.blur();
        if (el.tagName === "TEXTAREA") collapseLong();
      }
    });
  };
  wireField(inp);
  r.appendChild(inp);
  // Длинные одиночные значения: в строке — компактный однострочник,
  // кнопка разворачивает многострочное поле для удобной правки.
  if (s.length > 90) {
    const tgl = untFieldBtn(UNT_EXPAND_SVG, "unt_expand");
    tgl.onclick = e => {
      e.stopPropagation();
      if (longTa) {
        collapseLong();
        tgl.title = t("unt_expand");
        try { inp.focus({ preventScroll: true }); } catch (e2) {}
        return;
      }
      longTa = document.createElement("textarea");
      longTa.className = inp.className + " unt-kv-ta";
      longTa.spellcheck = false;
      longTa.autocomplete = "off";
      longTa.value = inp.value;
      longTa.dataset.col = inp.dataset.col;
      longTa.rows = 2;
      wireField(longTa);
      const grow = () => {
        longTa.style.height = "auto";
        longTa.style.height = Math.min(longTa.scrollHeight, 240) + "px";
      };
      longTa.addEventListener("input", grow);
      r.replaceChild(longTa, inp);
      r.classList.add("unt-kv-open");
      tgl.title = t("unt_collapse");
      grow();
      try { longTa.focus(); } catch (e2) {}
    };
    r.appendChild(tgl);
  }
  // Колонки картинок (image/pic): кнопка предпросмотра — той же фабрикой
  // кнопок, в том же ряду после поля.
  if (untIsPicCol(c)) {
    const pv = untFieldBtn(UNT_EYE_SVG, "unt_preview");
    pv.classList.add("unt-kv-preview");
    pv.onclick = e => {
      e.stopPropagation();
      untPicPreview(pv, untPicUrl(cat, sys, c, inp.value));
    };
    r.appendChild(pv);
  }
  // Колонка mesh: кнопка 3D-превью модели — диалог model3d.js
  // (тёмная тема, сетка Blender, текстуры, вращение мышью).
  if (String(c || "").trim().toLowerCase() === "mesh") {
    const m3 = untFieldBtn(UNT_M3D_SVG, "m3d_preview");
    m3.onclick = e => {
      e.stopPropagation();
      if (typeof openModelPreview !== "function") {
        toast(t("m3d_err_lib") || "3D error", "err");
        return;
      }
      openModelPreview(untSrcRoot() || "", inp.value || "", sys, {cat: cat, sys: sys});
    };
    r.appendChild(m3);
  }
}
// Открыть добавление пункта перечисления (фокус в новое поле): после
// превращения «текст -> чипы» пользователь продолжает набирать следующий
// пункт уже в чипах, не кликая «+».
function untChipsFocusAdd(r) {
  try {
    const add = r.querySelector(".unt-chip-add");
    if (add) add.click();
  } catch (e) { /* добавление откроют вручную */ }
}
// Перечисление чипами: каждый элемент свой чип с минимальным зазором,
// без запятых и без аутлайна. В файл уходит строка с запятой (разделитель —
// как в исходном значении: ", " или ","): commit пишет склейку через
// скрытое поле штатным untDetailCommit.
// Клик по чипу — инлайн-правка (Enter/мимо — сохранить, пустое — убрать,
// Esc — отмена); × — убрать; + — добавить (Enter — сохранить и следующее,
// Backspace в пустом добавлении — убрать последний чип).
// Удаления, после которых запятой не осталось (0-1 пункт): невидимая
// запятая удалена — пункт снова обычный (строка перестраивается текстом).
function untChipsField(r, ctx, s, focusAdd) {
  const { i } = ctx;
  const commit = el => ctx.commit(el);
  const sep = s.indexOf(", ") !== -1 ? ", " : ",";
  let items = s.split(",").map(x => x.trim()).filter(x => x !== "");
  const hidden = document.createElement("input");
  hidden.type = "hidden";
  hidden.dataset.col = String(i);
  hidden.value = s;
  r.appendChild(hidden);
  const box = document.createElement("div");
  box.className = "unt-chips";
  r.appendChild(box);
  const save = () => {
    hidden.value = items.join(sep);
    commit(hidden);
  };
  // Обычный пункт вместо чипов: запятой больше нет — перестроить строку
  // текстом и отдать фокус в поле.
  const toPlain = () => {
    hidden.value = items.join(sep);
    commit(hidden);
    untPaintRowField(r, ctx, hidden.value);
    try {
      const inp = r.querySelector(".unt-kv-inp");
      if (inp) inp.focus({ preventScroll: true });
    } catch (e) { /* фокус не критичен */ }
  };
  // Любое удаление: остался 0-1 пункт — в обычный текст, иначе чипы.
  const mutated = () => {
    if (items.length <= 1) toPlain();
    else { save(); paint(); }
  };
  const splitVal = v => String(v || "").split(",").map(x => x.trim())
    .filter(x => x !== "");
  const paint = () => {
    box.innerHTML = "";
    items.forEach((it, idx) => {
      const chip = document.createElement("span");
      chip.className = "unt-chip";
      const tx = document.createElement("span");
      tx.className = "unt-chip-txt";
      tx.textContent = it;
      tx.onclick = () => editChip(chip, idx, it);
      const x = document.createElement("button");
      x.type = "button";
      x.className = "unt-chip-x";
      x.setAttribute("aria-label", "×");
      x.textContent = "×";
      x.onclick = () => {
        items.splice(idx, 1);
        mutated();
      };
      chip.append(tx, x);
      box.appendChild(chip);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "unt-chip-add";
    add.textContent = "+";
    add.onclick = () => addChip();
    box.appendChild(add);
  };
  const editChip = (chip, idx, it) => {
    const ed = document.createElement("input");
    ed.className = "unt-chip-edit";
    ed.type = "text";
    ed.spellcheck = false;
    ed.autocomplete = "off";
    ed.value = it;
    let done = false;
    const fin = ok => {
      if (done) return;
      done = true;
      if (!ok) { paint(); return; }
      const parts = splitVal(ed.value);
      if (parts.length === 1 && parts[0] === it) { paint(); return; }
      // Правка с запятой — в несколько пунктов; без запятой (пусто или один
      // пункт) — удаление смотрит, не остался ли пункт обычным.
      items.splice(idx, 1, ...parts);
      mutated();
    };
    ed.addEventListener("blur", () => fin(true));
    ed.addEventListener("keydown", ev => {
      if (ev.key === "Enter") { ev.preventDefault(); fin(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); fin(false); }
    });
    try { chip.replaceWith(ed); } catch (e) { return; }
    try { ed.focus(); ed.select(); } catch (e2) {}
  };
  const addChip = () => {
    const ed = document.createElement("input");
    ed.className = "unt-chip-edit";
    ed.type = "text";
    ed.spellcheck = false;
    ed.autocomplete = "off";
    ed.value = "";
    let done = false;
    const fin = ok => {
      if (done) return "";
      done = true;
      const v = ed.value.trim();
      if (ok && v !== "") {
        // Добавление с запятой — сразу несколько пунктов.
        splitVal(v).forEach(p => items.push(p));
        save();
      }
      paint();
      return (ok && v !== "") ? v : "";
    };
    ed.addEventListener("blur", () => fin(true));
    ed.addEventListener("keydown", ev => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        if (fin(true)) addChip();
      }
      else if (ev.key === "Escape") { ev.preventDefault(); fin(false); }
      // Backspace в пустом добавлении рядом с чипами — убрать последний
      // чип; единственный чип не удаляем — убираем невидимую запятую:
      // строка снова обычная, текст пункта сохранён.
      else if (ev.key === "Backspace" && ed.value === "" && items.length) {
        ev.preventDefault();
        done = true;
        if (items.length <= 1) { toPlain(); return; }
        items.pop();
        mutated();
      }
    });
    const anchor = box.querySelector(".unt-chip-add");
    if (anchor) box.insertBefore(ed, anchor);
    else box.appendChild(ed);
    try { ed.focus(); } catch (e2) {}
  };
  paint();
  if (focusAdd) untChipsFocusAdd(r);
}

// URL превью картинки поля: сырой ключ колонки резолвит /api/units_pic
// (.dds — готовым конвертером в webp, нет файла — плейсхолдер категории).
function untPicUrl(cat, sys, col, value) {
  const p = new URLSearchParams({
    root: untSrcRoot() || "",
    cat: cat || "",
    sys: sys || "",
    col: String(col || ""),
    value: value || "",
  });
  return "/api/units_pic?" + p.toString();
}

let untPicPopEl = null;
let untPicPopHooked = false;
// Один глобальный хук: клик мимо, скролл, ресайз и Esc закрывают превью
// (попап живёт в body — скролл тела его не режет, только закрывает).
function untPicHook() {
  if (untPicPopHooked) return;
  untPicPopHooked = true;
  document.addEventListener("mousedown", e => {
    try {
      if (e.target && e.target.closest &&
          e.target.closest(".unt-pic-pop, .unt-kv-preview")) return;
      untPicClose();
    } catch (e2) { /* noop */ }
  });
  document.addEventListener("scroll", untPicClose, true);
  window.addEventListener("resize", untPicClose);
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") untPicClose();
  });
}
function untPicClose() {
  if (!untPicPopEl) return;
  try { untPicPopEl.remove(); } catch (e) {}
  untPicPopEl = null;
}
// Вписать окно в экран в зоне кнопки: под ней, не влезло — над ней.
function untPicFit(pop, anchor) {
  if (!pop || !anchor || !anchor.getBoundingClientRect) return;
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth || 120;
  const h = pop.offsetHeight || 120;
  const x = Math.max(4, Math.min(r.left, window.innerWidth - w - 4));
  let y = r.bottom + 6;
  if (y + h > window.innerHeight - 4) {
    y = r.top - h - 6;
    if (y < 4) y = Math.max(4, window.innerHeight - h - 4);
  }
  pop.style.left = x + "px";
  pop.style.top = y + "px";
}
// Превью картинки поля: маленькое окно по размеру самой картинки в зоне
// кнопки; повторный клик по кнопке — закрыть.
function untPicPreview(btn, url) {
  untPicHook();
  if (untPicPopEl && untPicPopEl.dataset.url === url) {
    untPicClose();
    return;
  }
  untPicClose();
  const pop = document.createElement("div");
  pop.className = "unt-pic-pop";
  pop.dataset.url = url;
  const spin = document.createElement("div");
  spin.className = "unt-pic-spin";
  pop.appendChild(spin);
  const img = document.createElement("img");
  img.className = "unt-pic-img";
  img.alt = "";
  img.draggable = false;
  img.onload = () => {
    try { spin.remove(); } catch (e) {}
    untPicFit(pop, btn);
  };
  // Бэкенд без плейсхолдера 404 не отдаёт; сбой сети — тихо закрываем.
  img.onerror = () => untPicClose();
  img.src = url;
  pop.appendChild(img);
  document.body.appendChild(pop);
  untPicFit(pop, btn);
  untPicPopEl = pop;
}

// Запись одного поля тела: ячейка (rowIdx, col) файла своего слоя.
// Переименование (col 0) едет выбором и списком на новое имя.
async function untDetailCommit(box, layerKey, cat, sys, rowIdx, col, inp) {
  if (!box || !box.isConnected || !state.units) return;
  const nv = inp.value;
  const data = untLayerCatData(layerKey, cat);
  const path = (data && data.path) || "";
  if (!path || rowIdx < 0) {
    toast(t("unt_sub") || "error", "err");
    return;
  }
  // Переименование: col 0 либо колонка sysname (поле живёт в шапке тела,
  // в списке её нет — индекс приходит из шапки).
  const colName = String(((data && data.columns) || [])[col] || "").trim().toLowerCase();
  if (col === 0 || colName === "sysname") {
    const to = String(nv || "").trim();
    if (!to || to === sys) {
      inp.value = sys;
      return;
    }
    if (untAllSys().has(to)) {
      toast(to, "err");
      inp.value = sys;
      return;
    }
    inp.disabled = true;
    const j = await untWriteCells(path,
      [{ row: rowIdx, col: 0, value: to }], sys + " → " + to);
    inp.disabled = false;
    if (!j || !j.ok) {
      inp.value = sys;
      return;
    }
    // Имя ушло: правим элемент слоя на месте, едем выбором, красим заново.
    const layers = (state.units && state.units.layers) || [];
    layers.forEach(L => {
      if (L.key !== layerKey) return;
      const items = (((L.cats || {})[cat] || {}).items) || [];
      items.forEach(x => { if (x.sys === sys) x.sys = to; });
    });
    delete (state.units.iconMap || {})[sys];
    state.units.sel = to;
    untPaintAllLists();
    document.querySelectorAll("#unt-main .unt-detail").forEach(untPaintTypeDetail);
    untEnsureIcons().catch(() => {});
    // без тоста «Сохранено»: переименование ушло в память, знак — дискета
    return;
  }
  inp.disabled = true;
  const j = await untWriteCells(path,
    [{ row: rowIdx, col, value: nv }], sys + " " + String((data.columns || [])[col] || col));
  inp.disabled = false;
  if (!j || !j.ok) return;
  // Цена и вместимость живут на чипах: правим кэши и красим списки заново.
  try {
    if (colName === "cost" && state.units.prices && state.units.prices[cat])
      state.units.prices[cat][sys] = nv;
    if (colName === "people_capacity" && typeof vehCapMap !== "undefined" && vehCapMap
        && (typeof uprSrcRoot !== "function" || uprSrcRoot() === untSrcRoot()))
      vehCapMap[sys] = String(parseInt(nv, 10) || 0);
  } catch (e) { /* кэши необязательны */ }
  untPaintAllLists();
}

// Все sysname витрины для анализа иконок (все слои и классы).
function untIconNames() {
  const names = new Set();
  ((state.units && state.units.layers) || []).forEach(L => {
    UNT_CATS.forEach(cat => {
      ((((L.cats || {})[cat] || {}).items) || []).forEach(x => {
        if (x && x.sys) names.add(x.sys);
      });
    });
  });
  return [...names];
}

// Досмотр недогруженных иконок списков (рваный коннект без error/onload) —
// РОВНО uprReloadImages (uprising.js), но по #unt-main и со СВОЕЙ картой
// иконок: застрял на плейсхолдере или висит реальная — прогнать через
// uprChipIcon заново; возвращает число перезапущенных.
function untReloadImages() {
  const main = $("#unt-main");
  if (!main || typeof uprChipIcon !== "function") return 0;
  const ready = !!(state.units && state.units.iconsReady);
  const map = (state.units && state.units.iconMap) || {};
  let n = 0;
  main.querySelectorAll("img.upr-chip-icon").forEach(img => {
    if (!img.isConnected) return;
    const name = img.dataset.uprName || "";
    if (!name) return;
    const real = !!img.dataset.uprReal;
    let ok = false;
    try { ok = img.complete && img.naturalWidth > 0; } catch (e) {}
    if (ok && real) return;
    if (!real && !ready) return; // батч ещё летит — он всё закроет
    try {
      const chip = (img.closest && img.closest(".upr-chip")) || img.parentNode;
      delete img.dataset.uprReal;
      uprChipIcon(img, chip, name, img.dataset.uprCat || "", { map, ready });
      n++;
    } catch (e) {}
  });
  return n;
}
let untImgSweepT = 0;

// Анализ — РОВНО как кампания (cmpAnalyze): дожатие недостающих иконок
// чанками через /api/uprising_convert с мини-прогрессом под шапкой, затем
// сброс карт в памяти и перерисовка списков.
async function untAnalyze() {
  if (!state.units) state.units = untFreshState();
  if (state.units.analyzing) return;
  if (!((state.units.layers || []).length)) await renderUnits().catch(() => {});
  state.units.analyzing = true;
  const btn = $("#unt-analyze");
  const label = t("unt_analyze") || "Анализ";
  if (btn) { btn.disabled = true; btn.textContent = label + "…"; }
  try {
    const names = untIconNames();
    const CH = 150;
    const acc = { converted: 0, ready: 0, missing: 0, failed: 0 };
    let okAll = true, lastErr = "";
    if (names.length) untConvShow(names.length);
    for (let i = 0; i < names.length; i += CH) {
      const r = await api("/api/uprising_convert", { method: "POST",
        body: JSON.stringify({ root: untSrcRoot(), names: names.slice(i, i + CH) }) });
      const j = await r.json();
      if (j && j.ok) {
        acc.converted += j.converted || 0;
        acc.ready += j.ready || 0;
        acc.missing += j.missing || 0;
        acc.failed += j.failed || 0;
      } else { okAll = false; lastErr = (j && j.error) || "error"; break; }
      untConvPaint(Math.min(i + CH, names.length), names.length);
    }
    if (okAll) {
      // индекс webp перестраивается по mtime сам; сбрасываем карты в памяти
      state.units.iconMap = {};
      state.units.iconsReady = false;
      state.units.iconSeq++;
      untEnsureIcons().catch(() => {});
      untEnsurePrices().catch(() => {});
      untPaintAllLists();
      const parts = [];
      if (acc.converted) parts.push("+" + acc.converted);
      if (acc.ready) parts.push("=" + acc.ready);
      if (acc.failed) parts.push("!" + acc.failed);
      toast((t("swt_analyzed_tt") || "Готово") +
        (parts.length ? " (" + parts.join(" ") + ")" : ""), "ok");
    } else toast(lastErr, "err");
  } catch (e) { toast(String((e && e.message) || e), "err"); }
  finally {
    state.units.analyzing = false;
    untConvHide();
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

// Мини-прогресс конвертации иконок — те же классы/вид, что upr-conv
// (cmpConvShow/cmpConvPaint/cmpConvHide у кампании).
function untConvShow(total) {
  const w = $("#unt-conv");
  if (!w) return;
  w.hidden = false;
  untConvPaint(0, total);
}
function untConvPaint(done, total) {
  const f = $("#unt-conv-fill"), tx = $("#unt-conv-txt");
  const pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 100;
  if (f) f.style.width = pct + "%";
  if (tx) tx.textContent = (t("upr_conv_icons") || "Иконки") +
    ": " + done + "/" + total;
}
function untConvHide() {
  if (state.units && state.units.analyzing) return;
  const w = $("#unt-conv");
  if (w) w.hidden = true;
}

// Открыть species-файл в гриде через существующий механизм (первый загруженный класс).
function untOpenGrid() {
  for (const cat of UNT_CATS) {
    const d = untCatData(cat);
    const p = d && d.path;
    if (p && typeof openFile === "function") { openFile(p); return; }
  }
  toast(t("unt_sub") || "", "err");
}

// Пачка правок ячеек одной записью истории (редактор и CRUD S6):
// cells = [{row, col, value, type?}] — строки species-файла, row включая шапку.
// path — ТОЛЬКО реальный путь из витрины слоёв (на несуществующем пути
// бэкенд отвечает 500, а не JSON).
async function untWriteCells(path, cells, summary) {
  if (!path) {
    toast(t("unt_sub") || "error", "err");
    return { ok: false, error: "no path" };
  }
  try {
    // save:false — правка только в память (образец cmpWriteCells): на диск
    // пишет явное сохранение, Enter в поле тоже лишь красит дискету.
    const body = { path, cells: cells || [], save: false };
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
      // В память, не на диск: красная дискета + кнопки undo/redo (новая
      // правка гасит чужой redo-хвост — флаги читаем с сервера свежими).
      if (j.changed) {
        try { untMarkDirty(path); } catch (e) {}
        try { await untSyncUndoButtons(); } catch (e) {}
      }
    }
    return j;
  } catch (e) {
    toast(String((e && e.message) || e), "err");
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Явное сохранение грязных species-файлов (кнопка шапки, Ctrl+S/Ctrl+Shift+S):
// каждый файл — через общий guardedSave: защищённая игра спрашивает
// «в проект/мод» обычным попапом, иначе тихая запись сессии на диск.
// Дискета гаснет зелёной вспышкой только когда всё записано.
async function untSaveGuarded(popup) {
  if (!state.units) return;
  const paths = Object.keys(state.units.dirtyPaths || {});
  if (!paths.length) return;
  for (const path of paths) {
    await guardedSave("file", path, async target => {
      if (target) {
        const j = await saveAsTo(path, "file", target);
        if (j.ok && j.saved) {
          delete state.units.dirtyPaths[path];
          toast((t("saved") || "Сохранено") + " → " + j.dst, "ok");
          try { await noteExternalTreeChange(target); } catch (e) {}
        }
        else toast((j.error || "error"), "err");
        return;
      }
      let j = null;
      try {
        const r = await api("/api/save", { method: "POST",
          body: JSON.stringify({ path }) });
        j = await r.json();
      } catch (e) { j = null; }
      if (!j || !j.ok) { toast((j && j.error) || "error", "err"); return; }
      delete state.units.dirtyPaths[path];
    }, popup);
  }
  if (!Object.keys(state.units.dirtyPaths || {}).length) {
    untMarkClean();
    toast(t("saved") || "Сохранено", "ok");
  }
  await renderUnits(true).catch(() => {});
}

// Страница в глобальном реестре истории: undo/redo, журнал и кнопки
// работают без правок ядра — как для любой будущей страницы.
function untRegisterHistPage() {
  try {
    if (typeof registerHistPage === "function") registerHistPage("units", {
      paths: untHistPaths,
      repaint: untRepaintUndo,
      hint: () => (state.units || {}),
      sync: untSyncUndoButtons,
      clean: untMarkClean,
    });
  } catch (e) { /* ядро истории ещё не загружено */ }
}
untRegisterHistPage();

// ==================== S6: редактор, CRUD, меню ====================
// Витрина читается мимо живых сессий (оверлеи — через /api/file без побочных
// эффектов): после каждой записи витрину категории перечитываем renderUnits(true).

// Данные категории слоя {path, columns, items:[{sys, path}]} или null.
// Слой держит ТОЛЬКО строки своего файла (basis и DLC рядом, без слияния).
function untLayerCatData(layerKey, cat) {
  const layers = (state.units && state.units.layers) || [];
  for (const L of layers) {
    if (L.key === layerKey) return ((L.cats || {})[cat]) || null;
  }
  return null;
}

// Сводный вид категории для CRUD/зеркала (старая форма cats[cat]):
// {path (basis), columns, overlays (пути DLC), items:[{sys, src, path}]} —
// сначала база, поверх оверлеи (DLC выигрывает у basis при том же sysname).
// Пути — ТОЛЬКО реальные из витрины слоёв.
function untCatData(cat) {
  return untMergedCat(cat);
}

function untMergedCat(cat) {
  const layers = (state.units && state.units.layers) || [];
  let path = "", columns = [], overlays = [];
  const bySys = new Map();
  layers.forEach(L => {
    const d = (L.cats || {})[cat];
    if (!d) return;
    const src = L.key === "basis" ? "basis" : (L.label || L.key);
    if (L.key === "basis") {
      path = d.path || "";
      columns = d.columns || [];
    } else if (d.path) overlays.push(d.path);
    if (!columns.length && (d.columns || []).length) columns = d.columns;
    (d.items || []).forEach(it => {
      bySys.delete(it.sys);
      bySys.set(it.sys, { sys: it.sys, src, path: d.path || "" });
    });
  });
  if (!path && !overlays.length && !bySys.size) return null;
  if (!path && overlays.length) path = overlays[0];
  return { path, columns, overlays, items: Array.from(bySys.values()) };
}

// Элемент слоя {sys, src, path} или null (src — метка слоя: basis/Имя DLC).
function untFindLayerItem(layerKey, cat, sys) {
  const layers = (state.units && state.units.layers) || [];
  for (const L of layers) {
    if (L.key !== layerKey) continue;
    const items = (((L.cats || {})[cat] || {}).items) || [];
    const hit = items.find(x => x.sys === sys);
    if (hit) return { sys: hit.sys,
      src: L.key === "basis" ? "basis" : (L.label || L.key),
      path: hit.path || "" };
  }
  return null;
}

// Элемент витрины {sys, src, path} или null.
function untFindItem(cat, sys) {
  const d = untCatData(cat);
  if (!d) return null;
  return (d.items || []).find(x => x.sys === sys) || null;
}

// Все sysname витрины (для проверки уникальности) — по всем слоям.
function untAllSys() {
  const out = new Set();
  ((state.units && state.units.layers) || []).forEach(L => {
    UNT_CATS.forEach(c => {
      ((((L.cats || {})[c] || {}).items) || []).forEach(x => { if (x.sys) out.add(x.sys); });
    });
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

// Попап-редактор удалён полностью: все параметры строки правятся прямо
// в теле карточки (untPaintTypeDetail/untDetailCommit) — отдельных окон
// редактирования нет ни по даблклику, ни из меню.

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
// /api/add_row): path — реальный путь файла своего слоя (кнопка «+» карточки
// пишет в файл слоя, иначе — в basis сводного вида). preset — готовые
// значения (вставка из буфера) или null (чистая строка).
async function untAddUnit(cat, preset, layerKey) {
  const layerData = layerKey ? untLayerCatData(layerKey, cat) : null;
  const d = untCatData(cat);
  const path = (layerData && layerData.path) || (d && d.path);
  if (!path) { toast(t("unt_sub") || "error", "err"); return null; }
  const effLayer = layerKey || "basis";
  const width = Math.max((((layerData && layerData.columns) || (d && d.columns)) || []).length, 1);
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
    // в память, не на диск: знак правки — красная дискета вкладки
    const r = await api("/api/add_row", { method: "POST",
      body: JSON.stringify({ path, values: vals, save: false }) });
    j = await r.json();
  } catch (e) { j = null; }
  if (!j || !j.ok) { toast((j && j.error) || "error", "err"); return null; }
  if (cat === "squads") await untCheckSquadRefs(vals, (d && d.columns) || []);
  try { untMarkDirty(path); } catch (e) {}
  try { await untSyncUndoButtons(); } catch (e) {}
  // Выбор — на добавленную строку в её слое (валидация renderUnits сохранит).
  if (state.units) {
    state.units.cat = cat;
    state.units.selLayer = effLayer;
    state.units.sel = vals[0];
  }
  await renderUnits(true).catch(() => {});
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
        body: JSON.stringify({ path: tg.path, row: ri, save: false }) });
      j = await r.json();
    } catch (e) { j = null; }
    if (!j || !j.ok) {
      toast((j && j.error) || tg.path, "err");
      ok = false;
    } else {
      try { untMarkDirty(tg.path); } catch (e) {}
    }
  }
  try { await untSyncUndoButtons(); } catch (e) {}
  await renderUnits(true).catch(() => {});
  return ok;
}

// Дублировать юнит в том же слое: строка-источник копируется дословно,
// имя уникализируется (имя_2, имя_3, …) через untAddUnit-пресет; выбор едет
// на дубликат. Один клик вместо «копировать + вставить + переименовать».
async function untDupUnit(cat, sys, layerKey) {
  const item = untFindLayerItem(layerKey, cat, sys) || untFindItem(cat, sys);
  if (!item || !item.path) { toast(t("unt_sub") || "error", "err"); return; }
  const got = await untReadRows(item.path);
  if (!got) { toast(item.path, "err"); return; }
  const ri = untFindRow(got.rows, sys);
  if (ri === -1) { toast(sys, "err"); return; }
  const vals = (got.rows[ri].values || []).slice();
  await untAddUnit(cat, vals, layerKey);
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
        body: JSON.stringify({ path: item.path, row: ri, save: false }) });
      j = await r.json();
    } catch (e) { j = null; }
    if (!j || !j.ok) {
      toast((j && j.error) || "error", "err");
      state.units.clip = null;
      return;
    }
    try { untMarkDirty(item.path); } catch (e) {}
    try { await untSyncUndoButtons(); } catch (e) {}
    await renderUnits(true).catch(() => {});
  }
  toast(t("ctx_copied") || "Скопировано", "ok");
}

// Вставить буфер: targetCat — конкретная категория (меню чипа/категории) или
// null (меню сектора/слоя: каждый элемент в свою категорию); targetLayerKey —
// слой-приёмник (меню карточки/слоя) или null (сводный basis). Имена
// уникализируем, ширину подгоняем под файл-приёмник, связи squads→humans
// проверяем. Пути — ТОЛЬКО реальные из витрины слоёв.
async function untPasteClip(targetCat, targetLayerKey) {
  const clip = state.units && state.units.clip;
  const entries = (clip && clip.items) || [];
  if (!entries.length) return;
  let n = 0;
  for (const en of entries) {
    const tcat = targetCat || en.cat;
    const layerData = targetLayerKey ? untLayerCatData(targetLayerKey, tcat) : null;
    const d = untCatData(tcat);
    const columns = ((layerData && layerData.columns) || (d && d.columns)) || [];
    const path = (layerData && layerData.path) || (d && d.path);
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
      const w0 = Math.max(columns.length, 1);
      vals = [en.sys];
      while (vals.length < w0) vals.push("");
    }
    const width = Math.max(columns.length, 1);
    vals = vals.slice(0, width);
    while (vals.length < width) vals.push("");
    vals[0] = untUniqueSys(String(vals[0] || en.sys || "unit_new").trim() || "unit_new");
    let j = null;
    try {
      const r = await api("/api/add_row", { method: "POST",
        body: JSON.stringify({ path, values: vals, save: false }) });
      j = await r.json();
    } catch (e) { j = null; }
    if (!j || !j.ok) { toast((j && j.error) || "error", "err"); continue; }
    if (tcat === "squads") await untCheckSquadRefs(vals, columns);
    try { untMarkDirty(path); } catch (e) {}
    n++;
  }
  try { await untSyncUndoButtons(); } catch (e) {}
  await renderUnits(true).catch(() => {});
}

// Вставить буфер в свой слой: каждый элемент — в свой класс, но в файл
// этого слоя (меню слоя); нет файла класса в слое — в сводный basis.
async function untPasteClipToLayer(layerKey) {
  const clip = state.units && state.units.clip;
  const entries = (clip && clip.items) || [];
  if (!entries.length) return;
  let n = 0;
  for (const en of entries) {
    const tcat = en.cat;
    const layerData = untLayerCatData(layerKey, tcat);
    const d = untCatData(tcat);
    const columns = ((layerData && layerData.columns) || (d && d.columns)) || [];
    const path = (layerData && layerData.path) || (d && d.path);
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
    const width = Math.max(columns.length, 1);
    if (!vals.length) vals = [en.sys];
    vals = vals.slice(0, width);
    while (vals.length < width) vals.push("");
    vals[0] = untUniqueSys(String(vals[0] || en.sys || "unit_new").trim() || "unit_new");
    let j = null;
    try {
      const r = await api("/api/add_row", { method: "POST",
        body: JSON.stringify({ path, values: vals, save: false }) });
      j = await r.json();
    } catch (e) { j = null; }
    if (!j || !j.ok) { toast((j && j.error) || "error", "err"); continue; }
    if (tcat === "squads") await untCheckSquadRefs(vals, columns);
    try { untMarkDirty(path); } catch (e) {}
    n++;
  }
  try { await untSyncUndoButtons(); } catch (e) {}
  await renderUnits(true).catch(() => {});
}

// Очистка категории слоя (layerKey) или всей категории (сводно, меню сектора):
// удалить строки (каждая — из своего файла).
async function untClearCat(cat, layerKey) {
  let items;
  if (layerKey) {
    const ld = untLayerCatData(layerKey, cat);
    items = (((ld && ld.items) || []).map(x => ({ sys: x.sys, path: x.path })));
  } else {
    const d = untCatData(cat);
    items = (((d && d.items) || []).slice());
  }
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
        const r = await api("/api/delete_row", { method: "POST",
          body: JSON.stringify({ path, row: ri, save: false }) });
        const j = await r.json();
        if (j && j.ok) { try { untMarkDirty(path); } catch (e) {} }
      } catch (e) { /* пропускаем, идём дальше */ }
    }
  }
  try { await untSyncUndoButtons(); } catch (e) {}
  await renderUnits(true).catch(() => {});
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
}

// Меню чипа (образец uprChipCtx): добавить/копировать/вырезать/
// удалить/вставить + открыть в таблице. Пункта редактирования нет —
// все параметры правятся прямо в теле карточки. Добавление и вставка
// пишут в файл своего слоя.
function untChipCtx(e, layerKey, cat, sys) {
  const hasClip = !!((state.units && state.units.clip && state.units.clip.items || []).length);
  openCtxMenu(e, [
    { label: t("unt_add") || "Добавить", icon: "add",
      fn: () => { untAddUnit(cat, null, layerKey).catch(() => {}); } },
    { label: t("unt_copy") || "Копировать", icon: "copy",
      fn: () => { untCopyUnit(cat, sys, false).catch(() => {}); } },
    { label: t("ctx_cut") || "Вырезать", icon: "cut",
      fn: () => { untCopyUnit(cat, sys, true).catch(() => {}); } },
    { label: t("unt_duplicate") || "Дублировать", icon: "copy",
      fn: () => { untDupUnit(cat, sys, layerKey).catch(() => {}); } },
    { sep: true },
    { label: t("unt_delete") || "Удалить", icon: "delete", danger: true,
      fn: () => { untDelUnit(cat, sys).catch(() => {}); } },
    { label: t("unt_paste") || "Вставить", icon: "paste", disabled: !hasClip,
      fn: () => { untPasteClip(cat, layerKey).catch(() => {}); } },
    { sep: true },
    { label: t("upr_open_grid") || "Открыть в таблице", icon: "grid",
      fn: () => {
        const it = untFindLayerItem(layerKey, cat, sys) || untFindItem(cat, sys);
        if (it && it.path && typeof openFile === "function") openFile(it.path);
      } },
  ]);
}

// Меню категории слоя (фон ряда/шапка карточки): добавить, копировать всё,
// вставить, очистить. Пишет в файл своего слоя.
function untCatCtx(e, layerKey, cat) {
  const ld = untLayerCatData(layerKey, cat);
  const items = ((ld && ld.items) || []).map(x => ({ sys: x.sys, path: x.path }));
  const n = items.length;
  const hasClip = !!((state.units && state.units.clip && state.units.clip.items || []).length);
  openCtxMenu(e, [
    { label: t("unt_add") || "Добавить", icon: "add",
      fn: () => { untAddUnit(cat, null, layerKey).catch(() => {}); } },
    { label: t("unt_copy") || "Копировать", icon: "copy", disabled: !n,
      fn: () => {
        if (!state.units) state.units = untFreshState();
        state.units.clip = { op: "copy",
          items: items.map(x => ({ cat, sys: x.sys, path: x.path })) };
        toast(t("ctx_copied") || "Скопировано", "ok");
      } },
    { label: t("unt_paste") || "Вставить", icon: "paste", disabled: !hasClip,
      fn: () => { untPasteClip(cat, layerKey).catch(() => {}); } },
    { sep: true },
    { label: t("upr_sec_clear") || "Очистить", icon: "delete", danger: true, disabled: !n,
      fn: () => { untClearCat(cat, layerKey).catch(() => {}); } },
  ]);
}

// Меню слоя (шапка секции): копировать весь слой, вставить в слой, очистить слой.
function untLayerCtx(e, layerKey) {
  const layers = (state.units && state.units.layers) || [];
  const L = layers.find(x => x.key === layerKey);
  if (!L) return;
  let total = untLayerTotal(L);
  const hasClip = !!((state.units && state.units.clip && state.units.clip.items || []).length);
  openCtxMenu(e, [
    { label: t("unt_copy") || "Копировать", icon: "copy", disabled: !total,
      fn: () => {
        if (!state.units) state.units = untFreshState();
        const items = [];
        UNT_CATS.forEach(c => {
          ((((L.cats || {})[c] || {}).items) || []).forEach(x =>
            items.push({ cat: c, sys: x.sys, path: x.path }));
        });
        state.units.clip = { op: "copy", items };
        toast(t("ctx_copied") || "Скопировано", "ok");
      } },
    { label: t("unt_paste") || "Вставить", icon: "paste", disabled: !hasClip,
      fn: () => { untPasteClipToLayer(layerKey).catch(() => {}); } },
    { sep: true },
    { label: t("upr_sec_clear") || "Очистить", icon: "delete", danger: true, disabled: !total,
      fn: async () => {
        const c = await askConfirm({
          title: (L.label || L.key) + ": " + total,
          message: t("upr_sec_clear_m") || "Всё наполнение будет удалено.",
          buttons: [
            { id: "ok", label: t("delete") || "Удалить", kind: "danger" },
            { id: "cancel", label: t("cancel") || "Отмена", kind: "ghost" },
          ],
        });
        if (c !== "ok") return;
        for (const cat of UNT_CATS) {
          const ld = (L.cats || {})[cat];
          if (!(((ld && ld.items) || []).length) || !ld.path) continue;
          const got = await untReadRows(ld.path);
          if (!got) continue;
          const rows = [];
          (ld.items || []).forEach(x => {
            const ri = untFindRow(got.rows, x.sys);
            if (ri !== -1) rows.push(ri);
          });
          rows.sort((a, b) => b - a);
          for (const ri of rows) {
            try {
              const r = await api("/api/delete_row", { method: "POST",
                body: JSON.stringify({ path: ld.path, row: ri, save: false }) });
              const j = await r.json();
              if (j && j.ok) { try { untMarkDirty(ld.path); } catch (e) {} }
            } catch (ex) { /* пропускаем, идём дальше */ }
          }
        }
        try { await untSyncUndoButtons(); } catch (e) {}
        await renderUnits(true).catch(() => {});
      } },
  ]);
}

// Меню сектора (образец uprSectorCtx): заменить/копировать/вставить/очистить.
// Сводно по всем слоям (пул вкладки).
function untSecCtx(e) {
  let total = 0;
  UNT_CATS.forEach(c => {
    const d = untCatData(c);
    total += (((d && d.items) || []).length);
  });
  const hasClip = !!((state.units && state.units.clip && state.units.clip.items || []).length);
  openCtxMenu(e, [
    { label: t("unt_edit") || "Редактировать", icon: "swap", disabled: !total,
      fn: () => { untReplaceSys().catch(() => {}); } },
    { label: t("unt_copy") || "Копировать", icon: "copy", disabled: !total,
      fn: () => {
        if (!state.units) state.units = untFreshState();
        const items = [];
        UNT_CATS.forEach(c => {
          const d = untCatData(c);
          (((d && d.items) || [])).forEach(x =>
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
          const d = untCatData(cat);
          if (!(((d && d.items) || []).length)) continue;
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
                const r = await api("/api/delete_row", { method: "POST",
                  body: JSON.stringify({ path: entry[0], row: ri, save: false }) });
                const j = await r.json();
                if (j && j.ok) { try { untMarkDirty(entry[0]); } catch (e) {} }
              } catch (ex) { /* пропускаем, идём дальше */ }
            }
          }
        }
        try { await untSyncUndoButtons(); } catch (e) {}
        await renderUnits(true).catch(() => {});
      } },
  ]);
}
