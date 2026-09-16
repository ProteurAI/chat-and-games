// ============================================================================
// KopfKicker - 2-player realtime arcade head-football. Server-authoritative
// physics (backend/kopf_kicker.py), same model as Tank Battle/Dodge Arena:
// this module only captures input and renders whatever `game_state`
// broadcasts arrive - no client-trusted position, score or goal anywhere.
//
// Two things ARE handled client-side, deliberately:
//  1. The selfie capture flow (camera/file -> square crop -> downscale ->
//     compress) - purely local image processing before the small resulting
//     data URL is sent once over its own websocket channel (kopf_selfie_set/
//     kopf_selfie_photo), never through the generic per-tick state broadcast
//     and never through the chat image upload endpoint - see
//     backend/kopf_kicker.py's module docstring for why.
//  2. A light interpolation layer for the ball/opponent between the last two
//     received snapshots, rendered via requestAnimationFrame - upgrading a
//     bit past Tank Battle/Dodge Arena's plain "redraw on each snapshot"
//     baseline (documented there as intentionally simple) since a bouncing
//     ball benefits noticeably more from smoothing than a topdown tank does.
//     The LOCAL player's own body is always drawn from the latest snapshot
//     (snappiest possible feedback for your own input) - only the ball and
//     the opponent are interpolated.
//
// window.KopfKicker.mount(stageEl, opts) -> { setState(state), showGameOver(data), destroy() }
// opts: { me, players, sendInput(payload), sendRaw(msg), sendRematch(), closeGame() }
// ============================================================================

(function () {
  "use strict";

  const HEAD_RATIO = 0.92;      // matches backend HEAD_OFFSET-derived look; purely visual scale
  const RENDER_DELAY_MS = 90;   // ~2-3 server ticks behind, for a smooth interpolation buffer
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
              <button type="button" class="kk-ctrl-btn kk-ctrl-btn--jump" data-role="jump" aria-label="Springen">⬆</button>
              <button type="button" class="kk-ctrl-btn kk-ctrl-btn--kick" data-role="kick" aria-label="Schießen">👟</button>
            </div>
          </div>
          <p class="kk-hint">A/D oder ◀/▶ laufen · Leertaste springen · E schießen</p>
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
    window.addEventListener("orientationchange", () => setTimeout(fitCanvas, 250));

    // ---------------- snapshot interpolation buffer ----------------
    // Only the ball + opponent are interpolated (see module header); the
    // local player is always drawn from the newest snapshot directly.
    const snapshots = []; // [{t: performance.now(), state}]
    function pushSnapshot(state) {
      snapshots.push({ t: performance.now(), state });
      while (snapshots.length > 8) snapshots.shift();
    }
    function interpolatedRenderData() {
      if (!snapshots.length) return null;
      const renderTime = performance.now() - RENDER_DELAY_MS;
      let older = snapshots[0], newer = snapshots[0];
      for (let i = 0; i < snapshots.length; i++) {
        if (snapshots[i].t <= renderTime) older = snapshots[i];
        if (snapshots[i].t >= renderTime) { newer = snapshots[i]; break; }
        newer = snapshots[i];
      }
      if (older === newer) return { ball: older.state.ball, players: older.state.playerState };
      const span = newer.t - older.t;
      const t = span > 0 ? Math.min(1, Math.max(0, (renderTime - older.t) / span)) : 1;
      const ob = older.state.ball, nb = newer.state.ball;
      const ball = ob && nb ? { x: lerp(ob.x, nb.x, t), y: lerp(ob.y, nb.y, t) } : (nb || ob);
      const players = {};
      const op = older.state.playerState || {}, np = newer.state.playerState || {};
      for (const uid of Object.keys(np)) {
        const a = op[uid], b = np[uid];
        players[uid] = a ? {
          ...b,
          x: lerp(a.x, b.x, t),
          height: lerp(a.height, b.height, t),
        } : b;
      }
      return { ball, players };
    }

    // ---------------- desktop keyboard ----------------
    let curDir = 0;
    function onKeyDown(e) {
      if (isTypingTarget() || !lastState || lastState.phase !== "playing") return;
      if (["ArrowLeft", "ArrowRight", " ", "Spacebar"].includes(e.key)) e.preventDefault();
      const k = e.key.toLowerCase();
      if (k === "a" || e.key === "ArrowLeft") { if (curDir !== -1) { curDir = -1; sendInput({ action: "move", dir: -1 }); } }
      else if (k === "d" || e.key === "ArrowRight") { if (curDir !== 1) { curDir = 1; sendInput({ action: "move", dir: 1 }); } }
      else if (k === " " || e.key === "Spacebar") { sendInput({ action: "jump" }); }
      else if (k === "e" || k === "enter" || e.key === "Shift") { sendInput({ action: "kick" }); }
    }
    function onKeyUp(e) {
      const k = e.key.toLowerCase();
      if ((k === "a" || e.key === "ArrowLeft") && curDir === -1) { curDir = 0; sendInput({ action: "move", dir: 0 }); }
      else if ((k === "d" || e.key === "ArrowRight") && curDir === 1) { curDir = 0; sendInput({ action: "move", dir: 0 }); }
    }
    function onKeyboardBlur() {
      if (curDir !== 0) { curDir = 0; sendInput({ action: "move", dir: 0 }); }
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onKeyboardBlur);
    document.addEventListener("visibilitychange", onKeyboardBlur);

    // ---------------- touch controls (independent pointerId per button,
    // so run-right + jump + kick can all be held/pressed simultaneously -
    // see module header / brief's explicit multitouch requirement) ----------------
    const leftBtn = stageEl.querySelector('[data-role="left"]');
    const rightBtn = stageEl.querySelector('[data-role="right"]');
    const jumpBtn = stageEl.querySelector('[data-role="jump"]');
    const kickBtn = stageEl.querySelector('[data-role="kick"]');
    const heldDirButtons = new Map(); // pointerId -> "left"|"right"

    function recomputeTouchDir() {
      const dirs = new Set(heldDirButtons.values());
      let dir = 0;
      if (dirs.has("left") && !dirs.has("right")) dir = -1;
      else if (dirs.has("right") && !dirs.has("left")) dir = 1;
      if (dir !== curDir) { curDir = dir; sendInput({ action: "move", dir }); }
    }
    function bindDirButton(btn, which) {
      const onDown = (e) => { e.preventDefault(); try { btn.setPointerCapture(e.pointerId); } catch (err) {} heldDirButtons.set(e.pointerId, which); btn.classList.add("kk-ctrl-btn--active"); recomputeTouchDir(); };
      const onUp = (e) => { heldDirButtons.delete(e.pointerId); btn.classList.remove("kk-ctrl-btn--active"); recomputeTouchDir(); };
      btn.addEventListener("pointerdown", onDown);
      btn.addEventListener("pointerup", onUp);
      btn.addEventListener("pointercancel", onUp);
      btn.addEventListener("lostpointercapture", onUp);
      return () => {
        btn.removeEventListener("pointerdown", onDown);
        btn.removeEventListener("pointerup", onUp);
        btn.removeEventListener("pointercancel", onUp);
        btn.removeEventListener("lostpointercapture", onUp);
      };
    }
    const unbindLeft = bindDirButton(leftBtn, "left");
    const unbindRight = bindDirButton(rightBtn, "right");

    function bindTapButton(btn, action) {
      const onDown = (e) => { e.preventDefault(); try { btn.setPointerCapture(e.pointerId); } catch (err) {} btn.classList.add("kk-ctrl-btn--active"); sendInput({ action }); };
      const onUp = (e) => { btn.classList.remove("kk-ctrl-btn--active"); };
      btn.addEventListener("pointerdown", onDown);
      btn.addEventListener("pointerup", onUp);
      btn.addEventListener("pointercancel", onUp);
      btn.addEventListener("lostpointercapture", onUp);
      return () => {
        btn.removeEventListener("pointerdown", onDown);
        btn.removeEventListener("pointerup", onUp);
        btn.removeEventListener("pointercancel", onUp);
        btn.removeEventListener("lostpointercapture", onUp);
      };
    }
    const unbindJump = bindTapButton(jumpBtn, "jump");
    const unbindKick = bindTapButton(kickBtn, "kick");

    function resetAllTouch() {
      heldDirButtons.clear();
      leftBtn.classList.remove("kk-ctrl-btn--active");
      rightBtn.classList.remove("kk-ctrl-btn--active");
      if (curDir !== 0) { curDir = 0; sendInput({ action: "move", dir: 0 }); }
    }
    window.addEventListener("blur", resetAllTouch);
    document.addEventListener("visibilitychange", () => { if (document.hidden) resetAllTouch(); });

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
            myOwnDataUrl.current = null;
            playerInfo.hasSelfie = false;
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
      scoreboardEl.innerHTML = `
        <span class="kk-score-name">${escapeHtml(mine.name)}</span>
        <span class="kk-score-value">${myScore} : ${oppScore}</span>
        <span class="kk-score-name">${escapeHtml(opp.name)}</span>
        <span class="kk-score-timer ${state.goldenGoal ? "kk-score-timer--golden" : ""}">${timeLabel}</span>
      `;
    }

    function renderOverlay(state) {
      if (state.phase === "countdown") {
        overlayEl.hidden = false;
        const n = state.countdownSecondsLeft;
        overlayEl.innerHTML = `<div class="kk-countdown">${n > 0 ? n : "KICK OFF!"}</div>`;
      } else if (state.phase === "goal_pause" && state.lastGoal) {
        overlayEl.hidden = false;
        const g = state.lastGoal;
        if (g.timeout) {
          overlayEl.innerHTML = `<div class="kk-goal-banner"><div class="kk-goal-text">⏱ ZEIT UM!</div></div>`;
        } else {
          const scorer = (state.players || []).find((p) => p.userId === g.scorerUserId);
          const img = scorer ? (scorer.userId === myUid ? myOwnDataUrl.current : (images.get(scorer.userId) && images.get(scorer.userId).src)) : null;
          overlayEl.innerHTML = `
            <div class="kk-goal-banner">
              <div class="kk-goal-text">⚽ ${g.ownGoal ? "EIGENTOR!" : "TOOOOR!"}</div>
              ${img ? `<img class="kk-goal-photo" src="${img}" alt="" />` : ""}
              <div class="kk-goal-scorer">${scorer ? escapeHtml(scorer.name) : ""}</div>
            </div>
          `;
        }
      } else if (state.phase === "disconnect_grace") {
        overlayEl.hidden = false;
        const opp = opponentOf(state);
        overlayEl.innerHTML = `
          <div class="kk-goal-banner">
            <div class="kk-goal-text">📡 ${opp ? escapeHtml(opp.name) : "Gegner"} hat die Verbindung verloren …</div>
            <div class="kk-goal-scorer">Neuer Versuch in ${state.disconnectGraceSecondsLeft}s</div>
          </div>
        `;
      } else {
        overlayEl.hidden = true;
      }
    }

    // ---------------- canvas rendering ----------------
    function drawArena(w, h) {
      const groundYpx = (lastState.world.groundY / worldH) * h;
      const grad = ctx.createLinearGradient(0, 0, 0, groundYpx);
      grad.addColorStop(0, "#1c2e52");
      grad.addColorStop(1, "#2c4a7c");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, groundYpx);
      // crowd dots (cheap stylized stadium detail)
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      for (let i = 0; i < 40; i++) {
        const cx = (i * 97) % w;
        const cy = 10 + ((i * 53) % 40);
        ctx.fillRect(cx, cy, 6, 4);
      }
      ctx.fillStyle = "#2e7d32";
      ctx.fillRect(0, groundYpx, w, h - groundYpx);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = Math.max(1, h * 0.004);
      ctx.beginPath();
      ctx.moveTo(w / 2, groundYpx);
      ctx.lineTo(w / 2, h);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(w / 2, h, h * 0.12, Math.PI, 0);
      ctx.stroke();

      for (const [x1, y1, x2, y2] of lastState.walls) {
        const sx = (v) => (v / worldW) * w;
        const sy = (v) => (v / worldH) * h;
        const rx1 = sx(x1), ry1 = sy(y1), rx2 = sx(x2), ry2 = sy(y2);
        // only draw goal-frame-ish walls (thin), skip the huge offscreen
        // border rects so the frame stays visually clean
        if (Math.abs(rx2 - rx1) > w * 0.5 && Math.abs(ry2 - ry1) > h * 0.5) continue;
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.fillRect(rx1, ry1, rx2 - rx1, ry2 - ry1);
      }
    }

    function drawShadow(sx, sy, scale) {
      ctx.save();
      ctx.globalAlpha = 0.28 * scale;
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.ellipse(sx, sy, 26 * scale, 8 * scale, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    function drawPlayer(sx, foot_sy, p, img, worldToPx) {
      const headR = worldToPx(46);
      const bodyR = worldToPx(24);
      const headY = foot_sy - worldToPx(92);
      const bodyY = foot_sy - worldToPx(34);
      const legSwing = p.animation === "run" ? Math.sin(performance.now() / 90) * 0.5 : 0;

      // legs
      ctx.save();
      ctx.strokeStyle = "#1a1a1a";
      ctx.lineWidth = worldToPx(10);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(sx - bodyR * 0.4, bodyY + bodyR * 0.6);
      ctx.lineTo(sx - bodyR * 0.4 + legSwing * bodyR, foot_sy);
      ctx.moveTo(sx + bodyR * 0.4, bodyY + bodyR * 0.6);
      ctx.lineTo(sx + bodyR * 0.4 - legSwing * bodyR, foot_sy);
      if (p.kicking) {
        ctx.moveTo(sx, bodyY + bodyR * 0.5);
        ctx.lineTo(sx + p.facing * bodyR * 1.6, foot_sy - bodyR * 0.3);
      }
      ctx.stroke();
      ctx.restore();

      // body
      ctx.save();
      ctx.fillStyle = p.color;
      ctx.strokeStyle = "rgba(0,0,0,0.3)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(sx, bodyY, bodyR * 0.9, bodyR, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // head (the selfie)
      ctx.save();
      ctx.beginPath();
      ctx.arc(sx, headY, headR, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      if (img && img.complete && img.naturalWidth) {
        ctx.drawImage(img, sx - headR, headY - headR, headR * 2, headR * 2);
      } else {
        ctx.fillStyle = "#cfd6e6";
        ctx.fillRect(sx - headR, headY - headR, headR * 2, headR * 2);
        ctx.fillStyle = "#8a93a8";
        ctx.font = `${Math.round(headR)}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("👤", sx, headY);
      }
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.arc(sx, headY, headR, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = p.color;
      ctx.stroke();
      ctx.restore();

      // name tag
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.font = `bold ${Math.max(10, worldToPx(15))}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(p.name, sx, headY - headR - 8);
      ctx.restore();
    }

    function drawBall(sx, sy, elevation, worldToPx) {
      const r = worldToPx(20);
      drawShadow(sx, sy + worldToPx(4), Math.max(0.4, 1 - elevation / 300));
      ctx.save();
      ctx.translate(sx, sy);
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#1a1a1a";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#1a1a1a";
      ctx.beginPath(); ctx.arc(0, 0, r * 0.32, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    function render() {
      if (destroyed || !lastState || lastState.phase === "lobby" || lastState.phase === "over") return;
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      drawArena(w, h);

      const worldToPx = (v) => (v / worldW) * w;
      const sx = (v) => (v / worldW) * w;
      const sy = (v) => (v / worldH) * h;
      const groundYpx = sy(lastState.world.groundY);

      const interp = interpolatedRenderData();
      const playersData = lastState.playerState || {};
      const opp = opponentOf(lastState);

      for (const p of lastState.players) {
        const isMe = p.userId === myUid;
        const raw = playersData[p.userId];
        if (!raw) continue;
        const smoothed = (!isMe && interp && interp.players[p.userId]) ? interp.players[p.userId] : raw;
        const footSy = groundYpx - sy(smoothed.height);
        const psx = sx(smoothed.x);
        drawShadow(psx, groundYpx, 1);
        const drawableImg = images.get(isMe ? "me" : p.userId);
        drawPlayer(psx, footSy, { ...raw, name: p.name, color: p.color, facing: smoothed.facing }, drawableImg, worldToPx);
      }

      if (lastState.ball) {
        const ballData = (interp && interp.ball) ? interp.ball : lastState.ball;
        const bsx = sx(ballData.x), bsy = sy(ballData.y);
        const elevation = lastState.world.groundY - ballData.y;
        drawBall(bsx, bsy, elevation, worldToPx);
      }
    }

    let rafId = null;
    function frame() {
      if (destroyed) return;
      render();
      rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);

    // ---------------- top-level phase dispatch ----------------
    function computeRenderKey(state) {
      return [state.phase, state.players.map((p) => `${p.hasSelfie}${p.ready}`).join(",")].join("|");
    }

    function showPhaseContainers(state) {
      lobbyEl.hidden = state.phase !== "lobby";
      matchEl.hidden = state.phase === "lobby" || state.phase === "over";
      endscreenEl.hidden = state.phase !== "over";
    }

    function setState(state) {
      if (!state || destroyed) return;
      lastState = state;
      if (state.world) { worldW = state.world.width; worldH = state.world.height; }

      showPhaseContainers(state);

      if (state.phase === "lobby") {
        const key = computeRenderKey(state);
        if (key !== renderKey) { renderKey = key; renderLobby(state); }
        return;
      }

      if (state.phase === "over") {
        return; // handled by showGameOver()
      }

      fitCanvas();
      if (state.ball) pushSnapshot(state);
      renderScoreboard(state);
      renderOverlay(state);
    }

    // ---------------- incoming selfie photos ----------------
    function onSelfieEvent(data) {
      if (data.type === "kopf_selfie_photo") {
        if (data.user_id === myUid) return;
        images.set(data.user_id, data.data_url);
        if (lastState && lastState.phase === "lobby") renderLobby(lastState);
      }
    }

    // Request the opponent's photo in case they submitted it before this
    // client (re)mounted the modal (e.g. a fresh page load joining an
    // already-in-progress lobby is not supported, but a remount within
    // the same session is - see backend module docstring for the exact
    // scope of "reconnect" this covers).
    function requestOpponentSelfieIfNeeded(state) {
      const opp = opponentOf(state);
      if (opp && opp.hasSelfie && !images.has(opp.userId)) {
        sendRaw({ type: "kopf_request_selfie", target_user_id: opp.userId });
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
      showPhaseContainers({ phase: "over" });
      renderEndscreen(lastState, data);
    }

    function destroy() {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (selfieCapture) selfieCapture.destroy();
      resizeObserver.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onKeyboardBlur);
      document.removeEventListener("visibilitychange", onKeyboardBlur);
      window.removeEventListener("blur", resetAllTouch);
      unbindLeft(); unbindRight(); unbindJump(); unbindKick();
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
