// ---------- Рандомайзер Uprising ----------
// Отдельный файл (после app.js): кнопки-оверлей карты, широкая модалка,
// взвешенная рандомизация юнитов по секторам. Использует существующее:
// сложности зон (uprZoneDiff), сложности юнитов (uprUdiffs "4"|"3-5",
// пусто = наследование от зоны), .cfg снапшоты, uprSaveCell батчем.
(function () {
"use strict";

// base64-сид по умолчанию: timestamp
function uprRndDefOpts() {
  return {
    cats: { squads: true, tanks: true, cars: true, helicopters: true,
            inventory_items: true },
    k: 1.0,                       // Хаос(0) ↔ Баланс(2)
    weights: { squads: 1, tanks: 3, cars: 2, helicopters: 3,
               inventory_items: 0.2 },
    countHeads: true,             // нагрузка в головах (Count) или записях
    softTol: false,               // мягкий допуск ±1 с половинным весом
    factionMode: "own",           // own | mix
    freePlace: true,              // юнитам без фракции — свободное размещение
    noOrigin: false,              // не класть в исходный сектор
    noNeighbours: false,          // не класть в соседние по номеру (±1)
    cap: 0,                       // лимит голов на сектор (0 = без лимита)
    seed: (Date.now() % 1000000),
    orphan: "nearest",            // nearest | stay | skip
  };
}

function uprRndOpts() {
  let o = {};
  try { o = JSON.parse(localStorage.getItem("tsh_upr_rnd") || "{}") || {}; }
  catch (e) { o = {}; }
  // localStorage живёт один запуск (порт сервера случаен): персист — в конфиге
  if (!Object.keys(o).length && state.config && state.config.uprising_rnd_opts) {
    try { o = JSON.parse(JSON.stringify(state.config.uprising_rnd_opts)) || {}; }
    catch (e) { o = {}; }
  }
  const d = uprRndDefOpts();
  o.cats = Object.assign({}, d.cats, o.cats);
  o.weights = Object.assign({}, d.weights, o.weights);
  return Object.assign(d, o);
}
// запись в localStorage сразу + в конфиг с дебаунсом (ползунки не спамят)
let _uprRndSaveT = null;
function uprRndSaveOpts(o) {
  try { localStorage.setItem("tsh_upr_rnd", JSON.stringify(o)); } catch (e) {}
  try { if (state.config) state.config.uprising_rnd_opts = JSON.parse(JSON.stringify(o)); } catch (e) {}
  try {
    clearTimeout(_uprRndSaveT);
    _uprRndSaveT = setTimeout(() => {
      api("/api/config", { method: "POST",
        body: JSON.stringify({ uprising_rnd_opts: o }) }).catch(() => {});
    }, 400);
  } catch (e) {}
}

// мета юнитов с бэкенда: {factions: {sys: faction}, costs: {sys: cost}}
let _uprRndMeta = null;
async function uprRndMeta() {
  if (_uprRndMeta) return _uprRndMeta;
  _uprRndMeta = { factions: {}, costs: {} };
  try {
    const r = await api("/api/upr_unit_meta", { method: "POST",
      body: JSON.stringify({
        project_root: (state.project && state.project.root) || "",
        unpacked_path: state.config.unpacked_path || "",
      }) });
    const j = await r.json();
    if (j && j.ok) _uprRndMeta = { factions: j.factions || {}, costs: j.costs || {} };
  } catch (e) { /* без меты — текстовый ввод и wildcard-фракции */ }
  return _uprRndMeta;
}

// парсинг сложности юнита: "4" -> [4,4], "3-5" -> [3,5], "" -> null (наследование)
function uprRndParseDiff(s) {
  const m = String(s || "").trim().match(/^([1-6])(?:\s*-\s*([1-6]))?$/);
  if (!m) return null;
  let a = parseInt(m[1], 10), b = parseInt(m[2] || m[1], 10);
  if (a > b) { const tmp = a; a = b; b = tmp; }
  return [a, b];
}

// оверлей-кнопки карты: [🎲 Рандомайзер][⚙] в правом нижнем углу;
// высота обеих 34px (см. .upr-map-btn), скругление минимальное
window.uprRndOverlay = function (box) {
  // якорь — область карты (#upr-map, position: relative), а не бокс картинки:
  // кнопки стоят в углу области при любом размере текстуры
  const anchor = (box && box.closest && box.closest("#upr-map")) || box;
  if (!anchor || anchor.querySelector(":scope > .upr-map-actions")) return;
  const bar = document.createElement("div");
  bar.className = "upr-map-actions";
  const rnd = document.createElement("button");
  rnd.type = "button";
  rnd.className = "btn upr-map-btn rnd";
  rnd.textContent = "🎲 " + (t("upr_rnd_title") || "Рандомайзер");
  rnd.onclick = () => uprRndOpen();
  const gear = document.createElement("button");
  gear.type = "button";
  gear.className = "icon-btn upr-map-btn icon";
  gear.title = t("upr_colors") || "Цвета зон";
  // центрирование инлайном: переживает любой каскад и залежавшийся css в кэше
  gear.style.display = "flex";
  gear.style.alignItems = "center";
  gear.style.justifyContent = "center";
  gear.style.padding = "0";
  gear.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" style="display:block;margin:auto" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 ' +
    '0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 ' +
    '0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 ' +
    '1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 ' +
    '1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 ' +
    '2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 ' +
    '1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 ' +
    '1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 ' +
    '0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  gear.onclick = () => uprOpenColors();
  bar.append(rnd, gear);
  anchor.appendChild(bar);
  // ВРЕМЕННАЯ самодиагностика раскладки (убрать после починки): страница сама
  // меряет кнопки и докладывает в лог — видно, что реально отрендерилось
  try {
    requestAnimationFrame(() => {
      try {
        const rb = rnd.getBoundingClientRect();
        const gb = gear.getBoundingClientRect();
        const overlap = !(rb.right <= gb.left || gb.right <= rb.left ||
          rb.bottom <= gb.top || gb.bottom <= rb.top);
        const bars = document.querySelectorAll(".upr-map-actions").length;
        const info = "bars=" + bars +
          " rnd=" + Math.round(rb.width) + "x" + Math.round(rb.height) +
          "@" + Math.round(rb.left) + "," + Math.round(rb.top) +
          " gear=" + Math.round(gb.width) + "x" + Math.round(gb.height) +
          "@" + Math.round(gb.left) + "," + Math.round(gb.top) +
          " overlap=" + overlap +
          " rndCls=" + rnd.className + " gearCls=" + gear.className;
        if (typeof reportClientError === "function")
          reportClientError("rnd-diag", info, {});
      } catch (e) {}
    });
  } catch (e) {}
};

// ---------- модалка ----------
let _uprRndPlan = null;    // последний расчёт: {moves, report, seed}
let _uprRndSnap = null;    // снапшот для «Отмены»

function uprRndExcluded() {
  let m = {};
  try { m = JSON.parse(localStorage.getItem("tsh_upr_rnd_excl") || "{}") || {}; }
  catch (e) { m = {}; }
  if (!Object.keys(m).length && state.config && state.config.uprising_rnd_excl) {
    try { m = JSON.parse(JSON.stringify(state.config.uprising_rnd_excl)) || {}; }
    catch (e) { m = {}; }
  }
  return m;
}
function uprRndIsExcluded(num) {
  // блокировки выбирает пользователь; сектор 1 больше не зашит
  return !!uprRndExcluded()[num];
}
function uprRndSetExcluded(num, v) {
  const m = uprRndExcluded();
  if (v) m[num] = String(true); else delete m[num];
  try { localStorage.setItem("tsh_upr_rnd_excl", JSON.stringify(m)); } catch (e) {}
  try { if (state.config) state.config.uprising_rnd_excl = JSON.parse(JSON.stringify(m)); } catch (e) {}
  try {
    api("/api/config", { method: "POST",
      body: JSON.stringify({ uprising_rnd_excl: m }) }).catch(() => {});
  } catch (e) {}
}

// щит сектора как в «Цветах зон»; перерисовка при смене цвета на лету
function uprRndShield(num) {
  return `<span class="upr-shield-wrap">${uprShieldSvg(num, null, 22)}` +
    `<b class="upr-shield-num">${num}</b></span>`;
}
window.uprRndRefreshShields = function () {
  document.querySelectorAll("#upr-rnd-body .upr-rnd-sec-row").forEach(row => {
    const lab = row.querySelector("span");
    if (lab) lab.innerHTML = uprRndShield(+row.dataset.num);
  });
};

function uprRndOpen() {
  if (!state.uprising.path || !uprGroups().length) {
    toast(t("upr_rnd_no_map") || "Сначала откройте карту", "err");
    return;
  }
  _uprRndPlan = null;
  _uprRndSnap = null;
  const modal = $("#upr-rnd-modal");
  const body = $("#upr-rnd-body");
  const foot = $("#upr-rnd-foot");
  body.innerHTML = "";
  foot.innerHTML = "";
  const o = uprRndOpts();

  // --- левая колонка: таблица секторов ---
  const secBox = document.createElement("div");
  secBox.className = "upr-rnd-sectors";
  const secTitle = document.createElement("div");
  secTitle.className = "upr-rnd-gtitle";
  secTitle.textContent = t("upr_rnd_sectors") || "Секторы";
  secBox.appendChild(secTitle);
  (window.UPR_MAP_SECTORS || []).slice()
    .sort((a, b) => a.num - b.num).forEach(s => {
      const row = document.createElement("div");
      row.className = "upr-rnd-sec-row";
      row.dataset.num = s.num;
      const lab = document.createElement("span");
      lab.innerHTML = uprRndShield(s.num);
      lab.title = s.faction || "";
      const sel = document.createElement("select");
      [1, 2, 3, 4, 5, 6].forEach(d => {
        const op = document.createElement("option");
        op.value = d;
        op.textContent = t("upr_diff_" + d) ? d + " · " + t("upr_diff_" + d) : String(d);
        if (uprZoneDiff(s.num) === d) op.selected = true;
        sel.appendChild(op);
      });
      sel.onchange = () => { uprSetZdiff(s.num, sel.value); renderUprising(); };
      // исключение из рандома — красный крест вместо галки
      const ex = document.createElement("button");
      ex.type = "button";
      ex.className = "upr-rnd-ex";
      ex.textContent = "✕";
      ex.title = t("upr_rnd_exclude") || "Исключить из рандома";
      const paintEx = () => {
        const v = uprRndIsExcluded(s.num);
        ex.classList.toggle("on", v);
        row.classList.toggle("excluded", v);
      };
      paintEx();
      ex.onclick = e => {
        e.stopPropagation();
        uprRndSetExcluded(s.num, !uprRndIsExcluded(s.num));
        paintEx();
      };
      // клик по строке подсвечивает зону на карте
      row.onclick = e => {
        if (e.target.closest("select,button")) return;
        document.querySelectorAll(".upr-zone").forEach(p =>
          p.classList.toggle("sel", p.dataset.num === String(s.num)));
        row.classList.add("hl");
        setTimeout(() => row.classList.remove("hl"), 900);
      };
      row.append(lab, sel, ex);
      secBox.appendChild(row);
    });

  // --- правая колонка: опции ---
  const opts = document.createElement("div");
  opts.className = "upr-rnd-opts";
  const group = (title, hint) => {
    const g = document.createElement("div");
    g.className = "upr-rnd-group";
    const h = document.createElement("div");
    h.className = "upr-rnd-gtitle";
    h.textContent = title;
    g.appendChild(h);
    if (hint) {
      const hh = document.createElement("div");
      hh.className = "upr-rnd-hint";
      hh.textContent = hint;
      g.appendChild(hh);
    }
    opts.appendChild(g);
    return g;
  };
  const chk = (g, label, val, fn) => {
    const r = document.createElement("label");
    r.className = "upr-rnd-row";
    const c = document.createElement("input");
    c.type = "checkbox";
    c.checked = !!val;
    c.onchange = () => { fn(c.checked); uprRndSaveOpts(o); };
    r.append(c, document.createTextNode(label));
    g.appendChild(r);
    return c;
  };
  const slider = (g, label, val, min, max, step, fmt, fn) => {
    // одна линия: текст слева, полоса фиксированной длины по правому краю
    const box = document.createElement("div");
    box.className = "upr-slider-row";
    const lb = document.createElement("span");
    lb.textContent = label;
    const mid = document.createElement("div");
    mid.className = "upr-slider-mid";
    const s = document.createElement("input");
    s.type = "range"; s.min = min; s.max = max; s.step = step; s.value = val;
    s.className = "upr-slider-in";
    const v = document.createElement("span");
    v.className = "upr-rnd-val";
    const paint = () => { v.textContent = fmt(parseFloat(s.value)); };
    s.oninput = () => { paint(); fn(parseFloat(s.value)); uprRndSaveOpts(o); };
    paint();
    const tk = document.createElement("div");
    tk.className = "upr-ticks";
    const n = Math.max(1, Math.round((max - min) / step));
    const per = 200 / n;
    tk.style.background =
      `repeating-linear-gradient(90deg, #7a818b 0, #7a818b 1px, transparent 1px, transparent ${per}px)`;
    mid.append(s, tk);
    box.append(lb, mid, v);
    g.appendChild(box);
    return s;
  };

  // блок 1: категории
  const g1 = group(t("upr_rnd_cats") || "Что рандомизируем",
    t("upr_rnd_h_cats") || "Какие типы юнитов перемешиваем. Выключенная категория остаётся на своих местах.");
  Object.keys(o.cats).forEach(cat => {
    chk(g1, cat, o.cats[cat], v => { o.cats[cat] = v; });
  });
  // блок 2: хаос/баланс + веса
  const g2 = group(t("upr_rnd_balance") || "Хаос ↔ Баланс",
    t("upr_rnd_h_balance") || "Хаос (k) — сила перемешивания: 0 почти ничего не меняет, 2 разбрасывает всё. Вес ×N — каким типам отдавать более сильные сектора.");
  slider(g2, t("upr_rnd_t_k") || "Хаос (k) — сила перемешивания", o.k, 0, 2, 0.1, x => x.toFixed(1), v => { o.k = v; });
  Object.keys(o.weights).forEach(cat => {
    slider(g2, (t("upr_rnd_t_w_pre") || "Вес") + " «" + cat + "» " + (t("upr_rnd_t_w_post") || "— приоритет сильных секторов"),
      o.weights[cat], 0, 5, 0.5,
      x => "×" + (Number.isInteger(x) ? x : x.toFixed(1)),
      v => { o.weights[cat] = v; });
  });
  chk(g2, t("upr_rnd_heads") || "Считать в головах (Count)", o.countHeads,
    v => { o.countHeads = v; });
  // блок 3: сложность
  const g3 = group(t("upr_rnd_diff") || "Сложность",
    t("upr_rnd_h_diff") || "Сложность секторов читается из карты. «Привязать» проставит её по стоимости гарнизонов.");
  const bindBtn = document.createElement("button");
  bindBtn.type = "button";
  bindBtn.className = "btn";
  bindBtn.textContent = t("upr_rnd_bind") || "Привязать сложность";
  bindBtn.onclick = async () => { await uprBindDifficulty(); uprRndRefreshReport(); };
  const costBtn = document.createElement("button");
  costBtn.type = "button";
  costBtn.className = "btn";
  costBtn.textContent = t("upr_rnd_by_cost") || "Предложить по стоимости";
  costBtn.onclick = () => uprRndByCost();
  const brow = document.createElement("div");
  brow.className = "upr-rnd-row";
  brow.append(bindBtn, costBtn);
  g3.appendChild(brow);
  chk(g3, t("upr_rnd_soft") || "Мягкий допуск ±1 (половинный вес)", o.softTol,
    v => { o.softTol = v; });
  const undLine = document.createElement("div");
  undLine.className = "upr-rnd-row";
  undLine.id = "upr-rnd-und";
  g3.appendChild(undLine);
  // блок 4: фракции
  const g4 = group(t("upr_rnd_faction") || "Фракции",
    t("upr_rnd_h_faction") || "Можно ли юнитам переезжать в сектора чужих фракций.");
  const frRow = document.createElement("div");
  frRow.className = "upr-rnd-row";
  [["own", t("upr_rnd_fown") || "Только внутри своей"],
   ["mix", t("upr_rnd_fmix") || "Микс разрешён"]].forEach(([val, label]) => {
    const lb = document.createElement("label");
    lb.className = "upr-rnd-row";
    const r = document.createElement("input");
    r.type = "radio"; r.name = "upr-rnd-fmode";
    r.checked = o.factionMode === val;
    r.onchange = () => { o.factionMode = val; uprRndSaveOpts(o); };
    lb.append(r, document.createTextNode(label));
    frRow.appendChild(lb);
  });
  g4.appendChild(frRow);
  chk(g4, t("upr_rnd_free") || "Без фракции — свободное размещение", o.freePlace,
    v => { o.freePlace = v; });
  // блок 5: география
  const g5 = group(t("upr_rnd_geo") || "География",
    t("upr_rnd_h_geo") || "Куда юнитам нельзя попадать и сколько голов держит один сектор (0 — без лимита).");
  chk(g5, t("upr_rnd_noorigin") || "Не класть в исходный сектор", o.noOrigin,
    v => { o.noOrigin = v; });
  chk(g5, t("upr_rnd_noneib") || "Не класть в соседние по номеру (±1)", o.noNeighbours,
    v => { o.noNeighbours = v; });
  slider(g5, t("upr_rnd_cap") || "Лимит голов на сектор (0 — без лимита)",
    o.cap, 0, 100, 1, x => String(x | 0), v => { o.cap = v | 0; });
  // блок 7: отчёт
  const g7 = group(t("upr_rnd_report") || "Отчёт");
  const rep = document.createElement("div");
  rep.className = "upr-rnd-report";
  rep.id = "upr-rnd-report";
  rep.textContent = t("upr_rnd_noplan") || "Нажмите «Рассчитать»";
  g7.appendChild(rep);

  body.append(secBox, opts);

  // --- фут: сид + стратегия сирот + действия ---
  const seedLab = document.createElement("span");
  seedLab.textContent = "seed";
  const seedInp = document.createElement("input");
  seedInp.className = "seed";
  seedInp.value = o.seed;
  seedInp.title = "seed";
  seedInp.onchange = () => {
    o.seed = parseInt(seedInp.value, 10) || 0;
    uprRndSaveOpts(o);
  };
  const dice = document.createElement("button");
  dice.type = "button"; dice.className = "btn"; dice.textContent = "🎲";
  dice.title = t("upr_rnd_dice") || "Случайный сид";
  dice.onclick = () => {
    o.seed = (Math.random() * 1000000) | 0;
    seedInp.value = o.seed;
    uprRndSaveOpts(o);
  };
  const orphSel = document.createElement("select");
  [["nearest", t("upr_rnd_onear") || "Сироты: в ближайший"],
   ["stay", t("upr_rnd_ostay") || "Сироты: оставить"],
   ["skip", t("upr_rnd_oskip") || "Сироты: пропустить"]].forEach(([val, label]) => {
    const op = document.createElement("option");
    op.value = val; op.textContent = label;
    if (o.orphan === val) op.selected = true;
    orphSel.appendChild(op);
  });
  orphSel.onchange = () => { o.orphan = orphSel.value; uprRndSaveOpts(o); };
  const mkBtn = (label, kind, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn" + (kind ? " " + kind : "");
    b.textContent = label;
    b.onclick = fn;
    foot.appendChild(b);
    return b;
  };
  foot.append(seedLab, seedInp, dice, orphSel);
  const safe = fn => () => {
    try {
      const r = fn();
      if (r && r.catch) r.catch(e => {
        const msg = String((e && e.message) || e);
        try {
          if (typeof reportClientError === "function")
            reportClientError("rnd-err", msg, { stack: String((e && e.stack) || "").slice(0, 500) });
        } catch (e2) {}
        toast(msg, "err");
      });
    } catch (e) { toast(String((e && e.message) || e), "err"); }
  };
  mkBtn(t("upr_rnd_calc") || "Рассчитать", "", safe(() => uprRndCalc(false)));
  mkBtn(t("upr_rnd_reroll") || "Реролл", "", safe(() => uprRndCalc(true)));
  mkBtn(t("upr_rnd_apply") || "Применить", "accent", safe(() => uprRndApply()));
  mkBtn(t("upr_rnd_undo") || "Отменить", "", safe(() => uprRndUndo()));
  // «Восстановить оригинальную карту» живёт в настройках карты (шестерёнка)
  modal.hidden = false;
  uprRndRefreshReport();
}

// попап прогресса долгой записи: сколько ячеек уже сохранено
function uprProgress(total, label) {
  const ov = document.createElement("div");
  ov.className = "upr-prog-ov";
  ov.innerHTML = `<div class="upr-prog-card"><div class="upr-prog-label"></div>` +
    `<div class="upr-prog-bar"><div class="upr-prog-fill"></div></div>` +
    `<div class="upr-prog-pct">0 / ${total}</div></div>`;
  document.body.appendChild(ov);
  const fill = ov.querySelector(".upr-prog-fill");
  const pct = ov.querySelector(".upr-prog-pct");
  ov.querySelector(".upr-prog-label").textContent = label || "";
  let done = 0;
  return {
    update() {
      done++;
      const p = total ? Math.round(done / total * 100) : 100;
      fill.style.width = p + "%";
      pct.textContent = done + " / " + total;
    },
    close() { ov.remove(); },
  };
}

// строка «без явной сложности: N» + кнопка привязки (мягкий режим)
function uprRndRefreshReport() {
  const line = $("#upr-rnd-und");
  if (!line || !state.uprising.path) return;
  line.innerHTML = "";
  const ud = uprUdiffs();
  let n = 0;
  uprGroups().forEach(g => g.list.forEach((rw, vi) => {
    UPRISING_CATS.forEach(cat => {
      const ci = uprCatCol(cat);
      if (ci === -1) return;
      uprParseList(state.uprising.rows[rw.ri].values[ci] || "").forEach(it => {
        if (it.name && !ud[uprPickKey(g.num, vi, cat, it.name)]) n++;
      });
    });
  }));
  line.textContent = (t("upr_rnd_inherit") || "Наследуют сложность зоны: ") + n;
}

// «Предложить по стоимости»: квантили cost -> 1..6 черновиком (только пустым)
async function uprRndByCost() {
  const meta = await uprRndMeta();
  const costs = Object.values(meta.costs || {}).filter(x => x > 0).sort((a, b) => a - b);
  if (!costs.length) {
    toast(t("upr_rnd_nocost") || "Нет данных о стоимости", "err");
    return;
  }
  const q = x => {
    const pos = costs.filter(c => c <= x).length / costs.length;
    return Math.min(6, Math.max(1, Math.ceil(pos * 6)));
  };
  const ud = uprUdiffs();
  let n = 0;
  uprGroups().forEach(g => g.list.forEach((rw, vi) => {
    UPRISING_CATS.forEach(cat => {
      const ci = uprCatCol(cat);
      if (ci === -1) return;
      uprParseList(state.uprising.rows[rw.ri].values[ci] || "").forEach(it => {
        const key = uprPickKey(g.num, vi, cat, it.name);
        const c = meta.costs[it.name];
        if (it.name && !ud[key] && c > 0) { ud[key] = String(q(c)); n++; }
      });
    });
  }));
  try { localStorage.setItem("tsh_upr_udiff", JSON.stringify(ud)); } catch (e) {}
  toast((t("upr_rnd_costdone") || "Предложено: ") + n, "ok");
  uprRndRefreshReport();
}

// ---------- алгоритм ----------
function uprRndHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function uprRndRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// фракция юнита -> ключ цвета зоны (через uprZoneKey с оверрайдами);
// resistance и неизвестные пары зон не имеют -> wildcard
const UPR_RND_F2Z = { legion: "legion", integrators: "integrators",
  founders: "founders", marauders: "grey", cartel: "yellow" };
function uprRndZoneKey(num) {
  const s = (window.UPR_MAP_SECTORS || []).find(x => x.num === num);
  return uprZoneKey(num, s ? s.faction : "grey");
}

// собрать юнитов карты: [{name, n, cat, num, vi, ri, range:[a,b], inherited}]
function uprRndCollect(o) {
  const ud = uprUdiffs();
  const out = [];
  uprGroups().forEach(g => g.list.forEach((rw, vi) => {
    UPRISING_CATS.forEach(cat => {
      if (!o.cats[cat]) return;
      const ci = uprCatCol(cat);
      if (ci === -1) return;
      uprParseList(state.uprising.rows[rw.ri].values[ci] || "").forEach(it => {
        if (!it.name) return;
        const own = uprRndParseDiff(ud[uprPickKey(g.num, vi, cat, it.name)]);
        out.push({ name: it.name, n: Math.max(1, it.n | 0), cat,
          num: g.num, vi, ri: rw.ri,
          range: own || [uprZoneDiff(g.num), uprZoneDiff(g.num)],
          inherited: !own });
      });
    });
  }));
  return out;
}

async function uprRndCalc(reroll) {
  const o = uprRndOpts();
  const seedInp = document.querySelector("#upr-rnd-foot .seed");
  if (reroll) {
    o.seed = ((o.seed | 0) + 1) >>> 0;
    if (seedInp) seedInp.value = o.seed;
    uprRndSaveOpts(o);
  } else if (seedInp) {
    o.seed = parseInt(seedInp.value, 10) || 0;
    uprRndSaveOpts(o);
  }
  const meta = await uprRndMeta();
  const sectors = (window.UPR_MAP_SECTORS || []).slice()
    .sort((a, b) => a.num - b.num)
    .filter(s => !uprRndIsExcluded(s.num));
  const zdiff = {};
  sectors.forEach(s => { zdiff[s.num] = uprZoneDiff(s.num); });

  const units = uprRndCollect(o);
  // нагрузка от НЕучаствующих (категория выкл): они остаются на месте
  const load = {};
  sectors.forEach(s => { load[s.num] = 0; });
  uprGroups().forEach(g => g.list.forEach((rw, vi) => {
    UPRISING_CATS.forEach(cat => {
      if (o.cats[cat]) return;
      const ci = uprCatCol(cat);
      if (ci === -1) return;
      uprParseList(state.uprising.rows[rw.ri].values[ci] || "").forEach(it => {
        if (it.name && load[g.num] !== undefined)
          load[g.num] += (o.countHeads ? Math.max(1, it.n | 0) : 1) * (o.weights[cat] || 0);
      });
    });
  }));

  // порядок: сначала самый ограниченный (уже диапазон), тай-брейк хеш+сид
  units.sort((a, b) =>
    ((a.range[1] - a.range[0]) - (b.range[1] - b.range[0])) ||
    (uprRndHash(a.name + o.seed) - uprRndHash(b.name + o.seed)));
  const rnd = uprRndRng((o.seed ^ 0x9E3779B9) >>> 0);
  const wOf = u => (o.countHeads ? u.n : 1) * (o.weights[u.cat] || 0);
  const moves = [];
  const orphans = [];
  units.forEach(u => {
    const [mn, mx] = u.range;
    const fac = (meta.factions || {})[u.name] || "";
    const zkey = UPR_RND_F2Z[fac] || "";
    let cands = sectors.filter(s => {
      const d = zdiff[s.num];
      const inR = d >= mn && d <= mx;
      const soft = o.softTol && !inR && d >= mn - 1 && d <= mx + 1;
      if (!inR && !soft) return false;
      if (o.factionMode === "own" && zkey && uprRndZoneKey(s.num) !== zkey) return false;
      if (!zkey && !o.freePlace && o.factionMode === "own") {
        // у юнита нет пары зона-фракция: без freePlace остаётся на месте
        if (fac && s.num !== u.num) return false;
      }
      if (o.noOrigin && s.num === u.num) return false;
      if (o.noNeighbours && Math.abs(s.num - u.num) <= 1 && s.num !== u.num) return false;
      if (o.cap > 0 && (load[s.num] || 0) + wOf(u) > o.cap) return false;
      u._soft = soft;
      return true;
    });
    if (!cands.length) {
      // сирота: nearest = ближайший D_s к диапазону
      let to = null;
      if (o.orphan === "nearest" && sectors.length) {
        let best = Infinity;
        sectors.forEach(s => {
          const d = zdiff[s.num];
          const dist = d < mn ? mn - d : (d > mx ? d - mx : 0);
          if (dist < best) { best = dist; to = s.num; }
        });
      }
      orphans.push({ name: u.name, cat: u.cat, range: u.range, to });
      moves.push({ u, to });
      if (to !== null) load[to] += wOf(u);
      return;
    }
    // взвешенный выбор: 1/(1+load)^k, мягкий допуск — половинный вес
    const ws = cands.map(s =>
      Math.pow(1 / (1 + (load[s.num] || 0)), o.k) * (zdiff[s.num] >= mn &&
        zdiff[s.num] <= mx ? 1 : 0.5));
    let sum = 0;
    ws.forEach(w => { sum += w; });
    let pick = rnd() * sum, to = cands[cands.length - 1].num;
    for (let i = 0; i < cands.length; i++) {
      pick -= ws[i];
      if (pick <= 0) { to = cands[i].num; break; }
    }
    moves.push({ u, to });
    load[to] += wOf(u);
  });

  _uprRndPlan = { moves, orphans, seed: o.seed, units: units.length };
  // ВРЕМЕННАЯ диагностика (убрать после починки): что насчиталось
  try {
    if (typeof reportClientError === "function") {
      const grpNums = uprGroups().map(g => g.num).join(",");
      const secNums = sectors.map(s => s.num).join(",");
      const mv = moves.filter(m => m.to !== null && m.to !== m.u.num).length;
      const s1 = moves.filter(m => m.u.num === 1 || m.to === 1).length;
      reportClientError("rnd-calc",
        `units=${units.length} groups=[${grpNums}] sectors=[${secNums}] moved=${mv} s1=${s1} orph=${orphans.length}`, {});
    }
  } catch (e) {}
  uprRndPaintReport();
  toast((t("upr_rnd_planned") || "Рассчитано: ") + moves.filter(m => m.to !== null &&
    m.to !== m.u.num).length + " / " + units.length, "ok");
}

// отчёт: сектор -> было/стало голов + сироты
function uprRndPaintReport() {
  const rep = $("#upr-rnd-report");
  if (!rep) return;
  rep.innerHTML = "";
  if (!_uprRndPlan) {
    rep.textContent = t("upr_rnd_noplan") || "Нажмите «Рассчитать»";
    return;
  }
  const o = uprRndOpts();
  const wOf = u => (o.countHeads ? u.n : 1);
  const before = {}, after = {};
  const bust = (m, s, v) => { m[s] = (m[s] || 0) + v; };
  // было: всё текущее размещение
  uprGroups().forEach(g => g.list.forEach((rw, vi) => {
    UPRISING_CATS.forEach(cat => {
      const ci = uprCatCol(cat);
      if (ci === -1) return;
      uprParseList(state.uprising.rows[rw.ri].values[ci] || "").forEach(it => {
        if (it.name) bust(before, g.num, o.countHeads ? Math.max(1, it.n | 0) : 1);
      });
    });
  }));
  Object.keys(before).forEach(k => { after[k] = before[k]; });
  _uprRndPlan.moves.forEach(({ u, to }) => {
    if (to === null || to === u.num) return;
    const w = wOf(u);
    after[u.num] -= w;
    after[to] = (after[to] || 0) + w;
  });
  const tbl = document.createElement("table");
  const hr = document.createElement("tr");
  ["№", t("upr_rnd_c_before") || "Было", t("upr_rnd_c_after") || "Стало",
   "Δ"].forEach(h => {
    const th = document.createElement("th");
    th.textContent = h;
    hr.appendChild(th);
  });
  tbl.appendChild(hr);
  Object.keys(after).map(Number).sort((a, b) => a - b).forEach(num => {
    const tr = document.createElement("tr");
    [num, before[num] || 0, after[num] || 0,
     (after[num] || 0) - (before[num] || 0)].forEach((v, i) => {
      const td = document.createElement("td");
      // «+» — только у дельты; было/стало — обычные итоги в головах
      td.textContent = (i === 3 && v > 0 ? "+" : "") + v;
      if (i === 3 && v !== 0) td.style.color = v > 0 ? "#7fd67f" : "#e08080";
      tr.appendChild(td);
    });
    tbl.appendChild(tr);
  });
  rep.appendChild(tbl);
  if (_uprRndPlan.orphans.length) {
    const p = document.createElement("div");
    p.style.marginTop = "8px";
    p.textContent = (t("upr_rnd_orphans") || "Сироты: ") +
      _uprRndPlan.orphans.map(x =>
        x.name + " [" + x.range[0] + "-" + x.range[1] + "]" +
        (x.to === null ? "×" : "→" + x.to)).join(", ");
    rep.appendChild(p);
  }
}

// применить: снапшот -> переписать ячейки батчем -> автосейв cfg
async function uprRndApply() {
  if (!_uprRndPlan) {
    toast(t("upr_rnd_noplan") || "Нажмите «Рассчитать»", "err");
    return;
  }
  // снапшот для «Отмены»: значения ячеек + сложности юнитов
  _uprRndSnap = {
    cells: new Map(),
    udiff: JSON.stringify(uprUdiffs()),
  };
  const touch = (ri, ci) => {
    const k = ri + "|" + ci;
    if (!_uprRndSnap.cells.has(k))
      _uprRndSnap.cells.set(k, state.uprising.rows[ri].values[ci] || "");
  };
  // сгруппировать переезды по ячейкам (num|vi|cat); вариант выдачи
  // подгоняется под целевой сектор (у него может быть меньше строк) —
  // иначе юнит удалялся из исходного, а в целевой не попадал
  const grpLen = {};
  uprGroups().forEach(g => { grpLen[g.num] = g.list.length; });
  const fitVi = (num, vi) => Math.min(vi, Math.max(0, (grpLen[num] || 1) - 1));
  const byCell = new Map();  _uprRndPlan.moves.forEach(({ u, to }) => {
    if (to === null || to === u.num) return;
    const viIn = fitVi(to, u.vi);
    const kOut = u.num + "|" + u.vi + "|" + u.cat;
    const kIn = to + "|" + viIn + "|" + u.cat;
    if (!byCell.has(kOut)) byCell.set(kOut, { num: u.num, vi: u.vi, cat: u.cat, del: [], add: [] });
    if (!byCell.has(kIn)) byCell.set(kIn, { num: to, vi: viIn, cat: u.cat, del: [], add: [] });
    byCell.get(kOut).del.push(u.name);
    byCell.get(kIn).add.push({ name: u.name, n: u.n, vi: viIn });
  });
  // ri ячейки: сектор|вариант -> ri (первая строка группы/варианта)
  const riOf = {};
  uprGroups().forEach(g => g.list.forEach((rw, vi) => {
    const k = g.num + "|" + vi;
    if (riOf[k] === undefined) riOf[k] = rw.ri;
  }));
  // ВРЕМЕННАЯ диагностика (убрать после починки)
  try {
    if (typeof reportClientError === "function") {
      const mv = _uprRndPlan.moves.filter(({ u, to }) => to !== null && to !== u.num);
      reportClientError("rnd-apply",
        `planMoves=${mv.length} byCell=${byCell.size} hasSnap=${!!_uprRndSnap}`, {});
    }
  } catch (e) {}
  let saveErr = 0;
  const prog = uprProgress(byCell.size, t("upr_rnd_applying") || "Применение…");
  // применение плана — одна команда для отмены: все ячейки батчем
  const edits = [];
  try {
    for (const [k, cell] of byCell) {
    const ri = riOf[cell.num + "|" + cell.vi];
    const ci = uprCatCol(cell.cat);
    if (ri === undefined || ci === -1 ||
        !state.uprising.rows[ri] || ci >= (state.uprising.rows[ri].values || []).length) {
      saveErr++;
      continue;
    }
    touch(ri, ci);
    let arr = uprParseList(state.uprising.rows[ri].values[ci] || "");
    cell.del.forEach(nm => { arr = arr.filter(x => x.name !== nm); });
    cell.add.forEach(a => {
      const ex = arr.find(x => x.name === a.name);
      if (ex) ex.n += a.n;
      else arr.push({ name: a.name, n: a.n });
    });
    edits.push({ ri, ci, val: uprJoinList(arr) });
    prog.update();
  }
    try {
      await uprWriteCells(edits,
        ((typeof t === "function" && t("upr_h_random")) || "Рандомайзер ({k} яч.)")
          .replace("{k}", edits.length));
    }
    catch (e) { saveErr += edits.length; }
  } finally {
    prog.close();
  }
  // перенос own-сложностей на новые ключи (по moves, вариант подогнан)
  const ud2 = uprUdiffs();
  _uprRndPlan.moves.forEach(({ u, to }) => {
    if (to === null || to === u.num || u.inherited) return;
    const ok = uprPickKey(u.num, u.vi, u.cat, u.name);
    const nk = uprPickKey(to, fitVi(to, u.vi), u.cat, u.name);
    if (ud2[ok] !== undefined) {
      ud2[nk] = ud2[ok];
      delete ud2[ok];
    }
  });
  try { localStorage.setItem("tsh_upr_udiff", JSON.stringify(ud2)); } catch (e) {}
  uprMarkDirty();
  uprCfgExport(true);   // автосейв cfg, как «Сохранить»
  renderUprising();
  uprRndRefreshReport();
  // план одноразовый: повторное «Применить» дописывало бы юниты поверх —
  // дальше только «Рассчитать» заново, откат — через «Отменить»
  _uprRndPlan = null;
  uprRndPaintReport();
  toast((t("saved") || "Сохранено") + (saveErr ? " (ошибок: " + saveErr + ")" : ""), saveErr ? "err" : "ok");
}

// зелёная кнопка: вернуть оригинальный shop_presets из резерва программы
async function uprRndRestore() {
  if (!state.uprising.path) return;
  const r = await api("/api/uprising_reset", { method: "POST",
    body: JSON.stringify({ root: uprSrcRoot(), path: state.uprising.path }) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "error", "err"); return; }
  _uprRndPlan = null;
  _uprRndSnap = null;
  await uprLoad(true);   // сессию сбросить, файл перечитать с диска
  uprApplyColors();
  renderUprising();
  uprRndRefreshReport();
  uprRndPaintReport();
  toast(t("upr_rnd_restored") || "Оригинальная карта восстановлена", "ok");
}
// настройки карты зовут восстановление напрямую (кнопка переехала туда
// из модалки рандомайзера)
window.uprRndRestore = uprRndRestore;

// отмена: вернуть снапшот
async function uprRndUndo() {
  const snap = _uprRndSnap;
  if (!snap || !snap.cells) {
    toast(t("upr_rnd_nosnap") || "Нечего отменять", "err");
    return;
  }
  const cells = [...snap.cells];
  const prog = uprProgress(cells.length, t("upr_rnd_undoing") || "Отмена…");
  // отмена плана — тоже одна команда: все ячейки батчем
  const edits = [];
  try {
    for (const [k, val] of cells) {
      const [ri, ci] = k.split("|").map(Number);
      if (!state.uprising.rows[ri]) continue;
      edits.push({ ri, ci, val });
      prog.update();
    }
    try { await uprWriteCells(edits); } catch (e) {}
  } finally {
    prog.close();
  }
  try { localStorage.setItem("tsh_upr_udiff", snap.udiff); } catch (e) {}
  _uprRndSnap = null;
  _uprRndPlan = null;
  uprMarkDirty();
  renderUprising();
  uprRndRefreshReport();
  uprRndPaintReport();
  toast(t("upr_rnd_undone") || "Отменено", "ok");
}

})();

