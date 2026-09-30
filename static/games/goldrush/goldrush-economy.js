// GoldRush - economy (provisional, no shop yet): money, the gold that was
// found (kept as structured finds, so selling / weighing / washing can come
// later) and the statistics. The ONE place that changes money.
//
// Money is integer cents, gold mass integer micrograms, mined mass integer
// grams - no floating-point sums anywhere (no € 1,2000000004).
// Provisional gold price: € 100 per gram, i.e. 1 cent = 0.1 mg of gold.

import { FIND } from "./goldrush-resources.js";

export const GOLD_CENTS_PER_GRAM = 10000;
const UG_PER_CENT = 1e6 / GOLD_CENTS_PER_GRAM;           // 100 µg

export const centsForMass = (ug) => Math.max(1, Math.round(ug / UG_PER_CENT));

// "€ 1.234,05" from integer cents, without going through a float
export function formatEuro(cents) {
  const c = Math.round(cents), neg = c < 0, a = Math.abs(c);
  const euros = Math.floor(a / 100), rest = a - euros * 100;
  const e = String(euros).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "−" : ""}€ ${e},${String(rest).padStart(2, "0")}`;
}

const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const bucket = (b) => ({ count: int(b && b.count), ug: int(b && b.ug) });

export class Economy {
  constructor(saved = null) {
    const s = saved || {};
    this.moneyCents = int(s.moneyCents);
    this.earnedCents = int(s.earnedCents);
    const inv = s.inventory || {};
    this.inventory = {
      dust: bucket(inv.dust),               // trace + fine gold dust
      flakes: bucket(inv.flakes),
      tinyPieces: bucket(inv.tinyPieces),
      nuggets: bucket(inv.nuggets),
    };
    const st = s.stats || {};
    const g = st.massG || {};
    this.stats = {
      totalDigs: int(st.totalDigs),          // strokes that reached the ground
      successfulDigs: int(st.successfulDigs),// ... and moved material
      blockedDigs: int(st.blockedDigs),      // ... on stone / too hard
      findDigs: int(st.findDigs),            // ... with at least one find
      volumeMl: int(st.volumeMl),
      massG: { dirt: int(g.dirt), compactDirt: int(g.compactDirt), gravel: int(g.gravel), stone: int(g.stone) },
      freshMassG: int(st.freshMassG),
      slices: int(st.slices),                // resource slices worked through
      finds: int(st.finds),
      dustValueCents: int(st.dustValueCents),
      flakeValueCents: int(st.flakeValueCents),
      tinyValueCents: int(st.tinyValueCents),
      nuggetValueCents: int(st.nuggetValueCents),
      biggestNuggetCents: int(st.biggestNuggetCents),
      biggestNuggetUg: int(st.biggestNuggetUg),
      playTimeMs: int(st.playTimeMs),
    };
    this.flags = { firstNuggetSeen: !!(s.flags && s.flags.firstNuggetSeen) };
    this.sessionCents = 0;                    // this visit only (not saved)
  }

  // a stroke's material side (mining result)
  recordStroke(r) {
    const st = this.stats;
    if (!r.ok) return;
    st.totalDigs++;
    if (r.blocked) { st.blockedDigs++; return; }
    if (r.massKg > 0) st.successfulDigs++;
    st.volumeMl += Math.round(r.volumeL * 1000);
    const keys = ["dirt", "compactDirt", "gravel", "stone"];
    for (let m = 0; m < 4; m++) st.massG[keys[m]] += Math.round(r.massByMat[m] * 1000);
    st.freshMassG += Math.round(r.freshKg * 1000);
    st.slices += r.slices;
  }

  // credit the finds of one stroke; returns what happened for the feedback
  credit(finds, count) {
    const out = { cents: 0, best: FIND.NONE, nuggetCents: 0, firstNugget: false, items: [] };
    if (!count) return out;
    const st = this.stats, inv = this.inventory;
    st.findDigs++;
    for (let n = 0; n < count; n++) {
      const f = finds[n], cents = centsForMass(f.massUg);
      out.cents += cents;
      out.items.push({ cls: f.cls, cents, massUg: f.massUg, x: f.x, y: f.y, z: f.z, key: f.key });
      if (f.cls > out.best) out.best = f.cls;
      st.finds++;
      if (f.cls === FIND.TRACE || f.cls === FIND.FINE) { inv.dust.count++; inv.dust.ug += f.massUg; st.dustValueCents += cents; }
      else if (f.cls === FIND.FLAKE) { inv.flakes.count++; inv.flakes.ug += f.massUg; st.flakeValueCents += cents; }
      else if (f.cls === FIND.TINY) { inv.tinyPieces.count++; inv.tinyPieces.ug += f.massUg; st.tinyValueCents += cents; }
      else if (f.cls === FIND.NUGGET) {
        inv.nuggets.count++; inv.nuggets.ug += f.massUg; st.nuggetValueCents += cents;
        if (cents > st.biggestNuggetCents) { st.biggestNuggetCents = cents; st.biggestNuggetUg = f.massUg; }
        out.nuggetCents = Math.max(out.nuggetCents, cents);
        if (!this.flags.firstNuggetSeen) { this.flags.firstNuggetSeen = true; out.firstNugget = true; }
      }
    }
    this.moneyCents += out.cents;
    this.earnedCents += out.cents;
    this.sessionCents += out.cents;
    return out;
  }

  get totalGoldUg() {
    const i = this.inventory;
    return i.dust.ug + i.flakes.ug + i.tinyPieces.ug + i.nuggets.ug;
  }

  addPlayTime(ms) { this.stats.playTimeMs += Math.round(ms); }

  serialize() {
    const i = this.inventory;
    return {
      moneyCents: this.moneyCents,
      earnedCents: this.earnedCents,
      inventory: {
        dust: { ...i.dust }, flakes: { ...i.flakes }, tinyPieces: { ...i.tinyPieces }, nuggets: { ...i.nuggets },
        totalGoldUg: this.totalGoldUg, totalValueCents: this.earnedCents,
      },
      stats: { ...this.stats, massG: { ...this.stats.massG } },
      flags: { ...this.flags },
    };
  }
}
