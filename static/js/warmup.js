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
    if (st.phase === "scan" || st.phase === "index") return t("warmup_scan") + "…";
    var s = done + "/" + total;
    if (cur) s += " · " + cur;
    if (st.failed) s += " · ✕" + st.failed;
    return s;
  }

  // Повторы того же состояния DOM не трогают вообще (меньше reflow:
  // опрос и так раз в секунду). Заливка — transform, не width.
  var lastPaint = "", hideT = null;
  function paint(st) {
    var b = bar(); if (!b) return;
    var running = !!st.running;
    var key = (running ? "1" : "0") + "|" + (st.phase || "") + "|" +
      (st.done || 0) + "/" + (st.total || 0) + "|" + (st.current || "") +
      "|" + (st.failed || 0);
    if (key !== lastPaint) {
      lastPaint = key;
      if (hideT) { clearTimeout(hideT); hideT = null; }
      b.hidden = !running && st.phase !== "done" && st.phase !== "stopped";
      var txt = "";
      // готовый/остановленный прогон — полная полоса на 4с, затем прячем
      if (!running && (st.phase === "done" || st.phase === "stopped")) {
        var k = st.phase === "done" ? "warmup_done" : "warmup_stopped";
        txt = t(k) + ": " + (st.done || 0) + "/" + (st.total || 0);
        if (fill()) fill().style.transform = "scaleX(1)";
        hideT = setTimeout(function () {
          var x = bar(); if (x) x.hidden = true;
        }, 4000);
      } else if (running) {
        txt = t("warmup_title") + ": " + fmt(st);
        if (fill()) fill().style.transform = "scaleX(" +
          (st.total > 0 ? (st.done / st.total).toFixed(4) : 0) + ")";
      }
      // полоса тонкая без текста: состояние — в подсказке и на кнопке;
      // корень — тоже в подсказке: видно, ЧТО именно греется
      // (только открытый источник, без чужих саб-путей)
      b.title = txt + (st.root ? " · " + st.root : "");
      if (label()) label().textContent = txt;
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

  // Корень текущего источника ПУТЁМ (Проект | Игра | Мод): тот же
  // srcRoot(state.treeView), что у карты/кампании/юнитов — один глобальный
  // источник на все страницы. Раньше брался объект дерева {n,d,f}, а не
  // путь — бэкенд его отбрасывал и кнопка всегда просила «выбрать мод
  // или проект». Запасной путь — первый настроенный корень
  // (мод → проект → игра), чтобы кнопка работала вообще без древа.
  function currentRoot() {
    try {
      var v = (typeof state !== "undefined" && state.treeView) || "";
      if (typeof srcRoot === "function") {
        var r = srcRoot(v) || "";
        if (r) return r;
      }
    } catch (e) {}
    try {
      if (typeof treeViewRoot === "function") {
        var t = treeViewRoot() || {};
        if (t.root) return t.root;
      }
    } catch (e) {}
    try {
      var cfg = (typeof state !== "undefined" && state.config) || {};
      var pr = (typeof state !== "undefined" && state.project &&
        state.project.root) || "";
      var cands = [cfg.mod_path, pr, cfg.project_path,
        cfg.last_project, cfg.unpacked_path];
      for (var i = 0; i < cands.length; i++) {
        if (cands[i]) return cands[i];
      }
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
