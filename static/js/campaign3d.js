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
    // Сцена переживает переключения: цикл спит, геометрия и текстуры
    // остаются — повторный вход мгновенный, без перезаказа
    if (!on && view._cmp3d) cmp3dSleep(view, true);
    if (on) cmp3dEnsure(view);
  }
}
// Пауза/продолжение цикла (вкладка скрыта — GPU не жжём, ресурсы держим)
function cmp3dSleep(view, sleep) {
  const st = view._cmp3d;
  if (!st) return;
  st.sleep = !!sleep;
  if (sleep) {
    try { cancelAnimationFrame(view._cmp3dRaf); } catch (e) {}
    view._cmp3dRaf = 0;
  } else if (!view._cmp3dRaf) {
    cmp3dLoop(view, st);
  }
}
// Кадровый цикл отдельно — чтобы будить его без перестройки сцены
function cmp3dLoop(view, st) {
  const loop = () => {
    if (!view.isConnected || view._cmp3d !== st) return;
    if (st.sleep || view.hidden) { view._cmp3dRaf = 0; return; }
    st.ctl.update();
    st.renderer.render(st.scene, st.camera);
    view._cmp3dRaf = requestAnimationFrame(loop);
  };
  loop();
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
// Свет карты одним местом (диагностика возвращает ровно эти значения)
var CMP3D_KEY = 1.1, CMP3D_HEMI = 0.22, CMP3D_EXPO = 1.0;

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
    load("/static/js/vendor/OrbitControls.js", ok2 => {
      if (!ok2) { done(false); return; }
      // ВРЕМЕННЫЙ эксперимент DDS без конвертации (клавиша 9):
      // грузим всегда, файл маленький
      load("/static/js/vendor/DDSLoader.js", done);
    });
  });
}

// Вход на сцену: живая — будим цикл (корень тот же — мгновенно),
// чужой корень (Проект|Игра|Мод переключили) — пересобираем
function cmp3dEnsure(view) {
  let root = "";
  try {
    root = (typeof cmpSrcRoot === "function") ? cmpSrcRoot() : "";
  } catch (e) { root = ""; }
  if (view._cmp3d && view._cmp3d.rootKey === (root || "")) {
    try {
      view._cmp3d.camera.aspect =
        view._cmp3d.box.clientWidth / view._cmp3d.box.clientHeight;
      view._cmp3d.camera.updateProjectionMatrix();
      view._cmp3d.renderer.setSize(view._cmp3d.box.clientWidth,
        view._cmp3d.box.clientHeight);
    } catch (e) {}
    cmp3dSleep(view, false);
    return;
  }
  if (view._cmp3d) cmp3dDispose(view);
  cmp3dBoot(view, root || "");
}
function cmp3dStatus(view, msg) {
  const st = view.querySelector(".cmp3d-status");
  if (st) st.textContent = msg;
}
// Первая стадия: рендер, свой свет, камера-пан, цикл — копия m3dStage
// под карту: чёрный фон + чёрный туман к краям, вращение и зум
// запрещены (только панорама), студийного света ядра нет
function cmp3dBoot(view, root) {
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
    renderer.toneMappingExposure = CMP3D_EXPO;
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
    const hemi = new THREE.HemisphereLight(0x3f748f, 0x233236, CMP3D_HEMI);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, CMP3D_KEY);
    // Лёгкий наклон для лепки рельефа (в игре горы с теневой стороной)
    key.position.set(15, 100, -45);
    scene.add(key);
    const group = new THREE.Group();
    group.rotation.y = CMP3D_MAP_ROT;
    scene.add(group);
    const st = {view: view, box: box, root: "",
      renderer: renderer, scene: scene, camera: camera, ctl: ctl,
      key: key, hemi: hemi, _fog: scene.fog,
      group: group, softGL: softGL, texCache: {},
      disposables: [renderer], home: null, bounds: null};
    view._cmp3d = st;
    st.rootKey = root || "";
    st.texMgr = new THREE.LoadingManager();
    st.texMgr.onStart = (url, loaded, total) => {
      cmp3dStatus(view, "tex " + loaded + "/" + total);
    };
    st.texMgr.onProgress = (url, loaded, total) => {
      cmp3dStatus(view, "tex " + loaded + "/" + total);
    };
    st.texMgr.onLoad = () => cmp3dStatus(view, "");
    cmp3dLoop(view, st);
    cmp3dDbg(view);
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
// Геометрия карты — тот же /api/model_preview, башен нет.
// Корень уже выбран в cmp3dEnsure (st.rootKey) — здесь не меняем,
// иначе повторный вход перезакажет геометрию
function cmp3dFetch(st) {
  const view = st.view;
  st.root = st.rootKey || "";
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
    // Слои по именам текстур, не по индексам — порядок мешей
    // в модели может плавать
    var isGhost = /state_names/.test((md && md.albedo) || "");
    var isUnder = /undercoat/.test((md && md.albedo) || "");
    // Подложка — неосвещаемая: чёрная внутри своих ячеек всегда,
    // светиться белым ей физически нечем (ни ключа, ни свечения).
    // Только albedo-карта (тёмная) + прозрачность рамки
    const mat = (isUnder && !st.softGL)
      ? new THREE.MeshBasicMaterial({color: 0xffffff})
      : st.softGL
      ? new THREE.MeshLambertMaterial({color: 0xffffff})
      : new THREE.MeshStandardMaterial({
        color: 0xffffff, metalness: 0.05, roughness: 0.85,
      });
    mat.userData.tex = [];
    mat.userData.slots = {map: null, normalMap: null, roughnessMap: null,
      emissiveMap: null};
    if (md && !md.missing) {
      mat.userData.albedoRel = md.albedo || "";
      cmp3dWantTex(st, texLoader, maxAniso, texUrl, mat, "map", md.albedo, true);
      if (isUnder) {
        // Подложке — только карту и прозрачность, остального нет:
        // ни нормалей, ни шершавости, ни свечения
        mat.userData.emissionPower = 0;
      } else {
        cmp3dWantTex(st, texLoader, maxAniso, texUrl, mat, "normalMap", md.normal, false);
        if (!st.softGL) cmp3dWantTex(st, texLoader, maxAniso, texUrl,
          mat, "roughnessMap", md.rough, false);
      }
      // Ночные огни и светящиеся дороги: сила — из материала
      // (террейн 0.6). Подложка свечения не получает вообще: её
      // белёсый emissive в 2 см под террейном и давал вуаль
      // (z-fighting на дистанции). Декали штатов (state_names:
      // текст чуть темнее фона в R, emission-слот пустой) светим
      // проявкой из albedo через canvas — иначе либо белые
      // простыни, либо ничего не видно
      if (!isGhost && !isUnder) cmp3dWantTex(st, texLoader, maxAniso,
        texUrl, mat, "emissiveMap", md.emission, true);
      else if (isGhost) cmp3dDecalEmissive(st,
        texUrl(md.albedo, "emissiveMap"), mat, md.emission_power || 2.0);
      mat.userData.emissionPower =
        (isGhost || isUnder) ? 0 : (md.emission_power || 0);
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
    // Подложка — скрытая база под террейном: топим на метр вниз.
    // Вида не меняет (она и так под ним), но убивает z-fighting
    if (typeof isUnder !== "undefined" && isUnder) mesh.position.y -= 1.0;
    mesh.userData.mid = mi;
    mesh.userData.title = [m.name, m.node].filter(Boolean).join(" @ ");
    st.group.add(mesh);
    st.disposables.push(g, mat);
    mat.userData.tex.forEach(tx => st.disposables.push(tx));
  });
}
// Проявка текста декалей: буквы темнее фона в R — инверсия
// с растяжкой в свечение (фон уходит в чёрный, вуали нет).
// Грузим через общий менеджер — статус «tex» ждёт и проявку,
// скрин раньше готовности исключён. Сила — decalPower, её же
// возвращают клавиши 5/0 (иначе текст умирал до перезахода)
function cmp3dDecalEmissive(st, url, mat, power) {
  if (!url || mat.userData.decalOn) return;
  mat.userData.decalOn = true;
  mat.userData.decalPower = power || 2.0;
  const tl = new THREE.TextureLoader(st.texMgr);
  tl.setCrossOrigin("anonymous");
  tl.load(url, tx => {
    try {
      const img = tx.image;
      const cv = document.createElement("canvas");
      cv.width = img.width; cv.height = img.height;
      const cx = cv.getContext("2d");
      cx.drawImage(img, 0, 0);
      const id = cx.getImageData(0, 0, cv.width, cv.height);
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        let v = (255 - d[i]) * 4 - 30;
        v = v < 0 ? 0 : (v > 255 ? 255 : v);
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
      cx.putImageData(id, 0, 0);
      try { tx.dispose(); } catch (e0) {}
      const dt = new THREE.CanvasTexture(cv);
      mat.emissiveMap = dt;
      mat.emissive = new THREE.Color(0xffffff);
      mat.emissiveIntensity = mat.userData.decalPower;
      mat.needsUpdate = true;
      mat.userData.tex.push(dt);
      st.disposables.push(dt);
    } catch (e) {}
  }, undefined, () => {});
}
function cmp3dTexReady(st, mat, slot) {
  try {
    const tx = mat.userData.slots[slot];
    if (!tx) return;
    mat[slot] = tx;
    if (slot === "emissiveMap") {
      mat.emissive = new THREE.Color(0xffffff);
      // Дороги и огни светятся, но не выбеливают террейн
      mat.emissiveIntensity = mat.userData.emissionPower || 0;
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
        () => cmp3dTexReady(st, mat, slot), undefined,
        () => { try { cmp3dStatus(st.view, "tex FAIL " + rel); }
          catch (e2) {} });
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
// ВРЕМЕННАЯ диагностика вуали (убрать после поимки): 1 террейн,
// ВРЕМЕННЫЙ эксперимент (убрать после опыта): клавиша 9 гоняет
// albedo подложки webp-кэш <-> сырой DDS напрямую (без конвертации).
// Сжатым текстурам flipY не применяется — картинка может быть
// перевёрнута по вертикали, для вопроса «вуаль или нет» неважно
function cmp3dDdsSwap(view, st) {
  st._ddsOn = !st._ddsOn;
  if (st._ddsOn && typeof THREE.DDSLoader === "undefined") {
    st._ddsOn = false;
    cmp3dStatus(view, "DBG no DDSLoader");
    return;
  }
  if (st._ddsOn) {
    let s3tc = null;
    try {
      s3tc = st.renderer.extensions.get("WEBGL_compressed_texture_s3tc");
    } catch (e) {}
    if (!s3tc) {
      st._ddsOn = false;
      cmp3dStatus(view, "DBG no S3TC in GPU");
      return;
    }
  }
  const loader = st._ddsOn ? new THREE.DDSLoader() : null;
  st.group.children.forEach(m => {
    const mt = m.material;
    if (!mt || !/undercoat/.test(mt.userData.albedoRel || "")) return;
    if (st._ddsOn) {
      if (!mt.userData.webpMap) mt.userData.webpMap = mt.map;
      const url = "/api/model_dds?root=" + encodeURIComponent(st.root || "") +
        "&rel=" + encodeURIComponent(mt.userData.albedoRel);
      loader.load(url, tx => {
        try {
          tx.encoding = THREE.sRGBEncoding;
          tx.anisotropy =
            st.renderer.capabilities.getMaxAnisotropy();
          mt.map = tx;
          mt.needsUpdate = true;
          mt.userData.tex.push(tx);
          st.disposables.push(tx);
        } catch (e) {}
      }, undefined, () => cmp3dStatus(view, "DBG DDS load fail"));
    } else if (mt.userData.webpMap) {
      mt.map = mt.userData.webpMap;
      mt.needsUpdate = true;
    }
  });
  cmp3dStatus(view, st._ddsOn ? "DBG DDS direct (no convert)" :
    "DBG WEBP cache");
}
// 2 подложка, 3 декали, 5 свечение, 6 свет, 7 туман,
// 8 только террейн, 0 — вернуть всё. Только на открытой 3D-карте.
function cmp3dDbg(view) {
  if (view._cmp3dDbg) return;
  view._cmp3dDbg = true;
  document.addEventListener("keydown", e => {
    if (!cmp3dIsOn() || !view._cmp3d || view.hidden) return;
    const k = (e.key || "");
    if (k !== "0" && k !== "1" && k !== "2" && k !== "3" &&
        k !== "5" && k !== "6" && k !== "7" && k !== "8" &&
        k !== "9") return;
    const st = view._cmp3d;
    const show = what => {
      st.group.children.forEach(m => {
        const mid = m.userData.mid;
        if (what === "all") {
          m.visible = true;
        } else if (what === "tonly") {
          m.visible = (mid === 3);
        } else {
          if (what === "terrain" && mid === 3) m.visible = !m.visible;
          if (what === "under" && (mid === 0 || mid === 1 || mid === 4))
            m.visible = !m.visible;
          if (what === "decal" && mid === 2) m.visible = !m.visible;
        }
      });
      if (what === "all") {
        st.group.children.forEach(m => {
          try {
            if (m.material && m.material.emissive)
              m.material.emissiveIntensity =
                m.material.userData.decalPower ||
                m.material.userData.emissionPower || 0;
          } catch (e3) {}
        });
        st._emisOff = false;
        st._lightsOff = false;
        st._fogOff = false;
        try {
          st.key.intensity = CMP3D_KEY;
          st.hemi.intensity = CMP3D_HEMI;
        } catch (e4) {}
        try { st.scene.fog = st._fog; } catch (e5) {}
      }
      if (what === "emis") {
        st._emisOff = !st._emisOff;
        st.group.children.forEach(m => {
          try {
            if (m.material && m.material.emissive)
              m.material.emissiveIntensity = st._emisOff ? 0 :
                (m.material.userData.decalPower ||
                  m.material.userData.emissionPower || 0);
          } catch (e2) {}
        });
      }
      if (what === "lights") {
        st._lightsOff = !st._lightsOff;
        try {
          st.key.intensity = st._lightsOff ? 0 : CMP3D_KEY;
          st.hemi.intensity = st._lightsOff ? 0 : CMP3D_HEMI;
        } catch (e6) {}
      }
      if (what === "fog") {
        st._fogOff = !st._fogOff;
        try { st.scene.fog = st._fogOff ? null : st._fog; } catch (e7) {}
      }
      const vis = st.group.children.map(m => m.visible ? 1 : 0).join("");
      cmp3dStatus(view, "DBG key=" + k + " meshes[" + vis + "]" +
        (st._emisOff ? " EMIS-OFF" : "") +
        (st._lightsOff ? " LIGHTS-OFF" : "") +
        (st._fogOff ? " FOG-OFF" : ""));
    };
    if (k === "1") show("terrain");
    else if (k === "2") show("under");
    else if (k === "3") show("decal");
    else if (k === "5") show("emis");
    else if (k === "6") show("lights");
    else if (k === "7") show("fog");
    else if (k === "8") show("tonly");
    else if (k === "9") cmp3dDdsSwap(view, st);
    else show("all");
  });
}
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
    // Туман — только самый дальний обрыв: видимая карта чистая,
    // как в игре (край просто обрывается в чёрное)
    st.scene.fog.near = dist * 2.2;
    st.scene.fog.far = dist * 6;
  } catch (e) {}
}

// ---------- setup ----------
function setupCampaign3d() {
  if (!state.camp3d) state.camp3d = cmp3dFreshState();
  const btn = $("#cmp-3d");
  if (btn) btn.onclick = () => cmp3dToggle();
  cmp3dPaint();
}
