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
  // UI state
  sidebarCollapsed: false,
  sidebarWidth: 320,
  treeCollapsed: {},        // "overlay::category" -> true
  treeFilter: "",
  treeSel: new Set(),       // tree multi-selection paths (ctrl+click)
  editedFiles: new Set(),   // project files edited & saved by us (lowercase abs paths)
  fullTree: null,           // {n, d:[], f:[]} full project tree from /api/project_tree
  treeExtFilter: null,      // null = show all; Set of lowercase exts to SHOW
  treeFolderFilter: null,   // null = show all; Set of lowercase folder names to SHOW
  fullTreeExpanded: new Set(),   // absolute dir paths the user forced open
  fullTreeCollapsed: new Set(),  // absolute dir paths the user forced closed
  treeCounts: null,         // {exts: Map, folders: Map} from the full tree
  clipboard: null,          // last copied cell value (context menu paste)
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
const api = (path, opts) =>
  fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts));

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
  const flag = state.lang === "ru" ? "RU" : "EN";
  $("#lang-toggle .lang-flag").textContent = flag;
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
function updateSidebarVisibility() {
  // compare & unpacker pages use the full window width: no project sidebar there
  const onWide = state.activeTabId === "compare" || state.activeTabId === "unpacker";
  const hasProject = !!(state.project && state.project.files && state.project.files.length)
    && !onWide;
  $("#sidebar").hidden = !hasProject;
  $("#sidebar-resizer").hidden = !hasProject || state.sidebarCollapsed;
  $("#tree-toolbar").hidden = !hasProject || state.sidebarCollapsed;
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

function createTabElement(tab) {
  const el = document.createElement("div");
  el.className = "tab" + (tab.id === state.activeTabId ? " active" : "");
  el.dataset.tabId = tab.id;
  el.setAttribute("role", "tab");
  el.setAttribute("aria-selected", tab.id === state.activeTabId);
  const closable = tab.type !== "welcome";
  el.innerHTML = `
    <span class="tab-icon-box">${iconHtml(tab.icon, "📄")}</span>
    <span class="tab-text">
      <span class="tab-title-row">
        <span class="tab-title" title="${escapeHtml(tab.path || tab.title)}">${escapeHtml(tab.title)}</span>
        ${tab.dirty ? `<span class="tab-badge dirty">${escapeHtml(t("unsaved"))}</span>` : ""}
      </span>
      <span class="tab-sub" title="${escapeHtml(tab.sub || "")}">${escapeHtml(tab.sub || "")}</span>
    </span>
    ${closable ? `<button class="tab-close" title="${t("close")}">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>` : ""}
  `;
  el.addEventListener("click", e => {
    if (e.target.closest(".tab-close")) return;
    activateTab(tab.id);
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
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, "\"")
    .replace(/'/g, "'");
}

function renderTabBar() {
  const inner = $("#tab-bar-inner");
  inner.innerHTML = "";
  state.tabs.forEach(tab => {
    if (tab.type === "welcome") return; // landing lives behind the pinned button, not in the bar
    inner.appendChild(createTabElement(tab));
  });
  updateTabBarScroll();
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
const LINK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

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
    state.selectedRow = null;
    state.dirty = tab.dirty || false;
    state.links = tab.links || [];
    $("#file-path").textContent = tab.path;
    updateDirty();
    // while the loading overlay is up the panel must stay untouched:
    // no "no file" placeholder row, no "+" header underneath the spinner
    const lo = $(`#loading-${tab.id}`);
    const loading = lo && !lo.classList.contains("hidden");
    if (!loading) {
      renderGrid();
      loadLinks();
    }
  } else if (tab.type === "welcome" || tab.type === "compare"
      || tab.type === "create-mod" || tab.type === "unpacker") {
    state.currentFile = null;
    state.dirty = false;
    updateDirty();
    // no file open -> no path in the header
    const fp = $("#file-path");
    fp.textContent = "";
    fp.title = "";
  }

  if (!$("#find-bar").hidden) refreshFind();
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

    // Remove tab panel (the compare / create-mod / unpacker panels are static
    // in index.html - keep them so the tabs can be reopened without rebuilding)
    if (tab.type !== "compare" && tab.type !== "create-mod" && tab.type !== "unpacker") {
      const panel = $(`.tab-panel[data-tab-id="${tabId}"]`);
      if (panel) panel.remove();
    }

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
  // Check if file already open
  const existing = state.tabs.find(t => t.type === "file" && t.path === path);
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
    const r = await api("/api/open_file", { method: "POST", body: JSON.stringify({ path }) });
    const j = await r.json();
    if (!j.ok) {
      showTabLoading(tempTab.id, false);
      toast(j.error || "error", "err");
      closeTab(tempTab.id);
      return j;
    }

    // Update tab with real data
    tempTab.fileData = j.file;
    tempTab.title = j.file.path.split(/[\\/]/).pop();
    tempTab.path = j.file.path;
    tempTab.sub = computeOverlaySub(j.file.path);
    tempTab.sheetIndex = j.file.sheet_index || 0;
    tempTab.icon = getFileIcon(j.file.path);
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
    loadLinks();

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
  const p = h.payload || {};
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
  // the backend); the old flat icon folder was replaced by themed sets
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
  const ext = String(path).split(".").pop().toLowerCase();
  return ICON_BASE + (FILE_EXT_ICONS[ext] || "file.svg");
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
  // icons are either asset URLs (file tabs) or legacy emoji
  if (icon && String(icon).startsWith("/")) return `<img src="${icon}" alt="">`;
  return escapeHtml(icon || fallback || "📄");
}

// base folder of the active icon theme
const ICON_BASE = "/assets/icons/dark/icons/";

const OVERLAY_LABEL_KEYS = {
  basis: "overlay_basis",
  dlc_resistance: "overlay_dlc_resistance",
  dlc_legion: "overlay_dlc_legion",
  dlc_evolution: "overlay_dlc_evolution",
  dlc: "overlay_dlc",
};

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
  return (t("overlay_basis") || "Компания") + "\\" + tail;
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
    const r = await api("/api/edited_marks?path=" + encodeURIComponent(root));
    const j = await r.json();
    if (j.ok) state.editedFiles = new Set((j.files || []).map(p => String(p).toLowerCase()));
  } catch (e) { /* marks are optional sugar */ }
}

function noteSaved(path) {
  // instant indicator update without a full tree re-render
  if (!path) return;
  const k = String(path).toLowerCase();
  if (state.editedFiles.has(k)) return;
  state.editedFiles.add(k);
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
const TREE_FILTER_DEFAULTS = { exts: ["xml"], folders: ["scripts"] };
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

async function loadFullTree() {
  state.fullTree = null;
  state.fullTreeExpanded = new Set();
  state.fullTreeCollapsed = new Set();
  state.treeCounts = null;
  try {
    const r = await api("/api/project_tree");
    const j = await r.json();
    if (j.ok) {
      state.fullTree = j.tree;
      computeTreeCounts(j.tree);
      // the filter menu is rebuilt from the scan; saved whitelist entries
      // that don't exist in this project are dropped so opening another
      // project never shows an empty tree
      sanitizeTreeFiltersToProject();
      return;
    }
  } catch (e) { /* fall through to the empty tree */ }
  state.fullTree = { n: "", d: [], f: [] };
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
  if (pair) return ICON_BASE + pair[expanded ? 1 : 0];
  return ICON_BASE + (expanded ? "folder__open.svg" : "folder.svg");
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
  const rootName = projectFolderName(state.project) || "";
  const others = (root._k || []).filter(d => d.n.toLowerCase() !== "dlc");
  const dlc = (root._k || []).find(d => d.n.toLowerCase() === "dlc");
  const sections = [];
  const compCount = others.reduce((n, d) => n + d._count, 0) + (root._fl || []).length;
  if (compCount) {
    const dirs = overlaySubtitleDirs({ _k: others });
    sections.push({
      key: "basis", label: t("overlay_basis") || "Компания",
      path: state.project.root,
      subtitle: rootName + "\\" + (dirs ? "  " + dirs : ""),
      node: { _k: others, _fl: root._fl || [], _en: true, _count: compCount },
    });
  }
  if (dlc) {
    if ((dlc._fl || []).length) {
      sections.push({
        key: "dlc", label: t("overlay_dlc") || "DLC",
        path: state.project.root + "\\dlc",
        subtitle: rootName + "\\DLC",
        node: { _k: [], _fl: dlc._fl, _en: true, _count: dlc._fl.length },
      });
    }
    for (const child of dlc._k || []) {
      const dirs = overlaySubtitleDirs(child);
      sections.push({
        key: "dlc::" + child.n.toLowerCase(), label: overlayLabel(child.n),
        path: state.project.root + "\\dlc\\" + child.n,
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
    if (TREE_EDITABLE_EXTS.has(fileExt(fname))) openFile(path);
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

function renderTree() {
  const tree = $("#project-tree");
  tree.innerHTML = "";
  if (!state.project) return;
  if (!state.fullTree) {
    const msg = document.createElement("div");
    msg.className = "tree-empty";
    msg.textContent = t("loading") || "Загрузка…";
    tree.appendChild(msg);
    return;
  }
  filterFullTree(state.fullTree);
  const sections = buildOverlaySections(state.fullTree);
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
  $$("#project-tree .tree-file").forEach(el => {
    el.classList.toggle("active", el.dataset.path === path);
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
    const r = await api("/api/open_project", { method: "POST", body: JSON.stringify({ path }) });
    const j = await r.json();
    showTabLoading("welcome", false);
    if (!j.ok) { toast(j.error || "error", "err"); return; }
    state.project = j.project;
    state.nameMap = j.project.display_names || {};
    await loadEditedMarks(j.project.root);
    await loadFullTree();
    renderTree();
    // title = name of the selected folder, not a static label
    $("#sidebar-title").textContent = projectFolderName(j.project);
    $("#sidebar-path").textContent = j.project.root;
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

// ---------- links ----------
async function loadLinks(retry = 0) {
  if (!state.currentFile) { state.links = []; return; }
  const p = state.currentFile.path;
  try {
    const r = await api("/api/links?path=" + encodeURIComponent(p));
    const j = await r.json();
    if (j.ok && j.pending) {
      if (retry < 8) { setTimeout(() => loadLinks(retry + 1), 1500); }
      return;
    }
    const had = state.links.length > 0;
    state.links = (j.ok && j.links) || [];
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

async function saveCurrent() {
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

  menu.addEventListener("click", e => {
    const item = e.target.closest(".ctx-item");
    if (!item || item.classList.contains("disabled")) return;
    const act = item.dataset.act;
    menu.hidden = true;
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

// ---------- Find & Replace ----------
let findTimer = null;

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
  const el = $("#find-count");
  const n = state.find.matches.length;
  el.textContent = n ? `${state.find.idx + 1}/${n}` : "0/0";
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
  $("#find-bar").hidden = false;
  $("#find-rep-row").hidden = !showReplace;
  const inp = $("#find-input");
  inp.focus();
  inp.select();
  if (state.find.q) refreshFind();
}

function closeFind() {
  $("#find-bar").hidden = true;
  state.find.active = false;
  state.find.q = "";
  renderGrid();
}

async function replaceCurrent() {
  const f = state.currentFile;
  const m = state.find.matches[state.find.idx];
  if (!f || !m) return;
  const q = state.find.q;
  const repl = $("#replace-input").value;
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
  const repl = $("#replace-input").value;
  if (!q) return;
  computeFindMatches();
  const cells = [...state.find.keySet].map(k => k.split(":").map(Number));
  if (!cells.length) { toast(t("save_success"), "ok"); return; }
  const re = new RegExp(escapeRegExp(q), "gi");
  let changed = 0;
  for (const [ri, ci] of cells) {
    const oldVal = String(f.rows[ri].values[ci] || "");
    const newVal = oldVal.replace(re, repl);
    if (newVal === oldVal) continue;
    const r = await api("/api/edit", { method: "POST",
      body: JSON.stringify({ path: f.path, row: ri, col: ci, value: newVal, save: false }) });
    const j = await r.json();
    if (j.ok) { f.rows[ri].values[ci] = newVal; changed++; }
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

function setupFindBar() {
  $("#find-input").addEventListener("input", e => {
    clearTimeout(findTimer);
    findTimer = setTimeout(() => {
      state.find.q = e.target.value;
      state.find.active = !!state.find.q;
      refreshFind();
    }, 150);
  });
  $("#find-input").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); closeFind(); }
  });
  $("#replace-input").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); replaceCurrent(); }
    else if (e.key === "Escape") { e.preventDefault(); closeFind(); }
  });
  $("#find-prev").onclick = () => findStep(-1);
  $("#find-next").onclick = () => findStep(1);
  $("#find-close").onclick = closeFind;
  $("#find-toggle-rep").onclick = () => {
    const row = $("#find-rep-row");
    row.hidden = !row.hidden;
    if (!row.hidden) $("#replace-input").focus();
  };
  $("#rep-one").onclick = replaceCurrent;
  $("#rep-all").onclick = replaceAll;
}

// ---------- grid font size (Ctrl +/- and settings) ----------
function gridFontScale(dir) {
  const cur = parseInt(localStorage.getItem("gridFont") || "12", 10);
  setGridFont(cur + dir);
}

// ---------- hotkeys ----------
// Keyboard shortcuts match e.code (physical key), NOT e.key: with a Russian
// or any other layout e.key becomes "а"/"с"/... and Ctrl+F would never fire.
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
    const isUndoRedo = ctrl && (c === "KeyZ" || c === "KeyY");
    if (isUndoRedo) {
      if (e.repeat) return;   // holding the key must not mass-undo/redo
      const tgt = e.target;
      const inText = tgt && tgt.closest && tgt.closest("input, textarea, select") &&
        !(tgt.classList && tgt.classList.contains("cell-input"));
      if (inText) return;
      e.preventDefault();
      if (ctrl && e.shiftKey) redoCurrent();          // Ctrl+Shift+Z / Ctrl+Shift+Y
      else if (c === "KeyY") redoCurrent();           // Ctrl+Y
      else undoCurrent();                             // Ctrl+Z
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
    if (ctrl && !e.shiftKey && c === "KeyF") {
      e.preventDefault(); openFind(false);
    } else if (ctrl && c === "KeyH") {
      e.preventDefault(); openFind(true);
    } else if (ctrl && !e.shiftKey && c === "KeyS") {
      e.preventDefault(); saveCurrent();
    } else if (ctrl && e.shiftKey && c === "KeyO") {
      e.preventDefault(); openProjectDialog();
    } else if (ctrl && !e.shiftKey && c === "KeyO") {
      e.preventDefault(); openFileDialog();
    } else if (ctrl && c === "KeyW") {
      e.preventDefault();
      if (state.activeTabId !== "welcome") closeTab(state.activeTabId);
    } else if (ctrl && (c === "Equal" || c === "NumpadAdd")) {
      e.preventDefault(); gridFontScale(1);
    } else if (ctrl && (c === "Minus" || c === "NumpadSubtract")) {
      e.preventDefault(); gridFontScale(-1);
    } else if (ctrl && c === "Digit0") {
      e.preventDefault(); setGridFont(12);
    } else if (c === "F3") {
      e.preventDefault(); findStep(e.shiftKey ? -1 : 1);
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
        else toast(t("up_done") || "Распаковка завершена", "ok");
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
  const choice = await askConfirm({
    title: t("up_run") || "Распаковать",
    message: (t("up_confirm") || "Распаковать архивы в") + " " + dest +
      " (" + total + " " + (t("files_n") || "files") + ")",
    buttons: [
      { id: "ok", label: t("up_run") || "Распаковать" },
      { id: "cancel", label: t("cancel"), kind: "ghost" },
    ],
  });
  if (choice !== "ok") return;
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

// ---------- tooltip ----------
let tipEl = null;
function showTip(e, text) {
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
  tipEl.style.left = x + "px";
  tipEl.style.top = y + "px";
}
function hideTip() { if (tipEl) { tipEl.remove(); tipEl = null; } }

// ---------- settings ----------
// window_size presets: normal (as-is), +20% width, +20% width & height
const WINDOW_SIZES = {
  normal: [1280, 800],
  wide:   [1536, 800],   // +20% width
  big:    [1536, 960],   // +20% width and height
};

function openSettings() {
  $("#set-auto-save").checked = !!state.config.auto_save;
  $("#set-fullscreen").checked = !!state.config.fullscreen;
  $("#set-theme").value = state.config.theme || "dark";
  $("#set-window-size").value = state.config.window_size || "normal";
  const gfSel = $("#set-grid-font");
  gfSel.innerHTML = "";
  for (let v = 9; v <= 20; v++) {
    const o = document.createElement("option");
    o.value = String(v);
    o.textContent = v + " px";
    gfSel.appendChild(o);
  }
  gfSel.value = String(parseInt(localStorage.getItem("gridFont") || "12", 10));
  $("#set-keycol").value = state.config.default_key_column || "sysname";
  $("#settings-modal").hidden = false;
}

async function saveSettings() {
  const body = {
    auto_save: $("#set-auto-save").checked,
    fullscreen: $("#set-fullscreen").checked,
    theme: $("#set-theme").value,
    window_size: $("#set-window-size").value,
    default_key_column: $("#set-keycol").value || "sysname",
  };
  const r = await api("/api/config", { method: "POST", body: JSON.stringify(body) });
  const j = await r.json();
  if (j.ok) {
    Object.assign(state.config, body);
    document.body.classList.toggle("light", state.config.theme === "light");
    // apply the new window size immediately (frameless pywebview window)
    const size = WINDOW_SIZES[body.window_size] || WINDOW_SIZES.normal;
    if (window.pywebview && pywebview.api && pywebview.api.apply_window_size) {
      pywebview.api.apply_window_size(size[0], size[1]).catch(() => {});
    }
    toast(t("save_success"), "ok");
  }
}

function setGridFont(v) {
  const val = Math.max(9, Math.min(20, v));
  localStorage.setItem("gridFont", String(val));
  document.documentElement.style.setProperty("--grid-font", val + "px");
}

async function toggleLang() {
  state.lang = state.lang === "ru" ? "en" : "ru";
  await api("/api/config", { method: "POST", body: JSON.stringify({ language: state.lang }) });
  await loadI18n();
  await renderGrid();
  // dynamic views bake localized strings at render time - rebuild them
  renderTree();
  populateTreeFilterMenu();
  nudgeRepaint();
  // the sidebar title is rendered once - refresh it too
  if (state.project) $("#sidebar-title").textContent = projectFolderName(state.project);
}

// ---------- compare page ----------
function openCompare() {
  if (!state.tabs.some(tb => tb.id === "compare")) {
    createTab("compare");
    renderTabBar();
  }
  activateTab("compare");
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
    const inp = $("#cmp-search-" + side);
    if (inp) inp.value = "";
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
  const sr = $("#cmp-search-row");
  const lt = $("#cmp-table-left"), rt = $("#cmp-table-right");
  // per-side search strips: each side's box lives only while its file is loaded
  const resetSearch = s => {
    state.cmpSearch[s] = "";
    state.cmpVisIdx[s] = null;
    const inp = $("#cmp-search-" + s);
    if (inp) inp.value = "";
  };
  if (!L && !R) {
    // nothing picked on either side: reset to the empty hint
    empty.hidden = false; fl.hidden = true; sr.hidden = true;
    resetSearch("left"); resetSearch("right");
    lt.querySelector("thead").innerHTML = ""; lt.querySelector("tbody").innerHTML = "";
    rt.querySelector("thead").innerHTML = ""; rt.querySelector("tbody").innerHTML = "";
    $("#cmp-merge").disabled = false;
    return;
  }
  empty.hidden = true;
  fl.hidden = true; // filter chips belong to the diff, not to a plain preview
  sr.hidden = false;
  $("#cmp-search-side-left").hidden = !L;
  $("#cmp-search-side-right").hidden = !R;
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

// wire the two independent search boxes (one per compare pane). In preview
// mode each re-renders ONLY its own pane; in the diff the rows are paired,
// so a row stays visible only if it matches every non-empty side's query.
function setupCmpSearch() {
  ["left", "right"].forEach(side => {
    const inp = $("#cmp-search-" + side);
    if (!inp) return;
    const refilter = () => {
      if (state.compare) { renderCompare(); return; } // paired rows: rebuild both
      const d = state.cmpData && state.cmpData[side];
      if (d) cmpFillPreviewPane(side, d); // preview: this side only
    };
    inp.addEventListener("input", () => {
      state.cmpSearch[side] = inp.value;
      refilter();
    });
    inp.addEventListener("keydown", ev => {
      if (ev.key === "Escape" && inp.value) {
        ev.stopPropagation();
        inp.value = "";
        state.cmpSearch[side] = "";
        refilter();
      }
    });
  });
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
  const keySel = $("#cmp-keycol");
  const keyCol = keySel.value === "" || keySel.value == null
    ? -1 : parseInt(keySel.value, 10);
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
    setUndoRedoButtons(!!j.can_undo, !!j.can_redo);
    $("#cmp-merge").disabled = false;
    // key column options: "all keys" first, then columns A -> Z
    keySel.innerHTML = "";
    const allOpt = document.createElement("option");
    allOpt.value = "-1";
    allOpt.textContent = t("cmp_all_keys");
    keySel.appendChild(allOpt);
    (j.left_columns || []).map((n, i) => [n, i])
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: "base" }))
      .forEach(([n, i]) => {
        const o = document.createElement("option");
        o.value = i; o.textContent = n;
        keySel.appendChild(o);
      });
    keySel.value = allMode ? "-1" : String(j.key_col);
    renderCompare();
  } finally {
    $("#cmp-loading-left").classList.add("hidden");
    $("#cmp-loading-right").classList.add("hidden");
  }
}

const CMP_CHUNK = 400; // rows rendered per chunk (virtualization: more on scroll)

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
          ? '<td class="cmp-diff" title="' + esc(name + ": " + ch[1] + "  ->  " + ch[2]) + '">' + esc(v) + "</td>"
          : "<td>" + esc(v) + "</td>";
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
  await runCompare();
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
  await runCompare();
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
  // compare page undoes/redoes the side the user last interacted with
  const tab = state.tabs.find(tb => tb.id === state.activeTabId);
  let path = null, isCompare = false, cmpSide = null;
  if (tab && tab.type === "file") path = tab.path;
  else if (tab && tab.type === "compare") {
    const tgt = cmpUndoTarget();
    if (tgt) { path = tgt.path; cmpSide = tgt.side; isCompare = true; }
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
    else await applyUndoPatch(j.patch);
    setUndoRedoButtons(!!j.can_undo, !!j.can_redo);
    toast(okMsg, "ok");
  } finally {
    state.histBusy = false;
  }
}

async function undoCurrent() {
  await runUndoRedo("/api/undo", t("undo"), t("undo_none"));
}

async function redoCurrent() {
  await runUndoRedo("/api/redo", t("redo"), t("redo_none"));
}

// ---------- history ----------
const HIST_ACTION_KEYS = {
  edit: "hist_edit",
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
  // main grid: one file; compare page: BOTH sides' files merged into one
  // journal, every record tagged with its side ("base" / "source")
  let targets;
  if (state.currentFile && state.currentFile.path) {
    targets = [{ side: null, path: state.currentFile.path }];
  } else {
    const sides = state.cmpLastSide
      ? [state.cmpLastSide, state.cmpLastSide === "left" ? "right" : "left"]
      : ["left", "right"];
    targets = [];
    for (const s of sides) {
      const d = state.cmpData && state.cmpData[s];
      if (d && d.path) targets.push({ side: s, path: d.path });
    }
  }
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
    // as a yellow button that jumps to the changed cell
    const sp = h.action === "edit" ? s.indexOf(" ") : -1;
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
        const rr = await api("/api/restore", { method: "POST",
          body: JSON.stringify({ backup_id: h.id, path: h.__path }) });
        const jj = await rr.json();
        if (!jj.ok) { toast(jj.error || "error", "err"); return; }
        if (state.currentFile) await reloadActiveFile();
        else {
          // compare page: cache the restored side's flags + repaint that side
          const d = h.__side && state.cmpData && state.cmpData[h.__side];
          if (d) d.flags = { can_undo: !!jj.can_undo, can_redo: !!jj.can_redo };
          await cmpReloadSide(h.__side);
          const tgt = cmpUndoTarget();
          const fl = tgt && state.cmpData[tgt.side] && state.cmpData[tgt.side].flags;
          setUndoRedoButtons(!!(fl && fl.can_undo), !!(fl && fl.can_redo));
        }
        toast(t("hist_restored"), "ok");
        openHistory(); // refresh the list in place
      });
    }
    body.appendChild(item);
  });
  $("#history-modal").hidden = false;
}

// ---------- drag & drop ----------
function setupDnD() {
  const dz = $("#dropzone");
  ["dragover", "dragenter"].forEach(evt => dz.addEventListener(evt, e => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach(evt => dz.addEventListener(evt, e => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", e => {
    e.preventDefault();
    // files dragged from the project tree: open each one
    const raw = e.dataTransfer && e.dataTransfer.getData("text/tsh-files");
    if (raw) {
      let data;
      try { data = JSON.parse(raw); } catch (err) { /* fall through */ }
      if (data) {
        if (Array.isArray(data)) data = { files: data };
        const paths = [...(data.files || [])];
        for (const fo of data.folders || []) paths.push(...(fo.paths || []));
        if (paths.length) {
          paths.forEach(p => { if (p && String(p).toLowerCase().endsWith(".xml")) openFile(p); });
          return;
        }
      }
    }
    const items = e.dataTransfer && e.dataTransfer.files;
    if (items && items.length) {
      const path = items[0].path;
      if (!path) return;
      const ext = path.split(".").pop().toLowerCase();
      if (ext === "xml") {
        openFile(path);
      } else {
        // folders and non-xml paths go straight to the project loader
        // (avoids a misleading "not a file" toast before the project opens)
        loadProject(path);
      }
    }
  });
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

// ---------- init ----------
async function init() {
  document.body.classList.add("dark");
  await loadConfig();
  await loadI18n();
  setupDnD();
  setupSidebar();
  setupTabBar();
  setupCmpSearch();

  // Create welcome tab
  createTab("welcome", {});

  $("#btn-project-side").onclick = openProjectDialog;
  $("#tab-open-file").onclick = () => activateTab("welcome");
  $("#landing-open-file").onclick = openFileDialog;
  $("#landing-open-project").onclick = openProjectDialog;
  $("#btn-save").onclick = saveCurrent;
  $("#btn-undo").onclick = undoCurrent;
  $("#btn-redo").onclick = redoCurrent;
  setUndoRedoButtons(false, false);
  $("#btn-compare").onclick = openCompare;
  $("#btn-create-mod").onclick = openCreateMod;
  $("#btn-unpacker").onclick = openUnpacker;
  $("#landing-create-mod").onclick = openCreateMod;
  $("#landing-unpacker").onclick = openUnpacker;
  $("#landing-compare").onclick = openCompare;
  $("#cm-pick-dir").onclick = cmPickDir;
  $("#cm-pick-icon").onclick = cmPickIcon;
  $("#cm-create").onclick = cmCreate;
  $("#cm-copy-files").onclick = cmCopyFiles;
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
  $("#btn-settings").onclick = openSettings;
  $("#btn-history").onclick = openHistory;
  $("#lang-toggle").onclick = toggleLang;
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
  // click the project path in the sidebar header -> show the folder in Explorer
  $("#sidebar-path").addEventListener("click", async () => {
    const p = state.project && state.project.root;
    if (!p) return;
    try { await api("/api/reveal", { method: "POST", body: JSON.stringify({ path: p }) }); }
    catch (e) { /* noop */ }
  });

  // restore grid font size
  const gf = parseInt(localStorage.getItem("gridFont") || "12", 10);
  document.documentElement.style.setProperty("--grid-font", gf + "px");
  // restore the sticky sysname column width (drag-resizable header);
  // the compare panes share the same width but never follow the font size
  const sw = parseInt(localStorage.getItem("stickyW"), 10);
  if (sw && !isNaN(sw)) {
    document.documentElement.style.setProperty("--sticky-w", sw + "px");
    document.documentElement.style.setProperty("--cmp-sticky-w", sw + "px");
  }

  setupWindowControls();
  setupContextMenu();
  setupFindBar();
  setupHotkeys();

  $$("[data-close]").forEach(b => b.onclick = () => {
    const modal = b.closest(".modal"); if (modal) modal.hidden = true;
  });
  // close modal by clicking the backdrop (outside the card)
  $$(".modal").forEach(modal => modal.addEventListener("click", e => {
    if (e.target === modal) modal.hidden = true;
  }));
  // settings save on change
  ["auto-save", "fullscreen", "theme", "keycol", "window-size"].forEach(id => {
    $("#set-" + id).addEventListener("change", saveSettings);
  });
  // grid font size select applies instantly (stored locally, not in config.json)
  $("#set-grid-font").addEventListener("change", e => setGridFont(parseInt(e.target.value, 10)));
  $("#cmp-run").onclick = runCompare;
  $("#cmp-merge").onclick = mergeAll;
  $("#cmp-keycol").onchange = () => { if (state.compare) runCompare(); };
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

  // reopen last project if configured
  const lastProj = state.config.last_project;
  if (lastProj) loadProject(lastProj);
  
  renderTabBar();
  activateTab("welcome");
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
  const doCollapse = () => {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    sidebar.classList.toggle("collapsed", state.sidebarCollapsed);
    updateSidebarVisibility();
  };
  toggle.onclick = e => { e.stopPropagation(); doCollapse(); };
  header.addEventListener("click", () => doCollapse()); // whole header = collapse button
  $("#sidebar-fab").addEventListener("click", () => doCollapse());
  // red X: close the project and clear the tree (does NOT collapse)
  $("#sidebar-close").onclick = async e => {
    e.stopPropagation();
    try {
      await api("/api/close_project", { method: "POST", body: "{}" });
    } catch (err) { /* keep clearing client-side regardless */ }
    state.project = null;
    state.nameMap = {};
    state.editedFiles = new Set();
    state.fullTree = null;
    state.treeCounts = null;
    $("#project-tree").innerHTML = "";
    $("#sidebar-path").textContent = "";
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

document.addEventListener("DOMContentLoaded", init);
