// GoldRush - material on its way from the mountain to the gold pouch.
//
// One generic flow, whatever moves or treats the material:
//
//   SOURCE      hand · shovel · pickaxe  (later: excavator, loader)
//   TRANSPORT   bucket · wheelbarrow     (later: loader, conveyor)
//   PROCESS     classifier · gold pan · sluice   (later: hopper, trommel, wash plant)
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

export const STAGE = { RAW: "raw", CONCENTRATE: "concentrate", HEAVY: "heavy", TAILINGS: "tailings" };
export const MAT_KEYS = ["dirt", "compactDirt", "gravel", "stone"];

// ---- tuning (canonical benchmark: tests/e2e/goldrush_bench.js, processing strategies)
// share of each material that stays on the classifier's screen (coarse:
// pebbles, clods, broken stone) - the rest falls through as concentrate
export const COARSE = [0.16, 0.26, 0.62, 1.0];
// fine gold the gold pan recovers from what it washes; the pan always keeps
// the visible pieces (heavy, they sink to the bottom) - only the finest
// gold washes over the rim with the mud. A classified concentrate (no pebbles,
// no clods) keeps a little more and pans a little faster per litre - the
// classifier's real gain is the volume it takes off before the pan: a sixth
// of plain dirt, almost two thirds of gravel (COARSE).
// Phase 7A, per active minute with all walking, carrying and swirling and the
// shovel + blade as baseline (goldrush_bench.py --kit, 12 seeds x 40 min at the
// starter faces): digging to spoil 1.00x, bucket + bowl ~1.2x, bucket + pan
// ~1.4x, classifier + pan ~1.5x on plain dirt (more in gravel).
export const PAN_RECOVERY = { raw: 0.58, concentrate: 0.63, heavy: 0.94 };
// seconds of steady panning per litre (raw ground is full of pebbles and
// clods; a classified concentrate pans faster), clamped per load
export const PAN_SECONDS = { raw: 3.7, concentrate: 3.3, heavy: 2.2, min: 6, max: 12 };
export const PAN_CAPACITY_ML = 2500;
// WASH BOWL (phase 7A): the free wooden bowl at the trough - the primitive way to
// wash a bucket before you own a gold pan. Same physics, worse at it: small, quick
// loads (1,4 l in ~4,5 s - a 10 l bucket is seven of them, the pan's four take
// about as long in all) and much more of the fine gold goes over its blunt rim
// (0,48 vs 0,58): per load the pan brings about twice the gold, per bucket ~20 %
// more. With slower loads (4,4 s/l) the bucket + bowl loop earned LESS per
// minute than digging to spoil with the same shovel (a trap - phase-7A benchmark).
export const BOWL_RECOVERY = { raw: 0.48, concentrate: 0.54, heavy: 0.9 };
export const BOWL_SECONDS = { raw: 3.2, concentrate: 2.8, heavy: 2.4, min: 3, max: 6 };
export const BOWL_CAPACITY_ML = 1400;
// a rest smaller than this goes along with the last load (no 0,2 l mini load)
export const BOWL_REST_ML = 300;
export const SIEVE_SECONDS = { perL: 0.42, min: 3, max: 6 };
// SLUICE (phase 6): water carries the material down the box, the riffles hold
// the heavy fraction - every gold piece, `capture` of the fine gold and a
// little black sand (heavyShare of the mass) - everything else leaves at the
// outlet as tailings. Riffles take `riffleL` litres before they need a clean
// out; past that they hold less and less (down to `overload` of capture at
// twice the load). The heavy concentrate then pans with little loss (0.94):
// a little more gold per litre than panning raw ground (0.65 x 0.94 = 0.61
// vs 0.58), less than classifier + riffled pan (0.71) - its point is the
// litres per minute, while you do something else; no pan is skipped.
export const SLUICE_TUNING = { capture: 0.65, heavyShare: 0.012, riffleL: 240, overload: 0.5 };

const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const validFind = (f) => f && f.cls >= FIND.TRACE && f.cls <= FIND.NUGGET && f.ug > 0;

export class MaterialBatch {
  constructor(o = {}) {
    this.id = Number.isInteger(o.id) ? o.id : 0;
    this.stage = o.stage === STAGE.CONCENTRATE || o.stage === STAGE.HEAVY || o.stage === STAGE.TAILINGS ? o.stage : STAGE.RAW;
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
// (a heavy sluice concentrate is mostly gold and black sand: hardly anything
// to lose, the riffled pan helps only a little there)
export function panRecovery(stage, recoveryMul = 1) {
  if (stage === STAGE.HEAVY) return Math.min(0.96, PAN_RECOVERY.heavy * (1 + (recoveryMul - 1) * 0.15));
  return Math.min(0.92, (stage === STAGE.CONCENTRATE ? PAN_RECOVERY.concentrate : PAN_RECOVERY.raw) * recoveryMul);
}

// how long a load takes to pan (s of steady swirling)
export function panSeconds(batch, tool = "pan") {
  const T = tool === "bowl" ? BOWL_SECONDS : PAN_SECONDS;
  const perL = batch.stage === STAGE.HEAVY ? T.heavy : batch.stage === STAGE.CONCENTRATE ? T.concentrate : T.raw;
  return Math.max(T.min, Math.min(T.max, (batch.volumeMl / 1000) * perL));
}

// the fine-gold recovery of a washing tool ("pan" with its upgrades | "bowl": no upgrades)
export function washRecovery(tool, stage, recoveryMul = 1) {
  if (tool !== "bowl") return panRecovery(stage, recoveryMul);
  return stage === STAGE.HEAVY ? BOWL_RECOVERY.heavy : stage === STAGE.CONCENTRATE ? BOWL_RECOVERY.concentrate : BOWL_RECOVERY.raw;
}

export function sieveSeconds(batch) {
  return Math.max(SIEVE_SECONDS.min, Math.min(SIEVE_SECONDS.max, (batch.volumeMl / 1000) * SIEVE_SECONDS.perL));
}

/**
 * Move material from one container to another - the ONE transfer every
 * container, vehicle and machine uses (bucket, wheelbarrow, sluice hopper,
 * classifier, pan; later loader, hopper, conveyor). A holder is
 * { batch, capacityMl } (capacity: the most it takes; none = unlimited).
 * Exact: what leaves `from` arrives in `to` (volume, mass, gold, pieces).
 * A small rounding rest (< 60 ml) goes along instead of staying behind.
 * -> ml moved
 */
export function pour(from, to, maxMl = Infinity, id = 0) {
  if (!from || !to || !from.batch || !to.batch || from === to || from.batch === to.batch) return 0;
  const cap = Number.isFinite(to.capacityMl) ? to.capacityMl : Infinity;
  const room = Math.max(0, cap - to.batch.volumeMl);
  const want = Math.min(from.batch.volumeMl, room, Math.max(0, maxMl));
  if (want <= 0) return 0;
  const part = from.batch.take(want, id);
  if (from.batch.volumeMl > 0 && from.batch.volumeMl < 60 && to.batch.volumeMl + part.volumeMl + from.batch.volumeMl <= cap) part.absorb(from.batch);
  const moved = part.volumeMl;
  to.batch.absorb(part);
  return moved;
}

/**
 * SLUICE: a portion of the feed runs down the box (see SLUICE_TUNING).
 *   heavy   what the riffles hold: every piece, floor(fine x capture), heavyShare of each material
 *   tails   the rest, out at the bottom
 * Exact: heavy + tails == input (volume, every material, fine gold, pieces).
 */
export function sluiceSplit(batch, capture, heavyShare, ids = [0, 0]) {
  const heavy = new MaterialBatch({ id: ids[0], stage: STAGE.HEAVY, source: batch.source });
  const tails = new MaterialBatch({ id: ids[1], stage: STAGE.TAILINGS, source: batch.source });
  const c = Math.max(0, Math.min(1, capture)), h = Math.max(0, Math.min(1, heavyShare));
  heavy.volumeMl = Math.floor(batch.volumeMl * h);
  tails.volumeMl = batch.volumeMl - heavy.volumeMl;
  for (let m = 0; m < 4; m++) { heavy.comp[m] = Math.floor(batch.comp[m] * h); tails.comp[m] = batch.comp[m] - heavy.comp[m]; }
  heavy.fineUg = Math.floor(batch.fineUg * c);
  tails.fineUg = batch.fineUg - heavy.fineUg;
  heavy.finds = batch.finds.slice();
  batch.volumeMl = 0; batch.comp = [0, 0, 0, 0]; batch.fineUg = 0; batch.finds = [];
  return { heavy, tails };
}

/**
 * TROMMEL (phase 9): the rotating screen washes the feed under its spray bars.
 * What is too coarse for its 12 mm holes leaves at the low end (OVERSIZE:
 * pebbles, stone, clay balls); the rest falls through (UNDERSIZE) with almost
 * all of the gold - every piece this ground holds is far below 12 mm (the
 * nuggets are 10-30 mg), and the fine gold is free; only a little rides out
 * stuck in clay balls: TROMMEL_TUNING.clay x the share of the feed's mass that
 * goes over as compact dirt (clods).
 * Exact: under + over == input (volume, every material, fine gold, pieces).
 */
export const TROMMEL_TUNING = { over: [0.05, 0.14, 0.42, 0.92], clay: 0.6, loose: 1.1 };

export function trommelSplit(batch, ids = [0, 0]) {
  const T = TROMMEL_TUNING;
  const under = new MaterialBatch({ id: ids[0], stage: STAGE.RAW, source: batch.source });
  const over = new MaterialBatch({ id: ids[1], stage: STAGE.RAW, source: "oversize" });
  const total = batch.massG;
  let overG = 0;
  for (let m = 0; m < 4; m++) {
    const g = Math.floor(batch.comp[m] * T.over[m]);
    over.comp[m] = g;
    under.comp[m] = batch.comp[m] - g;
    overG += g;
  }
  // volume follows the mass split (the coarse part packs a little looser)
  const ov = total > 0 ? Math.min(batch.volumeMl, Math.round(batch.volumeMl * (overG / total) * T.loose)) : 0;
  over.volumeMl = ov;
  under.volumeMl = batch.volumeMl - ov;
  const clay = total > 0 ? over.comp[1] / total : 0;
  over.fineUg = Math.floor(batch.fineUg * Math.min(0.2, T.clay * clay));
  under.fineUg = batch.fineUg - over.fineUg;
  under.finds = batch.finds.slice();
  under.history = [...batch.history, { op: "trommel", inG: total, overG }].slice(-6);
  batch.volumeMl = 0; batch.comp = [0, 0, 0, 0]; batch.fineUg = 0; batch.finds = [];
  return { under, over };
}
