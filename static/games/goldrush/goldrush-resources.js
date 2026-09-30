// GoldRush - the ground itself: which material sits where, how much gold it
// holds, and what exactly a given piece of it contains. Everything here is
// a pure function of the world seed and the ORIGINAL mound, so it is never
// saved - the save only records how deep each column has been worked
// (see goldrush-mining.js).
//
// Geology (simple, but spatial - the player can learn it):
//   - loose dirt near the surface, compact dirt inside the pile, gravel in
//     blobs and bands and above all at the bottom of the pile
//   - stone: rock outcrops, buried stone lenses and boulders sticking out
//     of the pile; the hand cannot get through any of them
//   - gold: next to nothing in most of the pile; a little more in richer
//     zones, in thin streaks and in the gravel "pay layer" at and below the old
//     ground, a lot in a handful of seeded pockets
//
// Resource voxels: every terrain column (one vertex, 12.5 x 12.5 cm) is cut
// into 5 cm slices. Each slice's content (nothing, gold dust, a flake, a
// tiny piece, a small nugget - and its exact mass) is decided by a hash of
// seed + voxel index. Working through a slice pays it out exactly once.

import { fbm2, hash3, mulberry32, noise2, noise3, smoothstep } from "./goldrush-noise.js";
import { MAT } from "./goldrush-materials.js";

export const VOXEL_H = 0.05;                     // m; footprint = one terrain column
export const FIND = { NONE: 0, TRACE: 1, FINE: 2, FLAKE: 3, TINY: 4, NUGGET: 5 };
export const FIND_IDS = ["barren", "traceGold", "fineGold", "goldFlake", "tinyGoldPiece", "smallNugget"];

// ---- tuning of the finds (see tests/e2e/goldrush_mining_e2e.py, TEST 25)
const P_FIND = 0.115;         // chance a slice holds gold at all = P_FIND * density^0.85
const P_NUGGET = 0.006;       // share of finds that are small nuggets, x (0.6 + 1.2 g²)
const P_TINY = 0.042;         // ... tiny pieces, x (0.4 + 1.2 g)
const P_FLAKE = 0.14;         // ... flakes, x (0.6 + g)
// mass ranges in micrograms (100 µg = 1 cent at the provisional € 100 / g)
const MASS = {
  [FIND.TRACE]: [60, 240, 2],          // 1-3 ct
  [FIND.FINE]: [300, 500, 1.5],        // 3-8 ct
  [FIND.FLAKE]: [800, 2200, 1.8],      // 8-30 ct
  [FIND.TINY]: [2500, 6500, 1.6],      // 25-90 ct
  [FIND.NUGGET]: [10000, 30000, 2.2],  // 1-4 €, most of them small
};

export class MaterialField {
  constructor(seed, terrain, floorY) {
    this.seed = seed | 0;
    this.terrain = terrain;
    this.floorY = floorY;
    const rng = mulberry32(this.seed ^ 0x51f15e);
    const { x: cx, z: cz } = terrain.moundCenter;
    // gold pockets: ellipsoids inside the pile, mostly low and deep
    this.pockets = [];
    for (let i = 0; i < 8; i++) {
      const a = rng() * Math.PI * 2, r = 1.5 + rng() * 7;
      this.pockets.push({
        x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r,
        y: 0.3 + rng() * rng() * 4,
        rx: 0.7 + rng() * 1.3, ry: 0.35 + rng() * 0.6, rz: 0.7 + rng() * 1.3,
        peak: 0.5 + rng() * 0.5,
      });
    }
    // buried stone lenses (flattened ellipsoids)
    this.lenses = [];
    for (let i = 0; i < 9; i++) {
      const a = rng() * Math.PI * 2, r = rng() * 8.5;
      this.lenses.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r, y: 0.4 + rng() * 4.5, r: 0.6 + rng() * 1.0 });
    }
    // boulders sticking out of the pile (visible; the world builds their meshes)
    this.boulders = [];
    const brng = mulberry32(this.seed ^ 0xb0a1de5);
    for (let tries = 0; tries < 200 && this.boulders.length < 12; tries++) {
      const a = brng() * Math.PI * 2, d = 2.5 + brng() * 8.5, r = 0.32 + brng() * brng() * 0.6;
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      const ground = terrain.getBaseHeightAt(x, z);
      if (ground < 0.3 || ground > 6) continue;
      if (!terrain.inDigArea(x - r - 0.5, z - r - 0.5) || !terrain.inDigArea(x + r + 0.5, z + r + 0.5)) continue;
      if (this.boulders.some((b) => Math.hypot(b.x - x, b.z - z) < b.r + r + 0.8)) continue;
      this.boulders.push({ x, z, y: ground - r * 0.15, r, rot: brng() * Math.PI * 2, variant: this.boulders.length % 4 });
    }
    this._buildStone();
  }

  // Per terrain column: top and bottom of the uppermost stone body. The top
  // is the "hard floor" for the hand (the terrain never goes below it).
  _buildStone() {
    const t = this.terrain, vps = t.vps, n = vps * vps, c = t.cell;
    const top = (this.stoneTop = new Float32Array(n).fill(-Infinity));
    const bot = (this.stoneBot = new Float32Array(n).fill(Infinity));
    const put = (k, y0, y1) => { if (y1 > top[k]) { top[k] = y1; bot[k] = y0; } };
    const cellOf = (x, z) => [Math.round((x - t.x0) / c), Math.round((z - t.z0) / c)];
    // rock outcrops (surface mask from the mound generator)
    for (let k = 0; k < n; k++) {
      const m = t.rock[k];
      if (m > 0.45) put(k, t.base[k] - (0.45 + (m - 0.45) * 1.2), t.base[k]);
    }
    // lenses: flattened ellipsoids, clipped to the original surface
    for (const l of this.lenses) {
      const ry = l.r * 0.62, [i0, j0] = cellOf(l.x - l.r, l.z - l.r), [i1, j1] = cellOf(l.x + l.r, l.z + l.r);
      for (let j = Math.max(0, j0); j <= Math.min(vps - 1, j1); j++) {
        for (let i = Math.max(0, i0); i <= Math.min(vps - 1, i1); i++) {
          const x = t.x0 + i * c, z = t.z0 + j * c, q = 1 - ((x - l.x) ** 2 + (z - l.z) ** 2) / (l.r * l.r);
          if (q <= 0) continue;
          const k = j * vps + i, h = ry * Math.sqrt(q);
          if (l.y - h >= t.base[k]) continue;              // would float above the pile
          put(k, l.y - h, Math.min(t.base[k], l.y + h));
        }
      }
    }
    // boulders: the body under the visible rock is stone as well
    for (const b of this.boulders) {
      const rs = b.r * 0.9, [i0, j0] = cellOf(b.x - rs, b.z - rs), [i1, j1] = cellOf(b.x + rs, b.z + rs);
      for (let j = Math.max(0, j0); j <= Math.min(vps - 1, j1); j++) {
        for (let i = Math.max(0, i0); i <= Math.min(vps - 1, i1); i++) {
          const x = t.x0 + i * c, z = t.z0 + j * c, q = rs * rs - (x - b.x) ** 2 - (z - b.z) ** 2;
          if (q <= 0) continue;
          const h = Math.sqrt(q);
          put(j * vps + i, b.y - h, b.y + h);
        }
      }
    }
  }

  _column(x, z) {
    const t = this.terrain;
    const i = Math.round((x - t.x0) / t.cell), j = Math.round((z - t.z0) / t.cell);
    if (i < 0 || j < 0 || i >= t.vps || j >= t.vps) return -1;
    return j * t.vps + i;
  }

  // what the ground is made of at a point (y = absolute height)
  materialAt(x, y, z, k = this._column(x, z)) {
    if (k >= 0 && y <= this.stoneTop[k] + 1e-4 && y >= this.stoneBot[k]) return MAT.STONE;
    const t = this.terrain, s = this.seed;
    const base = k >= 0 ? t.base[k] : 0, depth = base - y;
    // gravel: 3D blobs and bands, much more of it at the bottom of the pile
    const gn = noise3(x * 0.42, y * 1.05, z * 0.42, s + 501);
    if (gn * 0.62 + smoothstep(0.9, -0.3, y) * 0.55 > 0.42) return MAT.GRAVEL;
    // compact: the inside of the pile and the trodden toe; loose dirt on top
    const cn = noise3(x * 0.28, y * 0.7, z * 0.28, s + 511);
    if ((depth - 0.35) * 0.9 + cn * 0.6 + smoothstep(1.4, 0.3, base) * 0.35 > 0.3) return MAT.COMPACT;
    return MAT.DIRT;
  }

  // gold per unit of material, 0..1 (only relative; the finds turn it into mass)
  goldDensityAt(x, y, z, mat, depth) {
    if (mat === MAT.STONE) return 0;
    const s = this.seed;
    const region = smoothstep(0.15, 0.75, fbm2(x * 0.085 + 11.3, z * 0.085 - 7.1, s + 401, 3));
    const payY = -0.3 + 0.3 * noise2(x * 0.12, z * 0.12, s + 403);   // the old ground under the pile: dig down
    const pay = Math.exp(-(((y - payY) / 0.55) ** 2));
    const vn = noise3(x * 0.5, y * 0.9, z * 0.5, s + 405);
    const vein = Math.max(0, 1 - Math.abs(vn) * 7) ** 2 * smoothstep(-0.2, 0.5, noise2(x * 0.2, z * 0.2, s + 407));
    let pocket = 0;
    for (const p of this.pockets) {
      const dx = (x - p.x) / p.rx, dy = (y - p.y) / p.ry, dz = (z - p.z) / p.rz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1) pocket = Math.max(pocket, p.peak * (1 - d2) * (1 - d2));
    }
    const deep = 0.8 + 0.4 * smoothstep(0, 3, depth);
    const mf = mat === MAT.GRAVEL ? 1.55 : mat === MAT.COMPACT ? 1.05 : 0.7;
    return Math.min(1, Math.max(0, (0.06 + 0.32 * region + 0.3 * pay + 0.45 * vein) * deep * mf + pocket));
  }

  // content of resource voxel (column k = vertex i/j, slice iy): writes
  // { cls, massUg } into out; cls FIND.NONE for barren ground
  voxel(i, j, iy, out) {
    const t = this.terrain, k = j * t.vps + i;
    const x = t.x0 + i * t.cell, z = t.z0 + j * t.cell, y = this.floorY + (iy + 0.5) * VOXEL_H;
    out.cls = FIND.NONE;
    out.massUg = 0;
    const mat = this.materialAt(x, y, z, k);
    out.mat = mat;
    if (mat === MAT.STONE) return out;
    const g = this.goldDensityAt(x, y, z, mat, t.base[k] - y);
    out.g = g;
    const s = this.seed;
    if (hash3(i, iy, j, s ^ 0x6a09e667) >= P_FIND * Math.pow(g, 0.85)) return out;
    const u = hash3(i, iy, j, s ^ 0x3c6ef372);
    const pN = P_NUGGET * (0.6 + 1.2 * g * g), pT = P_TINY * (0.4 + 1.2 * g), pF = P_FLAKE * (0.6 + g);
    let cls;
    if (u < pN) cls = FIND.NUGGET;
    else if (u < pN + pT) cls = FIND.TINY;
    else if (u < pN + pT + pF) cls = FIND.FLAKE;
    else cls = hash3(i, iy, j, s ^ 0xa54ff53a) < 0.25 + 0.5 * g ? FIND.FINE : FIND.TRACE;
    const [m0, span, curve] = MASS[cls];
    out.cls = cls;
    out.massUg = Math.round(m0 + span * Math.pow(hash3(i, iy, j, s ^ 0x510e527f), curve));
    return out;
  }

  // debug / heatmap view of a point
  sample(x, y, z, out = {}) {
    const k = this._column(x, z);
    const mat = this.materialAt(x, y, z, k);
    const depth = Math.max(0, (k >= 0 ? this.terrain.base[k] : 0) - y);
    out.depth = depth;
    out.material = mat;
    out.stone = mat === MAT.STONE ? 1 : 0;
    out.dirt = 1 - out.stone;
    out.goldDensity = this.goldDensityAt(x, y, z, mat, depth);
    out.rarity = hash3(Math.floor(x * 4), Math.floor(y * 4), Math.floor(z * 4), this.seed + 991);
    return out;
  }

  // which boulder (index) a ray hits first, and where - or null
  raycastBoulders(ox, oy, oz, dx, dy, dz, maxDist, out) {
    let best = maxDist, hit = null;
    for (let b = 0; b < this.boulders.length; b++) {
      const B = this.boulders[b], r = B.r * 0.92;
      const lx = ox - B.x, ly = oy - B.y, lz = oz - B.z;
      const bq = lx * dx + ly * dy + lz * dz, c = lx * lx + ly * ly + lz * lz - r * r;
      const disc = bq * bq - c;
      if (disc < 0) continue;
      const tHit = -bq - Math.sqrt(disc);
      if (tHit > 0 && tHit < best) { best = tHit; hit = b; }
    }
    if (hit == null) return null;
    const B = this.boulders[hit];
    out.x = ox + dx * best; out.y = oy + dy * best; out.z = oz + dz * best;
    const nx = out.x - B.x, ny = out.y - B.y, nz = out.z - B.z, nl = Math.hypot(nx, ny, nz) || 1;
    out.normal = { x: nx / nl, y: ny / nl, z: nz / nl };
    out.distance = best;
    out.boulder = hit;
    return out;
  }
}
