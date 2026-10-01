// GoldRush - the first-person view model: two work gloves and the tool in
// them, modelled here from simple shapes (no external asset), drawn in
// their own small pass on top of the world so they never clip into the
// mound, and lit by the same sun as the world.
//
// The rhythm is NOT decided here: the ToolController (goldrush-tools.js)
// runs every action through its phases (hand: windup -> contact ->
// recover; shovel: windup -> thrust -> contact -> scoop -> dump -> recover;
// pickaxe: raise -> swing -> contact -> recoil -> recover) and this module
// only poses hands and tool from controller.view() each frame:
//   - bare hands: the two gloves take turns, reach to the ground, scrape
//     back (dirt) or bounce off (stone)
//   - shovel / pickaxe: the tool follows keyframes per phase, the gloves
//     sit ON its grips (fingers closed round the handle) and the forearms
//     follow them
// A found nugget is held up in the right hand for a moment (inspect); the
// controller is blocked meanwhile. Switching tools lowers the old one out
// of view and raises the new one.

import { ToolModels } from "./goldrush-toolmodels.js";

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

// Tool poses: where the tool's own origin sits in view space and how it is
// turned (Euler YXZ: x pitch, y yaw, z roll). Tool frame: handle along -z
// (grip end near the player), working end "up" = +y (goldrush-toolmodels.js).
// (Computed from where the right hand should be and where the tool should
// point - scratch helper, then checked on screenshots.)
export const TOOL_KEYS = {
  shovel: {
    rest: { p: [-0.001, -0.299, -0.818], r: [-0.221, 0.585, 0.15] },
    windup: { p: [0.043, -0.183, -0.774], r: [-0.094, 0.502, 0.2] },      // pulled back, blade up
    thrust: { p: [-0.002, -0.433, -0.996], r: [-0.416, 0.428, 0.1] },     // driven in, forward and down
    scoop: { p: [-0.011, -0.346, -0.886], r: [-0.103, 0.54, 0.05] },      // handle pressed down: the load comes up
    dump: { p: [0.34, -0.27, -0.84], r: [-0.2, -0.3, 1.72] },             // swung well aside and tipped right over (held a moment)
    recoil: { p: [0.043, -0.188, -0.765], r: [-0.151, 0.532, 0.25] },     // stone: thrown back
    held: { p: [-0.084, -0.544, -0.851], r: [-0.37, 0.588, 0.3] },        // one hand only (inspect)
  },
  pickaxe: {
    rest: { p: [0.202, -0.235, -0.523], r: [0.115, 0.301, -1.3] },        // held low and ready, head turned to show
    raise: { p: [0.247, 0.021, -0.312], r: [1.955, 0.138, 0] },           // over the shoulder, point forward
    swing: { p: [0.055, -0.219, -0.605], r: [0.243, 0.116, 0] },          // point in the ground ahead
    recoil: { p: [0.077, -0.158, -0.574], r: [0.494, 0.118, 0] },
    held: { p: [0.192, -0.331, -0.587], r: [0.072, 0.219, -1.2] },
  },
};

// which key a phase moves towards (and its easing)
const PHASE_KEY = {
  shovel: { windup: ["windup", "out"], thrust: ["thrust", "in"], scoop: ["scoop", "inout"], dump: ["dump", "inout"], recover: ["rest", "inout"], recoil: ["recoil", "out"] },
  pickaxe: { raise: ["raise", "inout"], swing: ["swing", "in"], recoil: ["recoil", "out"], recover: ["rest", "inout"] },
};

// How a glove holds a grip, as if it were the RIGHT hand (the left one is
// the mirror image): pos on the tool, the handle axis there ("z" shaft,
// "x" cross bar), roll of the hand round the handle, flip = which way the
// thumb points along it. Tuned on screenshots.
export const GRIPS = {
  shovel: [
    { side: 1, pos: [0, 0, 0.452], axis: "x", roll: 0.35, flip: 1 },        // right hand on the D-grip
    { side: -1, pos: [0, 0, 0.05], axis: "z", roll: 2.5, flip: 1 },        // left hand under the shaft
  ],
  pickaxe: [
    { side: 1, pos: [0, 0, 0.13], axis: "z", roll: 2.3, flip: 1 },
    { side: -1, pos: [0, 0, 0.25], axis: "z", roll: 2.3, flip: 1, freeAtRest: true },   // joins for the swing
  ],
};
const HANDLE_IN_GLOVE = [0, -0.03, -0.072];      // where a held handle runs through the closed glove

const ease = (t) => t * t * (3 - 2 * t);
// a stable pseudo-random number per stroke (variation that never touches timing or aim)
const vary = (n, salt) => { let h = Math.imul(n ^ salt, 0x45d9f3b); h = Math.imul(h ^ (h >>> 16), 0x45d9f3b); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const easeIn = (t) => t * t;
const easeOut = (t) => 1 - (1 - t) * (1 - t);
const EASE = { in: easeIn, out: easeOut, inout: ease };

function lerpPose(a, b, t, out) {
  for (let i = 0; i < 3; i++) {
    out.p[i] = a.p[i] + (b.p[i] - a.p[i]) * t;
    out.r[i] = a.r[i] + (b.r[i] - a.r[i]) * t;
  }
  if (a.c != null) out.c = a.c + (b.c - a.c) * t;
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
    this._m = new THREE.Matrix4();
  }

  _curl(c, thumb = 0.6) {
    c = Math.max(0, Math.min(1, c));
    this.fingers.forEach((f, i) => {
      const k = c * (1 - i * 0.04);
      f.base.rotation.x = -0.12 - k * 1.05;
      f.mid.rotation.x = -0.08 - k * 1.25;
    });
    this.thumbMid.rotation.x = -0.15 - c * thumb;
  }

  // bare-hand pose (view space)
  apply(pose, aspectK, extra) {
    const s = this.side, root = this.root;
    root.position.set(pose.p[0] * s * aspectK + extra.x * s, pose.p[1] + extra.y, pose.p[2]);
    root.rotation.set(pose.r[0] + extra.rx, pose.r[1] * s, pose.r[2] * s, "YXZ");
    root.scale.set(s, 1, 1);
    this.thumb.rotation.set(-0.2, 0.85, -0.5);
    this._curl(pose.c);
    root.updateMatrix();
    this._arm(aspectK);
  }

  // on a tool grip: m = the glove's full matrix (incl. the mirror)
  applyMatrix(m, aspectK, curl = 0.95) {
    const root = this.root;
    m.decompose(root.position, root.quaternion, root.scale);
    this.thumb.rotation.set(-0.55, 0.55, -0.9);               // thumb closed over the handle
    this._curl(curl, 0.9);
    root.updateMatrix();
    this._arm(aspectK);
  }

  // forearm from just inside the cuff to the elbow anchor
  _arm(aspectK) {
    const s = this.side;
    const a = this._a.set(0, -0.004, 0.04).applyMatrix4(this.root.matrix);
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
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.01, 4);
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

    // the tools (shared models, only the equipped one is shown)
    this.models = new ToolModels(THREE, { envMap });
    this.toolRoot = new THREE.Group();
    this.toolRoot.add(this.models.shovel, this.models.pickaxe);
    this.toolRoot.rotation.order = "YXZ";
    this.scene.add(this.toolRoot);
    this.tool = "hand";
    this._showTool("hand");

    this.debugPose = null;                          // tuning aid: both hands frozen in one pose
    this.debugToolPose = null;                      // tuning aid: the tool frozen in one pose
    this.aspectK = 1;
    this.time = 0;
    this.sway = { x: 0, y: 0 };
    this.grab = 0;                                  // free-hand grab pulse (piece arrives)
    this.dirt = 0;
    this.load = 0;                                  // soil on the shovel blade, 0..1
    this.visible = true;
    this.reducedMotion = false;
    this.hit = "ok";                                // what the last contact hit: ok | blocked | air
    this.hitMat = 0;
    this.shake = 0;                                 // recoil shake left (s)
    this._phaseSig = "";
    this._from = clonePose(POSE.rest);
    this._tmp = clonePose(POSE.rest);
    this._toolPose = clonePose(TOOL_KEYS.shovel.rest);
    this._toolFrom = clonePose(TOOL_KEYS.shovel.rest);
    this._toolTmp = clonePose(TOOL_KEYS.shovel.rest);
    this._activeSide = 1;
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this._g = new THREE.Matrix4();
    this._mx = new THREE.Matrix4().makeScale(-1, 1, 1);
    this._pa = new THREE.Vector3();
    this._qa = new THREE.Quaternion();
    this._freeW = 0;
    this._bx = new THREE.Vector3();
    this._by = new THREE.Vector3();
    this._bz = new THREE.Vector3();
    this.inspecting = null;
    this.state = "idle";                            // mirrors the controller (tests / debug)
    this.phase = null;
  }

  _showTool(id) {
    this.tool = id;
    this.models.shovel.visible = id === "shovel";
    this.models.pickaxe.visible = id === "pickaxe";
    this.toolRoot.visible = id !== "hand";
    const keys = TOOL_KEYS[id];
    if (keys) { this._toolPose = clonePose(keys.rest); this._toolFrom = clonePose(keys.rest); }
  }

  get toolModel() { return this.tool === "shovel" ? this.models.shovel : this.tool === "pickaxe" ? this.models.pickaxe : null; }

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

  // what the contact did: "ok" (material came off), "blocked" (bounced off
  // stone / a boulder), "air" (nothing in reach any more); massKg for the
  // load on a shovel
  contact(kind, mat = 0, massKg = 0) {
    this.hit = kind;
    this.hitMat = mat;
    if (kind === "ok") {
      this.dirt = Math.min(1, this.dirt + (this.tool === "hand" ? 0.0035 : 0.002));
      if (this.tool === "shovel") this.load = Math.min(1, massKg / 2.2);
    } else if (kind === "blocked") {
      this.shake = this.reducedMotion ? 0 : 0.22;
    }
  }

  // hold a found nugget up in the right hand for a moment (a second one
  // arriving meanwhile takes over - the first is booked right away, never
  // left hanging)
  inspect(look, dur, done) {
    if (this.inspecting) this.endInspect();
    const h = this.right.held;
    h.geometry = look.geometry;
    h.material = look.material;
    h.scale.setScalar(Math.max(0.014, look.size * 0.8));
    h.visible = true;
    this.inspecting = { dur, done, t: 0 };
    this._from = clonePose(this.right.pose);
  }

  // end an inspect right now (flush on exit / hidden tab)
  endInspect() {
    const ins = this.inspecting;
    if (!ins) return;
    this.inspecting = null;
    this.right.held.visible = false;
    if (ins.done) ins.done();
  }

  pickupPulse() { this.grab = 1; }

  // camera turn this frame (radians) -> the hands lag a little behind
  look(dx, dy) {
    if (this.reducedMotion) return;
    this.sway.x = Math.max(-0.03, Math.min(0.03, this.sway.x - dx * 0.35));
    this.sway.y = Math.max(-0.03, Math.min(0.03, this.sway.y + dy * 0.35));
  }

  /**
   * Per frame: pose hands and tool from the controller's view
   * (goldrush-tools.js ToolController.view()) + lighting.
   */
  update(dt, view, { camera, sunDir, sunVisible, walk, bob }) {
    const rm = this.reducedMotion;
    this.time += dt;
    if (this.grab > 0) this.grab = Math.max(0, this.grab - dt / 0.22);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt);
    if (this.inspecting) {
      this.inspecting.t += dt;
      if (this.inspecting.t >= this.inspecting.dur) this.endInspect();
    }
    if (view.tool !== this.tool) this._showTool(view.tool);
    this.state = view.state;
    this.phase = view.phase;
    // sway settles back
    const k = Math.exp(-dt * 9);
    this.sway.x *= k;
    this.sway.y *= k;
    // lowering / raising while switching tools
    const sw = view.state === "lower" ? ease(view.switchU) : view.state === "raise" ? 1 - ease(view.switchU) : 0;
    const breathe = rm ? 0 : Math.sin(this.time * 1.3) * 0.003;
    const bobX = rm ? 0 : Math.sin(bob) * 0.008 * walk, bobY = rm ? 0 : -Math.abs(Math.cos(bob)) * 0.01 * walk;
    const extra = { x: this.sway.x + bobX, y: this.sway.y + bobY + breathe - sw * 0.42, rx: -sw * 0.5 };
    if (this.tool === "hand") this._updateHands(dt, view, extra);
    else this._updateTool(dt, view, extra);
    // dust on the gloves builds up while digging
    this.gloveMat.color.copy(this.baseGlove).lerp(this.dirtColor, this.dirt * 0.55);
    this.models.setDirt(this.dirt);
    // light: the world's sun, seen from the camera; dimmed in the mound's shadow
    this._q.copy(camera.quaternion).invert();
    this._v.copy(sunDir).applyQuaternion(this._q);
    this.sun.position.copy(this._v).multiplyScalar(4);
    this.sun.target.position.set(0, 0, 0);
    const want = sunVisible ? 2.6 : 0.55;
    this.sun.intensity += (want - this.sun.intensity) * (1 - Math.exp(-dt * 4));
  }

  // ---- bare hands: alternate strokes
  _updateHands(dt, view, extra) {
    const rm = this.reducedMotion, idle = POSE.rest, target = this._tmp;
    const sig = `${view.cycle}`;
    if (view.state === "action" && sig !== this._phaseSig) {
      this._phaseSig = sig;
      // the hands take turns - not like a machine: now and then the same hand twice
      const n = view.cycle;
      this._activeSide = n === 1 ? 1 : vary(n, 11) < 0.18 ? this._activeSide : -this._activeSide;
      this._from = clonePose((this._activeSide === 1 ? this.right : this.left).pose);
      // where and how this stroke lands: a little different each time, by material
      const m = this.hitMat;
      const reachK = m === 1 ? 1.12 : m === 2 ? 0.92 : 1;            // compact: deeper, gravel: shorter
      this._var = {
        dx: (vary(n, 3) - 0.5) * 0.026, dy: (vary(n, 5) - 0.5) * 0.016, dz: (vary(n, 7) - 0.5) * 0.02,
        roll: (vary(n, 13) - 0.5) * 0.14, yaw: (vary(n, 17) - 0.5) * 0.1, curl: (vary(n, 19) - 0.5) * 0.16 + (m === 2 ? -0.12 : m === 1 ? 0.08 : 0),
        reach: reachK, scrapeOut: 0.85 + vary(n, 23) * 0.3,
      };
    }
    const act = this._activeSide === 1 ? this.right : this.left;
    let activePose = null;
    const V = this._var || { dx: 0, dy: 0, dz: 0, roll: 0, yaw: 0, curl: 0, reach: 1, scrapeOut: 1 };
    if (view.state === "action" && view.phase === "windup") {
      const u = view.u;
      activePose = u < 0.55 ? lerpPose(this._from, POSE.reach, easeOut(u / 0.55), target) : lerpPose(POSE.reach, POSE.contact, easeIn((u - 0.55) / 0.45), target);
      // this stroke's own contact point and angle (grows in with the reach)
      const k = rm ? 0 : ease(u);
      activePose.p[0] += V.dx * k; activePose.p[1] += (V.dy - (V.reach - 1) * 0.05) * k; activePose.p[2] += (V.dz - (V.reach - 1) * 0.06) * k;
      activePose.r[2] += V.roll * k; activePose.r[1] += V.yaw * k; activePose.c += V.curl * k;
    } else if (view.state === "action" && view.phase === "recover") {
      const u = view.u;
      if (this.hit === "blocked") {
        // bounce off: a short jolt back, fingers open - nothing gives
        const j = Math.sin(u * Math.PI) * (1 - u);
        activePose = lerpPose(POSE.contact, POSE.recoil, easeOut(Math.min(1, u * 2.2)), target);
        if (!rm) activePose.p[0] += Math.sin(u * 40) * 0.006 * (1 - u);
        activePose.c = 0.1 + j * 0.1;
      } else if (this.hit === "air") {
        activePose = lerpPose(POSE.contact, idle, ease(u), target);
      } else {
        activePose = u < 0.6 ? lerpPose(POSE.contact, POSE.scrape, ease(u / 0.6), target) : lerpPose(POSE.scrape, idle, ease((u - 0.6) / 0.4), target);
        // the scrape back differs a little stroke to stroke, fading out towards rest
        const k = rm ? 0 : Math.sin(Math.min(1, u / 0.8) * Math.PI);
        activePose.p[0] += V.dx * 0.6 * k; activePose.p[2] += (V.scrapeOut - 1) * 0.05 * k; activePose.r[2] += V.roll * 0.6 * k; activePose.c += V.curl * 0.5 * k;
      }
    }
    let inspectPose = null;
    if (this.inspecting) inspectPose = this._inspectPose(dt);
    const low = this.portrait ? -0.05 : 0;             // upright phones: hands rest lower, rise for a stroke
    for (const g of [this.right, this.left]) {
      let pose;
      if (g === this.right && inspectPose) pose = inspectPose;
      else if (g === act && activePose) pose = activePose;
      else {
        // the free hand drifts back to rest (and grabs when a piece arrives)
        const p = g.pose, rest = idle;
        const f = 1 - Math.exp(-dt * 10);
        for (let i = 0; i < 3; i++) { p.p[i] += (rest.p[i] - p.p[i]) * f; p.r[i] += (rest.r[i] - p.r[i]) * f; }
        p.c += (rest.c + (g !== act ? this.grab * 0.55 : 0) - p.c) * f;
        pose = p;
      }
      if (pose !== g.pose) { g.pose.p = [...pose.p]; g.pose.r = [...pose.r]; g.pose.c = pose.c; }
      const busy = (g === act && view.state === "action") || (g === this.right && inspectPose);
      g.apply(this.debugPose || g.pose, this.aspectK, { x: extra.x, y: extra.y + (busy ? 0 : low), rx: extra.rx });
    }
  }

  _inspectPose(dt) {
    const ins = this.inspecting, d = ins.dur, u = ins.t / d, rm = this.reducedMotion;
    const inP = lerpPose(this._from, POSE.inspect, ease(Math.min(1, u / 0.25)), clonePose(POSE.inspect));
    if (u > 0.78) {
      lerpPose(POSE.inspect, POSE.rest, ease((u - 0.78) / 0.22), inP);
      inP.c = POSE.inspect.c + (0.95 - POSE.inspect.c) * ease(Math.min(1, (u - 0.78) / 0.12));
    }
    if (!rm) inP.r[2] += Math.sin(this.time * 2.2) * 0.05;
    this.right.held.rotation.y += dt * 1.6;
    return inP;
  }

  // ---- shovel / pickaxe: the tool follows its keyframes, the gloves its grips
  _updateTool(dt, view, extra) {
    const id = this.tool, keys = TOOL_KEYS[id], rm = this.reducedMotion;
    const pose = this._toolPose;
    const inspecting = !!this.inspecting;
    const sig = `${view.state}:${view.phase}:${view.cycle}`;
    if (sig !== this._phaseSig) { this._phaseSig = sig; this._toolFrom = clonePose(pose); }
    if (this.debugToolPose) {
      pose.p = [...this.debugToolPose.p];
      pose.r = [...this.debugToolPose.r];
    } else if (view.state === "action" && PHASE_KEY[id][view.phase]) {
      const [key, e] = PHASE_KEY[id][view.phase];
      lerpPose(this._toolFrom, keys[key], EASE[e](view.u), pose);
    } else {
      // idle: settle to rest (or the one-handed hold while the right hand shows a nugget)
      const rest = inspecting ? keys.held : keys.rest;
      const f = 1 - Math.exp(-dt * 8);
      for (let i = 0; i < 3; i++) { pose.p[i] += (rest.p[i] - pose.p[i]) * f; pose.r[i] += (rest.r[i] - pose.r[i]) * f; }
    }
    // the shovel's load: on the blade from the contact until it is tipped off
    if (id === "shovel") {
      if (view.phase === "dump" && view.u > 0.45) this.load = 0;
      if (view.state !== "action" && !(view.phase === "dump")) this.load = Math.max(0, this.load - dt * 4);
      const soil = this.models.soil;
      soil.visible = this.load > 0.02;
      if (soil.visible) soil.scale.set(0.5 + this.load * 0.55, 0.35 + this.load * 0.75, 0.5 + this.load * 0.55);
    }
    const shake = this.shake > 0 ? Math.sin(this.time * 70) * 0.012 * (this.shake / 0.22) : 0;
    const T = this.toolRoot;
    T.position.set(pose.p[0] * this.aspectK + extra.x + shake, pose.p[1] + extra.y, pose.p[2]);
    T.rotation.set(pose.r[0] + extra.rx + (rm ? 0 : shake * 2), pose.r[1], pose.r[2]);
    T.updateMatrix();
    T.updateMatrixWorld(true);
    // gloves on the grips (the right one may be away, showing a nugget)
    for (const grip of GRIPS[id]) {
      const g = grip.side === 1 ? this.right : this.left;
      if (grip.side === 1 && inspecting) {
        const ip = this._inspectPose(dt);
        g.pose.p = [...ip.p]; g.pose.r = [...ip.r]; g.pose.c = ip.c;
        g.apply(ip, this.aspectK, extra);
        continue;
      }
      let w = 1;
      if (grip.freeAtRest) {
        const want = view.state === "action" ? 1 : 0;
        this._freeW += (want - this._freeW) * (1 - Math.exp(-dt * (want ? 14 : 6)));
        w = this._freeW;
      }
      if (w < 0.999) {
        // this hand lets go between actions: its bare-hand rest pose, blended
        g.apply(POSE.rest, this.aspectK, extra);
        this._pa.copy(g.root.position); this._qa.copy(g.root.quaternion);
        g.applyMatrix(this._gripMatrix(grip, this._g), this.aspectK, 0.97 * w + POSE.rest.c * (1 - w));
        g.root.position.lerpVectors(this._pa, g.root.position, w);
        g.root.quaternion.slerpQuaternions(this._qa, g.root.quaternion.clone(), w);
        g.root.updateMatrix();
        g._arm(this.aspectK);
      } else g.applyMatrix(this._gripMatrix(grip, this._g), this.aspectK, 0.97);
      // keep the bare-hand pose in sync for a smooth hand-over later
      g.pose = clonePose(POSE.rest);
    }
  }

  // the glove matrix for a grip (view space), incl. the mirror for the left hand
  _gripMatrix(grip, out) {
    const bx = this._bx, by = this._by, bz = this._bz, f = grip.flip || 1, ph = grip.roll || 0;
    if (grip.axis === "x") { bx.set(f, 0, 0); by.set(0, Math.cos(ph), -Math.sin(ph)); }
    else { bx.set(0, 0, f); by.set(-Math.sin(ph), Math.cos(ph), 0); }
    bz.crossVectors(bx, by);
    const m = out.makeBasis(bx, by, bz);
    // the handle centre in the glove lands on the grip point
    const h = this._v.set(HANDLE_IN_GLOVE[0], HANDLE_IN_GLOVE[1], HANDLE_IN_GLOVE[2]).applyMatrix4(m);
    m.setPosition(grip.pos[0] - h.x, grip.pos[1] - h.y, grip.pos[2] - h.z);
    if (grip.side === -1) m.premultiply(this._mx).multiply(this._mx);
    return m.premultiply(this.toolRoot.matrix);
  }

  // tests: largest distance between a glove's closed fist and its grip
  // point on the tool (hands that are free right now are skipped), m
  gripError() {
    if (this.tool === "hand") return 0;
    let worst = 0;
    const tmp = this._pa.clone(), tgt = this._pa.clone();
    for (const grip of GRIPS[this.tool]) {
      if (grip.freeAtRest && this._freeW < 0.999) continue;
      if (grip.side === 1 && this.inspecting) continue;
      const g = grip.side === 1 ? this.right : this.left;
      g.root.updateMatrix();
      tmp.set(HANDLE_IN_GLOVE[0], HANDLE_IN_GLOVE[1], HANDLE_IN_GLOVE[2]).applyMatrix4(g.root.matrix);
      tgt.set(grip.pos[0], grip.pos[1], grip.pos[2]).applyMatrix4(this.toolRoot.matrix);
      worst = Math.max(worst, tmp.distanceTo(tgt));
    }
    return worst;
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
    this.models.dispose();
    this.scene.clear();
  }
}
