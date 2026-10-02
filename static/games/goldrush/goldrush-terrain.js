// GoldRush - the diggable mound.
//
// A deformable HEIGHTFIELD (no voxels, no caves or overhangs in phase 1):
// one height per grid vertex, split into square chunks that are separate
// meshes. Digging changes a few dozen heights and re-uploads only the
// chunks it touched (positions, normals, colours, bounds). Normals come
// from the global height grid, so chunk borders never show seams.
//
// The mound itself is generated from the world seed (overlapping, warped
// lobes + fractal detail + rock outcrops), so the same seed always gives
// the same pile; saves only store what the player changed.

import { fbm2, hash3, mulberry32, noise2, ridged2, smoothstep } from "./goldrush-noise.js";
import { MAT } from "./goldrush-materials.js";
import { MaterialField } from "./goldrush-resources.js";
import { decodeInt16Rle, decodeIntRle, encodeIntRle } from "./goldrush-save.js";

export const FLOOR_Y = -2.5;          // today's open-pit floor (the dig limit) - later phases may lower it
// Origin of the resource-slice index (1 cm slices, goldrush-mining.js /
// goldrush-resources.js). Fixed for good: it decides which slice holds
// which gold, so it must never move - a deeper pit just uses slices below
// it (negative indices). Nothing assumes the original ground (y = 0) or
// FLOOR_Y to be the end of the mine.
export const SLICE_ORIGIN_Y = -2.5;
// Version of the mound generator. Saves store height deltas against the
// generated mound, so they only fit the generator that made it: bump this
// whenever _generate() changes shape (old digs are then dropped, not
// applied to a different mound).
export const TERRAIN_GEN = 1;
const EDGE_KEEP = 1.5;                // metres at the border that stay untouched (seam with the ground)
const TAN = (deg) => Math.tan((deg * Math.PI) / 180);
const SETTLE_SLOPE = TAN(50);         // generation: only noise spikes of the untouched pile are capped
// Heights are kept as "original mound + whole 0.1 mm" (an integer per
// column): even a single hand scrape (a few tenths of a millimetre at its
// edge) is stored exactly, every slide moves exact amounts (mass is kept),
// and a save restores the very same numbers.
export const HEIGHT_Q = 10000;
// Slopes after a bite (as tan): the untouched crust of the pile holds a cut
// face this steep; anything disturbed (dug, slid, loosened) settles to its
// material's angle of repose - but never flatter than the pile itself was
// there, so a cut at the toe of a steep flank can't start a slide that runs
// up the whole mound. Stone never moves.
const CRUST = TAN(62);
const REPOSE = [TAN(40), TAN(50), TAN(37), Infinity];      // by MAT: loose dirt, compact, gravel, stone
const SETTLE_ITER = 16;

// a dumped pile: broad rounded crest, flanks near the angle of repose, a
// softly spreading toe - never steepest at the bottom and never a pointed
// cone tip (t: 0 centre .. 1 edge)
const PILE_A = 0.42, PILE_TOP = Math.sqrt(1 + PILE_A * PILE_A);
function pileProfile(t) {
  const cone = Math.max(0, (PILE_TOP - Math.sqrt(t * t + PILE_A * PILE_A)) / (PILE_TOP - PILE_A));
  const bell = Math.pow(Math.max(0, 1 - Math.pow(t, 2.2)), 1.9);
  return 0.65 * cone + 0.35 * bell;
}
const CHANGED_EPS = 0.004;

// palette (sRGB hex, converted to linear once)
const PALETTE = {
  dustA: 0x9a7650, dustB: 0x7e5e3f, dustC: 0xae8b5f, slope: 0x9c6d4b,
  fresh: 0x7a5334, freshB: 0x694630, clay: 0x96603a, gravel: 0x857a6b,
  stone: 0x8e8272, stoneDark: 0x61574c, ground: 0xb59f7d, band: 0x8f5a38,
  moist: 0x5e4129, spill: 0x9a7f5d,
  // per material: weathered surface / fresh cut
  compactS: 0x7c5436, compactF: 0x684129, gravelS: 0x8a7f71, gravelL: 0xab9d88, gravelD: 0x5d544a, gravelF: 0x776b5d,
  stoneS: 0x8d857a, stoneD: 0x5f5850, fill: 0x93714f, stoneCut: 0xb1a899,
};
const REC_MAX = 256;                                  // cells one stroke can touch (radius <= 0.9 m)

export class DiggableTerrain {
  /**
   * @param THREE three.js namespace
   * @param opts { seed, center:{x,z}, size, cell, chunkCells, moundCenter:{x,z}, material }
   */
  constructor(THREE, opts) {
    this.THREE = THREE;
    this.seed = opts.seed | 0;
    this.cell = opts.cell || 0.125;
    this.cols = Math.round((opts.size || 30) / this.cell);
    this.chunkCells = opts.chunkCells || 30;
    if (this.cols % this.chunkCells) throw new Error("terrain size must be a multiple of the chunk size");
    this.chunksPerSide = this.cols / this.chunkCells;
    this.vps = this.cols + 1;
    this.size = this.cols * this.cell;
    this.center = opts.center;
    this.x0 = opts.center.x - this.size / 2;
    this.z0 = opts.center.z - this.size / 2;
    this.moundCenter = opts.moundCenter || opts.center;
    this.edgeCells = Math.ceil(EDGE_KEEP / this.cell);
    const n = this.vps * this.vps;
    this.base = new Float32Array(n);
    this.height = new Float32Array(n);
    this.qh = new Int32Array(n);                     // height - base, in 0.1 mm (the stored truth)
    this.loose = new Uint8Array(n);                  // loosened depth below the surface, cm (pickaxe)
    this.freshAt = new Float32Array(n).fill(-1e5);  // when the column was last cut / moved (game clock, s) - looks fresh
    this.clock = 0;                                  // game clock, set by the engine every frame
    this.rock = new Float32Array(n);
    this.rill = new Float32Array(n);
    this.spawn = opts.spawn || null;
    this._generate();
    this.height.set(this.base);
    this.baseTan = new Float32Array(n);              // steepest slope of the original pile per column (all 8 neighbours)
    this._lim = new Float32Array(n);                 // settle scratch
    this._tb = { i0: 0, i1: 0, j0: 0, j1: 0 };       // where the last settle pass moved material
    this._win = { i0: 0, i1: 0, j0: 0, j1: 0 };      // the window it finally covered
    const B = this.base, V = this.vps, d1 = this.cell, d2 = this.cell * Math.SQRT2;
    for (let j = 1; j < V - 1; j++) for (let i = 1; i < V - 1; i++) {
      const k = j * V + i, b = B[k];
      this.baseTan[k] = Math.max(
        Math.abs(b - B[k - 1]) / d1, Math.abs(b - B[k + 1]) / d1, Math.abs(b - B[k - V]) / d1, Math.abs(b - B[k + V]) / d1,
        Math.abs(b - B[k - V - 1]) / d2, Math.abs(b - B[k - V + 1]) / d2, Math.abs(b - B[k + V - 1]) / d2, Math.abs(b - B[k + V + 1]) / d2);
    }
    this.onRelocate = null;                          // (from, to, before, after) - set by the mining system
    this.field = new MaterialField(this.seed, this, SLICE_ORIGIN_Y);
    this.stoneTop = this.field.stoneTop;             // uppermost stone body per column
    this.stoneBot = this.field.stoneBot;
    this.consumed = null;                            // set by the mining system (worked-over depth per column)
    // what the last excavate() did per cell (the mining system books it)
    this.rec = { n: 0, k: new Int32Array(REC_MAX), before: new Float32Array(REC_MAX), after: new Float32Array(REC_MAX), mat: new Uint8Array(REC_MAX) };
    this._bite = { n: 0, k: new Int32Array(REC_MAX), w: new Float32Array(REC_MAX) };
    this.load = new Uint8Array(n);                   // columns a boulder rests on (no crust: they give way)
    this.heatmap = false;
    this.stride = 1;
    this.revision = 0;
    this.pal = {};
    for (const [k, hex] of Object.entries(PALETTE)) {
      const c = new THREE.Color(hex);           // sRGB -> linear working space
      this.pal[k] = [c.r, c.g, c.b];
    }
    this.material = opts.material;
    this.group = new THREE.Group();
    this.group.name = "goldrush-terrain";
    this._sample = {};
    this._buildChunks();
  }

  // ------------------------------------------------------------ generation

  _generate() {
    const rng = mulberry32(this.seed);
    const { x: mx, z: mz } = this.moundCenter;
    // two dumps side by side (across the view from the claim entrance): a
    // tall main crest and a lower shoulder, so the pile never reads as a
    // lone cone
    const side = rng() < 0.5 ? -1 : 1;
    const main = { x: mx - side * (2.2 + rng() * 0.6), z: mz + (rng() - 0.5) * 1.2, r: 9.6 + rng() * 0.8, h: 6.1 + rng() * 0.6, sx: 1.1, sz: 0.95, rot: (rng() - 0.5) * 0.5 };
    const lobes = [main, { x: main.x + side * (6.2 + rng() * 0.6), z: mz + (rng() - 0.5) * 2, r: 6.8 + rng() * 0.5, h: 4.2 + rng() * 0.5, sx: 1.1, sz: 0.9, rot: (rng() - 0.5) * 0.6 }];
    const count = 4 + Math.floor(rng() * 2);
    const sa = rng() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const a = sa + ((i + 0.5) / count) * Math.PI * 2 + rng() * 0.8;
      const d = 3.2 + rng() * 2.2;
      lobes.push({
        x: mx + Math.cos(a) * d, z: mz + Math.sin(a) * d,
        r: 4.2 + rng() * 2.0, h: 1.8 + rng() * 1.6,
        sx: 0.75 + rng() * 0.6, sz: 0.75 + rng() * 0.6, rot: rng() * Math.PI,
      });
    }
    const outcrops = [];
    for (let i = 0; i < 5; i++) {
      const a = rng() * Math.PI * 2, d = 2.2 + rng() * 5.2;
      outcrops.push({ x: mx + Math.cos(a) * d, z: mz + Math.sin(a) * d, r: 1.0 + rng() * 1.5, h: 0.3 + rng() * 0.55 });
    }
    this.lobes = lobes;
    const s = this.seed, c = this.cell, vps = this.vps;
    for (let j = 0; j < vps; j++) {
      const z = this.z0 + j * c;
      for (let i = 0; i < vps; i++) {
        const x = this.x0 + i * c;
        // lobes: the tallest one plus a share of every other (continuous merge)
        let top = 0, sum = 0;
        for (const L of lobes) {
          const dx = x - L.x, dz = z - L.z;
          const cr = Math.cos(L.rot), sr = Math.sin(L.rot);
          const u = (dx * cr - dz * sr) / L.sx, v = (dx * sr + dz * cr) / L.sz;
          const warp = 1 + 0.1 * noise2(x * 0.23 + L.x, z * 0.23 + L.z, s + 17);
          const t = Math.sqrt(u * u + v * v) / (L.r * warp);
          if (t < 1) {
            const hv = L.h * pileProfile(t);
            sum += hv;
            if (hv > top) top = hv;
          }
        }
        let h = top + 0.25 * (sum - top);
        const body = smoothstep(0, 1.4, h);
        h += body * (0.55 * fbm2(x * 0.21, z * 0.21, s + 31, 4) + 0.12 * fbm2(x * 0.95, z * 0.95, s + 47, 3));
        // rain rills: shallow channels running straight down the flanks
        const dx0 = x - mx, dz0 = z - mz, rad = Math.hypot(dx0, dz0);
        const ang = Math.atan2(dz0, dx0);
        const rill = ridged2(ang * 5 + fbm2(x * 0.15, z * 0.15, s + 57, 2) * 1.5, rad * 0.35 + fbm2(x * 0.3, z * 0.3, s + 61, 2) * 0.6, s + 67, 2);
        const rillMask = smoothstep(0.6, 1, rill) * smoothstep(1.5, 5, h) * smoothstep(-0.15, 0.35, noise2(x * 0.18, z * 0.18, s + 69));
        h -= body * rillMask * 0.1;
        // clods and lumps: loose, dumped material
        h += body * 0.05 * noise2(x * 2.6, z * 2.6, s + 71) + body * 0.02 * noise2(x * 4.1, z * 4.1, s + 73);
        // rock outcrops: ridged, sharper bumps on the flanks
        let rock = 0, bump = 0;
        const ridge = ridged2(x * 0.75, z * 0.75, s + 59);
        for (const o of outcrops) {
          const d = Math.hypot(x - o.x, z - o.z) / o.r;
          if (d < 1) {
            const m = (1 - d * d) * smoothstep(0.3, 0.75, ridge);
            rock = Math.max(rock, m);
            bump += o.h * m;
          }
        }
        h += bump * body;
        // hard-packed ground around the pile: tiny relief only
        h += (1 - body) * 0.05 * fbm2(x * 0.5, z * 0.5, s + 83, 2);
        // border fades to exactly 0 = the level of the surrounding ground plane
        const e = Math.min(i, vps - 1 - i, j, vps - 1 - j) * c;
        h *= smoothstep(0.35, 3.2, e);
        const k = j * vps + i;
        this.base[k] = h;
        this.rock[k] = Math.min(1, rock * body * 1.3);
        this.rill[k] = rillMask * body;
      }
    }
    this._settle();
  }

  // Let the generated pile settle: over-steep bumps are first smoothed
  // locally (rounded, no facets), then a hard cap below the dig wall limit
  // catches the rest - so the untouched mound never collapses on its own,
  // only what the player undercuts comes down.
  _settle() {
    const B = this.base, vps = this.vps, last = vps - 1;
    const soft = this.cell * Math.tan((46 * Math.PI) / 180);
    const prev = new Float32Array(B.length);
    for (let pass = 0; pass < 10; pass++) {
      prev.set(B);
      let moved = 0;
      for (let j = 1; j < last; j++) {
        for (let i = 1; i < last; i++) {
          const k = j * vps + i, h = prev[k];
          const l = prev[k - 1], r = prev[k + 1], d = prev[k - vps], u = prev[k + vps];
          if (Math.max(Math.abs(h - l), Math.abs(h - r), Math.abs(h - d), Math.abs(h - u)) > soft) {
            B[k] = h + ((l + r + d + u) * 0.25 - h) * 0.5;
            moved++;
          }
        }
      }
      if (!moved) break;
    }
    for (let r = 0; r < 3; r++) if (this._clampRange(B, 1, last - 1, 1, last - 1, this.cell * SETTLE_SLOPE) < 1e-6) break;
  }

  // Slope limit "from below": no cell may stand higher than a neighbour
  // plus maxDiff (x sqrt2 diagonally). A forward and a backward chamfer
  // sweep over 8 neighbours give the exact result for a window in one or
  // two rounds, however tall the wall (an iterative pairwise exchange would
  // need hundreds of passes to move material across a few metres).
  // Returns the volume (in height units) that came down.
  _clampRange(H, i0, i1, j0, j1, maxDiff) {
    const vps = this.vps, dd = maxDiff * Math.SQRT2;
    let removed = 0;
    const box = (this._box = { i0: Infinity, i1: -Infinity, j0: Infinity, j1: -Infinity });
    const mark = (i, j) => { if (i < box.i0) box.i0 = i; if (i > box.i1) box.i1 = i; if (j < box.j0) box.j0 = j; if (j > box.j1) box.j1 = j; };
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * vps + i;
        let m = H[k];
        if (i > i0 && H[k - 1] + maxDiff < m) m = H[k - 1] + maxDiff;
        if (j > j0) {
          const u = k - vps;
          if (H[u] + maxDiff < m) m = H[u] + maxDiff;
          if (i > i0 && H[u - 1] + dd < m) m = H[u - 1] + dd;
          if (i < i1 && H[u + 1] + dd < m) m = H[u + 1] + dd;
        }
        if (m < H[k] - 1e-7 && (m = this._stoneLimit(k, m)) < H[k] - 1e-7) { removed += H[k] - m; H[k] = m; mark(i, j); }
      }
    }
    for (let j = j1; j >= j0; j--) {
      for (let i = i1; i >= i0; i--) {
        const k = j * vps + i;
        let m = H[k];
        if (i < i1 && H[k + 1] + maxDiff < m) m = H[k + 1] + maxDiff;
        if (j < j1) {
          const d = k + vps;
          if (H[d] + maxDiff < m) m = H[d] + maxDiff;
          if (i < i1 && H[d + 1] + dd < m) m = H[d + 1] + dd;
          if (i > i0 && H[d - 1] + dd < m) m = H[d - 1] + dd;
        }
        if (m < H[k] - 1e-7 && (m = this._stoneLimit(k, m)) < H[k] - 1e-7) { removed += H[k] - m; H[k] = m; mark(i, j); }
      }
    }
    return removed;
  }

  // Lowest height column k may reach from its current height: a surface
  // inside a stone body is rigid, one above it stops on the stone's top.
  // (During generation there is no stone data yet.)
  _stoneLimit(k, target) {
    const top = this.stoneTop;
    if (!top) return target;
    const h = this.height[k];
    if (h <= top[k] + 1e-4 && h >= this.stoneBot[k]) return h;
    return h > top[k] && target < top[k] ? top[k] : target;
  }

  // ------------------------------------------------------------ meshes

  _index(vpc, step) {
    const idx = [];
    for (let j = 0; j + step < vpc; j += step) {
      for (let i = 0; i + step < vpc; i += step) {
        const a = j * vpc + i, b = (j + step) * vpc + i, cc = j * vpc + i + step, d = (j + step) * vpc + i + step;
        idx.push(a, b, cc, cc, b, d);
      }
    }
    return new this.THREE.BufferAttribute(new Uint32Array(idx), 1);
  }

  _buildChunks() {
    const THREE = this.THREE, cc = this.chunkCells, vpc = cc + 1;
    this.indexFull = this._index(vpc, 1);
    this.indexHalf = this._index(vpc, 2);
    this.chunks = [];
    for (let cz = 0; cz < this.chunksPerSide; cz++) {
      for (let cx = 0; cx < this.chunksPerSide; cx++) {
        const n = vpc * vpc;
        const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3), uv = new Float32Array(n * 2);
        const matw = new Float32Array(n * 2);          // (gravel, stone) weight -> detail textures
        const fresh = new Float32Array(n).fill(-1e5);  // when the ground here was last dug (fades in the shader)
        const i0 = cx * cc, j0 = cz * cc;
        for (let j = 0; j < vpc; j++) {
          for (let i = 0; i < vpc; i++) {
            const v = j * vpc + i, x = this.x0 + (i0 + i) * this.cell, z = this.z0 + (j0 + j) * this.cell;
            pos[v * 3] = x;
            pos[v * 3 + 2] = z;
            uv[v * 2] = x * 0.5;
            uv[v * 2 + 1] = z * 0.5;
          }
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        geom.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
        geom.setAttribute("color", new THREE.BufferAttribute(col, 3));
        geom.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
        geom.setAttribute("aMat", new THREE.BufferAttribute(matw, 2));
        geom.setAttribute("aFresh", new THREE.BufferAttribute(fresh, 1));
        geom.setIndex(this.stride === 2 ? this.indexHalf : this.indexFull);
        const mesh = new THREE.Mesh(geom, this.material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = `terrain-chunk-${cx}-${cz}`;
        const chunk = { cx, cz, i0, j0, mesh, geom };
        this.chunks.push(chunk);
        this.group.add(mesh);
        this._refreshChunk(chunk, i0, i0 + cc, j0, j0 + cc);
      }
    }
  }

  // re-derive y / normal / colour for the given GLOBAL vertex range of one chunk
  _refreshChunk(chunk, gi0, gi1, gj0, gj1) {
    const cc = this.chunkCells, vpc = cc + 1, vps = this.vps, c = this.cell, H = this.height;
    const i0 = Math.max(gi0, chunk.i0), i1 = Math.min(gi1, chunk.i0 + cc);
    const j0 = Math.max(gj0, chunk.j0), j1 = Math.min(gj1, chunk.j0 + cc);
    if (i0 > i1 || j0 > j1) return false;
    const pos = chunk.geom.attributes.position.array, nor = chunk.geom.attributes.normal.array, col = chunk.geom.attributes.color.array;
    const matw = chunk.geom.attributes.aMat.array, fresh = chunk.geom.attributes.aFresh.array;
    const last = vps - 1;
    const rgb = [0, 0, 0];
    for (let gj = j0; gj <= j1; gj++) {
      for (let gi = i0; gi <= i1; gi++) {
        const k = gj * vps + gi;
        const v = (gj - chunk.j0) * vpc + (gi - chunk.i0);
        const h = H[k];
        pos[v * 3 + 1] = h;
        const hl = H[gj * vps + (gi > 0 ? gi - 1 : gi)], hr = H[gj * vps + (gi < last ? gi + 1 : gi)];
        const hd = H[(gj > 0 ? gj - 1 : gj) * vps + gi], hu = H[(gj < last ? gj + 1 : gj) * vps + gi];
        const nx = (hl - hr) / (2 * c), nz = (hd - hu) / (2 * c);
        const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
        nor[v * 3] = nx * inv;
        nor[v * 3 + 1] = inv;
        nor[v * 3 + 2] = nz * inv;
        const curv = (hl + hr + hd + hu - 4 * h) / (c * c);   // >0 concave, <0 ridge
        const x = this.x0 + gi * c, z = this.z0 + gj * c;
        // what shows at the surface: stone only where it really is exposed
        // (a lens a few cm under the soil stays hidden until dug free)
        const mat = this.field.materialAt(x, h - 0.006, z, k);
        this._colorAt(k, x, z, h, inv, curv, mat, rgb);
        col[v * 3] = rgb[0];
        col[v * 3 + 1] = rgb[1];
        col[v * 3 + 2] = rgb[2];
        matw[v * 2] = mat === MAT.GRAVEL ? 1 : 0;
        matw[v * 2 + 1] = mat === MAT.STONE ? 1 : 0;
        fresh[v] = this.freshAt[k];
      }
    }
    chunk.geom.attributes.position.needsUpdate = true;
    chunk.geom.attributes.normal.needsUpdate = true;
    chunk.geom.attributes.color.needsUpdate = true;
    chunk.geom.attributes.aMat.needsUpdate = true;
    chunk.geom.attributes.aFresh.needsUpdate = true;
    chunk.geom.computeBoundingSphere();
    return true;
  }

  _colorAt(k, x, z, h, ny, curv, mat, out) {
    const P = this.pal, s = this.seed;
    const mix = (a, b, t) => { out[0] = a[0] + (b[0] - a[0]) * t; out[1] = a[1] + (b[1] - a[1]) * t; out[2] = a[2] + (b[2] - a[2]) * t; };
    const blend = (b, t) => { out[0] += (b[0] - out[0]) * t; out[1] += (b[1] - out[1]) * t; out[2] += (b[2] - out[2]) * t; };
    if (this.heatmap) { this._heatColor(k, x, z, h, mat, out); return; }
    const dug = this.base[k] - h;
    const n1 = noise2(x * 0.33, z * 0.33, s + 101) * 0.5 + 0.5;
    const n2 = noise2(x * 2.1, z * 2.1, s + 131);
    const grain = hash3(Math.round(x * 8), 7, Math.round(z * 8), s + 191);     // per-vertex pebble speckle
    const cut = smoothstep(CHANGED_EPS, 0.09, dug);
    if (cut >= 1) {
      // a fresh cut shows the material itself, still moist
      if (mat === MAT.STONE) mix(P.stoneS, P.stoneD, 0.35 + n1 * 0.4);
      else if (mat === MAT.GRAVEL) mix(P.gravelF, grain > 0.5 ? P.gravelL : P.gravelD, Math.abs(grain - 0.5) * 1.3);
      else if (mat === MAT.COMPACT) { mix(P.compactF, P.clay, smoothstep(0.35, 1.9, dug) * 0.6 * n1); }
      else { mix(P.fresh, P.freshB, n1); blend(P.clay, smoothstep(0.35, 1.9, dug) * 0.5); }
      if (mat === MAT.STONE && this.field.stoneTop0[k] - this.field.stoneTop[k] > 0.004) blend(P.stoneCut, 0.6);   // freshly broken stone
      else if (this.loose[k] > 2) blend(P.freshB, 0.22);                                                          // loosened, crumbly
    } else {
      mix(P.dustA, P.dustB, n1);
      blend(P.band, smoothstep(-0.1, 0.7, noise2(x * 0.11 + h * 0.3, z * 0.11, s + 171)) * 0.4);   // loads of redder soil
      blend(P.dustC, Math.max(0, noise2(x * 0.9, z * 0.9, s + 151)) * 0.5);        // sun-dried crust patches
      const slope = 1 - ny;
      blend(P.slope, smoothstep(0.2, 0.55, slope) * 0.5);
      blend(P.dustC, this.rill[k] * 0.3);                                            // rills: dry, lighter
      blend(P.moist, smoothstep(1.8, 0.2, h) * smoothstep(0.02, 0.25, h) * 0.45);  // the toe stays moist and dark
      const specks = noise2(x * 3.7, z * 3.7, s + 161);
      if (specks > 0.62) blend(P.stone, (specks - 0.62) * 1.4);                      // scattered pebbles
      // what the pile is made of shows through the dust
      if (mat === MAT.GRAVEL) { blend(P.gravelS, 0.65); blend(grain > 0.5 ? P.gravelL : P.gravelD, Math.abs(grain - 0.5) * 0.9); }
      else if (mat === MAT.COMPACT) blend(P.compactS, 0.42);
      else if (mat === MAT.STONE) blend(n2 > 0.1 ? P.stoneS : P.stoneD, 0.88 * (0.8 + 0.2 * noise2(x * 6.3, z * 6.3, s + 181)));
      else if (this.rock[k] > 0.05) blend(P.stone, Math.min(0.5, this.rock[k]));   // stony, weathered ground
      blend(P.spill, 1 - smoothstep(0.02, 0.22, h));                                // spilled material around the pile
      blend(P.ground, smoothstep(0.02, 0, h) * 0.7);
      if (cut > 0) blend(P.fresh, cut);                                            // shallow slides / scraped rims
    }
    // worked-over loose fill (slid into a hole): lighter and mixed
    const C = this.consumed;
    if (C && h - C[k] > 0.01) blend(P.fill, smoothstep(0.01, 0.06, h - C[k]) * 0.55);
    // cavities darker, crests lighter; fine grain (pits stay readable)
    const shade = Math.min(1.1, Math.max(0.84, 1 - curv * 0.035)) * (1 + n2 * 0.05);
    out[0] *= shade; out[1] *= shade; out[2] *= shade;
  }

  // debug heatmap: gold density of the ground at the surface, in bands
  _heatColor(k, x, z, h, mat, out) {
    const y = h - 0.03;
    const g = mat === MAT.STONE ? -1 : this.field.goldDensityAt(x, y, z, mat, this.base[k] - y);
    const bands = [[0.04, 0.05, 0.14], [0.05, 0.32, 0.1], [0.62, 0.52, 0.04], [0.95, 0.3, 0.03]];
    if (g < 0) { out[0] = out[1] = out[2] = 0.035; }
    else {
      const t = g < 0.08 ? g / 0.08 * 0.3 : g < 0.2 ? 1 + (g - 0.08) / 0.12 * 0.3 : g < 0.45 ? 2 + (g - 0.2) / 0.25 * 0.3 : 3;
      const b = bands[Math.floor(t)], f = t - Math.floor(t);
      out[0] = b[0] * (1 + f); out[1] = b[1] * (1 + f); out[2] = b[2] * (1 + f);
    }
    const C = this.consumed;
    if (C && h - C[k] > 0.01) { out[0] *= 0.45; out[1] *= 0.45; out[2] *= 0.45; }    // worked-over fill: nothing left
  }


  _refresh(gi0, gi1, gj0, gj1) {
    const cc = this.chunkCells;
    let touched = 0;
    for (const ch of this.chunks) {
      if (gi1 < ch.i0 || gi0 > ch.i0 + cc || gj1 < ch.j0 || gj0 > ch.j0 + cc) continue;
      if (this._refreshChunk(ch, gi0, gi1, gj0, gj1)) touched++;
    }
    return touched;
  }

  refreshAll() {
    this._refresh(0, this.vps - 1, 0, this.vps - 1);
  }

  // ------------------------------------------------------------ queries

  _heightFrom(arr, x, z) {
    const fx = (x - this.x0) / this.cell, fz = (z - this.z0) / this.cell;
    if (fx < 0 || fz < 0 || fx > this.cols || fz > this.cols) return 0;   // the flat ground around
    const i = Math.min(this.cols - 1, Math.floor(fx)), j = Math.min(this.cols - 1, Math.floor(fz));
    const tx = fx - i, tz = fz - j, vps = this.vps, k = j * vps + i;
    const a = arr[k], b = arr[k + 1], c = arr[k + vps], d = arr[k + vps + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }

  getHeightAt(x, z) { return this._heightFrom(this.height, x, z); }
  getBaseHeightAt(x, z) { return this._heightFrom(this.base, x, z); }

  getRockMaskAt(x, z) {
    const i = Math.round((x - this.x0) / this.cell), j = Math.round((z - this.z0) / this.cell);
    if (i < 0 || j < 0 || i > this.cols || j > this.cols) return 0;
    return this.rock[j * this.vps + i];
  }

  getNormalAt(x, z, out = { x: 0, y: 1, z: 0 }) {
    const e = this.cell;
    const nx = (this.getHeightAt(x - e, z) - this.getHeightAt(x + e, z)) / (2 * e);
    const nz = (this.getHeightAt(x, z - e) - this.getHeightAt(x, z + e)) / (2 * e);
    const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
    out.x = nx * inv; out.y = inv; out.z = nz * inv;
    return out;
  }

  inDigArea(x, z) {
    const m = this.edgeCells * this.cell;
    return x > this.x0 + m && x < this.x0 + this.size - m && z > this.z0 + m && z < this.z0 + this.size - m;
  }

  // march along the ray, then bisect: the surface point within maxDist or null
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    const step = this.cell * 0.5;
    let prevT = 0;
    if (oy - this.getHeightAt(ox, oz) <= 0) return null;
    for (let t = step; t <= maxDist + step * 0.5; t += step) {
      const tt = Math.min(t, maxDist);
      const f = oy + dy * tt - this.getHeightAt(ox + dx * tt, oz + dz * tt);
      if (f <= 0) {
        let a = prevT, b = tt;
        for (let it = 0; it < 12; it++) {
          const m = (a + b) * 0.5;
          if (oy + dy * m - this.getHeightAt(ox + dx * m, oz + dz * m) > 0) a = m; else b = m;
        }
        const x = ox + dx * b, y = oy + dy * b, z = oz + dz * b;
        return { x, y, z, distance: b, normal: this.getNormalAt(x, z), diggable: this.inDigArea(x, z) };
      }
      prevT = tt;
      if (tt >= maxDist) break;
    }
    return null;
  }

  // ------------------------------------------------------------ digging

  // set column k to an integer height (0.1 mm above/below the original pile)
  _setQ(k, q) {
    this.qh[k] = q;
    this.height[k] = Math.fround(this.base[k] + q / HEIGHT_Q);
  }

  // lowest integer height column k may take (floor of the pit)
  _qMin(k) { return Math.ceil((FLOOR_Y - this.base[k]) * HEIGHT_Q); }

  /**
   * One tool action. Removes a thin layer from the surface around the hit,
   * shaped by the tool's kernel in the surface's OWN plane: on a flat spot
   * it scrapes down, on a steep face it takes the face back (a heightfield
   * can only lower, so a face is recessed by lowering each column by
   * depth / cos(slope) - never a round hole bored straight down).
   *   K = { a, b: half length (along the stroke) / half width,
   *         vol: volume of a full bite (m3), tMax: deepest cut (m),
   *         edge: flat part of the profile, tilt: deeper at the leading
   *         edge (scoop), n: surface normal, u: stroke direction in the
   *         plane, cutsStone, loosenCm, loosenR, settleMargin }
   *   eff(k, x, y, z, material) -> share of the full bite in that cell
   * The bite is normalised to K.vol over the cells it covers (a small
   * kernel on the 12.5 cm grid would otherwise take 1 or 4 cells by
   * chance), so a stroke moves a steady amount: the visible dent and the
   * moved mass come from the same exact integer heights (0.1 mm).
   * Every changed cell lands in this.rec (before/after the bite, before any
   * settling) for the mining system; onCut(rec) runs right after the bite.
   * @returns { requested, removed, relocated (m3), cells, chunks } or null
   */
  excavate(hit, K, eff, onCut) {
    const rec = this.rec;
    rec.n = 0;
    if (!this.inDigArea(hit.x, hit.z)) return null;
    const c = this.cell, vps = this.vps, H = this.height, field = this.field, area = c * c;
    const nx = K.n.x, ny = K.n.y, nz = K.n.z, ux = K.u.x, uy = K.u.y, uz = K.u.z;
    const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
    const R = Math.max(K.a, K.b), cosn = Math.max(0.3, ny);
    const ci = (hit.x - this.x0) / c, cj = (hit.z - this.z0) / c, rr = Math.ceil(R / c) + 1;
    const lo = this.edgeCells, hi = vps - 1 - this.edgeCells;
    const i0 = Math.max(lo, Math.floor(ci - rr)), i1 = Math.min(hi, Math.ceil(ci + rr));
    const j0 = Math.max(lo, Math.floor(cj - rr)), j1 = Math.min(hi, Math.ceil(cj + rr));
    // pass 1: the cells under the kernel and their weights
    const S = this._bite;
    S.n = 0;
    let wsum = 0, near = -1, nearD = Infinity;
    for (let j = j0; j <= j1; j++) {
      const cz = this.z0 + j * c, pz = cz - hit.z;
      for (let i = i0; i <= i1; i++) {
        const cx = this.x0 + i * c, px = cx - hit.x, k = j * vps + i, py = H[k] - hit.y;
        const dn = px * nx + py * ny + pz * nz;
        if (dn > R * 0.6 || dn < -R) continue;              // not this face (the far side of a ridge, the bottom of a pit)
        const du = (px * ux + py * uy + pz * uz) / K.a, dv = (px * vx + py * vy + pz * vz) / K.b;
        const rho2 = du * du + dv * dv;
        if (rho2 >= 1.6 || S.n >= REC_MAX) continue;
        const rho = Math.sqrt(rho2);
        let w = rho >= 1 ? 0 : rho <= K.edge ? 1 : smoothstep(1, K.edge, rho);
        if (K.tilt) w *= Math.max(0, 1 + K.tilt * du);
        if (rho2 < nearD) { nearD = rho2; near = S.n; }
        S.k[S.n] = k; S.w[S.n] = w; S.n++;
      }
    }
    if (near >= 0 && S.w[near] < 0.5) S.w[near] = 0.5;      // the grid point under the hit always takes part
    for (let s = 0; s < S.n; s++) wsum += S.w[s];
    if (!(wsum > 0)) return { requested: 0, removed: 0, relocated: 0, cells: 0, chunks: 0 };
    const t = Math.min(K.tMax || 0.05, (K.vol * cosn) / (wsum * area));    // depth along the normal at the centre
    // pass 2: cut
    let requested = 0, removedQ = 0, cells = 0;
    for (let s = 0; s < S.n; s++) {
      const w = S.w[s];
      if (!(w > 0)) continue;
      const k = S.k[s], i = k % vps, j = (k - i) / vps, cx = this.x0 + i * c, cz = this.z0 + j * c, old = H[k];
      const want = (t * w) / cosn;                          // lowering that recesses the surface by t along its normal
      const inStone = old <= this.stoneTop[k] + 1e-4 && old >= this.stoneBot[k];
      const mat = inStone ? MAT.STONE : field.materialAt(cx, old - 0.01, cz, k);
      const f = eff(k, cx, old, cz, mat);
      requested += want;
      if (!(f > 0) || (inStone && !K.cutsStone)) continue;
      let target = old - want * f;
      if (!inStone) target = this._stoneLimit(k, target);  // a bite in soil stops on stone below
      const q = Math.max(this._qMin(k), Math.ceil((target - this.base[k]) * HEIGHT_Q));
      if (q >= this.qh[k] || rec.n >= REC_MAX) continue;
      removedQ += this.qh[k] - q;
      this._setQ(k, q);
      this.freshAt[k] = this.clock;
      if (inStone) field.cutStone(k, H[k]);
      // loosening (pickaxe) / using it up (any removal)
      const cm = Math.round((old - H[k]) * 100);
      let l = Math.max(0, this.loose[k] - cm);
      if (K.loosenCm && mat !== MAT.STONE) l = Math.min(30, l + Math.round(K.loosenCm * w));
      this.loose[k] = l;
      rec.k[rec.n] = k; rec.before[rec.n] = old; rec.after[rec.n] = H[k]; rec.mat[rec.n] = mat; rec.n++;
      cells++;
    }
    // loosening also reaches cells the pick hardly removes from
    if (K.loosenCm) this._loosen(hit, K, i0, i1, j0, j1);
    if (!cells) return { requested: requested * area, removed: 0, relocated: 0, cells: 0, chunks: 0 };
    if (onCut) onCut(rec);
    // the rim of a cut is scuffed too (crumbs, broken crust): it looks fresh as well
    const F = this.freshAt, now = this.clock;
    for (let r = 0; r < rec.n; r++) {
      const k = rec.k[r];
      F[k - vps - 1] = F[k - vps] = F[k - vps + 1] = F[k - 1] = F[k + 1] = F[k + vps - 1] = F[k + vps] = F[k + vps + 1] = now;
    }
    const m = Math.ceil((K.settleMargin || 0.8) / c);
    const movedQ = this._settleLocal(Math.max(lo, i0 - m), Math.min(hi, i1 + m), Math.max(lo, j0 - m), Math.min(hi, j1 + m), SETTLE_ITER);
    const w0 = this._win;
    const chunks = this._refresh(w0.i0 - 1, w0.i1 + 1, w0.j0 - 1, w0.j1 + 1);
    this.revision++;
    return { requested: requested * area, removed: (removedQ / HEIGHT_Q) * area, relocated: (movedQ / HEIGHT_Q) * area, cells, chunks };
  }

  // settle a window again (a boulder pressed on it, a test) - mass-conserving;
  // returns the relocated volume (m3)
  settleArea(x0, z0, x1, z1, iterations = SETTLE_ITER) {
    const c = this.cell, lo = this.edgeCells, hi = this.vps - 1 - this.edgeCells;
    const i0 = Math.max(lo, Math.floor((x0 - this.x0) / c)), i1 = Math.min(hi, Math.ceil((x1 - this.x0) / c));
    const j0 = Math.max(lo, Math.floor((z0 - this.z0) / c)), j1 = Math.min(hi, Math.ceil((z1 - this.z0) / c));
    if (i1 <= i0 || j1 <= j0) return 0;
    const moved = this._settleLocal(i0, i1, j0, j1, iterations);
    const w = this._win;
    if (moved) { this._refresh(w.i0 - 1, w.i1 + 1, w.j0 - 1, w.j1 + 1); this.revision++; }
    return (moved / HEIGHT_Q) * c * c;
  }

  // total volume above (+) / below (-) the original pile, m3 - exact (integer sum)
  volumeDelta() {
    let s = 0;
    for (let k = 0; k < this.qh.length; k++) s += this.qh[k];
    return (s / HEIGHT_Q) * this.cell * this.cell;
  }

  // the pile's volume above the old ground (y = 0) - the "mountain", m3
  pileVolume() {
    let s = 0;
    const H = this.height, c2 = this.cell * this.cell;
    for (let k = 0; k < H.length; k++) if (H[k] > 0) s += H[k];
    return s * c2;
  }

  _loosen(hit, K, i0, i1, j0, j1) {
    const c = this.cell, vps = this.vps, R = K.loosenR || 0.25, H = this.height;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * vps + i, x = this.x0 + i * c, z = this.z0 + j * c;
      const d = Math.hypot(x - hit.x, z - hit.z, (H[k] - hit.y) * 0.5) / R;
      if (d >= 1 || (H[k] <= this.stoneTop[k] + 1e-4 && H[k] >= this.stoneBot[k])) continue;
      this.loose[k] = Math.min(30, Math.max(this.loose[k], Math.round(K.loosenCm * (1 - d * d))));
    }
  }

  // tan of the slope column k may keep towards a lower neighbour
  _reposeTan(k) {
    const h = this.height[k];
    if (h <= this.stoneTop[k] + 1e-4 && h >= this.stoneBot[k]) return Infinity;      // stone: rigid
    if (this.qh[k] === 0 && !this.loose[k] && !this.load[k]) return CRUST;          // the untouched pile
    const vps = this.vps, i = k % vps, j = (k - i) / vps;
    let mat = this.field.materialAt(this.x0 + i * this.cell, h - 0.01, this.z0 + j * this.cell, k);
    if (mat === MAT.COMPACT && this.loose[k]) mat = MAT.DIRT;                         // loosened compact runs like dirt
    return Math.max(REPOSE[mat], this.baseTan[k] + 0.06);
  }

  // Local settling after a bite: loose material runs down to its angle of
  // repose, the crust holds cut faces, stone stays. Pairwise and
  // mass-conserving (what leaves a column lands on its lower neighbour),
  // in a window around the bite - no global smoothing, no slide running up
  // the whole pile. When sliding material reaches the edge of the window,
  // the window grows (a few times at most), so no cell is left standing
  // steeper than its limit next to one that was never looked at.
  // Returns the moved amount (0.1 mm units); this._win = the final window.
  _settleLocal(i0, i1, j0, j1, iterations) {
    const lo = this.edgeCells, hi = this.vps - 1 - this.edgeCells;
    let total = 0;
    for (let grow = 0; grow < 6; grow++) {
      const moved = this._settlePass(i0, i1, j0, j1, iterations);
      total += moved;
      if (!moved) break;
      const tb = this._tb;
      let more = false;
      if (tb.i0 <= i0 + 1 && i0 > lo) { i0 = Math.max(lo, i0 - 4); more = true; }
      if (tb.i1 >= i1 - 1 && i1 < hi) { i1 = Math.min(hi, i1 + 4); more = true; }
      if (tb.j0 <= j0 + 1 && j0 > lo) { j0 = Math.max(lo, j0 - 4); more = true; }
      if (tb.j1 >= j1 - 1 && j1 < hi) { j1 = Math.min(hi, j1 + 4); more = true; }
      if (!more) break;
    }
    this._win = { i0, i1, j0, j1 };
    return total;
  }

  _settlePass(i0, i1, j0, j1, iterations) {
    const vps = this.vps, lim = this._lim;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = j * vps + i; lim[k] = this._reposeTan(k); }
    const c = this.cell, cd = c * Math.SQRT2;
    const tb = this._tb;
    tb.i0 = tb.j0 = Infinity; tb.i1 = tb.j1 = -Infinity;
    let total = 0;
    for (let it = 0; it < iterations; it++) {
      let moved = 0;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * vps + i;
          if (i < i1) moved += this._pair(k, k + 1, c);
          if (j < j1) {
            moved += this._pair(k, k + vps, c);
            if (i < i1) moved += this._pair(k, k + vps + 1, cd);
            if (i > i0) moved += this._pair(k, k + vps - 1, cd);
          }
        }
      }
      total += moved;
      if (!moved) break;
    }
    return total;
  }

  _pair(p, q, dist) {
    const H = this.height, lim = this._lim;
    let a = p, b = q;
    if (H[q] > H[p]) { a = q; b = p; }
    const excess = H[a] - H[b] - dist * lim[a];
    if (!(excess > 2e-4)) return 0;                          // 0.2 mm tolerance (and Infinity for stone)
    const units = Math.min(this.qh[a] - this._qMin(a), Math.floor(excess * 0.4 * HEIGHT_Q));
    if (units <= 0) return 0;
    const before = H[a];
    this._setQ(a, this.qh[a] - units);
    this._setQ(b, this.qh[b] + units);
    this.freshAt[a] = this.freshAt[b] = this.clock;
    if (this.loose[b] < 30) this.loose[b] = Math.min(30, this.loose[b] + Math.round(units / 100));   // slid material is loose (cm, from ~5 mm on)
    lim[a] = this._reposeTan(a);
    lim[b] = this._reposeTan(b);
    const vps = this.vps, tb = this._tb, ia = a % vps, ja = (a - ia) / vps, ib = b % vps, jb = (b - ib) / vps;
    if (ia < tb.i0) tb.i0 = ia; if (ib < tb.i0) tb.i0 = ib; if (ia > tb.i1) tb.i1 = ia; if (ib > tb.i1) tb.i1 = ib;
    if (ja < tb.j0) tb.j0 = ja; if (jb < tb.j0) tb.j0 = jb; if (ja > tb.j1) tb.j1 = ja; if (jb > tb.j1) tb.j1 = jb;
    if (this.onRelocate) this.onRelocate(a, b, before, H[a]);
    return units;
  }

  // ------------------------------------------------------------ quality / debug

  setLod(stride) {
    this.stride = stride === 2 ? 2 : 1;
    for (const ch of this.chunks) ch.geom.setIndex(this.stride === 2 ? this.indexHalf : this.indexFull);
  }

  setHeatmap(on) {
    if (this.heatmap === !!on) return;
    this.heatmap = !!on;
    this.refreshAll();
  }

  stats() {
    const perChunk = (this.stride === 2 ? this.indexHalf : this.indexFull).count / 3;
    return { chunks: this.chunks.length, vertices: this.vps * this.vps, triangles: perChunk * this.chunks.length };
  }

  // sanity check used by tests / debug: every height finite and inside limits
  validate() {
    for (let k = 0; k < this.height.length; k++) {
      const h = this.height[k];
      if (!Number.isFinite(h) || h < FLOOR_Y - 1e-6 || h > 30) return false;
    }
    return true;
  }

  // ------------------------------------------------------------ persistence

  serialize() {
    let changed = 0;
    for (let k = 0; k < this.qh.length; k++) if (this.qh[k]) changed++;
    return { gen: TERRAIN_GEN, cols: this.cols, cell: this.cell, unit: "0.1mm", encoding: "rle-zigzag-varint-b64", changed, data: encodeIntRle(this.qh), loose: encodeIntRle(this.loose) };
  }

  // the height column k will have after serialize() -> deserialize(): the
  // same (heights are always kept in their stored form)
  restoredHeight(k) { return this.height[k]; }

  // -> true when applied; false when the data doesn't fit this terrain.
  // Accepts the phase-2 form (whole millimetres) as well.
  deserialize(t) {
    if (!t || t.gen !== TERRAIN_GEN || t.cols !== this.cols || Math.abs(t.cell - this.cell) > 1e-9 || t.encoding !== "rle-zigzag-varint-b64") return false;
    const n = this.height.length;
    if (t.unit === "mm") {
      const q = decodeInt16Rle(t.data, n);
      for (let k = 0; k < n; k++) this._setQ(k, Math.max(this._qMin(k), q[k] * 10));
    } else {
      const q = decodeIntRle(t.data, n);
      for (let k = 0; k < n; k++) this._setQ(k, Math.max(this._qMin(k), q[k]));
      if (typeof t.loose === "string") { const l = decodeIntRle(t.loose, n); for (let k = 0; k < n; k++) this.loose[k] = Math.max(0, Math.min(30, l[k])); }
    }
    this.refreshAll();
    this.revision++;
    return true;
  }

  dispose() {
    for (const ch of this.chunks) ch.geom.dispose();
    this.chunks = [];
    this.group.clear();
  }
}
