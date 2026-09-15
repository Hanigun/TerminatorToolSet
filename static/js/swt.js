/* TerminatorToolSet frontend — swt.js: редактор SWT целиком
   Вырезано из app.js без изменений логики. Классические скрипты,
   общий глобальный скоуп, порядок загрузки — FILES в templates/index.html. */
// ---------- SWT editor (mission trigger scripts) ----------
// раздел-кнопка: открыть редактор без файла (своры/подсказка до выбора .swt)
function openSwtEditor() {
  if (!state.tabs.some(tb => tb.id === "swt")) {
    createTab("swt");
    renderTabBar();   // без этого вкладка не появлялась до первого изменения
  }
  // страница SWT открывается с видимым деревом: activateTab применит
  // фильтр «только .swt» (swtApplyTreeFilter)
  state.sidebarCollapsed = false;
  activateTab("swt");
}

// фильтр SWT-страницы: в дереве остаются только .swt (все остальные галки
// сняты); прежние фильтры запоминаются и возвращаются при уходе со страницы
function swtApplyTreeFilter() {
  if (!state.swtFilterBackup) {
    state.swtFilterBackup = {
      exts: state.treeExtFilter ? [...state.treeExtFilter] : null,
      folders: state.treeFolderFilter ? [...state.treeFolderFilter] : null,
    };
  }
  state.treeExtFilter = new Set(["swt"]);
  state.treeFolderFilter = null;
  renderTree();
  updateTreeFilterButton();
}

function swtRestoreTreeFilter() {
  const b = state.swtFilterBackup;
  if (!b) return;
  state.swtFilterBackup = null;
  state.treeExtFilter = b.exts ? new Set(b.exts) : null;
  state.treeFolderFilter = b.folders ? new Set(b.folders) : null;
  renderTree();
  updateTreeFilterButton();
}

// Локализованный текст описания SWT-команды: description словаря — ключ
// локализации вида "swt_<имя>", тексты в locales/*.json; фолбэк — сырой текст
function swtCmdText(c) {
  if (!c) return "";
  return t("swt_" + c.name) || t(c.description) || c.description || "";
}

function swtFreshState() {  return { path: null, doc: null, fixed: 0, cmds: [], cmdMap: {},
           sel: -1, dirty: false, condOpen: true, actOpen: true, mtime: 0,
           _undo: [], _redo: [],
           _docSrc: {}, _analyzed: false, _srcPromise: null, _srcLoading: null };
}

// следующий свободный guid: max+1 по всему файлу В СВОЁМ типе (нумерации
// Trigger/Condition/Action независимы — пересечения между типами норма
// файлов игры, их не трогаем; см. fix_duplicate_guids)
function swtNextGuid(tag) {
  let mx = 0;
  const num = g => {
    const s = String(g == null ? "" : g).trim();
    if (/^\d+$/.test(s)) mx = Math.max(mx, parseInt(s, 10));
  };
  (state.swt.doc ? state.swt.doc.triggers : []).forEach(t => {
    if (tag === "Trigger") num(t.guid);
    (t.items || []).forEach(it => { if (it.tag === tag && !("raw" in it)) num(it.guid); });
  });
  return String(mx + 1);
}

function swtParamSpec(cmdName) {
  // описание команды -> подсказки параметров: "текст [имя] текст [select:a,b]"
  const e = state.swt.cmdMap && state.swt.cmdMap[cmdName];
  if (!e || !e.description) return [];
  const d = swtCmdText(e);
  const out = [];
  const re = /\[([^\]]+)\]/g;
  let m, last = 0;
  while ((m = re.exec(d))) {
    out.push({ label: d.slice(last, m.index).replace(/^[,;.\s]+|[,;.\s]+$/g, ""),
               spec: m[1] });
    last = re.lastIndex;
  }
  return out;
}

// ---------- Автозаполнение SWT: кастомный красивый дропдаун ----------
// панель позиционируется фиксированно ровно по ширине поля, пункты с
// описаниями, навигация стрелками, Enter/клик - выбор, Esc - закрыть
let swtAcOpenEl = null;   // сейчас открытый дропдаун (элемент в body)

function swtAcClose() {
  if (swtAcOpenEl) {
    swtAcOpenEl.remove();
    swtAcOpenEl = null;
  }
}

function swtAcPosition(panel, relEl) {
  // панель ровно под элементом и по его ширине
  const r = relEl.getBoundingClientRect();
  panel.style.left = r.left + "px";
  panel.style.top = (r.bottom + 3) + "px";
  panel.style.width = r.width + "px";
}

function swtAutocomplete(inp, items, onPick, opts) {
  // items: массив строк или {value, desc}; можно функция (свежие данные);
  // opts.openOnFocus === false — не открывать список сразу по фокусу
  // (только по вводу/стрелке): для поповера чипов карты, где фокус ставится
  // программно и мгновенная простыня мешает
  const openOnFocus = !opts || opts.openOnFocus !== false;
  const norm = s => String(s || "").toLowerCase();
  let panel = null;
  let active = -1;

  const filtered = () => {
    const arr = (typeof items === "function" ? items() : items) || [];
    const q = norm(inp.value.trim());
    const f = q ? arr.filter(it => norm((it && typeof it === "object") ? it.value : it).includes(q)) : arr;
    return f.slice(0, 200);
  };

  const close = () => {
    if (panel) {
      panel.remove();
      if (swtAcOpenEl === panel) swtAcOpenEl = null;   // гасим ссылку до обнуления panel
      panel = null;
    }
    active = -1;
  };

  const render = () => {
    const arr = filtered();
    if (!arr.length) { close(); return; }
    panel.innerHTML = "";
    arr.forEach((it, i) => {
      const v = (it && typeof it === "object") ? it.value : it;
      const el = document.createElement("div");
      el.className = "swt-ac-item" + (i === active ? " active" : "");
      el.title = v;
      const nm = document.createElement("span");
      nm.className = "swt-ac-name";
      nm.textContent = v;
      el.appendChild(nm);
      const desc = (it && typeof it === "object" && it.desc) ? it.desc : "";
      if (desc) {
        const d = document.createElement("span");
        d.className = "swt-ac-desc";
        d.textContent = desc;
        el.appendChild(d);
      }
      el.addEventListener("mousedown", e => {
        e.preventDefault();   // выбрать до blur у поля
        close();
        onPick(v);
      });
      panel.appendChild(el);
    });
    swtAcPosition(panel, inp);
    panel.classList.add("open");
    const a = panel.children[active];
    if (a && a.scrollIntoView) a.scrollIntoView({ block: "nearest" });
  };

  const open = () => {
    if (!inp.isConnected) return;
    swtAcClose();
    // глобальное закрытие (клик мимо/скролл/ресайз) удаляет узел из DOM,
    // но локальная ссылка живёт - переиспользовать её нельзя, иначе список
    // рендерится в «мёртвую» панель и больше никогда не появляется
    if (!panel || !panel.isConnected) {
      if (panel) panel.remove();
      panel = document.createElement("div");
      panel.className = "swt-ac-panel";
      panel.__inp = inp;
      document.body.appendChild(panel);
    }
    active = -1;
    swtAcOpenEl = panel;
    render();
    // словарей ещё нет (фоновая загрузка при открытии не успела/упала) —
    // догружаем и перерисовываем список, когда придут; фокус ещё в поле —
    // панель пересоздаём ТИХО (без полного open): полный open через
    // swtAcClose убивает чужую панель, её осиротевший .then открывает свою,
    // убивая нашу — вечная микротаск-петля open→then→open без отрисовки
    // («не отвечает»). Здесь словари уже загружены (ok), новый ensure не
    // нужен и новый .then не вешаем — петле не из чего состоять.
    swtEnsureSources().then(ok => {
      if (!ok) return;
      if (panel && panel.isConnected) { render(); return; }
      if (document.activeElement !== inp) return;
      if (panel) { try { panel.remove(); } catch (e) {} }
      panel = document.createElement("div");
      panel.className = "swt-ac-panel";
      panel.__inp = inp;
      document.body.appendChild(panel);
      active = -1;
      swtAcOpenEl = panel;
      render();
    });
  };

  inp.addEventListener("focus", () => { if (openOnFocus) open(); });
  inp.addEventListener("input", open);
  inp.addEventListener("keydown", e => {
    if (!panel) {
      if (e.key === "ArrowDown") { e.preventDefault(); open(); }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = panel.children.length;
      if (!n) return;
      active = e.key === "ArrowDown" ? Math.min(active + 1, n - 1) : Math.max(active - 1, 0);
      render();
    } else if (e.key === "Enter") {
      if (panel.children.length) {
        e.preventDefault();
        const it = filtered()[Math.max(active, 0)];
        const v = (it && typeof it === "object") ? it.value : it;
        close();
        if (v != null) onPick(v);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();   // Esc закрывает только список, не fullscreen
      close();
    }
  });
}

// глобальные закрытия: клик мимо, прокрутка, ресайз (одни слушатели на всех)
(function () {
  if (window.__swtAcInit) return;
  window.__swtAcInit = true;
  document.addEventListener("mousedown", e => {
    if (!swtAcOpenEl) return;
    if (swtAcOpenEl.contains(e.target)) return;
    if (swtAcOpenEl.__inp && swtAcOpenEl.__inp.contains(e.target)) return;
    swtAcClose();
  }, true);
  // прокрутка: саму панель (её скроллбар/колесо/стрелки) не закрываем;
  // при прокрутке страницы панель остаётся прижатой к своему полю
  document.addEventListener("scroll", e => {
    if (!swtAcOpenEl) return;
    if (e.target === swtAcOpenEl || (e.target && swtAcOpenEl.contains(e.target))) return;
    const inp = swtAcOpenEl.__inp;
    if (inp && inp.isConnected) {
      const r = inp.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) { swtAcClose(); return; }
      swtAcPosition(swtAcOpenEl, inp);
    } else {
      swtAcClose();
    }
  }, true);
  window.addEventListener("resize", () => { if (swtAcOpenEl) swtAcClose(); });
})();

// кнопка-дропдаун: замена нативному select (тот в тёмной теме выглядит
// чужеродно и не умеет описания). Та же панель .swt-ac-panel, ровно по
// ширине кнопки; клик/Enter выбирают, Esc закрывает; стрелки листают.
function swtDropdown(cur, items, onPick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "swt-dd";
  const label = document.createElement("span");
  label.className = "swt-dd-label";
  label.textContent = cur || "";
  const chev = document.createElement("span");
  chev.className = "swt-dd-chev";
  chev.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  btn.append(label, chev);
  let panel = null;
  let active = -1;
  const arr = () => (typeof items === "function" ? items() : items) || [];

  const close = () => {
    if (panel) {
      panel.remove();
      if (swtAcOpenEl === panel) swtAcOpenEl = null;
      panel = null;
    }
    active = -1;
    btn.classList.remove("open");
  };

  const pick = it => {
    const v = (it && typeof it === "object") ? it.value : it;
    if (v == null) return;
    const d = (it && typeof it === "object" && it.desc) ? it.desc : "";
    close();
    label.textContent = v;
    btn.title = d || v;
    onPick(v);
  };

  const render = () => {
    const a = arr();
    if (!a.length) { close(); return; }
    panel.innerHTML = "";
    a.forEach((it, i) => {
      const v = (it && typeof it === "object") ? it.value : it;
      const el = document.createElement("div");
      el.className = "swt-ac-item" + (i === active ? " active" : "");
      el.title = v;
      const nm = document.createElement("span");
      nm.className = "swt-ac-name";
      nm.textContent = v;
      el.appendChild(nm);
      const desc = (it && typeof it === "object" && it.desc) ? it.desc : "";
      if (desc) {
        const d = document.createElement("span");
        d.className = "swt-ac-desc";
        d.textContent = desc;
        el.appendChild(d);
      }
      el.addEventListener("mousedown", e => {
        e.preventDefault();   // выбрать до blur у кнопки
        pick(it);
      });
      panel.appendChild(el);
    });
    swtAcPosition(panel, btn);
    panel.classList.add("open");
    const ae = panel.children[active];
    if (ae && ae.scrollIntoView) ae.scrollIntoView({ block: "nearest" });
  };

  const open = () => {
    if (!btn.isConnected) return;
    swtAcClose();
    // как в swtAutocomplete: осиротевшую панель не переиспользуем
    if (!panel || !panel.isConnected) {
      if (panel) panel.remove();
      panel = document.createElement("div");
      panel.className = "swt-ac-panel";
      panel.__inp = btn;   // клики по самой кнопке панель не закрывают
      document.body.appendChild(panel);
    }
    active = -1;
    swtAcOpenEl = panel;
    btn.classList.add("open");
    render();
  };

  btn.addEventListener("click", () => (panel && panel.isConnected ? close() : open()));
  btn.addEventListener("keydown", e => {
    if (!panel) {
      if (e.key === "ArrowDown") { e.preventDefault(); open(); }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = panel.children.length;
      if (!n) return;
      active = e.key === "ArrowDown" ? Math.min(active + 1, n - 1) : Math.max(active - 1, 0);
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = arr()[Math.max(active, 0)];
      if (it != null) pick(it);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();   // Esc закрывает только список
      close();
    }
  });
  return btn;
}

// стороны игры: постоянный список + значения, найденные в самом файле
const SWT_TEAMS = ["player", "founders", "legion", "marauders", "cartel",
  "integrators", "resistance", "mercenaries", "neutral",
  "player_ally", "founders_ally", "integrators_ally", "total_marauders"];

// эвристика подсказок к распространённым именам триггеров (start, mov_1, ...)
const SWT_TRIG_HINTS = [
  [/^start\b|^intro/i, { ru: "Стартовый/вступительный триггер: запуск при начале миссии", en: "Intro/starting trigger: runs at mission start" }],
  [/win|victory|complete|end_/i, { ru: "Финальный триггер: завершение миссии (победа/итог)", en: "Final trigger: mission completion (victory)" }],
  [/lose|fail|defeat/i, { ru: "Триггер поражения: провал миссии", en: "Defeat trigger: mission failed" }],
  [/^mov_?\d|move|column|convoy/i, { ru: "Движение: перемещение групп/колонн по зонам", en: "Movement: groups/columns moving through zones" }],
  [/sniper/i, { ru: "Снайперы: позиция/зона снайперов", en: "Snipers: sniper position/zone" }],
  [/reinforce|support/i, { ru: "Подкрепления: вызов дополнительных сил", en: "Reinforcements: calling extra forces" }],
  [/dialog|talk|msg|message/i, { ru: "Диалоги/сообщения: реплики и уведомления", en: "Dialogs/messages: lines and notifications" }],
  [/spawn|create/i, { ru: "Спавн: создание юнитов/групп в зонах", en: "Spawn: creating units/groups in zones" }],
  [/attack|enemy|combat/i, { ru: "Бой: атаки и поведение противника", en: "Combat: attacks and enemy behaviour" }],
  [/zone|area|place|point/i, { ru: "Зоны/точки: работа с областями карты", en: "Zones/points: map area handling" }],
];

function swtTrigHint(name) {
  const n = String(name || "").toLowerCase();
  if (!n) return null;
  for (const [re, h] of SWT_TRIG_HINTS) {
    if (re.test(n)) return state.lang === "en" ? h.en : h.ru;
  }
  return null;
}

// значения, уже использованные в файле, сгруппированные по типу параметра:
// зоны, группы, имена юнитов, триггеры, метки, переменные и т.д.
function swtDocSources() {
  const map = {};
  const add = (spec, v) => {
    v = String(v || "").trim();
    if (!v || v.startsWith("prm=")) return;
    (map[spec] || (map[spec] = new Set())).add(v);
  };
  (state.swt.doc ? state.swt.doc.triggers : []).forEach(tr => {
    (tr.items || []).forEach(it => {
      const specs = swtParamSpec(it.name);
      (it.params || []).forEach((v, pi) => {
        if (pi >= specs.length) return;
        const sp = specs[pi].spec;
        if (!sp || sp.startsWith("select:")) return;
        add(sp, v);
      });
    });
    add("trigger_name", tr.name);
  });
  return map;
}

// подсказки для параметра: массив значений или null (обычный текстовый ввод).
// Внешние словари (юниты и т.п.) есть только при открытом проекте/игре;
// значения из самого файла доступны всегда - ошибок быть не может.
// unitType: тип юнита из того же Action (car|tank|squad|helicopter) -
// пресет улучшения зависит от него (car_upgrade_presets.xml и т.д.)
function swtSuggestFor(spec, unitType) {
  if (!spec || spec.startsWith("select:")) return null;
  const out = new Set();
  const src = state.swtSources || {};
  // тип юнита из того же блока (car|tank|squad|helicopter): sysname и
  // пресет улучшения фильтруются СТРОГО по нему (car — только cars.xml
  // и car_upgrade_presets.xml и т.д.). Тип не выбран — общий словарь
  // (как раньше) + значения из самого файла (они добавляются всегда ниже)
  const own = (typeof unitType === "function" ? unitType() : unitType) || "";
  if (spec === "sysname") {
    const byUnit = { car: src.units_car, tank: src.units_tank,
                     squad: src.units_squad, helicopter: src.units_heli };
    (byUnit[own] || (own ? [] : src.units) || []).forEach(v => out.add(v));
  } else if (spec === "upgrade_sysname") {
    // зависимость от типа: пресет целиком из файла своего типа;
    // тип не выбран - все пресеты; пресетов нет - старые *_upgrades.xml
    const byType = { car: src.car_presets, tank: src.tank_presets,
                     squad: src.squad_presets, helicopter: src.heli_presets };
    if (own) {
      (byType[own] || []).forEach(v => out.add(v));
    } else {
      ["car_presets", "tank_presets", "squad_presets", "heli_presets"]
        .forEach(k => (src[k] || []).forEach(v => out.add(v)));
      if (!out.size) (src.upgrades || []).forEach(v => out.add(v));
    }
  } else {
    const ext = {
      team_name: SWT_TEAMS,
      sysname: src.units,
      // экипаж — ОТРЯД из squads (Fnd_tank_crew), а не одиночный боец из humans
      // (Fnd_tank_crew_01): тот же словарь, что sysname (cars/tanks/squads/heli)
      crew_sysname: src.units,
      item: src.items,
      shop_preset: src.presets,
    }[spec];
    (ext || []).forEach(v => out.add(v));
  }
  const doc = state.swt._docSrc || {};
  (doc[spec] || []).forEach(v => out.add(v));
  return out.size ? [...out].sort() : null;
}

// словари sysname из species-файлов проекта/игры (бэкенд); при ошибке -
// пустые списки, редактор просто остаётся с текстовым вводом
async function loadSwtSources(path) {
  const empty = { ok: true, units: [], crew: [], upgrades: [], items: [],
                   presets: [], teams: [], car_presets: [], tank_presets: [],
                   squad_presets: [], heli_presets: [],
                   units_car: [], units_tank: [],
                   units_squad: [], units_heli: [], scope_label: "" };
  let reached = false;
  try {
    const r = await api("/api/swt_sources", { method: "POST",
      body: JSON.stringify({
        path,
        project_root: (state.project && state.project.root) || "",
        unpacked_path: state.config.unpacked_path || "",
      }) });
    const j = await r.json();
    reached = true;
    state.swtSources = j && j.ok ? j : empty;
  } catch {
    state.swtSources = empty;
  }
  // маркер «словари построены для этого файла»: только после ДОШЕДШЕГО
  // запроса (упавший не маркируем — при следующем обращении
  // swtEnsureSources попробует снова, а не молчит до кнопки «Анализ»)
  if (reached) {
    try { state.swtSources._forPath = path; } catch {}
  }
  return state.swtSources;
}

// ленивая догрузка словарей при первом обращении к подсказкам: фоновая
// загрузка при открытии могла не успеть/упасть (сервер ещё стартует,
// корни не готовы) — чиним сами, как sysnames обеих карт, а не только
// кнопкой «Анализ». Один полёт на файл (флаг _srcLoading).
function swtEnsureSources() {
  if (state.swt._srcLoading) return state.swt._srcLoading;
  const cur = state.swtSources;
  if (cur && cur._forPath === state.swt.path && state.swt.path)
    return Promise.resolve(true);
  if (!state.swt.path) return Promise.resolve(false);
  state.swt._srcLoading = loadSwtSources(state.swt.path).then(
    () => true, () => false).finally(() => {
      try { state.swt._srcLoading = null; } catch {}
    });
  return state.swt._srcLoading;
}

function swtTab() { return state.tabs.find(tb => tb.id === "swt"); }

function swtMarkDirty() {
  state.swt.dirty = true;
  // страховка от рассинхрона дефолтов (старый объект без стеков): молча чиним
  if (!Array.isArray(state.swt._undo)) state.swt._undo = [];
  if (!Array.isArray(state.swt._redo)) state.swt._redo = [];
  // пошаговый undo: стек post-состояний doc (как в референсном редакторе);
  // файловый undo через историю сохранений работает и раньше, это — отмена
  // последнего ДЕЙСТВИЯ. Вызывается только из мутаций, открытие не пушит.
  const st = state.swt;
  if (st.doc) {
    try {
      st._undo.push(JSON.stringify(st.doc));
      if (st._undo.length > 20) st._undo.shift();
      st._redo.length = 0;
    } catch (e) { /* doc не сериализуется — остаёмся без локального undo */ }
  }
  swtSyncUndoButtons();
  const tb = swtTab();
  if (tb && !tb.dirty) { tb.dirty = true; renderTabBar(); }
}

// начальное post-состояние после открытия (undo первой правки вернёт к нему)
function swtUndoReset() {
  const st = state.swt;
  st._undo = []; st._redo = [];
  if (st.doc) {
    try { st._undo.push(JSON.stringify(st.doc)); } catch (e) { /* noop */ }
  }
  swtSyncUndoButtons();
}

function swtSyncUndoButtons() {
  if (state.activeTabId !== "swt") return;
  const st = state.swt;
  if (!Array.isArray(st._undo)) st._undo = [];
  if (!Array.isArray(st._redo)) st._redo = [];
  setUndoRedoButtons(st._undo.length > 1, st._redo.length > 0);
}

function swtRestoreDoc(json) {
  const st = state.swt;
  st.doc = JSON.parse(json);
  const n = (st.doc ? st.doc.triggers : []).length;
  if (st.sel >= n) st.sel = n - 1;
  st.dirty = true;
  const tb = swtTab();
  if (tb && !tb.dirty) { tb.dirty = true; }
  renderTabBar();
  renderSwtList();
  renderSwtTrigger();
  swtSyncUndoButtons();
}

function swtUndo() {
  const st = state.swt;
  if (!Array.isArray(st._undo)) st._undo = [];
  if (!Array.isArray(st._redo)) st._redo = [];
  if (!st.doc || st._undo.length < 2) { toast(t("undo_none") || "Нечего отменять", ""); return; }
  st._redo.push(st._undo.pop());
  swtRestoreDoc(st._undo[st._undo.length - 1]);
  toast(t("undo") || "Отменено", "ok");
}

function swtRedo() {
  const st = state.swt;
  if (!st.doc || !st._redo.length) { toast(t("redo_none") || "Нечего повторять", ""); return; }
  const json = st._redo.pop();
  st._undo.push(json);
  swtRestoreDoc(json);
  toast(t("redo") || "Повторено", "ok");
}

function swtMarkClean() {
  state.swt.dirty = false;
  const tb = swtTab();
  if (tb) { tb.dirty = false; tb.saved = true; renderTabBar(); }
}

async function openSwt(path) {
  if (!state.tabs.some(tb => tb.id === "swt")) {
    createTab("swt");
    renderTabBar();
  }
  activateTab("swt");
  // открыли файл .swt - дерево автоматически прячется
  // (вернуть можно кнопкой сворачивания сайдбара, как обычно)
  state.sidebarCollapsed = true;
  updateSidebarVisibility();
  if (state.swt.path === path && state.swt.doc) return;
  if (state.swt.dirty) {
    const choice = await askConfirm({
      title: t("unsaved_changes"),
      message: t("close_dirty_confirm"),
      buttons: [
        { id: "save", label: t("save_close") },
        { id: "discard", label: t("close_wo_save"), kind: "danger" },
        { id: "cancel", label: t("cancel"), kind: "ghost" },
      ],
    });
    if (choice === "cancel") return;
    if (choice === "save") { const ok = await swtSaveGuarded(false); if (!ok) return; }
  }
  const r = await api("/api/swt_open", { method: "POST",
    body: JSON.stringify({ path }), timeout: API_TIMEOUT_OPEN });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "error", "err"); return; }
  state.swt = swtFreshState();
  state.swt.path = j.path;
  state.swt.doc = j.doc;
  state.swt.mtime = j.mtime || 0;
  state.swt.fixed = j.fixed || 0;
  state.swt.cmds = j.cmds || [];
  (j.cmds || []).forEach(c => { state.swt.cmdMap[c.name] = c; });
  swtUndoReset();   // undo первой правки вернёт к открытому состоянию
  // кнопка «Анализ» снова доступна (данные нового файла ещё не собраны)
  const anBtn = $("#swt-analyze");
  if (anBtn) {
    anBtn.disabled = false;
    anBtn.classList.remove("done");
    anBtn.title = t("swt_analyze_tt") || "Повторный анализ: пересобрать значения файла и словари проекта";
  }
  const fp = $("#swt-file");
  fp.textContent = j.path;
  fp.title = j.path;
  $("#swt-wrap").hidden = false;
  $("#swt-hint").hidden = true;
  // кнопка «Сохранить» висела в disabled навсегда (сохраняли только Ctrl+S и
  // тулбар) — включаем вместе с кнопками добавления при открытом файле
  $("#swt-save").disabled = false;
  $("#swt-add-trigger").disabled = false;
  $("#swt-add-var").disabled = false;
  if (state.swt.fixed) {
    const hint = $("#swt-hint");
    hint.textContent = (t("swt_fixed") || "Исправлено повторных guid: {n}")
      .replace("{n}", state.swt.fixed);
    hint.hidden = false;
    // автоправка МЕНЯЕТ файл при сохранении — это пользовательское изменение:
    // дискета горит, Ctrl+S «без правок» больше не перепишет файл молча
    swtMarkDirty();
  } else {
    swtMarkClean();
  }
  $("#swt-search").value = "";
  swtAcClose();
  renderSwtList();
  // словари для подсказок (юниты/улучшения/стороны...): качаем в фоне и
  // запоминаем промис - «Анализ» его дождётся; перерисовки здесь нет
  state.swt._srcPromise = loadSwtSources(path);
}

async function swtSaveGuarded(popup) {
  if (!state.swt.path || !state.swt.doc) return false;
  let res = false;
  await guardedSave("swt", state.swt.path, async target => {
    if (target) {
      const j = await saveAsTo(state.swt.path, "swt", target, state.swt.doc);
      if (j.ok && j.saved) {
        swtMarkClean();
        toast((t("saved") || "Сохранено") + " → " + j.dst, "ok");
        // дальше правим копию: переоткрываем редактор на ней
        if (j.dst) {
          // копия могла создать новый раздел древа (напр. dlc/) —
          // перечитываем до открытия, иначе вкладка без строки в древе
          await noteExternalTreeChange(target);
          await openSwt(j.dst);
        }
        res = true;
      }
      else toast(j.error || "error", "err");
      return;
    }
    res = await swtSave();
  }, popup);
  return res;
}

async function swtSave(force) {
  if (!state.swt.path || !state.swt.doc) return false;
  const r = await api("/api/swt_save", { method: "POST",
    body: JSON.stringify({ path: state.swt.path, doc: state.swt.doc,
                           mtime: state.swt.mtime || 0, force: !!force }) });
  const j = await r.json();
  if (!j.ok && j.changed && !force) {
    // файл изменился на диске после открытия (внешний редактор): молча не
    // перезаписываем — спрашиваем, иначе потеря чужих правок
    const c = await askConfirm({
      title: t("swt_changed_title") || "Файл изменился",
      message: (t("swt_changed_msg") ||
        "Файл был изменён вне редактора после открытия. Перезаписать его текущей версией?") +
        "\n\n" + state.swt.path,
      buttons: [
        { id: "ok", label: t("swt_overwrite") || "Перезаписать", kind: "danger" },
        { id: "cancel", label: t("cancel"), kind: "ghost" },
      ],
    });
    if (c === "ok") return swtSave(true);
    return false;
  }
  if (!j.ok) { toast(j.error || "error", "err"); return false; }
  if (j.written === false) { toast(t("swt_no_changes") || "Изменений нет", ""); return true; }
  if (j.mtime) state.swt.mtime = j.mtime;
  swtMarkClean();
  toast(t("saved") || "Сохранено", "ok");
  return true;
}

function swtFilteredTriggers() {
  const q = ($("#swt-search").value || "").toLowerCase().trim();
  const trs = state.swt.doc ? state.swt.doc.triggers : [];
  if (!q) return trs.map((tr, i) => ({ tr, i }));
  return trs.map((tr, i) => ({ tr, i })).filter(({ tr }) => {
    if ((tr.name || "").toLowerCase().includes(q)) return true;
    if (String(tr.guid || "").toLowerCase().includes(q)) return true;
    return (tr.items || []).some(it => (it.name || "").toLowerCase().includes(q));
  });
}

function renderSwtList() {
  renderSwtVars();
  const list = $("#swt-trig-list");
  list.innerHTML = "";
  const rows = swtFilteredTriggers();
  $("#swt-empty") && ($("#swt-empty").hidden = rows.length > 0 || !state.swt.doc);
  rows.forEach(({ tr, i }) => {
    const el = document.createElement("div");
    el.className = "swt-trig" + (i === state.swt.sel ? " sel" : "")
      + (tr.active === "1" ? "" : " off");
    const nm = document.createElement("span");
    nm.className = "swt-trig-name";
    nm.textContent = tr.name || "(без имени)";
    const meta = document.createElement("span");
    meta.className = "swt-trig-meta";
    const nAct = (tr.items || []).filter(x => x.tag === "Action").length;
    const nCond = (tr.items || []).filter(x => x.tag === "Condition").length;
    meta.textContent = `#${tr.guid} · ${nAct}${t("swt_meta_a") || "д"} ${nCond}${t("swt_meta_c") || "у"}`;
    el.append(nm, meta);
    el.title = `${tr.name || ""} — guid ${tr.guid}`;
    el.onclick = () => { state.swt.sel = i; renderSwtList(); renderSwtTrigger(); };
    list.appendChild(el);
  });
  if (!rows.length && state.swt.doc) {
    const none = document.createElement("div");
    none.className = "swt-none";
    none.textContent = t("no_results") || "—";
    list.appendChild(none);
  }
}

// стороны для дропдауна team_name: все фракции игры + найденные в файле
function swtTeamItems() {
  const out = [...SWT_TEAMS];
  ((state.swt._docSrc || {}).team_name || []).forEach(v => {
    if (!out.includes(v)) out.push(v);
  });
  return out.map(v => ({ value: v }));
}

function swtParamRow(value, spec, onChange, onDel, unitTypeOf) {
  const row = document.createElement("div");
  row.className = "swt-param";
  const lab = document.createElement("span");
  lab.className = "swt-param-label";
  lab.textContent = spec && spec.label ? spec.label
    : (spec && spec.spec ? spec.spec : "");
  lab.title = spec && spec.spec ? "[" + spec.spec + "]" : "";
  let inp;
  const isDD = s => s && (s.startsWith("select:") || s === "team_name");
  if (isDD(spec && spec.spec)) {
    // красивый кастомный дропдаун вместо нативного select (в т.ч. стороны:
    // это фракции - меню со всеми вариантами, без поиска)
    const sp = spec.spec;
    const items = sp === "team_name"
      ? () => swtTeamItems()
      : () => sp.slice(7).split(",").map(v => ({ value: v }));
    inp = swtDropdown(value, items, v => onChange(v));
  } else if ((spec && spec.spec) === "variable_name") {
    // trigger variables: короткий красный dropdown со списком переменных файла
    const varNames = (state.swt.doc && state.swt.doc.variables || [])
      .map(v => v.name).filter(Boolean);
    const curV = String(value || "");
    inp = document.createElement("select");
    inp.className = "swt-var-select";
    const optList = varNames.length ? varNames : (curV ? [curV] : [""]);
    optList.forEach(v => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v;
      inp.appendChild(o);
    });
    if (curV && !optList.includes(curV)) {
      const o = document.createElement("option");
      o.value = curV;
      o.textContent = curV + " ?";
      inp.appendChild(o);
    }
    inp.value = curV;
    inp.addEventListener("change", () => onChange(inp.value));
  } else {
    inp = document.createElement("input");
    inp.type = "text";
    inp.value = value;
    inp.spellcheck = false;
    // автодополнение привязываем ВСЕГДА (не только когда словарь уже в
    // памяти): источник динамический - подсказки появятся сразу после
    // фоновой загрузки словарей или после «Анализ», без перерисовки
    const sp = spec && spec.spec ? spec.spec : "";
    if (sp) {
      swtAutocomplete(inp, () => swtSuggestFor(sp, unitTypeOf) || [],
        v => { inp.value = v; onChange(v); });
    }
  }
  if (inp.tagName !== "BUTTON") {
    inp.addEventListener("change", () => onChange(inp.value));
  }
  const del = document.createElement("button");
  del.className = "icon-btn swt-param-del danger";
  del.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  del.title = t("swt_del_param") || "Удалить параметр";
  del.onclick = onDel;
  row.append(lab, inp, del);
  return row;
}

// свернуть/развернуть карточку блока БЕЗ перерисовки всего триггера
// (полная перерисовка на каждый клик давала лаги и дёргания интерфейса)
function swtApplyItemOpen(card, it) {
  const o = !!it._open;
  card.classList.toggle("swt-item-closed", !o);
  const body = card.querySelector(".swt-item-body");
  if (body) body.hidden = !o;
  const chev = card.querySelector(".swt-item-chev");
  if (chev) chev.title = o ? (t("swt_collapse") || "Свернуть")
                           : (t("swt_expand") || "Развернуть");
}

function swtItemCard(tr, it, idx, isCond) {
  const card = document.createElement("div");
  card.className = "swt-item" + (it.disabled === "1" ? " disabled" : "")
    + (it._open ? "" : " swt-item-closed");
  card.__item = it;   // для «развернуть/свернуть все» без перерисовки
  const head = document.createElement("div");
  head.className = "swt-item-head";
  // шеврон сворачивания блока условия/действия
  const chev = document.createElement("button");
  chev.className = "icon-btn swt-item-chev";
  chev.title = it._open ? (t("swt_collapse") || "Свернуть") : (t("swt_expand") || "Развернуть");
  chev.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
  chev.onclick = e => {
    e.stopPropagation();
    it._open = !it._open;
    swtApplyItemOpen(card, it);
  };
  const tag = document.createElement("span");
  tag.className = "swt-item-tag " + (isCond ? "cond" : "act");
  tag.textContent = isCond ? "C" : "A";
  // команда блока: кастомный дропдаун вместо нативного select
  const cmd = swtDropdown(it.name, () => {
    const tp = isCond ? "condition" : "action";
    return state.swt.cmds.filter(c => c.type === tp)
      .map(c => ({ value: c.name, desc: swtCmdText(c) }));
  }, v => {
    const oldSpecLen = swtParamSpec(it.name).length;
    it.name = v;
    const e2 = state.swt.cmdMap[it.name];
    cmd.title = swtCmdText(e2) || it.name;
    const spec = swtParamSpec(it.name);
    // подгоняем число параметров под словарь (сохраняем введённые значения)
    while (it.params.length < spec.length) it.params.push("");
    if (spec.length && it.params.length > Math.max(spec.length, oldSpecLen)) {
      it.params.length = Math.max(spec.length, oldSpecLen);
    }
    it._open = true;   // сменили команду - блок раскрыт для правки
    swtMarkDirty();
    renderSwtTrigger();   // состав параметров изменился - перерисовка
  });
  cmd.title = swtCmdText(state.swt.cmdMap[it.name]) || it.name;
  const guid = document.createElement("input");
  guid.type = "text";
  guid.className = "swt-guid";
  guid.value = it.guid;
  guid.title = "guid";
  guid.spellcheck = false;
  guid.addEventListener("change", () => { it.guid = guid.value.trim(); swtMarkDirty(); });
  const dis = document.createElement("label");
  dis.className = "swt-item-dis";
  const disChk = document.createElement("input");
  disChk.type = "checkbox";
  disChk.checked = it.disabled === "1";
  disChk.addEventListener("change", () => {
    it.disabled = disChk.checked ? "1" : "0";
    // без перерисовки: достаточно погасить карточку классом
    card.classList.toggle("disabled", disChk.checked);
    swtMarkDirty();
  });
  dis.append(disChk, document.createTextNode(t("swt_disabled") || "выкл"));
  const tools = document.createElement("div");
  tools.className = "swt-item-tools";
  const mkBtn = (txt, title, fn) => {
    const b = document.createElement("button");
    b.className = "icon-btn";
    b.innerHTML = txt;
    b.title = title;
    b.onclick = fn;
    return b;
  };
  const up = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  const dn = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>';
  const del = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>';
  tools.append(
    mkBtn(up, t("swt_move_up") || "Выше", () => {
      const arr = isCond
        ? tr.items.filter(x => x.tag === "Condition")
        : tr.items.filter(x => x.tag === "Action");
      const pos = arr.indexOf(it);
      if (pos > 0) {
        const gi = tr.items.indexOf(it);
        const gPrev = tr.items.indexOf(arr[pos - 1]);
        tr.items.splice(gi, 1);
        tr.items.splice(tr.items.indexOf(arr[pos - 1]), 0, it);
        void gi; void gPrev;
        swtMarkDirty(); renderSwtTrigger();
      }
    }),
    mkBtn(dn, t("swt_move_down") || "Ниже", () => {
      const arr = isCond
        ? tr.items.filter(x => x.tag === "Condition")
        : tr.items.filter(x => x.tag === "Action");
      const pos = arr.indexOf(it);
      if (pos > -1 && pos < arr.length - 1) {
        tr.items.splice(tr.items.indexOf(it), 1);
        tr.items.splice(tr.items.indexOf(arr[pos + 1]), 0, it);
        swtMarkDirty(); renderSwtTrigger();
      }
    }),
    mkBtn(del, t("swt_del") || "Удалить", () => {
      tr.items.splice(tr.items.indexOf(it), 1);
      swtMarkDirty(); renderSwtTrigger();
    })
  );
  head.append(chev, tag, cmd, guid, dis, tools);
  head.addEventListener("click", e => {
    // клик по свободному месту шапки тоже сворачивает блок
    if (e.target.closest("input, select, button, label")) return;
    it._open = !it._open;
    swtApplyItemOpen(card, it);
  });
  card.appendChild(head);

  const body = document.createElement("div");
  body.className = "swt-item-body";
  if (!open) body.hidden = true;
  const spec = swtParamSpec(it.name);
  const nSpec = spec.length;
  // индекс поля типа юнита (select с вариантами tank/squad/car/helicopter):
  // пресет улучшения зависит от него - геттер читает ТЕКУЩЕЕ значение,
  // поэтому подсказки верны и сразу после смены типа, без перерисовки
  const typeIdx = spec.findIndex(s => s && s.spec
    && s.spec.startsWith("select:") && /tank|squad/.test(s.spec));
  const unitTypeOf = () => {
    const raw = String(((it.params || [])[typeIdx]) ?? "").replace(/^:/, "");
    if (raw.startsWith("helicopter")) return "helicopter";
    return (raw === "car" || raw === "tank" || raw === "squad") ? raw : "";
  };
  (it.params || []).forEach((val, pi) => {
    const sp = pi < nSpec ? spec[pi] : { label: "param " + (pi + 1) };
    body.appendChild(swtParamRow(val, sp,
      v => { it.params[pi] = v; swtMarkDirty(); },
      () => { it.params.splice(pi, 1); swtMarkDirty(); renderSwtTrigger(); },
      unitTypeOf));
  });
  const addP = document.createElement("button");
  addP.className = "btn swt-add-param";
  addP.textContent = t("swt_add_param") || "+ параметр";
  addP.onclick = () => { it.params.push(""); swtMarkDirty(); renderSwtTrigger(); };
  body.appendChild(addP);
  if (nSpec) {
    const hint = document.createElement("div");
    hint.className = "swt-cmd-hint";
    hint.textContent = swtCmdText(state.swt.cmdMap[it.name]);
    body.appendChild(hint);
  }
  card.appendChild(body);
  // контекстное меню блока: создать новый / дублировать / удалить
  card.addEventListener("contextmenu", e => {
    e.preventDefault();
    e.stopPropagation();
    const mkItem = (name, open) => {
      const spec = swtParamSpec(name);
      return { tag: it.tag, guid: swtNextGuid(it.tag), disabled: "0", name,
               params: spec.map(() => ""), param_tails: null, _open: open };
    };
    openCtxMenu(e, [
      { label: t("swt_ctx_new") || "Создать новый", icon: "add", fn: () => {
          tr.items.splice(tr.items.indexOf(it) + 1, 0, mkItem("", true));
          swtMarkDirty();
          renderSwtTrigger();
        } },
      { label: t("swt_ctx_dup") || "Дублировать", icon: "duplicate", fn: () => {
          const cp = JSON.parse(JSON.stringify(it));
          cp._open = true;
          // дубликат — новый элемент: guid 1:1 дал бы повтор, который fix
          // заметил бы только при следующем открытии (а сохранение записало
          // бы дубликат); назначаем свободный сразу
          if (!("raw" in cp)) cp.guid = swtNextGuid(cp.tag);
          tr.items.splice(tr.items.indexOf(it) + 1, 0, cp);
          swtMarkDirty();
          renderSwtTrigger();
        } },
      { sep: true },
      { label: t("swt_del") || "Удалить", icon: "delete", danger: true, fn: () => {
          tr.items.splice(tr.items.indexOf(it), 1);
          swtMarkDirty();
          renderSwtTrigger();
        } },
    ]);
  });
  return card;
}

// переменные файла (<Variable>): компактный блок в сайдбаре — имени/типа/
// дефолта раньше было не видно и не создать (только триггеры). Переименование
// переменной ссылки в параметрах НЕ правит (как в референсном редакторе).
function renderSwtVars() {
  const box = $("#swt-vars");
  const head = $("#swt-vars-head");
  if (!box) return;
  box.innerHTML = "";
  const vars = state.swt.doc ? state.swt.doc.variables : [];
  // пустой секции в сайдбаре не показываем вовсе (раньше прятался только
  // список, а заголовок висел пустым)
  if (!vars || !vars.length) {
    box.hidden = true;
    if (head) head.hidden = true;
    return;
  }
  box.hidden = swtSecOpen.vars === false;
  if (head) head.hidden = false;
  vars.forEach((v, i) => {
    const row = document.createElement("div");
    row.className = "swt-var-row";
    const nm = document.createElement("input");
    nm.type = "text";
    nm.className = "cm-input swt-var-name";
    nm.value = v.name || "";
    nm.spellcheck = false;
    nm.title = t("swt_var_name_tt") || "Имя переменной";
    nm.addEventListener("change", () => { v.name = nm.value; swtMarkDirty(); });
    const ty = document.createElement("input");
    ty.type = "text";
    ty.className = "cm-input swt-var-type";
    ty.value = v.type || "int";
    ty.spellcheck = false;
    ty.title = "int / bool / string";
    ty.addEventListener("change", () => { v.type = ty.value.trim() || "int"; swtMarkDirty(); });
    const df = document.createElement("input");
    df.type = "text";
    df.className = "cm-input swt-var-def";
    df.value = v.default || "";
    df.spellcheck = false;
    df.title = t("swt_var_def_tt") || "Значение по умолчанию";
    df.addEventListener("change", () => { v.default = df.value; swtMarkDirty(); });
    const del = document.createElement("button");
    del.className = "icon-btn swt-var-del danger";
    del.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    del.title = t("swt_del") || "Удалить";
    del.onclick = async () => {
      const c = await askConfirm({
        title: t("swt_del_var") || "Удалить переменную",
        message: (v.name || "") + "\n" +
          (t("swt_del_var_warn") || "Ссылки в параметрах триггеров сами не обновятся."),
        buttons: [
          { id: "ok", label: t("delete") || "Удалить", kind: "danger" },
          { id: "cancel", label: t("cancel"), kind: "ghost" },
        ],
      });
      if (c !== "ok") return;
      vars.splice(i, 1);
      swtMarkDirty();
      renderSwtList();
    };
    row.append(nm, ty, df, del);
    box.appendChild(row);
  });
}

// новый триггер (дефолты как в референсном редакторе) + новая переменная
function swtAddTrigger() {
  const doc = state.swt.doc;
  if (!doc) return;
  const trs = doc.triggers;
  trs.push({ guid: swtNextGuid("Trigger"), any: "0", active: "1",
             cutsceneActive: "0", extra_attrs: {}, name: "New_Trigger",
             name_tail: "\n", exec_number: "0", exec_tail: "\n",
             items: [], tail: "\n" });
  state.swt.sel = trs.length - 1;
  swtMarkDirty();
  swtSecOpen.trig = true;
  renderSwtList();
  swtSyncSideSec();
  renderSwtTrigger();
  swtFlash($("#swt-trig-list") && $("#swt-trig-list").lastElementChild);
}

function swtAddVar() {
  const doc = state.swt.doc;
  if (!doc) return;
  const used = new Set((doc.variables || []).map(v => v.name));
  let name = "New_Variable", k = 2;
  while (used.has(name)) name = "New_Variable_" + (k++);
  (doc.variables || (doc.variables = [])).push(
    { name, type: "int", default: "0", extra_attrs: {}, tail: "\n" });
  swtMarkDirty();
  swtSecOpen.vars = true;
  renderSwtList();
  swtSyncSideSec();
  const rows = $("#swt-vars") ? $("#swt-vars").querySelectorAll(".swt-var-row") : [];
  swtFlash(rows.length ? rows[rows.length - 1] : null);
}

function renderSwtTrigger() {
  const main = $("#swt-main");
  main.innerHTML = "";
  swtAcClose();   // открытые дропдауны больше не привязаны к DOM
  // значения файла по типам параметров - для подсказок; собираются ОДИН РАЗ
  // кнопкой «Анализ» (полный обход файла на каждый рендер давал лаги)
  if (!state.swt._docSrc) state.swt._docSrc = {};
  const trs = state.swt.doc ? state.swt.doc.triggers : [];
  const tr = trs[state.swt.sel];
  if (!tr) {
    const empty = document.createElement("div");
    empty.className = "swt-empty";
    empty.textContent = t("swt_pick") || "Выберите триггер слева";
    main.appendChild(empty);
    return;
  }
  const head = document.createElement("div");
  head.className = "swt-trig-head";

  const nameInp = document.createElement("input");
  nameInp.type = "text";
  nameInp.className = "swt-name";
  nameInp.value = tr.name || "";
  nameInp.spellcheck = false;
  nameInp.title = t("swt_trig_name_tt") || "Имя триггера";
  nameInp.addEventListener("change", () => { tr.name = nameInp.value; swtMarkDirty(); renderSwtList(); });

  const guidInp = document.createElement("input");
  guidInp.type = "text";
  guidInp.className = "swt-guid";
  guidInp.value = tr.guid || "";
  guidInp.title = t("swt_trig_guid_tt") || "trigger guid";
  guidInp.spellcheck = false;
  guidInp.addEventListener("change", () => { tr.guid = guidInp.value.trim(); swtMarkDirty(); });

  const execInp = document.createElement("input");
  execInp.type = "text";
  execInp.className = "swt-guid";
  execInp.value = tr.exec_number || "";
  execInp.title = t("swt_trig_exec_tt") || "ExecNumber";
  execInp.spellcheck = false;
  execInp.addEventListener("change", () => { tr.exec_number = execInp.value.trim(); swtMarkDirty(); });

  const flags = document.createElement("div");
  flags.className = "swt-flags";
  [["active", "active", "swt_flag_active_tt", "Триггер включён: участвует в миссии"],
   ["any", "any", "swt_flag_any_tt", "Срабатывает при любом из условий"],
   ["cutsceneActive", "cutscene", "swt_flag_cut_tt", "Активен во время катсцены"],
  ].forEach(([key, label, ttKey, ttDef]) => {
    const l = document.createElement("label");
    l.className = "swt-flag";
    l.title = t(ttKey) || ttDef;
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = tr[key] === "1";
    chk.addEventListener("change", () => { tr[key] = chk.checked ? "1" : "0"; swtMarkDirty(); });
    l.append(chk, document.createTextNode(label));
    flags.appendChild(l);
  });

  const delTr = document.createElement("button");
  delTr.className = "btn danger";
  delTr.textContent = t("swt_del_trigger") || "Удалить триггер";
  delTr.onclick = async () => {
    const c = await askConfirm({
      title: t("swt_del_trigger") || "Удалить триггер",
      message: (tr.name || "") + " #" + tr.guid,
      buttons: [
        { id: "ok", label: t("delete") || "Удалить", kind: "danger" },
        { id: "cancel", label: t("cancel"), kind: "ghost" },
      ],
    });
    if (c !== "ok") return;
    trs.splice(state.swt.sel, 1);
    state.swt.sel = -1;
    swtMarkDirty();
    renderSwtList();
    renderSwtTrigger();
  };

  head.append(nameInp, guidInp, execInp, flags, delTr);
  main.appendChild(head);
  // подсказка по имени триггера, если похоже на известный шаблон
  const th = swtTrigHint(tr.name);
  if (th) {
    const hd = document.createElement("div");
    hd.className = "swt-name-hint";
    hd.textContent = th;
    main.appendChild(hd);
  }

  // секции «Условия» и «Действия»: сворачиваемые блоки (шеврон в заголовке);
  // сворачивание переключает DOM напрямую, без перерисовки секции
  const mkSec = (title, open, onFlip, children) => {
    const headEl = document.createElement("div");
    headEl.className = "swt-sec-head" + (open ? "" : " swt-sec-closed");
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
      onFlip(open);
      apply();
    };
    chev.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
    chev.onclick = e => { e.stopPropagation(); flip(); };
    const ttl = document.createElement("span");
    ttl.textContent = title;
    headEl.append(chev, ttl);
    children.forEach(ch => headEl.appendChild(ch));
    headEl.addEventListener("click", e => {
      if (e.target.closest("input, select, button, label, .swt-cmd-combo")) return;
      flip();
    });
    return { headEl, bodyEl };
  };

  // поле добавления с автодополнением: нейтральное пустое значение (список
  // показывает ВСЕ команды, ввод фильтрует), выбор сбрасывает поле
  const mkAddCombo = (ph, type) => {
    // поле добавления: кастомный дропдаун со всеми командами этого типа
    // (поиск по вводу, описание под именем, выбор мышью/Enter); нейтральное
    // пустое значение - после добавления поле сбрасывается
    const wrap = document.createElement("div");
    wrap.className = "swt-cmd-combo swt-add-cmd";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "swt-cmd-inp";
    inp.placeholder = ph;
    inp.spellcheck = false;
    const pick = v => {
      if (!state.swt.cmds.some(c => c.name === v && c.type === type)) return;
      inp.value = "";   // сброс к нейтральному после добавления
      onAdd(type, v);
    };
    swtAutocomplete(inp,
      () => state.swt.cmds.filter(c => c.type === type)
        .map(c => ({ value: c.name, desc: swtCmdText(c) })),
      pick);
    // набрал имя целиком и ушёл из поля - тоже добавляем
    inp.addEventListener("change", () => {
      const v = inp.value.trim();
      if (v) pick(v);
    });
    wrap.append(inp);
    return wrap;
  };

  const onAdd = (kind, name) => {
    const spec = swtParamSpec(name);
    const tag = kind === "condition" ? "Condition" : "Action";
    const rec = { tag, guid: swtNextGuid(tag), disabled: "0", name,
                    params: spec.map(() => ""), param_tails: null,
                    _open: true };
    // новое условие — перед первым действием (порядок Cond→Act как в файлах
    // игры), действия — в конец; раньше всё падало в общий конец
    if (tag === "Condition") {
      const idx = tr.items.findIndex(x => x.tag === "Action");
      if (idx === -1) tr.items.push(rec); else tr.items.splice(idx, 0, rec);
    } else {
      tr.items.push(rec);
    }
    swtMarkDirty();
    renderSwtTrigger();
    // новый блок может оказаться ниже видимой области - показываем его
    requestAnimationFrame(() => {
      const body = main.querySelector(".swt-sec-body:not([hidden])");
      const last = body && body.lastElementChild;
      if (last) last.scrollIntoView({ block: "nearest" });
    });
  };

  const mkAllBtn = (expand, kind) => {
    const b = document.createElement("button");
    b.className = "icon-btn swt-sec-all";
    b.title = expand ? (t("swt_expand_all") || "Развернуть все") : (t("swt_collapse_all") || "Свернуть все");
    b.innerHTML = expand
      ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6M6 20l6-6 6 6"/></svg>'
      : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6M6 4l6 6 6-6"/></svg>';
    b.onclick = () => {
      const tp = kind === "condition" ? "Condition" : "Action";
      tr.items.forEach(it => { if (it.tag === tp) it._open = expand; });
      // синхронизируем карточки своей секции напрямую, без перерисовки
      const secHead = b.closest(".swt-sec-head");
      const bodyEl = secHead && secHead.nextElementSibling;
      if (bodyEl) bodyEl.querySelectorAll(".swt-item").forEach(c => {
        if (c.__item) swtApplyItemOpen(c, c.__item);
      });
    };
    return b;
  };

  // условия
  const condSec = mkSec(t("swt_conditions") || "Условия",
    state.swt.condOpen,
    v => { state.swt.condOpen = v; },
    [mkAddCombo(t("swt_add_cond_ph") || "+ условие…", "condition"),
     mkAllBtn(true, "condition"), mkAllBtn(false, "condition")]);
  main.appendChild(condSec.headEl);
  tr.items.filter(x => x.tag === "Condition").forEach(it => {
    condSec.bodyEl.appendChild(swtItemCard(tr, it, tr.items.indexOf(it), true));
  });
  main.appendChild(condSec.bodyEl);

  // действия
  const actSec = mkSec(t("swt_actions") || "Действия",
    state.swt.actOpen,
    v => { state.swt.actOpen = v; },
    [mkAddCombo(t("swt_add_act_ph") || "+ действие…", "action"),
     mkAllBtn(true, "action"), mkAllBtn(false, "action")]);
  main.appendChild(actSec.headEl);
  tr.items.filter(x => x.tag === "Action").forEach(it => {
    actSec.bodyEl.appendChild(swtItemCard(tr, it, tr.items.indexOf(it), false));
  });
  main.appendChild(actSec.bodyEl);
}

// ---------- Поиск по телу SWT-редактора (общий попап) ----------
// Ищет по всему содержимому файла: имя/guid триггера, условия и действия
// (команды + guid) и все их параметры (слоты и значения). Найденное
// раскрывает, скроллит к строке параметра и подсвечивает.
let swtFind = null;        // попап (создаётся в setupSwtFind)
let swtFindHits = [];      // [{tr, item, pi, text}] — item/pi null(-1) = сам триггер
let swtFindIdx = 0;

function swtFindCorpus() {
  const doc = state.swt.doc;
  const out = [];
  if (!doc) return out;
  doc.triggers.forEach(tr => {
    out.push({ tr, item: null, pi: -1,
      text: [tr.name, tr.guid, tr.exec_number]
        .map(x => String(x || "").toLowerCase()).join(" ") });
    (tr.items || []).forEach(it => {
      const spec = swtParamSpec(it.name);
      out.push({ tr, item: it, pi: -1,
        text: [it.tag === "Condition" ? "condition" : "action", it.name, it.guid]
          .map(x => String(x || "").toLowerCase()).join(" ") });
      (it.params || []).forEach((v, pi) => {
        const sp = pi < spec.length ? spec[pi] : null;
        out.push({ tr, item: it, pi,
          text: [sp && sp.spec, sp && sp.label, v]
            .map(x => String(x || "").toLowerCase()).join(" ") });
      });
    });
  });
  return out;
}

function swtFindCompute(q) {
  swtFindHits = [];
  swtFindIdx = 0;
  const s = String(q || "").toLowerCase().trim();
  if (!s) return;
  swtFindCorpus().forEach(h => {
    if (h.text.includes(s)) swtFindHits.push(h);
  });
}

function swtFindStep(d) {
  const n = swtFindHits.length;
  if (!n) return;
  swtFindIdx = (swtFindIdx + d + n) % n;
  swtFind.setCount(swtFindIdx, n);
  swtFindJump(swtFindHits[swtFindIdx]);
}

function swtFindJump(m) {
  if (!m) return;
  const trs = state.swt.doc ? state.swt.doc.triggers : [];
  const ti = trs.indexOf(m.tr);
  if (ti < 0) return;
  state.swt.sel = ti;
  if (m.item) {
    // секция и карточка раскрываются до отрисовки
    if (m.item.tag === "Condition") state.swt.condOpen = true;
    else state.swt.actOpen = true;
    m.item._open = true;
  }
  renderSwtList();
  renderSwtTrigger();
  const main = $("#swt-main");
  let target = null;
  if (m.item) {
    const card = $$(".swt-item", main).find(c => c.__item === m.item);
    if (card) {
      if (m.pi >= 0) {
        const rows = card.querySelectorAll(".swt-item-body .swt-param");
        target = rows[m.pi] || card;
      } else {
        target = card.querySelector(".swt-item-head") || card;
      }
    }
  } else {
    target = main.querySelector(".swt-trig-head");
  }
  if (target) {
    target.scrollIntoView({ block: "center" });
    target.classList.add("find-flash");
    setTimeout(() => target.classList.remove("find-flash"), 1500);
  }
}

function setupSwtFind() {
  const host = $("#swt-wrap");
  if (!host) return;
  swtFind = mkFindBar({
    host,
    cls: "swt-find-pop",
    withReplace: false,
    onQuery: q => {
      swtFindCompute(q);
      swtFind.setCount(swtFindIdx, swtFindHits.length);
      swtFindJump(swtFindHits[swtFindIdx]);
    },
    onStep: d => swtFindStep(d),
  });
}

// ---------- Универсальный полноэкранный режим страницы/вкладки ----------
// Один механизм на всё приложение: на нужной странице вешаешь кнопку и
// вызываешь paneFsToggle(элемент страницы). Развёрнутый элемент фиксируется
// на весь экран, окно программы (pywebview) тоже раскрывается на весь
// монитор. Повторное нажатие кнопки («на весь экран») или Esc возвращает
// маленькое окно. Используется: SWT-редактор, панели сравнения.
let paneFsEl = null;        // развёрнутый сейчас элемент
let paneFsWindowFs = false; // окно сейчас в системном fullscreen (pywebview)

function paneFsWinFs(on) {
  if (on === paneFsWindowFs) return;
  if (window.pywebview && pywebview.api && pywebview.api.toggle_fullscreen) {
    try { pywebview.api.toggle_fullscreen(); paneFsWindowFs = !!on; } catch (e) { /* noop */ }
  }
}

function paneFsEnter(el) {
  if (!el || paneFsEl === el) return;
  paneFsExit();
  paneFsEl = el;
  el.classList.add("pane-fs-target");
  document.body.classList.add("pane-fs");
  paneFsWinFs(true);
  nudgeRepaint();
}

function paneFsExit() {
  if (!paneFsEl) return;
  const el = paneFsEl;
  paneFsEl = null;
  el.classList.remove("pane-fs-target");
  document.body.classList.remove("pane-fs");
  paneFsWinFs(false);
  // странице может понадобиться доработать выход (вернуть панели на место)
  if (typeof el.__fsOnExit === "function") { try { el.__fsOnExit(); } catch (e) { /* noop */ } }
  nudgeRepaint();
}

function paneFsToggle(el) {
  if (paneFsEl === el) paneFsExit(); else paneFsEnter(el);
}

// Esc возвращает маленькое окно - один слушатель на все страницы.
// Открытая модалка выше fullscreen: Esc достаётся ей (закрытие —
// в обработчике модалок), а не сворачиванию панели
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && paneFsEl) {
    if (document.querySelector(".modal:not([hidden])")) return;
    paneFsExit();
  }
});

// состояние сворачиваемых секций сайдбара SWT (живёт вне state.swt —
// тот пересоздаётся при каждом открытии файла)
const swtSecOpen = { trig: true, vars: true };

function swtSideSec(headSel, bodySel, key) {
  const head = $(headSel), body = $(bodySel);
  if (!head || !body) return;
  swtSyncSideSec();
  head.addEventListener("click", e => {
    if (e.target.closest("input, select, button:not(.swt-sec-chev), label")) return;
    swtSecOpen[key] = !(swtSecOpen[key] !== false);
    swtSyncSideSec();
  });
}

// состояние заголовков/тел секций сайдбара из swtSecOpen (пустой vars
// управляется renderSwtVars отдельно)
function swtSyncSideSec() {
  [["#swt-trig-head", "#swt-trig-list", "trig"],
   ["#swt-vars-head", "#swt-vars", "vars"]].forEach(([hs, bs, k]) => {
    const head = $(hs), body = $(bs);
    if (!head || !body) return;
    const open = swtSecOpen[k] !== false;
    head.classList.toggle("swt-sec-closed", !open);
    if (k === "vars" && !body.children.length) return; // пустой — скрыт
    body.hidden = !open;
  });
}

// вспышка нового элемента: докрутить и подсветить акцентом
function swtFlash(el) {
  if (!el || !el.scrollIntoView) return;
  try { el.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (e) { /* noop */ }
  el.classList.remove("swt-flash");
  void el.offsetWidth;
  el.classList.add("swt-flash");
}

function setupSwt() {
  $("#swt-save").onclick = () => swtSaveGuarded(false);
  const addTr = $("#swt-add-trigger");
  if (addTr) addTr.onclick = () => swtAddTrigger();
  const addVar = $("#swt-add-var");
  if (addVar) addVar.onclick = () => swtAddVar();
  // сворачиваемые секции сайдбара — как «Условия»/«Действия» в триггере
  swtSideSec("#swt-trig-head", "#swt-trig-list", "trig");
  swtSideSec("#swt-vars-head", "#swt-vars", "vars");
  $("#swt-search").addEventListener("input", renderSwtList);
  // «Анализ»: один раз собирает значения файла (swtDocSources) и дожидается
  // словарей проекта/игры - подсказки параметров начинают работать. Больше
  // не вызывается до открытия другого файла, поэтому ничего не лагает.
  const anBtn = $("#swt-analyze");
  if (anBtn) anBtn.onclick = async () => {
    // базовые подсказки (словари юнитов/техники) грузятся сами при открытии
    // файла - кнопка делает ПОВТОРНЫЙ анализ: свежие словари + значения файла
    if (!state.swt.path || anBtn.classList.contains("busy")) return;
    anBtn.disabled = true;
    anBtn.classList.add("busy");
    try {
      const sj = await loadSwtSources(state.swt.path);
      state.swt._srcPromise = Promise.resolve();
      state.swt._docSrc = swtDocSources();
      state.swt._analyzed = true;
      renderSwtTrigger();
      anBtn.classList.add("done");
      // скоп словарей виден сразу: DLC Resistance или base
      const scope = (sj && sj.scope_label) ? " · " + sj.scope_label : "";
      toast((t("swt_analyze_done") || "Анализ завершён: подсказки заполнены") + scope, "ok");
    } catch (e) {
      toast(String(e), "err");
    } finally {
      anBtn.classList.remove("busy");
      anBtn.disabled = false;   // снова доступна для повторного нажатия
      anBtn.title = t("swt_analyze_tt") || "";
    }
  };
  // полноэкранный режим редактора: универсальный механизм (кнопка в
  // развёрнутом виде возвращает маленькое окно, Esc работает)
  const fsBtn = $("#swt-fs");
  if (fsBtn) fsBtn.onclick = () => paneFsToggle($("#swt-wrap").closest(".swt-page"));
}

