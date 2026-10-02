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

// the place: head (hopper) south of the water tank, the box running east,
// down; a wheelbarrow comes from the open side (south / west) - Zone B
// further south stays free for the machines of later phases
export const SLUICE_AT = { x: -20.55, z: -2.1 };
export const SLUICE_SPOTS = {
  feed: { x: -20.82, z: -1.12, yaw: 0 },            // north of the hopper, facing it: bucket / water
  clean: { x: -19.2, z: -1.26, yaw: 0 },            // beside the riffle bed: clean out
  tray: { x: -16.3, z: 1.12 },                      // the concentrate tray at the wash trough
};
export const HOPPER_ML = 50000;                     // large hopper (upgrade): 90 l
export const FEED_LPM = 10;                         // litres a minute through the box (tuned, benchmark)
const STEP_ML = 500;
const BUILD_S = 2.4;
const CLEAN_S = 4;

const finite = (v) => typeof v === "number" && Number.isFinite(v);
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
    scene.add(this.trayModel);
    this.collider = { type: "box", x: SLUICE_AT.x + 1.25, z: SLUICE_AT.z, hw: 1.62, hd: 0.34, rot: 0 };
    this.world.colliders.push(this.collider);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._v = new THREE.Vector3(); this._s = new THREE.Vector3();
    this._sync();
  }

  get installed() { return this.state === "ready"; }
  get capacityMl() { return this.hopper.capacityMl; }
  get riffleLoad() { return this.loadMl / 1000 / SLUICE_TUNING.riffleL; }       // 1 = time to clean out
  get processing() { return this.installed && this.running && this.hopper.batch.volumeMl > 0; }

  applyUpgrades() {
    const ups = this.ctx.upgrades();
    this.hopper.capacityMl = ups.has("sluice.hopper") ? 90000 : HOPPER_ML;
    this.capture = ups.has("sluice.mat") ? 0.75 : SLUICE_TUNING.capture;
    this.model.userData.hop.scale.setScalar(ups.has("sluice.hopper") ? 1.18 : 1);
    this.model.userData.bed.material.color.setHex(ups.has("sluice.mat") ? 0xb7c2a6 : 0xffffff);   // the moss mat: lighter, greener
  }

  // what the riffles still hold of the fine gold right now (falls once overloaded)
  efficiency() {
    const L = this.loadMl / 1000, cap = SLUICE_TUNING.riffleL, over = SLUICE_TUNING.overload;
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

  canClean() { return this.installed && !this.running && (this.riffles.volumeMl > 0 || this.riffles.goldUg > 0); }

  /**
   * CLEAN OUT (after the work): nuggets out by hand into the pouch, the rest
   * of the riffles into the concentrate tray (to pan). -> result
   */
  finishClean() {
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
    return { ok: true, nuggets: nug.length, nuggetUg: got.ug, cents: got.cents, heavyMl, heavyUg };
  }

  // ---- running: called every frame (and by the simulation) with the time that passed
  process(dt) {
    if (!this.processing) { this.acc = 0; return 0; }
    this.acc += (FEED_LPM * 1000 / 60) * dt;
    let done = 0;
    const L = this.ctx.ledger;
    while (this.acc >= STEP_ML && this.hopper.batch.volumeMl > 0) {
      const part = this.hopper.batch.take(STEP_ML, this.ctx.nextId());
      if (this.hopper.batch.volumeMl > 0 && this.hopper.batch.volumeMl < 60) part.absorb(this.hopper.batch);
      const vol = part.volumeMl;
      const { heavy, tails } = sluiceSplit(part, this.efficiency(), SLUICE_TUNING.heavyShare, [this.ctx.nextId(), this.ctx.nextId()]);
      this.stats.heavyUg += heavy.goldUg;
      this.riffles.absorb(heavy);
      L.tailUg += tails.goldUg; L.tailG += tails.massG; L.tailMl += tails.volumeMl;
      this.tailMl += tails.volumeMl;
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

  _sync() {
    const u = this.model.userData;
    this.kit.visible = this.state === "delivered" && this.build < 0;
    this.model.visible = this.state === "ready" || this.build >= 0;
    const run = this.installed && this.running;
    u.water.visible = run;
    u.fall.visible = run;
    u.out.visible = run;
    this.trayModel.visible = this.installed;
    this.trayFill.visible = this.tray.batch.volumeMl > 0 || this.tray.batch.goldUg > 0;
    this._fill();
  }

  _fill() {
    const u = this.model.userData, H = SLUICE.hopper;
    const hv = this.hopper.batch.volumeMl, frac = Math.min(1, hv / this.hopper.capacityMl);
    u.hopFill.visible = hv > 50;
    u.hopFill.position.y = 0.03 + frac * (H.h - 0.06);
    u.heavy.material.opacity = Math.min(0.78, this.riffleLoad * 0.7 + (this.riffles.volumeMl > 0 ? 0.08 : 0));
    const t = Math.cbrt(this.tailMl / 1e6);
    u.heap.visible = this.tailMl > 2000;
    if (u.heap.visible) { const r = Math.min(1.35, 0.18 + t * 0.95); u.heap.scale.set(r, Math.min(0.85, 0.08 + t * 0.55), r); u.heap.position.y = u.heap.scale.y / 2; }
    this.trayFill.visible = this.installed && (this.tray.batch.volumeMl > 0 || this.tray.batch.goldUg > 0);
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
    const run = this.installed && this.running;
    if (run) {
      this.models.flowMap.offset.x = (this.models.flowMap.offset.x - dt * 0.9) % 1;
      // clear water; brown and silty while material runs through
      const silty = this.processing ? 1 : 0;
      this._silt = (this._silt || 0) + (silty - (this._silt || 0)) * Math.min(1, dt * 2);
      u.water.material.color.setRGB(0.56 - 0.2 * this._silt, 0.64 - 0.28 * this._silt, 0.65 - 0.36 * this._silt);
      u.water.material.opacity = 0.5 + 0.25 * this._silt;
      u.out.material.color.copy(u.water.material.color);
      this._waterT = (this._waterT || 0) - dt;
      if (nearPlayer && this._waterT <= 0) { this._waterT = 1.4; if (onSound) onSound("sluice_water"); }
    }
    // gravel tumbling down the box while it processes
    const g = u.gravel, n = run && this.processing ? 12 : 0;
    if (g.count !== n || n) {
      g.count = n;
      for (let i = 0; i < n; i++) {
        const ph = (this.time * 0.35 + i / n) % 1, x = 0.15 + ph * (SLUICE.len - 0.25);
        const z = Math.sin(i * 7.3) * (SLUICE.width * 0.32), s = 0.012 + ((i * 37) % 7) * 0.003;
        this._q.setFromAxisAngle(this._v.set(0, 0, 1), -this.time * 6 - i);
        this._m.compose(this._v.set(x, 0.026 + s * 0.5, z), this._q, this._s.set(s, s * 0.8, s));
        g.setMatrixAt(i, this._m);
      }
      g.instanceMatrix.needsUpdate = true;
    }
    this._fill();
  }

  serialize() {
    return {
      state: this.build >= 0 ? "ready" : this.state, running: this.running,
      hopper: this.hopper.batch.serialize(), riffles: this.riffles.serialize(), tray: this.tray.batch.serialize(),
      loadMl: this.loadMl, tailMl: this.tailMl, stats: { processedMl: this.stats.processedMl, heavyUg: this.stats.heavyUg, cleanouts: this.stats.cleanouts },
    };
  }

  dispose(scene) {
    const i = this.world.colliders.indexOf(this.collider);
    if (i >= 0) this.world.colliders.splice(i, 1);
    scene.remove(this.root);
    scene.remove(this.trayModel);
  }
}

export { STEP_ML, CLEAN_S, BUILD_S, finite };
