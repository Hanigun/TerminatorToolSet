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
    try { cmp3dLabelTick(st); } catch (e) {}
    view._cmp3dRaf = requestAnimationFrame(loop);
  };
  loop();
}
// Подпись штата — HTML-оверлей, как в игре: в текстуре state_names
// букв нет физически (замер: 0 пикселей темнее R150 на весь 2048²),
// TEXAS рисует сам интерфейс. Якорь — CMP3D_TEXAS, проекция каждый
    // кадр (камера панится — подпись едет вместе с картой)
function cmp3dLabels(box, st) {
  let el = box.querySelector(".cmp3d-state-label");
  if (!el) {
    el = document.createElement("div");
    el.className = "cmp3d-state-label";
    el.textContent = "TEXAS";
    box.appendChild(el);
  }
  st.labelEl = el;
  st.labelWorld = null;
}
function cmp3dLabelTick(st) {
  const el = st.labelEl;
  if (!el) return;
  try {
    if (!st.labelWorld) {
      st.group.updateMatrixWorld(true);
      st.labelWorld = new THREE.Vector3(
        CMP3D_TEXAS[0], CMP3D_TEXAS[1], CMP3D_TEXAS[2]
      ).applyMatrix4(st.group.matrixWorld);
      st.labelV = new THREE.Vector3();
    }
    st.labelV.copy(st.labelWorld).project(st.camera);
    const w = st.box.clientWidth || 640, h = st.box.clientHeight || 480;
    if (st.labelV.z > 1) { el.style.display = "none"; return; }
    el.style.display = "block";
    el.style.left = ((st.labelV.x * 0.5 + 0.5) * w) + "px";
    el.style.top = ((-st.labelV.y * 0.5 + 0.5) * h) + "px";
  } catch (e) {}
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
// Свет карты одним местом (диагностика возвращает ровно эти значения).
// Старт под линейный выход (GEM без кинокривой): альбедо террейна
// тёмное (R~40) и полупрозрачное (альфа ~0.24 поверх чёрной плиты) —
// яркость добирается силой света, а не тонемаппингом.
// Ориентир — скриншот игры: яркий сине-серый террейн, светящиеся дороги
var CMP3D_KEY = 8, CMP3D_HEMI = 0.8, CMP3D_EXPO = 1.2;
// Якорь подписи штата в координатах модели (центр Техаса —
// среднее POI, та же точка, что CMP3D_HOME)
var CMP3D_TEXAS = [-165, 8, -338];

// ---------- libs ----------
// three.js — из моста three-bridge.mjs (шапка index.html, r185):
// ждём window.THREE (событие + опрос), тегов вендора больше нет
var cmp3dLibState = 0, cmp3dLibQueue = [];
function cmp3dLibs(cb) {
  if (typeof THREE !== "undefined" && THREE.WebGLRenderer &&
      THREE.OrbitControls) { cmp3dLibState = 2; cb(true); return; }
  if (cmp3dLibState === 2) { cb(true); return; }
  cmp3dLibQueue.push(cb);
  if (cmp3dLibState === 1) return;
  cmp3dLibState = 1;
  const done = ok => {
    cmp3dLibState = ok ? 2 : 0;
    const q = cmp3dLibQueue.splice(0);
    q.forEach(f => { try { f(ok); } catch (e) {} });
  };
  let settled = false;
  const settle = ok => {
    if (settled) return;
    settled = true;
    try { clearInterval(timer); } catch (e) {}
    done(ok);
  };
  try {
    window.addEventListener("tsh:three", () => settle(true),
      {once: true});
  } catch (e) {
    try { window.addEventListener("tsh:three", () => settle(true)); }
    catch (e2) {}
  }
  let n = 0;
  const timer = setInterval(() => {
    if (typeof THREE !== "undefined" && THREE.WebGLRenderer &&
        THREE.OrbitControls) settle(true);
    else if (++n > 100) settle(false);
  }, 100);
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
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // GEM — LDR-движок без кинокривой (эквивалент Blender Standard):
    // ACESFilmic (эквивалент Filmic) съедал насыщенность и давил
    // средние тона — отсюда «тускло» при любом свете. Линейный выход:
    // цвет как в текстуре, яркость — только светом
    renderer.toneMapping = THREE.LinearToneMapping;
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
    // Свой свет: солнце строго сверху по light.xml
    // (direction 0,0,-1.37 — отвесно вниз). Наклона нет и в игре:
    // рельеф лепится нормалями, а не боковым светом.
    // Цвета полусферы — из хвоста global_map.lighting
    // (небо 0.3294,0.4627,0.5059 / земля 0.1373,0.1961,0.2118)
    const hemi = new THREE.HemisphereLight(0x547681, 0x233236, CMP3D_HEMI);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, CMP3D_KEY);
    key.position.set(0, 100, 0);
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
    // Временный пульт света: ползунки + видимые значения для фиксации
    try { cmp3dPanel(box, st); } catch (e9) {}
    // Подпись штата поверх карты
    try { cmp3dLabels(box, st); } catch (e10) {}
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
    const g = new THREE.BufferGeometry();    g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
    if (n.length === p.length) g.setAttribute("normal", new THREE.Float32BufferAttribute(n, 3));
    else g.computeVertexNormals();
    if (u.length === (p.length / 3) * 2) g.setAttribute("uv", new THREE.Float32BufferAttribute(u, 2));
    g.setIndex(ix);
    const mi = (m.material != null) ? m.material : -1;
    const md = (data.materials && data.materials[mi]) || null;
    // Рамки side/corner не строим: их tessellated-полосы поверх плиты
    // и давали лишнюю сетку. Остаётся только undercoat_main —
    // край карты обрывается глухой плитой в чёрное, как в игре
    var _alb = (md && md.albedo) || "";
    if (/undercoat_side|undercoat_corner/.test(_alb)) return;
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
    // Рамка (side/corner) — как обычная подложка: глухая и непрозрачная.
    // Их полупрозрачная альфа давала лишние ступени затемнения по краю;
    // main и так глухой (IsTransparent=false), теперь вся семья глухая.
    // Плита пригашена (0x333333): её линии R~45, точки R~130 — под
    // линейным выходом точки светились. Теперь линии почти не видны,
    // точки тускло тлеют — как в игре. Света на плите нет (unlit)
    mat.userData.isUnder = isUnder;
    if (isUnder) mat.color.setHex(0x333333);
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
      // геометрию не трогаем, TEXAS парит как задумано.
      // Глубину не пишет только парящая декаль; террейн и рамка пишут.
      // Подложка — глухая целиком (и рамка тоже): полупрозрачные
      // полосы side/corner затемняли край ступенями вместо одного
      // ровного спада
      if (md.transparent && !isUnder) {
        mat.transparent = true;
        mat.depthWrite = isGhost ? false : true;
      } else {
        mat.depthWrite = true;
      }
      if (md.double_sided) mat.side = THREE.DoubleSide;
      // Порядок отрисовки — из движка (RenderPriority: террейн
      // и подложка -100, декали 0): текст всегда поверх террейна,
      // а не по прихоти сортировки прозрачных
      try {
        mat.renderOrder = (md.render_priority != null) ?
          md.render_priority : 0;
      } catch (e8) { mat.renderOrder = 0; }
    } else {
      mat.color.setHex(0x9aa0a8);
    }
    const mesh = new THREE.Mesh(g, mat);
    // Геометрию не двигаем: рамка подложки сходится с краем
    // террейна ровно на движковой высоте, её видно по краям карты
    mesh.userData.mid = mi;
    mesh.userData.title = [m.name, m.node].filter(Boolean).join(" @ ");
    st.group.add(mesh);
    st.disposables.push(g, mat);
    mat.userData.tex.forEach(tx => st.disposables.push(tx));
  });
}
// Проявка текста декалей: буквы темнее фона в R — инверсия
// с растяжкой по реальному min/max (фон уходит в чёрный, вуали нет).
// Фиксированная формула давила контраст — текст тонул.
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
      // Сначала min/max инверсии — потом растяжка на весь диапазон
      let mn = 255, mx = 0;
      for (let i = 0; i < d.length; i += 4) {
        const v = 255 - d[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const span = (mx - mn) || 1;
      for (let i = 0; i < d.length; i += 4) {
        let v = ((255 - d[i]) - mn) * 255 / span;
        v = v < 0 ? 0 : (v > 255 ? 255 : v);
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
      cx.putImageData(id, 0, 0);
      try { tx.dispose(); } catch (e0) {}
      const dt = new THREE.CanvasTexture(cv);
      // Проявка — sRGB-картинка: без метки three читал бы её
      // как линейную и текст уходил бы не в ту яркость
      dt.colorSpace = THREE.SRGBColorSpace;
      mat.emissiveMap = dt;
      mat.emissive = new THREE.Color(0xffffff);
      mat.emissiveIntensity = mat.userData.decalPower *
        ((st.lset && st.lset.decal != null) ? st.lset.decal : 1);
      mat.needsUpdate = true;
      mat.userData.tex.push(dt);
      st.disposables.push(dt);
      cmp3dStatus(st.view, "decal TEXAS ok");
    } catch (e) {}
  }, undefined, () => {
    try { cmp3dStatus(st.view, "decal FAIL " + url); } catch (e2) {}
  });
}
function cmp3dTexReady(st, mat, slot) {
  try {
    const tx = mat.userData.slots[slot];
    if (!tx) return;
    mat[slot] = tx;
    if (slot === "emissiveMap") {
      mat.emissive = new THREE.Color(0xffffff);
      // Ночные огни и светящиеся дороги днём не горят (в игре их
      // включает ночь): сила — ползунок «Ночь», по умолчанию 0.
      // Иначе emission_power 0.6 лежит поверх дня белесой вуалью
      mat.emissiveIntensity = (mat.userData.emissionPower || 0) *
        ((st.lset && st.lset.night != null) ? st.lset.night : 0);
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
      if (srgb) tx.colorSpace = THREE.SRGBColorSpace;
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
          tx.colorSpace = THREE.SRGBColorSpace;
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
            if (m.material && m.material.emissive) {
              if (m.material.userData.decalPower)
                m.material.emissiveIntensity =
                  m.material.userData.decalPower *
                  ((st.lset && st.lset.decal != null) ?
                    st.lset.decal : 1);
              else
                m.material.emissiveIntensity =
                  (m.material.userData.emissionPower || 0) *
                  ((st.lset && st.lset.night != null) ?
                    st.lset.night : 0);
            }
          } catch (e3) {}
        });
        st._emisOff = false;
        st._lightsOff = false;
        st._fogOff = false;
        try {
          st.key.intensity = (st.lset && st.lset.key) || CMP3D_KEY;
          st.hemi.intensity = (st.lset && st.lset.hemi) || CMP3D_HEMI;
        } catch (e4) {}
        try { st.scene.fog = st._fog; } catch (e5) {}
      }
      if (what === "emis") {
        st._emisOff = !st._emisOff;
        st.group.children.forEach(m => {
          try {
            if (m.material && m.material.emissive) {
              if (st._emisOff) m.material.emissiveIntensity = 0;
              else if (m.material.userData.decalPower)
                m.material.emissiveIntensity =
                  m.material.userData.decalPower *
                  ((st.lset && st.lset.decal != null) ?
                    st.lset.decal : 1);
              else
                m.material.emissiveIntensity =
                  (m.material.userData.emissionPower || 0) *
                  ((st.lset && st.lset.night != null) ?
                    st.lset.night : 0);
            }
          } catch (e2) {}
        });
      }
      if (what === "lights") {
        st._lightsOff = !st._lightsOff;
        try {
          st.key.intensity = st._lightsOff ? 0 :
            ((st.lset && st.lset.key) || CMP3D_KEY);
          st.hemi.intensity = st._lightsOff ? 0 :
            ((st.lset && st.lset.hemi) || CMP3D_HEMI);
        } catch (e6) {}
      }
      if (what === "fog") {
        st._fogOff = !st._fogOff;
        try { st.scene.fog = st._fogOff ? null : st._fog; } catch (e7) {}
      }
      const vis = st.group.children.map(m => m.visible ? 1 : 0).join("");
      const lv = st.lset || cmp3dLightDef();
      cmp3dStatus(view, "DBG key=" + k + " meshes[" + vis + "]" +
        " " + cmp3dLightText(lv) +
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
    // Дальность — с временного пульта (Z): TEXAS шире экрана на
    // заводской дистанции — отъезд подбирается ползунком
    const dk = (st.lset && st.lset.dist) || 1;
    const dist = r * 0.5 * dk;
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
    // как в игре (край просто обрывается в чёрное).
    // Множитель — с временного пульта света (0 — туман выкл)
    const fmul = (st.lset && st.lset.fog) || 1;
    if (fmul <= 0) st.scene.fog = null;
    else {
      st.scene.fog = st._fog;
      st.scene.fog.near = dist * 2.2 * fmul;
      st.scene.fog.far = dist * 6 * fmul;
    }
  } catch (e) {}
}

// ВРЕМЕННЫЙ пульт света (убрать после подбора 1:1): ползунки
// Ключ/Фил/Экспо/Ночь/Текст/Туман справа поверх карты + кривая
// рендера (Standard/Без кривой/Кино) + видимые значения строкой
// (прислать её — зашью константами).
// Ночь — сила ночных огней террейна (днём в игре 0, иначе вуаль);
// Текст — яркость названий штатов (у них почти нулевая альфа,
// видны только через свечение, как в движке).
// Значения живут в localStorage (cmp3dLight), «Сброс» возвращает
// константы CMP3D_*
function cmp3dLightDef() {
  return {key: CMP3D_KEY, hemi: CMP3D_HEMI, expo: CMP3D_EXPO,
    night: 1.0, decal: 0, fog: 1.0, tm: "linear", dist: 1.0};
}
function cmp3dLightLoad() {
  const d = cmp3dLightDef();
  try {
    const s = JSON.parse(localStorage.getItem("cmp3dLight") || "null");
    if (s) Object.keys(d).forEach(k => {
      if (k === "tm") {
        if (s.tm === "linear" || s.tm === "none" || s.tm === "aces")
          d.tm = s.tm;
      } else if (typeof s[k] === "number" && isFinite(s[k])) d[k] = s[k];
    });
  } catch (e) {}
  return d;
}
function cmp3dLightSave(lset) {
  try { localStorage.setItem("cmp3dLight", JSON.stringify(lset)); }
  catch (e) {}
}
function cmp3dLightText(l) {
  const f = v => (Math.round(v * 100) / 100).toFixed(2);
  return "K" + f(l.key) + " F" + f(l.hemi) + " E" + f(l.expo) +
    " N" + f(l.night) + " D" + f(l.decal) + " T" + f(l.fog) +
    " Z" + f(l.dist) + " TM:" + l.tm;
}
function cmp3dLightApply(st) {
  if (!st || !st.key || !st.lset) return;
  const l = st.lset;
  try { st.key.intensity = l.key; } catch (e) {}
  try { st.hemi.intensity = l.hemi; } catch (e2) {}
  try { st.renderer.toneMappingExposure = l.expo; } catch (e3) {}
  // Кривая рендера: linear — как GEM (Standard), none — совсем без
  // кривой, aces — киношная (было, для сравнения). После смены кривой
  // шейдеры пересобираются — иначе картинка не обновится
  try {
    const want = l.tm === "aces" ? THREE.ACESFilmicToneMapping :
      l.tm === "none" ? THREE.NoToneMapping : THREE.LinearToneMapping;
    if (st.renderer.toneMapping !== want) {
      st.renderer.toneMapping = want;
      st.group.children.forEach(m => {
        try { if (m.material) m.material.needsUpdate = true; }
        catch (e6) {}
      });
    }
  } catch (e7) {}
  try {
    st.group.children.forEach(m => {
      if (m.material && m.material.emissive) {
        if (m.material.userData.decalPower)
          m.material.emissiveIntensity =
            m.material.userData.decalPower * l.decal;
        else
          m.material.emissiveIntensity =
            (m.material.userData.emissionPower || 0) * l.night;
      }
    });
  } catch (e4) {}
  try {
    if (st._fog) {
      if (l.fog <= 0) st.scene.fog = null;
      else {
        st.scene.fog = st._fog;
        const dist = (st.home && st.home.dist) || 170;
        st._fog.near = dist * 2.2 * l.fog;
        st._fog.far = dist * 6 * l.fog;
      }
    }
  } catch (e5) {}
}
function cmp3dPanel(box, st) {
  st.lset = cmp3dLightLoad();
  let panel = box.querySelector("#cmp3d-light");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "cmp3d-light";
    [["key", "Ключ", 0, 20, 0.1],
     ["hemi", "Фил", 0, 2, 0.01],
     ["expo", "Экспо", 0.3, 2.5, 0.01],
     ["night", "Ночь", 0, 2.5, 0.01],
     ["decal", "Текст", 0, 3, 0.01],
     ["fog", "Туман", 0, 3, 0.05],
     ["dist", "Дальность", 0.3, 1.5, 0.05]].forEach(r => {
      const row = document.createElement("label");
      row.className = "cmp3d-light-row";
      const nm = document.createElement("span");
      nm.textContent = r[1];
      const inp = document.createElement("input");
      inp.type = "range";
      inp.min = r[2]; inp.max = r[3]; inp.step = r[4];
      inp.dataset.k = r[0];
      inp.addEventListener("input", () => {
        const cur = panel._st;
        if (!cur) return;
        cur.lset[r[0]] = parseFloat(inp.value);
        cmp3dLightSave(cur.lset);
        cmp3dLightApply(cur);
        // Дальность двигает камеру — пересчитываем наводку
        if (r[0] === "dist") {
          try { cmp3dHome(cur); } catch (e8) {}
        }
        cmp3dLightSync(panel);
      });
      const val = document.createElement("b");
      row.appendChild(nm); row.appendChild(inp); row.appendChild(val);
      panel.appendChild(row);
    });
    // Кривая рендера: Standard (linear) / без кривой (none) / кино (aces)
    const tmRow = document.createElement("label");
    tmRow.className = "cmp3d-light-row";
    const tmNm = document.createElement("span");
    tmNm.textContent = "Кривая";
    const tmSel = document.createElement("select");
    [["linear", "Standard"], ["none", "Без кривой"],
     ["aces", "Кино"]].forEach(o => {
      const opt = document.createElement("option");
      opt.value = o[0];
      opt.textContent = o[1];
      tmSel.appendChild(opt);
    });
    tmSel.addEventListener("change", () => {
      const cur = panel._st;
      if (!cur) return;
      cur.lset.tm = tmSel.value;
      cmp3dLightSave(cur.lset);
      cmp3dLightApply(cur);
      cmp3dLightSync(panel);
    });
    tmRow.appendChild(tmNm); tmRow.appendChild(tmSel);
    panel.appendChild(tmRow);
    const out = document.createElement("div");
    out.className = "cmp3d-light-val";
    out.title = "Клик — выделить, Ctrl+C — скопировать";
    panel.appendChild(out);
    const rst = document.createElement("button");
    rst.type = "button";
    rst.textContent = "Сброс";
    rst.onclick = () => {
      const cur = panel._st;
      if (!cur) return;
      cur.lset = cmp3dLightDef();
      cmp3dLightSave(cur.lset);
      cmp3dLightApply(cur);
      cmp3dLightSync(panel);
    };
    panel.appendChild(rst);
    box.appendChild(panel);
  }
  panel._st = st;
  cmp3dLightSync(panel);
  cmp3dLightApply(st);
}
function cmp3dLightSync(panel) {
  const st = panel._st;
  if (!st || !st.lset) return;
  panel.querySelectorAll("input[type=range]").forEach(inp => {
    const k = inp.dataset.k;
    if (k in st.lset) inp.value = st.lset[k];
    const b = inp.parentNode.querySelector("b");
    if (b) b.textContent = Number(st.lset[k]).toFixed(2);
  });
  const sel = panel.querySelector("select");
  if (sel) sel.value = st.lset.tm;
  const out = panel.querySelector(".cmp3d-light-val");
  if (out) out.textContent = cmp3dLightText(st.lset);
}

// ---------- setup ----------
function setupCampaign3d() {  if (!state.camp3d) state.camp3d = cmp3dFreshState();
  const btn = $("#cmp-3d");
  if (btn) btn.onclick = () => cmp3dToggle();
  cmp3dPaint();
}
