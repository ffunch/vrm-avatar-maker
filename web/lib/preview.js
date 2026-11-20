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

const MOTION_BONES = {
  hips: "DEF-hips", spine: "DEF-spine001", chest: "DEF-spine002", upperChest: "DEF-spine003",
  neck: "DEF-neck", head: "DEF-head",
  leftShoulder: "DEF-shoulderL", leftUpperArm: "DEF-upper_armL", leftLowerArm: "DEF-forearmL", leftHand: "DEF-handL",
  rightShoulder: "DEF-shoulderR", rightUpperArm: "DEF-upper_armR", rightLowerArm: "DEF-forearmR", rightHand: "DEF-handR",
  leftUpperLeg: "DEF-thighL", leftLowerLeg: "DEF-shinL", leftFoot: "DEF-footL", leftToes: "DEF-toeL",
  rightUpperLeg: "DEF-thighR", rightLowerLeg: "DEF-shinR", rightFoot: "DEF-footR", rightToes: "DEF-toeR",
};
const MOTION_CLIPS = { walk: "Walk_Loop", run: "Jog_Fwd_Loop", jump: "Jump_Start" };
let motionSourceJob = null;
function loadMotionSource() {
  return motionSourceJob ??= new GLTFLoader().loadAsync(new URL("../vendor/quaternius-motion-2025/AnimationLibrary_Godot_Standard.gltf", import.meta.url).href)
    .then((gltf) => {
      gltf.scene.updateMatrixWorld(true);
      const nodes = Object.fromEntries(Object.entries(MOTION_BONES).map(([name, source]) => [name, gltf.scene.getObjectByName(source)]));
      const rest = Object.fromEntries(Object.entries(nodes).map(([name, node]) => [name, node.getWorldQuaternion(new THREE.Quaternion())]));
      const hipsPosition = nodes.hips.getWorldPosition(new THREE.Vector3());
      return { scene: gltf.scene, mixer: new THREE.AnimationMixer(gltf.scene), clips: Object.fromEntries(gltf.animations.map((clip) => [clip.name, clip])), nodes, rest, hipsPosition };
    }).catch((err) => { motionSourceJob = null; throw err; });
}

export function createPreview({ scene, camera }) {
  let vrm = null, figure = null, t = 0, nextBlink = 2, blinkStart = -1;
  let motion = null, motionSource = null, motionAction = null, motionTime = 0, targetRest = null, targetRestWorld = null, hipRest = null;
  const q = new THREE.Quaternion(), parentQ = new THREE.Quaternion(), desired = new THREE.Quaternion();

  function resetMotionPose() {
    if (!vrm || !targetRest) return;
    for (const [name, rest] of Object.entries(targetRest)) vrm.humanoid.getNormalizedBoneNode(name)?.quaternion.copy(rest);
    vrm.humanoid.getNormalizedBoneNode("hips")?.position.copy(hipRest);
  }

  function playClip(name, loop) {
    motionSource.mixer.stopAllAction();
    motionAction = motionSource.mixer.clipAction(motionSource.clips[name]);
    motionAction.reset().setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1).play();
    motionAction.clampWhenFinished = !loop;
    motionTime = 0;
  }

  async function setMotion(name) {
    if (!vrm) return;
    if (!name) {
      motion = null;
      motionSource?.mixer.stopAllAction();
      resetMotionPose();
      const v0 = vrm.meta?.metaVersion === "0" ? -1 : 1;
      for (const [bone, [x, y, z]] of Object.entries(STANDING_POSE))
        vrm.humanoid.getNormalizedBoneNode(bone)?.rotation.set(x * v0, y, z * v0);
      vrm.update(0);
      return;
    }
    const source = await loadMotionSource();
    if (!vrm) return;
    motionSource = source;
    resetMotionPose();
    motion = name;
    playClip(MOTION_CLIPS[name], name !== "jump");
    vrm.update(0);
  }

  function hide() {
    if (!figure) return;
    motionSource?.mixer.stopAllAction();
    scene.remove(figure);
    VRMUtils.deepDispose(figure);
    figure = null; vrm = null; motion = null; targetRest = null; targetRestWorld = null;
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
    vrm.scene.updateMatrixWorld(true);
    targetRest = Object.fromEntries(Object.keys(MOTION_BONES).map((name) => [name, vrm.humanoid.getNormalizedBoneNode(name)?.quaternion.clone()]));
    targetRestWorld = Object.fromEntries(Object.keys(MOTION_BONES).map((name) => [name, vrm.humanoid.getNormalizedBoneNode(name)?.getWorldQuaternion(new THREE.Quaternion())]));
    hipRest = vrm.humanoid.getNormalizedBoneNode("hips")?.position.clone();
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
    let motionEnded = false;
    if (motion) {
      motionSource.mixer.update(dt);
      motionTime += dt;
      motionSource.scene.updateMatrixWorld(true);
      const h = vrm.humanoid;
      // Transfer each bone's world-space change from its rest pose onto the VRM's own rest pose.
      for (const [name, source] of Object.entries(motionSource.nodes)) {
        const bone = h.getNormalizedBoneNode(name);
        if (!bone) continue;
        source.getWorldQuaternion(q);
        desired.copy(q).multiply(motionSource.rest[name].clone().invert());
        bone.parent.getWorldQuaternion(parentQ);
        bone.quaternion.copy(parentQ.invert().multiply(desired.multiply(targetRestWorld[name])));
        bone.updateMatrixWorld(true);
      }
      const sourceHip = motionSource.nodes.hips.getWorldPosition(new THREE.Vector3());
      h.getNormalizedBoneNode("hips").position.y = hipRest.y + (sourceHip.y - motionSource.hipsPosition.y);
      if (motion === "jump" && motionTime >= motionAction.getClip().duration) {
        if (motionAction.getClip().name === "Jump_Start") playClip("Jump_Land", false);
        else { setMotion(null); motionEnded = true; }
      }
    }
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
    if (!motion) h.getNormalizedBoneNode("chest")?.rotation.set(v0 * 0.02 * Math.sin(t * 1.6), 0, 0);
    if (!motion) h.getNormalizedBoneNode("head")?.rotation.set(v0 * 0.04 * Math.sin(t * 0.37), 0.12 * Math.sin(t * 0.23), v0 * 0.03 * Math.sin(t * 0.31));
    vrm.update(dt);
    return motionEnded;
  }

  /** World position of the head (for the editor's Face camera), or null. */
  const head = () => vrm?.humanoid.getRawBoneNode("head")?.getWorldPosition(new THREE.Vector3()) ?? null;

  return { show, hide, update, head, setMotion, get vrm() { return vrm; }, get shown() { return !!vrm; }, get motion() { return motion; } };
}
