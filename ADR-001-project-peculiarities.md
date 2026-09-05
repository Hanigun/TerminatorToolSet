# ADR-001 — Особенности проекта TerminatorSheetQt

Дата: 2026-09-01. Статус: принят. Область: TerminatorSheetQt (PySide6 + Flask) и связка с мод-данными.

## 1. Стек и режимы запуска

- Основной режим: frameless-окно PySide6 (`QWebEngineView` + `QWebChannel`), UI — HTML/JS (`static/js/app.js`), бэкенд — Flask, раздаётся локальным werkzeug-сервером на `127.0.0.1:<случайный порт>`.
- Мост JS↔Qt: `window.pywebview.api` (шим в `_qt_shim_source()`, инъекция на DocumentCreation). Имена методов моста сохранены от старого pywebview — `index.html`/`app.js` не знают о Qt.
- Fallback: без PySide6 — обычный браузер (`TS_BROWSER=1` или автоматом).
- Приложение запускается из консоли (`python main.py`). Exe НЕ пересобирать без явной просьбы. Изменения применяются рестартом приложения.

## 2. HTTP-сервер: обход бага Python 3.14 (`main.py:_serve`)

- Баг среды: Python 3.14 `http.server` (в т.ч. под werkzeug) зависает на любом ответе больше ~64КБ — клиент получает ровно 65535 байт, поток-обработчик исчезает, fetch виснет вечно. Симптом был: «один файл не открылся — последующие тоже», species-файлы (большие ответы) не открывались вовсе.
- Обход обязателен, работает только в связке:
  1. `disable_nagle_algorithm = True` (TCP_NODELAY) в кастомном `_TSRequestHandler`;
  2. WSGI-обёртка `_chunked` — тело ответа отдаётся чанками по 4КБ.
- Проверено: ответы 738КБ/150КБ доходят целиком; без любого из двух условий — вис.
- Возвращать «одним куском» нельзя, пока проект живёт на Python 3.14.
- 2026-09-02: под «бесконечную загрузку» страницы в браузере попали и keep-alive соединения — после большого ответа обработчик перестаёт читать следующую просьбу (в app.log: app.js ушёл, `/api/config` до сервера не дошёл; лечилось только F5). Второй обязательный пункт обхода: `protocol_version = "HTTP/1.0"` — соединение закрывается после каждого ответа. Виноват слой сокетов Python 3.14, не сервер: waitress 3.0.2 воспроизводит зависание на одиночной отдаче 256КБ (`scripts/gate_http_probe.py` гоняет 8 параллельных полных чтений app.js — это гейт G4).

## 3. Запуск сервера (`main.py`)

- Порт выделяется самим bind'ом: `make_server(host, 0, ...)` — сервер занимает порт СРАЗУ. `_free_port()` (закрыть сокет → потом bind) запрещён: race, порт мог уйти другому процессу → «все fetch висят».
- `_serve(app, host)` в проекте ОДНА (история: дубликат со старой сигнатурой `_serve(app, host, port)` перезаписывал новый и ронял запуск с `TypeError`). При правках проверять дубли.
- `serve_forever` — в daemon-потоке; признак живого сервера в консоли: строка `Flask server: http://127.0.0.1:PORT (pid N)`.
- Логи: `logs\app.log` (RotatingFileHandler 1МБ×3) + JS-консоль окна (`_Page.javaScriptConsoleMessage`) + `/api/client_log` от фронта. Werkzeug НЕ глушить: access-лог в консоли — главный признак живого сервера для пользователя.

## 4. Фронтенд (`static/js/app.js`)

- `api()`: таймауты через AbortController — 60с обычные, 300с тяжёлые (`open_project`, `open_file`, `project_tree`, `edited_marks`). Таймаут показывается понятно («timeout: сервер не ответил…»), не голым «Failed to fetch». GET ретраится один раз. Все сетевые сбои — `reportClientError` → `/api/client_log`.
- Защита от «серого старта» QtWebEngine: страница считается загруженной только после `window.__tshBooted` (ставится в `init()` после `loadI18n`). Серверный watchdog перезагружает страницу максимум 4 раза с интервалом 4с и только если живая страница не отвечает (`runJavaScript("!!window.__tshBooted")`).
- Вкладки: список в `sessionStorage` (`tsh_tabs`), восстановление под guard `window.__tshRestored` (иначе первый `renderTabBar` затирает список). Пути в состояниях — через `normPath()` (обратные слэши Windows).
- Статика отдаётся с `Cache-Control: no-cache` — рестарт всегда подхватывает свежие файлы.
- Кнопка «исправить файл» (`#btn-fix` → `/api/fix_file`) — починает `ss:ExpandedRowCount/ColumnCount` ТОЛЬКО по явному клику, авто-починка при save запрещена.

## 5. XML-движок (SpreadsheetML)

- Железное правило: сохранение нетронутого файла = байт-в-байт входа. Snapshot-сравнение в `Session.save`.
- Автотип ячеек (`spines.py`): числа по `_NUMBER_RE = ^-?(0|[1-9]\d*)(\.\d+)?$` получают `ss:Type="Number"`, остальное — String. Иначе WPS показывает «числа как текст», а ломаный тип ломает мод.
- Recover-режим: битый XML (`SpreadsheetML.load(path, recover=True)`, lxml recover) — по согласию пользователя (диалог во фронте); такие сессии: без автосейва, с баннером, save всегда пишет файл явно.
- Счётчики `<Table>`: `_bump_table` не выдумывает отсутствующие атрибуты; `delete_*`/`insert_*` ставят точный факт (`_max_logical_excluding`, `_next_logical`). Расхождение при save — только warning в лог (не блок), лечение — `/api/fix_file`.
- Вход-выход проверяется `test_roundtrip.py` (12 тестов); самозакрытый `<Cell/>` при вставке `<Data>` разворачивается в пару тегов.

## 6. Окно Qt

- Перетаскивание за шапку — ТОЛЬКО нативное: `Bridge.begin_drag()` → `windowHandle().startSystemMove()`. Прежняя схема JS `mousemove` → `move_window` через IPC на каждый пиксель вызывала сильные лаги/дёргания. Двойной клик по шапке = максимизация (детект в `begin_drag`: два вызова в 0.5с в радиусе 8px).
- Нативное контекстное меню Chromium (Назад/Обновить/Печать) отключено: `view.setContextMenuPolicy(Qt.NoContextMenu)`. Разрешено только наше HTML-меню (сетка/дерево).
- Chromium-флаги (`_apply_chromium_flags`, до импорта QtWebEngine): базовые — анти-троттлинг фона, `--disable-features=CalculateNativeWinOcclusion`, `--disable-ipc-flooding-protection`; `fps_vsync_unlock` (config, default true) добавляет `--disable-gpu-vsync` (для 120/144/165Гц мониторов); доп. флаги — из `config.chromium_flags`.
- FPS пишется в boot.log после старта (`_fps_probe`), вместе с GPU-рендерером.

## 7. Среда и данные

- `D:\CloudLayer\...` — обычный ЛОКАЛЬНЫЙ диск (не облако): файлы должны открываться максимально быстро, «долгие» таймауты — только страховка.
- Мод-данные: `TERMINATOR_OVERHAUL_MAIN/TERMINATOR_OVERHAUL` (species XML-таблицы, default_army.toml, spawns), тестовый проект `TERMINATOR_OVERHAUL_MAIN/TestProject`. Папки `basis/scripts` перечитываются с диска при каждом обращении.
- SQLite `terminator_sheet.db` (история, отметки) — в папке приложения; кэши/БД при «файлы не открываются» не виноваты — сначала проверять HTTP-слой (п.2).

## 8. Гейты проверки (после правок)

```
python -m py_compile main.py
node --check static\js\app.js
python -m test_roundtrip
python -m test_api          # интеграционный, поднимает реальный сервер
node scripts\verify-ui-wiring.mjs
python scripts\verify_history.py
```

## 9. Индексация

- CodeGraph: `.codegraph/` в корне `Terminator Project` (sync/status/explore). Инструмент graph-поиска по коду приложения.
- codebase-memory: `.cbmignore` в корне и в корнях мода содержит negations `!.../basis/scripts/` — НЕ удалять: индексатор по умолчанию пропускает любые папки `scripts`, negations возвращают мод-данные в индекс. Первый вызов CBM-CLI часто таймаутит (daemon прогрев) — ретрай.

## 10. Производительность рендера Qt-окна (2026-09-01)

- Ключевой факт пользователя: `run_dev.bat` (режим `--browser`) — вообще без лагов, включая большие XML-таблицы. Значит бэкенд и JS достаточно быстрые; тормозит КОМПОЗИТИНГ QtWebEngine-окна. Диагноз зондом: GPU активен (ANGLE D3D11, RTX 4070), fps=60 (монитор 60Гц) — проблема не в отсутствии GPU, а в пейсинге кадров под нагрузкой.
- Флаги: добавлены `--enable-gpu-rasterization`, `--enable-zero-copy`, `--use-angle=d3d11` (в Chrome это по умолчанию; в Qt-окне явно).
- Зонд FPS в `_run_qt`: `runJavaScript` возвращает значение СИНХРОННОГО выражения — rAF-цикл должен писать результат в `window.__tshPerf`, читать вторым вызовом (старый зонд всегда возвращал '' и писал «unreadable»). Замеряет fps + maxgap (макс. разрыв кадра = джанк) + WebGL-рендерер.
- Клик по вкладке НЕ должен перерисовывать сетку и дёргать `/api/links`: у вкладки кэш `rendered`/`links`/`linksLoaded` (activateTab). Это убрало подлагивания переключения и шторм ретраев links (проявлялся в app.log как 20+ подряд `/api/links`).
- Индексация сущностей: фоновый поток с `THREAD_PRIORITY_BELOW_NORMAL` + sleep(1мс) между файлами — не держит GIL против UI/HTTP.
- Drag&drop файлов из проводника: QWebEngineView НЕ пробрасывает файлы в веб-контент (в браузере работает, в Qt-окне — нет). Приём через `_DropView` (dragEnter/drop на Qt-уровне) → `window.__tshExternalDrop({folder}|{files})` в app.js.

## 11. Excel-совместимость (2026-09-01)

- Семантика `ss:ExpandedRowCount` — позиция ПОСЛЕДНЕЙ ЛОГИЧЕСКОЙ строки, а НЕ число элементов `<Row>`. Таблица из 16 `<Row>` с `ss:Index="36"` у последней требует ExpandedRowCount=36. Старый фиксатор считал элементы и ПОНИЖАЛ счётчик (36→16), ломая файл. Починено: `_logical_row_count` (spines) / `logical_row_count` (spreadsheet_ml), включая `_bump_row_count` и валидацию при save.
- Ссылки `ss:StyleID` на необъявленные стили Excel считает фатальными («Атрибут: StyleID, Значение: s127»). Лечение: `fix_missing_styles` добавляет пустые `<Style ss:ID="x"/>` в `<Styles>` (минимальная правка, ячейки не трогаются). Кнопка «исправить файл» чинит и счётчики, и стили; в ответе `/api/fix_file` поле `styles`.
- cars.xml из TestProject был починен утилитой (12 стилей + счётчик 36).
- Кросс-файловые ссылки: пути в entity-карте и сессии нормализуются (`normcase+normpath`) — иначе само-ссылки из-за «/» vs «\\»; значение, определённое в этом же файле, ссылкой НЕ становится (в entity-карте хранятся ВСЕ вхождения value — basis+dlc оверлеи).
- Иконка ссылки в ячейке: absolute в правом верхнем углу (`td.has-link`), inline-вариант переносился на вторую строку (после block `.cell-sub`) и раздувал строку/колонку.
- Зелёная точка сохранённого файла: `<project_name>.json` рядом с config.json. Без открытого проекта маркер пишется в json по папке самого файла; точка показывается и в дереве, и на вкладке (`tab.saved`, флаг `edited` в ответе `/api/open_file`).

## 12. Оверхаул UI и новые страницы (2026-09-02)

- Страницы-«оверлеи» поверх вкладок: `compare`, `create-mod`, `unpacker`, `swt`, `uprising` — статические секции `.tab-panel` в index.html с фиксированными tab-id. closeTab их панели НЕ удаляет; у каждой свой fresh-state при закрытии (`state.swt = swtFreshState()` и т.п.). Все — широкие (без сайдбара): список в `updateSidebarVisibility.onWide`.
- **Вкладки**: drag-reorder (`reorderTabs`, welcome не двигается); дерево проекта переключается на «Игра» (`/api/game_tree`, config.unpacked_path).
- **Настройки**: 3 вкладки (Основные/Пути/Хоткеи). Хоткеи: `HOTKEY_EDITABLE` (8 действий), хранение `config.hotkeys` (по e.code), `hkMatch("undo", e)` — верификационный гейт G5 завязан на этот паттерн.
- **Лаунчер**: splash 420×280 frameless (`/splash`, `splash.html`) создаётся ПЕРВЫМ; главное окно — в потоке `_launch_main`; `Api.main_ready()` гасит splash. `_check_updates` — заглушка (реальные апдейты не сделаны), `update_repo` пуст → «updates: disabled».
- **7-Zip в комплекте**: `7z\x64\7z.exe` + `7z\x86\7z.exe` рядом с кодом; `_find_7z` ищет их в `base_dir` (= `sys._MEIPASS` в сборке) ДО PATH/Program Files.
- **Сравнение**: кастомный дропдаун ключа (без скруглений, 440×420, поиск), контекстное меню на обеих панелях (копировать/вырезать/вставить/перенести ячейку/строку — переиспользует `/api/edit` и `transferRow`), кнопки «на весь экран» (панель переносится DOM-деревом в модалку `#cmp-fs` и обратно), Ctrl+F фокусит поиск активной панели. `handleCmpCtxAction(act, ctxCmp, cmpCellValue)` — снимок контекста передаётся параметрами (замыкание setupContextMenu недоступно top-level функции). Состояние сравнения для контекстного меню — `state.cmpCtx` (visible + src/cols каждой стороны), заполняется в `renderCompare`.
- **Создание модов**: живая подсказка пути `<game>\mods\<имя>` (латинское `mods` — как в игре), кнопка «Открыть мод» в результате → `loadProject`.
- **Распаковка**: после успешного прогона `dest` автозаписывается в `config.unpacked_path` (state.upDest), сайдбар/дерево/настройки обновляются; в подтверждении — разбивка по группам паков (white-space: pre-line в confirm-msg).
- **SWT-редактор** (`swt_editor.py`, `/api/swt_open`, `/api/swt_save`, словарь `swt_commands.json` — 167 команд из референса epq1176/SWT-editor):
  - формат .swt — плоский XML без декларации; парс свой (ElementTree читает), сериализация побайтовая: хвосты whitespace (tail) каждого элемента сохраняются как есть — в файлах игры аномалии (несколько Action в строке, табы после `</Name>`, мусор `´` после тегов, невалидные entity `&#x1F;` как маркеры);
  - невалидные entity подменяются PUA-сентинеллами `\uE000...\uE001` до парсинга и восстанавливаются в исходном виде при записи; hex-тело без префикса `x` (`int(body[1:], 16)`);
  - ET.tostring для «сырых» узлов УЖЕ включает tail — не задваивать;
  - авто-фикс повторных guid: три независимые нумерации (Trigger/Condition/Action), дубли получают max+1, файл помечается dirty;
  - сохранение: сравнение с исходником (без изменений — не пишется и маркер не ставится), `.bak` предыдущей версии, зелёная точка через `_mark_edited_file`. Round-trip проверен на всех 212 .swt мода — 0 расхождений.
- **Карта Uprising** (`/api/uprising_find`, `/api/uprising_sysnames`): редактирование наград секторов `dlc\Resistance\basis\scripts\species\shop_presets.xml`. Сектора — кнопки-плитки (группировка `sector_N_reward` + варианты `_ally`/`_1`/`_2`), значения — чипы «имя×count» с datalist-подсказкой; правки идут через `/api/edit` c `save:false` (сессия сервера остаётся dirty) + кнопка «Сохранить» → `/api/save` (история/undo работают как в гриде). Справочник sysname — первый столбец всех species-XML basis+dlc (+invs.xml) одним regex-проходом.
- **Сборка**: spec переключён на ONEDIR (`dist\TerminatorSheetQt\TerminatorSheetQt.exe` + `_internal\`); в datas добавлены `swt_commands.json` и комплектный `7z\`. Причина: мгновенный старт (без распаковки onefile в temp) и стабильные пути к 7z. Рестарт экзешника — smoke-тест живости (boot.log: server/mode/updates).

## 13. Гейты проверки (полный набор после правок)

```
python -m py_compile app.py main.py config.py swt_editor.py
node --check static\js\app.js
python -m test_api
python -m test_roundtrip
node scripts\verify-ui-wiring.mjs
python scripts\verify_history.py
```
