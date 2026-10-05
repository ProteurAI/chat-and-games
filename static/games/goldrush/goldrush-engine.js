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
import { Economy, formatEuro, formatMass } from "./goldrush-economy.js";
import { FirstPersonHands } from "./goldrush-hand.js";
import { GoldRushHud } from "./goldrush-hud.js";
import { GoldRushInput } from "./goldrush-input.js";
import { LootSystem } from "./goldrush-loot.js";
import { MAT, MATERIALS } from "./goldrush-materials.js";
import { MiningSystem } from "./goldrush-mining.js";
import { QUALITY, QUALITY_LEVELS, applyRendererQuality, createRenderer, guessQuality, isMobileDevice } from "./goldrush-renderer.js";
import { FIND, FIND_IDS, VOXEL_H } from "./goldrush-resources.js";
import { RockSystem } from "./goldrush-rocks.js";
import { DEFAULT_SETTINGS, SAVE_VERSION } from "./goldrush-save.js";
import { SHOP_ITEMS, itemStatus, shopItem } from "./goldrush-shop.js";
import { STATIONS, Stations } from "./goldrush-stations.js";
import { ProcessingSystem } from "./goldrush-processing.js";
import { BULK_AT } from "./goldrush-automation.js";
import { BULK } from "./goldrush-automodels.js";
import { SLICE_ORIGIN_Y } from "./goldrush-terrain.js";
import { TOOL_DEFS, TOOL_ORDER, ToolController, cycleSeconds, effectiveDef, toolEfficiency } from "./goldrush-tools.js";
import { DigEffects } from "./goldrush-vfx.js";
import { GoldRushWorld, SPAWN, SUN_DIR } from "./goldrush-world.js";

export const THREE_REVISION = THREE.REVISION;
export { SPAWN } from "./goldrush-world.js";
export { WASH } from "./goldrush-processing.js";
export { GRIPS, TOOL_KEYS } from "./goldrush-hand.js";
export { STATIONS } from "./goldrush-stations.js";

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
  hand: "Zu hart für die Hand – hier braucht es eine Spitzhacke.",
  shovel: "Die Schaufel prallt am Stein ab – dafür braucht es eine Spitzhacke.",
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
      quality: () => this.level,
    });
    // phase 6: the sluice's water (near it), a barrow load landing in the hopper
    this.processing.onSound = (kind) => this.audio.play(kind, { dist: 2.5, strength: 0.7 });
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
    renderer.compile(world.scene, camera);
    renderer.compile(this.hands.scene, this.hands.camera);
    if (this.rocks.tex) renderer.initTexture(this.rocks.tex);   // no upload hitch when the first boulder comes into view
    for (const t of pr.textures()) renderer.initTexture(t);   // the machines' shared maps (heap, load) before a heap first comes into view
    this.render();                                        // uploads the gold pieces' buffers too
    for (const o of culled) o.frustumCulled = true;
    renderer.autoClear = false;
    renderer.render(this.hands.scene, this.hands.camera);
    renderer.autoClear = true;
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
      const i = ["Digit1", "Digit2", "Digit3"].indexOf(e.code);
      if (i >= 0 && !this.processing.work && !this.processing.carrying) this.selectTool(TOOL_ORDER[i]);
      if (e.code === "KeyE" && this.processing.work) { e.preventDefault(); this._workAction(); return; }
      if (e.code === "KeyE" && this.station) { e.preventDefault(); this.useStation(); }
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
    return { equipped: this.tools.target || this.tools.equipped, owned: this.tools.ownedList(), dev: this.tools.dev, order: TOOL_ORDER.map((id) => ({ id, label: TOOL_DEFS[id].label, key: TOOL_DEFS[id].key, owned: this.tools.owned.has(id), usable: this.tools.canUse(id) })) };
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
    if (this.uiOpen || !STATIONS.some((s) => s.id === id)) return false;
    this.uiOpen = id;
    this.input.releaseAll();
    this.input.enabled = false;
    this.tools.cancel();
    this.hud.prompt(null);
    this.audio.play(id === "assay" ? "scale" : "shopOpen", { dist: 0.6, strength: 0.6 });
    this.ui.openStation(id, id === "assay" ? this.sellView() : this.shopView());
    if (!this.touch && this.input.locked) this.input.exitLock();          // the panel needs the mouse
    return true;
  }

  // E / the phone's button: whatever is in front of you
  useStation() {
    const s = this.station;
    if (!s) return false;
    if (s.kind !== "process") return this.openStation(s.id);
    if (s.disabled) { this.hud.tip(`proc-${s.id}`, s.action, 4); return false; }
    const r = this.processing.act(s.id, this.player);
    if (!r.ok) return false;
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
    else if (r.kind === "barrow") { this.audio.play("swap", { dist: 0.3 }); this.player.pitch = Math.min(this.player.pitch, -0.28); this.hud.tip("barrow", this.touch ? "Mit dem Stick schieben · ABSTELLEN tippen zum Abstellen" : "W schieben · [E] abstellen · am Trichter: [E] auskippen", 30); }
    else if (r.kind === "dump") this.audio.play("wheelbarrow_dump", { dist: 1.2 });
    else if (r.kind === "feed") { this.audio.play("sluice_feed", { dist: 0.8 }); this._fedEffect(s.id); }
    else if (r.kind === "build") { this.audio.play("purchase", { dist: 1 }); this.hud.message(r.what === "bulk" ? "Vorratstrichter" : r.what === "feeder" ? "Dosierer" : "Waschrinne", r.what === "feeder" ? "wird montiert …" : "wird aufgebaut …"); }
    else if (r.kind === "gate") { this.audio.play("gate_open", { dist: 0.8 }); this.hud.message("Schieber offen", "Es rutscht in den Trichter der Rinne – er schließt, wenn der voll ist."); }
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
    this.ui.root.classList.remove("gr-working");
    this.hud.work(null);
    this._stationSig = null;
  }

  // E while working: take the gold out of the pan (when it shows), else stop for now
  _workAction() {
    const pr = this.processing;
    if (pr.work === "pan" && pr.panDone) { this._collectPan(); return; }
    this._leaveWork();
  }

  _collectPan() {
    const r = this.processing.finishPan();
    this._leaveWork();
    if (!r.ok) return;
    if (r.cents > 0) {
      this.hud.collected(r.cents, FIND.FINE);
      this.hud.message("Gold gewaschen", `${formatMass(r.ug)} · ≈ ${formatEuro(r.cents)}${r.pieces ? ` · ${r.pieces} ${r.pieces === 1 ? "Stück" : "Stücke"}` : ""}`);
      this.audio.play(r.pieces ? "tiny" : "flake", { dist: 0.3 });
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

  shopView() {
    const e = this.economy, state = { owned: this.tools.owned, upgrades: this.tools.upgrades, equipment: this.processing.owned, hardSeen: e.flags.hardSeen, cashCents: e.cashCents };
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

  /**
   * BUY at the supply counter - one transaction: status, price, cash and
   * the item itself in one synchronous step (a second click finds it owned).
   */
  buy(id) {
    const it = shopItem(id);
    if (!it) return { ok: false, reason: "unknown" };
    const e = this.economy;
    const st = itemStatus(it, { owned: this.tools.owned, upgrades: this.tools.upgrades, equipment: this.processing.owned, hardSeen: e.flags.hardSeen, cashCents: e.cashCents });
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
    if (this.hands && this.ready) {
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
    if (this.processing.work) { this._workUpdate(dt, look); return; }
    const pr = this.processing, bw = pr.pushing ? pr.barrow : null;
    const oy = p.yaw;
    p.yaw -= look.x;
    if (bw && (bw.dump || !bw.canGo(p.x, p.z, p.yaw))) p.yaw = oy;          // it would swing into something: hold
    // pushing: the eyes stay on the barrow (the grips stay in view)
    p.pitch = bw ? Math.max(-0.8, Math.min(0.1, p.pitch - look.y)) : Math.max(-1.45, Math.min(1.45, p.pitch - look.y));
    this.hands.look(look.x, look.y);

    // walk: accelerate towards the stick/keys direction
    let mx = input.move.x, my = input.move.y;
    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    const speed = (input.sprint && !bw ? SPRINT : WALK) * this.processing.speedFactor();
    const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
    const tx = (-sin * my + cos * mx) * speed, tz = (-cos * my - sin * mx) * speed;
    const a = Math.min(1, dt * 10);
    p.vx += (tx - p.vx) * a;
    p.vz += (tz - p.vz) * a;
    const ox = p.x, oz = p.z;
    const g0 = world.groundAt(p.x, p.z);
    // steep ground: walking up to 38°, scrambling (slower) up to 68° - so you
    // always get out of your own pit - never up a stone wall
    const tryAxis = (sx, sz) => {
      const d = Math.hypot(sx, sz);
      if (d < 1e-6) return true;
      const rise = world.groundAt(p.x + sx, p.z + sz) - g0;
      const s = rise / d;
      if (rise > 0 && s > MAX_SLOPE) return false;
      const k = rise > 0 && s > WALK_SLOPE ? Math.max(0.25, 1 - ((Math.atan(s) - Math.atan(WALK_SLOPE)) / (Math.atan(MAX_SLOPE) - Math.atan(WALK_SLOPE))) * 0.75) : 1;
      p.x += sx * k;
      p.z += sz * k;
      return true;
    };
    if (!tryAxis(p.vx * dt, p.vz * dt)) {
      if (!tryAxis(p.vx * dt, 0)) p.vx = 0;
      if (!tryAxis(0, p.vz * dt)) p.vz = 0;
    }
    world.collide(p, RADIUS);
    this._keepOffWalls();
    if (bw) {
      // the wheel would climb a wall / the barrow would hit something: you stop
      if (bw.dump || !bw.canGo(p.x, p.z, p.yaw)) { p.x = ox; p.z = oz; p.vx = p.vz = 0; }
      bw.follow(p);
    }
    const ground = world.groundAt(p.x, p.z) + EYE;
    p.y += (ground - p.y) * Math.min(1, dt * (ground < p.y - 0.4 ? 20 : 12));
    if (p.y < ground - 0.25) p.y = ground - 0.25;             // never sink into ground that rose under you

    const moving = Math.hypot(p.vx, p.vz);
    if (moving > 0.3) p.bob += dt * moving * 2.1; else p.bob *= Math.exp(-dt * 6);
    p.kick *= Math.exp(-dt * 16);

    this._updateCamera(dt);
    this._aim();
    // the tool: actions while dig is held and the crosshair is on the ground
    // (not while you carry the bucket - your hand is on its bail)
    const carrying = this.processing.carrying || this.processing.pushing;
    const want = input.digHeld && !!this.target && !carrying;
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
    const ev = pr.input(look.x, look.y, dt);
    if (ev === "pan-ready") { this.audio.play("flake", { dist: 0.3, strength: 0.7 }); this._haptic(10); }
    else if (ev && ev.kind === "cleaned") {
      this.audio.play("sluice_cleanout", { dist: 0.5 });
      this.hud.message("Riffelmatte gereinigt", `${(ev.heavyMl / 1000).toFixed(1).replace(".", ",")} l Schwerkonzentrat in der Schale am Waschtrog${ev.nuggets ? ` · ${ev.nuggets} Nugget${ev.nuggets > 1 ? "s" : ""} herausgepickt` : ""}`);
      if (ev.cents) this.hud.collected(ev.cents, FIND.NUGGET);
      this._leaveWork();
      this.dirty = true;
      return;
    } else if (ev && ev.kind === "sieved") {
      this.audio.play("dump", { dist: 0.4, strength: 0.8 });
      const n = ev.retained.pieces;
      this.hud.message("Gesiebt", `${(ev.underMl / 1000).toFixed(1).replace(".", ",")} l Konzentrat in der Wanne${n ? ` · ${n} Nugget herausgepickt` : ""}`);
      if (ev.retained.cents) this.hud.collected(ev.retained.cents, FIND.NUGGET);
      this._leaveWork();
      this.dirty = true;
      return;
    }
    // click / tap when the gold shows: collect
    const click = this.input.digHeld;
    if (pr.work === "pan" && pr.panDone && click && !this._workClick) { this._workClick = click; this._collectPan(); return; }
    this._workClick = click;
    const touch = this.touch;
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
        this.audio.play("dump", { pan: 0.4, dist: 0.6 });
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
    let s = null;
    if (!this.uiOpen && !pr.work) {
      const pi = pr.interaction(this.player);
      if (pi) s = { ...pi, kind: "process" };
      else { const st = this.stations.near(this.player.x, this.player.z, this.player.yaw); if (st) s = { ...st, kind: "station" }; }
    }
    if (pr.work) s = pr.work === "pan" && pr.panDone ? { id: "pan-collect", action: "Gold einsammeln", short: "EINSAMMELN", kind: "work" } : { id: "work-stop", action: "", short: "FERTIG", kind: "work" };
    const sig = s ? `${s.kind}:${s.id}:${s.action}` : "";
    if (sig !== this._stationSig) {
      this._stationSig = sig;
      this.station = s && s.kind !== "work" ? s : null;
      this.hud.prompt(s && s.action ? s.action : null, this.touch || (s && s.disabled) ? "" : "E");
      this.ui.onStation && this.ui.onStation(s);
    }
    // the load chip: the bucket you carry / the barrow you push, else what stands near you
    const b = pr.bucket, w = pr.barrow, sl = pr.sluice, P = this.player;
    const dB = b && !b.carried ? Math.hypot(b.x - P.x, b.z - P.z) : Infinity;
    const wc = w && !w.pushing ? w.trayCenter(this._wc || (this._wc = {})) : null, dW = wc ? Math.hypot(wc.x - P.x, wc.z - P.z) : Infinity;
    const dS = sl ? Math.hypot(sl.root.position.x + 1.2 - P.x, sl.root.position.z - P.z) : Infinity;
    if (b && (b.carried || (dB < 3.2 && dB <= dW))) {
      const l = (pr.bucketMl / 1000).toFixed(1).replace(".", ","), cap = Math.round(pr.capacityMl / 1000);
      this.hud.load(`Eimer ${l} / ${cap} l${b.carried ? ` · ${pr.bucketKg.toFixed(1).replace(".", ",")} kg` : ""}`);
      this.hud.loadEl.classList.toggle("is-full", pr.bucketMl >= pr.capacityMl - 50);
    } else if (w && (w.pushing || dW < 3.6)) {
      this.hud.load(`Schubkarre ${Math.round(w.volumeMl / 1000)} / ${Math.round(w.capacityMl / 1000)} l${w.pushing ? ` · ${Math.round(w.massKg)} kg` : ""}`);
      this.hud.loadEl.classList.toggle("is-full", w.full);
    } else if (pr.bulk && pr.bulk.installed && Math.hypot(BULK_AT.x - P.x, BULK_AT.z - P.z) < 4.6) {
      // the automation at a glance: store, feeder, the sluice's hopper, the riffles
      const bk = pr.bulk, fd = pr.feeder && pr.feeder.installed ? pr.feeder : null;
      const parts = [`Vorrat ${Math.round(bk.volumeMl / 1000)} / ${Math.round(bk.capacityMl / 1000)} l`];
      if (fd) { const st = fd.status(); parts.push(st.key === "moving" ? `Dosierer ${String(fd.rateLpm).replace(".", ",")} l/min` : st.key === "off" ? "Dosierer aus" : "Dosierer wartet"); }
      else if (bk.gateOpen) parts.push("Schieber offen");
      if (sl && sl.installed) { parts.push(`Rinne ${Math.min(100, Math.round((sl.hopper.batch.volumeMl / sl.capacityMl) * 100))} %${sl.running ? "" : " (Wasser aus)"}`); parts.push(`Riffel ${Math.min(100, Math.round(sl.riffleLoad * 100))} %`); }
      this.hud.load(parts.join(" · "));
      this.hud.loadEl.classList.toggle("is-full", !!(sl && sl.riffleLoad >= 1));
    } else if (sl && sl.installed && dS < 4.2) {
      this.hud.load(`Trichter ${Math.round(sl.hopper.batch.volumeMl / 1000)} / ${Math.round(sl.capacityMl / 1000)} l · Riffel ${Math.min(100, Math.round(sl.riffleLoad * 100))} %${sl.running ? " · Wasser an" : ""}`);
      this.hud.loadEl.classList.toggle("is-full", sl.riffleLoad >= 1);
    } else this.hud.load(null);
    this._objT -= dt;
    if (this._objT <= 0) { this._objT = 0.5; this.hud.objective(this.uiOpen ? null : this._objective()); }
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

  _updateCamera() {
    const p = this.player, cam = this.camera;
    const bobOn = this.settings.headBob && !this.reducedMotion;
    const amp = bobOn ? Math.min(1, Math.hypot(p.vx, p.vz) / WALK) : 0;
    const by = Math.sin(p.bob * 2) * 0.022 * amp, bx = Math.cos(p.bob) * 0.012 * amp;
    cam.position.set(p.x + Math.cos(p.yaw) * bx, p.y + by, p.z - Math.sin(p.yaw) * bx);
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

  _hintNoTarget() {
    if (this.farTarget) this.hud.tip("far", "Zu weit entfernt – geh näher heran.", 5);
  }

  // the tool meets the ground now: the whole mining transaction
  _contact() {
    this._aim();                                   // what is under the tool at this very moment
    const hit = this.target, def = this.tools.def;
    if (!hit) {
      this.tools.react("air");
      this.hands.contact("air");
      this.audio.play("air");
      return;
    }
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
      this.audio.play(DIG_SOUND[def.id] ? DIG_SOUND[def.id][bm] : "stone", { pan, dist, strength: def.id === "hand" ? 1 : 0.7 });
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
    this.tools.react("ok", r.material);
    if (def.id === "shovel") { const c = mdef.fragmentColor; this.hands.models.loadRgb = [c[0] * 1.2, c[1] * 1.2, c[2] * 1.2]; }
    this.hands.contact("ok", r.material, r.removedMassKg);
    this.effects.impact(hit, r.material, def.id, dir, Math.min(1.5, 0.6 + r.removedMassKg / 2.5));
    const kind = (DIG_SOUND[def.id] || DIG_SOUND.hand)[r.material] || "hand_dirt";
    this.audio.play(kind, { pan, dist, strength: def.id === "hand" ? Math.min(1, 0.6 + r.removedMassKg * 2) : Math.min(1, 0.6 + r.removedMassKg / 3) });
    this._haptic(haptics[r.material] || mdef.haptic);
    if (!this.reducedMotion) this.player.kick = Math.min(0.03, this.player.kick + (kicks[r.material] || kicks[0]));
    this._trickleAfter(hit, r.material);
    this.ui.onDig && this.ui.onDig();
    // a mineralised streak: told once per streak; the shovel's limit in it now and then
    if (r.streak > 0.3) this._streakSeen(hit);
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
      this.audio.play(best === FIND.NUGGET ? "nugget" : best === FIND.TINY ? "tiny" : best === FIND.FLAKE ? "flake" : "dust", { pan, dist });
      if (best === FIND.NUGGET) this._haptic([14, 50, 24]);
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
    if (it.cls === FIND.NUGGET) this.hud.nugget(it.cents, !!(f && f.first));
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
    this.hands.inspect(this.loot.nuggetLook(item), INSPECT_S, () => this.loot.finish(item));
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
    const mat = hit.boulder != null ? MAT.STONE : f.materialAt(hit.x, y, hit.z);
    const t = this.terrain, i = Math.round((hit.x - t.x0) / t.cell), j = Math.round((hit.z - t.z0) / t.cell);
    const k = j * t.vps + i, iy = Math.ceil((y - SLICE_ORIGIN_Y) / VOXEL_H - 0.5) - 1;
    const def = this.tools.def;
    return {
      material: MATERIALS[mat].id, hardness: MATERIALS[mat].hardness, handEfficiency: MATERIALS[mat].handEfficiency,
      tool: def.id, toolEfficiency: +toolEfficiency(def, mat, t.loose[k] > 0, hit.boulder == null && !t.loose[k] && f.cementedAt(hit.x, hit.y - 0.01, hit.z)).toFixed(3), loose: t.loose[k],
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

  dispose() {
    if (this.disposed) return;
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
  };
}
