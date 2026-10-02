// GoldRush - mining. One tool action is ONE transaction, in this order:
//
//   1. valid target?           (the mound, inside the dig area, not under your own feet)
//   2. within the tool's reach?
//   3. a boulder?              (pickaxe: damage it; hand / shovel: bounce off)
//   4. material workable with this tool?   (stone: only the pickaxe)
//   5. how much actually comes off         (tool kernel x material efficiency per cell,
//                                           loosened ground counts extra)
//   6. deform the terrain                  (exact 0.1 mm integer heights)
//   7. consume the resource                (each 1 cm slice of each column exactly once)
//   8. which finds were in it              (fixed per slice by the world seed)
//   9. local settling                      (material RELOCATED, never removed)
//
// Removed and relocated material are kept apart: the result reports the
// requested volume (what the kernel asked for), the actually removed
// volume and mass (what left the mountain), the relocated volume (what slid
// inside it) and the processed resource volume (slices that were checked
// for gold). Gold only ever comes from removed material.
//
// Depletion: `cidx[k]` is the lowest slice of column k that is used up (an
// integer - exact, also across save/reload), `consumed[k]` the worked level
// itself (for the look and the statistics). A slice pays out when a tool
// takes the column below its centre - once.
// When settling moves material off a column below its worked level (a cut
// face slumps), those slices are used up THERE and whatever finds they held
// travel with the material: they are "carried" in the receiving column at
// the height they landed, and pay out when a tool later removes that layer.
// Nothing is lost, nothing pays twice, nothing pays for material that only
// slid.
// The fine gold of every used-up slice (goldrush-resources.js) is reported
// with the dig (fineUg) - the caller decides where that material goes
// (a bucket for processing, or the spoil). Slid fine gold rides along per
// receiving column (carriedFine) and comes out with that column's next cut.

import { MAT, MATERIALS } from "./goldrush-materials.js";
import { FIND, VOXEL_H } from "./goldrush-resources.js";
import { decodeInt16Rle, decodeIntRle, encodeInt16Rle, encodeIntRle } from "./goldrush-save.js";
import { SLICE_ORIGIN_Y } from "./goldrush-terrain.js";
import { toolEfficiency } from "./goldrush-tools.js";

const FEET_RADIUS = 0.45;        // m: no digging straight under your own feet
// index of the lowest slice whose centre is at or above height h
const sliceIndex = (h) => Math.ceil((h - SLICE_ORIGIN_Y) / VOXEL_H - 0.5);
const MAX_FINDS = 32;
const OLD_VOXEL_H = 0.05;         // phase-2 saves: 5 cm slices
const Q = 10000;                  // 0.1 mm

export class MiningSystem {
  constructor(terrain, rocks = null) {
    this.terrain = terrain;
    this.field = terrain.field;
    this.rocks = rocks;
    this.consumed = new Float32Array(terrain.height.length);
    this.consumed.set(terrain.height);                  // nothing below the surface is worked yet
    this.cidx = new Int16Array(terrain.height.length);
    this.carried = new Map();                           // column -> [{ cls, massUg, key, y }]
    this.carriedCount = 0;
    this.carriedFine = new Map();                       // column -> { ug, y }: fine gold in slid material
    this._resetIndex();
    terrain.consumed = this.consumed;
    terrain.onRelocate = (a, b, before, after) => this._relocate(a, b, before, after);
    this._vox = {};
    this.sliceVolume = VOXEL_H * terrain.cell * terrain.cell;
    // ledger (session): fine gold of used-up slices = paid out with digs + still riding in slid material
    this.totals = { relocatedSlices: 0, carriedPaid: 0, fineUsedUg: 0, finePaidUg: 0 };
    this.result = {
      ok: false, reason: "", kind: "", material: MAT.DIRT, blocked: false, cells: 0, chunks: 0,
      requestedVolume: 0, removedVolume: 0, removedMassKg: 0, relocatedVolume: 0, processedVolume: 0,
      massKg: 0, freshKg: 0, volumeL: 0, massByMat: [0, 0, 0, 0], slices: 0, finds: [], findCount: 0, fineUg: 0, rock: null,
    };
    for (let i = 0; i < MAX_FINDS; i++) this.result.finds.push({ cls: 0, massUg: 0, x: 0, y: 0, z: 0, mat: 0, key: "" });
    this._n = { x: 0, y: 1, z: 0 };
    this._u = { x: 0, y: 0, z: 1 };
  }

  _resetIndex() {
    const H = this.terrain.height, I = this.cidx;
    for (let k = 0; k < H.length; k++) I[k] = sliceIndex(H[k]);
    this.carried.clear();
    this.carriedCount = 0;
    this.carriedFine.clear();
  }

  // material at the very surface of a hit (a boulder is always stone)
  materialAtHit(hit) {
    if (hit.boulder != null) return MAT.STONE;
    return this.field.materialAt(hit.x, hit.y - 0.01, hit.z);
  }

  looseAtHit(hit) {
    const t = this.terrain, i = Math.round((hit.x - t.x0) / t.cell), j = Math.round((hit.z - t.z0) / t.cell);
    if (i < 0 || j < 0 || i >= t.vps || j >= t.vps) return false;
    return t.loose[j * t.vps + i] > 0;
  }

  // is this hit a place the player may work at all? -> "" or the reason
  check(hit, def, player) {
    if (!hit) return "none";
    if (!hit.diggable) return "none";
    if (hit.distance > def.reach) return "far";
    if (player && hit.boulder == null && Math.hypot(hit.x - player.x, hit.z - player.z) < FEET_RADIUS) return "feet";
    return "";
  }

  // efficiency of `def` right at the hit (crosshair state)
  efficiencyAtHit(hit, def) {
    if (hit.boulder != null) return def.rockDamage > 0 ? 1 : 0;
    return toolEfficiency(def, this.materialAtHit(hit), this.looseAtHit(hit));
  }

  _push(r, cls, massUg, mat, x, y, z, key) {
    if (r.findCount >= MAX_FINDS) return;
    const f = r.finds[r.findCount++];
    f.cls = cls; f.massUg = massUg; f.mat = mat; f.x = x; f.y = y; f.z = z; f.key = key;
  }

  /**
   * One action of tool `def` at `hit` - the whole transaction.
   * eye: where the stroke comes from (the camera) - sets its direction.
   * @returns this.result
   */
  action(hit, def, player, eye) {
    const r = this.result;
    r.ok = false; r.blocked = false; r.kind = ""; r.cells = 0; r.chunks = 0; r.rock = null;
    r.requestedVolume = 0; r.removedVolume = 0; r.removedMassKg = 0; r.relocatedVolume = 0; r.processedVolume = 0;
    r.massKg = 0; r.freshKg = 0; r.volumeL = 0; r.massByMat.fill(0); r.slices = 0; r.findCount = 0; r.fineUg = 0;
    r.reason = this.check(hit, def, player);
    if (r.reason) return r;
    r.ok = true;
    r.material = this.materialAtHit(hit);
    // 3. boulders
    if (hit.boulder != null) {
      if (def.rockDamage > 0 && this.rocks) {
        r.kind = "rock";
        r.rock = this.rocks.hit(hit.boulder, def.rockDamage);
        if (r.rock && r.rock.broke) this.rocks.settleIn(hit.x - 1.5, hit.z - 1.5, hit.x + 1.5, hit.z + 1.5);
      } else { r.kind = "blocked"; r.blocked = true; }
      return r;
    }
    // 4. workable at all?
    if (!(toolEfficiency(def, r.material, this.looseAtHit(hit)) > 0)) { r.kind = "blocked"; r.blocked = true; return r; }

    // 5.-9.
    const t = this.terrain, field = this.field, area = t.cell * t.cell, vps = t.vps, C = this.consumed, I = this.cidx;
    const K = this._kernel(hit, def, eye);
    const eff = (k, x, y, z, mat) => toolEfficiency(def, mat, t.loose[k] > 0);
    const onCut = (rec) => {
      for (let n = 0; n < rec.n; n++) {
        const k = rec.k[n], before = rec.before[n], after = rec.after[n], mat = rec.mat[n];
        const i = k % vps, j = (k - i) / vps, x = t.x0 + i * t.cell, z = t.z0 + j * t.cell;
        const dens = MATERIALS[mat].density;
        const vol = (before - after) * area;
        r.removedVolume += vol;
        r.massByMat[mat] += vol * dens;
        const c0 = C[k];
        if (after < c0) {
          r.freshKg += (Math.min(before, c0) - after) * area * dens;
          C[k] = after;
        }
        // finds that slid here earlier and lie in the removed layer
        const list = this.carried.get(k);
        if (list) {
          for (let q = list.length - 1; q >= 0; q--) {
            const it = list[q];
            if (it.y <= after) continue;
            this._push(r, it.cls, it.massUg, mat, x, Math.min(before, it.y), z, it.key);
            list.splice(q, 1);
            this.carriedCount--;
            this.totals.carriedPaid++;
          }
          if (!list.length) this.carried.delete(k);
        }
        // fine gold that slid here earlier: it comes off with this cut
        const cf = this.carriedFine.get(k);
        if (cf && cf.y > after) { r.fineUg += cf.ug; this.carriedFine.delete(k); }
        // slices whose centre the column passes now are used up
        const lo = sliceIndex(after), hi = I[k] - 1;
        if (lo > hi) continue;                                      // only loose, already worked material
        I[k] = lo;
        for (let iy = lo; iy <= hi; iy++) {
          r.slices++;
          const v = field.voxel(i, j, iy, this._vox);
          r.fineUg += v.fineUg;
          this.totals.fineUsedUg += v.fineUg;
          if (v.cls !== FIND.NONE) this._push(r, v.cls, v.massUg, v.mat, x, SLICE_ORIGIN_Y + (iy + 0.5) * VOXEL_H, z, `${i}:${j}:${iy}`);
        }
      }
    };
    const res = t.excavate(hit, K, eff, onCut);
    r.requestedVolume = res ? res.requested : 0;
    if (!res || !res.cells) { r.kind = "blocked"; r.blocked = true; return r; }     // e.g. stone right under a thin skin
    r.kind = "dig";
    this.totals.finePaidUg += r.fineUg;
    r.cells = res.cells;
    r.chunks = res.chunks;
    r.relocatedVolume = res.relocated;
    r.removedMassKg = r.massByMat[0] + r.massByMat[1] + r.massByMat[2] + r.massByMat[3];
    r.massKg = r.removedMassKg;
    r.volumeL = r.removedVolume * 1000;
    r.processedVolume = r.slices * this.sliceVolume;
    // boulders around the bite settle onto the new ground
    if (this.rocks) {
      const m = (def.kernel.settleMargin || 0.8) + Math.max(def.kernel.a, def.kernel.b) + 1.2;
      this.rocks.settleIn(hit.x - m, hit.z - m, hit.x + m, hit.z + m);
    }
    return r;
  }

  // the tool's kernel at this hit: oriented in the surface plane, the
  // stroke running along the view direction
  _kernel(hit, def, eye) {
    const n = this._n, u = this._u, src = hit.normal || { x: 0, y: 1, z: 0 };
    let nl = Math.hypot(src.x, src.y, src.z) || 1;
    n.x = src.x / nl; n.y = src.y / nl; n.z = src.z / nl;
    if (n.y < 0.05) { n.y = 0.05; nl = Math.hypot(n.x, n.y, n.z); n.x /= nl; n.y /= nl; n.z /= nl; }
    let dx = hit.x - (eye ? eye.x : hit.x), dy = hit.y - (eye ? eye.y : hit.y + 1), dz = hit.z - (eye ? eye.z : hit.z - 1);
    const dn = dx * n.x + dy * n.y + dz * n.z;
    dx -= dn * n.x; dy -= dn * n.y; dz -= dn * n.z;
    let ul = Math.hypot(dx, dy, dz);
    if (ul < 1e-4) {                                      // looking straight at the face: any direction in it
      dx = -n.z; dy = 0; dz = n.x; ul = Math.hypot(dx, dz) || 1;
      if (ul < 1e-4) { dx = 1; dz = 0; ul = 1; }
    }
    u.x = dx / ul; u.y = dy / ul; u.z = dz / ul;
    return { ...def.kernel, n, u };
  }

  // settling moved material from column a (height before -> after) onto b
  _relocate(a, b, before, after) {
    const t = this.terrain, I = this.cidx, vps = t.vps;
    const yTo = t.height[b];
    // finds riding in the loose material that went
    const list = this.carried.get(a);
    if (list) {
      for (let q = list.length - 1; q >= 0; q--) {
        if (list[q].y <= after) continue;
        const it = list.splice(q, 1)[0];
        it.y = yTo - 0.002;
        this._carry(b, it);
        this.carriedCount--;
      }
      if (!list.length) this.carried.delete(a);
    }
    // fine gold riding in the loose material that went
    const cf = this.carriedFine.get(a);
    if (cf && cf.y > after) { this.carriedFine.delete(a); this._carryFine(b, cf.ug, yTo - 0.002); }
    if (after < this.consumed[a]) this.consumed[a] = after;
    // unworked slices that slid away are used up here, their finds travel along
    const lo = sliceIndex(after), hi = I[a] - 1;
    if (lo > hi) return;
    I[a] = lo;
    const i = a % vps, j = (a - i) / vps;
    let fine = 0;
    for (let iy = lo; iy <= hi; iy++) {
      this.totals.relocatedSlices++;
      const v = this.field.voxel(i, j, iy, this._vox);
      fine += v.fineUg;
      if (v.cls !== FIND.NONE) this._carry(b, { cls: v.cls, massUg: v.massUg, key: `${i}:${j}:${iy}`, y: yTo - 0.002 - (hi - iy) * VOXEL_H * 0.3 });
    }
    this.totals.fineUsedUg += fine;
    if (fine > 0) this._carryFine(b, fine, yTo - 0.002);
  }

  // one running total per receiving column (it all lies in its loose top)
  _carryFine(k, ug, y) {
    const cf = this.carriedFine.get(k);
    if (cf) { cf.ug += ug; cf.y = Math.max(cf.y, y); } else this.carriedFine.set(k, { ug, y });
  }

  get carriedFineUg() { let u = 0; for (const cf of this.carriedFine.values()) u += cf.ug; return u; }

  _carry(k, it) {
    let list = this.carried.get(k);
    if (!list) { list = []; this.carried.set(k, list); }
    list.push(it);
    this.carriedCount++;
  }

  consumedAt(x, z) {
    const t = this.terrain;
    const i = Math.round((x - t.x0) / t.cell), j = Math.round((z - t.z0) / t.cell);
    if (i < 0 || j < 0 || i >= t.vps || j >= t.vps) return null;
    return this.consumed[j * t.vps + i];
  }

  // Saved per column, as differences to what the terrain save restores
  // (so they are ~0 almost everywhere and cost a few bytes):
  //   slices: used-up slice index vs. the restored surface - exact integers,
  //           so a reload can never hand out a slice twice
  //   level:  worked level below the surface in 0.1 mm (look + statistics)
  //   carried: finds travelling in slid material [column, height (0.1 mm
  //           above the pit floor), class, µg, origin]
  serialize() {
    const t = this.terrain, H = t.height, C = this.consumed, I = this.cidx, n = H.length;
    const qs = new Int16Array(n), ql = new Int32Array(n);
    let changed = 0;
    for (let k = 0; k < n; k++) {
      const hq = t.restoredHeight(k);
      qs[k] = sliceIndex(hq) - I[k];
      ql[k] = Math.max(0, Math.round((H[k] - C[k]) * Q));
      if (qs[k] || ql[k]) changed++;
    }
    const carried = [];
    for (const [k, list] of this.carried) for (const it of list) carried.push([k, Math.round((it.y - SLICE_ORIGIN_Y) * Q), it.cls, it.massUg, it.key]);
    const carriedFine = [];
    for (const [k, cf] of this.carriedFine) carriedFine.push([k, Math.round((cf.y - SLICE_ORIGIN_Y) * Q), cf.ug]);
    return { unit: "slice1cm+0.1mm", encoding: "rle-zigzag-varint-b64", changed, slices: encodeInt16Rle(qs), level: encodeIntRle(ql), carried, carriedFine };
  }

  // call after the terrain got its saved heights; no data (older save) =
  // everything above today's surface counts as worked (no retroactive loot)
  deserialize(d) {
    const H = this.terrain.height, C = this.consumed, I = this.cidx, n = H.length;
    C.set(H);
    this._resetIndex();
    if (!d || d.encoding !== "rle-zigzag-varint-b64" || typeof d.slices !== "string" || typeof d.level !== "string") return false;
    if (d.unit === "slice+mm") {
      // phase 2: 5 cm slices, millimetres. Everything at and above the
      // bottom of the lowest used-up 5 cm slice counts as used up now
      // (never more loot than before), never above today's surface.
      const qs = decodeInt16Rle(d.slices, n), ql = decodeInt16Rle(d.level, n);
      for (let k = 0; k < n; k++) {
        C[k] = Math.min(H[k], H[k] - ql[k] / 1000);
        if (qs[k] <= 0) continue;                            // nothing below today's surface was used up
        const old = Math.ceil((H[k] - SLICE_ORIGIN_Y) / OLD_VOXEL_H - 0.5) - qs[k];
        const yw = SLICE_ORIGIN_Y + old * OLD_VOXEL_H;
        I[k] = Math.min(sliceIndex(yw), sliceIndex(H[k]));
      }
    } else {
      const qs = decodeInt16Rle(d.slices, n), ql = decodeIntRle(d.level, n);
      for (let k = 0; k < n; k++) {
        I[k] -= qs[k];
        C[k] = H[k] - ql[k] / Q;
      }
      if (Array.isArray(d.carried)) {
        for (const e of d.carried) {
          if (!Array.isArray(e) || e.length < 5) continue;
          const [k, yq, cls, massUg, key] = e;
          if (!Number.isInteger(k) || k < 0 || k >= n || !Number.isFinite(yq) || !(cls >= FIND.TRACE && cls <= FIND.NUGGET) || !(massUg > 0)) continue;
          this._carry(k, { cls, massUg: Math.round(massUg), key: String(key), y: SLICE_ORIGIN_Y + yq / Q });
        }
      }
      if (Array.isArray(d.carriedFine)) {
        for (const e of d.carriedFine) {
          if (!Array.isArray(e) || e.length < 3) continue;
          const [k, yq, ug] = e;
          if (!Number.isInteger(k) || k < 0 || k >= n || !Number.isFinite(yq) || !(ug > 0)) continue;
          this._carryFine(k, Math.round(ug), SLICE_ORIGIN_Y + yq / Q);
        }
      }
    }
    this.terrain.refreshAll();
    return true;
  }

  // gold still in reach of the ground in a box (debug / benchmark), µg
  stats() {
    return { carried: this.carriedCount, relocatedSlices: this.totals.relocatedSlices, carriedPaid: this.totals.carriedPaid,
      fineUsedUg: this.totals.fineUsedUg, finePaidUg: this.totals.finePaidUg, carriedFineUg: this.carriedFineUg };
  }
}
