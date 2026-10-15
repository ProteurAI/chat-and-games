// GoldRush - Earth 2.0C: the boulder shapes.
//
// assets/rocks/rocks.glb (tools/goldrush/build_rock_assets.py): six real rock scans (Poly Haven, CC0), decimated to three
// levels of detail each - rock<N>_lod0 (~1600 triangles: the boulders you walk up to), _lod1 (~400: scenery at a distance,
// rubble) and _lod2 (~32: pebbles). Geometry only (positions, smooth normals): the game shades them itself
// (goldrush-rockmat.js: the Earth rock layer, the geology's tint, the contact with the ground). Each shape is centred on its
// bounding box, about 1.05 half extent wide and 0.5-0.7 high - the old icosahedron's size, so a gameplay radius r scales it.
//
// loadRockSet() resolves to null when the file cannot be loaded; every caller then keeps its procedural stand-in.

const URL_GLB = new URL("./assets/rocks/rocks.glb", import.meta.url).href;

export class RockSet {
  constructor(shapes) {
    this.shapes = shapes;                 // [{ lods: [BufferGeometry, ...] }]
    this.count = shapes.length;
  }

  /** the geometry of shape i (wrapped) at a level of detail 0..2 (the coarsest available when there are fewer) */
  geometry(i, lod = 0) {
    const s = this.shapes[((i % this.count) + this.count) % this.count];
    return s.lods[Math.min(lod, s.lods.length - 1)];
  }

  triangles(lod = 0) { return this.shapes.reduce((n, s) => n + s.lods[Math.min(lod, s.lods.length - 1)].index.count / 3, 0); }

  dispose() { for (const s of this.shapes) for (const g of s.lods) g.dispose(); }
}

export async function loadRockSet(THREE) {
  try {
    const { GLTFLoader } = await import("../../vendor/three/addons/loaders/GLTFLoader.js");
    const gltf = await new GLTFLoader().loadAsync(URL_GLB);
    gltf.scene.updateMatrixWorld(true);
    const by = new Map();
    gltf.scene.traverse((o) => {
      const m = /^rock(\d+)_lod(\d+)/.exec(o.name || "");
      if (!m || !o.geometry) return;
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal") g.deleteAttribute(k);
      if (!g.attributes.normal) g.computeVertexNormals();
      if (!g.index) return;
      g.computeBoundingBox();
      g.computeBoundingSphere();
      const n = +m[1], l = +m[2];
      if (!by.has(n)) by.set(n, []);
      by.get(n)[l] = g;
    });
    gltf.scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    const shapes = [...by.keys()].sort((a, b) => a - b).map((n) => ({ lods: by.get(n).filter(Boolean) })).filter((s) => s.lods.length);
    return shapes.length ? new RockSet(shapes) : null;
  } catch (e) {
    return null;
  }
}
