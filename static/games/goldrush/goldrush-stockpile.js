// GoldRush - stockpiles (Prompt 10, the working mine): real piles of loose
// material on the ground - what the excavator digs goes onto the RAW pile, the
// wheel loader takes it from there to the plant; the trommel's OVERSIZE, the
// wash plant's TAILINGS and the SPOIL heap are piles of the same kind.
//
//   SHAPE     a height field over the pile's site (cells of CELL = 25 cm). A
//             load tipped at a point lands there (spread over the bucket's
//             width) and then slides: every cell may stand at most its angle
//             of repose above a neighbour (8 neighbours), steeper material
//             avalanches down - a little every frame, so a fresh dump visibly
//             settles. The repose varies a little from cell to cell (stable
//             per site): no two piles alike, no cone - a pile tipped at
//             different places grows lopsided, then into a broad ridge. Wet
//             fine tailings run out flat (a fan), oversize cobbles stand steep.
//   MATERIAL  a MaterialBuffer (goldrush-transfer.js): every load its own layer
//             with its composition, fine gold and pieces - stockpiled pay dirt
//             keeps exactly the gold the ground gave it. Taken out from the
//             bottom (oldest first). The field's volume is the buffer's volume,
//             always (corrected after every move: the buffer is the truth).
//   TAKE      cut(): a bucket's mouth (a rectangle in front of its lip, at the
//             lip's height) takes the material above the lip inside it - only
//             as much as it can hold / as fast as it is pushed in; the face
//             then caves in behind (the same avalanche).
//   LEDGER    raw and oversize piles are containers (their gold counts in the
//             processing ledger's holders). Tailings and spoil are booked as
//             tailings the moment they land (gone from the plant's point of
//             view) - picking them up again books them back into containers;
//             nothing is created or lost either way.
//
// Visual: one GridLoad (goldrush-heap.js: a fixed grid of vertices, ragged
// edges by alpha, instanced lumps / cobbles by composition) per pile - two
// draws, fixed buffers, rebuilt only when the pile changed (at most ~12 / s).
// Everything runs in the game's frames (or the simulation hook); saved.

import { MaterialBuffer, takeFrom, putInto, volumeOf } from "./goldrush-transfer.js";
import { MaterialBatch, STAGE } from "./goldrush-material.js";
import { GridLoad } from "./goldrush-heap.js";
import { encodeInt16Rle, decodeInt16Rle } from "./goldrush-save.js";
import { noise2 } from "./goldrush-noise.js";

export const CELL = 0.25;                            // m: one cell of a pile's height field
const DIAG = Math.SQRT2;
const REBUILD_S = 0.085;                             // the mesh follows a settling pile at ~12 Hz
const RELAX_OPS = 9000;                              // avalanche steps per frame (a big dump settles over ~1 s)
const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

// the kinds: what stands on the sign, the angle of repose (tan), whether its content is booked as tailings,
// lump size / count, capacity, an own colour (else the composition's)
export const PILE_TYPES = {
  raw: { label: "RAW PAY DIRT", name: "Rohmaterial", repose: 0.74, tail: false, lumpK: 7, lumps: 300, capMl: 160e6, tint: null, wet: 0 },
  oversize: { label: "OVERSIZE", name: "Überkorn", repose: 0.92, tail: false, lumpK: 11, lumps: 360, capMl: 40e6, tint: [0.5, 0.48, 0.44], wet: 0.15 },
  tailings: { label: "TAILINGS", name: "Tailings", repose: 0.4, tail: true, lumpK: 3, lumps: 90, capMl: 600e6, tint: [0.6, 0.57, 0.52], wet: 0.6 },
  spoil: { label: "ABRAUM", name: "Abraum", repose: 0.72, tail: true, lumpK: 7, lumps: 260, capMl: 900e6, tint: null, wet: 0 },
};

// where the piles lie (world x / z, axis-aligned sites) and where a load lands by default
export const PILE_SITES = {
  raw: { type: "raw", x0: -14.5, x1: -5.5, z0: -24.0, z1: -16.25, drop: { x: -9.6, z: -18.6 } },
  oversize: { type: "oversize", x0: -24.4, x1: -21.4, z0: -9.4, z1: -2.9, drop: { x: -22.95, z: -4.15 } },
  tailings: { type: "tailings", x0: -24.4, x1: -18.9, z0: 3.9, z1: 10.6, drop: { x: -22.6, z: 4.6 } },
  spoil: { type: "spoil", x0: -23.9, x1: -16.9, z0: -21.6, z1: -13.9, drop: { x: -18.5, z: -15.5 } },
};

export const m3Text = (ml) => `${(ml / 1e6).toFixed(ml < 9.95e6 ? 1 : 0).replace(".", ",")} m³`;

export class Stockpile {
  /**
   * @param site  PILE_SITES entry (+ id)
   * @param saved serialize() output or null
   * @param ctx   { ledger, nextId, soilTex, seed }
   */
  constructor(THREE, scene, world, site, saved, ctx) {
    this.THREE = THREE;
    this.world = world;
    this.ctx = ctx;
    this.id = site.id;
    this.type = site.type;
    this.def = PILE_TYPES[site.type];
    this.site = site;
    this.x0 = site.x0; this.z0 = site.z0;
    this.nx = Math.round((site.x1 - site.x0) / CELL);
    this.nz = Math.round((site.z1 - site.z0) / CELL);
    this.x1 = this.x0 + this.nx * CELL; this.z1 = this.z0 + this.nz * CELL;
    const n = this.nx * this.nz, s = saved || {};
    this.h = new Float32Array(n);                    // m of material per cell
    this.base = new Float32Array(n);                 // the ground under each cell's centre (cached)
    this.jit = new Float32Array(n);                  // this cell's angle of repose (x the kind's)
    const seed = (ctx.seed || 1) + site.x0 * 13.1 + site.z0 * 7.7;
    for (let k = 0; k < n; k++) {
      const i = k % this.nx, j = (k - i) / this.nx, x = this.x0 + (i + 0.5) * CELL, z = this.z0 + (j + 0.5) * CELL;
      this.jit[k] = 1 + 0.2 * noise2(x * 0.7, z * 0.7, seed) + 0.1 * (hash(seed + k * 0.37) - 0.5);
    }
    this.buffer = new MaterialBuffer({ capacityMl: this.def.capMl, stage: this.def.tail ? STAGE.TAILINGS : STAGE.RAW, layers: s.buffer && s.buffer.layers });
    this.stats = { inMl: int(s.stats && s.stats.inMl), outMl: int(s.stats && s.stats.outMl), dumps: int(s.stats && s.stats.dumps), takes: int(s.stats && s.stats.takes) };
    // the settling queue (cells to look at), a flag per cell
    this.q = new Int32Array(n * 2);
    this.qn = 0;
    this.inQ = new Uint8Array(n);
    this._baseRev = -1;
    this._refreshBase();
    let shaped = false;
    if (typeof s.h === "string") {
      try {
        const mm = decodeInt16Rle(s.h, n);
        for (let k = 0; k < n; k++) this.h[k] = Math.max(0, mm[k]) / 1000;
        shaped = true;
      } catch (e) { shaped = false; }
    }
    // no shape saved (or it does not fit): the material it holds lands at the drop point
    if (!shaped && this.buffer.volumeMl > 0) { this.deposit(this.buffer.volumeMl / 1e6, site.drop.x, site.drop.z, 0.6); this.settle(); }
    this.fit();
    this._buildVisual(THREE, scene);
  }

  // ---------------------------------------------------------------- material

  get volumeMl() { return this.buffer.volumeMl; }
  // the processing ledger's holders: only containers count (tailings / spoil are booked out)
  get goldUg() { return this.def.tail ? 0 : this.buffer.goldUg; }
  get massG() { return this.def.tail ? 0 : this.buffer.massG; }
  get room() { return this.buffer.room; }
  get label() { return `${this.def.label} ${m3Text(this.volumeMl)}`; }

  /**
   * A load lands on the pile at (x, z) (the batch is emptied): into the buffer, onto the field (spread over r),
   * then it settles. -> ml taken (all of it, up to the pile's capacity: the rest stays in the batch)
   */
  dump(batch, x, z, r = 0.45) {
    if (!batch || batch.empty) return 0;
    let part = batch;
    if (batch.volumeMl > this.room) { part = batch.take(this.room, this.ctx.nextId ? this.ctx.nextId() : 0); if (part.empty) return 0; }
    const v = part.volumeMl;
    if (this.def.tail) { const L = this.ctx.ledger; L.tailUg += part.goldUg; L.tailG += part.massG; L.tailMl += part.volumeMl; }
    this.buffer.put(part);
    this.deposit(v / 1e6, x, z, r);
    this.stats.inMl += v; this.stats.dumps++;
    this.fit();
    return v;
  }

  /** a holder's content (a batch holder or a buffer, up to maxMl) onto the pile at (x, z) -> ml */
  dumpFrom(holder, maxMl = Infinity, x = this.site.drop.x, z = this.site.drop.z, r = 0.45) {
    const want = Math.min(volumeOf(holder), maxMl, this.room);
    if (!(want > 0)) return 0;
    const part = takeFrom(holder, want, this.ctx.nextId ? this.ctx.nextId() : 0, Math.min(maxMl, this.room));
    const v = this.dump(part, x, z, r);
    if (!part.empty) putInto(holder, part);          // a full pile: back where it came from
    return v;
  }

  /** material that already lies here (a save of an older version): onto the field, no ledger booking */
  restore(batch, x = this.site.drop.x, z = this.site.drop.z, r = 0.9) {
    if (!batch || batch.empty) return 0;
    const v = batch.volumeMl;
    this.buffer.put(batch);
    this.deposit(v / 1e6, x, z, r);
    this.settle();
    this.fit();
    return v;
  }

  /** the radius the material covers (m) - receivers aim at it */
  get radius() {
    let n = 0;
    for (let k = 0; k < this.h.length; k++) if (this.h[k] > 0.03) n++;
    return Math.max(0.6, Math.sqrt((n * CELL * CELL) / Math.PI));
  }

  /**
   * Take material out with a bucket's mouth: a rectangle from its lip (cx, cz) forward along (dx, dz) for
   * `depth` m, half-width hw, everything above lipY (world) inside it, up to maxMl.
   * -> a MaterialBatch (empty when there was nothing above the lip)
   */
  cut(cx, cz, dx, dz, hw, depth, lipY, maxMl) {
    const out = new MaterialBatch({ stage: STAGE.RAW });
    if (maxMl <= 0 || this.buffer.volumeMl <= 0) return out;
    const m3 = this._cutField(cx, cz, dx, dz, hw, depth, lipY, maxMl / 1e6);
    if (m3 <= 0) return out;
    const ml = Math.min(this.buffer.volumeMl, Math.round(m3 * 1e6));
    const part = this.buffer.take(ml, this.ctx.nextId ? this.ctx.nextId() : 0, maxMl);
    if (this.def.tail) { const L = this.ctx.ledger; L.tailUg -= part.goldUg; L.tailG -= part.massG; L.tailMl -= part.volumeMl; }
    out.absorb(part);
    out.source = this.type;
    this.stats.outMl += out.volumeMl; this.stats.takes++;
    this.fit();
    return out;
  }

  /** how much lies above lipY inside the mouth (m3) - for the loader's feel (resistance) and its fill rate */
  aboveLip(cx, cz, dx, dz, hw, depth, lipY) {
    let v = 0;
    this._eachInMouth(cx, cz, dx, dz, hw, depth, (k) => { v += Math.min(this.h[k], Math.max(0, this.base[k] + this.h[k] - lipY)); });
    return v * CELL * CELL;
  }

  // ---------------------------------------------------------------- the height field

  _cellOf(x, z) {
    const i = Math.floor((x - this.x0) / CELL), j = Math.floor((z - this.z0) / CELL);
    return i < 0 || j < 0 || i >= this.nx || j >= this.nz ? -1 : j * this.nx + i;
  }

  inside(x, z, margin = 0) { return x >= this.x0 - margin && x <= this.x1 + margin && z >= this.z0 - margin && z <= this.z1 + margin; }

  /** the material's thickness at (x, z) (bilinear over the cell centres), 0 outside */
  thickAt(x, z) {
    if (!this.inside(x, z)) return 0;
    const fx = (x - this.x0) / CELL - 0.5, fz = (z - this.z0) / CELL - 0.5;
    const i0 = clamp(Math.floor(fx), 0, this.nx - 1), j0 = clamp(Math.floor(fz), 0, this.nz - 1);
    const i1 = Math.min(this.nx - 1, i0 + 1), j1 = Math.min(this.nz - 1, j0 + 1), tx = clamp(fx - i0, 0, 1), tz = clamp(fz - j0, 0, 1);
    const h = this.h, nx = this.nx;
    const a = h[j0 * nx + i0] + (h[j0 * nx + i1] - h[j0 * nx + i0]) * tx, b = h[j1 * nx + i0] + (h[j1 * nx + i1] - h[j1 * nx + i0]) * tx;
    return a + (b - a) * tz;
  }

  /** the pile's surface at (x, z) in world y, or -Infinity where it holds (next to) nothing */
  heightAt(x, z) {
    if (!this._any || !this.inside(x, z)) return -Infinity;
    const t = this.thickAt(x, z);
    return t > 0.004 ? this.world.groundBelowAt(x, z) + t : -Infinity;
  }

  /** the top of the pile (world y) and where it is - the receivers' aim point */
  peak() {
    let best = -1, bh = 0;
    for (let k = 0; k < this.h.length; k++) if (this.h[k] > bh) { bh = this.h[k]; best = k; }
    if (best < 0) return { x: this.site.drop.x, z: this.site.drop.z, y: this.world.groundBelowAt(this.site.drop.x, this.site.drop.z), h: 0 };
    const i = best % this.nx, j = (best - i) / this.nx, x = this.x0 + (i + 0.5) * CELL, z = this.z0 + (j + 0.5) * CELL;
    return { x, z, y: this.base[best] + bh, h: bh };
  }

  /** m3 onto the field round (x, z), spread over r (a bucket's width), then queued to settle */
  deposit(m3, x, z, r = 0.45) {
    if (!(m3 > 0)) return;
    x = clamp(x, this.x0 + CELL, this.x1 - CELL); z = clamp(z, this.z0 + CELL, this.z1 - CELL);
    const rc = Math.max(1, Math.ceil(r / CELL)), ci = Math.floor((x - this.x0) / CELL), cj = Math.floor((z - this.z0) / CELL);
    const cells = [], ws = [];
    let wt = 0;
    for (let j = cj - rc; j <= cj + rc; j++) for (let i = ci - rc; i <= ci + rc; i++) {
      if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) continue;
      const dx = this.x0 + (i + 0.5) * CELL - x, dz = this.z0 + (j + 0.5) * CELL - z, d2 = (dx * dx + dz * dz) / (r * r);
      if (d2 > 1.4) continue;
      const w = Math.exp(-2.2 * d2);
      cells.push(j * this.nx + i); ws.push(w); wt += w;
    }
    if (!cells.length) { const k = clamp(cj, 0, this.nz - 1) * this.nx + clamp(ci, 0, this.nx - 1); cells.push(k); ws.push(1); wt = 1; }
    const per = m3 / (CELL * CELL * wt);
    for (let q = 0; q < cells.length; q++) { this.h[cells[q]] += per * ws[q]; this._push(cells[q]); }
    this._any = true;
    this.dirty = true;
  }

  _eachInMouth(cx, cz, dx, dz, hw, depth, fn) {
    const L = Math.hypot(dx, dz) || 1, fx = dx / L, fz = dz / L, px = -fz, pz = fx;
    const r = Math.hypot(hw, depth) + CELL;
    const i0 = Math.max(0, Math.floor((cx - r - this.x0) / CELL)), i1 = Math.min(this.nx - 1, Math.floor((cx + r - this.x0) / CELL));
    const j0 = Math.max(0, Math.floor((cz - r - this.z0) / CELL)), j1 = Math.min(this.nz - 1, Math.floor((cz + r - this.z0) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = this.x0 + (i + 0.5) * CELL - cx, z = this.z0 + (j + 0.5) * CELL - cz;
      const u = x * fx + z * fz, v = x * px + z * pz;
      if (u >= -CELL * 0.5 && u <= depth && Math.abs(v) <= hw) fn(j * this.nx + i);
    }
  }

  _cutField(cx, cz, dx, dz, hw, depth, lipY, maxM3) {
    const cells = [], av = [];
    let total = 0;
    this._eachInMouth(cx, cz, dx, dz, hw, depth, (k) => {
      const a = Math.min(this.h[k], Math.max(0, this.base[k] + this.h[k] - lipY));
      if (a > 1e-5) { cells.push(k); av.push(a); total += a; }
    });
    const tot3 = total * CELL * CELL;
    if (tot3 <= 0) return 0;
    const f = Math.min(1, maxM3 / tot3);
    for (let q = 0; q < cells.length; q++) {
      const k = cells[q];
      this.h[k] = Math.max(0, this.h[k] - av[q] * f);
      this._pushAround(k);
    }
    this.dirty = true;
    return tot3 * f;
  }

  _push(k) { if (!this.inQ[k] && this.qn < this.q.length) { this.inQ[k] = 1; this.q[this.qn++] = k; } }
  _pushAround(k) {
    const i = k % this.nx, j = (k - i) / this.nx;
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
      const ii = i + a, jj = j + b;
      if (ii >= 0 && jj >= 0 && ii < this.nx && jj < this.nz) this._push(jj * this.nx + ii);
    }
  }

  /** the avalanche: at most `ops` cells looked at -> whether it is still moving */
  relax(ops = RELAX_OPS) {
    const h = this.h, nx = this.nx, nz = this.nz, rep = this.def.repose * CELL, jit = this.jit;
    let n = 0, moved = false;
    while (this.qn > 0 && n < ops) {
      const k = this.q[--this.qn];
      this.inQ[k] = 0;
      n++;
      const i = k % nx, j = (k - i) / nx;
      let again = false;
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
        if (!a && !b) continue;
        const ii = i + a, jj = j + b;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
        const m = jj * nx + ii, diag = a && b;
        const lim = rep * (diag ? DIAG : 1) * (jit[k] + jit[m]) * 0.5;
        // what stands above the neighbour's surface (its own ground may lie higher or lower)
        const d = (this.base[k] + h[k]) - (this.base[m] + h[m]) - lim;
        if (d > 2e-4 && h[k] > 0) {
          const mv = Math.min(h[k], d * (diag ? 0.16 : 0.22));
          h[k] -= mv; h[m] += mv;
          this._push(m);
          again = true;
        }
      }
      if (again) { this._push(k); moved = true; }
    }
    if (moved) this.dirty = true;
    return this.qn > 0;
  }

  /** settle completely (loading a save, the simulation's long steps) */
  settle(maxOps = 4e6) {
    let left = maxOps;
    while (this.qn > 0 && left > 0) { this.relax(Math.min(left, 50000)); left -= 50000; }
  }

  /** the field holds exactly the buffer's volume (the buffer is the truth) */
  fit() {
    const want = this.buffer.volumeMl / 1e6 / (CELL * CELL);
    let have = 0;
    for (let k = 0; k < this.h.length; k++) have += this.h[k];
    if (want <= 0) { if (have > 0) { this.h.fill(0); this.dirty = true; } this._any = false; return; }
    if (have <= 0) { this.deposit(want * CELL * CELL, this.site.drop.x, this.site.drop.z, 0.6); return; }
    const f = want / have;
    if (Math.abs(f - 1) > 1e-7) { for (let k = 0; k < this.h.length; k++) this.h[k] *= f; this.dirty = true; }
    this._any = true;
  }

  _refreshBase() {
    const rev = this.world.terrain ? this.world.terrain.revision : 0;
    if (rev === this._baseRev) return false;
    this._baseRev = rev;
    for (let k = 0; k < this.base.length; k++) {
      const i = k % this.nx, j = (k - i) / this.nx;
      this.base[k] = this.world.groundBelowAt(this.x0 + (i + 0.5) * CELL, this.z0 + (j + 0.5) * CELL);
    }
    this.dirty = true;
    return true;
  }

  // ---------------------------------------------------------------- visual

  _buildVisual(THREE, scene) {
    this.group = new THREE.Group();
    this.group.name = `goldrush-pile-${this.id}`;
    scene.add(this.group);
    const d = this.def;
    this.load = new GridLoad(THREE, this.group, { nx: this.nx + 1, nz: this.nz + 1, x0: this.x0, x1: this.x1, z0: this.z0, z1: this.z1,
      lumps: d.lumps, map: this.ctx.soilTex || null, uv: 0.9, shadow: true, seed: 7 + Math.abs(Math.round(this.x0 * 3)), roughness: 0.97, lumpK: d.lumpK });
    this.load.surface.name = this.load.lumps.name = `goldrush-pile-${this.id}`;
    this.load.surface.userData.pile = this.id;
    this._vbase = new Float32Array((this.nx + 1) * (this.nz + 1));
    this._vbaseRev = -1;
    this._t = REBUILD_S;
    this._shapeFn = (x, z, o) => this._shapeAt(x, z, o);
    this._rgb = [0, 0, 0];
    this.dirty = true;
    this._redraw();
  }

  _shapeAt(x, z, o) {
    // the vertex's material: the mean of its (up to) four cells; a little relief where it is thick
    const fi = (x - this.x0) / CELL, fj = (z - this.z0) / CELL, i = Math.round(fi), j = Math.round(fj);
    let s = 0, c = 0;
    for (let b = j - 1; b <= j; b++) for (let a = i - 1; a <= i; a++) {
      if (a < 0 || b < 0 || a >= this.nx || b >= this.nz) continue;
      s += this.h[b * this.nx + a]; c++;
    }
    const t = c ? s / c : 0, vb = this._vbase[j * (this.nx + 1) + i];
    const relief = (0.035 * noise2(x * 2.3, z * 2.3, 61) + 0.015 * noise2(x * 7.1, z * 7.1, 67)) * Math.min(1, t / 0.25);
    o.y = (Number.isFinite(vb) ? vb : 0) + t + relief + 0.012;
    o.t = t;
    o.a = clamp((t - 0.006 + 0.01 * noise2(x * 3.3, z * 3.3, 71)) / 0.012, 0, 1);
    o.l = t > 0.05 ? 1 : 0;
  }

  _redraw() {
    if (this._vbaseRev !== this._baseRev) {
      this._vbaseRev = this._baseRev;
      for (let j = 0; j <= this.nz; j++) for (let i = 0; i <= this.nx; i++) this._vbase[j * (this.nx + 1) + i] = this.world.groundBelowAt(this.x0 + i * CELL, this.z0 + j * CELL);
    }
    const v = this.buffer.volumeMl, any = v > 2000;
    this.load.setVisible(any);
    if (!any) { this.dirty = false; return; }
    const comp = this.buffer.comp(this._comp || (this._comp = [0, 0, 0, 0]));
    let rgb = null;
    if (this.def.tint) rgb = this.def.tint;
    // the sign changes with every redraw (the field moved)
    this._sig = (this._sig || 0) + 1;
    const amount = this.type === "oversize" ? 1 : this.type === "tailings" ? 0.35 : 0.85;
    this.load.set(this._sig, this._shapeFn, comp, { amount, rgb, tMax: 0.6 });
    this.dirty = false;
  }

  /** per frame: settle, follow the ground, redraw when it changed -> whether it is still moving */
  update(dt) {
    const moving = this.relax();
    if (this._refreshBase()) this.dirty = true;
    this._t += dt;
    if (this.dirty && this._t >= REBUILD_S) { this._t = 0; this._redraw(); }
    return moving;
  }

  /** a ray against the pile's surface (marching) -> { distance, x, y, z } or null */
  raycast(ox, oy, oz, dx, dy, dz, maxD) {
    if (!this._any) return null;
    const step = 0.05;
    let prevAbove = true;
    for (let d = 0; d <= maxD; d += step) {
      const x = ox + dx * d, y = oy + dy * d, z = oz + dz * d;
      if (!this.inside(x, z)) { prevAbove = true; continue; }
      const t = this.thickAt(x, z);
      if (t < 0.02) { prevAbove = true; continue; }
      const top = this.world.groundBelowAt(x, z) + t;
      if (y <= top) return prevAbove ? { distance: d, x, y: top, z } : null;
      prevAbove = true;
    }
    return null;
  }

  // GPU warm-up (no first-look upload when the first load lands)
  warm(on) { this.load.warm(on); }

  serialize() {
    const n = this.h.length, mm = new Int16Array(n);
    for (let k = 0; k < n; k++) mm[k] = Math.min(32767, Math.round(this.h[k] * 1000));
    return { type: this.type, h: encodeInt16Rle(mm), buffer: this.buffer.serialize(), stats: { ...this.stats } };
  }

  dispose() {
    this.load.dispose();
    this.group.removeFromParent();
  }
}

/** All piles of the mine. Piles exist from the start (empty ones draw nothing). */
export class StockpileSystem {
  /** @param saved doc.processing.piles (v9) or null; ctx { ledger, nextId, soilTex, seed } */
  constructor(THREE, scene, world, saved, ctx) {
    this.THREE = THREE;
    this.scene = scene;
    this.world = world;
    this.ctx = ctx;
    this.piles = {};
    const s = (saved && saved.piles) || {};
    for (const [id, site] of Object.entries(PILE_SITES)) this.piles[id] = new Stockpile(THREE, scene, world, { ...site, id }, s[id] || null, ctx);
    this._heightSource = { heightAt: (x, z) => this.heightAt(x, z) };
    world.addHeightSource(this._heightSource);
  }

  get(id) { return this.piles[id] || null; }
  list() { return Object.values(this.piles); }

  // the ledger: what the container piles hold
  goldUg() { let u = 0; for (const p of this.list()) u += p.goldUg; return u; }
  massG() { let g = 0; for (const p of this.list()) g += p.massG; return g; }
  volumeMl() { let v = 0; for (const p of this.list()) v += p.def.tail ? 0 : p.volumeMl; return v; }

  /** the highest pile surface at (x, z) (world y) or -Infinity */
  heightAt(x, z) {
    let best = -Infinity;
    for (const p of this.list()) { const y = p.heightAt(x, z); if (y > best) best = y; }
    return best;
  }

  /** which pile covers (x, z) (material there, or within margin of its site) */
  at(x, z, margin = 0) {
    let best = null, bt = 0;
    for (const p of this.list()) {
      if (!p.inside(x, z, margin)) continue;
      const t = p.thickAt(x, z);
      if (!best || t > bt) { best = p; bt = t; }
    }
    return best;
  }

  raycast(ox, oy, oz, dx, dy, dz, maxD) {
    let best = null;
    for (const p of this.list()) {
      const r = p.raycast(ox, oy, oz, dx, dy, dz, maxD);
      if (r && (!best || r.distance < best.distance)) best = { ...r, pile: p };
    }
    return best;
  }

  update(dt) { let moving = false; for (const p of this.list()) if (p.update(dt)) moving = true; return moving; }
  settle() { for (const p of this.list()) { p.settle(); p.dirty = true; p._redraw(); } }
  warm(on) { for (const p of this.list()) p.warm(on); }

  serialize() {
    const piles = {};
    for (const [id, p] of Object.entries(this.piles)) if (p.volumeMl > 0 || p.stats.dumps) piles[id] = p.serialize();
    return { piles };
  }

  dispose() {
    this.world.removeHeightSource(this._heightSource);
    for (const p of this.list()) p.dispose();
  }
}
