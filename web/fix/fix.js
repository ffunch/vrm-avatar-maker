// "Fix my VRM" page: measure a VRM against So Many Rooms' budget, fix it (lib/vrm-fix.js), show the
// result seated in three-vrm (lib/preview.js) and offer the download.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { BUDGET, readGlb, measure, fixVRM } from "../lib/vrm-fix.js";
import { createPreview } from "../lib/preview.js";

const $ = (id) => document.getElementById(id);
const view = $("view");
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(devicePixelRatio);
view.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x26282b);
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.0));
const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(1, 3, 2); scene.add(sun);
scene.add(new THREE.GridHelper(4, 8, 0x555555, 0x3a3a3a));
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
camera.position.set(0.9, 1.2, 3.0);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.75, 0); controls.update();
new ResizeObserver(() => { const { clientWidth: w, clientHeight: h } = view; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }).observe(view);
const preview = createPreview({ scene, camera });
let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now(); preview.update(Math.min((now - last) / 1000, 0.05)); last = now;
  controls.update(); renderer.render(scene, camera);
});

const LABELS = { triangles: "Triangles", materials: "Materials", texture: "Largest texture (px)", bytes: "File size", bones: "Bones" };
const show = (k, v) => k === "bytes" ? `${(v / 1048576).toFixed(1)} MB` : Number.isFinite(v) ? v.toLocaleString() : "?";
function table(before, after) {
  $("after-head").hidden = !after;
  $("rows").replaceChildren(...Object.keys(LABELS).map((k) => {
    const tr = document.createElement("tr");
    const cell = (facts) => `<td class="num ${facts[k] > BUDGET[k] ? "bad" : "ok"}">${show(k, facts[k])}</td>`;
    tr.innerHTML = `<td>${LABELS[k]}</td><td class="num">${show(k, BUDGET[k])}</td>${cell(before)}${after ? cell(after) : ""}`;
    return tr;
  }));
}

let input = null, name = "avatar", fixed = null;
async function open(file) {
  name = file.name.replace(/\.(vrm|glb)$/i, "");
  input = await file.arrayBuffer(); fixed = null;
  $("report").hidden = false; $("steps").replaceChildren(); $("download").hidden = true; $("message").textContent = "";
  try {
    const facts = measure(readGlb(input), input.byteLength);
    const m = facts.meta;
    $("meta").textContent = `${m.name ?? file.name}${m.authors ? " by " + m.authors : ""} · VRM ${facts.version ?? "?"}`;
    table(facts);
    if (!facts.humanoid) { $("message").innerHTML = '<span class="bad">This file has no VRM humanoid, so it can\'t be used as an avatar.</span>'; $("fix").hidden = true; }
    else if (!m.canModify) { $("message").innerHTML = `<span class="bad">${m.text}</span> Ask the author for a lighter version.`; $("fix").hidden = true; }
    else if (!facts.over.length) { $("message").innerHTML = '<span class="ok">It already fits: you can upload it as it is.</span>'; $("fix").hidden = true; }
    else { $("message").textContent = "Over the limit: " + facts.over.map((k) => LABELS[k].toLowerCase()).join(", ") + "."; $("fix").hidden = false; }
    $("hint").textContent = "Loading…";
    await preview.show(input.slice(0), { seated: true });
    $("hint").textContent = "";
  } catch (err) {
    $("message").innerHTML = `<span class="bad">${err.message}</span>`; $("fix").hidden = true; $("hint").textContent = "";
  }
}

$("fix").addEventListener("click", async () => {
  $("fix").disabled = true; $("fix").textContent = "Working…"; $("steps").replaceChildren();
  try {
    const result = await fixVRM(input.slice(0), { onStep: (s) => { const li = document.createElement("li"); li.textContent = s; $("steps").append(li); } });
    table(result.before, result.after);
    if (result.buffer && !result.after.over.length) {
      fixed = result.buffer;
      $("message").innerHTML = '<span class="ok">The copy fits. Check it here, then download it and upload it in So Many Rooms.</span>';
      $("download").hidden = false; $("fix").hidden = true;
      await preview.show(fixed.slice(0), { seated: true });
    } else {
      $("message").innerHTML = `<span class="bad">Still over: ${result.after.over.map((k) => LABELS[k].toLowerCase()).join(", ")}.</span> This avatar needs more work than this page can do.`;
    }
  } catch (err) {
    $("message").innerHTML = `<span class="bad">${err.message}</span>`;
  } finally { $("fix").disabled = false; $("fix").textContent = "Make a copy that fits"; }
});
$("download").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([fixed], { type: "model/gltf-binary" }));
  Object.assign(document.createElement("a"), { href: url, download: `${name}-fixed.vrm` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

const drop = $("drop");
drop.addEventListener("click", () => $("file").click());
$("file").addEventListener("change", (e) => { if (e.target.files[0]) open(e.target.files[0]); e.target.value = ""; });
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files[0]) open(e.dataTransfer.files[0]); });
window.vrmFix = { open: (buffer, n = "test") => open(new File([buffer], n + ".vrm")), get fixed() { return fixed; } };  // for tests
