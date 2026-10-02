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
//   GOLD PAN     fill it from the tub (concentrate) or straight from the
//                bucket (raw), swirl it in the trough: the light material
//                goes over the rim, the gold stays. Raw ground pans slower
//                and keeps less of the fine gold than a concentrate.
//   POUCH        the recovered gold goes into the gold pouch (economy.recover)
//
// The material is a MaterialBatch all the way (goldrush-material.js):
// nothing is re-rolled, gold is only ever moved or - what a process does
// not recover - booked to the tailings. ledger: gold in (from digs) ==
// gold in containers + recovered + tailings, to the microgram.
// Work (panning / sieving) is done by the player: mouse / touch movement
// swirls the pan or shakes the screen; progress is capped per second, so a
// load takes its few seconds of real work - no bar that fills on its own.

import { MaterialBatch, STAGE, batchFromDig, classify, panLoad, panRecovery, panSeconds, sieveSeconds, PAN_CAPACITY_ML } from "./goldrush-material.js";
import { ProcessModels, bucketFillHeight, panFillHeight, panRadius } from "./goldrush-processmodels.js";
import { FIND } from "./goldrush-resources.js";

// the wash place, next to the water tank (-19.5, 1.8)
export const WASH = {
  trough: { x: -16.95, z: 2.35 },                          // centre (long side along z)
  panSpot: { x: -16.12, z: 2.0, yaw: Math.PI / 2 },        // stand here, facing the trough (west)
  bucketSpot: { x: -16.15, z: 3.5 },                       // a bucket set down at the wash place
  classifier: { x: -16.95, z: 4.8 },
  sieveSpot: { x: -15.9, z: 4.8, yaw: Math.PI / 2 },
  supplyDrop: { x: -17.35, z: 9.55 },                      // a bought bucket waits in front of the shed
};
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
  sieve: { p: [0, -0.25, -0.5], r: [0, 0, 0] },                         // both hands on the frame's handles
};
// how the gloves hold them (in the object's frame; like GRIPS in goldrush-hand.js:
// a left-hand grip is written as for the right hand - it is mirrored)
export const HELD_GRIPS = {
  bucket: [{ side: 1, pos: [0, 0.428, 0], axis: "x", roll: -0.2, flip: 1 }],
  pan: [{ side: 1, pos: [0.2, 0.05, 0.02], axis: "z", roll: 1.75, flip: 1 }, { side: -1, pos: [0.2, 0.05, 0.02], axis: "z", roll: 1.75, flip: 1 }],
  sieve: [{ side: 1, pos: [0.16, 0, 0], axis: "z", roll: 2.4, flip: 1 }, { side: -1, pos: [0.16, 0, 0], axis: "z", roll: 2.4, flip: 1 }],
};
const COLORS = { raw: 0x8a6a4c, conc: 0x6a5846, black: 0x3a332c };

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
    this.owned = new Set((Array.isArray(s.owned) ? s.owned : []).filter((id) => ["bucket", "pan", "classifier"].includes(id)));
    this.nextBatch = Number.isInteger(s.nextBatch) && s.nextBatch > 0 ? s.nextBatch : 1;
    const sb = s.bucket || null;
    this.bucket = this.owned.has("bucket") ? {
      x: Number.isFinite(sb && sb.x) ? sb.x : WASH.supplyDrop.x, z: Number.isFinite(sb && sb.z) ? sb.z : WASH.supplyDrop.z, ry: Number.isFinite(sb && sb.ry) ? sb.ry : 0,
      carried: !!(sb && sb.carried), batch: MaterialBatch.from(sb && sb.batch) || this._batch(STAGE.RAW),
    } : null;
    this.tub = MaterialBatch.from(s.tub) || this._batch(STAGE.CONCENTRATE);
    const sp = s.pan || {};
    this.pan = { batch: MaterialBatch.from(sp.batch) || this._batch(STAGE.RAW), progress: Math.max(0, Math.min(1, +sp.progress || 0)), need: 8 };
    const ss = s.sieve || {};
    this.sieve = { batch: MaterialBatch.from(ss.batch) || this._batch(STAGE.RAW), progress: Math.max(0, Math.min(1, +ss.progress || 0)), need: 4, stones: 0, dumpT: 0 };
    const l = s.ledger || {};
    this.ledger = {
      inUg: int(l.inUg), inFineUg: int(l.inFineUg), inG: int(l.inG), inMl: int(l.inMl),
      recoveredUg: int(l.recoveredUg), recoveredFineUg: int(l.recoveredFineUg), tailUg: int(l.tailUg), tailG: int(l.tailG), tailMl: int(l.tailMl),
      spoilFineUg: int(l.spoilFineUg), panLoads: int(l.panLoads), sieveLoads: int(l.sieveLoads), buckets: int(l.buckets),
    };
    this.work = null;              // null | "pan" | "sieve"
    this.swirlAngle = 0;
    this.swirlK = 0;               // how hard you swirl right now (0..1, visuals)
    this.shakeX = 0;
    this.time = 0;
    this.lastFull = false;
    this.reveal = null;            // the gold left in the pan at the end (what is shown)
    this.panDone = false;
    this._build();
  }

  _batch(stage) { return new MaterialBatch({ id: this.nextBatch++, stage }); }

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
    this.world.colliders.push({ type: "box", x: WASH.trough.x, z: WASH.trough.z, hw: 0.34, hd: 1.06, rot: 0 });
    // the pan lying on the trough's near rim (when owned and not in your hands)
    this.restPan = M.pan();
    this.restPan.position.set(WASH.trough.x + 0.12, 0.43, WASH.trough.z - 0.7);
    this.restPan.rotation.set(0, 0, -0.08);
    this.group.add(this.restPan);
    // the classifier with its tub
    this.cls = M.classifier();
    this.cls.position.set(WASH.classifier.x, 0, WASH.classifier.z);
    this.group.add(this.cls);
    this.clsCollider = { type: "box", x: WASH.classifier.x, z: WASH.classifier.z, hw: 0.5, hd: 0.4, rot: 0 };
    // the world bucket
    this.worldBucket = M.bucket();
    this.group.add(this.worldBucket);
    // in the hands (first-person pass)
    this.handBucket = M.bucket();
    this.handPan = M.pan({ hand: true });
    this.handSieve = new THREE.Group();                        // nothing drawn: the gloves on the (world) frame's handles
    this._sync();
  }

  // what is visible where (after a purchase / load)
  _sync() {
    const has = (id) => this.owned.has(id);
    this.restPan.visible = has("pan") && this.work !== "pan";
    this.cls.visible = has("classifier");
    const cIdx = this.world.colliders.indexOf(this.clsCollider);
    if (has("classifier") && cIdx < 0) this.world.colliders.push(this.clsCollider);
    if (!has("classifier") && cIdx >= 0) this.world.colliders.splice(cIdx, 1);
    const ups = this.upgrades();
    this.capacityMl = Math.round(BUCKET_ML * (ups.has("bucket.large") ? 1.4 : 1));
    this.bucketScale = ups.has("bucket.large") ? 1.12 : 1;
    this.worldBucket.scale.setScalar(this.bucketScale);
    this.handBucket.scale.setScalar(this.bucketScale);
    this.recoveryMul = ups.has("pan.riffles") ? 1.12 : 1;
    this.handPan.userData.riffles.visible = this.restPan.userData.riffles.visible = ups.has("pan.riffles");
    this.worldBucket.visible = !!this.bucket && !this.bucket.carried;
    this._placeBucket();
    this._fills();
  }

  ownedList() { return ["bucket", "pan", "classifier"].filter((id) => this.owned.has(id)); }

  // loading: every part once through the GPU (fill surfaces, heap, stones, flakes - all
  // hidden at first), so nothing is uploaded the first time a bucket fills
  warmup(on) {
    const w = this._warm || (this._warm = []);
    if (on) {
      const meshes = [this.worldBucket.userData.fill, this.handBucket.userData.fill, this.cls.userData.heap, this.cls.userData.conc,
        this.restPan.userData.mud, this.restPan.userData.water, this.handPan.userData.mud, this.handPan.userData.water, this.restPan.userData.riffles, this.handPan.userData.riffles];
      for (const m of meshes) { w.push([m, m.visible]); m.visible = true; }
      for (const im of [this.cls.userData.stones, this.handPan.userData.pebbles, this.handPan.userData.flakes, this.restPan.userData.pebbles, this.restPan.userData.flakes]) {
        w.push([im, im.visible, im.count]);
        im.count = Math.max(1, im.count);
      }
    } else {
      for (const [m, v, c] of w) { m.visible = v; if (c != null) m.count = c; }
      w.length = 0;
    }
  }

  // a purchase: the thing appears on the claim
  grant(id) {
    if (!["bucket", "pan", "classifier"].includes(id) || this.owned.has(id)) return false;
    this.owned.add(id);
    if (id === "bucket") this.bucket = { x: WASH.supplyDrop.x, z: WASH.supplyDrop.z, ry: 0.3, carried: false, batch: this._batch(STAGE.RAW) };
    this._sync();
    return true;
  }

  applyUpgrades() { this._sync(); }

  _placeBucket() {
    const b = this.bucket;
    if (!b || b.carried) return;
    this.worldBucket.position.set(b.x, this.world.groundAt(b.x, b.z), b.z);
    this.worldBucket.rotation.y = b.ry;
  }

  get carrying() { return !!(this.bucket && this.bucket.carried); }
  get bucketMl() { return this.bucket ? this.bucket.batch.volumeMl : 0; }
  get bucketKg() { return this.bucket ? this.bucket.batch.massG / 1000 : 0; }
  bucketAtWash() { const b = this.bucket; return !!(b && !b.carried && Math.hypot(b.x - WASH.bucketSpot.x, b.z - WASH.bucketSpot.z) < 0.9); }

  // walking speed with what you carry (a full bucket: a little slower)
  speedFactor() {
    if (!this.carrying) return 1;
    return 1 - FULL_SLOW * Math.min(1.4, this.bucketKg / 16);
  }

  // ------------------------------------------------------------ digging into the bucket

  /**
   * A dig's material (goldrush-mining.js result): into the bucket when one
   * stands within reach on the ground and has room - otherwise it is spoil
   * (its visible finds are discovered as always; its fine gold is lost to
   * the spoil heap - booked). Returns the finds the caller discovers
   * directly: { finds, count, intoMl, spilledMl }.
   */
  collect(r, player, source) {
    const out = this._out || (this._out = { finds: [], count: 0, intoMl: 0, spilledMl: 0, intoG: 0, spilledG: 0, intoUg: 0 });
    out.finds = r.finds; out.count = r.findCount; out.intoMl = 0; out.spilledMl = 0; out.intoG = 0; out.spilledG = 0; out.intoUg = 0;
    if (!r.ok || r.kind !== "dig" || !(r.removedVolume > 0)) return out;
    const b = this.bucket;
    const room = b && !b.carried && Math.hypot(b.x - player.x, b.z - player.z) <= REACH ? this.capacityMl - b.batch.volumeMl : 0;
    if (room <= 0) { this.ledger.spoilFineUg += int(r.fineUg); return out; }
    const dig = batchFromDig(r, source, this.nextBatch++);
    const total = dig.volumeMl;
    let part = dig;
    if (dig.volumeMl > room) part = dig.take(room, this.nextBatch++);
    this.ledger.inUg += part.goldUg; this.ledger.inFineUg += part.fineUg; this.ledger.inG += part.massG; this.ledger.inMl += part.volumeMl;
    out.intoMl = part.volumeMl; out.intoG = part.massG; out.intoUg = part.goldUg;
    b.batch.absorb(part);
    // what did not fit spills: its pieces are found like any dig, its fine gold is spoil
    if (part !== dig && dig.volumeMl > 0) {
      out.spilledMl = dig.volumeMl;
      out.spilledG = dig.massG;
      this.ledger.spoilFineUg += dig.fineUg;
      const keep = new Set(dig.finds.map((f) => f.key));
      out.finds = []; out.count = 0;
      for (let i = 0; i < r.findCount; i++) if (keep.has(r.finds[i].key)) { out.finds.push(r.finds[i]); out.count++; }
    } else { out.finds = []; out.count = 0; }
    if (total > 0) this._fills();
    this.fullNow = b.batch.volumeMl >= this.capacityMl - 50;
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
    const b = this.bucket;
    if (b && b.carried) {
      if (near(WASH.bucketSpot, 2.4)) return { id: "bucket-wash", action: "Eimer am Waschplatz abstellen", short: "ABSTELLEN" };
      return { id: "bucket-drop", action: "Eimer abstellen", short: "ABSTELLEN" };
    }
    if (this.owned.has("pan") && near(WASH.panSpot, USE_R) && facing(WASH.trough.x, WASH.panSpot.z) > 0.3) {
      if (this.pan.batch.volumeMl > 0 || this.pan.batch.goldUg > 0) return { id: "pan-work", action: "Weiter waschen", short: "WASCHEN" };
      if (this.tub.volumeMl > 0) return { id: "pan-fill", action: "Goldpfanne mit Konzentrat füllen", short: "WASCHEN" };
      if (this.bucketAtWash() && this.bucket.batch.volumeMl > 0) return { id: "pan-fill", action: "Goldpfanne aus dem Eimer füllen", short: "WASCHEN" };
      if (!this.bucket || !(b && b.batch.volumeMl > 0)) return { id: "pan-none", action: "Erst Erde im Eimer herbringen", short: "", disabled: true };
      return { id: "pan-none", action: "Den Eimer hier am Waschplatz abstellen", short: "", disabled: true };
    }
    if (this.owned.has("classifier") && near(WASH.sieveSpot, USE_R) && facing(WASH.classifier.x, WASH.sieveSpot.z) > 0.3) {
      if (this.sieve.batch.volumeMl > 0) return { id: "sieve-work", action: "Weiter sieben", short: "SIEBEN" };
      if (this.bucketAtWash() && this.bucket.batch.volumeMl > 0) {
        if (this.tub.volumeMl >= TUB_ML - 500) return { id: "sieve-full", action: "Die Wanne ist voll – erst waschen", short: "", disabled: true };
        return { id: "sieve-load", action: "Eimer aufs Sieb kippen", short: "SIEBEN" };
      }
      return { id: "sieve-none", action: "Erst einen vollen Eimer herbringen", short: "", disabled: true };
    }
    if (b && near(b, PICK_R) && facing(b.x, b.z) > 0.55) {
      const l = (b.batch.volumeMl / 1000).toFixed(1).replace(".", ",");
      return { id: "bucket-pick", action: `Eimer aufnehmen (${l} l)`, short: "AUFNEHMEN" };
    }
    return null;
  }

  /**
   * Do it. -> a short result for the HUD / sounds:
   * { ok, kind: "pick" | "drop" | "work" | ..., text }
   */
  act(id, player, ground) {
    const b = this.bucket;
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
    if (id === "pan-fill") return this.fillPan() ? { ok: true, kind: "work" } : { ok: false };
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

  // the pan takes up to 2,5 l: concentrate from the tub first, else raw from the bucket
  fillPan() {
    if (this.pan.batch.volumeMl > 0 || this.pan.batch.goldUg > 0) { this.startWork("pan"); return true; }
    let src = null;
    if (this.tub.volumeMl > 0) src = this.tub;
    else if (this.bucketAtWash() && this.bucket.batch.volumeMl > 0) src = this.bucket.batch;
    if (!src) return false;
    const load = src.take(PAN_CAPACITY_ML, this.nextBatch++);
    load.stage = src === this.tub ? STAGE.CONCENTRATE : STAGE.RAW;
    // tiny rest volumes (rounding) go along with the last load
    if (src.volumeMl < 60) load.absorb(src);
    this.pan.batch = load;
    this.pan.progress = 0;
    this._fills();
    this.startWork("pan");
    return true;
  }

  // the bucket (up to the screen's capacity) onto the classifier
  loadSieve() {
    if (!this.bucketAtWash() || this.bucket.batch.volumeMl <= 0) return false;
    if (this.sieve.batch.volumeMl > 0) { this.startWork("sieve"); return true; }
    const load = this.bucket.batch.take(CLASSIFIER_ML, this.nextBatch++);
    if (this.bucket.batch.volumeMl < 60) load.absorb(this.bucket.batch);
    this.sieve.batch = load;
    this.sieve.progress = 0;
    this._fills();
    this.startWork("sieve");
    return true;
  }

  startWork(kind) {
    if (kind === "pan") {
      this.pan.need = panSeconds(this.pan.batch);
      this.panDone = this.pan.progress >= 1;
      this.reveal = this.panDone ? this._revealOf(this.pan.batch) : null;
      this._panLook(true);
    } else this.sieve.need = sieveSeconds(this.sieve.batch);
    this.work = kind;
    this._sync();
    this._fills();
  }

  // stop working (E / pause / leave): what is in the pan or on the screen stays there
  stopWork() {
    if (!this.work) return;
    this.work = null;
    if (this.hands && !this.carrying) this.hands.setHeld(null);
    this._sync();
  }

  // where the camera is while working (the engine eases the player there)
  workPose() {
    if (this.work === "pan") return { x: WASH.panSpot.x, z: WASH.panSpot.z, yaw: WASH.panSpot.yaw, pitch: -0.82 };
    if (this.work === "sieve") return { x: WASH.sieveSpot.x, z: WASH.sieveSpot.z, yaw: WASH.sieveSpot.yaw, pitch: -0.72 };
    return null;
  }

  /**
   * Work input this frame: the look movement (radians) the player made.
   * Panning wants circling (any movement swirls), sieving a shake (mostly
   * sideways). Capped: a load takes its seconds. -> event or null:
   * "pan-ready" (gold shows, collect it) | "sieved" ({ ...result })
   */
  input(dx, dy, dt) {
    if (!this.work) return null;
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
        return "pan-ready";
      }
      return null;
    }
    // sieve
    const side = Math.abs(dx) + Math.abs(dy) * 0.4;
    this.swirlK += (Math.min(1, side / Math.max(1e-4, dt) / 1.2) - this.swirlK) * Math.min(1, dt * 8);
    this.shakeX = Math.sin(this.time * 40) * 0.022 * this.swirlK;
    const need = this.sieve.need;
    const dp = Math.min(dt / need, side / (need * 1.0));
    this.sieve.progress = Math.min(1, this.sieve.progress + dp);
    if (dp > 0 && this.effects && Math.random() < 0.5) this._fallThrough();
    if (this.sieve.progress >= 1) return this.finishSieve();
    return null;
  }

  // what the end of the pan will show (gold pieces + fine gold as flakes)
  _revealOf(batch) {
    const rec = panRecovery(batch.stage, this.recoveryMul);
    return { fineUg: Math.floor(batch.fineUg * rec), finds: batch.finds.length, findsUg: batch.findsUg, nugget: batch.finds.some((f) => f.cls === FIND.NUGGET) };
  }

  /**
   * COLLECT the gold left in the pan: one transaction - recovered gold into
   * the pouch, the rest (light material + unrecovered fine gold) to the
   * tailings, the pan empty. -> { ok, cents, ug, fineUg, pieces }
   */
  finishPan() {
    if (!this.panDone) return { ok: false };
    const load = this.pan.batch;
    const rec = panRecovery(load.stage, this.recoveryMul);
    const g = panLoad(load, rec, this.nextBatch++);
    const got = this.economy.recover(g.fineUg, g.finds);
    const L = this.ledger;
    L.recoveredUg += got.ug; L.recoveredFineUg += g.fineUg;
    L.tailUg += g.tails.goldUg; L.tailG += g.tails.massG; L.tailMl += g.tails.volumeMl;
    L.panLoads++;
    this.pan.batch = this._batch(STAGE.RAW);
    this.pan.progress = 0;
    this.panDone = false;
    this.reveal = null;
    this.stopWork();
    this._fills();
    return { ok: true, cents: got.cents, ug: got.ug, fineUg: g.fineUg, pieces: got.pieces, stage: load.stage };
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
    this.sieve.dumpT = 1.6;
    this.stopWork();
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
    const M = this.models;
    // world bucket + the one in your hand
    for (const g of [this.worldBucket, this.handBucket]) M.setBucketFill(g, this.bucket ? this.bucket.batch.volumeMl / (this.bucketScale ** 3) : 0);
    // classifier heap and the tub's concentrate
    const u = this.cls.userData;
    const sv = this.sieve.batch.volumeMl * (1 - this.sieve.progress * 0.6);
    u.heap.visible = sv > 100;
    if (u.heap.visible) { const r = 0.12 + Math.cbrt(sv / 1e6) * 0.7; u.heap.scale.set(r, Math.max(0.02, r * 0.45), r * 0.85); }
    u.conc.visible = this.tub.volumeMl > 80;
    if (u.conc.visible) u.conc.position.y = 0.035 + Math.min(1, this.tub.volumeMl / TUB_ML) * (u.TH - 0.06);
    this._stonesOnScreen();
  }

  _stonesOnScreen() {
    const st = this.cls.userData.stones, n = this.sieve.batch.volumeMl > 0 ? Math.min(36, Math.round(this.sieve.batch.volumeMl / 600)) : this.sieve.stones;
    if (st.count === n && !this._stoneDirty) return;
    this._stoneDirty = false;
    st.count = n;
    const m = this._m || (this._m = new this.THREE.Matrix4()), q = new this.THREE.Quaternion(), e = new this.THREE.Euler();
    for (let i = 0; i < n; i++) {
      const a = i * 2.39996, r = 0.05 + 0.28 * Math.sqrt((i + 0.5) / 36);
      const s = 0.016 + ((i * 7919) % 13) / 13 * 0.02;
      e.set(i, i * 1.7, i * 0.3);
      q.setFromEuler(e);
      m.compose(new this.THREE.Vector3(Math.cos(a) * r * 1.1, 0.02 + s * 0.6, Math.sin(a) * r * 0.85), q, new this.THREE.Vector3(s, s * 0.8, s));
      st.setMatrixAt(i, m);
    }
    st.instanceMatrix.needsUpdate = true;
  }

  // the pan in your hands: mud level, water, pebbles leaving, gold showing
  _panLook(reset) {
    const P = this.handPan.userData, b = this.pan.batch, u = this.pan.progress;
    if (reset) this._panStart = { ml: Math.max(1, b.volumeMl), stones: Math.min(18, Math.round((b.comp[2] + b.comp[3]) / 120 + b.comp[1] / 400)), stage: b.stage };
    const st = this._panStart || { ml: 1, stones: 0, stage: STAGE.RAW };
    // the material washes down to a thin dark layer of heavy sand
    const left = 1 - 0.9 * smooth(0.08, 0.92, u);
    const h = Math.max(0.004, panFillHeight(st.ml * left));
    P.mud.visible = st.ml > 1;
    P.mud.position.y = h;
    const r = panRadius(h) - 0.003;
    P.mud.scale.set(r, 1, r);
    P.mud.rotation.y = this.swirlAngle * 0.35;
    const dark = smooth(0.55, 1, u);
    P.mud.material.color.setHex(st.stage === STAGE.CONCENTRATE ? COLORS.conc : COLORS.raw).lerp(this._c2 || (this._c2 = new this.THREE.Color(COLORS.black)), dark);
    // water: muddy brown first, clearer towards the end
    P.water.visible = st.ml > 1 && u < 0.995;
    const wh = Math.min(0.056, h + 0.018 + 0.012 * smooth(0, 0.12, u));
    P.water.position.y = wh;
    const wr = panRadius(wh) - 0.002;
    P.water.scale.set(wr, 1, wr);
    P.water.rotation.y = this.swirlAngle;
    P.water.material.opacity = 0.42 - 0.2 * smooth(0.5, 1, u);
    P.water.material.color.setRGB(0.3 - 0.06 * u, 0.24 + 0.02 * u, 0.17 + 0.1 * u);
    // pebbles: picked / tossed out as the light stuff goes
    const nPeb = Math.round(st.stones * (1 - smooth(0.15, 0.75, u)));
    this._pebbles(P.pebbles, nPeb, h);
    // gold: shows at the bottom once the sand is thin
    const nFl = this.reveal || u > 0.7 ? this._flakeCount() : 0;
    this._flakes(P.flakes, Math.round(nFl * smooth(0.7, 1, u)), h);
  }

  _flakeCount() {
    const rv = this.reveal || this._revealOf(this.pan.batch);
    return Math.max(rv.fineUg > 0 || rv.finds ? 4 : 0, Math.min(40, Math.round(4 + rv.fineUg / 180 + rv.finds * 3)));
  }

  _pebbles(mesh, n, h) {
    if (mesh.count === n && this._pebH === h) return;
    this._pebH = h;
    mesh.count = n;
    const m = this._m || (this._m = new this.THREE.Matrix4()), q = new this.THREE.Quaternion(), e = new this.THREE.Euler(), v = new this.THREE.Vector3(), s3 = new this.THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const a = i * 2.39996 + this.swirlAngle * 0.3, rr = 0.03 + 0.1 * Math.sqrt((i + 0.5) / 18);
      const s = 0.007 + ((i * 7919) % 11) / 11 * 0.009;
      e.set(i, i * 2.1, 0); q.setFromEuler(e);
      v.set(Math.cos(a) * rr, h + s * 0.5, Math.sin(a) * rr);
      m.compose(v, q, s3.set(s, s * 0.75, s));
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  _flakes(mesh, n, h) {
    if (mesh.count === n && this._flH === h) return;
    this._flH = h;
    mesh.count = n;
    const m = this._m || (this._m = new this.THREE.Matrix4()), q = new this.THREE.Quaternion(), e = new this.THREE.Euler(), v = new this.THREE.Vector3(), s3 = new this.THREE.Vector3();
    const nug = this.reveal && this.reveal.nugget;
    for (let i = 0; i < n; i++) {
      // gold collects in the low side / the riffles: a crescent towards the far rim
      const a = -Math.PI * 0.5 + (((i * 0.618) % 1) - 0.5) * 1.7, rr = 0.05 + 0.08 * (((i * 0.382) % 1));
      const s = nug && i === 0 ? 0.008 : 0.0024 + ((i * 7919) % 7) / 7 * 0.0026;
      e.set(0.1 * i, i * 1.3, 0.05 * i); q.setFromEuler(e);
      v.set(Math.cos(a) * rr, Math.min(h, 0.006) + 0.0015, Math.sin(a) * rr);
      const k = mesh.userData.k || 1;
      m.compose(v, q, s3.set(s * k, s * k, s * k));
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Per frame. Hands: the bucket you carry / the pan you swirl (view space).
   */
  update(dt) {
    this.time += dt;
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
    if (this.work === "pan") {
      if (H.held !== "pan") H.setHeld("pan", this.handPan, HELD_GRIPS.pan);
      const k = this.swirlK, a = this.swirlAngle;
      const pose = this.handPan.userData.pose || (this.handPan.userData.pose = { p: [0, 0, 0], r: [0, 0, 0] });
      pose.p[0] = HELD.pan.p[0] + Math.cos(a * 0.5) * 0.012 * k;
      pose.p[1] = HELD.pan.p[1] + Math.sin(a * 0.5) * 0.006 * k;
      pose.p[2] = HELD.pan.p[2];
      pose.r[0] = HELD.pan.r[0] + Math.sin(a * 0.5) * 0.05 * k;
      pose.r[1] = HELD.pan.r[1];
      pose.r[2] = HELD.pan.r[2] + Math.cos(a * 0.5) * 0.06 * k;
      this._panLook(false);
      // muddy water over the rim while it is swirled
      if (k > 0.25 && this.pan.progress < 0.9 && Math.random() < dt * 14 * k) H.splash && H.splash(this.handPan);
    } else if (this.work === "sieve") {
      if (H.held !== "sieve") H.setHeld("sieve", this.handSieve, HELD_GRIPS.sieve);
      const pose = this.handSieve.userData.pose || (this.handSieve.userData.pose = { p: [0, 0, 0], r: [0, 0, 0] });
      pose.p[0] = HELD.sieve.p[0] - this.shakeX * 1.6; pose.p[1] = HELD.sieve.p[1]; pose.p[2] = HELD.sieve.p[2];
      pose.r[0] = HELD.sieve.r[0]; pose.r[1] = HELD.sieve.r[1]; pose.r[2] = HELD.sieve.r[2];
    } else if (this.carrying) {
      if (H.held !== "bucket") H.setHeld("bucket", this.handBucket, HELD_GRIPS.bucket);
      const pose = this.handBucket.userData.pose || (this.handBucket.userData.pose = { p: [0, 0, 0], r: [0, 0, 0] });
      const sw = Math.sin(this.time * 2.2) * 0.012;
      pose.p[0] = HELD.bucket.p[0]; pose.p[1] = HELD.bucket.p[1]; pose.p[2] = HELD.bucket.p[2];
      pose.r[0] = HELD.bucket.r[0] + sw; pose.r[1] = HELD.bucket.r[1]; pose.r[2] = HELD.bucket.r[2] + sw * 0.6;
    } else if (H.held) H.setHeld(null);
  }

  // ------------------------------------------------------------ save

  serialize() {
    const b = this.bucket;
    return {
      owned: this.ownedList(),
      nextBatch: this.nextBatch,
      bucket: b ? { x: b.x, z: b.z, ry: b.ry, carried: !!b.carried, batch: b.batch.serialize() } : null,
      tub: this.tub.serialize(),
      pan: { batch: this.pan.batch.serialize(), progress: +this.pan.progress.toFixed(3) },
      sieve: { batch: this.sieve.batch.serialize(), progress: +this.sieve.progress.toFixed(3) },
      ledger: { ...this.ledger },
    };
  }

  // gold in containers right now (ledger check)
  goldInContainers() {
    return (this.bucket ? this.bucket.batch.goldUg : 0) + this.tub.goldUg + this.pan.batch.goldUg + this.sieve.batch.goldUg;
  }

  massInContainers() {
    return (this.bucket ? this.bucket.batch.massG : 0) + this.tub.massG + this.pan.batch.massG + this.sieve.batch.massG;
  }

  dispose() {
    if (this.hands && this.hands.held) this.hands.setHeld(null);
    const i = this.world.colliders.indexOf(this.clsCollider);
    if (i >= 0) this.world.colliders.splice(i, 1);
    this.scene.remove(this.group);
    this.models.dispose();
  }
}
