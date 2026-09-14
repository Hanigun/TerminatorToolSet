/* TerminatorToolSet frontend — tree.js: источники Проект/Игра/Мод, дерево, фильтры, edited-метки, fs-операции
   Вырезано из app.js без изменений логики. Классические скрипты,
   общий глобальный скоуп, порядок загрузки — FILES в templates/index.html. */
// ---------- tree filters (compact dropdown over the full project tree) ----------
// Древо уже приходит обрезанным с бэкенда (walk_tree: 5 уровней папок —
// хватает на DLC-оверлеи dlc/<Имя>/basis/... — только TREE_KEEP_EXTS) —
// меню фильтров показывает ровно это: расширения xml+swt, папки в пределах
// 5 уровней. Правило ADR-001 §14: поддержка нового расширения = добавить
// его в TREE_KEEP_EXTS бэкенда И в exts ниже.
const TREE_FILTER_DEFAULTS = { exts: ["xml", "swt"], folders: ["scripts", "spawns"] };
const TREE_EDITABLE_EXTS = new Set(["xml"]);
const TREE_MATCH_CAP = 400;
const TREE_RENDER_CHUNK = 250;
const TREE_DIR_ICONS = {
  scripts: ["folder_scripts.svg", "folder_scripts__open.svg"],
  basis: ["folder_home.svg", "folder_home__open.svg"],
  species: ["folder_robot.svg", "folder_robot__open.svg"],
  spawns: ["folder_database.svg", "folder_database__open.svg"],
  animations: ["folder_animation.svg", "folder_animation__open.svg"],
  audio: ["folder_audio.svg", "folder_audio__open.svg"],
  sound: ["folder_audio.svg", "folder_audio__open.svg"],
  sounds: ["folder_audio.svg", "folder_audio__open.svg"],
  images: ["folder_images.svg", "folder_images__open.svg"],
  textures: ["folder_images.svg", "folder_images__open.svg"],
};

// unit-sheet categories: inside species-like folders the raw xml list is
// regrouped into labeled subsections (Отряды / Машины / Танки / Вооружение…).
// Order defines display order; groups only appear for files actually
// present in the opened project.
const TREE_CATEGORIES = [
  // humans.xml живёт в «Отрядах»: отдельный раздел «Пехота» убран, один
  // боец без отряда в игре не встречается
  { key: "squads", icon: "command.svg", match: n => n === "squads.xml" || n === "humans.xml" || n === "infantry_preview_config.xml" },
  { key: "squad_upgrades", icon: "renovate.svg", match: n => n.startsWith("squad_") || n === "infantry_training.xml" },
  { key: "cars", icon: "cargo.svg", match: n => n === "cars.xml" },
  { key: "car_upgrades", icon: "renovate.svg", match: n => n.startsWith("car_") },
  { key: "tanks", icon: "sentry.svg", match: n => n === "tanks.xml" },
  { key: "tank_upgrades", icon: "renovate.svg", match: n => n.startsWith("tank_") },
  { key: "helicopters", icon: "velocity.svg", match: n => n === "helicopters.xml" },
  { key: "heli_upgrades", icon: "renovate.svg", match: n => n.startsWith("heli_") },
  // авиация: сами самолёты и вызовы авиаударов одним разделом
  { key: "airplanes", icon: "velocity.svg", match: n => n === "airplanes.xml" || n === "airstrikes.xml" },
  // «Вооружение»: стволы, крепления, слоты, ракеты и боеприпасы одним разделом
  { key: "guns", icon: "dart.svg", match: n => n === "guns.xml" || n === "gun_mounts.xml" || n === "weapon_slots.xml" || n === "missiles.xml" || n === "ammunition.xml" },
  { key: "modules", icon: "lib.svg", match: n => n === "modules.xml" },
  { key: "animations", icon: "lottie.svg", match: n => n === "animations.xml" || n.startsWith("animations_") },
  { key: "inventory", icon: "package_json.svg", match: n => n === "inventory_items.xml" },
  { key: "exp", icon: "chart.svg", match: n => n === "exp.xml" },
  { key: "reinforcements", icon: "nest.svg", match: n => n === "reinforcements.xml" },
  { key: "spawns_sheet", icon: "spreadsheet.svg", match: n => n === "spawns_sheet.xml" },
  // shop_presets.xml делится ПО РАСПОЛОЖЕНИЮ: базовый файл (магазины
  // кампании) и dlc-файл (награды Uprising) — разные подразделы.
  // match получает вторым аргументом путь папки (см. categorizeNodeFiles).
  { key: "shop_campaign", icon: "database.svg", match: (n, p) => n === "shop_presets.xml" && !/(^|[\\/])dlc([\\/]|$)/i.test(p || "") },
  { key: "shop_uprising", icon: "database.svg", match: (n, p) => n === "shop_presets.xml" && /(^|[\\/])dlc([\\/]|$)/i.test(p || "") },
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
  // миграция старых дефолтов: они прятали часть файлов (.swt-сценарии,
  // потом .set без открывалки) или их уже нет в обрезанном дереве;
  // пользователь их не выбирал осознанно - заменяем новыми
  if (saved && !forceDefaults) {
    const norm = o => JSON.stringify({
      exts: o.exts == null ? o.exts : [...o.exts].map(x => String(x).toLowerCase()).sort(),
      folders: o.folders == null ? o.folders : [...o.folders].map(x => String(x).toLowerCase()).sort(),
    });
    const olds = [
      { exts: ["xml"], folders: ["scripts"] },
      { exts: ["xml", "swt", "set"], folders: ["scripts", "spawns"] },
    ].map(norm);
    if (olds.includes(norm(saved))) saved = null;
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

// спиннер древа — ПОИСТОЧНИКОВО: project/game/mod грузятся параллельно,
// общий счётчик зажигал спиннер игры поверх чужого древа. Виден только
// если грузится ТЕКУЩИЙ источник; остальные догружаются молча в фоне.
const treeLoading = new Set();
function setTreeLoading(src, on) {
  if (!src) return;
  if (on) treeLoading.add(src);
  else treeLoading.delete(src);
  paintTreeSpinner();
}
function paintTreeSpinner() {
  const el = $("#tree-loading");
  if (el) el.hidden = !treeLoading.has(state.treeView);
}

async function loadFullTree() {
  state.fullTree = null;
  state.fullTreeExpanded = new Set();
  state.fullTreeCollapsed = new Set();
  state.treeCounts = null;
  setTreeLoading("project", true);
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
  finally { setTreeLoading("project", false); }
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
// Uprising Map Editor и Редактор Компании — когда хоть в одном источнике
// есть shop_presets.xml, SWT Editor — когда есть .swt файлы.
function updateToolButtons() {
  const trees = [state.fullTree, state.gameTree, state.modTree];
  const hasUpr = trees.some(tr => treeHasFile(tr,
    fn => fn.toLowerCase() === "shop_presets.xml"));
  const hasSwt = trees.some(tr => treeHasFile(tr,
    fn => fn.toLowerCase().endsWith(".swt")));
  for (const id of ["#btn-uprising", "#landing-uprising", "#btn-campaign", "#landing-campaign"]) {
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

function categorizeNodeFiles(files, dirPath) {
  // returns category groups for a folder's file list, or null when nothing
  // matches a known unit-sheet file (random dirs stay ungrouped).
  // dirPath lets some categories split by location (shop_presets:
  // base file = Campaign Shop, dlc file = Uprising Shop).
  if (!files || !files.length) return null;
  const lower = files.map(f => f.toLowerCase());
  const hit = i => TREE_CATEGORIES.find(c => c.match(lower[i], dirPath));
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
    // вид «Мод» часто указывает на общую папку mods: верхний уровень —
    // отдельные моды, подпись секции — «Папка мода»/Mods, не «Base game»
    const basisLabel = tv.view === "mod"
      ? (t("overlay_mods") || "Mods")
      : isGame ? (rootName || (t("overlay_basis") || "Компания"))
               : (t("overlay_basis") || "Компания");
    sections.push({
      key: keyPfx + "basis",
      label: basisLabel,
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
    const cats = state.treeFilter ? null : categorizeNodeFiles(node._fl || [], path);
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

function appendTreeRows(container, rows, onDone, onStep) {
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
    // чанки дорисовываются кадрами: контент растёт сверху вниз, и без
    // возврата позиции вьюпорт болтается — держим её после каждого чанка
    if (onStep) onStep();
    if (i < rows.length) requestAnimationFrame(step);
    else if (onDone) onDone();
  };
  if (rows.length) requestAnimationFrame(step);
  else if (onDone) onDone();
}

// верхние папки вида «Мод» — отдельные моды в общей папке mods:
// иконка пакета из темы вместо обычной папки; глубже — обычные иконки
const MOD_TOP_ICON = ["folder_packages.svg", "folder_packages__open.svg"];
function modTopIcon(expanded) {
  const fn = MOD_TOP_ICON[expanded ? 1 : 0];
  return ICON_MAP[fn] || (ICON_BASE + fn);
}

function buildTreeDirRow(dir, depth, path, expanded) {
  const row = document.createElement("div");
  row.className = "tree-dir" + (expanded ? " expanded" : "");
  row.dataset.path = path;
  row.style.paddingLeft = treeIndent(depth) + "px";
  row.draggable = true;
  row.title = path;
  const iconSrc = (depth === 1 && state.treeView === "mod")
    ? modTopIcon(expanded)
    : dirIcon(dir.n, expanded);
  row.innerHTML = `
    <svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>
    <img class="file-icon" src="${iconSrc}" alt="">
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

// дабл-клик по shop_presets.xml: работают ОБА сигнала — проверка
// содержимого (счётчики sector/shop из /api/uprising_sniff) и приоритет
// пути (очевидный dlc-путь → карта, остальное → кампания). Путь сам
// ничего не решает: чисто секторный откроется картой из любого места
// (хоть с рабочего стола), чисто магазинный — кампанией из любой
// dlc-папки. Смешанный файл (есть и те, и другие строки) и ошибка чтения —
// решает приоритет пути. Сырая таблица — через «Открыть в таблице» из шапки.
async function openShopPresets(path) {
  const dlcPath = /(^|[\\/])dlc([\\/]|$)/i.test(String(path || ""));
  let toMap = dlcPath; // приоритет пути — стартовое значение
  try {
    const r = await api("/api/uprising_sniff", { method: "POST",
      body: JSON.stringify({ path }) });
    const j = await r.json();
    if (j && j.ok) {
      const sector = +j.sector || 0, shop = +j.shop || 0;
      if (j.uprising && !shop) toMap = true; // чисто секторный → карта
      else if (!sector) toMap = false; // секторов нет → кампания
      // смешанный: остаётся приоритет пути
    }
  } catch (e) { /* ниже — приоритет пути */ }
  if (toMap) { openUprising(path); return; }
  if (typeof openCampaign === "function") openCampaign(path);
  else openFile(path);
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
  // несохранённые правки — зелёная метка сразу, не после сохранения:
  // все редакторы (таблица, карта, кампания, SWT) идут через tab.dirty /
  // state.*.dirty, paintTreeDirty обновляет без ререндера
  if (treeFileDirty(path)) {
    row.classList.add("dirty");
    row.title = (t("unsaved") || "Есть несохранённые изменения") + "\n" + path;
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
    // shop_presets.xml — карта Uprising или редактор кампании: чистое
    // содержимое решает само (секторы → карта, магазины → кампания),
    // смешанный файл — приоритет пути (dlc → карта, база → кампания)
    else if (/^shop_presets\.xml$/i.test(fname)) openShopPresets(path);
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
  // «Проект» доступен и до конца фоновой загрузки (init/loadProject):
  // путь прошлого запуска уже в конфиге, state.project.root приедет позже.
  // Без этого сегмент «Проект» на сравнении нельзя выбрать, а сохранённые
  // стороны и зеркало («Аналогичный файл») молча отваливаются именно для
  // проекта, хотя для игры (путь из конфига сразу) всё работает.
  if (v === "project") return !!((state.project && state.project.root)
    || (state.config && (state.config.project_path || state.config.last_project)) || "");
  if (v === "game") return !!((state.config && state.config.unpacked_path) || "");
  if (v === "mod") return !!((state.config && state.config.mod_path) || "");
  return false;
}

function srcRoot(v) {
  if (v === "game") return ((state.config && state.config.unpacked_path) || "");
  if (v === "mod") return ((state.config && state.config.mod_path) || "");
  return ((state.project && state.project.root)
    || (state.config && (state.config.project_path || state.config.last_project)) || "");
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

async function loadGameTree(force) {
  if (state.gameTree && !force) return;
  state.gameTree = { n: "", d: [], f: [] };
  setTreeLoading("game", true);
  try {
    const r = await api("/api/game_tree", { timeout: API_TIMEOUT_OPEN });
    const j = await r.json();
    if (j.ok && j.tree) state.gameTree = j.tree;
  } catch (e) { /* остаётся пустое дерево */ }
  finally { setTreeLoading("game", false); updateToolButtons(); }
}

async function loadModTree(force) {
  if (state.modTree && !force) return;
  state.modTree = { n: "", d: [], f: [] };
  setTreeLoading("mod", true);
  try {
    const r = await api("/api/mod_tree", { timeout: API_TIMEOUT_OPEN });
    const j = await r.json();
    if (j.ok && j.tree) state.modTree = j.tree;
  } catch (e) { /* остаётся пустое дерево */ }
  finally { setTreeLoading("mod", false); updateToolButtons(); }
}

// дерево не знает о файлах, созданных мимо скана (save_as из игры в
// проект/мод, «скопировать в проект/мод»): после таких операций снапшот
// источника устаревает — новый раздел (напр. dlc/) не появляется, пока
// проект не переподключат. Перечитываем нужное дерево и перерисовываем.
async function noteExternalTreeChange(target) {
  try {
    if (target === "mod") {
      state.modTree = null;   // loadModTree иначе вернёт закэшированное
      if (srcAvail("mod")) await loadModTree();
    } else if (state.project && state.project.root) {
      await loadFullTree();
    }
  } catch (e) { /* дерево не критично для сейва */ }
  try { renderTree(); } catch (e) { /* noop */ }
  // свои же изменения — в базу вотчера, чтобы его тик не перечитывал
  // то же дерево повторно
  try { await syncTreeWatch(); } catch (e) { /* noop */ }
}

// ---------- внешний вотчер деревьев (бэкенд TreeWatch) ----------
// Фронт опрашивает /api/tree_watch и перечитывает ТОЛЬКО изменившееся
// дерево; чужие поколения гасят кэш, чтобы переключение вида не показывало
// протухшее. Первый тик — только синхронизация базы (без перезагрузок).
// Развёртки папок/секций сохраняем — фоновая подтяжка не должна схлопывать
// дерево, которое пользователь только что раскрыл.
let treeWatchTimer = null;
async function treeWatchTick() {
  try {
    if (document.hidden) return;
    const r = await api("/api/tree_watch");
    const j = await r.json();
    if (!j || !j.ok) return;
    state.treeWatch = state.treeWatch || { gens: {}, synced: false };
    const tw = state.treeWatch;
    if (!tw.synced) { tw.gens = Object.assign({}, j.roots); tw.synced = true; return; }
    for (const role of ["project", "game", "mod"]) {
      const gen = (j.roots && j.roots[role]) || 0;
      if ((tw.gens[role] || 0) >= gen) continue;
      tw.gens[role] = gen;
      if (state.treeView === role) {
        const keepE = state.fullTreeExpanded, keepC = state.fullTreeCollapsed,
          keepT = state.treeCollapsed;
        if (role === "project") await loadFullTree();
        else if (role === "game") await loadGameTree(true);
        else await loadModTree(true);
        if (keepE) state.fullTreeExpanded = keepE;
        if (keepC) state.fullTreeCollapsed = keepC;
        if (keepT) state.treeCollapsed = keepT;
        renderTree();
      } else if (role === "game") state.gameTree = null;
      else if (role === "mod") state.modTree = null;
    }
  } catch (e) { /* следующий тик */ }
}
// точечная синхронизация базы вотчера без перезагрузок
async function syncTreeWatch() {
  try {
    const r = await api("/api/tree_watch");
    const j = await r.json();
    if (j && j.ok) {
      state.treeWatch = state.treeWatch || { gens: {}, synced: false };
      state.treeWatch.gens = Object.assign({}, j.roots);
      state.treeWatch.synced = true;
    }
  } catch (e) { /* noop */ }
}
function ensureTreeWatch() {
  if (treeWatchTimer) return;
  treeWatchTimer = setInterval(treeWatchTick, 4000);
}
// «Пересканировать»: бэкенд роняет базы и поднимает все поколения,
// фронт принудительно перечитывает все три дерева
async function rescanAllTrees(btn) {
  if (rescanAllTrees.busy) return;
  rescanAllTrees.busy = true;
  if (btn) btn.disabled = true;
  try {
    const r = await api("/api/tree_rescan", { method: "POST" });
    const j = await r.json();
    if (j && j.ok) {
      state.treeWatch = { gens: Object.assign({}, j.roots), synced: true };
      await loadFullTree().catch(() => {});
      if (srcAvail("game")) await loadGameTree(true).catch(() => {});
      if (srcAvail("mod")) await loadModTree(true).catch(() => {});
      renderTree();
      toast(t("tree_rescanned") || "Деревья пересканированы", "ok");
    } else toast((j && j.error) || "error", "err");
  } catch (e) { toast(String((e && e.message) || e), "err"); }
  finally { rescanAllTrees.busy = false; if (btn) btn.disabled = false; }
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

// персист глобального источника: localStorage живёт один запуск
// (origin включает случайный порт сервера), межзапусковое —
// config.json (tree_view) через /api/config; пишем в оба сразу
function persistSrc(v) {
  try { localStorage.setItem("tsh_src", v); } catch (e) { /* приватный режим */ }
  try {
    api("/api/config", { method: "POST", body: JSON.stringify({ tree_view: v }) })
      .catch(() => {});
  } catch (e) { /* оффлайн */ }
}
// смена глобального источника: древо + переключатели + карта (с confirm при грязной карте)
async function setSrc(v) {
  if (!srcAvail(v)) return;
  if (state.treeView === v) { paintSrcSwitches(); paintTreeSpinner(); return; }
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
  persistSrc(v);
  // спиннер — только своего источника: переключение сразу перекрашивает,
  // фоновая догрузка чужого древа видна не будет
  paintTreeSpinner();
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
    // stale-оверлей («открыть проект» от прошлого источника) гаснет в тот же
    // тик: дальше find+load могут ждать GIL десятки секунд, и висеть должен
    // спиннер загрузки, а не старый текст
    try { uprSetLoading(true); } catch (e) { /* карта ещё не строилась */ }
    const path = await uprFindFile();
    state.uprising.path = "";
    state.uprising.rows = null;
    if (path) await openUprising(path, { activate: false });
    else { try { uprSetLoading(false); } catch (e) {} uprPaintNofile(); }
    uprLoadSysnames();
  }
  // редактор кампании — так же фоном из нового корня
  if (state.tabs.some(tb => tb.id === "campaign")) {
    if (state.campaign.path && state.campaign.rows && state.campaign.dirty) {
      const choice = await askConfirm({
        title: t("upr_src_change") || "Сменить источник",
        message: t("cpg_src_dirty") ||
          "Несохранённые изменения кампании будут потеряны. Продолжить?",
        buttons: [
          { id: "ok", label: t("continue") || "Продолжить", kind: "danger" },
          { id: "cancel", label: t("cancel"), kind: "ghost" },
        ],
      });
      if (choice !== "ok") { paintSrcSwitches(); return; }
    }
    state.campaign.dirty = false;
    const path = await cmpFindFile();
    state.campaign.path = "";
    state.campaign.rows = null;
    if (path) await openCampaign(path, { activate: false });
    else cmpPaintNofile();
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
  // сегменты Проект|Игра|Мод на страницах (карта #upr-src + кампания
  // #cmp-src): недоступные пункты темнеют (кнопка is-off), индикатор едет.
  // is-off вместо disabled: серая кнопка кликабельна и ведёт в настройки
  // (нативный disabled гасит клики — до настроек было не добраться).
  // unavailable current source -> no active button and no yellow pill
  // (иначе «Проект» подсвечен по умолчанию даже без пути)
  const paintSeg = (sel) => {
    const seg = $(sel);
    if (!seg) return;
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
  };
  paintSeg("#upr-src");
  paintSeg("#cmp-src");
  paintCmpSrc();
}

function updateSidebarTabs() {
  paintTreeTitle();
  paintSrcSwitches();
}

function renderTree() {
  const tree = $("#project-tree");
  // скроллится сам сайдбар: innerHTML схлопывает высоту контента и браузер
  // клэмпит его scrollTop к нулю — после разворота папки древо оказывалось
  // наверху. Запоминаем позицию и возвращаем после дорисовки всех чанков.
  const sidebar = $("#sidebar");
  const keepScroll = sidebar ? sidebar.scrollTop : 0;
  const renderDone = (msg) => {
    if (sidebar) sidebar.scrollTop = keepScroll;
    paintTreeDirty();
    if (msg) {
      const el = document.createElement("div");
      el.className = "tree-empty";
      el.textContent = msg;
      tree.appendChild(el);
    }
  };
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
  appendTreeRows(tree, rows, () => renderDone(msg || null),
    () => { if (sidebar) sidebar.scrollTop = keepScroll; });
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

// Глобальная зелёная метка несохранённых правок на узле древа: собирает
// dirty-пути из ВСЕХ редакторов (таблица/карта/кампания/SWT через табы +
// state-флаги) и переключает класс без ререндера древа
function treeDirtyPaths() {
  const out = new Set();
  const add = p => {
    if (!p) return;
    try { out.add(normPath(p)); } catch (e) { /* noop */ }
  };
  (state.tabs || []).forEach(tb => { if (tb.dirty && tb.path) add(tb.path); });
  if (state.uprising && state.uprising.dirty) add(state.uprising.path);
  if (state.campaign && state.campaign.dirty) add(state.campaign.path);
  if (state.swt && state.swt.dirty) add(state.swt.path);
  if (state.dirty && state.currentFile) add(state.currentFile.path);
  return out;
}

function treeFileDirty(path) {
  if (!path) return false;
  try { return treeDirtyPaths().has(normPath(path)); }
  catch (e) { return false; }
}

function paintTreeDirty() {
  const tree = $("#project-tree");
  if (!tree) return;
  const dirty = treeDirtyPaths();
  $$("#project-tree .tree-file").forEach(r => {
    const p = r.dataset.path || "";
    let is = false;
    try { is = dirty.has(normPath(p)); } catch (e) { /* noop */ }
    r.classList.toggle("dirty", is);
    if (is) r.title = (t("unsaved") || "Есть несохранённые изменения") + "\n" + p;
    else if (state.editedFiles && state.editedFiles.has(String(p).toLowerCase()))
      r.title = (t("edited_hint") || "Файл редактировался в Terminator Sheet") + "\n" + p;
    else r.title = p;
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

async function loadProject(path, opts) {
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
    await loadEditedMarks();
    await loadFullTree();
    // смена проекта вручную — показываем его дерево; фоновый старт
    // (keepSrc) — оставляем сохранённый источник: иначе каждый запуск
    // сносил бы game/mod в project и затирал localStorage следом
    if (opts && opts.keepSrc) {
      if (!srcAvail(state.treeView)) state.treeView = srcFirst(null) || "project";
    } else {
      state.treeView = "project";
    }
    persistSrc(state.treeView);
    paintTreeSpinner();
    renderTree();
    updateSidebarTabs();
    // проект мог приехать фоном (старт) или вручную при открытой странице
    // сравнения: сегменты сторон висели на старой доступности («Проект» серый,
    // «Игра» выбиралась с обеих сторон) — вернуть сохранённые и перекрасить
    try { cmpRestoreSides(); } catch (e) { /* страница сравнения не открывалась */ }
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
// больше не ждёт — имена дотягиваются после старта, грид перерисовывается.
// Слои — сначала корень ОТКРЫТОЙ КАРТЫ (путь карты лежит внутри своего
// источника: проект/мод/игра), дальше остальные по порядку проект/мод/игра
// (побеждает первый, остальные лишь добивают недостающее; GameAssets
// докладывает бэкенд сам, если скачаны).
async function loadDisplayNames(root, mapPath) {
  if (!root) return;
  try {
    const mod = (state.config && state.config.mod_path) || "";
    const game = (state.config && state.config.unpacked_path) || "";
    const all = [String(root || ""), String(mod || ""), String(game || "")];
    // путь карты задан явно (открытие/смена источника) либо берём карту
    // активной вкладки — её источник первый
    let mp = String(mapPath || "");
    if (!mp) {
      try {
        mp = state.activeTabId === "campaign"
          ? (state.campaign && state.campaign.path) || ""
          : state.activeTabId === "uprising"
            ? (state.uprising && state.uprising.path) || ""
            : "";
      } catch (e) { mp = ""; }
    }
    // источник карты первый: не нашлось там — ищем дальше по порядку
    let first = "";
    try {
      const m = String(mp || "").toLowerCase().replace(/\//g, "\\");
      if (m) {
        first = all.map(r => String(r || ""))
          .filter(r => r)
          .find(r => {
            const rl = r.toLowerCase().replace(/\//g, "\\");
            return m === rl || m.startsWith(rl + "\\");
          }) || "";
      }
    } catch (e) { first = ""; }
    const ordered = first ? [first].concat(all.filter(r => r !== first)) : all;
    const p = new URLSearchParams();
    const seen = new Set();
    ordered.forEach(r => {
      r = String(r || "");
      if (!r || seen.has(r.toLowerCase())) return;
      seen.add(r.toLowerCase());
      p.append("root", r);
    });
    p.set("lang", (state.config && state.config.language) || "ru");
    const r = await api("/api/display_names?" + p.toString(),
      { timeout: API_TIMEOUT_OPEN });
    const j = await r.json();
    if (j && j.ok && j.names) {
      state.nameMap = j.names;
      if (state.currentFile && state.currentFile.rows) renderGrid();
      // имена запечены в чипах при рендере — перерисовать открытые кампании
      try { if (state.uprising.rows) renderUprising(); } catch (e) {}
      try { if (typeof cmpPaintPanel === "function") cmpPaintPanel(); } catch (e) {}
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
      // фоновая индексация может занять минуты на больших проектах
      // (холодный HDD): не сдаёмся раньше времени; кнопка «Анализ»
      // пересчитывает текущий файл сразу, не дожидаясь фона
      if (retry < 200) { setTimeout(() => loadLinks(retry + 1), 3000); }
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
  // unit_set / unit_class в cars/tanks: стильный комбобокс классов + свободный ручной ввод
  if (typeof unitComboFor === "function" && typeof makeUnitSetCombo === "function") {
    const combo = unitComboFor(state.currentFile.path, state.currentFile.columns, ci,
      state.currentFile.rows.map(r => r.values[ci]));
    if (combo) makeUnitSetCombo(td, input, combo.choices, combo.title);
  }
  // фокус через хелпер: голый focus() докручивает контейнер сам и прячет
  // ячейку под липкую колонку sysname (см. focusCellInput в grid.js)
  focusCellInput(input, td);
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
        body: JSON.stringify({ path: state.currentFile.path, row: ri, col: ci, value: newVal,
          ...syncFlags() }) });
      const j = await r.json();
      if (j.ok) {
        await handleSyncResult(j, state.currentFile.path);
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

