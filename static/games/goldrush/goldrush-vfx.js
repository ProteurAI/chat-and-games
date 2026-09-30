// GoldRush - dig feedback: dust puffs and a few dirt/stone fragments.
// Both are fixed-size pools created once (one Points draw call, one
// InstancedMesh draw call); nothing is allocated per dig. The active limit
// follows the graphics quality.

const DUST_MAX = 260;
const FRAG_MAX = 40;
const GRAVITY = 9.81;

export class DigEffects {
  constructor(THREE, scene, terrain) {
    this.THREE = THREE;
    this.terrain = terrain;
    this.dustLimit = 140;
    this.fragLimit = 22;

    // ---- dust: soft round billboards, size in world units
    this.dust = [];
    const pos = new Float32Array(DUST_MAX * 3), col = new Float32Array(DUST_MAX * 3);
    const alpha = new Float32Array(DUST_MAX), size = new Float32Array(DUST_MAX);
    for (let i = 0; i < DUST_MAX; i++) this.dust.push({ life: 0, max: 1, x: 0, y: -99, z: 0, vx: 0, vy: 0, vz: 0, s: 0.2 });
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

    // ---- fragments: small irregular rocks, one instanced draw call
    const fg = (this.fragGeo = new THREE.IcosahedronGeometry(1, 0));
    const p = fg.attributes.position;
    for (let v = 0; v < p.count; v++) p.setXYZ(v, p.getX(v) * (0.8 + (v % 3) * 0.15), p.getY(v) * 0.7, p.getZ(v));
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
      this.fragState.push({ life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, sx: 0, sz: 0, s: 0.03, rest: false });
    }
    scene.add(this.frags);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3();
    this._sc = new THREE.Vector3();
    this._c = new THREE.Color();
    this.activeDust = 0;
    this.activeFrags = 0;
    this._seed = 1;
  }

  _rand() { this._seed = (this._seed * 16807) % 2147483647; return this._seed / 2147483647; }

  setLimits(dust, frags) {
    this.dustLimit = Math.min(DUST_MAX, dust);
    this.fragLimit = Math.min(FRAG_MAX, frags);
  }

  setScale(px) { this.dustMat.uniforms.uScale.value = px; }

  // one dig: a puff at the point, fragments thrown along the surface normal
  burst(hit, mat, strength = 1) {
    const r = () => this._rand();
    const stone = mat ? mat.stone : 0;
    const base = stone > 0.5 ? [0.26, 0.23, 0.19] : [0.3, 0.18, 0.09];     // linear: sunlit soil dust, not white
    const nDust = Math.round(Math.min(18, this.dustLimit / 8) * strength);
    for (let k = 0, placed = 0; k < this.dust.length && placed < nDust; k++) {
      const d = this.dust[k];
      if (d.life > 0) continue;
      d.max = d.life = 0.7 + r() * 0.7;
      d.x = hit.x + (r() - 0.5) * 0.18; d.y = hit.y + 0.04; d.z = hit.z + (r() - 0.5) * 0.18;
      d.vx = hit.normal.x * 0.45 + (r() - 0.5) * 0.7;
      d.vy = 0.35 + r() * 0.55;
      d.vz = hit.normal.z * 0.45 + (r() - 0.5) * 0.7;
      d.s = 0.12 + r() * 0.16;
      d.c = base.map((v) => v * (0.9 + r() * 0.25));
      placed++;
    }
    const nFrag = Math.round(Math.min(4, 1 + this.fragLimit / 12) * strength);
    for (let k = 0, placed = 0; k < this.fragState.length && placed < nFrag; k++) {
      const f = this.fragState[k];
      if (f.life > 0) continue;
      if (k >= this.fragLimit) break;
      f.life = 2.2 + r() * 0.8;
      f.x = hit.x; f.y = hit.y + 0.05; f.z = hit.z;
      const sp = 1.2 + r() * 1.6;
      f.vx = hit.normal.x * sp + (r() - 0.5) * 1.4;
      f.vy = 1.4 + r() * 1.6;
      f.vz = hit.normal.z * sp + (r() - 0.5) * 1.4;
      f.rx = r() * 6; f.ry = r() * 6; f.rz = r() * 6;
      f.sx = (r() - 0.5) * 12; f.sz = (r() - 0.5) * 12;
      f.s = 0.018 + r() * 0.03;
      f.rest = false;
      const isStone = r() < 0.25 + stone * 0.6;
      this._c.setRGB(...(isStone ? [0.33, 0.31, 0.29] : [0.3, 0.2, 0.13]).map((v) => v * (0.85 + r() * 0.3)));
      this.frags.setColorAt(k, this._c);
      placed++;
    }
    if (this.frags.instanceColor) this.frags.instanceColor.needsUpdate = true;
  }

  update(dt) {
    const pos = this.dustGeo.attributes.position.array, col = this.dustGeo.attributes.color.array;
    const alpha = this.dustGeo.attributes.aAlpha.array, size = this.dustGeo.attributes.aSize.array;
    let active = 0;
    for (let i = 0; i < this.dust.length; i++) {
      const d = this.dust[i];
      if (d.life > 0) {
        d.life -= dt;
        const drag = Math.exp(-2.2 * dt);
        d.vx *= drag; d.vz *= drag; d.vy = d.vy * drag + 0.12 * dt;        // warm air lifts it a little
        d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
        const t = Math.max(0, d.life / d.max);
        pos[i * 3] = d.x; pos[i * 3 + 1] = d.y; pos[i * 3 + 2] = d.z;
        col[i * 3] = d.c[0]; col[i * 3 + 1] = d.c[1]; col[i * 3 + 2] = d.c[2];
        alpha[i] = Math.min(1, (1 - t) * 6) * t * 0.42;
        size[i] = d.s * (1.6 - t * 0.9);
        active++;
      } else if (alpha[i] !== 0) {
        alpha[i] = 0;
        pos[i * 3 + 1] = -99;
      }
    }
    this.dustGeo.attributes.position.needsUpdate = true;
    this.dustGeo.attributes.color.needsUpdate = true;
    this.dustGeo.attributes.aAlpha.needsUpdate = true;
    this.dustGeo.attributes.aSize.needsUpdate = true;
    this.activeDust = active;

    let frags = 0;
    const m = this._m, q = this._q, e = this._e, v = this._v, sc = this._sc;
    for (let i = 0; i < this.fragState.length; i++) {
      const f = this.fragState[i];
      if (f.life <= 0) continue;
      f.life -= dt;
      if (!f.rest) {
        f.vy -= GRAVITY * dt;
        f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
        f.rx += f.sx * dt; f.rz += f.sz * dt;
        const ground = this.terrain.getHeightAt(f.x, f.z) + f.s * 0.6;
        if (f.y < ground) {
          f.y = ground;
          if (Math.abs(f.vy) < 0.8) { f.rest = true; f.vx = f.vz = 0; }
          else { f.vy = -f.vy * 0.28; f.vx *= 0.5; f.vz *= 0.5; f.sx *= 0.5; f.sz *= 0.5; }
        }
      }
      const fade = f.life < 0.5 ? Math.max(0, f.life / 0.5) : 1;          // sink + shrink away
      if (f.life <= 0) {
        m.makeScale(0, 0, 0);
      } else {
        e.set(f.rx, f.ry, f.rz);
        q.setFromEuler(e);
        m.compose(v.set(f.x, f.y - (1 - fade) * f.s, f.z), q, sc.setScalar(f.s * fade));
        frags++;
      }
      this.frags.setMatrixAt(i, m);
    }
    this.frags.instanceMatrix.needsUpdate = true;
    this.activeFrags = frags;
  }

  dispose() {
    this.dustGeo.dispose();
    this.dustMat.dispose();
    this.fragGeo.dispose();
    this.fragMat.dispose();
    this.frags.dispose();
  }
}
