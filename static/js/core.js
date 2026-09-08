/* TerminatorToolSet frontend — core.js: ядро: state/api/i18n/toast/confirm/ctx-меню/утилиты
   Вырезано из app.js без изменений логики. Классические скрипты,
   общий глобальный скоуп, порядок загрузки — FILES в templates/index.html. */
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
  cmpMoved: {},             // key -> "new" | "changed": rows transferred this session
  cmpMovedFor: "",          // fingerprint of the compared pair the marks belong to
  cmpMovedUndone: {},       // marks parked while their transfer is undone (redo returns them)
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
  swt: null, // заполняет init(): фабрика swtFreshState() живёт в swt.js ниже
  swtSources: null,         // словари для подсказок SWT (/api/swt_sources), null = нет
  uprising: null, // заполняет init(): фабрика uprFreshState() живёт в uprising.js ниже
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
  linkMap: null,      // "ri:ci" -> link, пересборка в renderGrid (O(1) на ячейку)
  selTr: null,        // выбранная tr: selectRow трогает максимум две строки
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
  grid: _CTX_SVG('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>'),
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
      // копия могла создать новый раздел древа мода — перечитываем,
      // иначе скопированного файла не видно без переподключения
      await noteExternalTreeChange("mod");
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

async function copyToProject(src) {
  try {
    const r = await api("/api/copy_to_project", { method: "POST",
      body: JSON.stringify({ src,
        game_root: (state.config && state.config.unpacked_path) || "" }) });
    const j = await r.json();
    if (j.ok) {
      // копия могла создать новый раздел древа (напр. dlc/) — перечитываем,
      // иначе скопированного файла не видно без переподключения проекта
      await noteExternalTreeChange("project");
      toast((t("ctx_to_project_done") || "Скопировано в проект") + ": " + j.path, "ok");
      return;
    }
    if (j.error === "no_project_path") {
      toast(t("ctx_no_project_path") || "Укажите путь к проекту в настройках", "err");
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
      { label: t("ctx_to_project") || "Скопировать в проект", icon: "to-mod", fn: () => copyToProject(path) },
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

