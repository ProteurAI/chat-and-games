# GoldRush – assets and their origin

GoldRush ships **no third-party art, models, textures or sounds**. Everything
you see and hear is generated at runtime by the game's own code:

| What | Where it is made | Origin |
|---|---|---|
| Terrain, mound, materials (dirt, compact dirt, gravel, stone) | `goldrush-terrain.js`, `goldrush-resources.js` | procedural, own code |
| Soil / gravel / rock / wood detail textures, signs | `goldrush-world.js` (canvas drawing) | procedural, own code |
| Boulders, props, fence, sky, environment light | `goldrush-world.js` | procedural, own code |
| First-person work gloves and forearms | `goldrush-hand.js` (capsules, spheres, cylinders) | procedural, own code |
| Gold flakes, tiny pieces, nuggets (6 nugget shapes) | `goldrush-loot.js` (noise-displaced spheres) | procedural, own code |
| Dust, clods, pebbles, stone chips, glints | `goldrush-vfx.js`, `goldrush-loot.js` | procedural, own code |
| All sounds (digging per material, stone, gold, pickup) | `goldrush-audio.js` (WebAudio synthesis) | synthesised, own code |
| HUD icons (hand, pause, close, nugget) | inline SVG in `goldrush.js` / `goldrush-hud.js` | own drawings |

The only external code is three.js r176 (MIT), vendored in
`static/vendor/three/` (see its README for version, source and checksum).

If real recordings or models are added later, they must be CC0 or our own,
and are listed here with source and licence.
