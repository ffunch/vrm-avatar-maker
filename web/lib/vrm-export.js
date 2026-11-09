// Browser-side avatar export for the spike: rig fitting, T-pose and a VRM 1.0 (.vrm / GLB) writer.
// No Blender involved. Inputs come from pipeline/export_web_assets.py (rig.json, skin.bin, items).
//
//  fitRig(rig, current)              joint positions from the morphed base mesh (MPFB "joint-*" cubes)
//  tPose(rig, heads, tails)          per-bone matrices that turn MakeHuman's A-pose into a T-pose
//  skinPositions(...)                linear blend skinning on the CPU, to bake the T-pose into the mesh
//  itemSkin(...)                     skin weights for a worn item, interpolated through its .mhclo refs
//  itemDeltas(...)                   a base-mesh face shape carried onto an item through its .mhclo refs
//  writeVRM(...)                     glTF 2.0 binary with VRMC_vrm 1.0, morph targets, expressions, eye look-at
//                                    and (optionally) VRMC_springBone hair physics from springs.js
import * as THREE from "three";

// ---- Rig -------------------------------------------------------------------------------------
function point(rig, current, end) {
  const list = end.cube ? rig.cubes[end.cube] : end.mean;
  const p = new THREE.Vector3();
  for (const i of list) { p.x += current[i * 3]; p.y += current[i * 3 + 1]; p.z += current[i * 3 + 2]; }
  return p.divideScalar(list.length);
}

export function fitRig(rig, current) {
  return { heads: rig.bones.map((b) => point(rig, current, b.head)), tails: rig.bones.map((b) => point(rig, current, b.tail)) };
}

// MakeHuman's rest pose is an A-pose; VRM wants a T-pose, and So Many Rooms poses bones relative to
// rest. Aim upper arm, forearm and hand along +-X (left is +X in MakeHuman), like build_avatar.py does
// with Damped Track constraints. Returns a world matrix per bone (identity for untouched bones).
export function tPose(rig, heads, tails) {
  const matrices = rig.bones.map(() => new THREE.Matrix4());
  const index = Object.fromEntries(rig.bones.map((b, i) => [b.name, i]));
  for (const [side, sign] of [["l", 1], ["r", -1]]) {
    for (const part of ["upperarm", "lowerarm", "hand"]) {
      const i = index[`${part}_${side}`];
      const h = heads[i].clone().applyMatrix4(matrices[i]);
      const t = tails[i].clone().applyMatrix4(matrices[i]);
      const q = new THREE.Quaternion().setFromUnitVectors(t.sub(h).normalize(), new THREE.Vector3(sign, 0, 0));
      const turn = new THREE.Matrix4().makeTranslation(h.x, h.y, h.z)
        .multiply(new THREE.Matrix4().makeRotationFromQuaternion(q))
        .multiply(new THREE.Matrix4().makeTranslation(-h.x, -h.y, -h.z));
      const moved = rig.bones.map(() => false);
      rig.bones.forEach((b, j) => { moved[j] = j === i || (b.parent >= 0 && moved[b.parent]); });
      moved.forEach((m, j) => { if (m) matrices[j].premultiply(turn); });
    }
  }
  return matrices;
}

export function skinPositions(positions, joints, weights, matrices) {
  const out = new Float32Array(positions.length);
  const e = matrices.map((m) => m.elements);
  for (let v = 0; v < positions.length / 3; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    let ox = 0, oy = 0, oz = 0;
    for (let k = 0; k < 4; k++) {
      const w = weights[v * 4 + k]; if (!w) continue;
      const m = e[joints[v * 4 + k]];
      ox += w * (m[0] * x + m[4] * y + m[8] * z + m[12]);
      oy += w * (m[1] * x + m[5] * y + m[9] * z + m[13]);
      oz += w * (m[2] * x + m[6] * y + m[10] * z + m[14]);
    }
    out[v * 3] = ox; out[v * 3 + 1] = oy; out[v * 3 + 2] = oz;
  }
  return out;
}

// Same idea as MPFB ClothesService.interpolate_weights: an item vertex gets the bone weights of its
// three base vertices, scaled by the .mhclo weights; then keep the top 4 and renormalize.
export function itemSkin(baseJoints, baseWeights, refs, refWeights) {
  const n = refs.length / 3, joints = new Uint16Array(n * 4), weights = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    const acc = new Map();
    for (let r = 0; r < 3; r++) {
      const w = refWeights[v * 3 + r], b = refs[v * 3 + r];
      if (!w) continue;
      for (let k = 0; k < 4; k++) {
        const bw = baseWeights[b * 4 + k]; if (!bw) continue;
        const j = baseJoints[b * 4 + k]; acc.set(j, (acc.get(j) ?? 0) + bw * w);
      }
    }
    // .mhclo weights can be negative (extrapolating refs); like MPFB, keep only real influences.
    const top = [...acc].filter(([, w]) => w > 0.001).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const total = top.reduce((s, [, w]) => s + w, 0) || 1;
    top.forEach(([j, w], k) => { joints[v * 4 + k] = j; weights[v * 4 + k] = w / total; });
    if (!top.length) weights[v * 4] = 1;  // falls back to bone 0 (Root)
  }
  return { joints, weights };
}

// Like MPFB FaceService.interpolate_targets: an item vertex moves by the weighted sum of its three
// base vertices' offsets (no offset scaling).
export function itemDeltas(baseDelta, refs, refWeights) {
  const n = refs.length / 3, out = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) for (let r = 0; r < 3; r++) {
    const w = refWeights[v * 3 + r], b = refs[v * 3 + r] * 3;
    if (w) for (let k = 0; k < 3; k++) out[v * 3 + k] += w * baseDelta[b + k];
  }
  return out;
}

// Smooth normals on source vertices (so UV seams don't show), for render triangles that index
// render vertices; `source` maps render vertex -> source vertex.
export function smoothNormals(positions, source, indices) {
  const acc = new Float32Array(positions.length);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < indices.length; i += 3) {
    const ia = source[indices[i]] * 3, ib = source[indices[i + 1]] * 3, ic = source[indices[i + 2]] * 3;
    a.fromArray(positions, ia); b.fromArray(positions, ib).sub(a); c.fromArray(positions, ic).sub(a); b.cross(c);
    for (const v of [ia, ib, ic]) { acc[v] += b.x; acc[v + 1] += b.y; acc[v + 2] += b.z; }
  }
  for (let v = 0; v < acc.length; v += 3) {
    const l = Math.hypot(acc[v], acc[v + 1], acc[v + 2]);
    if (l > 0) { acc[v] /= l; acc[v + 1] /= l; acc[v + 2] /= l; } else acc[v + 1] = 1;
  }
  return acc;
}

// ---- Images ----------------------------------------------------------------------------------
// Opaque textures become JPEG (much smaller); cut-outs keep PNG for the alpha. Max 2048 px. Always
// re-encoded: some source PNGs carry color-space chunks that the glTF validator flags.
// `source` is a URL or anything createImageBitmap takes (a canvas with recolored hair, makeup, ...).
export async function encodeImage(source, { jpeg, maxSize = 2048 }) {
  const blob = typeof source === "string" ? await (await fetch(source)).blob() : null;
  const bitmap = await createImageBitmap(blob ?? source);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const type = jpeg ? "image/jpeg" : "image/png";
  const out = await canvas.convertToBlob({ type, quality: 0.85 });
  return { bytes: new Uint8Array(await out.arrayBuffer()), mimeType: type };
}

// ---- GLB / VRM writer ------------------------------------------------------------------------
const FLOAT = 5126, UINT = 5125, USHORT = 5123;

class GlbBuilder {
  constructor(json) { this.json = json; this.parts = []; this.length = 0; }
  view(bytes, target) {
    const pad = -this.length % 4 & 3;
    if (pad) { this.parts.push(new Uint8Array(pad)); this.length += pad; }
    const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.parts.push(u8);
    const view = { buffer: 0, byteOffset: this.length, byteLength: u8.byteLength };
    if (target) view.target = target;
    this.length += u8.byteLength;
    return this.json.bufferViews.push(view) - 1;
  }
  accessor(array, type, componentType, { target, minmax } = {}) {
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    const acc = { bufferView: this.view(array, target), componentType, count: array.length / size, type };
    if (minmax) {
      acc.min = Array(size).fill(Infinity); acc.max = Array(size).fill(-Infinity);
      for (let i = 0; i < array.length; i++) {
        const k = i % size; acc.min[k] = Math.min(acc.min[k], array[i]); acc.max[k] = Math.max(acc.max[k], array[i]);
      }
    }
    return this.json.accessors.push(acc) - 1;
  }
  // VEC3 float accessor stored sparsely: only the listed (strictly increasing) indices are non-zero.
  sparseVec3(count, indices, values) {
    const zeros = indices.length < count ? [0] : [];
    const min = [0, 1, 2].map((k) => Math.min(...zeros, ...values.filter((_, i) => i % 3 === k)));
    const max = [0, 1, 2].map((k) => Math.max(...zeros, ...values.filter((_, i) => i % 3 === k)));
    return this.json.accessors.push({ componentType: FLOAT, count, type: "VEC3", min, max, sparse: { count: indices.length,
      indices: { bufferView: this.view(indices), componentType: UINT }, values: { bufferView: this.view(values) } } }) - 1;
  }
  toArrayBuffer() {
    this.json.buffers = [{ byteLength: this.length }];
    const enc = new TextEncoder();
    let jsonBytes = enc.encode(JSON.stringify(this.json));
    const jsonPad = -jsonBytes.length % 4 & 3, binPad = -this.length % 4 & 3;
    const jsonLen = jsonBytes.length + jsonPad, binLen = this.length + binPad;
    const total = 12 + 8 + jsonLen + 8 + binLen;
    const out = new Uint8Array(total), dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
    dv.setUint32(12, jsonLen, true); dv.setUint32(16, 0x4e4f534a, true);
    out.set(jsonBytes, 20); out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen);
    let at = 20 + jsonLen;
    dv.setUint32(at, binLen, true); dv.setUint32(at + 4, 0x004e4942, true); at += 8;
    for (const p of this.parts) { out.set(p, at); at += p.byteLength; }
    return out.buffer;
  }
}

/**
 * bones:  [{ name, parent, head: Vector3 (meters, world, T-pose) }], parents before children
 * meshes: [{ name, positions, normals (per source vertex, meters), source, uv, indices,
 *            joints, weights (per source vertex), image: {bytes, mimeType} | null, color, alpha:
 *            "OPAQUE" | "MASK", doubleSided, morphs: { name: deltas per source vertex (meters) } }]
 * expressions: { vrmPresetName: [[morph name, weight], ...] }
 */
export function writeVRM({ bones, humanoid, meshes, expressions = {}, meta, recipe, generator, springBone = null }) {
  const json = { asset: { version: "2.0", generator, extras: { avatarEditorRecipe: recipe } },
    extensionsUsed: ["VRMC_vrm"], scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [],
    textures: [], images: [], samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    skins: [], accessors: [], bufferViews: [] };
  const glb = new GlbBuilder(json);

  // Skeleton: translation-only nodes (rest pose = T-pose, identity rotations).
  bones.forEach((b) => {
    const p = b.parent >= 0 ? bones[b.parent].head : new THREE.Vector3();
    json.nodes.push({ name: b.name, translation: [b.head.x - p.x, b.head.y - p.y, b.head.z - p.z] });
  });
  bones.forEach((b, i) => { if (b.parent >= 0) (json.nodes[b.parent].children ??= []).push(i); });
  const ibm = new Float32Array(bones.length * 16);
  bones.forEach((b, i) => ibm.set(new THREE.Matrix4().makeTranslation(-b.head.x, -b.head.y, -b.head.z).elements, i * 16));
  const root = bones.findIndex((b) => b.parent < 0);
  json.skins.push({ joints: bones.map((_, i) => i), inverseBindMatrices: glb.accessor(ibm, "MAT4", FLOAT), skeleton: root });
  json.scenes[0].nodes.push(root);

  for (const m of meshes) {
    const n = m.source.length;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    const jnt = new Uint16Array(n * 4), wgt = new Float32Array(n * 4);
    for (let r = 0; r < n; r++) {
      const s = m.source[r];
      for (let k = 0; k < 3; k++) { pos[r * 3 + k] = m.positions[s * 3 + k]; nor[r * 3 + k] = m.normals[s * 3 + k]; }
      for (let k = 0; k < 4; k++) { jnt[r * 4 + k] = m.joints[s * 4 + k]; wgt[r * 4 + k] = m.weights[s * 4 + k]; }
      uv[r * 2] = m.uv[r * 2]; uv[r * 2 + 1] = 1 - m.uv[r * 2 + 1];  // OBJ v is bottom-up, glTF top-down
    }
    const material = { name: m.name, doubleSided: m.doubleSided, alphaMode: m.alpha,
      pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.7 } };
    if (m.alpha === "MASK") material.alphaCutoff = m.alphaCutoff ?? 0.5;
    if (m.image) {
      const image = json.images.push({ bufferView: glb.view(m.image.bytes), mimeType: m.image.mimeType, name: m.name }) - 1;
      material.pbrMetallicRoughness.baseColorTexture = { index: json.textures.push({ source: image, sampler: 0 }) - 1 };
      if (m.tint) material.pbrMetallicRoughness.baseColorFactor = m.tint;  // linear RGBA multiplier
    } else if (m.color) material.pbrMetallicRoughness.baseColorFactor = m.color;
    const materialIndex = json.materials.push(material) - 1;
    const primitive = {
      attributes: {
        POSITION: glb.accessor(pos, "VEC3", FLOAT, { target: 34962, minmax: true }),
        NORMAL: glb.accessor(nor, "VEC3", FLOAT, { target: 34962 }),
        TEXCOORD_0: glb.accessor(uv, "VEC2", FLOAT, { target: 34962 }),
        JOINTS_0: glb.accessor(jnt, "VEC4", USHORT, { target: 34962 }),
        WEIGHTS_0: glb.accessor(wgt, "VEC4", FLOAT, { target: 34962 }),
      },
      indices: glb.accessor(new Uint32Array(m.indices), "SCALAR", UINT, { target: 34963 }),
      material: materialIndex,
    };
    // Morph targets (face shapes), sparse, POSITION only; skip shapes that don't move this mesh.
    m.targetNames = [];
    for (const [name, deltas] of Object.entries(m.morphs ?? {})) {
      const idx = [], val = [];
      for (let r = 0; r < n; r++) {
        const s = m.source[r] * 3, x = deltas[s], y = deltas[s + 1], z = deltas[s + 2];
        if (Math.abs(x) > 1e-6 || Math.abs(y) > 1e-6 || Math.abs(z) > 1e-6) { idx.push(r); val.push(x, y, z); }
      }
      if (!idx.length) continue;
      (primitive.targets ??= []).push({ POSITION: glb.sparseVec3(n, new Uint32Array(idx), new Float32Array(val)) });
      m.targetNames.push(name);
    }
    const meshDef = { name: m.name, primitives: [primitive] };
    if (m.targetNames.length) Object.assign(meshDef, { weights: m.targetNames.map(() => 0), extras: { targetNames: m.targetNames } });
    const mesh = json.meshes.push(meshDef) - 1;
    m.node = json.nodes.push({ name: m.name, mesh, skin: 0 }) - 1;
    json.scenes[0].nodes.push(m.node);
  }

  // VRM 1.0 expressions: each preset binds the morph targets of every mesh that has them.
  const VRM_NAMES = { blink_left: "blinkLeft", blink_right: "blinkRight" };
  const preset = {};
  for (const [name, binds] of Object.entries(expressions)) {
    const morphTargetBinds = [];
    for (const [shape, weight] of binds) for (const m of meshes) {
      const index = m.targetNames.indexOf(shape);
      if (index >= 0) morphTargetBinds.push({ node: m.node, index, weight });
    }
    preset[VRM_NAMES[name] ?? name] = { isBinary: false, overrideBlink: "none", overrideLookAt: "none", overrideMouth: "none", morphTargetBinds };
  }

  const humanBones = {};
  const byName = Object.fromEntries(bones.map((b, i) => [b.name, i]));
  for (const [vrmBone, ours] of Object.entries(humanoid)) if (ours in byName) humanBones[vrmBone] = { node: byName[ours] };
  const vrm = { specVersion: "1.0", meta, humanoid: { humanBones }, expressions: { preset } };
  // Look-at: the eyes turn on their bones. Eyes can turn about 25° side to side and less up and down;
  // a viewer straight ahead to 40° off maps linearly onto that, beyond it the head has to turn.
  if (humanBones.leftEye && humanBones.rightEye && humanBones.head) {
    const eyes = [humanoid.leftEye, humanoid.rightEye].map((n) => bones[byName[n]].head);
    const head = bones[byName[humanoid.head]].head;
    const mid = eyes[0].clone().add(eyes[1]).multiplyScalar(0.5).sub(head);
    vrm.lookAt = { type: "bone", offsetFromHeadBone: [mid.x, mid.y, mid.z],
      rangeMapHorizontalInner: { inputMaxValue: 40, outputScale: 22 }, rangeMapHorizontalOuter: { inputMaxValue: 40, outputScale: 25 },
      rangeMapVerticalDown: { inputMaxValue: 30, outputScale: 15 }, rangeMapVerticalUp: { inputMaxValue: 30, outputScale: 12 } };
  }
  json.extensions = { VRMC_vrm: vrm };
  if (springBone) { json.extensions.VRMC_springBone = springBone; json.extensionsUsed.push("VRMC_springBone"); }
  return glb.toArrayBuffer();
}
