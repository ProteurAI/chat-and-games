// GoldRush - boulders in the pile. Loose rocks are objects of their own
// (not part of the ground): they lie embedded in the soil, and when the
// ground around them is dug away they SINK with it, tilt, or roll a little
// down into the hole - they never stay floating on a pillar of soil.
//
// Hand and shovel bounce off them. The pickaxe wears them down: every
// boulder has an integrity (more for bigger ones) and shows its damage -
// intact, damaged (cracks), heavily damaged (more and wider cracks) - until
// it breaks into a few pieces of rubble. All of it is saved (position,
// turn, integrity, broken).
//
// Settling, per boulder: 17 ground samples under it (centre + two rings).
// "Seat" = what the samples looked like when it last came to rest. The
// boulder sinks by how much the MEAN support dropped since (a soil cone
// left in the middle ends up inside the rock, not under it), and rolls a
// short way towards the side whose support went missing when that loss is
// lopsided. Columns under a boulder carry its weight: no crust there, they
// slump like loose soil (DiggableTerrain.load).

import { mulberry32, noise2 } from "./goldrush-noise.js";

const RING = [0.5, 0.85];                  // sample rings (x horizontal radius)
const RUBBLE = 4;                          // pieces a broken boulder leaves
const STONE_DENSITY = 2650;
export const ROCK_STAGES = ["intact", "damaged", "heavilyDamaged", "broken"];

export class RockSystem {
  constructor(THREE, scene, terrain, world, { seed, rockTex }) {
    this.THREE = THREE;
    this.scene = scene;
    this.terrain = terrain;
    this.world = world;
    this.seed = seed | 0;
    this.stats = { broken: 0, hits: 0, brokenKg: 0 };
    // samples (unit disk) + their vertical offset on a unit ellipsoid
    this.samples = [{ x: 0, z: 0 }];
    for (const r of RING) for (let a = 0; a < 8; a++) this.samples.push({ x: Math.cos((a / 8) * Math.PI * 2) * r, z: Math.sin((a / 8) * Math.PI * 2) * r });
    for (const s of this.samples) { s.d = Math.hypot(s.x, s.z); s.off = Math.sqrt(Math.max(0, 1 - s.d * s.d)); }
    this._c = new Float32Array(this.samples.length);
    this.rocks = terrain.field.boulders.map((b, i) => this._make(b, i));
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this._s = new THREE.Vector3();
    this._build(rockTex);
    for (const r of this.rocks) this._seat(r);
    this._markLoad();
  }

  _make(b, i) {
    const THREE = this.THREE;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.25 * Math.sin(b.rot * 3), b.rot, 0.2 * Math.cos(b.rot * 2)));
    const r = b.r;
    const hp = Math.round(4 + 30 * r * r * r);                  // ~5 hits for a small rock, ~27 for a big one
    return {
      index: i, variant: b.variant, r, rh: r * 1.1, ry: r * 0.85,
      x: b.x, y: b.y, z: b.z, q, x0: b.x, y0: b.y, z0: b.z,
      hp, maxHp: hp, broken: false, seat: new Float32Array(this.samples.length), seatMean: 0, embed: 0,
      moved: 0, changed: false, collider: null,
    };
  }

  // ------------------------------------------------------------ looks

  _build(rockTex) {
    const THREE = this.THREE;
    this.geos = [0, 1, 2, 3].map((vi) => {
      const geo = new THREE.IcosahedronGeometry(1, 2);
      const p = geo.attributes.position;
      for (let v = 0; v < p.count; v++) {
        const x = p.getX(v), y = p.getY(v), z = p.getZ(v);
        const k = 0.86 + 0.2 * (noise2(x * 1.7 + vi * 5, z * 1.7 + y, this.seed + 311 + vi) * 0.5 + 0.5) + 0.06 * noise2(x * 5 + vi, y * 5 - z, this.seed + 313);
        p.setXYZ(v, x * k * (1.08 + (vi % 2) * 0.1), y * k * (0.82 + (vi % 3) * 0.06), z * k);
      }
      geo.computeVertexNormals();
      return geo;
    });
    // damage: a crack network in the rock's own space (cell borders of a
    // warped 3D cellular noise, offset per boulder - no two crack the same),
    // more and wider the more it is damaged (per-instance attributes, no
    // texture swap, one program)
    // the rock detail texture tiled finer than on the ground: grain, not a
    // single giant crack (real cracks are the damage below)
    this.tex = rockTex ? rockTex.clone() : null;
    if (this.tex) { this.tex.wrapS = this.tex.wrapT = THREE.RepeatWrapping; this.tex.repeat.set(3, 2); this.tex.needsUpdate = true; }
    this.mat = new THREE.MeshStandardMaterial({ color: 0x9a9185, map: this.tex, roughness: 0.92, flatShading: true });
    this.mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float aDamage;\nattribute float aSeed;\nvarying float vDamage;\nvarying vec3 vObj;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvDamage = aDamage;\nvObj = position + vec3(aSeed, aSeed * 1.7, aSeed * 0.6);");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
          varying float vDamage; varying vec3 vObj;
          vec3 grH3(vec3 p) {
            p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
            return fract(sin(p) * 43758.5453);
          }
          // distance to the nearest cell border (F2 - F1) + the cell's own random value
          vec2 grCells(vec3 p) {
            vec3 i = floor(p), f = fract(p);
            float d1 = 8.0, d2 = 8.0, id = 0.0;
            for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
              vec3 g = vec3(float(x), float(y), float(z));
              vec3 o = grH3(i + g);
              vec3 r = g + o - f;
              float d = dot(r, r);
              if (d < d1) { d2 = d1; d1 = d; id = o.z; } else if (d < d2) d2 = d;
            }
            return vec2(sqrt(d2) - sqrt(d1), id);
          }`)
        .replace("#include <map_fragment>", `#include <map_fragment>
          if (vDamage > 0.01) {
            vec3 q = vObj + 0.18 * sin(vObj.yzx * 5.3);
            vec2 c1 = grCells(q * 2.6);
            vec2 c2 = grCells(q.zxy * 5.2 + 3.1);
            float w = 0.035 + 0.05 * vDamage;
            // only some borders crack at first, more of them as the damage grows
            float m1 = step(0.12, vDamage) * step(c1.y, 0.25 + vDamage * 0.9);
            float m2 = step(0.55, vDamage) * step(c2.y, (vDamage - 0.45) * 1.4);
            float cr = max(m1 * smoothstep(w, 0.0, c1.x), m2 * smoothstep(w * 0.8, 0.0, c2.x));
            diffuseColor.rgb *= 1.0 - 0.62 * cr;
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.12, 1.08, 1.02), 0.25 * vDamage);
          }`);
    };
    this.mat.customProgramCacheKey = () => "goldrush-rock-v2";
    const byVariant = [[], [], [], []];
    for (const r of this.rocks) byVariant[r.variant].push(r);
    this.meshes = [];
    byVariant.forEach((list, vi) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(this.geos[vi], this.mat, list.length);
      const dmg = new THREE.InstancedBufferAttribute(new Float32Array(list.length), 1);
      const seed = new THREE.InstancedBufferAttribute(new Float32Array(list.map((r) => (r.index * 7.31) % 23)), 1);
      im.geometry = this.geos[vi].clone();                      // own attribute set per variant
      im.geometry.setAttribute("aDamage", dmg);
      im.geometry.setAttribute("aSeed", seed);
      im.castShadow = true;
      im.receiveShadow = true;
      im.name = "pile-boulders";
      list.forEach((r, n) => { r.mesh = im; r.slot = n; });
      this.scene.add(im);
      this.meshes.push(im);
    });
    for (const g of this.geos) g.dispose();                     // the clones are the ones in use
    // rubble of broken boulders: one instanced draw call
    const rg = new THREE.IcosahedronGeometry(1, 0);
    const rp = rg.attributes.position;
    for (let v = 0; v < rp.count; v++) rp.setXYZ(v, rp.getX(v) * (0.9 + (v % 3) * 0.12), rp.getY(v) * 0.62, rp.getZ(v) * (0.85 + (v % 2) * 0.2));
    rg.computeVertexNormals();
    this.rubbleGeo = rg;
    this.rubble = new THREE.InstancedMesh(rg, this.mat, Math.max(1, this.rocks.length * RUBBLE));
    this.rubble.geometry = rg;
    rg.setAttribute("aDamage", new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, this.rocks.length * RUBBLE)).fill(0.3), 1));
    rg.setAttribute("aSeed", new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, this.rocks.length * RUBBLE)).map((_, n) => (n * 3.17) % 19), 1));
    this.rubble.count = 0;
    this.rubble.castShadow = true;
    this.rubble.receiveShadow = true;
    this.rubble.name = "rock-rubble";
    this.rubblePieces = [];
    this.scene.add(this.rubble);
    for (const r of this.rocks) this._place(r);
  }

  _place(r) {
    const m = this._m;
    if (r.broken) m.makeScale(0, 0, 0);
    else m.compose(this._v.set(r.x, r.y, r.z), r.q, this._s.setScalar(r.r));
    r.mesh.setMatrixAt(r.slot, m);
    r.mesh.instanceMatrix.needsUpdate = true;
    r.mesh.geometry.attributes.aDamage.setX(r.slot, 1 - r.hp / r.maxHp);
    r.mesh.geometry.attributes.aDamage.needsUpdate = true;
    r.mesh.computeBoundingSphere();
  }

  // ------------------------------------------------------------ colliders / load

  // player colliders live in the world's list; we keep ours up to date
  attachColliders(list) {
    this.colliderList = list;
    for (const r of this.rocks) {
      r.collider = { type: "circle", x: r.x, z: r.z, r: r.broken ? 0 : r.r * 0.85, rock: r.index };
      list.push(r.collider);
    }
  }

  _markLoad() {
    const t = this.terrain, L = t.load, c = t.cell, vps = t.vps;
    L.fill(0);
    for (const r of this.rocks) {
      if (r.broken) continue;
      const R = r.rh * 0.85;
      const i0 = Math.max(0, Math.floor((r.x - R - t.x0) / c)), i1 = Math.min(vps - 1, Math.ceil((r.x + R - t.x0) / c));
      const j0 = Math.max(0, Math.floor((r.z - R - t.z0) / c)), j1 = Math.min(vps - 1, Math.ceil((r.z + R - t.z0) / c));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        if (Math.hypot(t.x0 + i * c - r.x, t.z0 + j * c - r.z) < R) L[j * vps + i] = 1;
      }
    }
  }

  // ------------------------------------------------------------ settling

  _contacts(r, x, z, out) {
    const t = this.terrain;
    for (let s = 0; s < this.samples.length; s++) {
      const S = this.samples[s];
      out[s] = t.getHeightAt(x + S.x * r.rh, z + S.z * r.rh) + S.off * r.ry;
    }
    return out;
  }

  _mean(a) { let m = 0; for (let i = 0; i < a.length; i++) m += a[i]; return m / a.length; }

  _seat(r) {
    this._contacts(r, r.x, r.z, r.seat);
    r.seatMean = this._mean(r.seat);
    r.embed = r.seatMean - r.y;
  }

  /**
   * After the ground changed in [x0..x1] x [z0..z1]: let the boulders there
   * sink / tilt / roll onto the new surface. Returns how many moved.
   */
  settleIn(x0, z0, x1, z1) {
    let moved = 0;
    for (const r of this.rocks) {
      if (r.broken) continue;
      if (r.x + r.rh < x0 || r.x - r.rh > x1 || r.z + r.rh < z0 || r.z - r.rh > z1) continue;
      if (this._settle(r)) moved++;
    }
    this._settleRubble(x0, z0, x1, z1);
    if (moved) this._markLoad();
    return moved;
  }

  _settle(r) {
    const c = this._c, t = this.terrain;
    let changed = false;
    for (let step = 0; step < 6; step++) {
      this._contacts(r, r.x, r.z, c);
      const drop = r.seatMean - this._mean(c);
      // lost support per side (ring samples only)
      let vx = 0, vz = 0;
      for (let s = 1; s < this.samples.length; s++) {
        const loss = r.seat[s] - c[s], S = this.samples[s];
        vx += loss * S.x; vz += loss * S.z;
      }
      vx /= this.samples.length - 1; vz /= this.samples.length - 1;
      const lop = Math.hypot(vx, vz);
      if (drop > 0.003) {
        // sink with the ground, tilting a little towards the side that gave way
        r.y -= drop;
        if (lop > 1e-4) {
          const ang = Math.min(0.08, lop / r.rh);
          this._q2.setFromAxisAngle(this._v.set(vz / lop, 0, -vx / lop), ang);
          r.q.premultiply(this._q2);
        }
        changed = true;
      }
      if (lop > 0.12 * r.ry) {
        // lopsided: roll a short way towards the hole
        const dist = Math.min(0.45 * r.rh, lop * 3), dx = (vx / lop) * dist, dz = (vz / lop) * dist;
        const nx = r.x + dx, nz = r.z + dz;
        if (!t.inDigArea(nx - r.rh, nz - r.rh) || !t.inDigArea(nx + r.rh, nz + r.rh)) { this._rest(r); break; }
        this._contacts(r, nx, nz, c);
        const yNew = this._mean(c) - r.embed;
        if (yNew > r.y + 0.01) { this._rest(r); break; }        // would have to roll uphill: it stays
        this._q2.setFromAxisAngle(this._v.set(dz / dist, 0, -dx / dist), dist / r.ry);
        r.q.premultiply(this._q2);
        // the soil it lay on was pressed loose
        this._loosen(r.x, r.z, r.rh);
        r.x = nx; r.z = nz; r.y = yNew;
        r.moved += dist;
        changed = true;
        this._rest(r);
        if (r.moved > 3) break;                                  // a boulder never wanders off
        continue;
      }
      if (drop > 0.003) this._rest(r);
      break;
    }
    if (changed) {
      r.changed = true;
      this._place(r);
      if (r.collider) { r.collider.x = r.x; r.collider.z = r.z; }
    }
    return changed;
  }

  _rest(r) {
    this._contacts(r, r.x, r.z, r.seat);
    r.seatMean = this._mean(r.seat);
    r.y = Math.min(r.y, r.seatMean - r.embed);
    r.embed = r.seatMean - r.y;
  }

  _loosen(x, z, R) {
    const t = this.terrain, c = t.cell, vps = t.vps;
    const i0 = Math.max(0, Math.floor((x - R - t.x0) / c)), i1 = Math.min(vps - 1, Math.ceil((x + R - t.x0) / c));
    const j0 = Math.max(0, Math.floor((z - R - t.z0) / c)), j1 = Math.min(vps - 1, Math.ceil((z + R - t.z0) / c));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * vps + i;
      if (Math.hypot(t.x0 + i * c - x, t.z0 + j * c - z) < R && t.loose[k] < 6) t.loose[k] = 6;
    }
  }

  // ------------------------------------------------------------ the pickaxe

  // which (unbroken) boulder a ray hits first, and where - or null
  raycast(ox, oy, oz, dx, dy, dz, maxDist, out) {
    let best = maxDist, hit = null;
    for (const B of this.rocks) {
      if (B.broken) continue;
      const r = B.r * 0.95;
      const lx = ox - B.x, ly = oy - B.y, lz = oz - B.z;
      const bq = lx * dx + ly * dy + lz * dz, c = lx * lx + ly * ly + lz * lz - r * r;
      const disc = bq * bq - c;
      if (disc < 0) continue;
      const tHit = -bq - Math.sqrt(disc);
      if (tHit > 0 && tHit < best) { best = tHit; hit = B; }
    }
    if (!hit) return null;
    out.x = ox + dx * best; out.y = oy + dy * best; out.z = oz + dz * best;
    const nx = out.x - hit.x, ny = out.y - hit.y, nz = out.z - hit.z, nl = Math.hypot(nx, ny, nz) || 1;
    out.normal = { x: nx / nl, y: ny / nl, z: nz / nl };
    out.distance = best;
    out.boulder = hit.index;
    out.diggable = true;
    return out;
  }

  stage(i) {
    const r = this.rocks[i];
    if (!r) return null;
    if (r.broken) return "broken";
    const d = 1 - r.hp / r.maxHp;
    return d < 1 / 3 ? "intact" : d < 2 / 3 ? "damaged" : "heavilyDamaged";
  }

  // one pickaxe hit (damage may be fractional with upgrades): -> { stage, broke, hp, maxHp, kg }
  hit(i, damage) {
    const r = this.rocks[i];
    if (!r || r.broken) return null;
    this.stats.hits++;
    r.hp = Math.max(0, Math.round((r.hp - damage) * 100) / 100);
    r.changed = true;
    let broke = false, kg = 0;
    if (r.hp === 0) {
      broke = true;
      r.broken = true;
      kg = Math.round((4 / 3) * Math.PI * r.rh * r.ry * r.r * STONE_DENSITY * 0.8);
      this.stats.broken++;
      this.stats.brokenKg += kg;
      if (r.collider) r.collider.r = 0;
      this._loosen(r.x, r.z, r.rh);
      this._markLoad();
      this._addRubble(r);
      this.terrain.settleArea(r.x - r.rh - 0.4, r.z - r.rh - 0.4, r.x + r.rh + 0.4, r.z + r.rh + 0.4);
    }
    this._place(r);
    return { stage: this.stage(i), broke, hp: r.hp, maxHp: r.maxHp, kg };
  }

  // a few pieces where the boulder was (deterministic per boulder)
  _addRubble(r) {
    const rng = mulberry32((this.seed ^ 0x7ab1e) + r.index * 977);
    for (let n = 0; n < RUBBLE; n++) {
      const a = (n / RUBBLE) * Math.PI * 2 + rng() * 0.9, d = r.rh * (0.25 + rng() * 0.6);
      const s = r.r * (0.2 + rng() * 0.14);
      const x = r.x + Math.cos(a) * d, z = r.z + Math.sin(a) * d;
      this.rubblePieces.push({ x, z, s, rot: rng() * 6.28, tilt: rng() * 0.6, y: 0 });
    }
    this._settleRubble(-1e9, -1e9, 1e9, 1e9);
  }

  _settleRubble(x0, z0, x1, z1) {
    if (!this.rubblePieces.length) return;
    const t = this.terrain, m = this._m, e = new this.THREE.Euler();
    let any = false;
    this.rubblePieces.forEach((p, n) => {
      if (p.x < x0 - 1 || p.x > x1 + 1 || p.z < z0 - 1 || p.z > z1 + 1) { if (n < this.rubble.count) return; }
      p.y = t.getHeightAt(p.x, p.z) + p.s * 0.25;
      e.set(p.tilt, p.rot, p.tilt * 0.5);
      m.compose(this._v.set(p.x, p.y, p.z), this._q.setFromEuler(e), this._s.set(p.s * 1.1, p.s * 0.8, p.s));
      this.rubble.setMatrixAt(n, m);
      any = true;
    });
    this.rubble.count = this.rubblePieces.length;
    if (any) { this.rubble.instanceMatrix.needsUpdate = true; this.rubble.computeBoundingSphere(); }
  }

  // ------------------------------------------------------------ save

  // only boulders that changed: [index, x, y, z (mm), qx, qy, qz, qw (1e-4), hp, broken]
  serialize() {
    const list = [];
    const mm = (v) => Math.round(v * 1000), qq = (v) => Math.round(v * 10000);
    for (const r of this.rocks) {
      if (!r.changed) continue;
      list.push([r.index, mm(r.x), mm(r.y), mm(r.z), qq(r.q.x), qq(r.q.y), qq(r.q.z), qq(r.q.w), r.hp, r.broken ? 1 : 0]);
    }
    return { v: 1, count: this.rocks.length, list };
  }

  // call after the terrain got its saved heights
  deserialize(d) {
    if (!d || d.v !== 1 || !Array.isArray(d.list) || d.count !== this.rocks.length) {
      // no rock data (older save): let them settle onto the saved ground
      for (const r of this.rocks) if (this._settle(r)) r.changed = true;
      this._markLoad();
      return false;
    }
    for (const e of d.list) {
      const r = this.rocks[e[0]];
      if (!r || e.length < 10 || !e.every(Number.isFinite)) continue;
      r.x = e[1] / 1000; r.y = e[2] / 1000; r.z = e[3] / 1000;
      r.q.set(e[4] / 10000, e[5] / 10000, e[6] / 10000, e[7] / 10000).normalize();
      r.hp = Math.max(0, Math.min(r.maxHp, Math.round(e[8] * 100) / 100));
      r.broken = e[9] === 1 || r.hp === 0;
      if (r.broken) r.hp = 0;
      r.changed = true;
      if (r.broken) this._addRubble(r);
    }
    for (const r of this.rocks) {
      if (!r.broken) this._rest(r);
      this._place(r);
      if (r.collider) { r.collider.x = r.x; r.collider.z = r.z; r.collider.r = r.broken ? 0 : r.r * 0.85; }
    }
    this._markLoad();
    return true;
  }

  // largest gap between a boulder's underside and the ground below it
  // (tests: a boulder must never float), metres
  floatGap(i) {
    const r = this.rocks[i];
    if (!r || r.broken) return 0;
    let minGap = Infinity;
    for (const S of this.samples) {
      if (S.d > 0.6) continue;
      const bottom = r.y - S.off * r.ry;
      const g = bottom - this.terrain.getHeightAt(r.x + S.x * r.rh, r.z + S.z * r.rh);
      minGap = Math.min(minGap, g);
    }
    return Math.max(0, minGap);
  }

  dispose() {
    for (const im of this.meshes) { im.geometry.dispose(); this.scene.remove(im); }
    this.rubbleGeo.dispose();
    this.scene.remove(this.rubble);
    this.mat.dispose();
    if (this.tex) this.tex.dispose();
    if (this.colliderList) for (const r of this.rocks) { const i = this.colliderList.indexOf(r.collider); if (i >= 0) this.colliderList.splice(i, 1); }
  }
}
