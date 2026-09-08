# План: новая система рандомайзера карты Uprising (v2)

> Статус: РЕАЛИЗОВАНО 08.09.2026 (бэкенд v2 + 4 режима + редактор + гейт RND V2).
> Язык: только русский, в коде тоже.

## 1. Что есть сейчас

* Карта: 22 сектора (`static/js/upr-map-data.js`), фракции `player/legion/integrators/founders/grey`, столицы `1,4,12,22` (`static/js/uprising.js`).
* Рандомайзер: `static/js/upr-random.js` — один алгоритм с ручными слайдерами `k 0..2`, веса по категориям, `factionMode own|mix`, `softTol ±1`, `noOrigin/noNeighbours/cap`, сироты `nearest|stay|skip`, сид. Сложность юнита `4` или `3-5`, пусто = наследование зоны.
* Настройки карты (шестерёнка): `templates/index.html`, 2 вкладки `Сектора` и `Пресеты и конфиг` (`uprising.js: uprOpenColors`).
* Пресеты: `UprisingPresets/easy|normal|hard|chaos.cfg` — статичные раскладки формата `.cfg v1` (`ZONE` + строки юнитов). Сериализация: `terminator_toolset/services/uprising_service.py: cfg_write_file/cfg_read`.
* Мета юнитов: `/api/upr_unit_meta` отдаёт `factions` и `costs` из `species/*.xml`.
* Автокомплит: `swtAutocomplete` (`static/js/swt.js`), списки `uprSysnamesFor(cat)`, поповер чипа `uprEditPop`.
* Стиль: `static/css/uprising.css` (`upr-rnd-*`, `upr-chip*`, `upr-shield*`), модалки `upr-rnd-modal`, `upr-colors-modal`.

Вывод: пресеты и рандомайзер не связаны. Пресеты фиксированные, рандомайзер слишком технический.

## 2. Цель

* Режимы `Легко / Баланс / Сложно / Хаос` сразу в формате `v2`.
* Интерфейс рандомайзера простой и понятный игроку.
* Файлы сложности правит автор вручную в Блокноте + в красивом попап-редакторе в стиле рандомайзера.
* Старый технический функционал сохраняется во вкладке `Эксперт`.
* Локалей в конфиге нет, вся локализация тянется из основной (`locales/*.json`).

## 3. Файлы режимов v2

### 3.1 Расположение

```
TerminatorToolSet/UprisingRandomizer/
  easy.cfg
  balanced.cfg
  hard.cfg
  chaos.cfg
TerminatorToolSet/UprisingCustomRandomizer/
  *.cfg  # свои пресеты пользователя, перекрывают встроенные
```

* `compiler/embed_assets.py` и `embedded_cache.py` пакуют `UprisingRandomizer/` как `UprisingPresets/`.
* Правка встроенного файла из ToolSet молча идёт в `Custom`, встроенный не затирается.
* Обновление программы не трогает `UprisingCustomRandomizer/`.

### 3.2 Формат v2 (правится руками)

```ini
# Terminator Overhaul - Uprising randomizer config v2
# Mode: easy (названия — в locales, здесь не править)
[MODE]
name = easy

[RULES]
faction_mode = own        # own | mix | free
chaos_k = 0.4             # 0..2 сила перемешивания
count_heads = true
diff_soft_pm = true       # галка «±1»: регион 4 → юниты 3-5
no_origin = false
no_neighbours = false
cap_heads = 20            # 0 — без лимита
seed_default = 12345

[WEIGHTS]
squads = 1
cars = 2
tanks = 3
helicopters = 3
inventory_items = 0.2

[SECTORS]
# num = difficulty faction protect
# difficulty 1..6 обязательна; protect: - | start | capital
1 = 1 player start
2 = 1 player start
3 = 3 integrators -
4 = 3 integrators capital
8 = 4 legion -
12 = 2 founders capital
22 = 1 player start
# ... все 22 зоны, пропущенная = взять с карты, при сохранении дописать явно

[UNITS]
# sysname = difficulty category
# difficulty: N или N-M (1..6); category для контроля
fnd_infantry = 1-2 squads
fnd_rangers = 2 squads
lgn_drones = 4 squads
fnd_abrams = 4 tanks
upgrd_accuracy_generic = 3 inventory_items
# юнита нет в списке = наследует сложность зоны-источника

[LOOT]
rare_min_cost = 1500
rare_only_diff = 4
rare_in_capital = true
common_free = true
```

Правила парсинга (`cfg_read` расширить):

* есть `[MODE]` = `v2`, нет = `v1`, читаем как раньше;
* `#` — комментарий, неизвестный ключ — предупреждение в лог, не ошибка;
* неверное значение — ошибка с файлом, секцией и номером строки, файл не применяется;
* `5-3` нормализуем в `3-5`.

## 4. Режимы

| Режим | Правила по умолчанию | Поведение |
|---|---|---|
| Легко | `k=0.4, own, diff_soft_pm=вкл` | Дешёвые по `cost` игроку, сильное Легиону вдаль, стартовые `1,2,22` безопасны (`difficulty 1-2`), редкие предметы чаще у игрока |
| Баланс | `k=1.0, own, diff_soft_pm=вкл` | `cost`-квантили → `1..6`, строгое попадание в диапазон, выравнивание `Σ cost` по зонам |
| Сложно | `k=1.2, own, diff_soft_pm=выкл` | Дорогие юниты соседям игрока, `cap_heads` на сектора игрока |
| Хаос | `k=2.0, mix, no_origin=true, diff_soft_pm=выкл` | Игнор `difficulty` и фракций, предметы всё равно по `[LOOT]` |

Общие гарантии: стартовые и столицы не пустеют, исключённые сектора не участвуют, сид в отчёте, применение одним батчем `uprWriteCells`, план одноразовый.

Предметы отдельным проходом после юнитов: редкие (`cost >= rare_min_cost`) только в `diff >= rare_only_diff` или столицы.

## 5. Простой интерфейс рандомайзера

Модалка `upr-rnd-modal` (переделка `uprRndOpen`):

```
[Легко] [Баланс] [Сложно] [Хаос] (✏️ Редактировать рядом с активным)
Одно предложение описания режима.
[Сид: 12345] [кубик новый]
[x] Сложность юнитов ±1 от региона (Регион 4 → 3-5)
[x] Редкие предметы только в сложных секторах
[Рассчитать] → таблица Было/Стало/Δ + мощь Σ cost
[Применить] [Отменить]
```

Слайдеры `k`, веса, `factionMode`, `cap`, сироты уезжают в `Эксперт`. Галка `±1` остаётся в простом виде (требование), вкл = допуск с половинным весом на краях, выкл = строгое попадание.

## 6. Настройки карты — 4 вкладки

`upr-colors-modal` из 2 вкладок (`Сектора`, `Пресеты и конфиг`) становится 4:

1. `Сектора` — без изменений.
2. `Рандомайзер` — режим по умолчанию, `Открыть рандомайзер`, чекбоксы `редкие предметы / защищать стартовые / защищать столицы`.
3. `Эксперт` — переезд всего старого (`k`, веса, `own|mix`, география, `Привязать сложность`, `Предложить по стоимости`), пометка `для опытных`.
4. `Пресеты и конфиг` — как сейчас + `Активный файл режима` + `Сохранить результат как свой пресет`.

Новые ключи только в `locales/*.json`: `upr_set_rnd`, `upr_set_expert`, `upr_rnd_mode_easy/balanced/hard/chaos` + `_d`, `upr_rnd_pm` (±1), `upr_rnd_rare`, ключи редактора.

## 7. Попап-редактор конфига (в стиле рандомайзера, не текстовое окно)

### 7.1 Открытие

Кнопка `✏️` рядом с выбором режима в рандомайзере и в настройках (`Активный режим: balanced.cfg [✏️] [Открыть папку]`). Окно `upr-cfg-editor-modal`, каркас `modal-card wide upr-rnd-card`, табы `[Секторы] [Юниты и предметы] [Правила]`, фут с кнопками по п.8.

### 7.2 Стиль = стиль рандомайзера

* Группы `upr-rnd-group + upr-rnd-gtitle + upr-rnd-hint`, строки `upr-rnd-row`, слайдеры `upr-slider-row` 200px.
* Щиты `uprRndShield`, чипы `upr-chip` с бейджем `череп + сложность ×n`, кнопка `upr-chip-add`.
* Хелперы `group()/chk()/slider()` вынести в общий `upr-ui.js` для обоих окон.
* Сырой текст `v2` только как свернутый read-only блок `Показать как текст (для Блокнота)`.

### 7.3 Вкладки

* `Секторы`: таблица 22 строк `Щит+№ | Сложность 1-6 select | Фракция select | Защита select (нет/start/capital)`.
* `Юниты и предметы`: чипы по категориям + таблица `Sysname-комбобокс | Категория select | Сложность 4/3-5 | ✕`. Комбобокс = `input + swtAutocomplete`, источник `uprSysnamesFor(cat)` + `upr_unit_meta`, ввод свободный (выбор или свой текст). Неизвестный подсвечиваем `unknown`, сохраняем с предупреждением. Кнопки `+ Добавить`, `Импорт с карты`, поиск и фильтр по категории.
* `Правила`: radio `own|mix|free`, слайдер `chaos_k`, галка `±1`, блок `Лут`, `cap_heads/no_origin/no_neighbours`.

## 8. Сохранение: встроенные vs свои

* Открыт встроенный: фут `[Сохранить новый пресет] [Проверить] [Отмена]`, кнопки `Сохранить` нет. `Сохранить новый пресет` → `askPrompt` → пишет в `UprisingCustomRandomizer/<имя>.cfg`, дефолт имени `<режим> — копия`, конфликт → диалог перезаписи только для своих.
* Открыт свой: фут `[Сохранить] [Дублировать] [+ Новый] [Проверить] [Удалить] [Отмена]`. `Дублировать` копирует секции и меняет `[MODE] name`, открывает копию. `+ Новый` — черновик с дефолтами `balanced`. `Удалить` — `askConfirm danger`, только свои. Бейдж `Встроенный (только чтение)` / `Свой пресет`.
* Список режимов группируем `Встроенные / Мои` (паттерн `uprPresetFill`), свой с тем же именем перекрывает встроенный с пометкой.

## 9. Шаги реализации (не выполнять)

1. Бэкенд: `rnd_dirs()`, `rnd_mode_read/write/duplicate/delete`, роуты `uprising_rnd_modes/_get/_save/_reset/_delete/_duplicate`, детект `v1/v2`, упаковка `UprisingRandomizer/`.
2. Создать 4 файла `v2` с русскими комментариями.
3. Фронт: режимы в `upr-random.js`, 4 таба в `uprising.js`, новый `upr-cfg-editor.js` + модалка в `index.html`, стили в `uprising.css`, локали.
4. Проверки: `node --check static/js/upr-random.js`, `node --check static/js/uprising.js`, `node scripts/verify-ui-wiring.mjs`, `python scripts/verify_history.py`, ручной прогон каждого режима и сценарий редактора (встроенный → новый пресет, свой → сохранить/дублировать/удалить, опечатка в `.cfg` → понятная ошибка).
