# Gates: исправление проекта (батч UI/окна/настройки)

OWNS: TerminatorSheetQt/**

Scope: дерево видит .swt + раздел SWT; настройки — фикс. размер модалки, шрифт +20%, кнопка папки у пути, свёртывание в трей при открытии в браузере; браузер грузится без F5; подписи снизу вкладок (Распаковка/Создание модов/Сравнение); окна по центру; fullscreen не поверх панели задач; страница «Сравнить»: поиск ключей внутри дропдауна, попап Ctrl+F на сторону, fs на весь экран со свернуть/закрыть, без шапки «Сравнение»; главная — кнопки наверх по центру.

- [x] G1: API-дерево обрезано (глубина ≤5 с DLC, только xml/swt); дефолты фильтров фронта равны набору бэкенда (правило ADR-001 §14)
  CHECK: python scripts/gate_tree_swt.py
  EXPECT: TREE FILTERS OK
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\CloudLayer\Projects\Terminator Project\TerminatorSheetQt; path=fbf6a1c720a4/27 entries; EXPECT=matched; output-sha256=0bb58af5d09d2b45ebf521c6ba7ddbbeac0c2a25040dd442731c5de7522cf32d; output-bytes=120

- [x] G2: фронтовая разводка: SWT-кнопки среди остальных (тулбар+главная), «Недавние» отдельной строкой по центру, подписи-футеры трёх вкладок, инлайн-кнопка папки в настройках/путях, фикс. размер модалки настроек + шрифт, чекбокс «в трей при браузере», CSS-фикс key-dd-pop[hidden], попапы поиска+замены сравнения (копия find-bar, лево/право), fs-модалка без встроенного поиска со свернуть/закрыть, шапка «Сравнение» удалена, соединённые вкладки сайдбара
  CHECK: node scripts/verify-ui-wiring.mjs
  EXPECT: PROJECT FIX GATE PASSED
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\CloudLayer\Projects\Terminator Project\TerminatorSheetQt; path=fbf6a1c720a4/27 entries; EXPECT=matched; output-sha256=2d21839b8652333d27f65dca4b7ad6b1e990f3b676e1932ca5c0da3c3af69b9f; output-bytes=90

- [x] G3: бэкенд-поведение: config browser_to_tray разрешён в /api/config; main.py — окно hidden, «полный экран» через WorkingArea (без maximized/fullscreen/showMaximized, панель задач не перекрыта), minimize_to_tray/toggle_fullscreen/_apply_maximize; регресс py_compile + test_api + test_roundtrip + verify_history
  CHECK: python scripts/gate_backend.py
  EXPECT: BACKEND OK
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\CloudLayer\Projects\Terminator Project\TerminatorSheetQt; path=fbf6a1c720a4/27 entries; EXPECT=matched; output-sha256=af7ced734dad6eefca4f5e2dadddbff97ea28a7ed0d1a385b729ef3fdc568900; output-bytes=12

- [x] G4: HTTP-зонд: / и загрузочные /api/* отдаются целиком (не виснут), ответ байтово полный
  CHECK: python scripts/gate_http_probe.py
  EXPECT: HTTP PROBE OK
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\CloudLayer\Projects\Terminator Project\TerminatorSheetQt; path=fbf6a1c720a4/27 entries; EXPECT=matched; output-sha256=b31a47192c4e3f4ef2619bbc8e2f5c2b61e62a422859ff258e4407a74ecd59e2; output-bytes=984

- [ ] G5: модалка настроек: один фиксированный размер на всех вкладках, крупнее и с шрифтом ~+20% (визуально)
  EVIDENCE: pending

- [ ] G6: лаунчер и главное окно открываются по центру экрана, отрисовка уже в центре, главное окно не видно до готовности (визуально)
  EVIDENCE: pending

- [ ] G7: «Открыть в браузере» — страница грузится сразу; при включённой настройке окно прячется в трей, клик по иконке возвращает (визуально)
  EVIDENCE: pending

- [ ] G8: «Полный экран» программы не перекрывает панель задач Windows (развёрнутое окно) (визуально)
  EVIDENCE: pending

- [ ] G9: страница «Сравнить»: поиск ключей открывается внутри дропдауна ключей; Ctrl+F/Ctrl+H — попап поиска и замены (копия главной) у своей стороны (левый у разделителя, правый у правого края), работает и в fullscreen; fs-кнопка — весь монитор, «Свернуть» минимизирует окно программы; строки-шапки «Сравнение» нет (визуально)
  EVIDENCE: pending

- [x] G10: карта Uprising: upr-map-data.js валиден и содержит 22 сектора (player 3, legion 6, integrators 2, founders 4, grey 7 — серые 5,6,7,8,9,14,15); маршрут /assets/map/map.jpg отдаёт 200; вкладка Uprising грузит карту без client[unhandled] в логе; панель параметров сворачивается шевроном
  CHECK: node --check static/js/upr-map-data.js && node -e "…SECTORS check…" && HTTP GET /assets/map/map.jpg
  EXPECT: SECTORS 22 {"player":6,"integrators":2,"legion":8,"founders":4,"grey":2}
  EVIDENCE: EVIDENCE (rev.2, 2026-09-02): нумерация и фракции выверены по скриншоту игры (avg dist 0.019, биекция); зоны сомкнуты BFS-тайлингом (без зазоров и пересечений); щиты-бейджи вместо прямоугольников; выбор цвета зоны (6 цветов, localStorage tsh_upr_colors, кнопка «Цвета зон»). node --check ok (app.js + upr-map-data.js); SECTORS 22 {"player":6,"integrators":2,"legion":8,"founders":4,"grey":2}; verify-ui-wiring 4 gate PASSED
