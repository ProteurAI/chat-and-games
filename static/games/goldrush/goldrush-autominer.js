// GoldRush - the automatic hillside miner (Prompt 10): the first machine that
// digs the mountain by itself. Stationary: it stands at the mountain's foot,
// facing the flank, and works ONE section of it - a box in front of it (~2.4 m
// wide, 1.5-3.4 m ahead, up to 2.0 m above its own ground, never below it).
//
//   PLACING     bought, it is delivered (parked by the excavator's stand); [E]
//               there -> the placement mode (goldrush-engine.js): a ghost on the
//               ground under the crosshair, green / red with the reason. Valid
//               only on firm, not too steep ground (<= ~14 deg, no bumps), not
//               on a pile / deck / in anything's way, with enough mountain in
//               its section (>= 0.8 m3) and something to discharge into - the
//               plant's intake (the conveyor) or the RAW pile - within the reach
//               of its rear belt's tip (~3.1 m behind it, +-80 deg). Moving it: stop it, then
//               [E] "Versetzen" at its rear - the same placement again.
//   WORKING     a cycle per bite: the head swings to the highest diggable point
//               of its section (top-down: it benches its way into the flank),
//               pulls back a little (anticipation), touches (contact), cuts
//               against the material (resistance: the drum shakes, slower in
//               compact / gravel), the cut itself - a real dig (goldrush-mining.js)
//               with MINER_DEF: every 1 cm slice used up once, its fine gold and
//               pieces into the bite's MaterialBatch, the mountain contract counts
//               it - follows through, lifts, drops the bite onto its internal belt,
//               settles. ~8 l a bite, 70-95 l/min by material.
//   OUTPUT      the internal belt (60 l) -> the rear belt -> the intake / onto
//               the raw pile at its tip (150 l/min). Backpressure: a full intake
//               (the belt / trommel / wash plant backed up) or a pile up to the
//               tip stops the rear belt; the internal belt fills, the head slows
//               down and waits - and starts again by itself when there is room.
//   ROCK        intact stone stops the head (no cutting hard rock): the pick /
//               the excavator's breaker crack it (phase-8 fracture), the head
//               then takes the rubble. Only stone left -> HARTGESTEIN.
//   SECTION     nothing diggable left in its box -> ABBAUBEREICH ERSCHÖPFT: move it.
//
// It works only while the game runs (processing.update / tickSim): never in the
// pause menu, never offline. Saved: placed or not, where, heading, on / off, the
// status, its belt's load (a MaterialBuffer in the ledger), its stats. A bite is
// atomic (the cut): saving in between never doubles or loses anything.

import { MaterialBuffer, transfer } from "./goldrush-transfer.js";
import { STAGE, batchFromDig } from "./goldrush-material.js";
import { MAT } from "./goldrush-materials.js";
import { AutoMinerRig, AM } from "./goldrush-autominermodel.js";
import { CLAIM, MOUND_CENTER } from "./goldrush-world.js";
import { INTAKE } from "./goldrush-plantmodels.js";

export const MINER = {
  area: { w: 2.4, near: 1.5, far: 3.4, up: 2.0, floor: 0.05 },    // its section (machine frame: x ahead, z across; y above its ground) - ~4-7 m3 at the foot
  biteMl: 8000,
  bufMl: 60000,                         // the internal belt
  outLpm: 150,                          // the rear belt
  out: { luff: 0.22, slew: 1.4, inside: 0.55, beyond: 0.45 },     // the rear belt: tilted up 0.22 rad (its tip ~1.9 m high), +-1.4 rad off straight back; a hopper within its tip's reach -0.55 / +0.45 m
  phase: { reach: 0.85, contact: 0.22, cut: 2.6, follow: 0.45, drop: 0.4, back: 0.55 },
  maxGrade: Math.tan((14 * Math.PI) / 180), maxBump: 0.2, minM3: 0.8, slump: 1.3,      // slump: a stand yields its section's volume x1,3 (the face above slides into the cut), then it is done
 
  foot: [[1.0, 0], [0, 0], [-1.0, 0]], footR: 0.85,
};
// the head: like the excavator's bucket, but small bites; no stone; rubble yes
export const MINER_DEF = {
  id: "autominer", label: "Abbaugerät", reach: 99,
  materialEfficiency: [1.0, 0.86, 0.76, 0],
  loosenedBonus: [1, 1.08, 1.1, 1],
  cementEfficiency: 0.45,
  rubbleEfficiency: 0.85,
  hardnessLimit: 4,
  kernel: { type: "scoop", a: 0.3, b: 0.24, vol: MINER.biteMl / 1e6, tMax: 0.26, edge: 0.4, tilt: 0.3, settleMargin: 1.2 },
  rockDamage: 0,
};
// GoldRush 10.0.1: the small head ("Kleiner Schürfkopf") - the same machine with a narrower, lower section, small
// bites and a shorter belt: ~30 l/min instead of ~80 (slow, but on its own)
export const MINER_SMALL = { ...MINER, area: { w: 1.6, near: 1.4, far: 2.7, up: 1.5, floor: 0.05 }, biteMl: 3000, bufMl: 30000, outLpm: 90,
  phase: { ...MINER.phase, cut: 3.4 }, minM3: 0.4 };
export const MINER_SMALL_DEF = { ...MINER_DEF, kernel: { ...MINER_DEF.kernel, a: 0.22, b: 0.18, vol: MINER_SMALL.biteMl / 1e6 } };
export const MINER_HOME = { x: -20.2, z: -24.6, heading: 0 };        // delivered: parked in the claim's north-west corner (nothing else stands there)
export const STATUS = {
  parked: "nicht aufgestellt", stopped: "aus", running: "läuft", waiting: "wartet – Austrag voll",
  rock: "HARTGESTEIN – ABBAUKOPF BLOCKIERT", exhausted: "ABBAUBEREICH ERSCHÖPFT", placing: "wird aufgestellt",
};
const OUT_REACH = AM.outL * Math.cos(MINER.out.luff);               // m: how far behind its pivot the rear belt's tip lies (level)
const SHAKE = [0.006, 0.01, 0.013, 0.02];                             // the head's vibration by material
const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

export class AutoMiner {
  /**
   * @param saved doc.processing.autominer or null
   * @param ctx   { ledger, nextId, mining(), terrain(), rocks(), economy(), conveyor(), piles(), effects(), sound(kind, o), warm() }
   */
  constructor(THREE, scene, world, saved, ctx) {
    this.THREE = THREE;
    this.scene = scene;
    this.world = world;
    this.ctx = ctx;
    this._size(!!ctx.small);
    const s = saved || {};
    this.placed = !!s.placed;
    this.x = Number.isFinite(s.x) ? s.x : MINER_HOME.x;
    this.z = Number.isFinite(s.z) ? s.z : MINER_HOME.z;
    this.heading = Number.isFinite(s.heading) ? s.heading : MINER_HOME.heading;
    this.on = !!s.on && this.placed;
    this.status = this.placed ? (STATUS[s.status] && s.status !== "placing" ? s.status : this.on ? "running" : "stopped") : "parked";
    this.buffer = new MaterialBuffer({ capacityMl: this.M.bufMl, stage: STAGE.RAW, layers: s.buffer && s.buffer.layers });
    const st = s.stats || {};
    this.stats = { cuts: int(st.cuts), dugMl: int(st.dugMl), outMl: int(st.outMl), intakeMl: int(st.intakeMl), pileMl: int(st.pileMl), runS: int(st.runS), waitS: int(st.waitS), blocked: int(st.blocked), moves: int(st.moves), mountainG: int(st.mountainG) };
    this.budgetMl = int(s.budgetMl);    // what this stand may take (its section's volume when it was set down, x slump)
    this.placeDug = int(s.placeDug);    // what it took here so far
    this.task = null;                   // the bite in progress: { phase, t, hit, n, u, mat, dur, cut }
    this.outAcc = 0;
    this.time = 0;
    this._bad = new Map();              // sample points that would not cut (key -> until time)
    this.rig = new AutoMinerRig(THREE);
    this.root = this.rig.root;
    scene.add(this.root);
    this.pose = { slew: 0, boom: -0.35, stick: -0.6, ext: AM.stickL[0], spin: 0, outSlew: 0, outLuff: 0.45 };
    this.rest = { ...this.pose };
    this.colliders = this.M.foot.map(() => ({ type: "circle", x: 0, z: 0, r: this.M.footR }));
    for (const c of this.colliders) world.colliders.push(c);
    this._v = new THREE.Vector3(); this._w = new THREE.Vector3();
    this.recv = null;
    this._fit();
    if (this.placed) this.recv = this._receiver(this.x, this.z, this.heading, this.y);
    this._aimOut(1);
    this.rig.setPose(this.pose);
    this._load();
  }

  // 10.0.1: small (the "Kleiner Schürfkopf") or the full machine - its section, bites, belt; bought big later it grows
  _size(small) {
    this.small = small;
    this.M = small ? MINER_SMALL : MINER;
    this.DEF = small ? MINER_SMALL_DEF : MINER_DEF;
    if (this.buffer) this.buffer.capacityMl = this.M.bufMl;
    if (this.rig) this.rig.drum.scale.setScalar(small ? 0.72 : 1);
  }
  setSmall(small) { this._size(!!small); this._load && this._load(); return true; }
  get label() { return this.small ? "Schürfkopf" : "Abbaugerät"; }

  get volumeMl() { return this.buffer.volumeMl; }
  goldUg() { return this.buffer.goldUg; }
  massG() { return this.buffer.massG; }
  get fill() { return this.buffer.volumeMl / this.M.bufMl; }
  get running() { return this.on && this.placed; }
  static get outReach() { return OUT_REACH; }

  // ---------------------------------------------------------------- where it stands

  _frame(x = this.x, z = this.z, h = this.heading) {
    const c = Math.cos(h), s = Math.sin(h);
    return { c, s, at: (ax, az) => ({ x: x + c * ax + s * az, z: z - s * ax + c * az }) };
  }

  _fit() {
    const F = this._frame(), w = this.world;
    const f = F.at(1.0, 0), b = F.at(-1.0, 0), l = F.at(0, -0.7), r = F.at(0, 0.7);
    const gf = w.groundBelowAt(f.x, f.z), gb = w.groundBelowAt(b.x, b.z), gl = w.groundBelowAt(l.x, l.z), gr = w.groundBelowAt(r.x, r.z);
    this.y = (gf + gb + gl + gr) / 4;
    this.root.position.set(this.x, this.y, this.z);
    this.root.rotation.set(0, this.heading, 0);
    this.root.rotation.z = clamp(Math.atan2(gf - gb, 2.0), -0.3, 0.3);
    this.root.rotation.x = clamp(-Math.atan2(gl - gr, 1.4), -0.3, 0.3);
    this.root.updateMatrixWorld(true);
    this.M.foot.forEach(([ax, az], i) => { const p = F.at(ax, az); this.colliders[i].x = p.x; this.colliders[i].z = p.z; });
    const t = this.ctx.terrain && this.ctx.terrain();
    this._rev = t ? t.revision : 0;
  }

  // the section's sample points (world x / z) for a stand
  static samples(x, z, h, a, fn) {
    if (typeof a === "function") { fn = a; a = MINER.area; }                  // (the full machine's section by default)
    const A = a, c = Math.cos(h), s = Math.sin(h);
    for (let ax = A.near; ax <= A.far + 1e-6; ax += 0.3) for (let az = -A.w / 2; az <= A.w / 2 + 1e-6; az += 0.26) fn(x + c * ax + s * az, z - s * ax + c * az, ax, az);
  }

  // what is left in the section: m3 above its floor (diggable / stone), the highest point it can take
  // (its own stand: never more than its budget - what slides in from the face above does not make it endless)
  survey(x = this.x, z = this.z, h = this.heading, y = this.y) {
    const own = x === this.x && z === this.z && h === this.heading && this.placed && this.budgetMl > 0;
    const t = this.ctx.terrain(), A = this.M.area, floor = y + A.floor, top = y + A.up, out = { m3: 0, stoneM3: 0, inArea: 0, n: 0, best: null };
    const cellA = 0.3 * 0.26;
    AutoMiner.samples(x, z, h, this.M.area, (px, pz, ax, az) => {
      out.n++;
      if (!t.inDigArea(px, pz)) return;
      out.inArea++;
      const gy = t.getHeightAt(px, pz);
      if (gy <= floor + 0.06) return;
      const k = this._k(t, px, pz), stone = gy <= t.stoneTop[k] + 1e-4 && gy >= t.stoneBot[k] && !(t.rubble[k] > 0);
      if (stone) { out.stoneM3 += (gy - floor) * cellA; return; }
      out.m3 += (Math.min(gy, top) - floor) * cellA;
      if (gy > top + 0.02) return;                                       // its top is out of the head's reach (it comes down as the face below goes)
      const key = `${Math.round(ax * 10)}:${Math.round(az * 10)}`;
      if ((this._bad.get(key) || 0) > this.time) return;
      // the highest first (benching down from the top), then the nearest
      if (!out.best || gy > out.best.y + 0.03 || (Math.abs(gy - out.best.y) <= 0.03 && ax < out.best.ax)) out.best = { x: px, z: pz, y: gy, ax, az, key };
    });
    if (own) {
      const left = Math.max(0, this.budgetMl - this.placeDug) / 1e6;
      out.m3 = Math.min(out.m3, left);
      if (left * 1e6 < this.M.biteMl * 0.5) { out.best = null; out.spent = true; }
    }
    return out;
  }

  // why it stopped by itself: its stand's yield taken (the section done), or only intact stone left in reach
  _why(sv) { return sv.spent || !(sv.stoneM3 > 0.05) ? "exhausted" : "rock"; }

  _k(t, x, z) { const i = Math.round((x - t.x0) / t.cell), j = Math.round((z - t.z0) / t.cell); return clamp(j, 0, t.vps - 1) * t.vps + clamp(i, 0, t.vps - 1); }

  // where the rear belt would put its load: the intake (the conveyor) or the RAW pile, within reach
  _receiver(x, z, h, y) {
    const F = this._frame(x, z, h), piv = F.at(AM.outPivot[0], 0), back = h + Math.PI, O = this.M.out;
    const reach = (px, pz) => {
      const dx = px - piv.x, dz = pz - piv.z, d = Math.hypot(dx, dz);
      if (d < OUT_REACH - O.inside || d > OUT_REACH + O.beyond) return null;           // the tip over the hopper's mouth
      const a = Math.atan2(-dz, dx), off = Math.atan2(Math.sin(a - back), Math.cos(a - back));
      return Math.abs(off) <= O.slew ? { d, off } : null;
    };
    const cv = this.ctx.conveyor && this.ctx.conveyor();
    if (cv && cv.installed) {
      const ix = INTAKE.x, iz = INTAKE.z, r = reach(ix, iz);
      if (r) return { kind: "intake", x: ix, z: iz, d: r.d, off: r.off, label: "Aufgabetrichter" };
    }
    const P = this.ctx.piles && this.ctx.piles().get("raw");
    if (P) {
      // the raw pile's site: the reachable point nearest its drop
      let best = null;
      for (let a = -O.slew; a <= O.slew + 1e-6; a += O.slew / 12) {
        const d = OUT_REACH, px = piv.x + Math.cos(back + a) * d, pz = piv.z - Math.sin(back + a) * d;     // where its tip drops it
        if (!P.inside(px, pz, -0.3)) continue;
        const dd = Math.hypot(px - P.site.drop.x, pz - P.site.drop.z);
        if (!best || dd < best.dd) best = { kind: "pile", pile: P, x: px, z: pz, d, off: a, dd, label: "Rohhaufen" };
      }
      if (best) return best;
    }
    return null;
  }

  /**
   * May it stand here, facing this way? -> { ok, reason, y, m3, stoneM3, recv }
   * (the placement mode asks this every frame; the benchmark / developer tools look for a spot with it)
   */
  check(x, z, h) {
    const w = this.world, t = this.ctx.terrain(), F = this._frame(x, z, h);
    const no = (reason, more = {}) => ({ ok: false, reason, ...more });
    if (x < CLAIM.minX + 1.5 || x > CLAIM.maxX - 1.5 || z < CLAIM.minZ + 1.5 || z > CLAIM.maxZ - 1.5) return no("zu nah am Zaun");
    // its own footprint: free, firm, not on a deck / a pile
    const mine = this.colliders, cols = w.colliders;
    for (const c of mine) { const i = cols.indexOf(c); if (i >= 0) cols.splice(i, 1); }
    let blocked = false;
    try {
      for (const [ax, az] of this.M.foot) {
        const p = F.at(ax, az), q = { x: p.x, z: p.z };
        w.collide(q, this.M.footR);
        if (Math.hypot(q.x - p.x, q.z - p.z) > 0.02) { blocked = true; break; }
      }
    } finally { for (const c of mine) cols.push(c); }
    if (blocked) return no("hier steht etwas im Weg");
    const pts = [[1.15, -0.75], [1.15, 0.75], [-1.15, -0.75], [-1.15, 0.75], [0, 0]].map(([ax, az]) => { const p = F.at(ax, az); return { ...p, ax, az, g: w.groundBelowAt(p.x, p.z) }; });
    for (const p of pts) {
      if (w.decks.length && w.deckAt(p.x, p.z) > -Infinity) return no("nicht auf einer Plattform");
      if (w.groundAt(p.x, p.z) > p.g + 0.05) return no("nicht auf einem Haufen");
    }
    const y = (pts[0].g + pts[1].g + pts[2].g + pts[3].g) / 4;
    const pitch = ((pts[0].g + pts[1].g) - (pts[2].g + pts[3].g)) / 2 / 2.3, roll = ((pts[0].g + pts[2].g) - (pts[1].g + pts[3].g)) / 2 / 1.5;
    if (Math.abs(pitch) > this.M.maxGrade || Math.abs(roll) > this.M.maxGrade) return no("zu steil", { y });
    for (const p of pts) if (Math.abs(p.g - (y + pitch * p.ax + roll * -p.az)) > this.M.maxBump) return no("zu uneben", { y });
    // its section: mountain in it, nothing standing in it
    const sv = this.survey(x, z, h, y);
    if (sv.inArea < sv.n * 0.5 || sv.m3 + sv.stoneM3 < this.M.minM3) return no("kein Berg im Arbeitsbereich", { y, m3: sv.m3 });
    if (sv.m3 < this.M.minM3) return no("nur Fels im Arbeitsbereich", { y, m3: sv.m3, stoneM3: sv.stoneM3 });
    for (const [ax, az] of [[2.2, 0], [2.2, -1.0], [2.2, 1.0], [3.4, 0]]) {
      const p = F.at(ax, az), q = { x: p.x, z: p.z };
      w.collide(q, 0.3);
      if (Math.hypot(q.x - p.x, q.z - p.z) > 0.02) return no("Arbeitsbereich nicht frei", { y });
    }
    // somewhere to put it
    const recv = this._receiver(x, z, h, y);
    if (!recv) return no("kein Anschluss – Aufgabetrichter oder Rohhaufen gut 3 m hinter dem Gerät", { y, m3: sv.m3 });
    if (t && !t.inDigArea(F.at(this.M.area.near, 0).x, F.at(this.M.area.near, 0).z) && sv.inArea < sv.n * 0.7) return no("kein Berg im Arbeitsbereich", { y });
    return { ok: true, reason: "", y, m3: sv.m3, stoneM3: sv.stoneM3, recv };
  }

  /**
   * A good stand (benchmark / developer tools): round the mountain's foot, facing its centre, valid, the most
   * mountain in its section - with the intake as its receiver when `prefer` is "intake" (else any).
   */
  findSpot(prefer = "intake", from = null) {
    let best = null;
    for (let x = -17; x <= 3; x += 0.5) for (let z = -23; z <= -2; z += 0.5) {
      if (from && Math.hypot(x - from.x, z - from.z) > from.r) continue;
      const h0 = Math.atan2(-(MOUND_CENTER.z - z), MOUND_CENTER.x - x);
      for (const dh of [0, 0.4, -0.4, 0.8, -0.8]) {                   // facing the mountain, or turned a little (like R in the placement)
        const h = h0 + dh, r = this.check(x, z, h);
        if (!r.ok || (prefer && r.recv.kind !== prefer)) continue;
        if (!best || r.m3 > best.m3 + 0.05) best = { x, z, heading: h, m3: r.m3, recv: r.recv.kind };
      }
    }
    return best;
  }

  // put it down (the placement mode, a reload, the developer tools / benchmark): stopped, ready
  place(x, z, h) {
    const r = this.check(x, z, h);
    if (!r.ok) return r;
    this.task = null;
    this.x = x; this.z = z; this.heading = h;
    this.budgetMl = Math.round(r.m3 * this.M.slump * 1e6);
    this.placeDug = 0;
    this.placed = true;
    this.on = false;
    this.status = "stopped";
    this.stats.moves++;
    this._bad.clear();
    this._fit();
    this.recv = r.recv;
    this._drop = 0.45;                                                // it is set down (a short settle)
    this.pose = { ...this.rest };
    this._aimOut(1);
    this.rig.setPose(this.pose);
    if (this.ctx.warm) this.ctx.warm();
    return r;
  }

  // the placement mode starts: it stops, the belt's load stays
  unplace() {
    if (!this.placed) return true;
    this.on = false;
    this.task = null;
    this.status = "placing";
    return true;
  }

  // the panel's line: what it does, how full its belt is
  statusText() {
    const s = STATUS[this.status] || this.status, ml = Math.round(this.buffer.volumeMl / 1000);
    const done = this.budgetMl > 0 ? ` · Abschnitt ${Math.min(100, Math.round((this.placeDug / this.budgetMl) * 100))} %` : "";
    return this.status === "running" || this.status === "waiting" ? `${s} · Band ${ml}/${this.M.bufMl / 1000} l · ${this.recv ? this.recv.label : "kein Anschluss"}${done}` : s + done;
  }

  setOn(on) {
    if (!this.placed) return false;
    if (on) {
      const sv = this.survey();
      if (!sv.best) { this.on = false; this.status = this._why(sv); return false; }
      this.on = true; this.status = "running";
    } else { this.on = false; this.task = null; this.status = "stopped"; }
    return true;
  }

  // ---------------------------------------------------------------- the work

  /** per frame (and per simulated second): the cycle, the rear belt, the looks. player: { x, z } for the sound */
  update(dt, player = null) {
    this.time += dt;
    const t = this.ctx.terrain && this.ctx.terrain();
    if (t && t.revision !== this._rev && this.placed) this._fit();     // the ground under it changed
    if (this._drop > 0) { this._drop = Math.max(0, this._drop - dt); this.root.position.y = this.y + Math.sin(this._drop / 0.45 * Math.PI) * 0.08 * (this._drop / 0.45); }
    if (!this.placed) { this._pose(dt, this.rest, 4); return; }
    // the rear belt: while the machine runs (or holds a load and is on)
    if (this.on) this._discharge(dt);
    if (!this.on) { this._pose(dt, this.rest, 3); return; }
    this.stats.runS += dt;
    if (!this.task) {
      // room for another bite? (the head slows down as the belt fills, then waits)
      if (this.buffer.room < this.M.biteMl * 1.35) { this.status = "waiting"; this.stats.waitS += dt; this._pose(dt, this.rest, 2); return; }
      const sv = this.survey();
      if (!sv.best) { this.on = false; this.status = this._why(sv); this.task = null; this._sound("miner_stop", player); return; }
      this.status = "running";
      const hit = { x: sv.best.x, y: sv.best.y, z: sv.best.z, normal: t.getNormalAt(sv.best.x, sv.best.z), distance: 0, diggable: true, boulder: null };
      const mat = this.ctx.mining().materialAtHit(hit), m = this.ctx.mining(), eff = Math.max(0.3, m.efficiencyAtHit(hit, this.DEF) || this.DEF.materialEfficiency[mat] || 0.6);
      const slow = 1 + 1.6 * Math.max(0, this.fill - 0.5);           // backpressure: slower as the belt fills
      const P = this.M.phase;
      this.task = { phase: "reach", t: 0, hit, key: sv.best.key, mat, eff, slow, dur: { reach: P.reach * slow, contact: P.contact, cut: (P.cut / eff) * slow, follow: P.follow, drop: P.drop, back: P.back * slow }, cut: null, from: { ...this.pose } };
      this._sound("miner_motor", player, 0.7);
    }
    this._step(dt, player);
  }

  _step(dt, player) {
    const T = this.task, D = T.dur;
    T.t += dt;
    const u = Math.min(1, T.t / D[T.phase]);
    const aim = this._aimAt(T.hit, 0);
    if (T.phase === "reach") {
      // anticipation: it pulls back a little before it goes in
      const back = this._aimAt(T.hit, 0.42);
      this._blend(T.from, u < 0.25 ? this._lerp(T.from, this.rest, u / 0.25 * 0.3) : back, ease(u < 0.25 ? u / 0.25 : (u - 0.25) / 0.75));
      if (u >= 1) this._next("contact");
    } else if (T.phase === "contact") {
      this._blend(this._aimAt(T.hit, 0.42), aim, ease(u));
      if (u >= 1) { this._next("cut"); this._sound("miner_hit", player, 0.8 + 0.3 * (T.mat || 0) / 3); this._fx(T, 0.8); }
    } else if (T.phase === "cut") {
      // resistance: the drum bites in, the head shakes (more in compact / gravel), it pushes on along the stroke
      const push = this._aimAt(T.hit, -0.12 * u), sh = SHAKE[T.mat] || 0.01;
      this._blend(aim, push, u);
      this.pose.boom += Math.sin(this.time * 47) * sh; this.pose.slew += Math.sin(this.time * 31) * sh * 0.5;
      this.pose.spin += dt * (11 - 3 * (T.mat || 0));
      if ((T._fxT = (T._fxT || 0) - dt) <= 0) { T._fxT = 0.28; this._fx(T, 0.5); }
      if ((T._sT = (T._sT || 0) - dt) <= 0) { T._sT = 0.62; this._sound("miner_cut", player, 0.6 + 0.15 * (T.mat || 0)); }
      if (!T.cut && u >= 0.55) T.cut = this._cut(T);                  // the bite itself (atomic)
      if (u >= 1) this._next("follow");
    } else if (T.phase === "follow") {
      // follow-through: on through the cut and up out of it
      this._blend(this._aimAt(T.hit, -0.12), this._aimAt(T.hit, 0.3, 0.45), ease(u));
      this.pose.spin += dt * 8 * (1 - u);
      if (u >= 1) this._next("drop");
    } else if (T.phase === "drop") {
      // over the internal belt's chute: the bite falls onto it
      this._blend(T.from, this.drop || (this.drop = this._dropPose()), ease(u));
      if (u >= 1) {
        if (T.cut && T.cut.ml > 0) { this._load(); this._spill(); }
        this._next("back");
      }
    } else if (T.phase === "back") {
      // settle: back towards the face with a little overshoot
      const k = ease(u), o = Math.sin(u * Math.PI) * 0.04 * (1 - u);
      this._blend(T.from, this.rest, k);
      this.pose.boom += o;
      if (u >= 1) { this.task = null; if (T.cut && !T.cut.ok) this._bad.set(T.key, this.time + 30); }
    }
    this._aimOut(dt);
    this.rig.setPose(this.pose);
  }

  _next(phase) { const T = this.task; T.phase = phase; T.t = 0; T.from = { ...this.pose }; }

  // the bite: a real dig at the hit, into the internal belt (it has room - checked before the reach)
  _cut(T) {
    const m = this.ctx.mining(), L = this.ctx.ledger;
    const eye = this._w.set(this.x, this.y + AM.boomPivot[1] + 0.7, this.z);
    const r = m.action(T.hit, this.DEF, null, eye);
    if (this.ctx.economy) this.ctx.economy().recordAction(r, "autominer");
    if (!r.ok || r.blocked || r.kind !== "dig") { this.stats.blocked++; return { ok: false, ml: 0, material: r.material }; }
    const dig = batchFromDig(r, "autominer", this.ctx.nextId());
    L.inUg += dig.goldUg; L.inFineUg += dig.fineUg; L.inG += dig.massG; L.inMl += dig.volumeMl; L.inFinds += dig.finds.length;
    const ml = dig.volumeMl, ug = dig.goldUg;
    this.buffer.put(dig);                                             // (room was checked: ~8 l in, 1,35x kept free)
    this.stats.cuts++;
    this.stats.dugMl += ml;
    this.placeDug += ml;
    this.stats.mountainG += Math.round((r.mountainKg || 0) * 1000);
    return { ok: true, ml, material: r.material, fineUg: r.fineUg, pieces: r.findCount, mountainKg: r.mountainKg, ug, at: { x: T.hit.x, y: T.hit.y, z: T.hit.z } };
  }

  // the rear belt: into the intake / onto the raw pile at its tip, as much as fits
  _discharge(dt) {
    const R = this.recv;
    if (!R || this.buffer.volumeMl <= 0) { this.outAcc = 0; this._outRun = false; return; }
    this.outAcc += (this.M.outLpm * 1000 / 60) * dt;
    if (this.outAcc < 500) return;
    const want = Math.min(Math.floor(this.outAcc), this.buffer.volumeMl);
    let ml = 0;
    if (R.kind === "intake") {
      const cv = this.ctx.conveyor && this.ctx.conveyor();
      if (cv && cv.installed) ml = transfer(this.buffer, cv.intake, want, this.ctx.nextId());
      if (ml > 0) { this.stats.intakeMl += ml; cv.stats.inMl += ml; cv._fillSig = null; }
    } else if (R.kind === "pile") {
      const P = R.pile, tip = this._tipWorld();
      // the pile up to the tip: it waits (nothing falls beside it)
      if (P.heightAt(tip.x, tip.z) < tip.y - 0.35) ml = P.dumpFrom(this.buffer, want, tip.x, tip.z, 0.45);
      if (ml > 0) this.stats.pileMl += ml;
    }
    this.outAcc = ml > 0 ? Math.max(0, this.outAcc - ml) : Math.min(this.outAcc, 3000);
    this._outRun = ml > 0;
    if (ml > 0) {
      this.stats.outMl += ml;
      this._load();
      if (this.ctx.effects && Math.random() < 0.35) { const tip = this._tipWorld(), fx = this.ctx.effects(); if (fx) fx.spill(tip.x, tip.y - 0.1, tip.z, { index: 0 }, 0.4); }
    }
  }

  // ---------------------------------------------------------------- poses

  // the pose that puts the drum at the hit (offset `back` m out along the face's normal, `up` m higher)
  _aimAt(hit, back = 0, up = 0) {
    const R = this.root, inv = this._inv || (this._inv = new this.THREE.Matrix4());
    inv.copy(R.matrixWorld).invert();
    const n = hit.normal || { x: 0, y: 1, z: 0 };
    const p = this._v.set(hit.x + n.x * (back + 0.2), hit.y + n.y * (back + 0.2) + 0.14 + up, hit.z + n.z * (back + 0.2)).applyMatrix4(inv);
    // the boom's foot (root frame) -> the target: slew, then a two-link reach (boom + telescoping stick)
    const bx = p.x - AM.boomPivot[0], by = p.y - (AM.deckY + 0.3), bz = p.z;
    const slew = Math.atan2(-bz, bx), r = Math.hypot(bx, bz), D = Math.hypot(r, by);
    const ext = clamp(D - AM.boomL * 0.55, AM.stickL[0], AM.stickL[1]);
    const L1 = AM.boomL, L2 = ext, cosB = clamp((L1 * L1 + D * D - L2 * L2) / (2 * L1 * D), -1, 1);
    const base = Math.atan2(by, r), boom = base + Math.acos(cosB);
    const cosK = clamp((L1 * L1 + L2 * L2 - D * D) / (2 * L1 * L2), -1, 1), stick = -(Math.PI - Math.acos(cosK));
    return { slew, boom, stick, ext, spin: this.pose.spin, outSlew: this.pose.outSlew, outLuff: this.pose.outLuff };
  }

  _dropPose() { return { slew: 0.12, boom: 0.42, stick: -1.75, ext: AM.stickL[0], spin: this.pose.spin, outSlew: this.pose.outSlew, outLuff: this.pose.outLuff }; }

  _lerp(a, b, k) { const o = {}; for (const key of ["slew", "boom", "stick", "ext"]) o[key] = a[key] + (b[key] - a[key]) * k; return o; }

  _blend(a, b, k) {
    for (const key of ["slew", "boom", "stick", "ext"]) this.pose[key] = a[key] + (b[key] - a[key]) * k;
  }

  _pose(dt, target, rate) {
    const f = 1 - Math.exp(-dt * rate);
    for (const key of ["slew", "boom", "stick", "ext"]) this.pose[key] += (target[key] - this.pose[key]) * f;
    this._aimOut(dt);
    this.rig.setPose(this.pose);
  }

  // the rear belt swings to its receiver (the intake / its point on the raw pile)
  _aimOut(dt) {
    const R = this.recv;
    // working: towards its receiver at the belt's tilt; parked / moved: straight back, a little lower (transport)
    let slew = 0, luff = 0.1;
    if (R && this.placed) { slew = R.off || 0; luff = this.M.out.luff; }
    const f = 1 - Math.exp(-(dt || 1) * 2.5);
    this.pose.outSlew += (slew - this.pose.outSlew) * f;
    this.pose.outLuff += (luff - this.pose.outLuff) * f;
  }

  _tipWorld() { this.root.updateMatrixWorld(true); return this.rig.outTipWorld(this._w); }

  // ---------------------------------------------------------------- looks / sound

  _load() {
    const b = this.buffer, m = b.massG || 1, c = b.comp(), RGB = [[0.48, 0.34, 0.22], [0.42, 0.3, 0.2], [0.55, 0.5, 0.42], [0.5, 0.48, 0.45]];
    const rgb = [0, 0, 0];
    for (let k = 0; k < 4; k++) { const s = (c[k] || 0) / m; rgb[0] += RGB[k][0] * s; rgb[1] += RGB[k][1] * s; rgb[2] += RGB[k][2] * s; }
    this.rig.setLoad(this.fill, b.massG > 0 ? rgb : null);
  }

  _fx(T, strength) {
    const fx = this.ctx.effects && this.ctx.effects();
    if (!fx || !T.hit) return;
    fx.impact(T.hit, T.mat || 0, T.mat >= 2 ? "rock" : "pickaxe", null, strength);
  }

  _spill() {
    const fx = this.ctx.effects && this.ctx.effects();
    if (!fx) return;
    const F = this._frame(), p = F.at(AM.beltIn[0] + 0.1, -0.42);
    fx.spill(p.x, this.y + AM.beltIn[1] + 0.3, p.z, { index: this.task ? this.task.mat || 0 : 0 }, 0.5);
  }

  _sound(kind, player, strength = 1) {
    if (!this.ctx.sound || !player) return;
    const d = Math.hypot(player.x - this.x, player.z - this.z);
    if (d < 30) this.ctx.sound(kind, { dist: d, strength });
  }

  // ---------------------------------------------------------------- tests / benchmark / developer tools

  /** one bite at once (no animation): -> the cut's result (null: no room / nothing to take) */
  cutNow() {
    if (!this.placed || this.buffer.room < this.M.biteMl * 1.35) return null;
    const sv = this.survey();
    if (!sv.best) { this.on = false; this.status = this._why(sv); return null; }
    const t = this.ctx.terrain(), hit = { x: sv.best.x, y: sv.best.y, z: sv.best.z, normal: t.getNormalAt(sv.best.x, sv.best.z), distance: 0, diggable: true, boulder: null };
    const r = this._cut({ hit, mat: this.ctx.mining().materialAtHit(hit) });
    if (!r.ok) this._bad.set(sv.best.key, this.time + 30);
    this._load();
    return r;
  }

  /** simulated time (benchmark, developer fast-forward): bites at the material's pace, the rear belt */
  sim(sec) {
    if (!this.on || !this.placed) return 0;
    let moved = 0;
    this._simT = (this._simT || 0) + sec;
    this.stats.runS += sec;
    for (let s = 0; s < sec; s++) this._discharge(1);
    while (this._simT > 0) {
      if (this.buffer.room < this.M.biteMl * 1.35) { this.stats.waitS += this._simT; this._simT = 0; this.status = "waiting"; break; }
      const sv = this.survey();
      if (!sv.best) { this.on = false; this.status = this._why(sv); this._simT = 0; break; }
      const t = this.ctx.terrain(), hit = { x: sv.best.x, y: sv.best.y, z: sv.best.z, normal: t.getNormalAt(sv.best.x, sv.best.z), distance: 0, diggable: true, boulder: null };
      const m = this.ctx.mining(), mat = m.materialAtHit(hit), eff = Math.max(0.3, m.efficiencyAtHit(hit, this.DEF) || 0.6), P = this.M.phase;
      const dur = (P.reach + P.contact + P.cut / eff + P.follow + P.drop + P.back) * (1 + 1.6 * Math.max(0, this.fill - 0.5));
      if (this._simT < dur) break;
      this._simT -= dur;
      const r = this._cut({ hit, mat });
      if (!r.ok) this._bad.set(sv.best.key, this.time + 30);
      else moved += r.ml;
      this.status = "running";
    }
    this.time += sec;
    this._load();
    return moved;
  }

  serialize() {
    return { placed: this.placed, x: +this.x.toFixed(3), z: +this.z.toFixed(3), heading: +this.heading.toFixed(6), on: this.on, budgetMl: this.budgetMl, placeDug: this.placeDug, status: this.status === "placing" ? "stopped" : this.status, buffer: this.buffer.serialize(), stats: { ...this.stats, runS: Math.round(this.stats.runS), waitS: Math.round(this.stats.waitS) } };
  }

  dispose() {
    this.disposed = true;
    for (const c of this.colliders) { const i = this.world.colliders.indexOf(c); if (i >= 0) this.world.colliders.splice(i, 1); }
    this.scene.remove(this.root);
    this.rig.dispose();
  }
}
