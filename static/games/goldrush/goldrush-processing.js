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

import { MaterialBatch, STAGE, batchFromDig, classify, panLoad, panSeconds, sieveSeconds, washRecovery, PAN_CAPACITY_ML, BOWL_CAPACITY_ML, BOWL_REST_ML, pour } from "./goldrush-material.js";
import { ProcessModels, bucketFillHeight, washShape } from "./goldrush-processmodels.js";
import { MechModels, BARROW } from "./goldrush-mechmodels.js";
import { Wheelbarrow } from "./goldrush-wheelbarrow.js";
import { Sluice, SLUICE_AT, SLUICE_SPOTS, CLEAN_S } from "./goldrush-sluice.js";
import { AutoModels, BULK } from "./goldrush-automodels.js";
import { BulkHopper, Feeder, BULK_AT, AUTO_SPOTS, inAutomationFoot } from "./goldrush-automation.js";
import { transfer, roomOf } from "./goldrush-transfer.js";
import { FIND } from "./goldrush-resources.js";
import { findSize } from "./goldrush-loot.js";
import { centsForMass } from "./goldrush-economy.js";
import { mergeStatic } from "./goldrush-merge.js";

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
export const EQUIP = ["bucket", "pan", "classifier", "wheelbarrow", "sluice", "bulkhopper", "feeder"];
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
// how the gloves hold them (in the object's frame; like GRIPS in goldrush-hand.js:
// a left-hand grip is written as for the right hand - it is mirrored)
export const HELD_GRIPS = {
  bucket: [{ side: 1, pos: [0, 0.428, 0], axis: "x", roll: -0.2, flip: 1 }],
  pan: [{ side: 1, pos: [0.2, 0.05, 0.02], axis: "z", roll: 1.75, flip: 1 }, { side: -1, pos: [0.2, 0.05, 0.02], axis: "z", roll: 1.75, flip: 1 }],
  bowl: [{ side: 1, pos: [0.165, 0.07, 0.02], axis: "z", roll: 1.75, flip: 1 }, { side: -1, pos: [0.165, 0.07, 0.02], axis: "z", roll: 1.75, flip: 1 }],
  sieve: [{ side: 1, pos: [0.16, 0, 0], axis: "z", roll: 2.4, flip: 1 }, { side: -1, pos: [0.16, 0, 0], axis: "z", roll: 2.4, flip: 1 }],
  // the barrow's grips: placed every frame where the world grips are seen (see _barrowHands)
  barrow: [{ side: 1, pos: [0.2, 0, 0], axis: "x", roll: 0, flip: 1 }, { side: -1, pos: [0.2, 0, 0], axis: "x", roll: 0, flip: 1 }],
};
const COLORS = { raw: 0x8a6a4c, conc: 0x6a5846, black: 0x3a332c };
// the feeder lever: what [E] sets next
const MODE_TEXT = { auto: "Dosierer auf AUTO – läuft, solange das Wasser an ist", on: "Dosierer einschalten (AN)", stop: "Dosierer ausschalten" };
const MODE_SHORT = { auto: "AUTO", on: "START", stop: "STOP" };
const BULK_KIT = { x: BULK_AT.x + 1.45, z: BULK_AT.z - 1.2 };
const SLUICE_LEN = 2.7;               // SLUICE.len (goldrush-mechmodels.js): where the wet ground lies

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
    this._build();
    this.barrow = this.owned.has("wheelbarrow") ? new Wheelbarrow(THREE, this.scene, this.world, this.mech, s.wheelbarrow, WASH.barrowDrop) : null;
    this.sluice = this.owned.has("sluice") ? this._newSluice(s.sluice) : null;
    this.bulk = this.owned.has("bulkhopper") ? new BulkHopper(THREE, this.scene, this.world, this.auto, s.bulkHopper, this._autoCtx()) : null;
    this.feeder = this.owned.has("feeder") && this.bulk ? new Feeder(THREE, this.scene, this.world, this.auto, s.feeder, this._autoCtx()) : null;
    if (this.owned.has("feeder") && !this.bulk) this.owned.delete("feeder");
    this._refitBarrow();                                       // parked on the platform: it stands on the deck (made just now)
  }

  // a parked barrow onto whatever the ground is now (decks appear / go with the bulk hopper)
  _refitBarrow() { const w = this.barrow; if (w && !w.pushing && !w.dump) w.fit(null); }

  _autoCtx() {
    return this._actx || (this._actx = { nextId: () => this.nextBatch++, upgrades: this.upgrades, sluice: () => this.sluice, bulk: () => this.bulk, warm: () => { this.warmPending = true; } });
  }

  _newSluice(saved) {
    return new Sluice(this.THREE, this.scene, this.world, this.mech, saved, {
      ledger: this.ledger, economy: this.economy, nextId: () => this.nextBatch++, upgrades: this.upgrades, warm: () => { this.warmPending = true; },
    });
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
    this._wetGround();
    this.world.colliders.push({ type: "box", x: WASH.trough.x, z: WASH.trough.z, hw: 0.34, hd: 1.06, rot: 0 });
    // the pan lying on the trough's near rim (when owned and not in your hands)
    this.restPan = M.pan();
    this.restPan.position.set(WASH.trough.x + 0.12, 0.43, WASH.trough.z - 0.7);
    this.restPan.rotation.set(0, 0, -0.08);
    this.group.add(this.restPan);
    // phase 7A: the wooden wash bowl - part of the wash place from the start, on the trough's rim
    this.restBowl = M.bowl();
    this.restBowl.position.set(WASH.trough.x + 0.13, 0.43, WASH.trough.z + 0.32);
    this.restBowl.rotation.set(0.05, 0.6, -0.1);
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
    this.handBarrow = new THREE.Group();                       // nothing drawn: the gloves on the barrow's (world) grips
    this._barrowGrips = HELD_GRIPS.barrow.map((g) => ({ ...g, pos: [...g.pos] }));
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
    const SA = SLUICE_AT;
    // [x, z, size (m), stretch, puddle?, which: wash | sluice]
    const spots = [[WASH.trough.x + 0.55, WASH.trough.z - 0.1, 2.0, 1.4, 0, "wash"], [WASH.panSpot.x - 0.05, WASH.panSpot.z - 0.35, 0.55, 1.2, 1, "wash"],
      [WASH.classifier.x + 0.35, WASH.classifier.z - 0.1, 1.4, 1.2, 0, "wash"], [-19.5 + 0.9, 1.8 - 0.9, 0.9, 1, 0, "wash"],
      [SA.x + SLUICE_LEN + 0.2, SA.z + 0.55, 2.2, 1.5, 0, "sluice"], [SA.x + SLUICE_LEN - 0.4, SA.z + 0.95, 0.6, 1.4, 1, "sluice"],
      [SA.x - 0.25, SA.z + 0.95, 1.3, 1.2, 0, "sluice"], [SA.x + 1.3, SA.z + 0.75, 0.45, 1.6, 1, "sluice"]];
    // one mesh per (place, kind) - four draws instead of eight (phase 7A); they toggle as groups
    const groups = new Map();
    spots.forEach(([x, z, size, st, puddle, which], i) => {
      const key = `${which}:${puddle}`;
      if (!groups.has(key)) groups.set(key, { which, puddle, parts: [] });
      const m = new THREE.Mesh(geo, this._wetMats[puddle]);
      m.position.set(x, 0.004 + i * 0.0004, z);
      m.scale.set(size * st, 1, size);
      m.rotation.y = i * 1.37;
      groups.get(key).parts.push(m);
    });
    this._wetGeos = [];
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
      const mesh = new THREE.Mesh(g, this._wetMats[puddle]);
      mesh.renderOrder = 1;
      mesh.userData = { which, puddle: !!puddle, patches: parts.length };
      this.group.add(mesh);
      return mesh;
    });
  }

  // which wet patches show: the wash place always, the sluice's once it ran; LOW quality: no puddles
  _wetSync() {
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
    this.capacityMl = Math.round(BUCKET_ML * (ups.has("bucket.large") ? 1.4 : 1));
    this.bucketScale = ups.has("bucket.large") ? 1.12 : 1;
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
      const meshes = [this.worldBucket.userData.fill, this.handBucket.userData.fill, this.cls.userData.heap, this.cls.userData.conc,
        this.restPan.userData.mud, this.restPan.userData.water, this.handPan.userData.mud, this.handPan.userData.water, this.restPan.userData.riffles, this.handPan.userData.riffles,
        this.restBowl.userData.mud, this.restBowl.userData.water, this.handBowl.userData.mud, this.handBowl.userData.water];
      for (const m of meshes) { w.push([m, m.visible]); m.visible = true; }
      for (const im of [this.cls.userData.stones, this.handPan.userData.pebbles, this.handPan.userData.flakes, this.restPan.userData.pebbles, this.restPan.userData.flakes,
        this.handBowl.userData.pebbles, this.handBowl.userData.flakes]) {
        w.push([im, im.visible, im.count]);
        im.count = Math.max(1, im.count);
      }
    } else {
      for (const [m, v, c] of w) { m.visible = v; if (c != null) m.count = c; }
      w.length = 0;
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
    const roots = [this.barrow && this.barrow.group, sl && sl.root, sl && sl.trayModel, bk && bk.root, bk && bk.rampModel, bk && bk.post, bk && bk.kit, this.feeder && this.feeder.kit];
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
    if (id === "wheelbarrow") this.barrow = new Wheelbarrow(this.THREE, this.scene, this.world, this.mech, null, WASH.barrowDrop);
    if (id === "sluice") this.sluice = this._newSluice(null);           // delivered: boards by the tank, to be built
    if (id === "bulkhopper") this.bulk = new BulkHopper(this.THREE, this.scene, this.world, this.auto, null, this._autoCtx());     // delivered: a pallet by the sluice
    if (id === "feeder") {
      if (!this.bulk) { this.owned.delete(id); return false; }
      this.feeder = new Feeder(this.THREE, this.scene, this.world, this.auto, null, this._autoCtx());                      // delivered: a crate by the control post
    }
    if (["wheelbarrow", "sluice", "bulkhopper", "feeder"].includes(id)) this.warmPending = true;
    this._sync();
    return true;
  }

  applyUpgrades() {
    this._sync();
    if (this.sluice) this.sluice.applyUpgrades();
    if (this.bulk) this.bulk.applyUpgrades();
    if (this.feeder) this.feeder.applyUpgrades();
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
    const room = tgt ? tgt.capacityMl - tgt.batch.volumeMl : 0;
    if (room <= 0) { this.ledger.spoilFineUg += int(r.fineUg); return out; }
    out.into = tgt.kind;
    const dig = batchFromDig(r, source, this.nextBatch++);
    const total = dig.volumeMl;
    let part = dig;
    if (dig.volumeMl > room) part = dig.take(room, this.nextBatch++);
    this.ledger.inUg += part.goldUg; this.ledger.inFineUg += part.fineUg; this.ledger.inG += part.massG; this.ledger.inMl += part.volumeMl;
    this.ledger.inFinds += part.finds.length;
    out.intoMl = part.volumeMl; out.intoG = part.massG; out.intoUg = part.goldUg; out.intoFinds = part.finds.length;
    tgt.batch.absorb(part);
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
    this.fullNow = tgt.batch.volumeMl >= tgt.capacityMl - 50;
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
      if (w.batch.volumeMl > 0 && this._atBulkDump(w, c)) {
        if (this.bulk.buffer.room <= 200) return { id: "barrow-park", action: "Schubkarre abstellen – der Vorratstrichter ist voll", short: "ABSTELLEN" };
        return { id: "bulk-dump", action: "Schubkarre in den Vorratstrichter kippen", short: "AUSKIPPEN" };
      }
      if (sl && sl.installed && w.batch.volumeMl > 0 && Math.hypot(c.x - HOPPER_AT.x, c.z - HOPPER_AT.z) <= 1.5) {
        // a full hopper: set the barrow down here and let the water work it off
        if (sl.hopper.batch.volumeMl >= sl.capacityMl - 200) return { id: "barrow-park", action: "Schubkarre abstellen – der Trichter ist voll", short: "ABSTELLEN" };
        return { id: "barrow-dump", action: "Schubkarre in den Trichter kippen", short: "AUSKIPPEN" };
      }
      return { id: "barrow-park", action: this._atWash(c) ? "Schubkarre am Waschplatz abstellen" : "Schubkarre abstellen", short: "ABSTELLEN" };
    }
    // 2 - carrying the bucket: into the hopper / the barrow, or set it down
    const bk = this.bulk;
    if (b && b.carried) {
      if (b.batch.volumeMl > 0 && bk && bk.installed && near(AUTO_SPOTS.bucket, 0.9) && this.world.groundAt(p.x, p.z) > BULK.deckY - 0.15 && facing(BULK_AT.x, BULK_AT.z) > 0.5) {
        if (bk.buffer.room <= 200) return { id: "bulk-full", action: "Der Vorratstrichter ist voll", short: "", disabled: true };
        return { id: "bucket-bulk", action: "Eimer in den Vorratstrichter kippen", short: "KIPPEN" };
      }
      if (b.batch.volumeMl > 0 && sl && sl.installed && near(SLUICE_SPOTS.feed, 1.5)) {
        if (sl.hopper.batch.volumeMl >= sl.capacityMl - 200) return { id: "hopper-full", action: "Der Trichter ist voll", short: "", disabled: true };
        return { id: "bucket-hopper", action: "Eimer in den Trichter kippen", short: "KIPPEN" };
      }
      if (b.batch.volumeMl > 0 && w && !w.pushing && w.batch.volumeMl < w.capacityMl - 200) {
        const c = w.trayCenter(this._ti || (this._ti = {}));
        if (Math.hypot(c.x - p.x, c.z - p.z) <= 1.7) return { id: "bucket-barrow", action: "Eimer in die Schubkarre kippen", short: "KIPPEN" };
      }
      if (near(WASH.bucketSpot, 2.4)) return { id: "bucket-wash", action: "Eimer am Waschplatz abstellen", short: "ABSTELLEN" };
      return { id: "bucket-drop", action: "Eimer abstellen", short: "ABSTELLEN" };
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
      if (!sl.installed) {
        if (sl.build < 0 && (near(SLUICE_SPOTS.feed, 1.7) || near(SLUICE_SPOTS.clean, 1.7))) return { id: "sluice-build", action: "Waschrinne aufbauen", short: "AUFBAUEN" };
      } else if (near(SLUICE_SPOTS.feed, 1.3) && facing(HOPPER_AT.x, HOPPER_AT.z) > 0.3) {
        if (sl.running) return { id: "sluice-stop", action: "Wasser abstellen", short: "WASSER AUS" };
        return { id: "sluice-start", action: sl.hopper.batch.volumeMl > 0 ? "Wasser anstellen – die Rinne wäscht" : "Wasser anstellen", short: "WASSER AN" };
      } else if (near(SLUICE_SPOTS.clean, 1.3) && facing(SLUICE_AT.x + 1.35, SLUICE_AT.z) > 0.3) {
        if (sl.running) return { id: "sluice-stop", action: "Wasser abstellen (zum Reinigen)", short: "WASSER AUS" };
        if (sl.canClean()) return { id: "sluice-clean", action: sl.riffleLoad >= 1 ? "Riffelmatte reinigen – sie ist voll" : "Riffelmatte reinigen", short: "REINIGEN" };
        return { id: "sluice-empty", action: "In den Riffeln liegt noch nichts", short: "", disabled: true };
      }
    }
    // 4 - washing at the trough: the gold pan, or before it the wooden wash bowl that is always
    // there (heavy concentrate, the tub, a bucket or a barrow at the wash place)
    if (near(WASH.panSpot, USE_R) && facing(WASH.trough.x, WASH.panSpot.z) > 0.3) {
      const T = this.washName();
      if (this.pan.batch.volumeMl > 0 || this.pan.batch.goldUg > 0) return { id: "pan-work", action: "Weiter waschen", short: "WASCHEN" };
      if (sl && (sl.tray.batch.volumeMl > 0 || sl.tray.batch.goldUg > 0)) return { id: "pan-fill", action: `${T} mit Schwerkonzentrat füllen`, short: "WASCHEN" };
      if (this.tub.volumeMl > 0) return { id: "pan-fill", action: `${T} mit Konzentrat füllen`, short: "WASCHEN" };
      const src = this._washSource();
      if (src) return { id: "pan-fill", action: src.kind === "wheelbarrow" ? `${T} aus der Schubkarre füllen` : `${T} aus dem Eimer füllen`, short: "WASCHEN" };
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
    if (id === "barrow-dump" && w && w.pushing && sl && sl.installed) {
      const ok = w.startDump(sl.hopper, (ml) => { if (this.onDumped) this.onDumped(ml); }, this.nextBatch++);
      return ok ? { ok: true, kind: "dump" } : { ok: false };
    }
    const bk = this.bulk, fd = this.feeder;
    if (id === "bulk-dump" && w && w.pushing && bk && bk.installed) {
      const ok = w.startDump(bk.buffer, (ml) => { bk.stats.inMl += ml; if (ml > 0) bk.stats.loads++; bk._fill(); if (this.onDumped) this.onDumped(ml, "bulk"); }, this.nextBatch++);
      return ok ? { ok: true, kind: "dump" } : { ok: false };
    }
    if (id === "bucket-bulk" && b && b.carried && bk && bk.installed) {
      const ml = bk.pourIn({ batch: b.batch, capacityMl: this.capacityMl });
      this._fills();
      return ml > 0 ? { ok: true, kind: "feed", ml, into: "bulk" } : { ok: false };
    }
    if (id === "bulk-build" && bk) { const ok = bk.startBuild(); if (ok) this._clearAutomationFoot(); return ok ? { ok: true, kind: "build", what: "bulk" } : { ok: false }; }
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
    this._stoneDirty = true;
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
    if (id === "sluice" && this.sluice) {
      const sl = this.sluice;
      this._devTail(sl.hopper.batch); this._devTail(sl.riffles); this._devTail(sl.tray.batch);
      sl.dispose(this.scene); this.sluice = null;
    }
    if (id === "pan") { this._devTail(this.pan.batch); this.pan.batch = this._batch(STAGE.RAW); this.pan.progress = 0; this.panDone = false; this.reveal = null; }
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
    else { const w = this._washSource(); if (w) src = w.batch; }
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
      this.pan.need = panSeconds(this.pan.batch, this.pan.tool);
      this.panDone = this.pan.progress >= 1;
      this.reveal = this.panDone ? this._revealOf(this.pan.batch) : null;
      this._panLook(true);
    } else if (kind === "clean") this.sluice.clean.progress = 0;
    else this.sieve.need = sieveSeconds(this.sieve.batch);
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
    if (this.work === "pan") return { x: WASH.panSpot.x, z: WASH.panSpot.z, yaw: WASH.panSpot.yaw, pitch: this.pan.tool === "bowl" ? -0.78 : -0.82 };
    if (this.work === "sieve") return { x: WASH.sieveSpot.x, z: WASH.sieveSpot.z, yaw: WASH.sieveSpot.yaw, pitch: -0.72 };
    if (this.work === "clean") return { x: SLUICE_SPOTS.clean.x, z: SLUICE_SPOTS.clean.z, yaw: SLUICE_SPOTS.clean.yaw, pitch: -0.82 };
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
    if (this.work === "clean") {                    // brushing the mat out: back and forth
      const side = Math.abs(dx) + Math.abs(dy) * 0.4, c = this.sluice.clean;
      this.swirlK += (Math.min(1, side / Math.max(1e-4, dt) / 1.2) - this.swirlK) * Math.min(1, dt * 8);
      this.shakeX = Math.sin(this.time * 18) * 0.03 * this.swirlK;
      c.progress = Math.min(1, c.progress + Math.min(dt / CLEAN_S, side / CLEAN_S));
      if (c.progress >= 1) { const r = this.sluice.finishClean(); this.stopWork(); return { kind: "cleaned", ...r }; }
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

  // what the end of the pan will show: the fine gold it keeps, and its visible pieces at their own
  // size (FIND_LOOK - a EUR 1,50 wash is a sprinkle of specks, not a crescent of flakes)
  _revealOf(batch) {
    const rec = washRecovery(this.pan.tool, batch.stage, this.recoveryMul);
    return { fineUg: Math.floor(batch.fineUg * rec), finds: batch.finds.length, findsUg: batch.findsUg, nugget: batch.finds.some((f) => f.cls === FIND.NUGGET),
      pieces: batch.finds.slice(0, 6).map((f, i) => findSize(f.cls, centsForMass(f.ug), ((i * 0.37) % 1))) };
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
    this.pan.batch = this._batch(STAGE.RAW);
    this.pan.progress = 0;
    this.panDone = false;
    this.reveal = null;
    this.stopWork();
    this._fills();
    return { ok: true, cents: got.cents, ug: got.ug, fineUg: g.fineUg, pieces: got.pieces, stage: load.stage, tool };
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

  // the pan (or the wash bowl) in your hands: mud level, water, pebbles leaving, gold showing
  _washHand() { return this.pan.tool === "bowl" ? this.handBowl : this.handPan; }

  _panLook(reset) {
    const P = this._washHand().userData, b = this.pan.batch, u = this.pan.progress;
    const S = washShape(this.pan.tool), k = this.pan.tool === "bowl" ? 0.78 : 1;
    if (reset) this._panStart = { ml: Math.max(1, b.volumeMl), stones: Math.min(18, Math.round((b.comp[2] + b.comp[3]) / 120 + b.comp[1] / 400)), stage: b.stage };
    const st = this._panStart || { ml: 1, stones: 0, stage: STAGE.RAW };
    // the material washes down to a thin dark layer of heavy sand
    const left = 1 - 0.9 * smooth(0.08, 0.92, u);
    const h = Math.max(0.004, S.fill(st.ml * left));
    P.mud.visible = st.ml > 1;
    P.mud.position.y = S.base + h;
    const r = S.radius(h) - 0.003;
    P.mud.scale.set(r, 1, r);
    P.mud.rotation.y = this.swirlAngle * 0.35;
    const dark = smooth(0.55, 1, u);
    P.mud.material.color.setHex(st.stage === STAGE.CONCENTRATE ? COLORS.conc : COLORS.raw).lerp(this._c2 || (this._c2 = new this.THREE.Color(COLORS.black)), dark);
    // water: muddy brown first, clearer towards the end
    P.water.visible = st.ml > 1 && u < 0.995;
    const wh = Math.min(S.depth - 0.002, h + 0.018 + 0.012 * smooth(0, 0.12, u));
    P.water.position.y = S.base + wh;
    const wr = S.radius(wh) - 0.002;
    P.water.scale.set(wr, 1, wr);
    P.water.rotation.y = this.swirlAngle;
    P.water.material.opacity = 0.42 - 0.2 * smooth(0.5, 1, u);
    P.water.material.color.setRGB(0.3 - 0.06 * u, 0.24 + 0.02 * u, 0.17 + 0.1 * u);
    // pebbles: picked / tossed out as the light stuff goes
    const nPeb = Math.round(st.stones * (1 - smooth(0.15, 0.75, u)));
    this._pebbles(P.pebbles, nPeb, h, S.base, k);
    // gold: shows at the bottom once the sand is thin
    const nFl = this.reveal || u > 0.7 ? this._flakeCount() : 0;
    this._flakes(P.flakes, Math.round(nFl * smooth(0.7, 1, u)), h, S.base, k);
  }

  // fine gold shows as specks: a few for a trace, a few dozen for a good load (the number grows with
  // the root of the mass - ~28 for 17 mg); the visible pieces come on top (at most 6 + 34 = 40 drawn)
  _flakeCount() {
    const rv = this.reveal || this._revealOf(this.pan.batch);
    const specks = rv.fineUg > 0 ? Math.max(3, Math.min(34, Math.round(3 + 6 * Math.sqrt(rv.fineUg / 1000)))) : 0;
    return specks + rv.pieces.length;
  }

  _pebbles(mesh, n, h, base = 0, k = 1) {
    if (mesh.count === n && this._pebH === h) return;
    this._pebH = h;
    mesh.count = n;
    const m = this._m || (this._m = new this.THREE.Matrix4()), q = new this.THREE.Quaternion(), e = new this.THREE.Euler(), v = new this.THREE.Vector3(), s3 = new this.THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const a = i * 2.39996 + this.swirlAngle * 0.3, rr = (0.03 + 0.1 * Math.sqrt((i + 0.5) / 18)) * k;
      const s = 0.007 + ((i * 7919) % 11) / 11 * 0.009;
      e.set(i, i * 2.1, 0); q.setFromEuler(e);
      v.set(Math.cos(a) * rr, base + h + s * 0.5, Math.sin(a) * rr);
      m.compose(v, q, s3.set(s, s * 0.75, s));
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  _flakes(mesh, n, h, base = 0, kr = 1) {
    if (mesh.count === n && this._flH === h) return;
    this._flH = h;
    mesh.count = n;
    const m = this._m || (this._m = new this.THREE.Matrix4()), q = new this.THREE.Quaternion(), e = new this.THREE.Euler(), v = new this.THREE.Vector3(), s3 = new this.THREE.Vector3();
    const rv = this.reveal || this._revealOf(this.pan.batch), pieces = rv.pieces || [];
    for (let i = 0; i < n; i++) {
      // gold collects in the low side / the riffles: a crescent towards the far rim
      const a = -Math.PI * 0.5 + (((i * 0.618) % 1) - 0.5) * 1.7, rr = (0.05 + 0.08 * (((i * 0.382) % 1))) * kr;
      // its true size (m): the pieces first, then the fine gold - specks of 1,3-2,2 mm (drawn, a little over life)
      const s = i < pieces.length ? pieces[i] : 0.0013 + ((i * 7919) % 7) / 7 * 0.0009;
      e.set(0.1 * i, i * 1.3, 0.05 * i); q.setFromEuler(e);
      v.set(Math.cos(a) * rr, base + Math.min(h, 0.006) + s * 0.3, Math.sin(a) * rr);
      m.compose(v, q, s3.set(s, s, s));
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Per frame. Hands: the bucket you carry / the pan you swirl (view space).
   */
  update(dt, player = null) {
    this.time += dt;
    if (this.barrow) this.barrow.update(dt, this.barrow.pushing ? player : null);
    if (this.sluice) {
      if (!this.simWork) this.sluice.process(dt);              // (tests simulating a pan load: the machine has its own clock there)
      const near = player ? Math.hypot(player.x - (SLUICE_AT.x + 1.2), player.z - SLUICE_AT.z) < 9 : false;
      this.sluice.lowDetail = !!(this.ctx.quality && this.ctx.quality() === "low");
      this.sluice.update(dt, near, this.onSound);
      if ((this._wetT = (this._wetT || 0) - dt) <= 0) { this._wetT = 1; this._wetSync(); }
    }
    // phase 7: the feeder / the hand gate refill what the sluice took (downstream first)
    if (!this.simWork) { if (this.feeder) this.feeder.process(dt); if (this.bulk) this.bulk.process(dt); }
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
    if (this.work === "pan") {
      const tool = this.pan.tool, obj = this._washHand(), hp = HELD[tool];
      if (H.held !== tool) H.setHeld(tool, obj, HELD_GRIPS[tool]);
      const k = this.swirlK, a = this.swirlAngle;
      const pose = obj.userData.pose || (obj.userData.pose = { p: [0, 0, 0], r: [0, 0, 0] });
      pose.p[0] = hp.p[0] + Math.cos(a * 0.5) * 0.012 * k;
      pose.p[1] = hp.p[1] + Math.sin(a * 0.5) * 0.006 * k;
      pose.p[2] = hp.p[2];
      pose.r[0] = hp.r[0] + Math.sin(a * 0.5) * 0.05 * k;
      pose.r[1] = hp.r[1];
      pose.r[2] = hp.r[2] + Math.cos(a * 0.5) * 0.06 * k;
      this._panLook(false);
      // muddy water over the rim while it is swirled (the bowl's blunt rim spills more)
      if (k > 0.25 && this.pan.progress < 0.9 && Math.random() < dt * (tool === "bowl" ? 18 : 14) * k) H.splash && H.splash(obj);
    } else if (this.work === "sieve" || this.work === "clean") {
      if (H.held !== "sieve") H.setHeld("sieve", this.handSieve, HELD_GRIPS.sieve);
      const pose = this.handSieve.userData.pose || (this.handSieve.userData.pose = { p: [0, 0, 0], r: [0, 0, 0] });
      pose.p[0] = HELD.sieve.p[0] - this.shakeX * 1.6; pose.p[1] = HELD.sieve.p[1]; pose.p[2] = HELD.sieve.p[2];
      pose.r[0] = HELD.sieve.r[0]; pose.r[1] = HELD.sieve.r[1]; pose.r[2] = HELD.sieve.r[2];
    } else if (this.pushing) {
      if (H.held !== "barrow") H.setHeld("barrow", this.handBarrow, this._barrowGrips);
      this._barrowHands(H);
    } else if (this.carrying) {
      if (H.held !== "bucket") H.setHeld("bucket", this.handBucket, HELD_GRIPS.bucket);
      const pose = this.handBucket.userData.pose || (this.handBucket.userData.pose = { p: [0, 0, 0], r: [0, 0, 0] });
      const sw = Math.sin(this.time * 2.2) * 0.012;
      pose.p[0] = HELD.bucket.p[0]; pose.p[1] = HELD.bucket.p[1]; pose.p[2] = HELD.bucket.p[2];
      pose.r[0] = HELD.bucket.r[0] + sw; pose.r[1] = HELD.bucket.r[1]; pose.r[2] = HELD.bucket.r[2] + sw * 0.6;
    } else if (H.held) H.setHeld(null);
  }

  // the gloves where the barrow's grips are seen: each grip's world point is
  // projected with the world camera and put at the same screen spot in the
  // hands' own view (they have their own camera / field of view)
  _barrowHands(H) {
    const cam = this.camera, hc = H.camera, w = this.barrow;
    if (!cam || !hc) return;
    const a = w.gripWorld(1, this._ga).project(cam), b = w.gripWorld(-1, this._gb).project(cam);
    const d = 0.62, t = Math.tan((hc.fov * Math.PI) / 360);
    const ax = a.x * d * t * hc.aspect, ay = a.y * d * t, bx = b.x * d * t * hc.aspect, by = b.y * d * t;
    const pose = this.handBarrow.userData.pose || (this.handBarrow.userData.pose = { p: [0, 0, 0], r: [0, 0, 0] });
    pose.p[0] = (ax + bx) / 2 / (H.aspectK || 1); pose.p[1] = (ay + by) / 2 - 0.02; pose.p[2] = -d;
    pose.r[0] = 0; pose.r[1] = 0; pose.r[2] = Math.atan2(ay - by, ax - bx);
    const hw = Math.max(0.08, Math.min(0.32, Math.hypot(ax - bx, ay - by) / 2));
    for (const g of this._barrowGrips) g.pos[0] = hw;
  }

  // tests / benchmark: material from one container to another - the same pour() the actions use
  pourBetween(from, to) {
    const H = { bucket: this.bucket ? { batch: this.bucket.batch, capacityMl: this.capacityMl } : null, barrow: this.barrow, hopper: this.sluice ? this.sluice.hopper : null,
      bulk: this.bulk && this.bulk.installed ? this.bulk.buffer : null, tray: this.feeder ? this.feeder.tray : null };
    if (!H[from] || !H[to]) return 0;
    const ml = transfer(H[from], H[to], Infinity, this.nextBatch++);
    if (ml > 0 && to === "bulk") { this.bulk.stats.inMl += ml; this.bulk.stats.loads++; }
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
      this._steady();
    }
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
      pan: { batch: this.pan.batch.serialize(), progress: +this.pan.progress.toFixed(3), tool: this.pan.tool },
      sieve: { batch: this.sieve.batch.serialize(), progress: +this.sieve.progress.toFixed(3) },
      ledger: { ...this.ledger },
      wheelbarrow: this.barrow ? this.barrow.serialize() : null,
      sluice: this.sluice ? this.sluice.serialize() : null,
      bulkHopper: this.bulk ? this.bulk.serialize() : null,
      feeder: this.feeder ? this.feeder.serialize() : null,
    };
  }

  // gold in containers right now (ledger check)
  goldInContainers() {
    return (this.bucket ? this.bucket.batch.goldUg : 0) + this.tub.goldUg + this.pan.batch.goldUg + this.sieve.batch.goldUg
      + (this.barrow ? this.barrow.batch.goldUg : 0) + (this.sluice ? this.sluice.goldUg() : 0)
      + (this.bulk ? this.bulk.goldUg() : 0) + (this.feeder ? this.feeder.goldUg() : 0);
  }

  massInContainers() {
    return (this.bucket ? this.bucket.batch.massG : 0) + this.tub.massG + this.pan.batch.massG + this.sieve.batch.massG
      + (this.barrow ? this.barrow.batch.massG : 0) + (this.sluice ? this.sluice.massG() : 0)
      + (this.bulk ? this.bulk.massG() : 0) + (this.feeder ? this.feeder.massG() : 0);
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
    this.models.dispose();
    this.mech.dispose();
    if (this._wetTex) { this._wetTex.dispose(); this._wetGeo.dispose(); for (const m of this._wetMats) m.dispose(); for (const g of this._wetGeos || []) g.dispose(); }
    for (const m of this._merged || []) m.geometry.dispose();
  }
}
