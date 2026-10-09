// GoldRush - the sluice box (phase 6): the first processing that runs on
// its own - but only while the game runs (no offline progress: a closed or
// hidden game does not wash anything, a reload does not catch up).
//
//   DELIVERED  after the purchase a stack of boards lies at its place by
//              the water tank; [E] builds it (a short moment, parts rising
//              into place) - a fixed installation, no free placement.
//   HOPPER     takes material from a bucket or a wheelbarrow (pour(), the
//              same transfer every container uses - a loader or a conveyor
//              will feed it the same way later).
//   WATER      on: the box runs - the feed goes down at FEED_LPM, in steps of
//              STEP_ML, each step split exactly (sluiceSplit): the riffles
//              keep the heavy part (every piece, most of the fine gold, a
//              little black sand), the rest leaves as tailings onto the heap.
//   RIFFLES    load up; after ~SLUICE_TUNING.riffleL litres they hold less
//              and less - time to clean out: water off, brush the mat out
//              (a few seconds of work). Nuggets are picked out at once (into
//              the pouch); the rest - black sand with the gold - goes into
//              the concentrate tray at the wash trough, to be PANNED (heavy
//              concentrate: little loss). The gold pan stays the last step.
//
// Nothing here creates gold or money: every microgram of the hopper ends up
// in the riffles, the tray, the pouch (via the pan) or the tailings - the
// processing ledger (goldrush-processing.js) checks it.

import { MaterialBatch, STAGE, SLUICE_TUNING, sluiceSplit } from "./goldrush-material.js";
import { FIND } from "./goldrush-resources.js";
import { SLUICE } from "./goldrush-mechmodels.js";
import { PILE_SITES } from "./goldrush-stockpile.js";
import { mergeStatic, unmerge } from "./goldrush-merge.js";
import { WP } from "./goldrush-washplant.js";

// the place: head (hopper) south of the water tank, the box running east,
// down; a wheelbarrow comes from the open side (south / west) - Zone B
// further south stays free for the machines of later phases
export const SLUICE_AT = { x: -20.55, z: -2.1 };
// Prompt 10: where the box's tailings come down (its end) and how high the outlet pile may stand there
export const OUTLET = { x: SLUICE_AT.x + SLUICE.len + 0.2, z: SLUICE_AT.z, h: 0.6 };
void PILE_SITES;
export const SLUICE_SPOTS = {
  feed: { x: -20.82, z: -1.12, yaw: 0 },            // north of the hopper, facing it: bucket / water
  clean: { x: -19.2, z: -1.26, yaw: 0 },            // beside the riffle bed: clean out
  tray: { x: -16.3, z: 1.12 },                      // the concentrate tray at the wash trough
};
export const HOPPER_ML = 50000;                     // large hopper (upgrade): 90 l
export const FEED_LPM = 10;                         // litres a minute through the box (tuned, benchmark)
export const STEADY_MAX_LPM = 14;                   // fed steadily by a feeder (phase 7) it takes up to this - surges overload it, an even feed does not
// phase 9: the high-flow sluice (upgrade "sluice.highflow"): a wider box with deeper riffles - more litres a
// minute, the riffles hold far more before a clean out, a little less of the fine gold per litre at that flow
export const HIGHFLOW = { base: 20, max: 32, riffleL: 640, capture: 0.62, captureMat: 0.72, widen: 1.65 };
const STEP_ML = 500;
const BUILD_S = 2.4;
const CLEAN_S = 4;

const HEAP_B_MAX = 2.5;                            // the fan's half width at most (it reaches the mound's foot / Zone B); beyond it only gets higher
const finite = (v) => typeof v === "number" && Number.isFinite(v);

// the tailings heap's shape for a volume (m3): a fan of washed sand at about the
// angle of repose, its top under the outlet, spreading east / north-east onto the
// free ground (between the outlet, the ramp's Zone B and the wash place).
// volume of the unit fan (goldrush-mechmodels.js heapFan): 0.603 a b h; a = 1.3 b, h = 0.55 b
export function heapShape(m3) {
  const v = Math.max(0, m3), vCap = 0.431 * HEAP_B_MAX ** 3, b = Math.min(HEAP_B_MAX, Math.cbrt(v / 0.431));
  const extra = v > vCap ? Math.min(0.6, (v - vCap) / 20) : 0;
  return { a: 1.3 * b, b, h: 0.55 * b * (1 + extra), x: SLUICE.len + 0.22, z: -0.15 * b };
}
const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);

export class Sluice {
  /**
   * @param saved  doc.processing.sluice (v6) or null
   * @param ctx    { ledger, economy, nextId: () => int, upgrades: () => Set }
   */
  constructor(THREE, scene, world, models, saved, ctx) {
    this.THREE = THREE;
    this.world = world;
    this.models = models;
    this.ctx = ctx;
    const s = saved || {};
    this.state = s.state === "ready" || s.state === "delivered" ? s.state : "delivered";
    this.hopper = { batch: MaterialBatch.from(s.hopper) || new MaterialBatch({ stage: STAGE.RAW }), capacityMl: HOPPER_ML };
    this.riffles = MaterialBatch.from(s.riffles) || new MaterialBatch({ stage: STAGE.HEAVY });
    this.riffles.stage = STAGE.HEAVY;
    this.tray = { batch: MaterialBatch.from(s.tray) || new MaterialBatch({ stage: STAGE.HEAVY }), capacityMl: Infinity };
    this.tray.batch.stage = STAGE.HEAVY;
    this.running = !!s.running && this.state === "ready";
    this.loadMl = int(s.loadMl);                    // through the box since the last clean out
    this.tailMl = int(s.tailMl);                    // the heap (shown)
    this.acc = 0;
    const st = s.stats || {};
    this.stats = { processedMl: int(st.processedMl), heavyUg: int(st.heavyUg), cleanouts: int(st.cleanouts), stepUg: 0 };
    this.build = -1;                                // build animation clock
    this.clean = { progress: 0 };
    this.time = 0;
    this._build(scene);
    this.applyUpgrades();
  }

  _build(scene) {
    const THREE = this.THREE, M = this.models;
    this.root = new THREE.Group();
    this.root.position.set(SLUICE_AT.x, 0, SLUICE_AT.z);
    scene.add(this.root);
    this.model = M.sluice();
    this.root.add(this.model);
    this.kit = M.sluiceKit();
    this.root.add(this.kit);
    const u = this.model.userData;
    // the pipe from the tank down to the head box (world -> local)
    // (from high on the tank's south side: the water runs down into the head box)
    const a = new THREE.Vector3(-19.62 - SLUICE_AT.x, 1.72, 0.72 - SLUICE_AT.z), b = new THREE.Vector3(0.02, SLUICE.headY + 0.42, -0.05);
    u.pipe.position.copy(a).add(b).multiplyScalar(0.5);
    u.pipe.scale.set(0.03, a.distanceTo(b), 0.03);
    u.pipe.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    // the concentrate tray at the wash trough (a shallow black box on a stump)
    this.trayModel = new THREE.Group();
    this.trayModel.position.set(SLUICE_SPOTS.tray.x, 0, SLUICE_SPOTS.tray.z);
    M._mesh(M.cyl, M.darkWood, 0.16, 0.42, 0.16, 0, 0.21, 0, this.trayModel);
    M._mesh(M.box, M.galvDark, 0.34, 0.05, 0.26, 0, 0.445, 0, this.trayModel);
    this.trayFill = M._mesh(M.plane, M.heavy.clone(), 0.3, 1, 0.22, 0, 0.472, 0, this.trayModel, false);
    M.mats.push(this.trayFill.material);
    this.trayFill.material.opacity = 1;
    this.trayFill.material.transparent = false;
    this.trayFill.material.depthWrite = true;
    // the gold that shows in the black sand of the concentrate tray (after a clean out: the reward)
    this.traySpecks = new THREE.InstancedMesh(M.pebble, M.goldSpeck, 24);
    this.traySpecks.count = 0;
    this.traySpecks.frustumCulled = false;
    this.trayModel.add(this.traySpecks);
    scene.add(this.trayModel);
    this.collider = { type: "box", x: SLUICE_AT.x + 1.25, z: SLUICE_AT.z, hw: 1.62, hd: 0.34, rot: 0 };
    this.world.colliders.push(this.collider);
    this.heapCollider = { type: "box", x: 0, z: 0, hw: 0, hd: 0, rot: 0 };     // once the heap is high enough to be in the way
    this._drops = Array.from({ length: 24 }, () => ({ t: -1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, s: 0 }));
    this._silt = 0;
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._v = new THREE.Vector3(); this._s = new THREE.Vector3();
    this._sync();
  }

  get installed() { return this.state === "ready"; }
  // Prompt 10: the wash plant around this box (goldrush-washplant.js) - while it stands it does the washing
  get wp() { const w = this.ctx.washplant ? this.ctx.washplant() : null; return w && w.installed ? w : null; }
  // litres a minute through the box: FEED_LPM, more while a feeder doses it evenly (set every step by the processing system)
  get rateLpm() { const wp = this.wp; if (wp) return wp.rateLpm; return this.highflow ? Math.max(HIGHFLOW.base, Math.min(HIGHFLOW.max, this.steadyLpm || 0)) : Math.max(FEED_LPM, Math.min(STEADY_MAX_LPM, this.steadyLpm || 0)); }
  get capacityMl() { return this.hopper.capacityMl; }
  get riffleL() { return this.wp ? WP.riffleL : this.highflow ? HIGHFLOW.riffleL : SLUICE_TUNING.riffleL; }
  get riffleLoad() { const wp = this.wp; return wp ? wp.maxRiffleLoad() : this.loadMl / 1000 / this.riffleL; }       // 1 = time to clean out
  get processing() { return this.installed && this.running && this.hopper.batch.volumeMl > 0; }

  applyUpgrades() {
    const ups = this.ctx.upgrades(), wp = this.wp;
    this.hopper.capacityMl = wp ? WP.distMl : ups.has("sluice.hopper") ? 90000 : HOPPER_ML;
    this.highflow = ups.has("sluice.highflow") || !!wp;
    this.capture = this.highflow ? (ups.has("sluice.mat") ? HIGHFLOW.captureMat : HIGHFLOW.capture) : ups.has("sluice.mat") ? 0.75 : SLUICE_TUNING.capture;
    this.model.userData.hop.scale.setScalar(ups.has("sluice.hopper") ? 1.18 : 1);
    this.model.userData.bed.material.color.setHex(ups.has("sluice.mat") ? 0xb7c2a6 : 0xffffff);   // the moss mat: lighter, greener
    // phase 9: the high-flow box is wider (its baked frame is rebuilt at the new width); Prompt 10: inside the
    // wash plant its small hopper goes (the distribution box takes its place)
    const look = `${this.highflow}:${!!wp}`;
    if (look !== this._look) {
      const u = this.model.userData;
      this._look = look;
      if (this._merged) { unmerge(this.model, this._merged, u.parts); this._merged = null; }
      u.box.scale.z = this.highflow ? HIGHFLOW.widen : 1;
      this.collider.hd = this.highflow ? 0.46 : 0.34;
      u.hop.visible = !wp;
      const hopParts = new Set(), mark = (o) => { hopParts.add(o); for (const c of o.children) mark(c); };
      mark(u.hop);
      for (const p of u.parts) if (hopParts.has(p)) p.visible = !wp;
      if (this.installed) { this._merged = mergeStatic(this.THREE, this.model, wp ? u.parts.filter((p) => !hopParts.has(p)) : u.parts); if (this.ctx.warm) this.ctx.warm(); }
      if (this.trayModel) this._sync();                        // (the lanes' water, the hopper / the box)
    }
  }

  // what the riffles still hold of the fine gold right now (falls once overloaded)
  efficiency() {
    if (this.wp) return this.wp.efficiency(0);
    const L = this.loadMl / 1000, cap = this.riffleL, over = SLUICE_TUNING.overload;
    const k = L <= cap ? 1 : Math.max(over, 1 - ((L - cap) / cap) * (1 - over));
    return this.capture * k;
  }

  // ---- actions

  startBuild() {
    if (this.state !== "delivered" || this.build >= 0) return false;
    this.build = 0;
    this._sync();                                  // the boards go, the parts start rising
    return true;
  }

  setWater(on) {
    if (!this.installed) return false;
    this.running = !!on;
    if (!on) this.acc = 0;
    this._sync();
    return true;
  }

  canClean() { if (this.wp) return this.wp.canClean(); return this.installed && !this.running && (this.riffles.volumeMl > 0 || this.riffles.goldUg > 0); }

  /**
   * CLEAN OUT (after the work): nuggets out by hand into the pouch, the rest
   * of the riffles into the concentrate tray (to pan). -> result
   */
  finishClean() {
    if (this.wp) return this.wp.finishClean();                  // Prompt 10: all three mats, into the plant's tub
    const r = this.riffles, nug = r.finds.filter((f) => f.cls === FIND.NUGGET);
    r.finds = r.finds.filter((f) => f.cls !== FIND.NUGGET);
    const got = nug.length ? this.ctx.economy.recover(0, nug) : { cents: 0, ug: 0, pieces: 0 };
    this.ctx.ledger.recoveredUg += got.ug;
    const heavyMl = r.volumeMl, heavyUg = r.goldUg;
    this.tray.batch.absorb(r);
    this.riffles = new MaterialBatch({ id: this.ctx.nextId(), stage: STAGE.HEAVY });
    this.loadMl = 0;
    this.stats.cleanouts++;
    this.clean.progress = 0;
    this._sync();
    return { ok: true, nuggets: nug.length, nuggetUg: got.ug, cents: got.cents, heavyMl, heavyUg, bestUg: got.bestUg || 0 };
  }

  // Prompt 10 (human QA): its tailings are material on the OUTLET pile (goldrush-stockpile.js tailOut) - once
  // the pile stands up to the box's end, the sluice backs up (nothing is lost: the hopper keeps what waits)
  outletFull() {
    const out = this.ctx.tailOut ? this.ctx.tailOut() : null;
    if (!out) return false;
    const t = out.thickAt(OUTLET.x, OUTLET.z);
    this._choked = t >= OUTLET.h || (!!this._choked && t >= OUTLET.h - 0.12);      // choked: free again once ~12 cm are cleared
    return this._choked;
  }

  // ---- running: called every frame (and by the simulation) with the time that passed
  process(dt) {
    if (this.wp) { const done = this.wp.process(dt); this.blockedOut = this.wp.blocked; return done; }
    if (!this.processing) { this.acc = 0; this.blockedOut = false; return 0; }
    this.acc += (this.rateLpm * 1000 / 60) * dt;
    let done = 0;
    const L = this.ctx.ledger, out = this.ctx.tailOut ? this.ctx.tailOut() : null;
    this.blockedOut = this.outletFull();
    if (this.blockedOut) { this.acc = Math.min(this.acc, STEP_ML); this.stats.blockedS = (this.stats.blockedS || 0) + dt; }
    while (!this.blockedOut && this.acc >= STEP_ML && this.hopper.batch.volumeMl > 0) {
      const part = this.hopper.batch.take(STEP_ML, this.ctx.nextId());
      if (this.hopper.batch.volumeMl > 0 && this.hopper.batch.volumeMl < 60) part.absorb(this.hopper.batch);
      const vol = part.volumeMl;
      const { heavy, tails } = sluiceSplit(part, this.efficiency(), SLUICE_TUNING.heavyShare, [this.ctx.nextId(), this.ctx.nextId()]);
      this.stats.heavyUg += heavy.goldUg;
      this.riffles.absorb(heavy);
      this.tailMl += tails.volumeMl;
      if (out) {
        // down the outlet onto the pile (it books them as tailings), landing a little apart every time
        const j = this._oj = ((this._oj || 0) + 1) % 997, a = j * 2.39996, rr = 0.1 + 0.25 * ((j * 0.618) % 1);
        out.dump(tails, OUTLET.x + 0.15 + Math.cos(a) * rr, OUTLET.z + Math.sin(a) * rr * 1.4, 0.32);
        this.blockedOut = this.outletFull();
      } else { L.tailUg += tails.goldUg; L.tailG += tails.massG; L.tailMl += tails.volumeMl; }
      this.loadMl += vol;
      this.stats.processedMl += vol;
      this.acc -= STEP_ML;
      done += vol;
    }
    if (this.hopper.batch.volumeMl <= 0) this.acc = 0;
    return done;
  }

  // gold held by the sluice (hopper, riffles, tray) - ledger check
  goldUg() { return this.hopper.batch.goldUg + this.riffles.goldUg + this.tray.batch.goldUg; }
  massG() { return this.hopper.batch.massG + this.riffles.massG + this.tray.batch.massG; }

  // ---- visuals

  // the boxes water runs down: this one, and while the wash plant stands its two more lanes
  lanes() {
    const wp = this.wp, out = this._lanes || (this._lanes = []);
    out.length = 0;
    out.push(this.model.userData);
    if (wp) for (const m of wp.laneModels) out.push(m.userData);
    return out;
  }

  _sync() {
    const u = this.model.userData;
    this.kit.visible = this.state === "delivered" && this.build < 0;
    this.model.visible = this.state === "ready" || this.build >= 0;
    const run = this.installed && this.running, wpl = this.wp;
    for (const lu of this.lanes()) { lu.water.visible = run && !wpl; lu.out.visible = run && !wpl; lu.foam.visible = run && !wpl; if (wpl) { lu.heavy.visible = false; lu.gravel.count = 0; } else lu.heavy.visible = true; }
    if (wpl) wpl.fxOn(true);
    else if (this.ctx.washplant && this.ctx.washplant()) this.ctx.washplant().fxOn(false);
    u.fall.visible = run;
    this.trayModel.visible = this.installed;
    this.trayFill.visible = this.tray.batch.volumeMl > 0 || this.tray.batch.goldUg > 0;
    // built: legs, box and hopper boards baked into a few meshes (phase 7A draw calls)
    if (this.installed && !this._merged) { this._merged = mergeStatic(this.THREE, this.model, u.parts); if (this.ctx.warm) this.ctx.warm(); }
    this._fill();
  }

  _fill() {
    const u = this.model.userData, H = SLUICE.hopper, wp = this.wp;
    const hv = this.hopper.batch.volumeMl, frac = Math.min(1, hv / this.hopper.capacityMl);
    u.hopFill.visible = hv > 50 && !wp;
    u.hopFill.position.y = 0.03 + frac * (H.h - 0.06);
    const load0 = wp ? wp.maxRiffleLoad() : this.riffleLoad;
    u.heavy.material.opacity = Math.min(0.85, load0 * 0.75 + (this.riffles.volumeMl > 0 || (wp && wp.riffleMl() > 0) ? 0.12 : 0));
    // fine gold in the riffles: a few specks, more with the gold held (subtle - no glitter carpet)
    const nG = this.riffles.goldUg > 0 ? Math.min(40, Math.round(Math.sqrt(this.riffles.goldUg / 1500))) : 0;
    if (nG !== u.specks.count) {
      u.specks.count = nG;
      for (let i = 0; i < nG; i++) {
        const bar = i % 11, x = 0.25 + bar * ((SLUICE.len - 0.35) / 10) + 0.012 + ((i * 0.618) % 1) * 0.05;
        const z = (((i * 0.5698403 + 0.37) % 1) - 0.5) * (SLUICE.width - 0.06), sz = 0.0018 + ((i * 7919) % 5) * 0.0004;
        this._q.setFromAxisAngle(this._v.set(0, 1, 0), i * 2.3);
        this._m.compose(this._v.set(x, 0.009, z), this._q, this._s.set(sz, sz * 0.35, sz));
        u.specks.setMatrixAt(i, this._m);
      }
      u.specks.instanceMatrix.needsUpdate = true;
    }
    // the tailings heap: its shape from the volume (300 l small, 10 m3 big), out of the way once high
    // (Prompt 10: the real outlet pile draws itself - the phase-9 shape only without one)
    u.heap.visible = !(this.ctx.tailOut && this.ctx.tailOut()) && this.tailMl > 2000;
    const cols = this.world.colliders, hc = this.heapCollider, hi = cols.indexOf(hc);
    if (u.heap.visible) {
      const H = heapShape(this.tailMl / 1e6);
      u.heap.scale.set(H.a, H.h, H.b);
      u.heap.position.set(H.x, 0, H.z);
      if (H.h > 0.5) {
        hc.x = SLUICE_AT.x + H.x + 0.32 * H.a; hc.z = SLUICE_AT.z + H.z; hc.hw = H.a * 0.5; hc.hd = H.b * 0.55;
        if (hi < 0) cols.push(hc);
      } else if (hi >= 0) cols.splice(hi, 1);
    } else if (hi >= 0) cols.splice(hi, 1);
    this.trayFill.visible = this.installed && (this.tray.batch.volumeMl > 0 || this.tray.batch.goldUg > 0);
    if (this.traySpecks) {
      const nT = this.trayFill.visible ? Math.min(24, Math.round(Math.sqrt(this.tray.batch.goldUg / 2500))) : 0;
      if (nT !== this.traySpecks.count) {
        this.traySpecks.count = nT;
        for (let i = 0; i < nT; i++) {
          const sz = 0.002 + ((i * 7919) % 5) * 0.0005;
          this._m.compose(this._v.set((((i * 0.7548777 + 0.21) % 1) - 0.5) * 0.26, 0.475, (((i * 0.5698403 + 0.63) % 1) - 0.5) * 0.18), this._q.identity(), this._s.set(sz, sz * 0.35, sz));
          this.traySpecks.setMatrixAt(i, this._m);
        }
        this.traySpecks.instanceMatrix.needsUpdate = true;
      }
    }
  }

  // per frame: build animation, water, moving gravel, fills; onSound(kind) for the water loop
  update(dt, nearPlayer, onSound) {
    this.time += dt;
    const u = this.model.userData;
    if (this.build >= 0) {
      this.build += dt;
      const k = Math.min(1, this.build / BUILD_S), parts = u.parts;
      for (let i = 0; i < parts.length; i++) {
        const a = Math.max(0, Math.min(1, (k * parts.length * 1.15 - i) / 2));
        const e = a * a * (3 - 2 * a);
        parts[i].visible = a > 0.02;
        if (!parts[i].userData.s0) parts[i].userData.s0 = parts[i].scale.clone();
        const s0 = parts[i].userData.s0;
        parts[i].scale.set(s0.x, Math.max(0.001, s0.y * e), s0.z);
      }
      if (k >= 1) {
        for (const p of parts) if (p.userData.s0) { p.scale.copy(p.userData.s0); p.visible = true; }
        this.build = -1;
        this.state = "ready";
        this._sync();
      }
    }
    const run = this.installed && this.running, wp = this.wp, lanes = this.lanes();
    if (run) {
      this.models.flowMap.offset.x = (this.models.flowMap.offset.x - dt * 0.9) % 1;
      // clear (green-grey, you see the mat) - silty brown while material runs through, clearing again over some seconds
      const silty = this.processing ? 1 : 0;
      this._silt += (silty - this._silt) * Math.min(1, dt * (silty > this._silt ? 1.8 : 0.35));
      const k = this._silt;
      for (const lu of lanes) {
        lu.water.material.color.setRGB(0.2 + 0.26 * k, 0.29 + 0.07 * k, 0.29 - 0.04 * k);
        lu.water.material.opacity = 0.3 + 0.55 * k;
        lu.out.material.color.setRGB(0.62 + 0.18 * k, 0.6 + 0.08 * k, 0.56 - 0.02 * k);
        lu.out.material.opacity = 0.3 + 0.25 * k;
      }
      this._waterT = (this._waterT || 0) - dt;
      if (nearPlayer && this._waterT <= 0) { this._waterT = wp ? 1.25 : 1.4; if (onSound) onSound(wp ? "washplant_run" : "sluice_water"); }
    } else this._silt *= Math.exp(-dt * 0.35);
    // white water just below the bars: streaks that shift with the flow (tinted when silty); gravel tumbling down
    // the box and off the end - as much as the feed brings (a plant lane: while it is fed). With the wash plant all
    // three lanes go into its combined instanced meshes (one draw each) - its lanes' z in the first lane's frame
    if (run) this.models.foam.color.setRGB(0.95 - 0.25 * this._silt, 0.93 - 0.3 * this._silt, 0.88 - 0.38 * this._silt);
    const fx = wp ? wp.fx : null;
    let fi = 0, gi = 0;
    for (let l = 0; l < lanes.length; l++) {
      const lu = lanes[l], fm = fx ? fx.foam : lu.foam, zo = fx ? fx.inBox[l] : 0, sw = fx ? 1 / 1.65 : 1;
      if (!fx) { fm.visible = run; fi = 0; }
      if (run) {
        for (let i = 0; i < 11; i++) {
          const x = 0.25 + i * ((SLUICE.len - 0.35) / 10) + 0.045, j = 0.75 + 0.25 * Math.sin(this.time * 9 + i * 1.7 + l * 2.1);
          this._m.compose(this._v.set(x, 0.031, zo), this._q.identity(), this._s.set(0.06 * j, 1, (SLUICE.width - 0.04) * (0.85 + 0.15 * Math.sin(this.time * 6.3 + i + l))));
          fm.setMatrixAt(fi++, this._m);
        }
        fm.instanceMatrix.needsUpdate = true;
        if (fx) fm.count = fi;
      }
      const g = fx ? fx.gravel : lu.gravel, fed = wp ? wp.lanes[l].fed > 0 : this.processing, n = run && fed ? 12 : 0;
      if (!fx) gi = 0;
      if (fx || g.count !== n || n) {
        for (let i = 0; i < n; i++) {
          const ph = (this.time * 0.35 + i / n + l * 0.37) % 1.12, s = 0.012 + ((i * 37) % 7) * 0.003, z = Math.sin(i * 7.3) * (SLUICE.width * 0.32) * sw;
          let x = 0.15 + Math.min(1, ph) * (SLUICE.len - 0.25), y = 0.026 + s * 0.5;
          if (ph > 1) { const f = (ph - 1) / 0.12; x = SLUICE.len - 0.1 + f * 0.2; y -= f * f * 0.5; }      // over the end, down
          this._q.setFromAxisAngle(this._v.set(0, 0, 1), -this.time * 6 - i);
          this._m.compose(this._v.set(x, y, z + zo), this._q, this._s.set(s, s * 0.8, s * sw));
          g.setMatrixAt(gi++, this._m);
        }
        g.count = fx ? gi : n;
        g.instanceMatrix.needsUpdate = true;
      }
      // droplets: where the pipe's water hits the head box, and at the outlet (more while it washes; none on LOW) -
      // with the plant at the first lane only
      if (run && !this.lowDetail && (!fx || l === 0)) this._spray(dt, wp ? wp.lanes[l].fed > 0 : this.processing, lu, l);
      else if (lu.drops.count) lu.drops.count = 0;
    }
    if (fx) { fx.foam.visible = run; fx.gravel.visible = run && gi > 0; if (!run) { fx.foam.count = 0; fx.gravel.count = 0; } }
    this._fill();
  }

  // a few pooled droplets thrown up at the head and the outlet (ballistic, short-lived) - per lane its own pool
  _spray(dt, washing, u = this.model.userData, l = 0) {
    const pools = this._dropPools || (this._dropPools = [this._drops]);
    const D = pools[l] || (pools[l] = Array.from({ length: 24 }, () => ({ t: -1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, s: 0 })));
    const acc = this._dropAccs || (this._dropAccs = []);
    const rate = washing ? 26 : 12;
    acc[l] = (acc[l] || 0) + dt * rate;
    while (acc[l] >= 1) {
      acc[l] -= 1;
      const d = D.find((q) => q.t < 0);
      if (!d) break;
      const atHead = Math.random() < 0.45;
      d.t = 0; d.s = 0.006 + Math.random() * 0.007;
      if (atHead) { d.x = 0.05; d.y = SLUICE.headY + 0.04; d.z = (Math.random() - 0.5) * 0.2; d.vx = 0.2 + Math.random() * 0.5; d.vy = 0.5 + Math.random() * 0.6; d.vz = (Math.random() - 0.5) * 0.7; }
      else { d.x = SLUICE.len + 0.28; d.y = 0.06; d.z = (Math.random() - 0.5) * 0.25; d.vx = 0.3 + Math.random() * 0.5; d.vy = 0.6 + Math.random() * 0.7; d.vz = (Math.random() - 0.5) * 0.8; }
    }
    let n = 0;
    for (const d of D) {
      if (d.t < 0) continue;
      d.t += dt; d.vy -= 9.8 * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      if (d.t > 0.6 || d.y < 0) { d.t = -1; continue; }
      this._m.compose(this._v.set(d.x, d.y, d.z), this._q.identity(), this._s.set(d.s, d.s, d.s));
      u.drops.setMatrixAt(n++, this._m);
    }
    u.drops.count = n;
    if (n) u.drops.instanceMatrix.needsUpdate = true;
  }

  serialize() {
    return {
      state: this.build >= 0 ? "ready" : this.state, running: this.running,
      hopper: this.hopper.batch.serialize(), riffles: this.riffles.serialize(), tray: this.tray.batch.serialize(),
      loadMl: this.loadMl, tailMl: this.tailMl, stats: { processedMl: this.stats.processedMl, heavyUg: this.stats.heavyUg, cleanouts: this.stats.cleanouts },
    };
  }

  dispose(scene) {
    for (const c of [this.collider, this.heapCollider]) { const i = this.world.colliders.indexOf(c); if (i >= 0) this.world.colliders.splice(i, 1); }
    scene.remove(this.root);
    scene.remove(this.trayModel);
    for (const m of this._merged || []) m.geometry.dispose();
  }
}

export { STEP_ML, CLEAN_S, BUILD_S, finite };
