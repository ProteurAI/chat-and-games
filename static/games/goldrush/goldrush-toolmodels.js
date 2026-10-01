// GoldRush - first-person tool models, built here from our own geometry
// (no external asset): a round-point shovel and a pickaxe. Used, dusty
// wood and steel; shared geometries / materials, built once per game.
//
// Local frame of every tool: the handle runs along -z (grip end near the
// player at +z, the working end away at -z), "up" of the working end is +y.
// grips[] are the points (and handle direction) the gloves hold.

import { mulberry32, noise2 } from "./goldrush-noise.js";

// long wood grain along v, a few darker worn patches
function woodGrain(ctx, w, h, seed) {
  const rng = mulberry32(seed);
  ctx.fillStyle = "rgb(168,118,72)";
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 70; i++) {
    const x = rng() * w, a = 0.06 + rng() * 0.14, lw = 0.6 + rng() * 1.8;
    ctx.strokeStyle = rng() < 0.5 ? `rgba(92,58,30,${a})` : `rgba(214,170,118,${a})`;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    for (let y = 0; y <= h; y += 16) ctx.lineTo(x + Math.sin(y * 0.02 + i) * 2.5 + (rng() - 0.5) * 1.2, y);
    ctx.stroke();
  }
  for (let i = 0; i < 6; i++) {                                       // knots / stains
    ctx.fillStyle = `rgba(70,44,24,${0.12 + rng() * 0.12})`;
    ctx.beginPath(); ctx.ellipse(rng() * w, rng() * h, 2 + rng() * 3, 8 + rng() * 16, 0, 0, Math.PI * 2); ctx.fill();
  }
}

// steel: a cool grey with faint scratches and rust/dirt spots
function steelGrime(ctx, w, h, seed) {
  const rng = mulberry32(seed);
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = noise2(x * 0.05, y * 0.05, seed) * 0.5 + noise2(x * 0.2, y * 0.2, seed + 3) * 0.25;
      const g = 196 + n * 40;
      const i = (y * w + x) * 4;
      img.data[i] = g; img.data[i + 1] = g - 2; img.data[i + 2] = g - 6; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  for (let i = 0; i < 120; i++) {                                     // scratches
    ctx.strokeStyle = `rgba(255,255,255,${0.08 + rng() * 0.12})`;
    ctx.lineWidth = 0.5;
    const x = rng() * w, y = rng() * h, a = rng() * Math.PI;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * (4 + rng() * 14), y + Math.sin(a) * (4 + rng() * 14)); ctx.stroke();
  }
  for (let i = 0; i < 40; i++) {                                      // rust / dried mud
    ctx.fillStyle = rng() < 0.5 ? `rgba(120,70,40,${0.15 + rng() * 0.2})` : `rgba(110,86,60,${0.15 + rng() * 0.2})`;
    ctx.beginPath(); ctx.arc(rng() * w, rng() * h, 1 + rng() * 4, 0, Math.PI * 2); ctx.fill();
  }
}

function canvasTex(THREE, w, h, draw, repeat = true) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// a tube along a quadratic bezier with a cross-section that changes along
// the way: radius rx/ry(t) -> a tapering pick point or a flattening blade
function sweptTube(THREE, p0, p1, p2, steps, ring, section) {
  const pos = [], uv = [], idx = [];
  const P = new THREE.Vector3(), T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps, it = 1 - t;
    P.set(it * it * p0.x + 2 * it * t * p1.x + t * t * p2.x, it * it * p0.y + 2 * it * t * p1.y + t * t * p2.y, it * it * p0.z + 2 * it * t * p1.z + t * t * p2.z);
    T.set(2 * it * (p1.x - p0.x) + 2 * t * (p2.x - p1.x), 2 * it * (p1.y - p0.y) + 2 * t * (p2.y - p1.y), 2 * it * (p1.z - p0.z) + 2 * t * (p2.z - p1.z)).normalize();
    B.crossVectors(T, up).normalize();
    if (B.lengthSq() < 1e-6) B.set(1, 0, 0);
    N.crossVectors(B, T).normalize();
    const { rx, ry } = section(t);
    for (let r = 0; r <= ring; r++) {
      const a = (r / ring) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      pos.push(P.x + B.x * ca * rx + N.x * sa * ry, P.y + B.y * ca * rx + N.y * sa * ry, P.z + B.z * ca * rx + N.z * sa * ry);
      uv.push(r / ring, t);
    }
  }
  for (let s = 0; s < steps; s++) for (let r = 0; r < ring; r++) {
    const a = s * (ring + 1) + r, b = a + ring + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export class ToolModels {
  constructor(THREE, { envMap } = {}) {
    this.THREE = THREE;
    this.geos = [];
    const track = (g) => { this.geos.push(g); return g; };
    this.woodTex = canvasTex(THREE, 64, 512, (c, w, h) => woodGrain(c, w, h, 41));
    this.steelTex = canvasTex(THREE, 128, 128, (c, w, h) => steelGrime(c, w, h, 43));
    this.wood = new THREE.MeshStandardMaterial({ map: this.woodTex, color: 0xd8c0a0, roughness: 0.72, metalness: 0 });
    this.steel = new THREE.MeshStandardMaterial({ map: this.steelTex, color: 0x8a8c8f, roughness: 0.45, metalness: 0.85, envMap: envMap || null, envMapIntensity: 0.9 });
    this.edge = new THREE.MeshStandardMaterial({ map: this.steelTex, color: 0xc9c7c2, roughness: 0.3, metalness: 0.95, envMap: envMap || null, envMapIntensity: 1.1 });
    this.soilMat = new THREE.MeshStandardMaterial({ color: 0x6e4a2e, roughness: 1, metalness: 0, flatShading: true });
    // leather grip wrap: a strap wound round the handle (diagonal turns)
    this.wrapTex = canvasTex(THREE, 64, 64, (c, w, h) => {
      c.fillStyle = "rgb(112,74,46)"; c.fillRect(0, 0, w, h);
      for (let i = -2; i < 6; i++) {
        c.strokeStyle = "rgba(48,30,18,0.75)"; c.lineWidth = 2;
        c.beginPath(); c.moveTo(0, i * 16); c.lineTo(w, i * 16 + 22); c.stroke();
        c.strokeStyle = "rgba(170,126,86,0.35)"; c.lineWidth = 1.5;
        c.beginPath(); c.moveTo(0, i * 16 + 5); c.lineTo(w, i * 16 + 27); c.stroke();
      }
    });
    this.wrapTex.repeat.set(2, 3);
    this.leather = new THREE.MeshStandardMaterial({ map: this.wrapTex, color: 0xd2b49a, roughness: 0.82, metalness: 0 });
    // the parts an upgrade changes get their own material (ash shaft, hardened point)
    this.shovelWood = this.wood.clone();
    this.pointMat = this.steel.clone();
    this.mats = [this.wood, this.steel, this.edge, this.soilMat, this.leather, this.shovelWood, this.pointMat];

    // ---------------- shovel
    const shovel = (this.shovel = new THREE.Group());
    shovel.name = "tool-shovel";
    const shaft = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0155, 0.017, 0.92, 14, 1)), this.shovelWood);
    shaft.rotation.x = Math.PI / 2;
    shaft.position.z = -0.06;
    shovel.add(shaft);
    // D-grip at the near end: a half ring from the shaft end out to the
    // ends of the cross bar (both in the x/z plane)
    const dRing = new THREE.Mesh(track(new THREE.TorusGeometry(0.052, 0.011, 8, 22, Math.PI)), this.wood);
    dRing.rotation.set(Math.PI / 2, 0, Math.PI);
    dRing.position.set(0, 0, 0.452);
    shovel.add(dRing);
    const bar = new THREE.Mesh(track(new THREE.CylinderGeometry(0.013, 0.013, 0.104, 10)), this.wood);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0, 0, 0.452);
    shovel.add(bar);
    // ferrule (steel collar) with two rivets
    const collar = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0185, 0.026, 0.14, 14, 1)), this.steel);
    collar.rotation.x = Math.PI / 2;
    collar.position.z = -0.57;
    shovel.add(collar);
    for (const sx of [-1, 1]) {
      const rv = new THREE.Mesh(track(new THREE.SphereGeometry(0.0045, 8, 6)), this.edge);
      rv.position.set(sx * 0.02, 0, -0.55);
      shovel.add(rv);
    }
    // blade: a round-point outline, extruded thin, then dished and bent
    const sh = new THREE.Shape();
    const W = 0.122, L = 0.29;
    sh.moveTo(-W, 0);
    sh.lineTo(-W * 0.98, -L * 0.55);
    sh.quadraticCurveTo(-W * 0.92, -L * 0.88, 0, -L);
    sh.quadraticCurveTo(W * 0.92, -L * 0.88, W * 0.98, -L * 0.55);
    sh.lineTo(W, 0);
    sh.quadraticCurveTo(0, 0.022, -W, 0);
    const blade = track(new THREE.ExtrudeGeometry(sh, { depth: 0.0035, bevelEnabled: false, curveSegments: 10 }));
    const bp = blade.attributes.position;
    for (let v = 0; v < bp.count; v++) {
      const x = bp.getX(v), y = bp.getY(v), z = bp.getZ(v);
      const dish = 0.026 * (1 - (x / W) ** 2);                  // concave across
      const bend = 0.035 * (y / L) * (y / L);                   // lifted towards the tip a little
      bp.setXYZ(v, x, z + dish - bend, y);                      // blade lies in the x/z plane, tip towards -z
    }
    blade.computeVertexNormals();
    // the blade sits at a lift angle to the shaft (as on a real shovel: with
    // the shaft slanting down, the blade lies nearly flat)
    const LIFT = 0.45, HEAD_Z = -0.6;
    const head = new THREE.Group();
    head.position.z = HEAD_Z;
    head.rotation.x = LIFT;
    shovel.add(head);
    const bladeMesh = new THREE.Mesh(blade, this.steel);
    bladeMesh.position.z = -0.63 - HEAD_Z;
    head.add(bladeMesh);
    // rolled step on the top edge + a bright worn cutting edge near the tip
    const step = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0055, 0.0055, W * 1.95, 10)), this.steel);
    step.rotation.z = Math.PI / 2;
    step.position.set(0, 0.012, -0.632 - HEAD_Z);
    head.add(step);
    const edgeG = track(sweptTube(THREE, new THREE.Vector3(-W * 0.8, 0.004, -0.63 - L * 0.62), new THREE.Vector3(0, -0.004, -0.63 - L * 1.07), new THREE.Vector3(W * 0.8, 0.004, -0.63 - L * 0.62), 14, 6, () => ({ rx: 0.0028, ry: 0.0016 })));
    edgeG.translate(0, 0, -HEAD_Z);
    head.add(new THREE.Mesh(edgeG, this.edge));
    // upgrade "Verstärktes Schaufelblatt": a riveted steel rim round the point
    const rim = (this.bladeRim = new THREE.Group());
    const rimG = track(sweptTube(THREE, new THREE.Vector3(-W * 0.93, 0.006, -0.63 - L * 0.5), new THREE.Vector3(0, 0.0, -0.63 - L * 1.12), new THREE.Vector3(W * 0.93, 0.006, -0.63 - L * 0.5), 18, 6, () => ({ rx: 0.006, ry: 0.0032 })));
    rimG.translate(0, 0, -HEAD_Z);
    const rimMat = this.steel.clone();
    rimMat.color.setHex(0x5f6266);
    this.mats.push(rimMat);
    rim.add(new THREE.Mesh(rimG, rimMat));
    const rivG = track(new THREE.SphereGeometry(0.0042, 8, 6));
    for (const [rx, rz] of [[-0.09, -0.79], [-0.05, -0.87], [0.05, -0.87], [0.09, -0.79]]) {
      const rv2 = new THREE.Mesh(rivG, this.edge);
      rv2.position.set(rx, 0.03, rz - HEAD_Z);
      rim.add(rv2);
    }
    rim.visible = false;
    head.add(rim);
    // the load of soil (shown while scooping / carrying)
    const soilG = track(new THREE.IcosahedronGeometry(1, 2));
    const sp = soilG.attributes.position;
    for (let v = 0; v < sp.count; v++) {
      const x = sp.getX(v), y = sp.getY(v), z = sp.getZ(v);
      const k = 1 + 0.22 * noise2(x * 3 + z, y * 3, 17);
      sp.setXYZ(v, x * k * 0.095, Math.max(-0.2, y) * k * 0.045, z * k * 0.12);
    }
    soilG.computeVertexNormals();
    this.soil = new THREE.Mesh(soilG, this.soilMat);
    this.soil.position.set(0, 0.03, -0.76 - HEAD_Z);
    this.soil.visible = false;
    head.add(this.soil);
    shovel.userData.grips = [
      { z: 0.42, dir: 1, side: 1 },               // right hand on the D-grip
      { z: -0.18, dir: 1, side: -1 },             // left hand down the shaft
    ];
    const reach = 0.63 + L + HEAD_Z;
    shovel.userData.tip = new THREE.Vector3(0, Math.sin(LIFT) * reach, HEAD_Z - Math.cos(LIFT) * reach);

    // ---------------- pickaxe
    const pick = (this.pickaxe = new THREE.Group());
    pick.name = "tool-pickaxe";
    // oval hickory handle, thicker towards the head, a swelled knob at the end
    const handleG = track(new THREE.CylinderGeometry(0.0175, 0.0215, 0.86, 20, 8));
    handleG.scale(1.25, 1, 1);
    const handle = new THREE.Mesh(handleG, this.wood);
    handle.rotation.x = Math.PI / 2;
    handle.position.z = -0.1;
    pick.add(handle);
    const knob = new THREE.Mesh(track(new THREE.SphereGeometry(0.024, 18, 12)), this.wood);
    knob.scale.set(1.2, 0.95, 0.75);
    knob.position.z = 0.33;
    pick.add(knob);
    // a worn leather wrap where the hands go
    const wrap = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0215, 0.0222, 0.2, 20, 6, true)), this.leather);
    wrap.scale.set(1.22, 1, 1);
    wrap.rotation.x = Math.PI / 2;
    wrap.position.z = 0.2;
    pick.add(wrap);
    // forged head: the eye around the handle end with its socket and wedge,
    // a curved point and a flat adze
    // the head as one group round the eye (upgrade "Schwerer Kopf" scales it)
    const pickHead = (this.pickHead = new THREE.Group());
    pick.add(pickHead);
    const eye = new THREE.Mesh(track(new THREE.CylinderGeometry(0.03, 0.03, 0.075, 18, 2)), this.steel);
    eye.position.set(0, 0, -0.52);
    pick.add(eye);
    const socket = new THREE.Mesh(track(new THREE.CylinderGeometry(0.026, 0.029, 0.05, 18, 1)), this.steel);
    socket.rotation.x = Math.PI / 2;
    socket.position.z = -0.48;
    pick.add(socket);
    const wedge = new THREE.Mesh(track(new THREE.BoxGeometry(0.006, 0.004, 0.03)), this.edge);
    wedge.position.set(0, 0.0385, -0.52);
    pick.add(wedge);
    const point = track(sweptTube(THREE, new THREE.Vector3(0, -0.02, -0.52), new THREE.Vector3(0, -0.15, -0.53), new THREE.Vector3(0, -0.29, -0.45), 24, 12, (t) => {
      const r = 0.022 * (1 - t) + 0.0016;
      return { rx: r, ry: r * 1.15 };
    }));
    pickHead.add(new THREE.Mesh(point, this.pointMat));
    const adze = track(sweptTube(THREE, new THREE.Vector3(0, 0.02, -0.52), new THREE.Vector3(0, 0.12, -0.53), new THREE.Vector3(0, 0.22, -0.47), 22, 12, (t) => ({
      rx: 0.02 + t * 0.016,            // widens into a blade ...
      ry: 0.02 * (1 - t) + 0.0022,      // ... and gets thin
    })));
    pickHead.add(new THREE.Mesh(adze, this.steel));
    const tipG = track(new THREE.SphereGeometry(0.004, 8, 6));
    const tipMesh = new THREE.Mesh(tipG, this.edge);
    tipMesh.position.set(0, -0.29, -0.45);
    pickHead.add(tipMesh);
    this.pickTip = tipMesh;
    for (const m of [eye, socket, wedge]) { pick.remove(m); pickHead.add(m); }
    pick.userData.grips = [
      { z: 0.13, dir: 1, side: 1 },               // right hand (see GRIPS in goldrush-hand.js)
      { z: 0.25, dir: 1, side: -1 },              // left hand at the end
    ];
    pick.userData.tip = new THREE.Vector3(0, -0.29, -0.45);
    for (const g of [shovel, pick]) g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = false; } });
  }

  // what the bought upgrades look like (goldrush-shop.js ids)
  applyUpgrades(ups) {
    const has = (id) => ups && ups.has(id);
    this.bladeRim.visible = has("shovel.blade");
    this.shovelWood.color.setHex(has("shovel.handle") ? 0xf4e6c8 : 0xd8c0a0);       // pale ash vs. the old hickory
    this.pointMat.color.setHex(has("pickaxe.tip") ? 0xc9ced6 : 0x8a8c8f);
    this.pointMat.roughness = has("pickaxe.tip") ? 0.22 : 0.45;
    this.pickTip.scale.setScalar(has("pickaxe.tip") ? 1.5 : 1);
    // the heavy head: a bigger forging round the eye (the eye stays on the handle)
    const k = has("pickaxe.head") ? 1.14 : 1;
    this.pickHead.scale.setScalar(k);
    this.pickHead.position.set(0, 0, -0.52 * (1 - k));
  }

  // a little dirt sticks to the working ends while you use them
  setDirt(amount) {
    const d = Math.max(0, Math.min(1, amount));
    this.steel.color.setRGB(0.54 - d * 0.12, 0.55 - d * 0.15, 0.56 - d * 0.19);
  }

  dispose() {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.woodTex.dispose();
    this.steelTex.dispose();
    this.wrapTex.dispose();
  }
}
