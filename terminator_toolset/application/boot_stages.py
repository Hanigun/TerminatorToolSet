"""Boot stages: single source of truth for the 0-100 launcher progress.

Порядок запуска (время идёт сверху вниз, проценты строго растут):

  backend, до сервера (в лог; бар ещё не виден — splash опрашивает по HTTP):
    2  boot_lock     single-instance lock
    4  boot_log      логирование настроено
  boot-Flask (минимальное приложение: /splash + /api/boot_progress):
    6  boot_core     каркас boot-сервера собран
    10 boot_port     bind случайного localhost-порта (ретраи отдельно)
    14 boot_up       поток serve_forever запущен, порт известен
    18 boot_health   живой HTTP-самопробник (реальный GET, не in-process)
  окно (нужен .NET/WebView2; splash уже виден, бар живой):
    22 boot_gui      .NET-мост проверен
    26 boot_splash   окно-лаунчер создано
  тяжёлый билд (ПОСЛЕ показа лаунчера — первый старт пишет конфиги/БД
  уже при видимом баре):
    30 boot_cfg      Config (генерация config.json при первом старте)
    34 boot_db       Database (создание terminator_sheet.db, миграции)
    38 boot_services  сервисы create_app собраны
    42 boot_routes    маршруты подключены
    46 boot_swap      hot-swap WSGI живого сервера на полное приложение
    50 boot_updates   проверка обновлений (сеть, в потоке launcher)
    54 boot_window    главное окно создано (было 18 — там бар и замирал)
    58 boot_hooks     DnD-хуки + разворот окна (пост-поток, GUI не держит)
  фронт (загрузчик скриптов + init):
    59 сырой пинг CSS-гейта (без ключа, ниже порога seen — страница жива)
    60 boot_css      страница жива, ждёт стили (ниже порога seen)
    62-74 boot_scripts  каждый из 14 скриптов двигает бар (было молчание 18→25)
    78 boot_start    скрипты встали (порог seen для вотчдога — было 25)
    82 boot_config   настройки и язык
    86 boot_ui       построение интерфейса
    88 boot_trees    деревья файлов запущены
    90 boot_project  проект прошлого запуска
    92 boot_tree     дерево построено
    96 boot_tabs     вкладки восстановлены
    100 boot_done    main_ready, лаунчер гаснет

Чувствительные этапы изолированы: bind (10), health (18) и swap (46) —
у каждого свой ретрай/проверка, провал красит подпись, а не вешает бар.
После каждого пинга — короткая уступка (YIELD), чтобы поток splash-опроса
и серверные треды успели ответить: лишняя секунда на весь старт заложена.
"""
from __future__ import annotations

import json
import os
import time

# процент -> ключ подписи (локали boot_*; резолв — boot_label)
STAGES = [
    (2, "boot_lock"),
    (4, "boot_log"),
    (6, "boot_core"),
    (10, "boot_port"),
    (14, "boot_up"),
    (18, "boot_health"),
    (22, "boot_gui"),
    (26, "boot_splash"),
    (30, "boot_cfg"),
    (34, "boot_db"),
    (38, "boot_services"),
    (42, "boot_routes"),
    (46, "boot_swap"),
    (50, "boot_updates"),
    (54, "boot_window"),
    (58, "boot_hooks"),
    (60, "boot_css"),
    # 62..74 ставит загрузчик скриптов (templates/index.html), ключ boot_scripts
    (78, "boot_start"),
    (82, "boot_config"),
    (86, "boot_ui"),
    (88, "boot_trees"),
    (90, "boot_project"),
    (92, "boot_tree"),
    (96, "boot_tabs"),
    (100, "boot_done"),
]

# фронт считает «скрипты живы» с этого процента (раньше было 25)
SEEN_PCT = 60

# уступка GIL после каждого пинга: splash-опрос и HTTP-треды отвечают
# без заторов; ~25 стадий * 0.06с ≈ полторы секунды на весь старт
YIELD = 0.06

_LABEL_MEM = {"lang": "", "map": {}}


def boot_label(lang, key):
    """Подпись стадии на языке интерфейса. До Config (язык неизвестен) —
    русский. Фолбэк — английский, затем сам ключ."""
    lang = (lang or "ru").lower()
    mem = _LABEL_MEM
    if mem["lang"] != lang:
        mem["map"] = {}
        mem["lang"] = lang
    m = mem["map"]
    if key in m:
        return m[key]
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    hit = ""
    for cand in (lang, "en", "ru"):
        try:
            with open(os.path.join(base, "..", "locales", cand + ".json"),
                      "r", encoding="utf-8") as fh:
                hit = (json.load(fh) or {}).get(key) or ""
        except Exception:  # noqa: BLE001
            hit = ""
        if hit:
            break
    m[key] = hit or key
    return m[key]


def stage(progress, log, lang, pct, key):
    """Один этап: монотонный пинг + строка в boot.log + уступка планировщику.

    progress — общий dict {"pct","label"} (его же опрашивает splash);
    log — boot_log или logging-логгер; lang — код языка для подписи."""
    label = boot_label(lang, key)
    try:
        pct = max(0, min(100, int(pct)))
        if pct >= int(progress.get("pct") or 0):
            progress["pct"] = pct
            if label:
                progress["label"] = label
        elif label and pct == int(progress.get("pct") or 0):
            progress["label"] = label
    except Exception:  # noqa: BLE001
        pass
    try:
        if log is not None:
            if hasattr(log, "info"):
                log.info("boot %d %s", pct, key)
            else:
                log("boot %d %s" % (pct, key))
    except Exception:  # noqa: BLE001
        pass
    try:
        time.sleep(YIELD)
    except Exception:  # noqa: BLE001
        pass
