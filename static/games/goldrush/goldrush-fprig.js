// GoldRush - FP2.0A: the first-person RIG. The arms are authored, skinned meshes (assets/fp/fp_arms.glb, tools/goldrush/
// build_fp_arms.py: own work, no third-party art) with a bone chain upper -> fore -> hand -> finger / thumb joints and
// AnimationClips for the fingers. This module loads them and drives them:
//
//   loadFpArms(THREE)    the GLB, once per game; null (and a console warning) when it cannot be loaded - the caller then keeps
//                        the procedural glove (goldrush-hand.js), the game never depends on the file
//   RiggedArm            one arm. The pose of the HAND still comes from the ToolController's phases via FirstPersonHands (the
//                        keyframes, the grips, the contact aim - all unchanged: gameplay triggers the animation, the animation
//                        never decides anything). The arm's bones follow the same two-bone IK as before (goldrush-armik.js), the
//                        hand bone takes the hand's matrix, and the fingers are the clips: `curl` is sampled at the 0..1 curl the
//                        pose asks for (AnimationMixer, time = curl), `thumb` likewise - so a clip is authored data, not a formula
//                        in code. A little idle drift keeps a resting hand from being a statue.
//
// Bone frames are the glove frame's (wrist at the origin, fingers -z, back of the hand +y), so every grip / contact number
// in goldrush-hand.js (HANDLE_IN_GLOVE, GRIPS, the rim poses) means exactly what it did for the procedural glove.

import { GloveBase } from "./goldrush-armik.js";

const URL_ARMS = new URL("./assets/fp/fp_arms.glb", import.meta.url).href;

/** the arms' GLB: { scene, animations } or null */
export async function loadFpArms(THREE) {
  try {
    const { GLTFLoader } = await import("../../vendor/three/addons/loaders/GLTFLoader.js");
    const gltf = await new GLTFLoader().loadAsync(URL_ARMS);
    for (const tag of ["R", "L"]) {
      if (!gltf.scene.getObjectByName(`armature_${tag}`) || !gltf.scene.getObjectByName(`arm_${tag}`)) throw new Error(`fp_arms.glb: no ${tag} arm`);
      if (!gltf.animations.some((a) => a.name === `curl_${tag}`)) throw new Error(`fp_arms.glb: no curl_${tag} clip`);
    }
    return gltf;
  } catch (e) {
    if (typeof console !== "undefined") console.warn("[goldrush] first-person arms could not be loaded - the procedural gloves are used:", e && e.message ? e.message : e);
    return null;
  }
}

const MIRROR = (THREE) => new THREE.Matrix4().makeScale(-1, 1, 1);

/**
 * The rig's two materials (the GLB carries geometry + vertex colours + baked contact shading only): worn leather and
 * canvas, PBR (rough, no metal), with a fine surface relief - leather grain / a canvas weave - added to the shading normal
 * from the REST-pose object position (so it sticks to the surface while the fingers bend). Calm values: nothing glossy.
 */
export function makeRigMaterials(THREE, envMap) {
  const patch = (weave) => (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vRigP;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvRigP = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec3 vRigP;
        float rigH(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float rigN(vec3 p) {
          vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(rigH(i), rigH(i + vec3(1, 0, 0)), f.x), mix(rigH(i + vec3(0, 1, 0)), rigH(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(rigH(i + vec3(0, 0, 1)), rigH(i + vec3(1, 0, 1)), f.x), mix(rigH(i + vec3(0, 1, 1)), rigH(i + vec3(1, 1, 1)), f.x), f.y), f.z) * 2.0 - 1.0;
        }`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
        {
          vec3 q = vRigP * ${weave ? "260.0" : "340.0"};
          vec3 g = vec3(rigN(q), rigN(q + 7.3), rigN(q + 13.1)) * ${weave ? "0.10" : "0.16"};
          ${weave ? "g.x += sin(vRigP.z * 1700.0) * 0.09; g.y += sin(vRigP.x * 1500.0 + vRigP.y * 1500.0) * 0.07;" : "g += vec3(rigN(q * 3.1), rigN(q * 3.1 + 2.0), 0.0) * 0.06;"}
          normal = normalize(normal + g);
        }`);
  };
  const mk = (rough, weave, key) => {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: rough, metalness: 0, envMap: envMap || null, envMapIntensity: 0.45 });
    m.onBeforeCompile = patch(weave);
    m.customProgramCacheKey = () => `goldrush-fp-rig-${key}`;
    return m;
  };
  return { glove: mk(0.84, false, "leather"), sleeve: mk(0.95, true, "canvas") };
}

export class RiggedArm extends GloveBase {
  /** gltf: loadFpArms' result (its objects are taken over - one game, one rig); mats: { glove, sleeve } */
  constructor(THREE, side, gltf, mats, restPose) {
    super(THREE, side, restPose);
    const tag = side > 0 ? "R" : "L";
    this.tag = tag;
    this.armature = gltf.scene.getObjectByName(`armature_${tag}`);
    this.meshes = [];
    const node = gltf.scene.getObjectByName(`arm_${tag}`);
    node.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      o.frustumCulled = false;                       // (the bounding sphere is the rest pose's; the hands never leave the view pass anyway)
      o.castShadow = false;
      const part = o.material && o.material.name === "sleeve_canvas" ? "sleeve" : "glove";
      o.material = mats[part];
      this.meshes.push(o);
    });
    this.skinned = this.meshes[0];
    this.arm.add(this.armature, node);
    // the bones by short name (without the side prefix)
    this.bones = {};
    for (const b of this.skinned.skeleton.bones) this.bones[b.name.slice(2)] = b;
    this.restThumb = this.bones.th_1.quaternion.clone();
    // the thumb's root takes the game's euler (as the procedural glove's thumb group did): the left arm is a mirror image, so its y / z flip
    const th = this.bones.th_1, s = side;
    this.thumb = { rotation: { set: (x, y, z) => th.rotation.set(x, y * s, z * s) } };
    // clips: finger curl and thumb curl, sampled by time (the parameter is the curl 0..1)
    this.mixer = new THREE.AnimationMixer(this.armature);
    const clip = (n) => gltf.animations.find((a) => a.name === `${n}_${tag}`);
    this.curlAction = this.mixer.clipAction(clip("curl"));
    this.thumbAction = this.mixer.clipAction(clip("thumb"));
    for (const a of [this.curlAction, this.thumbAction]) { a.play(); a.setEffectiveWeight(1); }
    this.curlT = 0.4;
    this.thumbT = 0.3;
    this.idleT = 0;                                  // set by FirstPersonHands: the hands' clock (a little finger drift)
    this.restTranslation = { fore: this.bones.fore.position.clone(), hand: this.bones.hand.position.clone() };
    this._mir = MIRROR(THREE);
    this._hw = new THREE.Matrix4();
    this._fw = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._qu = new THREE.Quaternion();
    this._qf = new THREE.Quaternion();
    this._back = new THREE.Vector3(0, 0, -1);
    this._v = new THREE.Vector3();
    this._one = new THREE.Vector3(1, 1, 1);
    this._ZERO = new THREE.Vector3();
    // the held nugget (inspect) lives in the hand's frame, as on the procedural glove
    this.held = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), mats.glove);
    this.held.visible = false;
    this.held.position.set(0, -0.036, -0.055);
    this.root.add(this.held);
  }

  /** the fingers: curl 0..1 (the clip's time); thumb: how far the thumb closes with it (old numbers: 0.6 round a handle, 0.9 hooked) */
  _curl(c, thumb = 0.6) {
    c = Math.max(0, Math.min(1, c));
    const drift = this.reducedMotion ? 0 : Math.sin(this.idleT * 0.9 + this.side) * 0.025 * (1 - c);
    this.curlT = Math.max(0, Math.min(1, c + drift));
    this.thumbT = Math.max(0, Math.min(1, (c * thumb) / 0.9));
  }

  // wrist W, elbow E, shoulder point U (view space) -> the bones: the upper arm and forearm aim along the solved segments,
  // the hand bone takes the hand's own matrix (so the glove is exactly where the pose put it), the fingers play their clips
  _applyArm(W, E, U) {
    const b = this.bones;
    const qU = this._qu.setFromUnitVectors(this._back, this._v.subVectors(E, U).normalize());
    b.upper.position.copy(U);
    b.upper.quaternion.copy(qU);
    const qF = this._qf.setFromUnitVectors(this._back, this._v.subVectors(W, E).normalize());
    b.fore.quaternion.copy(this._q.copy(qU).invert().multiply(qF));
    // the hand: its world matrix (the mirrored left glove's scale removed - that arm's mesh is mirrored itself)
    const H = this._hw.copy(this.root.matrix);
    if (this.side < 0) H.multiply(this._mir);
    const F = this._fw.compose(E, qF, this._one);
    H.premultiply(F.invert());
    H.decompose(b.hand.position, b.hand.quaternion, this._v.set(1, 1, 1));
    this.curlAction.time = this.curlT * 0.9999;
    this.thumbAction.time = this.thumbT * 0.9999;
    this.mixer.update(0);
  }

  dispose() {
    this.mixer.stopAllAction();
    for (const m of this.meshes) m.geometry.dispose();
    this.held.geometry.dispose();
  }
}
