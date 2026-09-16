// Саб-пути мода: строка пути — ещё и кнопка, из неё выпадает саб-меню
// с двумя пунктами (ассеты, модели) и статусами саб-путей.
// Плюс модалка отказа при неверной структуре папки.
// Живёт поверх настроек (chrome.js/init.js), свои id — только здесь.
"use strict";

// Саб-меню открыто/закрыто.
function toggleModPathMenu(force) {
  const menu = document.getElementById("mod-path-menu");
  const group = document.getElementById("mod-path-group");
  if (!menu) return;
  const open = force !== undefined ? force : menu.hidden;
  menu.hidden = !open;
  if (group) {
    group.classList.toggle("open", open);
    group.setAttribute("aria-expanded", open ? "true" : "false");
  }
  if (open) refreshModSubpaths();
}

// Живые значения трёх путей (набранное, ещё не сохранённое — тоже).
function modPathsLive() {
  const val = id => {
    const el = document.getElementById(id);
    return el ? el.value.trim() : "";
  };
  return {
    root: val("set-mod-path"),
    assets: val("set-mod-assets"),
    models: val("set-mod-models"),
  };
}

// Статусы саб-путей в саб-меню: группы с бэкенда /api/mod_subpaths.
async function refreshModSubpaths() {
  const panel = document.getElementById("mod-subpaths");
  if (!panel) return;
  const live = modPathsLive();
  if (!live.root) {
    panel.innerHTML = "";
    const d = document.createElement("div");
    d.className = "modsp-empty";
    d.textContent = t("modsp_empty") || "Укажи путь мода — саб-пути появятся здесь";
    panel.appendChild(d);
    return;
  }
  let j = null;
  try {
    const r = await api("/api/mod_subpaths?root=" + encodeURIComponent(live.root)
      + "&assets=" + encodeURIComponent(live.assets)
      + "&models=" + encodeURIComponent(live.models));
    j = await r.json();
  } catch (e) { j = null; }
  panel.innerHTML = "";
  if (!j || !j.ok) {
    const d = document.createElement("div");
    d.className = "modsp-empty";
    d.textContent = t("modsp_empty") || "Укажи путь мода — саб-пути появятся здесь";
    panel.appendChild(d);
    return;
  }
  const groups = j.groups || {};
  for (const g of ["textures", "models"]) {
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
      pill.className = "modsp-pill" + (!it.exists ? " miss"
        : it.where === "mod" ? "" : " sub");
      pill.textContent = !it.exists
        ? (t("modsp_missing") || "нет")
        : it.where === "assets"
          ? (t("modsp_in_assets") || "ассеты")
          : it.where === "models"
            ? (t("modsp_in_models") || "модели")
            : (t("modsp_in_mod") || "мод");
      row.appendChild(pill);
      box.appendChild(row);
    }
    panel.appendChild(box);
  }
}

// Подпись поля для заголовка модалки отказа.
function modWarnFieldLabel(key) {
  if (key === "mod_assets_path") return t("set_mod_assets") || "assets";
  if (key === "mod_models_path") return t("set_mod_models") || "models";
  return t("set_mod_path") || "mod";
}

// Модалка отказа: папка без ожидаемой структуры не принимается.
// j: {error, key, kind, path, expected:[], found:[]}.
function showModWarn(j) {
  const modal = document.getElementById("modwarn-modal");
  if (!modal) {
    toast((j && j.error) || "error", "err");
    return;
  }
  const kind = (j && j.kind) || "mod";
  document.getElementById("modwarn-title").textContent =
    (t("modwarn_bad_path_title") || "Путь не принят")
    + " — " + modWarnFieldLabel(j && j.key);
  document.getElementById("modwarn-path").textContent = (j && j.path) || "";
  document.getElementById("modwarn-text").textContent = kind === "mod"
    ? (t("modwarn_bad_mod_text") || "Внутри нет структуры мода: нужен basis/ с данными игры или dlc/. Путь не сохранён — выбери корень мода (папку, где лежит basis).")
    : (t("modwarn_bad_overlay_text") || "Внутри нет ни basis/, ни dlc/, ни голых папок текстур/моделей. Проверь, что указан корень саб-пути, а не вложенная папка.");
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
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.value = v;
  };
  set("set-mod-path", (state.config && state.config.mod_path) || "");
  set("set-mod-assets", (state.config && state.config.mod_assets_path) || "");
  set("set-mod-models", (state.config && state.config.mod_models_path) || "");
  try { syncPathClear(); } catch (e) {}
  syncModSubClear();
  refreshModSubpaths();
}

// Крестики саб-путей: видны только при указанном пути.
function syncModSubClear() {
  for (const [inp, btn] of [["set-mod-assets", "set-mod-assets-clear"],
                            ["set-mod-models", "set-mod-models-clear"]]) {
    const i = document.getElementById(inp), b = document.getElementById(btn);
    if (i && b) b.hidden = !i.value.trim();
  }
}

// Привязка кнопки-меню и двух пунктов (id только этого модуля).
(function wireModPaths() {
  const arrow = document.getElementById("mod-path-toggle");
  const menu = document.getElementById("mod-path-menu");
  // саб-меню открывает только стрелка; текст подписи некликабелен
  if (arrow) {
    arrow.addEventListener("click", e => {
      e.stopPropagation();
      toggleModPathMenu();
    });
  }
  // клик мимо меню — закрыть; клик внутри — не всплывает наружу
  if (menu) menu.addEventListener("click", e => e.stopPropagation());
  document.addEventListener("click", () => toggleModPathMenu(false));
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && menu && !menu.hidden) toggleModPathMenu(false);
  });
  // живой пересчёт статусов при наборе любого из трёх путей
  for (const id of ["set-mod-path", "set-mod-assets", "set-mod-models"]) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", () => {
      syncModSubClear();
      if (menu && !menu.hidden) refreshModSubpathsDebounced();
    });
  }
  // пункты саб-меню: выбор папки / крестик
  for (const [sfx, key] of [["assets", "mod_assets_path"],
                            ["models", "mod_models_path"]]) {
    const inp = document.getElementById("set-mod-" + sfx);
    const pick = document.getElementById("set-mod-" + sfx + "-pick");
    const clr = document.getElementById("set-mod-" + sfx + "-clear");
    if (pick) {
      pick.addEventListener("click", async e => {
        e.stopPropagation();
        try {
          const p = await pickFolder();
          if (p && inp) {
            inp.value = p;
            syncModSubClear();
            refreshModSubpaths();
          }
        } catch (e2) {}
      });
    }
    if (clr) {
      clr.addEventListener("click", async e => {
        e.stopPropagation();
        if (!inp || !inp.value.trim()) return;
        try {
          await api("/api/config", { method: "POST",
            body: JSON.stringify({ [key]: "" }) });
        } catch (e2) {}
        state.config[key] = "";
        inp.value = "";
        syncModSubClear();
        refreshModSubpaths();
        toast(t("save_success"), "ok");
      });
    }
  }
  // очистка пути мода гасит и оба саб-пути: без корня они мертвы
  const modClr = document.getElementById("set-mod-clear");
  if (modClr) {
    modClr.addEventListener("click", async () => {
      try {
        await api("/api/config", { method: "POST",
          body: JSON.stringify({ mod_assets_path: "", mod_models_path: "" }) });
      } catch (e) {}
      state.config.mod_assets_path = "";
      state.config.mod_models_path = "";
      const a = document.getElementById("set-mod-assets");
      const m = document.getElementById("set-mod-models");
      if (a) a.value = "";
      if (m) m.value = "";
      syncModSubClear();
      refreshModSubpaths();
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
