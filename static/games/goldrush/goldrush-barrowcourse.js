// GoldRush - the wheelbarrow handling course (developer tools; phase 9 handling pass). Cones on open,
// flat claim ground, each station on its own spot:
//
//   straight   a 14 m lane                       corner   a 90 degree turn (an L of cones)
//   s          an S through three offset gates    bumps    a lane with small dug marks across it
//   park       a box of cones to back out of      slope    a mild slope (6-12 %) at the mountain's foot
//
// Developer tools only: nothing of it is saved; it goes with the mine (or is rebuilt). The bumps are
// real shovel strokes (the dug ground of a working claim); everything else only places cones.

const LANE = 1.0;                       // m: half the lane's width (cones at +-1 m)
// the stations in their own frame: u along the way in, v to the right; the footprint (u0, u1, v0, v1) and the cones
const DEF = {
  straight: { box: [-1, 15, -1.6, 1.6], cones: () => { const c = []; for (let u = 0; u <= 14; u += 2) c.push([u, -LANE], [u, LANE]); return c; } },
  corner: { box: [-1, 8, -1.6, 8], cones: () => [
    [0, -LANE], [0, LANE], [1.5, -LANE], [1.5, LANE], [3, -LANE], [3, LANE],          // the way in
    [4.5, -LANE], [5.6, -0.95], [6.5, -0.5], [7, 0.4],                                  // the outer edge round the corner
    [4.5, LANE], [5, 1.6],                                                              // the inner corner
    [7, 1.8], [7, 3.3], [7, 4.8], [7, 6.3], [5, 3.1], [5, 4.6], [5, 6.1],               // the way out (to the right)
  ] },
  s: { box: [-1, 13, -2.8, 2.8], cones: () => {
    const c = [[0, -LANE], [0, LANE]];
    [[3, 1.1], [6.5, -1.1], [10, 1.1]].forEach(([u, v]) => c.push([u, v - 0.9], [u, v + 0.9]));
    c.push([12.5, -LANE], [12.5, LANE]);
    return c;
  } },
  bumps: { box: [-1, 12, -1.6, 1.6], dig: true, cones: () => { const c = []; for (let u = 0; u <= 11; u += 2.75) c.push([u, -LANE - 0.2], [u, LANE + 0.2]); return c; } },
  park: { box: [-1.5, 4.5, -1.6, 1.6], cones: () => [[0.6, -1.0], [1.8, -1.0], [3.0, -1.0], [0.6, 1.0], [1.8, 1.0], [3.0, 1.0], [3.6, -0.5], [3.6, 0.5]] },
};
// where the barrow starts (its wheel, in the station's frame) and which way (+1: along u, -1: the park box's way out is behind)
const START = { straight: [0.6, 0], corner: [0.6, 0], s: [0.6, 0], bumps: [0.6, 0], park: [2.6, 0] };

const fwdOf = (yaw) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });
const rightOf = (yaw) => ({ x: Math.cos(yaw), z: -Math.sin(yaw) });

export class BarrowCourse {
  constructor(game) {
    this.game = game;
    const THREE = (this.THREE = game.world.THREE);
    this.group = new THREE.Group();
    this.group.name = "goldrush-barrow-course";
    this.geo = new THREE.ConeGeometry(0.11, 0.36, 10);
    this.geo.translate(0, 0.18, 0);
    this.mat = new THREE.MeshStandardMaterial({ color: 0xe0631c, roughness: 0.55 });
    this.stations = {};
    this.used = [];                     // the footprints taken (world AABBs)
  }

  // the course on the claim: every station on its own flat, free spot (null: no room for one of them)
  build() {
    const g = this.game, cones = [];
    for (const id of Object.keys(DEF)) {
      const st = this._find(id);
      if (!st) return { ok: false, missing: id };
      this.stations[id] = st;
      for (const [u, v] of DEF[id].cones()) cones.push(this._world(st, u, v));
    }
    const slope = this._slope();
    if (slope) this.stations.slope = slope;
    const THREE = this.THREE, m = new THREE.InstancedMesh(this.geo, this.mat, cones.length), M4 = new THREE.Matrix4();
    cones.forEach((p, i) => { M4.makeTranslation(p.x, g.world.groundAt(p.x, p.z), p.z); m.setMatrixAt(i, M4); });
    m.frustumCulled = false;
    this.group.add(m);
    g.world.scene.add(this.group);
    this.cones = cones.length;
    if (this.stations.bumps) this._digBumps(this.stations.bumps);
    return { ok: true, stations: Object.keys(this.stations), cones: cones.length };
  }

  dispose() {
    if (this.group.parent) this.group.parent.remove(this.group);
    this.geo.dispose(); this.mat.dispose();
    for (const c of this.group.children) if (c.dispose) c.dispose();
  }

  // the barrow's start for a station: { x, z, yaw } (the slope: at its foot, the nose up the slope)
  start(id) {
    const st = this.stations[id];
    if (!st) return null;
    if (id === "slope") return { x: st.x, z: st.z, yaw: st.yaw };
    const [u, v] = START[id], p = this._world(st, u, v);
    return { x: p.x, z: p.z, yaw: st.yaw };
  }

  _world(st, u, v) {
    const f = fwdOf(st.yaw), r = rightOf(st.yaw);
    return { x: st.x + f.x * u + r.x * v, z: st.z + f.z * u + r.z * v };
  }

  // a flat, free spot for a station's footprint (all four headings): the nearest to the camp that fits,
  // not on another station (the candidates in order of distance - the first that fits is taken)
  _find(id) {
    const g = this.game, W = g.world, t = g.terrain, b = W.bounds, [u0, u1, v0, v1] = DEF[id].box;
    if (!this._cands) {
      this._cands = [];
      for (let x = b.minX + 2; x <= b.maxX - 2; x += 1.5) for (let z = b.minZ + 2; z <= b.maxZ - 2; z += 1.5) this._cands.push([x, z, Math.hypot(x + 6, z - 8)]);
      this._cands.sort((a, c) => a[2] - c[2]);
    }
    const near = (p, d0) => {
      for (const c of W.colliders) {
        const d = c.type === "circle" ? Math.hypot(p.x - c.x, p.z - c.z) - c.r : Math.max(Math.abs(p.x - c.x) - (c.hw || 0), Math.abs(p.z - c.z) - (c.hd || 0));
        if (d < d0) return true;
      }
      return false;
    };
    for (const [x, z] of this._cands) for (const yaw of [Math.PI / 2, -Math.PI / 2, 0, Math.PI]) {
      const st = { x, z, yaw }, pts = [];
      for (let u = u0; u <= u1 + 1e-6; u += 1) for (let v = v0; v <= v1 + 1e-6; v += 1) pts.push(this._world(st, u, v));
      let lo = Infinity, hi = -Infinity, okk = true;
      for (const p of pts) {
        if (p.x < b.minX + 1 || p.x > b.maxX - 1 || p.z < b.minZ + 1 || p.z > b.maxZ - 1) { okk = false; break; }
        if (DEF[id].dig && !t.inDigArea(p.x, p.z)) { okk = false; break; }
        const h = W.groundAt(p.x, p.z);
        lo = Math.min(lo, h); hi = Math.max(hi, h);
        if (hi - lo > 0.12 || (W.decks.length && W.deckAt(p.x, p.z) > -Infinity)) { okk = false; break; }
        for (const r of this.used) if (p.x > r[0] - 1 && p.x < r[1] + 1 && p.z > r[2] - 1 && p.z < r[3] + 1) { okk = false; break; }
        if (!okk) break;
      }
      if (!okk || pts.some((p) => near(p, 0.6))) continue;
      const xs = pts.map((p) => p.x), zs = pts.map((p) => p.z);
      this.used.push([Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]);
      return st;
    }
    return null;
  }

  // a mild slope at the mountain's foot: 6-12 % over 4 m, level across, free; the barrow at its foot facing up
  _slope() {
    const g = this.game, W = g.world, t = g.terrain, mc = t.moundCenter;
    let best = null;
    for (let a = 0; a < Math.PI * 2; a += 0.12) for (let r = 7; r <= 18; r += 0.5) {
      const x = mc.x + Math.cos(a) * r, z = mc.z + Math.sin(a) * r, dx = -Math.cos(a), dz = -Math.sin(a);
      if (!t.inDigArea(x, z) || !t.inDigArea(x + dx * 4, z + dz * 4)) continue;
      const h0 = W.groundAt(x, z), h4 = W.groundAt(x + dx * 4, z + dz * 4), grade = (h4 - h0) / 4;
      if (grade < 0.06 || grade > 0.12) continue;
      const side = Math.abs(W.groundAt(x + dz * 1, z - dx * 1) - W.groundAt(x - dz * 1, z + dx * 1));
      if (side > 0.15) continue;
      let free = true;
      for (let s = 0; s <= 4; s += 1) for (const c of W.colliders) {
        const px = x + dx * s, pz = z + dz * s;
        const d = c.type === "circle" ? Math.hypot(px - c.x, pz - c.z) - c.r : Math.max(Math.abs(px - c.x) - (c.hw || 0), Math.abs(pz - c.z) - (c.hd || 0));
        if (d < 0.8) { free = false; break; }
      }
      if (!free) continue;
      const score = Math.abs(grade - 0.08) + side;
      if (!best || score < best.score) best = { x, z, yaw: Math.atan2(-dx, -dz), grade, score };
    }
    return best;
  }

  // small dug marks across the bump lane, in the wheel's track: two shovel strokes each (5-10 cm, real ground)
  _digBumps(st) {
    const g = this.game;
    if (!g.tools.canUse("shovel")) g.grantTool("shovel");
    for (let k = 0; k < 6; k++) {
      const u = 2 + k * 1.5, v = k % 2 ? 0.12 : -0.12, p = this._world(st, u, v), f = fwdOf(st.yaw);     // in the wheel's track
      const ex = p.x - f.x * 1.3, ez = p.z - f.z * 1.3;                  // stand 1.3 m before it, look down at it
      g.teleport({ x: ex, z: ez, yaw: st.yaw, pitch: -0.9 });
      g._updateCamera && g._updateCamera(0);
      for (let n = 0; n < 2; n++) g.strokeAtCrosshair({ visuals: false, tool: "shovel" });     // two strokes: a dent of 5-10 cm
    }
  }
}
