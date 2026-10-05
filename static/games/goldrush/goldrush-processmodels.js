// GoldRush - the processing kit, modelled here from simple shapes (no
// external asset): a galvanised bucket, a steel gold pan, the wash trough
// fed from the camp's water tank, and a shaker screen (classifier) over a
// concentrate tub. Fill surfaces, water, pebbles and gold flakes are cheap
// stand-ins (discs, instanced pebbles, two canvas textures) - no fluid or
// granular simulation; what they show follows the real material batches.
//
// Local frames: bucket and pan stand on y = 0, centred on the y axis. The
// pan's inside: flat bottom r = 0.11 m, walls flaring to 0.19 m at 6 cm.

import { mulberry32, noise2 } from "./goldrush-noise.js";
import { GridLoad, bucketShape, SCREEN } from "./goldrush-heap.js";

export const BUCKET = { r0: 0.112, r1: 0.14, h: 0.27, fillMax: 0.214 };       // 10 l at the fill line
export const PAN = { r0: 0.11, r1: 0.19, h: 0.058 };
// the wooden wash bowl (phase 7A): its inside - bottom r 0.088 m at y = base, flaring to 0.146 m 5,4 cm higher
export const BOWL = { r0: 0.088, r1: 0.146, h: 0.054, base: 0.02 };

function canvasTex(THREE, w, h, draw, repeat = true) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// wet soil / gravel seen from above: mottled, grains, a few light pebbles
function soilTex(THREE, seed) {
  return canvasTex(THREE, 128, 128, (g, w, h) => {
    const rng = mulberry32(seed);
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const n = noise2(x * 0.07, y * 0.07, seed) * 0.5 + noise2(x * 0.3, y * 0.3, seed + 7) * 0.3;
      const v = 150 + n * 70, i = (y * w + x) * 4;
      img.data[i] = v; img.data[i + 1] = v * 0.93; img.data[i + 2] = v * 0.84; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    for (let i = 0; i < 260; i++) {
      const a = 0.12 + rng() * 0.3, x = rng() * w, y = rng() * h, r = 0.6 + rng() * 2.2;
      g.fillStyle = rng() < 0.55 ? `rgba(40,28,18,${a})` : `rgba(235,220,196,${a * 0.8})`;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
  });
}

// ripples for the water (used as a bump map, scrolled / turned)
function rippleTex(THREE, seed) {
  return canvasTex(THREE, 128, 128, (g, w, h) => {
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const n = noise2(x * 0.09, y * 0.09, seed) * 0.6 + noise2(x * 0.23, y * 0.23, seed + 11) * 0.4;
      const v = 128 + n * 110, i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  });
}

// the screen of the classifier: woven wire with square holes (alpha)
function meshTex(THREE) {
  const t = canvasTex(THREE, 64, 64, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = "rgba(170,172,170,1)";
    g.lineWidth = 2.2;
    for (let i = 0; i <= 8; i++) {
      const p = (i / 8) * w;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, h); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(w, p); g.stroke();
    }
  });
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// a painted board (weathered planks, serif letters)
function signTex(THREE, text) {
  return canvasTex(THREE, 512, 128, (g, w, h) => {
    g.fillStyle = "#6b4a2c"; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 22; i++) {
      g.strokeStyle = `rgba(30,18,8,${0.08 + (i % 5) * 0.03})`;
      g.lineWidth = 1 + (i % 3);
      const y = (i * 37) % h;
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y + ((i % 4) - 2) * 3); g.stroke();
    }
    g.font = `700 ${Math.round(h * 0.48)}px Georgia, 'Times New Roman', serif`;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillStyle = "rgba(0,0,0,0.35)"; g.fillText(text, w / 2 + 2, h / 2 + 3);
    g.fillStyle = "#f2dfb6"; g.fillText(text, w / 2, h / 2);
  }, false);
}

const lathe = (THREE, pts, seg) => new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), seg);

// radius of the bucket / pan inside at height y
export const bucketRadius = (y, k = 1) => (BUCKET.r0 + (BUCKET.r1 - BUCKET.r0) * Math.min(1, y / (BUCKET.h * k)) ) * k;
export const panRadius = (y) => PAN.r0 + (PAN.r1 - PAN.r0) * Math.min(1, Math.max(0, y) / PAN.h);

// the stones in a pan / bowl: earth-brown to grey, lighter and darker (not one grey) - 7B
function tintPebbles(THREE, mesh, n) {
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const v = 0.72 + ((i * 5113) % 13) / 13 * 0.38, warm = ((i * 2971) % 7) / 7;
    c.setRGB(v * (0.92 + 0.12 * warm), v * (0.88 + 0.06 * warm), v * (0.82 - 0.06 * warm));
    mesh.setColorAt(i, c);
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

// fill height for a volume (frustum, solved by halving) - bucket scaled by k
export function bucketFillHeight(ml, k = 1) {
  const r0 = BUCKET.r0 * k, slope = ((BUCKET.r1 - BUCKET.r0) * k) / (BUCKET.h * k), want = ml / 1e6;
  const vol = (hh) => { const r = r0 + slope * hh; return (Math.PI * hh * (r0 * r0 + r0 * r + r * r)) / 3; };
  let lo = 0, hi = BUCKET.h * k * 0.98;
  if (want >= vol(hi)) return hi;
  for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (vol(m) < want) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

export const bowlRadius = (y) => BOWL.r0 + (BOWL.r1 - BOWL.r0) * Math.min(1, Math.max(0, y) / BOWL.h);
export function bowlFillHeight(ml) {
  const r0 = BOWL.r0, slope = (BOWL.r1 - BOWL.r0) / BOWL.h, want = ml / 1e6;
  const vol = (hh) => { const r = r0 + slope * hh; return (Math.PI * hh * (r0 * r0 + r0 * r + r * r)) / 3; };
  let lo = 0, hi = BOWL.h * 1.05;
  if (want >= vol(hi)) return hi;
  for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (vol(m) < want) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

// the inside of a washing tool: fill height (from its bottom) for a volume, radius at a height, where its bottom is
export function washShape(tool) {
  return tool === "bowl" ? { fill: bowlFillHeight, radius: bowlRadius, base: BOWL.base, depth: BOWL.h }
    : { fill: panFillHeight, radius: panRadius, base: 0, depth: PAN.h };
}

export function panFillHeight(ml) {
  const r0 = PAN.r0, slope = (PAN.r1 - PAN.r0) / PAN.h, want = ml / 1e6;
  const vol = (hh) => { const r = r0 + slope * hh; return (Math.PI * hh * (r0 * r0 + r0 * r + r * r)) / 3; };
  let lo = 0, hi = PAN.h * 1.15;
  if (want >= vol(hi)) return hi;
  for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (vol(m) < want) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

export class ProcessModels {
  constructor(THREE, { envMap, goldMat, woodTex } = {}) {
    this.THREE = THREE;
    this.geos = [];
    this.mats = [];
    this.texs = [];
    this.loads = [];                 // loose material (goldrush-heap.js): bucket fills, the classifier's heap
    const geo = (g) => { this.geos.push(g); return g; };
    const mat = (m) => { this.mats.push(m); return m; };
    const tex = (t) => { this.texs.push(t); return t; };
    this.goldMat = goldMat;

    // ---- shared materials
    this.galv = mat(new THREE.MeshStandardMaterial({ color: 0x92979a, roughness: 0.5, metalness: 0.55, envMap: envMap || null, envMapIntensity: 0.55 }));
    this.galvDark = mat(new THREE.MeshStandardMaterial({ color: 0x7d8286, roughness: 0.5, metalness: 0.6, envMap: envMap || null }));
    this.panSteel = mat(new THREE.MeshStandardMaterial({ color: 0x34373b, roughness: 0.33, metalness: 0.75, envMap: envMap || null, side: THREE.DoubleSide }));
    this.wood = mat(new THREE.MeshStandardMaterial({ map: woodTex || null, color: 0xa57c55, roughness: 0.9 }));
    this.darkWood = mat(new THREE.MeshStandardMaterial({ map: woodTex || null, color: 0x6a4c34, roughness: 0.92 }));
    this.gripWood = mat(new THREE.MeshStandardMaterial({ color: 0x8c6238, roughness: 0.7 }));
    this.soilMap = tex(soilTex(THREE, 41));
    this.soil = mat(new THREE.MeshStandardMaterial({ map: this.soilMap, color: 0x8a6a4c, roughness: 0.95 }));
    this.mud = mat(new THREE.MeshStandardMaterial({ map: this.soilMap, color: 0x7a5b40, roughness: 0.7 }));
    // black sand: magnetite / hematite grains, dark with a faint metallic sheen when wet
    this.sand = mat(new THREE.MeshStandardMaterial({ map: this.soilMap, color: 0x2b2622, roughness: 0.55, metalness: 0.25 }));
    this.conc = mat(new THREE.MeshStandardMaterial({ map: this.soilMap, color: 0x5a4a3a, roughness: 0.8 }));
    this.rippleMap = tex(rippleTex(THREE, 5));
    this.water = mat(new THREE.MeshStandardMaterial({ color: 0x4d3e2c, roughness: 0.45, metalness: 0.0, transparent: true, opacity: 0.42, bumpMap: this.rippleMap, bumpScale: 0.4, depthWrite: false }));
    this.troughWater = mat(new THREE.MeshStandardMaterial({ color: 0x6f7b74, roughness: 0.08, metalness: 0.0, transparent: true, opacity: 0.78, bumpMap: this.rippleMap, bumpScale: 0.4, depthWrite: false, envMap: envMap || null }));
    this.stream = mat(new THREE.MeshStandardMaterial({ color: 0xc9d6d8, roughness: 0.1, transparent: true, opacity: 0.45, depthWrite: false }));
    this.screenMap = tex(meshTex(THREE));
    this.screenMat = mat(new THREE.MeshStandardMaterial({ map: this.screenMap, alphaTest: 0.45, transparent: false, side: THREE.DoubleSide, roughness: 0.4, metalness: 0.6 }));
    this.pebbleMat = mat(new THREE.MeshStandardMaterial({ color: 0x9b958c, roughness: 0.85, flatShading: true }));
    // the wash bowl: turned wood, darkened by years of muddy water
    this.bowlWood = mat(new THREE.MeshStandardMaterial({ map: woodTex || null, color: 0x9c7048, roughness: 0.8, side: THREE.DoubleSide }));

    // ---- shared geometries
    // bucket: wall with a rolled rim and an inside, two pressed rings, the bail
    const b = BUCKET;
    this.bucketBody = geo(lathe(THREE, [[0, 0.004], [b.r0, 0.0], [b.r0 + 0.003, 0.004], [b.r1, b.h], [b.r1 + 0.005, b.h + 0.004], [b.r1 + 0.003, b.h + 0.01], [b.r1 - 0.004, b.h + 0.006],
      [b.r1 - 0.004, b.h - 0.004], [b.r0 - 0.003, 0.012], [0, 0.012]], 28));
    this.bucketRing = geo(new THREE.TorusGeometry(1, 0.0035, 5, 28));
    this.bucketRing.rotateX(Math.PI / 2);
    const bail = new THREE.CatmullRomCurve3([[-b.r1 - 0.006, b.h - 0.03, 0], [-b.r1 * 0.8, b.h + 0.1, 0], [0, b.h + 0.16, 0], [b.r1 * 0.8, b.h + 0.1, 0], [b.r1 + 0.006, b.h - 0.03, 0]].map(([x, y, z]) => new THREE.Vector3(x, y, z)));
    this.bucketBail = geo(new THREE.TubeGeometry(bail, 24, 0.0032, 6, false));
    this.bucketGrip = geo(new THREE.CylinderGeometry(0.013, 0.013, 0.085, 10));
    this.bucketGrip.rotateZ(Math.PI / 2);
    this.bucketGrip.translate(0, b.h + 0.158, 0);
    this.lug = geo(new THREE.CylinderGeometry(0.012, 0.012, 0.01, 10));
    this.lug.rotateZ(Math.PI / 2);
    this.disc = geo(new THREE.CircleGeometry(1, 40));
    this.disc.rotateX(-Math.PI / 2);
    // the black sand in the pan's low corner (phase 8): a flat patch with a ragged, uneven outline - the
    // heavy part gathers in drifts, never a circle; a shallow rise towards its middle
    this.sandDisc = geo(new THREE.CircleGeometry(1, 48, 0, Math.PI * 2));
    const sp = this.sandDisc.attributes.position;
    for (let v = 0; v < sp.count; v++) {
      const x = sp.getX(v), y = sp.getY(v), r = Math.hypot(x, y);
      if (r < 1e-6) { sp.setZ(v, 0.06); continue; }
      const a = Math.atan2(y, x), k = 1 + 0.16 * Math.sin(3 * a + 1.3) + 0.09 * Math.sin(7 * a + 0.4) + 0.05 * Math.sin(13 * a + 2.1);
      sp.setXYZ(v, x * k, y * k, 0.06 * (1 - r));
    }
    this.sandDisc.rotateX(-Math.PI / 2);
    this.sandDisc.computeVertexNormals();

    // pan: flat bottom, flaring wall, a rolled rim (both sides visible)
    const p = PAN;
    this.panBody = geo(lathe(THREE, [[0, 0], [p.r0, 0], [p.r0 + 0.006, 0.003], [p.r1, p.h], [p.r1 + 0.008, p.h + 0.004], [p.r1 + 0.006, p.h + 0.008]], 36));
    // riffles: three pressed ridges across one side of the wall (upgrade)
    this.riffle = geo(new THREE.TorusGeometry(1, 0.0028, 4, 18, Math.PI * 0.62));
    this.riffle.rotateX(Math.PI / 2);
    // wash bowl: a thick turned rim and base, the inside a shallow cone (BOWL)
    const w = BOWL;
    this.bowlBody = geo(lathe(THREE, [[0, 0], [w.r0 - 0.004, 0], [w.r0 + 0.012, 0.01], [w.r1 + 0.012, w.base + w.h - 0.004], [w.r1 + 0.014, w.base + w.h + 0.006],
      [w.r1 + 0.004, w.base + w.h + 0.01], [w.r1, w.base + w.h], [w.r0, w.base], [0, w.base]], 32));
    this.pebbleGeo = geo(new THREE.IcosahedronGeometry(1, 0));
    this.flakeGeo = geo(new THREE.IcosahedronGeometry(1, 0));
    this.flakeGeo.scale(1, 0.32, 0.8);
  }

  // ---- a bucket (world or hand): group + its fill surface
  bucket(scale = 1) {
    const THREE = this.THREE, g = new THREE.Group();
    const body = new THREE.Mesh(this.bucketBody, this.galv);
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);
    for (const y of [0.06, 0.2]) {
      const ring = new THREE.Mesh(this.bucketRing, this.galvDark);
      const r = BUCKET.r0 + (BUCKET.r1 - BUCKET.r0) * (y / BUCKET.h) + 0.002;
      ring.scale.set(r, 1, r);
      ring.position.y = y;
      g.add(ring);
    }
    for (const s of [-1, 1]) {
      const lug = new THREE.Mesh(this.lug, this.galvDark);
      lug.position.set(s * (BUCKET.r1 + 0.002), BUCKET.h - 0.03, 0);
      g.add(lug);
    }
    const bail = new THREE.Mesh(this.bucketBail, this.galvDark);
    bail.castShadow = true;
    g.add(bail);
    g.add(new THREE.Mesh(this.bucketGrip, this.gripWood));
    // the load (phase 7B): loose ground up to its level - uneven, crumbs / clods / pebbles on it
    const load = new GridLoad(THREE, g, { nx: 15, nz: 15, x0: -0.142, x1: 0.142, z0: -0.142, z1: 0.142, map: this.soilMap, lumps: 26, uv: 9, seed: 11 });
    this.loads.push(load);
    g.scale.setScalar(scale);
    g.userData.fill = load.surface;
    g.userData.load = load;
    g.userData.bail = bail;
    return g;
  }

  // set the fill of a bucket group: ml of material (in the unscaled bucket), comp its masses per material
  setBucketFill(group, ml, comp) {
    const L = group.userData.load, on = ml > 50;
    L.setVisible(on);
    if (!on) return;
    const h = bucketFillHeight(ml), k = Math.min(1, ml / 10000), c = comp || [1, 0, 0, 0];
    // phase 8: wall-constrained and nearly level, a few clumps - never a cone however full
    L.set(`${Math.round(ml / 25)}:${c.map((v) => Math.round(v / 50)).join(",")}`, bucketShape(h, bucketRadius, k, c), c, { amount: 0.45 + 0.45 * k, tMax: 0.22 });
  }

  // ---- the gold pan (world or hand): body, riffles, mud, water, pebbles, flakes
  pan({ hand = false } = {}) {
    const THREE = this.THREE, g = new THREE.Group();
    const body = new THREE.Mesh(this.panBody, this.panSteel);
    body.castShadow = !hand;
    body.receiveShadow = !hand;
    g.add(body);
    const riffles = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const y = 0.03 + i * 0.009, r = panRadius(y) - 0.001;
      const rf = new THREE.Mesh(this.riffle, this.panSteel);
      rf.scale.set(r, 1, r);
      rf.position.y = y;
      rf.rotation.y = Math.PI * 0.69;
      riffles.add(rf);
    }
    riffles.visible = false;
    g.add(riffles);
    const mud = new THREE.Mesh(this.disc, hand ? this.mud.clone() : this.mud);
    if (hand) this.mats.push(mud.material);
    mud.visible = false;
    g.add(mud);
    const water = new THREE.Mesh(this.disc, hand ? this.water.clone() : this.water);
    if (hand) this.mats.push(water.material);
    water.visible = false;
    water.renderOrder = 2;
    g.add(water);
    const sand = new THREE.Mesh(this.sandDisc, this.sand);
    sand.visible = false;
    g.add(sand);
    const pebbles = new THREE.InstancedMesh(this.pebbleGeo, this.pebbleMat, 18);
    pebbles.count = 0;
    pebbles.frustumCulled = false;
    tintPebbles(THREE, pebbles, 18);
    g.add(pebbles);
    const flakes = new THREE.InstancedMesh(this.flakeGeo, this.goldMat, 40);
    flakes.count = 0;
    flakes.frustumCulled = false;
    g.add(flakes);
    g.userData = { body, riffles, mud, water, sand, pebbles, flakes };
    return g;
  }

  // ---- the wash bowl (world or hand): the pan's parts, so the same washing drives it
  bowl({ hand = false } = {}) {
    const THREE = this.THREE, g = new THREE.Group();
    const body = new THREE.Mesh(this.bowlBody, this.bowlWood);
    body.castShadow = !hand;
    body.receiveShadow = !hand;
    g.add(body);
    const riffles = new THREE.Group();                 // none (the pan's upgrade) - kept for the same parts
    riffles.visible = false;
    g.add(riffles);
    const mud = new THREE.Mesh(this.disc, hand ? this.mud.clone() : this.mud);
    if (hand) this.mats.push(mud.material);
    mud.visible = false;
    g.add(mud);
    const water = new THREE.Mesh(this.disc, hand ? this.water.clone() : this.water);
    if (hand) this.mats.push(water.material);
    water.visible = false;
    water.renderOrder = 2;
    g.add(water);
    const sand = new THREE.Mesh(this.sandDisc, this.sand);
    sand.visible = false;
    g.add(sand);
    const pebbles = new THREE.InstancedMesh(this.pebbleGeo, this.pebbleMat, 18);
    pebbles.count = 0;
    pebbles.frustumCulled = false;
    tintPebbles(THREE, pebbles, 18);
    g.add(pebbles);
    const flakes = new THREE.InstancedMesh(this.flakeGeo, this.goldMat, 40);
    flakes.count = 0;
    flakes.frustumCulled = false;
    g.add(flakes);
    g.userData = { body, riffles, mud, water, sand, pebbles, flakes, bowl: true };
    return g;
  }

  // ---- the wash place: trough with water fed from the tank, a sign; the
  // classifier (screen over a tub) is separate - it appears once bought
  washPlace(sign) {
    const THREE = this.THREE, g = new THREE.Group(), parts = [];
    const mat = (m) => { this.mats.push(m); return m; };
    const tex = (t) => { this.texs.push(t); return t; };
    const box = (w, h, d, m, x, y, z, ry = 0) => {
      const mesh = new THREE.Mesh(this.geos[this.geos.push(new THREE.BoxGeometry(w, h, d)) - 1], m);
      mesh.position.set(x, y, z);
      mesh.rotation.y = ry;
      parts.push(mesh);
      return mesh;
    };
    // trough: 2.0 m along z, 0.56 m wide, 0.42 m high, planks 3 cm
    const L = 2.0, W = 0.56, H = 0.42, T = 0.03;
    box(W, T, L, this.darkWood, 0, 0.06 + T / 2, 0);
    box(T, H - 0.06, L, this.wood, -W / 2 + T / 2, 0.06 + (H - 0.06) / 2, 0);
    box(T, H - 0.06, L, this.wood, W / 2 - T / 2, 0.06 + (H - 0.06) / 2, 0);
    box(W - 2 * T, H - 0.06, T, this.wood, 0, 0.06 + (H - 0.06) / 2, -L / 2 + T / 2);
    box(W - 2 * T, H - 0.06, T, this.wood, 0, 0.06 + (H - 0.06) / 2, L / 2 - T / 2);
    for (const z of [-0.7, 0.7]) box(W + 0.12, 0.06, 0.08, this.darkWood, 0, 0.03, z);            // the feet it stands on
    box(0.06, 0.06, L + 0.04, this.darkWood, -W / 2 - 0.01, H + 0.005, 0);                      // a board along the far rim
    // feed pipe from the tank and a tap
    const pipe = new THREE.Mesh(this.geos[this.geos.push(new THREE.CylinderGeometry(0.025, 0.025, 1.0, 10)) - 1], this.galvDark);
    pipe.rotation.z = Math.PI / 2;
    pipe.position.set(-W / 2 - 0.5, 0.78, -0.55);
    parts.push(pipe);
    const drop = new THREE.Mesh(this.geos[this.geos.push(new THREE.CylinderGeometry(0.025, 0.025, 0.24, 10)) - 1], this.galvDark);
    drop.position.set(-W / 2 + 0.04, 0.68, -0.55);
    parts.push(drop);
    // sign on a post at the trough's end, painted on both sides
    if (sign) {
      box(0.06, 1.5, 0.06, this.darkWood, W / 2 + 0.12, 0.75, L / 2 + 0.12);
      box(0.04, 0.24, 0.9, this.darkWood, W / 2 + 0.16, 1.32, L / 2 + 0.12);
      const signMat = mat(new THREE.MeshStandardMaterial({ map: tex(signTex(THREE, "WASCHPLATZ")), roughness: 0.85 }));
      const face = this.geos[this.geos.push(new THREE.PlaneGeometry(0.86, 0.21)) - 1];
      for (const sx of [1, -1]) {
        const f = new THREE.Mesh(face, signMat);
        f.position.set(W / 2 + 0.16 + sx * 0.022, 1.32, L / 2 + 0.12);
        f.rotation.y = sx * Math.PI / 2;
        parts.push(f);
      }
    }
    for (const m of parts) { m.castShadow = true; m.receiveShadow = true; g.add(m); }
    // water surface and the trickle from the tap (not merged: they move / are transparent)
    const water = new THREE.Mesh(this.geos[this.geos.push(new THREE.PlaneGeometry(W - 2 * T, L - 2 * T)) - 1], this.troughWater);
    water.rotation.x = -Math.PI / 2;
    water.position.y = H - 0.07;
    water.renderOrder = 2;
    g.add(water);
    const trickle = new THREE.Mesh(this.geos[this.geos.push(new THREE.CylinderGeometry(0.008, 0.012, 0.22, 8, 1, true)) - 1], this.stream);
    trickle.position.set(-W / 2 + 0.04, 0.46, -0.55);
    g.add(trickle);
    g.userData = { water, trickle, L, W, H };
    return g;
  }

  // classifier: a wooden frame with a wire screen on legs, slightly tilted,
  // two handles at the near side; under it a tub for the concentrate
  classifier() {
    const THREE = this.THREE, g = new THREE.Group();
    const add = (geometry, m, x, y, z) => { const mesh = new THREE.Mesh(geometry, m); mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; return mesh; };
    const G = (gg) => { this.geos.push(gg); return gg; };
    // tub (stands still)
    const tub = new THREE.Group();
    const TW = 0.9, TD = 0.72, TH = 0.3, T = 0.03;
    tub.add(add(G(new THREE.BoxGeometry(TW, T, TD)), this.darkWood, 0, T / 2, 0));
    tub.add(add(G(new THREE.BoxGeometry(T, TH, TD)), this.wood, -TW / 2 + T / 2, TH / 2, 0));
    tub.add(add(G(new THREE.BoxGeometry(T, TH, TD)), this.wood, TW / 2 - T / 2, TH / 2, 0));
    tub.add(add(G(new THREE.BoxGeometry(TW - 2 * T, TH, T)), this.wood, 0, TH / 2, -TD / 2 + T / 2));
    tub.add(add(G(new THREE.BoxGeometry(TW - 2 * T, TH, T)), this.wood, 0, TH / 2, TD / 2 - T / 2));
    const conc = new THREE.Mesh(G(new THREE.PlaneGeometry(TW - 2 * T - 0.004, TD - 2 * T - 0.004)), this.conc);
    conc.rotation.x = -Math.PI / 2;
    conc.visible = false;
    tub.add(conc);
    g.add(tub);
    // legs + the shaking frame (its own group)
    for (const [x, z] of [[-0.48, -0.36], [0.48, -0.36], [-0.48, 0.36], [0.48, 0.36]]) g.add(add(G(new THREE.BoxGeometry(0.05, 0.62, 0.05)), this.darkWood, x, 0.31, z));
    const frame = new THREE.Group();
    frame.position.y = 0.62;
    frame.rotation.z = 0.06;                                   // tilted a little towards the far side
    const FW = 0.86, FD = 0.68, FH = 0.1;
    frame.add(add(G(new THREE.BoxGeometry(0.04, FH, FD)), this.wood, -FW / 2, FH / 2, 0));
    frame.add(add(G(new THREE.BoxGeometry(0.04, FH, FD)), this.wood, FW / 2, FH / 2, 0));
    frame.add(add(G(new THREE.BoxGeometry(FW, FH, 0.04)), this.wood, 0, FH / 2, -FD / 2));
    frame.add(add(G(new THREE.BoxGeometry(FW, FH, 0.04)), this.wood, 0, FH / 2, FD / 2));
    const screen = new THREE.Mesh(G(new THREE.PlaneGeometry(FW - 0.04, FD - 0.04)), this.screenMat);
    screen.rotation.x = -Math.PI / 2;
    screen.position.y = 0.015;
    screen.material.map.repeat.set(10, 8);
    frame.add(screen);
    for (const z of [-0.2, 0.2]) {                              // two handles at the near (+x) side
      const h = add(G(new THREE.CylinderGeometry(0.014, 0.014, 0.16, 8)), this.gripWood, FW / 2 + 0.1, FH / 2, z);
      h.rotation.z = Math.PI / 2;
      frame.add(h);
    }
    // what lies on the screen (phase 7B): a loose heap of the raw load - the fines sink through as
    // you shake, the pebbles / clods / stones stay; afterwards the coarse remainder alone
    // what lies on the screen (phase 8): a shallow layer spread across it (goldrush-heap.js screenShape)
    const heapLoad = new GridLoad(THREE, frame, { nx: 21, nz: 17, x0: -SCREEN.hx, x1: SCREEN.hx, z0: -SCREEN.hz, z1: SCREEN.hz, map: this.soilMap, lumps: 48, uv: 8, seed: 21, shadow: true });
    this.loads.push(heapLoad);
    const heap = heapLoad.surface, stones = heapLoad.lumps;
    g.add(frame);
    g.userData = { frame, heap, stones, heapLoad, conc, tub, TW, TD, TH };
    return g;
  }

  dispose() {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.texs) t.dispose();
    for (const l of this.loads) l.dispose();
  }
}
