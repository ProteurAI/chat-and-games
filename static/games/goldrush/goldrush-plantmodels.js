// GoldRush - phase-9 models from simple shapes (no external asset): the mine
// intake hopper at the mountain's west foot, the belt conveyor up to the bulk
// hopper, the trommel screen on the bulk hopper's frame, the oversize pile and
// the spoil heap. Built with the phase-6/7 kits' materials (goldrush-mechmodels.js
// MechModels, goldrush-automodels.js AutoModels) plus a few of their own:
// painted machine steel, the cleated rubber belt, the perforated drum. A step
// up from the timber-and-sheet automation - still a small claim's plant.
//
// The layout (world, metres; y = 0 the ground):
//   INTAKE    the hopper's centre; its frame turns with the belt (the belt leaves
//             through the middle of one face)
//   BELT      tail under the intake's outlet -> head over the bulk hopper's east
//             rim; it climbs ~20 deg (a chevron belt), legs at BELT.legs (share of
//             the way from the tail), a head chute into the bulk hopper until the
//             trommel takes the belt's load instead
//   TROMMEL   the drum over the bulk hopper: fed at its east end (the belt's head
//             drops into the feed box), it falls slightly to the west; what passes
//             the screen drops into the bulk hopper, the oversize leaves at the west
//             end down a chute onto the OVERSIZE pile by the fence. It stands on
//             steel extensions on top of the bulk hopper's timber legs.
//   SPOIL     the spoil heap NW of the mountain (the excavator's waste dump)

import { mulberry32, noise2 } from "./goldrush-noise.js";
import { lumpGeometry as nuggetLump } from "./goldrush-loot.js";        // (Prompt 10: the trap's nugget - the world's lump)
import { BULK_AT } from "./goldrush-automation.js";
import { BULK } from "./goldrush-automodels.js";

export const INTAKE = { x: -14.35, z: -9.35, top: 1.3, bottom: 0.34, outletY: 0.72, depth: 0.42 };
INTAKE.rimY = INTAKE.outletY + INTAKE.depth;
export const INTAKE_EXT = { h: 0.2 };                                     // Prompt 10: the intake's extension ring (upgrade)
export const INTAKE_POST = { x: -15.05, z: -10.25 };                    // the plant's control post (NW of the intake)
export const INTAKE_SPOT = { x: -15.05, z: -10.95, yaw: Math.PI };      // stand here, facing it (south)
export const BELT = { tail: { x: INTAKE.x, z: INTAKE.z, y: 0.52 }, head: { x: -19.98, z: -3.78, y: 3.66 }, width: 0.5, legs: [0.36, 0.7, 0.93] };
export const TROMMEL = { feedX: -19.95, endX: -21.55, z: BULK_AT.z, r: 0.36, feedY: 2.82, endY: 2.7 };
TROMMEL.len = TROMMEL.feedX - TROMMEL.endX;
export const OVERSIZE = { x: -22.95, z: -4.15 };                         // where the trommel's chute ends
// Prompt 10: the nugget trap - a slot in the oversize chute's floor a little below the drum's end, a drop pipe, a small
// steel box at chest height (its long sides grates): what is too big for the screen and heavy drops in, stones slide on
const _o0 = [TROMMEL.len + 0.05, TROMMEL.endY - TROMMEL.r + 0.02, 0], _o1 = [-(OVERSIZE.x + 0.45 - TROMMEL.feedX), 1.98, -(OVERSIZE.z + 0.2 - TROMMEL.z)];
export const TRAP = { q: 0.14, y: 1.5, w: 0.3, d: 0.26, h: 0.2 };
TRAP.local = [0, 1, 2].map((a) => _o0[a] + (_o1[a] - _o0[a]) * TRAP.q);           // the slot (the trommel's frame)
TRAP.x = TROMMEL.feedX - TRAP.local[0];
TRAP.z = TROMMEL.z - TRAP.local[2];
// Prompt 10: the oversize stacker - a short belt from under the chute's end south along the fence; its head drops the
// stones at the strip's south end, where the loader comes in from the open ground (Zone B's west side)
export const OVER_BELT = { tail: { x: -22.6, z: -4.1, y: 1.6 }, head: { x: -22.72, z: -7.95, y: 2.12 }, width: 0.4 };
export const OVER_DROP = { x: -22.72, z: -8.35 };
export function overBeltGeom() {
  const t = OVER_BELT.tail, h = OVER_BELT.head, dx = h.x - t.x, dz = h.z - t.z, horiz = Math.hypot(dx, dz), rise = h.y - t.y;
  return { horiz, rise, len: Math.hypot(horiz, rise), yaw: Math.atan2(-dz, dx), pitch: Math.atan2(rise, horiz) };
}
export const SPOIL = { x: -18.5, z: -15.5 };
export const SPOIL_SIGN = { x: -15.55, z: -13.2 };
export const GENERATOR = { x: -16.25, z: -10.55 };                       // the belt's power (a small diesel set), cabled to the post

// the belt's geometry, derived: horizontal run, rise, slope length, yaw (local +x = up the belt), pitch
export function beltGeom() {
  const t = BELT.tail, h = BELT.head, dx = h.x - t.x, dz = h.z - t.z, horiz = Math.hypot(dx, dz), rise = h.y - t.y;
  return { dx: dx / horiz, dz: dz / horiz, horiz, rise, len: Math.hypot(horiz, rise), yaw: Math.atan2(-dz, dx), pitch: Math.atan2(rise, horiz) };
}
// world point at share s of the way from the tail (on the belt's top surface)
export function beltPoint(s, out = {}) {
  const t = BELT.tail, h = BELT.head;
  out.x = t.x + (h.x - t.x) * s; out.z = t.z + (h.z - t.z) * s; out.y = t.y + (h.y - t.y) * s;
  return out;
}

// heaps: V = HEAP_K r^2 h for the unit heap below (profile (1 - rho)^1.2 on the unit disc)
export const HEAP_K = 0.8925;

function canvasTex(THREE, w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// the belt: black rubber, worn grey, a raised chevron every 0.5 m (u along the belt)
function beltTex(THREE) {
  return canvasTex(THREE, 128, 64, (g, w, h) => {
    g.fillStyle = "#26241f"; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(150,140,120,${0.04 + (i % 6) * 0.015})`; g.fillRect((i * 53) % w, (i * 31) % h, 2 + (i % 3), 1); }
    g.strokeStyle = "#3d3a33"; g.lineWidth = 7; g.lineCap = "round";
    g.beginPath(); g.moveTo(w * 0.62, 6); g.lineTo(w * 0.42, h / 2); g.lineTo(w * 0.62, h - 6); g.stroke();
    g.strokeStyle = "rgba(120,110,95,0.5)"; g.lineWidth = 2;
    g.beginPath(); g.moveTo(w * 0.64, 6); g.lineTo(w * 0.44, h / 2); g.lineTo(w * 0.64, h - 6); g.stroke();
    // a little dirt carried along the edges
    for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(110,82,55,${0.25 + (i % 4) * 0.1})`; g.fillRect((i * 29) % w, i % 2 ? 1 + (i % 5) : h - 2 - (i % 5), 3, 2); }
  });
}

// the trommel's screen: punched steel, round holes in rows, rust and mud - holes are alpha 0
function drumTex(THREE) {
  return canvasTex(THREE, 256, 128, (g, w, h) => {
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const n = noise2(x * 0.05, y * 0.08, 91) * 0.5 + noise2(x * 0.2, y * 0.2, 93) * 0.25;
      const rust = Math.max(0, n - 0.05) * 1.4, i = (y * w + x) * 4;
      img.data[i] = 112 + 40 * rust + n * 20; img.data[i + 1] = 104 + 10 * rust + n * 18; img.data[i + 2] = 98 - 20 * rust + n * 16; img.data[i + 3] = 255;
      // the holes: 12 mm on a staggered pitch (a cell 16 x 16 px)
      const row = Math.floor(y / 16), cx = (x + (row % 2) * 8) % 16 - 8, cy = (y % 16) - 8;
      if (cx * cx + cy * cy < 22) img.data[i + 3] = 0;
    }
    g.putImageData(img, 0, 0);
  });
}

// a lump of loose ground: a squashed, dented icosahedron (instanced on the belt / in the drum)
function lumpGeometry(THREE) {
  const g = new THREE.IcosahedronGeometry(1, 1), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = 0.72 + 0.4 * (noise2(x * 2.1 + z, y * 2.3, 71) + 0.5) * 0.8;
    p.setXYZ(i, x * k * 1.15, y * k * 0.55, z * k);
  }
  g.computeVertexNormals();
  return g;
}

// the load on one belt cell: a low ridge of loose ground across the troughed belt (unit: x -0.5..0.5 along the
// run, z -0.5..0.5 across, height 1 on the crest), uneven, its ends a little lower so the cells read as one band
function bedGeometry(THREE) {
  const NX = 6, NZ = 10, pos = [], uv = [], idx = [];
  for (let i = 0; i <= NX; i++) for (let k = 0; k <= NZ; k++) {
    const x = i / NX - 0.5, z = k / NZ - 0.5, ridge = Math.pow(Math.max(0, 1 - (2 * z) * (2 * z)), 0.7);
    const end = 0.82 + 0.18 * Math.cos(x * Math.PI), n = 0.78 + 0.44 * noise2(x * 5.3 + 2, z * 4.1, 73);
    pos.push(x, k === 0 || k === NZ ? 0 : ridge * end * n, z);
    uv.push(x * 1.6 + 0.5, z * 0.9 + 0.5);
  }
  for (let i = 0; i < NX; i++) for (let k = 0; k < NZ; k++) {
    const a = i * (NZ + 1) + k, b = a + NZ + 1;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// the unit heap: a polar grid on the unit disc, height (1 - rho)^1.2 + lumps, vertex colours
// from `tone` (r, g, b at the top / at the foot), a little noise
function heapGeometry(THREE, seed, tone) {
  const R = 12, N = 40, pos = [], col = [], idx = [];
  for (let r = 0; r <= R; r++) for (let k = 0; k < N; k++) {
    const rho = r / R, th = (k / N) * Math.PI * 2, cx = Math.cos(th), cz = Math.sin(th);
    const n = (noise2(cx * rho * 3.1 + seed, cz * rho * 3.1, seed + 1) - 0.5) * 0.22 * rho + (noise2(cx * rho * 9 + seed, cz * rho * 9, seed + 3) - 0.5) * 0.06;
    const y = r === R ? 0 : Math.max(0, Math.pow(1 - rho, 1.2) + n * (1 - rho * 0.7));
    pos.push(cx * rho, y, cz * rho);
    const f = Math.min(1, rho * 1.3), v = 0.85 + (noise2(cx * rho * 7, cz * rho * 7, seed + 5) - 0.5) * 0.3;
    col.push((tone[0] + (tone[3] - tone[0]) * f) * v, (tone[1] + (tone[4] - tone[1]) * f) * v, (tone[2] + (tone[5] - tone[2]) * f) * v);
  }
  for (let r = 0; r < R; r++) for (let k = 0; k < N; k++) {
    const a = r * N + k, b = r * N + ((k + 1) % N), c = (r + 1) * N + k, d = (r + 1) * N + ((k + 1) % N);
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(pos.filter((_, i) => i % 3 !== 1).map((v) => v * 2), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export class PlantModels {
  /** M: MechModels (shared materials), A: AutoModels (lamps, the control post) */
  constructor(M, A) {
    this.M = M;
    this.A = A;
    const THREE = (this.THREE = M.THREE);
    this.yellow = M._mat(new THREE.MeshStandardMaterial({ color: 0xd59a26, roughness: 0.52, metalness: 0.25, envMap: M.galv.envMap || null, envMapIntensity: 0.4 }));
    this.yellowWorn = M._mat(new THREE.MeshStandardMaterial({ color: 0xa98a52, roughness: 0.7, metalness: 0.2 }));
    this.green = M._mat(new THREE.MeshStandardMaterial({ color: 0x3e5447, roughness: 0.45, metalness: 0.35, envMap: M.galv.envMap || null, envMapIntensity: 0.4 }));
    this.beltMap = M._tex(beltTex(THREE));
    this.belt = M._mat(new THREE.MeshStandardMaterial({ map: this.beltMap, roughness: 0.82 }));
    this.drumMap = M._tex(drumTex(THREE));
    this.drum = M._mat(new THREE.MeshStandardMaterial({ map: this.drumMap, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.45, envMap: M.galv.envMap || null, envMapIntensity: 0.35 }));
    this.lumpMat = M._mat(new THREE.MeshStandardMaterial({ map: M.heapMap, roughness: 0.95 }));
    this.mud = M._mat(new THREE.MeshStandardMaterial({ map: M.flowMap, color: 0x8a6a4c, roughness: 0.35, transparent: true, opacity: 0.7, depthWrite: false }));
    this.spray = M._mat(new THREE.MeshStandardMaterial({ color: 0xe4eef0, roughness: 0.1, transparent: true, opacity: 0.72, depthWrite: false }));
    this.heapMat = M._mat(new THREE.MeshStandardMaterial({ map: M.heapMap, vertexColors: true, roughness: 0.97 }));
    this.lump = M._geo(lumpGeometry(THREE));
    this.bed = M._geo(bedGeometry(THREE));
    this.drumGeo = M._geo(new THREE.CylinderGeometry(1, 1, 1, 28, 1, true));
    this.drumGeo.rotateZ(Math.PI / 2);                                                  // axis along x
    this.drumGeo.attributes.uv.array.forEach((v, i, a) => { a[i] = v * (i % 2 ? 2.4 : 7); });   // hole pitch
    this.ringGeo = M._geo(new THREE.TorusGeometry(1, 0.09, 6, 28));
    this.ringGeo.rotateY(Math.PI / 2);                                                  // around the x axis
    // the two heaps: stony grey (oversize: pebbles, clods), brown overburden (spoil)
    this.overGeo = M._geo(heapGeometry(THREE, 211, [0.5, 0.47, 0.42, 0.62, 0.58, 0.52]));
    this.spoilGeo = M._geo(heapGeometry(THREE, 223, [0.47, 0.37, 0.27, 0.6, 0.5, 0.38]));
  }

  // a box from a to b (world or local points), thickness w x h - for beams, braces, pipes
  _bar(m, a, b, w, h, parent, cyl = false) {
    const THREE = this.THREE, M = this.M, dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dx, dy, dz);
    const o = M._mesh(cyl ? M.cyl : M.box, m, cyl ? w : w, L, cyl ? w : h, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, parent);
    o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / L, dy / L, dz / L));
    return o;
  }

  // ---- the mine intake hopper: a square steel funnel on four posts, its outlet over the belt's tail
  intake() {
    const THREE = this.THREE, M = this.M, I = INTAKE, g = new THREE.Group();
    g.name = "goldrush-intake";
    const parts = [], half = I.top / 2, rimY = I.rimY;
    const fr = M._geo(new THREE.CylinderGeometry(I.top / Math.SQRT2 + 0.02, I.bottom / Math.SQRT2 + 0.02, I.depth, 4, 1, true));
    fr.rotateY(Math.PI / 4);
    parts.push(M._mesh(fr, M.galv, 1, 1, 1, 0, I.outletY + I.depth / 2, 0, g));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(M._mesh(M.box, M.galvDark, 0.08, rimY + 0.02, 0.08, sx * (half + 0.02), (rimY + 0.02) / 2, sz * (half + 0.02), g));
    // the rim (angle steel) and two rows of bracing - not across the belt's way out (+x, low)
    for (const s of [-1, 1]) {
      parts.push(M._mesh(M.box, M.galvDark, I.top + 0.08, 0.05, 0.04, 0, rimY, s * (half + 0.02), g));
      parts.push(M._mesh(M.box, M.galvDark, 0.04, 0.05, I.top + 0.08, s * (half + 0.02), rimY, 0, g));
      parts.push(M._mesh(M.box, M.galvDark, I.top + 0.04, 0.05, 0.04, 0, 0.32, s * (half + 0.02), g));
    }
    parts.push(M._mesh(M.box, M.galvDark, 0.04, 0.05, I.top + 0.04, -(half + 0.02), 0.32, 0, g));
    // yellow wear strips on the rim's two working faces (towards the mountain: the excavator / the barrow come from there)
    parts.push(M._mesh(M.box, this.yellow, I.top + 0.1, 0.06, 0.05, 0, rimY + 0.03, -(half + 0.04), g));
    parts.push(M._mesh(M.box, this.yellow, 0.05, 0.06, I.top + 0.1, -(half + 0.04), rimY + 0.03, 0, g));
    // the outlet spout and the skirt boards that keep the load on the belt
    parts.push(M._mesh(M.box, M.galvDark, I.bottom + 0.08, 0.1, I.bottom + 0.08, 0.06, I.outletY - 0.04, 0, g));
    for (const s of [-1, 1]) parts.push(M._mesh(M.box, M.wood, 1.0, 0.14, 0.03, 0.42, BELT.tail.y + 0.09, s * 0.19, g));
    // the fill: a mottled surface at the level (painted from the content)
    const grid = M._geo(new THREE.PlaneGeometry(1, 1, 8, 8));
    grid.rotateX(-Math.PI / 2);
    grid.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(grid.attributes.position.count * 3).fill(1), 3));
    const fill = M._mesh(grid, this.A.fillMat, I.top, 1, I.top, 0, I.outletY + 0.02, 0, g, false);
    fill.visible = false;
    // a level gauge on the north face (painted board + float pointer)
    const gauge = M._mesh(M.plane, this.A.gaugeMat, 0.12, 1, 0.34, -0.38, I.outletY + 0.2, half + 0.075, g, false);
    gauge.rotation.set(Math.PI / 2, 0, 0);
    const pointer = M._mesh(M.box, this.A.red, 0.16, 0.022, 0.03, -0.38, I.outletY + 0.04, half + 0.09, g);
    // Prompt 10 (upgrade "conveyor.fast"): a raised, flared extension on the rim (240 -> 420 l), its own wear strip
    const ext = new THREE.Group(), extParts = [], eh = INTAKE_EXT.h, flare = 0.06;
    for (const s of [-1, 1]) {
      const a = M._mesh(M.box, M.galv, I.top + 0.1 + flare, eh, 0.03, 0, rimY + eh / 2, s * (half + 0.03 + flare / 2), ext);
      a.rotation.x = s * 0.2;
      const b = M._mesh(M.box, M.galv, 0.03, eh, I.top + 0.1 + flare, s * (half + 0.03 + flare / 2), rimY + eh / 2, 0, ext);
      b.rotation.z = -s * 0.2;
      extParts.push(a, b);
      extParts.push(M._mesh(M.box, M.galvDark, I.top + 0.2 + flare, 0.04, 0.05, 0, rimY + eh, s * (half + 0.06 + flare), ext));
      extParts.push(M._mesh(M.box, M.galvDark, 0.05, 0.04, I.top + 0.2 + flare, s * (half + 0.06 + flare), rimY + eh, 0, ext));
      for (const t of [-1, 1]) extParts.push(M._mesh(M.box, M.galvDark, 0.04, eh, 0.04, s * (half + 0.04), rimY + eh / 2, t * (half + 0.04), ext));
    }
    extParts.push(M._mesh(M.box, this.yellow, I.top + 0.24 + flare, 0.05, 0.05, 0, rimY + eh + 0.03, -(half + 0.08 + flare), ext));
    extParts.push(M._mesh(M.box, this.yellow, 0.05, 0.05, I.top + 0.24 + flare, -(half + 0.08 + flare), rimY + eh + 0.03, 0, ext));
    ext.visible = false;
    g.add(ext);
    g.userData = { parts, fill, pointer, rimY, ext, extParts };
    return g;
  }

  // ---- the belt conveyor: stringers, idlers, the belt (carry + return), pulleys, the drive at the head,
  // legs; the load is instanced lumps on the belt (goldrush-plant.js places them from the belt's cells)
  conveyor() {
    const THREE = this.THREE, M = this.M, B = BELT, G = beltGeom(), w = B.width, g = new THREE.Group();
    g.name = "goldrush-conveyor";
    g.position.set(B.tail.x, 0, B.tail.z);
    g.rotation.y = G.yaw;
    const inc = new THREE.Group();
    inc.position.set(0, B.tail.y, 0);
    inc.rotation.z = G.pitch;
    g.add(inc);
    const parts = [], L = G.len;
    for (const s of [-1, 1]) parts.push(M._mesh(M.box, M.galvDark, L + 0.3, 0.14, 0.05, L / 2, -0.12, s * (w / 2 + 0.07), inc));
    for (let x = 0.35; x < L - 0.2; x += 0.55) {
      const r = M._mesh(M.cyl, M.galv, 0.045, w + 0.06, 0.045, x, -0.05, 0, inc);
      r.rotation.x = Math.PI / 2;
      parts.push(r);
      for (const s of [-1, 1]) parts.push(M._mesh(M.box, M.galvDark, 0.04, 0.09, 0.04, x, -0.1, s * (w / 2 + 0.05), inc));
    }
    for (let x = 0.8; x < L - 0.3; x += 1.6) { const r = M._mesh(M.cyl, M.galv, 0.04, w + 0.04, 0.04, x, -0.3, 0, inc); r.rotation.x = Math.PI / 2; parts.push(r); }
    const belt = M._mesh(M.plane, this.belt, L, 1, w, L / 2, 0, 0, inc, false);
    belt.receiveShadow = true;
    const ret = M._mesh(M.plane, this.belt, L, 1, w, L / 2, -0.27, 0, inc, false);
    ret.rotation.x = Math.PI;
    this.beltMap.repeat.set(L / 0.5, 1);
    const tail = M._mesh(M.cyl, M.galvDark, 0.13, w + 0.08, 0.13, 0, -0.13, 0, inc);
    tail.rotation.x = Math.PI / 2;
    const head = M._mesh(M.cyl, M.galvDark, 0.15, w + 0.08, 0.15, L, -0.14, 0, inc);
    head.rotation.x = Math.PI / 2;
    // the drive: motor + gearbox on the head's south side, a yellow guard over the pulley's end
    const motor = M._mesh(M.cyl, this.green, 0.11, 0.34, 0.11, L - 0.12, -0.16, w / 2 + 0.36, inc);
    motor.rotation.x = Math.PI / 2;
    parts.push(motor, M._mesh(M.box, this.green, 0.24, 0.22, 0.14, L - 0.12, -0.16, w / 2 + 0.13, inc));
    parts.push(M._mesh(M.box, this.yellow, 0.34, 0.26, 0.03, L - 0.05, -0.14, -(w / 2 + 0.11), inc));
    for (let i = 0; i < 5; i++) parts.push(M._mesh(M.box, M.galvDark, 0.02, 0.012, w + 0.12, L - 0.12 + i * 0.05, 0.19 - Math.abs(i - 2) * 0.03, 0, inc));   // the head hood
    // Prompt 10 (upgrade "conveyor.fast"): a second, bigger drive on the head's north side (motor, gearbox, a
    // V-belt guard) and steel skirt boards along the loading run - hidden until bought
    const up = new THREE.Group(), upParts = [];
    inc.add(up);
    const m2 = M._mesh(M.cyl, this.yellow, 0.15, 0.42, 0.15, L - 0.2, -0.2, -(w / 2 + 0.44), up);
    m2.rotation.x = Math.PI / 2;
    upParts.push(m2, M._mesh(M.box, this.green, 0.32, 0.3, 0.2, L - 0.2, -0.2, -(w / 2 + 0.17), up));
    upParts.push(M._mesh(M.box, this.yellow, 0.5, 0.36, 0.035, L - 0.32, -0.18, -(w / 2 + 0.66), up));
    for (const x of [L - 0.55, L - 0.05]) upParts.push(M._mesh(M.box, M.galvDark, 0.05, 0.42, 0.05, x, -0.36, -(w / 2 + 0.44), up));
    for (const s of [-1, 1]) {
      upParts.push(M._mesh(M.box, M.galv, L * 0.38, 0.13, 0.025, L * 0.19 + 0.15, 0.07, s * (w / 2 - 0.02), up));
      for (let x = 0.3; x < L * 0.38; x += 0.6) upParts.push(M._mesh(M.box, M.galvDark, 0.03, 0.18, 0.03, x, 0.04, s * (w / 2 + 0.01), up));
    }
    up.visible = false;
    // legs: two posts each, a cross beam, a diagonal - in the yaw frame (x along the run, y up)
    for (const s of B.legs) {
      const x = s * G.horiz, top = B.tail.y + s * G.rise - 0.2 - 0.04 / Math.cos(G.pitch);
      for (const zz of [-1, 1]) parts.push(M._mesh(M.box, this.yellow, 0.08, top, 0.08, x, top / 2, zz * (w / 2 + 0.13), g));
      parts.push(M._mesh(M.box, this.yellow, 0.06, 0.06, w + 0.34, x, top - 0.03, 0, g));
      if (top > 1.2) parts.push(this._bar(this.yellow, [x, 0.3, -(w / 2 + 0.13)], [x, top - 0.08, w / 2 + 0.13], 0.05, 0.05, g));
    }
    // the material on the belt: a low bed of loose ground per cell and a few clods on it, instance colours per cell
    const bed = new THREE.InstancedMesh(this.bed, this.lumpMat, 32);
    bed.count = 0;
    bed.frustumCulled = false;
    bed.receiveShadow = true;
    bed.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(32 * 3).fill(1), 3);
    inc.add(bed);
    const lumps = new THREE.InstancedMesh(this.lump, this.lumpMat, 96);
    lumps.count = 0;
    lumps.frustumCulled = false;
    lumps.castShadow = true;
    lumps.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(96 * 3).fill(1), 3);
    inc.add(lumps);
    g.userData = { inc, belt, ret, tail, head, parts, lumps, bed, len: L, geom: G, up, upParts };
    return g;
  }

  // ---- Prompt 10: the oversize stacker (world space): stringers, idlers, the belt, two pulleys, a small drive at the head,
  // two pairs of legs, a hood over the head; stones riding on it (instanced, from the belt's cells - goldrush-plant.js)
  overBelt() {
    const THREE = this.THREE, M = this.M, B = OVER_BELT, G = overBeltGeom(), w = B.width, L = G.len, g = new THREE.Group();
    g.name = "goldrush-overbelt";
    g.position.set(B.tail.x, 0, B.tail.z);
    g.rotation.y = G.yaw;
    const inc = new THREE.Group();
    inc.position.set(0, B.tail.y, 0);
    inc.rotation.z = G.pitch;
    g.add(inc);
    const parts = [];
    for (const s of [-1, 1]) parts.push(M._mesh(M.box, M.galvDark, L + 0.2, 0.11, 0.04, L / 2, -0.1, s * (w / 2 + 0.05), inc));
    for (let x = 0.3; x < L - 0.15; x += 0.6) { const r = M._mesh(M.cyl, M.galv, 0.04, w + 0.04, 0.04, x, -0.045, 0, inc); r.rotation.x = Math.PI / 2; parts.push(r); }
    for (const s of [-1, 1]) parts.push(M._mesh(M.box, M.galv, L * 0.4, 0.12, 0.02, L * 0.2 + 0.05, 0.06, s * (w / 2 - 0.02), inc));     // skirts at the loading end
    const belt = M._mesh(M.plane, this.belt, L, 1, w, L / 2, 0, 0, inc, false);
    belt.receiveShadow = true;
    const ret = M._mesh(M.plane, this.belt, L, 1, w, L / 2, -0.2, 0, inc, false);
    ret.rotation.x = Math.PI;
    parts.push(belt, ret);                                           // (one draw: the stones ride on the carry side)
    for (const x of [0, L]) { const p = M._mesh(M.cyl, M.galvDark, 0.1, w + 0.06, 0.1, x, -0.1, 0, inc); p.rotation.x = Math.PI / 2; parts.push(p); }
    const motor = M._mesh(M.cyl, this.green, 0.08, 0.26, 0.08, L - 0.1, -0.13, w / 2 + 0.28, inc);
    motor.rotation.x = Math.PI / 2;
    parts.push(motor, M._mesh(M.box, this.yellow, 0.24, 0.2, 0.025, L - 0.04, -0.1, -(w / 2 + 0.09), inc));
    for (let i = 0; i < 4; i++) parts.push(M._mesh(M.box, M.galvDark, 0.02, 0.012, w + 0.1, L - 0.1 + i * 0.05, 0.15 - Math.abs(i - 1.5) * 0.03, 0, inc));
    for (const sx of [0.25, G.horiz - 0.2]) {
      const top = B.tail.y + (sx / G.horiz) * G.rise - 0.16;
      for (const zz of [-1, 1]) parts.push(M._mesh(M.box, this.yellow, 0.07, top, 0.07, sx, top / 2, zz * (w / 2 + 0.1), g));
      parts.push(M._mesh(M.box, this.yellow, 0.05, 0.05, w + 0.28, sx, top - 0.03, 0, g));
      parts.push(this._bar(this.yellow, [sx, 0.25, -(w / 2 + 0.1)], [sx, top - 0.08, w / 2 + 0.1], 0.04, 0.04, g));
    }
    const lumps = new THREE.InstancedMesh(this.lump, this.lumpMat, 24);
    lumps.count = 0;
    lumps.frustumCulled = false;
    lumps.castShadow = true;
    lumps.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(24 * 3).fill(1), 3);
    inc.add(lumps);
    // the stones dropping off the head (a short stream)
    const fall = M._mesh(M.box, this.mud, 0.18, 0.4, 0.05, L + 0.12, -0.3, 0, inc, false);
    fall.rotation.z = -G.pitch;
    fall.visible = false;
    g.userData = { inc, parts, lumps, fall, len: L, geom: G };
    return g;
  }

  // the head chute into the bulk hopper (world space) - until the trommel stands there
  headChute() {
    const THREE = this.THREE, M = this.M, g = new THREE.Group();
    g.name = "goldrush-headchute";
    const a = [BELT.head.x - 0.12, BELT.head.y - 0.1, BELT.head.z + 0.1], b = [BULK_AT.x + 0.3, BULK.outletY + BULK.depth + 0.32, BULK_AT.z - 0.1];
    const parts = [this._bar(M.galv, a, b, 0.32, 0.02, g)];
    for (const s of [-1, 1]) { const off = [0, 0.06, s * 0.16]; parts.push(this._bar(M.galvDark, [a[0] + off[0], a[1] + off[1], a[2] + off[2]], [b[0] + off[0], b[1] + off[1], b[2] + off[2]], 0.02, 0.09, g)); }
    const fall = M._mesh(M.box, this.A.trayLoadMat, 0.16, 0.36, 0.05, b[0] - 0.05, b[1] - 0.2, b[2], g, false);
    fall.visible = false;
    g.userData = { parts, fall };
    return g;
  }

  // ---- the trommel: origin at the drum's feed end (east), local +x = west (down the drum), +z = north
  trommel() {
    const THREE = this.THREE, M = this.M, T = TROMMEL, L = T.len, r = T.r, g = new THREE.Group();
    g.name = "goldrush-trommel";
    g.position.set(T.feedX, 0, T.z);
    g.rotation.y = Math.PI;
    const parts = [], slope = Math.atan2(T.feedY - T.endY, L);
    const ax = new THREE.Group();                                       // the drum's axis
    ax.position.set(0, T.feedY, 0);
    ax.rotation.z = -slope;
    g.add(ax);
    const rotor = new THREE.Group();
    ax.add(rotor);
    const rotorParts = [];
    rotorParts.push(M._mesh(this.drumGeo, this.drum, L, r, r, L / 2, 0, 0, rotor));
    for (const x of [0.28, L - 0.28]) rotorParts.push(M._mesh(this.ringGeo, M.galvDark, 1, r + 0.04, r + 0.04, x, 0, 0, rotor));
    rotorParts.push(M._mesh(this.ringGeo, this.yellow, 1, r + 0.01, r + 0.01, 0.02, 0, 0, rotor));            // the feed-end flange
    for (let k = 0; k < 4; k++) {                                        // lifter bars inside
      const a = (k / 4) * Math.PI * 2, b = M._mesh(M.box, M.galvDark, L - 0.1, 0.05, 0.03, L / 2, Math.cos(a) * (r - 0.04), Math.sin(a) * (r - 0.04), rotor);
      b.rotation.x = a;
      rotorParts.push(b);
    }
    // trunnion rollers under the riding rings, on pedestals
    for (const x of [0.28, L - 0.28]) for (const s of [-1, 1]) {
      const ro = M._mesh(M.cyl, M.galvDark, 0.065, 0.1, 0.065, x, -0.38, s * 0.27, ax);
      ro.rotation.z = Math.PI / 2;
      parts.push(ro, M._mesh(M.box, this.yellow, 0.12, 0.14, 0.1, x, -0.48, s * 0.27, ax));
    }
    // the frame: steel extensions on the bulk hopper's legs, beams round the top, cross beams under the trunnions
    const half = BULK.top / 2 + 0.03, legTop = BULK.outletY + BULK.depth + 0.04, beamY = T.feedY - 0.53;
    const bx = (wx) => -(wx - T.feedX);                                 // world x -> local x (the frame is turned)
    const lx = [bx(BULK_AT.x + half), bx(BULK_AT.x - half)];
    for (const x of lx) for (const s of [-1, 1]) parts.push(M._mesh(M.box, this.yellow, 0.09, beamY - legTop + 0.04, 0.09, x, (legTop + beamY) / 2, s * half, g));
    for (const s of [-1, 1]) parts.push(M._mesh(M.box, this.yellow, lx[1] - lx[0] + 0.12, 0.08, 0.07, (lx[0] + lx[1]) / 2, beamY, s * half, g));
    for (const x of [0.28, L - 0.28]) parts.push(M._mesh(M.box, this.yellow, 0.08, 0.08, half * 2 + 0.06, x, beamY + 0.02 - x * Math.tan(slope), 0, g));
    // the feed box on the drum's high (east) end and its chute into the drum's mouth
    const fbY = T.feedY + r + 0.02;
    for (const [x, z, w, d] of [[0.17, 0.48, 0.38, 0.03], [0.17, -0.3, 0.38, 0.03], [-0.02, 0.09, 0.03, 0.8], [0.36, 0.09, 0.03, 0.8]]) parts.push(M._mesh(M.box, M.galv, w, 0.3, d, x, fbY + 0.15, z, g));
    parts.push(this._bar(M.galv, [0.17, fbY + 0.02, 0.09], [0.5, T.feedY - 0.1, 0], 0.36, 0.02, g));
    // under the feed end (beyond the hopper's rim): a deflector into the hopper
    parts.push(this._bar(M.galv, [-0.06, beamY + 0.12, 0], [0.42, beamY + 0.02, 0], 0.62, 0.015, g));
    // the oversize chute at the low (west) end, down to the pile by the fence
    const o0 = [L + 0.05, T.endY - r + 0.02, 0], o1 = [-(OVERSIZE.x + 0.45 - T.feedX), 1.98, -(OVERSIZE.z + 0.2 - T.z)];
    parts.push(this._bar(M.galv, o0, o1, 0.42, 0.02, g));
    for (const s of [-1, 1]) parts.push(this._bar(M.galvDark, [o0[0], o0[1] + 0.08, o0[2] + s * 0.2], [o1[0], o1[1] + 0.08, o1[2] + s * 0.2], 0.02, 0.14, g));
    const chutePost = M._mesh(M.box, this.yellow, 0.07, 1.98, 0.07, o1[0] - 0.05, 0.99, o1[2], g);
    parts.push(chutePost);
    // Prompt 10: the nugget trap under the chute (TRAP): the drop pipe, the box (floor, lid, ends), grates on its long sides
    const [tx, ty, tz] = TRAP.local, Y = TRAP.y, hw = TRAP.w / 2, hd = TRAP.d / 2, hh = TRAP.h / 2;
    parts.push(M._mesh(M.box, M.galvDark, 0.07, ty - (Y + hh), 0.07, tx, (ty + Y + hh) / 2, tz, g));
    parts.push(M._mesh(M.box, M.galv, TRAP.w + 0.02, 0.02, TRAP.d, tx, Y - hh, tz, g), M._mesh(M.box, M.galv, TRAP.w + 0.02, 0.02, TRAP.d, tx, Y + hh, tz, g));
    for (const s of [-1, 1]) {
      parts.push(M._mesh(M.box, M.galv, 0.02, TRAP.h, TRAP.d, tx + s * hw, Y, tz, g));
      parts.push(M._mesh(M.box, this.yellow, TRAP.w, 0.025, 0.02, tx, Y + hh - 0.02, tz + s * hd, g), M._mesh(M.box, this.yellow, TRAP.w, 0.025, 0.02, tx, Y - hh + 0.02, tz + s * hd, g));
      for (let b = -2; b <= 2; b++) parts.push(M._mesh(M.box, M.galvDark, 0.012, TRAP.h - 0.03, 0.012, tx + b * (TRAP.w / 6), Y, tz + s * hd, g));
    }
    parts.push(M._mesh(M.box, M.galvDark, 0.04, Y - hh, 0.04, tx, (Y - hh) / 2, tz, g));          // its post
    // the nugget in it (shown while it holds one; not merged - goldrush-plant.js sizes it to the piece's value)
    const tg = nuggetLump(THREE, 35, { w: 18, h: 12, amp: 0.3, freq: 1.6, sx: 1.15, sy: 0.62, sz: 0.9 });
    const trapNugget = new THREE.Mesh(tg, new THREE.MeshStandardMaterial({ color: 0xe0ac38, metalness: 0.55, roughness: 0.32, emissive: 0x6a4200, emissiveIntensity: 0 }));
    trapNugget.name = "goldrush-trap-nugget";
    trapNugget.position.set(tx, Y - hh + 0.03, tz);
    trapNugget.visible = false;
    g.add(trapNugget);
    // the spray manifold over the drum, nozzles, and the supply pipe from the tank (world points -> local)
    const lp = (wx, wy, wz) => [-(wx - T.feedX), wy, -(wz - T.z)];
    const top = T.feedY + r + 0.16;
    parts.push(this._bar(M.galvDark, [0.1, top - 0.01, -0.12], [L - 0.1, top - 0.01 - (L - 0.2) * Math.tan(slope), -0.12], 0.025, 0, g, true));
    for (let i = 0; i < 6; i++) { const x = 0.2 + i * ((L - 0.4) / 5); parts.push(this._bar(M.galvDark, [x, top - x * Math.tan(slope) - 0.01, -0.12], [x, top - x * Math.tan(slope) - 0.12, -0.12], 0.012, 0, g, true)); }
    const path = [lp(-19.6, 2.32, 0.95), lp(-19.6, 2.32, -2.55), lp(-20.6, 2.32, -2.55), lp(-20.6, top - 0.05, -2.55), [lp(-20.6, 0, 0)[0], top - 0.05, -0.12]];
    for (let i = 0; i < path.length - 1; i++) parts.push(this._bar(M.galvDark, path[i], path[i + 1], 0.03, 0, g, true));
    // the drive: a motor and a chain guard on the north side of the feed end
    const motor = M._mesh(M.cyl, this.green, 0.1, 0.3, 0.1, 0.35, beamY + 0.16, half - 0.05, g);
    motor.rotation.z = Math.PI / 2;
    parts.push(motor, M._mesh(M.box, this.yellow, 0.36, 0.42, 0.04, 0.12, T.feedY - 0.05, half - 0.2, g));
    // Prompt 10 (upgrade "trommel.fast"): a second, stronger drive on the south side (motor, gearbox, chain guard)
    // and a second spray bar with its nozzles - more water, more throughput; hidden until bought
    const up = new THREE.Group(), upParts = [];
    g.add(up);
    const m2 = M._mesh(M.cyl, this.yellow, 0.13, 0.36, 0.13, 0.38, beamY + 0.2, -(half - 0.08), up);
    m2.rotation.z = Math.PI / 2;
    upParts.push(m2, M._mesh(M.box, this.green, 0.24, 0.26, 0.2, 0.08, beamY + 0.2, -(half - 0.08), up));
    upParts.push(M._mesh(M.box, this.yellow, 0.4, 0.5, 0.04, 0.12, T.feedY - 0.02, -(half - 0.22), up));
    upParts.push(this._bar(M.galvDark, [0.1, top - 0.01, 0.12], [L - 0.1, top - 0.01 - (L - 0.2) * Math.tan(slope), 0.12], 0.025, 0, up, true));
    for (let i = 0; i < 6; i++) { const x = 0.3 + i * ((L - 0.4) / 5); upParts.push(this._bar(M.galvDark, [x, top - x * Math.tan(slope) - 0.01, 0.12], [x, top - x * Math.tan(slope) - 0.12, 0.12], 0.012, 0, up, true)); }
    upParts.push(this._bar(M.galvDark, [0.1, top - 0.01, 0.12], [0.1, top - 0.01, -0.12], 0.025, 0, up, true));
    up.visible = false;
    // a status lamp on the frame's south-east post
    const lamp = M._mesh(this.A.sphere, this.A.lampOff, 0.035, 0.035, 0.035, lx[0], beamY + 0.12, -half - 0.04, g);
    // moving bits: lumps tumbling in the drum, spray, the undersize curtain, oversize sliding down the chute
    const tumble = new THREE.InstancedMesh(this.lump, this.lumpMat, 16);
    tumble.count = 0; tumble.frustumCulled = false;
    tumble.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(16 * 3).fill(1), 3);
    ax.add(tumble);
    const drops = new THREE.InstancedMesh(M.pebble, this.spray, 36);
    drops.count = 0; drops.frustumCulled = false;
    ax.add(drops);
    const curtain = M._mesh(M.box, this.mud, L - 0.15, 0.32, 0.02, L / 2 + 0.05, T.feedY - r - 0.2 - (L / 2) * Math.tan(slope), 0, g, false);
    curtain.visible = false;
    // what the belt's head throws into the feed box (local: the head pulley is above the box's south-east corner)
    const hx = -(BELT.head.x - T.feedX), hz = -(BELT.head.z - T.z);
    const feedFall = M._mesh(M.box, this.mud, 0.07, 0.36, 0.22, hx + 0.05, BELT.head.y - 0.26, hz - 0.03, g, false);
    feedFall.visible = false;
    const over = new THREE.InstancedMesh(this.lump, this.lumpMat, 8);
    over.count = 0; over.frustumCulled = false;
    over.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(8 * 3).fill(1), 3);
    g.add(over);
    g.userData = { ax, rotor, rotorParts, parts, lamp, tumble, drops, curtain, feedFall, over, chute: [o0, o1], slope, top, up, upParts, trapNugget };
    return g;
  }

  // ---- the wet ground under the trommel and the bulk hopper (water from the spray, drips): a dark, glossy patch
  // with a ragged edge; its own material (it gets wetter while the trommel works - goldrush-plant.js)
  wetPatch() {
    const THREE = this.THREE, N = 48, pos = [0, 0, 0], idx = [];
    for (let k = 0; k <= N; k++) {
      const a = (k / N) * Math.PI * 2, r = 0.78 + 0.22 * noise2(Math.cos(a) * 1.7 + 4, Math.sin(a) * 1.7, 91) + 0.08 * noise2(Math.cos(a) * 5, Math.sin(a) * 5, 93);
      pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
      if (k) idx.push(0, k + 1, k);
    }
    const geo = this.M._geo(new THREE.BufferGeometry());
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = this.M._mat(new THREE.MeshStandardMaterial({ color: 0x3a2d22, roughness: 0.28, metalness: 0.05, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    const m = new THREE.Mesh(geo, mat);
    m.name = "goldrush-wet";
    m.position.set(BULK_AT.x - 0.35, 0.01, BULK_AT.z + 0.1);
    m.scale.set(2.3, 1, 1.5);
    m.renderOrder = 1;
    m.visible = false;
    return m;
  }

  // ---- heaps (unit size; scaled by the volume they hold - goldrush-plant.js)
  oversizePile() { const m = this.M._mesh(this.overGeo, this.heapMat, 1, 1, 1, OVERSIZE.x, 0, OVERSIZE.z, null); m.name = "goldrush-oversize"; m.visible = false; return m; }
  spoilHeap() { const m = this.M._mesh(this.spoilGeo, this.heapMat, 1, 1, 1, SPOIL.x, 0, SPOIL.z, null); m.name = "goldrush-spoil"; m.visible = false; return m; }

  // the spoil heap's sign: a post with a board "ABRAUM"
  spoilSign(boardTex) {
    const THREE = this.THREE, M = this.M, g = new THREE.Group();
    g.name = "goldrush-spoil-sign";
    g.position.set(SPOIL_SIGN.x, 0, SPOIL_SIGN.z);
    g.rotation.y = -Math.PI / 2 + 0.5;
    M._mesh(M.box, M.darkWood, 0.09, 1.7, 0.09, 0, 0.85, 0, g);
    M._mesh(M.box, M.darkWood, 0.9, 0.34, 0.04, 0, 1.5, 0.05, g);
    const mat = M._mat(new THREE.MeshStandardMaterial({ map: M._tex(boardTex), roughness: 0.85 }));
    const face = M._mesh(M.plane, mat, 0.86, 1, 0.3, 0, 1.5, 0.073, g, false);
    face.rotation.x = Math.PI / 2;
    return g;
  }

  // ---- the generator that drives the belt: a skid, a green housing with louvres, an exhaust, the cable to the post
  generator() {
    const THREE = this.THREE, M = this.M, g = new THREE.Group();
    g.name = "goldrush-generator";
    g.position.set(GENERATOR.x, 0, GENERATOR.z);
    g.rotation.y = 0.25;
    const parts = [];
    parts.push(M._mesh(M.box, M.galvDark, 1.15, 0.1, 0.62, 0, 0.05, 0, g));
    parts.push(M._mesh(M.box, this.green, 1.05, 0.62, 0.56, 0, 0.42, 0, g));
    for (let k = 0; k < 6; k++) parts.push(M._mesh(M.box, M.galvDark, 0.03, 0.34, 0.012, -0.32 + k * 0.08, 0.44, 0.285, g));
    parts.push(M._mesh(M.box, this.yellow, 0.3, 0.2, 0.012, 0.3, 0.5, 0.285, g));                       // its panel
    parts.push(M._mesh(M.cyl, M.galvDark, 0.03, 0.34, 0.03, -0.4, 0.9, -0.15, g));                       // exhaust
    parts.push(M._mesh(M.box, M.galvDark, 0.16, 0.06, 0.1, 0.38, 0.76, 0, g));                           // the filler cap / handle
    // the cable along the ground to the control post (world points -> local, the group is turned)
    const lp = (wx, wz) => { const dx = wx - GENERATOR.x, dz = wz - GENERATOR.z, c = Math.cos(-0.25), s = Math.sin(-0.25); return [dx * c + dz * s, 0.03, -dx * s + dz * c]; };
    const pts = [[0.5, 0.25, 0.1], lp(-15.6, -10.45), lp(INTAKE_POST.x - 0.05, INTAKE_POST.z - 0.02)];
    for (let i = 0; i < pts.length - 1; i++) parts.push(this._bar(M.rubber, pts[i], pts[i + 1], 0.018, 0, g, true));
    g.userData = { parts };
    return g;
  }

  // ---- the excavator's attachment stand: a steel stand with the attachment that is not on the machine
  attachmentStand() {
    const THREE = this.THREE, M = this.M, g = new THREE.Group();
    g.name = "goldrush-attachment-stand";
    const parts = [];
    parts.push(M._mesh(M.box, M.darkWood, 1.0, 0.1, 0.8, 0, 0.05, 0, g));
    for (const s of [-1, 1]) parts.push(M._mesh(M.box, this.yellow, 0.06, 0.5, 0.6, s * 0.4, 0.33, 0, g));
    // the breaker lying on it (shown while the bucket is on the machine) / a spare bucket (while the breaker is)
    const breaker = new THREE.Group();
    breaker.add(M._mesh(M.box, this.yellow, 0.6, 0.22, 0.24, 0, 0.7, 0, null));
    breaker.add(M._mesh(M.box, M.galvDark, 0.14, 0.26, 0.26, -0.33, 0.7, 0, null));
    const ch = M._mesh(M.cyl, M.galvDark, 0.04, 0.34, 0.04, 0.45, 0.7, 0, null);
    ch.rotation.z = Math.PI / 2;
    breaker.add(ch);
    g.add(breaker);
    const bucket = new THREE.Group();
    const sh = M._mesh(M.cyl, M.galvDark, 0.27, 0.56, 0.27, 0, 0.82, 0, null);
    sh.rotation.x = Math.PI / 2;
    bucket.add(sh);
    g.add(bucket);
    g.userData = { parts, breaker, bucket };
    return g;
  }

  // ---- delivered kits: belt sections, a roll of belt and a crated motor / the drum on timbers
  conveyorKit() {
    const THREE = this.THREE, M = this.M, g = new THREE.Group();
    g.name = "goldrush-conveyor-kit";
    M._mesh(M.box, M.darkWood, 1.6, 0.12, 1.0, 0, 0.06, 0, g);
    for (let k = 0; k < 3; k++) M._mesh(M.box, M.galvDark, 1.5, 0.1, 0.62, 0.03 * k, 0.17 + k * 0.1, 0.02 * k, g);
    const roll = M._mesh(M.cyl, M.rubber, 0.26, 0.52, 0.26, -0.2, 0.69, 0.05, g);
    roll.rotation.x = Math.PI / 2;
    M._mesh(M.box, M.wood, 0.5, 0.42, 0.42, 1.15, 0.21, 0.2, g);
    const mt = M._mesh(M.cyl, this.green, 0.11, 0.3, 0.11, 1.15, 0.53, 0.2, g);
    mt.rotation.z = Math.PI / 2;
    return g;
  }

  trommelKit() {
    const THREE = this.THREE, M = this.M, g = new THREE.Group();
    g.name = "goldrush-trommel-kit";
    for (const x of [-0.5, 0.5]) M._mesh(M.box, M.darkWood, 0.14, 0.12, 1.0, x, 0.06, 0, g);
    M._mesh(this.drumGeo, this.drum, TROMMEL.len, TROMMEL.r, TROMMEL.r, 0, 0.12 + TROMMEL.r, 0, g);
    for (const x of [-0.52, 0.52]) M._mesh(this.ringGeo, M.galvDark, 1, TROMMEL.r + 0.04, TROMMEL.r + 0.04, x, 0.12 + TROMMEL.r, 0, g);
    for (let k = 0; k < 4; k++) M._mesh(M.box, this.yellow, 1.3, 0.08, 0.08, 0, 0.05 + k * 0.08, 0.7 + (k % 2) * 0.1, g);
    return g;
  }
}

// a deterministic jitter (visual only)
export const jit = mulberry32;
