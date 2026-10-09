// GoldRush - the automatic hillside miner's model (Prompt 10): a small tracked
// mining unit - crawler tracks, a deck with its power pack, a slewing boom and
// a telescoping stick with a rotary cutter drum (carbide picks), an internal
// belt from the head back over the deck, a slewing / luffing discharge belt at
// the rear. Built in code from boxes / cylinders with baked vertex colours
// (yellow paint, dark steel, rubber) - and the whole machine is ONE skinned mesh:
// every moving part rides its own bone (rigidly), so it is a single draw however
// many pieces and joints it has.
//
// The rig (the bones goldrush-autominer.js moves; an authored .glb can replace
// the procedural model later with nodes named like these):
//   root      the machine at its spot (heading, pitch / roll from the ground)
//   boom      rotation.y = slew (the head's side), rotation.z = boom angle
//   stick     at the boom's end: rotation.z = its angle, position.x = extension
//   drum      at the stick's end: rotation.x = spin
//   out       the discharge belt at the rear: rotation.y = slew, rotation.z = luff
//   load      the material on the internal belt (scale.y = how full)
// Front is +X like the other machines.

export const AM = {
  len: 2.5, wid: 1.62, trackW: 0.36, trackH: 0.44,
  deckY: 0.62,
  boomPivot: [0.78, 0.98, 0],          // root frame: the slewing boom's foot
  boomL: 1.55, stickL: [0.7, 1.55],    // the stick telescopes between these
  drumR: 0.27, drumW: 0.52,
  beltIn: [0.55, 0.72],                // root frame (x, y): where the head drops its bite onto the internal belt
  outPivot: [-1.12, 1.18, 0],          // root frame: the discharge belt's slewing / luffing pivot
  outL: 3.2,
  panel: [0.15, -0.95],                // root frame (x, z): the control panel on the left
};

const Y = [0.86, 0.62, 0.12], Y2 = [0.72, 0.5, 0.1], STEEL = [0.24, 0.25, 0.26], DARK = [0.09, 0.09, 0.1], RUB = [0.13, 0.13, 0.12], GREY = [0.5, 0.51, 0.5], RED = [0.7, 0.16, 0.1], AMB = [0.95, 0.55, 0.1];

// a little geometry kit: parts in one frame, merged into one indexed geometry with colours
class Kit {
  constructor(THREE) { this.THREE = THREE; this.parts = []; this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); }
  _add(g, c, x, y, z, rx = 0, ry = 0, rz = 0) {
    const THREE = this.THREE;
    this._e.set(rx, ry, rz);
    g.applyMatrix4(this._m.compose(new THREE.Vector3(x, y, z), this._q.setFromEuler(this._e), new THREE.Vector3(1, 1, 1)));
    const n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2]; }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    if (g.index) g = g.toNonIndexed();
    if (g.attributes.uv) g.deleteAttribute("uv");
    this.parts.push(g);
    return this;
  }
  box(w, h, d, c, x, y, z, rx, ry, rz) { return this._add(new this.THREE.BoxGeometry(w, h, d), c, x, y, z, rx, ry, rz); }
  cyl(r0, r1, h, c, x, y, z, rx, ry, rz, seg = 12) { return this._add(new this.THREE.CylinderGeometry(r0, r1, h, seg), c, x, y, z, rx, ry, rz); }
  cone(r, h, c, x, y, z, rx, ry, rz) { return this._add(new this.THREE.ConeGeometry(r, h, 5), c, x, y, z, rx, ry, rz); }
  build() {
    const THREE = this.THREE;
    let n = 0;
    for (const g of this.parts) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
    let o = 0;
    for (const g of this.parts) {
      pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); col.set(g.attributes.color.array, o * 3);
      o += g.attributes.position.count;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    out.setAttribute("color", new THREE.BufferAttribute(col, 3));
    out.computeBoundingSphere();
    this.parts = [];
    return out;
  }
}

// the geometries (shared by the machine and its placement ghost)
function geometries(THREE) {
  const L = AM.len, W = AM.wid, tw = AM.trackW, th = AM.trackH;
  // ---- the base: tracks, deck, power pack, tank, panel, the internal belt, outriggers
  const b = new Kit(THREE);
  for (const s of [-1, 1]) {
    const z = s * (W / 2 - tw / 2);
    b.box(L - 0.36, th - 0.14, tw, RUB, 0, th / 2, z);
    b.cyl(th / 2, th / 2, tw, RUB, L / 2 - 0.2, th / 2, z, Math.PI / 2).cyl(th / 2, th / 2, tw, RUB, -L / 2 + 0.2, th / 2, z, Math.PI / 2);
    for (let k = 0; k < 13; k++) b.box(0.05, 0.03, tw + 0.01, DARK, -L / 2 + 0.3 + k * ((L - 0.6) / 12), th + 0.0, z);   // grousers on top
    for (let k = 0; k < 4; k++) b.cyl(0.075, 0.075, tw * 0.6, STEEL, -0.7 + k * 0.47, 0.11, z, Math.PI / 2, 0, 0, 8);    // rollers
    b.box(L - 0.5, 0.12, 0.08, Y2, 0, th * 0.55, z - s * (tw / 2 + 0.03));                                                // the track frame's side
  }
  b.box(L - 0.25, 0.16, W - 0.12, Y, 0, AM.deckY, 0);                                    // the deck
  b.box(L - 0.3, 0.05, W - 0.06, STEEL, 0, AM.deckY - 0.1, 0);
  // power pack at the rear, its grille, exhaust, beacon
  b.box(0.95, 0.62, 1.12, Y, -0.66, AM.deckY + 0.39, 0.12);
  b.box(0.02, 0.4, 0.8, DARK, -1.14, AM.deckY + 0.36, 0.12);
  for (let k = 0; k < 6; k++) b.box(0.025, 0.03, 0.78, STEEL, -1.155, AM.deckY + 0.2 + k * 0.065, 0.12);
  b.cyl(0.045, 0.05, 0.42, DARK, -0.4, AM.deckY + 0.86, 0.5);
  b.cyl(0.06, 0.06, 0.07, AMB, -0.85, AM.deckY + 0.74, -0.25, 0, 0, 0, 10);
  b.box(0.98, 0.05, 1.15, Y2, -0.66, AM.deckY + 0.71, 0.12);
  // hydraulic tank (grey drum lying across), hoses
  b.cyl(0.17, 0.17, 0.62, GREY, -0.02, AM.deckY + 0.28, 0.45, Math.PI / 2);
  b.cyl(0.025, 0.025, 0.7, DARK, 0.3, AM.deckY + 0.2, 0.3, 0, 0, Math.PI / 2 - 0.3, 6);
  // the slewing ring under the boom
  b.cyl(0.36, 0.4, 0.2, STEEL, AM.boomPivot[0], AM.deckY + 0.16, 0, 0, 0, 0, 16);
  // the internal belt: from the front (by the head) back over the deck to the rear pivot
  {
    const x0 = AM.beltIn[0] + 0.15, y0 = AM.beltIn[1] - 0.02, x1 = AM.outPivot[0] + 0.15, y1 = AM.outPivot[1] - 0.06;
    const len = Math.hypot(x1 - x0, y1 - y0), a = Math.atan2(y1 - y0, x1 - x0), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    b.box(len, 0.04, 0.36, DARK, cx, cy, -0.42, 0, 0, a);
    for (const s of [-1, 1]) b.box(len, 0.12, 0.04, Y2, cx, cy + 0.04, -0.42 + s * 0.2, 0, 0, a);
    b.box(0.32, 0.3, 0.5, Y, x0 + 0.05, y0 + 0.12, -0.42);                                 // the receiving chute at the front
    for (const t of [0.25, 0.6]) b.box(0.05, cy - AM.deckY + 0.1, 0.05, Y2, x0 + (x1 - x0) * t, (AM.deckY + y0 + (y1 - y0) * t) / 2, -0.62);
  }
  // control panel on a post (left side), its lamps
  b.box(0.06, 0.62, 0.06, Y2, AM.panel[0], AM.deckY + 0.31, AM.panel[1] + 0.12);
  b.box(0.26, 0.34, 0.1, DARK, AM.panel[0], AM.deckY + 0.72, AM.panel[1] + 0.1);
  b.box(0.2, 0.22, 0.02, GREY, AM.panel[0], AM.deckY + 0.74, AM.panel[1] + 0.045);
  // outriggers at the front corners (feet on the ground)
  for (const s of [-1, 1]) {
    b.box(0.1, 0.5, 0.1, Y2, L / 2 - 0.25, AM.deckY - 0.18, s * (W / 2 + 0.02));
    b.box(0.3, 0.05, 0.26, STEEL, L / 2 - 0.25, 0.03, s * (W / 2 + 0.02));
  }
  const base = b.build();

  // ---- the boom (in its pivot frame, along +x): its foot bracket, the beam, a ram along its underside
  const m = new Kit(THREE);
  m.box(0.42, 0.32, 0.5, Y, 0.05, 0.08, 0);
  m.box(AM.boomL, 0.26, 0.3, Y, AM.boomL / 2, 0.08, 0);
  m.box(AM.boomL * 0.9, 0.05, 0.32, Y2, AM.boomL / 2, 0.22, 0);
  m.cyl(0.07, 0.07, AM.boomL * 0.72, GREY, AM.boomL * 0.42, -0.1, 0, 0, 0, Math.PI / 2, 10);
  m.cyl(0.05, 0.05, AM.boomL * 0.5, STEEL, AM.boomL * 0.7, -0.1, 0, 0, 0, Math.PI / 2, 8);
  m.cyl(0.09, 0.09, 0.36, STEEL, AM.boomL, 0.08, 0, Math.PI / 2, 0, 0, 10);              // the pin at its end
  const boom = m.build();

  // ---- the stick (from the boom's end along +x; telescoping: drawn at its short length, the inner tube runs on)
  const s = new Kit(THREE);
  s.box(AM.stickL[0], 0.22, 0.24, Y, AM.stickL[0] / 2, 0, 0);
  s.box(AM.stickL[1] - 0.15, 0.15, 0.17, STEEL, AM.stickL[0] + (AM.stickL[1] - AM.stickL[0]) / 2 - 0.4, 0, 0);
  s.box(0.2, 0.34, 0.66, Y2, AM.stickL[0] + 0.02, 0, 0);                                // the drum's yoke
  s.cyl(0.05, 0.05, 0.4, GREY, AM.stickL[0] * 0.5, 0.15, 0, 0, 0, Math.PI / 2, 8);
  const stick = s.build();

  // ---- the cutter drum (around its own axis = z): carbide picks spiralling round it
  const d = new Kit(THREE);
  d.cyl(AM.drumR * 0.82, AM.drumR * 0.82, AM.drumW, STEEL, 0, 0, 0, Math.PI / 2, 0, 0, 14);
  for (const sgn of [-1, 1]) d.cyl(AM.drumR * 0.9, AM.drumR * 0.9, 0.04, DARK, 0, 0, sgn * AM.drumW / 2, Math.PI / 2, 0, 0, 14);
  for (let k = 0; k < 18; k++) {
    const a = k * 2.399, z = -AM.drumW / 2 + 0.05 + (k % 6) * ((AM.drumW - 0.1) / 5), r = AM.drumR * 0.86;
    d.cone(0.035, 0.12, k % 3 ? GREY : DARK, Math.cos(a) * r, Math.sin(a) * r, z, 0, 0, a - Math.PI / 2);
  }
  const drum = d.build();

  // ---- the discharge belt (from its pivot along +x, which the machine points backwards)
  const o = new Kit(THREE);
  o.box(AM.outL, 0.04, 0.34, DARK, AM.outL / 2, 0, 0);
  for (const sgn of [-1, 1]) o.box(AM.outL, 0.14, 0.04, Y, AM.outL / 2, 0.03, sgn * 0.19);
  o.cyl(0.08, 0.08, 0.42, STEEL, AM.outL, 0, 0, Math.PI / 2, 0, 0, 10);
  o.cyl(0.08, 0.08, 0.42, STEEL, 0.05, 0, 0, Math.PI / 2, 0, 0, 10);
  o.box(0.06, 0.6, 0.06, Y2, AM.outL * 0.45, -0.32, 0.18, 0, 0, 0.35);
  o.box(0.06, 0.6, 0.06, Y2, AM.outL * 0.45, -0.32, -0.18, 0, 0, 0.35);
  o.box(0.3, 0.22, 0.42, Y, -0.05, 0.02, 0);                                             // the slewing head
  const out = o.build();

  // ---- the load on the internal belt (a strip, scaled by how full it is)
  const loadG = new THREE.BoxGeometry(1, 1, 1);
  loadG.translate(0, 0.5, 0);
  return { base, boom, stick, drum, out, load: loadG };
}

// the bones' bind pose (all angles 0): what the parts are authored in
function bones(THREE) {
  const rb = new THREE.Bone(), boom = new THREE.Bone(), stick = new THREE.Bone(), drum = new THREE.Bone(), out = new THREE.Bone(), load = new THREE.Bone();
  rb.name = "root"; boom.name = "boom"; stick.name = "stick"; drum.name = "drum"; out.name = "out"; load.name = "load";
  boom.position.set(AM.boomPivot[0], AM.deckY + 0.3, 0);
  boom.rotation.order = "YZX";
  stick.position.set(AM.boomL, 0.08, 0);
  drum.position.set(AM.stickL[0], 0, 0);
  out.position.set(AM.outPivot[0], AM.outPivot[1], AM.outPivot[2]);
  out.rotation.order = "YZX";
  rb.add(boom, out, load);
  boom.add(stick);
  stick.add(drum);
  return { list: [rb, boom, stick, drum, out, load], rb, boom, stick, drum, out, load };
}

// every part in its bone's frame -> one geometry in the mesh's frame, each vertex bound to its bone alone
function skinnedGeometry(THREE) {
  const G = geometries(THREE), B = bones(THREE);
  B.rb.updateMatrixWorld(true);
  const load = G.load.toNonIndexed();
  G.load.dispose();
  load.deleteAttribute("uv");
  { const n = load.attributes.position.count, c = new Float32Array(n * 3); for (let k = 0; k < n; k++) c.set([0.48, 0.35, 0.24], k * 3); load.setAttribute("color", new THREE.BufferAttribute(c, 3)); }
  const parts = [[G.base, 0], [G.boom, 1], [G.stick, 2], [G.drum, 3], [G.out, 4], [load, 5]];
  let n = 0;
  for (const [g] of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  let o = 0, loadStart = 0;
  for (const [g, b] of parts) {
    g.applyMatrix4(B.list[b].matrixWorld);
    const c = g.attributes.position.count;
    if (b === 5) loadStart = o;
    pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); col.set(g.attributes.color.array, o * 3);
    for (let k = 0; k < c; k++) { si[(o + k) * 4] = b; sw[(o + k) * 4] = 1; }
    o += c;
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("skinIndex", new THREE.BufferAttribute(si, 4));
  geo.setAttribute("skinWeight", new THREE.BufferAttribute(sw, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.2, 0), 5.8);          // the arm's and the belt's reach
  return { geo, loadStart, loadCount: n - loadStart };
}

export class AutoMinerRig {
  /** opts: { ghost: true } - the placement preview (one translucent colour, no shadows); geos: share the machine's geometry */
  constructor(THREE, { ghost = false, geos = null } = {}) {
    this.THREE = THREE;
    this.ownsGeos = !geos;
    this.geos = geos || skinnedGeometry(THREE);
    this.mat = ghost
      ? new THREE.MeshBasicMaterial({ color: 0x5ee07a, transparent: true, opacity: 0.38, depthWrite: false })
      : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.22 });
    const B = bones(THREE);
    this.mesh = new THREE.SkinnedMesh(this.geos.geo, this.mat);
    this.mesh.name = ghost ? "goldrush-autominer-ghost-mesh" : "goldrush-autominer-mesh";
    this.mesh.add(B.rb);
    this.mesh.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton(B.list));
    this.mesh.castShadow = !ghost;
    this.mesh.receiveShadow = !ghost;
    this.root = new THREE.Group();
    this.root.name = ghost ? "goldrush-autominer-ghost" : "goldrush-autominer";
    this.root.add(this.mesh);
    this.boom = B.boom; this.stick = B.stick; this.drum = B.drum; this.out = B.out; this.load = B.load;
    this.ghost = ghost;
    this._rgb = [0.48, 0.35, 0.24];
    this.setLoad(0, null);
    this.setStick(AM.stickL[0]);
    this.setPose({ slew: 0, boom: -0.35, stick: -0.6, ext: AM.stickL[0], spin: 0, outSlew: 0, outLuff: 0.45 });
  }

  // the stick's working length: its outer part stays, the drum rides at the end of the inner tube
  setStick(len) { this.drum.position.set(len, 0, 0); this._len = len; }

  setPose(p) {
    this.boom.rotation.set(0, p.slew || 0, p.boom || 0);
    this.stick.rotation.set(0, 0, p.stick || 0);
    if (p.ext != null && p.ext !== this._len) this.setStick(p.ext);
    this.drum.rotation.set(0, 0, p.spin || 0);
    // the discharge belt points backwards (+x of its frame = the machine's -x)
    this.out.rotation.set(0, Math.PI + (p.outSlew || 0), p.outLuff || 0);
  }

  // the internal belt's load (0..1) and its colour - the load bone shapes it (scaled to nothing when empty)
  setLoad(f, rgb) {
    const on = f > 0.004 && !this.ghost;
    if (!on) { this.load.scale.set(1e-4, 1e-4, 1e-4); return; }
    const x0 = AM.beltIn[0] + 0.1, x1 = AM.outPivot[0] + 0.2, y0 = AM.beltIn[1] + 0.02, y1 = AM.outPivot[1] - 0.02;
    const len = Math.hypot(x1 - x0, y1 - y0) * Math.min(1, 0.3 + f), a = Math.atan2(y1 - y0, x1 - x0);
    this.load.scale.set(len, 0.04 + 0.1 * Math.min(1, f), 0.26);
    this.load.position.set(x1 - Math.cos(a) * len / 2, y1 - Math.sin(a) * len / 2, -0.42);
    this.load.rotation.set(0, 0, a);
    if (rgb && Math.abs(rgb[0] - this._rgb[0]) + Math.abs(rgb[1] - this._rgb[1]) + Math.abs(rgb[2] - this._rgb[2]) > 0.02) {
      this._rgb = [...rgb];
      const c = this.geos.geo.attributes.color, a3 = c.array, lin = new this.THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], this.THREE.SRGBColorSpace);
      for (let k = this.geos.loadStart; k < this.geos.loadStart + this.geos.loadCount; k++) { a3[k * 3] = lin.r; a3[k * 3 + 1] = lin.g; a3[k * 3 + 2] = lin.b; }
      c.needsUpdate = true;
    }
  }

  // world points
  drumWorld(out) { this.drum.updateWorldMatrix(true, false); return out.setFromMatrixPosition(this.drum.matrixWorld); }
  outTipWorld(out) { this.out.updateWorldMatrix(true, false); return out.set(AM.outL, 0, 0).applyMatrix4(this.out.matrixWorld); }

  setGhostOk(ok) { if (this.ghost) this.mat.color.setHex(ok ? 0x5ee07a : 0xe0503c); }

  dispose() {
    if (this.ownsGeos) this.geos.geo.dispose();
    this.mesh.skeleton.dispose();
    this.mat.dispose();
  }
}
