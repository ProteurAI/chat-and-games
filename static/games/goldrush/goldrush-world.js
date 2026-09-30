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
import { fbm2, hash3, mulberry32, noise2, ridged2, smoothstep } from "./goldrush-noise.js";

export const CLAIM = { minX: -24, maxX: 24, minZ: -30, maxZ: 20 };      // fenced play area
export const MOUND_CENTER = { x: 0, z: -6 };
export const SPAWN = { x: 0.6, z: 10.2, yaw: 0, pitch: 0.12 };
export const MACHINE_ZONES = [
  { id: "A", x: 18.5, z: -3, w: 6, d: 8, label: "ZONE A" },
  { id: "B", x: -18.5, z: -9, w: 6, d: 8, label: "ZONE B" },
  { id: "C", x: 15.5, z: 13, w: 7, d: 5, label: "ZONE C" },
];
const SUN_DIR = [-0.74, 0.6, 0.36];                                     // towards the sun (west, low-ish)
const FOG_COLOR = 0xd3c19f;

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
  for (let p = 0; p < 260; p++) {                                   // small pebbles, light and dark
    const x = rng() * size, y = rng() * size, r = 0.5 + rng() * rng() * 1.8;
    const l = rng() < 0.55 ? 232 + rng() * 20 : 150 + rng() * 30;
    ctx.fillStyle = `rgba(${l},${l},${l},${0.55 + rng() * 0.35})`;
    for (const [ox, oy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      ctx.beginPath();
      ctx.ellipse(x + ox, y + oy, r, r * (0.6 + rng() * 0.4), rng() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
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
    const scene = (this.scene = new THREE.Scene());
    scene.fog = new THREE.FogExp2(FOG_COLOR, 0.0062);
    scene.background = new THREE.Color(FOG_COLOR);
    this._textures();
  }

  buildTerrain() {
    this._terrain();
  }

  buildScenery() {
    this._sky();
    this._lights();
    this._ground();
    this._fence();
    this._props();
    this._machineZones();
    this._boulders();
    this._grass();
    this._distantRidges();
  }

  track(o) { this.disposables.push(o); return o; }

  // procedural for now, through the asset manager (cached, disposed with the game)
  _textures() {
    const THREE = this.THREE, a = this.assets;
    this.soilTex = a.procedural("tex:soil", () => canvasTexture(THREE, 256, (ctx, s) => soilDetail(ctx, s, this.seed + 7)));
    this.woodTex = a.procedural("tex:wood", () => canvasTexture(THREE, 256, (ctx, s) => woodPlanks(ctx, s, this.seed + 11)));
  }

  _terrain() {
    const THREE = this.THREE;
    this.terrainMaterial = this.track(new THREE.MeshStandardMaterial({
      vertexColors: true, map: this.soilTex, bumpMap: this.soilTex, bumpScale: 1.4, roughness: 0.97, metalness: 0,
    }));
    this.terrain = new DiggableTerrain(THREE, {
      seed: this.seed, center: { x: 0, z: -6 }, size: 30, cell: 0.125, chunkCells: 30,
      moundCenter: MOUND_CENTER, material: this.terrainMaterial,
    });
    this.scene.add(this.terrain.group);
  }

  _sky() {
    const THREE = this.THREE;
    const sun = new THREE.Vector3(...SUN_DIR).normalize();
    const mat = this.track(new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        uSun: { value: sun },
        uZenith: { value: new THREE.Color(0x3a74bd) },
        uHorizon: { value: new THREE.Color(0xe0cda9) },
        uGround: { value: new THREE.Color(0xb8a07e) },
      },
      vertexShader: `varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform vec3 uSun, uZenith, uHorizon, uGround; varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55));
          col = mix(col, uGround, smoothstep(0.0, -0.12, h));
          float s = max(dot(d, uSun), 0.0);
          col += vec3(1.0, 0.86, 0.62) * (pow(s, 12.0) * 0.28 + pow(s, 900.0) * 3.0);   // haze glow + sun disc
          col = mix(col, uHorizon, exp(-abs(h) * 14.0) * 0.35);                           // dusty horizon band
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }));
    const sky = new THREE.Mesh(this.track(new THREE.SphereGeometry(420, 32, 16)), mat);
    sky.name = "sky";
    sky.frustumCulled = false;
    this.scene.add(sky);
  }

  _lights() {
    const THREE = this.THREE;
    const hemi = new THREE.HemisphereLight(0xb9d0ee, 0x86684a, 0.85);
    this.scene.add(hemi);
    const sun = (this.sun = new THREE.DirectionalLight(0xffecd0, 3.5));
    const target = new THREE.Vector3(0, 0, -5);
    sun.position.set(target.x + SUN_DIR[0] * 70, SUN_DIR[1] * 70, target.z + SUN_DIR[2] * 70);
    sun.target.position.copy(target);
    sun.castShadow = true;
    const cam = sun.shadow.camera;
    cam.left = -31; cam.right = 31; cam.top = 31; cam.bottom = -31; cam.near = 20; cam.far = 140;
    sun.shadow.bias = -0.00035;
    sun.shadow.normalBias = 0.045;
    this.scene.add(sun, sun.target);
    // a faint bounce from the warm ground towards the shadowed faces
    const bounce = new THREE.DirectionalLight(0xd6b48a, 0.28);
    bounce.position.set(-SUN_DIR[0] * 40, 12, -SUN_DIR[2] * 40);
    this.scene.add(bounce);
  }

  // the ground everywhere except the mound's square (a hole, so digging below
  // 0 never shows the ground plane through the pit); flat in the claim,
  // rolling dry hills beyond the fence
  _ground() {
    const THREE = this.THREE, s = this.seed;
    const t = this.terrain, hx0 = t.x0, hx1 = t.x0 + t.size, hz0 = t.z0, hz1 = t.z0 + t.size;
    const span = 240, step = 3, n = span / step;
    const pos = [], col = [], uv = [], idx = [];
    const cA = new THREE.Color(0xb59f7d), cB = new THREE.Color(0xa38c6c), cDry = new THREE.Color(0x9f9166), cTrack = new THREE.Color(0xc1ab86);
    const tmp = new THREE.Color();
    const heightAt = (x, z) => {
      const dx = Math.max(CLAIM.minX - 6 - x, 0, x - CLAIM.maxX - 6), dz = Math.max(CLAIM.minZ - 6 - z, 0, z - CLAIM.maxZ - 6);
      const d = Math.hypot(dx, dz);
      const hills = 5 + 9 * fbm2(x * 0.012, z * 0.012, s + 201, 4) + 5 * ridged2(x * 0.02, z * 0.02, s + 207);
      return Math.max(0, hills) * smoothstep(2, 34, d) + (d > 0 ? 0.25 * fbm2(x * 0.1, z * 0.1, s + 211, 2) * smoothstep(0, 6, d) : 0);
    };
    this.groundHeightAt = heightAt;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const x = -span / 2 + i * step, z = -span / 2 + j * step;
        const y = heightAt(x, z);
        pos.push(x, y, z);
        uv.push(x * 0.5, z * 0.5);
        const v = noise2(x * 0.08, z * 0.08, s + 221) * 0.5 + 0.5;
        tmp.copy(cA).lerp(cB, v);
        tmp.lerp(cDry, smoothstep(1, 6, y) * 0.8);
        // a worn track from the gate to the mound
        const track = Math.max(0, 1 - Math.abs(x - 0.8 * Math.sin(z * 0.08)) / 3.2) * smoothstep(CLAIM.maxZ + 2, 6, z) * (z > -2 ? 1 : 0);
        tmp.lerp(cTrack, track * 0.6);
        col.push(tmp.r, tmp.g, tmp.b);
      }
    }
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
    const mat = this.track(new THREE.MeshStandardMaterial({ vertexColors: true, map: this.soilTex, bumpMap: this.soilTex, bumpScale: 1.0, roughness: 0.98 }));
    const ground = new THREE.Mesh(g, mat);
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
    const rust = this.track(new THREE.MeshStandardMaterial({ color: 0x8a4e2c, roughness: 0.75, metalness: 0.2 }));
    const roofMat = this.track(new THREE.MeshStandardMaterial({ color: 0x7d8286, roughness: 0.6, metalness: 0.3 }));

    // tool shed (north-west of the gate)
    const sx = -18.2, sz = 13.2;
    this._box(4.2, 2.6, 3.2, wood, sx, 1.3, sz);
    const roof = new THREE.Mesh(this.track(new THREE.BoxGeometry(4.8, 0.1, 3.9)), roofMat);
    roof.position.set(sx, 2.75, sz);
    roof.rotation.x = -0.12;
    roof.castShadow = true;
    this.scene.add(roof);
    this._box(1.05, 1.95, 0.08, darkWood, sx + 0.9, 0.98, sz - 1.62, 0, false);                 // door
    const winMat = this.track(new THREE.MeshStandardMaterial({ color: 0x2b3440, roughness: 0.25, metalness: 0.1 }));
    this._box(0.8, 0.6, 0.06, winMat, sx - 1.1, 1.6, sz - 1.62, 0, false);                      // window

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

    // water tank (for the wash plant that will come)
    const tank = new THREE.Mesh(this.track(new THREE.CylinderGeometry(1.25, 1.25, 2.3, 24)), metal);
    tank.position.set(-19.5, 1.9, 1.8);
    tank.castShadow = true;
    tank.receiveShadow = true;
    this.scene.add(tank);
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
    const spots = [[-21.5, -26], [21, -24.5], [22.2, 7.5], [-22, -12], [9.5, 17.5], [-9, 18.2], [30, 5], [-32, -8], [26, -38], [-28, 30], [38, 26], [-6, -40]];
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
  _distantRidges() {
    const THREE = this.THREE, s = this.seed;
    const segs = 180, pos = [], idx = [];
    for (const [radius, base, amp, seedOff] of [[250, 10, 48, 501], [330, 22, 78, 509]]) {
      const start = pos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        const h = base + amp * ridged2(Math.cos(a) * 3 + seedOff, Math.sin(a) * 3, s + seedOff, 4);
        pos.push(Math.cos(a) * radius, -10, Math.sin(a) * radius, Math.cos(a) * radius, h, Math.sin(a) * radius);
      }
      for (let i = 0; i < segs; i++) {
        const a = start + i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const g = this.track(new THREE.BufferGeometry());
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    const mat = this.track(new THREE.MeshBasicMaterial({ color: 0x8d8a86, side: THREE.DoubleSide }));
    const ridges = new THREE.Mesh(g, mat);
    ridges.name = "ridges";
    ridges.frustumCulled = false;
    this.scene.add(ridges);
  }

  // ------------------------------------------------------------ runtime

  applyQuality(q) {
    const sun = this.sun;
    if (sun.shadow.mapSize.x !== q.shadowSize) {
      sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    this.terrain.setLod(q.terrainStride);
    if (this.grassMesh) this.grassMesh.count = Math.round(this.grassMax * q.grass);
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
    const t = this.terrain;
    if (x >= t.x0 && x <= t.x0 + t.size && z >= t.z0 && z <= t.z0 + t.size) return t.getHeightAt(x, z);
    return this.groundHeightAt(x, z);
  }

  dispose() {
    if (this.terrain) this.terrain.dispose();
    for (const d of this.disposables) { try { d.dispose(); } catch (e) { /* ignore */ } }
    this.disposables = [];
    this.scene.clear();
  }
}
