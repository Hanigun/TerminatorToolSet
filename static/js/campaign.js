/* TerminatorToolSet frontend — campaign.js: редактор кампании
   (магазины поселений поверх GlobalMap). Каркас по образцу uprising.js:
   openCampaign/setupCampaign/renderCampaign + загрузчик фона с ретраями.
   Чтение base shop_presets — через /api/campaign_find + /api/open_file
   (те же строки/колонки, что таблица). Ассортимент панели — следующий этап. */
"use strict";

// ---------- state ----------
function cmpFreshState() {
  return {
    path: "", rows: null, columns: [], loading: false, loadSeq: 0,
    sel: null, unitSel: [], tab: "shop", dirty: false, analyzing: false,
    prices: {}, stats: {}, sysnames: [], syscats: {}, statPaths: {}, redoHint: "",
    iconMap: {}, iconFail: {}, iconsReady: false, iconsLoading: false,
    sysLoading: false, clip: [], tileClip: [],
  };
}
function cmpTab() { return state.tabs.find(tb => tb.id === "campaign"); }

function cmpMarkDirty() {
  state.campaign.dirty = true;
  const tb = cmpTab();
  if (tb && !tb.dirty) { tb.dirty = true; renderTabBar(); }
}
function cmpMarkClean() {
  state.campaign.dirty = false;
  const tb = cmpTab();
  if (tb) { tb.dirty = false; tb.saved = true; renderTabBar(); }
}

// временный арт секторов (assets/Campaign/Sectors/glbmp_preview_*.webp):
// точное имя — первым, дальше префиксы; нет совпадения — градиент-заглушка.
// res_sup_base_0 — свой арт glbmp_res_sup_base.webp; resistance_far_recon —
// тот же арт, что resistance_camp (far_movement_camp).
// Без пресетов (картинки лежат без дела): abiquiu, amarilo, chihua,
// fort_worth, oklahoma, camp_founders, final.
var CMP_SECTOR_MAP = [
  ["res_sup_base_0", "glbmp_res_sup_base.webp"],
  ["res_sup_base_1", "glbmp_preview_abique.webp"],
  ["res_forward_post_0", "glbmp_preview_amarillo.webp"],
  ["tortuga_", "glbmp_preview_tortuga1.webp"],
  ["vega_", "glbmp_preview_vega.webp"],
  ["taos_", "glbmp_preview_taos1.webp"],
  ["albuquerque", "glbmp_preview_albuquerque.webp"],
  ["integrators_main", "glbmp_preview_int_main_camp.webp"],
  ["integrators_scavengers_1", "glbmp_preview_integrator_scav.webp"],
  ["integrators_scavengers_2", "glbmp_preview_integrator_scav.webp"],
  ["integrators_scavengers", "glbmp_preview_camp_integrators.webp"],
  ["resistance_camp", "glbmp_preview_far_movement_camp.webp"],
  ["resistance_far_recon", "glbmp_preview_far_movement_camp.webp"],
  ["res_", "glbmp_preview_camp_resistance.webp"],
  ["resistance_", "glbmp_preview_camp_resistance.webp"],
];
function cmpSectorImg(sys) {
  const s = String(sys || "").toLowerCase();
  for (const [pref, file] of CMP_SECTOR_MAP) {
    if (s.indexOf(pref) === 0) return "/assets/campaign/Sectors/" + file;
  }
  return "";
}

// Отображаемые имена поселений для шапок (плитка + панель + ховер):
// единый список на всех языках интерфейса (имена собственные).
// Нет записи — сырой sysname, как раньше.
var CMP_SETTLEMENT_NAMES = {
  taos_shop_1: "ТАОС 1",
  taos_shop_2: "ТАОС 2",
  taos_shop_3: "ТАОС 3",
  albuquerque_shop: "Albuquerque",
  res_sup_base_0: "Movement Support Base",
  res_sup_base_1: "Abiquiu",
  tortuga_1: "Nueva Tortuga 1",
  tortuga_2: "Nueva Tortuga 2",
  tortuga_3: "Nueva Tortuga 3",
  integrators_main_1: "Main Integrators Camp 1",
  integrators_main_2: "Main Integrators Camp 2",
  integrators_main_2a: "Main Integrators Camp 2a",
  integrators_main_3: "Main Integrators Camp 3",
  integrators_main_4: "Main Integrators Camp 4",
  integrators_main_0: "Main Integrators Camp 0",
  res_forward_post_0: "Amarillo",
  integrators_scavengers_1: "Destroyed Founders Camp",
  integrators_scavengers_2: "Destroyed Founders Camp",
};
function cmpSettlementName(sys) {
  if (Object.prototype.hasOwnProperty.call(CMP_SETTLEMENT_NAMES, sys))
    return CMP_SETTLEMENT_NAMES[sys];
  // vega-плитки (имена из данных игры): "Vega " + хвост ("vega_1" → "Vega 1")
  const s = String(sys || "");
  if (s.toLowerCase().indexOf("vega_") === 0 && s.length > 5)
    return "Vega " + s.slice(5);
  return sys;
}

// иконки особенностей в шапке плитки (assets/Campaign,
// 28x28): порядок manpower > shop > trainings, прижаты к правому краю.
// Полный набор — CMP_HEAD_ICONS; у отдельных плиток свой урезанный набор
// (карта sys -> список файлов): Таос и главная база интеграторов —
// только магазин, форпост — manpower + shop.
var CMP_HEAD_ICONS = [
  "icon_trait_manpower.webp",
  "icon_trait_shop.webp",
  "icon_trait_trainings.webp",
];
// плитки с иконками в шапке и именем заглавными: база + магазин Альбукерке
// + Тортуга (все три) + Таос (все три, только магазин) + форпост
// (manpower + shop) + лагерь Сопротивления и дальняя разведка (полный
// набор) + главная база интеграторов (все пять, только магазин —
// см. CMP_TILE_ICONS)
var CMP_ICON_TILES = ["res_sup_base_0", "res_sup_base_1", "albuquerque_shop",
  "tortuga_1", "tortuga_2", "tortuga_3",
  "taos_shop_1", "taos_shop_2", "taos_shop_3",
  "res_forward_post_0", "resistance_camp", "resistance_far_recon",
  "integrators_main_1", "integrators_main_2", "integrators_main_2a",
  "integrators_main_3", "integrators_main_4"];
var CMP_TILE_ICONS = {
  res_sup_base_1: ["icon_trait_trainings.webp"],
  integrators_scavengers_1: ["icon_trait_shop.webp"],
  integrators_scavengers_2: ["icon_trait_shop.webp"],
  taos_shop_1: ["icon_trait_shop.webp"],
  taos_shop_2: ["icon_trait_shop.webp"],
  taos_shop_3: ["icon_trait_shop.webp"],
  res_forward_post_0: ["icon_trait_manpower.webp", "icon_trait_shop.webp"],
  integrators_main_1: ["icon_trait_shop.webp"],
  integrators_main_2: ["icon_trait_shop.webp"],
  integrators_main_2a: ["icon_trait_shop.webp"],
  integrators_main_3: ["icon_trait_shop.webp"],
  integrators_main_4: ["icon_trait_shop.webp"],
};
function cmpTileIcons(sys) {
  if (Object.prototype.hasOwnProperty.call(CMP_TILE_ICONS, sys))
    return CMP_TILE_ICONS[sys];
  // vega-плитки (имена из данных игры, точный список неизвестен):
  // все — только иконка trainings
  if (String(sys || "").toLowerCase().indexOf("vega_") === 0)
    return ["icon_trait_trainings.webp"];
  if (CMP_ICON_TILES.indexOf(sys) !== -1) return CMP_HEAD_ICONS;
  return null;
}

// заголовки секций — иконки вместо текста (assets/Campaign/UnitSet):
// squads=infantry, cars=light_vehicle, tanks=tank, helicopters=heli,
// inventory_items=supply_vehicle. Текст остаётся в title/alt, нет
// файла — откат на текстовую подпись
var CMP_CAT_ICONS = {
  squads: "infantry.webp",
  cars: "light_vehicle.webp",
  tanks: "tank.webp",
  helicopters: "heli.webp",
  inventory_items: "supply_vehicle.webp",
};
function cmpCatIcon(cat) {
  return "/assets/campaign/UnitSet/" + (CMP_CAT_ICONS[cat] || "");
}

// источник — глобальный источник приложения (как карта Uprising)
function cmpSrcRoot() { return srcRoot(state.treeView); }

// переключение источника кампании — через глобальный источник
// (древо и карты всегда на одном: Проект | Игра | Мод) — как карта Uprising
async function cmpSwitchSrc(v) {
  await setSrc(v);
}

async function cmpFindFile() {
  const root = cmpSrcRoot();
  if (!root) return "";
  const fr = await api("/api/campaign_find", { method: "POST",
    body: JSON.stringify({ root }) });
  const fj = await fr.json();
  return (fj.ok && fj.path) || "";
}

// ---------- open ----------
async function openCampaign(path, opts) {
  if (!state.tabs.some(tb => tb.id === "campaign")) {
    createTab("campaign");
    renderTabBar();
  }
  if (!opts || opts.activate !== false) activateTab("campaign");
  if (!path && state.campaign.loading) return;
  // область карты + спиннер — ДО медленного поиска/загрузки: #cmp-loading
  // лежит внутри #cmp-wrap, и пока wrap скрыт — спиннер не виден вообще
  // (та же ловушка, что была в openUprising до её починки).
  try {
    $("#cmp-wrap").hidden = false;
    $("#cmp-nofile").hidden = true;
  } catch (e) { /* DOM ещё не готов — cmpLoad сам покажет */ }
  cmpSetLoading(true);
  if (!path) path = await cmpFindFile();
  if (!path) {
    cmpSetLoading(false);
    cmpPaintNofile();
    return;
  }
  if (state.campaign.path && normPath(path) === normPath(state.campaign.path) &&
      state.campaign.rows) { cmpSetLoading(false); return; }
  state.campaign.path = path;
  const seq = ++state.campaign.loadSeq;
  state.campaign.loading = true;
  try {
    await cmpLoad(seq);
  } catch (e) {
    // cmpLoad сам тостит сетевые сбои; здесь — страховка от синхронного
    // броска: иначе спиннер остался бы навсегда
    if (seq === state.campaign.loadSeq) {
      cmpSetLoading(false);
      toast(String((e && e.message) || e), "err");
    }
  } finally {
    if (seq === state.campaign.loadSeq) {
      state.campaign.loading = false;
      cmpSetLoading(false);
    }
  }
  cmpLoadMapImg($("#cmp-map-img"), 0);
  $("#cmp-file").textContent = path;
  $("#cmp-file").title = path;
  $("#cmp-wrap").hidden = false;
  $("#cmp-nofile").hidden = true;
  ["#cmp-reload", "#cmp-analyze", "#cmp-open-grid", "#cmp-fs", "#cmp-resizer"]
    .forEach(s => { $(s).hidden = false; });
  const sw = parseInt(localStorage.getItem("tsh_cmp_panel_w") || "0", 10);
  if (sw >= 280 && sw <= 900) $("#cmp-main").style.flex = "0 0 " + sw + "px";
  cmpFitMap();
  requestAnimationFrame(() => cmpFitMap());
  api("/api/history?path=" + encodeURIComponent(path)).then(r => r.json())
    .then(jh => { if (jh && jh.ok) setUndoRedoButtons(!!jh.can_undo, !!jh.can_redo); })
    .catch(() => {});
  // имена юнитов — приоритет источника ЭТОЙ карты (фон; корни уже в кэше
  // бэкенда после первого запроса — повтор дешёвый, только переслияние).
  // Без открытого проекта state.project.root пуст — тогда корень берём
  // из переключателя источника карты, иначе на карте нет имён юнитов.
  try {
    const pr = (state.project && state.project.root) || cmpSrcRoot() || "";
    if (pr && typeof loadDisplayNames === "function")
      loadDisplayNames(pr, state.campaign.path);
  } catch (e) { /* имена не критичны */ }
}

function cmpSetLoading(on) {
  const el = $("#cmp-loading");
  if (el) el.hidden = !on;
}

async function cmpLoad(seq) {
  if (typeof seq !== "number") seq = ++state.campaign.loadSeq;
  const my = seq;
  const hideOwn = () => { if (my === state.campaign.loadSeq) cmpSetLoading(false); };
  cmpSetLoading(true);
  let r;
  try {
    r = await api("/api/open_file", { method: "POST",
      body: JSON.stringify({ path: state.campaign.path, reset: false }), timeout: API_TIMEOUT_OPEN });
  } catch (e) {
    if (my === state.campaign.loadSeq) toast(String((e && e.message) || e), "err");
    hideOwn();
    return;
  }
  const j = await r.json();
  if (my !== state.campaign.loadSeq) return;
  if (!j.ok) {
    toast(j.error || "error", "err");
    hideOwn();
    state.campaign.rows = null;
    cmpPaintNofile();
    return;
  }
  state.campaign.rows = j.file.rows;
  state.campaign.columns = j.file.columns || [];
  state.campaign.sel = null;
  state.campaign.unitSel = [];
  state.campaign.iconMap = {};
  state.campaign.iconsReady = false;
  if (my !== state.campaign.loadSeq) return;
  renderCampaign();
  hideOwn();
  cmpLoadMeta();
}

// справочник sysname + цены (колонка cost): первое — для автокомплита
// попапа, второе — read-only заглушка под иконкой (записи нет)
function cmpLoadMeta() {
  if (state.campaign.sysLoading || !state.campaign.path) return;
  const root = cmpSrcRoot();
  if (!root) return;
  const path = state.campaign.path;
  state.campaign.sysLoading = true;
  api("/api/uprising_sysnames", { method: "POST", body: JSON.stringify({ root }) })
    .then(r => r.json())
    .then(j => {
      if (j.ok) {
        state.campaign.sysnames = j.names || [];
        state.campaign.syscats = j.cats || {};
        if (state.campaign.path === path && cmpSrcRoot() === root) cmpPaintPanel();
      }
    })
    .catch(() => {})
    .finally(() => { state.campaign.sysLoading = false; });
  api("/api/uprising_prices", { method: "POST", body: JSON.stringify({ root }) })
    .then(r => r.json())
    .then(j => {
      if (j.ok) {
        state.campaign.prices = j.prices || {};
        state.campaign.stats = j.stats || {};
      }
      if (state.campaign.path === path && cmpSrcRoot() === root) cmpPaintPanel();
    })
    .catch(() => {});
}

// цены (колонка cost) — read-only заглушка под иконкой: читаем через
// prices(), записи нет (в попапе поле будет disabled)
function cmpLoadPrices() { cmpLoadMeta(); }

function cmpPrice(cat, name) {
  try {
    const v = ((state.campaign.prices || {})[cat] || {})[name || ""];
    return (v === undefined || v === null) ? "" : String(v).trim();
  } catch (e) { return ""; }
}

// статы species для попапа (cost/cp_cost/supply_consumption): читаются
// тем же /api/uprising_prices (stats), пишутся через /api/species_stat
function cmpStat(cat, name, col) {
  try {
    const rec = (((state.campaign.stats || {})[cat] || {})[name || ""]) || {};
    const v = rec[col];
    return (v === undefined || v === null) ? "" : String(v).trim();
  } catch (e) { return ""; }
}
// категории-юниты: у них правятся все 3 стата; у предметов — только цена
var CMP_UNIT_CATS = ["squads", "tanks", "cars", "helicopters"];

// автокомплит строго из своего файла (как карта): нет словаря — всё подряд
function cmpSysnamesFor(cat) {
  const cats = state.campaign.syscats || {};
  if (cat && Array.isArray(cats[cat]) && cats[cat].length) return cats[cat];
  return state.campaign.sysnames || [];
}

// иконки выбранного поселения — через общее ядро static/js/icons.js
// (одно на три страницы): URL-батч вместо data-URL, добивка одиночным
// /api/uprising_icon из uprChipIcon — как было. Своё здесь только карта,
// fail, готовность и перекраска панели.
// Защита от петли перерисовок: без флага полёта каждый cmpPaintPanel слал
// новый батч, ответ снова красил панель — чипы пересоздавались, спиннер
// мигал; имена без иконок запоминаем в iconFail и больше не запрашиваем
let cmpIconEng = null;
function cmpIconEngine() {
  if (cmpIconEng) return cmpIconEng;
  cmpIconEng = iconEngine({
    root: () => cmpSrcRoot(),
    map: () => (state.campaign ? state.campaign.iconMap : {}),
    fail: () => (state.campaign ? state.campaign.iconFail : {}),
    saveFail: () => {},
    ready: v => { if (state.campaign) state.campaign.iconsReady = !!v; },
    isFresh: () => !!state.campaign,
    states: (root, names) => {
      if (typeof uprEnsureIconStates === "function") {
        try { uprEnsureIconStates(root, names); } catch (e) {}
      }
    },
    onChunk: () => { try { cmpPaintPanel(); } catch (e) {} },
    onSettled: () => {
      try {
        if (state.campaign) state.campaign.iconsLoading = false;
      } catch (e) {}
    },
  });
  return cmpIconEng;
}
function cmpEnsureIcons() {
  const sel = state.campaign.sel, path = state.campaign.path;
  if (!sel || !path || state.campaign.iconsLoading) return;
  const row = cmpRowOf(sel);
  if (!row) return;
  const names = [];
  ["squads", "tanks", "cars", "helicopters", "inventory_items"].forEach(cat => {
    const ci = cmpCatCol(cat);
    if (ci !== -1) uprParseList(ci < row.values.length ? row.values[ci] : "")
      .forEach(x => { if (x.name && names.indexOf(x.name) === -1) names.push(x.name); });
  });
  const fail = state.campaign.iconFail || {};
  const miss = names.filter(n => !state.campaign.iconMap[n] && !fail[n]);
  if (!miss.length) {
    state.campaign.iconsReady = true;
    if (typeof uprEnsureIconStates === "function") {
      try { uprEnsureIconStates(cmpSrcRoot(), names); } catch (e) {}
    }
    return;
  }
  state.campaign.iconsLoading = true;
  // поселение могли переключить, пока летит батч — чужое не применяем
  // (как было: сверка sel/path перед Object.assign)
  cmpIconEngine().ensure(miss, {
    fresh: () => !!state.campaign && state.campaign.sel === sel &&
      state.campaign.path === path,
  }).catch(() => {
    try {
      if (state.campaign) state.campaign.iconsLoading = false;
    } catch (e) {}
  });
}

// пустое состояние: оверлей поверх области карты + кнопка быстрого действия
function cmpPaintNofile() {
  cmpLoadMapImg($("#cmp-map-img"), 0);
  $("#cmp-wrap").hidden = false;
  $("#cmp-nofile").hidden = false;
  const msg = $("#cmp-nofile .swt-empty");
  if (msg) msg.textContent = t("cpg_nofile") || "";
  const box = $("#cmp-nofile-actions");
  if (box) {
    box.innerHTML = "";
    const mk = (label, fn, accent) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn" + (accent ? " accent" : "");
      b.textContent = label;
      b.onclick = fn;
      box.appendChild(b);
    };
    if (!cmpSrcRoot()) {
      mk(t("open_project") || "Открыть проект", () => openProjectDialog(), true);
    } else {
      mk(t("settings") || "Настройки", () => openSettings(), true);
    }
  }
  const fp = $("#cmp-file");
  if (fp) { fp.textContent = t("cpg_sub") || ""; fp.title = ""; }
  ["#cmp-reload", "#cmp-analyze", "#cmp-open-grid", "#cmp-fs", "#cmp-resizer"]
    .forEach(s => { const el = $(s); if (el) el.hidden = true; });
  renderCampaign();
}

// источник пропал: снести состояние, вкладка — в пустое состояние
function cmpInvalidateSource() {
  state.campaign = cmpFreshState();
  if (state.activeTabId === "campaign") {
    cmpPaintNofile();
    try { renderCampaign(); } catch (e) {}
  }
  renderTabBar();
}

// ---------- background ----------
// бокс ровно под обрез фона: contain-фит 16/9 в доступную область .cmp-map.
// CSS width:100% + max-height рвал пропорции (бокс шире картинки — плитки
// на чёрных полях); поэтому размер считаем здесь, в пикселях, при каждом
// изменении геометрии (ресайз окна/панели, fullscreen, тоггл панели)
function cmpFitMap() {
  const wrap = $("#cmp-map"), box = $("#cmp-map-box");
  if (!wrap || !box) return;
  const r = wrap.getBoundingClientRect();
  const aw = Math.max(0, r.width - 16), ah = Math.max(0, r.height - 16);
  if (aw < 10 || ah < 10) return;
  const k = Math.min(aw / 16, ah / 9);
  box.style.width = Math.max(200, Math.floor(16 * k)) + "px";
  box.style.height = Math.max(120, Math.floor(9 * k)) + "px";
  cmpFitTiles();
}

// сетка на весь кадр: колонки/ряды под размер бокса и число плиток —
// плитки (1fr) всегда закрывают фон целиком, без пустот и скролла
function cmpFitTiles() {
  const box = $("#cmp-map-box"), grid = $("#cmp-tiles");
  if (!box || !grid) return;
  const n = grid.children.length;
  if (!n) return;
  const r = box.getBoundingClientRect();
  const gap = 10, pad = 24;
  const aw = Math.max(50, r.width - pad), ah = Math.max(50, r.height - pad);
  let cols = Math.ceil(Math.sqrt(n * aw / ah));
  if (cols < 1) cols = 1;
  if (cols > n) cols = n;
  const rows = Math.ceil(n / cols);
  grid.style.gridTemplateColumns = "repeat(" + cols + ", 1fr)";
  grid.style.gridTemplateRows = "repeat(" + rows + ", 1fr)";
  // иконки шапки базы — размером от ширины плитки (~9%, 12..28px):
  // в маленьком окне ужаться и не съедать заголовок, в большом —
  // в родные 28px (выше родного не тянем — поплывут)
  const icon = Math.max(12, Math.min(28, Math.round(aw / cols * 0.09)));
  grid.style.setProperty("--cmp-head-icon", icon + "px");
}
// загрузка фона GlobalMap.png с контролем зависания: копия uprLoadMapImg
// (fetch с таймаутом 15с, до 3 попыток свежим коннектом; успех — blob в <img>)
function cmpLoadMapImg(img, attempt) {
  if (!img) return;
  const url = "/assets/campaign/GlobalMap.webp?v=" + Date.now() + "&r=" + attempt;
  const ctrl = ("AbortController" in window) ? new AbortController() : null;
  let done = false;
  const timer = setTimeout(() => {
    if (done) return; done = true;
    if (ctrl) { try { ctrl.abort(); } catch (e) {} }
    if (attempt < 3) cmpLoadMapImg(img, attempt + 1);
    else img.alt = "map";
  }, 15000);
  fetch(url, { cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
    .then(r => {
      if (!r.ok) throw new Error("map http " + r.status);
      return r.blob();
    })
    .then(b => {
      if (done) return; done = true;
      clearTimeout(timer);
      img.src = URL.createObjectURL(b);
    })
    .catch(() => {
      if (done) return; done = true;
      clearTimeout(timer);
      if (attempt < 3) cmpLoadMapImg(img, attempt + 1);
      else img.alt = "map";
    });
}

// ---------- render ----------
// плитки = именованные строки base shop_presets (первая ячейка sysname);
// тестовые и демо-пресеты скрыты; сектор-строки сюда не попадают
// по построению файла, но фильтр стоит на случай смешанного файла
function cmpPresets() {
  const rows = state.campaign.rows || [];
  const out = [];
  rows.forEach((row) => {
    const sys = String((row.values && row.values[0]) || "").trim();
    if (!sys || /^sector_\d+_reward/.test(sys)) return;
    if (/^test_shop/.test(sys) || sys === "resistance_dlc_shop_demo") return;
    out.push({ sys });
  });
  return out;
}

// выбор поселения — строго одиночный (мультивыделение живёт на юнитах
// панели, см. cmpUnitToggle): тоггл .sel на месте без перестройки плиток,
// чтобы transform туда-обратно шёл плавным transition, а не рваным
// пересозданием
function cmpSelect(sys) {
  const st = state.campaign;
  if (st.sel === sys) return;
  st.sel = sys || null;
  st.unitSel = [];
  try { uprCloseEditPop(); } catch (err) {}
  const box = $("#cmp-tiles");
  if (box) {
    box.querySelectorAll(".cmp-tile").forEach(d =>
      d.classList.toggle("sel", d.dataset.sys === st.sel));
  }
  cmpPaintPanel();
}

// снять выбор полностью: поселение + набор юнитов + панель + попап
// (Esc и клик в пустое место)
function cmpClearSel() {
  const st = state.campaign;
  if (!st.sel && !(st.unitSel || []).length) return;
  st.sel = null;
  st.unitSel = [];
  try { uprCloseEditPop(); } catch (err) {}
  const box = $("#cmp-tiles");
  if (box) box.querySelectorAll(".cmp-tile.sel").forEach(d =>
    d.classList.remove("sel"));
  cmpPaintPanel();
}

// ---------- мультивыделение юнитов ----------
// Ctrl/⌘+клик по чипу — добавить/снять юнит в наборе (ключ — поселение|
// категория|позиция в списке; повторы иконок одного стека делят ключ).
// Набор живёт, пока не сменились данные (renderCampaign его сбрасывает);
// точечный тоггл — только перекраска панели
function cmpUnitKey(sys, cat, idx) {
  return sys + "|" + cat + "|" + idx;
}
function cmpUnitToggle(sys, cat, idx) {
  const st = state.campaign;
  if (!st.unitSel) st.unitSel = [];
  const k = cmpUnitKey(sys, cat, idx);
  const i = st.unitSel.indexOf(k);
  if (i === -1) st.unitSel.push(k);
  else st.unitSel.splice(i, 1);
  cmpPaintPanel();
}
// ключи набора -> живые записи {sys, cat, idx, name, n}
// (протухшие после правок ключи молча отбрасываются)
function cmpSelUnits() {
  const out = [];
  (state.campaign.unitSel || []).forEach(k => {
    const p = String(k).split("|");
    if (p.length !== 3) return;
    const ri = cmpRowIdx(p[0]), ci = cmpCatCol(p[1]);
    if (ri === -1 || ci === -1) return;
    const items = uprParseList(state.campaign.rows[ri].values[ci] || "");
    const it = items[+p[2]];
    if (it && it.name) out.push({ sys: p[0], cat: p[1],
      idx: +p[2], name: it.name, n: it.n });
  });
  return out;
}

// картинка плитки (арт сектора + иконки шапки): исходник — в data-cmp-src,
// битая — один ретрай свежим URL (?r=минута мимо кэша диска), затем убрать.
// Рваный HTTP/1.0-коннект часто не даёт error вообще — такие зависшие
// добирает cmpReloadImages (кнопка reload + досмотр после отрисовки)
function cmpTileImg(img, url) {
  img.dataset.cmpSrc = url;
  img.src = url;
  img.onerror = () => {
    if (!img.dataset.cmpRetry) {
      img.dataset.cmpRetry = "1";
      img.src = url + (url.indexOf("?") === -1 ? "?r=" : "&r=") + Date.now();
    } else { try { img.remove(); } catch (e) {} }
  };
}
// досмотр недогруженных: complete без ширины или висящая загрузка —
// перезапросить свежим URL; возвращает число перезапущенных
function cmpReloadImages() {
  const box = $("#cmp-tiles");
  if (!box) return 0;
  let n = 0;
  box.querySelectorAll("img[data-cmp-src]").forEach(img => {
    if (!img.isConnected) return;
    let ok = false;
    try { ok = img.complete && img.naturalWidth > 0; } catch (e) {}
    if (ok) return;
    try {
      const base = img.dataset.cmpSrc || "";
      if (!base) return;
      delete img.dataset.cmpRetry;
      img.src = base + (base.indexOf("?") === -1 ? "?r=" : "&r=") + Date.now();
      n++;
    } catch (e) {}
  });
  return n;
}
let cmpImgSweepT = 0;

function renderCampaign() {
  if (!cmpTab()) return;
  const box = $("#cmp-tiles");
  if (box) {
    box.innerHTML = "";
    for (const p of cmpPresets()) {
      const d = document.createElement("div");
      d.className = "cmp-tile"
        + (state.campaign.sel === p.sys ? " sel" : "");
      d.dataset.sys = p.sys;
      // ховер — кастомный .tip (chrome.js), а не нативный title: первой
      // строкой имя, второй — описание из description; без описания —
      // только имя, как раньше. Нативный title убран, иначе поверх
      // кастомной всплывала бы ещё и системная подсказка
      d.addEventListener("mouseover", e => {
        const ds = cmpDescOf(p.sys);
        showTip(e, ds ? cmpSettlementName(p.sys) + "\n" + ds : cmpSettlementName(p.sys));
      });
      d.addEventListener("mouseleave", () => hideTip());
      const head = document.createElement("div");
      head.className = "cmp-tile-head";
      const nm = document.createElement("span");
      nm.className = "cmp-tile-name";
      nm.textContent = cmpSettlementName(p.sys);
      head.appendChild(nm);
      // плитки с иконками (cmpTileIcons): имя заглавными (класс) +
      // иконки особенностей справа (полный набор или свой, как у Таоса)
      const tileIcons = cmpTileIcons(p.sys);
      if (tileIcons) {
        d.classList.add("cmp-tile-base");
        const ti = document.createElement("span");
        ti.className = "cmp-head-icons";
        tileIcons.forEach(f => {
          const im = document.createElement("img");
          cmpTileImg(im, "/assets/campaign/" + f);
          im.alt = "";
          im.draggable = false;
          ti.appendChild(im);
        });
        head.appendChild(ti);
      }
      const body = document.createElement("div");
      body.className = "cmp-tile-body";
      const simg = cmpSectorImg(p.sys);
      if (simg) {
        const si = document.createElement("img");
        cmpTileImg(si, simg);
        si.alt = "";
        si.draggable = false;
        body.appendChild(si);
      } else {
        body.textContent = p.sys;
      }
      d.appendChild(head);
      d.appendChild(body);
      d.onclick = () => cmpSelect(p.sys);
      d.oncontextmenu = e => cmpTileCtx(e, p.sys);
      box.appendChild(d);
    }
    cmpFitTiles();
  }
  cmpPaintPanel();
  // досмотр зависших картинок (рваный коннект без error): один проход
  // через 5с после отрисовки; предыдущий таймер сбрасываем
  try {
    if (cmpImgSweepT) clearTimeout(cmpImgSweepT);
    cmpImgSweepT = setTimeout(() => { cmpImgSweepT = 0; cmpReloadImages(); }, 5000);
  } catch (e) {}
}

function cmpPaintPanel() {
  const body = $("#cmp-panel-body");
  if (!body) return;
  const main = $("#cmp-panel-body");
  const st = main ? main.scrollTop : 0;
  const tab = state.campaign.tab || "shop";
  body.innerHTML = "";
  body.dataset.cmpTab = tab;
  const sel = state.campaign.sel;
  const row = sel ? cmpRowOf(sel) : null;
  const head = $("#cmp-panel-head");
  const tabs = $("#cmp-tabs");
  if (!row) {
    // поселение не выбрано: прячем и заголовок, и рельс вкладок
    // (shop/hire/supplies) — панели нечего показывать, только подсказку
    if (head) head.hidden = true;
    if (tabs) tabs.hidden = true;
    const div = document.createElement("div");
    div.className = "swt-empty";
    div.dataset.i18n = "cpg_pick";
    div.textContent = t("cpg_pick") || "Выберите поселение";
    body.appendChild(div);
    if (main) main.scrollTop = st;
    return;
  }
  // заголовок поселения — отдельным рядом на всю ширину панели
  // (окно предметов + рельс вкладок); имя — локализованное, у плиток
  // с иконками (cmpTileIcons) — заглавными (класс ставит регистр через CSS)
  if (head) {
    head.hidden = false;
    // имя — в свой спан с обрезкой (флекс-шапка), справа — переключатель
    // вида иконок slot/classic (общий флаг с картой, uprising.js)
    head.innerHTML = "";
    const nm = document.createElement("span");
    nm.className = "cmp-panel-name";
    nm.textContent = cmpSettlementName(sel);
    nm.title = sel;
    head.appendChild(nm);
    try { if (typeof uprViewToggle === "function") head.appendChild(uprViewToggle()); } catch (e) {}
    try { if (typeof uprLocToggle === "function") head.appendChild(uprLocToggle()); } catch (e) {}
    head.title = sel;
    head.classList.toggle("cmp-head-base",
      cmpTileIcons(sel) !== null);
    // подсказка под заголовком: описание из колонки description.
    // Нет описания — блока нет вообще; ширина панели не меняется
    // (блок — wrapped-ряд шапки flex-basis 100%, текст переносится)
    const cdesc = cmpDescOf(sel);
    if (cdesc) {
      const dd = document.createElement("div");
      dd.className = "cmp-desc";
      const dq = document.createElement("span");
      dq.className = "cmp-desc-q";
      dq.textContent = "?";
      dq.setAttribute("aria-hidden", "true");
      const dt = document.createElement("span");
      dt.className = "cmp-desc-t";
      dt.textContent = cdesc;
      dd.appendChild(dq);
      dd.appendChild(dt);
      head.appendChild(dd);
    }
  }
  // поселение выбрано — рельс вкладок снова виден
  if (tabs) tabs.hidden = false;
  if (tab === "supplies") {
    const div = document.createElement("div");
    div.className = "swt-empty";
    div.dataset.i18n = "cpg_supplies_soon";
    div.textContent = t("cpg_supplies_soon") || "Снабжение — позже";
    body.appendChild(div);
  } else {
    const cats = tab === "hire"
      ? ["squads", "cars", "tanks", "helicopters"]
      : ["inventory_items"];
    let shown = 0;
    cats.forEach(cat => {
      const ci = cmpCatCol(cat);
      if (ci === -1) return;
      const items = uprParseList(ci < row.values.length ? row.values[ci] : "");
      // наём: все 4 категории видны всегда, даже пустые (пустая — только
      // шапка + кнопка «+», добавление через неё же); магазин как был —
      // пустую секцию товаров не показываем
      if (!items.length && tab !== "hire") return;
      shown++;
      const sec = document.createElement("div");
      sec.className = "cmp-sec";
      // шапка есть у всех секций, включая товары: у inventory_items она —
      // невидимая распорка (visibility:hidden) той же высоты, что иконки
      // найма, иначе при переходе shop<->hire столбец прыгает вверх/вниз
      // на высоту шапки; заголовки-иконки видны только у юнитов найма
      {
        const title = document.createElement("div");
        title.className = "upr-cat-title";
        const label = t("upr_cat_" + cat) || cat;
        title.title = label;
        if (cat !== "inventory_items") {
          if (CMP_CAT_ICONS[cat]) {
            const timg = document.createElement("img");
            timg.className = "cmp-sec-icon";
            timg.src = cmpCatIcon(cat);
            timg.alt = label;
            timg.draggable = false;
            timg.onerror = () => {
              try { title.textContent = label; } catch (e) {}
            };
            title.appendChild(timg);
          } else title.textContent = label;
        } else {
          // распорка: та же иконка supply_vehicle, но скрыта целиком —
          // раскладка один в один как у видимых шапок при любом CSS
          title.classList.add("cmp-sec-spacer");
          title.setAttribute("aria-hidden", "true");
          const timg = document.createElement("img");
          timg.className = "cmp-sec-icon";
          timg.src = cmpCatIcon(cat);
          timg.alt = "";
          timg.draggable = false;
          title.appendChild(timg);
        }
        sec.appendChild(title);
      }
      const list = document.createElement("div");
      list.className = "upr-cat-body";
      list.dataset.cat = cat;
      // количество — повтором иконок (mount_slot_item:2 = две иконки),
      // надписи ×n нет ни на чипе, ни в подсказке; все копии ссылаются
      // на одну запись стека (правка/перенос/удаление — целиком)
      items.forEach((it, idx) => {
        const reps = Math.max(1, it.n | 0);
        for (let k = 0; k < reps; k++)
          list.appendChild(cmpChip(sel, cat, items, idx));
      });
      // плюс последним в ряду — как .upr-chip-add на карте Uprising
      const add = document.createElement("button");
      add.className = "upr-chip-add";
      add.title = t("upr_add") || "Добавить";
      add.setAttribute("aria-label", t("upr_add") || "Добавить");
      const addImg = document.createElement("img");
      addImg.className = "upr-chip-add-icon";
      addImg.src = "/assets/UprisingMap/add_unit.webp";
      addImg.alt = "";
      addImg.draggable = false;
    add.appendChild(addImg);
    if (typeof uprAddBtn === "function") uprAddBtn(add, addImg);
    add.onclick = ev => { ev.stopPropagation(); cmpAddNew(sel, cat, add); };
      list.appendChild(add);
      // вставка из буфера правым кликом по пустому месту секции
      list.oncontextmenu = e => {
        if (e.target === list) cmpSecCtx(e, sel, cat);
      };
      sec.appendChild(list);
      body.appendChild(sec);
    });
    if (!shown) {
      const div = document.createElement("div");
      div.className = "swt-empty";
      div.dataset.i18n = "cpg_empty";
      div.textContent = t("cpg_empty") || "Нет записей";
      body.appendChild(div);
    }
    cmpEnsureIcons();
  }
  if (main) main.scrollTop = st;
}

// строка пресета по sysname; индекс колонки по имени заголовка;
// индекс строки — для записи ячеек
function cmpRowOf(sys) {
  return (state.campaign.rows || []).find(
    r => String((r.values && r.values[0]) || "").trim() === sys) || null;
}
function cmpRowIdx(sys) {
  return (state.campaign.rows || []).findIndex(
    r => String((r.values && r.values[0]) || "").trim() === sys);
}
function cmpCatCol(cat) {
  return (state.campaign.columns || []).indexOf(cat);
}

// описание поселения из колонки description (читаем по имени, не по
// индексу — порядок колонок гуляет между источниками Проект/Игра/Мод).
// Перевод — ключом cmp_desc_<sys> из локалей интерфейса (en/de/zh);
// русского ключа нет специально: сырой текст файла и есть русский, он же
// фолбэк, когда перевода нет (t возвращает сам ключ). Пусто — "".
function cmpDescCol() {
  return (state.campaign.columns || []).indexOf("description");
}
function cmpDescOf(sys) {
  const key = "cmp_desc_" + sys;
  let loc = "";
  try { loc = t(key); } catch (e) { loc = ""; }
  if (loc && loc !== key) return loc;
  const ci = cmpDescCol();
  if (ci === -1) return "";
  const row = cmpRowOf(sys);
  if (!row) return "";
  return String((row.values && ci < row.values.length ? row.values[ci] : "") || "").trim();
}

// широкие иконки (w/h ≥ 1.3: 136x72, 148x72) занимают две колонки
// сетки 4×72px (.cmp-span); квадраты (1.0: 72x72, 60x60) — одну.
// Только спан, размеров не трогаем — иконки в родных размерах файлов
function cmpSpanChip(chip, img) {
  try {
    const w = img.naturalWidth || 0, h = img.naturalHeight || 0;
    if (w && h && w / h >= 1.3) chip.classList.add("cmp-span");
  } catch (e) {}
}
// read-only чип — та же структура, что карточка Uprising (uprChipEditor):
// чистая иконка без подписей (.upr-chip.upr-card из uprising.css, зазоры —
// .upr-cat-body оттуда же); цена — шильдик .cmp-price-badge поверх иконки,
// имя — в подсказке (без ×n: количество видно повтором иконок). Даблклик — попап, весь чип — ручка переноса, ПКМ — меню
function cmpChip(sys, cat, items, i) {
  const it = items[i];
  const chip = document.createElement("span");
  chip.className = "upr-chip upr-card";
  chip.dataset.ukey = cmpUnitKey(sys, cat, i);
  if ((state.campaign.unitSel || []).indexOf(chip.dataset.ukey) !== -1)
    chip.classList.add("sel");
  const pv = cmpPrice(cat, it.name);
  // имя — локализованное сверху при включённой локализации, sysname виден
  // всегда (правка идёт по sysname)
  const dn = (typeof uprUnitName === "function") ? uprUnitName(it.name) : it.name;
  chip.title = (dn !== it.name ? dn + "\n" : "") + it.name
    + (pv === "" ? "" : "\n" + (t("cpg_cost") || "Cost") + ": " + pv);
  const img = document.createElement("img");
  img.className = "upr-chip-icon";
  img.draggable = false;
  img.loading = "lazy";
  img.alt = "";
  // спиннером владеет общий хелпер uprChipIcon (ставит только при реальном
  // ожидании иконки) — без дубля здесь, иначе мигание при каждом рендере
  // иконка через общий хелпер карты: мгновенный плейсхолдер категории
  // (предметы — squads-плейсхолдер) под спиннером, реальная подменяет;
  // карта иконок у кампании своя
  if (typeof uprChipIcon === "function")
    uprChipIcon(img, chip, it.name, cat,
      { map: state.campaign.iconMap, ready: state.campaign.iconsReady,
        fail: state.campaign.iconFail });
  else img.src = uprIconUrl(it.name, cat);
  // data-URL из кэша может быть complete до первого onload — спан ставим
  // сразу, иначе широкая иконка займёт одну колонку до перерисовки
  if (img.complete && img.naturalWidth) cmpSpanChip(chip, img);
  chip.appendChild(img);
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
    chip.appendChild(badge);
  }
  chip.ondblclick = e => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    cmpEditPop(chip, sys, cat, items, i);
  };
  // Ctrl/⌘+клик — в набор/из набора (мультивыделение юнитов);
  // обычный клик по чипу ничего не делает (правка — даблклик/ПКМ)
  chip.onclick = e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (!it.name) return;
    e.stopPropagation();
    cmpUnitToggle(sys, cat, i);
  };
  chip.onmousedown = e => {
    if (e.button !== 0 || !it.name) return;
    if (e.ctrlKey || e.metaKey) return;
    if (e.target.closest("input,button")) return;
    e.preventDefault();
    cmpDragStart(e, sys, cat, items, i, chip);
  };
  chip.oncontextmenu = e => cmpChipCtx(e, sys, cat, items, i);
  // ЭКСПЕРИМЕНТ «слот техники»: фон + sysname + полоса мест
  if (typeof vehDecor === "function") vehDecor(chip, it.name, cat, cmpSrcRoot());
  return chip;
}

// картинки-кнопки вкладок: выбрана — "p", не выбрана — "a",
// не выбрана + наведение — "n", клик (пресс) — "o".
// Нет файла — CSS-тонирование (.noimg)
function cmpTabImg(tab, st) {
  return "/assets/campaign/button_" + tab + "_" + st + ".webp";
}
function cmpTabBase(tab) {
  return cmpTabImg(tab, tab === (state.campaign.tab || "shop") ? "p" : "a");
}
function cmpPaintTabs() {
  const tabs = $("#cmp-tabs");
  if (!tabs) return;
  const cur = state.campaign.tab || "shop";
  tabs.querySelectorAll(".cmp-tab-btn").forEach(b => {
    const tb = b.dataset.cmpTab;
    const on = tb === cur;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on);
    let img = b.querySelector("img");
    if (!img) { img = document.createElement("img"); img.alt = ""; b.prepend(img); }
    if (!b.dataset.cmpImgInit) {
      b.dataset.cmpImgInit = "1";
      b._cmpDown = false;
      img.onerror = () => b.classList.add("noimg");
      // пресс — только неактивной ("o"); активная не дёргается
      b.addEventListener("mousedown", () => {
        if (b.classList.contains("active")) return;
        b._cmpDown = true;
        img.src = cmpTabImg(tb, "o");
      });
      b.addEventListener("mouseup", () => {
        if (!b._cmpDown) return;
        b._cmpDown = false;
        img.src = cmpTabBase(tb);
      });
      b.addEventListener("mouseleave", () => {
        b._cmpDown = false;
        img.src = cmpTabBase(tb);
      });
      // ховер неактивной — кадр "n"
      b.addEventListener("mouseenter", () => {
        if (b.classList.contains("active") || b._cmpDown) return;
        img.src = cmpTabImg(tb, "n");
      });
    }
    if (!b._cmpDown) img.src = cmpTabBase(tb);
  });
}
// ---------- запись ----------
// батч ассортимента в /api/edit_cells (save:false): оптимистично в память,
// при отказе — откат по stash; та же сериализация, что таблица
async function cmpWriteCells(edits, summary) {
  const cells = [];
  const stash = [];
  (edits || []).forEach(e => {
    if (!e || !state.campaign.rows[e.ri]) return;
    const val = (e.val !== undefined) ? e.val
      : uprJoinList(((e.items) || []).filter(x => x.name));
    const old = state.campaign.rows[e.ri].values[e.ci];
    if (old === val) return;
    stash.push({ ri: e.ri, ci: e.ci, old });
    state.campaign.rows[e.ri].values[e.ci] = val;
    cells.push({ row: e.ri, col: e.ci, value: val, type: "String" });
  });
  cmpMarkDirty();
  if (!cells.length) return true;
  let j = null;
  try {
    const body = { path: state.campaign.path, cells, save: false };
    if (summary) body.summary = String(summary).slice(0, 160);
    const r = await api("/api/edit_cells", { method: "POST",
      body: JSON.stringify(body) });
    try { j = await r.json(); } catch (e) { j = null; }
  } catch (e) { j = null; }
  if (!j || !j.ok) {
    stash.forEach(s => {
      if (state.campaign.rows[s.ri]) state.campaign.rows[s.ri].values[s.ci] = s.old;
    });
    renderCampaign();
    toast((j && j.error) || "campaign write failed", "err");
    return false;
  }
  state.campaign.redoHint = "";
  try { await cmpSyncUndoButtons(); } catch (e) {}
  // успешная запись могла сдвинуть позиции стеков — набор юнитов сбросить,
  // иначе протухшие ключи указывали бы не на те записи
  state.campaign.unitSel = [];
  // часть ячеек не легла (мимо строк/колонок): сообщить, сколько потеряно
  if (j.skipped) {
    toast((t("cpg_cells_skipped") || "Не записано ячеек: {k} (нет таких строк/колонок)")
      .replace("{k}", j.skipped), "err");
  }
  try { cmpSyncFileTabs(state.campaign.path, cells); } catch (e) {}
  return true;
}

// запись статов юнита/предмета в species-файл (cost/cp_cost/
// supply_consumption): бэкенд правит первым файлом со строкой sysname
// (base, затем DLC — как чтение цен). По возврату вливаем в кэш цен
// и статов и перекрашиваем панель — шильдик обновляется динамически;
// открытые таблицы того же species-файла подтягиваем следом
function cmpWriteStats(cat, name, stats) {
  const root = cmpSrcRoot();
  if (!root || !name) return Promise.resolve(false);
  // save:true — у species-файла нет своей кнопки сохранения в кампании
  // (как пакетная замена); тихая запись в защищённую папку режется бэкендом
  // (SavePipeline.autosaved), тогда по флагу saved:false показываем тот же
  // явный guard-попап «в проект/мод», что у остальных сейвов
  return api("/api/species_stat", { method: "POST",
    body: JSON.stringify({ root, cat, name, stats, save: true }) })
    .then(r => r.json())
    .then(async j => {
      if (!j || !j.ok) {
        toast(cmpStatErr(j, cat, name, stats), "err");
        return false;
      }
      // часть колонок не записалась (их нет в файле): предупредить,
      // какие значения потеряны, а не молчать
      if (j.skipped && j.skipped.length) {
        toast((t("cpg_stat_skipped") || "Не записано в {file} ({cols}): нет таких колонок")
          .replace("{file}", ((j.path || "").split(/[\\/]/).pop() || ""))
          .replace("{cols}", j.skipped.join(", ")), "err");
      }
      const st = state.campaign.stats[cat] || (state.campaign.stats[cat] = {});
      const cur = st[name] || (st[name] = {});
      Object.keys(stats).forEach(k => { cur[k] = stats[k]; });
      if (stats.cost !== undefined) {
        const pr = state.campaign.prices[cat] || (state.campaign.prices[cat] = {});
        pr[name] = stats.cost;
      }
      // вместимость правит и кэш полос vehCapMap (uprising.js, слот рисует
      // полосу по нему): полоса на иконке появляется/гаснет сразу, без
      // refetch; чужой корень не трогаем — там vehDecor доберёт сам
      try {
        if (stats.people_capacity !== undefined
            && typeof vehCapMap !== "undefined" && vehCapMap
            && (typeof uprSrcRoot !== "function" || uprSrcRoot() === root)) {
          vehCapMap[name] = String(parseInt(stats.people_capacity, 10) || 0);
        }
      } catch (e) {}
      try {
        cmpSyncFileTabs(j.path, (j.cells || []).map(c => (
          { row: c.row, col: c.col, value: c.value })));
      } catch (e) {}
      // тихая запись не прошла (защищённый файл распакованной игры) —
      // явный попап «в проект/мод», иначе цена «сохраняется» в никуда:
      // на диске защищённой папки ничего нет, правки только в памяти
      if (!j.saved) {
        try {
          await guardedSave("file", j.path, async target => {
            if (!target) return; // guard выключен/файл не защищён
            const sj = await saveAsTo(j.path, "file", target);
            if (sj.ok && sj.saved) {
              toast((t("save_success") || "Сохранено") + " → " + sj.dst, "ok");
              try { await noteExternalTreeChange(target); } catch (e) {}
            }
            else toast((sj.error || t("save_failed") || "save failed"), "err");
          }, false);
        } catch (e) {}
      }
      // species-правка живёт в чужом файле: запомнить для undo/redo
      // и истории страницы, новая правка гасит чужой redo-хвост
      try {
        if (j.path) state.campaign.statPaths[j.path] = true;
        state.campaign.redoHint = "";
        cmpSyncUndoButtons();
      } catch (e) {}
      renderCampaign();
      return true;
    })
    .catch(e => { toast(String((e && e.message) || e), "err"); return false; });
}

// текст ошибки записи стата: код бэкенда -> понятное сообщение с именем
// юнита и файлом (а не сырой "no such unit")
function cmpStatErr(j, cat, name, stats) {
  const code = j && j.error;
  const file = (j && (j.file || ((j.path || "").split(/[\\/]/).pop()))) || "";
  const cols = ((j && j.columns) || Object.keys(stats || {})).join(", ");
  if (code === "no_species_file") {
    return (t("cpg_stat_nofile") || "Нет файла {file}: значение «{name}» записать некуда")
      .replace("{file}", file).replace("{name}", name);
  }
  if (code === "no_such_unit") {
    return (t("cpg_stat_nounit") || "Юнит «{name}» не найден в {file}: значение не записано")
      .replace("{file}", file).replace("{name}", name);
  }
  if (code === "no_stat_column") {
    return (t("cpg_stat_nocol") || "В {file} нет колонок ({cols}): «{name}» не записан")
      .replace("{file}", file).replace("{cols}", cols).replace("{name}", name);
  }
  void cat;
  return (code || "species write failed");
}

// значения — в открытые таблицы указанного файла (кампания или species):
// общий хелпер подменяет ячейки, красит дискету и помечает неактивные
// вкладки stale (перерисуются при возврате — см. activateTab)
function cmpSyncFileTabs(path, cells) {
  try { return syncFileTabsCells(path, cells); }
  catch (e) { return false; }
}

// история страницы — два файла: карта + species-правки попапа (unit_set,
// cost...). undo/redo берут файл с самой свежей записью, кнопки — ИЛИ.
function cmpHistPaths() {
  try {
    const ps = [state.campaign.path]
      .concat(Object.keys(state.campaign.statPaths || {}));
    return ps.filter((p, i) => p && ps.indexOf(p) === i);
  } catch (e) { return state.campaign.path ? [state.campaign.path] : []; }
}
async function cmpSyncUndoButtons() {
  try {
    const rs = await Promise.all(cmpHistPaths().map(p =>
      api("/api/history?path=" + encodeURIComponent(p))
        .then(r => r.json()).catch(() => null)));
    setUndoRedoButtons(rs.some(j => j && j.ok && j.can_undo),
      rs.some(j => j && j.ok && j.can_redo));
  } catch (e) {}
}
// перечитать строки с сервера после undo/redo (dirty не трогаем: откат —
// тоже несохранённое изменение)
async function cmpRepaintUndo() {
  try {
    const r = await api("/api/open_file", { method: "POST",
      body: JSON.stringify({ path: state.campaign.path, reset: false }) });
    const j = await r.json();
    if (j.ok && j.file) {
      state.campaign.rows = j.file.rows;
      state.campaign.columns = j.file.columns || [];
      renderCampaign();
    }
  } catch (e) {}
  // статы могли откатиться в species-файле — перечитать, иначе шильдики
  // покажут старое; кнопки — ИЛИ по всем файлам истории страницы
  try { cmpLoadMeta(); } catch (e) {}
  await cmpSyncUndoButtons();
}

async function cmpSave() {
  if (!state.campaign.path) return;
  const r = await api("/api/save", { method: "POST",
    body: JSON.stringify({ path: state.campaign.path }) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "error", "err"); return; }
  cmpMarkClean();
  toast(t("saved") || "Сохранено", "ok");
}

async function cmpSaveGuarded(popup) {
  if (!state.campaign.path) return;
  return guardedSave("campaign", state.campaign.path, async target => {
    if (target) {
      const j = await saveAsTo(state.campaign.path, "campaign", target);
      if (j.ok && j.saved) {
        cmpMarkClean();
        toast((t("saved") || "Сохранено") + " → " + j.dst, "ok");
        if (j.dst && j.dst !== state.campaign.path) {
          await noteExternalTreeChange(target);
          state.campaign.path = j.dst;
          await cmpLoad();
        }
      }
      else toast((j.error || "error"), "err");
      return;
    }
    await cmpSave();
  }, popup);
}

// ---------- попап правки ----------
// даблклик / ПКМ → «Редактировать»: sysname, количество, cost (запись
// в cost species-файла, шильдик обновляется сам), у юнитов ещё cp_cost
// и расход припасов, у техники — вместимость (полоса на иконке); удаление.
// Стили — .upr-edit-pop (общие с картой)
function cmpEditPop(cellEl, sys, cat, items, i, isNew) {
  uprCloseEditPop();
  const it = items[i];
  if (!it) return;
  if (!(state.campaign.sysnames || []).length) cmpLoadMeta();
  const commitCell = () => {
    const ri = cmpRowIdx(sys), ci = cmpCatCol(cat);
    if (ri === -1 || ci === -1) return Promise.resolve(false);
    // без .then(render): рендер один, в конце commit — иначе второй
    // перерисов убивал FLIP-перелёт чипа в новую секцию на старте
    return cmpWriteCells([{ ri, ci, val: uprJoinList(items.filter(x => x.name)) }]);
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
  const rowS = mkRow(t("upr_f_sysname") || "Системное имя",
    (t("upr_f_from") || "sysname из ") + (cat || "") + ".xml");
  const nm = document.createElement("input");
  nm.type = "text";
  nm.className = "upr-chip-name";
  nm.value = it.name || "";
  nm.spellcheck = false;
  nm.placeholder = t("upr_add_ph") || "sysname";
  swtAutocomplete(nm, () => cmpSysnamesFor(cat), v => { nm.value = v; }, { openOnFocus: false });
  rowS.appendChild(nm);
  const rowN = mkRow(t("upr_f_count") || "Количество",
    t("upr_f_count_d") || "сколько единиц, минимум 1");
  const cnt = document.createElement("input");
  cnt.type = "number";
  cnt.min = "1";
  cnt.className = "mini";
  cnt.value = it.n;
  rowN.appendChild(cnt);
  // cost — запись в cost species-файла (шильдик обновится сам);
  // у юнитов ещё cp_cost и расход припасов; на шильдик ничего нового
  const rowP = mkRow(t("cpg_cost") || "Cost",
    t("cpg_cost_d") || "запись в cost species-файла");
  const prc = document.createElement("input");
  prc.type = "text";
  prc.className = "mini";
  prc.spellcheck = false;
  prc.value = cmpPrice(cat, it.name);
  rowP.appendChild(prc);
  let cpInp = null, supInp = null;
  if (CMP_UNIT_CATS.indexOf(cat) !== -1) {
    const rowC = mkRow(t("cpg_cp_cost") || "CP-стоимость",
      t("cpg_cp_cost_d") || "запись в cp_cost");
    cpInp = document.createElement("input");
    cpInp.type = "text";
    cpInp.className = "mini";
    cpInp.spellcheck = false;
    cpInp.value = cmpStat(cat, it.name, "cp_cost");
    rowC.appendChild(cpInp);
    const rowU = mkRow(t("cpg_supply") || "Расход припасов",
      t("cpg_supply_d") || "запись в supply_consumption");
    supInp = document.createElement("input");
    supInp.type = "text";
    supInp.className = "mini";
    supInp.spellcheck = false;
    supInp.value = cmpStat(cat, it.name, "supply_consumption");
    rowU.appendChild(supInp);
  }
  // вместимость — только техника (cars/tanks/helicopters): запись
  // в people_capacity; полоса на иконке появится/обновится сама
  // (кэш vehCapMap правим в cmpWriteStats)
  let capInp = null;
  if (["cars", "tanks", "helicopters"].indexOf(cat) !== -1) {
    const rowV = mkRow(t("cpg_capacity") || "Вместимость",
      t("cpg_capacity_d") || "запись в people_capacity: мест в технике");
    capInp = document.createElement("input");
    capInp.type = "text";
    capInp.className = "mini";
    capInp.spellcheck = false;
    capInp.value = cmpStat(cat, it.name, "people_capacity");
    rowV.appendChild(capInp);
  }
  // класс техники (unit_set) — то же комбо, что в таблице cars/tanks;
  // только запись пула доступности, без переносов между секциями.
  // Squads/heli уникальны — им поле не нужно, только cars/tanks.
  let setInp = null;
  if (["cars", "tanks"].indexOf(cat) !== -1) {
    const rowU = mkRow(t("upr_f_unitset") || "Класс",
      t("upr_f_unitset_d") || "запись в unit_set species-файла");
    const setHold = document.createElement("div");
    setHold.className = "upr-edit-set";
    setInp = document.createElement("input");
    setInp.type = "text";
    setInp.spellcheck = false;
    setInp.placeholder = "unit_set";
    setInp.value = cmpStat(cat, it.name, "unit_set");
    if (typeof makeUnitSetCombo === "function" &&
        typeof unitSetChoices === "function")
      makeUnitSetCombo(setHold, setInp, unitSetChoices([setInp.value]), "unit_set");
    else setHold.appendChild(setInp);
    rowU.appendChild(setHold);
  }
  const btns = document.createElement("div");
  btns.className = "upr-edit-btns";
  // «Расширенные» — первой в ряду (CSS прижимает влево): уход в редактор
  // юнитов с выбором этого юнита; закрытие — как «Отмена»
  const advB = document.createElement("button");
  advB.className = "btn sm ghost upr-adv-btn";
  advB.title = t("upr_advanced") || "Расширенные";
  advB.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08A1.7 1.7 0 0 0 10.12 3V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03z"/></svg>';
  const advT = document.createElement("span");
  advT.textContent = t("upr_advanced") || "Расширенные";
  advB.appendChild(advT);
  const delB = document.createElement("button");
  delB.className = "btn sm danger";
  delB.textContent = t("delete") || "Удалить";
  const canB = document.createElement("button");
  canB.className = "btn sm ghost";
  canB.textContent = t("cancel") || "Отмена";
  const okB = document.createElement("button");
  okB.className = "btn sm accent";
  okB.textContent = t("save") || "Сохранить";
  btns.append(advB, delB, canB, okB);
  pop.appendChild(btns);

  let closed = false;
  const commit = async save => {
    if (closed) return;
    if (!save && isNew) {
      items.splice(i, 1);
      commitCell();
    } else if (save) {
      const name = nm.value.trim();
      if (!name) {
        items.splice(i, 1);
      } else {
        it.name = name;
        it.n = Math.max(1, parseInt(cnt.value, 10) || 1);
        // статы species — только изменившееся и непустое; без имени
        // писать не во что. Шильдик обновится сам по возврату записи
        const diff = {};
        const put = (col, el) => {
          if (!el) return;
          const v = el.value.trim();
          if (v !== "" && v !== cmpStat(cat, name, col)) diff[col] = v;
        };
        put("cost", prc);
        put("cp_cost", cpInp);
        put("supply_consumption", supInp);
        put("people_capacity", capInp);
        put("unit_set", setInp);
        if (Object.keys(diff).length) await cmpWriteStats(cat, name, diff);
      }
      commitCell();
    }
    closed = true;
    document.removeEventListener("mousedown", outside, true);
    uprCloseEditPop();
    renderCampaign();
  };
  const outside = e => {
    // выпадашки автокомплита и комбо классов живут в body вне поповера —
    // клик по ним не «мимо»
    if (e.target.closest && (e.target.closest(".swt-ac-panel") ||
        e.target.closest(".unit-combo-pop"))) return;
    if (uprEditPopEl && !uprEditPopEl.contains(e.target)) commit(false);
  };
  delB.onclick = e => {
    e.stopPropagation();
    if (isNew) { commit(false); renderCampaign(); return; }
    commit(false); items.splice(i, 1); commitCell(); renderCampaign();
  };
  canB.onclick = e => { e.stopPropagation(); commit(false); };
  okB.onclick = e => { e.stopPropagation(); commit(true); };
  advB.onclick = e => {
    e.stopPropagation();
    const name = (nm.value || "").trim() || (it.name || "");
    if (typeof uprEditPopCloser === "function") {
      try { uprEditPopCloser(); } catch (err) { /* попап уже закрыт */ }
    }
    if (name && typeof untOpenUnit === "function") untOpenUnit(cat, name);
    else if (typeof openUnits === "function") openUnits();
  };
  [nm, cnt, prc, cpInp, supInp, capInp, setInp].forEach(el => {
    if (!el) return;
    el.addEventListener("keydown", ev => {
      if (ev.key === "Enter") { ev.preventDefault(); commit(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); commit(false); }
    });
    el.addEventListener("mousedown", ev => ev.stopPropagation());
  });
  pop.addEventListener("mousedown", ev => ev.stopPropagation());
  document.addEventListener("mousedown", outside, true);

  document.body.appendChild(pop);
  uprEditPopEl = pop;
  uprEditPopCloser = () => commit(false);
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const r = cellEl && cellEl.getBoundingClientRect
    ? cellEl.getBoundingClientRect()
    : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0, bottom: innerHeight / 2 };
  let x = r.left + r.width / 2 - pw / 2;
  let y = r.bottom + 6;
  if (y + ph > innerHeight - 8) y = r.top - ph - 6;
  if (y < 8) y = Math.max(8, (innerHeight - ph) / 2);
  x = Math.min(Math.max(8, x), innerWidth - pw - 8);
  pop.style.left = x + "px";
  pop.style.top = y + "px";
  setTimeout(() => { nm.focus(); nm.select(); }, 0);
}

// добавление: та же модалка (имя + количество сразу), пустой чистится сам
function cmpAddNew(sys, cat, anchorEl) {
  const ri = cmpRowIdx(sys), ci = cmpCatCol(cat);
  if (ri === -1 || ci === -1) return;
  const items = uprParseList(state.campaign.rows[ri].values[ci] || "");
  const tmp = { name: "", n: 1 };
  items.push(tmp);
  cmpEditPop(anchorEl, sys, cat, items, items.length - 1, true);
  // окно правки открыто с кнопки add — подсветка _h до закрытия
  if (typeof uprAddOpen === "function") uprAddOpen(anchorEl, true);
}

// ---------- контекстные меню ----------
function cmpChipCtx(e, sys, cat, items, idx) {
  e.preventDefault();
  e.stopPropagation();
  const chipEl = e.currentTarget;
  const it = items[idx];
  const hasIt = !!(it && it.name);
  // кликнутый чип в наборе из 2+ — копирование/вырезание/удаление
  // забирают весь набор юнитов, иначе только его
  const inSet = hasIt &&
    (state.campaign.unitSel || []).indexOf(cmpUnitKey(sys, cat, idx)) !== -1;
  const grab = () => {
    if (inSet) {
      const sel = cmpSelUnits();
      if (sel.length > 1) return sel;
    }
    return hasIt ? [{ sys, cat, name: it.name, n: it.n }] : [];
  };
  openCtxMenu(e, [
    { label: t("upr_add") || "Добавить", icon: "add", fn: () => {
        cmpAddNew(sys, cat, chipEl);
      } },
    { label: t("upr_edit") || "Редактировать", icon: "edit", disabled: !hasIt,
      fn: () => cmpEditPop(chipEl, sys, cat, items, idx) },
    { label: t("ctx_copy") || "Копировать", icon: "copy", disabled: !hasIt, fn: () => {
        const g = grab();
        state.campaign.clip = g.map(x => ({ name: x.name, n: x.n, cat: x.cat }));
        toast((t("ctx_copied") || "Скопировано")
          + (g.length > 1 ? " (" + g.length + ")" : ""), "ok");
      } },
    { label: t("ctx_cut") || "Вырезать", icon: "cut", disabled: !hasIt, fn: () => {
        state.campaign.clip = grab().map(x => ({ name: x.name, n: x.n, cat: x.cat }));
        cmpRemoveItems(grab());
        renderCampaign();
      } },
    { sep: true },
    { label: t("delete") || "Удалить", icon: "delete", danger: true, disabled: !hasIt, fn: () => {
        cmpRemoveItems(grab());
        renderCampaign();
      } },
    { label: t("ctx_paste") || "Вставить", icon: "paste",
      disabled: !(state.campaign.clip || []).length,
      fn: () => { cmpPasteTo(sys); renderCampaign(); } },
    { sep: true },
    { label: t("upr_open_grid") || "Открыть в таблице", icon: "grid", disabled: !hasIt,
      fn: () => uprOpenInGrid(cat, it.name) },
  ]);
}

// ПКМ по пустому месту секции — добавить/вставить
function cmpSecCtx(e, sys, cat) {
  e.preventDefault();
  e.stopPropagation();
  openCtxMenu(e, [
    { label: t("upr_add") || "Добавить", icon: "add",
      fn: () => cmpAddNew(sys, cat, e.target) },
    { label: t("ctx_paste") || "Вставить", icon: "paste",
      disabled: !(state.campaign.clip || []).length,
      fn: () => { cmpPasteTo(sys); renderCampaign(); } },
  ]);
}

// ---------- операции с плитками целиком (аналог секторов Uprising) ----------
// категории-наполнение поселения: все остальные колонки (служебные) не трогаем
var CMP_TILE_CATS = ["squads", "tanks", "cars", "helicopters", "inventory_items"];

// снимок плитки: [{cat, items}] по всем колонкам-наполнению
function cmpTileSnap(sys) {
  const ri = cmpRowIdx(sys);
  if (ri === -1) return [];
  const out = [];
  CMP_TILE_CATS.forEach(cat => {
    const ci = cmpCatCol(cat);
    if (ci === -1) return;
    out.push({ cat,
      items: uprParseList(state.campaign.rows[ri].values[ci] || "") });
  });
  return out;
}

// запись снимка в плитку одним батчем (одна запись истории)
function cmpTileWrite(sys, snap, summary) {
  const ri = cmpRowIdx(sys);
  if (ri === -1) return Promise.resolve(false);
  const edits = [];
  (snap || []).forEach(s => {
    const ci = cmpCatCol(s.cat);
    if (ci === -1) return;
    edits.push({ ri, ci, items: (s.items || []).filter(x => x.name) });
  });
  return cmpWriteCells(edits, summary).then(ok => {
    renderCampaign();
    return ok;
  });
}

// слияние содержимого в плитку: mode "skip" (дубликаты пропускаются)
// или "sum" (дубликаты суммируют количество). Возвращает {edits, skipped}
function cmpTileMerge(sys, snap, mode) {
  const ri = cmpRowIdx(sys);
  const edits = [], skipped = [];
  if (ri === -1) return { edits, skipped };
  (snap || []).forEach(s => {
    const ci = cmpCatCol(s.cat);
    if (ci === -1) return;
    const cur = uprParseList(state.campaign.rows[ri].values[ci] || "");
    (s.items || []).forEach(x => {
      if (!x.name) return;
      const f = cur.find(c => c.name === x.name);
      if (f) {
        if (mode === "sum") f.n = Math.max(1, (f.n || 1) + (x.n || 1));
        else skipped.push(x);
        return;
      }
      cur.push({ name: x.name, n: x.n || 1 });
    });
    edits.push({ ri, ci, items: cur });
  });
  return { edits, skipped };
}

// буфер плиток -> плоский список чипов {name, n, cat} (для обычной вставки)
function cmpTileClipChips() {
  const out = [];
  (state.campaign.tileClip || []).forEach(tc => {
    (tc.snap || []).forEach(s => {
      (s.items || []).forEach(x => {
        if (x.name) out.push({ name: x.name, n: x.n || 1, cat: s.cat });
      });
    });
  });
  return out;
}

// ПКМ по плитке: копировать / вырезать / вставить / вставить и заменить /
// вставить и добавить / обменять с / очистить — по аналогии с секторами
// Uprising. Выбор плиток строго одиночный, операция — только по кликнутой
// (мультивыделение живёт на юнитах панели)
function cmpTileCtx(e, sys) {
  e.preventDefault();
  e.stopPropagation();
  const clip = state.campaign.tileClip || [];
  const hasClip = !!clip.length;
  const singleClip = clip.length === 1 ? clip[0] : null;
  openCtxMenu(e, [
    { label: t("cpg_tile_copy") || "Скопировать", icon: "copy", fn: () => {
        if (cmpRowIdx(sys) === -1) return;
        state.campaign.tileClip = [{ sys, snap: cmpTileSnap(sys) }];
        toast(t("ctx_copied") || "Скопировано", "ok");
      } },
    { label: t("cpg_tile_cut") || "Вырезать", icon: "cut", fn: async () => {
        state.campaign.tileClip = [{ sys, snap: cmpTileSnap(sys) }];
        await cmpTileWrite(sys, CMP_TILE_CATS
          .filter(c => cmpCatCol(c) !== -1)
          .map(c => ({ cat: c, items: [] })),
          (t("upr_h_clear") || "Очистка ({n})").replace("{n}", sys));
      } },
    { label: t("ctx_paste") || "Вставить", icon: "paste", disabled: !hasClip,
      fn: () => {
        const chips = cmpTileClipChips();
        const byCat = new Map();
        chips.forEach(c => {
          if (cmpCatCol(c.cat) === -1) return;
          if (!byCat.has(c.cat)) byCat.set(c.cat, []);
          byCat.get(c.cat).push(c);
        });
        const edits = [], skipped = [];
        byCat.forEach((list, cat) => {
          const r = cmpTileMerge(sys, [{ cat,
            items: list.map(c => ({ name: c.name, n: c.n })) }], "skip");
          edits.push(...r.edits);
          skipped.push(...r.skipped);
        });
        if (edits.length) {
          cmpWriteCells(edits, (t("upr_h_paste") || "Вставка ({n})")
            .replace("{n}", sys)).then(() => renderCampaign());
        }
        if (skipped.length) {
          toast((skipped.length === 1
            ? (t("upr_drop_dup") || "«{name}» уже есть — пропущен")
            : (t("upr_drop_dups") || "Пропущено {k}: уже есть"))
            .replace("{name}", (skipped[0] || {}).name || "")
            .replace("{k}", skipped.length), "");
        }
      } },
    { label: t("cpg_tile_paste_rep") || "Вставить и заменить", icon: "paste",
      disabled: !singleClip, fn: () => {
        cmpTileWrite(sys, singleClip.snap,
          (t("upr_h_paste") || "Вставка ({n})").replace("{n}", sys));
        toast(t("saved") || "Сохранено", "ok");
      } },
    { label: t("cpg_tile_paste_add") || "Вставить и добавить", icon: "paste",
      disabled: !hasClip, fn: () => {
        const edits = [];
        clip.forEach(tc => {
          const r = cmpTileMerge(sys, tc.snap, "sum");
          edits.push(...r.edits);
        });
        if (edits.length) {
          cmpWriteCells(edits, (t("upr_h_paste_add") || "Вставка ({n}) (добавление)")
            .replace("{n}", sys)).then(() => renderCampaign());
        }
        toast(t("saved") || "Сохранено", "ok");
      } },
    { label: t("cpg_tile_swap") || "Обменять с…", icon: "swap", fn: async () => {
        const others = cmpPresets().map(p => p.sys).filter(s => s !== sys);
        const v = await askPrompt({
          title: (t("cpg_tile_swap_t") || "Обменять «{n}» с поселением:")
            .replace("{n}", sys),
          options: others,
          okLabel: t("cpg_tile_swap_ok") || "Обменять",
        });
        if (v === null) return;
        const other = String(v).trim();
        if (cmpRowIdx(other) === -1 || other === sys) {
          toast(t("cpg_tile_swap_bad") || "Нет такого поселения", "err");
          return;
        }
        const a = cmpTileSnap(sys), b = cmpTileSnap(other);
        const riA = cmpRowIdx(sys), riB = cmpRowIdx(other);
        const edits = [];
        b.forEach(s => {
          const ci = cmpCatCol(s.cat);
          if (ci !== -1) edits.push({ ri: riA, ci, items: s.items });
        });
        a.forEach(s => {
          const ci = cmpCatCol(s.cat);
          if (ci !== -1) edits.push({ ri: riB, ci, items: s.items });
        });
        await cmpWriteCells(edits, (t("upr_h_swap") || "Обмен {a} ↔ {b}")
          .replace("{a}", sys).replace("{b}", other));
        renderCampaign();
        toast((t("cpg_tile_swapped") || "«{a}» и «{b}» поменялись наполнением")
          .replace("{a}", sys).replace("{b}", other), "ok");
      } },
    { sep: true },
    { label: t("cpg_tile_clear") || "Очистить", icon: "delete", danger: true,
      fn: async () => {
        const c = await askConfirm({
          title: (t("cpg_tile_clear_t") || "Очистить «{n}»?").replace("{n}", sys),
          message: t("cpg_tile_clear_m") || "Всё наполнение поселения будет удалено.",
          buttons: [
            { id: "ok", label: t("delete") || "Удалить", kind: "danger" },
            { id: "cancel", label: t("cancel"), kind: "ghost" },
          ],
        });
        if (c !== "ok") return;
        await cmpTileWrite(sys, CMP_TILE_CATS
          .filter(cat => cmpCatCol(cat) !== -1)
          .map(cat => ({ cat, items: [] })),
          (t("upr_h_clear") || "Очистка ({n})").replace("{n}", sys));
      } },
    { sep: true },
    { label: t("upr_open_grid") || "Открыть в таблице", icon: "grid",
      fn: () => { if (state.campaign.path) openFile(state.campaign.path); } },
  ]);
}

function cmpRemoveItems(list) {
  const byCell = new Map();
  list.forEach(it => {
    const k = it.sys + "|" + it.cat;
    if (!byCell.has(k)) byCell.set(k, new Set());
    byCell.get(k).add(it.name);
  });
  const edits = [];
  byCell.forEach((names, k) => {
    const p = k.indexOf("|");
    const ri = cmpRowIdx(k.slice(0, p)), ci = cmpCatCol(k.slice(p + 1));
    if (ri === -1 || ci === -1) return;
    edits.push({ ri, ci,
      items: uprParseList(state.campaign.rows[ri].values[ci] || "")
        .filter(x => !names.has(x.name)) });
  });
  cmpWriteCells(edits, (t("upr_h_remove") || "Удаление ({k} шт.)")
    .replace("{k}", list.length));
}

// вставка строго по своим категориям: каждый элемент — в столбец своей
// категории целевого поселения; дубликаты пропускаются (не ошибка)
function cmpPasteTo(sys) {
  const clip = state.campaign.clip || [];
  const ri = cmpRowIdx(sys);
  if (ri === -1 || !clip.length) return;
  const byCat = new Map();
  clip.forEach(c => {
    if (!c.name || cmpCatCol(c.cat) === -1) return;
    if (!byCat.has(c.cat)) byCat.set(c.cat, []);
    byCat.get(c.cat).push(c);
  });
  const edits = [];
  const skipped = [];
  byCat.forEach((list, cat) => {
    const ci = cmpCatCol(cat);
    const cur = uprParseList(state.campaign.rows[ri].values[ci] || "");
    list.forEach(c => {
      if (cur.some(x => x.name === c.name)) { skipped.push(c); return; }
      cur.push({ name: c.name, n: c.n });
    });
    edits.push({ ri, ci, items: cur });
  });
  if (edits.length) {
    cmpWriteCells(edits, (t("upr_h_paste") || "Вставка ({n})")
      .replace("{n}", sys));
  }
  if (skipped.length === 1) {
    toast((t("upr_drop_dup") || "«{name}» уже есть — пропущен")
      .replace("{name}", skipped[0].name), "");
  } else if (skipped.length > 1) {
    toast((t("upr_drop_dups") || "Пропущено {k}: уже есть")
      .replace("{k}", skipped.length), "");
  }
}

// ---------- drag & drop между плитками ----------
// перенос из поселения в поселение (та же категория); дубликаты — пропуск.
// Призрак + подпись + подсветка цели — теми же классами, что карта
let cmpDrag = null;

function cmpSetHint(tile) {
  if (cmpDrag && cmpDrag.hintTile === tile) return;
  if (cmpDrag && cmpDrag.hintTile) cmpDrag.hintTile.classList.remove("drop-hint");
  if (cmpDrag) cmpDrag.hintTile = tile || null;
  if (tile) tile.classList.add("drop-hint");
}

function cmpDragStart(e, sys, cat, items, idx, chipEl) {
  closeCtxMenu();
  const it = items[idx];
  if (!it || !it.name) return;
  // одна иконка = один юнит: тянем ровно 1 шт., а не весь стек (n:1),
  // иначе из :4 уезжали все четыре разом. Взятый чип в наборе из 2+ —
  // тянем весь набор сразу (по 1 шт. с каждого)
  let list = [{ sys, cat, idx, name: it.name, n: 1 }];
  if ((state.campaign.unitSel || []).indexOf(cmpUnitKey(sys, cat, idx)) !== -1) {
    const sel = cmpSelUnits();
    if (sel.length > 1)
      list = sel.map(s => ({ sys: s.sys, cat: s.cat,
        idx: s.idx, name: s.name, n: 1 }));
  }
  cmpDrag = { list,
    chipEl, started: false, sx: e.clientX, sy: e.clientY,
    ghost: null, label: null, offX: 0, offY: 0, hintTile: null, over: "" };
  window.addEventListener("mousemove", cmpDragMove, true);
  window.addEventListener("mouseup", cmpDragEnd, true);
}

function cmpDragMove(e) {
  const d = cmpDrag;
  if (!d) return;
  if (!d.started) {
    if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 5) return;
    d.started = true;
    const r = d.chipEl.getBoundingClientRect();
    d.offX = d.sx - r.left;
    d.offY = d.sy - r.top;
    // набор из 2+ — призрак из всех иконок (общий mkDragGhost),
    // одиночка — клон чипа как раньше
    let g;
    if (d.list.length > 1) {
      const extra = d.list.slice(1).map(u => document.querySelector(
        '#campaign-tab .upr-cat-body [data-ukey="' +
        cmpUnitKey(u.sys, u.cat, u.idx) + '"]'));
      g = mkDragGhost(d.chipEl, extra, d.list.length);
    } else {
      g = (typeof ghostStrip === "function"
        ? ghostStrip(d.chipEl.cloneNode(true)) : d.chipEl.cloneNode(true));
      g.className = "upr-chip upr-card upr-drag-ghost";
    }
    document.body.appendChild(g);
    d.ghost = g;
    // курсор — левый верхний угол призрака (+12, как нативный DnD):
    // точка хвата не сохраняется — иначе призрак, обрезанный до иконки,
    // оказывается ровно по центру курсора
    d.offX = 12; d.offY = 12;
    const lb = document.createElement("div");
    lb.className = "upr-drop-label";
    lb.hidden = true;
    document.body.appendChild(lb);
    d.label = lb;
    d.chipEl.classList.add("upr-chip-dragging");
    document.body.classList.add("upr-dragging");
  }
  d.ghost.style.left = (e.clientX - d.offX) + "px";
  d.ghost.style.top = (e.clientY - d.offY) + "px";
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const tile = el && el.closest ? el.closest(".cmp-tile") : null;
  const tgt = tile ? tile.dataset.sys : "";
  const ok = !!(tile && tgt && tgt !== d.list[0].sys);
  cmpSetHint(ok ? tile : null);
  d.over = ok ? tgt : "";
  if (ok) {
    d.label.textContent = (t("upr_drop_to") || "Перенести ({n})")
      .replace("{n}", tgt)
      + (d.list.length > 1 ? " ×" + d.list.length : "");
    d.label.hidden = false;
    d.label.style.left = (e.clientX + 14) + "px";
    d.label.style.top = (e.clientY + 16) + "px";
  } else if (d.label) d.label.hidden = true;
}

function cmpDragEnd() {
  const d = cmpDrag;
  cmpDrag = null;
  window.removeEventListener("mousemove", cmpDragMove, true);
  window.removeEventListener("mouseup", cmpDragEnd, true);
  if (!d) return;
  try {
    if (d.ghost) d.ghost.remove();
    if (d.label) d.label.remove();
    if (d.chipEl) d.chipEl.classList.remove("upr-chip-dragging");
  } catch (e) {}
  document.body.classList.remove("upr-dragging");
  document.querySelectorAll(".cmp-tile.drop-hint")
    .forEach(z => z.classList.remove("drop-hint"));
  if (d.started && d.over) cmpMoveItems(d.list, d.over);
}

function cmpMoveItems(list, targetSys) {
  const moved = [];
  // кэш разобранных ячеек: несколько переносимых стеков могут делить одну
  // ячейку источника/цели — читаем её один раз, иначе повторный разбор
  // брал бы исходное значение и затирал предыдущий перенос тем же батчем
  const cache = new Map();
  const cellItems = (ri, ci) => {
    const k = ri + "|" + ci;
    if (!cache.has(k))
      cache.set(k, uprParseList(state.campaign.rows[ri].values[ci] || ""));
    return cache.get(k);
  };
  (list || []).forEach(it => {
    if (!it.name) return;
    const ci = cmpCatCol(it.cat);
    const tri = cmpRowIdx(targetSys);
    const sri = cmpRowIdx(it.sys);
    if (ci === -1 || tri === -1 || sri === -1) return;
    // поштучно: одна иконка = один юнит. Из источника списываем (пустой
    // стек убираем), в цель вливаем в существующий стек (:1 + дроп = :2)
    // или кладем новым стеком
    const qty = Math.max(1, it.n | 0);
    const scur = cellItems(sri, ci);
    const sentry = scur.find(x => x.name === it.name);
    if (!sentry) return;
    const take = Math.min(qty, sentry.n);
    sentry.n -= take;
    const tcur = cellItems(tri, ci);
    const tentry = tcur.find(x => x.name === it.name);
    if (tentry) tentry.n += take;
    else tcur.push({ name: it.name, n: take });
    moved.push(it);
  });
  const edits = [];
  cache.forEach((items, k) => {
    const p = k.split("|");
    edits.push({ ri: +p[0], ci: +p[1],
      items: items.filter(x => x.name && (x.n | 0) > 0) });
  });
  cmpWriteCells(edits, (t("upr_h_move") || "Перенос ({n}, {k} шт.)")
    .replace("{n}", targetSys).replace("{k}", moved.length))
    .then(() => {
      renderCampaign();
      const tiles = document.querySelectorAll(".cmp-tile");
      for (const z of tiles) {
        if (z.dataset.sys === targetSys) {
          z.classList.add("flash");
          setTimeout(() => z.classList.remove("flash"), 750);
          break;
        }
      }
    });
  if (moved.length) {
    toast((t("upr_moved") || "Перенесено ({n}): {k}")
      .replace("{n}", targetSys).replace("{k}", moved.length), "ok");
  }
}

// кнопка «Анализ»: bulk-конвертация недостающих dds в готовые webp —
// та же логика, что uprAnalyze (чанки /api/uprising_convert + тот же
// мини-прогресс), затем сброс карт иконок и перерисовка.
// Имена — весь файл (все поселения разом), не только выбранное
function cmpIconNames() {
  const names = new Set();
  const cats = ["squads", "tanks", "cars", "helicopters", "inventory_items"];
  (state.campaign.rows || []).forEach(row => {
    cats.forEach(cat => {
      const ci = cmpCatCol(cat);
      if (ci !== -1) uprParseList(ci < row.values.length ? row.values[ci] : "")
        .forEach(x => { if (x.name) names.add(x.name); });
    });
  });
  return [...names];
}
async function cmpAnalyze() {
  if (!state.campaign.path || state.campaign.analyzing) return;
  const btn = $("#cmp-analyze");
  state.campaign.analyzing = true;
  const label = t("swt_analyze") || "Анализ";
  if (btn) { btn.disabled = true; btn.textContent = label + "…"; }
  try {
    const names = cmpIconNames();
    const CH = 150;
    const acc = { converted: 0, ready: 0, missing: 0, failed: 0 };
    let okAll = true, lastErr = "";
    if (names.length) cmpConvShow(names.length);
    for (let i = 0; i < names.length; i += CH) {
      const r = await api("/api/uprising_convert", { method: "POST",
        body: JSON.stringify({ root: cmpSrcRoot(), names: names.slice(i, i + CH) }) });
      const j = await r.json();
      if (j && j.ok) {
        acc.converted += j.converted || 0;
        acc.ready += j.ready || 0;
        acc.missing += j.missing || 0;
        acc.failed += j.failed || 0;
      } else { okAll = false; lastErr = (j && j.error) || "error"; break; }
      cmpConvPaint(Math.min(i + CH, names.length), names.length);
    }
    if (okAll) {
      // индекс webp перестраивается по mtime сам; сбрасываем карты в памяти
      state.campaign.iconMap = {};
      state.campaign.iconFail = {};
      state.campaign.iconsReady = false;
      state.campaign.iconsLoading = false;
      cmpEnsureIcons();
      renderCampaign();
      const parts = [];
      if (acc.converted) parts.push("+" + acc.converted);
      if (acc.ready) parts.push("=" + acc.ready);
      if (acc.failed) parts.push("!" + acc.failed);
      toast((t("swt_analyzed_tt") || "Готово") +
        (parts.length ? " (" + parts.join(" ") + ")" : ""), "ok");
    } else toast(lastErr, "err");
  } catch (e) { toast(String((e && e.message) || e), "err"); }
  finally {
    state.campaign.analyzing = false;
    cmpConvHide();
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

// мини-прогресс конвертации иконок — те же классы/вид, что upr-conv
function cmpConvShow(total) {
  const w = $("#cmp-conv");
  if (!w) return;
  w.hidden = false;
  cmpConvPaint(0, total);
}
function cmpConvPaint(done, total) {
  const f = $("#cmp-conv-fill"), tx = $("#cmp-conv-txt");
  const pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 100;
  if (f) f.style.width = pct + "%";
  if (tx) tx.textContent = (t("upr_conv_icons") || "Иконки") +
    ": " + done + "/" + total;
}
function cmpConvHide() {
  if (state.campaign.analyzing) return;
  const w = $("#cmp-conv");
  if (w) w.hidden = true;
}

// ---------- setup ----------
function setupCampaign() {
  // класс вида иконок на body (флаг общий с картой) — на случай любого
  // порядка инициализации вкладок; сами кнопки живут в заголовке панели
  try { if (typeof uprViewApply === "function") uprViewApply(); } catch (e) {}
  $("#cmp-reload").onclick = () => {
    cmpLoadMapImg($("#cmp-map-img"), 0);
    cmpReloadImages();
    if (state.campaign.path) cmpLoad();
    else renderCampaign();
  };
  $("#cmp-open-grid").onclick = () => { if (state.campaign.path) openFile(state.campaign.path); };
  $("#cmp-analyze").onclick = () => cmpAnalyze();
  // сегмент Проект|Игра|Мод в шапке — тот же глобальный переключатель,
  // что на карте (клик по серой — в настройки на строку пути)
  const cmpSeg = $("#cmp-src");
  if (cmpSeg) cmpSeg.addEventListener("click", e => {
    const b = e.target.closest(".src-seg-btn");
    if (!b) return;
    if (b.classList.contains("is-off")) {
      openSettingsPaths(b.dataset.src === "mod" ? "set-mod-path"
        : b.dataset.src === "game" ? "set-unpacked" : undefined);
      return;
    }
    cmpSwitchSrc(b.dataset.src);
  });
  $("#cmp-fs").onclick = () => {
    paneFsToggle($("#cmp-wrap").closest(".swt-page"));
    requestAnimationFrame(() => requestAnimationFrame(() => cmpFitMap()));
  };
  const tabs = $("#cmp-tabs");
  if (tabs) tabs.addEventListener("click", e => {
    const b = e.target.closest(".cmp-tab-btn");
    if (!b) return;
    state.campaign.tab = b.dataset.cmpTab || "shop";
    cmpPaintTabs();
    cmpPaintPanel();
  });
  cmpPaintTabs();
  // клик вообще в любом месте программы — снять выбор поселения и юнитов,
  // очистить боковую панель. Исключения: сама плитка (выбор), блок иконок
  // .upr-cat-body (Ctrl+клик по чипам правит набор — там НЕ снимается),
  // рельс вкладок и заголовок поселения (им нужен выбор), попапы и меню.
  // Пустое место тела панели (без заливки) — снимает, как любое другое.
  // Capture-фаза: никакой stopPropagation ниже нас не глушит.
  // Снятие тоже точечное (без renderCampaign), иначе возврат анимации рвётся
  if (!document.body.dataset.cmpDesel) {
    document.body.dataset.cmpDesel = "1";
    document.addEventListener("click", e => {
      if (state.activeTabId !== "campaign") return;
      if (!state.campaign.sel && !(state.campaign.unitSel || []).length) return;
      const t = e.target;
      if (t.closest && (t.closest(".cmp-tile") ||
          t.closest("#campaign-tab .upr-cat-body") ||
          t.closest(".cmp-tabs") || t.closest(".cmp-panel-head") ||
          t.closest(".upr-edit-pop") || t.closest(".ctx-menu") ||
          t.closest("#ctx-menu"))) return;
      cmpClearSel();
    }, true);
    // Esc — снять выбор поселения и юнитов (попап правки обрабатывает
    // Esc сам — пока он открыт, сюда не лезем; модалки тоже не трогаем)
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (state.activeTabId !== "campaign") return;
      if (typeof uprEditPopEl !== "undefined" && uprEditPopEl) return;
      if (document.querySelector('.modal:not([hidden])')) return;
      if (!state.campaign.sel && !(state.campaign.unitSel || []).length) return;
      closeCtxMenu();
      cmpClearSel();
    }, true);
  }
  // раздвижная боковая панель: тянуть левый край (клон upr-resizer).
  // Дефолт — фикс 435px из CSS (4 квадрата 72px без остатка справа);
  // тяга ставит свой фикс поверх. Даблклик по ресайзеру — сброс к дефолту
  const rz = $("#cmp-resizer");
  if (rz) {
    rz.title = (rz.title ? rz.title + " · " : "") + (t("cmp_resizer_reset") || "");
    rz.addEventListener("dblclick", () => {
      const main = $("#cmp-main");
      if (main) main.style.flex = "";
      try { localStorage.removeItem("tsh_cmp_panel_w"); } catch (e) {}
      cmpFitMap();
    });
    rz.addEventListener("mousedown", e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const main = $("#cmp-main");
      document.body.classList.add("cmp-resizing");
      const move = ev => {
        const w = Math.min(900, Math.max(280, window.innerWidth - ev.clientX - 14));
        main.style.flex = "0 0 " + w + "px";
        cmpFitMap();
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.classList.remove("cmp-resizing");
        localStorage.setItem("tsh_cmp_panel_w",
          String(Math.round(main.getBoundingClientRect().width)));
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }
  // геометрия: окно, контейнер карты (ресайзер панели, fullscreen) —
  // пересчёт бокса синхронно, без ожидания следующего кадра
  window.addEventListener("resize", () => cmpFitMap());
  try {
    if ("ResizeObserver" in window) {
      if (!window.__cmpRO) {
        window.__cmpRO = new ResizeObserver(() => cmpFitMap());
      }
      const mw = $("#cmp-map");
      if (mw) window.__cmpRO.observe(mw);
    }
  } catch (e) {}
}
