// Fix my VRM: make a VRM (0.x or 1.0) fit So Many Rooms' avatar budget, changing as little as possible.
//
// So Many Rooms' avatar upload check measures a
// file from its bytes: at most 20 MB, 40,000 triangles drawn, 16 materials (every entry in the
// file, used or not), images of at most 2048 px, 256 bones. measure() below follows the same rules.
// fixVRM() works on the glTF itself, so everything else in the file (expressions, look-at, spring
// bones, meta, extensions) is kept as it was:
//   1. materials no primitive uses are dropped; identical ones are merged;
//   2. if still over 16: materials that look alike (same alpha mode, sides, shader) are merged into one
//      that uses a texture atlas of their base colors (UVs remapped into the atlas cell);
//   3. images over 2048 px are scaled down;
//   4. if over 40,000 triangles: the largest meshes are simplified with meshoptimizer (vertices stay
//      the same, only triangles go, so skin weights and face shapes keep working);
//   5. if over 20 MB: images are re-encoded (opaque PNG as JPEG) and then halved, largest first.
// Bones over 256 can't be fixed here. A file whose license says it may not be modified is refused.
//
// Browser only (images go through canvas). Only .vrm/.glb files with one embedded buffer.
import { MeshoptSimplifier } from "../vendor/meshoptimizer-0.22.0/meshopt_simplifier.module.js";

export const BUDGET = { bytes: 20 * 1024 * 1024, triangles: 40000, materials: 16, texture: 2048, bones: 256 };
const TRIANGLE_TARGET = 39000;  // a little headroom
const REQUIRED_BONES = ["hips", "spine", "head", "leftUpperArm", "leftLowerArm", "leftHand", "rightUpperArm", "rightLowerArm",
  "rightHand", "leftUpperLeg", "leftLowerLeg", "leftFoot", "rightUpperLeg", "rightLowerLeg", "rightFoot"];
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);

// ---- GLB in and out --------------------------------------------------------------------------
/** { json, views: Uint8Array per bufferView (copies) }. Throws a readable message when unsupported. */
export function readGlb(buffer) {
  const dv = new DataView(buffer);
  if (buffer.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error("This isn't a VRM or GLB file.");
  const jsonLength = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)));
  let bin = new Uint8Array(0);
  const next = 20 + jsonLength;
  if (next + 8 <= buffer.byteLength) bin = new Uint8Array(buffer, next + 8, dv.getUint32(next, true));
  if (list(json.buffers).length > 1 || list(json.buffers).some((b) => b.uri !== undefined)) throw new Error("This file keeps data outside its main buffer; that isn't supported.");
  if ((json.extensionsUsed ?? []).some((e) => /draco|meshopt_compression|KHR_mesh_quantization/.test(e))) throw new Error("This file uses compressed meshes; that isn't supported yet.");
  const views = list(json.bufferViews).map((v) => bin.slice(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength));
  return { json, views };
}

/** A GLB with the views packed one after another (4-byte aligned). */
export function writeGlb(doc) {
  const { json, views } = doc;
  let offset = 0;
  json.bufferViews.forEach((v, i) => { v.buffer = 0; v.byteOffset = offset; v.byteLength = views[i].byteLength; offset += (views[i].byteLength + 3) & ~3; });
  json.buffers = [{ byteLength: offset }];
  const bin = new Uint8Array(offset);
  views.forEach((data, i) => bin.set(data, json.bufferViews[i].byteOffset));
  let text = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = (text.byteLength + 3) & ~3;
  const total = 12 + 8 + jsonPadded + 8 + offset;
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonPadded, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20); out.fill(0x20, 20 + text.byteLength, 20 + jsonPadded);
  dv.setUint32(20 + jsonPadded, offset, true); dv.setUint32(24 + jsonPadded, 0x004e4942, true);
  out.set(bin, 28 + jsonPadded);
  return out.buffer;
}

// ---- Accessors -------------------------------------------------------------------------------
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const READERS = { 5120: ["getInt8", 1], 5121: ["getUint8", 1], 5122: ["getInt16", 2], 5123: ["getUint16", 2], 5125: ["getUint32", 4], 5126: ["getFloat32", 4] };
const NORMALIZE = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

/** An accessor's values as a flat array (Float32Array, or Uint32Array for integer scalars). */
function readAccessor(doc, index) {
  const a = doc.json.accessors[index], n = COMPONENTS[a.type], [getter, size] = READERS[a.componentType];
  const float = a.componentType === 5126 || a.normalized || n > 1;
  const out = float ? new Float32Array(a.count * n) : new Uint32Array(a.count * n);
  if (a.bufferView !== undefined) {
    const view = doc.views[a.bufferView], stride = doc.json.bufferViews[a.bufferView].byteStride || n * size;
    const dv = new DataView(view.buffer, view.byteOffset, view.byteLength), base = a.byteOffset ?? 0;
    for (let i = 0; i < a.count; i++) for (let k = 0; k < n; k++) {
      let v = dv[getter](base + i * stride + k * size, true);
      if (a.normalized) v = Math.max(v / NORMALIZE[a.componentType], -1);
      out[i * n + k] = v;
    }
  }
  if (a.sparse) {
    const idx = readRaw(doc, a.sparse.indices.bufferView, a.sparse.indices.byteOffset, a.sparse.indices.componentType, a.sparse.count, 1);
    const val = readRaw(doc, a.sparse.values.bufferView, a.sparse.values.byteOffset, a.componentType, a.sparse.count, n);
    for (let i = 0; i < a.sparse.count; i++) for (let k = 0; k < n; k++) out[idx[i] * n + k] = a.normalized ? val[i * n + k] / NORMALIZE[a.componentType] : val[i * n + k];
  }
  return out;
}
function readRaw(doc, viewIndex, byteOffset = 0, componentType, count, n) {
  const view = doc.views[viewIndex], [getter, size] = READERS[componentType], out = new Float64Array(count * n);
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  for (let i = 0; i < count * n; i++) out[i] = dv[getter](byteOffset + i * size, true);
  return out;
}
/** Appends data as a new tightly packed view + accessor; returns the accessor index. */
function addAccessor(doc, array, type, componentType, extra = {}) {
  const bytes = new Uint8Array(array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength));
  doc.views.push(bytes);
  doc.json.bufferViews.push({ buffer: 0, byteLength: bytes.byteLength });
  doc.json.accessors.push({ bufferView: doc.json.bufferViews.length - 1, componentType, count: array.length / COMPONENTS[type], type, ...extra });
  return doc.json.accessors.length - 1;
}
function addImage(doc, bytes, mimeType, name) {
  doc.json.images ??= [];
  doc.views.push(bytes);
  doc.json.bufferViews.push({ buffer: 0, byteLength: bytes.byteLength });
  doc.json.images.push({ bufferView: doc.json.bufferViews.length - 1, mimeType, ...(name ? { name } : {}) });
  return doc.json.images.length - 1;
}

// ---- Measuring (same rules as So Many Rooms' check) ------------------------------------------
function primitiveTriangles(doc, p) {
  const mode = p.mode ?? 4;
  if (mode !== 4 && mode !== 5 && mode !== 6) return 0;
  const a = doc.json.accessors[p.indices ?? p.attributes.POSITION];
  return mode === 4 ? Math.floor(a.count / 3) : Math.max(0, a.count - 2);
}
/** How many nodes draw each mesh (a mesh used twice is drawn twice). */
function meshUses(json) {
  const uses = new Array(list(json.meshes).length).fill(0);
  for (const node of list(json.nodes)) if (Number.isInteger(node.mesh)) uses[node.mesh]++;
  return uses;
}
export function imageSize(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength > 24 && dv.getUint32(0) === 0x89504e47) return { width: dv.getUint32(16), height: dv.getUint32(20), mime: "image/png" };
  if (bytes.byteLength > 4 && dv.getUint16(0) === 0xffd8) {
    let o = 2;
    while (o + 9 < bytes.byteLength) {
      if (bytes[o] !== 0xff) return null;
      const m = bytes[o + 1];
      if (m === 0xff) { o++; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: dv.getUint16(o + 7), height: dv.getUint16(o + 5), mime: "image/jpeg" };
      o += 2 + dv.getUint16(o + 2);
    }
    return null;
  }
  if (bytes.byteLength > 30 && dv.getUint32(0) === 0x52494646 && dv.getUint32(8) === 0x57454250) {
    const kind = String.fromCharCode(...bytes.subarray(12, 16));
    if (kind === "VP8 ") return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff, mime: "image/webp" };
    if (kind === "VP8L") { const b = dv.getUint32(21, true); return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, mime: "image/webp" }; }
    if (kind === "VP8X") return { width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)), mime: "image/webp" };
  }
  return null;
}
const imageBytes = (doc, i) => doc.views[doc.json.images[i].bufferView];

/** { version, bytes, triangles, materials, texture, bones, over: [...], humanoid, meta } */
export function measure(doc, bytes) {
  const { json } = doc, ext = json.extensions ?? {};
  const v1 = ext.VRMC_vrm, v0 = ext.VRM, vrm = v1 ?? v0;
  const uses = meshUses(json);
  let triangles = 0;
  list(json.meshes).forEach((m, i) => { for (const p of m.primitives) triangles += primitiveTriangles(doc, p) * uses[i]; });
  let texture = 0;
  list(json.images).forEach((_, i) => { const s = imageSize(imageBytes(doc, i)); texture = Math.max(texture, s ? Math.max(s.width, s.height) : Infinity); });
  const joints = new Set(list(json.skins).flatMap((s) => list(s.joints)));
  const bones = new Map();
  if (v1) for (const [k, b] of Object.entries(v1.humanoid?.humanBones ?? {})) bones.set(k, b.node);
  else for (const b of list(v0?.humanoid?.humanBones)) bones.set(b.bone, b.node);
  const humanoid = !!vrm && REQUIRED_BONES.every((b) => Number.isInteger(bones.get(b)) && bones.get(b) < list(json.nodes).length);
  const facts = { version: v1 ? "1.0" : v0 ? "0.x" : null, bytes, triangles, materials: list(json.materials).length, texture, bones: joints.size, humanoid };
  facts.over = Object.keys(BUDGET).filter((k) => facts[k] > BUDGET[k]);
  facts.meta = license(json);
  return facts;
}

/** What the file says about changing it. canModify false: we refuse. */
export function license(json) {
  const v1 = json.extensions?.VRMC_vrm, v0 = json.extensions?.VRM;
  if (v1) {
    const m = v1.meta ?? {};
    return { name: m.name ?? null, authors: (m.authors ?? []).join(", ") || null, modification: m.modification ?? null,
      canModify: m.modification !== "prohibited", text: m.modification === "prohibited" ? "The author doesn't allow changes to this avatar." : null };
  }
  const m = v0?.meta ?? {};
  const nd = /(^|_)ND(_|$)/.test(m.licenseName ?? "");
  return { name: m.title ?? null, authors: m.author ?? null, modification: m.licenseName ?? null,
    canModify: !nd, text: nd ? `Its license (${m.licenseName}) doesn't allow changes.` : null };
}

// ---- Images through canvas -------------------------------------------------------------------
async function decode(bytes, mime) { return createImageBitmap(new Blob([bytes], { type: mime })); }
function hasAlpha(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}
async function encode(canvas, mime, quality = 0.9) {
  const blob = await new Promise((r) => canvas.toBlob(r, mime, quality));
  return new Uint8Array(await blob.arrayBuffer());
}
async function resizeImage(bytes, mime, max, { forceJpeg = false } = {}) {
  const bmp = await decode(bytes, mime);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  let out = mime === "image/webp" ? "image/webp" : mime;
  if (forceJpeg && mime === "image/png" && !hasAlpha(ctx, c.width, c.height)) out = "image/jpeg";
  return { bytes: await encode(c, out), mime: out };
}

// ---- Structure helpers -----------------------------------------------------------------------
const TEXTURE_KEYS = /Texture$/;
/** Calls fn(textureInfo) for every {index} textureInfo in a material (glTF core and extensions). */
function eachTextureInfo(material, fn) {
  const walk = (o) => { for (const [k, v] of Object.entries(o)) { if (TEXTURE_KEYS.test(k) && isObj(v) && Number.isInteger(v.index)) fn(v, k); else if (isObj(v)) walk(v); } };
  walk(material);
}
function primitivesByMaterial(json) {
  const map = new Map();
  list(json.meshes).forEach((m) => m.primitives.forEach((p) => { if (Number.isInteger(p.material)) { if (!map.has(p.material)) map.set(p.material, []); map.get(p.material).push(p); } }));
  return map;
}
/** Removes materials not in `keep` (a Set of old indices), keeping VRM 0.x materialProperties in step
 *  (three-vrm pairs them by index) and fixing material references in VRM 1.0 expressions. */
function dropMaterials(json, keepSet, mergedInto = new Map()) {
  const old = json.materials, remap = new Map();
  json.materials = old.filter((_, i) => keepSet.has(i));
  old.forEach((_, i) => { if (keepSet.has(i)) remap.set(i, json.materials.indexOf(old[i])); });
  for (const [from, to] of mergedInto) remap.set(from, remap.get(to));
  list(json.meshes).forEach((m) => m.primitives.forEach((p) => { if (Number.isInteger(p.material)) p.material = remap.get(p.material); }));
  const v0 = json.extensions?.VRM;
  if (Array.isArray(v0?.materialProperties)) v0.materialProperties = v0.materialProperties.filter((_, i) => keepSet.has(i));
  const names = new Set(json.materials.map((m) => m.name));
  for (const g of list(v0?.blendShapeMaster?.blendShapeGroups)) if (g.materialValues) g.materialValues = g.materialValues.filter((v) => names.has(v.materialName));
  const v1 = json.extensions?.VRMC_vrm;
  for (const group of [v1?.expressions?.preset, v1?.expressions?.custom]) for (const e of Object.values(group ?? {})) {
    for (const key of ["materialColorBinds", "textureTransformBinds"]) if (e[key]) {
      e[key] = e[key].filter((b) => remap.has(b.material) && keepSet.has(b.material)).map((b) => ({ ...b, material: remap.get(b.material) }));
    }
  }
}
/** Drops textures, images, samplers, accessors and views nothing refers to any more. */
function prune(doc) {
  const { json } = doc;
  // Textures in use: materials, VRM 0.x material properties and thumbnail.
  const usedTex = new Set();
  for (const m of list(json.materials)) eachTextureInfo(m, (t) => usedTex.add(t.index));
  const v0 = json.extensions?.VRM, v1 = json.extensions?.VRMC_vrm;
  for (const mp of list(v0?.materialProperties)) for (const t of Object.values(mp.textureProperties ?? {})) usedTex.add(t);
  if (Number.isInteger(v0?.meta?.texture)) usedTex.add(v0.meta.texture);
  const texRemap = new Map(); const textures = [];
  list(json.textures).forEach((t, i) => { if (usedTex.has(i)) { texRemap.set(i, textures.length); textures.push(t); } });
  json.textures = textures;
  for (const m of list(json.materials)) eachTextureInfo(m, (t) => { t.index = texRemap.get(t.index); });
  for (const mp of list(v0?.materialProperties)) for (const k of Object.keys(mp.textureProperties ?? {})) mp.textureProperties[k] = texRemap.get(mp.textureProperties[k]);
  if (Number.isInteger(v0?.meta?.texture)) v0.meta.texture = texRemap.get(v0.meta.texture);
  // Images in use: textures (incl. KHR_texture_basisu / EXT_texture_webp sources) and the 1.0 thumbnail.
  const usedImg = new Set();
  const sources = (t) => [t.source, ...Object.values(t.extensions ?? {}).map((e) => e.source)].filter(Number.isInteger);
  for (const t of json.textures) sources(t).forEach((s) => usedImg.add(s));
  if (Number.isInteger(v1?.meta?.thumbnailImage)) usedImg.add(v1.meta.thumbnailImage);
  const imgRemap = new Map(); const images = [];
  list(json.images).forEach((im, i) => { if (usedImg.has(i)) { imgRemap.set(i, images.length); images.push(im); } });
  json.images = images;
  for (const t of json.textures) { if (Number.isInteger(t.source)) t.source = imgRemap.get(t.source); for (const e of Object.values(t.extensions ?? {})) if (Number.isInteger(e.source)) e.source = imgRemap.get(e.source); }
  if (Number.isInteger(v1?.meta?.thumbnailImage)) v1.meta.thumbnailImage = imgRemap.get(v1.meta.thumbnailImage);
  // Accessors in use: meshes, skins, animations.
  const usedAcc = new Set();
  for (const m of list(json.meshes)) for (const p of m.primitives) {
    if (Number.isInteger(p.indices)) usedAcc.add(p.indices);
    Object.values(p.attributes).forEach((a) => usedAcc.add(a));
    for (const t of list(p.targets)) Object.values(t).forEach((a) => usedAcc.add(a));
  }
  for (const s of list(json.skins)) if (Number.isInteger(s.inverseBindMatrices)) usedAcc.add(s.inverseBindMatrices);
  for (const an of list(json.animations)) for (const s of list(an.samplers)) { usedAcc.add(s.input); usedAcc.add(s.output); }
  const accRemap = new Map(); const accessors = [];
  list(json.accessors).forEach((a, i) => { if (usedAcc.has(i)) { accRemap.set(i, accessors.length); accessors.push(a); } });
  json.accessors = accessors;
  for (const m of list(json.meshes)) for (const p of m.primitives) {
    if (Number.isInteger(p.indices)) p.indices = accRemap.get(p.indices);
    for (const k of Object.keys(p.attributes)) p.attributes[k] = accRemap.get(p.attributes[k]);
    for (const t of list(p.targets)) for (const k of Object.keys(t)) t[k] = accRemap.get(t[k]);
  }
  for (const s of list(json.skins)) if (Number.isInteger(s.inverseBindMatrices)) s.inverseBindMatrices = accRemap.get(s.inverseBindMatrices);
  for (const an of list(json.animations)) for (const s of list(an.samplers)) { s.input = accRemap.get(s.input); s.output = accRemap.get(s.output); }
  // Views in use: any "bufferView" anywhere (accessors, sparse, images, extensions).
  const usedView = new Set();
  const scan = (o) => { if (Array.isArray(o)) o.forEach(scan); else if (isObj(o)) for (const [k, v] of Object.entries(o)) { if (k === "bufferView" && Number.isInteger(v)) usedView.add(v); else scan(v); } };
  scan(json);
  const viewRemap = new Map(); const bufferViews = [], views = [];
  json.bufferViews.forEach((v, i) => { if (usedView.has(i)) { viewRemap.set(i, bufferViews.length); bufferViews.push(v); views.push(doc.views[i]); } });
  json.bufferViews = bufferViews; doc.views = views;
  const rewrite = (o) => { if (Array.isArray(o)) o.forEach(rewrite); else if (isObj(o)) for (const [k, v] of Object.entries(o)) { if (k === "bufferView" && Number.isInteger(v)) o[k] = viewRemap.get(v); else rewrite(v); } };
  rewrite(json);
}

// ---- 1. Unused and duplicate materials -------------------------------------------------------
function dropUnusedMaterials(doc, log) {
  const { json } = doc, n = list(json.materials).length;
  if (!n) return;
  const used = primitivesByMaterial(json);
  const props = json.extensions?.VRM?.materialProperties ?? [];
  const keep = new Set(), merged = new Map(), seen = new Map();
  for (let i = 0; i < n; i++) {
    if (!used.has(i)) continue;
    const key = JSON.stringify([{ ...json.materials[i], name: undefined }, props[i] ? { ...props[i], name: undefined } : null]);
    if (seen.has(key)) merged.set(i, seen.get(key)); else { seen.set(key, i); keep.add(i); }
  }
  if (keep.size === n) return;
  dropMaterials(json, keep, merged);
  log(`Removed ${n - keep.size} unused or duplicate material${n - keep.size === 1 ? "" : "s"} (${n} → ${keep.size}).`);
}

// ---- 2. Merging look-alike materials into a texture atlas ------------------------------------
function baseTextureOf(json, i) {
  const props = json.extensions?.VRM?.materialProperties?.[i];
  if (props?.textureProperties?._MainTex !== undefined) return props.textureProperties._MainTex;
  return json.materials[i].pbrMetallicRoughness?.baseColorTexture?.index ?? null;
}
function baseFactorOf(json, i) {
  const props = json.extensions?.VRM?.materialProperties?.[i];
  if (props?.vectorProperties?._Color) return props.vectorProperties._Color;
  return json.materials[i].pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
}
function mergeKey(json, i) {
  const m = json.materials[i], props = json.extensions?.VRM?.materialProperties?.[i];
  const mtoon = m.extensions?.VRMC_materials_mtoon;
  return JSON.stringify([m.alphaMode ?? "OPAQUE", m.alphaMode === "MASK" ? (m.alphaCutoff ?? 0.5) : null, !!m.doubleSided,
    props ? [props.shader, props.renderQueue, props.keywordMap?._ALPHABLEND_ON ?? null] : null,
    mtoon ? [mtoon.transparentWithZWrite ?? false, mtoon.renderQueueOffsetNumber ?? 0] : null, !!m.extensions?.KHR_materials_unlit]);
}
/** Whether a material can go into an atlas: base color on UV 0, no texture transform, UVs inside 0..1. */
function atlasable(doc, i, prims, uvCache) {
  const m = doc.json.materials[i];
  let ok = true;
  eachTextureInfo(m, (t) => { if ((t.texCoord ?? 0) !== 0 || t.extensions?.KHR_texture_transform) ok = false; });
  if (!ok) return false;
  for (const p of prims) {
    const uvIndex = p.attributes.TEXCOORD_0;
    if (uvIndex === undefined) { if (baseTextureOf(doc.json, i) !== null) return false; continue; }
    if (!uvCache.has(uvIndex)) uvCache.set(uvIndex, readAccessor(doc, uvIndex));
    const uv = uvCache.get(uvIndex), idx = p.indices !== undefined ? readAccessor(doc, p.indices) : null;
    const count = idx ? idx.length : uv.length / 2;
    for (let k = 0; k < count; k++) {
      const v = idx ? idx[k] : k;
      const u = uv[v * 2], w = uv[v * 2 + 1];
      if (u < -0.01 || u > 1.01 || w < -0.01 || w > 1.01) return false;
    }
  }
  return true;
}
async function mergeMaterials(doc, log) {
  const { json } = doc;
  const prims = primitivesByMaterial(json), uvCache = new Map();
  const groups = new Map();
  for (let i = 0; i < json.materials.length; i++) {
    if (!prims.has(i) || !atlasable(doc, i, prims.get(i), uvCache)) continue;
    const k = mergeKey(json, i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  // Merge the biggest groups first until within budget.
  let count = json.materials.length;
  const plans = [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
  const keep = new Set(json.materials.map((_, i) => i)), mergedInto = new Map();
  for (const g of plans) {
    if (count <= BUDGET.materials) break;
    const take = g.slice(0, Math.min(g.length, count - BUDGET.materials + 1));
    if (take.length < 2) continue;
    if (!(await buildAtlas(doc, take, prims, uvCache))) continue;
    for (const i of take.slice(1)) { keep.delete(i); mergedInto.set(i, take[0]); }
    count -= take.length - 1;
    log(`Merged ${take.length} similar materials into one with a texture atlas.`);
  }
  if (mergedInto.size) dropMaterials(json, keep, mergedInto);
  return count;
}
async function buildAtlas(doc, members, prims, uvCache) {
  const { json } = doc;
  const grid = Math.ceil(Math.sqrt(members.length)), size = 2048, cell = Math.floor(size / grid), pad = 4;
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, size, size);
  const cells = new Map();
  for (const [slot, i] of members.entries()) {
    const x = (slot % grid) * cell, y = Math.floor(slot / grid) * cell;
    cells.set(i, { x: x + pad, y: y + pad, s: cell - 2 * pad });
    const tex = baseTextureOf(json, i), [r, g, b, a] = baseFactorOf(json, i);
    // The cell: the base texture (stretched to fill, padding repeats the edge) times the base color factor.
    const tmp = document.createElement("canvas"); tmp.width = tmp.height = cell;
    const t = tmp.getContext("2d");
    if (tex !== null && Number.isInteger(json.textures[tex]?.source)) {
      const im = json.images[json.textures[tex].source];
      const bytes = doc.views[im.bufferView], mime = im.mimeType ?? imageSize(bytes)?.mime ?? "image/png";
      const bmp = await decode(bytes, mime);
      t.drawImage(bmp, 0, 0, cell, cell);
    } else { t.fillStyle = "#ffffff"; t.fillRect(0, 0, cell, cell); }
    if (r !== 1 || g !== 1 || b !== 1) {
      t.globalCompositeOperation = "multiply";
      t.fillStyle = `rgb(${Math.round(Math.pow(r, 1 / 2.2) * 255)},${Math.round(Math.pow(g, 1 / 2.2) * 255)},${Math.round(Math.pow(b, 1 / 2.2) * 255)})`;
      t.fillRect(0, 0, cell, cell);
      t.globalCompositeOperation = "destination-in"; // keep the texture's alpha
      if (tex !== null) { const im = json.images[json.textures[tex].source]; t.drawImage(await decode(doc.views[im.bufferView], im.mimeType ?? "image/png"), 0, 0, cell, cell); }
      t.globalCompositeOperation = "source-over";
    }
    if (a < 1) { const d = t.getImageData(0, 0, cell, cell); for (let k = 3; k < d.data.length; k += 4) d.data[k] *= a; t.putImageData(d, 0, 0); }
    ctx.clearRect(x, y, cell, cell);
    ctx.drawImage(tmp, x, y, cell, cell);                                  // padding: the stretched edges
    ctx.drawImage(tmp, 0, 0, cell, cell, x + pad, y + pad, cell - 2 * pad, cell - 2 * pad);
  }
  // Remap UVs: one copy per UV accessor, vertices moved into their material's cell.
  const copies = new Map(), owner = new Map();
  for (const i of members) for (const p of prims.get(i)) {
    const uvIndex = p.attributes.TEXCOORD_0;
    if (uvIndex === undefined) continue;
    if (!copies.has(uvIndex)) copies.set(uvIndex, Float32Array.from(uvCache.get(uvIndex) ?? readAccessor(doc, uvIndex)));
    const src = uvCache.get(uvIndex), dst = copies.get(uvIndex), c = cells.get(i);
    const idx = p.indices !== undefined ? readAccessor(doc, p.indices) : null;
    const n = idx ? idx.length : src.length / 2;
    for (let k = 0; k < n; k++) {
      const v = idx ? idx[k] : k, key = `${uvIndex}:${v}`;
      if (owner.has(key) && owner.get(key) !== i) return false;  // a vertex shared by two materials: can't split it
      owner.set(key, i);
      dst[v * 2] = (c.x + src[v * 2] * c.s) / size;
      dst[v * 2 + 1] = (c.y + src[v * 2 + 1] * c.s) / size;
    }
  }
  const newUv = new Map();
  for (const [old, data] of copies) newUv.set(old, addAccessor(doc, data, "VEC2", 5126));
  for (const m of json.meshes) for (const p of m.primitives) if (newUv.has(p.attributes.TEXCOORD_0)) p.attributes.TEXCOORD_0 = newUv.get(p.attributes.TEXCOORD_0);
  // The merged material: the first member, using the atlas for base (and shade) color; other textures dropped.
  const atlasImage = addImage(doc, await encode(canvas, "image/png"), "image/png", "atlas");
  json.samplers ??= []; json.textures ??= [];
  const sampler = json.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }) - 1;  // clamp: no bleeding into the next cell
  const atlasTex = json.textures.push({ source: atlasImage, sampler }) - 1;
  const first = members[0], m = json.materials[first];
  m.name = (m.name ?? "material") + " (merged)";
  m.pbrMetallicRoughness = { ...(m.pbrMetallicRoughness ?? {}), baseColorTexture: { index: atlasTex }, baseColorFactor: [1, 1, 1, 1] };
  delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture; delete m.pbrMetallicRoughness.metallicRoughnessTexture;
  const mtoon = m.extensions?.VRMC_materials_mtoon;
  if (mtoon) {
    for (const k of ["shadingShiftTexture", "matcapTexture", "rimMultiplyTexture", "outlineWidthMultiplyTexture", "uvAnimationMaskTexture"]) delete mtoon[k];
    if (mtoon.shadeMultiplyTexture) mtoon.shadeMultiplyTexture = { index: atlasTex };
  }
  const props = json.extensions?.VRM?.materialProperties?.[first];
  if (props) {
    props.name = m.name;
    const had = props.textureProperties ?? {};
    props.textureProperties = { _MainTex: atlasTex, ...(had._ShadeTexture !== undefined ? { _ShadeTexture: atlasTex } : {}) };
    props.vectorProperties = { ...(props.vectorProperties ?? {}), _Color: [1, 1, 1, 1], _MainTex: [0, 0, 1, 1], _ShadeTexture: [0, 0, 1, 1] };
  }
  return true;
}

// ---- 3 and 5. Images -------------------------------------------------------------------------
async function shrinkImages(doc, max, log, opts = {}) {
  let changed = 0;
  for (const im of list(doc.json.images)) {
    const bytes = doc.views[im.bufferView], s = imageSize(bytes);
    if (!s) continue;
    const big = Math.max(s.width, s.height) > max;
    if (!big && !opts.forceJpeg) continue;
    const r = await resizeImage(bytes, im.mimeType ?? s.mime, max, opts);
    if (!big && r.bytes.byteLength >= bytes.byteLength) continue;
    doc.views[im.bufferView] = r.bytes; im.mimeType = r.mime; changed++;
  }
  if (changed) log(opts.forceJpeg ? `Re-encoded ${changed} image${changed === 1 ? "" : "s"} to save space.` : `Scaled ${changed} image${changed === 1 ? "" : "s"} down to ${max} px.`);
}

// ---- 4. Triangles ----------------------------------------------------------------------------
async function simplifyMeshes(doc, log) {
  await MeshoptSimplifier.ready;
  const { json } = doc, uses = meshUses(json);
  const prims = [];
  json.meshes.forEach((m, mi) => m.primitives.forEach((p) => {
    if ((p.mode ?? 4) !== 4 || !uses[mi]) return;
    prims.push({ p, uses: uses[mi], tris: primitiveTriangles(doc, p) });
  }));
  const total = () => prims.reduce((s, x) => s + x.tris * x.uses, 0) + otherTriangles(doc, prims);
  const before = total();
  // Small parts (eyes, teeth, lashes) stay; larger ones are reduced in proportion.
  for (let pass = 0; pass < 4 && total() > TRIANGLE_TARGET; pass++) {
    const big = prims.filter((x) => x.tris > 400);
    const bigTris = big.reduce((s, x) => s + x.tris * x.uses, 0);
    const ratio = Math.max(0.05, 1 - (total() - TRIANGLE_TARGET) / bigTris) * (pass ? 0.97 : 1);
    for (const x of big) {
      const positions = readAccessor(doc, x.p.attributes.POSITION);
      const indices = x.p.indices !== undefined ? Uint32Array.from(readAccessor(doc, x.p.indices)) : Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
      const target = Math.max(3, Math.floor(indices.length * ratio / 3) * 3);
      let out = indices;
      for (const error of [0.01, 0.03, 0.08, 0.2]) {
        [out] = MeshoptSimplifier.simplify(indices, positions, 3, target, error, []);
        if (out.length <= target * 1.05) break;
      }
      if (out.length >= indices.length) continue;
      const maxIndex = out.reduce((m, v) => Math.max(m, v), 0);
      x.p.indices = maxIndex < 65536 ? addAccessor(doc, Uint16Array.from(out), "SCALAR", 5123) : addAccessor(doc, out, "SCALAR", 5125);
      x.tris = out.length / 3;
    }
  }
  const after = total();
  if (after < before) log(`Simplified the meshes: ${before.toLocaleString()} → ${after.toLocaleString()} triangles.`);
}
function otherTriangles(doc, prims) {
  const counted = new Set(prims.map((x) => x.p)), uses = meshUses(doc.json);
  let t = 0;
  doc.json.meshes.forEach((m, mi) => m.primitives.forEach((p) => { if (!counted.has(p)) t += primitiveTriangles(doc, p) * uses[mi]; }));
  return t;
}

// ---- The whole fix ---------------------------------------------------------------------------
/** Returns { buffer, before, after, steps } — buffer null if nothing could or needed to be done. */
export async function fixVRM(input, { onStep = () => {} } = {}) {
  const doc = readGlb(input);
  const before = measure(doc, input.byteLength);
  const steps = [];
  const log = (s) => { steps.push(s); onStep(s); };
  if (!before.humanoid) throw new Error("This file has no VRM humanoid, so it can't be an avatar.");
  if (!before.meta.canModify) return { buffer: null, before, after: before, steps: [before.meta.text] };
  if (!before.over.length) return { buffer: null, before, after: before, steps: ["Nothing to fix: it already fits."] };
  dropUnusedMaterials(doc, log);
  if (doc.json.materials.length > BUDGET.materials) await mergeMaterials(doc, log);
  await shrinkImages(doc, BUDGET.texture, log);
  if (measure(doc, 0).triangles > BUDGET.triangles) await simplifyMeshes(doc, log);
  prune(doc);
  let buffer = writeGlb(doc);
  for (const [max, opts] of [[BUDGET.texture, { forceJpeg: true }], [1024, { forceJpeg: true }], [512, { forceJpeg: true }]]) {
    if (buffer.byteLength <= BUDGET.bytes) break;
    await shrinkImages(doc, max, log, opts);
    buffer = writeGlb(doc);
  }
  const after = measure(readGlb(buffer), buffer.byteLength);
  if (after.bones > BUDGET.bones) log(`It has ${after.bones} bones (limit ${BUDGET.bones}); that can't be fixed here.`);
  return { buffer, before, after, steps };
}
