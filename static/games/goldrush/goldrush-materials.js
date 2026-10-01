// GoldRush - what the ground is made of: ONE table of materials that every
// tool reads. Hand, shovel, pickaxe (and machines later) only bring their
// own efficiency per material and their own bite (goldrush-tools.js) - the
// materials, their densities, hardness and feedback stay the same.

export const MAT = { DIRT: 0, COMPACT: 1, GRAVEL: 2, STONE: 3 };

// density: kg per m³ in place (loose dirt ~1.35 t, rock ~2.65 t)
// hardness: 1 (loose) .. 10 (solid rock); a tool can only work what its
//   own strength allows, its efficiency per material says how well
// dust / fragments: how much a hit throws up and what flies
// cycle: extra recover time of a hand stroke in this material (s)
export const MATERIALS = [
  {
    id: "dirt", index: MAT.DIRT, label: "Lockere Erde", hardness: 1, density: 1350,
    handEfficiency: 1.0, dustAmount: 1.0, fragmentType: "clod", fragmentCount: 2,
    colorVariation: 0.1, soundProfile: "dirt", recover: 0.14, haptic: 6,
    dustColor: [0.3, 0.18, 0.09], fragmentColor: [0.3, 0.2, 0.13],
  },
  {
    id: "compactDirt", index: MAT.COMPACT, label: "Feste Erde", hardness: 2.5, density: 1650,
    handEfficiency: 0.5, dustAmount: 0.6, fragmentType: "clod", fragmentCount: 2,
    colorVariation: 0.06, soundProfile: "compact", recover: 0.17, haptic: 9,
    dustColor: [0.26, 0.15, 0.08], fragmentColor: [0.24, 0.14, 0.08],
  },
  {
    id: "gravel", index: MAT.GRAVEL, label: "Kies", hardness: 3.5, density: 1800,
    handEfficiency: 0.38, dustAmount: 0.45, fragmentType: "pebble", fragmentCount: 4,
    colorVariation: 0.18, soundProfile: "gravel", recover: 0.19, haptic: 10,
    dustColor: [0.19, 0.16, 0.12], fragmentColor: [0.33, 0.31, 0.28],
  },
  {
    id: "stone", index: MAT.STONE, label: "Stein", hardness: 9, density: 2650,
    handEfficiency: 0, dustAmount: 0.25, fragmentType: "chip", fragmentCount: 2,
    colorVariation: 0.08, soundProfile: "stone", recover: 0.26, haptic: 22,
    dustColor: [0.21, 0.2, 0.18], fragmentColor: [0.36, 0.34, 0.31],
  },
];

export const materialById = (id) => MATERIALS.find((m) => m.id === id) || MATERIALS[0];

// Tools (what they do to which material, how fast, how they move) are
// defined in goldrush-tools.js - one definition per tool.
