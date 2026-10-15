// GoldRush - Earth 2.0B: what a tool leaves in the ground, below the simulation's grid.
//
// The terrain's heights live on a 12.5 cm grid (the truth: integer qh, mass, gold). A shovel's scoop is a 1-2 cm dent
// over a few cells there - the grid cannot show a tool's edge, a lip, the blade's scrape marks. DigDetail is a derived,
// never-saved picture of exactly that: a fine texture (4 texels per grid cell, ~3 cm) over the whole terrain
//
//   R  relief: a height offset in metres around 0.5 (+-2 cm), the tool's imprint: floor scrape marks / finger grooves /
//      the pick's pit and cracks, the walls of the cut, a broken, irregular lip of spoil around it, crumbs that fell
//      back in. The Earth shader reads it as a normal / cavity change - the geometry, the shadows and the collision
//      are the simulation's heights alone, so nothing can float over the surface or clip through it.
//   G  footprint: where the tool just worked (1 inside, falling off through the lip) - a crisp "freshly cut" mask
//      instead of the grid's blurry one.
//
// A stamp is computed from the bite the terrain reports (terrain.lastBite: where, which way, how big, what tool) in the
// tool's own plane on the real surface (so it follows a slope), with a noise-broken outline, and blended into what was
// there (repeated digging overwrites the older imprint under the new footprint). Two later passes of the same stamp
// (settleAt) relax it: wall and lip sag a little, crumbs land in the floor - the short "settle" after a cut.
//
// Uploads: a stamp marks a texel box; once per frame before drawing it goes to the idle one of two texture sets as a
// sub-rectangle (as TerrainView does for the state textures: no driver stall). Nothing here is read back. After a
// reload the detail is empty (the shader's height-derived crest / cavity and the worked-ground state still show the cuts).

import { noise2, smoothstep } from "./goldrush-noise.js";

export const DIG_DETAIL = {
  perCell: 4,                 // texels per terrain grid cell
  range: 0.02,                // m: the relief texture spans +-range around 0.5
  settleAt: [0.12, 0.5],      // s after the cut: the stamp is redone, more settled each time
  maxQueue: 12,
  fullShare: 0.3,
};

const R0 = 128;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export class DigDetail {
  constructor(THREE, t) {
    this.THREE = THREE;
    this.t = t;
    const res = (this.res = Math.round(t.cols * DIG_DETAIL.perCell));
    this.texel = t.size / res;
    this.range = DIG_DETAIL.range;
    this.enabled = true;
    this.data = new Uint8Array(res * res * 2);
    for (let i = 0; i < this.data.length; i += 2) this.data[i] = R0;
    this.queue = [];
    this.dirty = null;                      // texel box changed since the last flush
    this.full = true;
    this.stats = { stamps: 0, restamps: 0, texels: 0, stampMs: 0, maxStampMs: 0, flushes: 0, partial: 0, fullUploads: 0, uploadMs: 0, maxFlushMs: 0 };
    const make = () => {
      const tex = new THREE.DataTexture(this.data, res, res, THREE.RGFormat, THREE.UnsignedByteType);
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.NoColorSpace;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      const stage = new THREE.DataTexture(this.data, res, res, THREE.RGFormat, THREE.UnsignedByteType);
      stage.unpackAlignment = 1;
      stage.colorSpace = THREE.NoColorSpace;
      return { tex, stage, pending: null, full: true };
    };
    this.sets = [make(), make()];
    this.cur = 0;
    this.uniforms = {
      tDDetail: { value: this.sets[0].tex },
      uDDetail: { value: new THREE.Vector4(t.x0, t.z0, 1 / t.size, 1 / res) },        // origin, 1 / size, 1 texel (uv)
      uDDetailK: { value: new THREE.Vector4(2 * this.range, this.texel, 2.2, 1) },    // relief span (m), texel (m), normal strength, on
    };
  }

  /** the dig detail is part of the picture on every tier but the lowest (the quality tier decides) */
  setEnabled(on) {
    on = !!on;
    if (on === this.enabled) return;
    this.enabled = on;
    this.uniforms.uDDetailK.value.w = on ? 1 : 0;
    if (!on) this.clear();
  }

  clear() {
    const d = this.data;
    for (let i = 0; i < d.length; i += 2) { d[i] = R0; d[i + 1] = 0; }
    this.queue.length = 0;
    this.full = true;
    this.dirty = null;
  }

  // ------------------------------------------------------------ stamping

  /** a bite was cut (terrain.lastBite, copied here): stamp it now, redo it twice while it settles */
  bite(b) {
    if (!this.enabled) return;
    const reach = (Math.max(b.a, b.b) + 0.1) * 2.2;
    for (let q = this.queue.length - 1; q >= 0; q--) {          // a newer cut over an older, still settling one: the newer wins
      const o = this.queue[q].bite;
      if (Math.hypot(o.x - b.x, o.z - b.z) < reach + (Math.max(o.a, o.b) + 0.1) * 2.2) this.queue.splice(q, 1);
    }
    const copy = { ...b };
    this.stamp(copy, 0);
    if (this.queue.length < DIG_DETAIL.maxQueue) this.queue.push({ bite: copy, t: 0, step: 0 });
  }

  /** per frame: the settling passes of recent cuts */
  update(dt) {
    const Q = this.queue;
    for (let q = Q.length - 1; q >= 0; q--) {
      const e = Q[q], at = DIG_DETAIL.settleAt;
      e.t += dt;
      while (e.step < at.length && e.t >= at[e.step]) { this.stamp(e.bite, (e.step + 1) / at.length, true); e.step++; }
      if (e.step >= at.length) Q.splice(q, 1);
    }
  }

  /**
   * Draw one bite's imprint into the detail. settle 0 .. 1: how far the cut has relaxed (wall / lip sag, crumbs in the floor).
   * Everything is a function of (bite, settle): the same seed gives the same marks every pass.
   */
  stamp(b, settle = 0, again = false) {
    const t = this.t, T = this.texel, res = this.res, data = this.data, range = this.range, t0 = performance.now();
    const a = b.a, bw = b.b, sd = b.seed | 0;
    const type = b.type === "pick" ? 1 : b.type === "scrape" ? 2 : 0;
    const reach = Math.max(a, bw) * 1.6 + 2 * T;
    const i0 = Math.max(0, Math.floor((b.x - reach - t.x0) / T)), i1 = Math.min(res - 1, Math.floor((b.x + reach - t.x0) / T));
    const j0 = Math.max(0, Math.floor((b.z - reach - t.z0) / T)), j1 = Math.min(res - 1, Math.floor((b.z + reach - t.z0) / T));
    if (i0 > i1 || j0 > j1) return;
    const nx = b.nx, ny = b.ny, nz = b.nz, ux = b.ux, uy = b.uy, uz = b.uz;
    const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
    // size of the marks: a bigger tool, a bigger lip; a partial bite leaves a lighter mark
    const amp = clamp(Math.sqrt(Math.max(a, bw) / 0.2), 0.7, 2.2) * (0.45 + 0.55 * b.frac) * (type === 1 ? 1.7 : 1);
    const sp = clamp(bw * 0.075, 0.011, 0.03);                      // the blade's scrape-line spacing
    const wob = type === 1 ? 0.3 : type === 2 ? 0.2 : 0.16;         // how broken the outline is
    const wy0 = b.y;
    const k127 = 127 / range;
    let n = 0;
    for (let j = j0; j <= j1; j++) {
      const wz = t.z0 + (j + 0.5) * T, pz = wz - b.z;
      for (let i = i0; i <= i1; i++) {
        const wx = t.x0 + (i + 0.5) * T, px = wx - b.x;
        const py = t.getHeightAt(wx, wz) - wy0;
        const dn = px * nx + py * ny + pz * nz;
        if (dn > 0.3 || dn < -0.3) continue;                       // not on this face (the far side of a ridge)
        const du = (px * ux + py * uy + pz * uz) / a, dv = (px * vx + py * vy + pz * vz) / bw;
        const rho = Math.sqrt(du * du + dv * dv);
        if (rho > 1.7) continue;
        const edgeN = noise2(wx * 9 + 3.1, wz * 9 + 7.7, sd) * 0.55 + noise2(wx * 23, wz * 23, sd + 1) * 0.45;
        const rb = rho * (1 + wob * edgeN);                          // the broken outline
        const W = 1 - smoothstep(1.05, 1.5, rb);
        if (W <= 0) continue;
        const inside = 1 - smoothstep(0.84, 1.0, rb);
        const band = smoothstep(0.86, 1.02, rb) * (1 - smoothstep(1.02, 1.42, rb));      // the lip's ring
        const lipN = 0.5 + 0.5 * noise2(wx * 17 + 11, wz * 17 - 5, sd + 2);              // broken: some stretches high, some missing
        const crumb = smoothstep(0.55, 0.85, noise2(wx * 38, wz * 38, sd + 4)) * settle;
        const sag = 1 - 0.3 * settle;
        let rel;
        if (type === 1) {                                           // pick: a pit, cracks running out of it, chips thrown round it
          const th = Math.atan2(dv, du);
          const crack = smoothstep(0.17, 0.0, Math.abs(Math.sin((th + noise2(wx * 7, wz * 7, sd + 5) * 0.9) * 3.0)))
            * smoothstep(0.15, 0.4, rb) * (1 - smoothstep(0.85, 1.35, rb));
          rel = -0.012 * amp * (1 - smoothstep(0.0, 0.55, rb))
            - 0.0046 * amp * crack * inside
            - 0.0035 * amp * smoothstep(0.7, 0.98, rb) * inside
            + 0.0105 * amp * band * smoothstep(0.1, 0.75, lipN) * sag
            + 0.0028 * amp * crumb * (1 - 0.6 * smoothstep(0.0, 0.5, rb));
        } else if (type === 2) {                                    // hand: shallow drag, finger grooves, a soft low rim
          const groove = Math.sin(dv * bw / 0.024 * 6.2832 + noise2(wx * 5, wz * 5, sd + 3) * 2.0);
          rel = -0.0012 * inside
            + 0.0017 * groove * inside * (1 - smoothstep(0.7, 0.95, rb))
            - 0.0022 * smoothstep(0.72, 0.98, rb) * inside
            + 0.0042 * amp * band * (0.3 + 0.9 * lipN) * sag
            + 0.002 * crumb * inside;
        } else {                                                    // scoop: blade lines in the floor, a cut wall, spoil behind and beside
          const stri = Math.sin(dv * bw / sp * 6.2832 + noise2(wx * 6, wz * 6, sd + 3) * 2.2);
          const spoil = 1 + 0.45 * clamp(-du, -1, 1);                // more of it on the side towards the digger
          rel = -0.0012 * inside
            + 0.0013 * amp * stri * inside * (1 - smoothstep(0.7, 0.95, rb))
            - 0.0048 * amp * smoothstep(0.66, 0.98, rb) * inside * sag
            - 0.0038 * amp * inside * smoothstep(0.35, 1.0, du) * (1 - 0.3 * settle)   // deeper at the leading edge
            + 0.0078 * amp * band * (0.35 + 1.1 * lipN * lipN) * spoil * sag
            + 0.0032 * amp * crumb * inside;
        }
        const o = (j * res + i) * 2;
        const old = (data[o] - R0) / k127;
        const nr = old + (rel - old) * W;
        data[o] = clamp(Math.round(R0 + nr * k127), 0, 255);
        const m = Math.round(255 * (1 - smoothstep(0.95, 1.3, rb)));
        if (m > data[o + 1]) data[o + 1] = m;
        n++;
      }
    }
    const d = this.dirty;
    this.dirty = d ? { i0: Math.min(d.i0, i0), i1: Math.max(d.i1, i1), j0: Math.min(d.j0, j0), j1: Math.max(d.j1, j1) } : { i0, i1, j0, j1 };
    const S = this.stats, ms = performance.now() - t0;
    if (again) S.restamps++; else S.stamps++;
    S.texels += n;
    S.stampMs += ms;
    S.maxStampMs = Math.max(S.maxStampMs, ms);
  }

  // ------------------------------------------------------------ upload (as TerrainView: idle set, sub-rectangle)

  flush(renderer) {
    if (!this.dirty && !this.full) return false;
    const S = this.stats, t0 = performance.now(), THREE = this.THREE, res = this.res, whole0 = this.full, dirty = this.dirty;
    const all = { i0: 0, i1: res - 1, j0: 0, j1: res - 1 };
    for (const set of this.sets) {
      if (whole0) set.full = true;
      else if (dirty) set.pending = set.pending ? { i0: Math.min(set.pending.i0, dirty.i0), i1: Math.max(set.pending.i1, dirty.i1), j0: Math.min(set.pending.j0, dirty.j0), j1: Math.max(set.pending.j1, dirty.j1) } : dirty;
    }
    const next = this.sets[1 - this.cur];
    let up = next.pending;
    if (next.full || !up || (up.i1 - up.i0 + 1) * (up.j1 - up.j0 + 1) > res * res * DIG_DETAIL.fullShare) up = next.full || up ? all : null;
    if (up) {
      if (up === all) { next.tex.needsUpdate = true; S.fullUploads++; }
      else {
        const src = (this._src = this._src || new THREE.Box2()), dst = (this._dst = this._dst || new THREE.Vector2());
        src.min.set(up.i0, up.j0); src.max.set(up.i1 + 1, up.j1 + 1); dst.set(up.i0, up.j0);
        renderer.copyTextureToTexture(next.stage, next.tex, src, dst);
        S.partial++;
      }
      next.pending = null;
      next.full = false;
    }
    if (!this._warm) { this._warm = true; for (const set of this.sets) renderer.initTexture(set.tex); }
    this.cur = 1 - this.cur;
    this.uniforms.tDDetail.value = this.sets[this.cur].tex;
    this.dirty = null;
    this.full = false;
    S.flushes++;
    const ms = performance.now() - t0;
    S.uploadMs += ms;
    S.maxFlushMs = Math.max(S.maxFlushMs, ms);
    return true;
  }

  /** tests / the dev tools: the relief (m) and footprint (0..1) at a world point (nearest texel) */
  sample(x, z) {
    const t = this.t, i = Math.floor((x - t.x0) / this.texel), j = Math.floor((z - t.z0) / this.texel);
    if (i < 0 || j < 0 || i >= this.res || j >= this.res) return { relief: 0, mask: 0 };
    const o = (j * this.res + i) * 2;
    return { relief: ((this.data[o] - R0) / (127 / this.range)), mask: this.data[o + 1] / 255 };
  }

  dispose() {
    for (const set of this.sets) { set.tex.dispose(); set.stage.dispose(); }
  }
}
