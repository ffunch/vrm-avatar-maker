// Live preview: the exported VRM itself, shown with three-vrm the way So Many Rooms shows it, with
// hair physics (spring bones), eyes that follow the camera, random blinking, breathing and a little
// head movement, seated (So Many Rooms' VR circle pose, on a stool) or standing.
// Loaded on demand by the editor (dynamic import), so it doesn't add to the first load.
//
//   const preview = createPreview({ scene, camera });
//   await preview.show(arrayBuffer, { seated });   // replaces what was shown
//   preview.update(dt, { expression, talk });     // every frame while shown
//   preview.hide();
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

// Same as So Many Rooms' seated avatars (and tools/viewer): normalized bone rotations.
const SEATED_POSE = {
  leftUpperLeg: [-Math.PI / 2, 0, 0], rightUpperLeg: [-Math.PI / 2, 0, 0],
  leftLowerLeg: [Math.PI / 2, 0, 0], rightLowerLeg: [Math.PI / 2, 0, 0],
  leftUpperArm: [0, 0, -1.25], rightUpperArm: [0, 0, 1.25],
};
const STANDING_POSE = {
  leftUpperArm: [0, 0, -1.2], rightUpperArm: [0, 0, 1.2],
  leftLowerArm: [0, -0.15, 0], rightLowerArm: [0, 0.15, 0],
};

export function createPreview({ scene, camera }) {
  let vrm = null, figure = null, t = 0, nextBlink = 2, blinkStart = -1;

  function hide() {
    if (!figure) return;
    scene.remove(figure);
    VRMUtils.deepDispose(figure);
    figure = null; vrm = null;
  }

  async function show(buffer, { seated = true } = {}) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.parseAsync(buffer, "");
    hide();
    vrm = gltf.userData.vrm;
    VRMUtils.removeUnnecessaryVertices(vrm.scene);
    VRMUtils.combineSkeletons(vrm.scene);
    VRMUtils.rotateVRM0(vrm);  // VRM 0.x avatars face the other way (the Fix page shows any VRM)
    vrm.scene.traverse((o) => { o.frustumCulled = false; });
    // VRM 0.x normalized bones turn the other way around x and z (three-vrm's retargeting example
    // negates them for VRM 0.x too); without this a 0.x avatar sits with its arms up and knees back.
    const v0 = vrm.meta?.metaVersion === "0" ? -1 : 1;
    for (const [bone, [x, y, z]] of Object.entries(seated ? SEATED_POSE : STANDING_POSE)) {
      vrm.humanoid.getNormalizedBoneNode(bone)?.rotation.set(x * v0, y, z * v0);
    }
    vrm.update(0);
    vrm.scene.updateMatrixWorld(true);
    const at = (bone) => vrm.humanoid.getRawBoneNode(bone)?.getWorldPosition(new THREE.Vector3()) ?? null;
    const feet = [at("leftFoot"), at("rightFoot")].filter(Boolean);
    const floor = feet.length ? Math.min(...feet.map((p) => p.y)) : 0;
    figure = new THREE.Group();
    vrm.scene.position.y = -floor;
    figure.add(vrm.scene);
    if (seated) {
      const thigh = at("leftUpperLeg");
      const h = Math.max(0.2, (thigh ? thigh.y - floor : 0.45) - 0.07);
      const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, h, 24), new THREE.MeshStandardMaterial({ color: 0x5a4632 }));
      stool.position.set(0, h / 2, (thigh ? thigh.z : 0) + 0.1);
      figure.add(stool);
    }
    if (vrm.lookAt) vrm.lookAt.target = camera;
    // Let the hair settle before the first frame is seen.
    for (let i = 0; i < 30; i++) vrm.update(1 / 60);
    scene.add(figure);
    return { springJoints: vrm.springBoneManager?.joints?.size ?? 0, lookAt: !!vrm.lookAt };
  }

  function update(dt, { expression = "", talk = false } = {}) {
    if (!vrm) return;
    t += dt;
    const em = vrm.expressionManager;
    if (em) {
      for (const name of Object.keys(em.expressionMap)) em.setValue(name, 0);
      if (expression) em.setValue(expression, 1);
      // Blink every 2-6 s, about 0.15 s with the lids closed.
      if (t >= nextBlink) { blinkStart = t; nextBlink = t + 2 + Math.random() * 4; }
      const b = t - blinkStart;
      if (blinkStart >= 0 && b < 0.2) em.setValue("blink", Math.sin(Math.PI * b / 0.2));
      if (talk) {
        const mouth = ["aa", "oh", "ee", "ou", "ih"][Math.floor(t * 6) % 5];
        em.setValue(mouth, 0.5 + 0.5 * Math.abs(Math.sin(t * 9)));
      }
    }
    // Breathing and a slow, small head movement (the eyes keep following the camera).
    const h = vrm.humanoid;
    const v0 = vrm.meta?.metaVersion === "0" ? -1 : 1;
    h.getNormalizedBoneNode("chest")?.rotation.set(v0 * 0.02 * Math.sin(t * 1.6), 0, 0);
    h.getNormalizedBoneNode("head")?.rotation.set(v0 * 0.04 * Math.sin(t * 0.37), 0.12 * Math.sin(t * 0.23), v0 * 0.03 * Math.sin(t * 0.31));
    vrm.update(dt);
  }

  /** World position of the head (for the editor's Face camera), or null. */
  const head = () => vrm?.humanoid.getRawBoneNode("head")?.getWorldPosition(new THREE.Vector3()) ?? null;

  return { show, hide, update, head, get vrm() { return vrm; }, get shown() { return !!vrm; } };
}
