// GoldRush - the ground itself: which material sits where, how much gold it
// holds, and what exactly a given piece of it contains. Everything here is
// a pure function of the world seed and the ORIGINAL mound, so it is never
// saved - the save only records how deep each column has been worked, how
// much stone a pickaxe cut away and where the boulders went
// (see goldrush-mining.js, goldrush-rocks.js).
//
// Geology (simple, but spatial - the player can learn it):
//   - loose dirt near the surface, compact dirt inside the pile, gravel in
//     blobs and bands and above all at the bottom of the pile
//   - stone: rock outcrops and buried stone lenses in the ground (only a
//     pickaxe cuts it), plus loose boulders lying in the pile - separate
//     objects (goldrush-rocks.js), not part of the ground
//   - gold: next to nothing in most of the pile; a little more in richer
//     zones, in thin streaks and (phase 9) in buried paleochannels, a lot in
//     a handful of seeded pockets (until phase 9 a gravel "pay layer" at and
//     below the old ground held much of it - see below)
//   - the starter zone (the faces you walk up to from the claim entrance)
//     is kept fair: never barren, never a jackpot, no gravel skirt and no
//     stone in the way - the rest of the pile varies freely per seed
//   - phase 9 (GEOLOGY 2.0, GEOLOGY_VERSION 2): no "pay layer" at the old
//     ground level any more (it made ground level itself the rich ground and
//     the camp's apron a gold farm). Instead:
//       ordinary ground   one neutral grade with broad regional variation; the
//                         upper mountain a little poorer (older overburden,
//                         GEO.mountain), gravel a little richer than dirt
//       paleochannels     2-4 buried ancient stream beds per seed (CHANNEL):
//                         curving across the claim, some under the mountain,
//                         varying width / bed height / thickness, gravel
//                         lenses, rich and poor stretches, gaps - rich ground
//                         is local and has to be found (samples), it is not a
//                         height
//       camp fill         the camp's apron is imported, compacted fill
//                         (CAMP_FILL): next to no native gold; natural ground
//                         lies below it
//     Everything stays a pure function of seed + position (+ the original
//     surface); nothing is tied to y = 0.
//   - mineralised streaks (phase 7A): a few tilted, cemented pay streaks of
//     gravel / clay in the pile, never in the starter zone. Hand and shovel
//     hardly get into them; the pickaxe breaks them up (loosens them) and the
//     shovel takes the loosened material. They hold more gold - taken from the
//     rest of the pile (REDIST), not added - mostly as fine gold and flakes;
//     the nugget odds stay those of the ground around them. Where one reaches
//     the surface it shows: rust-stained, quartz flecks, dark heavy-mineral
//     streaks (goldrush-terrain.js / goldrush-world.js) - never the gold itself.
//
// Resource voxels: every terrain column (one vertex, 12.5 x 12.5 cm) is cut
// into 1 cm slices (~0.16 l, ~0.2 kg). Each slice's content (nothing, gold
// dust, a flake, a tiny piece, a small nugget - and its exact mass) is
// decided by a hash of seed + voxel index. Taking a slice out pays it
// exactly once.
// Besides those visible pieces every slice holds FINE GOLD, spread through
// the material - far too fine to see while digging (fineUg, from the same
// gold density, no dice). Digging alone never gets it back: it leaves with
// the spoil. Washing the material (bucket -> classifier -> gold pan,
// goldrush-material.js) recovers part of it.

import { fbm2, hash3, mulberry32, noise2, noise3, smoothstep } from "./goldrush-noise.js";
import { MAT } from "./goldrush-materials.js";

export const VOXEL_H = 0.01;                     // m; footprint = one terrain column
export const FIND = { NONE: 0, TRACE: 1, FINE: 2, FLAKE: 3, TINY: 4, NUGGET: 5 };
export const FIND_IDS = ["barren", "traceGold", "fineGold", "goldFlake", "tinyGoldPiece", "smallNugget"];

// ---- tuning of the finds (canonical benchmark: tests/e2e/goldrush_bench.js)
// (measured: hand ~0.7 fresh slices per action; benchmark targets: first
// dust within seconds, first nugget after ~5-12 minutes, money in cents at
// first - see the phase-3 report)
const P_FIND = 0.34;          // chance a slice holds gold at all = P_FIND * density^0.85
const P_NUGGET = 0.0118;      // share of finds that are small nuggets, x (0.6 + 1.2 g²)
const P_TINY = 0.0206;        // ... tiny pieces, x (0.4 + 1.2 g)
const P_FLAKE = 0.038;        // ... flakes, x (0.6 + g)
// mass ranges in micrograms (100 µg = 1 cent at the provisional € 100 / g)
const MASS = {
  [FIND.TRACE]: [60, 240, 2],          // 1-3 ct
  [FIND.FINE]: [300, 500, 1.5],        // 3-8 ct
  [FIND.FLAKE]: [800, 2200, 1.8],      // 8-30 ct
  [FIND.TINY]: [2500, 6500, 1.6],      // 25-90 ct
  [FIND.NUGGET]: [10000, 30000, 2.2],  // 1-4 €, most of them small
};
// fine gold per slice at gold density 1 (µg) - the bulk of the gold in the
// ground, but only processing brings it back (see the phase-5 benchmark)
const FINE_PER_SLICE = 6000;
// starter zone: gold density held inside this band (fair, not lucky)
// (narrow on purpose: early progress should come from steady work, not from
// whether a seed's first nugget shows up early - see the phase-4 benchmark)
const STARTER = { radius: 6.5, fade: 2.5, depth: 1.6, gMin: 0.21, gMax: 0.29 };
// mineralised streaks: how many, how rich (added density at the core), the share of
// the ordinary gold left outside them (redist: the rest sits in the streaks - the
// pile's total stays the same within ~0,6 % per seed, measured over the volume),
// and the core value above which they are cemented
export const STREAK = { count: 6, g: 0.42, redist: 0.985, cement: 0.3, flake: 1.4, pieceCap: 0.12 };
// phase 9: the generation version of the ground's gold (saved; an older save keeps every slice it already
// took - those never pay again - and its unmined ground follows this one)
export const GEOLOGY_VERSION = 2;
// ordinary ground: neutral grade +- regional variation, by material, the upper mountain's share of it
// (smoothly from 0.3 m to 2.2 m of original height), how much deeper ground inside a body adds
export const GEO = { base: 0.2, region: 0.12, mf: [0.88, 1.0, 1.15, 0], mountain: 0.94, mountainFrom: 0.3, mountainTo: 2.2, deep: 0.2, vein: 0.25 };
// paleochannels: how many, their width / bed / thickness ranges, the grade they add (poor .. rich stretch)
export const CHANNEL = { min: 2, max: 4, width: [1.4, 3.4], bed: [-1.25, -0.3], thick: [0.35, 0.8], poor: 0.12, rich: 0.78, richPow: 1.3, gravel: 0.35 };
// the camp's apron: imported, compacted fill on top of the natural ground (west of the pile, in front of
// the camp) - its edge (x), its extent along z, a soft noisy border, how deep it goes, its trace of gold
export const CAMP_FILL = { x: -9.3, soft: 1.1, z0: -9.5, z1: 9.8, depth: 0.55, depthVar: 0.15, g: 0.008 };

export class MaterialField {
  constructor(seed, terrain, floorY) {
    this.seed = seed | 0;
    this.terrain = terrain;
    this.floorY = floorY;
    const rng = mulberry32(this.seed ^ 0x51f15e);
    const { x: cx, z: cz } = terrain.moundCenter;
    this._findStarter();
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
    // boulders lying in the pile: their start positions (goldrush-rocks.js
    // owns them from here on: settling, damage, breaking)
    this.boulders = [];
    const brng = mulberry32(this.seed ^ 0xb0a1de5);
    for (let tries = 0; tries < 200 && this.boulders.length < 12; tries++) {
      const a = brng() * Math.PI * 2, d = 2.5 + brng() * 8.5, r = 0.32 + brng() * brng() * 0.6;
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      const ground = terrain.getBaseHeightAt(x, z);
      if (ground < 0.3 || ground > 6) continue;
      if (!terrain.inDigArea(x - r - 0.5, z - r - 0.5) || !terrain.inDigArea(x + r + 0.5, z + r + 0.5)) continue;
      if (this.boulders.some((b) => Math.hypot(b.x - x, b.z - z) < b.r + r + 0.8)) continue;
      if (Math.hypot(x - this.starter.x, z - this.starter.z) < 3 + r) continue;     // not right where you start
      this.boulders.push({ x, z, y: ground - r * 0.15, r, rot: brng() * Math.PI * 2, variant: this.boulders.length % 4, broken: false, tilt: 0, tiltDir: 0 });
    }
    this._buildStone();
    this._buildStreaks();
    this._buildChannels();
  }

  // ---- phase 9: paleochannels - buried stream beds across the claim. Each a curve from one side to the
  // other (some across the middle, under the mountain, some past its foot), stamped once into the column
  // grid (nearest channel, where along it, how far off its centre line) so a lookup per slice is O(1).
  _buildChannels() {
    const t = this.terrain, rng = mulberry32(this.seed ^ 0x9a1e0c4), vps = t.vps, c = t.cell, n = vps * vps;
    const cx = t.x0 + t.size / 2, cz = t.z0 + t.size / 2, R = t.size * 0.62;
    const count = CHANNEL.min + Math.floor(rng() * (CHANNEL.max - CHANNEL.min + 1));
    this.channels = [];
    this.chIdx = new Int8Array(n).fill(-1);
    this.chT = new Float32Array(n);
    this.chD = new Float32Array(n).fill(1e9);
    const lerp = (a, b, k) => a + (b - a) * k;
    for (let q = 0; q < count; q++) {
      // across the claim: an entry angle, an exit roughly opposite, shifted sideways (past the middle or not)
      const a0 = (q / count) * Math.PI + rng() * 0.9, a1 = a0 + Math.PI + (rng() - 0.5) * 1.1;
      const off = (rng() - 0.5) * t.size * 0.55;
      const nx = -Math.sin(a0), nz = Math.cos(a0);
      const p0 = { x: cx + Math.cos(a0) * R + nx * off, z: cz + Math.sin(a0) * R + nz * off };
      const p1 = { x: cx + Math.cos(a1) * R + nx * off, z: cz + Math.sin(a1) * R + nz * off };
      const ch = {
        i: q, p0, p1, len: Math.hypot(p1.x - p0.x, p1.z - p0.z),
        amp: 0.8 + rng() * 2.6, waves: 1.2 + rng() * 2.2, phase: rng() * 6.283,
        w0: lerp(CHANNEL.width[0], CHANNEL.width[1], rng()), bed: lerp(CHANNEL.bed[0], CHANNEL.bed[1], rng()), tilt: (rng() - 0.5) * 0.7,
        th0: lerp(CHANNEL.thick[0], CHANNEL.thick[1], rng()), seedOff: Math.floor(rng() * 9000), richK: 0.85 + rng() * 0.3,
      };
      this.channels.push(ch);
      // stamp it into the grid: walk the curve in short steps, mark the columns round each point
      const steps = Math.ceil(ch.len / 0.1);
      const pt = {};
      for (let s = 0; s <= steps; s++) {
        const u = s / steps;
        this._channelPoint(ch, u, pt);
        const hw = this._channelWidth(ch, u) / 2;
        if (hw <= 0.05) continue;
        const r = hw + 0.15, i0 = Math.max(0, Math.floor((pt.x - r - t.x0) / c)), i1 = Math.min(vps - 1, Math.ceil((pt.x + r - t.x0) / c));
        const j0 = Math.max(0, Math.floor((pt.z - r - t.z0) / c)), j1 = Math.min(vps - 1, Math.ceil((pt.z + r - t.z0) / c));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const k = j * vps + i, d = Math.hypot(t.x0 + i * c - pt.x, t.z0 + j * c - pt.z);
          // the nearest centre line wins; its weight is judged against its own width at that point
          if (d / hw < this.chD[k]) { this.chD[k] = d / hw; this.chIdx[k] = q; this.chT[k] = u; }
        }
      }
    }
  }

  // the channel's centre line at u (0..1 along it): the straight line plus a meander
  _channelPoint(ch, u, out) {
    const dx = ch.p1.x - ch.p0.x, dz = ch.p1.z - ch.p0.z, l = ch.len || 1, px = -dz / l, pz = dx / l;
    const m = ch.amp * Math.sin(u * ch.waves * 6.283 + ch.phase) + 0.6 * noise2(u * 5.3, ch.seedOff * 0.01, this.seed + 811);
    out.x = ch.p0.x + dx * u + px * m;
    out.z = ch.p0.z + dz * u + pz * m;
    return out;
  }

  // its width at u: varying, and now and then it fades out (a gap - it split, or the stream left it)
  _channelWidth(ch, u) {
    const w = ch.w0 * (0.65 + 0.5 * (0.5 + 0.5 * noise2(u * 6.1 + ch.seedOff * 0.013, 0.37, this.seed + 813)));
    const gap = smoothstep(-0.72, -0.45, noise2(u * 3.7 + ch.seedOff * 0.017, 1.9, this.seed + 815));
    return w * gap;
  }

  /**
   * Inside a paleochannel? -> null or { w: 0..1 how deep inside its gravel body, rich: 0..1 the grade of
   * this stretch (with its gravel lenses), i: which channel }. The bed rises and falls a little along it.
   */
  channelAt(x, y, z, k = this._column(x, z)) {
    if (k < 0 || !this.chIdx || this.chIdx[k] < 0) return null;
    const lat = this.chD[k];
    if (lat >= 1) return null;
    const ch = this.channels[this.chIdx[k]], u = this.chT[k], s = this.seed;
    const bed = ch.bed + ch.tilt * (u - 0.5) + 0.18 * noise2(u * 4.3 + ch.seedOff * 0.011, 2.7, s + 817);
    const th = ch.th0 * (0.75 + 0.5 * (0.5 + 0.5 * noise2(u * 7.7 + ch.seedOff * 0.019, 3.3, s + 819)));
    const dv = (y - bed) / (th / 2);
    if (dv <= -1 || dv >= 1) return null;
    const w = Math.pow(1 - lat * lat, 0.7) * (1 - dv * dv);
    // the grade along it: rich and poor stretches (two scales), lenses of richer gravel inside
    const along = 0.5 + 0.55 * noise2(u * 5.2 + ch.seedOff * 0.023, 4.1, s + 821) + 0.25 * noise2(u * 15.7, ch.seedOff * 0.029, s + 823);
    const lens = 0.5 + 0.5 * noise3(x * 0.85, y * 2.4, z * 0.85, s + 825);
    const rich = Math.max(0, Math.min(1, (along * (0.7 + 0.6 * lens)) * ch.richK));
    return { w, rich, i: ch.i };
  }

  // phase 9: the camp's apron is fill - 0..1 (1: fill on top) and how deep it goes there (m)
  campFillAt(x, z) {
    const F = CAMP_FILL, e = noise2(x * 0.45, z * 0.45, this.seed + 831) * 0.6;
    const inX = smoothstep(F.x + F.soft, F.x - F.soft, x + e), inZ = smoothstep(F.z0 - 0.8, F.z0 + 0.4, z + e) * smoothstep(F.z1 + 0.8, F.z1 - 0.4, z + e);
    return inX * inZ;
  }

  fillDepthAt(x, z) { return CAMP_FILL.depth + CAMP_FILL.depthVar * noise2(x * 0.7, z * 0.7, this.seed + 833); }

  // inside the camp fill at (x, y, z)? (below its depth the natural ground starts)
  inFill(x, y, z, base) {
    const f = this.campFillAt(x, z);
    return f > 0.5 && base - y < this.fillDepthAt(x, z) * Math.min(1, f * 1.4);
  }

  // what the surface shows of the gold-bearing ground (looks only, subtle): a streak's rust and bands,
  // and - fainter - a paleochannel's pay gravel where it comes up (0..1)
  surfaceHint(x, y, z) {
    const st = this.streakAt(x, y, z), ch = this.channelAt(x, y, z);
    return Math.max(st, ch ? 0.32 * ch.w * (0.3 + 0.7 * ch.rich) : 0);
  }

  // a gold pocket's share at a point (0..1 of its peak) - the benchmark's zone
  pocketAt(x, y, z) {
    let pocket = 0;
    for (const p of this.pockets) {
      const dx = (x - p.x) / p.rx, dy = (y - p.y) / p.ry, dz = (z - p.z) / p.rz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1) pocket = Math.max(pocket, (1 - d2) * (1 - d2));
    }
    return pocket;
  }

  // tilted slabs of cemented pay gravel / clay: centre, strike (in plan), dip,
  // half length / width / thickness. One of them near the starter zone's rim
  // (you meet it within the first hour), the rest anywhere in the pile.
  _buildStreaks() {
    const t = this.terrain, rng = mulberry32(this.seed ^ 0x7a57ea4), { x: cx, z: cz } = t.moundCenter;
    this.streaks = [];
    const ok = (x, z, r) => {
      const ground = t.getBaseHeightAt(x, z);
      if (ground < 0.7 || ground > 7.5) return false;
      if (!t.inDigArea(x - r, z - r) || !t.inDigArea(x + r, z + r)) return false;
      if (Math.hypot(x - this.starter.x, z - this.starter.z) < STARTER.radius + STARTER.fade * 0.4 + r * 0.5) return false;
      return !this.streaks.some((s) => Math.hypot(s.x - x, s.z - z) < s.len + r + 0.6);
    };
    for (let tries = 0; tries < 400 && this.streaks.length < STREAK.count; tries++) {
      const first = this.streaks.length === 0 && tries < 200;
      let x, z;
      if (first) {
        // around the starter zone, a little up the pile
        const a0 = Math.atan2(cz - this.starter.z, cx - this.starter.x), a = a0 + (rng() - 0.5) * 2.4, d = STARTER.radius + 2.2 + rng() * 2.2;
        x = this.starter.x + Math.cos(a) * d; z = this.starter.z + Math.sin(a) * d;
      } else {
        const a = rng() * Math.PI * 2, d = 1.5 + rng() * 9;
        x = cx + Math.cos(a) * d; z = cz + Math.sin(a) * d;
      }
      const len = 1.3 + rng() * 1.6, w = 0.55 + rng() * 0.45, th = 0.16 + rng() * 0.16;
      if (!ok(x, z, len)) continue;
      const ground = t.getBaseHeightAt(x, z);
      // the first one comes up to the surface (it can be seen), the others lie 0-1.4 m deep
      const y = ground - (first ? 0.12 + rng() * 0.18 : rng() * 1.4) - th * 0.5;
      this.streaks.push({ i: this.streaks.length, x, y, z, len, w, th, strike: rng() * Math.PI, slope: Math.tan(0.15 + rng() * 0.5) * (rng() < 0.5 ? -1 : 1),
        gravel: rng() < 0.7, seedOff: Math.floor(rng() * 1000) });
    }
  }

  /** 0..1: how deep inside a mineralised streak a point lies (0 = outside) */
  streakAt(x, y, z) {
    const S = this.streaks;
    if (!S || !S.length) return 0;
    let best = 0;
    for (let n = 0; n < S.length; n++) {
      const s = S[n], dx = x - s.x, dz = z - s.z;
      if (dx * dx + dz * dz > (s.len + 0.3) * (s.len + 0.3)) continue;
      const c = Math.cos(s.strike), sn = Math.sin(s.strike);
      const u = dx * c + dz * sn, v = -dx * sn + dz * c;
      const e = (u / s.len) ** 2 + (v / s.w) ** 2;
      if (e >= 1) continue;
      // its mid plane rises across the streak (dip); the slab wavers a little
      const wav = noise2(u * 1.7 + s.seedOff, v * 1.7, this.seed + 701) * 0.07;
      const dy = (y - (s.y + v * s.slope + wav)) / (s.th * (0.75 + 0.25 * (1 - e)));
      if (dy <= -1 || dy >= 1) continue;
      best = Math.max(best, (1 - e) * (1 - dy * dy));
    }
    return best;
  }

  /** which streak a point lies in (its index), -1 = none */
  streakIdAt(x, y, z) {
    let best = 0, id = -1;
    for (const s of this.streaks || []) {
      const v = this.streakAt.call({ streaks: [s], seed: this.seed }, x, y, z);
      if (v > best) { best = v; id = s.i; }
    }
    return id;
  }

  /** a cemented spot: hand and shovel hardly get in until a pickaxe loosened it */
  cementedAt(x, y, z) { return this.streakAt(x, y, z) > STREAK.cement; }

  // the foot of the pile you reach first from the claim entrance
  _findStarter() {
    const t = this.terrain, sp = t.spawn || { x: 0.6, z: 10.2 }, mc = t.moundCenter;
    const dx = mc.x - sp.x, dz = mc.z - sp.z, len = Math.hypot(dx, dz) || 1;
    let x = mc.x, z = mc.z;
    for (let d = 0; d < len; d += 0.1) {
      const px = sp.x + (dx / len) * d, pz = sp.z + (dz / len) * d;
      if (t.getBaseHeightAt(px, pz) > 0.35) { x = px; z = pz; break; }
    }
    this.starter = { x, z };
  }

  // 1 inside the starter zone (close to its foot, near the surface), 0 outside
  starterWeight(x, y, z, base) {
    const d = Math.hypot(x - this.starter.x, z - this.starter.z);
    if (d > STARTER.radius + STARTER.fade) return 0;
    const depth = base - y;
    return smoothstep(STARTER.radius + STARTER.fade, STARTER.radius, d) * smoothstep(STARTER.depth + 0.6, STARTER.depth, depth);
  }

  // Per terrain column: top and bottom of the uppermost stone body in the
  // ground. A surface inside it is rigid; only a pickaxe cuts it (the cut
  // lowers stoneTop - see cutStone, saved by the mining system).
  _buildStone() {
    const t = this.terrain, vps = t.vps, n = vps * vps, c = t.cell;
    const top = (this.stoneTop = new Float32Array(n).fill(-Infinity));
    const bot = (this.stoneBot = new Float32Array(n).fill(Infinity));
    const put = (k, y0, y1) => { if (y1 > top[k]) { top[k] = y1; bot[k] = y0; } };
    const cellOf = (x, z) => [Math.round((x - t.x0) / c), Math.round((z - t.z0) / c)];
    const free = (x, z) => Math.hypot(x - this.starter.x, z - this.starter.z) < STARTER.radius * 0.6;   // nothing hard right at the start
    // rock outcrops (surface mask from the mound generator)
    for (let k = 0; k < n; k++) {
      const m = t.rock[k];
      if (m <= 0.45) continue;
      const i = k % vps, j = (k - i) / vps;
      if (free(t.x0 + i * c, t.z0 + j * c)) continue;
      put(k, t.base[k] - (0.45 + (m - 0.45) * 1.2), t.base[k]);
    }
    // lenses: flattened ellipsoids, clipped to the original surface
    for (const l of this.lenses) {
      if (free(l.x, l.z) && l.y > t.getBaseHeightAt(l.x, l.z) - 1.8) continue;
      const ry = l.r * 0.62, [i0, j0] = cellOf(l.x - l.r, l.z - l.r), [i1, j1] = cellOf(l.x + l.r, l.z + l.r);
      for (let j = Math.max(0, j0); j <= Math.min(vps - 1, j1); j++) {
        for (let i = Math.max(0, i0); i <= Math.min(vps - 1, i1); i++) {
          const x = t.x0 + i * c, z = t.z0 + j * c, q = 1 - ((x - l.x) ** 2 + (z - l.z) ** 2) / (l.r * l.r);
          if (q <= 0) continue;
          const k = j * vps + i, h = ry * Math.sqrt(q);
          if (l.y - h >= t.base[k]) continue;              // would float above the pile
          if (free(x, z) && l.y + h > t.base[k] - 1.8) continue;   // never in the starter's first metre and a half
          put(k, l.y - h, Math.min(t.base[k], l.y + h));
        }
      }
    }
    this.stoneTop0 = Float32Array.from(top);              // as generated (the save stores what was cut)
  }

  // a pickaxe took stone off column k down to height y
  cutStone(k, y) {
    if (!(y < this.stoneTop[k])) return;
    this.stoneTop[k] = y > this.stoneBot[k] + 0.005 ? y : -Infinity;   // cut through: no stone left in this column
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
    // phase 9: the camp's apron - imported, compacted fill (a disturbed mix of gravel and packed earth)
    if (this.inFill(x, y, z, base)) return noise3(x * 1.9, y * 3.1, z * 1.9, s + 835) > 0.1 ? MAT.GRAVEL : MAT.COMPACT;
    // a paleochannel's body: rounded stream gravel
    const ch = this.channels ? this.channelAt(x, y, z, k) : null;
    if (ch && ch.w > CHANNEL.gravel) return MAT.GRAVEL;
    // a mineralised streak: cemented gravel (or clay) whatever lay there before
    if (this.streaks && this.streaks.length) {
      const st = this.streakAt(x, y, z);
      if (st > STREAK.cement) return noise3(x * 1.3, y * 2.1, z * 1.3, s + 711) > 0.45 ? MAT.COMPACT : MAT.GRAVEL;
    }
    const sw = this.starterWeight(x, y, z, base);
    // gravel: 3D blobs and bands, much more of it at the bottom of the pile
    // (the starter faces keep most of their skirt as diggable dirt)
    const gn = noise3(x * 0.42, y * 1.05, z * 0.42, s + 501);
    if (gn * 0.62 + smoothstep(0.9, -0.3, y) * 0.55 * (1 - 0.75 * sw) > 0.42 + 0.2 * sw) return MAT.GRAVEL;
    // compact: the inside of the pile and the trodden toe; loose dirt on top
    const cn = noise3(x * 0.28, y * 0.7, z * 0.28, s + 511);
    // (the starter faces: a thicker loose layer, hardly any trodden toe)
    if ((depth - 0.35 - 0.45 * sw) * 0.9 + cn * 0.6 + smoothstep(1.4, 0.3, base) * 0.35 * (1 - 0.85 * sw) > 0.3) return MAT.COMPACT;
    return MAT.DIRT;
  }

  // gold per unit of material, 0..1 (only relative; the finds turn it into mass)
  goldDensityAt(x, y, z, mat, depth) {
    if (mat === MAT.STONE) return 0;
    const s = this.seed, k = this._column(x, z), base = k >= 0 ? this.terrain.base[k] : y + depth;
    // phase 9: the camp's fill holds a trace at most (it was brought in and packed)
    if (this.inFill(x, y, z, base)) return CAMP_FILL.g;
    const region = smoothstep(0.15, 0.75, fbm2(x * 0.085 + 11.3, z * 0.085 - 7.1, s + 401, 3));
    const vn = noise3(x * 0.5, y * 0.9, z * 0.5, s + 405);
    const vein = Math.max(0, 1 - Math.abs(vn) * 7) ** 2 * smoothstep(-0.2, 0.5, noise2(x * 0.2, z * 0.2, s + 407));
    let pocket = 0;
    for (const p of this.pockets) {
      const dx = (x - p.x) / p.rx, dy = (y - p.y) / p.ry, dz = (z - p.z) / p.rz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1) pocket = Math.max(pocket, p.peak * (1 - d2) * (1 - d2));
    }
    // ordinary ground (no "pay layer" at any height any more): neutral grade with regional variation,
    // by material; the upper mountain somewhat poorer (overburden), deeper inside a body a little richer
    const ordinary = GEO.base + GEO.region * (region - 0.5);
    const mount = 1 - (1 - GEO.mountain) * smoothstep(GEO.mountainFrom, GEO.mountainTo, base);
    const deep = 1 - GEO.deep / 2 + GEO.deep * smoothstep(0, 3, depth);
    // a paleochannel: its stretch's grade on top (poor stretches a little, rich ones several times)
    const ch = this.channels ? this.channelAt(x, y, z, k) : null;
    const chG = ch ? ch.w * (CHANNEL.poor + CHANNEL.rich * Math.pow(ch.rich, CHANNEL.richPow)) : 0;
    // REDIST: a small share of the ordinary gold sits in the mineralised streaks instead
    let g = Math.min(1, Math.max(0, (ordinary * GEO.mf[mat] * mount * deep + GEO.vein * vein) * STREAK.redist + chG + pocket + STREAK.g * this.streakAt(x, y, z)));
    // the starter zone: same geology, but held inside a fair band
    const sw = this.starterWeight(x, y, z, y + depth);
    if (sw > 0) g += (Math.min(STARTER.gMax, Math.max(STARTER.gMin, g)) - g) * sw;
    return g;
  }

  // content of resource voxel (column k = vertex i/j, slice iy): writes
  // { cls, massUg, fineUg, mat } into out; cls FIND.NONE when it holds no
  // visible piece (fineUg: the fine gold spread through it)
  voxel(i, j, iy, out) {
    const t = this.terrain, k = j * t.vps + i;
    const x = t.x0 + i * t.cell, z = t.z0 + j * t.cell, y = this.floorY + (iy + 0.5) * VOXEL_H;
    out.cls = FIND.NONE;
    out.massUg = 0;
    out.fineUg = 0;
    const mat = this.materialAt(x, y, z, k);
    out.mat = mat;
    if (mat === MAT.STONE) return out;
    const g = this.goldDensityAt(x, y, z, mat, t.base[k] - y);
    out.g = g;
    out.fineUg = Math.round(FINE_PER_SLICE * g);
    const s = this.seed;
    // in a streak: more pieces (above all flakes), but the nugget / tiny-piece odds
    // only of the ground around it plus a little (no nugget farm behind a pickaxe)
    const st = this.streaks && this.streaks.length ? this.streakAt(x, y, z) : 0;
    out.streak = st;
    if (hash3(i, iy, j, s ^ 0x6a09e667) >= P_FIND * Math.pow(g, 0.85)) return out;
    const u = hash3(i, iy, j, s ^ 0x3c6ef372);
    const gp = st > 0 ? Math.min(g, Math.max(0, g - STREAK.g * st) + STREAK.pieceCap) : g;
    const pN = P_NUGGET * (0.6 + 1.2 * gp * gp), pT = P_TINY * (0.4 + 1.2 * gp), pF = P_FLAKE * (0.6 + g) * (1 + STREAK.flake * st);
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
    out.streak = this.streakAt(x, y, z);
    out.rarity = hash3(Math.floor(x * 4), Math.floor(y * 4), Math.floor(z * 4), this.seed + 991);
    return out;
  }
}
