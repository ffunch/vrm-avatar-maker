// VRM Avatar Maker (2026-11-08). Builds a VRM 1.0 meeting avatar in the browser from CC0 MakeHuman parts:
// body and face-shape sliders, skin tone (or a fantasy skin color), eye color, hair (style and color),
// moustache, beard, glasses and visors, eyebrows, clothes and makeup. The recipe is stored in the VRM,
// so "Open VRM" brings it back.
// Assets: pipeline/make_parts.sh + pipeline/export_web_assets.py write web/assets/.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { fetchRetry, loadBase, morphBody, loadItem, fitItem, visibleBodyIndices, ageYears, skinBucket, skinGender } from "../lib/avatar-core.js";
import { fitRig, tPose, skinPositions, smoothNormals, encodeImage, writeVRM } from "../lib/vrm-export.js";
import { addHairSprings, springBoneExtension } from "../lib/springs.js";
import { skirtSkin } from "../lib/cloth.js";
import { loadLandmarker, loadHairSegmenter, findHair, facePoints, alignFlat, solveBounded, sampleColors, toLinear, toSRGB, luminance, lightness } from "../lib/photo-fit.js";

const A = "../assets/";
const MAX_TRIANGLES = 40000;  // So Many Rooms' AVATAR_BUDGET
const HAIR_COLORS = { Black: "#1d1a18", "Dark brown": "#3a281d", Brown: "#5e4029", Auburn: "#6f3420", Red: "#9a4524",
  "Dark blonde": "#8c6c45", Blonde: "#c4a36d", "Light blonde": "#ddc797", Grey: "#8e8a86", White: "#e6e3de" };
const FANTASY_HAIR = { Blue: "#2f5fd0", Teal: "#1f9a94", Green: "#3f9a3a", Purple: "#7a3fb8", Pink: "#e05a9a", Silver: "#c8ccd4" };
const SKIN_COLORS = { Green: "#5fa85a", Teal: "#3fa3a0", Blue: "#5a7fd0", Purple: "#9a6ad0", Grey: "#9a9aa2", Gold: "#d0a640", Red: "#c8584a" };
const CLOTHES = ["outfit", "top", "bottom", "shoes"];
const ITEM_SLOTS = ["hair", "eyebrows", "moustache", "beard", "glasses", "hat", ...CLOTHES];
const ALWAYS = ["eyes", "eyelashes01", "teeth_front", "tongue01"];
// Clothes sit this far off the body (decimeters) so skin and lower layers don't show through; a top
// sits outside trousers.
const INFLATE = { top: 0.05, outfit: 0.03, bottom: 0.02 };

// "AvatarEditor" is the recipe format's id (the project's old name), kept so VRMs made earlier still reopen.
const DEFAULT_RECIPE = {
  version: 1, editor: "AvatarEditor", name: "",
  body: { gender: 1, age: 0.5, muscle: 0.5, weight: 0.5, race: { african: 0.15, asian: 0.15, caucasian: 0.7 } },
  skin: { tone: 0.1, color: null }, eyes: "brown", face: {},
  hair: { style: "short02", color: "#3a281d" }, eyebrows: "eyebrow001", eyebrowHeight: 0.8,
  moustache: null, beard: null, glasses: null, hat: null,
  outfit: "male_casualsuit04", top: null, bottom: null, shoes: "shoes02",
  makeup: { eyeshadow: { amount: 0, color: "#7a5a8c" }, lips: { amount: 0, color: "#a8323e" }, nails: { amount: 0, color: "#b0283a" } },
};
let recipe = structuredClone(DEFAULT_RECIPE);

// ---- Scene -----------------------------------------------------------------------------------
const viewEl = document.getElementById("view");
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(devicePixelRatio);
viewEl.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x26282b);
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.0));
const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(1, 3, 2); scene.add(sun);
const fill = new THREE.DirectionalLight(0xffffff, 0.6); fill.position.set(-2, 1, 1); scene.add(fill);
scene.add(new THREE.GridHelper(4, 8, 0x555555, 0x3a3a3a));
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
const controls = new OrbitControls(camera, renderer.domElement);
let faceHeight = 1.6;  // meters above the floor, updated on refit
let lastCamera = "body";
let preview = null, previewing = false, previewSeated = true, previewJob = 0;  // live preview (see below)
let selectedMotion = null, motionBusy = false;
const motionButtons = [...document.querySelectorAll("#motion-controls button")];
function syncMotionButtons() {
  for (const button of motionButtons) {
    button.setAttribute("aria-pressed", String((selectedMotion ?? "stand") === button.dataset.motion));
    button.disabled = motionBusy;
  }
}
function syncPoseButtons() {
  document.querySelectorAll("#poses button").forEach((button) => button.classList.toggle("on", button.dataset.pose === (previewSeated ? "seated" : "standing")));
}
function setCamera(which) {
  lastCamera = which;
  const head = previewing ? preview.head() : null;  // the preview may be seated: aim at its real head
  const fh = head ? head.y + 0.06 : faceHeight, fz = head ? head.z : 0;
  const k = matchMedia("(max-width: 700px), (max-height: 500px) and (orientation: landscape)").matches ? 1.35 : 1.2;
  const [pos, target] = which === "face" ? [[0.25, fh + 0.04, fz + 0.95], [0, fh, fz]] : [[0.9 * k, 1.25, 3.4 * k], [0, 0.95, 0]];
  camera.position.set(...pos); controls.target.set(...target); controls.update();
}
function resize() {
  const { clientWidth: w, clientHeight: h } = viewEl;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewEl);
setCamera("body");
const avatar = new THREE.Group();
scene.add(avatar);

// ---- Load ------------------------------------------------------------------------------------
const base = await loadBase(A);
avatar.scale.setScalar(1 / base.unitsPerMeter);
const index = base.index;
const N = base.N;
const current = new Float32Array(N * 3);

const bitmapCache = new Map();
const bitmap = (url) => {
  if (!bitmapCache.has(url)) {
    const job = fetchRetry(url).then((r) => r.blob()).then((b) => createImageBitmap(b));
    job.catch(() => bitmapCache.delete(url));  // don't cache a failure
    bitmapCache.set(url, job);
  }
  return bitmapCache.get(url);
};


// Body mesh, with face shapes as morph targets (display units are decimeters).
const bodyGeom = new THREE.BufferGeometry();
const bodySource = base.body.source;
bodyGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(bodySource.length * 3), 3));
bodyGeom.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(bodySource.length * 3), 3));
bodyGeom.setAttribute("uv", new THREE.BufferAttribute(base.body.uv, 2));
bodyGeom.setIndex(new THREE.BufferAttribute(base.body.indices, 1));
addMorphs(bodyGeom, bodySource, base.faceShapes);
const skinCanvas = document.createElement("canvas");
skinCanvas.width = skinCanvas.height = 1024;  // the view; the download composes its own at 2048 (paintSkin)
const skinTexture = new THREE.CanvasTexture(skinCanvas);
skinTexture.colorSpace = THREE.SRGBColorSpace;
const bodyMesh = new THREE.Mesh(bodyGeom, new THREE.MeshStandardMaterial({ roughness: 0.7, map: skinTexture }));
bodyMesh.updateMorphTargets();
avatar.add(bodyMesh);

function addMorphs(geometry, source, shapes) {
  const list = [];
  for (const [name, deltas] of Object.entries(shapes)) {
    const out = new Float32Array(source.length * 3);
    let moved = false;
    for (let r = 0; r < source.length; r++) for (let k = 0; k < 3; k++) {
      const d = deltas[source[r] * 3 + k] * base.unitsPerMeter;
      out[r * 3 + k] = d; if (d) moved = true;
    }
    if (!moved) continue;
    const attr = new THREE.BufferAttribute(out, 3); attr.name = name; list.push(attr);
  }
  if (!list.length) return;  // an empty morph list breaks three.js' shader
  geometry.morphAttributes.position = list;
  geometry.morphTargetsRelative = true;
}

// ---- Worn items ------------------------------------------------------------------------------
// Alpha cut-off: brows and lashes are thin strokes that break up at 0.5.
const TONGUE_TINT = 0x7a5a5a;  // the inside of a mouth is in shadow; a bright tongue reads as a marshmallow
const cutoff = (slot) => (slot === "eyebrows" || slot === "eyelashes01" ? 0.3 : 0.5);
const worn = new Map();  // slot -> { item, mesh, canvas?, original? }

async function makeWorn(id, slot) {
  const item = await loadItem(base, id);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(item.source.length * 3), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(item.uv, 2));
  g.setIndex(new THREE.BufferAttribute(item.indices, 1));
  addMorphs(g, item.source, item.faceShapes);
  const inMouth = slot === "teeth_front" || slot === "tongue01";  // single-sided: no inside-out view
  const material = new THREE.MeshStandardMaterial({ roughness: inMouth ? 0.5 : 0.8, side: inMouth ? THREE.FrontSide : THREE.DoubleSide,
    color: 0xf2efe8, alphaTest: item.info.cutout ? cutoff(slot) : 0 });
  const entry = { item, mesh: new THREE.Mesh(g, material), fitted: new Float32Array(item.info.vertexCount * 3) };
  entry.mesh.updateMorphTargets();
  const textureFile = slot === "eyes" ? index.eyeColors[recipe.eyes] : item.info.texture;
  if (textureFile) await setItemTexture(entry, textureFile, slot);
  return entry;
}

// The 3D view uses textures/view/ (at most 1024 px, a third of the bytes); the download reads the full
// texture from entry.url (exportVRM), fetched only then.
async function setItemTexture(entry, file, slot) {
  const url = A + "textures/" + file;
  const img = await bitmap(A + "textures/view/" + file);
  const size = Math.min(1024, img.width);
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = Math.round(img.height * size / img.width);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  entry.canvas = canvas; entry.url = url;
  entry.original = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  entry.mesh.material.map?.dispose();
  entry.mesh.material.map = texture; entry.mesh.material.color.set(slot === "tongue01" ? TONGUE_TINT : 0xffffff);
  entry.mesh.material.needsUpdate = true;
  recolor(entry, slot);
}

// Hair color: keep the texture's light and shade, replace its color. Brows and facial hair follow.
const HAIR_SLOTS = { hair: 1, eyebrows: 0.8, moustache: 0.9, beard: 0.9 };
function recolor(entry, slot) {
  if (!(slot in HAIR_SLOTS) || !entry.original) return;
  const ctx = entry.canvas.getContext("2d");
  // "As made" hair: brows and facial hair take the hair texture's own color, so they still match.
  const hair = worn.get("hair");
  const color = recipe.hair.color ?? (slot !== "hair" && hair?.original ? meanColor(hair.original) : null);
  if (!color) { ctx.putImageData(entry.original, 0, 0); entry.recolored = false; }
  else {
    const src = entry.original.data, out = new ImageData(new Uint8ClampedArray(src), entry.original.width, entry.original.height);
    const target = new THREE.Color(color).multiplyScalar(HAIR_SLOTS[slot]);
    const [tr, tg, tb] = [target.r, target.g, target.b].map((c) => Math.pow(c, 1 / 2.2) * 255);  // linear -> sRGB
    let sum = 0, count = 0;
    for (let i = 0; i < src.length; i += 4) if (src[i + 3] > 128) { sum += 0.3 * src[i] + 0.59 * src[i + 1] + 0.11 * src[i + 2]; count++; }
    const mean = sum / Math.max(count, 1) || 1;
    for (let i = 0; i < src.length; i += 4) {
      const l = Math.pow((0.3 * src[i] + 0.59 * src[i + 1] + 0.11 * src[i + 2]) / mean, 0.85);
      out.data[i] = tr * l; out.data[i + 1] = tg * l; out.data[i + 2] = tb * l;
    }
    ctx.putImageData(out, 0, 0); entry.recolored = true;
  }
  entry.mesh.material.map.needsUpdate = true;
}

/** The color a painted beard takes: the chosen hair color, else the hair's (or brows') own color. */
function facialHairColor() {
  const own = worn.get("hair")?.original ?? worn.get("eyebrows")?.original;
  const c = new THREE.Color(recipe.hair.color ?? (own ? meanColor(own) : "#3a2a1e"));
  return "#" + c.getHexString();  // the strand shading (beardShadeCanvas) darkens it
}

function meanColor(image) {
  const d = image.data; let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  const hex = (v) => Math.round(v / Math.max(n, 1)).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// Painted items (short beard, stubble) are drawn into the skin texture: no mesh, no triangles.
const paintOf = (slot, id) => id ? index.categories[slot]?.items.find((i) => i.id === id)?.paint ?? null : null;
async function setSlot(slot, id) {
  if (slot === "beard") scheduleSkin();
  if (paintOf(slot, id)) id = null;
  const old = worn.get(slot);
  if ((old?.item.id ?? null) === id) return;
  if (old) { avatar.remove(old.mesh); old.mesh.geometry.dispose(); old.mesh.material.map?.dispose(); old.mesh.material.dispose(); worn.delete(slot); }
  if (id) {
    const entry = await makeWorn(id, slot);
    if (slotId(slot) !== id) return;  // changed again while loading (or now painted)
    worn.set(slot, entry);
    avatar.add(entry.mesh);
  }
  if (slot === "hair") { for (const s of ["eyebrows", "moustache", "beard"]) { const e = worn.get(s); if (e) recolor(e, s); } scheduleSkin(); }
  updateBodyIndices();
  refit();
}
const slotId = (slot) => slot === "hair" ? recipe.hair.style : slot === "eyes" ? "low-poly" : ALWAYS.includes(slot) ? slot : recipe[slot];

let visibleBody = null;  // body triangles not covered by what's worn (before tucking into boots)
function updateBodyIndices() {
  visibleBody = visibleBodyIndices(base, [...worn.values()].map((e) => e.item));
  bodyGeom.setIndex(new THREE.BufferAttribute(visibleBody, 1));
  updateStatus();
}

// ---- Refit -----------------------------------------------------------------------------------
function refit(only = null) {
  morphBody(base, recipe.body, current, recipe.face);
  const normals = smoothNormals(current, bodySource, base.body.indices);
  const pos = bodyGeom.attributes.position.array, nor = bodyGeom.attributes.normal.array;
  let lowest = Infinity;
  for (let r = 0; r < bodySource.length; r++) {
    const v = bodySource[r] * 3;
    for (let k = 0; k < 3; k++) { pos[r * 3 + k] = current[v + k]; nor[r * 3 + k] = normals[v + k]; }
    lowest = Math.min(lowest, current[v + 1]);
  }
  bodyGeom.attributes.position.needsUpdate = true; bodyGeom.attributes.normal.needsUpdate = true;
  bodyGeom.computeBoundingSphere();
  avatar.position.y = -lowest / base.unitsPerMeter;  // feet on the floor
  const head = base.rig.cubes["joint-head"];
  faceHeight = (head.reduce((s, v) => s + current[v * 3 + 1], 0) / head.length - lowest) / base.unitsPerMeter + 0.04;
  for (const [slot, entry] of worn) {
    if (only && !only.has(slot)) continue;
    fitItem(entry.item, current, entry.fitted);
    if (slot === "eyebrows") raiseAlongSkin(entry, normals, recipe.eyebrowHeight / 10);
    if (INFLATE[slot]) inflate(entry, INFLATE[slot]);
  }
  if (!only && worn.has("top") && worn.has("bottom")) tuck(worn.get("bottom"), worn.get("top"));
  let tucked = null;
  for (const slot of ["bottom", "outfit"]) {  // trousers go into tall boots (never skirts, dresses or robes)
    const e = worn.get(slot);
    if (!only && e && worn.has("shoes") && !index.categories[slot]?.items.find((i) => i.id === e.item.id)?.skirt)
      tucked = tuckIntoBoots(e, worn.get("shoes"), normals) ?? tucked;
  }
  if (!only) { hideSkinInBoots(tucked); hatHair(worn.get("hair"), worn.get("hat")); }
  for (const [slot, entry] of worn) {
    if (only && !only.has(slot)) continue;
    const p = entry.mesh.geometry.attributes.position.array, src = entry.item.source;
    for (let r = 0; r < src.length; r++) for (let k = 0; k < 3; k++) p[r * 3 + k] = entry.fitted[src[r] * 3 + k];
    entry.mesh.geometry.attributes.position.needsUpdate = true;
    entry.mesh.geometry.computeVertexNormals();
    entry.mesh.geometry.computeBoundingSphere();
  }
}

// Hat hair: hair under a hat is pressed inside it, like real hair. Above the brim, hair is pulled in
// within the hat's own radius at that height and direction (crowns taper and tilt) and below its top;
// over a thin band just under the brim it eases in, so strands bend under the brim instead of poking
// through it. Changes hair.fitted (the export uses it).
function hatHair(hair, hat) {
  if (!hair || !hat) return;
  const H = hat.fitted, n = H.length / 3, SECTORS = 24, LEVELS = 8, BAND = 0.06;  // dm
  let cx = 0, cz = 0, top = -Infinity;
  for (let i = 0; i < n; i++) { cx += H[i * 3]; cz += H[i * 3 + 2]; top = Math.max(top, H[i * 3 + 1]); }
  cx /= n; cz /= n;
  const sector = (x, z) => ((Math.round(Math.atan2(x - cx, z - cz) / (2 * Math.PI) * SECTORS) % SECTORS) + SECTORS) % SECTORS;
  const brim = new Float32Array(SECTORS).fill(Infinity);  // the brim's height per direction (brims tilt)
  for (let i = 0; i < n; i++) { const s = sector(H[i * 3], H[i * 3 + 2]); brim[s] = Math.min(brim[s], H[i * 3 + 1]); }
  const lowest = Math.min(...brim.filter(isFinite));
  for (let s = 0; s < SECTORS; s++) if (!isFinite(brim[s])) brim[s] = lowest;
  // The hat's inner radius per direction and height level (level 0 = just above the brim: skip the
  // brim's own width by starting the profile 15% up).
  const level = (s, y) => Math.min(LEVELS - 1, Math.max(0, Math.floor((y - brim[s]) / (top - brim[s]) * LEVELS)));
  const radius = new Float32Array(SECTORS * LEVELS).fill(Infinity);
  for (let i = 0; i < n; i++) {
    const x = H[i * 3], y = H[i * 3 + 1], z = H[i * 3 + 2], s = sector(x, z);
    if (y < brim[s] + 0.15 * (top - brim[s])) continue;
    const k = s * LEVELS + level(s, y);
    radius[k] = Math.min(radius[k], Math.hypot(x - cx, z - cz));
  }
  for (let s = 0; s < SECTORS; s++) {  // gaps: take the level above (up the crown it only narrows)
    for (let l = LEVELS - 2; l >= 0; l--) if (!isFinite(radius[s * LEVELS + l])) radius[s * LEVELS + l] = radius[s * LEVELS + l + 1];
    for (let l = 1; l < LEVELS; l++) if (!isFinite(radius[s * LEVELS + l])) radius[s * LEVELS + l] = radius[s * LEVELS + l - 1];
  }
  const F = hair.fitted;
  for (let v = 0; v < F.length / 3; v++) {
    const x = F[v * 3], z = F[v * 3 + 2], s = sector(x, z);
    let y = F[v * 3 + 1];
    const w = Math.min(1, Math.max(0, (y - (brim[s] - BAND)) / BAND));
    if (!w) continue;
    if (y > top - 0.3) { y -= w * (y - (top - 0.3)); F[v * 3 + 1] = y; }  // under the crown, also where it's dented
    const r = Math.hypot(x - cx, z - cz), limit = 0.88 * radius[s * LEVELS + level(s, y)];
    if (isFinite(limit) && r > limit) { const k = 1 - w * (1 - limit / r); F[v * 3] = cx + (x - cx) * k; F[v * 3 + 2] = cz + (z - cz) * k; }
  }
}

// MakeHuman's eyebrows sit low, on the eye socket. Slide them up along the forehead: move each vertex
// along the skin's "up" tangent (the skin normal comes from the item's three base vertices).
function raiseAlongSkin(entry, normals, h) {
  if (!h) return;
  const { refs, weights } = entry.item, f = entry.fitted;
  for (let v = 0; v < entry.item.info.vertexCount; v++) {
    let nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < 3; k++) {
      const w = weights[v * 3 + k], r = refs[v * 3 + k] * 3;
      nx += w * normals[r]; ny += w * normals[r + 1]; nz += w * normals[r + 2];
    }
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    let tx = -ny * nx, ty = 1 - ny * ny, tz = -ny * nz;  // up minus its normal component
    const tl = Math.hypot(tx, ty, tz) || 1;
    f[v * 3] += h * tx / tl; f[v * 3 + 1] += h * ty / tl; f[v * 3 + 2] += h * tz / tl;
  }
}

// Trousers can rise above a top's hem and poke through it. Where the top covers them (above its hem),
// pull the trousers in a little, fading in over the first 1.5 cm above the hem.
function tuck(bottom, top) {
  let hem = Infinity;
  for (let i = 1; i < top.fitted.length; i += 3) hem = Math.min(hem, top.fitted[i]);
  hem += 0.05;
  const f = bottom.fitted, n = smoothNormals(f, bottom.item.source, bottom.item.indices);
  for (let v = 0; v < f.length / 3; v++) {
    const t = Math.min(1, Math.max(0, (f[v * 3 + 1] - hem) / 0.15));
    if (t > 0) for (let k = 0; k < 3; k++) f[v * 3 + k] -= n[v * 3 + k] * 0.1 * t * t * (3 - 2 * t);
  }
}

// Trousers into tall boots, as people wear them. Each leg on its own: the trouser leg is laid onto the
// skin from a little above the boot's top down, easing back out above it. Deeper inside the boot it sits
// just under the skin (hidden there anyway), so no boot is ever tighter, and it still fills any slit in
// the boot as the leg would. Ankle boots (top under BOOT_TALL) stay under the trouser hem as they are.
const BOOT_TALL = 2.2;  // decimeters above the sole
let legSkin = null;     // body vertices of the visible mesh (fixed for the base mesh)
function tuckIntoBoots(garment, boots, normals) {
  const b = boots.fitted, f = garment.fitted;
  let lowest = Infinity;
  for (let i = 1; i < b.length; i += 3) lowest = Math.min(lowest, b[i]);
  const top = [-Infinity, -Infinity];  // per leg: x < 0, x >= 0
  for (let i = 0; i < b.length; i += 3) { const s = b[i] < 0 ? 0 : 1; top[s] = Math.max(top[s], b[i + 1]); }
  if (Math.max(top[0], top[1]) - lowest < BOOT_TALL) return null;
  // Only legs whose trousers reach into the boot (shorts with tall boots keep their bare knees).
  const reaches = [false, false];
  for (let i = 0; i < f.length; i += 3) { const s = f[i] < 0 ? 0 : 1; if (f[i + 1] < top[s]) reaches[s] = true; }
  if (!reaches[0]) top[0] = -Infinity;
  if (!reaches[1]) top[1] = -Infinity;
  if (!reaches[0] && !reaches[1]) return null;
  const ABOVE = 0.7, FULL = 0.2, DEEP = 0.3, CELL = 0.8, OFF = 0.06, UNDER = -0.15;  // CELL: baggy hems reach far from the leg
  legSkin ??= [...new Set(bodySource)];
  const grid = new Map(), key = (x, y, z) => `${x},${y},${z}`, cell = (v) => Math.floor(v / CELL);
  const reach = Math.max(top[0], top[1]) + ABOVE + CELL;
  for (const v of legSkin) {
    const y = current[v * 3 + 1];
    if (y > reach) continue;
    const k = key(cell(current[v * 3]), cell(y), cell(current[v * 3 + 2]));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(v);
  }
  for (let i = 0; i < f.length; i += 3) {
    const x = f[i], y = f[i + 1], z = f[i + 2], side = x < 0 ? 0 : 1, t = top[side];
    if (y > t + ABOVE) continue;
    let best = -1, bestD = Infinity;
    const cx = cell(x), cy = cell(y), cz = cell(z);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const v of grid.get(key(cx + dx, cy + dy, cz + dz)) ?? []) {
        if ((current[v * 3] < 0 ? 0 : 1) !== side) continue;  // this leg's skin only
        const d = (current[v * 3] - x) ** 2 + (current[v * 3 + 1] - y) ** 2 + (current[v * 3 + 2] - z) ** 2;
        if (d < bestD) { bestD = d; best = v; }
      }
    }
    if (best < 0) continue;
    // Fully in up to a little above the rim (long trouser triangles then can't cut through the boot's
    // wall), easing out above.
    const w0 = y <= t + FULL ? 1 : 1 - (y - t - FULL) / (ABOVE - FULL), w = w0 * w0 * (3 - 2 * w0);
    const off = y < t - DEEP ? UNDER  // deep in the boot
      : OFF + 0.12 * Math.min(1, Math.max(0, (y - t + 0.2) / 0.6));  // looser up toward the knee: no skin showing through
    for (let k = 0; k < 3; k++) f[i + k] += (current[best * 3 + k] + normals[best * 3 + k] * off - f[i + k]) * w;
  }
  return top.map((t) => t + ABOVE);  // per leg: skin below this is covered by trousers and boot
}

// Skin inside tucked trousers and boots isn't drawn (or exported): coarse trousers laid onto the leg
// would otherwise let it poke through between their corners.
function hideSkinInBoots(below) {
  if (!visibleBody) return;
  let indices = visibleBody;
  if (below) {
    const keep = [];
    for (let t = 0; t < visibleBody.length; t += 3) {
      let inside = true;
      for (let c = 0; c < 3 && inside; c++) {
        const v = bodySource[visibleBody[t + c]];
        inside = current[v * 3 + 1] < below[current[v * 3] < 0 ? 0 : 1];
      }
      if (!inside) keep.push(visibleBody[t], visibleBody[t + 1], visibleBody[t + 2]);
    }
    indices = Uint32Array.from(keep);
  }
  if (bodyGeom.index.array !== indices) { bodyGeom.setIndex(new THREE.BufferAttribute(indices, 1)); updateStatus(); }
}

// Push clothes off the body along their own normals.
function inflate(entry, d) {
  const n = smoothNormals(entry.fitted, entry.item.source, entry.item.indices), f = entry.fitted;
  for (let i = 0; i < f.length; i++) f[i] += n[i] * d;
}

// ---- Skin texture: tone blend between the light and dark CC0 skin of the right age and gender,
// then makeup tinted through our masks.
const maskCanvases = {};
async function maskCanvas(name) {
  if (!maskCanvases[name]) maskCanvases[name] = (async () => {
    const img = await bitmap(`${A}masks/mask_${name}.png`);
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < data.data.length; i += 4) { data.data[i + 3] = data.data[i]; data.data[i] = data.data[i + 1] = data.data[i + 2] = 255; }
    ctx.putImageData(data, 0, 0);
    return c;
  })();
  return maskCanvases[name];
}
// The beard mask as light and shade (opaque gray): strands lighter, the gaps between them darker.
let beardShade = null;
async function beardShadeCanvas() {
  beardShade ??= (async () => {
    const img = await bitmap(`${A}masks/mask_beard.png`);
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height), d = data.data;
    for (let i = 0; i < d.length; i += 4) { const v = 255 * Math.min(1, 0.45 + 0.75 * d[i] / 255); d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    ctx.putImageData(data, 0, 0);
    return c;
  })();
  return beardShade;
}
let skinJob = 0;
async function composeSkin() {
  const job = ++skinJob;
  const done = await paintSkin(skinCanvas, "textures/view/", () => job === skinJob);
  if (!done) return;
  skinTexture.needsUpdate = true;
  document.documentElement.style.setProperty("--tone-light", rgb(done.light.swatch));
  document.documentElement.style.setProperty("--tone-dark", rgb(done.dark.swatch));
}
/** The skin for the recipe into `canvas` (square, any size) from the textures in `folder`. Returns
 * the two skins used, or null if `current()` turned false while loading (a newer request). */
async function paintSkin(canvas, folder, current = () => true) {
  const S = canvas.width;
  const layer = document.createElement("canvas"); layer.width = layer.height = S;
  const bucket = skinBucket(recipe.body), gender = skinGender(recipe.body);
  const light = index.skins[`${bucket}_caucasian_${gender}`], dark = index.skins[`${bucket}_african_${gender}`];
  const [lightImg, darkImg] = await Promise.all([bitmap(A + folder + light.texture), bitmap(A + folder + dark.texture)]);
  const masks = {};
  for (const name of ["eyeshadow", "lips", "nails"]) if (recipe.makeup[name].amount > 0) masks[name] = await maskCanvas(name);
  const beardPaint = paintOf("beard", recipe.beard), beardMask = beardPaint ? await maskCanvas("beard") : null;
  const beardShading = beardPaint ? await beardShadeCanvas() : null;
  if (!current()) return null;
  const ctx = canvas.getContext("2d");
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1; ctx.drawImage(lightImg, 0, 0, S, S);
  ctx.globalAlpha = recipe.skin.tone; ctx.drawImage(darkImg, 0, 0, S, S);
  // Mid tones: a straight cross-fade of the light and dark textures looks ashy gray. A warm soft-light
  // tint, strongest halfway, makes it a natural brown and keeps the texture's detail.
  const warm = Math.sin(Math.PI * recipe.skin.tone) * 0.45;
  if (warm > 0.005 && !recipe.skin.color) {
    ctx.globalAlpha = warm; ctx.globalCompositeOperation = "soft-light"; ctx.fillStyle = "#c07548"; ctx.fillRect(0, 0, S, S);
    ctx.globalCompositeOperation = "source-over";
  }
  if (recipe.skin.color) {  // fantasy skin: take the hue, keep the texture's light and shade
    ctx.fillStyle = recipe.skin.color;
    ctx.globalAlpha = 0.9; ctx.globalCompositeOperation = "color"; ctx.fillRect(0, 0, S, S);
    ctx.globalAlpha = 0.25; ctx.globalCompositeOperation = "multiply"; ctx.fillRect(0, 0, S, S);
    ctx.globalCompositeOperation = "source-over";
  }
  const lctx = layer.getContext("2d");
  if (beardMask) {  // hair over the skin in the hair color: a full short beard, or lighter as stubble
    lctx.globalCompositeOperation = "source-over"; lctx.clearRect(0, 0, S, S);
    lctx.drawImage(beardMask, 0, 0, S, S);
    lctx.globalCompositeOperation = "source-in"; lctx.fillStyle = facialHairColor(); lctx.fillRect(0, 0, S, S);
    lctx.globalCompositeOperation = "multiply"; lctx.drawImage(beardShading, 0, 0, S, S);
    lctx.globalCompositeOperation = "destination-in"; lctx.drawImage(beardMask, 0, 0, S, S);
    ctx.globalAlpha = beardPaint.amount; ctx.globalCompositeOperation = "source-over"; ctx.drawImage(layer, 0, 0);
    ctx.globalAlpha = beardPaint.amount * 0.3; ctx.globalCompositeOperation = "multiply"; ctx.drawImage(layer, 0, 0);
  }
  for (const [name, mask] of Object.entries(masks)) {
    const { amount, color } = recipe.makeup[name];
    lctx.globalCompositeOperation = "source-over"; lctx.clearRect(0, 0, S, S);
    lctx.drawImage(mask, 0, 0, S, S);
    lctx.globalCompositeOperation = "source-in"; lctx.fillStyle = color; lctx.fillRect(0, 0, S, S);
    ctx.globalAlpha = amount; ctx.globalCompositeOperation = "color"; ctx.drawImage(layer, 0, 0);
    ctx.globalAlpha = amount * 0.55; ctx.globalCompositeOperation = "multiply"; ctx.drawImage(layer, 0, 0);
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
  return { light, dark };
}
const rgb = (c) => `rgb(${c.join(",")})`;

// ---- UI --------------------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const SLIDERS = ["gender", "age", "muscle", "weight"];
const RACES = ["african", "asian", "caucasian"];
let skinTimer = 0;
const scheduleSkin = () => { clearTimeout(skinTimer); skinTimer = setTimeout(composeSkin, 40); };

for (const id of [...SLIDERS, ...RACES]) $(id).addEventListener("input", () => {
  const before = skinBucket(recipe.body) + skinGender(recipe.body);
  if (SLIDERS.includes(id)) recipe.body[id] = +$(id).value; else recipe.body.race[id] = +$(id).value;
  refit(); showValues();
  if (skinBucket(recipe.body) + skinGender(recipe.body) !== before) scheduleSkin();
});
$("tone").addEventListener("input", () => { recipe.skin.tone = +$("tone").value; scheduleSkin(); });
for (const name of ["eyeshadow", "lips", "nails"]) {
  $(`mk-${name}`).addEventListener("input", () => { recipe.makeup[name].amount = +$(`mk-${name}`).value; scheduleSkin(); });
  $(`mc-${name}`).addEventListener("input", () => {
    recipe.makeup[name].color = $(`mc-${name}`).value;
    if (!recipe.makeup[name].amount) { recipe.makeup[name].amount = 0.6; $(`mk-${name}`).value = 0.6; }
    scheduleSkin();
  });
}
$("name").addEventListener("input", () => { recipe.name = $("name").value; });

function showValues() {
  $("v-gender").textContent = recipe.body.gender.toFixed(2);
  $("v-age").textContent = ageYears(recipe.body.age) + " y";
  $("v-muscle").textContent = recipe.body.muscle.toFixed(2);
  $("v-weight").textContent = recipe.body.weight.toFixed(2);
  const sum = RACES.reduce((s, r) => s + recipe.body.race[r], 0) || 1;
  for (const r of RACES) $(`v-${r}`).textContent = Math.round(recipe.body.race[r] / sum * 100) + "%";
}

function tile(label, thumb, on, click) {
  const b = document.createElement("button");
  b.className = "tile" + (on ? " on" : ""); b.title = label;
  // Thumbnails load when their section is opened (showThumbs): lazy loading alone still fetches
  // images inside closed <details>.
  b.innerHTML = (thumb ? `<img loading="lazy" data-src="${thumb}" alt="">` : "") + `<span>${label}</span>`;
  b.addEventListener("click", click);
  return b;
}
function renderTiles(cat) {
  const box = $(`cat-${cat}`), def = index.categories[cat];
  const selected = cat === "hair" ? recipe.hair.style : recipe[cat];
  box.replaceChildren();
  const none = def.none ?? (cat === "top" || cat === "bottom" ? null : undefined);
  if (none !== undefined && none !== null) box.append(tile(none, null, !selected, () => choose(cat, null)));
  for (const it of def.items) box.append(tile(it.label, it.thumb ? `${A}thumbs/${it.id}.webp` : null, selected === it.id, () => choose(cat, it.id)));
  showThumbs(box);
}
// Ready-made avatars (assets/presets/): click one to start from it. Thumbnails load when the section opens.
let presetList = null;
const loadPresets = async () => presetList ??= (await fetchRetry(A + "presets/presets.json").then((r) => r.json())).presets;
async function renderPresets() {
  const presets = await loadPresets();
  const box = $("presets");
  box.replaceChildren(...presets.map((p) => tile(p.label, `${A}presets/${p.id}.webp`, false, () => {
    endPreview();
    applyRecipe({ ...structuredClone(p.recipe), name: recipe.name });
  })));
  showThumbs(box);
}

function showThumbs(root) {
  if (!root.closest("details")?.open) return;
  for (const img of root.querySelectorAll("img[data-src]")) { img.src = img.dataset.src; img.removeAttribute("data-src"); }
}
document.querySelectorAll("#panel details").forEach((d) => d.addEventListener("toggle", () => showThumbs(d)));

async function choose(cat, id) {
  if (cat === "hair") recipe.hair.style = id; else recipe[cat] = id;
  // An outfit replaces top and bottom; choosing a top or bottom takes the outfit off. There is always
  // something to wear: without an outfit, top and bottom fall back to the first choice.
  if (cat === "outfit" && id) { recipe.top = null; recipe.bottom = null; }
  if ((cat === "top" || cat === "bottom") && id) recipe.outfit = null;
  if (!recipe.outfit) {
    recipe.top ??= index.categories.top.items[0].id;
    recipe.bottom ??= index.categories.bottom.items[0].id;
  }
  for (const c of ITEM_SLOTS) renderTiles(c);
  await Promise.all(ITEM_SLOTS.map((c) => setSlot(c, c === "hair" ? recipe.hair.style : recipe[c])));
}

function renderSwatches() {
  const eyes = $("eyes"); eyes.replaceChildren();
  for (const [name, file] of Object.entries(index.eyeColors)) {
    const b = document.createElement("button");
    b.className = "swatch" + (recipe.eyes === name ? " on" : ""); b.title = name;
    // Each eye texture holds two eyeballs; zoom onto one iris (center 70%, 30%; about 23% wide).
    const size = 28 / 0.25;
    b.style.backgroundImage = `url(${A}thumbs/eye_${name}.jpg)`; b.style.backgroundSize = `${size}px`;  // small copy
    b.style.backgroundPosition = `${14 - 0.703 * size}px ${14 - 0.298 * size}px`;
    b.addEventListener("click", async () => {
      recipe.eyes = name; renderSwatches();
      const entry = worn.get("eyes"); if (entry) await setItemTexture(entry, file, "eyes");
    });
    eyes.append(b);
  }
  const hair = $("hair-color"); hair.replaceChildren();
  const natural = document.createElement("button");
  natural.className = "swatch natural" + (recipe.hair.color ? "" : " on"); natural.title = "As made";
  natural.addEventListener("click", () => setHairColor(null));
  hair.append(natural);
  for (const [name, color] of Object.entries({ ...HAIR_COLORS, ...FANTASY_HAIR })) {
    const b = document.createElement("button");
    b.className = "swatch" + (recipe.hair.color === color ? " on" : ""); b.title = name; b.style.background = color;
    b.addEventListener("click", () => setHairColor(color));
    hair.append(b);
  }
  const custom = document.createElement("input");
  custom.type = "color"; custom.title = "Other color"; custom.value = recipe.hair.color ?? "#5e4029";
  custom.addEventListener("input", () => setHairColor(custom.value, true));
  hair.append(custom);
}
function renderSkinColors() {
  const box = $("skin-color"); box.replaceChildren();
  const natural = document.createElement("button");
  natural.className = "swatch" + (recipe.skin.color ? "" : " on"); natural.title = "Natural (skin tone slider)";
  natural.style.background = "linear-gradient(135deg, var(--tone-light), var(--tone-dark))";
  natural.addEventListener("click", () => setSkinColor(null));
  box.append(natural);
  for (const [name, color] of Object.entries(SKIN_COLORS)) {
    const b = document.createElement("button");
    b.className = "swatch" + (recipe.skin.color === color ? " on" : ""); b.title = name; b.style.background = color;
    b.addEventListener("click", () => setSkinColor(color));
    box.append(b);
  }
  const custom = document.createElement("input");
  custom.type = "color"; custom.title = "Other color"; custom.value = recipe.skin.color ?? "#5fa85a";
  custom.addEventListener("input", () => setSkinColor(custom.value, true));
  box.append(custom);
}
function setSkinColor(color, keepSwatches) {
  recipe.skin.color = color;
  if (!keepSwatches) renderSkinColors();
  scheduleSkin();
}

// Face-shape sliders, built from pipeline/modifiers.json.
// ---- Surprise me -------------------------------------------------------------------------------
// A random person in a ready-made avatar's clothes (so the outfit hangs together, costumes included):
// a new body, age, ancestry mix with a matching skin tone, eyes, hair, sometimes a beard, glasses or
// makeup, and a little face shaping. Fantasy skin and hair colors stay with the costumes that have them.
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const chance = (p) => Math.random() < p;
async function surprise() {
  const presets = await loadPresets();
  const male = chance(0.5);
  const sameSex = (p) => (p.recipe.body?.gender ?? 1) > 0.5 === male;
  const style = structuredClone(pick(presets.filter(sameSex)).recipe);
  const r = { ...style, name: recipe.name, face: {} };
  const age = chance(0.75) ? rand(0.38, 0.7) : rand(0.7, 0.9);  // mostly 20 to 50, some to about 77
  const main = pick(RACES), race = { african: 0, asian: 0, caucasian: 0 };
  race[main] = rand(0.6, 1);
  for (const other of RACES.filter((x) => x !== main)) race[other] = rand(0, 1 - race[main]);
  r.body = { gender: male ? rand(0.75, 1) : rand(0, 0.25), age, muscle: rand(0.25, 0.75), weight: rand(0.2, 0.8), race };
  const sum = race.african + race.asian + race.caucasian;
  const tone = Math.min(1, Math.max(0, (race.african * 0.9 + race.asian * 0.2) / sum + rand(-0.12, 0.12)));
  r.skin = { tone, color: style.skin?.color ?? null };
  const eyes = Object.keys(index.eyeColors);
  r.eyes = tone > 0.4 || chance(0.5) ? pick(["brown", "brown", "brownlight", "green"]) : pick(eyes);
  // Hair: half the time the outfit's own, otherwise one worn by someone of the same sex among the
  // ready-made avatars; natural colors by age, unless the costume has a fantasy color.
  const styles = [...new Set(presets.filter(sameSex).map((p) => p.recipe.hair?.style).filter((h) => h !== undefined))];
  const naturalColor = age > 0.8 && chance(0.7) ? pick(["Grey", "White"]) : age > 0.65 && chance(0.4) ? "Grey"
    : pick(Object.keys(HAIR_COLORS).filter((c) => c !== "Grey" && c !== "White"));
  const fantasy = style.hair?.color && Object.values(FANTASY_HAIR).includes(style.hair.color);
  r.hair = { style: chance(0.5) ? style.hair?.style ?? null : pick(styles), color: fantasy ? style.hair.color : HAIR_COLORS[naturalColor] };
  r.eyebrows = pick(index.categories.eyebrows.items).id;
  r.eyebrowHeight = Math.round(rand(0.3, 1.1) * 10) / 10;
  if (male && !style.beard && !style.moustache && chance(0.4)) r.beard = pick(["paint_stubble", "paint_beard_short", "beard_goatee", "beard_short"]);
  if (!male) { r.beard = null; r.moustache = null; }
  const ordinaryGlasses = index.categories.glasses.items.map((i) => i.id).filter((id) => id.includes("glasses"));
  if (!style.glasses && chance(0.18)) r.glasses = pick(ordinaryGlasses);
  const makeup = structuredClone(DEFAULT_RECIPE.makeup);
  if (!male && chance(0.55)) {
    makeup.lips = { amount: rand(0.25, 0.6), color: pick(["#a8323e", "#b5525a", "#8c3b4a", "#c46a6a"]) };
    if (chance(0.5)) makeup.eyeshadow = { amount: rand(0.2, 0.45), color: pick(["#7a5a8c", "#6b5a4a", "#4a5a7a", "#8a6a5a"]) };
  }
  for (const [k, v] of Object.entries(style.makeup ?? {})) if (v.amount > 0) makeup[k] = v;  // a costume's own makeup wins
  r.makeup = makeup;
  for (const m of [...base.modifiers].sort(() => Math.random() - 0.5).slice(0, 5))
    r.face[m.id] = Math.round((m.decr ? rand(-0.4, 0.4) : rand(0, 0.4)) * 100) / 100;
  endPreview();
  await applyRecipe(r);
}
$("surprise").addEventListener("click", () => surprise().catch((err) => { $("status").textContent = err.message; }));

// ---- Start from a photo ----------------------------------------------------------------------
// The face finder (web/lib/photo-fit.js) finds 468 points on the photo's face. We render our own
// face at the photo's angle and find the same points there, then move the face sliders and the
// ancestry mix until the two match: each round renders the face once per slider, nudged, to see how
// the points move (Gauss-Newton with bounds, pulled gently toward 0 so unclear sliders stay put).
// The face finder reads real faces a little differently from ours, so the photo's points are first
// corrected by the average difference (web/lib/photo-bias.json, calibrated on public-domain
// portraits). Skin tone, eye and hair color come from the photo's pixels. Female–Male and age stay
// as set: they change the whole body. The photo never leaves the browser.
// The face finder's lip and eye outline points.
const LIP_POINTS = new Set([61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 185, 40, 39, 37, 0, 267, 269, 270, 409,
  78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 191, 80, 81, 82, 13, 312, 311, 310, 415]);
const EYE_POINTS = new Set([33, 7, 163, 144, 145, 153, 154, 155, 133, 246, 161, 160, 159, 158, 157, 173,
  263, 249, 390, 373, 374, 380, 381, 382, 362, 466, 388, 387, 386, 385, 384, 398]);
const PHOTO_SLOTS = new Set(["eyes", "eyebrows", "eyelashes01"]);  // what the face finder sees of us
const FIT_FACE = ["noseSize", "noseWidth", "noseLength", "noseDepth", "noseHump", "noseTip", "noseNostrils",
  "headWidth", "headLength", "chinWidth", "chinProminent", "cheekbones", "lips", "mouthWidth", "eyeSize"];
const EYE_IRIS = { brown: [70, 13, 2], brownlight: [111, 81, 37], green: [59, 93, 53], bluegreen: [119, 180, 162], blue: [49, 91, 99],
  lightblue: [105, 166, 178], deepblue: [56, 57, 89], grey: [135, 150, 140], ice: [125, 161, 137] };  // iris medians of the textures
function fitVariables() {
  const setRace = (african, asian) => {
    african = Math.max(0, african); asian = Math.max(0, asian);
    const sum = african + asian; if (sum > 1) { african /= sum; asian /= sum; }
    recipe.body.race = { african, asian, caucasian: 1 - african - asian };
  };
  return [
    ...FIT_FACE.map((id) => ({ get: () => recipe.face[id] ?? 0, set: (v) => { recipe.face[id] = v; }, lo: -1, hi: 1, h: 0.35 })),
    { get: () => recipe.body.race.african, set: (v) => setRace(v, recipe.body.race.asian), lo: 0, hi: 1, h: 0.25 },
    { get: () => recipe.body.race.asian, set: (v) => setRace(recipe.body.race.african, v), lo: 0, hi: 1, h: 0.25 },
  ];
}
const faceCamera = new THREE.PerspectiveCamera(20, 1, 0.05, 10);
const faceView = { yaw: 0, pitch: 0 };  // the photo's head turn, so we measure our face at the same angle
/** Our face rendered at the photo's angle, neutral, with only what the face finder should see; its
 * points. */
function ourFacePoints(lm) {
  for (const mesh of [bodyMesh, ...[...worn.values()].map((e) => e.mesh)]) mesh.morphTargetInfluences?.fill(0);
  const hidden = [];
  for (const [slot, e] of worn) if (!PHOTO_SLOTS.has(slot) && e.mesh.visible) { e.mesh.visible = false; hidden.push(e.mesh); }
  const grid = scene.children.find((o) => o.isGridHelper); if (grid) grid.visible = false;
  const canvas = renderer.domElement;
  faceCamera.aspect = canvas.width / canvas.height; faceCamera.updateProjectionMatrix();
  const fh = faceHeight - 0.05;
  const { yaw, pitch } = faceView;
  faceCamera.position.set(Math.sin(yaw) * Math.cos(pitch), fh + Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  faceCamera.lookAt(0, fh, 0);
  renderer.render(scene, faceCamera);
  const found = facePoints(lm, canvas);
  const colors = found ? sampleColors(canvas, found.raw) : null;
  for (const m of hidden) m.visible = true; if (grid) grid.visible = true;
  return found && { ...found, colors };
}
async function readPhoto(file) {
  const image = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
  const photo = document.createElement("canvas");
  photo.width = Math.round(image.width * scale); photo.height = Math.round(image.height * scale);
  photo.getContext("2d").drawImage(image, 0, 0, photo.width, photo.height);
  return photo;
}
/** The face in the photo: { photo, theirs }. A small face in a big picture is looked at again alone,
 * larger (finer points, cleaner colors); `photo` is then that crop. */
function findFace(lm, photo) {
  let theirs = facePoints(lm, photo);
  if (!theirs) return null;
  const xs = theirs.raw.slice(0, 468).map((p) => p.x * photo.width), ys = theirs.raw.slice(0, 468).map((p) => p.y * photo.height);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const side = Math.min(Math.max(photo.width, photo.height), 2.2 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)));
  if (side < 0.7 * Math.min(photo.width, photo.height)) {
    const crop = document.createElement("canvas"); crop.width = crop.height = 768;
    crop.getContext("2d").drawImage(photo, cx - side / 2, cy - side / 2, side, side, 0, 0, 768, 768);
    const again = facePoints(lm, crop);
    if (again) return { photo: crop, theirs: again };
  }
  return { photo, theirs };
}
/** How much each point counts. Above the brows less: hair covers or shifts it, in the photo and in
 * ours differently. Our face is neutral, so a smiling or squinting photo's lips and eyes count less
 * (our face shapes can't make a natural smile to compare with). */
function photoWeights(theirs, ours) {
  const P = ours.pts, browY = (P[105 * 3 + 1] + P[334 * 3 + 1]) / 2, faceH = P[10 * 3 + 1] - P[152 * 3 + 1];
  const b = theirs.blend, smile = Math.max(b.mouthSmileLeft ?? 0, b.mouthSmileRight ?? 0, (b.jawOpen ?? 0) * 2);
  const squint = Math.max(b.eyeSquintLeft ?? 0, b.eyeSquintRight ?? 0, b.eyeBlinkLeft ?? 0, b.eyeBlinkRight ?? 0);
  const lipWt = Math.max(0.1, 1 - smile * 1.2), eyeWt = Math.max(0.2, 1 - squint);
  const pointWt = new Float64Array(P.length / 3).map((_, i) => (P[i * 3 + 1] > browY + 0.04 * faceH ? 0.15 : 1) *
    (LIP_POINTS.has(i) ? lipWt : EYE_POINTS.has(i) ? eyeWt : 1));
  const wt = new Float64Array(P.length).map((_, k) => (k % 3 === 2 ? 0 : pointWt[(k - k % 3) / 3]));  // x and y only
  return { pointWt, wt };
}
/** The photo's head turn: try angles, keep the one whose points match the photo's best (faceView). */
function findAngle(lm, theirs, pointWt, wt) {
  const misfitAt = (yaw, pitch) => {
    Object.assign(faceView, { yaw, pitch });
    const f = ourFacePoints(lm); if (!f) return Infinity;
    const a = alignFlat(theirs.pts, f.pts, pointWt);
    let s = 0; for (let k = 0; k < a.length; k++) s += wt[k] * (a[k] - f.pts[k]) ** 2;
    return s;
  };
  let best = { yaw: 0, pitch: 0, m: misfitAt(0, 0) };
  for (const step of [0.2, 0.1, 0.05]) {
    for (let moved = true, tries = 0; moved && tries < 5; tries++) {
      moved = false;
      for (const [dy, dp] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const yaw = best.yaw + dy * step, pitch = best.pitch + dp * step * 0.6;
        if (Math.abs(yaw) > 0.8 || Math.abs(pitch) > 0.4) continue;
        const m = misfitAt(yaw, pitch);
        if (m < best.m) { best = { yaw, pitch, m }; moved = true; }
      }
    }
  }
  Object.assign(faceView, { yaw: best.yaw, pitch: best.pitch });
}
/** The photo's points on our face's (in its picture), less how the face finder reads real faces
 * differently from ours (photoBias: an average real face then lands on our average face). */
function photoTarget(theirs, ours, pointWt) {
  const target = alignFlat(theirs.pts, ours.pts, pointWt);
  if (photoBias) {
    const g = recipe.body.gender, faceH = ours.pts[10 * 3 + 1] - ours.pts[152 * 3 + 1];
    for (let i = 0; i < target.length / 3; i++) for (let k = 0; k < 2; k++)
      target[i * 3 + k] -= faceH * (g * photoBias.male[i * 2 + k] + (1 - g) * photoBias.female[i * 2 + k]);
  }
  return target;
}
let photoBias = null;

/** Fit the face to one or more photos of the same person (canvases), e.g. straight on and turned
 * to each side: all are matched at once, each at its own angle. A turned head shows the nose's
 * depth and the chin's profile, which a straight-on photo can't. Colors come from the most frontal. */
async function fromPhotos(photos, say) {
  endPreview();
  say("Loading the face finder (about 17 MB the first time)…");
  showPhotos(photos.map((photo) => ({ photo })));
  const lm = await loadLandmarker();
  photoBias ??= await fetchRetry(new URL("../lib/photo-bias.json", import.meta.url)).then((r) => r.json()).catch(() => null);
  say("Finding the face…");
  const views = photos.map((p) => findFace(lm, p)).filter(Boolean);
  if (!views.length) throw new Error("No face found. Try a photo looking straight at the camera, in good light.");
  showPhotos(views);
  // Face shape and ancestry.
  recipe.face = {};
  const vars = fitVariables(), lo = vars.map((v) => v.lo), hi = vars.map((v) => v.hi);
  const measure = () => { refit(PHOTO_SLOTS); const f = ourFacePoints(lm); if (!f) throw new Error("Couldn't measure our own face"); return f; };
  say(views.length > 1 ? "Finding the head's angle in each photo…" : "Finding the head's angle…");
  for (const v of views) {
    Object.assign(faceView, { yaw: 0, pitch: 0 });
    Object.assign(v, photoWeights(v.theirs, measure()));
    findAngle(lm, v.theirs, v.pointWt, v.wt);
    v.view = { ...faceView };
    await new Promise((r) => setTimeout(r, 0));
  }
  for (let round = 0; round < 3; round++) {
    say(`Matching the face shape (round ${round + 1} of 3)…`);
    await new Promise((r) => setTimeout(r, 0));
    const x = vars.map((v) => v.get()), r = [], wt = [], J = vars.map(() => []);
    for (const v of views) {
      Object.assign(faceView, v.view);
      const ours = measure();
      const target = photoTarget(v.theirs, ours, v.pointWt);
      for (let k = 0; k < target.length; k++) { r.push(target[k] - ours.pts[k]); wt.push(v.wt[k]); }
      for (let i = 0; i < vars.length; i++) {
        const step = x[i] + vars[i].h <= hi[i] ? vars[i].h : -vars[i].h;
        vars[i].set(x[i] + step);
        const moved = alignFlat(measure().pts, ours.pts, v.pointWt);
        for (let k = 0; k < moved.length; k++) J[i].push((moved[k] - ours.pts[k]) / step);
        vars[i].set(x[i]);
        if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));  // keep the page responsive
      }
    }
    const d = solveBounded(J, r, x, lo, hi, 0.08, wt);
    vars.forEach((v, i) => v.set(x[i] + d[i]));
  }
  // Colors, from the most frontal photo: skin by its lightness, eyes by hue, hair brought to our light.
  const front = views.reduce((a, b) => (Math.abs(b.view.yaw) < Math.abs(a.view.yaw) ? b : a));
  Object.assign(faceView, { yaw: 0, pitch: 0 });
  const ours = measure(), pc = sampleColors(front.photo, front.theirs.raw), oc = ours.colors;
  const hair = await loadHairSegmenter().then((seg) => findHair(seg, front.photo, front.theirs.raw)).catch(() => null);
  if (hair) pc.hair = hair.cover < 0.12 ? null : hair.color;
  const notes = [];
  if (pc.skin && !recipe.skin.color) {
    // The skin's lightness (CIELAB L*). Photos are exposed for the face, and lit skin reads lighter
    // than its color, darker skin much more so: L* 73 is our lightest tone, 54 our darkest (from
    // official portraits; the white of the eyes is too often shaded or squinted away to measure by).
    recipe.skin.tone = Math.round(Math.min(1, Math.max(0, (73 - lightness(pc.skin)) / 19)) * 100) / 100;
  }
  if (pc.iris) {
    const chroma = (c) => { const l = c.map(toLinear), s = l[0] + l[1] + l[2] + 1e-6; return [l[0] / s, l[1] / s, l[2] / s, Math.log(s + 0.01)]; };
    const want = chroma(pc.iris);
    const dist = (c) => { const g = chroma(c); return Math.hypot(g[0] - want[0], g[1] - want[1], g[2] - want[2]) + 0.3 * Math.abs(g[3] - want[3]); };
    recipe.eyes = Object.keys(EYE_IRIS).filter((k) => k in index.eyeColors).sort((p, q) => dist(EYE_IRIS[p]) - dist(EYE_IRIS[q]))[0];
  }
  if (hair && hair.cover < 0.12) {  // bald or shaved
    recipe.hair.style = null;
    notes.push("no hair on top, so none on the avatar");
  } else if (pc.hair) {
    if (hair && !recipe.hair.style) recipe.hair.style = DEFAULT_RECIPE.hair.style;  // brought to our light: by the white of the eyes, or else by the skin
    const gain = Math.min(1.4, Math.max(0.8, pc.sclera && oc?.sclera ? luminance(oc.sclera) / luminance(pc.sclera)
      : oc?.skin && pc.skin ? luminance(oc.skin) / luminance(pc.skin) : 1));
    recipe.hair.color = "#" + pc.hair.map((c) => Math.min(255, toSRGB(Math.min(1, toLinear(c) * gain))).toString(16).padStart(2, "0")).join("");
  } else notes.push("hair color left as it was (none found above the forehead)");
  if (views.length < photos.length) notes.push(`no face found in ${photos.length - views.length} of the photos`);
  await applyRecipe(structuredClone(recipe));
  setCamera("face");
  return notes;
}
// Calibration (web/lib/photo-bias.json; run from the test hook, see STATUS.md): how the face finder
// reads real faces (photos: [{url, gender}]) vs our face with a matching ancestry mix; the mean
// difference per point, as a fraction of the face's height.
async function calibratePhotos(photos, race, age = 0.62) {
  const lm = await loadLandmarker(), sums = { male: null, female: null }, weights = { male: null, female: null }, info = [];
  for (const { url, gender } of photos) {
    const photo = await readPhoto(await (await fetch(url)).blob());
    const found = findFace(lm, photo);
    if (!found) { info.push({ url, found: false }); continue; }
    recipe.body = { ...recipe.body, gender, age, race: { ...race } }; recipe.face = {};
    Object.assign(faceView, { yaw: 0, pitch: 0 });
    refit(PHOTO_SLOTS);
    const first = ourFacePoints(lm);
    const { pointWt, wt } = photoWeights(found.theirs, first);
    findAngle(lm, found.theirs, pointWt, wt);
    const ours = ourFacePoints(lm), faceH = ours.pts[10 * 3 + 1] - ours.pts[152 * 3 + 1];
    const a = alignFlat(found.theirs.pts, ours.pts, pointWt), key = gender ? "male" : "female";
    sums[key] ??= new Float64Array(936); weights[key] ??= new Float64Array(468);
    for (let i = 0; i < 468; i++) {
      for (let k = 0; k < 2; k++) sums[key][i * 2 + k] += pointWt[i] * (a[i * 3 + k] - ours.pts[i * 3 + k]) / faceH;
      weights[key][i] += pointWt[i];
    }
    const pc = sampleColors(found.photo, found.theirs.raw);
    info.push({ url: url.split("/").pop(), view: { ...faceView }, L: pc.skin ? +lightness(pc.skin).toFixed(1) : null });
  }
  Object.assign(faceView, { yaw: 0, pitch: 0 });
  const out = {};
  for (const key of ["male", "female"]) out[key] = Array.from(sums[key], (v, j) => {
    const w = weights[key][j >> 1];
    return w > 1 ? +(v / w).toFixed(5) : 0;  // points that hardly counted anywhere (smiles): no correction
  });
  return { bias: out, info };
}
/** The photos (and the points found on them) side by side in the dialog. */
function showPhotos(views) {
  const c = $("photo-canvas"), n = views.length, H = 300, gap = 6;
  const widths = views.map(({ photo }) => Math.round(H * photo.width / photo.height));
  c.width = widths.reduce((s, w) => s + w, 0) + gap * (n - 1); c.height = H;
  const ctx = c.getContext("2d");
  let x0 = 0;
  views.forEach(({ photo, theirs }, i) => {
    const W = widths[i];
    ctx.drawImage(photo, x0, 0, W, H);
    if (theirs) {
      ctx.fillStyle = "rgba(120, 220, 255, 0.8)";
      for (let k = 0; k < 468; k += 2) ctx.fillRect(x0 + theirs.raw[k].x * W - 0.75, theirs.raw[k].y * H - 0.75, 1.5, 1.5);
    }
    x0 += W + gap;
  });
}

// The camera: three shots, straight on and turned a little to each side. Nothing starts until Start
// is pressed. Each step says what to do in large type over the video; when the face finder sees the
// head held at the right angle, a 3-2-1 countdown runs (it starts over if the head moves away), then
// a flash, a check mark on the step, and a moment before the next. "Take now" takes it as it is.
let webcam = null;  // { stream, stop: true when cancelled }
let photoRun = 0;  // goes up on each start and on Cancel: a camera that opens after a Cancel is closed again
const SIDE = [15, 35];  // degrees of head turn for the side shots
const SHOTS = [
  { say: "Look straight into the camera", hint: (yaw) => (Math.abs(yaw) < 7 ? null : "Turn to face the camera") },
  { say: "Turn your head a little to one side, eyes still on the camera",
    hint: (yaw) => (Math.abs(yaw) < SIDE[0] ? "A bit more" : Math.abs(yaw) > SIDE[1] ? "Not quite so far" : null) },
  { say: "Now a little to the other side, eyes still on the camera",
    hint: (yaw, side) => (Math.sign(yaw) === Math.sign(side) && Math.abs(yaw) > 7 ? "The other side" :
      Math.abs(yaw) < SIDE[0] ? "A bit more" : Math.abs(yaw) > SIDE[1] ? "Not quite so far" : null) },
];
const HOLD = 2.4;  // seconds held still for a shot (the countdown)
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function stopCamera() {
  if (!webcam) return;
  webcam.stop = true; webcam.stream.getTracks().forEach((t) => t.stop());
  $("photo-video").srcObject = null; $("photo-cam").hidden = true; $("photo-take").hidden = true;
  $("photo-box").querySelector(".card").classList.remove("wide");
  webcam = null;
}
function camSay(big, small = "") {
  $("cam-say").querySelector("b").textContent = big;
  $("cam-say").querySelector("small").textContent = small;
}
function camSteps(now, done) {
  [...$("cam-steps").children].forEach((el, i) => {
    el.className = i < done ? "done" : i === now ? "now" : "";
    el.textContent = (i < done ? "✓ " : `${i + 1} `) + ["Straight", "Turned", "Other way"][i];
  });
}
async function cameraShots(say, run) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't use the camera here (it needs a secure page: https, or localhost). Choose photos instead.");
  say("Waiting for the camera…");
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false })
    .catch(() => { throw new Error("No camera, or it wasn't allowed. Choose photos instead."); });
  if (run !== photoRun) { stream.getTracks().forEach((t) => t.stop()); return null; }
  const me = webcam = { stream, stop: false };
  const video = $("photo-video");
  video.srcObject = stream;
  $("photo-box").querySelector(".card").classList.add("wide");
  $("photo-cam").hidden = false; $("photo-canvas").hidden = true; say("");
  await video.play();
  camSteps(-1, 0); $("cam-count").textContent = "";
  camSay("Getting ready…", "Loading the face finder (about 17 MB the first time)");
  const lm = await loadLandmarker();
  if (me.stop) return null;
  // Wait for Start.
  camSay("Three photos: straight on, then turned a little each way", "Keep your eyes on the camera, and a neutral face. Press Start when ready.");
  $("cam-go").hidden = false;
  await new Promise((resolve) => { $("cam-go").onclick = resolve; const t = setInterval(() => { if (me.stop) { clearInterval(t); resolve(); } }, 200); });
  $("cam-go").hidden = true;
  if (me.stop) return null;
  const shots = [];
  let side = 0;  // the first turn's direction: the second goes the other way
  for (const [n, shot] of SHOTS.entries()) {
    camSteps(n, n); camSay(shot.say);
    $("photo-take").hidden = false;
    let take = false; $("photo-take").onclick = () => { take = true; };
    let since = null, frame = null;
    while (!me.stop) {
      await pause(100);
      if (me.stop || !video.videoWidth) continue;
      frame = document.createElement("canvas");
      frame.width = video.videoWidth; frame.height = video.videoHeight;
      frame.getContext("2d").drawImage(video, 0, 0);
      if (take) break;
      const yaw = facePoints(lm, frame)?.turn?.yaw;
      const hint = yaw == null ? "Can't see your face" : shot.hint(yaw, side);
      if (hint) { since = null; $("cam-count").textContent = ""; camSay(shot.say, hint); continue; }
      since ??= performance.now();
      const left = HOLD - (performance.now() - since) / 1000;
      camSay(shot.say, "Hold it there");
      $("cam-count").textContent = left > 0 ? Math.ceil(left / (HOLD / 3)) : "";
      if (left <= 0) { if (n === 1) side = yaw || 1; break; }
    }
    if (me.stop) return null;
    if (n === 1 && take) side = facePoints(lm, frame)?.turn?.yaw || 1;
    shots.push(frame);
    $("cam-count").textContent = "";
    $("cam-flash").classList.add("on"); requestAnimationFrame(() => requestAnimationFrame(() => $("cam-flash").classList.remove("on")));
    camSteps(-1, n + 1); camSay(`✓ Photo ${n + 1} of 3 taken`, n < 2 ? "Next one coming up…" : "All done");
    $("photo-take").hidden = true;
    await pause(1300);
    if (me.stop) return null;
  }
  stopCamera();
  $("photo-canvas").hidden = false;
  return shots;
}

let photoBefore = null;
const photoSay = (text) => { $("photo-status").textContent = text; };
function photoStep(step) {  // "start": choose the camera or photos; "busy"; "done"
  $("photo-start").hidden = step !== "start";
  $("photo-canvas").hidden = step === "start" || !!webcam;
  $("photo-undo").hidden = step !== "done" || !photoBefore;
  $("photo-done").textContent = step === "done" ? "Done" : "Cancel";
  $("photo-done").disabled = false;
}
async function runPhotoFit(getPhotos) {
  const before = structuredClone(recipe), run = ++photoRun;
  let failed = false;
  photoBefore = null; photoStep("busy");
  try {
    const photos = await getPhotos(run);
    if (!photos || run !== photoRun) return;  // cancelled
    $("photo-done").disabled = true;
    const notes = await fromPhotos(photos, photoSay);
    photoBefore = before;
    photoSay("Done (this is a beta). Face shape, ancestry mix, skin tone, eye and hair color now follow the photo" + (photos.length > 1 ? "s" : "") +
      (notes.length ? ` (${notes.join("; ")})` : "") + ". Hair style and clothes are yours to pick. It's a resemblance, not a likeness: adjust anything you like.");
  } catch (err) {
    stopCamera(); failed = true;
    photoSay(err.message);
    Object.assign(faceView, { yaw: 0, pitch: 0 });
    await applyRecipe(before);
  } finally { if (run === photoRun) photoStep(failed ? "start" : "done"); }  // after a failure: try again
}
$("photo").addEventListener("click", () => {
  $("photo-box").hidden = false; photoBefore = null; photoStep("start");
  photoSay("Take three quick shots with the camera (straight on, then turned a little each way), or choose one or more photos of the same face.");
});
$("photo-pick").addEventListener("click", () => $("photo-file").click());
$("photo-camera").addEventListener("click", () => runPhotoFit((run) => cameraShots(photoSay, run)));
$("photo-file").addEventListener("change", (e) => {
  const files = [...e.target.files].slice(0, 5); e.target.value = "";
  if (files.length) runPhotoFit(() => Promise.all(files.map(readPhoto)));
});
$("photo-done").addEventListener("click", () => { photoRun++; stopCamera(); $("photo-box").hidden = true; photoBefore = null; });
$("photo-undo").addEventListener("click", async () => {
  $("photo-box").hidden = true;
  if (photoBefore) await applyRecipe(photoBefore);
  photoBefore = null;
});

// ---- Share link ------------------------------------------------------------------------------
// The recipe goes after the # (never sent to a server), deflated and base64url: opening the link
// rebuilds the avatar. Unknown item ids (from an older or newer catalog) fall back to the defaults.
async function recipeLink() {
  const bytes = new TextEncoder().encode(JSON.stringify(recipe));
  const packed = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  let bin = ""; for (const b of packed) bin += String.fromCharCode(b);
  const code = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${location.origin}${location.pathname}#r=${code}`;
}
async function recipeFromLink(hash) {
  const code = hash.match(/^#r=([A-Za-z0-9_-]+)$/)?.[1];
  if (!code) return null;
  const bin = atob(code.replace(/-/g, "+").replace(/_/g, "/"));
  const packed = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const text = await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
  return checkedRecipe(JSON.parse(text));
}
/** A recipe from outside (a link, another site): only ids this catalog has (others: the defaults). */
function checkedRecipe(found) {
  if (!found || typeof found !== "object" || Array.isArray(found)) return null;
  found = structuredClone(found);
  for (const slot of ITEM_SLOTS) {  // only ids this catalog has
    const id = slot === "hair" ? found.hair?.style : found[slot];
    if (id && !index.categories[slot]?.items.some((i) => i.id === id)) {
      if (slot === "hair") found.hair.style = DEFAULT_RECIPE.hair.style; else found[slot] = DEFAULT_RECIPE[slot];
    }
  }
  if (found.eyes && !(found.eyes in index.eyeColors)) found.eyes = DEFAULT_RECIPE.eyes;
  return found;
}
$("share").addEventListener("click", async () => {
  try {
    const link = await recipeLink();
    history.replaceState(null, "", link);
    if (navigator.share && matchMedia("(pointer: coarse)").matches) await navigator.share({ title: recipe.name || "My avatar", url: link });
    else { await navigator.clipboard.writeText(link); $("status").textContent = "Link copied: it opens this avatar in the maker."; }
  } catch (err) {
    if (err.name !== "AbortError") $("status").textContent = "Couldn't copy the link; it's in the address bar now.";
  }
});

function buildFaceSliders() {
  const box = $("face-shape"); box.replaceChildren();
  let group = null;
  for (const m of base.modifiers) {
    if (m.group !== group) { group = m.group; const h = document.createElement("div"); h.className = "sub"; h.textContent = group; box.append(h); }
    const label = document.createElement("label"); label.className = "slider";
    label.innerHTML = `${m.label} <span></span><input type="range" min="${m.decr ? -1 : 0}" max="1" step="0.01">`;
    const input = label.querySelector("input"), out = label.querySelector("span");
    input.dataset.mod = m.id;
    input.addEventListener("input", () => { recipe.face[m.id] = +input.value; out.textContent = (+input.value).toFixed(2); refit(); });
    input.addEventListener("dblclick", () => { input.value = 0; input.dispatchEvent(new Event("input")); });
    box.append(label);
  }
  const reset = document.createElement("button"); reset.className = "plain"; reset.textContent = "Reset face shape";
  reset.style.marginTop = "8px";
  reset.addEventListener("click", () => { recipe.face = {}; syncFaceSliders(); refit(); });
  box.append(reset);
}
function syncFaceSliders() {
  for (const input of $("face-shape").querySelectorAll("input[data-mod]")) {
    input.value = recipe.face[input.dataset.mod] ?? 0;
    input.previousElementSibling.textContent = (+input.value).toFixed(2);
  }
}
$("brow-height").addEventListener("input", () => { recipe.eyebrowHeight = +$("brow-height").value; $("v-brow-height").textContent = recipe.eyebrowHeight.toFixed(1) + " cm"; refit(); });

function setHairColor(color, keepSwatches) {
  recipe.hair.color = color;
  if (!keepSwatches) renderSwatches();
  for (const slot of Object.keys(HAIR_SLOTS)) { const e = worn.get(slot); if (e) recolor(e, slot); }
  scheduleSkin();  // a painted beard follows the hair color
}

function syncControls() {
  for (const id of SLIDERS) $(id).value = recipe.body[id];
  for (const r of RACES) $(r).value = recipe.body.race[r];
  $("tone").value = recipe.skin.tone;
  $("brow-height").value = recipe.eyebrowHeight; $("v-brow-height").textContent = recipe.eyebrowHeight.toFixed(1) + " cm";
  renderSkinColors(); syncFaceSliders();
  for (const name of ["eyeshadow", "lips", "nails"]) { $(`mk-${name}`).value = recipe.makeup[name].amount; $(`mc-${name}`).value = recipe.makeup[name].color; }
  $("name").value = recipe.name ?? "";
  showValues(); renderSwatches();
  for (const c of ITEM_SLOTS) renderTiles(c);
}

function updateStatus() {
  const body = bodyGeom.index.count / 3;
  const total = body + [...worn.values()].reduce((s, e) => s + e.item.info.triangles, 0);
  const over = total > MAX_TRIANGLES;
  $("status").innerHTML = `<span class="${over ? "bad" : ""}">${total.toLocaleString()} triangles</span> of ${MAX_TRIANGLES.toLocaleString()} allowed` +
    (over ? " — too many for So Many Rooms; pick lighter hair, beard or clothes" : "");
  for (const b of downloadButtons()) b.disabled = over;
  return total;
}

// Expressions (VRM presets built from the face shapes, same mapping as the export).
buildFaceSliders();
const exprSelect = $("expr");
for (const name of Object.keys(base.expressions)) exprSelect.append(new Option(name.replace("_", " "), name));
function applyExpression(weights) {
  for (const mesh of [bodyMesh, ...[...worn.values()].map((e) => e.mesh)]) {
    const dict = mesh.morphTargetDictionary, inf = mesh.morphTargetInfluences;
    if (!dict) continue;
    inf.fill(0);
    for (const [expr, w] of Object.entries(weights)) for (const [shape, sw] of base.expressions[expr] ?? []) {
      if (shape in dict) inf[dict[shape]] = Math.min(1, inf[dict[shape]] + w * sw);
    }
  }
}

document.querySelectorAll("#camera button[data-cam]").forEach((b) => b.addEventListener("click", () => setCamera(b.dataset.cam)));

// ---- Export / import -------------------------------------------------------------------------
async function exportVRM() {
  await base.loadMore();  // the child and old body shapes (refit when they arrived)
  const fullSkin = document.createElement("canvas"); fullSkin.width = fullSkin.height = 2048;
  await paintSkin(fullSkin, "textures/");
  const items = [...worn.entries()];
  const { heads, tails } = fitRig(base.rig, current);
  const matrices = tPose(base.rig, heads, tails);
  const bodyPosed = skinPositions(current, base.joints, base.weights, matrices);
  let lowest = Infinity;
  for (let r = 0; r < bodySource.length; r++) lowest = Math.min(lowest, bodyPosed[bodySource[r] * 3 + 1]);
  const u = base.unitsPerMeter;
  const toMeters = (a) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i += 3) { o[i] = a[i] / u; o[i + 1] = (a[i + 1] - lowest) / u; o[i + 2] = a[i + 2] / u; } return o; };
  const bones = base.rig.bones.map((b, i) => {
    const h = heads[i].clone().applyMatrix4(matrices[i]);
    return { name: b.name, parent: b.parent, head: new THREE.Vector3(h.x / u, (h.y - lowest) / u, h.z / u) };
  });
  const indices = bodyGeom.index.array;
  const bodyPos = toMeters(bodyPosed);
  const visibleIds = [...new Set(bodySource)];  // body vertices in the export (not helpers), for collider sizing
  const meshes = [{ name: "body", positions: bodyPos, normals: smoothNormals(bodyPos, bodySource, indices), source: bodySource,
    uv: base.body.uv, indices, joints: base.joints, weights: base.weights, morphs: base.faceShapes,
    image: await encodeImage(fullSkin, { jpeg: true }), alpha: "OPAQUE", doubleSided: false }];
  let springs = null;
  for (const [slot, e] of items) {
    const it = e.item;
    const pos = toMeters(skinPositions(e.fitted, it.skin.joints, it.skin.weights, matrices));
    let skin = it.skin;
    if (slot === "hair") {  // long hair gets bone chains so it sways (VRMC_springBone)
      springs = addHairSprings({ bones, hair: { positions: pos, joints: it.skin.joints, weights: it.skin.weights },
        body: { positions: bodyPos, ids: visibleIds } });
      if (springs) skin = { joints: springs.joints, weights: springs.weights };
    }
    if (index.categories[slot]?.items.find((i) => i.id === it.id)?.skirt)  // one sheet over the lap when seated
      skin = skirtSkin({ bones, positions: pos, joints: skin.joints, weights: skin.weights });
    const cut = it.info.cutout;
    const image = e.canvas ? await encodeImage(e.recolored ? e.canvas : e.url, { jpeg: !cut, maxSize: cut ? 1024 : 2048 }) : null;
    meshes.push({ name: slot === "eyes" ? "eyes" : it.id, positions: pos, normals: smoothNormals(pos, it.source, it.indices), source: it.source,
      uv: it.uv, indices: it.indices, joints: skin.joints, weights: skin.weights, morphs: it.faceShapes,
      image, color: [0.95, 0.94, 0.91, 1], tint: slot === "tongue01" ? new THREE.Color(TONGUE_TINT).toArray().concat(1) : null, alpha: cut ? "MASK" : "OPAQUE", alphaCutoff: cutoff(slot), doubleSided: slot !== "teeth_front" && slot !== "tongue01" });
  }
  const meta = { name: recipe.name || "My avatar", version: "1", authors: ["Made with VRM Avatar Maker"],
    copyrightInformation: "Made with VRM Avatar Maker from CC0 MakeHuman assets",
    licenseUrl: "https://vrm.dev/licenses/1.0/", avatarPermission: "everyone", allowExcessivelyViolentUsage: false,
    allowExcessivelySexualUsage: false, commercialUsage: "corporation", allowPoliticalOrReligiousUsage: false,
    allowAntisocialOrHateUsage: false, creditNotation: "unnecessary", allowRedistribution: true,
    modification: "allowModificationRedistribution" };
  return writeVRM({ bones, humanoid: base.rig.humanoid, meshes, expressions: base.expressions, meta, recipe, generator: "AvatarEditor",
    springBone: springs ? springBoneExtension(bones, springs.springBone) : null });
}

// The VRM with its VRMC_* extensions removed: plain glTF for tools that don't read VRM. Bones, skin,
// morph targets (named in extras.targetNames) and materials stay; the recipe stays too, so it reopens here.
function plainGLB(vrm) {
  const dv = new DataView(vrm), jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(vrm, 20, jsonLen)));
  for (const k of Object.keys(json.extensions ?? {})) if (k.startsWith("VRMC_")) delete json.extensions[k];
  if (json.extensions && !Object.keys(json.extensions).length) delete json.extensions;
  json.extensionsUsed = (json.extensionsUsed ?? []).filter((k) => !k.startsWith("VRMC_"));
  if (!json.extensionsUsed.length) delete json.extensionsUsed;
  const bytes = new TextEncoder().encode(JSON.stringify(json)), padded = (bytes.length + 3) & ~3;
  const bin = new Uint8Array(vrm, 20 + jsonLen), out = new Uint8Array(20 + padded + bin.length);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, 0x46546c67, true); odv.setUint32(4, 2, true); odv.setUint32(8, out.length, true);
  odv.setUint32(12, padded, true); odv.setUint32(16, 0x4e4f534a, true);
  out.set(bytes, 20); out.fill(0x20, 20 + bytes.length, 20 + padded); out.set(bin, 20 + padded);
  return out.buffer;
}
function downloadButtons() { return ["download", "download-glb", "panel-glb", "send"].map((id) => $(id)); }
async function download(asGLB, button) {
  const label = button.textContent;
  for (const b of downloadButtons()) b.disabled = true;
  button.textContent = "Building…";
  try {
    const vrm = await exportVRM();
    const url = URL.createObjectURL(new Blob([asGLB ? plainGLB(vrm) : vrm], { type: "model/gltf-binary" }));
    const file = (recipe.name || "avatar").replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "") || "avatar";
    Object.assign(document.createElement("a"), { href: url, download: file + (asGLB ? ".glb" : ".vrm") }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } finally { button.textContent = label; updateStatus(); }
}
$("download").addEventListener("click", () => download(false, $("download")));
for (const id of ["download-glb", "panel-glb"]) $(id).addEventListener("click", () => download(true, $(id)));

// ---- Avatar handoff (docs/handoff.md) --------------------------------------------------------
// Another site opens the maker in a popup (or an iframe) with ?host=<its origin>. The two pages talk
// with postMessage, only ever to and from that exact origin: the site may send a starting avatar, and
// "Send to <site>" hands the finished VRM straight back, no download and upload. Nothing goes through
// a server and the maker needs no login: the site saves the avatar with its own.
const HANDOFF = "avatar-handoff:";
let handoff = null;  // { peer, origin, label }
function handoffOrigin() {
  const host = new URLSearchParams(location.search).get("host");
  if (!host) return null;
  try {
    const u = new URL(host);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    return u.protocol === "https:" || (u.protocol === "http:" && local) ? u.origin : null;
  } catch { return null; }
}
function startHandoff() {
  const origin = handoffOrigin(), peer = window.opener ?? (window.parent !== window ? window.parent : null);
  if (!origin || !peer) return;
  handoff = { peer, origin, label: new URL(origin).host };
  const post = (msg, transfer = []) => { try { handoff.peer.postMessage({ version: 1, ...msg }, handoff.origin, transfer); return true; } catch { return false; } };
  handoff.post = post;
  showSend();
  let heard = false;
  window.addEventListener("message", async (e) => {
    if (e.origin !== handoff.origin || e.source !== handoff.peer || typeof e.data?.type !== "string" || !e.data.type.startsWith(HANDOFF)) return;
    heard = true;
    const msg = e.data, kind = msg.type.slice(HANDOFF.length);
    if (kind === "start") {
      if (typeof msg.label === "string" && msg.label.trim()) { handoff.label = msg.label.trim().slice(0, 40); showSend(); }
      try {
        let next = null;
        if (msg.vrm instanceof ArrayBuffer) next = checkedRecipe(readRecipe(msg.vrm));
        else if (msg.recipe) next = checkedRecipe(msg.recipe);
        if (next) { endPreview(); await applyRecipe({ ...next, name: String(msg.name ?? next.name ?? recipe.name ?? "").slice(0, 60) }); }
        else if (typeof msg.name === "string") { recipe.name = msg.name.slice(0, 60); $("name").value = recipe.name; }
      } catch (err) {
        $("status").textContent = `Your avatar from ${handoff.label} couldn't be opened here: ${err.message} Starting from this one instead.`;
      }
    } else if (kind === "received") {
      const box = $("send");
      if (msg.ok === false) { $("status").textContent = `${handoff.label} didn't take the avatar` + (msg.error ? `: ${String(msg.error).slice(0, 200)}` : "."); box.textContent = `Send to ${handoff.label}`; updateStatus(); return; }
      box.textContent = `Sent to ${handoff.label} ✓`;
      $("status").textContent = `Sent to ${handoff.label}.` + (window.opener ? " This window closes now." : "");
      if (window.opener) setTimeout(() => window.close(), 1200);
    }
  });
  // Say hello until the site answers (it may still be setting up when we're ready).
  post({ type: HANDOFF + "ready", maker: "VRM Avatar Maker", formats: ["vrm1"] });
  let tries = 0;
  const hello = setInterval(() => { if (heard || ++tries > 20) clearInterval(hello); else post({ type: HANDOFF + "ready", maker: "VRM Avatar Maker", formats: ["vrm1"] }); }, 500);
  window.addEventListener("pagehide", () => post({ type: HANDOFF + "closed" }));
}
function showSend() {
  const b = $("send");
  b.hidden = false; b.textContent = `Send to ${handoff.label}`;
  b.title = `Hands this avatar straight to ${handoff.origin} (the page that opened the maker)`;
}
$("send").addEventListener("click", async () => {
  if (!handoff) return;
  if (window.opener ? window.opener.closed : false) { $("status").textContent = `The ${handoff.label} page that opened this is gone. Download the VRM instead.`; return; }
  for (const b of downloadButtons()) b.disabled = true;
  $("send").textContent = "Building…";
  try {
    const vrm = await exportVRM();
    if (!handoff.post({ type: HANDOFF + "avatar", format: "vrm1", name: recipe.name ?? "", vrm }, [vrm])) throw new Error("couldn't reach the page");
    $("send").textContent = "Sent, waiting for an answer…";
  } catch (err) {
    $("status").textContent = `Couldn't send to ${handoff.label} (${err.message}). Download the VRM instead.`;
    $("send").textContent = `Send to ${handoff.label}`;
  } finally { updateStatus(); }
});

function readRecipe(buffer) {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("Not a VRM/GLB file");
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, dv.getUint32(12, true))));
  const found = json.asset?.extras?.avatarEditorRecipe;
  if (!found) throw new Error("This avatar was made with another tool. Only avatars made here can be reopened for editing; yours can still be used as it is. (Fix my VRM, linked below, only matters if it's over So Many Rooms' size limits.)");
  if (found.editor === "AvatarEditor") return found;
  // A Blender-pipeline recipe (pipeline/recipes/): carry over the body; parts use defaults.
  return { ...structuredClone(DEFAULT_RECIPE), name: found.name ?? "", body: { ...DEFAULT_RECIPE.body, ...found.body } };
}
async function applyRecipe(next) {
  next = { ...next };
  if ("facialHair" in next) {  // recipes from before moustache and beard were separate
    const id = next.facialHair; delete next.facialHair;
    if (id?.includes("moustache")) next.moustache ??= id; else if (id) next.beard ??= id;
  }
  if (next.teeth) delete next.teeth;
  const merged = structuredClone(DEFAULT_RECIPE);
  for (const [k, v] of Object.entries(next)) merged[k] = typeof v === "object" && v && !Array.isArray(v) ? { ...merged[k], ...v } : v;
  merged.makeup = { ...DEFAULT_RECIPE.makeup, ...(next.makeup ?? {}) };
  // Same clothing rules as clicking: an outfit or a top and bottom, never both, never nothing.
  if ((next.top || next.bottom) && !next.outfit) merged.outfit = null;
  if (merged.outfit) { merged.top = null; merged.bottom = null; }
  else { merged.top ??= index.categories.top.items[0].id; merged.bottom ??= index.categories.bottom.items[0].id; }
  recipe = merged;
  syncControls();
  composeSkin();
  await Promise.all(ITEM_SLOTS.map((c) => setSlot(c, c === "hair" ? recipe.hair.style : recipe[c])));
  refit();  // the body and face may have changed even if nothing worn did
  // Items that stayed on (same hair style as before) still take the new hair color.
  for (const slot of Object.keys(HAIR_SLOTS)) { const e = worn.get(slot); if (e) recolor(e, slot); }
  scheduleSkin();
  const eyes = worn.get("eyes"); if (eyes) await setItemTexture(eyes, index.eyeColors[recipe.eyes], "eyes");
}
$("open").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { await applyRecipe(readRecipe(await f.arrayBuffer())); }
  catch (err) { $("status").textContent = err.message; }
  e.target.value = "";
});

// ---- Start -----------------------------------------------------------------------------------
for (const slot of ALWAYS) {
  const entry = await makeWorn(slot === "eyes" ? "low-poly" : slot, slot);
  worn.set(slot, entry); avatar.add(entry.mesh);
}
const linked = await recipeFromLink(location.hash).catch(() => null);
await applyRecipe(linked ?? recipe);
$("loading").remove();
setCamera(lastCamera);  // framing for the view's real shape (known now)
base.loadMore().then(refit, () => {});  // the child and old body shapes: the body may change when they arrive
renderPresets().catch(() => $("start").remove());
startHandoff();
window.avatarEditor = { exportVRM, applyRecipe, calibratePhotos, fromPhotos, camera, controls, scene, avatar, renderer, showPreview, endPreview, get preview() { return preview; }, get recipe() { return recipe; } };  // for tests

// ---- Live preview ----------------------------------------------------------------------------
// Preview shows the exported VRM in three-vrm (lib/preview.js, loaded on first use). Changing
// anything in the panel goes back to editing; the expression menu and "Blink and talk" drive the preview.
async function showPreview() {
  const job = ++previewJob;
  $("preview").textContent = "Building…";
  try {
    const [{ createPreview }, buffer] = await Promise.all([import("../lib/preview.js"), exportVRM()]);
    if (job !== previewJob) return;
    preview ??= createPreview({ scene, camera });
    const info = await preview.show(buffer, { seated: previewSeated });
    if (job !== previewJob) { preview.hide(); return; }
    previewing = true; avatar.visible = false;
    selectedMotion = null; syncMotionButtons();
    syncPoseButtons();
    if (lastCamera === "face") setCamera("face");
    $("preview").classList.add("active"); $("poses").hidden = false;
    $("status").textContent = `Downloaded avatar preview${info.springJoints ? " with hair physics" : ""}`;
  } catch (err) {
    $("status").textContent = "Preview failed: " + err.message;
  } finally {
    $("preview").textContent = "Preview";
  }
}
function endPreview() {
  previewJob++;
  if (!previewing) return;
  previewing = false; preview?.hide(); avatar.visible = true;
  selectedMotion = null; syncMotionButtons();
  $("preview").classList.remove("active"); $("poses").hidden = true;
  if (lastCamera === "face") setCamera("face");
  updateStatus();
}
$("preview").addEventListener("click", () => previewing ? endPreview() : showPreview());
document.querySelectorAll("#poses button").forEach((b) => b.addEventListener("click", () => {
  previewSeated = b.dataset.pose === "seated";
  syncPoseButtons();
  showPreview();
}));
for (const button of motionButtons) button.addEventListener("click", async () => {
  if (motionBusy) return;
  const name = button.dataset.motion === "stand" ? null : button.dataset.motion;
  motionBusy = true; syncMotionButtons();
  try {
    if (!previewing || previewSeated) {
      previewSeated = false;
      await showPreview();
    }
    if (!previewing) return;
    await preview.setMotion(name);
    selectedMotion = name; syncMotionButtons();
    $("status").textContent = `${button.textContent} preview`;
  } catch (err) {
    $("status").textContent = "Motion preview failed: " + err.message;
  } finally { motionBusy = false; syncMotionButtons(); }
});
for (const type of ["input", "click"]) $("panel").addEventListener(type, (e) => {
  if (previewing && !e.target.closest("#expr-row, summary")) endPreview();
}, true);
$("open").addEventListener("click", endPreview);

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now(), dt = Math.min((now - last) / 1000, 0.05); last = now;
  if (previewing) {
    if (preview.update(dt, { expression: exprSelect.value, talk: $("live").checked })) {
      selectedMotion = null; syncMotionButtons();
      $("status").textContent = "Standing preview";
    }
    controls.update();
    renderer.render(scene, camera);
    return;
  }
  const t = now / 1000, weights = {};
  if (exprSelect.value) weights[exprSelect.value] = 1;
  if ($("live").checked) {
    weights.blink = t % 3.5 < 0.15 ? 1 : 0;
    const mouth = ["aa", "oh", "ee", "ou", "ih"][Math.floor(t * 6) % 5];
    weights[mouth] = (weights[mouth] ?? 0) + 0.5 + 0.5 * Math.abs(Math.sin(t * 9));
  }
  applyExpression(weights);
  controls.update();
  renderer.render(scene, camera);
});
