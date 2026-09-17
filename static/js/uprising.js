/* TerminatorToolSet frontend — uprising.js: карта Uprising целиком (включая dnd чипов)
   Вырезано из app.js без изменений логики. Классические скрипты,
   общий глобальный скоуп, порядок загрузки — FILES в templates/index.html. */
// ---------- Карта Uprising (награды секторов shop_presets.xml) ----------
// Категории наград: заголовки из shop_presets.xml
const UPRISING_CATS = ["squads", "tanks", "cars", "helicopters", "inventory_items"];
// модалка редактора зоны по центру карты (временно отключена: только боковая панель)
const UPR_MODAL_ENABLED = false;

function uprFreshState() {
  // ЕДИНСТВЕННЫЙ дефолт состояния карты (старт + закрытие вкладки): все поля,
  // включая поколение загрузки loadSeq — без него переоткрытие давало NaN,
  // guard вечно дропал ответы и карта оставалась бледной (.empty, no sectors)
  return { path: null, rows: null, columns: [], sheetIndex: 0, sysnames: [], syscats: {}, prices: {}, stats: {}, statPaths: {}, extraHist: [], redoHint: "", sysLoading: false, sel: -1, variant: 0, dirty: false, found: false, panel: true, pick: new Set(), clip: [], sectorClip: null, editing: "", loading: false, loadSeq: 0, preloading: false };
}

function uprTab() { return state.tabs.find(tb => tb.id === "uprising"); }

function uprMarkDirty() {
  state.uprising.dirty = true;
  const tb = uprTab();
  if (tb && !tb.dirty) { tb.dirty = true; renderTabBar(); }
}

function uprMarkClean() {
  state.uprising.dirty = false;
  const tb = uprTab();
  if (tb) { tb.dirty = false; tb.saved = true; renderTabBar(); }
}

// ---------- сложности зон и юнитов + баланс-конфиг (.cfg) ----------
const UPR_DIFFS = [1, 2, 3, 4, 5, 6];
const UPR_DIFF_LABELS = { 1: "upr_diff_1", 2: "upr_diff_2", 3: "upr_diff_3",
                          4: "upr_diff_4", 5: "upr_diff_5", 6: "upr_diff_6" };

// сложности зон: {num: 1..6}; дефолт — 1 (легко)
function uprZdiffs() {
  try { return JSON.parse(localStorage.getItem("tsh_upr_zdiff") || "{}") || {}; }
  catch (e) { return {}; }
}
function uprZoneDiff(num) {
  return Math.min(6, Math.max(1, parseInt(uprZdiffs()[num], 10) || 1));
}
function uprSetZdiff(num, diff) {
  const m = uprZdiffs();
  m[num] = Math.min(6, Math.max(1, parseInt(diff, 10) || 1));
  localStorage.setItem("tsh_upr_zdiff", JSON.stringify(m));
  // бейджи-щиты на карте меняют число черепов сразу
  uprApplyColors();
}
function uprDiffLabel(d) {
  return d + " (" + (t(UPR_DIFF_LABELS[d]) || d) + ")";
}

// сложности юнитов: {"num|vi|cat|name": "4" | "3-5"}; пусто = унаследована от зоны
function uprUdiffs() {
  try { return JSON.parse(localStorage.getItem("tsh_upr_udiff") || "{}") || {}; }
  catch (e) { return {}; }
}
function uprSetUdiff(key, diff) {
  const m = uprUdiffs();
  if (diff) m[key] = diff; else delete m[key];
  localStorage.setItem("tsh_upr_udiff", JSON.stringify(m));
}

// имя фракции для конфига по ключу цвета зоны
function uprCfgFaction(key) {
  const m = { player: "Player", legion: "Legion", integrators: "Integrators",
              founders: "Movement", grey: "Marauders", yellow: "Cartel" };
  return m[key] || "Marauders";
}

// payload баланс-конфига: зоны + все юниты карты с эффективной сложностью
function uprCfgPayload() {
  const zones = (window.UPR_MAP_SECTORS || []).map(s => ({
    num: s.num, diff: uprZoneDiff(s.num),
    faction: uprCfgFaction(uprZoneKey(s.num, s.faction)),
  }));
  const units = [];
  uprGroups().forEach(g => g.list.forEach((rw, vi) => {
    UPRISING_CATS.forEach(cat => {
      const ci = uprCatCol(cat);
      if (ci === -1) return;
      uprParseList(state.uprising.rows[rw.ri].values[ci] || "").forEach(it => {
        if (!it.name) return;
        const own = uprUdiffs()[uprPickKey(g.num, vi, cat, it.name)];
        units.push({ sys: it.name, count: it.n,
          diff: own || String(uprZoneDiff(g.num)),
          cat: cat, sector: g.num, variant: vi });
      });
    });
  }));
  return { zones: zones, units: units, map: normPath(state.uprising.path || "") };
}

// флаг «сложности привязаны» — постоянный, живёт в localStorage по пути карты;
// сброс только явно (кнопка «Сбросить») — иначе охранная модалка не должна
// запускать «Привязать» и затирать ручные сложности сложностями зон
function uprInitedMap() {
  try { return JSON.parse(localStorage.getItem("tsh_upr_inited") || "{}") || {}; }
  catch (e) { return {}; }
}
function uprMarkInited() {
  if (!state.uprising.path) return;
  const m = uprInitedMap();
  m[normPath(state.uprising.path)] = true;
  localStorage.setItem("tsh_upr_inited", JSON.stringify(m));
  state.uprising.diffInit = true;
}
function uprIsInited() {
  return !!uprInitedMap()[normPath(state.uprising.path || "")] ||
    !!state.uprising.diffInit;
}

// экспорт («Скачать конфигурацию»): в настроенный путь; silent — без тоста,
// без пути — тихо (автозапись) или диалог «Сохранить как» (по кнопке)
async function uprCfgExport(silent) {
  if (!state.uprising.path || !uprGroups().length) return;
  let p = (state.config && state.config.uprising_cfg_path) || "";
  if (!p) {
    if (silent) return;
    p = await pickSaveFile();   // «Сохранить как» (.cfg), не «открыть файл»
    if (!p) return;
  }
  try {
    const r = await api("/api/uprising_cfg_write", { method: "POST",
      body: JSON.stringify({ path: p, ...uprCfgPayload() }) });
    const j = await r.json();
    if (!j.ok) { toast(j.error || "error", "err"); return; }
    uprNoteExtraHist(j.path || p);
    if (p !== (state.config && state.config.uprising_cfg_path || "")) {
      state.config.uprising_cfg_path = p;
      api("/api/config", { method: "POST",
        body: JSON.stringify({ uprising_cfg_path: p }) }).catch(() => {});
      const inp = $("#upr-cfg-path");
      if (inp) inp.value = p;
    }
    if (!silent) toast(t("upr_cfg_saved") || "Конфиг сохранён", "ok");
  } catch (e) { toast(String(e), "err"); }
}

// импорт: выбор файла → подтверждение → применение к карте
async function uprCfgImport() {
  if (!state.uprising.path) return;
  const path = await pickCfgFile();
  if (!path) return;
  try {
    const r = await api("/api/uprising_cfg_read", { method: "POST",
      body: JSON.stringify({ path: path }) });
    const j = await r.json();
    if (!j.ok) { toast(j.error || "error", "err"); return; }
    if (!j.exists || !(j.units || []).length) {
      toast(t("upr_cfg_empty") || "В конфиге нет юнитов", "err");
      return;
    }
    const choice = await askConfirm({
      title: t("upr_cfg_import") || "Загрузить конфиг",
      message: (t("upr_cfg_confirm") || "Применить конфигурацию к текущей карте?") +
        `\n${(j.zones || []).length} — зон, ${j.units.length} — юнитов`,
      buttons: [
        { id: "ok", label: t("continue") || "Применить", kind: "danger" },
        { id: "cancel", label: t("cancel"), kind: "ghost" },
      ],
    });
    if (choice !== "ok") return;
    await uprCfgApply(j.zones || [], j.units || [], false);
    // импортированный файл становится активным конфигом: автозапись и экспорт
    // дальше пишут в него
    state.config.uprising_cfg_path = path;
    api("/api/config", { method: "POST",
      body: JSON.stringify({ uprising_cfg_path: path }) }).catch(() => {});
    const inp = $("#upr-cfg-path");
    if (inp) inp.value = path;
    // открытые настройки перерисовать: сложности/цвета уже новые
    const modal = $("#upr-colors-modal");
    if (modal && !modal.hidden) uprOpenColors();
  } catch (e) { toast(String(e), "err"); }
}

// применить конфиг: сложности/цвета зон, списки категорий, сложности юнитов.
// silent — тихая загрузка зеркал при открытии карты (без dirty и тоста)
async function uprCfgApply(zones, units, silent) {
  const zm = new Map();
  zones.forEach(z => zm.set(z.num | 0, z));
  const rev = { player: "player", legion: "legion", integrators: "integrators",
                movement: "founders", marauders: "grey", cartel: "yellow" };
  const zd = uprZdiffs();
  const co = uprColorOverrides();
  (window.UPR_MAP_SECTORS || []).forEach(s => {
    const z = zm.get(s.num);
    if (!z) return;
    zd[s.num] = Math.min(6, Math.max(1, parseInt(z.diff, 10) || 1));
    const ck = rev[String(z.faction || "").toLowerCase()] || "";
    if (ck) co[s.num] = ck;
  });
  localStorage.setItem("tsh_upr_zdiff", JSON.stringify(zd));
  localStorage.setItem("tsh_upr_colors", JSON.stringify(co));
  // юниты группируем по «зона|вариант|категория»
  const lists = new Map();
  units.forEach(u => {
    const k = (u.sector | 0) + "|" + (u.variant | 0) + "|" + String(u.cat || "");
    if (!lists.has(k)) lists.set(k, []);
    lists.get(k).push({ name: String(u.sys || ""), n: Math.max(1, u.count | 0),
      diff: String(u.diff || "").trim() });
  });
  const touched = new Set();
  [...lists.keys()].forEach(k => touched.add(k.split("|")[0]));
  const diffs = uprUdiffs();
  Object.keys(diffs).forEach(k => { if (touched.has(k.split("|")[0])) delete diffs[k]; });
  // применение конфига — тоже одна команда для отмены: собираем ячейки батчем
  const cfgEdits = [];
  uprGroups().forEach(g => {
    if (!touched.has(String(g.num))) return;
    g.list.forEach((rw, vi) => {
      UPRISING_CATS.forEach(cat => {
        const ci = uprCatCol(cat);
        if (ci === -1) return;
        const arr = lists.get(g.num + "|" + vi + "|" + cat);
        const cur = uprParseList(state.uprising.rows[rw.ri].values[ci] || "");
        (arr || []).forEach(x => {
          if (x.name && x.diff) diffs[uprPickKey(g.num, vi, cat, x.name)] = x.diff;
        });
        if (!arr) {
          // в конфиге для этой категории пусто — чистим ячейку
          if (cur.length) cfgEdits.push({ ri: rw.ri, ci, items: [] });
          return;
        }
        const same = cur.length === arr.length &&
          cur.every((c, ix) => c.name === arr[ix].name && c.n === arr[ix].n);
        if (!same) {
          cfgEdits.push({ ri: rw.ri, ci,
            items: arr.map(x => ({ name: x.name, n: x.n })) });
        }
      });
    });
  });
  uprWriteCells(cfgEdits);
  localStorage.setItem("tsh_upr_udiff", JSON.stringify(diffs));
  uprMarkInited();
  if (!silent) {
    uprMarkDirty();
    toast(t("upr_cfg_applied") || "Конфигурация применена", "ok");
  }
  renderUprising();
}

// при открытии карты: если конфиг уже писался для этого файла — тянем зеркала
async function uprCfgDetectInit() {
  const p = (state.config && state.config.uprising_cfg_path) || "";
  if (!p || !state.uprising.path) return;
  try {
    const r = await api("/api/uprising_cfg_read", { method: "POST",
      body: JSON.stringify({ path: p }) });
    const j = await r.json();
    if (j.ok && j.exists && (j.units || []).length &&
        normPath(j.map || "") === normPath(state.uprising.path)) {
      await uprCfgApply(j.zones || [], j.units || [], true);
    }
  } catch (e) { /* конфига нет — не страшно */ }
}

// «Привязать сложность»: каждому юниту — сложность его зоны; конфиг создаётся
async function uprBindDifficulty() {
  if (!state.uprising.path || !uprGroups().length) return;
  const ud = uprUdiffs();
  uprGroups().forEach(g => g.list.forEach((rw, vi) => {
    UPRISING_CATS.forEach(cat => {
      const ci = uprCatCol(cat);
      if (ci === -1) return;
      uprParseList(state.uprising.rows[rw.ri].values[ci] || "").forEach(it => {
        if (it.name) ud[uprPickKey(g.num, vi, cat, it.name)] = String(uprZoneDiff(g.num));
      });
    });
  }));
  localStorage.setItem("tsh_upr_udiff", JSON.stringify(ud));
  uprMarkInited();
  renderUprising();
  await uprCfgExport(true);
  toast(t("upr_bind_done") || "Сложность привязана к зонам", "ok");
}

// охрана правки сложности юнита до инициализации
async function uprDiffGuard() {
  if (uprIsInited()) return true;
  const choice = await askConfirm({
    title: t("upr_bind_need_t") || "Сложность не привязана",
    message: t("upr_bind_need") ||
      "Сначала присвойте сложность: юниты получат сложность своих зон. Привязать сейчас?",
    buttons: [
      { id: "ok", label: t("upr_bind_btn") || "Привязать", kind: "primary" },
      { id: "cancel", label: t("cancel"), kind: "ghost" },
    ],
  });
  if (choice !== "ok") return false;
  await uprBindDifficulty();
  return true;
}

// инлайн-правка сложности юнита: «4» или «3-5»
function uprDiffEdit(btn, key, done) {
  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "upr-chip-diff-inp";
  inp.value = uprUdiffs()[key] || "";
  inp.placeholder = "1-6";
  inp.spellcheck = false;
  btn.replaceWith(inp);
  inp.focus();
  inp.select();
  let closed = false;
  const close = save => {
    if (closed) return;
    closed = true;
    if (save) {
      const v = inp.value.trim().replace(/\s+/g, "");
      if (!v || /^[1-6]$/.test(v) || /^[1-6]-[1-6]$/.test(v)) uprSetUdiff(key, v);
      else toast(t("upr_diff_bad") || "Формат сложности: 4 или 3-5", "err");
    }
    done();
  };
  inp.addEventListener("keydown", ev => {
    if (ev.key === "Enter") { ev.preventDefault(); close(true); }
    else if (ev.key === "Escape") { ev.preventDefault(); close(false); }
  });
  inp.addEventListener("blur", () => close(true));
}

// сброс конфига карты: восстановить shop_presets.xml из чистой копии (у
// проекта и распакованной игры — свои копии), удалить баланс-конфиг, обнулить
// сложности и цвета зон
async function uprResetConfig() {
  if (!state.uprising.path) return;
  const choice = await askConfirm({
    title: t("upr_reset_t") || "Сбросить конфиг",
    message: t("upr_reset_msg") ||
      "Карта вернётся к исходной: shop_presets.xml будет восстановлен из чистой копии, баланс-конфиг удалён, сложности и цвета зон сброшены.",
    buttons: [
      { id: "ok", label: t("upr_reset_btn") || "Сбросить", kind: "danger" },
      { id: "cancel", label: t("cancel"), kind: "ghost" },
    ],
  });
  if (choice !== "ok") return;
  try {
    const r = await api("/api/uprising_reset", { method: "POST",
      body: JSON.stringify({ root: uprSrcRoot(), path: state.uprising.path,
        cfg_path: (state.config && state.config.uprising_cfg_path) || "" }) });
    const j = await r.json();
    if (!j.ok) { toast(j.error || "error", "err"); return; }
    if (!j.restored && !j.cfg_removed) {
      // правок не было: копия только что снята, сбрасывать нечего
      toast(t("upr_reset_pristine") || "Изменений не было — копия снята", "ok");
      return;
    }
  } catch (e) { toast(String(e), "err"); return; }
  // зеркала — в ноль
  localStorage.removeItem("tsh_upr_zdiff");
  localStorage.removeItem("tsh_upr_udiff");
  localStorage.removeItem("tsh_upr_colors");
  const im = uprInitedMap();
  delete im[normPath(state.uprising.path)];
  localStorage.setItem("tsh_upr_inited", JSON.stringify(im));
  state.uprising.diffInit = false;
  await uprLoad(true);
  uprApplyColors();
  renderUprising();
  // открыта модалка настроек — перерисовать с дефолтами
  const modal = $("#upr-colors-modal");
  if (modal && !modal.hidden) uprOpenColors();
  toast(t("upr_reset_done") || "Конфиг сброшен", "ok");
}

function uprParseList(s) {
  // "name,name2:3;name3" -> [{name, n}]: элементы делятся запятой ИЛИ
  // точкой с запятой (в секторах встречается "a;b;c"). Суффикс количества
  // ":N" при этом не трогаем — сплит идёт раньше, ":N" остаётся приклеенным
  // к имени и разбирается регексом ниже. Сохранение (uprJoinList) всегда
  // пишет "," — ";" нормализуется в запятую при первой же записи.
  const out = [];
  String(s || "").split(/[,;]/).forEach(part => {
    const p = part.trim();
    if (!p) return;
    const m = p.match(/^(.*\S)\s*:(\d+)$/);
    if (m) out.push({ name: m[1].trim(), n: parseInt(m[2], 10) });
    else out.push({ name: p, n: 1 });
  });
  return out;
}

function uprJoinList(items) {
  return items.map(it => (it.n > 1 ? `${it.name}:${it.n}` : it.name)).join(",");
}

function uprSectorNum(sys) {
  const m = String(sys || "").match(/^sector_(\d+)_reward/);
  return m ? parseInt(m[1], 10) : 999;
}

// группы секторов: [{num, rows: [{ri, sys, variant}]}]
function uprGroups() {
  const rows = state.uprising.rows || [];
  const map = new Map();
  rows.forEach((row, ri) => {
    const sys = String((row.values && row.values[0]) || "").trim();
    if (!sys || !/^sector_\d+_reward/.test(sys)) return;
    const num = uprSectorNum(sys);
    if (!map.has(num)) map.set(num, []);
    const vm = sys.match(/^sector_\d+_reward_(.+)$/);
    map.get(num).push({ ri, sys, variant: vm ? vm[1] : "" });
  });
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([num, list]) => ({ num, list: list.sort((a, b) => a.variant.localeCompare(b.variant)) }));
}

function uprCatCol(cat) {
  // индекс колонки по имени заголовка (без учёта строки-заголовка)
  return state.uprising.columns.indexOf(cat);
}

// источник карты = глобальный источник приложения (древо + карта)
//localStorage-ключ tsh_src; старый tsh_upr_src мигрирует при старте
function uprSrc() { return state.treeView; }
function uprSrcRoot() { return srcRoot(state.treeView); }
function uprSrcPaint() { paintSrcSwitches(); }

async function uprFindFile() {
  const root = uprSrcRoot();
  if (!root) return "";
  const fr = await api("/api/uprising_find", { method: "POST",
    body: JSON.stringify({ root }) });
  const fj = await fr.json();
  return (fj.ok && fj.path) || "";
}

// переключение источника карты — через глобальный источник
// (древо и карта всегда на одном: Проект | Игра | Мод)
async function uprSwitchSrc(v) {
  await setSrc(v);
}

// компактное пустое состояние карты: сообщение под текущий источник +
// кнопка быстрого действия (открыть проект / указать путь в настройках)
function uprPaintNofile() {
  // пустого файла нет: область карты занята, поверх — некликаемый оверлей
  // с надписью и кнопкой (высокого блока под шапкой больше нет)
  $("#upr-wrap").hidden = false;
  $("#upr-nofile").hidden = false;
  const v = uprSrc();
  const msg = $("#upr-nofile .swt-empty");
  if (v === "game") msg.textContent = t("upr_need_unpacked") || t("upr_nofile");
  else if (v === "mod") msg.textContent = t("upr_need_mod") || t("upr_nofile");
  else msg.textContent = t("upr_need_project") || t("upr_nofile");
  const box = $("#upr-nofile-actions");
  box.innerHTML = "";
  const mk = (label, fn, accent) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn" + (accent ? " accent" : "");
    b.textContent = label;
    b.onclick = fn;
    box.appendChild(b);
  };
  if (v === "project") {
    mk(t("open_project") || "Открыть проект", () => openProjectDialog(), true);
  } else {
    mk(t("settings") || "Настройки", () => openSettings(), true);
  }
  // шапка пустого состояния: путь только существующего файла, кнопки
  // действий скрыты (иначе после закрытия источника висят старый путь
  // и рабочие кнопки — фантомная карта)
  const fp = $("#upr-file");
  if (fp) { fp.textContent = t("upr_sub") || ""; fp.title = ""; }
  ["#upr-reload", "#upr-analyze", "#upr-open-grid", "#upr-fs", "#upr-resizer"]
    .forEach(s => { const el = $(s); if (el) el.hidden = true; });
}

// источник карты пропал (проект/мод/распаковка закрыты): снести состояние,
// чтобы не висела фантомная карта; открытая вкладка — в пустое состояние
function uprInvalidateSource() {
  state.uprising = uprFreshState();
  uprIconMap = {};
  uprIconsReady = false;
  try { uprCloseEditPop(); } catch (e) { /* noop */ }
  if (state.activeTabId === "uprising") {
    uprPaintNofile();
    try { renderUprising(); } catch (e) { /* пустое состояние уже показано */ }
  }
  renderTabBar();
}

// карта без рута (файл с рабочего стола открыт одиночкой, проекта нет):
// подхватить текущий открытый файл, если это файл карты по содержимому.
// Иначе кнопка карты при подгруженном файле показывала «откройте проект».
async function uprCurrentShopFile() {
  try {
    const cf = state.currentFile && state.currentFile.path;
    if (!cf) return "";
    const bn = String(cf).split(/[\\/]/).pop() || "";
    if (!/^shop_presets\.xml$/i.test(bn)) return "";
    const r = await api("/api/uprising_sniff", { method: "POST",
      body: JSON.stringify({ path: cf }) });
    const j = await r.json();
    return (j && j.ok && j.uprising) ? cf : "";
  } catch (e) { return ""; }
}

async function openUprising(path, opts) {
  if (!state.tabs.some(tb => tb.id === "uprising")) {
    createTab("uprising");
    renderTabBar();
  }
  // смена источника при открытой карте перезагружает её фоном, не дёргая
  // вкладку на передний план (иначе выбор раздела в дереве принудительно
  // переключает на карту); явное открытие файла — как раньше, с активацией
  if (!opts || opts.activate !== false) activateTab("uprising");
  // повторный вход, пока загрузка в полёте (дабл-клик по кнопке карты,
  // клик во время boot): не плодим параллельные open_file/icons_data —
  // поздний ошибочный ответ затирал хорошие иконки пустой картой
  if (!path && state.uprising.loading) return;
  // область карты + спиннер — ДО медленного поиска/загрузки: #upr-loading
  // лежит внутри #upr-wrap, и пока wrap скрыт — спиннер не виден вообще.
  // При смене источника wrap уже показан, потому там спиннер был, а при
  // первом открытии его не было — пустая вкладка без фидбэка.
  try {
    $("#upr-wrap").hidden = false;
    $("#upr-nofile").hidden = true;
  } catch (e) { /* DOM ещё не готов — uprLoad сам покажет */ }
  uprSetLoading(true);
  if (!path) path = await uprFindFile();
  if (!path) path = await uprCurrentShopFile();
  if (!path) {
    uprSetLoading(false);
    uprPaintNofile();
    return;
  }
  // тот же файл уже загружен — ничего не делаем
  if (state.uprising.path && normPath(path) === normPath(state.uprising.path) &&
      state.uprising.rows) { uprSetLoading(false); return; }
  // повторный вход по тому же файлу, пока загрузка в полёте (дабл-клик
  // по кнопке/файлу, клик во время boot): параллельную цепочку не плодим.
  // Каждый лишний find — полный os.walk по распакованной игре (в app.log
  // три параллельных find по 5-12с от нетерпеливых кликов). Вход по ДРУГОМУ
  // файлу пропускаем: seq-поколение в uprLoad оставит последний ответ.
  // Спиннер не гасим: им владеет летящая загрузка.
  if (state.uprising.loading && state.uprising.path &&
      normPath(path) === normPath(state.uprising.path)) return;
  // смена файла при несохранённых правках — подтверждение
  if (state.uprising.path && state.uprising.dirty) {
    const choice = await askConfirm({
      title: t("upr_src_change") || "Сменить источник карты",
      message: t("upr_src_dirty") ||
        "Несохранённые изменения будут потеряны. Продолжить?",
      buttons: [
        { id: "ok", label: t("continue") || "Продолжить", kind: "danger" },
        { id: "cancel", label: t("cancel"), kind: "ghost" },
      ],
    });
    if (choice !== "ok") { uprSetLoading(false); return; }
  }
  state.uprising.path = path;
  // новое поколение загрузки: устаревший ответ параллельного openUprising
  // (смена источника mid-flight, дабл-клик) молча отбрасывается в uprLoad
  const seq = ++state.uprising.loadSeq;
  state.uprising.loading = true;
  try {
    await uprLoad(false, seq);
  } catch (e) {
    // uprLoad сам тостит сетевые сбои; здесь — страховка от синхронного
    // броска (битый JSON и т.п.): иначе спиннер остался бы навсегда
    if (seq === state.uprising.loadSeq) {
      uprSetLoading(false);
      toast(String((e && e.message) || e), "err");
    }
  } finally {
    if (seq === state.uprising.loadSeq) {
      state.uprising.loading = false;
      uprSetLoading(false);
    }
  }
  // файл без секторов Uprising (например, базовый shop_presets): карта пустая
  if (!uprGroups().length) toast(t("upr_no_sectors") || "Секторы не найдены", "err");
  // конфиг уже писался для этой карты? тянем сложности зон/юнитов
  uprCfgDetectInit();
  // чистая копия карты на источник (для «Сбросить конфиг») — до первых правок
  api("/api/uprising_reset", { method: "POST",
    body: JSON.stringify({ root: uprSrcRoot(), path: path, ensure_only: true }) })
    .catch(() => {});
  $("#upr-file").textContent = path;
  $("#upr-file").title = path;
  $("#upr-wrap").hidden = false;
  $("#upr-nofile").hidden = true;
  $("#upr-panel-toggle").hidden = !UPR_MODAL_ENABLED;
  uprSetPanel(state.uprising.panel);
  // шестерёнка цветов живёт в оверлее карты (uprRndOverlay), не в шапке
  ["#upr-reload", "#upr-analyze", "#upr-open-grid", "#upr-open-rnd", "#upr-fs",
   "#upr-src", "#upr-resizer"]
    .forEach(s => { $(s).hidden = false; });
  // сохранённая ширина боковой панели
  const sw = parseInt(localStorage.getItem("tsh_upr_panel_w") || "0", 10);
  if (sw >= 280 && sw <= 900) $("#upr-main").style.flex = "0 0 " + sw + "px";
  uprSrcPaint();
  // кнопки undo/redo тулбара — по истории файла карты, а не прошлой вкладки
  api("/api/history?path=" + encodeURIComponent(path)).then(r => r.json())
    .then(jh => { if (jh && jh.ok) setUndoRedoButtons(!!jh.can_undo, !!jh.can_redo); })
    .catch(() => {});
  // справочник sysname (фон, с ленивой повторной попыткой из форм ввода)
  uprLoadSysnames();
  // имена юнитов — приоритет источника ЭТОЙ карты (фон; корни уже в кэше
  // бэкенда после первого запроса — повтор дешёвый, только переслияние).
  // Без открытого проекта state.project.root пуст — тогда корень берём
  // из переключателя источника карты, иначе на карте нет имён юнитов.
  try {
    const pr = (state.project && state.project.root) || uprSrcRoot() || "";
    if (pr && typeof loadDisplayNames === "function")
      loadDisplayNames(pr, state.uprising.path);
  } catch (e) { /* имена не критичны */ }
}

// рандомайзер — отдельная страница-вкладка (не модалка):
// создать вкладку, активировать, отрисовать содержимое
function openUprisingRnd() {
  // диагностика пустой страницы: каждый шаг — в logs/app.log (client[rnd-open])
  const rndLog = (msg, extra) => {
    try {
      if (typeof reportClientError === "function") reportClientError("rnd-open", msg, extra || {});
    } catch (e) {}
  };
  try {
    rndLog("start", {
      tabs: state.tabs.map(tb => tb.id).join(","),
      panel: !!document.querySelector("#uprising-rnd-tab"),
      body: !!document.querySelector("#upr-rnd-page-body"),
      foot: !!document.querySelector("#upr-rnd-page-foot"),
      fn: typeof uprRndOpen,
      path: !!(state.uprising && state.uprising.path) });
    if (!state.tabs.some(tb => tb.id === "uprising-rnd")) {
      createTab("uprising-rnd");
      renderTabBar();
    }
    activateTab("uprising-rnd");
    rndLog("activated", { active: state.activeTabId,
      panelActive: !!(document.querySelector("#uprising-rnd-tab") || {}).classList &&
        document.querySelector("#uprising-rnd-tab").classList.contains("active") });
    if (typeof uprRndOpen === "function") uprRndOpen();
    else rndLog("uprRndOpen missing");
  } catch (e) {
    rndLog("throw: " + String((e && e.message) || e),
      { stack: String((e && e.stack) || "").slice(0, 500) });
  }
}

// справочник sysname для автокомплита и пометки «не найден»;
// вызывается при открытии карты и лениво — из формы добавления/редактирования
function uprLoadSysnames() {
  if (state.uprising.sysLoading || !state.uprising.path) return;
  const root = uprSrcRoot();
  if (!root) return;
  const path = state.uprising.path;
  state.uprising.sysLoading = true;
  api("/api/uprising_sysnames", { method: "POST", body: JSON.stringify({ root }) })
    .then(r => r.json())
    .then(j => {
      if (j.ok) {
        state.uprising.sysnames = j.names || [];
        state.uprising.syscats = j.cats || {};
        // источник могли переключить пока летел ответ — чужое не применяем
        // к виду: перерисовываем только если карта всё ещё на том же корне.
        // Без этого после смены вкладки висят «нет в species» до переоткрытия.
        if (state.uprising.path === path && state.uprising.rows &&
            uprSrcRoot() === root) renderUprising();
      }
    })
    .catch(() => {})
    .finally(() => { state.uprising.sysLoading = false; });
  // цены юнитов/предметов (колонка cost) — для модалки и шильдика
  api("/api/uprising_prices", { method: "POST", body: JSON.stringify({ root }) })
    .then(r => r.json())
    .then(j => {
      if (j.ok) {
        state.uprising.prices = j.prices || {};
        // статы species (cost/cp_cost/...) — для настроек юнита и шильдика;
        // шильдики уже на экране перерисовать, как после sysnames
        state.uprising.stats = j.stats || {};
        if (state.uprising.path === path && state.uprising.rows &&
            uprSrcRoot() === root) renderUprising();
      }
    })
    .catch(() => {});
}

// кнопка «Анализ» на карте: один bulk-запрос конвертирует недостающие DDS
// в assets/CustomImages, затем пути пересканируются и чипы подхватывают
// уже готовые webp (без поштучных запросов и повторного чтения файла карты)
async function uprAnalyze() {
  if (!state.uprising.path || state.uprising.analyzing) return;
  const btn = $("#upr-analyze");
  state.uprising.analyzing = true;
  const label = t("swt_analyze") || "Анализ";
  if (btn) { btn.disabled = true; btn.textContent = label + "…"; }
  // сторож: если цепочка зависнет дольше 10 минут — снять флаг, вернуть
  // кнопку и залогировать (кнопка не должна умирать навсегда)
  const watchTs = Date.now();
  const watch = setTimeout(() => {
    if (!state.uprising.analyzing) return;
    try {
      if (typeof reportClientError === "function")
        reportClientError("analyze", "uprising analyze watchdog: still running after 10min");
    } catch (e) {}
    state.uprising.analyzing = false;
    try { uprConvHide(); } catch (e) {}
    if (btn) { btn.disabled = false; btn.textContent = label; }
    toast(t("swt_analyze_stuck") || "Анализ завис — попробуйте ещё раз", "err");
  }, 600000);
  try {
    // bulk чанками, чтобы мини-прогресс под сегментом показывал ход
    // (один запрос на сотни DDS висит минутами без отклика)
    const names = uprIconNames();
    const CH = 150;
    const acc = { converted: 0, ready: 0, missing: 0, failed: 0 };
    let okAll = true, lastErr = "";
    if (names.length) uprConvShow(names.length);
    for (let i = 0; i < names.length; i += CH) {
      const r = await api("/api/uprising_convert", { method: "POST",
        body: JSON.stringify({ root: uprSrcRoot(), names: names.slice(i, i + CH) }),
        timeout: 180000 });
      const j = await r.json();
      if (j && j.ok) {
        acc.converted += j.converted || 0;
        acc.ready += j.ready || 0;
        acc.missing += j.missing || 0;
        acc.failed += j.failed || 0;
      } else { okAll = false; lastErr = (j && j.error) || "error"; break; }
      uprConvPaint(Math.min(i + CH, names.length), names.length);
    }
    if (okAll) {
      // словари sysname + индекс webp перестраиваются по mtime сами;
      // сбрасываем карты URL в памяти и перерисовываем чипы
      uprLoadSysnames();
      uprIconMap = {};
      uprIconsReady = false;
      await uprEnsureIcons();
      renderUprising();
      const parts = [];
      if (acc.converted) parts.push("+" + acc.converted);
      if (acc.ready) parts.push("=" + acc.ready);
      if (acc.failed) parts.push("!" + acc.failed);
      toast((t("swt_analyzed_tt") || "Готово") +
        (parts.length ? " (" + parts.join(" ") + ")" : ""), "ok");
    } else toast(lastErr, "err");
  } catch (e) { toast(String((e && e.message) || e), "err"); }
  finally {
    try { clearTimeout(watch); } catch (e) {}
    state.uprising.analyzing = false;
    uprConvHide();
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

// цена юнита из своего species-файла (пусто = неизвестна)
function uprPrice(cat, name) {
  try {
    const v = ((state.uprising.prices || {})[cat] || {})[name || ""];
    return (v === undefined || v === null) ? "" : String(v).trim();
  } catch (e) { return ""; }
}

// стат species для настроек юнита (cost/cp_cost/...): чтение из
// /api/uprising_prices (stats), запись — через /api/species_stat
function uprStat(cat, name, col) {
  try {
    const rec = (((state.uprising.stats || {})[cat] || {})[name || ""]) || {};
    const v = rec[col];
    return (v === undefined || v === null) ? "" : String(v).trim();
  } catch (e) { return ""; }
}

// запись статов юнита/предмета в species-файл (cost/cp_cost): тот же
// /api/species_stat, что у кампании (cmpWriteStats) — бэкенд правит первым
// файлом со строкой sysname. По возврату вливаем в кэши и перерисовываем
// карту — шильдик с cost обновляется динамически
function uprWriteStats(cat, name, stats) {
  const root = uprSrcRoot();
  if (!root || !name) return Promise.resolve(false);
  return api("/api/species_stat", { method: "POST",
    body: JSON.stringify({ root, cat, name, stats, save: true }) })
    .then(r => r.json())
    .then(async j => {
      if (!j || !j.ok) {
        toast((typeof cmpStatErr === "function"
          ? cmpStatErr(j, cat, name, stats)
          : ((j && j.error) || "error")), "err");
        return false;
      }
      if (j.skipped && j.skipped.length) {
        toast((t("cpg_stat_skipped") || "Не записано в {file} ({cols}): нет таких колонок")
          .replace("{file}", ((j.path || "").split(/[\\/]/).pop() || ""))
          .replace("{cols}", j.skipped.join(", ")), "err");
      }
      const st = state.uprising.stats[cat] || (state.uprising.stats[cat] = {});
      const cur = st[name] || (st[name] = {});
      Object.keys(stats).forEach(k => { cur[k] = stats[k]; });
      if (stats.cost !== undefined) {
        const pr = state.uprising.prices[cat] || (state.uprising.prices[cat] = {});
        pr[name] = stats.cost;
      }
      try {
        cmpSyncFileTabs(j.path, (j.cells || []).map(c => (
          { row: c.row, col: c.col, value: c.value })));
      } catch (e) {}
      if (!j.saved) {
        try {
          await guardedSave("file", j.path, async target => {
            if (!target) return;
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
        if (j.path) state.uprising.statPaths[j.path] = true;
        state.uprising.redoHint = "";
        uprSyncUndoButtons();
      } catch (e) {}
      renderUprising();
      return true;
    })
    .catch(e => { toast(String((e && e.message) || e), "err"); return false; });
}

// автокомплит строго из своего файла: cars — cars.xml, squads — squads.xml,
// tanks — tanks.xml, helicopters — helicopters.xml, items — inventory_items.xml
function uprSysnamesFor(cat) {
  const cats = state.uprising.syscats || {};
  if (cat && Array.isArray(cats[cat]) && cats[cat].length) return cats[cat];
  return state.uprising.sysnames || [];
}

// оверлей загрузки карты: спиннер по центру + затемнение, пока карта
// не прогрузилась полностью (открытие/перечитать)
function uprSetLoading(on) {
  const el = $("#upr-loading");
  if (el) el.hidden = !on;
}

async function uprLoad(reset, seq) {
  // seq не число (вызов из onclick даёт event) или не передан (кнопка
  // «перечитать», сброс конфига) — это новое поколение загрузки
  if (typeof seq !== "number") seq = ++state.uprising.loadSeq;
  const my = seq;
  const hideOwn = () => { if (my === state.uprising.loadSeq) uprSetLoading(false); };
  uprSetLoading(true);
  let r;
  try {
    r = await api("/api/open_file", { method: "POST",
      body: JSON.stringify({ path: state.uprising.path, reset: !!reset }), timeout: API_TIMEOUT_OPEN });
  } catch (e) {
    if (my === state.uprising.loadSeq) toast(String((e && e.message) || e), "err");
    hideOwn();
    return;
  }
  const j = await r.json().catch(e => null);
  // пока грузились — стартовало новое поколение (смена источника, повторный
  // клик): чужой файл не трогаем, иконки не перезаписываем; спиннером
  // владеет новое поколение — свой не гасим
  if (my !== state.uprising.loadSeq) return;
  if (!j || !j.ok) {
    toast((j && j.error) || "error", "err");
    hideOwn();
    // файл пропал (источник закрыт/удалён): не оставлять старые строки —
    // иначе висит фантомная карта от прошлого файла
    state.uprising.rows = null;
    uprPaintNofile();
    return;
  }
  state.uprising.rows = j.file.rows;
  state.uprising.columns = j.file.columns || [];
  state.uprising.sheetIndex = j.file.sheet_index || 0;
  state.uprising.sel = -1;
  state.uprising.variant = 0;
  uprMarkClean();
  // первый рендер — сразу по строкам, не дожидаясь иконок: скелет карты
  // (секторы, чипы-плейсхолдеры) виден мгновенно, иконки подтянутся следом;
  // раньше await icons_data блокировал любую отрисовку на секунды
  renderUprising();
  hideOwn();
  await uprEnsureIcons(my);   // один запрос карты URL — иконки видны на первом рендере
  if (my !== state.uprising.loadSeq) return;
  renderUprising();
}

function renderUprising() {
  renderUprMap();
  // прокрутка панели не должна сбрасываться при перерисовке (клики по иконкам)
  const main = $("#upr-main");
  const st = main ? main.scrollTop : 0;
  renderUprSector();
  if (main) main.scrollTop = st;
  // досмотр зависших иконок чипов (рваный коннект без error): один проход
  // через 5с после отрисовки; предыдущий таймер сбрасываем
  try {
    if (uprImgSweepT) clearTimeout(uprImgSweepT);
    uprImgSweepT = setTimeout(() => { uprImgSweepT = 0; uprReloadImages(); }, 5000);
  } catch (e) {}
}

// история страницы — карта + species-правки попапа (unit_set,
// cost...) + целые файлы (баланс-конфиг, пресеты, режимы рандомайзера):
// undo/redo берут файл с самой свежей записью, кнопки — ИЛИ.
function uprHistPaths() {
  try {
    const ps = [state.uprising.path]
      .concat(Object.keys(state.uprising.statPaths || {}))
      .concat(state.uprising.extraHist || []);
    return ps.filter((p, i) => p && ps.indexOf(p) === i);
  } catch (e) { return state.uprising.path ? [state.uprising.path] : []; }
}

// целый файл страницы записан (конфиг/пресет/режим): журнал и кнопки
// видят его без переоткрытия истории
function uprNoteExtraHist(path) {
  try {
    if (!path) return;
    const st = state.uprising;
    st.extraHist = st.extraHist || [];
    if (st.extraHist.indexOf(path) < 0) st.extraHist.push(path);
    uprSyncUndoButtons();
  } catch (e) {}
}
async function uprSyncUndoButtons() {
  try {
    const flags = (typeof histFlagsBatch === "function")
      ? await histFlagsBatch(uprHistPaths()) : {};
    const list = Object.values(flags);
    if (!list.length) return;
    setUndoRedoButtons(list.some(j => j && j.can_undo),
      list.some(j => j && j.can_redo));
  } catch (e) {}
}
// перечитать строки карты с сервера после undo/redo (без сброса dirty:
// откат — тоже несохранённое изменение); кнопки — по флагам истории
async function uprRepaintUndo() {
  try {
    const r = await api("/api/open_file", { method: "POST",
      body: JSON.stringify({ path: state.uprising.path, reset: false }) });
    const j = await r.json();
    if (j.ok && j.file) {
      state.uprising.rows = j.file.rows;
      state.uprising.columns = j.file.columns || [];
      renderUprising();
    }
  } catch (e) { /* оставили как было */ }
  // статы могли откатиться в species-файле — перечитать, иначе шильдики
  // покажут старое; кнопки — ИЛИ по всем файлам истории страницы
  try { uprLoadSysnames(); } catch (e) {}
  await uprSyncUndoButtons();
}

// «карта»: текстура карты + SVG-секторы произвольной формы
const UPR_SVG_NS = "http://www.w3.org/2000/svg";

// палитра зон: 5 цветов с карты игры + оранжевый (картель) — темнее 30%,
// прозрачность частично возвращена (+15% плотности)
const UPR_COLORS = {
  player:      { fill: "rgba(84,144,42,.30)",   stroke: "rgba(111,165,59,.67)", solid: "#78cd3c" },
  legion:      { fill: "rgba(158,32,32,.30)",   stroke: "rgba(179,59,50,.67)",  solid: "#dc3530" },
  integrators: { fill: "rgba(120,48,165,.30)",  stroke: "rgba(146,77,179,.67)", solid: "#ab44eb" },
  founders:    { fill: "rgba(39,84,158,.30)",   stroke: "rgba(67,118,179,.67)", solid: "#3c7ee0" },
  grey:        { fill: "rgba(104,112,120,.29)", stroke: "rgba(137,146,154,.61)",solid: "#9aa4b0" },
  yellow:      { fill: "rgba(165,105,22,.30)",  stroke: "rgba(176,127,46,.67)", solid: "#e59323" },
};
const UPR_SHIELD_D = "M-36 -30 Q-36 -40 -26 -40 H26 Q36 -40 36 -30 V4 Q36 30 0 44 Q-36 30 -36 4 Z";

function uprColorOverrides() {
  try { return JSON.parse(localStorage.getItem("tsh_upr_colors") || "{}") || {}; }
  catch (e) { return {}; }
}
function uprSaveColor(num, key) {
  const m = uprColorOverrides();
  if (key) m[num] = key; else delete m[num];
  localStorage.setItem("tsh_upr_colors", JSON.stringify(m));
}
function uprZoneKey(num, faction) {
  // ключ цвета зоны: переназначение из «Цветов зон» или своя фракция
  return uprColorOverrides()[num] || faction || "grey";
}
function uprZoneColor(num, faction) {
  return UPR_COLORS[uprZoneKey(num, faction)] || UPR_COLORS.grey;
}

// svg-щит с номером зоны (заголовок модалки, страница «Цвета зон» в настройках)
function uprSectorFaction(num) {
  const s = (window.UPR_MAP_SECTORS || []).find(x => x.num === num);
  return s ? s.faction : "grey";
}
// мини-щит для списков/заголовков: PNG фракции ВЫБРАННОГО цвета зоны
function uprShieldSvg(num, solid, size) {
  const s = (window.UPR_MAP_SECTORS || []).find(x => x.num === num);
  const art = uprBadgeArt(num, s ? s.faction : "grey");
  const h = Math.round(size * (art.capital ? 70.5 : 65.5) / 36);
  return `<img class="upr-shield-img" width="${size}" height="${h}" ` +
    `src="${art.href}" alt="">`;
}

function uprSvgEl(name, attrs) {
  const el = document.createElementNS(UPR_SVG_NS, name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

// собранные щиты-бейджи (assets/UprisingMap/shields, генерируются из DDS-иконок):
// карт-фракция -> имя файла щита; капитальные щиты для своих секторов;
// сложность черепов 1..6 (пол-черепа на уровень)
// ВСЕ щиты одним запросом в память (см. uprPreloadShields): раньше каждый щит
// грузился отдельным <img> по HTTP/1.0 без keep-alive (десятки коннектов +
// ?v=Date.now мимо кэша) — на холодном HDD часть щитов не прогружалась
const uprShieldCache = {};   // key (player_capital_d3) -> data-URL
let uprShieldsLoading = null;
const UPR_IMG_FACTION = { player: "player", legion: "legion", integrators: "integrators",
                          founders: "movement", grey: "marauders", cartel: "cartel" };
const UPR_CAPITALS = { 1: "player", 4: "integrators", 12: "movement", 18: "legion", 22: "cartel" };

// ключ цвета/фракции -> имя картинки щита («жёлтый» = картель)
function uprImgFaction(key) {
  return UPR_IMG_FACTION[key === "yellow" ? "cartel" : key] || "marauders";
}
// art бейджа: щит фракции ВЫБРАННОГО цвета; капитальный вариант — когда зона
// является столицей именно этой фракции; черепа = ЖИВАЯ сложность зоны
// (d1 — полчерепа/легко … d6 — три черепа/хардкор), 6 вариантов на фракцию
function uprBadgeArt(num, faction) {
  const imgF = uprImgFaction(uprZoneKey(num, faction));
  const cf = UPR_CAPITALS[num];
  const capital = !!cf && uprImgFaction(cf) === imgF;
  const diff = uprZoneDiff(num);
  const key = `${imgF}${capital ? "_capital" : ""}_d${diff}`;
  return { imgF, capital, diff,
    href: uprShieldCache[key] || ("/assets/shields/" + key + ".webp") };
}

// догрузка всех щитов одним запросом в память; вызывается фоном на старте
// (setupUprising) и при открытии карты — дальше все <img> берутся из кэша
function uprPreloadShields() {
  if (uprShieldsLoading) return uprShieldsLoading;
  uprShieldsLoading = (async () => {
    try {
      const r = await api("/api/uprising_shields_data", { timeout: 60000 });
      const j = await r.json();
      if (j && j.ok && j.shields) Object.assign(uprShieldCache, j.shields);
    } catch (e) { /* фолбэк — прямые URL */ }
    // карта могла отрисоваться раньше щитов: перерисовать с кэшем
    if (state.uprising.path && state.uprising.rows) renderUprising();
  })();
  return uprShieldsLoading;
}

// загрузка текстуры карты с контролем зависания: fetch с таймаутом 15с,
// до 3 попыток свежим коннектом; успех — blob в <img> (мимо кэша диска)
function uprLoadMapImg(img, attempt) {
  const url = "/assets/map/global_map.webp?v=" + Date.now() + "&r=" + attempt;
  const ctrl = ("AbortController" in window) ? new AbortController() : null;
  let done = false;
  const timer = setTimeout(() => {
    if (done) return; done = true;
    if (ctrl) { try { ctrl.abort(); } catch (e) {} }
    if (attempt < 3) uprLoadMapImg(img, attempt + 1);
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
      if (attempt < 3) uprLoadMapImg(img, attempt + 1);
      else img.alt = "map";
    });
}

function uprBuildMap(root) {
  const box = document.createElement("div");
  box.className = "upr-map-box";
  const img = document.createElement("img");
  img.className = "upr-map-img";
  img.alt = "";
  img.draggable = false;
  // текстура через fetch+blob с таймаутом: оборванный коннект (WinError 10054)
  // оставляет <img> в вечном «догружается наполовину» без onerror — fetch
  // такое определяет таймаутом и перезапрашивает; no-store обходит дневной
  // кэш (там могла осесть обрезанная копия)
  uprLoadMapImg(img, 0);
  const svg = uprSvgEl("svg", { viewBox: "0 0 3840 1996" });
  (window.UPR_MAP_SECTORS || []).forEach(s => {
    const c = uprZoneColor(s.num, s.faction);
    const p = uprSvgEl("path", { d: (s.d || []).join(" "), class: "upr-zone f-" + s.faction });
    p.dataset.num = s.num;
    p.style.fill = c.fill;
    p.style.stroke = c.stroke;
    p.onclick = () => {
      state.uprising.sel = s.num;
      state.uprising.variant = 0;
      renderUprising();
    };
    p.oncontextmenu = e => uprSectorCtx(e, s.num);
    svg.appendChild(p);
  });
  (window.UPR_MAP_SECTORS || []).forEach(s => {
    const art = uprBadgeArt(s.num, s.faction);
    const capital = art.capital;
    // картинка = щит (56|60) + полоса черепов, поднятая к сужению щита;
    // якорь — центр щита
    const W = 79;                                  // 66 × 1.2 (+20%)
    const sc = W / 36;
    const shH = capital ? 60 : 56, totH = capital ? 70.5 : 65.5;
    const g = uprSvgEl("g", { class: "upr-badge", transform: `translate(${s.cx},${s.cy})` });
    g.dataset.num = s.num;
    const im = uprSvgEl("image", { x: -W / 2, y: -shH * sc / 2, width: W, height: totH * sc,
      href: art.href });
    g.appendChild(im);
    // цифра ниже центрированной иконки (у капитала чуть ниже — тело длиннее)
    const tx = uprSvgEl("text", { x: 0, y: shH * (capital ? 0.22 : 0.186) * sc,
      "text-anchor": "middle", "dominant-baseline": "central" });
    tx.textContent = s.num;
    g.appendChild(tx);
    svg.appendChild(g);
  });
  box.append(img, svg);
  // оверлей-кнопки карты (шестерёнка + рандомайзер): живут в upr-random.js;
  // guard + try/catch — карта строится всегда, даже если оверлей упал
  try {
    if (typeof uprRndOverlay === "function") uprRndOverlay(box);
  } catch (e) { console.warn("upr overlay failed:", e); }
  root.appendChild(box);
}

function renderUprMap() {
  const map = $("#upr-map");
  if (!map.querySelector(".upr-map-box")) {
    uprBuildMap(map);
  }
  const have = new Set(uprGroups().map(g => g.num));
  map.querySelectorAll(".upr-zone").forEach(p => {
    const num = +p.dataset.num;
    p.classList.toggle("sel", state.uprising.sel === num);
    p.classList.toggle("empty", !have.has(num));
  });
  map.querySelectorAll(".upr-badge").forEach(b => {
    const sel = state.uprising.sel === +b.dataset.num;
    b.classList.toggle("sel", sel);
    // свечение бейджа — цветом зоны (не жёлтым акцентом), без brightness
    const s = (window.UPR_MAP_SECTORS || []).find(x => x.num === +b.dataset.num);
    const c = s && uprZoneColor(s.num, s.faction);
    const im = b.querySelector("image");
    if (im) im.style.filter = sel && c ? `drop-shadow(0 0 7px ${c.stroke})` : "";
  });
}

// перекраска зон без перестроения карты (после смены цвета в настройках);
// бейджи-щиты следуют выбранному цвету (включая капитальный вариант)
function uprApplyColors() {
  // щиты в открытом рандомайзере обновляются вместе с картой
  if (typeof window.uprRndRefreshShields === "function") {
    try { window.uprRndRefreshShields(); } catch (e) {}
  }
  const svg = $("#upr-map svg");
  if (!svg) return;
  (window.UPR_MAP_SECTORS || []).forEach(s => {
    const c = uprZoneColor(s.num, s.faction);
    const p = svg.querySelector(`.upr-zone[data-num="${s.num}"]`);
    if (p) { p.style.fill = c.fill; p.style.stroke = c.stroke; }
    const g = svg.querySelector(`.upr-badge[data-num="${s.num}"]`);
    if (!g) return;
    const art = uprBadgeArt(s.num, s.faction);
    const W = 79, sc = W / 36;
    const shH = art.capital ? 60 : 56, totH = art.capital ? 70.5 : 65.5;
    const im = g.querySelector("image"), tx = g.querySelector("text");
    if (im) {
      im.setAttribute("y", -shH * sc / 2);
      im.setAttribute("height", totH * sc);
      im.setAttribute("href", art.href);
    }
    if (tx) tx.setAttribute("y", shH * (art.capital ? 0.22 : 0.186) * sc);
  });
}

// модалка настроек карты (шестерёнка): плитка секторов (щит + сложность +
// цвет в одной рамочке) и страница пресетов с баланс-конфигом
function uprOpenColors() {
  const list = $("#upr-colors-list");
  if (!list) return;
  list.innerHTML = "";
  const sectors = (window.UPR_MAP_SECTORS || []).slice().sort((a, b) => a.num - b.num);
  const cur = uprColorOverrides();
  sectors.forEach(s => {
    const tile = document.createElement("div");
    tile.className = "upr-sec-tile";
    const shield = document.createElement("span");
    shield.className = "upr-sec-shield";
    const cap = UPR_CAPITALS[s.num] && uprImgFaction(UPR_CAPITALS[s.num]) === uprImgFaction(uprZoneKey(s.num, s.faction));
    shield.innerHTML = `<span class="upr-shield-wrap">${uprShieldSvg(s.num, uprZoneColor(s.num, s.faction).solid, 30)}<b class="upr-shield-num${cap ? " cap" : ""}">${s.num}</b></span>`;
    const nameRow = document.createElement("div");
    nameRow.className = "upr-sec-name";
    nameRow.innerHTML = `<span>${escapeHtml((t("upr_sector_reward") || "Награда сектора {n}").replace("{n}", String(s.num)))}</span><span class="upr-sector-sys">sector_${s.num}_reward</span>`;
    const sel = document.createElement("select");
    [["", "upr_color_auto"], ...Object.keys(UPR_COLORS).map(k => [k, "upr_col_" + k])]
      .forEach(([v, lk]) => {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = t(lk) || lk;
        if (v === (cur[s.num] || "")) o.selected = true;
        sel.appendChild(o);
      });
    sel.onchange = () => {
      uprSaveColor(s.num, sel.value);
      uprApplyColors();
      shield.innerHTML = `<span class="upr-shield-wrap">${uprShieldSvg(s.num, null, 30)}<b class="upr-shield-num${cap ? " cap" : ""}">${s.num}</b></span>`;
    };
    // сложность зоны: выпадающий список 1–6
    const dsel = document.createElement("select");
    dsel.className = "upr-diff-sel";
    dsel.title = t("upr_zone_diff") || "Сложность зоны";
    UPR_DIFFS.forEach(d => {
      const o = document.createElement("option");
      o.value = d;
      o.textContent = uprDiffLabel(d);
      if (uprZoneDiff(s.num) === d) o.selected = true;
      dsel.appendChild(o);
    });
    dsel.onchange = () => {
      uprSetZdiff(s.num, dsel.value);
      renderUprising();
      // щит плитки перерисовать тоже: черепа = живая сложность зоны
      shield.innerHTML = `<span class="upr-shield-wrap">${uprShieldSvg(s.num, null, 30)}<b class="upr-shield-num${cap ? " cap" : ""}">${s.num}</b></span>`;
    };
    tile.append(shield, nameRow, dsel, sel);
    list.appendChild(tile);
  });
  // блок баланс-конфига: путь к файлу + привязка/импорт/экспорт
  const box = $("#upr-cfg-box");
  if (box) {
    box.innerHTML = "";
    const title = document.createElement("div");
    title.className = "upr-cfg-title";
    title.textContent = t("upr_cfg_title") || "Баланс-конфиг";
    const prow = document.createElement("div");
    prow.className = "upr-cfg-prow";
    const pinp = document.createElement("input");
    pinp.type = "text";
    pinp.className = "upr-cfg-path";
    pinp.id = "upr-cfg-path";
    pinp.value = (state.config && state.config.uprising_cfg_path) || "";
    pinp.placeholder = "D:\\Terminator\\balance.cfg";
    pinp.spellcheck = false;
    pinp.onchange = () => {
      state.config.uprising_cfg_path = pinp.value.trim();
      api("/api/config", { method: "POST",
        body: JSON.stringify({ uprising_cfg_path: state.config.uprising_cfg_path }) })
        .catch(() => {});
    };
    prow.append(pinp);
    const brow = document.createElement("div");
    brow.className = "upr-cfg-brow";
    const mkBtn = (lk, fn, cls) => {
      const b = document.createElement("button");
      b.className = "btn sm " + (cls || "");
      b.textContent = t(lk) || lk;
      b.onclick = fn;
      return b;
    };
    brow.append(
      mkBtn("upr_bind_btn", uprBindDifficulty, "accent"),
      mkBtn("upr_cfg_import", uprCfgImport),
      mkBtn("upr_cfg_export", () => uprCfgExport(false)),
      mkBtn("upr_reset_btn", uprResetConfig, "danger"),
    );
    box.append(title, prow, brow);
    // пресеты карты: встроенные (из exe) + пользовательские
    const pt = document.createElement("div");
    pt.className = "upr-cfg-title";
    pt.textContent = t("upr_preset_title") || "Пресеты карты";
    const pprow = document.createElement("div");
    pprow.className = "upr-cfg-prow";
    const psel = document.createElement("select");
    psel.className = "upr-cfg-path";
    psel.id = "upr-preset-sel";
    pprow.append(psel);
    const pbrow = document.createElement("div");
    pbrow.className = "upr-cfg-brow";
    pbrow.append(
      mkBtn("upr_preset_apply", () => uprPresetApply(), "accent"),
      mkBtn("upr_preset_create", () => uprPresetCreate()),
    );
    box.append(pt, pprow, pbrow);
    uprPresetFill(psel);
    // восстановление оригинальной карты (переехало из модалки рандомайзера):
    // зелёная кнопка со своим свечением
    const rt = document.createElement("div");
    rt.className = "upr-cfg-title";
    rt.textContent = t("upr_rnd_restore") || "Восстановить оригинальную карту";
    const rrow = document.createElement("div");
    rrow.className = "upr-cfg-brow";
    const rb = document.createElement("button");
    rb.className = "btn sm green";
    rb.textContent = t("upr_rnd_restore") || "Восстановить оригинальную карту";
    rb.onclick = () => uprRndRestore();
    rrow.append(rb);
    box.append(rt, rrow);
  }
  uprRndBoxFill();
  uprExpertBoxFill();
  $("#upr-colors-modal").hidden = false;
}

// вкладка «Рандомайзер»: режим по умолчанию + быстрые галки + переход
async function uprRndBoxFill() {
  const box = $("#upr-rnd-box");
  if (!box) return;
  box.innerHTML = "";
  const hasRnd = typeof uprRndOpts === "function";
  const title = document.createElement("div");
  title.className = "upr-cfg-title";
  title.textContent = t("upr_set_rnd") || "Рандомайзер";
  box.appendChild(title);
  const prow = document.createElement("div");
  prow.className = "upr-cfg-prow";
  const sel = document.createElement("select");
  sel.className = "upr-cfg-path";
  sel.id = "upr-rnd-mode-sel";
  prow.appendChild(sel);
  box.appendChild(prow);
  const mkBtn = (lk, fb, fn, cls) => {
    const b = document.createElement("button");
    b.className = "btn sm " + (cls || "");
    b.textContent = t(lk) || fb;
    b.onclick = fn;
    return b;
  };
  const brow = document.createElement("div");
  brow.className = "upr-cfg-brow";
  const openSimple = () => {
    if (typeof uprRndOpenTab === "function") uprRndOpenTab("simple");
  };
  brow.append(
    mkBtn("upr_rnd_open", "Открыть рандомайзер", openSimple, "accent"),
  );
  box.appendChild(brow);
  // быстрые галки пишут прямо в опции рандомайзера
  const saveRnd = (o) => {
    try { localStorage.setItem("tsh_upr_rnd", JSON.stringify(o)); } catch (e) {}
    try { if (state.config) state.config.uprising_rnd_opts = JSON.parse(JSON.stringify(o)); } catch (e) {}
    try {
      api("/api/config", { method: "POST",
        body: JSON.stringify({ uprising_rnd_opts: o }) }).catch(() => {});
    } catch (e) {}
  };
  if (hasRnd) {
    const o = uprRndOpts();
    [["protectStarts", "upr_rnd_prot_starts", "Защищать стартовые"],
     ["protectCapitals", "upr_rnd_prot_caps", "Защищать столицы"],
     ["useModeSectors", "upr_rnd_sectors_from_mode", "Сложности секторов из режима"]
    ].forEach(([key, lk, fb]) => {
      const lb = document.createElement("label");
      lb.className = "upr-rnd-row";
      const c = document.createElement("input");
      c.type = "checkbox";
      c.checked = !!o[key];
      c.onchange = () => { o[key] = c.checked; saveRnd(o); };
      lb.append(c, document.createTextNode(t(lk) || fb));
      box.appendChild(lb);
    });
    // список режимов: встроенные + мои (свой перекрывает с пометкой)
    try {
      const r = await api("/api/uprising_rnd_modes", { method: "POST" });
      const j = await r.json();
      const grp = (label, arr) => {
        if (!arr.length) return;
        const g = document.createElement("optgroup");
        g.label = label;
        arr.forEach(n => {
          const stem = String(n).replace(/\.cfg$/i, "");
          const op = document.createElement("option");
          op.value = stem;
          try {
            op.textContent = (typeof uprRndModeTitle === "function")
              ? uprRndModeTitle(stem) : stem;
          } catch (e) { op.textContent = stem; }
          if (stem === o.mode) op.selected = true;
          g.appendChild(op);
        });
        sel.appendChild(g);
      };
      grp(t("upr_preset_builtin") || "Встроенные", (j.built_in || []).filter(n =>
        /^(easy|balanced|hard|chaos)\.cfg$/i.test(n)));
      grp(t("upr_preset_custom") || "Мои", j.custom || []);
      if (!sel.options.length) {
        const op = document.createElement("option");
        op.value = "balanced"; op.textContent = "balanced";
        sel.appendChild(op);
      }
      sel.onchange = async () => {
        if (typeof uprRndModeApply === "function") await uprRndModeApply(sel.value);
      };
    } catch (e) { /* без бэкенда — пустой список */ }
  }
}

// вкладка «Эксперт»: старый технический функционал + пометка
function uprExpertBoxFill() {
  const box = $("#upr-expert-box");
  if (!box) return;
  box.innerHTML = "";
  const title = document.createElement("div");
  title.className = "upr-cfg-title";
  title.textContent = t("upr_set_expert") || "Эксперт";
  const hint = document.createElement("div");
  hint.className = "settings-hint";
  hint.textContent = t("upr_expert_d") || "Для опытных: ручные веса, k, география и привязка сложности.";
  const brow = document.createElement("div");
  brow.className = "upr-cfg-brow";
  const mkBtn = (lk, fb, fn, cls) => {
    const b = document.createElement("button");
    b.className = "btn sm " + (cls || "");
    b.textContent = t(lk) || fb;
    b.onclick = fn;
    return b;
  };
  brow.append(
    mkBtn("upr_rnd_open_expert", "Открыть эксперт", () => {
      if (typeof uprRndOpenTab === "function") uprRndOpenTab("expert");
    }, "accent"),
    mkBtn("upr_rnd_bind", "Привязать сложность", () => uprBindDifficulty(), ""),
    mkBtn("upr_rnd_by_cost", "Предложить по стоимости", () => {
      if (typeof uprRndByCost === "function") uprRndByCost();
    }, ""),
  );
  box.append(title, hint, brow);
}
// список пресетов в select шестерёнки (группы: встроенные/пользовательские)
// встроенные пресеты сложности лежат английскими стволами (easy/normal/
// hard/chaos.cfg) — в списке показываем локализованные названия;
// пользовательские — как назвали
function uprPresetName(fn) {
  const stem = String(fn || "").replace(/\.cfg$/i, "");
  const key = { easy: "upr_preset_easy", normal: "upr_preset_normal",
    hard: "upr_preset_hard", chaos: "upr_preset_chaos" }[stem.toLowerCase()];
  return (key && t(key)) || stem;
}
async function uprPresetFill(sel) {
  sel.innerHTML = "";
  try {
    const r = await api("/api/uprising_presets", { method: "POST" });
    const j = await r.json();
    if (!j.ok) return;
    const grp = (label, arr, kind, namer) => {
      if (!arr.length) return;
      const g = document.createElement("optgroup");
      g.label = label;
      arr.forEach(n => {
        const o = document.createElement("option");
        o.value = kind + "|" + n;
        o.textContent = namer ? namer(n) : n.replace(/\.cfg$/i, "");
        g.appendChild(o);
      });
      sel.appendChild(g);
    };
    grp(t("upr_preset_builtin") || "Встроенные", j.built_in || [], "in", uprPresetName);
    grp(t("upr_preset_custom") || "Мои", j.custom || [], "custom", null);
  } catch (e) { /* noop */ }
  if (!sel.options.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = t("upr_preset_empty") || "Нет пресетов";
    sel.appendChild(o);
  }
}

// применить пресет: тот же парсер cfg, но активный баланс-конфиг не трогаем
async function uprPresetApply() {
  if (!state.uprising.path) return;
  const sel = $("#upr-preset-sel");
  const v = sel && sel.value;
  if (!v) return;
  const [kind, ...rest] = v.split("|");
  const name = rest.join("|");
  try {
    const g = await api("/api/uprising_preset_get", { method: "POST",
      body: JSON.stringify({ kind, name }) });
    const gj = await g.json();
    if (!gj.ok) { toast(gj.error || "error", "err"); return; }
    const r = await api("/api/uprising_cfg_read", { method: "POST",
      body: JSON.stringify({ path: gj.path }) });
    const j = await r.json();
    if (!j.ok) { toast(j.error || "error", "err"); return; }
    if (!j.exists || !(j.units || []).length) {
      toast(t("upr_cfg_empty") || "В конфиге нет юнитов", "err");
      return;
    }
    const choice = await askConfirm({
      title: t("upr_preset_apply") || "Применить пресет",
      message: (t("upr_cfg_confirm") || "Применить конфигурацию к текущей карте?") +
        `\n${(j.zones || []).length} — зон, ${j.units.length} — юнитов`,
      buttons: [
        { id: "ok", label: t("continue") || "Применить", kind: "danger" },
        { id: "cancel", label: t("cancel"), kind: "ghost" },
      ],
    });
    if (choice !== "ok") return;
    await uprCfgApply(j.zones || [], j.units || [], false);
    const modal = $("#upr-colors-modal");
    if (modal && !modal.hidden) uprOpenColors();
  } catch (e) { toast(String(e), "err"); }
}

// создать пресет из текущей карты — тем же сериализатором, что баланс-конфиг
async function uprPresetCreate() {
  if (!state.uprising.path || !uprGroups().length) return;
  const name = await askPrompt({
    title: t("upr_preset_name_t") || "Новый пресет",
    value: "", placeholder: t("upr_preset_name_ph") || "Название",
    okLabel: t("upr_preset_create") || "Создать пресет",
  });
  if (name === null) return;
  const nm = String(name).trim();
  if (!nm) return;
  try {
    const r = await api("/api/uprising_preset_save", { method: "POST",
      body: JSON.stringify({ name: nm, ...uprCfgPayload() }) });
    const j = await r.json();
    if (!j.ok) {
      if (j.error === "exists") {
        const c = await askConfirm({
          title: nm,
          message: t("upr_preset_exists") || "Такой пресет уже есть. Перезаписать?",
          buttons: [
            { id: "ok", label: t("upr_overwrite") || "Перезаписать", kind: "danger" },
            { id: "cancel", label: t("cancel"), kind: "ghost" },
          ],
        });
        if (c !== "ok") return;
        const r2 = await api("/api/uprising_preset_save", { method: "POST",
          body: JSON.stringify({ name: nm, overwrite: true, ...uprCfgPayload() }) });
        const j2 = await r2.json();
        if (!j2.ok) { toast(j2.error || "error", "err"); return; }
        uprNoteExtraHist(j2.path);
      } else { toast(j.error || "error", "err"); return; }
    }
    else uprNoteExtraHist(j.path);
    toast(t("upr_preset_saved") || "Пресет сохранён", "ok");
    const sel = $("#upr-preset-sel");
    if (sel) uprPresetFill(sel);
  } catch (e) { toast(String(e), "err"); }
}

// сворачивание/разворачивание панели параметров
function uprSetPanel(open) {
  // модалка зоны по центру временно отключена — боковая панель всегда открыта
  if (!UPR_MODAL_ENABLED) open = true;
  state.uprising.panel = !!open;
  const wrap = $("#upr-wrap");
  const btn = $("#upr-panel-toggle");
  if (!wrap || !btn) return;
  wrap.classList.toggle("panel-closed", !open);
  btn.textContent = open ? "\u2039" : "\u203A";
  btn.title = open ? (t("upr_panel_hide") || "Свернуть панель")
                   : (t("upr_panel_show") || "Показать панель");
  // панель скрыта + выбрана зона -> редактор открывается модалкой
  if (state.uprising.rows) renderUprising();
}

// заголовки секций — иконки вместо текста (assets/Campaign/UnitSet,
// как кампания): squads=infantry, cars=light_vehicle, tanks=tank,
// helicopters=heli, inventory_items=supply_vehicle. Текст — в title/alt,
// нет файла — откат на подпись; extra — приписка справа (счётчик)
var UPR_CAT_ICONS = {
  squads: "infantry.webp",
  cars: "light_vehicle.webp",
  tanks: "tank.webp",
  helicopters: "heli.webp",
  inventory_items: "supply_vehicle.webp",
};
function uprCatTitle(titleEl, cat, extra) {
  const label = (t("upr_cat_" + cat) || cat) + (extra || "");
  titleEl.title = t("upr_cat_" + cat) || cat;
  const f = UPR_CAT_ICONS[cat];
  if (!f) { titleEl.textContent = label; return; }
  const img = document.createElement("img");
  img.className = "cmp-sec-icon";
  img.src = "/assets/campaign/UnitSet/" + f;
  img.alt = label;
  img.draggable = false;
  img.onerror = () => { try { titleEl.textContent = label; } catch (e) {} };
  titleEl.appendChild(img);
  if (extra) {
    const s = document.createElement("span");
    s.className = "cmp-sec-count";
    s.textContent = extra;
    titleEl.appendChild(s);
  }
}

// вид иконок юнитов: «slot» (слоты эксперимента, дефолт — первая кнопка
// активна) или «classic» (визуал побайтово как до эксперимента + squads
// 72x72). Флаг один глобальный (localStorage tsh_upr_icon_view), кнопки —
// в шапках вкладок карты и кампании, чипы всех панелей и редактора
// следуют флагу через guard в vehDecor/squadNum + CSS body.upr-view-classic
function uprIconView() {
  try {
    return localStorage.getItem("tsh_upr_icon_view") === "classic"
      ? "classic" : "slot";
  } catch (e) { return "slot"; }
}
function uprViewApply() {
  try {
    document.body.classList.toggle("upr-view-classic",
      uprIconView() === "classic");
  } catch (e) {}
  uprViewPaint();
}
function uprViewPaint() {
  const v = uprIconView();
  document.querySelectorAll(".upr-view-btn").forEach(b => {
    const on = b.dataset.view === v;
    b.classList.toggle("sel", on);
    try { b.setAttribute("aria-pressed", on ? "true" : "false"); } catch (e) {}
  });
}
// пара кнопок-переключателей без текста для заголовка панели (первая —
// слот: фон unitslot_main + иконка пехоты внутри, вторая — просто иконка);
// свежий узел каждый раз — шапки перестраиваются при каждом рендере
function uprViewToggle() {
  const g = document.createElement("span");
  g.className = "upr-view-toggle";
  g.setAttribute("role", "group");
  const v = uprIconView();
  [["slot", true], ["classic", false]].forEach(([vv, composite]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "upr-view-btn" + (vv === v ? " sel" : "");
    b.dataset.view = vv;
    const lab = t("upr_view_" + vv) || vv;
    b.title = lab;
    b.setAttribute("aria-label", lab);
    try { b.setAttribute("aria-pressed", vv === v ? "true" : "false"); } catch (e) {}
    const img = document.createElement("img");
    img.src = "/assets/campaign/UnitSet/infantry.webp";
    img.alt = "";
    img.draggable = false;
    if (composite) {
      const slot = document.createElement("span");
      slot.className = "upr-view-slot";
      slot.appendChild(img);
      b.appendChild(slot);
    } else b.appendChild(img);
    b.onclick = () => uprSetIconView(vv);
    g.appendChild(b);
  });
  return g;
}
function uprSetIconView(v) {
  if (v !== "slot" && v !== "classic") return;
  try { localStorage.setItem("tsh_upr_icon_view", v); } catch (e) {}
  uprViewApply();
  // перерендер всех мест с чипами: панель сектора карты, панель кампании,
  // редактор рандомайзера (у каждого свой рендер — зовём что доступно)
  try { if (state.uprising.rows) renderUprising(); } catch (e) {}
  try { if (typeof cmpPaintPanel === "function") cmpPaintPanel(); } catch (e) {}
  try { if (typeof edRender === "function") edRender(); } catch (e) {}
}

// локализация имён юнитов на чипах: «on» (дефолт — первая кнопка активна)
// показывает имя из locale-XML (state.nameMap: проект+мод+игра+GameAssets),
// «без» — сырой sysname. Нет записи — всегда sysname. Флаг один глобальный
// (localStorage tsh_upr_unit_loc), кнопки-без-текста — в шапках рядом
// с переключателем вида иконок; чипы следуют флагу через uprUnitName
function uprUnitLoc() {
  try {
    return localStorage.getItem("tsh_upr_unit_loc") === "off" ? false : true;
  } catch (e) { return true; }
}
function uprUnitName(sys) {
  const s = String(sys == null ? "" : sys);
  if (!s) return s;
  try {
    if (uprUnitLoc() && state.nameMap && state.nameMap[s])
      return state.nameMap[s];
  } catch (e) {}
  return s;
}
function uprLocPaint() {
  const v = uprUnitLoc() ? "on" : "off";
  document.querySelectorAll(".upr-loc-btn").forEach(b => {
    const on = b.dataset.loc === v;
    b.classList.toggle("sel", on);
    try { b.setAttribute("aria-pressed", on ? "true" : "false"); } catch (e) {}
  });
}
// иконка-переводчик: облачко + «A» (вкл), то же перечёркнутое (выкл).
// Буква внутри SVG — часть картинки, текстовых подписей у кнопок нет
// (название — только в title/aria-label из словаря)
function uprLocIcon(on) {
  const slash = on ? ""
    : '<line x1="5" y1="20" x2="19" y2="4"/>';
  return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none"'
    + ' stroke="currentColor" stroke-width="2" stroke-linejoin="round">'
    + '<path d="M4 5h16v10H9l-5 4V5z"/>'
    + '<text x="12" y="14.5" text-anchor="middle" font-size="8"'
    + ' fill="currentColor" stroke="none" font-family="Segoe UI,sans-serif"'
    + ' font-weight="700">A</text>' + slash + "</svg>";
}
// пара кнопок-переключателей без текста для заголовка панели (рядом
// с uprViewToggle); свежий узел каждый раз — шапки перестраиваются
function uprLocToggle() {
  const g = document.createElement("span");
  g.className = "upr-view-toggle upr-loc-toggle";
  g.setAttribute("role", "group");
  const v = uprUnitLoc() ? "on" : "off";
  ["on", "off"].forEach(vv => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "upr-loc-btn" + (vv === v ? " sel" : "");
    b.dataset.loc = vv;
    const lab = t("upr_loc_" + vv) || vv;
    b.title = lab;
    b.setAttribute("aria-label", lab);
    try { b.setAttribute("aria-pressed", vv === v ? "true" : "false"); } catch (e) {}
    b.innerHTML = uprLocIcon(vv === "on");
    b.onclick = () => uprSetUnitLoc(vv);
    g.appendChild(b);
  });
  return g;
}
function uprSetUnitLoc(v) {
  const nv = v === "off" ? "off" : "on";
  try { localStorage.setItem("tsh_upr_unit_loc", nv); } catch (e) {}
  uprLocPaint();
  // имена запечены в чипах при рендере — перерисовать всё как вид иконок
  try { if (state.uprising.rows) renderUprising(); } catch (e) {}
  try { if (typeof cmpPaintPanel === "function") cmpPaintPanel(); } catch (e) {}
  try { if (typeof edRender === "function") edRender(); } catch (e) {}
}

// url иконки юнита/предмета карты Uprising по sysname (сначала готовая webp,
// затем старый поиск dds; нет иконки = плейсхолдер категории cat, не 404)
function uprIconUrl(name, cat) {
  const p = new URLSearchParams({
    name: name || "",
    root: uprSrcRoot() || "",
    game: (state.config && state.config.unpacked_path) || "",
  });
  if (cat) p.set("cat", cat);
  return "/api/uprising_icon?" + p.toString();
}

// категорийный плейсхолдер чипа (прямой URL готовой webp из плоского
// assets/UprisingMap, без бэкенда).
// Предметы с префиксом wpn_ получают собственный wpn_placeholder.webp,
// остальные предметы — тот же плейсхолдер, что отряды (squads).
function uprPlaceholderUrl(cat, name) {
  if ((name || "").toLowerCase().startsWith("wpn_"))
    return "/assets/UprisingMap/wpn_placeholder.webp";
  switch (cat) {
    case "cars": case "tanks": case "helicopters":
      return "/assets/UprisingMap/placeholder_vehicle.webp";
    case "squads":
    case "inventory_items":
      return "/assets/UprisingMap/placeholder_Squads_items.webp";
    default: return "";
  }
}

// Единая иконка чипа для карты, кампании и cfg-редактора: плейсхолдер
// категории ставится МГНОВЕННО под спиннер (предметы — squads-плейсхолдер),
// одиночный запрос — только после готового батча и в фоне (до батча сотни
// синглов душили сервер по HTTP/1.0, а чипы висели пустыми). Реальная
// иконка подменяет плейсхолдер; недолёт сингла — остаёмся на плейсхолдере.
// src — чужой источник ({map, ready}, кампания держит свою карту иконок).
// src.fail — известные missing (campaign.iconFail / units.iconFail): такие
// чипы сразу встают на плейсхолдер БЕЗ спиннера и сольного запроса — иначе
// каждое открытие сыпало сотнями HTTP/1.0-синглов заведомого несуществующего.
function uprChipIcon(img, chip, name, cat, src) {
  if (!img) return;
  // имя/категория — на img для досмотра недогруженных (uprReloadImages)
  img.dataset.uprName = name || "";
  img.dataset.uprCat = cat || "";
  // ховер/выбранное — один раз на чип (все три рендера идут через хелпер)
  if (chip && !chip.dataset.uprStBound) {
    chip.dataset.uprStBound = "1";
    chip.addEventListener("mouseenter", () => uprChipHover(chip, true));
    chip.addEventListener("mouseleave", () => uprChipHover(chip, false));
  }
  const ph = (typeof uprPlaceholderUrl === "function")
    ? (uprPlaceholderUrl(cat, name) || "") : "";
  const failed = !!(src && src.fail && src.fail[name]);
  if (failed) {
    // заведомо нет иконки: честный плейсхолдер без спиннера и сингла
    // (спиннер от прошлого прохода — снять, real — сбросить для досмотра)
    if (chip) chip.classList.remove("upr-loading");
    delete img.dataset.uprReal;
    if (ph) { if (chip) chip.classList.add("upr-chip-ph"); img.src = ph; }
    return;
  }
  const ready = src ? !!src.ready
    : ((typeof uprIconsReady !== "undefined") && uprIconsReady);
  const icons = (src && src.map)
    || ((typeof uprIconMap !== "undefined" && uprIconMap) || {});
  const pending = (typeof uprPendingIcons !== "undefined")
    && uprPendingIcons.has(name);
  const du = icons[name] || "";
  // иконка уже в памяти (data-URL) — встанет мгновенно, спиннер не нужен:
  // иначе каждый перерендер (закрытие попапа, выбор) мигает спиннерами
  if (chip && !du) chip.classList.add("upr-loading");
  const showReal = url => {
    img.dataset.uprReal = "1";
    if (!img.dataset.uprBase) img.dataset.uprBase = url;
    img.src = url;
    uprChipStatePaint(chip, img);
  };
  img.onload = () => {
    if (!img.dataset.uprReal) return; // плейсхолдер встал — ждём реальную
    if (typeof cmpSpanChip === "function") {
      try { cmpSpanChip(chip, img); } catch (e) { /* noop */ }
    }
    if (chip && !pending) chip.classList.remove("upr-loading");
  };
  img.onerror = () => {
    // реальная не долетела (битый data-URL) — остаёмся на плейсхолдере
    if (chip && !pending) chip.classList.remove("upr-loading");
  };
  if (du) { if (chip && ph) chip.classList.add("upr-chip-ph"); showReal(du); return; }
  if (ph) { if (chip) chip.classList.add("upr-chip-ph"); img.src = ph; }
  if (!ready) return; // до батча синглы не дёргаем — батч всё закроет
  // имя добавлено после батча (правка): фоновый сингл с одним повтором
  // (оборванный коннект WinError 10054), затем — честный плейсхолдер
  const solo = new Image();
  solo.onload = () => showReal(solo.src);
  solo.onerror = () => {
    if (solo.dataset.uprRetry) {
      if (chip && !pending) chip.classList.remove("upr-loading");
      return;
    }
    solo.dataset.uprRetry = "1";
    let url = uprIconUrl(name, cat);
    if (!String(solo.src).startsWith("data:")) url += "&retry=1";
    solo.src = url;
  };
  solo.src = uprIconUrl(name, cat);
}

// карта иконок: sysname -> data-URL webp (один запрос до первого рендера).
// Чипы — прямые <img> из памяти: ноль конвертации, спрайта и HTTP-запросов.
// Имён вне карты (правки после загрузки) добираются одиночным
// /api/uprising_icon (там тоже webp-first).
let uprIconMap = {};
// досмотр недогруженных чипов (рваный коннект без error/onload):
// застрял на плейсхолдере после батча или висит реальная — прогнать
// через uprChipIcon заново; возвращает число перезапущенных
function uprReloadImages() {
  const wrap = $("#upr-wrap");
  if (!wrap) return 0;
  const ready = (typeof uprIconsReady !== "undefined") && uprIconsReady;
  let n = 0;
  wrap.querySelectorAll("img.upr-chip-icon").forEach(img => {
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
      uprChipIcon(img, chip, name, img.dataset.uprCat || "");
      n++;
    } catch (e) {}
  });
  return n;
}
let uprImgSweepT = 0;
// состояния иконок чипов (ховер/выбранное): {name:{hover:url,selected:url}}
// с бэкенда (/api/uprising_icon_states, сиблинги _preselected/_selected и
// _o/_s тем же dds->webp в CustomImages). Выбранное бьёт ховер; нет пары —
// базовая иконка, как раньше
let uprIconStates = {};
async function uprEnsureIconStates(root, names) {
  root = root || "";
  if (!root || !names || !names.length) return;
  try {
    const r = await api("/api/uprising_icon_states", { method: "POST",
      body: JSON.stringify({ root, names }), timeout: 60000 });
    const j = await r.json();
    if (!j || !j.ok) return;
    Object.assign(uprIconStates, j.states || {});
    // состояния долетели позже иконок: перекрасить выбранные чипы обеих карт
    // и списков юнитов (те же чипы кампании: ховер/selected-пары)
    document.querySelectorAll("#upr-wrap img.upr-chip-icon, #cmp-wrap img.upr-chip-icon, #unt-main img.upr-chip-icon")
      .forEach(img => {
        const chip = (img.closest && img.closest(".upr-chip")) || img.parentNode;
        if (chip) uprChipStatePaint(chip, img);
      });
  } catch (e) {}
}
// выбранное (.sel кампания, .picked восстание) vs базовое: подмена src;
// ховер — только через uprChipHover (иначе гонка с предзагрузкой)
function uprChipStatePaint(chip, img) {
  if (!chip) return;
  try {
    img = img || (chip.querySelector ? chip.querySelector("img.upr-chip-icon") : null);
    if (!img || !img.dataset.uprReal) return;
    const st = uprIconStates[img.dataset.uprName || ""] || null;
    const sel = chip.classList.contains("sel") || chip.classList.contains("picked");
    const base = img.dataset.uprBase || "";
    if (sel && st && st.selected) { if (img.src !== st.selected) img.src = st.selected; }
    else if (!sel && base && img.src !== base) img.src = base;
  } catch (e) {}
}
function uprChipHover(chip, on) {
  if (!chip) return;
  try {
    const img = chip.querySelector ? chip.querySelector("img.upr-chip-icon") : null;
    if (!img || !img.dataset.uprReal) return;
    const st = uprIconStates[img.dataset.uprName || ""] || null;
    const sel = chip.classList.contains("sel") || chip.classList.contains("picked");
    if (on && !sel && st && st.hover && img.src !== st.hover) {
      const pre = new Image();
      pre.onload = () => {
        try {
          if (chip.matches(":hover") && !chip.classList.contains("sel") &&
              !chip.classList.contains("picked")) img.src = st.hover;
        } catch (e) {}
      };
      pre.src = st.hover;
    } else if (!on) uprChipStatePaint(chip, img);
  } catch (e) {}
}
// кнопка add (обе карты): ховер и открытое окно — add_unit_h.webp,
// иначе add_unit.webp (_h предзагружен один раз)
var UPR_ADD_SRC = "/assets/UprisingMap/add_unit.webp",
    UPR_ADD_HOV = "/assets/UprisingMap/add_unit_h.webp";
function uprAddBtn(add, img) {
  if (!add || !img || add.dataset.uprAddBound) return;
  add.dataset.uprAddBound = "1";
  add.addEventListener("mouseenter", () => {
    if (img.src !== UPR_ADD_HOV) img.src = UPR_ADD_HOV;
  });
  add.addEventListener("mouseleave", () => {
    if (!add.classList.contains("open") && img.src !== UPR_ADD_SRC) img.src = UPR_ADD_SRC;
  });
}
function uprAddOpen(add, on) {
  if (!add) return;
  try {
    add.classList.toggle("open", !!on);
    const img = add.querySelector ? add.querySelector("img.upr-chip-add-icon") : null;
    if (img) img.src = on ? UPR_ADD_HOV : UPR_ADD_SRC;
  } catch (e) {}
}
// батч долетел целиком: "" в карте = иконки точно нет (можно сразу
// категорийный плейсхолдер); иначе чипы добирают одиночными запросами
let uprIconsReady = false;

function uprIconNames() {
  const names = new Set();
  (state.uprising.rows || []).forEach(row => {
    UPRISING_CATS.forEach(cat => {
      const ci = uprCatCol(cat);
      if (ci !== -1) {
        uprParseList(ci < row.values.length ? row.values[ci] : "")
          .forEach(x => x.name && names.add(x.name));
      }
    });
  });
  return [...names];
}

// Движок иконок карты — общее ядро static/js/icons.js (одно на три
// страницы). Своё здесь только: карта uprIconMap, готовность uprIconsReady,
// спиннеры конвертируемых (uprPendingIcons), перекраска renderUprising,
// бар upr-conv. Fail-карты нет (как было: missing добирают одиночными).
let uprIconEng = null;
function uprIconEngine() {
  if (uprIconEng) return uprIconEng;
  uprIconEng = iconEngine({
    root: () => uprSrcRoot(),
    map: () => uprIconMap,
    pending: (typeof uprPendingIcons !== "undefined") ? uprPendingIcons : null,
    isFresh: () => !!state.uprising,
    ready: v => { uprIconsReady = !!v; },
    states: (root, names) => {
      try { uprEnsureIconStates(root, names); } catch (e) {}
    },
    onChunk: added => {
      if ((added || []).length) {
        try { renderUprising(); } catch (e) {}
      }
    },
    onProgress: (done, total) => {
      try {
        state.uprising.preloading = true;
        if (done === 0) uprConvShow(total);
        else uprConvPaint(done, total);
      } catch (e) {}
    },
    onSettled: () => {
      try { state.uprising.preloading = false; } catch (e) {}
      try { uprConvHide(); } catch (e) {}
    },
  });
  return uprIconEng;
}

async function uprEnsureIcons(seq) {
  const my = (typeof seq === "number") ? seq : state.uprising.loadSeq;
  // корень фиксируем на старт: пока летит ответ, источник могли переключить —
  // чужую карту не применяем (иначе иконки чужого слоя + каскад одиночных)
  const root = uprSrcRoot();
  const names = uprIconNames();
  uprIconMap = {};
  uprIconsReady = false;
  if (!names.length) { uprIconsReady = true; return; }
  const fresh = () => my === state.uprising.loadSeq && root === uprSrcRoot();
  // Ядро static/js/icons.js (одно на три страницы): URL-батч вместо
  // data-URL мегабайтов, недостающие dds жмутся фоном чанками preload
  // с прогрессом под сегментом, перекраска по мере готовности.
  // Шильдики/состояния/плейсхолдеры — как были.
  try {
    await uprIconEngine().ensure(names, { root, fresh });
  } catch (e) { /* чипы доберут одиночными + onerror-ретраем */ }
}

// ЭКСПЕРИМЕНТ «слот техники» (откат: удалить блок до uprConvShow + вызовы
// vehDecor в трёх рендерах + CSS .veh + /api/unit_capacity): чип cars/tanks/
// helicopters — фон unitslot_main.webp, sysname сверху, у кого people_capacity
// > 0 — тёмная полоса мест «0/N» между именем и иконкой.
var VEH_CATS = ["cars", "tanks", "helicopters"];
let vehCapMap = null, vehCapLoading = false, vehCapRoot = "";
function vehCapEnsure(root) {
  root = root || ((typeof uprSrcRoot === "function") ? uprSrcRoot() : "");
  if (vehCapLoading || (vehCapMap && vehCapRoot === (root || ""))) {
    if (vehCapMap) vehCapFlush();
    return;
  }
  vehCapLoading = true;
  vehCapRoot = root || "";
  api("/api/unit_capacity", { method: "POST",
    body: JSON.stringify({ root: vehCapRoot }), timeout: 30000 })
    .then(r => r.json())
    .then(j => {
      if (j && j.ok) { vehCapMap = j.capacity || {}; vehCapFlush(); }
    })
    .catch(() => {})
    .finally(() => { vehCapLoading = false; });
}
function vehCapFlush() {
  document.querySelectorAll("[data-veh-cap-pending]").forEach(chip => {
    const sys = chip.dataset.vehCapPending;
    delete chip.dataset.vehCapPending;
    const cap = parseInt((vehCapMap || {})[sys], 10) || 0;
    if (cap > 0) vehCapStripe(chip, cap);
  });
}
// полоса — оверлей вне потока: высоту слота не меняет, резерв не нужен
function vehCapStripe(chip, cap) {
  if (!chip || !cap || chip.querySelector(":scope > .upr-chip-veh-cap")) return;
  const s = document.createElement("span");
  s.className = "upr-chip-veh-cap";
  s.textContent = "0/" + cap;
  chip.appendChild(s);
}
function vehDecor(chip, sys, cat, root) {
  if (!chip || !sys) return;
  // вид «classic» — как до эксперимента: декора слота нет вообще
  if (typeof uprIconView === "function" && uprIconView() === "classic") return;
  // ЭКСПЕРИМЕНТ «слот пехоты»: squads — фон unitslot_main_inf + sysname +
  // шильдик N/N слева внизу (members), полосы мест нет
  const isVeh = VEH_CATS.indexOf(cat) !== -1;
  const isInf = cat === "squads";
  if (!isVeh && !isInf) return;
  chip.classList.add(isVeh ? "veh" : "inf");
  // слот пехоты широкий (148): в сетке кампании занимает 2 колонки, как
  // техника — cmpSpanChip ставит cmp-span только широким иконкам, квадратные
  // 60x60 его не получают и наезжают друг на друга (сетка 72px)
  if (isInf) chip.classList.add("cmp-span");
  if (!chip.querySelector(":scope > .upr-chip-veh-sys")) {
    const nm = document.createElement("span");
    nm.className = "upr-chip-veh-sys";
    // подпись — локализованное имя при включённой локализации, sysname
    // всегда остаётся в подсказке чипа
    nm.textContent = (typeof uprUnitName === "function") ? uprUnitName(sys) : sys;
    nm.title = sys;
    chip.insertBefore(nm, chip.firstChild);
  }
  if (isVeh) {
    if (vehCapMap) {
      const cap = parseInt(vehCapMap[sys], 10) || 0;
      if (cap > 0) vehCapStripe(chip, cap);
    } else {
      chip.dataset.vehCapPending = sys;
      vehCapEnsure(root);
    }
    return;
  }
  squadNum(chip, sys, root);
}
// ЭКСПЕРИМЕНТ «слот пехоты»: шильдик численности N/N слева внизу слота
let squadMap = null, squadLoading = false, squadRoot = "";
function squadEnsure(root) {
  root = root || ((typeof uprSrcRoot === "function") ? uprSrcRoot() : "");
  if (squadLoading || (squadMap && squadRoot === (root || ""))) {
    if (squadMap) squadFlush();
    return;
  }
  squadLoading = true;
  squadRoot = root || "";
  api("/api/squad_size", { method: "POST",
    body: JSON.stringify({ root: squadRoot }), timeout: 30000 })
    .then(r => r.json())
    .then(j => {
      if (j && j.ok) { squadMap = j.squad || {}; squadFlush(); }
    })
    .catch(() => {})
    .finally(() => { squadLoading = false; });
}
function squadFlush() {
  document.querySelectorAll("[data-squad-pending]").forEach(chip => {
    const sys = chip.dataset.squadPending;
    delete chip.dataset.squadPending;
    squadNum(chip, sys);
  });
}
function squadNum(chip, sys, root) {
  if (!chip || !sys) return;
  // вид «classic» — счётчика N/N нет (как до эксперимента)
  if (typeof uprIconView === "function" && uprIconView() === "classic") return;
  let el = chip.querySelector(":scope > .upr-chip-inf-num");
  if (!el) {
    el = document.createElement("span");
    el.className = "upr-chip-inf-num";
    chip.appendChild(el);
  }
  if (squadMap) {
    const n = parseInt(squadMap[sys], 10) || 0;
    el.textContent = n > 0 ? n + "/" + n : "";
    el.style.display = n > 0 ? "" : "none";
  } else {
    el.style.display = "none";
    chip.dataset.squadPending = sys;
    squadEnsure(root);
  }
}

// мини-прогресс конвертации иконок под сегментом Проект/Игра/Мод
// (абсолютное позиционирование — страницу не раздвигает)
function uprConvShow(total) {
  const w = $("#upr-conv");
  if (!w) return;
  w.hidden = false;
  uprConvPaint(0, total);
}
function uprConvPaint(done, total) {
  const f = $("#upr-conv-fill"), tx = $("#upr-conv-txt");
  const pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 100;
  if (f) f.style.width = pct + "%";
  if (tx) tx.textContent = (t("upr_conv_icons") || "Иконки") +
    ": " + done + "/" + total;
}
// прячем, только если никакая конвертация не идёт (предзагрузка и ручной
// «Анализ» делят один бар и могут лететь одновременно)
function uprConvHide() {
  if (state.uprising.preloading || state.uprising.analyzing) return;
  const w = $("#upr-conv");
  if (w) w.hidden = true;
}

// имена, чья иконка ещё может появиться (конвертация в полёте): чипы
// держат спиннер поверх плейсхолдера вместо статичной заглушки.
// Ведёт общее ядро иконок (pending-Set ядра); наполнение/перекраска —
// колбэками uprIconEngine выше.
let uprPendingIcons = new Set();

function uprChipEditor(container, items, onChange, meta) {
  // список чипов «имя ×n»: имя не редактируется кликом (F2/ПКМ → «Редактировать»),
  // количество — числовым полем; весь чип — ручка переноса; клик — выделение

  const render = () => {
    container.querySelectorAll(".upr-chip,.upr-chip-add").forEach(e => e.remove());
    items.forEach((it, i) => {
      const chip = document.createElement("span");
      chip.className = "upr-chip upr-card";
      // категория для иконок/плейсхолдеров/слотов — на весь чип, а не только
      // внутрь if (it.name): vehDecor внизу использует её вне того блока
      // (ReferenceError «phCat is not defined» гасил все непустые сектора)
      const phCat = meta && meta.cat;
      const known = !state.uprising.sysnames.length
        || state.uprising.sysnames.includes(it.name);
      if (!known) { chip.classList.add("unknown"); }
      const key = meta && it.name ? uprPickKey(meta.num, meta.vi, meta.cat, it.name) : "";
      if (key) chip.dataset.key = key;
      if (key && state.uprising.pick.has(key)) chip.classList.add("picked");
      if (it.name) {
        // подсказка: локализованное имя + sysname + сложность + количество
        // (правки идут по sysname — он виден всегда, локализация лишь сверху)
        const ud = (key && uprUdiffs()[key]) || "";
        const dn = (typeof uprUnitName === "function") ? uprUnitName(it.name) : it.name;
        chip.title = (dn !== it.name ? dn + "\n" : "") + it.name
          + `\n${t("upr_tip_diff") || "Сложность"}: ${ud || "—"}`
          + ` · ${t("upr_tip_count") || "Количество"}: ×${it.n}`
          + (known ? "" : `\n${t("upr_unknown") || "?"}`);
        // два шильдика: сложность с черепом — верхний левый угол голым
        // текстом, цена+количество — справа внизу в пилюле с подложкой
        // (как было), в один шильдик: «цена ×n»; цены нет — пилюля только
        // с количеством (цены/статы уже в памяти после prices-запроса)
        const effDiff = ud || ((meta && meta.num) ? uprZoneDiff(meta.num) : "—");
        const bcost = uprPrice(meta && meta.cat, it.name);
        const df = document.createElement("span");
        df.className = "upr-chip-corner-diff";
        const skull = document.createElement("img");
        skull.className = "upr-chip-skull";
        skull.src = "/assets/UprisingMap/difficulty.webp";
        skull.alt = "";
        skull.draggable = false;
        const dt = document.createElement("span");
        dt.textContent = effDiff;
        df.append(skull, dt);
        chip.appendChild(df);
        const badge = document.createElement("span");
        badge.className = "upr-chip-badge" +
          ((meta && meta.cat === "inventory_items") ? " upr-chip-badge-items" : "");
        const bt = document.createElement("span");
        bt.textContent = (bcost ? bcost + " " : "") + "×" + it.n;
        badge.appendChild(bt);
        chip.appendChild(badge);
        // карточка = чистая иконка реального размера (техника 136x72,
        // пехота 60x60, предметы свои размеры); без подложки и подписей.
        // Правка всего (имя/количество/сложность/удаление) — двойной клик,
        // F2 или ПКМ → Редактировать: модалка поверх карточки.
        // прямая готовая webp из карты URL (фолбэк — одиночный запрос)
        const img = document.createElement("img");
        img.className = "upr-chip-icon";
        img.draggable = false;
        img.loading = "lazy";
        img.alt = "";
  // иконка через общий хелпер: мгновенный плейсхолдер категории
  // под спиннером, реальная подменяет (см. uprChipIcon)
  uprChipIcon(img, chip, it.name, phCat);
  chip.appendChild(img);
      } else {
        chip.textContent = "?";
      }
      chip.ondblclick = e => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        uprEditPop(chip, meta, items, i);
      };
      // весь чип — ручка: mousedown+движение = перенос, клик = выделение
      chip.onmousedown = e => {
        if (e.button !== 0 || !it.name) return;
        if (e.target.closest("input,button")) return;
        e.preventDefault();
        uprDragStart(e, meta, items, i, chip);
      };
      chip.oncontextmenu = e => uprChipCtx(e, meta, items, i);
      // ЭКСПЕРИМЕНТ «слот техники»: фон + sysname + полоса мест
      vehDecor(chip, it.name, phCat, uprSrcRoot());
      container.appendChild(chip);
    });
    const add = document.createElement("button");
    add.className = "upr-chip-add";
    add.title = t("upr_add") || "Добавить";
    add.setAttribute("aria-label", t("upr_add") || "Добавить");
    // иконка-кнопка всегда последняя в ряду (add_unit.webp)
    const addImg = document.createElement("img");
    addImg.className = "upr-chip-add-icon";
    addImg.src = "/assets/UprisingMap/add_unit.webp";
    addImg.alt = "";
    addImg.draggable = false;
    add.appendChild(addImg);
    uprAddBtn(add, addImg);
    add.onclick = ev => { ev.stopPropagation(); uprAddNew(meta, items, onChange, add); };
    container.appendChild(add);
    // вставка из буфера правым кликом по пустому месту секции
    container.oncontextmenu = e => {
      if (e.target === container) uprChipCtx(e, meta, items, items.length - 1);
    };
  };
  render();
}

// пакетная сложность мультивыделения: одно значение всем выбранным
function uprBulkDiff() {
  const keys = [...(state.uprising.pick || [])];
  if (!keys.length) return;
  const v = prompt(t("upr_bulk_diff_hint") ||
    "Задать сложность всем выбранным (4 или 3-5, пусто — наследовать зону)", "");
  if (v === null) return;
  const s = String(v).trim();
  if (s && !/^[1-6]$/.test(s) && !/^[1-6]-[1-6]$/.test(s)) {
    toast(t("upr_diff_bad") || "Нужно 1-6 или диапазон 2-4", "err");
    return;
  }
  keys.forEach(k => uprSetUdiff(k, s));
  state.uprising.pick.clear();
  renderUprising();
  toast((t("upr_bulk_done") || "Задано: ") + keys.length, "ok");
}

// ---------- перенос/копирование элементов между зонами ----------
function uprPickKey(num, vi, cat, name) {
  return num + "|" + vi + "|" + cat + "|" + name;
}

function uprTogglePick(meta, name) {
  const k = uprPickKey(meta.num, meta.vi, meta.cat, name);
  if (state.uprising.pick.has(k)) state.uprising.pick.delete(k);
  else state.uprising.pick.add(k);
  // точечно, без renderUprising (см. выше про dblclick)
  const on = state.uprising.pick.has(k);
  document.querySelectorAll(`.upr-chip[data-key="${CSS.escape(k)}"]`)
    .forEach(c => { c.classList.toggle("picked", on); uprChipStatePaint(c); });
}

// клик по любому месту мимо чипа снимает выделение (жёлтая рамка)
function setupUprDeselect() {
  if (setupUprDeselect.done) return;
  setupUprDeselect.done = true;
  document.addEventListener("mousedown", e => {
    if (state.activeTabId !== "uprising" || !state.uprising.pick.size) return;
    if (e.ctrlKey || e.metaKey) return; // мультивыделение правит само себя
    const t = e.target;
    if (t && t.closest && (t.closest(".upr-chip") || t.closest(".upr-edit-pop") ||
        t.closest(".swt-ac-panel") || t.closest(".ctx-menu"))) return;
    state.uprising.pick.clear();
    document.querySelectorAll(".upr-chip.picked")
      .forEach(c => { c.classList.remove("picked"); uprChipStatePaint(c); });
  }, true);
}

// ---------- модалка правки элемента поверх карточки ----------
// двойной клик / F2 / ПКМ → «Редактировать»: имя, количество, сложность,
// удаление. Больше самой иконки, чтобы всё поместилось.
let uprEditPopEl = null;
let uprEditPopCloser = null;

function uprCloseEditPop() {
  if (uprEditPopEl) { uprEditPopEl.remove(); uprEditPopEl = null; }
  uprEditPopCloser = null;
  // окно с кнопки add закрыто — снять подсветку _h (обе карты)
  try {
    document.querySelectorAll(".upr-chip-add.open").forEach(a => uprAddOpen(a, false));
  } catch (e) {}
}

// добавление: та же модалка, что редактирование (все 3 параметра сразу),
// якорь — кнопка "+" своего раздела; пустой элемент чистится сам
function uprAddNew(meta, items, onChange, anchorEl) {
  if (!state.uprising.sysnames.length) uprLoadSysnames();
  const tmp = { name: "", n: 1 };
  items.push(tmp);
  uprEditPop(anchorEl, meta, items, items.length - 1, () => {
    if (!tmp.name.trim()) {
      const k = items.indexOf(tmp);
      if (k !== -1) items.splice(k, 1);
    }
    onChange();
  }, true);
  // окно правки открыто с кнопки add — подсветка _h до закрытия
  uprAddOpen(anchorEl, true);
}

function uprEditPop(chipEl, meta, items, i, onChange, isNew) {
  uprCloseEditPop();
  const it = items[i];
  if (!it) return;
  // F2/ПКМ передают свежую копию списка без колбэка — по умолчанию пишем
  // правки обратно в ячейку той же сериализацией, что редактор чипов
  if (typeof onChange !== "function") {
    onChange = () => {
      const g = uprGroups().find(x => x.num === meta.num);
      const rw = g && g.list[Math.min(meta.vi, g.list.length - 1)];
      const ci = uprCatCol(meta.cat);
      if (!rw || ci === -1) return;
      const val = uprJoinList(items.filter(x => x.name));
      uprWriteCells([{ ri: rw.ri, ci, val }]);
    };
  }
  if (!state.uprising.sysnames.length) uprLoadSysnames();
  const oldKey = uprPickKey(meta.num, meta.vi, meta.cat, it.name);
  const pop = document.createElement("div");
  pop.className = "upr-edit-pop";
  // строка: полное название + серое описание слева, мини-поле справа
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
  // sysname
  const rowS = mkRow(t("upr_f_sysname") || "Системное имя",
    (t("upr_f_from") || "sysname из ") + (meta.cat || "") + ".xml");
  const nm = document.createElement("input");
  nm.type = "text";
  nm.className = "upr-chip-name";
  nm.value = it.name || "";
  nm.spellcheck = false;
  nm.placeholder = t("upr_add_ph") || "sysname";
  swtAutocomplete(nm, () => uprSysnamesFor(meta.cat), v => { nm.value = v; }, { openOnFocus: false });
  rowS.appendChild(nm);
  // количество
  const rowN = mkRow(t("upr_f_count") || "Количество",
    t("upr_f_count_d") || "сколько единиц, минимум 1");
  const cnt = document.createElement("input");
  cnt.type = "number";
  cnt.min = "1";
  cnt.className = "mini";
  cnt.value = it.n;
  rowN.appendChild(cnt);
  // сложность (пусто = унаследована от зоны)
  const rowD = mkRow(t("upr_f_diff") || "Сложность",
    t("upr_f_diff_d") || "1-6 или 3-5, пусто = сложность зоны");
  const dinp = document.createElement("input");
  dinp.type = "text";
  dinp.className = "upr-chip-diff-inp mini";
  dinp.value = uprUdiffs()[oldKey] || "";
  dinp.placeholder = "1-6";
  dinp.spellcheck = false;
  rowD.appendChild(dinp);
  // cost — запись в cost species-файла (шильдик обновится сам); у юнитов
  // ещё cp_cost. Зеркало кампании (cmpEditPop): те же колонки, тот же API
  const rowP = mkRow(t("cpg_cost") || "Cost",
    t("cpg_cost_d") || "запись в cost species-файла");
  const prc = document.createElement("input");
  prc.type = "text";
  prc.className = "mini";
  prc.spellcheck = false;
  prc.value = uprPrice(meta.cat, it.name);
  rowP.appendChild(prc);
  let cpInp = null;
  if (["squads", "tanks", "cars", "helicopters"].indexOf(meta.cat) !== -1) {
    const rowC = mkRow(t("cpg_cp_cost") || "CP-стоимость",
      t("cpg_cp_cost_d") || "запись в cp_cost");
    cpInp = document.createElement("input");
    cpInp.type = "text";
    cpInp.className = "mini";
    cpInp.spellcheck = false;
    cpInp.value = uprStat(meta.cat, it.name, "cp_cost");
    rowC.appendChild(cpInp);
  }
  // класс техники (unit_set) — то же комбо, что в таблице cars/tanks;
  // только запись пула доступности, без переносов между секциями.
  // Squads/heli уникальны — им поле не нужно, только cars/tanks.
  let setInp = null;
  if (["cars", "tanks"].indexOf(meta.cat) !== -1) {
    const rowU = mkRow(t("upr_f_unitset") || "Класс",
      t("upr_f_unitset_d") || "запись в unit_set species-файла");
    const setHold = document.createElement("div");
    setHold.className = "upr-edit-set";
    setInp = document.createElement("input");
    setInp.type = "text";
    setInp.spellcheck = false;
    setInp.placeholder = "unit_set";
    setInp.value = uprStat(meta.cat, it.name, "unit_set");
    if (typeof makeUnitSetCombo === "function" &&
        typeof unitSetChoices === "function")
      makeUnitSetCombo(setHold, setInp, unitSetChoices([setInp.value]), "unit_set");
    else setHold.appendChild(setInp);
    rowU.appendChild(setHold);
  }
  // цена скрыта везде (uprPrice/uprising_prices остаются в коде на будущее)
  // кнопки
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
      // новый элемент без сохранения — убрать временный, как будто его не было
      items.splice(i, 1);
      try { onChange(); } catch (e) { /* noop */ }
    } else if (save) {
      const name = nm.value.trim();
      const v = dinp.value.trim().replace(/\s+/g, "");
      if (v && !/^[1-6]$/.test(v) && !/^[1-6]-[1-6]$/.test(v)) {
        toast(t("upr_diff_bad") || "Формат сложности: 4 или 3-5", "err");
        return;   // без closed: поповер жив, можно исправить и сохранить
      }
      if (v && v !== (uprUdiffs()[oldKey] || "") && !(await uprDiffGuard())) return;
      if (!name) {
        items.splice(i, 1);           // пустое имя = удалить
      } else {
        it.name = name;
        it.n = Math.max(1, parseInt(cnt.value, 10) || 1);
        const newKey = uprPickKey(meta.num, meta.vi, meta.cat, name);
        // сложность переезжает за юнитом при переименовании
        if (v !== (uprUdiffs()[oldKey] || "")) uprSetUdiff(oldKey, v);
        if (newKey !== oldKey && uprUdiffs()[oldKey] !== undefined) {
          uprSetUdiff(newKey, uprUdiffs()[oldKey]);
          uprSetUdiff(oldKey, "");
        }
        // статы species — только изменившееся и непустое, как у кампании
        const diff = {};
        const put = (col, el) => {
          if (!el) return;
          const sv = el.value.trim();
          if (sv !== "" && sv !== uprStat(meta.cat, name, col)) diff[col] = sv;
        };
        put("cost", prc);
        put("cp_cost", cpInp);
        put("unit_set", setInp);
        if (Object.keys(diff).length) await uprWriteStats(meta.cat, name, diff);
        state.uprising.pick.delete(oldKey);
        state.uprising.pick.add(newKey);
      }
      onChange();
    }
    closed = true;
    document.removeEventListener("mousedown", outside, true);
    uprCloseEditPop();
    renderUprising();
  };
  const outside = e => {
    // выпадашка автокомплита живёт в body вне поповера — клик по ней не «мимо»
    if (e.target.closest && (e.target.closest(".swt-ac-panel") ||
        e.target.closest(".unit-combo-pop"))) return;
    if (uprEditPopEl && !uprEditPopEl.contains(e.target)) commit(false);
  };
  delB.onclick = e => {
    e.stopPropagation();
    if (isNew) { commit(false); renderUprising(); return; }
    commit(false); items.splice(i, 1); onChange(); renderUprising();
  };
  canB.onclick = e => { e.stopPropagation(); commit(false); };
  okB.onclick = e => { e.stopPropagation(); commit(true); };
  advB.onclick = e => {
    e.stopPropagation();
    const name = (nm.value || "").trim() || (it.name || "");
    if (typeof uprEditPopCloser === "function") {
      try { uprEditPopCloser(); } catch (err) { /* попап уже закрыт */ }
    }
    if (name && typeof untOpenUnit === "function") untOpenUnit(meta.cat, name);
    else if (typeof openUnits === "function") openUnits();
  };
  [nm, cnt, dinp, prc, cpInp, setInp].forEach(el => {
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
  uprEditPopEl = pop;                 // без этого поповер никогда не закрывался
  uprEditPopCloser = () => commit(false);
  // позиция: поверх карточки, но не внутри неё; не вылезает за экран
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const r = chipEl && chipEl.getBoundingClientRect
    ? chipEl.getBoundingClientRect()
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

// правка по ключу выделения (F2): найти карточку и открыть модалку
function uprEditByKey(k) {
  const parts = k.split("|");
  const num = parseInt(parts[0], 10), vi = parseInt(parts[1], 10);
  const cat = parts[2], name = parts.slice(3).join("|");
  const chip = document.querySelector(`.upr-chip[data-key="${CSS.escape(k)}"]`);
  const g = uprGroups().find(x => x.num === num);
  const rw = g && g.list[Math.min(vi, g.list.length - 1)];
  const ci = uprCatCol(cat);
  if (!rw || ci === -1) return;
  const items = uprParseList(state.uprising.rows[rw.ri].values[ci] || "");
  const i = items.findIndex(x => x.name === name);
  if (i === -1) return;
  uprEditPop(chip, { num, vi, cat }, items, i);
}

function uprStartEdit(meta, name, chipEl) {
  const key = uprPickKey(meta.num, meta.vi, meta.cat, name);
  const chip = chipEl || document.querySelector(`.upr-chip[data-key="${CSS.escape(key)}"]`);
  const items = uprEditItems(meta);
  const i = items.findIndex(x => x.name === name);
  if (i === -1) return;
  uprEditPop(chip, meta, items, i);
}

// свежий список элементов категории зоны (по фактическим данным таблицы)
function uprEditItems(meta) {
  const g = uprGroups().find(x => x.num === meta.num);
  const rw = g && g.list[Math.min(meta.vi, g.list.length - 1)];
  const ci = uprCatCol(meta.cat);
  if (!rw || ci === -1) return [];
  return uprParseList(state.uprising.rows[rw.ri].values[ci] || "");
}

// все выделенные (ctrl+клик) элементы по фактическим данным таблицы
function uprCollectPicked() {
  const out = [];
  uprGroups().forEach(g => g.list.forEach((rw, vi) => {
    UPRISING_CATS.forEach(cat => {
      const ci = uprCatCol(cat);
      if (ci === -1) return;
      uprParseList(state.uprising.rows[rw.ri].values[ci] || "").forEach(it => {
        if (it.name && state.uprising.pick.has(uprPickKey(g.num, vi, cat, it.name)))
          out.push({ num: g.num, vi, cat, name: it.name, n: it.n });
      });
    });
  }));
  return out;
}

function uprWriteCell(ri, ci, items) {
  uprWriteCells([{ ri, ci, items }]);
}

// батч-запись ячеек карты ОДНИМ запросом: вся команда (вставка/перенос/
// очистка сектора) — одна запись истории и один undo-шаг. Раньше каждая
// ячейка шла отдельным /api/edit: отмена шла по одному юниту + параллельные
// правки одного файла гонялись между собой.
// summary — готовая подпись команды для журнала («Обмен секторов 3 ↔ 7»);
// без неё бэкенд соберёт подпись сам. Возвращает true при успехе.
async function uprWriteCells(edits, summary) {
  const cells = [];
  const stash = [];
  (edits || []).forEach(e => {
    if (!e || !state.uprising.rows[e.ri]) return;
    // e.items (список) или готовый e.val (уже сериализованная строка)
    const val = (e.val !== undefined) ? e.val
      : uprJoinList(((e.items) || []).filter(x => x.name));
    const old = state.uprising.rows[e.ri].values[e.ci];
    if (old === val) return;
    // оптимистично — для мгновенного рендера; при отказе сервера
    // откатим по stash (иначе карта покажет ×3, а в файле останется
    // старое, и повторная правка молча пропустится как «без изменений»)
    stash.push({ ri: e.ri, ci: e.ci, old });
    state.uprising.rows[e.ri].values[e.ci] = val;
    cells.push({ row: e.ri, col: e.ci, value: val, type: "String" });
  });
  uprMarkDirty();
  if (!cells.length) return true;
  let j = null;
  try {
    const body = { path: state.uprising.path, cells, save: false };
    if (summary) body.summary = String(summary).slice(0, 160);
    const r = await api("/api/edit_cells", { method: "POST",
      body: JSON.stringify(body) });
    try { j = await r.json(); } catch (e) { j = null; }
  } catch (e) { j = null; }
  if (!j || !j.ok) {
    stash.forEach(s => {
      if (state.uprising.rows[s.ri]) state.uprising.rows[s.ri].values[s.ci] = s.old;
    });
    renderUprising();
    toast((j && j.error) || "map write failed", "err");
    return false;
  }
  state.uprising.redoHint = "";
  try { await uprSyncUndoButtons(); } catch (e) {}
  // открытые вкладки-таблицы того же файла: подменить значения, иначе
  // таблица покажет старое до переоткрытия
  try { uprSyncFileTabs(cells); } catch (e) { /* таблица обновится при открытии */ }
  return true;
}

// значения карты — в открытые таблицы того же файла (cells как в запросе):
// общий хелпер подменяет ячейки, красит дискету и помечает неактивные
// вкладки stale (перерисуются при возврате — см. activateTab)
function uprSyncFileTabs(cells) {
  try { return syncFileTabsCells(state.uprising.path || "", cells, state.uprising.sheetIndex || 0); }
  catch (e) { return false; }
}

function uprRemoveItems(list) {
  const byCell = new Map();
  list.forEach(it => {
    const k = it.num + "|" + it.vi + "|" + it.cat;
    if (!byCell.has(k)) byCell.set(k, new Set());
    byCell.get(k).add(it.name);
  });
  const edits = [];
  uprGroups().forEach(g => g.list.forEach((rw, vi) => {
    UPRISING_CATS.forEach(cat => {
      const m = byCell.get(g.num + "|" + vi + "|" + cat);
      const ci = m ? uprCatCol(cat) : -1;
      if (ci === -1) return;
      edits.push({ ri: rw.ri, ci,
        items: uprParseList(state.uprising.rows[rw.ri].values[ci] || "")
          .filter(x => !m.has(x.name)) });
    });
  }));
  uprWriteCells(edits, (t("upr_h_remove") || "Удаление с карты ({k} шт.)")
    .replace("{k}", list.length));
}

// перенос элементов в зону targetNum; дубликаты пропускаются (не ошибка)
function uprMoveItems(list, targetNum) {
  const groups = uprGroups();
  const tgt = groups.find(g => g.num === targetNum);
  if (!tgt || !tgt.list.length) return;
  const moved = [], skipped = [];
  // кэш разобранных ячеек: несколько переносимых стеков могут делить одну
  // ячейку источника/цели — читаем её один раз, иначе повторный разбор
  // брал бы исходное значение и затирал предыдущий перенос тем же батчем
  const cache = new Map();
  const cellItems = (ri, ci) => {
    const k = ri + "|" + ci;
    if (!cache.has(k))
      cache.set(k, uprParseList(state.uprising.rows[ri].values[ci] || ""));
    return cache.get(k);
  };
  (list || []).forEach(it => {
    if (!it.name) return;
    const ci = uprCatCol(it.cat);
    if (ci === -1) return;
    const tr = tgt.list[Math.min(it.vi, tgt.list.length - 1)];
    const cur = cellItems(tr.ri, ci);
    if (cur.some(x => x.name === it.name)) { skipped.push(it); return; }
    cur.push({ name: it.name, n: it.n });
    // убрать из зоны-источника
    const src = groups.find(g => g.num === it.num);
    const sr = src && src.list[Math.min(it.vi, src.list.length - 1)];
    if (sr) {
      const scur = cellItems(sr.ri, ci);
      const si = scur.findIndex(x => x.name === it.name);
      if (si !== -1) scur.splice(si, 1);
    }
    moved.push(it);
  });
  const edits = [];
  cache.forEach((items, k) => {
    const p = k.split("|");
    edits.push({ ri: +p[0], ci: +p[1], items });
  });
  uprWriteCells(edits, (t("upr_h_move") || "Перенос в сектор {n} ({k} шт.)")
    .replace("{n}", targetNum).replace("{k}", moved.length));
  if (moved.length) {
    toast((t("upr_moved") || "Перенесено в зону {n}: {k}")
      .replace("{n}", targetNum).replace("{k}", moved.length), "ok");
  }
  if (skipped.length === 1) {
    toast((t("upr_drop_dup") || "«{name}» уже есть в зоне {n} — пропущен")
      .replace("{name}", skipped[0].name).replace("{n}", targetNum), "");
  } else if (skipped.length > 1) {
    toast((t("upr_drop_dups") || "Пропущено {k}: уже есть в зоне {n}")
      .replace("{k}", skipped.length).replace("{n}", targetNum), "");
  }
}

function uprPasteItems(meta, items, idx) {
  // вставка строго по своим категориям: cars→cars, tanks→tanks и т.д.
  // (перенос мышью так уже делает через it.cat в uprMoveItems).
  // Кликнутая категория игнорируется: каждый элемент ложится в столбец
  // своей категории того же сектора и ряда.
  const clip = state.uprising.clip || [];
  const g = uprGroups().find(x => x.num === meta.num);
  if (!g || !g.list.length) return;
  const rw = g.list[Math.min(meta.vi, g.list.length - 1)];
  const byCat = new Map();
  clip.forEach(c => {
    if (!c.name || uprCatCol(c.cat) === -1) return;
    if (!byCat.has(c.cat)) byCat.set(c.cat, []);
    byCat.get(c.cat).push(c);
  });
  const edits = [];
  const skipped = [];
  byCat.forEach((list, cat) => {
    const ci = uprCatCol(cat);
    const cur = uprParseList(state.uprising.rows[rw.ri].values[ci] || "");
    list.forEach(c => {
      if (cur.some(x => x.name === c.name)) { skipped.push(c); return; }
      cur.push({ name: c.name, n: c.n });
    });
    edits.push({ ri: rw.ri, ci, items: cur });
  });
  if (edits.length) {
    uprWriteCells(edits, (t("upr_h_paste") || "Вставка в сектор {n}")
      .replace("{n}", meta.num));
  }
  if (skipped.length === 1) {
    toast((t("upr_drop_dup") || "«{name}» уже есть в зоне {n} — пропущен")
      .replace("{name}", skipped[0].name).replace("{n}", meta.num), "");
  } else if (skipped.length > 1) {
    toast((t("upr_drop_dups") || "Пропущено {k}: уже есть в зоне {n}")
      .replace("{k}", skipped.length).replace("{n}", meta.num), "");
  }
  renderUprising();
}

// ---------- контекстное меню сектора карты ----------
// снимок наполнения сектора: ячейки + сложности юнитов (ключи num|vi|cat|name)
function uprSectorCells(num) {
  const g = uprGroups().find(x => x.num === num);
  if (!g) return [];
  const out = [];
  g.list.forEach((rw, vi) => {
    UPRISING_CATS.forEach(cat => {
      const ci = uprCatCol(cat);
      if (ci === -1) return;
      out.push({ vi, cat, ci, ri: rw.ri,
        items: uprParseList(state.uprising.rows[rw.ri].values[ci] || "") });
    });
  });
  return out;
}

function uprSectorSnap(num) {
  const diffs = uprUdiffs();
  return uprSectorCells(num).map(c => ({
    vi: c.vi, cat: c.cat,
    items: c.items.map(x => ({ name: x.name, n: x.n,
      diff: diffs[uprPickKey(num, c.vi, c.cat, x.name)] || "" })),
  }));
}

// собрать одну правку ячейки сектора + перепривязать сложности.
// Возвращает {ri, ci, items} (без записи); запись — батчем через uprWriteCells,
// чтобы вся команда была одним шагом отмены
function uprSectorEdit(num, vi, cat, items) {
  const g = uprGroups().find(x => x.num === num);
  const rw = g && g.list[vi];
  const ci = uprCatCol(cat);
  if (!rw || ci === -1) return null;
  uprParseList(state.uprising.rows[rw.ri].values[ci] || "")
    .forEach(x => uprSetUdiff(uprPickKey(num, vi, cat, x.name), ""));
  (items || []).forEach(x => {
    if (x.name && x.diff) uprSetUdiff(uprPickKey(num, vi, cat, x.name), x.diff);
  });
  return { ri: rw.ri, ci, items };
}

// записать одну ячейку сектора + перепривязать сложности
function uprSectorPut(num, vi, cat, items) {
  const e = uprSectorEdit(num, vi, cat, items);
  if (e) uprWriteCells([e]);
}

function uprSectorWrite(num, snap, summary) {
  const edits = (snap || [])
    .map(s => uprSectorEdit(num, s.vi, s.cat, s.items))
    .filter(e => e);
  uprWriteCells(edits, summary);
  renderUprising();
}

function uprSectorCtx(e, num) {
  e.preventDefault();
  e.stopPropagation();
  const hasClip = !!((state.uprising.sectorClip || []).length);
  openCtxMenu(e, [
    { label: t("upr_sec_swap") || "Заменить на…", icon: "swap", fn: async () => {
        const nums = (window.UPR_MAP_SECTORS || []).map(s => s.num);
        const v = await askPrompt({
          title: (t("upr_sec_swap_t") || "Заменить сектор {n}: наполнение сектора №").replace("{n}", num),
          value: "", placeholder: nums.filter(n => n !== num).join(", "),
          okLabel: t("upr_sec_swap_ok") || "Поменять",
        });
        if (v === null) return;
        const other = parseInt(String(v).trim(), 10);
        if (!nums.includes(other) || other === num) {
          toast(t("upr_sec_bad") || "Нет такого сектора", "err");
          return;
        }
        const sa = uprSectorSnap(num), sb = uprSectorSnap(other);
        // обмен — одна команда: обе стороны одним батчем = одна запись
        // истории и один undo-шаг
        const edits = [
          ...sb.map(s => uprSectorEdit(num, s.vi, s.cat, s.items)),
          ...sa.map(s => uprSectorEdit(other, s.vi, s.cat, s.items)),
        ].filter(e => e);
        await uprWriteCells(edits, (t("upr_h_swap") || "Обмен секторов {a} ↔ {b}")
          .replace("{a}", num).replace("{b}", other));
        renderUprising();
        toast((t("upr_sec_swapped") || "Секторы {a} и {b} поменялись наполнением")
          .replace("{a}", num).replace("{b}", other), "ok");
      } },
    { label: t("upr_sec_copy") || "Скопировать всё", icon: "copy", fn: () => {
        state.uprising.sectorClip = uprSectorSnap(num);
        toast(t("ctx_copied") || "Скопировано", "ok");
      } },
    { label: t("upr_sec_paste_rep") || "Вставить и заменить", icon: "paste", disabled: !hasClip, fn: () => {
        uprSectorWrite(num, state.uprising.sectorClip,
          (t("upr_h_paste") || "Вставка в сектор {n} (замена)").replace("{n}", num));
        toast(t("saved") || "Сохранено", "ok");
      } },
    { label: t("upr_sec_paste_add") || "Вставить и добавить", icon: "paste", disabled: !hasClip, fn: () => {
        const cur = uprSectorCells(num);
        const edits = [];
        (state.uprising.sectorClip || []).forEach(s => {
          const c = cur.find(x => x.vi === s.vi && x.cat === s.cat);
          const merged = (c ? c.items : []).map(x => ({ name: x.name, n: x.n, diff: "" }));
          // сложности текущих — сохранить при слиянии
          const diffs = uprUdiffs();
          merged.forEach(m => { m.diff = diffs[uprPickKey(num, s.vi, s.cat, m.name)] || ""; });
          (s.items || []).forEach(x => {
            if (!x.name) return;
            const f = merged.find(m => m.name === x.name);
            if (f) {
              f.n = Math.max(1, (f.n || 1) + (x.n || 1));
              if (x.diff) f.diff = x.diff;
            } else merged.push({ name: x.name, n: x.n || 1, diff: x.diff || "" });
          });
          const e = uprSectorEdit(num, s.vi, s.cat, merged);
          if (e) edits.push(e);
        });
        uprWriteCells(edits, (t("upr_h_paste_add") || "Вставка в сектор {n} (добавление)")
          .replace("{n}", num));
        renderUprising();
        toast(t("saved") || "Сохранено", "ok");
      } },
    { sep: true },
    { label: t("upr_sec_clear") || "Очистить сектор", icon: "delete", danger: true, fn: async () => {
        const c = await askConfirm({
          title: (t("upr_sec_clear_t") || "Очистить сектор {n}?").replace("{n}", num),
          message: t("upr_sec_clear_m") || "Всё наполнение сектора будет удалено.",
          buttons: [
            { id: "ok", label: t("delete") || "Удалить", kind: "danger" },
            { id: "cancel", label: t("cancel"), kind: "ghost" },
          ],
        });
        if (c !== "ok") return;
        uprWriteCells(uprSectorCells(num)
          .map(cl => uprSectorEdit(num, cl.vi, cl.cat, []))
          .filter(e => e),
          (t("upr_h_clear") || "Очистка сектора {n}").replace("{n}", num));
        renderUprising();
      } },
  ]);
}

function uprChipCtx(e, meta, items, idx) {
  e.preventDefault();
  e.stopPropagation();
  const chipEl = e.currentTarget;
  const it = items[idx];
  const hasIt = !!(it && it.name);
  const key = hasIt ? uprPickKey(meta.num, meta.vi, meta.cat, it.name) : "";
  const multi = hasIt && state.uprising.pick.size > 1 && state.uprising.pick.has(key);
  const grab = () => multi ? uprCollectPicked()
    : [{ num: meta.num, vi: meta.vi, cat: meta.cat, name: it.name, n: it.n }];
  openCtxMenu(e, [
    { label: t("upr_add") || "Добавить", icon: "add", fn: () => {
        const g = uprGroups().find(x => x.num === meta.num);
        const rw = g && g.list[Math.min(meta.vi, g.list.length - 1)];
        const ci = uprCatCol(meta.cat);
        if (!rw || ci === -1) return;
        uprAddNew(meta, items, () => {
          uprWriteCell(rw.ri, ci, items.filter(x => x.name));
        }, chipEl);
      } },
    { label: t("upr_edit") || "Редактировать", icon: "edit", disabled: !hasIt, fn: () => uprStartEdit(meta, it.name, chipEl) },
    { label: t("ctx_copy") || "Копировать", icon: "copy", disabled: !hasIt, fn: () => {
        state.uprising.clip = grab().map(x => ({ name: x.name, n: x.n, cat: x.cat }));
        toast(t("ctx_copied") || "Скопировано", "ok");
      } },
    { label: t("ctx_cut") || "Вырезать", icon: "cut", disabled: !hasIt, fn: () => {
        const grabbed = grab();
        state.uprising.clip = grabbed.map(x => ({ name: x.name, n: x.n, cat: x.cat }));
        uprRemoveItems(grabbed);
        renderUprising();
      } },
    { sep: true },
    { label: t("delete") || "Удалить", icon: "delete", danger: true, disabled: !hasIt, fn: () => {
        uprRemoveItems(grab());
        renderUprising();
      } },
    { label: t("ctx_paste") || "Вставить", icon: "paste", disabled: !(state.uprising.clip || []).length,
      fn: () => uprPasteItems(meta, items, idx) },
    { sep: true },
    { label: t("upr_open_grid") || "Открыть в таблице", icon: "grid", disabled: !hasIt,
      fn: () => uprOpenInGrid(meta.cat, it.name) },
  ]);
}

// «Открыть в таблице» с карты: species-файл категории (бэкенд находит файл
// с нужным sysname), вкладка переиспользуется, строка подсвечивается
async function uprOpenInGrid(cat, name) {
  if (!name) return;
  try {
    const r = await api("/api/uprising_species_file", { method: "POST",
      body: JSON.stringify({ root: uprSrcRoot(), cat, name }) });
    const j = await r.json();
    if (!j.ok || !j.path) { toast(t("drop_no_match") + name || name, "err"); return; }
    await openFile(j.path);
    const rows = (state.currentFile && state.currentFile.rows) || [];
    const ri = rows.findIndex(row => String((row.values || [])[0] || "") === name);
    if (ri >= 0) focusLinkedRow(ri);
    else toast((t("drop_no_match") || "Не найдено: ") + name, "err");
  } catch (e) { toast(String((e && e.message) || e), "err"); }
}

// ---------- drag & drop чипов на карту ----------
let uprDrag = null;
let uprHintZone = null;

function uprSetHint(zone) {
  if (uprHintZone === zone) return;
  if (uprHintZone) uprHintZone.classList.remove("drop-hint");
  uprHintZone = zone;
  if (zone) zone.classList.add("drop-hint");
}

function uprDragStart(e, meta, items, idx, chipEl) {
  closeCtxMenu();
  const it = items[idx];
  if (!it || !it.name) return;
  const key = uprPickKey(meta.num, meta.vi, meta.cat, it.name);
  const multi = state.uprising.pick.size > 1 && state.uprising.pick.has(key);
  const list = multi ? uprCollectPicked()
    : [{ num: meta.num, vi: meta.vi, cat: meta.cat, name: it.name, n: it.n }];
  if (!list.length) return;
  uprDrag = { list, chipEl, meta, name: it.name, started: false, sx: e.clientX, sy: e.clientY,
              ctrl: !!(e.ctrlKey || e.metaKey),
              ghost: null, label: null, offX: 0, offY: 0, w: 0, h: 0, over: 0 };
  window.addEventListener("mousemove", uprDragMove, true);
  window.addEventListener("mouseup", uprDragEnd, true);
}

function uprDragMove(e) {
  const d = uprDrag;
  if (!d) return;
  if (!d.started) {
    if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 5) return;
    d.started = true;
    const r = d.chipEl.getBoundingClientRect();
    d.offX = d.sx - r.left;
    d.offY = d.sy - r.top;
    d.w = r.width;
    d.h = r.height;
    // набор из 2+ — призрак из всех иконок (общий mkDragGhost),
    // одиночка — клон чипа как раньше
    let g;
    if (d.list.length > 1) {
      const extra = [];
      document.querySelectorAll("#uprising-tab .upr-chip.picked")
        .forEach(c => { if (c !== d.chipEl) extra.push(c); });
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
  const zone = el && el.closest ? el.closest(".upr-zone") : null;
  const num = zone ? +zone.dataset.num : 0;
  const ok = !!(zone && num && num !== d.meta.num);
  uprSetHint(ok ? zone : null);
  d.over = ok ? num : 0;
  if (ok) {
    d.label.textContent = (t("upr_drop_to") || "Перенести в зону {n}").replace("{n}", num)
      + (d.list.length > 1 ? " ×" + d.list.length : "");
    d.label.hidden = false;
    d.label.style.left = (e.clientX + 14) + "px";
    d.label.style.top = (e.clientY + 16) + "px";
  } else {
    d.label.hidden = true;
  }
}

function uprDragEnd(e) {
  const d = uprDrag;
  uprDrag = null;
  window.removeEventListener("mousemove", uprDragMove, true);
  window.removeEventListener("mouseup", uprDragEnd, true);
  if (!d) return;
  if (!d.started) {
    // простое нажатие без движения — выделение: ЛКМ только один элемент,
    // Ctrl+ЛКМ добавляет/снимает в мультивыделении.
    // Классы правим точечно, без renderUprising: перестройка DOM убивала dblclick
    if (d.name) {
      const k = uprPickKey(d.meta.num, d.meta.vi, d.meta.cat, d.name);
      if (d.ctrl) {
        uprTogglePick(d.meta, d.name);
      } else {
        const only = state.uprising.pick.size === 1 && state.uprising.pick.has(k);
        state.uprising.pick.clear();
        document.querySelectorAll(".upr-chip.picked")
          .forEach(c => { c.classList.remove("picked"); uprChipStatePaint(c); });
        if (!only) {
          state.uprising.pick.add(k);
          if (d.chipEl && d.chipEl.isConnected) {
            d.chipEl.classList.add("picked");
            uprChipStatePaint(d.chipEl);
          }
        }
      }
    }
    return;
  }
  uprSetHint(null);
  document.body.classList.remove("upr-dragging");
  if (d.label) d.label.remove();
  const target = d.over;
  const zone = target ? document.querySelector(`.upr-zone[data-num="${target}"]`) : null;
  if (zone) {
    // бросок: приз летит к центру зоны
    const zr = zone.getBoundingClientRect();
    const gx = parseFloat(d.ghost.style.left) || 0;
    const gy = parseFloat(d.ghost.style.top) || 0;
    const tx = zr.left + zr.width / 2 - d.w / 2;
    const ty = zr.top + zr.height / 2 - d.h / 2;
    d.ghost.style.transition = "transform .28s cubic-bezier(.2,.8,.3,1), opacity .28s";
    requestAnimationFrame(() => {
      d.ghost.style.transform = `translate(${tx - gx}px, ${ty - gy}px) scale(.35)`;
      d.ghost.style.opacity = ".15";
    });
    setTimeout(() => {
      d.ghost.remove();
      d.chipEl.classList.remove("upr-chip-dragging");
      zone.classList.add("flash");
      setTimeout(() => zone.classList.remove("flash"), 750);
      uprMoveItems(d.list, target);
      state.uprising.pick.clear();
      renderUprising();
    }, 300);
  } else {
    // мимо зоны: приз тает, элемент остаётся на месте
    d.ghost.style.transition = "opacity .18s";
    d.ghost.style.opacity = "0";
    setTimeout(() => {
      d.ghost.remove();
      d.chipEl.classList.remove("upr-chip-dragging");
    }, 190);
  }
}

function renderUprSector() {
  const main = $("#upr-main");
  main.innerHTML = "";
  const modal = $("#upr-sector-modal");
  const groups = uprGroups();
  const g = groups.find(x => x.num === state.uprising.sel);
  if (!g) {
    const empty = document.createElement("div");
    empty.className = "swt-empty";
    empty.textContent = t("upr_pick") || "Выберите сектор";
    main.appendChild(empty);
    if (modal) modal.hidden = true;
    return;
  }
  if (!state.uprising.panel) {
    if (!UPR_MODAL_ENABLED) {
      // модалка по центру временно отключена: показываем боковую панель
      state.uprising.panel = true;
    } else {
      // боковая панель скрыта: тот же редактор в модалке (категории в ряд)
      const body = $("#upr-modal-body");
      body.innerHTML = "";
      uprFillSector(body, g, true);
      const mvi = Math.min(state.uprising.variant, g.list.length - 1);
      const msys = (g.list[mvi] || {}).sys || ("sector_" + g.num + "_reward");
      $("#upr-modal-title").innerHTML =
        `<span class="upr-title-shield">${uprShieldSvg(g.num, uprZoneColor(g.num, uprSectorFaction(g.num)).solid, 22)}</span> ` +
        escapeHtml((t("upr_sector_reward") || "Награда сектора {n}").replace("{n}", String(g.num)) + " · " + msys);
      if (modal) modal.hidden = false;
      return;
    }
  }
  if (modal) modal.hidden = true;
  uprFillSector(main, g, false);
}

function uprFillSector(root, g, horizontal) {
  const vi = Math.min(state.uprising.variant, g.list.length - 1);
  // переключатель вариантов награды (ally / 1 / 2)
  if (g.list.length > 1) {
    const tabs = document.createElement("div");
    tabs.className = "upr-variants";
    g.list.forEach((rw, v) => {
      const b = document.createElement("button");
      b.className = "upr-variant" + (v === state.uprising.variant ? " sel" : "");
      b.textContent = rw.variant ? (t("upr_variant_" + rw.variant) || rw.variant)
        : (t("upr_variant") || "Выдача");
      b.onclick = () => { state.uprising.variant = v; renderUprising(); };
      tabs.appendChild(b);
    });
    root.appendChild(tabs);
  }
  const rw = g.list[vi];
  const row = state.uprising.rows[rw.ri];
  if (!row) return;
  const head = document.createElement("div");
  head.className = "upr-sector-head";
  const hname = document.createElement("span");
  hname.className = "upr-sector-name";
  // «Награда сектора N» + серый sysname (вместо голого sector_N_reward)
  hname.innerHTML = "";
  const hnMain = document.createElement("span");
  hnMain.textContent = (t("upr_sector_reward") || "Награда сектора {n}")
    .replace("{n}", String(g.num));
  const hnSys = document.createElement("span");
  hnSys.className = "upr-sector-sys";
  hnSys.textContent = rw.sys;
  hnSys.title = rw.sys;
  hname.append(hnMain, hnSys);
  head.appendChild(hname);
  // сложность зоны — прямо на панели сектора
  const hsel = document.createElement("select");
  hsel.className = "upr-diff-sel";
  hsel.title = t("upr_zone_diff") || "Сложность зоны";
  UPR_DIFFS.forEach(d => {
    const o = document.createElement("option");
    o.value = d;
    o.textContent = uprDiffLabel(d);
    if (uprZoneDiff(g.num) === d) o.selected = true;
    hsel.appendChild(o);
  });
  hsel.onchange = () => { uprSetZdiff(g.num, hsel.value); renderUprising(); };
  head.appendChild(hsel);
  // переключатель вида иконок + переключатель локализации имён — в заголовке
  // панели, справа (флекс)
  try { head.appendChild(uprViewToggle()); } catch (e) {}
  try { if (typeof uprLocToggle === "function") head.appendChild(uprLocToggle()); } catch (e) {}
  root.appendChild(head);

  const catsRow = document.createElement("div");
  catsRow.className = "upr-cats-row" + (horizontal ? " horiz" : "");
  UPRISING_CATS.forEach(cat => {
    // один битый блок не гасит всю панель: падение видно тостом с причиной
    try {
      const ci = uprCatCol(cat);
      if (ci === -1) return;
      const sec = document.createElement("div");
      sec.className = "upr-cat";
      const title = document.createElement("div");
      title.className = "upr-cat-title";
      uprCatTitle(title, cat);
      sec.appendChild(title);
      const body = document.createElement("div");
      body.className = "upr-cat-body";
      body.dataset.cat = cat;
      const items = uprParseList(ci < row.values.length ? row.values[ci] : "");
      uprChipEditor(body, items, () => {
        // пустые чипы не пишем в файл
        const cleaned = items.filter(x => x.name);
        uprWriteCells([{ ri: rw.ri, ci, items: cleaned }]);
      }, { num: g.num, vi: vi, cat: cat });
      sec.appendChild(body);
      catsRow.appendChild(sec);
    } catch (err) {
      try {
        console.error("uprFillSector block failed:", g.num, cat, err);
        toast("Сектор " + g.num + " · " + cat + ": " +
          String((err && err.message) || err), "err");
      } catch (e) {}
    }
  });
  root.appendChild(catsRow);
}

async function uprSaveGuarded(popup) {
  if (!state.uprising.path) return;
  return guardedSave("uprising", state.uprising.path, async target => {
    if (target) {
      const j = await saveAsTo(state.uprising.path, "uprising", target);
      if (j.ok && j.saved) {
        uprMarkClean();
        uprCfgExport(true);
        toast((t("saved") || "Сохранено") + " → " + j.dst, "ok");
        // дальше правим копию: переключаем карту на неё
        if (j.dst && j.dst !== state.uprising.path) {
          // копия могла создать новый раздел древа (напр. dlc/) —
          // перечитываем, иначе файл карты без строки в древе
          await noteExternalTreeChange(target);
          state.uprising.path = j.dst;
          await uprLoad(true);
        }
      }
      else toast((j.error || "error"), "err");
      return;
    }
    await uprSave();
  }, popup);
}

async function uprSave() {
  if (!state.uprising.path) return;
  const r = await api("/api/save", { method: "POST",
    body: JSON.stringify({ path: state.uprising.path }) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "error", "err"); return; }
  uprMarkClean();
  // баланс-конфиг (.cfg) пишется только явно: «Сохранить»/Ctrl+S или
  // кнопка «Скачать конфигурацию» — сам по себе он не перезаписывается
  uprCfgExport(true);
  toast(t("saved") || "Сохранено", "ok");
}

function setupUprising() {
  setupUprDeselect();
  // применённый вид иконок slot/classic (класс на body переживает рендеры)
  uprViewApply();
  // щиты карты — одним запросом в память, фоном (к открытию карты уже в кэше)
  uprPreloadShields();
  // сохранение карты — кнопка шапки и Ctrl+S (saveActive → uprSaveGuarded)
  // без обёртки event клика попал бы в uprLoad как seq и убил бы рендер
  // (guard поколения сравнивает строго с числом)
  $("#upr-reload").onclick = () => {
    // усиленный Reload: сбрасываем кэши иконок/щитов в памяти, затем новое
    // поколение загрузки (текстура карты уже bust-ится через ?v=Date.now)
    uprIconMap = {};
    uprIconsReady = false;
    try {
      for (const k of Object.keys(uprShieldCache)) delete uprShieldCache[k];
    } catch (e) { /* noop */ }
    uprLoad().then(() => { uprReloadImages(); uprPreloadShields(); }).catch(() => {});
  };
  $("#upr-open-grid").onclick = () => { if (state.uprising.path) openFile(state.uprising.path); };
  // рандомайзер — отдельная страница (кнопка в шапке слева от Проект|Игра|Мод)
  $("#upr-open-rnd").onclick = () => openUprisingRnd();
  $("#upr-analyze").onclick = () => uprAnalyze();
  $("#upr-fs").onclick = () => paneFsToggle($("#upr-wrap").closest(".swt-page"));
  $("#upr-panel-toggle").onclick = () => uprSetPanel(!state.uprising.panel);
  const uprSeg = $("#upr-src");
  if (uprSeg) uprSeg.addEventListener("click", e => {
    const b = e.target.closest(".src-seg-btn");
    if (!b) return;
    if (b.classList.contains("is-off")) {
      // путь не задан: серая кнопка открывает настройки на вкладке путей
      // с пульсирующей подсветкой нужной строки
      openSettingsPaths(b.dataset.src === "mod" ? "set-mod-path"
        : b.dataset.src === "game" ? "set-unpacked" : undefined);
      return;
    }
    uprSwitchSrc(b.dataset.src);
  });
  // раздвижная боковая панель сектора: тянуть левый край
  const rz = $("#upr-resizer");
  if (rz) rz.addEventListener("mousedown", e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const main = $("#upr-main");
    document.body.classList.add("upr-resizing");
    const move = ev => {
      const w = Math.min(900, Math.max(280, window.innerWidth - ev.clientX - 14));
      main.style.flex = "0 0 " + w + "px";
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("upr-resizing");
      localStorage.setItem("tsh_upr_panel_w",
        String(Math.round(main.getBoundingClientRect().width)));
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  // F2 — редактировать выделенный элемент (модалка поверх карточки)
  document.addEventListener("keydown", e => {
    if (state.activeTabId !== "uprising" || e.key !== "F2") return;
    const pick = state.uprising.pick;
    if (!pick.size) return;
    e.preventDefault();
    const k = [...pick][pick.size - 1];
    const parts = k.split("|");
    const num = parseInt(parts[0], 10), vi = parseInt(parts[1], 10);
    if (state.uprising.sel !== num || state.uprising.variant !== vi) {
      state.uprising.sel = num;
      state.uprising.variant = vi;
      renderUprising();
    }
    uprEditByKey(k);
  });
}

