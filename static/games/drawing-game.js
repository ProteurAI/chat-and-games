// ============================================================================
// Kritzelmeister - live drawing-and-guessing party game for Chat & Games.
//
// Round flow, drawer rotation, word secrecy, timers and scoring are fully
// server-authoritative (backend/drawing_game.py) via the existing
// game_state/game_over websocket events - this module only renders what
// it's given and sends {action:"select_word"|"guess", ...} through the
// same game_input channel every other multiplayer game uses.
//
// Live strokes are the one exception: they're sent/received through their
// own small set of namespaced drawing_* websocket messages (NOT
// game_input), batched from raw pointer events into ~25 updates/second,
// with normalized (0-1) coordinates so every screen size sees the exact
// same drawing correctly scaled - see sendWs()/the pointer handlers below,
// and backend/drawing_game.py's module docstring for why the server keeps
// this path separate from the generic per-tick state broadcast.
//
// SECURITY NOTE: this module never receives the secret word unless the
// viewer IS the drawer, has already guessed correctly, or the round is in
// "reveal" - see public_state() server-side. Guesses that turn out
// correct never carry the guessed text back down either; only a
// {correct:true} flag + the guesser's name.
//
// window.KritzelmeisterGame.mount(stageEl, opts) -> { setState(state), showGameOver(data), destroy() }
// window.KritzelmeisterGame.openHostOptionsModal(onConfirm)
// ============================================================================

(function () {
  "use strict";

  const CANVAS_W = 1000;
  const CANVAS_H = 700;
  const COLORS = ["#000000", "#e53935", "#1e88e5", "#43a047", "#fdd835", "#fb8c00", "#8e24aa"];
  const WIDTHS = [3, 6, 12];
  const BATCH_MS = 40; // ~25 flushes/second

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str == null ? "" : String(str);
    return d.innerHTML;
  }

  function uid() {
    return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------------------------------------------------------------------
  // Host pre-create options modal (rounds per player / draw time)
  // ---------------------------------------------------------------------
  function openHostOptionsModal(onConfirm) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal dg-options-modal">
        <div class="modal-head">
          <h2>🎨 Kritzelmeister erstellen</h2>
          <button type="button" class="icon-btn" data-role="close">✕</button>
        </div>
        <div class="dg-options-body">
          <div class="dg-options-group">
            <div class="dg-options-label">Runden pro Spieler</div>
            <div class="dg-options-chips" data-role="rpp">
              <button type="button" class="dg-chip" data-value="1">1</button>
              <button type="button" class="dg-chip dg-chip--active" data-value="2">2</button>
              <button type="button" class="dg-chip" data-value="3">3</button>
            </div>
          </div>
          <div class="dg-options-group">
            <div class="dg-options-label">Zeichenzeit</div>
            <div class="dg-options-chips" data-role="draw">
              <button type="button" class="dg-chip" data-value="60">60s</button>
              <button type="button" class="dg-chip dg-chip--active" data-value="80">80s</button>
              <button type="button" class="dg-chip" data-value="100">100s</button>
            </div>
          </div>
        </div>
        <div class="dg-options-actions">
          <button type="button" class="ghost-btn" data-role="cancel">Abbrechen</button>
          <button type="button" class="primary-btn" data-role="confirm">Spiel erstellen</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    function close() { overlay.remove(); }
    overlay.querySelector('[data-role="close"]').addEventListener("click", close);
    overlay.querySelector('[data-role="cancel"]').addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    for (const group of overlay.querySelectorAll(".dg-options-chips")) {
      group.addEventListener("click", (e) => {
        const btn = e.target.closest(".dg-chip");
        if (!btn) return;
        for (const c of group.querySelectorAll(".dg-chip")) c.classList.remove("dg-chip--active");
        btn.classList.add("dg-chip--active");
      });
    }

    overlay.querySelector('[data-role="confirm"]').addEventListener("click", () => {
      const rounds_per_player = parseInt(overlay.querySelector('[data-role="rpp"] .dg-chip--active').dataset.value, 10);
      const draw_seconds = parseInt(overlay.querySelector('[data-role="draw"] .dg-chip--active').dataset.value, 10);
      close();
      onConfirm({ rounds_per_player, draw_seconds });
    });
  }

  // ---------------------------------------------------------------------
  // Main module
  // ---------------------------------------------------------------------
  function mount(stageEl, opts) {
    const { me, sendInput, sendRematch, closeGame, sendWs } = opts;

    stageEl.innerHTML = `
      <div class="dg-root">
        <div class="dg-topbar" data-role="topbar"></div>
        <div class="dg-canvas-outer" data-role="canvas-outer">
          <div class="dg-canvas-wrap" data-role="canvas-wrap">
            <canvas class="dg-canvas" data-role="canvas" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
            <div class="dg-choosing-overlay" data-role="choosing-overlay" hidden></div>
            <div class="dg-reveal-overlay" data-role="reveal-overlay" hidden></div>
          </div>
        </div>
        <div class="dg-toolbar" data-role="toolbar" hidden></div>
        <div class="dg-guess-area" data-role="guess-area" hidden>
          <form class="dg-guess-form" data-role="guess-form">
            <input type="text" class="dg-guess-input" data-role="guess-input" placeholder="Deine Vermutung …" maxlength="80" autocomplete="off" />
            <button type="submit" class="primary-btn dg-guess-submit">Raten</button>
          </form>
          <div class="dg-guess-feed" data-role="guess-feed"></div>
        </div>
      </div>
    `;

    const root = stageEl.querySelector(".dg-root");
    const topbar = stageEl.querySelector('[data-role="topbar"]');
    const canvasOuter = stageEl.querySelector('[data-role="canvas-outer"]');
    const canvasWrap = stageEl.querySelector('[data-role="canvas-wrap"]');
    const canvas = stageEl.querySelector('[data-role="canvas"]');
    const choosingOverlay = stageEl.querySelector('[data-role="choosing-overlay"]');
    const revealOverlay = stageEl.querySelector('[data-role="reveal-overlay"]');
    const toolbar = stageEl.querySelector('[data-role="toolbar"]');
    const guessArea = stageEl.querySelector('[data-role="guess-area"]');
    const guessForm = stageEl.querySelector('[data-role="guess-form"]');
    const guessInput = stageEl.querySelector('[data-role="guess-input"]');
    const guessFeed = stageEl.querySelector('[data-role="guess-feed"]');
    const ctx = canvas.getContext("2d");

    let lastState = null;
    let renderKey = null;
    let destroyed = false;

    // ---- tool state (drawer only) ----
    let currentColor = COLORS[0];
    let currentWidth = WIDTHS[1];
    let currentTool = "pen";
    let activeStrokeId = null;
    let pendingBatch = [];
    let batchTimer = null;
    let localStrokeCount = 0; // for one_stroke special round UI

    // ---- local stroke store (authoritative-ish mirror for rendering) ----
    // { id, color, width, tool, points: [{x,y}], done, mine }
    const strokes = [];
    let myLastLocalStroke = null;

    function send(type, payload) {
      if (typeof sendWs === "function") sendWs(Object.assign({ type }, payload));
    }

    // ---------------------------------------------------------------------
    // canvas fit (logical 1000x700 world, displayed size follows container -
    // same fitCanvasToContainer() pattern the arcade games use)
    // ---------------------------------------------------------------------
    function fitCanvas() {
      const ow = canvasOuter.clientWidth;
      const oh = canvasOuter.clientHeight;
      if (!ow || !oh) return;
      const ratio = CANVAS_W / CANVAS_H;
      let w = ow, h = ow / ratio;
      if (h > oh) { h = oh; w = oh * ratio; }
      canvasWrap.style.width = `${Math.floor(w)}px`;
      canvasWrap.style.height = `${Math.floor(h)}px`;
      canvas.style.width = `${Math.floor(w)}px`;
      canvas.style.height = `${Math.floor(h)}px`;
    }
    let resizeObserver = null;
    if (window.ResizeObserver) {
      resizeObserver = new ResizeObserver(() => fitCanvas());
      resizeObserver.observe(canvasOuter);
    }
    window.addEventListener("resize", fitCanvas);
    setTimeout(fitCanvas, 0);

    // ---------------------------------------------------------------------
    // rendering
    // ---------------------------------------------------------------------
    function redrawAll() {
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      for (const s of strokes) drawStroke(s);
    }

    function drawStroke(s) {
      if (!s.points.length) return;
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalCompositeOperation = s.tool === "eraser" ? "destination-out" : "source-over";
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      // "blind" special round: the drawer's OWN completed strokes render
      // near-invisible on their own screen only (everyone else - and the
      // server's authoritative copy - keep full opacity); the stroke
      // currently being drawn stays visible so they can still see what
      // they're doing right now.
      const isBlindHidden = s.mine && s.done && lastState && lastState.specialRound === "blind" && lastState.isDrawer;
      ctx.globalAlpha = isBlindHidden ? 0.04 : 1;
      ctx.beginPath();
      const pts = s.points;
      ctx.moveTo(pts[0].x * CANVAS_W, pts[0].y * CANVAS_H);
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i];
        ctx.lineTo(p.x * CANVAS_W, p.y * CANVAS_H);
      }
      if (pts.length === 1) ctx.lineTo(pts[0].x * CANVAS_W + 0.01, pts[0].y * CANVAS_H + 0.01);
      ctx.stroke();
      ctx.restore();
    }

    function findStroke(id) { return strokes.find((s) => s.id === id); }

    function clearStrokes() {
      strokes.length = 0;
      redrawAll();
    }

    // ---------------------------------------------------------------------
    // incoming websocket relay (called from app.js's handleWsEvent)
    // ---------------------------------------------------------------------
    function onDrawingEvent(data) {
      if (destroyed) return;
      if (data.type === "drawing_stroke_start") {
        strokes.push({ id: data.stroke_id, color: data.color, width: data.width, tool: data.tool, points: data.points || [], done: false, mine: false });
        drawStroke(strokes[strokes.length - 1]);
      } else if (data.type === "drawing_stroke_batch") {
        const s = findStroke(data.stroke_id);
        if (!s) return;
        s.points.push(...data.points);
        drawStroke(s); // incremental - fine since strokes only ever grow, never shrink here
      } else if (data.type === "drawing_stroke_end") {
        const s = findStroke(data.stroke_id);
        if (s) s.done = true;
      } else if (data.type === "drawing_undo") {
        strokes.pop();
        redrawAll();
      } else if (data.type === "drawing_clear") {
        clearStrokes();
      } else if (data.type === "drawing_sync") {
        strokes.length = 0;
        for (const s of data.strokes || []) strokes.push(Object.assign({ mine: false }, s));
        redrawAll();
      }
    }

    // request a fresh snapshot once on mount, and whenever the server-
    // reported strokesVersion (carried on every lightweight state tick)
    // doesn't match what we've locally accumulated - covers a missed
    // relay or a fresh websocket on an already-open tab (see
    // backend/drawing_game.py's handle_request_sync docstring).
    let knownStrokesVersion = 0;
    function maybeResync(state) {
      if (state.strokesVersion !== knownStrokesVersion) {
        knownStrokesVersion = state.strokesVersion;
        send("drawing_request_sync", {});
      }
    }
    send("drawing_request_sync", {});

    // ---------------------------------------------------------------------
    // drawer input: pointer events on the canvas, batched to ~25/s
    // ---------------------------------------------------------------------
    function canvasPoint(e) {
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
    }

    function flushBatch() {
      if (activeStrokeId && pendingBatch.length) {
        send("drawing_stroke_batch", { stroke_id: activeStrokeId, points: pendingBatch });
        pendingBatch = [];
      }
    }

    function iAmDrawing() {
      return lastState && lastState.isDrawer && lastState.phase === "drawing";
    }

    function oneStrokeBudgetLeft() {
      if (!lastState || lastState.specialRound !== "one_stroke") return Infinity;
      return lastState.oneStrokeBudget == null ? Infinity : lastState.oneStrokeBudget;
    }

    let pointerDown = false;
    function onPointerDown(e) {
      if (!iAmDrawing() || oneStrokeBudgetLeft() <= 0) return;
      pointerDown = true;
      canvas.setPointerCapture(e.pointerId);
      activeStrokeId = uid();
      const pt = canvasPoint(e);
      const stroke = { id: activeStrokeId, color: currentColor, width: currentWidth, tool: currentTool, points: [pt], done: false, mine: true };
      strokes.push(stroke);
      drawStroke(stroke);
      pendingBatch = [];
      send("drawing_stroke_start", { stroke_id: activeStrokeId, color: currentColor, width: currentWidth, tool: currentTool, points: [pt] });
      if (batchTimer) clearInterval(batchTimer);
      batchTimer = setInterval(flushBatch, BATCH_MS);
    }
    function onPointerMove(e) {
      if (!pointerDown || !activeStrokeId) return;
      const pt = canvasPoint(e);
      const s = findStroke(activeStrokeId);
      if (s) { s.points.push(pt); drawStroke(s); }
      pendingBatch.push(pt);
    }
    function endStroke() {
      if (!pointerDown || !activeStrokeId) { pointerDown = false; return; }
      pointerDown = false;
      flushBatch();
      if (batchTimer) { clearInterval(batchTimer); batchTimer = null; }
      const s = findStroke(activeStrokeId);
      if (s) s.done = true;
      send("drawing_stroke_end", { stroke_id: activeStrokeId });
      activeStrokeId = null;
      localStrokeCount++;
      if (lastState && lastState.specialRound === "blind" && lastState.isDrawer) redrawAll();
      renderToolbarStrokeBudget();
    }
    function onPointerUp() { endStroke(); }
    function onPointerCancel() { endStroke(); }

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("lostpointercapture", onPointerCancel);
    document.addEventListener("visibilitychange", () => { if (document.hidden) endStroke(); });
    // touch-action:none is scoped to just the canvas (CSS), not the app -
    // no global scroll/zoom lockout.

    function undoStroke() {
      if (!iAmDrawing()) return;
      // optimistic local pop; the server's own drawing_undo echo (sent to
      // ALL session members, drawer included) is then a harmless no-op.
      strokes.pop();
      redrawAll();
      send("drawing_undo", {});
    }
    function requestClear() {
      if (!iAmDrawing()) return;
      if (!confirm("Zeichnung wirklich löschen?")) return;
      clearStrokes();
      send("drawing_clear", {});
    }

    // ---------------------------------------------------------------------
    // toolbar
    // ---------------------------------------------------------------------
    function renderToolbar() {
      toolbar.innerHTML = `
        <button type="button" class="dg-tool-btn dg-tool-btn--active" data-role="tool-pen" title="Stift">✏️</button>
        <button type="button" class="dg-tool-btn" data-role="tool-eraser" title="Radierer">🧽</button>
        <button type="button" class="dg-tool-btn" data-role="undo" title="Rückgängig">↶</button>
        <button type="button" class="dg-tool-btn" data-role="clear" title="Löschen">🗑️</button>
        <button type="button" class="dg-tool-btn dg-color-trigger" data-role="color-trigger" title="Farbe">🎨</button>
        <button type="button" class="dg-tool-btn" data-role="width-trigger" title="Strichstärke">•••</button>
        <span class="dg-stroke-budget" data-role="stroke-budget" hidden></span>
        <div class="dg-popover dg-color-popover" data-role="color-popover" hidden>
          ${COLORS.map((c) => `<button type="button" class="dg-swatch" data-color="${c}" style="background:${c}" aria-label="Farbe wählen"></button>`).join("")}
        </div>
        <div class="dg-popover dg-width-popover" data-role="width-popover" hidden>
          ${WIDTHS.map((w) => `<button type="button" class="dg-width-opt" data-width="${w}"><span style="width:${w * 2}px;height:${w * 2}px"></span></button>`).join("")}
        </div>
      `;
      const penBtn = toolbar.querySelector('[data-role="tool-pen"]');
      const eraserBtn = toolbar.querySelector('[data-role="tool-eraser"]');
      penBtn.addEventListener("click", () => { currentTool = "pen"; penBtn.classList.add("dg-tool-btn--active"); eraserBtn.classList.remove("dg-tool-btn--active"); });
      eraserBtn.addEventListener("click", () => { currentTool = "eraser"; eraserBtn.classList.add("dg-tool-btn--active"); penBtn.classList.remove("dg-tool-btn--active"); });
      toolbar.querySelector('[data-role="undo"]').addEventListener("click", undoStroke);
      toolbar.querySelector('[data-role="clear"]').addEventListener("click", requestClear);

      const colorPop = toolbar.querySelector('[data-role="color-popover"]');
      const widthPop = toolbar.querySelector('[data-role="width-popover"]');
      toolbar.querySelector('[data-role="color-trigger"]').addEventListener("click", () => {
        widthPop.hidden = true;
        colorPop.hidden = !colorPop.hidden;
      });
      toolbar.querySelector('[data-role="width-trigger"]').addEventListener("click", () => {
        colorPop.hidden = true;
        widthPop.hidden = !widthPop.hidden;
      });
      for (const sw of toolbar.querySelectorAll(".dg-swatch")) {
        if (sw.dataset.color === currentColor) sw.classList.add("dg-swatch--active");
        sw.addEventListener("click", () => {
          currentColor = sw.dataset.color;
          for (const s of toolbar.querySelectorAll(".dg-swatch")) s.classList.toggle("dg-swatch--active", s === sw);
          colorPop.hidden = true;
        });
      }
      for (const wb of toolbar.querySelectorAll(".dg-width-opt")) {
        if (parseInt(wb.dataset.width, 10) === currentWidth) wb.classList.add("dg-width-opt--active");
        wb.addEventListener("click", () => {
          currentWidth = parseInt(wb.dataset.width, 10);
          for (const w of toolbar.querySelectorAll(".dg-width-opt")) w.classList.toggle("dg-width-opt--active", w === wb);
          widthPop.hidden = true;
        });
      }
      renderToolbarStrokeBudget();
    }
    function renderToolbarStrokeBudget() {
      const chip = toolbar.querySelector('[data-role="stroke-budget"]');
      if (!chip) return;
      if (lastState && lastState.specialRound === "one_stroke" && lastState.isDrawer && lastState.phase === "drawing") {
        chip.hidden = false;
        chip.textContent = `Striche übrig: ${lastState.oneStrokeBudget}`;
      } else {
        chip.hidden = true;
      }
    }

    // ---------------------------------------------------------------------
    // topbar / status
    // ---------------------------------------------------------------------
    function specialBanner(state) {
      if (!state.specialRound) return "";
      const meta = {
        chaos: { label: "🔥 CHAOSRUNDE", sub: "Nur 20 Sekunden Zeit!" },
        one_stroke: { label: "✏️ EIN STRICH", sub: "Nur 3 Striche erlaubt!" },
        blind: { label: "🙈 BLINDZEICHNEN", sub: state.isDrawer ? "Du siehst deine eigenen Linien nicht!" : "Der/Die Zeichner(in) zeichnet blind!" },
      }[state.specialRound];
      if (!meta) return "";
      return `<div class="dg-special-banner dg-special-banner--${state.specialRound}"><strong>${meta.label}</strong><span>${escapeHtml(meta.sub)}</span></div>`;
    }

    function renderTopbar(state) {
      if (state.phase === "choosing") {
        topbar.innerHTML = state.isDrawer
          ? `<span class="dg-topbar-label">🎨 Wähle einen Begriff …</span><span class="dg-timer" data-role="timer">${state.secondsLeft}</span>`
          : `<span class="dg-topbar-label">🎨 ${escapeHtml(state.drawerName)} wählt einen Begriff …</span>`;
      } else if (state.phase === "drawing") {
        const wordDisplay = state.isDrawer
          ? `<span class="dg-word dg-word--own">${escapeHtml(state.word)}</span>`
          : state.myCorrect
            ? `<span class="dg-word dg-word--solved">🎉 ${escapeHtml(state.word)}</span>`
            : `<span class="dg-word-pattern">${escapeHtml(state.wordPattern)}</span>`;
        const label = state.isDrawer ? "🎨 Du zeichnest:" : `🎨 ${escapeHtml(state.drawerName)} zeichnet`;
        topbar.innerHTML = `
          <div class="dg-topbar-row">
            <span class="dg-topbar-label">${label}</span>
            ${wordDisplay}
            <span class="dg-timer" data-role="timer">${state.secondsLeft}</span>
          </div>
          ${specialBanner(state)}
        `;
      } else if (state.phase === "reveal") {
        const r = state.reveal || {};
        topbar.innerHTML = `<span class="dg-topbar-label">Runde ${state.roundIndex} / ${state.totalRounds}</span>`;
      } else if (state.phase === "standings") {
        topbar.innerHTML = `<span class="dg-topbar-label">🏆 Zwischenstand</span>`;
      }
    }

    // ---------------------------------------------------------------------
    // choosing overlay (drawer's 3 word cards)
    // ---------------------------------------------------------------------
    const DIFF_LABEL = { 1: "Leicht", 2: "Mittel", 3: "Schwer" };
    function renderChoosingOverlay(state) {
      if (state.phase !== "choosing") { choosingOverlay.hidden = true; return; }
      choosingOverlay.hidden = false;
      if (!state.isDrawer) {
        choosingOverlay.innerHTML = `<div class="dg-choosing-wait">🎨 ${escapeHtml(state.drawerName)} wählt einen Begriff …</div>`;
        return;
      }
      choosingOverlay.innerHTML = `
        <div class="dg-word-choice">
          <div class="dg-word-choice-title">Wähle deinen Begriff (${state.secondsLeft}s)</div>
          <div class="dg-word-choice-cards">
            ${(state.candidateWords || []).map((w) => `
              <button type="button" class="dg-word-card" data-word-id="${w.id}">
                <span class="dg-word-card-diff dg-word-card-diff--${w.difficulty}">${DIFF_LABEL[w.difficulty]}</span>
                <span class="dg-word-card-text">${escapeHtml(w.word)}</span>
              </button>
            `).join("")}
          </div>
        </div>
      `;
      for (const btn of choosingOverlay.querySelectorAll(".dg-word-card")) {
        btn.addEventListener("click", () => {
          for (const b of choosingOverlay.querySelectorAll(".dg-word-card")) b.disabled = true;
          sendInput({ action: "select_word", word_id: btn.dataset.wordId });
        });
      }
    }

    // ---------------------------------------------------------------------
    // reveal overlay
    // ---------------------------------------------------------------------
    function renderRevealOverlay(state) {
      if (state.phase !== "reveal") { revealOverlay.hidden = true; return; }
      revealOverlay.hidden = false;
      const r = state.reveal;
      if (!r) { revealOverlay.innerHTML = ""; return; }
      const deltas = state.roundPointsDelta || {};
      const rows = (state.players || [])
        .map((p) => ({ ...p, delta: deltas[String(p.userId)] || 0 }))
        .filter((p) => p.delta !== 0 || p.userId === r.drawerUserId)
        .sort((a, b) => b.delta - a.delta);
      const reasonNote = r.reason === "drawer_left" ? `<p class="dg-reveal-note">Zeichner(in) hat das Spiel verlassen - Runde übersprungen.</p>` : "";
      revealOverlay.innerHTML = `
        <div class="dg-reveal-card">
          ${r.word ? `<div class="dg-reveal-label">DER BEGRIFF WAR …</div><div class="dg-reveal-word">${escapeHtml(r.word)}</div>` : ""}
          ${reasonNote}
          <ul class="dg-reveal-points">
            ${rows.map((p) => `<li><span>${escapeHtml(p.name)}${p.userId === r.drawerUserId ? " 🎨" : ""}</span><span>${p.delta > 0 ? "+" : ""}${p.delta}</span></li>`).join("")}
          </ul>
        </div>
      `;
    }

    // ---------------------------------------------------------------------
    // standings (mid-match) / guess feed / guess input
    // ---------------------------------------------------------------------
    function renderStandingsOverlay(state) {
      if (state.phase !== "standings") { revealOverlay.hidden = true; return; }
      revealOverlay.hidden = false;
      const standings = state.standings || [];
      revealOverlay.innerHTML = `
        <div class="dg-reveal-card">
          <div class="dg-reveal-label">🏆 ZWISCHENSTAND</div>
          <ol class="dg-standings-list">
            ${standings.map((s, i) => `<li><span>${i + 1}.</span><span>${escapeHtml(s.name)}</span><span>${s.score}</span></li>`).join("")}
          </ol>
        </div>
      `;
    }

    function renderGuessFeed(state) {
      guessFeed.innerHTML = (state.guessFeed || []).slice().reverse().map((g) => {
        const name = playerName(state, g.userId);
        if (g.correct) return `<div class="dg-guess-row dg-guess-row--correct">✅ ${escapeHtml(name)} hat richtig geraten!</div>`;
        const nearTag = g.near ? ` <span class="dg-guess-near">🔥 Ganz nah!</span>` : "";
        return `<div class="dg-guess-row"><strong>${escapeHtml(name)}:</strong> „${escapeHtml(g.text)}“${nearTag}</div>`;
      }).join("");
    }

    function playerName(state, userId) {
      const p = (state.players || []).find((pl) => pl.userId === userId);
      return p ? p.name : "?";
    }

    guessForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = guessInput.value.trim();
      if (!text) return;
      sendInput({ action: "guess", text });
      guessInput.value = "";
    });

    // ---------------------------------------------------------------------
    // full render dispatch
    // ---------------------------------------------------------------------
    function computeRenderKey(state) {
      return [state.phase, state.roundIndex, state.isDrawer, state.myCorrect].join("|");
    }

    function updatePlayerBar(state) {
      // no dedicated player bar element beyond the topbar's own labels for
      // now - kept intentionally simple/uncluttered per the brief's "keine
      // riesige Chat-&-Games-Navigation während des Zeichnens" spirit.
    }

    function fullRender(state) {
      renderKey = computeRenderKey(state);
      renderTopbar(state);
      renderChoosingOverlay(state);

      const isChoosingOrDrawing = state.phase === "choosing" || state.phase === "drawing";
      if (state.phase === "reveal") renderRevealOverlay(state);
      else if (state.phase === "standings") renderStandingsOverlay(state);
      else revealOverlay.hidden = true;

      const canDrawNow = state.phase === "drawing" && state.isDrawer;
      toolbar.hidden = !canDrawNow;
      canvas.style.pointerEvents = canDrawNow ? "auto" : "none";
      canvas.style.touchAction = canDrawNow ? "none" : "auto";
      if (canDrawNow && !toolbar.dataset.built) { renderToolbar(); toolbar.dataset.built = "1"; }
      renderToolbarStrokeBudget();

      const showGuessArea = state.phase === "drawing" && !state.isDrawer;
      guessArea.hidden = !showGuessArea;
      guessInput.disabled = !showGuessArea || state.myCorrect;
      guessInput.placeholder = state.myCorrect ? "Du hast schon richtig geraten! 🎉" : "Deine Vermutung …";
      if (showGuessArea) renderGuessFeed(state);
      else if (state.phase === "drawing" && state.isDrawer) renderGuessFeed(state);
    }

    function tickUpdate(state) {
      const timerEl = topbar.querySelector('[data-role="timer"]');
      if (timerEl) timerEl.textContent = String(state.secondsLeft);
      const patternEl = topbar.querySelector(".dg-word-pattern");
      if (patternEl && state.wordPattern) patternEl.textContent = state.wordPattern;
      if (state.phase === "choosing" && state.isDrawer) {
        const choiceTimer = choosingOverlay.querySelector(".dg-word-choice-title");
        if (choiceTimer) choiceTimer.textContent = `Wähle deinen Begriff (${state.secondsLeft}s)`;
      }
      renderGuessFeed(state);
      renderToolbarStrokeBudget();
    }

    function setState(state) {
      if (!state || destroyed) return;
      const prevPhase = lastState ? lastState.phase : null;
      lastState = state;
      maybeResync(state);
      if (prevPhase !== "drawing" && state.phase === "drawing") {
        // fresh round of drawing started - the server already cleared its
        // stroke history in _start_round(), mirror that locally too.
        clearStrokes();
      }
      const key = computeRenderKey(state);
      if (key !== renderKey) fullRender(state);
      else tickUpdate(state);
    }

    // ---------------------------------------------------------------------
    // endscreen
    // ---------------------------------------------------------------------
    function renderEndscreen(endscreen) {
      const podium = endscreen.leaderboard.slice(0, 3);
      const rest = endscreen.leaderboard.slice(3);
      const medals = ["🥇", "🥈", "🥉"];
      const fs = endscreen.funStats || {};
      stageEl.innerHTML = `
        <div class="dg-root dg-root--end">
          <div class="dg-endscreen">
            <div class="dg-endscreen-title">🎨 KRITZELMEISTER 🎨</div>
            <ol class="dg-podium-list">
              ${podium.map((p, i) => `
                <li class="dg-podium-entry">
                  <span class="dg-podium-medal">${medals[i]}</span>
                  <span class="dg-podium-name">${escapeHtml(p.name)}</span>
                  <span class="dg-podium-score">${p.score} Punkte</span>
                </li>
              `).join("")}
            </ol>
            ${rest.length ? `
              <ol class="dg-rest-list" start="4">
                ${rest.map((p) => `<li><span>${escapeHtml(p.name)}</span><span>${p.score} Punkte</span></li>`).join("")}
              </ol>
            ` : ""}
            <div class="dg-fun-stats">
              ${["fastest", "artist", "mindReader", "undiscovered", "guessMachine"].map((k) => fs[k] ? `<div class="dg-fun-stat"><strong>${fs[k].label}</strong><span>${escapeHtml(fs[k].name)} — ${escapeHtml(fs[k].detail)}</span></div>` : "").join("")}
            </div>
            <div class="dg-endscreen-actions">
              <button type="button" class="primary-btn" data-role="rematch">NOCH EINE RUNDE</button>
              <button type="button" class="ghost-btn" data-role="leave">SPIEL VERLASSEN</button>
            </div>
          </div>
        </div>
      `;
      const rematchBtn = stageEl.querySelector('[data-role="rematch"]');
      if (rematchBtn) rematchBtn.addEventListener("click", () => sendRematch());
      const leaveBtn = stageEl.querySelector('[data-role="leave"]');
      if (leaveBtn) leaveBtn.addEventListener("click", () => closeGame && closeGame());
    }

    function showGameOver(data) {
      if (data && data.details) {
        renderEndscreen(data.details);
        return;
      }
      stageEl.innerHTML = `
        <div class="dg-root dg-root--end">
          <div class="dg-endscreen">
            <div class="dg-endscreen-title">Spiel beendet</div>
            <p>Die Partie wurde beendet.</p>
            <div class="dg-endscreen-actions">
              <button type="button" class="ghost-btn" data-role="leave">SPIEL VERLASSEN</button>
            </div>
          </div>
        </div>
      `;
      const leaveBtn = stageEl.querySelector('[data-role="leave"]');
      if (leaveBtn) leaveBtn.addEventListener("click", () => closeGame && closeGame());
    }

    function destroy() {
      destroyed = true;
      if (batchTimer) clearInterval(batchTimer);
      if (resizeObserver) resizeObserver.disconnect();
      window.removeEventListener("resize", fitCanvas);
    }

    return {
      setState,
      showGameOver,
      destroy,
      handleDrawingEvent: onDrawingEvent,
      _debugLastState() { return lastState; },
      _debugStrokes() { return strokes; },
    };
  }

  window.KritzelmeisterGame = { mount, openHostOptionsModal };
})();
