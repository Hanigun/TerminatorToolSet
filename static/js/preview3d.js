// Редактор preview_config: поза камеры для превью юнита.
// ВАЖНО: model3d.js не тронут — только вызываем его готовое ядро
// (m3dLibs/m3dStage/m3dShowData/кэш) и дорисовываем свою боковую панель.
// Точка входа — openPreviewEditor({root, mesh, sys, cat, config}):
// переиспользуется из редактора юнитов, а позже — из древа и других
// редакторов. Открывается попапом поверх всего (как превью модели).
// Соответствие координатам игры: у игры Z вверх, у three — Y, плюс
// поворот кадра: бэкенд кладёт вершины как (-y, z, -x)
// (model3d_service.py) — позу камеры конвертим тем же переходом M,
// иначе камера уходит под модель. rotation в превью всегда смотрит
// в origin (OrbitControls держит lookAt), поэтому читаем и пишем
// фактический кватернион камеры; zoom игры — дистанция камера→origin
// (у абрамса |pos|≈20.3, zoom=20.58 — сходится).
var PV3_RAD2DEG = 180 / Math.PI;
var PV3_DEG2RAD = Math.PI / 180;

// Переход кадра игра→three (та же M, что у вершин): (X,Y,Z)->(-Y,Z,-X);
// обратно — транспонированием (поворот, инверсия = транспонирование).
function pv3G2T(p) {
  return {x: -(+p.y || 0), y: (+p.z || 0), z: -(+p.x || 0)};
}
function pv3T2G(p) {
  return {x: -(+p.z || 0), y: -(+p.x || 0), z: (+p.y || 0)};
}
function pv3QMul(a, b) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}
function pv3QConj(q) {
  return {w: q.w, x: -q.x, y: -q.y, z: -q.z};
}
// Кватернион перехода M (матрица→кватернион классикой по следу):
// поворот кадра сопрягается им с обеих сторон.
var PV3_QM = (function () {
  const m = [0, -1, 0, 0, 0, 1, -1, 0, 0];
  const tr = m[0] + m[4] + m[8];
  let w, x, y, z;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s;
    x = (m[7] - m[5]) / s;
    y = (m[2] - m[6]) / s;
    z = (m[3] - m[1]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    w = (m[7] - m[5]) / s;
    x = 0.25 * s;
    y = (m[1] + m[3]) / s;
    z = (m[2] + m[6]) / s;
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    w = (m[2] - m[6]) / s;
    x = (m[1] + m[3]) / s;
    y = 0.25 * s;
    z = (m[5] + m[7]) / s;
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    w = (m[3] - m[1]) / s;
    x = (m[2] + m[6]) / s;
    y = (m[5] + m[7]) / s;
    z = 0.25 * s;
  }
  return {w: w, x: x, y: y, z: z};
})();
var PV3_QMI = pv3QConj(PV3_QM);

// Свет для нового конфига с нуля: копия значений игры (abrams.config) —
// редактор свет не крутит, но файл обязан остаться полным.
var PV3_DEFAULT_LIGHTS = {
  directLight: {
    color: "00e9f9fe",
    position: {x: 0.0, y: 0.0, z: 0.0},
    power: 10.0, range: 1.0,
    rotation: {w: -0.383022278547287, x: -0.3830222189426422,
      y: -0.17860622704029083, z: 0.8213937282562256},
    shadowBias: 0.0003000000142492354, shadowOpacity: 0.0,
  },
  indirectLight: {
    addFactor: 0.0, ambientColor: "ffffffff", angle: 53.0,
    brightness: 0.699999988079071, exposure: 0.5199999809265137,
    textureName: "gray_1",
  },
};

// "preview_config/abrams.config" -> "abrams.config"; "abrams" -> "abrams.config"
function pv3ConfigName(ref) {
  let s = String(ref || "").replace(/\\/g, "/");
  s = s.split("/").pop().trim();
  if (!s) return "";
  return s.endsWith(".config") ? s : s + ".config";
}

// Открыть редактор превью попапом (как обычное превью модели, чуть шире —
// справа влезает панель полей). Повторный вызов — новый попап вместо
// старого. Вкладки не создаём: редактор — диалог поверх всего.
function openPreviewEditor(opts) {
  opts = opts || {};
  const root = opts.root || "", mesh = opts.mesh || "";
  if (!root || !mesh) {
    toast(t("m3d_err_nofile") || "3D error", "err");
    return;
  }
  if (typeof m3dClose === "function") m3dClose();
  const sys = opts.sys || mesh;
  const pv3 = {root: root, mesh: mesh, sys: sys,
    cat: opts.cat || "", config: pv3ConfigName(opts.config),
    names: [], base: null, cam: null, st: null, ui: null};
  // Фон-подложка: клик мимо окна закрывает редактор (как в превью)
  const back = document.createElement("div");
  back.className = "m3d-back";
  back.onclick = () => m3dClose();
  document.body.appendChild(back);
  const pop = document.createElement("div");
  pop.className = "m3d-pop pv3-pop";
  pop._back = back;
  const bar = document.createElement("div");
  bar.className = "m3d-bar";
  pop.appendChild(bar);
  const body = document.createElement("div");
  body.className = "pv3-body";
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
  const side = document.createElement("aside");
  side.className = "pv3-side";
  const title = document.createElement("div");
  title.className = "pv3-title";
  title.textContent = sys;
  side.appendChild(title);
  body.appendChild(view);
  body.appendChild(side);
  pop.appendChild(body);
  document.body.appendChild(pop);
  m3dPopEl = pop;
  pop._pv3 = pv3;
  // Esc закрывает диалог
  pop._esc = e => { if (e.key === "Escape") m3dClose(); };
  document.addEventListener("keydown", pop._esc);
  m3dLibs(ok => {
    if (!pop.isConnected) return;
    const fail = msg => {
      try { view.querySelector(".m3d-cube").remove(); } catch (e) {}
      try { view.querySelector(".m3d-status").remove(); } catch (e2) {}
      try { view.querySelector(".m3d-pbar").remove(); } catch (e3) {}
      const box = view.querySelector(".m3d-err");
      if (box) { box.textContent = msg; box.hidden = false; }
    };
    if (!ok || typeof m3dStage !== "function") {
      fail(t("m3d_err_lib") || "3D error");
      return;
    }
    // Сцена ядром model3d — та же, что в обычном превью.
    // Крестик в баре вьюера закрывает попап (дефолт m3dBuildBar).
    const st = m3dStage(pop, view, bar, root);
    if (!st) { fail(t("m3d_err_lib") || "3D error"); return; }
    pv3.st = st;
    pv3FetchModel(pv3, st, fail);
  });
}

// Геометрия — тем же эндпоинтом и тем же показом, что обычное превью
// (m3dShowData), дальше поза камеры — наша.
function pv3FetchModel(pv3, st, fail) {
  const key = m3dCacheKey(pv3.root, pv3.mesh, pv3.cat, pv3.sys);
  st.cacheKey = key;
  const done = data => {
    if (!st.pop.isConnected) return;
    try { st.spin.hidden = true; } catch (e) {}
    try { st.status.hidden = true; } catch (e2) {}
    if (!data || !data.ok) {
      fail(m3dErrText(data && data.error));
      return;
    }
    if (st.cacheKey) m3dCachePut(st.cacheKey, {data: data});
    m3dShowData(st, data, true);
    pv3AfterLoad(pv3, st);
  };
  const hit = m3dCacheGet(key);
  if (hit && hit.data && hit.data.ok) {
    st.params = {root: pv3.root, value: pv3.mesh,
      cat: pv3.cat, sys: pv3.sys,
      turret: (hit.data.turret && hit.data.turret.rel) || "@@auto@@"};
    st.fromCache = true;
    done(hit.data);
    return;
  }
  m3dProgress(st, 0.15);
  st.params = {root: pv3.root, value: pv3.mesh,
    cat: pv3.cat, sys: pv3.sys,
    turret: m3dTurretPick.get(key) || "@@auto@@"};
  fetch("/api/model_preview", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(st.params),
  }).then(r => r.json()).catch(() => ({ok: false, error: "net"})
  ).then(done);
}

// Модель встала: строим боковую панель, включаем текстуры (редактор —
// WYSIWYG: в обычном превью они по умолчанию выключены), вешаем рамку
// кадра игры, грузим список конфигов и применяем позу текущего конфига.
function pv3AfterLoad(pv3, st) {
  pv3BuildSide(pv3, st);
  pv3TexOn(pv3, st);
  pv3TexWatch(pv3, st);
  pv3BuildFrame(pv3, st);
  try {
    st.ctl.addEventListener("change", () => pv3Update(pv3));
  } catch (e) { /* без живого readout — только по кнопкам */ }
  fetch("/api/preview_configs?root=" + encodeURIComponent(pv3.root)
  ).then(r => r.json()).catch(() => ({ok: false})
  ).then(res => {
    if (!st.pop.isConnected) return;
    pv3.names = (res && res.ok && res.names) || [];
    pv3FillSelect(pv3);
    pv3LoadConfig(pv3, pv3.config || "");
  });
}

// Редактор — WYSIWYG: текстуры включены сразу, а не по вкладке
// (в обычном превью модели они по умолчанию выключены). Ядро уважаем:
// только флаг st.texOn + та же раздача уже готовых карт, что в кнопке
// Textures; остальное доводит наблюдатель менеджера (pv3TexWatch).
// model3d.js не тронут.
function pv3TexOn(pv3, st) {
  if (!st || st.texOn) return;
  st.texOn = true;
  try {
    const want = t("m3d_textures") || "m3d_textures";
    st.bar.querySelectorAll("button").forEach(b => {
      if (b.textContent === want) b.classList.add("on");
    });
  } catch (e) { /* подсветка необязательна */ }
  pv3TexAssign(st);
}

// Раздача готовых карт по материалам — ровно та же, что в кнопке
// Textures ядра (map/normalMap/roughnessMap из слотов).
function pv3TexAssign(st) {
  try {
    st.group.children.forEach(mesh => {
      const mt = mesh.material, slots = mt && mt.userData.slots;
      if (!mt || !slots) return;
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
    });
  } catch (e) { /* карты доедут по готовности */ }
}

// Наблюдатель загрузок: дожимает назначение на каждом затишье менеджера
// (покрывает поздние догрузки и своп башни — её текстуры идут через тот
// же менеджер) и показывает живой статус в панели: сколько карт приехало,
// сколько упало. Оригиналы колбэков ядра вызываются как были.
function pv3TexWatch(pv3, st) {
  const mgr = st && st.texMgr;
  if (!mgr || mgr._pv3) return;
  mgr._pv3 = true;
  const stat = {total: 0, done: 0, err: 0};
  const paint = () => {
    if (pv3.ui && pv3.ui.tex)
      pv3.ui.tex.textContent = "tex " + stat.done + "/" + stat.total +
        (stat.err ? " · err " + stat.err : "");
  };
  const prevStart = mgr.onStart, prevProg = mgr.onProgress,
    prevLoad = mgr.onLoad, prevErr = mgr.onError;
  mgr.onStart = (url, a, b) => {
    try { if (typeof prevStart === "function") prevStart(url, a, b); }
    catch (e) {}
    stat.total = b || 0;
    paint();
  };
  mgr.onProgress = (url, a, b) => {
    try { if (typeof prevProg === "function") prevProg(url, a, b); }
    catch (e) {}
    stat.done = a || 0;
    stat.total = b || stat.total;
    paint();
  };
  mgr.onLoad = () => {
    try { if (typeof prevLoad === "function") prevLoad(); } catch (e) {}
    pv3TexAssign(st);
    paint();
  };
  mgr.onError = url => {
    try { if (typeof prevErr === "function") prevErr(url); } catch (e) {}
    stat.err++;
    try { console.warn("[pv3] texture failed: " + url); } catch (e2) {}
    paint();
  };
  paint();
}

// Рамка кадра игры: квадрат как слот карточки юнита в игре (~1:1).
// Внутри рамки — то, что увидит игрок, снаружи — вуаль. Геометрия
// пересчитывается под текущий размер сцены.
function pv3BuildFrame(pv3, st) {
  const view = st && st.view;
  if (!view || pv3.frame) return;
  const el = document.createElement("div");
  el.className = "pv3-frame";
  for (let c = 0; c < 4; c++) el.appendChild(document.createElement("i"));
  view.appendChild(el);
  pv3.frame = el;
  pv3.frameOn = true;
  pv3LayoutFrame(pv3, st);
  try {
    const ro = new ResizeObserver(() => pv3LayoutFrame(pv3, st));
    ro.observe(view);
    // Отписка — через общий список m3dClose (dispose, без правок ядра)
    st.disposables.push({dispose: () => {
      try { ro.disconnect(); } catch (e) {}
    }});
  } catch (e) { /* старый движок — рамка по первому замеру */ }
}

function pv3LayoutFrame(pv3, st) {
  const el = pv3.frame, view = st && st.view;
  if (!el || !view) return;
  const w = view.clientWidth || 0, h = view.clientHeight || 0;
  if (w < 10 || h < 10) return;
  const s = Math.floor(Math.min(w, h));
  el.style.display = pv3.frameOn ? "" : "none";
  el.style.width = s + "px";
  el.style.height = s + "px";
  el.style.left = Math.floor((w - s) / 2) + "px";
  el.style.top = Math.floor((h - s) / 2) + "px";
}

function pv3SetFrame(pv3, on) {
  pv3.frameOn = !!on;
  if (pv3.ui && pv3.ui.frame) pv3.ui.frame.checked = pv3.frameOn;
  pv3LayoutFrame(pv3, pv3.st);
}

// Прямая запись позы из игровых координат (для слайдеров): точка,
// позиция и угол — как есть, без пересчёта по дистанции (в отличие от
// pv3ApplyPose, которая кладёт камеру по направлению на zoom).
function pv3WritePose(pv3, pose) {
  const st = pv3.st;
  if (!st || !pose) return;
  const o = pv3G2T(pose.origin || {}), p = pv3G2T(pose.position || {});
  st.ctl.target.set(o.x, o.y, o.z);
  st.camera.position.set(p.x, p.y, p.z);
  st.camera.fov = (+pose.fov > 0 ? +pose.fov : 0.49) * PV3_RAD2DEG;
  st.camera.updateProjectionMatrix();
  st.ctl.update();
  pv3Update(pv3);
}

// Тонкий слайдер одной оси: буква + ползунок (значение уже видно
// в readout выше). Возвращает input; позицию подтягивает pv3Update.
function pv3Slider(parent, axis, min, max, step, onInput) {
  const row = document.createElement("div");
  row.className = "pv3-srow";
  const lab = document.createElement("span");
  lab.textContent = axis;
  const s = document.createElement("input");
  s.type = "range";
  s.min = min;
  s.max = max;
  s.step = step;
  s.addEventListener("input", () => onInput(parseFloat(s.value)));
  row.appendChild(lab);
  row.appendChild(s);
  parent.appendChild(row);
  return s;
}

// Применить позу из конфига: точка прицеливания, угол обзора, затем
// камера на сохранённой дистанции (zoom) по направлению позы.
// Координаты игры (Z вверх) — через переход кадра в three.
function pv3ApplyPose(pv3, cam) {
  const st = pv3.st;
  if (!st || !cam) return;
  const o = pv3G2T(cam.origin || {}), p = pv3G2T(cam.position || {});
  const origin = new THREE.Vector3(o.x, o.y, o.z);
  const pos = new THREE.Vector3(p.x, p.y, p.z);
  const dir = pos.clone().sub(origin);
  if (dir.lengthSq() < 1e-8) dir.set(1, 0.5, -1);
  dir.normalize();
  const zoom = (+cam.zoom > 0) ? +cam.zoom : 20;
  st.ctl.target.copy(origin);
  st.camera.position.copy(origin).addScaledVector(dir, zoom);
  st.camera.fov = (+cam.fov > 0 ? +cam.fov : 0.49) * PV3_RAD2DEG;
  st.camera.updateProjectionMatrix();
  st.ctl.update();
  pv3.cam = JSON.parse(JSON.stringify(cam));
  pv3Update(pv3);
}

// Текущая поза сцены в формате конфига игры (полная точность,
// без округлений — округление только в подписях). Координаты three
// возвращаем в кадр игры тем же переходом; поворот сопрягаем.
function pv3ReadPose(pv3) {
  const st = pv3.st;
  const c = st.camera, tg = st.ctl.target;
  const q = pv3QMul(pv3QMul(PV3_QMI,
    {w: c.quaternion.w, x: c.quaternion.x,
     y: c.quaternion.y, z: c.quaternion.z}), PV3_QM);
  return {
    fov: c.fov * PV3_DEG2RAD,
    origin: pv3T2G(tg),
    position: pv3T2G(c.position),
    rotation: {w: q.w, x: q.x, y: q.y, z: q.z},
    zoom: c.position.distanceTo(tg),
  };
}

// Живые координаты в панели: каждый сдвиг камеры — новые цифры.
function pv3Update(pv3) {
  const ui = pv3.ui;
  if (!ui || !pv3.st) return;
  const pose = pv3ReadPose(pv3);
  const f4 = v => (Math.round(v * 10000) / 10000).toFixed(4);
  ui.pos.textContent = f4(pose.position.x) + "  " +
    f4(pose.position.y) + "  " + f4(pose.position.z);
  ui.rot.textContent = f4(pose.rotation.w) + "  " +
    f4(pose.rotation.x) + "  " + f4(pose.rotation.y) + "  " +
    f4(pose.rotation.z);
  ui.org.textContent = f4(pose.origin.x) + "  " +
    f4(pose.origin.y) + "  " + f4(pose.origin.z);
  ui.fov.textContent = f4(pose.fov);
  ui.zoom.textContent = f4(pose.zoom);
  if (document.activeElement !== ui.fovIn) ui.fovIn.value = f4(pose.fov);
  // Слайдеры следуют за камерой (орбита мышью, Reset, загрузка конфига);
  // пока ползунок тащат — не мешаем (фокус на нём). Диапазон только
  // расширяется под значение, назад не сужается.
  const setS = (s, v) => {
    if (!s) return;
    v = +v;
    if (!(v >= 0 || v < 0)) return;
    if (v < +s.min) s.min = (v * 1.2).toFixed(2);
    if (v > +s.max) s.max = (v * 1.2).toFixed(2);
    if (document.activeElement !== s) s.value = v;
  };
  setS(ui.fovS, pose.fov);
  setS(ui.zoomS, pose.zoom);
  ["x", "y", "z"].forEach(ax => {
    setS(ui.posS && ui.posS[ax], pose.position[ax]);
    setS(ui.orgS && ui.orgS[ax], pose.origin[ax]);
  });
}

// Загрузить конфиг по имени и встать в его позу; пустое имя —
// домашний вид ядра (поза по умолчанию, свет — дефолт игры).
function pv3LoadConfig(pv3, name) {
  const st = pv3.st;
  if (!st) return;
  pv3.config = name || "";
  pv3.base = null;
  if (pv3.ui) {
    pv3.ui.sel.value = name || "";
    pv3.ui.name.value = name || "";
  }
  if (!name) {
    if (st.home) st.home();
    pv3.cam = null;
    pv3Update(pv3);
    return;
  }
  fetch("/api/preview_config?root=" + encodeURIComponent(pv3.root) +
    "&name=" + encodeURIComponent(name)
  ).then(r => r.json()).catch(() => ({ok: false})
  ).then(res => {
    if (!st.pop.isConnected) return;
    if (!res || !res.ok || !res.data) {
      toast(t("pv3_err_load") || "preview error", "err");
      return;
    }
    pv3.base = res.data;
    if (res.data.camera) pv3ApplyPose(pv3, res.data.camera);
    else pv3Update(pv3);
  });
}

// Сохранить текущую позу: в текущий конфиг либо в новый из поля имени.
function pv3Save(pv3) {
  const ui = pv3.ui;
  if (!ui || !pv3.st) return;
  const name = pv3ConfigName(ui.name.value);
  if (!name) {
    toast(t("pv3_err_name") || "preview error", "err");
    return;
  }
  const base = pv3.base || {};
  const data = {
    camera: pv3ReadPose(pv3),
    directLight: base.directLight || PV3_DEFAULT_LIGHTS.directLight,
    indirectLight: base.indirectLight || PV3_DEFAULT_LIGHTS.indirectLight,
  };
  fetch("/api/preview_config_save", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({root: pv3.root, name: name, data: data}),
  }).then(r => r.json()).catch(() => ({ok: false})
  ).then(res => {
    if (!pv3.st.pop.isConnected) return;
    if (!res || !res.ok) {
      toast(t("pv3_err_save") || "preview error", "err");
      return;
    }
    pv3.config = res.name;
    pv3.base = data;
    pv3.cam = JSON.parse(JSON.stringify(data.camera));
    // путь файла для журнала/undo попапа (история видит его без страницы)
    if (res.path) pv3.cfgPath = res.path;
    if (pv3.names.indexOf(res.name) === -1) {
      pv3.names.push(res.name);
      pv3.names.sort();
      pv3FillSelect(pv3);
    }
    ui.sel.value = res.name;
    ui.name.value = res.name;
    toast(t("pv3_saved") || "saved", "ok");
  });
}

function pv3FillSelect(pv3) {
  const sel = pv3.ui && pv3.ui.sel;
  if (!sel) return;
  sel.options.length = 0;
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "—";
  sel.appendChild(none);
  pv3.names.forEach(n => {
    const o = document.createElement("option");
    o.value = n;
    o.textContent = n.replace(/\.config$/, "");
    if (n === pv3.config) o.selected = true;
    sel.appendChild(o);
  });
}

// Боковая панель редактора: выбор конфига, живые координаты,
// угол обзора, имя файла, сохранить/сбросить.
function pv3BuildSide(pv3, st) {
  const side = st.pop.querySelector(".pv3-side");
  if (!side || pv3.ui) return;
  const L = key => t(key) || key;
  const mkLab = key => {
    const d = document.createElement("div");
    d.className = "pv3-lab";
    d.textContent = L(key);
    side.appendChild(d);
    return d;
  };
  const mkVal = () => {
    const d = document.createElement("div");
    d.className = "pv3-val";
    d.textContent = "—";
    side.appendChild(d);
    return d;
  };
  mkLab("pv3_config");
  const sel = document.createElement("select");
  sel.className = "pv3-in";
  sel.onchange = () => pv3LoadConfig(pv3, sel.value || "");
  side.appendChild(sel);
  mkLab("pv3_pos");
  const pos = mkVal();
  // Слайдеры осей позиции камеры (игровые координаты, метры):
  // двигают камеру, цель и угол не трогают.
  const posS = {};
  ["x", "y", "z"].forEach(ax => {
    posS[ax] = pv3Slider(side, ax.toUpperCase(), -60, 60, 0.01, v => {
      const pose = pv3ReadPose(pv3);
      pose.position[ax] = v;
      pv3WritePose(pv3, pose);
    });
  });
  mkLab("pv3_rot");
  const rot = mkVal();
  // Поворот — кватернион: слайдеры по компонентам бессмысленны,
  // только readout; крутится мышью (позиция подхватится выше).
  mkLab("pv3_origin");
  const org = mkVal();
  // Слайдеры осей точки прицеливания: едет цель, камера стоит.
  const orgS = {};
  ["x", "y", "z"].forEach(ax => {
    orgS[ax] = pv3Slider(side, ax.toUpperCase(), -60, 60, 0.01, v => {
      const pose = pv3ReadPose(pv3);
      pose.origin[ax] = v;
      pv3WritePose(pv3, pose);
    });
  });
  mkLab("pv3_fov");
  const fov = mkVal();
  const fovIn = document.createElement("input");
  fovIn.className = "pv3-in";
  fovIn.type = "number";
  fovIn.step = "0.01";
  fovIn.min = "0.05";
  fovIn.title = L("pv3_fov");
  fovIn.onchange = () => {
    const v = parseFloat(fovIn.value);
    if (!(v > 0)) return;
    st.camera.fov = v * PV3_RAD2DEG;
    st.camera.updateProjectionMatrix();
    pv3Update(pv3);
  };
  side.appendChild(fovIn);
  // Слайдер угла обзора — дубль числового поля выше.
  const fovS = pv3Slider(side, "F", 0.05, 1.5, 0.005, v => {
    if (!(v > 0)) return;
    const pose = pv3ReadPose(pv3);
    pose.fov = v;
    pv3WritePose(pv3, pose);
  });
  mkLab("pv3_zoom");
  const zoom = mkVal();
  // Слайдер дистанции: едет камера вдоль текущего луча, цель стоит.
  const zoomS = pv3Slider(side, "D", 0.5, 120, 0.05, v => {
    if (!(v > 0)) return;
    const pose = pv3ReadPose(pv3);
    const o = pose.origin, p = pose.position;
    const dx = p.x - o.x, dy = p.y - o.y, dz = p.z - o.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len > 1e-8)) return;
    pose.position = {x: o.x + dx / len * v,
      y: o.y + dy / len * v, z: o.z + dz / len * v};
    pv3WritePose(pv3, pose);
  });
  mkLab("pv3_name");
  const name = document.createElement("input");
  name.className = "pv3-in";
  name.type = "text";
  name.spellcheck = false;
  name.autocomplete = "off";
  name.placeholder = "abrams";
  side.appendChild(name);
  const frameLab = document.createElement("label");
  frameLab.className = "pv3-check";
  const frame = document.createElement("input");
  frame.type = "checkbox";
  frame.checked = true;
  frame.onchange = () => pv3SetFrame(pv3, frame.checked);
  frameLab.appendChild(frame);
  frameLab.appendChild(document.createTextNode(L("pv3_frame")));
  side.appendChild(frameLab);
  // Живой статус текстур (заполняет наблюдатель pv3TexWatch):
  // сколько карт приехало, сколько упало — видно, грузится ли вообще.
  const tex = document.createElement("div");
  tex.className = "pv3-val";
  tex.style.marginTop = "8px";
  tex.textContent = "tex 0/0";
  side.appendChild(tex);
  const row = document.createElement("div");
  row.className = "pv3-row";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "pv3-btn";
  save.textContent = L("pv3_save");
  save.onclick = () => pv3Save(pv3);
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "pv3-btn pv3-ghost";
  reset.textContent = L("pv3_reset");
  reset.onclick = () => {
    if (pv3.cam) pv3ApplyPose(pv3, pv3.cam);
    else if (st.home) { st.home(); pv3Update(pv3); }
  };
  row.appendChild(save);
  row.appendChild(reset);
  side.appendChild(row);
  pv3.ui = {sel: sel, pos: pos, rot: rot, org: org, fov: fov,
    fovIn: fovIn, zoom: zoom, name: name, frame: frame, tex: tex,
    posS: posS, orgS: orgS, fovS: fovS, zoomS: zoomS};
  pv3Update(pv3);
}
