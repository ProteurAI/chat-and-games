// GoldRush - Material in Motion 1A: loose material that MOVES (derived, never simulated).
//
// The simulation moves material in exact steps (MaterialBatch / pour() / transfer()): a bucket tipped into a
// hopper is empty and the hopper full in the same instant. This module only SHOWS such a step. It owns no
// material - it is handed an amount that the simulation has already moved and draws it leaving the source
// and arriving at the destination:
//
//   MaterialFlow   a pool of instanced clumps (one draw call, fixed buffers, no allocation per frame) on
//                  ballistic arcs from the source's lip to the destination, a small dust puff and a few
//                  crumbs where it lands. A "pour" is a slot with the real amount (ml), the colour of the
//                  material, wetness and a rate; clumps are emitted exactly as that amount is consumed and
//                  each carries its share, so  emitted == landed == moved  (audit()).
//   DisplayHold    what a container's drawing still owes the viewer while a pour runs: `keep` (material that
//                  already left the simulation container but is still drawn in it, falling off the lip) and
//                  `owe` (material the simulation already counts in the destination that has not yet arrived
//                  in the drawing). The drawn level is  truth + keep - owe  and equals the truth again as soon
//                  as the stream ends. A hold never outlives a few seconds (tick()) and is cleared with the
//                  stream (cancel / flush) - the picture can never keep material the simulation does not have.
//
// Nothing here is saved or fed back into the simulation. A stream never starts for a transfer that moved
// nothing (a full destination = backpressure): the caller starts one only with the ml the transfer returned.

import { LOOSE_MAT } from "./goldrush-heap.js";

const G = 9.81;
const POOL = { low: 30, medium: 60, high: 90 };           // clumps in flight (a pour is thinner on LOW)
const SLOTS = 4;                                          // pours at once (the oldest is finished when a fifth starts)
const ML_MIN = 22;                                        // a clump carries at least this much (ml)
const HOLD_MAX_S = 2.5;                                   // an unconsumed hold is dropped after this (never owed forever)

const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
const smooth = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

export class DisplayHold {
  constructor() { this.ml = 0; this.pending = 0; this.age = 0; this.g = [0, 0, 0, 0]; }

  /** an amount (ml, masses per material in g) the drawing owes / keeps; pending: not yet in a stream */
  add(ml, comp) {
    if (!(ml > 0)) return;
    this.ml += ml; this.pending += ml; this.age = 0;
    for (let k = 0; k < 4; k++) this.g[k] += (comp && comp[k]) || 0;
  }

  /** `ml` of the pending hold goes into a stream (it then falls with the stream) -> ml taken */
  start(ml) { const m = Math.min(ml, this.pending); this.pending -= m; return m; }

  consume(ml) {
    if (!(ml > 0) || this.ml <= 0) return;
    const rest = Math.max(0, this.ml - ml), f = rest / this.ml;
    for (let k = 0; k < 4; k++) this.g[k] *= f;
    this.ml = rest;
    if (this.pending > this.ml) this.pending = this.ml;
    if (this.ml < 1) this.clear();
  }

  tick(dt) { if (this.pending > 0 && (this.age += dt) > HOLD_MAX_S) { const p = this.pending; this.pending = 0; this.consume(p); } }

  clear() { this.ml = 0; this.pending = 0; this.age = 0; this.g.fill(0); }
}

/**
 * The shown amount of a container: truth +- holds. comp is written to out (masses per material, g).
 * keep / owe: DisplayHold or null.
 */
export function shownLoad(truthMl, truthComp, keep, owe, out) {
  let ml = truthMl + (keep ? keep.ml : 0) - (owe ? owe.ml : 0);
  for (let k = 0; k < 4; k++) out[k] = Math.max(0, (truthComp ? truthComp[k] : 0) + (keep ? keep.g[k] : 0) - (owe ? owe.g[k] : 0));
  return Math.max(0, ml);
}

export class MaterialFlow {
  constructor(THREE, scene, { effects = null, quality = null } = {}) {
    this.THREE = THREE; this.effects = effects; this.quality = quality;
    this.max = POOL.high;
    this.limit = POOL.medium;
    const geo = (this.geo = new THREE.IcosahedronGeometry(1, 0));
    this.mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.94, metalness: 0, flatShading: true });
    const mesh = (this.mesh = new THREE.InstancedMesh(geo, this.mat, this.max));
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 3), 3);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.visible = false;
    mesh.userData.noMerge = true;
    mesh.name = "material-flow";
    scene.add(mesh);
    const n = this.max;
    this.p = {
      on: new Uint8Array(n), kind: new Uint8Array(n), slot: new Int8Array(n),
      x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n),
      vx: new Float32Array(n), vy: new Float32Array(n), vz: new Float32Array(n),
      sx: new Float32Array(n), sy: new Float32Array(n), sz: new Float32Array(n),
      ax: new Float32Array(n), ay: new Float32Array(n), az: new Float32Array(n),
      spin: new Float32Array(n), ml: new Float32Array(n), dy: new Float32Array(n), life: new Float32Array(n),
      r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n),
    };
    this.slots = [];
    for (let i = 0; i < SLOTS; i++) this.slots.push(this._newSlot());
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._v = new THREE.Vector3(); this._s = new THREE.Vector3();
    this._src = new THREE.Vector3();
    this.time = 0; this.seed = 1;
    this.stats = { pours: 0, spawned: 0, skipped: 0, landed: 0, puffs: 0, peak: 0, startedMl: 0, emittedMl: 0, landedMl: 0, canceledMl: 0, active: 0, flying: 0 };
    this.setQuality(quality ? quality() : "medium");
  }

  _newSlot() {
    return { on: false, t: 0, delay: 0, total: 0, remaining: 0, rate: 0, debt: 0, perClump: ML_MIN, sx: 0, src: null, srcPos: new this.THREE.Vector3(),
      dst: new this.THREE.Vector3(), spread: 0.05, comp: [0, 0, 0, 0], rgb: [0.5, 0.36, 0.24], wet: 0, dust: 1, onConsume: null, onLand: null, onEnd: null,
      lastPuff: -9, kind: "", id: 0, first: true, emitted: 0, landedMl: 0, windup: 0 };
  }

  setQuality(level) {
    this.level = level;
    this.limit = Math.min(this.max, POOL[level] || POOL.medium);
  }

  get busy() { for (const s of this.slots) if (s.on) return true; return false; }

  /**
   * Show `ml` that the simulation has ALREADY moved. o: { ml, rate (ml/s), delay (s, the lead-in: tipping),
   * from (fn(out) -> out, the source point each frame) or fromPos, to {x, y, z}, spread (m at the destination),
   * comp (masses per material, g), rgb (the material's colour), wet 0..1, dust 0..1 (scale of the puff), kind,
   * onConsume(ml) (left the source), onLand(ml) (arrived at the destination), onEnd() }
   * -> the slot (cancel it with cancel()) or null when there is nothing to show
   */
  start(o) {
    const ml = Math.round(o.ml || 0);
    if (!(ml > 0)) return null;
    let s = this.slots.find((x) => !x.on);
    if (!s) { s = this.slots.reduce((a, b) => (a.t > b.t ? a : b)); this.cancel(s); }     // (a fifth pour: the longest-running ends at once)
    s.on = true; s.t = 0; s.delay = o.delay || 0; s.total = ml; s.remaining = ml; s.debt = 0; s.first = true; s.emitted = 0; s.landedMl = 0; s.lastPuff = -9;
    s.rate = Math.max(300, o.rate || ml / 0.9);
    const T = 0.25, cap = Math.max(10, (this.limit * 0.9) / T / Math.max(1, this._active()));
    s.perClump = Math.max(ML_MIN, s.rate / cap);
    s.src = o.from || null;
    if (o.fromPos) s.srcPos.set(o.fromPos.x, o.fromPos.y, o.fromPos.z);
    s.dst.set(o.to.x, o.to.y, o.to.z);
    s.spread = o.spread != null ? o.spread : 0.05;
    for (let k = 0; k < 4; k++) s.comp[k] = (o.comp && o.comp[k]) || 0;
    if (!(s.comp[0] + s.comp[1] + s.comp[2] + s.comp[3])) s.comp[0] = 1;
    const c = o.rgb || LOOSE_MAT[0].rgb;
    s.rgb[0] = c[0]; s.rgb[1] = c[1]; s.rgb[2] = c[2];
    s.wet = o.wet || 0; s.dust = o.dust != null ? o.dust : 1;
    s.onConsume = o.onConsume || null; s.onLand = o.onLand || null; s.onEnd = o.onEnd || null;
    s.kind = o.kind || ""; s.id = ++this.seed;
    this.stats.pours++; this.stats.startedMl += ml;
    this.mesh.visible = true;
    return s;
  }

  _active() { let n = 0; for (const s of this.slots) if (s.on) n++; return n; }

  /** end a pour NOW: what was not shown yet counts as arrived (the picture catches up to the truth at once) */
  cancel(s) {
    if (!s || !s.on) return;
    const rest = s.remaining + s.debt, si = this.slots.indexOf(s);
    s.on = false;
    this.stats.canceledMl += rest;
    this.stats.emittedMl += s.remaining;
    // clumps of this pour still in flight: they arrive at once
    const P = this.p;
    let inflight = 0;
    for (let i = 0; i < this.max; i++) if (P.on[i] && P.slot[i] === si && P.kind[i] === 0) { inflight += P.ml[i]; P.on[i] = 0; }
    if (s.onConsume && s.remaining > 0) s.onConsume(s.remaining);          // (what sat in the debt left the source already)
    if (s.onLand && rest + inflight > 0) s.onLand(rest + inflight);
    this.stats.landedMl += rest + inflight;
    if (s.onEnd) s.onEnd(true);
    s.remaining = 0; s.debt = 0;
  }

  /** cancel every pour of a kind ("" = all) */
  flush(kind = "") { for (const s of this.slots) if (s.on && (!kind || s.kind === kind)) this.cancel(s); }

  /** the slots' conservation: what was started == emitted + (still to emit); what was emitted == landed + in flight */
  audit() {
    let remain = 0, flying = 0;
    for (const s of this.slots) if (s.on) remain += s.remaining + s.debt;
    const P = this.p;
    for (let i = 0; i < this.max; i++) if (P.on[i] && P.kind[i] === 0) flying += P.ml[i];
    const st = this.stats;
    return { startedMl: st.startedMl, emittedMl: st.emittedMl, landedMl: st.landedMl, canceledMl: st.canceledMl, remainMl: remain, flyingMl: flying,
      balance: Math.round(st.startedMl - (st.landedMl + flying + remain)) };
  }

  update(dt) {
    dt = Math.min(dt, 0.05);
    this.time += dt;
    let any = false;
    for (let si = 0; si < SLOTS; si++) {
      const s = this.slots[si];
      if (!s.on) continue;
      any = true;
      s.t += dt;
      if (s.t < s.delay) continue;
      const age = s.t - s.delay;
      // the stream builds up over a moment and thins to a dribble at the end (never an instant on / off)
      const ramp = 0.35 + 0.65 * smooth(age / 0.18), tail = Math.max(0.35, Math.min(1, s.remaining / Math.max(1, s.total * 0.16)));
      const take = Math.min(s.remaining, s.rate * ramp * tail * dt);
      if (take > 0) {
        s.remaining -= take; s.debt += take; this.stats.emittedMl += take; s.emitted += take;
        if (s.onConsume) s.onConsume(take);
        while (s.debt >= s.perClump || (s.remaining <= 0 && s.debt > 0.5)) {
          const ml = s.remaining <= 0 ? s.debt : s.perClump;
          s.debt -= ml;
          this._spawn(si, s, ml);
        }
      }
      if (s.remaining <= 0.0001 && s.debt <= 0.5) {
        s.on = false; s.remaining = 0; s.debt = 0;
        if (s.onEnd) s.onEnd(false);
      }
    }
    this._integrate(dt);
    this.stats.active = this._active();
    if (!any && this.mesh.count === 0) this.mesh.visible = false;
  }

  _spawn(si, s, ml) {
    const P = this.p;
    let i = -1;
    for (let k = 0; k < this.limit; k++) if (!P.on[k]) { i = k; break; }
    if (i < 0) {                                         // the pool is full: the picture is thinner, the amount still arrives
      this.stats.skipped++;
      this.stats.landedMl += ml; s.landedMl += ml;
      if (s.onLand) s.onLand(ml);
      return;
    }
    const src = s.src ? s.src(this._src) : this._src.copy(s.srcPos);
    const n = (s.id * 131 + (this.stats.spawned++)) * 1.37;
    const h1 = hash(n), h2 = hash(n + 7.1), h3 = hash(n + 13.7), h4 = hash(n + 21.3), h5 = hash(n + 5.3);
    const a = h1 * 6.2832, rr = Math.sqrt(h2) * s.spread;
    const dx = s.dst.x + Math.cos(a) * rr, dz = s.dst.z + Math.sin(a) * rr, dy = s.dst.y;
    const x = src.x + (h3 - 0.5) * 0.045, y = src.y + (h4 - 0.5) * 0.01, z = src.z + (h5 - 0.5) * 0.045;
    const drop = y - dy;
    const T = drop > 0.06 ? Math.max(0.16, Math.min(0.55, Math.sqrt((2 * drop) / G))) : 0.3;
    P.on[i] = 1; P.kind[i] = 0; P.slot[i] = si;
    P.x[i] = x; P.y[i] = y; P.z[i] = z;
    const j = 0.94 + 0.12 * hash(n + 31.7);
    P.vx[i] = ((dx - x) / T) * j; P.vz[i] = ((dz - z) / T) * j; P.vy[i] = (dy - y) / T + 0.5 * G * T;
    P.dy[i] = dy; P.ml[i] = ml; P.life[i] = 0;
    // which kind of piece: the composition (gravel and stone show their pieces readily)
    let wt = 0; const w0 = s.comp[0] * LOOSE_MAT[0].weight, w1 = s.comp[1] * LOOSE_MAT[1].weight, w2 = s.comp[2] * LOOSE_MAT[2].weight, w3 = s.comp[3] * LOOSE_MAT[3].weight;
    wt = w0 + w1 + w2 + w3;
    let pick = hash(n + 41.9) * wt, k = 0;
    const ws = [w0, w1, w2, w3];
    while (k < 3 && pick > ws[k]) { pick -= ws[k]; k++; }
    const M = LOOSE_MAT[k], base = M.size[0] + (M.size[1] - M.size[0]) * hash(n + 47.3) ** 1.5;
    const sk = Math.max(1, Math.min(2.4, Math.cbrt(ml / ML_MIN))) * 1.2;
    P.sx[i] = base * sk * M.lump[0]; P.sy[i] = base * sk * M.lump[1]; P.sz[i] = base * sk * M.lump[2];
    P.ax[i] = hash(n + 2.1) * 6.28; P.ay[i] = hash(n + 3.7) * 6.28; P.az[i] = hash(n + 5.9) * 6.28; P.spin[i] = (hash(n + 8.3) - 0.5) * 9;
    const mix = k >= 2 ? 0.3 : 0.6, vary = (0.78 + 0.34 * hash(n + 11.3)) * M.dark * 0.58 * (1 - 0.34 * s.wet);
    P.r[i] = (M.rgb[0] * (1 - mix) + s.rgb[0] * mix) * vary; P.g[i] = (M.rgb[1] * (1 - mix) + s.rgb[1] * mix) * vary; P.b[i] = (M.rgb[2] * (1 - mix) + s.rgb[2] * mix) * vary;
  }

  _integrate(dt) {
    const P = this.p, ic = this.mesh.instanceColor.array, lim = this.limit;
    let n = 0;
    for (let i = 0; i < this.max; i++) {
      if (!P.on[i]) continue;
      if (i >= lim && P.kind[i] === 1) { P.on[i] = 0; continue; }
      P.life[i] += dt;
      P.vy[i] -= G * dt;
      P.x[i] += P.vx[i] * dt; P.y[i] += P.vy[i] * dt; P.z[i] += P.vz[i] * dt;
      const s = P.kind[i] === 0 ? this.slots[P.slot[i]] : null;
      if (P.vy[i] < 0 && P.y[i] <= P.dy[i]) {
        if (P.kind[i] === 0) { this._land(i, s); continue; }
        P.on[i] = 0; continue;
      }
      if (P.kind[i] === 1 && P.life[i] > 0.4) { P.on[i] = 0; continue; }
      this._e.set(P.ax[i] + P.spin[i] * P.life[i], P.ay[i] + P.spin[i] * 0.6 * P.life[i], P.az[i]);
      this._q.setFromEuler(this._e);
      this._m.compose(this._v.set(P.x[i], P.y[i], P.z[i]), this._q, this._s.set(P.sx[i], P.sy[i], P.sz[i]));
      this.mesh.setMatrixAt(n, this._m);
      ic[n * 3] = P.r[i]; ic[n * 3 + 1] = P.g[i]; ic[n * 3 + 2] = P.b[i];
      n++;
    }
    this.mesh.count = n;
    this.stats.flying = n;
    if (n > this.stats.peak) this.stats.peak = n;
    if (n || this._wasDrawn) { this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor.needsUpdate = true; }
    this._wasDrawn = n > 0;
  }

  // a stream clump reached the destination: its share arrives; now and then a puff and a crumb or two bounce
  _land(i, s) {
    const P = this.p, ml = P.ml[i];
    P.on[i] = 0;
    this.stats.landed++; this.stats.landedMl += ml;
    if (!s) return;
    s.landedMl += ml;
    if (s.onLand) s.onLand(ml);
    if (this.time - s.lastPuff > 0.11) {
      s.lastPuff = this.time;
      const dust = s.dust * (1 - s.wet) * Math.min(1, 0.35 + ml / 500);
      if (this.effects && this.effects.puff && dust > 0.05) { this.effects.puff(P.x[i], P.dy[i] + 0.02, P.z[i], s.rgb, dust); this.stats.puffs++; }
      // one or two crumbs hop off the heap (the same pool: no extra allocation)
      for (let c = 0; c < 2; c++) {
        let j = -1;
        for (let k = 0; k < this.limit; k++) if (!P.on[k]) { j = k; break; }
        if (j < 0) break;
        const h = hash(this.stats.landed * 3.1 + c * 7.7 + s.id);
        P.on[j] = 1; P.kind[j] = 1; P.slot[j] = P.slot[i];
        P.x[j] = P.x[i]; P.y[j] = P.dy[i] + 0.01; P.z[j] = P.z[i];
        P.vx[j] = (h - 0.5) * 0.9; P.vz[j] = (hash(h * 91.7) - 0.5) * 0.9; P.vy[j] = 0.7 + 0.8 * hash(h * 13.3);
        P.dy[j] = P.dy[i] - 0.02; P.life[j] = 0; P.ml[j] = 0;
        const sc = 0.5 + 0.6 * hash(h * 57.1);
        P.sx[j] = P.sx[i] * 0.55 * sc; P.sy[j] = P.sy[i] * 0.55 * sc; P.sz[j] = P.sz[i] * 0.55 * sc;
        P.ax[j] = h * 6; P.ay[j] = h * 9; P.az[j] = h * 3; P.spin[j] = (h - 0.5) * 14;
        P.r[j] = P.r[i]; P.g[j] = P.g[i]; P.b[j] = P.b[i];
      }
    }
  }

  // GPU warm-up: one clump drawn once (the program and buffers exist before the first pour)
  warm(on) {
    const P = this.p, m = this.mesh;
    if (on) {
      this._warm = [m.visible, m.count];
      this._m.compose(this._v.set(0, -50, 0), this._q.identity(), this._s.set(0.01, 0.01, 0.01));
      m.setMatrixAt(0, this._m); m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true;
      m.count = 1; m.visible = true;
    } else if (this._warm) { m.visible = this._warm[0]; m.count = this._warm[1]; this._warm = null; }
    void P;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
    this.mesh.dispose();
  }
}
