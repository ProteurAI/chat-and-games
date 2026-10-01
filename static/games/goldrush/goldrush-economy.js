// GoldRush - economy (provisional, no shop yet): money, the gold that was
// found (kept as structured finds, so selling / weighing / washing can come
// later) and the statistics. The ONE place that changes money.
//
// Money is integer cents, gold mass integer micrograms, mined mass integer
// grams - no floating-point sums anywhere (no € 1,2000000004).
// Provisional gold price: € 100 per gram, i.e. 1 cent = 0.1 mg of gold.
//
// A find goes through three states:
//   DISCOVERED  the dig took its slice out of the ground (mining) - it is
//               used up there for good
//   PENDING     it is on its way to the player (flying, lying, being held
//               up): listed in `pending` with an id, saved like that
//   COLLECTED   collect(id): only now money, inventory and find statistics
//               change - exactly once (a second collect of the same id does
//               nothing)
// Leaving the game, hiding the tab or loading a save with pending finds
// collects them all at once (collectAll) - no find is lost, none is paid
// twice: the save always holds either the pending entry or the money,
// never both, never neither.

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
const MASS_KEYS = ["dirt", "compactDirt", "gravel", "stone"];

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
    const tl = st.byTool || {};
    const tool = (b) => ({ actions: int(b && b.actions), massG: int(b && b.massG), volumeMl: int(b && b.volumeMl), blocked: int(b && b.blocked) });
    this.stats = {
      totalDigs: int(st.totalDigs),          // actions that reached the ground
      successfulDigs: int(st.successfulDigs),// ... and moved material
      blockedDigs: int(st.blockedDigs),      // ... on stone / too hard
      findDigs: int(st.findDigs),            // ... with at least one find
      volumeMl: int(st.volumeMl),            // removed from the mountain
      relocatedMl: int(st.relocatedMl),      // slid inside it (not removed)
      massG: { dirt: int(g.dirt), compactDirt: int(g.compactDirt), gravel: int(g.gravel), stone: int(g.stone) },
      freshMassG: int(st.freshMassG),
      slices: int(st.slices),                // resource slices worked through
      finds: int(st.finds),                  // collected finds
      discovered: int(st.discovered),        // finds taken out of the ground
      dustValueCents: int(st.dustValueCents),
      flakeValueCents: int(st.flakeValueCents),
      tinyValueCents: int(st.tinyValueCents),
      nuggetValueCents: int(st.nuggetValueCents),
      biggestNuggetCents: int(st.biggestNuggetCents),
      biggestNuggetUg: int(st.biggestNuggetUg),
      playTimeMs: int(st.playTimeMs),
      rockHits: int(st.rockHits),
      rocksBroken: int(st.rocksBroken),
      byTool: { hand: tool(tl.hand), shovel: tool(tl.shovel), pickaxe: tool(tl.pickaxe) },
    };
    this.flags = { firstNuggetSeen: !!(s.flags && s.flags.firstNuggetSeen) };
    this.nextId = int(s.nextId) || 1;
    // finds on their way (saved); restored ones are collected by the game right after loading
    this.pending = new Map();
    if (Array.isArray(s.pending)) {
      for (const p of s.pending) {
        if (!p || !Number.isInteger(p.id) || !(p.cls >= FIND.TRACE && p.cls <= FIND.NUGGET) || !(p.massUg > 0)) continue;
        this.pending.set(p.id, { id: p.id, cls: p.cls, massUg: int(p.massUg), cents: centsForMass(p.massUg), key: String(p.key || "") });
        if (p.id >= this.nextId) this.nextId = p.id + 1;
      }
    }
    this.sessionCents = 0;                    // this visit only (not saved)
  }

  // an action's material side (mining result)
  recordAction(r, toolId = "hand") {
    const st = this.stats;
    if (!r.ok) return;
    const tb = st.byTool[toolId] || st.byTool.hand;
    st.totalDigs++;
    tb.actions++;
    if (r.kind === "rock") { st.rockHits++; if (r.rock && r.rock.broke) st.rocksBroken++; return; }
    if (r.blocked) { st.blockedDigs++; tb.blocked++; return; }
    if (r.removedMassKg > 0) st.successfulDigs++;
    const ml = Math.round(r.removedVolume * 1e6);
    st.volumeMl += ml;
    tb.volumeMl += ml;
    st.relocatedMl += Math.round(r.relocatedVolume * 1e6);
    let g = 0;
    for (let m = 0; m < 4; m++) { const v = Math.round(r.massByMat[m] * 1000); st.massG[MASS_KEYS[m]] += v; g += v; }
    tb.massG += g;
    st.freshMassG += Math.round(r.freshKg * 1000);
    st.slices += r.slices;
  }

  // the finds of one action are out of the ground: they become PENDING.
  // Returns what to show (items carry their id) - no money yet.
  discover(finds, count) {
    const out = { cents: 0, best: FIND.NONE, nuggetCents: 0, firstNugget: false, items: [] };
    if (!count) return out;
    this.stats.findDigs++;
    for (let n = 0; n < count; n++) {
      const f = finds[n], cents = centsForMass(f.massUg);
      const item = { id: this.nextId++, cls: f.cls, cents, massUg: f.massUg, key: f.key };
      this.pending.set(item.id, item);
      this.stats.discovered++;
      out.cents += cents;
      out.items.push({ ...item, x: f.x, y: f.y, z: f.z });
      if (f.cls > out.best) out.best = f.cls;
      if (f.cls === FIND.NUGGET) {
        out.nuggetCents = Math.max(out.nuggetCents, cents);
        if (!this.flags.firstNuggetSeen) { this.flags.firstNuggetSeen = true; out.firstNugget = true; }
      }
    }
    return out;
  }

  // a pending find reached the player -> COLLECTED (once). Returns it or null.
  collect(id) {
    const it = this.pending.get(id);
    if (!it) return null;
    this.pending.delete(id);
    const st = this.stats, inv = this.inventory, f = it, cents = it.cents;
    st.finds++;
    if (f.cls === FIND.TRACE || f.cls === FIND.FINE) { inv.dust.count++; inv.dust.ug += f.massUg; st.dustValueCents += cents; }
    else if (f.cls === FIND.FLAKE) { inv.flakes.count++; inv.flakes.ug += f.massUg; st.flakeValueCents += cents; }
    else if (f.cls === FIND.TINY) { inv.tinyPieces.count++; inv.tinyPieces.ug += f.massUg; st.tinyValueCents += cents; }
    else if (f.cls === FIND.NUGGET) {
      inv.nuggets.count++; inv.nuggets.ug += f.massUg; st.nuggetValueCents += cents;
      if (cents > st.biggestNuggetCents) { st.biggestNuggetCents = cents; st.biggestNuggetUg = f.massUg; }
    }
    this.moneyCents += cents;
    this.earnedCents += cents;
    this.sessionCents += cents;
    return it;
  }

  // everything still pending -> collected now; returns the items
  collectAll() {
    const out = [];
    for (const id of [...this.pending.keys()]) { const it = this.collect(id); if (it) out.push(it); }
    return out;
  }

  get pendingCents() { let c = 0; for (const it of this.pending.values()) c += it.cents; return c; }

  get totalGoldUg() {
    const i = this.inventory;
    return i.dust.ug + i.flakes.ug + i.tinyPieces.ug + i.nuggets.ug;
  }

  addPlayTime(ms) { this.stats.playTimeMs += Math.round(ms); }

  serialize() {
    const i = this.inventory, st = this.stats;
    return {
      moneyCents: this.moneyCents,
      earnedCents: this.earnedCents,
      inventory: {
        dust: { ...i.dust }, flakes: { ...i.flakes }, tinyPieces: { ...i.tinyPieces }, nuggets: { ...i.nuggets },
        totalGoldUg: this.totalGoldUg, totalValueCents: this.earnedCents,
      },
      stats: { ...st, massG: { ...st.massG }, byTool: { hand: { ...st.byTool.hand }, shovel: { ...st.byTool.shovel }, pickaxe: { ...st.byTool.pickaxe } } },
      flags: { ...this.flags },
      nextId: this.nextId,
      pending: [...this.pending.values()].map((p) => ({ id: p.id, cls: p.cls, massUg: p.massUg, key: p.key })),
    };
  }
}
