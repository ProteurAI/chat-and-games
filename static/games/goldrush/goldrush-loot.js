// GoldRush - finds you can see. Gold dust is a short glitter at the dig
// spot; flakes, tiny pieces and small nuggets are real little metal
// objects that pop out of the ground, land, catch the sun and are then
// pulled in (pickup). A nugget ends up in the player's hand for a moment.
//
// The economy lists every find as PENDING from the moment of the dig and
// books it when this module reports it collected: every shown piece
// reports back exactly once (onCollect, with the find's id), and nothing is
// ever dropped: pieces left behind are pulled in after a few seconds,
// flush() collects all at once (exit, hidden tab). Everything is pooled -
// no allocation per find.

import { FIND, jackpotTier } from "./goldrush-resources.js";
import { mulberry32, noise3 } from "./goldrush-noise.js";

const GRAVITY = 9.81;
const GLINT_MAX = 64;
const PICKUP_RANGE = 3.5;        // m: pieces lying closer are pulled in after their short rest
const GIVE_UP = 6;               // s: then they come from anywhere
const REST = { [FIND.FLAKE]: 0.45, [FIND.TINY]: 0.8, [FIND.NUGGET]: 1.0 };
const POOL = { [FIND.FLAKE]: 10, [FIND.TINY]: 8, [FIND.NUGGET]: 3 };
const SPECKS = 32;               // fine-gold flitter in flight at most (one instanced draw)

// How a find looks - true to what it is worth (phase 7A): gold dust and fine gold
// are a few tiny specks, a flake stays well under a fingertip, a tiny piece is a
// small lump, only a real nugget (EUR 1-4) is a proper little nugget you hold up.
// size: mesh radius in m (pieces are drawn a little larger than life so a 5 mm
// flake still reads from standing height), from the cheapest to the dearest of
// the class (by value, logarithmic). Prompt 10: a big nugget above the class's
// EUR 4 grows with the fourth root of its value - between the cube root of its
// mass and what still reads as a piece of gold, not a prop: EUR 10 ~1,25x,
// EUR 30 ~1,65x, EUR 80 ~2,1x the radius of a EUR 4 one.
export const FIND_LOOK = {
  [FIND.TRACE]: { kind: "speck", specks: 2, size: [0.0018, 0.0026], cents: [1, 3], glint: [0.016, 0.026], glints: 2 },
  [FIND.FINE]: { kind: "speck", specks: 4, size: [0.0022, 0.0032], cents: [3, 8], glint: [0.02, 0.034], glints: 3 },
  [FIND.FLAKE]: { kind: "flake", size: [0.0045, 0.0068], cents: [8, 30] },
  [FIND.TINY]: { kind: "lump", size: [0.0062, 0.0094], cents: [25, 90] },
  [FIND.NUGGET]: { kind: "nugget", size: [0.0105, 0.0165], cents: [100, 400] },
};

/** the drawn radius (m) of a find of class `cls` worth `cents`; u (0..1) adds a little variety */
export function findSize(cls, cents, u = 0.5) {
  const L = FIND_LOOK[cls];
  if (!L) return 0;
  const [c0, c1] = L.cents, [r0, r1] = L.size;
  if (cls === FIND.NUGGET && cents > c1) return r1 * Math.pow(Math.min(cents, 12000) / c1, 0.25) * (0.97 + 0.06 * u);
  const t = Math.max(0, Math.min(1, Math.log(Math.max(1, cents) / c0) / Math.log(c1 / c0)));
  return r0 + (r1 - r0) * Math.max(0, Math.min(1, 0.75 * t + 0.25 * u));
}

// an irregular lump: a sphere pushed in and out by noise, then squashed (Prompt 10: also the trommel's trap and the pan)
export function lumpGeometry(THREE, seed, { w = 20, h = 14, amp = 0.28, freq = 1.7, sx = 1, sy = 0.7, sz = 0.85 } = {}) {
  const g = new THREE.SphereGeometry(1, w, h);
  const p = g.attributes.position;
  for (let v = 0; v < p.count; v++) {
    const x = p.getX(v), y = p.getY(v), z = p.getZ(v);
    let n = noise3(x * freq + seed * 3.1, y * freq, z * freq, seed) * amp;
    n += noise3(x * freq * 2.6, y * freq * 2.6 + seed, z * freq * 2.6, seed + 7) * amp * 0.45;
    const k = 1 + n;
    p.setXYZ(v, x * k * sx, y * k * sy, z * k * sz);
  }
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export class LootSystem {
  constructor(THREE, scene, terrain, { envMap } = {}) {
    this.THREE = THREE;
    this.scene = scene;
    this.terrain = terrain;
    this.onCollect = () => {};
    this.onNuggetArrive = null;          // (item) => hand takes it; call finish(item) afterwards
    this.glintLimit = 48;
    const rng = mulberry32(0x60d);

    // gold: a real metal (metalness 1, the environment gives it its colour
    // and the sun its highlight) - not a yellow plastic ball
    // (phase 7A: a warmer, deeper gold - highlights from the light, never neon yellow)
    this.goldMat = new THREE.MeshStandardMaterial({ color: 0xe2a63e, metalness: 1, roughness: 0.3, envMap: envMap || null, envMapIntensity: 1.3 });
    this.goldMatRough = new THREE.MeshStandardMaterial({ color: 0xd69a38, metalness: 1, roughness: 0.42, envMap: envMap || null, envMapIntensity: 1.15 });
    this.geos = {
      [FIND.FLAKE]: [0, 1, 2].map((i) => lumpGeometry(THREE, 11 + i, { w: 12, h: 8, amp: 0.3, freq: 2.2, sx: 1, sy: 0.14, sz: 0.78 })),
      [FIND.TINY]: [0, 1, 2].map((i) => lumpGeometry(THREE, 21 + i, { w: 14, h: 10, amp: 0.34, freq: 1.9, sx: 1.05, sy: 0.72, sz: 0.85 })),
      [FIND.NUGGET]: [0, 1, 2, 3, 4, 5].map((i) => lumpGeometry(THREE, 31 + i, { w: 22, h: 16, amp: 0.3 + (i % 3) * 0.05, freq: 1.5 + (i % 2) * 0.5, sx: 1.1 + (i % 3) * 0.12, sy: 0.62 + (i % 2) * 0.1, sz: 0.86 })),
    };
    this.items = [];
    for (const cls of [FIND.FLAKE, FIND.TINY, FIND.NUGGET]) {
      for (let n = 0; n < POOL[cls]; n++) {
        const mesh = new THREE.Mesh(this.geos[cls][n % this.geos[cls].length], n % 3 === 2 ? this.goldMatRough : this.goldMat);
        mesh.visible = false;
        mesh.castShadow = cls === FIND.NUGGET;
        mesh.frustumCulled = false;
        scene.add(mesh);
        this.items.push({ mesh, cls, state: "free", variant: n, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, sx: 0, sy: 0, sz: 0, size: 0.01, t: 0, wait: 0, rested: 0, cents: 0, dur: 0.3, sxp: 0, syp: 0, szp: 0 });
      }
    }
    this.dustItems = [];                  // invisible "pieces" of gold dust (short delay, then collected)
    // fine-gold flitter: a few tiny specks pop up and fall back (looks only; one instanced draw)
    this.speckMesh = new THREE.InstancedMesh(this.geos[FIND.FLAKE][0], this.goldMat, SPECKS);
    this.speckMesh.count = 0;
    this.speckMesh.frustumCulled = false;
    scene.add(this.speckMesh);
    this.specks = Array.from({ length: SPECKS }, () => ({ life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, s: 0, r: 0 }));
    this._sm = new THREE.Matrix4(); this._sq = new THREE.Quaternion(); this._se = new THREE.Euler(); this._sv = new THREE.Vector3(); this._ss = new THREE.Vector3();

    // glints: small additive stars (one Points draw call)
    this.glints = [];
    const pos = new Float32Array(GLINT_MAX * 3), alpha = new Float32Array(GLINT_MAX), size = new Float32Array(GLINT_MAX);
    for (let i = 0; i < GLINT_MAX; i++) this.glints.push({ life: 0, max: 1, x: 0, y: -99, z: 0, s: 0.05, follow: null, ox: 0, oy: 0, oz: 0 });
    const g = (this.glintGeo = new THREE.BufferGeometry());
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1));
    g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    this.glintMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: 400 } },
      vertexShader: `
        attribute float aAlpha; attribute float aSize; varying float vAlpha; uniform float uScale;
        void main() {
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vAlpha;
        void main() {
          vec2 c = gl_PointCoord - 0.5; float r = length(c);
          float core = smoothstep(0.16, 0.0, r);
          float rays = max(smoothstep(0.035, 0.0, abs(c.x)), smoothstep(0.035, 0.0, abs(c.y))) * smoothstep(0.5, 0.05, r);
          float a = (core + rays * 0.6) * vAlpha * 0.85;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vec3(1.0, 0.84, 0.52) * a, a);
        }`,
    });
    this.glintPoints = new THREE.Points(g, this.glintMat);
    this.glintPoints.frustumCulled = false;
    this.glintPoints.renderOrder = 4;
    scene.add(this.glintPoints);

    this.shine = 0;                         // nugget shine (big soft glints) running, for tests / debug

    this._rng = rng;
    this._v = new THREE.Vector3();
    this._fw = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._rt = new THREE.Vector3();
  }

  setLimits(glints) { this.glintLimit = Math.min(GLINT_MAX, glints); }
  setScale(px) { this.glintMat.uniforms.uScale.value = px; }

  _glint(x, y, z, s, life, follow = null) {
    for (let i = 0; i < this.glintLimit; i++) {
      const gl = this.glints[i];
      if (gl.life > 0) continue;
      gl.life = gl.max = life;
      gl.x = x; gl.y = y; gl.z = z; gl.s = s;
      gl.follow = follow;
      if (follow) { gl.ox = x - follow.x; gl.oy = y - follow.y; gl.oz = z - follow.z; }
      return;
    }
  }

  // show the finds of one stroke at the dig spot
  spawn(items, hit) {
    const r = this._rng, n = hit.normal || { x: 0, y: 1, z: 0 };
    for (const f of items) {
      if (f.cls === FIND.TRACE || f.cls === FIND.FINE) {
        // gold dust / fine gold: a short glitter and a few tiny specks - never a "piece"
        const L = FIND_LOOK[f.cls];
        for (let q = 0; q < L.glints; q++) {
          this._glint(hit.x + (r() - 0.5) * 0.16 + n.x * 0.04, hit.y + 0.03 + r() * 0.09, hit.z + (r() - 0.5) * 0.16 + n.z * 0.04, L.glint[0] + r() * (L.glint[1] - L.glint[0]), 0.22 + r() * 0.3);
        }
        for (let q = 0; q < L.specks; q++) this._speck(hit, n, findSize(f.cls, f.cents, r()));
        this.dustItems.push({ t: 0.32 + r() * 0.1, cents: f.cents, cls: f.cls, item: f });
        continue;
      }
      const it = this.items.find((o) => o.cls === f.cls && o.state === "free");
      if (!it) { this.onCollect({ cls: f.cls, cents: f.cents, find: f }); continue; }      // pool full: book it right away
      it.find = f;
      it.cents = f.cents;
      it.state = "fly";
      it.t = 0;
      it.rested = 0;
      it.wait = REST[f.cls];
      const big = f.cls === FIND.NUGGET, tq = big ? jackpotTier(f.massUg || 0) : -1;
      // its size follows its value (FIND_LOOK): a few-cent flake stays a flake
      it.size = findSize(f.cls, f.cents, r());
      it.x = hit.x + n.x * 0.03; it.y = hit.y + 0.03; it.z = hit.z + n.z * 0.03;
      const up = big ? (tq >= 1 ? 1.8 : 2.3) + r() * 0.4 : f.cls === FIND.TINY ? 1.8 + r() * 0.4 : 1.5 + r() * 0.4;     // (a heavy one does not fly as high)
      const out = 0.55 + r() * 0.4;
      it.vx = n.x * out + (r() - 0.5) * 0.5; it.vy = up; it.vz = n.z * out + (r() - 0.5) * 0.5;
      it.rx = r() * 6; it.ry = r() * 6; it.rz = r() * 6;
      it.sxp = (r() - 0.5) * 14; it.syp = (r() - 0.5) * 10; it.szp = (r() - 0.5) * 14;
      it.mesh.visible = true;
      it.mesh.scale.setScalar(it.size);
      it.mesh.position.set(it.x, it.y, it.z);
      if (big) {
        // the nugget's moment: a warm shine on the piece (soft, big glints that
        // ride along with it) and a few sparks - no flash, no light source
        // (Prompt 10: a big one a little more - larger, longer, a few more sparks; still no flash)
        const k = tq >= 0 ? 1 + 0.12 * (tq + 1) : 1;
        this._glint(it.x, it.y + 0.02, it.z, 0.22 * k, 0.7 * k, it);
        this._glint(it.x, it.y + 0.03, it.z, 0.13 * k, 0.95 * k, it);
        for (let q = 0; q < 5 + 2 * (tq + 1); q++) this._glint(it.x + (r() - 0.5) * 0.1 * k, it.y + r() * 0.1 * k, it.z + (r() - 0.5) * 0.1 * k, 0.035 + r() * 0.035, 0.35 + r() * 0.3);
        this.shine = 0.95;
        this.lastTier = tq;
      } else {
        this._glint(it.x, it.y + 0.02, it.z, f.cls === FIND.TINY ? 0.042 : 0.034, 0.3);
      }
    }
  }

  // one speck of fine gold thrown up from the dig spot
  _speck(hit, n, s) {
    const sp = this.specks.find((o) => o.life <= 0);
    if (!sp) return;
    const r = this._rng;
    sp.life = 0.55 + r() * 0.35;
    sp.x = hit.x + n.x * 0.03 + (r() - 0.5) * 0.06; sp.y = hit.y + 0.02; sp.z = hit.z + n.z * 0.03 + (r() - 0.5) * 0.06;
    sp.vx = n.x * 0.5 + (r() - 0.5) * 0.6; sp.vy = 0.9 + r() * 0.7; sp.vz = n.z * 0.5 + (r() - 0.5) * 0.6;
    sp.s = s; sp.r = r() * 6;
  }

  _specks(dt) {
    let n = 0;
    const m = this._sm, q = this._sq, e = this._se, v = this._sv, sc = this._ss;
    for (const sp of this.specks) {
      if (sp.life <= 0) continue;
      sp.life -= dt;
      sp.vy -= GRAVITY * dt;
      sp.x += sp.vx * dt; sp.y += sp.vy * dt; sp.z += sp.vz * dt;
      const g = this.terrain.getHeightAt(sp.x, sp.z) + sp.s * 0.3;
      if (sp.y < g) { sp.y = g; sp.vx = sp.vz = sp.vy = 0; }
      sp.r += dt * 11;
      const k = Math.min(1, sp.life / 0.25);
      e.set(sp.r, sp.r * 0.7, 0.3); q.setFromEuler(e);
      m.compose(v.set(sp.x, sp.y, sp.z), q, sc.setScalar(sp.s * k));
      this.speckMesh.setMatrixAt(n++, m);
    }
    if (n || this.speckMesh.count) { this.speckMesh.count = n; this.speckMesh.instanceMatrix.needsUpdate = true; }
  }

  get activeSpecks() { let n = 0; for (const s of this.specks) if (s.life > 0) n++; return n; }

  // camera-relative point in front of the player where pieces are pulled to
  _pocket(camera, out, reach = 0.5) {
    camera.getWorldDirection(this._fw);
    this._up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    return out.copy(camera.position).addScaledVector(this._fw, reach).addScaledVector(this._up, -0.24);
  }

  update(dt, camera, player) {
    const r = this._rng;
    this._specks(dt);
    // gold dust: collected after its short glitter
    for (let i = this.dustItems.length - 1; i >= 0; i--) {
      const d = this.dustItems[i];
      d.t -= dt;
      if (d.t <= 0) { this.dustItems.splice(i, 1); this.onCollect({ cls: d.cls, cents: d.cents, find: d.item }); }
    }
    for (const it of this.items) {
      if (it.state === "free" || it.state === "held") continue;
      it.t += dt;
      if (it.state === "fly") {
        it.vy -= GRAVITY * dt;
        it.x += it.vx * dt; it.y += it.vy * dt; it.z += it.vz * dt;
        it.rx += it.sxp * dt; it.ry += it.syp * dt; it.rz += it.szp * dt;
        const ground = this.terrain.getHeightAt(it.x, it.z) + it.size * 0.45;
        if (it.y < ground) {
          it.y = ground;
          if (Math.abs(it.vy) < 0.7 || it.t > 1.6) {
            it.state = "rest"; it.t = 0;
            it.vx = it.vz = it.vy = 0;
            it.rx = it.rx * 0.2; it.rz = it.rz * 0.2;          // settle roughly flat
          } else {
            it.vy = -it.vy * 0.32; it.vx *= 0.45; it.vz *= 0.45; it.sxp *= 0.4; it.szp *= 0.4;
          }
        }
      } else if (it.state === "rest") {
        it.rested += dt;
        it.y = Math.max(it.y, this.terrain.getHeightAt(it.x, it.z) + it.size * 0.45);   // the ground may have been dug away under it
        if (r() < dt * (it.cls === FIND.NUGGET ? 2.2 : 0.9)) this._glint(it.x + (r() - 0.5) * it.size * 2, it.y + it.size * 0.6, it.z + (r() - 0.5) * it.size * 2, it.size * 2.2 + r() * it.size * 2, 0.25);
        const near = !player || Math.hypot(player.x - it.x, player.z - it.z) < PICKUP_RANGE;
        if ((it.t >= it.wait && near) || it.rested > GIVE_UP) {
          it.state = "magnet"; it.t = 0;
          it.dur = near ? (it.cls === FIND.NUGGET ? 0.42 : 0.32) : 0.55;
          it.x0 = it.x; it.y0 = it.y; it.z0 = it.z;
        }
      } else if (it.state === "magnet") {
        const u = Math.min(1, it.t / it.dur), e = u * u * (3 - 2 * u);
        const p = this._pocket(camera, this._v, it.cls === FIND.NUGGET ? 0.55 : 0.5);
        it.x = it.x0 + (p.x - it.x0) * e;
        it.y = it.y0 + (p.y - it.y0) * e + Math.sin(u * Math.PI) * 0.18;
        it.z = it.z0 + (p.z - it.z0) * e;
        it.ry += dt * 9;
        if (u >= 1) this._arrive(it);
      }
      if (it.state !== "free" && it.state !== "held") {
        it.mesh.position.set(it.x, it.y, it.z);
        it.mesh.rotation.set(it.rx, it.ry, it.rz);
        const shrink = it.state === "magnet" ? 1 - 0.35 * Math.min(1, it.t / it.dur) : 1;
        it.mesh.scale.setScalar(it.size * shrink);
      }
    }
    if (this.shine > 0) this.shine = Math.max(0, this.shine - dt);
    // glints
    const pos = this.glintGeo.attributes.position.array, alpha = this.glintGeo.attributes.aAlpha.array, size = this.glintGeo.attributes.aSize.array;
    for (let i = 0; i < GLINT_MAX; i++) {
      const gl = this.glints[i];
      if (gl.life > 0) {
        gl.life -= dt;
        const t = Math.max(0, gl.life / gl.max);
        if (gl.follow) { gl.x = gl.follow.x + gl.ox; gl.y = gl.follow.y + gl.oy; gl.z = gl.follow.z + gl.oz; }
        pos[i * 3] = gl.x; pos[i * 3 + 1] = gl.y; pos[i * 3 + 2] = gl.z;
        alpha[i] = Math.sin(t * Math.PI) * 0.95;
        size[i] = gl.s * (0.6 + 0.6 * Math.sin(t * Math.PI));
      } else if (alpha[i] !== 0) {
        alpha[i] = 0;
        pos[i * 3 + 1] = -99;
      }
    }
    this.glintGeo.attributes.position.needsUpdate = true;
    this.glintGeo.attributes.aAlpha.needsUpdate = true;
    this.glintGeo.attributes.aSize.needsUpdate = true;
  }

  _arrive(it) {
    if (it.cls === FIND.NUGGET && this.onNuggetArrive) {
      it.state = "held";
      it.mesh.visible = false;
      this.onNuggetArrive(it);            // the hand shows it; finish(it) books the pickup
      return;
    }
    this._done(it);
  }

  _done(it) {
    it.state = "free";
    it.mesh.visible = false;
    this.onCollect({ cls: it.cls, cents: it.cents, find: it.find, item: it });
    it.find = null;
  }

  finish(it) { if (it && it.state === "held") this._done(it); }

  // everything still on its way is booked now (exit, hidden tab)
  flush() {
    for (const d of this.dustItems.splice(0)) this.onCollect({ cls: d.cls, cents: d.cents, find: d.item });
    for (const it of this.items) if (it.state !== "free") this._done(it);
    this.shine = 0;
  }

  get active() {
    let n = this.dustItems.length;
    for (const it of this.items) if (it.state !== "free") n++;
    return n;
  }

  get activeGlints() {
    let n = 0;
    for (const g of this.glints) if (g.life > 0) n++;
    return n;
  }

  // make every gold material / geometry known to the GPU up front (a first
  // nugget must not stutter while its shader compiles)
  warmup(on) {
    for (const it of this.items) {
      if (it.state !== "free") continue;
      it.mesh.visible = on;
      it.mesh.position.set(0, -40, 0);
    }
    if (on) { this.speckMesh.count = Math.max(1, this.speckMesh.count); this.speckMesh.setMatrixAt(0, this._sm.makeTranslation(0, -40, 0)); }
    else if (!this.activeSpecks) this.speckMesh.count = 0;
  }

  // the geometry + material a hand should show for a held nugget
  nuggetLook(it) { return { geometry: it.mesh.geometry, material: it.mesh.material, size: it.size }; }

  dispose() {
    for (const list of Object.values(this.geos)) for (const g of list) g.dispose();
    this.goldMat.dispose();
    this.goldMatRough.dispose();
    this.glintGeo.dispose();
    this.glintMat.dispose();
    this.scene.remove(this.speckMesh);
    this.speckMesh.dispose();
    for (const it of this.items) this.scene.remove(it.mesh);
    this.scene.remove(this.glintPoints);
  }
}
