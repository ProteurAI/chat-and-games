// ============================================================================
// KopfKicker - 2-player realtime arcade head-football. Server-authoritative
// physics (backend/kopf_kicker.py, 60 Hz fixed step, ~30 snapshots/s): this
// module only captures input and renders whatever `game_state` broadcasts
// arrive - no client-trusted position, score or goal anywhere.
//
// Handled client-side, deliberately:
//  1. The selfie capture flow (camera/file -> square crop -> downscale ->
//     compress) - purely local image processing before the small resulting
//     data URL is sent once over its own websocket channel (kopf_selfie_set/
//     kopf_selfie_photo), never through the generic per-tick state broadcast
//     and never through the chat image upload endpoint - see
//     backend/kopf_kicker.py's module docstring for why.
//  2. Smoothing: ball + opponent are interpolated between snapshots on the
//     SERVER's clock (serverTime), rendered a fixed delay behind it; the
//     local player is extrapolated from the newest snapshot for immediacy.
//  3. Purely visual animation (run/jump/fall/land/kick poses, head bob and
//     squash, ball spin/shadow/trail, impact effects, goal flash/shake).
//     None of it moves a collider - the server's head/body circles are
//     exactly where the snapshot says. Effects are triggered by the
//     server's `events` list (kick/head/post/floor/goal).
//
// Debug overlay (colliders, kick hitbox, goal zones, vectors, rates): add
// ?kkdebug to the URL or set localStorage kk_debug=1.
//
// window.KopfKicker.mount(stageEl, opts) -> { setState(state), showGameOver(data), destroy() }
// opts: { me, players, sendInput(payload), sendRaw(msg), sendRematch(), closeGame() }
// ============================================================================

(function () {
  "use strict";

  const RENDER_DELAY = 0.1;     // s behind server time: ~3 snapshots of interpolation buffer
  const SELFIE_TARGET = 320;    // square px
  const SELFIE_QUALITY = 0.82;

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str == null ? "" : String(str);
    return d.innerHTML;
  }

  function isTypingTarget() {
    const el = document.activeElement;
    return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  // ---------------------------------------------------------------------
  // Image cache: decode each selfie data URL into an HTMLImageElement
  // exactly once and reuse it every frame (per the brief's explicit
  // "keine new Image() pro Frame" performance requirement).
  // ---------------------------------------------------------------------
  function createImageCache() {
    const cache = new Map(); // userId -> HTMLImageElement
    return {
      set(userId, dataUrl) {
        const img = new Image();
        img.src = dataUrl;
        cache.set(userId, img);
      },
      get(userId) { return cache.get(userId) || null; },
      has(userId) { return cache.has(userId); },
    };
  }

  // ---------------------------------------------------------------------
  // Selfie capture: camera (preferred) with a file-input fallback, square
  // crop + downscale + compress entirely client-side before anything is
  // sent. No face detection/recognition anywhere - purely a visual crop.
  // ---------------------------------------------------------------------
  function mountSelfieCapture(container, opts) {
    const { onConfirmed } = opts;
    let stream = null;
    let capturedDataUrl = null;

    container.innerHTML = `
      <div class="kk-selfie-flow">
        <div class="kk-selfie-head">
          <div class="kk-selfie-title">⚽ KOPFKICKER</div>
          <div class="kk-selfie-sub">Mach dich bereit.</div>
          <p class="kk-selfie-hint">Dein Gesicht wird gleich zum wichtigsten Körperteil auf dem Platz.</p>
        </div>
        <div class="kk-selfie-stage" data-role="stage">
          <button type="button" class="primary-btn kk-selfie-camera-btn" data-role="open-camera">📸 Kamera öffnen</button>
        </div>
        <input type="file" accept="image/*" data-role="file-input" hidden />
        <button type="button" class="ghost-btn kk-selfie-upload-btn" data-role="open-file">🖼️ Foto auswählen</button>
      </div>
    `;

    const stage = container.querySelector('[data-role="stage"]');
    const fileInput = container.querySelector('[data-role="file-input"]');

    function stopStream() {
      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    }

    function showError(message) {
      stopStream();
      stage.innerHTML = `
        <div class="kk-selfie-error">
          <div class="kk-selfie-error-icon">📷</div>
          <p>${escapeHtml(message)}</p>
          <div class="kk-selfie-error-actions">
            <button type="button" class="primary-btn" data-role="retry">Erneut versuchen</button>
            <button type="button" class="ghost-btn" data-role="upload-fallback">Foto auswählen</button>
          </div>
        </div>
      `;
      stage.querySelector('[data-role="retry"]').addEventListener("click", openCamera);
      stage.querySelector('[data-role="upload-fallback"]').addEventListener("click", () => fileInput.click());
    }

    async function openCamera() {
      stage.innerHTML = `<p class="kk-selfie-hint">Kamera wird geöffnet …</p>`;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      } catch (err) {
        showError("Kamera konnte nicht geöffnet werden.");
        return;
      }
      stage.innerHTML = `
        <div class="kk-selfie-camera-wrap">
          <video class="kk-selfie-video" data-role="video" autoplay playsinline muted></video>
          <div class="kk-selfie-face-guide" aria-hidden="true"></div>
        </div>
        <p class="kk-selfie-hint">Schau möglichst gerade in die Kamera.</p>
        <button type="button" class="primary-btn kk-selfie-shoot-btn" data-role="shoot">📸 Foto machen</button>
      `;
      const video = stage.querySelector('[data-role="video"]');
      video.srcObject = stream;
      stage.querySelector('[data-role="shoot"]').addEventListener("click", () => captureFromVideo(video));
    }

    function squareCanvasFrom(source, sw, sh, mirror) {
      const side = Math.min(sw, sh);
      const sx = (sw - side) / 2, sy = (sh - side) / 2;
      const canvas = document.createElement("canvas");
      canvas.width = SELFIE_TARGET;
      canvas.height = SELFIE_TARGET;
      const ctx = canvas.getContext("2d");
      if (mirror) {
        ctx.translate(SELFIE_TARGET, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(source, sx, sy, side, side, 0, 0, SELFIE_TARGET, SELFIE_TARGET);
      return canvas;
    }

    function captureFromVideo(video) {
      // The live preview is mirrored via CSS (feels natural to the user) -
      // capture mirrored too, so the saved photo matches exactly what they
      // saw, with no surprise flip after the fact (see brief).
      const canvas = squareCanvasFrom(video, video.videoWidth, video.videoHeight, true);
      finishCapture(canvas);
      stopStream();
    }

    function finishCapture(canvas) {
      const mime = "image/webp";
      let dataUrl;
      try {
        dataUrl = canvas.toDataURL(mime, SELFIE_QUALITY);
        if (!dataUrl.startsWith("data:image/webp")) throw new Error("webp unsupported");
      } catch (e) {
        dataUrl = canvas.toDataURL("image/jpeg", SELFIE_QUALITY);
      }
      capturedDataUrl = dataUrl;
      showPreview();
    }

    function showPreview() {
      stage.innerHTML = `
        <div class="kk-selfie-preview-wrap">
          <img class="kk-selfie-preview-img" src="${capturedDataUrl}" alt="Dein Foto" />
        </div>
        <div class="kk-selfie-preview-actions">
          <button type="button" class="ghost-btn" data-role="retake">↻ Nochmal</button>
          <button type="button" class="primary-btn" data-role="use">✓ Dieses Foto verwenden</button>
        </div>
      `;
      stage.querySelector('[data-role="retake"]').addEventListener("click", () => {
        capturedDataUrl = null;
        openCamera();
      });
      stage.querySelector('[data-role="use"]').addEventListener("click", () => {
        onConfirmed(capturedDataUrl, "image/webp");
      });
    }

    container.querySelector('[data-role="open-camera"]').addEventListener("click", openCamera);
    container.querySelector('[data-role="open-file"]').addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const img = new Image();
      img.onload = () => {
        const canvas = squareCanvasFrom(img, img.naturalWidth, img.naturalHeight, false);
        finishCapture(canvas);
      };
      img.onerror = () => showError("Foto konnte nicht verarbeitet werden.");
      img.src = URL.createObjectURL(file);
    });

    return { destroy: stopStream };
  }

  // ---------------------------------------------------------------------
  // Main module
  // ---------------------------------------------------------------------
  function mount(stageEl, opts) {
    const { me, sendInput, sendRaw, sendRematch, closeGame } = opts;
    const myUid = me.id;
    const reducedMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    let debug = false;
    try { debug = /[?&]kkdebug\b/.test(location.search) || localStorage.getItem("kk_debug") === "1"; } catch (e) { /* ignore */ }

    stageEl.innerHTML = `
      <div class="kk-root">
        <div class="kk-lobby" data-role="lobby" hidden></div>
        <div class="kk-match" data-role="match" hidden>
          <div class="kk-scoreboard" data-role="scoreboard"></div>
          <div class="kk-canvas-outer" data-role="canvas-outer">
            <div class="kk-canvas-wrap" data-role="canvas-wrap">
              <canvas class="kk-canvas" data-role="canvas"></canvas>
              <div class="kk-overlay" data-role="overlay" hidden></div>
            </div>
          </div>
          <div class="kk-controls" data-role="controls">
            <div class="kk-controls-move">
              <button type="button" class="kk-ctrl-btn" data-role="left" aria-label="Links">◀</button>
              <button type="button" class="kk-ctrl-btn" data-role="right" aria-label="Rechts">▶</button>
            </div>
            <div class="kk-controls-action">
              <button type="button" class="kk-ctrl-btn kk-ctrl-btn--kick" data-role="kick" aria-label="Schießen">👟</button>
              <button type="button" class="kk-ctrl-btn kk-ctrl-btn--jump" data-role="jump" aria-label="Springen">⬆</button>
            </div>
          </div>
          <p class="kk-hint">A/D oder ◀/▶ laufen · Leertaste/W springen (halten = höher) · E schießen</p>
        </div>
        <div class="kk-endscreen" data-role="endscreen" hidden></div>
      </div>
    `;

    const lobbyEl = stageEl.querySelector('[data-role="lobby"]');
    const matchEl = stageEl.querySelector('[data-role="match"]');
    const endscreenEl = stageEl.querySelector('[data-role="endscreen"]');
    const scoreboardEl = stageEl.querySelector('[data-role="scoreboard"]');
    const canvasOuter = stageEl.querySelector('[data-role="canvas-outer"]');
    const canvasWrap = stageEl.querySelector('[data-role="canvas-wrap"]');
    const canvas = stageEl.querySelector('[data-role="canvas"]');
    const overlayEl = stageEl.querySelector('[data-role="overlay"]');
    const ctx = canvas.getContext("2d");

    let lastState = null;
    let renderKey = null;
    let destroyed = false;
    let selfieCapture = null;
    const images = createImageCache();
    const myOwnDataUrl = { current: null };
    // Every listener outside stageEl goes through here so destroy() can
    // remove all of them - a rematch remounts this module.
    const cleanups = [];
    function listen(target, type, fn, options) {
      target.addEventListener(type, fn, options);
      cleanups.push(() => target.removeEventListener(type, fn, options));
    }

    // ---------------- world / canvas sizing ----------------
    let worldW = 1600, worldH = 900;
    function fitCanvas() {
      const availW = canvasOuter.clientWidth, availH = canvasOuter.clientHeight;
      if (!availW || !availH) return;
      const aspect = worldW / worldH;
      let cssW = availW, cssH = availW / aspect;
      if (cssH > availH) { cssH = availH; cssW = availH * aspect; }
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.style.width = `${Math.floor(cssW)}px`;
      canvas.style.height = `${Math.floor(cssH)}px`;
      canvasWrap.style.width = `${Math.floor(cssW)}px`;
      canvasWrap.style.height = `${Math.floor(cssH)}px`;
      const pixelW = Math.floor(cssW * dpr), pixelH = Math.floor(cssH * dpr);
      if (canvas.width !== pixelW || canvas.height !== pixelH) {
        canvas.width = pixelW;
        canvas.height = pixelH;
      }
    }
    const resizeObserver = new ResizeObserver(() => fitCanvas());
    resizeObserver.observe(canvasOuter);

    // ---------------- snapshot interpolation (server-time based) ----------------
    // Each snapshot carries the server's clock (serverTime). The client
    // keeps an estimate of (local clock - server clock) from the LEAST
    // delayed recent arrival, and renders the ball + opponent RENDER_DELAY
    // behind that estimated server time, so network jitter doesn't turn
    // into visible stutter. The local player is extrapolated from the
    // newest snapshot instead (see localPlayerPose) - own input must feel
    // immediate.
    const snapshots = []; // [{st, recv, state}]
    const offsetSamples = [];
    let clockOffset = null;
    let snapshotRate = 0, lastRecv = 0;
    function nowSec() { return performance.now() / 1000; }
    function pushSnapshot(state) {
      const recv = nowSec();
      const st = typeof state.serverTime === "number" ? state.serverTime : recv;
      offsetSamples.push(recv - st);
      if (offsetSamples.length > 40) offsetSamples.shift();
      clockOffset = Math.min(...offsetSamples);
      if (lastRecv) snapshotRate = snapshotRate * 0.9 + (1 / Math.max(0.001, recv - lastRecv)) * 0.1;
      lastRecv = recv;
      if (snapshots.length && st <= snapshots[snapshots.length - 1].st) return;
      snapshots.push({ st, recv, state });
      while (snapshots.length > 12) snapshots.shift();
    }
    function extrapolateBall(b, dt) {
      const cfg = physics();
      const g = cfg.ballGravity || 2100;
      const ground = lastState.world.groundY - cfg.ballRadius;
      if (b.asleep) return { x: b.x, y: b.y, vx: 0, vy: 0 };
      const y = Math.min(ground, b.y + b.vy * dt + 0.5 * g * dt * dt);
      return { x: b.x + b.vx * dt, y, vx: b.vx, vy: b.vy };
    }
    function interpolated() {
      if (!snapshots.length || clockOffset == null) return null;
      const renderT = nowSec() - clockOffset - RENDER_DELAY;
      let i = snapshots.length - 1;
      while (i > 0 && snapshots[i - 1].st > renderT) i--;
      const newer = snapshots[i];
      const older = i > 0 ? snapshots[i - 1] : null;
      if (!older || renderT >= newer.st) {
        // behind on packets: short, capped extrapolation of the newest
        const dt = Math.min(Math.max(0, renderT - newer.st), 0.1);
        return { ball: newer.state.ball ? extrapolateBall(newer.state.ball, dt) : null, players: newer.state.playerState || {} };
      }
      const t = Math.min(1, Math.max(0, (renderT - older.st) / Math.max(1e-6, newer.st - older.st)));
      const ob = older.state.ball, nb = newer.state.ball;
      const ball = ob && nb ? { x: lerp(ob.x, nb.x, t), y: lerp(ob.y, nb.y, t), vx: lerp(ob.vx, nb.vx, t), vy: lerp(ob.vy, nb.vy, t) } : (nb || ob);
      const players = {};
      const op = older.state.playerState || {}, np = newer.state.playerState || {};
      for (const uid of Object.keys(np)) {
        const a = op[uid], b = np[uid];
        players[uid] = a ? { ...b, x: lerp(a.x, b.x, t), height: lerp(a.height, b.height, t) } : b;
      }
      return { ball, players };
    }
    function localPlayerPose(raw) {
      // newest server state + velocity for the time since it arrived
      // (capped), so our own figure moves at display rate, not 30 Hz steps
      const newest = snapshots[snapshots.length - 1];
      const age = newest ? Math.min(nowSec() - newest.recv, 0.07) : 0;
      const height = Math.max(0, raw.height - raw.vy * age);
      return { ...raw, x: raw.x + raw.vx * age, height };
    }

    // ---------------- input: one place that knows what is held ----------------
    // Held state is tracked even outside "playing" (a key held through the
    // kickoff countdown), but only sent while playing; the server clears
    // every input at kickoff, so entering "playing" re-sends what's held.
    const heldKeys = new Set();        // "left" | "right" (keyboard)
    const heldDirPointers = new Map(); // pointerId -> "left" | "right"
    const heldJumpPointers = new Set();
    let jumpKeyHeld = false;
    let sentDir = 0;
    let sentJumpHeld = false;
    let localKickAt = -1;              // purely visual: kick pose starts on press
    function playing() { return !!lastState && lastState.phase === "playing"; }
    function currentDir() {
      const dirs = new Set([...heldKeys, ...heldDirPointers.values()]);
      if (dirs.has("left") && !dirs.has("right")) return -1;
      if (dirs.has("right") && !dirs.has("left")) return 1;
      return 0;
    }
    function syncDir(force) {
      const dir = currentDir();
      if (!playing()) return;
      if (dir !== sentDir || (force && dir !== 0)) { sentDir = dir; sendInput({ action: "move", dir }); }
    }
    function jumpHeldNow() { return jumpKeyHeld || heldJumpPointers.size > 0; }
    function pressJump() {
      if (!playing()) return;
      sentJumpHeld = true;
      sendInput({ action: "jump" });
    }
    function syncJumpRelease() {
      if (sentJumpHeld && !jumpHeldNow()) {
        sentJumpHeld = false;
        if (playing()) sendInput({ action: "jump_release" });
      }
    }
    function pressKick() {
      if (!playing()) return;
      localKickAt = nowSec();
      sendInput({ action: "kick" });
    }
    function resetAllInputs() {
      heldKeys.clear();
      heldDirPointers.clear();
      heldJumpPointers.clear();
      jumpKeyHeld = false;
      for (const b of stageEl.querySelectorAll(".kk-ctrl-btn--active")) b.classList.remove("kk-ctrl-btn--active");
      if (sentDir !== 0) { sentDir = 0; if (playing()) sendInput({ action: "move", dir: 0 }); }
      syncJumpRelease();
    }

    // ---------------- desktop keyboard ----------------
    function keyRole(e) {
      const k = e.key.toLowerCase();
      if (k === "a" || e.key === "ArrowLeft") return "left";
      if (k === "d" || e.key === "ArrowRight") return "right";
      if (k === " " || e.key === "Spacebar" || k === "w" || e.key === "ArrowUp") return "jump";
      if (k === "e" || k === "enter" || e.key === "Shift") return "kick";
      return null;
    }
    function onKeyDown(e) {
      if (isTypingTarget() || !lastState || lastState.phase === "lobby" || lastState.phase === "over") return;
      const role = keyRole(e);
      if (!role) return;
      e.preventDefault();
      if (role === "left" || role === "right") { heldKeys.add(role); syncDir(); }
      else if (role === "jump") { if (!e.repeat) { jumpKeyHeld = true; pressJump(); } }
      else if (role === "kick") { if (!e.repeat) pressKick(); }
    }
    function onKeyUp(e) {
      const role = keyRole(e);
      if (role === "left" || role === "right") { heldKeys.delete(role); syncDir(); }
      else if (role === "jump") { jumpKeyHeld = false; syncJumpRelease(); }
    }
    listen(window, "keydown", onKeyDown);
    listen(window, "keyup", onKeyUp);

    // ---------------- touch controls: one pointerId per button, so
    // right + jump + kick can all be held/pressed at the same time ----------------
    const leftBtn = stageEl.querySelector('[data-role="left"]');
    const rightBtn = stageEl.querySelector('[data-role="right"]');
    const jumpBtn = stageEl.querySelector('[data-role="jump"]');
    const kickBtn = stageEl.querySelector('[data-role="kick"]');

    function bindButton(btn, onDown, onUp) {
      const down = (e) => {
        e.preventDefault();
        try { btn.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        btn.classList.add("kk-ctrl-btn--active");
        onDown(e.pointerId);
      };
      const up = (e) => {
        onUp(e.pointerId);
        btn.classList.toggle("kk-ctrl-btn--active", false);
      };
      btn.addEventListener("pointerdown", down);
      btn.addEventListener("pointerup", up);
      btn.addEventListener("pointercancel", up);
      btn.addEventListener("lostpointercapture", up);
      btn.addEventListener("contextmenu", (e) => e.preventDefault());
    }
    bindButton(leftBtn, (id) => { heldDirPointers.set(id, "left"); syncDir(); }, (id) => { heldDirPointers.delete(id); syncDir(); });
    bindButton(rightBtn, (id) => { heldDirPointers.set(id, "right"); syncDir(); }, (id) => { heldDirPointers.delete(id); syncDir(); });
    bindButton(jumpBtn, (id) => { const first = heldJumpPointers.size === 0; heldJumpPointers.add(id); if (first) pressJump(); }, (id) => { heldJumpPointers.delete(id); syncJumpRelease(); });
    bindButton(kickBtn, () => pressKick(), () => {});

    // Safety nets: anything that can swallow a pointerup/keyup.
    listen(window, "blur", resetAllInputs);
    listen(document, "visibilitychange", () => { if (document.hidden) resetAllInputs(); });
    listen(window, "orientationchange", () => { resetAllInputs(); setTimeout(fitCanvas, 250); });
    // Opening the in-game chat (header 💬, see mobile-shell.js) covers the
    // controls - release everything, so nothing keeps running underneath.
    // Observed rather than hooked, so the shared chat code stays untouched.
    const chatPanel = document.getElementById("game-chat-panel");
    let chatObserver = null;
    if (chatPanel && window.MutationObserver) {
      let wasOpen = chatPanel.classList.contains("open");
      chatObserver = new MutationObserver(() => {
        const isOpen = chatPanel.classList.contains("open");
        if (isOpen && !wasOpen) resetAllInputs();
        wasOpen = isOpen;
      });
      chatObserver.observe(chatPanel, { attributes: true, attributeFilter: ["class"] });
    }

    // ---------------- lobby (selfie + ready) ----------------
    function opponentOf(state) {
      return (state.players || []).find((p) => p.userId !== myUid);
    }
    function meIn(state) {
      return (state.players || []).find((p) => p.userId === myUid);
    }

    function renderLobby(state) {
      const opp = opponentOf(state);
      const mine = meIn(state);
      const isHost = state.isHost;
      const bothReady = state.players.every((p) => p.ready);
      const bothSelfie = state.players.every((p) => p.hasSelfie);

      lobbyEl.innerHTML = `
        <div class="kk-lobby-card">
          <div class="kk-lobby-title">KOPFKICKER</div>
          <div class="kk-lobby-vs">
            <div class="kk-lobby-side" data-role="side-me"></div>
            <div class="kk-lobby-vs-label">VS</div>
            <div class="kk-lobby-side" data-role="side-opp"></div>
          </div>
          <div class="kk-lobby-mode">1 VS 1</div>
          <button type="button" class="primary-btn kk-lobby-start-btn" data-role="start" ${isHost && bothReady && bothSelfie ? "" : "disabled"}>
            ${isHost ? "▶ MATCH STARTEN" : "Warte auf Host …"}
          </button>
        </div>
      `;
      const sideMe = lobbyEl.querySelector('[data-role="side-me"]');
      const sideOpp = lobbyEl.querySelector('[data-role="side-opp"]');
      renderLobbySide(sideMe, mine, true, state);
      renderLobbySide(sideOpp, opp, false, state);

      const startBtn = lobbyEl.querySelector('[data-role="start"]');
      if (isHost) startBtn.addEventListener("click", () => sendInput({ action: "start_match" }));
    }

    function renderLobbySide(el, playerInfo, isMe, state) {
      if (!playerInfo) { el.innerHTML = `<div class="kk-lobby-empty">Warte auf Spieler …</div>`; return; }
      const name = playerInfo.name;
      let photoHtml;
      if (isMe && myOwnDataUrl.current) {
        photoHtml = `<img class="kk-lobby-photo" src="${myOwnDataUrl.current}" alt="${escapeHtml(name)}" />`;
      } else if (!isMe && images.has(playerInfo.userId)) {
        photoHtml = `<img class="kk-lobby-photo" src="${images.get(playerInfo.userId).src}" alt="${escapeHtml(name)}" />`;
      } else {
        photoHtml = `<div class="kk-lobby-photo kk-lobby-photo--empty">📸</div>`;
      }
      const statusHtml = playerInfo.ready
        ? `<span class="kk-lobby-status kk-lobby-status--ready">✅ Ready</span>`
        : playerInfo.hasSelfie
          ? `<span class="kk-lobby-status">🟡 Nicht bereit</span>`
          : `<span class="kk-lobby-status">📸 Selfie fehlt</span>`;
      el.innerHTML = `
        <div class="kk-lobby-name">${escapeHtml(name)}${isMe ? " (du)" : ""}</div>
        ${photoHtml}
        ${statusHtml}
        ${isMe ? `<div class="kk-lobby-actions" data-role="my-actions"></div>` : ""}
      `;
      if (isMe) {
        const actions = el.querySelector('[data-role="my-actions"]');
        if (!playerInfo.hasSelfie) {
          const captureHost = document.createElement("div");
          captureHost.className = "kk-lobby-capture-host";
          actions.appendChild(captureHost);
          if (selfieCapture) selfieCapture.destroy();
          selfieCapture = mountSelfieCapture(captureHost, {
            onConfirmed: (dataUrl, mime) => {
              myOwnDataUrl.current = dataUrl;
              images.set("me", dataUrl);
              renderKey = null; // show READY as soon as the server confirms
              sendRaw({ type: "kopf_selfie_set", data_url: dataUrl, mime });
            },
          });
        } else {
          const readyBtn = document.createElement("button");
          readyBtn.type = "button";
          readyBtn.className = playerInfo.ready ? "ghost-btn" : "primary-btn";
          readyBtn.textContent = playerInfo.ready ? "Nicht mehr bereit" : "✅ READY";
          readyBtn.addEventListener("click", () => sendInput({ action: "ready", value: !playerInfo.ready }));
          actions.appendChild(readyBtn);
          const changeBtn = document.createElement("button");
          changeBtn.type = "button";
          changeBtn.className = "ghost-btn";
          changeBtn.textContent = "Foto ändern";
          changeBtn.addEventListener("click", () => {
            // keep the server-side key, so the next snapshot (still
            // "has selfie") doesn't immediately tear the camera down again
            renderKey = computeRenderKey(lastState);
            myOwnDataUrl.current = null;
            const mine = meIn(lastState);
            if (mine) mine.hasSelfie = false;
            renderLobby(lastState);
          });
          actions.appendChild(changeBtn);
        }
      }
    }

    // ---------------- scoreboard / countdown / goal overlay ----------------
    function renderScoreboard(state) {
      const opp = opponentOf(state) || { name: "…" };
      const mine = meIn(state) || { name: me.name };
      const myScore = state.score[myUid] ?? 0;
      const oppScore = opp.userId != null ? (state.score[opp.userId] ?? 0) : 0;
      const timeLabel = state.goldenGoal
        ? "🔥 GOLDEN GOAL"
        : state.secondsLeft != null
          ? `${String(Math.floor(state.secondsLeft / 60)).padStart(2, "0")}:${String(state.secondsLeft % 60).padStart(2, "0")}`
          : "";
      const html = `
        <span class="kk-score-name">${escapeHtml(mine.name)}</span>
        <span class="kk-score-value">${myScore} : ${oppScore}</span>
        <span class="kk-score-name">${escapeHtml(opp.name)}</span>
        <span class="kk-score-timer ${state.goldenGoal ? "kk-score-timer--golden" : ""}">${timeLabel}</span>
      `;
      if (html !== scoreboardEl._lastHtml) { scoreboardEl.innerHTML = html; scoreboardEl._lastHtml = html; }
    }

    function renderOverlay(state) {
      let html = null;
      if (state.phase === "countdown") {
        const n = state.countdownSecondsLeft;
        html = `<div class="kk-countdown">${n > 0 ? n : "KICK OFF!"}</div>`;
      } else if (state.phase === "goal_pause" && state.lastGoal) {
        const g = state.lastGoal;
        if (g.timeout) {
          html = `<div class="kk-goal-banner"><div class="kk-goal-text">⏱ ZEIT UM!</div></div>`;
        } else {
          const scorer = (state.players || []).find((p) => p.userId === g.scorerUserId);
          const img = scorer ? (scorer.userId === myUid ? myOwnDataUrl.current : (images.get(scorer.userId) && images.get(scorer.userId).src)) : null;
          html = `
            <div class="kk-goal-banner">
              <div class="kk-goal-text">⚽ ${g.ownGoal ? "EIGENTOR!" : "TOOOOR!"}</div>
              ${img ? `<img class="kk-goal-photo" src="${img}" alt="" />` : ""}
              <div class="kk-goal-scorer">${scorer ? escapeHtml(scorer.name) : ""}</div>
            </div>
          `;
        }
      } else if (state.phase === "disconnect_grace") {
        const opp = opponentOf(state);
        html = `
          <div class="kk-goal-banner">
            <div class="kk-goal-text">📡 ${opp ? escapeHtml(opp.name) : "Gegner"} hat die Verbindung verloren …</div>
            <div class="kk-goal-scorer">Neuer Versuch in ${state.disconnectGraceSecondsLeft}s</div>
          </div>
        `;
      }
      overlayEl.hidden = html == null;
      // only touch the DOM when the content changes (30 snapshots/s would
      // otherwise restart the banner's entry animation every frame)
      if (html != null && html !== overlayEl._lastHtml) overlayEl.innerHTML = html;
      overlayEl._lastHtml = html;
    }

    // ---------------- effects (visual only, driven by server events) ----------------
    const effects = [];     // {type, x, y, born, strength}
    let lastEventSeq = null;
    let shakeUntil = 0, shakeAmp = 0;
    function physics() {
      return (lastState && lastState.physics) || { ballRadius: 24, headRadius: 46, bodyRadius: 24, headOffset: 92, bodyOffset: 34, kickReach: 20, kickHeight: 20, kickRadius: 34, kickTotal: 0.22, kickWindup: 0.03, kickActive: 0.11, maxBallSpeed: 1900, landAnim: 0.12 };
    }
    function consumeEvents(state) {
      const events = state.events || [];
      if (lastEventSeq == null) { lastEventSeq = events.length ? events[events.length - 1].seq : 0; return; }
      for (const ev of events) {
        if (ev.seq <= lastEventSeq) continue;
        lastEventSeq = ev.seq;
        const t = nowSec();
        if (ev.type === "kick" || ev.type === "head" || ev.type === "post") {
          effects.push({ type: "impact", x: ev.x, y: ev.y, born: t, strength: ev.type === "kick" ? 1 : Math.max(0.4, ev.strength * 1.6), post: ev.type === "post" });
        } else if (ev.type === "floor" && ev.strength > 0.3) {
          effects.push({ type: "dust", x: ev.x, y: ev.y, born: t, strength: ev.strength });
        } else if (ev.type === "goal") {
          effects.push({ type: "flash", x: ev.x, y: ev.y, born: t, strength: 1 });
          shake(4, 0.15);
        }
      }
      while (effects.length > 16) effects.shift();
    }
    function shake(px, secs) {
      if (reducedMotion) return;
      shakeAmp = px;
      shakeUntil = nowSec() + secs;
    }

    // ---------------- canvas rendering ----------------
    function drawArena(w, h, S) {
      const groundYpx = lastState.world.groundY * S;
      const grad = ctx.createLinearGradient(0, 0, 0, groundYpx);
      grad.addColorStop(0, "#1c2e52");
      grad.addColorStop(1, "#2c4a7c");
      ctx.fillStyle = grad;
      ctx.fillRect(-10, -10, w + 20, groundYpx + 10);
      // crowd dots (cheap stylized stadium detail)
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      for (let i = 0; i < 40; i++) {
        const cx = (i * 97) % w;
        const cy = 10 + ((i * 53) % 40);
        ctx.fillRect(cx, cy, 6, 4);
      }
      ctx.fillStyle = "#2e7d32";
      ctx.fillRect(-10, groundYpx, w + 20, h - groundYpx + 10);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = Math.max(1, h * 0.004);
      ctx.beginPath();
      ctx.moveTo(w / 2, groundYpx);
      ctx.lineTo(w / 2, h);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(w / 2, h, h * 0.12, Math.PI, 0);
      ctx.stroke();

      // goal nets (behind the frame): light hatched area inside each mouth
      const gTop = (lastState.world.groundY - lastState.world.goalHeight) * S;
      const gDepth = lastState.world.goalDepth * S;
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.lineWidth = 1;
      for (const side of [0, 1]) {
        const x0 = side === 0 ? 0 : w - gDepth;
        ctx.fillStyle = "rgba(255,255,255,0.05)";
        ctx.fillRect(x0, gTop, gDepth, groundYpx - gTop);
        for (let yy = gTop; yy < groundYpx; yy += 10 * S * 1.6) {
          ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x0 + gDepth, yy); ctx.stroke();
        }
      }
      ctx.restore();

      for (const [x1, y1, x2, y2] of lastState.walls) {
        const rx1 = x1 * S, ry1 = y1 * S, rx2 = x2 * S, ry2 = y2 * S;
        // only draw goal-frame-ish walls (thin), skip the huge offscreen
        // border rects so the frame stays visually clean
        if (Math.abs(rx2 - rx1) > w * 0.5 && Math.abs(ry2 - ry1) > h * 0.5) continue;
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.fillRect(rx1, ry1, rx2 - rx1, ry2 - ry1);
      }
    }

    function drawGroundShadow(sx, groundPx, elevation, baseR, S) {
      // higher = smaller and fainter (reads the ball's height at a glance)
      const k = Math.min(1, Math.max(0, elevation / 520));
      ctx.save();
      ctx.globalAlpha = 0.32 * (1 - k * 0.75);
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.ellipse(sx, groundPx + 2 * S, baseR * (1 - k * 0.55), baseR * 0.3 * (1 - k * 0.55), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Per-player visual animation state (client only - never fed back).
    const anim = new Map(); // uid -> {runPhase, lastT}
    function animFor(uid) {
      let a = anim.get(uid);
      if (!a) { a = { runPhase: 0, lastT: nowSec() }; anim.set(uid, a); }
      return a;
    }

    // The collider stays exactly where the server has it; everything in
    // here is a render transform (bob, squash, lean, kick leg).
    function drawPlayer(p, S, groundPx, img, isMe) {
      const cfg = physics();
      const t = nowSec();
      const a = animFor(p.userId);
      const dt = Math.min(0.05, t - a.lastT);
      a.lastT = t;
      const running = p.grounded && Math.abs(p.vx) > 30;
      if (running) a.runPhase += dt * (6 + Math.abs(p.vx) / 40);
      else a.runPhase *= 0.85;

      const sx = p.x * S;
      const footY = groundPx - p.height * S;
      const headR = cfg.headRadius * S;
      const bodyR = cfg.bodyRadius * S;
      const u = S; // one world unit in px

      // pose parameters (in world units / radians)
      let bob = 0, lean = 0, squashX = 1, squashY = 1, headLag = 0, tuck = 0, kickSwing = null;
      if (!reducedMotion) {
        if (running) { bob = Math.abs(Math.sin(a.runPhase)) * 4; lean = 0.09 * Math.sign(p.vx); }
        else if (p.grounded) bob = Math.sin(t * 2.4 + p.userId) * 1.2; // idle breathing
      }
      if (!p.grounded) {
        if (p.vy < 0) { headLag = 4; squashY = 1.05; squashX = 0.97; tuck = 10; }   // rising: stretched, legs tucked
        else { headLag = -3; tuck = 4; }                                            // falling: head trails a bit
      }
      if (p.landT != null && !reducedMotion) {
        const k = 1 - p.landT / cfg.landAnim;                                        // 1 -> 0
        squashY = 1 - 0.14 * k; squashX = 1 + 0.1 * k; headLag = -7 * k;
      }
      let kickT = p.kickT;
      if (kickT == null && isMe && localKickAt > 0 && t - localKickAt < cfg.kickTotal) kickT = t - localKickAt;
      if (kickT != null) {
        const k = kickT / cfg.kickTotal;
        // wind-up back, fast strike forward, recover
        kickSwing = k < 0.14 ? -0.5 * (k / 0.14) : k < 0.6 ? -0.5 + 1.9 * ((k - 0.14) / 0.46) : 1.4 * (1 - (k - 0.6) / 0.4);
        lean += 0.12 * p.facing * Math.min(1, Math.max(0, kickSwing));
      }

      const hipY = footY - (cfg.bodyOffset - cfg.bodyRadius * 0.55) * u;
      const bodyCy = footY - (cfg.bodyOffset + bob * 0.6) * u;
      const headCy = footY - (cfg.headOffset + bob + headLag) * u;
      const headCx = sx + Math.sin(lean) * 14 * u;

      // legs
      ctx.save();
      ctx.strokeStyle = "#1a1a1a";
      ctx.lineWidth = 9 * u;
      ctx.lineCap = "round";
      const stride = running ? Math.sin(a.runPhase) * 12 : 0;
      const lift = running ? Math.max(0, Math.cos(a.runPhase)) * 6 : 0;
      const legs = [
        { hx: sx - bodyR * 0.35, fx: sx - bodyR * 0.35 + stride * u, fy: footY - (lift + tuck) * u },
        { hx: sx + bodyR * 0.35, fx: sx + bodyR * 0.35 - stride * u, fy: footY - (running ? Math.max(0, -Math.cos(a.runPhase)) * 6 : tuck) * u },
      ];
      if (kickSwing != null) {
        // front leg becomes the kicking leg, swung around the hip
        const front = p.facing > 0 ? 1 : 0;
        const len = (cfg.bodyOffset - cfg.bodyRadius * 0.55) * u;
        const ang = Math.PI / 2 - kickSwing * p.facing * 0.9;
        legs[front].fx = legs[front].hx + Math.cos(ang) * len * 1.35;
        legs[front].fy = hipY + Math.sin(ang) * len * 1.1;
      }
      ctx.beginPath();
      for (const l of legs) { ctx.moveTo(l.hx, hipY); ctx.lineTo(l.fx, l.fy); }
      ctx.stroke();
      ctx.restore();

      // body
      ctx.save();
      ctx.translate(sx, bodyCy);
      ctx.rotate(lean);
      ctx.scale(squashX, squashY);
      ctx.fillStyle = p.color;
      ctx.strokeStyle = "rgba(0,0,0,0.3)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(0, 0, bodyR * 0.9, bodyR, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // head (the selfie) - unchanged image, only transformed
      ctx.save();
      ctx.translate(headCx, headCy);
      ctx.scale(squashX, squashY);
      ctx.beginPath();
      ctx.arc(0, 0, headR, 0, Math.PI * 2);
      ctx.closePath();
      ctx.save();
      ctx.clip();
      if (img && img.complete && img.naturalWidth) {
        ctx.drawImage(img, -headR, -headR, headR * 2, headR * 2);
      } else {
        ctx.fillStyle = "#cfd6e6";
        ctx.fillRect(-headR, -headR, headR * 2, headR * 2);
        ctx.fillStyle = "#8a93a8";
        ctx.font = `${Math.round(headR)}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("👤", 0, 0);
      }
      ctx.restore();
      ctx.lineWidth = 3;
      ctx.strokeStyle = p.color;
      ctx.stroke();
      ctx.restore();

      // name tag
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.font = `bold ${Math.max(10, 15 * u)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(p.name, headCx, headCy - headR - 8);
      ctx.restore();
    }

    let ballAngle = 0, lastBallT = 0;
    const trail = [];
    function drawBall(b, S, groundPx) {
      const cfg = physics();
      const r = cfg.ballRadius * S;
      const t = nowSec();
      const dt = lastBallT ? Math.min(0.05, t - lastBallT) : 0;
      lastBallT = t;
      ballAngle += (b.vx / cfg.ballRadius) * dt; // rolling look, visual only
      const bx = b.x * S, by = b.y * S;
      const elevation = lastState.world.groundY - cfg.ballRadius - b.y;
      drawGroundShadow(bx, groundPx, elevation, r * 1.1, S);

      // speed streak: only for really fast balls, short and faint
      const speed = Math.hypot(b.vx, b.vy);
      if (!reducedMotion && speed > cfg.maxBallSpeed * 0.6) {
        trail.push({ x: bx, y: by, t });
      }
      while (trail.length && (t - trail[0].t > 0.09 || trail.length > 6)) trail.shift();
      if (trail.length > 1 && !reducedMotion) {
        ctx.save();
        ctx.lineCap = "round";
        for (let i = 1; i < trail.length; i++) {
          const k = i / trail.length;
          ctx.strokeStyle = `rgba(255,255,255,${0.16 * k})`;
          ctx.lineWidth = r * 1.4 * k;
          ctx.beginPath();
          ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
          ctx.lineTo(trail[i].x, trail[i].y);
          ctx.stroke();
        }
        ctx.restore();
      }

      ctx.save();
      ctx.translate(bx, by);
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#1a1a1a";
      ctx.lineWidth = Math.max(1.5, 2 * S * 1.6);
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.save();
      ctx.clip();
      ctx.rotate(ballAngle);
      ctx.fillStyle = "#1a1a1a";
      ctx.beginPath(); ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < 5; i++) {
        const ang = (i / 5) * Math.PI * 2;
        ctx.beginPath(); ctx.arc(Math.cos(ang) * r * 0.95, Math.sin(ang) * r * 0.95, r * 0.26, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    function drawEffects(S, w, h) {
      const t = nowSec();
      for (let i = effects.length - 1; i >= 0; i--) {
        const e = effects[i];
        const age = t - e.born;
        const life = e.type === "flash" ? 0.35 : e.type === "dust" ? 0.3 : 0.2;
        if (age > life) { effects.splice(i, 1); continue; }
        const k = age / life;
        const x = e.x * S, y = e.y * S;
        ctx.save();
        if (e.type === "impact") {
          // 4 short lines flying out
          ctx.strokeStyle = e.post ? `rgba(255,255,255,${0.9 * (1 - k)})` : `rgba(255,236,170,${0.85 * (1 - k)})`;
          ctx.lineWidth = Math.max(1.5, 3 * S);
          ctx.lineCap = "round";
          const r0 = (10 + 30 * k) * S * e.strength, r1 = r0 + 14 * S * e.strength;
          for (let j = 0; j < 4; j++) {
            const ang = j * Math.PI / 2 + Math.PI / 4;
            ctx.beginPath();
            ctx.moveTo(x + Math.cos(ang) * r0, y + Math.sin(ang) * r0);
            ctx.lineTo(x + Math.cos(ang) * r1, y + Math.sin(ang) * r1);
            ctx.stroke();
          }
        } else if (e.type === "dust") {
          ctx.fillStyle = `rgba(210,230,200,${0.35 * (1 - k)})`;
          for (const dx of [-1, 1]) {
            ctx.beginPath();
            ctx.ellipse(x + dx * (8 + 22 * k) * S, y - 4 * S, (6 + 8 * k) * S, (3 + 4 * k) * S, 0, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (e.type === "flash" && !reducedMotion) {
          ctx.fillStyle = `rgba(255,255,255,${0.22 * (1 - k)})`;
          ctx.fillRect(0, 0, w, h);
        }
        ctx.restore();
      }
    }

    function drawDebug(S, groundPx, playersDraw, ballDraw) {
      const cfg = physics();
      const raw = lastState.playerState || {};
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.font = `${Math.max(10, 11 * S * 1.6)}px ui-monospace, monospace`;
      // goal zones
      const gTop = (lastState.world.groundY - lastState.world.goalHeight) * S;
      ctx.fillStyle = "rgba(255,80,80,0.18)";
      ctx.fillRect(-lastState.world.goalDepth * S, gTop, lastState.world.goalDepth * S, groundPx - gTop);
      ctx.fillRect(lastState.world.width * S, gTop, lastState.world.goalDepth * S, groundPx - gTop);
      for (const p of lastState.players) {
        const r = raw[p.userId];
        if (!r) continue;
        const foot = groundPx - r.height * S;
        ctx.strokeStyle = "rgba(0,255,255,0.9)";
        ctx.beginPath(); ctx.arc(r.x * S, foot - cfg.headOffset * S, cfg.headRadius * S, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(r.x * S, foot - cfg.bodyOffset * S, cfg.bodyRadius * S, 0, Math.PI * 2); ctx.stroke();
        if (r.kickT != null && r.kickT >= cfg.kickWindup && r.kickT < cfg.kickWindup + cfg.kickActive) {
          ctx.strokeStyle = "rgba(255,60,60,0.95)";
          ctx.beginPath(); ctx.arc((r.x + r.facing * (cfg.bodyRadius + cfg.kickReach)) * S, foot - cfg.kickHeight * S, cfg.kickRadius * S, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.strokeStyle = "rgba(255,255,0,0.9)";
        ctx.beginPath(); ctx.moveTo(r.x * S, foot); ctx.lineTo((r.x + r.vx * 0.15) * S, foot + r.vy * 0.15 * S); ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.fillText(`${r.grounded ? "G" : "air"} ${r.animation} vx${Math.round(r.vx)}`, r.x * S - 40, foot + 14);
      }
      const b = lastState.ball;
      if (b) {
        ctx.strokeStyle = "rgba(0,255,0,0.9)";
        ctx.beginPath(); ctx.arc(b.x * S, b.y * S, cfg.ballRadius * S, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(b.x * S, b.y * S); ctx.lineTo((b.x + b.vx * 0.12) * S, (b.y + b.vy * 0.12) * S); ctx.stroke();
      }
      const speed = b ? Math.hypot(b.vx, b.vy) : 0;
      const jitter = offsetSamples.length ? (offsetSamples[offsetSamples.length - 1] - clockOffset) * 1000 : 0;
      const lines = [
        `tick ${lastState.tick}  physics ${cfg.physicsHz} Hz  snapshots ${snapshotRate.toFixed(1)}/s`,
        `packet delay over best ${jitter.toFixed(0)} ms  render delay ${(RENDER_DELAY * 1000).toFixed(0)} ms`,
        `ball ${speed.toFixed(0)} u/s  ${b && b.asleep ? "ASLEEP" : "awake"}`,
      ];
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(6, 6, 380 * S * 1.2, lines.length * 16 * S * 1.4 + 8);
      ctx.fillStyle = "#fff";
      lines.forEach((l, i) => ctx.fillText(l, 12, 20 + i * 16 * S * 1.4));
      ctx.restore();
    }

    function render() {
      if (destroyed || !lastState || lastState.phase === "lobby" || lastState.phase === "over") return;
      const w = canvas.width, h = canvas.height;
      const S = w / worldW;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const t = nowSec();
      if (t < shakeUntil) {
        const k = (shakeUntil - t) / 0.15;
        ctx.translate((Math.random() * 2 - 1) * shakeAmp * k, (Math.random() * 2 - 1) * shakeAmp * k);
      }
      drawArena(w, h, S);

      const groundPx = lastState.world.groundY * S;
      const interp = interpolated();
      const playersData = lastState.playerState || {};

      for (const p of lastState.players) {
        const isMe = p.userId === myUid;
        const raw = playersData[p.userId];
        if (!raw) continue;
        let pose = isMe ? localPlayerPose(raw) : ((interp && interp.players[p.userId]) || raw);
        // own facing reacts to the key/button immediately
        if (isMe && sentDir !== 0) pose = { ...pose, facing: sentDir };
        drawGroundShadow(pose.x * S, groundPx, pose.height, physics().bodyRadius * 1.3 * S, S);
        drawPlayer({ ...pose, userId: p.userId, name: p.name, color: p.color }, S, groundPx, images.get(isMe ? "me" : p.userId), isMe);
      }

      if (lastState.ball) {
        const b = (interp && interp.ball) ? interp.ball : lastState.ball;
        drawBall(b, S, groundPx);
      }
      drawEffects(S, w, h);
      if (debug) drawDebug(S, groundPx);
    }

    let rafId = null;
    function frame() {
      if (destroyed) return;
      render();
      rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);

    // ---------------- top-level phase dispatch ----------------
    // Lobby re-render granularity: MY side holds the live camera/preview,
    // so it's only rebuilt when MY status changes. The opponent confirming
    // a photo or pressing READY used to rebuild the whole lobby - wiping a
    // photo preview (or open camera) mid-capture on this side.
    function computeRenderKey(state) {
      const mine = meIn(state) || {};
      return [state.phase, `${mine.hasSelfie}${mine.ready}`].join("|");
    }
    function computeOpponentKey(state) {
      const opp = opponentOf(state) || {};
      return `${opp.userId}${opp.hasSelfie}${opp.ready}${opp.userId != null && images.has(opp.userId)}|${state.isHost}`;
    }
    let opponentKey = null;
    function refreshLobbyOpponent(state) {
      const side = lobbyEl.querySelector('[data-role="side-opp"]');
      if (side) renderLobbySide(side, opponentOf(state), false, state);
      const startBtn = lobbyEl.querySelector('[data-role="start"]');
      if (startBtn) startBtn.disabled = !(state.isHost && state.players.every((p) => p.ready) && state.players.every((p) => p.hasSelfie));
    }

    function showPhaseContainers(state) {
      lobbyEl.hidden = state.phase !== "lobby";
      matchEl.hidden = state.phase === "lobby" || state.phase === "over";
      endscreenEl.hidden = state.phase !== "over";
    }

    function setState(state) {
      if (!state || destroyed) return;
      const prevPhase = lastState ? lastState.phase : null;
      lastState = state;
      if (state.world) { worldW = state.world.width; worldH = state.world.height; }

      showPhaseContainers(state);

      if (state.phase === "lobby") {
        const key = computeRenderKey(state);
        const oppKey = computeOpponentKey(state);
        if (key !== renderKey) { renderKey = key; opponentKey = oppKey; renderLobby(state); }
        else if (oppKey !== opponentKey) { opponentKey = oppKey; refreshLobbyOpponent(state); }
        return;
      }
      renderKey = null;

      if (state.phase === "over") {
        return; // handled by showGameOver()
      }

      if (state.phase === "playing" && prevPhase !== "playing") {
        // the server cleared all inputs at kickoff - re-send what's held
        sentDir = 0;
        sentJumpHeld = false;
        syncDir(true);
      }
      fitCanvas();
      if (state.ball) pushSnapshot(state);
      consumeEvents(state);
      renderScoreboard(state);
      renderOverlay(state);
    }

    // ---------------- incoming selfie photos ----------------
    function onSelfieEvent(data) {
      if (data.type === "kopf_selfie_photo") {
        if (data.user_id === myUid) {
          // our own photo, re-fetched after a remount (rematch)
          myOwnDataUrl.current = data.data_url;
          images.set("me", data.data_url);
          return;
        }
        images.set(data.user_id, data.data_url);
        if (lastState && lastState.phase === "lobby") refreshLobbyOpponent(lastState);
      }
    }

    // Request photos we don't have yet - the opponent's if they submitted
    // it before this client mounted, and our OWN after a remount (a rematch
    // mounts a fresh instance that no longer holds it).
    function requestOpponentSelfieIfNeeded(state) {
      const opp = opponentOf(state);
      if (opp && opp.hasSelfie && !images.has(opp.userId)) {
        sendRaw({ type: "kopf_request_selfie", target_user_id: opp.userId });
      }
      const mine = meIn(state);
      if (mine && mine.hasSelfie && !images.has("me")) {
        sendRaw({ type: "kopf_request_selfie", target_user_id: myUid });
      }
    }

    // ---------------- endscreen ----------------
    function renderEndscreen(state, gameOverData) {
      const opp = opponentOf(state) || {};
      const mine = meIn(state) || { name: me.name };
      const myScore = state.score ? (state.score[myUid] ?? 0) : 0;
      const oppScore = state.score && opp.userId != null ? (state.score[opp.userId] ?? 0) : 0;
      const iWon = myScore > oppScore;
      const draw = myScore === oppScore;
      const stats = state.stats || {};
      const myStats = stats[myUid] || {};
      const oppStats = opp.userId != null ? (stats[opp.userId] || {}) : {};

      const resultText = draw ? "UNENTSCHIEDEN" : iWon ? `${escapeHtml(mine.name).toUpperCase()} GEWINNT!` : `${escapeHtml(opp.name || "GEGNER").toUpperCase()} GEWINNT!`;

      endscreenEl.innerHTML = `
        <div class="kk-endscreen-card">
          <div class="kk-endscreen-title">🏆 KOPFKICKER</div>
          <div class="kk-endscreen-result">${resultText}</div>
          <div class="kk-endscreen-photos">
            <div class="kk-endscreen-photo-col">
              ${myOwnDataUrl.current ? `<img class="kk-endscreen-photo" src="${myOwnDataUrl.current}" alt="" />` : ""}
              <div>${escapeHtml(mine.name)}</div>
            </div>
            <div class="kk-endscreen-score">${myScore} : ${oppScore}</div>
            <div class="kk-endscreen-photo-col">
              ${images.get(opp.userId) ? `<img class="kk-endscreen-photo" src="${images.get(opp.userId).src}" alt="" />` : ""}
              <div>${escapeHtml(opp.name || "")}</div>
            </div>
          </div>
          <div class="kk-endscreen-stats">
            <div class="kk-endscreen-stat-row"><span>Tore</span><span>${myStats.goals || 0}</span><span>${oppStats.goals || 0}</span></div>
            <div class="kk-endscreen-stat-row"><span>Schüsse</span><span>${myStats.kicks || 0}</span><span>${oppStats.kicks || 0}</span></div>
            <div class="kk-endscreen-stat-row"><span>Eigentore</span><span>${myStats.own_goals || 0}</span><span>${oppStats.own_goals || 0}</span></div>
          </div>
          <div class="kk-endscreen-actions">
            <button type="button" class="primary-btn" data-role="rematch">🔁 REMATCH</button>
            <button type="button" class="ghost-btn" data-role="lobby">↩ ZUR LOBBY</button>
            <button type="button" class="ghost-btn" data-role="leave">SPIEL VERLASSEN</button>
          </div>
        </div>
      `;
      endscreenEl.querySelector('[data-role="rematch"]').addEventListener("click", () => sendRematch());
      endscreenEl.querySelector('[data-role="lobby"]').addEventListener("click", () => sendInput({ action: "back_to_lobby" }));
      endscreenEl.querySelector('[data-role="leave"]').addEventListener("click", () => closeGame && closeGame());
    }

    function showGameOver(data) {
      if (!lastState) return;
      resetAllInputs();
      showPhaseContainers({ phase: "over" });
      renderEndscreen(lastState, data);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (selfieCapture) selfieCapture.destroy();
      resizeObserver.disconnect();
      if (chatObserver) chatObserver.disconnect();
      for (const off of cleanups.splice(0)) off();
    }

    return {
      setState,
      showGameOver,
      destroy,
      handleSelfieEvent: onSelfieEvent,
      requestOpponentSelfieIfNeeded,
      _debugLastState() { return lastState; },
    };
  }

  window.KopfKicker = { mount };
})();
