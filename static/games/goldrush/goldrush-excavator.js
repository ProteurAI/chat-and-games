// GoldRush - the compact excavator (phase 9): the first machine that digs.
//
//   DRIVING     tracks (skid steer): W / S forward and back, A / D turn the
//               chassis on the spot; it follows the ground (pitch and roll from
//               the four track ends), climbs up to ~28 deg, never onto the
//               timber decks; props, fences, machines stop it.
//   SWING       the house turns towards where you look (rate-limited); the
//               camera sits in the cab and turns with your view.
//   SCOOP       (assisted) aim at diggable ground in reach, click: the house
//               swings to it, the arm reaches out (approach), the teeth touch
//               (teeth), the bucket drags towards the cab and curls (curl) - the
//               cut happens there: a real dig (goldrush-mining.js) with the
//               excavator's bite (EXC_DEF), every 1 cm slice used up once, its
//               fine gold and pieces into the bucket as one MaterialBatch - then
//               it lifts (fill, lift). ~45 l a scoop, ~2.4 s.
//   DUMP        aim at a receiver, right click / Q: it swings, reaches over it,
//               tips (the transfer happens at the tip: as much as fits - a full
//               hopper takes part of it, the rest stays in the bucket):
//                 the mine intake hopper, a parked wheelbarrow, the bulk hopper,
//                 the spoil heap (waste - booked like tailings)
//   ROCK        intact stone stops the bucket (no cutting hard rock); the
//               hydraulic breaker (upgrade, swapped at the excavator's stand)
//               cracks it with the phase-8 fracture logic (terrain.strikeStone,
//               several points per blow) and breaks boulders; the bucket then
//               takes the rubble.
//
// The bucket is a container: its gold counts in the processing ledger; dig
// material is booked in like a dig into a barrow (no pieces discovered at the
// face - they come out in the wash). Saved: where it stands, its pose, its
// load, the attachment, whether you sit in it. A scoop's transaction is
// atomic (the cut), so is a dump's (the tip): saving in between never doubles
// or loses anything.

import { MaterialBatch, STAGE, batchFromDig } from "./goldrush-material.js";
import { ExcavatorRig, EXC, rigFromScene, TrackMarks } from "./goldrush-excavatormodel.js";
import { transfer } from "./goldrush-transfer.js";
import { MAT } from "./goldrush-materials.js";

export const EXC_HOME = { x: -16.4, z: -12.6, heading: 0 };   // where it is delivered / the attachment stand
export const BUCKET_ML = 45000;
// the bite: a wide, deep scoop (its volume is limited to the room left in the bucket)
export const EXC_DEF = {
  id: "excavator", label: "Bagger", reach: 9,
  materialEfficiency: [1.0, 0.86, 0.78, 0],          // intact stone: no
  loosenedBonus: [1, 1.08, 1.1, 1],
  cementEfficiency: 0.55,                            // a cemented streak: it tears it up, slowly
  rubbleEfficiency: 0.9,                             // broken rock (pick / breaker): yes
  hardnessLimit: 4,
  kernel: { type: "scoop", a: 0.42, b: 0.3, vol: 0.05, tMax: 0.34, edge: 0.45, tilt: 0.35, settleMargin: 1.4 },
  rockDamage: 0,
};
export const DRIVE = { fwd: 1.45, back: 0.95, turn: 0.85, acc: 1.5, maxGrade: Math.tan((28 * Math.PI) / 180), maxDrop: Math.tan((38 * Math.PI) / 180), r: 1.05 };
export const PHASE_S = { approach: 0.6, teeth: 0.3, curl: 0.85, fill: 0.3, lift: 0.55, reach: 0.55, tip: 0.65, back: 0.55, hammer: 0.9 };
const SWING_RATE = 1.35;                              // rad/s
const SWING_ACC = 3.2;                                // rad/s2: the house speeds up to SWING_RATE and eases in (no snap)
const PHI = { open: -0.9, mid: -0.25, curl: 0.95, dump: -2.25, chisel: -1.57 };
const CARRY = [2.15, 1.35];                           // the wrist when it carries a load (house frame r, y)
const PARK = [1.75, 0.35];                            // ... when it rests (bucket low in front)
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const lerp = (a, b, t) => a + (b - a) * t;
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const MAT_RGB = [[0.6, 0.44, 0.3], [0.5, 0.36, 0.25], [0.6, 0.55, 0.47], [0.52, 0.5, 0.47]];

export class Excavator {
  /**
   * @param saved doc.processing.excavator (v8) or null
   * @param ctx   { ledger, nextId, mining(), terrain(), rocks(), economy(), conveyor(), barrow(), bulk(), spoil(), trommel(), upgrades(), assets, envMap, warm() }
   */
  constructor(THREE, scene, world, saved, ctx) {
    this.THREE = THREE;
    this.scene = scene;
    this.world = world;
    this.ctx = ctx;
    const s = saved || {};
    this.x = Number.isFinite(s.x) ? s.x : EXC_HOME.x;
    this.z = Number.isFinite(s.z) ? s.z : EXC_HOME.z;
    this.heading = Number.isFinite(s.heading) ? s.heading : EXC_HOME.heading;
    this.swing = Number.isFinite(s.swing) ? s.swing : 0;
    const P = s.pose || {};
    this.pose = { swing: this.swing, boom: Number.isFinite(P.boom) ? P.boom : 0.3, stick: Number.isFinite(P.stick) ? P.stick : -1.6, tool: Number.isFinite(P.tool) ? P.tool : 0 };
    this.attachment = s.attachment === "breaker" ? "breaker" : "bucket";
    this.bucket = { batch: MaterialBatch.from(s.bucket) || new MaterialBatch({ stage: STAGE.RAW }), capacityMl: BUCKET_ML };
    this.inCab = !!s.inCab;
    const st = s.stats || {};
    this.stats = { scoops: int(st.scoops), dumps: int(st.dumps), dugMl: int(st.dugMl), spoilMl: int(st.spoilMl), intakeMl: int(st.intakeMl), breaks: int(st.breaks), driveM: int(st.driveM), blocked: int(st.blocked) };
    this.v = 0;                        // track speed (m/s, + forward)
    this.w = 0;                        // turn rate
    this.task = null;                  // { kind: scoop | dump | break | swap, phase, t, ... }
    this.viewAz = this.swing;          // where the operator looks (relative to the chassis): the house follows when idle
    this.time = 0;
    this.rig = new ExcavatorRig(THREE, { envMap: ctx.envMap || null });
    this.root = this.rig.root;
    scene.add(this.root);
    // its stand: the attachment that is not on the machine lies there (the breaker once bought)
    this.stand = ctx.standModel ? ctx.standModel() : null;
    if (this.stand) {
      this.stand.position.set(EXC_HOME.x - 0.4, 0, EXC_HOME.z + 1.85);
      this.stand.rotation.y = 0.15;
      scene.add(this.stand);
      this.standCollider = { type: "box", x: this.stand.position.x, z: this.stand.position.z, hw: 0.55, hd: 0.45, rot: 0.15 };
      world.colliders.push(this.standCollider);
    }
    this.collider = { type: "circle", x: this.x, z: this.z, r: 1.15 };
    world.colliders.push(this.collider);
    // where it drives, the tracks leave their imprint (every ~0.3 m, also when it turns on the spot)
    this.marks = new TrackMarks(THREE, scene);
    this._markD = 0;
    this.rig.setAttachment(this.attachment);
    this.standSync();
    this._v = new THREE.Vector3(); this._w = new THREE.Vector3(); this._m4 = new THREE.Matrix4();
    // the parked pose for a fresh machine: arm folded, bucket resting low in front
    if (!s.pose) this._poseFor(PARK[0], PARK[1], PHI.curl, this.pose);
    this._fit();
    this.rig.setPose(this.pose);
    this._load();
    // an authored model replaces the procedural one when models/manifest.json lists it
    if (ctx.assets) ctx.assets.modelOr(new URL("./models/excavator.glb", import.meta.url).href, () => null).then((scene) => { if (scene && !this.disposed) this._useAuthored(scene); }).catch(() => {});
  }

  _useAuthored(scene) {
    const rig = rigFromScene(this.THREE, scene, this.rig);
    if (!rig) return;
    this.scene.remove(this.root);
    this.rig = rig;
    this.root = rig.root;
    this.scene.add(this.root);
    this._fit();
    this.rig.setPose(this.pose);
    if (this.ctx.warm) this.ctx.warm();
  }

  // the stand shows what is not on the machine: the breaker (once bought, while the bucket works), or the bucket
  standSync() {
    if (!this.stand) return;
    const has = this.ctx.upgrades().has("excavator.breaker"), u = this.stand.userData;
    u.breaker.visible = has && !this.breaker;
    u.bucket.visible = this.breaker;
  }

  get volumeMl() { return this.bucket.batch.volumeMl; }
  get room() { return Math.max(0, BUCKET_ML - this.bucket.batch.volumeMl); }
  get busy() { return !!this.task; }
  get breaker() { return this.attachment === "breaker"; }
  goldUg() { return this.bucket.batch.goldUg; }
  massG() { return this.bucket.batch.massG; }

  // ---------------------------------------------------------------- the ground under it

  // pitch / roll from the four track ends; the root sits on their mean height
  _fit() {
    const c = Math.cos(this.heading), s = Math.sin(this.heading), hl = EXC.trackL / 2 - 0.15, hw = EXC.gauge / 2;
    const g = (fx, fz) => this.world.groundAt(this.x + c * fx + s * fz, this.z - s * fx + c * fz);
    const fl = g(hl, hw), fr = g(hl, -hw), bl = g(-hl, hw), br = g(-hl, -hw);
    const y = Math.max((fl + fr + bl + br) / 4, Math.min(fl, fr, bl, br));
    this.y = y;
    this.root.position.set(this.x, y, this.z);
    this.root.rotation.set(0, this.heading, 0);
    const pitch = Math.atan2((fl + fr) / 2 - (bl + br) / 2, hl * 2), roll = Math.atan2((fl + bl) / 2 - (fr + br) / 2, hw * 2);
    this.root.rotation.z = Math.max(-0.5, Math.min(0.5, pitch));
    this.root.rotation.x = Math.max(-0.5, Math.min(0.5, -roll));
    this.root.updateMatrixWorld(true);
    this.collider.x = this.x; this.collider.z = this.z;
  }

  // may it stand / drive here? (claim, no deck, the ground not too steep from where it is)
  _canGo(nx, nz, dir) {
    const w = this.world;
    if (w.decks.length && w.deckAt(nx, nz) > -Infinity) return false;
    const c = Math.cos(this.heading), s = Math.sin(this.heading), ahead = 1.05 * Math.sign(dir || 1);
    const h0 = w.groundAt(this.x, this.z), h1 = w.groundAt(nx + c * ahead, nz - s * ahead), d = Math.hypot(nx + c * ahead - this.x, nz - s * ahead - this.z) || 1;
    const grade = (h1 - h0) / d;
    if (grade > DRIVE.maxGrade || grade < -DRIVE.maxDrop) return false;
    return true;
  }

  /**
   * The tracks this step: fwd -1..1 (W / S), turn -1..1 (A / D). Blocked while the arm works.
   * -> { moved: m, blocked }
   */
  drive(dt, fwd, turn) {
    const can = !this.task;
    const want = can ? (fwd > 0 ? fwd * DRIVE.fwd : fwd * DRIVE.back) : 0;
    this.v += Math.max(-DRIVE.acc * dt, Math.min(DRIVE.acc * dt, want - this.v));
    const wt = can ? -turn * DRIVE.turn * (Math.abs(this.v) > 0.2 ? 0.75 : 1) : 0;
    this.w += Math.max(-2.5 * dt, Math.min(2.5 * dt, wt - this.w));
    let blocked = false, moved = 0;
    if (Math.abs(this.w) > 1e-4) this.heading = wrapA(this.heading + this.w * dt);
    if (Math.abs(this.v) > 1e-4) {
      const c = Math.cos(this.heading), s = Math.sin(this.heading), d = this.v * dt;
      let nx = this.x + c * d, nz = this.z - s * d;
      if (!this._canGo(nx, nz, this.v)) { blocked = true; this.v = 0; }
      else {
        const i = this.world.colliders.indexOf(this.collider);
        if (i >= 0) this.world.colliders.splice(i, 1);
        const p = { x: nx, z: nz };
        this.world.collide(p, DRIVE.r);
        if (i >= 0) this.world.colliders.splice(i, 0, this.collider);
        if (Math.hypot(p.x - nx, p.z - nz) > Math.abs(d) * 0.7) { blocked = true; this.v *= 0.3; }
        moved = Math.hypot(p.x - this.x, p.z - this.z);
        this.x = p.x; this.z = p.z;
        this.stats.driveM += moved;
      }
    }
    if (Math.abs(this.v) > 1e-4 || Math.abs(this.w) > 1e-4) this._fit();
    this.rig.trackScroll(this.v + this.w * 0.6, this.v - this.w * 0.6, dt);
    this._markD += moved + Math.abs(this.w) * dt * EXC.gauge * 0.5;
    if (this._markD >= 0.3) {
      this._markD = 0;
      const c = Math.cos(this.heading), s = Math.sin(this.heading);
      for (const side of [-1, 1]) {
        const mx = this.x + s * side * EXC.gauge / 2, mz = this.z + c * side * EXC.gauge / 2;
        this.marks.add(mx, this.world.groundAt(mx, mz), mz, this.heading);
      }
    }
    return { moved, blocked };
  }

  // ---------------------------------------------------------------- targets (world <-> the house's plane)

  // a world point in the chassis frame: { r (from the slewing centre), y (up from the house origin), az (relative to the chassis) }
  rel(p) {
    this.root.updateMatrixWorld(true);
    this._m4.copy(this.root.matrixWorld).invert();
    const l = this._v.set(p.x, p.y, p.z).applyMatrix4(this._m4);
    // the arm works in a plane 0.1 m right of the slewing centre (EXC.boomPivot z): turn a little further
    // left so its plane runs through the point; r is measured in that plane
    const rh = Math.hypot(l.x, l.z), off = EXC.boomPivot[2];
    return { r: Math.sqrt(Math.max(0.01, rh * rh - off * off)), y: l.y - EXC.houseY, az: Math.atan2(-l.z, l.x) + Math.asin(Math.min(0.5, off / Math.max(0.3, rh))), dist: rh };
  }

  // the arm's pose for teeth at (r, y) with the tool at absolute angle phi (house plane) -> into `out`
  _poseFor(r, y, phi, out, pt) {
    const [wr, wy] = ExcavatorRig.wristFor(r, y, phi, pt);
    const ik = ExcavatorRig.solve(wr, wy);
    out.boom = ik.boom; out.stick = ik.stick; out.tool = ExcavatorRig.toolFor(phi, ik.boom, ik.stick);
    return out;
  }

  // can the teeth get to (r, y) for a scoop (both ends of the drag in reach, not under the tracks)?
  reachable(rel, kind = "scoop") {
    const E = EXC, L = E.boomL + E.stickL - 0.06, P = E.boomPivot;
    if (kind === "dump") return rel.r >= E.dumpReach[0] && rel.r <= E.dumpReach[1] && rel.y > -1.6 && rel.y < 2.4;
    if (rel.r < E.reach[0] || rel.r > E.reach[1] || rel.y < -2.2 || rel.y > 2.4) return false;
    for (const [dr, dy, phi] of [[0.12, 0.03, PHI.open], [-0.38, -0.02, PHI.mid]]) {
      const [wr, wy] = ExcavatorRig.wristFor(rel.r + dr, rel.y + dy, phi);
      if (Math.hypot(wr - P[0], wy - P[1]) > L) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- tasks

  /** a scoop at a terrain hit (or the oversize pile: target.kind "oversize") -> ok */
  startScoop(target) {
    if (this.task || this.breaker || this.room < 2000) return false;
    const rel = this.rel(target.at || target.hit);
    if (!this.reachable(rel)) return false;
    this.task = { kind: "scoop", phase: "swing", t: 0, target, rel, from: { ...this.pose }, cut: false };
    return true;
  }

  /** a dump onto receiver { kind: intake | barrow | bulk | spoil, at: {x, y, z} } -> ok */
  startDump(recv) {
    if (this.task || this.bucket.batch.volumeMl <= 0) return false;
    const rel = this.rel(recv.at);
    if (!this.reachable(rel, "dump")) return false;
    this.task = { kind: "dump", phase: "swing", t: 0, recv, rel, from: { ...this.pose }, tipped: false };
    return true;
  }

  /** the breaker on rock / a boulder at a hit -> ok */
  startBreak(target) {
    if (this.task || !this.breaker) return false;
    const rel = this.rel(target.hit);
    if (rel.r < EXC.reach[0] || rel.r > EXC.reach[1] + 0.2 || rel.y < -2.2 || rel.y > 2.4) return false;
    this.task = { kind: "break", phase: "swing", t: 0, target, rel, from: { ...this.pose }, blows: 0 };
    return true;
  }

  // the attachment stand: bucket <-> breaker (bucket empty, near the stand)
  canSwap() { return !this.task && this.ctx.upgrades().has("excavator.breaker") && this.bucket.batch.volumeMl <= 0 && Math.hypot(this.x - EXC_HOME.x, this.z - EXC_HOME.z) < 4.5; }
  startSwap() {
    if (!this.canSwap()) return false;
    this.task = { kind: "swap", phase: "lower", t: 0, from: { ...this.pose } };
    return true;
  }

  // the arm's key poses for a task phase
  _target(task, phase, out) {
    const r = task.rel ? task.rel.r : 2, y = task.rel ? task.rel.y : 0;
    if (task.kind === "scoop") {
      if (phase === "approach") return this._poseFor(r + 0.18, y + 0.35, PHI.open, out);
      if (phase === "teeth") return this._poseFor(r + 0.12, y + 0.03, PHI.open, out);
      if (phase === "curl") return this._poseFor(r - 0.38, y - 0.02, PHI.mid, out);
      if (phase === "fill") return this._poseFor(r - 0.42, y + 0.2, PHI.curl, out);
      return this._poseFor(CARRY[0], CARRY[1], PHI.curl, out);
    }
    if (task.kind === "dump") {
      const top = y + 0.55;
      if (phase === "reach") return this._poseFor(r - 0.1, top, PHI.curl, out, EXC.mouth);
      if (phase === "tip") return this._poseFor(r - 0.05, top + 0.12, PHI.dump, out, EXC.mouth);
      return this._poseFor(CARRY[0], CARRY[1] - 0.3, PHI.curl, out);
    }
    if (task.kind === "break") {
      const pt = [0.06, -1.04];                                     // the chisel's tip in the tool frame (straight down at phi -pi/2)
      if (phase === "approach") return this._poseFor(r, y + 0.35, PHI.chisel, out, pt);
      if (phase === "hammer") return this._poseFor(r, y + 0.02, PHI.chisel, out, pt);
      return this._poseFor(CARRY[0], CARRY[1] - 0.4, PHI.curl, out);
    }
    // swap: down to the ground in front, then back
    if (phase === "lower") return this._poseFor(1.9, -0.45, PHI.open, out);
    return this._poseFor(PARK[0], PARK[1], PHI.curl, out);
  }

  /**
   * Per frame: the swing, the task's phases (events at their moments), the pose.
   * ev(kind, data) is told: "cut" (the scoop's transaction result), "tip", "blow", "swap", "done".
   */
  update(dt, ev = null) {
    this.time += dt;
    const T = this.task;
    // the ground was dug somewhere: imprints over dug ground go
    const tr = this.ctx.terrain && this.ctx.terrain();
    if (tr && tr.revision !== this._rev) { this._rev = tr.revision; if (this.marks.used) this.marks.prune((x, z) => this.world.groundAt(x, z)); }
    // the house: towards the task's target, else where the operator looks
    const azWant = T && T.rel ? T.rel.az : T ? this.swing : this.inCab ? this.viewAz : this.swing;
    // the house swings with inertia: it speeds up, and brakes in time to stop at the target
    const d = wrapA(azWant - this.swing), sv = this.swingV || 0;
    const vWant = Math.sign(d) * Math.min(SWING_RATE, Math.sqrt(2 * SWING_ACC * Math.abs(d)) * 0.95);
    this.swingV = sv + Math.max(-SWING_ACC * dt, Math.min(SWING_ACC * dt, vWant - sv));
    if (Math.abs(d) < 0.003 && Math.abs(this.swingV) < 0.06) { this.swing = wrapA(azWant); this.swingV = 0; }
    else this.swing = wrapA(this.swing + this.swingV * dt);
    this.swinging = Math.abs(this.swingV) > 0.05;
    if (T) this._step(T, dt, ev);
    else if (this.inCab) {
      // idle: the bucket held where it is useful - carrying when loaded, low in front when empty
      const want = this._want || (this._want = {});
      if (this.bucket.batch.volumeMl > 0) this._poseFor(CARRY[0], CARRY[1], PHI.curl, want); else this._poseFor(PARK[0] + 0.25, PARK[1] + 0.25, PHI.curl, want);
      const k = Math.min(1, dt * 2.5);
      for (const key of ["boom", "stick", "tool"]) this.pose[key] = lerp(this.pose[key], want[key], k);
    }
    this.pose.swing = this.swing;
    // what you see on top of the pose (never saved, never used by a cut): the arm settling after the load came on /
    // went off (a damped bounce), the shudder of the teeth in the ground
    this._settleT = (this._settleT || 0) + dt;
    const vp = this._vpose || (this._vpose = {});
    Object.assign(vp, this.pose);
    if (this._settle) vp.boom += this._settle * 0.028 * Math.sin(this._settleT * 15) * Math.exp(-this._settleT * 4.5);
    if (T && T.kind === "scoop" && T.phase === "curl") { const s = 0.009 * Math.sin(this.time * 41) * (1 - Math.min(1, T.t / 0.6)); vp.stick += s; vp.tool += s * 1.6; }
    this.rig.setPose(vp);
    // the breaker shakes while it hammers
    if (this.rig.breakerBody) this.rig.breakerBody.position.x = 0.06 + (T && T.kind === "break" && T.phase === "hammer" ? Math.sin(this.time * 90) * 0.006 : 0);
  }

  _step(T, dt, ev) {
    const order = { scoop: ["swing", "approach", "teeth", "curl", "fill", "lift"], dump: ["swing", "reach", "tip", "back"], break: ["swing", "approach", "hammer", "lift"], swap: ["lower", "raise"] }[T.kind];
    if (T.phase === "swing") {
      // the arm starts reaching while the house still swings the last part (as an operator overlaps them)
      if (Math.abs(wrapA(T.rel.az - this.swing)) < 0.45) { T.phase = order[1]; T.t = 0; T.from = { ...this.pose }; }
      return;
    }
    const dur = T.phase === "raise" ? 0.7 : T.phase === "lower" ? 0.8 : PHASE_S[T.phase] || 0.5;
    T.t += dt;
    const u = Math.min(1, T.t / dur), k = ease(T.phase === "curl" ? Math.pow(u, 1.35) : u);     // the curl: the teeth bite, then it gives
    const to = this._target(T, T.phase, T.to || (T.to = {}));
    this.pose.boom = lerp(T.from.boom, to.boom, k);
    this.pose.stick = lerp(T.from.stick, to.stick, k);
    this.pose.tool = lerp(T.from.tool, to.tool, k);
    // the moments
    if (T.kind === "scoop" && T.phase === "curl" && !T.cut && T.t >= dur * 0.5) { T.cut = true; const r = this._cut(T.target); if (ev) ev("cut", r); if (r && !r.ok) { T.phase = "lift"; T.t = 0; T.from = { ...this.pose }; return; } }
    if (T.kind === "scoop" && T.phase === "lift" && !T.settled && T.t >= dur * 0.2) { T.settled = true; this._settle = -0.8; this._settleT = 0; }    // the load's weight on the arm
    if (T.kind === "dump" && T.phase === "tip" && !T.tipped && T.t >= dur * 0.55) { T.tipped = true; const r = this._tip(T.recv); if (ev) ev("tip", r); this._settle = 1; this._settleT = 0; }   // load off: it springs
    if (T.kind === "break" && T.phase === "hammer") {
      const want = Math.min(3, Math.floor((T.t / dur) * 3 + 0.34));
      while (T.blows < want) { T.blows++; const r = this._blow(T.target, T.blows); if (ev) ev("blow", r); }
    }
    if (T.kind === "swap" && T.phase === "lower" && !T.swapped && T.t >= dur * 0.9) { T.swapped = true; this.attachment = this.breaker ? "bucket" : "breaker"; this.rig.setAttachment(this.attachment); this.standSync(); if (ev) ev("swap", { attachment: this.attachment }); }
    if (T.t >= dur) {
      const i = order.indexOf(T.phase);
      if (i >= order.length - 1) { this.task = null; if (ev) ev("done", { kind: T.kind }); return; }
      T.phase = order[i + 1]; T.t = 0; T.from = { ...this.pose };
    }
  }

  // ---------------------------------------------------------------- the transactions

  // THE SCOOP: a real dig at the hit with the excavator's bite (volume limited to the room) -> result
  _cut(target) {
    const L = this.ctx.ledger, room = this.room;
    if (target.kind === "oversize") {
      const tr = this.ctx.trommel();
      const ml = tr ? tr.takeOversize(this.bucket, Math.min(room, BUCKET_ML)) : 0;
      this._load();
      this.stats.scoops++;
      return { ok: ml > 0, kind: "oversize", ml };
    }
    const def = this._def || (this._def = { ...EXC_DEF, kernel: { ...EXC_DEF.kernel } });
    def.kernel.vol = Math.min(EXC_DEF.kernel.vol, (room * 0.95) / 1e6);      // a heaped bucket (loosened ground can top it up a little)
    // the stroke runs towards the machine: from the slewing centre's height
    const eye = this._w.set(this.x, this.y + EXC.houseY + 0.8, this.z);
    const r = this.ctx.mining().action(target.hit, def, null, eye);
    this.ctx.economy().recordAction(r, "excavator");
    if (!r.ok || r.blocked || r.kind !== "dig") { this.stats.blocked++; return { ok: false, blocked: true, material: target.hit.boulder != null ? MAT.STONE : r.material, kind: r.kind, cemented: !!r.cemented }; }
    const dig = batchFromDig(r, "excavator", this.ctx.nextId());
    L.inUg += dig.goldUg; L.inFineUg += dig.fineUg; L.inG += dig.massG; L.inMl += dig.volumeMl; L.inFinds += dig.finds.length;
    const ml = dig.volumeMl, kg = dig.massG / 1000;
    this.bucket.batch.absorb(dig);                     // (a heaped bucket may go a little past 45 l)
    this.stats.scoops++;
    this.stats.dugMl += ml;
    this._load();
    return { ok: true, kind: "dig", ml, kg, material: r.material, slices: r.slices, mountainKg: r.mountainKg, fineUg: r.fineUg, pieces: r.findCount, massByMat: [...r.massByMat] };
  }

  // THE TIP: as much as the receiver takes -> { ok, ml, rest, kind }
  _tip(recv) {
    const b = this.bucket;
    let ml = 0;
    if (recv.kind === "intake") { const cv = this.ctx.conveyor(); if (cv && cv.installed) ml = cv.pourIn(b); this.stats.intakeMl += ml; }
    else if (recv.kind === "barrow") { const w = this.ctx.barrow(); if (w && !w.pushing) ml = transfer(b, w, Infinity, this.ctx.nextId()); }
    else if (recv.kind === "bulk") { const bk = this.ctx.bulk(); if (bk && bk.installed) { ml = transfer(b, bk.buffer, Infinity, this.ctx.nextId()); bk.stats.inMl += ml; if (ml > 0) bk.stats.loads++; bk._fill(); } }
    else if (recv.kind === "spoil") { const sp = this.ctx.spoil(); if (sp) { ml = sp.dumpFrom(b); this.stats.spoilMl += ml; } }
    if (ml > 0) this.stats.dumps++;
    this._load();
    return { ok: ml > 0, ml, rest: b.batch.volumeMl, kind: recv.kind };
  }

  // THE BREAKER: one blow - several fracture points round the chisel (stone), or damage to a boulder
  _blow(target, n) {
    const hit = target.hit, tr = this.ctx.terrain(), rocks = this.ctx.rocks();
    if (hit.boulder != null && rocks) {
      const rk = rocks.hit(hit.boulder, 5);
      if (rk && rk.broke) rocks.settleIn(hit.x - 1.5, hit.z - 1.5, hit.x + 1.5, hit.z + 1.5);
      if (rk && rk.broke) this.stats.breaks++;
      return { ok: true, rock: rk, broke: !!(rk && rk.broke) };
    }
    let fractured = 0;
    const pts = [[0, 0], [0.22, 0.1], [-0.18, 0.16], [0.05, -0.24]];
    for (const [dx, dz] of pts) {
      const p = { x: hit.x + dx, y: tr.getHeightAt(hit.x + dx, hit.z + dz), z: hit.z + dz };
      const c = tr.strikeStone(p, 2.4);
      fractured += c.fractured || 0;
    }
    if (fractured) this.stats.breaks += fractured;
    return { ok: true, fractured, n };
  }

  // the bucket's look: fill and colour from its batch
  _load() {
    const b = this.bucket.batch, m = b.massG || 1, rgb = [0, 0, 0];
    for (let k = 0; k < 4; k++) { const s = b.comp[k] / m; rgb[0] += MAT_RGB[k][0] * s; rgb[1] += MAT_RGB[k][1] * s; rgb[2] += MAT_RGB[k][2] * s; }
    this.rig.setLoad(b.volumeMl / BUCKET_ML, b.massG > 0 ? rgb : null, b.id || 1);
  }

  // ---------------------------------------------------------------- instant forms (benchmark / tests: no animation)

  scoopNow(target) {
    if (this.task || this.breaker || this.room < 2000) return null;
    const rel = this.rel(target.at || target.hit);
    if (!this.reachable(rel)) return null;
    this.swing = rel.az;
    this._poseFor(Math.max(EXC.reach[0], rel.r - 0.4), rel.y + 0.2, PHI.curl, this.pose);
    this.pose.swing = this.swing;
    this.rig.setPose(this.pose);
    return this._cut(target);
  }

  dumpNow(recv) {
    if (this.task || this.bucket.batch.volumeMl <= 0) return null;
    const rel = this.rel(recv.at);
    if (!this.reachable(rel, "dump")) return null;
    this.swing = rel.az;
    this.pose.swing = this.swing;
    this.rig.setPose(this.pose);
    return this._tip(recv);
  }

  breakNow(target) {
    if (this.task || !this.breaker) return null;
    const out = [];
    for (let n = 1; n <= 3; n++) out.push(this._blow(target, n));
    return out;
  }

  // stand somewhere (tests / benchmark / developer tools): the ground decides the rest
  place(x, z, heading = this.heading) {
    this.x = x; this.z = z; this.heading = heading; this.v = this.w = 0;
    this._fit();
    this.rig.setPose(this.pose);
  }

  // where the operator's eyes are (the cab turns with the house)
  eye(out) { return this.rig.eyeWorld(out); }

  // where the player gets out: beside the cab (left), else right, behind, in front
  exitSpot() {
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    const cands = [[0, -1.45], [0, 1.45], [-1.6, 0], [1.7, 0]];             // the cab's side (left, -z) first
    for (const [fx, fz] of cands) {
      const x = this.x + c * fx + s * fz, z = this.z - s * fx + c * fz;
      const g = this.world.groundAt(x, z);
      if (Math.abs(g - this.y) > 0.9) continue;
      const p = { x, z };
      this.world.collide(p, 0.35);
      if (Math.hypot(p.x - x, p.z - z) < 0.3) return { x: p.x, z: p.z };
    }
    return { x: this.x - s * 1.45, z: this.z - c * 1.45 };
  }

  serialize() {
    return {
      x: +this.x.toFixed(3), z: +this.z.toFixed(3), heading: +this.heading.toFixed(4), swing: +this.swing.toFixed(4),
      pose: { boom: +this.pose.boom.toFixed(4), stick: +this.pose.stick.toFixed(4), tool: +this.pose.tool.toFixed(4) },
      attachment: this.attachment, bucket: this.bucket.batch.serialize(), inCab: this.inCab, stats: { ...this.stats, driveM: Math.round(this.stats.driveM) },
    };
  }

  dispose() {
    this.disposed = true;
    for (const c of [this.collider, this.standCollider]) { const i = this.world.colliders.indexOf(c); if (i >= 0) this.world.colliders.splice(i, 1); }
    this.scene.remove(this.root);
    if (this.stand) this.scene.remove(this.stand);
    this.marks.dispose();
    this.rig.dispose();
  }
}

export { PHI, CARRY };
