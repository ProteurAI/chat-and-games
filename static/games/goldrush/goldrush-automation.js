// GoldRush - first automation (phase 7): a bulk hopper that stores several
// wheelbarrow loads, and a motorised feeder that doses it into the sluice -
// built on the generic transfer layer (goldrush-transfer.js), so a conveyor
// (prompt 8) plugs in the same way.
//
//   BULK HOPPER   at the sluice's head, on a timber frame; a loading ramp up from
//                 the west side of Zone B and a platform north of it (walkable
//                 decks, goldrush-world.js). A barrow pushed up onto the platform
//                 tips into it (southwards), a bucket is emptied into it from there. Its content is a MaterialBuffer:
//                 every load its own layer, the oldest leaves first.
//                 Without a feeder its outlet has a SLIDE GATE: pulled at the
//                 control post, the material slides down the chute into the
//                 sluice hopper (GATE_LPM) until that is full or the bulk hopper
//                 empty - then it closes by itself.
//   FEEDER        mounted under the outlet: the chute becomes a vibrating tray.
//                 Two links - bulk hopper -> tray (a small buffer: the material
//                 on its way) -> sluice hopper - at FEEDER_LPM. A full sluice
//                 hopper backs the tray up, a full tray stops the outlet: it
//                 waits and goes on by itself (backpressure). Lever at the
//                 control post: AUS -> AUTO (runs while the sluice's water is on)
//                 -> AN (runs) -> AUS. A lamp shows running / waiting / off.
//
// Everything runs only while the game runs (frames, or the simulation hook);
// a paused or closed game does nothing, a reload does not catch up. Gold and
// mass only move between holders - the processing ledger counts them all.

import { STAGE } from "./goldrush-material.js";
import { MaterialBuffer, TransferLink, stepChain, transfer, volumeOf, roomOf } from "./goldrush-transfer.js";
import { BULK, bulkLevelFor } from "./goldrush-automodels.js";
import { mergeStatic } from "./goldrush-merge.js";

export const BULK_AT = { x: -20.82, z: -3.45 };
export const BULK_ML = 360000;                 // 360 l (~4 wheelbarrow loads); extension 540 l (tuned, benchmark)
export const BULK_EXT_ML = 540000;
export const FEEDER_LPM = 12;                  // an even feed: the sluice takes 12 instead of 10 l/min (surges would overload it)
export const FEEDER_FINE_LPM = 14;             // fine-dosing gate (upgrade): 14 l/min, the most the sluice takes
export const FEEDER_HIGHFLOW_LPM = 32;         // phase 9: the high-flow sluice comes with a wider outlet - it doses what that box takes
export const FEEDER_PLANT_LPM = 120;           // Prompt 10: the wash plant's distribution box takes three lanes' worth
export const GATE_LPM = 40;                    // the slide gate by hand: gravity, fast
export const TRAY_ML = 2500;                   // what lies on the vibrating tray
// the loading ramp runs north -> south up to the platform at the hopper's north rim
// (foot / top along z; x0..x1 its width) - the west strip of Zone B
export const RAMP = { x0: BULK_AT.x - 0.7, x1: BULK_AT.x + 0.7, foot: -9.1, top: -4.85, h: BULK.deckY };
export const PLATFORM = { z0: -4.85, z1: BULK_AT.z - 0.7 };
export const AUTO_SPOTS = {
  post: { x: -21.75, z: -2.72 },                         // the control post (west of the outlet)
  control: { x: -22.45, z: -2.72, yaw: -Math.PI / 2 },   // stand here, facing it (east)
  bucket: { x: BULK_AT.x, z: -4.55, yaw: Math.PI },      // on the platform, facing the hopper (south)
  dump: { x: BULK_AT.x, z: -5.04 },                      // a barrow's tray here (on the platform) tips into it ...
  dumpWheel: { x: BULK_AT.x, z: BULK_AT.z - 0.98 },      // ... its wheel against the frame
  rampFoot: { x: BULK_AT.x, z: -10.0, yaw: Math.PI },    // behind a barrow at the ramp, facing up it
};
const BUILD_S = 2.6, MOUNT_S = 1.8;
const FOOT = { x0: BULK_AT.x - 0.85, x1: BULK_AT.x + 0.85, z0: RAMP.foot - 0.3, z1: BULK_AT.z + 0.85 };     // what the installation covers

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
// the materials' colours in the hopper (dirt, compact dirt, gravel, stone) - a little lighter than in the barrow: dry, in the sun
const MAT_RGB = [[0.6, 0.44, 0.3], [0.5, 0.36, 0.25], [0.6, 0.55, 0.47], [0.52, 0.5, 0.47]];

function growParts(parts, k) {
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i], a = Math.max(0, Math.min(1, (k * parts.length * 1.15 - i) / 2)), e = a * a * (3 - 2 * a);
    if (!p.userData.s0) p.userData.s0 = p.scale.clone();
    p.visible = a > 0.02;
    p.scale.set(p.userData.s0.x, Math.max(0.001, p.userData.s0.y * e), p.userData.s0.z);
  }
}
function grownParts(parts) { for (const p of parts) { if (p.userData.s0) p.scale.copy(p.userData.s0); p.visible = true; } }

// does the installation's footprint cover (x, z)?
export function inAutomationFoot(x, z) { return x >= FOOT.x0 && x <= FOOT.x1 && z >= FOOT.z0 && z <= FOOT.z1; }

export class BulkHopper {
  /**
   * @param saved doc.processing.bulkHopper (v7) or null
   * @param ctx   { nextId: () => int, upgrades: () => Set, sluice: () => Sluice | null }
   */
  constructor(THREE, scene, world, auto, saved, ctx) {
    this.THREE = THREE;
    this.world = world;
    this.auto = auto;
    this.ctx = ctx;
    const s = saved || {};
    this.state = s.state === "ready" ? "ready" : "delivered";
    this.buffer = new MaterialBuffer({ capacityMl: BULK_ML, stage: STAGE.RAW, layers: s.buffer && s.buffer.layers });
    const gs = s.gate || {};
    this.gate = new TransferLink({ from: () => this.buffer, to: () => this._sluiceIn(), rateLpm: GATE_LPM, stepMl: 500, acc: gs.acc, on: !!gs.on && this.state === "ready", moved: gs.moved });
    const st = s.stats || {};
    this.stats = { inMl: int(st.inMl), outMl: int(st.outMl), loads: int(st.loads) };
    this.feeder = null;                            // set by the Feeder once it is there
    this.build = -1;
    this.time = 0;
    this.flowK = 0;                                // how much runs down the chute right now (visuals, 0..1)
    this._build(scene);
    this.applyUpgrades();
  }

  _build(scene) {
    const THREE = this.THREE, A = this.auto;
    this.root = new THREE.Group();
    this.root.position.set(BULK_AT.x, 0, BULK_AT.z);
    scene.add(this.root);
    this.model = A.bulkHopper();
    this.root.add(this.model);
    this.rampModel = A.ramp({ x: BULK_AT.x, z: RAMP.foot, dir: 1, len: RAMP.top - RAMP.foot, w: RAMP.x1 - RAMP.x0, h: RAMP.h, plat: PLATFORM.z1 - PLATFORM.z0 });
    scene.add(this.rampModel);
    this.post = A.controlPost();
    this.post.position.set(AUTO_SPOTS.post.x, 0, AUTO_SPOTS.post.z);
    this.post.rotation.y = Math.PI;                          // its box faces the player (west)
    scene.add(this.post);
    this.kit = A.bulkKit();
    this.kit.position.set(BULK_AT.x + 1.45, 0, BULK_AT.z - 1.2);           // beside the site, east of the ramp
    this.kit.rotation.y = 0.2;
    scene.add(this.kit);
    this.parts = [...this.model.userData.parts, ...this.rampModel.userData.parts];
    // walkable: the ramp and the platform; solid: the frame, the post
    this.decks = [
      { x0: RAMP.x0, x1: RAMP.x1, z0: RAMP.foot, z1: RAMP.top, axis: "z", a: RAMP.foot, b: RAMP.top, h0: 0, h1: RAMP.h },
      { x0: RAMP.x0, x1: RAMP.x1, z0: PLATFORM.z0, z1: PLATFORM.z1, axis: "z", a: 0, b: 0, h0: RAMP.h, h1: RAMP.h },
    ];
    this.collider = { type: "box", x: BULK_AT.x, z: BULK_AT.z, hw: BULK.top / 2 + 0.06, hd: BULK.top / 2 + 0.06, rot: 0 };
    this.postCollider = { type: "circle", x: AUTO_SPOTS.post.x, z: AUTO_SPOTS.post.z, r: 0.14 };
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._v = new THREE.Vector3(); this._s = new THREE.Vector3();
    this._col = [0, 0, 0, 0];
    this._sync();
  }

  get installed() { return this.state === "ready"; }
  get capacityMl() { return this.buffer.capacityMl; }
  get volumeMl() { return this.buffer.volumeMl; }
  get gateOpen() { return this.gate.on; }

  _sluiceIn() { const sl = this.ctx.sluice(); return sl && sl.installed ? sl.hopper : null; }

  applyUpgrades() {
    const ups = this.ctx.upgrades();
    this.buffer.capacityMl = ups.has("bulk.extension") ? BULK_EXT_ML : BULK_ML;
    this.model.userData.ext.visible = ups.has("bulk.extension") && (this.installed || this.build >= 0);
    this._fill();
  }

  startBuild() {
    if (this.state !== "delivered" || this.build >= 0) return false;
    this.build = 0;
    this._sync();
    return true;
  }

  // the slide gate by hand (no feeder): it stays open until the sluice hopper is full / this is empty
  openGate() {
    if (!this.installed || this.feeder || this.gate.on || this.buffer.volumeMl <= 0) return false;
    const to = this._sluiceIn();
    if (!to || roomOf(to) <= 0) return false;
    this.gate.on = true;
    this.gate.state = "moving";
    return true;
  }

  // the bucket / a dev batch straight in (the barrow tips in through its own animation: transfer())
  pourIn(holder) {
    const ml = transfer(holder, this.buffer, Infinity, this.ctx.nextId());
    if (ml > 0) { this.stats.inMl += ml; this.stats.loads++; this._fill(); }
    return ml;
  }

  // the simulation step (frames / the benchmark): the hand gate
  process(dt) {
    if (!this.installed || this.feeder) { this.gate.on = false; return 0; }
    if (!this.gate.on) return 0;
    const moved = stepChain([this.gate], dt, this.ctx.nextId);
    this.stats.outMl += moved;
    if (this.gate.state === "blocked" || this.gate.state === "starved" || this.gate.state === "off") this.gate.on = false;   // full / empty: it closes
    if (moved) this._fill();
    return moved;
  }

  goldUg() { return this.buffer.goldUg; }
  massG() { return this.buffer.massG; }

  // ---- visuals

  _sync() {
    const on = this.installed || this.build >= 0;
    this.kit.visible = this.state === "delivered" && this.build < 0;
    this.model.visible = this.rampModel.visible = this.post.visible = on;
    const cols = this.world.colliders, has = (c) => cols.includes(c);
    if (on && !has(this.collider)) cols.push(this.collider, this.postCollider);
    if (!on && has(this.collider)) { cols.splice(cols.indexOf(this.collider), 1); cols.splice(cols.indexOf(this.postCollider), 1); }
    for (const d of this.decks) { if (this.installed) this.world.addDeck(d); else this.world.removeDeck(d); }
    this.model.userData.ext.visible = this.ctx.upgrades().has("bulk.extension") && on;
    if (this.installed && !this._merged) this._mergeStatic();
    this._fill();
  }

  // built: frame, funnel, rim and the whole ramp baked into a few meshes (phase 7A draw calls);
  // the gate, its handle, the chute (it shakes with a feeder) and the extension boards stay apart
  _mergeStatic() {
    const u = this.model.userData, keep = new Set([u.gate, u.handle]);
    u.chute.traverse((o) => keep.add(o));
    u.ext.traverse((o) => keep.add(o));
    this._merged = [
      ...mergeStatic(this.THREE, this.model, u.parts.filter((p) => !keep.has(p))),
      ...mergeStatic(this.THREE, this.rampModel, this.rampModel.userData.parts),
    ];
    if (this.ctx.warm) this.ctx.warm();
  }

  // the level (a float pointer on the gauge) and the surface: mottled by what lies on top
  _fill() {
    const u = this.model.userData, v = this.buffer.volumeMl, m3 = v / 1e6;
    const h = bulkLevelFor(m3), frac = Math.min(1, v / Math.max(1, this.capacityMl));
    u.fill.visible = v > 300 && (this.installed || this.build >= 0);
    if (u.fill.visible) {
      const s = h <= BULK.depth ? BULK.bottom + (BULK.top - BULK.bottom) * (h / BULK.depth) : BULK.top;
      u.fill.position.y = BULK.outletY + h;
      u.fill.scale.set(s * 0.97, 1, s * 0.97);
    }
    u.pointer.position.y = BULK.outletY + 0.03 + frac * (BULK.depth - 0.06);
    const sig = this.buffer.layers.length ? `${this.buffer.layers.length}:${this.buffer.layers[this.buffer.layers.length - 1].id}:${Math.round(v / 20000)}` : "";
    if (sig !== this._fillSig) { this._fillSig = sig; this._paint(); }
  }

  // vertex colours of the surface: each point one of the top layers' materials, in their
  // proportions (by mass), a little noise - a rough mixed picture of what was tipped in last
  _paint() {
    const geo = this.model.userData.fill.geometry, col = geo.attributes.color, pos = geo.attributes.position;
    const top = this.buffer.top(3), shares = [];
    for (const l of top) {
      const m = l.massG || 1;
      shares.push([l.comp[0] / m, l.comp[1] / m, l.comp[2] / m, l.comp[3] / m]);
    }
    for (let i = 0; i < col.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const r1 = fract(Math.sin(x * 127.1 + z * 311.7) * 43758.5453), r2 = fract(Math.sin(x * 269.5 + z * 183.3) * 24634.6345);
      // the newest layer mostly, older ones show at the edges
      const li = shares.length ? Math.min(shares.length - 1, Math.floor(r2 * r2 * shares.length * (0.6 + 0.8 * Math.max(Math.abs(x), Math.abs(z))))) : 0;
      const sh = shares[li] || [1, 0, 0, 0];
      let k = 0, acc = sh[0];
      while (k < 3 && r1 > acc) { k++; acc += sh[k]; }
      const c = MAT_RGB[k], n = 0.85 + 0.25 * fract(r1 * 7.13 + r2 * 3.7);
      col.setXYZ(i, c[0] * n, c[1] * n, c[2] * n);
      // a low heap where the loads land (the east side, under the platform's edge), a little lumpy
      const d = Math.hypot(x - 0.18, z * 1.2), hp = Math.max(0, 1 - d / 0.62);
      pos.setY(i, (0.05 + 0.05 * Math.min(1, this.buffer.volumeMl / 200000)) * hp * hp * (3 - 2 * hp) + (r1 - 0.5) * 0.012);
    }
    col.needsUpdate = true;
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }

  // per frame: the build animation, the gate plate, material sliding down the chute
  update(dt, flow) {
    this.time += dt;
    const u = this.model.userData;
    if (this.build >= 0) {
      this.build += dt;
      const k = Math.min(1, this.build / BUILD_S);
      growParts(this.parts, k);
      if (k >= 1) { grownParts(this.parts); this.build = -1; this.state = "ready"; this._sync(); }
    }
    // the gate: out when open (by hand or held open by the feeder)
    const open = this.gate.on || (this.feeder && this.feeder.running);
    u.gate.position.x += ((open ? -0.24 : 0) - u.gate.position.x) * Math.min(1, dt * 6);
    u.handle.position.x = u.gate.position.x;
    // the chute: material on it / sliding down (flow 0..1 from the gate or the feeder)
    const want = flow != null ? flow : this.gate.on && this.gate.state === "moving" ? 1 : 0;
    this.flowK += (want - this.flowK) * Math.min(1, dt * 4);
    const trayMl = this.feeder ? this.feeder.tray.volumeMl : 0;
    u.chuteLoad.visible = this.flowK > 0.05 || trayMl > 200;
    u.fall.visible = this.flowK > 0.15;
    if (u.fall.visible) u.fall.scale.y = 0.18 + 0.06 * Math.sin(this.time * 31);
    const pb = u.pebbles, n = this.flowK > 0.1 ? Math.round(6 + 10 * this.flowK) : 0;
    if (pb.count !== n || n) {
      pb.count = n;
      const speed = this.feeder ? 0.45 : 0.9;
      for (let i = 0; i < n; i++) {
        const ph = (this.time * speed + i / n) % 1, z = -0.05 + ph * (BULK.chuteL - 0.1);
        const x = Math.sin(i * 5.1) * (BULK.chuteW * 0.32), s = 0.011 + ((i * 37) % 7) * 0.0025;
        this._q.setFromAxisAngle(this._v.set(1, 0, 0), this.time * 7 + i);
        this._m.compose(this._v.set(x, 0.02 + s * 0.5 + (this.feeder ? Math.abs(Math.sin(this.time * 40 + i)) * 0.006 : 0), z), this._q, this._s.set(s, s * 0.8, s));
        pb.setMatrixAt(i, this._m);
      }
      pb.instanceMatrix.needsUpdate = true;
    }
  }

  serialize() {
    return { state: this.state, buffer: this.buffer.serialize(), gate: this.gate.serialize(), stats: { ...this.stats } };
  }

  dispose(scene) {
    for (const c of [this.collider, this.postCollider]) { const i = this.world.colliders.indexOf(c); if (i >= 0) this.world.colliders.splice(i, 1); }
    for (const d of this.decks) this.world.removeDeck(d);
    scene.remove(this.root); scene.remove(this.rampModel); scene.remove(this.post); scene.remove(this.kit);
    for (const m of this._merged || []) m.geometry.dispose();
  }
}

const fract = (v) => v - Math.floor(v);
const MODES = ["stop", "auto", "on"];

export class Feeder {
  /**
   * @param saved doc.processing.feeder (v7) or null
   * @param ctx   { nextId, upgrades, bulk: () => BulkHopper, sluice: () => Sluice | null }
   */
  constructor(THREE, scene, world, auto, saved, ctx) {
    this.THREE = THREE;
    this.world = world;
    this.auto = auto;
    this.ctx = ctx;
    const s = saved || {};
    this.state = s.state === "ready" ? "ready" : "delivered";
    this.mode = MODES.includes(s.mode) ? s.mode : "stop";
    this.tray = new MaterialBuffer({ capacityMl: TRAY_ML, stage: STAGE.RAW, layers: s.tray && s.tray.layers });
    const li = s.inLink || {}, lo = s.outLink || {};
    this.inLink = new TransferLink({ from: () => { const b = this.ctx.bulk(); return b && b.installed ? b.buffer : null; }, to: this.tray, rateLpm: FEEDER_LPM, stepMl: 250, acc: li.acc, moved: li.moved });
    this.outLink = new TransferLink({ from: this.tray, to: () => { const sl = this.ctx.sluice(); return sl && sl.installed ? sl.hopper : null; }, rateLpm: FEEDER_LPM, stepMl: 250, acc: lo.acc, moved: lo.moved });
    this.build = -1;
    this.time = 0;
    this.running = false;
    this._build(scene);
    this.applyUpgrades();
  }

  _build(scene) {
    const bulk = this.ctx.bulk();
    this.model = this.auto.feeder(bulk.model.userData.chute);
    this.kit = this.auto.feederKit();
    this.kit.position.set(AUTO_SPOTS.post.x - 0.15, 0, AUTO_SPOTS.post.z - 0.7);
    this.kit.rotation.y = 0.4;
    scene.add(this.kit);
    this.scene = scene;
    this._sync();
  }

  get installed() { return this.state === "ready"; }
  get rateLpm() { return this.outLink.rateLpm; }

  applyUpgrades() {
    const ups = this.ctx.upgrades(), wp = this.ctx.washplant ? this.ctx.washplant() : null;
    const r = wp && wp.installed ? FEEDER_PLANT_LPM : ups.has("sluice.highflow") ? FEEDER_HIGHFLOW_LPM : ups.has("feeder.fine") ? FEEDER_FINE_LPM : FEEDER_LPM;
    this.inLink.rateLpm = this.outLink.rateLpm = r;
  }

  startMount() {
    const bulk = this.ctx.bulk();
    if (this.state !== "delivered" || this.build >= 0 || !bulk || !bulk.installed) return false;
    this.build = 0;
    this._sync();
    return true;
  }

  // the lever: AUS -> AUTO -> AN -> AUS
  nextMode() { return MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]; }
  setMode(mode) {
    if (!this.installed || !MODES.includes(mode)) return false;
    this.mode = mode;
    return true;
  }

  // should it run right now? (AUTO: while the sluice's water is on)
  wants() {
    if (!this.installed || this.mode === "stop") return false;
    if (this.mode === "on") return true;
    const sl = this.ctx.sluice();
    return !!(sl && sl.installed && sl.running);
  }

  process(dt) {
    const run = this.wants();
    this.inLink.on = this.outLink.on = run;
    const moved = stepChain([this.inLink, this.outLink], dt, this.ctx.nextId);
    this.running = run;
    return moved;
  }

  /** what it is doing: { key, text, lamp } - key: off | moving | blocked | starved | waiting */
  status() {
    if (!this.installed) return { key: "off", text: "noch nicht montiert", lamp: "off" };
    if (this.mode === "stop") return { key: "off", text: "aus", lamp: "off" };
    if (!this.running) return { key: "waiting", text: "AUTO – wartet auf das Wasser der Rinne", lamp: "wait" };
    const o = this.outLink, i = this.inLink;
    if (o.state === "blocked") return { key: "blocked", text: "wartet – der Trichter der Rinne ist voll", lamp: "wait" };
    if (o.state === "starved" && i.state === "starved") return { key: "starved", text: "wartet – der Vorratstrichter ist leer", lamp: "wait" };
    if (!this.ctx.sluice() || !this.ctx.sluice().installed) return { key: "blocked", text: "wartet – keine Waschrinne", lamp: "wait" };
    return { key: "moving", text: `läuft · ${String(this.rateLpm).replace(".", ",")} l/min`, lamp: "on" };
  }

  goldUg() { return this.tray.goldUg; }
  massG() { return this.tray.massG; }

  // how much runs down the tray right now (0..1, the bulk hopper's chute visuals)
  flow() {
    const k = this.status().key;
    return k === "moving" ? Math.min(1, this.rateLpm / FEEDER_FINE_LPM) : this.tray.volumeMl > 200 ? 0.15 : 0;      // (high flow: full)
  }

  _sync() {
    const on = this.installed || this.build >= 0;
    this.kit.visible = this.state === "delivered" && this.build < 0;
    this.model.visible = on;
    const bulk = this.ctx.bulk();
    if (bulk) bulk.feeder = this.installed ? this : null;
    // (Prompt 10: fewer draw calls - mounted, its bolts, housing and frame are baked per material)
    if (this.installed && !this._merged) {
      const u = this.model.userData;
      this._merged = mergeStatic(this.THREE, this.model, u.parts.filter((p) => p !== u.motor));
      if (this.ctx.warm) this.ctx.warm();
    }
  }

  update(dt, onSound, near) {
    this.time += dt;
    if (this.build >= 0) {
      this.build += dt;
      const k = Math.min(1, this.build / MOUNT_S);
      growParts(this.model.userData.parts, k);
      if (k >= 1) { grownParts(this.model.userData.parts); this.build = -1; this.state = "ready"; this._sync(); }
    }
    const st = this.status(), bulk = this.ctx.bulk();
    if (bulk) {
      this.auto.setLamp(bulk.post, st.lamp);
      // the lever: down (aus), middle (auto), up (an)
      const lv = bulk.post.userData.lever, want = this.mode === "on" ? 0.6 : this.mode === "auto" ? 0 : -0.6;
      lv.rotation.z += (want - lv.rotation.z) * Math.min(1, dt * 10);
      // the vibrating tray: a fast small shake while it moves material
      const ch = bulk.model.userData.chute, shake = st.key === "moving" ? Math.sin(this.time * 95) * 0.0035 : 0;
      ch.position.x = shake;
      ch.position.y = BULK.outletY - 0.13 + (st.key === "moving" ? Math.abs(Math.sin(this.time * 47)) * 0.002 : 0);
    }
    this._hum = (this._hum || 0) - dt;
    if (near && st.key === "moving" && this._hum <= 0 && onSound) { this._hum = 1.2; onSound("feeder_run"); }
  }

  serialize() {
    return { state: this.state, mode: this.mode, tray: this.tray.serialize(), inLink: this.inLink.serialize(), outLink: this.outLink.serialize() };
  }

  dispose(scene) {
    if (this.model.parent) this.model.parent.remove(this.model);
    scene.remove(this.kit);
    for (const m of this._merged || []) m.geometry.dispose();
    const bulk = this.ctx.bulk();
    if (bulk && bulk.feeder === this) bulk.feeder = null;
  }
}

// for the HUD / tests: room left downstream of the feeder (the sluice hopper)
export function sluiceRoom(sl) { return sl && sl.installed ? roomOf(sl.hopper) : 0; }
export { volumeOf };
