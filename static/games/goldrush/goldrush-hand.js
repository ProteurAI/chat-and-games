// GoldRush - the player's hands. Two work gloves in first person, modelled
// here from simple shapes (no external asset), drawn in their own small
// pass on top of the world so they never clip into the mound, and lit by
// the same sun as the world.
//
// The hands own the rhythm of digging. A stroke is
//   digWindup  -> reach out and down to the ground
//   digContact -> the fingers touch: the engine runs the mining
//                 transaction in exactly this frame (nothing is removed
//                 earlier), and tells the hand what it hit
//   digRecover -> scrape back (dirt), or bounce off (stone)
// then the next stroke (other hand) or back to idle. A found nugget is held
// up for a moment (inspect); arriving pieces make the free hand grab.

export const HAND_STATE = { IDLE: "idle", WINDUP: "digWindup", CONTACT: "digContact", RECOVER: "digRecover", INSPECT: "inspect" };

// poses of the RIGHT hand in view space (the left one is mirrored):
// wrist position, rotation (x pitch, y yaw, z roll), finger curl 0..1
const POSE = {
  rest: { p: [0.2, -0.24, -0.37], r: [0.3, 0.45, -0.25], c: 0.4 },
  reach: { p: [0.1, -0.18, -0.47], r: [0.4, 0.35, -0.15], c: 0.12 },
  contact: { p: [0.05, -0.13, -0.55], r: [0.0, 0.32, -0.12], c: 0.5 },
  scrape: { p: [0.15, -0.24, -0.4], r: [0.25, 0.45, -0.25], c: 0.95 },
  recoil: { p: [0.12, -0.19, -0.45], r: [0.5, 0.4, -0.2], c: 0.1 },
  inspect: { p: [0.05, -0.14, -0.34], r: [0.2, 0.15, 2.85], c: 0.25 },
};

const ease = (t) => t * t * (3 - 2 * t);
const easeIn = (t) => t * t;
const easeOut = (t) => 1 - (1 - t) * (1 - t);

function lerpPose(a, b, t, out) {
  for (let i = 0; i < 3; i++) {
    out.p[i] = a.p[i] + (b.p[i] - a.p[i]) * t;
    out.r[i] = a.r[i] + (b.r[i] - a.r[i]) * t;
  }
  out.c = a.c + (b.c - a.c) * t;
  return out;
}
const clonePose = (p) => ({ p: [...p.p], r: [...p.r], c: p.c });

// concatenate simple indexed geometries (already transformed) into one,
// with a flat vertex colour per part
function mergeParts(THREE, parts) {
  let nv = 0, ni = 0;
  for (const { g } of parts) { nv += g.attributes.position.count; ni += g.index.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3), idx = new Uint32Array(ni);
  let ov = 0, oi = 0;
  const c = new THREE.Color();
  for (const { g, color } of parts) {
    const P = g.attributes.position, N = g.attributes.normal, I = g.index;
    c.set(color);
    for (let v = 0; v < P.count; v++) {
      pos.set([P.getX(v), P.getY(v), P.getZ(v)], (ov + v) * 3);
      nor.set([N.getX(v), N.getY(v), N.getZ(v)], (ov + v) * 3);
      col.set([c.r, c.g, c.b], (ov + v) * 3);
    }
    for (let q = 0; q < I.count; q++) idx[oi + q] = I.getX(q) + ov;
    ov += P.count;
    oi += I.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("color", new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

class Glove {
  constructor(THREE, side, res) {
    this.side = side;                              // +1 right, -1 left
    const root = (this.root = new THREE.Group());
    root.scale.x = side;                           // the left glove is the mirrored right one
    root.add(new THREE.Mesh(res.bodyGeo, res.bodyMat));
    // fingers: two segments each, bending at the knuckle and the middle joint
    // (local frame: wrist at 0, fingers towards -z, back of the hand +y)
    this.fingers = [];
    const F = [[-0.029, 0.04, 0.034, 0.0112], [-0.0098, 0.045, 0.037, 0.0118], [0.0098, 0.042, 0.034, 0.0112], [0.028, 0.033, 0.027, 0.0098]];
    for (const [x, l1, l2, rad] of F) {
      const base = new THREE.Group();
      base.position.set(x, 0.001, -0.088);
      const seg1 = new THREE.Mesh(res.capsule, res.gloveMat);
      seg1.scale.set(rad / 0.01, rad / 0.01, (l1 + rad) / 0.05);
      seg1.position.z = -l1 / 2;
      base.add(seg1);
      const mid = new THREE.Group();
      mid.position.z = -l1;
      const seg2 = new THREE.Mesh(res.capsule, res.gloveMat);
      seg2.scale.set(rad * 0.95 / 0.01, rad * 0.95 / 0.01, (l2 + rad) / 0.05);
      seg2.position.z = -l2 / 2;
      mid.add(seg2);
      base.add(mid);
      root.add(base);
      this.fingers.push({ base, mid });
    }
    // thumb, off the side of the palm
    const tb = (this.thumb = new THREE.Group());
    tb.position.set(-0.04, -0.006, -0.026);
    tb.rotation.set(-0.2, 0.85, -0.5);
    const t1 = new THREE.Mesh(res.capsule, res.gloveMat);
    t1.scale.set(1.3, 1.25, 0.048 / 0.05);
    t1.position.z = -0.02;
    tb.add(t1);
    const tm = (this.thumbMid = new THREE.Group());
    tm.position.z = -0.038;
    const t2 = new THREE.Mesh(res.capsule, res.gloveMat);
    t2.scale.set(1.2, 1.15, 0.04 / 0.05);
    t2.position.z = -0.016;
    tm.add(t2);
    tb.add(tm);
    root.add(tb);
    this.held = new THREE.Mesh(res.nuggetPlaceholder, res.gloveMat);   // replaced by the found nugget
    this.held.visible = false;
    this.held.position.set(0, -0.036, -0.055);
    root.add(this.held);
    // the forearm: stretched from the wrist to an elbow below the screen
    // edge every frame, so the arm always comes into view from below
    this.arm = new THREE.Mesh(res.armGeo, res.armMat);
    this.pose = clonePose(POSE.rest);
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  apply(pose, aspectK, extra) {
    const s = this.side, root = this.root;
    root.position.set(pose.p[0] * s * aspectK + extra.x * s, pose.p[1] + extra.y, pose.p[2]);
    root.rotation.set(pose.r[0] + extra.rx, pose.r[1] * s, pose.r[2] * s, "YXZ");
    const c = Math.max(0, Math.min(1, pose.c));
    this.fingers.forEach((f, i) => {
      const k = c * (1 - i * 0.04);
      f.base.rotation.x = -0.12 - k * 1.05;
      f.mid.rotation.x = -0.08 - k * 1.25;
    });
    this.thumbMid.rotation.x = -0.15 - c * 0.6;
    // forearm from just inside the cuff to the elbow anchor
    root.updateMatrix();
    const a = this._a.set(0, -0.004, 0.04).applyMatrix4(root.matrix);
    const b = this._b.set(ELBOW[0] * s * aspectK, ELBOW[1], ELBOW[2]);
    const arm = this.arm;
    arm.position.copy(a).add(b).multiplyScalar(0.5);
    const len = a.distanceTo(b);
    arm.quaternion.setFromUnitVectors(this._up, b.sub(a).normalize());
    arm.scale.set(1, len, 1);
  }
}

// where the forearms come from (view space, below the bottom edge of the screen)
const ELBOW = [0.27, -0.56, 0.06];

export class FirstPersonHands {
  constructor(THREE, { envMap } = {}) {
    this.THREE = THREE;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.01, 3);
    this.hemi = new THREE.HemisphereLight(0xb9d0ee, 0x86684a, 1.05);
    this.sun = new THREE.DirectionalLight(0xffecd0, 2.6);
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.envMap = envMap || null;

    // one body mesh per glove (palm + cuff + sleeve, vertex coloured), fingers separate
    const palm = new THREE.SphereGeometry(1, 20, 12);
    palm.scale(0.047, 0.021, 0.052);
    palm.translate(0, 0, -0.047);
    const knuckles = new THREE.CapsuleGeometry(0.0135, 0.058, 4, 12);
    knuckles.rotateZ(Math.PI / 2);
    knuckles.translate(0, 0.002, -0.086);
    const back = new THREE.SphereGeometry(1, 16, 10);          // padded back of the glove
    back.scale(0.04, 0.012, 0.042);
    back.translate(0, 0.012, -0.05);
    const cuff = new THREE.CylinderGeometry(0.04, 0.043, 0.04, 18, 1, false);
    cuff.rotateX(Math.PI / 2);
    cuff.translate(0, -0.002, 0.012);
    const rim = new THREE.TorusGeometry(0.041, 0.005, 8, 22);
    rim.translate(0, -0.002, -0.008);
    const leather = 0xc48d55, dark = 0xa87445, canvas = 0x8a5f3a;
    this.bodyGeo = mergeParts(THREE, [
      { g: palm, color: leather }, { g: knuckles, color: dark }, { g: back, color: 0xcf9860 }, { g: cuff, color: canvas }, { g: rim, color: 0x6e4a2c },
    ]);
    this.armGeo = new THREE.CylinderGeometry(0.034, 0.045, 1, 16, 1, true);
    this.armMat = new THREE.MeshStandardMaterial({ color: 0x7a6a55, roughness: 0.95, metalness: 0 });
    this.capsule = new THREE.CapsuleGeometry(0.01, 0.03, 4, 10);
    this.capsule.rotateX(Math.PI / 2);
    this.bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0 });
    this.gloveMat = new THREE.MeshStandardMaterial({ color: leather, roughness: 0.8, metalness: 0 });
    this.baseGlove = this.gloveMat.color.clone();
    this.dirtColor = new THREE.Color(0x6e4c30);
    this.nuggetPlaceholder = new THREE.SphereGeometry(1, 8, 6);
    const res = { bodyGeo: this.bodyGeo, bodyMat: this.bodyMat, gloveMat: this.gloveMat, capsule: this.capsule, nuggetPlaceholder: this.nuggetPlaceholder, armGeo: this.armGeo, armMat: this.armMat };
    this.right = new Glove(THREE, 1, res);
    this.left = new Glove(THREE, -1, res);
    this.scene.add(this.right.root, this.left.root, this.right.arm, this.left.arm);
    this.debugPose = null;                          // tuning aid: both hands frozen in one pose

    this.state = HAND_STATE.IDLE;
    this.t = 0;
    this.active = this.right;
    this.cycle = 0;
    this.recoverDur = 0.14;
    this.windupDur = 0.11;
    this.hit = "dirt";                              // what the last contact hit
    this.aspectK = 1;
    this.time = 0;
    this.sway = { x: 0, y: 0 };
    this.grab = 0;                                  // free-hand grab pulse (piece arrives)
    this.dirt = 0;
    this.visible = true;
    this.reducedMotion = false;
    this._from = clonePose(POSE.rest);
    this._tmp = clonePose(POSE.rest);
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this.inspecting = null;
  }

  setAspect(aspect, worldFov = 70) {
    this.camera.aspect = aspect;
    // follow the world camera: where it opens up (upright phones) the hands
    // get smaller instead of filling half the screen
    this.camera.fov = aspect < 0.9 ? Math.min(95, worldFov) : Math.max(55, Math.min(80, worldFov * 0.83));
    this.camera.updateProjectionMatrix();
    // narrow (portrait) screens: bring the hands in so they stay on screen
    this.aspectK = Math.max(0.42, Math.min(1, aspect / 1.6));
    this.portrait = aspect < 0.9;
  }

  // wantDig: the player holds dig and aims at the mound.
  // Returns "contact" in the frame the fingers touch the ground.
  tick(dt, wantDig) {
    this.time += dt;
    this.t += dt;
    let event = null;
    switch (this.state) {
      case HAND_STATE.IDLE:
        if (wantDig && !this.inspecting) this._startStroke();
        break;
      case HAND_STATE.WINDUP:
        if (this.t >= this.windupDur) { this.state = HAND_STATE.CONTACT; this.t = 0; event = "contact"; }
        break;
      case HAND_STATE.CONTACT:
        // one frame: the engine answered via react(); start recovering
        this.state = HAND_STATE.RECOVER;
        this.t = 0;
        break;
      case HAND_STATE.RECOVER:
        if (this.t >= this.recoverDur) {
          if (wantDig && !this.inspecting) this._startStroke();
          else { this.state = HAND_STATE.IDLE; this.t = 0; }
        }
        break;
      case HAND_STATE.INSPECT:
        if (this.t >= this.inspecting.dur) {
          const done = this.inspecting.done;
          this.right.held.visible = false;
          this.inspecting = null;
          this.state = HAND_STATE.IDLE;
          this.t = 0;
          if (done) done();
        }
        break;
      default: break;
    }
    if (this.grab > 0) this.grab = Math.max(0, this.grab - dt / 0.22);
    return event;
  }

  _startStroke() {
    this.cycle++;
    this.active = this.cycle % 2 ? this.right : this.left;
    this._from = clonePose(this.active.pose);
    this.state = HAND_STATE.WINDUP;
    this.t = 0;
    this.windupDur = 0.11 * (0.94 + ((this.cycle * 7919) % 13) / 100);   // a little life in the rhythm
  }

  // what the contact did: material recover time, "stone" bounces off,
  // "air" when nothing was in reach at the contact frame
  react(kind, recover) {
    this.hit = kind;
    this.recoverDur = recover * (0.95 + ((this.cycle * 104729) % 11) / 100);
    if (kind === "dirt") this.dirt = Math.min(1, this.dirt + 0.0035);
  }

  // hold a found nugget up in the right hand for a moment
  inspect(look, dur, done) {
    const h = this.right.held;
    h.geometry = look.geometry;
    h.material = look.material;
    h.scale.setScalar(Math.max(0.014, look.size * 0.8));
    h.visible = true;
    this.inspecting = { dur, done };
    this.state = HAND_STATE.INSPECT;
    this.t = 0;
    this.active = this.right;
    this._from = clonePose(this.right.pose);
  }

  pickupPulse() { this.grab = 1; }

  // camera turn this frame (radians) -> the hands lag a little behind
  look(dx, dy) {
    if (this.reducedMotion) return;
    this.sway.x = Math.max(-0.03, Math.min(0.03, this.sway.x - dx * 0.35));
    this.sway.y = Math.max(-0.03, Math.min(0.03, this.sway.y + dy * 0.35));
  }

  // per frame, after tick(): poses + lighting
  update(dt, { camera, sunDir, sunVisible, walk, bob }) {
    const rm = this.reducedMotion;
    // sway settles back
    const k = Math.exp(-dt * 9);
    this.sway.x *= k;
    this.sway.y *= k;
    const idle = POSE.rest;
    const act = this.active, other = act === this.right ? this.left : this.right;
    const target = this._tmp;
    const t = this.t;
    let activePose = null;
    if (this.state === HAND_STATE.WINDUP) {
      const u = Math.min(1, t / this.windupDur);
      activePose = u < 0.55 ? lerpPose(this._from, POSE.reach, easeOut(u / 0.55), target) : lerpPose(POSE.reach, POSE.contact, easeIn((u - 0.55) / 0.45), target);
    } else if (this.state === HAND_STATE.CONTACT) {
      activePose = lerpPose(POSE.contact, POSE.contact, 0, target);
    } else if (this.state === HAND_STATE.RECOVER) {
      const u = Math.min(1, t / this.recoverDur);
      if (this.hit === "stone") {
        // bounce off: a short jolt back, fingers open - nothing gives
        const j = Math.sin(u * Math.PI) * (1 - u);
        activePose = lerpPose(POSE.contact, POSE.recoil, easeOut(Math.min(1, u * 2.2)), target);
        if (!rm) activePose.p[0] += Math.sin(u * 40) * 0.006 * (1 - u);
        activePose.c = 0.1 + j * 0.1;
      } else if (this.hit === "air") {
        activePose = lerpPose(POSE.contact, idle, ease(u), target);
      } else {
        activePose = u < 0.6 ? lerpPose(POSE.contact, POSE.scrape, ease(u / 0.6), target) : lerpPose(POSE.scrape, idle, ease((u - 0.6) / 0.4), target);
      }
    } else if (this.state === HAND_STATE.INSPECT) {
      const d = this.inspecting.dur, u = t / d;
      const inP = lerpPose(this._from, POSE.inspect, ease(Math.min(1, u / 0.25)), target);
      if (u > 0.78) {
        lerpPose(POSE.inspect, idle, ease((u - 0.78) / 0.22), inP);
        inP.c = POSE.inspect.c + (0.95 - POSE.inspect.c) * ease(Math.min(1, (u - 0.78) / 0.12));
      }
      if (!rm) inP.r[2] += Math.sin(this.time * 2.2) * 0.05;
      this.right.held.rotation.y += dt * 1.6;
      activePose = inP;
    }
    const breathe = rm ? 0 : Math.sin(this.time * 1.3) * 0.003;
    const bobX = rm ? 0 : Math.sin(bob) * 0.008 * walk, bobY = rm ? 0 : -Math.abs(Math.cos(bob)) * 0.01 * walk;
    const low = this.portrait ? -0.05 : 0;             // upright phones: hands rest lower, rise for a stroke
    for (const g of [this.right, this.left]) {
      let pose;
      if (g === act && activePose) pose = activePose;
      else if (g === this.right && this.state === HAND_STATE.INSPECT) pose = activePose;
      else {
        // the free hand drifts back to rest (and grabs when a piece arrives)
        const p = g.pose, rest = idle;
        const f = 1 - Math.exp(-dt * 10);
        for (let i = 0; i < 3; i++) { p.p[i] += (rest.p[i] - p.p[i]) * f; p.r[i] += (rest.r[i] - p.r[i]) * f; }
        p.c += (rest.c + (g !== act ? this.grab * 0.55 : 0) - p.c) * f;
        pose = p;
      }
      if (pose !== g.pose) { g.pose.p = [...pose.p]; g.pose.r = [...pose.r]; g.pose.c = pose.c; }
      const restLow = (g !== act || this.state === HAND_STATE.IDLE) && this.state !== HAND_STATE.INSPECT ? low : 0;
      g.apply(this.debugPose || g.pose, this.aspectK, { x: this.sway.x + bobX, y: this.sway.y + bobY + breathe + restLow, rx: 0 });
    }
    // dust on the gloves builds up while digging
    this.gloveMat.color.copy(this.baseGlove).lerp(this.dirtColor, this.dirt * 0.55);
    // light: the world's sun, seen from the camera; dimmed in the mound's shadow
    this._q.copy(camera.quaternion).invert();
    this._v.copy(sunDir).applyQuaternion(this._q);
    this.sun.position.copy(this._v).multiplyScalar(4);
    this.sun.target.position.set(0, 0, 0);
    const want = sunVisible ? 2.6 : 0.55;
    this.sun.intensity += (want - this.sun.intensity) * (1 - Math.exp(-dt * 4));
  }

  render(renderer) {
    if (!this.visible) return;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.bodyGeo.dispose();
    this.armGeo.dispose();
    this.armMat.dispose();
    this.capsule.dispose();
    this.nuggetPlaceholder.dispose();
    this.bodyMat.dispose();
    this.gloveMat.dispose();
    this.scene.clear();
  }
}
