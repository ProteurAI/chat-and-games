// GoldRush - entry point (ES module, loaded on demand by app.js).
//
// Owns the immersive layer: loading screen, HUD, pause/settings, dialogs,
// the WebGL fallback. The heavy part (three.js + the game itself) is
// imported only after the loading screen is up. At most ONE GoldRush runs
// at a time; open() while it is open just returns the running instance.

import { BACKUP_KEY, loadSave, quarantineCorrupt, resetSave } from "./goldrush-save.js";
import { webglAvailable } from "./goldrush-renderer.js";

let current = null;

export function isOpen() { return !!current; }

export function open({ onExit } = {}) {
  if (current) return current;
  current = new GoldRushShell(onExit);
  current.start();
  return current;
}

const ICONS = {
  pause: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/></svg>`,
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>`,
  hand: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 11V5.5a1.5 1.5 0 013 0V10m0-1V4a1.5 1.5 0 013 0v6m0-4.5a1.5 1.5 0 013 0V12m0-3a1.5 1.5 0 013 0v5c0 4-2.7 7-6.5 7-2.4 0-4-1-5.3-2.8L4.7 14a1.6 1.6 0 012.4-2L8 13" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`,
};

const fmtMoney = (v) => `€ ${v.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function newSeed() {
  const a = new Uint32Array(1);
  try { crypto.getRandomValues(a); } catch (e) { a[0] = Math.floor(Math.random() * 2 ** 31); }
  return a[0] & 0x7fffffff;
}

class GoldRushShell {
  constructor(onExit) {
    this.onExit = onExit || (() => {});
    this.touch = window.matchMedia("(pointer: coarse)").matches;
    let dbg = false;
    try { dbg = localStorage.getItem("goldrush.debug") === "1" || /[?&]goldrush-debug\b/.test(location.search); } catch (e) { /* ignore */ }
    this.debug = dbg;
    this.game = null;
    this.closed = false;
    this._off = [];
    this._build();
  }

  on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._off.push(() => target.removeEventListener(type, fn, opts));
  }

  // ------------------------------------------------------------ DOM

  _build() {
    const root = (this.root = document.createElement("div"));
    root.className = "gr-root" + (this.touch ? " gr-touch" : " gr-desktop");
    root.setAttribute("role", "application");
    root.setAttribute("aria-label", "GoldRush");
    root.innerHTML = `
      <canvas class="gr-canvas" tabindex="-1"></canvas>
      <div class="gr-hud" hidden>
        <div class="gr-hud-top">
          <div class="gr-chip gr-brand"><span aria-hidden="true">⛏️</span><span>GoldRush</span></div>
          <div class="gr-hud-right">
            <div class="gr-chip gr-money" aria-label="Guthaben">${fmtMoney(0)}</div>
            <button type="button" class="gr-hud-btn" data-act="settings" aria-label="Pause und Einstellungen">${ICONS.pause}</button>
            <button type="button" class="gr-hud-btn" data-act="exit" aria-label="GoldRush verlassen">${ICONS.close}</button>
          </div>
        </div>
        <div class="gr-chip gr-tool" aria-label="Werkzeug: Hand"><span class="gr-tool-ico">${ICONS.hand}</span><span>Hand</span></div>
        <div class="gr-crosshair" aria-hidden="true"><span></span></div>
        <div class="gr-hint">WASD bewegen · Maus umsehen · Linksklick halten: graben · Esc: Pause</div>
        <div class="gr-notice" role="status" hidden></div>
      </div>
      <div class="gr-stick" aria-hidden="true"><div class="gr-stick-knob"></div></div>
      <button type="button" class="gr-dig-btn" aria-label="Graben (gedrückt halten)"><span class="gr-dig-ico">${ICONS.hand}</span><span>GRABEN</span></button>
      <div class="gr-overlay gr-pause" hidden>
        <div class="gr-card">
          <div class="gr-card-title">Pausiert</div>
          <p class="gr-card-text" data-role="pause-text">Klicke, um weiterzugraben.</p>
          <div class="gr-keys"><span><b>WASD</b> bewegen</span><span><b>Maus</b> umsehen</span><span><b>Linksklick</b> graben</span><span><b>Shift</b> schneller</span><span><b>Esc</b> Pause</span></div>
          <div class="gr-actions">
            <button type="button" class="primary-btn primary-btn--lg" data-act="resume">Weiterspielen</button>
            <button type="button" class="ghost-btn" data-act="settings">Einstellungen</button>
            <button type="button" class="ghost-btn" data-act="exit">Verlassen</button>
          </div>
        </div>
      </div>
      <div class="gr-panel" hidden role="dialog" aria-modal="true" aria-label="GoldRush Einstellungen">
        <div class="gr-card gr-settings">
          <div class="gr-card-title">Einstellungen</div>
          <div class="gr-field">
            <div class="gr-label">Grafikqualität</div>
            <div class="gr-seg" role="radiogroup" aria-label="Grafikqualität">
              <button type="button" role="radio" data-q="auto">Auto</button>
              <button type="button" role="radio" data-q="low">Niedrig</button>
              <button type="button" role="radio" data-q="medium">Mittel</button>
              <button type="button" role="radio" data-q="high">Hoch</button>
            </div>
            <div class="gr-sub" data-role="q-note"></div>
          </div>
          <label class="gr-toggle"><input type="checkbox" data-role="headbob" /><span>Kopfbewegung beim Laufen</span></label>
          <label class="gr-toggle"><input type="checkbox" data-role="reduced" /><span>Reduzierte Bewegung <em>(kein Wippen, kein Rückstoß, keine HUD-Animationen)</em></span></label>
          <div class="gr-sub" data-role="bob-note" hidden>Dein System wünscht reduzierte Bewegung – sie ist hier immer an.</div>
          <label class="gr-toggle"><input type="checkbox" data-role="sound" /><span>Sound</span></label>
          <label class="gr-toggle" data-role="vibration-row" hidden><input type="checkbox" data-role="vibration" /><span>Vibration <em>(dezent, bei Treffern und Funden)</em></span></label>
          <div class="gr-danger-zone">
            <button type="button" class="ghost-btn gr-reset" data-act="reset">Spielstand zurücksetzen …</button>
            <div class="gr-confirm" hidden>
              <p>Deinen GoldRush-Fortschritt wirklich löschen? Der Berg wird komplett neu aufgeschüttet.</p>
              <div class="gr-actions">
                <button type="button" class="ghost-btn" data-act="reset-cancel">Abbrechen</button>
                <button type="button" class="primary-btn danger-btn" data-act="reset-confirm">Endgültig zurücksetzen</button>
              </div>
            </div>
          </div>
          <div class="gr-actions gr-actions--end">
            <button type="button" class="ghost-btn" data-act="exit">GoldRush verlassen</button>
            <button type="button" class="primary-btn" data-act="close-settings">Zurück zum Spiel</button>
          </div>
        </div>
      </div>
      <div class="gr-loading">
        <div class="gr-loading-inner">
          <div class="gr-loading-brand"><span class="gr-pick" aria-hidden="true">⛏️</span><span>GoldRush</span></div>
          <div class="gr-loading-text" data-role="load-text">Mine wird vorbereitet …</div>
          <div class="gr-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>
          <div class="gr-loading-step" data-role="load-step"></div>
          <button type="button" class="gr-loading-cancel" data-act="exit">Abbrechen</button>
        </div>
      </div>
      <div class="gr-overlay gr-dialog" hidden role="alertdialog" aria-modal="true">
        <div class="gr-card">
          <div class="gr-card-title" data-role="dlg-title"></div>
          <p class="gr-card-text" data-role="dlg-text"></p>
          <div class="gr-actions" data-role="dlg-actions"></div>
        </div>
      </div>
      <pre class="gr-debug" hidden></pre>`;
    document.body.appendChild(root);
    document.documentElement.classList.add("goldrush-active");
    const q = (s) => root.querySelector(s);
    this.el = {
      canvas: q(".gr-canvas"), hud: q(".gr-hud"), money: q(".gr-money"), crosshair: q(".gr-crosshair"), hint: q(".gr-hint"),
      notice: q(".gr-notice"), stick: q(".gr-stick"), knob: q(".gr-stick-knob"), digBtn: q(".gr-dig-btn"),
      pause: q(".gr-pause"), pauseText: q("[data-role=pause-text]"), panel: q(".gr-panel"), loading: q(".gr-loading"),
      loadText: q("[data-role=load-text]"), loadStep: q("[data-role=load-step]"), progress: q(".gr-progress"),
      dialog: q(".gr-dialog"), debug: q(".gr-debug"), tool: q(".gr-tool"),
    };
    this.on(root, "click", (e) => {
      const b = e.target.closest("[data-act]");
      if (b) this._act(b.dataset.act);
      const qb = e.target.closest("[data-q]");
      if (qb && this.game) { this.game.setQualitySetting(qb.dataset.q); this._syncSettings(); }
    });
    this.on(root.querySelector("[data-role=headbob]"), "change", (e) => {
      if (!this.game) return;
      this.game.settings.headBob = e.target.checked;
      this.game.dirty = true;
    });
    this.on(root.querySelector("[data-role=sound]"), "change", (e) => { if (this.game) this.game.setSound(e.target.checked); });
    this.on(root.querySelector("[data-role=vibration]"), "change", (e) => { if (this.game) this.game.setVibration(e.target.checked); });
    this.on(root.querySelector("[data-role=reduced]"), "change", (e) => {
      if (!this.game) return;
      this.game.setReducedMotion(e.target.checked);
      this._syncSettings();
    });
    this.on(window, "keydown", (e) => {
      if (e.key === "Escape" && !this.el.panel.hidden) { e.preventDefault(); this._closeSettings(); }
    }, true);
  }

  // ------------------------------------------------------------ flow

  async start() {
    this._progress(0.04, "Mine wird vorbereitet …");
    if (!webglAvailable()) {
      this._fallback("GoldRush benötigt WebGL auf diesem Gerät.", "Dein Browser oder Gerät stellt gerade keine 3D-Grafik bereit. Aktiviere die Hardwarebeschleunigung oder probiere einen anderen Browser.");
      return;
    }
    let doc;
    const res = loadSave();
    if (res.status === "ok") doc = res.doc;
    else if (res.status === "backup") { doc = res.doc; this.pendingNotice = "Der letzte Spielstand war beschädigt – die Sicherung wurde geladen."; }
    else if (res.status === "corrupt") {
      const choice = await this._ask("Spielstand beschädigt",
        `Dein GoldRush-Spielstand konnte nicht gelesen werden (${res.error}). Du kannst neu beginnen – der alte Stand wird zur Sicherheit beiseitegelegt.`,
        [{ id: "exit", label: "Zurück", ghost: true }, { id: "new", label: "Neues Spiel starten" }]);
      if (this.closed) return;
      if (choice !== "new") { this.close(); return; }
      quarantineCorrupt();
    }
    this._progress(0.1, "Grafik-Engine wird geladen …");
    let engine;
    try {
      engine = await import("./goldrush-engine.js");
    } catch (e) {
      if (!this.closed) this._fallback("GoldRush konnte nicht geladen werden.", "Bitte prüfe deine Verbindung und versuche es gleich noch einmal.");
      return;
    }
    if (this.closed) return;
    if (!doc) doc = engine.newWorldDoc(this._testSeed() ?? newSeed());
    this.engine = engine;
    const game = (this.game = new engine.GoldRushGame(this._bridge(), doc, { touch: this.touch, debug: this.debug }));
    try {
      await game.init((p, text) => this._progress(p, text));
    } catch (e) {
      if (e === engine.ABORTED || this.closed) return;          // left while loading: close() already cleaned up
      console.error("[goldrush] start failed", e);
      game.dispose();
      this.game = null;
      if (!this.closed) this._fallback("GoldRush konnte nicht gestartet werden.", "Die 3D-Grafik ließ sich auf diesem Gerät nicht einrichten.");
      return;
    }
    if (this.closed) { game.dispose(); return; }
    this.el.loading.classList.add("is-done");
    setTimeout(() => { if (this.el) this.el.loading.hidden = true; }, 420);
    this.el.hud.hidden = false;
    if (this.debug) this.el.debug.hidden = false;
    this._syncSettings();
    if (this.pendingNotice || game.loadNotice) this.notice(this.pendingNotice || game.loadNotice);
    if (this.touch) {
      game.setPaused(false);
      if (window.matchMedia("(orientation: portrait)").matches) setTimeout(() => { if (!this.closed) this.notice("Tipp: Für mehr Übersicht das Gerät drehen."); }, 1800);
    } else {
      this.el.pauseText.textContent = "Klicke, um zu starten. Die Maus steuert dann den Blick.";
      this.el.pause.querySelector("[data-act=resume]").textContent = "Loslegen";
      this.el.pause.hidden = false;
      this._hintT = setTimeout(() => { if (this.el) this.el.hint.classList.add("is-faded"); }, 9000);
    }
    this._exposeTestHooks();
  }

  _bridge() {
    const el = this.el;
    return {
      root: this.root, canvas: el.canvas, stick: el.stick, knob: el.knob, digBtn: el.digBtn, moneyEl: el.money,
      setCrosshair: (state) => { if (el.crosshair.dataset.state !== state) el.crosshair.dataset.state = state; },
      onDig: () => {
        el.crosshair.classList.remove("is-pulse");
        void el.crosshair.offsetWidth;                // restart the tiny pulse
        el.crosshair.classList.add("is-pulse");
        el.tool.classList.add("is-working");
        el.digBtn.classList.add("is-stroke");
        clearTimeout(this._toolT);
        this._toolT = setTimeout(() => { if (this.el) { el.tool.classList.remove("is-working"); el.digBtn.classList.remove("is-stroke"); } }, 120);
      },
      showPauseOverlay: (show, failed) => {
        el.pauseText.textContent = failed
          ? "Die Maussteuerung wurde vom Browser nicht freigegeben. Klicke noch einmal ins Spiel."
          : "Klicke, um weiterzugraben.";
        el.pause.querySelector("[data-act=resume]").textContent = "Weiterspielen";
        el.pause.hidden = !show;
      },
      showGlLost: (show) => {
        if (show) this._showDialog("Grafikverbindung wurde unterbrochen.", "Die 3D-Grafik wird wiederhergestellt, sobald der Browser es erlaubt. Dein Fortschritt ist gespeichert.",
          [{ id: "exit", label: "GoldRush verlassen", ghost: true }]);
        else this._hideDialog();
      },
      notice: (t) => this.notice(t),
      setDebug: (t) => { el.debug.textContent = t; },
      toggleDebug: () => { el.debug.hidden = !el.debug.hidden; },
      panelOpen: () => !el.panel.hidden,
      onQuality: () => this._syncSettings(),
    };
  }

  _act(act) {
    const g = this.game;
    if (act === "exit") { this.close(); return; }
    if (act === "resume") {
      if (!g) return;
      if (this.touch) { g.setPaused(false); this.el.pause.hidden = true; } else g.input.requestLock();
      return;
    }
    if (act === "settings") { this._openSettings(); return; }
    if (act === "close-settings") { this._closeSettings(); return; }
    if (act === "reset") { this.root.querySelector(".gr-confirm").hidden = false; this.root.querySelector(".gr-reset").hidden = true; return; }
    if (act === "reset-cancel") { this.root.querySelector(".gr-confirm").hidden = true; this.root.querySelector(".gr-reset").hidden = false; return; }
    if (act === "reset-confirm") { this._resetGame(); return; }
    if (act.startsWith("dlg:")) { const r = this._dlgResolve; this._hideDialog(); if (r) r(act.slice(4)); else if (act === "dlg:exit") this.close(); }
  }

  _openSettings() {
    if (!this.game) return;
    this.el.panel.hidden = false;
    this.el.pause.hidden = true;
    this.game.setPaused(true);
    this.game.input.exitLock();
    this._syncSettings();
    const first = this.el.panel.querySelector(".gr-seg button[aria-checked=true]") || this.el.panel.querySelector("button");
    if (first) first.focus({ preventScroll: true });
  }

  _closeSettings() {
    this.el.panel.hidden = true;
    this.root.querySelector(".gr-confirm").hidden = true;
    this.root.querySelector(".gr-reset").hidden = false;
    if (!this.game) return;
    if (this.touch) this.game.setPaused(false);
    else { this.el.pauseText.textContent = "Klicke, um weiterzugraben."; this.el.pause.hidden = false; }
  }

  _syncSettings() {
    const g = this.game;
    if (!g) return;
    const s = g.settings;
    for (const b of this.root.querySelectorAll("[data-q]")) b.setAttribute("aria-checked", String(b.dataset.q === s.quality));
    const names = { low: "Niedrig", medium: "Mittel", high: "Hoch" };
    this.root.querySelector("[data-role=q-note]").textContent = s.quality === "auto"
      ? `Auto nutzt gerade: ${names[g.level]} – passt sich an, wenn es ruckelt.` : "Gilt sofort, ohne Neustart.";
    const bob = this.root.querySelector("[data-role=headbob]");
    bob.checked = !!s.headBob && !g.reducedMotion;
    bob.disabled = g.reducedMotion;
    const rm = this.root.querySelector("[data-role=reduced]");
    rm.checked = g.reducedMotion;
    rm.disabled = g.systemReducedMotion;
    this.root.querySelector("[data-role=bob-note]").hidden = !g.systemReducedMotion;
    this.root.querySelector("[data-role=sound]").checked = s.sound !== false;
    const canVibrate = this.touch && typeof navigator.vibrate === "function";
    this.root.querySelector("[data-role=vibration-row]").hidden = !canVibrate;
    this.root.querySelector("[data-role=vibration]").checked = s.vibration !== false;
    this.root.classList.toggle("gr-reduced", g.reducedMotion);
  }

  async _resetGame() {
    const onExit = this.onExit;
    this.onExit = () => {};
    if (this.game) { this.game.dispose(); this.game = null; }
    resetSave();
    this.close();
    current = null;
    open({ onExit });                                 // a fresh mine with a new seed
  }

  // fixed world seed for automated tests (goldrush.testSeed), never in normal play
  _testSeed() {
    if (!(this.debug || navigator.webdriver)) return null;
    try {
      const v = localStorage.getItem("goldrush.testSeed");
      return v != null && /^\d+$/.test(v) ? Number(v) : null;
    } catch (e) { return null; }
  }

  notice(text) {
    const n = this.el.notice;
    n.textContent = text;
    n.hidden = false;
    clearTimeout(this._noticeT);
    this._noticeT = setTimeout(() => { n.hidden = true; }, 6000);
  }

  _progress(p, text) {
    const pct = Math.round(Math.max(0, Math.min(1, p)) * 100);
    this.el.progress.querySelector("span").style.width = `${pct}%`;
    this.el.progress.setAttribute("aria-valuenow", String(pct));
    if (text) this.el.loadStep.textContent = text;
  }

  _fallback(title, text) {
    this.el.loading.hidden = true;
    this._showDialog(title, text, [{ id: "exit", label: "Zurück zum Chat" }]);
  }

  _ask(title, text, buttons) {
    return new Promise((resolve) => { this._dlgResolve = resolve; this._showDialog(title, text, buttons); });
  }

  _showDialog(title, text, buttons) {
    const d = this.el.dialog;
    d.querySelector("[data-role=dlg-title]").textContent = title;
    d.querySelector("[data-role=dlg-text]").textContent = text;
    const box = d.querySelector("[data-role=dlg-actions]");
    box.innerHTML = "";
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = b.ghost ? "ghost-btn" : "primary-btn";
      btn.dataset.act = `dlg:${b.id}`;
      btn.textContent = b.label;
      box.appendChild(btn);
    }
    d.hidden = false;
    const last = box.lastElementChild;
    if (last) last.focus({ preventScroll: true });
  }

  _hideDialog() {
    this.el.dialog.hidden = true;
    this._dlgResolve = null;
  }

  // test / debug handle - only for automated tests (webdriver) or ?goldrush-debug
  _exposeTestHooks() {
    if (!(this.debug || navigator.webdriver)) return;
    const g = this.game;
    window.__goldrush = {
      state: () => ({
        x: g.player.x, y: g.player.y, z: g.player.z, yaw: g.player.yaw, pitch: g.player.pitch, camY: g.camera.position.y,
        paused: g.paused, running: g.running, locked: g.input.locked, free: g.input.free, level: g.level, quality: g.settings.quality,
        digs: g.digs, strokes: g.economy.stats.totalDigs, money: g.money, moneyCents: g.economy.moneyCents, seed: g.doc.worldSeed,
        target: !!g.target, targetDist: g.target ? g.target.distance : null, aim: g.aimState, digHeld: g.input.digHeld, revision: g.terrain.revision,
        headBob: g.settings.headBob, reducedMotion: g.reducedMotion, touch: this.touch,
      }),
      info: () => g.info(),
      pose: ({ x, z, yaw, pitch }) => {
        const p = g.player;
        if (x != null) p.x = x;
        if (z != null) p.z = z;
        if (yaw != null) p.yaw = yaw;
        if (pitch != null) p.pitch = pitch;
        p.vx = p.vz = 0;
        p.y = g.world.groundAt(p.x, p.z) + 1.62;
        g._updateCamera();
        g._aim();
        g.render();
        return !!g.target;
      },
      // n mining transactions at the crosshair (no hand animation); visuals:false = booked right away
      digAtCrosshair: (n = 1, opts = {}) => {
        let done = 0, cents = 0, finds = 0, blocked = 0, best = 0;
        const t0 = performance.now(), keys = [];
        for (let i = 0; i < n; i++) {
          const r = g.strokeAtCrosshair(opts);
          if (!r) continue;
          if (r.blocked) blocked++;
          else if (r.massKg > 0) { done++; cents += r.cents; finds += r.finds; best = Math.max(best, r.best || 0); if (r.keys) keys.push(...r.keys); }
        }
        const ms = performance.now() - t0;
        if (opts.visuals !== false) g.render();
        return { done, blocked, cents, finds, best, keys, ms, perDig: done ? ms / done : 0, last: g.lastStroke };
      },
      economy: () => ({ ...g.economy.serialize(), sessionCents: g.economy.sessionCents, shownCents: g.hud.shown }),
      probe: () => g.probe(),
      aim: () => ({ state: g.aimState, material: g.target ? g.target.material : null, distance: g.target ? g.target.distance : g.farTarget ? g.farTarget.distance : null }),
      hand: () => ({ state: g.hands.state, cycle: g.hands.cycle, inspecting: !!g.hands.inspecting, dirt: g.hands.dirt }),
      loot: () => ({ active: g.loot.active, glints: g.loot.activeGlints, floats: g.hud.floatsVisible }),
      flushLoot: () => { g.flushLoot(); return g.economy.moneyCents; },
      materialAt: (x, y, z) => g.terrain.field.materialAt(x, y, z),
      goldAt: (x, y, z) => { const f = g.terrain.field, m = f.materialAt(x, y, z); return f.goldDensityAt(x, y, z, m, g.terrain.getBaseHeightAt(x, z) - y); },
      voxel: (i, j, iy) => ({ ...g.terrain.field.voxel(i, j, iy, {}) }),
      worked: (x, z) => { const t = g.terrain, i = Math.round((x - t.x0) / t.cell), j = Math.round((z - t.z0) / t.cell); return { slice: g.mining.cidx[j * t.vps + i], level: g.mining.consumed[j * t.vps + i], height: t.height[j * t.vps + i] }; },
      boulders: () => g.terrain.field.boulders.map((b) => ({ ...b })),
      // debug/test only: a find of class cls at the crosshair, booked like a real one
      debugFind: (cls, massUg) => {
        g._aim();
        const hit = g.target;
        if (!hit) return null;
        const f = { cls, massUg, x: hit.x, y: hit.y, z: hit.z, key: "debug" };
        const credit = g.economy.credit([f], 1);
        if (credit.firstNugget) credit.items[0].first = true;
        g.loot.spawn(credit.items, hit);
        return credit.cents;
      },
      handPose: (pose) => { g.hands.debugPose = pose; g.hands.update(0, { camera: g.camera, sunDir: g.world.sun.position.clone().normalize(), sunVisible: true, walk: 0, bob: 0 }); g.render(); },
      lootLook: () => { const m = g.loot.goldMat; return { metalness: m.metalness, roughness: m.roughness, envMap: !!m.envMap, color: m.color.getHexString(), shine: g.loot.shine, pointLights: g.world.scene.children.filter((o) => o.isPointLight).length }; },
      hudState: () => {
        const q = (sel) => this.root.querySelector(sel);
        return {
          toast: q(".gr-toast").hidden ? null : q(".gr-toast").textContent, tip: q(".gr-tip").hidden ? null : q(".gr-tip").textContent,
          floats: [...this.root.querySelectorAll(".gr-float")].filter((e) => !e.hidden).map((e) => e.textContent),
          money: q(".gr-money").textContent, sub: q(".gr-money-sub") && !q(".gr-money-sub").hidden ? q(".gr-money-sub").textContent : null,
          crosshair: q(".gr-crosshair").dataset.state || "idle",
        };
      },
      // exact fingerprints of the world state (save/reload tests)
      hashes: () => {
        const h = (arr, scale) => { let v = 0; for (let k = 0; k < arr.length; k++) v = (Math.imul(v, 31) + Math.round(arr[k] * scale)) | 0; return v; };
        return { height: h(g.terrain.height, 1000), slices: h(g.mining.cidx, 1), money: g.economy.moneyCents, finds: g.economy.stats.finds, seed: g.doc.worldSeed };
      },
      sceneStats: () => {
        const out = { world: {}, hands: 0, shadowCasters: 0 };
        g.world.scene.traverseVisible((o) => {
          if (!o.isMesh && !o.isPoints) return;
          const key = o.name || o.geometry.type || o.type;
          out.world[key] = (out.world[key] || 0) + 1;
          if (o.castShadow) out.shadowCasters++;
        });
        g.hands.scene.traverseVisible((o) => { if (o.isMesh) out.hands++; });
        const r = g.renderer, sm = r.shadowMap.autoUpdate;
        r.info.reset(); r.render(g.world.scene, g.camera); out.worldCalls = r.info.render.calls;
        r.shadowMap.autoUpdate = false;
        r.info.reset(); r.render(g.world.scene, g.camera); out.worldCallsNoShadow = r.info.render.calls;
        r.shadowMap.autoUpdate = sm;
        r.info.reset(); r.autoClear = false; g.hands.render(r); r.autoClear = true; out.handCalls = r.info.render.calls;
        return out;
      },
      // like pose(), without drawing a frame (fast loops in tests / the economy simulation)
      aimAt: ({ x, z, yaw, pitch }) => {
        const p = g.player;
        p.x = x; p.z = z; p.yaw = yaw; p.pitch = pitch; p.vx = p.vz = 0;
        p.y = g.world.groundAt(x, z) + 1.62;
        g._updateCamera();
        g._aim();
        return g.target ? g.target.distance : null;
      },
      terrainOk: () => g.terrain.validate(),
      terrain: () => g.terrain,
      heightAt: (x, z) => g.terrain.getHeightAt(x, z),
      baseSignature: () => { let h = 0; const b = g.terrain.base; for (let k = 0; k < b.length; k += 97) h = (h * 31 + Math.round(b[k] * 1000)) | 0; return h; },
      save: () => g.save("test"),
      saveBytes: () => { try { return (localStorage.getItem("goldrush.save") || "").length; } catch (e) { return -1; } },
      setQuality: (v) => { g.setQualitySetting(v); this._syncSettings(); return g.level; },
      loseContext: () => { const ext = g.renderer.getContext().getExtension("WEBGL_lose_context"); if (ext) { ext.loseContext(); setTimeout(() => ext.restoreContext(), 400); } return !!ext; },
      sampleAt: (x, y, z) => g.terrain.field.sample(x, y, z, {}),
      three: this.engine.THREE_REVISION,
      backupKey: BACKUP_KEY,
    };
  }

  // ------------------------------------------------------------ close

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.game) { this.game.dispose(); this.game = null; }
    for (const off of this._off.splice(0)) off();
    clearTimeout(this._noticeT);
    clearTimeout(this._toolT);
    clearTimeout(this._hintT);
    if (this._dlgResolve) { const r = this._dlgResolve; this._dlgResolve = null; r("exit"); }
    this.root.remove();
    this.root = null;
    this.el = null;
    document.documentElement.classList.remove("goldrush-active");
    if (window.__goldrush) delete window.__goldrush;
    if (current === this) current = null;
    try { this.onExit(); } catch (e) { /* ignore */ }
  }
}
