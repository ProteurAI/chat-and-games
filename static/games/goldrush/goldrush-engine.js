// GoldRush - the running game: renderer, world, player, the hand, mining,
// finds, money, save, quality, lifecycle. Loaded lazily by goldrush.js
// (this is the module that pulls in three.js), created once per opened
// game and fully disposed on exit - no render loop, listener, timer, audio
// context or GL context survives it.

import * as THREE from "../../vendor/three/three.module.min.js";
import { AssetManager } from "./goldrush-assets.js";
import { GoldRushAudio } from "./goldrush-audio.js";
import { Economy } from "./goldrush-economy.js";
import { FirstPersonHands, HAND_STATE } from "./goldrush-hand.js";
import { GoldRushHud } from "./goldrush-hud.js";
import { GoldRushInput } from "./goldrush-input.js";
import { LootSystem } from "./goldrush-loot.js";
import { MAT, MATERIALS, TOOLS } from "./goldrush-materials.js";
import { MiningSystem } from "./goldrush-mining.js";
import { QUALITY, QUALITY_LEVELS, applyRendererQuality, createRenderer, guessQuality, isMobileDevice } from "./goldrush-renderer.js";
import { FIND, FIND_IDS, VOXEL_H } from "./goldrush-resources.js";
import { SAVE_VERSION, writeSave } from "./goldrush-save.js";
import { FLOOR_Y } from "./goldrush-terrain.js";
import { DigEffects } from "./goldrush-vfx.js";
import { GoldRushWorld, SPAWN, SUN_DIR } from "./goldrush-world.js";

export const THREE_REVISION = THREE.REVISION;

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
  constructor(ui, doc, { touch, debug }) {
    this.ui = ui;
    this.doc = doc;
    this.touch = !!touch;
    this.mobile = isMobileDevice() || this.touch;
    this.debug = !!debug;
    this.settings = { quality: "auto", headBob: true, reducedMotion: false, sound: true, vibration: true, ...(doc.settings || {}) };
    this.economy = new Economy(doc.economy);
    this.tool = TOOLS.hand;
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
    this.mining = new MiningSystem(this.terrain);
    if (this.doc.terrain) {
      let ok = false;
      try { ok = this.terrain.deserialize(this.doc.terrain); } catch (e) { ok = false; }
      if (!ok) this.loadNotice = "Die Grabspuren im Spielstand passten nicht mehr – der Berg wurde neu aufgeschüttet.";
      else {
        try { this.mining.deserialize(this.doc.resources); } catch (e) { this.mining.deserialize(null); }
      }
    }
    progress(0.72, "Claim wird aufgebaut …");
    await step();
    world.buildScenery();
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
    this.audio = new GoldRushAudio();
    this.audio.setEnabled(this.settings.sound !== false);
    this.hud = new GoldRushHud(ui.root, ui.moneyEl, { reducedMotion: this.reducedMotion });
    this.hud.setMoney(this.economy.moneyCents);
    const ring = new THREE.RingGeometry(this.tool.radius * 0.9, this.tool.radius, 48);
    this.reticle = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({
      color: 0xfff3d6, transparent: true, opacity: 0.38, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, fog: false,
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
    const held = this.hands.right.held;
    held.geometry = this.loot.geos[5][0];
    held.material = this.loot.goldMat;
    held.visible = true;
    renderer.compile(world.scene, camera);
    renderer.compile(this.hands.scene, this.hands.camera);
    this.render();                                        // uploads the gold pieces' buffers too
    renderer.autoClear = false;
    renderer.render(this.hands.scene, this.hands.camera);
    renderer.autoClear = true;
    held.visible = false;
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
    if (this.debug) {
      this.on(window, "keydown", (e) => {
        if (e.code === "KeyH") this.terrain.setHeatmap(!this.terrain.heatmap);
        if (e.code === "F3") { e.preventDefault(); ui.toggleDebug(); }
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
  setReducedMotion(on) {
    this.settings.reducedMotion = !!on;
    this.reducedMotion = this.systemReducedMotion || !!on;
    if (this.hands) this.hands.reducedMotion = this.reducedMotion;
    if (this.hud) this.hud.reducedMotion = this.reducedMotion;
    this.dirty = true;
  }

  setSound(on) {
    this.settings.sound = !!on;
    this.audio.setEnabled(!!on);
    if (on) this.audio.unlock();
    this.dirty = true;
  }

  setVibration(on) {
    this.settings.vibration = !!on;
    this.dirty = true;
  }

  setQualitySetting(value) {
    this.settings.quality = value;
    this.applyQuality(value === "auto" ? this.autoLevel : value);
    this.dirty = true;
    this.render();
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
    this.hands.update(dt, { camera: this.camera, sunDir: SUN_VEC, sunVisible: this.sunVisible, walk: Math.min(1, Math.hypot(this.player.vx, this.player.vz) / WALK), bob: this.player.bob });
    this.hud.update(dt);
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
    // the hand: strokes while dig is held and the crosshair is on the ground
    const want = input.digHeld && !!this.target;
    if (input.digHeld && !this.target) this._hintNoTarget();
    if (this.hands.tick(dt, want) === "contact") this._contact();
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
    const b = this.terrain.field.raycastBoulders(ox, oy, oz, dx, dy, dz, hit ? hit.distance : SEE, this._hit);
    if (b) { hit = b; b.diggable = true; }
    else if (hit) hit.boulder = null;
    let state = "idle";
    this.target = null;
    if (hit && hit.diggable) {
      const why = this.mining.check(hit, this.tool, p);
      hit.material = this.mining.materialAtHit(hit);
      if (why === "far") state = "far";
      else if (why === "feet") state = "idle";
      else {
        this.target = hit;
        state = this.tool.efficiency(MATERIALS[hit.material]) > 0 ? "dig" : "hard";
      }
      this.farTarget = why === "far" ? hit : null;
    } else this.farTarget = null;
    this.aimState = state;
    const r = this.reticle;
    if (this.target) {
      const n = this.target.normal;
      r.position.set(this.target.x + n.x * 0.012, this.target.y + n.y * 0.012, this.target.z + n.z * 0.012);
      r.quaternion.setFromUnitVectors(ZUP, this._n.set(n.x, n.y, n.z));
      r.material.color.setHex(state === "hard" ? 0xc9c3ba : 0xfff3d6);
      r.visible = true;
    } else {
      r.visible = false;
    }
    this.ui.setCrosshair(state);
  }

  _n = new THREE.Vector3();

  _hintNoTarget() {
    if (this.farTarget) this.hud.tip("far", "Zu weit entfernt – geh näher heran.", 5);
  }

  // the fingers touch the ground now: the whole mining transaction
  _contact() {
    this._aim();                                   // what is under the hand at this very moment
    const hit = this.target;
    if (!hit) {
      this.hands.react("air", 0.12);
      this.audio.play("air");
      return;
    }
    const r = this.mining.stroke(hit, this.tool, this.player);
    this.economy.recordStroke(r);
    const def = MATERIALS[r.material];
    const pan = this._pan(hit), dist = hit.distance;
    if (!r.ok) { this.hands.react("air", 0.12); return; }
    if (r.blocked) {
      this.hands.react("stone", MATERIALS[MAT.STONE].recover);
      this.effects.burst(hit, MATERIALS[MAT.STONE], 0.6);
      this.audio.play("stone", { pan, dist });
      this._haptic(MATERIALS[MAT.STONE].haptic);
      this.hud.tip("stone", "Zu hart für die Hand – hier braucht es später Werkzeug.", 10);
      this.ui.crosshairPulse && this.ui.crosshairPulse("hard");
      this.lastStroke = { material: MAT.STONE, massKg: 0, blocked: true, finds: 0, cents: 0 };
      this.dirty = true;
      return;
    }
    this.hands.react("dirt", def.recover);
    this.effects.burst(hit, def, Math.min(1.2, 0.55 + r.massKg / 5));
    this.audio.play(SOUND[r.material], { pan, dist, strength: Math.min(1, 0.6 + r.massKg / 6) });
    this._haptic(def.haptic);
    this.player.kick = Math.min(0.03, this.player.kick + 0.01);
    this.ui.onDig && this.ui.onDig();
    // finds: booked now (economy), shown now (loot), counted in the HUD on pickup
    const credit = this.economy.credit(r.finds, r.findCount);
    if (credit.items.length) {
      if (credit.firstNugget) for (const it of credit.items) if (it.cls === FIND.NUGGET) { it.first = true; break; }
      this.loot.spawn(credit.items, hit);
      const best = credit.best;
      this.audio.play(best === FIND.NUGGET ? "nugget" : best === FIND.TINY ? "tiny" : best === FIND.FLAKE ? "flake" : "dust", { pan, dist });
      if (best === FIND.NUGGET) this._haptic([14, 50, 24]);
    }
    this.lastStroke = {
      material: r.material, massKg: +r.massKg.toFixed(3), freshKg: +r.freshKg.toFixed(3), slices: r.slices,
      finds: credit.items.length, cents: credit.cents, best: FIND_IDS[credit.best], cells: r.cells, chunks: r.chunks,
    };
    this.dirty = true;
  }

  // the transaction without the hand animation (tests, simulation)
  strokeAtCrosshair({ visuals = true } = {}) {
    this._aim();
    const hit = this.target;
    if (!hit) return null;
    const r = this.mining.stroke(hit, this.tool, this.player);
    this.economy.recordStroke(r);
    if (!r.ok || r.blocked) { this.dirty = true; return { ok: r.ok, blocked: r.blocked, cents: 0, finds: 0, massKg: 0, material: r.material }; }
    const credit = this.economy.credit(r.finds, r.findCount);
    if (visuals) {
      this.effects.burst(hit, MATERIALS[r.material], 1);
      if (credit.items.length) {
        if (credit.firstNugget) for (const it of credit.items) if (it.cls === FIND.NUGGET) { it.first = true; break; }
        this.loot.spawn(credit.items, hit);
      }
    } else if (credit.items.length) {
      for (const it of credit.items) this._collected({ cls: it.cls, cents: it.cents, find: it, silent: true });
    }
    this.dirty = true;
    return { ok: true, blocked: false, cents: credit.cents, finds: credit.items.length, best: credit.best, massKg: r.massKg, material: r.material, slices: r.slices, cells: r.cells, keys: credit.items.map((i) => i.key) };
  }

  // a piece (or dust) reached the player
  _collected(item) {
    this.hud.collected(item.cents, item.cls);
    if (item.cls === FIND.NUGGET) this.hud.nugget(item.cents, !!(item.find && item.find.first));
    if (item.silent) return;
    if (item.cls >= FIND.FLAKE) {
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
    if (this.hands && this.hands.inspecting) {
      const done = this.hands.inspecting.done;
      this.hands.inspecting = null;
      this.hands.state = HAND_STATE.IDLE;
      this.hands.right.held.visible = false;
      if (done) done();
    }
    this.loot.flush();
    this.hud.settle(this.economy.moneyCents);
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
      tool: this.tool.id,
      player: { x: round3(p.x), z: round3(p.z), yaw: round3(p.yaw), pitch: round3(p.pitch) },
      settings: { ...this.settings },
      economy: this.economy.serialize(),
      terrain: this.terrain.serialize(),
      resources: this.mining.serialize(),
    };
  }

  save(reason = "manual") {
    if (!this.ready) return 0;                     // never overwrite a save with a half-built game
    if (this.disposed && reason !== "exit") return 0;
    try {
      const bytes = writeSave(this.buildDoc());
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
      gpu: this.gpu && this.gpu.gpu, saveBytes: this.lastSaveBytes,
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
    return {
      material: MATERIALS[mat].id, hardness: MATERIALS[mat].hardness, handEfficiency: MATERIALS[mat].handEfficiency,
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
      pr ? `Ziel: ${pr.material} (Härte ${pr.hardness}, Hand ${pr.handEfficiency}) · Gold ${pr.gold} · Tiefe ${pr.depth} m · ${pr.distance} m` : "Ziel: –",
      pr ? `Zelle ${pr.cell} · bearbeitet ab Scheibe ${pr.workedSlice} (${pr.worked ? "verbraucht" : "frisch"})` : "",
      ls ? `Letzter Griff: ${ls.blocked ? "Stein – nichts" : `${ls.massKg} kg (${ls.freshKg} frisch), ${ls.slices} Scheiben, ${ls.finds} Fund(e) ${ls.cents} ct`}` : "",
      `Griffe ${st.totalDigs} · erfolgreich ${st.successfulDigs} · Funde ${st.finds} · Nuggets ${this.economy.inventory.nuggets.count}`,
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
    tool: "hand",
    player: { x: SPAWN.x, z: SPAWN.z, yaw: SPAWN.yaw, pitch: SPAWN.pitch },
    settings: { quality: "auto", headBob: true, reducedMotion: false, sound: true, vibration: true },
    economy: null,
    terrain: null,
    resources: null,
  };
}
