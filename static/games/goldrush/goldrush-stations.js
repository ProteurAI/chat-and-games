// GoldRush - the camp's two stations, part of the world (not menus):
//
//   GOLDANKAUF (assay)  an assay booth (phase 8, goldrush-buildings.js): the
//                       brass balance on its counter, lockbox, ledger,
//                       sample shelves. Selling sets the pouch on the scale -
//                       the beam dips, brass weights go on, it settles.
//   AUSRÜSTUNG (supply) an open-front supply shack: a serving counter, the
//                       shovel and the pickaxe on a rack in the opening
//                       until you buy them, shelves of gear inside.
//
//   BERGAUFTRAG (contract, phase 9)  a notice board at the camp's edge, facing
//                       the mountain: the order to take the whole mountain away
//                       and how far it has come (goldrush-contract.js) -
//                       repainted when the numbers change; [E] opens its panel.
//
// Built here from simple shapes with the world's own materials (no
// external asset); the signs are painted on canvas. All static parts are
// merged into one mesh per material (a handful of draw calls for the whole
// camp), the scale and the tools on the rack stay movable / hideable;
// nothing runs per frame unless the scale moves.
// Interaction: stand at a station's spot, roughly facing it.

import { boardTexture, buildAssayBooth, buildSupplyShack, buildingMaterials } from "./goldrush-buildings.js";

const ASSAY = { x: -12.4, z: 10.75 };            // the booth's counter (out of the shack's afternoon shadow)
export const SHED = { x: -18.2, z: 13.2 };        // the supply shack (4.2 x 3.2 m)
const SHED_FRONT_Z = 11.6;                        // its open front (towards the camp)
export const BOARD = { x: -15.95, z: 7.6 };        // phase 9: the contract board (faces east, the mountain)

export const STATIONS = [
  { id: "assay", label: "Goldankauf", action: "Gold verkaufen", x: ASSAY.x, z: 9.25, lookX: ASSAY.x, lookZ: ASSAY.z, r: 2.0 },
  { id: "supply", label: "Ausrüstung", action: "Ausrüstung ansehen", x: -18.75, z: 10.35, lookX: -18.75, lookZ: SHED_FRONT_Z, r: 1.9 },
  { id: "contract", label: "Bergauftrag", action: "Bergauftrag lesen", x: BOARD.x + 1.35, z: BOARD.z, lookX: BOARD.x, lookZ: BOARD.z, r: 1.7 },
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
    const leather = mat(new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.8 }));
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

    // ---------------- GOLDANKAUF (phase 8): the assay booth (goldrush-buildings.js) round its counter,
    // the brass balance on it - the focal point - and the board across the roof
    const BM = buildingMaterials(THREE, world);
    for (const m of Object.values(BM)) if (m && m.isMaterial) this.mats.push(m);
    this.texs.push(...BM.texs);
    const addS = (o) => { o.castShadow = true; o.receiveShadow = true; this.group.add(o); return o; };
    const booth = buildAssayBooth(THREE, { x: ASSAY.x, z: ASSAY.z, add: addS, M: BM, geo, colliders: world.colliders });
    const th = booth.counterY;
    // balance scale: base, post, beam (pivots), two pans - larger than a table scale: read from the path
    const scale = (this.scale = new THREE.Group());
    scale.position.set(booth.scaleAt.x, th, booth.scaleAt.z);
    scale.scale.setScalar(1.45);
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
    // a sale (phase 8): the pouch is set on the left pan, the gold out of it beside; brass weights on
    // the right one until the beam balances
    const lumpG = geo(new THREE.IcosahedronGeometry(0.012, 0));
    this.heap = new THREE.Group();
    const pouch = new THREE.Mesh(geo(new THREE.SphereGeometry(0.03, 10, 8)), leather);
    pouch.scale.set(1, 0.85, 0.9);
    pouch.position.set(-0.018, 0.03, 0);
    this.heap.add(pouch);
    for (let i = 0; i < 6; i++) {
      const l = new THREE.Mesh(lumpG, goldMat);
      l.position.set(0.022 + Math.cos(i * 2.4) * 0.016 * (i % 3), 0.012 + (i % 2) * 0.007, Math.sin(i * 2.4) * 0.02 * (i % 3));
      l.scale.setScalar(0.6 + (i % 3) * 0.3);
      this.heap.add(l);
    }
    this.heap.visible = false;
    this.pans[0].group.add(this.heap);
    this.weights = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const w = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.012 - i * 0.002, 0.014 - i * 0.002, 0.016, 10)), brass);
      w.position.set((i - 1) * 0.026, 0.012, 0);
      this.weights.add(w);
    }
    this.weights.visible = false;
    this.pans[1].group.add(this.weights);
    this.tilt = 0; this.tiltV = 0; this.tiltTarget = 0;
    this._placeScale();
    // the board across the roof: from the mine it says what this is - gold letters (the supply shack's
    // are cream: the two booths side by side never read as the same thing, phase 8 review)
    const signTex = boardTexture(THREE, "GOLDANKAUF", { fg: "#f3cf6a", accent: "#e0b24a" });
    this.texs.push(signTex);
    const signMat = mat(new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.82 }));
    add(box(2.7, 0.5, 0.06, darkWood), ASSAY.x, booth.signY, booth.signZ);
    add(new THREE.Mesh(geo(new THREE.PlaneGeometry(2.6, 0.44)), signMat), ASSAY.x, booth.signY, booth.signZ - 0.032, Math.PI);
    // ... and painted on the counter's front: at the counter (where the roof board is above your view)
    // it still says it, at eye level
    const frontTex = boardTexture(THREE, "GOLD · ANKAUF", { w: 1024, h: 200, fg: "#f3cf6a", accent: "#b88a3a", bg: "#33241a" });
    this.texs.push(frontTex);
    const frontMat = mat(new THREE.MeshStandardMaterial({ map: frontTex, roughness: 0.85 }));
    add(new THREE.Mesh(geo(new THREE.PlaneGeometry(1.7, 0.33)), frontMat), ASSAY.x, 0.6, booth.counterFront - 0.004, Math.PI);

    // ---------------- AUSRÜSTUNG (phase 8): the open-front supply shack (goldrush-buildings.js); the tools
    // for sale hang on a rack in its opening, working end up; the board along the front of the roof
    const shack = buildSupplyShack(THREE, { x: SHED.x, z: SHED.z, add: addS, M: BM, geo, colliders: world.colliders });
    const cz = shack.rackAt.z;
    add(box(1.0, 1.25, 0.04, wood), shack.rackAt.x, 1.68, cz + 0.06);              // the rack board, lighter: the tools stand out
    const pegG = geo(new THREE.CylinderGeometry(0.012, 0.012, 0.08, 6));
    for (const dx of [-0.22, 0.22]) {
      const peg = add(new THREE.Mesh(pegG, steel), shack.rackAt.x + dx, 1.25, cz);
      peg.rotation.x = Math.PI / 2;
    }
    const supTex = boardTexture(THREE, "AUSRÜSTUNG");
    this.texs.push(supTex);
    const supMat = mat(new THREE.MeshStandardMaterial({ map: supTex, roughness: 0.82 }));
    add(box(3.6, 0.6, 0.06, darkWood), SHED.x - 0.2, shack.signY, shack.signZ);
    add(new THREE.Mesh(geo(new THREE.PlaneGeometry(3.5, 0.54)), supMat), SHED.x - 0.2, shack.signY, shack.signZ - 0.032, Math.PI);
    this.rackAt = shack.rackAt;

    // ---------------- BERGAUFTRAG (phase 9): a notice board on two posts under a little roof, facing the
    // mountain; the painted sheet on it is a canvas repainted when the contract's numbers change
    const bx = BOARD.x, bz = BOARD.z;
    for (const dz of [-0.82, 0.82]) add(box(0.11, 2.3, 0.11, darkWood), bx, 1.15, bz + dz);
    add(box(0.05, 1.12, 1.62, darkWood), bx - 0.03, 1.5, bz);                                     // the backing boards
    const roofB = add(box(0.42, 0.035, 1.86, wood), bx + 0.05, 2.18, bz);
    roofB.rotation.z = -0.32;
    add(box(0.06, 0.06, 1.7, darkWood), bx + 0.02, 0.92, bz);                                     // the ledge under it
    this.boardCanvas = document.createElement("canvas");
    this.boardCanvas.width = 768; this.boardCanvas.height = 520;
    this.boardTex = new THREE.CanvasTexture(this.boardCanvas);
    this.boardTex.colorSpace = THREE.SRGBColorSpace;
    this.boardTex.anisotropy = 8;
    this.texs.push(this.boardTex);
    this.boardMat = mat(new THREE.MeshStandardMaterial({ map: this.boardTex, roughness: 0.92 }));
    this.boardSheet = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.015), this.boardMat);
    this.boardSheet.position.set(bx + 0.001, 1.5, bz);
    this.boardSheet.rotation.y = Math.PI / 2;                    // faces east (+x)
    this.boardSheet.receiveShadow = true;
    world.colliders.push({ type: "box", x: bx, z: bz, hw: 0.12, hd: 0.9, rot: 0 });
    this._boardSig = "";
    this.paintContract(null);

    // merge everything static: one mesh per material
    const statics = this.group.children.filter((o) => o.isMesh);
    for (const m of statics) this.group.remove(m);
    const merged = mergeByMaterial(THREE, statics);
    const inUse = new Set();                                // the scale keeps its own parts (it moves)
    scale.traverse((o) => { if (o.isMesh) inUse.add(o.geometry); });
    for (const g of this.geos) if (!inUse.has(g)) g.dispose();
    this.geos = [...inUse];
    for (const m of merged) { this.group.add(m); this.geos.push(m.geometry); }
    this.group.add(this.boardSheet);                         // (its canvas changes: not merged)
    this.geos.push(this.boardSheet.geometry);

    // the tools for sale on the rack: each merged per material, hidden once bought
    this.rackTools = {};
    if (models) {
      for (const [id, dx, y] of [["shovel", -0.22, 1.62], ["pickaxe", 0.22, 1.7]]) {
        const src = models[id].clone(true);
        src.rotation.set(Math.PI / 2, Math.PI, 0);           // working end up (over the counter), its face towards the camp
        src.position.set(this.rackAt.x + dx, y, cz - 0.04);
        src.updateMatrixWorld(true);
        const parts = [];
        src.traverse((o) => { if (o.isMesh && o.visible && !o.isInstancedMesh && !o.userData.noMerge && o.geometry !== models.soil.geometry) parts.push(o); });
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

  /**
   * The contract board's sheet (goldrush-contract.js view): repainted only when what it says
   * changed. Painted like a posted order - ink on paper, a ruled progress bar, no game colours.
   */
  paintContract(v) {
    const sig = v ? `${v.text.pct}|${v.text.removed}|${v.text.t}|${v.steps.map((s) => (s.met ? 1 : 0)).join("")}` : "-";
    if (sig === this._boardSig) return false;
    this._boardSig = sig;
    const c = this.boardCanvas, g = c.getContext("2d"), W = c.width, H = c.height;
    g.fillStyle = "#e9dcc0"; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 90; i++) { g.fillStyle = `rgba(90,60,30,${0.015 + (i % 7) * 0.006})`; g.fillRect((i * 151) % W, (i * 97) % H, 30 + (i % 5) * 22, 2 + (i % 3)); }   // foxing
    g.strokeStyle = "#5b4128"; g.lineWidth = 4; g.strokeRect(14, 14, W - 28, H - 28);
    g.fillStyle = "#2c1d10"; g.textAlign = "left"; g.textBaseline = "alphabetic";
    g.font = "700 54px Georgia, 'Times New Roman', serif"; g.fillText("BERGAUFTRAG", 40, 82);
    g.font = "italic 26px Georgia, serif"; g.fillText("Claim 01 – der ganze Berg muss weg.", 42, 122);
    g.fillRect(40, 140, W - 80, 2);
    if (!v) { g.font = "26px Georgia, serif"; g.fillText("Vermessung läuft …", 42, 190); this.boardTex.needsUpdate = true; return true; }
    g.font = "26px Georgia, serif";
    g.fillText(`Ursprünglich: ${v.text.v0} · ≈ ${v.text.t0}`, 42, 180);
    g.fillText(`Abgetragen: ${v.text.removed} · ${v.text.t}`, 42, 216);
    // the bar: ruled ink, filled with hatching up to the share removed (log-ish: the first per cent is visible)
    const x0 = 42, y0 = 240, bw = W - 84, bh = 34, f = Math.min(1, v.pct / 100);
    g.strokeStyle = "#2c1d10"; g.lineWidth = 2; g.strokeRect(x0, y0, bw, bh);
    for (let p = 10; p < 100; p += 10) { g.fillRect(x0 + (bw * p) / 100, y0 + bh - 8, 2, 8); }
    g.save(); g.beginPath(); g.rect(x0, y0, Math.max(3, bw * f), bh); g.clip();
    g.strokeStyle = "#5b4128"; g.lineWidth = 3;
    for (let x = -bh; x < bw * f + bh; x += 9) { g.beginPath(); g.moveTo(x0 + x, y0 + bh); g.lineTo(x0 + x + bh, y0); g.stroke(); }
    g.restore();
    g.font = "700 30px Georgia, serif"; g.fillStyle = "#2c1d10"; g.fillText(`${v.text.pct} abgetragen`, 42, 312);
    g.font = "24px Georgia, serif";
    let y = 356;
    g.fillText("Freigaben nach Fortschritt:", 42, y); y += 34;
    // (Prompt 10: six steps - two columns)
    const rows = Math.ceil(v.steps.length / 2);
    v.steps.forEach((s, i) => g.fillText(`${s.met ? "✓" : "–"}  ${s.label} ab ${s.pctText}`, i < rows ? 60 : 410, y + (i % rows) * 32));
    this.boardTex.needsUpdate = true;
    return true;
  }

  // the tools still for sale hang on the rack
  setOwned(owned) {
    for (const [id, m] of Object.entries(this.rackTools)) m.visible = !owned.has(id);
  }

  // a sale: the pouch goes on the scale; mass sets how far the beam dips - then the brass weights go
  // on the other pan and it comes back level (phase 8: the moment you see the result)
  weigh(ug) {
    this.heap.visible = ug > 0;
    this.weights.visible = false;
    this.heap.scale.setScalar(Math.min(1.6, 0.8 + Math.log10(1 + ug / 2000) * 0.4));
    this.tiltTarget = Math.min(0.22, 0.07 + Math.log10(1 + ug / 1000) * 0.05);
    this.tiltV = 1.8;
    this.weighT = 2.8;                                   // then it is taken off again
    this.balanceT = 0.9;                                 // the weights go on after a moment
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
      if (this.balanceT > 0 && (this.balanceT -= dt) <= 0) { this.weights.visible = true; this.tiltTarget = 0.012; this.tiltV -= 0.8; }
      if (this.weighT <= 0) { this.tiltTarget = 0; this.heap.visible = false; this.weights.visible = false; }
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
