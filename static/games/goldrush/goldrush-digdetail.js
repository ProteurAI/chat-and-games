// GoldRush - Earth 2.0B / 2.0C: what a tool leaves in the ground, below the simulation's grid.
//
// The terrain's heights live on a 12.5 cm grid (the truth: integer qh, mass, gold). A shovel's scoop is a 1-2 cm dent
// over a few cells there - the grid cannot show a tool's edge, a lip, the blade's scrape marks. DigDetail is a derived,
// never-saved picture of exactly that, in a fine texture (~3 cm per texel):
//
//   R  relief: a height offset in metres around 0.5 (+-2 cm), the tool's imprint: floor scrape marks / finger grooves /
//      the pick's pit and cracks, the walls of the cut, a broken, irregular lip of spoil around it, crumbs that fell
//      back in. The Earth shader reads it as a normal / cavity change - the geometry, the shadows and the collision
//      are the simulation's heights alone, so nothing can float over the surface or clip through it.
//   G  footprint: where the tool just worked (1 inside, falling off through the lip) - a crisp "freshly cut" mask
//      instead of the grid's blurry one.
//
// Earth 2.0C: REGIONS. The detail is no longer one texture over the whole terrain. The world is cut into square tiles
// (6 m, 192 texels + a 2-texel apron), addressed by WORLD position; a tile gets a layer of a fixed POOL (a texture
// array) the first time something is stamped into it, and an indirection texture (tile -> layer) tells the shader where
// to look. The pool is the memory budget - independent of the world's size: a mountain 50 times as big needs the same
// pool, only the tiles near the work are alive (the least recently stamped one is recycled when the pool is full: an
// old imprint is lost, the ground itself is not). The apron holds the neighbouring tile's texels, so bilinear filtering
// and the shader's normal taps run across tile borders without a seam (a stamp near a border is written into both).
//
// A stamp is computed from the bite the terrain reports (terrain.lastBite: where, which way, how big, what tool) in the
// tool's own plane on the real surface (so it follows a slope), with a noise-broken outline, and blended into what was
// there (repeated digging overwrites the older imprint under the new footprint). Two later passes of the same stamp
// (settleAt) relax it: wall and lip sag a little, crumbs land in the floor - the short "settle" after a cut.
//
// Uploads: a stamp marks per-layer texel boxes; once per frame before drawing they go to the idle one of two pool sets as
// touched layers (as TerrainView does for the state textures: no driver stall). Nothing here is read back. After a
// reload the detail is empty (the shader's height-derived crest / cavity and the worked-ground state still show the cuts).

import { noise2, smoothstep } from "./goldrush-noise.js";

export const DIG_DETAIL = {
  tileSize: 6,                // m per tile
  texels: 192,                // texels per tile side (3.1 cm)
  apron: 2,                   // texels copied from the neighbours around each tile
  pool: 40,                   // layers: the whole pool is ~3 MB per set whatever the world's size
  window: 16,                 // tiles per side the indirection covers (96 m around the terrain)
  range: 0.02,                // m: the relief texture spans +-range around 0.5
  settleAt: [0.12, 0.5],      // s after the cut: the stamp is redone, more settled each time
  maxQueue: 12,
};

const R0 = 128;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export class DigDetail {
  constructor(THREE, t) {
    this.THREE = THREE;
    this.t = t;
    const D = DIG_DETAIL, S = (this.S = D.tileSize), N = (this.N = D.texels), A = (this.A = D.apron), M = (this.M = N + 2 * A), P = (this.P = D.pool), W = (this.W = D.window);
    this.texel = S / N;
    this.range = D.range;
    this.enabled = true;
    // the window of tiles around the terrain (world anchored: tile (tx, tz) covers [ox + tx S, ox + (tx + 1) S))
    this.ox = Math.round(t.center.x / S) * S - (W * S) / 2;
    this.oz = Math.round(t.center.z / S) * S - (W * S) / 2;
    this.layerSize = M * M * 2;
    this.data = new Uint8Array(P * this.layerSize);
    for (let i = 0; i < this.data.length; i += 2) this.data[i] = R0;
    this.index = new Uint8Array(W * W);                      // tile -> layer + 1 (0: no imprint there)
    this.tiles = new Map();                                  // tile key -> { tx, tz, layer, used }
    this.layerTile = new Array(P).fill(null);
    this.freeLayers = Array.from({ length: P }, (_, i) => P - 1 - i);
    this.tick = 0;
    this.queue = [];
    this.dirty = null;                                       // Map layer -> texel box changed since the last flush
    this.full = true;
    this.stats = { stamps: 0, restamps: 0, texels: 0, stampMs: 0, maxStampMs: 0, flushes: 0, partial: 0, fullUploads: 0, uploadMs: 0, maxFlushMs: 0, tiles: 0, recycled: 0 };
    const make = () => {
      const tex = new THREE.DataArrayTexture(this.data, M, M, P);
      tex.format = THREE.RGFormat;
      tex.type = THREE.UnsignedByteType;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.NoColorSpace;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      return { tex, pending: new Set(), full: true };
    };
    this.sets = [make(), make()];
    this.cur = 0;
    this.indexTex = new THREE.DataTexture(this.index, W, W, THREE.RedFormat, THREE.UnsignedByteType);
    this.indexTex.minFilter = this.indexTex.magFilter = THREE.NearestFilter;
    this.indexTex.generateMipmaps = false;
    this.indexTex.colorSpace = THREE.NoColorSpace;
    this.indexTex.unpackAlignment = 1;
    this.indexTex.needsUpdate = true;
    this.uniforms = {
      tDDetail: { value: this.sets[0].tex },
      tDIndex: { value: this.indexTex },
      uDRegion: { value: new THREE.Vector4(this.ox, this.oz, 1 / S, W) },          // window origin, 1 / tile size, tiles per side
      uDTile: { value: new THREE.Vector4(A, N, M, this.texel) },                     // apron, texels, stored size, texel (m)
      uDDetailK: { value: new THREE.Vector4(2 * this.range, this.texel, 2.2, 1) },   // relief span (m), texel (m), normal strength, on
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
    this.index.fill(0);
    this.tiles.clear();
    this.layerTile.fill(null);
    this.freeLayers = Array.from({ length: this.P }, (_, i) => this.P - 1 - i);
    this.queue.length = 0;
    this.full = true;
    this.dirty = null;
    this.indexTex.needsUpdate = true;
  }

  // ------------------------------------------------------------ tiles (world addressed, pooled)

  _tile(tx, tz, create) {
    const W = this.W;
    if (tx < 0 || tz < 0 || tx >= W || tz >= W) return null;
    const key = tz * W + tx;
    let e = this.tiles.get(key);
    if (e || !create) { if (e && create) e.used = this.tick; return e || null; }
    let layer = this.freeLayers.pop();
    if (layer === undefined) {                                // the pool is full: recycle the least recently stamped tile
      let old = null;
      for (const v of this.tiles.values()) if (!old || v.used < old.used) old = v;
      layer = old.layer;
      this.tiles.delete(old.tz * W + old.tx);
      this.index[old.tz * W + old.tx] = 0;
      this.stats.recycled++;
    }
    const d = this.data, o = layer * this.layerSize;
    for (let i = 0; i < this.layerSize; i += 2) { d[o + i] = R0; d[o + i + 1] = 0; }
    e = { tx, tz, layer, used: this.tick };
    this.tiles.set(key, e);
    this.layerTile[layer] = e;
    this.index[key] = layer + 1;
    this.indexTex.needsUpdate = true;
    this._mark(layer, 0, this.M - 1, 0, this.M - 1);
    this.stats.tiles = this.tiles.size;
    return e;
  }

  _mark(layer, i0, i1, j0, j1) {
    const m = this.dirty || (this.dirty = new Map()), d = m.get(layer);
    m.set(layer, d ? { i0: Math.min(d.i0, i0), i1: Math.max(d.i1, i1), j0: Math.min(d.j0, j0), j1: Math.max(d.j1, j1) } : { i0, i1, j0, j1 });
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
   * Everything is a function of (bite, settle, world position of the texel): the same seed gives the same marks every pass
   * and in every tile that holds the texel (its own area and the neighbours' aprons).
   */
  stamp(b, settle = 0, again = false) {
    const t0 = performance.now();
    this.tick++;
    const S = this.S, T = this.texel, A = this.A, M = this.M;
    const reach = Math.max(b.a, b.b) * 1.6 + 2 * T;
    const pad = A * T;
    const tx0 = Math.floor((b.x - reach - pad - this.ox) / S), tx1 = Math.floor((b.x + reach + pad - this.ox) / S);
    const tz0 = Math.floor((b.z - reach - pad - this.oz) / S), tz1 = Math.floor((b.z + reach + pad - this.oz) / S);
    let n = 0;
    for (let tz = tz0; tz <= tz1; tz++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const wx0 = this.ox + tx * S - pad, wz0 = this.oz + tz * S - pad;       // world corner of texel (0, 0) of this layer
        const i0 = Math.max(0, Math.floor((b.x - reach - wx0) / T)), i1 = Math.min(M - 1, Math.floor((b.x + reach - wx0) / T));
        const j0 = Math.max(0, Math.floor((b.z - reach - wz0) / T)), j1 = Math.min(M - 1, Math.floor((b.z + reach - wz0) / T));
        if (i0 > i1 || j0 > j1) continue;
        const e = this._tile(tx, tz, true);
        if (!e) continue;
        n += this._stampTile(e, wx0, wz0, i0, i1, j0, j1, b, settle);
      }
    }
    const St = this.stats, ms = performance.now() - t0;
    if (again) St.restamps++; else St.stamps++;
    St.texels += n;
    St.stampMs += ms;
    St.maxStampMs = Math.max(St.maxStampMs, ms);
  }

  _stampTile(e, wx0, wz0, i0, i1, j0, j1, b, settle) {
    const t = this.t, T = this.texel, M = this.M, data = this.data, range = this.range, base = e.layer * this.layerSize;
    const a = b.a, bw = b.b, sd = b.seed | 0;
    const type = b.type === "pick" ? 1 : b.type === "scrape" ? 2 : 0;
    const nx = b.nx, ny = b.ny, nz = b.nz, ux = b.ux, uy = b.uy, uz = b.uz;
    const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
    // size of the marks: a bigger tool, a bigger lip; a partial bite leaves a lighter mark
    const amp = clamp(Math.sqrt(Math.max(a, bw) / 0.2), 0.7, 2.2) * (0.45 + 0.55 * b.frac) * (type === 1 ? 1.7 : 1);
    const sp = clamp(bw * 0.075, 0.011, 0.03);                      // the blade's scrape-line spacing
    const wob = type === 1 ? 0.3 : type === 2 ? 0.2 : 0.16;         // how broken the outline is
    const k127 = 127 / range;
    let n = 0;
    for (let j = j0; j <= j1; j++) {
      const wz = wz0 + (j + 0.5) * T, pz = wz - b.z;
      for (let i = i0; i <= i1; i++) {
        const wx = wx0 + (i + 0.5) * T, px = wx - b.x;
        const py = t.getHeightAt(wx, wz) - b.y;
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
        const o = base + (j * M + i) * 2;
        const old = (data[o] - R0) / k127;
        const nr = old + (rel - old) * W;
        data[o] = clamp(Math.round(R0 + nr * k127), 0, 255);
        const m = Math.round(255 * (1 - smoothstep(0.95, 1.3, rb)));
        if (m > data[o + 1]) data[o + 1] = m;
        n++;
      }
    }
    this._mark(e.layer, i0, i1, j0, j1);
    return n;
  }

  // ------------------------------------------------------------ upload (as TerrainView: idle set, sub-rectangles)

  flush(renderer) {
    if (!this.dirty && !this.full) return false;
    const S = this.stats, t0 = performance.now(), whole0 = this.full, dirty = this.dirty;
    for (const set of this.sets) {
      if (whole0) set.full = true;
      else if (dirty) {
        for (const layer of dirty.keys()) set.pending.add(layer);
      }
    }
    const next = this.sets[1 - this.cur];
    if (next.full) { next.tex.needsUpdate = true; S.fullUploads++; next.full = false; next.pending.clear(); }
    else if (next.pending.size) {
      for (const layer of next.pending) next.tex.addLayerUpdate(layer);      // (only the touched layers are uploaded)
      next.tex.needsUpdate = true;
      S.partial += next.pending.size;
      next.pending.clear();
    }
    if (!this._warm) { this._warm = true; for (const set of this.sets) renderer.initTexture(set.tex); renderer.initTexture(this.indexTex); }
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

  /** tests / the dev tools: the relief (m) and footprint (0..1) at a world point (nearest texel; zero where no tile is alive) */
  sample(x, z) {
    const S = this.S, tx = Math.floor((x - this.ox) / S), tz = Math.floor((z - this.oz) / S), e = this._tile(tx, tz, false);
    if (!e) return { relief: 0, mask: 0 };
    const i = Math.floor((x - (this.ox + tx * S)) / this.texel) + this.A, j = Math.floor((z - (this.oz + tz * S)) / this.texel) + this.A;
    const o = e.layer * this.layerSize + (j * this.M + i) * 2;
    return { relief: (this.data[o] - R0) / (127 / this.range), mask: this.data[o + 1] / 255 };
  }

  dispose() {
    for (const set of this.sets) set.tex.dispose();
    this.indexTex.dispose();
  }
}
