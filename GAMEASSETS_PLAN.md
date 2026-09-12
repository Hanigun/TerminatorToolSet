# План: скачивание архива GameAssets

> Только план, без реализации. Решения зафиксированы по ответам заказчика.

## Решения

- Кнопка в шапке видна только пока архив **не скачан** (`game_assets_downloaded = 0`), после успеха прячется. Клик открывает вкладку настроек «Обновления», секцию GameAssets.
- Архив — `GameAssets*.zip` (без учёта регистра) в **том же релизе**, что и программа. Отдельного тега нет.
- Распаковка — только в папку `GameAssets` рядом с exe, `unpacked_path` **не трогать**.
- При `game_assets_downloaded = 1` программа ищет оттуда файлы локализации и скрипты (xml, swt) по тем же путям, что в распакованной игре, с той же структурой. Приоритет — **последний**: после распакованной игры / проекта / мода, перед встроенным `GameScripts`.
- После успеха — статус «Скачано» + кнопка перекачивания.

## 1. `compiler/worker.js` — разделить «программу» и «ассеты»

Проблема: `pickZip()` берёт первый `.zip` релиза — каналы `release`/`beta` могут увидеть или отдать `GameAssets.zip`.

- `pickZip()` — исключить имена по маске `/gameassets/i`.
- Новая `pickGameAssets(assets)` — ищет `.zip` с `/gameassets/i` в имени.
- Новый эндпоинт `GET /gameassets[?repo=]` — ищет в `releases?per_page=20` самый свежий релиз, содержащий gameassets-ZIP, возвращает `{ok, version: tag, published_at, assets: [один gameassets-ассет]}`. Кэш отдельно от релизного (`?ga=1`, `max-age=300`).
- `GET /asset` — новый параметр `kind=gameassets`:
  - без `kind` — текущее поведение + явный отказ: если `id` принадлежит gameassets-ассету, вернуть `404 asset not in latest release`;
  - с `kind=gameassets` — проверка членства только в gameassets-списке найденного релиза, стриминг тем же 302-механизмом (токен не покидает воркер).
- После правки `/release` и `/prerelease` физически не могут вернуть `GameAssets.zip`.

## 2. Бэкенд: конфиг + сервис + API

**`terminator_toolset/domain/config.py`:**
- `DEFAULTS += {"game_assets_downloaded": 0, "game_assets_version": ""}` — флаг строго `0/1`, по умолчанию `0`. В `_normalize()` привести к `int 0/1`, версию — к строке.

**Новый `terminator_toolset/services/game_assets_service.py` (класс `GameAssets`, по образцу `Updates`, но проще):**
- `fetch_meta(server, repo)` — запрос к воркеру `/gameassets`.
- `download()` — фоновый поток + `_progress {state: idle|downloading|extracting|done|error, done, total, error}`; скачивание через `…/asset?repo=…&id=…&kind=gameassets`; распаковка во временную папку, затем перенос в `<program_dir>/GameAssets` (схлопывание одиночной верхней папки, как `_release_root`). Успех: `config.set("game_assets_downloaded", 1)`, версия, `state=done`. Без рестарта, без pending.
- `state()` — флаг, версия, наличие папки на диске, прогресс.

**Новый `terminator_toolset/api/game_assets.py`:** `GET /api/game_assets_state`, `POST /api/game_assets_check`, `POST /api/game_assets_download`, `GET /api/game_assets_progress`. Подключить в `app.py create_app` (создать сервис с тем же `program_dir`, что у `Updates`, добавить в `ctx`, вызвать `register_game_assets`).

## 3. Фронтенд

**`templates/index.html`:**
- В шапку рядом с `#btn-update`: `<button id="btn-gameassets" hidden>` со своей иконкой (стиль как `upd-btn`).
- Вкладка настроек `data-stp="updates"`, ниже существующего блока: разделитель + секция GameAssets — заголовок, хинт, `#ga-state`, кнопка `#ga-download` («Скачать ассеты»), кнопка `#ga-redownload` (видна только при `downloaded=1`), прогресс `#ga-progress > #ga-fill + #ga-pct`. Классы `.upd-*` переиспользовать.

**`static/js/chrome.js` (отдельные `ga*`-функции рядом с `upd*`):**
- `gaStateLoad()` — `GET /api/game_assets_state`; вызывается при старте (для шапки) и в `openSettings("updates")`.
- Шапка: `hidden = (downloaded == 1)`; клик → `openSettings("updates")` + `scrollIntoView` секции GameAssets.
- `gaDownload()` — `POST /api/game_assets_download`, поллинг `GET /api/game_assets_progress` каждые ~600 мс: проценты `done/total`, `extracting` → «Распаковка…»; `done` → `gaStateLoad()` (кнопка шапки прячется); `error` → тост. Рестарта/Updater'а нет.

**`static/css/overrides.css`:** `#btn-gameassets[hidden]{display:none}` по аналогии с `#btn-update`.

**Локали `ru/en/de/zh.json`:** ~7 ключей (`ga_title`, `ga_hint`, `ga_download`, `ga_redownload`, `ga_downloaded`, `ga_downloading`, `ga_extracting`, `ga_checking`) — все строки через `t()`, русского текста в коде нет.

## 4. Цепочка поиска данных (приоритет — последний, перед `GameScripts`)

Новый чистый хелпер без циклов импорта, напр. `terminator_toolset/infrastructure/gameassets_path.py`: `game_assets_root(config, program_dir)` → `<program_dir>/GameAssets`, только если `config.game_assets_downloaded == 1` и папка существует. `program_dir` — тот же, что `app.py` вычисляет для `Updates` (frozen — рядом с exe, dev — корень исходников).

Точки вставки (везде — после проект/мод/распакованная игра, перед `_gamescripts_dir()`):
- `uprising_service._layer_roots()` — новый слой (покрывает иконки, `icon_map`, `gun_index`, `_custom_*` автоматически);
- `uprising_service.species_file()` — кандидаты из GameAssets;
- `uprising_service.sysnames()` — `scan_roots += [gameassets]`;
- `uprising_service.unit_meta()` / `swt_sources()` — дописать корень на бэкенде (сигнатуры и фронтенд не менять);
- `domain/project.py` (карта `sysname → display_name` из `localization/...`) — сканировать и GameAssets-корень.
- Guard (`guard_service`) — не трогать, папка только для чтения по построению.

## 5. Гейты и проводка UI

- `scripts/verify-ui-wiring.mjs` — ассерты: `#btn-gameassets`, `#ga-download`, `#ga-progress` в HTML; биндинги `$("#btn-gameassets")`, `gaDownload` в JS.
- После правок: `node --check` тронутых JS, `node scripts\verify-ui-wiring.mjs`, `python scripts\verify_history.py`. Exe не пересобирать (`dist` не трогать), `updater.py` / `apply_pending_update` / `unpacked_path` — не трогать.

## 6. Проверка вручную (dev, `python main.py`)

1. Воркер на фикстурах релиза с двумя ZIP: `/release` отдаёт программный, `/gameassets` — ассетный, `/asset` без `kind` отвергает id ассета.
2. В настройках: «Скачать ассеты» → прогресс-бар под секцией → папка `GameAssets` рядом с exe → флаг `1`, кнопка шапки исчезла.
3. Удаление `GameAssets` вручную + перекачивание → снова `1`, без рестарта.
4. Данные: sysname только в `GameAssets` → находится в автодополнении/SWT-источниках; при наличии в проекте побеждает проект.
5. Чистый профиль (`downloaded=0`) → кнопка в шапке видна и ведёт в настройки к секции.

## Краевые случаи

- GameAssets нет в релизе → `/gameassets` 404, фронт показывает «архив не найден», кнопка шапки остаётся.
- ZIP с вложенной топ-папкой `GameAssets/` → схлопнуть, не допускать `GameAssets/GameAssets/`.
- Параллельное скачивание обновления и ассетов — разные `_progress`, друг друга не блокируют.
- `game_assets_version` — только информация (тег релиза-источника); автообновления ассетов нет, только ручная кнопка.
