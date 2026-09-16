// Саб-пути мода: строка оверлея _ASSETS, дропдаун текстур/моделей,
// модалка отказа при неверной структуре папки.
// Живёт поверх настроек (chrome.js/init.js), свои id — только здесь.
"use strict";

// Дропдаун саб-путей: группы с бэкенда /api/mod_subpaths.
async function refreshModSubpaths() {
  const panel = document.getElementById("mod-subpaths");
  const cnt = document.getElementById("mod-subpaths-count");
  if (!panel) return;
  const inp = document.getElementById("set-mod-path");
  const root = inp ? inp.value.trim()
    : ((state.config && state.config.mod_path) || "");
  const paintCount = (found, total) => {
    if (cnt) cnt.textContent = total ? (found + " / " + total) : "";
  };
  if (!root) {
    panel.innerHTML = "";
    const d = document.createElement("div");
    d.className = "modsp-empty";
    d.textContent = t("modsp_empty") || "Укажи путь мода — саб-пути появятся здесь";
    panel.appendChild(d);
    paintCount(0, 0);
    return;
  }
  let j = null;
  try {
    const r = await api("/api/mod_subpaths?root=" + encodeURIComponent(root));
    j = await r.json();
  } catch (e) { j = null; }
  panel.innerHTML = "";
  if (!j || !j.ok) {
    const d = document.createElement("div");
    d.className = "modsp-empty";
    d.textContent = t("modsp_empty") || "Укажи путь мода — саб-пути появятся здесь";
    panel.appendChild(d);
    paintCount(0, 0);
    return;
  }
  const groups = j.groups || {};
  const order = ["textures", "models"];
  let found = 0, total = 0;
  for (const g of order) {
    const items = groups[g] || [];
    const box = document.createElement("div");
    box.className = "modsp-group";
    const head = document.createElement("div");
    head.className = "modsp-head";
    const dot = document.createElement("span");
    dot.className = "modsp-gdot" + (items.some(x => x.exists) ? " ok" : "");
    head.appendChild(dot);
    const ttl = document.createElement("span");
    ttl.className = "modsp-title";
    ttl.textContent = g === "textures"
      ? (t("mod_subpaths_textures") || "Текстуры")
      : (t("mod_subpaths_models") || "Модели");
    head.appendChild(ttl);
    box.appendChild(head);
    for (const it of items) {
      total++;
      if (it.exists) found++;
      const row = document.createElement("div");
      row.className = "modsp-row" + (it.exists ? " ok" : " miss");
      const st = document.createElement("span");
      st.className = "modsp-dot" + (it.exists ? " ok" : "");
      st.textContent = it.exists ? "●" : "○";
      row.appendChild(st);
      const rel = document.createElement("span");
      rel.className = "modsp-rel";
      rel.textContent = it.rel;
      rel.title = it.rel;
      row.appendChild(rel);
      const pill = document.createElement("span");
      pill.className = "modsp-pill" + (it.exists
        ? (it.where === "overlay" ? " sub" : "") : " miss");
      pill.textContent = !it.exists
        ? (t("modsp_missing") || "нет")
        : it.where === "overlay"
          ? (t("modsp_in_overlay") || "саб-путь")
          : (t("modsp_in_mod") || "мод");
      row.appendChild(pill);
      box.appendChild(row);
    }
    panel.appendChild(box);
  }
  paintCount(found, total);
}

// Модалка отказа: папка без ожидаемой структуры не принимается.
// j: {error, path, expected:[], found:[]}.
function showModWarn(j) {
  const modal = document.getElementById("modwarn-modal");
  if (!modal) {
    toast((j && j.error) || "error", "err");
    return;
  }
  const badOverlay = j && j.error === "bad_overlay_structure";
  document.getElementById("modwarn-title").textContent = badOverlay
    ? (t("modwarn_bad_overlay_title") || "Саб-путь не принят")
    : (t("modwarn_bad_mod_title") || "Папка мода не принята");
  document.getElementById("modwarn-path").textContent = (j && j.path) || "";
  document.getElementById("modwarn-text").textContent = badOverlay
    ? (t("modwarn_bad_overlay_text") || "Внутри нет ни basis/, ни dlc/, ни голых папок текстур/моделей. Проверь, что указан корень _ASSETS, а не вложенная папка.")
    : (t("modwarn_bad_mod_text") || "Внутри нет структуры мода: нужен basis/ с данными игры или dlc/. Путь не сохранён — выбери корень мода (папку, где лежит basis).");
  const exp = document.getElementById("modwarn-expected");
  const fnd = document.getElementById("modwarn-found");
  exp.innerHTML = "";
  fnd.innerHTML = "";
  for (const s of ((j && j.expected) || [])) {
    const c = document.createElement("span");
    c.className = "modsp-pill";
    c.textContent = s;
    exp.appendChild(c);
  }
  const found = (j && j.found) || [];
  if (!found.length) {
    const c = document.createElement("span");
    c.className = "modsp-pill miss";
    c.textContent = t("modwarn_found_none") || "пусто";
    fnd.appendChild(c);
  }
  for (const s of found) {
    const c = document.createElement("span");
    c.className = "modsp-pill sub";
    c.textContent = s;
    fnd.appendChild(c);
  }
  modal.hidden = false;
}

// Откат полей путей к принятым значениям после отказа + перекраска.
function revertModPathFields() {
  const mp = document.getElementById("set-mod-path");
  const ov = document.getElementById("set-mod-overlay");
  if (mp) mp.value = (state.config && state.config.mod_path) || "";
  if (ov) ov.value = (state.config && state.config.mod_overlay_path) || "";
  try { syncPathClear(); } catch (e) {}
  try { syncModOverlayClear(); } catch (e) {}
  try { refreshModSubpaths(); } catch (e) {}
}

// Крестик оверлея: виден только при указанном пути (как PATH_CLEAR_PAIRS).
function syncModOverlayClear() {
  const i = document.getElementById("set-mod-overlay");
  const b = document.getElementById("set-mod-overlay-clear");
  if (i && b) b.hidden = !i.value.trim();
}

// Привязка строки оверлея и дропдауна (id только этого модуля).
(function wireModPaths() {
  const tgl = document.getElementById("mod-subpaths-toggle");
  const panel = document.getElementById("mod-subpaths");
  if (tgl && panel) {
    tgl.onclick = () => {
      panel.hidden = !panel.hidden;
      tgl.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
      tgl.classList.toggle("open", !panel.hidden);
      if (!panel.hidden) refreshModSubpaths();
    };
  }
  const inp = document.getElementById("set-mod-path");
  if (inp) {
    let timer = 0;
    inp.addEventListener("input", () => {
      try {
        if (!panel || panel.hidden) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(refreshModSubpaths, 400);
      } catch (e) {}
    });
  }
  const ovInp = document.getElementById("set-mod-overlay");
  if (ovInp) {
    ovInp.addEventListener("input", () => {
      syncModOverlayClear();
      if (panel && !panel.hidden) refreshModSubpathsDebounced();
    });
  }
  const pick = document.getElementById("set-mod-overlay-pick");
  if (pick) {
    pick.addEventListener("click", async () => {
      try {
        const p = await pickFolder();
        if (p && ovInp) {
          ovInp.value = p;
          syncModOverlayClear();
          if (panel && !panel.hidden) refreshModSubpaths();
        }
      } catch (e) {}
    });
  }
  const clr = document.getElementById("set-mod-overlay-clear");
  if (clr) {
    clr.addEventListener("click", async () => {
      if (!ovInp || !ovInp.value.trim()) return;
      try {
        await api("/api/config", { method: "POST",
          body: JSON.stringify({ mod_overlay_path: "" }) });
      } catch (e) {}
      state.config.mod_overlay_path = "";
      ovInp.value = "";
      syncModOverlayClear();
      try { refreshModSubpaths(); } catch (e2) {}
      toast(t("save_success"), "ok");
    });
  }
  // очистка пути мода гасит и саб-путь: без корня оверлей мёртв
  const modClr = document.getElementById("set-mod-clear");
  if (modClr) {
    modClr.addEventListener("click", async () => {
      try {
        await api("/api/config", { method: "POST",
          body: JSON.stringify({ mod_overlay_path: "" }) });
      } catch (e) {}
      state.config.mod_overlay_path = "";
      if (ovInp) ovInp.value = "";
      syncModOverlayClear();
      try { refreshModSubpaths(); } catch (e2) {}
    });
  }
  const ok = document.getElementById("modwarn-ok");
  if (ok) ok.onclick = () => {
    document.getElementById("modwarn-modal").hidden = true;
  };
})();

let _modspTimer = 0;
function refreshModSubpathsDebounced() {
  if (_modspTimer) clearTimeout(_modspTimer);
  _modspTimer = setTimeout(refreshModSubpaths, 400);
}
