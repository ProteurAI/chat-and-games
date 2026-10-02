// GoldRush - the running game: renderer, world, player, the tools in your
// hands, mining, boulders, finds, the gold pouch, the camp's stations
// (selling gold, buying supplies), money, save, quality, lifecycle. Loaded lazily by goldrush.js
// (this is the module that pulls in three.js), created once per opened
// game and fully disposed on exit - no render loop, listener, timer, audio
// context or GL context survives it.

import * as THREE from "../../vendor/three/three.module.min.js";
import { AssetManager } from "./goldrush-assets.js";
import { GoldRushAudio } from "./goldrush-audio.js";
import { Economy, formatEuro } from "./goldrush-economy.js";
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
import { FLOOR_Y } from "./goldrush-terrain.js";
import { TOOL_DEFS, TOOL_ORDER, ToolController, cycleSeconds, effectiveDef, toolEfficiency } from "./goldrush-tools.js";
import { DigEffects } from "./goldrush-vfx.js";
import { GoldRushWorld, SPAWN, SUN_DIR } from "./goldrush-world.js";

export const THREE_REVISION = THREE.REVISION;
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
const SOUND = ["dirt", "compact", "gravel", "stone"];
const KICK = { hand: 0.01, shovel: 0.016, pickaxe: 0.022 };     // subtle camera kick per contact (off with reduced motion)
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
    this.hands.models.soil.visible = true;
    const held = this.hands.right.held;
    held.geometry = this.loot.geos[5][0];
    held.material = this.loot.goldMat;
    held.visible = true;
    // ... and the whole claim, the camp behind you included: one frame without
    // frustum culling uploads every buffer and texture (no hitch at the first look round)
    const culled = [];
    world.scene.traverse((o) => { if (o.frustumCulled) { culled.push(o); o.frustumCulled = false; } });
    renderer.compile(world.scene, camera);
    renderer.compile(this.hands.scene, this.hands.camera);
    if (this.rocks.tex) renderer.initTexture(this.rocks.tex);   // no upload hitch when the first boulder comes into view
    this.render();                                        // uploads the gold pieces' buffers too
    for (const o of culled) o.frustumCulled = true;
    renderer.autoClear = false;
    renderer.render(this.hands.scene, this.hands.camera);
    renderer.autoClear = true;
    held.visible = false;
    [this.hands.models.shovel.visible, this.hands.models.pickaxe.visible, tr.visible] = vis;
    this.hands.models.soil.visible = false;
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
      if (i >= 0) this.selectTool(TOOL_ORDER[i]);
      if (e.code === "KeyE" && this.station) { e.preventDefault(); this.openStation(this.station.id); }
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
    const e = this.economy, state = { owned: this.tools.owned, upgrades: this.tools.upgrades, hardSeen: e.flags.hardSeen, cashCents: e.cashCents };
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

  /**
   * BUY at the supply counter - one transaction: status, price, cash and
   * the item itself in one synchronous step (a second click finds it owned).
   */
  buy(id) {
    const it = shopItem(id);
    if (!it) return { ok: false, reason: "unknown" };
    const e = this.economy;
    const st = itemStatus(it, { owned: this.tools.owned, upgrades: this.tools.upgrades, hardSeen: e.flags.hardSeen, cashCents: e.cashCents });
    if (st.state === "owned") return { ok: false, reason: "owned" };
    if (st.state === "locked") return { ok: false, reason: "locked", needs: st.needs };
    const pay = e.buy(it.id, it.price, it.kind);
    if (!pay.ok) { this.audio.play("insufficient", { dist: 0.4 }); return { ok: false, reason: pay.reason, missing: pay.missing }; }
    if (it.kind === "tool") {
      this.tools.unlock(it.tool);
      this.stations.setOwned(this.tools.owned);
      this.tools.equip(it.tool);                                          // straight into your hands
    } else {
      this.tools.addUpgrade(it.id);
      this.hands.models.applyUpgrades(this.tools.upgrades);
    }
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
    if (p) { this.input.releaseAll(); this.save("pause"); }
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
  };

  render() {
    if (this.glLost || this.disposed) return;
    const r = this.renderer;
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
    const p = this.player, input = this.input, world = this.world;
    const look = input.takeLook();
    p.yaw -= look.x;
    p.pitch = Math.max(-1.45, Math.min(1.45, p.pitch - look.y));
    this.hands.look(look.x, look.y);

    // walk: accelerate towards the stick/keys direction
    let mx = input.move.x, my = input.move.y;
    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    const speed = input.sprint ? SPRINT : WALK;
    const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
    const tx = (-sin * my + cos * mx) * speed, tz = (-cos * my - sin * mx) * speed;
    const a = Math.min(1, dt * 10);
    p.vx += (tx - p.vx) * a;
    p.vz += (tz - p.vz) * a;
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
    const ground = world.groundAt(p.x, p.z) + EYE;
    p.y += (ground - p.y) * Math.min(1, dt * (ground < p.y - 0.4 ? 20 : 12));
    if (p.y < ground - 0.25) p.y = ground - 0.25;             // never sink into ground that rose under you

    const moving = Math.hypot(p.vx, p.vz);
    if (moving > 0.3) p.bob += dt * moving * 2.1; else p.bob *= Math.exp(-dt * 6);
    p.kick *= Math.exp(-dt * 16);

    this._updateCamera(dt);
    this._aim();
    // the tool: actions while dig is held and the crosshair is on the ground
    const want = input.digHeld && !!this.target;
    if (input.digHeld && !this.target) this._hintNoTarget();
    this.tools.blocked = !!this.hands.inspecting;
    const ev = this.tools.tick(dt, want);
    if (ev === "contact") this._contact();
    else if (ev === "swap") this._swapped();
    this._phaseHooks();
  }

  // looks and sounds bound to an action's phases (not to the contact)
  _phaseHooks() {
    const v = this.tools.view(), sig = `${v.state}:${v.phase}:${v.cycle}`;
    if (sig === this._lastPhase) return;
    this._lastPhase = sig;
    if (v.state !== "action") return;
    if (v.tool === "shovel" && v.phase === "dump" && this.lastStroke && this.lastStroke.massKg > 0) {
      // the load goes off the blade, to the right of the player
      const c = this.camera, p = this.player, fw = this._fw.set(-Math.sin(p.yaw), 0, -Math.cos(p.yaw)), rt = this._rt.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
      const x = c.position.x + fw.x * 0.75 + rt.x * 0.45, z = c.position.z + fw.z * 0.75 + rt.z * 0.45;
      const y = Math.max(this.terrain.getHeightAt(x, z) + 0.2, c.position.y - 0.55);
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
    const s = this.uiOpen ? null : this.stations.near(this.player.x, this.player.z, this.player.yaw);
    if (s !== this.station) {
      this.station = s;
      this.hud.prompt(s ? s.action : null, this.touch ? "" : "E");
      this.ui.onStation && this.ui.onStation(s);
    }
    this._objT -= dt;
    if (this._objT <= 0) { this._objT = 0.5; this.hud.objective(this.uiOpen ? null : this._objective()); }
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
    const kick = this.reducedMotion ? 0 : KICK[def.id] || 0.01;
    if (r.kind === "rock") {
      // the pickaxe on a boulder: chips, a clank, the boulder cracks / breaks
      const rk = r.rock;
      this.tools.react("ok", MAT.STONE);
      this.hands.contact("blocked", MAT.STONE);
      this.effects.burst(hit, MATERIALS[MAT.STONE], rk && rk.broke ? 1.4 : 0.8, rk && rk.broke ? 6 : 2);
      this.audio.play("pickStone", { pan, dist });
      if (rk && rk.broke) this.audio.play("break", { pan, dist });
      else if (rk && rk.stage !== "intact") this.audio.play("crack", { pan, dist, strength: 0.8 });
      this._haptic(rk && rk.broke ? [18, 40, 26] : 16);
      this.player.kick = Math.min(0.04, this.player.kick + kick);
      if (rk && rk.broke) this.hud.tip("rock-broken", "Felsbrocken zerschlagen – der Weg ist frei.", 20);
      this.lastStroke = { tool: def.id, kind: "rock", material: MAT.STONE, massKg: 0, rock: rk, finds: 0, cents: 0 };
      this.dirty = true;
      return;
    }
    if (r.blocked) {
      this.tools.react("blocked", MAT.STONE);
      this.hands.contact("blocked", MAT.STONE);
      this.effects.burst(hit, MATERIALS[MAT.STONE], 0.6, def.id === "shovel" ? 2 : 0);
      this.audio.play(def.id === "hand" ? "stone" : "pickStone", { pan, dist, strength: def.id === "hand" ? 1 : 0.7 });
      this._haptic(MATERIALS[MAT.STONE].haptic);
      if (STONE_TIP[def.id]) this.hud.tip(`stone-${def.id}`, STONE_TIP[def.id], 10);
      this.ui.crosshairPulse && this.ui.crosshairPulse("hard");
      this.player.kick = Math.min(0.03, this.player.kick + kick * 0.5);
      this.lastStroke = { tool: def.id, kind: "blocked", material: hit.boulder != null ? MAT.STONE : r.material, massKg: 0, blocked: true, finds: 0, cents: 0 };
      this.dirty = true;
      return;
    }
    const mdef = MATERIALS[r.material];
    this.tools.react("ok", r.material);
    if (def.id === "shovel") { const c = mdef.fragmentColor; this.hands.models.soilMat.color.setRGB(c[0] * 1.25, c[1] * 1.25, c[2] * 1.25); }
    this.hands.contact("ok", r.material, r.removedMassKg);
    const vfx = def.vfxProfile || { dust: 1, chunks: 1 };
    this.effects.burst(hit, mdef, Math.min(1.6, (0.55 + r.removedMassKg / 3) * vfx.dust), Math.round(vfx.chunks - 1));
    if (def.id === "shovel") this.audio.play("shovel", { pan, dist, strength: Math.min(1, 0.6 + r.removedMassKg / 3) });
    else if (def.id === "pickaxe") this.audio.play(r.material === MAT.STONE ? "pickStone" : "pick", { pan, dist });
    else this.audio.play(SOUND[r.material], { pan, dist, strength: Math.min(1, 0.6 + r.removedMassKg * 2) });
    this._haptic(mdef.haptic);
    this.player.kick = Math.min(0.03, this.player.kick + kick);
    this.ui.onDig && this.ui.onDig();
    // finds: out of the ground now (pending), shown now (loot), money on pickup
    const disc = this.economy.discover(r.finds, r.findCount);
    if (disc.items.length) {
      if (disc.firstNugget) for (const it of disc.items) if (it.cls === FIND.NUGGET) { it.first = true; break; }
      this.loot.spawn(disc.items, hit);
      const best = disc.best;
      this.audio.play(best === FIND.NUGGET ? "nugget" : best === FIND.TINY ? "tiny" : best === FIND.FLAKE ? "flake" : "dust", { pan, dist });
      if (best === FIND.NUGGET) this._haptic([14, 50, 24]);
    }
    this.lastStroke = this._strokeInfo(def, r, disc);
    this.dirty = true;
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
    const base = { ok: r.ok, kind: r.kind, blocked: r.blocked, material: r.material, rock: r.rock, cents: 0, finds: 0, massKg: 0 };
    if (!r.ok || r.blocked || r.kind === "rock") { this.dirty = true; this.lastStroke = { tool: id, kind: r.kind, massKg: 0 }; return base; }
    const disc = this.economy.discover(r.finds, r.findCount);
    if (visuals) {
      this.effects.burst(hit, MATERIALS[r.material], 1);
      if (disc.items.length) {
        if (disc.firstNugget) for (const it of disc.items) if (it.cls === FIND.NUGGET) { it.first = true; break; }
        this.loot.spawn(disc.items, hit);
      }
    } else if (disc.items.length) {
      for (const it of disc.items) this._collected({ cls: it.cls, cents: it.cents, find: it, silent: true });
    }
    this.lastStroke = this._strokeInfo(def, r, disc);
    this.dirty = true;
    return {
      ...base, cents: disc.cents, finds: disc.items.length, best: disc.best, massKg: r.removedMassKg, massByMat: [...r.massByMat], slices: r.slices, cells: r.cells,
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

  // what is under the crosshair right now (debug panel, tests)
  probe() {
    const hit = this.target || this.farTarget;
    if (!hit) return null;
    const f = this.terrain.field, y = hit.y - 0.02;
    const mat = hit.boulder != null ? MAT.STONE : f.materialAt(hit.x, y, hit.z);
    const t = this.terrain, i = Math.round((hit.x - t.x0) / t.cell), j = Math.round((hit.z - t.z0) / t.cell);
    const k = j * t.vps + i, iy = Math.ceil((y - FLOOR_Y) / VOXEL_H - 0.5) - 1;
    const def = this.tools.def;
    return {
      material: MATERIALS[mat].id, hardness: MATERIALS[mat].hardness, handEfficiency: MATERIALS[mat].handEfficiency,
      tool: def.id, toolEfficiency: +toolEfficiency(def, mat, t.loose[k] > 0).toFixed(3), loose: t.loose[k],
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
  };
}
