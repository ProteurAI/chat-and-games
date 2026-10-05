// GoldRush - loose material (phase 7B): what lies on a shovel blade, in a bucket,
// a wheelbarrow or on the classifier's screen reads as loose ground - an uneven
// surface made of a few overlapping mounds (noise on the outline and the height,
// no pole, planar texture coordinates: no ball, no disc, no spiral) and a sparse
// layer of lumps on it: crumbs and clods of earth, small pebbles of gravel, a few
// bigger stones - in the colours of what the batch holds.
//
// Two draws per load: the surface and one instanced mesh of lumps. Both keep a
// fixed size: a new fill only rewrites the vertex buffers (a few hundred
// vertices) and the lump matrices - no geometry is created after construction.
// Purely visual: the gameplay mass stays in the MaterialBatch.

import { noise2 } from "./goldrush-noise.js";

// per MAT index (dirt, compact, gravel, stone): the surface colour, and the lumps -
// shape (x, y, z stretch of a faceted icosahedron), size range (m), how readily they show
export const LOOSE_MAT = [
  { rgb: [0.5, 0.36, 0.24], lump: [1, 0.68, 0.9], size: [0.005, 0.013], weight: 1.0, dark: 0.82 },    // dirt: crumbs
  { rgb: [0.44, 0.31, 0.21], lump: [1, 0.78, 0.94], size: [0.01, 0.022], weight: 0.9, dark: 0.85 },   // compact: earthy clods
  { rgb: [0.52, 0.48, 0.42], lump: [1, 0.72, 0.86], size: [0.005, 0.014], weight: 2.2, dark: 1.05 },  // gravel: many small pebbles
  { rgb: [0.5, 0.48, 0.45], lump: [1, 0.82, 0.7], size: [0.016, 0.034], weight: 0.35, dark: 1.0 },    // stone: a few bigger pieces
];

// the blended colour of a composition (masses per MAT) -> [r, g, b]
export function looseColor(comp, out = [0, 0, 0]) {
  const m = (comp[0] + comp[1] + comp[2] + comp[3]) || 1;
  out[0] = out[1] = out[2] = 0;
  for (let k = 0; k < 4; k++) for (let c = 0; c < 3; c++) out[c] += (LOOSE_MAT[k].rgb[c] * (comp[k] || 0)) / m;
  if (!(comp[0] + comp[1] + comp[2] + comp[3])) out.splice(0, 3, ...LOOSE_MAT[0].rgb);
  return out;
}

const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

export class LooseLoad {
  /**
   * parent: the group the load lives in (its frame: y up, the footprint in x / z).
   * opts: rings / segs of the surface grid, lumps (max instances), map (optional texture,
   * planar), uv (texture repeats per metre), shadow (cast), seed, lumpK (lump size scale),
   * shade (how much darker the thin rim / hollows are than the crests)
   */
  constructor(THREE, parent, { rings = 7, segs = 22, lumps = 40, map = null, uv = 7, shadow = false, seed = 1, roughness = 0.95, lumpK = 1, shade = 0.22 } = {}) {
    this.THREE = THREE;
    this.rings = rings; this.segs = segs; this.max = lumps; this.uvk = uv; this.seed = seed; this.lumpK = lumpK; this.shade = shade;
    const n = 1 + rings * segs;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), uvs = new Float32Array(n * 2);
    const idx = [];
    for (let j = 0; j < segs; j++) idx.push(0, 1 + ((j + 1) % segs), 1 + j);
    for (let i = 1; i < rings; i++) for (let j = 0; j < segs; j++) {
      const a = 1 + (i - 1) * segs + j, b = 1 + (i - 1) * segs + ((j + 1) % segs), c = 1 + i * segs + j, d = 1 + i * segs + ((j + 1) % segs);
      idx.push(a, b, c, b, d, c);
    }
    const g = (this.geo = new THREE.BufferGeometry());
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    g.setIndex(idx);
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: map || null, roughness, metalness: 0 });
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
    this._sig = null;
    this.p = null;
  }

  get visible() { return this.surface.visible; }
  setVisible(v) { this.surface.visible = v; this.lumps.visible = v; }

  // the height of the load at a point of its unit footprint (u, v in -1..1) - 0 at the rim of a pile
  _height(u, v) {
    const p = this.p, s = this.seed + p.seed;
    let lob = 0;
    for (let k = 0; k < p.lobes; k++) {
      // the lobes: the first in the middle, the others around it - a heap poured in several shovels
      const a = hash(s + k * 7.1) * Math.PI * 2, d = k ? 0.3 + 0.32 * hash(s + k * 3.3) : 0.08;
      const cx = Math.cos(a) * d, cz = Math.sin(a) * d, r = k ? 0.42 + 0.22 * hash(s + k * 9.7) : 0.66;
      // a poured cone (the angle of repose), not a dome
      const q = Math.hypot(u - cx, v - cz) / r;
      lob = Math.max(lob, (k ? 0.74 + 0.22 * hash(s + k) : 1) * Math.max(0, 1 - q) ** 1.12);
    }
    const t = Math.min(1, Math.hypot(u, v));
    const rough = 0.13 * noise2(u * 3.1 + s, v * 3.1, 977) + 0.07 * noise2(u * 7.3, v * 7.3 + s, 983) + 0.035 * noise2(u * 15.7 + s, v * 15.7, 989);
    if (p.edge > 0) {
      // a fill meeting a wall: the rim stays at the level, the middle a little heaped
      return p.edge * 0.25 + (1 - p.edge * 0.25) * Math.min(1, lob + 0.15) * (1 - 0.55 * t * t) + rough * 0.6;
    }
    return Math.max(0, Math.min(1.08, lob + rough)) * (1 - t ** 3);
  }

  /**
   * shape it: { rx, rz: footprint half axes (m); h: height of the heap (m); y0: its base;
   * x0, z0: its centre; edge: 0 a pile (falls to y0 at the rim) .. 1 a fill against a wall;
   * lobes 1-4; comp: masses per MAT (colour, lumps); amount 0..1 lump density;
   * seed: the pour; rgb: an own colour (the ground just dug) instead of the composition's;
   * wobble: how ragged the outline is (0.07) }
   */
  set(p) {
    const sig = `${p.wobble || 0}:${p.rgb ? p.rgb.map((c) => c.toFixed(3)).join("/") : ""}:${p.rx.toFixed(4)}:${p.rz.toFixed(4)}:${p.h.toFixed(4)}:${p.y0.toFixed(4)}:${(p.x0 || 0).toFixed(3)}:${(p.z0 || 0).toFixed(3)}:${p.edge || 0}:${p.lobes}:${(p.amount || 0).toFixed(2)}:${p.seed || 0}:${p.comp.map((c) => Math.round(c)).join(",")}`;
    if (sig === this._sig) return false;
    this._sig = sig;
    this.p = { lobes: 1, edge: 0, seed: 0, x0: 0, z0: 0, amount: 1, ...p };
    const P = this.p, R = this.rings, S = this.segs;
    const pos = this.geo.attributes.position.array, col = this.geo.attributes.color.array, uv = this.geo.attributes.uv.array;
    const base = P.rgb ? (this._rgb = P.rgb.slice(0, 3)) : looseColor(P.comp, this._rgb || (this._rgb = [0, 0, 0]));
    const put = (n, u, v) => {
      // a slightly irregular outline, then the height
      const w = 1 + (P.wobble || 0.07) * noise2(Math.atan2(v, u) * 1.6 + P.seed, 3.1, 991) + (P.wobble || 0.07) * 0.5 * noise2(Math.atan2(v, u) * 4.3, P.seed + 1.7, 993);
      const x = P.x0 + u * P.rx * w, z = P.z0 + v * P.rz * w, y = P.y0 + P.h * this._height(u, v);
      pos[n * 3] = x; pos[n * 3 + 1] = y; pos[n * 3 + 2] = z;
      uv[n * 2] = x * this.uvk; uv[n * 2 + 1] = z * this.uvk;
      // moist and darker in the hollows, lighter on the crests; a little mottling
      const k = (1.06 - this.shade + this.shade * this._height(u, v) / 1.08 + 0.08 * noise2(x * 21, z * 21, 997)) * (P.edge > 0 ? 1 : 0.96 + 0.06 * (1 - Math.hypot(u, v)));
      col[n * 3] = base[0] * k; col[n * 3 + 1] = base[1] * k; col[n * 3 + 2] = base[2] * k;
    };
    put(0, 0, 0);
    for (let i = 1; i <= R; i++) for (let j = 0; j < S; j++) {
      const t = i / R, a = (j / S) * Math.PI * 2;
      put(1 + (i - 1) * S + j, Math.cos(a) * t, Math.sin(a) * t);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.attributes.uv.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.geo.computeBoundingSphere();
    this._placeLumps();
    return true;
  }

  // the lumps on the surface: how many follows the visible area and the density asked for;
  // which kind each one is follows the composition (gravel shows its pebbles readily)
  _placeLumps() {
    const P = this.p, L = this.lumps;
    const area = Math.PI * P.rx * P.rz;
    const n = Math.min(this.max, Math.round(this.max * Math.min(1, area / 0.03) * Math.max(0, P.amount)));
    const w = LOOSE_MAT.map((m, k) => (P.comp[k] || 0) * m.weight), wt = w.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < n; i++) {
      // golden-angle spread over the footprint (a little jitter), kept off the very rim
      const a = i * 2.39996 + hash(P.seed + i) * 0.9, t = 0.9 * Math.sqrt((i + 0.5) / Math.max(1, n));
      const u = Math.cos(a) * t, v = Math.sin(a) * t;
      let pick = hash(P.seed * 3 + i * 1.7) * wt, k = 0;
      while (k < 3 && pick > w[k]) { pick -= w[k]; k++; }
      const M = LOOSE_MAT[k], sz = (M.size[0] + (M.size[1] - M.size[0]) * hash(P.seed + i * 5.3) ** 1.6) * this.lumpK;
      const y = P.y0 + P.h * this._height(u, v);
      this._e.set(hash(i * 2.1) * 6, hash(i * 3.7) * 6, hash(i * 5.9) * 6);
      this._q.setFromEuler(this._e);
      this._m.compose(this._v.set(P.x0 + u * P.rx, y + sz * 0.25, P.z0 + v * P.rz), this._q, this._s.set(sz * M.lump[0], sz * M.lump[1], sz * M.lump[2]));
      L.setMatrixAt(i, this._m);
      // its own kind's colour, pulled towards the load's (a clod of this very earth, a pebble a little greyer)
      const vary = (0.82 + 0.3 * hash(P.seed + i * 11.3)) * M.dark, b = this._rgb || M.rgb, mix = k === 2 || k === 3 ? 0.35 : 0.6;
      this._c.setRGB((M.rgb[0] * (1 - mix) + b[0] * mix) * vary, (M.rgb[1] * (1 - mix) + b[1] * mix) * vary, (M.rgb[2] * (1 - mix) + b[2] * mix) * vary);
      L.setColorAt(i, this._c);
    }
    L.count = n;
    L.instanceMatrix.needsUpdate = true;
    if (L.instanceColor) L.instanceColor.needsUpdate = true;
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
