// Единое ядро загрузки иконок трёх страниц (карта, кампания, юниты).
//
// Раньше каждая страница качала иконки своим кодом: data-URL батчи
// /api/uprising_icons_data (мегабайты base64 в памяти — те же байты лежат
// в готовых webp и отдаются браузеру с immutable-кэшем) + свой предзагрузчик
// недостающих dds. Теперь транспорт один: /api/uprising_icon_map
// (sysname -> URL готовой webp, килобайты JSON), браузер кэширует байты сам,
// повторный рендер идёт из памяти без единого запроса.
//
// Поток ensure(names):
//   1) URL-батч недостающего (ч In chunks по 800 — лимит сервера) — быстро,
//      ответ ждём: чипы с готовыми иконками красятся сразу;
//   2) ready(true) — страница НЕ ждёт конвертацию: плейсхолдеры стоят,
//      спиннеры только у конвертируемых;
//   3) фон: preload чанками (dds->webp на сервере, пул ×8) + добивка URL
//      после каждого чанка, прогресс колбэком, перекраска колбэком;
//   4) остаток без иконок — в fail (страница персистит), честные
//      плейсхолдеры без дальнейших запросов.
//
// Шильдики, плейсхолдеры, hover/selected-состояния — дело страниц
// (uprChipIcon и декор чипов не тронуты): ядро отдаёт только карту URL.
// Поколение gen гасит гонки (смена источника/перезагрузка во время полёта).
function iconEngine(o) {
  o = o || {};
  const rootOf = o.root || (() => "");
  const mapOf = o.map || (() => ({}));
  const failOf = o.fail || (() => ({}));
  const saveFail = o.saveFail || (() => {});
  const setReady = o.ready || (() => {});
  const onChunk = o.onChunk || (() => {});
  const onProgress = o.onProgress || null;
  const onSettled = o.onSettled || (() => {});
  const isFresh = o.isFresh || (() => true);
  const wantStates = o.states || null;
  const pending = o.pending || null;
  const URL_CH = o.urlChunk || 800;
  const PRE_CH = o.preChunk || 100;
  let gen = 0, activeFresh = null;
  const alive = g => g === gen && isFresh() &&
    (!activeFresh || activeFresh());

  const missOf = names => {
    const map = mapOf() || {}, fail = failOf() || {};
    const out = [];
    (names || []).forEach(n => {
      if (!n || map[n] || fail[n] || out.indexOf(n) !== -1) return;
      out.push(n);
    });
    return out;
  };

  // URL-батч: {added:[имена с новыми URL], missing:[без URL]}.
  // Транзиент (оборванный коннект) — один повтор чанка с паузой.
  async function urlBatch(g, root, names) {
    const added = [], missing = [];
    for (let i = 0; i < (names || []).length; i += URL_CH) {
      if (!alive(g)) return { added, missing: names.slice(i), stale: true };
      const chunk = names.slice(i, i + URL_CH);
      let icons = null;
      for (let att = 0; att < 2 && icons === null; att++) {
        if (att) await new Promise(res => setTimeout(res, 1500));
        if (!alive(g)) return { added, missing: names.slice(i), stale: true };
        try {
          const r = await api("/api/uprising_icon_map", { method: "POST",
            body: JSON.stringify({ root, names: chunk }), timeout: 60000 });
          const j = await r.json();
          if (j && j.ok) icons = j.icons || {};
        } catch (e) { icons = null; }
      }
      const map = mapOf() || {};
      chunk.forEach(n => {
        const u = icons ? icons[n] : "";
        if (u && !map[n]) { map[n] = u; added.push(n); }
        else if (!map[n]) missing.push(n);
      });
    }
    return { added, missing, stale: false };
  }

  // Фоновая предзагрузка недостающего: жмём dds чанками, после каждого
  // добираем URL и красим. Возвращает остаток без иконок (финал добит
  // ещё одним URL-батчем — транзиент предзагрузки не равно «нет иконки»).
  async function preloadBack(g, root, names) {
    const total = (names || []).length;
    let done = 0;
    try {
      if (onProgress && total) onProgress(0, total);
    } catch (e) {}
    if (pending) names.forEach(n => pending.add(n));
    const still = [];
    for (let i = 0; i < names.length; i += PRE_CH) {
      if (!alive(g)) return [];
      const chunk = names.slice(i, i + PRE_CH);
      try {
        await api("/api/uprising_icon_preload", { method: "POST",
          body: JSON.stringify({ root, names: chunk }), timeout: 180000 });
      } catch (e) { /* чанк не дожался — остальные всё равно идут */ }
      if (!alive(g)) return [];
      const r = await urlBatch(g, root, chunk);
      if (!alive(g)) return [];
      done = Math.min(i + PRE_CH, total);
      try {
        if (onProgress) onProgress(done, total);
      } catch (e) {}
      if (r.added.length) {
        if (pending) r.added.forEach(n => pending.delete(n));
        try { onChunk(r.added); } catch (e) {}
      }
      r.missing.forEach(n => {
        if (still.indexOf(n) === -1) still.push(n);
      });
    }
    if (still.length && alive(g)) {
      const r = await urlBatch(g, root, still);
      if (!alive(g)) return [];
      if (r.added.length) {
        if (pending) r.added.forEach(n => pending.delete(n));
        try { onChunk(r.added); } catch (e) {}
      }
      if (pending) r.missing.forEach(n => pending.delete(n));
      return r.missing;
    }
    if (pending) still.forEach(n => pending.delete(n));
    return still;
  }

  // Полная загрузка имён: быстрая фаза ждётся, фоновая — нет.
  // Возвращает промис быстрой фазы (URL-батч + ready).
  // opt.root — зафиксированный корень на всю операцию (иначе живой rootOf:
  // чанки после переключения источника уехали бы в чужой слой);
  // opt.fresh — доп. проверка свежести поколения (loadSeq/корень страницы).
  async function ensure(names, opt) {
    opt = opt || {};
    const g = ++gen;
    const root = (opt.root !== undefined) ? opt.root : (rootOf() || "");
    activeFresh = (typeof opt.fresh === "function") ? opt.fresh : null;
    const miss = missOf(names);
    if (!miss.length) {
      try { setReady(true); } catch (e) {}
      try { onChunk([]); } catch (e) {}
      if (wantStates && root && (names || []).length) {
        try { wantStates(root, names); } catch (e) {}
      }
      try { onSettled(); } catch (e) {}
      return;
    }
    const r = await urlBatch(g, root, miss);
    // Устарело — мутаций нет, но settled обязателен (флаги загрузки страниц
    // и бар: как старый .finally, иначе чужой полёт оставит iconsLoading
    // навсегда и повторный заход уже не стартует).
    if (!alive(g)) {
      try { onSettled(); } catch (e) {}
      return;
    }
    if (r.added.length) {
      try { onChunk(r.added); } catch (e) {}
    }
    try { setReady(true); } catch (e) {}
    if (wantStates && root && (names || []).length) {
      try { wantStates(root, names); } catch (e) {}
    }
    if (!r.missing.length || r.stale) {
      try { onSettled(); } catch (e) {}
      return;
    }
    // фон: страницу не держим — чипы дорисует onChunk
    preloadBack(g, root, r.missing).then(rest => {
      if (!alive(g)) {
        try { onSettled(); } catch (e) {}
        return;
      }
      // состояния (ховер/selected) дожатого — подтянуть их URL тоже
      if (wantStates) {
        try { wantStates(root, names); } catch (e) {}
      }
      if ((rest || []).length) {
        const fail = failOf() || {};
        let changed = false;
        rest.forEach(n => {
          if (!(mapOf() || {})[n] && !fail[n]) { fail[n] = 1; changed = true; }
        });
        if (changed) {
          try { saveFail(); } catch (e) {}
          try { onChunk([]); } catch (e) {}
        }
      }
      try { onSettled(); } catch (e) {}
    }).catch(() => { try { onSettled(); } catch (e) {} });
  }

  // Добор имён, появившихся после загрузки (правки): готовность не
  // трогаем, готовые чипы стоят без спиннеров.
  function refresh(names, opt) {
    opt = opt || {};
    const g = ++gen;
    const root = (opt.root !== undefined) ? opt.root : (rootOf() || "");
    activeFresh = (typeof opt.fresh === "function") ? opt.fresh : null;
    const miss = missOf(names);
    if (!miss.length) return Promise.resolve();
    return urlBatch(g, root, miss).then(r => {
      if (!alive(g)) return;
      if (r.added.length) {
        try { onChunk(r.added); } catch (e) {}
      }
      if (!r.missing.length || r.stale) return;
      return preloadBack(g, root, r.missing).then(rest => {
        if (!alive(g)) return;
        if ((rest || []).length) {
          try { onChunk([]); } catch (e) {}
        }
      });
    }).catch(() => {});
  }

  // Смена источника: гасит полёты, чистит поколение.
  function reset() { gen++; }

  return { ensure, refresh, reset };
}
