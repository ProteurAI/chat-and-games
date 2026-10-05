// GoldRush - the camp's two trade buildings (phase 8): what you read from the
// mine before you are there.
//
//   ASSAY BOOTH   the gold buyer: a small planked booth - back and side walls,
//                 a lean-to roof with deep eaves over a solid counter, the
//                 brass balance as the centre of it all, a lockbox, the ledger,
//                 shelves of sample jars and crucibles, a lantern; the
//                 GOLDANKAUF board across the front of the roof
//   SUPPLY SHACK  the equipment shop: an open-front shack - a serving counter
//                 in the open front, the tools for sale on a rack in the
//                 opening, shelves of buckets, pans and crates inside (a warm
//                 lantern, the inside lighter than the planks outside), a door
//                 at one end, deep eaves, the AUSRÜSTUNG board along the front
//
// Built from boxes, lathes and planes with the world's textures, painted signs;
// the caller merges the static parts per material (a handful of draw calls).
// Colliders: one box per building (and its counter) - simple.

// canvas: corrugated sheet metal (light and dark bands, a little rust at the laps)
function corrugatedTex(THREE) {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 128;
  const g = c.getContext("2d");
  for (let x = 0; x < 128; x++) {
    const v = 150 + 55 * Math.sin((x / 128) * Math.PI * 16);
    g.fillStyle = `rgb(${v},${v + 2},${v + 4})`;
    g.fillRect(x, 0, 1, 128);
  }
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(120,64,30,${0.08 + (i % 4) * 0.04})`;
    g.fillRect((i * 37) % 128, 0, 2 + (i % 3), 6 + (i * 13) % 40);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// a grain sack (lathe): a full belly, a tied neck
export function sackGeometry(THREE) {
  const g = new THREE.LatheGeometry([[0, 0], [0.19, 0.015], [0.23, 0.12], [0.22, 0.3], [0.16, 0.42], [0.07, 0.48], [0.05, 0.53], [0.065, 0.57], [0, 0.585]].map(([x, y]) => new THREE.Vector2(x, y)), 12);
  g.scale(1, 1, 0.72);
  return g;
}

// a painted sign board: dark weathered planks, cream letters with a shadow
export function boardTexture(THREE, text, { w = 1024, h = 192, bg = "#3d2a1a", fg = "#f1dfb2", accent = "#c8963e" } = {}) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 3; i++) { g.fillStyle = "rgba(0,0,0,0.22)"; g.fillRect(0, (h / 3) * i, w, 3); }
  for (let i = 0; i < 40; i++) {                                     // grain
    g.strokeStyle = `rgba(255,230,190,${0.03 + (i % 5) * 0.012})`;
    g.lineWidth = 1 + (i % 2);
    const y = (i * 29) % h;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y + ((i % 5) - 2) * 4); g.stroke();
  }
  g.strokeStyle = accent; g.lineWidth = 6; g.strokeRect(14, 14, w - 28, h - 28);
  g.font = `700 ${Math.round(h * 0.56)}px Georgia, 'Times New Roman', serif`;
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillStyle = "rgba(0,0,0,0.45)"; g.fillText(text, w / 2 + 4, h / 2 + 6);
  g.fillStyle = fg; g.fillText(text, w / 2, h / 2 + 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/**
 * The materials both buildings share (created once, disposed by the caller).
 * world: woodTex, envMap
 */
export function buildingMaterials(THREE, world) {
  const roofTex = corrugatedTex(THREE);
  roofTex.repeat.set(3, 1);
  return {
    texs: [roofTex],
    plank: new THREE.MeshStandardMaterial({ map: world.woodTex, color: 0xa68566, roughness: 0.9 }),            // weathered outside boards
    frame: new THREE.MeshStandardMaterial({ map: world.woodTex, color: 0x7a5c40, roughness: 0.9 }),            // posts, beams, trim
    inside: new THREE.MeshStandardMaterial({ map: world.woodTex, color: 0xd2a678, roughness: 0.88, emissive: 0x2a1606, emissiveIntensity: 1 }),   // lit from within
    counter: new THREE.MeshStandardMaterial({ map: world.woodTex, color: 0x8a6440, roughness: 0.62 }),         // worn smooth by use
    roof: new THREE.MeshStandardMaterial({ map: roofTex, color: 0xb4b4ae, roughness: 0.55, metalness: 0.45, envMap: world.envMap || null, envMapIntensity: 0.5 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x6e7072, roughness: 0.45, metalness: 0.75, envMap: world.envMap || null, envMapIntensity: 0.6 }),
    galv: new THREE.MeshStandardMaterial({ color: 0xa7aaab, roughness: 0.4, metalness: 0.6, envMap: world.envMap || null, envMapIntensity: 0.7 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xc09848, roughness: 0.3, metalness: 0.9, envMap: world.envMap || null }),
    glass: new THREE.MeshStandardMaterial({ color: 0xd9c9a2, roughness: 0.15, metalness: 0.1, envMap: world.envMap || null, envMapIntensity: 0.8 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0xffe2a8, emissive: 0xffb456, emissiveIntensity: 1.6, roughness: 0.4 }),
    sack: new THREE.MeshStandardMaterial({ color: 0xb19a72, roughness: 0.97 }),
    paper: new THREE.MeshStandardMaterial({ color: 0xe9dfc6, roughness: 0.95 }),
    leather: new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.8 }),
  };
}

/**
 * The gold buyer's booth round the counter at (x, z) (its front, towards the path, is -z).
 * add(mesh) puts a static part in the scene; M: buildingMaterials. Returns { counterY, scaleAt,
 * lanternAt, signTex } - the caller places the (moving) scale on the counter.
 */
export function buildAssayBooth(THREE, { x, z, add, M, geo, colliders }) {
  const box = (w, h, d, m, px, py, pz, ry = 0) => { const o = new THREE.Mesh(geo(new THREE.BoxGeometry(w, h, d)), m); o.position.set(x + px, py, z + pz); o.rotation.y = ry; return add(o); };
  const cyl = (rt, rb, h, seg, m, px, py, pz) => { const o = new THREE.Mesh(geo(new THREE.CylinderGeometry(rt, rb, h, seg)), m); o.position.set(x + px, py, z + pz); return add(o); };
  const W = 2.7, D = 2.05, back = 1.05, front = -0.8, hb = 2.5, hf = 2.7;
  // a plank floor, raised a little
  box(W, 0.08, D, M.frame, 0, 0.04, (back + front) / 2 + 0.02);
  // back wall and the two side walls (the inside lit warm)
  box(W, hb, 0.07, M.plank, 0, hb / 2, back + 0.04);
  box(W - 0.12, hb - 0.12, 0.02, M.inside, 0, hb / 2, back - 0.005);
  for (const s of [-1, 1]) {
    box(0.07, hb, 1.25, M.plank, s * (W / 2), hb / 2, back - 0.6);
    box(0.02, hb - 0.12, 1.15, M.inside, s * (W / 2 - 0.045), hb / 2, back - 0.6);
  }
  // posts at the front and the corners, a lean-to roof sloping back, deep eaves over the counter
  for (const s of [-1, 1]) {
    box(0.11, hf, 0.11, M.frame, s * (W / 2), hf / 2, front);
    box(0.11, hb, 0.11, M.frame, s * (W / 2), hb / 2, back + 0.04);
  }
  box(W + 0.2, 0.14, 0.14, M.frame, 0, hf - 0.02, front);                          // the front beam
  const rl = Math.hypot(back - front + 0.75, hf - hb), roof = box(W + 0.55, 0.05, rl, M.roof, 0, (hf + hb) / 2 + 0.12, (back + front) / 2 - 0.15);
  roof.rotation.x = Math.atan2(hf - hb, back - front + 0.75);
  // the counter: a planked front, a thick worn top, a shelf below inside
  const cz = -0.18, ch = 0.98;
  box(2.05, ch - 0.06, 0.06, M.plank, 0, (ch - 0.06) / 2, cz - 0.28);
  for (const s of [-1, 1]) box(0.06, ch - 0.06, 0.56, M.frame, s * 1.0, (ch - 0.06) / 2, cz);
  box(2.2, 0.08, 0.66, M.counter, 0, ch, cz);
  box(1.9, 0.04, 0.5, M.frame, 0, 0.42, cz + 0.02);
  // on the counter: the lockbox (steel, a brass padlock), the ledger and pen, a little sack of samples
  box(0.34, 0.2, 0.24, M.steel, 0.66, ch + 0.14, cz + 0.06, -0.08);
  box(0.36, 0.025, 0.26, M.steel, 0.66, ch + 0.25, cz + 0.06, -0.08);
  box(0.05, 0.06, 0.02, M.brass, 0.66, ch + 0.17, cz - 0.07, -0.08);
  box(0.3, 0.03, 0.4, M.leather, -0.62, ch + 0.055, cz + 0.02, 0.18);
  box(0.28, 0.008, 0.37, M.paper, -0.62, ch + 0.073, cz + 0.02, 0.18);
  const sack = new THREE.Mesh(geo(sackGeometry(THREE)), M.sack);
  sack.scale.setScalar(0.42); sack.position.set(x + 0.3, ch + 0.04, z + cz + 0.18); sack.rotation.y = 0.5; add(sack);
  // shelves on the back wall: sample jars, crucibles, bottles - the assayer's things
  for (const [sy, n] of [[1.45, 7], [1.9, 6]]) {
    box(2.2, 0.035, 0.26, M.frame, 0, sy, back - 0.15);
    for (let i = 0; i < n; i++) {
      const px = -0.92 + (i * 1.84) / (n - 1), kind = (i + (sy > 1.6 ? 1 : 0)) % 3;
      if (kind === 0) cyl(0.04, 0.04, 0.12, 10, M.glass, px, sy + 0.08, back - 0.15);                  // a sample jar
      else if (kind === 1) cyl(0.045, 0.03, 0.07, 10, M.counter, px, sy + 0.05, back - 0.16);          // a clay crucible
      else cyl(0.025, 0.035, 0.17, 8, M.glass, px, sy + 0.1, back - 0.15);                              // a bottle
    }
  }
  // the lantern under the eaves, over the scale: the warm centre of the booth
  box(0.02, 0.32, 0.02, M.steel, -0.2, hf - 0.26, front + 0.28);
  cyl(0.06, 0.07, 0.16, 8, M.lamp, -0.2, hf - 0.5, front + 0.28);
  cyl(0.08, 0.05, 0.04, 8, M.steel, -0.2, hf - 0.4, front + 0.28);
  colliders.push({ type: "box", x, z: z + cz, hw: 1.12, hd: 0.36, rot: 0 });
  colliders.push({ type: "box", x, z: z + back - 0.4, hw: W / 2 + 0.08, hd: 0.55, rot: 0 });
  for (const s of [-1, 1]) colliders.push({ type: "circle", x: x + s * (W / 2), z: z + front, r: 0.1 });
  return { counterY: ch + 0.04, scaleAt: { x: x - 0.12, z: z + cz + 0.02 }, signY: hf + 0.2, signZ: z + front - 0.09, front: z + front, counterFront: z + cz - 0.31 };
}

/**
 * The supply shack (centre x, z on the ground; its front, towards the camp, is -z; 4.2 x 3.2 m).
 * Returns { rackAt: where the tools for sale hang (x, z, y), counterZ }.
 */
export function buildSupplyShack(THREE, { x, z, add, M, geo, colliders }) {
  const box = (w, h, d, m, px, py, pz, ry = 0, rx = 0) => { const o = new THREE.Mesh(geo(new THREE.BoxGeometry(w, h, d)), m); o.position.set(x + px, py, z + pz); o.rotation.set(rx, ry, 0); return add(o); };
  const cyl = (rt, rb, h, seg, m, px, py, pz, rz = 0) => { const o = new THREE.Mesh(geo(new THREE.CylinderGeometry(rt, rb, h, seg)), m); o.position.set(x + px, py, z + pz); o.rotation.z = rz; return add(o); };
  const W = 4.2, D = 3.2, hf = 2.65, hb = 2.3, fz = -D / 2, bz = D / 2;
  const ox0 = -1.75, ox1 = 0.95;                              // the open front between these (the door beyond)
  // floor, back wall, side walls (outside planks; the inside warm and lighter)
  box(W, 0.1, D, M.frame, 0, 0.05, 0);
  box(W, hb, 0.08, M.plank, 0, hb / 2, bz - 0.04);
  box(W - 0.2, hb - 0.1, 0.02, M.inside, 0, hb / 2, bz - 0.09);
  for (const s of [-1, 1]) {
    box(0.08, (hf + hb) / 2, D, M.plank, s * (W / 2 - 0.04), (hf + hb) / 4, 0);
    box(0.02, (hf + hb) / 2 - 0.15, D - 0.2, M.inside, s * (W / 2 - 0.1), (hf + hb) / 4, 0);
  }
  // the front: a wall at the left end, the open front with its counter, the door section on the right
  box(ox0 + W / 2, hf, 0.08, M.plank, (-W / 2 + ox0) / 2, hf / 2, fz + 0.04);
  box(W / 2 - ox1, hf, 0.08, M.plank, (ox1 + W / 2) / 2, hf / 2, fz + 0.04);
  box(0.95, 2.0, 0.05, M.frame, (ox1 + W / 2) / 2, 1.0, fz - 0.005);                       // the door
  box(0.04, 0.12, 0.04, M.steel, (ox1 + W / 2) / 2 - 0.35, 1.0, fz - 0.04);                // its handle
  box(ox1 - ox0, 0.95, 0.08, M.plank, (ox0 + ox1) / 2, 0.475, fz + 0.04);                  // under the counter
  box(ox1 - ox0 + 0.1, 0.07, 0.55, M.counter, (ox0 + ox1) / 2, 0.98, fz - 0.12);           // the counter board
  box(ox1 - ox0 + 0.2, 0.22, 0.12, M.frame, (ox0 + ox1) / 2, 2.32, fz + 0.02);             // the header over the opening
  for (const px of [ox0, ox1]) box(0.12, hf, 0.12, M.frame, px, hf / 2, fz + 0.02);
  // the roof: sheet metal, sloping back, deep eaves over the front
  const rl = Math.hypot(D + 0.95, hf - hb), roof = box(W + 0.6, 0.05, rl, M.roof, 0, (hf + hb) / 2 + 0.06, -0.3);
  roof.rotation.x = Math.atan2(hf - hb, D + 0.95);
  box(W + 0.6, 0.18, 0.06, M.frame, 0, hf + 0.13, fz - 0.62);                              // the fascia under the sign
  // inside: shelves along the back with buckets, pans and crates; a rack of handles; a lantern
  for (const sy of [0.85, 1.45, 2.0]) box(W - 0.4, 0.04, 0.42, M.frame, 0, sy, bz - 0.3);
  for (let i = 0; i < 4; i++) cyl(0.12, 0.1, 0.25, 12, M.galv, -1.6 + i * 0.3, 0.98, bz - 0.3);           // buckets
  for (let i = 0; i < 3; i++) { const p = cyl(0.19, 0.12, 0.05, 16, M.steel, 0.4 + i * 0.42, 1.5, bz - 0.28); p.rotation.x = 0.25; }   // gold pans
  for (let i = 0; i < 3; i++) box(0.4, 0.32, 0.34, M.counter, -1.3 + i * 0.5, 2.18, bz - 0.3, (i - 1) * 0.08);              // crates
  for (let i = 0; i < 5; i++) { const h = cyl(0.018, 0.018, 1.1, 6, M.counter, 1.45 + (i % 3) * 0.09, 0.62, bz - 0.55 - (i % 2) * 0.1, 0.12 - (i % 3) * 0.08); h.rotation.x = 0.1; }   // spare handles
  cyl(0.18, 0.2, 0.6, 12, M.frame, 1.55, 0.35, bz - 0.6);                                   // ... in a tub
  box(0.02, 0.4, 0.02, M.steel, -0.4, hf - 0.45, fz + 0.5);
  cyl(0.065, 0.075, 0.17, 8, M.lamp, -0.4, hf - 0.74, fz + 0.5);
  // outside: sacks and a crate by the counter, a stack of buckets by the door
  const sack = geo(sackGeometry(THREE));
  for (const [px, pz, sx, ry, rz] of [[-1.95, fz - 0.4, 1, 0.3, 0.05], [-1.55, fz - 0.48, 0.92, -0.4, -0.12]]) { const o = new THREE.Mesh(sack, M.sack); o.scale.setScalar(sx); o.position.set(x + px, 0, z + pz); o.rotation.set(0, ry, rz); add(o); }
  box(0.55, 0.45, 0.5, M.counter, 1.35, 0.23, fz - 0.55, 0.2);
  for (let i = 0; i < 3; i++) cyl(0.125, 0.105, 0.26, 12, M.galv, 1.72, 0.13 + i * 0.07, fz - 0.45);
  colliders.push({ type: "box", x, z, hw: W / 2, hd: D / 2, rot: 0 });
  colliders.push({ type: "box", x: x + (ox0 + ox1) / 2, z: z + fz - 0.12, hw: (ox1 - ox0) / 2 + 0.05, hd: 0.3, rot: 0 });
  return { rackAt: { x: x + (ox0 + ox1) / 2 - 0.5, z: z + fz + 0.3 }, counterY: 1.02, signY: hf + 0.38, signZ: z + fz - 0.66, front: z + fz };
}
