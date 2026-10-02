// GoldRush - material on its way from the mountain to the gold pouch.
//
// One generic flow, whatever moves or treats the material:
//
//   SOURCE      hand · shovel · pickaxe  (later: excavator, loader)
//   TRANSPORT   bucket                   (later: wheelbarrow, conveyor)
//   PROCESS     classifier · gold pan    (later: sluice, trommel, wash plant)
//   OUTPUT      concentrate · tailings · recovered gold
//
// A MaterialBatch is a quantity of ground with everything it holds - all
// integers, so nothing drifts: volume (ml), mass per material (g: loose
// dirt, compact dirt, gravel, stone), the fine gold spread through it (µg)
// and the discrete pieces in it (dust, flakes, tiny pieces, nuggets - each
// with the key of the resource slice it came from). The gold in a batch is
// exactly what the resource grid put into the slices that went into it
// (goldrush-resources.js / goldrush-mining.js): processing never rolls
// dice, it only decides how much of that gold comes back out (RECOVERY).
//
// Every split and every process conserves mass and gold to the gram /
// microgram: what is taken out plus what stays is what was there. The
// gold that a process does not recover ends up in the tailings - booked,
// not vanished.

import { FIND } from "./goldrush-resources.js";

export const STAGE = { RAW: "raw", CONCENTRATE: "concentrate", TAILINGS: "tailings" };
export const MAT_KEYS = ["dirt", "compactDirt", "gravel", "stone"];

// ---- tuning (canonical benchmark: tests/e2e/goldrush_bench.js, processing strategies)
// share of each material that stays on the classifier's screen (coarse:
// pebbles, clods, broken stone) - the rest falls through as concentrate
export const COARSE = [0.16, 0.26, 0.62, 1.0];
// fine gold the gold pan recovers from what it washes; the pan always keeps
// the visible pieces (heavy, they sink to the bottom) - only the finest
// gold washes over the rim with the mud
export const PAN_RECOVERY = { raw: 0.58, concentrate: 0.68 };
// seconds of steady panning per litre (raw ground is full of pebbles and
// clods; a classified concentrate pans faster), clamped per load
export const PAN_SECONDS = { raw: 3.7, concentrate: 2.7, min: 6, max: 12 };
export const PAN_CAPACITY_ML = 2500;
export const SIEVE_SECONDS = { perL: 0.42, min: 3, max: 6 };

const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const validFind = (f) => f && f.cls >= FIND.TRACE && f.cls <= FIND.NUGGET && f.ug > 0;

export class MaterialBatch {
  constructor(o = {}) {
    this.id = Number.isInteger(o.id) ? o.id : 0;
    this.stage = o.stage === STAGE.CONCENTRATE || o.stage === STAGE.TAILINGS ? o.stage : STAGE.RAW;
    this.volumeMl = int(o.volumeMl);
    const c = Array.isArray(o.comp) ? o.comp : [];
    this.comp = [int(c[0]), int(c[1]), int(c[2]), int(c[3])];       // grams per material
    this.fineUg = int(o.fineUg);
    this.finds = Array.isArray(o.finds) ? o.finds.filter(validFind).map((f) => ({ cls: f.cls, ug: int(f.ug), key: String(f.key || "") })) : [];
    this.source = typeof o.source === "string" ? o.source : "";
    this.history = Array.isArray(o.history) ? o.history.slice(-6) : [];
  }

  get massG() { return this.comp[0] + this.comp[1] + this.comp[2] + this.comp[3]; }
  get findsUg() { let u = 0; for (const f of this.finds) u += f.ug; return u; }
  get goldUg() { return this.fineUg + this.findsUg; }
  get empty() { return this.volumeMl <= 0 && this.massG <= 0 && this.goldUg <= 0; }

  // pour another batch into this one (it is emptied)
  absorb(other) {
    if (!other || other === this) return this;
    this.volumeMl += other.volumeMl;
    for (let m = 0; m < 4; m++) this.comp[m] += other.comp[m];
    this.fineUg += other.fineUg;
    for (const f of other.finds) this.finds.push(f);
    if (!this.source) this.source = other.source;
    other.volumeMl = 0; other.comp = [0, 0, 0, 0]; other.fineUg = 0; other.finds = [];
    return this;
  }

  /**
   * Take `ml` (or all) out of this batch: volume, every material and the
   * fine gold in proportion (floored - the remainder stays), the discrete
   * pieces in the order they came in. Exact: taken + left == before.
   */
  take(ml, id = 0) {
    const out = new MaterialBatch({ id, stage: this.stage, source: this.source });
    const v = Math.max(0, Math.min(this.volumeMl, Math.round(ml)));
    if (v <= 0 || this.volumeMl <= 0) {
      // only gold without volume left (rounding leftovers): it goes with a full take
      if (ml >= this.volumeMl && this.volumeMl === 0) out.absorb(this);
      return out;
    }
    if (v >= this.volumeMl) { out.absorb(this); return out; }
    const f = v / this.volumeMl;
    out.volumeMl = v;
    this.volumeMl -= v;
    for (let m = 0; m < 4; m++) { const g = Math.floor(this.comp[m] * f); out.comp[m] = g; this.comp[m] -= g; }
    const fine = Math.floor(this.fineUg * f);
    out.fineUg = fine;
    this.fineUg -= fine;
    const n = Math.floor(this.finds.length * f + 1e-9);
    if (n > 0) out.finds = this.finds.splice(0, n);
    return out;
  }

  serialize() {
    return { id: this.id, stage: this.stage, volumeMl: this.volumeMl, comp: [...this.comp], fineUg: this.fineUg,
      finds: this.finds.map((f) => ({ cls: f.cls, ug: f.ug, key: f.key })), source: this.source, history: this.history.slice(-6) };
  }

  static from(o) { return o && typeof o === "object" ? new MaterialBatch(o) : null; }
}

// what one dig took out of the mountain, as a batch (goldrush-mining.js result)
export function batchFromDig(r, source, id = 0) {
  const b = new MaterialBatch({ id, stage: STAGE.RAW, source });
  b.volumeMl = int(r.removedVolume * 1e6);
  for (let m = 0; m < 4; m++) b.comp[m] = int(r.massByMat[m] * 1000);
  b.fineUg = int(r.fineUg);
  for (let i = 0; i < r.findCount; i++) {
    const f = r.finds[i];
    if (f.cls !== FIND.NONE && f.massUg > 0) b.finds.push({ cls: f.cls, ug: int(f.massUg), key: f.key });
  }
  return b;
}

/**
 * CLASSIFIER: the batch goes over the screen.
 *   under    falls through - the concentrate (finer, and all the fine gold)
 *   over     stays on the screen - pebbles, clods, broken stone (tailings)
 *   retained nuggets too big for the mesh: you see them and pick them out
 * Exact: under + over == input (volume, every material), all gold accounted.
 */
export function classify(batch, ids = [0, 0]) {
  const over = new MaterialBatch({ id: ids[1], stage: STAGE.TAILINGS, source: batch.source });
  const under = new MaterialBatch({ id: ids[0], stage: STAGE.CONCENTRATE, source: batch.source });
  const total = batch.massG;
  let overG = 0;
  for (let m = 0; m < 4; m++) {
    const g = Math.floor(batch.comp[m] * COARSE[m]);
    over.comp[m] = g;
    under.comp[m] = batch.comp[m] - g;
    overG += g;
  }
  // volume follows the mass split (the coarse part packs a little looser)
  const ov = total > 0 ? Math.min(batch.volumeMl, Math.round(batch.volumeMl * (overG / total) * 1.08)) : 0;
  over.volumeMl = ov;
  under.volumeMl = batch.volumeMl - ov;
  under.fineUg = batch.fineUg;                       // fine gold is fine: it goes through the mesh
  const retained = [];
  for (const f of batch.finds) (f.cls === FIND.NUGGET ? retained : under.finds).push(f);
  under.history = [...batch.history, { op: "classify", inG: total, overG, retained: retained.length }].slice(-6);
  batch.volumeMl = 0; batch.comp = [0, 0, 0, 0]; batch.fineUg = 0; batch.finds = [];
  return { under, over, retained };
}

/**
 * GOLD PAN: the load is washed. The light material leaves over the rim
 * (tailings), the heavy pieces stay, of the fine gold `recovery` stays
 * (floored to the microgram; the rest is in the tailings).
 * -> { fineUg, finds, tails }   Exact: fineUg + tails.fineUg == input fine.
 */
export function panLoad(batch, recovery, tailsId = 0) {
  const r = Math.max(0, Math.min(1, recovery));
  const fineUg = Math.floor(batch.fineUg * r);
  const tails = new MaterialBatch({ id: tailsId, stage: STAGE.TAILINGS, source: batch.source });
  tails.volumeMl = batch.volumeMl;
  tails.comp = [...batch.comp];
  tails.fineUg = batch.fineUg - fineUg;
  const finds = batch.finds.slice();
  batch.volumeMl = 0; batch.comp = [0, 0, 0, 0]; batch.fineUg = 0; batch.finds = [];
  return { fineUg, finds, tails };
}

// the pan's fine-gold recovery for a load of this stage, with its upgrades
export function panRecovery(stage, recoveryMul = 1) {
  return Math.min(0.92, (stage === STAGE.CONCENTRATE ? PAN_RECOVERY.concentrate : PAN_RECOVERY.raw) * recoveryMul);
}

// how long a load takes to pan (s of steady swirling)
export function panSeconds(batch) {
  const perL = batch.stage === STAGE.CONCENTRATE ? PAN_SECONDS.concentrate : PAN_SECONDS.raw;
  return Math.max(PAN_SECONDS.min, Math.min(PAN_SECONDS.max, (batch.volumeMl / 1000) * perL));
}

export function sieveSeconds(batch) {
  return Math.max(SIEVE_SECONDS.min, Math.min(SIEVE_SECONDS.max, (batch.volumeMl / 1000) * SIEVE_SECONDS.perL));
}
