// GoldRush - the camp as a working place (phase 7A world art pass 1): worn paths
// between its places, wheelbarrow ruts towards the loading ramp, and what a
// working claim collects - sacks, spare planks, a coiled hose, picked stones,
// an old wheel rim, duckboards and a drain at the wash place, a heap of washed
// sand. Cosmetic only: no game state, no colliders in anybody's way (all of it
// is flat or stands against a wall / the fence). Everything is static and
// merged per material - a handful of draw calls for the whole dressing.

import { mergeStatic } from "./goldrush-merge.js";
import { mulberry32, noise2 } from "./goldrush-noise.js";

// the camp's places (paths run between them; outside the diggable square, so a
// dug pile never leaves a path hanging in the air)
export const CAMP = {
  shop: { x: -18.6, z: 9.7 }, assay: { x: -13.2, z: 9.4 }, hub: { x: -15.7, z: 9.0 },
  wash: { x: -15.9, z: 4.3 }, post: { x: -22.4, z: -2.3 }, rampFoot: { x: -20.85, z: -9.9 },
};
// polylines [x, z] with a width (m) and a look: "path" (trodden), "barrow" (path + one wheel rut)
export const PATHS = [
  { look: "path", w: 1.15, pts: [[-18.6, 9.7], [-17.0, 9.55], [-15.4, 9.35], [-13.3, 9.45]] },             // shop - gold buyer
  { look: "path", w: 1.0, pts: [[-15.6, 9.1], [-15.95, 7.2], [-16.0, 5.6], [-15.85, 4.35]] },              // camp - wash place
  { look: "path", w: 0.95, pts: [[-16.4, 4.6], [-18.4, 4.75], [-21.0, 3.8], [-22.55, 1.2], [-22.5, -2.0]] }, // wash place - control post (west of the tank)
  { look: "barrow", w: 1.05, y: 0.108, pts: [[-15.6, -8.55], [-17.2, -9.1], [-19.4, -9.6], [-20.85, -9.95]] }, // the mine - the loading ramp's foot (barrow ruts, on Zone B's slab)
  { look: "path", w: 1.2, pts: [[-13.0, 10.3], [-9.0, 11.3], [-5.0, 12.4], [-1.6, 14.2]] },               // camp - the gate track
  // phase 8: the claim as one working place - the barrow track from the foot of the pile to the wash
  // place, and the walk from the gold buyer down to the mine
  { look: "barrow", w: 1.05, pts: [[-7.9, 0.3], [-10.4, 2.0], [-12.9, 3.5], [-15.0, 4.4]] },              // the mine - the wash place
  { look: "path", w: 1.05, pts: [[-12.5, 8.9], [-11.4, 6.4], [-9.9, 3.6], [-8.3, 1.2]] },                // gold buyer - the mine
];

// a canvas atlas: left half trodden soil, right half the same with a wheel rut and
// boot prints; soft, frayed edges (alpha) so nothing ends in a straight line
function pathTexture(THREE) {
  const W = 256, H = 256, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d"), img = g.createImageData(W, H), rng = mulberry32(91);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const half = x < 128 ? 0 : 1, u = (x % 128) / 127, i = (y * W + x) * 4;
    const n = noise2(x * 0.09, y * 0.09, 7) * 0.5 + noise2(x * 0.31, y * 0.31, 11) * 0.3;
    const edge = Math.min(u, 1 - u) * 2;                         // 0 at the sides, 1 in the middle
    let a = Math.max(0, Math.min(1, (edge - 0.12 + n * 0.28) * 2.2));
    let v = 124 + n * 24;                                        // packed, trodden soil: a little darker and greyer than the loose sand
    if (half === 1) {
      const rut = Math.exp(-(((u - 0.5) / 0.055) ** 2));         // the barrow's single wheel in the middle
      v -= rut * 40;
      a = Math.min(1, a + rut * 0.35);
    }
    img.data[i] = v; img.data[i + 1] = v * 0.91; img.data[i + 2] = v * 0.8; img.data[i + 3] = Math.round(a * 205);
  }
  g.putImageData(img, 0, 0);
  // boot prints along both halves (darker ovals, staggered left / right)
  for (let k = 0; k < 18; k++) {
    for (const half of [0, 1]) {
      const y = (k / 18) * H + rng() * 6, side = k % 2 ? 1 : -1, x = half * 128 + 64 + side * (18 + rng() * 6);
      g.fillStyle = `rgba(92,74,52,${0.16 + rng() * 0.1})`;
      g.beginPath(); g.ellipse(x, y, 4.5, 8, (rng() - 0.5) * 0.4, 0, Math.PI * 2); g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// one ribbon per polyline (quads along it, u across 0..0.5 or 0.5..1, v by the metre)
function ribbons(THREE, paths, y0) {
  const pos = [], uv = [], nor = [], idx = [];
  for (const p of paths) {
    const u0 = p.look === "barrow" ? 0.5 : 0, u1 = u0 + 0.5, hw = p.w / 2, y = p.y != null ? p.y : y0;
    let along = 0, base = pos.length / 3;
    const pts = p.pts;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      if (i > 0) along += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      const nx = -dz, nz = dx, w = hw * (0.92 + 0.16 * Math.sin(i * 2.1));
      pos.push(pts[i][0] + nx * w, y, pts[i][1] + nz * w, pts[i][0] - nx * w, y, pts[i][1] - nz * w);
      uv.push(u0 + 0.003, along / 2.2, u1 - 0.003, along / 2.2);
      nor.push(0, 1, 0, 0, 1, 0);
      if (i > 0) { const q = base + (i - 1) * 2; idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3); }      // counter-clockwise seen from above
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export class CampDressing {
  constructor(THREE, scene, { woodTex = null } = {}) {
    this.THREE = THREE;
    this.group = new THREE.Group();
    this.group.name = "goldrush-camp-dressing";
    scene.add(this.group);
    this.geos = []; this.mats = []; this.texs = [];
    const geo = (g) => { this.geos.push(g); return g; };
    const mat = (m) => { this.mats.push(m); return m; };
    // ---- paths (one draw)
    this.pathTex = pathTexture(THREE);
    this.texs.push(this.pathTex);
    const pathMat = mat(new THREE.MeshStandardMaterial({ map: this.pathTex, transparent: true, depthWrite: false, roughness: 0.97,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
    this.paths = new THREE.Mesh(geo(ribbons(THREE, PATHS, 0.006)), pathMat);
    this.paths.name = "camp-paths";
    this.paths.renderOrder = 1;
    this.paths.receiveShadow = true;
    this.group.add(this.paths);

    // ---- props: built from a few shared shapes, then merged per material
    const M = {
      wood: mat(new THREE.MeshStandardMaterial({ map: woodTex, color: 0xb08a62, roughness: 0.9 })),
      wetWood: mat(new THREE.MeshStandardMaterial({ map: woodTex, color: 0x5e4836, roughness: 0.78 })),
      burlap: mat(new THREE.MeshStandardMaterial({ color: 0xa08660, roughness: 1 })),
      rubber: mat(new THREE.MeshStandardMaterial({ color: 0x2e3530, roughness: 0.7 })),
      metal: mat(new THREE.MeshStandardMaterial({ color: 0x7c7f80, roughness: 0.6, metalness: 0.4 })),
      rust: mat(new THREE.MeshStandardMaterial({ color: 0x86522f, roughness: 0.8, metalness: 0.25 })),
      stone: mat(new THREE.MeshStandardMaterial({ color: 0x7f7568, roughness: 0.86 })),         // washed cobbles (phase 8: no white facets)
      sand: mat(new THREE.MeshStandardMaterial({ color: 0x9c8a72, roughness: 0.96 })),
    };
    this.M = M;
    const box = geo(new THREE.BoxGeometry(1, 1, 1)), cyl = geo(new THREE.CylinderGeometry(1, 1, 1, 12)), ico = geo(new THREE.IcosahedronGeometry(1, 1));
    // a washed stone: rounded, a little lumpy - never a crisp polyhedron
    { const p = ico.attributes.position; for (let q = 0; q < p.count; q++) { const x = p.getX(q), y = p.getY(q), z = p.getZ(q), k = 1 + 0.16 * noise2(x * 1.7 + 3, z * 1.7 - y, 21); p.setXYZ(q, x * k, y * k * 0.82, z * k); } ico.computeVertexNormals(); }
    const blob = geo(new THREE.IcosahedronGeometry(1, 2));          // a smooth low heap (squashed)
    { const p = blob.attributes.position; for (let q = 0; q < p.count; q++) { const y = p.getY(q), k = 1 + 0.12 * noise2(p.getX(q) * 2.3, p.getZ(q) * 2.3, 5); p.setXYZ(q, p.getX(q) * k, Math.max(0, y) * k, p.getZ(q) * k); } blob.computeVertexNormals(); }
    const sack = geo(new THREE.LatheGeometry([[0, 0], [0.2, 0.01], [0.24, 0.12], [0.23, 0.3], [0.17, 0.42], [0.09, 0.47], [0.02, 0.5]].map(([x, y]) => new THREE.Vector2(x, y)), 10));
    const ring = geo(new THREE.TorusGeometry(1, 0.08, 6, 20));
    const parts = [];
    const add = (g, m, x, y, z, sx, sy, sz, ry = 0, rx = 0, rz = 0) => {
      const o = new THREE.Mesh(g, m);
      o.position.set(x, y, z); o.scale.set(sx, sy, sz); o.rotation.set(rx, ry, rz);
      o.castShadow = true; o.receiveShadow = true;
      this.group.add(o); parts.push(o);
      return o;
    };
    const rng = mulberry32(7741);
    // by the shed (-18.2, 13.2): sacks against its west wall, a wheel rim leaning on it, an old bucket upside down
    for (const [x, z, s, r] of [[-20.6, 12.3, 1, 0.3], [-20.62, 12.85, 0.9, 1.2], [-20.88, 12.56, 0.82, 2.1]]) add(sack, M.burlap, x, 0, z, s, s * (0.92 + rng() * 0.1), s, r, 0.05, (rng() - 0.5) * 0.12);
    add(ring, M.rust, -20.44, 0.35, 13.95, 0.34, 0.34, 0.34, Math.PI / 2, 0, 0.12);
    add(cyl, M.metal, -20.55, 0.14, 11.85, 0.13, 0.27, 0.13);
    // spare planks by the wash place: two layers on two short bearers
    for (const z of [6.3, 7.6]) add(box, M.wood, -18.6, 0.035, z, 0.95, 0.07, 0.09);
    for (let k = 0; k < 7; k++) { const layer = k < 4 ? 0 : 1, x = -18.6 + ((k < 4 ? k : k - 4) - (layer ? 1 : 1.5)) * 0.215; add(box, M.wood, x + (rng() - 0.5) * 0.03, 0.09 + layer * 0.042, 6.95 + (rng() - 0.5) * 0.08, 0.2, 0.04, 1.9, (rng() - 0.5) * 0.04); }
    // the hose: a coil by the tank's foot (the tank: -19.5, 1.8)
    for (let k = 0; k < 3; k++) add(ring, M.rubber, -18.05, 0.03 + k * 0.035, 3.05, 0.3 - k * 0.025, 0.3 - k * 0.025, 0.3 - k * 0.025, 0, Math.PI / 2);
    // picked stones: a heap next to the classifier (-16.95, 4.8), a couple of small piles by the pile's foot
    const pile = (cx, cz, n, r, s0) => { for (let k = 0; k < n; k++) { const a = k * 2.4, d = r * Math.sqrt((k + 0.5) / n), s = s0 * (0.6 + rng() * 0.7); add(ico, M.stone, cx + Math.cos(a) * d, s * 0.55 + (n - k) / n * s0 * 0.9, cz + Math.sin(a) * d, s, s * 0.7, s * 0.85, rng() * 6, rng(), rng()); } };
    pile(-17.85, 5.45, 14, 0.38, 0.075);
    pile(-15.55, 0.95, 9, 0.32, 0.07);
    pile(-23.1, 6.8, 8, 0.3, 0.08);
    // wash place: duckboards where you stand to pan and to sieve (wet, dark), the drain
    // stones, a low heap of washed sand south of the trough (what the washing leaves)
    for (const [x, z, n] of [[-16.08, 2.05, 5], [-15.85, 4.8, 4]]) {
      for (let k = 0; k < n; k++) add(box, M.wetWood, x, 0.025, z - (n - 1) * 0.11 + k * 0.22, 0.75, 0.035, 0.17, 0.02 * (k - 2));
      for (const dx of [-0.3, 0.3]) add(box, M.wetWood, x + dx, 0.006, z, 0.06, 0.012, n * 0.22);
    }
    for (let k = 0; k < 7; k++) { const t = k / 6, x = -17.25 + t * 0.2, z = 1.05 - t * 1.9, s = 0.05 + rng() * 0.035; add(ico, M.stone, x + (k % 2 ? 0.18 : -0.18), s * 0.5, z, s, s * 0.6, s, rng() * 6); }
    for (const [dx, dz, s, h] of [[0, 0, 0.42, 0.13], [0.3, 0.18, 0.28, 0.09], [-0.22, 0.24, 0.24, 0.07]]) add(blob, M.sand, -16.15 + dx, -0.01, 0.5 + dz, s * 1.25, h, s, rng() * 6);
    this.merged = mergeStatic(THREE, this.group, parts);
    for (const p of parts) if (!p.visible) this.group.remove(p);
    // the drain: a wet strip from the trough's south end away from the camp (one more draw, glossy, frayed edges)
    const drainMat = mat(new THREE.MeshStandardMaterial({ map: this.pathTex, color: 0x5e4836, roughness: 0.3, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -3 }));
    this.drain = new THREE.Mesh(geo(ribbons(THREE, [{ look: "path", w: 0.34, pts: [[-17.0, 1.25], [-17.05, 0.4], [-16.95, -0.4], [-17.1, -0.9]] }], 0.008)), drainMat);
    this.drain.renderOrder = 1;
    this.drain.name = "camp-drain";
    this.drain.receiveShadow = true;
    this.group.add(this.drain);
  }

  dispose(scene) {
    scene.remove(this.group);
    for (const m of this.merged) m.geometry.dispose();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.texs) t.dispose();
  }
}
