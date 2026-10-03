// GoldRush - phase-7 models from simple shapes (no external asset), built
// with the phase-6 kit's materials (goldrush-mechmodels.js MechModels): the
// bulk hopper on its timber frame with the loading ramp and platform, its
// chute / the motorised feeder's vibrating tray, the control post, the
// delivered kits. Claim technology a step up from the sluice: galvanised
// sheet, angle steel, rough timber - nothing industrial.
//
// Local frame of the hopper group: x / z as in the world, the hopper's axis
// at the origin, y = 0 the ground. The chute runs +z (south) to the sluice
// hopper; the platform and the ramp lie east (+x).

export const BULK = {
  top: 1.4, bottom: 0.36,                  // inner square sides (m) at the rim / the outlet
  outletY: 1.5, depth: 0.5,                // outlet height, rim = outletY + depth
  extH: 0.24,                              // the extension boards on top (upgrade)
  chuteL: 1.2, chuteW: 0.3, chuteDrop: 0.08,
  deckY: 1.7,                              // the platform's deck
};

// volume (m3) of the frustum filled to height h above the outlet (h <= depth),
// and the extension above it (a straight box of the top's size)
export function bulkVolumeAt(h) {
  const B = BULK, d = Math.min(h, B.depth), s1 = B.bottom + (B.top - B.bottom) * (d / B.depth);
  let v = (d / 3) * (B.bottom * B.bottom + s1 * s1 + B.bottom * s1);
  if (h > B.depth) v += (h - B.depth) * B.top * B.top;
  return v;
}

// the fill height (m above the outlet) for a volume (m3)
export function bulkLevelFor(m3) {
  let lo = 0, hi = BULK.depth + BULK.extH;
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (bulkVolumeAt(mid) < m3) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

export class AutoModels {
  constructor(M) {
    this.M = M;
    this.THREE = M.THREE;
    const THREE = this.THREE;
    this.frustum = M._geo(new THREE.CylinderGeometry(BULK.top / Math.SQRT2 + 0.02, BULK.bottom / Math.SQRT2 + 0.02, BULK.depth, 4, 1, true));
    this.frustum.rotateY(Math.PI / 4);
    this.grid = M._geo(new THREE.PlaneGeometry(1, 1, 10, 10));
    this.grid.rotateX(-Math.PI / 2);
    this.grid.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(this.grid.attributes.position.count * 3).fill(1), 3));
    this.sphere = M._geo(new THREE.SphereGeometry(1, 10, 8));
    this.fillMat = M._mat(new THREE.MeshStandardMaterial({ map: M.heapMap, vertexColors: true, roughness: 0.95 }));
    this.trayLoadMat = M._mat(new THREE.MeshStandardMaterial({ map: M.heapMap, color: 0x7a6047, roughness: 0.95 }));
    this.paint = M._mat(new THREE.MeshStandardMaterial({ color: 0xe0b33a, roughness: 0.7 }));
    this.red = M._mat(new THREE.MeshStandardMaterial({ color: 0xb2332b, roughness: 0.6 }));
    this.gaugeMat = M._mat(new THREE.MeshStandardMaterial({ map: M._tex(gaugeTex(THREE)), roughness: 0.8 }));
    this.lampOff = M._mat(new THREE.MeshStandardMaterial({ color: 0x3a3a34, roughness: 0.4 }));
    this.lampOn = M._mat(new THREE.MeshStandardMaterial({ color: 0x9be38a, emissive: 0x4bd34a, emissiveIntensity: 0.9, roughness: 0.4 }));
    this.lampWait = M._mat(new THREE.MeshStandardMaterial({ color: 0xf2c46a, emissive: 0xe0a020, emissiveIntensity: 0.8, roughness: 0.4 }));
  }

  // ---- the bulk hopper: frame, sheet-steel funnel, rim, outlet with its slide gate, the chute, the level gauge
  bulkHopper() {
    const THREE = this.THREE, M = this.M, B = BULK, g = new THREE.Group();
    g.name = "goldrush-bulkhopper";
    const parts = [], rimY = B.outletY + B.depth, half = B.top / 2;
    // four timber legs and the cross bracing (the frame stands around the funnel)
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(M._mesh(M.box, M.darkWood, 0.11, rimY + 0.04, 0.11, sx * (half + 0.03), (rimY + 0.04) / 2, sz * (half + 0.03), g));
    for (const [y, t] of [[0.55, 0.07], [B.outletY - 0.04, 0.09], [rimY - 0.03, 0.08]]) {
      for (const s of [-1, 1]) {
        parts.push(M._mesh(M.box, M.darkWood, B.top + 0.17, t, 0.07, 0, y, s * (half + 0.03), g));
        parts.push(M._mesh(M.box, M.darkWood, 0.07, t, B.top + 0.17, s * (half + 0.03), y, 0, g));
      }
    }
    // X braces on the east and west faces (the south one carries the gauge, the platform stands on the north)
    for (const sx of [-1, 1]) for (const k of [-1, 1]) {
      const len = Math.hypot(B.top, B.outletY - 0.6), b = M._mesh(M.box, M.darkWood, 0.05, 0.05, len, sx * (half + 0.06), 1.05, 0, g);
      b.rotation.x = k * Math.atan2(B.outletY - 0.6, B.top);
      parts.push(b);
    }
    // the funnel (galvanised sheet, open top) and its angle-steel rim
    const funnel = M._mesh(this.frustum, M.galv, 1, 1, 1, 0, B.outletY + B.depth / 2, 0, g);
    parts.push(funnel);
    for (const s of [-1, 1]) {
      parts.push(M._mesh(M.box, M.galvDark, B.top + 0.06, 0.05, 0.04, 0, rimY, s * (half + 0.02), g));
      parts.push(M._mesh(M.box, M.galvDark, 0.04, 0.05, B.top + 0.06, s * (half + 0.02), rimY, 0, g));
    }
    // the extension boards (upgrade): a timber collar on the rim
    const ext = new THREE.Group();
    for (const s of [-1, 1]) {
      ext.add(M._mesh(M.box, M.wood, B.top + 0.1, B.extH, 0.04, 0, rimY + B.extH / 2, s * (half + 0.04)));
      ext.add(M._mesh(M.box, M.wood, 0.04, B.extH, B.top + 0.1, s * (half + 0.04), rimY + B.extH / 2, 0));
    }
    ext.visible = false;
    g.add(ext);
    // the outlet spout and the slide gate (a plate that moves out when open)
    parts.push(M._mesh(M.box, M.galvDark, B.bottom + 0.06, 0.1, B.bottom + 0.06, 0, B.outletY - 0.05, 0, g));
    const gate = M._mesh(M.box, M.galv, B.bottom + 0.1, 0.012, B.bottom + 0.08, 0, B.outletY - 0.105, 0, g);
    const handle = M._mesh(M.box, this.red, 0.04, 0.04, 0.16, 0, B.outletY - 0.105, -(B.bottom / 2 + 0.12), g);
    parts.push(gate, handle);
    // the chute down to the sluice hopper (south): an open steel channel on two hangers
    const chute = new THREE.Group();
    chute.position.set(0, B.outletY - 0.13, 0);
    chute.rotation.x = -Math.atan2(B.chuteDrop, B.chuteL);
    g.add(chute);
    parts.push(M._mesh(M.box, M.galv, B.chuteW, 0.012, B.chuteL, 0, 0, B.chuteL / 2 - 0.1, chute));
    for (const s of [-1, 1]) parts.push(M._mesh(M.box, M.galv, 0.012, 0.09, B.chuteL, s * B.chuteW / 2, 0.045, B.chuteL / 2 - 0.1, chute));
    const chuteLoad = M._mesh(M.plane, this.trayLoadMat, B.chuteW - 0.03, 1, B.chuteL - 0.2, 0, 0.012, B.chuteL / 2 - 0.15, chute, false);
    chuteLoad.visible = false;
    const pebbles = new THREE.InstancedMesh(M.pebble, M.pebbleMat, 16);
    pebbles.count = 0;
    pebbles.frustumCulled = false;
    chute.add(pebbles);
    // the falling stream at the chute's end (into the sluice hopper)
    const fall = M._mesh(M.box, this.trayLoadMat, B.chuteW * 0.55, 0.22, 0.05, 0, B.outletY - 0.13 - B.chuteDrop - 0.12, B.chuteL - 0.06, g, false);
    fall.visible = false;
    // the level gauge on the south face: a painted board, a float pointer
    const board = M._mesh(M.plane, this.gaugeMat, 0.16, 1, 0.5, 0.42, B.outletY + 0.25, half + 0.075, g, false);
    board.rotation.set(Math.PI / 2, 0, 0);
    const pointer = M._mesh(M.box, this.red, 0.2, 0.025, 0.03, 0.42, B.outletY + 0.02, half + 0.09, g);
    // the fill: a mottled surface at the level (its colours from the content)
    const fill = M._mesh(this.grid, this.fillMat, B.top, 1, B.top, 0, B.outletY + 0.02, 0, g, false);
    fill.visible = false;
    g.userData = { parts, ext, gate, handle, chute, chuteLoad, pebbles, fall, board, pointer, fill, rimY };
    return g;
  }

  // ---- the loading ramp and its platform (the decks: goldrush-world.js addDeck)
  // o = { x, z: the foot's centre, dir: +1 the ramp rises towards +z (-1: towards -z),
  //       len, w, h: the platform's height, plat: the platform's length beyond the ramp's top }
  ramp(o) {
    const THREE = this.THREE, M = this.M, g = new THREE.Group();
    g.name = "goldrush-ramp";
    g.position.set(o.x, 0, o.z);
    g.rotation.y = o.dir > 0 ? -Math.PI / 2 : Math.PI / 2;            // local +x: up the ramp
    const parts = [], w = o.w, L = Math.hypot(o.len, o.h), ang = Math.atan2(o.h, o.len);
    // the ramp's deck: planks on two stringers, low kick boards along its sides
    const deck = new THREE.Group();
    deck.position.set(o.len / 2, o.h / 2 - 0.04, 0);                   // the planks' top on the deck's height line
    deck.rotation.z = ang;
    g.add(deck);
    for (let k = 0; k < Math.round(L / 0.22); k++) parts.push(M._mesh(M.box, k % 3 === 1 ? M.darkWood : M.wood, 0.2, 0.04, w, -L / 2 + 0.11 + k * 0.22, 0.02, 0, deck));
    for (const s of [-1, 1]) parts.push(M._mesh(M.box, M.darkWood, L, 0.14, 0.08, 0, -0.07, s * (w / 2 - 0.08), deck));
    for (const s of [-1, 1]) parts.push(M._mesh(M.box, M.darkWood, L, 0.06, 0.04, 0, 0.07, s * (w / 2 - 0.02), deck));
    // posts under it, their heights following it
    for (let k = 1; k <= 3; k++) {
      const x = o.len * (k / 4), hh = o.h * (k / 4) - 0.16;
      for (const s of [-1, 1]) parts.push(M._mesh(M.box, M.darkWood, 0.1, hh, 0.1, x, hh / 2, s * (w / 2 - 0.1), g));
    }
    // the platform: deck, four posts, braces, a rail along each side
    const px = o.len + o.plat / 2;
    for (let k = 0; k < Math.max(1, Math.round(o.plat / 0.2)); k++) parts.push(M._mesh(M.box, k % 2 ? M.darkWood : M.wood, 0.19, 0.045, w, o.len + 0.1 + k * 0.2, o.h - 0.022, 0, g));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(M._mesh(M.box, M.darkWood, 0.12, o.h - 0.05, 0.12, px + sx * (o.plat / 2 - 0.08), (o.h - 0.05) / 2, sz * (w / 2 - 0.08), g));
    for (const sz of [-1, 1]) { const b = M._mesh(M.box, M.darkWood, Math.hypot(o.plat, o.h), 0.06, 0.05, px, o.h / 2, sz * (w / 2 - 0.05), g); b.rotation.z = Math.atan2(o.h - 0.2, o.plat) * sz; parts.push(b); }
    for (const sz of [-1, 1]) {
      for (const x of [o.len + 0.05, o.len + o.plat - 0.05]) parts.push(M._mesh(M.box, M.darkWood, 0.06, 0.95, 0.06, x, o.h + 0.47, sz * (w / 2 - 0.04), g));
      parts.push(M._mesh(M.box, M.wood, o.plat, 0.06, 0.06, px, o.h + 0.9, sz * (w / 2 - 0.04), g));
    }
    g.userData = { parts };
    return g;
  }

  // ---- the motorised feeder: the vibration motor and the springs under the chute (added to the hopper's chute)
  feeder(chute) {
    const THREE = this.THREE, M = this.M, B = BULK, g = new THREE.Group();
    g.name = "goldrush-feeder";
    const parts = [];
    // springs (short coils as stacked rings) between the frame and the tray
    for (const z of [0.15, B.chuteL - 0.3]) for (const s of [-1, 1]) {
      for (let k = 0; k < 4; k++) parts.push(M._mesh(M.cyl, M.galvDark, 0.03, 0.012, 0.03, s * (B.chuteW / 2 + 0.03), -0.04 - k * 0.025, z, g));
    }
    // the motor: a ribbed housing on the west side, its cable down
    const motor = M._mesh(M.cyl, M.galvDark, 0.075, 0.2, 0.075, -(B.chuteW / 2 + 0.11), -0.06, B.chuteL * 0.45, g);
    motor.rotation.x = Math.PI / 2;
    parts.push(motor);
    parts.push(M._mesh(M.box, this.paint, 0.05, 0.12, 0.12, -(B.chuteW / 2 + 0.11), -0.06, B.chuteL * 0.45 - 0.13, g));
    chute.add(g);
    g.userData = { parts, motor };
    return g;
  }

  // ---- the control post: a timber post with a steel box, the lever, the lamp
  controlPost() {
    const THREE = this.THREE, M = this.M, g = new THREE.Group();
    g.name = "goldrush-controlpost";
    M._mesh(M.box, M.darkWood, 0.1, 1.25, 0.1, 0, 0.625, 0, g);
    const box = M._mesh(M.box, M.galvDark, 0.18, 0.26, 0.12, 0.09, 1.05, 0, g);
    const lever = M._mesh(M.box, this.red, 0.03, 0.18, 0.03, 0.16, 1.08, 0, g);
    const lamp = M._mesh(this.sphere, this.lampOff, 0.03, 0.03, 0.03, 0.12, 1.22, 0, g);
    const sign = M._mesh(M.box, this.paint, 0.005, 0.07, 0.14, 0.185, 0.96, 0, g);
    g.userData = { box, lever, lamp, sign };
    return g;
  }

  setLamp(post, state) {
    const u = post.userData;
    u.lamp.material = state === "on" ? this.lampOn : state === "wait" ? this.lampWait : this.lampOff;
  }

  // ---- delivered kits: steel sheets and timber on a pallet / a crate with the motor
  bulkKit() {
    const THREE = this.THREE, M = this.M, g = new THREE.Group();
    g.name = "goldrush-bulkhopper-kit";
    M._mesh(M.box, M.darkWood, 1.3, 0.12, 0.9, 0, 0.06, 0, g);
    for (let k = 0; k < 4; k++) M._mesh(M.box, M.galv, 1.2, 0.02, 0.8, 0.02 * k, 0.13 + k * 0.022, 0.01 * k, g);
    for (let k = 0; k < 6; k++) M._mesh(M.box, k % 2 ? M.darkWood : M.wood, 2.2, 0.06, 0.12, -0.2 + (k % 3) * 0.02, 0.24 + Math.floor(k / 3) * 0.06, -0.3 + (k % 3) * 0.3, g).rotation.y = 0.03 * k;
    return g;
  }

  feederKit() {
    const THREE = this.THREE, M = this.M, g = new THREE.Group();
    g.name = "goldrush-feeder-kit";
    M._mesh(M.box, M.wood, 0.6, 0.38, 0.45, 0, 0.19, 0, g);
    const m = M._mesh(M.cyl, M.galvDark, 0.08, 0.22, 0.08, 0, 0.47, 0, g);
    m.rotation.z = Math.PI / 2;
    return g;
  }
}

function gaugeTex(THREE) {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 192;
  const g = c.getContext("2d");
  g.fillStyle = "#e9e1cf"; g.fillRect(0, 0, 64, 192);
  g.strokeStyle = "#2c2418"; g.lineWidth = 3; g.strokeRect(2, 2, 60, 188);
  g.fillStyle = "#2c2418";
  for (let k = 0; k <= 8; k++) { const y = 182 - k * 21.5; g.fillRect(8, y - 1, k % 2 ? 18 : 30, k % 4 ? 2 : 4); }
  g.fillStyle = "#b2332b"; g.fillRect(44, 8, 12, 22);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
