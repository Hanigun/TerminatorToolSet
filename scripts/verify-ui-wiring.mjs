// Unlazy oracle: static wiring checks for the client bundle.
// Prints one success marker per gate section, only after all its assertions pass.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(root, p), "utf8");
// фронт нарезан на фича-файлы с общим скоупом: гейты ищут по их конкатенации
// в порядке загрузки (FILES в templates/index.html); стили — в порядке
// каскада (<link>-цепочка в templates/index.html), разметка — shell + партиалы
const JS_ORDER = ["upr-map-data.js", "core.js", "grid.js", "tree.js", "findbar.js",
  "compare.js", "swt.js", "uprising.js", "chrome.js", "history.js", "init.js",
  "upr-random.js", "upr-cfg-editor.js"];
const appjs = JS_ORDER.map(f => read("static/js/" + f)).join("\n");
const uprsvc = read("terminator_toolset/services/uprising_service.py");
const CSS_ORDER = ["base.css", "chrome.css", "sidebar.css", "popups.css", "tabs.css",
  "tree.css", "grid.css", "dialogs.css", "create.css", "swt.css", "uprising.css",
  "dnd.css", "compare.css", "findbar.css", "history.css", "menus.css", "widgets.css",
  "theme.css", "unpacker.css", "overrides.css"];
const css = CSS_ORDER.map(f => read("static/css/" + f)).join("\n");
const HTML_ORDER = ["index.html", "partials/page-welcome.html", "partials/page-compare.html",
  "partials/page-create.html", "partials/page-unpacker.html", "partials/page-swt.html",
  "partials/page-uprising.html", "partials/page-uprising-rnd.html"];
const html = HTML_ORDER.map(f => read("templates/" + f)).join("\n");

function section(name, asserts) {
  let bad = 0;
  for (const [cond, msg] of asserts) {
    if (!cond) { console.error("FAIL: " + msg); bad++; }
  }
  if (!bad) console.log(name);
  return bad;
}

// ---------- G2: home button geometry ----------
{
  const block = (sel) => {
    const i = css.indexOf(sel + " {");
    if (i < 0) return "";
    return css.slice(i, css.indexOf("}", i));
  };
  const home = block(".tab-open-file");
  const bar = block(".tab-bar");
  const tab = block(".tab");
  let total = 0;
  total += section("HOME BUTTON GATE PASSED", [
    [/margin:\s*0 0 -1px 0/.test(home), ".tab-open-file must have margin: 0 0 -1px 0 (no side gaps)"],
    [/padding:\s*0 4px 0 0|padding-left:\s*0/.test(bar), ".tab-bar must have zero left padding so the home button touches the edge"],
    [/margin-bottom:\s*-1px|margin:\s*0 0 -1px 0/.test(tab), "tabs must overlap the divider (margin-bottom: -1px)"],
    [/margin-bottom:\s*-1px|margin:\s*0 0 -1px 0/.test(home), "home button must overlap the divider like tabs"],
  ].map(([c, m]) => [c, m]));
  if (total) process.exit(1);
}

// ---------- G5: redo button + hotkey hygiene ----------
{
  // горячие клавиши переназначаемые: undo/redo через hkMatch (config.hotkeys)
  const i = appjs.indexOf('const isUndo = hkMatch("undo", e);');
  const seg = i >= 0 ? appjs.slice(i, i + 600) : "";
  const bad = section("UI WIRING GATE PASSED", [
    [/id="btn-redo"/.test(html), "index.html must declare #btn-redo"],
    [/\$\("#btn-redo"\)\.onclick\s*=/.test(appjs), "app.js must bind #btn-redo"],
    [/bu\.disabled\s*=\s*!canUndo/.test(appjs), "app.js must toggle the undo button disabled state"],
    [/br\.disabled\s*=\s*!canRedo/.test(appjs), "app.js must toggle the redo button disabled state"],
    [i >= 0, "undo/redo hotkey branch missing"],
    [/if \(e\.repeat\) return;/.test(seg), "held-down undo/redo keys must be ignored (e.repeat guard)"],
    [/can_undo/.test(appjs) && /can_redo/.test(appjs), "undo/redo availability flags must be consumed"],
  ]);
  if (bad) process.exit(1);
}

// ---------- G6: click-then-type cell editing + subtle focus ----------
{
  const bad = section("EDIT UX GATE PASSED", [
    [/e\.key\.length === 1/.test(appjs), "printable-char keydown must be detected"],
    [/beginEdit\([^)]*,\s*e\.key\)/.test(appjs), "typed character must seed beginEdit"],
    [/state\.selCell/.test(appjs) && /beginEdit\(/.test(appjs), "clicking the selected cell again must begin editing"],
    [/\.cell-focus/.test(css), "style.css must define the subtle .cell-focus highlight"],
    [/classList\.remove\("cell-focus"\)/.test(appjs), "previous cell focus must be cleared"],
  ]);
  if (bad) process.exit(1);
}

// ---------- G7: global source Project|Game|Mod + compare undo sync ----------
{
  // backend routes live in terminator_toolset/api/ (app.py is a thin factory)
  const py = read("app.py")
    + read("terminator_toolset/api/project.py")
    + read("terminator_toolset/api/shell.py")
    + read("terminator_toolset/api/uprising.py");
  const splash = read("templates/splash.html");
  const bad = section("SOURCE SWITCH GATE PASSED", [
    [/id="sb-tab-mod"/.test(html), "index.html must declare #sb-tab-mod"],
    [/data-i18n="tree_tab_mod"/.test(html), "mod tab/switches must use the tree_tab_mod label"],
    [/id="upr-src"[\s\S]{0,600}?data-src="mod"/.test(html), "map header switch must have the mod position"],
    [/id="cmp-left-src"[\s\S]{0,600}?data-src="mod"/.test(html), "compare left side must have its own 3-way switch"],
    [/id="cmp-right-src"[\s\S]{0,600}?data-src="mod"/.test(html), "compare right side must have its own 3-way switch"],
    [/\.src-seg-ind/.test(css) && /translateX\(100%\)/.test(css) && /translateX\(200%\)/.test(css), "style.css must slide the segment indicator across 3 positions"],
    [/\.src-seg-btn:disabled/.test(css), "style.css must dim the unavailable segment position"],
    [/\/api\/mod_tree/.test(py), "backend must serve /api/mod_tree"],
    [/function setSrc\(/.test(appjs) && /localStorage\.setItem\("tsh_src"/.test(appjs), "global source must persist"],
    [/s === other && canElse/.test(appjs), "compare must dim the source picked on the other side"],
    [/function cmpRestoreSides\(/.test(appjs) && /tsh_cmp_" \+ side/.test(appjs), "compare must re-apply saved side sources once availability changes (init runs before the background project load)"],
    [/async function loadProject\(path\)[\s\S]{0,2500}?cmpRestoreSides/.test(appjs), "project load must repaint compare side switches (stale segments let game be picked on both sides)"],
    [/cmpSyncUndoButtons\(\);/.test(appjs) && /state\.cmpLastSide = "left";/.test(appjs), "compare mutations must re-sync undo/redo buttons"],
    [/function uprPaintNofile\(/.test(appjs) && /id="upr-nofile-actions"/.test(html), "map empty state must offer a quick action"],
    [/function histInProject\(/.test(appjs) && /stockTargets/.test(appjs), "stock rollback must only target in-project files"],
    [/loadOne\(0\)/.test(html) && /<script src="\/static\/js\/app\.js/.test(html) === false, "boot scripts must load via the retrying loader, not sync tags"],
    [/readyState === "loading"/.test(appjs), "init must start exactly once for both sync and dynamic script loading"],
    [/\/api\/boot_progress/.test(py) && /boot_ping/.test(py), "backend must serve the boot progress channel"],
    [/id="fill"/.test(splash) && /id="pct"/.test(splash) && /fetch\("\/api\/boot_progress"/.test(splash), "splash must poll the real boot progress 0-100"],
    [/logo_data_url/.test(splash) && /_logo_data_url\(config, base\)/.test(py), "splash must inline the logo as a data-URL (a separate icon request arrives after the page, frozen unpack stalls it)"],
    [/function bootPing\(/.test(appjs) && /function bgTreeDone\(/.test(appjs), "frontend must report boot stages and warm heavy trees in background"],
    // карта: гонка параллельных загрузок (дабл-клик, смена источника mid-flight)
    [/loadSeq/.test(appjs) && /state\.uprising\.loading/.test(appjs), "map load must carry a generation token + in-flight guard"],
    [/my !== state\.uprising\.loadSeq/.test(appjs), "stale map responses must be dropped by the generation guard"],
    [/const root = uprSrcRoot\(\);[\s\S]{0,400}?fresh\(\)/.test(appjs) || /root === uprSrcRoot\(\)/.test(appjs), "icon bundle must be pinned to the source root it was requested for"],
    [/dataset\.uprRetry/.test(appjs) && /uprIconUrl\(it\.name(,|\))/.test(appjs), "map chips must retry a broken icon once (torn HTTP/1.0 connection)"],
    [/\/assets\/map\/global_map\.webp\?v=" \+ Date\.now\(\)/.test(appjs) && /img\.dataset\.uprRetry/.test(appjs), "map texture must reload once on a broken first fetch"],
    [/return \("", 503\)/.test(py), "icon endpoint must answer 503 on a transient serve failure, not the silent placeholder"],
    [/function uprFreshState\(\)[\s\S]{0,500}?loadSeq: 0/.test(appjs) && /state\.uprising = uprFreshState\(\);/.test(appjs), "map state must reset via the single default carrying loadSeq (reopen after close must load)"],
  ].map(([c, m]) => [c, m]));
  if (bad) process.exit(1);
}
{
  const cssBlock = (sel) => {
    const i = css.indexOf(sel + " {");
    if (i < 0) return "";
    return css.slice(i, css.indexOf("}", i));
  };
  const keyPop = cssBlock(".key-dd-pop");
  const setCard = cssBlock("#settings-modal .modal-card");
  const bad = section("PROJECT FIX GATE PASSED", [
    // swt: раздел-категория в дереве + кнопки среди остальных кнопок
    [/key:\s*"swt_scripts"/.test(appjs), "app.js must declare the swt_scripts tree category"],
    [/id="btn-swt"/.test(html), "index.html must declare the toolbar SWT button"],
    [/id="landing-swt"/.test(html), "index.html must declare the landing SWT button"],
    [/\$\("#btn-swt"\)\.onclick/.test(appjs) && /\$\("#landing-swt"\)\.onclick/.test(appjs), "app.js must wire both SWT buttons"],
    [/function openSwtEditor/.test(appjs), "app.js must define openSwtEditor"],
    [/id="sb-swt"/.test(html) === false, "sidebar toolbar must NOT hold the SWT button"],
    // подписи живут в субтитрах вкладок таббара, не под заголовками страниц
    [/data-i18n="cm_sub"/.test(html) === false && /data-i18n="up_sub"/.test(html) === false, "create-mod/unpacker pages must NOT hold caption divs under the h2"],
    [/sub:\s*t\("cm_sub"\)/.test(appjs), "create-mod tab must carry its caption in the tab subtitle"],
    [/sub:\s*t\("up_sub"\)/.test(appjs), "unpacker tab must carry its caption in the tab subtitle"],
    [/tb\.type === "create-mod"\) tb\.sub = t\("cm_sub"\)/.test(appjs), "tab subtitles must refresh on language change"],
    [/data-i18n="cmp_foot"/.test(html), "compare tab must have its footer caption"],
    // вид «Мод»: секция подписана Mods/Папка мода, верхние папки — пакеты
    [/overlay_mods/.test(read("locales/ru.json")) && /overlay_mods/.test(read("locales/en.json")), "overlay_mods string must exist in locales"],
    [/MOD_TOP_ICON/.test(appjs) && /folder_packages/.test(appjs), "mod top-level folders must use the packages icon"],
    // карта без shop_presets: оверлей внутри области карты, не блок под шапкой
    [/id="upr-wrap"[\s\S]{0,600}?id="upr-nofile"/.test(html), "nofile must live inside the map wrap as an overlay"],
    [/\.upr-nofile \{[^}]*position:\s*absolute/.test(css), "nofile overlay must be absolutely positioned over the map"],
    // поиск дропдауна сравнения: подсветка + скролл к найденному
    [/cmp-list-mark/.test(appjs) && /scrollIntoView/.test(appjs), "compare dropdown search must highlight and scroll to the match"],
    // распаковщик: чипы .pak зеленеют по очереди во время распаковки
    [/done_files/.test(appjs) && /up-pak\[data-pak=/.test(appjs), "unpacked paks must turn green one by one while running"],
    [/\.up-pak\.done \{[^}]*color:\s*var\(--green\)/.test(css), "done pak chips must be green"],
    [/\.up-pak\.off \{/.test(css) && /state\.upOff/.test(appjs), "pak chips must toggle off (grey) on click"],
    [/skip/.test(appjs) && /unpack_run/.test(appjs), "unpack run must send the clicked-off paks to skip"],
    // главная: кнопки над дропзоной, «Недавние» — в дропзоне под Файл/Папкой
    [/class="dz-actions-top"/.test(html), "welcome must have the top actions strip"],
    [/class="dz-actions-top"[\s\S]*?id="landing-create-mod"/.test(html), "create-mod button must live in the top strip"],
    [/id="dropzone"[\s\S]{0,900}?id="landing-open-file"/.test(html), "file button must stay inside the dropzone"],
    [/id="landing-open-project"[\s\S]{0,1200}?id="landing-records-btn"/.test(html), "recents button must sit below the file/folder buttons, centered between them"],
    [/class="dz-recent"/.test(html) && /\.dz-recent \{[^}]*justify-content:\s*center/.test(css), "recents wrapper must center the button"],
    [/class="dz-actions-top"[\s\S]*?id="dropzone"/.test(html), "top strip must precede the dropzone"],
    // нативный дроп: перехват на дочерних HWND WebView2 + терпеливый добор mailbox
    [/SetWindowLongPtrW/.test(read("terminator_toolset/infrastructure/window.py")) && /EnumChildWindows/.test(read("terminator_toolset/infrastructure/window.py")), "native drop must hook WebView2 child windows, not just the form"],
    [/_drop_rehook/.test(read("terminator_toolset/infrastructure/window.py")), "late WebView2 child windows must get the drop hook in background"],
    [/RevokeDragDrop/.test(read("terminator_toolset/infrastructure/window.py")) && /AllowDrop/.test(read("terminator_toolset/infrastructure/window.py")), "WebView2 OLE drop target must be revoked so the form receives full drop paths"],
    [/RegisterDragDrop/.test(read("terminator_toolset/infrastructure/window.py")) && /IDropTarget/.test(read("terminator_toolset/infrastructure/window.py")), "own IDropTarget must beat Chromium in the registration race"],
    [/pollPendingFiles\(\)\) return/.test(appjs), "drop handler must re-poll the mailbox before the not-found toast"],
    [/id="dnd-overlay"/.test(html) && /dndLock/.test(appjs) && /\.dnd-overlay \{/.test(css), "drop must show a topmost overlay with spinner while opening"],
    [/dnd_drop_hint/.test(read("locales/ru.json")) && /dnd_opening/.test(read("locales/en.json")), "drop overlay strings must be localized"],
    // локализация динамических строк: редактор клавиш + кнопки SWT-сайдбара
    [/t\("hk_change"\)/.test(appjs), "hotkey change button must come from the dictionary"],
    [/data-i18n="swt_add_trig"/.test(html) && /data-i18n="swt_add_var"/.test(html), "SWT sidebar add buttons must be localized"],
    // настройки: фикс. размер + zoom, чекбокс браузер->трей, инлайн-пикер пути
    [/zoom:\s*1\.2/.test(setCard), "settings modal must scale ~+20% (zoom)"],
    [/height:\s*min\(/.test(setCard), "settings modal must have a fixed height for all tabs"],
    [/id="set-browser-to-tray"/.test(html), "settings must declare the browser-to-tray checkbox"],
    [/browser_to_tray:\s*\$\("#set-browser-to-tray"\)\.checked/.test(appjs), "saveSettings must persist browser_to_tray"],
    [/browser_to_tray && window\.pywebview[\s\S]{0,120}minimize_to_tray/.test(appjs), "open-browser must minimize to tray when enabled"],
    [/set-path-row/.test(html) && /id="set-unpacked-pick"/.test(html), "paths tab must have the inline folder pick button"],
    [/set-path-row \{ display:\s*flex/.test(css), "style.css must style the inline path row"],
    [/\.set-path-clear\[hidden\]\s*\{[^}]*visibility:\s*hidden/.test(css), "hidden X must keep its slot (visibility, not display:none) so the path field never jumps"],
    [/((class="icon-btn gold" id="set-)[\w-]+-pick[\s\S]*){3}/.test(html), "all three folder pick buttons must carry the global gold hover"],
    // сравнение: шапка убрана, fs-кнопки; попапы поиска — из общего ядра
    [/data-i18n="cmp_title"/.test(html) === false, "compare h2 header must be removed"],
    [/id="cmp-fs-search"/.test(html) === false, "fullscreen modal must NOT have a built-in search input"],
    [/function mkFindBar\(/.test(appjs), "shared find popup core (mkFindBar) must exist"],
    [/fileFind = mkFindBar\(/.test(appjs), "file tabs must use the shared find core"],
    [/cmpFindBar\[side\] = mkFindBar\(/.test(appjs), "compare must build per-side popups from the shared core"],
    [/swtFind = mkFindBar\(/.test(appjs), "SWT editor must use the shared find core"],
    [/cmpFindOpen\(side\)/.test(appjs), "Ctrl+F must open the side find popup"],
    [/cmpReplaceAll/.test(appjs) && /cmpSetCell\(side, m\.ri, m\.ci, newVal\)/.test(appjs), "replace-all must edit cells via cmpSetCell"],
    [/id="cmp-fs-min"/.test(html) === false && /id="cmp-fs-close"/.test(html), "compare fullscreen modal must have a single close button like other modals"],
    [/function cmpFsClose\(/.test(appjs) && !/function cmpFsMinimize\(/.test(appjs), "fs modal must only restore the pane on close (no minimize path)"],
    [/paneFsWinFs\(true\)/.test(appjs), "compare fullscreen must toggle real window fullscreen (shared paneFsWinFs)"],
    [/.key-dd-pop\[hidden\]\s*\{\s*display:\s*none/.test(css), "key dropdown search must hide with the popup ([hidden] rule)"],
    [/\.sb-tab \{[^}]*flex:\s*1 1 0/.test(css), "sidebar tabs must split tree width in half"],
    [/config\.set\("project_path", ""\)/.test(read("terminator_toolset/services/entity_service.py")), "project close must forget project_path too, not just last_project (or boot resurrects the deleted path)"],
    [/"project_path" in data[\s\S]{0,200}?config\.set\("last_project", ""\)/.test(read("terminator_toolset/api/config.py")), "clearing the project path in settings must also kill last_project auto-reopen"],
    [/state\.config\.project_path = ""/.test(appjs), "sidebar close must mirror the cleared project_path client-side (or the settings field shows the deleted project)"],
    [/id="set-project-clear"[\s\S]{0,80}?set_clear_path/.test(html) && /id="set-unpacked-clear"/.test(html) && /id="set-mod-clear"/.test(html), "each settings path must have a clear (X) button after the folder pick"],
    [/1-1-1V8/.test(html) === false, "no corrupted folder SVG arc (one bad arc kills the whole pick icon)"],
    [/PATH_CLEAR_PAIRS/.test(appjs) && /closeTreeSource\(src\)/.test(appjs), "settings X must close the source via closeTreeSource, not just wipe the field"],
    [/b\.hidden = !i\.value\.trim\(\)/.test(appjs), "settings X buttons must show only when a path is set"],
    [/syncPathClear\(\)/.test(appjs), "openSettings must refresh X visibility after filling the paths"],
    [/set_clear_path/.test(read("locales/ru.json")) && /set_clear_path/.test(read("locales/en.json")), "set_clear_path string must exist in locales"],
    [/!\s*fileOrigin\(path\)[\s\S]{0,60}?return tail/.test(appjs), "external dropped file must not get the Base game prefix in the tab subtitle"],
    [/\.dnd-overlay \{[^}]*pointer-events:\s*none/.test(css), "dnd overlay must not intercept the drag"],
    [/dndHint\(true\)/.test(appjs) === false, "drag hover must not show popups (the file goes to the dropzone)"],
    [/ov\.hidden = false; \}, 400\)/.test(appjs), "spinner overlay must appear only on slow opens (delayed show, no flash on fast ones)"],
    [/\.icon-btn\[hidden\] \{[^}]*display:\s*none/.test(css), "icon-btn display must not override hidden (or settings X buttons show always)"],
  ].map(([c, m]) => [c, m]));
  if (bad) process.exit(1);
}

// ---------- G8: SWT editor file safety ----------
{
  const swt = read("terminator_toolset/domain/swt_editor.py");
  const swtsvc = read("terminator_toolset/services/swt_service.py");
  const bad = section("SWT SAFE GATE PASSED", [
    [/os\.replace\(tmp, path\)/.test(swt), "swt_editor.save_file must write atomically (tmp + os.replace)"],
    [/not utf-8/.test(swt), "swt_editor.parse_file must fail loudly on bad bytes, not replace them"],
    [/float\(mtime or 0\)/.test(swtsvc) && /swt_changed_on_disk/.test(swtsvc), "api_swt_save must refuse to overwrite a file changed on disk (mtime-guard)"],
    [/"mtime": mtime/.test(swtsvc), "swt open/save must exchange mtime with the frontend"],
    [/function swtNextGuid\(/.test(appjs), "new conditions/actions must get a free guid at creation, not empty string"],
    [/findIndex\(x => x\.tag === "Action"\)/.test(appjs), "new conditions must be inserted before the first action"],
    [/cp\.guid = swtNextGuid\(cp\.tag\)/.test(appjs), "duplicated blocks must get a fresh guid immediately"],
    [/function swtUndo\(\)/.test(appjs) && /function swtRedo\(\)/.test(appjs), "SWT editor must have stepwise undo/redo"],
    [/state\.activeTabId === "swt"[\s\S]{0,80}?swtUndo\(\)/.test(appjs), "global undo hotkey/button must route the SWT tab to the local undo stack"],
    [/if \(state\.swt\.fixed\)[\s\S]{0,600}?swtMarkDirty\(\)/.test(appjs), "guid autofix on open must mark the file dirty"],
    [/mtime: state\.swt\.mtime/.test(appjs), "SWT save must send mtime and confirm overwrite on external change"],
    [/state\.swt = swtFreshState\(\);/.test(appjs), "initial SWT state must come from the single default (undo stacks exist before open)"],
    [/id="swt-add-trigger"/.test(html) && /id="swt-add-var"/.test(html), "SWT sidebar must have add-trigger/add-variable buttons"],
    [/id="swt-trig-head"/.test(html) && /id="swt-vars-head"/.test(html) && /function swtSideSec\(/.test(appjs), "SWT sidebar lists must be collapsible sections"],
    [/function swtAddTrigger\(/.test(appjs) && /function swtAddVar\(\)/.test(appjs) && /function renderSwtVars\(\)/.test(appjs), "SWT editor must create triggers and edit variables"],
    [/\$\("#swt-save"\)\.disabled = false/.test(appjs), "opening a file must enable the SWT save button"],
    [/crew_sysname: src\.units/.test(appjs), "crew prompts must use the squads dictionary (crew is a squad, not a humans entry)"],
    [/car_upgrade_presets\.xml/.test(uprsvc) && /squad_presets/.test(uprsvc) && /heli_presets/.test(uprsvc), "swt_sources must scan per-type upgrade preset files"],
    [/byType\[own\]/.test(appjs) && /unitTypeOf/.test(appjs), "upgrade prompts must depend on the unit type of the same action"],
  ].map(([c, m]) => [c, m]));
  if (bad) process.exit(1);
}

// ---------- G9: Uprising randomizer ----------
{
  const apiupr = read("terminator_toolset/api/uprising.py");
  const rnd = read("static/js/upr-random.js");
  const bad = section("RND GATE PASSED", [
    [/\/api\/upr_unit_meta/.test(apiupr) && /_UPR_FACTIONS/.test(uprsvc), "backend must expose unit factions/costs for the randomizer"],
    [/id="uprising-rnd-tab"/.test(html) && /upr-random\.js/.test(html), "page must include the randomizer page and script"],
    [/data-tab-id="uprising-rnd"/.test(html) && /id="upr-rnd-page-body"/.test(html) && /id="upr-rnd-page-foot"/.test(html), "randomizer page must have body and foot containers"],
    [/id="upr-open-rnd"/.test(html) && html.indexOf('id="upr-open-rnd"') < html.indexOf('id="upr-src"'), "randomizer button must sit in the map header left of the Проект|Игра|Мод segment"],
    [/type === "uprising-rnd"/.test(appjs) && /function openUprisingRnd\(\)/.test(appjs), "randomizer must open as a real tab via openUprisingRnd"],
    [/openUprisingRnd\(\);/.test(rnd), "randomizer entry points must route to the page"],
    [/typeof uprRndOverlay === "function"/.test(appjs), "map must call the overlay hook with a fallback when the script is missing"],
    [/upr-map-actions/.test(css) && /\.upr-rnd-page-body/.test(css), "map gear overlay and randomizer page layout must be styled"],
    [/window\.uprRndOverlay = function/.test(rnd), "map gear overlay must be built in upr-random.js"],
    [/function uprBulkDiff\(/.test(appjs), "multi-selection must set difficulty in bulk"],
    [/function uprRndCalc\(/.test(rnd) && /function uprRndApply\(\)/.test(rnd) && /function uprRndUndo\(\)/.test(rnd), "randomizer must calculate, apply and undo"],
    [/upr-rnd-topbar/.test(rnd) && /upr-rnd-topbar/.test(css) && /upr-rnd-seed/.test(rnd), "seed and action buttons must live in the top bar, right-aligned"],
    [/uprRndRng/.test(rnd) && /seed/.test(rnd), "randomization must be seeded and repeatable"],
    [/uprRndIsExcluded/.test(rnd) && !/if \(num === 1\) return/.test(rnd), "sector exclusions must be user-controlled (no hardcoded base lock)"],
    [/uprRndByCost/.test(rnd), "randomizer must suggest difficulty by unit cost"],
    [/upr_rnd_title/.test(read("locales/ru.json")) && /upr_rnd_title/.test(read("locales/en.json")) && /upr_rnd_title/.test(read("locales/de.json")) && /upr_rnd_title/.test(read("locales/zh.json")), "randomizer strings must exist in all 4 locales"],
  ].map(([c, m]) => [c, m]));
  if (bad) process.exit(1);
}

// ---------- G10: self-updates (worker over GitHub releases) ----------
{
  const apiupd = read("terminator_toolset/api/updates.py");
  const updsvc = read("terminator_toolset/services/update_service.py");
  const worker = read("../compiler/worker.js");
  const updfix = read("../compiler/updater.py");
  const updspec = read("../compiler/Updater.spec");
  const buildbat = read("../compiler/build.bat");
  const bad = section("UPD GATE PASSED", [
    [/\/api\/update_state/.test(apiupd) && /\/api\/update_check/.test(apiupd) && /\/api\/update_download/.test(apiupd) && /\/api\/update_progress/.test(apiupd), "backend must serve the update state/check/download/progress routes"],
    [/\/api\/update_restart/.test(apiupd) && /def restart\(self\)/.test(updsvc) && /_updater_binary/.test(updsvc) && /updater\.exe/.test(updsvc), "backend must restart via the external updater.exe (copies after our death, never self-replace while locked)"],
    [!/\/relaunch-wait\//.test(read("main.py")) && !/relaunch-wait=/.test(read("main.py")) && !/relaunch-wait/.test(updsvc), "dead double-process relaunch must be gone (it could never replace its own locked files)"],
    [!/powershell/.test(updsvc) && !/_write_updater/.test(updsvc) && !/robocopy/.test(updsvc), "powershell .ps1 updater must be gone (replaced by updater.exe)"],
    [/WaitForSingleObject/.test(updfix) && /--pid/.test(updfix) && /--staged/.test(updfix) && /--target/.test(updfix) && /--exe/.test(updfix) && /--version/.test(updfix), "updater.py must wait the pid and take staged/target/exe/version args"],
    [/updater\.exe/.test(updfix) && /KEEP_TOP/.test(updfix) && /update_applied\.json/.test(updfix) && /update_pending\.json/.test(updfix), "updater.py must skip itself + user data, write the applied marker and eat pending"],
    [/tkinter/.test(updfix) && /overrideredirect/.test(updfix) && /14161a/.test(updfix) && /ff8a00/.test(updfix), "updater.py must show a splash-like launcher window (tkinter, no console)"],
    [/create_arc/.test(updfix) && /norm_ver/.test(updfix), "updater splash must spin like the launcher and print a single-v version"],
    [/--lang/.test(updfix) && /STRINGS/.test(updfix) && /system_lang/.test(updfix) && /--lang/.test(updsvc), "updater language must come from program settings with a system fallback"],
    [/st_mtime_ns/.test(updfix) && !/sha256/.test(updfix), "updater verify must be instant (size+mtime stat, no full sha256 pass)"],
    [/run_console/.test(updfix), "updater.py must fall back to console progress without tkinter"],
    [/name="updater"/.test(updspec) && /console=False/.test(updspec) && /updater_assets/.test(updspec), "Updater.spec must build a windowed one-file updater.exe with the logo"],
    [/Updater\.spec/.test(buildbat) && /updater\.exe/.test(buildbat) && /del "%COMPILER%\\dist\\updater\.exe"/.test(buildbat), "build.bat must compile updater.exe next to the main EXE only (no outside duplicate)"],
    [/ToolSetLibs\\assets\\icons/.test(buildbat) && /must not ship/.test(buildbat), "build.bat must enforce icons bundled once (no external copy, fail otherwise)"],
    [/rmdir \/S \/Q "%OUT%\\assets\\CustomImages"/.test(buildbat) && /assets\\CustomImages must not ship/.test(buildbat), "build.bat must never pack CustomImages (user icon cache like Logs/, fail otherwise)"],
    [/def ensure_custom_images\(self\)/.test(uprsvc) && /self\.ensure_custom_images\(\)/.test(uprsvc), "icon service must create CustomImages roots at boot (fresh release ships without the folder)"],
    [/fn\.lower\(\) == "updater\.exe"/.test(updsvc), "boot fallback must never self-update updater.exe (frozen v1)"],
    [/cached = None/.test(updsvc) && /is_newer\(str\(cached/.test(updsvc), "state() must hide a cached available that is not newer than current (no phantom dot)"],
    [/cached\["available"\] = None/.test(updsvc), "consuming the applied marker must clear the cached available"],
    [/not os\.path\.isdir\(staged\)/.test(updsvc), "pending with a missing staged dir must be eaten silently (no dead install button)"],
    [!/\/relaunch-wait\//.test(read("main.py")) && !/relaunch-wait=/.test(read("main.py")) && !/relaunch-wait/.test(updsvc), "dead double-process relaunch must be gone (it could never replace its own locked files)"],
    [/update_restart/.test(appjs) && /updRestarted/.test(appjs) && /updDoRestart/.test(appjs) && /updInstall/.test(appjs), "frontend must auto-install staged releases and offer a manual install button"],
    [/register_updates\(app, ctx\)/.test(read("app.py")) && /upd=upd/.test(read("app.py")), "update service must be composed in app.py context"],
    [/contents_directory="ToolSetLibs"/.test(read("../compiler/TerminatorToolSet.spec")), "spec must rename _internal to ToolSetLibs"],
    [/"stringprep"/.test(read("../compiler/TerminatorToolSet.spec")), "spec must pin stringprep hiddenimport (else frozen bind dies: unknown encoding: idna)"],
    [/\/release/.test(worker) && /\/prerelease/.test(worker) && /\/asset/.test(worker) && /GH_TOKEN/.test(worker), "worker.js must serve /release + /prerelease + /asset with a token"],
    [/application\/octet-stream/.test(worker) && /asset not in latest release/.test(worker) && /no-store/.test(worker), "worker /asset must stream the binary with membership check and no-store"],
    [/replace\(.+\{2,\}.+\"\/\"\)/.test(worker), "worker must collapse duplicate slashes (server config ends with /)"],
    [/id="btn-update"/.test(html) && /id="set-upd-check"/.test(html) && /id="set-upd-channel"/.test(html) && /id="set-auto-update"/.test(html) && /id="upd-install"/.test(html) && /id="upd-notes"/.test(html) && /id="upd-progress"/.test(html) && /id="upd-hint"/.test(html) && /id="upd-actions"/.test(html), "page must have header update button, settings tab with check/channel/auto-update/changelog/progress/install"],
    [/function updCheck\(/.test(appjs) && /function updDownload\(/.test(appjs) && /function updPollTick\(/.test(appjs) && /function updPaintInline\(/.test(appjs), "app.js must check, download, poll, and paint inline changelog"],
    [/\.upd-dot/.test(css) && /\.upd-fill/.test(css) && /\.upd-notes-inline/.test(css), "update button dot, progress bar and inline notes must be styled"],
    [/#upd-actions\[hidden\]/.test(css), "flex action rows must not defeat the hidden attribute (update buttons visible only with an update)"],
    [/if \(tab === "updates"\) updStateLoad\(\);/.test(appjs), "opening the updates tab must reload server state (no stale buttons)"],
    [/__version__ as VERSION/.test(read("app.py")), "app version must come from the single package source"],
    [/version = "\d+\.\d+\.\d+"/.test(read("pyproject.toml")), "pyproject.toml must carry the canonical version"],
    [/importlib\.metadata/.test(read("terminator_toolset/__init__.py")) && /pyproject\.toml/.test(read("terminator_toolset/__init__.py")) && !/__version__ = "/.test(read("terminator_toolset/__init__.py")), "package version must resolve from pyproject (metadata first), no hardcoded string"],
    [/pyproject\.toml/.test(read("../compiler/TerminatorToolSet.spec")), "spec must bundle pyproject.toml (frozen exe has no importlib.metadata)"],
    [/UprisingPresets/.test(read("../compiler/TerminatorToolSet.spec")) && !/xcopy "%SRC%\\UprisingPresets"/.test(read("../compiler/build.bat")), "presets must ship inside the exe, no external copy in build.bat"],
    [/Terminator_ToolSet_v%VERSION%\.zip/.test(read("../compiler/build.bat")) && /release_util\.py zip/.test(read("../compiler/build.bat")), "build.bat must pack a versioned Terminator_ToolSet_vX.Y.Z.zip"],
    [/chcp 65001|^[ -~\r\n]*$/.test(read("../compiler/build.bat")), "build.bat must stay ASCII-only (Cyrillic steps show mojibake under codepage 866)"],
    [/UprisingPresets/.test(updfix) && /assets", "icons"/.test(updfix), "updater must drop stale external presets/icons (bundled now, externals would shadow)"],
    [/is_newer/.test(updsvc) && /apply_pending_update/.test(updsvc), "update service must compare versions and apply staged releases"],
    [/\/asset/.test(updsvc) && /browser_download_url 404/.test(updsvc), "downloads must go through the worker /asset proxy (direct links 404 on private repos)"],
    [/keeping pending/.test(updsvc) && /time\.sleep\(2\)/.test(updsvc), "apply must retry locked files before keeping pending (half-new install crashes next boot)"],
    [/\.old/.test(updsvc) && /os\.rename\(dst, old\)/.test(updsvc), "apply must rename locked exe/DLLs aside (running image cannot be overwritten)"],
    [/_same_file/.test(updsvc), "apply must verify staged files byte-for-byte under the same names"],
    [/upd_restarting/.test(read("locales/ru.json")) && /upd_restarting/.test(read("locales/en.json")) && /upd_restarting/.test(read("locales/de.json")) && /upd_restarting/.test(read("locales/zh.json")), "restart string must exist in all 4 locales"],
    [/upd_applying/.test(read("locales/ru.json")) && /upd_just_updated/.test(read("locales/en.json")) && /upd_install/.test(read("locales/de.json")) && /set_auto_update/.test(read("locales/zh.json")), "updater strings (applying/installed/install/auto-update) must exist in all 4 locales"],
    [/just_updated/.test(updsvc) && /update_applied\.json/.test(updsvc), "backend must report the updater-installed version once via update_applied.json"],
    [/auto_update/.test(read("terminator_toolset/domain/config.py")) && /"auto_update": False/.test(read("terminator_toolset/domain/config.py")), "auto_update must default to off in config DEFAULTS"],
    [/auto_update/.test(read("terminator_toolset/infrastructure/window.py")), "startup update check must be gated on auto_update"],
    [/updAutoTick/.test(appjs) && /updAutoTried/.test(appjs), "frontend must finish staged/pending updates once at boot when auto_update is on"],
    [/set-auto-update/.test(appjs) && /auto_update: \$\("#set-auto-update"\)\.checked/.test(appjs), "settings must wire the auto_update checkbox"],
    [/kill_child_processes/.test(read("terminator_toolset/infrastructure/procutil.py")) && /TerminateProcess/.test(read("terminator_toolset/infrastructure/procutil.py")), "procutil must kill own webview children via Toolhelp snapshot"],
    [/kill_child_processes/.test(updsvc) && /_kill_kids/.test(read("terminator_toolset/infrastructure/window.py")), "restart and window close must kill own webview ghosts (they pin the profile/locks)"],    [/server\.rstrip\("\/"\) \+ "\/asset"/.test(updsvc), "asset URL must strip the trailing slash (config server ends with /)"],
    [/def download\(self, url="", version=""\)/.test(updsvc) && /self\.check\(force=True\)/.test(updsvc), "download must force-refresh the cached URL (stale cache may hold a direct 404 link)"],
    [/upd_check/.test(read("locales/ru.json")) && /upd_check/.test(read("locales/en.json")) && /upd_check/.test(read("locales/de.json")) && /upd_check/.test(read("locales/zh.json")), "update strings must exist in all 4 locales"],
  ].map(([c, m]) => [c, m]));
  if (bad) process.exit(1);
}

// ---------- G11: header extras + settings updates tab + map settings ----------
{
  const shell = read("terminator_toolset/api/shell.py");
  const cfg = read("terminator_toolset/domain/config.py");
  const bad = section("HDR GATE PASSED", [
    [/id="btn-donate"/.test(html) && /id="btn-about"/.test(html) && /id="about-modal"/.test(html) && /id="about-social"/.test(html), "header must have donate + about buttons and the about modal with socials"],
    [!/id="update-modal"/.test(html) && /data-st="updates"/.test(html) && /id="upd-notes"/.test(html) && /id="upd-actions"/.test(html), "updates must live in the settings tab (inline changelog), no separate modal"],
    [/ABOUT_LINKS/.test(appjs) && /DONATE_URL/.test(appjs) && /function openAbout\(/.test(appjs), "about links/donate URL must be single-sourced in app.js"],
    [/\/api\/open_link/.test(shell) && /_OPEN_LINK_ALLOW/.test(shell), "external links must go through an allowlisted backend endpoint"],
    [/30 \* 60 \* 1000/.test(appjs) && /b\.hidden = !has/.test(appjs), "update button must stay hidden until found, with a 30-minute background recheck"],
    [/upr_sector_reward/.test(appjs) && /\.replace\("\{n\}"/.test(appjs), "sector heads must render the localized reward name"],
    [/data-i18n="upr_map_settings"/.test(html) && /\.modal-card\.upr-set-card/.test(css), "map settings modal must be renamed and fixed-size"],
    [/paintCmpSrc[\s\S]*?is-off/.test(appjs), "compare source switch must use clickable is-off like the map"],
    [/dataset\.pos/.test(appjs) && /"-1"/.test(appjs) && /data-pos="-1"/.test(css), "source switches must hide the yellow pill when the source is unavailable"],
    [/startsWith\("data:image\/"\)/.test(appjs), "tab icons must render data-URL icons as <img>, not base64 text"],
    [/"tray_enabled": True/.test(cfg) && /"browser_to_tray": True/.test(cfg), "tray options must default to on"],
    [/\.donate-btn/.test(css) && /\.social-btn/.test(css) && /\.tab-sub-path/.test(css) && /\.toast \{[^}]*120%/.test(css), "donate/social buttons, readable tab paths and +20% toasts must be styled"],
    [/CTX_ICONS/.test(appjs) && /icon: "save"/.test(appjs) && /icon: "delete"/.test(appjs) && /icon: "swap"/.test(appjs), "dynamic context menus (tabs/tree/swt/map) must carry icons"],
    [/cmpSrc: \{ left: null, right: null \}/.test(appjs), "compare sides must default to unselected"],
    [/\.cmp-side \.src-seg-sm[^}]*align-self:\s*flex-start/.test(css) && !/dz-actions-sub/.test(html) && !/dz-actions-sub/.test(css), "compare segs must not stretch"],
    [/id="upr-save"/.test(html) === false && !/upr-save/.test(appjs), "map must not duplicate the header save button"],
    [/uprCatCol\(c\.cat\)/.test(appjs) && /cat: x\.cat/.test(appjs), "map clipboard must keep the category and paste cars->cars etc"],
    [/\.tab-title \{[^}]*flex:\s*0 1 auto/.test(css), "tab title must not push origin icons to the right edge"],
    [/id="cmp-fs-min"/.test(html) === false, "compare fullscreen modal must keep a single button"],
    [/border-right-color: var\(--accent\)/.test(css) === false, "home button must not have the yellow right edge"],
    [/upr_map_settings/.test(read("locales/ru.json")) && /upr_sector_reward/.test(read("locales/en.json")) && /set_tab_updates/.test(read("locales/de.json")) && /donate/.test(read("locales/zh.json")) && /about_title/.test(read("locales/ru.json")), "batch strings must exist in all 4 locales"],
  ].map(([c, m]) => [c, m]));
  if (bad) process.exit(1);
}

// ---------- G10: CustomImages по слоям (конвертер DDS->WebP) ----------
{
  const shell = read("terminator_toolset/api/shell.py");
  const iconFileBody = uprsvc.split("def icon_file")[1].split("def webp_bucket_dir")[0];
  const bad = section("ICON CACHE GATE PASSED", [
    [/_custom_subdir_for/.test(uprsvc) && /"BaseGame"/.test(uprsvc), "converter must sort icons into layer subfolders (game=BaseGame, project/mod=folder name, one level)"],
    [/stem \+ "\.webp"/.test(uprsvc), "converted icon name must be exactly {stem}.webp (marder.dds -> marder.webp, no hash suffix)"],
    [/hexdigest\(\)\[:8\]/.test(uprsvc) === false, "converter must not append a hash to icon names"],
    [/custom_first=False/.test(uprsvc), "icon lookup must support source-only search so a stale webp never hides a fresh dds"],
    [/UnitIcons/.test(iconFileBody) === false && /inventory/.test(iconFileBody) === false, "icon_file must not check bundled program UnitIcons/inventory (no icons ship with the app)"],
    [/<path:filename>/.test(shell), "webp route must serve layer subfolders (path, not flat filename)"],
    [/difficulty\.webp/.test(appjs), "map difficulty badge must stay"],
    [/\/assets\/UprisingMap\/difficulty\.webp/.test(appjs), "difficulty badge must load from the renamed UprisingMap assets"],
    [/\/assets\/UprisingMap\/add_unit\.webp/.test(appjs) && /upr-webp\/inventory\/upgrd_base/.test(appjs) === false, "unit section add button must load from flat UprisingMap assets (no stale upr-webp inventory path)"],
    [/\/assets\/UprisingMap\/placeholder_vehicle\.webp/.test(appjs) && /\/assets\/UprisingMap\/placeholder_Squads_items\.webp/.test(appjs) && /\/assets\/UprisingMap\/wpn_placeholder\.webp/.test(appjs) && /upr-webp\/(vehicles|infantry|inventory)\//.test(appjs) === false, "chip placeholders must load from flat UprisingMap assets (renamed files, no stale bucket paths)"],
    [/placeholder_Squads_items\.webp/.test(uprsvc) && /_flat_upr_dirs/.test(uprsvc), "backend category placeholders must resolve from flat UprisingMap (renamed files first, legacy buckets as fallback)"],
    [/UprisingMap Editor/.test(uprsvc) === false && /"uprising", "shields"/.test(uprsvc) === false, "no stale UprisingMap Editor / assets\\/uprising paths in the icon service"],
  ].map(([c, m]) => [c, m]));
  if (bad) process.exit(1);
}

// ---------- G11: древо после save_as/копирования (новые разделы без переподключения) ----------
{
  const treejs = read("static/js/tree.js");
  const gridjs = read("static/js/grid.js");
  const swtjs = read("static/js/swt.js");
  const uprjs = read("static/js/uprising.js");
  const corejs = read("static/js/core.js");
  const apiuprising = read("terminator_toolset/api/uprising.py");
  const svcuprising = read("terminator_toolset/services/uprising_service.py");
  const chromejs = read("static/js/chrome.js");
  const bad = section("TREE REFRESH GATE PASSED", [
    [/async function noteExternalTreeChange\(target\)/.test(treejs) && /await loadFullTree\(\)/.test(treejs) && /state\.modTree = null/.test(treejs), "tree must offer a helper that refetches the project tree (and drops the cached mod tree) after files are created outside the scan"],
    [/noteExternalTreeChange\(target\)/.test(gridjs), "guarded file save must refresh the tree before opening the project/mod copy"],
    [/noteExternalTreeChange\(target\)/.test(swtjs), "guarded swt save must refresh the tree before reopening on the copy"],
    [/noteExternalTreeChange\(target\)/.test(uprjs), "guarded uprising save must refresh the tree before switching to the copy"],
    [/noteExternalTreeChange\("project"\)/.test(corejs) && /noteExternalTreeChange\("mod"\)/.test(corejs), "copy to project/mod must refresh the matching tree"],
    [/keepScroll/.test(treejs) && /sidebar\.scrollTop = keepScroll/.test(treejs), "renderTree must preserve the sidebar scroll position across full re-renders (clearing innerHTML clamps scrollTop to zero)"],
    [/function openShopPresets\(path\)/.test(treejs) && /\/api\/uprising_sniff/.test(treejs) && !/resistance\/i\.test\(path\)/.test(treejs), "shop_presets double-click must route by content sniff (openShopPresets), not by a resistance path test"],
    [/\/api\/uprising_sniff/.test(apiuprising) && /is_uprising_shop/.test(apiuprising), "backend must expose /api/uprising_sniff backed by is_uprising_shop"],
    [/def is_uprising_shop/.test(svcuprising) && /\^sector_\\d\+_reward/.test(svcuprising) && /sector \* 2 >= named/.test(svcuprising), "map-file detection must be content-based (sector_N_reward sysnames, majority rule), never path-based"],
    [/\^sector_\\d\+_reward/.test(uprjs), "frontend sector grouping must use the same sector_N_reward pattern as the backend detector"],
    [/def find_shop/.test(svcuprising) && /is_uprising_shop\(p\)/.test(svcuprising), "find_shop must verify candidates by content and return empty instead of the base file"],
    [/openShopPresets\(p\)/.test(chromejs) && /shop_presets/.test(chromejs), "desktop drop must route shop_presets.xml through the content sniff (openShopPresets), not straight to the grid"],
    [/uprCurrentShopFile/.test(uprjs) && /currentFile\.path/.test(uprjs), "map button with no root must pick up the open file when it is a map file (not show nofile)"],
    [/async function refreshSrcPaths/.test(chromejs) && /refreshSrcPaths[\s\S]{0,900}updateToolButtons\(\)/.test(chromejs), "settings path change must recompute tool buttons (nulled trees with lit buttons is a stale state)"],
  ].map(([c, m]) => [c, m]));
  if (bad) process.exit(1);
}

// ---------- G12: редактор ячейки не уезжает под липкую колонку sysname ----------
{
  const bad = section("CELL EDIT GATE PASSED", [
    [/function focusCellInput\(input, td\)/.test(appjs) && /focusCellInput[\s\S]{0,400}preventScroll/.test(appjs), "cell editors must focus through a helper with preventScroll (bare focus scrolls the cell under the sticky sysname column)"],
    [/ensureEditCellVisible/.test(appjs) && /thead th\.sticky-col/.test(appjs), "editor focus must nudge the scroll container clear of the sticky column width"],
    [(appjs.match(/focusCellInput\(input, td\)/g) || []).length >= 3, "all three cell editors (grid + both compare panes) must use the helper"],
    [/input\.focus\(\);\n\s*input\.select\(\);/.test(appjs) === false, "no bare input.focus()+select() may remain in cell editors"],
    [/wrap\.scrollLeft \+= \(cr\.left - \(wr\.left \+ stickyW\)\)/.test(appjs), "jump-to-cell navigation must pin the cell to the left edge (right after sticky) so its content is fully visible"],
  ].map(([c, m]) => [c, m]));
  if (bad) process.exit(1);
}

// ---------- G13: зависимости xml (правила семейств + кнопка «Анализ») ----------
{
  const linksPy = read("terminator_toolset/domain/links.py");
  const entitiesPy = read("terminator_toolset/services/entity_service.py");
  const filesPy = read("terminator_toolset/api/files.py");
  const bad = section("LINKS GATE PASSED", [
    [/car_upgrade_presets\.xml.: \["cars\.xml"\]/.test(linksPy) && /heli_upgrade_presets\.xml.: \["helicopters\.xml"\]/.test(linksPy) && /squad_upgrade_presets\.xml.: \["humans\.xml"\]/.test(linksPy) && /tank_upgrade_presets\.xml.: \["tanks\.xml"\]/.test(linksPy), "family rules must map upgrade presets to their base files (cars/helicopters/humans/tanks)"],
    [/def pick_target/.test(linksPy) && /dep_basenames/.test(linksPy), "multiple sysname hits must prefer the rule-target files (same folder/overlay next)"],
    [/def split_refs/.test(linksPy) && /_COUNT_SUFFIX/.test(linksPy), "cell values must split into ref tokens (comma lists, name:count composites) so guns/gun_mounts resolve"],
    [/defs_from_grid/.test(linksPy) && /_key_indexes/.test(linksPy), "definitions must index col 0 plus sysname-titled columns"],
    [/_file_defs/.test(entitiesPy) && /_cached_defs/.test(entitiesPy), "entity defs must cache per-file mtime so repeat passes skip unchanged files"],
    [/any\(h\["file"\] == this_path for h in hits\)/.test(linksPy), "a value defined in the open file itself must never become a link (no self-links)"],
    [/def analyze\(self, path_key/.test(entitiesPy) && /collect_incoming/.test(entitiesPy), "entity index must offer a synchronous per-file dependency analysis"],
    [/\/api\/analyze_links/.test(filesPy), "analyze endpoint must exist"],
    [/id="btn-analyze"/.test(html) && /id="deps-modal"/.test(html) && /id="deps-body"/.test(html), "open xml toolbar must have the Analyze button and the deps modal"],
    [/function analyzeCurrentFile\(\)/.test(appjs) && /\/api\/analyze_links/.test(appjs) && /renderDepsModal\(j, path\);/.test(appjs) === false, "analyze must rescore links and repaint link buttons without opening the modal"],
    [/\.deps-body/.test(css) && /\.deps-jump/.test(css), "deps modal must be styled"],
    [/retry < 200/.test(appjs), "link polling must survive slow background indexing (no silent link loss)"],
    [/analyze/.test(read("locales/ru.json")) && /analyze/.test(read("locales/en.json")) && /analyze/.test(read("locales/de.json")) && /analyze/.test(read("locales/zh.json")), "analyze strings must exist in all 4 locales"],
  ].map(([c, m]) => [c, m]));
  if (bad) process.exit(1);
}

// ---------- COMPARE UX GATE ----------
{
  const ru = read("locales/ru.json"), en = read("locales/en.json"),
    de = read("locales/de.json"), zh = read("locales/zh.json");
  const cmpSvc = read("terminator_toolset/services/compare_service.py");
  const cmpJs = read("static/js/compare.js");
  const mirrorTag = (/<input[^>]*id="cmp-mirror"[^>]*>/.exec(html) || [""])[0];
  const bad = section("COMPARE UX GATE PASSED", [
    [/#btn-settings svg \{[^}]*transition: transform \.35s ease/.test(css) && /#btn-settings:hover svg \{[^}]*rotate\(60deg\)/.test(css), "settings gear must reuse the uprising map gear animation (60deg in .35s)"],
    [/id="cmp-key-dd"[\s\S]{0,1500}id="cmp-mirror"[\s\S]{0,600}id="cmp-sync-scroll"[\s\S]{0,1500}id="cmp-run"/.test(html), "key row must come first, then mirror/sync checkboxes, then the compare button"],
    [!/checked/.test(mirrorTag), "mirror checkbox must be off by default"],
    [/localStorage\.getItem\("tsh_cmp_mirror"\) === "1"/.test(appjs), "mirror default must be off unless explicitly enabled"],
    [/async function cmpMirrorPick\(side, rel\)/.test(appjs) && /cmpFillFolderList\(other, true\)/.test(appjs) && /srcRoot\(state\.cmpSrc\[other\]\)/.test(appjs), "mirror must resolve the other side to a folder and load its list instead of staying silent"],
    [/function cmpPaintMerge\(\)/.test(appjs) && /cmp_merge_new/.test(appjs) && /cmp_merge_edited/.test(appjs) && /cmp_merge_all/.test(appjs), "merge button label must follow the active filter"],
    [/key_col: j\.key_col, mode,/.test(appjs), "merge must send its filter mode to the server"],
    [/mode: str = "all"\)/.test(cmpSvc) && /if mode in \("all", "new"\)/.test(cmpSvc) && /if mode in \("all", "edited"\)/.test(cmpSvc), "server merge must support all/new/edited modes"],
    [/cmp_merge_all/.test(ru) && /cmp_merge_new/.test(ru) && /cmp_merge_edited/.test(ru) && /cmp_merge_all/.test(en) && /cmp_merge_new/.test(en) && /cmp_merge_edited/.test(en) && /cmp_merge_all/.test(de) && /cmp_merge_new/.test(de) && /cmp_merge_edited/.test(de) && /cmp_merge_all/.test(zh) && /cmp_merge_new/.test(zh) && /cmp_merge_edited/.test(zh), "merge mode strings must exist in all 4 locales"],
    [/other\.scrollTop = pane\.scrollTop/.test(appjs) && /other\.scrollLeft = pane\.scrollLeft/.test(appjs) && /dataset\.synced/.test(appjs), "sync scroll must mirror both axes (rows and columns) with echo guard (no lag, no jump-back)"],
    [/cmp-copy-ph/.test(cmpJs) && /\.cmp-copy-ph \{[^}]*visibility: hidden/.test(css), "left rows must carry an invisible copy of the transfer arrow so both panes share row heights"],
    [/function cmpSetupPreviewEvents\(side\)/.test(cmpJs) && /tbody\.addEventListener\("mousedown"/.test(cmpJs) && /function cmpMakeCell/.test(cmpJs) === false, "preview cells must use delegated tbody events and string-built rows (no per-cell DOM/listeners) so scrolling stays smooth"],
    [/setTimeout\(\(\) => \{ other\.dataset\.synced/.test(cmpJs), "a stuck sync echo flag must expire by timer instead of swallowing the next live scroll"],
    [/cmpAppendQueued\[side\]/.test(appjs), "diff chunk appends must coalesce to one per frame"],
    [/cmpAppendQueued\[side\] = true;[\s\S]{0,200}requestAnimationFrame/.test(appjs) && /pane\.dataset\.cmpPrevQueued/.test(cmpJs), "pane bottom checks must run inside rAF (no scrollHeight reflow per wheel tick)"],
    [/function cmpNoteScrolling\(\)/.test(cmpJs) && /if \(cmpScrolling\) return/.test(cmpJs) && /pane\.dataset\.cmpHlScroll/.test(cmpJs), "pair hover must pause while scrolling and stay wired once per pane"],
    [/function cmpSetupPairHL\(\)/.test(cmpJs) && /add\("row-pair"\)/.test(cmpJs), "hovering a row must highlight its pair on the other pane"],
    [/tbody\.addEventListener\("click"/.test(cmpJs) && /add\("row-pin"\)/.test(cmpJs) && /remove\("row-pin"\)/.test(cmpJs) && /\.cmp-grid tbody tr\.row-pin td/.test(css) && css.indexOf("tr.row-pin") > css.indexOf("tr.row-pair"), "click must pin the whole row pair stronger than hover (row-pin after row-pair), toggle off on second click"],
    [((cmpJs.match(/add\("cell-focus"\)/g) || []).length === 1 && (cmpJs.match(/add\("sel"\)/g) || []).length === 1), "click must not select an element: only the find-jump path may mark a cell"],
    [/new Intl\.Collator\(undefined, \{ numeric: true, sensitivity: "base" \}\)/.test(appjs), "compare sorting must reuse one collator"],
    [/\.cmp-grid tbody tr \{[^}]*content-visibility: auto/.test(css) && /\.grid tbody tr \{[^}]*content-visibility: auto/.test(css), "compare and main grids must skip off-screen rows"],
    [/\.cmp-grid \{[^}]*table-layout: fixed/.test(css) && /\.cmp-grid th\.td-st, \.cmp-grid td\.td-st/.test(css), "compare grids must use fixed layout like the main grid (no reflow while both panes move)"],
    [/cmpMovedFor/.test(appjs) && /row-moved-new/.test(cmpJs) && /row-moved-changed/.test(cmpJs) && /\.cmp-grid tbody tr\.row-moved-new td/.test(css) && /row-moved-changed td[^}]*rgba\(232,184,75,\.68\)/.test(css), "transferred rows must glow bright (new green, changed yellow) until the compared pair changes"],
    [/function cmpReconcileMoved\(\)/.test(cmpJs) && /cmpReconcileMoved\(\);\s*cmpSetupPairHL\(\);/.test(cmpJs) && /cmpMovedUndone/.test(appjs), "undoing a transfer must park its glow, redo must return it (reconciled on every diff render)"],
    [/\/api\/reset_beginning/.test(appjs) && /def restore_to_beginning/.test(read("terminator_toolset/services/files_service.py")) && /reset_beginning/.test(read("terminator_toolset/api/files.py")), "reset-to-beginning must undo every record down to the clean file (restore of the oldest record keeps the first edit)"],
    [/\.cmp-filter \{[^}]*border-radius: 0/.test(css) && /\.cmp-filter \{[^}]*font-size: 12\.5px/.test(css), "compare filters must be bigger, square and minimal"],
    [/\.upr-card:hover \{[^}]*outline: 1px dashed/.test(css), "unit icon hover must keep the dashed outline"],
    [/\.modal-card\.upr-set-card \{[^}]*min\(900px/.test(css), "sector settings modal must fit 5 sectors across"],
  ].map(([c, m]) => [c, m]));
  if (bad) process.exit(1);
}

// ---------- RND V2 GATE: режимы рандомайзера + редактор ----------
{
  const ru = read("locales/ru.json"), en = read("locales/en.json"),
    de = read("locales/de.json"), zh = read("locales/zh.json");
  const apiupr = read("terminator_toolset/api/uprising.py");
  const embed = read("../compiler/embed_assets.py");
  let rndFiles = [];
  try { rndFiles = readdirSync(join(root, "UprisingRandomizer")); } catch (e) { rndFiles = []; }
  const bad = section("RND V2 GATE PASSED", [
    [/upr-cfg-editor\.js/.test(html), "script loader in index.html must include upr-cfg-editor.js after upr-random.js"],
    [/id="upr-cfg-editor-modal"/.test(html) === false, "config editor modal must be gone (editor lives as a randomizer tab)"],
    [/upr-rnd-editor-body/.test(appjs) && /upr-rnd-editor-foot/.test(appjs) && /upr-rnd-editor-tabs/.test(appjs) && /upr-rnd-editor-title/.test(appjs), "randomizer page must build the editor tab containers (title/tabs/body/foot)"],
    [/window\.uprCfgEdEnsure = edEnsure/.test(appjs) && /uprRndOpenTab\("editor"/.test(appjs), "editor entry points must route to the editor tab with lazy mode load"],
    [/function edDragStart\(/.test(appjs) && /function edMoveUnit\(/.test(appjs) && /function edDragAbort\(/.test(appjs), "editor chips must drag via pointer engine (map-style), not HTML5 DnD"],
    [/ondragstart/.test(appjs) === false && /text\/ed-unit/.test(appjs) === false, "no HTML5 drag leftovers in the editor (WebView2-unreliable dataTransfer MIME)"],
    [/upr_rnd_edit_mode/.test(appjs) === false, "duplicate edit-mode buttons must be gone (editor is a tab now)"],
    [/edBody\.isConnected/.test(appjs) && /_edLoadSeq/.test(appjs), "editor load must wait for append (isConnected) and answer only the latest fetch"],
    [/function edExpandSec\(/.test(appjs) && /function edDragAutoscroll\(/.test(appjs), "editor drag must hover-expand sectors and autoscroll"],
    [/\.upr-cfg-ed-drop\.drop-hint/.test(css) === false, "yellow drop highlight must be gone"],
    [/\(cat \|\| "squads"\) !== \(u\.cat/.test(appjs), "editor drag must keep the unit type (no cross-category moves)"],
    [/upr_cfg_ed_pool/.test(ru) && /upr_cfg_ed_pool/.test(en) && /upr_cfg_ed_pool/.test(de) && /upr_cfg_ed_pool/.test(zh), "pool strings must exist in all 4 locales"],
    [/beforeUid/.test(appjs) === false, "unit reorder via drag must be gone (append-only moves)"],
    [/upr_cfg_ed_unknown/.test(appjs) && /upr_cfg_ed_unknown/.test(ru) && /upr_cfg_ed_unknown/.test(en) && /upr_cfg_ed_unknown/.test(de) && /upr_cfg_ed_unknown/.test(zh), "missing-from-project warning must exist in code and all 4 locales"],
    [/upr_rnd_tab_editor/.test(ru) && /upr_rnd_tab_editor/.test(en) && /upr_rnd_tab_editor/.test(de) && /upr_rnd_tab_editor/.test(zh), "editor tab string must exist in all 4 locales"],
    [/data-st="rnd"/.test(html) && /data-st="expert"/.test(html) && /id="upr-rnd-box"/.test(html) && /id="upr-expert-box"/.test(html), "map settings must have 4 tabs (sectors/rnd/expert/presets) with rnd + expert pages"],
    [/function uprCfgEditOpen\(/.test(appjs) && /uprising_rnd_mode_save/.test(appjs) && /uprising_rnd_mode_delete/.test(appjs) && /uprising_rnd_convert_v1/.test(appjs), "config editor must open, save, delete and convert v1 via backend routes"],
    [/function uprRndModeApply\(/.test(appjs) && /uprRndPaintModes/.test(appjs) && /uprRndOpenTab/.test(appjs), "randomizer must apply modes, paint mode cards and open on a chosen tab"],
    [/uprRndModeTitle/.test(appjs) && /protectStarts/.test(appjs) && /lootBlocked/.test(appjs), "randomizer must title modes from locales, protect starts/capitals and filter rare loot"],
    [/uprRndBoxFill/.test(appjs) && /uprExpertBoxFill/.test(appjs), "map settings must fill the rnd + expert tabs"],
    [/uprising_rnd_modes/.test(apiupr) && /uprising_rnd_mode_get/.test(apiupr) && /uprising_rnd_mode_save/.test(apiupr) && /uprising_rnd_mode_delete/.test(apiupr) && /uprising_rnd_mode_duplicate/.test(apiupr) && /uprising_rnd_convert_v1/.test(apiupr), "backend must expose all 6 rnd mode routes"],
    [/def rnd_parse_v2/.test(uprsvc) && /def rnd_serialize_v2/.test(uprsvc) && /def rnd_mode_save/.test(uprsvc) && /def rnd_convert_v1/.test(uprsvc) && /_RND_DEFAULTS/.test(uprsvc), "backend must parse/serialize v2 with per-mode defaults"],
    [/UprisingRandomizer/.test(embed) && /_collect\(rnd_dir\)/.test(embed), "embed_assets must pack UprisingRandomizer into the exe bundle"],
    [["easy.cfg", "balanced.cfg", "hard.cfg", "chaos.cfg"].every(f => rndFiles.includes(f)), "UprisingRandomizer must carry easy/balanced/hard/chaos.cfg v2"],
    [/\[MODE\]/.test(read("UprisingRandomizer/easy.cfg")) && /\[SECTORS\]/.test(read("UprisingRandomizer/easy.cfg")) && /\[UNITS\]/.test(read("UprisingRandomizer/easy.cfg")) && /\[LOOT\]/.test(read("UprisingRandomizer/easy.cfg")), "mode files must be v2 (MODE/SECTORS/UNITS/LOOT sections)"],
    [/upr_rnd_mode_easy/.test(ru) && /upr_rnd_mode_balanced_d/.test(ru) && /upr_cfg_ed_save_new/.test(ru) && /upr_set_rnd/.test(ru) && /upr_set_expert/.test(ru), "rnd v2 strings must exist in ru"],
    [/upr_rnd_mode_easy/.test(en) && /upr_cfg_ed_save_new/.test(en) && /upr_set_rnd/.test(en) && /upr_set_expert/.test(en), "rnd v2 strings must exist in en"],
    [/upr_rnd_mode_easy/.test(de) && /upr_cfg_ed_save_new/.test(de) && /upr_set_rnd/.test(de) && /upr_set_expert/.test(de), "rnd v2 strings must exist in de"],
    [/upr_rnd_mode_easy/.test(zh) && /upr_cfg_ed_save_new/.test(zh) && /upr_set_rnd/.test(zh) && /upr_set_expert/.test(zh), "rnd v2 strings must exist in zh"],
    [/\.upr-rnd-mode\.active/.test(css) && /\.upr-cfg-ed-body/.test(css) && /input\.upr-unknown/.test(css), "mode cards, editor body and unknown highlight must be styled"],
  ].map(([c, m]) => [c, m]));
  if (bad) process.exit(1);
}
