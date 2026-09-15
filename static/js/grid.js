/* TerminatorToolSet frontend — grid.js: вкладки, грид, sticky-колонка, guard/сохранение, тулбар, ctx-меню грида
   Вырезано из app.js без изменений логики. Классические скрипты,
   общий глобальный скоуп, порядок загрузки — FILES в templates/index.html. */
// ---------- views / tabs ----------
function toggleSidebar() {
  // единый путь сворачивания: кнопка в шапке дерева, фаб и горячая клавиша
  // (Ctrl+B по умолчанию) - чтобы класс .collapsed не рассинхронился
  state.sidebarCollapsed = !state.sidebarCollapsed;
  $("#sidebar").classList.toggle("collapsed", state.sidebarCollapsed);
  updateSidebarVisibility();
}

function updateSidebarVisibility() {
  // compare & unpacker & uprising & campaign pages: full window width, no sidebar.
  // SWT-страница остаётся с сайдбаром: там нужно дерево с фильтром .swt
  const onWide = state.activeTabId === "compare" || state.activeTabId === "unpacker"
    || state.activeTabId === "uprising" || state.activeTabId === "uprising-rnd"
    || state.activeTabId === "campaign";
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
    // хвост перетаскивания: отпустили после drag — это не клик, молчим
    if (Date.now() - tabDragEndTs < 250) return;
    activateTab(tab.id);
  });
  // перетаскивание вкладок: указательный DnD вместо нативного HTML5
  // (dataTransfer с кастомным MIME в WebView2 ненадёжен, а картинки-иконки
  // внутри вкладки перехватывают нативный drag). Порядок меняется внутри
  // state.tabs вживую, welcome в баре нет и не двигается.
  el.addEventListener("pointerdown", e => tabDragBegin(e, tab.id));
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

// ---------- перетаскивание вкладок мышью (Pointer Events) ----------
// Живой порядок: вкладка следует за курсором, пересборка таб-бара только
// при смене позиции. Тач не трогаем — ему нужен нативный скролл бара.
let tabDrag = null;    // {id, x0, y0, dx, dy, active, ghost, order}
let tabDragEndTs = 0;  // когда кончился drag: клик-хвост гасится в createTabElement

function tabDragBegin(e, id) {
  if (e.button !== 0) return;                       // средняя/правая — не наше
  if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
  if (e.target.closest(".tab-close")) return;       // крестик закрывает, не тянет
  tabDrag = { id, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0,
              active: false, ghost: null,
              order: state.tabs.map(t => t.id) };
  window.addEventListener("pointermove", tabDragMove);
  window.addEventListener("pointerup", tabDragEnd, { once: true });
  window.addEventListener("pointercancel", tabDragAbort, { once: true });
  window.addEventListener("blur", tabDragAbort, { once: true });
}

function tabDragMove(e) {
  if (!tabDrag) return;
  if (!tabDrag.active) {
    if (Math.hypot(e.clientX - tabDrag.x0, e.clientY - tabDrag.y0) < 6) return;
    const src = $(`#tab-bar-inner .tab[data-tab-id="${CSS.escape(tabDrag.id)}"]`);
    if (!src) { tabDragStop(); return; }
    tabDrag.active = true;
    document.body.classList.add("no-select");
    try { getSelection()?.removeAllRanges(); } catch (err) { /* noop */ }
    const r = src.getBoundingClientRect();
    tabDrag.dx = tabDrag.x0 - r.left;
    tabDrag.dy = tabDrag.y0 - r.top;
    src.classList.add("dragging");
    const g = src.cloneNode(true);
    g.classList.add("tab-ghost");
    g.classList.remove("dragging");
    g.style.width = r.width + "px";
    document.body.appendChild(g);
    tabDrag.ghost = g;
    window.addEventListener("keydown", tabDragEsc);
  }
  tabDragPlace(e);
}

function tabDragPlace(e) {
  const g = tabDrag.ghost;
  if (g) {
    g.style.left = (e.clientX - tabDrag.dx) + "px";
    g.style.top = (e.clientY - tabDrag.dy) + "px";
  }
  // край бара — автопрокрутка
  const sc = $("#tab-bar-scroll");
  if (sc) {
    const r = sc.getBoundingClientRect();
    if (e.clientX > r.right - 28) sc.scrollLeft += 14;
    else if (e.clientX < r.left + 28) sc.scrollLeft -= 14;
  }
  // куда встанет: число вкладок, чьи середины левее курсора
  const els = $$("#tab-bar-inner .tab").filter(el => el.dataset.tabId !== tabDrag.id);
  let idx = els.length;
  for (let i = 0; i < els.length; i++) {
    const r = els[i].getBoundingClientRect();
    if (e.clientX < r.left + r.width / 2) { idx = i; break; }
  }
  const cur = state.tabs.findIndex(t => t.id === tabDrag.id);
  if (cur < 0 || cur === idx) return;
  const [mv] = state.tabs.splice(cur, 1);
  state.tabs.splice(idx, 0, mv);
  renderTabBar();
  // пересборка убила исходный узел — вернём ему .dragging
  $(`#tab-bar-inner .tab[data-tab-id="${CSS.escape(tabDrag.id)}"]`)?.classList.add("dragging");
}

function tabDragStop() {
  window.removeEventListener("pointermove", tabDragMove);
  window.removeEventListener("keydown", tabDragEsc);
}

function tabDragEnd() {
  // отпустили: порядок уже живой в state.tabs, просто чистим
  tabDragStop();
  for (const [evt, fn] of [["pointercancel", tabDragAbort], ["blur", tabDragAbort]])
    window.removeEventListener(evt, fn);
  if (!tabDrag) return;
  if (tabDrag.active) {
    tabDragEndTs = Date.now();
    renderTabBar(); // снять .dragging, добить sessionStorage
  }
  tabDrag.ghost?.remove();
  document.body.classList.remove("no-select");
  tabDrag = null;
}

function tabDragAbort() {
  // срыв (Ecs, фокус ушёл, жест отменён): откат к порядку до drag
  tabDragStop();
  for (const [evt, fn] of [["pointerup", tabDragEnd], ["pointercancel", tabDragAbort], ["blur", tabDragAbort]])
    window.removeEventListener(evt, fn);
  if (!tabDrag) return;
  const want = tabDrag.order;
  tabDrag.ghost?.remove();
  document.body.classList.remove("no-select");
  tabDrag = null;
  const same = want.length === state.tabs.length &&
    want.every((id, i) => state.tabs[i] && state.tabs[i].id === id);
  if (!same) {
    const byId = new Map(state.tabs.map(t => [t.id, t]));
    state.tabs = want.map(id => byId.get(id)).filter(Boolean);
    renderTabBar();
  }
}

function tabDragEsc(e) {
  if (e.key === "Escape") tabDragAbort();
}

function renderTabBar() {
  // подписи статичных вкладок (создание мода / распаковка) живут в субтитрах
  // таббара: обновить под текущий словарь (смена языка, первый рендер)
  for (const tb of state.tabs) {
    if (tb.type === "create-mod") tb.sub = t("cm_sub") || "";
    else if (tb.type === "unpacker") tb.sub = t("up_sub") || "";
  }
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
  // все markDirty/markClean идут через таб-бар: заодно обновить зелёные
  // метки несохранённых правок на узлах древа (таблица/карта/кампания/SWT)
  if (typeof paintTreeDirty === "function") paintTreeDirty();
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

async function activateTab(tabId) {
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
    state.dirty = tab.dirty || false;    // Ссылки хранятся на вкладке: повторный клик по вкладке НЕ дёргает
    // /api/links и не перерисовывает иконки связей (это и было подлагивание).
    state.links = tab.links != null ? tab.links : [];
    $("#file-path").textContent = tab.path;
    updateDirty();
    paintSyncBoxes();
    // while the loading overlay is up the panel must stay untouched:
    // no "no file" placeholder row, no "+" header underneath the spinner
    const lo = $(`#loading-${tab.id}`);
    const loading = lo && !lo.classList.contains("hidden");
    if (!loading) {
      // Сетка перерисовывается если вкладка ещё не отрисована, осознанно
      // сброшена — или протухла, пока были в другом месте (staleGrid:
      // карта/сравнение правили файл мимо грида). Возврат на свежую
      // вкладку по-прежнему сохраняет скролл и выделение.
      if (!tab.rendered || tab.staleGrid) {
        if (tab.staleGrid === "reload") {
          // структурные правки извне: перечитать сессию, затем рисовать
          if (!(await refreshFileTabFromServer(tab))) renderGrid();
        } else {
          if (!tab.rendered) state.selectedRow = null;
          renderGrid();
        }
        tab.rendered = true;
        tab.staleGrid = false;
      }
      if (!tab.linksLoaded) loadLinks();
    }
  } else if (tab.type === "welcome" || tab.type === "compare"
      || tab.type === "create-mod" || tab.type === "unpacker" || tab.type === "swt"
      || tab.type === "uprising" || tab.type === "uprising-rnd"
      || tab.type === "campaign" || tab.type === "units") {
    state.currentFile = null;
    state.dirty = false;
    updateDirty();
    paintSyncBoxes();
    // SWT живёт на локальном стеке undo (не серверном): кнопки — по нему
    if (tab.type === "swt") swtSyncUndoButtons();
    // no file open -> no path in the header
    const fp = $("#file-path");
    fp.textContent = "";
    fp.title = "";
  }

  if (fileFind && fileFind.isOpen()) refreshFind();
  // закрытый поиск тоже пересчитываем под новый файл, иначе в нём горели
  // бы чужие совпадения (запрос и подсветка переживают закрытие)
  else computeFindMatches();
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
      syncLegion: false, syncResistance: false, // галочки «⇄ DLC Legion»/«⇄ DLC Resistance»
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
      sub: t("cm_sub") || "",
      icon: "/assets/icons/dark/icons/xml.svg"
    };
  } else if (type === "unpacker") {
    tab = {
      id: "unpacker",
      type: "unpacker",
      title: t("up_title") || "Распаковщик архивов",
      sub: t("up_sub") || "",
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
  } else if (type === "campaign") {
    tab = {
      id: "campaign",
      type: "campaign",
      title: t("cpg_title") || "Редактор Компании",
      sub: "shop_presets",
      icon: "/assets/icons/dark/icons/xml.svg"
    };
  } else if (type === "uprising-rnd") {
    tab = {
      id: "uprising-rnd",
      type: "uprising-rnd",
      title: t("upr_rnd_title") || "Рандомайзер",
      sub: "modes",
      icon: "/assets/icons/dark/icons/xml.svg"
    };
  } else if (type === "units") {
    tab = {
      id: "units",
      type: "units",
      title: t("unt_title") || "Редактор юнитов",
      sub: "",
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
        && tab.type !== "unpacker" && tab.type !== "swt" && tab.type !== "uprising"
        && tab.type !== "uprising-rnd" && tab.type !== "campaign") {
      const panel = $(`.tab-panel[data-tab-id="${tabId}"]`);
      if (panel) panel.remove();
    }
    if (tab.type === "swt") state.swt = swtFreshState();
    if (tab.type === "uprising") state.uprising = uprFreshState();
    if (tab.type === "campaign") state.campaign = cmpFreshState();

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
        // saveActive, а не saveCurrent: у карты/SWT нет currentFile —
        // прямое сохранение молча ничего не писало
        if (state.activeTabId === tabId) await saveActive();
        else {
          const sr = await api("/api/save", { method: "POST",
            body: JSON.stringify({ path: tab.path, ...syncFlagsFor(tab) }) });
          const sj = await sr.json();
          if (sj.saved) noteSaved(tab.path);
          markSyncTabsSaved(sj.sync_saved);
          if (sj.ok) toastSaveWithSync(sj);
          else toast((sj.error || t("save_failed")), "err");
        }
      } else if (choice === "discard") {
        // «без сохранения» — откатить по-настоящему: сбросить сессию
        // к диску, иначе правки переживут закрытие
        await discardTabBackend(tab);
        if (tab.type === "compare") {
          // сессии сброшены — вид тоже: stale-превью/диф больше невалидны
          if (state.cmpData) { state.cmpData.left = null; state.cmpData.right = null; }
          cancelCompare();
        }
      }
      doClose();
    });
    return;
  }

  doClose();
}

// Пути бэкенд-сессий, задетые вкладкой (файл/карта; у SWT свой локальный
// doc — серверную сессию он не трогает, сброс не нужен)
function tabSessionPaths(tab) {
  const out = [];
  if (!tab) return out;
  if (tab.type === "file" && tab.path) out.push(tab.path);
  else if (tab.type === "uprising" && state.uprising && state.uprising.path) out.push(state.uprising.path);
  else if (tab.type === "campaign" && state.campaign && state.campaign.path) out.push(state.campaign.path);
  else if (tab.type === "compare") {
    // стороны сравнения правят сессии файлов напрямую: «закрыть без
    // сохранения» обязано откатить их тоже, иначе правки переживут закрытие
    if (state.compare && !state.compare.preview) out.push(state.compare.left, state.compare.right);
    if (state.cmpData) {
      if (state.cmpData.left && state.cmpData.left.path) out.push(state.cmpData.left.path);
      if (state.cmpData.right && state.cmpData.right.path) out.push(state.cmpData.right.path);
    }
  }
  return out;
}

// Путь используется где-то ещё (другая вкладка/сторона сравнения)?
function pathInUseElsewhere(path, excludeId) {
  const np = normPath(path || "");
  if (!np) return false;
  for (const tb of state.tabs) {
    if (tb.id === excludeId) continue;
    if (tb.type === "file" && normPath(tb.path || "") === np) return true;
    if (tb.id === "uprising" && state.uprising && normPath(state.uprising.path || "") === np) return true;
    if (tb.id === "campaign" && state.campaign && normPath(state.campaign.path || "") === np) return true;
    if (tb.type === "compare") {
      const sides = [];
      if (state.compare && !state.compare.preview) sides.push(state.compare.left, state.compare.right);
      if (state.cmpData) {
        if (state.cmpData.left) sides.push(state.cmpData.left.path);
        if (state.cmpData.right) sides.push(state.cmpData.right.path);
      }
      if (sides.some(p => normPath(p || "") === np)) return true;
    }
  }
  return false;
}

// «Закрыть без сохранения» — честный откат: сбросить серверную сессию к
// диску и вычистить журнал, иначе правки переживают закрытие (видны при
// повторном открытии и пишутся следующим сейвом). Если тот же файл открыт
// ещё где-то — сессия чужая, не трогаем (там правки ещё на виду и грязные).
async function discardTabBackend(tab) {
  for (const p of tabSessionPaths(tab)) {
    if (pathInUseElsewhere(p, tab.id)) continue;
    try {
      await api("/api/open_file", { method: "POST",
        body: JSON.stringify({ path: p, reset: true }) });
    } catch (e) { /* закрываемся в любом случае */ }
    try {
      await api("/api/clear_history", { method: "POST",
        body: JSON.stringify({ path: p }) });
    } catch (e) { /* журнал — второстепенно */ }
  }
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

// связь ячейки за O(1): линейный поиск по массиву на каждую ячейку
// (десятки тысяч вызовов на чанк) — главная цена рендера больших таблиц.
// Карта пересобирается в renderGrid; фолбэк — старый поиск.
function linkAt(ri, ci) {
  const m = state.linkMap;
  if (m) return m.get(ri + ":" + ci) || null;
  const arr = state.links || [];
  return arr.find(l => l.row === ri && l.col === ci) || null;
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
  const link = linkAt(ri, ci);
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

// Строка таблицы одной HTML-строкой: парсер браузера строит тысячи ячеек
// на порядок быстрее поочерёдных createElement/appendChild. Структура
// один в один как у renderCellContent (тот остался для точечных перерисовок
// одной ячейки после правки/undo). Обработчики не вешаются на ячейки —
// один делегированный набор на tbody (см. setupGridEvents).
function gridCellHtml(row, ri, ci) {
  const rawVal = row.values[ci];
  const s = rawVal == null ? "" : String(rawVal);
  let cls = ci === 0 ? "sticky-col " : "";
  let inner = escapeHtml(s);
  let title = "";
  if (ci === 0 && s) {
    const disp = state.nameMap[String(s).trim()];
    if (disp && disp !== s) {
      title = ` title="${escapeHtml(disp + " (" + s + ")")}"`;
      inner += `<div class="cell-sub">${escapeHtml(disp)}</div>`;
    }
  }
  const link = linkAt(ri, ci);
  if (link) {
    cls += "has-link";
    const tname = String(link.target_file || "").split(/[\\/]/).pop();
    inner += `<button type="button" class="link-btn" title="${escapeHtml((t("link_hint") || "") + (tname ? " → " + tname : ""))}">${LINK_SVG}</button>`;
  }
  if (state.find.active && state.find.keySet.has(ri + ":" + ci)) cls += "find-hit";
  return `<td class="${cls}" data-row="${ri}" data-col="${ci}"${title}>${inner}</td>`;
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

function setupGridEvents(table) {
  if (!table || table.dataset.gridEventsBound) return;
  table.dataset.gridEventsBound = "1";
  const tbody = table.querySelector("tbody");
  tbody.addEventListener("mousedown", ev => {
    if (ev.target.closest(".link-btn")) return;
    const td = ev.target.closest("td");
    if (!td || td.dataset.row === undefined) return;
    const ri = Number(td.dataset.row), ci = Number(td.dataset.col);
    clearColSelection();
    // второй клик по уже сфокусированной ячейке сразу входит в правку
    if (state.selCell && state.selCell.r === ri && state.selCell.c === ci) {
      beginEdit(td.parentNode, ri, ci);
      return;
    }
    clearCellFocus();
    state.selCell = { r: ri, c: ci };
    td.classList.add("cell-focus");
    selectRow(ri);
  });
  tbody.addEventListener("dblclick", e => {
    if (e.target.closest(".link-btn")) return;
    const td = e.target.closest("td");
    if (!td || td.dataset.row === undefined) return;
    beginEdit(td.parentNode, Number(td.dataset.row), Number(td.dataset.col));
  });
  tbody.addEventListener("click", ev => {
    const lb = ev.target.closest(".link-btn");
    if (!lb) return;
    ev.stopPropagation();
    const td = lb.closest("td");
    if (!td) return;
    const link = linkAt(Number(td.dataset.row), Number(td.dataset.col));
    if (link) followLink(link);
  });
}

function appendGridRows(table, from, to) {
  const tbody = table.querySelector("tbody");
  let html = "";
  for (let k = from; k < to && k < state.visRows.length; k++) {
    const { row, ri } = state.visRows[k];
    html += `<tr data-row-index="${ri}"${state.selectedRow === ri ? ' class="sel"' : ""}>`;
    for (let ci = 0; ci < row.values.length; ci++) html += gridCellHtml(row, ri, ci);
    html += "</tr>";
  }
  tbody.insertAdjacentHTML("beforeend", html);
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
  paintSyncBoxes();
  const table = getActiveGridTable();
  if (!table) return;
  state.selCell = null;   // grid is rebuilt; cell focus restarts on click
  state.selTr = null;     // выбранная строка тоже: старые tr уже в мусоре
  // карта связей под текущий файл: O(1) на ячейку вместо поиска по массиву
  state.linkMap = new Map((state.links || []).map(l => [(l.row + ":" + l.col), l]));
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
    // поиск бьёт и по ключам колонок: совпавший заголовок подсвечиваем,
    // как ячейки (find-hit), текущее совпадение докрасит paintCurrentMatch
    if (state.find.active && state.find.keySet.has("h:" + ci)) th.classList.add("find-hit");
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
  setupGridEvents(table);

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
  // один клик раньше перебирал все строки таблицы; держим выбранную —
  // трогаем максимум две
  const prev = state.selTr;
  if (prev && prev.isConnected) {
    if (Number(prev.dataset.rowIndex) === ri) return;
    prev.classList.remove("sel");
  }
  const table = getActiveGridTable();
  const tr = table && table.querySelector(`tbody tr[data-row-index="${ri}"]`);
  if (tr) tr.classList.add("sel");
  state.selTr = tr || null;
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
  let tr = table.querySelector(`tbody tr[data-row-index="${ri}"]`);
  if (!tr && state.visRows.length) {
    const k = state.visRows.findIndex(v => v.ri === ri);
    if (k >= state.gridRenderLimit) {
      const to = Math.min(k + 1, state.visRows.length);
      appendGridRows(table, state.gridRenderLimit, to);
      state.gridRenderLimit = to;
      tr = table.querySelector(`tbody tr[data-row-index="${ri}"]`);
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
  // horizontal: навигация (поиск/история/ссылки) ставит ячейку к левому
  // краю — сразу за липкую колонку sysname, чтобы контент был виден
  // целиком, а не обрезан у правого края кадра (минимального скролла мало:
  // широкое поле остаётся наполовину скрытым и приходится докручивать).
  if (!td.classList.contains("sticky-col")) {
    const stickyTh = wrap.querySelector(".grid thead th.sticky-col");
    const stickyW = stickyTh ? stickyTh.offsetWidth : 0;
    if (cr.left < wr.left + stickyW || cr.right > wr.right) {
      wrap.scrollLeft += (cr.left - (wr.left + stickyW));
    }
  }
}

// Поиск доводит ячейку в центр кадра по вертикали: минимальный скролл
// ensureCellVisible оставлял совпадение на самом краю/под шапкой
// («недоскролл» — результат не видно). Горизонталь не трогаем — её уже
// выставил ensureCellVisible (к левому краю за липкой колонкой)
function centerCellVert(td) {
  const wrap = td.closest(".grid-scroll");
  if (!wrap) return;
  const wr = wrap.getBoundingClientRect();
  const cr = td.getBoundingClientRect();
  const thead = wrap.querySelector(".grid thead");
  const headH = thead ? thead.offsetHeight : 0;
  const viewH = wr.bottom - (wr.top + headH);
  const target = wr.top + headH + (viewH - cr.height) / 2;
  wrap.scrollTop += (cr.top - target);
}

// Текст, выделенный пользователем мышью внутри ячейки таблицы:
// Ctrl+C / пункт «Копировать» должны отдать его, а не всё поле целиком.
// Возвращает "" когда выделения нет или оно вне таблиц (.grid/.cmp-grid).
function gridTextSelection() {
  try {
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed) return "";
    const s = String((sel.toString && sel.toString()) || "");
    if (!s) return "";
    const node = sel.anchorNode;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (el && el.closest && el.closest(".grid, .cmp-grid")) return s;
  } catch (e) { /* noop */ }
  return "";
}

// ---------- unit_set / unit_class: классы техники в cars.xml / tanks.xml ----------
// Известные игре значения (проверено по basis+dlc распакованной игры и мода).
// Свой стильный попап вместо нативного datalist: datalist в Chrome фильтрует
// пункты по текущему значению поля и показывает только уже выбранное.
// Ввод при этом свободный: input остаётся текстовым.
const UNIT_SET_OPTIONS = ["armored_transport", "artillery", "combat_vehicle",
  "light_vehicle", "supply", "tank"];
// Соседняя колонка unit_class — свой набор (тоже проверен по basis+dlc и моду).
const UNIT_CLASS_OPTIONS = ["aircraft", "heavy_vehicle", "light_vehicle",
  "medium_vehicle", "tank"];
function isSpeciesCarTank(path) {
  const p = String(path || "");
  return /species[\\/]cars\.xml$/i.test(p) || /species[\\/]tanks\.xml$/i.test(p);
}
function isUnitSetCell(path, columns, ci) {
  if (ci == null || ci < 0 || !columns ||
      String(columns[ci] || "") !== "unit_set") return false;
  return isSpeciesCarTank(path);
}
// Соседняя колонка unit_class — та же логика комбобокса, свой набор классов.
function isUnitClassCell(path, columns, ci) {
  if (ci == null || ci < 0 || !columns ||
      String(columns[ci] || "") !== "unit_class") return false;
  return isSpeciesCarTank(path);
}
// Все известные + встреченные в текущем файле (мод может ввести свой класс).
function unitSetChoices(extraVals) {
  const seen = new Set(UNIT_SET_OPTIONS);
  try {
    (extraVals || []).forEach(v => {
      v = String(v ?? "").trim();
      if (v) seen.add(v);
    });
  } catch (e) { /* noop */ }
  return [...seen].sort();
}
// То же для unit_class: известные + встреченные в файле.
function unitClassChoices(extraVals) {
  const seen = new Set(UNIT_CLASS_OPTIONS);
  try {
    (extraVals || []).forEach(v => {
      v = String(v ?? "").trim();
      if (v) seen.add(v);
    });
  } catch (e) { /* noop */ }
  return [...seen].sort();
}
// Один выбор для всех трёх редакторов (основная сетка, превью и диф сравнения):
// какая колонка — такой набор. Возвращает {choices, title} либо null.
function unitComboFor(path, columns, ci, extraVals) {
  try {
    if (typeof isUnitSetCell === "function" &&
        isUnitSetCell(path, columns, ci))
      return { choices: unitSetChoices(extraVals), title: "unit_set" };
    if (typeof isUnitClassCell === "function" &&
        isUnitClassCell(path, columns, ci))
      return { choices: unitClassChoices(extraVals), title: "unit_class" };
  } catch (e) { /* noop */ }
  return null;
}
// Фрагмент, выделенный в ячейке на момент ОТКРЫТИЯ контекстного меню.
// Левый клик по пункту меню схлопывает живое выделение раньше click-хендлера,
// поэтому живое gridTextSelection() в меню уже пусто — берём запомненное.
// Перезаписывается при каждом открытии меню, stale не живёт.
let gridCtxSelText = "";
// Живое выделение прямо сейчас либо запомненное при открытии меню.
function gridCopyFragment() {
  try {
    const live = (typeof gridTextSelection === "function") ? gridTextSelection() : "";
    if (live) return live;
  } catch (e) { /* noop */ }
  return gridCtxSelText || "";
}
// Один глобальный хук: клик/скролл мимо открытого попапа закрывает его.
// Попап живёт в body (position:fixed): пересборка ячейки при commit его
// не убивает, overflow таблицы его не режет.
let unitComboHooked = false;
function ensureUnitComboHook() {
  if (unitComboHooked) return; unitComboHooked = true;
  const closeAll = () => {
    try { (window.$$ ? $$(".unit-combo-pop") : []).forEach(p => p.remove()); }
    catch (e2) { /* noop */ }
  };
  document.addEventListener("mousedown", e => {
    try {
      if (e.target && e.target.closest &&
          e.target.closest(".unit-combo, .unit-combo-pop")) return;
      closeAll();
    } catch (e2) { /* noop */ }
  });
  // скролл/ресайз — попап привязан к координатам, при сдвиге закрываем
  document.addEventListener("scroll", closeAll, true);
  window.addEventListener("resize", closeAll);
}
// Комбобокс в ячейке: input (свободный ввод) + кнопка ▾ + стильный попап.
// Кнопка всегда показывает ВСЕ классы; печать фильтрует; выбор подставляет
// значение и оставляет правку открытой (коммит — Enter/клик мимо, как обычно).
// title — подпись кнопки (unit_set / unit_class).
function makeUnitSetCombo(td, input, choices, title) {
  try {
    ensureUnitComboHook();
    const box = document.createElement("div");
    box.className = "unit-combo";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "unit-combo-btn";
    btn.tabIndex = -1;
    btn.title = title || "unit_set";
    btn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    let pop = null;
    const closePop = () => { if (pop) { try { pop.remove(); } catch (e) {} pop = null; } };
    const placePop = () => {
      if (!pop) return;
      if (!input.isConnected) { closePop(); return; }
      const r = input.getBoundingClientRect();
      pop.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 190)) + "px";
      pop.style.top = (r.bottom + 3) + "px";
      pop.style.minWidth = Math.max(r.width + 22, 150) + "px";
    };
    const paint = filter => {
      pop.textContent = "";
      const q = String(filter ?? "").trim().toLowerCase();
      (choices || []).forEach(v => {
        if (q && String(v).toLowerCase().indexOf(q) < 0) return;
        const o = document.createElement("div");
        o.className = "unit-combo-opt" + (String(v) === String(input.value) ? " cur" : "");
        o.textContent = v;
        // mousedown гасим, чтобы клик не уводил фокус/blur (иначе правка
        // закоммитится раньше выбора)
        o.addEventListener("mousedown", e => e.preventDefault());
        o.addEventListener("click", () => {
          input.value = v;
          closePop();
          try { input.focus(); } catch (e2) { /* noop */ }
        });
        pop.appendChild(o);
      });
      if (!pop.children.length) {
        const em = document.createElement("div");
        em.className = "unit-combo-empty";
        em.textContent = "—";
        pop.appendChild(em);
      }
    };
    const openPop = all => {
      closePop();
      pop = document.createElement("div");
      pop.className = "unit-combo-pop";
      paint(all ? "" : input.value);
      document.body.appendChild(pop);
      placePop();
    };
    // Кнопка: показать всё (фильтр сбросить), повторный клик — закрыть.
    btn.addEventListener("mousedown", e => e.preventDefault());
    btn.addEventListener("click", () => {
      if (pop) closePop();
      else {
        openPop(true);
        try { input.focus({ preventScroll: true }); } catch (e) { /* noop */ }
      }
    });
    // Печать: фильтровать и показывать.
    input.addEventListener("input", () => openPop(false));
    input.addEventListener("keydown", e => {
      if (e.key === "Escape" && pop) {
        // первый Esc закрывает меню, а не отменяет правку
        e.stopImmediatePropagation();
        closePop();
      } else if (e.key === "ArrowDown" && !pop) {
        e.preventDefault();
        openPop(true);
      }
      // Enter с открытым меню: просто закрыть, дальше штатный commit редактора.
      else if (e.key === "Enter" && pop) closePop();
    });
    // Правка закрылась (blur→commit пересобрал ячейку) — попапу не висеть.
    // Задержка: клик по пункту (mousedown уже погашен) должен успеть раньше.
    input.addEventListener("blur", () => setTimeout(closePop, 250));
    td.textContent = "";
    box.appendChild(input);
    box.appendChild(btn);
    td.appendChild(box);
  } catch (e) { /* noop: правка остаётся обычным input */ }
}

// Фокус редактора ячейки без самопроизвольного скролла: нативный focus()
// докручивает контейнер сам и не знает про липкую колонку sysname —
// редактируемая ячейка уезжает влево под неё. Фокусим без скролла, доводим
// контейнер вручную с учётом ширины sticky и только потом выделяем текст.
function focusCellInput(input, td) {
  try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
  if (td) ensureEditCellVisible(td);
  try { input.select(); } catch (e) { /* noop */ }
}

// Как ensureCellVisible, но для старта правки: контейнер вправо НЕ двигаем
// никогда — ячейку уже видно (по ней кликнули или она подсвечена), а правый
// автоскролл только дезориентирует и заставляет крутить обратно влево.
// Два исключения: ячейка уехала влево под липкую колонку (выводим из-под
// неё) и ячейки вообще нет в кадре (правка с клавиатуры) — её показываем.
function ensureEditCellVisible(td) {
  const wrap = td.closest(".grid-scroll, .cmp-pane");
  if (!wrap) return;
  if (td.classList.contains("sticky-col")) return;   // липкая видна всегда
  const wr = wrap.getBoundingClientRect();
  const cr = td.getBoundingClientRect();
  const table = td.closest("table");
  const stickyTh = table && table.querySelector("thead th.sticky-col");
  const stickyW = stickyTh ? stickyTh.offsetWidth : 0;
  if (cr.left < wr.left + stickyW) {
    wrap.scrollLeft -= (wr.left + stickyW - cr.left);
  } else if (cr.left >= wr.right) {
    wrap.scrollLeft += (cr.right - wr.right);
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
  "squads": "command.svg",
  "squad_upgrades": "renovate.svg",
  "cars": "cargo.svg",
  "car_upgrades": "renovate.svg",
  "tanks": "sentry.svg",
  "tank_upgrades": "renovate.svg",
  "helicopters": "velocity.svg",
  "heli_upgrades": "renovate.svg",
  "guns": "dart.svg",
  "modules": "lib.svg",
  "animations": "lottie.svg",
  "inventory": "package_json.svg",
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
    "folder_home.svg", "folder_packages.svg", "folder_packages__open.svg",
    "diff.svg", "xml.svg", "zip.svg"]);
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
// or "resistance\scripts\species". Внешний файл вне проекта/мода/игры
// (origin null — брошен с диска) НЕ получает префикс «Base game»:
// он не из игры, подпись — честный хвост его папки (напр. «D:»).
function computeOverlaySub(path) {
  const norm = path.replace(/\//g, "\\").toLowerCase();
  const dirs = path.split(/[\\/]/).slice(0, -1);
  const tail = dirs.slice(-2).join("\\");
  if (norm.includes("\\dlc\\resistance\\")) return "resistance\\" + tail;
  if (norm.includes("\\dlc\\legion\\")) return "legion\\" + tail;
  if (norm.includes("\\dlc\\evolution\\")) return "evolution\\" + tail;
  if (norm.includes("\\dlc\\")) return "dlc\\" + tail;
  if (!fileOrigin(path)) return tail || path.split(/[\\/]/).pop();
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
  // метки грузятся ВСЕ (без фильтра по корню): древо показывает текущий
  // источник (проект/игра/мод), а правили могли в любом — фильтр по одному
  // корню прятал зелёные точки после рестарта. Бэкенд без path отдаёт всё.
  state.editedFiles = new Set();
  try {
    const url = root ? "/api/edited_marks?path=" + encodeURIComponent(root)
      : "/api/edited_marks";
    const r = await api(url, { timeout: API_TIMEOUT_OPEN });
    const j = await r.json();
    if (j.ok) state.editedFiles = new Set((j.files || []).map(p => String(p).toLowerCase()));
  } catch (e) { /* marks are optional sugar */ }
  // дерево могли отрисовать до ответа: докрасить метки без ререндера
  try {
    $$("#project-tree .tree-file").forEach(row => {
      const p = row.dataset.path || "";
      if (state.editedFiles.has(String(p).toLowerCase())) {
        row.classList.add("edited");
        row.title = (t("edited_hint") || "Файл редактировался в Terminator Sheet") + "\n" + p;
      }
    });
    if (typeof paintTreeDirty === "function") paintTreeDirty();
  } catch (e2) { /* noop */ }
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

// ---------- синхронизация открытых таблиц с внешними правками ----------
// Карта/сравнение пишут в сессию файла напрямую, мимо грида: открытые
// таблицы того же файла подменяют значения в памяти и помечаются stale,
// а перерисовываются при возврате на вкладку (activateTab). Иначе таблица
// показывала бы старое до переоткрытия, хотя дискета уже красная.
function syncFileTabsCells(path, cells, sheetIndex) {
  const np = normPath(path || "");
  if (!np || !cells || !cells.length) return false;
  let any = false, active = false;
  state.tabs.forEach(tb => {
    if (tb.type !== "file" || !tb.fileData || !tb.fileData.rows) return;
    if (normPath(tb.path || "") !== np) return;
    if (sheetIndex != null && (tb.sheetIndex || 0) !== sheetIndex) return;
    cells.forEach(c => {
      const row = tb.fileData.rows[c.row];
      if (row && row.values && c.col < row.values.length) {
        row.values[c.col] = c.value;
        if (c.col === 0) row.key = c.value;
      }
    });
    if (!tb.dirty) tb.dirty = true;
    if (tb.id === state.activeTabId) active = true;
    else tb.staleGrid = true;
    any = true;
  });
  if (!any) return false;
  renderTabBar();
  if (active && state.currentFile && state.currentFile.rows) renderGrid();
  return true;
}

// Структурная правка извне (строки/колонки из сравнения, слияние):
// точечно значения не подменить — вкладка перечитает сессию с сервера
// при возврате (staleGrid "reload").
function markFileTabsStale(path, sheetIndex) {
  const np = normPath(path || "");
  if (!np) return false;
  let any = false, active = false;
  state.tabs.forEach(tb => {
    if (tb.type !== "file" || !tb.fileData) return;
    if (normPath(tb.path || "") !== np) return;
    if (sheetIndex != null && (tb.sheetIndex || 0) !== sheetIndex) return;
    if (!tb.dirty) tb.dirty = true;
    if (tb.id === state.activeTabId) active = true;
    else if (!tb.staleGrid) tb.staleGrid = "reload";
    any = true;
  });
  if (!any) return false;
  renderTabBar();
  if (active) {
    const tab = state.tabs.find(tb => tb.id === state.activeTabId);
    refreshFileTabFromServer(tab);
  }
  return true;
}

// Перечитать файловую вкладку из серверной сессии и перерисовать
// (структурные правки извне, откат к диску). Молча: тосты — у вызывающего.
async function refreshFileTabFromServer(tab, opts) {
  opts = opts || {};
  if (!tab || tab.type !== "file" || !tab.path) return false;
  try {
    const r = await api("/api/file?path=" + encodeURIComponent(tab.path));
    const f = await r.json();
    if (!f || !f.ok) return false;
    tab.fileData = {
      path: tab.path,
      sheet_index: f.sheet_index, sheet_name: f.sheet_name,
      sheets: f.sheets, columns: f.columns, comments: f.comments,
      rows: f.rows, expanded_cols: f.expanded_cols,
      recovered: !!f.recovered,
    };
    tab.sheetIndex = f.sheet_index || 0;
    if (opts.clean) {
      tab.dirty = false;
      tab.staleGrid = false;
    }
    if (tab.id === state.activeTabId) {
      state.currentFile = tab.fileData;
      if (opts.clean) { state.dirty = false; updateDirty(); }
      tab.linksLoaded = false;
      renderGrid();
      loadLinks();
    }
    return true;
  } catch (e) { return false; }
}

// ---------- синхронизация basis -> DLC внутри своего корня ----------
// Две галочки на вкладке обычной таблицы («⇄ DLC Legion», «⇄ DLC Resistance»)
// зеркалят правку basis-файла в одноимённые species-файлы DLC-оверлеев ТОГО
// ЖЕ корня, где лежит открытый файл (проект — в проект, мод — в мод).
// Через корни (проект↔мод, игра→мод) зеркала нет; направление только вниз:
// правка DLC-файла никуда не зеркалится, для файлов вне проекта/мода
// галочки скрыты. Живут на вкладке до её закрытия, по умолчанию выключены.
// Каждая синхронизация пишет СВОЮ запись истории в каждом файле — откат
// отдельно по файлам.
const SYNC_SCOPES = ["legion", "resistance"];
let syncInfoCache = {}; // normPath -> /api/sync_info ответ
function syncScopeTitle(sc) {
  return t("sync_" + sc) || ("⇄ DLC " + sc);
}
function syncTabFlag(sc) {
  return "sync" + sc[0].toUpperCase() + sc.slice(1);
}
function syncActiveTab() {
  const tb = state.tabs.find(t => t.id === state.activeTabId);
  return (tb && tb.type === "file" && tb.path) ? tb : null;
}
function syncInfoFor(tb) {
  if (!tb) return null;
  return syncInfoCache[normPath(tb.path || "")] || null;
}
async function syncInfoLoad(path) {  const key = normPath(path || "");
  if (!key || syncInfoCache[key]) return syncInfoCache[key] || null;
  try {
    const r = await api("/api/sync_info", { method: "POST",
      body: JSON.stringify({ path }) });
    const j = await r.json();
    if (j && j.ok) syncInfoCache[key] = j;
  } catch (e) { /* без синхронизации, как раньше */ }
  return syncInfoCache[key] || null;
}
// корни разделов сменились (настройки путей, проект, закрытие источника):
// принадлежность файлов пересчитать
function syncInfoReset() {
  syncInfoCache = {};
  try { paintSyncBoxes(); } catch (e) { /* разметка ещё не готова */ }
}
function syncScopesOn() {
  return syncScopesFor(syncActiveTab());
}
// флаги галок произвольной вкладки (не только активной): сохранение при
// закрытии неактивной идёт мимо syncActiveTab — зеркало терялось
function syncScopesFor(tb) {
  const info = syncInfoFor(tb);
  if (!tb || !info || !info.scopes) return [];
  return SYNC_SCOPES.filter(sc => {
    const st = info.scopes[sc];
    // зеркало только вниз из basis своего корня: DLC-файл и файл вне
    // проекта/мода (connected false) никуда не зеркалят
    return tb[syncTabFlag(sc)] && st && st.connected && st.eligible && info.basis;
  });
}
function syncFlags() {
  return syncFlagsFor(syncActiveTab());
}
function syncFlagsFor(tb) {
  const on = syncScopesFor(tb);
  return { sync_legion: on.includes("legion"),
    sync_resistance: on.includes("resistance") };
}
function paintSyncBoxes() {
  const tb = syncActiveTab();
  const info = syncInfoFor(tb);
  SYNC_SCOPES.forEach(sc => {
    const wrap = $("#sync-" + sc + "-wrap"), box = $("#sync-" + sc);
    if (!wrap || !box) return;
    const st = info && info.scopes && info.scopes[sc];
    const show = !!(st && st.connected);
    wrap.hidden = !show;
    if (show) {
      box.checked = !!tb[syncTabFlag(sc)];
      // серая: исходник не из basis (зеркало только вниз) — или в этом
      // DLC-оверлее нет одноимённого файла
      box.disabled = !info.basis || !st.eligible;
      wrap.classList.toggle("on", box.checked && !box.disabled);
      if (!info.basis) {
        wrap.title = info.from_dlc
          ? (t("sync_dlc_from_dlc") || "Файл уже из DLC — зеркало только из basis")
          : (t("sync_dlc_na") || "Файл вне проекта/мода — зеркалить некуда");
      } else if (!st.eligible) {
        wrap.title = t("sync_dlc_na") || "Нет одноимённого файла в этом DLC";
      } else {
        wrap.title = t("sync_dlc_title") || "Зеркалить правку из basis в DLC того же пути";
      }
    }
  });
  // данные ещё не приезжали — подтянуть и перекрасить (если вкладка та же)
  if (tb && !info) {
    const id = tb.id;
    syncInfoLoad(tb.path).then(() => {
      if (state.activeTabId === id) paintSyncBoxes();
    });
  }
}
// общий разбор ответа с синхронизацией: подтянуть открытые вкладки
// сиблингов, показать итог; missing — спросить «скопировать целиком?».
async function handleSyncResult(j, srcPath) {
  if (!j) return;
  const synced = j.synced || [];
  const parts = [];
  for (const s of synced) {
    const tag = s.label;
    if (s.applied > 0) {
      if (s.structural) markFileTabsStale(s.path);
      else if (s.cells && s.cells.length) syncFileTabsCells(s.path, s.cells);
      else markFileTabsStale(s.path);
      parts.push(tag + " +" + s.applied);
    } else if (s.guarded) {
      parts.push(tag + " (" + (t("sync_dlc_guarded") || "защита") + ")");
    }
    const sk = (s.skipped || []).filter(x => x !== "guarded");
    if (sk.length && s.applied === 0 && !s.guarded) parts.push(tag + ": " + sk.join("; "));
  }
  if (parts.length) {
    toast((t("sync_dlc_applied") || "⇄ Синхронизировано: {info}")
      .replace("{info}", parts.join(", ")), "ok");
  }
  const miss = j.missing || [];
  const lines = [];
  miss.forEach(m => {
    (m.sysnames || []).forEach(n => lines.push(
      { scope: m.scope, path: m.path, label: m.label, name: n }));
  });
  if (!lines.length) return;
  const msg = lines.map(l => (t("sync_dlc_missing") || "Нет в {label}: {rows}")
    .replace("{label}", l.label)
    .replace("{rows}", l.name)).join("\n");
  const choice = await askConfirm({
    title: t("sync_dlc") || "⇄ Синхронизация",
    message: msg,
    buttons: [
      { id: "copy", label: t("sync_dlc_copy") || "Скопировать", kind: "primary" },
      { id: "skip", label: t("sync_dlc_skip") || "Пропустить", kind: "ghost" },
    ],
  });
  if (choice !== "copy") return;
  const names = [...new Set(lines.map(l => l.name))];
  const scopes = [...new Set(lines.map(l => l.scope))];
  try {
    const r = await api("/api/sync_copy_rows", { method: "POST",
      body: JSON.stringify({ path: srcPath, sysnames: names, scopes }) });
    const c = await r.json();
    if (!c || !c.ok) { toast((c && c.error) || "error", "err"); return; }
    (c.synced || []).forEach(s => { if (s.applied > 0) markFileTabsStale(s.path); });
    const done = (c.synced || []).filter(s => s.applied > 0)
      .map(s => s.label + " +" + s.applied);
    if (done.length) {
      toast((t("sync_dlc_copied") || "⇄ Строки скопированы: {info}")
        .replace("{info}", done.join(", ")), "ok");
    }
  } catch (e) { toast(String((e && e.message) || e), "err"); }
}

// ---------- toolbar actions ----------
// тост сохранения с галкой: один тост вместо двух — главный файл плюс
// каждый дописанный сиблинг строкой «Scope → файл сохранён»
function syncSavedLines(saved) {
  return (saved || []).map(e => {
    const label = String((e && e.label) || e || "").replace(/^DLC\s+/i, "");
    const p = (e && e.path) || "";
    const base = String(p).split(/[\\/]/).pop() || String(p);
    return label + " → " + base + " " + (t("saved") || "сохранён");
  });
}
function toastSaveWithSync(j) {
  let msg = t("save_success") || "Сохранено";
  const lines = syncSavedLines(j.sync_saved);
  if (lines.length) msg += "\n" + lines.join("\n");
  toast(msg, "ok");
}
// дискеты дописанных сиблингов: /api/save пишет сессию как есть (память ==
// диск), значит открытая вкладка сиблинга тоже чистая — гасим dirty везде,
// не только на активной. Возвращает, тронуло ли что-то (перекрасить бар).
function markSyncTabsSaved(saved) {
  let touched = false;
  (saved || []).forEach(e => {
    const p = (e && e.path) || e || "";
    if (!p) return;
    try { if (typeof noteSaved === "function") noteSaved(p); } catch (err) {}
    let np = "";
    try { np = normPath(p); } catch (err2) { return; }
    (state.tabs || []).forEach(tb => {
      if (tb.path && tb.dirty) {
        try {
          if (normPath(tb.path) === np) {
            tb.dirty = false; tb.saved = true; touched = true;
          }
        } catch (err3) { /* noop */ }
      }
    });
    ["uprising", "campaign", "swt"].forEach(k => {
      const st = state[k];
      if (st && st.path && st.dirty) {
        try {
          if (normPath(st.path) === np) { st.dirty = false; touched = true; }
        } catch (err4) { /* noop */ }
      }
    });
  });
  return touched;
}
function markDirty() {
  state.dirty = true;
  updateDirty();
}

function updateDirty() {
  $("#dirty-dot").classList.toggle("on", state.dirty);
  if (typeof paintTreeDirty === "function") paintTreeDirty();
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
  const onCampaign = state.activeTabId === "campaign";
  if (onUprising) path = state.uprising.path || "";
  if (onCampaign) path = state.campaign.path || "";
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
    if (onCampaign && j.saved) {
      state.campaign.rows = null;
      state.campaign.dirty = false;
      await openCampaign(path);
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
  if (state.activeTabId === "campaign") return cmpSaveGuarded(!!popup);
  if (state.activeTabId === "compare") return saveCompareGuarded(!!popup);
  return saveCurrent(!!popup);
}

// ---------- анализ зависимостей открытого xml ----------
// Кнопка «Анализ» в тулбаре файла: пересчитать зависимости сейчас —
// исходящие («ссылается на») и входящие («ссылаются») по правилам семейств
// (cars/humans/tanks/helicopters + общее совпадение значений). Найденные
// ссылки ячеек подставляются сразу, без ожидания фонового индекса.
async function analyzeCurrentFile() {
  if (!state.currentFile) { toast(t("no_file"), "err"); return; }
  const btn = $("#btn-analyze");
  const path = state.currentFile.path;
  if (btn) btn.disabled = true;
  try {
    const r = await api("/api/analyze_links", { method: "POST",
      body: JSON.stringify({ path }), timeout: API_TIMEOUT_OPEN });
    const j = await r.json();
    if (!j.ok) { toast(j.error || "error", "err"); return; }
    // подставить ссылки: иконки связей в ячейках появляются сразу
    state.links = j.links || [];
    const activeTab = state.tabs.find(tb => tb.id === state.activeTabId);
    if (activeTab && activeTab.type === "file" &&
        normPath(activeTab.path || "") === normPath(path)) {
      activeTab.links = state.links;
      activeTab.linksLoaded = true;
    }
    if (state.currentFile && normPath(state.currentFile.path) === normPath(path)
        && state.currentFile.rows) renderGrid();
    // без модалки: кнопка только перевыставляет иконки связей в ячейках
    toast(t("analyze") + ": " + (j.links || []).length, "ok");
  } catch (e) {
    toast(t("analyze") + ": " + (e && e.message ? e.message : e), "err");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function depsShortPath(path) {
  const parts = String(path || "").split(/[\\/]/).filter(Boolean);
  const base = parts.pop() || String(path || "");
  const tail = parts.slice(-2).join("/");
  return { base, tail };
}

// модалка зависимостей: группы файлов с раскрывающимися ячейками;
// исходящая ячейка — прыжок к ней же в открытом файле, входящая —
// открытие ссылающегося файла на нужной строке
function renderDepsModal(j, path) {
  const modal = $("#deps-modal");
  const body = $("#deps-body");
  const base = String(path).split(/[\\/]/).pop();
  $("#deps-title").textContent = (t("analyze_title") || "Зависимости") + ": " + base;
  body.innerHTML = "";
  const out = j.outgoing || [];
  const inc = j.incoming || [];
  const outN = out.reduce((n, g) => n + (g.cells || []).length, 0);
  const mkSec = label => {
    const el = document.createElement("div");
    el.className = "deps-sec";
    el.textContent = label;
    body.appendChild(el);
  };
  const mkGroup = (g, cells, onCell) => {
    const { base: gb, tail } = depsShortPath(g.file);
    const box = document.createElement("div");
    box.className = "deps-group";
    const head = document.createElement("div");
    head.className = "deps-ghead";
    const nm = document.createElement("span");
    nm.className = "deps-file";
    nm.textContent = gb;
    nm.title = g.file;
    const dir = document.createElement("span");
    dir.className = "deps-dir";
    dir.textContent = tail;
    const cnt = document.createElement("span");
    cnt.className = "deps-count";
    cnt.textContent = String(g.total != null ? g.total : cells.length);
    const open = document.createElement("button");
    open.className = "btn sm ghost deps-open";
    open.textContent = t("analyze_open") || "Открыть файл";
    open.addEventListener("click", async ev => {
      ev.stopPropagation();
      modal.hidden = true;
      const first = cells[0];
      await openFile(g.file, first ? { scrollRow: first.target_row != null ? first.target_row : first.row } : undefined);
    });
    head.append(nm, dir, cnt, open);
    const list = document.createElement("div");
    list.className = "deps-cells";
    list.hidden = true;
    head.addEventListener("click", () => { list.hidden = !list.hidden; });
    const CAP = 60;
    cells.slice(0, CAP).forEach(c => {
      const row = document.createElement("div");
      row.className = "deps-cell";
      const val = document.createElement("span");
      val.className = "deps-val";
      // ref — разрешённый токен («Lgn_wolf» из «Lgn_wolf:4»); вся ячейка — в title
      val.textContent = c.ref || c.value;
      val.title = c.value;
      const pos = document.createElement("span");
      pos.className = "deps-pos";
      pos.textContent = c.colName || ("R" + (c.row + 1) + ":C" + (c.col + 1));
      const go = document.createElement("button");
      go.className = "deps-jump";
      go.textContent = t("analyze_goto") || "К ячейке";
      go.addEventListener("click", async ev => {
        ev.stopPropagation();
        modal.hidden = true;
        await onCell(c);
      });
      row.append(val, pos, go);
      list.appendChild(row);
    });
    const shown = Math.min(cells.length, CAP);
    const total = g.total != null ? g.total : cells.length;
    if (total > shown) {
      const more = document.createElement("div");
      more.className = "deps-more";
      more.textContent = (t("analyze_more") || "…и ещё {n}").replace("{n}", String(total - shown));
      list.appendChild(more);
    }
    box.append(head, list);
    body.appendChild(box);
  };
  const cols = (state.currentFile && state.currentFile.columns) || [];
  if (out.length) {
    mkSec((t("analyze_out") || "Ссылается на") + ` (${out.length}, ${outN})`);
    out.forEach(g => mkGroup(g, g.cells.map(c => Object.assign({}, c, {
      colName: cols[c.col] ? `${cols[c.col]} · R${c.row + 1}` : undefined,
    })), async c => { focusLinkedCell(c.row, c.col); }));
  }
  if (inc.length) {
    const incN = inc.reduce((n, g) => n + (g.cells || []).length, 0);
    mkSec((t("analyze_in") || "Ссылаются") + ` (${inc.length}, ${incN})`);
    inc.forEach(g => mkGroup(g, g.cells, async c => {
      await openFile(g.file);
      focusLinkedCell(c.row, c.col);
    }));
  }
  if (!out.length && !inc.length) {
    const empty = document.createElement("div");
    empty.className = "deps-empty";
    empty.textContent = t("analyze_empty") || "Зависимостей не найдено";
    body.appendChild(empty);
  }
  modal.hidden = false;
  modal.onclick = e => { if (e.target === modal) modal.hidden = true; };
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
        if (j.dst) {
          // копия могла создать новый раздел древа (напр. dlc/) —
          // перечитываем до открытия, иначе вкладка без строки в древе
          await noteExternalTreeChange(target);
          await openFile(j.dst);
        }
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
    body: JSON.stringify({ path: state.currentFile.path, ...syncFlags() }) });
  const j = await r.json();
  if (j.ok) {
    state.dirty = false;
    if (j.saved) noteSaved(state.currentFile.path);
    markSyncTabsSaved(j.sync_saved);
    const activeTab = state.tabs.find(t => t.id === state.activeTabId);
    if (activeTab) activeTab.dirty = false;
    updateDirty();
    renderTabBar();
    toastSaveWithSync(j);
  }
  else toast((j.error || t("save_failed")), "err");
}

async function addRow() {
  if (!state.currentFile) return;
  const r = await api("/api/add_row", { method: "POST",
    body: JSON.stringify({ path: state.currentFile.path, values: null,
      ...syncFlags() }) });
  const j = await r.json();
  if (j.ok) {
    await handleSyncResult(j, state.currentFile.path);
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
    body: JSON.stringify({ path: state.currentFile.path, row: state.selectedRow,
      ...syncFlags() }) });
  const j = await r.json();
  if (j.ok) {
    await handleSyncResult(j, state.currentFile.path);
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
    body: JSON.stringify({ path: state.currentFile.path, name,
      ...syncFlags() }) });
  const j = await r.json();
  if (j.ok) {
    await handleSyncResult(j, state.currentFile.path);
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
    body: JSON.stringify({ path: state.currentFile.path, col: ci,
      ...syncFlags() }) });
  const j = await r.json();
  if (j.ok) {
    await handleSyncResult(j, state.currentFile.path);
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
    body: JSON.stringify({ path: state.currentFile.path, values,
      ...syncFlags() }) });
  const j = await r.json();
  if (j.ok) {
    await handleSyncResult(j, state.currentFile.path);
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
    body: JSON.stringify({ path: f.path, row: ri, col: ci, value: newVal,
      ...syncFlags() }) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "edit error", "err"); return; };
  await handleSyncResult(j, f.path)
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
    // Запомнить выделенный фрагмент СРАЗУ: левый клик по пункту меню схлопнет
    // живое выделение раньше click-хендлера (там уже будет пусто).
    try { gridCtxSelText = gridTextSelection(); } catch (e2) { gridCtxSelText = ""; }
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
      // выделенный мышью кусок текста — только его, иначе всё поле целиком.
      // Живое выделение к моменту клика уже схлопнуто — берём запомненное.
      const frag = gridCopyFragment();
      state.clipboard = frag || String(state.currentFile.rows[ctxRow].values[ctxCol] ?? "");
      copyText(state.clipboard);
    } else if (act === "cut-cell" && ctxRow != null && ctxCol != null) {
      // cut: copy the value out, then clear the cell (undoable via history).
      // Но при выделенном куске чистить всё поле нельзя — только копируем кусок.
      const frag = gridCopyFragment();
      if (frag) {
        state.clipboard = frag;
        copyText(state.clipboard);
      } else {
        state.clipboard = String(state.currentFile.rows[ctxRow].values[ctxCol] ?? "");
        copyText(state.clipboard);
        applyCellEdit(ctxRow, ctxCol, "");
      }
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

