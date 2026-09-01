// Unlazy oracle: static wiring checks for the client bundle.
// Prints one success marker per gate section, only after all its assertions pass.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(root, p), "utf8");
const appjs = read("static/js/app.js");
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
  const i = appjs.indexOf('const isUndoRedo = ctrl && (c === "KeyZ" || c === "KeyY")');
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
