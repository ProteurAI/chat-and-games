// GoldRush - the compact excavator's model (phase 9), behind a small rig
// interface so an authored model can replace it (goldrush-assets.js modelOr,
// models/manifest.json - see ASSETS.md):
//
//   root          world position, heading (local +x = forward), pitch / roll on the ground
//     tracks      the undercarriage: two rubber tracks, sprockets, idlers, a dozer blade
//     house       the upper structure, turns on the slewing ring (rotation.y = swing)
//       cab       the operator's cab on the left (-z: looking along +x, +z is to the right), the seat, the eye point
//       boom      pivot at the house's front (rotation.z = boom angle, + up); along its +x to its tip
//         stick   pivot at the boom tip (rotation.z relative to the boom)
//           tool  pivot at the stick tip: the bucket (or the hydraulic breaker)
//
// An authored .glb needs nodes named exactly like that ("tracks", "house", "cab", "boom",
// "stick", "tool"; optional "bucket", "breaker", "eye") with the same pivots; the game
// only sets rotations on them - the procedural model below follows the same rules.
//
// Dimensions: a ~2.7 t machine. Boom 1.95 m, stick 1.25 m (wrist = the stick's tip),
// bucket 45 l, track length 1.9 m, gauge 1.24 m. Kinematics (house frame, x forward,
// y up): see EXC below and ExcavatorRig.solve().

import { noise2 } from "./goldrush-noise.js";
import { mergeStatic } from "./goldrush-merge.js";

export const EXC = {
  trackL: 1.9, trackW: 0.3, gauge: 1.24, trackH: 0.42,
  houseY: 0.56,                         // the slewing ring's top (house frame origin)
  boomPivot: [0.66, 0.64, 0.1],         // in the house frame (right of centre; the cab is on the left)
  boomL: 2.1, stickL: 1.45,
  teeth: [0.42, -0.34],                 // bucket frame: where the teeth are (from the wrist)
  mouth: [0.2, -0.2],                   // bucket frame: the load's centre
  eye: [0.3, 1.5, -0.33],               // house frame: the operator's eyes (front of the cab)
  reach: [1.75, 4.1],                   // horizontal reach of the teeth from the slewing centre (dig; the IK decides the rest)
  dumpReach: [1.8, 4.3],
};

const fract = (v) => v - Math.floor(v);

// rubber track: dark with raised lugs across it (u along the track)
function trackTex(THREE) {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 32;
  const g = c.getContext("2d");
  g.fillStyle = "#1d1c1a"; g.fillRect(0, 0, 64, 32);
  for (let x = 0; x < 64; x += 16) { g.fillStyle = "#34322e"; g.fillRect(x + 2, 2, 8, 28); g.fillStyle = "#121110"; g.fillRect(x + 10, 2, 2, 28); }
  for (let i = 0; i < 60; i++) { g.fillStyle = `rgba(120,96,70,${0.15 + (i % 4) * 0.08})`; g.fillRect((i * 37) % 64, (i * 23) % 32, 2, 1); }     // mud
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// a track's imprint in loose ground: the lugs' grooves across it, soft edges (alpha)
function treadTex(THREE) {
  const c = document.createElement("canvas");
  c.width = 32; c.height = 64;
  const g = c.getContext("2d");
  g.clearRect(0, 0, 32, 64);
  for (let y = 0; y < 64; y += 8) {
    g.fillStyle = "rgba(255,255,255,0.85)"; g.fillRect(3, y + 1, 26, 4);
    g.fillStyle = "rgba(255,255,255,0.35)"; g.fillRect(1, y, 30, 7);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// the tracks' imprints on the ground (cosmetic, not saved): a fixed pool, the oldest reused; one dug away goes
export class TrackMarks {
  constructor(THREE, scene, n = 200) {
    this.n = n; this.next = 0; this.used = 0;
    this.tex = treadTex(THREE);
    this.mat = new THREE.MeshStandardMaterial({ map: this.tex, color: 0x5b4634, roughness: 1, transparent: true, opacity: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.geo = new THREE.PlaneGeometry(1, 1);
    this.geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, n);
    this.mesh.name = "goldrush-track-marks";
    this.mesh.count = 0; this.mesh.visible = false; this.mesh.frustumCulled = false; this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this.scene = scene;
    this.pos = new Float32Array(n * 3);
    this.gone = new Uint8Array(n);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._v = new THREE.Vector3(); this._s = new THREE.Vector3();
    this._hide = new THREE.Matrix4().makeScale(0, 0, 0);
  }

  // one imprint: its centre, the ground there, the heading (local x along the track)
  add(x, y, z, heading) {
    const i = this.next;
    this.next = (i + 1) % this.n;
    this.used = Math.min(this.n, this.used + 1);
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z; this.gone[i] = 0;
    this._q.setFromAxisAngle(this._v.set(0, 1, 0), heading);
    this._m.compose(this._v.set(x, y + 0.012, z), this._q, this._s.set(0.36, 1, 0.3));
    this.mesh.setMatrixAt(i, this._m);
    this.mesh.count = this.used;
    this.mesh.visible = true;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  // the ground changed (a dig): imprints whose ground went (or rose) disappear
  prune(groundAt) {
    let n = 0;
    for (let i = 0; i < this.used; i++) {
      if (this.gone[i]) continue;
      if (Math.abs(groundAt(this.pos[i * 3], this.pos[i * 3 + 2]) - this.pos[i * 3 + 1]) > 0.03) { this.gone[i] = 1; this.mesh.setMatrixAt(i, this._hide); n++; }
    }
    if (n) this.mesh.instanceMatrix.needsUpdate = true;
    return n;
  }

  get visibleCount() { let n = 0; for (let i = 0; i < this.used; i++) if (!this.gone[i]) n++; return n; }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.dispose(); this.geo.dispose(); this.mat.dispose(); this.tex.dispose();
  }
}

// a sticker for the house's side: the claim's own (no brand)
function decalTex(THREE) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "#d99f22"; g.fillRect(0, 0, 256, 64);
  g.fillStyle = "#1e1c19"; g.font = "700 34px system-ui, sans-serif"; g.textBaseline = "middle";
  g.fillText("CLAIM 01 · 27", 14, 34);
  g.fillRect(0, 56, 256, 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class ExcavatorRig {
  constructor(THREE, { envMap = null } = {}) {
    this.THREE = THREE;
    this.geos = []; this.mats = []; this.texs = [];
    const geo = (g) => { this.geos.push(g); return g; };
    const mat = (m) => { this.mats.push(m); return m; };
    this._geo = geo; this._mat = mat;
    this.paint = mat(new THREE.MeshStandardMaterial({ color: 0xd99f22, roughness: 0.48, metalness: 0.2, envMap, envMapIntensity: 0.45 }));
    this.paintWorn = mat(new THREE.MeshStandardMaterial({ color: 0xb98d3a, roughness: 0.66, metalness: 0.15 }));
    this.dark = mat(new THREE.MeshStandardMaterial({ color: 0x2a2927, roughness: 0.6, metalness: 0.3, envMap, envMapIntensity: 0.3 }));
    this.steel = mat(new THREE.MeshStandardMaterial({ color: 0x5c5852, roughness: 0.5, metalness: 0.6, envMap, envMapIntensity: 0.5 }));
    this.chrome = mat(new THREE.MeshStandardMaterial({ color: 0xc8ccd0, roughness: 0.18, metalness: 0.95, envMap, envMapIntensity: 0.9 }));
    this.glass = mat(new THREE.MeshStandardMaterial({ color: 0x9fb4bb, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.28, depthWrite: false, envMap, envMapIntensity: 1 }));
    this.seat = mat(new THREE.MeshStandardMaterial({ color: 0x1f1f22, roughness: 0.85 }));
    this.trackMap = trackTex(THREE); this.texs.push(this.trackMap);
    this.rubber = mat(new THREE.MeshStandardMaterial({ map: this.trackMap, roughness: 0.92 }));
    this.decalMap = decalTex(THREE); this.texs.push(this.decalMap);
    this.decal = mat(new THREE.MeshStandardMaterial({ map: this.decalMap, roughness: 0.5 }));
    this.loadMat = mat(new THREE.MeshStandardMaterial({ color: 0x7a5d43, roughness: 0.95 }));
    this.light = mat(new THREE.MeshStandardMaterial({ color: 0xf3ead2, emissive: 0x6a5a3a, emissiveIntensity: 0.5, roughness: 0.3 }));
    this.box = geo(new THREE.BoxGeometry(1, 1, 1));
    this.cyl = geo(new THREE.CylinderGeometry(1, 1, 1, 14));
    this.cylZ = geo(new THREE.CylinderGeometry(1, 1, 1, 16)); this.cylZ.rotateX(Math.PI / 2);   // axis along z
    this._v = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._m = new THREE.Matrix4();
    this._build();
  }

  _mesh(g, m, sx, sy, sz, x, y, z, parent, shadow = true) {
    const o = new this.THREE.Mesh(g, m);
    o.scale.set(sx, sy, sz);
    o.position.set(x, y, z);
    o.castShadow = shadow;
    o.receiveShadow = true;
    parent.add(o);
    return o;
  }

  _build() {
    const THREE = this.THREE, E = EXC;
    const root = (this.root = new THREE.Group());
    root.name = "goldrush-excavator";
    root.rotation.order = "YXZ";
    // ---- the undercarriage
    const tracks = (this.tracks = new THREE.Group());
    tracks.name = "tracks";
    root.add(tracks);
    this.trackParts = [];
    for (const s of [-1, 1]) {
      const z = s * E.gauge / 2;
      // the track: a rounded loop (a box with the ends as half cylinders) in rubber
      const mid = this._mesh(this.box, this.rubber, E.trackL - E.trackH, E.trackH, E.trackW, 0, E.trackH / 2, z, tracks);
      for (const x of [-(E.trackL - E.trackH) / 2, (E.trackL - E.trackH) / 2]) this.trackParts.push(this._mesh(this.cylZ, this.rubber, E.trackH / 2, E.trackH / 2, E.trackW, x, E.trackH / 2, z, tracks));
      this.trackParts.push(mid);
      // the frame inside the loop, sprocket (rear) and idler (front) hubs, bottom rollers
      this._mesh(this.box, this.dark, E.trackL - 0.5, E.trackH - 0.16, E.trackW + 0.02, 0, E.trackH / 2, z, tracks);
      for (const x of [-(E.trackL - E.trackH) / 2, (E.trackL - E.trackH) / 2]) this._mesh(this.cylZ, this.steel, 0.12, 0.12, E.trackW + 0.05, x, E.trackH / 2, z, tracks);
      for (let k = 0; k < 4; k++) this._mesh(this.cylZ, this.dark, 0.055, 0.055, E.trackW + 0.03, -0.5 + k * 0.33, 0.09, z, tracks);
    }
    this._mesh(this.box, this.dark, 1.2, 0.26, E.gauge - E.trackW, 0, 0.32, 0, tracks);          // the centre frame
    this._mesh(this.cyl, this.dark, 0.5, 0.12, 0.5, 0, 0.5, 0, tracks);                              // the slewing ring
    // the dozer blade in front, on two arms
    for (const s of [-1, 1]) this._mesh(this.box, this.paint, 0.5, 0.08, 0.08, 0.95, 0.27, s * 0.4, tracks);
    const blade = this._mesh(this.box, this.paint, 0.08, 0.34, E.gauge + E.trackW + 0.04, 1.23, 0.2, 0, tracks);
    blade.rotation.z = -0.22;
    this._mesh(this.box, this.steel, 0.05, 0.05, E.gauge + E.trackW + 0.04, 1.29, 0.05, 0, tracks);   // its cutting edge
    // ---- the house (it turns)
    const house = (this.house = new THREE.Group());
    house.name = "house";
    house.position.y = E.houseY;
    root.add(house);
    this._mesh(this.box, this.paint, 1.42, 0.42, 1.36, -0.12, 0.27, 0, house);                     // the deck / body
    // the counterweight: a heavy rounded back
    const cw = this._mesh(this.cyl, this.dark, 0.7, 0.5, 0.7, -0.62, 0.32, 0, house);
    cw.scale.set(0.42, 0.5, 0.68);
    this._mesh(this.box, this.paint, 0.62, 0.36, 0.62, -0.38, 0.62, 0.36, house);                   // the engine hood (right rear)
    for (let k = 0; k < 5; k++) this._mesh(this.box, this.dark, 0.5, 0.012, 0.03, -0.38, 0.805, 0.16 + k * 0.1, house);   // its grille
    this._mesh(this.box, this.decal, 0.5, 0.12, 0.004, -0.38, 0.58, 0.672, house, false);
    // exhaust stack
    this._mesh(this.cyl, this.dark, 0.035, 0.32, 0.035, -0.5, 0.95, 0.52, house);
    // the cab (left): four posts, a roof, glass, the seat, two control towers, work lights
    const cab = (this.cab = new THREE.Group());
    cab.name = "cab";
    house.add(cab);
    const cx = 0.12, cz = -0.34, ch = 1.2, y0 = 0.48;
    for (const [px, pz] of [[cx + 0.42, cz - 0.3], [cx + 0.42, cz + 0.3], [cx - 0.42, cz - 0.3], [cx - 0.42, cz + 0.3]]) this._mesh(this.box, this.dark, 0.05, ch, 0.05, px, y0 + ch / 2, pz, cab);
    this._mesh(this.box, this.paint, 0.98, 0.07, 0.72, cx, y0 + ch + 0.03, cz, cab);
    this._mesh(this.box, this.dark, 0.9, 0.36, 0.62, cx - 0.04, y0 + 0.16, cz, cab);                  // the cab's floor box
    const glassF = this._mesh(this.box, this.glass, 0.01, ch - 0.38, 0.56, cx + 0.42, y0 + 0.62, cz, cab, false);
    const glassL = this._mesh(this.box, this.glass, 0.8, ch - 0.38, 0.01, cx, y0 + 0.62, cz + 0.3, cab, false);
    const glassR = this._mesh(this.box, this.glass, 0.8, ch - 0.6, 0.01, cx, y0 + 0.73, cz - 0.3, cab, false);
    this.glassParts = [glassF, glassL, glassR];
    // the seat and the control towers - seen from outside; from the seat itself they would fill the view (hidden then)
    const inside = (this.cabInterior = new THREE.Group());
    cab.add(inside);
    this._mesh(this.box, this.seat, 0.36, 0.1, 0.42, cx - 0.12, y0 + 0.4, cz, inside);
    this._mesh(this.box, this.seat, 0.08, 0.5, 0.42, cx - 0.32, y0 + 0.68, cz, inside);
    for (const s of [-1, 1]) {
      this._mesh(this.box, this.dark, 0.3, 0.32, 0.1, cx + 0.06, y0 + 0.5, cz + s * 0.24, inside);
      const lev = this._mesh(this.cyl, this.dark, 0.012, 0.16, 0.012, cx + 0.16, y0 + 0.73, cz + s * 0.24, inside);
      lev.rotation.z = -0.25;
      this._mesh(this.cyl, this.seat, 0.022, 0.06, 0.022, cx + 0.18, y0 + 0.81, cz + s * 0.24, inside);
    }
    for (const s of [-1, 1]) this._mesh(this.box, this.light, 0.05, 0.06, 0.09, cx + 0.48, y0 + ch - 0.04, cz + s * 0.24, cab, false);
    // ---- the boom: a bent ("banana") boom from the pivot to its tip on its +x (two webbed segments)
    const P = E.boomPivot;
    this._mesh(this.box, this.paint, 0.22, 0.28, 0.24, P[0] - 0.08, P[1] - 0.1, P[2], house);        // the swing bracket
    const boom = (this.boom = new THREE.Group());
    boom.name = "boom";
    boom.position.set(P[0], P[1], P[2]);
    house.add(boom);
    const knee = [1.12, 0.36];
    this._seg(boom, [0, 0], knee, 0.2, 0.17, this.paint);
    this._seg(boom, knee, [E.boomL, 0], 0.17, 0.15, this.paint);
    this._mesh(this.cylZ, this.steel, 0.07, 0.07, 0.22, 0, 0, 0, boom);
    this._mesh(this.cylZ, this.steel, 0.06, 0.06, 0.2, E.boomL, 0, 0, boom);
    // ---- the stick
    const stick = (this.stick = new THREE.Group());
    stick.name = "stick";
    stick.position.set(E.boomL, 0, 0);
    boom.add(stick);
    this._seg(stick, [-0.22, 0.1], [E.stickL, 0], 0.15, 0.13, this.paint);
    this._mesh(this.cylZ, this.steel, 0.05, 0.05, 0.18, E.stickL, 0, 0, stick);
    // ---- the tool: the bucket (and the breaker, shown instead)
    const tool = (this.tool = new THREE.Group());
    tool.name = "tool";
    tool.position.set(E.stickL, 0, 0);
    stick.add(tool);
    this.bucket = this._bucket(tool);
    this.breaker = this._breaker(tool);
    this.breaker.visible = false;
    // ---- hydraulic cylinders (body + chrome rod), stretched between two points every frame
    this.rams = [
      this._ram(house, boom, [0.95, 0.2, 0.1], [0.72, -0.11]),           // boom ram: the house's front -> under the boom
      this._ram(boom, stick, [0.5, 0.24, 0], [-0.22, 0.12]),               // stick ram: on top of the boom -> the stick's heel
      this._ram(stick, tool, [0.25, 0.1, 0], [-0.05, 0.08]),               // bucket ram: along the stick -> the bucket's linkage
    ];
    this.eyeLocal = new THREE.Vector3(E.eye[0], E.eye[1], E.eye[2]);
    this.pose = { swing: 0, boom: 0.35, stick: -1.5, tool: -0.9 };
    this._merge();
    this.setPose(this.pose);
  }

  // fewer draw calls: every joint's static parts baked per material into that joint (tracks, house,
  // cab interior, glass, boom, stick, bucket, breaker) - the rams (they stretch) and the load stay apart
  _merge() {
    const THREE = this.THREE, rams = new Set(this.rams.map((r) => r.g));
    const collect = (root, stop, skip = new Set()) => {
      const out = [];
      const walk = (o) => {
        for (const c of o.children) {
          if (stop.has(c) || rams.has(c)) continue;
          if (c.isMesh && !c.isInstancedMesh && !skip.has(c)) out.push(c);
          walk(c);
        }
      };
      walk(root);
      return out;
    };
    const keep = (list) => { this.geos.push(...list.map((m) => m.geometry)); return list; };
    const glass = new Set(this.glassParts), fill = new Set([this.fill, this.fillLumps]);
    keep(mergeStatic(THREE, this.tracks, collect(this.tracks, new Set())));
    keep(mergeStatic(THREE, this.cabInterior, collect(this.cabInterior, new Set())));
    keep(mergeStatic(THREE, this.house, collect(this.house, new Set([this.boom, this.cabInterior]), glass)));
    this.glassParts = keep(mergeStatic(THREE, this.cab, this.glassParts, { shadow: false }));      // (after the house: not baked into it)
    keep(mergeStatic(THREE, this.boom, collect(this.boom, new Set([this.stick]))));
    keep(mergeStatic(THREE, this.stick, collect(this.stick, new Set([this.tool]))));
    keep(mergeStatic(THREE, this.bucket, collect(this.bucket, new Set(), fill)));
    keep(mergeStatic(THREE, this.breakerBody, collect(this.breakerBody, new Set())));
  }

  // a web segment in the x-y plane of `parent` from a to b (width w at a, w2 at b), the boom's thickness
  _seg(parent, a, b, w, w2, m) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    const o = this._mesh(this.box, m, L + 0.05, (w + w2) / 2, 0.16, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0, parent);
    o.rotation.z = Math.atan2(dy, dx);
    return o;
  }

  // a ram: its barrel fixed at `pa` in parent A, its rod end at `pb` (x, y) in group B - laid out per frame
  _ram(A, B, pa, pb) {
    const THREE = this.THREE, g = new THREE.Group();
    A.add(g);
    const barrel = this._mesh(this.cyl, this.paint, 0.05, 1, 0.05, 0, 0, 0, g);
    const rod = this._mesh(this.cyl, this.chrome, 0.026, 1, 0.026, 0, 0, 0, g);
    return { g, A, B, a: new THREE.Vector3(pa[0], pa[1], pa[2]), b: new THREE.Vector3(pb[0], pb[1], 0), barrel, rod };
  }

  _bucket(tool) {
    const THREE = this.THREE, g = new THREE.Group();
    g.name = "bucket";
    tool.add(g);
    const W = 0.56, R = 0.27, cx = 0.16, cy = -0.18;
    // the shell: a part cylinder, open towards the teeth
    // (cylinder angle th lies at (R sin th, -R cos th) once turned onto the z axis: from the top over the
    // back and the bottom to the lip in front - the mouth open forwards)
    const shellG = this._geo(new THREE.CylinderGeometry(R, R, W, 18, 1, true, Math.PI * 0.95, Math.PI * 1.4));
    shellG.rotateX(Math.PI / 2);
    this.bucketSteel = this._mat(this.steel.clone());
    this.bucketSteel.side = THREE.DoubleSide;
    this._mesh(shellG, this.bucketSteel, 1, 1, 1, cx, cy, 0, g);
    this.paintWorn.side = THREE.DoubleSide;
    const sideG = this._geo(new THREE.CircleGeometry(R + 0.01, 18, Math.PI * 0.45, Math.PI * 1.4));
    for (const s of [-1, 1]) this._mesh(sideG, this.paintWorn, 1, 1, 1, cx, cy, s * W / 2, g);
    // the linkage ears on the back, the cutting lip and five teeth
    for (const s of [-1, 1]) this._mesh(this.box, this.paint, 0.18, 0.1, 0.03, 0.02, -0.02, s * 0.1, g);
    const lip = this._mesh(this.box, this.dark, 0.05, 0.02, W, EXC.teeth[0] - 0.04, EXC.teeth[1] + 0.02, 0, g);
    lip.rotation.z = -0.7;
    for (let k = 0; k < 5; k++) {
      const t = this._mesh(this.box, this.dark, 0.09, 0.03, 0.045, EXC.teeth[0], EXC.teeth[1], -W / 2 + 0.06 + k * ((W - 0.12) / 4), g);
      t.rotation.z = -0.75;
    }
    // the load: a mound in the mouth (scaled by the fill), lumps on it
    const fillG = this._geo(new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2));
    this.fill = this._mesh(fillG, this.loadMat, 0.2, 0.1, W * 0.46, EXC.mouth[0], EXC.mouth[1], 0, g);
    this.fill.visible = false;
    this.fillLumps = new THREE.InstancedMesh(this._geo(new THREE.IcosahedronGeometry(1, 0)), this.loadMat, 10);
    this.fillLumps.count = 0;
    this.fillLumps.frustumCulled = false;
    g.add(this.fillLumps);
    return g;
  }

  _breaker(tool) {
    const THREE = this.THREE, g = new THREE.Group();
    g.name = "breaker";
    tool.add(g);
    // a box housing hanging from the stick, the chisel pointing out of its lower end (the tool's -y)
    const body = new THREE.Group();
    body.position.set(0.06, -0.3, 0);
    g.add(body);
    this._mesh(this.box, this.paint, 0.22, 0.58, 0.24, 0, 0, 0, body);
    this._mesh(this.box, this.dark, 0.24, 0.12, 0.26, 0, 0.22, 0, body);
    this._mesh(this.box, this.dark, 0.18, 0.08, 0.2, 0, -0.32, 0, body);
    this.chisel = this._mesh(this.cyl, this.steel, 0.04, 0.32, 0.04, 0, -0.5, 0, body);
    const tip = this._mesh(this._geo(new THREE.ConeGeometry(0.04, 0.08, 8)), this.steel, 1, 1, 1, 0, -0.7, 0, body);
    tip.rotation.z = Math.PI;
    this.chiselTip = new THREE.Object3D();
    this.chiselTip.position.set(0, -0.74, 0);
    body.add(this.chiselTip);
    this.breakerBody = body;
    return g;
  }

  // from the operator's seat: no seat / towers in the view, the cab's front glass out of the way
  setFirstPerson(on) {
    if (this.cabInterior) this.cabInterior.visible = !on;
    for (const g of this.glassParts || []) g.visible = !on;
  }

  setAttachment(kind) {
    this.bucket.visible = kind !== "breaker";
    this.breaker.visible = kind === "breaker";
  }

  /** pose = { swing, boom, stick, tool } radians (boom: up from horizontal; stick, tool: relative) */
  setPose(p) {
    this.pose = p;
    this.house.rotation.y = p.swing;
    this.boom.rotation.z = p.boom;
    this.stick.rotation.z = p.stick;
    this.tool.rotation.z = p.tool;
    this.root.updateMatrixWorld(true);
    for (const r of this.rams) this._layRam(r);
  }

  _layRam(r) {
    const a = r.a, b = this._v.set(r.b.x, r.b.y, r.b.z);
    // b from group B into group A's frame
    r.B.localToWorld(b);
    r.A.worldToLocal(b);
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, L = Math.hypot(dx, dy, dz) || 0.001;
    r.g.position.copy(a);
    r.g.quaternion.setFromUnitVectors(this._up || (this._up = new this.THREE.Vector3(0, 1, 0)), this._s.set(dx / L, dy / L, dz / L));
    const bl = Math.min(L * 0.62, 0.95);
    r.barrel.scale.set(0.05, bl, 0.05); r.barrel.position.y = bl / 2;
    r.rod.scale.set(0.026, L - bl + 0.05, 0.026); r.rod.position.y = bl + (L - bl) / 2 - 0.02;
  }

  /**
   * Planar IK in the house frame: the wrist (stick tip) to (r, y) - r forward from the slewing
   * centre, y up from the house frame's origin. -> { boom, stick } (elbow up), clamped to reach.
   */
  static solve(r, y) {
    const E = EXC, L1 = E.boomL, L2 = E.stickL;
    let dx = r - E.boomPivot[0], dy = y - E.boomPivot[1];
    let d = Math.hypot(dx, dy);
    const dMin = Math.abs(L1 - L2) + 0.08, dMax = L1 + L2 - 0.02;
    if (d < dMin || d > dMax) { const k = Math.max(dMin, Math.min(dMax, d)) / (d || 1); dx *= k; dy *= k; d = Math.hypot(dx, dy); }
    const a1 = Math.acos(Math.max(-1, Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d))));
    const g = Math.acos(Math.max(-1, Math.min(1, (L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2))));
    return { boom: Math.atan2(dy, dx) + a1, stick: -(Math.PI - g) };
  }

  // the tool's rotation (relative to the stick) for an absolute angle phi in the house's plane
  static toolFor(phi, boom, stick) { return phi - boom - stick; }

  // the wrist for teeth at (r, y) with the tool held at absolute angle phi
  static wristFor(r, y, phi, pt = EXC.teeth) {
    const c = Math.cos(phi), s = Math.sin(phi);
    return [r - (pt[0] * c - pt[1] * s), y - (pt[0] * s + pt[1] * c)];
  }

  // world positions (the rig's matrices must be current)
  eyeWorld(out) { return this.house.localToWorld(out.copy(this.eyeLocal)); }
  teethWorld(out) { return this.bucket.localToWorld(out.set(EXC.teeth[0], EXC.teeth[1], 0)); }
  mouthWorld(out) { return this.bucket.localToWorld(out.set(EXC.mouth[0], EXC.mouth[1] + 0.05, 0)); }
  chiselWorld(out) { return this.chiselTip.getWorldPosition(out); }

  // the tracks' rubber moves with their speeds (m/s); the texture repeats every 0.5 m
  trackScroll(vl, vr, dt) {
    this._tl = ((this._tl || 0) + vl * dt) % 100;
    this.trackMap.offset.x = -this._tl / 0.5;
  }

  // the load in the bucket: frac 0..1 of its capacity, colour (r, g, b)
  setLoad(frac, rgb, seed = 1) {
    const f = Math.max(0, Math.min(1, frac));
    this.fill.visible = f > 0.02;
    if (this.fill.visible) {
      this.fill.scale.set(0.12 + 0.12 * f, 0.04 + 0.16 * f, 0.26 * (0.7 + 0.3 * f));
      this.fill.position.set(EXC.mouth[0] - 0.02, EXC.mouth[1] - 0.05 + 0.06 * f, 0);
      // the material's colours are sRGB values (as the terrain's) - set as such, a little darker (fresh, damp)
      if (rgb) this.loadMat.color.setRGB(rgb[0] * 0.8, rgb[1] * 0.8, rgb[2] * 0.8, this.THREE.SRGBColorSpace);
    }
    const n = this.fill.visible ? Math.min(10, Math.round(3 + 7 * f)) : 0;
    const L = this.fillLumps;
    if (n !== L.count || this._loadSeed !== seed) {
      this._loadSeed = seed;
      L.count = n;
      for (let i = 0; i < n; i++) {
        const h = fract(Math.sin((seed + i * 13) * 12.9898) * 43758.5453), h2 = fract(h * 5.7), s = 0.03 + 0.03 * h;
        this._m.compose(this._v.set(EXC.mouth[0] - 0.08 + h * 0.18, EXC.mouth[1] + 0.02 + 0.12 * f * h2, (h2 - 0.5) * 0.4), this._q.setFromAxisAngle(this._s.set(0, 1, 0), h * 6), this._s.set(s * 1.3, s * 0.7, s));
        L.setMatrixAt(i, this._m);
      }
      L.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.texs) t.dispose();
  }
}

// an authored model (models/excavator.glb) wrapped into the same interface - null when it lacks a node
export function rigFromScene(THREE, scene, base) {
  const need = ["tracks", "house", "cab", "boom", "stick", "tool"], nodes = {};
  scene.traverse((o) => { if (need.includes(o.name) || ["bucket", "breaker", "eye"].includes(o.name)) nodes[o.name] = o; });
  if (need.some((n) => !nodes[n])) return null;
  const rig = Object.create(ExcavatorRig.prototype);
  Object.assign(rig, base, { root: scene, tracks: nodes.tracks, house: nodes.house, cab: nodes.cab, boom: nodes.boom, stick: nodes.stick, tool: nodes.tool,
    bucket: nodes.bucket || nodes.tool, breaker: nodes.breaker || new THREE.Group(), rams: [], glassParts: [] });
  if (nodes.eye) rig.eyeLocal = nodes.eye.position.clone();
  rig.fill = base.fill; rig.fillLumps = base.fillLumps;
  rig.bucket.add(base.fill, base.fillLumps);
  return rig;
}

export { noise2 };
