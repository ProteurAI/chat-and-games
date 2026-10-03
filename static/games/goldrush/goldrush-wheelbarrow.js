// GoldRush - the wheelbarrow (phase 6): the first big transport. A real
// object on the claim with a real load (a MaterialBatch - the gold in it is
// whatever the dug slices held, nothing is re-rolled).
//
//   PARKED   stands on its wheel and two legs, fitted to the ground under
//            them; it blocks the way like any prop. Dig next to it and the
//            material goes in (goldrush-processing.js routes it).
//   PUSHED   you hold the grips: it rolls ahead of you on its wheel, the
//            handles at your hands' height - pitch from the ground under the
//            wheel. Slower the heavier it is and the steeper uphill; a wheel
//            that would have to climb a wall, hit a prop or a boulder, or
//            leave the claim simply does not go there.
//   DUMPED   at the sluice hopper it is tipped over the wheel: the tray
//            tilts, the load slides out (a visible moment), the batch goes
//            over with transfer() (goldrush-transfer.js: a sluice hopper or a
//            bulk hopper alike) - what does not fit stays in the barrow.
//
// No vehicle physics, no stamina: a few ground samples per frame.

import { MaterialBatch, STAGE } from "./goldrush-material.js";
import { transfer } from "./goldrush-transfer.js";
import { BARROW } from "./goldrush-mechmodels.js";

export const BARROW_ML = 85000;                 // 85 l (tuned with the phase-6 benchmark)
const EMPTY_KG = 18;                            // the barrow itself
const FULL_KG = (BARROW_ML * 1.8) / 1000;       // full of gravel: ~153 kg
const GRIP_AHEAD = 0.85;                        // the grips this far in front of you while pushing
const HANDS_Y = 0.8;                            // ... this high above the ground you stand on
const MAX_GRADE = 0.62;                         // the wheel does not climb steeper than this (~32 deg)
const MAX_DH = 0.95;                            // nor more than this above / below the ground you stand on (the grips stay in reach)
const TRAY_R = 0.46;                            // what a parked barrow blocks
const DUMP_S = 1.1;                             // tipping it over (s)
const MAT_RGB = [[0.55, 0.4, 0.27], [0.47, 0.33, 0.22], [0.55, 0.5, 0.43], [0.5, 0.48, 0.45]];
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
    this._fwd = { x: 0, z: 0 };
    this._fillSig = "";
    this.park();
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
    let f = 0.96 - 0.3 * load;
    if (grade > 0) f *= 1 - Math.min(0.5, grade) * (0.45 + 0.9 * load);
    else f *= 1 + Math.min(0.08, -grade * 0.2);
    return Math.max(0.42, Math.min(0.98, f));
  }

  // where the wheel is when the player stands at (px, pz) facing yaw
  wheelFor(px, pz, yaw, out = {}) {
    const f = this.fwd(yaw), d = GRIP_AHEAD + BARROW.grip;
    out.x = px + f.x * d; out.z = pz + f.z * d;
    return out;
  }

  /**
   * Can it roll there (the player at px/pz facing yaw)? The wheel must not
   * climb a wall, the barrow must not run into a prop / boulder / the fence.
   */
  canGo(px, pz, yaw) {
    const w = this.wheelFor(px, pz, yaw, this._w || (this._w = {}));
    const b = this.world.bounds;
    if (w.x < b.minX || w.x > b.maxX || w.z < b.minZ || w.z > b.maxZ) return false;
    const g0 = this.world.groundAt(this.x, this.z), g1 = this.world.groundAt(w.x, w.z), d = Math.hypot(w.x - this.x, w.z - this.z);
    if (d > 1e-4 && (g1 - g0) / d > MAX_GRADE && g1 > g0 + 0.03) return false;
    // wheel and grips a whole frame apart in height (up a long slope, down into a pit): no further -
    // a move that brings them closer again is always allowed (so it never gets stuck)
    const f0 = this.fwd(), dp = GRIP_AHEAD + BARROW.grip;
    const dhNow = Math.abs(g0 - this.world.groundAt(this.x - f0.x * dp, this.z - f0.z * dp)), dhNew = Math.abs(g1 - this.world.groundAt(px, pz));
    if (dhNew > MAX_DH && dhNew > dhNow + 1e-4) return false;
    const f = this.fwd(yaw), mid = BARROW.trayZ0 + (BARROW.trayZ1 - BARROW.trayZ0) / 2;
    const pts = [[w.x, w.z, 0.22], [w.x - f.x * mid, w.z - f.z * mid, 0.36]];
    for (const c of this.world.colliders) {
      if (c === this.collider) continue;
      for (const [x, z, r] of pts) if (overlaps(c, x, z, r)) return false;
    }
    return true;
  }

  // the slope the wheel is about to take (rise per metre ahead)
  gradeAhead() {
    const f = this.fwd(), g0 = this.world.groundAt(this.x, this.z), g1 = this.world.groundAt(this.x + f.x * 0.35, this.z + f.z * 0.35);
    return (g1 - g0) / 0.35;
  }

  // ---- states

  take() {
    this.pushing = true;
    const i = this.world.colliders.indexOf(this.collider);
    if (i >= 0) this.world.colliders.splice(i, 1);
  }

  park() {
    this.pushing = false;
    const t = this.trayCenter(this._tc || (this._tc = {}));
    this.collider.x = t.x; this.collider.z = t.z;
    if (!this.world.colliders.includes(this.collider)) this.world.colliders.push(this.collider);
    this.fit(null);
  }

  // the player pushes: it follows (call after the player moved)
  follow(player) {
    const w = this.wheelFor(player.x, player.z, player.yaw, this._w2 || (this._w2 = {}));
    this.x = w.x; this.z = w.z; this.yaw = player.yaw;
    this.fit(player);
  }

  /** place the model on the ground: pushed (handles at the hands) or parked (wheel + legs) */
  fit(player) {
    const G = this.group, B = BARROW, f = this.fwd();
    const yw = this.world.groundAt(this.x, this.z);
    let theta, roll = 0;
    if (player && this.pushing) {
      const target = this.world.groundAt(player.x, player.z) + HANDS_Y - yw;
      const R = Math.hypot(B.gripY, B.grip), phi = Math.atan2(B.gripY, B.grip);
      theta = Math.asin(Math.max(-0.95, Math.min(0.95, target / R))) - phi;
    } else {
      const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
      const lx = this.x - f.x * B.legZ, lz = this.z - f.z * B.legZ;
      const yl = this.world.groundAt(lx - rx * 0.23, lz - rz * 0.23), yr = this.world.groundAt(lx + rx * 0.23, lz + rz * 0.23);
      theta = Math.atan2((yl + yr) / 2 - yw, B.legZ);
      roll = Math.max(-0.25, Math.min(0.25, Math.atan2(yr - yl, 0.46)));
    }
    if (this.dump) theta += Math.sin(Math.min(1, this.dump.t / DUMP_S) * Math.PI) * 0.75;
    this.theta = theta;
    G.position.set(this.x, yw, this.z);
    G.rotation.set(-theta, this.yaw, roll, "YXZ");
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

  // per frame: the dump animation; the material goes over at the top of the tilt
  update(dt, player) {
    if (this.dump) {
      const d = this.dump;
      d.t += dt;
      if (d.moved < 0 && d.t >= DUMP_S * 0.5) {
        d.moved = transfer(this, d.target, Infinity, d.id);
        if (d.onPeak) d.onPeak(d.moved);
      }
      if (d.t >= DUMP_S) this.dump = null;
    }
    if (this.pushing && player) this.follow(player);
    else if (this.dump) this.fit(null);
    this._fills();
  }

  _fills() {
    const b = this.batch, frac = Math.min(1, b.volumeMl / this.capacityMl);
    const sig = `${b.volumeMl}:${b.massG}`;
    if (sig === this._fillSig) return;
    this._fillSig = sig;
    const m = b.massG || 1, rgb = [0, 0, 0];
    for (let k = 0; k < 4; k++) for (let c = 0; c < 3; c++) rgb[c] += (MAT_RGB[k][c] * b.comp[k]) / m;
    this.models.setBarrowFill(this.group, frac, b.massG > 0 ? rgb : null);
  }

  serialize() {
    return { x: this.x, z: this.z, yaw: this.yaw, batch: this.batch.serialize() };
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
