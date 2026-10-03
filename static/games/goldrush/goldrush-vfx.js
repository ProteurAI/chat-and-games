// GoldRush - dig feedback: what a hit throws up, by material and by tool.
//
// Every impact has up to three layers, all from fixed pools created once
// (nothing is allocated per hit):
//   MICRO DUST   soft billboards                     - one Points draw call
//   DEBRIS       crumbs / pebbles / sharp stone chips  \  one InstancedMesh
//   CHUNKS       a few bigger clods or stones          /  draw call
// Debris and chunks fly ballistically (gravity, a little drag), land on the
// real ground, bounce by material (soil: hardly; gravel: a few short
// clicks; stone chips: a little) and stay lying for a few seconds as micro
// debris before they sink away. Directions follow the tool: a pick throws
// chips sideways / out of the face, a shovel's material flows back along the
// scoop, the hand only loosens crumbs. Colours come from the ground that was
// hit (the terrain's own vertex colour there), so no two spots look the same.
//
// "Nachrieseln": after a cut into a steep fresh face, a few crumbs trickle
// down it a moment later - VISUAL ONLY: no terrain, no mass, no gold changes.
//
// Density follows the graphics quality (LOW fewer, HIGH more); what is dug
// never depends on it.

const DUST_MAX = 320;
const FRAG_MAX = 260;
const QUEUE_MAX = 8;
const GRAVITY = 9.81;

// shapes (per-instance scale of one faceted rock): soil crumbs and clods are
// lumpy, pebbles rounded, stone chips flat and sharp
// (pebbles a little darker than raw rock and mixed with the ground: light, but no white sparks in the sun)
const ROCK_GREY = [0.25, 0.24, 0.22], PEBBLE_GREY = [0.2, 0.183, 0.163];
const SHAPE = { crumb: [1, 0.8, 0.9], clod: [1, 0.72, 0.95], pebble: [0.95, 0.68, 0.82], chip: [1, 0.3, 0.68] };

// per material (MAT index): the three layers - count at medium density,
// size range (m), launch speed (m/s), restitution, how long it lies (s)
const PROFILES = [
  { // DIRT - soft: a puff of fine dust, crumbs, a few loose clods; no bounce
    dust: { n: 14, s0: 0.1, s1: 0.24, speed: 0.75, life: 1.15, alpha: 0.44, tint: 1.1 },
    debris: { n: 9, s0: 0.006, s1: 0.013, speed: 1.3, bounce: 0.07, rest: 4.5, shape: "crumb", tint: 0.8 },
    chunks: { n: 0.7, s0: 0.022, s1: 0.04, speed: 1.1, bounce: 0.04, rest: 6, shape: "clod", tint: 0.76 },      // big clods: rare
  },
  { // COMPACT DIRT - harder: less dust, firm heavy lumps, a duller impact
    dust: { n: 6, s0: 0.08, s1: 0.18, speed: 0.55, life: 0.9, alpha: 0.36, tint: 1.05 },
    debris: { n: 7, s0: 0.008, s1: 0.017, speed: 1.15, bounce: 0.1, rest: 5, shape: "clod", tint: 0.72 },
    chunks: { n: 4, s0: 0.026, s1: 0.052, speed: 0.95, bounce: 0.07, rest: 7, shape: "clod", tint: 0.68 },
  },
  { // GRAVEL - grainy: many pebbles with a few short clicks, little dust
    dust: { n: 4, s0: 0.07, s1: 0.15, speed: 0.5, life: 0.8, alpha: 0.28, tint: 1.0 },
    debris: { n: 15, s0: 0.007, s1: 0.016, speed: 1.9, bounce: 0.34, rest: 6, shape: "pebble", stone: true },
    chunks: { n: 2, s0: 0.018, s1: 0.03, speed: 1.6, bounce: 0.28, rest: 8, shape: "pebble", stone: true },
  },
  { // STONE - hard: sharp chips, fast and focused, almost no dust, no sparks
    dust: { n: 2, s0: 0.05, s1: 0.1, speed: 0.4, life: 0.6, alpha: 0.24, tint: 1.15 },
    debris: { n: 11, s0: 0.004, s1: 0.01, speed: 3.1, bounce: 0.3, rest: 5, shape: "chip", stone: true },
    chunks: { n: 2, s0: 0.012, s1: 0.022, speed: 2.3, bounce: 0.24, rest: 7, shape: "chip", stone: true },
  },
];

// per tool: how much of each layer, how big, how fast, which way
const TOOLS = {
  hand: { count: 0.42, dust: 0.55, chunks: 0.2, size: 0.8, speed: 0.5, mode: "hand" },
  shovel: { count: 1.45, dust: 1.25, chunks: 1.8, size: 1.05, speed: 0.9, mode: "scoop" },
  pickaxe: { count: 1.0, dust: 0.75, chunks: 0.9, size: 0.95, speed: 1.3, mode: "strike" },
  rock: { count: 1.5, dust: 1.1, chunks: 2.6, size: 1.35, speed: 1.15, mode: "strike" },      // a boulder breaking apart
};

export class DigEffects {
  constructor(THREE, scene, terrain) {
    this.THREE = THREE;
    this.terrain = terrain;
    this.dustLimit = 160;
    this.fragLimit = 150;
    this.density = 1;

    // ---- micro dust: soft round billboards, size in world units
    this.dust = [];
    const pos = new Float32Array(DUST_MAX * 3), col = new Float32Array(DUST_MAX * 3);
    const alpha = new Float32Array(DUST_MAX), size = new Float32Array(DUST_MAX);
    for (let i = 0; i < DUST_MAX; i++) this.dust.push({ life: 0, max: 1, x: 0, y: -99, z: 0, vx: 0, vy: 0, vz: 0, s: 0.2, r: 0, g: 0, b: 0, a: 0.42 });
    const g = (this.dustGeo = new THREE.BufferGeometry());
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1));
    g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -6), 60);
    this.dustMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: true, vertexColors: true,
      uniforms: { uScale: { value: 400 }, ...THREE.UniformsLib.fog },
      vertexShader: `
        attribute float aAlpha; attribute float aSize; varying float vAlpha; varying vec3 vColor; uniform float uScale;
        #include <fog_pars_vertex>
        void main() {
          vAlpha = aAlpha; vColor = color;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(0.1, -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        varying float vAlpha; varying vec3 vColor;
        #include <fog_pars_fragment>
        void main() {
          vec2 c = gl_PointCoord - 0.5; float d = dot(c, c) * 4.0;
          float a = vAlpha * smoothstep(1.0, 0.0, d);
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor, a);
          #include <fog_fragment>
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.dustPoints = new THREE.Points(g, this.dustMat);
    this.dustPoints.frustumCulled = false;
    this.dustPoints.renderOrder = 2;
    scene.add(this.dustPoints);

    // ---- debris + chunks + lying micro debris: one faceted rock, scaled per instance
    const fg = (this.fragGeo = new THREE.IcosahedronGeometry(1, 0));
    const p = fg.attributes.position;
    for (let v = 0; v < p.count; v++) p.setXYZ(v, p.getX(v) * (0.8 + (v % 3) * 0.15), p.getY(v) * 0.75, p.getZ(v) * (0.9 + (v % 2) * 0.12));
    fg.computeVertexNormals();
    this.fragMat = new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true });
    this.frags = new THREE.InstancedMesh(fg, this.fragMat, FRAG_MAX);
    this.frags.frustumCulled = false;
    this.frags.castShadow = false;
    this.fragState = [];
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0), white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < FRAG_MAX; i++) {
      this.frags.setMatrixAt(i, hidden);
      this.frags.setColorAt(i, white);
      this.fragState.push({ on: false, phase: 0, t: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, sx: 0, sz: 0,
        s: 0.03, kx: 1, ky: 1, kz: 1, bounce: 0, hops: 0, rest: 0, slide: false, layer: 0 });
    }
    scene.add(this.frags);
    this.queue = [];
    for (let i = 0; i < QUEUE_MAX; i++) this.queue.push({ t: -1, x: 0, y: 0, z: 0, gx: 0, gz: 0, mat: 0 });
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3();
    this._sc = new THREE.Vector3();
    this._c = new THREE.Color();
    this._n = new THREE.Vector3();
    this._t = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._vel = new THREE.Vector3();
    this._tc = [0.4, 0.3, 0.2];
    this.activeDust = 0;
    this.activeFrags = 0;
    this.lying = 0;
    this.trickles = 0;
    this.impacts = 0;
    this.onTrickle = null;           // (x, y, z) -> a quiet sound
    this._seed = 1;
    this._dirty = false;
  }

  _rand() { this._seed = (this._seed * 16807) % 2147483647; return this._seed / 2147483647; }
  // a count from an expected value: 0.7 -> one piece 70 % of the time (rare things stay rare)
  _count(x) { const f = Math.floor(x); return f + (this._rand() < x - f ? 1 : 0); }

  // pool limits from the graphics quality (renderer QUALITY): LOW fewer, HIGH more
  setLimits(dust, frags) {
    this.dustLimit = Math.min(DUST_MAX, dust);
    this.fragLimit = Math.min(FRAG_MAX, frags);
    this.density = Math.max(0.35, Math.min(1.6, this.fragLimit / 150));
  }

  setScale(px) { this.dustMat.uniforms.uScale.value = px; }

  pools() { return { dust: DUST_MAX, frags: FRAG_MAX, dustLimit: this.dustLimit, fragLimit: this.fragLimit, density: this.density }; }

  // tests: what is in the air / on the ground right now, by layer (lying pieces are counted in their layer too)
  stats() {
    const out = { dust: 0, debris: 0, chunks: 0, trickle: 0, lying: this.lying, flat: 0, bounced: 0, sizeDebris: 0, sizeChunks: 0, speed: 0 };
    for (const d of this.dust) if (d.life > 0) out.dust++;
    let sp = 0, n = 0;
    for (const f of this.fragState) {
      if (!f.on) continue;
      if (f.layer === 1) { out.debris++; out.sizeDebris += f.s; } else if (f.layer === 2) { out.chunks++; out.sizeChunks += f.s; } else if (f.layer === 3) out.trickle++;
      if (f.ky < 0.45) out.flat++;
      if (f.hops > 0) out.bounced++;
      if (f.phase === 0) { sp += Math.hypot(f.vx, f.vy, f.vz); n++; }
    }
    if (out.debris) out.sizeDebris /= out.debris;
    if (out.chunks) out.sizeChunks /= out.chunks;
    out.speed = n ? sp / n : 0;
    return out;
  }

  // tests: everything gone at once (a clean start for a measurement)
  clear() {
    for (const d of this.dust) d.life = 0;
    for (const f of this.fragState) f.on = false;
    for (const q of this.queue) q.t = -1;
    const m = this._m.makeScale(0, 0, 0);
    for (let i = 0; i < FRAG_MAX; i++) this.frags.setMatrixAt(i, m);
    this.frags.instanceMatrix.needsUpdate = true;
    this.update(0);
  }

  // surface frame at the hit: n (out of the ground), t (the tool's way along the surface), b (sideways)
  _basis(normal, dir) {
    const n = this._n.set(normal.x, normal.y, normal.z).normalize(), t = this._t;
    const d = dir || this._v.set(0, -1, 0);
    t.set(d.x, d.y, d.z).addScaledVector(n, -n.dot(d));
    if (t.lengthSq() < 0.04) t.set(0, 1, 0).addScaledVector(n, -n.y);           // straight into the face: "up the face"
    if (t.lengthSq() < 1e-6) t.set(1, 0, 0);
    t.normalize();
    this._b.crossVectors(n, t).normalize();
  }

  // a launch velocity for this tool's way of throwing material
  _launch(mode, speed) {
    const n = this._n, t = this._t, b = this._b, v = this._vel;
    const side = this._rand() < 0.5 ? -1 : 1;
    if (mode === "strike") {                    // out of the face and to the sides, a little back towards you
      v.copy(n).multiplyScalar(speed * (0.4 + 0.55 * this._rand()));
      v.addScaledVector(b, side * speed * (0.45 + 0.85 * this._rand()));
      v.addScaledVector(t, -speed * (0.1 + 0.35 * this._rand()));
      v.y += speed * (0.25 + 0.35 * this._rand());
    } else if (mode === "scoop") {              // along the scoop: back towards you and up, spilling off the blade
      v.copy(t).multiplyScalar(-speed * (0.45 + 0.65 * this._rand()));
      v.addScaledVector(n, speed * (0.15 + 0.35 * this._rand()));
      v.addScaledVector(b, side * speed * (0.1 + 0.3 * this._rand()));
      v.y += speed * (0.55 + 0.55 * this._rand());
    } else {                                    // the hand: crumbs loosened right where the fingers are
      v.copy(n).multiplyScalar(speed * (0.25 + 0.4 * this._rand()));
      v.addScaledVector(b, side * speed * (0.1 + 0.3 * this._rand()));
      v.addScaledVector(t, -speed * 0.2 * this._rand());
      v.y += speed * (0.2 + 0.4 * this._rand());
    }
    return v;
  }

  /**
   * One hit. hit: { x, y, z, normal }, mat: MAT index, tool: "hand" |
   * "shovel" | "pickaxe" | "rock", dir: the tool's motion (camera forward),
   * strength ~0.5..1.5 (how much came loose)
   */
  impact(hit, mat, tool, dir, strength = 1) {
    const P = PROFILES[mat] || PROFILES[0], T = TOOLS[tool] || TOOLS.hand;
    const k = this.density * Math.max(0.2, Math.min(1.6, strength));
    this._basis(hit.normal || this._v.set(0, 1, 0), dir);
    const tc = this._tc;
    if (!(this.terrain.surfaceColor && this.terrain.surfaceColor(hit.x, hit.z, tc))) { tc[0] = 0.42; tc[1] = 0.3; tc[2] = 0.2; }
    this.impacts++;
    this._dust(hit, P.dust, this._count(P.dust.n * T.dust * k), T, mat);
    this._frags(hit, P.debris, this._count(P.debris.n * T.count * k), T, mat, 1);
    const nc = this._count(P.chunks.n * T.chunks * Math.min(1.3, k));
    this._frags(hit, P.chunks, tool === "hand" ? Math.min(nc, 1) : nc, T, mat, 2);
  }

  _dust(hit, L, n, T, mat) {
    const tc = this._tc, n0 = this._n, t = this._t;
    for (let k = 0, placed = 0; k < DUST_MAX && placed < n && k < this.dustLimit; k++) {
      const d = this.dust[k];
      if (d.life > 0) continue;
      const r = this._rand();
      d.max = d.life = L.life * (0.6 + 0.7 * this._rand());
      d.x = hit.x + n0.x * 0.04 + (this._rand() - 0.5) * 0.16;
      d.y = hit.y + n0.y * 0.04 + 0.02;
      d.z = hit.z + n0.z * 0.04 + (this._rand() - 0.5) * 0.16;
      const sp = L.speed * (0.4 + 0.8 * r) * (T.mode === "hand" ? 0.6 : 1);
      d.vx = n0.x * sp - t.x * sp * 0.4 + (this._rand() - 0.5) * 0.5;
      d.vy = 0.12 + this._rand() * 0.3;
      d.vz = n0.z * sp - t.z * sp * 0.4 + (this._rand() - 0.5) * 0.5;
      d.s = (L.s0 + (L.s1 - L.s0) * this._rand()) * (T.mode === "hand" ? 0.75 : 1);
      // a lighter, drier version of the ground's colour (stone: grey rock dust)
      const v = L.tint * (0.9 + this._rand() * 0.2);
      if (mat === 3) { d.r = 0.25 * v; d.g = 0.24 * v; d.b = 0.22 * v; } else { d.r = tc[0] * 0.62 * v; d.g = tc[1] * 0.6 * v; d.b = tc[2] * 0.58 * v; }
      d.a = L.alpha;
      placed++;
    }
  }

  _frags(hit, L, n, T, mat, layer) {
    if (n <= 0) return;
    const tc = this._tc, n0 = this._n, sh = SHAPE[L.shape] || SHAPE.clod;
    for (let k = 0, placed = 0; k < FRAG_MAX && placed < n; k++) {
      if (k >= this.fragLimit) break;
      const f = this.fragState[k];
      if (f.on) continue;
      this._place(f, hit.x + n0.x * 0.03, hit.y + n0.y * 0.03 + 0.02, hit.z + n0.z * 0.03);
      const v = this._launch(T.mode, L.speed * T.speed * (0.75 + 0.5 * this._rand()));
      f.vx = v.x; f.vy = v.y; f.vz = v.z;
      f.s = (L.s0 + (L.s1 - L.s0) * this._rand()) * T.size;
      f.kx = sh[0] * (0.85 + 0.3 * this._rand()); f.ky = sh[1] * (0.85 + 0.3 * this._rand()); f.kz = sh[2] * (0.85 + 0.3 * this._rand());
      f.bounce = L.bounce; f.rest = L.rest * (0.7 + 0.6 * this._rand()); f.layer = layer;
      f.sx = (this._rand() - 0.5) * (L.shape === "chip" ? 22 : 12); f.sz = (this._rand() - 0.5) * (L.shape === "chip" ? 22 : 12);
      this._color(k, L, mat, tc);
      placed++;
    }
    this._dirty = true;
  }

  _place(f, x, y, z) {
    f.on = true; f.phase = 0; f.t = 0; f.hops = 0; f.slide = false;
    f.x = x; f.y = y; f.z = z;
    f.rx = this._rand() * 6; f.ry = this._rand() * 6; f.rz = this._rand() * 6;
  }

  _color(k, L, mat, tc) {
    const v = 0.85 + this._rand() * 0.3;
    if (L.stone) {                                          // pebbles / chips: grey-brown rock, a little varied
      const base = mat === 3 ? ROCK_GREY : PEBBLE_GREY;
      const w = mat === 3 ? this._rand() * 0.25 : 0.15 + this._rand() * 0.3, g = mat === 3 ? 1 : 0.5;     // pebbles: the ground's colour (as rendered) mixed in
      const q = mat !== 3 && this._rand() < 0.1 ? 1.25 : 1;                                              // now and then a lighter quartz pebble
      this._c.setRGB((base[0] * (1 - w) + tc[0] * g * w) * v * q, (base[1] * (1 - w) + tc[1] * g * w) * v * q, (base[2] * (1 - w) + tc[2] * g * w) * v * q);
    } else {                                                // soil: the ground's own colour (as rendered: x0.5), moist and darker
      const t = (L.tint || 0.8) * v * 0.5;
      this._c.setRGB(tc[0] * t, tc[1] * t, tc[2] * t);
    }
    this.frags.setColorAt(k, this._c);
  }

  // legacy entry (older call sites): a hit without a tool direction
  burst(hit, def, strength = 1) {
    const mat = def && Number.isInteger(def.index) ? def.index : 0;
    this.impact(hit, mat, "pickaxe", null, strength);
  }

  // material sliding off a shovel blade / out of a bucket or a barrow:
  // clods dropping from a point (world space), a low puff where they land
  spill(x, y, z, def, strength = 1) {
    this.spills = (this.spills || 0) + 1;
    const mat = def && Number.isInteger(def.index) ? def.index : 0, P = PROFILES[mat] || PROFILES[0];
    const tc = this._tc;
    if (!(this.terrain.surfaceColor && this.terrain.surfaceColor(x, z, tc))) { tc[0] = 0.42; tc[1] = 0.3; tc[2] = 0.2; }
    const nFrag = Math.round(Math.min(8, 2 + this.fragLimit / 30) * strength * this.density);
    const sh = SHAPE[P.debris.shape] || SHAPE.clod;
    for (let k = 0, placed = 0; k < FRAG_MAX && placed < nFrag; k++) {
      if (k >= this.fragLimit) break;
      const f = this.fragState[k];
      if (f.on) continue;
      this._place(f, x + (this._rand() - 0.5) * 0.12, y, z + (this._rand() - 0.5) * 0.12);
      f.vx = (this._rand() - 0.5) * 0.6; f.vy = -0.2 + this._rand() * 0.5; f.vz = (this._rand() - 0.5) * 0.6;
      f.s = (placed % 3 === 0 ? 0.02 + this._rand() * 0.025 : 0.008 + this._rand() * 0.012);
      f.kx = sh[0]; f.ky = sh[1]; f.kz = sh[2];
      f.bounce = P.debris.bounce; f.rest = 2 + this._rand() * 2; f.layer = 1;
      f.sx = (this._rand() - 0.5) * 8; f.sz = (this._rand() - 0.5) * 8;
      this._color(k, placed % 3 === 0 ? P.chunks : P.debris, mat, tc);
      placed++;
    }
    this._dirty = true;
    const g = this.terrain.getHeightAt(x, z);
    const nDust = Math.round(Math.min(10, this.dustLimit / 14) * strength * (def ? def.dustAmount : 1) * this.density);
    for (let k = 0, placed = 0; k < DUST_MAX && placed < nDust && k < this.dustLimit; k++) {
      const d = this.dust[k];
      if (d.life > 0) continue;
      d.max = d.life = 0.6 + this._rand() * 0.6;
      d.x = x + (this._rand() - 0.5) * 0.3; d.y = Math.max(g + 0.05, y - 0.3 - this._rand() * 0.3); d.z = z + (this._rand() - 0.5) * 0.3;
      d.vx = (this._rand() - 0.5) * 0.7; d.vy = 0.05 + this._rand() * 0.2; d.vz = (this._rand() - 0.5) * 0.7;
      d.s = 0.1 + this._rand() * 0.12;
      const v = 0.95 + this._rand() * 0.2;
      d.r = tc[0] * 0.62 * v; d.g = tc[1] * 0.6 * v; d.b = tc[2] * 0.58 * v; d.a = 0.4;
      placed++;
    }
  }

  /**
   * Nachrieseln (visual only): a few crumbs set off from just above a fresh,
   * steep cut a moment later and trickle down the slope. (x, y, z) where they
   * start, (gx, gz) the downhill direction, delay in seconds.
   */
  queueTrickle(x, y, z, gx, gz, mat, delay) {
    let q = null;
    for (const e of this.queue) if (e.t < 0) { q = e; break; }
    if (!q) return false;
    q.t = delay; q.x = x; q.y = y; q.z = z; q.gx = gx; q.gz = gz; q.mat = mat;
    return true;
  }

  _trickle(q) {
    const P = PROFILES[q.mat] || PROFILES[0], tc = this._tc;
    if (!(this.terrain.surfaceColor && this.terrain.surfaceColor(q.x, q.z, tc))) { tc[0] = 0.42; tc[1] = 0.3; tc[2] = 0.2; }
    const n = Math.max(2, Math.round((3 + this._rand() * 3) * this.density));
    const sh = SHAPE[P.debris.shape] || SHAPE.crumb;
    for (let k = 0, placed = 0; k < FRAG_MAX && placed < n; k++) {
      if (k >= this.fragLimit) break;
      const f = this.fragState[k];
      if (f.on) continue;
      this._place(f, q.x + (this._rand() - 0.5) * 0.1, q.y + this._rand() * 0.03, q.z + (this._rand() - 0.5) * 0.1);
      const sp = 0.25 + this._rand() * 0.35;
      f.vx = q.gx * sp; f.vy = -0.1; f.vz = q.gz * sp;
      f.s = 0.005 + this._rand() * 0.009;
      f.kx = sh[0]; f.ky = sh[1]; f.kz = sh[2];
      f.bounce = 0.05; f.rest = 1.5 + this._rand() * 1.5; f.layer = 3; f.slide = true;
      f.sx = (this._rand() - 0.5) * 6; f.sz = (this._rand() - 0.5) * 6;
      this._color(k, P.debris, q.mat, tc);
      placed++;
    }
    this._dirty = true;
    this.trickles++;
    if (this.onTrickle) this.onTrickle(q.x, q.y, q.z);
  }

  update(dt) {
    // queued trickles
    for (const q of this.queue) {
      if (q.t < 0) continue;
      q.t -= dt;
      if (q.t <= 0) { q.t = -1; this._trickle(q); }
    }
    // dust
    const pos = this.dustGeo.attributes.position.array, col = this.dustGeo.attributes.color.array;
    const alpha = this.dustGeo.attributes.aAlpha.array, size = this.dustGeo.attributes.aSize.array;
    let active = 0, dustChanged = false;
    for (let i = 0; i < DUST_MAX; i++) {
      const d = this.dust[i];
      if (d.life > 0) {
        d.life -= dt;
        const drag = Math.exp(-2.4 * dt);
        d.vx *= drag; d.vz *= drag; d.vy = d.vy * drag - 0.28 * dt;          // a puff that spreads and settles, not a smoke column
        d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
        const t = Math.max(0, d.life / d.max);
        pos[i * 3] = d.x; pos[i * 3 + 1] = d.y; pos[i * 3 + 2] = d.z;
        col[i * 3] = d.r; col[i * 3 + 1] = d.g; col[i * 3 + 2] = d.b;
        alpha[i] = Math.min(1, (1 - t) * 6) * t * d.a;
        size[i] = d.s * (1.6 - t * 0.9);
        active++;
        dustChanged = true;
      } else if (alpha[i] !== 0) {
        alpha[i] = 0;
        pos[i * 3 + 1] = -99;
        dustChanged = true;
      }
    }
    if (dustChanged) {
      this.dustGeo.attributes.position.needsUpdate = true;
      this.dustGeo.attributes.color.needsUpdate = true;
      this.dustGeo.attributes.aAlpha.needsUpdate = true;
      this.dustGeo.attributes.aSize.needsUpdate = true;
    }
    this.activeDust = active;

    // debris / chunks / lying micro debris
    let frags = 0, lying = 0;
    const m = this._m, q = this._q, e = this._e, v = this._v, sc = this._sc, T = this.terrain;
    for (let i = 0; i < FRAG_MAX; i++) {
      const f = this.fragState[i];
      if (!f.on) continue;
      f.t += dt;
      const lift = f.s * f.ky * 0.55;
      if (f.phase === 0) {                                   // flying
        f.vy -= GRAVITY * dt;
        const drag = Math.exp(-0.35 * dt);
        f.vx *= drag; f.vz *= drag;
        f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
        f.rx += f.sx * dt; f.rz += f.sz * dt;
        const ground = T.getHeightAt(f.x, f.z) + lift;
        if (f.y < ground) {
          f.y = ground;
          if (f.slide && this._slope(f) > 0.5) { f.phase = 3; }
          else if (-f.vy > 1.0 && f.bounce > 0.05 && f.hops < 3) {     // a short click / hop (gravel, chips)
            f.vy = -f.vy * f.bounce; f.vx *= 0.55; f.vz *= 0.55; f.sx *= 0.5; f.sz *= 0.5; f.hops++;
          } else { f.phase = 1; f.vx = f.vz = f.vy = 0; f.t = 0; }
        }
        if (f.t > 4) { f.phase = 2; f.t = 0; }               // never forever in the air (fell off the world)
      } else if (f.phase === 3) {                            // trickling down a steep fresh face
        const gx = this._gx, gz = this._gz, sl = this._slope(f);
        if (sl < 0.45 || f.t > 2.5) { f.phase = 1; f.t = 0; }
        else {
          const acc = GRAVITY * (sl / Math.sqrt(1 + sl * sl)) * 0.55;
          f.vx += (gx / sl) * acc * dt; f.vz += (gz / sl) * acc * dt;
          const sp = Math.hypot(f.vx, f.vz), max = 1.2;
          if (sp > max) { f.vx *= max / sp; f.vz *= max / sp; }
          f.x += f.vx * dt; f.z += f.vz * dt;
          f.y = T.getHeightAt(f.x, f.z) + lift;
          f.rx += f.sx * dt * 2; f.rz += f.sz * dt * 2;
        }
      } else if (f.phase === 1) {                            // lying on the ground: micro debris
        const ground = T.getHeightAt(f.x, f.z) + lift;
        if (ground < f.y - 0.03) { f.phase = 0; f.vx = f.vz = 0; f.vy = 0; f.t = 0; }   // the ground under it was dug away: it falls
        else f.y = ground;
        if (f.t > f.rest) { f.phase = 2; f.t = 0; }
        lying++;
      } else if (f.t > 0.6) {                                // sunk away
        f.on = false;
        m.makeScale(0, 0, 0);
        this.frags.setMatrixAt(i, m);
        this._dirty = true;
        continue;
      }
      const fade = f.phase === 2 ? Math.max(0, 1 - f.t / 0.6) : 1;
      e.set(f.rx, f.ry, f.rz);
      q.setFromEuler(e);
      m.compose(v.set(f.x, f.y - (1 - fade) * f.s, f.z), q, sc.set(f.s * f.kx * fade, f.s * f.ky * fade, f.s * f.kz * fade));
      this.frags.setMatrixAt(i, m);
      frags++;
      this._dirty = true;
    }
    if (this._dirty) {
      this.frags.instanceMatrix.needsUpdate = true;
      if (this.frags.instanceColor) this.frags.instanceColor.needsUpdate = true;
      this._dirty = frags > 0;
    }
    this.activeFrags = frags;
    this.lying = lying;
  }

  // ground slope (rise per metre) under a piece; leaves the downhill direction in _gx/_gz
  _slope(f) {
    const T = this.terrain, d = 0.08;
    const gx = (T.getHeightAt(f.x - d, f.z) - T.getHeightAt(f.x + d, f.z)) / (2 * d);
    const gz = (T.getHeightAt(f.x, f.z - d) - T.getHeightAt(f.x, f.z + d)) / (2 * d);
    this._gx = gx; this._gz = gz;
    return Math.hypot(gx, gz);
  }

  dispose() {
    this.dustGeo.dispose();
    this.dustMat.dispose();
    this.fragGeo.dispose();
    this.fragMat.dispose();
    this.frags.dispose();
  }
}

export { PROFILES as DIG_PROFILES, TOOLS as DIG_TOOLS };
