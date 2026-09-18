/* TerminatorToolSet frontend — campaign3d.js: 3D-превью глобальной карты.
   Временный изолированный режим поверх редактора кампании: кнопка «3D»
   в шапке переключает плитки на 3D-сцену. campaign.js НЕ трогаем —
   состояние своё (state.camp3d), все id — с префиксом cmp3d-.
   Этап 0: только каркас переключения; сцена приедет на этапе 1. */
"use strict";

// ---------- state ----------
function cmp3dFreshState() {
  return { on: false };
}
function cmp3dIsOn() {
  return !!(state.camp3d && state.camp3d.on);
}

// ---------- toggle ----------
function cmp3dToggle() {
  if (!state.camp3d) state.camp3d = cmp3dFreshState();
  state.camp3d.on = !state.camp3d.on;
  cmp3dPaint();
}
function cmp3dPaint() {
  const on = cmp3dIsOn();
  const btn = $("#cmp-3d");
  if (btn) {
    // Временная кнопка не зависит от загрузки shop_presets.xml
    // (карта из «Игры») — видна всегда, в отличие от соседних
    btn.hidden = false;
    btn.classList.toggle("is-on", on);
    btn.textContent = on ? "2D" : (t("cpg_3d") || "3D");
  }
  // Прячем только карту с плитками; правая панель (магазин/найм/
  // снабжение) остаётся — на этапе 4 она откроется при выборе сектора
  const map = $("#cmp-map"), view = $("#cmp3d-view");
  const wrap = $("#cmp-wrap");
  if (map) map.hidden = on;
  // 3D — отдельная страница: прячем всю витрину с плитками,
  // сцена занимает вкладку целиком; назад — возвращаем как было
  if (wrap && view) {
    if (on) {
      if (view._wrapWas === undefined) view._wrapWas = wrap.hidden;
      wrap.hidden = true;
    } else if (view._wrapWas !== undefined) {
      wrap.hidden = view._wrapWas;
      view._wrapWas = undefined;
    }
  }
  if (view) {
    view.hidden = !on;
    // Уход со сцены — останавливаем цикл и возвращаем ресурсы;
    // следующий вход строит сцену заново (корень мог смениться)
    if (!on && view._cmp3dReady) {
      view._cmp3dReady = false;
      cmp3dDispose(view);
    }
    if (on) cmp3dEnsure(view);
  }
}
// ---------- tuning ----------
// Наклон камеры как в игре (подобрать по camera_angle.jpg на этапе 5):
// высота над горизонтом и азимут взгляда; дистанция — от размера карты
var CMP3D_ELEV = 52, CMP3D_AZIM = 0;
var CMP3D_VALUE = "models\\global_map\\glbmp_main.model";
// Карта в модели лежит повёрнутой: доворачиваем саму группу мешей
// на 90° по часовой (вид сверху). Камеру не трогаем.
// Координаты точек из global_map.swt позже пройдут через тот же доворот
var CMP3D_MAP_ROT = -Math.PI / 2;
// Стартовая точка — центр Техаса (среднее 15 POI штата):
// игра открывает карту регионом, TEXAS читается крупно
var CMP3D_HOME = [-165, 3, -338];
// Мелкая сетка как в игре (линии + точки на пересечениях)
var CMP3D_GRID = 28;

// ---------- libs ----------
// Ленивая подгрузка three.js — копия m3dLibs своим состоянием,
// чтобы не трогать ядро model3d.js
var cmp3dLibState = 0, cmp3dLibQueue = [];
function cmp3dLibs(cb) {
  if (typeof THREE !== "undefined" && THREE.WebGLRenderer &&
      THREE.OrbitControls) { cb(true); return; }
  if (cmp3dLibState === 2) { cb(true); return; }
  cmp3dLibQueue.push(cb);
  if (cmp3dLibState === 1) return;
  cmp3dLibState = 1;
  const done = ok => {
    cmp3dLibState = ok ? 2 : 0;
    const q = cmp3dLibQueue.splice(0);
    q.forEach(f => { try { f(ok); } catch (e) {} });
  };
  const load = (url, next) => {
    const s = document.createElement("script");
    s.src = url;
    s.onload = () => next(true);
    s.onerror = () => next(false);
    document.head.appendChild(s);
  };
  load("/static/js/vendor/three.min.js", ok => {
    if (!ok) { done(false); return; }
    load("/static/js/vendor/OrbitControls.js", done);
  });
}

// Этап 1 построит здесь сцену; пока — заглушка со статусом
function cmp3dEnsure(view) {
  if (view._cmp3dReady) return;
  view._cmp3dReady = true;
  cmp3dBoot(view);
}
function cmp3dStatus(view, msg) {
  const st = view.querySelector(".cmp3d-status");
  if (st) st.textContent = msg;
}
// Первая стадия: рендер, свой свет, камера-пан, цикл — копия m3dStage
// под карту: чёрный фон + чёрный туман к краям, вращение и зум
// запрещены (только панорама), студийного света ядра нет
function cmp3dBoot(view) {
  const box = view.querySelector(".cmp3d-view");
  cmp3dStatus(view, t("m3d_loading") || "Загрузка…");
  cmp3dLibs(ok => {
    if (!view.isConnected) return;
    if (!ok || !box) {
      cmp3dStatus(view, t("m3d_err_lib") || "3D error");
      return;
    }
    const W = () => box.clientWidth || 640;
    const H = () => box.clientHeight || 480;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({antialias: true});
    } catch (e) {
      cmp3dStatus(view, t("m3d_err_lib") || "3D error");
      return;
    }
    let softGL = false;
    try {
      const gl = renderer.getContext();
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      const gpuName = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "")
        : String(gl.getParameter(gl.RENDERER) || "");
      softGL = /swiftshader|software|llvmpipe|basic render|angle \(google/i.test(gpuName);
    } catch (e) {}
    renderer.setPixelRatio(softGL ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W(), H());
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    box.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    // Туман в игре по краям чёрный: обрыв модели тонет в фоне
    scene.fog = new THREE.Fog(0x000000, 400, 1400);
    const camera = new THREE.PerspectiveCamera(45, W() / H(), 0.5, 5000);
    const ctl = new THREE.OrbitControls(camera, renderer.domElement);
    ctl.enableDamping = true;
    ctl.dampingFactor = 0.08;
    // Только передвижение по карте: вращать и менять ракурс/зум нельзя
    ctl.enableRotate = false;
    ctl.enableZoom = false;
    ctl.screenSpacePanning = false;
    ctl.target.set(0, 0, 0);
    // Свой свет: ключ почти строго сверху по light.xml
    // (direction 0,0,-1.37), оттенки полусферы — цвета из global_map.lighting
    // Рельеф лепит направленный ключ, фил слабый — иначе всё
    // выбеливается в плоскую кашу (как было при hemi 1.15)
    scene.add(new THREE.HemisphereLight(0x547682, 0x233236, 0.22));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    // Лёгкий наклон для лепки рельефа (в игре горы с теневой стороной)
    key.position.set(15, 100, -45);
    scene.add(key);
    const group = new THREE.Group();
    group.rotation.y = CMP3D_MAP_ROT;
    scene.add(group);
    const st = {view: view, box: box, root: "",
      renderer: renderer, scene: scene, camera: camera, ctl: ctl,
      group: group, softGL: softGL, texCache: {},
      disposables: [renderer], home: null, bounds: null};
    view._cmp3d = st;
    st.texMgr = new THREE.LoadingManager();
    st.texMgr.onStart = (url, loaded, total) => {
      cmp3dStatus(view, "tex " + loaded + "/" + total);
    };
    st.texMgr.onProgress = (url, loaded, total) => {
      cmp3dStatus(view, "tex " + loaded + "/" + total);
    };
    st.texMgr.onLoad = () => cmp3dStatus(view, "");
    const loop = () => {
      if (!view.isConnected || view._cmp3d !== st) return;
      ctl.update();
      renderer.render(scene, camera);
      view._cmp3dRaf = requestAnimationFrame(loop);
    };
    loop();
    try {
      st.ro = new ResizeObserver(() => {
        try {
          camera.aspect = W() / H();
          camera.updateProjectionMatrix();
          renderer.setSize(W(), H());
        } catch (e) {}
      });
      st.ro.observe(box);
    } catch (e) {}
    cmp3dFetch(st);
  });
}
// Остановка цикла и возврат ресурсов при уходе со сцены
function cmp3dDispose(view) {
  const st = view._cmp3d;
  if (!st) return;
  view._cmp3d = null;
  try { cancelAnimationFrame(view._cmp3dRaf); } catch (e) {}
  try { st.ro && st.ro.disconnect(); } catch (e) {}
  st.group.children.slice().forEach(mesh => {
    st.group.remove(mesh);
    try { mesh.geometry.dispose(); } catch (e) {}
    const mt = mesh.material;
    if (mt) {
      (mt.userData.tex || []).forEach(tx => { try { tx.dispose(); } catch (e) {} });
      try { mt.dispose(); } catch (e2) {}
    }
  });
  // Внесценовые довески (сетка): снять со сцены и вернуть ресурсы
  (st.sceneExtras || []).forEach(o => {
    try { st.scene.remove(o); } catch (e) {}
    try { o.geometry.dispose(); } catch (e2) {}
    try { o.material.dispose(); } catch (e3) {}
  });
  st.sceneExtras = [];
  try { st.renderer.dispose(); } catch (e) {}
  try { st.renderer.domElement.remove(); } catch (e) {}
}
// Геометрия карты — тот же /api/model_preview, башен нет
function cmp3dFetch(st) {
  const view = st.view;
  try {
    st.root = (typeof cmpSrcRoot === "function") ? cmpSrcRoot() : "";
  } catch (e) { st.root = ""; }
  cmp3dStatus(view, t("m3d_loading") || "Загрузка…");
  fetch("/api/model_preview", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({root: st.root || "",
      value: CMP3D_VALUE, turret: "", mg: ""}),
  }).then(r => r.json()).catch(() => ({ok: false, error: "net"})
  ).then(data => {
    if (!view.isConnected || view._cmp3d !== st) return;
    if (!data || !data.ok) {
      cmp3dStatus(view, String((data && data.error) || "error"));
      return;
    }
    cmp3dStatus(view, "tex 0/…");
    cmp3dAddMeshes(st, data);
    cmp3dHome(st);
    cmp3dGrid(st);
    cmp3dStatus(view, "");
  });
}
// Меши карты — урезанная копия m3dAddMeshes: без брони/башен,
// текстуры albedo/normal/rough через /api/model_tex в рантайм-кэш
function cmp3dAddMeshes(st, data) {
  const texLoader = new THREE.TextureLoader(st.texMgr);
  texLoader.setCrossOrigin("anonymous");
  const maxAniso = st.renderer.capabilities.getMaxAnisotropy();
  const texUrl = (rel, slot) => "/api/model_tex?root=" + encodeURIComponent(st.root || "") +
    "&rel=" + encodeURIComponent(rel || "") + "&model=glbmp_main" +
    "&slot=" + encodeURIComponent({map: "albedo", normalMap: "normal",
      roughnessMap: "rough", emissiveMap: "emission"}[slot] || "");
  (data.meshes || []).forEach(m => {
    const p = m.positions || [], n = m.normals || [], u = m.uvs || [], ix = m.indices || [];
    if (!p.length || !ix.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
    if (n.length === p.length) g.setAttribute("normal", new THREE.Float32BufferAttribute(n, 3));
    else g.computeVertexNormals();
    if (u.length === (p.length / 3) * 2) g.setAttribute("uv", new THREE.Float32BufferAttribute(u, 2));
    g.setIndex(ix);
    const mi = (m.material != null) ? m.material : -1;
    const md = (data.materials && data.materials[mi]) || null;
    const mat = st.softGL
      ? new THREE.MeshLambertMaterial({color: 0xffffff})
      : new THREE.MeshStandardMaterial({
        color: 0xffffff, metalness: 0.05, roughness: 0.85,
      });
    mat.userData.tex = [];
    mat.userData.slots = {map: null, normalMap: null, roughnessMap: null,
      emissiveMap: null};
    if (md && !md.missing) {
      cmp3dWantTex(st, texLoader, maxAniso, texUrl, mat, "map", md.albedo, true);
      cmp3dWantTex(st, texLoader, maxAniso, texUrl, mat, "normalMap", md.normal, false);
      if (!st.softGL) cmp3dWantTex(st, texLoader, maxAniso, texUrl,
        mat, "roughnessMap", md.rough, false);
      // Ночные огни и светящиеся дороги: emission двигает цвет сильнее
      // всего (без него карта тусклая)
      cmp3dWantTex(st, texLoader, maxAniso, texUrl, mat, "emissiveMap",
        md.emission, true);
      // Декали штатов/точек (IsTransparent): только прозрачность фона —
      // геометрию не трогаем, TEXAS парит как задумано
      if (md.transparent) {
        mat.transparent = true;
        mat.depthWrite = false;
      }
      if (md.double_sided) mat.side = THREE.DoubleSide;
    } else {
      mat.color.setHex(0x9aa0a8);
    }
    const mesh = new THREE.Mesh(g, mat);
    mesh.userData.title = [m.name, m.node].filter(Boolean).join(" @ ");
    st.group.add(mesh);
    st.disposables.push(g, mat);
    mat.userData.tex.forEach(tx => st.disposables.push(tx));
  });
}
// Текстура готова: назначаем на материал; emission включает свечение
function cmp3dTexReady(st, mat, slot) {
  try {
    const tx = mat.userData.slots[slot];
    if (!tx) return;
    mat[slot] = tx;
    if (slot === "emissiveMap") {
      mat.emissive = new THREE.Color(0xffffff);
      // Дороги и огни светятся, но не выбеливают террейн
      mat.emissiveIntensity = 0.35;
    }
    mat.needsUpdate = true;
  } catch (e) {}
}
// Заказ текстуры в фон с дедупом — копия m3dWantTex (назначение всегда,
// тумблера текстур на карте нет)
function cmp3dWantTex(st, texLoader, maxAniso, texUrl, mat, slot, rel, srgb) {
  if (!rel) return;
  const key = (srgb ? "s" : "l") + rel;
  let tx = st.texCache[key];
  if (!tx) {
    try {
      tx = texLoader.load(texUrl(rel, slot),
        () => cmp3dTexReady(st, mat, slot));
      if (srgb) tx.encoding = THREE.sRGBEncoding;
      tx.anisotropy = maxAniso;
      tx.wrapS = THREE.RepeatWrapping;
      tx.wrapT = THREE.RepeatWrapping;
    } catch (e) { return; }
    st.texCache[key] = tx;
  }
  mat.userData.slots[slot] = tx;
  // Уже готовая (кэш/повтор) — назначаем сразу
  try {
    if (tx.image && tx.image.complete !== false && tx.image.width)
      cmp3dTexReady(st, mat, slot);
  } catch (e) {}
}
// Мелкая сетка как в игре: линии + точки на пересечениях,
// ложатся на рельеф (рейкаст вниз). Строится в мировых координатах,
// доворот карты уже учтён боксом
function cmp3dGrid(st) {
  try {
    if (!st.bounds) return;
    const bb = st.bounds;
    const n = CMP3D_GRID, seg = 16;
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const top = bb.max.y + 50;
    const drape = (x, z) => {
      ray.set(new THREE.Vector3(x, top, z), down);
      const hit = ray.intersectObjects(st.group.children, false);
      return hit.length ? hit[0].point.y + 0.4 : null;
    };
    const lp = [], dp = [];
    for (let i = 0; i <= n; i++) {
      const fx = bb.min.x + (bb.max.x - bb.min.x) * i / n;
      const fz = bb.min.z + (bb.max.z - bb.min.z) * i / n;
      let prev = null;
      for (let j = 0; j <= seg; j++) {
        const z = bb.min.z + (bb.max.z - bb.min.z) * j / seg;
        const y = drape(fx, z);
        if (y === null) { prev = null; continue; }
        if (prev) lp.push(prev[0], prev[1], prev[2], fx, y, z);
        prev = [fx, y, z];
      }
      prev = null;
      for (let j = 0; j <= seg; j++) {
        const x = bb.min.x + (bb.max.x - bb.min.x) * j / seg;
        const y = drape(x, fz);
        if (y === null) { prev = null; continue; }
        if (prev) lp.push(prev[0], prev[1], prev[2], x, y, fz);
        prev = [x, y, fz];
      }
      const cy = drape(fx, fz);
      if (cy !== null) dp.push(fx, cy + 0.1, fz);
    }
    if (!lp.length) return;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.Float32BufferAttribute(lp, 3));
    const lm = new THREE.LineBasicMaterial({color: 0x9fc0c0,
      transparent: true, opacity: 0.16});
    const lines = new THREE.LineSegments(lg, lm);
    st.scene.add(lines);
    st.disposables.push(lg, lm);
    (st.sceneExtras = st.sceneExtras || []).push(lines);
    if (dp.length) {
      const dg = new THREE.BufferGeometry();
      dg.setAttribute("position", new THREE.Float32BufferAttribute(dp, 3));
      const dm = new THREE.PointsMaterial({color: 0xcfe8e8, size: 2,
        sizeAttenuation: false, transparent: true, opacity: 0.45});
      const dots = new THREE.Points(dg, dm);
      st.scene.add(dots);
      st.disposables.push(dg, dm);
      (st.sceneExtras = st.sceneExtras || []).push(dots);
    }
  } catch (e) {}
}
// Домой: стартуем с Техаса крупно (как игра), дистанция — доля радиуса
function cmp3dHome(st) {
  try {
    const bb = new THREE.Box3().setFromObject(st.group);
    if (bb.isEmpty()) return;
    const r = bb.getSize(new THREE.Vector3()).length() / 2;
    const el = CMP3D_ELEV * Math.PI / 180, az = CMP3D_AZIM * Math.PI / 180;
    const dist = r * 0.5;
    const c = new THREE.Vector3(CMP3D_HOME[0], CMP3D_HOME[1], CMP3D_HOME[2]);
    // доворот группы меняет мировые координаты цели
    st.group.updateMatrixWorld(true);
    c.applyMatrix4(st.group.matrixWorld);
    st.camera.position.set(
      c.x + dist * Math.cos(el) * Math.sin(az),
      c.y + dist * Math.sin(el),
      c.z + dist * Math.cos(el) * Math.cos(az));
    st.ctl.target.copy(c);
    st.ctl.update();
    st.home = {target: c.clone(), dist: dist};
    st.bounds = bb;
    // Ближний план чистый, дальний обрыв тонет в чёрном
    // (на близком плане туман почти не виден, как в игре)
    st.scene.fog.near = dist * 1.5;
    st.scene.fog.far = dist * 5;
  } catch (e) {}
}

// ---------- setup ----------
function setupCampaign3d() {
  if (!state.camp3d) state.camp3d = cmp3dFreshState();
  const btn = $("#cmp-3d");
  if (btn) btn.onclick = () => cmp3dToggle();
  cmp3dPaint();
}
