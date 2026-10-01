# GoldRush – assets and their origin

GoldRush ships **no third-party art, models, textures or sounds**. Everything
you see and hear is generated at runtime by the game's own code:

| What | Where it is made | Origin |
|---|---|---|
| Terrain, mound, materials (dirt, compact dirt, gravel, stone) | `goldrush-terrain.js`, `goldrush-resources.js` | procedural, own code |
| Soil / gravel / rock / wood detail textures, signs | `goldrush-world.js` (canvas drawing) | procedural, own code |
| Boulders, props, fence, sky, environment light | `goldrush-world.js` | procedural, own code |
| First-person work gloves and forearms | `goldrush-hand.js` (capsules, spheres, cylinders) | procedural, own code |
| Shovel (round-point blade with lift, D-grip, steel collar, rivets, worn edge, soil load) and pickaxe (oval handle, forged eye, curved point, adze) | `goldrush-toolmodels.js` (extruded outline, swept tubes along curves, cylinders; canvas-drawn wood grain and scratched steel) | procedural, own code |
| Boulders, their crack stages, rubble | `goldrush-rocks.js` (noise-displaced icosahedra, a cellular crack network per boulder in a shader) | procedural, own code |
| The camp's stations: Goldankauf (work table, canvas awning, brass balance scale, gold pan, cash box, ledger) and Ausrüstung (counter, tool rack with the shovel / pickaxe for sale), painted signs | `goldrush-stations.js` (boxes, lathes, a sagging plane; signs drawn on canvas in Georgia/serif) | procedural, own code |
| Tool upgrade looks (riveted blade rim, pale ash shaft, hardened point, heavier head) | `goldrush-toolmodels.js` | procedural, own code |
| Small loose pebbles on the pile, fresh-dirt look, terrain micro detail | `goldrush-world.js` (instanced icosahedra; value noise + a rotated second detail sample in the terrain shader) | procedural, own code |
| Gold flakes, tiny pieces, nuggets (6 nugget shapes) | `goldrush-loot.js` (noise-displaced spheres) | procedural, own code |
| Dust, clods, pebbles, stone chips, glints | `goldrush-vfx.js`, `goldrush-loot.js` | procedural, own code |
| All sounds (digging per material, stone, gold, pickup, shovel scoop and dump, pickaxe on soil and stone, cracking / breaking boulders, swing, tool switch, the scale, a sale, the supply counter, a purchase, "not enough cash") | `goldrush-audio.js` (WebAudio synthesis) | synthesised, own code - **provisional placeholders**: levels are measured (no clipping, nothing silent), but no person has judged them by ear yet |
| HUD icons (hand, shovel, pickaxe, pause, close, nugget) | inline SVG in `goldrush.js` / `goldrush-hud.js` | own drawings |

The only external code is three.js r176 (MIT), vendored in
`static/vendor/three/` (see its README for version, source and checksum).

If real recordings or models are added later, they must be CC0 or our own,
and are listed here with source and licence.

Tools are not modelled after any particular product or game: proportions
follow ordinary garden / construction tools (round-point shovel ~1.4 m,
pickaxe ~0.9 m handle), built from basic shapes in code.
