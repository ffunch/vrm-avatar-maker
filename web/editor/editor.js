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
function setCamera(which) {
  lastCamera = which;
  const head = previewing ? preview.head() : null;  // the preview may be seated: aim at its real head
  const fh = head ? head.y + 0.06 : faceHeight, fz = head ? head.z : 0;
  const k = camera.aspect < 1.2 ? 1.2 : 1;  // a narrow view (phone upright): a little farther, so the head clears the buttons
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
function refit() {
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
    fitItem(entry.item, current, entry.fitted);
    if (slot === "eyebrows") raiseAlongSkin(entry, normals, recipe.eyebrowHeight / 10);
    if (INFLATE[slot]) inflate(entry, INFLATE[slot]);
  }
  if (worn.has("top") && worn.has("bottom")) tuck(worn.get("bottom"), worn.get("top"));
  let tucked = null;
  for (const slot of ["bottom", "outfit"]) {  // trousers go into tall boots (never skirts, dresses or robes)
    const e = worn.get(slot);
    if (e && worn.has("shoes") && !index.categories[slot]?.items.find((i) => i.id === e.item.id)?.skirt)
      tucked = tuckIntoBoots(e, worn.get("shoes"), normals) ?? tucked;
  }
  hideSkinInBoots(tucked);
  hatHair(worn.get("hair"), worn.get("hat"));
  for (const entry of worn.values()) {
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
  const found = JSON.parse(text);
  if (!found || typeof found !== "object") return null;
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
  $("download").disabled = over;
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

$("download").addEventListener("click", async () => {
  $("download").disabled = true; $("download").textContent = "Building…";
  try {
    const url = URL.createObjectURL(new Blob([await exportVRM()], { type: "model/gltf-binary" }));
    const file = (recipe.name || "avatar").replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "") || "avatar";
    Object.assign(document.createElement("a"), { href: url, download: file + ".vrm" }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } finally { $("download").textContent = "Download VRM"; updateStatus(); }
});

function readRecipe(buffer) {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("Not a VRM/GLB file");
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, dv.getUint32(12, true))));
  const found = json.asset?.extras?.avatarEditorRecipe;
  if (!found) throw new Error("This VRM wasn't made with this editor, so it can't be edited here. Too big for So Many Rooms? Try Fix my VRM (link below).");
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
window.avatarEditor = { exportVRM, applyRecipe, camera, controls, scene, avatar, renderer, showPreview, endPreview, get preview() { return preview; }, get recipe() { return recipe; } };  // for tests

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
    if (lastCamera === "face") setCamera("face");
    $("preview").classList.add("active"); $("poses").hidden = false;
    $("status").textContent = `Preview of the download: ${info.springJoints ? "hair physics, " : ""}eyes follow you, blinking. Change anything to edit again.`;
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
  $("preview").classList.remove("active"); $("poses").hidden = true;
  if (lastCamera === "face") setCamera("face");
  updateStatus();
}
$("preview").addEventListener("click", () => previewing ? endPreview() : showPreview());
document.querySelectorAll("#poses button").forEach((b) => b.addEventListener("click", () => {
  previewSeated = b.dataset.pose === "seated";
  document.querySelectorAll("#poses button").forEach((x) => x.classList.toggle("on", x === b));
  showPreview();
}));
for (const type of ["input", "click"]) $("panel").addEventListener(type, (e) => {
  if (previewing && !e.target.closest("#expr-row, summary")) endPreview();
}, true);
$("open").addEventListener("click", endPreview);

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now(), dt = Math.min((now - last) / 1000, 0.05); last = now;
  if (previewing) {
    preview.update(dt, { expression: exprSelect.value, talk: $("live").checked });
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
