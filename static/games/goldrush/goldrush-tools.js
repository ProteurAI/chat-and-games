// GoldRush - tools. ONE definition per tool (what it does to which
// material, how fast, how big its bite is, how it moves, sounds and looks),
// and the controller that owns which tools you have, which one is in your
// hands and how an action runs through its phases.
//
// Power ladder (long-term, see the phase-3 report): every tier makes the
// mountain only a bit less impossible -
//   0 hand  ~25 kg/min loose dirt          2 shovel ~5x the hand (~120 kg/min)
//   1 simple hand tool (later)             3+ processing, mechanics, machines ...
// The pickaxe is no step on that ladder: it is the tool for what the others
// cannot do (stone, boulders) and prepares hard ground (loosening).
// Tools never carry luck stats: more gold only ever comes from moving more
// material (the finds are in the ground).

import { MAT } from "./goldrush-materials.js";

export const TOOL_ORDER = ["hand", "shovel", "pickaxe"];

// materialEfficiency / loosenedBonus are indexed by MAT (dirt, compact, gravel, stone)
export const TOOL_DEFS = {
  hand: {
    id: "hand", tier: 0, label: "Hand", key: "1", defaultOwned: true,
    reach: 2.2,
    materialEfficiency: [1.0, 0.45, 0.2, 0],
    loosenedBonus: [1, 2.0, 1.6, 1],
    hardnessLimit: 3.5,
    // a small, flat scrape: ~0.135 l = ~0.18 kg of loose dirt
    kernel: { type: "scrape", a: 0.14, b: 0.11, vol: 0.000135, tMax: 0.012, edge: 0.55, tilt: 0, settleMargin: 0.7 },
    massCapacity: 0.25,
    strike: [["windup", 0.16]],
    follow: { ok: (m) => [["recover", [0.26, 0.31, 0.34, 0.36][m]]], blocked: () => [["recover", 0.36]], air: () => [["recover", 0.18]] },
    rockDamage: 0,
    animationProfile: "hand", vfxProfile: { dust: 1, chunks: 1 }, audioProfile: "hand",
    unlockCost: null,
  },
  shovel: {
    id: "shovel", tier: 2, label: "Schaufel", key: "2", defaultOwned: false,
    reach: 2.4,
    materialEfficiency: [1.0, 0.55, 0.5, 0],
    loosenedBonus: [1, 1.7, 1.4, 1],
    hardnessLimit: 3.5,
    // a scoop: wider, deeper, deepest at the leading edge: ~1.63 l = ~2.2 kg of loose dirt
    kernel: { type: "scoop", a: 0.23, b: 0.15, vol: 0.00163, tMax: 0.06, edge: 0.45, tilt: 0.35, settleMargin: 1.0 },
    massCapacity: 2.5,
    strike: [["windup", 0.3], ["thrust", 0.12]],
    follow: {
      ok: () => [["scoop", 0.18], ["dump", 0.38], ["recover", 0.1]],      // the dump is held a little: readable
      blocked: () => [["recoil", 0.22], ["recover", 0.24]],
      air: () => [["recover", 0.25]],
    },
    rockDamage: 0,
    animationProfile: "shovel", vfxProfile: { dust: 1.6, chunks: 2.4 }, audioProfile: "shovel",
    // NOT a shop: a prepared, provisional figure for a later phase. Design
    // target: earned after ~10-25 minutes of normal first play by hand; the
    // canonical benchmark (tests/e2e/goldrush_bench.py) puts the median
    // starter at ~€ 4.40 after 10 and ~€ 9.40 after 20 minutes.
    unlockCost: { provisional: true, cents: 900 },
  },
  pickaxe: {
    id: "pickaxe", tier: 2, label: "Spitzhacke", key: "3", defaultOwned: false,
    reach: 2.3,
    // the wrong tool for dirt; it breaks up compact soil and gravel (loosening
    // them for hand / shovel) and is the only one that cuts stone
    materialEfficiency: [0.25, 0.35, 0.3, 0.12],
    loosenedBonus: [1, 1, 1, 1],
    hardnessLimit: 10,
    // a point strike: small crater (~0.4 l at full bite), loosens around it
    kernel: { type: "pick", a: 0.12, b: 0.09, vol: 0.0004, tMax: 0.05, edge: 0.3, tilt: 0, settleMargin: 0.6, cutsStone: true, loosenCm: 10, loosenR: 0.32 },
    massCapacity: 0.4,
    strike: [["raise", 0.3], ["swing", 0.12]],
    follow: {
      ok: () => [["recoil", 0.14], ["recover", 0.26]],
      blocked: () => [["recoil", 0.16], ["recover", 0.26]],
      air: () => [["recover", 0.3]],
    },
    rockDamage: 1,
    animationProfile: "pickaxe", vfxProfile: { dust: 0.8, chunks: 1.4 }, audioProfile: "pickaxe",
    unlockCost: { provisional: true, cents: 1500 },             // provisional, see the shovel
  },
};

export const toolDef = (id) => TOOL_DEFS[id] || TOOL_DEFS.hand;

// efficiency of a tool on a material at a cell (loosened ground helps)
export function toolEfficiency(def, mat, loosened) {
  const e = def.materialEfficiency[mat] || 0;
  return loosened ? e * def.loosenedBonus[mat] : e;
}

// one stroke's average cycle time on a material (for reports / benchmarks)
export function cycleSeconds(def, mat = MAT.DIRT) {
  const s = def.strike.reduce((a, p) => a + p[1], 0);
  const f = (mat === MAT.STONE ? def.follow.blocked() : def.follow.ok(mat)).reduce((a, p) => a + p[1], 0);
  return s + f;
}

const LOWER = 0.18, RAISE = 0.24;

export class ToolController {
  constructor({ owned = ["hand"], equipped = "hand", dev = false } = {}) {
    this.owned = new Set(owned.filter((id) => TOOL_DEFS[id]));
    this.owned.add("hand");
    this.dev = !!dev;
    this.equipped = this.canUse(equipped) ? equipped : "hand";
    this.state = "idle";                  // idle | action | lower | raise
    this.phase = null;                    // current action phase name
    this.phaseT = 0;
    this.phaseDur = 0;
    this.queue = [];
    this.afterContact = false;
    this.target = null;                   // tool to switch to
    this.switchT = 0;
    this.blocked = false;                 // e.g. the hand shows a nugget
    this.cycles = 0;
    this.lastReact = "ok";
  }

  get def() { return toolDef(this.equipped); }
  canUse(id) { return !!TOOL_DEFS[id] && (this.owned.has(id) || this.dev); }
  unlock(id) { if (TOOL_DEFS[id]) this.owned.add(id); }
  ownedList() { return TOOL_ORDER.filter((id) => this.owned.has(id)); }

  // ask for another tool; false when it is locked
  equip(id) {
    if (!this.canUse(id)) return false;
    if (id === this.equipped && !this.target) return true;
    this.target = id === this.equipped ? null : id;
    if (!this.target) return true;
    if (this.state === "action" && !this.afterContact) this._endAction();     // nothing happened yet: drop the stroke
    if (this.state === "idle") this._lower();
    return true;
  }

  _lower() { this.state = "lower"; this.switchT = 0; }

  _endAction() {
    this.state = "idle";
    this.phase = null;
    this.queue = [];
    this.afterContact = false;
  }

  // cancel whatever runs (pause, touchcancel before contact, ...)
  cancel() {
    if (this.state === "action" && !this.afterContact) this._endAction();
  }

  _startAction() {
    this.cycles++;
    this.state = "action";
    this.afterContact = false;
    const jitter = 0.95 + ((this.cycles * 7919) % 11) / 100;            // a little life in the rhythm
    this.queue = this.def.strike.map(([n, d]) => [n, d * jitter]);
    this._next();
  }

  _next() {
    const p = this.queue.shift();
    if (!p) { this._endAction(); return false; }
    this.phase = p[0];
    this.phaseDur = p[1];
    this.phaseT = 0;
    return true;
  }

  // the engine's answer to a contact: "ok" | "blocked" | "air", material index
  react(kind, mat = MAT.DIRT) {
    this.lastReact = kind;
    this.queue = (this.def.follow[kind] || this.def.follow.ok)(mat).map((p) => p.slice());
    this._next();
  }

  // per simulation step; returns "contact" in the step the tool meets the ground
  tick(dt, wantAction) {
    let event = null;
    if (this.state === "lower") {
      this.switchT += dt;
      if (this.switchT >= LOWER) {
        if (this.target && this.canUse(this.target)) this.equipped = this.target;
        this.target = null;
        this.state = "raise";
        this.switchT = 0;
        event = "swap";
      }
      return event;
    }
    if (this.state === "raise") {
      this.switchT += dt;
      if (this.switchT >= RAISE) { this.state = "idle"; this.switchT = 0; }
      return null;
    }
    if (this.state === "idle") {
      if (this.target) { this._lower(); return null; }
      if (wantAction && !this.blocked) this._startAction();
      else return null;
    }
    // action
    this.phaseT += dt;
    while (this.state === "action" && this.phaseT >= this.phaseDur) {
      const over = this.phaseT - this.phaseDur;
      if (!this.afterContact && this.queue.length === 0) {
        // the strike phase is done: the tool meets the ground now
        this.afterContact = true;
        this.phaseT = this.phaseDur;
        return "contact";                 // the engine calls react() before the next tick
      }
      if (!this._next()) {
        if (this.target) this._lower();
        else if (wantAction && !this.blocked) { this._startAction(); this.phaseT = Math.min(over, 0.05); }
        break;
      }
      this.phaseT = over;
    }
    return event;
  }

  // what the view model needs to pose hands and tool
  view() {
    const u = this.phaseDur ? Math.min(1, this.phaseT / this.phaseDur) : 0;
    return {
      tool: this.equipped, state: this.state, phase: this.phase, u, react: this.lastReact, cycle: this.cycles,
      switchU: this.state === "lower" ? Math.min(1, this.switchT / LOWER) : this.state === "raise" ? Math.min(1, this.switchT / RAISE) : 0,
    };
  }

  // only what is really yours is saved (a debug unlock never is)
  serialize() { return { equipped: this.owned.has(this.equipped) ? this.equipped : "hand", owned: this.ownedList() }; }
}
