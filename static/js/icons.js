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
  // Сессионный кэш на корень {map, fail, dead}: переживает закрытие вкладок
  // (движки — синглтоны страниц). Повторное открытие сеется из памяти и
  // красится мгновенно, батч добирает только новое. dead — имена без иконок
  // после полного preload-прохода: предзагрузку за сессию не повторяем
  // (URL-проверка дешёвая и остаётся — внешний webp подхватится).
  // reset() (смена источника, «Анализ») чистит fail/dead, карты URL живут
  // (готовый webp никуда не девается).
  const sess = {};
  const entry = root => {
    if (!sess[root]) sess[root] = { map: {}, fail: {}, dead: {} };
    return sess[root];
  };

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
  // добираем URL и красим. dead пропускаем (см. sess). Возвращает остаток
  // без иконок (финал добит ещё одним URL-батчем — транзиент предзагрузки
  // не равно «нет иконки»).
  async function preloadBack(g, root, names, ent) {
    const queue = (names || []).filter(n => !ent.dead[n]);
    const total = queue.length;
    let done = 0;
    try {
      if (onProgress && total) onProgress(0, total);
    } catch (e) {}
    if (pending) queue.forEach(n => pending.add(n));
    const still = [];
    for (let i = 0; i < queue.length; i += PRE_CH) {
      if (!alive(g)) return [];
      const chunk = queue.slice(i, i + PRE_CH);
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
        r.added.forEach(n => {
          try { ent.map[n] = (mapOf() || {})[n] || ent.map[n]; } catch (e) {}
        });
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
        r.added.forEach(n => {
          try { ent.map[n] = (mapOf() || {})[n] || ent.map[n]; } catch (e) {}
        });
        try { onChunk(r.added); } catch (e) {}
      }
      if (pending) r.missing.forEach(n => pending.delete(n));
      r.missing.forEach(n => { ent.dead[n] = 1; });
      return r.missing;
    }
    if (pending) still.forEach(n => pending.delete(n));
    still.forEach(n => { ent.dead[n] = 1; });
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
    const ent = entry(root);
    // посев из сессионного кэша: повторное открытие красится сразу
    // из памяти, батч доберёт только новое
    try {
      const pmap = mapOf() || {}, pfail = failOf() || {};
      const seeded = [];
      Object.keys(ent.map).forEach(n => {
        if (!pmap[n] && ent.map[n]) { pmap[n] = ent.map[n]; seeded.push(n); }
      });
      Object.keys(ent.fail).forEach(n => { if (!pfail[n]) pfail[n] = 1; });
      if (seeded.length) onChunk(seeded);
    } catch (e) {}
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
      r.added.forEach(n => {
        try { ent.map[n] = (mapOf() || {})[n] || ent.map[n]; } catch (e) {}
      });
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
    preloadBack(g, root, r.missing, ent).then(rest => {
      if (!alive(g)) {
        try { onSettled(); } catch (e) {}
        return;
      }
      if ((rest || []).length) {
        const fail = failOf() || {};
        let changed = false;
        rest.forEach(n => {
          if (!(mapOf() || {})[n] && !fail[n]) { fail[n] = 1; changed = true; }
          try { ent.fail[n] = 1; } catch (e) {}
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
    const ent = entry(root);
    const miss = missOf(names);
    if (!miss.length) return Promise.resolve();
    return urlBatch(g, root, miss).then(r => {
      if (!alive(g)) return;
      if (r.added.length) {
        r.added.forEach(n => {
          try { ent.map[n] = (mapOf() || {})[n] || ent.map[n]; } catch (e) {}
        });
        try { onChunk(r.added); } catch (e) {}
      }
      if (!r.missing.length || r.stale) return;
      return preloadBack(g, root, r.missing, ent).then(rest => {
        if (!alive(g)) return;
        if ((rest || []).length) {
          try { onChunk([]); } catch (e) {}
        }
      });
    }).catch(() => {});
  }

  // Смена источника / «Анализ»: гасит полёты, чистит поколение, fail и dead
  // (карты URL живут — готовый webp никуда не девается; посев ускорит
  // следующий заход, батч доберёт новое).
  function reset() {
    gen++;
    try {
      Object.keys(sess).forEach(k => {
        sess[k].fail = {};
        sess[k].dead = {};
      });
    } catch (e) {}
  }

  return { ensure, refresh, reset };
}
