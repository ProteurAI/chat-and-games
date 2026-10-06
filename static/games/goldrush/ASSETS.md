# GoldRush – assets and their origin

GoldRush ships **no third-party art, models, textures or sounds**. Everything
you see and hear is generated at runtime by the game's own code:

| What | Where it is made | Origin |
|---|---|---|
| Terrain, mound, materials (dirt, compact dirt, gravel, stone) | `goldrush-terrain.js`, `goldrush-resources.js` | procedural, own code |
| Soil / gravel / rock / wood detail textures, signs | `goldrush-world.js` (canvas drawing) | procedural, own code |
| Boulders, props, fence, sky, environment light; the water tank's weathered galvanised plates (riveted seams, rust streaks, phase 7B) | `goldrush-world.js` (canvas-drawn plate texture) | procedural, own code |
| First-person work gloves and arms (phase 8: forearm and upper arm at fixed lengths with an elbow, a work-jacket sleeve; the left glove a true mirror of the right) | `goldrush-hand.js` (capsules, spheres, cylinders) | procedural, own code |
| Shovel (round-point blade with lift, D-grip, steel collar, rivets, worn edge, soil load) and pickaxe (oval handle, forged eye, curved point, adze) | `goldrush-toolmodels.js` (extruded outline, swept tubes along curves, cylinders; canvas-drawn wood grain and scratched steel) | procedural, own code |
| Boulders, their crack stages, rubble | `goldrush-rocks.js` (noise-displaced icosahedra, a cellular crack network per boulder in a shader) | procedural, own code |
| The camp's stations (phase 8): the Goldankauf assay booth (plank walls, lean-to sheet-metal roof, counter, brass balance with pans and weights, shelves of sample jars / crucibles / bottles, lockbox, ledger, sample sack, lantern) and the open-front Ausrüstung supply shack (counter, tool rack with the shovel / pickaxe for sale, shelves, crates, spare handles, buckets, sacks), painted signs (GOLDANKAUF in gold letters on the roof board and the counter) | `goldrush-buildings.js`, `goldrush-stations.js` (boxes, lathes; corrugated roof and signs drawn on canvas in Georgia/serif) | procedural, own code |
| Tool upgrade looks (riveted blade rim, pale ash shaft, hardened point, heavier head) | `goldrush-toolmodels.js` | procedural, own code |
| Small loose pebbles on the pile, fresh-dirt look, terrain micro detail | `goldrush-world.js` (instanced icosahedra; value noise + a rotated second detail sample in the terrain shader) | procedural, own code |
| The wash place (wooden trough fed from the camp's water tank, tap, painted "WASCHPLATZ" sign), a galvanised bucket with bail and its load, the steel gold pan (riffles as upgrade), the shaker screen (classifier) over its concentrate tub | `goldrush-processmodels.js` (lathes, boxes, a swept bail; woven wire, wet soil and water ripples drawn on canvas) | procedural, own code |
| Material in bucket / pan / tub, muddy water, pebbles tossed out, gold showing at the bottom of the pan, fines falling through the screen, muddy drops over the pan's rim | `goldrush-processing.js`, `goldrush-hand.js` (fill discs, instanced pebbles and flakes, pooled drops; no fluid or granular simulation) | procedural, own code |
| Bulk hopper (galvanised funnel on a timber frame with braces, angle-steel rim, outlet with a red slide gate, the chute, a painted level gauge with a float pointer, the extension boards), its loading ramp and platform with rails, the control post (lever, lamp), the delivered pallet / crate | `goldrush-automodels.js` (boxes, a four-sided frustum, cylinders, spheres; the gauge drawn on canvas) | procedural, own code |
| Motorised feeder (springs, vibration motor) on the chute, material moving down it and falling into the sluice hopper | `goldrush-automodels.js`, `goldrush-automation.js` (instanced pebbles, a shaking tray) | procedural, own code |
| The bulk hopper's content: a mottled surface in the colours of the last loads, a low heap where they land | `goldrush-automation.js` (vertex colours on a grid, per-material shares) | procedural, own code |
| Sluice polish: white water at the riffles, droplets at the head and the outlet, black sand bands behind the riffle bars, fine gold specks (riffles and concentrate tray), the tailings fan (top under the outlet, wet / dry colours) | `goldrush-mechmodels.js`, `goldrush-sluice.js` (canvas foam / band textures, instanced specks and droplets, a polar-grid fan) | procedural, own code |
| Wet ground and small puddles at the wash place and the sluice | `goldrush-processing.js` (canvas-drawn blotch decals) | procedural, own code |
| Gold flakes, tiny pieces, nuggets (6 nugget shapes), sized by their value (phase 7A: dust / fine gold as a few tiny specks, a flake under a fingertip, only a EUR 1-4 nugget a real little nugget) | `goldrush-loot.js` (noise-displaced spheres, one instanced speck mesh; `FIND_LOOK`) | procedural, own code |
| The wooden wash bowl at the trough (phase 7A: turned wood darkened by muddy water, its load, muddy water, pebbles tossed out, gold showing) | `goldrush-processmodels.js` (a lathe; the pan's fill / water / pebble / flake parts) | procedural, own code |
| The shovel's load building up on the blade and sliding off it, crumbs / pebbles on top of it (phase 7A; phase 7B: a loose heaped layer that lags the swing and slides to the tip) | `goldrush-toolmodels.js`, `goldrush-hand.js`, `goldrush-heap.js` | procedural, own code |
| Loose material (phase 8: shaped by its container): a shallow layer on the shovel blade, a nearly level fill in the bucket, the load inside the barrow's tapered tray, a thin layer across the classifier's screen that thins and opens while shaken - coloured by what the batch holds, with crumbs / clods / pebbles / stones on it | `goldrush-heap.js` (`GridLoad`: a fixed grid with a shape function per container, vertex alpha for ragged edges, one instanced faceted lump mesh; fixed buffers) | procedural, own code |
| Black sand and gold in the pan (phase 8): an uneven dark drift in the low corner, gold in a few drifts on it | `goldrush-processmodels.js` (a noise-edged disc), `goldrush-processing.js` (instanced flakes, seeded per load) | procedural, own code |
| Embedded stone (phase 8): natural joints, cracks that grow with each pick hit, broken angular rubble | `goldrush-world.js` (terrain shader: cellular noise, crack lines from value noise), `goldrush-terrain.js` (fracture state per column) | procedural, own code |
| The mountain's geology (phase 8): gullies with gravel beds, spurs, redder bands, damp / dry patches, talus fans at the foot, rock outcrops, granular earth up close | `goldrush-world.js` (terrain shader; instanced pebbles and noise-displaced icosahedra) | procedural, own code |
| Mineralised streaks at the surface (rust stain, quartz veinlets, dark heavy-mineral streaks), crumb relief on worked ground and steep fresh cuts, ragged material borders, less texture tiling (phase 7A) | `goldrush-terrain.js` (vertex colours / weights), `goldrush-world.js` (terrain shader: value noise, a procedural bump term) | procedural, own code |
| The camp as a working place (phase 7A): worn paths and wheelbarrow ruts between its places, sacks, spare planks, a coiled hose, picked stones, an old wheel rim, duckboards and a drain at the wash place, a heap of washed sand | `goldrush-campdressing.js` (ribbons along polylines, boxes, tori, icosahedra; merged per material) | procedural, own code |
| Distant mountains with painted atmosphere (nearer ring warmer, far ring cooler and paler, the sun side lit) | `goldrush-world.js` (vertex colours on the ridge strips) | procedural, own code |
| Dig effects per material and tool: dust puffs, crumbs, clods, rounded pebbles, flat stone chips, micro debris that lies a few seconds, the trickle after a steep cut; colours sampled from the terrain under the hit | `goldrush-vfx.js` (one pooled point cloud + one instanced faceted rock, per-instance shape scale; no physics engine) | procedural, own code |
| Glints | `goldrush-loot.js` | procedural, own code |
| Wheelbarrow (open steel tray, wooden handles, spoked wheel with tyre, legs, its load of soil / gravel) | `goldrush-mechmodels.js` (boxes, cylinders, a torus tyre with spokes; phase 7B: the load a loose heap from `goldrush-heap.js` that grows with the fill) | procedural, own code |
| Sluice (the delivered stack of boards and rolled mat, the sloped wooden box on legs with its riffle bars over a mat, the hopper with its fill, the pipe from the water tank, running water, gravel moving down the riffles, the heavy concentrate behind the bars, the outlet and its growing tailings heap, the concentrate tray) | `goldrush-mechmodels.js`, `goldrush-sluice.js` (boxes, cylinders, a scrolling canvas-drawn flow texture, instanced pebbles; the heap a cone that grows with the tailings) | procedural, own code |
| All sounds (digging per material, stone, gold, pickup, shovel scoop and dump, pickaxe on soil and stone, cracking / breaking boulders, swing, tool switch, the scale, a sale, the supply counter, a purchase, "not enough cash", water in the pan, the screen's rattle, a bucket set down; phase 6: hand / shovel / pickaxe per material (hand_dirt, hand_gravel, shovel_dirt, shovel_gravel, pickaxe_compact, pickaxe_stone), rock_break, material_slide, bucket_fill, wheelbarrow_dump, sluice_water (a quiet wash, repeated while you are near the running sluice), sluice_feed, sluice_cleanout; phase 7: feeder_run (hum and gravel chatter of the vibrating tray), gate_open (a steel plate scraping open, material sliding); phase 8: barrow_take, barrow_roll (the wheel's roll and a creak now and then), barrow_bump, stone_scrape (the shovel skidding on rock), rock_chip, rock_fracture) | `goldrush-audio.js` (WebAudio synthesis) | synthesised, own code - **provisional placeholders**: levels are measured (no clipping, nothing silent), but no person has judged them by ear yet |
| Phase 9 - the mechanised claim: the mine intake hopper (square galvanised funnel on steel posts, yellow wear strips, level gauge, fill in the colours of its loads), the belt conveyor (stringers, idlers, a cleated chevron belt drawn on canvas and scrolled, pulleys, the drive, yellow legs, a head chute; the load as flat lumps coloured by each belt cell's batch), the generator by the intake, the trommel (a perforated drum - round holes punched into a canvas texture, alpha-tested - riding rings, trunnion rollers, lifter bars, the feed box, a spray manifold with droplets, the undersize curtain, the oversize chute and pile), the high-flow sluice (the phase-6 box widened), the spoil heap and its sign | `goldrush-plantmodels.js`, `goldrush-plant.js` (boxes, cylinders, a torus, a four-sided frustum, a noise-displaced lump, polar-grid heaps with vertex colours; canvas textures) | procedural, own code |
| The compact excavator (phase 9): rubber tracks (canvas lug texture, scrolled), sprockets, idlers, rollers, dozer blade, the house with counterweight, engine hood, exhaust, a "CLAIM 01" decal, the cab (posts, roof, glass, seat, control towers, work lights), the bent boom, the stick, hydraulic rams (barrel + chrome rod, laid out between their pins every frame), the bucket (shell, side plates, lip, teeth, its load) and the hydraulic breaker; the attachment stand | `goldrush-excavatormodel.js` (boxes, cylinders, a part-cylinder shell, circle sectors, cones; merged per joint) | procedural, own code - an authored `.glb` can replace it (below) |
| Prospecting (phase 9): numbered survey flags (stake + pennant, the numbers painted into one canvas atlas), the contract board in the camp (an order sheet drawn on canvas: title, numbers, a hatched progress bar, the unlocks) | `goldrush-prospect.js`, `goldrush-stations.js` | procedural, own code |
| Phase 9 sounds: conveyor_run (electric motor whine, rollers ticking), trommel_run / trommel_idle (stones tumbling in the drum, the spray), exc_engine (a small diesel's knock, harder under load), exc_tracks, exc_hydraulic (pump whine, oil hiss), exc_scoop (teeth into the ground, the load breaking off), exc_dump, exc_blow (the breaker on rock), exc_start / exc_stop | `goldrush-audio.js` (WebAudio synthesis) | synthesised, own code - provisional placeholders like the rest |
| HUD / shop icons (hand, shovel, pickaxe, bucket, gold pan, classifier, wheelbarrow, sluice, bulk hopper, feeder, pause, close, nugget, pouch; phase 8: the material row's bucket, wheelbarrow and concentrate; phase 9: prospecting kit, conveyor, trommel, excavator, the sample bags, the excavator's bucket) | inline SVG in `goldrush.js` / `goldrush-hud.js` | own drawings |

The only external code is three.js r176 (MIT), vendored in
`static/vendor/three/` (see its README for version, source and checksum) -
since phase 8 including its `GLTFLoader` and `BufferGeometryUtils` addons from
the same npm tarball (`static/vendor/three/addons/`, only the `'three'` import
path changed), loaded only when an authored model is asked for.

## Authored models (.glb / .gltf) - optional, phase 8

Every model in the game is built in code today. For later vehicles, machines,
stations, characters or hero props an authored model can take over one at a
time - the procedural one stays as the fallback:

1. Make or obtain the model: **our own or CC0 only**, with its source and
   licence written into the table above. Units metres, +Y up, the model's
   front towards -Z (as the procedural ones), origin on the ground at its
   footprint's centre. Prefer `.glb` (one file, textures embedded),
   sRGB base colour, metallic-roughness PBR, a few draws (merge meshes per
   material), textures 1024-2048 px.
2. Put it into `static/games/goldrush/models/` and add its file name to
   `models/manifest.json` (`"models": ["barrow.glb"]`). Only listed files are
   ever requested - a missing one costs no request and no console error.
3. In code: `const obj = await game.assets.modelOr(new URL("./models/barrow.glb",
   import.meta.url).href, () => buildProceduralBarrow())` - the authored model
   when it is there (a placeable clone, sharing geometry and materials with the
   cached one), otherwise the procedural build. `assets.model(url)` gives
   `{ scene, animations }` or `null`; everything loaded is disposed with the
   game (`AssetManager.dispose`).
4. Register what is always visible in the GPU warm pass (like the machines in
   `ProcessingSystem.warmMachines`) so it does not upload mid-game, and check
   the draw calls (`tests/e2e/goldrush_premium_e2e.py --only perf`).

### The excavator (phase 9) - an authored model behind its rig

`goldrush-excavatormodel.js` builds the compact excavator in code; an authored
`models/excavator.glb` (listed in `manifest.json`) replaces it when it has the
rig's nodes - **named exactly**: `tracks`, `house`, `cab`, `boom`, `stick`,
`tool` (optional: `bucket`, `breaker`, `eye` - the operator's eye point). The
game only sets rotations on them, so the pivots must sit where the procedural
model has them:

| Node | Parent | Pivot (in its parent) | The game sets |
|---|---|---|---|
| `tracks` | the model root | ground, footprint centre | nothing (the root gets position, heading, pitch / roll) |
| `house` | root | the slewing ring, 0.56 m up | `rotation.y` = swing |
| `cab` | `house` | anywhere (left side, -Z) | nothing |
| `boom` | `house` | boom foot `[0.66, 0.64, 0.1]` | `rotation.z` = boom angle (+ up from horizontal); the boom runs along its +X, 2.1 m to the stick pin |
| `stick` | `boom` | `[2.1, 0, 0]` | `rotation.z` (relative to the boom); 1.45 m along +X to the tool pin |
| `tool` | `stick` | `[1.45, 0, 0]` | `rotation.z`; the bucket's teeth at `[0.42, -0.34]`, its load at `[0.2, -0.2]` (tool frame) |

Note: unlike the other models the excavator's **front is +X** (its kinematics
run in the X-Y plane), the cab on the **-Z** side. Hydraulic rams are not
required (the procedural ones are laid out between pins each frame). The
bucket's load (`fill`, lumps) is added to `bucket` by the game. If a node is
missing the procedural model stays (no error).

If real recordings or models are added later, they must be CC0 or our own,
and are listed here with source and licence.

Tools are not modelled after any particular product or game: proportions
follow ordinary garden / construction tools (round-point shovel ~1.4 m,
pickaxe ~0.9 m handle), built from basic shapes in code.
