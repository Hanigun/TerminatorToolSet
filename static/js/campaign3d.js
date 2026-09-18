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
    btn.classList.toggle("is-on", on);
    btn.textContent = on ? "2D" : (t("cpg_3d") || "3D");
  }
  // Прячем только карту с плитками; правая панель (магазин/найм/
  // снабжение) остаётся — на этапе 4 она откроется при выборе сектора
  const map = $("#cmp-map"), view = $("#cmp3d-view");
  if (map) map.hidden = on;
  if (view) view.hidden = !on;
  if (on && view) cmp3dEnsure(view);
}
// Этап 1 построит здесь сцену; пока — заглушка со статусом
function cmp3dEnsure(view) {
  if (view._cmp3dReady) return;
  view._cmp3dReady = true;
  const box = view.querySelector(".cmp3d-view");
  if (box) box.textContent = "";
  const st = view.querySelector(".cmp3d-status");
  if (st) st.textContent = t("cpg_3d_soon") || "3D-сцена впереди (этап 1)";
}

// ---------- setup ----------
function setupCampaign3d() {
  if (!state.camp3d) state.camp3d = cmp3dFreshState();
  const btn = $("#cmp-3d");
  if (btn) btn.onclick = () => cmp3dToggle();
  cmp3dPaint();
}
