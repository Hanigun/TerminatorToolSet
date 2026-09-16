// Саб-пути мода: блок пути — кнопка саб-меню с двумя пунктами
// (ассеты, модели) деревом. Плюс модалка отказа при неверной
// структуре папки.
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
  const block = document.querySelector("#mod-path-group .set-mod-row");
  const menu = document.getElementById("mod-path-menu");
  // кнопка — весь блок, кроме текста подписи, поля ввода и кнопок:
  // клик по ним игнорируем (текст некликабелен, поле фокусится,
  // у кнопок свои действия), остальное переключает саб-меню
  if (block) {
    block.addEventListener("click", e => {
      if (e.target.closest("input, button, #mod-path-label")) return;
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
  // крестики саб-путей при наборе: только видимость
  for (const id of ["set-mod-path", "set-mod-assets", "set-mod-models"]) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", syncModSubClear);
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
    });
  }
  const ok = document.getElementById("modwarn-ok");
  if (ok) ok.onclick = () => {
    document.getElementById("modwarn-modal").hidden = true;
  };
})();
