// GoldRush - Earth 2.0A: the terrain's GPU view.
//
// The simulation keeps its integer qh heights on the CPU (goldrush-terrain.js: raycast, collision, save, mass).
// This module only DRAWS them, derived and never read back:
//
//   HeightTex   R32F, one texel per simulation grid point - the terrain's own Float32Array `height`, shared, no copy.
//               The vertex shader reads the height (and the normal, by central differences) from it, so the render
//               meshes are flat, static grids: a dig changes texels, never geometry.
//   attribute textures   RGBA16F, one texel per grid point, the Earth B0 per-surface state that used to be vertex
//               attributes (aGeo, aEarth, aMat, colour). The fragment shader samples them bilinearly by world
//               position, so the material does not depend on the mesh's vertices any more (no LOD pop of the
//               material, no per-tile data).
//   tiles       the render grid is a set of tile meshes (30 x 30 cells today). Each tile has world-space positions
//               (watertight seams: the same bits on both sides of a border) and picks its index buffer by distance:
//               LOD 0 = every grid point, LOD 1 = every second one. A fine tile next to a coarse one drops the odd
//               vertices on that border (stitched fan blocks), so there are no cracks and no skirts. Hysteresis
//               avoids flicker between the two. Heights/normals come from the same texture at every LOD.
//
// A dig marks a dirty box; once per frame (before drawing) the box is packed and uploaded as a sub-rectangle
// (copyTextureToTexture) - or the whole texture when most of it changed. Shadows use the same displacement
// (customDepthMaterial), so the shadow map and the main pass can never disagree about the surface.
//
// Prepared for later: tiles are addressed by world position, the texture lookup is `(p - uTGrid.xy) * uTGrid.z`
// - a larger world replaces the single texture by per-region textures / a clipmap without touching the material.

const TEX_KEYS = ["height", "col", "geo", "earth", "mat"];

export const TERRAIN_VIEW = {
  lodNear: 21,          // m: a coarse tile goes back to full resolution closer than this ...
  lodFar: 25,           // ... and a full-resolution tile goes coarse beyond this (hysteresis)
  fullShare: 0.3,       // a dirty box covering more of the grid than this is uploaded whole
};

// ---------------------------------------------------------------------------------------------------- shader parts
// (used by the earth material's terrain variant and by the shadow depth material)

export const TERRAIN_GLSL = {
  vertexDecl: `
    uniform highp sampler2D tTHeight; uniform vec4 uTGrid;
    float grTH = 0.0;
    float grTFetch(ivec2 t) { int m = int(uTGrid.w) - 1; return texelFetch(tTHeight, clamp(t, ivec2(0), ivec2(m)), 0).r; }`,
  // replaces <beginnormal_vertex>: the height and the surface normal at this grid point
  normal: `
    ivec2 grTI = ivec2(floor((position.xz - uTGrid.xy) * uTGrid.z + 0.5));
    grTH = grTFetch(grTI);
    float grTHl = grTFetch(grTI + ivec2(-1, 0)), grTHr = grTFetch(grTI + ivec2(1, 0));
    float grTHd = grTFetch(grTI + ivec2(0, -1)), grTHu = grTFetch(grTI + ivec2(0, 1));
    vec3 objectNormal = normalize(vec3((grTHl - grTHr) * (0.5 * uTGrid.z), 1.0, (grTHd - grTHu) * (0.5 * uTGrid.z)));`,
  // after <begin_vertex>
  lift: `transformed.y = grTH;`,
  // the depth material has no normal: just the height
  depthLift: `transformed.y = grTFetch(ivec2(floor((position.xz - uTGrid.xy) * uTGrid.z + 0.5)));`,
  fragmentDecl: `
    uniform highp sampler2D tTCol; uniform highp sampler2D tTGeo; uniform highp sampler2D tTEarth; uniform highp sampler2D tTMat;
    uniform vec4 uTGrid;`,
  // the per-surface state at this fragment (what the vertex attributes vEGeo / vEEarth / vEMat / vColor were)
  fragmentState: `
    vec2 grTUv = ((vEWPos.xz - uTGrid.xy) * uTGrid.z + 0.5) / uTGrid.w;
    vec4 vEGeo = texture(tTGeo, grTUv), vEEarth = texture(tTEarth, grTUv), vEMat = texture(tTMat, grTUv);
    vec3 grVC = texture(tTCol, grTUv).rgb;`,
};

// ---------------------------------------------------------------------------------------------------- index buffers

/** LOD 1: every second grid point of a tile with `cells` cells per side */
export function indexCoarse(cells) {
  const vpc = cells + 1, idx = [];
  for (let j = 0; j + 2 < vpc; j += 2) {
    for (let i = 0; i + 2 < vpc; i += 2) {
      const a = j * vpc + i, b = (j + 2) * vpc + i, c = j * vpc + i + 2, d = (j + 2) * vpc + i + 2;
      idx.push(a, b, c, c, b, d);
    }
  }
  return new Uint32Array(idx);
}

/**
 * LOD 0 (every grid point). `mask` bits mark the borders whose neighbour is coarse: 1 = -x, 2 = +x, 4 = -z, 8 = +z.
 * There the odd border vertices are left out: the 2 x 2 cell blocks touching that border become a fan around the
 * block's centre that skips the border midpoint - the border then runs straight between the same even vertices as
 * the coarse neighbour's, so the two meet exactly (same heights, no T-junction gap).
 */
export function indexFine(cells, mask) {
  const vpc = cells + 1, idx = [], nb = cells / 2;
  for (let bj = 0; bj < nb; bj++) {
    for (let bi = 0; bi < nb; bi++) {
      const i = bi * 2, j = bj * 2;
      const skipX0 = bi === 0 && (mask & 1), skipX1 = bi === nb - 1 && (mask & 2);
      const skipZ0 = bj === 0 && (mask & 4), skipZ1 = bj === nb - 1 && (mask & 8);
      if (!(skipX0 || skipX1 || skipZ0 || skipZ1)) {
        for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
          const a = (j + dj) * vpc + i + di, b = (j + dj + 1) * vpc + i + di, c = a + 1, d = b + 1;
          idx.push(a, b, c, c, b, d);
        }
        continue;
      }
      // perimeter, turning from +z to +x (front-facing triangles); a coarse border has no midpoint
      const ring = [];
      if (!skipZ1) ring.push([1, 2]);
      ring.push([2, 2]);
      if (!skipX1) ring.push([2, 1]);
      ring.push([2, 0]);
      if (!skipZ0) ring.push([1, 0]);
      ring.push([0, 0]);
      if (!skipX0) ring.push([0, 1]);
      ring.push([0, 2]);
      const ctr = (j + 1) * vpc + i + 1;
      for (let r = 0; r < ring.length; r++) {
        const p = ring[r], q = ring[(r + 1) % ring.length];
        idx.push(ctr, (j + p[1]) * vpc + i + p[0], (j + q[1]) * vpc + i + q[0]);
      }
    }
  }
  return new Uint32Array(idx);
}

// ---------------------------------------------------------------------------------------------------- the view

export class TerrainView {
  /** t: the DiggableTerrain (reads t.height, t.vis, t.vps, t.cell, t.x0, t.z0, t.chunkCells); material: the tiles' */
  constructor(THREE, t, material) {
    this.THREE = THREE;
    this.t = t;
    const V = (this.V = t.vps), cc = (this.cells = t.chunkCells), per = (this.per = t.chunksPerSide);
    this.material = material;
    this.forceCoarse = false;
    this.detail = null;                    // Earth 2.0B: the dig detail texture (goldrush-digdetail.js) - uploaded along with the rest
    this.opts = { ...TERRAIN_VIEW, force: null };      // (per view: tests / the dev tools may force a LOD: 0 or 1)
    this.dirty = null;                     // the box changed since the last flush
    this.full = true;                      // everything changed (first upload, markAll)
    this.stats = { flushes: 0, partial: 0, fullUploads: 0, texels: 0, packMs: 0, uploadMs: 0, maxFlushMs: 0, lodSwitches: 0 };

    // --- textures: the height is the terrain's own array; the state textures are packed halves.
    // Two sets, used alternately: a dig is uploaded into the set the GPU is NOT reading from the frame in flight
    // (writing into a texture a queued draw still samples makes the driver stall - up to 100s of ms on an iGPU).
    const make = (data, fmt, type, linear) => {
      const tex = new THREE.DataTexture(data, V, V, fmt, type);
      tex.minFilter = tex.magFilter = linear ? THREE.LinearFilter : THREE.NearestFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.NoColorSpace;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      return tex;
    };
    // (the stage texture shares the CPU array: it is only the source of sub-rectangle copies, never uploaded itself)
    const mk = (data, fmt, type, linear) => ({ tex: make(data, fmt, type, linear), stage: new THREE.DataTexture(data, V, V, fmt, type) });
    const D = () => new Uint16Array(V * V * 4), RGBA = THREE.RGBAFormat, HF = THREE.HalfFloatType;
    this.data = { col: D(), geo: D(), earth: D(), mat: D() };           // (the packed CPU copies, shared by both sets)
    this.sets = [0, 1].map(() => ({
      height: mk(t.height, THREE.RedFormat, THREE.FloatType, false),
      col: mk(this.data.col, RGBA, HF, true), geo: mk(this.data.geo, RGBA, HF, true),
      earth: mk(this.data.earth, RGBA, HF, true), mat: mk(this.data.mat, RGBA, HF, true),
      pending: null, full: true,                                         // what this set still lacks
    }));
    for (const set of this.sets) for (const k of TEX_KEYS) { set[k].stage.unpackAlignment = 1; set[k].stage.colorSpace = THREE.NoColorSpace; }
    this.cur = 0;                                                        // the set the uniforms point at (drawn)
    const c = this.sets[0];
    this.uniforms = {
      tTHeight: { value: c.height.tex }, tTCol: { value: c.col.tex }, tTGeo: { value: c.geo.tex },
      tTEarth: { value: c.earth.tex }, tTMat: { value: c.mat.tex },
      uTGrid: { value: new THREE.Vector4(t.x0, t.z0, 1 / t.cell, V) },
    };

    // --- the shadow pass displaces exactly like the main pass
    this.depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    this.depthMaterial.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${TERRAIN_GLSL.vertexDecl}`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>\n${TERRAIN_GLSL.depthLift}`);
    };
    this.depthMaterial.customProgramCacheKey = () => "goldrush-terrain-depth-v1";

    // --- index buffers: shared by all tiles (LOD 1, and LOD 0 per coarse-border mask)
    const B = THREE.BufferAttribute;
    this.indexLod1 = new B(indexCoarse(cc), 1);
    this.indexLod0 = [];
    for (let m = 0; m < 16; m++) this.indexLod0.push(new B(indexFine(cc, m), 1));

    // --- tiles: flat, world-space grids (static); the height comes from the texture
    this.tiles = [];
    const vpc = cc + 1;
    for (let cz = 0; cz < per; cz++) {
      for (let cx = 0; cx < per; cx++) {
        const pos = new Float32Array(vpc * vpc * 3), i0 = cx * cc, j0 = cz * cc;
        for (let j = 0; j < vpc; j++) for (let i = 0; i < vpc; i++) {
          const v = j * vpc + i;
          pos[v * 3] = t.x0 + (i0 + i) * t.cell;
          pos[v * 3 + 2] = t.z0 + (j0 + j) * t.cell;
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        geom.setIndex(this.indexLod0[0]);
        const mesh = new THREE.Mesh(geom, material);
        mesh.customDepthMaterial = this.depthMaterial;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = `terrain-chunk-${cx}-${cz}`;
        mesh.onBeforeRender = (renderer) => { if (this.dirty || this.full || (this.detail && (this.detail.dirty || this.detail.full))) this.flush(renderer); };
        const tile = { cx, cz, i0, j0, mesh, geom, lod: 0, mask: 0, ccx: t.x0 + (i0 + cc / 2) * t.cell, ccz: t.z0 + (j0 + cc / 2) * t.cell, midY: 0 };
        mesh.userData.tile = tile;
        this.tiles.push(tile);
        t.group.add(mesh);
        this._bounds(tile);
      }
    }
  }

  // ------------------------------------------------------------ bounds (the heights are not in the geometry)

  _bounds(tile) {
    const t = this.t, V = this.V, cc = this.cells, H = t.height, THREE = this.THREE;
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j <= cc; j++) {
      const row = (tile.j0 + j) * V + tile.i0;
      for (let i = 0; i <= cc; i++) { const h = H[row + i]; if (h < lo) lo = h; if (h > hi) hi = h; }
    }
    const x0 = t.x0 + tile.i0 * t.cell, z0 = t.z0 + tile.j0 * t.cell, s = cc * t.cell;
    const box = tile.geom.boundingBox || (tile.geom.boundingBox = new THREE.Box3());
    box.min.set(x0, lo - 0.05, z0);
    box.max.set(x0 + s, hi + 0.05, z0 + s);
    tile.geom.boundingSphere = box.getBoundingSphere(tile.geom.boundingSphere || new THREE.Sphere());
    tile.midY = (lo + hi) * 0.5;
  }

  // ------------------------------------------------------------ dirty box + upload

  /** the terrain refreshed this vertex box (its state arrays / heights changed) -> number of tiles it touches */
  mark(i0, i1, j0, j1) {
    const V = this.V;
    i0 = Math.max(0, i0); j0 = Math.max(0, j0); i1 = Math.min(V - 1, i1); j1 = Math.min(V - 1, j1);
    if (i0 > i1 || j0 > j1) return 0;
    const d = this.dirty;
    this.dirty = d ? { i0: Math.min(d.i0, i0), i1: Math.max(d.i1, i1), j0: Math.min(d.j0, j0), j1: Math.max(d.j1, j1) } : { i0, i1, j0, j1 };
    const cc = this.cells;
    let n = 0;
    for (const tile of this.tiles) if (!(i1 < tile.i0 || i0 > tile.i0 + cc || j1 < tile.j0 || j0 > tile.j0 + cc)) n++;
    return n;
  }

  markAll() { this.full = true; this.dirty = null; }

  _pack(i0, i1, j0, j1) {
    const t = this.t, V = this.V, vis = t.vis, hf = this.THREE.DataUtils.toHalfFloat;
    const C = this.data.col, G = this.data.geo, E = this.data.earth, M = this.data.mat;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * V + i, o = k * 4, c = k * 3;
        C[o] = hf(vis.col[c]); C[o + 1] = hf(vis.col[c + 1]); C[o + 2] = hf(vis.col[c + 2]); C[o + 3] = 15360;       // (1.0)
        for (let q = 0; q < 4; q++) { G[o + q] = hf(vis.geo[o + q]); E[o + q] = hf(vis.earth[o + q]); M[o + q] = hf(vis.mat[o + q]); }
      }
    }
  }

  /** pack + upload what changed (once per frame, before drawing) into the idle texture set, then draw from it */
  flush(renderer) {
    const dd = this.detail, didDetail = dd && (dd.dirty || dd.full) ? dd.flush(renderer) : false;
    if (!this.dirty && !this.full) return didDetail;
    const V = this.V, S = this.stats, t0 = performance.now(), THREE = this.THREE, whole0 = this.full, dirty = this.dirty;
    let box = dirty;
    const all = { i0: 0, i1: V - 1, j0: 0, j1: V - 1 };
    if (whole0 || !box) box = all;
    this._pack(box.i0, box.i1, box.j0, box.j1);
    const t1 = performance.now();
    // both sets must end up with every change: the idle one gets this box plus what it missed before
    for (const set of this.sets) {
      if (whole0) set.full = true;
      else if (dirty) set.pending = set.pending ? { i0: Math.min(set.pending.i0, dirty.i0), i1: Math.max(set.pending.i1, dirty.i1), j0: Math.min(set.pending.j0, dirty.j0), j1: Math.max(set.pending.j1, dirty.j1) } : dirty;
    }
    const next = this.sets[1 - this.cur];
    let up = next.pending;
    if (next.full || !up || (up.i1 - up.i0 + 1) * (up.j1 - up.j0 + 1) > V * V * this.opts.fullShare) up = next.full || up ? all : null;
    if (up) {
      if (up === all) {
        for (const k of TEX_KEYS) next[k].tex.needsUpdate = true;
        S.fullUploads++;
      } else {
        const src = (this._region = this._region || new THREE.Box2()), dst = (this._dst = this._dst || new THREE.Vector2());
        src.min.set(up.i0, up.j0);
        src.max.set(up.i1 + 1, up.j1 + 1);
        dst.set(up.i0, up.j0);
        for (const k of TEX_KEYS) renderer.copyTextureToTexture(next[k].stage, next[k].tex, src, dst);
        S.partial++;
      }
      S.texels += (up.i1 - up.i0 + 1) * (up.j1 - up.j0 + 1);
      next.pending = null;
      next.full = false;
    }
    // the first flush creates the GPU side of both sets, so no texture is ever created while playing
    if (!this._warm) { this._warm = true; for (const set of this.sets) for (const k of TEX_KEYS) renderer.initTexture(set[k].tex); }
    this.cur = 1 - this.cur;
    const u = this.uniforms, c = this.sets[this.cur];
    u.tTHeight.value = c.height.tex; u.tTCol.value = c.col.tex; u.tTGeo.value = c.geo.tex; u.tTEarth.value = c.earth.tex; u.tTMat.value = c.mat.tex;
    // the tiles under the box: their culling bounds follow the new heights
    const cc = this.cells;
    for (const tile of this.tiles) if (!(box.i1 < tile.i0 || box.i0 > tile.i0 + cc || box.j1 < tile.j0 || box.j0 > tile.j0 + cc)) this._bounds(tile);
    this.dirty = null;
    this.full = false;
    S.flushes++;
    S.packMs += t1 - t0;
    S.uploadMs += performance.now() - t1;
    S.maxFlushMs = Math.max(S.maxFlushMs, performance.now() - t0);
    return true;
  }

  // ------------------------------------------------------------ LOD

  setForceCoarse(on) {
    on = !!on;
    if (on === this.forceCoarse) return;
    this.forceCoarse = on;
    this._applyLod(true);
  }

  /** per frame, before drawing: each tile's LOD from its distance to the camera (hysteresis), neighbours stitched */
  update(camera) {
    const e = camera.matrixWorld.elements, p = { x: e[12], y: e[13], z: e[14] };
    let changed = false;
    for (const tile of this.tiles) {
      const dx = tile.ccx - p.x, dz = tile.ccz - p.z, dy = tile.midY - p.y;
      const d = Math.sqrt(dx * dx + dz * dz + dy * dy) - this.cells * this.t.cell * 0.5;     // to the tile's near side
      const O = this.opts;
      const want = O.force === 0 || O.force === 1 ? O.force : tile.lod === 0 ? (d > O.lodFar ? 1 : 0) : (d < O.lodNear ? 0 : 1);
      if (want !== tile.lod) { tile.lod = want; changed = true; this.stats.lodSwitches++; }
    }
    if (changed) this._applyLod(false);
  }

  _applyLod(forced) {
    const per = this.per, tiles = this.tiles;
    const lodOf = (cx, cz) => (cx < 0 || cz < 0 || cx >= per || cz >= per) ? 0 : (this.forceCoarse ? 1 : tiles[cz * per + cx].lod);
    for (const tile of tiles) {
      const own = this.forceCoarse ? 1 : tile.lod;
      let mask = 0;
      if (own === 0) {
        if (lodOf(tile.cx - 1, tile.cz) === 1) mask |= 1;
        if (lodOf(tile.cx + 1, tile.cz) === 1) mask |= 2;
        if (lodOf(tile.cx, tile.cz - 1) === 1) mask |= 4;
        if (lodOf(tile.cx, tile.cz + 1) === 1) mask |= 8;
      }
      const index = own === 1 ? this.indexLod1 : this.indexLod0[mask];
      if (tile.geom.index !== index) tile.geom.setIndex(index);
      tile.mask = mask;
    }
  }

  triangles() {
    let n = 0;
    for (const tile of this.tiles) n += tile.geom.index.count / 3;
    return n;
  }

  lodCounts() {
    const c = [0, 0];
    for (const tile of this.tiles) c[this.forceCoarse ? 1 : tile.lod]++;
    return { lod0: c[0], lod1: c[1] };
  }

  dispose() {
    for (const tile of this.tiles) tile.geom.dispose();
    this.tiles = [];
    for (const set of this.sets) for (const k of TEX_KEYS) { set[k].tex.dispose(); set[k].stage.dispose(); }
    this.depthMaterial.dispose();
  }
}
