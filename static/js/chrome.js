/* TerminatorToolSet frontend — chrome.js: hotkeys/pickers/create-mod/unpacker/tooltip/settings/dnd/recents/updates
   Вырезано из app.js без изменений логики. Классические скрипты,
   общий глобальный скоуп, порядок загрузки — FILES в templates/index.html. */
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
      // Кусок текста, выделенный мышью внутри ячейки: отдать его нативному
      // копированию, а не затирать целым полем (вставку это не касается —
      // нативный Ctrl+V в нередактируемой ячейке ничего не вставит).
      if (c !== "KeyV" && typeof gridTextSelection === "function" &&
          gridTextSelection()) return;
      // Провал ВНУТРЬ ячейки (открыт редактор .cell-input): выделение живёт
      // в самом input (window.getSelection его не видит) — частичное берём
      // нативно, без preventDefault. Целое поле — как раньше, через перехват.
      if (c !== "KeyV" && tgt && tgt.classList &&
          tgt.classList.contains("cell-input")) {
        let selS = null, selE = null;
        try { selS = tgt.selectionStart; selE = tgt.selectionEnd; } catch (err) {}
        if (selS != null && selE != null && selE > selS) {
          const iv = String(tgt.value ?? "");
          if (!(selS === 0 && selE === iv.length)) {
            state.clipboard = iv.slice(selS, selE);
            if (c === "KeyC") copyText(state.clipboard);
            else toast(t("cut_buffer") || "Вырезано в буфер", "ok");
            return;
          }
        }
      }
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

// двусторонняя синхронизация пути к игре между «Создание мода»
// (#cm-game-dir) и «Распаковка» (#up-root): выставили в одном разделе —
// подставилось и во втором (бэкенд-ключ game_dir + localStorage)
function syncGameDirInputs(dir) {
  if (!dir) return;
  const cm = $("#cm-game-dir");
  if (cm) cm.value = dir;
  const up = $("#up-root");
  if (up) up.value = dir;
  try { localStorage.setItem("tsh_up_root", dir); } catch (e) { /* приватный режим */ }
  cmPathHint();
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
  else syncGameDirInputs(dir);
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
  syncGameDirInputs(dir);
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
    // мод открывается только в своём разделе «Мод», проект не трогаем
    closeTab("create-mod");
    await setSrc("mod");
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
  // двусторонняя синхронизация: путь из «Создания мода» подтягивается сюда
  api("/api/game_dir").then(r => r.json()).then(j => {
    const up = $("#up-root");
    if (j && j.ok && j.game_dir && up && !up.value.trim()) {
      up.value = j.game_dir;
      try { localStorage.setItem("tsh_up_root", j.game_dir); } catch (e) { /* noop */ }
    }
  }).catch(() => {});
}

function upPlanGroup(title, paks, groupCls, copies, skipped, loc) {
  const card = document.createElement("div");
  card.className = "up-group";
  const head = document.createElement("div");
  head.className = "up-group-head";
  head.textContent = title;
  card.appendChild(head);
  const list = document.createElement("div");
  list.className = "up-group-list";
  const items = paks || [];
  // loose-папки идут первыми: копируются до распаковки; клик выключает
  // как у паков (серый + в прогон не идёт)
  for (const c of (copies || [])) {
    const row = document.createElement("div");
    row.className = "up-pak up-copy" + (groupCls ? " " + groupCls : "");
    const ckey = c.path || c.name;
    if (state.upDone && state.upDone.has(ckey)) row.classList.add("done");
    if (state.upOff && state.upOff.has(ckey)) row.classList.add("off");
    row.dataset.pak = ckey;
    row.title = (c.path || c.name) + "\n" + title + "\n" + (t("up_off_hint") || "Клик — исключить из распаковки");
    row.tabIndex = 0;
    row.onclick = () => {
      if (!state.upOff) state.upOff = new Set();
      if (state.upOff.has(ckey)) {
        state.upOff.delete(ckey);
        row.classList.remove("off");
      } else {
        state.upOff.add(ckey);
        row.classList.remove("done");
        row.classList.add("off");
      }
    };
    row.onkeydown = e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); row.onclick(); }
    };
    const n = document.createElement("span");
    n.className = "up-pak-n";
    n.textContent = "⤵";
    const name = document.createElement("span");
    name.className = "up-pak-name";
    name.textContent = "📁 " + c.name + "\\";
    row.append(n, name);
    list.appendChild(row);
  }
  if (!items.length && !(loc || []).length && !(skipped || []).length && !list.children.length) {
    const none = document.createElement("div");
    none.className = "up-pak-none";
    none.textContent = t("up_no_paks") || ".pak архивы не найдены";
    list.appendChild(none);
  }
  // локализация — ОДИН чип на группу (внутри все языки): клик выключает
  // сразу все паки языков, в прогоне идут вторыми после loose-папки
  if ((loc || []).length) {
    const row = document.createElement("div");
    row.className = "up-pak up-loc" + (groupCls ? " " + groupCls : "");
    const keys = loc.map(p => p.path || p.name).filter(Boolean);
    row._locPaths = keys;
    const langs = [...new Set(loc.map(p => p.lang).filter(Boolean))].join(", ");
    if (keys.every(k => state.upDone && (state.upDone.has(k)))) row.classList.add("done");
    if (keys.some(k => state.upOff && state.upOff.has(k))) row.classList.add("off");
    row.dataset.loc = "1";
    row.title = keys.join("\n") + "\n→ localization\\\n" + (t("up_off_hint") || "Клик — исключить из распаковки");
    row.tabIndex = 0;
    const toggle = () => {
      if (!state.upOff) state.upOff = new Set();
      if (keys.some(k => state.upOff.has(k))) {
        keys.forEach(k => state.upOff.delete(k));
        row.classList.remove("off");
      } else {
        keys.forEach(k => state.upOff.add(k));
        row.classList.remove("done");
        row.classList.add("off");
      }
    };
    row.onclick = toggle;
    row.onkeydown = e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    };
    const n = document.createElement("span");
    n.className = "up-pak-n";
    n.textContent = "🌐";
    const name = document.createElement("span");
    name.className = "up-pak-name";
    name.textContent = "localization\\" + (langs ? " (" + langs + ")" : "") + " — " + loc.length;
    row.append(n, name);
    list.appendChild(row);
  }
  items.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "up-pak" + (groupCls ? " " + groupCls : "");
    const key = p.path || p.name;
    // зелёная метка уже распакованного пака (переживает пересканирование);
    // ключ — полный путь: basename дублируются между группами
    if (state.upDone && (state.upDone.has(key) || state.upDone.has(p.name))) row.classList.add("done");
    // клик по чипу исключает пак из распаковки (серый); повторный клик возвращает
    if (state.upOff && state.upOff.has(key)) row.classList.add("off");
    row.dataset.pak = key;
    row.dataset.pakname = p.name;
    row.title = p.path + "\n" + title + "\n" + (t("up_off_hint") || "Клик — исключить из распаковки");
    row.tabIndex = 0;
    const toggle = () => {
      if (!state.upOff) state.upOff = new Set();
      if (state.upOff.has(key)) {
        state.upOff.delete(key);
        row.classList.remove("off");
      } else {
        state.upOff.add(key);
        row.classList.remove("done");
        row.classList.add("off");
      }
    };
    row.onclick = toggle;
    row.onkeydown = e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    };
    const n = document.createElement("span");
    n.className = "up-pak-n";
    n.textContent = String(i + 1).padStart(2, "0");
    const name = document.createElement("span");
    name.className = "up-pak-name";
    name.textContent = p.name;
    row.append(n, name);
    list.appendChild(row);
  });
  // пропущенные очередью .pak (не basis.pak и не patch_*): в прогон не идут,
  // чипы некликабельные, с предупреждением — молча их больше не теряем
  for (const s of (skipped || [])) {    const row = document.createElement("div");
    row.className = "up-pak up-skipped" + (groupCls ? " " + groupCls : "");
    row.title = (s.path || s.name) + "\n" + (t("up_skipped") || "Не входит в очередь распаковки");
    const n = document.createElement("span");
    n.className = "up-pak-n";
    n.textContent = "⚠";
    const name = document.createElement("span");
    name.className = "up-pak-name";
    name.textContent = s.name;
    row.append(n, name);
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}

async function upScan() {
  const root = $("#up-root").value.trim();
  if (!root) { toast(t("cm_need_dir"), "err"); return; }
  localStorage.setItem("tsh_up_root", root);
  // корень сканирования — путь к игре: запоминаем для «Создания мода»
  try {
    await api("/api/game_dir", { method: "POST", body: JSON.stringify({ path: root }) });
    const cm = $("#cm-game-dir");
    if (cm && !cm.value.trim()) { cm.value = root; cmPathHint(); }
  } catch (e) { /* не критично */ }
  const r = await api("/api/unpack_scan", { method: "POST", body: JSON.stringify({ path: root }) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "error", "err"); return; }
  state.upPlan = j;
  const plan = $("#up-plan");
  plan.hidden = false;
  plan.innerHTML = "";
  const sk = j.skipped || {};
  const lc = j.loc || {};
  plan.appendChild(upPlanGroup(t("up_grp_base") || "Основа → basis\\", j.base, "g-base", (j.copy || {}).base, sk.base, lc.base));
  plan.appendChild(upPlanGroup(t("up_grp_legion") || "DLC Legion → dlc\\legion\\basis", j.legion, "g-legion", (j.copy || {}).legion, sk.legion, lc.legion));
  plan.appendChild(upPlanGroup(t("up_grp_res") || "DLC Resistance → dlc\\resistance\\basis", j.resistance, "g-res", (j.copy || {}).resistance, sk.resistance, lc.resistance));
  plan.appendChild(upPlanGroup(t("up_grp_evo") || "DLC Evolution → dlc\\evolution\\basis", j.evolution, "g-evo", (j.copy || {}).evolution, sk.evolution, lc.evolution));
  const locN = ["base", "legion", "resistance", "evolution"]
    .reduce((n, k) => n + (((j.loc || {})[k] || []).length), 0);
  const total = (j.base || []).length + (j.legion || []).length + (j.resistance || []).length
    + (j.evolution || []).length + locN;
  $("#up-run").disabled = !total;
  $("#up-abort").disabled = true;
  const prog = $("#up-progress");
  if (prog) prog.hidden = true;
  // фокус с кнопки: иначе :focus-visible-аутлайн висит рядом с чипами
  const scanBtn = $("#up-scan");
  if (scanBtn && scanBtn.blur) scanBtn.blur();
  if (!j.sevenz) toast(t("up_no_7z") || "7-Zip не найден", "err");
  if (!total) toast(t("up_no_paks") || ".pak архивы не найдены", "err");
  const skN = ["base", "legion", "resistance", "evolution"]
    .reduce((n, k) => n + (((j.skipped || {})[k] || []).length), 0);
  if (skN) toast((t("up_skipped_warn") || "Пропущено архивов вне очереди") + ": " + skN, "err");
}

let upPollTimer = null;

function upPoll() {
  if (upPollTimer) { clearTimeout(upPollTimer); upPollTimer = null; }
  api("/api/unpack_status").then(r => r.json()).then(j => {
    if (!j.ok) return;
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
      // готовые паки зеленеют по очереди, прямо во время распаковки
      // (выключенные кликом чипы не красим — их пропускает бэкенд).
      // Ключ — полный путь пака (basename дублируются между группами);
      // сравниваем в JS, а не CSS-селектором: бэкслэши пути ломали бы селектор
      if (j.done_files && j.done_files.length) {
        if (!state.upDone) state.upDone = new Set();
        const doneSet = new Set(j.done_files.filter(Boolean));
        doneSet.forEach(nm => state.upDone.add(nm));
        $$("#up-plan .up-pak:not(.off)").forEach(x => {
          if (x.dataset.pak && (doneSet.has(x.dataset.pak) || doneSet.has(x.dataset.pakname))) x.classList.add("done");
          if (x._locPaths && x._locPaths.length && x._locPaths.every(k => doneSet.has(k))) x.classList.add("done");
        });
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
          // каждый распакованный пак получает зелёную метку
          if (!state.upDone) state.upDone = new Set();
          ["base", "legion", "resistance", "evolution"].forEach(k => {
            ((state.upPlan || {})[k] || []).forEach(p => {
              if (p && (p.path || p.name)) state.upDone.add(p.path || p.name);
            });
            ((((state.upPlan || {}).loc || {})[k]) || []).forEach(p => {
              if (p && (p.path || p.name)) state.upDone.add(p.path || p.name);
            });
            ((((state.upPlan || {}).copy || {})[k]) || []).forEach(p => {
              if (p && (p.path || p.name)) state.upDone.add(p.path || p.name);
            });
          });
          $$("#up-plan .up-pak:not(.off)").forEach(x => x.classList.add("done"));
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
  // кликом выключенные чипы в распаковку не идут (паки и папки одним списком)
  const off = state.upOff || new Set();
  const left = arr => (arr || []).filter(p => !off.has(p.path || p.name));
  const base = left(state.upPlan.base), legion = left(state.upPlan.legion),
    res = left(state.upPlan.resistance), evo = left(state.upPlan.evolution);
  const lc = state.upPlan.loc || {};
  const locLeft = k => left(lc[k]);
  const locAll = [...locLeft("base"), ...locLeft("legion"), ...locLeft("resistance"), ...locLeft("evolution")];
  const cp = state.upPlan.copy || {};
  const cpLeft = k => left(cp[k]);
  const copies = [...cpLeft("base"), ...cpLeft("legion"), ...cpLeft("resistance"), ...cpLeft("evolution")];
  const total = base.length + legion.length + res.length + evo.length + locAll.length;
  if (!total && !copies.length) {
    const skipped = off.size > 0;
    toast(skipped
      ? (t("up_all_off") || "Всё исключено кликом — включите хотя бы один пак или папку")
      : (t("up_no_paks") || ".pak архивы не найдены"), "err");
    return;
  }
  // 7z нужен только под паки: копирование-only прогон идёт без него
  if (total && state.upPlan.sevenz === "") { toast(t("up_no_7z") || "7-Zip не найден", "err"); return; }
  localStorage.setItem("tsh_up_dest", dest);
  // что именно распакуем/скопируем: группы и количество .pak + папки
  const parts = [];
  const grp = (key, fb, arr) => { if ((arr || []).length) parts.push((t(key) || fb) + ": " + arr.length); };
  if (locAll.length) parts.push("🌐 " + (t("up_loc") || "Локализация") + ": " +
    locAll.map(p => (p.lang ? p.lang + "\\" : "") + p.name).join(", "));
  grp("up_grp_base", "Основа", [...base, ...locLeft("base")]);
  grp("up_grp_legion", "DLC Legion", [...legion, ...locLeft("legion")]);
  grp("up_grp_res", "DLC Resistance", [...res, ...locLeft("resistance")]);
  grp("up_grp_evo", "DLC Evolution", [...evo, ...locLeft("evolution")]);
  const cpgrp = (key, fb) => {
    const l = cpLeft(key);
    if (l.length) parts.push("📁 " + (t(key) || fb) + ": " + l.map(c => c.name).join(", "));
  };
  cpgrp("up_grp_base", "Основа");
  cpgrp("up_grp_legion", "DLC Legion");
  cpgrp("up_grp_res", "DLC Resistance");
  cpgrp("up_grp_evo", "DLC Evolution");
  const skNames = [];
  ["base", "legion", "resistance", "evolution"].forEach(k => {
    ((((state.upPlan || {}).skipped || {})[k]) || []).forEach(p => {
      if (p && p.name) skNames.push(p.name);
    });
  });
  if (skNames.length) parts.push("⚠ " + (t("up_skipped") || "Не входят в очередь") + ": " + skNames.join(", "));
  const totalTxt = total
    ? total + " " + (t("files_n") || "files")
    : copies.length + " " + (t("up_folders_n") || "папки");
  const choice = await askConfirm({
    title: t("up_run") || "Распаковать",
    message: (t("up_confirm") || "Распаковать архивы в") + " " + dest + "\n" +
      parts.join("  ·  ") + "  (" + totalTxt + ")",
    buttons: [
      { id: "ok", label: t("up_run") || "Распаковать" },
      { id: "cancel", label: t("cancel"), kind: "ghost" },
    ],
  });
  if (choice !== "ok") return;
  state.upDest = dest;
  const r = await api("/api/unpack_run", { method: "POST",
    body: JSON.stringify({ game_root: root, dest,
      skip: Array.from(off).filter(x => typeof x === "string") }) });
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
  toast(t("up_running") || "Распаковка…", "ok");
  upPoll();
}

// ---------- tooltip ----------
// Стандартная задержка всплывашки, как у системных (~полсекунды): показ
// по таймеру, отмена по mouseleave. Позицию берём живую (трекинг курсора),
// а не точку входа — за полсекунды мышь успевает уйти. Тот же текст уже
// висит — только подтягиваем позицию, без перемигивания.
var TIP_DELAY = 500;
let tipEl = null;
let tipRaf = null;
let tipX = 0, tipY = 0;
let tipTimer = null;
let tipMX = 0, tipMY = 0;
try {
  document.addEventListener("mousemove", e => {
    tipMX = e.clientX; tipMY = e.clientY;
    // показанная подсказка следует за курсором (иначе, ведя мышь вдоль
    // ряда чипов, уходишь от застывшего tip'а — он остаётся левее);
    // ожидание показа — по-прежнему только живой позицией в таймере
    if (tipEl) moveTip(e);
  }, { passive: true });
} catch (e) {}
function showTip(e, text) {
  if (tipEl && tipEl.textContent === text) { moveTip(e); return; }
  hideTip();
  tipTimer = setTimeout(() => {
    tipTimer = null;
    tipEl = document.createElement("div");
    tipEl.className = "tip";
    tipEl.textContent = text;
    document.body.appendChild(tipEl);
    moveTip({ clientX: tipMX, clientY: tipMY });
  }, TIP_DELAY);
}
function moveTip(e) {
  if (!tipEl) return;
  // позиция — по реальному размеру всплывашки: не влезла справа —
  // флип вплотную слева от курсора (а не прыжок на -330), не влезла
  // снизу — вверх; в крайнем случае прижать к краю вьюпорта
  const pad = 14, m = 8;
  let w = 0, h = 0;
  try { w = tipEl.offsetWidth || 0; h = tipEl.offsetHeight || 0; } catch (err) {}
  let x = e.clientX + pad, y = e.clientY + pad;
  try {
    if (w && x + w > window.innerWidth - m) x = e.clientX - w - pad;
    if (h && y + h > window.innerHeight - m) y = e.clientY - h - pad;
  } catch (err) {}
  if (x < m) x = m;
  if (y < m) y = m;
  tipX = x; tipY = y;
  // одно перемещение на кадр: коалесим пачку mouseover'ов в один layout/repaint
  if (tipRaf !== null) return;
  tipRaf = requestAnimationFrame(() => {
    tipRaf = null;
    if (tipEl) { tipEl.style.left = tipX + "px"; tipEl.style.top = tipY + "px"; }
  });
}
function hideTip() {
  if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
  if (tipEl) { tipEl.remove(); tipEl = null; }
  if (tipRaf !== null) { cancelAnimationFrame(tipRaf); tipRaf = null; }
}
// ---------- единый стиль подсказок по всей программе ----------
// Любой нативный title показываем кастомным .tip (та же задержка
// TIP_DELAY): на время показа атрибут снимаем, чтобы поверх не всплывала
// системная подсказка, при уходе мыши — возвращаем. Прямые вызовы
// showTip (плитки кампании) не затрагиваются: у них нет title.
// Отказ — data-tip-native (оставить системную подсказку).
let tipTitleEl = null;
let tipTitleText = "";
function tipTitleRestore() {
  if (!tipTitleEl) return;
  try {
    // title уже вернули (например, applyI18n при смене языка) — не затираем
    if (!tipTitleEl.hasAttribute("title")) tipTitleEl.setAttribute("title", tipTitleText);
  } catch (e) {}
  tipTitleEl = null;
}
try {
  document.addEventListener("mouseover", e => {
    const t = e.target;
    // курсор всё ещё внутри захваченного элемента (его дочки, чей title
    // снят, или предки с собственным title вроде заголовка секции) —
    // держим его подсказку, без перезахвата и дрожания
    if (tipTitleEl) {
      try { if (tipTitleEl.contains(t)) return; } catch (err) {}
    }
    const el = t && t.closest ? t.closest("[title]") : null;
    if (el === tipTitleEl) return;
    tipTitleRestore();
    hideTip();
    if (!el) return;
    if (el.closest && el.closest("[data-tip-native]")) return;
    const tx = el.getAttribute("title");
    if (!tx) return;
    tipTitleEl = el; tipTitleText = tx;
    try { el.removeAttribute("title"); } catch (err) {}
    showTip(e, tx);
  });
  document.addEventListener("mouseout", e => {
    if (!tipTitleEl) return;
    try { if (tipTitleEl.contains(e.relatedTarget)) return; } catch (err) {}
    tipTitleRestore();
    hideTip();
  });
} catch (e) {}

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
  $("#set-warmup-auto").checked = !!state.config.warmup_auto;
  $("#set-unpacked").value = state.config.unpacked_path || "";
  $("#set-mod-path").value = state.config.mod_path || "";
  $("#set-mod-assets").value = state.config.mod_assets_path || "";
  $("#set-mod-models").value = state.config.mod_models_path || "";
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
  syncPathClear();
  try { syncModSubClear(); } catch (e) {}
  if (tab) {
    const btn = document.querySelector('.settings-tabs .st-tab[data-st="' + tab + '"]');
    if (btn) btn.click();
    // вкладка обновлений: состояние с сервера свежее, чем в памяти —
    // кнопки скачать/установить видны только при реальном обновлении
    if (tab === "updates") { updStateLoad(); gaStateLoad(); }
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
  { id: "discord", url: "https://discord.com/invite/mNvUs8rRPS" },
];
const DONATE_URL = "https://dalink.to/hanigun";
const DISCORD_URL = "https://discord.com/invite/mNvUs8rRPS";
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

// отдельная модалка «Список изменений»: тот же mdRender, что и инлайн-бокс
// вкладки обновлений, но показывает весь changelog последнего релиза
// канала (updState.latest с сервера — есть, даже если версия уже стоит).
// Нет кэша (офлайн с пустым кэшем) — тихая принудительная проверка.
function updLatest() {
  if (!updState) return null;
  if (updState.latest && updState.latest.version) return updState.latest;
  const av = updState.available;
  if (av && av.version) return { version: av.version, notes: av.notes || "" };
  return null;
}

async function openChangelog() {
  $("#about-modal").hidden = true;
  if (!updState) await updStateLoad();
  let lat = updLatest();
  if (!lat || !lat.notes) {
    await updCheck(true, true);
    lat = updLatest();
  }
  const ver = (lat && lat.version) || (updState && updState.current) || "";
  $("#changelog-title").textContent =
    (t("upd_changelog") || "Список изменений") + (ver ? " " + ver : "");
  const body = $("#changelog-body");
  if (lat && lat.notes) body.innerHTML = mdRender(lat.notes);
  else body.innerHTML = "<p>" + escapeHtml(t("upd_no_notes") || "Список изменений пуст.") + "</p>";
  $("#changelog-modal").hidden = false;
}

// ---------- настройки: вкладки внутри модалки ----------
// строго в пределах своей модалки: иначе клик по вкладкам главных настроек
// гасил бы страницы настроек карты и наоборот
function setupSettingsTabs() {
  $$(".settings-tabs").forEach(bar => {
    const scope = bar.closest(".modal-card") || document;
    bar.querySelectorAll(".st-tab").forEach(b => {
      if (b.disabled) return; // вкладки в разработке: серые, не открываются
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
      <button class="btn sm hk-change"></button>
      <button class="icon-btn hk-reset" tabindex="-1">⟲</button>`;
    row.querySelector(".hk-edit-label").textContent = t(h.label) || h.id;
    // строки динамических кнопок — через словарь сразу при рендере:
    // applyI18n статичный DOM уже прошла, data-i18n здесь не сработает
    row.querySelector(".hk-change").textContent = t("hk_change") || "Изменить";
    row.querySelector(".hk-reset").title = t("hk_reset") || "Сбросить";
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
    warmup_auto: $("#set-warmup-auto").checked,
    mod_path: $("#set-mod-path").value.trim(),
    mod_assets_path: $("#set-mod-assets").value.trim(),
    mod_models_path: $("#set-mod-models").value.trim(),
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
  } else if (j.error === "bad_mod_structure" || j.error === "bad_overlay_structure") {
    // папка без структуры мода не принимается: объяснить попапом,
    // поля откатить к принятым значениям (бэкенд ничего не писал)
    if (typeof showModWarn === "function") showModWarn(j);
    if (typeof revertModPathFields === "function") revertModPathFields();
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
  // имена юнитов — на новом языке (проект+мод+игра+GameAssets), до
  // перерисовки грида: ячейки и чипы показывают их из state.nameMap
  try {
    if (state.project && state.project.root)
      await loadDisplayNames(state.project.root);
  } catch (e) { /* имена не критичны */ }
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
  if (state.tabs.some(tb => tb.id === "campaign")) {
    renderCampaign();
  }
  // страница сравнения: ключ-список и фильтры запекают строки при рендере —
  // без перерисовки остаются на старом языке до первого клика
  if (state.tabs.some(tb => tb.id === "compare")) {
    try { if (typeof renderKeyDropdown === "function") renderKeyDropdown(); } catch (e) {}
    try { if (typeof renderCompare === "function") renderCompare(); } catch (e) {}
  }
  // редактор горячих клавиш строится динамически — перерисовать под словарь
  // (модалка настроек со сменой языка открыта прямо сейчас)
  if (!$("#settings-modal").hidden) renderHotkeyEditor();
  nudgeRepaint();
  // заголовок сайдбара зависит от источника — обновить тоже
  paintTreeTitle();
}

// пути игры/мода в настройках изменились: сбросить кэш деревьев,
// подтянуть текущий источник и перекрасить все переключатели
async function refreshSrcPaths() {
  state.gameTree = null;
  state.modTree = null;
  try { syncInfoReset(); } catch (e) { /* грид ещё не готов */ }
  if (srcAvail("game")) await loadGameTree();
  if (srcAvail("mod")) await loadModTree();
  if (!srcAvail(state.treeView)) {
    const fb = srcFirst(null);
    if (fb) {
      state.treeView = fb;
      persistSrc(fb);
    }
  }
  state.treeCounts = null;
  const root = treeRoot();
  if (root) computeTreeCounts(root);
  paintTreeTitle();
  paintSrcSwitches(); // красит и стороны сравнения
  renderTree();
  // пути сменились/очистились — деревья уже снесены выше: кнопки карты/SWT
  // иначе остаются активными по протухшему состоянию («файлов нет, а горят»)
  updateToolButtons();
  updateSidebarVisibility();
  // корни локализации сменились — имена перезапросить фоном (проект+мод+игра)
  try {
    const pr = (state.project && state.project.root) || "";
    if (pr) loadDisplayNames(pr);
  } catch (e) { /* имена не критичны */ }
}

// пути настроек: [поле, крестик, источник closeTreeSource].
// Крестик виден только при указанном пути (syncPathClear).
const PATH_CLEAR_PAIRS = [
  ["set-project-path", "set-project-clear", "project"],
  ["set-unpacked", "set-unpacked-clear", "game"],
  ["set-mod-path", "set-mod-clear", "mod"],
];
function syncPathClear() {
  for (const [inp, btn] of PATH_CLEAR_PAIRS) {
    const i = $("#" + inp), b = $("#" + btn);
    if (i && b) b.hidden = !i.value.trim();
  }
}

// красный крестик: закрыть источник древа («project»/«game»/«mod»).
// Раньше жил только в сайдбаре и закрывал активный источник; крестики
// путей в настройках переиспользуют его же — иначе путь виден, но не
// отвязан (дерево/карта/кнопки живут по протухшему состоянию).
async function closeTreeSource(v) {
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
    // зеркало конфига: бэкенд уже потёр оба ключа (close_project),
    // без этого поле путей в настройках показывает удалённый проект
    state.config.project_path = "";
  }
  // древо переходит на первый доступный источник (закрытый уже выбыл:
  // путь отвязан, кэш дерева сброшен)
  const fb = srcFirst(null);
  if (fb) {
    state.treeView = fb;
    persistSrc(fb);
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
  try { syncInfoReset(); } catch (e) { /* грид ещё не готов */ }
  // карта жила внутри закрытого корня — снести, иначе фантом
  if (closedRoot && state.tabs.some(tb => tb.id === "uprising")
      && state.uprising.path) {
    const np = normPath(state.uprising.path).toLowerCase();
    const nr = normPath(closedRoot).toLowerCase();
    if (np === nr || np.startsWith(nr + "\\")) uprInvalidateSource();
  }
  // кампания — так же
  if (closedRoot && state.tabs.some(tb => tb.id === "campaign")
      && state.campaign.path) {
    const np = normPath(state.campaign.path).toLowerCase();
    const nr = normPath(closedRoot).toLowerCase();
    if (np === nr || np.startsWith(nr + "\\")) cmpInvalidateSource();
  }
  const tf = $("#tree-filter");
  if (tf) tf.value = "";
  hideTreeFilterMenu();
  updateSidebarVisibility();
}

// ---------- drag & drop ----------
// перетаскивание из Windows Explorer: WebView2 не отдаёт пути (только имена),
// поэтому имена сопоставляем с известными корнями через /api/resolve_drop,
// а mailbox бэкенда (второй инстанс/CLI) забираем через /api/pending_files.
async function handleExternalPaths(paths, dirs) {
  paths = paths || [];
  dirs = dirs || [];
  const openables = paths.filter(p => /\.(xml|swt|model)$/i.test(String(p || "")));
  if (!openables.length && !dirs.length) return;
  // папка = открыть как проект; файлы + папка: сначала проект, потом файлы
  if (dirs.length) await loadProject(dirs[0]);
  for (const p of openables) {
    // shop_presets.xml с рабочего стола — диспетч как в древе
    // (openShopPresets: sniff-счётчики + приоритет пути), иначе DLC-файл
    // уходил только в таблицу в обход дабл-клика
    const bn = String(p || "").split(/[\\/]/).pop() || "";
    if (/^shop_presets\.xml$/i.test(bn)) await openShopPresets(p);
    else await openFile(p);
  }
}

async function pollPendingFiles() {
  try {
    const r = await api("/api/pending_files");
    const j = await r.json();
    if (j && j.ok) {
      const files = j.files || [], ds = j.dirs || [];
      if (files.length || ds.length) {
        // нативный дроп (mailbox): спиннер поверх на время открытия
        const done = dndLock();
        try {
          await handleExternalPaths(files, ds);
        } finally {
          done();
        }
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
    // после серии доборов mailbox (нативный хук пишет туда асинхронно),
    // иначе ложно ругаемся на рабочий дроп
    const names = [];
    for (const f of dt.files) { if (f && f.name) names.push(f.name); }
    const un = (res && res.unknown && res.unknown.length)
      ? res.unknown.join(", ") : names.join(", ");
    setTimeout(async () => {
      for (const wait of [500, 800, 1000]) {
        await new Promise(r => setTimeout(r, wait));
        if (await pollPendingFiles()) return;
      }
      if (un) toast((t("drop_no_match") || "Не нашёл в проекте: ") + un, "warn");
    }, 300);
    return true;
  }
  return false;
}

// оверлей drag&drop: спиннер «Открываю…» на время обработки ПОСЛЕ броска.
// Подсказок при наведении нет: файл кидают в dropzone (у неё своя
// подсветка .drag), попап — только со спиннером, если открытие затянулось.
// dndLocks — счётчик вложенных обработок (JS-дроп и poll mailbox могут
// пересечься): прячем только когда закрылись все.
let dndLocks = 0;
// скрыть оверлей (вызывают dragleave/dragend/drop); во время открытия
// (dndLocks) не трогает — спиннер переживает движение мыши
function dndHint(show) {
  if (show) return; // наведение попапов не показывает
  const ov = $("#dnd-overlay");
  if (!ov || dndLocks) return;
  ov.hidden = true;
}
// спиннер «Открываю…» на время обработки; вернуть done() для закрытия.
// Показ с задержкой 400мс: быстрые открытия — без мигания попапом,
// долгие (распаковка-дерево, большой XML) — со спиннером.
function dndLock() {
  const ov = $("#dnd-overlay");
  dndLocks++;
  let timer = 0;
  if (ov) {
    const tx = $("#dnd-text");
    if (tx) tx.textContent = t("dnd_opening");
    timer = setTimeout(() => { if (dndLocks && ov) ov.hidden = false; }, 400);
  }
  return () => {
    dndLocks = Math.max(0, dndLocks - 1);
    if (timer) clearTimeout(timer);
    if (!dndLocks && ov) ov.hidden = true;
  };
}
async function handleDropWithOverlay(e, fromDropzone) {
  dndHint(false);
  const done = dndLock();
  try {
    await handleDropEvent(e, fromDropzone);
  } finally {
    done();
  }
}

function setupDnD() {
  const dz = $("#dropzone");
  ["dragover", "dragenter"].forEach(evt => dz.addEventListener(evt, e => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach(evt => dz.addEventListener(evt, e => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", e => {
    e.preventDefault();
    dz.classList.remove("drag");
    handleDropWithOverlay(e, true);
  });
  // документ-уровень: drop вне dropzone тоже открывает XML.
  // Наведение попапов НЕ показывает (файл кидают в dropzone, у неё своя
  // подсветка .drag): попап со спиннером — только после броска, если
  // открытие затянулось (dndLock с задержкой).
  ["dragover", "dragenter"].forEach(evt => document.addEventListener(evt, e => {
    e.preventDefault();
  }));
  document.addEventListener("dragleave", () => dndHint(false));
  document.addEventListener("drop", e => {
    if (e.target && e.target.closest && e.target.closest("#dropzone")) return;
    handleDropWithOverlay(e, false);
  });
  document.addEventListener("dragend", () => dndHint(false));
  // окно получает файлы второго запуска и нативный дроп (mailbox) каждую 1с:
  // пауза между броском и открытием — ожидание poll + openFile/loadProject
  setInterval(pollPendingFiles, 1000);
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

// минимальный markdown для changelog обновлений (текст релиза с сервера):
// сначала escape всего HTML (XSS из чужого текста не пройдёт), затем
// заголовки, списки, цитаты, hr, fence-блоки, `код`, **bold**, *italic*,
// [текст](url) и голые https://-ссылки. Ссылки открываются кликом через
// /api/open_link — бэкенд пропускает только свой allowlist.
function mdRender(src) {
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const t = esc(String(src || ""));
  // bold/italic — до ссылок: в plain-тексте тегов ещё нет, портить нечего
  const em = s => s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^_\n]+)_/g, "$1<em>$2</em>");
  // [текст](url), затем голые ссылки; lookbehind не даёт съесть URL
  // внутри только что созданного data-mdlink="..." и скобок [t](url)
  const rich = s => em(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      (m, txt, url) => '<a href="#" data-mdlink="' + url + '">' + txt + "</a>")
    .replace(/(?<![\"'=(\[>])(https?:\/\/[^\s<)\]]+)/g,
      (m, url) => '<a href="#" data-mdlink="' + url + '">' + url + "</a>");
  // `код` — через split: внутри кодовых кусков разметку не трогаем,
  // поэтому `*` и `_` в коде (и snake_case) никогда не ломаются
  const inline = s => s.split(/(`[^`\n]+`)/g).map((part, k) =>
    (k % 2) ? "<code>" + part.slice(1, -1) + "</code>" : rich(part)
  ).join("");
  const out = [];
  let para = [], list = null, quote = [], fence = null;
  const flushPara = () => {
    if (para.length) out.push("<p>" + para.map(inline).join("<br>") + "</p>");
    para = [];
  };
  const flushList = () => {
    if (list) out.push("<" + list.tag + ">"
      + list.items.map(i => "<li>" + inline(i) + "</li>").join("")
      + "</" + list.tag + ">");
    list = null;
  };
  const flushQuote = () => {
    if (quote.length)
      out.push("<blockquote>" + quote.map(inline).join("<br>") + "</blockquote>");
    quote = [];
  };
  for (const line of t.split("\n")) {
    if (/^```/.test(line)) {
      if (fence === null) { flushPara(); flushList(); flushQuote(); fence = []; }
      else { out.push("<pre><code>" + fence.join("\n") + "</code></pre>"); fence = null; }
      continue;
    }
    if (fence !== null) { fence.push(line); continue; }
    let m;
    if ((m = /^(#{1,4})\s+(.*)/.exec(line))) {
      flushPara(); flushList(); flushQuote();
      const h = m[1].length + 3; // # -> h4: в боксе 180px крупные кегли ни к чему
      out.push("<h" + h + ">" + inline(m[2]) + "</h" + h + ">");
    }
    else if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      flushPara(); flushList(); flushQuote();
      out.push("<hr>");
    }
    else if ((m = /^\s*[-*]\s+(.*)/.exec(line))) {
      flushPara(); flushQuote();
      if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; }
      list.items.push(m[1]);
    }
    else if ((m = /^\s*\d+[.)]\s+(.*)/.exec(line))) {
      flushPara(); flushQuote();
      if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; }
      list.items.push(m[1]);
    }
    else if ((m = /^\s*&gt;\s?(.*)/.exec(line))) { // > уже &gt; после escape
      flushPara(); flushList();
      quote.push(m[1]);
    }
    else if (!line.trim()) { flushPara(); flushList(); flushQuote(); }
    else para.push(line);
  }
  if (fence !== null) // незакрытый fence — тоже кодом, текст не теряем
    out.push("<pre><code>" + fence.join("\n") + "</code></pre>");
  flushPara(); flushList(); flushQuote();
  return out.join("");
}

// вкладка обновлений в настройках: changelog прямо в окне (со скроллом),
// кнопки скачивания и подсказка про перезапуск
function updPaintInline() {
  const avail = updState && updState.available;
  const pend = updState && updState.pending;
  const notes = $("#upd-notes");
  if (notes) {
    notes.innerHTML = mdRender((avail && avail.notes) || "");
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
    // пояс для класса settings-actions (display:flex бьёт hidden):
    // кнопки прячем и по отдельности, только обновление их показывает
    if (dl) dl.hidden = true;
    if (inst) inst.hidden = true;
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

// guard перед установкой обновления: процесс выходит сразу после ответа
// (os._exit), и несохранённые вкладки сгорели бы вместе с ним. Собираем
// dirty (файловые вкладки + SWT + Uprising) и предлагаем: сохранить всё
// и продолжить, продолжить без сохранения или отменить установку.
function updDirtyList() {
  const out = [];
  (state.tabs || []).forEach(tb => {
    if (tb.dirty && tb.type === "file" && tb.path)
      out.push({ kind: "file", label: tb.title || tb.path, path: tb.path });
  });
  if (state.swt && state.swt.dirty && state.swt.path)
    out.push({ kind: "swt",
      label: "SWT: " + String(state.swt.path).split(/[\\/]/).pop() });
  if (state.uprising && state.uprising.dirty && state.uprising.path)
    out.push({ kind: "uprising",
      label: "Uprising: " + String(state.uprising.path).split(/[\\/]/).pop() });
  return out;
}

async function updSaveAllDirty() {
  for (const tb of (state.tabs || [])) {
    if (!(tb.dirty && tb.type === "file" && tb.path)) continue;
    try {
      const sr = await api("/api/save", { method: "POST",
        body: JSON.stringify({ path: tb.path }) });
      const sj = await sr.json();
      if (sj && sj.ok) {
        tb.dirty = false;
        if (sj.saved) noteSaved(tb.path);
      }
    } catch (e) { /* остаток покажет пересчёт ниже */ }
  }
  try { if (state.swt && state.swt.dirty) await swtSaveGuarded(false); }
  catch (e) { /* остаток покажет пересчёт ниже */ }
  try { if (state.uprising && state.uprising.dirty) await uprSaveGuarded(false); }
  catch (e) { /* остаток покажет пересчёт ниже */ }
  updateDirty();
  renderTabBar();
  return updDirtyList();
}

async function updInstall() {
  const inst = $("#upd-install");
  if (inst) inst.disabled = true;
  updRestarted = false;
  try {
    const dirty = updDirtyList();
    if (dirty.length) {
      const names = dirty.map(d => d.label).join(", ");
      const choice = await askConfirm({
        title: t("unsaved_changes"),
        message: (t("upd_dirty_confirm") ||
          "Несохранённые изменения будут потеряны при перезапуске. Установить обновление сейчас?") +
          " (" + names + ")",
        buttons: [
          { id: "save", label: t("upd_save_install") || "Сохранить и установить" },
          { id: "discard", label: t("upd_nosave_install") || "Установить без сохранения", kind: "danger" },
          { id: "cancel", label: t("cancel"), kind: "ghost" },
        ],
      });
      if (choice === "cancel") return;
      if (choice === "save") {
        const rest = await updSaveAllDirty();
        if (rest.length) {
          toast((t("upd_save_failed") ||
            "Не всё удалось сохранить — установка отменена") +
            " (" + rest.map(d => d.label).join(", ") + ")", "err");
          return;
        }
      }
    }
    toast(t("upd_applying") || "Applying update…", "ok");
    await updDoRestart();
  } finally {
    if (inst) inst.disabled = false;
  }
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
  // ссылки из markdown-changelog: клик уходит в /api/open_link
  // (не-allowlist бэкенд режет сам — см. _OPEN_LINK_ALLOW в shell.py).
  // Обработчик общий: и инлайн-бокс вкладки обновлений, и отдельная
  // модалка «Список изменений» рендерятся тем же mdRender.
  const mdLinkClick = e => {
    const a = e.target && e.target.closest
      ? e.target.closest("a[data-mdlink]") : null;
    if (!a) return;
    e.preventDefault();
    api("/api/open_link", { method: "POST",
      body: JSON.stringify({ url: a.getAttribute("data-mdlink") }) });
  };
  const un = $("#upd-notes");
  if (un) un.onclick = mdLinkClick;
  const clb = $("#changelog-body");
  if (clb) clb.onclick = mdLinkClick;
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
  const aboutL = $("#about-changelog");
  if (aboutL) aboutL.onclick = () => openChangelog();
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

// ---------- GameAssets: скачивание архива из релиза ----------
// Только попап кнопки в шапке (в настройки ничего не добавляем);
// зелёная точка — архив скачан и распакован.
let gaState = null;
let gaPollTimer = null;
let gaRunTs = 0;

async function gaStateLoad() {
  try {
    const r = await api("/api/game_assets_state");
    const j = await r.json();
    if (j && j.ok) gaState = j;
  } catch (e) { /* офлайн на старте: молча */ }
  gaPaint();
  return gaState;
}

function gaPaint() {
  const done = !!(gaState && gaState.downloaded == 1 && gaState.has_dir);
  const dot = $("#btn-gameassets-dot");
  if (dot) dot.hidden = !done;
  // попап открыт — перерисовать (состояние/прогресс могли смениться)
  const p = $("#ga-pop");
  if (p && !p.hidden) gaPopRender();
}

// собственный выпадающий попап кнопки (не настройки): состояние, мини-план
// с чипами состава и мини-прогресс распаковки
function gaPopEl() {
  let p = $("#ga-pop");
  if (p) return p;
  p = document.createElement("div");
  p.id = "ga-pop";
  p.className = "ga-pop";
  p.hidden = true;
  document.body.appendChild(p);
  return p;
}

function gaToggle() {
  const p = gaPopEl();
  if (!p.hidden) { p.hidden = true; return; }
  const b = $("#btn-gameassets");
  if (b) {
    const r = b.getBoundingClientRect();
    p.style.top = (r.bottom + 8) + "px";
    p.style.right = Math.max(8, window.innerWidth - r.right) + "px";
  }
  p.hidden = false;
  gaPopRender();
}

function gaPopRender() {
  const p = gaPopEl();
  const ready = !!(gaState && gaState.downloaded == 1 && gaState.has_dir);
  const prog = (gaState && gaState.progress) || {};
  let h = '<div class="ga-pop-title">' + escapeHtml(t("ga_title") || "GameAssets") + "</div>"
    + '<div class="ga-note">' + escapeHtml(t("ga_hint") || "") + "</div>"
    + '<div class="ga-pop-state" id="gap-state">' + escapeHtml(gaPopStateText()) + "</div>"
    + '<div class="upd-progress" id="gap-progress" hidden>'
    + '<div class="upd-bar"><div class="upd-fill" id="gap-fill"></div></div>'
    + '<div class="upd-pct" id="gap-pct"></div></div>'
    + '<div class="ga-pop-row"><button class="btn accent" id="gap-dl">'
    + escapeHtml(t(ready ? "ga_redownload" : "ga_download") || "") + "</button></div>";
  p.innerHTML = h;
  const dl = $("#gap-dl");
  if (dl) dl.onclick = gaDownload;
  if (prog.state === "checking" || prog.state === "downloading"
    || prog.state === "extracting") gaPollStart();
}

// строка состояния в попапе: версия скачанного или текст ошибки
function gaPopStateText() {
  if (!gaState) return "";
  if (gaState.downloaded == 1 && gaState.has_dir)
    return (t("ga_downloaded") || "Done")
      + (gaState.version ? " " + gaState.version : "");
  const pr = gaState.progress || {};
  if (pr.state === "error" && pr.error) return pr.error;
  return "";
}

async function gaDownload() {
  const dl = $("#gap-dl");
  if (dl) dl.disabled = true;
  const st = $("#gap-state");
  if (st) st.textContent = t("ga_checking") || "…";
  let j = null;
  try {
    const r = await api("/api/game_assets_download", { method: "POST",
      body: JSON.stringify({}) });
    j = await r.json();
  } catch (e) { j = null; }
  if (!j || !j.ok) {
    toast((j && j.error) || (t("ga_not_found") || "error"), "err");
    if (st) st.textContent = (j && j.error) || "";
    if (dl) dl.disabled = false;
    return;
  }
  // POST вернулся сразу — бар показываем тут же (сначала крутится
  // на проверке, затем живые проценты из polling)
  gaRunTs = Date.now();
  gaShowBusy();
  gaPollStart();
}

// бар в режиме ожидания: виден сразу, полоска бежит (фаза проверки)
function gaShowBusy() {
  const bar = $("#gap-progress"), fill = $("#gap-fill"), pct = $("#gap-pct");
  const st = $("#gap-state");
  if (bar) bar.hidden = false;
  if (fill) { fill.style.width = "100%"; fill.classList.add("indet"); }
  const txt = t("ga_checking") || "…";
  if (pct) pct.textContent = txt;
  if (st) st.textContent = txt;
}

function gaPollStart() {
  gaPollStop();
  gaPollTick();
  gaPollTimer = setInterval(gaPollTick, 600);
}

function gaPollStop() {
  if (gaPollTimer) { clearInterval(gaPollTimer); gaPollTimer = null; }
}

async function gaPollTick() {
  let j = null;
  try {
    const r = await api("/api/game_assets_progress");
    j = await r.json();
  } catch (e) { return; }
  const pr = j && j.progress;
  if (!pr) return;
  if (gaState) gaState.progress = pr;
  // попап перерисовали без нас (элементов нет) — пересобрать из свежего
  // состояния, иначе анимация крутится без живого polling
  const pop = $("#ga-pop");
  if (pop && !pop.hidden && !$("#gap-fill")) gaPopRender();
  const bar = $("#gap-progress"), fill = $("#gap-fill"), pct = $("#gap-pct");
  const st = $("#gap-state"), dlb = $("#gap-dl");
  if (pr.state === "checking") {
    if (gaRunTs && Date.now() - gaRunTs > 45000) {
      // бэкенд держит проверку ≤25с: дольше — зависший процесс,
      // показываем ошибку и отдаём кнопку вместо вечной анимации
      gaPollStop();
      gaRunTs = 0;
      const stuck = t("ga_stuck") || "stuck";
      toast(stuck, "err");
      if (bar) bar.hidden = true;
      if (st) st.textContent = stuck;
      if (dlb) dlb.disabled = false;
      return;
    }
    // проверка воркера: реальные проценты ещё неизвестны — полоска бежит
    if (bar) bar.hidden = false;
    if (fill) { fill.style.width = "100%"; fill.classList.add("indet"); }
    const txt = t("ga_checking") || "…";
    if (pct) pct.textContent = txt;
    if (st) st.textContent = txt;
  } else if (pr.state === "downloading" || pr.state === "extracting") {
    if (bar) bar.hidden = false;
    if (fill) fill.classList.remove("indet");
    const total = pr.total || 0, done = pr.done || 0;
    const pc = total > 0 ? Math.min(99, Math.floor(done * 100 / total)) : 0;
    if (fill) fill.style.width = (pr.state === "extracting" ? 100 : pc) + "%";
    const txt = pr.state === "extracting"
      ? (t("ga_extracting") || "…")
      : (t("ga_downloading") || "…") + " " + pc + "%";
    if (pct) pct.textContent = txt;
    if (st) st.textContent = txt;
  } else if (pr.state === "done") {
    gaPollStop();
    gaRunTs = 0;
    if (bar) bar.hidden = true;
    toast(t("ga_downloaded") || "Done", "ok");
    await gaStateLoad();
  } else if (pr.state === "error") {
    gaPollStop();
    gaRunTs = 0;
    if (bar) bar.hidden = true;
    toast(pr.error || "error", "err");
    if (st) st.textContent = pr.error || "";
    if (dlb) dlb.disabled = false;
  }
}

function gaSetup() {
  const b = $("#btn-gameassets");
  if (b) b.onclick = e => {
    if (e) e.stopPropagation();
    gaToggle();
  };
  try {
    document.addEventListener("click", e => {
      const p = $("#ga-pop");
      if (p && !p.hidden && !p.contains(e.target)
        && !(e.target.closest && e.target.closest("#btn-gameassets")))
        p.hidden = true;
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        const p = $("#ga-pop");
        if (p && !p.hidden) p.hidden = true;
      }
    });
  } catch (e) { /* noop */ }
}

