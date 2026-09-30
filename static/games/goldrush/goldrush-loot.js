// GoldRush - finds you can see. Gold dust is a short glitter at the dig
// spot; flakes, tiny pieces and small nuggets are real little metal
// objects that pop out of the ground, land, catch the sun and are then
// pulled in (pickup). A nugget ends up in the player's hand for a moment.
//
// The money itself is booked in the economy at the moment of the dig (one
// transaction); this module only presents it. Every shown piece reports
// back exactly once (onCollect), and nothing is ever dropped: pieces left
// behind are pulled in after a few seconds, flush() collects all at once
// (exit, hidden tab). Everything is pooled - no allocation per find.

import { FIND } from "./goldrush-resources.js";
import { mulberry32, noise3 } from "./goldrush-noise.js";

const GRAVITY = 9.81;
const GLINT_MAX = 64;
const PICKUP_RANGE = 3.5;        // m: pieces lying closer are pulled in after their short rest
const GIVE_UP = 6;               // s: then they come from anywhere
const REST = { [FIND.FLAKE]: 0.45, [FIND.TINY]: 0.8, [FIND.NUGGET]: 1.0 };
const POOL = { [FIND.FLAKE]: 10, [FIND.TINY]: 8, [FIND.NUGGET]: 3 };

// an irregular lump: a sphere pushed in and out by noise, then squashed
function lumpGeometry(THREE, seed, { w = 20, h = 14, amp = 0.28, freq = 1.7, sx = 1, sy = 0.7, sz = 0.85 } = {}) {
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
    this.goldMat = new THREE.MeshStandardMaterial({ color: 0xeeb043, metalness: 1, roughness: 0.26, envMap: envMap || null, envMapIntensity: 1.5 });
    this.goldMatRough = new THREE.MeshStandardMaterial({ color: 0xe3a53c, metalness: 1, roughness: 0.38, envMap: envMap || null, envMapIntensity: 1.35 });
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
          float a = (core + rays * 0.75) * vAlpha;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vec3(1.0, 0.86, 0.55) * a, a);
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
        const count = f.cls === FIND.FINE ? 6 : 3;
        for (let q = 0; q < count; q++) {
          this._glint(hit.x + (r() - 0.5) * 0.22 + n.x * 0.04, hit.y + 0.03 + r() * 0.12, hit.z + (r() - 0.5) * 0.22 + n.z * 0.04, 0.035 + r() * 0.04, 0.25 + r() * 0.35);
        }
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
      const big = f.cls === FIND.NUGGET;
      // a little larger than life: a 3 mm flake would be invisible from standing height
      it.size = f.cls === FIND.FLAKE ? 0.02 + r() * 0.006 : f.cls === FIND.TINY ? 0.021 + r() * 0.007 : 0.032 + Math.min(1, f.cents / 400) * 0.016;
      it.x = hit.x + n.x * 0.03; it.y = hit.y + 0.03; it.z = hit.z + n.z * 0.03;
      const up = big ? 2.3 + r() * 0.4 : f.cls === FIND.TINY ? 1.8 + r() * 0.4 : 1.5 + r() * 0.4;
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
        this._glint(it.x, it.y + 0.02, it.z, 0.34, 0.7, it);
        this._glint(it.x, it.y + 0.03, it.z, 0.2, 0.95, it);
        for (let q = 0; q < 6; q++) this._glint(it.x + (r() - 0.5) * 0.12, it.y + r() * 0.12, it.z + (r() - 0.5) * 0.12, 0.05 + r() * 0.05, 0.35 + r() * 0.3);
        this.shine = 0.95;
      } else {
        this._glint(it.x, it.y + 0.02, it.z, 0.05, 0.3);
      }
    }
  }

  // camera-relative point in front of the player where pieces are pulled to
  _pocket(camera, out, reach = 0.5) {
    camera.getWorldDirection(this._fw);
    this._up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    return out.copy(camera.position).addScaledVector(this._fw, reach).addScaledVector(this._up, -0.24);
  }

  update(dt, camera, player) {
    const r = this._rng;
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
        if (r() < dt * (it.cls === FIND.NUGGET ? 2.2 : 0.9)) this._glint(it.x + (r() - 0.5) * it.size * 2, it.y + it.size * 0.6, it.z + (r() - 0.5) * it.size * 2, 0.03 + r() * 0.03, 0.25);
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
  }

  // the geometry + material a hand should show for a held nugget
  nuggetLook(it) { return { geometry: it.mesh.geometry, material: it.mesh.material, size: it.size }; }

  dispose() {
    for (const list of Object.values(this.geos)) for (const g of list) g.dispose();
    this.goldMat.dispose();
    this.goldMatRough.dispose();
    this.glintGeo.dispose();
    this.glintMat.dispose();
    for (const it of this.items) this.scene.remove(it.mesh);
    this.scene.remove(this.glintPoints);
  }
}
