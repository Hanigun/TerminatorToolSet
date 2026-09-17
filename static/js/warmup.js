// Фонопрогрев текстур: кнопка в шапке греет корень текущего древа
// (проект/игра/мод; у мода — плюс саб-пути), бар сверху показывает
// прогресс. Галка в настройках — авто один раз при подключении,
// свежак по mtime пропускается самим бэкендом, повтор дёшев.
(function () {
  "use strict";
  var timer = null;

  function bar() { return document.getElementById("warmup-bar"); }
  function fill() { return document.getElementById("warmup-fill"); }
  function label() { return document.getElementById("warmup-label"); }
  function btn() { return document.getElementById("btn-warmup"); }

  function fmt(st) {
    var done = st.done || 0, total = st.total || 0;
    var cur = st.current || "";
    if (st.phase === "scan") return t("warmup_scan") + "…";
    var s = done + "/" + total;
    if (cur) s += " · " + cur;
    if (st.failed) s += " · ✕" + st.failed;
    return s;
  }

  function paint(st) {
    var b = bar(); if (!b) return;
    var running = !!st.running;
    b.hidden = !running && st.phase !== "done" && st.phase !== "stopped";
    // готовый/остановленный прогон — короткая вспышка итога, затем прячем
    if (!running && (st.phase === "done" || st.phase === "stopped")) {
      var key = st.phase === "done" ? "warmup_done" : "warmup_stopped";
      if (label()) label().textContent = t(key) + ": " +
        (st.done || 0) + "/" + (st.total || 0);
      if (fill()) fill().style.width = "100%";
      setTimeout(function () { var x = bar(); if (x) x.hidden = true; }, 4000);
    } else if (running) {
      if (label()) label().textContent = t("warmup_title") + ": " + fmt(st);
      if (fill()) fill().style.width = (st.total > 0
        ? Math.round(st.done / st.total * 100) : 0) + "%";
    }
    var bn = btn();
    if (bn) {
      bn.classList.toggle("running", running);
      bn.title = running ? (t("warmup_stop") + ": " + fmt(st)) : t("warmup_title");
    }
  }

  function poll() {
    api("/api/warmup_status").then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok || !j.status) { stopPoll(); return; }
        paint(j.status);
        if (!j.status.running) stopPoll();
        else if (!timer) timer = setInterval(poll, 1000);
      }).catch(function () { stopPoll(); });
  }

  function stopPoll() { if (timer) { clearInterval(timer); timer = null; } }

  // корень текущего древа: проект | игра | мод (tree.js: treeRoot)
  function currentRoot() {
    try {
      if (typeof treeRoot === "function") return treeRoot() || "";
    } catch (e) {}
    return "";
  }

  async function toggleWarmup() {
    var st = null;
    try {
      var r = await api("/api/warmup_status");
      var j = await r.json();
      st = (j && j.ok && j.status) || null;
    } catch (e) { st = null; }
    if (st && st.running) {
      // повторный клик по работающей — мягкий стоп
      try { await api("/api/warmup_stop", { method: "POST" }); } catch (e) {}
      poll();
      return;
    }
    var root = currentRoot();
    if (!root) { toast(t("warmup_noroot"), "warn"); return; }
    try {
      var r2 = await api("/api/warmup_start", { method: "POST",
        body: JSON.stringify({ root: root }) });
      var j2 = await r2.json();
      if (!j2 || !j2.ok) { toast(t("warmup_noroot"), "warn"); return; }
      paint(j2.status || {});
    } catch (e) { toast(t("warmup_noroot"), "warn"); return; }
    stopPoll();
    timer = setInterval(poll, 1000);
  }

  function init() {
    var b = btn();
    if (b && !b.dataset.wu) {
      b.dataset.wu = "1";
      b.addEventListener("click", toggleWarmup);
    }
    // авто-прогон из настроек мог стартовать без нас (сейв путей):
    // подхватить бар, если бэкенд уже греет
    try {
      api("/api/warmup_status").then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.ok && j.status && j.status.running) {
            paint(j.status);
            stopPoll();
            timer = setInterval(poll, 1000);
          }
        }).catch(function () {});
    } catch (e) {}
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
