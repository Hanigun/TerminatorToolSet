// ---------- Редактор режимов рандомайзера v2 ----------
// Вкладка «Редактор» на странице рандомайзера (те же upr-rnd-группы, щиты
// и чипы), а не текстовый редактор и не модалка. Открывается вкладкой,
// правит активный режим; преобразование/дублирование ведут сюда же
// через uprCfgEditOpen. Встроенные — только «Сохранить новый пресет»,
// свои — полный набор.
(function () {
"use strict";

const ED_CATS = ["squads", "tanks", "cars", "helicopters", "inventory_items"];
const ED_FACTIONS = ["player", "legion", "integrators", "founders", "grey", "yellow"];
const ED_PROTECTS = ["-", "start", "capital"];

let _ed = null; // {name, kind, isCustom, legacy, mtime, data, tab, filter, status}

// контейнеры вкладки редактора на странице рандомайзера
// (строятся в uprRndOpen: upr-rnd-editor-title/tabs/body/foot)
function edRoots() {
  return {
    title: document.getElementById("upr-rnd-editor-title"),
    tabs: document.getElementById("upr-rnd-editor-tabs"),
    body: document.getElementById("upr-rnd-editor-body"),
    foot: document.getElementById("upr-rnd-editor-foot"),
  };
}
function edUiReady() {
  const r = edRoots();
  return !!(r.title && r.tabs && r.body && r.foot);
}

function edOpts() {
  return (typeof uprRndOpts === "function") ? uprRndOpts() : {};
}
function edCurrentMode() {
  try {
    const m = edOpts().mode || "balanced";
    return String(m).replace(/\.cfg$/i, "") || "balanced";
  } catch (e) { return "balanced"; }
}

// вход извне (преобразование v1, дублирование): ведёт на вкладку
// редактора страницы рандомайзера; сама загрузка — в edEnsure
async function uprCfgEditOpen(modeName) {
  const nm = String(modeName || "").replace(/\.cfg$/i, "") || edCurrentMode();
  if (typeof uprRndOpenTab === "function") uprRndOpenTab("editor", nm);
  else await edEnsure(nm);
}

// подгрузка режима во вкладку: тот же режим повторно — только перерисовка
// (состояние правок живёт в _ed и переживает пересборку страницы).
// Скелет без данных режимом не считается — его всегда догружаем,
// иначе повторный вход рисовал бы пустой скелет («error» в теле)
async function edEnsure(modeName, force) {
  const nm = String(modeName || "").replace(/\.cfg$/i, "") || edCurrentMode();
  if (_ed && _ed.name === nm && !force && (_ed.data || _ed.legacy)) {
    if (edUiReady()) edRender();
    return;
  }
  await edLoad(nm);
}

let _edLoadSeq = 0; // токен гонки: отвечает только последняя загрузка

async function edLoad(nm) {
  const keepTab = (_ed && _ed.tab) || "sectors";
  // контейнеры ещё не в DOM (пересборка страницы до append) — старое
  // состояние не трогаем, загрузка произойдёт после append (см. uprRndOpen)
  if (!edUiReady()) return;
  _ed = { name: nm, kind: "any", isCustom: false, legacy: false,
          mtime: 0, data: null, tab: keepTab,
          filter: "", status: null };
  const body = edRoots().body;
  body.innerHTML = "";
  edRoots().foot.innerHTML = "";
  const my = ++_edLoadSeq;
  let j = null;
  try {
    const r = await api("/api/uprising_rnd_mode_get", { method: "POST",
      body: JSON.stringify({ kind: "any", name: nm + ".cfg" }) });
    j = await r.json();
  } catch (e) { j = null; }
  if (my !== _edLoadSeq) return; // пока грузился — стартовала более новая
  if (!_ed || _ed.name !== nm) return; // состояние сменилось (удаление и т.п.)
  if (!j || !j.ok) {
    _ed.status = { ok: false, text: (j && j.error) || "not_found" };
    edRender();
    return;
  }
  if (j.version === "v1" || j.legacy) {
    // устаревший v1: только чтение + кнопка преобразования
    _ed.legacy = true;
    _ed.data = j;
    edRender();
    return;
  }
  _ed.isCustom = !!j.is_custom;
  _ed.mtime = j.mtime || 0;
  _ed.path = j.path || "";
  _ed.openSec = { 0: true };
  _ed.clip = [];
  _ed.data = { mode: { name: nm }, rules: j.rules || {},
    weights: j.weights || {}, sectors: j.sectors || {},
    units: (j.units || []).map(u => (edNormUnit(u))),
    loot: j.loot || {} };
  _ed.status = (j.warnings && j.warnings.length)
    ? { ok: true, text: (t("upr_cfg_ed_warn") || "Предупреждения: ") + j.warnings.length }
    : null;
  edRender();
};

function edTitle() {
  const el = edRoots().title;
  if (!el) return;
  const badge = _ed.isCustom
    ? (t("upr_cfg_ed_own") || "Свой пресет")
    : (t("upr_cfg_ed_builtin") || "Встроенный (только чтение)");
  el.textContent = "✏️ " + _ed.name + " · " + badge;
}

function edRender() {
  if (!edUiReady() || !_ed) return;
  try { edClosePop(); } catch (e) {}
  try { edDragAbort(); } catch (e) {}
  edTitle();
  // подвкладки вкладки редактора (статические кнопки из uprRndOpen)
  edRoots().tabs.querySelectorAll(".st-tab").forEach(b => {
    b.classList.toggle("active", b.dataset.st === _ed.tab);
    b.onclick = () => { _ed.tab = b.dataset.st; edRender(); };
  });
  const body = edRoots().body;
  body.innerHTML = "";
  if (_ed.legacy) { edRenderLegacy(body); }
  else if (!_ed.data) { body.textContent = (_ed.status && _ed.status.text) || "error"; }
  else if (_ed.tab === "sectors") edRenderSectors(body);
  else if (_ed.tab === "units") edRenderUnits(body);
  else edRenderRules(body);
  edRenderFoot();
  if (_ed.status) edPaintStatus();
}

// --- v1: бейдж устаревшего + преобразование ---
function edRenderLegacy(body) {
  const g = document.createElement("div");
  g.className = "upr-rnd-group";
  const h = document.createElement("div");
  h.className = "upr-rnd-gtitle";
  h.textContent = t("upr_rnd_legacy") || "Режим v1 (устаревший)";
  const p = document.createElement("div");
  p.className = "upr-rnd-hint";
  p.textContent = t("upr_cfg_ed_legacy_d") ||
    "Старый формат ZONE: только чтение. Преобразуйте в v2 — копия появится в своих пресетах.";
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn accent";
  b.textContent = t("upr_cfg_ed_convert") || "Преобразовать в v2";
  b.onclick = async () => {
    const nn = await askPrompt({ title: t("upr_cfg_ed_new_name") || "Имя нового пресета",
      value: _ed.name + " v2" });
    if (!nn) return;
    const r = await api("/api/uprising_rnd_convert_v1", { method: "POST",
      body: JSON.stringify({ kind: "any", name: _ed.name + ".cfg", new_name: nn }) });
    const j = await r.json();
    if (!j.ok) { toast(j.error || "error", "err"); return; }
    toast(t("saved") || "Сохранено", "ok");
    uprCfgEditOpen(nn.replace(/\.cfg$/i, ""));
  };
  g.append(h, p, b);
  body.appendChild(g);
}

// нормализация записи юнита: сектор 0 = общий пул, количество ×1
let _edUid = 1;
function edNormUnit(u) {
  let sec = 0;
  try { sec = parseInt(u.sector, 10) || 0; } catch (e) { sec = 0; }
  if (!(sec >= 0 && sec <= 22)) sec = 0;
  let cnt = 1;
  try { cnt = parseInt(u.count, 10) || 1; } catch (e) { cnt = 1; }
  if (!(cnt >= 1 && cnt <= 99)) cnt = 1;
  return { _id: "u" + (_edUid++), sys: String(u.sys || ""),
    diff: String(u.diff || "1"), cat: String(u.cat || "squads"),
    sector: sec, count: cnt };
}

function edSecGet(n) {
  return _ed.data.sectors[String(n)] ||
    { difficulty: 1, faction: "player", protect: "-" };
}
function edSecSet(n, patch) {
  const cur = _ed.data.sectors[String(n)] || {};
  _ed.data.sectors[String(n)] = Object.assign(
    { difficulty: 1, faction: "player", protect: "-" }, cur, patch);
}
function edSecCount(n) {
  return _ed.data.units.filter(u => (u.sector | 0) === n).length;
}
function edDiffLabel(d) {
  try {
    if (typeof uprDiffLabel === "function") return uprDiffLabel(d);
  } catch (e) {}
  return String(d);
}
function edShield(n) {
  try {
    if (typeof uprRndShield === "function") return uprRndShield(n);
  } catch (e) {}
  return "<b>" + n + "</b>";
}
// щит как в плитке «Сектора» настроек карты: крупный, с подсветкой столицы
function edShieldBig(n) {
  try {
    const col = (typeof uprZoneColor === "function" && typeof uprZoneKey === "function")
      ? uprZoneColor(n, edSecGet(n).faction).solid : null;
    const svg = (typeof uprShieldSvg === "function")
      ? uprShieldSvg(n, col, 30) : "";
    if (!svg) return edShield(n);
    let cap = "";
    try {
      const U = (typeof UPR_CAPITALS !== "undefined") ? UPR_CAPITALS : null;
      if (U && U[n] && typeof uprImgFaction === "function" &&
          uprImgFaction(U[n]) === uprImgFaction(uprZoneKey(n, edSecGet(n).faction)))
        cap = " cap";
    } catch (e) {}
    return `<span class="upr-shield-wrap">${svg}<b class="upr-shield-num${cap}">${n}</b></span>`;
  } catch (e) { return edShield(n); }
}

// --- вкладка Секторы: плитка как «Сектора» в настройках карты ---
// щит + название + sysname, под ними сложность / фракция / защита,
// внизу — сколько юнитов привязано к сектору во вкладке «Юниты»
function edRenderSectors(body) {
  const g = document.createElement("div");
  g.className = "upr-rnd-group";
  const h = document.createElement("div");
  h.className = "upr-rnd-gtitle";
  h.textContent = (t("upr_cfg_ed_sectors") || "Секторы") + " · 22";
  g.appendChild(h);
  const grid = document.createElement("div");
  grid.className = "upr-sectors-grid upr-cfg-ed-grid";
  for (let n = 1; n <= 22; n++) {
    const s = edSecGet(n);
    const tile = document.createElement("div");
    tile.className = "upr-sec-tile";
    const shield = document.createElement("span");
    shield.className = "upr-sec-shield";
    shield.innerHTML = edShieldBig(n);
    const nameRow = document.createElement("div");
    nameRow.className = "upr-sec-name";
    const nm = document.createElement("span");
    try {
      nm.textContent = (t("upr_sector_reward") || "Награда сектора {n}")
        .replace("{n}", String(n));
    } catch (e) { nm.textContent = "Сектор " + n; }
    const sys = document.createElement("span");
    sys.className = "upr-sector-sys";
    sys.textContent = "sector_" + n + "_reward";
    nameRow.append(nm, sys);
    const mkSel = (vals, cur, fn, fmt) => {
      const sel = document.createElement("select");
      vals.forEach(v => {
        const op = document.createElement("option");
        op.value = v;
        op.textContent = fmt ? fmt(v) : String(v);
        if (String(v) === String(cur)) op.selected = true;
        sel.appendChild(op);
      });
      sel.onchange = () => fn(sel.value);
      sel.onmousedown = e => e.stopPropagation();
      return sel;
    };
    const dsel = mkSel([1, 2, 3, 4, 5, 6], s.difficulty,
      v => edSecSet(n, { difficulty: +v }), edDiffLabel);
    dsel.className = "upr-diff-sel";
    dsel.title = t("upr_zone_diff") || "Сложность зоны";
    const fsel = mkSel(ED_FACTIONS, s.faction, v => edSecSet(n, { faction: v }));
    fsel.title = t("upr_rnd_faction") || "Фракция";
    const psel = mkSel(ED_PROTECTS, s.protect, v => edSecSet(n, { protect: v }),
      v => v === "-" ? ("— " + (t("upr_cfg_ed_no_prot") || "без защиты")) : v);
    psel.title = t("upr_cfg_ed_protect") || "Защита";
    const cnt = document.createElement("div");
    cnt.className = "upr-cfg-ed-tile-cnt";
    const k = edSecCount(n);
    cnt.textContent = (t("upr_cfg_ed_units") || "Юниты и предметы") + ": " + k;
    tile.append(shield, nameRow, dsel, fsel, psel, cnt);
    grid.appendChild(tile);
  }
  g.appendChild(grid);
  body.appendChild(g);
}

// --- вкладка Юниты: аккордеон секторов с чипами как на карте ---
// заголовок — широкий дропдаун: щит сектора + название + сводка,
// выпадает вниз горизонтальный блок категорий с чипами,
// перетаскивание, контекстное меню и «+» — как в боковом меню карты
function edKnown(cat) {
  try {
    const arr = (typeof uprSysnamesFor === "function") ? uprSysnamesFor(cat) : [];
    const set = {};
    (arr || []).forEach(s => { set[String(s).toLowerCase()] = true; });
    return set;
  } catch (e) { return {}; }
}
function edIsUnknown(u) {
  if (!u.sys) return true;
  try {
    // как на карте: глобальный справочник, не строгая категория
    // (пехота из humans.xml под категорией squads — валидна, не желтить)
    const all = (typeof state !== "undefined" && state.uprising &&
      state.uprising.sysnames) || [];
    if (!all.length) return false;
    const set = {};
    all.forEach(s => { set[String(s).toLowerCase()] = true; });
    return !set[String(u.sys).toLowerCase()];
  } catch (e) { return false; }
}

function edRenderUnits(body) {
  const g = document.createElement("div");
  g.className = "upr-rnd-group";
  const h = document.createElement("div");
  h.className = "upr-rnd-gtitle";
  h.textContent = (t("upr_cfg_ed_units") || "Юниты и предметы") + " · " + _ed.data.units.length;
  g.appendChild(h);
  const hint = document.createElement("div");
  hint.className = "upr-rnd-hint";
  hint.textContent = t("upr_cfg_ed_units_d") ||
    "Свой список для каждого сектора. Перетаскивай чипы между секторами, правка — двойной клик или правое меню.";
  g.appendChild(hint);
  // поиск + фильтр категории + импорт
  const bar = document.createElement("div");
  bar.className = "upr-rnd-row";
  const q = document.createElement("input");
  q.type = "text";
  q.className = "upr-cfg-ed-search";
  q.placeholder = "🔍";
  q.value = _ed.filter || "";
  q.oninput = () => {
    _ed.filter = q.value;
    // живой поиск без потери фокуса: перерисовать только аккордеон
    const acc = body.querySelector(".upr-cfg-ed-acc");
    if (acc) { acc.replaceWith(edSecAccordion()); }
  };
  const cf = document.createElement("select");
  ["", ...ED_CATS].forEach(c => {
    const op = document.createElement("option");
    op.value = c; op.textContent = c || "—";
    if ((_ed.catFilter || "") === c) op.selected = true;
    cf.appendChild(op);
  });
  cf.onchange = () => { _ed.catFilter = cf.value; edRender(); };
  const imp = document.createElement("button");
  imp.type = "button";
  imp.className = "btn sm";
  imp.textContent = t("upr_cfg_ed_import") || "Импорт с карты";
  imp.onclick = () => edImportFromMap();
  bar.append(q, cf, imp);
  g.appendChild(bar);
  g.appendChild(edSecAccordion());
  body.appendChild(g);
}

function edUnitMatch(u) {
  if (_ed.catFilter && u.cat !== _ed.catFilter) return false;
  const ql = (_ed.filter || "").toLowerCase();
  if (ql && String(u.sys || "").toLowerCase().indexOf(ql) < 0) return false;
  return true;
}

// весь аккордеон: общий пул + 22 сектора
function edSecAccordion() {
  const acc = document.createElement("div");
  acc.className = "upr-cfg-ed-acc";
  acc.appendChild(edSecBlock(0));
  for (let n = 1; n <= 22; n++) acc.appendChild(edSecBlock(n));
  return acc;
}

function edSecSummary(n) {
  const s = edSecGet(n);
  return (t("upr_cfg_ed_sec_sum") || "Сложность {d} · {f} · {p}")
    .replace("{d}", String(s.difficulty))
    .replace("{f}", String(s.faction))
    .replace("{p}", String(s.protect));
}

// один раскрывающийся блок сектора
function edSecBlock(n) {
  const wrap = document.createElement("div");
  wrap.className = "upr-cfg-ed-sec";
  wrap.dataset.sec = n;
  const list = _ed.data.units.filter(u => (u.sector | 0) === n && edUnitMatch(u));
  const heads = list.reduce((a, u) => a + (u.count | 0 || 1), 0);
  const open = !!(_ed.openSec || {})[n] || !!(_ed.filter && list.length);
  // заголовок-дропдаун: щит + название + сводка + счётчик
  const head = document.createElement("button");
  head.type = "button";
  head.className = "upr-cfg-ed-sec-head" + (open ? " open" : "");
  const shield = document.createElement("span");
  shield.className = "upr-sec-shield";
  shield.innerHTML = n === 0 ? "♾️" : edShield(n);
  const title = document.createElement("span");
  title.className = "upr-cfg-ed-sec-title";
  title.textContent = n === 0
    ? (t("upr_cfg_ed_pool") || "Общий пул (без сектора)")
    : ((t("upr_sector_reward") || "Награда сектора {n}").replace("{n}", String(n)));
  const sum = document.createElement("span");
  sum.className = "upr-cfg-ed-sec-sum";
  sum.textContent = n === 0
    ? (t("upr_cfg_ed_pool_d") || "разбираются по сложности")
    : edSecSummary(n);
  const badge = document.createElement("span");
  badge.className = "upr-cfg-ed-sec-badge";
  badge.textContent = list.length + " · ×" + heads;
  const chev = document.createElement("span");
  chev.className = "upr-cfg-ed-chev";
  chev.textContent = open ? "▾" : "▸";
  head.append(shield, title, sum, badge, chev);
  head.onclick = () => {
    _ed.openSec = _ed.openSec || {};
    _ed.openSec[n] = !open;
    edRender();
  };
  // быстрое добавление прямо из заголовка (не раскрывая)
  head.oncontextmenu = e => {
    e.preventDefault();
    e.stopPropagation();
    edSecCtx(e, n);
  };
  wrap.appendChild(head);
  if (!open) return wrap;
  // тело: категории друг под другом — один тип в один ряд, как на карте
  const catsRow = document.createElement("div");
  catsRow.className = "upr-cats-row upr-cfg-ed-cats";
  ED_CATS.forEach(cat => {
    if (_ed.catFilter && cat !== _ed.catFilter) return;
    const items = list.filter(u => u.cat === cat);
    catsRow.appendChild(edCatBlock(n, cat, items));
  });
  wrap.appendChild(catsRow);
  return wrap;
}

function edSecCtx(e, n) {
  if (typeof openCtxMenu !== "function") return;
  e.preventDefault();
  e.stopPropagation();
  openCtxMenu(e, [
    { label: (t("upr_cfg_ed_add") || "Добавить") + " → " +
      (n === 0 ? (t("upr_cfg_ed_pool") || "пул") : "сектор " + n),
      icon: "add", fn: () => edUnitAdd(n, _ed.catFilter || "squads", null) },
    { label: t("ctx_paste") || "Вставить", icon: "paste",
      disabled: !(_ed.clip || []).length,
      fn: () => edClipPaste(n, _ed.clipTargetCat || "squads") },
  ]);
}

// блок категории внутри сектора: заголовок + чипы + «+»
function edCatBlock(secNum, cat, items) {
  const sec = document.createElement("div");
  sec.className = "upr-cat";
  const title = document.createElement("div");
  title.className = "upr-cat-title";
  if (typeof uprCatTitle === "function") uprCatTitle(title, cat, " · " + items.length);
  else title.textContent = (t("upr_cat_" + cat) || cat) + " · " + items.length;
  sec.appendChild(title);
  const bwrap = document.createElement("div");
  bwrap.className = "upr-cat-body upr-cfg-ed-drop";
  bwrap.dataset.sec = secNum;
  bwrap.dataset.cat = cat;
  items.forEach(u => bwrap.appendChild(edChip(u)));
  // кнопка «+» всегда последняя в ряду
  const add = document.createElement("button");
  add.type = "button";
  add.className = "upr-chip-add";
  add.title = t("upr_add") || "Добавить";
  const addImg = document.createElement("img");
  addImg.className = "upr-chip-add-icon";
  addImg.src = "/assets/UprisingMap/add_unit.webp";
  addImg.alt = "";
  addImg.draggable = false;
  addImg.onerror = () => { add.textContent = "+"; };
  add.appendChild(addImg);
  add.onclick = ev => { ev.stopPropagation(); edUnitAdd(secNum, cat, add); };
  bwrap.appendChild(add);
  // приём pointer-перетаскивания чипов — в edDragMove/edDragEnd
  // (цель ищется через .upr-cfg-ed-drop, подсветка — .drop-hint);
  // вставка из буфера по ПКМ на пустом месте
  bwrap.oncontextmenu = e => {
    if (e.target === bwrap) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof openCtxMenu !== "function") return;
      openCtxMenu(e, [
        { label: t("upr_add") || "Добавить", icon: "add",
          fn: () => edUnitAdd(secNum, cat, null) },
        { label: t("ctx_paste") || "Вставить", icon: "paste",
          disabled: !(_ed.clip || []).length,
          fn: () => edClipPaste(secNum, cat) },
      ]);
    }
  };
  sec.appendChild(bwrap);
  return sec;
}

// чип юнита как на карте: бейдж «сложность ×количество» + иконка
function edChip(u) {
  const chip = document.createElement("span");
  chip.className = "upr-chip upr-card";
  chip.dataset.uid = u._id;
  if (edIsUnknown(u)) chip.classList.add("unknown");
  chip.title = (u.sys || "?") +
    "\n" + (t("upr_f_diff") || "Сложность") + ": " + (u.diff || "—") +
    " · " + (t("upr_f_count") || "Количество") + ": ×" + (u.count || 1) +
    "\n" + u.cat + (u.sector ? " · сектор " + u.sector : "");
  const badge = document.createElement("span");
  badge.className = "upr-chip-badge" +
    (u.cat === "inventory_items" ? " upr-chip-badge-items" : "");
  const skull = document.createElement("img");
  skull.className = "upr-chip-skull";
  skull.src = "/assets/UprisingMap/difficulty.webp";
  skull.alt = "";
  skull.draggable = false;
  const bt = document.createElement("span");
  bt.textContent = (u.diff || "—") + " ×" + (u.count || 1);
  badge.append(skull, bt);
  chip.appendChild(badge);
  const img = document.createElement("img");
  img.className = "upr-chip-icon";
  img.draggable = false;
  img.loading = "lazy";
  img.alt = "";
  edIcon(img, u.sys, u.cat, chip);
  chip.appendChild(img);
  // ЭКСПЕРИМЕНТ «слот техники»: фон + sysname + полоса мест
  if (typeof vehDecor === "function") vehDecor(chip, u.sys, u.cat);
  // перенос указателем как на карте: mousedown+движение = перетаскивание
  // (HTML5 DnD в WebView2 ненадёжен — там тот же pointer-механизм);
  // клик без движения ничего не делает, правка — dblclick/ПКМ
  chip.onmousedown = e => edDragStart(e, u, chip);
  chip.ondblclick = e => {
    e.preventDefault();
    e.stopPropagation();
    edUnitPop(chip, u);
  };
  chip.oncontextmenu = e => edChipCtx(e, u, chip);
  return chip;
}
// ---------- перетаскивание чипов указателем (как на карте) ----------
// mousedown+движение = перенос с призраком, цель — под курсором
// (elementFromPoint): чужой чип — вставка перед ним, пустое место блока —
// в конец блока. Без движения — обычный клик (ничего не делает).
let _edPD = null; // {uid, chipEl, started, sx, sy, offX, offY, ghost, over}
function edDragStart(e, u, chip) {
  if (!e || e.button !== 0 || !u) return;
  if (e.target.closest && e.target.closest("input,button,select,textarea")) return;
  e.preventDefault();
  try { if (typeof closeCtxMenu === "function") closeCtxMenu(); } catch (err) {}
  edClosePop();
  edDragAbort();
  _edPD = { uid: u._id, cat: u.cat || "squads", chipEl: chip, started: false,
            sx: e.clientX, sy: e.clientY, offX: 0, offY: 0,
            ghost: null, over: null, hoverSec: -1, hoverSince: 0 };
  window.addEventListener("mousemove", edDragMove, true);
  window.addEventListener("mouseup", edDragEnd, true);
  window.addEventListener("blur", edDragAbort);
}
function edDragAbort() {
  const d = _edPD;
  _edPD = null;
  window.removeEventListener("mousemove", edDragMove, true);
  window.removeEventListener("mouseup", edDragEnd, true);
  window.removeEventListener("blur", edDragAbort);
  if (!d) return;
  if (d.ghost) d.ghost.remove();
  if (d.chipEl && d.chipEl.isConnected)
    d.chipEl.classList.remove("upr-chip-dragging");
  document.body.classList.remove("upr-dragging");
}
function edDragMove(e) {
  const d = _edPD;
  if (!d) return;
  if (!d.started) {
    if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 5) return;
    if (!d.chipEl.isConnected) { edDragAbort(); return; }
    d.started = true;
    const r = d.chipEl.getBoundingClientRect();
    d.offX = d.sx - r.left;
    d.offY = d.sy - r.top;
    const g = (typeof ghostStrip === "function"
      ? ghostStrip(d.chipEl.cloneNode(true)) : d.chipEl.cloneNode(true));
    g.className = "upr-chip upr-card upr-drag-ghost";
    g.style.width = r.width + "px";
    document.body.appendChild(g);
    d.ghost = g;
    // курсор — левый верхний угол призрака (+12, как нативный DnD):
    // точка хвата не сохраняется — иначе призрак, обрезанный до иконки,
    // оказывается ровно по центру курсора
    d.offX = 12; d.offY = 12;
    d.chipEl.classList.add("upr-chip-dragging");
    document.body.classList.add("upr-dragging");
  }
  d.ghost.style.left = (e.clientX - d.offX) + "px";
  d.ghost.style.top = (e.clientY - d.offY) + "px";
  edDragAutoscroll(e.clientY);
  d.over = null;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  edDragHover(el);
  if (!el || !el.closest) return;
  // цель — блок категории целиком, бросок всегда в конец блока:
  // порядок внутри списка драгом не меняется, только перенос между секторами
  const wrap = el.closest(".upr-cfg-ed-drop");
  if (wrap && (wrap.dataset.cat || "squads") === d.cat) {
    d.over = { sec: +(wrap.dataset.sec || 0), cat: d.cat };
  }
}
// край экрана — плавный автоскролл тела редактора (затем окна)
function edDragAutoscroll(y) {
  const r = edRoots();
  const box = r && r.body;
  if (box && box.scrollHeight > box.clientHeight + 4) {
    const rc = box.getBoundingClientRect();
    if (y < rc.top + 70 && box.scrollTop > 0) { box.scrollTop -= 14; return; }
    if (y > rc.bottom - 70 &&
        box.scrollTop + box.clientHeight < box.scrollHeight) {
      box.scrollTop += 14; return;
    }
  }
  if (y < 70) window.scrollBy(0, -14);
  else if (y > window.innerHeight - 70) window.scrollBy(0, 14);
}
// ховер над свёрнутым сектором — разворот с задержкой и мягким скроллом;
// перерисовывается только аккордеон, драг не прерывается
function edDragHover(el) {
  const d = _edPD;
  if (!d) return;
  const secEl = el && el.closest ? el.closest(".upr-cfg-ed-sec") : null;
  const sec = secEl ? +(secEl.dataset.sec || 0) : -1;
  const now = (typeof performance !== "undefined" && performance.now)
    ? performance.now() : Date.now();
  if (sec !== d.hoverSec) { d.hoverSec = sec; d.hoverSince = now; return; }
  if (sec < 0 || (now - (d.hoverSince || 0)) < 450) return;
  if (!_ed || ((_ed.openSec || {})[sec])) return;
  d.hoverSince = now;
  edExpandSec(sec);
}
function edExpandSec(n) {
  if (!_ed) return;
  _ed.openSec = _ed.openSec || {};
  if (_ed.openSec[n]) return;
  _ed.openSec[n] = true;
  const r = edRoots();
  const acc = r.body && r.body.querySelector(".upr-cfg-ed-acc");
  if (!acc) return;
  acc.replaceWith(edSecAccordion());
  try {
    const blk = r.body.querySelector('.upr-cfg-ed-sec[data-sec="' + n + '"]');
    if (blk && blk.scrollIntoView)
      blk.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (e) {}
}
function edDragEnd() {
  const d = _edPD;
  const over = d && d.started ? d.over : null;
  const uid = d ? d.uid : null;
  edDragAbort();
  if (over && uid) edMoveUnit(uid, over.sec, over.cat);
}

function edMoveUnit(uid, secNum, cat) {
  if (!_ed || !_ed.data) return;
  const u = _ed.data.units.find(x => x._id === uid);
  if (!u || (cat || "squads") !== (u.cat || "squads")) return; // тип не меняем
  u.sector = secNum;
  u.cat = cat;
  _ed.openSec = _ed.openSec || {};
  _ed.openSec[secNum] = true;
  edRender();
}

function edIcon(img, sys, cat, chip) {
  // иконка через общий хелпер карты: мгновенный плейсхолдер категории
  // (предметы — squads-плейсхолдер) под спиннером, реальная подменяет
  if (typeof uprChipIcon === "function") {
    try { uprChipIcon(img, chip, sys, cat); return; }
    catch (e) { /* ниже — старый путь */ }
  }
  const fin = () => { if (chip) chip.classList.remove("upr-loading"); };
  if (chip) chip.classList.add("upr-loading");
  img.onload = fin;
  // категорийный плейсхолдер — статичный файл, доступен всегда:
  // чип без иконки не остаётся никогда
  let ph = "";
  try {
    ph = (typeof uprPlaceholderUrl === "function")
      ? (uprPlaceholderUrl(cat, sys) || "") : "";
  } catch (e) { ph = ""; }
  img.onerror = () => {
    // первая ошибка (data-URL или одиночный запрос) → плейсхолдер,
    // вторая → прячем битую картинку
    if (img.dataset.edFb && ph) {
      img.dataset.edFb = "";
      img.src = ph;
      return;
    }
    img.classList.add("noicon");
    fin();
  };
  let du = "";
  try { du = (typeof uprIconMap !== "undefined" && uprIconMap[sys]) || ""; }
  catch (e) { du = ""; }
  if (du) { img.dataset.edFb = "1"; img.src = du; return; }
  let solo = "";
  try { solo = (typeof uprIconUrl === "function") ? uprIconUrl(sys, cat) : ""; }
  catch (e) { solo = ""; }
  if (solo) { img.dataset.edFb = "1"; img.src = solo; return; }
  if (ph) { img.src = ph; fin(); return; }
  img.classList.add("noicon");
  fin();
}

// контекстное меню чипа: как на карте
function edChipCtx(e, u, chipEl) {
  e.preventDefault();
  e.stopPropagation();
  if (typeof openCtxMenu !== "function") { edUnitPop(chipEl, u); return; }
  openCtxMenu(e, [
    { label: t("upr_add") || "Добавить", icon: "add",
      fn: () => edUnitAdd(u.sector | 0, u.cat, null) },
    { label: t("upr_edit") || "Редактировать", icon: "edit",
      fn: () => edUnitPop(chipEl, u) },
    { label: t("ctx_copy") || "Копировать", icon: "copy",
      fn: () => { _ed.clip = [edSnap(u)]; toast(t("ctx_copied") || "Скопировано", "ok"); } },
    { label: t("ctx_cut") || "Вырезать", icon: "cut",
      fn: () => {
        _ed.clip = [edSnap(u)];
        _ed.data.units = _ed.data.units.filter(x => x._id !== u._id);
        edRender();
      } },
    { sep: true },
    { label: t("upr_cfg_ed_dupl") || "Дублировать", icon: "copy",
      fn: () => {
        const c = edSnap(u);
        c._id = "u" + (_edUid++);
        const i = _ed.data.units.indexOf(u);
        _ed.data.units.splice(i + 1, 0, c);
        edRender();
      } },
    { label: t("delete") || "Удалить", icon: "delete", danger: true,
      fn: () => {
        _ed.data.units = _ed.data.units.filter(x => x._id !== u._id);
        edRender();
      } },
    { sep: true },
    { label: t("ctx_paste") || "Вставить", icon: "paste",
      disabled: !(_ed.clip || []).length,
      fn: () => edClipPaste(u.sector | 0, u.cat) },
  ]);
}

function edSnap(u) {
  return { sys: u.sys, diff: u.diff, cat: u.cat,
    sector: u.sector | 0, count: u.count | 0 || 1 };
}
function edClipPaste(secNum, cat) {
  if (!(_ed.clip || []).length) return;
  _ed.clipTargetCat = cat;
  _ed.clip.forEach(c => {
    _ed.data.units.push({ _id: "u" + (_edUid++),
      sys: c.sys, diff: c.diff, cat: cat, sector: secNum, count: c.count });
  });
  _ed.openSec = _ed.openSec || {};
  _ed.openSec[secNum] = true;
  edRender();
  toast(t("saved") || "Сохранено", "ok");
}

// новый юнит сразу с поповером правки (все параметры за раз)
function edUnitAdd(secNum, cat, anchorEl) {
  const s = secNum ? edSecGet(secNum) : null;
  const u = { _id: "u" + (_edUid++), sys: "",
    diff: s ? String(s.difficulty || "1") : "1",
    cat: cat || "squads", sector: secNum | 0, count: 1 };
  _ed.data.units.push(u);
  _ed.openSec = _ed.openSec || {};
  _ed.openSec[secNum] = true;
  edRender();
  // поповер на свежем чипе после перерисовки
  requestAnimationFrame(() => {
    const el = document.querySelector(`.upr-chip[data-uid="${u._id}"]`);
    edUnitPop(el || anchorEl, u, true);
  });
}

// поповер правки чипа: имя + количество + сложность + категория + сектор
let _edPop = null;
function edClosePop() {
  if (_edPop) { _edPop.remove(); _edPop = null; }
}
function edUnitPop(anchorEl, u, isNew) {
  edClosePop();
  if (!u) return;
  const pop = document.createElement("div");
  pop.className = "upr-edit-pop upr-cfg-ed-pop";
  const mkRow = (title, desc) => {
    const row = document.createElement("div");
    row.className = "upr-edit-row";
    const lab = document.createElement("div");
    lab.className = "upr-edit-lab";
    const b = document.createElement("b");
    b.textContent = title;
    const sp = document.createElement("span");
    sp.textContent = desc;
    lab.append(b, sp);
    row.appendChild(lab);
    pop.appendChild(row);
    return row;
  };
  // ровно как модалка на карте: имя, количество, сложность.
  // категория и сектор — из блока, чьей кнопкой «+» открыт поповер
  // (перенос — перетаскиванием чипа); контекст виден в подписи
  const where = (u.cat || "") + ".xml · " +
    ((u.sector | 0) === 0
      ? (t("upr_cfg_ed_pool") || "Общий пул (без сектора)")
      : ("сектор " + (u.sector | 0)));
  const rowS = mkRow(t("upr_f_sysname") || "Системное имя",
    (t("upr_f_from") || "sysname из ") + where);
  const nm = document.createElement("input");
  nm.type = "text";
  nm.className = "upr-chip-name";
  nm.value = u.sys || "";
  nm.spellcheck = false;
  nm.placeholder = t("upr_add_ph") || "sysname";
  try {
    swtAutocomplete(nm, () => {
      try { return uprSysnamesFor(u.cat) || []; } catch (e) { return []; }
    }, v => { nm.value = v; }, { openOnFocus: false });
  } catch (e) {}
  rowS.appendChild(nm);
  // количество
  const rowN = mkRow(t("upr_f_count") || "Количество",
    t("upr_f_count_d") || "сколько единиц, минимум 1");
  const cnt = document.createElement("input");
  cnt.type = "number";
  cnt.min = "1";
  cnt.max = "99";
  cnt.className = "mini";
  cnt.value = u.count || 1;
  rowN.appendChild(cnt);
  // сложность
  const rowD = mkRow(t("upr_f_diff") || "Сложность",
    t("upr_f_diff_d") || "1-6 или 3-5, пусто = сложность зоны");
  const dinp = document.createElement("input");
  dinp.type = "text";
  dinp.className = "upr-chip-diff-inp mini";
  dinp.value = u.diff || "";
  dinp.placeholder = "1-6";
  dinp.spellcheck = false;
  rowD.appendChild(dinp);
  const btns = document.createElement("div");
  btns.className = "upr-edit-btns";
  const delB = document.createElement("button");
  delB.className = "btn sm danger";
  delB.textContent = t("delete") || "Удалить";
  const canB = document.createElement("button");
  canB.className = "btn sm ghost";
  canB.textContent = t("cancel") || "Отмена";
  const okB = document.createElement("button");
  okB.className = "btn sm accent";
  okB.textContent = t("save") || "Сохранить";
  btns.append(delB, canB, okB);
  pop.appendChild(btns);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("mousedown", outside, true);
    edClosePop();
  };
  const commit = save => {
    if (closed) return;
    if (!save && isNew && !u.sys) {
      // новый без имени — убрать временный
      _ed.data.units = _ed.data.units.filter(x => x._id !== u._id);
      close();
      edRender();
      return;
    }
    if (save) {
      const sys = nm.value.trim();
      const df = dinp.value.trim().replace(/\s+/g, "");
      if (df && !/^[1-6]$/.test(df) && !/^[1-6]-[1-6]$/.test(df)) {
        toast(t("upr_diff_bad") || "Формат сложности: 4 или 3-5", "err");
        return;
      }
      if (!sys) {
        _ed.data.units = _ed.data.units.filter(x => x._id !== u._id);
      } else {
        u.sys = sys;
        u.diff = df || String((edSecGet(u.sector | 0) || {}).difficulty || "1");
        u.count = Math.max(1, Math.min(99, parseInt(cnt.value, 10) || 1));
        _ed.openSec = _ed.openSec || {};
        _ed.openSec[u.sector | 0] = true;
      }
    }
    close();
    edRender();
  };
  const outside = e => {
    if (e.target.closest && e.target.closest(".swt-ac-panel")) return;
    if (_edPop && !_edPop.contains(e.target)) commit(false);
  };
  delB.onclick = e => {
    e.stopPropagation();
    if (isNew) { commit(false); return; }
    _ed.data.units = _ed.data.units.filter(x => x._id !== u._id);
    close();
    edRender();
  };
  canB.onclick = e => { e.stopPropagation(); commit(false); };
  okB.onclick = e => { e.stopPropagation(); commit(true); };
  [nm, cnt, dinp].forEach(el => {
    el.addEventListener("keydown", ev => {
      if (ev.key === "Enter") { ev.preventDefault(); commit(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); commit(false); }
    });
    el.addEventListener("mousedown", ev => ev.stopPropagation());
  });
  pop.addEventListener("mousedown", ev => ev.stopPropagation());
  document.addEventListener("mousedown", outside, true);
  // позиция: рядом с чипом, иначе по центру модалки
  document.body.appendChild(pop);
  _edPop = pop;
  try {
    const r = anchorEl && anchorEl.getBoundingClientRect
      ? anchorEl.getBoundingClientRect() : null;
    if (r) {
      pop.style.position = "fixed";
      pop.style.left = Math.max(8, Math.min(window.innerWidth - 330, r.left - 40)) + "px";
      pop.style.top = Math.max(8, Math.min(window.innerHeight - 320, r.bottom + 8)) + "px";
      pop.style.zIndex = 1200;
    }
  } catch (e) {}
  setTimeout(() => { try { nm.focus(); } catch (e) {} }, 30);
}

// черновик из текущих юнитов карты: сектор и количество сохраняются
function edImportFromMap() {
  let n = 0;
  try {
    const ud = (typeof uprUdiffs === "function") ? uprUdiffs() : {};
    const seen = {};
    (typeof uprGroups === "function" ? uprGroups() : []).forEach(gr =>
      (gr.list || []).forEach((rw, vi) => {
        ED_CATS.forEach(cat => {
          const ci = (typeof uprCatCol === "function") ? uprCatCol(cat) : -1;
          if (ci === -1 || !state.uprising.rows[rw.ri]) return;
          uprParseList(state.uprising.rows[rw.ri].values[ci] || "").forEach(it => {
            const key = gr.num + "|" + cat + "|" + it.name;
            if (!it.name || seen[key]) return;
            seen[key] = true;
            const dk = (typeof uprPickKey === "function")
              ? uprPickKey(gr.num, vi, cat, it.name) : "";
            _ed.data.units.push(edNormUnit({ sys: it.name,
              diff: (dk && ud[dk]) || "1", cat,
              sector: gr.num, count: Math.max(1, it.n | 0 || 1) }));
            n++;
          });
        });
      }));
  } catch (e) { toast(String((e && e.message) || e), "err"); return; }
  toast((t("upr_cfg_ed_imported") || "Импортировано: ") + n, "ok");
  edRender();
}

// --- вкладка Правила ---
function edRenderRules(body) {
  const r = _ed.data.rules, w = _ed.data.weights, l = _ed.data.loot;
  const g = (title) => {
    const el = document.createElement("div");
    el.className = "upr-rnd-group";
    const h = document.createElement("div");
    h.className = "upr-rnd-gtitle";
    h.textContent = title;
    el.appendChild(h);
    body.appendChild(el);
    return el;
  };
  const row2 = (gEl, label, input) => {
    const rEl = document.createElement("label");
    rEl.className = "upr-rnd-row";
    const sp = document.createElement("span");
    sp.textContent = label;
    sp.style.flex = "1";
    rEl.append(sp, input);
    gEl.appendChild(rEl);
    return rEl;
  };
  const num = (v, fn, min, max) => {
    const i = document.createElement("input");
    i.type = "number";
    i.value = v;
    if (min !== undefined) i.min = min;
    if (max !== undefined) i.max = max;
    i.style.width = "90px";
    i.onchange = () => fn(parseFloat(i.value));
    return i;
  };
  const bool = (v, fn) => {
    const c = document.createElement("input");
    c.type = "checkbox";
    c.checked = !!v;
    c.onchange = () => fn(c.checked);
    return c;
  };
  // фракции
  const gf = g(t("upr_rnd_faction") || "Фракции");
  const frRow = document.createElement("div");
  frRow.className = "upr-rnd-row";
  [["own", t("upr_rnd_fown") || "Только внутри своей"],
   ["mix", t("upr_rnd_fmix") || "Микс разрешён"],
   ["free", t("upr_rnd_ffree") || "Свободно (free)"]].forEach(([val, label]) => {
    const lb = document.createElement("label");
    lb.className = "upr-rnd-row";
    const rd = document.createElement("input");
    rd.type = "radio";
    rd.name = "upr-cfg-ed-fmode";
    rd.checked = r.faction_mode === val;
    rd.onchange = () => { r.faction_mode = val; };
    lb.append(rd, document.createTextNode(label));
    frRow.appendChild(lb);
  });
  gf.appendChild(frRow);
  row2(gf, t("upr_rnd_t_k") || "Хаос (k) — сила перемешивания", num(r.chaos_k, v => { r.chaos_k = v; }, 0, 2));
  // допуск и география
  const gg = g(t("upr_rnd_geo") || "География");
  row2(gg, t("upr_rnd_pm") || "Сложность юнитов ±1 от региона", bool(r.diff_soft_pm, v => { r.diff_soft_pm = v; }));
  row2(gg, t("upr_rnd_heads") || "Считать в головах (Count)", bool(r.count_heads, v => { r.count_heads = v; }));
  row2(gg, t("upr_rnd_noorigin") || "Не класть в исходный сектор", bool(r.no_origin, v => { r.no_origin = v; }));
  row2(gg, t("upr_rnd_noneib") || "Не класть в соседние по номеру (±1)", bool(r.no_neighbours, v => { r.no_neighbours = v; }));
  row2(gg, t("upr_rnd_cap") || "Лимит голов на сектор (0 — без лимита)", num(r.cap_heads, v => { r.cap_heads = v | 0; }, 0, 100));
  row2(gg, "seed", num(r.seed_default, v => { r.seed_default = v | 0; }, 0));
  // веса
  const gw = g(t("upr_rnd_balance") || "Хаос ↔ Баланс");
  ED_CATS.forEach(c => row2(gw, (t("upr_rnd_t_w_pre") || "Вес") + " «" + c + "»", num(w[c], v => { w[c] = v; }, 0, 5)));
  // лут
  const gl = g(t("upr_cfg_ed_loot") || "Лут");
  row2(gl, "rare_min_cost", num(l.rare_min_cost, v => { l.rare_min_cost = v | 0; }, 0));
  row2(gl, "rare_only_diff", num(l.rare_only_diff, v => { l.rare_only_diff = v | 0; }, 0, 6));
  row2(gl, "rare_in_capital", bool(l.rare_in_capital, v => { l.rare_in_capital = v; }));
  row2(gl, "common_free", bool(l.common_free, v => { l.common_free = v; }));
}

// --- фут: кнопки по источнику (кнопки закрытия нет — навигация вкладками) ---
function edRenderFoot() {
  const foot = edRoots().foot;
  if (!foot) return;
  foot.innerHTML = "";
  const st = document.createElement("span");
  st.id = "upr-cfg-ed-status";
  st.className = "upr-rnd-row";
  st.style.flex = "1";
  foot.appendChild(st);
  const mk = (label, kind, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn" + (kind ? " " + kind : "");
    b.textContent = label;
    b.onclick = fn;
    foot.appendChild(b);
    return b;
  };
  mk(t("upr_cfg_ed_check") || "Проверить", "", () => edCheck(true));
  if (_ed.data && !_ed.legacy) {
    if (_ed.isCustom) {
      mk(t("save") || "Сохранить", "accent", () => edSave(false));
      mk(t("upr_cfg_ed_dupl") || "Дублировать", "", () => edDuplicate());
      mk(t("upr_cfg_ed_new") || "+ Новый", "", () => edNew());
      mk(t("delete") || "Удалить", "sm danger", () => edDelete());
    } else {
      mk(t("upr_cfg_ed_save_new") || "Сохранить новый пресет", "accent", () => edSave(true));
    }
  }
}

function edPaintStatus() {
  const st = document.getElementById("upr-cfg-ed-status");
  if (!st || !_ed.status) return;
  st.textContent = _ed.status.text;
  st.style.color = _ed.status.ok ? "#7fd67f" : "#e08080";
}

// клиентская проверка до отправки (сервер всё равно валидирует)
function edCheck(loud) {
  const errs = [];
  if (!_ed || !_ed.data || !(_ed.data.sectors || _ed.data.zones)) {
    if (loud) toast(((_ed && _ed.status && _ed.status.text) || "error"), "err");
    return errs;
  }
  for (let n = 1; n <= 22; n++) {
    const s = _ed.data.sectors[String(n)];
    if (!s) { errs.push("сектор " + n + ": нет строки"); continue; }
    if (!(s.difficulty >= 1 && s.difficulty <= 6)) errs.push("сектор " + n + ": difficulty 1..6");
    if (ED_FACTIONS.indexOf(s.faction) < 0) errs.push("сектор " + n + ": фракция");
    if (ED_PROTECTS.indexOf(s.protect) < 0) errs.push("сектор " + n + ": защита");
  }
  _ed.data.units.forEach((u, i) => {
    if (!u.sys) errs.push("юнит " + (i + 1) + ": пустой sysname");
    if (!/^([1-6])(\s*-\s*([1-6]))?$/.test(u.diff || "")) errs.push((u.sys || "?") + ": сложность N или N-M");
    if (ED_CATS.indexOf(u.cat) < 0) errs.push((u.sys || "?") + ": категория");
    if (!(u.sector >= 0 && u.sector <= 22)) errs.push((u.sys || "?") + ": сектор 0..22");
    if (!(u.count >= 1 && u.count <= 99)) errs.push((u.sys || "?") + ": количество 1..99");
  });
  // имена вне проекта (stale-пресеты): предупреждение, не блокер
  const missing = [...new Set(_ed.data.units
    .filter(u => u.sys && edIsUnknown(u)).map(u => u.sys))];
  const missTxt = missing.length
    ? (t("upr_cfg_ed_unknown") || "нет в проекте") + ": " +
      missing.slice(0, 5).join(", ") +
      (missing.length > 5 ? " (+" + (missing.length - 5) + ")" : "")
    : "";
  _ed.status = errs.length
    ? { ok: false, text: errs.slice(0, 5).join("; ") + (errs.length > 5 ? " (+" + (errs.length - 5) + ")" : "") }
    : { ok: true, text: "✓ ok · " + _ed.data.units.length +
        (missTxt ? " · " + missTxt : "") };
  edPaintStatus();
  if (loud) toast(errs.length ? _ed.status.text : (missTxt || "✓ ok"),
    errs.length ? "err" : (missTxt ? "warn" : "ok"));
  return !errs.length;
}

async function edSave(asNew) {
  if (!edCheck(false)) { toast(_ed.status.text, "err"); return; }
  let name = _ed.name;
  if (asNew) {
    const nn = await askPrompt({ title: t("upr_cfg_ed_new_name") || "Имя нового пресета",
      value: _ed.name + " — копия" });
    if (!nn) return;
    name = nn;
  }
  const payload = { name, data: _ed.data };
  if (!asNew && _ed.isCustom) { payload.overwrite = true; payload.mtime = _ed.mtime; }
  const r = await api("/api/uprising_rnd_mode_save", { method: "POST",
    body: JSON.stringify(payload) });
  const j = await r.json();
  if (!j.ok && j.error === "exists") {
    const c = await askConfirm({ title: name,
      message: t("upr_cfg_ed_overwrite") || "Такой пресет уже есть. Перезаписать?",
      buttons: [{ id: "cancel", label: t("cancel") || "Отмена", kind: "ghost" },
                { id: "ok", label: t("save") || "Сохранить", kind: "accent" }] });
    if (c !== "ok") return;
    payload.overwrite = true;
    const r2 = await api("/api/uprising_rnd_mode_save", { method: "POST",
      body: JSON.stringify(payload) });
    const j2 = await r2.json();
    if (!j2.ok) { edConflict(j2); return; }
    afterSave(name, j2);
    return;
  }
  if (!j.ok) { edConflict(j); return; }
  afterSave(name, j);
}

function edConflict(j) {
  if (j.error === "conflict") {
    _ed.status = { ok: false,
      text: t("upr_cfg_ed_conflict") || "Файл изменился на диске. Переоткройте редактор." };
  } else {
    _ed.status = { ok: false, text: j.error || "error" };
  }
  edPaintStatus();
  toast(_ed.status.text, "err");
}

function afterSave(name, j) {
  _ed.name = String(name).replace(/\.cfg$/i, "");
  _ed.isCustom = true;
  _ed.mtime = j.mtime || 0;
  if (j.path) {
    _ed.path = j.path;
    try {
      if (typeof uprNoteExtraHist === "function") uprNoteExtraHist(j.path);
    } catch (e) {}
  }
  _ed.status = { ok: true, text: "✓ " + (t("saved") || "Сохранено") };
  // карточки режимов на странице — на месте (пересборка страницы снесла бы редактор)
  try { if (typeof uprRndRefreshModes === "function") uprRndRefreshModes(); } catch (e) {}
  edRender();
  toast(t("saved") || "Сохранено", "ok");
}

async function edDuplicate() {
  const nn = await askPrompt({ title: t("upr_cfg_ed_dupl") || "Дублировать",
    value: _ed.name + " — копия" });
  if (!nn) return;
  const r = await api("/api/uprising_rnd_mode_duplicate", { method: "POST",
    body: JSON.stringify({ src: _ed.name + ".cfg", name: nn }) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "error", "err"); return; }
  // сброс кэша до переоткрытия: пересборка страницы подхватит свежий список
  try { if (typeof uprRndRefreshModes === "function") uprRndRefreshModes(); } catch (e) {}
  uprCfgEditOpen(nn.replace(/\.cfg$/i, ""));
}

function edNew() {
  // черновик с дефолтами balanced + 22 зоны difficulty=1
  const sectors = {};
  for (let n = 1; n <= 22; n++) sectors[String(n)] = { difficulty: 1, faction: "player", protect: "-" };
  _ed = { name: "new", kind: "any", isCustom: true, legacy: false, mtime: 0,
    openSec: { 0: true }, clip: null,
    data: { mode: { name: "new" },
      rules: { faction_mode: "own", chaos_k: 1.0, count_heads: true, diff_soft_pm: true,
               no_origin: false, no_neighbours: false, cap_heads: 0, seed_default: 12345 },
      weights: { squads: 1, cars: 2, tanks: 3, helicopters: 3, inventory_items: 0.2 },
      sectors, units: [],
      loot: { rare_min_cost: 1500, rare_only_diff: 4, rare_in_capital: true, common_free: true } },
    tab: "sectors", filter: "", status: null };
  edRender();
}

async function edDelete() {
  const c = await askConfirm({ title: _ed.name,
    message: t("upr_cfg_ed_del") || "Удалить свой пресет?",
    buttons: [{ id: "cancel", label: t("cancel") || "Отмена", kind: "ghost" },
              { id: "ok", label: t("delete") || "Удалить", kind: "danger" }] });
  if (c !== "ok") return;
  const r = await api("/api/uprising_rnd_mode_delete", { method: "POST",
    body: JSON.stringify({ name: _ed.name + ".cfg" }) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "error", "err"); return; }
  // удалённый файл остаётся в журнале (восстановим через историю)
  try {
    if (j.path && typeof uprNoteExtraHist === "function") uprNoteExtraHist(j.path);
  } catch (e) {}
  // пресет удалён: редактор не на что показывать — сброс кэша режимов,
  // состояние сбросить, уйти на вкладку Простой (пересборка подтянет список)
  const dead = _ed.name;
  _ed = null;
  try { if (typeof uprRndRefreshModes === "function") uprRndRefreshModes(); } catch (e) {}
  // удалили активный режим — откатить опции на balanced, иначе висят на файле
  try {
    if (typeof uprRndOpts === "function" && typeof uprRndModeApply === "function") {
      const cur = String(uprRndOpts().mode || "").replace(/\.cfg$/i, "");
      if (cur === dead) await uprRndModeApply("balanced");
    }
  } catch (e) {}
  if (typeof uprRndOpenTab === "function") uprRndOpenTab("simple");
  toast(t("upr_cfg_ed_deleted") || "Удалено", "ok");
}

// --- undo/redo + журнал вкладки редактора (страница рандомайзера) ---
// Один открытый режим — один файл: серверный журнал сейвов через общий
// роутер history.js (кнопки — по его флагам). После undo/redo диск под
// редактором меняется — перечитываем режим с диска.
function edHistPaths() {
  try { return (_ed && _ed.path) ? [_ed.path] : []; }
  catch (e) { return []; }
}
async function edSyncUndoButtons() {
  try {
    const ps = edHistPaths();
    if (!ps.length) { setUndoRedoButtons(false, false); return; }
    const rs = await Promise.all(ps.map(p =>
      api("/api/history?path=" + encodeURIComponent(p))
        .then(r => r.json()).catch(() => null)));
    setUndoRedoButtons(rs.some(j => j && j.ok && j.can_undo),
      rs.some(j => j && j.ok && j.can_redo));
  } catch (e) {}
}
async function edRepaintUndo() {
  // откат — тоже несохранённое изменение: черновик с диска, кнопки по флагам
  if (_ed && _ed.name) {
    try { await edEnsure(_ed.name, true); } catch (e) {}
  }
  await edSyncUndoButtons();
}
// точечный рефреш после undo чужого файла страницы: свой — перечитать
function uprCfgEdRefreshIf(path) {
  try {
    if (!_ed || !_ed.path || !path) return false;
    if (normPath(_ed.path) !== normPath(path)) return false;
    edEnsure(_ed.name, true);
    return true;
  } catch (e) { return false; }
}

window.uprCfgEditOpen = uprCfgEditOpen;
window.uprCfgEdEnsure = edEnsure;
window.uprCfgEdRefreshIf = uprCfgEdRefreshIf;
window.uprCfgEdSync = edSyncUndoButtons;
try {
  if (typeof registerHistPage === "function") registerHistPage("uprising-rnd", {
    paths: edHistPaths,
    repaint: edRepaintUndo,
    hint: () => ({}),
    sync: edSyncUndoButtons,
  });
} catch (e) {}

})();
