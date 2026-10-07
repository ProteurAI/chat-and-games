// GoldRush - economy: cash, the gold you carry (the pouch), selling it,
// buying supplies, and the statistics. The ONE place that changes money.
//
// Money is integer cents, gold mass integer micrograms, mined mass integer
// grams - no floating-point sums anywhere (no € 1,2000000004).
// Static game gold value (no live price, no network): € 100 per gram,
// i.e. 1 cent = 0.1 mg of gold. Tool prices are balanced against it with
// the canonical benchmark (tests/e2e/goldrush_bench.py).
//
// GOLD IS NOT MONEY. A find goes through these states:
//   DISCOVERED          the dig took its slice out of the ground (mining) -
//                       the resource is used up there for good
//   PENDING             on its way to the player (flying, lying, held up):
//                       listed in `pending` with an id, saved like that
//   COLLECTED_TO_POUCH  collect(id): the gold is in the pouch (count + mass
//                       per class) - exactly once; still no cash
//   SOLD                sell(): at the assay station the whole pouch is
//                       weighed and paid out - pouch emptied and cash booked
//                       in one step
// Gold won by washing material (gold pan, goldrush-material.js) goes into
// the pouch with recover() - its fine gold as "washedGold", the pieces in
// it into their own classes - straight from the pan, exactly once.
// Leaving the game, hiding the tab or loading a save with pending finds
// moves them into the pouch (collectAll) - no find is lost, none counted
// twice: the save always holds each find in exactly one state.
//
// Buying: buy(id, cents) checks the price against the cash and books it in
// one step (never below zero); the caller grants the item in the same
// synchronous call, so a save can never see one without the other.

import { FIND } from "./goldrush-resources.js";

export const GOLD_CENTS_PER_GRAM = 10000;
const UG_PER_CENT = 1e6 / GOLD_CENTS_PER_GRAM;           // 100 µg

// value of one find (shown when it is found / picked up) - the assay pays
// exactly the sum of these for the pouch, so every "+ € 0,03" you saw counts
export const centsForMass = (ug) => Math.max(1, Math.round(ug / UG_PER_CENT));

// "€ 1.234,05" from integer cents, without going through a float
export function formatEuro(cents) {
  const c = Math.round(cents), neg = c < 0, a = Math.abs(c);
  const euros = Math.floor(a / 100), rest = a - euros * 100;
  const e = String(euros).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "−" : ""}€ ${e},${String(rest).padStart(2, "0")}`;
}

// "12,4 mg" / "1,25 g" from micrograms
export function formatMass(ug) {
  if (ug >= 1e6) return `${(ug / 1e6).toFixed(2).replace(".", ",")} g`;
  if (ug >= 1e3) return `${(ug / 1e3).toFixed(1).replace(".", ",")} mg`;
  return `${Math.round(ug)} µg`;
}

const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const bucket = (b) => ({ count: int(b && b.count), ug: int(b && b.ug), cents: int(b && b.cents) });
const MASS_KEYS = ["dirt", "compactDirt", "gravel", "stone"];
// pouch classes (the find ids of goldrush-resources.js)
export const DEV_MAX_CASH = 100000000;               // developer tools: at most € 1.000.000,00
export const POUCH_CLASSES =["traceGold", "fineGold", "goldFlake", "tinyGoldPiece", "smallNugget", "washedGold"];
const CLASS_OF = { [FIND.TRACE]: "traceGold", [FIND.FINE]: "fineGold", [FIND.FLAKE]: "goldFlake", [FIND.TINY]: "tinyGoldPiece", [FIND.NUGGET]: "smallNugget" };

export class Economy {
  constructor(saved = null) {
    const s = saved || {};
    this.cashCents = int(s.cashCents != null ? s.cashCents : s.moneyCents);
    this.earnedCents = int(s.earnedCents);          // all cash ever received (sales; v3: gold sold automatically)
    const p = s.pouch || {};
    this.pouch = {};
    for (const c of POUCH_CLASSES) this.pouch[c] = bucket(p[c]);
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
      finds: int(st.finds),                  // finds put into the pouch
      discovered: int(st.discovered),        // finds taken out of the ground
      goldFoundUg: int(st.goldFoundUg),      // all gold ever put into the pouch
      biggestNuggetCents: int(st.biggestNuggetCents),
      biggestNuggetUg: int(st.biggestNuggetUg),
      playTimeMs: int(st.playTimeMs),
      rockHits: int(st.rockHits),
      rocksBroken: int(st.rocksBroken),
      byTool: { hand: tool(tl.hand), shovel: tool(tl.shovel), pickaxe: tool(tl.pickaxe), excavator: tool(tl.excavator), sample: tool(tl.sample) },
      // phase 9: what the cuts took out of the original mountain (the contract; goldrush-contract.js)
      mountainG: int(st.mountainG),
      mountainMl: int(st.mountainMl),
      washedUg: int(st.washedUg),            // fine gold recovered by washing (all time)
      washedPieces: int(st.washedPieces),    // pieces that came out of the pan / off the screen
    };
    const so = s.sold || {};
    this.sold = {
      totalGoldUg: int(so.totalGoldUg),      // gold that went over the scale
      totalCashCents: int(so.totalCashCents),// cash it brought
      sales: int(so.sales),
      largestSaleCents: int(so.largestSaleCents),
      legacyUg: int(so.legacyUg),            // v3 saves: gold that was turned into cash automatically
    };
    const sh = s.shop || {};
    this.shop = {
      purchases: Array.isArray(sh.purchases) ? sh.purchases.filter((q) => q && typeof q.id === "string").map((q) => ({ id: q.id, cents: int(q.cents), atMs: int(q.atMs) })) : [],
      spentCents: int(sh.spentCents),
      toolPurchases: int(sh.toolPurchases),
      upgradePurchases: int(sh.upgradePurchases),
    };
    const ms = s.milestones || {};
    this.milestones = { firstSaleMs: ms.firstSaleMs != null ? int(ms.firstSaleMs) : null, shovelMs: ms.shovelMs != null ? int(ms.shovelMs) : null, pickaxeMs: ms.pickaxeMs != null ? int(ms.pickaxeMs) : null };
    const fl = s.flags || {};
    this.flags = {
      firstNuggetSeen: !!fl.firstNuggetSeen,
      firstSaleSeen: !!fl.firstSaleSeen,
      firstPurchaseSeen: !!fl.firstPurchaseSeen,
      hardSeen: !!fl.hardSeen,                // has come up against stone / a boulder
      fillSeen: !!fl.fillSeen,                // GoldRush 9.1: has dug into the camp's fill (told once)
      // phase 7A: the mineralised streaks already come across (their indices - told once each)
      streaksFound: Array.isArray(fl.streaksFound) ? fl.streaksFound.filter((i) => Number.isInteger(i) && i >= 0 && i < 64).slice(0, 64) : [],
    };
    this.nextId = int(s.nextId) || 1;
    // finds on their way (saved); restored ones go to the pouch right after loading
    this.pending = new Map();
    if (Array.isArray(s.pending)) {
      for (const q of s.pending) {
        if (!q || !Number.isInteger(q.id) || !(q.cls >= FIND.TRACE && q.cls <= FIND.NUGGET) || !(q.massUg > 0)) continue;
        this.pending.set(q.id, { id: q.id, cls: q.cls, massUg: int(q.massUg), cents: centsForMass(q.massUg), key: String(q.key || "") });
        if (q.id >= this.nextId) this.nextId = q.id + 1;
      }
    }
    this.sessionCents = 0;                    // cash received this visit (not saved)
  }

  // a mineralised streak came to light: true the first time (a moment worth telling)
  foundStreak(i) {
    if (!Number.isInteger(i) || i < 0 || this.flags.streaksFound.includes(i)) return false;
    this.flags.streaksFound.push(i);
    return true;
  }

  // ---- compatibility: "money" is cash
  get moneyCents() { return this.cashCents; }

  // an action's material side (mining result)
  recordAction(r, toolId = "hand") {
    const st = this.stats;
    if (!r.ok) return;
    const tb = st.byTool[toolId] || st.byTool.hand;
    st.totalDigs++;
    tb.actions++;
    if (r.kind === "rock") { st.rockHits++; if (r.rock && r.rock.broke) st.rocksBroken++; this.flags.hardSeen = true; return; }
    if (r.blocked) { st.blockedDigs++; tb.blocked++; this.flags.hardSeen = true; return; }
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
    if (r.mountainKg > 0) { st.mountainG += Math.round(r.mountainKg * 1000); st.mountainMl += Math.round(r.mountainVol * 1e6); }
  }

  // the finds of one action are out of the ground: they become PENDING.
  // Returns what to show (items carry their id) - nothing in the pouch yet.
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

  // a pending find reached the player -> into the POUCH (once). Returns it or null.
  collect(id) {
    const it = this.pending.get(id);
    if (!it) return null;
    this.pending.delete(id);
    const b = this.pouch[CLASS_OF[it.cls]];
    b.count++;
    b.ug += it.massUg;
    b.cents += it.cents;
    const st = this.stats;
    st.finds++;
    st.goldFoundUg += it.massUg;
    if (it.cls === FIND.NUGGET && it.cents > st.biggestNuggetCents) { st.biggestNuggetCents = it.cents; st.biggestNuggetUg = it.massUg; }
    return it;
  }

  /**
   * Gold won by processing (gold pan / classifier): fine gold -> "washedGold",
   * each piece -> its class. No pending state - it is in your hand already.
   * -> { cents, ug, pieces }
   */
  recover(fineUg, finds = []) {
    const out = { cents: 0, ug: 0, pieces: 0 };
    const st = this.stats;
    const fine = int(fineUg);
    if (fine > 0) {
      const b = this.pouch.washedGold, c = centsForMass(fine);
      b.count++; b.ug += fine; b.cents += c;
      out.cents += c; out.ug += fine;
      st.washedUg += fine;
    }
    for (const f of finds) {
      const cls = CLASS_OF[f.cls], ug = int(f.ug);
      if (!cls || !(ug > 0)) continue;
      const b = this.pouch[cls], c = centsForMass(ug);
      b.count++; b.ug += ug; b.cents += c;
      out.cents += c; out.ug += ug; out.pieces++;
      st.finds++;
      st.washedPieces++;
      if (f.cls === FIND.NUGGET && c > st.biggestNuggetCents) { st.biggestNuggetCents = c; st.biggestNuggetUg = ug; }
    }
    st.goldFoundUg += out.ug;
    return out;
  }

  // everything still pending -> pouch now; returns the items
  collectAll() {
    const out = [];
    for (const id of [...this.pending.keys()]) { const it = this.collect(id); if (it) out.push(it); }
    return out;
  }

  get pouchUg() { let u = 0; for (const c of POUCH_CLASSES) u += this.pouch[c].ug; return u; }
  get pouchCount() { let n = 0; for (const c of POUCH_CLASSES) n += this.pouch[c].count; return n; }
  // what the assay station pays for the pouch right now
  get pouchCents() { let v = 0; for (const c of POUCH_CLASSES) v += this.pouch[c].cents; return v; }
  get pendingCents() { let c = 0; for (const it of this.pending.values()) c += it.cents; return c; }

  // pouch per class (for the sell view / the HUD)
  pouchView() {
    return POUCH_CLASSES.map((c) => ({ id: c, count: this.pouch[c].count, ug: this.pouch[c].ug, cents: this.pouch[c].cents }));
  }

  /**
   * SOLD: weigh the whole pouch and pay it out - one step. Returns the sale
   * ({ ok, cents, ug, count, byClass, first }) or { ok: false } when the
   * pouch is empty. A second call right after finds an empty pouch.
   */
  sell() {
    const ug = this.pouchUg;
    if (ug <= 0) return { ok: false, reason: "empty", cents: 0, ug: 0 };
    const byClass = this.pouchView();
    const cents = this.pouchCents;
    const count = this.pouchCount;
    for (const c of POUCH_CLASSES) this.pouch[c] = { count: 0, ug: 0, cents: 0 };
    this.cashCents += cents;
    this.earnedCents += cents;
    this.sessionCents += cents;
    const so = this.sold;
    so.totalGoldUg += ug;
    so.totalCashCents += cents;
    so.sales++;
    if (cents > so.largestSaleCents) so.largestSaleCents = cents;
    const first = !this.flags.firstSaleSeen;
    this.flags.firstSaleSeen = true;
    if (this.milestones.firstSaleMs == null) this.milestones.firstSaleMs = this.stats.playTimeMs;
    return { ok: true, cents, ug, count, byClass, first };
  }

  /**
   * Pay for an item: checks the cash, books it - one step, never below zero.
   * The caller grants the item in the same synchronous call.
   */
  buy(id, cents, kind = "tool") {
    const price = int(cents);
    if (!(price > 0)) return { ok: false, reason: "price" };
    if (this.cashCents < price) return { ok: false, reason: "cash", missing: price - this.cashCents };
    this.cashCents -= price;
    this.shop.spentCents += price;
    this.shop.purchases.push({ id, cents: price, atMs: this.stats.playTimeMs });
    if (kind === "tool") this.shop.toolPurchases++; else this.shop.upgradePurchases++;
    if (id === "shovel" && this.milestones.shovelMs == null) this.milestones.shovelMs = this.stats.playTimeMs;
    if (id === "pickaxe" && this.milestones.pickaxeMs == null) this.milestones.pickaxeMs = this.stats.playTimeMs;
    const first = !this.flags.firstPurchaseSeen;
    this.flags.firstPurchaseSeen = true;
    return { ok: true, cents: price, first };
  }

  addPlayTime(ms) { this.stats.playTimeMs += Math.round(ms); }

  // ---- developer tools only (goldrush-devactions.js): never called by the game.
  // Cash is set directly (not earned: no sale, no statistics); gold goes into
  // the pouch as a real entry of its class, worth what its mass is worth.
  devSetCash(cents) {
    if (!Number.isInteger(cents) || cents < 0 || cents > DEV_MAX_CASH) return false;
    this.cashCents = cents;
    return true;
  }

  devAddPouch(cls, ug) {
    const key = CLASS_OF[cls] || (cls === "washedGold" ? "washedGold" : null);
    if (!key || !Number.isInteger(ug) || ug <= 0 || ug > 1e9) return null;
    const b = this.pouch[key], cents = centsForMass(ug);
    b.count++; b.ug += ug; b.cents += cents;
    return { cls: key, ug, cents };
  }

  devEmptyPouch() {
    for (const c of POUCH_CLASSES) this.pouch[c] = { count: 0, ug: 0, cents: 0 };
  }

  serialize() {
    const st = this.stats;
    const pouch = {};
    for (const c of POUCH_CLASSES) pouch[c] = { ...this.pouch[c] };
    return {
      cashCents: this.cashCents,
      moneyCents: this.cashCents,                       // same value, for older readers
      earnedCents: this.earnedCents,
      pouch,
      pouchSummary: { totalGoldUg: this.pouchUg, estimatedSaleCents: this.pouchCents, count: this.pouchCount },
      sold: { ...this.sold },
      shop: { purchases: this.shop.purchases.map((q) => ({ ...q })), spentCents: this.shop.spentCents, toolPurchases: this.shop.toolPurchases, upgradePurchases: this.shop.upgradePurchases },
      milestones: { ...this.milestones },
      stats: { ...st, massG: { ...st.massG }, byTool: { hand: { ...st.byTool.hand }, shovel: { ...st.byTool.shovel }, pickaxe: { ...st.byTool.pickaxe }, excavator: { ...st.byTool.excavator }, sample: { ...st.byTool.sample } } },
      flags: { ...this.flags, streaksFound: [...this.flags.streaksFound] },
      nextId: this.nextId,
      pending: [...this.pending.values()].map((q) => ({ id: q.id, cls: q.cls, massUg: q.massUg, key: q.key })),
    };
  }
}
