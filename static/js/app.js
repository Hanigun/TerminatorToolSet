/* Terminator Sheet frontend.
   Renders the SpreadsheetML grid, project tree, comparator and all controls.
   Talks to the Flask backend via JSON API. */
"use strict";

const state = {
  config: {},
  i18n: {},
  lang: "ru",
  currentFile: null,        // {path, sheet_index, sheet_name, sheets, columns, comments, rows}
  project: null,
  bootLoading: false,     // фоновая загрузка проекта прошлого запуска ещё идёт
  selectedRow: null,        // 0-based data-row index
  selCell: null,            // focused cell {r, c} for type-over editing
  histBusy: false,          // an undo/redo request is in flight
  dirty: false,
  links: [],                // [{row,col,value,target_file,target_row}]
  filterText: "",
  // compare
  compare: null,
  cmpFilter: "all",
  cmpSel: { left: null, right: null }, // focused preview cell per side {r, c}
  cmpLastSide: null,                   // side of the last focused preview cell
  cmpPrevLimit: { left: 0, right: 0 }, // rows rendered per preview pane
  cmpSearch: { left: "", right: "" },  // per-side search box text (independent)
  cmpVisIdx: { left: null, right: null }, // per-side filtered row indices (null = all)
  cmpKeyCol: -1,            // selected key column (-1 = all keys / default key)
  cmpKeyItems: [],          // key dropdown options [{v, label}]
  // UI state
  sidebarCollapsed: false,
  sidebarWidth: 320,
  treeCollapsed: {},        // "overlay::category" -> true
  treeFilter: "",
  treeSel: new Set(),       // tree multi-selection paths (ctrl+click)
  editedFiles: new Set(),   // project files edited & saved by us (lowercase abs paths)
  fullTree: null,           // {n, d:[], f:[]} full project tree from /api/project_tree
  gameTree: null,           // tree of unpacked game assets (tab «Игра»)
  modTree: null,            // tree of the main mod folder (tab «Мод», config.mod_path)
  swt: swtFreshState(),
  swtSources: null,         // словари для подсказок SWT (/api/swt_sources), null = нет
  uprising: uprFreshState(),
  treeView: "project",      // глобальный источник: project | game | mod (древо + карта)
  cmpSrc: { left: null, right: null }, // источники сторон сравнения: по умолчанию ничего не выбрано
  treeExtFilter: null,      // null = show all; Set of lowercase exts to SHOW
  treeFolderFilter: null,   // null = show all; Set of lowercase folder names to SHOW
  fullTreeExpanded: new Set(),   // absolute dir paths the user forced open
  fullTreeCollapsed: new Set(),  // absolute dir paths the user forced closed
  treeCounts: null,         // {exts: Map, folders: Map} from the full tree
  clipboard: null,          // last copied cell value (context menu paste)
  treeClip: null,           // скопированный в дереве путь (контекстное меню)
  // Tabs
  tabs: [],                 // [{id, type, title, path, fileData, dirty, sheetIndex}]
  activeTabId: "welcome",
  tabCounter: 0,
  nameMap: {},              // sysname -> display name (localization)
  colSel: null,             // selected column index (double-click on header)
  // Grid virtualization (active tab only)
  visRows: [],
  gridRenderLimit: 0,
  // Find & Replace
  find: { active: false, q: "", matches: [], idx: 0, keySet: new Set() },
};

const GRID_CHUNK = 150;

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

const API_TIMEOUT_DEFAULT = 60000;   // обычные запросы
const API_TIMEOUT_OPEN = 300000;     // тяжёлые: open_project / open_file / compare

function reportClientError(kind, message, extra) {
  // ошибки фронта -> общий лог бэкенда (logs/app.log); консоль часто не видна.
  // сырой fetch без логирования ошибок - не создаём рекурсию, когда сервер недоступен
  try {
    const payload = JSON.stringify({ kind, message: String(message || "").slice(0, 500), extra: extra || {} });
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/client_log", new Blob([payload], { type: "application/json" }));
    } else {
      fetch("/api/client_log", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: payload }).catch(() => {});
    }
  } catch (e) { /* noop - сами не падаем */ }
}

async function api(path, opts) {
  const opt = Object.assign({ headers: { "Content-Type": "application/json" } }, opts);
  const timeout = opt.timeout || API_TIMEOUT_DEFAULT;
  const isGet = !opt.method || opt.method === "GET";
  const attempt = async () => {
    const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
    try {
      if (ctrl) opt.signal = ctrl.signal;
      return await fetch(path, opt);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const t0 = performance.now();
  try {
    const r = await attempt();
    const ms = performance.now() - t0;
    if (ms > 2000) console.warn("[api] slow", path, Math.round(ms) + "ms");
    return r;
  } catch (e) {
    // таймаут показываем понятно (не голым "Failed to fetch")
    if (e && (e.name === "AbortError" || /aborted/i.test(String(e.message)))) {
      const te = new Error("timeout: сервер не ответил за " + Math.round(timeout / 1000) + "с (" + path + ")");
      te.isTimeout = true;
      reportClientError("network", te.message);
      throw te;
    }
    // сеть/сервер недоступны: GET один раз повторяем - часть сбоев лечится
    // сама (гонка старта, короткий сбой сервера)
    if (isGet && !opt.noRetry) {
      try { return await attempt(); } catch (e2) {
        reportClientError("network", "api " + path + " failed twice: " + (e2 && e2.message));
        throw e2;
      }
    }
    reportClientError("network", "api " + path + " failed: " + (e && e.message));
    throw e;
  }
}

// маяк прогресса запуска для лаунчера: тихо, без ожиданий (не тормозит старт)
function bootPing(pct, label) {
  try {
    fetch("/api/boot_progress", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pct, label: label || "" }) }).catch(() => {});
  } catch (e) { /* сервер ещё не готов */ }
}

// ---------- i18n ----------
async function loadI18n() {
  const r = await api(`/api/i18n`);
  state.i18n = await r.json();
  applyI18n();
}

function t(key) {
  return state.i18n[key] !== undefined ? state.i18n[key] : key;
}

function applyI18n() {
  $$("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  $$("[data-i18n-ph]").forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  $$("[data-i18n-title]").forEach(el => { el.title = t(el.dataset.i18nTitle); });
  document.documentElement.lang = state.lang;
  // keep the native window title in sync with the UI language
  document.title = t("app_title");
}

// WebView2 quirk: areas under pywebview-drag-region (the topbar with the
// brand) stop repainting after DOM changes until the window is minimized.
// Force a repaint whenever the language changes.
function nudgeRepaint() {
  const bar = document.querySelector(".topbar");
  if (!bar) return;
  bar.style.display = "none";
  void bar.offsetHeight;
  bar.style.display = "";
}

// ---------- toast ----------
let toastTimer = null;
function toast(msg, kind) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast " + (kind || "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

// ---------- универсальное контекстное меню ----------
// (дерево, вкладки, блоки SWT: пункты задаются списком, стили общие .ctx-menu)
let ctxMenuEl = null;
function closeCtxMenu() {
  if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
}
// иконки динамических контекстных меню (вкладки, дерево, SWT, карта):
// статичное меню таблицы уже несёт .ctx-ico в шаблоне
const _CTX_SVG = inner => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
const CTX_ICONS = {
  save: _CTX_SVG('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>'),
  revert: _CTX_SVG('<path d="M9 14 4 9l5-5"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>'),
  "to-mod": _CTX_SVG('<path d="M4 20h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-8L9.6 4.6A2 2 0 0 0 8.2 4H4a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1z"/><path d="M12 10v6"/><path d="M9 13h6"/>'),
  copy: _CTX_SVG('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  paste: _CTX_SVG('<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>'),
  cut: _CTX_SVG('<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>'),
  duplicate: _CTX_SVG('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/><path d="M15.5 12.5v6M12.5 15.5h6"/>'),
  add: _CTX_SVG('<path d="M12 5v14M5 12h14"/>'),
  edit: _CTX_SVG('<path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z"/>'),
  delete: _CTX_SVG('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  swap: _CTX_SVG('<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="M16 21l4-4-4-4"/><path d="M20 17H4"/>'),
};
function openCtxMenu(e, items) {
  e.preventDefault();
  closeCtxMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  items.forEach(it => {
    if (!it) return;
    if (it.sep) {
      const s = document.createElement("div");
      s.className = "ctx-sep";
      menu.appendChild(s);
      return;
    }
    const b = document.createElement("div");
    b.className = "ctx-item" + (it.danger ? " danger" : "")
      + (it.disabled ? " disabled" : "");
    b.innerHTML = (it.icon && CTX_ICONS[it.icon]
      ? '<span class="ctx-ico">' + CTX_ICONS[it.icon] + '</span>' : "")
      + '<span>' + escapeHtml(it.label) + '</span>';
    menu.appendChild(b);
    if (!it.disabled && it.fn) {
      b.addEventListener("click", () => { closeCtxMenu(); it.fn(); });
    }
  });
  document.body.appendChild(menu);
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(e.clientX, window.innerWidth - mw - 8) + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - mh - 8) + "px";
  ctxMenuEl = menu;
}
document.addEventListener("mousedown", e => {
  if (ctxMenuEl && !ctxMenuEl.contains(e.target)) closeCtxMenu();
}, true);
window.addEventListener("blur", closeCtxMenu);

// ---------- файловые операции контекстного меню дерева/вкладок ----------
// вставка/дублирование через /api/fs_copy; «скопировать в мод» - /api/copy_to_mod
async function fsCopyTo(src, dstDir) {
  const r = await api("/api/fs_copy", { method: "POST",
    body: JSON.stringify({ src, dst_dir: dstDir }) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "error", "err"); return null; }
  toast(t("ctx_copied") || "Скопировано", "ok");
  // новое файловое дерево подтянем со свежим сканом
  await loadFullTree();
  renderTree();
  return j.path;
}

async function copyToMod(src) {
  try {
    const r = await api("/api/copy_to_mod", { method: "POST",
      body: JSON.stringify({ src,
        project_root: (state.project && state.project.root) || "" }) });
    const j = await r.json();
    if (j.ok) {
      toast((t("ctx_to_mod_done") || "Скопировано в мод") + ": " + j.path, "ok");
      return;
    }
    if (j.error === "no_mod_path") {
      toast(t("ctx_no_mod_path") || "Укажите путь к моду в настройках", "err");
      return;
    }
    toast(j.error || "error", "err");
  } catch (e) { toast(String(e), "err"); }
}

function treeParentDir(path) {
  // для папки вставляем В НЕЁ, для файла - рядом (в её папку)
  const trimmed = String(path || "").replace(/[\\/]+$/, "");
  const parent = trimmed.replace(/[\\/][^\\/]+$/, "");
  return parent || trimmed;
}

// контекстное меню вкладки: сохранить / отменить все изменения / в мод
function bindTabCtxMenu() {
  const bar = $("#tab-bar-inner");
  if (!bar) return;
  bar.addEventListener("contextmenu", e => {
    const el = e.target.closest(".tab");
    if (!el) return;
    const tab = state.tabs.find(x => x.id === el.dataset.tabId);
    if (!tab) return;
    const items = [];
    if (tab.type === "file" || tab.type === "swt" || tab.type === "uprising") {
      items.push({ label: t("save") || "Сохранить", icon: "save", fn: async () => {
        activateTab(tab.id);
        await saveActive();
      } });
    }
    if (tab.type === "file" && tab.path) {
      items.push({ label: t("ctx_revert") || "Отменить все изменения", icon: "revert", fn: async () => {
        // сброс к файлу на диске: закрыть вкладку без сохранения и открыть
        // заново с reset - серверная сессия тоже отбрасывается
        tab.dirty = false;
        closeTab(tab.id);
        await openFile(tab.path, { reset: true });
      } });
    }
    if (tab.type === "swt" && state.swt.path) {
      items.push({ label: t("ctx_revert") || "Отменить все изменения", icon: "revert", fn: async () => {
        // doc=null обходит «уже открыт» - файл перечитывается с диска;
        // dirty=false убирает подтверждение (пользователь сам просил сброс)
        state.swt.doc = null;
        state.swt.dirty = false;
        await openSwt(state.swt.path);
      } });
    }
    if (tab.type === "uprising" && state.uprising.path) {
      items.push({ label: t("ctx_revert") || "Отменить все изменения", icon: "revert", fn: async () => {
        state.uprising.dirty = false;
        await uprLoad(true);
      } });
    }
    const modSrc = tab.type === "swt" ? state.swt.path
      : tab.type === "uprising" ? state.uprising.path : tab.path;
    if (modSrc) {
      if (items.length) items.push({ sep: true });
      items.push({ label: t("ctx_to_mod") || "Скопировать в мод", icon: "to-mod",
        fn: () => copyToMod(modSrc) });
    }
    if (items.length) openCtxMenu(e, items);
  });
}

// контекстное меню дерева: копировать / вставить / дублировать / в мод
function bindTreeCtxMenu() {
  const tree = $("#project-tree");
  if (!tree) return;
  tree.addEventListener("contextmenu", e => {
    const row = e.target.closest(".tree-dir, .tree-file");
    if (!row) return;
    const path = row.dataset.path;
    if (!path) return;
    const isDir = row.classList.contains("tree-dir");
    openCtxMenu(e, [
      { label: t("ctx_copy") || "Копировать", icon: "copy",
        fn: () => { state.treeClip = { path }; toast(t("ctx_copied") || "Скопировано"); } },
      { label: t("ctx_paste") || "Вставить", icon: "paste", disabled: !state.treeClip,
        fn: () => fsCopyTo(state.treeClip.path, isDir ? path : treeParentDir(path)) },
      { sep: true },
      { label: t("ctx_duplicate") || "Дублировать", icon: "duplicate",
        fn: () => fsCopyTo(path, treeParentDir(path)) },
      { label: t("ctx_to_mod") || "Скопировать в мод", icon: "to-mod", fn: () => copyToMod(path) },
    ]);
  });
}

// ---------- in-app confirm dialog (replaces the browser confirm()) ----------
function askConfirm(opts) {
  return new Promise(resolve => {
    const modal = $("#confirm-modal");
    $("#confirm-title").textContent = opts.title || t("confirm");
    $("#confirm-msg").textContent = opts.message || "";
    const box = $("#confirm-actions");
    box.innerHTML = "";
    (opts.buttons || [{ id: "ok", label: "OK" }]).forEach(b => {
      const btn = document.createElement("button");
      btn.className = "btn " + (b.kind || "");
      btn.textContent = b.label;
      btn.onclick = () => { modal.hidden = true; resolve(b.id); };
      box.appendChild(btn);
    });
    modal.hidden = false;
    // backdrop click = cancel
    modal.onclick = e => {
      if (e.target === modal) { modal.hidden = true; resolve("cancel"); }
    };
  });
}

// In-app replacement for the browser prompt(): a small modal with a text
// input. Resolves with the entered string or null on cancel.
function askPrompt(opts) {
  return new Promise(resolve => {
    const modal = $("#prompt-modal");
    const input = $("#prompt-input");
    $("#prompt-title").textContent = opts.title || "";
    input.value = opts.value || "";
    input.placeholder = opts.placeholder || "";
    const box = $("#prompt-actions");
    box.innerHTML = "";
    [
      { id: "cancel", label: t("cancel"), kind: "ghost" },
      { id: "ok", label: opts.okLabel || "OK", kind: "accent" },
    ].forEach(b => {
      const btn = document.createElement("button");
      btn.className = "btn " + (b.kind || "");
      btn.textContent = b.label;
      btn.onclick = () => { modal.hidden = true; resolve(b.id === "ok" ? input.value.trim() : null); };
      box.appendChild(btn);
    });
    modal.hidden = false;
    modal.onclick = e => { if (e.target === modal) { modal.hidden = true; resolve(null); } };
    const submit = e => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      modal.hidden = true;
      document.removeEventListener("keydown", submit);
      resolve(input.value.trim());
    };
    document.addEventListener("keydown", submit);
    setTimeout(() => input.focus(), 30);
  });
}

// ---------- views / tabs ----------
function toggleSidebar() {
  // единый путь сворачивания: кнопка в шапке дерева, фаб и горячая клавиша
  // (Ctrl+B по умолчанию) - чтобы класс .collapsed не рассинхронился
  state.sidebarCollapsed = !state.sidebarCollapsed;
  $("#sidebar").classList.toggle("collapsed", state.sidebarCollapsed);
  updateSidebarVisibility();
}

function updateSidebarVisibility() {
  // compare & unpacker & uprising pages: full window width, no sidebar.
  // SWT-страница остаётся с сайдбаром: там нужно дерево с фильтром .swt
  const onWide = state.activeTabId === "compare" || state.activeTabId === "unpacker"
    || state.activeTabId === "uprising";
  // древо видно и без открытого проекта — по «Игре»/«Моду», если пути заданы
  const hasProject = (!!(state.project && state.project.files && state.project.files.length)
    || srcAvail("game") || srcAvail("mod")) && !onWide;
  $("#sidebar").hidden = !hasProject;
  // класс .collapsed обязателен: без него min-width:220px не даст sidebar-у
  // схлопнуться в 0 (симптом: авто-скрытие прячет дерево лишь наполовину)
  $("#sidebar").classList.toggle("collapsed", state.sidebarCollapsed);
  $("#sidebar-resizer").hidden = !hasProject || state.sidebarCollapsed;
  $("#tree-toolbar").hidden = !hasProject || state.sidebarCollapsed;
  updateSidebarTabs();
  hideTreeFilterMenu();
  document.body.classList.toggle("has-sidebar", hasProject);

  if (hasProject) {
    const w = state.sidebarCollapsed ? 0 : state.sidebarWidth;
    document.documentElement.style.setProperty("--sidebar-w", w + "px");
  } else {
    document.documentElement.style.setProperty("--sidebar-w", "0px");
  }
  const fab = $("#sidebar-fab");
  if (fab) fab.hidden = !(hasProject && state.sidebarCollapsed);
}

function createTabElement(tab, flashSaved) {
  const el = document.createElement("div");
  el.className = "tab" + (tab.id === state.activeTabId ? " active" : "");
  el.dataset.tabId = tab.id;
  el.setAttribute("role", "tab");
  el.setAttribute("aria-selected", tab.id === state.activeTabId);
  const closable = tab.type !== "welcome";
  // индикатор несохранённых изменений: красная дискета; только что
  // сохранённая вкладка получает зелёную вспышку с исчезновением
  const dirtyBadge = tab.dirty
    ? `<span class="tab-badge dirty tab-dirty-floppy" title="${escapeHtml(t("unsaved"))}">${FLOPPY_SVG}</span>`
    : (flashSaved ? `<span class="tab-badge dirty tab-dirty-floppy saved-flash" title="">${FLOPPY_SVG}</span>` : "");
  el.innerHTML = `
    <span class="tab-icon-box">${iconHtml(tab.icon, "📄")}</span>
    <span class="tab-text">
      <span class="tab-title-row">
        <span class="tab-title" title="${escapeHtml(tab.path || tab.title)}">${escapeHtml(tab.title)}</span>
        ${tab.type === "file" && tab.origin ? `<span class="tab-origin${tab.origin === "game" ? " is-game" : (tab.origin === "mod" ? " is-mod" : "")}" title="${escapeHtml(tab.origin === "game" ? t("origin_game") : (tab.origin === "mod" ? t("origin_mod") : t("origin_project")))}">${tab.origin === "game" ? GAMEPAD_SVG : (tab.origin === "mod" ? MOD_SVG : FOLDER_SVG)}</span>` : ""}
        ${tab.saved ? `<span class="tab-saved" title="${escapeHtml(t("edited_hint") || "Файл сохранён в Terminator Sheet")}"></span>` : ""}
        ${dirtyBadge}
      </span>
      <span class="tab-sub${tab.type === "file" ? " tab-sub-path" : ""}" title="${escapeHtml(tab.sub || "")}">${escapeHtml(tab.sub || "")}</span>
    </span>
    ${closable ? `<button class="tab-close" title="${t("close")}">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>` : ""}
  `;
  el.addEventListener("click", e => {
    if (e.target.closest(".tab-close")) return;
    activateTab(tab.id);
  });
  // перетаскивание вкладок: порядок меняется внутри state.tabs, welcome не двигается
  el.draggable = true;
  el.addEventListener("dragstart", e => {
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/tsh-tab", tab.id); } catch (err) { /* noop */ }
    el.classList.add("dragging");
  });
  el.addEventListener("dragend", () => el.classList.remove("dragging"));
  el.addEventListener("dragover", e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });
  el.addEventListener("drop", e => {
    e.preventDefault();
    e.stopPropagation();
    let id = "";
    try { id = e.dataTransfer.getData("text/tsh-tab"); } catch (err) { /* noop */ }
    if (!id || id === tab.id) return;
    reorderTabs(id, tab.id, e);
  });
  el.addEventListener("auxclick", e => {
    if (e.button === 1 && closable) closeTab(tab.id); // middle-click closes
  });
  el.querySelector(".tab-close")?.addEventListener("click", e => {
    e.stopPropagation();
    closeTab(tab.id);
  });
  return el;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// нормализация пути для ключей вкладок/дерева: / -> \ (иначе один и тот же
// файл, открытый из дерева и из drag&drop, получит две вкладки)
function normPath(p) {
  return String(p || "").replace(/\//g, "\\");
}

function reorderTabs(srcId, dstId, e) {
  const src = state.tabs.findIndex(t => t.id === srcId);
  const dst = state.tabs.findIndex(t => t.id === dstId);
  if (src < 0 || dst < 0) return;
  const moved = state.tabs.splice(src, 1)[0];
  let idx = state.tabs.findIndex(t => t.id === dstId);
  if (idx < 0) { state.tabs.splice(src, 0, moved); return; }
  const dstEl = $(`#tab-bar-inner .tab[data-tab-id="${CSS.escape(dstId)}"]`);
  if (dstEl) {
    const r = dstEl.getBoundingClientRect();
    if (e && e.clientX > r.left + r.width / 2) idx += 1;
  }
  state.tabs.splice(idx, 0, moved);
  renderTabBar();
}

function renderTabBar() {
  const inner = $("#tab-bar-inner");
  // какие вкладки были с красной дискетой до перерисовки: только что
  // сохранённые получат зелёную вспышку (createTabElement -> .saved-flash)
  const wasDirty = {};
  $$(".tab", inner).forEach(el => {
    wasDirty[el.dataset.tabId] = !!el.querySelector(".tab-dirty-floppy:not(.saved-flash)");
  });
  inner.innerHTML = "";
  state.tabs.forEach(tab => {
    if (tab.type === "welcome") return; // landing lives behind the pinned button, not in the bar
    inner.appendChild(createTabElement(tab, !tab.dirty && wasDirty[tab.id]));
  });
  updateTabBarScroll();
  // пути открытых вкладок в sessionStorage: переживают перезагрузку страницы
  // (watchdog reload / F5), но не перезапуск приложения. Пишем только ПОСЛЕ
  // восстановления (иначе первый render в init затрёт сохранённый список)
  if (window.__tshRestored) {
    try {
      const openPaths = state.tabs.filter(tb => tb.type === "file" && tb.path)
        .map(tb => tb.path);
      sessionStorage.setItem("tsh_tabs", JSON.stringify(openPaths));
    } catch (e) { /* noop */ }
  }
}

// восстановление открытых вкладок после перезагрузки страницы (watchdog/F5)
async function restoreTabs() {
  let paths = [];
  try { paths = JSON.parse(sessionStorage.getItem("tsh_tabs") || "[]"); }
  catch (e) { paths = []; }
  if (!Array.isArray(paths)) paths = [];
  window.__tshRestored = true;   // дальше renderTabBar уже может писать
  for (const p of paths) {
    if (typeof p === "string" && p && !getOrCreateFileTab(p)) {
      try { await openFile(p); } catch (e) { /* вкладка не открылась - пропускаем */ }
    }
  }
}

function updateTabBarScroll() {
  const scroll = $("#tab-bar-scroll");
  const inner = $("#tab-bar-inner");
  const menu = $("#tab-bar-menu");
  const maxScroll = inner.scrollWidth - scroll.clientWidth;
  // the three-dots button appears only when the tabs overflow the bar;
  // scrolling is done with the mouse wheel over the tab bar
  if (menu) menu.hidden = maxScroll <= 1;
}

const ICON_MENU_DOTS = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>';
const FOLDER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-8L9.6 4.6A2 2 0 0 0 8.2 4H4a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1z"/></svg>';
const GAMEPAD_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12h4m-2-2v4m8-1h.01M18 10h.01M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/></svg>';
const MOD_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>';
const LINK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

// красная дискета «не сохранено» на вкладке; при сохранении вспыхивает
// зелёным и исчезает (см. .tab-dirty-floppy / @keyframes tabSaveFlash)
const FLOPPY_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>';

function toggleTabsDropdown() {
  const dd = $("#tabs-dropdown");
  if (!dd.hidden) { dd.hidden = true; return; }
  dd.innerHTML = "";
  const fileTabs = state.tabs.filter(tab => tab.type !== "welcome");
  if (!fileTabs.length) {
    const empty = document.createElement("div");
    empty.className = "tabs-dd-empty";
    empty.textContent = t("no_tabs");
    dd.appendChild(empty);
  }
  fileTabs.forEach(tab => {
    const item = document.createElement("div");
    item.className = "tabs-dd-item" + (tab.id === state.activeTabId ? " active" : "");
    item.innerHTML = `<span class="td-ico"></span><span class="td-main"><span class="td-title"></span><span class="td-sub"></span></span>`;
    item.querySelector(".td-ico").innerHTML = iconHtml(tab.icon, "📄");
    item.querySelector(".td-title").textContent = tab.title;
    item.querySelector(".td-sub").textContent = tab.sub || "";
    item.title = tab.path || tab.title;
    item.addEventListener("click", () => { dd.hidden = true; activateTab(tab.id); });
    dd.appendChild(item);
  });
  const btn = $("#tab-bar-menu");
  const r = btn.getBoundingClientRect();
  dd.style.top = r.bottom + 6 + "px";
  dd.style.right = Math.max(8, window.innerWidth - r.right) + "px";
  dd.hidden = false;
}

function activateTab(tabId) {
  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab) return;
  
  state.activeTabId = tabId;
  
  // Update tab bar
  $$("#tab-bar-inner .tab").forEach(el => {
    const isActive = el.dataset.tabId === tabId;
    el.classList.toggle("active", isActive);
    el.setAttribute("aria-selected", isActive);
  });
  // the pinned home button is a full tab: highlight it for the welcome tab
  const homeBtn = $("#tab-open-file");
  if (homeBtn) homeBtn.classList.toggle("active", tabId === "welcome");
  
  // Update tab panels
  $$(".tab-panel").forEach(panel => {
    const isActive = panel.dataset.tabId === tabId;
    panel.classList.toggle("active", isActive);
  });
  
  // Update toolbar visibility
  const isWelcome = tab.type === "welcome";
  $("#sheet-toolbar").hidden = isWelcome;
  
  // Update current file state for the active tab
  if (tab.type === "file" && tab.fileData) {
    state.currentFile = tab.fileData;
    state.dirty = tab.dirty || false;
    // Ссылки хранятся на вкладке: повторный клик по вкладке НЕ дёргает
    // /api/links и не перерисовывает иконки связей (это и было подлагивание).
    state.links = tab.links != null ? tab.links : [];
    $("#file-path").textContent = tab.path;
    updateDirty();
    // while the loading overlay is up the panel must stay untouched:
    // no "no file" placeholder row, no "+" header underneath the spinner
    const lo = $(`#loading-${tab.id}`);
    const loading = lo && !lo.classList.contains("hidden");
    if (!loading) {
      // Сетка перерисовывается только если вкладка ещё не отрисована (или её
      // осознанно сбросили). Возврат на вкладку сохраняет скролл и выделение -
      // это дешевле и заметно плавнее в Qt-окне.
      if (!tab.rendered) {
        state.selectedRow = null;
        renderGrid();
        tab.rendered = true;
      }
      if (!tab.linksLoaded) loadLinks();
    }
  } else if (tab.type === "welcome" || tab.type === "compare"
      || tab.type === "create-mod" || tab.type === "unpacker" || tab.type === "swt"
      || tab.type === "uprising") {
    state.currentFile = null;
    state.dirty = false;
    updateDirty();
    // SWT живёт на локальном стеке undo (не серверном): кнопки — по нему
    if (tab.type === "swt") swtSyncUndoButtons();
    // no file open -> no path in the header
    const fp = $("#file-path");
    fp.textContent = "";
    fp.title = "";
  }

  if (fileFind && fileFind.isOpen()) refreshFind();
  // SWT-страница: фильтр «только .swt»; уход со страницы возвращает прежний
  if (tabId === "swt") swtApplyTreeFilter();
  else swtRestoreTreeFilter();
  // уходим со вкладки - универсальный fullscreen сворачивается
  paneFsExit();
  updateSidebarVisibility();
}

function createTab(type, data) {
  state.tabCounter++;
  const id = "tab-" + state.tabCounter;
  let tab;

  if (type === "file") {
    const fileName = data.path.split(/[\\/]/).pop();
    tab = {
      id,
      type: "file",
      title: fileName,
      path: data.path,
      sub: computeOverlaySub(data.path),
      origin: fileOrigin(data.path),
      fileData: data,
      dirty: false,
      sheetIndex: data.sheet_index || 0,
      links: [],
      icon: getFileIcon(data.path)
    };
  } else if (type === "welcome") {
    tab = {
      id: "welcome",
      type: "welcome",
      title: t("open_file"),
      sub: t("welcome_sub") || "XML / проект",
      icon: "🏠"
    };
  } else if (type === "compare") {
    tab = {
      id: "compare",
      type: "compare",
      title: t("compare"),
      sub: "",
      icon: "/assets/icons/dark/icons/diff.svg"
    };
  } else if (type === "create-mod") {
    tab = {
      id: "create-mod",
      type: "create-mod",
      title: t("create_mod") || "Создать мод",
      sub: "",
      icon: "/assets/icons/dark/icons/xml.svg"
    };
  } else if (type === "unpacker") {
    tab = {
      id: "unpacker",
      type: "unpacker",
      title: t("up_title") || "Распаковщик архивов",
      sub: "",
      icon: "/assets/icons/dark/icons/zip.svg"
    };
  } else if (type === "swt") {
    tab = {
      id: "swt",
      type: "swt",
      title: t("swt_title") || "SWT редактор",
      sub: ".swt",
      icon: "/assets/icons/dark/icons/xml.svg"
    };
  } else if (type === "uprising") {
    tab = {
      id: "uprising",
      type: "uprising",
      title: t("upr_title") || "Карта Uprising",
      sub: "shop_presets",
      icon: "/assets/icons/dark/icons/xml.svg"
    };
  }

  state.tabs.push(tab);
  return tab;
}

function closeTab(tabId) {
  const idx = state.tabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;

  const tab = state.tabs[idx];
  if (tab.type === "welcome") return; // never close welcome tab

  const doClose = () => {
    const i = state.tabs.findIndex(t => t.id === tabId);
    if (i === -1) return;
    state.tabs.splice(i, 1);

    // If closing active tab, activate previous
    if (state.activeTabId === tabId) {
      const newIdx = Math.min(i, state.tabs.length - 1);
      if (newIdx >= 0) {
        activateTab(state.tabs[newIdx].id);
      }
    }

    renderTabBar();

    // Remove tab panel (the compare / create-mod / unpacker / swt panels are
    // static in index.html - keep them so the tabs can be reopened without
    // rebuilding)
    if (tab.type !== "compare" && tab.type !== "create-mod"
        && tab.type !== "unpacker" && tab.type !== "swt" && tab.type !== "uprising") {
      const panel = $(`.tab-panel[data-tab-id="${tabId}"]`);
      if (panel) panel.remove();
    }
    if (tab.type === "swt") state.swt = swtFreshState();
    if (tab.type === "uprising") state.uprising = uprFreshState();

    updateSidebarVisibility();
  };

  // If dirty, ask via the in-app dialog (not the browser confirm)
  if (tab.dirty) {
    askConfirm({
      title: t("unsaved_changes"),
      message: t("close_dirty_confirm"),
      buttons: [
        { id: "save", label: t("save_close") },
        { id: "discard", label: t("close_wo_save"), kind: "danger" },
        { id: "cancel", label: t("cancel"), kind: "ghost" },
      ],
    }).then(async choice => {
      if (choice === "cancel") return;
      if (choice === "save") {
        if (state.activeTabId === tabId) await saveCurrent();
        else {
          const sr = await api("/api/save", { method: "POST", body: JSON.stringify({ path: tab.path }) });
          const sj = await sr.json();
          if (sj.saved) noteSaved(tab.path);
        }
      }
      doClose();
    });
    return;
  }

  doClose();
}

function getOrCreateFileTab(path) {
  // Check if file already open (normalized: / vs \)
  const np = normPath(path);
  const existing = state.tabs.find(t => t.type === "file" && normPath(t.path) === np);
  if (existing) {
    activateTab(existing.id);
    return existing;
  }

  return null;
}

function addFileTab(fileData) {
  const tab = createTab("file", fileData);
  
  // Create tab panel
  const panel = document.createElement("section");
  panel.className = "tab-panel grid-tab";
  panel.dataset.tabId = tab.id;
  panel.role = "tabpanel";
  panel.innerHTML = `
    <div class="loading-overlay hidden" id="loading-${tab.id}">
      <div class="loading-spinner"></div>
      <div class="loading-text">${t("loading") || "Loading..."}</div>
    </div>
    <div class="grid-wrap">
      <div class="corner"></div>
      <div class="grid-scroll">
        <table class="grid"><thead></thead><tbody></table>
      </div>
    </div>
  `;
  $("#tab-panels").appendChild(panel);
  
  renderTabBar();
  activateTab(tab.id);
  
  return tab;
}

async function openFile(path, opts) {
  // .swt открывается в отдельном редакторе триггеров
  if (/\.swt$/i.test(path)) { await openSwt(path); return { ok: true }; }
  // Reuse the existing tab when the file is already open
  const existingTab = getOrCreateFileTab(path);
  if (existingTab) {
    markActiveTreeFile(path);
    if (opts && opts.scrollRow != null) {
      setTimeout(() => focusLinkedRow(opts.scrollRow), 60);
    }
    return { ok: true };
  }

  // Add optimistic tab immediately for responsiveness
  const tempTab = addFileTab({
    path,
    sheet_index: 0,
    sheets: [],
    columns: [],
    comments: [],
    rows: [],
    expanded_cols: 0
  });
  showTabLoading(tempTab.id, true);

  try {
    const r = await api("/api/open_file", { method: "POST",
      body: JSON.stringify({ path, recover: !!(opts && opts.recover),
        reset: !!(opts && opts.reset) }), timeout: API_TIMEOUT_OPEN });
    let j = await r.json();
    if (!j.ok) {
      showTabLoading(tempTab.id, false);
      if (j.recoverable && !(opts && opts.recover)) {
        // файл - битый XML: предложить аварийное открытие (с потерей
        // повреждённых частей; автосохранение для него будет выключено)
        const choice = await askConfirm({
          title: t("recover_title"),
          message: t("recover_msg") + "\n\n" + (j.error || ""),
          buttons: [
            { id: "ok", label: t("recover_open"), kind: "danger" },
            { id: "cancel", label: t("cancel"), kind: "ghost" },
          ],
        });
        if (choice === "ok") {
          showTabLoading(tempTab.id, true);
          const r2 = await api("/api/open_file", { method: "POST",
            body: JSON.stringify({ path, recover: true }), timeout: API_TIMEOUT_OPEN });
          j = await r2.json();
        }
      }
      if (!j.ok) {
        if (j.error) toast(j.error, "err");
        closeTab(tempTab.id);
        return j;
      }
    }

    // Update tab with real data
    tempTab.fileData = j.file;
    tempTab.title = j.file.path.split(/[\\/]/).pop();
    tempTab.path = j.file.path;
    tempTab.sub = computeOverlaySub(j.file.path);
    tempTab.origin = fileOrigin(j.file.path);
    tempTab.sheetIndex = j.file.sheet_index || 0;
    tempTab.icon = getFileIcon(j.file.path);
    // зелёная точка: файл уже сохранялся из программы (маркеры сервера)
    if (j.edited) tempTab.saved = true;
    if (j.file.recovered) tempTab.recovered = true;
    renderTabBar();

    state.currentFile = j.file;
    state.selectedRow = null;
    state.selCell = null;
    state.dirty = false;
    state.links = [];
    const fp = $("#file-path");
    fp.textContent = j.file.path;
    fp.title = j.file.path;
    updateDirty();
    setUndoRedoButtons(!!j.can_undo, !!j.can_redo);

    // Render the grid first: the spinner stays up until data is on screen.
    // Links are loaded in the background and re-render their markers.
    renderGrid();
    showTabLoading(tempTab.id, false);
    // настройка «скрывать дерево при открытии файла»: спрятать сайдбар,
    // вернуть можно кнопкой сворачивания сайдбара
    if (state.config.auto_hide_tree) {
      state.sidebarCollapsed = true;
      updateSidebarVisibility();
    }
    loadLinks();
    if (j.file.recovered) {
      toast(t("recovered_banner"), "warn");
    }

    if (opts && opts.scrollRow != null) {
      setTimeout(() => focusLinkedRow(opts.scrollRow), 50);
    }

    // Highlight in tree
    markActiveTreeFile(j.file.path);
    return j;
  } catch (e) {
    showTabLoading(tempTab.id, false);
    toast("Failed to open file: " + e.message, "err");
    closeTab(tempTab.id);
    return { ok: false, error: e.message };
  }
}

function showTabLoading(tabId, show) {
  const overlay = $(`#loading-${tabId}`);
  if (overlay) overlay.classList.toggle("hidden", !show);
}

function getActiveGridTable() {
  const activePanel = $(".tab-panel.active");
  if (!activePanel) return null;
  return activePanel.querySelector(".grid");
}

function cellClassName(ri, ci) {
  // highlight cells of rows flagged as changed by the comparator
  if (state.compare && state.compare.changedRows && state.compare.changedRows.has(ri)) {
    return "changed";
  }
  return "";
}

function visibleRows() {
  const f = state.currentFile;
  if (!f) return [];
  if (!state.filterText) return f.rows.map((row, ri) => ({ row, ri }));
  const out = [];
  f.rows.forEach((row, ri) => {
    if (row.values.some(v => String(v).toLowerCase().includes(state.filterText))) {
      out.push({ row, ri });
    }
  });
  return out;
}

function renderCellContent(td, ri, ci, rawVal) {
  td.textContent = rawVal;
  // friendly name under sysname (col 0)
  if (ci === 0 && rawVal) {
    const disp = state.nameMap[String(rawVal).trim()];
    if (disp && disp !== rawVal) {
      td.title = disp + " (" + rawVal + ")";
      const sub = document.createElement("div");
      sub.className = "cell-sub";
      sub.textContent = disp;
      td.appendChild(sub);
    }
  }
  const link = state.links.find(l => l.row === ri && l.col === ci);
  if (link) {
    // absolute-позиционирование внутри ячейки: иконка не переносится на
    // вторую строку и не раздувает колонку/строку
    td.classList.add("has-link");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "link-btn";
    const tname = String(link.target_file || "").split(/[\\/]/).pop();
    btn.title = t("link_hint") + (tname ? " → " + tname : "");
    btn.innerHTML = LINK_SVG;
    btn.addEventListener("click", ev => { ev.stopPropagation(); followLink(link); });
    td.appendChild(btn);
  }
}

function makeCell(row, ri, ci, tr) {
  const td = document.createElement("td");
  td.className = (ci === 0 ? "sticky-col " : "") + cellClassName(ri, ci);
  const rawVal = row.values[ci];
  renderCellContent(td, ri, ci, rawVal);
  td.dataset.row = ri; td.dataset.col = ci;
  if (state.find.active && state.find.keySet.has(ri + ":" + ci)) {
    td.classList.add("find-hit");
  }
  td.addEventListener("mousedown", ev => {
    if (ev.target.closest(".link-btn")) return;
    clearColSelection();
    // a second click on the already-focused cell enters edit mode right away
    if (state.selCell && state.selCell.r === ri && state.selCell.c === ci) {
      beginEdit(tr, ri, ci);
      return;
    }
    clearCellFocus();
    state.selCell = { r: ri, c: ci };
    td.classList.add("cell-focus");
    selectRow(ri);
  });
  td.addEventListener("dblclick", e => {
    if (e.target.closest(".link-btn")) return;
    beginEdit(tr, ri, ci);
  });
  return td;
}

// Drop the subtle focus highlight from the previously selected cell.
function clearCellFocus() {
  if (state.selCell) {
    const table = getActiveGridTable();
    const tr = table && table.querySelector(`tbody tr[data-row-index="${state.selCell.r}"]`);
    const td = tr && tr.children[state.selCell.c];
    if (td) td.classList.remove("cell-focus");
  }
  state.selCell = null;
}

function appendGridRows(table, from, to) {
  const tbody = table.querySelector("tbody");
  for (let k = from; k < to && k < state.visRows.length; k++) {
    const { row, ri } = state.visRows[k];
    const tr = document.createElement("tr");
    if (state.selectedRow === ri) tr.classList.add("sel");
    tr.dataset.rowIndex = ri;
    row.values.forEach((_val, ci) => tr.appendChild(makeCell(row, ri, ci, tr)));
    tbody.appendChild(tr);
  }
  // keep the ghost "+ add row" line at the very bottom when lazy chunks
  // append below it
  const trAdd = tbody.querySelector("tr.tr-add");
  if (trAdd) tbody.appendChild(trAdd);
}

function setupGridScroll(table) {
  const wrap = table.closest(".grid-scroll");
  if (!wrap || wrap.dataset.gridScrollBound) return;
  wrap.dataset.gridScrollBound = "1";
  wrap.addEventListener("scroll", () => {
    const t = wrap.querySelector(".grid");
    if (!t || state.gridRenderLimit >= state.visRows.length) return;
    if (wrap.scrollTop + wrap.clientHeight < wrap.scrollHeight - 400) return;
    // while the user stays at the bottom, keep appending so there are never
    // invisible rows below the scrollbar end
    let guard = 0;
    while (state.gridRenderLimit < state.visRows.length &&
           wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 400 &&
           guard < 4) {
      const from = state.gridRenderLimit;
      const to = Math.min(from + GRID_CHUNK, state.visRows.length);
      state.gridRenderLimit = to;
      appendGridRows(t, from, to);
      guard++;
    }
  }, { passive: true });
}

function renderGrid() {
  const f = state.currentFile;
  if (!f) return;
  const table = getActiveGridTable();
  if (!table) return;
  state.selCell = null;   // grid is rebuilt; cell focus restarts on click
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");
  thead.innerHTML = ""; tbody.innerHTML = "";

  state.visRows = visibleRows();
  state.gridRenderLimit = Math.min(GRID_CHUNK, state.visRows.length);

  // header row
  const hrow = document.createElement("tr");
  f.columns.forEach((name, ci) => {
    const th = document.createElement("th");
    th.textContent = name;
    th.className = (ci === 0 ? "sticky-col col-head " : "col-head ");
    th.dataset.col = ci;
    const comment = f.comments[ci];
    if (comment) th.classList.add("has-comment");
    // built-in RU glossary for column names (the game files don't localize them)
    const ru = HEADER_GLOSSARY[String(name).trim()];
    if (ru) {
      const subEl = document.createElement("div");
      subEl.className = "th-sub";
      subEl.textContent = ru;
      th.appendChild(subEl);
    }
    th.addEventListener("mouseenter", e => {
      if (comment) showTip(e, name + (ru ? " (" + ru + ")" : "") + " — " + comment);
    });
    th.addEventListener("mousemove", e => comment && moveTip(e));
    th.addEventListener("mouseleave", () => hideTip());
    th.addEventListener("dblclick", () => selectColumn(ci)); // select whole column
    if (ci === 0) {
      // drag handle on the sticky sysname header to resize the column
      const rz = document.createElement("div");
      rz.className = "th-resizer";
      rz.title = t("resize_col") || "Перетащите, чтобы изменить ширину";
      rz.addEventListener("mousedown", e => startStickyResize(e));
      rz.addEventListener("dblclick", e => e.stopPropagation());
      th.appendChild(rz);
    }
    hrow.appendChild(th);
  });
  const thAdd = document.createElement("th");
  thAdd.className = "th-add";
  thAdd.textContent = "+";
  thAdd.title = t("add_column");
  thAdd.addEventListener("click", () => addColumn());
  hrow.appendChild(thAdd);
  thead.appendChild(hrow);

  appendGridRows(table, 0, state.gridRenderLimit);
  setupGridScroll(table);

  // ghost "+ add row" row
  if (state.visRows.length) {
    const trAdd = document.createElement("tr");
    trAdd.className = "tr-add";
    const td = document.createElement("td");
    td.colSpan = (f.columns.length || 1) + 1;
    td.textContent = "+ " + t("add_row");
    td.addEventListener("click", () => addRow());
    trAdd.appendChild(td);
    tbody.appendChild(trAdd);
  }

  // empty state
  if (!state.visRows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = f.columns.length || 1;
    td.textContent = t("no_file");
    td.style.padding = "30px"; td.style.color = "var(--text-mute)";
    tr.appendChild(td); tbody.appendChild(tr);
  }
}

function selectRow(ri) {
  state.selectedRow = ri;
  const table = getActiveGridTable();
  if (!table) return;
  $$("tbody tr", table).forEach(tr => {
    tr.classList.toggle("sel", Number(tr.dataset.rowIndex) === ri);
  });
}

// After following a link: scroll to the target row, select it and flash it,
// so the linked object is obvious at a glance.
function focusLinkedRow(ri) {
  const table = getActiveGridTable();
  if (!table || !state.currentFile || !state.currentFile.rows[ri]) return;
  selectRow(ri);
  const tr = table.querySelector(`tbody tr[data-row-index="${ri}"]`);
  if (tr) {
    tr.classList.remove("row-flash");
    // restart the CSS animation when the same row is focused twice
    void tr.offsetWidth;
    tr.classList.add("row-flash");
    setTimeout(() => tr.classList.remove("row-flash"), 1800);
    const td = tr.children[0];
    if (td) ensureCellVisible(td);
  } else {
    scrollToRow(ri);
  }
}

// Jump from a history record to the exact changed cell: select and flash the
// row, put the subtle focus highlight on the edited cell and scroll to it.
function focusLinkedCell(ri, ci) {
  const table = getActiveGridTable();
  if (!table || !state.currentFile || !state.currentFile.rows[ri]) return;
  selectRow(ri);
  const tr = table.querySelector(`tbody tr[data-row-index="${ri}"]`);
  if (!tr) { scrollToRow(ri); setTimeout(() => focusLinkedCell(ri, ci), 90); return; }
  clearCellFocus();
  state.selCell = { r: ri, c: ci };
  const td = tr.children[ci];
  if (td) { td.classList.add("cell-focus"); ensureCellVisible(td); }
  tr.classList.remove("row-flash");
  void tr.offsetWidth;
  tr.classList.add("row-flash");
  setTimeout(() => tr.classList.remove("row-flash"), 1800);
}

// Click on the yellow column button in a history record: close the modal and
// show the change in place.
function jumpToHistoryChange(h) {
  let p = h.payload || {};
  // батч из одной ячейки: координаты лежат в cells[0]
  if ((p.r == null || p.c == null) && Array.isArray(p.cells)
      && p.cells.length === 1) p = p.cells[0];
  if (p.r == null || p.c == null) return;
  $("#history-modal").hidden = true;
  // on the compare page jump inside the preview pane of that record's file
  if (!state.currentFile && h.__side && state.cmpData) {
    if (cmpFocusCell(h.__side, p.r, p.c)) return;
  }
  focusLinkedCell(p.r, p.c);
}

// ---------- sticky column resize ----------
function stickyWidth() {
  const saved = parseInt(localStorage.getItem("stickyW"), 10);
  if (saved && !isNaN(saved)) return saved;
  const css = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sticky-w"), 10);
  return isNaN(css) ? 220 : css;
}

function startStickyResize(e) {
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX;
  const startW = stickyWidth();
  const move = ev => {
    const w = Math.max(90, Math.min(600, startW + (ev.clientX - startX)));
    document.documentElement.style.setProperty("--sticky-w", w + "px");
    // keep the compare sysname column in sync (it must not follow the font)
    document.documentElement.style.setProperty("--cmp-sticky-w", w + "px");
    localStorage.setItem("stickyW", String(w));
  };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    document.body.style.userSelect = "";
  };
  document.body.style.userSelect = "none";
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}

function clearColSelection() {
  if (state.colSel == null) return;
  state.colSel = null;
  const table = getActiveGridTable();
  if (table) $$(".col-sel", table).forEach(el => el.classList.remove("col-sel"));
}

// double-click on a header toggles whole-column selection
function selectColumn(ci) {
  const table = getActiveGridTable();
  if (!table) return;
  const wasSel = state.colSel;
  clearColSelection();
  if (wasSel === ci) return; // second double-click clears
  state.colSel = ci;
  table.querySelectorAll(`thead th[data-col="${ci}"], tbody td[data-col="${ci}"]`)
    .forEach(el => el.classList.add("col-sel"));
}

function scrollToRow(ri) {
  const table = getActiveGridTable();
  if (!table) return;
  let tr = $$("tbody tr", table).find(x => Number(x.dataset.rowIndex) === ri);
  if (!tr && state.visRows.length) {
    const k = state.visRows.findIndex(v => v.ri === ri);
    if (k >= state.gridRenderLimit) {
      const to = Math.min(k + 1, state.visRows.length);
      appendGridRows(table, state.gridRenderLimit, to);
      state.gridRenderLimit = to;
      tr = $$("tbody tr", table).find(x => Number(x.dataset.rowIndex) === ri);
    }
  }
  if (!tr) return;
  const wrap = tr.closest(".grid-scroll");
  if (!wrap) return;
  const wr = wrap.getBoundingClientRect();
  const r = tr.getBoundingClientRect();
  const thead = wrap.querySelector(".grid thead");
  const headH = thead ? thead.offsetHeight : 0;
  const viewH = wr.bottom - (wr.top + headH);
  const target = wr.top + headH + (viewH - r.height) / 2;
  wrap.scrollTop += (r.top - target);
}

// Bring a cell into view by scrolling ONLY the grid container (both axes).
// scrollIntoView() is deliberately not used: it also scrolls overflow:hidden
// ancestors (body), which pushed the app top bar out of the window.
function ensureCellVisible(td) {
  const wrap = td.closest(".grid-scroll");
  if (!wrap) return;
  const wr = wrap.getBoundingClientRect();
  const cr = td.getBoundingClientRect();
  const thead = wrap.querySelector(".grid thead");
  const headH = thead ? thead.offsetHeight : 0;
  // vertical: keep the cell below the sticky header
  if (cr.top < wr.top + headH) {
    wrap.scrollTop -= (wr.top + headH - cr.top);
  } else if (cr.bottom > wr.bottom) {
    wrap.scrollTop += (cr.bottom - wr.bottom);
  }
  // horizontal: keep the cell clear of the sticky sysname column
  if (!td.classList.contains("sticky-col")) {
    const stickyTh = wrap.querySelector(".grid thead th.sticky-col");
    const stickyW = stickyTh ? stickyTh.offsetWidth : 0;
    if (cr.left < wr.left + stickyW) {
      wrap.scrollLeft -= (wr.left + stickyW - cr.left);
    } else if (cr.right > wr.right) {
      wrap.scrollLeft += (cr.right - wr.right);
    }
  }
}

function getFileIcon(path) {
  // per-format icons from the icon theme (assets/icons/dark/icons, served by
  // the backend); the old flat icon folder was replaced by themed sets.
  // Возвращает data-URL из памяти, если иконки уже подтянуты одним запросом
  // (preloadIcons) — иначе прямой URL (фолбэк сам доберёт по коннекту)
  const ext = String(path).split(".").pop().toLowerCase();
  const fn = FILE_EXT_ICONS[ext] || "file.svg";
  return ICON_MAP[fn] || (ICON_BASE + fn);
}

// Semantic icons for the project tree categories (best fit available in the set)
const CATEGORY_ICONS = {
  "humans": "pawn.svg",
  "squads": "command.svg",
  "squad_upgrades": "renovate.svg",
  "cars": "cargo.svg",
  "car_upgrades": "renovate.svg",
  "tanks": "sentry.svg",
  "tank_upgrades": "renovate.svg",
  "helicopters": "velocity.svg",
  "heli_upgrades": "renovate.svg",
  "guns": "dart.svg",
  "ammunition": "payload.svg",
  "modules": "lib.svg",
  "animations": "lottie.svg",
  "exp": "chart.svg",
  "reinforcements": "nest.svg",
  "spawns_sheet": "spreadsheet.svg",
  "misc": "doc.svg",
};

function iconHtml(icon, fallback) {
  // icons are either asset URLs (file tabs) or legacy emoji; после
  // preloadIcons в памяти лежат data-URL — их тоже отдаём <img>, иначе
  // весь base64 печатается текстом (баг «мусора» во вкладках)
  const s = String(icon || "");
  if (s.startsWith("/") || s.startsWith("data:image/")) return `<img src="${s}" alt="">`;
  return escapeHtml(icon || fallback || "📄");
}

// base folder of the active icon theme
const ICON_BASE = "/assets/icons/dark/icons/";
// весь используемый набор иконок — одним запросом в память (см. preloadIcons):
// сотни отдельных <img> по HTTP/1.0 без keep-alive эпизодически не
// прогружались (пустая иконка главной вкладки и т.п.)
const ICON_MAP = {};   // file.svg -> data-URL
let iconsLoading = null;

// per-format icons (вынесено из getFileIcon для usedIconNames)
const FILE_EXT_ICONS = {
  xml: "xml.svg",
  toml: "toml.svg",
  json: "json.svg",
  set: "json.svg",     // skirmish garrisons are JSON
  swt: "xml.svg",      // trigger scripts are XML
  swp: "binary.svg",   // binary CWP containers
  sws: "binary.svg",
  txt: "txt.svg",
  config: "properties.svg",
  sav: "database.svg",
  lbox: "zip.svg",
  material: "shader.svg",
  model: "_3d.svg",
  anim: "lottie.svg",
  psyfx: "binary.svg",
  dds: "image.svg",
  png: "image.svg",
  jpg: "image.svg",
  jpeg: "image.svg",
  tga: "image.svg",
  pdn: "image.svg",
  wav: "audio.svg",
  ogg: "audio.svg",
};

function usedIconNames() {
  const s = new Set(["file.svg", "folder.svg", "folder__open.svg",
    "folder_home.svg", "diff.svg", "xml.svg", "zip.svg"]);
  for (const k in FILE_EXT_ICONS) s.add(FILE_EXT_ICONS[k]);
  for (const k in CATEGORY_ICONS) s.add(CATEGORY_ICONS[k]);
  for (const k in TREE_DIR_ICONS) TREE_DIR_ICONS[k].forEach(f => s.add(f));
  return [...s];
}

// догрузка всех иконок темы одним запросом в память; вызывается фоном на
// старте — дальше все <img> берутся из кэша без единого коннекта
function preloadIcons() {
  if (iconsLoading) return iconsLoading;
  iconsLoading = (async () => {
    try {
      const r = await api("/api/icons_data", { method: "POST",
        body: JSON.stringify({ names: usedIconNames() }), timeout: 60000 });
      const j = await r.json();
      if (j && j.ok && j.icons) Object.assign(ICON_MAP, j.icons);
    } catch (e) { /* фолбэк — прямые URL */ }
    // иконка главной вкладки (статичный <img> в шаблоне)
    const home = document.getElementById("home-icon");
    if (home && ICON_MAP["folder_home.svg"]) home.src = ICON_MAP["folder_home.svg"];
    // дерево и вкладки могли отрисоваться раньше иконок: перерисовать с кэшем
    if (state.fullTree || state.gameTree || state.modTree) renderTree();
    renderTabBar();
  })();
  return iconsLoading;
}

const OVERLAY_LABEL_KEYS = {
  basis: "overlay_basis",
  dlc_resistance: "overlay_dlc_resistance",
  dlc_legion: "overlay_dlc_legion",
  dlc_evolution: "overlay_dlc_evolution",
  dlc: "overlay_dlc",
};

// Откуда файл: «project» (папка проекта), «mod» (папка мода) или
// «game» (распакованные ассеты). Определяется по абсолютному пути.
function fileOrigin(path) {
  const norm = normPath(path).toLowerCase() + "\\";
  if (state.project && state.project.root &&
      norm.startsWith(normPath(state.project.root).toLowerCase() + "\\")) return "project";
  const md = (state.config && state.config.mod_path) || "";
  if (md && norm.startsWith(normPath(md).toLowerCase() + "\\")) return "mod";
  const up = (state.config && state.config.unpacked_path) || "";
  if (up && norm.startsWith(normPath(up).toLowerCase() + "\\")) return "game";
  return null;
}

function rootFolderName(p) {
  const parts = normPath(p).split("\\").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

// Корневое имя для подписи вкладки: файл из распакованной игры ->
// имя папки распаковки, из мода -> имя папки мода, из проекта -> имя проекта.
function rootPrefixName(path) {
  if (fileOrigin(path) === "game") {
    const n = rootFolderName((state.config && state.config.unpacked_path) || "");
    if (n) return n;
  }
  if (fileOrigin(path) === "mod") {
    const n = rootFolderName((state.config && state.config.mod_path) || "");
    if (n) return n;
  }
  if (state.project && state.project.root) return projectFolderName(state.project);
  return t("overlay_basis") || "Компания";
}

// Tab subtitle: make the overlay explicit, e.g. "Компания\scripts\species"
// or "resistance\scripts\species"
function computeOverlaySub(path) {
  const norm = path.replace(/\//g, "\\").toLowerCase();
  const dirs = path.split(/[\\/]/).slice(0, -1);
  const tail = dirs.slice(-2).join("\\");
  if (norm.includes("\\dlc\\resistance\\")) return "resistance\\" + tail;
  if (norm.includes("\\dlc\\legion\\")) return "legion\\" + tail;
  if (norm.includes("\\dlc\\evolution\\")) return "evolution\\" + tail;
  if (norm.includes("\\dlc\\")) return "dlc\\" + tail;
  return rootPrefixName(path) + "\\" + tail;
}

const HEADER_GLOSSARY = {
  sysname: "Системное имя",
  mass: "Масса",
  health: "Прочность",
  armor: "Броня",
  durability: "Живучесть",
  cost: "Стоимость",
  crew: "Экипаж",
  members: "Состав отряда",
  man: "Человек",
  gun: "Орудие",
  guns: "Орудия",
  engine: "Двигатель",
  mesh: "Модель",
  image: "Изображение",
  icon: "Иконка",
  description: "Описание",
  comment: "Комментарий",
  comments: "Комментарии",
  category: "Категория",
  type: "Тип",
  faction: "Фракция",
  nationality: "Национальность",
  parent: "Родитель",
  slot: "Слот",
  slot_type: "Тип слота",
  gun_slots: "Слоты орудий",
  gun_mounts: "Крепления орудий",
  gun_mounts_standard: "Станд. крепления",
  gun_mounts_special: "Особые крепления",
  weapon_slots_standard: "Станд. оружейные слоты",
  weapon_slots_special: "Особые оружейные слоты",
  weapon_type: "Тип оружия",
  modules: "Модули",
  module_type: "Тип модуля",
  module_function: "Функция модуля",
  upgrades: "Модификации",
  squad_upgrades: "Модификации отряда",
  cars: "Машины",
  tanks: "Танки",
  helicopters: "Вертолёты",
  squads: "Отряды",
  ammunition: "Боеприпасы",
  ammo_class: "Класс боеприпаса",
  bullet_type: "Тип пули",
  rocket_type: "Тип ракеты",
  max_velocity: "Макс. скорость",
  max_walk_velocity: "Скорость шага",
  max_range: "Макс. дальность",
  max_shot_distance: "Макс. дистанция выстрела",
  min_shot_distance: "Мин. дистанция выстрела",
  effective_distance: "Эфф. дистанция",
  shot_period: "Период выстрела",
  burst_period: "Период очереди",
  burst_shots: "Выстрелов в очереди",
  reload_penalty: "Штраф перезарядки",
  hit_damage: "Урон",
  direct_damage: "Прямой урон",
  explode_damage: "Урон взрыва",
  splash_radius: "Радиус осколков",
  hit_splash_radius: "Радиус осколков",
  explode_splash_radius: "Радиус взрыва",
  accuracy: "Точность",
  aim_accuracy: "Точность прицела",
  aim_deviation: "Отклонение прицела",
  bullet_scattering: "Разброс",
  shot_rebound_factor: "Рикошет",
  hit_prob: "Вероятность попадания",
  vision_radius: "Радиус обзора",
  vision_radius_multiplier: "Множитель обзора",
  detection_radius_stay: "Обзор (стоя)",
  detection_radius_move: "Обзор (в движении)",
  detection_radius_shoot: "Заметность при выстреле",
  hide: "Маскировка",
  camo_stats: "Камуфляж",
  command_points: "Командные очки",
  cp_cost: "Стоимость (КО)",
  bonus_points: "Бонусные очки",
  base_points_easy: "Очки (легко)",
  base_points_normal: "Очки (норма)",
  base_points_hard: "Очки (сложно)",
  base_points_realistic: "Очки (реализм)",
  additional_cp_easy: "Доп. КО (легко)",
  additional_cp_normal: "Доп. КО (норма)",
  additional_cp_hard: "Доп. КО (сложно)",
  additional_cp_realistic: "Доп. КО (реализм)",
  unit_class_counts_easy: "Лимит юнитов (легко)",
  unit_class_counts_normal: "Лимит юнитов (норма)",
  unit_class_counts_hard: "Лимит юнитов (сложно)",
  unit_class_counts_realistic: "Лимит юнитов (реализм)",
  research_cost: "Стоимость исследования",
  researched: "Исследовано",
  crusher_class: "Класс тарана",
  crushable_class: "Класс сминаемости",
  trailer_class: "Класс прицепа",
  truck_class: "Класс грузовика",
  driving_class: "Класс вождения",
  chassis_type: "Тип шасси",
  track_width: "Ширина траков",
  turn_radius: "Радиус разворота",
  max_acceleration: "Ускорение",
  fuel_consumption: "Расход топлива",
  fuel_tank_capacity: "Объём бака",
  people_capacity: "Вместимость (людей)",
  supply_capacity: "Вместимость (снабжение)",
  supply_consumption: "Расход снабжения",
  supply_cost: "Стоимость снабжения",
  cost_recharge: "Стоимость восстановления",
  time_recharge: "Время восстановления",
  passive_recharge_rate: "Скорость восстановления",
  perks: "Перки",
  trainings: "Тренировки",
  abilities: "Способности",
  fighting_type: "Тип боя",
  close_combat: "Ближний бой",
  base_fighting_skill: "Навык боя",
  exp_levels: "Уровни опыта",
  shot_sound: "Звук выстрела",
  destroy_sound: "Звук уничтожения",
  inventory_items: "Инвентарь",
  item_type: "Тип предмета",
  is_grenade: "Граната",
  is_obstacle: "Препятствие",
  life_time: "Время жизни",
  life_distance: "Дистанция действия",
  detonation_distance: "Дистанция детонации",
  cruise_height: "Высота полёта",
  land_time: "Время посадки",
  blades: "Лопасти",
  voices: "Голоса",
  voice_state: "Озвучка",
};

// ---------- edited-files marks (dot in the tree + <project>.json) ----------
async function loadEditedMarks(root) {
  state.editedFiles = new Set();
  if (!root) return;
  try {
    const r = await api("/api/edited_marks?path=" + encodeURIComponent(root), { timeout: API_TIMEOUT_OPEN });
    const j = await r.json();
    if (j.ok) state.editedFiles = new Set((j.files || []).map(p => String(p).toLowerCase()));
  } catch (e) { /* marks are optional sugar */ }
}

function noteSaved(path) {
  // instant indicator update without a full tree re-render
  if (!path) return;
  const k = String(path).toLowerCase();
  const fresh = !state.editedFiles.has(k);
  state.editedFiles.add(k);
  // зелёная точка на вкладке (работает и без открытого проекта)
  let tabChanged = false;
  state.tabs.forEach(tb => {
    if (tb.type === "file" && tb.path && normPath(tb.path) === normPath(path) && !tb.saved) {
      tb.saved = true;
      tabChanged = true;
    }
  });
  if (tabChanged) renderTabBar();
  if (!fresh) return;
  $$("#project-tree .tree-file").forEach(r => {
    if (String(r.dataset.path || "").toLowerCase() === k) {
      r.classList.add("edited");
      r.title = t("edited_hint") || "Файл редактировался в Terminator Sheet";
    }
  });
}

async function clearEditedMarks() {
  const root = state.project && state.project.root;
  if (!root) return;
  try {
    await api("/api/edited_marks/clear", { method: "POST", body: JSON.stringify({ path: root }) });
  } catch (err) { /* still clear client-side */ }
  state.editedFiles = new Set();
  $$("#project-tree .tree-file.edited").forEach(r => {
    r.classList.remove("edited");
    r.title = "";
  });
  toast(t("edited_cleared") || "Пометки очищены", "ok");
}

function clearTreeSel() {
  state.treeSel = new Set();
  $$("#project-tree .tree-file.selected").forEach(el => el.classList.remove("selected"));
}

function treeDragPayload(list, folders) {
  const data = { files: list || [], folders: folders || [] };
  return JSON.stringify(data);
}

// ---------- tree filters (compact dropdown over the full project tree) ----------
// Defaults = what we can actually edit today: the scripts folders + .xml.
// Add new extensions here as editor support grows.
// Дефолтные фильтры дерева. exts включает "swt", folders — "spawns":
// иначе сценарии миссий basis/spawns/*.swt (и в dlc-оверлеях) скрыты
// дефолтным фильтром и «в дереве не видно файлов swt».
const TREE_FILTER_DEFAULTS = { exts: ["xml", "swt", "set"], folders: ["scripts", "spawns"] };
const TREE_EDITABLE_EXTS = new Set(["xml"]);
const TREE_MATCH_CAP = 400;
const TREE_RENDER_CHUNK = 250;
const TREE_DIR_ICONS = {
  scripts: ["folder_scripts.svg", "folder_scripts__open.svg"],
  animations: ["folder_animation.svg", "folder_animation__open.svg"],
  audio: ["folder_audio.svg", "folder_audio__open.svg"],
  sound: ["folder_audio.svg", "folder_audio__open.svg"],
  sounds: ["folder_audio.svg", "folder_audio__open.svg"],
  images: ["folder_images.svg", "folder_images__open.svg"],
  textures: ["folder_images.svg", "folder_images__open.svg"],
};

// unit-sheet categories: inside species-like folders the raw xml list is
// regrouped into labeled subsections (Пехота / Отряды / Машины / Танки…).
// Order defines display order; groups only appear for files actually
// present in the opened project.
const TREE_CATEGORIES = [
  { key: "humans", icon: "pawn.svg", match: n => n === "humans.xml" },
  { key: "squads", icon: "command.svg", match: n => n === "squads.xml" },
  { key: "squad_upgrades", icon: "renovate.svg", match: n => n.startsWith("squad_") },
  { key: "cars", icon: "cargo.svg", match: n => n === "cars.xml" },
  { key: "car_upgrades", icon: "renovate.svg", match: n => n.startsWith("car_") },
  { key: "tanks", icon: "sentry.svg", match: n => n === "tanks.xml" },
  { key: "tank_upgrades", icon: "renovate.svg", match: n => n.startsWith("tank_") },
  { key: "helicopters", icon: "velocity.svg", match: n => n === "helicopters.xml" },
  { key: "heli_upgrades", icon: "renovate.svg", match: n => n.startsWith("heli_") },
  { key: "guns", icon: "dart.svg", match: n => n === "guns.xml" },
  { key: "ammunition", icon: "payload.svg", match: n => n === "ammunition.xml" },
  { key: "modules", icon: "lib.svg", match: n => n === "modules.xml" },
  { key: "animations", icon: "lottie.svg", match: n => n === "animations.xml" },
  { key: "exp", icon: "chart.svg", match: n => n === "exp.xml" },
  { key: "reinforcements", icon: "nest.svg", match: n => n === "reinforcements.xml" },
  { key: "spawns_sheet", icon: "spreadsheet.svg", match: n => n === "spawns_sheet.xml" },
  // сценарии миссий: свой раздел в дереве, открываются в SWT-редакторе
  { key: "swt_scripts", icon: "xml.svg", match: n => n.endsWith(".swt") },
];

function fileExt(name) {
  const s = String(name);
  const i = s.lastIndexOf(".");
  return i > 0 ? s.slice(i + 1).toLowerCase() : "";
}

function treeFilterStore() {
  try { return window.localStorage; } catch (e) { return null; }
}

function loadTreeFilters(forceDefaults) {
  let saved = null;
  const ls = treeFilterStore();
  if (ls && !forceDefaults) {
    try { saved = JSON.parse(ls.getItem("tsh_tree_filters") || "null"); } catch (e) { saved = null; }
  }
  // миграция старых дефолтов (["xml"] + ["scripts"]): они полностью прятали
  // .swt-сценарии в spawns; пользователь их не выбирал осознанно - заменяем
  if (saved && !forceDefaults) {
    const oldDefault = JSON.stringify({ exts: ["xml"], folders: ["scripts"] });
    const cur = JSON.stringify({
      exts: saved.exts === null ? null : saved.exts.map(x => String(x).toLowerCase()),
      folders: saved.folders === null ? null : saved.folders.map(x => String(x).toLowerCase()),
    });
    if (cur === oldDefault) saved = null;
  }
  const pick = (v, def) => {
    if (v === null) return null;
    if (Array.isArray(v)) return new Set(v.map(x => String(x).toLowerCase()));
    return new Set(def);
  };
  state.treeExtFilter = pick(saved ? saved.exts : undefined, TREE_FILTER_DEFAULTS.exts);
  state.treeFolderFilter = pick(saved ? saved.folders : undefined, TREE_FILTER_DEFAULTS.folders);
}

function saveTreeFilters() {
  const ls = treeFilterStore();
  if (!ls) return;
  try {
    ls.setItem("tsh_tree_filters", JSON.stringify({
      exts: state.treeExtFilter ? [...state.treeExtFilter] : null,
      folders: state.treeFolderFilter ? [...state.treeFolderFilter] : null,
    }));
  } catch (e) { /* storage may be unavailable */ }
}

function treeFiltersActive() {
  return state.treeExtFilter !== null || state.treeFolderFilter !== null;
}

function treeExtAllowed(fname) {
  if (!state.treeExtFilter) return true;
  if (!state.treeExtFilter.size) return false;
  return state.treeExtFilter.has(fileExt(fname));
}

function setTreeLoading(on) {
  const el = $("#tree-loading");
  if (el) el.hidden = !on;
}

async function loadFullTree() {
  state.fullTree = null;
  state.fullTreeExpanded = new Set();
  state.fullTreeCollapsed = new Set();
  state.treeCounts = null;
  setTreeLoading(true);
  try {
    const r = await api("/api/project_tree", { timeout: API_TIMEOUT_OPEN });
    const j = await r.json();
    if (j.ok) {
      state.fullTree = j.tree;
      computeTreeCounts(j.tree);
      // the filter menu is rebuilt from the scan; saved whitelist entries
      // that don't exist in this project are dropped so opening another
      // project never shows an empty tree
      sanitizeTreeFiltersToProject();
      updateToolButtons();
      return;
    }
  } catch (e) { /* fall through to the empty tree */ }
  finally { setTreeLoading(false); }
  state.fullTree = { n: "", d: [], f: [] };
  updateToolButtons();
}

// есть ли файл в дереве {n,d,f} (итеративно, деревья огромные)
function treeHasFile(tree, test) {
  if (!tree) return false;
  const stack = [tree];
  while (stack.length) {
    const nd = stack.pop();
    if (!nd) continue;
    for (const fn of (nd.f || [])) {
      try { if (test(String(fn))) return true; } catch (e) { /* дальше */ }
    }
    for (const sub of (nd.d || [])) stack.push(sub);
  }
  return false;
}

// кнопки инструментов активны только когда есть с чем работать:
// Uprising Map Editor — когда хоть в одном источнике есть shop_presets.xml,
// SWT Editor — когда есть .swt файлы. Иначе серые и неактивные.
function updateToolButtons() {
  const trees = [state.fullTree, state.gameTree, state.modTree];
  const hasUpr = trees.some(tr => treeHasFile(tr,
    fn => fn.toLowerCase() === "shop_presets.xml"));
  const hasSwt = trees.some(tr => treeHasFile(tr,
    fn => fn.toLowerCase().endsWith(".swt")));
  for (const id of ["#btn-uprising", "#landing-uprising"]) {
    const b = $(id);
    if (b) b.disabled = !hasUpr;
  }
  for (const id of ["#btn-swt", "#landing-swt"]) {
    const b = $(id);
    if (b) b.disabled = !hasSwt;
  }
}

function sanitizeTreeFiltersToProject() {
  if (!state.treeCounts) return;
  let changed = false;
  const prune = (filter, known) => {
    const kept = [...filter].filter(x => known.has(x));
    if (kept.length === filter.size) return filter;
    changed = true;
    return kept.length ? new Set(kept) : null;
  };
  if (state.treeExtFilter) {
    state.treeExtFilter = prune(state.treeExtFilter, state.treeCounts.exts);
  }
  if (state.treeFolderFilter) {
    state.treeFolderFilter = prune(state.treeFolderFilter, state.treeCounts.folders);
  }
  if (changed) saveTreeFilters();
}

function categorizeNodeFiles(files) {
  // returns category groups for a folder's file list, or null when nothing
  // matches a known unit-sheet file (random dirs stay ungrouped)
  if (!files || !files.length) return null;
  const lower = files.map(f => f.toLowerCase());
  const hit = i => TREE_CATEGORIES.find(c => c.match(lower[i]));
  const groups = [];
  let matched = false;
  for (const c of TREE_CATEGORIES) {
    const gf = files.filter((f, i) => {
      const h = hit(i);
      return h && h.key === c.key;
    });
    if (gf.length) { matched = true; groups.push({ key: c.key, icon: c.icon, label: t("cat_" + c.key) || c.key, files: gf }); }
  }
  if (!matched) return null;
  const rest = files.filter((f, i) => !hit(i));
  if (rest.length) groups.push({ key: "misc", icon: "doc.svg", label: t("cat_misc") || "misc", files: rest });
  return groups;
}

function computeTreeCounts(root) {
  const exts = new Map();
  const folders = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const countFiles = node => {
    let n = (node.f || []).length;
    for (const d of node.d || []) n += countFiles(d);
    return n;
  };
  (function walk(node) {
    for (const fname of node.f || []) bump(exts, fileExt(fname));
    for (const d of node.d || []) {
      folders.set(d.n.toLowerCase(),
        (folders.get(d.n.toLowerCase()) || 0) + countFiles(d));
      walk(d);
    }
  })(root);
  state.treeCounts = { exts, folders };
}

function filterFullTree(root) {
  // Annotates nodes in place: _k = kept subdirs, _fl = kept files,
  // _count = total kept files under the node, _en = folder filter allows it.
  // A folder matching the filter enables its WHOLE subtree (files still obey
  // the extension filter); non-matching folders stay as pass-through only
  // when they lead to an enabled subtree.
  const q = (state.treeFilter || "").toLowerCase();
  const noFolders = state.treeFolderFilter === null;
  function walk(node, enabled, isRoot) {
    const keptDirs = [];
    for (const d of node.d || []) {
      const en = (!isRoot && enabled) || noFolders ||
        state.treeFolderFilter.has(d.n.toLowerCase());
      if (walk(d, en, false)) keptDirs.push(d);
    }
    let files;
    if (q) files = (node.f || []).filter(f => f.toLowerCase().includes(q));
    else if (enabled || isRoot) files = (node.f || []).filter(treeExtAllowed);
    else files = [];
    node._k = keptDirs;
    node._fl = files;
    node._en = enabled || isRoot;
    let count = files.length;
    for (const d of keptDirs) count += d._count;
    node._count = count;
    return keptDirs.length > 0 || files.length > 0 ||
      (!!q && node.n.toLowerCase().includes(q));
  }
  walk(root, true, true);
}

function dirIcon(name, expanded) {
  const pair = TREE_DIR_ICONS[String(name).toLowerCase()];
  const fn = pair ? pair[expanded ? 1 : 0]
    : (expanded ? "folder__open.svg" : "folder.svg");
  return ICON_MAP[fn] || (ICON_BASE + fn);
}

// tapered indent: the first levels keep the comfortable step, deeper
// nesting compresses so a fully-open tree never drifts off the sidebar
function treeIndent(depth) {
  let x = 6;
  for (let d = 1; d <= depth; d++) x += d <= 2 ? 13 : (d <= 4 ? 9 : 6);
  return x;
}

function buildTreeChipRow(sec, collapsed) {
  const row = document.createElement("div");
  row.className = "overlay-head" + (collapsed ? "" : " expanded");
  row.title = t("tree_toggle") || "Свернуть/развернуть";
  row.innerHTML = `
    <svg class="chev ov-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>
    <span class="overlay-head-text">
      <span class="overlay-name"></span>
      <span class="overlay-path"></span>
    </span>`;
  row.querySelector(".overlay-name").textContent = sec.label;
  row.querySelector(".overlay-path").textContent = sec.subtitle || "";
  row.addEventListener("click", () => {
    const k = "ov::" + sec.key;
    state.treeCollapsed[k] = !state.treeCollapsed[k];
    renderTree();
  });
  return row;
}

function overlayLabel(name) {
  const known = { legion: "overlay_dlc_legion", resistance: "overlay_dlc_resistance" };
  return (name && t(known[String(name).toLowerCase()])) || "DLC " + name;
}

function overlaySubtitleDirs(node) {
  const names = (node._k || []).map(d => d.n);
  if (!names.length) return "";
  return names.slice(0, 3).join(" · ") + (names.length > 3 ? " +" + (names.length - 3) : "");
}

function buildOverlaySections(root) {
  // Chips follow the old overlay model: "Компания" = everything not under
  // the dlc folder, the dlc folder splits into per-mod chips (DLC Legion,
  // DLC Resistance, generic "DLC <name>" for the rest). Subtitles carry the
  // path from the mod root plus the section's own top-level dirs.
  // Корень следует за активным деревом: «Проект» -> папка мода,
  // «Игра» -> папка распакованных ассетов, «Мод» -> папка главного мода.
  const tv = treeViewRoot();
  const isGame = tv.view === "game";
  const rootPath = tv.root;
  const rootName = rootFolderName(rootPath) ||
    (tv.view === "project" ? (projectFolderName(state.project) || "") : "");
  const keyPfx = tv.pfx;
  const others = (root._k || []).filter(d => d.n.toLowerCase() !== "dlc");
  const dlc = (root._k || []).find(d => d.n.toLowerCase() === "dlc");
  const sections = [];
  const compCount = others.reduce((n, d) => n + d._count, 0) + (root._fl || []).length;
  if (compCount) {
    const dirs = overlaySubtitleDirs({ _k: others });
    sections.push({
      key: keyPfx + "basis",
      label: isGame ? (rootName || (t("overlay_basis") || "Компания"))
                    : (t("overlay_basis") || "Компания"),
      path: rootPath,
      subtitle: rootName + "\\" + (dirs ? "  " + dirs : ""),
      node: { _k: others, _fl: root._fl || [], _en: true, _count: compCount },
    });
  }
  if (dlc) {
    if ((dlc._fl || []).length) {
      sections.push({
        key: keyPfx + "dlc", label: t("overlay_dlc") || "DLC",
        path: rootPath + "\\dlc",
        subtitle: rootName + "\\DLC",
        node: { _k: [], _fl: dlc._fl, _en: true, _count: dlc._fl.length },
      });
    }
    for (const child of dlc._k || []) {
      const dirs = overlaySubtitleDirs(child);
      sections.push({
        key: keyPfx + "dlc::" + child.n.toLowerCase(), label: overlayLabel(child.n),
        path: rootPath + "\\dlc\\" + child.n,
        subtitle: rootName + "\\DLC\\" + child.n + (dirs ? "  " + dirs : ""),
        node: child,
      });
    }
  }
  return sections;
}

function collectOverlayRows(sections, capFiles) {
  const rows = [];
  let filesShown = 0;
  let truncated = false;
  const visit = (node, depth, path) => {
    for (const d of node._k || []) {
      const p = path + "\\" + d.n;
      const forced = state.fullTreeExpanded.has(p);
      const auto = !forced && !state.fullTreeCollapsed.has(p) &&
        (!d._en || (d._fl.length === 0 && d._k.length === 1 && d._count > 0));
      const expanded = !!state.treeFilter || forced || auto;
      rows.push({ kind: "dir", node: d, depth, path: p, expanded });
      if (expanded) visit(d, depth + 1, p);
    }
    const cats = state.treeFilter ? null : categorizeNodeFiles(node._fl || []);
    if (cats) {
      for (const g of cats) {
        const ck = "cat::" + path + "::" + g.key;
        const collapsed = !!state.treeCollapsed[ck];
        rows.push({ kind: "cat", group: g, depth, ck, collapsed, path });
        if (collapsed) continue;
        for (const fname of g.files) {
          if (filesShown >= capFiles) { truncated = true; return; }
          filesShown++;
          rows.push({ kind: "file", name: fname, depth: depth + 1, path: path + "\\" + fname });
        }
      }
      return;
    }
    for (const fname of node._fl || []) {
      if (filesShown >= capFiles) { truncated = true; return; }
      filesShown++;
      rows.push({ kind: "file", name: fname, depth, path: path + "\\" + fname });
    }
  };
  for (const sec of sections) {
    const collapsed = !state.treeFilter && !!state.treeCollapsed["ov::" + sec.key];
    rows.push({ kind: "chip", sec, collapsed });
    if (collapsed) continue;
    visit(sec.node, 1, sec.path);
  }
  return { rows, truncated };
}

function buildTreeCatRow(group, depth, ck, collapsed, path) {
  const row = document.createElement("div");
  row.className = "tree-cat" + (collapsed ? " collapsed" : "");
  row.style.paddingLeft = treeIndent(depth) + "px";
  row.title = t("tree_toggle") || "";
  row.innerHTML = `
    <svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>
    <img class="cat-icon" src="${ICON_BASE}${group.icon}" alt="">
    <span class="cat-name"></span>
    <span class="cat-count"></span>`;
  row.querySelector(".cat-name").textContent = group.label;
  row.querySelector(".cat-count").textContent = String(group.files.length);
  row.addEventListener("click", () => {
    state.treeCollapsed[ck] = !state.treeCollapsed[ck];
    renderTree();
  });
  // drag the whole subsection like a folder: every file inside travels with it
  row.draggable = true;
  row.addEventListener("dragstart", e => {
    const paths = (group.files || []).map(f => path + "\\" + f);
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData("text/tsh-files", treeDragPayload([], [{ name: group.label, paths }]));
    e.dataTransfer.setData("text/plain", paths.join("\n"));
    row.classList.add("dragging");
    const ghost = document.createElement("div");
    ghost.className = "tree-drag-ghost";
    ghost.textContent = `${group.label} (${paths.length})`;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 12, 12);
    setTimeout(() => ghost.remove(), 0);
  });
  row.addEventListener("dragend", () => row.classList.remove("dragging"));
  return row;
}

function appendTreeRows(container, rows, onDone) {
  let i = 0;
  const step = () => {
    const end = Math.min(i + TREE_RENDER_CHUNK, rows.length);
    const frag = document.createDocumentFragment();
    for (; i < end; i++) {
      const r = rows[i];
      frag.appendChild(r.kind === "chip"
        ? buildTreeChipRow(r.sec, r.collapsed)
        : r.kind === "cat"
          ? buildTreeCatRow(r.group, r.depth, r.ck, r.collapsed, r.path)
          : r.kind === "dir"
            ? buildTreeDirRow(r.node, r.depth, r.path, r.expanded)
            : buildTreeFileRow(r.name, r.depth, r.path));
    }
    container.appendChild(frag);
    if (i < rows.length) requestAnimationFrame(step);
    else if (onDone) onDone();
  };
  if (rows.length) requestAnimationFrame(step);
  else if (onDone) onDone();
}

function buildTreeDirRow(dir, depth, path, expanded) {
  const row = document.createElement("div");
  row.className = "tree-dir" + (expanded ? " expanded" : "");
  row.dataset.path = path;
  row.style.paddingLeft = treeIndent(depth) + "px";
  row.draggable = true;
  row.title = path;
  row.innerHTML = `
    <svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>
    <img class="file-icon" src="${dirIcon(dir.n, expanded)}" alt="">
    <span class="file-name"></span>
    <span class="file-meta"></span>`;
  row.querySelector(".file-name").textContent = dir.n;
  row.querySelector(".file-meta").textContent = dir._count ? String(dir._count) : "";
  row.addEventListener("click", () => {
    if (state.treeSel && state.treeSel.size) clearTreeSel();
    if (expanded) {
      state.fullTreeExpanded.delete(path);
      state.fullTreeCollapsed.add(path);
    } else {
      state.fullTreeCollapsed.delete(path);
      state.fullTreeExpanded.add(path);
    }
    renderTree();
  });
  row.addEventListener("dragstart", e => {
    const paths = [];
    (function collect(node, prefix) {
      for (const fname of node._fl || []) paths.push(prefix + "\\" + fname);
      for (const d of node._k || []) collect(d, prefix + "\\" + d.n);
    })(dir, path);
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData("text/tsh-files", treeDragPayload([], [{ name: dir.n, paths }]));
    e.dataTransfer.setData("text/plain", paths.join("\n"));
    row.classList.add("dragging");
    const ghost = document.createElement("div");
    ghost.className = "tree-drag-ghost";
    ghost.textContent = `${dir.n} / (${paths.length})`;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 12, 12);
    setTimeout(() => ghost.remove(), 0);
  });
  row.addEventListener("dragend", () => row.classList.remove("dragging"));
  return row;
}

function buildTreeFileRow(fname, depth, path) {
  const row = document.createElement("div");
  row.className = "tree-file";
  row.dataset.path = path;
  row.style.paddingLeft = treeIndent(depth) + "px";
  row.title = path;
  if (state.treeSel && state.treeSel.has(path)) row.classList.add("selected");
  if (state.editedFiles && state.editedFiles.has(path.toLowerCase())) {
    row.classList.add("edited");
    row.title = (t("edited_hint") || "Файл редактировался в Terminator Sheet") + "\n" + path;
  }
  row.draggable = true;
  row.innerHTML = `<img class="file-icon" src="${getFileIcon(fname)}" alt="">
    <span class="file-name"></span>`;
  row.querySelector(".file-name").textContent = fname;
  row.addEventListener("click", e => {
    if (e.ctrlKey || e.metaKey) {
      state.treeSel = state.treeSel || new Set();
      if (state.treeSel.has(path)) {
        state.treeSel.delete(path);
        row.classList.remove("selected");
      } else {
        state.treeSel.add(path);
        row.classList.add("selected");
      }
      return;
    }
    if (state.treeSel && state.treeSel.size) clearTreeSel();
    markActiveTreeFile(path);
    if (/\.swt$/i.test(fname)) openSwt(path);
    // shop_presets.xml из dlc/Resistance — файл карты Uprising: открываем картой;
    // базовые shop_presets (без секторов) — обычной таблицей
    else if (/^shop_presets\.xml$/i.test(fname) && /resistance/i.test(path)) openUprising(path);
    else if (TREE_EDITABLE_EXTS.has(fileExt(fname))) openFile(path);
    else toast(t("tree_not_editable") || "Этот формат пока не открывается в редакторе", "");
  });
  row.addEventListener("dragstart", e => {
    const sel = state.treeSel || new Set();
    const list = sel.has(path) ? [...sel] : [path];
    if (!sel.has(path)) { state.treeSel = new Set([path]); markActiveTreeFile(path); }
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData("text/tsh-files", treeDragPayload(list));
    e.dataTransfer.setData("text/plain", list.join("\n"));
    row.classList.add("dragging");
    if (row.setDragImage) {
      const ghost = document.createElement("div");
      ghost.className = "tree-drag-ghost";
      ghost.textContent = list.length > 1
        ? `${list.length} ${t("files_n") || "files"}`
        : fname;
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 12, 12);
      setTimeout(() => ghost.remove(), 0);
    }
  });
  row.addEventListener("dragend", () => row.classList.remove("dragging"));
  return row;
}

// ---------- глобальный источник «Проект | Игра | Мод» ----------
// Один выбор на всё приложение: древо (Главная / Создать мод / SWT) и карта.
// Стороны сравнения — независимые, красятся тем же компонентом (.src-seg).
const SRC_ORDER = ["project", "game", "mod"];

function srcAvail(v) {
  if (v === "project") return !!((state.project && state.project.root) || "");
  if (v === "game") return !!((state.config && state.config.unpacked_path) || "");
  if (v === "mod") return !!((state.config && state.config.mod_path) || "");
  return false;
}

function srcRoot(v) {
  if (v === "game") return ((state.config && state.config.unpacked_path) || "");
  if (v === "mod") return ((state.config && state.config.mod_path) || "");
  return ((state.project && state.project.root) || "");
}

// первый доступный источник, кроме except (для сторон сравнения)
function srcFirst(except) {
  for (const v of SRC_ORDER) {
    if (v !== except && srcAvail(v)) return v;
  }
  return null;
}

// корень активного дерева + префикс ключей секций (чтобы сворачивания
// разных источников не пересекались)
function treeViewRoot() {
  const v = state.treeView;
  if (v === "game") return { view: v, root: srcRoot("game"), pfx: "g::" };
  if (v === "mod") return { view: v, root: srcRoot("mod"), pfx: "m::" };
  return { view: "project", root: srcRoot("project"), pfx: "" };
}

// активное дерево: «Проект» (мод), «Игра» (распакованные ассеты) или «Мод» (mod_path)
function treeRoot() {
  const v = state.treeView;
  if (v === "game") return state.gameTree;
  if (v === "mod") return state.modTree;
  return state.fullTree;
}

async function loadGameTree() {
  if (state.gameTree) return;
  state.gameTree = { n: "", d: [], f: [] };
  setTreeLoading(true);
  try {
    const r = await api("/api/game_tree", { timeout: API_TIMEOUT_OPEN });
    const j = await r.json();
    if (j.ok && j.tree) state.gameTree = j.tree;
  } catch (e) { /* остаётся пустое дерево */ }
  finally { setTreeLoading(false); updateToolButtons(); }
}

async function loadModTree() {
  if (state.modTree) return;
  state.modTree = { n: "", d: [], f: [] };
  setTreeLoading(true);
  try {
    const r = await api("/api/mod_tree", { timeout: API_TIMEOUT_OPEN });
    const j = await r.json();
    if (j.ok && j.tree) state.modTree = j.tree;
  } catch (e) { /* остаётся пустое дерево */ }
  finally { setTreeLoading(false); updateToolButtons(); }
}

// фоновый обход дерева завершился: если этот источник активен — пересчитать
// счётчики и перерисовать (до этого древо показывало «Загрузка…»)
function bgTreeDone(v) {
  if (state.treeView !== v) return;
  state.treeCounts = null;
  const root = treeRoot();
  if (root) computeTreeCounts(root);
  renderTree();
  updateToolButtons();
}

// клик по вкладке древа: доступная — переключение источника; недоступная —
// ведёт к выбору пути: проект — окно выбора папки, игра/мод — настройки
// на вкладке путей с анимированной подсветкой нужной строки
function sbTabClick(v) {
  if (srcAvail(v)) { setSrc(v); return; }
  // проект прошлого запуска ещё грузится фоном: клик — не «проекта нет»,
  // диалог не открываем, просто показываем что идёт загрузка
  if (v === "project") {
    if (state.bootLoading) { toast(t("loading") || "Загрузка…"); return; }
    openProjectDialog();
    return;
  }
  openSettingsPaths(v === "mod" ? "set-mod-path" : "set-unpacked");
}

// настройки сразу на вкладке путей + пульсирующая подсветка строки inputId
function openSettingsPaths(inputId) {
  openSettings();
  const tab = document.querySelector('.settings-tabs .st-tab[data-st="paths"]');
  if (tab) tab.click();
  const inp = document.getElementById(inputId);
  const row = inp ? inp.closest("label.setting-row") : null;
  if (!row) return;
  row.scrollIntoView({ block: "nearest" });
  row.classList.remove("set-flash");
  void row.offsetWidth;   // перезапуск анимации при повторных кликах
  row.classList.add("set-flash");
  setTimeout(() => row.classList.remove("set-flash"), 3000);
  try { inp.focus({ preventScroll: true }); } catch (e) { /* noop */ }
}

// смена глобального источника: древо + переключатели + карта (с confirm при грязной карте)
async function setSrc(v) {
  if (!srcAvail(v)) return;
  if (state.treeView === v) { paintSrcSwitches(); return; }
  if (state.uprising.path && state.uprising.rows && state.uprising.dirty) {
    const choice = await askConfirm({
      title: t("upr_src_change") || "Сменить источник",
      message: t("upr_src_dirty") ||
        "Несохранённые изменения карты будут потеряны. Продолжить?",
      buttons: [
        { id: "ok", label: t("continue") || "Продолжить", kind: "danger" },
        { id: "cancel", label: t("cancel"), kind: "ghost" },
      ],
    });
    if (choice !== "ok") { paintSrcSwitches(); return; }
  }
  state.treeView = v;
  try { localStorage.setItem("tsh_src", v); } catch (e) { /* приватный режим */ }
  if (v === "game") await loadGameTree();
  if (v === "mod") await loadModTree();
  // счётчики для меню фильтров следуют за активным деревом; сами фильтры общие
  state.treeCounts = null;
  const root = treeRoot();
  if (root) computeTreeCounts(root);
  paintSrcSwitches();
  paintTreeTitle();
  renderTree();
  // открытая карта перечитывается из нового корня (правки уже подтверждены выше)
  if (state.tabs.some(tb => tb.id === "uprising")) {
    state.uprising.dirty = false;
    uprMarkClean();
    const path = await uprFindFile();
    state.uprising.path = "";
    state.uprising.rows = null;
    if (path) await openUprising(path);
    else uprPaintNofile();
    uprLoadSysnames();
  }
}

// дерево из сайдбара — тот же глобальный источник
async function setTreeView(view) {
  await setSrc(view);
}

function paintTreeTitle() {
  const el = $("#sidebar-title");
  if (!el) return;
  const tv = treeViewRoot();
  if (tv.root) {
    const parts = String(tv.root).split(/[\\/]/).filter(Boolean);
    el.textContent = parts.pop() || tv.root;
    el.title = tv.root;
  } else {
    el.textContent = t("open_project");
    el.title = "";
  }
}

function paintSrcSwitches() {
  const v = state.treeView;
  const tabs = { project: $("#sb-tab-project"), game: $("#sb-tab-game"), mod: $("#sb-tab-mod") };
  const tabsBox = $("#sidebar-tabs");
  if (tabsBox) {
    const any = SRC_ORDER.some(srcAvail);
    tabsBox.hidden = !any;
    for (const s of SRC_ORDER) {
      const b = tabs[s];
      if (!b) continue;
      // hidden не прячет (.sb-tab { display:flex } перебивает атрибут) —
      // вкладки видны всегда, недоступные приглушены классом inactive
      b.hidden = !srcAvail(s);
      b.classList.toggle("active", v === s && srcAvail(s));
      b.classList.toggle("inactive", !srcAvail(s));
      b.title = srcRoot(s);
    }
  }
  // сегмент карты: недоступные пункты темнеют (кнопка is-off), индикатор едет.
  // is-off вместо disabled: серая кнопка кликабельна и ведёт в настройки
  // (нативный disabled гасит клики — до настроек было не добраться).
  // unavailable current source -> no active button and no yellow pill
  // (иначе «Проект» подсвечен по умолчанию даже без пути)
  const seg = $("#upr-src");
  if (seg) {
    const ok = srcAvail(v);
    seg.dataset.pos = ok ? String(Math.max(0, SRC_ORDER.indexOf(v))) : "-1";
    $$(".src-seg-btn", seg).forEach(b => {
      const s = b.dataset.src;
      const sok = srcAvail(s);
      b.classList.toggle("active", ok && v === s && sok);
      b.classList.toggle("is-off", !sok);
      b.removeAttribute("disabled");
      b.setAttribute("aria-disabled", String(!sok));
      b.title = srcRoot(s) || "";
    });
  }
  paintCmpSrc();
}

function updateSidebarTabs() {
  paintTreeTitle();
  paintSrcSwitches();
}

function renderTree() {
  const tree = $("#project-tree");
  tree.innerHTML = "";
  // без проекта древо не исчезает: показывают «Игру»/«Мод», если пути заданы
  if (!srcAvail(state.treeView)) return;
  const root = treeRoot();
  if (!root) {
    const msg = document.createElement("div");
    msg.className = "tree-empty";
    msg.textContent = t("loading") || "Загрузка…";
    tree.appendChild(msg);
    return;
  }
  filterFullTree(root);
  const sections = buildOverlaySections(root);
  if (!sections.length) {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    empty.textContent = t("tree_empty") || "";
    tree.appendChild(empty);
    updateTreeFilterButton();
    return;
  }
  const cap = state.treeFilter ? TREE_MATCH_CAP : Infinity;
  const { rows, truncated } = collectOverlayRows(sections, cap);
  const msg = truncated ? (t("tree_matches_cap") || "") : "";
  appendTreeRows(tree, rows, msg ? () => {
    const el = document.createElement("div");
    el.className = "tree-empty";
    el.textContent = msg;
    tree.appendChild(el);
  } : null);
  updateTreeFilterButton();
}

function populateTreeFilterMenu() {
  if (!state.treeCounts) return;
  const q = (($("#tfm-search") || {}).value || "").trim().toLowerCase();
  const fill = (box, entries, active, kind) => {
    box.innerHTML = "";
    const items = entries.filter(([name]) => !q || name.includes(q));
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "tfm-empty";
      empty.textContent = "—";
      box.appendChild(empty);
      return;
    }
    for (const [name, count] of items) {
      const label = document.createElement("label");
      label.className = "tfm-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !active || active.has(name);
      cb.addEventListener("change", () => {
        // first interaction on "show all" (null) materializes a whitelist
        // with everything visible, so unchecking one item narrows the view
        const all = kind === "ext"
          ? [...state.treeCounts.exts.keys()]
          : [...state.treeCounts.folders.keys()];
        let target = kind === "ext" ? state.treeExtFilter : state.treeFolderFilter;
        if (!target) target = new Set(all);
        if (cb.checked) target.add(name);
        else target.delete(name);
        if (kind === "ext") state.treeExtFilter = target;
        else state.treeFolderFilter = target;
        saveTreeFilters();
        renderTree();
      });
      const nm = document.createElement("span");
      nm.className = "tfm-name";
      nm.textContent = kind === "ext" ? "." + name : name;
      const ct = document.createElement("span");
      ct.className = "tfm-count";
      ct.textContent = String(count);
      label.appendChild(cb);
      label.appendChild(nm);
      label.appendChild(ct);
      box.appendChild(label);
    }
  };
  fill($("#tfm-exts"), [...state.treeCounts.exts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), state.treeExtFilter, "ext");
  fill($("#tfm-folders"), [...state.treeCounts.folders.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), state.treeFolderFilter, "folder");
  updateTreeFilterButton();
}

function updateTreeFilterButton() {
  const btn = $("#tree-filter-btn");
  if (btn) btn.classList.toggle("active", treeFiltersActive());
}

function hideTreeFilterMenu() {
  const menu = $("#tree-filter-menu");
  if (menu) menu.hidden = true;
}

function markActiveTreeFile(path) {
  const np = normPath(path);
  $$("#project-tree .tree-file").forEach(el => {
    el.classList.toggle("active", normPath(el.dataset.path) === np);
  });
}

// ---------- project ----------
async function openProjectDialog() {
  const path = await pickFolder();
  if (!path) return;
  await loadProject(path);
}

// folder name shown in the sidebar header (title)
function projectFolderName(proj) {
  if (!proj || !proj.root) return t("open_project");
  const parts = String(proj.root).split(/[\\/]/).filter(Boolean);
  return parts.pop() || proj.root;
}

async function loadProject(path) {
  showTabLoading("welcome", true);
  try {
    const r = await api("/api/open_project", { method: "POST", body: JSON.stringify({ path }), timeout: API_TIMEOUT_OPEN });
    const j = await r.json();
    showTabLoading("welcome", false);
    if (!j.ok) { toast(j.error || "error", "err"); return; }
    state.project = j.project;
    // имена из locale-XML — отдельным фоновым запросом (см. loadDisplayNames)
    state.nameMap = {};
    loadDisplayNames(j.project.root);
    await loadEditedMarks(j.project.root);
    await loadFullTree();
    state.treeView = "project";
    try { localStorage.setItem("tsh_src", "project"); } catch (e) { /* приватный режим */ }
    renderTree();
    updateSidebarTabs();
    // title = name of the selected folder, not a static label
    $("#sidebar-title").textContent = projectFolderName(j.project);
    updateSidebarVisibility();
    // Switch to welcome tab to show the project tree
    activateTab("welcome");
  } catch (e) {
    showTabLoading("welcome", false);
    toast("Failed to load project: " + e.message, "err");
  }
}

async function openFileDialog() {
  const path = await pickFile();
  if (!path) return;
  await openFile(path);
}

// локализованные имена (sysname -> имя) отдельным фоновым запросом: парсинг
// всех locale-XML на холодном HDD держит ответ минутами, open_project его
// больше не ждёт — имена дотягиваются после старта, грид перерисовывается
async function loadDisplayNames(root) {
  if (!root) return;
  try {
    const r = await api("/api/display_names?root=" + encodeURIComponent(root)
      + "&lang=" + encodeURIComponent(state.config.language || "ru"),
      { timeout: API_TIMEOUT_OPEN });
    const j = await r.json();
    if (j && j.ok && j.names) {
      state.nameMap = j.names;
      if (state.currentFile && state.currentFile.rows) renderGrid();
    }
  } catch (e) { /* имена не критичны: грид работает на sysname */ }
}

// ---------- links ----------
// Внешний drop от второго инстанса / нативного слоя: пути уже проверены,
// открываем папку как проект или XML-файлы по вкладкам.
window.__tshExternalDrop = function (data) {
  if (!data) return;
  if (data.folder) { loadProject(data.folder); return; }
  handleExternalPaths((data.files || []).filter(p => /\.(xml|swt)$/i.test(p || "")),
    data.dirs || []);
};

async function loadLinks(retry = 0) {
  if (!state.currentFile) { state.links = []; return; }
  const p = state.currentFile.path;
  try {
    const r = await api("/api/links?path=" + encodeURIComponent(p));
    const j = await r.json();
    if (j.ok && j.pending) {
      // фоновая индексация может занять минуту на больших проектах
      if (retry < 40) { setTimeout(() => loadLinks(retry + 1), 3000); }
      return;
    }
    const had = state.links.length > 0;
    state.links = (j.ok && j.links) || [];
    // ссылки кэшируются на вкладке: клик по вкладке больше не перезапрашивает
    const activeTab = state.tabs.find(t2 => t2.id === state.activeTabId);
    if (activeTab && activeTab.type === "file" &&
        normPath(activeTab.path || "") === normPath(p)) {
      activeTab.links = state.links;
      activeTab.linksLoaded = true;
    }
    // repaint the accent link buttons as soon as the links are known - they
    // must be visible right after opening, not only after the first edit
    if ((state.links.length || had) && state.currentFile &&
        state.currentFile.path === p &&
        state.currentFile.rows && state.currentFile.rows.length) {
      renderGrid();
    }
  } catch (e) { state.links = []; }
}

async function followLink(link) {
  // openFile reuses the existing tab when present and scrolls after render
  await openFile(link.target_file, { scrollRow: link.target_row });
  toast(link.value);
}
function beginEdit(tr, ri, ci, initVal) {
  const td = tr.children[ci];
  if (!td || td.querySelector(".cell-input")) return;
  const val = state.currentFile.rows[ri].values[ci];
  const input = document.createElement("input");
  input.className = "cell-input";
  input.value = initVal != null ? String(initVal) : val;
  td.textContent = "";
  td.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const commit = async () => {
    if (done) return; done = true;
    const newVal = input.value;
    // rebuild the full cell content (keeps the friendly-name sub and link mark)
    renderCellContent(td, ri, ci, newVal);
    if (state.find.active && state.find.keySet.has(ri + ":" + ci)) td.classList.add("find-hit");
    if (newVal !== val) {
      const activeTab = state.tabs.find(t => t.id === state.activeTabId);
      const r = await api("/api/edit", { method: "POST",
        body: JSON.stringify({ path: state.currentFile.path, row: ri, col: ci, value: newVal }) });
      const j = await r.json();
      if (j.ok) {
        state.currentFile.rows[ri].values[ci] = newVal;
        setUndoRedoButtons(!!j.can_undo, !!j.can_redo);
        if (activeTab) activeTab.dirty = j.saved ? false : true;
        state.dirty = j.saved ? false : true;
        if (j.saved) noteSaved(state.currentFile && state.currentFile.path);
        updateDirty();
        renderTabBar(); // update dirty indicator
      }
      else toast("edit error", "err");
    }
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", ev => {
    if (ev.key === "Enter") { input.blur(); }
    else if (ev.key === "Escape") { done = true; renderCellContent(td, ri, ci, val); }
  });
}

// ---------- toolbar actions ----------
function markDirty() {
  state.dirty = true;
  updateDirty();
}

function updateDirty() {
  $("#dirty-dot").classList.toggle("on", state.dirty);
  if (state.currentFile) {
    const sheetTag = state.currentFile.sheets && state.currentFile.sheets.length > 1
      ? ` [${state.currentFile.sheet_name}]` : "";
    const p = state.currentFile.path;
    const fp = $("#file-path");
    fp.textContent = p + sheetTag + (state.dirty ? " ●" : "");
    fp.title = p + "  (клик — показать в папке)";
  }
}

// Кнопка «исправить файл»: пересчитать ss:ExpandedRowCount/ColumnCount по
// факту. Именно расхождение этих счётчиков заставляет Excel отказываться
// открывать мод-файлы (WPS открывает, но ругается). Фиксим только по кнопке.
async function fixCurrentFile() {
  // путь с активной вкладки: карта Uprising и SWT живут не в currentFile
  let path = state.currentFile ? state.currentFile.path : "";
  const onUprising = state.activeTabId === "uprising";
  if (onUprising) path = state.uprising.path || "";
  if (state.activeTabId === "swt") path = (state.swt && state.swt.path) || "";
  if (!path) { toast(t("no_file"), "err"); return; }
  const choice = await askConfirm({
    title: t("fix_file_title"),
    message: t("fix_file_msg"),
    buttons: [
      { id: "ok", label: t("fix_file_apply") },
      { id: "cancel", label: t("cancel"), kind: "ghost" },
    ],
  });
  if (choice !== "ok") return;
  try {
    const r = await api("/api/fix_file", { method: "POST",
      body: JSON.stringify({ path }) });
    const j = await r.json();
    if (!j.ok) { toast((j.error || t("fix_file_failed")), "err"); return; }
    const changed = j.changed || [];
    const styles = j.styles || [];
    if (!changed.length && !styles.length) { toast(t("fix_file_nothing"), "ok"); return; }
    const detail = changed.map(c => c.attr + ": " + c.old + " \u2192 " + c.new)
      .concat(styles.length ? [t("fix_styles_added") + ": " + styles.join(", ")] : [])
      .join("; ");
    toast((j.saved ? t("fix_file_done") : t("fix_file_failed")) + " " + detail,
          j.saved ? "ok" : "err");
    if (onUprising && j.saved) {
      // файл карты правился на диске — перечитать в карту
      state.uprising.rows = null;
      state.uprising.dirty = false;
      await openUprising(path);
    }
  } catch (e) {
    toast(t("fix_file_failed") + " " + (e && e.message ? e.message : ""), "err");
  }
}

// единая точка сохранения для кнопки на тулбаре и Ctrl+S: сохраняет то,
// что открыто на АКТИВНОЙ вкладке (раньше кнопка не работала на SWT/Uprising).
// popup=true: защищённый файл всегда спрашивает куда (кнопка шапки, Ctrl+Shift+S);
// иначе Ctrl+S использует запомненный выбор.
async function saveActive(popup) {
  if (state.activeTabId === "swt") return swtSaveGuarded(!!popup);
  if (state.activeTabId === "uprising") return uprSaveGuarded(!!popup);
  return saveCurrent(!!popup);
}

// ---------- защита распакованной игры ----------
async function guardCheck(path) {
  try {
    const r = await api("/api/guard_check", { method: "POST",
      body: JSON.stringify({ path }) });
    return await r.json();
  } catch (e) { return { ok: false }; }
}

let guardResolver = null;
let guardObserved = false;

// попап: куда сохранить защищённый файл. Возвращает "project"|"mod"|null.
function askGuardSave(src, chk) {
  return new Promise(resolve => {
    const modal = $("#guard-modal");
    if (!guardObserved) {
      guardObserved = true;
      new MutationObserver(() => {
        if (modal.hidden && guardResolver) {
          const r = guardResolver; guardResolver = null; r(null);
        }
      }).observe(modal, { attributes: true, attributeFilter: ["hidden"] });
    }
    guardResolver = resolve;
    const fEl = $("#guard-file");
    const bP = $("#guard-to-project");
    const bM = $("#guard-to-mod");
    const bSave = $("#guard-save");
    const bCancel = $("#guard-cancel");
    let sel = null;
    fEl.textContent = src;
    bP.hidden = !chk.project;
    bM.hidden = !chk.mod;
    // имя в скобках — жёлтым чипом (guard-chip), выбор не меняет размер
    // кнопок: никакого font-weight переключения, только рамка/фон/кружок
    const paintOpt = (b, label, dest) => {
      b.textContent = "";
      b.append(document.createTextNode(label));
      if (dest) {
        b.append(document.createTextNode(" "));
        const c = document.createElement("span");
        c.className = "guard-chip";
        c.textContent = dest.name;
        b.append(c);
      }
    };
    paintOpt(bP, t("guard_to_project") || "Сохранить изменённый файл в «проект»",
      chk.project);
    paintOpt(bM, t("guard_to_mod") || "Сохранить изменённый файл в «мод»",
      chk.mod);
    if (chk.project && !chk.mod) sel = "project";
    if (chk.mod && !chk.project) sel = "mod";
    const paint = () => {
      bP.classList.toggle("sel", sel === "project");
      bM.classList.toggle("sel", sel === "mod");
    };
    paint();
    bP.onclick = () => { sel = "project"; paint(); };
    bM.onclick = () => { sel = "mod"; paint(); };
    const done = v => {
      guardResolver = null;
      bSave.classList.remove("busy");
      modal.hidden = true;
      resolve(v);
    };
    bCancel.onclick = () => done(null);
    bSave.onclick = () => {
      if (!sel) return;
      bSave.classList.add("busy"); // анимация сохранения
      setTimeout(() => done(sel), 450);
    };
    bSave.classList.remove("busy");
    modal.hidden = false;
  });
}

// обёртка сейва: защищённый путь уходит в проект/мод через попап или
// запомненный выбор; обычный путь сохраняется как раньше.
async function guardedSave(kind, src, doSave, popup) {
  if (state.config.guard_unpacked === false) { await doSave(null); return; }
  const chk = await guardCheck(src);
  if (!chk.ok || !chk.guarded) { await doSave(null); return; }
  let target = null;
  if (!popup && state.guardChoice && chk[state.guardChoice]) target = state.guardChoice;
  if (!target) {
    if (!chk.project && !chk.mod) {
      toast(t("guard_no_dest") || "Задай путь проекта или мода в настройках", "err");
      return;
    }
    target = await askGuardSave(src, chk);
    if (!target) return;
  }
  state.guardChoice = target;
  await doSave(target);
}

async function saveAsTo(src, kind, target, doc) {
  const body = { src, kind, target };
  if (doc) body.doc = doc;
  const r = await api("/api/save_as", { method: "POST", body: JSON.stringify(body) });
  return r.json();
}

async function saveCurrent(popup) {
  if (!state.currentFile) return;
  return guardedSave("file", state.currentFile.path, async target => {
    if (target) {
      const j = await saveAsTo(state.currentFile.path, "file", target);
      if (j.ok && j.saved) {
        state.dirty = false;
        const activeTab = state.tabs.find(t => t.id === state.activeTabId);
        if (activeTab) activeTab.dirty = false;
        updateDirty();
        renderTabBar();
        toast((t("save_success") || "Сохранено") + " → " + j.dst, "ok");
        // защита скопировала в проект/мод: дальше правим копию —
        // открываем её в новой вкладке
        if (j.dst) await openFile(j.dst);
      }
      else toast((j.error || t("save_failed")), "err");
      return;
    }
    await saveCurrentDirect();
  }, popup);
}

async function saveCurrentDirect() {
  if (!state.currentFile) return;
  const r = await api("/api/save", { method: "POST",
    body: JSON.stringify({ path: state.currentFile.path }) });
  const j = await r.json();
  if (j.ok) {
    state.dirty = false;
    if (j.saved) noteSaved(state.currentFile.path);
    const activeTab = state.tabs.find(t => t.id === state.activeTabId);
    if (activeTab) activeTab.dirty = false;
    updateDirty();
    renderTabBar();
    toast(t("save_success"), "ok");
  }
  else toast((j.error || t("save_failed")), "err");
}

async function addRow() {
  if (!state.currentFile) return;
  const r = await api("/api/add_row", { method: "POST",
    body: JSON.stringify({ path: state.currentFile.path, values: null }) });
  const j = await r.json();
  if (j.ok) {
    state.currentFile.rows.push({ values: Array(state.currentFile.columns.length).fill(""), key: "" });
    state.dirty = j.saved ? false : true;
    if (j.saved) noteSaved(state.currentFile && state.currentFile.path);
    const activeTab = state.tabs.find(t => t.id === state.activeTabId);
    if (activeTab) activeTab.dirty = state.dirty;
    updateDirty();
    renderTabBar();
    setUndoRedoButtons(!!j.can_undo, !!j.can_redo);
    await renderGrid();
  }
}

async function deleteRow() {
  if (!state.currentFile || state.selectedRow == null) { toast(t("no_file")); return; }
  const r = await api("/api/delete_row", { method: "POST",
    body: JSON.stringify({ path: state.currentFile.path, row: state.selectedRow }) });
  const j = await r.json();
  if (j.ok) {
    state.currentFile.rows.splice(state.selectedRow, 1);
    state.selectedRow = null;
    state.dirty = j.saved ? false : true;
    if (j.saved) noteSaved(state.currentFile && state.currentFile.path);
    const activeTab = state.tabs.find(t => t.id === state.activeTabId);
    if (activeTab) activeTab.dirty = state.dirty;
    updateDirty();
    renderTabBar();
    setUndoRedoButtons(!!j.can_undo, !!j.can_redo);
    await renderGrid();
  }
}

async function addColumn() {
  if (!state.currentFile) return;
  const name = await askPrompt({
    title: t("add_column") + " (name)",
    okLabel: t("add_column"),
  });
  if (!name) return;
  const r = await api("/api/add_column", { method: "POST",
    body: JSON.stringify({ path: state.currentFile.path, name }) });
  const j = await r.json();
  if (j.ok) {
    const f = state.currentFile;
    f.columns.push(name); f.comments.push(null);
    f.rows.forEach(rw => rw.values.push(""));
    state.dirty = j.saved ? false : true;
    if (j.saved) noteSaved(state.currentFile && state.currentFile.path);
    const activeTab = state.tabs.find(t => t.id === state.activeTabId);
    if (activeTab) activeTab.dirty = state.dirty;
    updateDirty();
    renderTabBar();
    setUndoRedoButtons(!!j.can_undo, !!j.can_redo);
    await renderGrid();
  }
}

async function deleteColumnAt(ci) {
  if (!state.currentFile) return;
  if (ci == null || ci < 0 || ci >= state.currentFile.columns.length) return;
  const r = await api("/api/delete_column", { method: "POST",
    body: JSON.stringify({ path: state.currentFile.path, col: ci }) });
  const j = await r.json();
  if (j.ok) {
    state.currentFile.columns.splice(ci, 1);
    state.currentFile.comments.splice(ci, 1);
    state.currentFile.rows.forEach(rw => rw.values.splice(ci, 1));
    state.dirty = j.saved ? false : true;
    if (j.saved) noteSaved(state.currentFile && state.currentFile.path);
    const activeTab = state.tabs.find(tb => tb.id === state.activeTabId);
    if (activeTab) activeTab.dirty = state.dirty;
    updateDirty();
    renderTabBar();
    setUndoRedoButtons(!!j.can_undo, !!j.can_redo);
    await renderGrid();
  } else toast(j.error, "err");
}

// ---------- context menu (rows / header cells) ----------
async function copyText(txt) {
  try {
    await navigator.clipboard.writeText(txt);
    toast(t("copied_buffer") || "Скопировано в буфер", "ok");
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = txt;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); toast(t("copied_buffer") || "Скопировано в буфер", "ok"); }
    catch (e2) { toast("copy failed", "err"); }
    ta.remove();
  }
}

async function duplicateRow(ri) {
  if (!state.currentFile || ri == null) return;
  const values = state.currentFile.rows[ri].values.slice();
  const r = await api("/api/add_row", { method: "POST",
    body: JSON.stringify({ path: state.currentFile.path, values }) });
  const j = await r.json();
  if (j.ok) {
    state.currentFile.rows.push({ values, key: "" });
    state.dirty = j.saved ? false : true;
    if (j.saved) noteSaved(state.currentFile && state.currentFile.path);
    const activeTab = state.tabs.find(tb => tb.id === state.activeTabId);
    if (activeTab) activeTab.dirty = state.dirty;
    updateDirty();
    renderTabBar();
    await renderGrid();
  }
}

// write a value into a cell (used by paste): backend edit + in-place repaint
async function applyCellEdit(ri, ci, newVal) {
  const f = state.currentFile;
  if (!f || ri == null || ci == null) return;
  if (String(f.rows[ri].values[ci]) === String(newVal)) return;
  const r = await api("/api/edit", { method: "POST",
    body: JSON.stringify({ path: f.path, row: ri, col: ci, value: newVal }) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "edit error", "err"); return; }
  f.rows[ri].values[ci] = newVal;
  setUndoRedoButtons(!!j.can_undo, !!j.can_redo);
  const activeTab = state.tabs.find(tb => tb.id === state.activeTabId);
  if (activeTab) activeTab.dirty = j.saved ? false : true;
  state.dirty = j.saved ? false : true;
  if (j.saved) noteSaved(state.currentFile && state.currentFile.path);
  updateDirty();
  renderTabBar();
  const table = getActiveGridTable();
  const td = table && table.querySelector(`td[data-row="${ri}"][data-col="${ci}"]`);
  if (td) {
    renderCellContent(td, ri, ci, newVal);
    if (state.find.active && state.find.keySet.has(ri + ":" + ci)) td.classList.add("find-hit");
  }
}

function setupContextMenu() {
  const menu = $("#ctx-menu");
  let ctxRow = null, ctxCol = null, ctxOnHead = false;
  let ctxCmp = null;   // {side, mode, i (visible idx) | ri, onHead}
  const showActs = acts => {
    $$(".ctx-item", menu).forEach(it => {
      it.style.display = acts.includes(it.dataset.act) ? "" : "none";
    });
    // the separator above "open linked file" only shows with the item
    const linkSep = menu.querySelector('[data-sep="link"]');
    if (linkSep) linkSep.style.display = acts.includes("open-link") ? "" : "none";
    // paste is grey while nothing has been copied
    const paste = menu.querySelector('[data-act="paste-cell"]');
    if (paste) paste.classList.toggle("disabled", state.clipboard == null);
  };

  document.addEventListener("contextmenu", e => {
    // сравнение: своё контекстное меню на ячейках/заголовках обеих панелей
    const cmpGrid = e.target.closest(".cmp-grid");
    if (cmpGrid) {
      const pane = cmpGrid.closest(".cmp-pane");
      const side = pane && pane.id === "cmp-pane-right" ? "right" : "left";
      const td = e.target.closest("tbody td:not(.td-st):not(.cmp-absent):not(.cmp-search-none)");
      const th = e.target.closest("thead th:not(.td-st)");
      if (!td && !th) { menu.hidden = true; return; }
      e.preventDefault();
      ctxCmp = { side, onHead: !td };
      if (td) {
        const tr = td.parentElement;
        ctxCmp.ri = tr.dataset.rowIndex != null ? Number(tr.dataset.rowIndex) : null;
        ctxCmp.i = tr.dataset.rowIndex != null ? null
          : Array.prototype.indexOf.call(tr.parentElement.children, tr);
        ctxCmp.ci = Array.prototype.indexOf.call(tr.children, td) - 1; // minus status column
        const acts = ["copy-cell", "copy-row"];
        const inDiff = state.compare && !state.compare.preview && state.cmpCtx;
        if (inDiff && side === "right") {
          acts.push("transfer-cell", "transfer-row");
        } else if (!state.compare) {
          acts.unshift("cut-cell", "paste-cell");
        }
        // полный набор правки XML в сравнении: добавление/удаление строк
        // работает в превью и в дифе, на любой панели
        if (!state.compare || inDiff) {
          acts.push("add-row");
          if (ctxCmp.ri != null) acts.push("del-row");
        }
        showActs(acts);
      } else {
        ctxCmp.ci = Array.prototype.indexOf.call(th.parentElement.children, th) - 1;
        const acts = ["copy-col", "add-col", "del-col"];
        if (state.compare && !state.compare.preview && state.cmpCtx && side === "right") {
          acts.push("transfer-col");
        }
        showActs(acts);
      }
      menu.hidden = false;
      const mw = menu.offsetWidth, mh = menu.offsetHeight;
      menu.style.left = Math.min(e.clientX, window.innerWidth - mw - 8) + "px";
      menu.style.top = Math.min(e.clientY, window.innerHeight - mh - 8) + "px";
      return;
    }
    ctxCmp = null;
    const th = e.target.closest(".grid thead th.col-head");
    const td = e.target.closest(".grid tbody tr:not(.tr-add) td");
    if (!th && !td) { menu.hidden = true; return; }
    e.preventDefault();
    ctxRow = ctxCol = null;
    ctxOnHead = false;
    if (td) {
      ctxRow = Number(td.dataset.row);
      ctxCol = Number(td.dataset.col);
      selectRow(ctxRow);
      const acts = ["copy-cell", "cut-cell", "paste-cell", "copy-row", "dup-row", "del-row"];
      // a linked file exists for this row -> offer to open it (PKM)
      if (state.links.some(l => l.row === ctxRow)) acts.unshift("open-link");
      showActs(acts);
    } else {
      ctxOnHead = true;
      ctxCol = Number(th.dataset.col);
      showActs(["copy-col", "del-col"]);
    }
    menu.hidden = false;
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.min(e.clientX, window.innerWidth - mw - 8) + "px";
    menu.style.top = Math.min(e.clientY, window.innerHeight - mh - 8) + "px";
  });

  // значение ячейки сравнения по контексту (compare-режим или превью)
  const cmpCellValue = () => {
    if (!ctxCmp || ctxCmp.onHead || ctxCmp.ci < 0) return null;
    const side = ctxCmp.side;
    if (state.compare && !state.compare.preview && state.cmpCtx) {
      if (ctxCmp.i == null || ctxCmp.i < 0) return null;
      const d = state.cmpCtx.visible[ctxCmp.i].d;
      const ri = side === "left" ? d.left_index : d.right_index;
      if (ri == null) return null;
      const src = state.cmpCtx[side].src;
      const row = src[ri] || [];
      return ctxCmp.ci < row.length ? row[ctxCmp.ci] : "";
    }
    const d = state.cmpData && state.cmpData[side];
    if (d && d.rows && d.rows[ctxCmp.ri] != null) {
      const row = d.rows[ctxCmp.ri];
      return ctxCmp.ci < row.length ? row[ctxCmp.ci] : "";
    }
    return null;
  };

  menu.addEventListener("click", e => {
    const item = e.target.closest(".ctx-item");
    if (!item || item.classList.contains("disabled")) return;
    const act = item.dataset.act;
    menu.hidden = true;
    if (ctxCmp) { handleCmpCtxAction(act, ctxCmp, cmpCellValue); return; }
    if (act === "open-link" && ctxRow != null) {
      const link = state.links.find(l => l.row === ctxRow);
      if (link) followLink(link);
    } else if (act === "copy-cell" && ctxRow != null && ctxCol != null) {
      // copy the value of the clicked cell
      state.clipboard = String(state.currentFile.rows[ctxRow].values[ctxCol] ?? "");
      copyText(state.clipboard);
    } else if (act === "cut-cell" && ctxRow != null && ctxCol != null) {
      // cut: copy the value out, then clear the cell (undoable via history)
      state.clipboard = String(state.currentFile.rows[ctxRow].values[ctxCol] ?? "");
      copyText(state.clipboard);
      applyCellEdit(ctxRow, ctxCol, "");
    } else if (act === "paste-cell" && ctxRow != null && ctxCol != null) {
      applyCellEdit(ctxRow, ctxCol, state.clipboard);
    } else if (act === "copy-row" && ctxRow != null) {
      copyText(state.currentFile.rows[ctxRow].values.join("\t"));
    } else if (act === "copy-col" && ctxOnHead && ctxCol != null) {
      // whole column of the currently visible (filtered) rows, TSV-free one per line
      const vals = state.visRows.map(v => String(v.row.values[ctxCol] ?? ""));
      copyText(vals.join("\n"));
    } else if (act === "dup-row" && ctxRow != null) {
      duplicateRow(ctxRow);
    } else if (act === "del-row" && ctxRow != null) {
      state.selectedRow = ctxRow;
      deleteRow();
    } else if (act === "del-col" && ctxOnHead) {
      deleteColumnAt(ctxCol);
    }
  });

  document.addEventListener("mousedown", e => {
    if (!e.target.closest("#ctx-menu")) menu.hidden = true;
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") menu.hidden = true;
  });
  window.addEventListener("blur", () => { menu.hidden = true; });
}

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
      <button class="icon-btn fp-close" data-i18n-title="find_close_t">${FP_SVG.close}</button>
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

// ---------- hotkeys ----------
// Keyboard shortcuts match e.code (physical key), NOT e.key: with a Russian
// or any other layout e.key becomes "а"/"с"/... and Ctrl+F would never fire.

// Переназначаемые горячие клавиши: id, ключ i18n и значение по умолчанию.
// Пользовательские значения живут в config.hotkeys (настройки, вкладка «Горячие клавиши»).
const HOTKEY_EDITABLE = [
  { id: "find",         label: "hk_find",         d: { code: "KeyF", ctrl: true,  shift: false, alt: false } },
  { id: "replace",      label: "hk_replace",      d: { code: "KeyH", ctrl: true,  shift: false, alt: false } },
  { id: "save",         label: "hk_save",         d: { code: "KeyS", ctrl: true,  shift: false, alt: false } },
  { id: "save_force",   label: "hk_save_force",   d: { code: "KeyS", ctrl: true,  shift: true,  alt: false } },
  { id: "open_file",    label: "hk_open_file",    d: { code: "KeyO", ctrl: true,  shift: false, alt: false } },
  { id: "open_project", label: "hk_open_project", d: { code: "KeyO", ctrl: true,  shift: true,  alt: false } },
  { id: "close_tab",    label: "hk_close_tab",    d: { code: "KeyW", ctrl: true,  shift: false, alt: false } },
  { id: "undo",         label: "hk_undo",         d: { code: "KeyZ", ctrl: true,  shift: false, alt: false } },
  { id: "redo",         label: "hk_redo",         d: { code: "KeyY", ctrl: true,  shift: false, alt: false } },
  { id: "toggle_tree",  label: "hk_toggle_tree",  d: { code: "KeyB", ctrl: true,  shift: false, alt: false } },
  { id: "font_plus",    label: "hk_font_plus",    d: { code: "Equal",  ctrl: true, shift: false, alt: false } },
  { id: "font_minus",   label: "hk_font_minus",   d: { code: "Minus",  ctrl: true, shift: false, alt: false } },
  { id: "font_reset",   label: "hk_font_reset",   d: { code: "Digit0", ctrl: true, shift: false, alt: false } },
];

function hkCombo(action) {
  const def = HOTKEY_EDITABLE.find(h => h.id === action);
  const custom = (state.config.hotkeys || {})[action];
  return Object.assign({}, def ? def.d : { code: "", ctrl: false, shift: false, alt: false }, custom || {});
}

function hkKey(c) {
  return [!!c.ctrl, !!c.shift, !!c.alt, c.code].join("+");
}

function hkMatch(action, e) {
  const c = hkCombo(action);
  const ctrl = e.ctrlKey || e.metaKey;
  return ctrl === !!c.ctrl && e.shiftKey === !!c.shift && e.altKey === !!c.alt && e.code === c.code;
}

function hkComboStr(c) {
  const pretty = code => String(code || "")
    .replace(/^Key/, "").replace(/^Digit/, "")
    .replace(/^Equal$/, "+").replace(/^Minus$/, "−")
    .replace(/^NumpadAdd$/, "+").replace(/^NumpadSubtract$/, "−")
    .replace(/^BracketLeft$/, "[").replace(/^BracketRight$/, "]");
  const parts = [];
  if (c.ctrl) parts.push("Ctrl");
  if (c.shift) parts.push("Shift");
  if (c.alt) parts.push("Alt");
  parts.push(pretty(c.code));
  return parts.join("+");
}

function hkConflicts(cand, excludeId) {
  const key = hkKey(cand);
  return HOTKEY_EDITABLE.some(h => h.id !== excludeId && hkKey(hkCombo(h.id)) === key);
}

function setupHotkeys() {
  document.addEventListener("keydown", e => {
    const ctrl = e.ctrlKey || e.metaKey;
    const c = e.code;
    // Esc clears the tree multi-selection
    if (e.key === "Escape" && state.treeSel && state.treeSel.size) {
      clearTreeSel();
      return;
    }
    // undo/redo: inside plain inputs keep the native text undo, but inside the
    // grid cell editor (.cell-input) still use the app-level cell undo
    const isUndo = hkMatch("undo", e);
    // legacy redo Ctrl+Shift+Z works while the user has not remapped redo
    const isRedo = hkMatch("redo", e) ||
      (ctrl && e.shiftKey && c === "KeyZ" && !(state.config.hotkeys || {}).redo);
    if (isUndo || isRedo) {
      if (e.repeat) return;   // holding the key must not mass-undo/redo
      const tgt = e.target;
      const inText = tgt && tgt.closest && tgt.closest("input, textarea, select") &&
        !(tgt.classList && tgt.classList.contains("cell-input"));
      if (inText) return;
      e.preventDefault();
      if (isRedo) redoCurrent();
      else undoCurrent();
      return;
    }
    // Ctrl+C / Ctrl+X / Ctrl+V: data clipboard for the grid, tree and compare
    // panes (inside plain inputs the native text clipboard still works)
    if (ctrl && (c === "KeyC" || c === "KeyX" || c === "KeyV")) {
      const tgt = e.target;
      if (tgt && tgt.closest && tgt.closest("input, textarea, select") &&
          !(tgt.classList && tgt.classList.contains("cell-input"))) return;
      const f = state.currentFile;
      if (c === "KeyV") {
        if (state.selCell && f && state.clipboard != null) {
          e.preventDefault();
          applyCellEdit(state.selCell.r, state.selCell.c, state.clipboard);
          toast(t("pasted_buffer") || "Вставлено", "ok");
        }
        return;
      }
      if (state.selCell && f && f.rows[state.selCell.r]) {
        e.preventDefault();
        const val = String(f.rows[state.selCell.r].values[state.selCell.c] ?? "");
        state.clipboard = val;
        if (c === "KeyX") {
          copyText(val);            // toasts "Скопировано в буфер"
          applyCellEdit(state.selCell.r, state.selCell.c, "");
          toast(t("cut_buffer") || "Вырезано в буфер", "ok");
        } else {
          copyText(val);
        }
        return;
      }
      if (c === "KeyC" && state.treeSel && state.treeSel.size) {
        // copy the selected tree paths as text
        e.preventDefault();
        const list = [...state.treeSel].join("\n");
        state.clipboard = list;
        copyText(list);
      }
      return;
    }
    // type-over editing: a focused grid cell starts the editor as soon as the
    // user types a printable character - no double click needed
    if (!ctrl && !e.altKey && !e.metaKey && e.key && e.key.length === 1 &&
        state.currentFile && state.selCell &&
        !(e.target && e.target.closest && e.target.closest("input, textarea, select"))) {
      const tr = (getActiveGridTable() || {}).querySelector &&
        getActiveGridTable().querySelector(`tbody tr[data-row-index="${state.selCell.r}"]`);
      if (tr) {
        e.preventDefault();
        beginEdit(tr, state.selCell.r, state.selCell.c, e.key);
        return;
      }
    }
    // type-over editing on the compare page preview panes (both sides work
    // exactly like the main grid)
    if (!ctrl && !e.altKey && !e.metaKey && e.key && e.key.length === 1 &&
        state.compare === null && state.cmpLastSide &&
        !(e.target && e.target.closest && e.target.closest("input, textarea, select"))) {
      const side = state.cmpLastSide;
      const sel = state.cmpSel[side];
      const table = sel ? $("#cmp-table-" + side) : null;
      const tr = table && table.querySelector(`tbody tr[data-row-index="${sel.r}"]`);
      if (tr && state.cmpData && state.cmpData[side]) {
        e.preventDefault();
        cmpBeginEdit(side, tr, sel.r, sel.c, e.key);
        return;
      }
    }
    if (hkMatch("toggle_tree", e)) {
      e.preventDefault();
      toggleSidebar();
    } else if (hkMatch("find", e)) {
      e.preventDefault();
      if (state.activeTabId === "compare") cmpFindOpen(state.cmpLastSide || "left");
      else if (state.activeTabId === "swt") {
        if (swtFind && state.swt.doc) swtFind.open(false);
      }
      else openFind(false);
    } else if (hkMatch("replace", e)) {
      e.preventDefault();
      if (state.activeTabId === "compare") {
        const side = state.cmpLastSide || "left";
        cmpFindOpen(side);
        const bar = cmpFindBar[side];
        if (bar) bar.showRepRow();
      } else openFind(true);
    } else if (hkMatch("save", e) && !e.shiftKey) {
      e.preventDefault();
      saveActive(false);
    } else if (hkMatch("save_force", e)) {
      e.preventDefault();
      saveActive(true);
    } else if (hkMatch("open_project", e)) {
      e.preventDefault(); openProjectDialog();
    } else if (hkMatch("open_file", e)) {
      e.preventDefault(); openFileDialog();
    } else if (hkMatch("close_tab", e)) {
      e.preventDefault();
      if (state.activeTabId !== "welcome") closeTab(state.activeTabId);
    } else if (hkMatch("font_plus", e)) {
      e.preventDefault(); zoomScale("contentZoom", 1);
      toast(Math.round(loadZoom("contentZoom") * 100) + "%");
    } else if (hkMatch("font_minus", e)) {
      e.preventDefault(); zoomScale("contentZoom", -1);
      toast(Math.round(loadZoom("contentZoom") * 100) + "%");
    } else if (hkMatch("font_reset", e)) {
      e.preventDefault(); setZoom("contentZoom", 1);
      toast("100%");
    } else if (c === "F3") {
      e.preventDefault();
      if (state.activeTabId === "compare" && state.cmpLastSide
          && cmpFindBar[state.cmpLastSide] && cmpFindBar[state.cmpLastSide].isOpen()) {
        cmpFindStep(state.cmpLastSide, e.shiftKey ? -1 : 1);
      } else if (state.activeTabId === "swt" && swtFind && swtFind.isOpen()) {
        swtFindStep(e.shiftKey ? -1 : 1);
      } else {
        findStep(e.shiftKey ? -1 : 1);
      }
    }
  });
}

// ---------- file pickers (pywebview js api or fallback to input) ----------
function pickFile() {
  return new Promise(resolve => {
    // Try native pywebview picker first
    if (window.pywebview && pywebview.api && pywebview.api.pick_file) {
      pywebview.api.pick_file()
        .then(p => resolve(p || null))
        .catch(err => {
          console.warn("Native file picker failed:", err);
          fallbackFile(resolve);
        });
      return;
    }
    fallbackFile(resolve);
  });
}

function fallbackFile(resolve) {
  const input = $("#file-input");
  input.value = ""; // allow picking same file again
  input.onchange = () => {
    const file = input.files[0];
    if (!file) { resolve(null); return; }
    // In browser mode, File object has no .path - use a data URL or prompt
    // For simplicity in dev mode, prompt for the actual path
    const path = prompt("Browser mode: enter full path to the .xml file:");
    resolve(path || null);
    input.onchange = null;
  };
  input.click();
}

// диалог «Сохранить как» для баланс-конфига (.cfg)
function pickSaveFile() {
  return new Promise(resolve => {
    if (window.pywebview && pywebview.api && pywebview.api.pick_file_save) {
      pywebview.api.pick_file_save()
        .then(p => resolve(p || null))
        .catch(err => {
          console.warn("Native save picker failed:", err);
          resolve(prompt(t("upr_cfg_save_prompt") ||
            "Полный путь для сохранения .cfg:") || null);
        });
      return;
    }
    resolve(prompt(t("upr_cfg_save_prompt") ||
      "Полный путь для сохранения .cfg:") || null);
  });
}

// диалог открытия баланс-конфига (.cfg/.txt, не xml)
function pickCfgFile() {
  return new Promise(resolve => {
    if (window.pywebview && pywebview.api && pywebview.api.pick_cfg_file) {
      pywebview.api.pick_cfg_file()
        .then(p => resolve(p || null))
        .catch(err => {
          console.warn("Native cfg picker failed:", err);
          resolve(prompt(t("upr_cfg_open_prompt") ||
            "Полный путь к файлу .cfg:") || null);
        });
      return;
    }
    resolve(prompt(t("upr_cfg_open_prompt") ||
      "Полный путь к файлу .cfg:") || null);
  });
}

function pickFolder() {
  return new Promise(resolve => {
    // Try native pywebview folder picker
    if (window.pywebview && pywebview.api && pywebview.api.pick_folder) {
      pywebview.api.pick_folder()
        .then(p => resolve(p || null))
        .catch(err => {
          console.warn("Native folder picker failed:", err);
          resolve(pickFolderFallbackDialogs());
        });
      return;
    }
    resolve(pickFolderFallbackDialogs());
  });
}

// dev/browser fallback: no native folder picker in browsers -> ask for a path
function pickFolderFallbackDialogs() {
  const path = prompt(t("folder_prompt") || "Path to mod project folder (basis/scripts/species):");
  return path;
}

function pickImage() {
  return new Promise(resolve => {
    if (window.pywebview && pywebview.api && pywebview.api.pick_image) {
      pywebview.api.pick_image()
        .then(p => resolve(p || null))
        .catch(() => resolve(prompt("Image path:") || null));
      return;
    }
    resolve(prompt("Image path:") || null);
  });
}

// ---------- create mod page ----------
function cmRelFor(path) {
  const root = state.project && state.project.root;
  if (!root) return "";
  const norm = s => String(s).replace(/\//g, "\\").toLowerCase().replace(/\\+$/, "");
  if (norm(path).startsWith(norm(root) + "\\")) {
    return path.slice(root.length).replace(/^[\\/]+/, "");
  }
  return "";
}

function cmCount() {
  return (state.cmFiles || []).reduce((n, e) => n + (e.folder ? e.files.length : 1), 0);
}

function cmFlatten() {
  const out = [];
  for (const e of state.cmFiles || []) {
    if (e.folder) out.push(...e.files);
    else out.push({ path: e.path, rel: e.rel });
  }
  return out;
}

function cmRenderFiles() {
  const list = $("#cm-file-list");
  const files = state.cmFiles || [];
  list.innerHTML = "";
  files.forEach((entry, i) => {
    if (entry.folder) {
      const wrap = document.createElement("div");
      wrap.className = "cm-folder";
      wrap.style.animationDelay = `${Math.min(i, 12) * 55}ms`;
      const head = document.createElement("div");
      head.className = "cm-folder-head";
      head.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-8L9.6 4.6A2 2 0 0 0 8.2 4H4a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1z"/></svg>
        <span class="cm-folder-name"></span>
        <span class="cm-file-rel"></span>
        <button class="cm-file-x" title="✕">✕</button>`;
      head.querySelector(".cm-folder-name").textContent = entry.folder;
      head.querySelector(".cm-file-rel").textContent = entry.files.length
        ? (entry.files[0].rel || "basis/scripts/") : "";
      head.title = entry.files.map(x => x.rel || x.path).join("\n");
      head.querySelector(".cm-file-x").onclick = () => {
        state.cmFiles.splice(i, 1);
        cmRenderFiles();
      };
      wrap.appendChild(head);
      const box = document.createElement("div");
      box.className = "cm-folder-files";
      entry.files.forEach((f, j) => {
        const chip = document.createElement("div");
        chip.className = "cm-file";
        chip.style.animationDelay = `${Math.min(j, 12) * 45}ms`;
        const name = String(f.path).split(/[\\/]/).filter(Boolean).pop();
        chip.innerHTML = `
          <img class="file-icon" src="${getFileIcon(name)}" alt="">
          <span class="cm-file-name"></span>
          <button class="cm-file-x" title="✕">✕</button>`;
        chip.querySelector(".cm-file-name").textContent = name;
        chip.querySelector(".cm-file-name").title = f.path;
        chip.querySelector(".cm-file-x").onclick = () => {
          entry.files.splice(j, 1);
          if (!entry.files.length) state.cmFiles.splice(i, 1);
          cmRenderFiles();
        };
        box.appendChild(chip);
      });
      wrap.appendChild(box);
      list.appendChild(wrap);
      return;
    }
    const chip = document.createElement("div");
    chip.className = "cm-file";
    chip.style.animationDelay = `${Math.min(i, 12) * 55}ms`;
    const name = String(entry.path).split(/[\\/]/).filter(Boolean).pop();
    chip.innerHTML = `
      <img class="file-icon" src="${getFileIcon(name)}" alt="">
      <span class="cm-file-name"></span>
      <span class="cm-file-rel"></span>
      <button class="cm-file-x" title="✕">✕</button>`;
    chip.querySelector(".cm-file-name").textContent = name;
    chip.querySelector(".cm-file-name").title = entry.path;
    chip.querySelector(".cm-file-rel").textContent = entry.rel || "basis/scripts/";
    chip.querySelector(".cm-file-rel").title = entry.rel
      ? (t("cm_rel_hint") || "Структура папок будет сохранена") + ": " + entry.rel
      : (t("cm_rel_none") || "Вне проекта — будет помещён в basis/scripts/");
    chip.querySelector(".cm-file-x").onclick = () => {
      state.cmFiles.splice(i, 1);
      cmRenderFiles();
    };
    list.appendChild(chip);
  });
  $("#cm-drop-hint").style.display = files.length ? "none" : "";
  $("#cm-drop-count").textContent = cmCount()
    ? `${t("cm_files") || "Files"}: ${cmCount()}` : "";
  $("#cm-clear-files").disabled = !files.length;
  updateCmButtons();
}

function cmAddFiles(data) {
  state.cmFiles = state.cmFiles || [];
  const has = p => state.cmFiles.some(e =>
    e.folder ? e.files.some(x => x.path.toLowerCase() === String(p).toLowerCase())
             : e.path.toLowerCase() === String(p).toLowerCase());
  let added = 0;
  for (const fo of (data && data.folders) || []) {
    const paths = (fo.paths || []).filter(p => p && !has(p));
    if (!paths.length || state.cmFiles.some(e => e.folder === fo.name)) continue;
    state.cmFiles.push({
      folder: fo.name,
      files: paths.map(p => ({ path: p, rel: cmRelFor(p) }))
    });
    added += paths.length;
  }
  for (const p of (data && data.files) || []) {
    if (!p || has(p)) continue;
    state.cmFiles.push({ path: p, rel: cmRelFor(p) });
    added++;
  }
  if (added) cmRenderFiles();
  return added;
}

function updateCmButtons() {
  const sel = $("#cm-target-mod");
  const hasMod = !!(sel && sel.value);
  $("#cm-copy-files").disabled = !(state.cmFiles && state.cmFiles.length && hasMod);
}

async function cmRefreshMods() {
  const sel = $("#cm-target-mod");
  sel.innerHTML = "";
  try {
    const j = await (await api("/api/list_mods")).json();
    (j.mods || []).forEach(m => {
      const o = document.createElement("option");
      o.value = m; o.textContent = m;
      sel.appendChild(o);
    });
  } catch (e) { /* noop */ }
  if (!sel.children.length) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = t("cm_no_mods") || "— модов пока нет —";
    sel.appendChild(o);
  }
  updateCmButtons();
}

function openCreateMod() {
  if (!state.tabs.some(tb => tb.id === "create-mod")) {
    createTab("create-mod");
    renderTabBar();
  }
  activateTab("create-mod");
  cmRefreshMods();
  // prefill the stored game dir
  api("/api/game_dir").then(r => r.json()).then(j => {
    if (j && j.ok && j.game_dir) $("#cm-game-dir").value = j.game_dir;
  }).catch(() => {});
}

function cmPreview(iconPath) {
  const box = $("#cm-preview");
  if (!iconPath) {
    box.innerHTML = `<span class="cm-no-icon">${t("cm_no_icon")}</span>`;
    return;
  }
  box.innerHTML = `<img alt="" src="/api/icon_preview?p=${encodeURIComponent(iconPath)}">`;
}

async function cmPickDir() {
  const dir = await pickFolder();
  if (!dir) return;
  $("#cm-game-dir").value = dir;
  const r = await api("/api/game_dir", { method: "POST", body: JSON.stringify({ path: dir }) });
  const j = await r.json();
  if (!j.ok) toast(j.error || "err", "err");
}

async function cmPickIcon() {
  const f = await pickImage();
  if (!f) return;
  state.cmIcon = f;
  cmPreview(f);
}

// подсказка под полем имени: где именно будет создан мод
function cmPathHint() {
  const el = $("#cm-path-hint");
  if (!el) return;
  const dir = ($("#cm-game-dir").value || "").trim().replace(/[\\/]+$/, "");
  const name = ($("#cm-name").value || "").trim();
  if (!dir) { el.textContent = ""; return; }
  el.textContent = dir + "\\mods\\" + (name || t("cm_name_ph") || "мод");
}

async function cmCreate() {
  const dir = $("#cm-game-dir").value.trim();
  const name = $("#cm-name").value.trim();
  const desc = $("#cm-desc").value;
  if (!dir) { toast(t("cm_need_dir"), "err"); return; }
  if (!name) { toast(t("cm_need_name"), "err"); return; }
  const gd = await api("/api/game_dir", { method: "POST", body: JSON.stringify({ path: dir }) });
  const gdj = await gd.json();
  if (!gdj.ok) { toast(gdj.error || t("cm_need_dir"), "err"); return; }
  const r = await api("/api/create_mod", {
    method: "POST",
    body: JSON.stringify({
      name, description: desc, icon: state.cmIcon || "",
      files: cmFlatten()
    })
  });
  const j = await r.json();
  if (!j.ok) {
    toast(j.error === "exists" ? t("cm_err_exists") : (j.error || "err"), "err");
    return;
  }
  // путь созданного мода запоминаем в настройках («Путь к основному моду»):
  // он используется командой «Скопировать в мод» и показывается в настройках
  try {
    await api("/api/config", { method: "POST",
      body: JSON.stringify({ mod_path: j.path }) });
    state.config.mod_path = j.path;
    refreshSrcPaths(); // вкладка «Мод» в древе появляется сразу
  } catch (e) { /* не критично */ }
  const box = $("#cm-result");
  box.hidden = false;
  box.innerHTML = "";
  const ok = document.createElement("div");
  ok.className = "cm-result-ok";
  ok.textContent = t("cm_created");
  box.appendChild(ok);
  const row = document.createElement("div");
  row.className = "cm-result-path";
  row.textContent = j.path;
  row.title = j.path;
  row.onclick = async () => {
    try { await api("/api/reveal", { method: "POST", body: JSON.stringify({ path: j.path }) }); }
    catch (e) { /* noop */ }
  };
  box.appendChild(row);
  // «Открыть мод»: сразу загрузить созданный мод как проект
  const openRow = document.createElement("div");
  openRow.className = "cm-result-open";
  const openBtn = document.createElement("button");
  openBtn.className = "btn accent";
  openBtn.textContent = t("cm_open_mod") || "Открыть мод";
  openBtn.onclick = async () => {
    $("#cm-result").hidden = true;
    await loadProject(j.path);
    activateTab("welcome");
  };
  openRow.appendChild(openBtn);
  box.appendChild(openRow);
  if ((j.copied || []).length) {
    const fc = document.createElement("div");
    fc.className = "cm-result-files";
    fc.textContent = `${t("cm_files_copied") || "Files copied"}: ${j.copied.length}` +
      ((j.skipped || []).length ? ` (${t("cm_files_skipped") || "skipped"}: ${j.skipped.length})` : "");
    fc.title = j.copied.join("\n");
    box.appendChild(fc);
  }
  toast(t("cm_created"), "ok");
  state.cmFiles = [];
  cmRenderFiles();
  cmRefreshMods();
}

async function cmCopyFiles() {
  const mod = $("#cm-target-mod").value;
  if (!mod) { toast(t("cm_no_mods") || "—", "err"); return; }
  if (!state.cmFiles || !state.cmFiles.length) return;
  const r = await api("/api/copy_mod_files", {
    method: "POST",
    body: JSON.stringify({ mod, files: cmFlatten() })
  });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "err", "err"); return; }
  const n = (j.copied || []).length;
  toast(`${t("cm_copied_to") || "Copied into"} "${mod}": ${n}` +
    ((j.skipped || []).length ? ` (${t("cm_files_skipped") || "skipped"}: ${j.skipped.length})` : ""), "ok");
  state.cmFiles = [];
  cmRenderFiles();
}

// ---------- archive unpacker ----------
function openUnpacker() {
  if (!state.tabs.some(tb => tb.id === "unpacker")) {
    createTab("unpacker");
    renderTabBar();
  }
  activateTab("unpacker");
  // resume polling if an unpack job is already running
  upPoll();
}

function upPlanGroup(title, paks, groupCls) {
  const card = document.createElement("div");
  card.className = "up-group";
  const head = document.createElement("div");
  head.className = "up-group-head";
  head.textContent = title;
  card.appendChild(head);
  const list = document.createElement("div");
  list.className = "up-group-list";
  const items = paks || [];
  if (!items.length) {
    const none = document.createElement("div");
    none.className = "up-pak-none";
    none.textContent = t("up_no_paks") || ".pak архивы не найдены";
    list.appendChild(none);
  }
  items.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "up-pak" + (groupCls ? " " + groupCls : "");
    row.title = p.path + "\n" + title;
    const n = document.createElement("span");
    n.className = "up-pak-n";
    n.textContent = String(i + 1).padStart(2, "0");
    const name = document.createElement("span");
    name.className = "up-pak-name";
    name.textContent = p.name;
    row.append(n, name);
    list.appendChild(row);
  });
  card.appendChild(list);
  return card;
}

async function upScan() {
  const root = $("#up-root").value.trim();
  if (!root) { toast(t("cm_need_dir"), "err"); return; }
  localStorage.setItem("tsh_up_root", root);
  const r = await api("/api/unpack_scan", { method: "POST", body: JSON.stringify({ path: root }) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "error", "err"); return; }
  state.upPlan = j;
  const plan = $("#up-plan");
  plan.hidden = false;
  plan.innerHTML = "";
  plan.appendChild(upPlanGroup(t("up_grp_base") || "Основа → basis\\", j.base, "g-base"));
  plan.appendChild(upPlanGroup(t("up_grp_legion") || "DLC Legion → dlc\\legion\\basis", j.legion, "g-legion"));
  plan.appendChild(upPlanGroup(t("up_grp_res") || "DLC Resistance → dlc\\resistance\\basis", j.resistance, "g-res"));
  plan.appendChild(upPlanGroup(t("up_grp_evo") || "DLC Evolution → dlc\\evolution\\basis", j.evolution, "g-evo"));
  const total = (j.base || []).length + (j.legion || []).length + (j.resistance || []).length
    + (j.evolution || []).length;
  $("#up-run").disabled = !total;
  $("#up-abort").disabled = true;
  const prog = $("#up-progress");
  if (prog) prog.hidden = true;
  // фокус с кнопки: иначе :focus-visible-аутлайн висит рядом с чипами
  const scanBtn = $("#up-scan");
  if (scanBtn && scanBtn.blur) scanBtn.blur();
  if (!j.sevenz) toast(t("up_no_7z") || "7-Zip не найден", "err");
  if (!total) toast(t("up_no_paks") || ".pak архивы не найдены", "err");
}

let upPollTimer = null;

function upPoll() {
  if (upPollTimer) { clearTimeout(upPollTimer); upPollTimer = null; }
  api("/api/unpack_status").then(r => r.json()).then(j => {
    if (!j.ok) return;
    const log = $("#up-log");
    if (j.lines && j.lines.length) {
      log.hidden = false;
      const txt = j.lines.join("\n");
      if (log.dataset.txt !== txt) {
        log.textContent = txt;
        log.dataset.txt = txt;
        log.scrollTop = log.scrollHeight;
      }
    }
    const prog = $("#up-progress"), fill = $("#up-progress-fill"), ptext = $("#up-progress-text");
    if (j.running) {
      $("#up-run").disabled = true;
      $("#up-abort").disabled = false;
      // per-file progress: each pak runs 0 -> 100%, then the next one restarts
      if (prog && fill && ptext) {
        prog.hidden = false;
        fill.style.width = (j.pct || 0) + "%";
        ptext.textContent = j.current ? j.current + " — " + (j.pct || 0) + "%" : "";
      }
      upPollTimer = setTimeout(upPoll, 900);
    } else if (j.done) {
      $("#up-run").disabled = !state.upPlan;
      $("#up-abort").disabled = true;
      if (prog && fill && ptext) {
        if (j.error === "cancelled") {
          prog.hidden = true; // abort removes the bar
        } else {
          prog.hidden = false;
          fill.style.width = "100%";
          ptext.textContent = j.error ? (t("up_fail") || "Ошибка") : (t("up_done") || "Готово");
        }
      }
      if (state.upWasRunning) {
        state.upWasRunning = false;
        if (j.error === "cancelled") toast(t("up_cancelled") || "Распаковка прервана", "err");
        else if (j.error) toast(t("up_fail") + ": " + j.error, "err");
        else {
          toast(t("up_done") || "Распаковка завершена", "ok");
          // успешная распаковка → запоминаем папку как распакованную игру
          const dest = state.upDest || "";
          if (dest) {
            api("/api/config", { method: "POST", body: JSON.stringify({ unpacked_path: dest }) }).then(() => {
              state.config.unpacked_path = dest;
              refreshSrcPaths();
              const set = $("#set-unpacked");
              if (set) set.value = dest;
              toast(t("up_saved_unpacked") || "Папка игры сохранена в настройках", "ok");
            }).catch(() => {});
            state.upDest = "";
          }
        }
      }
    }
  }).catch(() => {});
}

async function upAbort() {
  const r = await api("/api/unpack_abort", { method: "POST" });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "error", "err"); return; }
  // cancel + hide the progress bar right away
  const prog = $("#up-progress");
  if (prog) prog.hidden = true;
  $("#up-abort").disabled = true;
  toast(t("up_cancelled") || "Распаковка прервана", "ok");
}

async function upRun() {
  const root = $("#up-root").value.trim();
  const dest = $("#up-dest").value.trim();
  if (!root) { toast(t("cm_need_dir"), "err"); return; }
  if (!dest) { toast(t("up_need_dest") || "Укажите папку распаковки", "err"); return; }
  if (!state.upPlan) { await upScan(); }
  if (!state.upPlan) return;
  const total = (state.upPlan.base || []).length + (state.upPlan.legion || []).length
    + (state.upPlan.resistance || []).length + (state.upPlan.evolution || []).length;
  if (!total) { toast(t("up_no_paks") || ".pak архивы не найдены", "err"); return; }
  if (state.upPlan.sevenz === "") { toast(t("up_no_7z") || "7-Zip не найден", "err"); return; }
  localStorage.setItem("tsh_up_dest", dest);
  // что именно распакуем: группы и количество .pak
  const parts = [];
  const grp = (key, fb, arr) => { if ((arr || []).length) parts.push((t(key) || fb) + ": " + arr.length); };
  grp("up_grp_base", "Основа", state.upPlan.base);
  grp("up_grp_legion", "DLC Legion", state.upPlan.legion);
  grp("up_grp_res", "DLC Resistance", state.upPlan.resistance);
  grp("up_grp_evo", "DLC Evolution", state.upPlan.evolution);
  const choice = await askConfirm({
    title: t("up_run") || "Распаковать",
    message: (t("up_confirm") || "Распаковать архивы в") + " " + dest + "\n" +
      parts.join("  ·  ") + "  (" + total + " " + (t("files_n") || "files") + ")",
    buttons: [
      { id: "ok", label: t("up_run") || "Распаковать" },
      { id: "cancel", label: t("cancel"), kind: "ghost" },
    ],
  });
  if (choice !== "ok") return;
  state.upDest = dest;
  const r = await api("/api/unpack_run", { method: "POST",
    body: JSON.stringify({ game_root: root, dest }) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "error", "err"); return; }
  state.upWasRunning = true;
  $("#up-run").disabled = true;
  $("#up-abort").disabled = false;
  const prog = $("#up-progress"), fill = $("#up-progress-fill"), ptext = $("#up-progress-text");
  if (prog && fill && ptext) {
    prog.hidden = false;
    fill.style.width = "0%";
    ptext.textContent = "";
  }
  $("#up-log").hidden = false;
  toast(t("up_running") || "Распаковка…", "ok");
  upPoll();
}

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
           _docSrc: {}, _analyzed: false, _srcPromise: null };
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
  if (spec === "upgrade_sysname") {
    // зависимость от типа: пресет целиком из файла своего типа;
    // тип не выбран - все пресеты; пресетов нет - старые *_upgrades.xml
    const byType = { car: src.car_presets, tank: src.tank_presets,
                     squad: src.squad_presets, helicopter: src.heli_presets };
    const own = (typeof unitType === "function" ? unitType() : unitType) || "";
    (byType[own] || []).forEach(v => out.add(v));
    if (!out.size) {
      ["car_presets", "tank_presets", "squad_presets", "heli_presets"]
        .forEach(k => (src[k] || []).forEach(v => out.add(v)));
    }
    if (!out.size) (src.upgrades || []).forEach(v => out.add(v));
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
                  squad_presets: [], heli_presets: [] };
  try {
    const r = await api("/api/swt_sources", { method: "POST",
      body: JSON.stringify({
        path,
        project_root: (state.project && state.project.root) || "",
        unpacked_path: state.config.unpacked_path || "",
      }) });
    const j = await r.json();
    state.swtSources = j && j.ok ? j : empty;
  } catch {
    state.swtSources = empty;
  }
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
        if (j.dst) await openSwt(j.dst);
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
  del.className = "icon-btn swt-param-del";
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
    del.className = "icon-btn swt-var-del";
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
    onClose: () => { swtFindHits = []; swtFindIdx = 0; },
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
      await loadSwtSources(state.swt.path);
      state.swt._srcPromise = Promise.resolve();
      state.swt._docSrc = swtDocSources();
      state.swt._analyzed = true;
      renderSwtTrigger();
      anBtn.classList.add("done");
      toast(t("swt_analyze_done") || "Анализ завершён: подсказки заполнены", "ok");
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

// ---------- Карта Uprising (награды секторов shop_presets.xml) ----------
// Категории наград: заголовки из shop_presets.xml
const UPRISING_CATS = ["squads", "tanks", "cars", "helicopters", "inventory_items"];
// модалка редактора зоны по центру карты (временно отключена: только боковая панель)
const UPR_MODAL_ENABLED = false;

function uprFreshState() {
  // ЕДИНСТВЕННЫЙ дефолт состояния карты (старт + закрытие вкладки): все поля,
  // включая поколение загрузки loadSeq — без него переоткрытие давало NaN,
  // guard вечно дропал ответы и карта оставалась бледной (.empty, no sectors)
  return { path: null, rows: null, columns: [], sheetIndex: 0, sysnames: [], syscats: {}, prices: {}, sysLoading: false, sel: -1, variant: 0, dirty: false, found: false, panel: true, pick: new Set(), clip: [], sectorClip: null, editing: "", loading: false, loadSeq: 0 };
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
  // "name,name2:3,name3" -> [{name, n}]
  const out = [];
  String(s || "").split(",").forEach(part => {
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
  $("#upr-nofile").hidden = false;
  $("#upr-wrap").hidden = true;
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
  ["#upr-reload", "#upr-open-grid", "#upr-fs", "#upr-resizer"]
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

async function openUprising(path) {
  if (!state.tabs.some(tb => tb.id === "uprising")) {
    createTab("uprising");
    renderTabBar();
  }
  activateTab("uprising");
  // повторный вход, пока загрузка в полёте (дабл-клик по кнопке карты,
  // клик во время boot): не плодим параллельные open_file/icons_data —
  // поздний ошибочный ответ затирал хорошие иконки пустой картой
  if (!path && state.uprising.loading) return;
  if (!path) path = await uprFindFile();
  if (!path) {
    uprPaintNofile();
    return;
  }
  // тот же файл уже загружен — ничего не делаем
  if (state.uprising.path && normPath(path) === normPath(state.uprising.path) &&
      state.uprising.rows) return;
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
    if (choice !== "ok") return;
  }
  state.uprising.path = path;
  // новое поколение загрузки: устаревший ответ параллельного openUprising
  // (смена источника mid-flight, дабл-клик) молча отбрасывается в uprLoad
  const seq = ++state.uprising.loadSeq;
  state.uprising.loading = true;
  try {
    await uprLoad(false, seq);
  } finally {
    if (seq === state.uprising.loadSeq) state.uprising.loading = false;
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
  ["#upr-reload", "#upr-open-grid", "#upr-fs", "#upr-src",
   "#upr-resizer"]
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
    .then(j => { if (j.ok) state.uprising.prices = j.prices || {}; })
    .catch(() => {});
}

// цена юнита из своего species-файла (пусто = неизвестна)
function uprPrice(cat, name) {
  try {
    const v = ((state.uprising.prices || {})[cat] || {})[name || ""];
    return (v === undefined || v === null) ? "" : String(v).trim();
  } catch (e) { return ""; }
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
  const j = await r.json();
  // пока грузились — стартовало новое поколение (смена источника, повторный
  // клик): чужой файл не трогаем, иконки не перезаписываем
  if (my !== state.uprising.loadSeq) return;
  if (!j.ok) {
    toast(j.error || "error", "err");
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
  await uprEnsureIcons(my);   // один запрос карты URL — иконки видны на первом рендере
  if (my !== state.uprising.loadSeq) return;
  renderUprising();
  hideOwn();
}

function renderUprising() {
  renderUprMap();
  // прокрутка панели не должна сбрасываться при перерисовке (клики по иконкам)
  const main = $("#upr-main");
  const st = main ? main.scrollTop : 0;
  renderUprSector();
  if (main) main.scrollTop = st;
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
  try {
    const h = await api("/api/history?path=" + encodeURIComponent(state.uprising.path));
    const jh = await h.json();
    if (jh && jh.ok) setUndoRedoButtons(!!jh.can_undo, !!jh.can_redo);
  } catch (e) { /* кнопки как были */ }
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

// собранные щиты-бейджи (assets/uprising/shields, генерируются из DDS-иконок):
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
    // локализованное имя награды + серый sysname
    const nameRow = document.createElement("div");
    nameRow.className = "upr-sec-name";
    nameRow.innerHTML = `<span>${t("upr_sector_reward").replace("{n}", s.num)}</span><span class="upr-sector-sys">sector_${s.num}_reward</span>`;
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
  $("#upr-colors-modal").hidden = false;
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
      } else { toast(j.error || "error", "err"); return; }
    }
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

// категорийный плейсхолдер чипа (прямой URL готовой webp, без бэкенда)
function uprPlaceholderUrl(cat) {
  switch (cat) {
    case "cars": case "tanks": case "helicopters":
      return "/assets/upr-webp/vehicles/placeholder_vehicle.webp";
    case "squads":
      return "/assets/upr-webp/infantry/placeholder.webp";
    case "inventory_items":
      return "/assets/upr-webp/inventory/upgrd_placeholder.webp";
    default: return "";
  }
}

// карта иконок: sysname -> data-URL webp (один запрос до первого рендера).
// Чипы — прямые <img> из памяти: ноль конвертации, спрайта и HTTP-запросов.
// Имён вне карты (правки после загрузки) добираются одиночным
// /api/uprising_icon (там тоже webp-first).
let uprIconMap = {};
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
  try {
    // один ответ со всеми байтами (data-URL): сотни отдельных <img>-запросов
    // по HTTP/1.0 без keep-alive давали секунды оверхеда на соединения
    const r = await api("/api/uprising_icons_data", { method: "POST",
      body: JSON.stringify({ root, names }), timeout: 60000 });
    const j = await r.json();
    if (j && j.ok) {
      if (fresh()) { uprIconMap = j.icons || {}; uprIconsReady = true; }
      return;
    }
    throw new Error("icons_data not ok");
  } catch (e) {
    if (!fresh()) return;   // устарело — ретрай за новым поколением
    // транзиент (оборванный коннект): один повтор с паузой, иначе все чипы
    // уйдут сотнями одиночных запросов и частью побьются — «недогруз»
    await new Promise(res => setTimeout(res, 1500));
    if (!fresh()) return;
    try {
      const r2 = await api("/api/uprising_icons_data", { method: "POST",
        body: JSON.stringify({ root, names }), timeout: 60000 });
      const j2 = await r2.json();
      if (j2 && j2.ok && fresh()) { uprIconMap = j2.icons || {}; uprIconsReady = true; }
    } catch (e2) { /* чипы доберут одиночными + onerror-ретраем */ }
  }
}

function uprChipEditor(container, items, onChange, meta) {
  // список чипов «имя ×n»: имя не редактируется кликом (F2/ПКМ → «Редактировать»),
  // количество — числовым полем; весь чип — ручка переноса; клик — выделение

  const render = () => {
    container.querySelectorAll(".upr-chip,.upr-chip-add").forEach(e => e.remove());
    items.forEach((it, i) => {
      const chip = document.createElement("span");
      chip.className = "upr-chip upr-card";
      const known = !state.uprising.sysnames.length
        || state.uprising.sysnames.includes(it.name);
      if (!known) { chip.classList.add("unknown"); }
      const key = meta && it.name ? uprPickKey(meta.num, meta.vi, meta.cat, it.name) : "";
      if (key) chip.dataset.key = key;
      if (key && state.uprising.pick.has(key)) chip.classList.add("picked");
      if (it.name) {
        // подсказка: sysname + сложность + количество
        const ud = (key && uprUdiffs()[key]) || "";
        chip.title = it.name
          + `\n${t("upr_tip_diff") || "Сложность"}: ${ud || "—"}`
          + ` · ${t("upr_tip_count") || "Количество"}: ×${it.n}`
          + (known ? "" : `\n${t("upr_unknown") || "?"}`);
        // неизменяемый визуальный счётчик слева вверху: череп + сложность × кол-во
        const badge = document.createElement("span");
        badge.className = "upr-chip-badge" +
          ((meta && meta.cat === "inventory_items") ? " upr-chip-badge-items" : "");
        const skull = document.createElement("img");
        skull.className = "upr-chip-skull";
        skull.src = "/assets/uprising/difficulty.webp";
        skull.alt = "";
        skull.draggable = false;
        const bt = document.createElement("span");
        const effDiff = ud || ((meta && meta.num) ? uprZoneDiff(meta.num) : "—");
        bt.textContent = effDiff + " ×" + it.n;
        badge.append(skull, bt);
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
        // фолбек долгой загрузки: спиннер + затемнение чипа
        chip.classList.add("upr-loading");
        img.onload = () => chip.classList.remove("upr-loading");
        const phCat = meta && meta.cat;
        const du = uprIconMap[it.name];
        if (du) img.src = du;
        else if (uprIconsReady && uprPlaceholderUrl(phCat)) {
          // батч подтвердил: иконки нет — сразу категорийный плейсхолдер
          // (без рамки/фона), спиннер не нужен
          chip.classList.add("upr-chip-ph");
          chip.classList.remove("upr-loading");
          img.src = uprPlaceholderUrl(phCat);
        } else img.src = uprIconUrl(it.name, phCat);
        // оборванный коннект (HTTP/1.0 без keep-alive, WinError 10054) бил чип
        // навсегда: однократный повтор — data-URL свежим одиночным запросом,
        // одиночный новым коннектом; 503 бэкенда (файл блокирован) тоже лечится
        img.onerror = () => {
          if (img.dataset.uprRetry) { chip.classList.remove("upr-loading"); return; }
          img.dataset.uprRetry = "1";
          let solo = uprIconUrl(it.name, phCat);
          if (!img.src.startsWith("data:")) solo += "&retry=1";
          img.src = solo;
        };
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
      container.appendChild(chip);
    });
    const add = document.createElement("button");
    add.className = "upr-chip-add";
    add.title = t("upr_add") || "Добавить";
    add.setAttribute("aria-label", t("upr_add") || "Добавить");
    // иконка-кнопка всегда последняя в ряду (upgrd_base.webp 72x72)
    const addImg = document.createElement("img");
    addImg.className = "upr-chip-add-icon";
    addImg.src = "/assets/upr-webp/inventory/upgrd_base.webp";
    addImg.alt = "";
    addImg.draggable = false;
    add.appendChild(addImg);
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
    .forEach(c => c.classList.toggle("picked", on));
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
      .forEach(c => c.classList.remove("picked"));
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
  // цена скрыта везде (uprPrice/uprising_prices остаются в коде на будущее)
  // кнопки
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
    if (e.target.closest && e.target.closest(".swt-ac-panel")) return;
    if (uprEditPopEl && !uprEditPopEl.contains(e.target)) commit(false);
  };
  delB.onclick = e => {
    e.stopPropagation();
    if (isNew) { commit(false); renderUprising(); return; }
    commit(false); items.splice(i, 1); onChange(); renderUprising();
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
  setUndoRedoButtons(!!j.can_undo, !!j.can_redo);
  // открытые вкладки-таблицы того же файла: подменить значения, иначе
  // таблица покажет старое до переоткрытия
  try { uprSyncFileTabs(cells); } catch (e) { /* таблица обновится при открытии */ }
  return true;
}

// значения карты — в открытые таблицы того же файла (cells как в запросе)
function uprSyncFileTabs(cells) {
  const np = normPath(state.uprising.path || "");
  if (!np) return;
  const si = state.uprising.sheetIndex || 0;
  let active = false, any = false;
  state.tabs.forEach(tb => {
    if (tb.type !== "file" || !tb.fileData || !tb.fileData.rows) return;
    if (normPath(tb.path || "") !== np) return;
    if ((tb.sheetIndex || 0) !== si) return;   // другой лист того же файла
    any = true;
    cells.forEach(c => {
      const row = tb.fileData.rows[c.row];
      if (row && row.values && c.col < row.values.length) row.values[c.col] = c.value;
    });
    if (!tb.dirty) tb.dirty = true;
    if (tb.id === state.activeTabId) active = true;
  });
  if (!any) return;
  renderTabBar();
  if (active && state.currentFile && state.currentFile.rows) renderGrid();
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
  const edits = [];
  const moved = [], skipped = [];
  list.forEach(it => {
    if (!it.name) return;
    const ci = uprCatCol(it.cat);
    if (ci === -1) return;
    const tr = tgt.list[Math.min(it.vi, tgt.list.length - 1)];
    const cur = uprParseList(state.uprising.rows[tr.ri].values[ci] || "");
    if (cur.some(x => x.name === it.name)) { skipped.push(it); return; }
    cur.push({ name: it.name, n: it.n });
    edits.push({ ri: tr.ri, ci, items: cur });
    // убрать из зоны-источника
    const src = groups.find(g => g.num === it.num);
    const sr = src && src.list[Math.min(it.vi, src.list.length - 1)];
    if (sr) {
      edits.push({ ri: sr.ri, ci,
        items: uprParseList(state.uprising.rows[sr.ri].values[ci] || "")
          .filter(x => x.name !== it.name) });
    }
    moved.push(it);
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
    { label: t("delete") || "Удалить", icon: "delete", disabled: !hasIt, fn: () => {
        uprRemoveItems(grab());
        renderUprising();
      } },
    { label: t("ctx_paste") || "Вставить", icon: "paste", disabled: !(state.uprising.clip || []).length,
      fn: () => uprPasteItems(meta, items, idx) },
  ]);
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
    const g = d.chipEl.cloneNode(true);
    g.className = "upr-chip upr-card upr-drag-ghost";
    if (d.list.length > 1) {
      const b = document.createElement("span");
      b.className = "upr-ghost-n";
      b.textContent = "×" + d.list.length;
      g.appendChild(b);
    }
    document.body.appendChild(g);
    d.ghost = g;
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
    d.label.textContent = (t("upr_drop_to") || "Перенести в зону {n}").replace("{n}", num);
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
          .forEach(c => c.classList.remove("picked"));
        if (!only) {
          state.uprising.pick.add(k);
          if (d.chipEl && d.chipEl.isConnected) d.chipEl.classList.add("picked");
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
      $("#upr-modal-title").innerHTML =
        `<span class="upr-title-shield">${uprShieldSvg(g.num, uprZoneColor(g.num, uprSectorFaction(g.num)).solid, 22)}</span> ` +
        escapeHtml((t("upr_sector_reward") || "Награда сектора {n}").replace("{n}", String(g.num)));
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
  root.appendChild(head);

  const catsRow = document.createElement("div");
  catsRow.className = "upr-cats-row" + (horizontal ? " horiz" : "");
  UPRISING_CATS.forEach(cat => {
    const ci = uprCatCol(cat);
    if (ci === -1) return;
    const sec = document.createElement("div");
    sec.className = "upr-cat";
    const title = document.createElement("div");
    title.className = "upr-cat-title";
    title.textContent = t("upr_cat_" + cat) || cat;
    sec.appendChild(title);
    const body = document.createElement("div");
    body.className = "upr-cat-body";
    const items = uprParseList(ci < row.values.length ? row.values[ci] : "");
    uprChipEditor(body, items, () => {
      // пустые чипы не пишем в файл
      const cleaned = items.filter(x => x.name);
      uprWriteCells([{ ri: rw.ri, ci, items: cleaned }]);
    }, { num: g.num, vi: vi, cat: cat });
    sec.appendChild(body);
    catsRow.appendChild(sec);
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
  // щиты карты — одним запросом в память, фоном (к открытию карты уже в кэше)
  uprPreloadShields();
  // сохранение карты — кнопка шапки и Ctrl+S (saveActive → uprSaveGuarded)
  // без обёртки event клика попал бы в uprLoad как seq и убил бы рендер
  // (guard поколения сравнивает строго с числом)
  $("#upr-reload").onclick = () => uprLoad();
  $("#upr-open-grid").onclick = () => { if (state.uprising.path) openFile(state.uprising.path); };
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

// ---------- tooltip ----------
let tipEl = null;
let tipRaf = null;
let tipX = 0, tipY = 0;function showTip(e, text) {
  hideTip();
  tipEl = document.createElement("div");
  tipEl.className = "tip";
  tipEl.textContent = text;
  document.body.appendChild(tipEl);
  moveTip(e);
}
function moveTip(e) {
  if (!tipEl) return;
  const pad = 14;
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + 320 > window.innerWidth) x = e.clientX - 330;
  tipX = x; tipY = y;
  // одно перемещение на кадр: коалесим пачку mouseover'ов в один layout/repaint
  if (tipRaf !== null) return;
  tipRaf = requestAnimationFrame(() => {
    tipRaf = null;
    if (tipEl) { tipEl.style.left = tipX + "px"; tipEl.style.top = tipY + "px"; }
  });
}
function hideTip() {
  if (tipEl) { tipEl.remove(); tipEl = null; }
  if (tipRaf !== null) { cancelAnimationFrame(tipRaf); tipRaf = null; }
}

// ---------- settings ----------
// window_size presets: normal (as-is), +20% width, +20% width & height
const WINDOW_SIZES = {
  normal: [1280, 800],
  wide:   [1536, 800],   // +20% width
  big:    [1536, 960],   // +20% width and height
};

function openSettings(tab) {
  $("#set-auto-save").checked = !!state.config.auto_save;
  $("#set-fullscreen").checked = !!state.config.fullscreen;
  $("#set-theme").value = state.config.theme || "dark";
  $("#set-lang").value = state.lang || "ru";
  $("#set-window-size").value = state.config.window_size || "normal";
  $("#set-tray").checked = !!state.config.tray_enabled;
  $("#set-auto-update").checked = !!state.config.auto_update;
  $("#set-open-browser").checked = !!state.config.open_in_browser;
  $("#set-browser-to-tray").checked = !!state.config.browser_to_tray;
  $("#set-auto-hide-tree").checked = !!state.config.auto_hide_tree;
  $("#set-guard-unpacked").checked = state.config.guard_unpacked !== false;
  $("#set-unpacked").value = state.config.unpacked_path || "";
  $("#set-mod-path").value = state.config.mod_path || "";
  $("#set-project-path").value = state.config.project_path || state.config.last_project || "";
  const czSel = $("#set-content-zoom");
  const uzSel = $("#set-ui-zoom");
  for (const sel of [czSel, uzSel]) {
    sel.innerHTML = "";
    ZOOM_STEPS.forEach(v => {
      const o = document.createElement("option");
      o.value = String(v);
      o.textContent = Math.round(v * 100) + "%";
      sel.appendChild(o);
    });
  }
  czSel.value = String(snapZoom(loadZoom("contentZoom")));
  uzSel.value = String(snapZoom(loadZoom("uiZoom")));
  $("#set-keycol").value = state.config.default_key_column || "sysname";
  renderHotkeyEditor();
  $("#settings-modal").hidden = false;
  if (tab) {
    const btn = document.querySelector('.settings-tabs .st-tab[data-st="' + tab + '"]');
    if (btn) btn.click();
  }
}

// о программе: версия, автор, соцсети, донат
// ссылки соцсетей — в одном месте (заглушки с пустым url рисуются
// приглушёнными и не кликаются); иконки: assets/icons/social
const ABOUT_LINKS = [
  { id: "youtube", url: "" },
  { id: "twitch", url: "" },
  { id: "telegram", url: "" },
  { id: "github", url: "https://github.com/Hanigun/TerminatorToolSet" },
  { id: "discord", url: "" },
];
const DONATE_URL = "https://dalink.to/hanigun";
function openAbout() {
  $("#about-ver").textContent = (updState && updState.current)
    || state.version || "";
  const box = $("#about-social");
  box.innerHTML = "";
  const light = document.body.classList.contains("light");
  for (const { id, url } of ABOUT_LINKS) {
    const b = document.createElement("button");
    b.className = "social-btn";
    // тёмная иконка github видна только на светлой теме
    const icon = (id === "github" && !light) ? "github_light.png" : id + ".png";
    b.innerHTML = '<img src="/assets/icons/social/' + icon + '" alt="' + id + '">';
    b.title = id;
    if (!url) {
      b.disabled = true;
    } else {
      b.onclick = () => api("/api/open_link", { method: "POST",
        body: JSON.stringify({ url }) });
    }
    box.appendChild(b);
  }
  const st = $("#about-upd-state");
  if (st) st.textContent = "";
  if (updState && updState.available) {
    st.textContent = (t("upd_avail") || "Доступно: ") + updState.available.version;
  } else if (updState && updState.pending && updState.pending.version) {
    st.textContent = (t("upd_staged_short") || "Загружено: ") + updState.pending.version;
  } else if (updState) {
    st.textContent = (t("upd_uptodate") || "Установлена последняя версия") + " " + updState.current;
  }
  $("#about-modal").hidden = false;
}

// ---------- настройки: вкладки внутри модалки ----------
// строго в пределах своей модалки: иначе клик по вкладкам главных настроек
// гасил бы страницы настроек карты и наоборот
function setupSettingsTabs() {
  $$(".settings-tabs").forEach(bar => {
    const scope = bar.closest(".modal-card") || document;
    bar.querySelectorAll(".st-tab").forEach(b => {
      b.addEventListener("click", () => {
        bar.querySelectorAll(".st-tab").forEach(x => x.classList.toggle("active", x === b));
        scope.querySelectorAll(".settings-page").forEach(p => { p.hidden = p.dataset.stp !== b.dataset.st; });
      });
    });
  });
}

// ---------- настройки: редактор горячих клавиш ----------
function renderHotkeyEditor() {
  const box = $("#hk-editor");
  if (!box) return;
  box.innerHTML = "";
  const custom = state.config.hotkeys || {};
  for (const h of HOTKEY_EDITABLE) {
    const row = document.createElement("div");
    row.className = "hk-edit-row";
    row.innerHTML = `
      <span class="hk-edit-label"></span>
      <kbd class="hk-edit-combo"></kbd>
      <button class="btn sm hk-change" data-i18n="hk_change">Изменить</button>
      <button class="icon-btn hk-reset" data-i18n-title="hk_reset" title="Сбросить">⟲</button>`;
    row.querySelector(".hk-edit-label").textContent = t(h.label) || h.id;
    const combo = hkCombo(h.id);
    const kbd = row.querySelector(".hk-edit-combo");
    kbd.textContent = hkComboStr(combo);
    kbd.classList.toggle("custom", !!custom[h.id]);
    row.querySelector(".hk-change").addEventListener("click", () => hkCaptureStart(h.id, row));
    row.querySelector(".hk-reset").addEventListener("click", async () => {
      const hk = Object.assign({}, state.config.hotkeys || {});
      delete hk[h.id];
      await api("/api/config", { method: "POST", body: JSON.stringify({ hotkeys: hk }) });
      state.config.hotkeys = hk;
      renderHotkeyEditor();
    });
    box.appendChild(row);
  }
}

// снять захват клавиши (листенер больше не висит на document)
function hkCaptureStop() {
  if (state.hkCaptureHandler) {
    document.removeEventListener("keydown", state.hkCaptureHandler, true);
    state.hkCaptureHandler = null;
  }
  state.hkCapture = null;
}

function hkCaptureStart(actionId, row) {
  // клик по «Изменить» во время захвата: повтор по той же строке отменяет,
  // по другой — переключает захват на неё (старый листенер снимается)
  if (state.hkCapture) {
    const same = state.hkCapture === actionId;
    hkCaptureStop();
    if (same) { renderHotkeyEditor(); return; }
  }
  state.hkCapture = actionId;
  const kbd = row.querySelector(".hk-edit-combo");
  kbd.textContent = "…";
  kbd.classList.add("capturing");
  const handler = e => {
    // Esc всегда отменяет захват
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      hkCaptureStop();
      renderHotkeyEditor();
      return;
    }
    const mod = e.ctrlKey || e.metaKey || e.shiftKey || e.altKey;
    // сам модификатор (без пары) — ещё не комбинация, ждём дальше
    if (/^Control|^Shift|^Alt|^Meta/.test(e.code)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // без модификаторов разрешаем только F-клавиши и спецклавиши
    const plainOk = /^F\d+$/.test(e.code) ||
      /^(Insert|Delete|Home|End|PageUp|PageDown|Pause|PrintScreen|ContextMenu)$/.test(e.code);
    if (!mod && !plainOk) return;   // буквы/цифры без модификатора не занимаем
    e.preventDefault();
    e.stopPropagation();
    const cand = { code: e.code, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey };
    hkCaptureStop();
    if (hkConflicts(cand, actionId)) {
      toast(t("hk_conflict") || "Эта комбинация уже занята", "err");
      renderHotkeyEditor();
      return;
    }
    const hk = Object.assign({}, state.config.hotkeys || {});
    hk[actionId] = cand;
    state.config.hotkeys = hk;
    api("/api/config", { method: "POST", body: JSON.stringify({ hotkeys: hk }) }).catch(() => {});
    renderHotkeyEditor();
  };
  state.hkCaptureHandler = handler;
  document.addEventListener("keydown", handler, true);
}

async function saveSettings() {
  const body = {
    auto_save: $("#set-auto-save").checked,
    fullscreen: $("#set-fullscreen").checked,
    theme: $("#set-theme").value,
    language: $("#set-lang").value,
    window_size: $("#set-window-size").value,
    default_key_column: $("#set-keycol").value || "sysname",
    tray_enabled: $("#set-tray").checked,
    auto_update: $("#set-auto-update").checked,
    open_in_browser: $("#set-open-browser").checked,
    browser_to_tray: $("#set-browser-to-tray").checked,
    auto_hide_tree: $("#set-auto-hide-tree").checked,
    guard_unpacked: $("#set-guard-unpacked").checked,
    mod_path: $("#set-mod-path").value.trim(),
  };
  const prevLang = state.lang;
  const r = await api("/api/config", { method: "POST", body: JSON.stringify(body) });
  const j = await r.json();
  if (j.ok) {
    const prevSize = state.config.window_size;
    const prevUnpacked = state.config.unpacked_path || "";
    const prevMod = state.config.mod_path || "";
    Object.assign(state.config, body);
    // деревья перечитываем только при смене путей (обход игры — секунды),
    // иначе — дешёвая перекраска переключателей
    if ((state.config.unpacked_path || "") !== prevUnpacked ||
        (state.config.mod_path || "") !== prevMod) refreshSrcPaths();
    else updateCmpSrcSwitch();
    document.body.classList.toggle("light", state.config.theme === "light");
    // размер окна применяем ТОЛЬКО при смене пресета - иначе любое другое
    // изменение в настройках (например, язык) сбивает текущий размер окна
    if (body.window_size !== prevSize) {
      const size = WINDOW_SIZES[body.window_size] || WINDOW_SIZES.normal;
      if (window.pywebview && pywebview.api && pywebview.api.apply_window_size) {
        pywebview.api.apply_window_size(size[0], size[1]).catch(() => {});
      }
    }
    toast(t("save_success"), "ok");
    // язык изменился - обновить словарь и перерисовать всё с локализацией
    if (body.language && body.language !== prevLang) await applyLang(body.language);
  }
}

function setGridFont(v) {
  const val = Math.max(9, Math.min(20, v));
  localStorage.setItem("gridFont", String(val));
  document.documentElement.style.setProperty("--grid-font", val + "px");
}

async function applyLang(lang) {
  // смена языка из настроек: язык уже сохранён вызывающим кодом - здесь
  // обновляем словарь и перерисовываем всё, где строки запечены при рендере
  state.lang = lang || state.lang;
  await loadI18n();
  await renderGrid();
  renderTree();
  populateTreeFilterMenu();
  // SWT-редактор: строки локализуются при рендере - перерисовываем сам
  // (раньше локализация менялась только после клика по триггеру)
  if (state.tabs.some(tb => tb.id === "swt") && state.swt.doc) {
    renderSwtList();
    if (state.activeTabId === "swt") renderSwtTrigger();
  }
  if (state.tabs.some(tb => tb.id === "uprising") && state.uprising.rows) {
    renderUprising();
  }
  nudgeRepaint();
  // заголовок сайдбара зависит от источника — обновить тоже
  paintTreeTitle();
}

// пути игры/мода в настройках изменились: сбросить кэш деревьев,
// подтянуть текущий источник и перекрасить все переключатели
async function refreshSrcPaths() {
  state.gameTree = null;
  state.modTree = null;
  if (srcAvail("game")) await loadGameTree();
  if (srcAvail("mod")) await loadModTree();
  if (!srcAvail(state.treeView)) {
    const fb = srcFirst(null);
    if (fb) {
      state.treeView = fb;
      try { localStorage.setItem("tsh_src", fb); } catch (e) { /* noop */ }
    }
  }
  state.treeCounts = null;
  const root = treeRoot();
  if (root) computeTreeCounts(root);
  paintTreeTitle();
  paintSrcSwitches(); // красит и стороны сравнения
  renderTree();
  updateSidebarVisibility();
}

// ---------- compare page ----------
function openCompare() {
  if (!state.tabs.some(tb => tb.id === "compare")) {
    createTab("compare");
    renderTabBar();
  }
  activateTab("compare");
  updateCmpSrcSwitch(); // пути в настройках могли измениться
  // prefill the left (base) side: currently open file, else the project
  // opened earlier (this session or the last one stored in the config)
  const lp = $("#cmp-left-path");
  if (!lp.value.trim()) {
    const cur = state.currentFile && state.currentFile.path;
    if (cur) lp.value = cur;
  }
  if (!lp.value.trim()) {
    const projRoot = (state.project && state.project.root) || state.config.last_project || "";
    if (projRoot) {
      lp.value = projRoot;
      cmpFillFolderList("left"); // fills the dropdown; nothing loads until a file is picked
    }
  }
}

const cmpSide = side => ({
  path: $("#cmp-" + side + "-path"),
  list: $("#cmp-" + side + "-list"),
  dd: $("#cmp-" + side + "-dd"),
  face: $("#cmp-" + side + "-dd-face"),
});

// per-side status line: shows loading spinner / loaded row count / error
function cmpStatus(side, text, loading, err) {
  const el = $("#cmp-" + side + "-status");
  if (!el) return;
  el.hidden = !text && !loading;
  el.classList.toggle("err", !!err);
  el.innerHTML = "";
  if (loading) {
    const sp = document.createElement("span");
    sp.className = "mini-spin";
    el.appendChild(sp);
  }
  if (text) el.appendChild(document.createTextNode(text));
}

// load one side as soon as a file is picked (no need to press "compare"):
// caches rows locally and shows the count under the path input.
// silent=true (auto-preselect on page open): a failed load clears the
// status line instead of showing an error.
async function cmpLoadSide(side, silent) {
  if (!state.cmpData) state.cmpData = {};
  const p = cmpResolved(side);
  if (!p) { state.cmpData[side] = null; cmpStatus(side, ""); return; }
  if (state.cmpData[side] && state.cmpData[side].path === p) return;
  cmpStatus(side, t("cmp_loading") || "Загрузка…", true);
  try {
    const r = await api("/api/file?path=" + encodeURIComponent(p));
    const j = await r.json();
    if (!j.ok) {
      state.cmpData[side] = null;
      cmpStatus(side, silent ? "" : (j.error || "error"), false, !silent);
      return;
    }
    state.cmpData[side] = { path: p, columns: j.columns || [],
      comments: j.comments || {}, rows: (j.rows || []).map(x => x.values) };
    cmpStatus(side, (j.rows || []).length + " " + (t("cmp_rows_loaded") || "строк загружено"));
  } catch (e) {
    state.cmpData[side] = null;
    if (!silent) cmpStatus(side, String((e && e.message) || e), false, true);
    else cmpStatus(side, "");
    return;
  }
  // picking a file just OPENS it in its own pane; the diff runs only when
  // the user presses "compare"
  cmpShowPreview();
}

// which compare file the next undo/redo/history action should target: the
// side the user last interacted with (both sides are editable), left fallback
function cmpUndoTarget() {
  const tab = state.tabs.find(tb => tb.id === state.activeTabId);
  if (!tab || tab.type !== "compare") return null;
  const order = state.cmpLastSide
    ? [state.cmpLastSide, state.cmpLastSide === "left" ? "right" : "left"]
    : ["left", "right"];
  for (const s of order) {
    const d = state.cmpData && state.cmpData[s];
    if (d && d.path) return { side: s, path: d.path };
  }
  return null;
}

// toolbar undo/redo state on the compare page: refresh the per-side flags
// from the server and show the ones for the side the user last touched
async function cmpSyncUndoButtons() {
  const sides = ["left", "right"].filter(s =>
    state.cmpData && state.cmpData[s] && state.cmpData[s].path);
  await Promise.all(sides.map(async s => {
    try {
      const r = await api("/api/history?path=" + encodeURIComponent(state.cmpData[s].path));
      const j = await r.json();
      if (j.ok) state.cmpData[s].flags = { can_undo: !!j.can_undo, can_redo: !!j.can_redo };
    } catch (e) { /* keep the cached flags on network errors */ }
  }));
  const tgt = cmpUndoTarget();
  const fl = tgt && state.cmpData[tgt.side] && state.cmpData[tgt.side].flags;
  setUndoRedoButtons(!!(fl && fl.can_undo), !!(fl && fl.can_redo));
}

// repaint after an undo/redo that touched one compare side's file:
// the diff re-runs on the server; a preview reloads just that side
async function cmpRepaintUndo(side, patch) {
  if (!side) return;
  if (state.compare) { await runCompare(); return; }
  const d = state.cmpData && state.cmpData[side];
  if (d && patch && patch.kind === "cell" &&
      d.rows[patch.row] && patch.col < d.rows[patch.row].length) {
    d.rows[patch.row][patch.col] = patch.value;
    const table = $("#cmp-table-" + side);
    const tr = table && table.querySelector(`tbody tr[data-row-index="${patch.row}"]`);
    const td = tr && tr.children[patch.col];
    if (td) cmpRenderCell(side, d, td, patch.row, patch.col, patch.value);
    return;
  }
  state.cmpData[side] = null;
  await cmpLoadSide(side); // structural patch: reload the side + repaint
}

// repaint the compare view after a server-side change (history restore)
async function cmpReloadSide(side) {
  if (!side) return;
  if (state.compare) { await runCompare(); return; }
  state.cmpData[side] = null;
  await cmpLoadSide(side);
}

// jump from a history record to a cell of a compare preview pane: extend the
// rendered chunks until the row exists, then focus + flash it. If the row is
// hidden by that side's search filter, the filter is lifted first.
function cmpFocusCell(side, ri, ci) {
  const d = state.cmpData && state.cmpData[side];
  if (!d || !d.rows || !d.rows[ri]) return false;
  let list = state.cmpVisIdx[side];
  if (list && !list.includes(ri)) {
    state.cmpSearch[side] = "";
    list = null;
    cmpFillPreviewPane(side, d);
  }
  const total = list || d.rows.map((_, i) => i);
  const pos = list ? list.indexOf(ri) : ri;
  while (state.cmpPrevLimit[side] <= pos && state.cmpPrevLimit[side] < total.length) {
    const from = state.cmpPrevLimit[side];
    const to = Math.min(from + CMP_CHUNK, total.length);
    state.cmpPrevLimit[side] = to;
    cmpAppendPreviewRows(side, from, to);
  }
  const table = $("#cmp-table-" + side);
  const tr = table && table.querySelector(`tbody tr[data-row-index="${ri}"]`);
  if (!tr) return false;
  cmpClearCellFocus(side);
  state.cmpSel[side] = { r: ri, c: ci };
  state.cmpLastSide = side;
  const prevSel = table.querySelector("tbody tr.sel");
  if (prevSel) prevSel.classList.remove("sel");
  tr.classList.add("sel");
  const td = tr.children[ci];
  if (td) { td.classList.add("cell-focus"); td.scrollIntoView({ block: "nearest" }); }
  tr.classList.remove("row-flash");
  void tr.offsetWidth;
  tr.classList.add("row-flash");
  setTimeout(() => tr.classList.remove("row-flash"), 1800);
  return true;
}

// preview mode: show the picked file's rows in its own pane as a plain
// table (no diff yet). No auto-compare - that only happens on "Сравнить".
function cmpShowPreview() {
  const data = state.cmpData || {};
  const L = data.left, R = data.right;
  state.compare = null;
  state.cmpCtx = null;
  state.cmpSel = { left: null, right: null };
  state.cmpLastSide = null;
  const empty = $("#cmp-empty");
  const fl = $("#cmp-filters");
  const lt = $("#cmp-table-left"), rt = $("#cmp-table-right");
  // попапы поиска/замены живут внутри своих панелей (Ctrl+F)
  const resetSearch = s => {
    state.cmpSearch[s] = "";
    state.cmpVisIdx[s] = null;
    cmpFindClose(s);
  };
  if (!L && !R) {
    // nothing picked on either side: reset to the empty hint
    empty.hidden = false; fl.hidden = true;
    resetSearch("left"); resetSearch("right");
    lt.querySelector("thead").innerHTML = ""; lt.querySelector("tbody").innerHTML = "";
    rt.querySelector("thead").innerHTML = ""; rt.querySelector("tbody").innerHTML = "";
    $("#cmp-merge").disabled = false;
    return;
  }
  empty.hidden = true;
  fl.hidden = true; // filter chips belong to the diff, not to a plain preview
  if (!L) resetSearch("left");
  if (!R) resetSearch("right");
  cmpFillPreviewPane("left", L);
  cmpFillPreviewPane("right", R);
  cmpSyncUndoButtons();
  $("#cmp-merge").disabled = true; // nothing to merge from yet
}

// plain single-side table: header + editable rows, exactly like the main
// grid (click selects, second click / dblclick / typing edits the cell)
function cmpFillPreviewPane(side, data) {
  const table = $(side === "left" ? "#cmp-table-left" : "#cmp-table-right");
  const thead = table.querySelector("thead"), tbody = table.querySelector("tbody");
  thead.innerHTML = ""; tbody.innerHTML = "";
  state.cmpSel[side] = null;
  state.cmpPrevLimit[side] = 0;
  state.cmpVisIdx[side] = data ? cmpFilteredIdx(side) : null;
  if (!data) return;
  const cols = data.columns || [];
  const hr = document.createElement("tr");
  (cols || []).forEach((name, ci) => {
    const th = document.createElement("th");
    th.textContent = name;
    if (ci === 0) th.classList.add("sticky-col"); // sysname: same as the main grid
    const comment = data.comments && data.comments[ci];
    if (comment) {
      th.classList.add("has-comment");
      th.classList.add("col-comment");
    } else {
      th.title = name;
    }
    // built-in RU glossary under the header name, like the main grid
    const ru = HEADER_GLOSSARY[String(name).trim()];
    if (ru) {
      const subEl = document.createElement("div");
      subEl.className = "th-sub";
      subEl.textContent = ru;
      th.appendChild(subEl);
    }
    th.addEventListener("mouseenter", e => {
      if (comment) showTip(e, name + (ru ? " (" + ru + ")" : "") + " — " + comment);
    });
    th.addEventListener("mousemove", e => comment && moveTip(e));
    th.addEventListener("mouseleave", () => hideTip());
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  const list = state.cmpVisIdx[side] || (data.rows || []).map((_, i) => i);
  state.cmpPrevLimit[side] = Math.min(CMP_CHUNK, list.length);
  cmpAppendPreviewRows(side, 0, state.cmpPrevLimit[side]);
}

// rows of one side that match its own search box (null = no filter: all rows);
// same matching rule as the main grid filter (case-insensitive substring)
function cmpFilteredIdx(side) {
  const d = state.cmpData && state.cmpData[side];
  if (!d) return null;
  const q = (state.cmpSearch[side] || "").trim().toLowerCase();
  if (!q) return null;
  const rows = d.rows || [];
  const out = [];
  for (let ri = 0; ri < rows.length; ri++) {
    if (rows[ri].some(v => String(v).toLowerCase().includes(q))) out.push(ri);
  }
  return out;
}

// ---------- поиск и замена в панелях сравнения (копия find-bar главной) ----------
// попап живёт внутри своей .cmp-pane: в fullscreen-модалке переезжает вместе
// с таблицей; левый прижат к разделителю, правый - к правому краю
const cmpFindState = {
  left:  { q: "", idx: 0, matches: [], _t: null },
  right: { q: "", idx: 0, matches: [], _t: null },
};

function cmpFindTable(side) {
  return $(side === "left" ? "#cmp-table-left" : "#cmp-table-right");
}

// источник строк стороны: превью одного файла (cmpData) или парный диф
function cmpFindSource(side) {
  if (state.compare && state.compare.diff && state.cmpCtx) {
    const ctx = state.cmpCtx[side];
    if (!ctx) return null;
    return {
      mode: "diff",
      n: ctx.visible.length,
      cols: ctx.cols.length,
      val: (i, ci) => {
        const r = ctx.visible[i];
        if (!r) return "";
        const ri = side === "left" ? r.d.left_index : r.d.right_index;
        const src = ctx.src[ri];
        return src && ci < src.length ? String(src[ci] || "") : "";
      },
    };
  }
  const d = state.cmpData && state.cmpData[side];
  if (!d) return null;
  return {
    mode: "preview",
    n: (d.rows || []).length,
    cols: (d.columns || []).length,
    val: (i, ci) => {
      const row = d.rows[i];
      return row && ci < row.length ? String(row[ci] || "") : "";
    },
  };
}

function cmpFindCompute(side) {
  const f = cmpFindState[side];
  const src = cmpFindSource(side);
  f.matches = [];
  if (!src || !f.q) return;
  const q = f.q.toLowerCase();
  for (let i = 0; i < src.n; i++) {
    for (let ci = 0; ci < src.cols; ci++) {
      if (src.val(i, ci).toLowerCase().includes(q)) f.matches.push({ ri: i, ci });
    }
  }
  if (f.idx >= f.matches.length) f.idx = 0;
}

function cmpFindCount(side) {
  const b = cmpFindBar[side];
  const f = cmpFindState[side];
  if (b) b.setCount(f.idx, f.matches.length);
}

function cmpFindPaint(side) {
  const f = cmpFindState[side];
  const table = cmpFindTable(side);
  if (!table) return;
  $$(".find-cur", table).forEach(el => el.classList.remove("find-cur"));
  const m = f.matches[f.idx];
  if (!m) return;
  const src = cmpFindSource(side);
  if (!src) return;
  if (src.mode === "diff") {
    // диф рисуется чанками: дорисовать до нужной строки
    if (state.cmpPane && state.cmpPane[side] <= m.ri) {
      appendCmpRows(side, m.ri + 1 - state.cmpPane[side]);
    }
  } else {
    const data = state.cmpData[side];
    const list = state.cmpVisIdx[side] || data.rows.map((_, i) => i);
    const pos = list.indexOf(m.ri);
    while (pos >= state.cmpPrevLimit[side] && state.cmpPrevLimit[side] < list.length) {
      const from = state.cmpPrevLimit[side];
      const to = Math.min(from + CMP_CHUNK, list.length);
      cmpAppendPreviewRows(side, from, to);
      state.cmpPrevLimit[side] = to;
    }
  }
  const td = table.querySelector('td[data-row="' + m.ri + '"][data-col="' + m.ci + '"]');
  if (td) {
    td.classList.add("find-cur");
    td.scrollIntoView({ block: "nearest" });
  }
}

function cmpFindRefresh(side) {
  cmpFindCompute(side);
  cmpFindCount(side);
  cmpFindPaint(side);
}

function cmpFindStep(side, dir) {
  const f = cmpFindState[side];
  const n = f.matches.length;
  if (!n) return;
  f.idx = (f.idx + dir + n) % n;
  cmpFindCount(side);
  cmpFindPaint(side);
}

function cmpFindOpen(side) {
  const bar = cmpFindBar[side];
  if (!bar) return;
  bar.setQ(cmpFindState[side].q || "");
  bar.open(false);
  if (cmpFindState[side].q) cmpFindRefresh(side);
}

function cmpFindClose(side) {
  if (cmpFindBar[side]) cmpFindBar[side].close();
}

function cmpFindRepAvailable(side) {
  const src = cmpFindSource(side);
  return !!src && src.mode === "preview";
}

async function cmpReplaceOne(side, replArg) {
  if (!cmpFindRepAvailable(side)) {
    toast(t("cmp_rep_diff") || "Замена доступна только в предпросмотре файла", "err");
    return;
  }
  const f = cmpFindState[side];
  const m = f.matches[f.idx];
  if (!m || !f.q) return;
  const repl = replArg != null ? replArg : (cmpFindBar[side] ? cmpFindBar[side].replaceText() : "");
  const data = state.cmpData[side];
  const oldVal = String(data.rows[m.ri][m.ci] || "");
  const re = new RegExp(escapeRegExp(f.q), "gi");
  const newVal = oldVal.replace(re, repl);
  if (newVal !== oldVal) await cmpSetCell(side, m.ri, m.ci, newVal);
  cmpFindRefresh(side);
}

async function cmpReplaceAll(side, replArg) {
  if (!cmpFindRepAvailable(side)) {
    toast(t("cmp_rep_diff") || "Замена доступна только в предпросмотре файла", "err");
    return;
  }
  const f = cmpFindState[side];
  if (!f.q) return;
  cmpFindCompute(side);
  const cells = f.matches.slice();
  if (!cells.length) { toast(t("save_success"), "ok"); return; }
  const repl = replArg != null ? replArg : (cmpFindBar[side] ? cmpFindBar[side].replaceText() : "");
  const re = new RegExp(escapeRegExp(f.q), "gi");
  let changed = 0;
  for (const m of cells) {
    const oldVal = String(state.cmpData[side].rows[m.ri][m.ci] || "");
    const newVal = oldVal.replace(re, repl);
    if (newVal === oldVal) continue;
    await cmpSetCell(side, m.ri, m.ci, newVal);
    changed++;
  }
  toast((t("replace_all") || "Заменить все") + ": " + changed, "ok");
  cmpFindRefresh(side);
}

// попапы поиска/замены на обеих панелях — из общего ядра mkFindBar;
// стороны независимы: можно открыть оба сразу. Клик по панели делает её
// «выделенной», и Ctrl+F открывает поиск именно на ней.
const cmpFindBar = { left: null, right: null };

function setupCmpSearch() {
  ["left", "right"].forEach(side => {
    const pane = $("#cmp-pane-" + side);
    if (!pane) return;
    pane.addEventListener("mousedown", () => { state.cmpLastSide = side; });
    cmpFindBar[side] = mkFindBar({
      id: "cmp-find-" + side,
      host: pane,
      sticky: true,
      autoClose: false,
      withReplace: true,
      canReplace: () => cmpFindRepAvailable(side),
      onQuery: q => { const f = cmpFindState[side]; f.q = q; cmpFindRefresh(side); },
      onStep: d => cmpFindStep(side, d),
      onReplaceOne: repl => cmpReplaceOne(side, repl),
      onReplaceAll: repl => cmpReplaceAll(side, repl),
      onClose: () => {
        const f = cmpFindState[side];
        f.q = ""; f.idx = 0; f.matches = [];
        const table = cmpFindTable(side);
        if (table) $$(".find-cur", table).forEach(el => el.classList.remove("find-cur"));
      },
    });
  });
}

// ---------- полноэкранный режим панели сравнения ----------
// окно на весь монитор включает общий механизм (paneFsWinFs); модалка
// оставлена своя: панель переезжает в неё из двухколоночного вида
let cmpFsRestore = null;   // {side, pane} — куда вернуть таблицу

function cmpFullscreen(side) {
  const modal = $("#cmp-fs");
  const pane = $("#cmp-pane-" + side);
  if (!modal || !pane) return;
  if (!modal.hidden && cmpFsRestore && cmpFsRestore.side === side) { cmpFsClose(); return; }
  if (!modal.hidden && cmpFsRestore) cmpFsClose();
  cmpFsRestore = { side, pane };
  const tag = $("#cmp-fs-tag");
  tag.textContent = side === "left" ? (t("cmp_base") || "Основа") : (t("cmp_source") || "Источник");
  tag.className = "cmp-tag " + (side === "left" ? "base" : "src");
  const p = state.cmpData && state.cmpData[side];
  $("#cmp-fs-file").textContent = p ? (p.path || "")
    : (side === "left" ? $("#cmp-left-path").value : $("#cmp-right-path").value);
  $("#cmp-fs-body").appendChild(pane);
  // настоящий полноэкранный режим окна (весь монитор) - общий механизм;
  // в браузере недоступно - модалка и так на всю страницу
  paneFsWinFs(true);
  modal.hidden = false;
}

function cmpFsClose() {
  const modal = $("#cmp-fs");
  if (modal.hidden || !cmpFsRestore) return;
  const { side, pane } = cmpFsRestore;
  cmpFsRestore = null;
  if (side === "left") $("#cmp-grid-wrap").insertBefore(pane, $("#cmp-divider"));
  else $("#cmp-grid-wrap").appendChild(pane);
  modal.hidden = true;
  paneFsWinFs(false);
}

function setupCmpFs() {
  const modal = $("#cmp-fs");
  if (!modal) return;
  $("#cmp-fs-close").onclick = cmpFsClose;
  modal.addEventListener("mousedown", e => { if (e.target === modal) cmpFsClose(); });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !modal.hidden) cmpFsClose();
  });
}

// ---------- синхронная прокрутка панелей сравнения ----------
// галка над таблицами; работает в превью и в дифе, в fullscreen тоже
// (панель одна - вторая скрыта, зеркалить нечем, подписка просто молчит)
function setupCmpSyncScroll() {
  ["left", "right"].forEach(side => {
    const pane = $("#cmp-pane-" + side);
    if (!pane) return;
    pane.addEventListener("scroll", () => {
      const box = $("#cmp-sync-scroll");
      if (!box || !box.checked) return;
      const other = $("#cmp-pane-" + (side === "left" ? "right" : "left"));
      if (!other || other.scrollTop === pane.scrollTop) return;
      other.scrollTop = pane.scrollTop;
    }, { passive: true });
  });
}

// ---------- переключатели источника сторон сравнения ----------
// У каждой стороны свой источник (Проект | Игра | Мод) тем же сегментом,
// что на карте. Пункт, выбранный на другой стороне, темнеет и не выбирается
// (пока есть альтернатива); пункты без путей в настройках тоже темнеют.
function paintCmpSrc() {
  // стороны НЕ подтягиваем автоматически: по умолчанию ни одна вкладка
  // не выбрана, выбор — только кликом; недоступное из localStorage — в null
  for (const side of ["left", "right"]) {
    if (state.cmpSrc[side] && !srcAvail(state.cmpSrc[side])) {
      state.cmpSrc[side] = null;
      try { localStorage.removeItem("tsh_cmp_" + side); } catch (e) { /* noop */ }
    }
  }
  for (const side of ["left", "right"]) {
    const seg = $("#cmp-" + side + "-src");
    if (!seg) continue;
    const other = state.cmpSrc[side === "left" ? "right" : "left"];
    const canElse = SRC_ORDER.some(s => srcAvail(s) && s !== other);
    seg.dataset.pos = srcAvail(state.cmpSrc[side])
      ? String(Math.max(0, SRC_ORDER.indexOf(state.cmpSrc[side]))) : "-1";
    $$(".src-seg-btn", seg).forEach(b => {
      const s = b.dataset.src;
      b.classList.toggle("active", s === state.cmpSrc[side] && srcAvail(s));
      // как на карте: без пути — серая кликабельная кнопка в настройки
      // (is-off вместо disabled); disabled — только конфликт сторон
      const off = !srcAvail(s);
      b.classList.toggle("is-off", off);
      b.disabled = !off && (s === other && canElse);
      b.setAttribute("aria-disabled", String(off || (s === other && canElse)));
      b.title = srcRoot(s) || "";
    });
  }
}

async function cmpSetSideSrc(side, v) {
  if (!srcAvail(v)) return;
  const other = side === "left" ? "right" : "left";
  const canElse = SRC_ORDER.some(s => srcAvail(s) && s !== state.cmpSrc[other]);
  if (v === state.cmpSrc[other] && canElse) return;
  state.cmpSrc[side] = v;
  try { localStorage.setItem("tsh_cmp_" + side, v); } catch (e) { /* noop */ }
  paintCmpSrc();
  const root = srcRoot(v) || (v === "project" ? (state.config.last_project || "") : "");
  const els = cmpSide(side);
  const prevRel = els.list.dataset.value || "";
  els.path.value = root;
  await cmpFillFolderList(side);
  if (prevRel) {
    const item = [...els.list.children].find(x => {
      const rest = x.querySelector(".cmp-list-rest");
      return rest && rest.textContent === prevRel;
    });
    if (item) cmpSelectFile(side, prevRel, item, true);
  }
}

function setupCmpSrcSwitch() {
  for (const side of ["left", "right"]) {
    const seg = $("#cmp-" + side + "-src");
    if (!seg || seg.dataset.wired) continue;
    seg.dataset.wired = "1";
    seg.addEventListener("click", e => {
      const b = e.target.closest(".src-seg-btn");
      if (!b) return;
      if (b.classList.contains("is-off")) {
        const src = b.dataset.src;
        const id = src === "mod" ? "set-mod-path"
          : src === "game" ? "set-unpacked"
          : "set-project-path";
        openSettingsPaths(id);
        return;
      }
      if (b.disabled) return;
      cmpSetSideSrc(side, b.dataset.src);
    });
  }
  paintCmpSrc();
}

function updateCmpSrcSwitch() {
  paintCmpSrc();
}

// Ctrl+F на странице сравнения: попап поиска/замены у своей панели
// (лево/право независимы); в fullscreen-модалке попап тот же - он живёт
// внутри .cmp-pane и переезжает в модалку вместе с таблицей
function cmpFocusSearch(side) {
  cmpFindOpen(side);
}

// append the next chunk of editable preview rows to one side's pane
function cmpAppendPreviewRows(side, from, to) {
  const table = $(side === "left" ? "#cmp-table-left" : "#cmp-table-right");
  const tbody = table.querySelector("tbody");
  const data = state.cmpData && state.cmpData[side];
  if (!data) return;
  const cols = data.columns || [];
  const rows = data.rows || [];
  const list = state.cmpVisIdx[side] || rows.map((_, i) => i);
  // the search filtered everything out: show a "no matches" placeholder
  if (!list.length && !tbody.children.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = Math.max(cols.length, 1);
    td.className = "cmp-search-none";
    td.textContent = t("cmp_search_none");
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (let k = from; k < to && k < list.length; k++) {
    const ri = list[k];
    const tr = document.createElement("tr");
    tr.dataset.rowIndex = ri;
    for (let ci = 0; ci < cols.length; ci++) {
      tr.appendChild(cmpMakeCell(side, data, ri, ci, tr));
    }
    tbody.appendChild(tr);
  }
  cmpSetupPaneScroll(side);
}

// lazy-append preview rows while scrolling (same idea as the main grid)
function cmpSetupPaneScroll(side) {
  const pane = $(side === "left" ? "#cmp-pane-left" : "#cmp-pane-right");
  if (!pane || pane.dataset.cmpPrevScroll) return;
  pane.dataset.cmpPrevScroll = "1";
  pane.addEventListener("scroll", () => {
    if (state.compare) return; // diff view handles its own rendering
    const table = $(side === "left" ? "#cmp-table-left" : "#cmp-table-right");
    if (!table || !table.querySelector("thead tr")) return; // empty pane
    const data = state.cmpData && state.cmpData[side];
    if (!data) return;
    const list = state.cmpVisIdx[side] || (data.rows || []).map((_, i) => i);
    if (state.cmpPrevLimit[side] >= list.length) return;
    if (pane.scrollTop + pane.clientHeight < pane.scrollHeight - 400) return;
    const from = state.cmpPrevLimit[side];
    const to = Math.min(from + CMP_CHUNK, list.length);
    state.cmpPrevLimit[side] = to;
    cmpAppendPreviewRows(side, from, to);
  }, { passive: true });
}

// one editable preview cell: same interaction as the main grid
function cmpMakeCell(side, data, ri, ci, tr) {
  const td = document.createElement("td");
  if (ci === 0) td.classList.add("sticky-col"); // sysname: same as the main grid
  const rawVal = data.rows[ri] && ci < data.rows[ri].length
    ? data.rows[ri][ci] : "";
  td.textContent = rawVal;
  if (ci === 0 && rawVal) {
    const disp = state.nameMap[String(rawVal).trim()];
    if (disp && disp !== rawVal) {
      td.title = disp + " (" + rawVal + ")";
      const sub = document.createElement("div");
      sub.className = "cell-sub";
      sub.textContent = disp;
      td.appendChild(sub);
    }
  }
  td.dataset.row = ri; td.dataset.col = ci;
  td.addEventListener("mousedown", ev => {
    // a second click on the already-focused cell enters edit mode right away
    if (state.cmpSel[side] && state.cmpSel[side].r === ri && state.cmpSel[side].c === ci) {
      cmpBeginEdit(side, tr, ri, ci);
      return;
    }
    cmpClearCellFocus(side);
    state.cmpSel[side] = { r: ri, c: ci };
    state.cmpLastSide = side;
    // row selection, like the main grid
    const prevSel = tr.parentElement.querySelector("tr.sel");
    if (prevSel) prevSel.classList.remove("sel");
    tr.classList.add("sel");
    // undo/redo now act on THIS side: show its cached history flags
    const fl = state.cmpData[side] && state.cmpData[side].flags;
    if (fl) setUndoRedoButtons(!!fl.can_undo, !!fl.can_redo);
    td.classList.add("cell-focus");
  });
  td.addEventListener("dblclick", () => cmpBeginEdit(side, tr, ri, ci));
  return td;
}

function cmpClearCellFocus(side) {
  const sel = state.cmpSel[side];
  if (sel) {
    const table = $(side === "left" ? "#cmp-table-left" : "#cmp-table-right");
    const tr = table && table.querySelector(`tbody tr[data-row-index="${sel.r}"]`);
    const td = tr && tr.children[sel.c];
    if (td) td.classList.remove("cell-focus");
  }
  state.cmpSel[side] = null;
}

// repaint one preview cell after commit / cancel (keeps the friendly sub)
function cmpRenderCell(side, data, td, ri, ci, rawVal) {
  td.textContent = rawVal;
  if (ci === 0 && rawVal) {
    const disp = state.nameMap[String(rawVal).trim()];
    if (disp && disp !== rawVal) {
      td.title = disp + " (" + rawVal + ")";
      const sub = document.createElement("div");
      sub.className = "cell-sub";
      sub.textContent = disp;
      td.appendChild(sub);
    }
  }
}

// cell editing in a preview pane: same UX as the main grid, but the edit
// goes to THIS side's file (state.cmpData[side].path)
function cmpBeginEdit(side, tr, ri, ci, initVal) {
  const data = state.cmpData && state.cmpData[side];
  if (!data || !data.rows || !data.rows[ri]) return;
  const td = tr.children[ci];
  if (!td || td.querySelector(".cell-input")) return;
  const val = data.rows[ri][ci];
  const input = document.createElement("input");
  input.className = "cell-input";
  input.value = initVal != null ? String(initVal) : val;
  td.textContent = "";
  td.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const commit = async () => {
    if (done) return; done = true;
    const newVal = input.value;
    cmpRenderCell(side, data, td, ri, ci, newVal);
    if (newVal !== val) {
      const r = await api("/api/edit", { method: "POST",
        body: JSON.stringify({ path: data.path, row: ri, col: ci, value: newVal }) });
      const j = await r.json();
      if (j.ok) {
        data.rows[ri][ci] = newVal;
        data.flags = { can_undo: !!j.can_undo, can_redo: !!j.can_redo };
        setUndoRedoButtons(!!j.can_undo, !!j.can_redo);
        if (j.saved) noteSaved(data.path);
      } else {
        toast(j.error || "edit error", "err");
      }
    }
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", ev => {
    if (ev.key === "Enter") { input.blur(); }
    else if (ev.key === "Escape") { done = true; cmpRenderCell(side, data, td, ri, ci, val); }
  });
}

// правка ячейки прямо в диф-режиме: изменение уходит в файл ЭТОЙ стороны,
// после ответа диф перезапускается (строки/колонки пересчитаются)
function cmpBeginDiffEdit(side, td, i, ci) {
  if (!state.compare || state.compare.preview || !state.cmpCtx) return;
  const ctx = state.cmpCtx[side];
  const item = state.cmpCtx.visible[i];
  if (!ctx || !item) return;
  const d = item.d;
  const ri = side === "left" ? d.left_index : d.right_index;
  if (ri == null) return;
  const j = state.compare;
  const fileCols = side === "left" ? (j.left_columns || []) : (j.right_columns || []);
  const filePath = side === "left" ? j.left : j.right;
  const colName = ctx.cols[ci];
  const fci = fileCols.indexOf(colName);
  if (fci < 0 || !filePath) return;
  const srcRow = ctx.src[ri] || [];
  const val = ci < srcRow.length ? String(srcRow[ci] ?? "") : "";
  const input = document.createElement("input");
  input.className = "cell-input";
  input.value = val;
  td.textContent = "";
  td.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const commit = async () => {
    if (done) return; done = true;
    const nv = input.value;
    td.textContent = val;   // вернём старое значение; диф перерисуется
    if (nv === val) return;
    const r = await api("/api/edit", { method: "POST",
      body: JSON.stringify({ path: filePath, row: ri, col: fci, value: nv }) });
    const res = await r.json();
    if (!res.ok) { toast(res.error || "edit error", "err"); return; }
    if (res.saved) noteSaved(filePath);
    state.cmpLastSide = side;
    await runCompare();
    cmpSyncUndoButtons();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", ev => {
    if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
    else if (ev.key === "Escape") { done = true; td.textContent = val; }
  });
}

// правка ячейки превью-панели программно (контекстное меню «Вставить»/«Вырезать»)
async function cmpSetCell(side, ri, ci, newVal) {
  const data = state.cmpData && state.cmpData[side];
  if (!data || !data.rows || !data.rows[ri]) return;
  const r = await api("/api/edit", { method: "POST",
    body: JSON.stringify({ path: data.path, row: ri, col: ci, value: newVal }) });
  const j = await r.json();
  if (j.ok) {
    data.rows[ri][ci] = newVal;
    data.flags = { can_undo: !!j.can_undo, can_redo: !!j.can_redo };
    setUndoRedoButtons(!!j.can_undo, !!j.can_redo);
    if (j.saved) noteSaved(data.path);
    const table = $(side === "left" ? "#cmp-table-left" : "#cmp-table-right");
    const tr = table && table.querySelector(`tbody tr[data-row-index="${ri}"]`);
    if (tr && tr.children[ci]) cmpRenderCell(side, data, tr.children[ci], ri, ci, newVal);
  } else {
    toast(j.error || "edit error", "err");
  }
}

// перенос значения из источника (право) в основу (лево) по совпадающей колонке
async function cmpTransferCell(side, i, ci) {
  const j = state.compare;
  if (!j || j.preview || !state.cmpCtx || side !== "right") return;
  const d = state.cmpCtx.visible[i] && state.cmpCtx.visible[i].d;
  if (!d || d.left_index == null || d.right_index == null) {
    toast(t("cmp_no_base_row") || "Нет парной строки в основе", "err");
    return;
  }
  const name = state.cmpCtx.right.cols[ci];
  const lci = (j.left_columns || []).indexOf(name);
  if (lci < 0) { toast(t("cmp_no_base_col") || "Колонки нет в основе", "err"); return; }
  const val = (state.cmpCtx.right.src[d.right_index] || [])[ci];
  const r = await api("/api/edit", { method: "POST",
    body: JSON.stringify({ path: j.left, row: d.left_index, col: lci, value: String(val ?? "") }) });
  const res = await r.json();
  if (!res.ok) { toast(res.error || "edit error", "err"); return; }
  toast(t("save_success"), "ok");
  state.cmpLastSide = "left"; // перенос значения пишет в основу
  await runCompare();
  cmpSyncUndoButtons();
}

// индекс строки в САМОМ файле для выбранной ячейки сравнения
function cmpCtxFileRow(side, c) {
  if (state.compare && !state.compare.preview && state.cmpCtx) {
    if (c.i == null || c.i < 0) return null;
    const d = state.cmpCtx.visible[c.i] && state.cmpCtx.visible[c.i].d;
    if (!d) return null;
    return side === "left" ? d.left_index : d.right_index;
  }
  return c.ri != null ? c.ri : null;
}

// структурная правка (добавить/удалить строку, добавить/удалить колонку)
// над файлом одной из панелей сравнения; превью перечитывает сторону,
// диф перезапускает сравнение
async function cmpStructOp(side, op, extra) {
  const path = state.compare && !state.compare.preview
    ? (side === "left" ? state.compare.left : state.compare.right)
    : (state.cmpData && state.cmpData[side] && state.cmpData[side].path);
  if (!path) return;
  const r = await api("/api/" + op, { method: "POST",
    body: JSON.stringify(Object.assign({ path }, extra)) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "error", "err"); return; }
  if (j.saved) noteSaved(path);
  toast(t("save_success"), "ok");
  state.cmpLastSide = side;
  if (state.compare && !state.compare.preview) await runCompare();
  else { state.cmpData[side] = null; await cmpLoadSide(side); }
  cmpSyncUndoButtons();
}

// перенос колонки из источника (право) в основу (лево) по имени колонки
// (в основе создаётся новая, если такой колонки там нет)
async function cmpTransferCol(srcCi) {
  const j = state.compare;
  if (!j || j.preview || !state.cmpCtx) return;
  const name = state.cmpCtx.right.cols[srcCi];
  if (name == null) return;
  const srcCol = (j.right_columns || []).indexOf(name);
  const dstCol = (j.left_columns || []).indexOf(name); // -1 -> добавить колонку
  const r = await api("/api/transfer_column", { method: "POST",
    body: JSON.stringify({ src: j.right, dst: j.left,
      src_col: srcCol, dst_col: dstCol, key_col: Math.max(j.key_col, 0) }) });
  const res = await r.json();
  if (!res.ok) { toast(res.error || "error", "err"); return; }
  toast(t("save_success"), "ok");
  await runCompare();
}

// действия контекстного меню на панелях сравнения
// (c = снимок {side, ri, i, ci, onHead}, cellValue = чтение значения ячейки)
async function handleCmpCtxAction(act, c, cellValue) {
  const side = c && c.side;
  if (!side) return;
  if (act === "copy-cell") {
    const v = cellValue();
    if (v != null) { state.clipboard = String(v); copyText(state.clipboard); }
  } else if (act === "copy-row") {
    let vals = null;
    if (state.compare && !state.compare.preview && state.cmpCtx) {
      const d = state.cmpCtx.visible[c.i].d;
      const ri = side === "left" ? d.left_index : d.right_index;
      if (ri != null) vals = (state.cmpCtx[side].src[ri] || []).join("\t");
    } else {
      const d = state.cmpData && state.cmpData[side];
      if (d && d.rows && d.rows[c.ri]) vals = d.rows[c.ri].join("\t");
    }
    if (vals != null) copyText(vals);
  } else if (act === "copy-col") {
    const ci = c.ci;
    const out = [];
    if (state.compare && !state.compare.preview && state.cmpCtx) {
      for (const r of state.cmpCtx.visible) {
        const d = r.d;
        const ri = side === "left" ? d.left_index : d.right_index;
        if (ri == null) continue;
        const row = state.cmpCtx[side].src[ri] || [];
        out.push(ci < row.length ? String(row[ci] ?? "") : "");
      }
    } else {
      const d = state.cmpData && state.cmpData[side];
      if (d && d.rows) {
        const list = state.cmpVisIdx[side] || d.rows.map((_, i) => i);
        for (const ri of list) out.push(String(d.rows[ri][ci] ?? ""));
      }
    }
    copyText(out.join("\n"));
  } else if (act === "cut-cell") {
    const v = cellValue();
    if (v != null) {
      state.clipboard = String(v);
      copyText(state.clipboard);
      cmpSetCell(side, c.ri, c.ci, "");
    }
  } else if (act === "paste-cell") {
    if (state.clipboard != null) cmpSetCell(side, c.ri, c.ci, state.clipboard);
  } else if (act === "transfer-cell") {
    if (c.i != null) cmpTransferCell(side, c.i, c.ci);
  } else if (act === "transfer-row") {
    if (c.i != null) transferRow(state.cmpCtx.visible[c.i].d);
  } else if (act === "transfer-col") {
    await cmpTransferCol(c.ci);
  } else if (act === "add-row") {
    await cmpStructOp(side, "add_row", {});
  } else if (act === "del-row") {
    const ri = cmpCtxFileRow(side, c);
    if (ri != null) await cmpStructOp(side, "delete_row", { row: ri });
  } else if (act === "add-col") {
    await cmpStructOp(side, "add_column", {});
  } else if (act === "del-col") {
    await cmpStructOp(side, "delete_column", { col: c.ci });
  }
}

async function cmpPick(side, kind) {
  const els = cmpSide(side);
  if (kind === "folder") {
    const dir = await pickFolder();
    if (!dir) return;
    els.path.value = dir;
    await cmpFillFolderList(side);
  } else {
    const f = await pickFile();
    if (!f) return;
    els.path.value = f;
    els.dd.hidden = true;
    delete els.list.dataset.value;
    cmpLoadSide(side);
  }
}

async function cmpFillFolderList(side) {
  const els = cmpSide(side);
  const root = els.path.value.trim();
  if (!root) return;
  const r = await api("/api/list_xml", { method: "POST", body: JSON.stringify({ path: root }) });
  const j = await r.json();
  if (!j.ok || !j.files.length) { toast(j.error || t("no_file"), "err"); return; }
  els.list.innerHTML = "";
  delete els.list.dataset.value;
  // first item = the empty option: "no file selected" (clears the pick)
  const none = document.createElement("div");
  none.className = "cmp-list-item cmp-list-none";
  none.textContent = t("cmp_no_file") || "Файл не выбран";
  none.onclick = () => cmpNoneFile(side);
  els.list.appendChild(none);
  const items = [];
  j.files.forEach(rel => {
    const item = document.createElement("div");
    item.className = "cmp-list-item";
    const chip = cmpListChip(rel);
    if (chip) {
      const c = document.createElement("span");
      c.className = "cmp-chip " + chip.cls;
      c.textContent = chip.label;
      item.appendChild(c);
    }
    const rest = document.createElement("span");
    rest.className = "cmp-list-rest";
    rest.textContent = rel;
    item.appendChild(rest);
    item.title = rel;
    item.onclick = () => cmpSelectFile(side, rel, item);
    els.list.appendChild(item);
    items.push(item);
  });
  els.dd.hidden = false;
  els.list.hidden = true;
  // nothing is selected yet: the face shows the empty option and no side
  // loads until the user actually picks a file
  cmpNoneFile(side);
}

// face + state for "no file selected" on one side
function cmpNoneFile(side) {
  const els = cmpSide(side);
  els.list.dataset.value = "";
  els.list.querySelectorAll(".cmp-list-item.selected")
    .forEach(x => x.classList.remove("selected"));
  els.face.innerHTML = "";
  const ph = document.createElement("span");
  ph.className = "cmp-dd-none";
  ph.textContent = t("cmp_no_file") || "Файл не выбран";
  els.face.appendChild(ph);
  if (state.cmpData) state.cmpData[side] = null;
  cmpStatus(side, "");
  cmpShowPreview(); // refresh: preview the remaining side or clear the page
}

// select a file in the dropdown: highlight + show it (with chip) in the face
function cmpSelectFile(side, rel, item, silent) {
  const els = cmpSide(side);
  els.list.dataset.value = rel;
  els.list.querySelectorAll(".cmp-list-item.selected")
    .forEach(x => x.classList.remove("selected"));
  item.classList.add("selected");
  els.face.innerHTML = "";
  const chip = item.querySelector(".cmp-chip");
  if (chip) els.face.appendChild(chip.cloneNode(true));
  const rest = document.createElement("span");
  rest.className = "cmp-list-rest";
  rest.textContent = item.querySelector(".cmp-list-rest").textContent;
  els.face.appendChild(rest);
  els.list.hidden = true;
  cmpLoadSide(side, silent); // the picked file starts loading immediately
}

// overlay label for a relative path: basis -> company chip (yellow),
// dlc\resistance -> purple chip, dlc\Legion -> red chip,
// dlc\evolution -> dark-blue chip; the path text keeps its full form
// (basis\... / dlc\...) so the origin stays readable
function cmpListChip(rel) {
  const p = rel.toLowerCase();
  if (p.startsWith("dlc\\legion\\"))
    return { cls: "chip-legion", label: "Legion", rest: rel };
  if (p.startsWith("dlc\\resistance\\"))
    return { cls: "chip-res", label: "Resistance", rest: rel };
  if (p.startsWith("dlc\\evolution\\"))
    return { cls: "chip-evo", label: "Evolution", rest: rel };
  if (p.startsWith("basis\\"))
    return { cls: "chip-base", label: t("overlay_basis") || "Компания", rest: rel };
  return null;
}

// clear one side: drop the picked file/folder and its dropdown
function cmpClear(side) {
  const els = cmpSide(side);
  els.path.value = "";
  els.dd.hidden = true;
  els.list.innerHTML = "";
  els.list.hidden = true;
  delete els.list.dataset.value;
  els.face.textContent = "\u0424\u0430\u0439\u043B\u2026"; // "Файл…"
  if (state.cmpData) state.cmpData[side] = null;
  cmpStatus(side, "");
}

// resolve a side input to a concrete xml file path (folder + selected relative file)
function cmpResolved(side) {
  const els = cmpSide(side);
  const p = els.path.value.trim();
  if (!p) return "";
  const rel = els.list.dataset && els.list.dataset.value;
  // a loaded folder dropdown stays collapsed after selection - check its
  // wrapper, not the popup visibility; while no file is picked in it,
  // the side is unresolved
  if (els.dd && !els.dd.hidden) {
    return rel ? p.replace(/[\\/]+$/, "") + "\\" + rel : "";
  }
  return p;
}

async function runCompare() {
  const left = cmpResolved("left"), right = cmpResolved("right");
  if (!left || !right) { toast(t("cmp_need_paths"), "err"); return; }
  const keyCol = state.cmpKeyCol == null || state.cmpKeyCol < 0 ? -1 : state.cmpKeyCol;
  const allMode = keyCol === -1; // "all keys": match by the default key, copy every column
  // per-pane loading animation while the files are read on the server
  $("#cmp-loading-left").classList.remove("hidden");
  $("#cmp-loading-right").classList.remove("hidden");
  try {
    const r = await api("/api/compare", { method: "POST",
      body: JSON.stringify({ left, right, key_col: keyCol,
        default_key: state.config.default_key_column || "sysname" }) });
    const j = await r.json();
    if (!j.ok) { toast(j.error, "err"); return; }
    j.changedRows = new Set((j.diff || [])
      .filter(d => d.status === "both" && d.changes && d.changes.length)
      .map(d => d.right_index).filter(x => x != null));
    state.compare = j;
    state.cmpFilter = "all";
    // кнопки undo/redo — по стороне, с которой работали последней, а не
    // всегда левой (/api/compare возвращает флаги только левой)
    cmpSyncUndoButtons();
    $("#cmp-merge").disabled = false;
    // key dropdown options: "all keys" first, then columns A -> Z
    state.cmpKeyItems = [
      { v: -1, label: t("cmp_all_keys") },
      ...(j.left_columns || []).map((n, i) => ({ v: i, label: n }))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" })),
    ];
    state.cmpKeyCol = allMode ? -1 : j.key_col;
    renderKeyDropdown();
    renderCompare();
  } finally {
    $("#cmp-loading-left").classList.add("hidden");
    $("#cmp-loading-right").classList.add("hidden");
  }
}

const CMP_CHUNK = 400; // rows rendered per chunk (virtualization: more on scroll)

// ---------- выбор колонки-ключа: раскрывающееся окно с поиском ----------
function renderKeyDropdown() {
  const face = $("#cmp-key-face");
  const list = $("#cmp-key-list");
  if (!face || !list) return;
  const cur = state.cmpKeyItems.find(it => it.v === state.cmpKeyCol);
  face.textContent = cur ? cur.label : t("cmp_all_keys");
  const q = ($("#cmp-key-search").value || "").trim().toLowerCase();
  list.innerHTML = "";
  const items = state.cmpKeyItems.filter(it => !q || it.label.toLowerCase().includes(q));
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "key-dd-item" + (it.v === state.cmpKeyCol ? " active" : "");
    b.textContent = it.label;
    b.addEventListener("click", () => {
      state.cmpKeyCol = it.v;
      $("#cmp-key-pop").hidden = true;
      renderKeyDropdown();
      if (state.compare) runCompare();
    });
    list.appendChild(b);
  }
  if (!items.length) {
    const e = document.createElement("div");
    e.className = "key-dd-empty";
    e.textContent = t("cmp_search_none") || "—";
    list.appendChild(e);
  }
}

function setupKeyDropdown() {
  const pop = $("#cmp-key-pop");
  const btn = $("#cmp-key-btn");
  if (!pop || !btn) return;
  btn.addEventListener("click", e => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
    if (!pop.hidden) {
      $("#cmp-key-search").value = "";
      renderKeyDropdown();
      $("#cmp-key-search").focus();
      // широкое высокое окно выравнивается по кнопке, не вылезая за экран
      const r = btn.getBoundingClientRect();
      pop.style.left = Math.min(0, window.innerWidth - r.left - 460) + "px";
    }
  });
  pop.addEventListener("click", e => e.stopPropagation());
  $("#cmp-key-search").addEventListener("input", renderKeyDropdown);
  $("#cmp-key-search").addEventListener("keydown", e => {
    if (e.key === "Escape") { pop.hidden = true; e.stopPropagation(); }
  });
  document.addEventListener("mousedown", e => {
    if (!e.target.closest("#cmp-key-dd")) pop.hidden = true;
  });
}

function renderCompare() {
  const j = state.compare;
  const empty = $("#cmp-empty");
  const fl = $("#cmp-filters");
  const lt = $("#cmp-table-left"), rt = $("#cmp-table-right");
  if (!j || !j.diff) {
    empty.hidden = false; fl.hidden = true;
    lt.querySelector("thead").innerHTML = ""; lt.querySelector("tbody").innerHTML = "";
    rt.querySelector("thead").innerHTML = ""; rt.querySelector("tbody").innerHTML = "";
    state.cmpCtx = null;
    return;
  }
  empty.hidden = true;
  fl.hidden = false;
  const lcols = j.left_columns || [], rcols = j.right_columns || [];
  const lnames = new Set(lcols), rnames = new Set(rcols);
  const rows = (j.diff || []).map(d => ({
    d,
    cls: d.status === "left_only" ? "row-left-only"
      : d.status === "right_only" ? "row-right-only"
      : (d.changes && d.changes.length) ? "row-changed" : "row-same",
  }));
  // keys in alphabetical order
  rows.sort((a, b) => a.d.key.localeCompare(b.d.key, undefined, { numeric: true, sensitivity: "base" }));
  const st = { changed: 0, right_only: 0, left_only: 0 };
  rows.forEach(r => {
    if (r.cls === "row-changed") st.changed++;
    else if (r.cls === "row-right-only") st.right_only++;
    else if (r.cls === "row-left-only") st.left_only++;
  });
  // filter chips with counts
  fl.innerHTML = "";
  const mkFilter = (id, label, n) => {
    const b = document.createElement("button");
    b.className = "cmp-filter" + (state.cmpFilter === id ? " active" : "");
    b.innerHTML = escapeHtml(label) + ' <span class="n">' + n + "</span>";
    b.onclick = () => { state.cmpFilter = id; renderCompare(); };
    fl.appendChild(b);
  };
  mkFilter("all", t("cmp_all"), rows.length);
  mkFilter("changed", t("cmp_changed"), st.changed);
  mkFilter("right_only", t("cmp_new"), st.right_only);
  mkFilter("left_only", t("cmp_missing"), st.left_only);

  // per-side search boxes also filter the paired diff rows: a row stays
  // visible only if it matches every non-empty side's query
  const qs = {
    left: (state.cmpSearch.left || "").trim().toLowerCase(),
    right: (state.cmpSearch.right || "").trim().toLowerCase(),
  };
  const rowMatch = (side, d) => {
    const q = qs[side];
    if (!q) return true;
    const ri = side === "left" ? d.left_index : d.right_index;
    if (ri == null) return false;
    const src = side === "left" ? (j.left_rows || []) : (j.right_rows || []);
    const row = src[ri] || [];
    return row.some(v => String(v).toLowerCase().includes(q));
  };
  const keep = r => (state.cmpFilter === "all"
      || (state.cmpFilter === "changed" ? r.cls === "row-changed"
        : state.cmpFilter === "right_only" ? r.d.status === "right_only"
        : r.d.status === "left_only"))
    && rowMatch("left", r.d) && rowMatch("right", r.d);

  state.cmpCtx = {
    visible: rows.filter(keep),
    left: { cols: lcols, other: rnames, src: j.left_rows || [] },
    right: { cols: rcols, other: lnames, src: j.right_rows || [] },
  };
  state.cmpPane = { left: 0, right: 0 };
  buildCmpHead(lt, "left");
  buildCmpHead(rt, "right");
  lt.querySelector("tbody").innerHTML = "";
  rt.querySelector("tbody").innerHTML = "";
  appendCmpRows("left", CMP_CHUNK);
  appendCmpRows("right", CMP_CHUNK);
  // both panes filtered to nothing by the search boxes: say so instead of
  // silently empty tables
  if (!state.cmpCtx.visible.length && (qs.left || qs.right)) {
    [lt, rt].forEach((tbl, i) => {
      const tb = tbl.querySelector("tbody");
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 1 + (i === 0 ? lcols : rcols).length;
      td.className = "cmp-search-none";
      td.textContent = t("cmp_search_none");
      tr.appendChild(td);
      tb.appendChild(tr);
    });
  }
}

function buildCmpHead(table, side) {
  const ctx = state.cmpCtx[side];
  const thead = table.querySelector("thead");
  const hr = document.createElement("tr");
  const thSt = document.createElement("th");
  thSt.className = "td-st";
  thSt.textContent = side === "right" ? "\u27F5" : "";
  hr.appendChild(thSt);
  ctx.cols.forEach(name => {
    const th = document.createElement("th");
    th.textContent = name;
    th.title = name;
    if (!ctx.other.has(name)) th.classList.add("col-extra");
    hr.appendChild(th);
  });
  thead.innerHTML = "";
  thead.appendChild(hr);
}

// append the next chunk of rows to a pane's tbody (string-built for speed)
function appendCmpRows(side, count) {
  const ctxAll = state.cmpCtx;
  if (!ctxAll) return;
  const from = state.cmpPane[side];
  const visible = ctxAll.visible;
  if (from >= visible.length) return;
  const to = Math.min(from + count, visible.length);
  const ctx = ctxAll[side];
  const esc = escapeHtml;
  const parts = new Array(to - from);
  for (let i = from; i < to; i++) {
    const r = visible[i], d = r.d;
    const ri = side === "left" ? d.left_index : d.right_index;
    const changedMap = {};
    (d.changes || []).forEach(ch => { changedMap[ch[0]] = ch; });
    let h = '<tr class="' + r.cls + '">';
    if (side === "right" && (d.status === "right_only"
        || (d.status === "both" && d.changes && d.changes.length))) {
      // the source table starts with the transfer arrow, then the status dot
      h += '<td class="td-st"><button class="cmp-copy" data-i="' + i + '">\u27F5</button>'
        + '<span class="dot ' + r.cls.replace("row-", "") + '"></span></td>';
    } else {
      h += '<td class="td-st"><span class="dot ' + r.cls.replace("row-", "") + '"></span></td>';
    }
    for (let ci = 0; ci < ctx.cols.length; ci++) {
      const name = ctx.cols[ci];
      const ch = changedMap[name];
      if (ri == null) {
        h += '<td class="cmp-absent"></td>';
      } else {
        const srcRow = ctx.src[ri];
        const v = srcRow && ci < srcRow.length ? srcRow[ci] : "";
        h += ch
          ? '<td class="cmp-diff" data-row="' + i + '" data-col="' + ci + '" title="' + esc(name + ": " + ch[1] + "  ->  " + ch[2]) + '">' + esc(v) + "</td>"
          : '<td data-row="' + i + '" data-col="' + ci + '">' + esc(v) + "</td>";
      }
    }
    h += "</tr>";
    parts[i - from] = h;
  }
  state.cmpPane[side] = to;
  const tbody = $(side === "left" ? "#cmp-table-left tbody" : "#cmp-table-right tbody");
  tbody.insertAdjacentHTML("beforeend", parts.join(""));
}

async function transferRow(d) {
  // copy one row FROM the source (right) INTO the base (left)
  const j = state.compare;
  if (!j || j.preview || !j.left || !j.right) return;
  const r = await api("/api/transfer_row", { method: "POST",
    body: JSON.stringify({ src: j.right, dst: j.left, row: d.right_index, key_col: j.key_col }) });
  const res = await r.json();
  if (res.ok) toast(t("save_success"), "ok"); else toast(res.error, "err");
  state.cmpLastSide = "left"; // перенос пишет в основу
  await runCompare();
  cmpSyncUndoButtons();
}

// merge mode: auto-transfer everything new from the right source into the left base
async function mergeAll() {
  const j = state.compare;
  if (!j || !j.diff || j.preview) return;
  const nNew = j.diff.filter(d => d.status === "right_only").length;
  const nChg = j.diff.filter(d => d.status === "both" && d.changes && d.changes.length).length;
  const choice = await askConfirm({
    title: t("cmp_merge"),
    message: t("cmp_merge_confirm") + " (" + nNew + " + " + nChg + ")",
    buttons: [
      { id: "ok", label: t("cmp_merge") },
      { id: "cancel", label: t("cancel"), kind: "ghost" },
    ],
  });
  if (choice !== "ok") return;
  const r = await api("/api/merge_all", { method: "POST",
    body: JSON.stringify({ left: j.left, right: j.right, key_col: j.key_col,
      default_key: state.config.default_key_column || "sysname" }) });
  const res = await r.json();
  if (!res.ok) { toast(res.error, "err"); return; }
  toast(t("cmp_created") + ": " + res.created + " · " + t("cmp_updated") + ": " + res.updated, "ok");
  state.cmpLastSide = "left"; // слияние пишет в основу
  await runCompare();
  cmpSyncUndoButtons();
}

// ---------- undo / redo (snapshot-based, like the History panel) ----------
async function reloadActiveFile() {
  const tab = state.tabs.find(tb => tb.id === state.activeTabId);
  if (!tab || tab.type !== "file") return;
  try {
    const r = await api("/api/file?path=" + encodeURIComponent(tab.path));
    const f = await r.json();
    tab.fileData = f;
    tab.dirty = false;
    if (state.activeTabId === tab.id) {
      state.currentFile = f;
      state.selectedRow = null;
      state.dirty = false;
      updateDirty();
      renderTabBar();
      renderGrid();
      loadLinks();
    }
  } catch (e) { /* keep the old grid on network errors */ }
}

function setUndoRedoButtons(canUndo, canRedo) {
  const bu = $("#btn-undo"), br = $("#btn-redo");
  if (bu) bu.disabled = !canUndo;
  if (br) br.disabled = !canRedo;
}

// Fast in-place application of an undo/redo patch: only cell patches skip
// the full re-render; structural ones (row/column) reload the grid.
async function applyUndoPatch(patch) {
  if (!patch) { await reloadActiveFile(); return; }
  if (patch.kind === "cell") {
    const f = state.currentFile;
    const row = f && f.rows[patch.row];
    if (!row || row.values[patch.col] === undefined) { await reloadActiveFile(); return; }
    row.values[patch.col] = patch.value;
    if (patch.col === 0) row.key = patch.value;
    const table = getActiveGridTable();
    const tr = table && table.querySelector(`tbody tr[data-row-index="${patch.row}"]`);
    const td = tr && tr.children[patch.col];
    if (td) {
      renderCellContent(td, patch.row, patch.col, patch.value);
      if (state.find.active && state.find.keySet.has(patch.row + ":" + patch.col)) {
        td.classList.add("find-hit");
      }
    } else {
      renderGrid(); // row not virtualized - repaint
    }
  } else {
    await reloadActiveFile();
  }
}

async function runUndoRedo(endpoint, okMsg, noneMsg) {
  // works everywhere changes happen: file tabs edit their own file, the
  // compare page undoes/redoes the side the user last interacted with,
  // the map page (XML under the hood) undoes/redoes its own file pre-save
  const tab = state.tabs.find(tb => tb.id === state.activeTabId);
  let path = null, isCompare = false, cmpSide = null, isUprising = false;
  if (tab && tab.type === "file") path = tab.path;
  else if (tab && tab.type === "compare") {
    const tgt = cmpUndoTarget();
    if (tgt) { path = tgt.path; cmpSide = tgt.side; isCompare = true; }
  }
  else if (state.activeTabId === "uprising" && state.uprising.path) {
    path = state.uprising.path;
    isUprising = true;
  }
  if (!path) { toast(t("no_file")); return; }
  if (state.histBusy) return;   // one request at a time (no repeat pile-up)
  state.histBusy = true;
  try {
    const r = await api(endpoint, { method: "POST", body: JSON.stringify({ path }) });
    const j = await r.json();
    if (!j.ok) {
      setUndoRedoButtons(!!j.can_undo, !!j.can_redo);
      if (j.error === "nothing_to_undo" || j.error === "nothing_to_redo") {
        toast(noneMsg);   // boundary reached - informational, not an error
      } else {
        toast(j.error || "error", "err");
      }
      return;
    }
    if (isCompare) {
      const d = state.cmpData && state.cmpData[cmpSide];
      if (d) d.flags = { can_undo: !!j.can_undo, can_redo: !!j.can_redo };
      await cmpRepaintUndo(cmpSide, j.patch);
    }
    else if (isUprising) await uprRepaintUndo();
    else await applyUndoPatch(j.patch);
    setUndoRedoButtons(!!j.can_undo, !!j.can_redo);
    toast(okMsg, "ok");
  } finally {
    state.histBusy = false;
  }
}

async function undoCurrent() {
  // SWT-редактор: локальный пошаговый undo (стек правок doc); файловые
  // вкладки и сравнение — серверный undo через историю, как раньше
  if (state.activeTabId === "swt") { swtUndo(); return; }
  await runUndoRedo("/api/undo", t("undo"), t("undo_none"));
}

async function redoCurrent() {
  if (state.activeTabId === "swt") { swtRedo(); return; }
  await runUndoRedo("/api/redo", t("redo"), t("redo_none"));
}

// ---------- history ----------
// Ядро истории: какие файлы попадают в журнал для активной страницы
// (SWT-вкладка, сравнение с двумя панелями или открытый файл-вкладка)
function histTargets() {
  if (state.activeTabId === "uprising" && state.uprising.path) {
    return [{ side: null, path: state.uprising.path }];
  }
  if (state.activeTabId === "swt" && state.swt.path) {
    return [{ side: null, path: state.swt.path }];
  }
  if (state.activeTabId === "compare") {
    const sides = state.cmpLastSide
      ? [state.cmpLastSide, state.cmpLastSide === "left" ? "right" : "left"]
      : ["left", "right"];
    const targets = [];
    for (const s of sides) {
      const d = state.cmpData && state.cmpData[s];
      if (d && d.path) targets.push({ side: s, path: d.path });
    }
    return targets;
  }
  if (state.currentFile && state.currentFile.path) {
    return [{ side: null, path: state.currentFile.path }];
  }
  return [];
}

// перерисовать активную страницу после серверного изменения файла
// (восстановление записи истории, полный откат к стоку)
async function histRepaintContext(path, side) {
  if (state.activeTabId === "uprising" && path) {
    // restore из журнала пишет файл на диск: память перечитана = чисто
    await uprRepaintUndo();
    uprMarkClean();
    return;
  }
  if (state.activeTabId === "swt" && path) {
    // сброс пути: openSwt с тем же путём вышел бы по early-return
    state.swt.dirty = false;
    state.swt.path = "";
    await openSwt(path);
    return;
  }
  if (side) {
    const d = state.cmpData && state.cmpData[side];
    if (d) d.flags = { can_undo: false, can_redo: false };
    await cmpReloadSide(side);
    const tgt = cmpUndoTarget();
    const fl = tgt && state.cmpData[tgt.side] && state.cmpData[tgt.side].flags;
    setUndoRedoButtons(!!(fl && fl.can_undo), !!(fl && fl.can_redo));
    return;
  }
  await reloadActiveFile();
}

// несохранённые правки SWT перед серверной подменой файла: сохранить/отбросить
async function histConfirmSwtDirty() {
  if (state.activeTabId !== "swt" || !state.swt.dirty) return true;
  const choice = await askConfirm({
    title: t("unsaved_changes"),
    message: t("close_dirty_confirm"),
    buttons: [
      { id: "save", label: t("save_close") },
      { id: "discard", label: t("close_wo_save"), kind: "danger" },
      { id: "cancel", label: t("cancel"), kind: "ghost" },
    ],
  });
  if (choice === "cancel") return false;
  if (choice === "save") return swtSaveGuarded(false);
  state.swt.dirty = false;
  return true;
}

const HIST_ACTION_KEYS = {
  edit: "hist_edit",
  edit_cells: "hist_edit_cells",
  add_row: "hist_add_row",
  del_row: "hist_del_row",
  add_col: "hist_add_col",
  del_col: "hist_del_col",
  row_set: "hist_row_set",
  col_set: "hist_col_set",
};

function fmtDate(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString().slice(0, 5);
}

function fmtSize(n) {
  if (n == null) return "";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " " + t("kb");
  return (n / 1048576).toFixed(1) + " " + t("mb");
}

async function openHistory() {
  // ядро истории работает на любой странице: SWT-вкладка - файл .swt,
  // сравнение - обе панели одним журналом, иначе - открытый файл
  const targets = histTargets();
  if (!targets.length) { toast(t("no_file")); return; }
  $("#history-clear").onclick = async () => {
    const choice = await askConfirm({
      title: t("hist_clear"),
      message: t("hist_clear_confirm"),
      buttons: [
        { id: "ok", label: t("hist_clear"), kind: "danger" },
        { id: "cancel", label: t("cancel"), kind: "ghost" },
      ],
    });
    if (choice !== "ok") return;
    for (const tg of targets) {
      const rr = await api("/api/clear_history", { method: "POST",
        body: JSON.stringify({ path: tg.path }) });
      const jj = await rr.json();
      if (!jj.ok) { toast(jj.error || "error", "err"); return; }
    }
    if (state.currentFile) setUndoRedoButtons(false, false);
    else if (state.activeTabId === "uprising") {
      uprRepaintUndo();
      setUndoRedoButtons(false, false);
    }
    else await cmpSyncUndoButtons();
    toast(t("hist_cleared"), "ok");
    openHistory(); // refresh the list in place
  };
  // fetch every file's journal in parallel and tag records with their side
  let list, flags;
  try {
    const results = await Promise.all(targets.map(async tg => {
      const r = await api("/api/history?path=" + encodeURIComponent(tg.path));
      return r.json();
    }));
    list = [];
    results.forEach((j, i) => {
      const tg = targets[i];
      ((j && j.records) || []).forEach(h => {
        h.__side = tg.side;
        h.__path = tg.path;
        list.push(h);
      });
    });
    flags = results.map(j => ({ can_undo: !!(j && j.can_undo), can_redo: !!(j && j.can_redo) }));
  } catch (e) {
    toast(String((e && e.message) || e), "err");
    return;
  }
  list.sort((a, b) => b.ts - a.ts); // newest first across both files
  // toolbar buttons reflect the preferred side (the one the user last touched)
  if (flags[0]) setUndoRedoButtons(flags[0].can_undo, flags[0].can_redo);
  // per-file "current state" marker: the newest applied record of that file
  const currentKey = new Set();
  targets.forEach(tg => {
    const cur = list.find(h => h.__path === tg.path && !h.undone);
    if (cur) currentKey.add(tg.path + ":" + cur.id);
  });
  const body = $("#history-body");
  body.innerHTML = `<div class="hist-hint">${escapeHtml(t("hist_hint"))}</div>`;
  if (!list.length) {
    body.insertAdjacentHTML("beforeend",
      `<div class="recents-empty">${escapeHtml(t("history_empty"))}</div>`);
  }
  list.forEach(h => {
    const isCurrent = currentKey.has(h.__path + ":" + h.id);
    const isUndone = !!h.undone;
    const item = document.createElement("div");
    item.className = "history-item" + (isCurrent ? " current" : "") + (isUndone ? " undone" : "");
    const tm = new Date(h.ts * 1000).toLocaleString();
    const actLabel = t(HIST_ACTION_KEYS[h.action] || "hist_edit");
    item.innerHTML = `
      ${h.__side ? `<span class="h-side ${h.__side}"></span>` : ""}
      <span class="h-badge ${isUndone ? "h-undone" : ""}">${escapeHtml(actLabel)}</span>
      <span class="h-main">
        <span class="h-sum"></span>
        <span class="h-meta"></span>
      </span>
      ${isCurrent
        ? ""
        : `<span class="h-go">${escapeHtml(isUndone ? t("hist_redo_to") : t("hist_revert"))}</span>`}`;
    if (h.__side) {
      item.querySelector(".h-side").textContent =
        t(h.__side === "left" ? "cmp_base" : "cmp_source");
    }
    const sumEl = item.querySelector(".h-sum");
    const s = h.summary || "—";
    // "sysname colname: old -> new" → sysname as a yellow badge, column name
    // as a yellow button that jumps to the changed cell (single-cell batches
    // carry the same summary shape and jump via cells[0])
    const splittable = h.action === "edit" || (h.action === "edit_cells"
      && h.payload && (h.payload.cells || []).length === 1);
    const sp = splittable ? s.indexOf(" ") : -1;
    const colon = sp > 0 ? s.indexOf(":", sp) : -1;
    if (sp > 0 && colon > sp) {
      const keyEl = document.createElement("span");
      keyEl.className = "h-key";
      keyEl.textContent = s.slice(0, sp);
      const colEl = document.createElement("button");
      colEl.className = "h-col";
      colEl.textContent = s.slice(sp + 1, colon);
      colEl.addEventListener("click", ev => { ev.stopPropagation(); jumpToHistoryChange(h); });
      sumEl.append(keyEl, document.createTextNode(" "), colEl, s.slice(colon));
    } else if (h.action === "row_set") {
      // "row <key> created|transferred|updated ..." -> the key as a yellow chip
      const m = /^row (.+?) (created|transferred|updated)(.*)$/.exec(s);
      if (m) {
        const keyEl = document.createElement("span");
        keyEl.className = "h-key";
        keyEl.textContent = m[1];
        sumEl.append(keyEl, document.createTextNode(" " + m[2] + m[3]));
      } else {
        sumEl.textContent = s;
      }
    } else {
      sumEl.textContent = s;
    }
    // file name + what changed + when; the "current state" marker is compact
    // and lives at the end of the meta line
    const metaEl = item.querySelector(".h-meta");
    metaEl.textContent = (h.file || "") + " · " + tm + (isCurrent ? " · " : "");
    if (isCurrent) {
      const cur = document.createElement("span");
      cur.className = "h-current";
      cur.textContent = t("hist_current_short");
      metaEl.appendChild(cur);
    }
    // full change description on hover (the one-liner may be truncated)
    item.title = s + "\n" + (h.__path || h.file || "") + " · " + tm +
      (isCurrent ? "" : "\n" + (isUndone ? t("hist_redo_to") : t("hist_revert")));
    if (!isCurrent) {
      item.addEventListener("click", async () => {
        if (!await histConfirmSwtDirty()) return;
        const rr = await api("/api/restore", { method: "POST",
          body: JSON.stringify({ backup_id: h.id, path: h.__path }) });
        const jj = await rr.json();
        if (!jj.ok) { toast(jj.error || "error", "err"); return; }
        await histRepaintContext(h.__path, h.__side);
        toast(t("hist_restored"), "ok");
        openHistory(); // refresh the list in place
      });
    }
    body.appendChild(item);
  });
  // откат всего к началу изменений: restore самой старой записи каждого
  // файла (не сток из мода, а точка до первой правки в журнале)
  const oldest = [];
  targets.forEach(tg => {
    const recs = list.filter(h => h.__path === tg.path);
    if (recs.length) oldest.push(recs[recs.length - 1]);
  });
  if (oldest.length) {
    const allRow = document.createElement("div");
    allRow.className = "hist-stock";
    const allBtn = document.createElement("button");
    allBtn.className = "btn";
    allBtn.textContent = t("hist_reset_all") || "Откатить всё к началу";
    allBtn.onclick = async () => {
      const choice = await askConfirm({
        title: t("hist_reset_all") || "Откат к началу",
        message: t("hist_reset_all_confirm") ||
          "Все изменения из журнала будут отменены.",
        buttons: [
          { id: "ok", label: t("hist_reset_all") || "Откатить", kind: "danger" },
          { id: "cancel", label: t("cancel"), kind: "ghost" },
        ],
      });
      if (choice !== "ok") return;
      if (!await histConfirmSwtDirty()) return;
      for (const h of oldest) {
        const rr = await api("/api/restore", { method: "POST",
          body: JSON.stringify({ backup_id: h.id, path: h.__path }) });
        const jj = await rr.json();
        if (!jj.ok) { toast(jj.error || "error", "err"); return; }
        await histRepaintContext(h.__path, h.__side);
      }
      setUndoRedoButtons(false, true);
      toast(t("hist_reset_all_done") || "Откачено к началу изменений", "ok");
      openHistory();
    };
    allRow.appendChild(allBtn);
    body.appendChild(allRow);
  }
  // Работает только для файлов ВНУТРИ открытого проекта (сервер копирует
  // сток поверх файла проекта): стороны сравнения вне проекта молча
  // пропускаются, а если таких файлов нет вообще — кнопки нет.
  // полный откат к стоковой версии (из главного мода) — в самом низу журнала.
  // Работает только для файлов ВНУТРИ открытого проекта (сервер копирует
  // сток поверх файла проекта): стороны сравнения вне проекта молча
  // пропускаются, а если таких файлов нет вообще — кнопки нет.
  const stockTargets = targets.filter(tg => histInProject(tg.path));
  if (stockTargets.length) {
  const stockRow = document.createElement("div");
  stockRow.className = "hist-stock";
  const stockBtn = document.createElement("button");
  stockBtn.className = "btn danger";
  stockBtn.textContent = t("hist_stock") || "Откатить к стоковой версии";
  stockBtn.onclick = async () => {
    const choice = await askConfirm({
      title: t("hist_stock") || "Откат к стоку",
      message: t("hist_stock_confirm") ||
        "Файлы будут перезаписаны оригиналами из главного мода, журнал изменений очищен.",
      buttons: [
        { id: "ok", label: t("hist_stock") || "Откатить", kind: "danger" },
        { id: "cancel", label: t("cancel"), kind: "ghost" },
      ],
    });
    if (choice !== "ok") return;
    if (!await histConfirmSwtDirty()) return;
    let fails = 0;
    for (const tg of stockTargets) {
      const rr = await api("/api/stock_restore", { method: "POST",
        body: JSON.stringify({ path: tg.path }) });
      const jj = await rr.json();
      if (!jj.ok) {
        fails++;
        const key = { no_stock: "hist_stock_no", no_mod_path: "hist_stock_nomod",
          outside_project: "hist_stock_outside", no_project: "hist_stock_outside" }[jj.error];
        toast((key ? t(key) : (jj.error || "error")) + (jj.stock ? "\n" + jj.stock : ""), "err");
      }
    }
    if (fails === stockTargets.length) return;
    for (const tg of stockTargets) await histRepaintContext(tg.path, tg.side);
    if (stockTargets.length < targets.length) {
      toast(t("hist_stock_skip") || "Файлы вне проекта пропущены", "warn");
    }
    setUndoRedoButtons(false, false);
    toast(t("hist_stock_done") || "Восстановлена стоковая версия", "ok");
    openHistory();
  };
  stockRow.appendChild(stockBtn);
  body.appendChild(stockRow);
  }
  $("#history-modal").hidden = false;
}

// файл внутри открытого проекта (для стокового отката)
function histInProject(path) {
  const root = (state.project && state.project.root) || "";
  if (!root || !path) return false;
  const np = normPath(path).toLowerCase();
  const nr = normPath(root).toLowerCase().replace(/[\\/]+$/, "");
  return np === nr || np.startsWith(nr + "\\");
}

// ---------- drag & drop ----------
// перетаскивание из Windows Explorer: WebView2 не отдаёт пути (только имена),
// поэтому имена сопоставляем с известными корнями через /api/resolve_drop,
// а mailbox бэкенда (второй инстанс/CLI) забираем через /api/pending_files.
async function handleExternalPaths(paths, dirs) {
  paths = paths || [];
  dirs = dirs || [];
  const openables = paths.filter(p => /\.(xml|swt)$/i.test(String(p || "")));
  if (!openables.length && !dirs.length) return;
  // папка = открыть как проект; файлы + папка: сначала проект, потом файлы
  if (dirs.length) await loadProject(dirs[0]);
  for (const p of openables) await openFile(p);
}

async function pollPendingFiles() {
  try {
    const r = await api("/api/pending_files");
    const j = await r.json();
    if (j && j.ok) {
      const files = j.files || [], ds = j.dirs || [];
      if (files.length || ds.length) {
        await handleExternalPaths(files, ds);
        return { files, dirs: ds };
      }
    }
  } catch (e) { /* noop */ }
  return null;
}

// имена брошенного: файлы {name,size}, папки {name,isDir:true}
async function resolveDropItems(list) {
  const entries = [];
  try {
    for (const it of list) {
      if (!it) continue;
      if (typeof it.webkitGetAsEntry === "function") {
        const en = it.webkitGetAsEntry();
        if (en) { entries.push({ name: en.name, isDir: !!en.isDirectory }); continue; }
      }
      const f = (typeof it.getAsFile === "function") ? it.getAsFile() : it;
      if (f && f.name) entries.push({ name: f.name, size: f.size || 0, isDir: false });
    }
  } catch (e) { /* noop */ }
  if (!entries.length) return null;
  try {
    const r = await api("/api/resolve_drop", { method: "POST",
      body: JSON.stringify({ items: entries }) });
    const j = await r.json();
    if (j && j.ok) return j;
  } catch (e) { /* noop */ }
  return null;
}

// общий обработчик drop: true = событие поглощено
async function handleDropEvent(e, fromDropzone) {
  e.preventDefault();
  const dt = e.dataTransfer;
  if (!dt) return false;
  const raw = dt.getData && dt.getData("text/tsh-files");
  if (raw) {
    if (!fromDropzone) return false; // внутреннее дерево — только dropzone
    let data;
    try { data = JSON.parse(raw); } catch (err) { return true; }
    if (data) {
      if (Array.isArray(data)) data = { files: data };
      const ps = [...(data.files || [])];
      for (const fo of data.folders || []) ps.push(...(fo.paths || []));
      if (ps.length) handleExternalPaths(ps, []);
    }
    return true;
  }
  if (dt.files && dt.files.length) {
    const withPath = [];
    for (const f of dt.files) { if (f && f.path) withPath.push(f.path); }
    if (withPath.length) { await handleExternalPaths(withPath, []); return true; }
    // WebView2 путей не отдаёт — сначала mailbox: нативный слой (WM_DROPFILES)
    // кладёт туда ТОЧНЫЕ пути, это ровно функция кнопок (любой файл/папка).
    // Нашёлся — resolve по именам уже не нужен.
    const got = await pollPendingFiles();
    if (got) return true;
    const res = await resolveDropItems(
      (dt.items && dt.items.length) ? dt.items : dt.files);
    if (res && ((res.files && res.files.length) || (res.dirs && res.dirs.length))) {
      await handleExternalPaths(res.files || [], res.dirs || []);
      return true;
    }
    // нативный drop мог прийти позже JS-события: тост «не нашёл» — только
    // после повторного забора mailbox, иначе ложно ругаемся на рабочий дроп
    const names = [];
    for (const f of dt.files) { if (f && f.name) names.push(f.name); }
    const un = (res && res.unknown && res.unknown.length)
      ? res.unknown.join(", ") : names.join(", ");
    setTimeout(async () => {
      const got2 = await pollPendingFiles();
      if (!got2 && un) toast((t("drop_no_match") || "Не нашёл в проекте: ") + un, "warn");
    }, 1200);
    return true;
  }
  return false;
}

function setupDnD() {
  const dz = $("#dropzone");
  ["dragover", "dragenter"].forEach(evt => dz.addEventListener(evt, e => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach(evt => dz.addEventListener(evt, e => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", e => {
    e.preventDefault();
    dz.classList.remove("drag");
    handleDropEvent(e, true);
  });
  // документ-уровень: drop вне dropzone тоже открывает XML
  ["dragover", "dragenter"].forEach(evt => document.addEventListener(evt, e => {
    e.preventDefault();
  }));
  document.addEventListener("drop", e => {
    if (e.target && e.target.closest && e.target.closest("#dropzone")) return;
    handleDropEvent(e, false);
  });
  // окно получает файлы второго запуска каждые 3с
  setInterval(pollPendingFiles, 3000);
}

// ---------- recents (popup with a scrollable, informative list) ----------
async function openRecentsModal() {
  const r = await api("/api/recents");
  const list = await r.json();
  const body = $("#recents-body");
  body.innerHTML = "";
  if (!list.length) {
    body.innerHTML = `<div class="recents-empty">${escapeHtml(t("recents_empty"))}</div>`;
  }
  (Array.isArray(list) ? list : []).forEach(x => {
    const isProj = x.kind === "project";
    const name = String(x.path).split(/[\\/]/).filter(Boolean).pop() || x.path;
    const item = document.createElement("div");
    item.className = "recent-row" + (x.exists === false ? " missing" : "");
    const ico = isProj ? FOLDER_SVG : `<img src="${getFileIcon(x.path)}" alt="">`;
    item.innerHTML = `
      <span class="rr-ico">${ico}</span>
      <span class="rr-main">
        <span class="rr-name"></span>
        <span class="rr-path"></span>
        <span class="rr-meta"></span>
      </span>
      <span class="rr-kind">${isProj ? escapeHtml(t("project_kind")) : escapeHtml(t("file_kind"))}</span>`;
    item.querySelector(".rr-name").textContent = name;
    item.querySelector(".rr-path").textContent = x.path;
    const bits = [t("opened") + ": " + (x.last_opened ? fmtDate(x.last_opened) : "—")];
    if (typeof x.mtime === "number" && x.mtime > 0) bits.push(t("modified") + ": " + fmtDate(x.mtime));
    if (typeof x.size === "number") bits.push(fmtSize(x.size));
    if (x.exists === false) bits.push(t("missing"));
    item.querySelector(".rr-meta").textContent = bits.join(" · ");
    item.title = x.path;
    item.addEventListener("click", () => {
      $("#recents-modal").hidden = true;
      if (x.exists === false) { toast(t("missing"), "err"); return; }
      if (isProj) loadProject(x.path); else openFile(x.path);
    });
    body.appendChild(item);
  });
  $("#recents-modal").hidden = false;
}

// ---------- self-updates (worker over GitHub releases) ----------
let updState = null;
let updPollTimer = null;
let updRestarted = false;

function updDot(on) {
  const d = $("#btn-update-dot");
  if (d) d.hidden = !on;
}

async function updStateLoad() {
  try {
    const r = await api("/api/update_state");
    const j = await r.json();
    if (j && j.ok) {
      updState = j;
      // updater поставил новую версию и поднял нас: один тост об этом
      // (маркер одноразовый, бэкенд его уже съел)
      if (j.just_updated) {
        toast((t("upd_just_updated") || "Установлено обновление")
          + " " + j.just_updated, "ok");
      }
    }
  } catch (e) { /* офлайн на старте: молча */ }
  updPaint();
  return updState;
}

function updPaint() {
  const pend = updState && updState.pending;
  const has = !!(updState && (updState.available
    || (pend && pend.version)));
  updDot(has);
  // кнопка в шапке видна только когда обновление найдено (после старта
  // или фоновой перепроверки); ручная проверка — во вкладке настроек
  const b = $("#btn-update");
  if (b) b.hidden = !has;
  const st = $("#set-upd-state");
  if (st) {
    if (updState && updState.available) {
      st.textContent = (t("upd_avail") || "Доступно: ")
        + updState.available.version;
    } else if (pend && pend.version) {
      st.textContent = (t("upd_staged_short") || "Загружено: ")
        + pend.version;
    } else if (updState) {
      st.textContent = (t("upd_uptodate") || "Установлена последняя версия")
        + " " + updState.current;
    }
  }
  const ch = $("#set-upd-channel");
  if (ch && updState) ch.value = updState.channel || "release";
  updPaintInline();
}

// вкладка обновлений в настройках: changelog прямо в окне (со скроллом),
// кнопки скачивания и подсказка про перезапуск
function updPaintInline() {
  const avail = updState && updState.available;
  const pend = updState && updState.pending;
  const notes = $("#upd-notes");
  if (notes) {
    notes.textContent = (avail && avail.notes) || "";
    notes.hidden = !(avail && avail.notes);
  }
  const acts = $("#upd-actions"), dl = $("#upd-download");
  const inst = $("#upd-install");
  const prog = $("#upd-progress"), hint = $("#upd-hint");
  if (pend && pend.version && (!avail || avail.version === pend.version)) {
    // уже скачано: установка — кнопкой через внешний updater
    // (сам всё заменит и перезапустит; руками перезапускать не надо)
    if (hint) hint.textContent = (t("upd_restart_hint")
      || "Обновление загружено.")
      + " (" + pend.version + ")";
    if (acts) acts.hidden = false;
    if (dl) dl.hidden = true;
    if (inst) inst.hidden = false;
    if (prog) prog.hidden = true;
  } else if (avail) {
    if (hint) hint.textContent = (t("upd_avail") || "Доступно: ")
      + avail.version;
    if (acts) acts.hidden = false;
    if (dl) { dl.hidden = false; dl.disabled = false; }
    if (inst) inst.hidden = true;
  } else {
    if (hint) hint.textContent = "";
    if (acts) acts.hidden = true;
    if (prog) prog.hidden = true;
  }
}

async function updCheck(force, silent) {
  const st = $("#set-upd-state");
  if (!silent && st) st.textContent = t("upd_checking") || "Проверка…";
  let j = null;
  try {
    const r = await api("/api/update_check", { method: "POST",
      body: JSON.stringify({ force: !!force }), timeout: 30000 });
    j = await r.json();
  } catch (e) { j = null; }
  if (!j || !j.ok) {
    if (!silent) toast((j && j.error) || "update check failed", "err");
    else await updStateLoad();
    return null;
  }
  await updStateLoad();
  if (updState && updState.available) {
    // список изменений — прямо во вкладке обновлений
    if (!silent) openSettings("updates");
  }
  else if (!silent) {
    toast((t("upd_uptodate") || "Установлена последняя версия")
      + (updState ? " " + updState.current : ""), "ok");
  }
  return updState;
}

async function updDownload() {
  const dl = $("#upd-download");
  if (dl) dl.disabled = true;
  updRestarted = false;
  let j = null;
  try {
    const r = await api("/api/update_download", { method: "POST",
      body: JSON.stringify({}) });
    j = await r.json();
  } catch (e) { j = null; }
  if (!j || !j.ok) {
    toast((j && j.error) || "download failed", "err");
    if (dl) dl.disabled = false;
    return;
  }
  updPollStart();
}

// установка staged-обновления: внешний updater всё заменит и поднимет
// новую версию сам; текущий процесс выходит сразу после ответа
async function updDoRestart() {
  try {
    const r = await api("/api/update_restart", { method: "POST",
      body: "{}", timeout: 15000 });
    const j = await r.json();
    if (!j || !j.ok) {
      toast((j && j.error) || "restart failed", "err");
      return false;
    }
    return true;
  } catch (e) {
    toast(String((e && e.message) || e), "err");
    return false;
  }
}

async function updInstall() {
  const inst = $("#upd-install");
  if (inst) inst.disabled = true;
  updRestarted = false;
  toast(t("upd_applying") || "Applying update…", "ok");
  await updDoRestart();
  if (inst) inst.disabled = false;
}

function updPollStart() {
  updPollStop();
  updPollTick();
  updPollTimer = setInterval(updPollTick, 600);
}

function updPollStop() {
  if (updPollTimer) { clearInterval(updPollTimer); updPollTimer = null; }
}

async function updPollTick() {
  let j = null;
  try {
    const r = await api("/api/update_progress");
    j = await r.json();
  } catch (e) { return; }
  const p = j && j.progress;
  if (!p) return;
  const bar = $("#upd-progress"), fill = $("#upd-fill"), pct = $("#upd-pct");
  if (p.state === "downloading" || p.state === "extracting") {
    if (bar) bar.hidden = false;
    const total = p.total || 0, done = p.done || 0;
    const pc = total > 0 ? Math.min(99, Math.floor(done * 100 / total)) : 0;
    if (fill) fill.style.width = (p.state === "extracting" ? 100 : pc) + "%";
    if (pct) pct.textContent = p.state === "extracting"
      ? (t("upd_extracting") || "Распаковка…")
      : pc + "% · " + fmtSize(done) + " / " + (total ? fmtSize(total) : "?");
  } else if (p.state === "staged") {
    updPollStop();
    if (bar) bar.hidden = true;
    if (!updRestarted) {
      // обновление скачано: сразу установка через updater, руками не надо
      updRestarted = true;
      toast(t("upd_restarting") || "Restarting…", "ok");
      if (await updDoRestart()) return;
      updRestarted = false;
    }
    // рестарт не вышел (updater не стартовал): показать staged-состояние
    // с кнопкой ручной установки
    await updStateLoad();
    updPaintInline();
  } else if (p.state === "error") {
    updPollStop();
    if (bar) bar.hidden = true;
    toast(p.error || "download failed", "err");
    const dl = $("#upd-download");
    if (dl) dl.disabled = false;
  }
}

function updSetup() {
  const b = $("#btn-update");
  if (b) b.onclick = () => {
    const pend = updState && updState.pending;
    if (updState && (updState.available || (pend && pend.version))) {
      openSettings("updates");
    } else updCheck(true, false);
  };
  const sc = $("#set-upd-check");
  if (sc) sc.onclick = () => updCheck(true, false);
  const ch = $("#set-upd-channel");
  if (ch) ch.onchange = async () => {
    try {
      const r = await api("/api/update_channel", { method: "POST",
        body: JSON.stringify({ channel: ch.value }) });
      const j = await r.json();
      if (!j || !j.ok) { toast((j && j.error) || "error", "err"); return; }
      await updStateLoad();
      if (updState && updState.available) openSettings("updates");
      else {
        toast((t("upd_uptodate") || "Установлена последняя версия")
          + (updState ? " " + updState.current : ""), "ok");
      }
    } catch (e) { toast(String((e && e.message) || e), "err"); }
  };
  const dl = $("#upd-download");
  if (dl) dl.onclick = updDownload;
  const inst = $("#upd-install");
  if (inst) inst.onclick = updInstall;
  const aboutC = $("#about-check");
  if (aboutC) aboutC.onclick = () => {
    $("#about-modal").hidden = true;
    updCheck(true, false);
  };
  const aboutU = $("#about-updates");
  if (aboutU) aboutU.onclick = () => {
    $("#about-modal").hidden = true;
    openSettings("updates");
  };
  const aboutD = $("#about-donate");
  if (aboutD) aboutD.onclick = () => api("/api/open_link", { method: "POST",
    body: JSON.stringify({ url: DONATE_URL }) });
  // автообновление при старте (по умолчанию выкл, галка в настройках):
  // тихие проверки + добив staged через updater; без галки — только руки
  if (state.config && state.config.auto_update) {
    // фоновая перепроверка каждые 30 минут (forced: суточный троттлинг
    // бэкенда её бы гасил — обновление, вышедшее после запуска, иначе
    // не находится); суточная автопроверка после старта не тормозит boot
    setInterval(() => updCheck(true, true), 30 * 60 * 1000);
    setTimeout(() => updCheck(false, true), 8000);
    // добив: загрузка идёт фоном в лаунчере — ждём её конца (20с пауза),
    // затем staged (или висящий pending) уходит в updater сам
    setTimeout(updAutoStart, 20000);
  }
}

let updAutoArmed = false;
let updAutoTried = false; // авторестарт — разовый, дальше только руками
function updAutoStart() {
  if (updAutoArmed) return;
  updAutoArmed = true;
  updAutoTick();
  setInterval(updAutoTick, 2000);
}

async function updAutoTick() {
  if (!state.config || !state.config.auto_update || updRestarted
    || updAutoTried) return;
  let p = null;
  try {
    const r = await api("/api/update_progress");
    p = (await r.json()).progress;
  } catch (e) { return; }
  // качается/распаковывается — ждём; ошибка — ждём рук
  if (p && (p.state === "downloading" || p.state === "extracting"
    || p.state === "error")) return;
  if (p && p.state === "staged") {
    updAutoTried = true;
    updRestarted = true;
    toast(t("upd_restarting") || "Restarting…", "ok");
    if (await updDoRestart()) return;
    updRestarted = false;
    return;
  }
  // докачки нет, а pending висит (updater прошлого раза не отработал
  // или boot-apply не смог): разовый добив через updater
  await updStateLoad();
  const pend = updState && updState.pending;
  if (pend && pend.version) {
    updAutoTried = true;
    updRestarted = true;
    toast(t("upd_restarting") || "Restarting…", "ok");
    if (await updDoRestart()) return;
    updRestarted = false;
  }
}

// ---------- init ----------
async function init() {
  document.body.classList.add("dark");
  bootPing(25, ""); // скрипты встали, дальше этапы с подписями
  await loadConfig();
  await loadI18n();
  // страница прошла критичную фазу: watchdog не должен её перезагружать
  window.__tshBooted = true;
  try { sessionStorage.removeItem("tsh_boot_reload"); } catch (e) { /* приватный режим */ }
  bootPing(40, t("boot_config"));
  setupDnD();
  setupSidebar();
  setupTabBar();
  setupCmpSearch();
  setupKeyDropdown();
  setupCmpFs();
  setupSwtFind();
  setupSwt();
  setupUprising();
  // иконки темы — одним запросом в память, фоном (дерево/вкладки больше
  // не открывают по коннекту на каждую иконку)
  preloadIcons();
  // инструменты недоступны пока не прогрузятся деревья (updateToolButtons
  // включает кнопки по мере загрузки каждого источника)
  updateToolButtons();

  // Create welcome tab
  createTab("welcome", {});

  $("#tab-open-file").onclick = () => activateTab("welcome");
  $("#landing-open-file").onclick = openFileDialog;
  $("#landing-open-project").onclick = openProjectDialog;
  $("#btn-save").onclick = () => saveActive(true);
  $("#btn-fix").onclick = fixCurrentFile;
  $("#btn-undo").onclick = undoCurrent;
  $("#btn-redo").onclick = redoCurrent;
  setUndoRedoButtons(false, false);
  $("#btn-compare").onclick = openCompare;
  $("#btn-create-mod").onclick = openCreateMod;
  $("#btn-unpacker").onclick = openUnpacker;
  $("#btn-uprising").onclick = () => openUprising();
  $("#btn-swt").onclick = openSwtEditor;
  $("#landing-create-mod").onclick = openCreateMod;
  $("#landing-unpacker").onclick = openUnpacker;
  $("#landing-uprising").onclick = () => openUprising();
  $("#landing-compare").onclick = openCompare;
  $("#landing-swt").onclick = openSwtEditor;
  $("#cm-pick-dir").onclick = cmPickDir;
  $("#cm-pick-icon").onclick = cmPickIcon;
  $("#cm-create").onclick = cmCreate;
  $("#cm-copy-files").onclick = cmCopyFiles;
  // живая подсказка «Создастся: <игра>\Mods\имя»
  const cmHint = () => cmPathHint();
  $("#cm-name").addEventListener("input", cmHint);
  $("#cm-game-dir").addEventListener("input", cmHint);
  cmHint();
  $("#cm-target-mod").onchange = updateCmButtons;
  $("#cm-clear-files").onclick = () => { state.cmFiles = []; cmRenderFiles(); };
  const cmDrop = $("#cm-dropzone");
  if (cmDrop) {
    ["dragover", "dragenter"].forEach(evt => cmDrop.addEventListener(evt, e => {
      e.preventDefault(); e.stopPropagation();
      cmDrop.classList.add("drag");
    }));
    ["dragleave", "drop"].forEach(evt => cmDrop.addEventListener(evt, e => {
      e.preventDefault(); cmDrop.classList.remove("drag");
    }));
    cmDrop.addEventListener("drop", e => {
      e.preventDefault(); e.stopPropagation();
      const raw = e.dataTransfer && e.dataTransfer.getData("text/tsh-files");
      if (!raw) return;
      let data;
      try { data = JSON.parse(raw); } catch (err) { return; }
      if (Array.isArray(data)) data = { files: data };
      cmAddFiles(data || {});
    });
  }
  // unpacker page wiring
  const upRoot = $("#up-root"), upDest = $("#up-dest");
  if (upRoot && upDest) {
    upRoot.value = localStorage.getItem("tsh_up_root") || "";
    upDest.value = localStorage.getItem("tsh_up_dest") || "C:\\TDF_Unpacked";
    $("#up-pick-root").onclick = async () => {
      const d = await pickFolder();
      if (d) { upRoot.value = d; localStorage.setItem("tsh_up_root", d); }
    };
    $("#up-pick-dest").onclick = async () => {
      const d = await pickFolder();
      if (d) { upDest.value = d; localStorage.setItem("tsh_up_dest", d); }
    };
    $("#up-scan").onclick = upScan;
    $("#up-run").onclick = upRun;
    $("#up-abort").onclick = upAbort;
  }
  $("#btn-settings").onclick = () => openSettings();
  $("#btn-history").onclick = openHistory;
  $("#btn-about").onclick = openAbout;
  $("#btn-donate").onclick = () => api("/api/open_link", { method: "POST",
    body: JSON.stringify({ url: DONATE_URL }) });
  updSetup();
  updStateLoad();
  bindTabCtxMenu();
  bindTreeCtxMenu();
  $("#landing-records-btn").onclick = openRecentsModal;
  $("#recents-clear").onclick = async () => {
    const choice = await askConfirm({
      title: t("recents_clear"),
      message: t("recents_clear_confirm"),
      buttons: [
        { id: "ok", label: t("recents_clear"), kind: "danger" },
        { id: "cancel", label: t("cancel"), kind: "ghost" },
      ],
    });
    if (choice !== "ok") return;
    await api("/api/recents/clear", { method: "POST" });
    toast(t("recents_cleared"), "ok");
    openRecentsModal(); // refresh the list in place
  };
  // click the file path in the header -> show it in Explorer
  $("#file-path").addEventListener("click", async () => {
    const p = state.currentFile && state.currentFile.path;
    if (!p) return;
    try { await api("/api/reveal", { method: "POST", body: JSON.stringify({ path: p }) }); }
    catch (e) { /* noop */ }
  });
  // вкладки древа в шапке сайдбара — тот же глобальный источник
  $("#sb-tab-project").addEventListener("click", e => {
    e.stopPropagation();
    sbTabClick("project");
  });
  $("#sb-tab-game").addEventListener("click", e => {
    e.stopPropagation();
    sbTabClick("game");
  });
  $("#sb-tab-mod").addEventListener("click", e => {
    e.stopPropagation();
    sbTabClick("mod");
  });

  // restore grid font size
  const gf = parseInt(localStorage.getItem("gridFont") || "12", 10);
  document.documentElement.style.setProperty("--grid-font", gf + "px");
  // restore scales (content text + UI)
  applyZooms();
  // restore the sticky sysname column width (drag-resizable header);
  // the compare panes share the same width but never follow the font size
  const sw = parseInt(localStorage.getItem("stickyW"), 10);
  if (sw && !isNaN(sw)) {
    document.documentElement.style.setProperty("--sticky-w", sw + "px");
    document.documentElement.style.setProperty("--cmp-sticky-w", sw + "px");
  }

  setupWindowControls();
  setupContextMenu();
  setupFindBars();
  setupHotkeys();

  $$("[data-close]").forEach(b => b.onclick = () => {
    const modal = b.closest(".modal"); if (modal) modal.hidden = true;
    if (modal && modal.id === "settings-modal") hkCaptureStop();
  });
  // close modal by clicking the backdrop (outside the card)
  $$(".modal").forEach(modal => modal.addEventListener("click", e => {
    if (e.target === modal) {
      modal.hidden = true;
      if (modal.id === "settings-modal") hkCaptureStop();
    }
  }));
  // Esc закрывает поповер правки юнита и верхнюю открытую модалку.
  // confirm/prompt исключены: там обязателен явный выбор (иначе повиснет await).
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (typeof uprEditPopCloser === "function" && uprEditPopCloser) {
      e.preventDefault();
      uprEditPopCloser();
      return;
    }
    const open = [...document.querySelectorAll(".modal:not([hidden])")]
      .filter(m => m.id !== "confirm-modal" && m.id !== "prompt-modal");
    const top = open.pop();
    if (top) {
      e.preventDefault();
      top.hidden = true;
      if (top.id === "settings-modal") hkCaptureStop();
    }
  });
  // settings save on change
  ["auto-save", "fullscreen", "theme", "keycol", "window-size", "tray", "open-browser", "browser-to-tray", "lang"].forEach(id => {
    $("#set-" + id).addEventListener("change", saveSettings);
  });
  setupSettingsTabs();
  // paths tab: pick + save folders manually
  $("#set-unpacked-pick").addEventListener("click", async () => {
    const p = await pickFolder();
    if (p) $("#set-unpacked").value = p;
  });
  $("#set-project-pick").addEventListener("click", async () => {
    const p = await pickFolder();
    if (p) $("#set-project-path").value = p;
  });
  $("#set-unpacked-save").addEventListener("click", async () => {
    const p = $("#set-unpacked").value.trim();
    const mp = $("#set-mod-path").value.trim();
    const pp = $("#set-project-path").value.trim();
    const r = await api("/api/config", { method: "POST",
      body: JSON.stringify({ unpacked_path: p, mod_path: mp, project_path: pp }) });
    const j = await r.json();
    if (j.ok) {
      state.config.unpacked_path = p;
      state.config.mod_path = mp;
      state.config.project_path = pp;
      refreshSrcPaths();
      toast(t("save_success"), "ok");
    }
  });
  $("#set-mod-pick").addEventListener("click", async () => {
    const p = await pickFolder();
    if (p) $("#set-mod-path").value = p;
  });
  // open the UI in the default system browser
  $("#btn-open-browser").onclick = async () => {
    try {
      await api("/api/open_browser", { method: "POST", body: "{}" });
      // настройка «сворачивать в трей при открытии в браузере»:
      // прячем окно, иконка в трее возвращает его кликом
      if (state.config.browser_to_tray && window.pywebview && pywebview.api
          && pywebview.api.minimize_to_tray) {
        try { await pywebview.api.minimize_to_tray(); } catch (e) { /* noop */ }
      }
    }
    catch (e) { toast(String(e.message || e), "err"); }
  };
  // масштабы (текст тела / интерфейс) применяются мгновенно (localStorage)
  $("#set-content-zoom").addEventListener("change", e => setZoom("contentZoom", parseFloat(e.target.value)));
  $("#set-ui-zoom").addEventListener("change", e => setZoom("uiZoom", parseFloat(e.target.value)));
  $("#cmp-run").onclick = runCompare;
  $("#cmp-merge").onclick = mergeAll;
  ["left", "right"].forEach(side => {
    $("#cmp-" + side + "-fs").onclick = () => cmpFullscreen(side);
  });
  ["left", "right"].forEach(side => {
    $("#cmp-" + side + "-file").onclick = () => cmpPick(side, "file");
    $("#cmp-" + side + "-dir").onclick = () => cmpPick(side, "folder");
    $("#cmp-" + side + "-clear").onclick = () => cmpClear(side);
    $("#cmp-" + side + "-path").addEventListener("keydown", e => {
      if (e.key === "Enter") runCompare();
    });
    // compact file dropdown: toggle the floating list
    $("#cmp-" + side + "-dd-btn").addEventListener("click", e => {
      e.stopPropagation();
      const list = $("#cmp-" + side + "-list");
      list.hidden = !list.hidden;
    });
  });
  // click outside any compare dropdown closes it
  document.addEventListener("click", e => {
    ["left", "right"].forEach(side => {
      const dd = $("#cmp-" + side + "-dd");
      if (dd && !dd.contains(e.target)) $("#cmp-" + side + "-list").hidden = true;
    });
  });
  // compare pane virtualization: append more rows when scrolled near the bottom
  ["left", "right"].forEach(side => {
    $("#cmp-pane-" + side).addEventListener("scroll", e => {
      const pane = e.target;
      if (!state.cmpCtx) return;
      if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 800) {
        appendCmpRows(side, CMP_CHUNK);
      }
    }, { passive: true });
  });
  // transfer arrows are delegated (rows render in chunks)
  $("#cmp-table-right").addEventListener("click", e => {
    const b = e.target.closest("button.cmp-copy");
    if (!b || !state.cmpCtx) return;
    const item = state.cmpCtx.visible[parseInt(b.dataset.i, 10)];
    if (item) transferRow(item.d);
  });
  // правка ячеек прямо в диф-режиме (dblclick по ячейке любой панели)
  ["left", "right"].forEach(side => {
    const tbl = $("#cmp-table-" + side);
    if (!tbl) return;
    tbl.addEventListener("dblclick", e => {
      const td = e.target.closest("tbody td[data-row]");
      if (!td || !state.cmpCtx) return;
      cmpBeginDiffEdit(side, td, parseInt(td.dataset.row, 10), parseInt(td.dataset.col, 10));
    });
  });
  setupCmpSyncScroll();
  setupCmpSrcSwitch();
  updateCmpSrcSwitch();
  $("#set-theme").addEventListener("change", () => {
    document.body.classList.toggle("light", $("#set-theme").value === "light");
  });

  // Tab bar scrolls with the mouse wheel (setupTabBar); no arrow buttons.

  // reset any stray ancestor scroll (e.g. after scrollIntoView in old sessions)
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;

  // Tree filter (debounced)
  let tfTimer = null;
  $("#tree-filter").addEventListener("input", e => {
    clearTimeout(tfTimer);
    tfTimer = setTimeout(() => {
      state.treeFilter = e.target.value.trim();
      renderTree();
    }, 200);
  });

  // Tree filter dropdown (extensions + folders)
  loadTreeFilters();
  const tfBtn = $("#tree-filter-btn");
  const tfMenu = $("#tree-filter-menu");
  if (tfBtn && tfMenu) {
    tfBtn.addEventListener("click", e => {
      e.stopPropagation();
      tfMenu.hidden = !tfMenu.hidden;
      if (!tfMenu.hidden) populateTreeFilterMenu();
    });
    tfMenu.addEventListener("click", e => e.stopPropagation());
    document.addEventListener("click", () => hideTreeFilterMenu());
    $("#tfm-search").addEventListener("input", populateTreeFilterMenu);
    $("#tfm-default").addEventListener("click", () => {
      loadTreeFilters(true);
      saveTreeFilters();
      populateTreeFilterMenu();
      renderTree();
    });
    $("#tfm-all").addEventListener("click", () => {
      state.treeExtFilter = null;
      state.treeFolderFilter = null;
      saveTreeFilters();
      populateTreeFilterMenu();
      renderTree();
    });
  }

  // проект прошлого запуска (project_path в приоритете) грузится фоном
  // в конце init: лаунчер его не ждёт (см. bootChain ниже)
  bootPing(50, t("boot_ui"));
  const lastProj = state.config.project_path || state.config.last_project;
  // тяжёлые обходы игры/мода (секунды на распакованной игре) — фоном, лаунчер
  // не держат: древо показывает «Загрузка…», пока walk не вернулся
  if ((state.config.unpacked_path) || "") loadGameTree().then(() => bgTreeDone("game")).catch(() => {});
  if ((state.config.mod_path) || "") loadModTree().then(() => bgTreeDone("mod")).catch(() => {});
  // сохранённый глобальный источник (миграция со старого ключа карты)
  let want = "project";
  try {
    want = localStorage.getItem("tsh_src") ||
      (localStorage.getItem("tsh_upr_src") === "game" ? "game" : "project");
  } catch (e) { /* приватный режим */ }
  if (!SRC_ORDER.includes(want)) want = "project";
  state.treeView = srcAvail(want) ? want : (srcFirst(null) || "project");
  try { localStorage.setItem("tsh_src", state.treeView); } catch (e) { /* noop */ }
  try {
    const cl = localStorage.getItem("tsh_cmp_left"), cr = localStorage.getItem("tsh_cmp_right");
    if (cl && srcAvail(cl)) state.cmpSrc.left = cl;
    if (cr && srcAvail(cr)) state.cmpSrc.right = cr;
  } catch (e) { /* noop */ }
  state.treeCounts = null;
  const initRoot = treeRoot();
  if (initRoot) computeTreeCounts(initRoot);
  paintTreeTitle();
  paintSrcSwitches();
  renderTree();
  bootPing(88, t("boot_tree"));

  renderTabBar();
  activateTab("welcome");
  // интерфейс жив сразу: лаунчер гаснет, тяжёлое (walk проекта по холодному
  // HDD) — фоном. Раньше main_ready ждал loadProject и лаунчер висел минутами.
  // мост pywebview появляется асинхронно: без AdGuard-тормозов init добегает
  // раньше моста и один вызов терялся навсегда (splash висел с последним
  // label при живом фронте) — долбим до доставки, бэкенд идемпотентен
  let _mrTries = 0;
  (function mainReadyPing() {
    try {
      if (window.pywebview && pywebview.api && pywebview.api.main_ready) {
        pywebview.api.main_ready();
        return;
      }
    } catch (e) { /* браузерный режим */ return; }
    // в браузере моста нет и не будет — не крутить вечно (30с с запасом)
    if (++_mrTries < 60) setTimeout(mainReadyPing, 500);
  })();
  bootPing(88, t("boot_tree"));
  // проект прошлого запуска + вкладки — фоном, порядок сохранён.
  // Флаг bootLoading отличает «проект ещё грузится» от «проекта нет»:
  // клик по вкладке Проект во время загрузки не открывает диалог.
  let bootChain;
  if (lastProj) {
    const parts = String(lastProj).split(/[\\/]/).filter(Boolean);
    bootPing(60, (t("boot_project") || "") + " " + (parts.pop() || lastProj));
    state.bootLoading = true;
    bootChain = loadProject(lastProj).then(() => bootPing(78, t("boot_tree")));
  } else {
    bootChain = Promise.resolve();
  }
  // восстановить вкладки, открытые до перезагрузки страницы (watchdog/F5)
  bootChain.then(() => restoreTabs())
    .then(() => { state.bootLoading = false; bootPing(95, t("boot_tabs")); })
    .catch(() => { state.bootLoading = false; });
}

function setupTabBar() {
  const scroll = $("#tab-bar-scroll");

  // Mouse wheel scrolls the tab bar on hover
  scroll.addEventListener("wheel", e => {
    if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
      e.preventDefault();
      scroll.scrollLeft += (e.deltaY || e.deltaX);
    }
  }, { passive: false });

  // Touch scroll support for tab bar
  let isDown = false, startX, scrollLeft;
  scroll.addEventListener("mousedown", e => {
    if (e.target.closest(".tab")) return;
    isDown = true;
    startX = e.pageX - scroll.offsetLeft;
    scrollLeft = scroll.scrollLeft;
    scroll.style.cursor = "grabbing";
  });
  scroll.addEventListener("mouseleave", () => { isDown = false; scroll.style.cursor = ""; });
  scroll.addEventListener("mouseup", () => { isDown = false; scroll.style.cursor = ""; });
  scroll.addEventListener("mousemove", e => {
    if (!isDown) return;
    e.preventDefault();
    const x = e.pageX - scroll.offsetLeft;
    scroll.scrollLeft = scrollLeft - (x - startX) * 2;
  });
  scroll.addEventListener("scroll", updateTabBarScroll, { passive: true });

  // Overflow menu: list all tabs
  $("#tab-bar-menu").addEventListener("click", e => {
    e.stopPropagation();
    toggleTabsDropdown();
  });
  document.addEventListener("mousedown", e => {
    const dd = $("#tabs-dropdown");
    if (!dd.hidden && !e.target.closest("#tabs-dropdown") && !e.target.closest("#tab-bar-menu")) {
      dd.hidden = true;
    }
  });
}

const ICON_MAX = '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
const ICON_RESTORE = '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3 2.5V.5h6.5V7H7.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';

function setMaxIcon(max) {
  $("#btn-max").innerHTML = max ? ICON_RESTORE : ICON_MAX;
}

function setupWindowControls() {
  // show native-window buttons only inside pywebview (frameless mode)
  const reveal = () => { $("#window-controls").hidden = false; };
  if (window.pywebview && pywebview.api) {
    reveal();
  } else {
    window.addEventListener("pywebviewready", reveal, { once: true });
  }

  $("#btn-min").onclick = () => {
    if (window.pywebview && pywebview.api && pywebview.api.minimize) pywebview.api.minimize();
  };
  $("#btn-max").onclick = async () => {
    if (window.pywebview && pywebview.api && pywebview.api.toggle_maximize) {
      try { setMaxIcon(!!(await pywebview.api.toggle_maximize())); } catch (e) { /* noop */ }
    }
  };
  $("#btn-close").onclick = () => {
    if (window.pywebview && pywebview.api && pywebview.api.close_window) {
      pywebview.api.close_window();
    } else if (window.close) {
      window.close();
    }
  };

  // double-click on the drag region toggles maximize (native behaviour)
  $(".topbar").addEventListener("dblclick", e => {
    if (e.target.closest("button") || e.target.closest(".pywebview-no-drag")) return;
    if (window.pywebview && pywebview.api && pywebview.api.toggle_maximize) {
      pywebview.api.toggle_maximize().then(setMaxIcon).catch(() => {});
    }
  });
}

function setupSidebar() {
  const sidebar = $("#sidebar");
  const resizer = $("#sidebar-resizer");
  const toggle = $("#sidebar-toggle");
  const header = $(".sidebar-header");

  // Toggle collapse (button + whole header acts as a collapse button);
  // the floating accent button restores the sidebar when collapsed
  const doCollapse = () => toggleSidebar();
  toggle.onclick = e => { e.stopPropagation(); doCollapse(); };
  header.addEventListener("click", () => doCollapse()); // whole header = collapse button
  $("#sidebar-fab").addEventListener("click", () => doCollapse());
  // red X: close the ACTIVE source (does NOT collapse).
  // раньше закрывался только проект: на вкладках «Игра»/«Мод» древо тут же
  // переключалось обратно на тот же источник — крестик «не работал»
  $("#sidebar-close").onclick = async e => {
    e.stopPropagation();
    const v = state.treeView;
    // корень закрываемого источника — для инвалидации карт/файлов,
    // живших внутри него (фантомы после закрытия)
    const closedRoot = (v === "mod" || v === "game")
      ? (state.config[v === "mod" ? "mod_path" : "unpacked_path"] || "")
      : ((state.project && state.project.root) || "");
    if (v === "mod" || v === "game") {
      const key = v === "mod" ? "mod_path" : "unpacked_path";
      try {
        await api("/api/config", { method: "POST",
          body: JSON.stringify({ [key]: "" }) });
      } catch (err) { /* keep clearing client-side regardless */ }
      state.config[key] = "";
      if (v === "mod") state.modTree = null;
      else state.gameTree = null;
    } else {
      try {
        await api("/api/close_project", { method: "POST", body: "{}" });
      } catch (err) { /* keep clearing client-side regardless */ }
      state.project = null;
      state.nameMap = {};
      state.editedFiles = new Set();
      state.fullTree = null;
    }
    // древо переходит на первый доступный источник (закрытый уже выбыл:
    // путь отвязан, кэш дерева сброшен)
    const fb = srcFirst(null);
    if (fb) {
      state.treeView = fb;
      try { localStorage.setItem("tsh_src", fb); } catch (e) { /* приватный режим */ }
      if (fb === "game") await loadGameTree();
      if (fb === "mod") await loadModTree();
      state.treeCounts = null;
      const root = treeRoot();
      if (root) computeTreeCounts(root);
    } else {
      state.treeCounts = null;
    }
    paintTreeTitle();
    paintSrcSwitches();
    renderTree();
    updateToolButtons();
    // карта жила внутри закрытого корня — снести, иначе фантом
    if (closedRoot && state.tabs.some(tb => tb.id === "uprising")
        && state.uprising.path) {
      const np = normPath(state.uprising.path).toLowerCase();
      const nr = normPath(closedRoot).toLowerCase();
      if (np === nr || np.startsWith(nr + "\\")) uprInvalidateSource();
    }
    const tf = $("#tree-filter");
    if (tf) tf.value = "";
    hideTreeFilterMenu();
    updateSidebarVisibility();
  };
  // tiny broom: delete <project_name>.json (the edited-files marks)
  const clrBtn = $("#sidebar-clear-edited");
  if (clrBtn) clrBtn.onclick = e => { e.stopPropagation(); clearEditedMarks(); };

  // Resize drag
  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  resizer.addEventListener("mousedown", e => {
    if (state.sidebarCollapsed) return;
    dragging = true;
    startX = e.clientX;
    startWidth = state.sidebarWidth;
    resizer.classList.add("dragging");
    document.body.classList.add("sidebar-resizing");
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", e => {
    if (!dragging) return;
    const newWidth = Math.max(220, Math.min(560, startWidth + (e.clientX - startX)));
    state.sidebarWidth = newWidth;
    document.documentElement.style.setProperty("--sidebar-w", newWidth + "px");
  });

  document.addEventListener("mouseup", () => {
    if (dragging) {
      dragging = false;
      resizer.classList.remove("dragging");
      document.body.classList.remove("sidebar-resizing");
      document.body.style.userSelect = "";
    }
  });
}

async function loadConfig() {
  const r = await api("/api/config");
  state.config = await r.json();
  state.lang = state.config.language || "ru";
  document.body.classList.toggle("light", state.config.theme === "light");
}

// старт: скрипты могут прийти и синхронными тегами, и динамическим
// загрузчиком из index.html (тогда парсинг уже окончен) — запускаемся
// ровно один раз в обоих случаях
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// любые необработанные ошибки фронта -> лог бэкенда (диагностика «молчаливых» сбоев)
window.addEventListener("error", e => {
  reportClientError("error", e.message, { src: (e.filename || "") + ":" + (e.lineno || 0) });
});
window.addEventListener("unhandledrejection", e => {
  const r = e.reason;
  reportClientError("unhandled", r && r.message ? r.message : String(r));
});
