// Unlazy oracle: static wiring checks for the client bundle.
// Prints one success marker per gate section, only after all its assertions pass.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(root, p), "utf8");
const appjs = read("static/js/app.js");
const uprsvc = read("terminator_toolset/services/uprising_service.py");
const css = read("static/css/style.css");
const html = read("templates/index.html");

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
    [/cmpSyncUndoButtons\(\);/.test(appjs) && /state\.cmpLastSide = "left";/.test(appjs), "compare mutations must re-sync undo/redo buttons"],
    [/function uprPaintNofile\(/.test(appjs) && /id="upr-nofile-actions"/.test(html), "map empty state must offer a quick action"],
    [/function histInProject\(/.test(appjs) && /stockTargets/.test(appjs), "stock rollback must only target in-project files"],
    [/loadOne\(0\)/.test(html) && /<script src="\/static\/js\/app\.js/.test(html) === false, "boot scripts must load via the retrying loader, not sync tags"],
    [/readyState === "loading"/.test(appjs), "init must start exactly once for both sync and dynamic script loading"],
    [/\/api\/boot_progress/.test(py) && /boot_ping/.test(py), "backend must serve the boot progress channel"],
    [/id="fill"/.test(splash) && /id="pct"/.test(splash) && /fetch\("\/api\/boot_progress"/.test(splash), "splash must poll the real boot progress 0-100"],
    [/function bootPing\(/.test(appjs) && /function bgTreeDone\(/.test(appjs), "frontend must report boot stages and warm heavy trees in background"],
    // карта: гонка параллельных загрузок (дабл-клик, смена источника mid-flight)
    [/loadSeq/.test(appjs) && /state\.uprising\.loading/.test(appjs), "map load must carry a generation token + in-flight guard"],
    [/my !== state\.uprising\.loadSeq/.test(appjs), "stale map responses must be dropped by the generation guard"],
    [/const root = uprSrcRoot\(\);[\s\S]{0,400}?fresh\(\)/.test(appjs) || /root === uprSrcRoot\(\)/.test(appjs), "icon bundle must be pinned to the source root it was requested for"],
    [/dataset\.uprRetry/.test(appjs) && /uprIconUrl\(it\.name(,|\))/.test(appjs), "map chips must retry a broken icon once (torn HTTP/1.0 connection)"],
    [/\/assets\/map\/map\.webp\?v=" \+ Date\.now\(\)/.test(appjs) && /img\.dataset\.uprRetry/.test(appjs), "map texture must reload once on a broken first fetch"],
    [/return \("", 503\)/.test(py), "icon endpoint must answer 503 on a transient serve failure, not the silent placeholder"],
    [/function uprFreshState\(\)[\s\S]{0,500}?loadSeq: 0/.test(appjs) && /uprising: uprFreshState\(\)/.test(appjs), "map state must reset via the single default carrying loadSeq (reopen after close must load)"],
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
    // подписи снизу трёх вкладок
    [/data-i18n="up_foot"/.test(html), "unpacker tab must have its footer caption"],
    [/data-i18n="cm_foot"/.test(html), "create-mod tab must have its footer caption"],
    [/data-i18n="cmp_foot"/.test(html), "compare tab must have its footer caption"],
    // главная: кнопки (кроме Файл/Папка) над дропзоной, «Недавние» ниже по центру
    [/class="dz-actions-top"/.test(html), "welcome must have the top actions strip"],
    [/class="dz-actions-top"[\s\S]*?id="landing-create-mod"/.test(html), "create-mod button must live in the top strip"],
    [/class="dz-actions-sub"[\s\S]{0,200}?id="landing-records-btn"/.test(html), "recents button must live in its own centered row below the strip"],
    [/id="dropzone"[\s\S]{0,900}?id="landing-open-file"/.test(html), "file button must stay inside the dropzone"],
    [/class="dz-actions-top"[\s\S]*?id="dropzone"/.test(html), "top strip must precede the dropzone"],
    // настройки: фикс. размер + zoom, чекбокс браузер->трей, инлайн-пикер пути
    [/zoom:\s*1\.2/.test(setCard), "settings modal must scale ~+20% (zoom)"],
    [/height:\s*min\(/.test(setCard), "settings modal must have a fixed height for all tabs"],
    [/id="set-browser-to-tray"/.test(html), "settings must declare the browser-to-tray checkbox"],
    [/browser_to_tray:\s*\$\("#set-browser-to-tray"\)\.checked/.test(appjs), "saveSettings must persist browser_to_tray"],
    [/browser_to_tray && window\.pywebview[\s\S]{0,120}minimize_to_tray/.test(appjs), "open-browser must minimize to tray when enabled"],
    [/set-path-row/.test(html) && /id="set-unpacked-pick"/.test(html), "paths tab must have the inline folder pick button"],
    [/set-path-row \{ display:\s*flex/.test(css), "style.css must style the inline path row"],
    // сравнение: шапка убрана, fs-кнопки; попапы поиска — из общего ядра
    [/data-i18n="cmp_title"/.test(html) === false, "compare h2 header must be removed"],
    [/id="cmp-fs-search"/.test(html) === false, "fullscreen modal must NOT have a built-in search input"],
    [/function mkFindBar\(/.test(appjs), "shared find popup core (mkFindBar) must exist"],
    [/fileFind = mkFindBar\(/.test(appjs), "file tabs must use the shared find core"],
    [/cmpFindBar\[side\] = mkFindBar\(/.test(appjs), "compare must build per-side popups from the shared core"],
    [/swtFind = mkFindBar\(/.test(appjs), "SWT editor must use the shared find core"],
    [/cmpFindOpen\(side\)/.test(appjs), "Ctrl+F must open the side find popup"],
    [/cmpReplaceAll/.test(appjs) && /cmpSetCell\(side, m\.ri, m\.ci, newVal\)/.test(appjs), "replace-all must edit cells via cmpSetCell"],
    [/id="cmp-fs-min"/.test(html), "compare fullscreen modal must have the minimize button"],
    [/minBtn\.onclick = cmpFsMinimize/.test(appjs) && /pywebview\.api\.minimize\(\)/.test(appjs), "fs minimize must minimize the program window"],
    [/paneFsWinFs\(true\)/.test(appjs), "compare fullscreen must toggle real window fullscreen (shared paneFsWinFs)"],
    [/.key-dd-pop\[hidden\]\s*\{\s*display:\s*none/.test(css), "key dropdown search must hide with the popup ([hidden] rule)"],
    [/\.sb-tab \{[^}]*flex:\s*1 1 0/.test(css), "sidebar tabs must split tree width in half"],
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
    [/swt: swtFreshState\(\)/.test(appjs), "initial SWT state must come from the single default (undo stacks exist before open)"],
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
    [/id="upr-rnd-modal"/.test(html) && /upr-random\.js/.test(html), "page must include the randomizer modal and script"],
    [/modal-card wide upr-rnd-card/.test(html), "randomizer modal must be wide and centered"],
    [/typeof uprRndOverlay === "function"/.test(appjs), "map must call the overlay hook with a fallback when the script is missing"],
    [/upr-map-actions/.test(css) && /\.upr-rnd-card/.test(css), "map overlay buttons and modal layout must be styled"],
    [/window\.uprRndOverlay = function/.test(rnd), "overlay buttons must be built in upr-random.js"],
    [/function uprBulkDiff\(/.test(appjs), "multi-selection must set difficulty in bulk"],
    [/function uprRndCalc\(/.test(rnd) && /function uprRndApply\(\)/.test(rnd) && /function uprRndUndo\(\)/.test(rnd), "randomizer must calculate, apply and undo"],
    [/uprRndRng/.test(rnd) && /seed/.test(rnd), "randomization must be seeded and repeatable"],
    [/uprRndIsExcluded/.test(rnd) && !/if \(num === 1\) return/.test(rnd), "sector exclusions must be user-controlled (no hardcoded base lock)"],
    [/uprRndByCost/.test(rnd), "randomizer must suggest difficulty by unit cost"],
    [/upr_rnd_title/.test(read("locales/ru.json")) && /upr_rnd_title/.test(read("locales/en.json")) && /upr_rnd_title/.test(read("locales/de.json")) && /upr_rnd_title/.test(read("locales/zh.json")), "randomizer strings must exist in all 4 locales"],
  ].map(([c, m]) => [c, m]));
  if (bad) process.exit(1);
}
