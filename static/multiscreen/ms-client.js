// ============================================================================
// MultiScreen / Table Mode - client. Several phones lying on a table become
// one screen: every phone draws only its own rectangle of ONE shared world
// the server owns (backend/multiscreen/). This module is the reusable part
// every MultiScreen game gets for free:
//
//   entry (start / join by code) -> setup (host arranges the phones in a
//   layout editor, everyone may calibrate with a bank card) -> test (colour,
//   edges, wave across all screens, seams) -> ready (sizes frozen) -> game.
//
// plus the stage every game draws on (world-anchored background, walls,
// letterboxing, rotation), swipe/keyboard/D-pad input turned into LOCAL
// directions (the server maps them through this screen's rotation), clock
// sync, wake lock, immersive mode, pause/reconnect UI, visibility/
// orientation reporting. Games plug in via window.MultiScreenGames[key].
//
// Chat stays available before and after a game (header 💬 minimises this
// overlay); while a game runs the world has absolute priority - no chat,
// no floating buttons, only a discreet ⋯ in the safe-area corner.
//
// window.MultiScreen = { init(opts), handleMessage(msg), onSocketOpen(),
//                        openEntry(gameKey), lobby(), isOpen() }
// ============================================================================
(function () {
  "use strict";

  const G = window.MSGeometry;
  const DEVICE_KEY = "ms_device_id";
  const CODE_KEY = "ms_session_code";
  const CALIB_KEY = "ms_px_per_mm";
  const DPAD_KEY = "ms_dpad";
  const SOUND_KEY = "ms_sound";
  const SNAP = 7;              // world units: magnetic edge snapping in the editor
  const NUDGE = 10;            // world units per arrow tap in the editor
  const CARD_W = 53.98, CARD_H = 85.6;   // ISO/IEC 7810 ID-1 bank card, mm

  const S = {
    send: null, getMe: null, toast: (t) => console.log(t), onLobbyChange: () => {},
    deviceId: null, code: null, gameKey: null,
    state: null, gameState: null, gameRecv: 0,
    lobby: [], catalog: [],
    open: false, minimized: false,
    offset: null, bestRtt: Infinity, pingTimer: null,
    wakeLock: null, raf: null, game: null, gameFor: null,
    drafts: {}, selected: null, drag: null,
    debug: /[?&]msdebug\b/.test(location.search),
    frames: 0, fps: 0, fpsT: 0,
    lastInfoSent: null, infoTimer: null,
  };

  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function sstore(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function sload(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }

  function deviceId() {
    let id = load(DEVICE_KEY);
    if (!id || !/^[A-Za-z0-9_-]{8,40}$/.test(id)) {
      const a = new Uint8Array(12);
      (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => { a[i] = Math.random() * 256; });
      id = "d" + Array.from(a, (b) => (b % 36).toString(36)).join("");
      store(DEVICE_KEY, id);
    }
    return id;
  }

  function send(msg) { if (S.send) S.send(msg); }
  // the app's own confirm dialog (sits above this overlay); native as fallback
  function ask(title, text, confirmLabel) {
    return window.confirmDialog ? window.confirmDialog({ title, text, confirmLabel }) : Promise.resolve(window.confirm(title));
  }
  function serverNow() { return Date.now() / 1000 + (S.offset || 0); }
  function me() { return S.state ? S.state.devices.find((d) => d.deviceId === S.deviceId) : null; }
  function isHost() { return !!S.state && S.state.hostDeviceId === S.deviceId; }
  function myTile() { return S.state ? S.state.layout.tiles.find((t) => t.deviceId === S.deviceId) || null : null; }
  function deviceById(id) { return S.state ? S.state.devices.find((d) => d.deviceId === id) : null; }
  function nameOf(id) { const d = deviceById(id); return d ? d.name : "?"; }

  // ---------------------------------------------------------------------
  // Device info: viewport, dpr, orientation, safe areas, capabilities,
  // calibration. Nothing personal (no model, no user agent).
  // ---------------------------------------------------------------------
  let safeProbe = null;
  function safeArea() {
    if (!safeProbe) {
      safeProbe = document.createElement("div");
      safeProbe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
      document.body.appendChild(safeProbe);
    }
    const cs = getComputedStyle(safeProbe);
    return { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
  }
  function viewportSize() {
    // the stage is edge-to-edge over the whole visual viewport - never a
    // bare 100vh guess
    const vv = window.visualViewport;
    const w = vv ? vv.width * (vv.scale || 1) : window.innerWidth;
    const h = vv ? vv.height * (vv.scale || 1) : window.innerHeight;
    return { w: Math.round(Math.max(w, window.innerWidth * 0.5)), h: Math.round(Math.max(h, window.innerHeight * 0.5)) };
  }
  function calibration() { const v = parseFloat(load(CALIB_KEY)); return v > 1.5 && v < 30 ? v : null; }
  function deviceInfo() {
    const v = viewportSize();
    return {
      cssWidth: v.w, cssHeight: v.h, dpr: window.devicePixelRatio || 1, pxPerMm: calibration(),
      safeArea: safeArea(),
      capabilities: {
        touch: "ontouchstart" in window || (navigator.maxTouchPoints || 0) > 0,
        pointer: window.matchMedia ? window.matchMedia("(pointer: coarse)").matches : false,
        wakeLock: "wakeLock" in navigator,
        fullscreen: !!(document.fullscreenEnabled || document.webkitFullscreenEnabled),
        vibrate: "vibrate" in navigator,
      },
    };
  }
  function reportDeviceInfo(force) {
    if (!S.code) return;
    const info = deviceInfo();
    const prev = S.lastInfoSent;
    const flipped = prev && (prev.cssWidth > prev.cssHeight) !== (info.cssWidth > info.cssHeight);
    const big = !prev || Math.abs(prev.cssWidth - info.cssWidth) / prev.cssWidth > 0.03 || Math.abs(prev.cssHeight - info.cssHeight) / prev.cssHeight > 0.03;
    if (!force && !flipped && !big && prev && prev.pxPerMm === info.pxPerMm) return;
    S.lastInfoSent = info;
    send({ type: "ms_device_info", device: info });
  }
  function scheduleInfo() {
    clearTimeout(S.infoTimer);
    S.infoTimer = setTimeout(() => reportDeviceInfo(false), 350);
  }

  // ---------------------------------------------------------------------
  // Clock sync (ping/pong, best RTT wins) - drives every synchronized
  // animation (test wave, intro sweep, countdowns) without streaming frames.
  // ---------------------------------------------------------------------
  function startPing() {
    if (S.pingTimer) return;
    const ping = () => send({ type: "ms_ping", t: Date.now() / 1000 });
    ping();
    S.pingTimer = setInterval(ping, 2000);
  }
  function stopPing() { clearInterval(S.pingTimer); S.pingTimer = null; }
  function onPong(msg) {
    const now = Date.now() / 1000;
    const rtt = now - msg.t;
    if (!(rtt >= 0 && rtt < 5)) return;
    S.rtt = rtt;
    if (rtt <= S.bestRtt * 1.3 || S.offset == null) {
      S.bestRtt = Math.min(S.bestRtt, rtt);
      S.offset = msg.serverTime - (msg.t + rtt / 2);
    }
  }

  // ---------------------------------------------------------------------
  // Wake lock + immersive mode (both optional, silently skipped if the
  // browser doesn't have them - iPhone Safari has no fullscreen API)
  // ---------------------------------------------------------------------
  async function wantWakeLock(on) {
    if (!("wakeLock" in navigator)) return;
    if (on && !S.wakeLock && document.visibilityState === "visible") {
      try {
        S.wakeLock = await navigator.wakeLock.request("screen");
        S.wakeLock.addEventListener("release", () => { S.wakeLock = null; });
      } catch (e) { S.wakeLock = null; }
    } else if (!on && S.wakeLock) {
      try { await S.wakeLock.release(); } catch (e) { /* ignore */ }
      S.wakeLock = null;
    }
  }
  function canFullscreen() { return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled); }
  function toggleFullscreen() {
    const d = document;
    if (d.fullscreenElement || d.webkitFullscreenElement) { (d.exitFullscreen || d.webkitExitFullscreen).call(d); return; }
    const el = document.documentElement;
    const fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (fn) { try { const p = fn.call(el); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ } }
  }

  // ---------------------------------------------------------------------
  // Sound + haptics (tiny generated beeps, no assets)
  // ---------------------------------------------------------------------
  let audioCtx = null;
  function soundOn() { return load(SOUND_KEY) !== "0"; }
  function beep(freq, dur, type, gain, delay) {
    if (!soundOn()) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const t0 = audioCtx.currentTime + (delay || 0);
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = type || "sine"; o.frequency.value = freq;
      g.gain.setValueAtTime(gain || 0.05, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    } catch (e) { /* best effort */ }
  }
  const sound = {
    tick: () => beep(660, 0.08, "sine", 0.04),
    go: () => { beep(660, 0.09); beep(990, 0.14, "sine", 0.05, 0.09); },
    handoff: () => { beep(880, 0.06, "sine", 0.05); beep(1320, 0.09, "sine", 0.05, 0.06); },
    prepare: () => beep(520, 0.05, "sine", 0.03),
    food: () => { beep(740, 0.07, "triangle", 0.05); beep(1110, 0.1, "triangle", 0.05, 0.06); },
    crash: () => { beep(180, 0.22, "square", 0.05); beep(120, 0.3, "square", 0.05, 0.15); },
    over: () => { beep(523, 0.14); beep(392, 0.16, "sine", 0.05, 0.15); beep(262, 0.3, "sine", 0.05, 0.32); },
  };
  function vibrate(p) { if (window.MobileUX) window.MobileUX.vibrate(p); else try { navigator.vibrate && navigator.vibrate(p); } catch (e) { /* ignore */ } }

  // ---------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------
  let root, shell, head, main, stage, canvas, ctx, stageUi, hostBar, menuBtn, menuEl, dpadWrap, returnBar, calibEl;
  function build() {
    if (root) return;
    root = document.createElement("div");
    root.id = "ms-overlay";
    root.className = "ms-overlay";
    root.hidden = true;
    root.innerHTML = `
      <div class="ms-shell" data-role="shell">
        <header class="ms-head">
          <button type="button" class="icon-btn ms-head-btn" data-role="close" aria-label="MultiScreen verlassen">✕</button>
          <div class="ms-head-title" data-role="title">📱 MultiScreen</div>
          <button type="button" class="icon-btn ms-head-btn" data-role="minimize" aria-label="Zum Chat">💬</button>
        </header>
        <main class="ms-main" data-role="main"></main>
      </div>
      <div class="ms-stage" data-role="stage" hidden>
        <canvas class="ms-canvas" data-role="canvas"></canvas>
        <div class="ms-stage-ui" data-role="stage-ui"></div>
        <div class="ms-hostbar" data-role="hostbar" hidden></div>
        <div class="ms-dpad-wrap" data-role="dpad" hidden></div>
        <button type="button" class="ms-menu-btn" data-role="menu-btn" aria-label="Menü">⋯</button>
        <div class="ms-menu" data-role="menu" hidden></div>
      </div>
      <div class="ms-calib-layer" data-role="calib" hidden></div>
    `;
    document.body.appendChild(root);
    shell = root.querySelector('[data-role="shell"]');
    main = root.querySelector('[data-role="main"]');
    head = root.querySelector('[data-role="title"]');
    stage = root.querySelector('[data-role="stage"]');
    canvas = root.querySelector('[data-role="canvas"]');
    ctx = canvas.getContext("2d");
    stageUi = root.querySelector('[data-role="stage-ui"]');
    hostBar = root.querySelector('[data-role="hostbar"]');
    menuBtn = root.querySelector('[data-role="menu-btn"]');
    menuEl = root.querySelector('[data-role="menu"]');
    dpadWrap = root.querySelector('[data-role="dpad"]');
    calibEl = root.querySelector('[data-role="calib"]');

    returnBar = document.createElement("button");
    returnBar.type = "button";
    returnBar.id = "ms-return-bar";
    returnBar.className = "ms-return-bar";
    returnBar.hidden = true;
    returnBar.textContent = "📱 MultiScreen läuft – zurück";
    returnBar.addEventListener("click", () => { S.minimized = false; render(); });
    document.body.appendChild(returnBar);

    root.querySelector('[data-role="close"]').addEventListener("click", async () => {
      if (S.code && !(await ask("MultiScreen verlassen?", "Dein Handy verlässt die gemeinsame Spielfläche.", "Verlassen"))) return;
      leave();
    });
    root.querySelector('[data-role="minimize"]').addEventListener("click", () => { S.minimized = true; render(); });
    menuBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(); });
    bindStageInput();

    window.addEventListener("resize", scheduleInfo);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", scheduleInfo);
    window.addEventListener("orientationchange", () => setTimeout(() => reportDeviceInfo(true), 300));
    document.addEventListener("visibilitychange", () => {
      if (!S.code) return;
      send({ type: "ms_visibility", hidden: document.hidden });
      if (!document.hidden) { wantWakeLock(stageActive()); reportDeviceInfo(true); }
    });
  }

  function show(on) {
    S.open = on;
    root.hidden = !on || S.minimized;
    returnBar.hidden = !(on && S.minimized);
    document.body.classList.toggle("ms-open", on && !S.minimized);
  }

  // ---------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------
  function openEntry(gameKey) {
    build();
    S.gameKey = gameKey || "snake";
    if (S.code) { S.minimized = false; render(); return; }
    S.minimized = false;
    show(true);
    renderEntry();
  }

  function createSession() {
    S.deviceId = deviceId();
    send({ type: "ms_create", game: S.gameKey || "snake", deviceId: S.deviceId, device: deviceInfo() });
  }
  function joinSession(code) {
    S.deviceId = deviceId();
    send({ type: "ms_join", code: String(code || "").trim().toUpperCase(), deviceId: S.deviceId, device: deviceInfo() });
  }
  function leave() {
    if (S.code) send({ type: "ms_leave" });
    endLocal();
  }
  function endLocal() {
    S.code = null; S.state = null; S.gameState = null; sstore(CODE_KEY, null);
    if (S.game) { S.game.destroy(); S.game = null; S.gameFor = null; }
    stopPing(); wantWakeLock(false); stopLoop();
    S.minimized = false;
    if (root) { show(false); stage.hidden = true; }
    S.onLobbyChange();
  }

  function onSocketOpen() {
    const code = sload(CODE_KEY);
    S.lastInfoSent = null;
    if (code) {
      S.deviceId = deviceId();
      send({ type: "ms_join", code, deviceId: S.deviceId, device: deviceInfo() });
    }
    send({ type: "ms_lobby_request" });
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case "ms_state": onState(msg.state); break;
      case "ms_game_state": onGameState(msg.state); break;
      case "ms_pong": onPong(msg); break;
      case "ms_lobby": S.lobby = msg.sessions || []; S.catalog = msg.catalog || []; S.onLobbyChange(); if (S.open && !S.code) renderEntry(); break;
      case "ms_error": S.toast(msg.message); break;
      case "ms_closed":
        if (msg.code && S.code && msg.code !== S.code) break;
        if (S.code && msg.reason === "host_closed") S.toast("Der Host hat MultiScreen beendet.");
        if (S.code && msg.reason === "unknown") S.toast("Diese MultiScreen-Runde gibt es nicht mehr.");
        endLocal();
        break;
      default: break;
    }
  }

  function onState(state) {
    build();
    const first = !S.state;
    S.state = state;
    if (S.offset == null && state.serverTime) S.offset = state.serverTime - Date.now() / 1000;
    if (S.code !== state.code) {
      S.code = state.code;
      sstore(CODE_KEY, state.code);
      startPing();
      reportDeviceInfo(true);
    }
    if (!S.drag) S.drafts = JSON.parse(JSON.stringify(state.placements || {}));
    if (state.notice) S.toast(state.notice);
    if (first && !S.open) { S.minimized = false; }
    if (state.phase !== "game" && S.game) { S.game.destroy(); S.game = null; S.gameFor = null; S.gameState = null; }
    show(true);
    render();
  }

  function onGameState(gs) {
    S.gameState = gs;
    S.gameRecv = performance.now() / 1000;
    ensureGame();
    if (S.game) S.game.onState(gs, S.gameRecv);
    renderPause();
  }

  function stageActive() { return !!S.state && ["test", "ready", "game"].includes(S.state.phase); }

  // ---------------------------------------------------------------------
  // Rendering: which view?
  // ---------------------------------------------------------------------
  function render() {
    if (!root) return;
    if (!S.code || !S.state) { show(S.open); return; }
    show(true);
    const phase = S.state.phase;
    const onStage = stageActive();
    head.textContent = `${S.state.game.emoji} ${S.state.game.name}`;
    root.classList.toggle("ms-overlay--stage", onStage);
    root.querySelector('[data-role="minimize"]').hidden = phase === "game" && S.gameState && !S.gameState.stats;
    shell.hidden = onStage;
    stage.hidden = !onStage;
    wantWakeLock(onStage && !S.minimized);
    if (onStage) {
      startLoop();
      renderStageChrome();
    } else {
      stopLoop();
      if (isHost()) renderHostSetup(); else renderGuestSetup();
    }
  }

  // ---------------------------------------------------------------------
  // Entry: start / join
  // ---------------------------------------------------------------------
  function renderEntry() {
    root.classList.remove("ms-overlay--stage");
    shell.hidden = false; stage.hidden = true;
    head.textContent = "📱 MultiScreen";
    const cat = S.catalog.find((c) => c.key === (S.gameKey || "snake")) || { emoji: "🐍", name: "MultiScreen Snake", subtitle: "Eine Schlange. Viele Displays.", minDevices: 2, maxDevices: 12 };
    const open = S.lobby.filter((l) => l.joinable);
    main.innerHTML = `
      <section class="ms-entry">
        <div class="ms-hero">
          <div class="ms-hero-emoji">${esc(cat.emoji)}</div>
          <div class="ms-hero-title">${esc(cat.name)}</div>
          <div class="ms-hero-sub">${esc(cat.subtitle)}</div>
          <div class="ms-hero-meta">${cat.minDevices}–${cat.maxDevices} Geräte · Handys nebeneinander auf den Tisch</div>
          <div class="ms-hero-phones" aria-hidden="true"><span></span><span></span><span></span></div>
        </div>
        <button type="button" class="primary-btn ms-big-btn" data-role="create">📱 MULTISCREEN STARTEN</button>
        <div class="ms-join-box">
          <label class="ms-join-label" for="ms-code-input">Mit Code beitreten</label>
          <div class="ms-join-row">
            <input id="ms-code-input" class="ms-code-input" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="CODE" />
            <button type="button" class="ghost-btn" data-role="join">Beitreten</button>
          </div>
        </div>
        ${open.length ? `<div class="ms-open-list"><div class="home-section-title">OFFENE RUNDEN</div>${open.map((l) => `
          <button type="button" class="ms-open-item" data-code="${esc(l.code)}">
            <span>${esc(l.emoji)} ${esc(l.hostName)} · ${esc(l.game)}</span><span class="ms-open-count">${l.devices} ${l.devices === 1 ? "Gerät" : "Geräte"} ▸</span>
          </button>`).join("")}</div>` : ""}
      </section>`;
    main.querySelector('[data-role="create"]').addEventListener("click", createSession);
    const input = main.querySelector("#ms-code-input");
    input.addEventListener("input", () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
    const doJoin = () => { if (input.value.length >= 4) joinSession(input.value); };
    main.querySelector('[data-role="join"]').addEventListener("click", doJoin);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin(); });
    for (const b of main.querySelectorAll(".ms-open-item")) b.addEventListener("click", () => joinSession(b.dataset.code));
  }

  // ---------------------------------------------------------------------
  // Setup: guests
  // ---------------------------------------------------------------------
  function identityHtml(d, big) {
    return `<div class="ms-identity ${big ? "ms-identity--big" : ""}" style="--dev:${esc(d.color)}">
      <div class="ms-identity-num">${d.number}</div>
      <div class="ms-identity-name">${esc(d.name)}</div>
      <div class="ms-identity-sub">Handy ${d.number}${d.calibrated ? " · 📏 kalibriert" : ""}</div>
    </div>`;
  }

  function renderGuestSetup() {
    const d = me();
    if (!d) return;
    const host = deviceById(S.state.hostDeviceId);
    main.innerHTML = `
      <section class="ms-guest">
        ${identityHtml(d, true)}
        <p class="ms-guest-text">Leg dein Handy auf den Tisch.<br><strong>${esc(host ? host.name : "Der Host")}</strong> ordnet gerade alle Handys an.</p>
        <div class="ms-code-small">Runde <b>${esc(S.state.code)}</b> · ${S.state.devices.filter((x) => x.connected).length} Geräte verbunden</div>
        <div class="ms-guest-actions">
          <button type="button" class="ghost-btn" data-role="calib">📏 Genau kalibrieren</button>
          ${d.calibrated ? `<button type="button" class="ghost-btn" data-role="calib-reset">Kalibrierung zurücksetzen</button>` : ""}
          ${canFullscreen() ? `<button type="button" class="ghost-btn" data-role="fs">Vollbild</button>` : ""}
        </div>
      </section>`;
    bindCommonSetupButtons();
  }

  function bindCommonSetupButtons() {
    const c = main.querySelector('[data-role="calib"]');
    if (c) c.addEventListener("click", openCalibration);
    const r = main.querySelector('[data-role="calib-reset"]');
    if (r) r.addEventListener("click", () => { store(CALIB_KEY, null); reportDeviceInfo(true); S.toast("Kalibrierung zurückgesetzt."); });
    const f = main.querySelector('[data-role="fs"]');
    if (f) f.addEventListener("click", toggleFullscreen);
  }

  // ---------------------------------------------------------------------
  // Setup: host layout editor
  // ---------------------------------------------------------------------
  function tileRect(devId, pl) {
    const d = deviceById(devId);
    if (!d || !pl) return null;
    const rot = pl.rotation;
    const w = rot === 90 || rot === 270 ? d.localH : d.localW;
    const h = rot === 90 || rot === 270 ? d.localW : d.localH;
    return { deviceId: devId, x: pl.x, y: pl.y, w, h, rotation: rot };
  }
  function draftRects() {
    return Object.entries(S.drafts).map(([id, pl]) => tileRect(id, pl)).filter(Boolean);
  }
  function commitLayout() {
    send({ type: "ms_layout_update", tiles: Object.entries(S.drafts).map(([deviceId, p]) => ({ deviceId, x: p.x, y: p.y, rotation: p.rotation })) });
  }
  function snapRect(r, others) {
    let bestX = null, bestY = null;
    for (const o of others) {
      const xs = [o.x + o.w, o.x - r.w, o.x, o.x + o.w - r.w, o.x + o.w / 2 - r.w / 2];
      const ys = [o.y + o.h, o.y - r.h, o.y, o.y + o.h - r.h, o.y + o.h / 2 - r.h / 2];
      for (const x of xs) if (Math.abs(x - r.x) < SNAP && (bestX == null || Math.abs(x - r.x) < Math.abs(bestX - r.x))) bestX = x;
      for (const y of ys) if (Math.abs(y - r.y) < SNAP && (bestY == null || Math.abs(y - r.y) < Math.abs(bestY - r.y))) bestY = y;
    }
    return { x: Math.round((bestX == null ? r.x : bestX) * 100) / 100, y: Math.round((bestY == null ? r.y : bestY) * 100) / 100 };
  }

  function templatesFor(n) {
    const t = [];
    if (n >= 2) t.push(["row", "Reihe"], ["column", "Spalte"]);
    if (n === 4) t.unshift(["grid2", "2×2"]);
    if (n === 6) t.unshift(["grid3", "3×2"], ["grid2", "2×3"]);
    if (n >= 7) t.push(["grid2rows", "2 Reihen"], ["grid3", "3 pro Reihe"]);
    if (n >= 3) t.push(["L", "L-Form"]);
    if (n >= 4) t.push(["T", "T-Form"]);
    if (n === 5) t.unshift(["cross", "Kreuz"]);
    if (n >= 3) t.push(["stairs", "Treppe"]);
    return t;
  }
  function applyTemplate(kind) {
    const devs = S.state.devices.filter((d) => d.connected && !d.left).sort((a, b) => a.number - b.number);
    const n = devs.length;
    const out = {};
    const size = (d) => ({ w: d.localW, h: d.localH });
    const row = (list, y0, centered) => {
      let x = 0;
      for (const d of list) { const s = size(d); out[d.deviceId] = { x, y: centered ? y0 - s.h / 2 : y0, rotation: 0 }; x += s.w; }
      return x;
    };
    if (kind === "row") row(devs, 0, true);
    else if (kind === "column") { let y = 0; for (const d of devs) { const s = size(d); out[d.deviceId] = { x: -s.w / 2, y, rotation: 0 }; y += s.h; } }
    else if (kind.startsWith("grid")) {
      const cols = kind === "grid3" ? 3 : kind === "grid2rows" ? Math.ceil(n / 2) : 2;
      const bottoms = [];
      devs.forEach((d, i) => {
        const r = Math.floor(i / cols), c = i % cols;
        const s = size(d);
        const left = c === 0 ? 0 : out[devs[i - 1].deviceId].x + size(devs[i - 1]).w;
        const top = r === 0 ? 0 : bottoms[c];
        out[d.deviceId] = { x: left, y: top, rotation: 0 };
        bottoms[c] = top + s.h;
      });
    } else if (kind === "L" || kind === "T") {
      const top = devs.slice(0, n - 1);
      row(top, 0, false);
      const last = devs[n - 1];
      const anchor = kind === "L" ? top[0] : top[Math.floor((top.length - 1) / 2)];
      const a = out[anchor.deviceId];
      out[last.deviceId] = { x: a.x + (size(anchor).w - size(last).w) / 2, y: a.y + size(anchor).h, rotation: 0 };
    } else if (kind === "cross" && n === 5) {
      const [m, nN, w, e, s] = [devs[0], devs[1], devs[2], devs[3], devs[4]];
      const M = size(m);
      out[m.deviceId] = { x: 0, y: 0, rotation: 0 };
      out[nN.deviceId] = { x: (M.w - size(nN).w) / 2, y: -size(nN).h, rotation: 0 };
      out[s.deviceId] = { x: (M.w - size(s).w) / 2, y: M.h, rotation: 0 };
      out[w.deviceId] = { x: -size(w).w, y: (M.h - size(w).h) / 2, rotation: 0 };
      out[e.deviceId] = { x: M.w, y: (M.h - size(e).h) / 2, rotation: 0 };
    } else if (kind === "stairs") {
      let x = 0, y = 0;
      for (const d of devs) { const s = size(d); out[d.deviceId] = { x, y, rotation: 0 }; x += s.w; y += s.h / 2; }
    }
    S.drafts = out;
    S.selected = null;
    commitLayout();
    renderHostSetup();
  }

  function renderHostSetup() {
    const st = S.state;
    const devs = st.devices;
    const connected = devs.filter((d) => d.connected);
    const placedIds = Object.keys(S.drafts);
    const tray = devs.filter((d) => !placedIds.includes(d.deviceId) && !d.left);
    const problems = st.layout.problems || [];
    const errors = problems.filter((p) => p.severity === "error");
    const bad = new Set(errors.flatMap((p) => p.devices));
    const d = me();
    main.innerHTML = `
      <section class="ms-setup">
        <div class="ms-code-card">
          <div class="ms-code-label">Andere Handys treten bei mit</div>
          <div class="ms-code" data-role="code">${esc(st.code)}</div>
          <div class="ms-code-hint">Chat &amp; Games öffnen → 🎮 → MultiScreen → Code eingeben</div>
        </div>
        <div class="ms-dev-chips">${devs.map((x) => `
          <span class="ms-dev-chip ${x.connected ? "" : "ms-dev-chip--off"}" style="--dev:${esc(x.color)}">
            <b>${x.number}</b> ${esc(x.name)}${x.deviceId === S.deviceId ? " (du)" : ""}${x.calibrated ? " 📏" : ""}${x.connected ? "" : " · getrennt"}
          </span>`).join("")}</div>
        <p class="ms-setup-hint">Zieh die Handys so an, wie sie gerade auf eurem Tisch liegen. Antippen zum Drehen oder Verschieben.</p>
        <div class="ms-templates">${templatesFor(connected.length).map(([k, l]) => `<button type="button" class="ms-chip-btn" data-template="${k}">${l}</button>`).join("")}</div>
        <div class="ms-editor" data-role="editor"></div>
        <div class="ms-tile-tools" data-role="tools" ${S.selected && S.drafts[S.selected] ? "" : "hidden"}>
          <span class="ms-tools-name">${S.selected ? esc(nameOf(S.selected)) : ""}</span>
          <button type="button" class="ms-tool" data-nudge="left" aria-label="Nach links">←</button>
          <button type="button" class="ms-tool" data-nudge="up" aria-label="Nach oben">↑</button>
          <button type="button" class="ms-tool" data-nudge="down" aria-label="Nach unten">↓</button>
          <button type="button" class="ms-tool" data-nudge="right" aria-label="Nach rechts">→</button>
          <button type="button" class="ms-tool ms-tool--rot" data-role="rotate" aria-label="Drehen">⟳</button>
          <button type="button" class="ms-tool" data-role="unplace" aria-label="Entfernen">✕</button>
        </div>
        ${tray.length ? `<div class="ms-tray"><span class="ms-tray-label">Nicht auf dem Tisch:</span>${tray.map((x) => `
          <button type="button" class="ms-tray-item" data-place="${esc(x.deviceId)}" style="--dev:${esc(x.color)}">＋ ${esc(x.name)} (${x.number})</button>`).join("")}</div>` : ""}
        <ul class="ms-problems">${problems.map((p) => `<li class="ms-problem ms-problem--${p.severity}">${p.severity === "error" ? "⚠️" : "ℹ️"} ${esc(p.message)}</li>`).join("")}</ul>
        <div class="ms-actions">
          <button type="button" class="ghost-btn" data-role="calib">📏 ${d && d.calibrated ? "Neu kalibrieren" : "Genau kalibrieren"}</button>
          ${d && d.calibrated ? `<button type="button" class="ghost-btn" data-role="calib-reset">Kalibrierung zurücksetzen</button>` : ""}
          <button type="button" class="primary-btn ms-big-btn" data-role="test" ${errors.length ? "disabled" : ""}>LAYOUT TESTEN ▸</button>
        </div>
      </section>`;
    for (const b of main.querySelectorAll("[data-template]")) b.addEventListener("click", () => applyTemplate(b.dataset.template));
    for (const b of main.querySelectorAll("[data-place]")) b.addEventListener("click", () => placeFromTray(b.dataset.place));
    for (const b of main.querySelectorAll("[data-nudge]")) b.addEventListener("click", () => nudge(b.dataset.nudge));
    const rot = main.querySelector('[data-role="rotate"]');
    if (rot) rot.addEventListener("click", rotateSelected);
    const un = main.querySelector('[data-role="unplace"]');
    if (un) un.addEventListener("click", () => { delete S.drafts[S.selected]; S.selected = null; commitLayout(); renderHostSetup(); });
    main.querySelector('[data-role="test"]').addEventListener("click", () => send({ type: "ms_test", mode: "color" }));
    bindCommonSetupButtons();
    renderEditor(bad);
  }

  function editorGeometry(box) {
    const rects = draftRects();
    let x1 = 0, y1 = 0, x2 = 70, y2 = 150;
    if (rects.length) {
      x1 = Math.min(...rects.map((r) => r.x)); y1 = Math.min(...rects.map((r) => r.y));
      x2 = Math.max(...rects.map((r) => r.x + r.w)); y2 = Math.max(...rects.map((r) => r.y + r.h));
    }
    const m = 40;
    const bw = box.clientWidth || 320, bh = box.clientHeight || 300;
    const scale = Math.min(bw / (x2 - x1 + 2 * m), bh / (y2 - y1 + 2 * m));
    return { scale, ox: (bw - (x2 - x1) * scale) / 2 - x1 * scale, oy: (bh - (y2 - y1) * scale) / 2 - y1 * scale };
  }

  function renderEditor(bad) {
    const box = main.querySelector('[data-role="editor"]');
    if (!box) return;
    const geo = S.drag ? S.drag.geo : editorGeometry(box);
    box.innerHTML = "";
    for (const r of draftRects()) {
      const d = deviceById(r.deviceId);
      const el = document.createElement("div");
      el.className = "ms-tile" + (S.selected === r.deviceId ? " ms-tile--selected" : "") + (bad && bad.has(r.deviceId) ? " ms-tile--bad" : "") + (d.connected ? "" : " ms-tile--off");
      el.style.cssText = `--dev:${d.color};left:${geo.ox + r.x * geo.scale}px;top:${geo.oy + r.y * geo.scale}px;width:${r.w * geo.scale}px;height:${r.h * geo.scale}px`;
      el.dataset.id = r.deviceId;
      el.innerHTML = `<span class="ms-tile-arrow" style="transform:rotate(${r.rotation}deg)">↑</span>
        <span class="ms-tile-name">${esc(d.name)}</span><span class="ms-tile-num">Handy ${d.number}${d.calibrated ? " 📏" : ""}</span>`;
      box.appendChild(el);
      bindTileDrag(el, box);
    }
    if (!S.drag) {
      for (const p of S.state.layout.passages || []) {
        const line = document.createElement("div");
        line.className = "ms-passage" + (p.ok ? "" : " ms-passage--narrow");
        const x = geo.ox + Math.min(p.x1, p.x2) * geo.scale, y = geo.oy + Math.min(p.y1, p.y2) * geo.scale;
        const vertical = p.x1 === p.x2;
        line.style.cssText = vertical
          ? `left:${x - 2}px;top:${y}px;width:4px;height:${Math.abs(p.y2 - p.y1) * geo.scale}px`
          : `left:${x}px;top:${y - 2}px;height:4px;width:${Math.abs(p.x2 - p.x1) * geo.scale}px`;
        if (!p.ok) line.title = "Zu schmal für Snake.";
        box.appendChild(line);
      }
    }
    box.onpointerdown = (e) => { if (e.target === box) { S.selected = null; renderHostSetup(); } };
  }

  function bindTileDrag(el, box) {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const id = el.dataset.id;
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      S.drag = { id, sx: e.clientX, sy: e.clientY, start: { ...S.drafts[id] }, moved: false, geo: editorGeometry(box) };
      if (S.selected !== id) { S.selected = id; }
      el.classList.add("ms-tile--selected");
    });
    el.addEventListener("pointermove", (e) => {
      const dr = S.drag;
      if (!dr || dr.id !== el.dataset.id) return;
      const dx = (e.clientX - dr.sx) / dr.geo.scale, dy = (e.clientY - dr.sy) / dr.geo.scale;
      if (!dr.moved && Math.hypot(e.clientX - dr.sx, e.clientY - dr.sy) < 4) return;
      dr.moved = true;
      const pl = S.drafts[dr.id];
      const r = tileRect(dr.id, { ...pl, x: dr.start.x + dx, y: dr.start.y + dy });
      const snapped = snapRect(r, draftRects().filter((o) => o.deviceId !== dr.id));
      pl.x = snapped.x; pl.y = snapped.y;
      el.style.left = `${dr.geo.ox + pl.x * dr.geo.scale}px`;
      el.style.top = `${dr.geo.oy + pl.y * dr.geo.scale}px`;
    });
    const end = () => {
      const dr = S.drag;
      if (!dr || dr.id !== el.dataset.id) return;
      S.drag = null;
      if (dr.moved) commitLayout();
      renderHostSetup();
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  function placeFromTray(id) {
    const rects = draftRects();
    const x = rects.length ? Math.max(...rects.map((r) => r.x + r.w)) : 0;
    const y = rects.length ? Math.min(...rects.map((r) => r.y)) : 0;
    S.drafts[id] = { x, y, rotation: 0 };
    S.selected = id;
    commitLayout();
    renderHostSetup();
  }
  function nudge(dir) {
    const pl = S.drafts[S.selected];
    if (!pl) return;
    const [dx, dy] = G.DIRS[dir];
    const r = tileRect(S.selected, { ...pl, x: pl.x + dx * NUDGE, y: pl.y + dy * NUDGE });
    const sn = snapRect(r, draftRects().filter((o) => o.deviceId !== S.selected));
    pl.x = sn.x; pl.y = sn.y;
    commitLayout();
    renderHostSetup();
  }
  function rotateSelected() {
    const pl = S.drafts[S.selected];
    if (!pl) return;
    const before = tileRect(S.selected, pl);
    const cx = before.x + before.w / 2, cy = before.y + before.h / 2;
    pl.rotation = (pl.rotation + 90) % 360;
    const after = tileRect(S.selected, pl);
    const r = { ...after, x: cx - after.w / 2, y: cy - after.h / 2 };
    const sn = snapRect(r, draftRects().filter((o) => o.deviceId !== S.selected));
    pl.x = sn.x; pl.y = sn.y;
    commitLayout();
    renderHostSetup();
  }

  // ---------------------------------------------------------------------
  // Precision calibration with a bank card (optional; quick mode needs
  // nothing). Only the px-per-mm number is stored, locally.
  // ---------------------------------------------------------------------
  function openCalibration() {
    let k = calibration() || (window.matchMedia("(pointer: coarse)").matches ? 6.3 : 3.8);
    calibEl.hidden = false;
    calibEl.innerHTML = `
      <div class="ms-calib">
        <h3>Lege eine normale Bankkarte auf den Rahmen.</h3>
        <p>Größe einstellen, bis die lange Kante genau passt.</p>
        <div class="ms-calib-row">
          <button type="button" class="ms-tool" data-step="-1" aria-label="Kleiner">−</button>
          <input type="range" min="2.5" max="12" step="0.01" data-role="slider" aria-label="Größe" />
          <button type="button" class="ms-tool" data-step="1" aria-label="Größer">+</button>
        </div>
        <div class="ms-calib-stage"><div class="ms-calib-card" data-role="card"><span class="ms-calib-long">85,60 mm</span></div></div>
        <div class="ms-calib-actions">
          <button type="button" class="ghost-btn" data-role="skip">ÜBERSPRINGEN</button>
          <button type="button" class="primary-btn" data-role="ok">PASST</button>
        </div>
      </div>`;
    const card = calibEl.querySelector('[data-role="card"]');
    const slider = calibEl.querySelector('[data-role="slider"]');
    // the frame is drawn at its TRUE size for the chosen px/mm - never
    // squeezed to fit (a real phone is ~6.3 css px/mm = a 540px tall card);
    // the layer scrolls if a small screen needs it
    const apply = () => {
      card.style.width = `${CARD_W * k}px`;
      card.style.height = `${CARD_H * k}px`;
      slider.value = String(k);
    };
    apply();
    slider.addEventListener("input", () => { k = parseFloat(slider.value); apply(); });
    for (const b of calibEl.querySelectorAll("[data-step]")) b.addEventListener("click", () => { k = Math.max(2.5, Math.min(12, k + parseInt(b.dataset.step, 10) * 0.02)); apply(); });
    calibEl.querySelector('[data-role="skip"]').addEventListener("click", () => { calibEl.hidden = true; });
    calibEl.querySelector('[data-role="ok"]').addEventListener("click", () => {
      store(CALIB_KEY, k.toFixed(3));
      calibEl.hidden = true;
      reportDeviceInfo(true);
      S.toast("Kalibriert 📏");
    });
  }

  // ---------------------------------------------------------------------
  // Stage chrome: host bar (test / ready), menu, D-pad
  // ---------------------------------------------------------------------
  function renderStageChrome() {
    const st = S.state;
    const host = isHost();
    hostBar.hidden = true;
    hostBar.innerHTML = "";
    menuBtn.hidden = st.phase !== "game";
    if (st.phase === "test" && host) {
      const m = st.test ? st.test.mode : "color";
      hostBar.hidden = false;
      hostBar.innerHTML = `
        <div class="ms-seg">${[["color", "Farbe"], ["edges", "Kanten"], ["wave", "Welle"], ["seam", "Naht"]].map(([k, l]) =>
          `<button type="button" class="ms-seg-btn ${m === k ? "ms-seg-btn--on" : ""}" data-mode="${k}">${l}</button>`).join("")}</div>
        <div class="ms-hostbar-row">
          <button type="button" class="ghost-btn" data-role="adjust">✎ LAYOUT ANPASSEN</button>
          <button type="button" class="primary-btn" data-role="ok">✓ PASST</button>
        </div>`;
      for (const b of hostBar.querySelectorAll("[data-mode]")) b.addEventListener("click", () => send({ type: "ms_test", mode: b.dataset.mode }));
      hostBar.querySelector('[data-role="adjust"]').addEventListener("click", () => send({ type: "ms_test", mode: "off" }));
      hostBar.querySelector('[data-role="ok"]').addEventListener("click", () => send({ type: "ms_layout_confirm" }));
    } else if (st.phase === "ready") {
      hostBar.hidden = false;
      hostBar.innerHTML = host ? `
        <div class="ms-ready-text">Perfekt – eure gemeinsame Welt ist bereit.</div>
        <div class="ms-hostbar-row">
          <button type="button" class="ghost-btn" data-role="adjust">✎ LAYOUT ÄNDERN</button>
          ${canFullscreen() ? `<button type="button" class="ghost-btn" data-role="fs">VOLLBILD</button>` : ""}
          <button type="button" class="primary-btn" data-role="start">${esc(st.game.emoji)} ${esc(st.game.name.replace("MultiScreen ", "").toUpperCase())} STARTEN</button>
        </div>` : `
        <div class="ms-ready-text">Perfekt – eure gemeinsame Welt ist bereit.<br><small>Warte auf den Host …</small></div>
        ${canFullscreen() ? `<div class="ms-hostbar-row"><button type="button" class="ghost-btn" data-role="fs">IMMERSIVE MODE</button></div>` : ""}`;
      const a = hostBar.querySelector('[data-role="adjust"]');
      if (a) a.addEventListener("click", () => send({ type: "ms_test", mode: "off" }));
      const s = hostBar.querySelector('[data-role="start"]');
      if (s) s.addEventListener("click", () => send({ type: "ms_start" }));
      const f = hostBar.querySelector('[data-role="fs"]');
      if (f) f.addEventListener("click", toggleFullscreen);
    }
    dpadWrap.hidden = !(st.phase === "game" && load(DPAD_KEY) === "1");
    if (!dpadWrap.hidden && !dpadWrap.firstChild && window.TouchDPad) {
      S.dpad = window.TouchDPad.create(dpadWrap, (dir) => onLocalDir(dir));
      dpadWrap.classList.add("ms-dpad-wrap");
    }
    renderTestUi();
    renderPause();
  }

  function toggleMenu(force) {
    const open = force != null ? force : menuEl.hidden;
    menuEl.hidden = !open;
    if (!open) return;
    const host = isHost();
    const gs = S.gameState;
    const paused = gs && gs.paused && gs.paused.reasons.some((r) => r.kind === "host");
    const items = [];
    if (host && gs && !gs.stats) {
      items.push(paused ? ["resume", "▶ Fortsetzen"] : ["pause", "⏸ Pause"]);
      items.push(["restart", "↻ Neu starten"], ["end", "■ Spiel beenden"]);
    }
    items.push(["dpad", load(DPAD_KEY) === "1" ? "D-Pad ausblenden" : "D-Pad anzeigen"]);
    items.push(["sound", soundOn() ? "🔇 Ton aus" : "🔊 Ton an"]);
    if (canFullscreen()) items.push(["fs", "Vollbild"]);
    items.push(["leave", "Verlassen"]);
    menuEl.innerHTML = items.map(([k, l]) => `<button type="button" class="ms-menu-item" data-act="${k}">${l}</button>`).join("");
    for (const b of menuEl.querySelectorAll("[data-act]")) b.addEventListener("click", () => {
      const a = b.dataset.act;
      toggleMenu(false);
      if (["pause", "resume", "restart", "end"].includes(a)) send({ type: "ms_host", action: a });
      else if (a === "dpad") { store(DPAD_KEY, load(DPAD_KEY) === "1" ? "0" : "1"); if (S.dpad) { S.dpad.destroy(); S.dpad = null; } renderStageChrome(); }
      else if (a === "sound") store(SOUND_KEY, soundOn() ? "0" : "1");
      else if (a === "fs") toggleFullscreen();
      else if (a === "leave") { ask("Spiel verlassen?", "Die anderen müssen dann pausieren.", "Verlassen").then((ok) => { if (ok) leave(); }); }
    });
  }

  // ---------------------------------------------------------------------
  // Pause card (disconnect / rotation / background / host) - generic
  // ---------------------------------------------------------------------
  function renderPause() {
    if (!root) return;
    let card = stageUi.querySelector(".ms-pause");
    const p = S.gameState && S.state && S.state.phase === "game" ? S.gameState.paused : null;
    if (!p) { if (card) card.remove(); return; }
    if (!card) { card = document.createElement("div"); card.className = "ms-pause"; stageUi.appendChild(card); }
    const lines = [];
    let prompt = "";
    for (const r of p.reasons) {
      if (r.kind === "lost") lines.push(`📡 <b>${esc(r.name)}</b> hat die Verbindung verloren …${!r.expired && p.graceLeft != null ? ` <span class="ms-pause-sub">(${Math.ceil(p.graceLeft)}s)</span>` : ""}`);
      else if (r.kind === "left") lines.push(`👋 <b>${esc(r.name)}</b> ist nicht mehr dabei.`);
      else if (r.kind === "orientation") lines.push(`🔄 <b>${esc(r.name)}</b> hat das Gerät gedreht.<br><span class="ms-pause-sub">Gerät wieder zurückdrehen – oder Layout neu kalibrieren.</span>`);
      else if (r.kind === "hidden") lines.push(`🙈 <b>${esc(r.name)}</b> steuert gerade, aber die App ist im Hintergrund.`);
      else if (r.kind === "host") lines.push("⏸ Pausiert");
    }
    if (isHost()) {
      if (p.hostPrompt) prompt = `<div class="ms-pause-actions">
          <button type="button" class="ghost-btn" data-act="wait_more">WEITER WARTEN</button>
          <button type="button" class="ghost-btn" data-act="reconfigure">LAYOUT NEU KONFIGURIEREN</button>
          <button type="button" class="ghost-btn" data-act="end">SPIEL BEENDEN</button></div>`;
      else if (p.reasons.some((r) => r.kind === "orientation")) prompt = `<div class="ms-pause-actions"><button type="button" class="ghost-btn" data-act="reconfigure">LAYOUT NEU KALIBRIEREN</button></div>`;
      else if (p.reasons.some((r) => r.kind === "host")) prompt = `<div class="ms-pause-actions"><button type="button" class="primary-btn" data-act="resume">▶ FORTSETZEN</button></div>`;
    }
    const resume = p.resumeIn != null && !p.reasons.length ? `<div class="ms-pause-count">Weiter in ${Math.max(1, Math.ceil(p.resumeIn))} …</div>` : "";
    const html = `${lines.map((l) => `<div class="ms-pause-line">${l}</div>`).join("")}${resume}${prompt}`;
    if (card._html !== html) {
      card._html = html;
      card.innerHTML = html;
      for (const b of card.querySelectorAll("[data-act]")) b.addEventListener("click", () => send({ type: "ms_host", action: b.dataset.act }));
    }
  }

  // ---------------------------------------------------------------------
  // Stage: view transform + world-anchored drawing
  // ---------------------------------------------------------------------
  function computeView() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = stage.clientWidth || window.innerWidth, cssH = stage.clientHeight || window.innerHeight;
    const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    let tile = myTile();
    let overview = false;
    if (!tile) {
      // not on the table: spectator overview of the whole world
      const b = S.state.layout.bounds;
      const w = Math.max(10, b[2] - b[0]), h = Math.max(10, b[3] - b[1]);
      tile = { x: b[0] - 10, y: b[1] - 10, w: w + 20, h: h + 20, rotation: 0, localW: w + 20, localH: h + 20 };
      overview = true;
    }
    // frozen tile size -> letterbox into whatever the canvas is right now
    // (browser bars changing never reshape the world)
    const sCss = Math.min(cssW / tile.localW, cssH / tile.localH);
    const oxCss = (cssW - tile.localW * sCss) / 2, oyCss = (cssH - tile.localH * sCss) / 2;
    const m = G.worldMatrix(tile, sCss * dpr, oxCss * dpr, oyCss * dpr);
    return {
      tile, overview, dpr, cssW, cssH, scale: sCss, m,
      toCss(wx, wy) { const l = G.worldToLocal(tile, wx, wy); return [oxCss + l[0] * sCss, oyCss + l[1] * sCss]; },
      rect: { x: tile.x, y: tile.y, w: tile.w, h: tile.h },
      rotation: tile.rotation,
    };
  }

  function hash2(i, j) {
    let h = (i * 374761393 + j * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177 | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }

  function drawWorldBackground(view, cell) {
    const r = view.rect;
    const tiles = view.overview ? S.state.layout.tiles : [myTile()];
    ctx.save();
    ctx.beginPath();
    for (const t of tiles) if (t) ctx.rect(t.x, t.y, t.w, t.h);
    ctx.clip();
    ctx.fillStyle = "#0f1626";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    // world-anchored grid: lines continue exactly across the phone edges
    ctx.strokeStyle = "rgba(160,190,255,0.07)";
    ctx.lineWidth = 0.35;
    ctx.beginPath();
    for (let x = Math.ceil(r.x / cell) * cell; x <= r.x + r.w; x += cell) { ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); }
    for (let y = Math.ceil(r.y / cell) * cell; y <= r.y + r.h; y += cell) { ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); }
    ctx.stroke();
    // world-anchored "stars": same hash per world cell on every phone
    ctx.fillStyle = "rgba(220,230,255,0.35)";
    const big = cell * 2;
    for (let i = Math.floor(r.x / big); i <= Math.ceil((r.x + r.w) / big); i++) {
      for (let j = Math.floor(r.y / big); j <= Math.ceil((r.y + r.h) / big); j++) {
        const hv = hash2(i, j);
        if (hv > 0.28) continue;
        const px = (i + hash2(j, i + 7)) * big, py = (j + hash2(i + 3, j)) * big;
        ctx.beginPath(); ctx.arc(px, py, 0.25 + hv * 1.2, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
    // walls glow faintly; open passages stay open (no line at all)
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(255,120,120,0.55)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const w of S.state.layout.walls || []) {
      const [x1, y1, x2, y2] = w;
      if (x2 < r.x - 1 || x1 > r.x + r.w + 1 || y2 < r.y - 1 || y1 > r.y + r.h + 1) continue;
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    }
    ctx.stroke();
    if (view.overview) {
      ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 0.8;
      for (const t of S.state.layout.tiles) ctx.strokeRect(t.x, t.y, t.w, t.h);
    }
    ctx.restore();
  }

  // ----- test visuals -----
  function pathLength(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; }
  function pointAt(pts, d) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d <= L) { const k = L ? d / L : 0; return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]; }
      d -= L;
    }
    return pts[pts.length - 1];
  }
  function drawTestWorld(view) {
    const t = S.state.test;
    if (!t) return;
    if (t.mode === "wave" && t.path && t.path.length > 1) {
      const L = pathLength(t.path);
      const speed = 120;
      const period = L / speed + 0.8;
      const el = ((serverNow() - t.startedAt) % period + period) % period;
      const d = Math.min(L, el * speed);
      ctx.save();
      ctx.lineCap = "round";
      for (let k = 0; k < 14; k++) {
        const back = d - k * 4;
        if (back < 0) break;
        const p = pointAt(t.path, back);
        ctx.fillStyle = `rgba(255,236,170,${0.55 * (1 - k / 14)})`;
        ctx.beginPath(); ctx.arc(p[0], p[1], 4.5 - k * 0.2, 0, Math.PI * 2); ctx.fill();
      }
      const p = pointAt(t.path, d);
      ctx.shadowColor = "rgba(255,230,160,0.9)"; ctx.shadowBlur = 18 * view.dpr;
      ctx.fillStyle = "#fff6d8";
      ctx.beginPath(); ctx.arc(p[0], p[1], 5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    } else if (t.mode === "seam") {
      ctx.save();
      ctx.strokeStyle = "rgba(120,220,255,0.35)"; ctx.lineWidth = 1;
      const r = view.rect;
      ctx.beginPath();
      for (let k = Math.floor((r.x + r.y) / 12) * 12; k < r.x + r.w + r.y + r.h; k += 12) { ctx.moveTo(k - r.y, r.y); ctx.lineTo(k - (r.y + r.h), r.y + r.h); }
      ctx.stroke();
      for (const p of S.state.layout.passages || []) {
        if (!p.ok) continue;
        const mx = (p.x1 + p.x2) / 2, my = (p.y1 + p.y2) / 2;
        const vertical = p.x1 === p.x2;
        ctx.strokeStyle = "rgba(255,255,255,0.95)"; ctx.lineWidth = 1.4;
        ctx.beginPath();
        if (vertical) { ctx.moveTo(mx - 40, my); ctx.lineTo(mx + 40, my); } else { ctx.moveTo(mx, my - 40); ctx.lineTo(mx, my + 40); }
        ctx.stroke();
        ctx.strokeStyle = "rgba(255,200,120,0.95)";
        ctx.beginPath(); ctx.arc(mx, my, 16, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }
  }

  function renderTestUi() {
    let layer = stageUi.querySelector(".ms-test-ui");
    const st = S.state;
    if (!st || st.phase !== "test" || !st.test) { if (layer) layer.remove(); return; }
    if (!layer) { layer = document.createElement("div"); layer.className = "ms-test-ui"; stageUi.prepend(layer); }
    const d = me();
    const t = myTile();
    let html = "";
    if (!d) return;
    if (st.test.mode === "color") {
      html = `<div class="ms-test-color" style="--dev:${esc(d.color)}">${identityHtml(d, true)}</div>`;
    } else {
      html = `<div class="ms-test-badge" style="--dev:${esc(d.color)}"><b>${d.number}</b> ${esc(d.name)}</div>`;
      if (st.test.mode === "edges" && t) {
        const adj = st.layout.adjacency[S.deviceId] || {};
        const bySide = { top: [], right: [], bottom: [], left: [] };
        for (const side of ["top", "right", "bottom", "left"]) {
          const local = G.worldSideToLocalSide(t.rotation, side);
          for (const n of adj[side] || []) bySide[local].push(nameOf(n.neighbor));
        }
        const arrow = { top: "↑", right: "→", bottom: "↓", left: "←" };
        html += ["top", "right", "bottom", "left"].map((s) => `<div class="ms-edge ms-edge--${s}">${bySide[s].length ? `${arrow[s]} ${bySide[s].map(esc).join(" · ")}` : `<span class="ms-edge-wall">Wand</span>`}</div>`).join("");
        const upLocal = G.worldDirToLocal(t.rotation, "up");
        const deg = { up: 0, right: 90, down: 180, left: 270 }[upLocal];
        html += `<div class="ms-world-up"><span style="transform:rotate(${deg}deg)">⬆</span><small>zeigt auf allen Handys<br>in dieselbe Richtung</small></div>`;
      } else if (st.test.mode === "wave") {
        html += `<div class="ms-test-hint">Der Lichtpunkt wandert über alle Handys.</div>`;
      } else if (st.test.mode === "seam") {
        html += `<div class="ms-test-hint">Laufen die Linien sauber über die Kanten weiter?</div>`;
      }
      if (!t) html += `<div class="ms-test-hint">Dieses Handy liegt nicht auf dem Tisch.</div>`;
    }
    if (layer._html !== html) { layer._html = html; layer.innerHTML = html; }
  }

  function drawDebug(view) {
    ctx.save();
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    const t = myTile();
    const gs = S.gameState;
    const lines = [
      `device ${S.deviceId} ${t ? `rot ${t.rotation}` : "(not placed)"}`,
      t ? `world ${t.x.toFixed(1)},${t.y.toFixed(1)} ${t.w.toFixed(1)}×${t.h.toFixed(1)}` : "",
      `fps ${S.fps}  rtt ${S.rtt != null ? (S.rtt * 1000).toFixed(0) : "?"}ms  tick ${gs ? gs.tick : "-"}`,
      gs && gs.snake && gs.snake.path[0] ? `head ${gs.snake.path[0].map((v) => v.toFixed(1)).join(",")} active ${nameOf(gs.activeDeviceId)}` : "",
      `passages ${(S.state.layout.passages || []).map((p) => `${nameOf(p.a)}↔${nameOf(p.b)} ${p.length}`).join(" | ")}`,
    ].filter(Boolean);
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(4, 40, 330, lines.length * 14 + 8);
    ctx.fillStyle = "#9f9";
    lines.forEach((l, i) => ctx.fillText(l, 10, 54 + i * 14));
    ctx.restore();
  }

  function frame() {
    S.raf = requestAnimationFrame(frame);
    if (!S.state || stage.hidden) return;
    const now = performance.now() / 1000;
    S.frames++;
    if (now - S.fpsT > 1) { S.fps = S.frames; S.frames = 0; S.fpsT = now; }
    const view = computeView();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#070a12";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(...view.m);
    const cell = S.gameState && S.gameState.cell ? S.gameState.cell : 9;
    drawWorldBackground(view, cell);
    if (S.state.phase === "test") drawTestWorld(view);
    if (S.state.phase === "game" && S.game) {
      ctx.save();
      ctx.beginPath();
      for (const t of view.overview ? S.state.layout.tiles : [view.tile]) ctx.rect(t.x, t.y, t.w, t.h);
      ctx.clip();
      S.game.draw(ctx, view, now);
      ctx.restore();
      S.game.ui(stageUi, view, now);
    }
    if (S.debug) drawDebug(view);
  }
  function startLoop() { if (!S.raf) S.raf = requestAnimationFrame(frame); }
  function stopLoop() { if (S.raf) cancelAnimationFrame(S.raf); S.raf = null; }

  // ---------------------------------------------------------------------
  // Games
  // ---------------------------------------------------------------------
  function ensureGame() {
    const key = S.gameState && S.gameState.game;
    if (!key || !S.state || S.state.phase !== "game") return;
    if (S.game && S.gameFor === key) return;
    const factory = window.MultiScreenGames && window.MultiScreenGames[key];
    if (!factory) return;
    if (S.game) S.game.destroy();
    S.gameFor = key;
    S.game = factory.create({
      myDeviceId: () => S.deviceId,
      isHost, nameOf, deviceById, myTile, serverNow,
      state: () => S.state,
      sendInput: (input) => send({ type: "ms_game_input", input }),
      hostAction: (action) => send({ type: "ms_host", action }),
      closeSession: () => send({ type: "ms_close" }),
      leave,
      minimize: () => { S.minimized = true; render(); },
      sound, vibrate,
    });
    renderStageChrome();
  }

  // ---------------------------------------------------------------------
  // Input: swipe anywhere, keys, optional D-pad -> LOCAL direction. The
  // server turns it into a world direction with this screen's rotation.
  // ---------------------------------------------------------------------
  function onLocalDir(dir) {
    if (S.game && S.state && S.state.phase === "game") S.game.onInputDir(dir);
  }
  function bindStageInput() {
    let sx = 0, sy = 0, active = false, fired = false;
    stage.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, .ms-menu, .ms-pause, .ms-results, .ms-hostbar")) return;
      active = true; fired = false; sx = e.clientX; sy = e.clientY;
      if (!menuEl.hidden) toggleMenu(false);
    });
    stage.addEventListener("pointermove", (e) => {
      if (!active || fired) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.hypot(dx, dy) < 24) return;
      fired = true;   // fire on the move, not on release: feels instant
      onLocalDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up"));
    });
    const end = () => { active = false; };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
    window.addEventListener("keydown", (e) => {
      if (!S.open || S.minimized || !stageActive() || S.state.phase !== "game") return;
      const t = document.activeElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      const k = e.key.toLowerCase();
      const map = { arrowup: "up", w: "up", arrowdown: "down", s: "down", arrowleft: "left", a: "left", arrowright: "right", d: "right" };
      if (map[k]) { e.preventDefault(); onLocalDir(map[k]); }
    });
  }

  window.MultiScreen = {
    init(opts) {
      S.send = opts.send; S.getMe = opts.getMe; S.toast = opts.toast || S.toast; S.onLobbyChange = opts.onLobbyChange || S.onLobbyChange;
      S.deviceId = deviceId();
    },
    handleMessage, onSocketOpen, openEntry,
    lobby: () => S.lobby.slice(),
    isOpen: () => !!S.code,
    joinCode: (code) => { build(); S.open = true; joinSession(code); },
    _debug: () => S,
  };
})();
