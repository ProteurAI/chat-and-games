// GoldRush - loose material in its container (phase 8): what lies on a shovel
// blade, in a bucket, a wheelbarrow tray or on the classifier's screen is drawn
// by the SHAPE OF ITS CONTAINER - not one radial heap for everything (7B: the
// same polar mound read as a ball on the blade, a sausage in the tray, a round
// dome on the screen).
//
//   GridLoad   a fixed rectangular grid over the container's opening; a shape
//              function gives every vertex a height and whether material is
//              there (vertex alpha + alphaTest: ragged, irregular edges, no
//              disc outline); one instanced mesh of lumps sits only on
//              visible material. Two draws per load, fixed buffers: a new
//              fill rewrites a few hundred vertices and the lump matrices
//   shapes     bladeShape   a shallow layer conforming to the dished blade,
//                           sliding to the tip on release
//              bucketShape  a wall-constrained fill, nearly level, clumps
//              trayShape    the inside of the barrow's tapered tray: a local
//                           asymmetric pile, spreading along the floor, at
//                           last a broad load held by the walls
//              screenShape  a shallow layer spread across the classifier's
//                           screen; the fines go, holes open, coarse pieces
//                           remain
//
// Material identity (LOOSE_MAT): dirt fine with small crumbs, compact earth in
// crumbly clods, gravel many small stones, stone a few big angular pieces.
// Purely visual: the gameplay mass stays in the MaterialBatch.

import { noise2 } from "./goldrush-noise.js";

// per MAT index (dirt, compact, gravel, stone): the surface colour, and the lumps -
// shape (x, y, z stretch of a faceted icosahedron), size range (m), how readily they show,
// a darkness factor and how much finer / coarser the surface relief is
export const LOOSE_MAT = [
  { rgb: [0.5, 0.36, 0.24], lump: [1, 0.68, 0.9], size: [0.005, 0.012], weight: 1.0, dark: 0.82, grain: 1.0 },    // dirt: fine, small crumbs
  { rgb: [0.44, 0.31, 0.21], lump: [1, 0.8, 0.94], size: [0.012, 0.026], weight: 1.1, dark: 0.86, grain: 1.6 },   // compact: crumbly clods
  { rgb: [0.52, 0.48, 0.42], lump: [1, 0.72, 0.86], size: [0.005, 0.014], weight: 2.6, dark: 1.05, grain: 0.7 },  // gravel: many small stones
  { rgb: [0.5, 0.48, 0.45], lump: [1, 0.78, 0.66], size: [0.02, 0.04], weight: 0.4, dark: 1.0, grain: 1.2 },      // stone: few big angular pieces
];

// the blended colour of a composition (masses per MAT) -> [r, g, b]
const LOOSE_DENS = [1.3, 1.6, 1.75, 2.6];                     // g / ml loose (dirt, compact clods, gravel, stone)
export function looseColor(comp, out = [0, 0, 0]) {
  const m = (comp[0] + comp[1] + comp[2] + comp[3]) || 1;
  out[0] = out[1] = out[2] = 0;
  // (by volume: a stone weighs twice a crumb of soil, it does not cover twice the surface)
  let vs = 0;
  for (let k = 0; k < 4; k++) vs += (comp[k] || 0) / LOOSE_DENS[k];
  for (let k = 0; k < 4; k++) for (let c = 0; c < 3; c++) out[c] += (LOOSE_MAT[k].rgb[c] * ((comp[k] || 0) / LOOSE_DENS[k])) / (vs || m);
  if (!(comp[0] + comp[1] + comp[2] + comp[3])) out.splice(0, 3, ...LOOSE_MAT[0].rgb);
  return out;
}

const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
const sn = noise2;                                                   // signed value noise, -1..1 (noise2 already is)
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// how coarse a composition is (gravel + stone share) and its relief scale
function grainOf(comp) {
  const m = (comp[0] + comp[1] + comp[2] + comp[3]) || 1;
  let g = 0;
  for (let k = 0; k < 4; k++) g += LOOSE_MAT[k].grain * (comp[k] || 0) / m;
  return { coarse: ((comp[2] || 0) + (comp[3] || 0)) / m, grain: g || 1 };
}

// a few clumps / clods on a surface: small bumps at stable places (relief, not lumps)
function clumps(x, z, seed, n, r, amp) {
  let h = 0;
  for (let i = 0; i < n; i++) {
    const cx = (hash(seed + i * 3.1) - 0.5) * 2, cz = (hash(seed + i * 5.7) - 0.5) * 2, rr = r * (0.6 + 0.8 * hash(seed + i * 7.3));
    const d2 = ((x - cx) ** 2 + (z - cz) ** 2) / (rr * rr);
    if (d2 < 1) h += amp * (0.5 + hash(seed + i * 9.1)) * (1 - d2) * (1 - d2);
  }
  return h;
}

export class GridLoad {
  /**
   * parent: the group the load lives in (its frame: y up). opts: nx / nz grid
   * vertices over x0..x1 / z0..z1 (the container's opening), lumps (max
   * instances), map (texture, planar), uv (repeats per metre), shadow, seed,
   * roughness, lumpK (lump size scale)
   */
  constructor(THREE, parent, { nx = 15, nz = 15, x0 = -0.5, x1 = 0.5, z0 = -0.5, z1 = 0.5, lumps = 40, map = null, uv = 7, shadow = false, seed = 1, roughness = 0.95, lumpK = 1 } = {}) {
    this.THREE = THREE;
    this.nx = nx; this.nz = nz; this.x0 = x0; this.x1 = x1; this.z0 = z0; this.z1 = z1;
    this.max = lumps; this.uvk = uv; this.seed = seed; this.lumpK = lumpK;
    const n = nx * nz;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 4), uvs = new Float32Array(n * 2);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const v = j * nx + i, x = x0 + ((x1 - x0) * i) / (nx - 1), z = z0 + ((z1 - z0) * j) / (nz - 1);
      pos[v * 3] = x; pos[v * 3 + 2] = z;
      uvs[v * 2] = x * uv; uvs[v * 2 + 1] = z * uv;
    }
    const idx = [];
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      // alternate the diagonals: no visible grain in one direction
      if ((i + j) % 2) idx.push(a, c, b, b, c, d); else idx.push(a, c, d, a, d, b);
    }
    const g = (this.geo = new THREE.BufferGeometry());
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 4));
    g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    g.setIndex(idx);
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: map || null, roughness, metalness: 0, alphaTest: 0.5, side: THREE.DoubleSide });
    this.surface = new THREE.Mesh(g, this.mat);
    this.surface.receiveShadow = true;
    this.surface.castShadow = shadow;
    this.surface.visible = false;
    this.surface.userData.noMerge = true;
    parent.add(this.surface);
    this.lumpGeo = new THREE.IcosahedronGeometry(1, 0);
    this.lumpMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });
    this.lumps = new THREE.InstancedMesh(this.lumpGeo, this.lumpMat, lumps);
    this.lumps.count = 0;
    this.lumps.frustumCulled = false;
    this.lumps.castShadow = shadow;
    this.lumps.visible = false;
    this.lumps.userData.noMerge = true;
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < lumps; i++) this.lumps.setColorAt(i, white);
    parent.add(this.lumps);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._v = new THREE.Vector3(); this._s = new THREE.Vector3(); this._c = new THREE.Color();
    this._o = { y: 0, a: 0, t: 0, l: -1 };
    this._sig = null;
    this._rgb = [0, 0, 0];
    this.stats = { visibleVerts: 0, maxY: 0, lumps: 0 };
  }

  get visible() { return this.surface.visible; }
  setVisible(v) { this.surface.visible = v; this.lumps.visible = v; }

  /**
   * shape it: sig - a string that changes when the fill changes (unchanged: nothing to do);
   * shape(x, z, out) sets out.y (height), out.a (material there 0..1) and out.t (its thickness, m),
   * optionally out.l (lumps may lie here 0..1 - default: where material is, at least 3 mm thick);
   * comp: masses per MAT (colour, lumps); amount 0..1 lump density; rgb: an own colour
   */
  set(sig, shape, comp, { amount = 1, rgb = null, tMax = 0.05 } = {}) {
    if (sig === this._sig) return false;
    this._sig = sig;
    const pos = this.geo.attributes.position.array, col = this.geo.attributes.color.array, o = this._o;
    const base = rgb ? (this._rgb = rgb.slice(0, 3)) : looseColor(comp, this._rgb);
    const { grain } = grainOf(comp);
    let vis = 0, maxY = -Infinity, lumpCover = 0;
    for (let v = 0, n = this.nx * this.nz; v < n; v++) {
      const x = pos[v * 3], z = pos[v * 3 + 2];
      o.y = 0; o.a = 0; o.t = 0; o.l = -1;
      shape(x, z, o);
      pos[v * 3 + 1] = o.y;
      if ((o.l >= 0 ? o.l : o.a) >= 0.5) lumpCover++;
      // moist and darker in the hollows and where it is thin, lighter on crests; fine mottling by grain
      const k = (0.71 + 0.3 * clamp(o.t / tMax, 0, 1) + 0.09 * sn(x * 31 / grain, z * 31 / grain, 997)) * (0.86 + 0.07 * sn(x * 9, z * 9, 991));
      col[v * 4] = base[0] * k; col[v * 4 + 1] = base[1] * k; col[v * 4 + 2] = base[2] * k; col[v * 4 + 3] = o.a;
      if (o.a >= 0.5) { vis++; if (o.y > maxY) maxY = o.y; }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.geo.computeBoundingSphere();
    this.stats.visibleVerts = vis;
    this.stats.maxY = vis ? maxY : 0;
    this._placeLumps(shape, comp, amount, lumpCover / (this.nx * this.nz));
    return true;
  }

  // the lumps: only on visible material; how many follows the covered area and the density asked
  // for, which kind each one is the composition (gravel shows its stones readily)
  _placeLumps(shape, comp, amount, cover) {
    const L = this.lumps, o = this._o, b = this._rgb;
    const want = Math.min(this.max, Math.round(this.max * Math.min(1, cover * 1.6) * clamp(amount, 0, 1)));
    const w = LOOSE_MAT.map((m, k) => (comp[k] || 0) * m.weight), wt = w.reduce((a, c) => a + c, 0) || 1;
    let n = 0;
    for (let i = 0; i < this.max * 5 && n < want; i++) {
      const x = this.x0 + (this.x1 - this.x0) * hash(this.seed * 13 + i * 1.37), z = this.z0 + (this.z1 - this.z0) * hash(this.seed * 17 + i * 2.11);
      o.y = 0; o.a = 0; o.t = 0; o.l = -1;
      shape(x, z, o);
      if (o.l >= 0 ? o.l < 0.5 : (o.a < 0.75 || o.t < 0.003)) continue;
      let pick = hash(this.seed * 3 + i * 1.7) * wt, k = 0;
      while (k < 3 && pick > w[k]) { pick -= w[k]; k++; }
      const M = LOOSE_MAT[k], sz = (M.size[0] + (M.size[1] - M.size[0]) * hash(this.seed + i * 5.3) ** 1.7) * this.lumpK;
      this._e.set(hash(i * 2.1) * 6, hash(i * 3.7) * 6, hash(i * 5.9) * 6);
      this._q.setFromEuler(this._e);
      this._m.compose(this._v.set(x, o.y + sz * 0.22, z), this._q, this._s.set(sz * M.lump[0], sz * M.lump[1], sz * M.lump[2]));
      L.setMatrixAt(n, this._m);
      // its own kind's colour, pulled towards the load's (a clod of this very earth, a stone a little greyer)
      const vary = (0.8 + 0.32 * hash(this.seed + i * 11.3)) * M.dark, mix = k >= 2 ? 0.3 : 0.6;
      this._c.setRGB((M.rgb[0] * (1 - mix) + b[0] * mix) * vary, (M.rgb[1] * (1 - mix) + b[1] * mix) * vary, (M.rgb[2] * (1 - mix) + b[2] * mix) * vary);
      L.setColorAt(n, this._c);
      n++;
    }
    L.count = n;
    L.instanceMatrix.needsUpdate = true;
    if (L.instanceColor) L.instanceColor.needsUpdate = true;
    this.stats.lumps = n;
  }

  // GPU warm-up: draw both once even while empty (no first-look upload later)
  warm(on) {
    if (on) { this._warm = [this.surface.visible, this.lumps.visible, this.lumps.count]; this.setVisible(true); this.lumps.count = Math.max(1, this.lumps.count); }
    else if (this._warm) { this.surface.visible = this._warm[0]; this.lumps.visible = this._warm[1]; this.lumps.count = this._warm[2]; this._warm = null; }
  }

  dispose() {
    this.surface.removeFromParent();
    this.lumps.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
    this.lumpGeo.dispose();
    this.lumpMat.dispose();
    this.lumps.dispose();
  }
}

// ---------------------------------------------------------------- the containers

/**
 * The shovel blade (goldrush-toolmodels.js, head frame): a round-point outline
 * W = 0.122 wide, L = 0.29 long from the heel at z = -0.03 to the tip, dished
 * across and bent up towards the tip. load 0..1, slide 0..1 (towards the tip and
 * off), lagX / lagZ (m), grain from the composition.
 */
export const BLADE = { W: 0.122, L: 0.29, z0: -0.03 };
export function bladeShape(load, slide, lagX, lagZ, comp, seed = 5) {
  const B = BLADE, { grain } = grainOf(comp), k = clamp(load, 0, 1);
  const tMax = (0.012 + 0.032 * k) * (1 - 0.55 * slide);
  const sc = 0.42 + 0.4 * slide;                                      // where along the blade the layer is thickest
  return (x, z, o) => {
    const s = -(z - B.z0) / B.L;                                       // 0 heel .. 1 tip
    const w = s < 0.55 ? B.W * (1 - 0.02 * s / 0.55) : B.W * 0.98 * Math.sqrt(Math.max(0, 1 - ((s - 0.55) / 0.45) ** 2));
    const yb = 0.0035 + 0.026 * (1 - (x / B.W) ** 2) - 0.035 * clamp(s, 0, 1) ** 2;
    if (s < 0 || s > 1 || Math.abs(x) >= w) { o.y = yb - 0.004; o.a = 0; o.t = 0; return; }
    const ax = Math.abs(x - lagX) / (w * 0.9), along = (s - sc - lagZ / B.L) / (0.42 - 0.12 * slide);
    let t = tMax * Math.max(0, 1 - ax ** 2.2) * Math.max(0, 1 - along * along);
    t *= 0.7 + 0.45 * noise2(x * 40 / grain + seed, z * 40 / grain, 977) + clumps(x / B.W, s * 2 - 1, seed, 4, 0.3, 0.25);
    t += 0.005 * sn(x * 90, z * 90, 983) * k;
    o.t = t; o.a = smooth(0.0016, 0.0032, t); o.y = yb + Math.max(0, t) + 0.0015;
  };
}

/**
 * The bucket (goldrush-processmodels.js BUCKET, bucket frame): fill level h
 * (m above the floor), the wall at radius r(y). Nearly level, a little higher
 * at the wall (it creeps up), small clumps - no cone however full.
 */
export function bucketShape(h, rAt, k, comp, seed = 11) {
  const { grain } = grainOf(comp);
  const lvl = Math.max(0.012, h);
  return (x, z, o) => {
    const rho = Math.hypot(x, z), rw = rAt(lvl);
    let y = lvl + 0.006 * (rho / rw) ** 4 + 0.008 * sn(x * 22 / grain + seed, z * 22 / grain, 977) + 0.004 * sn(x * 61, z * 61, 983)
      + clumps(x / rw, z / rw, seed, 6, 0.32, 0.007 + 0.004 * k);
    y = Math.max(0.006, y);
    o.y = y; o.t = y - 0.004; o.a = rho < rAt(y) - 0.004 ? 1 : 0;
  };
}

/**
 * The barrow's tray (goldrush-mechmodels.js BARROW, barrow frame): floor
 * 0.44 x 0.57 m at y = floorY, opening 0.66 x 0.89 m at floorY + trayD, the
 * front wall sloped. f 0..1 of its capacity: a little is an asymmetric pile
 * near the front where it was tipped in; it spreads along the floor, its base
 * rises; full, a broad irregular load held by the walls, heaped a hand's
 * breadth over the rim (never a cone, a sausage or a loaf).
 */
export const TRAY = { fy: 0.33, d: 0.3, w0: 0.218, w1: 0.33, zf0: 0.323, zf1: 0.134, zb0: 0.897, zb1: 1.02 };
export function trayWallY(x, z) {
  const T = TRAY;
  const t = Math.max((Math.abs(x) - T.w0) / (T.w1 - T.w0), (T.zf0 - z) / (T.zf0 - T.zf1), (z - T.zb0) / (T.zb1 - T.zb0));
  return t > 1.0001 ? Infinity : T.fy + T.d * Math.max(0, t);
}
export function trayShape(f, comp, seed = 31) {
  const T = TRAY, { grain, coarse } = grainOf(comp), F = clamp(f, 0, 1), F7 = F ** 0.7;
  const level = T.fy + T.d * 0.9 * smooth(0.14, 1, F);                 // the bed rises once it reaches the walls
  const cx = 0.07 * (1 - F) * (hash(seed) > 0.5 ? 1 : -1), cz = 0.5 + 0.08 * (1 - F);   // tipped in near the front, to one side
  const ax = 0.1 + 0.3 * F7, az = 0.13 + 0.44 * F7;                    // the pile's half extents (full: past the walls - no cliff inside)
  const p = 2 + 2.6 * F;                                              // round at first, then the tray's own shape
  const Hm = (0.045 + 0.11 * F ** 0.8) * (1 - 0.25 * coarse);          // how far it heaps over its bed (coarse stuff lies flatter)
  const q = 1.3 + 1.3 * F;                                            // a flatter, broader top the fuller it is
  return (x, z, o) => {
    const wy = trayWallY(x, z);
    if (wy === Infinity) { o.y = T.fy + T.d; o.a = 0; o.t = 0; return; }
    const ang = Math.atan2(z - cz, x - cx);
    const rr = 1 + (0.16 * sn(ang * 1.7 + seed, F * 3, 991) + 0.08 * sn(ang * 4.3, seed, 993)) * (1 - 0.6 * F);   // a ragged outline (full: held by the walls)
    const dn = (Math.abs(x - cx) ** p / ax ** p + Math.abs(z - cz) ** p / az ** p) ** (1 / p) / rr;
    const mound = dn < 1 ? Hm * (1 - dn ** q) : 0;
    const relief = (0.016 * sn(x * 9 / grain + seed, z * 9 / grain, 977) + 0.009 * sn(x * 24 / grain, z * 24 / grain + seed, 983)) * (0.4 + 0.6 * Math.min(1, F * 3)) - 0.006
      + clumps((x - cx) / Math.max(0.1, ax), (z - cz) / Math.max(0.1, az), seed, 7, 0.28, 0.012 + 0.012 * F);
    let y = (F > 0.14 ? level : T.fy) + mound + relief * (mound > 0 || F > 0.3 ? 1 : 0);
    // at the opening's edge it can be no higher than the rim (it would hang over it)
    const ex = Math.abs(x) / T.w1, ez = Math.max((T.zf0 - z) / (T.zf0 - T.zf1), (z - T.zb0) / (T.zb1 - T.zb0));
    const e = Math.max(ex, ez);
    y = Math.min(y, T.fy + T.d + 0.012 + 0.3 * (1 - smooth(0.8, 1, e)));
    // nothing sits below the wall: there the steel is
    const t = y - wy;
    o.t = Math.max(0, y - T.fy);
    o.a = smooth(0.002, 0.006, t);
    o.y = Math.max(y, wy + 0.001);
  };
}

/**
 * The classifier's screen (goldrush-processmodels.js, the frame): a shallow
 * layer spread across 0.82 x 0.64 m. p 0..1 how far it is shaken: the fines
 * go - thinner, holes opening where it was thin; vol 0..1 how much was put
 * on. coarse: what the screen keeps (lumps, drawn by the GridLoad).
 */
export const SCREEN = { hx: 0.41, hz: 0.32, y: 0.015 };
export function screenShape(p, vol, comp, seed = 7) {
  const S = SCREEN, { grain } = grainOf(comp), P = clamp(p, 0, 1);
  // (10 l over the 0.52 m2 screen is ~2 cm: spread out nearly to the frame, a thin layer - never a cake in the middle)
  const tBase = (0.013 + 0.02 * clamp(vol, 0, 1)) * (1 - 0.93 * P);
  const ax = S.hx * (0.76 + 0.1 * vol), az = S.hz * (0.74 + 0.1 * vol);
  return (x, z, o) => {
    const ang = Math.atan2(z / az, x / ax);
    const rr = 1 + 0.14 * sn(ang * 1.9 + seed, 1.3, 991) + 0.07 * sn(ang * 5.1, seed, 993);
    const dn = ((Math.abs(x) / ax) ** 3 + (Math.abs(z) / az) ** 3) ** (1 / 3) / rr;
    let t = dn < 1 ? tBase * (1 - dn ** 3) ** 0.7 : 0;
    t *= 0.62 + 0.55 * noise2(x * 14 / grain + seed, z * 14 / grain, 977) + clumps(x / S.hx, z / S.hz, seed, 8, 0.22, 0.35 * (1 - P));
    // the fines going through: holes open where it is thinnest
    const hole = 0.0025 + 0.012 * P * (0.5 + 0.5 * sn(x * 21 + seed, z * 21, 989));
    o.t = t; o.a = smooth(hole, hole + 0.002, t); o.y = S.y + 0.002 + Math.max(0, t);
    // what the screen keeps lies where the load was, on the wire once the fines are gone
    o.l = dn < 0.95 ? 1 : 0;
  };
}
