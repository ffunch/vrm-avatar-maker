// Hair that sways: VRMC_springBone chains for hair that hangs below the ears, plus body colliders.
//
// MakeHuman hair is skinned to the head (and for long hair, neck and shoulders) only, so it moves as
// one rigid piece. Here the hanging part gets bone chains, one per sector around the head (front,
// front-left, left, ... in 45° steps) where enough hair hangs down. Each chain runs from just below
// the ears to the hair's lowest point in that sector. Hair vertices are weighted along their
// chain, blended between neighboring chains so the hair doesn't split, and faded into the original
// weights near the top so the scalp stays put. Everything is in meters, in the T-posed rest pose.
//
//   addHairSprings({ bones, hair, body, bodyWeights })
//     bones:  [{name, parent, head: Vector3}]   the export skeleton; chain bones are appended to it
//     hair:   { positions, joints, weights }    per hair vertex (xyz, 4 joints, 4 weights)
//     body:   positions per base vertex (meters) to size the colliders, and visible body source ids
//   returns { joints, weights, springBone } or null if the hair is too short to swing.
import * as THREE from "three";

const SECTORS = 8;
const RAMP = 0.05;            // m: fade from the head's weights into the chains
const SEGMENT = 0.07;         // m: target chain segment length
const SETTINGS = { hitRadius: 0.02, stiffness: 0.9, gravityPower: 0.05, gravityDir: [0, -1, 0], dragForce: 0.5 };

const angleOf = (x, z) => Math.atan2(x, z);  // 0 = front (+z), positive toward the avatar's left (+x)
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function addHairSprings({ bones, hair, body }) {
  const byName = Object.fromEntries(bones.map((b, i) => [b.name, i]));
  if (!("head" in byName) || !("eye_l" in byName)) return null;
  const eyeY = (bones[byName.eye_l].head.y + bones[byName.eye_r].head.y) / 2;
  const P = hair.positions, n = P.length / 3;
  if (!n) return null;

  // Head axis: the middle of the hair's footprint above the eyes.
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) if (P[i * 3 + 1] > eyeY) {
    x0 = Math.min(x0, P[i * 3]); x1 = Math.max(x1, P[i * 3]); z0 = Math.min(z0, P[i * 3 + 2]); z1 = Math.max(z1, P[i * 3 + 2]);
  }
  if (!isFinite(x0)) return null;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const yStart = eyeY - 0.05;  // about the bottom of the ears: above this, hair lies on the skull

  // Hanging vertices by sector.
  const sectorOf = (i) => ((Math.round(angleOf(P[i * 3] - cx, P[i * 3 + 2] - cz) / (2 * Math.PI / SECTORS)) % SECTORS) + SECTORS) % SECTORS;
  const members = Array.from({ length: SECTORS }, () => []);
  for (let i = 0; i < n; i++) if (P[i * 3 + 1] < yStart) members[sectorOf(i)].push(i);

  const chains = [];
  for (let s = 0; s < SECTORS; s++) {
    const list = members[s];
    if (list.length < 30) continue;
    let low = Infinity;
    for (const i of list) low = Math.min(low, P[i * 3 + 1]);
    const length = yStart - low;
    if (length < 0.06) continue;
    const segments = Math.max(2, Math.min(5, Math.round(length / SEGMENT)));
    const step = length / segments, joints = [];
    // Fallback for a level with no hair near it (e.g. a gap right under the ears): the sector's middle.
    let mx = 0, mz = 0;
    for (const i of list) { mx += P[i * 3]; mz += P[i * 3 + 2]; }
    let last = new THREE.Vector3(mx / list.length, yStart, mz / list.length);
    for (let k = 0; k <= segments; k++) {
      const y = yStart - k * step;
      let sx = 0, sz = 0, c = 0;
      for (const i of list) if (Math.abs(P[i * 3 + 1] - y) <= step / 2) { sx += P[i * 3]; sz += P[i * 3 + 2]; c++; }
      const p = c ? new THREE.Vector3(sx / c, y, sz / c) : new THREE.Vector3(last.x, y, last.z);
      joints.push(p); last = p;
    }
    chains.push({ sector: s, angle: s * 2 * Math.PI / SECTORS, step, segments, joints, first: 0 });
  }
  if (!chains.length) return null;

  // Bones: each chain hangs off the head; the last joint is the tip (no weights).
  for (const c of chains) {
    c.first = bones.length;
    c.joints.forEach((p, k) => bones.push({ name: `hair_${c.sector}_${k}`, parent: k ? bones.length - 1 : byName.head, head: p }));
  }

  // Weights.
  chains.sort((a, b) => wrap(a.angle) - wrap(b.angle));
  const joints = new Uint16Array(hair.joints), weights = new Float32Array(hair.weights);
  for (let i = 0; i < n; i++) {
    const y = P[i * 3 + 1];
    if (y >= yStart) continue;
    const phi = angleOf(P[i * 3] - cx, P[i * 3 + 2] - cz);
    // The two chains around this direction, or the nearest if the gap between them is wide.
    let best = null;
    for (let a = 0; a < chains.length; a++) {
      const A = chains[a], B = chains[(a + 1) % chains.length];
      const gap = chains.length === 1 ? 0 : ((wrap(B.angle - A.angle) + 2 * Math.PI) % (2 * Math.PI)) || 2 * Math.PI;
      const into = ((wrap(phi - A.angle) + 2 * Math.PI) % (2 * Math.PI));
      if (gap > 0 && gap <= Math.PI * 0.56 && into <= gap) { best = [[A, 1 - into / gap], [B, into / gap]]; break; }
    }
    if (!best) {
      const near = chains.reduce((m, c) => Math.abs(wrap(phi - c.angle)) < Math.abs(wrap(phi - m.angle)) ? c : m);
      best = [[near, 1]];
    }
    const s = Math.min(1, (yStart - y) / RAMP);
    const mix = new Map();
    for (let k = 0; k < 4; k++) if (weights[i * 4 + k] > 0) mix.set(joints[i * 4 + k], (1 - s) * weights[i * 4 + k]);
    for (const [c, cw] of best) {
      const a = Math.max(0, (yStart - y) / c.step - 0.5);
      const k0 = Math.min(c.segments - 1, Math.floor(a)), k1 = Math.min(c.segments - 1, k0 + 1), f = Math.min(1, a - Math.floor(a));
      for (const [k, w] of [[k0, 1 - f], [k1, f]]) mix.set(c.first + k, (mix.get(c.first + k) ?? 0) + s * cw * w);
    }
    const top = [...mix].filter(([, w]) => w > 0.001).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const total = top.reduce((t, [, w]) => t + w, 0) || 1;
    for (let k = 0; k < 4; k++) { joints[i * 4 + k] = top[k]?.[0] ?? 0; weights[i * 4 + k] = top[k] ? top[k][1] / total : 0; }
  }

  return { joints, weights, springBone: { colliders: bodyColliders(bones, byName, body, eyeY, cx, cz), chains } };
}

/** Sphere and capsule colliders on the head, neck, chest and upper arms, sized from the body mesh. */
function bodyColliders(bones, byName, body, eyeY, cx, cz) {
  const B = body.positions, ids = body.ids;
  const slice = (y, half, maxX) => {
    let z0 = Infinity, z1 = -Infinity, x1 = 0;
    for (const v of ids) {
      const x = B[v * 3], yy = B[v * 3 + 1], z = B[v * 3 + 2];
      if (Math.abs(yy - y) > half || Math.abs(x) > maxX) continue;
      z0 = Math.min(z0, z); z1 = Math.max(z1, z); x1 = Math.max(x1, Math.abs(x));
    }
    return isFinite(z0) ? { r: (z1 - z0) / 2, z: (z1 + z0) / 2, w: x1 } : null;
  };
  const at = (name) => bones[byName[name]].head;
  const local = (name, p) => [p.x - at(name).x, p.y - at(name).y, p.z - at(name).z];
  const out = [];
  const head = slice(eyeY + 0.02, 0.01, 0.2);
  if (head) out.push({ bone: "head", shape: { sphere: { offset: local("head", new THREE.Vector3(cx, eyeY + 0.01, cz)), radius: 0.85 * Math.min(head.w, head.r) } } });
  const neckTop = at("head"), neckLow = at("neck_01");
  const neck = slice((neckTop.y + neckLow.y) / 2, 0.01, 0.1);
  if (neck) out.push({ bone: "neck_01", shape: { capsule: {
    offset: local("neck_01", new THREE.Vector3(0, neckLow.y, neck.z)), radius: 0.8 * neck.r,
    tail: local("neck_01", new THREE.Vector3(0, neckTop.y, neck.z)) } } });
  const shoulder = Math.abs(at("upperarm_l").x);
  for (const name of ["spine_03", "spine_02"]) {
    const y = at(name).y + (name === "spine_03" ? 0.06 : 0.04);
    const s = slice(y, 0.015, 0.12);
    if (!s) continue;
    const r = 0.85 * s.r, w = Math.max(0.01, shoulder - r);
    out.push({ bone: name, shape: { capsule: { offset: local(name, new THREE.Vector3(-w, y, s.z)), radius: r, tail: local(name, new THREE.Vector3(w, y, s.z)) } } });
  }
  for (const side of ["l", "r"]) {
    const a = at(`upperarm_${side}`), b = at(`lowerarm_${side}`);
    out.push({ bone: `upperarm_${side}`, shape: { capsule: { offset: [0, 0, 0], radius: 0.045, tail: [b.x - a.x, b.y - a.y, b.z - a.z] } } });
  }
  return out;
}

/** The VRMC_springBone 1.0 extension for writeVRM: node indices are bone indices. */
export function springBoneExtension(bones, { colliders, chains }) {
  const byName = Object.fromEntries(bones.map((b, i) => [b.name, i]));
  return {
    specVersion: "1.0",
    colliders: colliders.map((c) => ({ node: byName[c.bone], shape: c.shape })),
    colliderGroups: [{ name: "body", colliders: colliders.map((_, i) => i) }],
    springs: chains.map((c) => ({
      name: `hair_${c.sector}`, colliderGroups: [0],
      joints: c.joints.map((_, k) => ({ node: c.first + k, ...SETTINGS })),
    })),
  };
}
