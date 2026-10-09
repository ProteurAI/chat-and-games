// GoldRush - the mechanised claim's plant (phase 9), on the transfer layer
// (goldrush-transfer.js) like the phase-7 automation:
//
//   CONVEYOR   (one purchase: "Förderband mit Aufgabetrichter")
//              INTAKE  a 240 l steel hopper at the mountain's west foot. You dig
//                      straight into it (like into a barrow), tip a barrow or a
//                      bucket into it, the excavator dumps into it. A
//                      MaterialBuffer: every load its own layer, oldest out first.
//              BELT    a chevron belt up to the bulk hopper (goldrush-transfer.js
//                      Belt: the material really travels, ~20 s, ~64 l/min); full
//                      at the head -> it stops (backpressure), the intake fills.
//              LEVER   at the control post by the intake: AUS -> AUTO (runs while
//                      the sluice's water is on - the whole plant starts and stops
//                      with the water) -> AN -> AUS; the lamp: running / waiting / off.
//   TROMMEL    on the bulk hopper's frame: the belt's head drops into its feed
//              box instead of the hopper. It runs with the belt; its spray bars
//              take water from the tank. Every litre is split exactly
//              (goldrush-material.js trommelSplit): undersize with nearly all the
//              gold into the bulk hopper, oversize down a chute onto a pile by
//              the fence - recoverable (shovel it into a barrow, scoop it with
//              the excavator). Full bulk hopper or a pile up to the chute ->
//              it waits, the belt behind it stops.
//   SPOIL      the spoil heap NW of the mountain (comes with the excavator): where
//              waste goes - the overburden you do not want to wash. It is
//              booked like tailings (gold included - nothing vanishes).
//   Prompt 10: NUGGET TRAP - a nugget too big for the screen's holes (goldrush-material.js SCREEN_CATCH_UG,
//   from ~ EUR 10) rides to the drum's end and drops into a small trap under the chute (plantmodels TRAP):
//   it waits there, whole, in the ledger and the save, until you take it out ([E]) - never onto the pile.
//   Prompt 10: the oversize pile and the spoil heap are real stockpiles
//   (goldrush-stockpile.js: a height field that settles, its material kept
//   layer by layer) - the trommel drops its oversize onto the OVERSIZE pile
//   (it waits once the pile reaches the chute), the spoil heap is the SPOIL
//   pile; a save of phase 9 brings both over (nothing booked twice).
//
// Everything runs only while the game runs (frames, or the simulation hook);
// the processing ledger (goldrush-processing.js) counts every holder here.

import { MaterialBuffer, Belt, transfer, volumeOf, roomOf, putInto } from "./goldrush-transfer.js";
import { MaterialBatch, STAGE, trommelSplit } from "./goldrush-material.js";
import { INTAKE, INTAKE_EXT, INTAKE_POST, INTAKE_SPOT, BELT, TROMMEL, OVERSIZE, OVER_BELT, OVER_DROP, overBeltGeom, SPOIL, SPOIL_SIGN, GENERATOR, HEAP_K, beltGeom, TRAP } from "./goldrush-plantmodels.js";
import { FIND } from "./goldrush-resources.js";
import { findSize } from "./goldrush-loot.js";
import { centsForMass } from "./goldrush-economy.js";
import { BULK_AT } from "./goldrush-automation.js";
import { mergeStatic, unmerge } from "./goldrush-merge.js";

export const INTAKE_ML = 240000;
export const BELT_CELLS = 24;
export const BELT_CELL_ML = 900;
export const BELT_SPEED = 0.42;                      // m/s -> ~64 l/min
export const TROMMEL_LPM = 60;
// Prompt 10: the plant upgrades (goldrush-shop.js) - the belt: a stronger drive, faster and a fuller load per metre
// (~137 l/min), the intake raised to 420 l; the trommel: a second drive and spray bar (120 l/min)
export const BELT_FAST = { speed: 0.62, cellMl: 1300 };
export const INTAKE_EXT_ML = 420000;
export const TROMMEL_FAST_LPM = 120;
export const TROMMEL_STEP_ML = 1000;
export const TROMMEL_FEED_ML = 30000;                // the feed box and what tumbles in the drum
export const OVERSIZE_MAX_ML = 7000000;              // phase 9's pile reached the chute at ~7 m3 (Prompt 10: the real pile's height decides)
export const CHUTE_H = 1.25;                          // m: (phase 9) the oversize pile up to the chute's end -> the trommel waited
// Prompt 10: the oversize stacker - the pile under its head up to OVER_H stops it (then the trommel waits)
export const OVER_H = 1.65;
const OVER_SLOTS = 10, OVER_CELL_ML = 1200, OVER_SPEED = 0.55, OVER_IN_ML = 4000;
export const CONVEYOR_KIT = { x: -15.95, z: -11.45 };
export const TROMMEL_KIT = { x: -17.7, z: -4.75 };
const BUILD_S = 3.2;
const MODES = ["stop", "auto", "on"];
const MAT_RGB = [[0.6, 0.44, 0.3], [0.5, 0.36, 0.25], [0.6, 0.55, 0.47], [0.52, 0.5, 0.47]];
const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const fract = (v) => v - Math.floor(v);
const lit = (ml) => `${Math.round(ml / 1000)} l`;
const m3 = (ml) => `${(ml / 1e6).toFixed(ml < 1e6 ? 2 : 1).replace(".", ",")} m³`;

function growParts(parts, k) {
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i], a = Math.max(0, Math.min(1, (k * parts.length * 1.15 - i) / 2)), e = a * a * (3 - 2 * a);
    if (!p.userData.s0) p.userData.s0 = p.scale.clone();
    p.visible = a > 0.02;
    p.scale.set(p.userData.s0.x, Math.max(0.001, p.userData.s0.y * e), p.userData.s0.z);
  }
}
function grownParts(parts) { for (const p of parts) { if (p.userData.s0) p.scale.copy(p.userData.s0); p.visible = true; } }

// a heap's size for a volume: radius up to rMax, then it grows in height (to hMax), then wider again
export function heapSize(ml, rMax, hRatio = 0.55, hMax = Infinity) {
  const v = Math.max(0, ml / 1e6);
  let r = Math.cbrt(v / (HEAP_K * hRatio)), h = hRatio * r;
  if (r > rMax) { r = rMax; h = v / (HEAP_K * r * r); }
  if (h > hMax) { h = hMax; r = Math.sqrt(v / (HEAP_K * h)); }
  return { r, h };
}

// the colour of a batch (mass shares of the four materials), for the lumps
function tint(b, out) {
  const m = b.massG || 1;
  out[0] = out[1] = out[2] = 0;
  for (let k = 0; k < 4; k++) { const s = b.comp[k] / m; out[0] += MAT_RGB[k][0] * s; out[1] += MAT_RGB[k][1] * s; out[2] += MAT_RGB[k][2] * s; }
  return out;
}

// =====================================================================================
// CONVEYOR: the intake hopper, the belt, the control post
// =====================================================================================
export class Conveyor {
  /**
   * @param saved  doc.processing.conveyor (v8) or null
   * @param ctx    { nextId, sluice: () => Sluice, bulk: () => BulkHopper, trommel: () => Trommel, warm }
   */
  constructor(THREE, scene, world, pm, saved, ctx) {
    this.THREE = THREE;
    this.scene = scene;
    this.world = world;
    this.pm = pm;
    this.ctx = ctx;
    const s = saved || {};
    this.state = s.state === "ready" ? "ready" : "delivered";
    this.mode = MODES.includes(s.mode) ? s.mode : "auto";
    this.intake = new MaterialBuffer({ capacityMl: INTAKE_ML, stage: STAGE.RAW, layers: s.intake && s.intake.layers });
    const G = (this.geom = beltGeom());
    this.belt = new Belt({ from: () => this.intake, to: () => this.target(), slots: BELT_CELLS, cellLen: G.len / BELT_CELLS, cellMl: BELT_CELL_ML, speed: BELT_SPEED, saved: s.belt });
    const st = s.stats || {};
    this.stats = { inMl: int(st.inMl), loads: int(st.loads), outMl: int(st.outMl), runS: int(st.runS), blockedS: int(st.blockedS), starvedS: int(st.starvedS) };
    this.build = -1;
    this.time = 0;
    this.running = false;
    this._build();
    this.applyUpgrades();
  }

  // Prompt 10: the conveyor upgrade - a faster belt carrying more per metre, the raised intake (you see both)
  applyUpgrades() {
    const ups = this.ctx.upgrades ? this.ctx.upgrades() : null, fast = !!(ups && ups.has("conveyor.fast"));
    this.fast = fast;
    this.belt.speed = fast ? BELT_FAST.speed : BELT_SPEED;
    this.belt.cellMl = fast ? BELT_FAST.cellMl : BELT_CELL_ML;
    this.intake.capacityMl = fast ? INTAKE_EXT_ML : INTAKE_ML;
    const iu = this.intakeModel.userData, cu = this.model.userData, on = this.installed || this.build >= 0;
    iu.ext.visible = cu.up.visible = fast && on;
    // built: the upgrade's parts are baked with the machine's own (per material - no extra draws); bought later: re-baked
    if (this._merged && this._mergedFast !== fast) { this._unmergeAll(); this._mergeStatic(); }
    this._fillSig = null;
  }

  _unmergeAll() {
    const iu = this.intakeModel.userData, cu = this.model.userData;
    for (const m of this._merged) { if (m.parent) m.parent.remove(m); m.geometry.dispose(); }
    for (const p of [...iu.parts, ...iu.extParts, ...cu.parts, ...cu.upParts, ...this.gen.userData.parts]) p.visible = true;
    this._merged = null;
  }

  // the intake's rim (where a load is tipped over): higher with the extension
  get rimY() { return INTAKE.rimY + (this.fast ? INTAKE_EXT.h : 0); }

  _build() {
    const THREE = this.THREE, pm = this.pm, G = this.geom;
    this.intakeModel = pm.intake();
    this.intakeModel.position.set(INTAKE.x, 0, INTAKE.z);
    this.intakeModel.rotation.y = G.yaw;
    this.model = pm.conveyor();
    this.chute = pm.headChute();
    this.post = pm.A.controlPost();
    this.post.position.set(INTAKE_POST.x, 0, INTAKE_POST.z);
    this.post.rotation.y = Math.PI / 2;                       // its box faces the player (north)
    this.kit = pm.conveyorKit();
    this.kit.position.set(CONVEYOR_KIT.x, 0, CONVEYOR_KIT.z);
    this.kit.rotation.y = 0.35;
    this.gen = pm.generator();
    for (const o of [this.intakeModel, this.model, this.chute, this.post, this.kit, this.gen]) this.scene.add(o);
    this.parts = [...this.intakeModel.userData.parts, ...this.model.userData.parts, ...this.chute.userData.parts, ...this.gen.userData.parts];
    // solid: the intake's frame, the belt where it is low (you walk under it further up), the legs, the post
    const c = Math.cos(G.yaw), sn = Math.sin(G.yaw);
    this.colliders = [{ type: "box", x: INTAKE.x, z: INTAKE.z, hw: INTAKE.top / 2 + 0.08, hd: INTAKE.top / 2 + 0.08, rot: G.yaw }];
    const lowS = 0.42, mid = lowS / 2;
    this.colliders.push({ type: "box", x: BELT.tail.x + (BELT.head.x - BELT.tail.x) * mid, z: BELT.tail.z + (BELT.head.z - BELT.tail.z) * mid, hw: (G.horiz * lowS) / 2, hd: BELT.width / 2 + 0.15, rot: G.yaw });
    for (const s of BELT.legs) for (const zz of [-1, 1]) {
      const lx = s * G.horiz, lz = zz * (BELT.width / 2 + 0.13);
      this.colliders.push({ type: "circle", x: BELT.tail.x + c * lx + sn * lz, z: BELT.tail.z - sn * lx + c * lz, r: 0.09 });
    }
    this.colliders.push({ type: "circle", x: INTAKE_POST.x, z: INTAKE_POST.z, r: 0.14 });
    this.colliders.push({ type: "box", x: GENERATOR.x, z: GENERATOR.z, hw: 0.6, hd: 0.34, rot: 0.25 });
    this._v = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._m = new THREE.Matrix4(); this._c = [0, 0, 0];
    this._sync();
  }

  get installed() { return this.state === "ready"; }
  get capacityMl() { return this.intake.capacityMl; }
  get volumeMl() { return this.intake.volumeMl; }

  // where the belt delivers: the trommel's feed box once it stands, else the bulk hopper
  target() {
    const tr = this.ctx.trommel();
    if (tr && tr.installed) return tr.feed;
    const bk = this.ctx.bulk();
    return bk && bk.installed ? bk.buffer : null;
  }

  startBuild() {
    if (this.state !== "delivered" || this.build >= 0) return false;
    this.build = 0;
    this._sync();
    return true;
  }

  nextMode() { return MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]; }
  setMode(m) { if (!this.installed || !MODES.includes(m)) return false; this.mode = m; return true; }

  // should it run now? AUTO: while the sluice's water is on
  wants() {
    if (!this.installed || this.mode === "stop") return false;
    if (this.mode === "on") return true;
    const sl = this.ctx.sluice();
    return !!(sl && sl.installed && sl.running);
  }

  // a load into the intake (barrow animation's end, the bucket, the excavator, dev) -> ml
  pourIn(holder, maxMl = Infinity) {
    const ml = transfer(holder, this.intake, maxMl, this.ctx.nextId());
    if (ml > 0) { this.stats.inMl += ml; this.stats.loads++; this._fillSig = null; }
    return ml;
  }

  process(dt) {
    const run = this.wants();
    this.belt.on = run;
    const out = this.belt.step(dt, this.ctx.nextId);
    this.running = run;
    if (run) {
      this.stats.runS += dt;
      if (this.belt.state === "blocked" || !this.target()) this.stats.blockedS += dt;
      else if (this.belt.state === "starved") this.stats.starvedS += dt;
    }
    if (out > 0) {
      this.stats.outMl += out;
      const tr = this.ctx.trommel();
      if (!(tr && tr.installed)) { const bk = this.ctx.bulk(); if (bk) { bk.stats.inMl += out; bk._fill(); } }
      else tr.stats.inMl += out;
    }
    return out;
  }

  /** { key: off | waiting | moving | blocked | starved, text, lamp } */
  status() {
    if (!this.installed) return { key: "off", text: "noch nicht aufgebaut", lamp: "off" };
    if (this.mode === "stop") return { key: "off", text: "aus", lamp: "off" };
    if (!this.running) return { key: "waiting", text: "AUTO – wartet auf das Wasser der Rinne", lamp: "wait" };
    const b = this.belt;
    if (b.state === "blocked") {
      const tr = this.ctx.trommel();
      return { key: "blocked", text: tr && tr.installed ? "steht – die Trommel nimmt nichts mehr an" : "steht – der Vorratstrichter ist voll", lamp: "wait" };
    }
    if (!this.target()) return { key: "blocked", text: "steht – kein Vorratstrichter", lamp: "wait" };
    if (b.state === "starved") return { key: "starved", text: "läuft leer – der Aufgabetrichter ist leer", lamp: "wait" };
    return { key: "moving", text: `läuft · ${Math.round(b.rateLpm)} l/min`, lamp: "on" };
  }

  goldUg() { return this.intake.goldUg + this.belt.goldUg; }
  massG() { return this.intake.massG + this.belt.massG; }

  // ---- visuals

  _sync() {
    const on = this.installed || this.build >= 0;
    this.kit.visible = this.state === "delivered" && this.build < 0;
    this.intakeModel.visible = this.model.visible = this.post.visible = this.gen.visible = on;
    const tr = this.ctx.trommel();
    this.chute.visible = on && !(tr && (tr.installed || tr.build >= 0));
    const cols = this.world.colliders;
    for (const c of this.colliders) { const i = cols.indexOf(c); if (on && i < 0) cols.push(c); if (!on && i >= 0) cols.splice(i, 1); }
    if (this.installed && !this._merged) this._mergeStatic();
    if (this.intakeModel.userData.ext) this.applyUpgrades();
    this._fillSig = null;
  }

  // built: frames, idlers, legs baked per material (the belt, pulleys, lumps, fills stay apart)
  _mergeStatic() {
    const iu = this.intakeModel.userData, cu = this.model.userData, ups = this.ctx.upgrades ? this.ctx.upgrades() : null, fast = !!(ups && ups.has("conveyor.fast"));
    const inc = cu.inc, incParts = cu.parts.filter((p) => p.parent === inc), outer = cu.parts.filter((p) => p.parent !== inc);
    iu.ext.visible = cu.up.visible = fast;
    this._merged = [
      ...mergeStatic(this.THREE, this.intakeModel, fast ? [...iu.parts, ...iu.extParts] : iu.parts),
      ...mergeStatic(this.THREE, inc, fast ? [...incParts, ...cu.upParts] : incParts),
      ...mergeStatic(this.THREE, this.model, outer),
      ...mergeStatic(this.THREE, this.gen, this.gen.userData.parts),
    ];
    this._mergedFast = fast;
    if (this.ctx.warm) this.ctx.warm();
  }

  // the intake's level and surface (the top layers' materials), the gauge
  _fill() {
    const u = this.intakeModel.userData, v = this.intake.volumeMl, frac = Math.min(1, v / this.intake.capacityMl);
    u.pointer.position.y = INTAKE.outletY + 0.03 + frac * (INTAKE.depth - 0.06);
    const sig = `${this.intake.layers.length}:${Math.round(v / 8000)}`;
    if (sig === this._fillSig) return;
    this._fillSig = sig;
    u.fill.visible = v > 300 && (this.installed || this.build >= 0);
    if (!u.fill.visible) return;
    // level in the frustum (square): V(h) = h/3 (b^2 + s^2 + b s), s = b + (t - b) h / d
    const I = INTAKE, want = v / 1e6 * (INTAKE_ML / 1e6 > 0 ? 0.3147 / (INTAKE_ML / 1e6) : 1);   // (the 240 l fill the funnel)
    const vFun = (I.depth / 3) * (I.bottom * I.bottom + I.top * I.top + I.bottom * I.top);
    let lo = 0, hi = I.depth;
    for (let i = 0; i < 20; i++) { const h = (lo + hi) / 2, s = I.bottom + (I.top - I.bottom) * (h / I.depth); if ((h / 3) * (I.bottom * I.bottom + s * s + I.bottom * s) < want) lo = h; else hi = h; }
    let h = (lo + hi) / 2, side = I.bottom + (I.top - I.bottom) * (h / I.depth);
    if (want > vFun) { h = I.depth + Math.min(INTAKE_EXT.h, (want - vFun) / ((I.top + 0.06) ** 2)); side = I.top + 0.06 * Math.min(1, (h - I.depth) / INTAKE_EXT.h); }   // up into the extension
    u.fill.position.y = I.outletY + h;
    u.fill.scale.set(side * 0.97, 1, side * 0.97);
    const geo = u.fill.geometry, col = geo.attributes.color, pos = geo.attributes.position, top = this.intake.top(3), sh = top.map((l) => { const m = l.massG || 1; return [l.comp[0] / m, l.comp[1] / m, l.comp[2] / m, l.comp[3] / m]; });
    for (let i = 0; i < col.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i), r1 = fract(Math.sin(x * 127.1 + z * 311.7) * 43758.5453), r2 = fract(Math.sin(x * 269.5 + z * 183.3) * 24634.6345);
      const s = sh[Math.min(sh.length - 1, Math.floor(r2 * r2 * sh.length))] || [1, 0, 0, 0];
      let k = 0, acc = s[0];
      while (k < 3 && r1 > acc) { k++; acc += s[k]; }
      const c = MAT_RGB[k], n = 0.85 + 0.25 * fract(r1 * 7.13 + r2 * 3.7);
      col.setXYZ(i, c[0] * n, c[1] * n, c[2] * n);
      const d = Math.hypot(x, z), hp = Math.max(0, 1 - d / 0.65);
      pos.setY(i, (0.04 + 0.06 * frac) * hp * hp * (3 - 2 * hp) + (r1 - 0.5) * 0.015);
    }
    col.needsUpdate = true; pos.needsUpdate = true;
    geo.computeVertexNormals();
  }

  // the load on the belt: a few flat clusters per loaded cell (a ridge of loose ground, not balls),
  // sized by its litres, coloured by its materials, slightly darker than in the sun (damp)
  _lumps() {
    const u = this.model.userData, L = u.lumps, B = u.bed, b = this.belt, cl = b.cellLen;
    let n = 0, nb = 0;
    for (let i = 0; i < b.slots; i++) {
      const c = b.cells[i];
      if (!c || c.volumeMl < 40) continue;
      const f = c.volumeMl / BELT_CELL_ML, x0 = b.cellAt(i), col = tint(c, this._c), h0 = fract(Math.sin(c.id * 12.9898) * 43758.5453);
      // the bed: ~1 cm of loose ground over the trough, a crest of up to ~3 cm (900 ml over 0.35 m of belt)
      if (nb < 32) {
        this._q.setFromAxisAngle(this._v.set(0, 1, 0), h0 > 0.5 ? Math.PI : 0);
        this._m.compose(this._v.set(x0, 0.004, (h0 - 0.5) * 0.04), this._q, this._s.set(cl * 1.12, 0.008 + 0.024 * Math.sqrt(f), 0.24 + 0.08 * Math.sqrt(f)));
        B.setMatrixAt(nb, this._m);
        const d = 0.52 + 0.12 * h0;                        // damp, in the belt's shade
        B.instanceColor.setXYZ(nb, col[0] * d, col[1] * d, col[2] * d);
        nb++;
      }
      // a clod or two riding on it (fist-sized at most)
      const k = c.volumeMl >= 350 ? 1 + (c.volumeMl >= 750 ? 1 : 0) : 0;
      for (let j = 0; j < k && n < 92; j++) {
        const h = fract(Math.sin((c.id + j * 17) * 12.9898) * 43758.5453), h2 = fract(h * 7.31), sz = 0.016 + 0.014 * h;
        this._q.setFromAxisAngle(this._v.set(0, 1, 0), h * 6.28);
        this._m.compose(this._v.set(x0 + (h2 - 0.5) * cl * 0.7, 0.012 + 0.02 * Math.sqrt(f), (j % 2 ? 1 : -1) * (0.02 + 0.07 * h2)), this._q, this._s.set(sz * 1.5, sz * 0.7, sz * (1.2 + 0.4 * h2)));
        L.setMatrixAt(n, this._m);
        const d = 0.46 + 0.12 * h2;
        L.instanceColor.setXYZ(n, col[0] * d, col[1] * d, col[2] * d);
        n++;
      }
    }
    B.count = nb;
    B.instanceMatrix.needsUpdate = true;
    B.instanceColor.needsUpdate = true;
    L.count = n;
    L.instanceMatrix.needsUpdate = true;
    L.instanceColor.needsUpdate = true;
  }

  update(dt, near, onSound) {
    this.time += dt;
    if (this.build >= 0) {
      this.build += dt;
      const k = Math.min(1, this.build / BUILD_S);
      growParts(this.parts, k);
      if (k >= 1) { grownParts(this.parts); this.build = -1; this.state = "ready"; this._sync(); }
    }
    const u = this.model.userData, st = this.status();
    // the belt you see runs up and coasts down (~1 s): the drive's start, the rollers' inertia
    this.visV = (this.visV || 0) + ((this.belt.running ? this.belt.speed : 0) - (this.visV || 0)) * Math.min(1, dt * (this.belt.running ? 1.8 : 2.6));
    if (this.visV > 0.002) {
      this.pm.beltMap.offset.x = (this.pm.beltMap.offset.x - (dt * this.visV) / 0.5) % 1;
      u.head.rotation.y += dt * (this.visV / 0.15);
      u.tail.rotation.y += dt * (this.visV / 0.13);
    }
    if (this.installed || this.build >= 0) { this._lumps(); this._fill(); }
    // the chute: a stream while something leaves the head (no trommel yet)
    const cu = this.chute.userData;
    cu.fall.visible = this.chute.visible && this.belt.running && !!this.belt.cells[this.belt.slots - 1];
    if (cu.fall.visible) cu.fall.scale.y = 0.32 + 0.05 * Math.sin(this.time * 29);
    // the post: lamp and lever (down aus, middle auto, up an)
    this.pm.A.setLamp(this.post, st.lamp);
    const lv = this.post.userData.lever, want = this.mode === "on" ? 0.6 : this.mode === "auto" ? 0 : -0.6;
    lv.rotation.z += (want - lv.rotation.z) * Math.min(1, dt * 10);
    this._hum = (this._hum || 0) - dt;
    if (near && this.belt.running && this._hum <= 0 && onSound) { this._hum = 1.1; onSound("conveyor_run"); }
  }

  serialize() {
    const st = this.stats;
    return { state: this.build >= 0 ? "ready" : this.state, mode: this.mode, intake: this.intake.serialize(), belt: this.belt.serialize(),
      stats: { ...st, runS: Math.round(st.runS), blockedS: Math.round(st.blockedS), starvedS: Math.round(st.starvedS) } };
  }

  dispose() {
    const cols = this.world.colliders;
    for (const c of this.colliders) { const i = cols.indexOf(c); if (i >= 0) cols.splice(i, 1); }
    for (const o of [this.intakeModel, this.model, this.chute, this.post, this.kit, this.gen]) this.scene.remove(o);
    for (const m of this._merged || []) m.geometry.dispose();
  }
}

// =====================================================================================
// TROMMEL: the screen over the bulk hopper, its oversize pile
// =====================================================================================
export class Trommel {
  /**
   * @param saved doc.processing.trommel (v8) or null
   * @param ctx   { nextId, bulk: () => BulkHopper, conveyor: () => Conveyor, warm }
   */
  constructor(THREE, scene, world, pm, saved, ctx) {
    this.THREE = THREE;
    this.scene = scene;
    this.world = world;
    this.pm = pm;
    this.ctx = ctx;
    const s = saved || {};
    this.state = s.state === "ready" ? "ready" : "delivered";
    this.feed = new MaterialBuffer({ capacityMl: TROMMEL_FEED_ML, stage: STAGE.RAW, layers: s.feed && s.feed.layers });
    // Prompt 10: the oversize lies on the OVERSIZE stockpile; a phase-9 save's oversize buffer moves onto it once
    this._none = new MaterialBuffer({ capacityMl: 0, stage: STAGE.RAW });
    const legacy = s.oversize && Array.isArray(s.oversize.layers) ? new MaterialBuffer({ capacityMl: 1e12, stage: STAGE.RAW, layers: s.oversize.layers }) : null;
    const pile = ctx.pile ? ctx.pile() : null;
    if (legacy && pile) for (const l of legacy.layers.splice(0)) pile.restore(l, OVER_DROP.x, OVER_DROP.z, 0.9);
    // the stacker: what the chute drops on it (a few litres), the belt, what its head throws onto the pile (same step)
    this.overIn = new MaterialBuffer({ capacityMl: OVER_IN_ML, stage: STAGE.RAW, layers: s.overIn && s.overIn.layers });
    this._overBin = new MaterialBuffer({ capacityMl: 1e12, stage: STAGE.RAW });
    const og = overBeltGeom();
    this.overBelt = new Belt({ from: () => this.overIn, to: () => (this.pileAtHead ? null : this._overBin), slots: OVER_SLOTS, cellLen: og.len / OVER_SLOTS, cellMl: OVER_CELL_ML, speed: OVER_SPEED, saved: s.overBelt });
    this.acc = Number.isFinite(s.acc) ? Math.max(0, Math.min(TROMMEL_STEP_ML, s.acc)) : 0;
    // Prompt 10: the nugget trap - the pieces too big for the screen, whole (each its own key), until taken out
    this.trap = Array.isArray(s.trap) ? s.trap.filter((f) => f && f.cls === FIND.NUGGET && int(f.ug) > 0).map((f) => ({ cls: FIND.NUGGET, ug: int(f.ug), key: String(f.key || "") })) : [];
    const st = s.stats || {};
    this.stats = { inMl: int(st.inMl), underMl: int(st.underMl), overMl: int(st.overMl), underUg: int(st.underUg), overUg: int(st.overUg), runS: int(st.runS), recoveredMl: int(st.recoveredMl),
      blockedS: int(st.blockedS), starvedS: int(st.starvedS), trapped: int(st.trapped) };
    this.build = -1;
    this.time = 0;
    this.running = false;
    this.why = null;
    this.flowK = 0;
    this._build();
    this.applyUpgrades();
  }

  // Prompt 10: the trommel upgrade - a second drive and spray bar: twice the litres a minute (you see / hear it)
  applyUpgrades() {
    const ups = this.ctx.upgrades ? this.ctx.upgrades() : null, fast = !!(ups && ups.has("trommel.fast"));
    this.fast = fast;
    this.lpm = fast ? TROMMEL_FAST_LPM : TROMMEL_LPM;
    const u = this.model.userData, on = this.installed || this.build >= 0;
    u.up.visible = fast && on;
    if (this._merged && this._mergedFast !== fast) {           // bought later: re-baked with the frame (no extra draws)
      for (const m of this._merged) { if (m.parent) m.parent.remove(m); m.geometry.dispose(); }
      const su = this.stacker.userData;
      unmerge({ remove() {} }, [], [...u.parts, ...u.rotorParts, ...u.upParts, ...su.parts]);
      this._merged = null;
      this._mergeT();
    }
  }

  // built: frame, drum, stacker baked per material (the upgrade's drive / spray bar with the frame)
  _mergeT() {
    const u = this.model.userData, keep = new Set([u.lamp]), ups = this.ctx.upgrades ? this.ctx.upgrades() : null, fast = !!(ups && ups.has("trommel.fast"));
    u.up.visible = fast;
    this._merged = [...mergeStatic(this.THREE, this.model, [...u.parts.filter((p) => !keep.has(p) && p.parent === this.model), ...(fast ? u.upParts : [])]),
      ...mergeStatic(this.THREE, u.ax, u.parts.filter((p) => p.parent === u.ax)),
      ...mergeStatic(this.THREE, u.rotor, u.rotorParts)];
    const su = this.stacker.userData;
    this._merged.push(...mergeStatic(this.THREE, su.inc, su.parts.filter((p) => p.parent === su.inc)), ...mergeStatic(this.THREE, this.stacker, su.parts.filter((p) => p.parent === this.stacker)));
    this._mergedFast = fast;
    if (this.ctx.warm) this.ctx.warm();
  }

  _build() {
    const THREE = this.THREE, pm = this.pm;
    this.model = pm.trommel();
    this.stacker = pm.overBelt();
    this.scene.add(this.stacker);
    this.pile = pm.oversizePile();
    this.kit = pm.trommelKit();
    this.wet = pm.wetPatch();
    this.wet.position.y = this.world.groundAt(this.wet.position.x, this.wet.position.z) + 0.01;
    this.scene.add(this.wet);
    this.kit.position.set(TROMMEL_KIT.x, 0, TROMMEL_KIT.z);
    this.kit.rotation.y = 0.3;
    for (const o of [this.model, this.pile, this.kit]) this.scene.add(o);
    const u = this.model.userData;
    this.parts = [...u.parts, ...u.rotorParts, ...this.stacker.userData.parts];
    // the stacker's legs (you walk under its belt at the tail, not through its posts)
    const og = overBeltGeom(), c = Math.cos(og.yaw), sn = Math.sin(og.yaw);
    this.stackerColliders = [0.25, og.horiz - 0.2].flatMap((sx) => [-1, 1].map((zz) => {
      const lz = zz * (OVER_BELT.width / 2 + 0.1);
      return { type: "circle", x: OVER_BELT.tail.x + c * sx + sn * lz, z: OVER_BELT.tail.z - sn * sx + c * lz, r: 0.08 };
    }));
    this.stackerColliders.push({ type: "circle", x: TRAP.x, z: TRAP.z, r: 0.2 });          // (Prompt 10: the nugget trap at chest height)
    this.pileCollider = { type: "box", x: OVERSIZE.x, z: OVERSIZE.z, hw: 0, hd: 0, rot: 0 };
    this._v = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._m = new THREE.Matrix4(); this._c = [0, 0, 0];
    this._drops = Array.from({ length: 36 }, () => ({ t: -1, x: 0, y: 0, z: 0, v: 0 }));
    this._sync();
  }

  get installed() { return this.state === "ready"; }
  get pileRef() { return this.ctx.pile ? this.ctx.pile() : null; }
  // the oversize: the pile's material (Prompt 10)
  get oversize() { const p = this.pileRef; return p ? p.buffer : this._none; }
  get overMl() { return this.oversize.volumeMl; }
  // Prompt 10: the pile under the stacker's head reaches up to it -> the stacker stops; its feed full -> the trommel waits
  get pileAtHead() { const p = this.pileRef; return !p || p.thickAt(OVER_DROP.x, OVER_DROP.z) >= OVER_H || p.room < 4000; }
  get pileAtChute() { return this.overIn.room < TROMMEL_STEP_ML; }

  _under() { const bk = this.ctx.bulk(); return bk && bk.installed ? bk.buffer : null; }

  startBuild() {
    if (this.state !== "delivered" || this.build >= 0) return false;
    this.build = 0;
    this._sync();
    const cv = this.ctx.conveyor();
    if (cv) cv._sync();
    return true;
  }

  // it turns with the belt (one plant, one lever)
  wants() { const cv = this.ctx.conveyor(); return this.installed && !!(cv && cv.installed && cv.wants()); }

  process(dt) {
    const run = this.wants();
    this.running = run;
    this.why = null;
    if (!run) { this.acc = 0; return 0; }
    this.stats.runS += dt;
    this.acc += (this.lpm * 1000 / 60) * dt;
    let done = 0;
    while (this.acc >= TROMMEL_STEP_ML) {
      if (this.feed.volumeMl <= 0) { this.why = "starved"; break; }
      const under = this._under();
      if (!under || roomOf(under) < TROMMEL_STEP_ML) { this.why = "blocked"; break; }
      if (this.pileAtChute) { this.why = "pile"; break; }
      const part = this.feed.take(TROMMEL_STEP_ML, this.ctx.nextId(), TROMMEL_STEP_ML);
      const vol = part.volumeMl;
      const { under: u, over: o, caught } = trommelSplit(part, [this.ctx.nextId(), this.ctx.nextId()]);
      if (caught.length) {                                       // (Prompt 10: too big for the holes -> the trap)
        for (const f of caught) this.trap.push(f);
        this.stats.trapped += caught.length;
        this._trapSig = null;
        if (this.ctx.onTrap) this.ctx.onTrap(caught);
      }
      this.stats.underMl += u.volumeMl; this.stats.underUg += u.goldUg;
      this.stats.overMl += o.volumeMl; this.stats.overUg += o.goldUg;
      putInto(under, u);
      // the oversize slides down the chute onto the stacker (Prompt 10: it carries it to the strip's south end)
      if (!o.empty) putInto(this.overIn, o);
      const bk = this.ctx.bulk();
      if (bk) bk.stats.inMl += u.volumeMl;
      this.acc -= TROMMEL_STEP_ML;
      done += vol;
    }
    if (this.why) this.acc = Math.min(this.acc, TROMMEL_STEP_ML);
    // the stacker runs with the drum; its head throws onto the pile, a little apart every time (stones roll on)
    this.overBelt.on = run;
    this.overBelt.step(dt, this.ctx.nextId);
    if (this._overBin.volumeMl > 0 || this._overBin.goldUg > 0) {
      const j = this._j = ((this._j || 0) + 1) % 997, a = j * 2.39996, rr = 0.1 + 0.35 * ((j * 0.618) % 1);
      this.pileRef.dumpFrom(this._overBin, Infinity, OVER_DROP.x + Math.cos(a) * rr * 0.5, OVER_DROP.z - 0.15 + Math.sin(a) * rr, 0.4);
    }
    this._fed = done > 0 ? 1.5 : Math.max(0, (this._fed || 0) - dt);
    if (this.why === "blocked" || this.why === "pile") this.stats.blockedS += dt;
    else if (this.why === "starved" && this.feed.volumeMl <= 0) this.stats.starvedS += dt;
    if (done > 0) { const bk = this.ctx.bulk(); if (bk) bk._fill(); }
    return done;
  }

  status() {
    if (!this.installed) return { key: "off", text: "noch nicht aufgebaut", lamp: "off" };
    if (!this.running) return { key: "off", text: "steht (läuft mit dem Förderband)", lamp: "off" };
    if (this.why === "blocked") return { key: "blocked", text: "wartet – der Vorratstrichter ist voll", lamp: "wait" };
    if (this.why === "pile") return { key: "blocked", text: "wartet – der Überkornhaufen reicht bis an den Kopf des Überkornbands", lamp: "wait" };
    if (this.why === "starved" && this.feed.volumeMl <= 0) return { key: "starved", text: "dreht leer – nichts im Aufgabekasten", lamp: "wait" };
    return { key: "moving", text: `siebt · ${this.lpm} l/min`, lamp: "on" };
  }

  // recovering the oversize: up to maxMl into a holder (a barrow, the excavator's bucket) - off the top of the
  // pile (the loader takes it with its bucket from the pile itself) -> ml
  takeOversize(holder, maxMl = Infinity) {
    const p = this.pileRef;
    if (!p || p.volumeMl <= 0) return 0;
    const pk = p.peak(), want = Math.min(maxMl, roomOf(holder));
    const got = p.cut(pk.x - 0.6, pk.z, 1, 0, 0.55, 1.2, pk.y - 0.45, want);
    if (got.volumeMl <= 0) return 0;
    const ml = got.volumeMl;
    putInto(holder, got);
    this.stats.recoveredMl += ml;
    return ml;
  }

  // the ledger: the feed box, the stacker, the nugget trap (the pile counts as a stockpile)
  goldUg() { return this.feed.goldUg + this.overIn.goldUg + this.overBelt.goldUg + this._overBin.goldUg + this.trapUg; }
  get trapUg() { let u = 0; for (const f of this.trap) u += f.ug; return u; }
  // Prompt 10: take the trap's pieces out (the caller books them into the pouch in the same call)
  takeTrap() { const out = this.trap; this.trap = []; this._trapSig = null; return out; }
  massG() { return this.feed.massG + this.overIn.massG + this.overBelt.massG + this._overBin.massG; }

  // ---- visuals

  _sync() {
    const on = this.installed || this.build >= 0;
    this.kit.visible = this.state === "delivered" && this.build < 0;
    this.model.visible = on;
    this.stacker.visible = on;
    const cols = this.world.colliders;
    for (const c of this.stackerColliders) { const i = cols.indexOf(c); if (on && i < 0) cols.push(c); if (!on && i >= 0) cols.splice(i, 1); }
    this.pile.visible = false;                       // (the phase-9 cone: the real pile draws itself)
    if (this.installed && !this._merged) this._mergeT();
    if (this.model.userData.up) this.applyUpgrades();
  }

  update(dt, near, onSound) {
    this.time += dt;
    const u = this.model.userData;
    if (this.build >= 0) {
      this.build += dt;
      const k = Math.min(1, this.build / BUILD_S);
      growParts(this.parts, k);
      if (k >= 1) { grownParts(this.parts); this.build = -1; this.state = "ready"; this._sync(); const cv = this.ctx.conveyor(); if (cv) cv._sync(); }
    }
    const st = this.status(), turning = this.installed && this.running && st.key !== "blocked";
    const feeding = turning && ((this._fed || 0) > 0 || this.feed.volumeMl > 500);
    this.flowK += ((feeding ? 1 : 0) - this.flowK) * Math.min(1, dt * 3);
    const spin = this.fast ? 2.7 : 2.1;                       // ~20 rpm (upgraded ~26), run up / out
    this.spinV = (this.spinV || 0) + ((turning ? spin : 0) - (this.spinV || 0)) * Math.min(1, dt * (turning ? 1.2 : 0.8));
    if (this.spinV > 0.002) u.rotor.rotation.x += dt * this.spinV;
    u.ax.position.y = TROMMEL.feedY + (this.spinV > 0.3 ? (0.0012 + 0.0018 * this.flowK) * Math.sin(this.time * 61) * (this.spinV / 2.1) : 0);
    this.pm.A.setLamp({ userData: { lamp: u.lamp } }, st.lamp);
    // inside: lumps tumbling down the drum (as much as the feed holds), water from the spray bars
    const T = TROMMEL, L = T.len, tb = u.tumble;
    const nT = this.installed ? Math.min(16, Math.round(this.feed.volumeMl / 1500)) : 0;
    if (nT || tb.count) {
      tb.count = nT;
      const top = this.feed.top(1)[0], col = top ? tint(top, this._c) : MAT_RGB[0];
      for (let i = 0; i < nT; i++) {
        const ph = fract((turning ? this.time * 0.22 : 0) + i / Math.max(1, nT)), a = -Math.PI / 2 + 0.6 + Math.sin(this.time * 2.1 + i) * 0.35 * (turning ? 1 : 0);
        const sz = 0.05 + 0.025 * fract(i * 0.618);
        this._m.compose(this._v.set(0.15 + ph * (L - 0.3), Math.sin(a) * (T.r - sz), Math.cos(a) * (T.r - sz)), this._q.setFromAxisAngle(this._s.set(1, 0, 0), this.time * 3 + i), this._s.set(sz, sz, sz));
        tb.setMatrixAt(i, this._m);
        tb.instanceColor.setXYZ(i, col[0], col[1], col[2]);
      }
      tb.instanceMatrix.needsUpdate = true; tb.instanceColor.needsUpdate = true;
    }
    if (turning && !this.lowDetail) this._spray(dt);
    else if (u.drops.count) u.drops.count = 0;
    u.curtain.visible = this.flowK > 0.2;
    if (u.curtain.visible) { u.curtain.scale.y = 0.3 + 0.04 * Math.sin(this.time * 23); u.curtain.material.opacity = 0.5 + 0.4 * this.flowK; }
    // the belt's head throwing its load into the feed box
    const cv = this.ctx.conveyor(), bt = cv && cv.belt;
    u.feedFall.visible = this.installed && !!(bt && bt.running && bt.cells[bt.slots - 1]);
    if (u.feedFall.visible) u.feedFall.scale.y = 0.36 + 0.05 * Math.sin(this.time * 31);
    // oversize sliding down the chute while it screens
    const ov = u.over, nO = this.flowK > 0.3 ? 6 : 0;
    if (nO || ov.count) {
      ov.count = nO;
      const [a, b] = u.chute, last = this.oversize.top(1)[0], col = last ? tint(last, this._c) : MAT_RGB[2];
      for (let i = 0; i < nO; i++) {
        const ph = fract(this.time * 0.8 + i / nO), sz = 0.035 + 0.02 * fract(i * 0.37);
        this._m.compose(this._v.set(a[0] + (b[0] - a[0]) * ph, a[1] + (b[1] - a[1]) * ph + 0.04, a[2] + (b[2] - a[2]) * ph + (fract(i * 0.71) - 0.5) * 0.2), this._q.setFromAxisAngle(this._s.set(0, 0, 1), -this.time * 6 - i), this._s.set(sz, sz, sz));
        ov.setMatrixAt(i, this._m);
        ov.instanceColor.setXYZ(i, col[0] * 0.95, col[1] * 0.95, col[2] * 0.95);
      }
      ov.instanceMatrix.needsUpdate = true; ov.instanceColor.needsUpdate = true;
    }
    // the stacker: stones riding up it (from its cells), the stream off its head onto the pile
    const su = this.stacker.userData, ob = this.overBelt, sl = su.lumps;
    let nl = 0;
    for (let i = 0; i < ob.slots && nl < 24; i++) {
      const c = ob.cells[i];
      if (!c || c.volumeMl < 60) continue;
      const k = c.volumeMl >= 500 ? 2 + (c.volumeMl >= 1000 ? 1 : 0) : 1, x0 = ob.cellAt(i), col = tint(c, this._c);
      for (let j = 0; j < k && nl < 24; j++) {
        const h = fract(Math.sin((c.id + j * 13) * 12.9898) * 43758.5453), h2 = fract(h * 7.31), sz = 0.03 + 0.03 * h;
        this._q.setFromAxisAngle(this._v.set(0, 1, 0), h * 6.28);
        this._m.compose(this._v.set(x0 + (h2 - 0.5) * ob.cellLen * 0.7, 0.02 + sz * 0.5, (j % 2 ? 1 : -1) * (0.03 + 0.08 * h2)), this._q, this._s.set(sz * 1.3, sz * 0.8, sz));
        sl.setMatrixAt(nl, this._m);
        const d = 0.62 + 0.15 * h2;
        sl.instanceColor.setXYZ(nl, col[0] * d, col[1] * d, col[2] * d);
        nl++;
      }
    }
    if (nl || sl.count) { sl.count = nl; sl.instanceMatrix.needsUpdate = true; sl.instanceColor.needsUpdate = true; }
    su.fall.visible = this.installed && ob.running && !!ob.cells[ob.slots - 1];
    if (su.fall.visible) su.fall.scale.y = 0.38 + 0.05 * Math.sin(this.time * 33);
    // Prompt 10: the nugget trap's piece - the biggest one in it, at its size; a slow, faint warm gleam
    const tn = u.trapNugget;
    if (tn) {
      const sig = this.installed ? this.trap.length : 0;
      if (sig !== this._trapSig) {
        this._trapSig = sig;
        tn.visible = sig > 0;
        if (sig) { const ug = Math.max(...this.trap.map((f) => f.ug)), r = findSize(FIND.NUGGET, centsForMass(ug), 0.5); tn.scale.set(r, r, r); tn.position.y = TRAP.y - TRAP.h / 2 + 0.012 + r * 0.6; }
      }
      if (tn.visible) { tn.material.emissiveIntensity = 0.18 + 0.16 * Math.sin(this.time * 1.7); tn.rotation.y = 0.6; }
    }
    // the ground under it gets wet with the hours it has run (and stays so)
    const wk = this.installed ? Math.min(1, this.stats.runS / 120) : 0;
    this.wet.visible = wk > 0.02;
    if (this.wet.visible) this.wet.material.opacity = 0.18 + 0.42 * wk;
    this._hum = (this._hum || 0) - dt;
    if (near && turning && this._hum <= 0 && onSound) { this._hum = 1.3; onSound(feeding ? "trommel_run" : "trommel_idle"); }
  }

  // water from the spray bar's nozzles, falling through the drum (pooled droplets, axis frame)
  _spray(dt) {
    const u = this.model.userData, D = this._drops, T = TROMMEL;
    this._acc = (this._acc || 0) + dt * 60;
    while (this._acc >= 1) {
      this._acc -= 1;
      const d = D.find((q) => q.t < 0);
      if (!d) break;
      d.t = 0; d.x = 0.2 + Math.floor(Math.random() * 6) * ((T.len - 0.4) / 5); d.y = T.r + 0.14; d.z = -0.12 + (Math.random() - 0.5) * 0.05; d.v = -0.4 - Math.random() * 0.6;
    }
    let n = 0;
    for (const d of D) {
      if (d.t < 0) continue;
      d.t += dt; d.v -= 9.8 * dt; d.y += d.v * dt;
      if (d.y < -T.r - 0.35 || d.t > 0.6) { d.t = -1; continue; }
      const s = 0.012;
      this._m.compose(this._v.set(d.x, d.y, d.z), this._q.identity(), this._s.set(s, s * 5.5, s * 1.4));
      u.drops.setMatrixAt(n++, this._m);
    }
    u.drops.count = n;
    if (n) u.drops.instanceMatrix.needsUpdate = true;
  }

  serialize() {
    return { state: this.build >= 0 ? "ready" : this.state, feed: this.feed.serialize(), acc: Math.round(this.acc), overIn: this.overIn.serialize(), overBelt: this.overBelt.serialize(),
      trap: this.trap.map((f) => ({ cls: f.cls, ug: f.ug, key: f.key })),
      stats: { ...this.stats, runS: Math.round(this.stats.runS), blockedS: Math.round(this.stats.blockedS), starvedS: Math.round(this.stats.starvedS) } };
  }

  dispose() {
    const i = this.world.colliders.indexOf(this.pileCollider);
    if (i >= 0) this.world.colliders.splice(i, 1);
    for (const c of this.stackerColliders) { const k = this.world.colliders.indexOf(c); if (k >= 0) this.world.colliders.splice(k, 1); }
    for (const o of [this.model, this.pile, this.kit, this.wet, this.stacker]) this.scene.remove(o);
    for (const m of this._merged || []) m.geometry.dispose();
    const tn = this.model.userData.trapNugget;
    if (tn) { tn.geometry.dispose(); tn.material.dispose(); }
  }
}

// =====================================================================================
// SPOIL HEAP: where the waste goes (booked like tailings)
// =====================================================================================
export class SpoilHeap {
  /**
   * Prompt 10: the SPOIL stockpile behind phase 9's interface (dump / dumpFrom / over / radius / ml).
   * @param saved doc.processing.spoil: phase 9 { ml, g, ug, loads } (brought onto the pile once, its tailings
   *              booking kept) or v9 { v: 9, loads }; ctx { ledger, pile() }
   */
  constructor(THREE, scene, world, pm, saved, ctx, signTex) {
    this.scene = scene;
    this.world = world;
    this.ctx = ctx;
    const s = saved || {};
    this.loads0 = int(s.loads);
    const pile = this.pile;
    if (s.v !== 9 && int(s.ml) > 0 && pile) {
      // phase 9 kept totals only: one layer of that volume / mass / gold (already booked as tailings)
      const b = new MaterialBatch({ stage: STAGE.TAILINGS, source: "spoil" });
      b.volumeMl = int(s.ml); b.comp = [int(s.g), 0, 0, 0]; b.fineUg = int(s.ug);
      pile.restore(b, SPOIL.x, SPOIL.z, 1.4);
    }
    this.model = pile ? pile.load.surface : pm.spoilHeap();
    this.sign = pm.spoilSign(signTex);
    scene.add(this.sign);
    this.signCollider = { type: "circle", x: SPOIL_SIGN.x, z: SPOIL_SIGN.z, r: 0.12 };
    world.colliders.push(this.signCollider);
  }

  get pile() { return this.ctx.pile ? this.ctx.pile() : null; }
  get ml() { const p = this.pile; return p ? p.volumeMl : 0; }
  get g() { const p = this.pile; return p ? p.buffer.massG : 0; }
  get ug() { const p = this.pile; return p ? p.buffer.goldUg : 0; }
  get loads() { const p = this.pile; return this.loads0 + (p ? p.stats.dumps : 0); }
  get radius() { const p = this.pile; return p ? Math.max(1.2, p.radius) : 1.2; }

  // where the next load lands: a little apart every time (a broad heap, not a cone)
  _spot() {
    const j = this._j = ((this._j || 0) + 1) % 997, a = j * 2.39996, r = 0.4 + 1.6 * ((j * 0.618) % 1);
    return { x: SPOIL.x + Math.cos(a) * r, z: SPOIL.z + Math.sin(a) * r * 0.8 };
  }

  // waste in: everything in it leaves the containers for good (booked as tailings by the pile)
  dump(batch, at = null) {
    const p = this.pile;
    if (!p || !batch || batch.empty) return 0;
    const q = at || this._spot();
    return p.dump(batch, q.x, q.z, 0.6);
  }

  // a holder's content (up to maxMl) onto the heap -> ml
  dumpFrom(holder, maxMl = Infinity, at = null) {
    const p = this.pile;
    if (!p) return 0;
    const q = at || this._spot();
    return p.dumpFrom(holder, maxMl, q.x, q.z, 0.6);
  }

  // is (x, z) over the heap (where a load can be tipped)?
  over(x, z, margin = 0.6) { return Math.hypot(x - SPOIL.x, z - SPOIL.z) <= this.radius + margin; }

  serialize() { return { v: 9, loads: this.loads }; }

  dispose() {
    const i = this.world.colliders.indexOf(this.signCollider);
    if (i >= 0) this.world.colliders.splice(i, 1);
    this.scene.remove(this.sign);
  }
}

export { INTAKE, INTAKE_POST, INTAKE_SPOT, BELT, TROMMEL, OVERSIZE, SPOIL, BULK_AT, TRAP, volumeOf, lit, m3 };
