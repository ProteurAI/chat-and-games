// GoldRush - the wash plant (Prompt 10): the high-flow sluice grows into a small
// modular plant at the same place - the processing bottleneck of phase 9
// (32 l/min behind a 474-l/min excavator) becomes ~120 l/min.
//
//   DISTRIBUTION BOX  a steel box across the heads of three wide lanes (the
//                     high-flow box is the first of them; its small hopper goes).
//                     The feeder doses into it (it opens up to 120 l/min with the
//                     plant); a barrow or a bucket can be tipped into it too. It
//                     splits the feed evenly over the lanes that can take it.
//   LANES             three wide riffled boxes, 40 l/min each: ~77 % of the fine
//                     gold stays in the riffles (84 % with the recovery upgrade:
//                     expanded-metal riffles over moss mats), every piece; an
//                     overloaded mat holds less (clean out in time). Each lane's
//                     tailings go down its own end onto the outlet pile
//                     (goldrush-stockpile.js tailOut); once that pile stands up to
//                     a lane's end the lane waits, the others carry on - all three
//                     waiting: the box fills, the feeder stops (backpressure: the
//                     bulk hopper fills, the trommel waits, the belt stops).
//   CONCENTRATE TUB   cleaning out (water off) brushes all three mats at once: the
//                     nuggets go into the pouch (as with the sluice), the black sand
//                     with the fine gold into a galvanised tub beside the plant.
//                     You fill it into your bucket and pan it at the trough - the
//                     plant never pays out by itself.
//
// Nothing here creates gold: every microgram that enters the distribution box ends
// up in a lane's riffles, the tub, the pouch or the tailings (the processing
// ledger checks it). The lanes 2 and 3 are this module's; lane 1 is the sluice's
// own box (its riffles, its load) - goldrush-sluice.js asks this plant when it is
// installed.

import { MaterialBatch, STAGE, SLUICE_TUNING, sluiceSplit } from "./goldrush-material.js";
import { FIND } from "./goldrush-resources.js";
import { SLUICE } from "./goldrush-mechmodels.js";
import { mergeStatic } from "./goldrush-merge.js";
import { transfer } from "./goldrush-transfer.js";

export const WP = {
  laneDz: [0, 0.78, 1.56],                     // lanes north of the sluice's own box (its local z)
  laneLpm: 40,                                 // litres a minute per lane
  riffleL: 900,                                // litres per lane before its mat should be cleaned
  capture: 0.77, captureRec: 0.84,             // fine gold kept (base / recovery upgrade)
  heavyShare: 0.004,                           // the black sand pulled into the riffles (wide, deep lanes: a cleaner concentrate)
  distMl: 150000,                              // the distribution box
  concMl: 40000,                               // the tub (cleaning out stops once it is that full)
  outletH: 0.6,                                // the outlet pile up to a lane's end -> it waits
  dist: { x0: -0.66, x1: -0.02, z0: -0.4, z1: 1.96, y0: 1.0, h: 0.36 },    // local (sluice frame)
};
const STEP_ML = 500;
const BUILD_S = 3.4;
const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);

export function washplantSpots(at) {
  return {
    feed: { x: at.x - 1.2, z: at.z + 0.78, yaw: -Math.PI / 2 },            // west of the box, facing it: water, a bucket
    clean: { x: at.x + 1.35, z: at.z + 2.32, yaw: 0 },                     // north of the lanes, facing them
    dist: { x: at.x + (WP.dist.x0 + WP.dist.x1) / 2, z: at.z + (WP.dist.z0 + WP.dist.z1) / 2 },
    tub: { x: at.x + 2.15, z: at.z + 2.3 },                                 // the concentrate tub, on a pallet north of the lanes
    kit: { x: at.x - 1.85, z: at.z + 1.6 },                                 // the delivery, west of the sluice
  };
}

export class WashPlant {
  /**
   * @param saved doc.processing.washplant or null
   * @param ctx   { sluice: () => Sluice, at: SLUICE_AT, nextId, ledger, economy, upgrades: () => Set, tailOut: () => pile,
   *                warm, onReady }
   */
  constructor(THREE, scene, world, models, saved, ctx) {
    this.THREE = THREE;
    this.scene = scene;
    this.world = world;
    this.M = models;
    this.ctx = ctx;
    const s = saved || {};
    this.state = s.state === "ready" ? "ready" : "delivered";
    const L = Array.isArray(s.lanes) ? s.lanes : [];
    // lane 0 is the sluice's own box: only lanes 1 and 2 keep their riffles here
    this.lanes = WP.laneDz.map((dz, i) => ({
      dz, riffles: i === 0 ? null : (MaterialBatch.from(L[i] && L[i].riffles) || new MaterialBatch({ stage: STAGE.HEAVY })),
      loadMl: i === 0 ? 0 : int(L[i] && L[i].loadMl), processedMl: int(L[i] && L[i].processedMl), blocked: false, fed: 0,
    }));
    for (const l of this.lanes) if (l.riffles) l.riffles.stage = STAGE.HEAVY;
    this.conc = { batch: MaterialBatch.from(s.conc) || new MaterialBatch({ stage: STAGE.HEAVY }), capacityMl: Infinity };
    this.conc.batch.stage = STAGE.HEAVY;
    const st = s.stats || {};
    this.stats = { processedMl: int(st.processedMl), heavyUg: int(st.heavyUg), cleanouts: int(st.cleanouts), concOutMl: int(st.concOutMl), blockedS: int(st.blockedS), runS: int(st.runS), laneBlockedS: int(st.laneBlockedS) };
    this.acc = 0;
    this._rr = 0;
    this.build = -1;
    this.time = 0;
    this.spots = washplantSpots(ctx.at);
    this._build();
  }

  get installed() { return this.state === "ready"; }
  get sl() { return this.ctx.sluice(); }
  get capture() { const u = this.ctx.upgrades ? this.ctx.upgrades() : null; return u && u.has("washplant.recovery") ? WP.captureRec : WP.capture; }
  get rateLpm() { let n = 0; for (const l of this.lanes) if (!l.blocked) n++; return WP.laneLpm * n; }
  get maxLpm() { return WP.laneLpm * this.lanes.length; }

  // ---- the lanes' riffles / loads (lane 0: the sluice's own)
  rif(i) { return i === 0 ? this.sl.riffles : this.lanes[i].riffles; }
  load(i) { return i === 0 ? this.sl.loadMl : this.lanes[i].loadMl; }
  riffleLoad(i) { return this.load(i) / 1000 / WP.riffleL; }
  efficiency(i) {
    const L = this.load(i) / 1000, cap = WP.riffleL, over = SLUICE_TUNING.overload;
    return this.capture * (L <= cap ? 1 : Math.max(over, 1 - ((L - cap) / cap) * (1 - over)));
  }
  outlet(i) { const a = this.ctx.at; return { x: a.x + SLUICE.len + 0.2, z: a.z + this.lanes[i].dz }; }
  // (a lane's end choked stays so until ~12 cm are cleared from it)
  outletFull(i) {
    const out = this.ctx.tailOut ? this.ctx.tailOut() : null, o = this.outlet(i), l = this.lanes[i];
    if (!out) return false;
    const t = out.thickAt(o.x, o.z);
    l.choked = t >= WP.outletH || (!!l.choked && t >= WP.outletH - 0.12);
    return l.choked;
  }

  // ---- build
  startBuild() {
    if (this.state !== "delivered" || this.build >= 0) return false;
    this.build = 0;
    this._sync();
    return true;
  }

  _done() {
    this.build = -1;
    this.state = "ready";
    for (const p of this.parts) if (p.userData.s0) { p.scale.copy(p.userData.s0); p.visible = true; }
    this._sync();
    if (this.ctx.onReady) this.ctx.onReady();
  }

  // ---- running (the sluice's process() hands over while the plant stands)
  process(dt) {
    const sl = this.sl, H = sl.hopper.batch;
    for (const l of this.lanes) { l.blocked = false; l.fed = Math.max(0, l.fed - dt); }
    if (!this.installed || !sl.running || H.volumeMl <= 0) { this.acc = 0; this.blocked = false; return 0; }
    this.stats.runS += dt;
    let free = 0;
    for (let i = 0; i < this.lanes.length; i++) { this.lanes[i].blocked = this.outletFull(i); if (!this.lanes[i].blocked) free++; else this.stats.laneBlockedS += dt / this.lanes.length; }
    this.blocked = free === 0;
    if (this.blocked) { this.acc = Math.min(this.acc, STEP_ML); this.stats.blockedS += dt; return 0; }
    this.acc += (free * WP.laneLpm * 1000 / 60) * dt;
    const L = this.ctx.ledger, out = this.ctx.tailOut ? this.ctx.tailOut() : null;
    let done = 0;
    while (this.acc >= STEP_ML && H.volumeMl > 0) {
      // the next lane that takes it (round robin: the box splits the feed evenly)
      let i = -1;
      for (let k = 0; k < this.lanes.length; k++) { const j = (this._rr + k) % this.lanes.length; if (!this.lanes[j].blocked) { i = j; break; } }
      if (i < 0) break;
      this._rr = (i + 1) % this.lanes.length;
      const part = H.take(STEP_ML, this.ctx.nextId());
      if (H.volumeMl > 0 && H.volumeMl < 60) part.absorb(H);
      const vol = part.volumeMl;
      const { heavy, tails } = sluiceSplit(part, this.efficiency(i), WP.heavyShare, [this.ctx.nextId(), this.ctx.nextId()]);
      this.stats.heavyUg += heavy.goldUg;
      sl.stats.heavyUg += heavy.goldUg;
      this.rif(i).absorb(heavy);
      if (out) {
        // down this lane's end onto the outlet pile (it books them as tailings), a little apart every time
        const o = this.outlet(i), j = this._oj = ((this._oj || 0) + 1) % 997, a = j * 2.39996, rr = 0.1 + 0.25 * ((j * 0.618) % 1);
        out.dump(tails, o.x + 0.15 + Math.cos(a) * rr, o.z + Math.sin(a) * rr * 0.9, 0.3);
        this.lanes[i].blocked = this.outletFull(i);
      } else { L.tailUg += tails.goldUg; L.tailG += tails.massG; L.tailMl += tails.volumeMl; }
      if (i === 0) sl.loadMl += vol; else this.lanes[i].loadMl += vol;
      this.lanes[i].processedMl += vol;
      this.lanes[i].fed = 0.8;
      sl.tailMl += vol;
      sl.stats.processedMl += vol;
      this.stats.processedMl += vol;
      this.acc -= STEP_ML;
      done += vol;
      if (this.lanes.every((l) => l.blocked)) { this.blocked = true; break; }
    }
    if (H.volumeMl <= 0) this.acc = 0;
    return done;
  }

  // ---- cleaning out: all three mats at once (water off)
  riffleUg() { let u = 0; for (let i = 0; i < this.lanes.length; i++) u += this.rif(i).goldUg; return u; }
  riffleMl() { let v = 0; for (let i = 0; i < this.lanes.length; i++) v += this.rif(i).volumeMl; return v; }
  maxRiffleLoad() { let m = 0; for (let i = 0; i < this.lanes.length; i++) m = Math.max(m, this.riffleLoad(i)); return m; }
  get tubFull() { return this.conc.batch.volumeMl >= WP.concMl; }
  canClean() {
    const sl = this.sl;
    if (!this.installed || sl.running || this.tubFull) return false;
    for (let i = 0; i < this.lanes.length; i++) { const r = this.rif(i); if (r.volumeMl > 0 || r.goldUg > 0) return true; }
    return false;
  }

  finishClean() {
    const sl = this.sl, nug = [];
    let heavyMl = 0, heavyUg = 0;
    for (let i = 0; i < this.lanes.length; i++) {
      const r = this.rif(i);
      for (const f of r.finds) if (f.cls === FIND.NUGGET) nug.push(f);
      r.finds = r.finds.filter((f) => f.cls !== FIND.NUGGET);
      heavyMl += r.volumeMl; heavyUg += r.goldUg;
      this.conc.batch.absorb(r);
      const fresh = new MaterialBatch({ id: this.ctx.nextId(), stage: STAGE.HEAVY });
      if (i === 0) { sl.riffles = fresh; sl.loadMl = 0; } else { this.lanes[i].riffles = fresh; this.lanes[i].loadMl = 0; }
    }
    const got = nug.length ? this.ctx.economy.recover(0, nug) : { cents: 0, ug: 0, pieces: 0 };
    this.ctx.ledger.recoveredUg += got.ug;
    this.stats.cleanouts++;
    sl.stats.cleanouts++;
    sl.clean.progress = 0;
    this._sync();
    sl._sync();
    return { ok: true, nuggets: nug.length, nuggetUg: got.ug, cents: got.cents, heavyMl, heavyUg, tub: true, tubMl: this.conc.batch.volumeMl, bestUg: got.bestUg || 0 };
  }

  // the concentrate into a bucket (an empty one, or one already holding concentrate) -> ml
  toBucket(bucket) {
    const b = bucket && bucket.batch;
    if (!b || (b.volumeMl > 0 && b.stage !== STAGE.HEAVY)) return 0;
    const was = b.volumeMl;
    const ml = transfer(this.conc, bucket, Infinity, this.ctx.nextId());
    if (ml > 0 && was <= 0) b.stage = STAGE.HEAVY;
    if (this.conc.batch.volumeMl <= 0 && this.conc.batch.goldUg > 0) { b.absorb(this.conc.batch); }   // (rounding crumbs go along)
    this.stats.concOutMl += ml;
    this._tubSig = null;
    return ml;
  }

  goldUg() { return this.lanes[1].riffles.goldUg + this.lanes[2].riffles.goldUg + this.conc.batch.goldUg; }
  massG() { return this.lanes[1].riffles.massG + this.lanes[2].riffles.massG + this.conc.batch.massG; }

  // ---- models
  _build() {
    const THREE = this.THREE, M = this.M, sl = this.sl, W = WP.dist;
    this.parts = [];
    // lanes 2 and 3: the sluice's box at its high-flow width, in the sluice's frame (no hopper, no pipe, no old heap)
    this.laneModels = [];
    for (let i = 1; i < this.lanes.length; i++) {
      const m = M.sluice(), u = m.userData;
      m.position.z = this.lanes[i].dz;
      u.box.scale.z = 1.65;
      for (const k of ["hop", "pipe", "fall", "heap"]) u[k].visible = false;
      const hop = u.hop, keep = u.parts.filter((p) => { let o = p; while (o) { if (o === hop) return false; o = o.parent; } return true; });
      u.parts = keep;
      u.mesh = this._meshOverlay(u);
      sl.root.add(m);
      this.laneModels.push(m);
      this.parts.push(...keep);
    }
    // lane 1's overlay (the recovery upgrade's expanded metal) on the sluice's own box
    this._overlay0 = this._meshOverlay(sl.model.userData);
    // the distribution box: galvanised steel across the heads, four legs, three spouts, its level inside
    const d = (this.dist = new THREE.Group());
    sl.root.add(d);
    const dp = [], cx = (W.x0 + W.x1) / 2, cz = (W.z0 + W.z1) / 2, w = W.x1 - W.x0, len = W.z1 - W.z0;
    dp.push(M._mesh(M.box, M.galv, w, 0.03, len, cx, W.y0, cz, d));
    for (const s of [-1, 1]) dp.push(M._mesh(M.box, M.galv, w, W.h, 0.03, cx, W.y0 + W.h / 2, s > 0 ? W.z1 : W.z0, d));
    dp.push(M._mesh(M.box, M.galv, 0.03, W.h, len, W.x0, W.y0 + W.h / 2, cz, d));
    dp.push(M._mesh(M.box, M.galv, 0.03, W.h * 0.62, len, W.x1, W.y0 + W.h * 0.31, cz, d));          // the lane side: lower, the spouts over it
    for (const s of [-1, 1]) dp.push(M._mesh(M.box, M.galvDark, w + 0.06, 0.035, 0.035, cx, W.y0 + W.h, s > 0 ? W.z1 + 0.015 : W.z0 - 0.015, d));
    for (const x of [W.x0 + 0.04, W.x1 - 0.04]) for (const z of [W.z0 + 0.04, W.z1 - 0.04, cz]) dp.push(M._mesh(M.box, M.galvDark, 0.06, W.y0, 0.06, x, W.y0 / 2, z, d));
    // dividers inside (the box splits evenly) and a spout per lane
    for (const z of [(this.lanes[0].dz + this.lanes[1].dz) / 2, (this.lanes[1].dz + this.lanes[2].dz) / 2]) dp.push(M._mesh(M.box, M.galvDark, w - 0.08, W.h * 0.55, 0.02, cx + 0.02, W.y0 + W.h * 0.28, z, d));
    this.spouts = [];
    for (const l of this.lanes) {
      const sp = M._mesh(M.box, M.galv, 0.24, 0.02, 0.3, W.x1 + 0.1, W.y0 + 0.02, l.dz, d);
      sp.rotation.z = -0.35;
      dp.push(sp);
      for (const s of [-1, 1]) dp.push(M._mesh(M.box, M.galvDark, 0.24, 0.07, 0.015, W.x1 + 0.1, W.y0 + 0.05, l.dz + s * 0.15, d));
      const st = M._mesh(M.box, M.stream, 0.22, 0.02, 0.24, W.x1 + 0.24, W.y0 - 0.06, l.dz, d, false);
      st.rotation.z = -1.0;
      st.visible = false;
      this.spouts.push(st);
    }
    // the water valve on the west side (the plant's tap) and a little sign
    const valve = M._mesh(M.cyl, M.galvDark, 0.03, 0.5, 0.03, W.x0 - 0.06, W.y0 + 0.1, cz, d);
    dp.push(valve);
    const wheel = M._mesh(M.cyl, this._red || (this._red = M._mat(new THREE.MeshStandardMaterial({ color: 0xa8321f, roughness: 0.55, metalness: 0.3 }))), 0.11, 0.02, 0.11, W.x0 - 0.12, W.y0 + 0.36, cz, d);
    wheel.rotation.z = Math.PI / 2;
    this.wheel = wheel;
    const grid = M._geo(new THREE.PlaneGeometry(1, 1, 6, 10));
    grid.rotateX(-Math.PI / 2);
    this.distFill = M._mesh(grid, M.load.clone(), w - 0.06, 1, len - 0.06, cx, W.y0 + 0.04, cz, d, false);
    M.mats.push(this.distFill.material);
    this.distFill.visible = false;
    this.distParts = dp;
    this.parts.push(...dp);
    // (the three streams out of the box: one mesh, on while the plant runs)
    const sm = mergeStatic(THREE, d, this.spouts, { shadow: false });
    for (const s of this.spouts) d.remove(s);
    this.spoutFx = sm[0] || null;
    if (this.spoutFx) this.spoutFx.visible = false;
    this._buildFx();
    // the concentrate tub on a pallet (world space): galvanised, two handles, the black sand in it, gold showing
    const T = (this.tub = new THREE.Group()), at = this.spots.tub;
    T.position.set(at.x, this.world.groundAt(at.x, at.z), at.z);
    this.scene.add(T);
    const tp = [];
    for (const z of [-0.2, 0, 0.2]) tp.push(M._mesh(M.box, M.darkWood, 0.9, 0.04, 0.12, 0, 0.05, z, T));
    for (const x of [-0.38, 0, 0.38]) tp.push(M._mesh(M.box, M.darkWood, 0.08, 0.06, 0.56, x, 0.02, 0, T));
    const shell = M._geo(new THREE.CylinderGeometry(1, 0.84, 1, 22, 1, true));
    tp.push(M._mesh(shell, M.galv, 0.4, 0.26, 0.29, 0, 0.21, 0, T));
    tp.push(M._mesh(M.cyl, M.galvDark, 0.34, 0.012, 0.24, 0, 0.085, 0, T));
    const ring = M._geo(new THREE.TorusGeometry(1, 0.035, 5, 22));
    ring.rotateX(Math.PI / 2);
    tp.push(M._mesh(ring, M.galvDark, 0.4, 0.4, 0.29, 0, 0.34, 0, T));
    for (const s of [-1, 1]) { const h = M._mesh(M._geo(new THREE.TorusGeometry(0.06, 0.012, 5, 10, Math.PI)), M.galvDark, 1, 1, 1, s * 0.43, 0.3, 0, T); h.rotation.y = Math.PI / 2; tp.push(h); }
    const disc = M._geo(new THREE.CircleGeometry(1, 20));
    disc.rotateX(-Math.PI / 2);
    this.tubFill = M._mesh(disc, M.heavy.clone(), 0.37, 1, 0.26, 0, 0.12, 0, T, false);
    M.mats.push(this.tubFill.material);
    Object.assign(this.tubFill.material, { opacity: 1, transparent: false, depthWrite: true });
    this.tubFill.visible = false;
    this.tubSpecks = new THREE.InstancedMesh(M.pebble, M.goldSpeck, 30);
    this.tubSpecks.count = 0;
    this.tubSpecks.frustumCulled = false;
    T.add(this.tubSpecks);
    this.tubParts = tp;
    this.parts.push(...tp);
    // the delivery: a crate, galvanised sheets, two rolled mats (west of the sluice)
    const K = (this.kit = new THREE.Group()), ka = this.spots.kit;
    K.position.set(ka.x, this.world.groundAt(ka.x, ka.z), ka.z);
    K.rotation.y = 0.25;
    this.scene.add(K);
    M._mesh(M.box, M.wood, 0.9, 0.55, 0.6, 0, 0.28, 0, K);
    M._mesh(M.box, M.galv, 1.3, 0.12, 0.75, 0.05, 0.62, 0.02, K);
    for (const z of [-0.18, 0.18]) { const r = M._mesh(M.cyl, M.mat, 0.11, 0.75, 0.11, 0.1, 0.12, z + 0.7, K); r.rotation.z = Math.PI / 2; }
    // colliders: lanes 2-3, the box, the tub, the crate
    const a = this.ctx.at;
    this.colliders = [
      { type: "box", x: a.x + 1.25, z: a.z + (this.lanes[1].dz + this.lanes[2].dz) / 2, hw: 1.62, hd: 0.78, rot: 0 },
      { type: "box", x: a.x + cx, z: a.z + cz, hw: w / 2 + 0.05, hd: len / 2 + 0.05, rot: 0 },
      { type: "circle", x: at.x, z: at.z, r: 0.45 },
    ];
    this.kitCollider = { type: "box", x: ka.x, z: ka.z + 0.3, hw: 0.7, hd: 0.7, rot: 0.25 };
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._v = new THREE.Vector3(); this._s = new THREE.Vector3();
    this._sync();
  }

  // fewer draw calls: what all three lanes show while water runs, as ONE mesh each, in the first lane's frame (the
  // box tilted, its width scaled - a lane's offset z is dz / that scale there); the sluice drives them (its update)
  _buildFx() {
    const THREE = this.THREE, sl = this.sl, u0 = sl.model.userData, box = u0.box, M = this.M, sz = 1.65;
    const copies = (src, dzs) => dzs.map((dz) => {
      const m = new THREE.Mesh(src.geometry, src.material);
      m.position.copy(src.position); m.rotation.copy(src.rotation); m.scale.copy(src.scale); m.position.z += dz;
      src.parent.add(m);
      return m;
    });
    const merged = (src, dzs) => {
      const tmp = copies(src, dzs), out = mergeStatic(THREE, src.parent, tmp, { shadow: false });
      for (const t of tmp) src.parent.remove(t);
      const m = out[0];
      m.renderOrder = src.renderOrder;
      m.visible = false;
      return m;
    };
    const inBox = this.lanes.map((l) => l.dz / sz), inModel = this.lanes.map((l) => l.dz);
    this.fx = {
      water: merged(u0.water, inBox),
      heavy: merged(u0.heavy, inBox),
      out: merged(u0.out, inModel),
      foam: new THREE.InstancedMesh(M.plane, M.foam, 33),
      gravel: new THREE.InstancedMesh(M.pebble, M.pebbleMat, 36),
      inBox,
    };
    for (const k of ["foam", "gravel"]) { const im = this.fx[k]; im.count = 0; im.frustumCulled = false; im.visible = false; box.add(im); }
    this.fx.gravel.castShadow = false;
    // the riffle bars of all three lanes: one instanced mesh (the lanes' own hidden while the plant stands)
    const isRiffles = (c) => c.isInstancedMesh && c.material === M.galvDark && c.geometry === M.box;
    this.fx.laneRiffles = [box, ...this.laneModels.map((m) => m.userData.box)].map((b) => b.children.find(isRiffles)).filter(Boolean);
    const r0 = this.fx.laneRiffles[0], rf = new THREE.InstancedMesh(M.box, M.galvDark, r0.count * 3), m4 = new THREE.Matrix4();
    for (let l = 0; l < 3; l++) for (let i = 0; i < r0.count; i++) { r0.getMatrixAt(i, m4); m4.elements[14] += inBox[l]; rf.setMatrixAt(l * r0.count + i, m4); }
    rf.castShadow = true;
    rf.visible = false;
    box.add(rf);
    this.fx.riffles = rf;
  }

  // while the plant stands: its own lanes' water / foam / gravel / dark sand are the combined ones
  fxOn(on) {
    const f = this.fx;
    if (!f) return;
    for (const m of [f.water, f.out, f.foam, f.gravel]) m.visible = on && this.sl.running;
    f.heavy.visible = on;
    f.riffles.visible = on;
    for (const r of f.laneRiffles) r.visible = !on;
  }

  // the recovery upgrade: expanded metal over the mat (a diamond lattice) - one plane over each lane's bed
  _meshOverlay(u) {
    const THREE = this.THREE, M = this.M;
    if (!this._emMat) {
      const c = document.createElement("canvas");
      c.width = 64; c.height = 32;
      const g = c.getContext("2d");
      g.clearRect(0, 0, 64, 32);
      g.strokeStyle = "#9aa3a8"; g.lineWidth = 3.2;
      for (let x = -64; x < 128; x += 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 16, 32); g.stroke(); g.beginPath(); g.moveTo(x + 16, 0); g.lineTo(x, 32); g.stroke(); }
      const t = M._tex(new THREE.CanvasTexture(c));
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(SLUICE.len * 4, 2.2);
      t.colorSpace = THREE.SRGBColorSpace;
      this._emMat = M._mat(new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.4, metalness: 0.55, roughness: 0.45, side: THREE.DoubleSide }));
    }
    const o = M._mesh(M.plane, this._emMat, SLUICE.len - 0.2, 1, SLUICE.width - 0.03, SLUICE.len / 2 + 0.05, 0.024, 0, u.box, false);
    o.visible = false;
    return o;
  }

  applyUpgrades() {
    const u = this.ctx.upgrades ? this.ctx.upgrades() : null, rec = !!(u && u.has("washplant.recovery")), on = this.installed || this.build >= 0;
    for (const m of this.laneModels) m.userData.mesh.visible = rec && on;
    this._overlay0.visible = rec && on;
  }

  _sync() {
    const on = this.installed || this.build >= 0;
    for (const m of this.laneModels) m.visible = on;
    this.dist.visible = on;
    this.tub.visible = on;
    this.kit.visible = this.state === "delivered" && this.build < 0;
    const cols = this.world.colliders;
    for (const c of this.colliders) { const i = cols.indexOf(c); if (on && i < 0) cols.push(c); if (!on && i >= 0) cols.splice(i, 1); }
    const ki = cols.indexOf(this.kitCollider);
    if (this.kit.visible && ki < 0) cols.push(this.kitCollider);
    if (!this.kit.visible && ki >= 0) cols.splice(ki, 1);
    if (this.installed && !this._merged) {
      // the two lanes' frames, legs, sides, beds baked together (per material, in lane 2's frame)
      const [m1, m2] = this.laneModels;
      this._merged = [...mergeStatic(this.THREE, m1, [...m1.userData.parts, ...m2.userData.parts]),
        ...mergeStatic(this.THREE, this.dist, this.distParts), ...mergeStatic(this.THREE, this.tub, this.tubParts)];
      if (this.ctx.warm) this.ctx.warm();
    }
    this.applyUpgrades();
    this._tubSig = null;
    this._fill();
  }

  // the lanes' loads (dark sand behind the bars, specks), the box's level, the tub
  _fill() {
    const M = this.M, sl = this.sl;
    for (let k = 0; k < this.laneModels.length; k++) {
      const i = k + 1, u = this.laneModels[k].userData, r = this.rif(i);
      u.heavy.visible = false;                                          // (the combined plane shows the dark sand)
      const nG = r.goldUg > 0 ? Math.min(40, Math.round(Math.sqrt(r.goldUg / 1500))) : 0;
      if (nG !== u.specks.count) {
        u.specks.count = nG;
        for (let j = 0; j < nG; j++) {
          const bar = j % 11, x = 0.25 + bar * ((SLUICE.len - 0.35) / 10) + 0.012 + ((j * 0.618) % 1) * 0.05;
          const z = (((j * 0.5698403 + 0.37) % 1) - 0.5) * (SLUICE.width - 0.06), sz = 0.0018 + ((j * 7919) % 5) * 0.0004;
          this._q.setFromAxisAngle(this._v.set(0, 1, 0), j * 2.3);
          this._m.compose(this._v.set(x, 0.009, z), this._q, this._s.set(sz, sz * 0.35, sz));
          u.specks.setMatrixAt(j, this._m);
        }
        u.specks.instanceMatrix.needsUpdate = true;
      }
    }
    // the box: its level
    const hv = sl.hopper.batch.volumeMl, frac = Math.min(1, hv / WP.distMl), W = WP.dist;
    this.distFill.visible = (this.installed || this.build >= 0) && hv > 200;
    this.distFill.position.y = W.y0 + 0.03 + frac * (W.h * 0.55);
    // the tub: black sand rising, gold showing in it
    const cv = this.conc.batch.volumeMl, sig = `${Math.round(cv / 400)}:${Math.round(Math.sqrt(this.conc.batch.goldUg / 2500))}`;
    if (sig !== this._tubSig) {
      this._tubSig = sig;
      const f = Math.min(1, cv / WP.concMl);
      this.tubFill.visible = this.tub.visible && (cv > 0 || this.conc.batch.goldUg > 0);
      this.tubFill.position.y = 0.1 + f * 0.17;
      const s = 0.33 + f * 0.06;
      this.tubFill.scale.set(s, 1, s * 0.72);
      const nT = this.tubFill.visible ? Math.min(30, Math.round(Math.sqrt(this.conc.batch.goldUg / 2500))) : 0;
      this.tubSpecks.count = nT;
      for (let j = 0; j < nT; j++) {
        const sz = 0.002 + ((j * 7919) % 5) * 0.0006, a = j * 2.39996, rr = Math.sqrt(((j * 0.618) % 1)) * 0.85;
        this._m.compose(this._v.set(Math.cos(a) * rr * s, this.tubFill.position.y + 0.003, Math.sin(a) * rr * s * 0.72), this._q.identity(), this._s.set(sz, sz * 0.35, sz));
        this.tubSpecks.setMatrixAt(j, this._m);
      }
      this.tubSpecks.instanceMatrix.needsUpdate = true;
    }
    void M;
  }

  // per frame: the build, the spouts (which lane gets fed), the valve, the fills
  update(dt) {
    this.time += dt;
    if (this.build >= 0) {
      this.build += dt;
      const k = Math.min(1, this.build / BUILD_S), parts = this.parts;
      for (let i = 0; i < parts.length; i++) {
        const a = Math.max(0, Math.min(1, (k * parts.length * 1.1 - i) / 3)), e = a * a * (3 - 2 * a), p = parts[i];
        p.visible = a > 0.02;
        if (!p.userData.s0) p.userData.s0 = p.scale.clone();
        p.scale.set(p.userData.s0.x, Math.max(0.001, p.userData.s0.y * e), p.userData.s0.z);
      }
      if (k >= 1) this._done();
    }
    const sl = this.sl, run = this.installed && sl.running;
    if (this.spoutFx) this.spoutFx.visible = run && this.lanes.some((l) => l.fed > 0);
    // the valve wheel turns to its stop when the water goes on / off
    const want = sl.running ? 1.6 : 0;
    this.wheel.rotation.x += (want - this.wheel.rotation.x) * Math.min(1, dt * 6);
    this._fill();
  }

  serialize() {
    const st = this.stats;
    return {
      state: this.build >= 0 ? "ready" : this.state,
      lanes: this.lanes.map((l, i) => (i === 0 ? { processedMl: l.processedMl } : { riffles: l.riffles.serialize(), loadMl: l.loadMl, processedMl: l.processedMl })),
      conc: this.conc.batch.serialize(),
      stats: { ...st, blockedS: Math.round(st.blockedS), runS: Math.round(st.runS), laneBlockedS: Math.round(st.laneBlockedS) },
    };
  }

  dispose() {
    const cols = this.world.colliders;
    for (const c of [...this.colliders, this.kitCollider]) { const i = cols.indexOf(c); if (i >= 0) cols.splice(i, 1); }
    const sl = this.sl;
    for (const m of this.laneModels) sl.root.remove(m);
    sl.root.remove(this.dist);
    if (this.fx) {
      for (const k of ["water", "heavy", "out", "foam", "gravel", "riffles"]) { const m = this.fx[k]; if (m.parent) m.parent.remove(m); if (!m.isInstancedMesh) m.geometry.dispose(); }
      for (const r of this.fx.laneRiffles) r.visible = true;
      this.fx = null;
    }
    if (this._overlay0 && this._overlay0.parent) this._overlay0.parent.remove(this._overlay0);
    this.scene.remove(this.tub);
    this.scene.remove(this.kit);
    for (const m of this._merged || []) m.geometry.dispose();
  }
}

export { STEP_ML as WP_STEP_ML, BUILD_S as WP_BUILD_S };
