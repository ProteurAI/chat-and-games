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
import { decodeInt16Rle, encodeInt16Rle } from "./goldrush-save.js";

export const FLOOR_Y = -2.5;          // open-pit floor: nobody digs deeper (phase 1)
// Version of the mound generator. Saves store height deltas against the
// generated mound, so they only fit the generator that made it: bump this
// whenever _generate() changes shape (old digs are then dropped, not
// applied to a different mound).
export const TERRAIN_GEN = 1;
const EDGE_KEEP = 1.5;                // metres at the border that stay untouched (seam with the ground)
// A fresh cut in moist soil stands steeper than the dry flank around it; the
// gap between the two limits decides how far up a toe cut pulls the flank
// (scarp height ~ depth * tan(wall) / (tan(wall) - tan(flank)) = ~2.7x here).
const MAX_SLOPE = Math.tan((62 * Math.PI) / 180);   // dug walls steeper than this collapse
const SETTLE_SLOPE = Math.tan((50 * Math.PI) / 180);  // only noise spikes of the untouched pile are capped
const RELAX_MARGIN = 12;                               // first collapse window around a dig (cells) ...
const RELAX_GROW = 16;                                 // ... grown while a collapse still reaches its edge

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
  stoneS: 0x8d857a, stoneD: 0x5f5850, fill: 0x93714f,
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
    this.rock = new Float32Array(n);
    this.rill = new Float32Array(n);
    this._generate();
    this.height.set(this.base);
    this.field = new MaterialField(this.seed, this, FLOOR_Y);
    this.stoneTop = this.field.stoneTop;             // uppermost stone body per column
    this.stoneBot = this.field.stoneBot;
    this.consumed = null;                            // set by the mining system (worked-over depth per column)
    // what the last excavate() did per cell (the mining system books it)
    this.rec = { n: 0, k: new Int32Array(REC_MAX), before: new Float32Array(REC_MAX), after: new Float32Array(REC_MAX) };
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
    const matw = chunk.geom.attributes.aMat.array;
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
        const mat = this.field.materialAt(x, h - 0.02, z, k);
        this._colorAt(k, x, z, h, inv, curv, mat, rgb);
        col[v * 3] = rgb[0];
        col[v * 3 + 1] = rgb[1];
        col[v * 3 + 2] = rgb[2];
        matw[v * 2] = mat === MAT.GRAVEL ? 1 : 0;
        matw[v * 2 + 1] = mat === MAT.STONE ? 1 : 0;
      }
    }
    chunk.geom.attributes.position.needsUpdate = true;
    chunk.geom.attributes.normal.needsUpdate = true;
    chunk.geom.attributes.color.needsUpdate = true;
    chunk.geom.attributes.aMat.needsUpdate = true;
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

  /**
   * Lower the surface around (x, z) with a smooth kernel.
   * @returns { removed: m^3, cells, chunks } or null when not diggable
   */
  // One tool stroke at (x, z): lowers a smooth round bite. eff(k, x, y, z)
  // says how much of the full bite comes off in the material at that cell
  // (0 = nothing, e.g. stone for the bare hand). Every changed cell lands in
  // this.rec with its height before and after the stroke (before any
  // collapse), so the mining system can book exactly what the tool took.
  // onCut(rec) runs right after the bite, before anything slides.
  excavate(x, z, radius, depth, eff, onCut) {
    const rec = this.rec;
    rec.n = 0;
    if (!this.inDigArea(x, z)) return null;
    const c = this.cell, vps = this.vps, H = this.height, r2 = radius * radius;
    const ci = (x - this.x0) / c, cj = (z - this.z0) / c, rr = Math.ceil(radius / c) + 1;
    const lo = this.edgeCells, hi = vps - 1 - this.edgeCells;
    const i0 = Math.max(lo, Math.floor(ci - rr)), i1 = Math.min(hi, Math.ceil(ci + rr));
    const j0 = Math.max(lo, Math.floor(cj - rr)), j1 = Math.min(hi, Math.ceil(cj + rr));
    let removed = 0, cells = 0;
    for (let j = j0; j <= j1; j++) {
      const cz = this.z0 + j * c, dz = cz - z;
      for (let i = i0; i <= i1; i++) {
        const cx = this.x0 + i * c, dx = cx - x, d2 = dx * dx + dz * dz;
        if (d2 >= r2) continue;
        let w = 1 - d2 / r2;
        w *= w;
        const k = j * vps + i, old = H[k];
        const f = eff ? eff(k, cx, old, cz) : 1;
        if (!(f > 0)) continue;
        const nh = Math.max(FLOOR_Y, this._stoneLimit(k, old - depth * w * f));
        if (nh < old - 1e-6 && rec.n < REC_MAX) {
          H[k] = nh;
          rec.k[rec.n] = k; rec.before[rec.n] = old; rec.after[rec.n] = nh; rec.n++;
          removed += old - nh;
          cells++;
        }
      }
    }
    if (!cells) return { removed: 0, cells: 0, chunks: 0 };
    if (onCut) onCut(rec);
    const win = this._relax(i0, i1, j0, j1);
    this._quantize(win.i0, win.i1, win.j0, win.j1);
    const chunks = this._refresh(win.i0 - 2, win.i1 + 2, win.j0 - 2, win.j1 + 2);
    this.revision++;
    return { removed: removed * c * c, cells, chunks };
  }


  // Loose material collapses: walls steeper than the angle of repose come
  // down, and what came down lands in the hole (volume is kept - digging
  // at the foot of the pile makes material trickle in from above). A
  // heightfield can't hold overhangs, so this is also what turns "digging
  // into the face" into a natural scoop instead of a vertical slot.
  // Near-critical flanks can slide a long way from a small undercut: the
  // window grows until the collapse no longer reaches its edge (never a
  // cliff at an arbitrary window border). Returns the final window.
  _relax(i0, i1, j0, j1) {
    const H = this.height, B = this.base, vps = this.vps, maxDiff = this.cell * MAX_SLOPE;
    const lo = this.edgeCells, hi = vps - 1 - this.edgeCells;
    const m = RELAX_MARGIN;
    const win = { i0: Math.max(lo, i0 - m), i1: Math.min(hi, i1 + m), j0: Math.max(lo, j0 - m), j1: Math.min(hi, j1 + m) };
    let fell = 0;
    for (let round = 0; round < 10; round++) {
      fell += this._clampRange(H, win.i0, win.i1, win.j0, win.j1, maxDiff);
      const b = this._box;
      const grow = [];
      if (b.i0 <= win.i0 + 1 && win.i0 > lo) grow.push("i0");
      if (b.i1 >= win.i1 - 1 && win.i1 < hi) grow.push("i1");
      if (b.j0 <= win.j0 + 1 && win.j0 > lo) grow.push("j0");
      if (b.j1 >= win.j1 - 1 && win.j1 < hi) grow.push("j1");
      if (!grow.length || b.i0 === Infinity) break;
      for (const side of grow) {
        if (side === "i0") win.i0 = Math.max(lo, win.i0 - RELAX_GROW);
        if (side === "i1") win.i1 = Math.min(hi, win.i1 + RELAX_GROW);
        if (side === "j0") win.j0 = Math.max(lo, win.j0 - RELAX_GROW);
        if (side === "j1") win.j1 = Math.min(hi, win.j1 + RELAX_GROW);
      }
    }
    if (fell > 1e-6) {
      // spread what came down over the dug cells, deeper cells get more
      let w = 0;
      for (let j = win.j0; j <= win.j1; j++) for (let i = win.i0; i <= win.i1; i++) { const k = j * vps + i; if (B[k] - H[k] > CHANGED_EPS) w += B[k] - H[k]; }
      if (w > 0) {
        for (let j = win.j0; j <= win.j1; j++) {
          for (let i = win.i0; i <= win.i1; i++) {
            const k = j * vps + i, depth = B[k] - H[k];
            if (depth > CHANGED_EPS) H[k] += Math.min(depth, (fell * depth) / w);
          }
        }
        this._clampRange(H, win.i0, win.i1, win.j0, win.j1, maxDiff);
      }
    }
    return win;
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
    const n = this.height.length, q = new Int16Array(n);
    let changed = 0;
    for (let k = 0; k < n; k++) {
      const d = Math.round((this.height[k] - this.base[k]) * 1000);
      const v = d > 32767 ? 32767 : d < -32767 ? -32767 : d;
      q[k] = v;
      if (v) changed++;
    }
    return { gen: TERRAIN_GEN, cols: this.cols, cell: this.cell, unit: "mm", encoding: "rle-zigzag-varint-b64", changed, data: encodeInt16Rle(q) };
  }

  // -> true when applied; false when the data doesn't fit this terrain
  // Changed heights are kept in exactly the form a save stores (original
  // mound + whole millimetres), so playing on and reloading a save always
  // continue from the very same numbers - no sub-millimetre drift that could
  // make a stroke come out differently after a reload.
  _quantize(i0, i1, j0, j1) {
    const vps = this.vps;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * vps + i;
      if (this.height[k] !== this.base[k]) this.height[k] = this.restoredHeight(k);
    }
  }

  // the height column k will have after serialize() -> deserialize()
  restoredHeight(k) {
    const d = Math.round((this.height[k] - this.base[k]) * 1000);
    const v = d > 32767 ? 32767 : d < -32767 ? -32767 : d;
    return Math.fround(Math.max(FLOOR_Y, this.base[k] + v / 1000));
  }

  deserialize(t) {
    if (!t || t.gen !== TERRAIN_GEN || t.cols !== this.cols || Math.abs(t.cell - this.cell) > 1e-9 || t.encoding !== "rle-zigzag-varint-b64") return false;
    const q = decodeInt16Rle(t.data, this.height.length);
    for (let k = 0; k < q.length; k++) this.height[k] = Math.max(FLOOR_Y, this.base[k] + q[k] / 1000);
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
