// 3D-превью .model: тёмный диалог в духе вьюпорта Blender (тёмный фон,
// сетка пола с цветными осями), модель с натянутыми текстурами
// (albedo/normal/rough из .material через /api/model_tex), вращение
// мышью (OrbitControls). three.js вендорен локально (static/js/vendor,
// r128) — CDN не нужен, программа офлайн.
// Сцена (свет, камера, спиннер) встаёт СРАЗУ при открытии — геометрия
// догружается асинхронно, окно не висит. Башня подтягивается отдельным
// файлом на маунт-кость корпуса (бэкенд считает сдвиг по правилам
// Blender-плагина); навесная броня скрыта по умолчанию, тумблер в меню.
var M3D_THREE_URL = "/static/js/vendor/three.min.js";
var M3D_ORBIT_URL = "/static/js/vendor/OrbitControls.js";
var m3dLibState = 0; // 0 — нет, 1 — грузится, 2 — готов
var m3dLibQueue = [];

// Ленивая подгрузка three.js только при первом открытии превью, чтобы
// не тормозить старт программы. Колбэки ждут готовности.
function m3dLibs(cb) {
  if (m3dLibState === 2) { cb(true); return; }
  m3dLibQueue.push(cb);
  if (m3dLibState === 1) return;
  m3dLibState = 1;
  const done = ok => {
    m3dLibState = ok ? 2 : 0;
    const q = m3dLibQueue.splice(0);
    q.forEach(f => { try { f(ok); } catch (e) {} });
  };
  const load = (url, next) => {
    const s = document.createElement("script");
    s.src = url;
    s.onload = () => next(true);
    s.onerror = () => next(false);
    document.head.appendChild(s);
  };
  load(M3D_THREE_URL, ok => {
    if (!ok) { done(false); return; }
    load(M3D_ORBIT_URL, done);
  });
}

let m3dPopEl = null;

// Клиентский кэш готовых ответов: повторное открытие — мгновенно,
// без fetch. Только несколько последних (LRU), память не раздуваем.
var m3dCache = new Map();
var M3D_CACHE_MAX = 3;
// Последний выбранный вариант башни на модель (переживает обмен,
// чтобы переоткрытие вернуло тот же вариант через лёгкий эндпоинт).
var m3dTurretPick = new Map();
function m3dCacheKey(root, value, cat, sys) {
  return (root || "") + "|" + (value || "") + "|" + (cat || "") + "|" + (sys || "");
}
function m3dCacheGet(k) {
  const e = m3dCache.get(k);
  if (e) { m3dCache.delete(k); m3dCache.set(k, e); }
  return e || null;
}
function m3dCachePut(k, e) {
  m3dCache.delete(k);
  m3dCache.set(k, e);
  while (m3dCache.size > M3D_CACHE_MAX)
    m3dCache.delete(m3dCache.keys().next().value);
}

// Открыть 3D-превью модели: root — корень источника вкладки,
// value — сырое значение колонки mesh, title — подпись (sysname),
// opts — {cat, sys} для автоподбора башни по строке species.
function openModelPreview(root, value, title, opts) {
  if (m3dPopEl) m3dClose();
  // Фон-подложка: клик в любое место мимо окна закрывает предпросмотр
  const back = document.createElement("div");
  back.className = "m3d-back";
  back.onclick = () => m3dClose();
  document.body.appendChild(back);
  const pop = document.createElement("div");
  pop.className = "m3d-pop";
  pop._back = back;
  const bar = document.createElement("div");
  bar.className = "m3d-bar";
  pop.appendChild(bar);
  const view = document.createElement("div");
  view.className = "m3d-view";
  pop.appendChild(view);
  const spin = document.createElement("div");
  spin.className = "m3d-cube";
  spin.innerHTML = '<div class="m3d-cube-inner"><i></i><i></i><i></i><i></i><i></i><i></i></div>';
  view.appendChild(spin);
  const status = document.createElement("div");
  status.className = "m3d-status";
  status.textContent = t("m3d_loading") || "";
  view.appendChild(status);
  const pbar = document.createElement("div");
  pbar.className = "m3d-pbar";
  pbar.innerHTML = "<i></i>";
  view.appendChild(pbar);
  const tprog = document.createElement("div");
  tprog.className = "m3d-tprog";
  tprog.innerHTML = "<span></span><i><b></b></i>";
  tprog.style.display = "none";
  view.appendChild(tprog);
  const perf = document.createElement("div");
  perf.className = "m3d-perf";
  view.appendChild(perf);
  const err = document.createElement("div");
  err.className = "m3d-err";
  err.hidden = true;
  view.appendChild(err);
  document.body.appendChild(pop);
  m3dPopEl = pop;
  const fail = msg => {
    try { spin.remove(); } catch (e) {}
    try { status.remove(); } catch (e2) {}
    err.textContent = msg;
    err.hidden = false;
  };
  // Esc закрывает диалог
  pop._esc = e => { if (e.key === "Escape") m3dClose(); };
  document.addEventListener("keydown", pop._esc);
  const cat = (opts && opts.cat) || "";
  const sys = (opts && opts.sys) || "";
  m3dLibs(ok => {
    if (!pop.isConnected) return;
    if (!ok) { fail(t("m3d_err_lib") || "3D error"); return; }
    // Сцена сразу: свет и камера есть до прихода геометрии
    const st = m3dStage(pop, view, bar, root || "");
    if (!st) { fail(t("m3d_err_lib") || "3D error"); return; }
    const key = m3dCacheKey(root || "", value || "", cat, sys);
    st.cacheKey = key;
    const hit = m3dCacheGet(key);
    if (hit && hit.data && hit.data.ok) {
      // Модель уже загружена: строим мгновенно, сеть не трогаем
      st.params = {root: root || "", value: value || "",
        cat: cat, sys: sys,
        turret: (hit.data.turret && hit.data.turret.rel) || "@@auto@@"};
      st.fromCache = true;
      m3dShowData(st, hit.data, true);
      return;
    }
    m3dProgress(st, 0.15);
    m3dFetch(st, {root: root || "", value: value || "",
      cat: cat, sys: sys,
      turret: m3dTurretPick.get(key) || "@@auto@@"}, true);
  });
}

// Полоса загрузки: дробь 0..1
function m3dProgress(st, frac) {
  try {
    if (!st.pbarFill) return;
    st.pbar.style.display = "";
    st.pbarFill.style.width = Math.round(
      Math.max(0, Math.min(1, frac)) * 100) + "%";
  } catch (e) {}
}

// Запрос геометрии; first — первичное открытие (домой камерой),
// иначе — смена варианта башни (вид сохраняем).
function m3dFetch(st, params, first) {
  const pop = st.pop;
  st.params = params;
  st.status.hidden = false;
  st.spin.hidden = false;
  st.status.textContent = t("m3d_loading") || "";
  m3dProgress(st, 0.3);
  const t0 = (typeof performance !== "undefined" && performance.now)
    ? performance.now() : Date.now();
  fetch("/api/model_preview", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(params),
  }).then(r => r.json()).catch(() => ({ok: false, error: "net"})
  ).then(data => {
    if (!pop.isConnected) return;
    const t1 = (typeof performance !== "undefined" && performance.now)
      ? performance.now() : Date.now();
    st.lastFetchMs = Math.round(t1 - t0);
    st.spin.hidden = true;
    st.status.hidden = true;
    if (!data || !data.ok) {
      if (first) {
        try { st.spin.remove(); } catch (e) {}
        try { st.status.remove(); } catch (e2) {}
        try { st.pbar.remove(); } catch (e3) {}
        st.err.textContent = m3dErrText(data && data.error);
        st.err.hidden = false;
      }
      return;
    }
    m3dProgress(st, 0.6);
    if (first && st.cacheKey) m3dCachePut(st.cacheKey, {data: data});
    m3dShowData(st, data, first);
  });
}

// Текст ошибки бэкенда кодом локали
function m3dErrText(code) {
  const map = {bad_value: "m3d_err_bad", no_root: "m3d_err_bad",
    no_file: "m3d_err_nofile", parse_failed: "m3d_err_parse", net: "m3d_err_parse"};
  return t(map[code] || "m3d_err_parse") || String(code || "error");
}

function m3dClose() {
  const pop = m3dPopEl;
  m3dPopEl = null;
  if (!pop) return;
  try { document.removeEventListener("keydown", pop._esc); } catch (e) {}
  try { document.removeEventListener("click", pop._armorDoc); } catch (e2) {}
  try { document.removeEventListener("click", pop._turretDoc); } catch (e3) {}
  try {
    if (pop._raf) cancelAnimationFrame(pop._raf);
    if (pop._ro) pop._ro.disconnect();
    (pop._disposables || []).forEach(d => {
      try { d.dispose ? d.dispose() : d(); } catch (e) {}
    });
    Object.keys(pop._texCache || {}).forEach(k => {
      try { pop._texCache[k].dispose(); } catch (e2) {}
    });
  } catch (e) {}
  try { pop.remove(); } catch (e) {}
  try { pop._back && pop._back.remove(); } catch (e) {}
}

// Первая стадия: рендер, свет, камера, цикл — геометрии ещё нет
function m3dStage(pop, view, bar, root) {
  const W = () => view.clientWidth || 640;
  const H = () => view.clientHeight || 480;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({antialias: true});
  } catch (e) { return null; }
  // Строка видеодрайвера: SwiftShader/llvmpipe = программный GL —
  // там тяжёлый Standard-материал даёт слайд-шоу, берём лёгкий Lambert
  let gpuName = "", softGL = false;
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    gpuName = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "")
      : String(gl.getParameter(gl.RENDERER) || "");
    softGL = /swiftshader|software|llvmpipe|basic render|angle \(google/i.test(gpuName);
  } catch (e) {}
  renderer.setPixelRatio(softGL ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(W(), H());
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  view.appendChild(renderer.domElement);
  // Пока модель грузится — только куб и прогресс: сцену не показываем
  renderer.domElement.style.visibility = "hidden";
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x38383c);
  const camera = new THREE.PerspectiveCamera(45, W() / H(), 0.05, 2000);
  camera.position.set(6, 5, 8);
  const ctl = new THREE.OrbitControls(camera, renderer.domElement);
  ctl.enableDamping = true;
  ctl.dampingFactor = 0.08;
  ctl.target.set(0, 1, 0);
  // Студийный свет сразу: доминантный ключ строго сверху, холодный
  // контровой сбоку, снизу — чистый чёрный (подсветки снизу нет вообще)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x000000, 0.45));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(1, 16, 3);
  scene.add(key);
  const side = new THREE.DirectionalLight(0xbfd0ff, 0.35);
  side.position.set(-8, 5, -2);
  scene.add(side);
  const group = new THREE.Group();
  scene.add(group);
  const gridHolder = new THREE.Group();
  scene.add(gridHolder);
  const st = {pop: pop, view: view, bar: bar, root: root,
    renderer: renderer, scene: scene, camera: camera, ctl: ctl,
    group: group, gridHolder: gridHolder, softGL: softGL, gpuName: gpuName,
    spin: view.querySelector(".m3d-cube"),
    status: view.querySelector(".m3d-status"),
    perf: view.querySelector(".m3d-perf"),
    err: view.querySelector(".m3d-err"),
    pbar: view.querySelector(".m3d-pbar"),
    pbarFill: (function () {
      const pb = view.querySelector(".m3d-pbar");
      return pb ? pb.querySelector("i") : null;
    })(),
    tprog: view.querySelector(".m3d-tprog"),
    canvasHidden: true, fromCache: false, cacheKey: "",
    disposables: [renderer],
    armorOn: false, turretOn: true, texOn: false,
    armorKinds: null,
    // Набор прикреплённых башен (их rel) + слоты вариантов: чекбоксы
    // дропа башен (как виды брони). null = ещё не инициализирован
    // (первая загрузка встанет на backend-selected).
    turretSet: null, turretSlots: null, turretKnown: null,
    turretDropBtn: null, turretDrop: null,
    barBuilt: false, home: null, mgSel: null,
    armorKindBtn: null, armorDrop: null, armorKnown: null,
    armorLab: null, mgLab: null, params: null,
    texCache: {}, texMgr: null};
  pop._disposables = st.disposables;
  // Общий менеджер текстур на диалог: догрузка идёт в фоне, справа
  // сверху висит её прогресс, просмотр модели ничего не ждёт
  st.texMgr = new THREE.LoadingManager();
  // Старт тоже показываем (tex 0/N): иначе до первой готовой текстуры
  // (геометрия + её 10МБ JSON + сборка 269 мешей + башня) бар молчит
  // ~10 сек и кажется, что ничего не происходит
  st.texMgr.onStart = (url, loaded, total) => {
    try {
      st.tprog.style.display = "";
      st.tprog.querySelector("span").textContent =
        "tex " + loaded + "/" + total;
      st.tprog.querySelector("b").style.width = "0%";
    } catch (e) {}
  };
  st.texMgr.onProgress = (url, loaded, total) => {
    try {
      st.tprog.style.display = "";
      st.tprog.querySelector("span").textContent =
        "tex " + loaded + "/" + total;
      st.tprog.querySelector("b").style.width =
        Math.round(loaded / Math.max(total, 1) * 100) + "%";
    } catch (e) {}
  };
  st.texMgr.onLoad = () => {
    try { st.tprog.style.display = "none"; } catch (e) {}
  };
  pop._texCache = st.texCache;
  // Цикл и ресайз живут с первой стадии
  const loop = () => {
    if (!pop.isConnected) return;
    ctl.update();
    if (!st.canvasHidden) renderer.render(scene, camera);
    pop._raf = requestAnimationFrame(loop);
  };
  loop();
  try {
    pop._ro = new ResizeObserver(() => {
      try {
        camera.aspect = W() / H();
        camera.updateProjectionMatrix();
        renderer.setSize(W(), H());
      } catch (e) {}
    });
    pop._ro.observe(view);
  } catch (e) { /* старый движок — фиксированный размер */ }
  return st;
}

// Выбросить содержимое группы (смена варианта башни)
function m3dClearGroup(st) {
  st.group.children.slice().forEach(mesh => {
    st.group.remove(mesh);
    try { mesh.geometry.dispose(); } catch (e) {}
    const mt = mesh.material;
    if (mt) {
      (mt.userData.tex || []).forEach(tx => { try { tx.dispose(); } catch (e) {} });
      try { mt.dispose(); } catch (e2) {}
    }
  });
  st.gridHolder.children.slice().forEach(g => {
    st.gridHolder.remove(g);
    try { g.geometry.dispose(); } catch (e) {}
    try { g.material.dispose(); } catch (e2) {}
  });
  st.disposables = st.disposables.filter(d =>
    !st.group.children.includes(d));
}

// Текстура готова: назначаем на материал, только если текстуры включены
function m3dTexReady(st, mat, slot) {
  try {
    const tx = mat.userData.slots[slot];
    if (!tx || !st.texOn) return;
    mat[slot] = tx;
    mat.needsUpdate = true;
    mat.userData.mapsOn = true;
  } catch (e) {}
}

// Заказ текстуры в фон: дедуп по rel (сотни мешей делят десяток
// уникальных), назначение — по готовности через m3dTexReady
function m3dWantTex(st, texLoader, maxAniso, texUrl, mat, slot, rel, srgb) {
  if (!rel) return;
  const key = (srgb ? "s" : "l") + rel;
  let tx = st.texCache[key];
  if (!tx) {
    try {
      tx = texLoader.load(texUrl(rel, slot), () => m3dTexReady(st, mat, slot));
      if (srgb) tx.encoding = THREE.sRGBEncoding;
      tx.anisotropy = maxAniso;
      // UV игры тайлятся (гусеницы: v до −13) — без повтора Clamp
      // размазывает крайний пиксель полосами
      tx.wrapS = THREE.RepeatWrapping;
      tx.wrapT = THREE.RepeatWrapping;
    } catch (e) { return; }
    st.texCache[key] = tx;
    mat.userData.tex.push(tx);
  }
  mat.userData.slots[slot] = tx;
  // Уже готовая (кэш/повтор) и текстуры включены — назначаем сразу
  try {
    if (tx.image && tx.image.complete !== false && tx.image.width &&
        st.texOn) {
      mat[slot] = tx;
      mat.needsUpdate = true;
      mat.userData.mapsOn = true;
    }
  } catch (e) {}
}

// Добавление мешей в группу общим кодом: полная загрузка и смена
// башни идут через него, состояние тумблеров применяется к новым мешам.
// modelRel — rel модели-владельца (корпус или башня): бэкенд кладёт
// текстуры в CustomImages/.../textures/<стем модели>.
// turretRel — rel башни для мешей part turret/mg (иначе ""): по нему
// чекбоксы дропа снимают/возвращают каждую башню отдельно.
function m3dAddMeshes(st, meshes, materials, modelRel, turretRel) {
  const root = st.root;
  const texLoader = new THREE.TextureLoader(st.texMgr);
  texLoader.setCrossOrigin("anonymous");
  const maxAniso = st.renderer.capabilities.getMaxAnisotropy();
  let modelStem = "";
  try {
    const bn = String(modelRel || "").replace(/\\/g, "/").split("/").pop();
    modelStem = bn.replace(/\.[^.]*$/, "");
  } catch (e) { modelStem = ""; }
  const texUrl = (rel, slot) => "/api/model_tex?root=" + encodeURIComponent(root || "") +
    "&rel=" + encodeURIComponent(rel || "") +
    "&model=" + encodeURIComponent(modelStem) +
    "&slot=" + encodeURIComponent({map: "albedo", normalMap: "normal",
      roughnessMap: "rough"}[slot] || "");
  const group = st.group;
  let armorCount = 0, turretCount = 0;
  const armorStat = {};
  (meshes || []).forEach(m => {
    const p = m.positions || [], n = m.normals || [], u = m.uvs || [], ix = m.indices || [];
    if (!p.length || !ix.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
    if (n.length === p.length) g.setAttribute("normal", new THREE.Float32BufferAttribute(n, 3));
    else g.computeVertexNormals();
    if (u.length === (p.length / 3) * 2) g.setAttribute("uv", new THREE.Float32BufferAttribute(u, 2));
    g.setIndex(ix);
    const mi = (m.material != null) ? m.material : -1;
    const md = (materials && materials[mi]) || null;
    // Программный GL (SwiftShader): лёгкий Lambert вместо Standard —
    // иначе компиляция и кадры тяжёлого шейдера дают слайд-шоу
    // Материалы обычные: туман общий на сцену (сетка и модель тонут
    // в фоне одинаково, как в Blender)
    const mat = st.softGL
      ? new THREE.MeshLambertMaterial({color: 0xffffff})
      : new THREE.MeshStandardMaterial({
        color: 0xffffff, metalness: 0.05, roughness: 0.85,
      });
    mat.userData.tex = [];
    mat.userData.slots = {map: null, normalMap: null, roughnessMap: null};
    mat.userData.mapsOn = false;
    if (md && !md.missing) {
      // Фоновая догрузка с дедупом; назначение — по готовности и флагу
      m3dWantTex(st, texLoader, maxAniso, texUrl, mat, "map", md.albedo, true);
      m3dWantTex(st, texLoader, maxAniso, texUrl, mat, "normalMap", md.normal, false);
      if (!st.softGL) m3dWantTex(st, texLoader, maxAniso, texUrl,
        mat, "roughnessMap", md.rough, false);
      if (md.transparent) mat.transparent = true;
      if (md.double_sided) mat.side = THREE.DoubleSide;
    } else {
      mat.color.setHex(0x9aa0a8);
    }
    const mesh = new THREE.Mesh(g, mat);
    const isArmor = m.group === "armor";
    const isTurret = m.part === "turret" || m.part === "mg";
    mesh.userData.isArmor = isArmor;
    mesh.userData.isTurret = isTurret;
    if (isTurret) mesh.userData.turretRel = turretRel || "";
    mesh.userData.detail = m.detail || "";
    mesh.userData.layer = m.layer || "";
    mesh.visible = m3dVis(st, mesh.userData);
    if (isArmor) {
      armorCount++;
      const k = [m.detail, m.layer].filter(Boolean).join("/");
      if (k) armorStat[k] = (armorStat[k] || 0) + 1;
    }
    // Счётчик башни — только тело (без обвеса брони)
    if (isTurret && !isArmor) turretCount++;
    mesh.userData.title = [m.name, m.node].filter(Boolean).join(" @ ");
    group.add(mesh);
    st.disposables.push(g, mat);
    mat.userData.tex.forEach(tx => st.disposables.push(tx));
  });
  return {armor: armorCount, turret: turretCount, armorStat: armorStat};
}

// Обмен только башни: старую снимаем, новую ставим — корпус, сетка
// и камера не трогаются, чёрной вспышки нет
// Единая видимость меша: выключенная башня гасит всё своё
// (тело, обвес брони, пулемёт); конкретная снятая с набора гасит
// только свои меши (по turretRel); броня — мастер-флаг + вид;
// корпус — всегда. Чинит сразу два бага: броня больше не включает
// выключенную башню, а башня не показывает свой обвес
// при выключенной броне.
function m3dVis(st, ud) {
  if (ud.isTurret && !st.turretOn) return false;
  if (ud.isTurret && st.turretSet && ud.turretRel &&
      !st.turretSet.has(ud.turretRel)) return false;
  if (ud.isArmor) {
    if (!st.armorOn) return false;
    if (!ud.detail) return true;
    const ks = st.armorKinds;
    return !ks || ks.has(ud.detail);
  }
  if (ud.isTurret) return true;
  return true;
}

function m3dApplyVis(st) {
  st.group.children.forEach(mesh => {
    mesh.visible = m3dVis(st, mesh.userData);
  });
}

// Снятие мешей одной башни (по turretRel; пустой rel — всех башен):
// корпус, сетка и камера не трогаются, чёрной вспышки нет
function m3dDropTurretMeshes(st, rel) {
  st.group.children.slice().forEach(mesh => {
    const ud = mesh.userData;
    if (!ud.isTurret) return;
    if (rel && ud.turretRel !== rel) return;
    st.group.remove(mesh);
    try { mesh.geometry.dispose(); } catch (e) {}
    const mt = mesh.material;
    if (mt) {
      (mt.userData.tex || []).forEach(tx => { try { tx.dispose(); } catch (e) {} });
      try { mt.dispose(); } catch (e2) {}
    }
  });
}

// Первичная башня набора (для пулемёта и переоткрытия): первая
// из порядка установки
function m3dTurretPrimary(st) {
  const s = st.turretSet;
  if (s && s.size) return [...s][0];
  return "";
}

// Прикрепление башни из чекбокса: меши своего rel снимаем (повторный
// заход после смены пулемёта) и кладём новые поверх остальных —
// соседние башни не трогаем, видно всё разом. Индексы материалов
// бэкенд считает от числа материалов корпуса, а st.allMats уже
// подрос на ранее прикреплённые — сдвигаем на дельту (только
// дописываем в хвост, дыры от снятых никому не мешают).
function m3dAddTurret(st, res) {
  if (!res || !res.ok || !res.rel) return;
  m3dDropTurretMeshes(st, res.rel);
  const mats = res.materials || [];
  const delta = st.allMats.length - (st.matBase || 0);
  (res.meshes || []).forEach(b => {
    if (b.material != null && b.material >= 0) b.material += delta;
  });
  st.allMats = st.allMats.concat(mats);
  m3dAddMeshes(st, res.meshes || [], st.allMats, res.rel, res.rel);
  try {
    if (!st.turretSet) st.turretSet = new Set();
    st.turretSet.add(res.rel);
  } catch (e) {}
  m3dAfterTurretChange(st, res);
}

// Снятие башни чекбоксом: только свои меши, остальной набор стоит
function m3dRemoveTurret(st, rel) {
  if (!rel) return;
  m3dDropTurretMeshes(st, rel);
  try {
    if (st.turretSet) st.turretSet.delete(rel);
  } catch (e) {}
  m3dAfterTurretChange(st, null);
}

// Общее после смены набора: свежий список вариантов, счётчики,
// подпись дропа, пулемёт, пик переоткрытия. Кэш с прежним составом
// стираем (иначе воскреснет старый набор).
function m3dAfterTurretChange(st, res) {
  if (res) m3dRefreshTurretSel(st, res);
  m3dRecountPartBtns(st);
  m3dTurretDropBtn(st);
  if (res) m3dRefreshMgSel(st, res);
  try {
    st.params = Object.assign({}, st.params,
      {turret: m3dTurretPrimary(st) || "@@auto@@"});
  } catch (e) {}
  try {
    if (st.cacheKey) {
      m3dCache.delete(st.cacheKey);
      const prim = m3dTurretPrimary(st);
      if (prim) {
        m3dTurretPick.set(st.cacheKey, prim);
        while (m3dTurretPick.size > 10)
          m3dTurretPick.delete(m3dTurretPick.keys().next().value);
      }
    }
  } catch (e) {}
  try {
    const srv = (res && res.srv_ms && res.srv_ms.total) || 0;
    st.perf.textContent = "turret " + srv + "ms · " +
      "meshes " + st.group.children.length +
      (st.gpuName ? " · " + st.gpuName : "") +
      (st.softGL ? " [soft]" : "");
    st.perfBase = st.perf.textContent;
  } catch (e) {}
}

// Пересчёт счётчиков брони/башни по живым мешам (после смены набора):
// у башни считаем штуки (разные rel), а не меши — иначе мадробот
// с пятью пушками покажет десятки
function m3dTurretRels(st) {
  const out = [];
  try {
    st.group.children.forEach(mesh => {
      const ud = mesh.userData;
      if (ud.isTurret && !ud.isArmor && ud.turretRel &&
          out.indexOf(ud.turretRel) < 0) out.push(ud.turretRel);
    });
  } catch (e) {}
  return out;
}

// Пересчёт счётчиков брони/башни по живым мешам (после смены набора)
function m3dRecountPartBtns(st) {
  let armorCount = 0;
  const turretCount = m3dTurretRels(st).length;
  const stat = {};
  st.group.children.forEach(mesh => {
    const ud = mesh.userData;
    if (ud.isArmor) {
      armorCount++;
      const k = [ud.detail, ud.layer].filter(Boolean).join("/");
      if (k) stat[k] = (stat[k] || 0) + 1;
    }
  });
  if (st.armorBtn) st.armorBtn.textContent =
    (t("m3d_armor") || "armor") + (armorCount ? " (" + armorCount + ")" : "");
  if (st.turretBtn) st.turretBtn.textContent =
    (t("m3d_turret") || "turret") + (turretCount ? " (" + turretCount + ")" : "");
  m3dArmorTitle(st, stat);
  m3dRefreshArmorSel(st, stat);
}

// Подсказка кнопки брони: разбивка по видам сторона/слой
function m3dArmorTitle(st, stat) {
  if (!st.armorBtn) return;
  const s = stat || st.armorStat || null;
  if (st.armorBtn && stat) st.armorStat = stat;
  if (!s) return;
  const parts = Object.keys(s).sort().map(k => k + ": " + s[k]);
  if (parts.length) st.armorBtn.title = parts.join(", ");
}

// Запрос только башни (смена варианта): лёгкий эндпоинт, без корпуса
function m3dFetchTurret(st, rel, slot, mg) {
  st.params = Object.assign({}, st.params, {turret: rel});
  fetch("/api/model_turret", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({root: st.root || "",
      value: (st.params && st.params.value) || "", turret: rel || "",
      slot: slot || "", mg: mg == null ? "@@auto@@" : mg,
      cat: (st.params && st.params.cat) || "",
      sys: (st.params && st.params.sys) || ""}),
  }).then(r => r.json()).catch(() => ({ok: false, error: "net"})
  ).then(res => {
    if (!st.pop.isConnected) return;
    m3dAddTurret(st, res);
  });
}

// Вторая стадия: геометрия приехала — сетка, меши, камера, кнопки
function m3dShowData(st, data, first) {
  const tb0 = (typeof performance !== "undefined" && performance.now)
    ? performance.now() : Date.now();
  m3dClearGroup(st);
  // Геометрия готова: гасим куб и прогресс, показываем сцену
  try { st.spin.hidden = true; } catch (e) {}
  try { st.status.hidden = true; } catch (e2) {}
  try { st.pbar.style.display = "none"; } catch (e3) {}
  try {
    st.renderer.domElement.style.visibility = "visible";
    st.canvasHidden = false;
  } catch (e4) {}
  const root = st.root;
  const scene = st.scene, camera = st.camera, ctl = st.ctl;
  // Рамка модели для сетки и камеры
  const bbox = new THREE.Box3();
  const tmp = new THREE.Vector3();
  (data.meshes || []).forEach(m => {
    const p = m.positions || [];
    for (let i = 0; i + 2 < p.length; i += 3) {
      tmp.set(p[i], p[i + 1], p[i + 2]);
      bbox.expandByPoint(tmp);
    }
  });
  if (bbox.isEmpty()) bbox.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1);
  // Сетка в духе Blender: мелкие клетки 1 м тускло, крупные 10 м
  // чуть ярче, оси X красная / Z зелёная; туман гасит всё к горизонту.
  // Крупной модели — крупное поле: иначе край сетки сидит вплотную
  // к корпусу и его не спрятать, не задев саму модель.
  const gridSize = Math.max(Math.ceil(maxDim * 1.5) * 2 + 2, 120);
  // Линии сетки свет и тонирование игнорируют (toneMapped=false) —
  // иначе ACES+sRGB осветляют заданный цвет почти вдвое («белый»).
  // Цвета заданы в линейном виде, чтобы на экране было ровно как
  // на скрине Blender 5.2; ширина линий в WebGL всегда 1px, тонкость
  // вида — низкой контрастностью к фону.
  const gh = new THREE.GridHelper(gridSize, gridSize, 0x121217, 0x0f0f13);
  gh.material.toneMapped = false;
  gh.position.y = bbox.min.y - 0.01;
  st.gridHolder.add(gh);
  const ghBig = new THREE.GridHelper(gridSize, Math.max(Math.round(gridSize / 10), 1), 0x1a1a1e, 0x141418);
  ghBig.material.toneMapped = false;
  ghBig.position.y = bbox.min.y - 0.008;
  st.gridHolder.add(ghBig);
  const axGeo = (x1, z1, x2, z2) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(
      [x1, 0, z1, x2, 0, z2], 3));
    return g;
  };
  const y0 = bbox.min.y;
  const axLen = gridSize / 2;
  const axX = new THREE.Line(axGeo(-axLen, 0, axLen, 0),
    new THREE.LineBasicMaterial({color: 0xad0f1a, toneMapped: false}));
  axX.position.y = y0;
  const axZ = new THREE.Line(axGeo(0, -axLen, 0, axLen),
    new THREE.LineBasicMaterial({color: 0x378a16, toneMapped: false}));
  axZ.position.y = y0;
  st.gridHolder.add(axX);
  st.gridHolder.add(axZ);
  // Туман в цвет фона (тоже линейный, иначе горизонт светлее фона).
  // Дальность — ниже, у домашнего вида: считаем от фактической дистанции
  // камеры, границы ФИКСИРОВАНЫ и за зумом не ездят — как в Blender:
  // отъехал далеко — всё (сетка и модель) тонет в фоне.
  const dHome = (maxDim * 1.5 + 1) * 0.62;
  st.disposables.push(gh.geometry, gh.material,
    ghBig.geometry, ghBig.material,
    axX.geometry, axX.material, axZ.geometry, axZ.material);
  // Граница материалов корпуса: башня дописывается поверх при обмене
  st.matBase = (data.turret && data.turret.mat_base != null)
    ? data.turret.mat_base : (data.materials || []).length;
  st.baseMats = (data.materials || []).slice(0, st.matBase);
  st.allMats = data.materials || [];
  const added = m3dAddMeshes(st, data.meshes || [], st.allMats,
    data.value || (st.params && st.params.value) || "",
    (data.turret && data.turret.rel) || "");
  const armorCount = added.armor;
  // Камера: цель в центр модели; вид по умолчанию — сбоку
  // (профиль, как на скрине юзера), чуть сверху и немного спереди:
  // нос модели в −Z, правый борт в +X
  st.home = () => {
    ctl.target.copy(center);
    const d = dHome;
    camera.position.set(center.x - d * 1.0, center.y + d * 0.3, center.z - d * 0.65);
    camera.near = Math.max(d / 500, 0.01);
    camera.far = d * 60 + 100;
    camera.updateProjectionMatrix();
    ctl.update();
  };
  if (first) st.home();
  // Туман от фактической дистанции камеры: ближняя — сразу за моделью
  // (корпус чист целиком), дальняя — за бортом сетки, но до её угла
  // (полу-диагональ ~1.41): борт тает, угол уже в полном тумане —
  // края не видно. Полоса не схлопывается: минимум 0.3 половины.
  {
    const half = gridSize / 2;
    const radius = size.length() / 2;
    const camD = camera.position.distanceTo(ctl.target);
    const fogNear = camD + radius;
    scene.fog = new THREE.Fog(0x38383c, fogNear,
      Math.max(fogNear + half * 0.3, camD + half * 1.05));
  }
  if (!st.barBuilt) {
    st.barBuilt = true;
    m3dBuildBar(st);
  }
  // Новый корпус — новый набор башен (старые rel недействительны)
  st.turretSet = null;
  st.turretSlots = null;
  m3dRefreshTurretSel(st, data);
  m3dRefreshMgSel(st, (data && data.turret) || {});
  // Подписи кнопок брони/башни — со счётчиками (у башни — штуки)
  if (st.armorBtn) st.armorBtn.textContent =
    (t("m3d_armor") || "armor") + (armorCount ? " (" + armorCount + ")" : "");
  m3dArmorTitle(st, added.armorStat);
  m3dRefreshArmorSel(st, added.armorStat);
  const turretCount = m3dTurretRels(st).length;
  if (st.turretBtn) {
    st.turretBtn.textContent =
      (t("m3d_turret") || "turret") + (turretCount ? " (" + turretCount + ")" : "");
    st.turretBtn.style.display = turretCount ? "" : "none";
  }
  // Строка диагностики: где реально сидит время (fetch/сборка/сервер/GPU)
  try {
    const t2 = (typeof performance !== "undefined" && performance.now)
      ? performance.now() : Date.now();
    const srv = (data.srv_ms && data.srv_ms.total) || 0;
    st.perf.textContent = "fetch " + (st.lastFetchMs || 0) + "ms · " +
      "srv " + srv + "ms · build " + Math.round(t2 - tb0) + "ms · " +
      "meshes " + (data.meshes || []).length +
      (st.fromCache ? " · cached" : "") +
      (st.gpuName ? " · " + st.gpuName : "") +
      (st.softGL ? " [soft]" : "");
    st.perfBase = st.perf.textContent;
    st.fromCache = false;
  } catch (e) {}
}

// Панель: сетка, текстуры, броня, башня, сброс вида
function m3dBuildBar(st) {
  const bar = st.bar;
  const mkBtn = (key, on, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "m3d-btn" + (on ? " on" : "");
    b.textContent = t(key) || key;
    b.onclick = () => fn(b);
    bar.appendChild(b);
    return b;
  };
  mkBtn("m3d_grid", true, b => {
    st.gridHolder.visible = !st.gridHolder.visible;
    b.classList.toggle("on", st.gridHolder.visible);
  });
  mkBtn("m3d_textures", st.texOn, b => {
    const on = !b.classList.contains("on");
    b.classList.toggle("on", on);
    st.texOn = on;
    st.group.children.forEach(mesh => {
      const mt = mesh.material;
      const slots = mt && mt.userData.slots;
      if (!mt || !slots) return;
      if (on) {
        // Назначаем только докачанные; остальные встанут сами
        // через m3dTexReady, когда догрузятся
        let touched = false;
        ["map", "normalMap", "roughnessMap"].forEach(k => {
          const tx = slots[k];
          if (tx && tx.image && tx.image.complete !== false &&
              tx.image.width) {
            mt[k] = tx;
            touched = true;
          }
        });
        if (touched) mt.needsUpdate = true;
        mt.userData.mapsOn = touched;
      } else if (mt.userData.mapsOn || mt.map || mt.normalMap ||
                 mt.roughnessMap) {
        mt.map = null; mt.normalMap = null; mt.roughnessMap = null;
        mt.needsUpdate = true;
        mt.userData.mapsOn = false;
      }
    });
  });
  // Навесная броня: скрыта по умолчанию, тумблер в верхнем меню
  st.armorBtn = mkBtn("m3d_armor", st.armorOn, b => {
    const on = !b.classList.contains("on");
    b.classList.toggle("on", on);
    st.armorOn = on;
    m3dApplyVis(st);
  });
  // Башня: отдельный файл на маунте корпуса, тумблер + выбор варианта
  st.turretBtn = mkBtn("m3d_turret", st.turretOn, b => {
    const on = !b.classList.contains("on");
    b.classList.toggle("on", on);
    st.turretOn = on;
    m3dApplyVis(st);
  });
  const lab = document.createElement("span");
  lab.className = "m3d-lab";
  lab.textContent = t("m3d_turret_pick") || "";
  lab.style.display = "none";
  bar.appendChild(lab);
  st.turretLab = lab;
  // Набор башен: мульти-дроп с чекбоксами по вариантам (как виды
  // брони) — каждую видно и снимать можно отдельно, все разом тоже.
  // По умолчанию стоит backend-selected, остальные цепляются галками.
  const tkbtn = document.createElement("button");
  tkbtn.type = "button";
  tkbtn.className = "m3d-btn m3d-selbtn";
  tkbtn.style.display = "none";
  tkbtn.onclick = ev => {
    try { ev.stopPropagation(); } catch (e) {}
    const dd = st.turretDrop;
    if (dd) dd.style.display = dd.style.display === "none" ? "" : "none";
  };
  const tdrop = document.createElement("div");
  tdrop.className = "m3d-drop";
  tdrop.style.display = "none";
  tdrop.onclick = ev => {
    try { ev.stopPropagation(); } catch (e) {}
  };
  const twrap = document.createElement("span");
  twrap.className = "m3d-kindwrap";
  twrap.appendChild(tkbtn);
  twrap.appendChild(tdrop);
  bar.appendChild(twrap);
  st.turretDropBtn = tkbtn;
  st.turretDrop = tdrop;
  // Клик мимо панели закрывает её (снимаем при закрытии диалога)
  const tdlg = st.pop;
  if (tdlg && !tdlg._turretDoc) {
    tdlg._turretDoc = () => {
      try {
        if (st.turretDrop) st.turretDrop.style.display = "none";
      } catch (e) {}
    };
    document.addEventListener("click", tdlg._turretDoc);
  }
  // Вид брони: мульти-выпадашка с чекбоксами по видам плагина
  // (ceramic/carbon/…), по умолчанию все включены
  const alab = document.createElement("span");
  alab.className = "m3d-lab";
  alab.textContent = t("m3d_armor_kind") || "";
  alab.style.display = "none";
  bar.appendChild(alab);
  st.armorLab = alab;
  const akbtn = document.createElement("button");
  akbtn.type = "button";
  akbtn.className = "m3d-btn m3d-selbtn";
  akbtn.style.display = "none";
  akbtn.onclick = ev => {
    try { ev.stopPropagation(); } catch (e) {}
    const dd = st.armorDrop;
    if (dd) dd.style.display = dd.style.display === "none" ? "" : "none";
  };
  const drop = document.createElement("div");
  drop.className = "m3d-drop";
  drop.style.display = "none";
  drop.onclick = ev => {
    try { ev.stopPropagation(); } catch (e) {}
  };
  // Обёртка-якорь: панель позиционируется от кнопки, а не от края
  // диалога (абсолютный флекс-потомок без left уезжал влево)
  const wrap = document.createElement("span");
  wrap.className = "m3d-kindwrap";
  wrap.appendChild(akbtn);
  wrap.appendChild(drop);
  bar.appendChild(wrap);
  st.armorKindBtn = akbtn;
  st.armorDrop = drop;
  // Клик мимо панели закрывает её (снимаем при закрытии диалога)
  const dlg = st.pop;
  if (dlg && !dlg._armorDoc) {
    dlg._armorDoc = () => {
      try {
        if (st.armorDrop) st.armorDrop.style.display = "none";
      } catch (e) {}
    };
    document.addEventListener("click", dlg._armorDoc);
  }
  // Пулемёт: выбор гнезда поверх башни
  const mlab = document.createElement("span");
  mlab.className = "m3d-lab";
  mlab.textContent = t("m3d_mg_pick") || "";
  mlab.style.display = "none";
  bar.appendChild(mlab);
  st.mgLab = mlab;
  const msel = document.createElement("select");
  msel.className = "m3d-sel";
  msel.style.display = "none";
  msel.onchange = () => {
    // Пулемёт ставится на первичную башню набора (первую из порядка
    // установки): её меши пересобираются тем же add-путём, соседи стоят
    const prim = m3dTurretPrimary(st);
    if (!prim) return;
    const slots = st.turretSlots || {};
    m3dFetchTurret(st, prim, slots[prim] || "", msel.value || "");
  };
  bar.appendChild(msel);
  st.mgSel = msel;
  mkBtn("m3d_reset", false, () => { if (st.home) st.home(); });
  // Крестик — последним в ряду кнопок (верхней панели больше нет);
  // во вкладке древа закрывает вкладку, в попапе — диалог
  const x = document.createElement("button");
  x.type = "button";
  x.className = "m3d-btn m3d-xbtn";
  x.textContent = "✕";
  x.title = t("m3d_close") || "";
  x.onclick = () => {
    if (st && typeof st.onClose === "function") st.onClose();
    else m3dClose();
  };
  bar.appendChild(x);
}

// Набор башен: выпадашка с чекбоксами по вариантам (мультивыбор,
// как виды брони — каждую видно и снимать можно отдельно, все разом
// тоже). Состояние живёт в st.turretSet (пустой набор = все сняты).
// Первая загрузка встаёт на backend-selected, новые варианты после
// ответов включаются сами. Слоты вариантов — в st.turretSlots
// (для пулемёта и fetch).
function m3dRefreshTurretSel(st, data) {
  const btn = st.turretDropBtn, drop = st.turretDrop;
  if (!btn || !drop) return;
  const t = data.turret || (data.ok && data.rel ? data : null) || {};
  const ch = t.choices || [];
  const slots = {};
  ch.forEach(c => { slots[c.rel] = c.slot || ""; });
  st.turretSlots = slots;
  const list = ch.map(c => c.rel);
  drop.textContent = "";
  if (!st.turretKnown) st.turretKnown = [];
  if (!st.turretSet) {
    const sel = ch.filter(c => c.selected).map(c => c.rel);
    st.turretSet = new Set(sel.length ? sel : list.slice(0, 1));
  } else {
    list.forEach(rel => {
      if (st.turretKnown.indexOf(rel) < 0) st.turretSet.add(rel);
    });
  }
  st.turretKnown = list.slice();
  if (list.length < 2) {
    btn.style.display = "none";
    if (st.turretLab) st.turretLab.style.display = "none";
    drop.style.display = "none";
    return;
  }
  const on = st.turretSet;
  list.forEach(rel => {
    const c = ch.filter(x => x.rel === rel)[0] || {};
    const lab = document.createElement("label");
    lab.className = "m3d-check";
    lab.title = rel;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = on.has(rel);
    cb.onchange = () => {
      if (cb.checked) {
        const cslot = (st.turretSlots || {})[rel] || "";
        // Пулемёт нового варианта — по умолчанию (как смена селекта
        // раньше): выбор пулемёта живёт на первичной башне
        m3dFetchTurret(st, rel, cslot, "@@auto@@");
      } else {
        m3dRemoveTurret(st, rel);
      }
    };
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(c.label || rel));
    drop.appendChild(lab);
  });
  btn.style.display = "";
  if (st.turretLab) st.turretLab.style.display = "";
  m3dTurretDropBtn(st);
}

// Подпись кнопки набора: название + счётчик прикреплённых
function m3dTurretDropBtn(st) {
  const btn = st.turretDropBtn;
  if (!btn) return;
  const base = t("m3d_turret_pick") || "";
  const known = st.turretKnown || [];
  const on = st.turretSet;
  if (!on || known.every(k => on.has(k))) {
    btn.textContent = base + " ▾";
    return;
  }
  const n = known.filter(k => on.has(k)).length;
  btn.textContent = base + " (" + n + "/" + known.length + ") ▾";
}

// Выбор пулемёта поверх башни (из общего списка корпуса)
function m3dRefreshMgSel(st, t) {
  const sel = st.mgSel;
  if (!sel) return;
  const list = (t && t.mg_choices) || [];
  sel.options.length = 0;
  if (list.length < 2) {
    sel.style.display = "none";
    if (st.mgLab) st.mgLab.style.display = "none";
    return;
  }
  const active = (t && t.mg) || "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "—";
  if (!active) none.selected = true;
  sel.appendChild(none);
  list.forEach(m => {
    const o = document.createElement("option");
    o.value = m.rel;
    o.textContent = m.label || m.rel;
    if (active && m.rel === active) o.selected = true;
    sel.appendChild(o);
  });
  sel.style.display = "";
  if (st.mgLab) st.mgLab.style.display = "";
}

// Выбор видов брони: выпадашка с чекбоксами (мультивыбор,
// по умолчанию все включены). Состояние живёт в st.armorKinds
// (null = все) и переживает обмен башни: новые виды после обмена
// включаются сами
function m3dRefreshArmorSel(st, stat) {
  const btn = st.armorKindBtn, drop = st.armorDrop;
  if (!btn || !drop) return;
  const kinds = {};
  Object.keys(stat || {}).forEach(k => {
    const d = k.split("/")[0];
    if (d) kinds[d] = (kinds[d] || 0) + (stat[k] || 0);
  });
  const list = Object.keys(kinds).sort();
  drop.textContent = "";
  if (!st.armorKnown) st.armorKnown = [];
  if (st.armorKinds)
    list.forEach(k => {
      if (st.armorKnown.indexOf(k) < 0) st.armorKinds.add(k);
    });
  st.armorKnown = list.slice();
  if (list.length < 2) {
    btn.style.display = "none";
    if (st.armorLab) st.armorLab.style.display = "none";
    drop.style.display = "none";
    return;
  }
  const on = st.armorKinds; // null = все включены
  list.forEach(k => {
    const lab = document.createElement("label");
    lab.className = "m3d-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !on || on.has(k);
    cb.onchange = () => {
      let s = st.armorKinds;
      if (!s) {
        s = new Set(list);
        st.armorKinds = s;
      }
      if (cb.checked) s.add(k);
      else s.delete(k);
      m3dArmorKindBtn(st);
      m3dApplyVis(st);
    };
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(k + " (" + kinds[k] + ")"));
    drop.appendChild(lab);
  });
  btn.style.display = "";
  if (st.armorLab) st.armorLab.style.display = "";
  m3dArmorKindBtn(st);
}

// Подпись кнопки видов: название + счётчик выбранных
function m3dArmorKindBtn(st) {
  const btn = st.armorKindBtn;
  if (!btn) return;
  const base = t("m3d_armor_kind") || "";
  const known = st.armorKnown || [];
  const on = st.armorKinds;
  if (!on || known.every(k => on.has(k))) {
    btn.textContent = base + " ▾";
    return;
  }
  const n = known.filter(k => on.has(k)).length;
  btn.textContent = base + " (" + n + "/" + known.length + ") ▾";
}

// rel модели от слоя basis для /api/model_preview: всё после последнего
// /basis/ (DLC-оверлей бьёт базу тем же путём, ищет find_file бэкенда).
// Нет сегмента — файл не из игровых данных, превью не строим.
function m3dRelFromPath(path) {
  const v = String(path || "").replace(/\\/g, "/");
  const i = v.toLowerCase().lastIndexOf("/basis/");
  if (i === -1) return "";
  return v.slice(i + 7).replace(/^\/+/, "");
}

// Открыть .model из древа вкладкой: тело — тот же вьюер, что в редакторе
// юнитов (m3dStage/m3dFetch/m3dShowData, тот же /api/model_preview),
// попап не создаём. Повторный клик — переключение на готовую вкладку.
async function openModelFile(path) {
  if (!path) return;
  const np = (typeof normPath === "function") ? normPath(path) : String(path);
  const same = p => ((typeof normPath === "function") ? normPath(p) : String(p)) === np;
  try {
    const hit = (state.tabs || []).find(t => t.type === "model" && same(t.path || ""));
    if (hit) {
      activateTab(hit.id);
      try { markActiveTreeFile(path); } catch (e) {}
      return;
    }
  } catch (e) { /* древо ещё не готово */ }
  const origin = ((typeof fileOrigin === "function") ? fileOrigin(path) : null)
    || state.treeView || "project";
  const root = (typeof srcRoot === "function") ? (srcRoot(origin) || "") : "";
  const rel = m3dRelFromPath(path);
  if (!root || !rel) {
    toast(t("m3d_err_nofile") || "3D error", "err");
    return;
  }
  const tab = createTab("model", { path });
  const panel = document.createElement("section");
  panel.className = "tab-panel model-tab";
  panel.dataset.tabId = tab.id;
  panel.role = "tabpanel";
  const bar = document.createElement("div");
  bar.className = "m3d-bar";
  const view = document.createElement("div");
  view.className = "m3d-view";
  view.innerHTML = '<div class="m3d-cube"><div class="m3d-cube-inner">' +
    '<i></i><i></i><i></i><i></i><i></i><i></i></div></div>' +
    '<div class="m3d-status"></div>' +
    '<div class="m3d-pbar"><i></i></div>' +
    '<div class="m3d-tprog" style="display:none"><span></span><i><b></b></i></div>' +
    '<div class="m3d-perf"></div>' +
    '<div class="m3d-err" hidden></div>';
  try { view.querySelector(".m3d-status").textContent = t("m3d_loading") || ""; }
  catch (e) { /* подпись необязательна */ }
  panel.appendChild(bar);
  panel.appendChild(view);
  $("#tab-panels").appendChild(panel);
  renderTabBar();
  activateTab(tab.id);
  try { markActiveTreeFile(path); } catch (e) {}
  if (state.config && state.config.auto_hide_tree) {
    state.sidebarCollapsed = true;
    try { updateSidebarVisibility(); } catch (e) {}
  }
  m3dLibs(ok => {
    if (!panel.isConnected) return;
    const fail = msg => {
      try { view.querySelector(".m3d-cube").remove(); } catch (e) {}
      try { view.querySelector(".m3d-status").remove(); } catch (e2) {}
      try { view.querySelector(".m3d-pbar").remove(); } catch (e3) {}
      const box = view.querySelector(".m3d-err");
      if (box) { box.textContent = msg; box.hidden = false; }
    };
    if (!ok) { fail(t("m3d_err_lib") || "3D error"); return; }
    // Сцена сразу: свет и камера есть до прихода геометрии
    const st = m3dStage(panel, view, bar, root);
    if (!st) { fail(t("m3d_err_lib") || "3D error"); return; }
    // Крестик в баре вьюера закрывает вкладку (в попапе — диалог)
    st.onClose = () => { try { closeTab(tab.id); } catch (e) {} };
    tab._m3d = st;
    const key = m3dCacheKey(root, rel, "", path);
    st.cacheKey = key;
    const hitC = m3dCacheGet(key);
    if (hitC && hitC.data && hitC.data.ok) {
      // Модель уже загружена: строим мгновенно, сеть не трогаем
      st.params = { root: root, value: rel, cat: "", sys: "",
        turret: (hitC.data.turret && hitC.data.turret.rel) || "@@auto@@" };
      st.fromCache = true;
      m3dShowData(st, hitC.data, true);
      return;
    }
    m3dProgress(st, 0.15);
    m3dFetch(st, { root: root, value: rel, cat: "", sys: "",
      turret: m3dTurretPick.get(key) || "@@auto@@" }, true);
  });
}

// Уборка вкладки 3D-превью (зовёт closeTab): гасим цикл рендера,
// снимаем наблюдатели и чистим GL-ресурсы. Панель сносит сам closeTab.
function m3dDisposeTab(tab) {
  const st = (tab && tab._m3d) || null;
  if (tab) { try { tab._m3d = null; } catch (e) {} }
  if (!st) return;
  const host = st.pop;
  try { if (host && host._raf) cancelAnimationFrame(host._raf); } catch (e) {}
  try { if (host && host._ro) host._ro.disconnect(); } catch (e) {}
  try {
    if (host && host._armorDoc)
      document.removeEventListener("click", host._armorDoc);
  } catch (e) {}
  try {
    if (host && host._turretDoc)
      document.removeEventListener("click", host._turretDoc);
  } catch (e) {}
  try {
    (st.disposables || []).forEach(d => {
      try { if (d.dispose) d.dispose(); else d(); } catch (e2) {}
    });
  } catch (e) {}
  try {
    Object.keys(st.texCache || {}).forEach(k => {
      try { st.texCache[k].dispose(); } catch (e2) {}
    });
  } catch (e) {}
}
