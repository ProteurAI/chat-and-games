// GoldRush - the first location: "Claim 01", a dusty gold claim in a dry
// valley. Scene composition only - the diggable mound comes from
// DiggableTerrain, everything else here is set dressing, colliders and
// the reserved (still empty) machine zones for later phases.
//
// World units are metres. The player enters from the south (+z) and looks
// north at the mound; the afternoon sun comes from the west, a little
// behind them, so the pile has a lit and a shaded flank (it reads as a
// shape, not a cut-out) and the face they dig into is in good light.

import { DiggableTerrain } from "./goldrush-terrain.js";
import { CampDressing } from "./goldrush-campdressing.js";
import { mergeStatic } from "./goldrush-merge.js";
import { fbm2, hash3, mulberry32, noise2, ridged2, smoothstep } from "./goldrush-noise.js";
import { AIR, SUN_DIR, analyticEnvironment, hdriEnvironment, skyMaterial } from "./goldrush-atmos.js";
import { EarthSystem } from "./goldrush-earthmat.js";

export const CLAIM = { minX: -24, maxX: 24, minZ: -30, maxZ: 20 };      // fenced play area
export const MOUND_CENTER = { x: 0, z: -6 };
export const SPAWN = { x: 0.6, z: 10.2, yaw: 0, pitch: 0.12 };
export const MACHINE_ZONES = [
  { id: "A", x: 18.5, z: -3, w: 6, d: 8, label: "ZONE A" },
  { id: "B", x: -18.5, z: -9, w: 6, d: 8, label: "ZONE B" },
  { id: "C", x: 15.5, z: 13, w: 7, d: 5, label: "ZONE C" },
];
export { SUN_DIR };                       // towards the sun: west-south-west, 22 deg up (Visual Overhaul A, goldrush-atmos.js)
const GROUND_REF = 0xb59f7d;             // the plain's colour - the earth layers' tint is relative to it
// image-based light: a CC0 HDRI (Poly Haven "Goegap", ASSETS.md), local - never hotlinked
const HDRI_URL = new URL("./assets/hdri/goegap_1k.hdr", import.meta.url).href;

// --------------------------------------------------------------- textures

function canvasTexture(THREE, size, draw, { srgb = true, repeat = true } = {}) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d"), size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  return t;
}

// greyscale ground detail (multiplies the vertex colours): soft clumps,
// grain and small pebbles. Periodic noise, so the tile repeats seamlessly.
function periodicFbm(u, v, period, seed, octaves) {
  let sum = 0, amp = 1, norm = 0, per = period;
  for (let o = 0; o < octaves; o++) {
    const x = u * per, y = v * per, ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const h = (i, j) => hash3(((i % per) + per) % per, ((j % per) + per) % per, o, seed);
    const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1);
    sum += amp * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
    norm += amp;
    amp *= 0.5;
    per *= 2;
  }
  return sum / norm;          // 0..1
}

function soilDetail(ctx, size, seed) {
  const img = ctx.createImageData(size, size);
  const rng = mulberry32(seed);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const clump = periodicFbm(u, v, 6, seed, 4);
      const g = 206 + (clump - 0.5) * 44 + (rng() - 0.5) * 16;
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(255, g));
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  for (let p = 0; p < 260; p++) {                                   // small pebbles, light and dark (phase 8: quieter - no confetti)
    const x = rng() * size, y = rng() * size, r = 0.5 + rng() * rng() * 1.5;
    const l = rng() < 0.5 ? 218 + rng() * 16 : 168 + rng() * 22;
    ctx.fillStyle = `rgba(${l},${l},${l},${0.3 + rng() * 0.25})`;
    for (const [ox, oy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      ctx.beginPath();
      ctx.ellipse(x + ox, y + oy, r, r * (0.6 + rng() * 0.4), rng() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// rock detail: grain, a few cracks, pale lichen specks
function rockDetail(ctx, size, seed) {
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const g = 196 + (periodicFbm(u, v, 5, seed, 5) - 0.5) * 90;
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(255, g));
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const rng = mulberry32(seed + 1);
  ctx.strokeStyle = "rgba(55,48,42,0.55)";
  for (let c = 0; c < 9; c++) {
    let x = rng() * size, y = rng() * size;
    ctx.lineWidth = 0.7 + rng() * 1.3;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let s = 0; s < 7; s++) { x += (rng() - 0.5) * 34; y += (rng() - 0.3) * 26; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  for (let l = 0; l < 140; l++) {
    ctx.fillStyle = `rgba(235,228,200,${0.2 + rng() * 0.3})`;
    ctx.beginPath(); ctx.arc(rng() * size, rng() * size, 0.6 + rng() * 1.8, 0, Math.PI * 2); ctx.fill();
  }
}

function woodPlanks(ctx, size, seed) {
  const rng = mulberry32(seed);
  const planks = 6, w = size / planks;
  for (let p = 0; p < planks; p++) {
    const base = 128 + rng() * 38;
    ctx.fillStyle = `rgb(${base + 18},${base - 8},${base - 42})`;
    ctx.fillRect(p * w, 0, w, size);
    for (let g = 0; g < 26; g++) {                                   // grain
      ctx.strokeStyle = `rgba(60,38,20,${0.08 + rng() * 0.14})`;
      ctx.lineWidth = 0.6 + rng() * 1.2;
      const x = p * w + rng() * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.bezierCurveTo(x + (rng() - 0.5) * 6, size * 0.3, x + (rng() - 0.5) * 6, size * 0.7, x + (rng() - 0.5) * 4, size);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(40,24,12,0.55)";                          // gap
    ctx.fillRect(p * w, 0, 2, size);
  }
}

// phase 7B: the water tank's weathered galvanised plates - riveted seams round it, rust
// running down from them, a darker grime band at the foot (top of the canvas = top of the tank)
function tankPlates(ctx, size, seed) {
  const rng = mulberry32(seed);
  ctx.fillStyle = "rgb(168,170,164)";
  ctx.fillRect(0, 0, size, size);
  for (let k = 0; k < 900; k++) {                                     // mottled zinc
    const v = 140 + rng() * 60;
    ctx.fillStyle = `rgba(${v},${v + 2},${v - 4},0.22)`;
    ctx.fillRect(rng() * size, rng() * size, 2 + rng() * 9, 1 + rng() * 5);
  }
  const seams = 5;
  for (let s = 1; s < seams; s++) {
    const y = (s / seams) * size;
    for (let k = 0; k < 14; k++) {                                    // rust running down from the seam
      const x = rng() * size, len = 8 + rng() * 34, g = ctx.createLinearGradient(0, y, 0, y + len);
      g.addColorStop(0, `rgba(122,66,32,${0.25 + rng() * 0.3})`);
      g.addColorStop(1, "rgba(122,66,32,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x, y, 1.5 + rng() * 3, len);
    }
    ctx.fillStyle = "rgba(60,62,60,0.55)";                           // the lap and its rivets
    ctx.fillRect(0, y - 1.5, size, 3);
    ctx.fillStyle = "rgba(210,212,206,0.35)";
    ctx.fillRect(0, y + 1.5, size, 1);
    ctx.fillStyle = "rgba(70,70,66,0.7)";
    for (let x = 4; x < size; x += 11) ctx.fillRect(x, y - 4, 2, 2);
  }
  for (let x = 0; x < size; x += size / 4) { ctx.fillStyle = "rgba(70,72,70,0.4)"; ctx.fillRect(x, 0, 2, size); }   // the vertical joints
  const foot = ctx.createLinearGradient(0, size * 0.78, 0, size);
  foot.addColorStop(0, "rgba(96,74,52,0)");
  foot.addColorStop(1, "rgba(96,74,52,0.55)");
  ctx.fillStyle = foot;
  ctx.fillRect(0, size * 0.78, size, size * 0.22);
}

function signTexture(THREE, lines, { w = 512, h = 192, bg = "#5a3a22", fg = "#f4d58a" } = {}) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  for (let y = 0; y < h; y += h / 4) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  ctx.fillStyle = fg;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((l) => {
    let size = l.size;
    const font = (px) => `${l.weight || 800} ${px}px Unbounded, Inter, "Segoe UI", sans-serif`;
    ctx.font = font(size);
    while (ctx.measureText(l.text).width > w * 0.86 && size > 10) { size -= 2; ctx.font = font(size); }   // always fits the board
    ctx.fillText(l.text, w / 2, h * l.y);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// --------------------------------------------------------------- world

export class GoldRushWorld {
  // built in two steps (buildTerrain, buildScenery) so the loading screen
  // can show real progress in between
  constructor(THREE, { seed, assets }) {
    this.THREE = THREE;
    this.seed = seed;
    this.assets = assets;
    this.disposables = [];
    this.colliders = [];
    this.decks = [];               // phase 7: walkable timber (a loading ramp, a platform) - see addDeck
    this.heightSources = [];       // Prompt 10: more walkable surfaces on the ground (stockpiles) - see addHeightSource
    const scene = (this.scene = new THREE.Scene());
    // (Visual Overhaul A: the haze is goldrush-atmos.js' fog - distance + height layer + sun inscatter, in linear light)
    scene.fog = new THREE.FogExp2(new THREE.Color().setRGB(...AIR.fog), 0.0046);
    scene.background = new THREE.Color().setRGB(...AIR.horizon);
    this._textures();
  }

  buildTerrain() {
    this._terrain();
  }

  buildScenery() {
    this._sky();
    this._lights();
    this._ground();
    const n0 = this.scene.children.length;
    this._fence();
    this._props();
    this._machineZones();
    // phase 7A: paths, ruts and the things a working claim collects (merged, cosmetic)
    this.dressing = new CampDressing(this.THREE, this.scene, { woodTex: this.woodTex });
    this.disposables.push({ dispose: () => this.dressing.dispose(this.scene) });
    this._boulders();
    this._mergeProps(this.scene.children.slice(n0));
    this._grass();
    this._pebbles();
    this._distantRidges();
  }

  track(o) { this.disposables.push(o); return o; }

  // phase 7A draw calls: the fence, the shed, barrels, tank, lamps, the zones' slabs / paint /
  // stakes / flags and the rocks outside the pile never move - baked per material (each keeping
  // its own shadow) and the parts taken out of the scene (colliders are separate data)
  _mergeProps(list) {
    const parts = list.filter((o) => o.isMesh && !o.isInstancedMesh && !o.name);
    const merged = mergeStatic(this.THREE, this.scene, parts, { keepShadow: true });
    for (const m of merged) this.track(m.geometry);
    for (const p of parts) if (!p.visible) this.scene.remove(p);
    this.propsMerged = merged.length;
  }

  // procedural for now, through the asset manager (cached, disposed with the game)
  _textures() {
    const THREE = this.THREE, a = this.assets;
    this.soilTex = a.procedural("tex:soil", () => canvasTexture(THREE, 256, (ctx, s) => soilDetail(ctx, s, this.seed + 7)));
    this.woodTex = a.procedural("tex:wood", () => canvasTexture(THREE, 256, (ctx, s) => woodPlanks(ctx, s, this.seed + 11)));
    this.rockTex = a.procedural("tex:rock", () => canvasTexture(THREE, 256, (ctx, s) => rockDetail(ctx, s, this.seed + 17)));
  }

  // Earth B0 (Visual Overhaul A): the ground's PBR layers (goldrush-earthmat.js) - crust, loose dirt, compact clay,
  // gravel and stone from the MaterialField at the exposed surface; the same material (its plain variant) for the
  // ground outside the dig square, so the two meet without a seam
  _terrain() {
    const THREE = this.THREE;
    this.timeUniform = this.timeUniform || { value: 0 };
    this.terrainUniforms = { uTime: this.timeUniform };          // (the engine drives the clock; the sky's clouds use it)
    const lin = (hex) => new THREE.Color(hex).toArray();
    this.earth = new EarthSystem(THREE, { ground: lin(GROUND_REF), fill: lin(0x8d8475) });
    this.disposables.push(this.earth);
    this.terrainMaterial = this.earth.terrainMaterial;
    this.terrain = new DiggableTerrain(THREE, {
      seed: this.seed, center: { x: 0, z: -6 }, size: 30, cell: 0.125, chunkCells: 30,
      moundCenter: MOUND_CENTER, material: this.terrainMaterial, spawn: SPAWN,
    });
    this.earth.attach(this.terrain);
    this.scene.add(this.terrain.group);
  }

  /** the earth layers' textures (1024 / 512 px); a flat stand-in when they cannot be loaded */
  async loadEarth(renderer, res) {
    try { await this.earth.load(renderer, res); } catch (e) {
      this.earthError = String((e && e.message) || e);
      this.earth.fallback();
    }
  }

  // Visual Overhaul A: a shader dome (goldrush-atmos.js) - dusty gradient, the sun disc where the light comes
  // from, slow high clouds (the terrain clock drives them)
  _sky() {
    const THREE = this.THREE;
    this.timeUniform = this.timeUniform || { value: 0 };
    const sky = new THREE.Mesh(this.track(new THREE.SphereGeometry(420, 48, 24)), this.track(skyMaterial(THREE, this.timeUniform)));
    sky.name = "sky";
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    this.scene.add(sky);
  }

  _lights() {
    const THREE = this.THREE;
    // Visual Overhaul A: a low sun (22 deg) carries the light; the sky is the HDRI's image-based light
    // (buildEnvironment), so the flat hemisphere fill is only a trace and the bounce light is gone - shade
    // has depth again, the relief reads, the beige wash is gone
    const hemi = (this.hemi = new THREE.HemisphereLight(0xaec6e6, 0x7f6146, 0.18));
    this.scene.add(hemi);
    const sun = (this.sun = new THREE.DirectionalLight(0xffe2bc, 4.6));
    const target = new THREE.Vector3(0, 0, -5);
    sun.position.set(target.x + SUN_DIR[0] * 70, SUN_DIR[1] * 70, target.z + SUN_DIR[2] * 70);
    sun.target.position.copy(target);
    sun.castShadow = true;
    const cam = sun.shadow.camera;
    cam.left = -31; cam.right = 31; cam.top = 31; cam.bottom = -31; cam.near = 20; cam.far = 140;
    sun.shadow.bias = -0.00035;
    sun.shadow.normalBias = 0.045;
    this.scene.add(sun, sun.target);
  }

  // the ground everywhere except the mound's square (a hole, so digging below
  // 0 never shows the ground plane through the pit); flat in the claim,
  // rolling dry hills beyond the fence
  _ground() {
    const THREE = this.THREE, s = this.seed;
    const t = this.terrain, hx0 = t.x0, hx1 = t.x0 + t.size, hz0 = t.z0, hz1 = t.z0 + t.size;
    const span = 240, step = 3, n = span / step;
    const pos = [], col = [], uv = [], idx = [];
    const cA = new THREE.Color(GROUND_REF), cB = new THREE.Color(0xa38c6c), cDry = new THREE.Color(0x9f9166), cTrack = new THREE.Color(0xc1ab86);
    const tmp = new THREE.Color();
    const heightAt = (x, z) => {
      const dx = Math.max(CLAIM.minX - 6 - x, 0, x - CLAIM.maxX - 6), dz = Math.max(CLAIM.minZ - 6 - z, 0, z - CLAIM.maxZ - 6);
      const d = Math.hypot(dx, dz);
      const hills = 5 + 9 * fbm2(x * 0.012, z * 0.012, s + 201, 4) + 5 * ridged2(x * 0.02, z * 0.02, s + 207);
      return Math.max(0, hills) * smoothstep(2, 34, d) + (d > 0 ? 0.25 * fbm2(x * 0.1, z * 0.1, s + 211, 2) * smoothstep(0, 6, d) : 0);
    };
    this.groundHeightAt = heightAt;
    // the ground's colour at a point (the terrain square uses it too where its ground is untouched)
    const colorAt = (x, z, y, out) => {
      const v = noise2(x * 0.08, z * 0.08, s + 221) * 0.5 + 0.5;
      tmp.copy(cA).lerp(cB, v);
      tmp.lerp(cDry, smoothstep(1, 6, y) * 0.8);
      // a worn track from the gate to the mound
      const track = Math.max(0, 1 - Math.abs(x - 0.8 * Math.sin(z * 0.08)) / 3.2) * smoothstep(CLAIM.maxZ + 2, 6, z) * (z > -2 ? 1 : 0);
      tmp.lerp(cTrack, track * 0.6);
      // phase 7A: paths worn between the camp's places (mine, shop, wash place, gold buyer, automation)
      const wear = this._pathWear ? this._pathWear(x, z) : 0;
      if (wear > 0) tmp.lerp(cTrack, wear * 0.45);
      out[0] = tmp.r; out[1] = tmp.g; out[2] = tmp.b;
      return out;
    };
    const c3 = [0, 0, 0];
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const x = -span / 2 + i * step, z = -span / 2 + j * step;
        const y = heightAt(x, z);
        pos.push(x, y, z);
        uv.push(x * 0.5, z * 0.5);
        colorAt(x, z, y, c3);
        col.push(c3[0], c3[1], c3[2]);
      }
    }
    t.groundColor = (x, z, out) => colorAt(x, z, 0, out);
    t.refreshAll();
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x0 = -span / 2 + i * step, z0 = -span / 2 + j * step;
        if (x0 >= hx0 && x0 + step <= hx1 && z0 >= hz0 && z0 + step <= hz1) continue;   // the mound's square
        const a = j * (n + 1) + i, b = (j + 1) * (n + 1) + i;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const g = this.track(new THREE.BufferGeometry());
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // (Earth B0: the crust layer, tinted by these vertex colours - tracks and worn paths stay; the dig square's
    // untouched edge ground uses the same formula)
    const ground = new THREE.Mesh(g, this.earth.groundMaterial);
    ground.receiveShadow = true;
    ground.name = "ground";
    this.scene.add(ground);
  }

  _fence() {
    const THREE = this.THREE;
    const woodMat = (this.woodMat = this.track(new THREE.MeshStandardMaterial({ map: this.woodTex, color: 0xc9b08e, roughness: 0.9 })));
    const posts = [], rails = [];
    const gateHalf = 2.2;
    const edge = (x0, z0, x1, z1, gate) => {
      const len = Math.hypot(x1 - x0, z1 - z0), segs = Math.round(len / 3);
      for (let k = 0; k <= segs; k++) {
        const t = k / segs, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
        if (gate && Math.abs(x) < gateHalf - 0.01) continue;
        posts.push([x, z]);
        if (k < segs) {
          const t2 = (k + 1) / segs, x2 = x0 + (x1 - x0) * t2, z2 = z0 + (z1 - z0) * t2;
          if (gate && ((x < gateHalf && x2 > -gateHalf) || (x2 < gateHalf && x > -gateHalf))) continue;
          rails.push([(x + x2) / 2, (z + z2) / 2, Math.hypot(x2 - x, z2 - z), Math.atan2(z2 - z, x2 - x)]);
        }
      }
    };
    edge(CLAIM.minX, CLAIM.minZ, CLAIM.maxX, CLAIM.minZ, false);
    edge(CLAIM.maxX, CLAIM.minZ, CLAIM.maxX, CLAIM.maxZ, false);
    edge(CLAIM.minX, CLAIM.maxZ, CLAIM.maxX, CLAIM.maxZ, true);
    edge(CLAIM.minX, CLAIM.minZ, CLAIM.minX, CLAIM.maxZ, false);
    posts.push([-gateHalf, CLAIM.maxZ], [gateHalf, CLAIM.maxZ]);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    const postGeo = this.track(new THREE.CylinderGeometry(0.07, 0.085, 1.35, 7));
    const postMesh = new THREE.InstancedMesh(postGeo, woodMat, posts.length);
    posts.forEach(([x, z], i) => {
      const rng = mulberry32(i + 17);
      q.setFromAxisAngle(new THREE.Vector3(Math.cos(i), 0, Math.sin(i)), (rng() - 0.5) * 0.06);
      m.compose(p.set(x, 0.62, z), q, sc.set(1, 0.9 + rng() * 0.2, 1));
      postMesh.setMatrixAt(i, m);
    });
    postMesh.castShadow = true;
    postMesh.receiveShadow = true;
    const railGeo = this.track(new THREE.BoxGeometry(1, 0.07, 0.045));
    const railMesh = new THREE.InstancedMesh(railGeo, woodMat, rails.length * 2);
    rails.forEach(([x, z, len, ang], i) => {
      for (let r = 0; r < 2; r++) {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -ang);
        m.compose(p.set(x, 0.55 + r * 0.45, z), q, sc.set(len + 0.1, 1, 1));
        railMesh.setMatrixAt(i * 2 + r, m);
      }
    });
    railMesh.castShadow = true;
    this.scene.add(postMesh, railMesh);
    // gate: two tall posts and a sign board across
    const gatePostGeo = this.track(new THREE.BoxGeometry(0.22, 3.4, 0.22));
    for (const gx of [-gateHalf, gateHalf]) {
      const gp = new THREE.Mesh(gatePostGeo, woodMat);
      gp.position.set(gx, 1.7, CLAIM.maxZ);
      gp.castShadow = true;
      this.scene.add(gp);
    }
    const signTex = this.track(signTexture(THREE, [{ text: "GOLDRUSH", size: 78, y: 0.42 }, { text: "CLAIM 01", size: 30, y: 0.8, weight: 700 }]));
    const sign = new THREE.Mesh(this.track(new THREE.BoxGeometry(4.8, 1.05, 0.08)),
      [woodMat, woodMat, woodMat, woodMat, this.track(new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.85 })), woodMat]);
    sign.position.set(0, 3.05, CLAIM.maxZ + 0.02);
    sign.rotation.y = Math.PI;       // the lettering faces the player inside the claim
    sign.castShadow = true;
    this.scene.add(sign);
    // the fence keeps the player in
    this.bounds = { minX: CLAIM.minX + 0.7, maxX: CLAIM.maxX - 0.7, minZ: CLAIM.minZ + 0.7, maxZ: CLAIM.maxZ - 0.7 };
  }

  _box(w, h, d, mat, x, y, z, ry = 0, collide = true) {
    const THREE = this.THREE;
    const mesh = new THREE.Mesh(this.track(new THREE.BoxGeometry(w, h, d)), mat);
    mesh.position.set(x, y, z);
    mesh.rotation.y = ry;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    if (collide) this.colliders.push({ type: "box", x, z, hw: w / 2, hd: d / 2, rot: ry });
    return mesh;
  }

  _props() {
    const THREE = this.THREE;
    const wood = this.woodMat;
    const darkWood = this.track(new THREE.MeshStandardMaterial({ map: this.woodTex, color: 0x8a6a4c, roughness: 0.92 }));
    const metal = this.track(new THREE.MeshStandardMaterial({ color: 0x8b8f93, roughness: 0.55, metalness: 0.35 }));
    const rust = this.track(new THREE.MeshStandardMaterial({ color: 0x74462c, roughness: 0.8, metalness: 0.2 }));
    // phase 7B: weathered galvanised plates for the tank (it read as a black block before)
    const tankTex = this.assets.procedural("tex:tank", () => canvasTexture(THREE, 256, (ctx, s) => tankPlates(ctx, s, this.seed + 23)));
    const tankMat = this.track(new THREE.MeshStandardMaterial({ map: tankTex, color: 0xb2b0a8, roughness: 0.66, metalness: 0.22 }));
    this._metalMats = [metal, rust, tankMat];          // they get the sky's reflection (buildEnvironment)

    // the supply shack (north-west of the gate) is built with the stations (goldrush-buildings.js, phase 8:
    // an open front instead of a closed box); here only what stands round it
    const sx = -18.2, sz = 13.2;

    // crates and planks by the shed
    const crate = this.track(new THREE.MeshStandardMaterial({ map: this.woodTex, color: 0xb89468, roughness: 0.9 }));
    this._box(0.8, 0.8, 0.8, crate, sx + 3.0, 0.4, sz - 0.4, 0.2);
    this._box(0.8, 0.8, 0.8, crate, sx + 3.2, 0.4, sz + 0.55, -0.1);
    this._box(0.7, 0.7, 0.7, crate, sx + 3.05, 1.15, sz + 0.1, 0.5, false);
    for (let k = 0; k < 6; k++) this._box(3.2, 0.06, 0.24, wood, sx - 0.2, 0.05 + k * 0.065, sz + 2.4 + (k % 2) * 0.06, 0.02 * k, k === 0);

    // barrels
    const barrelGeo = this.track(new THREE.LatheGeometry(
      [[0.0, 0], [0.3, 0], [0.34, 0.2], [0.36, 0.45], [0.34, 0.7], [0.3, 0.9], [0.0, 0.9]].map(([x, y]) => new THREE.Vector2(x, y)), 14));
    const bandGeo = this.track(new THREE.TorusGeometry(0.352, 0.018, 5, 18));
    const barrel = (x, z, mat) => {
      const b = new THREE.Mesh(barrelGeo, mat);
      b.position.set(x, 0, z);
      b.castShadow = true;
      b.receiveShadow = true;
      this.scene.add(b);
      for (const y of [0.2, 0.7]) {
        const band = new THREE.Mesh(bandGeo, metal);
        band.rotation.x = Math.PI / 2;
        band.position.set(x, y, z);
        this.scene.add(band);
      }
      this.colliders.push({ type: "circle", x, z, r: 0.36 });
    };
    barrel(sx + 2.6, sz + 1.8, rust);
    barrel(sx + 3.35, sz + 2.05, darkWood);
    barrel(-19.2, 4.4, rust);

    // water tank (feeds the trough): riveted plates, a shallow cone roof with a hatch, two bands,
    // the outlet with its valve where the trough's pipe comes in
    const tankGeo = this.track(new THREE.CylinderGeometry(1.25, 1.25, 2.3, 24, 1, true));
    const tank = new THREE.Mesh(tankGeo, tankMat);
    tank.position.set(-19.5, 1.9, 1.8);
    tank.castShadow = true;
    tank.receiveShadow = true;
    this.scene.add(tank);
    const roofT = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.16, 1.3, 0.3, 24)), tankMat);
    roofT.position.set(-19.5, 3.2, 1.8);
    roofT.castShadow = true;
    const hatch = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.2, 0.2, 0.08, 12)), metal);
    hatch.position.set(-19.5, 3.38, 1.8);
    const bottom = new THREE.Mesh(this.track(new THREE.CylinderGeometry(1.25, 1.25, 0.04, 24)), metal);
    bottom.position.set(-19.5, 0.77, 1.8);
    this.scene.add(roofT, hatch, bottom);
    const tankBand = this.track(new THREE.TorusGeometry(1.262, 0.022, 5, 32));
    for (const y of [1.15, 2.6]) {
      const b = new THREE.Mesh(tankBand, rust);
      b.rotation.x = Math.PI / 2;
      b.position.set(-19.5, y, 1.8);
      this.scene.add(b);
    }
    const valve = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.055, 0.055, 0.14, 10)), rust);
    valve.rotation.z = Math.PI / 2;
    valve.position.set(-18.2, 0.79, 1.8);
    const wheel = new THREE.Mesh(this.track(new THREE.TorusGeometry(0.07, 0.012, 5, 12)), rust);
    wheel.position.set(-18.2, 0.92, 1.8);
    wheel.rotation.x = Math.PI / 2;
    const stem = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.012, 0.012, 0.12, 6)), metal);
    stem.position.set(-18.2, 0.86, 1.8);
    this.scene.add(valve, wheel, stem);
    const legGeo = this.track(new THREE.BoxGeometry(0.12, 0.8, 0.12));
    for (const [dx, dz] of [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]]) {
      const leg = new THREE.Mesh(legGeo, darkWood);
      leg.position.set(-19.5 + dx, 0.4, 1.8 + dz);
      leg.castShadow = true;
      this.scene.add(leg);
    }
    this.colliders.push({ type: "circle", x: -19.5, z: 1.8, r: 1.3 });

    // two work lamps by the zones
    const poleGeo = this.track(new THREE.CylinderGeometry(0.05, 0.06, 4.2, 6));
    const headGeo = this.track(new THREE.BoxGeometry(0.5, 0.18, 0.3));
    const lampMat = this.track(new THREE.MeshStandardMaterial({ color: 0xfff1c8, emissive: 0xffd98a, emissiveIntensity: 0.4, roughness: 0.4 }));
    for (const [x, z] of [[13.4, -9.2], [-13.2, -15.2]]) {
      const pole = new THREE.Mesh(poleGeo, metal);
      pole.position.set(x, 2.1, z);
      pole.castShadow = true;
      const head = new THREE.Mesh(headGeo, lampMat);
      head.position.set(x, 4.15, z);
      this.scene.add(pole, head);
      this.colliders.push({ type: "circle", x, z, r: 0.2 });
    }
  }

  // reserved, still empty machine zones: gravel slabs, painted borders, stakes with flags
  _machineZones() {
    const THREE = this.THREE;
    const slab = this.track(new THREE.MeshStandardMaterial({ color: 0xb3aa9b, map: this.soilTex, roughness: 0.95 }));
    const paint = this.track(new THREE.MeshStandardMaterial({ color: 0xe0b33a, roughness: 0.8 }));
    const stakeMat = this.track(new THREE.MeshStandardMaterial({ map: this.woodTex, color: 0xd0b48c, roughness: 0.9 }));
    const flagMat = this.track(new THREE.MeshStandardMaterial({ color: 0xe8662a, roughness: 0.8, side: THREE.DoubleSide }));
    const stakeGeo = this.track(new THREE.BoxGeometry(0.05, 0.9, 0.05));
    const flagGeo = this.track(new THREE.PlaneGeometry(0.22, 0.14));
    this.zones = [];
    for (const zdef of MACHINE_ZONES) {
      const base = new THREE.Mesh(this.track(new THREE.BoxGeometry(zdef.w, 0.1, zdef.d)), slab);
      base.position.set(zdef.x, 0.05, zdef.z);
      base.receiveShadow = true;
      this.scene.add(base);
      const edges = [[zdef.w, 0.12, 0, zdef.d / 2 - 0.06], [zdef.w, 0.12, 0, -zdef.d / 2 + 0.06], [0.12, zdef.d, zdef.w / 2 - 0.06, 0], [0.12, zdef.d, -zdef.w / 2 + 0.06, 0]];
      for (const [w, d, ox, oz] of edges) {
        const e = new THREE.Mesh(this.track(new THREE.BoxGeometry(w, 0.012, d)), paint);
        e.position.set(zdef.x + ox, 0.106, zdef.z + oz);
        this.scene.add(e);
      }
      for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const x = zdef.x + cx * (zdef.w / 2 + 0.35), z = zdef.z + cz * (zdef.d / 2 + 0.35);
        const st = new THREE.Mesh(stakeGeo, stakeMat);
        st.position.set(x, 0.45, z);
        st.castShadow = true;
        const fl = new THREE.Mesh(flagGeo, flagMat);
        fl.position.set(x + 0.11, 0.8, z);
        this.scene.add(st, fl);
      }
      const lbl = new THREE.Mesh(this.track(new THREE.PlaneGeometry(1.4, 0.5)),
        this.track(new THREE.MeshStandardMaterial({ map: this.track(signTexture(THREE, [{ text: zdef.label, size: 64, y: 0.5 }], { w: 384, h: 136, bg: "#e0b33a", fg: "#2c2418" })), roughness: 0.8 })));
      lbl.rotation.x = -Math.PI / 2;
      lbl.position.set(zdef.x, 0.112, zdef.z + zdef.d / 2 - 0.7);
      this.scene.add(lbl);
      this.zones.push({ ...zdef, mesh: base });
    }
  }

  _boulders() {
    const THREE = this.THREE;
    const rng = mulberry32(this.seed + 301);
    const mat = this.track(new THREE.MeshStandardMaterial({ color: 0x8f877c, roughness: 0.93, flatShading: true }));
    // (Prompt 10: the one by the west fence moved beyond it - the loader comes in there to the oversize pile)
    const spots = [[-21.5, -26], [21, -24.5], [22.2, 7.5], [-25.6, -12.4], [9.5, 17.5], [-9, 18.2], [30, 5], [-32, -8], [26, -38], [-28, 30], [38, 26], [-6, -40]];
    for (const [x, z] of spots) {
      const r = 0.45 + rng() * 0.9;
      const geo = this.track(new THREE.IcosahedronGeometry(r, 1));
      const p = geo.attributes.position;
      for (let v = 0; v < p.count; v++) {
        const k = 0.78 + 0.35 * (noise2(p.getX(v) * 2 + x, p.getZ(v) * 2 + z, this.seed + 303) * 0.5 + 0.5);
        p.setXYZ(v, p.getX(v) * k * 1.2, p.getY(v) * k * 0.7, p.getZ(v) * k);
      }
      geo.computeVertexNormals();
      const b = new THREE.Mesh(geo, mat);
      const gy = this.groundHeightAt(x, z);
      b.position.set(x, gy + r * 0.25, z);
      b.rotation.y = rng() * 6;
      b.castShadow = true;
      b.receiveShadow = true;
      this.scene.add(b);
      if (x > CLAIM.minX && x < CLAIM.maxX && z > CLAIM.minZ && z < CLAIM.maxZ) this.colliders.push({ type: "circle", x, z, r: r * 1.15 });
    }
  }

  // small loose stones lying on the untouched pile: they go with the
  // material when that spot is dug (hidden as soon as its column changed).
  // One instanced draw call, no shadows of their own; count follows quality.
  _pebbles() {
    const THREE = this.THREE, t = this.terrain, rng = mulberry32(this.seed + 907);
    const geo = this.track(new THREE.IcosahedronGeometry(1, 0));
    const gp = geo.attributes.position;
    for (let v = 0; v < gp.count; v++) gp.setXYZ(v, gp.getX(v) * (0.85 + (v % 3) * 0.12), gp.getY(v) * 0.6, gp.getZ(v) * (0.9 + (v % 2) * 0.15));
    geo.computeVertexNormals();
    const mat = this.track(new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }));
    const max = 1300;
    const im = new THREE.InstancedMesh(geo, mat, max);
    im.name = "pile-pebbles";
    im.receiveShadow = true;
    im.castShadow = false;
    this.pebbles = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), pos = new THREE.Vector3(), col = new THREE.Color();
    // phase 8: no even scatter (it read as confetti round the base) - talus fans where the gullies run
    // out at the foot of the pile, stony patches on the rocky flanks, a few strays
    const mc = MOUND_CENTER, fans = [];
    for (let f = 0; f < 16; f++) {
      const a = (f / 16) * Math.PI * 2 + (rng() - 0.5) * 0.35;
      // the foot along this direction: the first ground lower than 0.5 m going outward
      let r = 2;
      for (; r < 13; r += 0.2) { const k = this._colAt(mc.x + Math.cos(a) * r, mc.z + Math.sin(a) * r); if (k < 0 || t.base[k] < 0.5) break; }
      fans.push({ x: mc.x + Math.cos(a) * (r - 0.4), z: mc.z + Math.sin(a) * (r - 0.4), a, len: 1.3 + rng() * 1.6, wid: 0.5 + rng() * 0.6, n: 34 + Math.floor(rng() * 40) });
    }
    const place = (x, z, s) => {
      const k = this._colAt(x, z);
      if (k < 0 || t.base[k] < 0.02 || t.base[k] > 7 || this.pebbles.length >= max) return;
      const n = this.pebbles.length;
      this.pebbles.push({ k, x, z, s, ry: rng() * 6.28, tilt: (rng() - 0.5) * 0.6 });
      // earthy greys and browns (7B), darker than before (phase 8 review: in full sun they read as white specks)
      const gray = 0.1 + rng() * 0.09, warm = 0.03 + rng() * 0.06;
      col.setRGB(gray + warm, gray + warm * 0.55, gray * 0.8);
      im.setColorAt(n, col);
    };
    for (const F of fans) {
      const ca = Math.cos(F.a), sa = Math.sin(F.a);
      for (let i = 0; i < F.n; i++) {
        // spread outward and downhill from the gully's mouth, coarser stones run furthest
        const u = Math.sqrt(rng()), v = (rng() - 0.5) * 2 * (0.3 + 0.7 * u);
        const x = F.x + ca * u * F.len - sa * v * F.wid, z = F.z + sa * u * F.len + ca * v * F.wid;
        place(x, z, 0.01 + rng() * rng() * 0.035 * (0.6 + 0.8 * u));
      }
    }
    let tries = 0;
    while (this.pebbles.length < max && tries++ < max * 4) {
      const x = t.x0 + 2 + rng() * (t.size - 4), z = t.z0 + 2 + rng() * (t.size - 4), k = this._colAt(x, z);
      if (k < 0 || t.base[k] < 0.3 || t.base[k] > 7 || rng() > t.rock[k] * 1.4) continue;      // the rocky flanks only
      // a stony patch: a few together
      for (let c = 0, nc = 3 + Math.floor(rng() * 6); c < nc; c++) place(x + (rng() - 0.5) * 0.5, z + (rng() - 0.5) * 0.5, 0.012 + rng() * rng() * 0.03);
    }
    im.count = this.pebbles.length;
    this.pebbleMax = this.pebbles.length;
    this.pebbleMesh = im;
    this._pm = { m, q, e, sc, pos };
    this.pebbles.forEach((p, n) => this._placePebble(p, n));
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    this.scene.add(im);
    this._pebbleRev = t.revision;
    this._outcrops(rng);
  }

  _colAt(x, z) {
    const t = this.terrain, i = Math.round((x - t.x0) / t.cell), j = Math.round((z - t.z0) / t.cell);
    return i < 0 || j < 0 || i >= t.vps || j >= t.vps ? -1 : j * t.vps + i;
  }

  /**
   * Phase 8: bedded rock breaking the surface on the flanks - flat, angular slabs in small groups,
   * sunk into the ground and tilted with the slope (looks only: no collision, nothing to mine; like
   * the pebbles they are gone once their ground is dug or slid). One instanced draw, shadows on.
   */
  _outcrops(rng) {
    const THREE = this.THREE, t = this.terrain, mc = MOUND_CENTER;
    const geo = this.track(new THREE.IcosahedronGeometry(1, 1));
    const gp = geo.attributes.position;
    for (let v = 0; v < gp.count; v++) {
      const x = gp.getX(v), y = gp.getY(v), z = gp.getZ(v), n = 0.82 + 0.3 * hash3(Math.round(x * 50), Math.round(y * 50), Math.round(z * 50), 71);
      gp.setXYZ(v, x * n * 1.25, y * n * 0.42, z * n);
    }
    geo.computeVertexNormals();
    const mat = this.track(new THREE.MeshStandardMaterial({ map: this.rockTex, color: 0x9a8f80, roughness: 0.86, flatShading: true }));
    const max = 44, im = new THREE.InstancedMesh(geo, mat, max);
    im.name = "pile-outcrops";
    im.castShadow = true;
    im.receiveShadow = true;
    this.outcrops = [];
    const col = new THREE.Color(), q = new THREE.Quaternion(), e = new THREE.Euler(), m = new THREE.Matrix4(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    let tries = 0;
    while (this.outcrops.length < max && tries++ < 400) {
      const a = rng() * Math.PI * 2, r = 3 + rng() * 6.5;
      const x = mc.x + Math.cos(a) * r, z = mc.z + Math.sin(a) * r, k = this._colAt(x, z);
      if (k < 0 || t.base[k] < 0.9 || t.base[k] > 5.5) continue;
      if (this.terrain.field && this.terrain.field.starter && Math.hypot(x - this.terrain.field.starter.x, z - this.terrain.field.starter.z) < 4.5) continue;   // the starting face stays clear
      // the slope here: the slabs lie with it (along the strata)
      const d = 0.25, gx = (t.getBaseHeightAt(x + d, z) - t.getBaseHeightAt(x - d, z)) / (2 * d), gz = (t.getBaseHeightAt(x, z + d) - t.getBaseHeightAt(x, z - d)) / (2 * d);
      const nc = 2 + Math.floor(rng() * 3);
      for (let c = 0; c < nc && this.outcrops.length < max; c++) {
        const ox = x + (rng() - 0.5) * 0.7, oz = z + (rng() - 0.5) * 0.7, kk = this._colAt(ox, oz);
        if (kk < 0) continue;
        const s = 0.16 + rng() * 0.26;
        const n = this.outcrops.length;
        e.set(Math.atan(gz) + (rng() - 0.5) * 0.3, rng() * 6.28, -Math.atan(gx) + (rng() - 0.5) * 0.3, "YXZ");
        m.compose(p.set(ox, t.getHeightAt(ox, oz) - s * 0.18, oz), q.setFromEuler(e), sc.set(s, s, s * (0.7 + rng() * 0.5)));
        im.setMatrixAt(n, m);
        const g = 0.78 + rng() * 0.22;
        col.setRGB(g * 1.0, g * 0.95, g * 0.88);
        im.setColorAt(n, col);
        this.outcrops.push({ k: kk, gone: false });
      }
    }
    im.count = this.outcrops.length;
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    this.outcropMesh = im;
    this.scene.add(im);
  }

  _placePebble(p, n) {
    const t = this.terrain, { m, q, e, sc, pos } = this._pm;
    if (t.qh[p.k] !== 0) m.makeScale(0, 0, 0);                        // its ground was dug / moved: gone with it
    else {
      e.set(p.tilt, p.ry, p.tilt * 0.5);
      m.compose(pos.set(p.x, t.getHeightAt(p.x, p.z) + p.s * 0.25, p.z), q.setFromEuler(e), sc.setScalar(p.s));
    }
    this.pebbleMesh.setMatrixAt(n, m);
  }

  // after digging: pebbles whose ground changed disappear
  updatePebbles() {
    const t = this.terrain;
    if (!this.pebbleMesh || this._pebbleRev === t.revision) return;
    this._pebbleRev = t.revision;
    let changed = false;
    this.pebbles.forEach((p, n) => {
      if (!p.gone && t.qh[p.k] !== 0) { p.gone = true; this._placePebble(p, n); changed = true; }
    });
    if (changed) this.pebbleMesh.instanceMatrix.needsUpdate = true;
    // the outcrops too: dug into, they are gone (looks only)
    let oc = false;
    const zero = this._pm.m;
    if (this.outcrops) this.outcrops.forEach((o, n) => { if (!o.gone && t.qh[o.k] !== 0) { o.gone = true; this.outcropMesh.setMatrixAt(n, zero.makeScale(0, 0, 0)); oc = true; } });
    if (oc) this.outcropMesh.instanceMatrix.needsUpdate = true;
  }

  // dry grass tufts (a few thin blades each, vertex-coloured - no alpha
  // texture, so no dark fringes), mostly outside the fence; count follows quality
  _grass() {
    const THREE = this.THREE;
    const rng = mulberry32(this.seed + 401);
    const pos = [], col = [], idx = [];
    const base = new THREE.Color(0x7d6a3e), tip = new THREE.Color(0xe0cf94);
    for (let b = 0; b < 11; b++) {
      const a = rng() * Math.PI * 2, lean = 0.12 + rng() * 0.28, h = 0.28 + rng() * 0.38, w = 0.025 + rng() * 0.02;
      const ox = Math.cos(a) * 0.06, oz = Math.sin(a) * 0.06;
      const px = -Math.sin(a) * w, pz = Math.cos(a) * w;
      const i0 = pos.length / 3;
      pos.push(ox - px, 0, oz - pz, ox + px, 0, oz + pz, ox + Math.cos(a) * lean, h, oz + Math.sin(a) * lean);
      col.push(base.r, base.g, base.b, base.r, base.g, base.b, tip.r, tip.g, tip.b);
      idx.push(i0, i0 + 1, i0 + 2);
    }
    const geo = this.track(new THREE.BufferGeometry());
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(pos.map((v, i) => (i % 3 === 1 ? 1 : 0)), 3));   // lit like the ground
    geo.setIndex(idx);
    const mat = this.track(new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 1 }));
    const MAX = 1400;
    const mesh = (this.grassMesh = new THREE.InstancedMesh(geo, mat, MAX));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    const t = this.terrain;
    let n = 0, guard = 0;
    while (n < MAX && guard++ < MAX * 20) {
      // clustered: pick a clump centre, then scatter a few tufts around it
      const cx = (rng() - 0.5) * 150, cz = (rng() - 0.5) * 150 - 5;
      const clump = 1 + Math.floor(rng() * 5);
      for (let c = 0; c < clump && n < MAX; c++) {
        const x = cx + (rng() - 0.5) * 2.2, z = cz + (rng() - 0.5) * 2.2;
        const inClaim = x > CLAIM.minX - 1 && x < CLAIM.maxX + 1 && z > CLAIM.minZ - 1 && z < CLAIM.maxZ + 1;
        if (inClaim) {
          const nearFence = Math.min(x - CLAIM.minX, CLAIM.maxX - x, z - CLAIM.minZ, CLAIM.maxZ - z) < 1.8;
          if (!nearFence || Math.abs(x) < 3) continue;
        }
        if (x > t.x0 && x < t.x0 + t.size && z > t.z0 && z < t.z0 + t.size) continue;
        const k = 0.8 + rng() * 1.1;
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI * 2);
        m.compose(p.set(x, this.groundHeightAt(x, z) - 0.01, z), q, sc.set(k, k * (0.7 + rng() * 0.6), k));
        mesh.setMatrixAt(n++, m);
      }
    }
    mesh.count = n;
    this.grassMax = n;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  // hazy mountain ridges on the horizon
  // two rings of distant mountains. Their haze is painted in (phase 7A) instead of
  // the scene fog, which turned them into flat beige cut-outs: the nearer ring warmer
  // with a little contrast, the far one cooler and paler, the sun side of each lit,
  // the peaks a touch lighter, the feet lost in the dust over the plain.
  _distantRidges() {
    const THREE = this.THREE, s = this.seed;
    const segs = 180, pos = [], idx = [], col = [];
    const sun = new THREE.Vector2(SUN_DIR[0], SUN_DIR[2]).normalize(), haze = new THREE.Color(0xcdb99a), c = new THREE.Color();
    for (const [radius, base, amp, seedOff, tone, mist] of [[250, 10, 48, 501, 0x86796b, 0.5], [330, 22, 78, 509, 0x8f949d, 0.66]]) {
      const start = pos.length / 3, rock = new THREE.Color(tone);
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        const h = base + amp * ridged2(Math.cos(a) * 3 + seedOff, Math.sin(a) * 3, s + seedOff, 4);
        pos.push(Math.cos(a) * radius, -10, Math.sin(a) * radius, Math.cos(a) * radius, h, Math.sin(a) * radius);
        const lit = Math.max(0, -(Math.cos(a) * sun.x + Math.sin(a) * sun.y));        // its inner face turned to the sun
        const k = 0.84 + 0.26 * lit + 0.08 * Math.max(0, (h - base) / amp);
        c.copy(rock).multiplyScalar(k).lerp(haze, mist);
        col.push(haze.r, haze.g, haze.b, c.r, c.g, c.b);                             // foot: in the dust; top: the rock in its haze
      }
      for (let i = 0; i < segs; i++) {
        const a = start + i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const g = this.track(new THREE.BufferGeometry());
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    const mat = this.track(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false }));
    const ridges = new THREE.Mesh(g, mat);
    ridges.name = "ridges";
    ridges.frustumCulled = false;
    this.scene.add(ridges);
  }

  // ------------------------------------------------------------ runtime

  // (the boulders IN the pile are goldrush-rocks.js: they settle, crack and break)

  // image-based light: the HDRI (goldrush-atmos.js: rotated to the sun, its sun clamped out, a little
  // desaturated so gold stays gold, normalised to the energy of the old analytic probe - every
  // envMapIntensity tuned before stays valid); the analytic probe when the file cannot be loaded
  async buildEnvironment(renderer) {
    const THREE = this.THREE;
    let env;
    try { env = await hdriEnvironment(THREE, renderer, HDRI_URL); } catch (e) {
      this.envError = String((e && e.message) || e);
      env = analyticEnvironment(THREE, renderer);
    }
    this.envRT = env.rt;
    this.envSource = env.source;
    this.envStats = env.stats || null;
    this.envMap = this.envRT.texture;
    // phase 7B: the camp's metal reflects the sky (without it the tank and bands read black)
    for (const m of this._metalMats || []) { m.envMap = this.envMap; m.envMapIntensity = 0.4; m.needsUpdate = true; }
    // phase 8: every standard material gets image-based light (ambient that depends on the surface: metal
    // reflects, rough wood and soil stay matte) - materials with an own envMap keep it
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 0.6;
    return this.envMap;
  }

  applyQuality(q) {
    const sun = this.sun;
    if (sun.shadow.mapSize.x !== q.shadowSize) {
      sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    this.terrain.setLod(q.terrainStride);
    if (this.grassMesh) this.grassMesh.count = Math.round(this.grassMax * q.grass);
    if (this.pebbleMesh) this.pebbleMesh.count = Math.round(this.pebbleMax * Math.max(0.4, Math.min(1, q.grass)));
    this.scene.fog.density = q.fogDensity;
  }

  // player vs. props / fence (2D circle of radius r)
  collide(pos, r) {
    const b = this.bounds;
    pos.x = Math.min(b.maxX, Math.max(b.minX, pos.x));
    pos.z = Math.min(b.maxZ, Math.max(b.minZ, pos.z));
    for (const c of this.colliders) {
      if (c.type === "circle") {
        const dx = pos.x - c.x, dz = pos.z - c.z, d = Math.hypot(dx, dz), min = c.r + r;
        if (d < min && d > 1e-6) { pos.x = c.x + (dx / d) * min; pos.z = c.z + (dz / d) * min; }
      } else {
        const cs = Math.cos(-c.rot), sn = Math.sin(-c.rot);
        const lx = (pos.x - c.x) * cs - (pos.z - c.z) * sn, lz = (pos.x - c.x) * sn + (pos.z - c.z) * cs;
        const cx = Math.max(-c.hw, Math.min(c.hw, lx)), cz = Math.max(-c.hd, Math.min(c.hd, lz));
        const dx = lx - cx, dz = lz - cz, d = Math.hypot(dx, dz);
        if (d < r) {
          let nx, nz;
          if (d > 1e-6) { nx = cx + (dx / d) * r; nz = cz + (dz / d) * r; } else {
            const px = c.hw - Math.abs(lx), pz = c.hd - Math.abs(lz);          // inside: leave by the nearest side
            if (px < pz) { nx = Math.sign(lx || 1) * (c.hw + r); nz = lz; } else { nx = lx; nz = Math.sign(lz || 1) * (c.hd + r); }
          }
          const ics = Math.cos(c.rot), isn = Math.sin(c.rot);
          pos.x = c.x + nx * ics - nz * isn;
          pos.z = c.z + nx * isn + nz * ics;
        }
      }
    }
    return pos;
  }

  groundAt(x, z) {
    const g = this.groundBelowAt(x, z);
    if (!this.heightSources.length) return g;
    let h = g;
    for (const s of this.heightSources) { const y = s.heightAt(x, z); if (y > h) h = y; }
    return h;
  }

  // the ground itself (terrain / camp ground and the decks) - what a pile lies on
  groundBelowAt(x, z) {
    const t = this.terrain;
    const g = x >= t.x0 && x <= t.x0 + t.size && z >= t.z0 && z <= t.z0 + t.size ? t.getHeightAt(x, z) : this.groundHeightAt(x, z);
    return this.decks.length ? Math.max(g, this.deckAt(x, z)) : g;
  }

  // Prompt 10: a surface lying on the ground ({ heightAt(x, z) -> world y or -Infinity }) - a stockpile
  addHeightSource(s) { if (!this.heightSources.includes(s)) this.heightSources.push(s); return s; }
  removeHeightSource(s) { const i = this.heightSources.indexOf(s); if (i >= 0) this.heightSources.splice(i, 1); }

  /**
   * Walkable timber on the claim (phase 7): an axis-aligned rectangle
   * { x0, x1, z0, z1 } whose height runs linearly from h0 (at a) to h1 (at b)
   * along `axis` ("x" | "z") - a ramp; h0 == h1: a platform. You stand / push a
   * barrow on it (groundAt is its height there); its sides are too high to
   * step onto - only the low end of a ramp is.
   */
  addDeck(d) { if (!this.decks.includes(d)) this.decks.push(d); return d; }
  removeDeck(d) { const i = this.decks.indexOf(d); if (i >= 0) this.decks.splice(i, 1); }
  deckAt(x, z) {
    let h = -Infinity;
    for (const d of this.decks) {
      if (x < d.x0 || x > d.x1 || z < d.z0 || z > d.z1) continue;
      const u = d.axis === "z" ? z : x, f = d.b === d.a ? 0 : Math.max(0, Math.min(1, (u - d.a) / (d.b - d.a)));
      h = Math.max(h, d.h0 + (d.h1 - d.h0) * f);
    }
    return h;
  }

  dispose() {
    if (this.terrain) this.terrain.dispose();
    if (this.envRT) { this.envRT.dispose(); this.envRT = null; }
    for (const d of this.disposables) { try { d.dispose(); } catch (e) { /* ignore */ } }
    this.disposables = [];
    this.scene.clear();
  }
}
