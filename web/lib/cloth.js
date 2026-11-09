// Skirts that don't tear when the avatar sits.
//
// A MakeHuman skirt borrows its skin weights from the body vertices it is fitted to, so a vertex in
// the middle of the lap follows the left thigh while its neighbor follows the right thigh or the
// pelvis. Standing that doesn't show; seated (thighs rotated 90° forward) neighboring vertices end
// up far apart and the skirt splits open. Here weights below the waist are rebuilt as a smooth
// function of position instead: pelvis at the hips, fading into the thighs further down, and a soft
// left/right blend across the middle, so the skirt bends as one sheet and lies over the lap. Long
// skirts, dresses and robes follow the shins below the knee, so seated they hang from the knees.
// Everything is in meters, in the T-posed rest pose; the avatar faces +z.
//
//   skirtSkin({ bones, positions, joints, weights })
//     bones:     [{name, parent, head: Vector3}]  the export skeleton
//     positions: the item's vertices (xyz); joints, weights: its current skin (4 per vertex)
//   returns { joints, weights }

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function skirtSkin({ bones, positions, joints, weights }) {
  const at = Object.fromEntries(bones.map((b, i) => [b.name, i]));
  const L = bones[at.thigh_l].head, R = bones[at.thigh_r].head;
  const hipY = (L.y + R.y) / 2, cx = (L.x + R.x) / 2, toLeft = Math.sign(L.x - cx) || 1;
  const top = hipY + 0.06;   // above: the item's own weights (waistband, blouse)
  const mid = hipY + 0.01;   // fully rebuilt from here down; pelvis only at this height
  const low = hipY - 0.07;   // thighs only from here down
  const kneeY = (bones[at.calf_l].head.y + bones[at.calf_r].head.y) / 2;
  // Only long garments (reaching well down the shins) follow the shins; a knee-length hem with points
  // would otherwise tear into strips, the points hanging down and the rest lying on the lap.
  let lowest = Infinity;
  for (let v = 1; v < positions.length; v += 3) lowest = Math.min(lowest, positions[v]);
  const long = lowest < kneeY - 0.25;
  // Others drape over the knee: halfway to the shin there, like the skin they cover (else the bent
  // knee pokes through the hem).
  const shin = (y) => long ? smooth(kneeY - 0.05, kneeY - 0.2, y) : 0.5 * smooth(kneeY + 0.1, kneeY - 0.02, y);
  const J = new Uint16Array(joints), W = new Float32Array(weights);
  const arm = new Set(bones.flatMap((b, i) => /^(upperarm|lowerarm|hand|thumb|index|middle|ring|pinky)_/.test(b.name) ? [i] : []));
  for (let v = 0; v < positions.length / 3; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1];
    if (y >= top) continue;
    let onArm = 0;  // wide sleeves hang beside the hips: they stay with the arms
    for (let k = 0; k < 4; k++) if (arm.has(J[v * 4 + k])) onArm += W[v * 4 + k];
    if (onArm > 0.3) continue;
    const a = smooth(top, mid, y), leg = smooth(mid, low, y), left = smooth(-0.05, 0.05, (x - cx) * toLeft);
    const mix = new Map();
    for (let k = 0; k < 4; k++) if (W[v * 4 + k] > 0) mix.set(J[v * 4 + k], (1 - a) * W[v * 4 + k]);
    const c = shin(y);
    for (const [bone, w] of [[at.pelvis, 1 - leg], [at.thigh_l, leg * left * (1 - c)], [at.thigh_r, leg * (1 - left) * (1 - c)],
                             [at.calf_l, leg * left * c], [at.calf_r, leg * (1 - left) * c]])
      mix.set(bone, (mix.get(bone) ?? 0) + a * w);
    const best = [...mix].filter(([, w]) => w > 0.001).sort((p, q) => q[1] - p[1]).slice(0, 4);
    const total = best.reduce((t, [, w]) => t + w, 0) || 1;
    for (let k = 0; k < 4; k++) { J[v * 4 + k] = best[k]?.[0] ?? 0; W[v * 4 + k] = best[k] ? best[k][1] / total : 0; }
  }
  return { joints: J, weights: W };
}
