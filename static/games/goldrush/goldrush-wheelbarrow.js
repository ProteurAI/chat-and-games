// GoldRush - the wheelbarrow (phase 6): the first big transport. A real
// object on the claim with a real load (a MaterialBatch - the gold in it is
// whatever the dug slices held, nothing is re-rolled).
//
//   PARKED   stands on its wheel and two legs, fitted to the ground under
//            them; it blocks the way like any prop. Dig next to it and the
//            material goes in (goldrush-processing.js routes it).
//   PUSHED   you hold the grips (phase 8: goldrush-wheelbarrow-controller.js):
//            it is a world object with its own speed and turn rate - your
//            input asks, it answers (a full one is slow to start, to stop and
//            to turn; downhill it pulls); you stand behind its grips, within
//            arm's reach. The wheel rides the ground as it is; a wheel that
//            would climb a wall, hit a prop or a boulder, leave the claim or
//            take you somewhere you cannot stand simply does not go there.
//   DUMPED   at the sluice hopper it is tipped over the wheel: the tray
//            tilts, the load slides out (a visible moment), the batch goes
//            over with transfer() (goldrush-transfer.js: a sluice hopper or a
//            bulk hopper alike) - what does not fit stays in the barrow.
//
// No vehicle physics, no stamina: a few ground samples per frame.

import { MaterialBatch, STAGE } from "./goldrush-material.js";
import { transfer } from "./goldrush-transfer.js";
import { BARROW } from "./goldrush-mechmodels.js";
import { PushController, PUSH } from "./goldrush-wheelbarrow-controller.js";

export const BARROW_ML = 85000;                 // 85 l (tuned with the phase-6 benchmark)
const EMPTY_KG = 18;                            // the barrow itself
const FULL_KG = (BARROW_ML * 1.8) / 1000;       // full of gravel: ~153 kg
const PLAYER_R = 0.33;                          // where you stand behind it (the engine's player radius)
const MAX_GRADE = 0.62;                         // the wheel does not climb steeper than this (~32 deg) ...
const LIP = 0.1;                                // ... except a lip this high (it rolls over a clod, a dug edge) ...
const OVER_FEET = 0.08;                         // ... or ground no higher than this above your feet (out of a pit)
const MAX_DH = 0.95;                            // nor more than this above / below the ground you stand on (the grips stay in reach)
const TRAY_R = 0.46;                            // what a parked barrow blocks
const DUMP_S = 1.1;                             // tipping it over (s)
const finite = (v) => typeof v === "number" && Number.isFinite(v);

export class Wheelbarrow {
  /**
   * @param saved  doc.processing.wheelbarrow (v6) or null
   * @param at     where a new one waits ({ x, z, yaw })
   */
  constructor(THREE, scene, world, models, saved, at) {
    this.THREE = THREE;
    this.world = world;
    this.models = models;
    const s = saved || {};
    this.x = finite(s.x) ? s.x : at.x;
    this.z = finite(s.z) ? s.z : at.z;
    this.yaw = finite(s.yaw) ? s.yaw : at.yaw;
    this.batch = MaterialBatch.from(s.batch) || new MaterialBatch({ stage: STAGE.RAW });
    this.capacityMl = BARROW_ML;
    this.pushing = false;                       // a reload finds it parked where it was
    this.group = models.wheelbarrow();
    scene.add(this.group);
    this.collider = { type: "circle", x: 0, z: 0, r: TRAY_R };
    this.dump = null;                           // { t, target, onPeak, moved }
    this.theta = 0;
    this.roll = 0;
    this._fwd = { x: 0, z: 0 };
    this._fillSig = "";
    this.ctl = new PushController();
    this.fullKg = FULL_KG;
    this.walkSpeed = 3.4;                       // the engine's walking speed (top speed = this x speedFactor)
    this._standY = null;                        // the ground you stand on while holding it
    this.park();
    this.ctl.mode = "parked";
  }

  get massKg() { return this.batch.massG / 1000; }
  get volumeMl() { return this.batch.volumeMl; }
  get full() { return this.batch.volumeMl >= this.capacityMl - 200; }

  fwd(yaw = this.yaw) { this._fwd.x = -Math.sin(yaw); this._fwd.z = -Math.cos(yaw); return this._fwd; }

  // the tray's centre on the ground (interaction / collisions)
  trayCenter(out = {}) {
    const f = this.fwd(), d = BARROW.trayZ0 + (BARROW.trayZ1 - BARROW.trayZ0) / 2;
    out.x = this.x - f.x * d; out.z = this.z - f.z * d;
    return out;
  }

  // the grips (world, ground height ignored) - where you take hold
  gripsCenter(out = {}) {
    const f = this.fwd();
    out.x = this.x - f.x * BARROW.grip; out.z = this.z - f.z * BARROW.grip;
    return out;
  }

  // walking speed with it, from the load and the slope ahead (rise per metre, > 0 uphill)
  speedFactor(grade = 0) {
    const load = Math.min(1, this.massKg / FULL_KG);
    let f = 0.96 - 0.24 * load;                  // (phase 9 handling pass: full 0.72, was 0.66)
    if (grade > 0) f *= 1 - Math.min(0.5, grade) * (0.45 + 0.9 * load);
    else f *= 1 + Math.min(0.08, -grade * 0.2);
    return Math.max(0.42, Math.min(0.98, f));
  }

  // the tilt that puts the grips `rise` m above the wheel's ground (handles lifted)
  static pushTheta(rise) {
    const B = BARROW, R = Math.hypot(B.gripY, B.grip), phi = Math.atan2(B.gripY, B.grip);
    return Math.asin(Math.max(-0.95, Math.min(0.95, rise / R))) - phi;
  }

  /**
   * Where you stand while pushing it, the wheel at (x, z) heading yaw: behind
   * the grips (as far as the handles reach back at the push tilt), so the
   * grips are PUSH.gripAhead in front of your eyes - within arm's reach.
   */
  standFor(x, z, yaw, out = {}) {
    const B = BARROW, f = this.fwd(yaw);
    const gy = this.world.groundAt(x, z);
    const sy = this._standY != null ? this._standY : gy;
    const th = Wheelbarrow.pushTheta(sy + PUSH.handsY - gy);
    const back = B.grip * Math.cos(th) - B.gripY * Math.sin(th) - 0.07 + PUSH.gripAhead;
    out.x = x - f.x * back; out.z = z - f.z * back;
    return out;
  }

  /**
   * Could it be here (the wheel at x/z, heading yaw), you behind it? The
   * wheel must not climb a wall, the barrow must not run into a prop /
   * boulder / the fence, and where you would stand must be ground you can
   * stand on (not in a wall, not off the claim).
   */
  canPlace(x, z, yaw) {
    const b = this.world.bounds, W = this.world;
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return false;
    const g0 = W.groundAt(this.x, this.z), g1 = W.groundAt(x, z), d = Math.hypot(x - this.x, z - this.z);
    if (d > 1e-4) {
      // the slope it rolls onto, over a wheel's length ahead (a frame's step rises a few mm at most -
      // judged per step, nothing would ever be too steep): the pile's flank stops it, a lip does not,
      // and climbing back out of a pit to the ground you stand on is always possible
      const ux = (x - this.x) / d, uz = (z - this.z) / d, gA = Math.max(g1, W.groundAt(x + ux * 0.2, z + uz * 0.2));
      const feet = this._standY != null ? this._standY : g0;
      if ((gA - g0) / (d + 0.2) > MAX_GRADE && gA > g0 + LIP && gA > feet + OVER_FEET) return false;
    }
    const s = this.standFor(x, z, yaw, this._sp || (this._sp = {}));
    if (s.x < b.minX || s.x > b.maxX || s.z < b.minZ || s.z > b.maxZ) return false;
    // wheel and feet a whole frame apart in height (up a long slope, down into a pit): no further -
    // a move that brings them closer again is always allowed (so it never gets stuck)
    const cur = this.standFor(this.x, this.z, this.yaw, this._sc || (this._sc = {}));
    const ys = W.groundAt(s.x, s.z), yc = W.groundAt(cur.x, cur.z);
    const dhNow = Math.abs(g0 - yc), dhNew = Math.abs(g1 - ys);
    if (dhNew > MAX_DH && dhNew > dhNow + 1e-4) return false;
    // your feet: no wall to climb (the engine's walking limit) between where you stand and where you go
    const ds = Math.hypot(s.x - cur.x, s.z - cur.z);
    if (ds > 1e-4 && (ys - yc) / ds > 2.4 && ys > yc + 0.05) return false;
    const f = this.fwd(yaw), mid = BARROW.trayZ0 + (BARROW.trayZ1 - BARROW.trayZ0) / 2;
    const pts = [[x, z, 0.22], [x - f.x * mid, z - f.z * mid, 0.36], [s.x, s.z, PLAYER_R * 0.85]];
    for (const c of W.colliders) {
      if (c === this.collider) continue;
      for (const [px, pz, r] of pts) if (overlaps(c, px, pz, r)) return false;
    }
    return true;
  }

  // the slope the wheel is about to take (rise per metre ahead)
  gradeAhead() {
    const f = this.fwd(), W = this.world, g0 = W.groundAt(this.x, this.z);
    const g1 = W.groundAt(this.x + f.x * 0.3, this.z + f.z * 0.3), g2 = W.groundAt(this.x + f.x * 0.6, this.z + f.z * 0.6);
    return ((g1 - g0) / 0.3 + (g2 - g0) / 0.6) / 2;
  }

  // how rough the ground under the wheel is (0 smooth .. 1 very rough): bumps, not the slope
  roughness() {
    const W = this.world, x = this.x, z = this.z, h = 0.12;
    const c = W.groundAt(x, z);
    const cx = Math.abs(W.groundAt(x + h, z) + W.groundAt(x - h, z) - 2 * c), cz = Math.abs(W.groundAt(x, z + h) + W.groundAt(x, z - h) - 2 * c);
    return Math.min(1, Math.max(0, (cx + cz - 0.006) / 0.05));
  }

  // ---- states

  // take hold: the hands reach, the grips are taken, the legs leave the ground (controller)
  take() {
    this.pushing = true;
    this.ctl.take();
    const i = this.world.colliders.indexOf(this.collider);
    if (i >= 0) this.world.colliders.splice(i, 1);
  }

  // set it down: it stops, the handles go down onto the legs, the hands let go (controller);
  // for the game it stands from now on
  park() {
    this.pushing = false;
    this.ctl.park();
    const t = this.trayCenter(this._tc || (this._tc = {}));
    this.collider.x = t.x; this.collider.z = t.z;
    if (!this.world.colliders.includes(this.collider)) this.world.colliders.push(this.collider);
    this.fit();
  }

  /**
   * Pushing, one frame: input { fwd, turn } (the move keys / the stick), the
   * player p (its yaw = where you look). The barrow moves by itself (the
   * controller); you are put behind its grips. -> the controller's result
   */
  drive(dt, input, p) {
    const taking = this.ctl.mode === "taking";
    const r = this.ctl.step(dt, this, taking ? {} : input, p.yaw);
    const s = this.standFor(this.x, this.z, this.yaw, this._sd || (this._sd = {}));
    // taking hold: you step in behind the grips while the hands reach (no jump)
    const k = taking ? 1 - Math.exp(-dt * 14) : 1;
    const nx = p.x + (s.x - p.x) * k, nz = p.z + (s.z - p.z) * k;
    p.vx = (nx - p.x) / Math.max(1e-4, dt); p.vz = (nz - p.z) / Math.max(1e-4, dt);
    p.x = nx; p.z = nz;
    this._standY = this.world.groundAt(p.x, p.z);
    this.fit();
    return r;
  }

  /** the model on the ground: held (handles at your hands, by the lift) and / or parked (wheel + legs) */
  fit() {
    const G = this.group, B = BARROW, f = this.fwd(), c = this.ctl;
    const yw = this.world.groundAt(this.x, this.z);
    // parked: on the wheel and the two legs
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const lx = this.x - f.x * B.legZ, lz = this.z - f.z * B.legZ;
    const yl = this.world.groundAt(lx - rx * 0.23, lz - rz * 0.23), yr = this.world.groundAt(lx + rx * 0.23, lz + rz * 0.23);
    let theta = Math.atan2((yl + yr) / 2 - yw, B.legZ);
    let roll = Math.max(-0.25, Math.min(0.25, Math.atan2(yr - yl, 0.46)));
    if (c.lift > 0) {
      // held: the grips at your hands (the ground you stand on + PUSH.handsY), level - a little bump on rough ground
      const sy = this._standY != null ? this._standY : yw;
      const held = Wheelbarrow.pushTheta(sy + PUSH.handsY - yw) + c.bump * 0.035 * Math.sin(c.travel * 31) - c.surge * (0.012 + 0.03 * c.load);
      theta += (held - theta) * c.lift;
      roll += (c.bump * 0.04 * Math.sin(c.travel * 17) - roll) * c.lift;
    }
    if (this.dump) theta += Math.sin(Math.min(1, this.dump.t / DUMP_S) * Math.PI) * 0.75;
    this.theta = theta;
    this.roll = roll;
    G.position.set(this.x, yw, this.z);
    G.rotation.set(-theta, this.yaw, roll, "YXZ");
    if (G.userData.wheel) G.userData.wheel.rotation.x = -c.spin;
    G.updateMatrixWorld(true);
  }

  // the grips in world space (the gloves are put on them)
  gripWorld(side, out) {
    out.set(side * BARROW.gripX, BARROW.gripY + 0.02, BARROW.grip - 0.07);
    return out.applyMatrix4(this.group.matrixWorld);
  }

  // ---- dumping over the wheel into `target` ({ batch, capacityMl })
  startDump(target, onPeak, id = 0) {
    if (this.dump || this.batch.volumeMl <= 0) return false;
    this.dump = { t: 0, target, onPeak, moved: -1, id };
    return true;
  }

  // per frame: the dump animation (the material goes over at the top of the tilt); setting it down
  update(dt) {
    if (this.dump) {
      const d = this.dump;
      d.t += dt;
      if (d.moved < 0 && d.t >= DUMP_S * 0.5) {
        d.moved = transfer(this, d.target, Infinity, d.id);
        if (d.onPeak) d.onPeak(d.moved);
      }
      if (d.t >= DUMP_S) this.dump = null;
    }
    if (!this.pushing && this.ctl.mode === "parking") this.ctl.animate(dt);
    if (this.dump || this.ctl.mode === "parking" || !this.pushing) this.fit();
    this._fills();
  }

  // the grips you hold (for the hands): both hands on them, how much (0..1)
  get handsOn() { return this.ctl.grip; }

  // the right grip's handle point in the barrow's own frame (the left one is mirrored)
  gripLocal() { return this._gl || (this._gl = [BARROW.gripX, BARROW.gripY + 0.02, BARROW.grip - 0.07]); }

  _fills() {
    const b = this.batch, frac = Math.min(1, b.volumeMl / this.capacityMl);
    const sig = `${b.volumeMl}:${b.massG}`;
    if (sig === this._fillSig) return;
    this._fillSig = sig;
    this.models.setBarrowFill(this.group, frac, b.massG > 0 ? b.comp : null);
  }

  serialize() {
    return { x: this.x, z: this.z, yaw: this.yaw, batch: this.batch.serialize() };
  }

  // tests / devtools: the push state
  state() {
    const c = this.ctl;
    return { mode: c.mode, v: c.v, w: c.w, spin: c.spin, travel: c.travel, grip: c.grip, lift: c.lift, rough: c.rough, theta: this.theta, roll: this.roll,
      x: this.x, z: this.z, yaw: this.yaw, wheelY: this.world.groundAt(this.x, this.z), loadKg: this.massKg };
  }

  dispose(scene) {
    const i = this.world.colliders.indexOf(this.collider);
    if (i >= 0) this.world.colliders.splice(i, 1);
    scene.remove(this.group);
  }
}

// a collider (circle / rotated box) overlapping a circle at (x, z) of radius r
export function overlaps(c, x, z, r) {
  if (c.type === "circle") return Math.hypot(x - c.x, z - c.z) < c.r + r;
  const cs = Math.cos(-c.rot), sn = Math.sin(-c.rot);
  const lx = (x - c.x) * cs - (z - c.z) * sn, lz = (x - c.x) * sn + (z - c.z) * cs;
  const dx = lx - Math.max(-c.hw, Math.min(c.hw, lx)), dz = lz - Math.max(-c.hd, Math.min(c.hd, lz));
  return Math.hypot(dx, dz) < r;
}

export { EMPTY_KG, FULL_KG };
