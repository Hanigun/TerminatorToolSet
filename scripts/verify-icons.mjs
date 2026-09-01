// Unlazy oracle: icon references must resolve to real files in the new set.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(root, p), "utf8");
const appjs = read("static/js/app.js");
const css = read("static/css/style.css");
const html = read("templates/index.html");

const THEME = "dark";
const iconDir = join(root, "assets", "icons", THEME, "icons");
let bad = 0;
const fail = (m) => { console.error("FAIL: " + m); bad++; };

// app.js must serve icons from the themed subfolder
if (!appjs.includes("/assets/icons/" + THEME + "/icons/")) {
  fail("app.js must reference the themed icon base path /assets/icons/" + THEME + "/icons/");
}

// every icon file referenced from app.js must exist on disk
const refs = new Set();
for (const m of appjs.matchAll(/[\w./-]*assets\/icons[\w./-]*\.svg/g)) refs.add(m[0]);
for (const m of appjs.matchAll(/([a-z0-9_]+(?:__open)?\.svg)/gi)) refs.add(m[1]);
for (const ref of refs) {
  const name = ref.split("/").pop();
  if (!existsSync(join(iconDir, name))) fail("missing icon file: " + name);
}
if (!refs.size) fail("no icon references found in app.js");

// every category key used by the tree must have a mapping entry
const CAT_KEYS = ["humans", "squads", "squad_upgrades", "cars", "car_upgrades", "tanks",
  "tank_upgrades", "helicopters", "heli_upgrades", "guns", "ammunition", "modules",
  "animations", "exp", "reinforcements", "spawns_sheet", "misc"];
for (const k of CAT_KEYS) {
  if (!appjs.includes('"' + k + '":')) fail("category icon mapping is missing key: " + k);
}

// deleted flat icons must not be referenced anywhere
const banned = ["tdfd.png", "uprising.png", "hex.svg"];
for (const src of [appjs, css, html]) {
  for (const b of banned) {
    if (src.includes(b)) fail("reference to removed icon '" + b + "' must be deleted");
  }
}
// the app logo (still shipped at assets/icons root) must keep working
if (!existsSync(join(root, "assets", "icons", "app_icon.png"))) fail("app_icon.png missing");

if (bad) { console.error("ICONS CHECK FAILED: " + bad); process.exit(1); }
console.log("ICONS GATE PASSED");
