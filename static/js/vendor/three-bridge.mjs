/* Мост three.js r185 в классические скрипты (model3d/campaign3d/preview3d).
   Новый three — только ES-модули, а загрузчик index.html инжектит
   классику текстом (модули так не запустить). Поэтому один маленький
   модуль: импортит движок + аддоны, кладёт на window.THREE
   (с полями OrbitControls/DDSLoader, как раньше) и пинает событием.
   Классика ждёт готовности через m3dLibs/cmp3dLibs (событие + опрос),
   тегов <script src> вендора больше нет. Офлайн: всё завендорено. */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DDSLoader } from "three/addons/loaders/DDSLoader.js";

THREE.OrbitControls = OrbitControls;
THREE.DDSLoader = DDSLoader;
window.THREE = THREE;
try {
  window.dispatchEvent(new Event("tsh:three"));
} catch (e) {}
