// GoldRush - processing: getting the gold out of the ground you dug, by
// hand, at the camp's wash place (phase 5). Physical, not a menu:
//
//   BUCKET       stands where you put it. Dig next to it (any tool) and
//                what comes off goes INTO it - terrain mass out, bucket mass
//                in, with every slice's gold (the visible pieces and the
//                fine gold). Carry it (a full one slows you a little), set
//                it down at the wash place.
//   CLASSIFIER   tip the bucket onto the screen and shake it: stones and
//                clods stay on top and go to the tailings, nuggets are
//                picked out, the fines (and all the fine gold) fall into the
//                tub below - the concentrate.
//   WASH BOWL    (phase 7A) the free wooden bowl on the trough: from the first
//                bucket on you can wash - a small load, swirled like the pan,
//                but slower and much of the fine gold goes over its rim
//   GOLD PAN     fill it from the tub (concentrate) or straight from the
//                bucket (raw), swirl it in the trough: the light material
//                goes over the rim, the gold stays. Raw ground pans slower
//                and keeps less of the fine gold than a concentrate. Once
//                owned it replaces the bowl (more per load, faster, more gold).
//   POUCH        the recovered gold goes into the gold pouch (economy.recover)
//   WHEELBARROW  (phase 6) the big container: dig into it like into the bucket,
//                push it (goldrush-wheelbarrow.js), tip it into the sluice
//                hopper, or park it at the wash place to feed screen and pan
//   SLUICE       (phase 6) the first continuous processing by the water tank
//                (goldrush-sluice.js): hopper -> riffles -> tailings; its
//                cleaned heavy concentrate is panned here like the rest
//   BULK HOPPER  (phase 7) several barrow loads in store at the sluice's head,
//   FEEDER       a motor dosing it into the sluice hopper (goldrush-automation.js,
//                on the transfer layer goldrush-transfer.js)
//   SAMPLES      (phase 9) the prospecting kit's bags (goldrush-prospect.js): a
//                test pan at the trough, its result into the notebook
//   CONVEYOR     (phase 9) the mine intake hopper at the mountain's foot and the
//   TROMMEL      belt up to the bulk hopper; the trommel screen on the bulk
//   SPOIL        hopper's frame; the spoil heap (goldrush-plant.js)
//
// Every move of material between containers goes through pour()
// (goldrush-material.js) or its generic form transfer() (goldrush-transfer.js:
// batch holders and layered buffers alike) - the bucket, the barrow, the
// hoppers, the feeder today, a loader or a conveyor later.
//
// The material is a MaterialBatch all the way (goldrush-material.js):
// nothing is re-rolled, gold is only ever moved or - what a process does
// not recover - booked to the tailings. ledger: gold in (from digs) ==
// gold in containers + recovered + tailings, to the microgram.
// Work (panning / sieving) is done by the player: mouse / touch movement
// swirls the pan or shakes the screen; progress is capped per second, so a
// load takes its few seconds of real work - no bar that fills on its own.

import { MaterialBatch, STAGE, COARSE, batchFromDig, classify, panLoad, panSeconds, sieveSeconds, washRecovery, PAN_CAPACITY_ML, BOWL_CAPACITY_ML, BOWL_REST_ML, pour } from "./goldrush-material.js";
import { ProcessModels, bucketFillHeight, washShape } from "./goldrush-processmodels.js";
import { MechModels, BARROW } from "./goldrush-mechmodels.js";
import { Wheelbarrow } from "./goldrush-wheelbarrow.js";
import { Sluice, SLUICE_AT, SLUICE_SPOTS, CLEAN_S } from "./goldrush-sluice.js";
import { WashPlant, WP } from "./goldrush-washplant.js";
import { AutoModels, BULK } from "./goldrush-automodels.js";
import { BulkHopper, Feeder, BULK_AT, AUTO_SPOTS, inAutomationFoot } from "./goldrush-automation.js";
import { transfer, roomOf, putInto } from "./goldrush-transfer.js";
import { FIND } from "./goldrush-resources.js";
import { findSize } from "./goldrush-loot.js";
import { centsForMass } from "./goldrush-economy.js";
import { mergeStatic } from "./goldrush-merge.js";
import { screenShape } from "./goldrush-heap.js";
import { ProspectSystem, SAMPLE_PAN_S } from "./goldrush-prospect.js";
import { PlantModels, OVER_BELT, OVER_DROP, TRAP } from "./goldrush-plantmodels.js";
import { Conveyor, Trommel, SpoilHeap, INTAKE, INTAKE_SPOT, CONVEYOR_KIT, TROMMEL_KIT, OVERSIZE, SPOIL } from "./goldrush-plant.js";
import { MaterialBuffer } from "./goldrush-transfer.js";
import { boardTexture } from "./goldrush-buildings.js";
import { Excavator } from "./goldrush-excavator.js";
import { AutoMiner, STATUS as MINER_STATUS } from "./goldrush-autominer.js";
import { AM } from "./goldrush-autominermodel.js";
import { StockpileSystem } from "./goldrush-stockpile.js";
import { Loader } from "./goldrush-loader.js";

// the wash place, next to the water tank (-19.5, 1.8)
export const WASH = {
  trough: { x: -16.95, z: 2.35 },                          // centre (long side along z)
  panSpot: { x: -16.12, z: 2.0, yaw: Math.PI / 2 },        // stand here, facing the trough (west)
  bucketSpot: { x: -16.15, z: 3.5 },                       // a bucket set down at the wash place
  classifier: { x: -16.95, z: 4.8 },
  sieveSpot: { x: -15.9, z: 4.8, yaw: Math.PI / 2 },
  supplyDrop: { x: -17.35, z: 9.55 },                      // a bought bucket waits in front of the shed
  barrowDrop: { x: -15.2, z: 9.2, yaw: -Math.PI / 2 },     // ... a bought wheelbarrow next to it
  feedZone: { x: -16.0, z: 3.4, r: 3.1 },                  // a barrow parked here feeds screen and pan
};
export const EQUIP = ["bucket", "pan", "classifier", "wheelbarrow", "sluice", "bulkhopper", "feeder", "prospectkit", "conveyor", "trommel", "excavator", "loader", "washplant", "autominer"];
const INTAKE_REACH = 2.6;          // m: standing this close to the intake hopper, what you dig goes into it
const BARROW_REACH = 2.6;        // m: a parked barrow this close (its tray) catches what you dig
const HOPPER_AT = { x: SLUICE_AT.x - 0.27, z: SLUICE_AT.z };
export const BUCKET_ML = 10000;
export const TUB_ML = 30000;
const CLASSIFIER_ML = 14000;
const REACH = 2.4;               // m: a bucket this close catches what you dig
const USE_R = 1.6;               // m: work spots
const PICK_R = 1.8;              // m: picking a bucket up
const FULL_SLOW = 0.15;          // a full 10 l bucket: 15 % slower
const HELD = {
  bucket: { p: [0.24, -0.52, -0.6], r: [0.42, 0.3, 0.06] },           // hanging from the right hand, rim and load in view
  pan: { p: [0, -0.23, -0.6], r: [0.58, 0, 0] },                        // both hands, over the trough, tilted to you
  bowl: { p: [0, -0.22, -0.55], r: [0.52, 0, 0] },                      // the wooden bowl: smaller, a little closer
  sieve: { p: [0, -0.25, -0.5], r: [0, 0, 0] },                         // both hands on the frame's handles
};
// the rims the hands hold (goldrush-processmodels.js PAN / BOWL profiles: the outer wall's top, its angle)
// (fingers straight along the wall: curled, their tips came through the bottom - phase 8 QA)
const PAN_RIM = { at: 0.1, r: 0.19, y: 0.058, wall: 0.64, up: 0.07, out: 0.03, twist: 0, tilt: 0 };
const BOWL_RIM = { at: 0.1, r: 0.158, y: 0.07, wall: 0.8, up: 0.07, out: 0.03, twist: 0, tilt: 0 };
const PAN_THUMB = [-1.21, 0.524, 1.2, 0.8];          // the thumb's rotation (x, y, z) and the bend of its tip: over the rim, forward and in
// how the gloves hold them (in the object's frame; like GRIPS in goldrush-hand.js:
// a left-hand grip is written as for the right hand - it is mirrored)
export const HELD_GRIPS = {
  bucket: [{ side: 1, pos: [0, 0.428, 0], axis: "x", roll: -0.2, flip: 1 }],
  // pan / bowl (phase 8): held from outside at the sides - the palms against the outer wall under the
  // rim, the fingers under the bottom, the thumbs over the rim (goldrush-hand.js _rimMatrix)
  pan: [{ side: 1, rim: PAN_RIM, curl: 0, thumb: PAN_THUMB }, { side: -1, rim: PAN_RIM, curl: 0, thumb: PAN_THUMB }],
  bowl: [{ side: 1, rim: BOWL_RIM, curl: 0, thumb: PAN_THUMB }, { side: -1, rim: BOWL_RIM, curl: 0, thumb: PAN_THUMB }],
  sieve: [{ side: 1, pos: [0.16, 0, 0], axis: "z", roll: 2.4, flip: 1 }, { side: -1, pos: [0.16, 0, 0], axis: "z", roll: 2.4, flip: 1 }],
};
const COLORS = { raw: 0x8a6a4c, conc: 0x6a5846, black: 0x3a332c };
// the feeder lever: what [E] sets next
const MODE_TEXT = { auto: "Dosierer auf AUTO – läuft, solange das Wasser an ist", on: "Dosierer einschalten (AN)", stop: "Dosierer ausschalten" };
const MODE_SHORT = { auto: "AUTO", on: "START", stop: "STOP" };
const BULK_KIT = { x: BULK_AT.x + 1.45, z: BULK_AT.z - 1.2 };
const SLUICE_LEN = 2.7;               // SLUICE.len (goldrush-mechmodels.js): where the wet ground lies

// a stable pseudo-random number 0..1 for n (visual variation only - never gameplay)
const hash01 = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const ease = (t) => t * t * (3 - 2 * t);
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class ProcessingSystem {
  /**
   * @param saved    doc.processing (v5) or null
   * @param ctx      { economy, effects, hands, envMap, goldMat, upgrades: () => Set }
   */
  constructor(THREE, scene, world, saved, ctx) {
    this.THREE = THREE;
    this.scene = scene;
    this.world = world;
    this.economy = ctx.economy;
    this.effects = ctx.effects;
    this.hands = ctx.hands;
    this.upgrades = ctx.upgrades || (() => new Set());
    this.models = new ProcessModels(THREE, { envMap: ctx.envMap, goldMat: ctx.goldMat, woodTex: world.woodTex });
    const s = saved || {};
    this.ctx = ctx;
    this.camera = ctx.camera || null;
    this.owned = new Set((Array.isArray(s.owned) ? s.owned : []).filter((id) => EQUIP.includes(id)));
    this.nextBatch = Number.isInteger(s.nextBatch) && s.nextBatch > 0 ? s.nextBatch : 1;
    const sb = s.bucket || null;
    this.bucket = this.owned.has("bucket") ? {
      x: Number.isFinite(sb && sb.x) ? sb.x : WASH.supplyDrop.x, z: Number.isFinite(sb && sb.z) ? sb.z : WASH.supplyDrop.z, ry: Number.isFinite(sb && sb.ry) ? sb.ry : 0,
      carried: !!(sb && sb.carried), batch: MaterialBatch.from(sb && sb.batch) || this._batch(STAGE.RAW),
    } : null;
    this.tub = MaterialBatch.from(s.tub) || this._batch(STAGE.CONCENTRATE);
    const sp = s.pan || {};
    // pan.tool: what the load in it is washed with - "pan", or the wooden "bowl" before you own a pan
    this.pan = { batch: MaterialBatch.from(sp.batch) || this._batch(STAGE.RAW), progress: Math.max(0, Math.min(1, +sp.progress || 0)), need: 8, tool: sp.tool === "bowl" ? "bowl" : "pan" };
    // phase 9: a prospecting sample in the pan (its notebook line waits for the result)
    this.pan.sample = sp.sample && typeof sp.sample === "object" && (this.pan.batch.volumeMl > 0 || this.pan.batch.goldUg > 0) ? { ...sp.sample } : null;
    const ss = s.sieve || {};
    this.sieve = { batch: MaterialBatch.from(ss.batch) || this._batch(STAGE.RAW), progress: Math.max(0, Math.min(1, +ss.progress || 0)), need: 4, stones: 0, dumpT: 0 };
    const l = s.ledger || {};
    this.ledger = {
      inUg: int(l.inUg), inFineUg: int(l.inFineUg), inG: int(l.inG), inMl: int(l.inMl), inFinds: int(l.inFinds),     // inFinds: pieces carried in (7B)
      recoveredUg: int(l.recoveredUg), recoveredFineUg: int(l.recoveredFineUg), tailUg: int(l.tailUg), tailG: int(l.tailG), tailMl: int(l.tailMl),
      spoilFineUg: int(l.spoilFineUg), panLoads: int(l.panLoads), sieveLoads: int(l.sieveLoads), buckets: int(l.buckets),
    };
    if (l.bowlLoads) this.ledger.bowlLoads = int(l.bowlLoads);      // phase 7A: loads washed in the wooden bowl
    if (l.devInUg) this.ledger.devInUg = int(l.devInUg);         // developer test material (only in test mines)
    this.work = null;              // null | "pan" | "sieve"
    this.swirlAngle = 0;
    this.swirlK = 0;               // how hard you swirl right now (0..1, visuals)
    this.shakeX = 0;
    this.time = 0;
    this.lastFull = false;
    this.reveal = null;            // the gold left in the pan at the end (what is shown)
    this.panDone = false;
    // Prompt 10 (human QA): the work's phase - "gesture" (the mouse works the tool, nothing else), "settle" (the
    // motion runs out, input ignored), "result" (what came out shows; E / a click ends it - only then the mouse
    // looks around again) - pan, sieve and the sluice's mat alike
    this.workPhase = null;
    this.workResult = null;
    this.settleT = 0;
    this._build();
    this.barrow = this.owned.has("wheelbarrow") ? new Wheelbarrow(THREE, this.scene, this.world, this.mech, s.wheelbarrow, WASH.barrowDrop) : null;
    if (this.barrow) this.barrow.applyUpgrades(this.upgrades());            // (Prompt 10: its sideboards, tyre, bearings)
    this.sluice = this.owned.has("sluice") ? this._newSluice(s.sluice) : null;
    this.bulk = this.owned.has("bulkhopper") ? new BulkHopper(THREE, this.scene, this.world, this.auto, s.bulkHopper, this._autoCtx()) : null;
    this.feeder = this.owned.has("feeder") && this.bulk ? new Feeder(THREE, this.scene, this.world, this.auto, s.feeder, this._autoCtx()) : null;
    if (this.owned.has("feeder") && !this.bulk) this.owned.delete("feeder");
    this.prospect = this.owned.has("prospectkit") ? this._newProspect(ctx.prospect) : null;
    // Prompt 10: the stockpiles (raw pay dirt, oversize, tailings, spoil) - real piles on the ground; they exist from the
    // start (an empty one draws nothing), the trommel and the spoil heap put their material onto them
    this.piles = new StockpileSystem(THREE, this.scene, this.world, s.piles || null, { ledger: this.ledger, nextId: () => this.nextBatch++, soilTex: this.world.soilTex || null, seed: this.world.seed || 1 });
    // phase 9: the plant - intake + conveyor, trommel, the spoil heap (with the excavator)
    this.conveyor = this.owned.has("conveyor") && this.bulk ? new Conveyor(THREE, this.scene, this.world, this.pm, s.conveyor, this._plantCtx()) : null;
    if (this.owned.has("conveyor") && !this.conveyor) this.owned.delete("conveyor");
    this.trommel = this.owned.has("trommel") && this.conveyor ? new Trommel(THREE, this.scene, this.world, this.pm, s.trommel, this._trommelCtx()) : null;
    if (this.owned.has("trommel") && !this.trommel) this.owned.delete("trommel");
    if (this.conveyor) this.conveyor._sync();
    this.spoil = this.owned.has("excavator") || this.owned.has("trommel") ? this._newSpoil(s.spoil) : null;       // the waste dump: with the trommel (oversize) or the excavator
    this.excavator = this.owned.has("excavator") ? this._newExcavator(s.excavator) : null;
    this.autominer = this.owned.has("autominer") ? this._newMiner(s.autominer) : null;       // Prompt 10: the automatic hillside miner
    this.loader = this.owned.has("loader") ? this._newLoader(s.loader) : null;
    this._spoilBin = new MaterialBuffer({ capacityMl: 1e12 });          // a barrow tipped onto the heap passes through here (same frame)
    // Prompt 10: the wash plant around the sluice (three lanes, the distribution box, the concentrate tub)
    this.washplant = this.owned.has("washplant") && this.sluice ? this._newWashplant(s.washplant) : null;
    if (this.owned.has("washplant") && !this.washplant) this.owned.delete("washplant");
    if (this.washplant) { this.sluice.applyUpgrades(); this.sluice._sync(); if (this.feeder) this.feeder.applyUpgrades(); }
    this._refitBarrow();                                       // parked on the platform: it stands on the deck (made just now)
  }

  _newWashplant(saved) {
    return new WashPlant(this.THREE, this.scene, this.world, this.mech, saved, {
      sluice: () => this.sluice, at: SLUICE_AT, nextId: () => this.nextBatch++, ledger: this.ledger, economy: this.economy, upgrades: this.upgrades,
      tailOut: () => (this.piles ? this.piles.get("tailOut") : null), warm: () => { this.warmPending = true; }, onReady: () => this.applyUpgrades(),
    });
  }

  // where you stand at the sluice: its own spots, or the wash plant's once it stands (the box moved the hopper)
  get wp() { return this.washplant && this.washplant.installed ? this.washplant : null; }
  _slSpots() {
    const wp = this.wp;
    return wp ? { feed: wp.spots.feed, clean: wp.spots.clean, hopper: wp.spots.dist, cleanLook: { x: SLUICE_AT.x + 1.35, z: SLUICE_AT.z + 0.78 } }
      : { feed: SLUICE_SPOTS.feed, clean: SLUICE_SPOTS.clean, hopper: HOPPER_AT, cleanLook: { x: SLUICE_AT.x + 1.35, z: SLUICE_AT.z } };
  }

  // a parked barrow onto whatever the ground is now (decks appear / go with the bulk hopper)
  _refitBarrow() { const w = this.barrow; if (w && !w.pushing && !w.dump) w.fit(null); }

  _autoCtx() {
    return this._actx || (this._actx = { nextId: () => this.nextBatch++, upgrades: this.upgrades, sluice: () => this.sluice, bulk: () => this.bulk, warm: () => { this.warmPending = true; },
      washplant: () => this.washplant });
  }

  _newSluice(saved) {
    return new Sluice(this.THREE, this.scene, this.world, this.mech, saved, {
      ledger: this.ledger, economy: this.economy, nextId: () => this.nextBatch++, upgrades: this.upgrades, warm: () => { this.warmPending = true; },
      tailOut: () => (this.piles ? this.piles.get("tailOut") : null), washplant: () => this.washplant,
    });
  }

  /**
   * Prompt 10 (human QA): every container a load can be tipped into - ONE table the barrow, the loader (and the
   * excavator) ask the same way. Each: { id, act (the station's id), label, holder (a buffer / batch holder) or
   * pile, at {x, z}, reach (m, the barrow's tray centre from `at`), loaderReach, top (rim, world y), room, fill,
   * done(ml) (the receiver's own bookkeeping), inRange(barrow, trayCentre) optional (the bulk hopper's deck) }.
   * The move itself is transfer() everywhere: exact, partial when full - the rest stays where it was.
   */
  receivers() {
    const out = this._recv || (this._recv = []);
    out.length = 0;
    const cv = this.conveyor, bk = this.bulk, sl = this.sluice, l = (ml) => Math.round(ml / 1000);
    if (cv && cv.installed) out.push({ id: "intake", act: "intake-dump", label: "Aufgabetrichter", into: "in den Aufgabetrichter", at: INTAKE, reach: 2.25, loaderReach: 1.35,
      top: this.world.groundBelowAt(INTAKE.x, INTAKE.z) + Math.max(INTAKE.top, cv.rimY + 0.16), holder: cv.intake, room: cv.intake.room, fill: `${l(cv.volumeMl)} / ${l(cv.capacityMl)} l`,
      done: (ml, quiet) => { cv.stats.inMl += ml; if (ml > 0 && !quiet) cv.stats.loads++; cv._fillSig = null; if (this.onDumped && !quiet) this.onDumped(ml, "intake"); } });
    if (bk && bk.installed) out.push({ id: "bulk", act: "bulk-dump", label: "Vorratstrichter", into: "in den Vorratstrichter", at: BULK_AT, deck: true,
      holder: bk.buffer, room: bk.buffer.room, fill: `${l(bk.volumeMl)} / ${l(bk.capacityMl)} l`, inRange: (w, c) => this._atBulkDump(w, c),
      done: (ml) => { bk.stats.inMl += ml; if (ml > 0) bk.stats.loads++; bk._fill(); if (this.onDumped) this.onDumped(ml, "bulk"); } });
    const wpl = this.wp;
    if (sl && sl.installed) out.push({ id: "hopper", act: "barrow-dump", label: wpl ? "Verteilerkasten" : "Trichter der Waschrinne", into: wpl ? "in den Verteilerkasten" : "in den Trichter", at: wpl ? wpl.spots.dist : HOPPER_AT, reach: wpl ? 1.7 : 1.5, small: true,
      holder: sl.hopper, room: sl.capacityMl - sl.hopper.batch.volumeMl, fill: `${l(sl.hopper.batch.volumeMl)} / ${l(sl.capacityMl)} l`,
      done: (ml) => { if (this.onDumped) this.onDumped(ml); } });
    for (const P of this.piles.list()) {
      if (!P.dumpable) continue;
      out.push({ id: `pile:${P.id}`, act: P.id === "spoil" ? "spoil-dump" : `pile-dump:${P.id}`, label: P.def.name, into: P.id === "spoil" ? "auf die Abraumhalde (Abraum – wird nicht gewaschen)" : `auf ${P.def.name === "Rohmaterial" ? "den Rohhaufen" : `die ${P.def.name}`}`,
        pile: P, at: P.site.drop, room: P.room, fill: `${(P.volumeMl / 1e6).toFixed(1).replace(".", ",")} m³`,
        inRange: (w, c) => P.inside(c.x, c.z, 0.25), done: (ml) => { if (this.onDumped) this.onDumped(ml, P.id === "spoil" ? "spoil" : "pile"); } });
    }
    return out;
  }

  // which receiver a barrow (pushed, tray centre c) is at: the bulk hopper's deck / a pile site, or near enough to
  // a hopper's rim and facing it
  _barrowReceiver(w, c) {
    const f = w.fwd ? w.fwd() : { x: -Math.sin(w.yaw), z: -Math.cos(w.yaw) };
    let best = null, bd = Infinity;
    for (const r of this.receivers()) {
      if (r.inRange) { if (r.inRange(w, c)) { const d = r.pile ? 0.5 : 0; if (d < bd) { bd = d; best = r; } } continue; }
      const dx = r.at.x - c.x, dz = r.at.z - c.z, d = Math.hypot(dx, dz);
      if (d > r.reach) continue;
      // tipping forwards: the hopper ahead of the tray (or right under it)
      if (d > 0.6 && (f.x * dx + f.z * dz) / d < 0.15) continue;
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  }

  /**
   * Prompt 10: the hand / the shovel takes from a pile (its surface at `at`, the stroke along dir) into the
   * bucket / barrow / intake next to you - up to ml, exactly that pile's material (no new ledger booking: it was
   * in already; a tailings pile hands its share back from the tailings). -> { ml, into } (ml 0: no room / nothing)
   */
  collectFromPile(pile, at, dir, ml, player) {
    const tgt = this._digTarget(player);
    const room = !tgt ? 0 : tgt.holder ? tgt.room : tgt.capacityMl - tgt.batch.volumeMl;
    if (room <= 0) return { ml: 0, into: null, noRoom: !tgt ? "none" : "full" };
    const L = Math.hypot(dir.x, dir.z) || 1, dx = dir.x / L, dz = dir.z / L;
    const got = pile.cut(at.x - dx * 0.12, at.z - dz * 0.12, dx, dz, 0.16, 0.34, at.y - 0.16, Math.min(ml, room));
    if (got.volumeMl <= 0) return { ml: 0, into: tgt.kind };
    const v = got.volumeMl;
    if (tgt.holder) { tgt.holder.put(got); if (tgt.kind === "intake") { this.conveyor.stats.inMl += v; this.conveyor._fillSig = null; } }
    else tgt.batch.absorb(got);
    this._fills();
    this.fullNow = tgt.holder ? tgt.holder.room <= 50 : tgt.batch.volumeMl >= tgt.capacityMl - 50;
    this.fullKind = tgt.kind;
    return { ml: v, into: tgt.kind };
  }

  _batch(stage) { return new MaterialBatch({ id: this.nextBatch++, stage }); }

  _plantCtx() {
    return this._pctx || (this._pctx = { nextId: () => this.nextBatch++, sluice: () => this.sluice, bulk: () => this.bulk, trommel: () => this.trommel, conveyor: () => this.conveyor,
      ledger: this.ledger, warm: () => { this.warmPending = true; }, upgrades: () => this.upgrades() });
  }

  // Prompt 10: the trommel's oversize lies on the OVERSIZE pile, the spoil heap is the SPOIL pile
  _trommelCtx() { return this._tctx || (this._tctx = { ...this._plantCtx(), pile: () => this.piles.get("oversize"), onTrap: (fs) => { if (this.onTrap) this.onTrap(fs); } }); }
  _spoilCtx() { return this._sctx || (this._sctx = { ...this._plantCtx(), pile: () => this.piles.get("spoil") }); }

  // Prompt 10: the compact wheel loader (goldrush-loader.js) - its bucket is a container like the barrow
  _newLoader(saved) {
    const c = this.ctx;
    return new Loader(this.THREE, this.scene, this.world, saved, {
      ledger: this.ledger, nextId: () => this.nextBatch++, piles: () => this.piles, assets: c.assets || null, envMap: c.envMap || null,
      soilTex: this.world.soilTex || null, warm: () => { this.warmPending = true; },
    });
  }

  // phase 9: the compact excavator (goldrush-excavator.js) - its bucket is a container like the barrow
  _newExcavator(saved) {
    const c = this.ctx;
    return new Excavator(this.THREE, this.scene, this.world, saved, {
      ledger: this.ledger, nextId: () => this.nextBatch++, mining: () => c.mining(), terrain: () => c.terrain, rocks: () => c.rocks(), economy: () => this.economy,
      conveyor: () => this.conveyor, barrow: () => this.barrow, bulk: () => this.bulk, spoil: () => this.spoil, trommel: () => this.trommel, upgrades: this.upgrades, piles: () => this.piles,
      assets: c.assets || null, envMap: c.envMap || null, warm: () => { this.warmPending = true; }, standModel: () => this.pm.attachmentStand(),
    });
  }

  // Prompt 10: the automatic hillside miner (goldrush-autominer.js) - its belt is a container
  _newMiner(saved) {
    const c = this.ctx;
    return new AutoMiner(this.THREE, this.scene, this.world, saved, {
      ledger: this.ledger, nextId: () => this.nextBatch++, mining: () => c.mining(), terrain: () => c.terrain, rocks: () => c.rocks(), economy: () => this.economy,
      conveyor: () => this.conveyor, piles: () => this.piles, effects: () => this.effects || null, sound: (k, o) => { if (this.onSoundAt) this.onSoundAt(k, o); },
      warm: () => { this.warmPending = true; },
    });
  }

  _newSpoil(saved) {
    return new SpoilHeap(this.THREE, this.scene, this.world, this.pm, saved, this._spoilCtx(), boardTexture(this.THREE, "ABRAUM", { w: 512, h: 160 }));
  }

  // phase 9: the prospecting kit (bags, notebook, flags)
  _newProspect(saved) {
    return new ProspectSystem(this.THREE, this.scene, this.world, saved, { ledger: this.ledger, economy: this.economy, terrain: this.ctx.terrain || null, nextId: () => this.nextBatch++ });
  }

  // ------------------------------------------------------------ world

  _build() {
    const THREE = this.THREE, M = this.models;
    this.group = new THREE.Group();
    this.group.name = "goldrush-processing";
    this.scene.add(this.group);
    // the wash place is there from the start (the camp's water tank finally has a use)
    this.wash = M.washPlace(true);
    this.wash.position.set(WASH.trough.x, 0, WASH.trough.z);
    this.group.add(this.wash);
    this._wetGround();
    this.world.colliders.push({ type: "box", x: WASH.trough.x, z: WASH.trough.z, hw: 0.34, hd: 1.06, rot: 0 });
    // the pan lying on the trough's near rim (when owned and not in your hands)
    this.restPan = M.pan();
    this.restPan.position.set(WASH.trough.x + 0.12, 0.43, WASH.trough.z - 0.7);
    this.restPan.rotation.set(0, 0, -0.08);
    this.group.add(this.restPan);
    // phase 7A: the wooden wash bowl - part of the wash place from the start, on the trough's rim
    this.restBowl = M.bowl();
    // (7B: set down on the near rim, tipped towards where you stand - its inside in view)
    this.restBowl.position.set(WASH.trough.x + 0.24, 0.47, WASH.trough.z + 0.22);
    this.restBowl.rotation.set(0.04, 0, -0.36);
    this.group.add(this.restBowl);
    // the classifier with its tub
    this.cls = M.classifier();
    this.cls.position.set(WASH.classifier.x, 0, WASH.classifier.z);
    this.group.add(this.cls);
    this.clsCollider = { type: "box", x: WASH.classifier.x, z: WASH.classifier.z, hw: 0.5, hd: 0.4, rot: 0 };
    // phase 7A draw calls: the trough with its pipe and sign, the classifier's tub and legs, its
    // shaking frame with the handles - each baked per material (water, fills, heap, stones stay apart)
    const wu = this.wash.userData, cu = this.cls.userData, keep = new Set([wu.water, wu.trickle, cu.conc, cu.heap, cu.stones]);
    const plain = (list) => list.filter((o) => o.isMesh && !keep.has(o));
    this._merged = [
      ...mergeStatic(THREE, this.wash, plain(this.wash.children)),
      ...mergeStatic(THREE, this.cls, plain([...cu.tub.children, ...this.cls.children])),
      ...mergeStatic(THREE, cu.frame, plain(cu.frame.children)),
    ];
    // the world bucket
    this.worldBucket = M.bucket();
    this.group.add(this.worldBucket);
    // in the hands (first-person pass)
    this.handBucket = M.bucket();
    this.handPan = M.pan({ hand: true });
    this.handBowl = M.bowl({ hand: true });
    this.handSieve = new THREE.Group();                        // nothing drawn: the gloves on the (world) frame's handles
    // phase 6: the wheelbarrow and the sluice share one model kit
    this.mech = new MechModels(THREE, { envMap: this.ctx.envMap, woodTex: this.world.woodTex });
    this.auto = new AutoModels(this.mech);                     // phase 7: the bulk hopper, the feeder (same materials)
    this.pm = new PlantModels(this.mech, this.auto);           // phase 9: intake, conveyor, trommel, heaps (same materials)
    this._ga = new THREE.Vector3();
    this._gb = new THREE.Vector3();
    this._sync();
  }

  // phase 7: wet ground where water is used - darker, a little mud, a few small puddles
  // (cosmetic decals on the flat camp ground; the sluice's only once it has run)
  _wetGround() {
    const THREE = this.THREE, c = document.createElement("canvas");
    c.width = c.height = 128;
    const g2 = c.getContext("2d"), img = g2.createImageData(128, 128);
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
      const dx = x / 64 - 1, dy = y / 64 - 1, r = Math.hypot(dx, dy);
      const n = Math.sin(x * 0.21 + Math.sin(y * 0.13) * 2) * 0.5 + Math.sin(y * 0.17 + Math.sin(x * 0.11) * 3) * 0.5;
      const a = Math.max(0, Math.min(1, (1 - r) * 1.6 + n * 0.25 - 0.1)), i = (y * 128 + x) * 4;
      img.data[i] = 34 + n * 6; img.data[i + 1] = 26 + n * 5; img.data[i + 2] = 18 + n * 4; img.data[i + 3] = Math.round(a * 255);
    }
    g2.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this._wetTex = tex;
    const mk = (opacity, rough) => new THREE.MeshStandardMaterial({ map: tex, transparent: true, opacity, roughness: rough, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, envMap: this.ctx.envMap || null });
    this._wetMats = [mk(0.72, 0.62), mk(0.85, 0.12)];
    const geo = (this._wetGeo = new THREE.PlaneGeometry(1, 1));
    geo.rotateX(-Math.PI / 2);
    this._wet = [];
    this._wetBuild("");
  }

  // the patches: [x, z, size (m), stretch, puddle?, which: wash | sluice, turn?]. Prompt 10: the wash plant's two
  // more lane ends, its box and its tub, the trommel's oversize chute and the stacker dripping along the fence join
  // the sluice's groups (no extra draw) once they stand
  _wetSpots(key) {
    const SA = SLUICE_AT;
    const spots = [[WASH.trough.x + 0.55, WASH.trough.z - 0.1, 2.0, 1.4, 0, "wash"], [WASH.panSpot.x - 0.05, WASH.panSpot.z - 0.35, 0.55, 1.2, 1, "wash"],
      [WASH.classifier.x + 0.35, WASH.classifier.z - 0.1, 1.4, 1.2, 0, "wash"], [-19.5 + 0.9, 1.8 - 0.9, 0.9, 1, 0, "wash"],
      [SA.x + SLUICE_LEN + 0.2, SA.z + 0.55, 2.2, 1.5, 0, "sluice"], [SA.x + SLUICE_LEN - 0.4, SA.z + 0.95, 0.6, 1.4, 1, "sluice"],
      [SA.x - 0.25, SA.z + 0.95, 1.3, 1.2, 0, "sluice"], [SA.x + 1.3, SA.z + 0.75, 0.45, 1.6, 1, "sluice"]];
    if (key.includes("w")) spots.push([SA.x + SLUICE_LEN + 0.35, SA.z + 1.6, 2.0, 1.45, 0, "sluice", 0.3], [SA.x + SLUICE_LEN - 0.35, SA.z + 1.95, 0.5, 1.5, 1, "sluice", 0.1],
      [SA.x - 0.5, SA.z + 1.7, 1.25, 1.3, 0, "sluice", 1.4], [SA.x + 2.1, SA.z + 2.6, 0.85, 1.3, 0, "sluice", 0.2],
      [SA.x + SLUICE_LEN + 0.55, SA.z + 0.85, 1.7, 1.5, 0, "sluice", 1.9]);
    if (key.includes("t")) spots.push([OVERSIZE.x + 0.15, OVERSIZE.z - 0.35, 1.05, 1.3, 0, "sluice", 1.2], [OVER_BELT.tail.x + 0.1, (OVER_BELT.tail.z + OVER_BELT.head.z) / 2, 0.95, 2.7, 0, "sluice", Math.PI / 2 + 0.05],
      [OVER_DROP.x + 0.25, OVER_DROP.z + 0.35, 1.0, 1.4, 0, "sluice", 0.7]);
    return spots;
  }

  // (re)build the groups' meshes for these patches (the meshes stay - only their geometry changes)
  _wetBuild(key) {
    const THREE = this.THREE, geo = this._wetGeo;
    this._wetKey = key;
    // one mesh per (place, kind) - four draws instead of eight (phase 7A); they toggle as groups
    const groups = new Map();
    this._wetSpots(key).forEach(([x, z, size, st, puddle, which, turn], i) => {
      const k = `${which}:${puddle}`;
      if (!groups.has(k)) groups.set(k, { which, puddle, parts: [] });
      const m = new THREE.Mesh(geo, this._wetMats[puddle]);
      m.position.set(x, 0.004 + i * 0.0004, z);
      m.scale.set(size * st, 1, size);
      m.rotation.y = turn != null ? turn : i * 1.37;
      groups.get(k).parts.push(m);
    });
    for (const g of this._wetGeos || []) g.dispose();
    this._wetGeos = [];
    const old = this._wet || [];
    this._wet = [...groups.values()].map(({ which, puddle, parts }) => {
      const g = new THREE.BufferGeometry(), P = [], N = [], U = [], I = [];
      for (const m of parts) {
        m.updateMatrix();
        const b = P.length / 3, pos = geo.attributes.position, uv = geo.attributes.uv, v = new THREE.Vector3();
        for (let q = 0; q < pos.count; q++) { v.fromBufferAttribute(pos, q).applyMatrix4(m.matrix); P.push(v.x, v.y, v.z); N.push(0, 1, 0); U.push(uv.getX(q), uv.getY(q)); }
        for (let q = 0; q < geo.index.count; q++) I.push(geo.index.getX(q) + b);
      }
      g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(N, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(U, 2));
      g.setIndex(I);
      g.computeBoundingSphere();
      this._wetGeos.push(g);
      const had = old.find((m) => m.userData.which === which && m.userData.puddle === !!puddle);
      if (had) { had.geometry = g; had.userData.patches = parts.length; return had; }
      const mesh = new THREE.Mesh(g, this._wetMats[puddle]);
      mesh.renderOrder = 1;
      mesh.userData = { which, puddle: !!puddle, patches: parts.length };
      this.group.add(mesh);
      return mesh;
    });
  }

  // which wet patches show: the wash place always, the sluice's once it ran; LOW quality: no puddles
  _wetSync() {
    const key = `${this.washplant && this.washplant.installed ? "w" : ""}${this.trommel && this.trommel.installed ? "t" : ""}`;
    if (key !== this._wetKey) this._wetBuild(key);
    const low = this.ctx.quality && this.ctx.quality() === "low", ran = !!(this.sluice && this.sluice.installed && this.sluice.stats.processedMl > 0);
    for (const m of this._wet) m.visible = (m.userData.which === "wash" || ran) && !(low && m.userData.puddle);
  }

  // what is visible where (after a purchase / load)
  _sync() {
    const has = (id) => this.owned.has(id);
    this.restPan.visible = has("pan") && !(this.work === "pan" && this.pan.tool === "pan");
    this.restBowl.visible = !(this.work === "pan" && this.pan.tool === "bowl");
    this.cls.visible = has("classifier");
    const cIdx = this.world.colliders.indexOf(this.clsCollider);
    if (has("classifier") && cIdx < 0) this.world.colliders.push(this.clsCollider);
    if (!has("classifier") && cIdx >= 0) this.world.colliders.splice(cIdx, 1);
    const ups = this.upgrades();
    this.capacityMl = Math.round(BUCKET_ML * (ups.has("bucket.xl") ? 1.9 : ups.has("bucket.large") ? 1.4 : 1));
    this.bucketScale = ups.has("bucket.xl") ? 1.24 : ups.has("bucket.large") ? 1.12 : 1;
    if (this.barrow) this.barrow.applyUpgrades(ups);
    this.worldBucket.scale.setScalar(this.bucketScale);
    this.handBucket.scale.setScalar(this.bucketScale);
    this.recoveryMul = ups.has("pan.riffles") ? 1.12 : 1;
    this.handPan.userData.riffles.visible = this.restPan.userData.riffles.visible = ups.has("pan.riffles");
    this.worldBucket.visible = !!this.bucket && !this.bucket.carried;
    this._placeBucket();
    this._fills();
    this._wetSync();
  }

  ownedList() { return EQUIP.filter((id) => this.owned.has(id)); }

  // loading: every part once through the GPU (fill surfaces, heap, stones, flakes - all
  // hidden at first), so nothing is uploaded the first time a bucket fills
  warmup(on) {
    const w = this._warm || (this._warm = []);
    if (on) {
      for (const L of this.models.loads) L.warm(true);       // bucket fills, the classifier's heap (7B)
      const meshes = [this.cls.userData.conc,
        this.restPan.userData.mud, this.restPan.userData.water, this.handPan.userData.mud, this.handPan.userData.water, this.restPan.userData.riffles, this.handPan.userData.riffles,
        this.restBowl.userData.mud, this.restBowl.userData.water, this.handBowl.userData.mud, this.handBowl.userData.water,
        this.handPan.userData.sand, this.handBowl.userData.sand];                       // (phase 8: the black sand patch)
      for (const m of meshes) { w.push([m, m.visible]); m.visible = true; }
      for (const im of [this.handPan.userData.pebbles, this.handPan.userData.flakes, this.restPan.userData.pebbles, this.restPan.userData.flakes,
        this.handBowl.userData.pebbles, this.handBowl.userData.flakes, this.handPan.userData.nuggets, this.handBowl.userData.nuggets, this.restPan.userData.nuggets]) {
        w.push([im, im.visible, im.count]);
        im.count = Math.max(1, im.count);
        im.visible = true;
      }
    } else {
      for (const [m, v, c] of w) { m.visible = v; if (c != null) m.count = c; }
      w.length = 0;
      for (const L of this.models.loads) L.warm(false);
    }
  }

  // every texture of the camp's models (shown or not) - uploaded while loading
  textures() {
    return [...this.models.texs, ...this.mech.texs, ...(this._wetTex ? [this._wetTex] : [])];
  }

  // the machines' parts that only show later (the heap, foam, droplets, specks, a fill, the crates):
  // all visible, one instance each, for one pass - nothing is uploaded when they first come into view
  // (at loading; after a purchase the engine draws that pass into a single pixel - warmPending)
  warmMachines(on) {
    const w = this._warmM || (this._warmM = []);
    if (!on) {
      for (const [o, v, f, c] of w) { o.visible = v; o.frustumCulled = f; if (c != null) o.count = c; }
      w.length = 0;
      return;
    }
    const sl = this.sluice, bk = this.bulk;
    const cv = this.conveyor, tr = this.trommel, sp = this.spoil;
    const roots = [this.barrow && this.barrow.group, sl && sl.root, sl && sl.trayModel, bk && bk.root, bk && bk.rampModel, bk && bk.post, bk && bk.kit, this.feeder && this.feeder.kit,
      cv && cv.intakeModel, cv && cv.model, cv && cv.chute, cv && cv.post, cv && cv.kit, tr && tr.model, tr && tr.pile, tr && tr.kit, sp && sp.sign,
      this.excavator && this.excavator.root, this.excavator && this.excavator.stand, this.excavator && this.excavator.marks.mesh, cv && cv.gen, tr && tr.wet,
      this.prospect && this.prospect.stakes, this.prospect && this.prospect.cloths, this.loader && this.loader.root, ...this.piles.list().map((p) => p.group),
      this.washplant && this.washplant.tub, this.washplant && this.washplant.kit, this.autominer && this.autominer.root,
      ...(this.extraWarm ? this.extraWarm() : [])];
    for (const r of roots) if (r) r.traverse((o) => {
      w.push([o, o.visible, o.frustumCulled, o.isInstancedMesh ? o.count : null]);
      o.visible = true;
      o.frustumCulled = false;
      if (o.isInstancedMesh) o.count = Math.max(1, o.count);
    });
  }

  // a purchase: the thing appears on the claim
  grant(id) {
    if (!EQUIP.includes(id) || this.owned.has(id)) return false;
    this.owned.add(id);
    if (id === "bucket") this.bucket = { x: WASH.supplyDrop.x, z: WASH.supplyDrop.z, ry: 0.3, carried: false, batch: this._batch(STAGE.RAW) };
    if (id === "wheelbarrow") { this.barrow = new Wheelbarrow(this.THREE, this.scene, this.world, this.mech, null, WASH.barrowDrop); this.barrow.applyUpgrades(this.upgrades()); }
    if (id === "sluice") this.sluice = this._newSluice(null);           // delivered: boards by the tank, to be built
    if (id === "bulkhopper") this.bulk = new BulkHopper(this.THREE, this.scene, this.world, this.auto, null, this._autoCtx());     // delivered: a pallet by the sluice
    if (id === "feeder") {
      if (!this.bulk) { this.owned.delete(id); return false; }
      this.feeder = new Feeder(this.THREE, this.scene, this.world, this.auto, null, this._autoCtx());                      // delivered: a crate by the control post
    }
    if (id === "prospectkit") this.prospect = this._newProspect(null);
    if (id === "conveyor") {
      if (!this.bulk) { this.owned.delete(id); return false; }
      this.conveyor = new Conveyor(this.THREE, this.scene, this.world, this.pm, null, this._plantCtx());       // delivered: parts by the intake site
    }
    if (id === "trommel") {
      if (!this.conveyor) { this.owned.delete(id); return false; }
      this.trommel = new Trommel(this.THREE, this.scene, this.world, this.pm, null, this._trommelCtx());         // delivered: the drum on timbers by the bulk hopper
      if (!this.spoil) this.spoil = this._newSpoil(null);
    }
    if (id === "excavator" && !this.spoil) this.spoil = this._newSpoil(null);
    if (id === "excavator" && !this.excavator) this.excavator = this._newExcavator(null);                       // parked by the intake, ready
    if (id === "loader" && !this.loader) this.loader = this._newLoader(null);                                   // parked north of the raw pile, ready
    if (id === "autominer" && !this.autominer) this.autominer = this._newMiner(null);                           // parked in the north-west corner, to be set up
    if (id === "washplant") {
      if (!this.sluice) { this.owned.delete(id); return false; }
      this.washplant = this._newWashplant(null);                                                               // delivered: a crate and sheets west of the sluice
    }
    if (["wheelbarrow", "sluice", "bulkhopper", "feeder", "prospectkit", "conveyor", "trommel", "excavator", "loader", "washplant", "autominer"].includes(id)) this.warmPending = true;
    this._sync();
    return true;
  }

  applyUpgrades() {
    this._sync();
    if (this.sluice) this.sluice.applyUpgrades();
    if (this.bulk) this.bulk.applyUpgrades();
    if (this.feeder) this.feeder.applyUpgrades();
    if (this.conveyor) this.conveyor.applyUpgrades();
    if (this.trommel) this.trommel.applyUpgrades();
    if (this.washplant) this.washplant.applyUpgrades();
    if (this.excavator) this.excavator.standSync();
  }

  // the bulk hopper goes up: a barrow or bucket standing where it will stand goes to the shed
  _clearAutomationFoot() {
    const w = this.barrow, b = this.bucket;
    if (w && !w.pushing && !w.dump) {
      const c = w.trayCenter(this._tc2 || (this._tc2 = {}));
      if (inAutomationFoot(w.x, w.z) || inAutomationFoot(c.x, c.z)) this.devPlaceBarrow(WASH.barrowDrop.x, WASH.barrowDrop.z, WASH.barrowDrop.yaw);
    }
    if (b && !b.carried && inAutomationFoot(b.x, b.z)) { b.x = WASH.supplyDrop.x; b.z = WASH.supplyDrop.z; this._sync(); }
  }

  // a barrow on the platform, pointing at the bulk hopper, its tray over the rim
  _atBulkDump(w, c) {
    const bk = this.bulk;
    if (!bk || !bk.installed) return false;
    // its wheel up on the platform, pushed up against the hopper's frame (it stops there), pointing south:
    // tipped, the load goes over the rim into the funnel
    return Math.hypot(w.x - AUTO_SPOTS.dumpWheel.x, w.z - AUTO_SPOTS.dumpWheel.z) <= 0.25 && this.world.groundAt(w.x, w.z) > BULK.deckY - 0.03 && w.fwd().z > 0.8;
  }

  _placeBucket() {
    const b = this.bucket;
    if (!b || b.carried) return;
    this.worldBucket.position.set(b.x, this.world.groundAt(b.x, b.z), b.z);
    this.worldBucket.rotation.y = b.ry;
  }

  // what you wash with at the trough: the gold pan once you own one, else the wooden bowl
  washTool() { return this.owned.has("pan") && !this.devBowl ? "pan" : "bowl"; }      // devBowl: developer test only (not saved)
  // ... and what the load in it is washed with right now (a load keeps its tool)
  get washing() { return this.pan.batch.volumeMl > 0 || this.pan.batch.goldUg > 0 ? this.pan.tool : this.washTool(); }
  washName(short = false) { return this.washing === "bowl" ? (short ? "Schale" : "Waschschale") : (short ? "Pfanne" : "Goldpfanne"); }

  get carrying() { return !!(this.bucket && this.bucket.carried); }
  get bucketMl() { return this.bucket ? this.bucket.batch.volumeMl : 0; }
  get bucketKg() { return this.bucket ? this.bucket.batch.massG / 1000 : 0; }
  bucketAtWash() { const b = this.bucket; return !!(b && !b.carried && Math.hypot(b.x - WASH.bucketSpot.x, b.z - WASH.bucketSpot.z) < 0.9); }

  get pushing() { return !!(this.barrow && this.barrow.pushing); }

  // walking speed with what you carry / push (a full bucket: a little slower;
  // the barrow: by its load and the slope ahead of its wheel)
  speedFactor() {
    if (this.pushing) return this.barrow.speedFactor(this.barrow.gradeAhead());
    if (!this.carrying) return 1;
    return 1 - FULL_SLOW * Math.min(1.4, this.bucketKg / 16);
  }

  // a container at the wash place that screen and pan can take from (bucket first, then a parked barrow)
  _washSource() {
    if (this.bucketAtWash() && this.bucket.batch.volumeMl > 0) return { kind: "bucket", batch: this.bucket.batch };
    if (this.barrowAtWash() && this.barrow.batch.volumeMl > 0) return { kind: "wheelbarrow", batch: this.barrow.batch };
    return null;
  }

  // phase 7B: what to do with a barrow load rather than panning it straight (or null): the
  // sluice's hopper, the bulk hopper, the classifier - whichever is there and has room
  barrowBetter() {
    const sl = this.sluice, bk = this.bulk;
    if (bk && bk.installed && bk.buffer.room > 200) return "in den Vorratstrichter kippen";
    if (sl && sl.installed && sl.hopper.batch.volumeMl < sl.capacityMl - 200) return "in den Trichter der Waschrinne kippen";
    if (this.owned.has("classifier") && this.sieve.batch.volumeMl <= 0 && this.tub.volumeMl < TUB_ML - 500) return "erst sieben";
    return null;
  }

  barrowAtWash() {
    const w = this.barrow;
    if (!w || w.pushing) return false;
    const c = w.trayCenter(this._tw || (this._tw = {}));
    return Math.hypot(c.x - WASH.feedZone.x, c.z - WASH.feedZone.z) <= WASH.feedZone.r;
  }

  // where a dig goes: a parked barrow within reach (its tray), else the bucket - if they have room
  _digTarget(p) {
    const w = this.barrow, b = this.bucket;
    if (w && !w.pushing && !w.dump && w.batch.volumeMl < w.capacityMl) {
      const c = w.trayCenter(this._td || (this._td = {}));
      if (Math.hypot(c.x - p.x, c.z - p.z) <= BARROW_REACH) return { kind: "wheelbarrow", batch: w.batch, capacityMl: w.capacityMl };
    }
    // phase 9: standing at the intake hopper, you dig straight into it
    const cv = this.conveyor;
    if (cv && cv.installed && cv.intake.room > 50 && Math.hypot(INTAKE.x - p.x, INTAKE.z - p.z) <= INTAKE_REACH) return { kind: "intake", holder: cv.intake, room: cv.intake.room };
    if (b && !b.carried && b.batch.volumeMl < this.capacityMl && Math.hypot(b.x - p.x, b.z - p.z) <= REACH) return { kind: "bucket", batch: b.batch, capacityMl: this.capacityMl };
    return null;
  }

  // ------------------------------------------------------------ digging into the bucket

  /**
   * A dig's material (goldrush-mining.js result): into the bucket / barrow
   * when one stands within reach and has room - otherwise it is spoil.
   *   direct (no container): its visible finds are discovered now (pouch on
   *     pickup), its fine gold is lost to the spoil heap (booked)
   *   into a container: the part that fits takes its material, its fine gold
   *     AND its visible finds - they are not found now; washing / the sluice
   *     brings them out later (phase 7B: no "+ EUR" while you fill a bucket)
   *   overflow (the last dig of a full container): the part that did not fit
   *     is direct mining - its finds are discovered, its fine gold is spoil.
   * The split follows MaterialBatch.take: volume, materials and fine gold in
   * proportion, the pieces by count in the order they came (floored - one
   * piece of a dig that only half fits stays with the overflow). Exact to the
   * microgram, nothing booked twice. Returns the finds the caller discovers
   * now: { finds, count, into, intoMl, spilledMl, intoUg, intoFinds }.
   */
  collect(r, player, source) {
    const out = this._out || (this._out = { finds: [], count: 0, intoMl: 0, spilledMl: 0, intoG: 0, spilledG: 0, intoUg: 0, intoFinds: 0 });
    out.finds = r.finds; out.count = r.findCount; out.intoMl = 0; out.spilledMl = 0; out.intoG = 0; out.spilledG = 0; out.intoUg = 0; out.intoFinds = 0;
    out.into = null;
    if (!r.ok || r.kind !== "dig" || !(r.removedVolume > 0)) return out;
    const tgt = this._digTarget(player);
    const room = !tgt ? 0 : tgt.holder ? tgt.room : tgt.capacityMl - tgt.batch.volumeMl;
    if (room <= 0) { this.ledger.spoilFineUg += int(r.fineUg); return out; }
    out.into = tgt.kind;
    const dig = batchFromDig(r, source, this.nextBatch++);
    const total = dig.volumeMl;
    let part = dig;
    if (dig.volumeMl > room) part = dig.take(room, this.nextBatch++);
    this.ledger.inUg += part.goldUg; this.ledger.inFineUg += part.fineUg; this.ledger.inG += part.massG; this.ledger.inMl += part.volumeMl;
    this.ledger.inFinds += part.finds.length;
    out.intoMl = part.volumeMl; out.intoG = part.massG; out.intoUg = part.goldUg; out.intoFinds = part.finds.length;
    if (tgt.holder) { tgt.holder.put(part); this.conveyor.stats.inMl += out.intoMl; this.conveyor._fillSig = null; }
    else tgt.batch.absorb(part);
    out.finds = []; out.count = 0;
    // what did not fit spills: direct mining - its pieces are found now, its fine gold is spoil
    if (part !== dig && dig.volumeMl > 0) {
      out.spilledMl = dig.volumeMl;
      out.spilledG = dig.massG;
      this.ledger.spoilFineUg += dig.fineUg;
      const keep = new Set(dig.finds.map((f) => f.key));
      for (let i = 0; i < r.findCount; i++) if (keep.has(r.finds[i].key)) { out.finds.push(r.finds[i]); out.count++; }
    }
    if (total > 0) this._fills();
    this.fullNow = tgt.holder ? tgt.holder.room <= 50 : tgt.batch.volumeMl >= tgt.capacityMl - 50;
    this.fullKind = tgt.kind;
    return out;
  }

  // ------------------------------------------------------------ interactions

  /**
   * What the player can do here right now (prompt / E / the phone's button):
   * { id, action, short } or null. player = { x, z, yaw }
   */
  interaction(p) {
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const facing = (x, z) => { const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz) || 1; return (fx * dx + fz * dz) / d; };
    const near = (s, r) => Math.hypot(p.x - s.x, p.z - s.z) <= r;
    const b = this.bucket, w = this.barrow, sl = this.sluice;
    // 1 - pushing the wheelbarrow: tip it into the hopper, or set it down
    if (w && w.pushing) {
      if (w.dump) return null;
      const c = w.trayCenter(this._ti || (this._ti = {}));
      // Prompt 10: every receiver from one table (the bulk hopper's deck, the mountain-side intake, the sluice's
      // hopper, the stockpiles) - a full one: set the barrow down here and let the line work it off
      const R = w.batch.volumeMl > 0 ? this._barrowReceiver(w, c) : null;
      if (R) {
        if (R.room <= 200) return { id: "barrow-park", action: `Schubkarre abstellen – ${R.pile ? `${R.label} ist voll` : `der ${R.label} ist voll`}`, short: "ABSTELLEN" };
        return { id: R.act, action: `Schubkarre ${R.into} kippen`, short: "AUSKIPPEN" };
      }
      return { id: "barrow-park", action: this._atWash(c) ? "Schubkarre am Waschplatz abstellen" : "Schubkarre abstellen", short: "ABSTELLEN" };
    }
    // 2 - carrying the bucket: into the hopper / the barrow, or set it down
    const bk = this.bulk;
    // Prompt 10: the wash plant's concentrate tub - into your bucket (an empty one, or one with concentrate)
    const wpt = this.wp;
    if (wpt && near(wpt.spots.tub, 1.45) && facing(wpt.spots.tub.x, wpt.spots.tub.z) > 0.35) {
      const cb = wpt.conc.batch, l = (cb.volumeMl / 1000).toFixed(1).replace(".", ",");
      if (cb.volumeMl > 0 || cb.goldUg > 0) {
        if (!b) return { id: "conc-none", action: `Konzentratwanne · ${l} l – mit einem Eimer abholen und am Waschtrog auswaschen`, short: "", disabled: true };
        if (!b.carried) return { id: "conc-none", action: `Konzentratwanne · ${l} l – den Eimer holen und hineinfüllen`, short: "", disabled: true };
        if (b.batch.volumeMl > 0 && b.batch.stage !== STAGE.HEAVY) return { id: "conc-none", action: "Erst den Eimer leeren – Konzentrat nur in einen leeren Eimer", short: "", disabled: true };
        if (b.batch.volumeMl >= this.capacityMl - 100) return { id: "conc-none", action: "Der Eimer ist voll – zum Waschtrog tragen", short: "", disabled: true };
        return { id: "conc-bucket", action: `Konzentrat in den Eimer füllen (${l} l in der Wanne)`, short: "EINFÜLLEN" };
      }
      if (!(b && b.carried)) return { id: "conc-none", action: "Konzentratwanne – leer (Matten reinigen: Wasser aus, an den Rinnen)", short: "", disabled: true };
    }
    if (b && b.carried) {
      if (b.batch.volumeMl > 0 && bk && bk.installed && near(AUTO_SPOTS.bucket, 0.9) && this.world.groundAt(p.x, p.z) > BULK.deckY - 0.15 && facing(BULK_AT.x, BULK_AT.z) > 0.5) {
        if (bk.buffer.room <= 200) return { id: "bulk-full", action: "Der Vorratstrichter ist voll", short: "", disabled: true };
        return { id: "bucket-bulk", action: "Eimer in den Vorratstrichter kippen", short: "KIPPEN" };
      }
      const cvb = this.conveyor;
      if (b.batch.volumeMl > 0 && cvb && cvb.installed && near(INTAKE, 1.6)) {
        if (cvb.intake.room <= 200) return { id: "intake-full", action: "Der Aufgabetrichter ist voll", short: "", disabled: true };
        return { id: "bucket-intake", action: "Eimer in den Aufgabetrichter kippen", short: "KIPPEN" };
      }
      if (b.batch.volumeMl > 0 && sl && sl.installed && near(this._slSpots().feed, 1.5)) {
        if (sl.hopper.batch.volumeMl >= sl.capacityMl - 200) return { id: "hopper-full", action: this.wp ? "Der Verteilerkasten ist voll" : "Der Trichter ist voll", short: "", disabled: true };
        return { id: "bucket-hopper", action: this.wp ? "Eimer in den Verteilerkasten kippen" : "Eimer in den Trichter kippen", short: "KIPPEN" };
      }
      if (b.batch.volumeMl > 0 && w && !w.pushing && w.batch.volumeMl < w.capacityMl - 200) {
        const c = w.trayCenter(this._ti || (this._ti = {}));
        if (Math.hypot(c.x - p.x, c.z - p.z) <= 1.7) return { id: "bucket-barrow", action: "Eimer in die Schubkarre kippen", short: "KIPPEN" };
      }
      if (near(WASH.bucketSpot, 2.4)) return { id: "bucket-wash", action: "Eimer am Waschplatz abstellen", short: "ABSTELLEN" };
      return { id: "bucket-drop", action: "Eimer abstellen", short: "ABSTELLEN" };
    }
    // 3x - phase 9: the excavator - get in at the cab (its left side)
    const ex = this.excavator;
    if (ex && !ex.inCab && Math.hypot(ex.x - p.x, ex.z - p.z) < 2.3) {
      const c = Math.cos(ex.heading), s = Math.sin(ex.heading), dx = ex.x - s * 0.4 - p.x, dz = ex.z - c * 0.4 - p.z;      // (the cab: its left side)
      if (facing(ex.x, ex.z) > 0.45 && Math.hypot(dx, dz) < 2.1) return { id: "exc-enter", action: ex.volumeMl > 0 ? `In den Bagger steigen (Löffel ${Math.round(ex.volumeMl / 1000)} l)` : "In den Bagger steigen", short: "EINSTEIGEN" };
    }
    // 3l - Prompt 10: the wheel loader - get in at its steps (the cab's left side)
    const ld = this.loader;
    if (ld && !ld.inCab && Math.hypot(ld.x - p.x, ld.z - p.z) < 3.0) {
      const c = Math.cos(ld.heading), s = Math.sin(ld.heading), dx = ld.x - c * 0.4 - s * 0.9 - p.x, dz = ld.z + s * 0.4 - c * 0.9 - p.z;      // (the cab's left side)
      if (facing(ld.x - c * 0.4, ld.z + s * 0.4) > 0.4 && Math.hypot(dx, dz) < 2.2) return { id: "ldr-enter", action: ld.volumeMl > 0 ? `In den Radlader steigen (Schaufel ${Math.round(ld.volumeMl / 1000)} l)` : "In den Radlader steigen", short: "EINSTEIGEN" };
    }
    // 3m - Prompt 10: the automatic hillside miner - set it up (delivered), switch it on / off at its panel, move it
    const am = this.autominer;
    if (am && am.status !== "placing" && Math.hypot(am.x - p.x, am.z - p.z) < 3.6) {
      const F = am._frame(), pan = F.at(AM.panel[0], AM.panel[1] - 0.4), rear = F.at(-1.85, 0);
      if (!am.placed) { if (facing(am.x, am.z) > 0.3) return { id: "miner-place", action: "Abbaugerät aufstellen – Platz an der Bergflanke wählen", short: "AUFSTELLEN" }; }
      else if (near(pan, 1.35) && facing(am.x, am.z) > 0.1) {
        if (am.status === "exhausted" || am.status === "rock") return { id: "miner-move", action: `${MINER_STATUS[am.status]} – Abbaugerät versetzen`, short: "VERSETZEN" };
        return am.on ? { id: "miner-off", action: `Abbaugerät anhalten (${am.statusText()})`, short: "AUS" } : { id: "miner-on", action: `Abbaugerät starten${am.volumeMl > 0 ? ` (Band ${Math.round(am.volumeMl / 1000)} l)` : ""}`, short: "START" };
      } else if (!am.on && near(rear, 1.7) && facing(am.x, am.z) > 0.2) return { id: "miner-move", action: "Abbaugerät versetzen", short: "VERSETZEN" };
    }
    // 3w - Prompt 10: the wash plant's delivery - build it
    const wpk = this.washplant;
    if (wpk && !wpk.installed && wpk.build < 0 && near(wpk.spots.kit, 2.0) && facing(wpk.spots.kit.x, wpk.spots.kit.z) > 0.3) {
      if (!sl || !sl.installed) return { id: "washplant-wait", action: "Erst die Waschrinne aufbauen", short: "", disabled: true };
      return { id: "washplant-build", action: "Waschanlage aufbauen (Verteilerkasten, zwei weitere Rinnen)", short: "AUFBAUEN" };
    }
    // 3p - phase 9: the plant - build the conveyor / the trommel, the lever at the intake's post, the oversize pile
    const cv = this.conveyor, tr = this.trommel;
    if (cv) {
      const atPost = near(INTAKE_SPOT, 0.95) && facing(INTAKE_SPOT.x, INTAKE_SPOT.z + 0.7) > 0.5;
      if (!cv.installed) {
        if (cv.build < 0 && (atPost || (near(CONVEYOR_KIT, 1.8) && facing(CONVEYOR_KIT.x, CONVEYOR_KIT.z) > 0.3))) return { id: "conveyor-build", action: "Aufgabetrichter und Förderband aufbauen", short: "AUFBAUEN" };
      } else if (atPost) {
        const nx = cv.nextMode();
        return { id: "conveyor-mode", action: nx === "auto" ? "Förderband auf AUTO – läuft, solange das Wasser der Rinne an ist" : nx === "on" ? "Förderband einschalten (AN)" : "Förderband ausschalten", short: nx === "auto" ? "AUTO" : nx === "on" ? "START" : "STOP" };
      }
    }
    if (tr && !tr.installed && tr.build < 0 && near(TROMMEL_KIT, 1.9) && facing(TROMMEL_KIT.x, TROMMEL_KIT.z) > 0.3) return { id: "trommel-build", action: "Trommelsieb aufbauen", short: "AUFBAUEN" };
    // Prompt 10: the trommel's nugget trap - what was too big for the screen waits in it
    if (tr && tr.trap.length && near(TRAP, 1.9) && facing(TRAP.x, TRAP.z) > 0.3) return { id: "trommel-trap", action: tr.trap.length > 1 ? `Nuggetfalle leeren – ${tr.trap.length} große Nuggets` : "Nuggetfalle leeren – ein großer Nugget", short: "HERAUSNEHMEN" };
    const opk = tr && tr.installed && tr.overMl > 2000 && tr.pileRef ? tr.pileRef.peak() : null;      // (Prompt 10: wherever the pile stands now - at the stacker's head)
    if (opk && tr.pileRef.inside(p.x, p.z, 1.4) && Math.hypot(opk.x - p.x, opk.z - p.z) < 3.2 && facing(opk.x, opk.z) > 0.3) {
      const wpk = w && !w.pushing && !w.dump ? w.trayCenter(this._ti || (this._ti = {})) : null;
      if (wpk && Math.hypot(wpk.x - p.x, wpk.z - p.z) <= 2.6 && w.batch.volumeMl < w.capacityMl - 500) return { id: "oversize-barrow", action: `Überkorn in die Schubkarre schaufeln (${(tr.overMl / 1e6).toFixed(2).replace(".", ",")} m³ auf dem Haufen)`, short: "AUFLADEN" };
      return { id: "oversize-none", action: "Überkornhaufen – stell die Schubkarre daneben, um ihn abzutragen", short: "", disabled: true };
    }
    // 3a - the automation: build the bulk hopper, mount the feeder, the lever / the hand gate
    if (bk) {
      const atPost = near(AUTO_SPOTS.control, 0.95) && facing(AUTO_SPOTS.post.x, AUTO_SPOTS.post.z) > 0.5;
      if (!bk.installed) {
        if (bk.build < 0 && (atPost || (near(BULK_KIT, 1.7) && facing(BULK_KIT.x, BULK_KIT.z) > 0.3))) return { id: "bulk-build", action: "Vorratstrichter aufbauen", short: "AUFBAUEN" };
      } else if (atPost) {
        const fd = this.feeder;
        if (fd && !fd.installed) return fd.build < 0 ? { id: "feeder-mount", action: "Dosierer montieren", short: "MONTIEREN" } : null;
        if (fd) { const nx = fd.nextMode(); return { id: "feeder-mode", action: MODE_TEXT[nx], short: MODE_SHORT[nx] }; }
        if (bk.gateOpen) return { id: "gate-busy", action: "Der Schieber ist offen – es rutscht nach", short: "", disabled: true };
        if (bk.volumeMl <= 0) return { id: "gate-none", action: "Der Vorratstrichter ist leer", short: "", disabled: true };
        if (!sl || !sl.installed) return { id: "gate-none", action: "Erst die Waschrinne aufbauen", short: "", disabled: true };
        if (roomOf(sl.hopper) <= 0) return { id: "gate-none", action: "Der Trichter der Rinne ist voll", short: "", disabled: true };
        return { id: "bulk-gate", action: "Schieber ziehen – Trichter der Rinne füllen", short: "SCHIEBER" };
      }
    }
    // 3 - the sluice: build it, water on / off, clean the riffles out
    if (sl) {
      const SP = this._slSpots(), wpp = this.wp;
      if (!sl.installed) {
        if (sl.build < 0 && (near(SLUICE_SPOTS.feed, 1.7) || near(SLUICE_SPOTS.clean, 1.7))) return { id: "sluice-build", action: "Waschrinne aufbauen", short: "AUFBAUEN" };
      } else if (near(SP.feed, 1.3) && facing(SP.hopper.x, SP.hopper.z) > 0.3) {
        if (sl.running) return { id: "sluice-stop", action: "Wasser abstellen", short: "WASSER AUS" };
        return { id: "sluice-start", action: sl.hopper.batch.volumeMl > 0 ? (wpp ? "Wasser anstellen – die Waschanlage wäscht" : "Wasser anstellen – die Rinne wäscht") : "Wasser anstellen", short: "WASSER AN" };
      } else if (near(SP.clean, 1.3) && facing(SP.cleanLook.x, SP.cleanLook.z) > 0.3) {
        if (sl.running) return { id: "sluice-stop", action: "Wasser abstellen (zum Reinigen)", short: "WASSER AUS" };
        if (wpp && wpp.tubFull) return { id: "sluice-empty", action: "Die Konzentratwanne ist voll – erst in den Eimer füllen", short: "", disabled: true };
        if (sl.canClean()) return { id: "sluice-clean", action: wpp ? (sl.riffleLoad >= 1 ? "Matten aller drei Rinnen reinigen – sie sind voll" : "Matten aller drei Rinnen reinigen") : sl.riffleLoad >= 1 ? "Riffelmatte reinigen – sie ist voll" : "Riffelmatte reinigen", short: "REINIGEN" };
        return { id: "sluice-empty", action: "In den Riffeln liegt noch nichts", short: "", disabled: true };
      }
    }
    // 4 - washing at the trough: the gold pan, or before it the wooden wash bowl that is always
    // there (heavy concentrate, the tub, a bucket or a barrow at the wash place)
    if (near(WASH.panSpot, USE_R) && facing(WASH.trough.x, WASH.panSpot.z) > 0.3) {
      const T = this.washName();
      if (this.pan.batch.volumeMl > 0 || this.pan.batch.goldUg > 0) return { id: "pan-work", action: this.pan.sample ? `Probe ${this.pan.sample.n} weiter auswaschen` : "Weiter waschen", short: "WASCHEN" };
      // phase 9: sample bags - a quick test pan each, the result into the notebook
      const pg = this.prospect;
      if (pg && pg.count > 0 && this.washTool() === "pan") return { id: "pan-sample", action: `Probe ${pg.nextBag().n} auswaschen (${pg.count} ${pg.count === 1 ? "Beutel" : "Beutel"})`, short: "PROBE" };
      if (sl && (sl.tray.batch.volumeMl > 0 || sl.tray.batch.goldUg > 0)) return { id: "pan-fill", action: `Mit ${T} waschen – Schwerkonzentrat aus der Rinne`, short: "WASCHEN" };
      if (this.tub.volumeMl > 0) return { id: "pan-fill", action: `Mit ${T} waschen – Konzentrat aus der Wanne`, short: "WASCHEN" };
      const src = this._washSource();
      // phase 7B: a barrow load is best sieved / sluiced first - straight into the pan stays possible
      // (a secondary choice, never locked), the prompt names the better way
      if (src && src.kind === "wheelbarrow") {
        const better = this.barrowBetter();
        return { id: "pan-fill", action: better ? `Mit ${T} direkt aus der Schubkarre waschen (besser: ${better})` : `Mit ${T} waschen – aus der Schubkarre`, short: "WASCHEN", secondary: !!better };
      }
      if (src) return { id: "pan-fill", action: `Mit ${T} waschen`, short: "WASCHEN" };
      if (!this.bucket) return { id: "pan-none", action: "Waschschale – mit einem Eimer kannst du hier Erde waschen", short: "", disabled: true };
      if (!(b && b.batch.volumeMl > 0)) return { id: "pan-none", action: "Erst Erde im Eimer herbringen", short: "", disabled: true };
      return { id: "pan-none", action: "Den Eimer hier am Waschplatz abstellen", short: "", disabled: true };
    }
    // 5 - the classifier
    if (this.owned.has("classifier") && near(WASH.sieveSpot, USE_R) && facing(WASH.classifier.x, WASH.sieveSpot.z) > 0.3) {
      if (this.sieve.batch.volumeMl > 0) return { id: "sieve-work", action: "Weiter sieben", short: "SIEBEN" };
      const src = this._washSource();
      if (src) {
        if (this.tub.volumeMl >= TUB_ML - 500) return { id: "sieve-full", action: "Die Wanne ist voll – erst waschen", short: "", disabled: true };
        return { id: "sieve-load", action: src.kind === "wheelbarrow" ? "Aus der Schubkarre aufs Sieb schaufeln" : "Eimer aufs Sieb kippen", short: "SIEBEN" };
      }
      return { id: "sieve-none", action: "Erst einen vollen Eimer herbringen", short: "", disabled: true };
    }
    // 6 - pick up the bucket / take the barrow by its grips: the nearer one you face
    let best = null, bestD = Infinity;
    if (b && near(b, PICK_R) && facing(b.x, b.z) > 0.55) {
      const l = (b.batch.volumeMl / 1000).toFixed(1).replace(".", ",");
      best = { id: "bucket-pick", action: `Eimer aufnehmen (${l} l)`, short: "AUFNEHMEN" };
      bestD = Math.hypot(b.x - p.x, b.z - p.z);
    }
    if (w && !w.dump) {
      const gc = w.gripsCenter(this._tg || (this._tg = {})), d = Math.hypot(gc.x - p.x, gc.z - p.z);
      const behind = (-Math.sin(w.yaw)) * fx + (-Math.cos(w.yaw)) * fz;          // you look the way it points
      if (d < 1.25 && behind > 0.45 && d < bestD) {
        const l = Math.round(w.batch.volumeMl / 1000);
        best = { id: "barrow-take", action: `Schubkarre greifen${l ? ` (${l} l)` : ""}`, short: "GREIFEN" };
      }
    }
    return best;
  }

  _atWash(c) { return Math.hypot(c.x - WASH.feedZone.x, c.z - WASH.feedZone.z) <= WASH.feedZone.r; }

  /**
   * Do it. -> a short result for the HUD / sounds:
   * { ok, kind: "pick" | "drop" | "work" | ..., text }
   */
  act(id, player, ground) {
    const b = this.bucket;
    // Prompt 10: the automatic hillside miner - set up / move (the engine's placement mode), on / off
    const am = this.autominer;
    if ((id === "miner-place" || id === "miner-move") && am) { am.unplace(); return { ok: true, kind: "place", what: "autominer", moving: am.placed }; }
    if (id === "miner-on" && am) return am.setOn(true) ? { ok: true, kind: "mode", what: "autominer", on: true } : { ok: true, kind: "minerStatus", status: am.status };
    if (id === "miner-off" && am) { am.setOn(false); return { ok: true, kind: "mode", what: "autominer", on: false }; }
    if (id === "bucket-pick" && b && !b.carried) {
      b.carried = true;
      this._sync();
      return { ok: true, kind: "pick" };
    }
    if ((id === "bucket-drop" || id === "bucket-wash") && b && b.carried) {
      if (id === "bucket-wash") { b.x = WASH.bucketSpot.x; b.z = WASH.bucketSpot.z; b.ry = 0.4; this.ledger.buckets += b.batch.volumeMl > 0 ? 1 : 0; }
      else {
        const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw), rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
        b.x = player.x + fx * 0.6 + rx * 0.35; b.z = player.z + fz * 0.6 + rz * 0.35; b.ry = player.yaw;
      }
      b.carried = false;
      this._sync();
      return { ok: true, kind: "drop" };
    }
    const w = this.barrow, sl = this.sluice;
    if (id === "barrow-take" && w && !w.pushing && !(b && b.carried)) { w.take(); this._sync(); return { ok: true, kind: "barrow" }; }
    if (id === "barrow-park" && w && w.pushing) { w.park(); this._sync(); return { ok: true, kind: "drop" }; }
    // Prompt 10: tipping the barrow - whatever receiver the table names for this station (one path for all of
    // them: the barrow's own transfer at the top of its tilt, partial when full; a pile through a pass-through bin)
    if (w && w.pushing && (id === "barrow-dump" || id === "bulk-dump" || id === "intake-dump" || id === "spoil-dump" || id.startsWith("pile-dump:"))) {
      const R = this.receivers().find((r) => r.act === id);
      if (!R) return { ok: false };
      let ok;
      if (R.pile) {
        const bin = this._pileBin || (this._pileBin = new MaterialBuffer({ capacityMl: 1e12 })), c = w.trayCenter(this._tc3 || (this._tc3 = {})), at = { x: c.x, z: c.z };
        ok = w.startDump(bin, (ml) => { R.pile.dumpFrom(bin, Infinity, at.x, at.z, 0.55); R.done(ml); }, this.nextBatch++);
      } else ok = w.startDump(R.holder, (ml) => R.done(ml), this.nextBatch++);
      return ok ? { ok: true, kind: "dump" } : { ok: false };
    }
    const bk = this.bulk, fd = this.feeder;
    if (id === "bucket-bulk" && b && b.carried && bk && bk.installed) {
      const ml = bk.pourIn({ batch: b.batch, capacityMl: this.capacityMl });
      this._fills();
      return ml > 0 ? { ok: true, kind: "feed", ml, into: "bulk" } : { ok: false };
    }
    if (id === "bulk-build" && bk) { const ok = bk.startBuild(); if (ok) this._clearAutomationFoot(); return ok ? { ok: true, kind: "build", what: "bulk" } : { ok: false }; }
    // phase 9: the plant
    const cv = this.conveyor, tr = this.trommel;
    if (id === "bucket-intake" && b && b.carried && cv && cv.installed) {
      const ml = cv.pourIn({ batch: b.batch, capacityMl: this.capacityMl });
      this._fills();
      return ml > 0 ? { ok: true, kind: "feed", ml, into: "intake" } : { ok: false };
    }
    if (id === "exc-enter" && this.excavator) return { ok: true, kind: "enter" };
    if (id === "ldr-enter" && this.loader) return { ok: true, kind: "enter", machine: "loader" };
    if (id === "conveyor-build" && cv) return cv.startBuild() ? { ok: true, kind: "build", what: "conveyor" } : { ok: false };
    if (id === "conveyor-mode" && cv && cv.installed) { cv.setMode(cv.nextMode()); return { ok: true, kind: "mode", mode: cv.mode, what: "conveyor" }; }
    if (id === "trommel-build" && tr) return tr.startBuild() ? { ok: true, kind: "build", what: "trommel" } : { ok: false };
    if (id === "trommel-trap" && tr && tr.trap.length) {
      const got = this.economy.recover(0, tr.takeTrap());
      this.ledger.recoveredUg += got.ug;
      return { ok: true, kind: "trap", got };
    }
    if (id === "oversize-barrow" && tr && w && !w.pushing) {
      const ml = tr.takeOversize(w, w.capacityMl - w.batch.volumeMl);
      return ml > 0 ? { ok: true, kind: "load", ml } : { ok: false };
    }
    if (id === "feeder-mount" && fd) return fd.startMount() ? { ok: true, kind: "build", what: "feeder" } : { ok: false };
    if (id === "feeder-mode" && fd && fd.installed) { fd.setMode(fd.nextMode()); return { ok: true, kind: "mode", mode: fd.mode }; }
    if (id === "bulk-gate" && bk) return bk.openGate() ? { ok: true, kind: "gate" } : { ok: false };
    if (id === "bucket-hopper" && b && b.carried && sl && sl.installed) {
      const ml = pour({ batch: b.batch }, sl.hopper, Infinity, this.nextBatch++);
      this._fills();
      return ml > 0 ? { ok: true, kind: "feed", ml } : { ok: false };
    }
    if (id === "bucket-barrow" && b && b.carried && w) {
      const ml = pour({ batch: b.batch }, w, Infinity, this.nextBatch++);
      this._fills();
      return ml > 0 ? { ok: true, kind: "feed", ml } : { ok: false };
    }
    if (id === "sluice-build" && sl) return sl.startBuild() ? { ok: true, kind: "build" } : { ok: false };
    if ((id === "sluice-start" || id === "sluice-stop") && sl) return sl.setWater(id === "sluice-start") ? { ok: true, kind: "water", on: sl.running } : { ok: false };
    if (id === "sluice-clean" && sl && sl.canClean()) { this.startWork("clean"); return { ok: true, kind: "work" }; }
    const wpa = this.washplant;
    if (id === "washplant-build" && wpa) return wpa.startBuild() ? { ok: true, kind: "build", what: "washplant" } : { ok: false };
    if (id === "conc-bucket" && wpa && this.bucket && this.bucket.carried) {
      const ml = wpa.toBucket({ batch: this.bucket.batch, capacityMl: this.capacityMl });
      this._fills();
      return ml > 0 ? { ok: true, kind: "conc", ml, left: wpa.conc.batch.volumeMl } : { ok: false };
    }
    if (id === "pan-fill") return this.fillPan() ? { ok: true, kind: "work" } : { ok: false };
    if (id === "pan-sample") return this.fillPanSample() ? { ok: true, kind: "work" } : { ok: false };
    if (id === "pan-work") { this.startWork("pan"); return { ok: true, kind: "work" }; }
    if (id === "sieve-load") return this.loadSieve() ? { ok: true, kind: "work" } : { ok: false };
    if (id === "sieve-work") { this.startWork("sieve"); return { ok: true, kind: "work" }; }
    return { ok: false };
  }

  // tip the bucket out where you stand (poor ground you do not want to wash):
  // the material and its gold go to the tailings - booked, nothing vanishes
  emptyBucket() {
    const b = this.bucket;
    if (!b || b.batch.volumeMl <= 0) return false;
    const L = this.ledger;
    L.tailUg += b.batch.goldUg; L.tailG += b.batch.massG; L.tailMl += b.batch.volumeMl;
    b.batch = this._batch(STAGE.RAW);
    this._fills();
    return true;
  }

  // ---- developer tools only (goldrush-devactions.js) - never called by the game.
  // Test material comes from outside the mountain (source "dev"): it is booked
  // as input like a dig, what it replaces goes to the tailings - so the ledger
  // stays exact (in == containers + recovered + tailings) in a test mine too.
  _devIn(batch) {
    const L = this.ledger;
    L.inUg += batch.goldUg; L.inFineUg += batch.fineUg; L.inG += batch.massG; L.inMl += batch.volumeMl; L.inFinds += batch.finds.length;
    L.devInUg = (L.devInUg || 0) + batch.goldUg;
  }

  _devTail(batch) {
    const L = this.ledger;
    L.tailUg += batch.goldUg; L.tailG += batch.massG; L.tailMl += batch.volumeMl;
  }

  // the bucket's whole content becomes `batch` (null = empty)
  devSetBucket(batch) {
    const b = this.bucket;
    if (!b || (batch && batch.volumeMl > this.capacityMl)) return false;
    this._devTail(b.batch);
    b.batch = batch || this._batch(STAGE.RAW);
    if (batch) { batch.id = this.nextBatch++; this._devIn(batch); }
    this._fills();
    return true;
  }

  // a load straight into the (empty) pan, ready to swirl at the trough
  devPanLoad(batch) {
    if (!this.owned.has("pan") || this.work || this.pan.batch.volumeMl > 0 || this.pan.batch.goldUg > 0) return false;
    batch.id = this.nextBatch++;
    this._devIn(batch);
    this.pan.batch = batch;
    this.pan.progress = 0;
    this.panDone = false;
    this.reveal = null;
    this._fills();
    return true;
  }

  // put the bucket down somewhere (out of the hands)
  devPlaceBucket(x, z, ry = 0.4) {
    const b = this.bucket;
    if (!b || this.work) return false;
    b.carried = false; b.x = x; b.z = z; b.ry = ry;
    this._sync();
    return true;
  }

  // forget the tailings so far (the numbers and the stone heap) - in and out together
  devClearTailings() {
    const L = this.ledger;
    L.inUg = Math.max(0, L.inUg - L.tailUg); L.inG = Math.max(0, L.inG - L.tailG); L.inMl = Math.max(0, L.inMl - L.tailMl);
    L.tailUg = 0; L.tailG = 0; L.tailMl = 0;
    this.sieve.stones = 0; this.sieve.dumpT = 0;
    this._fills();
  }

  // a piece of equipment goes away again (its content to the tailings)
  devRemove(id) {
    if (!this.owned.has(id)) return false;
    if (this.work) this.stopWork();
    if (id === "bucket" && this.bucket) { this._devTail(this.bucket.batch); this.bucket = null; }
    if (id === "wheelbarrow" && this.barrow) { this._devTail(this.barrow.batch); this.barrow.dispose(this.scene); this.barrow = null; }
    if (id === "bulkhopper" && this.owned.has("feeder")) this.devRemove("feeder");
    if (id === "feeder" && this.feeder) { for (const l of this.feeder.tray.layers) this._devTail(l); this.feeder.dispose(this.scene); this.feeder = null; }
    if (id === "bulkhopper" && this.bulk) { for (const l of this.bulk.buffer.layers) this._devTail(l); this.bulk.dispose(this.scene); this.bulk = null; }
    if (id === "sluice" && this.owned.has("washplant")) this.devRemove("washplant");
    if (id === "washplant" && this.washplant) {
      const wp = this.washplant;
      for (let i = 1; i < wp.lanes.length; i++) this._devTail(wp.lanes[i].riffles);
      this._devTail(wp.conc.batch);
      wp.dispose(); this.washplant = null;
      if (this.sluice) { this.sluice.applyUpgrades(); this.sluice._sync(); }
      if (this.feeder) this.feeder.applyUpgrades();
    }
    if (id === "sluice" && this.sluice) {
      const sl = this.sluice;
      this._devTail(sl.hopper.batch); this._devTail(sl.riffles); this._devTail(sl.tray.batch);
      sl.dispose(this.scene); this.sluice = null;
    }
    if (id === "pan") { this._devTail(this.pan.batch); this.pan.batch = this._batch(STAGE.RAW); this.pan.progress = 0; this.pan.sample = null; this.panDone = false; this.reveal = null; }
    if (id === "prospectkit" && this.prospect) { for (const b of this.prospect.bags) this._devTail(b.batch); this.prospect.dispose(); this.prospect = null; }
    if (id === "conveyor" && this.owned.has("trommel")) this.devRemove("trommel");
    if (id === "bulkhopper" && this.owned.has("conveyor")) this.devRemove("conveyor");
    if (id === "trommel" && this.trommel) {
      // what the trommel itself holds (Prompt 10: the oversize lies on its stockpile - that stays; the stacker, the trap go)
      const tr = this.trommel;
      for (const l of [...tr.feed.layers, ...tr.overIn.layers, ...tr._overBin.layers]) this._devTail(l);
      for (const c of tr.overBelt.cells) if (c) this._devTail(c);
      this.ledger.tailUg += tr.trapUg;
      tr.dispose(); this.trommel = null; if (this.conveyor) this.conveyor._sync();
    }
    if (id === "conveyor" && this.conveyor) { for (const l of this.conveyor.intake.layers) this._devTail(l); for (const c of this.conveyor.belt.cells) if (c) this._devTail(c); this.conveyor.dispose(); this.conveyor = null; }
    if (id === "excavator" && this.excavator) { this._devTail(this.excavator.bucket.batch); this.excavator.dispose(); this.excavator = null; }
    if ((id === "excavator" || id === "trommel") && this.spoil && !(this.owned.has("excavator") && id !== "excavator") && !(this.owned.has("trommel") && id !== "trommel")) { this.spoil.dispose(); this.spoil = null; }
    if (id === "classifier") {
      this._devTail(this.sieve.batch); this._devTail(this.tub);
      this.sieve.batch = this._batch(STAGE.RAW); this.sieve.progress = 0; this.sieve.stones = 0;
      this.tub = this._batch(STAGE.CONCENTRATE);
    }
    this.owned.delete(id);
    this._sync();
    this._refitBarrow();
    return true;
  }

  // the barrow's whole content becomes `batch` (null = empty)
  devSetBarrow(batch) {
    const w = this.barrow;
    if (!w || (batch && batch.volumeMl > w.capacityMl)) return false;
    this._devTail(w.batch);
    w.batch = batch || this._batch(STAGE.RAW);
    if (batch) { batch.id = this.nextBatch++; this._devIn(batch); }
    return true;
  }

  devPlaceBarrow(x, z, yaw) {
    const w = this.barrow;
    if (!w || w.dump) return false;
    if (w.pushing) w.park();
    w.x = x; w.z = z; w.yaw = yaw;
    w.park();
    return true;
  }

  // the sluice: hopper content (null = empty), riffles loaded up to the clean-out point
  devSetHopper(batch) {
    const sl = this.sluice;
    if (!sl || (batch && batch.volumeMl > sl.capacityMl)) return false;
    this._devTail(sl.hopper.batch);
    sl.hopper.batch = batch || this._batch(STAGE.RAW);
    if (batch) { batch.id = this.nextBatch++; this._devIn(batch); }
    return true;
  }

  devInstallSluice() { const sl = this.sluice; if (!sl) return false; sl.state = "ready"; sl.build = -1; sl._sync(); return true; }

  // Prompt 10: a pile's content becomes `batch` (null = empty), dropped load by load round its drop point (a real
  // pile shape, not one cone); a tailings / spoil pile books it as tailings like any dump does
  devSetPile(id, batch, spread = 1) {
    const P = this.piles.get(id);
    if (!P) return false;
    if (!P.def.tail) for (const l of P.buffer.layers) this._devTail(l);
    P.buffer.layers = [];
    P.h.fill(0);
    P.fit();
    P.dirty = true;
    if (batch && batch.volumeMl > 0) {
      batch.id = this.nextBatch++;
      this._devIn(batch);
      const n = Math.max(1, Math.min(80, Math.round(batch.volumeMl / 60000))), d = P.site.drop;
      for (let k = 0; k < n; k++) {
        const part = k === n - 1 ? batch : batch.take(Math.round(batch.volumeMl / (n - k)), this.nextBatch++);
        const a = k * 2.39996, r = spread * (0.2 + 1.1 * ((k * 0.618) % 1));
        P.dump(part, d.x + Math.cos(a) * r, d.z + Math.sin(a) * r * 0.8, 0.45);
        if (k % 10 === 9) P.relax(30000);
      }
      P.settle();
    }
    P._redraw && P._redraw();
    return true;
  }

  // the loader's bucket becomes `batch` (null = empty)
  devSetLoader(batch) {
    const ld = this.loader;
    if (!ld || ld.task || (batch && batch.volumeMl > ld.bucket.capacityMl)) return false;
    this._devTail(ld.bucket.batch);
    ld.bucket.batch = batch || this._batch(STAGE.RAW);
    if (batch) { batch.id = this.nextBatch++; this._devIn(batch); }
    ld._load();
    return true;
  }

  // the wash plant's concentrate tub becomes `batch` (heavy concentrate; null = empty)
  devSetConc(batch) {
    const wp = this.washplant;
    if (!wp) return false;
    this._devTail(wp.conc.batch);
    wp.conc.batch = batch || this._batch(STAGE.HEAVY);
    wp.conc.batch.stage = STAGE.HEAVY;
    if (batch) { batch.id = this.nextBatch++; this._devIn(batch); }
    wp._tubSig = null;
    return true;
  }

  // the outlet pile up to the lanes' ends (the plant backs up) - washed sand, booked as tailings
  devFillOutlet() {
    const out = this.piles.get("tailOut"), wp = this.washplant;
    if (!out) return false;
    const lanes = wp ? wp.lanes.map((l, i) => wp.outlet(i)) : [{ x: SLUICE_AT.x + 2.9, z: SLUICE_AT.z }];
    // (settled every few loads: what counts is the settled pile at each lane's end - as the running plant sees it)
    for (let k = 0; k < 900; k++) {
      const o = lanes[k % lanes.length], b = this._batch(STAGE.TAILINGS);
      b.volumeMl = 20000; b.comp = [8000, 4000, 22000, 0]; b.fineUg = 200;
      this._devIn(b);
      const a = k * 2.39996;
      out.dump(b, o.x + 0.2 + Math.cos(a) * 0.2, o.z + Math.sin(a) * 0.2, 0.3);
      if (k % 12 === 11) { out.settle(); if (lanes.every((q) => out.thickAt(q.x, q.z) >= WP.outletH + 0.03)) break; }
    }
    out.settle();
    return true;
  }

  // benchmark (tests/e2e/goldrush_bench.js): one loader load from a pile into the intake / onto another pile - the
  // material moves exactly as the loader's own take and pour do (the bot pays the time a real cycle takes)
  benchLoaderMove(fromId, to, maxMl = 260000, by = "loader") {
    const P = this.piles.get(fromId), ld = by === "loader" ? this.loader : null;
    if (!P || (by === "loader" && !ld) || P.volumeMl <= 0) return 0;
    const bin = this._benchBin || (this._benchBin = new MaterialBuffer({ capacityMl: 1e12 }));
    let want = maxMl;
    if (to === "intake") { const cv = this.conveyor; if (!cv || !cv.installed) return 0; want = Math.min(want, cv.intake.room); }
    for (let k = 0; k < 8 && want - bin.volumeMl > 500 && P.volumeMl > 0; k++) {
      const pk = P.peak(), a = k * 1.7;
      const got = P.cut(pk.x - Math.cos(a) * 0.6, pk.z - Math.sin(a) * 0.6, Math.cos(a), Math.sin(a), 0.9, 2.2, -Infinity, want - bin.volumeMl);
      if (got.volumeMl <= 0 && got.goldUg <= 0) continue;
      putInto(bin, got);
    }
    const ml = bin.volumeMl;
    if (ml <= 0) { this._benchFlush(bin, P); return 0; }
    if (ld) { ld.stats.takes++; ld.stats.tookMl += ml; }
    if (to === "intake") {
      const cv = this.conveyor, moved = transfer(bin, cv.intake, Infinity, this.nextBatch++);
      cv.stats.inMl += moved; cv.stats.loads++; cv._fillSig = null; if (ld) ld.stats.intakeMl += moved;
    } else {
      const Q = this.piles.get(to.replace("pile:", "")), d = Q.site.drop, j = (this._bj = ((this._bj || 0) + 1) % 997), a = j * 2.39996, r = 0.3 + 1.4 * ((j * 0.618) % 1);
      Q.dumpFrom(bin, Infinity, d.x + Math.cos(a) * r, d.z + Math.sin(a) * r * 0.8, 0.5);
    }
    this._benchFlush(bin, P);
    return ml;
  }

  // (what did not fit goes back where it came from - nothing stays in the pass-through bin)
  _benchFlush(bin, P) {
    if (bin.volumeMl > 0 || bin.goldUg > 0) { const d = P.site.drop; P.dumpFrom(bin, Infinity, d.x, d.z, 0.6); }
  }

  // benchmark: the excavator's bucket onto a pile (round its drop point)
  benchExcToPile(id) {
    const ex = this.excavator, P = this.piles.get(id);
    if (!ex || !P || ex.task || ex.volumeMl <= 0) return 0;
    const d = P.site.drop, j = (this._ej = ((this._ej || 0) + 1) % 997), a = j * 2.39996, r = 0.3 + 1.6 * ((j * 0.618) % 1);
    const res = ex._tip({ kind: "pile", id, at: { x: d.x + Math.cos(a) * r, z: d.z + Math.sin(a) * r * 0.8 } });
    return res && res.ok ? res.ml : 0;
  }

  // benchmark (Prompt 10): the trommel's nugget trap emptied on a round of the plant - what its station does (the walk
  // there is the bot's) -> pieces
  benchTrap() {
    const tr = this.trommel;
    if (!tr || !tr.trap.length) return 0;
    const got = this.economy.recover(0, tr.takeTrap());
    this.ledger.recoveredUg += got.ug;
    return got.pieces;
  }

  // benchmark: the concentrate tub into the bucket (empty / concentrate), the bucket set down at the wash place
  benchConcToWash() {
    const wp = this.washplant, b = this.bucket;
    if (!wp || !b || (b.batch.volumeMl > 0 && b.batch.stage !== STAGE.HEAVY)) return 0;
    const ml = wp.toBucket({ batch: b.batch, capacityMl: this.capacityMl });
    b.carried = true;
    this.act("bucket-wash", { x: WASH.bucketSpot.x, z: WASH.bucketSpot.z, yaw: 0 });
    if (b.carried) { b.carried = false; this.devPlaceBucket(WASH.bucketSpot.x, WASH.bucketSpot.z, 0.4); }
    this._fills();
    return ml;
  }

  // Prompt 10: the wash plant stands (the sluice under it first)
  devInstallWashplant() {
    const wp = this.washplant;
    if (!wp || !this.devInstallSluice()) return false;
    if (!wp.installed) { wp.state = "ready"; wp.build = -1; wp._sync(); this.applyUpgrades(); }
    return true;
  }

  // phase 7: the bulk hopper built / its content (null = empty), the feeder mounted and its lever
  devInstallBulk() {
    const bk = this.bulk;
    if (!bk) return false;
    if (!bk.installed) { this._clearAutomationFoot(); bk.state = "ready"; bk.build = -1; bk._sync(); }
    return true;
  }

  devSetBulk(batch) {
    const bk = this.bulk;
    if (!bk || (batch && batch.volumeMl > bk.capacityMl)) return false;
    for (const l of bk.buffer.layers) this._devTail(l);
    bk.buffer.layers = [];
    if (batch) { batch.id = this.nextBatch++; this._devIn(batch); bk.buffer.put(batch); }
    bk._fill();
    return true;
  }

  devInstallFeeder() {
    const fd = this.feeder;
    if (!fd || !this.devInstallBulk()) return false;
    if (!fd.installed) { fd.state = "ready"; fd.build = -1; fd._sync(); }
    return true;
  }

  devFeederMode(mode) { return !!(this.feeder && this.feeder.installed && this.feeder.setMode(mode)); }

  // phase 9: the plant built at once / its holders filled (test material from outside, booked like a dig)
  devInstallConveyor() {
    const cv = this.conveyor;
    if (!cv || !this.devInstallBulk()) return false;
    if (!cv.installed) { cv.state = "ready"; cv.build = -1; cv._sync(); }
    return true;
  }

  devInstallTrommel() {
    const tr = this.trommel;
    if (!tr || !this.devInstallConveyor()) return false;
    if (!tr.installed) { tr.state = "ready"; tr.build = -1; tr._sync(); this.conveyor._sync(); }
    return true;
  }

  devSetIntake(batch) {
    const cv = this.conveyor;
    if (!cv || (batch && batch.volumeMl > cv.capacityMl)) return false;
    for (const l of cv.intake.layers) this._devTail(l);
    cv.intake.layers = [];
    if (batch) { batch.id = this.nextBatch++; this._devIn(batch); cv.intake.put(batch); }
    cv._fillSig = null;
    return true;
  }

  devSetOversize(batch) {
    const tr = this.trommel;
    if (!tr) return false;
    for (const l of tr.oversize.layers) this._devTail(l);
    tr.oversize.layers = [];
    if (batch) { batch.id = this.nextBatch++; this._devIn(batch); tr.oversize.put(batch); }
    tr._pileSig = null;
    return true;
  }

  devConveyorMode(mode) { return !!(this.conveyor && this.conveyor.installed && this.conveyor.setMode(mode)); }

  devRiffles(batch, loadMl) {
    const sl = this.sluice;
    if (!sl) return false;
    if (batch) { batch.id = this.nextBatch++; batch.stage = STAGE.HEAVY; this._devIn(batch); sl.riffles.absorb(batch); }
    sl.loadMl = Math.max(sl.loadMl, loadMl);
    sl._sync();
    return true;
  }

  // after an upgrade went away: a bucket holding more than it can now
  devFitBucket() {
    const b = this.bucket;
    if (!b || b.batch.volumeMl <= this.capacityMl) return;
    const keep = b.batch.take(this.capacityMl, this.nextBatch++);
    this._devTail(b.batch);
    b.batch = keep;
    this._fills();
  }

  // the pan takes up to 2,5 l (the wash bowl 1,4 l): concentrate from the tub first, else raw from the bucket
  fillPan() {
    if (this.pan.batch.volumeMl > 0 || this.pan.batch.goldUg > 0) { this.startWork("pan"); return true; }
    const tool = this.washTool();
    let src = null, stage = STAGE.RAW;
    const tray = this.sluice ? this.sluice.tray.batch : null;
    if (tray && (tray.volumeMl > 0 || tray.goldUg > 0)) { src = tray; stage = STAGE.HEAVY; }
    else if (this.tub.volumeMl > 0) { src = this.tub; stage = STAGE.CONCENTRATE; }
    else { const w = this._washSource(); if (w) { src = w.batch; if (w.kind === "bucket" && w.batch.stage === STAGE.HEAVY) stage = STAGE.HEAVY; } }
    if (!src) return false;
    const load = src.take(tool === "bowl" ? BOWL_CAPACITY_ML : PAN_CAPACITY_ML, this.nextBatch++);
    load.stage = stage;
    this.pan.tool = tool;
    // tiny rest volumes (rounding; for the small bowl up to 0,3 l) go along with the last load
    if (src.volumeMl < (tool === "bowl" ? BOWL_REST_ML : 60)) load.absorb(src);
    this.pan.batch = load;
    this.pan.progress = 0;
    this._fills();
    this.startWork("pan");
    return true;
  }

  // phase 9: the next sample bag into the pan - a quick test pan (its line goes into the notebook)
  fillPanSample() {
    if (this.pan.batch.volumeMl > 0 || this.pan.batch.goldUg > 0) { this.startWork("pan"); return true; }
    const pg = this.prospect;
    if (!pg || !pg.count || this.washTool() !== "pan") return false;
    const bag = pg.popBag();
    const load = bag.batch;
    load.stage = STAGE.RAW;
    this.pan.tool = "pan";
    this.pan.batch = load;
    // (its spot too - GoldRush 9.1: a flag can be set at a washed sample's place and carries its number)
    this.pan.sample = { n: bag.n, place: bag.place, depth: bag.depth, mat: bag.mat, flag: bag.flag, t: bag.t || 0, ml: load.volumeMl, g: load.massG, x: bag.x, z: bag.z };
    this.pan.progress = 0;
    this._fills();
    this.startWork("pan");
    return true;
  }

  // the bucket (up to the screen's capacity) onto the classifier
  loadSieve() {
    if (this.sieve.batch.volumeMl > 0) { this.startWork("sieve"); return true; }
    const w = this._washSource();
    if (!w) return false;
    const load = w.batch.take(CLASSIFIER_ML, this.nextBatch++);
    if (w.batch.volumeMl < 60) load.absorb(w.batch);
    this.sieve.batch = load;
    this.sieve.progress = 0;
    this._fills();
    this.startWork("sieve");
    return true;
  }

  startWork(kind) {
    if (kind === "pan") {
      this.pan.need = this.pan.sample ? Math.max(SAMPLE_PAN_S.min, Math.min(SAMPLE_PAN_S.max, (this.pan.batch.volumeMl / 1000) * SAMPLE_PAN_S.perL)) : panSeconds(this.pan.batch, this.pan.tool);
      this.panDone = this.pan.progress >= 1;
      this.reveal = this.panDone ? this._revealOf(this.pan.batch) : null;
      this._panLook(true);
    } else if (kind === "clean") this.sluice.clean.progress = 0;
    else this.sieve.need = sieveSeconds(this.sieve.batch);
    this.work = kind;
    this.workPhase = kind === "pan" && this.panDone ? "result" : "gesture";
    this.workResult = null;
    this._sync();
    this._fills();
  }

  // stop working (E / pause / leave): what is in the pan or on the screen stays there
  stopWork() {
    if (!this.work) return;
    this.work = null;
    this.workPhase = null;
    this.workResult = null;
    if (this.hands && !this.carrying) this.hands.setHeld(null);
    this._sync();
  }

  // where the camera is while working (the engine eases the player there)
  workPose() {
    if (this.work === "pan") return { x: WASH.panSpot.x, z: WASH.panSpot.z, yaw: WASH.panSpot.yaw, pitch: this.pan.tool === "bowl" ? -0.78 : -0.82 };
    if (this.work === "sieve") return { x: WASH.sieveSpot.x, z: WASH.sieveSpot.z, yaw: WASH.sieveSpot.yaw, pitch: -0.72 };
    if (this.work === "clean") { const c = this._slSpots().clean; return { x: c.x, z: c.z, yaw: c.yaw, pitch: -0.82 }; }
    return null;
  }

  /**
   * Work input this frame: the look movement (radians) the player made.
   * Panning wants circling (any movement swirls), sieving a shake (mostly
   * sideways). Capped: a load takes its seconds. -> event or null:
   * "pan-ready" (gold shows, collect it) | "sieved" ({ ...result })
   */
  input(dx, dy, dt) {
    if (!this.work || this.workPhase !== "gesture") return null;
    const amount = Math.hypot(dx, dy);
    if (this.work === "pan") {
      if (this.panDone) return null;
      const need = this.pan.need;
      this.swirlK += (Math.min(1, amount / Math.max(1e-4, dt) / 1.4) - this.swirlK) * Math.min(1, dt * 6);
      this.swirlAngle += amount * 9;
      const dp = Math.min(dt / need, amount / (need * 1.1));
      this.pan.progress = Math.min(1, this.pan.progress + dp);
      if (this.pan.progress >= 1) {
        this.panDone = true;
        this.reveal = this._revealOf(this.pan.batch);
        this._toResult({ kind: "pan" });
        return "pan-ready";
      }
      return null;
    }
    if (this.work === "clean") {                    // brushing the mat out: back and forth
      const side = Math.abs(dx) + Math.abs(dy) * 0.4, c = this.sluice.clean;
      this.swirlK += (Math.min(1, side / Math.max(1e-4, dt) / 1.2) - this.swirlK) * Math.min(1, dt * 8);
      this.shakeX = Math.sin(this.time * 18) * 0.03 * this.swirlK;
      c.progress = Math.min(1, c.progress + Math.min(dt / CLEAN_S, side / CLEAN_S));
      if (c.progress >= 1) { const r = { kind: "cleaned", ...this.sluice.finishClean() }; this._toResult(r); return r; }
      return null;
    }
    // sieve
    const side = Math.abs(dx) + Math.abs(dy) * 0.4;
    this.swirlK += (Math.min(1, side / Math.max(1e-4, dt) / 1.2) - this.swirlK) * Math.min(1, dt * 8);
    this.shakeX = Math.sin(this.time * 40) * 0.022 * this.swirlK;
    const need = this.sieve.need;
    const dp = Math.min(dt / need, side / (need * 1.0));
    this.sieve.progress = Math.min(1, this.sieve.progress + dp);
    this._sieveLook();
    if (dp > 0 && this.effects && Math.random() < 0.5) this._fallThrough();
    if (this.sieve.progress >= 1) { const r = this.finishSieve(); this._toResult(r); return r; }
    return null;
  }

  // the gesture is done (its transaction too): the motion runs out, then the result stays until E / a click
  _toResult(r) {
    this.workPhase = "settle";
    this.settleT = 0.5;
    this.workResult = r;
  }

  // per frame: the settle runs out (the shaking / swirling eases off), then the result shows
  tickWork(dt) {
    if (!this.work || this.workPhase === "gesture") return;
    this.swirlK *= Math.exp(-dt * 5);
    this.shakeX *= Math.exp(-dt * 7);
    if (this.workPhase === "settle" && (this.settleT -= dt) <= 0) this.workPhase = "result";
  }

  // what the end of the pan will show: the fine gold it keeps, and its visible pieces at their own
  // size (FIND_LOOK - a EUR 1,50 wash is a sprinkle of specks, not a crescent of flakes)
  // (Prompt 10: the pan is seen from ~30 cm, not from standing height - a nugget there is drawn at 0,65 of its world size,
  // a big one's growing with a square root above a EUR 4 one's: EUR 4 ~2 cm across, EUR 80 ~3 cm)
  _revealOf(batch) {
    const panSize = (s, nug) => (nug ? 0.65 * (s > 0.0165 ? 0.0165 * Math.sqrt(s / 0.0165) : s) : s);
    const rec = washRecovery(this.pan.tool, batch.stage, this.recoveryMul);
    const shown = batch.finds.length > 6 ? [...batch.finds].sort((a, b) => b.ug - a.ug).slice(0, 6) : batch.finds;     // (the biggest pieces)
    return { fineUg: Math.floor(batch.fineUg * rec), finds: batch.finds.length, findsUg: batch.findsUg, nugget: batch.finds.some((f) => f.cls === FIND.NUGGET),
      pieces: shown.map((f, i) => panSize(findSize(f.cls, centsForMass(f.ug), ((i * 0.37) % 1)), f.cls === FIND.NUGGET)), nugs: shown.map((f) => f.cls === FIND.NUGGET) };
  }

  /**
   * COLLECT the gold left in the pan: one transaction - recovered gold into
   * the pouch, the rest (light material + unrecovered fine gold) to the
   * tailings, the pan empty. -> { ok, cents, ug, fineUg, pieces }
   */
  finishPan() {
    if (!this.panDone) return { ok: false };
    const load = this.pan.batch, tool = this.pan.tool;
    const rec = washRecovery(tool, load.stage, this.recoveryMul);
    const g = panLoad(load, rec, this.nextBatch++);
    const got = this.economy.recover(g.fineUg, g.finds);
    const L = this.ledger;
    L.recoveredUg += got.ug; L.recoveredFineUg += g.fineUg;
    L.tailUg += g.tails.goldUg; L.tailG += g.tails.massG; L.tailMl += g.tails.volumeMl;
    L.panLoads++;
    if (tool === "bowl") L.bowlLoads = (L.bowlLoads || 0) + 1;
    // phase 9: a sample - its line in the notebook (what the pan kept, per litre of the sample)
    const sample = this.pan.sample && this.prospect ? this.prospect.noteResult({ ...this.pan.sample, batch: { volumeMl: 0, massG: 0 } }, got) : null;
    if (sample) L.sampleLoads = (L.sampleLoads || 0) + 1;
    this.pan.sample = null;
    this.pan.batch = this._batch(STAGE.RAW);
    this.pan.progress = 0;
    this.panDone = false;
    this.reveal = null;
    this.stopWork();
    this._fills();
    return { ok: true, cents: got.cents, ug: got.ug, fineUg: g.fineUg, pieces: got.pieces, stage: load.stage, tool, sample, bestUg: got.bestUg };
  }

  // the shaking is done: fines -> tub, stones -> tailings, nuggets -> pouch
  finishSieve() {
    const load = this.sieve.batch;
    const { under, over, retained } = classify(load, [this.nextBatch++, this.nextBatch++]);
    const underMl = under.volumeMl;
    this.tub.absorb(under);
    this.tub.stage = STAGE.CONCENTRATE;
    const got = retained.length ? this.economy.recover(0, retained) : { cents: 0, ug: 0, pieces: 0 };
    const L = this.ledger;
    L.recoveredUg += got.ug;
    L.tailUg += over.goldUg; L.tailG += over.massG; L.tailMl += over.volumeMl;
    L.sieveLoads++;
    this.sieve.batch = this._batch(STAGE.RAW);
    this.sieve.progress = 0;
    // the stones stay a moment, then slide off
    this.sieve.stones = Math.min(36, Math.round(over.massG / 220));
    this.sieve.coarse = { comp: over.comp.slice(), ml: over.volumeMl, seed: load.id % 97 };
    this.sieve.dumpT = 1.6;
    // (the work stays on its result until E - Prompt 10: no jump back to looking round)
    this._fills();
    return { kind: "sieved", overMl: over.volumeMl, underMl, retained: got };
  }

  // fines falling through the screen into the tub
  _fallThrough() {
    const p = this.cls.position;
    const def = { dustColor: [0.32, 0.24, 0.16], fragmentColor: [0.36, 0.27, 0.18], dustAmount: 0.4, fragmentCount: 1, fragmentType: "clod" };
    this.effects.spill(p.x + (Math.random() - 0.5) * 0.5, 0.58, p.z + (Math.random() - 0.5) * 0.4, def, 0.35);
  }

  // ------------------------------------------------------------ visuals

  _fills() {
    if (this.bucket && this.bucket.batch.volumeMl <= 0 && this.bucket.batch.goldUg <= 0 && this.bucket.batch.stage !== STAGE.RAW) this.bucket.batch.stage = STAGE.RAW;
    const M = this.models;
    // world bucket + the one in your hand
    const bc = this.bucket ? this.bucket.batch.comp : null;
    for (const g of [this.worldBucket, this.handBucket]) M.setBucketFill(g, this.bucket ? this.bucket.batch.volumeMl / (this.bucketScale ** 3) : 0, bc);
    // classifier heap and the tub's concentrate
    const u = this.cls.userData;
    this._sieveLook();
    u.conc.visible = this.tub.volumeMl > 80;
    if (u.conc.visible) u.conc.position.y = 0.035 + Math.min(1, this.tub.volumeMl / TUB_ML) * (u.TH - 0.06);
  }

  // the load on the classifier's screen (phase 7B): a loose heap; while you shake, the fine part
  // sinks through (the heap gets lower, the pebbles / clods / stones show more and more), at the
  // end only the coarse part lies there - what the screen really keeps (COARSE) - until it slides off
  _sieveLook() {
    // phase 8: spread shallow across the screen (goldrush-heap.js screenShape); while you shake, the fines
    // go - the layer thins, holes open, the coarse pieces stay; at the end only they lie there
    const H = this.cls.userData.heapLoad, b = this.sieve.batch;
    if (b.volumeMl > 100) {
      const p = Math.round(this.sieve.progress * 20) / 20;
      const comp = [0, 0, 0, 0];
      for (let k = 0; k < 4; k++) { const c = b.comp[k] * COARSE[k]; comp[k] = c + (b.comp[k] - c) * (1 - p); }
      const vol = Math.min(1, b.volumeMl / 14000), seed = b.id % 97;
      H.setVisible(true);
      H.set(`l:${p}:${b.id}:${Math.round(b.volumeMl / 100)}`, screenShape(p, vol, comp, seed), comp, { amount: 0.5 + 0.5 * p, tMax: 0.05 });
    } else if (this.sieve.stones > 0 && this.sieve.coarse) {
      const c = this.sieve.coarse;
      H.setVisible(true);
      H.set(`c:${c.seed}:${c.ml}`, screenShape(1, Math.min(1, c.ml / 6000), c.comp, c.seed), c.comp, { amount: 1, tMax: 0.05 });
    } else H.setVisible(false);
  }

  // the pan (or the wash bowl) in your hands: mud level, water, pebbles leaving, gold showing
  _washHand() { return this.pan.tool === "bowl" ? this.handBowl : this.handPan; }

  _panLook(reset) {
    const P = this._washHand().userData, b = this.pan.batch, u = this.pan.progress;
    const S = washShape(this.pan.tool), k = this.pan.tool === "bowl" ? 0.78 : 1;
    if (reset) this._panStart = { ml: Math.max(1, b.volumeMl), stones: Math.min(18, Math.round((b.comp[2] + b.comp[3]) / 120 + b.comp[1] / 400)), stage: b.stage, seed: (b.id * 7919) % 9973 };
    const st = this._panStart || { ml: 1, stones: 0, stage: STAGE.RAW, seed: 0 };
    // phase 7B: what you see while you swirl - (1) muddy water, (2) the light earth washes out and the
    // load gets thinner, (3) the stones get fewer, (4) dark heavy sand gathers on the low side,
    // (5) the gold shows at the end. Water and material follow the pan's tilt a moment late (slosh).
    const sl = this._slosh || (this._slosh = { x: 0, z: 0, vx: 0, vz: 0 });
    const left = 1 - 0.9 * smooth(0.08, 0.92, u);
    const h = Math.max(0.004, S.fill(st.ml * left));
    P.mud.visible = st.ml > 1;
    const conc = smooth(0.45, 1, u);                                      // the heavy sand draws to the far, low side
    P.mud.position.set(sl.x * 0.006, S.base + h, sl.z * 0.006 - conc * 0.025 * k);
    // (phase 8: the light load washes away towards the far side and is gone at the end - what stays is the
    // black sand patch below, not a dark disc)
    const r = (S.radius(h) - 0.003) * (1 - 0.55 * conc);
    P.mud.scale.set(r, 1, r * (1 - 0.25 * conc));
    if (u > 0.97) P.mud.visible = false;
    // the black sand (phase 8): an uneven drift in the low corner where the bottom meets the far wall,
    // a little different for every load; it shows as the light material thins
    if (P.sand) {
      const sk = smooth(0.3, 0.9, u), rb = S.radius(0), sd = st.seed || 0;
      P.sand.visible = st.ml > 1 && sk > 0.02;
      P.sand.position.set(sl.x * 0.004 + (hash01(sd + 1) - 0.5) * rb * 0.25, S.base + 0.0012, -rb * (0.5 + 0.08 * hash01(sd + 2)) + sl.z * 0.004);
      // (the patch's crown: 0.06 units high in the geometry -> 1-3 mm here: a thin drift, not a heap)
      P.sand.scale.set(rb * (0.42 + 0.3 * sk) * (0.9 + 0.2 * hash01(sd + 3)), 0.02 + 0.03 * sk, rb * (0.2 + 0.2 * sk));
      P.sand.rotation.y = (hash01(sd + 4) - 0.5) * 0.6;
    }
    P.mud.rotation.y = this.swirlAngle * 0.35;
    const c = P.mud.material.color.setHex(st.stage === STAGE.CONCENTRATE ? COLORS.conc : COLORS.raw);
    c.multiplyScalar(1.08 - 0.12 * smooth(0, 0.35, u));                // the light top washes off first
    c.lerp(this._c2 || (this._c2 = new this.THREE.Color(COLORS.black)), smooth(0.35, 0.82, u));
    // water: thick and muddy at first, clearing; it lags behind the pan's tilt and leans against it
    P.water.visible = st.ml > 1 && u < 0.995;
    const wh = Math.min(S.depth - 0.002, h + 0.018 + 0.012 * smooth(0, 0.12, u));
    P.water.position.set(sl.x * 0.011, S.base + wh, sl.z * 0.011);
    const wr = S.radius(wh) - 0.002;
    P.water.scale.set(wr * (1 + Math.abs(sl.x) * 0.04), 1, wr * (1 + Math.abs(sl.z) * 0.04));
    P.water.rotation.set(-sl.z * 0.11, this.swirlAngle, sl.x * 0.11);
    P.water.material.opacity = 0.62 - 0.36 * smooth(0.3, 1, u);
    P.water.material.color.setRGB(0.32 - 0.08 * u, 0.25 + 0.01 * u, 0.17 + 0.1 * u);
    // pebbles: tossed out as the light stuff goes; the ones left slosh with the water
    const nPeb = Math.round(st.stones * (1 - smooth(0.15, 0.75, u)));
    this._pebbles(P.pebbles, nPeb, h, S.base, k, sl);
    // gold: shows at the bottom once the sand is thin
    const nFl = this.reveal || u > 0.7 ? this._flakeCount() : 0;
    this._flakes(P.flakes, Math.round(nFl * smooth(0.7, 1, u)), h, S.base, k, P.nuggets);
  }

  // fine gold shows as specks: a few for a trace, a few dozen for a good load (the number grows with
  // the root of the mass - ~28 for 17 mg); the visible pieces come on top (at most 6 + 34 = 40 drawn)
  _flakeCount() {
    const rv = this.reveal || this._revealOf(this.pan.batch);
    const specks = rv.fineUg > 0 ? Math.max(3, Math.min(34, Math.round(3 + 6 * Math.sqrt(rv.fineUg / 1000)))) : 0;
    return specks + rv.pieces.length;
  }

  // the stones in the pan: mostly small (3-12 mm, few big ones), they go round with the swirl
  // and slosh with the water (sl: the slosh offset)
  _pebbles(mesh, n, h, base = 0, k = 1, sl = null) {
    const sx = sl ? sl.x : 0, sz = sl ? sl.z : 0;
    if (mesh.count === n && this._pebH === h && this._pebA === this.swirlAngle) return;
    this._pebH = h; this._pebA = this.swirlAngle;
    mesh.count = n;
    const m = this._m || (this._m = new this.THREE.Matrix4()), q = new this.THREE.Quaternion(), e = new this.THREE.Euler(), v = new this.THREE.Vector3(), s3 = new this.THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const f = ((i * 7919) % 17) / 17, a = i * 2.39996 + this.swirlAngle * (0.22 + 0.12 * f), rr = (0.03 + 0.1 * Math.sqrt((i + 0.5) / 18)) * k;
      const s = 0.003 + f * f * 0.0085;
      e.set(i, i * 2.1 + this.swirlAngle * 0.2, 0); q.setFromEuler(e);
      v.set(Math.cos(a) * rr + sx * 0.014, base + h + s * 0.45, Math.sin(a) * rr + sz * 0.014);
      m.compose(v, q, s3.set(s, s * 0.72, s * (0.8 + 0.3 * f)));
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  _flakes(mesh, n, h, base = 0, kr = 1, nugMesh = null) {
    const sd = (this._panStart && this._panStart.seed) || 0;
    if (mesh.count === n && this._flH === h && this._flS === sd && this._flM === nugMesh) return;
    this._flH = h; this._flS = sd; this._flM = nugMesh;
    mesh.count = n;
    let nn = 0;
    const m = this._m || (this._m = new this.THREE.Matrix4()), q = new this.THREE.Quaternion(), e = new this.THREE.Euler(), v = new this.THREE.Vector3(), s3 = new this.THREE.Vector3();
    const rv = this.reveal || this._revealOf(this.pan.batch), pieces = rv.pieces || [];
    // gold settles where the black sand lies - the low corner of the bottom at the far wall (phase 8): in
    // two or three small drifts that differ load by load, the bigger pieces deepest, a few stray specks;
    // never a ring, an arc or a sunflower (the amount still follows the gold's value)
    const rb = 0.11 * kr, nc = 2 + Math.floor(hash01(sd + 11) * 2), cx = [], cz = [];
    for (let c = 0; c < nc; c++) {
      const a = (hash01(sd + 13 + c) - 0.5) * 1.1, rr = rb * (0.62 + 0.25 * hash01(sd + 17 + c));
      cx.push(Math.sin(a) * rr); cz.push(-Math.cos(a) * rr);
    }
    for (let i = 0; i < n; i++) {
      // its true size (m): the pieces first, then the fine gold - specks of 1,3-2,2 mm (drawn, a little over life)
      const s = i < pieces.length ? pieces[i] : 0.0013 + hash01(sd + i * 3.7) * 0.0009;
      let x, z;
      if (i < pieces.length) {                                   // the heavy pieces: in the deepest drift, close together
        x = cx[0] + (hash01(sd + i * 5.1) - 0.5) * 0.014; z = cz[0] + (hash01(sd + i * 6.3) - 0.5) * 0.01;
      } else if (hash01(sd + i * 2.9) < 0.12) {                  // a stray speck somewhere on the sand
        const a = (hash01(sd + i * 4.3) - 0.5) * 1.6, rr = rb * (0.35 + 0.55 * hash01(sd + i * 8.1));
        x = Math.sin(a) * rr; z = -Math.cos(a) * rr;
      } else {                                                   // one of the drifts: dense in its middle, thinning out
        const c = Math.floor(hash01(sd + i * 1.9) * nc), g1 = hash01(sd + i * 7.7) + hash01(sd + i * 9.3) - 1, g2 = hash01(sd + i * 3.1) + hash01(sd + i * 5.9) - 1;
        x = cx[c] + g1 * 0.022; z = cz[c] + g2 * 0.012;
      }
      const rr = Math.hypot(x, z), lim = rb * 0.95;
      if (rr > lim) { x *= lim / rr; z *= lim / rr; }
      e.set(hash01(sd + i) * 3, hash01(sd + i * 1.3) * 6, hash01(sd + i * 2.3) * 0.6); q.setFromEuler(e);
      v.set(x, base + Math.min(h, 0.006) + s * 0.3, z);
      m.compose(v, q, s3.set(s, s, s));
      // (Prompt 10: a nugget is a lump lying flat - drawn by its own mesh, the flake slot left empty)
      if (nugMesh && i < pieces.length && rv.nugs && rv.nugs[i] && nn < 6) { e.set((hash01(sd + i) - 0.5) * 0.12, hash01(sd + i * 1.3) * 6, (hash01(sd + i * 2.3) - 0.5) * 0.12); q.setFromEuler(e); v.y = base + Math.min(h, 0.006) + s * 0.4; m.compose(v, q, s3.set(s, s, s)); nugMesh.setMatrixAt(nn++, m); m.compose(v, q, s3.set(0, 0, 0)); }
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (nugMesh) { nugMesh.count = nn; nugMesh.visible = nn > 0; if (nn) nugMesh.instanceMatrix.needsUpdate = true; }
  }

  /**
   * Per frame. Hands: the bucket you carry / the pan you swirl (view space).
   */
  update(dt, player = null) {
    this.tickWork(dt);
    this.time += dt;
    if (this.prospect) this.prospect.update();
    if (this.barrow) this.barrow.update(dt, this.barrow.pushing ? player : null);
    if (this.sluice) {
      if (!this.simWork) this.sluice.process(dt);              // (tests simulating a pan load: the machine has its own clock there)
      const near = player ? Math.hypot(player.x - (SLUICE_AT.x + 1.2), player.z - SLUICE_AT.z) < 9 : false;
      this.sluice.lowDetail = !!(this.ctx.quality && this.ctx.quality() === "low");
      this.sluice.update(dt, near, this.onSound);
      if (this.washplant) this.washplant.update(dt);
      if ((this._wetT = (this._wetT || 0) - dt) <= 0) { this._wetT = 1; this._wetSync(); }
    }
    // phase 7: the feeder / the hand gate refill what the sluice took (downstream first); phase 9: then the trommel, the belt
    if (!this.simWork) { if (this.feeder) this.feeder.process(dt); if (this.bulk) this.bulk.process(dt); if (this.trommel) this.trommel.process(dt); if (this.conveyor) this.conveyor.process(dt); }
    if (this.trommel) { this.trommel.lowDetail = !!(this.ctx.quality && this.ctx.quality() === "low"); this.trommel.update(dt, player ? Math.hypot(player.x - BULK_AT.x, player.z - BULK_AT.z) < 11 : false, this.onSound); }
    if (this.excavator) this.excavator.update(dt, this.excEvent || null);
    if (this.autominer) this.autominer.update(dt, player);
    // Prompt 10: the loader's arms / its work (the engine hands in the throttle while you sit in it), the piles settle
    if (this.loader) this.loader.update(dt, this.loaderInput || null, this.loaderEvent || null);
    this.piles.update(dt, player);
    if (this.conveyor) this.conveyor.update(dt, player ? Math.min(Math.hypot(player.x - INTAKE.x, player.z - INTAKE.z), Math.hypot(player.x - (INTAKE.x + BULK_AT.x) / 2, player.z - (INTAKE.z + BULK_AT.z) / 2)) < 7 : false, this.onSound);
    this._steady();
    if (this.feeder) this.feeder.update(dt, this.onSound, player ? Math.hypot(player.x - BULK_AT.x, player.z - BULK_AT.z) < 10 : false);
    if (this.bulk) this.bulk.update(dt, this.feeder && this.feeder.installed ? this.feeder.flow() : null);
    // the bucket stands on whatever the ground is now
    if (this.bucket && !this.bucket.carried) this.worldBucket.position.y = this.world.groundAt(this.bucket.x, this.bucket.z);
    // trough water: a slow shimmer, the trickle
    const wd = this.wash.userData;
    if (wd.water.material.bumpMap) wd.water.material.bumpMap.offset.set((this.time * 0.02) % 1, (this.time * 0.013) % 1);
    wd.trickle.scale.x = wd.trickle.scale.z = 0.9 + Math.sin(this.time * 23) * 0.1;
    // classifier: shake while sieving, stones slide off afterwards
    const fr = this.cls.userData.frame;
    if (this.work === "sieve") fr.position.z = this.shakeX;
    else {
      fr.position.z *= Math.exp(-dt * 12);
      this.swirlK *= Math.exp(-dt * 4);
    }
    if (this.sieve.dumpT > 0) {
      this.sieve.dumpT -= dt;
      fr.rotation.z = 0.06 + (this.sieve.dumpT < 0.7 ? Math.sin(Math.min(1, (0.7 - this.sieve.dumpT) / 0.7) * Math.PI) * 0.35 : 0);
      if (this.sieve.dumpT <= 0) { this.sieve.stones = 0; fr.rotation.z = 0.06; this._fills(); }
    }
    // what the hands hold
    const H = this.hands;
    if (!H) return;
    const w = this.barrow;
    if (H.holdBarrow) H.holdBarrow(!this.work && w && (w.pushing || w.handsOn > 0) ? w : null);
    if (this.work === "pan") {
      const tool = this.pan.tool, obj = this._washHand(), hp = HELD[tool];
      if (H.held !== tool) H.setHeld(tool, obj, HELD_GRIPS[tool]);
      const k = this.swirlK, a = this.swirlAngle;
      const pose = obj.userData.pose || (obj.userData.pose = { p: [0, 0, 0], r: [0, 0, 0] });
      // your circles tilt and turn the pan (7B: a little more than before), the water follows late
      pose.p[0] = hp.p[0] + Math.cos(a * 0.5) * 0.016 * k;
      pose.p[1] = hp.p[1] + Math.sin(a * 0.5) * 0.008 * k;
      pose.p[2] = hp.p[2];
      pose.r[0] = hp.r[0] + Math.sin(a * 0.5) * 0.085 * k;
      pose.r[1] = hp.r[1] + Math.sin(a * 0.25) * 0.03 * k;
      pose.r[2] = hp.r[2] + Math.cos(a * 0.5) * 0.1 * k;
      const sl = this._slosh || (this._slosh = { x: 0, z: 0, vx: 0, vz: 0 }), tx = Math.cos(a * 0.5) * k, tz = Math.sin(a * 0.5) * k;
      const sd = Math.min(dt, 0.05);
      sl.vx += ((tx - sl.x) * 34 - sl.vx * 6.5) * sd; sl.vz += ((tz - sl.z) * 34 - sl.vz * 6.5) * sd;
      sl.x += sl.vx * sd; sl.z += sl.vz * sd;
      this._panLook(false);
      // muddy water over the rim while it is swirled (the bowl's blunt rim spills more)
      if (k > 0.25 && this.pan.progress < 0.9 && Math.random() < dt * (tool === "bowl" ? 18 : 14) * k) H.splash && H.splash(obj);
    } else if (this.work === "sieve" || this.work === "clean") {
      if (H.held !== "sieve") H.setHeld("sieve", this.handSieve, HELD_GRIPS.sieve);
      const pose = this.handSieve.userData.pose || (this.handSieve.userData.pose = { p: [0, 0, 0], r: [0, 0, 0] });
      pose.p[0] = HELD.sieve.p[0] - this.shakeX * 1.6; pose.p[1] = HELD.sieve.p[1]; pose.p[2] = HELD.sieve.p[2];
      pose.r[0] = HELD.sieve.r[0]; pose.r[1] = HELD.sieve.r[1]; pose.r[2] = HELD.sieve.r[2];
    } else if (w && (w.pushing || w.handsOn > 0)) {
      // the barrow (phase 8): the gloves on its world grips, the arms by IK (goldrush-hand.js)
      if (H.held) H.setHeld(null);
    } else if (this.carrying) {
      if (H.held !== "bucket") H.setHeld("bucket", this.handBucket, HELD_GRIPS.bucket);
      const pose = this.handBucket.userData.pose || (this.handBucket.userData.pose = { p: [0, 0, 0], r: [0, 0, 0] });
      const sw = Math.sin(this.time * 2.2) * 0.012;
      pose.p[0] = HELD.bucket.p[0]; pose.p[1] = HELD.bucket.p[1]; pose.p[2] = HELD.bucket.p[2];
      pose.r[0] = HELD.bucket.r[0] + sw; pose.r[1] = HELD.bucket.r[1]; pose.r[2] = HELD.bucket.r[2] + sw * 0.6;
    } else if (H.held) H.setHeld(null);
  }

  // tests / benchmark: material from one container to another - the same pour() the actions use
  pourBetween(from, to) {
    const H = { bucket: this.bucket ? { batch: this.bucket.batch, capacityMl: this.capacityMl } : null, barrow: this.barrow, hopper: this.sluice ? this.sluice.hopper : null,
      bulk: this.bulk && this.bulk.installed ? this.bulk.buffer : null, tray: this.feeder ? this.feeder.tray : null,
      intake: this.conveyor && this.conveyor.installed ? this.conveyor.intake : null, oversize: this.trommel ? this.trommel.oversize : null,
      scoop: this.excavator ? this.excavator.bucket : null, spoil: this.spoil ? this._spoilBin : null, loader: this.loader ? this.loader.bucket : null,
      miner: this.autominer ? this.autominer.buffer : null,
      conc: this.washplant ? this.washplant.conc : null };
    if (!H[from] || !H[to]) return 0;
    const ml = transfer(H[from], H[to], Infinity, this.nextBatch++);
    if (ml > 0 && to === "bulk") { this.bulk.stats.inMl += ml; this.bulk.stats.loads++; }
    if (ml > 0 && to === "intake") { this.conveyor.stats.inMl += ml; this.conveyor.stats.loads++; this.conveyor._fillSig = null; }
    if (ml > 0 && to === "spoil") this.spoil.dumpFrom(this._spoilBin);
    if (this.bulk) this.bulk._fill();
    this._fills();
    return ml;
  }

  // the simulation (benchmark): the machines run for `seconds` (nothing drawn) - with the
  // phase-7 machines in short steps (sluice first, then what refills it), exactly like frames
  tickSim(seconds) {
    if (!this.bulk && !this.feeder) return this.sluice ? this.sluice.process(seconds) : 0;
    let done = 0;
    for (let t = 0; t < seconds - 1e-9; t += 1) {
      const h = Math.min(1, seconds - t);
      if (this.sluice) done += this.sluice.process(h);
      if (this.feeder) this.feeder.process(h);
      if (this.bulk) this.bulk.process(h);
      if (this.trommel) this.trommel.process(h);
      if (this.conveyor) this.conveyor.process(h);
      if (this.autominer) this.autominer.sim(h);                    // Prompt 10: the hillside miner bites and feeds the intake
      this._steady();
    }
    for (const p of this.piles.list()) p.relax(40000);            // (the simulation draws nothing: the piles only settle)
    return done;
  }

  // a running feeder doses evenly: the sluice takes its rate (FEED_LPM .. STEADY_MAX_LPM)
  _steady() {
    if (this.sluice) this.sluice.steadyLpm = this.feeder && this.feeder.installed && this.feeder.running ? this.feeder.rateLpm : 0;
  }

  // ------------------------------------------------------------ save

  serialize() {
    const b = this.bucket;
    return {
      owned: this.ownedList(),
      nextBatch: this.nextBatch,
      bucket: b ? { x: b.x, z: b.z, ry: b.ry, carried: !!b.carried, batch: b.batch.serialize() } : null,
      tub: this.tub.serialize(),
      pan: { batch: this.pan.batch.serialize(), progress: +this.pan.progress.toFixed(3), tool: this.pan.tool, ...(this.pan.sample ? { sample: { ...this.pan.sample } } : {}) },
      sieve: { batch: this.sieve.batch.serialize(), progress: +this.sieve.progress.toFixed(3) },
      ledger: { ...this.ledger },
      wheelbarrow: this.barrow ? this.barrow.serialize() : null,
      sluice: this.sluice ? this.sluice.serialize() : null,
      bulkHopper: this.bulk ? this.bulk.serialize() : null,
      feeder: this.feeder ? this.feeder.serialize() : null,
      conveyor: this.conveyor ? this.conveyor.serialize() : null,
      trommel: this.trommel ? this.trommel.serialize() : null,
      washplant: this.washplant ? this.washplant.serialize() : null,
      spoil: this.spoil ? this.spoil.serialize() : null,
      excavator: this.excavator ? this.excavator.serialize() : null,
      autominer: this.autominer ? this.autominer.serialize() : null,
      // Prompt 10 (v9)
      piles: this.piles.serialize(),
      loader: this.loader ? this.loader.serialize() : null,
    };
  }

  // gold in containers right now (ledger check)
  goldInContainers() {
    return (this.bucket ? this.bucket.batch.goldUg : 0) + this.tub.goldUg + this.pan.batch.goldUg + this.sieve.batch.goldUg
      + (this.barrow ? this.barrow.batch.goldUg : 0) + (this.sluice ? this.sluice.goldUg() : 0)
      + (this.bulk ? this.bulk.goldUg() : 0) + (this.feeder ? this.feeder.goldUg() : 0)
      + (this.prospect ? this.prospect.goldUg() : 0) + (this.conveyor ? this.conveyor.goldUg() : 0) + (this.trommel ? this.trommel.goldUg() : 0)
      + (this.washplant ? this.washplant.goldUg() : 0)
      + (this.excavator ? this.excavator.goldUg() : 0) + this._spoilBin.goldUg + (this._pileBin ? this._pileBin.goldUg : 0)
      + this.piles.goldUg() + (this.loader ? this.loader.goldUg() : 0) + (this.autominer ? this.autominer.goldUg() : 0);
  }

  massInContainers() {
    return (this.bucket ? this.bucket.batch.massG : 0) + this.tub.massG + this.pan.batch.massG + this.sieve.batch.massG
      + (this.barrow ? this.barrow.batch.massG : 0) + (this.sluice ? this.sluice.massG() : 0)
      + (this.bulk ? this.bulk.massG() : 0) + (this.feeder ? this.feeder.massG() : 0)
      + (this.prospect ? this.prospect.massG() : 0) + (this.conveyor ? this.conveyor.massG() : 0) + (this.trommel ? this.trommel.massG() : 0)
      + (this.washplant ? this.washplant.massG() : 0)
      + (this.excavator ? this.excavator.massG() : 0) + this._spoilBin.massG + (this._pileBin ? this._pileBin.massG : 0)
      + this.piles.massG() + (this.loader ? this.loader.massG() : 0) + (this.autominer ? this.autominer.massG() : 0);
  }

  dispose() {
    if (this.hands && this.hands.held) this.hands.setHeld(null);
    const i = this.world.colliders.indexOf(this.clsCollider);
    if (i >= 0) this.world.colliders.splice(i, 1);
    this.scene.remove(this.group);
    if (this.barrow) this.barrow.dispose(this.scene);
    if (this.sluice) this.sluice.dispose(this.scene);
    if (this.feeder) this.feeder.dispose(this.scene);
    if (this.bulk) this.bulk.dispose(this.scene);
    if (this.prospect) this.prospect.dispose();
    if (this.trommel) this.trommel.dispose();
    if (this.washplant) { this.washplant.dispose(); this.washplant = null; }
    if (this.conveyor) this.conveyor.dispose();
    if (this.spoil) this.spoil.dispose();
    if (this.excavator) this.excavator.dispose();
    if (this.loader) this.loader.dispose();
    if (this.autominer) this.autominer.dispose();
    this.piles.dispose();
    this.models.dispose();
    this.mech.dispose();
    if (this._wetTex) { this._wetTex.dispose(); this._wetGeo.dispose(); for (const m of this._wetMats) m.dispose(); for (const g of this._wetGeos || []) g.dispose(); }
    for (const m of this._merged || []) m.geometry.dispose();
  }
}
