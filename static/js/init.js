/* TerminatorToolSet frontend — init.js: init() и регистрация старта
   Вырезано из app.js без изменений логики. Классические скрипты,
   общий глобальный скоуп, порядок загрузки — FILES в templates/index.html. */
// ---------- init ----------
async function init() {
  // свежие состояния фич: их фабрики в swt.js/uprising.js, state стартует с null
  state.swt = swtFreshState();
  state.uprising = uprFreshState();
  state.campaign = cmpFreshState();
  document.body.classList.add("dark");
  bootPing(78, ""); // скрипты встали (таблица boot_stages), дальше этапы с подписями
  await loadConfig();
  await loadI18n();
  // страница прошла критичную фазу: watchdog не должен её перезагружать
  window.__tshBooted = true;
  try { sessionStorage.removeItem("tsh_boot_reload"); } catch (e) { /* приватный режим */ }
  bootPing(82, t("boot_config"));
  setupDnD();
  setupSidebar();
  setupTabBar();
  setupCmpSearch();
  setupKeyDropdown();
  setupCmpFs();
  setupSwtFind();
  setupSwt();
  setupUprising();
  setupCampaign();
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
  $("#btn-analyze").onclick = analyzeCurrentFile;
  $("#btn-undo").onclick = undoCurrent;
  $("#btn-redo").onclick = redoCurrent;
  setUndoRedoButtons(false, false);
  $("#btn-compare").onclick = openCompare;
  $("#btn-create-mod").onclick = openCreateMod;
  $("#btn-unpacker").onclick = openUnpacker;
  $("#btn-uprising").onclick = () => openUprising();
  $("#btn-campaign").onclick = () => openCampaign();
  $("#btn-swt").onclick = openSwtEditor;
  $("#landing-create-mod").onclick = openCreateMod;
  $("#landing-unpacker").onclick = openUnpacker;
  $("#landing-uprising").onclick = () => openUprising();
  $("#landing-campaign").onclick = () => openCampaign();
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
    upDest.value = localStorage.getItem("tsh_up_dest") || "C:\\TDFD_Unpacked";
    $("#up-pick-root").onclick = async () => {
      const d = await pickFolder();
      if (d) {
        upRoot.value = d; localStorage.setItem("tsh_up_root", d);
        // путь из распаковки — тоже путь к игре: синхронизируем второй раздел
        try {
          await api("/api/game_dir", { method: "POST", body: JSON.stringify({ path: d }) });
          const cm = $("#cm-game-dir");
          if (cm && !cm.value.trim()) { cm.value = d; cmPathHint(); }
        } catch (e) { /* не критично */ }
      }
    };
    $("#up-pick-dest").onclick = async () => {
      const d = await pickFolder();
      if (d) {
        // выбранная папка — РОДИТЕЛЬ: распаковка всегда идёт в
        // <выбор>\TDFD_Unpacked (хвост добавляем жёстко; уже есть — не дублируем)
        const t = String(d).replace(/[\\/]+$/, "");
        const v = /TDFD_Unpacked$/i.test(t) ? t : t + "\\TDFD_Unpacked";
        upDest.value = v; localStorage.setItem("tsh_up_dest", v);
      }
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
  const discordBtn = $("#btn-discord");
  if (discordBtn) discordBtn.onclick = () => api("/api/open_link", { method: "POST",
    body: JSON.stringify({ url: DISCORD_URL }) });
  updSetup();
  updStateLoad();
  gaSetup();
  gaStateLoad();
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
  // settings save on change (все чекбоксы/селекты без своей кнопки
  // «Сохранить» — иначе галка слетает при закрытии окна, как было с
  // auto-update/auto-hide-tree/guard-unpacked)
  ["auto-save", "fullscreen", "theme", "keycol", "window-size", "tray", "open-browser", "browser-to-tray", "auto-update", "auto-hide-tree", "guard-unpacked", "lang"].forEach(id => {
    $("#set-" + id).addEventListener("change", saveSettings);
  });
  setupSettingsTabs();
  // paths tab: pick + save folders manually.
  // крестик после иконки папки виден только при указанном пути и
  // ЗАКРЫВАЕТ источник (closeTreeSource), а не просто стирает поле —
  // иначе путь пуст, а дерево/карта живут по старому корню.
  // Пары и syncPathClear — в chrome.js (нужны и openSettings).
  for (const [inp, btn, src] of PATH_CLEAR_PAIRS) {
    $("#" + inp).addEventListener("input", syncPathClear);
    $("#" + btn).addEventListener("click", async () => {
      if (!$("#" + inp).value.trim()) return;
      await closeTreeSource(src);
      // closeTreeSource уже отвязал путь в state.config — подтянуть поле
      $("#set-project-path").value = state.config.project_path || state.config.last_project || "";
      $("#set-unpacked").value = state.config.unpacked_path || "";
      $("#set-mod-path").value = state.config.mod_path || "";
      syncPathClear();
      toast(t("save_success"), "ok");
    });
  }
  $("#set-unpacked-pick").addEventListener("click", async () => {
    const p = await pickFolder();
    if (p) { $("#set-unpacked").value = p; syncPathClear(); }
  });
  $("#set-project-pick").addEventListener("click", async () => {
    const p = await pickFolder();
    if (p) { $("#set-project-path").value = p; syncPathClear(); }
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
      // путь проекта из настроек применяется сразу: дерево перезагружается
      // тем же путём, что и с главной (иначе путь виден, но не загружен)
      const curRoot = (state.project && state.project.root) || "";
      if (pp && normPath(pp) !== normPath(curRoot)) await loadProject(pp);
      else refreshSrcPaths();
      syncPathClear();
      toast(t("save_success"), "ok");
    }
  });
  $("#set-mod-pick").addEventListener("click", async () => {
    const p = await pickFolder();
    if (p) { $("#set-mod-path").value = p; syncPathClear(); }
  });
  // иконка папки логов в ряду категорий настроек (справа): открыть Logs
  const logsBtn = $("#btn-open-logs");
  if (logsBtn) logsBtn.addEventListener("click", async () => {
    try {
      const r = await api("/api/open_logs", { method: "POST", body: "{}" });
      const j = await r.json();
      if (!j.ok) toast(j.error || "error", "err");
    } catch (e) { toast(String((e && e.message) || e), "err"); }
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
  $("#cmp-run").onclick = cmpRunToggle;
  // галочки «⇄ DLC Legion»/«⇄ DLC Resistance» на вкладке species-таблицы:
  // зеркало правки basis-файла в DLC того же корня. Живут на вкладке до её закрытия.
  SYNC_SCOPES.forEach(sc => {
    $("#sync-" + sc).addEventListener("change", e => {
      const tb = state.tabs.find(t => t.id === state.activeTabId);
      if (!tb || tb.type !== "file") return;
      tb[syncTabFlag(sc)] = !!e.target.checked;
      paintSyncBoxes();
      const on = !!e.target.checked && !e.target.disabled;
      toast((t(on ? "sync_dlc_on" : "sync_dlc_off") || (on
        ? "Синхронизация включена: {scope}"
        : "Синхронизация выключена: {scope}"))
        .replace("{scope}", syncScopeTitle(sc)), "ok");
    });
  });
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
    $("#cmp-" + side + "-path").addEventListener("change", () => cmpPathChanged(side));
    // compact file dropdown: toggle the floating list
    $("#cmp-" + side + "-dd-btn").addEventListener("click", e => {
      e.stopPropagation();
      const list = $("#cmp-" + side + "-list");
      list.hidden = !list.hidden;
      // список открыт — поиск сразу в фокусе, можно печатать без клика
      if (!list.hidden) {
        const inp = list.querySelector(".cmp-list-search");
        if (inp) inp.focus();
      }
    });
  });
  // click outside any compare dropdown closes it
  document.addEventListener("click", e => {
    ["left", "right"].forEach(side => {
      const dd = $("#cmp-" + side + "-dd");
      if (dd && !dd.contains(e.target)) $("#cmp-" + side + "-list").hidden = true;
    });
  });
  // compare pane virtualization: append more rows when scrolled near the bottom.
  // The bottom check lives inside rAF: reading scrollHeight on every raw
  // scroll event forces a full-table reflow per wheel tick and froze the pane,
  // so a burst of events schedules a single check reading the latest position.
  const cmpAppendQueued = { left: false, right: false };
  ["left", "right"].forEach(side => {
    $("#cmp-pane-" + side).addEventListener("scroll", e => {
      if (!state.cmpCtx || cmpAppendQueued[side]) return;
      cmpAppendQueued[side] = true;
      const pane = e.target;
      requestAnimationFrame(() => {
        cmpAppendQueued[side] = false;
        if (!state.cmpCtx) return;
        if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 800) {
          appendCmpRows(side, CMP_CHUNK);
        }
      });
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
  setupCmpHelp();
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
  loadTreeFilters();  const tfBtn = $("#tree-filter-btn");
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

  // ручной рескан всех трёх деревьев + фоновый вотчер внешних изменений
  const rsBtn = $("#tree-rescan-btn");
  if (rsBtn) rsBtn.addEventListener("click", () => rescanAllTrees(rsBtn));
  try { ensureTreeWatch(); } catch (e) { /* вотчер не критичен */ }

  // проект прошлого запуска (project_path в приоритете) грузится фоном
  // в конце init: лаунчер его не ждёт (см. bootChain ниже)
  bootPing(86, t("boot_ui")); // интерфейс собран, деревья запускаются следом
  const lastProj = state.config.project_path || state.config.last_project;
  // тяжёлые обходы игры/мода (секунды на распакованной игре) — фоном, лаунчер
  // не держат: древо показывает «Загрузка…», пока walk не вернулся
  if ((state.config.unpacked_path) || "") loadGameTree().then(() => bgTreeDone("game")).catch(() => {});
  if ((state.config.mod_path) || "") loadModTree().then(() => bgTreeDone("mod")).catch(() => {});
  // сохранённый глобальный источник: localStorage (перезагрузка страницы
  // в том же запуске — origin тот же), иначе config.json (tree_view —
  // межзапусковый, localStorage умирает со случайным портом), иначе
  // миграция со старого ключа карты; итог валидируем доступностью
  let want = "project";
  try {
    want = localStorage.getItem("tsh_src") ||
      ((state.config && state.config.tree_view) || "") ||
      (localStorage.getItem("tsh_upr_src") === "game" ? "game" : "project");
  } catch (e) { /* приватный режим */ }
  if (!SRC_ORDER.includes(want)) want = "project";
  state.treeView = srcAvail(want) ? want : (srcFirst(null) || "project");
  persistSrc(state.treeView);
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
  bootPing(88, t("boot_trees"));

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
  // проект прошлого запуска + вкладки — фоном, порядок сохранён.
  // Флаг bootLoading отличает «проект ещё грузится» от «проекта нет»:
  // клик по вкладке Проект во время загрузки не открывает диалог.
  let bootChain;
  if (lastProj) {
    const parts = String(lastProj).split(/[\\/]/).filter(Boolean);
    bootPing(90, (t("boot_project") || "") + " " + (parts.pop() || lastProj));
    state.bootLoading = true;
    // фон старта: проект прошлого запуска подтягивается молча, выбранный
    // источник (Проект | Игра | Мод) не трогаем — иначе сохранённый game/mod
    // слетал бы в project при каждом запуске
    bootChain = loadProject(lastProj, { keepSrc: true }).then(() => bootPing(92, t("boot_tree")));
  } else {
    bootChain = Promise.resolve();
  }
  // восстановить вкладки, открытые до перезагрузки страницы (watchdog/F5)
  bootChain.then(() => restoreTabs())
    .then(() => { state.bootLoading = false; bootPing(96, t("boot_tabs")); })
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
  // переключалось обратно на тот же источник — крестик «не работал».
  // Тело — closeTreeSource (chrome.js): его же дёргают крестики путей
  // в настройках, чтобы путь не только стирался, но и отвязывался.
  $("#sidebar-close").onclick = async e => {
    e.stopPropagation();
    await closeTreeSource(state.treeView);
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
