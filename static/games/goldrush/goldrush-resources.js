// GoldRush - the material field: what the ground is made of at any point
// of the (original) mound volume. Pure function of the world seed and the
// terrain's ORIGINAL surface, so it never has to be saved and a dig can ask
// "what did I just remove?" instead of rolling loot out of thin air.
//
// Geology (deliberately simple, but spatial):
//   - topsoil / dirt everywhere, getting moister and more clay-like with depth
//   - stone: the rock outcrops of the mound plus a few buried stone lenses
//   - gold: a thin background everywhere, a richer "pay layer" near the base
//     of the pile (heavy gold settles low) and a handful of seeded pockets
//     inside the mound. Later prompts turn goldDensity into finds.

import { hash3, mulberry32, noise3 } from "./goldrush-noise.js";

export class MaterialField {
  constructor(seed, terrain) {
    this.seed = seed | 0;
    this.terrain = terrain;
    const rng = mulberry32(this.seed ^ 0x51f15e);
    const { x: cx, z: cz } = terrain.moundCenter;
    // gold pockets: ellipsoids inside the mound body, mostly low and deep
    this.pockets = [];
    for (let i = 0; i < 7; i++) {
      const a = rng() * Math.PI * 2, r = 1.5 + rng() * 6.5;
      this.pockets.push({
        x: cx + Math.cos(a) * r,
        z: cz + Math.sin(a) * r,
        y: 0.4 + rng() * rng() * 4.5,
        rx: 0.9 + rng() * 1.6, ry: 0.5 + rng() * 0.9, rz: 0.9 + rng() * 1.6,
        peak: 0.45 + rng() * 0.55,
      });
    }
    // buried stone lenses
    this.lenses = [];
    for (let i = 0; i < 9; i++) {
      const a = rng() * Math.PI * 2, r = rng() * 8;
      this.lenses.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r, y: 0.5 + rng() * 5, r: 0.6 + rng() * 1.1 });
    }
  }

  // x, y, z in world units; y is the absolute height of the sample point
  sample(x, y, z, out = {}) {
    const surface = this.terrain.getBaseHeightAt(x, z);
    const depth = Math.max(0, surface - y);
    const s = this.seed;

    // stone: outcrops (surface rock mask from the generator, fading with
    // depth) + buried lenses + a little fractured noise
    let stone = this.terrain.getRockMaskAt(x, z) * Math.max(0, 1 - depth * 0.6);
    for (const l of this.lenses) {
      const d = Math.hypot(x - l.x, (y - l.y) * 1.6, z - l.z) / l.r;
      if (d < 1) stone = Math.max(stone, (1 - d) * 1.6);
    }
    const crack = noise3(x * 0.9, y * 0.9, z * 0.9, s + 77);
    stone = Math.min(1, Math.max(0, stone + (crack > 0.55 ? (crack - 0.55) * 1.4 : 0)));

    // gold
    let gold = 0.015 + 0.03 * Math.min(1, depth / 3);
    const pay = Math.max(0, 1 - Math.abs(y - 0.6) / 1.1);            // pay layer at the base of the pile
    gold += pay * 0.12 * (0.6 + 0.4 * noise3(x * 0.45, 0, z * 0.45, s + 5));
    for (const p of this.pockets) {
      const dx = (x - p.x) / p.rx, dy = (y - p.y) / p.ry, dz = (z - p.z) / p.rz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1) gold += p.peak * (1 - d2) * (1 - d2);
    }
    const speck = noise3(x * 2.3, y * 2.3, z * 2.3, s + 13);       // nuggety, not smooth
    gold *= 0.55 + 0.45 * (speck * 0.5 + 0.5);
    gold *= 1 - stone * 0.6;                                          // less in solid rock

    out.depth = depth;
    out.stone = stone;
    out.dirt = 1 - stone;
    out.goldDensity = Math.min(1, Math.max(0, gold));
    out.rarity = hash3(Math.floor(x * 4), Math.floor(y * 4), Math.floor(z * 4), s + 991);
    return out;
  }
}
