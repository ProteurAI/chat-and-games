// GoldRush - GeoTex (Visual Overhaul A / Earth B0): the claim's geology as a 3D texture for the renderer.
//
// What the ground IS at any point of the dig volume - the MaterialField's own answer (materialAt: dirt,
// compact, gravel, stone; goldrush-resources.js), sampled on a grid and stored one-hot (RGBA8: R dirt,
// G compact, B gravel, A stone). The earth shader (goldrush-earthmat.js) reads it at the visible surface
// point only - never through the ground (no X-ray) - so a vertical cut face shows its layers at 12.5 cm,
// not smeared over the 12.5 cm vertex grid, and a later GPU heightfield renderer finds the material
// identity here without the vertex attributes.
//
// Derived, reconstructable, never saved, never read back by the simulation: the MaterialField stays the
// truth. Built progressively (a time budget per frame) after the mine is loaded; the shader falls back to
// the per-vertex material until it is complete. Stone changes (a lens broken / cut through) re-sample
// their columns (refreshColumns, from the terrain's refresh).
//
// Grid: 0.25 m across, 0.125 m up, from the dig floor (SLICE_ORIGIN_Y) to just above the highest original
// surface; above a column's original surface nothing is sampled (deposits there are loose cover - the
// shader knows them from the terrain's state).

import { MAT } from "./goldrush-materials.js";

export const GEO = { dxz: 0.25, dy: 0.125, top: 0.15, budgetMs: 2 };      // (budget: ms per frame while it builds; LOW 1)

export class GeoTex {
  constructor(THREE, terrain, floorY) {
    this.THREE = THREE;
    this.t = terrain;
    const t = terrain;
    let maxBase = 0;
    for (let k = 0; k < t.base.length; k++) if (t.base[k] > maxBase) maxBase = t.base[k];
    this.nx = Math.round(t.size / GEO.dxz) + 1;
    this.nz = this.nx;
    this.y0 = floorY;
    this.ny = Math.ceil((maxBase + GEO.top - floorY) / GEO.dy) + 1;
    this.x0 = t.x0; this.z0 = t.z0;
    this.data = new Uint8Array(this.nx * this.ny * this.nz * 4);
    const tex = (this.texture = new THREE.Data3DTexture(this.data, this.nx, this.ny, this.nz));
    // (three's 3D texture axes: width = x, height = y, depth = z)
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;              // (uploaded empty in the warm pass: completing it later refills that texture, no new one mid-game)
    this.stoneSeen = new Float32Array(this.nx * this.nz).fill(NaN);   // the stone top each column was sampled with
    this.next = 0;                       // the next column to build
    this.ready = false;
    this.dirty = false;
    this.stats = { samples: 0, ms: 0, columns: this.nx * this.nz, bytes: this.data.length, dims: [this.nx, this.ny, this.nz] };
  }

  // where the shader finds it: uvw = (p - min) * inv
  get min() { return [this.x0 - GEO.dxz / 2, this.y0 - GEO.dy / 2, this.z0 - GEO.dxz / 2]; }
  get inv() { return [1 / (this.nx * GEO.dxz), 1 / (this.ny * GEO.dy), 1 / (this.nz * GEO.dxz)]; }

  _column(ci, cj) {
    const t = this.t, f = t.field, x = this.x0 + ci * GEO.dxz, z = this.z0 + cj * GEO.dxz;
    const ti = Math.min(t.vps - 1, Math.max(0, Math.round((x - t.x0) / t.cell))), tj = Math.min(t.vps - 1, Math.max(0, Math.round((z - t.z0) / t.cell)));
    const k = tj * t.vps + ti, top = t.base[k] + GEO.top, nxy = this.nx * this.ny;
    let n = 0;
    for (let yi = 0; yi < this.ny; yi++) {
      const y = this.y0 + yi * GEO.dy, o = (cj * nxy + yi * this.nx + ci) * 4;
      // above the original surface: cover (loose) - the shader decides; dirt is the neutral answer
      const m = y > top ? MAT.DIRT : f.materialAt(x, y, z, k);
      if (y <= top) n++;
      this.data[o] = m === MAT.DIRT ? 255 : 0;
      this.data[o + 1] = m === MAT.COMPACT ? 255 : 0;
      this.data[o + 2] = m === MAT.GRAVEL ? 255 : 0;
      this.data[o + 3] = m === MAT.STONE ? 255 : 0;
    }
    this.stoneSeen[cj * this.nx + ci] = t.stoneTop[k];
    return n;
  }

  /** build on within a time budget (ms); true once complete */
  step(budgetMs = GEO.budgetMs) {
    if (this.ready) return true;
    const t0 = performance.now(), total = this.nx * this.nz;
    while (this.next < total) {
      this.stats.samples += this._column(this.next % this.nx, Math.floor(this.next / this.nx));
      this.next++;
      if ((this.next & 7) === 0 && performance.now() - t0 > budgetMs) break;
    }
    this.stats.ms += performance.now() - t0;
    if (this.next >= total) { this.ready = true; this.texture.needsUpdate = true; this.stats.usPerSample = +(this.stats.ms / Math.max(1, this.stats.samples) * 1000).toFixed(3); }
    return this.ready;
  }

  /** the terrain refreshed vertices [gi0..gi1] x [gj0..gj1]: re-sample columns whose stone changed */
  refreshColumns(gi0, gi1, gj0, gj1) {
    const t = this.t, r = GEO.dxz / t.cell;
    const ci0 = Math.max(0, Math.floor(gi0 / r)), ci1 = Math.min(this.nx - 1, Math.ceil(gi1 / r));
    const cj0 = Math.max(0, Math.floor(gj0 / r)), cj1 = Math.min(this.nz - 1, Math.ceil(gj1 / r));
    let n = 0;
    for (let cj = cj0; cj <= cj1; cj++) for (let ci = ci0; ci <= ci1; ci++) {
      const c = cj * this.nx + ci;
      if (this.next <= c && !this.ready) continue;                 // not built yet: it will be sampled as it is
      const ti = Math.min(t.vps - 1, Math.round(ci * r)), tj = Math.min(t.vps - 1, Math.round(cj * r));
      const s = t.stoneTop[tj * t.vps + ti], seen = this.stoneSeen[c];
      if (s === seen || (Number.isNaN(seen) && Number.isNaN(s))) continue;
      this._column(ci, cj);
      n++;
    }
    if (n && this.ready) this.dirty = true;
    return n;
  }

  /** upload pending column changes (at most every interval, a full upload) */
  flush() {
    if (!this.dirty) return false;
    this.dirty = false;
    this.texture.needsUpdate = true;
    return true;
  }

  dispose() { this.texture.dispose(); }
}
