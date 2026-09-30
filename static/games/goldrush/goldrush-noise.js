// GoldRush - deterministic randomness. Everything that shapes the world
// (the mound, rock outcrops, gold deposits, prop placement) is derived from
// the world seed through these functions, so the same seed always rebuilds
// the same mine and a save only has to store what the player changed.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// integer lattice hash -> [0, 1)
export function hash3(ix, iy, iz, seed) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(iz | 0, 0x9e3779b1) ^ Math.imul(seed | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

// smooth value noise in [-1, 1]
export function noise2(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = fade(x - ix), fz = fade(z - iz);
  const a = hash3(ix, 0, iz, seed), b = hash3(ix + 1, 0, iz, seed);
  const c = hash3(ix, 0, iz + 1, seed), d = hash3(ix + 1, 0, iz + 1, seed);
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fz) * 2 - 1;
}

export function noise3(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = fade(x - ix), fy = fade(y - iy), fz = fade(z - iz);
  const v = (dx, dy, dz) => hash3(ix + dx, iy + dy, iz + dz, seed);
  const x00 = lerp(v(0, 0, 0), v(1, 0, 0), fx), x10 = lerp(v(0, 1, 0), v(1, 1, 0), fx);
  const x01 = lerp(v(0, 0, 1), v(1, 0, 1), fx), x11 = lerp(v(0, 1, 1), v(1, 1, 1), fx);
  return lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz) * 2 - 1;
}

export function fbm2(x, z, seed, octaves = 4, lacunarity = 2.03, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2(x * freq, z * freq, seed + o * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

// ridged variant: sharp crests, used for rock outcrops and distant ridges
export function ridged2(x, z, seed, octaves = 3) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(noise2(x * freq, z * freq, seed + o * 733));
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum / norm;
}

export function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
