// GoldRush - phase-6 models from simple shapes (no external asset): a
// wheelbarrow and a sluice box with its feed hopper, water and tailings.
// Early claim technology - wood, galvanised steel, a rubber-mat riffle bed -
// nothing futuristic. Water, sediment and moving gravel are cheap stand-ins
// (scrolling textures, instanced pebbles), driven by the real batches.
//
// Local frames
//   wheelbarrow  wheel contact at the origin, forward = -z (it rolls that
//                way), handles run back to +z (grips at z = BARROW.grip)
//   sluice       head (hopper) at x = 0, the box runs down to x = SLUICE.len,
//                y = 0 is the ground

import { mulberry32, noise2 } from "./goldrush-noise.js";

export const BARROW = { wheelR: 0.19, grip: 1.3, gripY: 0.46, gripX: 0.27, trayZ0: 0.2, trayZ1: 1.02, trayW: 0.66, trayD: 0.3, floorY: 0.33, legZ: 0.92 };
export const SLUICE = { len: 2.7, width: 0.38, side: 0.15, headY: 0.92, tailY: 0.62, hopper: { w: 0.78, d: 0.72, h: 0.32 } };

function canvasTex(THREE, w, h, draw, repeat = true) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// loose material seen from above (grey-brown base, grains, pebbles) - tinted per batch
function heapTex(THREE, seed) {
  return canvasTex(THREE, 128, 128, (g, w, h) => {
    const rng = mulberry32(seed);
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const n = noise2(x * 0.08, y * 0.08, seed) * 0.5 + noise2(x * 0.35, y * 0.35, seed + 3) * 0.35;
      const v = 165 + n * 70, i = (y * w + x) * 4;
      img.data[i] = v; img.data[i + 1] = v * 0.94; img.data[i + 2] = v * 0.86; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    for (let i = 0; i < 340; i++) {
      const a = 0.15 + rng() * 0.35, x = rng() * w, y = rng() * h, r = 0.7 + rng() * 2.6;
      g.fillStyle = rng() < 0.5 ? `rgba(38,27,18,${a})` : `rgba(226,214,196,${a * 0.85})`;
      g.beginPath(); g.ellipse(x, y, r, r * (0.6 + rng() * 0.4), rng() * 3, 0, Math.PI * 2); g.fill();
    }
  });
}

// the riffle bed: a ribbed rubber mat (dark, rows of ridges across the flow)
function matTex(THREE) {
  return canvasTex(THREE, 64, 128, (g, w, h) => {
    g.fillStyle = "#2c2a28"; g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 8) {
      g.fillStyle = "#3d3a36"; g.fillRect(0, y, w, 3);
      g.fillStyle = "#1c1b1a"; g.fillRect(0, y + 3, w, 1);
    }
    for (let i = 0; i < 90; i++) { g.fillStyle = `rgba(90,84,76,${0.15 + (i % 5) * 0.05})`; g.fillRect((i * 37) % w, (i * 53) % h, 1, 1); }
  });
}

// running water: soft streaks along the flow (scrolled in u)
function flowTex(THREE, seed) {
  return canvasTex(THREE, 128, 64, (g, w, h) => {
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const n = noise2(x * 0.04, y * 0.25, seed) * 0.6 + noise2(x * 0.11, y * 0.6, seed + 5) * 0.4;
      const v = 140 + n * 115, i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  });
}

export class MechModels {
  constructor(THREE, { envMap, woodTex } = {}) {
    this.THREE = THREE;
    this.geos = []; this.mats = []; this.texs = [];
    const geo = (g) => { this.geos.push(g); return g; };
    const mat = (m) => { this.mats.push(m); return m; };
    const tex = (t) => { this.texs.push(t); return t; };
    this._geo = geo; this._mat = mat;
    this.galv = mat(new THREE.MeshStandardMaterial({ color: 0x8d9295, roughness: 0.52, metalness: 0.55, envMap: envMap || null, envMapIntensity: 0.5, side: THREE.DoubleSide }));
    this.galvDark = mat(new THREE.MeshStandardMaterial({ color: 0x5e6366, roughness: 0.55, metalness: 0.5, envMap: envMap || null }));
    this.rubber = mat(new THREE.MeshStandardMaterial({ color: 0x1f1e1d, roughness: 0.9 }));
    this.wood = mat(new THREE.MeshStandardMaterial({ map: woodTex || null, color: 0xa57c55, roughness: 0.9 }));
    this.darkWood = mat(new THREE.MeshStandardMaterial({ map: woodTex || null, color: 0x6a4c34, roughness: 0.92 }));
    this.wetWood = mat(new THREE.MeshStandardMaterial({ map: woodTex || null, color: 0x5d4632, roughness: 0.6 }));
    this.gripWood = mat(new THREE.MeshStandardMaterial({ color: 0x8c6238, roughness: 0.7 }));
    this.heapMap = tex(heapTex(THREE, 77));
    this.load = mat(new THREE.MeshStandardMaterial({ map: this.heapMap, color: 0x8a6a4c, roughness: 0.95 }));
    this.matMap = tex(matTex(THREE));
    this.matMap.repeat.set(1, 6);
    this.mat = mat(new THREE.MeshStandardMaterial({ map: this.matMap, roughness: 0.85 }));
    this.heavy = mat(new THREE.MeshStandardMaterial({ color: 0x15130f, roughness: 0.7, transparent: true, opacity: 0, depthWrite: false }));
    this.flowMap = tex(flowTex(THREE, 9));
    this.flowMap.repeat.set(3, 1);
    this.water = mat(new THREE.MeshStandardMaterial({ color: 0x8fa3a6, roughness: 0.12, transparent: true, opacity: 0.55, bumpMap: this.flowMap, bumpScale: 0.5, map: this.flowMap, depthWrite: false, envMap: envMap || null, envMapIntensity: 0.7 }));
    this.stream = mat(new THREE.MeshStandardMaterial({ color: 0xc9d6d8, roughness: 0.1, transparent: true, opacity: 0.5, depthWrite: false, map: this.flowMap }));
    this.tailMat = mat(new THREE.MeshStandardMaterial({ map: this.heapMap, color: 0x8e7b66, roughness: 0.96 }));
    this.pebbleMat = mat(new THREE.MeshStandardMaterial({ color: 0x8e877d, roughness: 0.85, flatShading: true }));
    this.box = geo(new THREE.BoxGeometry(1, 1, 1));
    this.cyl = geo(new THREE.CylinderGeometry(1, 1, 1, 12));
    this.plane = geo(new THREE.PlaneGeometry(1, 1));
    this.plane.rotateX(-Math.PI / 2);
    this.pebble = geo(new THREE.IcosahedronGeometry(1, 0));
  }

  _mesh(g, m, sx, sy, sz, x, y, z, parent, shadow = true) {
    const o = new this.THREE.Mesh(g, m);
    o.scale.set(sx, sy, sz);
    o.position.set(x, y, z);
    o.castShadow = shadow;
    o.receiveShadow = true;
    if (parent) parent.add(o);
    return o;
  }

  // ---- WHEELBARROW: wheel in front, a tapered steel tray, wooden handles and two legs
  wheelbarrow() {
    const THREE = this.THREE, B = BARROW, g = new THREE.Group();
    g.name = "goldrush-wheelbarrow";
    g.rotation.order = "YXZ";
    // the wheel (tyre, hub, spokes) on its axle
    const wheel = new THREE.Group();
    wheel.position.set(0, B.wheelR, 0);
    const tyre = new THREE.Mesh(this._geo(new THREE.TorusGeometry(B.wheelR - 0.035, 0.035, 8, 22)), this.rubber);
    tyre.rotation.y = Math.PI / 2; tyre.castShadow = true;
    wheel.add(tyre);
    const hub = this._mesh(this.cyl, this.galvDark, 0.035, 0.09, 0.035, 0, 0, 0, wheel);
    hub.rotation.z = Math.PI / 2;
    for (let i = 0; i < 6; i++) {
      const sp = this._mesh(this.box, this.galvDark, 0.012, (B.wheelR - 0.04) * 2, 0.012, 0, 0, 0, wheel, false);
      sp.rotation.x = (i / 6) * Math.PI;
    }
    g.add(wheel);
    g.userData.wheel = wheel;
    // the tray: a box tapering towards the bottom, the front wall sloped
    const tg = this._geo(new THREE.BoxGeometry(1, 1, 1, 1, 1, 1));
    const p = tg.attributes.position;
    for (let v = 0; v < p.count; v++) {
      const top = p.getY(v) > 0, front = p.getZ(v) < 0;
      p.setX(v, p.getX(v) * (top ? 1 : 0.66));
      p.setZ(v, p.getZ(v) * (top ? 1 : 0.7) + (front && top ? -0.08 : 0));
    }
    tg.computeVertexNormals();
    const trayLen = B.trayZ1 - B.trayZ0, zc = (B.trayZ0 + B.trayZ1) / 2;
    const tray = this._mesh(tg, this.galv, B.trayW, B.trayD, trayLen, 0, B.floorY + B.trayD / 2, zc, g);
    tray.material = this.galv;
    g.userData.tray = tray;
    // rim
    for (const s of [-1, 1]) this._mesh(this.cyl, this.galvDark, 0.012, trayLen + 0.08, 0.012, s * B.trayW / 2, B.floorY + B.trayD, zc - 0.03, g).rotation.x = Math.PI / 2;
    // handles + frame: from the axle back to the grips
    for (const s of [-1, 1]) {
      const a = new THREE.Vector3(s * 0.12, B.wheelR, 0), b = new THREE.Vector3(s * B.gripX, B.gripY, B.grip);
      const len = a.distanceTo(b), mid = a.clone().add(b).multiplyScalar(0.5);
      const h = this._mesh(this.cyl, this.darkWood, 0.022, len, 0.022, mid.x, mid.y, mid.z, g);
      h.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      const grip = this._mesh(this.cyl, this.gripWood, 0.026, 0.16, 0.026, b.x, b.y, b.z - 0.07, g);
      grip.quaternion.copy(h.quaternion);
      // leg under the back of the tray
      this._mesh(this.box, this.galvDark, 0.025, B.floorY + 0.02, 0.025, s * 0.23, (B.floorY + 0.02) / 2, B.legZ, g);
    }
    // the load: a mound surface in the tray (height, tint and shape follow the batch)
    const fill = this._mesh(this._geo(new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2)), this.load.clone(), 1, 1, 1, 0, 0, zc, g, false);
    this.mats.push(fill.material);
    fill.visible = false;
    g.userData.fill = fill;
    g.userData.trayCenterZ = zc;
    return g;
  }

  // load in the tray: 0..1 of its capacity, tinted by what it is. The level
  // rises with the load; the heap's base fits the (tapered, front-sloped)
  // tray at that height, so it never pokes through a wall; full, it is heaped
  // a hand's breadth over the rim
  setBarrowFill(g, frac, rgb) {
    const B = BARROW, f = g.userData.fill;
    f.visible = frac > 0.004;
    if (!f.visible) return;
    const len = B.trayZ1 - B.trayZ0, zc = (B.trayZ0 + B.trayZ1) / 2;
    const t = 0.12 + 0.78 * Math.min(1, frac);                    // the level, as a share of the tray's depth
    const hw = (B.trayW / 2) * (0.66 + 0.34 * t), hl = len * (0.35 + 0.19 * t);
    f.position.set(0, B.floorY + B.trayD * t, zc - len * 0.04 * t);
    f.scale.set(hw * 0.96, B.trayD * (0.08 + 0.36 * Math.min(1, frac)), hl * 0.96);
    if (rgb) f.material.color.setRGB(rgb[0], rgb[1], rgb[2]);
  }

  // ---- SLUICE: legs, the sloped box with its riffle bed, the hopper at the head,
  // water from the tank, an outlet onto the tailings heap
  sluice() {
    const THREE = this.THREE, S = SLUICE, g = new THREE.Group();
    g.name = "goldrush-sluice";
    const parts = [];
    const slope = Math.atan2(S.headY - S.tailY, S.len);
    // legs (pairs at head, middle, tail)
    for (const [x, frac] of [[0.2, 0], [S.len / 2, 0.5], [S.len - 0.15, 1]]) {
      const top = S.headY - (S.headY - S.tailY) * (x / S.len) - 0.04;
      for (const s of [-1, 1]) parts.push(this._mesh(this.box, this.darkWood, 0.07, top, 0.07, x, top / 2, s * (S.width / 2 + 0.05), g));
      parts.push(this._mesh(this.box, this.darkWood, 0.05, 0.05, S.width + 0.16, x, top * 0.45, 0, g));
    }
    // the box: tilted down towards the outlet
    const box = new THREE.Group();
    box.position.set(0, S.headY, 0);
    box.rotation.z = -slope;
    g.add(box);
    parts.push(this._mesh(this.box, this.wetWood, S.len, 0.03, S.width + 0.06, S.len / 2, -0.015, 0, box));
    for (const s of [-1, 1]) parts.push(this._mesh(this.box, this.wood, S.len, S.side, 0.03, S.len / 2, S.side / 2, s * (S.width / 2 + 0.015), box));
    // riffle bed: the mat and the cross bars
    const bed = this._mesh(this.plane, this.mat, S.len - 0.12, 1, S.width, S.len / 2 + 0.04, 0.002, 0, box, false);
    parts.push(bed);
    const riffles = new THREE.InstancedMesh(this.box, this.galvDark, 11);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 11; i++) {
      m.compose(new THREE.Vector3(0.25 + i * ((S.len - 0.35) / 10), 0.018, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -0.5)), new THREE.Vector3(0.012, 0.035, S.width));
      riffles.setMatrixAt(i, m);
    }
    riffles.castShadow = true;
    box.add(riffles);
    parts.push(riffles);
    // the heavy (dark) sand collecting behind the riffles: shows how loaded the mat is
    const heavy = this._mesh(this.plane, this.heavy, S.len - 0.3, 1, S.width - 0.02, S.len / 2 + 0.06, 0.006, 0, box, false);
    // water running down the box
    const water = this._mesh(this.plane, this.water.clone(), S.len, 1, S.width - 0.01, S.len / 2, 0.028, 0, box, false);
    this.mats.push(water.material);
    water.material.map = this.flowMap; water.material.bumpMap = this.flowMap;
    water.visible = false;
    // gravel moving with the water
    const gravel = new THREE.InstancedMesh(this.pebble, this.pebbleMat, 12);
    gravel.count = 0;
    gravel.frustumCulled = false;
    box.add(gravel);
    // the hopper (feed box) at the head, its load inside
    const H = S.hopper, hop = new THREE.Group();
    hop.position.set(-H.w / 2 + 0.12, S.headY + 0.02, 0);
    g.add(hop);
    parts.push(this._mesh(this.box, this.wood, H.w, 0.03, H.d, 0, 0, 0, hop));
    for (const [sx, sz, w, d] of [[0, H.d / 2, H.w, 0.03], [0, -H.d / 2, H.w, 0.03], [-H.w / 2, 0, 0.03, H.d], [H.w / 2, 0, 0.03, H.d * 0.5]]) {
      parts.push(this._mesh(this.box, this.wood, w, H.h, d, sx, H.h / 2, sz, hop));
    }
    for (const sx of [-H.w / 2 + 0.05, H.w / 2 - 0.05]) for (const sz of [-H.d / 2 + 0.05, H.d / 2 - 0.05]) {
      parts.push(this._mesh(this.box, this.darkWood, 0.06, S.headY + 0.02, 0.06, hop.position.x + sx, (S.headY + 0.02) / 2, sz, g));
    }
    const hopFill = this._mesh(this.plane, this.load.clone(), H.w - 0.06, 1, H.d - 0.06, 0, 0.02, 0, hop, false);
    this.mats.push(hopFill.material);
    hopFill.visible = false;
    // the pipe from the tank and the water falling into the head
    const pipe = this._mesh(this.cyl, this.galvDark, 0.03, 1, 0.03, 0, 0, 0, g);
    const fall = this._mesh(this.cyl, this.stream, 0.022, 0.32, 0.022, 0.06, S.headY + 0.2, -0.05, g, false);
    fall.visible = false;
    // the outlet: a thin sheet of muddy water from the end of the box down onto the heap
    const x0 = S.len + 0.03, y0 = S.tailY - 0.03, x1 = S.len + 0.3, y1 = 0.04, sheet = Math.hypot(x1 - x0, y0 - y1);
    const out = this._mesh(this.box, this.stream.clone(), 0.02, sheet, S.width * 0.8, (x0 + x1) / 2, (y0 + y1) / 2, 0, g, false);
    out.rotation.z = Math.asin((x1 - x0) / sheet);
    this.mats.push(out.material);
    out.visible = false;
    // the tailings heap below the outlet (the sheet lands on its near slope)
    const heap = this._mesh(this._geo(new THREE.ConeGeometry(1, 1, 18, 1, true)), this.tailMat, 0.01, 0.01, 0.01, S.len + 0.5, 0, 0, g);
    heap.visible = false;
    g.userData = { box, bed, heavy, water, gravel, hop, hopFill, pipe, fall, out, heap, slope, parts };
    return g;
  }

  // the delivery: a stack of boards and a rolled mat where the sluice will stand
  sluiceKit() {
    const THREE = this.THREE, g = new THREE.Group();
    g.name = "goldrush-sluice-kit";
    for (let k = 0; k < 5; k++) this._mesh(this.box, k % 2 ? this.darkWood : this.wood, 2.4, 0.05, 0.22, 1.3, 0.025 + k * 0.05, (k % 2) * 0.1 - 0.05, g).rotation.y = 0.04 * k;
    const roll = this._mesh(this.cyl, this.rubber, 0.09, 0.42, 0.09, 1.3, 0.34, 0.25, g);
    roll.rotation.x = Math.PI / 2;
    return g;
  }

  dispose() {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.texs) t.dispose();
  }
}
