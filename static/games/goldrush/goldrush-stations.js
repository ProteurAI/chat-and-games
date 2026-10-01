// GoldRush - the camp's two stations, part of the world (not menus):
//
//   GOLDANKAUF (assay)  a work table under a canvas awning next to the shed:
//                       a balance scale, a gold pan, a cash box and the
//                       ledger. Selling puts the pouch on the scale - the
//                       beam dips, wobbles and settles.
//   AUSRÜSTUNG (supply) the tool shed's front: a counter under the window
//                       and a rack on the wall where the shovel and the
//                       pickaxe hang until you buy them.
//
// Built here from simple shapes with the world's own materials (no
// external asset); the signs are painted on canvas. All static parts are
// merged into one mesh per material (a handful of draw calls for the whole
// camp), the scale and the tools on the rack stay movable / hideable;
// nothing runs per frame unless the scale moves.
// Interaction: stand at a station's spot, roughly facing it.

const ASSAY = { x: -12.4, z: 10.75 };            // table centre (out of the shed's afternoon shadow)
const SHED_FRONT_Z = 11.56;                       // the shed's north wall (outside face)

export const STATIONS = [
  { id: "assay", label: "Goldankauf", action: "Gold verkaufen", x: ASSAY.x, z: 9.25, lookX: ASSAY.x, lookZ: ASSAY.z, r: 2.0 },
  { id: "supply", label: "Ausrüstung", action: "Ausrüstung ansehen", x: -18.75, z: 10.35, lookX: -18.75, lookZ: SHED_FRONT_Z, r: 1.9 },
];

// bake meshes (with their transforms) into one geometry per material
function mergeByMaterial(THREE, meshes) {
  const groups = new Map();
  for (const m of meshes) {
    m.updateMatrixWorld(true);
    const g = m.geometry.index ? m.geometry.clone() : m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    if (!groups.has(m.material)) groups.set(m.material, []);
    groups.get(m.material).push(g);
  }
  const out = [];
  for (const [material, list] of groups) {
    let nv = 0, ni = 0;
    for (const g of list) { nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = new Uint32Array(ni);
    let ov = 0, oi = 0;
    for (const g of list) {
      const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
      pos.set(P.array.subarray(0, P.count * 3), ov * 3);
      if (N) nor.set(N.array.subarray(0, P.count * 3), ov * 3);
      if (U) uv.set(U.array.subarray(0, P.count * 2), ov * 2);
      if (g.index) for (let q = 0; q < g.index.count; q++) idx[oi + q] = g.index.getX(q) + ov;
      else for (let q = 0; q < P.count; q++) idx[oi + q] = q + ov;
      oi += g.index ? g.index.count : P.count;
      ov += P.count;
      g.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.push(mesh);
  }
  return out;
}

function signTexture(THREE, text, { w = 512, h = 128, bg = "#6b4a2c", fg = "#f2dfb6" } = {}) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 26; i++) {                                     // weathered planks
    g.strokeStyle = `rgba(30,18,8,${0.08 + (i % 5) * 0.03})`;
    g.lineWidth = 1 + (i % 3);
    const y = (i * 37) % h;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y + ((i % 4) - 2) * 3); g.stroke();
  }
  g.fillStyle = "rgba(20,12,6,0.35)"; g.fillRect(0, h / 2 - 1, w, 2);
  g.font = `700 ${Math.round(h * 0.5)}px Georgia, 'Times New Roman', serif`;
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillStyle = "rgba(0,0,0,0.35)"; g.fillText(text, w / 2 + 2, h / 2 + 3);
  g.fillStyle = fg; g.fillText(text, w / 2, h / 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class Stations {
  /**
   * @param world   GoldRushWorld (materials, textures, colliders, groundAt)
   * @param models  ToolModels (the shovel / pickaxe shown on the rack)
   */
  constructor(THREE, scene, world, { models, goldMat }) {
    this.THREE = THREE;
    this.scene = scene;
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = "goldrush-stations";
    scene.add(this.group);
    this.geos = [];
    this.mats = [];
    this.texs = [];
    const geo = (g) => { this.geos.push(g); return g; };
    const mat = (m) => { this.mats.push(m); return m; };
    const wood = mat(new THREE.MeshStandardMaterial({ map: world.woodTex, color: 0xb08a62, roughness: 0.88 }));
    const darkWood = mat(new THREE.MeshStandardMaterial({ map: world.woodTex, color: 0x6e5038, roughness: 0.9 }));
    const steel = mat(new THREE.MeshStandardMaterial({ color: 0x9a9a96, roughness: 0.38, metalness: 0.85, envMap: world.envMap || null }));
    const brass = mat(new THREE.MeshStandardMaterial({ color: 0xb8913f, roughness: 0.32, metalness: 0.9, envMap: world.envMap || null }));
    const paper = mat(new THREE.MeshStandardMaterial({ color: 0xe9dfc6, roughness: 0.95 }));
    const leather = mat(new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.8 }));
    const canvas = mat(new THREE.MeshStandardMaterial({ color: 0xcab68e, roughness: 0.96, side: THREE.DoubleSide }));
    this.goldMat = goldMat;
    const add = (mesh, x, y, z, ry = 0) => {
      mesh.position.set(x, y, z);
      mesh.rotation.y = ry;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      return mesh;
    };
    const box = (w, h, d, m) => new THREE.Mesh(geo(new THREE.BoxGeometry(w, h, d)), m);

    // ---------------- GOLDANKAUF: work table, awning, scale, pan, cash box, ledger, sign
    const tx = ASSAY.x, tz = ASSAY.z, th = 0.86;
    add(box(1.5, 0.06, 0.72, wood), tx, th, tz);
    const legG = geo(new THREE.BoxGeometry(0.07, th - 0.03, 0.07));
    for (const [dx, dz] of [[-0.68, -0.3], [0.68, -0.3], [-0.68, 0.3], [0.68, 0.3]]) add(new THREE.Mesh(legG, darkWood), tx + dx, (th - 0.03) / 2, tz + dz);
    add(box(1.36, 0.04, 0.05, darkWood), tx, 0.25, tz + 0.3);                     // stretcher
    world.colliders.push({ type: "box", x: tx, z: tz, hw: 0.78, hd: 0.4, rot: 0 });
    // awning: four posts and a sagging canvas, sloping to the back
    const postG = geo(new THREE.CylinderGeometry(0.045, 0.05, 2.35, 8));
    for (const [dx, dz, hgt] of [[-0.95, -0.55, 2.3], [0.95, -0.55, 2.3], [-0.95, 0.75, 2.05], [0.95, 0.75, 2.05]]) {
      const p = add(new THREE.Mesh(postG, darkWood), tx + dx, hgt / 2, tz + dz);
      p.scale.y = hgt / 2.35;
      world.colliders.push({ type: "circle", x: tx + dx, z: tz + dz, r: 0.08 });
    }
    const awG = geo(new THREE.PlaneGeometry(2.2, 1.55, 10, 6));
    const ap = awG.attributes.position;
    for (let v = 0; v < ap.count; v++) {
      const x = ap.getX(v), y = ap.getY(v);
      ap.setZ(v, -0.06 * (1 - (x / 1.1) ** 2) * (1 - (y / 0.78) ** 2));      // sags between the posts
    }
    awG.computeVertexNormals();
    const aw = add(new THREE.Mesh(awG, canvas), tx, 2.2, tz + 0.1);
    aw.rotation.x = -Math.PI / 2 + 0.17;
    aw.castShadow = false;                               // the table stays in the light (readable)
    // balance scale: base, post, beam (pivots), two pans
    const scale = (this.scale = new THREE.Group());
    scale.position.set(tx - 0.28, th + 0.03, tz + 0.05);
    this.group.add(scale);
    const sBase = new THREE.Mesh(geo(new THREE.BoxGeometry(0.22, 0.03, 0.12)), darkWood);
    sBase.position.y = 0.015;
    const sPost = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.009, 0.012, 0.34, 8)), brass);
    sPost.position.y = 0.2;
    scale.add(sBase, sPost);
    const beam = (this.beam = new THREE.Group());
    beam.position.y = 0.37;
    scale.add(beam);
    const beamBar = new THREE.Mesh(geo(new THREE.BoxGeometry(0.36, 0.012, 0.014)), brass);
    beam.add(beamBar);
    const needle = new THREE.Mesh(geo(new THREE.BoxGeometry(0.006, 0.09, 0.006)), steel);
    needle.position.y = -0.045;
    beam.add(needle);
    const panG = geo(new THREE.LatheGeometry([[0, 0], [0.06, 0.004], [0.075, 0.018], [0.078, 0.022]].map(([x, y]) => new THREE.Vector2(x, y)), 18));
    const rodG = geo(new THREE.CylinderGeometry(0.0025, 0.0025, 0.2, 5));
    this.pans = [];
    for (const side of [-1, 1]) {
      const pan = new THREE.Group();
      const dish = new THREE.Mesh(panG, brass);
      const rod = new THREE.Mesh(rodG, steel);
      rod.position.y = 0.1;
      pan.add(dish, rod);
      scale.add(pan);
      this.pans.push({ group: pan, side });
    }
    // the gold of a sale on the left pan
    const lumpG = geo(new THREE.IcosahedronGeometry(0.012, 0));
    this.heap = new THREE.Group();
    for (let i = 0; i < 7; i++) {
      const l = new THREE.Mesh(lumpG, goldMat);
      l.position.set(Math.cos(i * 2.4) * 0.025 * (i % 3), 0.012 + (i % 2) * 0.008, Math.sin(i * 2.4) * 0.025 * (i % 3));
      l.scale.setScalar(0.7 + (i % 3) * 0.35);
      this.heap.add(l);
    }
    this.heap.visible = false;
    this.pans[0].group.add(this.heap);
    this.tilt = 0; this.tiltV = 0; this.tiltTarget = 0;
    this._placeScale();
    // gold pan, cash box, ledger and a pencil
    const goldPan = add(new THREE.Mesh(geo(new THREE.LatheGeometry([[0, 0], [0.13, 0.008], [0.19, 0.045], [0.2, 0.052]].map(([x, y]) => new THREE.Vector2(x, y)), 24)), steel), tx + 0.36, th + 0.03, tz + 0.08);
    goldPan.rotation.z = 0.04;
    const cash = add(box(0.26, 0.11, 0.18, darkWood), tx + 0.05, th + 0.085, tz + 0.2);
    cash.rotation.y = 0.12;
    const lid = add(box(0.27, 0.015, 0.19, steel), tx + 0.05, th + 0.145, tz + 0.2);
    lid.rotation.y = 0.12;
    add(box(0.24, 0.025, 0.32, leather), tx + 0.55, th + 0.043, tz - 0.12, -0.25);
    add(box(0.225, 0.006, 0.3, paper), tx + 0.55, th + 0.058, tz - 0.12, -0.25);
    const pencil = add(new THREE.Mesh(geo(new THREE.CylinderGeometry(0.004, 0.004, 0.16, 6)), mat(new THREE.MeshStandardMaterial({ color: 0xd8a33a, roughness: 0.6 }))), tx + 0.42, th + 0.036, tz - 0.2);
    pencil.rotation.z = Math.PI / 2;
    pencil.rotation.y = 0.6;
    // sign: a board hanging from the awning's front edge, painted on both sides
    const signTex = signTexture(THREE, "GOLDANKAUF");
    this.texs.push(signTex);
    const signMat = mat(new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.85 }));
    const boardG = geo(new THREE.BoxGeometry(1.1, 0.28, 0.03));
    const faceG = geo(new THREE.PlaneGeometry(1.06, 0.25));
    add(new THREE.Mesh(boardG, darkWood), tx, 2.02, tz - 0.6);
    add(new THREE.Mesh(faceG, signMat), tx, 2.02, tz - 0.6 - 0.017, Math.PI);       // towards the path (north)
    add(new THREE.Mesh(faceG, signMat), tx, 2.02, tz - 0.6 + 0.017);                // and from under the awning

    // ---------------- AUSRÜSTUNG: counter under the window, rack, sign
    const cz = SHED_FRONT_Z;
    add(box(1.5, 0.06, 0.42, wood), -19.25, 1.0, cz - 0.22);                      // counter board
    const brG = geo(new THREE.BoxGeometry(0.05, 0.3, 0.32));
    for (const dx of [-0.6, 0.6]) add(new THREE.Mesh(brG, darkWood), -19.25 + dx, 0.82, cz - 0.17);
    add(box(0.32, 0.22, 0.24, mat(new THREE.MeshStandardMaterial({ map: world.woodTex, color: 0xc6a27a, roughness: 0.9 }))), -19.7, 1.14, cz - 0.24, 0.15);   // small crate of nails
    world.colliders.push({ type: "box", x: -19.25, z: cz - 0.22, hw: 0.75, hd: 0.25, rot: 0 });
    // rack board with pegs; the tools for sale hang on it
    add(box(0.92, 1.55, 0.04, wood), -18.35, 1.42, cz - 0.03);              // lighter board: the tools stand out in the shade
    const pegG = geo(new THREE.CylinderGeometry(0.012, 0.012, 0.08, 6));
    for (const dx of [-0.2, 0.22]) {
      const peg = add(new THREE.Mesh(pegG, steel), -18.35 + dx, 2.1, cz - 0.08);
      peg.rotation.x = Math.PI / 2;
    }
    const supTex = signTexture(THREE, "AUSRÜSTUNG");
    this.texs.push(supTex);
    const supMat = mat(new THREE.MeshStandardMaterial({ map: supTex, roughness: 0.85 }));
    add(box(1.5, 0.3, 0.03, darkWood), -18.8, 2.38, cz - 0.03);
    add(new THREE.Mesh(geo(new THREE.PlaneGeometry(1.46, 0.27)), supMat), -18.8, 2.38, cz - 0.047, Math.PI);

    // merge everything static: one mesh per material
    const statics = this.group.children.filter((o) => o.isMesh);
    for (const m of statics) this.group.remove(m);
    const merged = mergeByMaterial(THREE, statics);
    const inUse = new Set();                                // the scale keeps its own parts (it moves)
    scale.traverse((o) => { if (o.isMesh) inUse.add(o.geometry); });
    for (const g of this.geos) if (!inUse.has(g)) g.dispose();
    this.geos = [...inUse];
    for (const m of merged) { this.group.add(m); this.geos.push(m.geometry); }

    // the tools for sale on the rack: each merged per material, hidden once bought
    this.rackTools = {};
    if (models) {
      for (const [id, dx, y] of [["shovel", -0.2, 1.68], ["pickaxe", 0.22, 1.73]]) {
        const src = models[id].clone(true);
        src.rotation.x = -Math.PI / 2;                    // handle up, working end down, front towards the path
        src.position.set(-18.35 + dx, y, cz - 0.12);
        src.updateMatrixWorld(true);
        const parts = [];
        src.traverse((o) => { if (o.isMesh && o.visible && o.geometry !== models.soil.geometry) parts.push(o); });
        const merged = new THREE.Group();
        for (const m of mergeByMaterial(THREE, parts)) { merged.add(m); this.geos.push(m.geometry); }
        this.group.add(merged);
        this.rackTools[id] = merged;
      }
    }
    this.time = 0;
  }

  // the station the player can use right now (in reach, roughly facing it) or null
  near(px, pz, yaw) {
    for (const s of STATIONS) {
      const d = Math.hypot(px - s.x, pz - s.z);
      if (d > s.r) continue;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const tx = s.lookX - px, tz = s.lookZ - pz, tl = Math.hypot(tx, tz) || 1;
      if ((fx * tx + fz * tz) / tl < 0.35) continue;                // looking away (> ~70 deg)
      return s;
    }
    return null;
  }

  // the tools still for sale hang on the rack
  setOwned(owned) {
    for (const [id, m] of Object.entries(this.rackTools)) m.visible = !owned.has(id);
  }

  // a sale: the pouch goes on the scale; mass sets how far the beam dips
  weigh(ug) {
    this.heap.visible = ug > 0;
    this.heap.scale.setScalar(Math.min(1.6, 0.7 + Math.log10(1 + ug / 2000) * 0.45));
    this.tiltTarget = Math.min(0.2, 0.06 + Math.log10(1 + ug / 1000) * 0.05);
    this.tiltV = 1.8;
    this.weighT = 2.6;                                   // then it is taken off again
  }

  _placeScale() {
    const a = this.tilt;
    this.beam.rotation.z = a;
    for (const p of this.pans) {
      const x = p.side * 0.17 * Math.cos(a), y = 0.37 + p.side * 0.17 * Math.sin(a);
      p.group.position.set(x, y - 0.2, 0);
    }
  }

  update(dt) {
    this.time += dt;
    if (this.weighT > 0) {
      this.weighT -= dt;
      if (this.weighT <= 0) { this.tiltTarget = 0; this.heap.visible = false; }
    }
    if (this.tilt === this.tiltTarget && this.tiltV === 0) return;
    // a damped spring: dips, wobbles, settles
    const k = 60, c = 7;
    const acc = (this.tiltTarget - this.tilt) * k - this.tiltV * c;
    this.tiltV += acc * dt;
    this.tilt += this.tiltV * dt;
    if (Math.abs(this.tilt - this.tiltTarget) < 1e-4 && Math.abs(this.tiltV) < 1e-3) { this.tilt = this.tiltTarget; this.tiltV = 0; }
    this._placeScale();
  }

  get settled() { return this.tilt === this.tiltTarget && this.tiltV === 0; }

  dispose() {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.texs) t.dispose();
    this.scene.remove(this.group);
  }
}
