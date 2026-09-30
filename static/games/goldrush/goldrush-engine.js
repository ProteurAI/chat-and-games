// GoldRush - the running game: renderer, world, player, digging, save,
// quality, lifecycle. Loaded lazily by goldrush.js (this is the module that
// pulls in three.js), created once per opened game and fully disposed on
// exit - no render loop, listener, timer or GL context survives it.

import * as THREE from "../../vendor/three/three.module.min.js";
import { AssetManager } from "./goldrush-assets.js";
import { GoldRushInput } from "./goldrush-input.js";
import { QUALITY, QUALITY_LEVELS, applyRendererQuality, createRenderer, guessQuality, isMobileDevice } from "./goldrush-renderer.js";
import { SAVE_VERSION, writeSave } from "./goldrush-save.js";
import { DigEffects } from "./goldrush-vfx.js";
import { GoldRushWorld, SPAWN } from "./goldrush-world.js";

export const THREE_REVISION = THREE.REVISION;

const EYE = 1.62;
const RADIUS = 0.33;
const WALK = 3.4;
const SPRINT = 5.6;
const REACH = 2.4;
const FOV = 70;                                   // vertical, for the usual 16:9 / 16:10 screens
const HFOV_MIN = Math.tan((50 * Math.PI) / 360);  // phones upright: still enough view to the sides
const HFOV_MAX = Math.tan((106 * Math.PI) / 360); // phones sideways: no fish-eye
const MAX_CLIMB = Math.tan((38 * Math.PI) / 180);
const DIG = { radius: 0.3, depth: 0.055, interval: 0.24 };      // the bare hand: small, shallow, ~4 per second
const AUTOSAVE_MS = 10000;
const MONITOR = { warmup: 3, window: 2, slowMs: 27, cooldown: 8 };

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
   * @param doc   the save document (new or loaded)
   */
  constructor(ui, doc, { touch, debug }) {
    this.ui = ui;
    this.doc = doc;
    this.touch = !!touch;
    this.mobile = isMobileDevice() || this.touch;
    this.debug = !!debug;
    this.settings = { quality: "auto", headBob: true, reducedMotion: false, sound: true, ...(doc.settings || {}) };
    this.money = doc.money || 0;
    this.digs = (doc.stats && doc.stats.digs) || 0;
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
    this.digTimer = 0;
    this.target = null;
    this.frameMs = [];
    this.stats = { fps: 0, frameMs: 0 };
    this.monitor = { t: 0, acc: 0, n: 0, cooldown: 0 };
    this._off = [];
    this._v2 = new THREE.Vector2();
    this.ready = false;
    this.disposed = false;
  }

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
    if (this.doc.terrain) {
      let ok = false;
      try { ok = this.terrain.deserialize(this.doc.terrain); } catch (e) { ok = false; }
      if (!ok) this.loadNotice = "Die Grabspuren im Spielstand passten nicht mehr – der Berg wurde neu aufgeschüttet.";
    }
    progress(0.72, "Claim wird aufgebaut …");
    await step();
    world.buildScenery();

    const camera = (this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 900));
    camera.rotation.order = "YXZ";
    this.effects = new DigEffects(THREE, world.scene, this.terrain);
    const ring = new THREE.RingGeometry(DIG.radius * 0.9, DIG.radius, 48);
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
    renderer.compile(world.scene, camera);
    progress(0.97, "Erster Blick in die Mine …");
    await step();
    this.render();
    this.ready = true;
    progress(1, "Bereit");
    ui.setMoney(this.money);
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
    this.on(window, "orientationchange", () => setTimeout(onResize, 250));
    this.resizeObserver = new ResizeObserver(onResize);
    this.resizeObserver.observe(ui.root);
    this.on(document, "visibilitychange", () => {
      this.hidden = document.hidden;
      if (this.hidden) { this.save("hidden"); this.input.releaseAll(); }
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
    if (this.camera) this.resize();
    this.monitor = { t: 0, acc: 0, n: 0, cooldown: MONITOR.cooldown };
    this.ui.onQuality && this.ui.onQuality(this.settings.quality, level);
  }

  // in-game switch; the system preference always wins
  setReducedMotion(on) {
    this.settings.reducedMotion = !!on;
    this.reducedMotion = this.systemReducedMotion || !!on;
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
    // in steps short enough for walking and collisions to stay exact
    const dt = Math.min(0.1, Math.max(0, raw));
    this.frameMs.push(raw * 1000);
    if (this.frameMs.length > 120) this.frameMs.shift();
    this._monitor(raw);
    const steps = Math.max(1, Math.ceil(dt / 0.034));
    for (let i = 0; i < steps; i++) this.update(dt / steps);
    this.effects.update(dt);
    this.render();
    if (this.dirty && now - this.lastSave > AUTOSAVE_MS) this.save("auto");
    if (this.debug) this._debugTick(now);
  };

  render() {
    if (this.glLost || this.disposed) return;
    this.renderer.render(this.world.scene, this.camera);
  }

  // ------------------------------------------------------------ simulation

  update(dt) {
    const p = this.player, input = this.input, world = this.world;
    const look = input.takeLook();
    p.yaw -= look.x;
    p.pitch = Math.max(-1.45, Math.min(1.45, p.pitch - look.y));

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
    const tryAxis = (nx, nz) => {
      const d = Math.hypot(nx - p.x, nz - p.z);
      if (d < 1e-6) return;
      const rise = world.groundAt(nx, nz) - g0;
      if (rise > 0 && rise / d > MAX_CLIMB) return false;        // too steep: the mound's flank stops you
      p.x = nx;
      p.z = nz;
      return true;
    };
    if (tryAxis(p.x + p.vx * dt, p.z + p.vz * dt) === false) {
      // slide along the slope: try each axis on its own
      if (tryAxis(p.x + p.vx * dt, p.z) === false) p.vx = 0;
      if (tryAxis(p.x, p.z + p.vz * dt) === false) p.vz = 0;
    }
    world.collide(p, RADIUS);
    const ground = world.groundAt(p.x, p.z) + EYE;
    p.y += (ground - p.y) * Math.min(1, dt * (ground < p.y - 0.4 ? 20 : 12));

    const moving = Math.hypot(p.vx, p.vz);
    if (moving > 0.3) p.bob += dt * moving * 2.1; else p.bob *= Math.exp(-dt * 6);
    p.kick *= Math.exp(-dt * 16);

    // what the hand points at
    this._updateCamera(dt);
    this._aim();
    if (input.digHeld && this.target && this.target.diggable) {
      this.digTimer -= dt;
      if (this.digTimer <= 0) {
        this.digAt(this.target);
        this.digTimer = DIG.interval;
      }
    } else {
      this.digTimer = Math.max(0, this.digTimer - dt);
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

  _aim() {
    const p = this.player, cam = this.camera;
    const cp = Math.cos(p.pitch);
    const dx = -Math.sin(p.yaw) * cp, dy = Math.sin(p.pitch), dz = -Math.cos(p.yaw) * cp;
    const hit = this.terrain.raycast(cam.position.x, cam.position.y, cam.position.z, dx, dy, dz, REACH);
    this.target = hit && hit.diggable ? hit : null;
    const r = this.reticle;
    if (this.target) {
      const n = hit.normal;
      r.position.set(hit.x + n.x * 0.012, hit.y + n.y * 0.012, hit.z + n.z * 0.012);
      r.quaternion.setFromUnitVectors(ZUP, this._n.set(n.x, n.y, n.z));
      r.visible = true;
    } else {
      r.visible = false;
    }
    this.ui.setCrosshair(this.target ? "dig" : "idle");
  }

  _n = new THREE.Vector3();

  // one hand dig at the target; returns the excavation result
  digAt(hit) {
    const res = this.terrain.excavate(hit.x, hit.z, DIG.radius, DIG.depth);
    if (!res || !res.cells) return null;
    const mat = this.terrain.field.sample(hit.x, hit.y - 0.04, hit.z, {});
    this.effects.burst(hit, mat);
    this.player.kick = Math.min(0.03, this.player.kick + 0.014);
    this.digs++;
    this.dirty = true;
    this.lastDig = { removed: res.removed, cells: res.cells, chunks: res.chunks, stone: mat.stone, goldDensity: mat.goldDensity };
    this.ui.onDig && this.ui.onDig();
    return res;
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
    const db = this.renderer.getDrawingBufferSize(this._v2);
    this.effects.setScale(db.y / (2 * Math.tan((this.camera.fov * Math.PI) / 360)));
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
      money: this.money,
      tool: "hand",
      player: { x: round3(p.x), z: round3(p.z), yaw: round3(p.yaw), pitch: round3(p.pitch) },
      settings: { ...this.settings },
      stats: { digs: this.digs },
      terrain: this.terrain.serialize(),
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
      ...this.frameStats(), drawCalls: r.render.calls, triangles: r.render.triangles,
      geometries: r.memory.geometries, textures: r.memory.textures, programs: r.programs ? r.programs.length : 0,
      particles: this.effects.activeDust, fragments: this.effects.activeFrags,
      chunks: t.chunks, terrainTriangles: t.triangles, heapMB: mem, level: this.level, dpr: this.dpr, fov: +this.camera.fov.toFixed(1),
      gpu: this.gpu && this.gpu.gpu, saveBytes: this.lastSaveBytes,
    };
  }

  _debugTick(now) {
    if (now - (this._dbgAt || 0) < 500) return;
    this._dbgAt = now;
    const i = this.info();
    this.ui.setDebug([
      `${i.fps} FPS · ${i.frameMs} ms (p95 ${i.p95})`,
      `Draw calls ${i.drawCalls} · Dreiecke ${(i.triangles / 1000).toFixed(0)}k`,
      `Partikel ${i.particles} · Brocken ${i.fragments}`,
      `Chunks ${i.chunks} · Terrain ${(i.terrainTriangles / 1000).toFixed(0)}k Δ`,
      `Qualität ${i.level} · DPR ${i.dpr}` + (i.heapMB != null ? ` · Heap ${i.heapMB} MB` : ""),
      `Save ${(i.saveBytes / 1024).toFixed(1)} KB · Grabungen ${this.digs}`,
      `H = Gold-Heatmap ${this.terrain.heatmap ? "an" : "aus"} · F3 = Overlay`,
    ].join("\n"));
  }

  // ------------------------------------------------------------ teardown

  dispose() {
    if (this.disposed) return;
    this.save("exit");
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.input) this.input.detach();
    for (const off of this._off.splice(0)) off();          // incl. the context-loss listeners
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.effects) this.effects.dispose();
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
    money: 0,
    tool: "hand",
    player: { x: SPAWN.x, z: SPAWN.z, yaw: SPAWN.yaw, pitch: SPAWN.pitch },
    settings: { quality: "auto", headBob: true, reducedMotion: false, sound: true },
    stats: { digs: 0 },
    terrain: null,
  };
}
