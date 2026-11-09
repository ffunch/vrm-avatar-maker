// Avatar core for the browser editor: loads the assets from pipeline/export_web_assets.py, morphs the
// MakeHuman base mesh from the body sliders, and fits worn items to it (.mhclo).
import { itemSkin, itemDeltas } from "./vrm-export.js";

const TYPED = { f: Float32Array, I: Uint32Array, h: Int16Array, H: Uint16Array };
export const view = (buffer, [offset, count, kind]) => new TYPED[kind](buffer, offset, count);

/** fetch() with a few retries: a busy server can refuse some of the many parallel requests. */
export async function fetchRetry(url, tries = 3) {
  for (let i = 1; ; i++) {
    try { const r = await fetch(url); if (r.ok) return r; throw new Error(`${r.status} ${url}`); }
    catch (err) { if (i >= tries) throw err; await new Promise((res) => setTimeout(res, 300 * i)); }
  }
}

/**
 * A .bin from export_web_assets.py: fetched as <url>.gz and unpacked here (DecompressionStream), so any
 * static host works. If the server already undid the gzip (Content-Encoding), the bytes are used as is.
 */
export async function fetchBin(url) {
  const bytes = await (await fetchRetry(url + ".gz")).arrayBuffer();
  const head = new Uint8Array(bytes, 0, 2);
  if (head[0] !== 0x1f || head[1] !== 0x8b) return bytes;
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

/**
 * Undo write_bin's byte planes in place: "planes" (all low bytes, then all high bytes), and "xyz"
 * (the same, with the 16-bit values ordered all x, all y, all z; back to x,y,z per vertex).
 */
export function unplane(buffer, layout) {
  for (const [offset, count, , flag] of Object.values(layout)) {
    if (flag !== "planes" && flag !== "xyz") continue;
    const u8 = new Uint8Array(buffer, offset, count * 2), copy = u8.slice();
    if (flag === "planes") for (let i = 0; i < count; i++) { u8[i * 2] = copy[i]; u8[i * 2 + 1] = copy[count + i]; }
    else {
      const n = count / 3;
      for (let k = 0; k < 3; k++) for (let i = 0; i < n; i++) {
        const from = k * n + i, to = (i * 3 + k) * 2;
        u8[to] = copy[from]; u8[to + 1] = copy[count + from];
      }
    }
  }
  return buffer;
}

/** A sparse target: vertex indices (from uint16 gaps) and int16 offsets. */
function sparseTarget(buffer, layout, name) {
  const gaps = view(buffer, layout[name + ":g"]), idx = new Uint32Array(gaps.length);
  for (let i = 0, v = -1; i < gaps.length; i++) idx[i] = v += gaps[i];
  return { idx, d: view(buffer, layout[name + ":d"]) };
}

export async function loadBase(A) {
  const getJSON = (p) => fetchRetry(A + p).then((r) => r.json());
  const getBin = (p) => fetchBin(A + p);
  const [baseInfo, baseBin, macroInfo, macroBin, index, rig, skinBin, faceInfo, faceBin, modInfo, modBin] = await Promise.all([
    getJSON("base.json"), getBin("base.bin"), getJSON("macros.json"), getBin("macros.bin"), getJSON("index.json"),
    getJSON("rig.json"), getBin("skin.bin"), getJSON("faces.json"), getBin("faces.bin"),
    getJSON("modifiers.json"), getBin("modifiers.bin"),
  ]);
  const N = baseInfo.vertexCount;
  for (const [bin, info] of [[baseBin, baseInfo], [macroBin, macroInfo], [skinBin, rig], [faceBin, faceInfo], [modBin, modInfo]]) unplane(bin, info.layout);
  const targets = {};
  for (const name of Object.keys(macroInfo.targets)) targets[name] = sparseTarget(macroBin, macroInfo.layout, name);
  for (const name of Object.keys(modInfo.targets)) targets[name] = sparseTarget(modBin, modInfo.layout, name);
  // Face shapes as dense per-base-vertex offsets in meters (the face isn't moved by the T-pose).
  const faceShapes = {};
  for (const name of Object.keys(faceInfo.targets)) {
    const { idx, d } = sparseTarget(faceBin, faceInfo.layout, name);
    const dense = new Float32Array(N * 3), s = faceInfo.quant / baseInfo.unitsPerMeter;
    for (let i = 0; i < idx.length; i++) for (let k = 0; k < 3; k++) dense[idx[i] * 3 + k] = d[i * 3 + k] * s;
    faceShapes[name] = dense;
  }
  return {
    A, N, index, rig, targets, faceShapes, modifiers: modInfo.modifiers, expressions: faceInfo.expressions, unitsPerMeter: baseInfo.unitsPerMeter,
    macro: macroInfo.macro, quant: macroInfo.quant,
    rest: view(baseBin, baseInfo.layout.positions),
    body: { source: view(baseBin, baseInfo.layout.source), uv: view(baseBin, baseInfo.layout.uv), indices: view(baseBin, baseInfo.layout.indices) },
    joints: view(skinBin, rig.layout.joints), weights: view(skinBin, rig.layout.weights),
  };
}

// ---- Body: MakeHuman macro sliders (port of MPFB TargetService.calculate_target_stack_from_macro_info_dict)
function components(base, name, value) {
  const out = [];
  for (const p of base.macro.macrotargets[name].parts) {
    if (value > p.lowest && value < p.highest) {
      const pct = (value - p.lowest) / (p.highest - p.lowest);
      if (p.low) out.push([p.low, 1 - pct]);
      if (p.high) out.push([p.high, pct]);
    }
  }
  return out;
}

export function targetStack(base, body) {
  const c = Object.fromEntries(["gender", "age", "muscle", "weight"].map((k) => [k, components(base, k, body[k])]));
  const race = { ...body.race };
  const sum = Object.values(race).reduce((a, b) => a + b, 0) || 1;
  const stack = [];
  for (const [r, rw] of Object.entries(race)) {
    if (rw / sum <= 0.0001) continue;
    for (const [a, aw] of c.age) for (const [g, gw] of c.gender) stack.push([`${r}-${g}-${a}`, rw / sum * gw * aw]);
  }
  for (const [g, gw] of c.gender) for (const [a, aw] of c.age) for (const [mu, mw] of c.muscle) for (const [we, ww] of c.weight)
    stack.push([`universal-${g}-${a}-${mu}-${we}`, gw * aw * mw * ww]);
  return stack.filter(([name, w]) => w > 0.01 && base.targets[name]);  // (baby targets aren't shipped)
}

/** Face-shape sliders (pipeline/modifiers.json) as [target, weight] pairs: decr below 0, incr above. */
export function modifierStack(base, face = {}) {
  const stack = [];
  for (const m of base.modifiers) {
    const v = face[m.id] ?? 0;
    for (const t of (v < 0 ? m.decr : m.incr) ?? []) if (Math.abs(v) > 0.001) stack.push([t, Math.abs(v)]);
  }
  return stack;
}

/** Base-mesh positions (decimeters, y up) for the body and face settings; writes into `out` if given. */
export function morphBody(base, body, out = new Float32Array(base.N * 3), face = {}) {
  out.set(base.rest);
  for (const [name, w] of [...targetStack(base, body), ...modifierStack(base, face)]) {
    const { idx, d } = base.targets[name], s = w * base.quant;
    for (let i = 0; i < idx.length; i++) {
      const v = idx[i] * 3;
      out[v] += d[i * 3] * s; out[v + 1] += d[i * 3 + 1] * s; out[v + 2] += d[i * 3 + 2] * s;
    }
  }
  return out;
}

// ---- Items -----------------------------------------------------------------------------------
const itemCache = new Map();

/** Loads an item's mesh and fitting data (cached): render mesh, .mhclo fit, skin weights, face shapes. */
export function loadItem(base, id) {
  if (!itemCache.has(id)) itemCache.set(id, (async () => {
    const [info, bin] = await Promise.all([
      fetchRetry(`${base.A}items/${id}.json`).then((r) => r.json()), fetchBin(`${base.A}items/${id}.bin`),
    ]);
    const L = info.layout;
    unplane(bin, L);
    const item = { id, info, source: view(bin, L.source), uv: view(bin, L.uv), indices: view(bin, L.indices),
      refs: view(bin, L.refs), weights: view(bin, L.weights), offsets: view(bin, L.offsets), hides: view(bin, L.delete) };
    item.skin = itemSkin(base.joints, base.weights, item.refs, item.weights);
    item.faceShapes = Object.fromEntries(Object.entries(base.faceShapes).map(([k, d]) => [k, itemDeltas(d, item.refs, item.weights)]));
    return item;
  })());
  itemCache.get(id).catch(() => itemCache.delete(id));  // don't cache a failure
  return itemCache.get(id);
}

/** MakeHuman .mhclo fitting: each vertex = weighted sum of 3 base vertices + offset scaled by body size. */
export function fitItem(item, current, out = new Float32Array(item.info.vertexCount * 3)) {
  const sc = item.info.scale;
  const axisScale = (axis, k) => sc[axis] ? Math.abs(current[sc[axis][0] * 3 + k] - current[sc[axis][1] * 3 + k]) / sc[axis][2] : 1;
  const s = [axisScale("x", 0), axisScale("y", 1), axisScale("z", 2)];
  const { refs, weights: w, offsets: o } = item;
  for (let i = 0; i < item.info.vertexCount; i++) {
    const r0 = refs[i * 3] * 3, r1 = refs[i * 3 + 1] * 3, r2 = refs[i * 3 + 2] * 3;
    const w0 = w[i * 3], w1 = w[i * 3 + 1], w2 = w[i * 3 + 2];
    for (let k = 0; k < 3; k++) out[i * 3 + k] = w0 * current[r0 + k] + w1 * current[r1 + k] + w2 * current[r2 + k] + o[i * 3 + k] * s[k];
  }
  return out;
}

/** Body triangles not hidden by the worn items (.mhclo delete_verts), like MPFB's bake_masks. */
export function visibleBodyIndices(base, items) {
  const hidden = new Uint8Array(base.N);
  for (const it of items) for (const v of it.hides) hidden[v] = 1;
  const { source, indices } = base.body, out = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    if (!hidden[source[a]] && !hidden[source[b]] && !hidden[source[c]]) out.push(a, b, c);
  }
  return new Uint32Array(out);
}

// ---- Skin texture age bucket -------------------------------------------------------------------
// MakeHuman age slider: 0.1875 = 11 y, 0.5 = 25 y, 1 = 90 y.
export const ageYears = (v) => Math.round(v < 0.1875 ? 1 + v / 0.1875 * 10 : v < 0.5 ? 11 + (v - 0.1875) / 0.3125 * 14 : 25 + (v - 0.5) / 0.5 * 65);
export const skinBucket = (body) => `${ageYears(body.age) < 38 ? "young" : ageYears(body.age) < 60 ? "middleage" : "old"}`;
export const skinGender = (body) => (body.gender >= 0.5 ? "male" : "female");
