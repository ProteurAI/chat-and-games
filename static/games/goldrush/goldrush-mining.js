// GoldRush - mining. One tool stroke is ONE transaction, in this order:
//
//   1. valid target?           (the mound, inside the dig area, not under your own feet)
//   2. within reach?
//   3. material workable with this tool?   (stone: the hand just bounces off)
//   4. how much actually comes off         (tool bite x material efficiency, per cell)
//   5. deform the terrain                  (+ local collapse, see DiggableTerrain)
//   6. consume the resource                (each 5 cm slice of each column exactly once)
//   7. which finds were in it              (fixed per slice by the world seed)
//
// The caller then shows the finds, credits them (economy) and marks the
// save dirty. There is no second random number anywhere: what a slice holds
// is decided by the seed, whether it was already worked by `consumed`.
//
// Depletion: `cidx[k]` is the lowest slice of column k a tool has worked
// through (an integer - exact, also across save/reload), `consumed[k]` the
// level itself (for the look and the statistics). A slice pays out when a
// stroke takes the column below its centre - once, whatever order or angle
// it is dug from. Material that slides into a hole lies ABOVE the worked
// level and holds nothing (it was already worked or never belonged to this
// column); material that slid away from a column without being worked keeps
// its content for when the tool gets there.

import { MAT, MATERIALS } from "./goldrush-materials.js";
import { FIND, VOXEL_H } from "./goldrush-resources.js";
import { decodeInt16Rle, encodeInt16Rle } from "./goldrush-save.js";
import { FLOOR_Y } from "./goldrush-terrain.js";

const FEET_RADIUS = 0.45;        // m: no digging straight under your own feet
// index of the lowest slice whose centre is at or above height h
const sliceIndex = (h) => Math.ceil((h - FLOOR_Y) / VOXEL_H - 0.5);
const MAX_FINDS = 16;

export class MiningSystem {
  constructor(terrain) {
    this.terrain = terrain;
    this.field = terrain.field;
    this.consumed = new Float32Array(terrain.height.length);
    this.consumed.set(terrain.height);                  // nothing below the surface is worked yet
    this.cidx = new Int16Array(terrain.height.length);
    this._resetIndex();
    terrain.consumed = this.consumed;
    this._vox = {};
    this._eff = null;
    this.result = {
      ok: false, reason: "", material: MAT.DIRT, blocked: false, cells: 0, chunks: 0,
      massKg: 0, freshKg: 0, volumeL: 0, massByMat: [0, 0, 0, 0], slices: 0, finds: [],
    };
    for (let i = 0; i < MAX_FINDS; i++) this.result.finds.push({ cls: 0, massUg: 0, x: 0, y: 0, z: 0, mat: 0, key: "" });
    this.result.findCount = 0;
  }

  _resetIndex() {
    const H = this.terrain.height, I = this.cidx;
    for (let k = 0; k < H.length; k++) I[k] = sliceIndex(H[k]);
  }

  // material at the very surface of a hit (a boulder is always stone)
  materialAtHit(hit) {
    if (hit.boulder != null) return MAT.STONE;
    return this.field.materialAt(hit.x, hit.y - 0.02, hit.z);
  }

  // is this hit a place the player may work at all? -> "" or the reason
  check(hit, tool, player) {
    if (!hit) return "none";
    if (!hit.diggable) return "none";
    if (hit.distance > tool.reach) return "far";
    if (player && Math.hypot(hit.x - player.x, hit.z - player.z) < FEET_RADIUS) return "feet";
    return "";
  }

  // one stroke of `tool` at `hit` - the whole transaction; returns this.result
  stroke(hit, tool, player) {
    const r = this.result;
    r.ok = false; r.blocked = false; r.cells = 0; r.chunks = 0; r.massKg = 0; r.freshKg = 0; r.volumeL = 0;
    r.massByMat.fill(0); r.slices = 0; r.findCount = 0;
    r.reason = this.check(hit, tool, player);
    if (r.reason) return r;
    r.ok = true;
    r.material = this.materialAtHit(hit);
    const def = MATERIALS[r.material];
    if (!(tool.efficiency(def) > 0) || hit.boulder != null) { r.blocked = true; return r; }

    const t = this.terrain, field = this.field, area = t.cell * t.cell;
    const eff = (k, x, y, z) => tool.efficiency(MATERIALS[field.materialAt(x, y - 0.02, z, k)]);
    const onCut = (rec) => {
      const C = this.consumed, I = this.cidx, vps = t.vps;
      for (let n = 0; n < rec.n; n++) {
        const k = rec.k[n], before = rec.before[n], after = rec.after[n];
        const i = k % vps, j = (k - i) / vps, x = t.x0 + i * t.cell, z = t.z0 + j * t.cell;
        const mat = field.materialAt(x, (before + after) * 0.5, z, k);
        const dens = MATERIALS[mat].density;
        const vol = (before - after) * area;
        r.volumeL += vol * 1000;
        r.massKg += vol * dens;
        r.massByMat[mat] += vol * dens;
        const c0 = C[k];
        if (after < c0) {
          r.freshKg += (Math.min(before, c0) - after) * area * dens;
          C[k] = after;
        }
        // slices whose centre the column passes now are worked through
        const lo = sliceIndex(after), hi = I[k] - 1;
        if (lo > hi) continue;                                      // only loose, already worked material
        I[k] = lo;
        for (let iy = lo; iy <= hi; iy++) {
          r.slices++;
          const v = field.voxel(i, j, iy, this._vox);
          if (v.cls !== FIND.NONE && r.findCount < MAX_FINDS) {
            const f = r.finds[r.findCount++];
            f.cls = v.cls; f.massUg = v.massUg; f.mat = v.mat;
            f.x = x; f.y = FLOOR_Y + (iy + 0.5) * VOXEL_H; f.z = z;
            f.key = `${i}:${j}:${iy}`;
          }
        }
      }
    };
    const res = t.excavate(hit.x, hit.z, tool.radius, tool.depth, eff, onCut);
    if (!res || !res.cells) { r.blocked = true; return r; }          // e.g. stone right under a thin skin
    r.cells = res.cells;
    r.chunks = res.chunks;
    return r;
  }

  consumedAt(x, z) {
    const t = this.terrain;
    const i = Math.round((x - t.x0) / t.cell), j = Math.round((z - t.z0) / t.cell);
    if (i < 0 || j < 0 || i >= t.vps || j >= t.vps) return null;
    return this.consumed[j * t.vps + i];
  }

  // Saved per column, both as differences to what the terrain save restores
  // (so they are ~0 almost everywhere and cost a few bytes):
  //   slices: worked slice index vs. the restored surface - exact integers,
  //           so a reload can never hand out a slice twice
  //   level:  worked level below the surface in mm (look + statistics)
  serialize() {
    const t = this.terrain, H = t.height, C = this.consumed, I = this.cidx, n = H.length;
    const qs = new Int16Array(n), ql = new Int16Array(n);
    let changed = 0;
    for (let k = 0; k < n; k++) {
      const hq = t.restoredHeight(k);
      qs[k] = sliceIndex(hq) - I[k];
      const d = Math.round((H[k] - C[k]) * 1000);
      ql[k] = d > 32767 ? 32767 : d < -32767 ? -32767 : d;
      if (qs[k] || ql[k]) changed++;
    }
    return { unit: "slice+mm", encoding: "rle-zigzag-varint-b64", changed, slices: encodeInt16Rle(qs), level: encodeInt16Rle(ql) };
  }

  // call after the terrain got its saved heights; no data (older save) =
  // everything above today's surface counts as worked (no retroactive loot)
  deserialize(d) {
    const H = this.terrain.height, C = this.consumed, I = this.cidx, n = H.length;
    C.set(H);
    this._resetIndex();
    if (!d || d.encoding !== "rle-zigzag-varint-b64" || typeof d.slices !== "string" || typeof d.level !== "string") return false;
    const qs = decodeInt16Rle(d.slices, n), ql = decodeInt16Rle(d.level, n);
    for (let k = 0; k < n; k++) {
      I[k] -= qs[k];
      C[k] = H[k] - ql[k] / 1000;
    }
    this.terrain.refreshAll();
    return true;
  }
}
