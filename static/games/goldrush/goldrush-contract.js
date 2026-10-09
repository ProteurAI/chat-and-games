// GoldRush - the mountain contract (phase 9): "BERGAUFTRAG - der Berg muss weg."
//
// The claim comes with an order: the whole mountain has to go. Gold pays for
// the tools and machines; the contract is what they are for. It is measured,
// not counted:
//
//   ORIGINAL MOUNTAIN  everything the seed piled up above the claim's own flat
//                      ground: the original surface (terrain.base) above
//                      MOUNTAIN_FLOOR (0.06 m - the flat claim's own relief
//                      stays below it, so digging the flat claim, the camp's
//                      fill or a channel under the flat ground never counts)
//   REMOVED (m3)       original volume minus what stands above the floor now
//                      (terrain.height) - exact for that definition, after any
//                      save / reload, whoever dug (hand, shovel, excavator).
//                      Material that only slid inside the mountain is still
//                      mountain; a slide off it below the floor has left it.
//   REMOVED (t)        the mass of every cut above the floor, per material
//                      (goldrush-mining.js result.mountainKg -> economy
//                      stats.mountainG) - what actually went out of the body
//   PERCENT            removed m3 / original m3
//
// Machines are unlocked by money AND by contract progress (goldrush-shop.js
// requires.mountainPct): the claim grows with the hole in the mountain. The
// numbers are shown on the contract board in the camp (a painted board, its
// panel) and in the pause card. Nothing here gives money.
//
// Future: below the floor the mine goes on (open pit, prompt 10+) - the floor
// is only where the CONTRACT's mountain ends, not where digging ends.

import { MATERIALS } from "./goldrush-materials.js";

export const MOUNTAIN_FLOOR = 0.06;                // m above the old ground (y = 0)
// what each next machine needs from the contract (shop items' requires.mountainPct use these)
export const CONTRACT_STEPS = [
  { pct: 0.9, item: "conveyor", label: "Förderband" },
  { pct: 1.1, item: "trommel", label: "Trommelsieb" },
  { pct: 1.45, item: "excavator", label: "Kompaktbagger" },
  { pct: 2.0, item: "excavator.breaker", label: "Hydraulikhammer" },
  { pct: 2.3, item: "loader", label: "Radlader" },                         // Prompt 10: the working mine
  { pct: 3.0, item: "autominer", label: "Abbaugerät" },
  { pct: 8.0, item: "washplant.recovery", label: "Recovery-Ausbau" },
];

const pctText = (v) => `${v.toFixed(v < 10 ? 2 : 1).replace(".", ",")} %`;
const m3Text = (v) => `${v < 100 ? v.toFixed(1).replace(".", ",") : Math.round(v).toLocaleString("de-DE")} m³`;
const tText = (kg) => (kg < 1000 ? `${Math.round(kg)} kg` : kg < 100000 ? `${(kg / 1000).toFixed(1).replace(".", ",")} t` : `${Math.round(kg / 1000).toLocaleString("de-DE")} t`);
export { pctText, m3Text, tText };

export class MountainContract {
  /** @param terrain  the claim's terrain (base = the original surface), economy  stats.mountainG */
  constructor(terrain, economy) {
    this.terrain = terrain;
    this.economy = economy;
    const B = terrain.base, c2 = terrain.cell * terrain.cell, F = MOUNTAIN_FLOOR;
    let s = 0, n = 0;
    for (let k = 0; k < B.length; k++) if (B[k] > F) { s += B[k] - F; n++; }
    this.v0 = s * c2;                              // m3 - the original mountain
    this.footprint = n * c2;                       // m2 it covers
    this.rev = -1;
    this.remainingM3 = this.v0;
    this.removedM3 = 0;
    this._t0 = null;
    this.refresh(true);
  }

  // re-measure when the ground changed (cheap: one pass over the columns)
  refresh(force = false) {
    const t = this.terrain;
    if (!force && t.revision === this.rev) return false;
    this.rev = t.revision;
    const H = t.height, F = MOUNTAIN_FLOOR;
    let s = 0;
    for (let k = 0; k < H.length; k++) if (H[k] > F) s += H[k] - F;
    this.remainingM3 = s * t.cell * t.cell;
    this.removedM3 = Math.max(0, this.v0 - this.remainingM3);
    return true;
  }

  get pct() { return this.v0 > 0 ? (100 * this.removedM3) / this.v0 : 0; }
  get removedKg() { return (this.economy.stats.mountainG || 0) / 1000; }

  // the original mountain's mass (t): sampled once, coarsely, from the ground's materials (display only)
  get massKg0() {
    if (this._t0 != null) return this._t0;
    const t = this.terrain, f = t.field, B = t.base, F = MOUNTAIN_FLOOR, step = 6, dy = 0.25;
    let kg = 0;
    for (let j = 0; j < t.vps; j += step) for (let i = 0; i < t.vps; i += step) {
      const k = j * t.vps + i, top = B[k];
      if (top <= F) continue;
      const x = t.x0 + i * t.cell, z = t.z0 + j * t.cell;
      for (let y = F + dy / 2; y < top; y += dy) {
        const h = Math.min(dy, top - (y - dy / 2));
        kg += MATERIALS[f.materialAt(x, y, z, k)].density * h;
      }
    }
    this._t0 = kg * t.cell * t.cell * step * step;
    return this._t0;
  }

  // the next steps of the contract (what each unlocks) and where you stand
  steps() {
    const p = this.pct;
    return CONTRACT_STEPS.map((s) => ({ ...s, met: p >= s.pct, pctText: pctText(s.pct) }));
  }

  /** everything the board / the pause card show */
  view() {
    this.refresh();
    const steps = this.steps(), next = steps.find((s) => !s.met) || null;
    return {
      v0: this.v0, removedM3: this.removedM3, remainingM3: this.remainingM3, pct: this.pct, removedKg: this.removedKg, massKg0: this.massKg0,
      text: { v0: m3Text(this.v0), removed: m3Text(this.removedM3), remaining: m3Text(this.remainingM3), pct: pctText(this.pct), t: tText(this.removedKg), t0: tText(this.massKg0) },
      steps, next,
    };
  }

  // one line for the pause card / the HUD
  line() {
    this.refresh();
    return `Bergauftrag: ${pctText(this.pct)} abgetragen · ${m3Text(this.removedM3)} · ${tText(this.removedKg)}`;
  }
}
