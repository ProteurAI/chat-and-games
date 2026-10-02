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
| The wash place (wooden trough fed from the camp's water tank, tap, painted "WASCHPLATZ" sign), a galvanised bucket with bail and its load, the steel gold pan (riffles as upgrade), the shaker screen (classifier) over its concentrate tub | `goldrush-processmodels.js` (lathes, boxes, a swept bail; woven wire, wet soil and water ripples drawn on canvas) | procedural, own code |
| Material in bucket / pan / tub, muddy water, pebbles tossed out, gold showing at the bottom of the pan, fines falling through the screen, muddy drops over the pan's rim | `goldrush-processing.js`, `goldrush-hand.js` (fill discs, instanced pebbles and flakes, pooled drops; no fluid or granular simulation) | procedural, own code |
| Gold flakes, tiny pieces, nuggets (6 nugget shapes) | `goldrush-loot.js` (noise-displaced spheres) | procedural, own code |
| Dig effects per material and tool: dust puffs, crumbs, clods, rounded pebbles, flat stone chips, micro debris that lies a few seconds, the trickle after a steep cut; colours sampled from the terrain under the hit | `goldrush-vfx.js` (one pooled point cloud + one instanced faceted rock, per-instance shape scale; no physics engine) | procedural, own code |
| Glints | `goldrush-loot.js` | procedural, own code |
| Wheelbarrow (steel tray, wooden handles, spoked wheel with tyre, legs, its load of soil / gravel) | `goldrush-mechmodels.js` (boxes, cylinders, a torus tyre with spokes; the load a flattened half sphere in the material's colour, rising with the fill) | procedural, own code |
| Sluice (the delivered stack of boards and rolled mat, the sloped wooden box on legs with its riffle bars over a mat, the hopper with its fill, the pipe from the water tank, running water, gravel moving down the riffles, the heavy concentrate behind the bars, the outlet and its growing tailings heap, the concentrate tray) | `goldrush-mechmodels.js`, `goldrush-sluice.js` (boxes, cylinders, a scrolling canvas-drawn flow texture, instanced pebbles; the heap a cone that grows with the tailings) | procedural, own code |
| All sounds (digging per material, stone, gold, pickup, shovel scoop and dump, pickaxe on soil and stone, cracking / breaking boulders, swing, tool switch, the scale, a sale, the supply counter, a purchase, "not enough cash", water in the pan, the screen's rattle, a bucket set down; phase 6: hand / shovel / pickaxe per material (hand_dirt, hand_gravel, shovel_dirt, shovel_gravel, pickaxe_compact, pickaxe_stone), rock_break, material_slide, bucket_fill, wheelbarrow_dump, sluice_water (a quiet wash, repeated while you are near the running sluice), sluice_feed, sluice_cleanout) | `goldrush-audio.js` (WebAudio synthesis) | synthesised, own code - **provisional placeholders**: levels are measured (no clipping, nothing silent), but no person has judged them by ear yet |
| HUD / shop icons (hand, shovel, pickaxe, bucket, gold pan, classifier, wheelbarrow, sluice, pause, close, nugget, pouch) | inline SVG in `goldrush.js` / `goldrush-hud.js` | own drawings |

The only external code is three.js r176 (MIT), vendored in
`static/vendor/three/` (see its README for version, source and checksum).

If real recordings or models are added later, they must be CC0 or our own,
and are listed here with source and licence.

Tools are not modelled after any particular product or game: proportions
follow ordinary garden / construction tools (round-point shovel ~1.4 m,
pickaxe ~0.9 m handle), built from basic shapes in code.
