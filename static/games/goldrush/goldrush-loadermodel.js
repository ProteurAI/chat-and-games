// GoldRush - the compact wheel loader's model (Prompt 10), behind a small rig
// interface so an authored model can replace it (goldrush-assets.js modelOr,
// models/manifest.json - see ASSETS.md):
//
//   root        world position on the ground at the articulation joint, the REAR
//               frame's heading (local +x = forward, +z = right), pitch / roll
//     rear      the rear frame: engine hood, counterweight, the operator's cab
//               (ROPS, glass, seat, steering wheel, dash), rear axle
//       wheelRL / wheelRR   (rotation.z = the wheel's turn)
//     front     the front frame: pivots at the joint (rotation.y = articulation,
//               + = to the left), the loader tower, front axle
//       wheelFL / wheelFR
//       boom    the lift arms: pivot on the tower (rotation.z = lift angle, + up)
//         bucket  pivot at the arms' tips (rotation.z relative to the arms)
//
// An authored .glb needs nodes named exactly like that ("rear", "front", "boom",
// "bucket", "wheelFL", "wheelFR", "wheelRL", "wheelRR"; optional "eye") with the
// same pivots; the game only sets rotations on them.
//
// Dimensions: a ~4.5 t compact loader. Wheels 0.96 m, wheelbase 2.0 m (1.0 m
// either side of the joint), track 1.46 m, arms 2.0 m from a pivot 1.62 m up,
// a 1.8 m wide bucket (~0.3 m3 heaped). Kinematics: LDR below.

import { mergeStatic } from "./goldrush-merge.js";
import { GridLoad } from "./goldrush-heap.js";

export const LDR = {
  wheelR: 0.48, wheelW: 0.34, track: 1.46, lf: 1.0, lr: 1.0,
  boomPivot: [0.4, 1.62],                // in the front frame (x forward from the joint, y up from the ground)
  boomL: 2.0,
  bucketW: 1.8,
  lip: [0.7, -0.24],                     // bucket frame (from the arms' pin): the cutting edge
  floorY: -0.22,                         // bucket frame: its floor below the pin (level when the bucket is level)
  mouth: [-0.04, 0.62],                  // bucket frame: the opening along x (back .. lip)
  eye: [-0.56, 2.2, 0],                  // rear frame: the operator's eyes (over the seat: the wheel and the dash low in view)
  armZ: 0.62,                            // the two arms either side
  steerMax: 0.66,                        // articulation, rad (~38 deg)
};

const fract = (v) => v - Math.floor(v);

// a tyre's imprint in loose ground (u along the travel): chevron lugs from the middle out, soft edges (alpha)
export function tyreMarkTex(THREE) {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 32;
  const g = c.getContext("2d");
  g.clearRect(0, 0, 64, 32);
  g.fillStyle = "rgba(255,255,255,0.3)"; g.fillRect(0, 3, 64, 26);
  g.strokeStyle = "rgba(255,255,255,0.9)"; g.lineWidth = 3.2; g.lineCap = "round";
  for (let u = -8; u < 72; u += 13) {
    g.beginPath(); g.moveTo(u, 15); g.lineTo(u - 7, 4); g.stroke();
    g.beginPath(); g.moveTo(u + 6, 17); g.lineTo(u - 1, 28); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// the parking pad (u across, v along the parked loader; canvas top = north): ground driven hard - the trodden
// paths' brown, a little gravel in it, a ragged rounded outline (no carpet), the two ruts it rolls in and out
// on (they run out to the south, towards the raw pile), a dark oil stain where the engine stands
export function parkPadTex(THREE) {
  const W = 176, H = 256, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d"), img = g.createImageData(W, H);
  let s = 41;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const wob = (a, b) => Math.sin(a * 0.071 + b) * 0.55 + Math.sin(a * 0.19 + b * 2.3) * 0.3 + Math.sin(a * 0.43 + b * 0.7) * 0.15;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    // a rounded box, its edge wandering by ~10 px (less at the south end: the ruts leave there)
    const qx = Math.abs(x - W / 2) / (W / 2), qy = Math.abs(y - H / 2) / (H / 2);
    const d = Math.pow(Math.pow(qx, 4) + Math.pow(qy, 4), 0.25);
    const edge = 0.86 + 0.07 * wob(y + x * 0.5, 1.7) + 0.04 * wob(x * 1.3, 4.1);
    const n = Math.sin(x * 0.37 + Math.sin(y * 0.11) * 2.1) * 0.5 + Math.sin(y * 0.29 + Math.sin(x * 0.13) * 2.7) * 0.5;
    const a = Math.max(0, Math.min(1, (edge - d) * 7 + n * 0.12));
    const v = 112 + n * 9 + (rnd() - 0.5) * 22;
    img.data[i] = v; img.data[i + 1] = v * 0.9; img.data[i + 2] = v * 0.77; img.data[i + 3] = Math.round(a * (165 + n * 25));
  }
  g.putImageData(img, 0, 0);
  // gravel trodden in: small lighter / darker stones
  for (let k = 0; k < 260; k++) {
    const x = 18 + rnd() * (W - 36), y = 16 + rnd() * (H - 32), r = 0.8 + rnd() * 1.4, l = rnd() > 0.5;
    g.fillStyle = l ? `rgba(196,182,160,${0.25 + rnd() * 0.25})` : `rgba(64,52,40,${0.18 + rnd() * 0.2})`;
    g.beginPath(); g.ellipse(x, y, r * 1.3, r, rnd() * 3, 0, Math.PI * 2); g.fill();
  }
  // the ruts (the track 1.46 m of the 4.4-m pad): from the parked spot out over the south edge, a lug pattern
  const top = 100;                              // the front wheels when it is parked
  for (const cx of [W / 2 - (1.46 / 4.4) * W / 2, W / 2 + (1.46 / 4.4) * W / 2]) {
    const grad = g.createLinearGradient(0, top, 0, top + 30);
    grad.addColorStop(0, "rgba(66,52,38,0)"); grad.addColorStop(1, "rgba(66,52,38,0.34)");
    g.fillStyle = grad; g.fillRect(cx - 6, top, 12, H - top);
    g.fillStyle = "rgba(56,44,32,0.32)";
    for (let y = top + 18; y < H; y += 7) { g.fillRect(cx - 5 + (rnd() - 0.5), y, 4, 2); g.fillRect(cx + 1 + (rnd() - 0.5), y + 3, 4, 2); }
  }
  // oil where the engine stands (the rear frame, the pad's south part), a smaller drip by the joint
  for (const [x, y, r, o] of [[W / 2 + 4, 206, 15, 0.42], [W / 2 - 3, 168, 7, 0.3]]) {
    const gr = g.createRadialGradient(x, y, 1, x, y, r);
    gr.addColorStop(0, `rgba(28,24,20,${o})`); gr.addColorStop(0.7, `rgba(34,28,22,${o * 0.6})`); gr.addColorStop(1, "rgba(40,32,24,0)");
    g.fillStyle = gr; g.beginPath(); g.ellipse(x, y, r * 1.2, r, 0.4, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// tyre tread: deep chevron lugs on dark rubber (u around the tyre)
function tyreTex(THREE) {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 32;
  const g = c.getContext("2d");
  g.fillStyle = "#1b1a18"; g.fillRect(0, 0, 128, 32);
  g.fillStyle = "#302e2a";
  for (let x = 0; x < 128; x += 16) {
    g.beginPath(); g.moveTo(x, 2); g.lineTo(x + 7, 16); g.lineTo(x, 30); g.lineTo(x + 6, 30); g.lineTo(x + 13, 16); g.lineTo(x + 6, 2); g.closePath(); g.fill();
  }
  for (let i = 0; i < 70; i++) { g.fillStyle = `rgba(120,96,70,${0.12 + (i % 4) * 0.07})`; g.fillRect((i * 41) % 128, (i * 23) % 32, 2, 1); }   // dried mud
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function decalTex(THREE) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "#dfa52a"; g.fillRect(0, 0, 256, 64);
  g.fillStyle = "#1e1c19"; g.font = "700 30px system-ui, sans-serif"; g.textBaseline = "middle";
  g.fillText("CLAIM 01 · L45", 14, 32);
  g.fillRect(0, 54, 256, 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class LoaderRig {
  constructor(THREE, { envMap = null, soilTex = null } = {}) {
    this.THREE = THREE;
    this.geos = []; this.mats = []; this.texs = [];
    const geo = (g) => { this.geos.push(g); return g; };
    const mat = (m) => { this.mats.push(m); return m; };
    this._geo = geo; this._mat = mat;
    this.soilTex = soilTex;
    this.paint = mat(new THREE.MeshStandardMaterial({ color: 0xdfa52a, roughness: 0.46, metalness: 0.2, envMap, envMapIntensity: 0.45 }));
    this.paintWorn = mat(new THREE.MeshStandardMaterial({ color: 0xb98d3a, roughness: 0.68, metalness: 0.15, side: THREE.DoubleSide }));
    this.dark = mat(new THREE.MeshStandardMaterial({ color: 0x2a2927, roughness: 0.6, metalness: 0.3, envMap, envMapIntensity: 0.3 }));
    this.steel = mat(new THREE.MeshStandardMaterial({ color: 0x5c5852, roughness: 0.5, metalness: 0.6, envMap, envMapIntensity: 0.5, side: THREE.DoubleSide }));
    this.chrome = mat(new THREE.MeshStandardMaterial({ color: 0xc8ccd0, roughness: 0.18, metalness: 0.95, envMap, envMapIntensity: 0.9 }));
    this.glass = mat(new THREE.MeshStandardMaterial({ color: 0x9fb4bb, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.26, depthWrite: false, envMap, envMapIntensity: 1 }));
    this.seat = mat(new THREE.MeshStandardMaterial({ color: 0x1f1f22, roughness: 0.85 }));
    this.tyreMap = tyreTex(THREE); this.texs.push(this.tyreMap);
    this.rubber = mat(new THREE.MeshStandardMaterial({ map: this.tyreMap, roughness: 0.93 }));
    this.rim = mat(new THREE.MeshStandardMaterial({ color: 0xd4a334, roughness: 0.5, metalness: 0.3 }));
    this.decalMap = decalTex(THREE); this.texs.push(this.decalMap);
    this.decal = mat(new THREE.MeshStandardMaterial({ map: this.decalMap, roughness: 0.5 }));
    this.light = mat(new THREE.MeshStandardMaterial({ color: 0xf3ead2, emissive: 0x6a5a3a, emissiveIntensity: 0.5, roughness: 0.3 }));
    this.beacon = mat(new THREE.MeshStandardMaterial({ color: 0xf0a020, emissive: 0x7a4a08, emissiveIntensity: 0.6, roughness: 0.3, transparent: true, opacity: 0.9 }));
    this.tail = mat(new THREE.MeshStandardMaterial({ color: 0x8a1c14, emissive: 0x3a0806, emissiveIntensity: 0.4, roughness: 0.4 }));
    this.box = geo(new THREE.BoxGeometry(1, 1, 1));
    this.cyl = geo(new THREE.CylinderGeometry(1, 1, 1, 14));
    this.cylZ = geo(new THREE.CylinderGeometry(1, 1, 1, 18)); this.cylZ.rotateX(Math.PI / 2);   // axis along z
    this._v = new THREE.Vector3(); this._s = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._m = new THREE.Matrix4();
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
    const THREE = this.THREE, L = LDR;
    const root = (this.root = new THREE.Group());
    root.name = "goldrush-loader";
    root.rotation.order = "YXZ";
    // ---------------------------------------------------------------- rear frame
    const rear = (this.rear = new THREE.Group());
    rear.name = "rear";
    root.add(rear);
    this._mesh(this.box, this.dark, 1.5, 0.46, 0.96, -0.92, 0.66, 0, rear);                       // the chassis
    this._mesh(this.box, this.dark, 0.3, 0.3, 0.62, -0.1, 0.66, 0, rear);                         // the joint's rear yoke
    this._mesh(this.cyl, this.steel, 0.07, 0.62, 0.07, -0.02, 0.66, 0, rear);                     // the king pin
    this._mesh(this.box, this.paint, 1.18, 0.62, 1.12, -1.2, 1.2, 0, rear);                       // the engine hood
    this._mesh(this.box, this.paint, 1.1, 0.08, 1.02, -1.2, 1.54, 0, rear);                       // its rounded top
    for (let k = 0; k < 6; k++) this._mesh(this.box, this.dark, 0.04, 0.018, 0.86, -1.62 + k * 0.1, 1.585, 0, rear);   // grille slots on top
    for (const s of [-1, 1]) for (let k = 0; k < 4; k++) this._mesh(this.box, this.dark, 0.5, 0.018, 0.01, -1.32, 1.04 + k * 0.08, s * 0.565, rear);   // side louvres
    for (const s of [-1, 1]) this._mesh(this.box, this.decal, 0.62, 0.15, 0.004, -0.98, 1.34, s * 0.562, rear, false);
    // the counterweight: a heavy cast back with the tail lights
    this._mesh(this.box, this.dark, 0.28, 0.92, 1.46, -1.9, 0.82, 0, rear);
    this._mesh(this.box, this.paint, 0.08, 0.6, 1.36, -2.04, 0.96, 0, rear);
    for (const s of [-1, 1]) this._mesh(this.box, this.tail, 0.03, 0.08, 0.16, -2.09, 1.12, s * 0.5, rear, false);
    this._mesh(this.box, this.dark, 0.12, 0.08, 0.5, -2.06, 0.46, 0, rear);                        // the tow hitch
    // exhaust and air intake on the hood
    this._mesh(this.cyl, this.dark, 0.045, 0.46, 0.045, -1.52, 1.82, 0.34, rear);
    this._mesh(this.cyl, this.dark, 0.06, 0.06, 0.06, -1.52, 2.06, 0.34, rear);
    this._mesh(this.cyl, this.dark, 0.07, 0.3, 0.07, -1.46, 1.72, -0.34, rear);
    // rear fenders
    for (const s of [-1, 1]) {
      this._mesh(this.box, this.paint, 1.04, 0.05, 0.42, -L.lr, 1.0, s * L.track / 2, rear);
      this._mesh(this.box, this.paint, 0.05, 0.3, 0.42, -L.lr + 0.5, 0.86, s * L.track / 2, rear);
    }
    // the cab (ROPS): four posts, the roof, glass, the floor box, steps, mirrors, a beacon and work lights
    const cab = (this.cab = new THREE.Group());
    cab.name = "cab";
    rear.add(cab);
    const cx0 = -0.86, cx1 = 0.12, cw = 0.6, y0 = 0.92, y1 = 2.44;
    for (const [px, pz] of [[cx1, -cw], [cx1, cw], [cx0, -cw], [cx0, cw]]) this._mesh(this.box, this.dark, 0.06, y1 - y0, 0.06, px, (y0 + y1) / 2, pz, cab);
    this._mesh(this.box, this.paint, cx1 - cx0 + 0.18, 0.09, cw * 2 + 0.16, (cx0 + cx1) / 2, y1 + 0.03, 0, cab);
    this._mesh(this.box, this.dark, cx1 - cx0 + 0.1, 0.03, cw * 2 + 0.08, (cx0 + cx1) / 2, y1 + 0.09, 0, cab);
    this._mesh(this.box, this.dark, cx1 - cx0, 0.2, cw * 2, (cx0 + cx1) / 2, y0 + 0.08, 0, cab);
    const gF = this._mesh(this.box, this.glass, 0.01, y1 - y0 - 0.18, cw * 2 - 0.08, cx1, (y0 + y1) / 2 + 0.06, 0, cab, false);
    const gB = this._mesh(this.box, this.glass, 0.01, y1 - y0 - 0.5, cw * 2 - 0.08, cx0, (y0 + y1) / 2 + 0.2, 0, cab, false);
    const gL = this._mesh(this.box, this.glass, cx1 - cx0 - 0.08, y1 - y0 - 0.25, 0.01, (cx0 + cx1) / 2, (y0 + y1) / 2 + 0.06, -cw, cab, false);
    const gR = this._mesh(this.box, this.glass, cx1 - cx0 - 0.08, y1 - y0 - 0.25, 0.01, (cx0 + cx1) / 2, (y0 + y1) / 2 + 0.06, cw, cab, false);
    this.glassParts = [gF, gB, gL, gR];
    this.frontGlass = gF;
    for (let k = 0; k < 3; k++) this._mesh(this.box, this.dark, 0.32, 0.04, 0.2, (cx0 + cx1) / 2 - 0.05, 0.3 + k * 0.24, -cw - 0.12, cab);       // steps (left)
    for (const s of [-1, 1]) {
      this._mesh(this.box, this.dark, 0.03, 0.03, 0.3, cx1 + 0.05, y1 - 0.25, s * (cw + 0.15), cab);
      this._mesh(this.box, this.dark, 0.02, 0.18, 0.12, cx1 + 0.08, y1 - 0.38, s * (cw + 0.32), cab);              // mirrors
      this._mesh(this.box, this.light, 0.05, 0.07, 0.12, cx1 + 0.06, y1 + 0.02, s * 0.42, cab, false);             // front work lights
      this._mesh(this.box, this.light, 0.05, 0.07, 0.12, cx0 - 0.06, y1 + 0.02, s * 0.42, cab, false);             // rear work lights
    }
    this.beaconMesh = this._mesh(this.cyl, this.beacon, 0.07, 0.11, 0.07, cx0 + 0.18, y1 + 0.16, -0.35, cab, false);
    // inside: seat, steering column and wheel, the dash, the joystick - from the seat the wheel and dash stay
    // in view (the seat and its back are hidden then)
    const inside = (this.cabInterior = new THREE.Group());
    cab.add(inside);
    this._mesh(this.box, this.seat, 0.42, 0.11, 0.48, -0.42, y0 + 0.5, 0, inside);
    this._mesh(this.box, this.seat, 0.09, 0.56, 0.48, -0.66, y0 + 0.8, 0, inside);
    const dash = (this.dash = new THREE.Group());
    cab.add(dash);
    this._mesh(this.box, this.dark, 0.2, 0.42, 0.62, -0.02, y0 + 0.42, 0, dash);
    const col = this._mesh(this.cyl, this.dark, 0.035, 0.42, 0.035, -0.1, y0 + 0.78, 0, dash);
    col.rotation.z = 0.55;
    const wheelG = this._geo(new THREE.TorusGeometry(0.17, 0.018, 8, 24));
    const sw = this._mesh(wheelG, this.seat, 1, 1, 1, -0.2, y0 + 0.92, 0, dash);
    sw.rotation.y = Math.PI / 2; sw.rotation.x = -0.6;
    this.steerWheel = sw;
    this._mesh(this.box, this.dark, 0.08, 0.16, 0.08, -0.3, y0 + 0.62, 0.3, dash);                // the joystick's console (right)
    this._mesh(this.cyl, this.seat, 0.02, 0.12, 0.02, -0.3, y0 + 0.76, 0.3, dash);
    // the rear wheels
    this.wheels = [];
    for (const s of [-1, 1]) this.wheels.push(this._wheel(rear, -L.lr, s, s < 0 ? "wheelRL" : "wheelRR"));
    // ---------------------------------------------------------------- front frame
    const front = (this.front = new THREE.Group());
    front.name = "front";
    root.add(front);
    this._mesh(this.box, this.dark, 1.3, 0.44, 0.9, 0.82, 0.64, 0, front);                         // the chassis
    this._mesh(this.box, this.dark, 0.34, 0.24, 0.52, 0.12, 0.66, 0, front);                        // the joint's front yoke
    this._mesh(this.box, this.paint, 0.36, 0.86, 0.76, 0.42, 1.24, 0, front);                       // the loader tower
    for (const s of [-1, 1]) this._mesh(this.box, this.paint, 0.26, 0.3, 0.06, L.boomPivot[0], L.boomPivot[1] - 0.05, s * (L.armZ - 0.08), front);   // the arms' brackets
    this._mesh(this.cylZ, this.steel, 0.06, 0.06, L.armZ * 2 + 0.12, L.boomPivot[0], L.boomPivot[1], 0, front);
    for (const s of [-1, 1]) {
      this._mesh(this.box, this.paint, 0.9, 0.05, 0.42, L.lf, 1.0, s * L.track / 2, front);       // front fenders
      this._mesh(this.box, this.paint, 0.05, 0.28, 0.42, L.lf - 0.45, 0.87, s * L.track / 2, front);
      this._mesh(this.box, this.light, 0.04, 0.09, 0.14, 0.62, 1.52, s * 0.3, front, false);      // headlights on the tower
    }
    for (const s of [-1, 1]) this.wheels.push(this._wheel(front, L.lf, s, s < 0 ? "wheelFL" : "wheelFR"));
    // ---------------------------------------------------------------- lift arms
    const boom = (this.boom = new THREE.Group());
    boom.name = "boom";
    boom.position.set(L.boomPivot[0], L.boomPivot[1], 0);
    front.add(boom);
    for (const s of [-1, 1]) {
      // a slightly bent box arm: the elbow sits a little up (clears the front tyres when lowered)
      this._seg(boom, [0, 0], [0.95, 0.12], 0.2, 0.18, s * L.armZ);
      this._seg(boom, [0.95, 0.12], [L.boomL, 0], 0.18, 0.15, s * L.armZ);
    }
    this._mesh(this.cylZ, this.paint, 0.08, 0.08, L.armZ * 2, 1.05, 0.1, 0, boom);                 // the cross tube
    this._mesh(this.cylZ, this.steel, 0.05, 0.05, L.armZ * 2 + 0.1, L.boomL, 0, 0, boom);           // the bucket pins
    // the bellcrank on the cross tube: the tilt cylinder pushes its top, a link runs from there to the bucket
    const crank = this._mesh(this.box, this.paint, 0.46, 0.1, 0.12, 1.075, 0.3, 0, boom);
    crank.rotation.z = Math.atan2(0.44, 0.05);
    // ---------------------------------------------------------------- bucket
    const bucket = (this.bucket = new THREE.Group());
    bucket.name = "bucket";
    bucket.position.set(L.boomL, 0, 0);
    boom.add(bucket);
    this._buildBucket(bucket);
    // ---------------------------------------------------------------- cylinders (laid out per pose)
    this.rams = [];
    for (const s of [-1, 1]) this.rams.push(this._ram(front, boom, [0.82, 0.74, s * (L.armZ - 0.02)], [0.95, -0.06, s * (L.armZ - 0.02)], 0.065, 0.034));   // lift
    this.rams.push(this._ram(front, boom, [0.62, 1.58, 0], [1.1, 0.52, 0], 0.07, 0.036));                    // tilt (to the bellcrank's top)
    this.links = [this._link(boom, bucket, [1.1, 0.52, 0], [-0.1, 0.4, 0])];                                    // bellcrank -> bucket
    this.eyeLocal = new THREE.Vector3(L.eye[0], L.eye[1], L.eye[2]);
    this.pose = { steer: 0, boom: -0.75, tilt: 0.15, spin: [0, 0, 0, 0] };
    this._merge();
    this.setPose(this.pose);
  }

  _wheel(parent, x, side, name) {
    const THREE = this.THREE, L = LDR, g = new THREE.Group();
    g.name = name;
    g.position.set(x, L.wheelR, side * L.track / 2);
    parent.add(g);
    const tyreG = this._geo(new THREE.CylinderGeometry(L.wheelR, L.wheelR, L.wheelW, 28, 1));
    tyreG.rotateX(Math.PI / 2);
    // the tread wraps the tyre: u along the circumference (x4)
    const uv = tyreG.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 4);
    const tyre = this._mesh(tyreG, this.rubber, 1, 1, 1, 0, 0, 0, g);
    // shoulders (a slightly smaller, darker side wall each side) and the rim with its hub
    for (const s of [-1, 1]) this._mesh(this.cylZ, this.dark, L.wheelR * 0.93, L.wheelR * 0.93, 0.02, 0, 0, s * (L.wheelW / 2 + 0.005), g);
    this._mesh(this.cylZ, this.rim, L.wheelR * 0.56, L.wheelR * 0.56, 0.03, 0, 0, side * (L.wheelW / 2 + 0.02), g);
    this._mesh(this.cylZ, this.dark, 0.1, 0.1, 0.06, 0, 0, side * (L.wheelW / 2 + 0.04), g);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      this._mesh(this.cylZ, this.steel, 0.018, 0.018, 0.03, Math.cos(a) * 0.17, Math.sin(a) * 0.17, side * (L.wheelW / 2 + 0.04), g);
    }
    // the axle stub inside
    this._mesh(this.cylZ, this.dark, 0.08, 0.08, 0.32, 0, 0, -side * 0.28, g);
    g.userData.tyre = tyre;
    return g;
  }

  _buildBucket(g) {
    const THREE = this.THREE, L = LDR, W = L.bucketW;
    // the profile (bucket frame, x forward from the pin, y up): back plate, curved heel, floor to the lip
    const R = 0.3, cx = 0.18, cy = L.floorY + R;                              // the heel's curve centre
    // (a cylinder's angle th lies at (R sin th, -R cos th) once turned onto the z axis: 1.5 pi is the back,
    // 2 pi the bottom - the heel between them, a little overlap either side)
    const shellG = this._geo(new THREE.CylinderGeometry(R, R, W, 16, 1, true, Math.PI * 1.45, Math.PI * 0.6));
    shellG.rotateX(Math.PI / 2);
    this._mesh(shellG, this.steel, 1, 1, 1, cx, cy, 0, g);
    // the back plate (from the heel up to the spill guard) and the floor (heel to the lip)
    this._mesh(this.box, this.steel, 0.025, 0.42, W, cx - R + 0.012, cy + 0.2, 0, g);
    this._mesh(this.box, this.steel, L.lip[0] - cx + 0.02, 0.025, W, (cx + L.lip[0]) / 2, L.floorY + 0.012, 0, g);
    this._mesh(this.box, this.paint, 0.06, 0.12, W + 0.04, cx - R - 0.01, cy + 0.42, 0, g);        // the spill guard
    // the side plates: a trapezoid each
    const side = new THREE.Shape();
    side.moveTo(cx - R, L.floorY + 0.05); side.lineTo(L.lip[0] + 0.02, L.lip[1]); side.lineTo(L.lip[0] - 0.12, L.floorY + 0.38); side.lineTo(cx - R - 0.02, cy + 0.48); side.closePath();
    const sideG = this._geo(new THREE.ShapeGeometry(side));
    for (const s of [-1, 1]) this._mesh(sideG, this.paintWorn, 1, 1, 1, 0, 0, s * W / 2, g);
    // the cutting edge (a thick wear plate) and the mounting ears on the back
    this._mesh(this.box, this.dark, 0.16, 0.035, W + 0.02, L.lip[0] - 0.06, L.lip[1] + 0.02, 0, g);
    for (const s of [-1, 1]) {
      this._mesh(this.box, this.paint, 0.2, 0.2, 0.05, -0.04, 0.02, s * L.armZ, g);
      this._mesh(this.box, this.paint, 0.18, 0.16, 0.05, -0.1, 0.38, s * 0.08, g);                // the link's ears (top)
    }
    // the load: a grid over the mouth, shaped by the fill (and a few lumps)
    this.fill = new GridLoad(THREE, g, { nx: 17, nz: 25, x0: L.mouth[0], x1: L.mouth[1], z0: -W / 2 + 0.03, z1: W / 2 - 0.03, lumps: 40, map: this.soilTex, uv: 3, shadow: true, seed: 47, lumpK: 4 });
    this._fillSig = null;
  }

  // fewer draw calls: every frame's static parts baked per material (rear, cab interior / dash, front, arms,
  // bucket, each wheel) - the cylinders and links (they move) and the load stay apart
  _merge() {
    const THREE = this.THREE, moving = new Set([...this.rams.map((r) => r.g), ...this.links.map((l) => l.g)]);
    const collect = (root, stop, skip = new Set()) => {
      const out = [];
      const walk = (o) => {
        for (const c of o.children) {
          if (stop.has(c) || moving.has(c)) continue;
          if (c.isMesh && !c.isInstancedMesh && !skip.has(c) && !c.userData.noMerge) out.push(c);
          walk(c);
        }
      };
      walk(root);
      return out;
    };
    const keep = (list) => { this.geos.push(...list.map((m) => m.geometry)); return list; };
    const glass = new Set(this.glassParts), wheels = new Set(this.wheels);
    for (const w of this.wheels) keep(mergeStatic(THREE, w, collect(w, new Set())));
    // (Prompt 10: a rigid axle - the right wheel baked into the left one's frame, it spins with it on the same line)
    for (const [a, b] of [[0, 1], [2, 3]]) {
      const wa = this.wheels[a], wb = this.wheels[b];
      if (!wa || !wb) continue;
      wb.rotation.z = wa.rotation.z;
      keep(mergeStatic(THREE, wa, [...wa.children.filter((c) => c.isMesh && c.visible), ...wb.children.filter((c) => c.isMesh && c.visible)]));
      this.axleTwin = this.axleTwin || new Map();
      this.axleTwin.set(wb, wa);
    }
    keep(mergeStatic(THREE, this.cabInterior, collect(this.cabInterior, new Set())));
    keep(mergeStatic(THREE, this.dash, collect(this.dash, new Set([]), new Set([this.steerWheel]))));
    keep(mergeStatic(THREE, this.rear, collect(this.rear, new Set([...wheels, this.cabInterior, this.dash]), glass)));
    this.glassParts = keep(mergeStatic(THREE, this.cab, this.glassParts, { shadow: false }));
    keep(mergeStatic(THREE, this.front, collect(this.front, new Set([...wheels, this.boom]))));
    keep(mergeStatic(THREE, this.boom, collect(this.boom, new Set([this.bucket]))));
    keep(mergeStatic(THREE, this.bucket, collect(this.bucket, new Set())));
    // no shadow from what sits inside the cab (never seen through its shell) or from the thin rams / link -
    // a shadow-pass draw each for nothing you would notice
    for (const o of [this.cabInterior, this.dash, ...this.rams.map((r) => r.g), ...this.links.map((l) => l.g)]) o.traverse((m) => { if (m.isMesh) m.castShadow = false; });
  }

  // an arm segment from a to b (x, y in the boom frame) at z
  _seg(parent, a, b, w, w2, z) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    const o = this._mesh(this.box, this.paint, L + 0.06, (w + w2) / 2, 0.12, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z, parent);
    o.rotation.z = Math.atan2(dy, dx);
    return o;
  }

  _ram(A, B, pa, pb, rb, rr) {
    const THREE = this.THREE, g = new THREE.Group();
    A.add(g);
    const barrel = this._mesh(this.cyl, this.paint, rb, 1, rb, 0, 0, 0, g);
    const rod = this._mesh(this.cyl, this.chrome, rr, 1, rr, 0, 0, 0, g);
    return { g, A, B, a: new THREE.Vector3(pa[0], pa[1], pa[2]), b: new THREE.Vector3(pb[0], pb[1], pb[2]), barrel, rod, rb, rr };
  }

  // a rigid link (a flat bar) from A to B
  _link(A, B, pa, pb) {
    const THREE = this.THREE, g = new THREE.Group();
    A.add(g);
    const bar = this._mesh(this.box, this.paint, 0.07, 1, 0.1, 0, 0, 0, g);
    return { g, A, B, a: new THREE.Vector3(pa[0], pa[1], pa[2]), b: new THREE.Vector3(pb[0], pb[1], pb[2]), bar };
  }

  // from the operator's seat: the seat hidden, the front glass out of the way (the wheel and the dash stay)
  setFirstPerson(on) {
    this.cabInterior.visible = !on;
    for (const g of this.glassParts || []) g.visible = !on;
  }

  /**
   * pose = { steer (articulation, + left), boom (arm angle, + up), tilt (bucket relative to the arms),
   * spin [FL, FR, RL, RR] wheel turns (rad), steerWheel (the steering wheel's turn, optional) }
   */
  setPose(p) {
    this.pose = p;
    this.front.rotation.y = p.steer;
    this.boom.rotation.z = p.boom;
    this.bucket.rotation.z = p.tilt;
    if (p.spin) for (let i = 0; i < 4; i++) this.wheels[i < 2 ? i + 2 : i - 2].rotation.z = -p.spin[i];
    if (this.axleTwin) for (const [b, a] of this.axleTwin) b.rotation.z = a.rotation.z;          // (the baked twin: one axle)
    if (this.steerWheel) this.steerWheel.rotation.z = (p.steerWheel || 0);
    this.root.updateMatrixWorld(true);
    for (const r of this.rams) this._layRam(r);
    for (const l of this.links) this._layLink(l);
  }

  _layRam(r) {
    const a = r.a, b = this._v.copy(r.b);
    r.B.localToWorld(b);
    r.A.worldToLocal(b);
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, L = Math.hypot(dx, dy, dz) || 0.001;
    r.g.position.copy(a);
    r.g.quaternion.setFromUnitVectors(this._up || (this._up = new this.THREE.Vector3(0, 1, 0)), this._s.set(dx / L, dy / L, dz / L));
    const bl = Math.min(L * 0.6, 0.9);
    r.barrel.scale.set(r.rb, bl, r.rb); r.barrel.position.y = bl / 2;
    r.rod.scale.set(r.rr, L - bl + 0.05, r.rr); r.rod.position.y = bl + (L - bl) / 2 - 0.02;
  }

  _layLink(l) {
    const a = l.a, b = this._v.copy(l.b);
    l.B.localToWorld(b);
    l.A.worldToLocal(b);
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, L = Math.hypot(dx, dy, dz) || 0.001;
    l.g.position.copy(a);
    l.g.quaternion.setFromUnitVectors(this._up || (this._up = new this.THREE.Vector3(0, 1, 0)), this._s.set(dx / L, dy / L, dz / L));
    l.bar.scale.set(0.07, L, 0.1); l.bar.position.y = L / 2;
  }

  // ---- kinematics (front frame, y up from the ground under the joint)

  /** the arms' pin for an arm angle -> [x, y] */
  static pinAt(boom) { return [LDR.boomPivot[0] + LDR.boomL * Math.cos(boom), LDR.boomPivot[1] + LDR.boomL * Math.sin(boom)]; }
  /** the arm angle that puts the pin at height y */
  static boomForPinY(y) { return Math.asin(Math.max(-1, Math.min(1, (y - LDR.boomPivot[1]) / LDR.boomL))); }
  /** the bucket's rotation relative to the arms for an absolute angle phi (front frame) */
  static tiltFor(phi, boom) { return phi - boom; }
  /** the cutting edge in the front frame for (boom, absolute bucket angle phi) -> [x, y] */
  static lipAt(boom, phi) {
    const [px, py] = LoaderRig.pinAt(boom), c = Math.cos(phi), s = Math.sin(phi);
    return [px + LDR.lip[0] * c - LDR.lip[1] * s, py + LDR.lip[0] * s + LDR.lip[1] * c];
  }

  // world positions (matrices current)
  eyeWorld(out) { return this.rear.localToWorld(out.copy(this.eyeLocal)); }
  lipWorld(out) { return this.bucket.localToWorld(out.set(LDR.lip[0], LDR.lip[1], 0)); }
  mouthWorld(out) { return this.bucket.localToWorld(out.set((LDR.mouth[0] + LDR.mouth[1]) / 2, LDR.floorY + 0.15, 0)); }

  // the tyres' tread scrolls a little (the wheels turn as groups already - this is the mud's sparkle off)
  /**
   * The load in the bucket: frac 0..1 of its capacity (heaped above 0.8), comp (masses per material) for the
   * colour / lumps, an own colour (tailings) optional. The surface: level with a heap in the middle, held by the
   * walls, never above the back's spill guard.
   */
  setLoad(frac, comp, rgb = null) {
    const f = Math.max(0, Math.min(1.15, frac)), L = LDR;
    const sig = `${Math.round(f * 60)}:${comp ? comp.map((c) => Math.round(c / 2000)).join(",") : ""}:${rgb ? rgb.join(",") : ""}`;
    if (sig === this._fillSig) return;
    this._fillSig = sig;
    if (f < 0.015) { this.fill.setVisible(false); return; }
    this.fill.setVisible(true);
    const mx0 = L.mouth[0], mx1 = L.mouth[1], W2 = L.bucketW / 2;
    const level = L.floorY + 0.04 + 0.4 * Math.min(1, f), heap = Math.max(0, f - 0.55) * 0.36;
    this.fill.set(sig, (x, z, o) => {
      const u = (x - mx0) / (mx1 - mx0), v = z / W2;
      // deeper at the back (the heel) than towards the lip; a heap in the middle when full
      const back = 1 - u, mound = heap * Math.max(0, 1 - v * v) * Math.max(0, 1 - Math.pow(u - 0.45, 2) * 3.2);
      const y = Math.min(L.floorY + 0.62, Math.max(L.floorY + 0.01, level - 0.12 * u * (1 - f * 0.6) + mound + 0.012 * Math.sin(x * 23 + z * 9)));
      o.y = y; o.t = y - L.floorY; o.a = Math.abs(v) < 0.995 && u > 0.01 && u < (f > 0.3 ? 1.02 : 0.9 + 0.3 * f) ? 1 : 0;
      o.l = o.a && o.t > 0.06 ? 1 : 0;
      void back;
    }, comp || [1, 0, 0, 0], { amount: Math.min(1, 0.4 + f), rgb, tMax: 0.35 });
  }

  dispose() {
    this.fill.dispose();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.texs) t.dispose();
  }
}

// an authored model (models/loader.glb) wrapped into the same interface - null when it lacks a node
export function loaderRigFromScene(THREE, scene, base) {
  const need = ["rear", "front", "boom", "bucket", "wheelFL", "wheelFR", "wheelRL", "wheelRR"], nodes = {};
  scene.traverse((o) => { if (need.includes(o.name) || o.name === "eye" || o.name === "cab") nodes[o.name] = o; });
  if (need.some((n) => !nodes[n])) return null;
  const rig = Object.create(LoaderRig.prototype);
  Object.assign(rig, base, { root: scene, rear: nodes.rear, front: nodes.front, boom: nodes.boom, bucket: nodes.bucket,
    wheels: [nodes.wheelRL, nodes.wheelRR, nodes.wheelFL, nodes.wheelFR], rams: [], links: [], glassParts: [], cabInterior: new THREE.Group(), steerWheel: null });
  if (nodes.eye) rig.eyeLocal = nodes.eye.position.clone();
  rig.bucket.add(base.fill.surface, base.fill.lumps);
  return rig;
}

export { fract };
