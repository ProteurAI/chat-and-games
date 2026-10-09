// GoldRush - the running game: renderer, world, player, the tools in your
// hands, mining, boulders, finds, the gold pouch, the camp's stations
// (selling gold, buying supplies), processing at the wash place (bucket,
// classifier, gold pan), money, save, quality, lifecycle. Loaded lazily by goldrush.js
// (this is the module that pulls in three.js), created once per opened
// game and fully disposed on exit - no render loop, listener, timer, audio
// context or GL context survives it.

import * as THREE from "../../vendor/three/three.module.min.js";
import { AssetManager } from "./goldrush-assets.js";
import { GoldRushAudio } from "./goldrush-audio.js";
import { Economy, centsForMass, formatEuro, formatMass } from "./goldrush-economy.js";
import { FirstPersonHands } from "./goldrush-hand.js";
import { GoldRushHud } from "./goldrush-hud.js";
import { GoldRushInput } from "./goldrush-input.js";
import { LootSystem } from "./goldrush-loot.js";
import { MAT, MATERIALS } from "./goldrush-materials.js";
import { MiningSystem } from "./goldrush-mining.js";
import { QUALITY, QUALITY_LEVELS, applyRendererQuality, createRenderer, guessQuality, isMobileDevice } from "./goldrush-renderer.js";
import { FIND, FIND_IDS, GEOLOGY_VERSION, VOXEL_H, jackpotTier } from "./goldrush-resources.js";
import { RockSystem } from "./goldrush-rocks.js";
import { DEFAULT_SETTINGS, SAVE_VERSION } from "./goldrush-save.js";
import { SHOP_ITEMS, itemStatus, shopItem } from "./goldrush-shop.js";
import { STATIONS, Stations } from "./goldrush-stations.js";
import { ProcessingSystem } from "./goldrush-processing.js";
import { BULK_AT } from "./goldrush-automation.js";
import { BULK } from "./goldrush-automodels.js";
import { INTAKE, TROMMEL, OVERSIZE, SPOIL, TRAP, m3 } from "./goldrush-plant.js";
import { EXC_DEF, EXC_HOME, BUCKET_ML as EXC_BUCKET_ML } from "./goldrush-excavator.js";
import { BUCKET_ML as LDR_BUCKET_ML } from "./goldrush-loader.js";
import { m3Text } from "./goldrush-stockpile.js";
import { SLICE_ORIGIN_Y } from "./goldrush-terrain.js";
import { TOOL_DEFS, TOOL_ORDER, ToolController, cycleSeconds, effectiveDef, toolEfficiency } from "./goldrush-tools.js";
import { DigEffects } from "./goldrush-vfx.js";
import { clampLook } from "./goldrush-wheelbarrow-controller.js";
import { GoldRushWorld, SPAWN, SUN_DIR, MOUND_CENTER } from "./goldrush-world.js";
import { MINER } from "./goldrush-autominer.js";
import { AutoMinerRig } from "./goldrush-autominermodel.js";
import { MountainContract } from "./goldrush-contract.js";
import { BAGS, MAX_FLAGS, ProspectSystem, SAMPLE_DEF } from "./goldrush-prospect.js";

export const THREE_REVISION = THREE.REVISION;
export { SPAWN } from "./goldrush-world.js";
export { WASH } from "./goldrush-processing.js";
export { GRIPS, TOOL_KEYS } from "./goldrush-hand.js";
export { STATIONS } from "./goldrush-stations.js";
export { JUMP };

// the tool table as plain data (debug panel, tests, benchmark) - with the
// upgrades the player owns applied, and the shop price of each tool
export function TOOL_INFO(upgrades = []) {
  return TOOL_ORDER.map((id) => {
    const d = effectiveDef(id, upgrades), item = shopItem(id);
    return {
      id, label: d.label, tier: d.tier, key: d.key, defaultOwned: d.defaultOwned, reach: d.reach,
      materialEfficiency: [...d.materialEfficiency], loosenedBonus: [...d.loosenedBonus], hardnessLimit: d.hardnessLimit,
      kernel: { ...d.kernel }, massCapacity: d.massCapacity, rockDamage: d.rockDamage, price: item ? item.price : 0,
      upgrades: d.upgrades || [],
      cycle: [0, 1, 2, 3].map((m) => +cycleSeconds(d, m).toFixed(3)),
    };
  });
}

const EYE = 1.62;
const RADIUS = 0.33;
const WALK = 3.4;
const SPRINT = 5.6;
const SEE = 5;                                    // m: the crosshair reads the ground this far (reach is the tool's)
const FOV = 70;                                   // vertical, for the usual 16:9 / 16:10 screens
const HFOV_MIN = Math.tan((50 * Math.PI) / 360);  // phones upright: still enough view to the sides
const HFOV_MAX = Math.tan((106 * Math.PI) / 360); // phones sideways: no fish-eye
// Prompt 10 (human QA): the jump - about 38 cm, a quick dip before it (anticipation), your momentum carries
// on with little control in the air, a heavier fall, the landing dips the view and slows you; a moment's rest
// after it (no bunny hopping)
const JUMP = { h: 0.38, g: 9.81, fallK: 1.35, prep: 0.06, airCtl: 1.4, cool: 0.32, landKeep: 0.78, dipMax: 0.075, dipS: 0.24 };
JUMP.v0 = Math.sqrt(2 * JUMP.g * JUMP.h);
const WALK_SLOPE = Math.tan((38 * Math.PI) / 180);    // steeper: you scramble (slower) ...
const MAX_SLOPE = Math.tan((68 * Math.PI) / 180);     // ... steeper still: you can't (stone walls)
const AUTOSAVE_MS = 10000;
const MONITOR = { warmup: 3, window: 2, slowMs: 27, cooldown: 8 };
const GLINTS = { low: 24, medium: 48, high: 64 };
const INSPECT_S = 1.15;
// what a hit sounds like, per tool x material (dirt, compact, gravel, stone) - placeholders, goldrush-audio.js
const DIG_SOUND = {
  hand: ["hand_dirt", "hand_dirt", "hand_gravel", "stone"],
  shovel: ["shovel_dirt", "shovel_dirt", "shovel_gravel", "pickaxe_stone"],
  pickaxe: ["pickaxe_compact", "pickaxe_compact", "pickaxe_compact", "pickaxe_stone"],
};
// a very subtle camera impulse per tool x material (radians of pitch; off with reduced motion)
const KICK = { hand: [0.005, 0.007, 0.007, 0.01], shovel: [0.012, 0.015, 0.016, 0.02], pickaxe: [0.016, 0.02, 0.02, 0.026] };
// one short haptic pulse per hit (ms; phones with vibration switched on) - never a continuous buzz
const HAPTIC = { hand: [4, 6, 7, 12], shovel: [8, 10, 12, 16], pickaxe: [10, 14, 14, 20] };
const STONE_TIP = {
  hand: "Zu hart – fester Fels, mit bloßen Händen keine Chance. Die Spitzhacke bricht ihn auf.",
  shovel: "Zu hart – die Schaufel rutscht am Fels ab. Mit der Spitzhacke aufbrechen, dann schaufeln.",
  pickaxe: "",
};

const nextFrame = () => new Promise((resolve) => {
  let done = false;
  const go = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(go);
  setTimeout(go, 60);                       // hidden tabs don't fire rAF
});

// thrown by init() when the game was closed while it was still loading
export const ABORTED = new Error("goldrush: closed while loading");

export class GoldRushGame {
  /**
   * @param ui    DOM bridge from goldrush.js (root, canvas, controls, callbacks)
   * @param doc   the save document (new or loaded, already at the current version)
   */
  constructor(ui, doc, { touch, debug, settings }) {
    this.ui = ui;
    this.doc = doc;
    this.touch = !!touch;
    this.mobile = isMobileDevice() || this.touch;
    this.debug = !!debug;
    // device settings (goldrush-save.js) - not part of the mine
    this.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    this.economy = new Economy(doc.economy);
    // finds that were still on their way when the last session ended go
    // into the pouch now, in one go (they are in the save as pending)
    this.restoredPending = this.economy.collectAll().length;
    const tl = doc.tools || {};
    this.tools = new ToolController({ owned: Array.isArray(tl.owned) ? tl.owned : ["hand"], equipped: tl.equipped || "hand", dev: false, upgrades: Array.isArray(tl.upgrades) ? tl.upgrades : [] });
    this.station = null;                     // the station the player stands at (prompt)
    this.uiOpen = null;                      // "assay" | "supply" while its panel is open
    this._objT = 0;
    this._lastPhase = "";
    this.player = {
      x: doc.player.x, z: doc.player.z, yaw: doc.player.yaw, pitch: doc.player.pitch,
      y: 0, vx: 0, vz: 0, bob: 0, kick: 0,
      air: false, vy: 0, prep: 0, cool: 0, dip: 0, dipT: 1, dipA: 0, jumps: 0, lands: 0,   // Prompt 10: the jump
    };
    this.systemReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.reducedMotion = this.systemReducedMotion || !!this.settings.reducedMotion;
    this.paused = true;
    this.hidden = document.hidden;
    this.glLost = false;
    this.running = false;
    this.raf = 0;
    this.dirty = false;
    this.lastSave = performance.now();
    this.lastSaveBytes = 0;
    this.target = null;                      // what the crosshair is on (any distance up to SEE)
    this.aimState = "idle";
    this.frameMs = [];
    this.monitor = { t: 0, acc: 0, n: 0, cooldown: 0 };
    this.lastStroke = null;
    this.sunVisible = true;
    this._sunT = 0;
    this._off = [];
    this._v2 = new THREE.Vector2();
    this._hit = { x: 0, y: 0, z: 0, normal: null, distance: 0, diggable: true, boulder: null };
    this.ready = false;
    this.disposed = false;
    // developer tools: this mine was changed by a QA command (informative only)
    this.devModified = !!doc.devModified;
    this.devModifiedAt = Number.isFinite(doc.devModifiedAt) ? doc.devModifiedAt : null;
    this.devHook = null;                     // per-frame debug overlays (only while one is switched on)
  }

  get digs() { return this.economy.stats.successfulDigs; }
  get money() { return this.economy.moneyCents / 100; }

  on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._off.push(() => target.removeEventListener(type, fn, opts));
  }

  // ------------------------------------------------------------ build

  async init(progress) {
    const ui = this.ui;
    // every await is a point where the player may already have left: stop
    // there instead of building (and binding) a game nobody will dispose
    const step = async () => { await nextFrame(); if (this.disposed) throw ABORTED; };
    progress(0.42, "Grafik wird gestartet …");
    await step();
    const renderer = (this.renderer = createRenderer(THREE, ui.canvas, { antialias: this.settings.quality !== "low" }));
    this.gpu = guessQuality(renderer.getContext());
    this.autoLevel = this.gpu.level;

    this.assets = new AssetManager(THREE);
    const world = (this.world = new GoldRushWorld(THREE, { seed: this.doc.worldSeed, assets: this.assets }));
    progress(0.5, "Der Berg wird aufgeschüttet …");
    await step();
    world.buildTerrain();
    this.terrain = world.terrain;
    let terrainOk = false;
    if (this.doc.terrain) {
      try { terrainOk = this.terrain.deserialize(this.doc.terrain); } catch (e) { terrainOk = false; }
      if (!terrainOk) this.loadNotice = "Die Grabspuren im Spielstand passten nicht mehr – der Berg wurde neu aufgeschüttet.";
    }
    // phase 9: a mine dug in geology 1 now lies on geology 2 (goldrush-save.js) - said once
    const geo = this.doc.geology || (this.doc.geology = { version: GEOLOGY_VERSION });
    // GoldRush 9.1: a mine of geology 2 follows the recalibrated ground from here on (the untouched ground only -
    // what was dug stays dug, what sits in a container keeps its gold); no notice, nothing moved
    if (geo.version < GEOLOGY_VERSION && geo.version >= 2) geo.version = GEOLOGY_VERSION;
    if (geo.from && !geo.noted && !this.loadNotice) {
      this.loadNotice = "Der Claim wurde neu vermessen: alte Flussrinnen im Untergrund, der Lagerplatz am Camp ist aufgeschüttet. Was du schon abgebaut hast und alles in Behältern bleibt genau so.";
      geo.noted = true;
    }
    this.rocks = new RockSystem(THREE, world.scene, this.terrain, world, { seed: this.doc.worldSeed, rockTex: world.rockTex });
    this.mining = new MiningSystem(this.terrain, this.rocks);
    if (terrainOk) {
      try { this.mining.deserialize(this.doc.resources); } catch (e) { this.mining.deserialize(null); }
      try { this.rocks.deserialize(this.doc.rocks); } catch (e) { this.rocks.deserialize(null); }
    }
    progress(0.72, "Claim wird aufgebaut …");
    await step();
    world.buildScenery();
    this.rocks.attachColliders(world.colliders);
    const envMap = world.buildEnvironment(renderer);

    const camera = (this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 900));
    camera.rotation.order = "YXZ";
    this.effects = new DigEffects(THREE, world.scene, this.terrain);
    // fresh steep cuts trickle a moment later (visual only) - a quiet slide
    this.effects.onTrickle = (x, y, z) => {
      const c = this.camera.position, d = Math.hypot(x - c.x, y - c.y, z - c.z);
      if (d < 6) this.audio.play("material_slide", { pan: this._pan({ x, z }), dist: d, strength: 0.6 });
    };
    this.loot = new LootSystem(THREE, world.scene, this.terrain, { envMap });
    this.loot.onCollect = (item) => this._collected(item);
    this.loot.onNuggetArrive = (item) => this._nuggetInHand(item);
    this.hands = new FirstPersonHands(THREE, { envMap });
    this.hands.reducedMotion = this.reducedMotion;
    this.hands.dirt = Math.min(0.6, this.economy.stats.successfulDigs / 800);
    this.hands.update(0, this.tools.view(), { camera, sunDir: SUN_VEC, sunVisible: true, walk: 0, bob: 0 });
    this.audio = new GoldRushAudio();
    this.audio.setEnabled(this.settings.sound !== false);
    this.hud = new GoldRushHud(ui.root, ui.moneyEl, { reducedMotion: this.reducedMotion });
    this.hud.setMoney(this.economy.cashCents);
    this.hud.setPouch(this.economy.pouchCents);
    // the camp: gold buyer + supply counter (the rack shows what is still for sale)
    this.stations = new Stations(THREE, world.scene, world, { models: this.hands.models, goldMat: this.loot.goldMat });
    this.stations.setOwned(this.tools.owned);
    this.hands.models.applyUpgrades(this.tools.upgrades);
    // the wash place: bucket, classifier, gold pan (phase 5)
    this.processing = new ProcessingSystem(THREE, world.scene, world, this.doc.processing, {
      economy: this.economy, effects: this.effects, hands: this.hands, envMap, goldMat: this.loot.goldMat, upgrades: () => this.tools.upgrades, camera,
      quality: () => this.level, terrain: this.terrain, prospect: this.doc.prospect || null,
      mining: () => this.mining, rocks: () => this.rocks, assets: this.assets,
    });
    this.processing.excEvent = (kind, r) => this._excEvent(kind, r);
    this.processing.loaderEvent = (kind, r) => this._ldrEvent(kind, r);
    // phase 9: the mountain contract - measured on the ground itself (goldrush-contract.js), shown on the camp's board
    this.contract = new MountainContract(this.terrain, this.economy);
    this.stations.paintContract(this.contract.view());
    // phase 6: the sluice's water (near it), a barrow load landing in the hopper
    this.processing.onSound = (kind) => this.audio.play(kind, { dist: 2.5, strength: 0.7 });
    this.processing.onSoundAt = (kind, o) => this.audio.play(kind, o);          // Prompt 10: a machine's sound at its distance
    this.processing.onTrap = (finds) => this._trapped(finds);                    // Prompt 10: a big nugget in the trommel's trap
    this.processing.onDumped = (ml, where) => this._dumped(ml, where);
    const ring = new THREE.RingGeometry(0.88, 1, 48);
    this.reticle = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({
      color: 0xfff3d6, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, fog: false,
    }));
    this.reticle.visible = false;
    this.reticle.renderOrder = 3;
    world.scene.add(this.reticle);

    const p = this.player;
    p.y = world.groundAt(p.x, p.z) + EYE;
    this.applyQuality(this.settings.quality === "auto" ? this.autoLevel : this.settings.quality);
    this._bind();
    this.resize();
    this._updateCamera(0);
    progress(0.88, "Shader werden vorbereitet …");
    await step();
    this.loot.warmup(true);
    // every tool model once through the GPU (no hitch at the first switch)
    const tr = this.hands.toolRoot, vis = [this.hands.models.shovel.visible, this.hands.models.pickaxe.visible, tr.visible];
    this.hands.models.shovel.visible = this.hands.models.pickaxe.visible = tr.visible = true;
    this.hands.models.setLoad(1, 0, 0, 0, 2);            // the blade's load, every part of it once
    this.hands.models.bladeLoad.warm(true);
    const held = this.hands.right.held;
    held.geometry = this.loot.geos[5][0];
    held.material = this.loot.goldMat;
    held.visible = true;
    // ... and the whole claim, the camp behind you included: one frame without
    // frustum culling uploads every buffer and texture (no hitch at the first look round)
    const culled = [];
    const pr = this.processing, shown = [pr.restPan.visible, pr.cls.visible, pr.worldBucket.visible];
    pr.restPan.visible = pr.cls.visible = pr.worldBucket.visible = true;
    pr.warmup(true);
    pr.warmMachines(true);
    pr.warmPending = false;
    this.hands.scene.add(pr.handPan, pr.handBowl, pr.handBucket);
    world.scene.traverse((o) => { if (o.frustumCulled) { culled.push(o); o.frustumCulled = false; } });
    // (phase 8: the hands' scene too - the upper arms only come into view on the barrow's grips)
    const culledH = [];
    this.hands.scene.traverse((o) => { if (o.frustumCulled) { culledH.push(o); o.frustumCulled = false; } });
    renderer.compile(world.scene, camera);
    renderer.compile(this.hands.scene, this.hands.camera);
    if (this.rocks.tex) renderer.initTexture(this.rocks.tex);   // no upload hitch when the first boulder comes into view
    for (const t of pr.textures()) renderer.initTexture(t);   // the machines' shared maps (heap, load) before a heap first comes into view
    this.render();                                        // uploads the gold pieces' buffers too
    for (const o of culled) o.frustumCulled = true;
    renderer.autoClear = false;
    renderer.render(this.hands.scene, this.hands.camera);
    renderer.autoClear = true;
    for (const o of culledH) o.frustumCulled = true;
    this.hands.scene.remove(pr.handPan, pr.handBowl, pr.handBucket);
    pr.warmMachines(false);
    pr.warmup(false);
    [pr.restPan.visible, pr.cls.visible, pr.worldBucket.visible] = shown;
    held.visible = false;
    [this.hands.models.shovel.visible, this.hands.models.pickaxe.visible, tr.visible] = vis;
    this.hands.models.bladeLoad.warm(false);
    this.hands.models.setLoad(0);
    this.loot.warmup(false);
    progress(0.97, "Erster Blick in die Mine …");
    await step();
    if (this.processing.loader && this.processing.loader.inCab) this.enterCab(true, "loader");
    else if (this.processing.excavator && this.processing.excavator.inCab) this.enterCab(true);
    this.render();
    this.ready = true;
    progress(1, "Bereit");
  }

  _bind() {
    const ui = this.ui;
    this.input = new GoldRushInput({
      root: ui.root, canvas: ui.canvas, touch: this.touch, stickEl: ui.stick, knobEl: ui.knob, digBtn: ui.digBtn,
      onLockChange: (locked, failed) => this._lockChanged(locked, failed),
    });
    this.input.attach();
    const onResize = () => this.resize();
    this.on(window, "resize", onResize);
    if (window.visualViewport) this.on(window.visualViewport, "resize", onResize);
    this.on(window, "orientationchange", () => { this.input.releaseAll(); setTimeout(onResize, 250); });
    this.resizeObserver = new ResizeObserver(onResize);
    this.resizeObserver.observe(ui.root);
    this.on(document, "visibilitychange", () => {
      this.hidden = document.hidden;
      if (this.hidden) { this.flushLoot(); this.save("hidden"); this.input.releaseAll(); }
      this._syncLoop();
    });
    this.on(window, "pagehide", () => this.save("pagehide"));
    this.on(ui.canvas, "webglcontextlost", (e) => {
      e.preventDefault();
      this.glLost = true;
      this.save("context-lost");
      ui.showGlLost(true);
      this._syncLoop();
    });
    this.on(ui.canvas, "webglcontextrestored", () => {
      this.glLost = false;
      const sun = this.world.sun;
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      ui.showGlLost(false);
      this.render();
      this._syncLoop();
    });
    // sound may only start from a user gesture
    const unlock = () => { this.audio.unlock(); this.userActed = true; };
    this.on(ui.root, "pointerdown", unlock);
    this.on(window, "keydown", unlock);
    // tools: 1 / 2 / 3 (only what you own; a locked slot just says so);
    // E: use the station in front of you
    this.on(window, "keydown", (e) => {
      if (this.paused || this.uiOpen || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      // Prompt 10: placing the hillside miner - R turns it, E stops placing (the click sets it down)
      if (this.placing) {
        if (e.code === "KeyR") { e.preventDefault(); this.placing.rot = (this.placing.rot + Math.PI / 8) % (Math.PI * 2); this.placing.at = null; }
        else if (e.code === "KeyE") { e.preventDefault(); this._placeEnd(false); }
        return;
      }
      // phase 9: in the excavator's cab - E out, Q dump, T change the attachment (at its stand)
      if (this.cab) {
        if (e.code === "KeyE") { e.preventDefault(); this.exitCab(); }
        else if (e.code === "KeyQ") { e.preventDefault(); this._cabDump = true; }
        else if (e.code === "KeyT") { e.preventDefault(); this.cabSwap(); }
        return;
      }
      const i = ["Digit1", "Digit2", "Digit3"].indexOf(e.code);
      if (i >= 0 && !this.processing.work && !this.processing.carrying) this.selectTool(TOOL_ORDER[i]);
      if (e.code === "KeyE" && this.processing.work) { e.preventDefault(); this._workAction(); return; }
      if (e.code === "KeyE" && this.station) { e.preventDefault(); this.useStation(); }
      // phase 9: prospecting - a sample, a survey flag, the notebook
      if (e.code === "KeyR" && !this.processing.work) { e.preventDefault(); this.sample(); }
      if (e.code === "KeyF" && !this.processing.work) { e.preventDefault(); this.flagAtCrosshair(); }
      if (e.code === "KeyN" && !this.processing.work) { e.preventDefault(); this.openNotebook(); }
    });
    if (this.debug) {
      this.on(window, "keydown", (e) => {
        if (e.code === "KeyH") this.terrain.setHeatmap(!this.terrain.heatmap);
        if (e.code === "F3") { e.preventDefault(); ui.toggleDebug(); }
        // debug builds only: every tool usable (never saved as owned)
        if (e.code === "KeyU" && e.shiftKey) { this.setDevUnlock(!this.tools.dev); ui.notice(this.tools.dev ? "DEV: alle Werkzeuge freigeschaltet (nur Debug, wird nicht gespeichert)." : "DEV-Freischaltung aus."); }
      });
    }
  }

  // ------------------------------------------------------------ quality

  applyQuality(level) {
    if (!QUALITY_LEVELS.includes(level)) level = "medium";
    const base = QUALITY[level];
    const q = { ...base, shadowSize: this.mobile && base.shadowSizeMobile ? base.shadowSizeMobile : base.shadowSize };
    this.level = level;
    this.q = q;
    this.dpr = applyRendererQuality(THREE, this.renderer, this.world.scene, q, this.mobile);
    this.world.applyQuality(q);
    this.effects.setLimits(q.particles, q.fragments);
    this.loot.setLimits(GLINTS[level]);
    if (this.camera) this.resize();
    this.monitor = { t: 0, acc: 0, n: 0, cooldown: MONITOR.cooldown };
    this.ui.onQuality && this.ui.onQuality(this.settings.quality, level);
  }

  // in-game switch; the system preference always wins
  // ------------------------------------------------------------ tools

  // switch to a tool (keys 1-3, the toolbelt, the mobile tool sheet)
  selectTool(id) {
    if (!TOOL_DEFS[id]) return false;
    if (!this.tools.canUse(id)) {
      this.hud.tip(`locked-${id}`, `${TOOL_DEFS[id].label}: noch nicht freigeschaltet – im Camp bei „Ausrüstung“ erhältlich.`, 6);
      return false;
    }
    if (id === this.tools.equipped && !this.tools.target) return true;
    this.tools.equip(id);
    this.ui.onTool && this.ui.onTool(this.toolState());
    return true;
  }

  // for the toolbelt UI
  toolState() {
    return { equipped: this.tools.target || this.tools.equipped, owned: this.tools.ownedList(), dev: this.tools.dev, prospect: !!(this.processing && this.processing.prospect),
      order: TOOL_ORDER.map((id) => ({ id, label: TOOL_DEFS[id].label, key: TOOL_DEFS[id].key, owned: this.tools.owned.has(id), usable: this.tools.canUse(id) })) };
  }

  // debug / tests only: all tools usable without owning them (not saved as owned)
  setDevUnlock(on) {
    this.tools.dev = !!on;
    if (!on && !this.tools.canUse(this.tools.equipped)) this.tools.equip("hand");
    this.ui.onTool && this.ui.onTool(this.toolState());
  }

  // a tool really becomes yours (what a purchase does; tests use it directly)
  grantTool(id) {
    if (!TOOL_DEFS[id]) return false;
    this.tools.unlock(id);
    this.stations.setOwned(this.tools.owned);
    this.dirty = true;
    this.ui.onTool && this.ui.onTool(this.toolState());
    return true;
  }

  // ------------------------------------------------------------ the camp: selling + buying

  // open the panel of a station: game input off, mouse free
  openStation(id) {
    if (this.uiOpen || !(STATIONS.some((s) => s.id === id) || (id === "notebook" && this.processing.prospect))) return false;
    this.uiOpen = id;
    this.input.releaseAll();
    this.input.enabled = false;
    this.tools.cancel();
    this._sampleArm = false;
    this.hud.prompt(null);
    this.audio.play(id === "assay" ? "scale" : "shopOpen", { dist: 0.6, strength: 0.6 });
    this.ui.openStation(id, id === "assay" ? this.sellView() : id === "contract" ? this.contractView() : id === "notebook" ? this.processing.prospect.view() : this.shopView());
    if (!this.touch && this.input.locked) this.input.exitLock();          // the panel needs the mouse
    return true;
  }

  // E / the phone's button: whatever is in front of you
  useStation() {
    const s = this.station;
    if (!s) return false;
    if (s.kind === "cab") { this.exitCab(); return true; }        // the phone's AUSSTEIGEN (the desktop's E goes straight to exitCab)
    if (s.kind === "info") return false;                           // (Prompt 10: a pile's name and volume - nothing to do)
    if (s.kind === "place") { this._placeEnd(false); return true; }  // (Prompt 10: the phone's ABBRECHEN while placing the miner)
    if (s.kind !== "process") return this.openStation(s.id);
    if (s.disabled) { this.hud.tip(`proc-${s.id}`, s.action, 4); return false; }
    const r = this.processing.act(s.id, this.player);
    if (!r.ok) return false;
    if (r.kind === "enter") { this.enterCab(false, r.machine); return true; }
    if (r.kind === "place") { this._placeStart(r.what, r.moving); return true; }
    if (r.kind === "gate" || r.kind === "mode" || r.kind === "water") this.hands.reachOut();      // (Prompt 10: the hand to the lever / the valve)
    if (r.kind === "pick") this.audio.play("swap", { dist: 0.3 });
    else if (r.kind === "drop") {
      this.audio.play(s.id === "barrow-park" ? "shopOpen" : "bucket", { dist: 0.5, strength: 0.8 });
      // phase 7B: the first full bucket at the wash place, before any wash - where to wash it (once)
      const pr = this.processing;
      if (s.id === "bucket-wash" && pr.bucketMl > 0 && !pr.owned.has("pan") && !(pr.ledger.bowlLoads > 0) && !this._washTip) {
        this._washTip = true;
        this.hud.tip("wash-first", this.touch ? "Am Trog liegt die Waschschale – WASCHEN tippen." : "Am Trog liegt die Waschschale – dort [E]: Mit Waschschale waschen.", 6);
      }
    }
    else if (r.kind === "barrow") { this.audio.play("barrow_take", { dist: 0.3 }); this.player.pitch = Math.min(this.player.pitch, -0.62); this.hud.tip("barrow", this.touch ? "Mit dem Stick schieben und lenken · ABSTELLEN tippen zum Abstellen" : "W schieben · S bremsen · A / D lenken · [E] abstellen · am Trichter: [E] auskippen", 30); }
    else if (r.kind === "dump") this.audio.play("wheelbarrow_dump", { dist: 1.2 });
    else if (r.kind === "feed") { this.audio.play("sluice_feed", { dist: 0.8 }); this._fedEffect(s.id); }
    else if (r.kind === "build") {
      this.audio.play("purchase", { dist: 1 });
      const name = { bulk: "Vorratstrichter", feeder: "Dosierer", conveyor: "Aufgabetrichter und Förderband", trommel: "Trommelsieb", washplant: "Waschanlage" }[r.what] || "Waschrinne";
      this.hud.message(name, r.what === "feeder" ? "wird montiert …" : "wird aufgebaut …");
      if (r.what === "conveyor") this.hud.tip("conveyor-built", "Grab direkt in den Aufgabetrichter oder kipp die Schubkarre hinein – das Band bringt alles in den Vorratstrichter. Am Pfosten: AUTO läuft mit dem Wasser der Rinne.", 40);
      if (r.what === "trommel") this.hud.tip("trommel-built", "Die Trommel siebt alles, was das Band bringt: das Feine in den Vorratstrichter, Steine und Klumpen auf den Überkornhaufen am Zaun.", 40);
      if (r.what === "washplant") this.hud.tip("washplant-built", "Der Dosierer füllt jetzt den Verteilerkasten, drei Rinnen waschen zugleich. Reinigen (Wasser aus) bringt das Konzentrat in die Wanne an der Anlage – mit dem Eimer abholen, am Waschtrog auswaschen.", 40);
    }
    else if (r.kind === "conc") { this.audio.play("bucket_fill", { dist: 0.5 }); this.hud.message("Konzentrat im Eimer", `${(r.ml / 1000).toFixed(1).replace(".", ",")} l Schwerkonzentrat – am Waschtrog abstellen und auswaschen${r.left > 0 ? ` · ${(r.left / 1000).toFixed(1).replace(".", ",")} l noch in der Wanne` : ""}`); }
    else if (r.kind === "gate") { this.audio.play("gate_open", { dist: 0.8 }); this.hud.message("Schieber offen", "Es rutscht in den Trichter der Rinne – er schließt, wenn der voll ist."); }
    else if (r.kind === "mode" && r.what === "conveyor") {
      this.audio.play("swap", { dist: 0.4 });
      const t = { auto: "AUTO – läuft, solange das Wasser der Rinne an ist (mit der Trommel)", on: "AN – läuft, bis der Aufgabetrichter leer ist oder vorne nichts mehr hineingeht", stop: "AUS" };
      this.hud.message("Förderband", t[r.mode]);
    }
    else if (r.kind === "load") { this.audio.play("shovel_gravel", { dist: 0.8 }); this.hud.message("Überkorn aufgeladen", `${(r.ml / 1000).toFixed(0)} l in der Schubkarre`); }
    else if (r.kind === "trap") {
      this.hands.reachOut();
      this.hud.collected(r.got.cents, FIND.NUGGET);
      if (!this._bigFind(r.got.bestUg)) this.hud.nugget(r.got.cents, false);
      this.dirty = true;
    }
    else if (r.kind === "mode" && r.what === "autominer") {
      this.audio.play(r.on ? "miner_motor" : "miner_stop", { dist: 1.2, strength: 0.9 });
      this.hud.message("Abbaugerät", r.on ? "läuft – baut seinen Abschnitt ab und gibt aufs Band" : "aus – das Band hält, was darauf liegt");
      if (r.on) this.hud.tip("miner-on", "Das Abbaugerät arbeitet allein, solange GoldRush läuft – nicht in der Pause, nicht offline. Ist der Austrag voll, wartet es und läuft von selbst wieder an.", 30);
    }
    else if (r.kind === "minerStatus") this.hud.message("Abbaugerät", r.status === "rock" ? "Hartgestein – der Abbaukopf ist blockiert. Den Fels mit Spitzhacke oder Hammer brechen – oder das Gerät versetzen." : "Abbaubereich erschöpft – das Gerät versetzen.");
    else if (r.kind === "mode") {
      this.audio.play("swap", { dist: 0.4 });
      const t = { auto: "AUTO – läuft, solange das Wasser der Rinne an ist", on: "AN – läuft, bis der Vorrat leer oder der Rinnen-Trichter voll ist", stop: "AUS" };
      this.hud.message("Dosierer", t[r.mode]);
      if (r.mode !== "stop") this.hud.tip("feeder-on", "Der Dosierer füllt die Rinne nach, solange Vorrat da ist – du kannst derweil weitergraben.", 40);
    }
    else if (r.kind === "water") { this.audio.play("splash", { dist: 1, strength: 0.8 }); if (r.on) this.hud.tip("sluice-on", "Die Rinne läuft, solange Material im Trichter ist – du kannst derweil weiterarbeiten.", 40); }
    else if (r.kind === "work") this._enterWork();
    this._stationSig = null;
    this.dirty = true;
    return true;
  }

  // a barrow load went into a hopper (at the top of the tip): the sluice's, or the bulk hopper (phase 7)
  _dumped(ml, where) {
    const pr = this.processing, sl = pr.sluice, bk = pr.bulk;
    const l = (ml / 1000).toFixed(0), rest = pr.barrow && pr.barrow.batch.volumeMl > 0 ? " – der Rest bleibt in der Karre" : "";
    // phase 9: the intake at the mountain's foot, the spoil heap
    if (where === "intake" && pr.conveyor) {
      if (this.effects) this.effects.spill(INTAKE.x, INTAKE.rimY + 0.2, INTAKE.z, MATERIALS[0], 1.0);
      this.audio.play("sluice_feed", { dist: 1.2, strength: 0.9 });
      this.hud.message("Ausgekippt", `${l} l im Aufgabetrichter (${Math.round(pr.conveyor.volumeMl / 1000)} / ${Math.round(pr.conveyor.capacityMl / 1000)} l)${rest}`);
      this.dirty = true;
      return;
    }
    if (where === "spoil") {
      this.audio.play("wheelbarrow_dump", { dist: 1.2 });
      this.hud.message("Auf die Halde", `${l} l Abraum · Halde ${m3(pr.spoil ? pr.spoil.ml : 0)}`);
      this.dirty = true;
      return;
    }
    if (where === "bulk" && bk) {
      if (this.effects) this.effects.spill(bk.root.position.x + 0.35, BULK.outletY + 0.55, bk.root.position.z, MATERIALS[0], 1.0);
      this.audio.play("sluice_feed", { dist: 1.2, strength: 0.9 });
      this.hud.message("Ausgekippt", `${l} l im Vorratstrichter (${Math.round(bk.volumeMl / 1000)} / ${Math.round(bk.capacityMl / 1000)} l)${rest}`);
      this.dirty = true;
      return;
    }
    if (!sl) return;
    const x = sl.root.position.x - 0.27, z = sl.root.position.z;
    if (this.effects) this.effects.spill(x, 1.35, z, MATERIALS[0], 0.9);
    this.audio.play("sluice_feed", { dist: 1.2 });
    this.hud.message("Ausgekippt", `${l} l im Trichter${rest}`);
    this.dirty = true;
  }

  // a bucket emptied into the hopper / the barrow: a little spill over the edge
  _fedEffect(id) {
    const pr = this.processing;
    if (!this.effects) return;
    if (id === "bucket-hopper" && pr.sluice) this.effects.spill(pr.sluice.root.position.x - 0.27, 1.3, pr.sluice.root.position.z, MATERIALS[0], 0.5);
    else if (id === "bucket-bulk" && pr.bulk) this.effects.spill(pr.bulk.root.position.x + 0.3, BULK.outletY + 0.5, pr.bulk.root.position.z, MATERIALS[0], 0.5);
    else if (id === "bucket-barrow" && pr.barrow) { const c = pr.barrow.trayCenter(); this.effects.spill(c.x, this.world.groundAt(c.x, c.z) + 0.6, c.z, MATERIALS[0], 0.5); }
  }

  _enterWork() {
    this.tools.cancel();
    this.input.releaseAll();
    this.input.allLook = true;
    this.ui.root.classList.add("gr-working");
    this.audio.play(this.processing.work === "pan" ? "splash" : "rattle", { dist: 0.4, strength: 0.6 });
    this._stationSig = null;
  }

  _leaveWork() {
    this.processing.stopWork();
    this.input.allLook = false;
    this.input.discardLook(0.2);                 // no camera jump: what the mouse still moves is not a look
    this._workClick = true;                      // (a click still held does not dig right away)
    this._workQueued = false;                    // (an E / click pressed while it settled belonged to this work)
    this.ui.root.classList.remove("gr-working");
    this.hud.work(null);
    this._stationSig = null;
  }

  // E while working: take the gold out of the pan (when it shows), end a sieve / mat result, else stop for now
  _workAction() {
    const pr = this.processing;
    // the pan (the reference): the gold shows - E takes it at once; the sieve / the mat: their motion still runs
    // out - E counts as soon as the result shows (never swallowed)
    if (pr.work === "pan" && pr.panDone) { this._collectPan(); return; }
    if (pr.workPhase === "settle") { this._workQueued = true; return; }
    this._leaveWork();
  }

  _collectPan() {
    const r = this.processing.finishPan();
    this._leaveWork();
    if (!r.ok) return;
    if (r.sample) {
      // phase 9: a test pan - numbers, no verdict (the notebook keeps the line)
      const L = ProspectSystem.line(r.sample);
      this.hud.message(`Probe ${r.sample.n} · ${L.grade}`, `${L.gold} aus ${L.amount} · ${L.where}`);
      if (r.cents > 0) this.hud.collected(r.cents, FIND.FINE);
      if (!this._bigFind(r.bestUg)) this.audio.play(r.pieces ? "tiny" : "flake", { dist: 0.3, strength: 0.6 });
      this.dirty = true;
      this.save("pan");
      return;
    }
    if (r.cents > 0) {
      this.hud.collected(r.cents, FIND.FINE);
      if (!this._bigFind(r.bestUg)) {
        this.hud.message("Gold gewaschen", `${formatMass(r.ug)} · ≈ ${formatEuro(r.cents)}${r.pieces ? ` · ${r.pieces} ${r.pieces === 1 ? "Stück" : "Stücke"}` : ""}`);
        this.audio.play(r.pieces ? "tiny" : "flake", { dist: 0.3 });
      }
    } else this.hud.tip("pan-empty", `Diesmal blieb kein Gold in der ${r.tool === "bowl" ? "Schale" : "Pfanne"}.`, 3);
    // the first wash with the wooden bowl: what a gold pan would do better (once)
    if (r.tool === "bowl" && !this._bowlTip) { this._bowlTip = true; this.hud.tip("bowl-first", "Mit einer Goldpfanne (Ausrüstung) bleibt deutlich mehr Feingold liegen – und es geht schneller.", 6); }
    this.dirty = true;
    this.save("pan");
  }

  // close it again; resume = the close came from a click (may take the mouse back)
  closeStation(resume = true) {
    if (!this.uiOpen) return false;
    this.uiOpen = null;
    this.input.enabled = true;
    this.input.releaseAll();
    if (this._afterClose) { const f = this._afterClose; this._afterClose = null; f(); }
    if (!this.touch) {
      if (resume) this.input.requestLock();
      else { this.setPaused(true); this.ui.showPauseOverlay(true); }
    }
    return true;
  }

  sellView() {
    const e = this.economy;
    return { classes: e.pouchView(), ug: e.pouchUg, cents: e.pouchCents, count: e.pouchCount, cash: e.cashCents, first: !e.flags.firstSaleSeen };
  }

  // phase 9: the contract board's panel (and the pause card's line)
  contractView() { return this.contract.view(); }

  // [N] the prospecting notebook (a panel like the stations')
  openNotebook() {
    if (!this.processing.prospect) { this.hud.tip("no-kit", "Ein Notizbuch gehört zum Probenset (Ausrüstung).", 6); return false; }
    return this.openStation("notebook");
  }

  /**
   * [R] a test sample (phase 9): the next stroke of the hand / the shovel takes a small, real sample
   * at the crosshair into a bag (goldrush-prospect.js) instead of digging normally.
   */
  sample() {
    const pr = this.processing, pg = pr.prospect;
    if (!pg) { this.hud.tip("no-kit", "Für Proben brauchst du das Probenset (im Camp bei „Ausrüstung“).", 6); return false; }
    if (pr.carrying || pr.pushing || pr.work || this.uiOpen) return false;
    if (pg.full) { this.hud.tip("bags-full", `Alle ${BAGS} Probenbeutel sind voll – am Waschtrog auswaschen.`, 5); return false; }
    const tool = this.tools.target || this.tools.equipped;
    if (tool === "pickaxe") { this.hud.tip("sample-tool", "Proben nimmst du mit der Hand oder der Schaufel ([1] / [2]).", 5); return false; }
    this._aim();
    if (!this.target || this.target.distance > SAMPLE_DEF.reach) { this.hud.tip("sample-far", "Zum Probennehmen auf den Boden in Reichweite zielen.", 4); return false; }
    this._sampleArm = true;
    return true;
  }

  // the stroke reaches the ground with a sample armed: the sample transaction (a small real dig into a bag)
  _sampleContact() {
    this._aim();
    const hit = this.target, pg = this.processing.prospect;
    if (!hit || !pg || pg.full) { this.tools.react("air"); this.hands.contact("air"); return; }
    const r = this.mining.action(hit, SAMPLE_DEF, this.player, this.camera.position);
    this.economy.recordAction(r, "sample");
    const pan = this._pan(hit), dist = hit.distance;
    if (!r.ok || r.blocked || r.kind !== "dig") {
      const bm = hit.boulder != null ? MAT.STONE : r.material;
      this.tools.react("blocked", bm);
      this.hands.contact("blocked", bm);
      this.audio.play("stone", { pan, dist, strength: 0.6 });
      this.hud.tip("sample-hard", bm === MAT.STONE ? "Fester Fels – hier lässt sich keine Probe nehmen." : "Zu hart für die Kelle – erst mit der Spitzhacke lockern.", 5);
      this.lastStroke = { tool: "sample", kind: "blocked", material: bm, massKg: 0, finds: 0, cents: 0 };
      return;
    }
    const t = pg.take(r, hit, this.terrain.getBaseHeightAt(hit.x, hit.z), this.economy.stats.playTimeMs);
    this.tools.react("ok", r.material);
    this.hands.contact("ok", r.material, r.removedMassKg);
    this.effects.impact(hit, r.material, this.tools.def.id, this._toolDir(), 0.45);
    this.audio.play("bucket_fill", { pan, dist, strength: 0.45 });
    if (t.ok) this.hud.message(`Probe ${t.bag.n} im Beutel`, `${(t.bag.batch.volumeMl / 1000).toFixed(2).replace(".", ",")} l · ${t.bag.place} · Beutel ${pg.count} / ${BAGS} · [F] hier: Fähnchen ${t.bag.n}`);
    if (t.ok && pg.stats.samples === 1) this.hud.tip("sample-first", "Am Waschtrog [E]: die Probe schnell auswaschen – das Ergebnis steht dann im Notizbuch [N].", 8);
    this.lastStroke = { tool: "sample", kind: "dig", material: r.material, massKg: +r.removedMassKg.toFixed(4), finds: 0, cents: 0, sample: t.ok ? t.bag.n : 0 };
    this.dirty = true;
  }

  // tests / benchmark: the sample transaction at the crosshair now (no animation)
  sampleNow() {
    const pg = this.processing.prospect;
    if (!pg || pg.full) return null;
    this._aim();
    const hit = this.target;
    if (!hit || hit.distance > SAMPLE_DEF.reach) return null;
    const r = this.mining.action(hit, SAMPLE_DEF, this.player, this.camera.position);
    this.economy.recordAction(r, "sample");
    if (!r.ok || r.blocked || r.kind !== "dig") return { ok: false, blocked: true, material: r.material };
    const t = pg.take(r, hit, this.terrain.getBaseHeightAt(hit.x, hit.z), this.economy.stats.playTimeMs);
    this.dirty = true;
    const b = t.ok ? t.bag : null;
    return b ? { ok: true, n: b.n, ml: b.batch.volumeMl, g: b.batch.massG, ug: b.batch.goldUg, place: b.place, flag: b.flag, depth: b.depth, mat: b.mat, x: b.x, z: b.z } : { ok: false };
  }

  /** [F] a numbered survey flag at the ground under the crosshair - or out again at one */
  flagAtCrosshair() {
    const pg = this.processing.prospect;
    if (!pg) { this.hud.tip("no-kit", "Fähnchen gehören zum Probenset (im Camp bei „Ausrüstung“).", 6); return null; }
    if (this.uiOpen || this.processing.work) return null;
    this._aim();
    let h = this.target || this.farTarget;
    if (!h) {
      const p = this.player, c = this.camera.position, cp = Math.cos(p.pitch);
      h = this.terrain.raycast(c.x, c.y, c.z, -Math.sin(p.yaw) * cp, Math.sin(p.pitch), -Math.cos(p.yaw) * cp, 9);
    }
    if (!h || h.boulder != null) { this.hud.tip("flag-none", "Zum Abstecken auf den Boden zielen.", 4); return null; }
    const r = pg.toggleFlag(h.x, h.z);
    if (r.kind === "full") this.hud.tip("flags-full", `Alle ${MAX_FLAGS} Fähnchen stecken schon – [F] an einem Fähnchen zieht es wieder heraus, im Notizbuch alle einsammeln.`, 5);
    else if (r.kind === "set") this.hud.message(`Fähnchen ${r.label} gesteckt`, r.flag === "sample" ? `Markiert die Stelle von Probe ${r.n}.` : "Freies Fähnchen (keine Probe hier) – zum Abstecken.");
    else this.hud.message(`Fähnchen ${r.label} gezogen`, `${pg.flags.length} / ${MAX_FLAGS} stecken`);
    if (r.kind !== "full") this.audio.play("swap", { dist: 0.6, strength: 0.5 });
    this.dirty = true;
    return r;
  }

  // GoldRush 9.1 - the notebook's actions: every flag out of the ground (the notebook stays) ...
  collectFlags() {
    const pg = this.processing.prospect;
    if (!pg) return null;
    const n = pg.collectFlags();
    if (n) this.audio.play("swap", { dist: 0.6, strength: 0.5 });
    this.dirty = true;
    this.save("prospect");
    return { ok: true, collected: n };
  }

  // ... and the whole prospecting record anew: notebook, numbering, flags (the next sample is #1). The ground
  // the samples used stays used, unwashed bags keep their material (goldrush-prospect.js reset)
  resetProspect() {
    const pg = this.processing.prospect;
    if (!pg) return null;
    const r = pg.reset(this.processing.pan.sample || null);
    this.dirty = true;
    this.save("prospect");
    return { ok: true, ...r };
  }

  shopView() {
    if (this.contract) this.contract.refresh();
    const e = this.economy, state = { owned: this.tools.owned, upgrades: this.tools.upgrades, equipment: this.processing.owned, hardSeen: e.flags.hardSeen, cashCents: e.cashCents, mountainPct: this.contract ? this.contract.pct : 0 };
    return {
      cash: e.cashCents, pouch: e.pouchCents,
      items: SHOP_ITEMS.map((it) => ({ id: it.id, kind: it.kind, tool: it.tool, label: it.label, text: it.text, price: it.price, ...itemStatus(it, state) })),
    };
  }

  /**
   * SELL ALL at the assay station - one transaction (economy.sell): the
   * pouch is emptied and the cash booked in the same step; what follows
   * (scale, counting) only shows it. A second call finds an empty pouch.
   */
  sell() {
    const r = this.economy.sell();
    if (!r.ok) return r;
    this.stations.weigh(r.ug);
    this.audio.play("sell", { dist: 0.5 });
    this.hud.setPouch(0);
    this.hud.cashTo(this.economy.cashCents, 0.9);
    if (r.first) this._afterClose = () => this.hud.message("Gold verkauft", `Neuer Kontostand: ${formatEuro(this.economy.cashCents)}`);
    this.save("sale");
    return r;
  }

  // What owning a shop item means in the game - one place, used by buy() and
  // by the developer tools (goldrush-devactions.js). A later phase with a new
  // kind of item (a machine) adds its kind here and in ownsItem().
  canGrant(it) { return !!it && ["tool", "equipment", "upgrade"].includes(it.kind); }

  ownsItem(it) {
    if (it.kind === "tool") return this.tools.owned.has(it.tool);
    if (it.kind === "equipment") return this.processing.owned.has(it.id);
    if (it.kind === "upgrade") return this.tools.upgrades.has(it.id);
    return false;
  }

  _grantItem(it) {
    if (it.kind === "tool") {
      this.tools.unlock(it.tool);
      this.stations.setOwned(this.tools.owned);
    } else if (it.kind === "equipment") {
      this.processing.grant(it.id);                                       // it appears on the claim
    } else if (it.kind === "upgrade") {
      this.tools.addUpgrade(it.id);
      this.hands.models.applyUpgrades(this.tools.upgrades);
      this.processing.applyUpgrades();
    } else return false;
    return true;
  }

  // developer tools / tests: an item becomes yours without paying and without its requirements (same grant as a purchase)
  devGrant(id) {
    const it = shopItem(id);
    if (!it || !this.canGrant(it) || this.ownsItem(it)) return false;
    if (it.kind === "equipment" && !this.processing.owned.has(id) && !this._grantItem(it)) return false;
    if (it.kind !== "equipment") this._grantItem(it);
    if (!this.ownsItem(it)) return false;
    this.dirty = true;
    this.ui.onTool && this.ui.onTool(this.toolState());
    return true;
  }

  /**
   * BUY at the supply counter - one transaction: status, price, cash and
   * the item itself in one synchronous step (a second click finds it owned).
   */
  buy(id) {
    const it = shopItem(id);
    if (!it) return { ok: false, reason: "unknown" };
    const e = this.economy;
    if (this.contract) this.contract.refresh();
    const st = itemStatus(it, { owned: this.tools.owned, upgrades: this.tools.upgrades, equipment: this.processing.owned, hardSeen: e.flags.hardSeen, cashCents: e.cashCents, mountainPct: this.contract ? this.contract.pct : 0 });
    if (st.state === "owned") return { ok: false, reason: "owned" };
    if (st.state === "locked") return { ok: false, reason: "locked", needs: st.needs };
    const pay = e.buy(it.id, it.price, it.kind);
    if (!pay.ok) { this.audio.play("insufficient", { dist: 0.4 }); return { ok: false, reason: pay.reason, missing: pay.missing }; }
    this._grantItem(it);
    if (it.kind === "tool") this.tools.equip(it.tool);                    // straight into your hands
    this.audio.play("purchase", { dist: 0.5 });
    this.hud.cashTo(e.cashCents);
    this.ui.onTool && this.ui.onTool(this.toolState());
    this.save("purchase");
    return { ok: true, item: it.id, cents: it.price, cash: e.cashCents };
  }

  // the quiet guidance of the very start (no quests, no rewards)
  _objective() {
    const e = this.economy;
    if (e.flags.firstPurchaseSeen || this.tools.owned.size > 1) return null;
    if (!e.flags.firstSaleSeen) return e.pouchUg > 0 || e.pending.size ? "Ziel: Gold im Camp beim Goldankauf verkaufen" : "Ziel: am Berg nach Gold graben";
    const price = shopItem("shovel").price;
    return `Ziel: Schaufel · ${formatEuro(e.cashCents)} / ${formatEuro(price)}`;
  }

  setReducedMotion(on) {
    this.settings.reducedMotion = !!on;
    this.reducedMotion = this.systemReducedMotion || !!on;
    if (this.hands) this.hands.reducedMotion = this.reducedMotion;
    if (this.hud) this.hud.reducedMotion = this.reducedMotion;
    this.persistSettings();
  }

  setSound(on) {
    this.settings.sound = !!on;
    this.audio.setEnabled(!!on);
    if (on) this.audio.unlock();
    this.persistSettings();
  }

  setVibration(on) {
    this.settings.vibration = !!on;
    this.persistSettings();
  }

  setQualitySetting(value) {
    this.settings.quality = value;
    this.applyQuality(value === "auto" ? this.autoLevel : value);
    this.persistSettings();
    this.render();
  }

  // settings belong to the device (a new mine keeps them), not to the mine
  persistSettings() {
    if (this.ui.saveSettings) this.ui.saveSettings({ ...this.settings });
  }

  // AUTO only steps DOWN, once per cooldown, when frames are really slow
  _monitor(dt) {
    if (this.settings.quality !== "auto") return;
    const m = this.monitor;
    m.t += dt;
    m.cooldown -= dt;
    if (m.t < MONITOR.warmup) return;
    m.acc += dt * 1000;
    m.n++;
    if (m.acc / 1000 < MONITOR.window) return;
    const avg = m.acc / m.n;
    m.acc = 0;
    m.n = 0;
    if (avg > MONITOR.slowMs && m.cooldown <= 0) {
      const i = QUALITY_LEVELS.indexOf(this.level);
      if (i > 0) {
        this.autoLevel = QUALITY_LEVELS[i - 1];
        this.applyQuality(this.autoLevel);
      }
    }
  }

  // ------------------------------------------------------------ loop

  // one place decides whether frames run: not paused, visible, GL alive
  _syncLoop() {
    const shouldRun = !this.paused && !this.hidden && !this.glLost && !this.disposed;
    if (shouldRun && !this.running) {
      this.running = true;
      this.last = performance.now();
      this.raf = requestAnimationFrame(this._frame);
    } else if (!shouldRun && this.running) {
      this.running = false;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      if (!this.glLost && !this.disposed) this.render();       // show the current state while paused
    }
  }

  setPaused(p) {
    if (this.paused === p) return;
    this.paused = p;
    if (p) { if (this.processing && this.processing.work) this._leaveWork(); this.input.releaseAll(); this.save("pause"); }
    this._syncLoop();
  }

  _frame = (now) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this._frame);
    const raw = (now - this.last) / 1000;
    this.last = now;
    // real time down to 10 FPS (slow devices must not play in slow motion),
    // in steps short enough for walking, collisions and the dig rhythm
    const dt = Math.min(0.1, Math.max(0, raw));
    this.frameMs.push(raw * 1000);
    if (this.frameMs.length > 120) this.frameMs.shift();
    this._monitor(raw);
    const steps = Math.max(1, Math.ceil(dt / 0.034));
    for (let i = 0; i < steps; i++) this.update(dt / steps);
    this.effects.update(dt);
    this.loot.update(dt, this.camera, this.player);
    this._sunCheck(dt);
    this.processing.update(dt, this.player);
    this.hands.update(dt, this.tools.view(), { camera: this.camera, sunDir: SUN_VEC, sunVisible: this.sunVisible, walk: Math.min(1, Math.hypot(this.player.vx, this.player.vz) / WALK), bob: this.player.bob });
    this.hud.update(dt);
    this.stations.update(dt);
    if (this.reticle.visible) { const m = this.reticle.material; m.opacity += ((this._reticleWant || 0.2) - m.opacity) * Math.min(1, dt * 10); }
    this.terrain.clock += dt;
    this.world.terrainUniforms.uTime.value = this.terrain.clock;
    this.world.updatePebbles();
    this._stationTick(dt);
    this.economy.addPlayTime(dt * 1000);
    this.render();
    if (this.dirty && now - this.lastSave > AUTOSAVE_MS) this.save("auto");
    if (this.debug) this._debugTick(now);
    if (this.devHook) this.devHook(now);
  };

  // the HUD's material row: { bucket, barrow, conc } - each null until you own what holds it (the
  // concentrate: once something can make it - classifier or sluice - and only while there is some)
  _materialRow(pr) {
    const row = this._matRow || (this._matRow = { bucket: null, barrow: null, conc: null });
    const fmt = (l) => (l < 10 ? l.toFixed(1).replace(".", ",") : String(Math.round(l)));
    const b = pr.bucket;
    if (b) {
      const l = pr.bucketMl / 1000, cap = Math.round(pr.capacityMl / 1000), full = pr.bucketMl >= pr.capacityMl - 50;
      const v = row.bucket || (row.bucket = {});
      v.text = `${fmt(l)}/${cap} l${b.carried ? ` · ${pr.bucketKg.toFixed(1).replace(".", ",")} kg` : ""}`;
      v.active = !!b.carried; v.full = full; v.aria = `Eimer ${fmt(l)} von ${cap} Litern${b.carried ? ", in der Hand" : ""}`;
    } else row.bucket = null;
    const w = pr.barrow;
    if (w) {
      const l = w.volumeMl / 1000, cap = Math.round(w.capacityMl / 1000);
      const v = row.barrow || (row.barrow = {});
      v.text = `${fmt(l)}/${cap} l${w.pushing ? ` · ${Math.round(w.massKg)} kg` : ""}`;
      v.active = !!w.pushing; v.full = !!w.full; v.aria = `Schubkarre ${fmt(l)} von ${cap} Litern${w.pushing ? ", geschoben" : ""}`;
    } else row.barrow = null;
    // the concentrate: the classifier's tub and the sluice's clean-out tray - both wait for the pan
    const canMake = pr.owned && (pr.owned.has("classifier") || pr.owned.has("sluice"));
    const tray = pr.sluice && pr.sluice.tray ? pr.sluice.tray.batch.volumeMl : 0, cml = (pr.tub ? pr.tub.volumeMl : 0) + tray;
    if (canMake && cml > 50) {
      const v = row.conc || (row.conc = {});
      v.text = `${fmt(cml / 1000)} l`; v.active = pr.work === "pan"; v.full = false;
      v.aria = `Konzentrat ${fmt(cml / 1000)} Liter bereit zum Waschen`;
    } else row.conc = null;
    // phase 9: the excavator's bucket (while you sit in it, or when it holds something)
    const ex = pr.excavator;
    if (ex && (ex.inCab || ex.volumeMl > 0)) {
      const v = row.scoop || (row.scoop = {});
      v.text = ex.breaker ? "Hammer" : `${fmt(ex.volumeMl / 1000)}/${Math.round(EXC_BUCKET_ML / 1000)} l${ex.volumeMl > 0 ? ` · ${Math.round(ex.massG() / 1000)} kg` : ""}`;
      v.active = !!ex.inCab; v.full = ex.room < 2000; v.aria = `Baggerlöffel ${fmt(ex.volumeMl / 1000)} Liter`;
    } else row.scoop = null;
    // Prompt 10: the wheel loader's bucket (while you sit in it, or when it holds something)
    const ld = pr.loader;
    if (ld && (ld.inCab || ld.volumeMl > 0)) {
      const v = row.loader || (row.loader = {});
      v.text = `${fmt(ld.volumeMl / 1000)}/${Math.round(LDR_BUCKET_ML / 1000)} l${ld.volumeMl > 0 ? ` · ${Math.round(ld.massG() / 1000)} kg` : ""}`;
      v.active = !!ld.inCab; v.full = ld.room < 4000; v.aria = `Radladerschaufel ${fmt(ld.volumeMl / 1000)} Liter`;
    } else row.loader = null;
    // phase 9: sample bags waiting to be panned
    const pg = pr.prospect;
    if (pg && pg.count > 0) {
      const v = row.samples || (row.samples = {});
      v.text = `${pg.count}/${BAGS}`; v.active = !!(pr.pan && pr.pan.sample); v.full = pg.full;
      v.aria = `${pg.count} von ${BAGS} Probenbeuteln gefüllt`;
    } else row.samples = null;
    return row;
  }

  // the barrow's wheel on the ground: a soft roll with a creak now and then, more when it is loaded
  _barrowSound(dt, bw) {
    const c = bw.ctl, v = Math.abs(c.v), load = c.load || 0;
    this._creakT = (this._creakT || 0) - dt * v;
    if (v > 0.25 && this._creakT <= 0) {
      this._creakT = 0.9 + Math.random() * 0.8;
      this.audio.play("barrow_roll", { dist: 0.5, strength: Math.min(1, 0.35 + v * 0.4 + Math.min(1, bw.massKg / 150) * 0.3 + c.rough * 0.3) });
    }
    // a heavy load: the frame and the wood groan when it gets going / is pulled up, now and then while it rolls
    this._loadT = (this._loadT || 0) - dt;
    const jolt = Math.abs(c.surge) > 0.55 && Math.abs(this._lastSurge || 0) <= 0.55;
    this._lastSurge = c.surge;
    if (load > 0.4 && this._loadT <= 0 && (jolt || (v > 0.8 && Math.random() < dt * 0.25))) {
      this._loadT = 1.2;
      this.audio.play("barrow_load", { dist: 0.4, strength: Math.min(1, 0.4 + load * 0.6) });
    }
    // and you feel it: the view gives a little as it starts / stops (more when full)
    if (jolt && !this.reducedMotion) this.player.kick = Math.max(this.player.kick || 0, 0.006 + 0.01 * load);
  }

  render() {
    if (this.glLost || this.disposed) return;
    const r = this.renderer, pr = this.processing;
    if (pr && pr.warmPending && this.ready) {
      // a machine was just bought: all its parts once through the GPU, drawn into one pixel the frame covers
      pr.warmPending = false;
      pr.warmMachines(true);
      r.setScissorTest(true);
      r.setScissor(0, 0, 1, 1);
      r.render(this.world.scene, this.camera);
      r.setScissorTest(false);
      pr.warmMachines(false);
    }
    r.render(this.world.scene, this.camera);
    // draw calls of the main pass (as in phase 1; the shadow pass comes on top) + the hands pass
    this.frameCalls = r.info.render.calls;
    this.frameTris = r.info.render.triangles;
    if (this.hands && this.ready && !this.cab) {
      r.autoClear = false;
      this.hands.render(r);
      r.autoClear = true;
      this.frameCalls += r.info.render.calls;
      this.frameTris += r.info.render.triangles;
    }
  }

  // ------------------------------------------------------------ simulation

  update(dt) {
    // the shovel's load leaves the blade a moment after the cut (thrown aside / dropped into the bucket or barrow)
    if (this._release && (this._release.t -= dt) <= 0) { this._shovelRelease(this._release); this._release = null; }
    const p = this.player, input = this.input, world = this.world;
    const look = input.takeLook();
    const jumpReq = input.takeJump();           // taken here: a press in a machine / at work is gone, not kept for later
    if (this.cab) { if (this.cab.kind === "loader") this._loaderUpdate(dt, look); else this._cabUpdate(dt, look); return; }
    if (this.processing.work) { this._workUpdate(dt, look); return; }
    const pr = this.processing, bw = pr.pushing ? pr.barrow : null;
    p.yaw -= look.x;
    // pushing (phase 8): you look round freely a little; further off its line the barrow turns after
    // you (its controller) - the eyes never leave it (the grips stay in reach of the view)
    if (bw) { p.yaw = clampLook(p.yaw, bw.yaw, false); const c = clampLook(p.yaw, bw.yaw); p.yaw += (c - p.yaw) * Math.min(1, dt * 12); }
    p.pitch = bw ? Math.max(-1.05, Math.min(0.15, p.pitch - look.y)) : Math.max(-1.45, Math.min(1.45, p.pitch - look.y));
    this.hands.look(look.x, look.y);

    // walk: accelerate towards the stick/keys direction
    let mx = input.move.x, my = input.move.y;
    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    if (bw) {
      // the barrow moves by itself (goldrush-wheelbarrow-controller.js) - W / S push and brake / back up,
      // A / D steer; you stand behind its grips
      bw.walkSpeed = WALK;
      const r = bw.drive(dt, { fwd: my, turn: mx }, p);
      if (r.blocked && this.audio) this.audio.play("barrow_bump", { dist: 0.6, strength: Math.min(1, 0.4 + Math.abs(bw.ctl.v)) });
      this._barrowSound(dt, bw);
    }
    const speed = (input.sprint && !bw ? SPRINT : WALK) * this.processing.speedFactor();
    const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
    const tx = (-sin * my + cos * mx) * speed, tz = (-cos * my - sin * mx) * speed;
    const a = Math.min(1, dt * (p.air ? JUMP.airCtl : 10));           // in the air: your momentum, little control
    if (!bw) { p.vx += (tx - p.vx) * a; p.vz += (tz - p.vz) * a; }
    const g0 = world.groundAt(p.x, p.z);
    if (jumpReq) this._jumpPress(g0, bw);
    // steep ground: walking up to 38°, scrambling (slower) up to 68° - so you
    // always get out of your own pit - never up a stone wall
    const feet = p.air ? p.y - EYE : null;
    const tryAxis = (sx, sz) => {
      const d = Math.hypot(sx, sz);
      if (d < 1e-6) return true;
      // in the air: ground higher than your feet stops you (you land on what you cleared)
      if (feet != null) { if (world.groundAt(p.x + sx, p.z + sz) > feet + 0.02) return false; p.x += sx; p.z += sz; return true; }
      const rise = world.groundAt(p.x + sx, p.z + sz) - g0;
      const s = rise / d;
      if (rise > 0 && s > MAX_SLOPE) return false;
      const k = rise > 0 && s > WALK_SLOPE ? Math.max(0.25, 1 - ((Math.atan(s) - Math.atan(WALK_SLOPE)) / (Math.atan(MAX_SLOPE) - Math.atan(WALK_SLOPE))) * 0.75) : 1;
      p.x += sx * k;
      p.z += sz * k;
      return true;
    };
    if (!bw) {
      if (!tryAxis(p.vx * dt, p.vz * dt)) {
        if (!tryAxis(p.vx * dt, 0)) p.vx = 0;
        if (!tryAxis(0, p.vz * dt)) p.vz = 0;
      }
      world.collide(p, RADIUS);
      this._keepOffWalls();
    }
    const ground = world.groundAt(p.x, p.z) + EYE;
    if (p.prep > 0 && (p.prep -= dt) <= 0) this._jumpOff();
    if (p.air) this._airborne(dt, ground);
    else {
      p.y += (ground - p.y) * Math.min(1, dt * (ground < p.y - 0.4 ? 20 : 12));
      if (p.y < ground - 0.25) p.y = ground - 0.25;             // never sink into ground that rose under you
    }
    if (p.cool > 0) p.cool -= dt;
    this._dipUpdate(dt);

    const moving = Math.hypot(p.vx, p.vz);
    if (moving > 0.3) p.bob += dt * moving * 2.1; else p.bob *= Math.exp(-dt * 6);
    p.kick *= Math.exp(-dt * 16);

    this._updateCamera(dt);
    this._aim();
    // Prompt 10: placing the hillside miner - the crosshair picks its spot, the tools rest
    if (this.placing) { this._placeUpdate(dt); this.tools.tick(dt, false); this._phaseHooks(); return; }
    // the tool: actions while dig is held and the crosshair is on the ground
    // (not while you carry the bucket - your hand is on its bail)
    const carrying = this.processing.carrying || this.processing.pushing;
    if (this._sampleArm && (!this.target || carrying)) this._sampleArm = false;
    const want = (input.digHeld || this._sampleArm) && !!this.target && !carrying;
    if (input.digHeld && !this.target && !carrying) this._hintNoTarget();
    if (input.digHeld && carrying) {
      if (this.processing.pushing) this.hud.tip("push", "Du schiebst die Schubkarre – erst abstellen [E], dann graben.", 8);
      else this.hud.tip("carry", "Du trägst den Eimer – erst abstellen [E], dann graben.", 8);
    }
    this.tools.blocked = !!this.hands.inspecting || carrying;
    if (carrying !== this._handsBusy) { this._handsBusy = carrying; this.ui.setHandsBusy && this.ui.setHandsBusy(carrying); }
    const ev = this.tools.tick(dt, want);
    if (ev === "contact") this._contact();
    else if (ev === "swap") this._swapped();
    this._phaseHooks();
  }

  // ------------------------------------------------------------ the excavator's cab (phase 9)

  // get in: the view from the cab, the hands at the controls (not drawn), the tracks under W A S D
  // (Prompt 10: machine "loader" - the wheel loader's seat)
  enterCab(restoring = false, machine = "excavator") {
    if (machine === "loader") return this._enterLoader(restoring);
    const ex = this.processing.excavator;
    if (!ex || this.processing.work || this.processing.carrying || this.processing.pushing) return false;
    this.tools.cancel();
    this._sampleArm = false;
    this.input.releaseAll();
    this.cab = ex;
    ex.inCab = true;
    const p = this.player;
    p.yaw = restoring ? p.yaw : ex.heading + ex.swing - Math.PI / 2;
    p.pitch = restoring ? Math.max(-1.1, Math.min(0.5, p.pitch)) : -0.32;
    ex.viewAz = Math.atan2(Math.sin(p.yaw + Math.PI / 2 - ex.heading), Math.cos(p.yaw + Math.PI / 2 - ex.heading));
    this.reticle.visible = false;
    ex.rig.setFirstPerson(true);
    this.ui.root.classList.add("gr-cab");
    this.ui.setCab && this.ui.setCab(true, ex.breaker);
    this.audio.play("exc_start", { dist: 0.4 });
    if (!restoring) this.hud.tip("cab", this.touch ? "Stick: fahren und drehen · ziehen: umsehen · SCHAUFELN / KIPPEN · AUSSTEIGEN" : "W / S fahren · A / D drehen · Maus: umsehen, der Oberwagen folgt · Linksklick: graben · Rechtsklick / Q: abkippen · E: aussteigen", 30);
    this._stationSig = null;
    this.dirty = true;
    return true;
  }

  // Prompt 10: into the wheel loader's seat - looking ahead over the bucket
  _enterLoader(restoring) {
    const ld = this.processing.loader;
    if (!ld || this.processing.work || this.processing.carrying || this.processing.pushing) return false;
    this.tools.cancel();
    this._sampleArm = false;
    this.input.releaseAll();
    this.cab = ld;
    ld.inCab = true;
    const p = this.player;
    p.yaw = restoring ? p.yaw : ld.heading - Math.PI / 2;
    p.pitch = restoring ? Math.max(-1.0, Math.min(0.45, p.pitch)) : -0.2;
    this._ldrDig = this._ldrAlt = false;
    this.reticle.visible = false;
    ld.rig.setFirstPerson(true);
    this.ui.root.classList.add("gr-cab");
    this.ui.setCab && this.ui.setCab(true, false, "loader");
    this.audio.play("exc_start", { dist: 0.4 });
    if (!restoring) this.hud.tip("cab-loader", this.touch ? "Stick: fahren und lenken · ziehen: umsehen · SCHAUFEL: absenken / anheben · KIPPEN · AUSSTEIGEN" : "W / S fahren · A / D lenken · Maus: umsehen · Linksklick: Schaufel absenken / anheben · in den Haufen fahren: füllen · Rechtsklick / Q: am Trichter kippen · E: aussteigen", 30);
    this._stationSig = null;
    this.dirty = true;
    return true;
  }

  exitCab() {
    const ex = this.cab;
    if (!ex) return false;
    this.cab = null;
    ex.inCab = false;
    ex.v = 0;
    if (ex.w != null) ex.w = 0;
    if (ex.kind === "loader") this.processing.loaderInput = null;
    ex.rig.setFirstPerson(false);
    const spot = ex.exitSpot(), p = this.player;
    p.x = spot.x; p.z = spot.z; p.vx = p.vz = 0;
    p.y = this.world.groundAt(p.x, p.z) + EYE;
    p.pitch = Math.max(-0.6, Math.min(0.3, p.pitch));
    this.world.collide(p, RADIUS);
    this.input.releaseAll();
    this.ui.root.classList.remove("gr-cab");
    this.ui.setCab && this.ui.setCab(false);
    this.hud.work(null);
    this.hud.clearTip();
    this.audio.play("exc_stop", { dist: 0.6 });
    this._updateCamera();
    this._stationSig = null;
    this.dirty = true;
    return true;
  }

  // [T] at the attachment stand: bucket <-> hydraulic breaker
  cabSwap() {
    const ex = this.cab;
    if (!ex) return false;
    if (!this.tools.upgrades.has("excavator.breaker")) { this.hud.tip("no-breaker", "Einen Hydraulikhammer gibt es bei der Ausrüstung (ab 2 % Bergauftrag).", 5); return false; }
    if (ex.volumeMl > 0) { this.hud.tip("swap-load", "Erst den Löffel leeren, dann das Anbaugerät wechseln.", 4); return false; }
    if (!ex.canSwap()) { this.hud.tip("swap-far", "Anbaugeräte wechselst du am Stand des Baggers (neben dem Aufgabetrichter).", 5); return false; }
    return ex.startSwap();
  }

  // the receivers (dump) and sources (scoop) the crosshair can pick out
  _cabReceivers() {
    const pr = this.processing, out = this._rcv || (this._rcv = []);
    out.length = 0;
    const cv = pr.conveyor, w = pr.barrow, bk = pr.bulk, sp = pr.spoil, tr = pr.trommel;
    if (cv && cv.installed) out.push({ kind: "intake", label: "Aufgabetrichter", at: { x: INTAKE.x, y: INTAKE.rimY, z: INTAKE.z }, r: 0.85, room: cv.intake.room, fill: `${Math.round(cv.volumeMl / 1000)} / ${Math.round(cv.capacityMl / 1000)} l` });
    if (w && !w.pushing && !w.dump) { const c = w.trayCenter(); out.push({ kind: "barrow", label: "Schubkarre", at: { x: c.x, y: this.world.groundAt(c.x, c.z) + 0.55, z: c.z }, r: 0.55, room: w.capacityMl - w.batch.volumeMl, fill: `${Math.round(w.batch.volumeMl / 1000)} / ${Math.round(w.capacityMl / 1000)} l` }); }
    if (bk && bk.installed) out.push({ kind: "bulk", label: "Vorratstrichter", at: { x: BULK_AT.x, y: BULK.outletY + BULK.depth, z: BULK_AT.z }, r: 0.8, room: bk.buffer.room, fill: `${Math.round(bk.volumeMl / 1000)} / ${Math.round(bk.capacityMl / 1000)} l` });
    if (sp) { const R = sp.radius; out.push({ kind: "spoil", label: "Abraumhalde", at: { x: SPOIL.x, y: Math.max(0.3, sp.model.visible ? sp.model.scale.y * 0.55 : 0.3), z: SPOIL.z }, r: Math.max(1.3, R * 0.95), room: Infinity, fill: m3(sp.ml) }); }
    if (tr && tr.overMl > 3000 && tr.pile.visible) out.push({ kind: "oversize", source: true, label: "Überkornhaufen", at: { x: OVERSIZE.x, y: tr.pile.scale.y * 0.5, z: tr.pile.position.z }, r: Math.max(0.7, tr.pile.scale.x), room: 0, fill: m3(tr.overMl) });
    return out;
  }

  // what the crosshair is on from the cab: a dig spot, a receiver, the oversize pile, rock
  _cabAim() {
    const ex = this.cab, p = this.player, cam = this.camera;
    const cp = Math.cos(p.pitch), dx = -Math.sin(p.yaw) * cp, dy = Math.sin(p.pitch), dz = -Math.cos(p.yaw) * cp;
    const ox = cam.position.x, oy = cam.position.y, oz = cam.position.z;
    let hit = this.terrain.raycast(ox, oy, oz, dx, dy, dz, 12);
    const b = this.rocks.raycast(ox, oy, oz, dx, dy, dz, hit ? hit.distance : 12, this._hit);
    if (b) hit = b; else if (hit) hit.boulder = null;
    let best = null, bestT = hit ? hit.distance + 0.25 : 12;
    for (const o of this._cabReceivers()) {
      const vx = o.at.x - ox, vy = o.at.y - oy, vz = o.at.z - oz, t = vx * dx + vy * dy + vz * dz;
      if (t <= 0 || t > bestT) continue;
      const cx = ox + dx * t - o.at.x, cy = oy + dy * t - o.at.y, cz = oz + dz * t - o.at.z;
      if (Math.hypot(cx, cy, cz) <= o.r) { bestT = t; best = o; }
    }
    const load = ex.volumeMl, tgt = this._cabTgt || (this._cabTgt = {});
    tgt.recv = null; tgt.hit = null; tgt.ok = false; tgt.act = null; tgt.state = "idle"; tgt.text = "";
    // Prompt 10: a stockpile under the crosshair (its surface, or the bare ground of its site): tip onto it
    // with a load, scoop from it with an empty bucket
    const piles = this.processing.piles;
    const ph = piles ? piles.raycast(ox, oy, oz, dx, dy, dz, hit ? hit.distance + 0.05 : 12) : null;
    let pileAt = null;
    if (ph && (!best || ph.distance < bestT)) pileAt = { pile: ph.pile, at: { x: ph.x, y: ph.y, z: ph.z }, surface: true };
    else if (!best && hit && hit.boulder == null && piles) { const p0 = piles.at(hit.x, hit.z, 0); if (p0 && (p0.id === "raw" || p0.id === "spoil")) pileAt = { pile: p0, at: { x: hit.x, y: hit.y, z: hit.z }, surface: false }; }
    if (pileAt && !ex.breaker) {
      const P = pileAt.pile, reach = ex.reachable(ex.rel(pileAt.at), "dump"), name = P.def.name;
      if (load > 0) {
        if (!reach) { tgt.text = `${name} – näher heranfahren`; tgt.state = "far"; }
        else if (P.room <= 200) { tgt.text = `${name} ist voll`; tgt.state = "hard"; }
        else { tgt.ok = true; tgt.act = "dump"; tgt.state = "dig"; tgt.recv = { kind: "pile", id: P.id, label: name, at: pileAt.at }; tgt.text = `${this.touch ? "KIPPEN" : "[Rechtsklick / Q]"}: auf den Haufen ${P.def.label} · ${m3Text(P.volumeMl)}`; }
        this.ui.setCrosshair(tgt.state);
        this.reticle.visible = false;
        return tgt;
      }
      if (pileAt.surface) {
        const sreach = ex.reachable(ex.rel(pileAt.at));
        if (!sreach) { tgt.text = `${P.def.label} ${m3Text(P.volumeMl)} – näher heranfahren`; tgt.state = "far"; }
        else { tgt.ok = true; tgt.act = "scoop"; tgt.state = "dig"; tgt.recv = { kind: "pile", id: P.id, source: true, at: pileAt.at }; tgt.text = `${this.touch ? "SCHAUFELN" : "[Klick]"}: vom Haufen nehmen · ${P.def.label} ${m3Text(P.volumeMl)}`; }
        this.ui.setCrosshair(tgt.state);
        this.reticle.visible = false;
        return tgt;
      }
    }
    if (best) {
      tgt.recv = best;
      const reach = ex.reachable(ex.rel(best.at), "dump");
      if (best.source) {
        if (ex.breaker) tgt.text = `${best.label} · ${best.fill} – zum Aufnehmen den Löffel anbauen`;
        else if (ex.room < 2000) tgt.text = `${best.label} – der Löffel ist voll`;
        else if (!reach) { tgt.text = `${best.label} · ${best.fill} – näher heranfahren`; tgt.state = "far"; }
        else { tgt.ok = true; tgt.act = "scoop"; tgt.state = "dig"; tgt.text = `${this.touch ? "SCHAUFELN" : "[Klick]"}: Überkorn aufnehmen · ${best.fill}`; }
      } else if (load <= 0) tgt.text = `${best.label} · ${best.fill} – erst graben, dann kippen`;
      else if (!reach) { tgt.text = `${best.label} – näher heranfahren`; tgt.state = "far"; }
      else if (best.room <= 200) { tgt.text = `${best.label} ist voll (${best.fill})`; tgt.state = "hard"; }
      else { tgt.ok = true; tgt.act = "dump"; tgt.state = "dig"; tgt.text = `${this.touch ? "KIPPEN" : "[Rechtsklick / Q]"}: ${best.kind === "spoil" ? "auf die Abraumhalde (Abraum, wird nicht gewaschen)" : `in ${best.kind === "barrow" ? "die" : "den"} ${best.label}`} · ${best.fill}`; }
    } else if (hit) {
      tgt.hit = hit;
      const rel = ex.rel(hit), reach = ex.reachable(rel), boulder = hit.boulder != null;
      const mat = this.mining.materialAtHit(hit), rubble = mat === MAT.STONE && this.mining.rubbleAtHit(hit);
      const eff = boulder ? 0 : (mat === MAT.STONE && !rubble ? 0 : 1);
      if (!hit.diggable) tgt.text = "Hier wird nicht gegraben";
      else if (ex.breaker) {
        if (!(boulder || (mat === MAT.STONE && !rubble))) tgt.text = "Der Hammer ist für Fels und Felsbrocken – zum Graben den Löffel anbauen (am Stand: T)";
        else if (!reach && !(rel.r >= 1.6 && rel.r <= 4.3)) { tgt.text = "Außer Reichweite – näher heranfahren"; tgt.state = "far"; }
        else { tgt.ok = true; tgt.act = "break"; tgt.state = "dig"; tgt.text = `${this.touch ? "HAMMER" : "[Klick]"}: ${boulder ? "Felsbrocken brechen" : "Fels brechen"}`; }
      } else if (boulder) { tgt.text = "Felsbrocken – zu groß für den Löffel (Hydraulikhammer)"; tgt.state = "hard"; }
      else if (!eff) { tgt.text = "Fester Fels – der Löffel kommt nicht hinein (Hydraulikhammer oder Spitzhacke)"; tgt.state = "hard"; }
      else if (!reach) { tgt.text = rel.r < 1.75 ? "Zu nah an den Ketten – etwas zurücksetzen" : "Außer Reichweite – näher heranfahren"; tgt.state = "far"; }
      else if (ex.room < 2000) { tgt.text = "Löffel voll – auf Aufgabetrichter, Schubkarre oder Halde zielen"; tgt.state = "hard"; }
      else { tgt.ok = true; tgt.act = "scoop"; tgt.state = "dig"; tgt.text = `${this.touch ? "SCHAUFELN" : "[Klick]"}: graben · ${MATERIALS[mat].label}${rubble ? " (Geröll)" : ""}`; }
    }
    // the ring where the bucket will bite
    const r = this.reticle;
    if (tgt.hit && (tgt.act === "scoop" || tgt.act === "break" || tgt.state === "hard" || tgt.state === "far")) {
      const n = tgt.hit.normal || { x: 0, y: 1, z: 0 };
      r.position.set(tgt.hit.x + n.x * 0.02, tgt.hit.y + n.y * 0.02, tgt.hit.z + n.z * 0.02);
      r.quaternion.setFromUnitVectors(ZUP, this._n.set(n.x, n.y, n.z));
      r.scale.setScalar(tgt.act === "break" ? 0.16 : tgt.state === "dig" ? EXC_DEF.kernel.a * 0.9 : 0.1);
      r.material.color.setHex(tgt.state === "dig" ? 0xfff3d6 : 0xc9c3ba);
      this._reticleWant = tgt.state === "dig" ? 0.25 : 0.15;
      r.visible = true;
    } else { r.visible = false; r.material.opacity = 0; }
    this.ui.setCrosshair(tgt.state);
    return tgt;
  }

  _cabUpdate(dt, look) {
    const ex = this.cab, p = this.player, input = this.input;
    p.yaw -= look.x;
    p.pitch = Math.max(-1.15, Math.min(0.55, p.pitch - look.y));
    ex.viewAz = Math.atan2(Math.sin(p.yaw + Math.PI / 2 - ex.heading), Math.cos(p.yaw + Math.PI / 2 - ex.heading));
    // the tracks: W / S, A / D (the stick on a phone); the chassis turns, the view turns with it
    const h0 = ex.heading;
    const r = ex.drive(dt, input.move.y, input.move.x);
    p.yaw += ex.heading - h0;
    if (r.blocked && (this._bumpT = (this._bumpT || 0) - dt) <= 0) { this._bumpT = 0.8; this.audio.play("barrow_bump", { dist: 1.2, strength: 0.8 }); }
    // the camera in the cab (it turns with the house - the eye follows the seat)
    const eye = ex.eye(this._eyeV || (this._eyeV = new THREE.Vector3()));
    p.x = eye.x; p.z = eye.z; p.y = eye.y; p.vx = p.vz = 0;
    const cam = this.camera;
    cam.position.copy(eye);
    cam.rotation.y = p.yaw;
    cam.rotation.x = p.pitch;
    const tgt = this._cabAim();
    // actions: click = scoop (break), right click / Q / the phone's KIPPEN = dump
    const dump = input.altHeld || this._cabDump;
    this._cabDump = false;
    if (!ex.busy && tgt.ok) {
      if (input.digHeld && tgt.act === "scoop") ex.startScoop(tgt.recv ? (tgt.recv.kind === "pile" ? { kind: "pile", id: tgt.recv.id, at: tgt.recv.at } : { kind: "oversize", at: tgt.recv.at }) : { kind: "ground", hit: { ...tgt.hit, normal: tgt.hit.normal ? { ...tgt.hit.normal } : null } });
      else if (input.digHeld && tgt.act === "break") ex.startBreak({ hit: { ...tgt.hit } });
      else if (dump && tgt.act === "dump") ex.startDump({ kind: tgt.recv.kind, id: tgt.recv.id, at: { ...tgt.recv.at } });
    } else if (!ex.busy && dump && ex.volumeMl > 0 && !(tgt.recv && !tgt.recv.source)) this.hud.tip("dump-where", "Zum Abkippen auf den Aufgabetrichter, eine Schubkarre, den Vorratstrichter oder die Abraumhalde zielen.", 6);
    // the cab's quiet HUD: the bucket in the material row, what the crosshair is on below
    const busy = ex.task ? { scoop: "gräbt …", dump: "kippt …", break: "hämmert …", swap: "wechselt das Anbaugerät …" }[ex.task.kind] : "";
    this.hud.work(busy ? `Bagger ${busy}` : tgt.text || (this.touch ? "Auf den Hang zielen: SCHAUFELN" : "Auf den Hang zielen · Linksklick: graben"));
    // sounds: the diesel (busier under load), the tracks, the hydraulics
    this._dieselT = (this._dieselT || 0) - dt;
    if (this._dieselT <= 0) { this._dieselT = 0.75; this.audio.play("exc_engine", { dist: 0.6, strength: ex.task || Math.abs(ex.v) > 0.1 ? 1 : 0.55 }); }
    this._trackT = (this._trackT || 0) - dt * Math.min(2, Math.abs(ex.v) + Math.abs(ex.w) * 0.8);
    if (this._trackT <= 0 && (Math.abs(ex.v) > 0.15 || Math.abs(ex.w) > 0.15)) { this._trackT = 0.55; this.audio.play("exc_tracks", { dist: 0.8, strength: Math.min(1, 0.5 + Math.abs(ex.v) * 0.4) }); }
    if (ex.task && ex.task.phase !== "swing" && (this._hydT = (this._hydT || 0) - dt) <= 0) { this._hydT = 0.5; this.audio.play("exc_hydraulic", { dist: 0.7, strength: 0.7 }); }
    if (ex.swinging && (this._swT = (this._swT || 0) - dt) <= 0) { this._swT = 0.6; this.audio.play("exc_hydraulic", { dist: 0.9, strength: 0.45 }); }
    this.tools.blocked = true;
    this.tools.tick(dt, false);
  }

  // Prompt 10: a stroke into a stockpile - loose material, it gives easily: into the bucket / barrow / intake
  _pileContact(hit, def) {
    const P = hit.pile, ml = Math.round(((def.kernel && def.kernel.vol) || 0.0012) * 1e6 * 1.25);
    const dir = this._toolDir(), pan = this._pan(hit), dist = hit.distance;
    const r = this.processing.collectFromPile(P, hit, { x: dir.x, z: dir.z }, ml, this.player);
    const comp = P.buffer.comp(this._pc || (this._pc = [0, 0, 0, 0]));
    let mat = 0; for (let m = 1; m < 4; m++) if (comp[m] > comp[mat]) mat = m;
    if (r.ml > 0) {
      this.tools.react("ok", mat);
      this.hands.contact("ok", mat, r.ml / 1000 * 1.5);
      this.effects.impact(hit, mat, def.id, dir, 0.6);
      this.audio.play((DIG_SOUND[def.id] || DIG_SOUND.hand)[mat] || "hand_dirt", { pan, dist, strength: 0.8 });
      if (def.id === "shovel") this._release = { t: 0.3, mat, into: r.into, kg: r.ml / 600 };
      this.lastStroke = { tool: def.id, kind: "pile", pile: P.id, ml: r.ml, into: r.into, massKg: 0, finds: 0, cents: 0 };
    } else {
      this.tools.react("air");
      this.hands.contact("ok", mat, 0.2);
      this.hud.tip(`pile-${r.noRoom || "none"}`, r.noRoom === "full" ? "Eimer / Schubkarre ist voll." : `${P.def.label}: erst einen Eimer oder die Schubkarre daneben abstellen – dann hineinschaufeln.`, 6);
      this.lastStroke = { tool: def.id, kind: "pile", pile: P.id, ml: 0, massKg: 0, finds: 0, cents: 0 };
    }
    this.dirty = true;
  }

  // ------------------------------------------------------------ the wheel loader (Prompt 10)

  // what lies in front of its bucket: a receiver to pour into (the intake, a stockpile site), the pile it digs
  _loaderAim() {
    const ld = this.cab, pr = this.processing, tgt = this._ldrTgt || (this._ldrTgt = {});
    tgt.recv = null; tgt.text = ""; tgt.state = "idle";
    const lip = ld.rig.lipWorld(this._lipV || (this._lipV = new THREE.Vector3())), fh = ld.frontHeading, dx = Math.cos(fh), dz = -Math.sin(fh);
    const ax = lip.x + dx * 0.45, az = lip.z + dz * 0.45;
    // the same receiver table as the barrow's (goldrush-processing.js receivers): the hoppers it can reach over,
    // the stockpile sites; the small sluice hopper and the deck-mounted bulk hopper are not for a 260-l bucket
    for (const R of pr.receivers()) {
      if (R.small || R.deck) continue;
      if (R.pile) {
        if (!R.pile.inside(ax, az, 0.2)) continue;
        const y = Math.max(this.world.groundBelowAt(ax, az), R.pile.heightAt(ax, az));
        tgt.recv = { kind: "pile", pile: R.pile, label: R.label, top: Number.isFinite(y) ? y : this.world.groundBelowAt(ax, az), fill: m3Text(R.pile.volumeMl), room: R.room, R };
        break;
      }
      if (Math.hypot(ax - R.at.x, az - R.at.z) < (R.loaderReach || 1.3)) { tgt.recv = { kind: R.id, label: R.label, top: R.top, holder: R.holder, fill: R.fill, room: R.room, R }; break; }
    }
    // the outlet / oversize piles: not to tip onto, but to dig from - so the bucket's mouth knows them too
    if (!tgt.recv && pr.piles) { const P = pr.piles.at(ax, az, 0.2); if (P && P.volumeMl > 0) tgt.recv = { kind: "pile", pile: P, label: P.def.name, top: Math.max(this.world.groundBelowAt(ax, az), P.heightAt(ax, az)), fill: m3Text(P.volumeMl), room: P.dumpable ? P.room : 0 }; }
    const R = tgt.recv, load = ld.volumeMl, kbd = !this.touch;
    if (ld.dumping) { tgt.text = `kippt … ${R ? R.label : ""}`; tgt.state = "dig"; }
    else if (ld.wall) { tgt.text = "Gewachsener Boden – der Radlader gräbt keinen Berg. Das macht der Bagger; der Lader nimmt vom Haufen."; tgt.state = "hard"; }
    else if (ld.mode === "dig") {
      if (ld.room < 4000) { tgt.text = "Schaufel voll"; tgt.state = "hard"; }
      else if (ld.face > 0) { tgt.text = `In den Haufen schieben – die Schaufel füllt sich · ${Math.round(load / 1000)} / ${Math.round(LDR_BUCKET_ML / 1000)} l`; tgt.state = "dig"; }
      else tgt.text = R && R.kind === "pile" && R.pile.volumeMl > 0 ? `Weiter in den Haufen ${R.pile.def.label} fahren` : `Schaufel unten · in einen Haufen fahren · ${kbd ? "Linksklick" : "SCHAUFEL"}: anheben`;
    } else if (R && load > 0) {
      if (R.kind === "pile" && !R.pile.dumpable) { tgt.text = `${R.pile.def.label} ${R.fill} – hier wird nur aufgenommen. Kippen: Aufgabetrichter, Rohhaufen, Tailings-Zone oder Abraumhalde`; tgt.state = "hard"; }
      else if (R.room <= 200) { tgt.text = `${R.label} ist voll (${R.fill})`; tgt.state = "hard"; }
      else { tgt.text = `${kbd ? "[Rechtsklick / Q]" : "KIPPEN"}: ${R.R ? R.R.into : `auf den Haufen ${R.pile.def.label}`} · ${R.fill}`; tgt.state = "dig"; tgt.ok = true; }
    } else if (R && R.kind === "pile" && R.pile.volumeMl > 0) tgt.text = `${R.pile.def.label} ${R.fill} · ${kbd ? "Linksklick" : "SCHAUFEL"}: Schaufel absenken, dann hineinfahren`;
    else tgt.text = load > 0 ? `Schaufel ${Math.round(load / 1000)} l – zum Aufgabetrichter oder auf einen Haufen fahren` : `${kbd ? "Linksklick" : "SCHAUFEL"}: Schaufel absenken – Rohmaterial holt der Lader vom Haufen am Bagger`;
    return tgt;
  }

  _loaderUpdate(dt, look) {
    const ld = this.cab, p = this.player, input = this.input, pr = this.processing;
    // the view: around the seat within limits of the machine's heading (you turn with the rear frame)
    p.yaw -= look.x;
    p.pitch = Math.max(-1.0, Math.min(0.45, p.pitch - look.y));
    const ahead = ld.heading - Math.PI / 2, rel = Math.max(-1.95, Math.min(1.95, Math.atan2(Math.sin(p.yaw - ahead), Math.cos(p.yaw - ahead))));
    p.yaw = ahead + rel;
    const h0 = ld.heading;
    const r = ld.drive(dt, input.move.y, input.move.x);
    p.yaw += ld.heading - h0;
    const li = pr.loaderInput = this._ldrIn || (this._ldrIn = { fwd: 0 });
    li.fwd = input.move.y;
    if (r.blocked && (this._bumpT = (this._bumpT || 0) - dt) <= 0) { this._bumpT = 0.8; this.audio.play("barrow_bump", { dist: 1.2, strength: 0.9 }); }
    const eye = ld.eye(this._eyeV || (this._eyeV = new THREE.Vector3()));
    p.x = eye.x; p.z = eye.z; p.y = eye.y; p.vx = p.vz = 0;
    const cam = this.camera;
    cam.position.copy(eye);
    cam.rotation.y = p.yaw;
    cam.rotation.x = p.pitch;
    const tgt = this._loaderAim();
    // [Linksklick] / SCHAUFEL: the bucket down / up (on the press); [Rechtsklick / Q] / KIPPEN: pour into what is in front
    const dig = input.digHeld, alt = input.altHeld || this._cabDump;
    this._cabDump = false;
    if (dig && !this._ldrDig && !ld.busy) {
      const m = ld.toggleDig();
      this.audio.play("exc_hydraulic", { dist: 0.7, strength: 0.6 });
      if (m === "dig" && ld.stats.takes === 0) this.hud.tip("ldr-first", "Schaufel unten: jetzt langsam in den Rohhaufen fahren – je kräftiger du schiebst, desto schneller füllt sie sich. Voll hebt sie sich von selbst.", 10);
    }
    if (alt && !this._ldrAlt && !ld.busy) {
      if (tgt.recv && ld.volumeMl > 0 && tgt.recv.room > 200) { ld.startDump(tgt.recv); this.audio.play("exc_hydraulic", { dist: 0.7, strength: 0.7 }); }
      else if (ld.volumeMl > 0) this.hud.tip("ldr-where", "Zum Kippen mit der Schaufel an den Aufgabetrichter fahren – oder über einen Haufen.", 5);
    }
    this._ldrDig = dig; this._ldrAlt = alt;
    this.hud.work(tgt.text);
    this.ui.setCrosshair(tgt.state === "dig" ? "dig" : tgt.state === "hard" ? "hard" : "idle");
    this.reticle.visible = false;
    // sounds: the diesel (it works harder pushing, lifting, climbing), the tyres on gravel, the hydraulics
    const work = (ld.pushing ? 1 : 0) + (ld.armsMoving ? 0.6 : 0) + Math.min(1, Math.abs(ld.v) / 2.5);
    this._dieselT = (this._dieselT || 0) - dt;
    if (this._dieselT <= 0) { this._dieselT = 0.74; this.audio.play("ldr_engine", { dist: 0.6, strength: Math.min(1, 0.45 + 0.4 * work) }); }
    this._tyreT = (this._tyreT || 0) - dt * Math.min(2.2, Math.abs(ld.v));
    if (this._tyreT <= 0 && Math.abs(ld.v) > 0.3) { this._tyreT = 0.6; this.audio.play("ldr_tyres", { dist: 1.0, strength: Math.min(1, 0.4 + Math.abs(ld.v) * 0.2 + ld.loadFrac * 0.2) }); }
    if (ld.armsMoving && (this._hydT = (this._hydT || 0) - dt) <= 0) { this._hydT = 0.55; this.audio.play("exc_hydraulic", { dist: 0.8, strength: 0.5 }); }
    this.tools.blocked = true;
    this.tools.tick(dt, false);
  }

  // the loader's moments: material taken from a pile, the bucket full, a pour, the edge against a bank
  _ldrEvent(kind, r) {
    const ld = this.processing.loader;
    if (!ld) return;
    const near = !!this.cab || Math.hypot(this.player.x - ld.x, this.player.z - ld.z) < 16;
    const dist = this.cab ? 1.4 : Math.max(1.5, Math.hypot(this.player.x - ld.x, this.player.z - ld.z));
    if (kind === "take") {
      if (near && (this._scrapeT = (this._scrapeT || 0) - 1) <= 0) { this._scrapeT = 10; this.audio.play("ldr_bucket", { dist, strength: 0.7 }); }
    } else if (kind === "filled") {
      if (near) this.audio.play("exc_scoop", { dist, strength: 0.9 });
      this.hud.tip("ldr-full", `Schaufel voll – ${Math.round(r.ml / 1000)} l. Zum Aufgabetrichter fahren und kippen (Rechtsklick / Q).`, 8);
    } else if (kind === "pour") {
      if (near && (this._pourT = (this._pourT || 0) - 1) <= 0) { this._pourT = 6; this.audio.play("exc_dump", { dist, strength: Math.min(1, 0.4 + r.ml / 60000) }); }
      if (this.effects && r.ml > 4000) { const at = ld.rig.lipWorld(this._lipV2 || (this._lipV2 = new THREE.Vector3())); this.effects.spill(at.x, at.y - 0.25, at.z, MATERIALS[0], 1.4); }
    } else if (kind === "poured") {
      this._pourT = 0;
      // the whole bucket at once (its pour ran in steps): what went in, where
      if (r.ml > 0 && r.kind === "intake" && this.processing.conveyor) {
        const cv = this.processing.conveyor;
        cv.stats.loads++;
        this.audio.play("sluice_feed", { dist, strength: 0.9 });
        if (this.cab) this.hud.message("Ausgekippt", `${Math.round(r.ml / 1000)} l im Aufgabetrichter (${Math.round(cv.volumeMl / 1000)} / ${Math.round(cv.capacityMl / 1000)} l)`);
      }
      if (r.full && r.rest > 1000 && this.cab) this.hud.tip("ldr-rest", `Voll – ${Math.round(r.rest / 1000)} l bleiben in der Schaufel.`, 5);
    } else if (kind === "wall") {
      if ((this._wallT = (this._wallT || 0) - 1) <= 0) { this._wallT = 40; if (near) this.audio.play("stone_scrape", { dist, strength: 0.8 }); }
    }
    this.dirty = true;
  }

  // the excavator's moments (from its animation): the cut, the tip, a blow, the attachment changed
  _excEvent(kind, r) {
    const ex = this.processing.excavator;
    if (!ex) return;
    const near = !!this.cab || Math.hypot(this.player.x - ex.x, this.player.z - ex.z) < 14;
    const dist = this.cab ? 1.2 : Math.max(1.5, Math.hypot(this.player.x - ex.x, this.player.z - ex.z));
    const at = ex.rig.teethWorld(this._tw || (this._tw = new THREE.Vector3()));
    if (kind === "cut") {
      if (r && r.ok) {
        if (near) this.audio.play("exc_scoop", { dist, strength: Math.min(1, 0.6 + (r.ml || 0) / 60000) });
        if (this.effects && r.kind === "dig") this.effects.impact({ x: at.x, y: at.y, z: at.z, normal: { x: 0, y: 1, z: 0 } }, r.material, "shovel", this._toolDir(), 1.5);
        if (r.kind === "dig" && ex.stats.scoops === 1) this.hud.tip("exc-first", "Ein Löffel sind gut 40 Liter – so viel wie ein paar Dutzend Schaufelstiche. Kippen: auf den Aufgabetrichter zielen, Rechtsklick / Q.", 10);
        if (ex.room < 2000 && this.cab) this.hud.tip("exc-full", "Löffel voll.", 3);
      } else if (r) {
        if (near) this.audio.play("stone_scrape", { dist, strength: 1 });
        this.hud.tip("exc-rock", r.material === MAT.STONE ? "Der Löffel rutscht über festen Fels – den bricht erst der Hydraulikhammer (oder die Spitzhacke)." : "Der Löffel kommt hier nicht hinein.", 8);
      }
    } else if (kind === "tip") {
      if (near) this.audio.play("exc_dump", { dist, strength: Math.min(1, 0.5 + (r.ml || 0) / 50000) });
      if (this.effects && r.ok) this.effects.spill(at.x, at.y - 0.2, at.z, MATERIALS[0], 1.2);
      if (r.ok && r.rest > 1000 && this.cab) this.hud.tip("exc-rest", `Nicht alles passte hinein – ${Math.round(r.rest / 1000)} l bleiben im Löffel.`, 4);
      if (r.kind === "spoil" && r.ok) this.hud.tip("exc-spoil", "Abraum auf der Halde zählt für den Bergauftrag – gewaschen wird er nicht.", 30);
    } else if (kind === "blow") {
      if (near) this.audio.play(r.fractured || r.broke ? "rock_fracture" : "exc_blow", { dist, strength: 1 });
      if (this.effects) this.effects.impact({ x: at.x, y: at.y, z: at.z, normal: { x: 0, y: 1, z: 0 } }, MAT.STONE, "pickaxe", this._toolDir(), 1.3);
    } else if (kind === "swap") {
      this.audio.play("barrow_bump", { dist: 1, strength: 0.8 });
      this.hud.message(r.attachment === "breaker" ? "Hydraulikhammer angebaut" : "Löffel angebaut", r.attachment === "breaker" ? "Fels und Felsbrocken brechen – danach mit dem Löffel das Geröll aufnehmen." : "Graben, aufnehmen, abkippen.");
      this.ui.setCab && this.ui.setCab(!!this.cab, ex.breaker);
    }
    this.dirty = true;
  }

  // working at the wash place: the camera stays at the trough / the screen,
  // mouse / touch movement is the work (swirl / shake) - see goldrush-processing.js
  _workUpdate(dt, look) {
    const p = this.player, pr = this.processing, wp = pr.workPose();
    if (!wp) { this._leaveWork(); return; }
    const k = Math.min(1, dt * 8);
    p.x += (wp.x - p.x) * k; p.z += (wp.z - p.z) * k;
    let dy = wp.yaw - p.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    p.yaw += dy * k;
    p.pitch += (wp.pitch - p.pitch) * k;
    p.vx = p.vz = 0;
    const ground = this.world.groundAt(p.x, p.z) + EYE;
    p.y += (ground - p.y) * Math.min(1, dt * 12);
    this._updateCamera(dt);
    this.target = null;
    this.ui.setCrosshair("idle");
    this.tools.blocked = true;
    this.tools.tick(dt, false);
    // the mouse belongs to the tool while it works (the gesture); settling / the result: to nothing (no look,
    // no tool) until E / a click ends it - Prompt 10, human QA: no camera jump after sieving
    const ev = pr.input(look.x, look.y, dt);
    if (ev === "pan-ready") { this.audio.play("flake", { dist: 0.3, strength: 0.7 }); this._haptic(10); }
    else if (ev && ev.kind === "cleaned") {
      this.audio.play("sluice_cleanout", { dist: 0.5 });
      this.hud.message(ev.tub ? "Matten gereinigt" : "Riffelmatte gereinigt", `${(ev.heavyMl / 1000).toFixed(1).replace(".", ",")} l Schwerkonzentrat ${ev.tub ? "in der Konzentratwanne an der Anlage" : "in der Schale am Waschtrog"}${ev.nuggets ? ` · ${ev.nuggets} Nugget${ev.nuggets > 1 ? "s" : ""} herausgepickt` : ""}`);
      if (ev.cents) this.hud.collected(ev.cents, FIND.NUGGET);
      this._bigFind(ev.bestUg);
      this.dirty = true;
    } else if (ev && ev.kind === "sieved") {
      this.audio.play("dump", { dist: 0.4, strength: 0.8 });
      const n = ev.retained.pieces;
      this.hud.message("Gesiebt", `${(ev.underMl / 1000).toFixed(1).replace(".", ",")} l Konzentrat in der Wanne${n ? ` · ${n} Nugget herausgepickt` : ""}`);
      if (ev.retained.cents) this.hud.collected(ev.retained.cents, FIND.NUGGET);
      this._bigFind(ev.retained.bestUg);
      this.dirty = true;
    }
    // click / tap on the result: collect the pan / end the sieve or the mat (while it still settles: as soon as it shows)
    const click = this.input.digHeld;
    if (click && !this._workClick && pr.workPhase === "settle" && pr.work !== "pan") this._workQueued = true;
    if (this._workQueued && pr.workPhase === "result") { this._workQueued = false; this._workClick = click; this._workAction(); return; }
    if ((pr.workPhase === "result" || (pr.work === "pan" && pr.panDone)) && click && !this._workClick) {
      this._workClick = click;
      if (pr.work === "pan") this._collectPan(); else this._leaveWork();
      return;
    }
    this._workClick = click;
    const touch = this.touch, confirm = touch ? "FERTIG tippen" : "[E] / Klick: fertig";
    if (pr.workPhase !== "gesture" && pr.work !== "pan") {
      const r = pr.workResult || {};
      if (pr.work === "sieve") this.hud.work(`Gesiebt · ${((r.underMl || 0) / 1000).toFixed(1).replace(".", ",")} l Konzentrat in der Wanne${pr.workPhase === "result" ? ` – ${confirm}` : ""}`);
      else this.hud.work(`${r.tub ? "Matten gereinigt · Schwerkonzentrat in der Wanne" : "Riffelmatte gereinigt · Schwerkonzentrat in der Schale"}${pr.workPhase === "result" ? ` – ${confirm}` : ""}`);
      return;
    }
    if (pr.work === "pan") {
      const n = pr.washName(true);
      this.hud.work(pr.panDone ? (touch ? `Gold liegt in der ${n} – EINSAMMELN tippen` : `Gold liegt in der ${n} – Klick oder [E]: einsammeln`)
        : touch ? `Mit dem Finger kreisen: ${n} schwenken` : `Maus kreisen lassen: ${n} schwenken · [E] aufhören`);
    }
    else if (pr.work === "clean") this.hud.work(touch ? "Mit dem Finger hin und her: Riffelmatte ausbürsten" : "Maus hin und her: Riffelmatte ausbürsten · [E] aufhören");
    else this.hud.work(touch ? "Mit dem Finger hin und her: Sieb rütteln" : "Maus hin und her: Sieb rütteln · [E] aufhören");
  }

  // looks and sounds bound to an action's phases (not to the contact)
  _phaseHooks() {
    const v = this.tools.view(), sig = `${v.state}:${v.phase}:${v.cycle}`;
    if (sig === this._lastPhase) return;
    this._lastPhase = sig;
    if (v.state !== "action") return;
    if (v.tool === "shovel" && v.phase === "dump" && this.lastStroke && this.lastStroke.massKg > 0) {
      // the load goes off the blade, to the right of the player - or into the bucket
      const c = this.camera, p = this.player, fw = this._fw.set(-Math.sin(p.yaw), 0, -Math.cos(p.yaw)), rt = this._rt.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
      let x = c.position.x + fw.x * 0.75 + rt.x * 0.45, z = c.position.z + fw.z * 0.75 + rt.z * 0.45;
      let y = Math.max(this.terrain.getHeightAt(x, z) + 0.2, c.position.y - 0.55);
      const into = this.lastStroke.intoBucket ? this.lastStroke.into : null, bk = into === "bucket" && this.processing.bucket, bw = into === "wheelbarrow" && this.processing.barrow;
      if (bk) { x = bk.x; z = bk.z; y = this.world.groundAt(x, z) + 0.42 * this.processing.bucketScale; }
      else if (bw) { const c = bw.trayCenter(); x = c.x; z = c.z; y = this.world.groundAt(x, z) + 0.62; }
      setTimeout(() => {
        if (this.disposed) return;
        this.effects.spill(x, y, z, MATERIALS[this.lastStroke ? this.lastStroke.material : 0] || MATERIALS[0], Math.min(1, 0.4 + (this.lastStroke ? this.lastStroke.massKg : 1) / 3));
        // (phase 8: as heavy as the load was)
        this.audio.play("dump", { pan: 0.4, dist: 0.6, strength: Math.min(1, 0.45 + (this.lastStroke ? this.lastStroke.massKg : 1) / 3.5) });
      }, 120);
    } else if ((v.tool === "pickaxe" && v.phase === "swing") || (v.tool === "shovel" && v.phase === "thrust")) {
      this.audio.play("swing", { dist: 0.3, strength: v.tool === "pickaxe" ? 1 : 0.6 });
    }
  }

  _fw = new THREE.Vector3();
  _rt = new THREE.Vector3();

  // which station is in front of the player (prompt / mobile button), the objective line
  _stationTick(dt) {
    const pr = this.processing;
    this._minerWatch();
    let s = null;
    if (this.cab) s = { id: "exc-exit", action: "Aussteigen", short: "AUSSTEIGEN", kind: "cab" };
    else if (this.placing) s = { id: "place-cancel", action: "Aufstellen abbrechen", short: "ABBRECHEN", kind: "place" };
    else if (!this.uiOpen && !pr.work) {
      const pi = pr.interaction(this.player);
      if (pi) s = { ...pi, kind: "process" };
      else { const st = this.stations.near(this.player.x, this.player.z, this.player.yaw); if (st) s = { ...st, kind: "station" }; }
      // Prompt 10: a stockpile in view - what it is and how much (contextual, no gold value)
      const ps = this.pileSeen;
      if (!s && ps && ps.volumeMl > 2000) s = { id: "pile-info", action: `${ps.def.label} ${m3Text(ps.volumeMl)}`, short: "", disabled: true, kind: "info" };
    }
    if (pr.work) s = pr.work === "pan" && pr.panDone ? { id: "pan-collect", action: "Gold einsammeln", short: "EINSAMMELN", kind: "work" } : { id: "work-stop", action: "", short: "FERTIG", kind: "work" };
    const sig = s ? `${s.kind}:${s.id}:${s.action}` : "";
    if (sig !== this._stationSig) {
      this._stationSig = sig;
      this.station = s && s.kind !== "work" ? s : null;
      this.hud.prompt(s && s.action ? s.action : null, this.touch || (s && s.disabled) ? "" : "E");
      this.ui.onStation && this.ui.onStation(s);
    }
    // where the material is (phase 8): bucket, barrow and the concentrate ready to pan - always in view
    // once you own them, the one in your hands highlighted; the chip below: the machines near you
    const b = pr.bucket, w = pr.barrow, sl = pr.sluice, P = this.player;
    const dS = sl ? Math.hypot(sl.root.position.x + 1.2 - P.x, sl.root.position.z - P.z) : Infinity;
    this.hud.materials(this._materialRow(pr));
    const cv = pr.conveyor && pr.conveyor.installed ? pr.conveyor : null, tr = pr.trommel && pr.trommel.installed ? pr.trommel : null;
    if (cv && Math.hypot(INTAKE.x - P.x, INTAKE.z - P.z) < 4.2) {
      // phase 9: the intake and the belt at a glance (the trommel's oversize when there is one)
      const st = cv.status(), parts = [`Aufgabe ${Math.round(cv.volumeMl / 1000)} / ${Math.round(cv.capacityMl / 1000)} l`];
      parts.push(st.key === "moving" ? `Band ${Math.round(cv.belt.rateLpm)} l/min` : st.key === "off" ? "Band aus" : st.key === "waiting" ? "Band wartet aufs Wasser" : st.key === "blocked" ? "Band steht (vorne voll)" : "Band läuft leer");
      if (tr) parts.push(`Trommel ${tr.status().key === "moving" ? "siebt" : tr.status().key === "blocked" ? "wartet" : "steht"}`);
      this.hud.load(parts.join(" · "));
      this.hud.loadEl.classList.toggle("is-full", st.key === "blocked" || cv.intake.room <= 200);
    } else if (pr.bulk && pr.bulk.installed && Math.hypot(BULK_AT.x - P.x, BULK_AT.z - P.z) < 4.6) {
      // the automation at a glance: store, feeder, the sluice's hopper, the riffles
      const bk = pr.bulk, fd = pr.feeder && pr.feeder.installed ? pr.feeder : null;
      const parts = [`Vorrat ${Math.round(bk.volumeMl / 1000)} / ${Math.round(bk.capacityMl / 1000)} l`];
      if (fd) { const st = fd.status(); parts.push(st.key === "moving" ? `Dosierer ${String(fd.rateLpm).replace(".", ",")} l/min` : st.key === "off" ? "Dosierer aus" : "Dosierer wartet"); }
      else if (bk.gateOpen) parts.push("Schieber offen");
      if (tr) { const ts = tr.status(); parts.push(ts.key === "moving" ? "Trommel siebt" : ts.key === "blocked" ? "Trommel wartet" : "Trommel steht"); if (tr.overMl > 50000) parts.push(`Überkorn ${m3(tr.overMl)}`); }
      if (sl && sl.installed) { parts.push(`Rinne ${Math.min(100, Math.round((sl.hopper.batch.volumeMl / sl.capacityMl) * 100))} %${sl.running ? "" : " (Wasser aus)"}`); parts.push(`Riffel ${Math.min(100, Math.round(sl.riffleLoad * 100))} %`); }
      this.hud.load(parts.join(" · "));
      this.hud.loadEl.classList.toggle("is-full", !!(sl && sl.riffleLoad >= 1));
    } else if (sl && sl.installed && dS < 4.2) {
      this.hud.load(`Trichter ${Math.round(sl.hopper.batch.volumeMl / 1000)} / ${Math.round(sl.capacityMl / 1000)} l · Riffel ${Math.min(100, Math.round(sl.riffleLoad * 100))} %${sl.running ? " · Wasser an" : ""}`);
      this.hud.loadEl.classList.toggle("is-full", sl.riffleLoad >= 1);
    } else this.hud.load(null);
    this._objT -= dt;
    if (this._objT <= 0) {
      this._objT = 0.5;
      this.hud.objective(this.uiOpen ? null : this._objective());
      // the board: repainted for every change of the ground since its last paint (others refresh the contract too -
      // the shop, the pause card - its own revision, not refresh()'s answer, decides)
      if (this.contract && this._boardRev !== this.terrain.revision) { this._boardRev = this.terrain.revision; this.stations.paintContract(this.contract.view()); }
    }
  }

  /**
   * Developer tools: stand somewhere else. The same rules as walking there:
   * inside the fence, pushed out of props and boulders, off walls, on the
   * ground at eye height, standing still. -> positionCheck()
   */
  teleport({ x, z, yaw, pitch }) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    if (this.processing.work) this._leaveWork();
    this.tools.cancel();
    this.input.releaseAll();
    const p = this.player;
    p.x = x; p.z = z;
    if (Number.isFinite(yaw)) p.yaw = yaw;
    if (Number.isFinite(pitch)) p.pitch = Math.max(-1.45, Math.min(1.45, pitch));
    p.vx = p.vz = 0; p.bob = 0; p.kick = 0;
    p.air = false; p.vy = 0; p.prep = 0; p.dip = 0; p.dipT = 1;              // (Prompt 10: never mid-jump after a teleport)
    for (let i = 0; i < 4; i++) { this.world.collide(p, RADIUS); this._keepOffWalls(); }
    this.world.collide(p, RADIUS);
    p.y = this.world.groundAt(p.x, p.z) + EYE;
    this._updateCamera();
    this._aim();
    this._stationSig = null;
    this._stationTick(0);
    this.dirty = true;
    if (!this.running) this.render();
    return this.positionCheck();
  }

  // where the player stands is a place one can stand (tests + teleport)
  positionCheck() {
    const p = this.player, b = this.world.bounds, eps = 0.02;
    const finite = [p.x, p.y, p.z, p.yaw, p.pitch].every(Number.isFinite);
    const inside = p.x >= b.minX - 1e-6 && p.x <= b.maxX + 1e-6 && p.z >= b.minZ - 1e-6 && p.z <= b.maxZ + 1e-6;
    let clear = true;
    for (const c of this.world.colliders) {
      if (c.type === "circle") { if (Math.hypot(p.x - c.x, p.z - c.z) < c.r + RADIUS - eps) clear = false; continue; }
      const cs = Math.cos(-c.rot), sn = Math.sin(-c.rot);
      const lx = (p.x - c.x) * cs - (p.z - c.z) * sn, lz = (p.x - c.x) * sn + (p.z - c.z) * cs;
      const dx = lx - Math.max(-c.hw, Math.min(c.hw, lx)), dz = lz - Math.max(-c.hd, Math.min(c.hd, lz));
      if (Math.hypot(dx, dz) < RADIUS - eps) clear = false;
    }
    const ground = this.world.groundAt(p.x, p.z);
    const onGround = Math.abs(p.y - (ground + EYE)) < 1e-3;
    return { ok: finite && inside && clear && onGround && p.vx === 0 && p.vz === 0, x: p.x, z: p.z, y: p.y, ground, inside, clear, onGround };
  }

  // the new tool is in the hands now
  _swapped() {
    this.audio.play("swap", { dist: 0.3 });
    this.ui.onTool && this.ui.onTool(this.toolState());
    this._aim();
  }

  // a wall right in front of the eyes (a stone pillar, a pit edge): step back
  // instead of letting the camera slide into it
  _keepOffWalls() {
    const p = this.player, t = this.terrain, eye = t.getHeightAt(p.x, p.z) + EYE;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2, dx = Math.cos(a) * 0.3, dz = Math.sin(a) * 0.3;
      if (t.getHeightAt(p.x + dx, p.z + dz) > eye - 0.2) { p.x -= dx * 0.15; p.z -= dz * 0.15; }
    }
  }

  // ------------------------------------------------------------ the jump (Prompt 10, human QA)
  // Space: only from the ground (feet on it, not sliding down a drop), never twice in the air, not again
  // straight after a landing; never with the barrow in your hands (the engine's machine / work branches never
  // get here). A short dip first (anticipation), then the push-off.
  _jumpPress(g0, bw) {
    const p = this.player;
    if (bw) { this.hud.tip("jump-barrow", "Mit der Schubkarre in den Händen wird nicht gesprungen.", 4); return; }
    const grounded = !p.air && p.prep <= 0 && Math.abs(p.y - (g0 + EYE)) < 0.16;   // (walking down a slope the eye trails a little)
    if (!grounded || p.cool > 0) return;
    p.prep = this.reducedMotion ? 0.001 : JUMP.prep;
    this._dipStart(0.03, JUMP.prep * 2.2);
  }

  _jumpOff() {
    const p = this.player;
    p.prep = 0;
    if (this.processing.pushing || this.cab || this.processing.work) return;
    p.air = true;
    p.vy = JUMP.v0;
    p.jumps++;
    p.apex = p.jumpFrom = p.y;
    this.audio.play("jump", { dist: 0.3, strength: 0.6 + 0.4 * Math.min(1, Math.hypot(p.vx, p.vz) / SPRINT) });
    if (this.hands && !this.reducedMotion) this.hands.sway.y = Math.max(-0.03, this.hands.sway.y - 0.018);   // the arms lag below
  }

  _airborne(dt, ground) {
    const p = this.player;
    p.vy -= JUMP.g * (p.vy > 0 ? 1 : JUMP.fallK) * dt;
    p.y += p.vy * dt;
    if (p.y > p.apex) p.apex = p.y;
    if (p.y > ground || p.vy > 0) return;
    // the landing: feet on the ground, the knees give (the view dips and comes back), the step costs you some speed
    const impact = -p.vy;
    p.y = ground;
    p.air = false;
    p.vy = 0;
    p.cool = JUMP.cool;
    p.lands++;
    p.lastJump = { height: +(p.apex - (p.jumpFrom != null ? p.jumpFrom : p.apex)).toFixed(3), impact: +impact.toFixed(2) };
    p.vx *= JUMP.landKeep; p.vz *= JUMP.landKeep;
    this._dipStart(Math.min(JUMP.dipMax, 0.016 * impact), JUMP.dipS);
    this.audio.play("land", { dist: 0.25, strength: Math.min(1, 0.35 + impact / 5) });
    if (this.hands && !this.reducedMotion) this.hands.sway.y = Math.max(-0.03, this.hands.sway.y - Math.min(0.03, 0.007 * impact));
    if (impact > 3.5) this._haptic(12);
  }

  _dipStart(a, s) { const p = this.player; if (this.reducedMotion) return; p.dipA = a; p.dipT = 0; p.dipS = s; }
  _dipUpdate(dt) {
    const p = this.player;
    if (p.dipT >= 1) { p.dip = 0; return; }
    p.dipT = Math.min(1, p.dipT + dt / (p.dipS || 0.2));
    const t = p.dipT;                                                 // down fast, up slower (a knee, not a spring)
    p.dip = p.dipA * (t < 0.3 ? Math.sin((t / 0.3) * Math.PI / 2) : Math.cos(((t - 0.3) / 0.7) * Math.PI / 2) ** 2);
  }

  _updateCamera() {
    const p = this.player, cam = this.camera;
    const bobOn = this.settings.headBob && !this.reducedMotion;
    const amp = bobOn && !p.air ? Math.min(1, Math.hypot(p.vx, p.vz) / WALK) : 0;
    const by = Math.sin(p.bob * 2) * 0.022 * amp, bx = Math.cos(p.bob) * 0.012 * amp;
    cam.position.set(p.x + Math.cos(p.yaw) * bx, p.y + by - (p.dip || 0), p.z - Math.sin(p.yaw) * bx);
    cam.rotation.y = p.yaw;
    cam.rotation.x = p.pitch - (this.reducedMotion ? 0 : p.kick);
  }

  // what the crosshair is on: the mound (or a boulder), how far, which material
  _aim() {
    const p = this.player, cam = this.camera;
    const cp = Math.cos(p.pitch);
    const dx = -Math.sin(p.yaw) * cp, dy = Math.sin(p.pitch), dz = -Math.cos(p.yaw) * cp;
    const ox = cam.position.x, oy = cam.position.y, oz = cam.position.z;
    let hit = this.terrain.raycast(ox, oy, oz, dx, dy, dz, SEE);
    const b = this.rocks.raycast(ox, oy, oz, dx, dy, dz, hit ? hit.distance : SEE, this._hit);
    if (b) hit = b;
    else if (hit) hit.boulder = null;
    let state = "idle";
    this.target = null;
    const def = this.tools.def;
    // Prompt 10: a stockpile's surface in front of the ground - the hand / the shovel take from it (into the
    // bucket / barrow / intake next to you; with nothing to catch it, nothing happens)
    const piles = this.processing.piles, ph = piles ? piles.raycast(ox, oy, oz, dx, dy, dz, hit ? hit.distance : SEE) : null;
    this.pileSeen = ph && ph.distance < 9 ? ph.pile : null;
    if (ph && ph.distance <= (def.reach || 2.4)) {
      this.target = { x: ph.x, y: ph.y, z: ph.z, distance: ph.distance, normal: { x: 0, y: 1, z: 0 }, pile: ph.pile, diggable: true, boulder: null };
      this.farTarget = null;
      state = "dig";
      this.aimState = state;
      this.reticle.visible = false;
      this.ui.setCrosshair && this.ui.setCrosshair(state);
      return;
    }
    if (hit && hit.diggable) {
      const why = this.mining.check(hit, def, p);
      hit.material = this.mining.materialAtHit(hit);
      if (why === "far") state = "far";
      else if (why === "feet") state = "idle";
      else {
        this.target = hit;
        state = this.mining.efficiencyAtHit(hit, def) > 0 ? "dig" : "hard";
      }
      this.farTarget = why === "far" ? hit : null;
    } else this.farTarget = null;
    this.aimState = state;
    if (state === "hard" && !this.economy.flags.hardSeen) this.economy.flags.hardSeen = true;   // stone / a boulder right in front of you
    const r = this.reticle;
    if (this.target && this.target.boulder == null) {
      const n = this.target.normal;
      r.position.set(this.target.x + n.x * 0.012, this.target.y + n.y * 0.012, this.target.z + n.z * 0.012);
      r.quaternion.setFromUnitVectors(ZUP, this._n.set(n.x, n.y, n.z));
      // quiet: a thin ring the size of the bite on diggable ground, a small
      // grey one on stone - the world stays the main thing on screen
      const hard = state === "hard";
      r.scale.setScalar(hard ? 0.07 : Math.max(def.kernel.a, def.kernel.b) * 0.8);
      r.material.color.setHex(hard ? 0xc9c3ba : 0xfff3d6);
      this._reticleWant = hard ? 0.3 : 0.2;
      r.visible = true;
    } else {
      r.visible = false;
      r.material.opacity = 0;
    }
    this.ui.setCrosshair(state);
  }

  _n = new THREE.Vector3();

  // the first time a streak comes to light: what it is, what it means (no gold shown - you find out)
  _streakSeen(hit) {
    const id = this.terrain.field.streakIdAt(hit.x, hit.y - 0.01, hit.z);
    if (!this.economy.foundStreak(id)) return;
    this.hud.message("Mineralisierte Zone", "Rostiger, verfestigter Kies mit Quarzadern und dunklem Schwersand – solche Lagen halten oft mehr Gold.");
    this.audio.play("crack", { dist: 0.4, strength: 0.5 });
    this.feedback = (this.feedback || 0) + 1;
    this.dirty = true;
  }

  // the pick into solid stone (phase 8): every hit shows - a chip and a crack that grows; a few
  // hits and the patch breaks into rubble (a burst, a heavier sound, a short hold of the blow)
  _stoneCrack(hit, r, dir, pan, dist) {
    const c = r.crack;
    if (c.fractured) {
      this.audio.play("rock_fracture", { pan, dist });
      this.effects.impact(hit, MAT.STONE, "rock", dir, 1.3);
      this._haptic([16, 30, 20]);
      this.hands.hitStop && this.hands.hitStop(0.07);
      this.hud.tip("stone-broken", "Der Fels ist gebrochen – das Geröll lässt sich jetzt schaufeln (oder mit der Hacke weiter lösen).", 30);
    } else {
      this.audio.play("rock_chip", { pan, dist, strength: 0.7 + 0.3 * c.level });
      this.effects.impact(hit, MAT.STONE, "pickaxe", dir, 0.7 + 0.5 * c.level);
      this.hands.hitStop && this.hands.hitStop(0.045);
      if (c.level > 0) this.hud.tip("stone-crack", "Fester Fels – jeder Hieb lässt ihn weiter reißen. Noch ein paar Schläge, dann bricht er.", 30);
    }
  }

  _hintNoTarget() {
    if (this.farTarget) this.hud.tip("far", "Zu weit entfernt – geh näher heran.", 5);
  }

  // the tool meets the ground now: the whole mining transaction
  _contact() {
    if (this._sampleArm) { this._sampleArm = false; this._sampleContact(); return; }     // phase 9: [R] a sample
    this._aim();                                   // what is under the tool at this very moment
    const hit = this.target, def = this.tools.def;
    if (!hit) {
      this.tools.react("air");
      this.hands.contact("air");
      this.audio.play("air");
      return;
    }
    if (hit.pile) { this._pileContact(hit, def); return; }
    const r = this.mining.action(hit, def, this.player, this.camera.position);
    this.economy.recordAction(r, def.id);
    const pan = this._pan(hit), dist = hit.distance;
    if (!r.ok) { this.tools.react("air"); this.hands.contact("air"); return; }
    const kicks = KICK[def.id] || KICK.hand, haptics = HAPTIC[def.id] || HAPTIC.hand;
    const dir = this._toolDir();
    if (r.kind === "rock") {
      // the pickaxe on a boulder: chips, a clank, the boulder cracks / breaks apart
      const rk = r.rock;
      this.tools.react("ok", MAT.STONE);
      this.hands.contact("blocked", MAT.STONE);
      this.effects.impact(hit, MAT.STONE, rk && rk.broke ? "rock" : "pickaxe", dir, rk && rk.broke ? 1.4 : 0.9);
      this.audio.play("pickaxe_stone", { pan, dist });
      if (rk && rk.broke) this.audio.play("rock_break", { pan, dist });
      else if (rk && rk.stage !== "intact") this.audio.play("crack", { pan, dist, strength: 0.8 });
      this._haptic(rk && rk.broke ? [18, 40, 26] : haptics[MAT.STONE]);
      if (!this.reducedMotion) this.player.kick = Math.min(0.04, this.player.kick + kicks[MAT.STONE] * (rk && rk.broke ? 1.3 : 1));
      if (rk && rk.broke) this.hud.tip("rock-broken", "Felsbrocken zerschlagen – der Weg ist frei.", 20);
      this.lastStroke = { tool: def.id, kind: "rock", material: MAT.STONE, massKg: 0, rock: rk, finds: 0, cents: 0 };
      this.dirty = true;
      return;
    }
    if (r.blocked) {
      const cem = r.cemented && hit.boulder == null, bm = cem ? r.material : MAT.STONE;   // cemented gravel / clay: a dull thud, no sparks
      this.tools.react("blocked", bm);
      this.hands.contact("blocked", bm);
      this.effects.impact(hit, bm, def.id, dir, cem ? 0.35 : 0.5);
      // solid stone: the shovel skids, steel grinding on rock (phase 8)
      this.audio.play(!cem && def.id === "shovel" ? "stone_scrape" : DIG_SOUND[def.id] ? DIG_SOUND[def.id][bm] : "stone", { pan, dist, strength: def.id === "hand" ? 1 : 0.8 });
      this._haptic(haptics[bm]);
      if (cem) { this._streakSeen(hit); this.hud.tip("cemented-hand", "Verfestigter, rostiger Kies – mit bloßen Händen keine Chance. Die Spitzhacke bricht ihn auf.", 10); }
      else if (STONE_TIP[def.id]) this.hud.tip(`stone-${def.id}`, STONE_TIP[def.id], 10);
      this.ui.crosshairPulse && this.ui.crosshairPulse("hard");
      if (!this.reducedMotion) this.player.kick = Math.min(0.03, this.player.kick + kicks[MAT.STONE] * 0.5);
      this.lastStroke = { tool: def.id, kind: "blocked", material: hit.boulder != null ? MAT.STONE : r.material, massKg: 0, blocked: true, finds: 0, cents: 0 };
      this.dirty = true;
      return;
    }
    const mdef = MATERIALS[r.material];
    if (r.crack) this._stoneCrack(hit, r, dir, pan, dist);
    this.tools.react("ok", r.material);
    if (def.id === "shovel") { const c = mdef.fragmentColor; this.hands.models.loadRgb = [c[0] * 1.2, c[1] * 1.2, c[2] * 1.2]; }
    this.hands.contact("ok", r.material, r.removedMassKg);
    this.effects.impact(hit, r.material, def.id, dir, Math.min(1.5, 0.6 + r.removedMassKg / 2.5));
    // broken stone (rubble) sounds like the coarse gravel it now is; the pick's own crack has its sound
    const soundMat = r.material === MAT.STONE && r.rubble && def.id !== "pickaxe" ? MAT.GRAVEL : r.material;
    const kind = r.crack && !r.crack.fractured ? null : (DIG_SOUND[def.id] || DIG_SOUND.hand)[soundMat] || "hand_dirt";
    if (kind) this.audio.play(kind, { pan, dist, strength: def.id === "hand" ? Math.min(1, 0.6 + r.removedMassKg * 2) : Math.min(1, 0.6 + r.removedMassKg / 3) });
    this._haptic(haptics[r.material] || mdef.haptic);
    if (!this.reducedMotion) this.player.kick = Math.min(0.03, this.player.kick + (kicks[r.material] || kicks[0]));
    this._trickleAfter(hit, r.material);
    this.ui.onDig && this.ui.onDig();
    // a mineralised streak: told once per streak; the shovel's limit in it now and then
    if (r.streak > 0.3) this._streakSeen(hit);
    // GoldRush 9.1: the camp's apron is fill - next to no gold (on purpose); said once per mine, then a short
    // reminder now and then while you keep digging in it (the natural ground starts about half a metre down)
    const fld = this.terrain.field;
    if (fld.inFill && fld.inFill(hit.x, hit.y, hit.z, this.terrain.getBaseHeightAt(hit.x, hit.z))) {
      if (!this.economy.flags.fillSeen) {
        this.economy.flags.fillSeen = true;
        this.hud.message("Aufgeschütteter Lagerplatz", "Verdichteter Fremdboden – hier liegt kaum Gold. Gewachsener Boden beginnt etwa einen halben Meter tiefer; der Berg lohnt sich.");
      } else this.hud.tip("camp-fill", "Lagerplatz-Aufschüttung: kaum Gold.", 120);
    }
    if (r.cemented && def.id !== "pickaxe") this.hud.tip("cemented", "Verfestigter Kies – die Schaufel rutscht ab. Erst mit der Spitzhacke lockern, dann schaufeln.", 12);
    // into the bucket / barrow next to you (with its fine gold and its pieces - washing gets them
    // out), or spoil: then its finds come out of the ground now (pending), shown (loot), money on pickup
    const routed = this.processing.collect(r, this.player, def.id);
    this._intoBucket(routed);
    if (def.id === "shovel" && r.removedMassKg > 0.05) this._release = { t: 0.3, mat: r.material, into: routed.intoMl > 0 ? routed.into : null, kg: r.removedMassKg };
    const disc = this.economy.discover(routed.finds, routed.count);
    if (disc.items.length) {
      if (disc.firstNugget) for (const it of disc.items) if (it.cls === FIND.NUGGET) { it.first = true; break; }
      this.loot.spawn(disc.items, hit);
      const best = disc.best;
      // (a big nugget: its tier's sound now, its line when it reaches the hand - Prompt 10)
      if (!this._bigFind(disc.bestUg, { toast: false, pan, dist })) {
        this.audio.play(best === FIND.NUGGET ? "nugget" : best === FIND.TINY ? "tiny" : best === FIND.FLAKE ? "flake" : "dust", { pan, dist });
        if (best === FIND.NUGGET) this._haptic([14, 50, 24]);
      }
    }
    this.lastStroke = this._strokeInfo(def, r, disc);
    this.lastStroke.intoBucket = routed.intoMl > 0;
    this.lastStroke.into = routed.into;
    this.dirty = true;
  }

  // the shovel's load sliding off the blade: into the bucket / barrow it went (at its rim), else thrown
  // aside in front of you (the blade as it comes up: below and right of the view's centre)
  _shovelRelease(rl) {
    if (!this.effects) return;
    const pr = this.processing, def = MATERIALS[rl.mat] || MATERIALS[0], k = Math.min(0.8, 0.3 + rl.kg / 4);
    if (rl.into === "wheelbarrow" && pr.barrow) { const c = pr.barrow.trayCenter(); this.effects.spill(c.x, this.world.groundAt(c.x, c.z) + 0.62, c.z, def, k); return; }
    if (rl.into === "bucket" && pr.bucket) { const b = pr.bucket; this.effects.spill(b.x, this.world.groundAt(b.x, b.z) + 0.34 * pr.bucketScale, b.z, def, k); return; }
    const p = this.player, cp = Math.cos(p.pitch), fx = -Math.sin(p.yaw) * cp, fz = -Math.cos(p.yaw) * cp, rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
    const x = p.x + fx * 0.75 + rx * 0.22, z = p.z + fz * 0.75 + rz * 0.22;
    this.effects.spill(x, Math.max(this.world.groundAt(x, z) + 0.15, this.camera.position.y - 0.55), z, def, k);
  }

  // the bucket caught a dig: a puff at its rim (hand / pickaxe; the shovel dumps into it), a tip once it is full
  _intoBucket(routed) {
    if (!(routed.intoMl > 0)) return;
    const pr = this.processing, b = pr.bucket, w = pr.barrow;
    if (routed.into === "wheelbarrow" && w) {
      if (this.tools.equipped !== "shovel" && this.effects) { const c = w.trayCenter(); this.effects.spill(c.x, this.world.groundAt(c.x, c.z) + 0.55, c.z, MATERIALS[0], 0.25); }
      if (pr.fullNow && !this._fullTold) { this._fullTold = true; this.hud.tip("barrow-full", pr.sluice && pr.sluice.installed ? "Schubkarre voll – greifen und zum Trichter der Waschrinne schieben." : "Schubkarre voll – greifen und an den Waschplatz schieben.", 12); }
    } else if (b) {
      if (this.tools.equipped !== "shovel" && this.effects) this.effects.spill(b.x, this.world.groundAt(b.x, b.z) + 0.3 * pr.bucketScale, b.z, MATERIALS[0], 0.25);
      else this.audio.play("bucket_fill", { dist: 1, strength: 0.6 });
      if (pr.fullNow && !this._fullTold) { this._fullTold = true; this.hud.tip("bucket-full", "Eimer voll – ab zum Waschplatz beim Wassertank.", 12); }
    }
    if (!pr.fullNow) this._fullTold = false;
  }

  _strokeInfo(def, r, disc) {
    return {
      tool: def.id, kind: r.kind, material: r.material, massKg: +r.removedMassKg.toFixed(4), freshKg: +r.freshKg.toFixed(4), slices: r.slices,
      requestedL: +(r.requestedVolume * 1000).toFixed(4), removedL: +(r.removedVolume * 1000).toFixed(4), relocatedL: +(r.relocatedVolume * 1000).toFixed(4),
      processedL: +(r.processedVolume * 1000).toFixed(4), finds: disc.items.length, cents: disc.cents, best: FIND_IDS[disc.best], cells: r.cells, chunks: r.chunks,
    };
  }

  // the transaction without the animation (tests, simulation); tool = id
  // (default: the one in the hands; it must be usable)
  strokeAtCrosshair({ visuals = true, tool = null } = {}) {
    this._aim();
    const hit = this.target;
    if (!hit) return null;
    const id = tool && this.tools.canUse(tool) ? tool : this.tools.equipped;
    const def = this.tools.defOf(id);                    // with the upgrades the player owns
    if (hit.distance > def.reach) return null;
    const r = this.mining.action(hit, def, this.player, this.camera.position);
    this.economy.recordAction(r, def.id);
    const base = { ok: r.ok, kind: r.kind, blocked: r.blocked, material: r.material, rock: r.rock, cents: 0, finds: 0, massKg: 0, cemented: !!r.cemented, streak: r.streak || 0 };
    // a mineralised streak touched for the first time (the bench / trace counts it as a moment)
    if (r.ok && r.streak > 0.3) base.streakFound = this.economy.foundStreak(this.terrain.field.streakIdAt(hit.x, hit.y - 0.01, hit.z));
    if (!r.ok || r.blocked || r.kind === "rock") { this.dirty = true; this.lastStroke = { tool: id, kind: r.kind, massKg: 0 }; return base; }
    const routed = this.processing.collect(r, this.player, id);
    const disc = this.economy.discover(routed.finds, routed.count);
    if (visuals) {
      this.effects.impact(hit, r.material, id, this._toolDir(), Math.min(1.5, 0.6 + r.removedMassKg / 2.5));
      if (disc.items.length) {
        if (disc.firstNugget) for (const it of disc.items) if (it.cls === FIND.NUGGET) { it.first = true; break; }
        this.loot.spawn(disc.items, hit);
      }
    } else if (disc.items.length) {
      for (const it of disc.items) this._collected({ cls: it.cls, cents: it.cents, find: it, silent: true });
    }
    this.lastStroke = this._strokeInfo(def, r, disc);
    this.lastStroke.intoBucket = routed.intoMl > 0;
    this.lastStroke.into = routed.into;
    this.dirty = true;
    return {
      ...base, cents: disc.cents, finds: disc.items.length, best: disc.best, massKg: r.removedMassKg, massByMat: [...r.massByMat], slices: r.slices, cells: r.cells,
      fineUg: r.fineUg, intoMl: routed.intoMl, spilledMl: routed.spilledMl, intoG: routed.intoG, spilledG: routed.spilledG, intoUg: routed.intoUg,
      // every piece the dig took out of the ground (found now or carried in the container - 7B ledger audit)
      digFinds: Array.from({ length: r.findCount }, (_, i) => ({ key: r.finds[i].key, cls: r.finds[i].cls, ug: r.finds[i].massUg })), intoFinds: routed.intoFinds,
      volumeMl: Math.round(r.removedVolume * 1e6), massG: [0, 1, 2, 3].reduce((a, m) => a + Math.round(r.massByMat[m] * 1000), 0),
      requested: r.requestedVolume, removed: r.removedVolume, relocated: r.relocatedVolume, processed: r.processedVolume,
      keys: disc.items.map((i) => i.key), ids: disc.items.map((i) => i.id),
    };
  }

  // a piece (or dust) reached the player: into the gold pouch (no cash yet)
  _collected(item) {
    const f = item.find;
    const it = f && f.id != null ? this.economy.collect(f.id) : null;
    if (!it) return;                                     // already in the pouch (never twice)
    this.hud.collected(it.cents, it.cls);
    if (it.cls === FIND.NUGGET) this.hud.nugget(it.cents, !!(f && f.first), jackpotTier(it.massUg));
    this.dirty = true;
    if (item.silent) return;
    if (it.cls >= FIND.FLAKE) {
      this.audio.play("pickup", { dist: 0.3 });
      this.hands.pickupPulse();
      this._haptic(8);
    }
  }

  _nuggetInHand(item) {
    this.audio.play("pickup", { dist: 0.2 });
    const tq = jackpotTier(item.find ? item.find.massUg || 0 : 0);              // (a big one: held up a little longer)
    this.hands.inspect(this.loot.nuggetLook(item), INSPECT_S * (tq >= 2 ? 1.8 : tq >= 0 ? 1.35 : 1), () => this.loot.finish(item));
  }

  // Prompt 10: the moment of a big nugget by its tier (JACKPOT) - EUR 5-12 a fuller ring, EUR 12-30 its own short
  // sound, from EUR 30 a short sting and "Großer Goldfund – EUR …" - wherever it comes out: the ground (the sound at
  // the dig, the line in the hand), the pan, the sieve, the mats, the trommel's trap. -> true when it was one
  _bigFind(ug, { toast = true, pan = 0, dist = 0.3 } = {}) {
    const tier = ug > 0 ? jackpotTier(ug) : -1;
    if (tier < 0) return false;
    this.audio.play(tier >= 2 ? "nugget_jackpot" : tier === 1 ? "nugget_rare" : "nugget_big", { pan, dist });
    this._haptic(tier >= 2 ? [20, 60, 30, 60, 40] : [16, 50, 28]);
    if (toast) this.hud.nugget(centsForMass(ug), false, tier);
    this.lastBigFind = { ug, tier, cents: centsForMass(ug) };
    return true;
  }

  // Prompt 10: a nugget too big for the trommel's screen dropped into its trap (it waits there - goldrush-plant.js)
  _trapped(finds) {
    const p = this.player, d = Math.hypot(p.x - TRAP.x, p.z - TRAP.z);
    this.audio.play("nugget_trap", { dist: Math.min(8, 0.6 + d / 3) });
    this.hud.message("Nuggetfalle an der Trommel", `${finds.length > 1 ? `${finds.length} große Nuggets` : "Ein großer Nugget"} – zu groß fürs Sieb. Er liegt in der Falle unter dem Trommelende: dort herausnehmen.`);
    this.dirty = true;
  }

  // everything still flying / lying around is booked now
  flushLoot() {
    if (!this.loot) return;
    if (this.hands) this.hands.endInspect();
    this.loot.flush();
    this.economy.collectAll();                          // anything pending that was never shown
    this.hud.settle(this.economy.cashCents, this.economy.pouchCents);
  }

  // the tool's motion into the ground: where the crosshair looks (dig effects throw relative to it)
  _toolDir() {
    const p = this.player, cp = Math.cos(p.pitch);
    return this._dir.set(-Math.sin(p.yaw) * cp, Math.sin(p.pitch), -Math.cos(p.yaw) * cp);
  }

  // a cut into a steep face: a few crumbs trickle down it a moment later (visual only -
  // the ground, its mass and its gold are not touched)
  _trickleAfter(hit, mat) {
    if (mat === MAT.STONE || this._trickleCool > performance.now()) return;
    const T = this.terrain, d = 0.15;
    const gx = (T.getHeightAt(hit.x - d, hit.z) - T.getHeightAt(hit.x + d, hit.z)) / (2 * d);
    const gz = (T.getHeightAt(hit.x, hit.z - d) - T.getHeightAt(hit.x, hit.z + d)) / (2 * d);
    const sl = Math.hypot(gx, gz);
    if (sl < 0.7) return;                                   // ~35 degrees and steeper
    const x = hit.x - (gx / sl) * 0.22, z = hit.z - (gz / sl) * 0.22;
    // a really steep fresh face (phase 7A): a little more runs down, a moment later a second trickle beside it
    const steep = sl > 1.1;
    if (this.effects.queueTrickle(x, T.getHeightAt(x, z) + 0.012, z, gx / sl, gz / sl, mat, 0.25 + Math.random() * 0.6)) this._trickleCool = performance.now() + (steep ? 450 : 700);
    if (steep) {
      const sx = x + (gz / sl) * 0.14, sz = z - (gx / sl) * 0.14;
      this.effects.queueTrickle(sx, T.getHeightAt(sx, sz) + 0.012, sz, gx / sl, gz / sl, mat, 0.7 + Math.random() * 0.7);
    }
  }

  _dir = new THREE.Vector3();

  _pan(hit) {
    const p = this.player, dx = hit.x - p.x, dz = hit.z - p.z;
    return Math.max(-1, Math.min(1, (dx * Math.cos(p.yaw) - dz * Math.sin(p.yaw)) / Math.max(0.5, Math.hypot(dx, dz))));
  }

  _haptic(pattern) {
    if (!this.touch || this.settings.vibration === false || !this.userActed || !navigator.vibrate) return;
    try { navigator.vibrate(pattern); } catch (e) { /* ignore */ }
  }

  // is the player (their hands) in the mound's shadow? a few times per second
  _sunCheck(dt) {
    this._sunT -= dt;
    if (this._sunT > 0) return;
    this._sunT = 0.25;
    const c = this.camera.position;
    this.sunVisible = !this.terrain.raycast(c.x, c.y - 0.3, c.z, SUN_VEC.x, SUN_VEC.y, SUN_VEC.z, 25);
  }

  // ------------------------------------------------------------ input / pause

  _lockChanged(locked, failed) {
    if (this.touch) return;
    if (failed && !locked && !this.input.everLocked) {
      // this browser / frame gives no pointer lock at all: play on with the
      // free mouse (right-button drag looks) instead of a pause card that
      // can never be dismissed. (A refusal after the lock once worked is
      // transient - e.g. Chrome right after Esc - and just asks again.)
      this.input.free = true;
      this.setPaused(false);
      this.ui.showPauseOverlay(false);
      if (!this._freeNotice) {
        this._freeNotice = true;
        this.ui.notice("Dein Browser gibt die Maus nicht frei: rechte Maustaste halten und ziehen zum Umsehen.");
      }
      return;
    }
    if (locked) { this.input.free = false; this.setPaused(false); }
    else if (!this.ui.panelOpen()) this.setPaused(true);
    this.ui.showPauseOverlay(!locked && !this.ui.panelOpen(), failed);
  }

  // ------------------------------------------------------------ size

  resize() {
    if (!this.renderer || this.disposed) return;
    const r = this.ui.root.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = fovFor(w / h);
    this.camera.updateProjectionMatrix();
    this.hands.setAspect(w / h, this.camera.fov);
    const db = this.renderer.getDrawingBufferSize(this._v2);
    const px = db.y / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.effects.setScale(px);
    this.loot.setScale(px);
    if (!this.running) this.render();
  }

  // ------------------------------------------------------------ save

  buildDoc() {
    const p = this.player;
    return {
      saveVersion: SAVE_VERSION,
      worldSeed: this.doc.worldSeed,
      createdAt: this.doc.createdAt,
      updatedAt: Date.now(),
      tools: this.tools.serialize(),
      player: { x: round3(p.x), z: round3(p.z), yaw: round3(p.yaw), pitch: round3(p.pitch) },
      economy: this.economy.serialize(),
      terrain: this.terrain.serialize(),
      resources: this.mining.serialize(),
      rocks: this.rocks.serialize(),
      processing: this.processing.serialize(),
      geology: { ...(this.doc.geology || { version: GEOLOGY_VERSION }) },
      prospect: this.processing.prospect ? this.processing.prospect.serialize() : null,
      ...(this.devModified ? { devModified: true, devModifiedAt: this.devModifiedAt } : {}),
    };
  }

  save(reason = "manual") {
    if (!this.ready) return 0;                     // never overwrite a save with a half-built game
    if (this.disposed && reason !== "exit") return 0;
    try {
      const bytes = this.ui.writeSave(this.buildDoc());
      this.dirty = false;
      this.lastSave = performance.now();
      this.lastSaveBytes = bytes;
      this.saveFailed = false;
      return bytes;
    } catch (e) {
      if (!this.saveFailed) this.ui.notice("Spielstand konnte nicht gespeichert werden (Speicher voll oder blockiert).");
      this.saveFailed = true;
      return 0;
    }
  }

  // ------------------------------------------------------------ debug

  frameStats() {
    const f = this.frameMs;
    if (!f.length) return { fps: 0, frameMs: 0, p95: 0 };
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    const s = [...f].sort((a, b) => a - b);
    return { fps: Math.round(1000 / avg), frameMs: +avg.toFixed(2), p95: +s[Math.floor(s.length * 0.95)].toFixed(2) };
  }

  info() {
    const r = this.renderer.info, t = this.terrain.stats();
    const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
    return {
      ...this.frameStats(), drawCalls: this.frameCalls || r.render.calls, triangles: this.frameTris || r.render.triangles,
      geometries: r.memory.geometries, textures: r.memory.textures, programs: r.programs ? r.programs.length : 0,
      particles: this.effects.activeDust, fragments: this.effects.activeFrags,
      loot: this.loot.active, glints: this.loot.activeGlints, sceneObjects: this.world.scene.children.length,
      chunks: t.chunks, terrainTriangles: t.triangles, heapMB: mem, level: this.level, dpr: this.dpr, fov: +this.camera.fov.toFixed(1),
      gpu: this.gpu && this.gpu.gpu, saveBytes: this.lastSaveBytes, tool: this.tools.equipped, toolState: this.tools.state,
    };
  }

  // what the world pass draws (debug / performance tests): visible renderables in the camera's
  // frustum and the shadow casters, grouped by the scene's top-level parts (their names)
  drawStats() {
    const cam = this.camera, fr = new THREE.Frustum(), m = new THREE.Matrix4();
    cam.updateMatrixWorld();
    m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    fr.setFromProjectionMatrix(m);
    const groups = new Map(), scene = this.world.scene;
    let main = 0, shadow = 0;
    scene.traverseVisible((o) => {
      if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
      if (o.isInstancedMesh && o.count === 0) return;
      let top = o;
      while (top.parent && top.parent !== scene) top = top.parent;
      const key = top.name || `${top.type}#${scene.children.indexOf(top)}`;
      const g = groups.get(key) || { key, main: 0, shadow: 0, objs: 0 };
      g.objs++;
      if (!o.frustumCulled || fr.intersectsObject(o)) { g.main++; main++; }
      if (o.castShadow) { g.shadow++; shadow++; }
      groups.set(key, g);
    });
    return { main, shadow, groups: [...groups.values()].sort((a, b) => b.main + b.shadow - a.main - a.shadow) };
  }

  // what is under the crosshair right now (debug panel, tests)
  probe() {
    const hit = this.target || this.farTarget;
    if (!hit) return null;
    const f = this.terrain.field, y = hit.y - 0.02;
    const mat = hit.boulder != null || this.mining.rubbleAtHit(hit) ? MAT.STONE : f.materialAt(hit.x, y, hit.z);
    const t = this.terrain, i = Math.round((hit.x - t.x0) / t.cell), j = Math.round((hit.z - t.z0) / t.cell);
    const k = j * t.vps + i, iy = Math.ceil((y - SLICE_ORIGIN_Y) / VOXEL_H - 0.5) - 1;
    const def = this.tools.def;
    return {
      material: MATERIALS[mat].id, hardness: MATERIALS[mat].hardness, handEfficiency: MATERIALS[mat].handEfficiency,
      tool: def.id, toolEfficiency: +toolEfficiency(def, mat, t.loose[k] > 0, hit.boulder == null && !t.loose[k] && f.cementedAt(hit.x, hit.y - 0.01, hit.z), mat === MAT.STONE && t.rubble[k] > 0).toFixed(3), loose: t.loose[k],
      crack: hit.boulder == null ? +(t.crack[k] / 16).toFixed(3) : 0, rubble: hit.boulder == null ? t.rubble[k] : 0, at: { x: +hit.x.toFixed(3), z: +hit.z.toFixed(3) },
      cemented: hit.boulder == null && !t.loose[k] && f.cementedAt(hit.x, hit.y - 0.01, hit.z), streak: hit.boulder == null ? +f.streakAt(hit.x, hit.y - 0.01, hit.z).toFixed(3) : 0,
      rock: hit.boulder != null ? this.rocks.stage(hit.boulder) : null,
      gold: +f.goldDensityAt(hit.x, y, hit.z, mat, t.base[k] - y).toFixed(3), depth: +(t.base[k] - hit.y).toFixed(2),
      cell: `${i}:${j}:${iy}`, workedSlice: this.mining.cidx[k], worked: iy >= this.mining.cidx[k],
      distance: +hit.distance.toFixed(2), boulder: hit.boulder,
    };
  }

  _debugTick(now) {
    if (now - (this._dbgAt || 0) < 500) return;
    this._dbgAt = now;
    const i = this.info(), pr = this.probe(), ls = this.lastStroke, st = this.economy.stats;
    this.ui.setDebug([
      `${i.fps} FPS · ${i.frameMs} ms (p95 ${i.p95}) · Seed ${this.doc.worldSeed}`,
      `Draw calls ${i.drawCalls} · Dreiecke ${(i.triangles / 1000).toFixed(0)}k · Partikel ${i.particles}/${i.fragments} · Loot ${i.loot} · Glitzer ${i.glints}`,
      `Qualität ${i.level} · DPR ${i.dpr}` + (i.heapMB != null ? ` · Heap ${i.heapMB} MB` : "") + ` · Save ${(i.saveBytes / 1024).toFixed(1)} KB`,
      `Werkzeug ${this.tools.equipped} (${this.tools.state}${this.tools.phase ? " " + this.tools.phase : ""}) · Zyklus ${cycleSeconds(this.tools.def).toFixed(2)} s` + (this.tools.dev ? " · DEV-Freischaltung" : ""),
      pr ? `Ziel: ${pr.material} (Härte ${pr.hardness}, ${pr.tool} ${pr.toolEfficiency}${pr.loose ? `, gelockert ${pr.loose} cm` : ""}) · Gold ${pr.gold} · Tiefe ${pr.depth} m · ${pr.distance} m${pr.rock ? ` · Fels ${pr.rock}` : ""}` : "Ziel: –",
      pr ? `Zelle ${pr.cell} · bearbeitet ab Scheibe ${pr.workedSlice} (${pr.worked ? "verbraucht" : "frisch"})` : "",
      ls ? `Letzte Aktion: ${ls.kind === "rock" ? `Fels ${ls.rock ? ls.rock.stage : ""}` : ls.blocked ? "abgeprallt – nichts" : `${ls.massKg} kg entfernt (${ls.removedL} l, verlagert ${ls.relocatedL} l), ${ls.slices} Scheiben, ${ls.finds} Fund(e) ${ls.cents} ct`}` : "",
      `Aktionen ${st.totalDigs} · erfolgreich ${st.successfulDigs} · Funde ${st.finds} (+${this.economy.pending.size} unterwegs) · Nuggets ${this.economy.inventory.nuggets.count}`,
      `H = Gold-Heatmap ${this.terrain.heatmap ? "an" : "aus"} · F3 = Overlay`,
    ].filter(Boolean).join("\n"));
  }

  // ------------------------------------------------------------ teardown

  // ------------------------------------------------------------ placing the hillside miner (Prompt 10)

  // the ghost follows the crosshair on the ground at the mountain's foot, facing the mountain (R turns it on);
  // green = it may stand there (its section, its belt's receiver), red = why not
  _placeStart(what, moving) {
    const am = this.processing.autominer;
    if (!am || this.placing) return;
    const ghost = new AutoMinerRig(THREE, { ghost: true, geos: am.rig.geos }), A = MINER.area;
    const areaGeo = new THREE.BoxGeometry(A.far - A.near, A.up, A.w);
    areaGeo.translate((A.near + A.far) / 2, A.up / 2 + A.floor, 0);
    const areaMat = new THREE.MeshBasicMaterial({ color: 0x5ee07a, transparent: true, opacity: 0.12, depthWrite: false });
    const area = new THREE.Mesh(areaGeo, areaMat);
    ghost.root.add(area);
    ghost.root.visible = false;
    this.world.scene.add(ghost.root);
    this.placing = { what, moving: !!moving, ghost, area, areaMat, rot: 0, ok: false, click: this.input.digHeld, at: null, res: null };
    this.audio.play("swap", { dist: 0.4 });
    this.hud.tip("miner-place", this.touch ? "Auf den Boden am Fuß der Bergflanke zielen – grün: Grabknopf zum Aufstellen, ABBRECHEN zum Abbrechen" : "Auf den Boden am Fuß der Bergflanke zielen – grün: [Klick] aufstellen · [R] drehen · [E] abbrechen", 20);
  }

  _placeUpdate() {
    const P = this.placing, am = this.processing.autominer;
    if (!am) { this._placeEnd(false); return; }
    const p = this.player, cam = this.camera, cp = Math.cos(p.pitch);
    const dx = -Math.sin(p.yaw) * cp, dy = Math.sin(p.pitch), dz = -Math.cos(p.yaw) * cp;
    let hit = this.terrain.raycast(cam.position.x, cam.position.y, cam.position.z, dx, dy, dz, 24);
    if (!hit && dy < -0.02) { const t = -cam.position.y / dy; if (t < 24) hit = { x: cam.position.x + dx * t, z: cam.position.z + dz * t }; }
    let r = null;
    if (hit) {
      const x = Math.round(hit.x * 10) / 10, z = Math.round(hit.z * 10) / 10;
      const h = Math.atan2(-(MOUND_CENTER.z - z), MOUND_CENTER.x - x) + P.rot;
      if (!P.at || P.at.x !== x || P.at.z !== z || P.at.h !== h) { P.at = { x, z, h }; P.res = am.check(x, z, h); }
      r = P.res;
      const G = P.ghost.root;
      G.visible = true;
      G.position.set(x, r.y != null ? r.y : this.world.groundAt(x, z), z);
      G.rotation.set(0, h, 0);
      P.ghost.setGhostOk(r.ok);
      P.areaMat.color.setHex(r.ok ? 0x5ee07a : 0xe0503c);
    } else { P.ghost.root.visible = false; P.at = null; }
    P.ok = !!(r && r.ok);
    const hint = !r ? "Auf den Boden am Fuß der Bergflanke zielen"
      : r.ok ? `Hier aufstellen: ${r.m3.toFixed(1).replace(".", ",")} m³ Berg im Abschnitt · Austrag ${r.recv.kind === "intake" ? "in den Aufgabetrichter" : "auf den Rohhaufen"}`
        : `Hier nicht: ${r.reason}`;
    this.hud.work(`${hint} · ${this.touch ? "Grabknopf: aufstellen" : "[Klick] aufstellen · [R] drehen · [E] abbrechen"}`);
    const click = this.input.digHeld;
    if (click && !P.click) {
      if (P.ok) { this._placeEnd(true); return; }
      this.audio.play("barrow_bump", { dist: 0.5, strength: 0.5 });
      this.hud.tip("miner-bad", `Hier nicht: ${r ? r.reason : "kein Boden unter dem Fadenkreuz"}`, 4);
    }
    P.click = click;
  }

  // place: set it down where the ghost is (valid); else: it stays where it was
  _placeEnd(place) {
    const P = this.placing;
    if (!P) return;
    this.placing = null;
    this.world.scene.remove(P.ghost.root);
    P.ghost.dispose(); P.area.geometry.dispose(); P.areaMat.dispose();
    this.hud.work("");
    const am = this.processing.autominer;
    if (!am) return;
    if (place && P.at) {
      const r = am.place(P.at.x, P.at.z, P.at.h);
      if (r.ok) {
        this.audio.play("exc_dump", { dist: 1.8, strength: 0.6 });
        this.hud.message("Abbaugerät steht", `${r.m3.toFixed(1).replace(".", ",")} m³ Berg im Abschnitt · Austrag ${r.recv.kind === "intake" ? "in den Aufgabetrichter" : "auf den Rohhaufen"} – am Bedienpult (links am Gerät) [E] starten.`);
        this.dirty = true;
        return;
      }
    }
    if (am.status === "placing") am.status = am.placed ? "stopped" : "parked";
  }

  // the miner stopped by itself (its section empty / only hard rock left): said once
  _minerWatch() {
    const am = this.processing.autominer;
    if (!am) return;
    if (am._seen !== am.status) {
      if ((am.status === "exhausted" || am.status === "rock") && am._seen === "running") {
        this.audio.play("miner_stop", { dist: 2, strength: 0.8 });
        this.hud.message("Abbaugerät steht", am.status === "rock" ? "Hartgestein – der Abbaukopf ist blockiert. Fels brechen (Spitzhacke / Hammer) oder versetzen." : "Abbaubereich erschöpft – am Bedienpult [E]: versetzen.");
      }
      am._seen = am.status;
    }
  }

  dispose() {
    if (this.disposed) return;
    if (this.placing) this._placeEnd(false);
    if (this.ready) this.flushLoot();
    this.save("exit");
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.input) this.input.detach();
    for (const off of this._off.splice(0)) off();          // incl. the context-loss listeners
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.effects) this.effects.dispose();
    if (this.loot) this.loot.dispose();
    if (this.hands) this.hands.dispose();
    if (this.rocks) this.rocks.dispose();
    if (this.stations) this.stations.dispose();
    if (this.processing) this.processing.dispose();
    if (this.audio) this.audio.dispose();
    if (this.hud) this.hud.dispose();
    if (this.reticle) { this.reticle.geometry.dispose(); this.reticle.material.dispose(); }
    if (this.world) this.world.dispose();
    if (this.assets) this.assets.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();                     // hand the GL context back to the browser now
    }
  }
}

const ZUP = new THREE.Vector3(0, 0, 1);
const SUN_VEC = new THREE.Vector3(...SUN_DIR).normalize();

// vertical FOV for an aspect ratio: 70 deg, unless that would leave the
// horizontal view too narrow (portrait) or too wide (very wide landscape)
function fovFor(aspect) {
  const h = Math.tan((FOV * Math.PI) / 360) * aspect;
  if (h < HFOV_MIN) return (2 * Math.atan(HFOV_MIN / aspect) * 180) / Math.PI;
  if (h > HFOV_MAX) return (2 * Math.atan(HFOV_MAX / aspect) * 180) / Math.PI;
  return FOV;
}
const round3 = (v) => Math.round(v * 1000) / 1000;

export function newWorldDoc(seed) {
  return {
    saveVersion: SAVE_VERSION,
    worldSeed: seed,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tools: { owned: ["hand"], equipped: "hand", upgrades: [] },  // a new mine owns ONLY the hand, € 0,00
    player: { x: SPAWN.x, z: SPAWN.z, yaw: SPAWN.yaw, pitch: SPAWN.pitch },
    economy: null,
    terrain: null,
    resources: null,
    rocks: null,
    processing: null,
    geology: { version: GEOLOGY_VERSION },
  };
}
