// GoldRush - material transfer between machines (phase 7): the small,
// generic layer every machine plugs into - today wheelbarrow -> bulk hopper
// -> feeder -> sluice, later loader -> hopper -> conveyor -> trommel.
//
//   HOLDER       anything that holds material. Two kinds, one interface
//                (volumeOf / roomOf / takeFrom / putInto):
//                  batch holder   { batch: MaterialBatch, capacityMl } - a bucket,
//                                 a barrow, the sluice hopper: one mixed batch
//                  MaterialBuffer layers in arrival order (FIFO) - the bulk hopper,
//                                 the feeder's tray (later: material on a belt).
//                                 Every input stays its own layer (origin,
//                                 composition and gold kept apart); it leaves
//                                 from the bottom, the oldest layer first.
//   transfer()   one move from a holder to another: exact (ml, g, ug, pieces),
//                partial when the target is full - the rest stays where it was.
//   TransferLink a motor / gate between an OUTPUT holder and an INPUT holder,
//                with a rate (l/min). It moves material in whole steps; when the
//                target has no room it waits (BACKPRESSURE: "blocked"), when the
//                source is empty it waits ("starved"), switched off it does
//                nothing ("off"). Nothing is lost or duplicated; its only state
//                is the step accumulator (saved with it).
//   stepChain()  advances a chain of links downstream first, so room made at the
//                end is used by the whole chain in the same tick; long times
//                (simulation) are cut into short steps - frame rate independent.
//
// Gold and mass are never created here; the processing ledger
// (goldrush-processing.js) counts every holder (goldUg / massG).

import { MaterialBatch, STAGE } from "./goldrush-material.js";

const MAX_LAYERS = 24;                 // inputs kept apart in a buffer (older ones merge beyond that)
const CRUMB_ML = 60;                   // a leftover this small goes along (when it fits), as pour() does

export class MaterialBuffer {
  /** @param o { capacityMl, stage, layers: [serialized batches] } */
  constructor(o = {}) {
    this.capacityMl = Number.isFinite(o.capacityMl) ? o.capacityMl : 0;
    this.stage = o.stage || STAGE.RAW;
    this.layers = (Array.isArray(o.layers) ? o.layers : []).map((l) => MaterialBatch.from(l)).filter((b) => b && !b.empty);
  }

  get volumeMl() { let v = 0; for (const l of this.layers) v += l.volumeMl; return v; }
  get massG() { let g = 0; for (const l of this.layers) g += l.massG; return g; }
  get goldUg() { let u = 0; for (const l of this.layers) u += l.goldUg; return u; }
  get fineUg() { let u = 0; for (const l of this.layers) u += l.fineUg; return u; }
  get pieces() { let n = 0; for (const l of this.layers) n += l.finds.length; return n; }
  get room() { return Math.max(0, this.capacityMl - this.volumeMl); }
  get empty() { return this.layers.length === 0; }

  /** grams per material over all layers */
  comp(out = [0, 0, 0, 0]) {
    out[0] = out[1] = out[2] = out[3] = 0;
    for (const l of this.layers) for (let m = 0; m < 4; m++) out[m] += l.comp[m];
    return out;
  }

  /** the top layers (what you see from above), newest first */
  top(n = 3) { return this.layers.slice(-n).reverse(); }

  /** a batch comes in (it is emptied): a layer of its own on top */
  put(batch) {
    if (!batch || batch.empty) return 0;
    const v = batch.volumeMl, top = this.layers[this.layers.length - 1];
    // the same source poured on in small portions (a trickle): the same layer
    if (top && top.source === batch.source && v < CRUMB_ML * 5) top.absorb(batch);
    else {
      const layer = new MaterialBatch({ id: batch.id, stage: this.stage, source: batch.source });
      layer.history = batch.history.slice(-6);
      layer.absorb(batch);
      this.layers.push(layer);
    }
    // too many: keep the bottom one (what leaves next) apart, merge the next two
    while (this.layers.length > MAX_LAYERS) { this.layers[1].absorb(this.layers[2]); this.layers.splice(2, 1); }
    return v;
  }

  /** `ml` out of the bottom (oldest first) as one batch; a crumb left in a layer goes along if the total stays <= maxMl */
  take(ml, id = 0, maxMl = ml) {
    const out = new MaterialBatch({ id, stage: this.stage });
    let want = Math.max(0, Math.round(ml));
    while (want > 0 && this.layers.length) {
      const l = this.layers[0];
      const part = l.take(Math.min(want, l.volumeMl), id);
      if (!out.source) out.source = part.source;
      want -= part.volumeMl;
      out.absorb(part);
      if (l.volumeMl > 0 && l.volumeMl < CRUMB_ML && out.volumeMl + l.volumeMl <= maxMl) { want = Math.max(0, want - l.volumeMl); out.absorb(l); }
      if (l.volumeMl <= 0) {
        if (!l.empty && out.volumeMl > 0) out.absorb(l);                 // gold / mass crumbs without volume: along
        if (l.empty) this.layers.shift(); else break;
      }
    }
    return out;
  }

  serialize() { return { capacityMl: this.capacityMl, stage: this.stage, layers: this.layers.map((l) => l.serialize()) }; }
}

// ---- the holder interface (batch holder or MaterialBuffer)

const isBuffer = (h) => h instanceof MaterialBuffer;
export function volumeOf(h) { return !h ? 0 : isBuffer(h) ? h.volumeMl : h.batch ? h.batch.volumeMl : 0; }
export function goldOf(h) { return !h ? 0 : isBuffer(h) ? h.goldUg : h.batch ? h.batch.goldUg : 0; }
export function massOf(h) { return !h ? 0 : isBuffer(h) ? h.massG : h.batch ? h.batch.massG : 0; }
export function roomOf(h) {
  if (!h) return 0;
  if (isBuffer(h)) return h.room;
  const cap = Number.isFinite(h.capacityMl) ? h.capacityMl : Infinity;
  return Math.max(0, cap - (h.batch ? h.batch.volumeMl : 0));
}
export function takeFrom(h, ml, id = 0, maxMl = ml) {
  if (isBuffer(h)) return h.take(ml, id, maxMl);
  const b = h.batch, part = b.take(ml, id);
  if (b.volumeMl > 0 && b.volumeMl < CRUMB_ML && part.volumeMl + b.volumeMl <= maxMl) part.absorb(b);      // no crumbs left behind
  return part;
}
export function putInto(h, batch) {
  if (isBuffer(h)) return h.put(batch);
  const v = batch.volumeMl;
  h.batch.absorb(batch);
  return v;
}

/**
 * One move: up to maxMl from `from` to `to`, as much as fits. -> ml moved.
 * Exact - what was taken is what arrives (volume, every material, the fine
 * gold, the pieces); the rest stays in `from`.
 */
export function transfer(from, to, maxMl = Infinity, id = 0) {
  if (!from || !to || from === to) return 0;
  const room = roomOf(to), want = Math.min(volumeOf(from), room, Math.max(0, maxMl));
  if (want <= 0) return 0;
  const part = takeFrom(from, want, id, room);
  const moved = part.volumeMl;
  putInto(to, part);
  return moved;
}

/**
 * A motor or gate moving material from an output holder to an input holder at
 * a rate. step(dt) -> ml moved this time; .state "off" | "moving" | "blocked" |
 * "starved". from / to are holders or functions returning one (resolved every
 * step - a machine built, upgraded or rebuilt is simply the new end).
 */
export class TransferLink {
  constructor({ from, to, rateLpm, stepMl = 250, acc = 0, on = false, moved = 0 }) {
    this.from = from;
    this.to = to;
    this.rateLpm = rateLpm;
    this.stepMl = stepMl;
    this.acc = Number.isFinite(acc) ? Math.max(0, Math.min(stepMl, acc)) : 0;
    this.on = !!on;
    this.moved = Number.isFinite(moved) ? Math.max(0, Math.round(moved)) : 0;
    this.state = this.on ? "moving" : "off";
    this.rateNow = 0;                  // l/min actually moved over the last seconds (gauge / status)
    this._win = 0; this._winMl = 0;
  }

  _h(x) { return typeof x === "function" ? x() : x; }

  step(dt, nextId = () => 0) {
    const from = this._h(this.from), to = this._h(this.to);
    let moved = 0;
    if (!this.on || !from || !to || !(this.rateLpm > 0)) { this.state = "off"; this.acc = 0; }
    else {
      this.acc += (this.rateLpm * 1000 / 60) * dt;
      let why = null;
      while (this.acc >= this.stepMl) {
        if (volumeOf(from) <= 0) { why = "starved"; break; }
        if (roomOf(to) <= 0) { why = "blocked"; break; }
        const m = transfer(from, to, this.stepMl, nextId());
        if (m <= 0) { why = "blocked"; break; }
        moved += m;
        this.acc = m >= this.stepMl ? this.acc - this.stepMl : 0;       // a part step (source end / last room) ends the step
      }
      if (this.acc > this.stepMl) this.acc = this.stepMl;               // waiting builds no backlog to burst out later
      this.state = why || (volumeOf(from) <= 0 ? "starved" : roomOf(to) <= 0 ? "blocked" : "moving");
    }
    this.moved += moved;
    this._win += dt; this._winMl += moved;
    if (this._win >= 3 || !this.on) { this.rateNow = this._win > 0 ? (this._winMl / 1000) / (this._win / 60) : 0; this._win = 0; this._winMl = 0; }
    return moved;
  }

  serialize() { return { acc: Math.round(this.acc), on: this.on, moved: this.moved }; }
}

/**
 * Advance a chain of links (ordered upstream -> downstream) by dt: downstream
 * first, in steps of at most maxStep seconds. -> ml moved in total.
 */
export function stepChain(links, dt, nextId, maxStep = 0.5) {
  let moved = 0;
  if (!(dt > 0)) return 0;
  for (let t = 0; t < dt - 1e-9; t += maxStep) {
    const h = Math.min(maxStep, dt - t);
    for (let i = links.length - 1; i >= 0; i--) moved += links[i].step(h, nextId);
  }
  return moved;
}
