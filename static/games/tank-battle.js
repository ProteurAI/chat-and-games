// ============================================================================
// Tank Battle - 2-4 player realtime topdown arena shooter.
//
// Fully server-authoritative, like every other realtime game here (see
// backend/tank_battle.py) - this module only captures input (keyboard/
// mouse on desktop, dual virtual joysticks + fire button on touch) and
// renders whatever `game_state` broadcasts arrive. No client-side physics
// or hit detection at all; the canvas is a pure display of server state,
// consistent with how Pong/Light Cycles already render in this codebase
// (direct per-update redraw, no interpolation - the server's 30Hz tick is
// smooth enough on its own, per the "stable and simple over clever" brief).
//
// window.TankBattle.mount(stageEl, opts) -> { setState(state), destroy() }
// opts: { me, players, sendInput(payload) }
// Win/lose screens reuse the SHARED game-modal overlay (app.js's
// showGameOver) exactly like Pong/Buzzer/etc - no separate endscreen here.
// ============================================================================

(function () {
  "use strict";

  const MOVE_KEYS = { w: "up", a: "left", s: "down", d: "right" };
  const AIM_THROTTLE_MS = 40;
  const MOVE_THROTTLE_MS = 60;
  const FIRE_HOLD_INTERVAL_MS = 150;

  function isTypingTarget() {
    const el = document.activeElement;
    return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
  }

  function setupJoystick(zoneEl, knobEl, maxR, onChange) {
    let active = false, pointerId = null, cx = 0, cy = 0;
    function start(e) {
      if (active) return;
      active = true; pointerId = e.pointerId;
      const rect = zoneEl.getBoundingClientRect();
      cx = rect.left + rect.width / 2; cy = rect.top + rect.height / 2;
      try { zoneEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      // Deliberately NOT calling move(e) here: a touch-down is centered
      // (dx=dy=0) in the overwhelming majority of cases, and routing that
      // through onChange would start the caller's send-throttle clock
      // before the player's first real drag - swallowing it if that drag
      // follows within the throttle window (which it very often does).
      e.preventDefault();
    }
    function move(e) {
      if (!active || e.pointerId !== pointerId) return;
      let dx = e.clientX - cx, dy = e.clientY - cy;
      const dist = Math.hypot(dx, dy);
      if (dist > maxR) { dx = (dx / dist) * maxR; dy = (dy / dist) * maxR; }
      knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
      onChange(dx / maxR, dy / maxR);
      e.preventDefault();
    }
    function end(e) {
      if (e.pointerId !== pointerId) return;
      active = false; pointerId = null;
      knobEl.style.transform = "translate(0,0)";
      onChange(0, 0);
    }
    zoneEl.addEventListener("pointerdown", start);
    zoneEl.addEventListener("pointermove", move);
    zoneEl.addEventListener("pointerup", end);
    zoneEl.addEventListener("pointercancel", end);
    return () => {
      zoneEl.removeEventListener("pointerdown", start);
      zoneEl.removeEventListener("pointermove", move);
      zoneEl.removeEventListener("pointerup", end);
      zoneEl.removeEventListener("pointercancel", end);
    };
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str == null ? "" : String(str);
    return d.innerHTML;
  }

  function mount(stageEl, opts) {
    const { me, sendInput } = opts;
    const myUid = me.id;

    stageEl.innerHTML = `
      <div class="arc-root arc-tank">
        <ul class="arc-hud" data-role="hud"></ul>
        <div class="arc-canvas-wrap">
          <canvas class="arc-canvas" data-role="canvas"></canvas>
          <div class="arc-countdown" data-role="countdown" hidden></div>
          <div class="arc-touch-controls">
            <div class="arc-stick-zone arc-stick-zone--left" data-role="movezone">
              <div class="arc-stick-knob"></div>
            </div>
            <div class="arc-stick-zone arc-stick-zone--right" data-role="aimzone">
              <div class="arc-stick-knob"></div>
            </div>
            <button type="button" class="arc-fire-btn" data-role="fire">FEUER</button>
          </div>
          <p class="arc-hint">WASD bewegen &middot; Maus zielen &middot; Klick schießen</p>
        </div>
      </div>
    `;

    const canvas = stageEl.querySelector('[data-role="canvas"]');
    const ctx = canvas.getContext("2d");
    const hud = stageEl.querySelector('[data-role="hud"]');
    const countdownEl = stageEl.querySelector('[data-role="countdown"]');
    const moveZone = stageEl.querySelector('[data-role="movezone"]');
    const aimZone = stageEl.querySelector('[data-role="aimzone"]');
    const fireBtn = stageEl.querySelector('[data-role="fire"]');

    let lastState = null;
    let worldW = 960, worldH = 640;

    // ---------------- keyboard (desktop) ----------------
    const pressed = new Set();
    function computeMoveFromKeys() {
      const forward = (pressed.has("w") ? 1 : 0) - (pressed.has("s") ? 1 : 0);
      const turn = (pressed.has("d") ? 1 : 0) - (pressed.has("a") ? 1 : 0);
      return { forward, turn };
    }
    function onKeyDown(e) {
      if (isTypingTarget()) return;
      const k = e.key.toLowerCase();
      if (!MOVE_KEYS[k] || pressed.has(k)) return;
      pressed.add(k);
      const m = computeMoveFromKeys();
      sendInput({ action: "move", forward: m.forward, turn: m.turn });
    }
    function onKeyUp(e) {
      const k = e.key.toLowerCase();
      if (!MOVE_KEYS[k] || !pressed.has(k)) return;
      pressed.delete(k);
      const m = computeMoveFromKeys();
      sendInput({ action: "move", forward: m.forward, turn: m.turn });
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // ---------------- mouse aim + fire (desktop) ----------------
    let lastAimSentAt = 0;
    function aimAtWorldPoint(worldX, worldY) {
      const myTank = lastState && lastState.players.find((p) => p.userId === myUid);
      if (!myTank || !myTank.alive) return;
      const now = performance.now();
      if (now - lastAimSentAt < AIM_THROTTLE_MS) return;
      lastAimSentAt = now;
      const angle = Math.atan2(worldY - myTank.y, worldX - myTank.x);
      sendInput({ action: "aim", angle });
    }
    function onMouseMove(e) {
      const rect = canvas.getBoundingClientRect();
      const worldX = ((e.clientX - rect.left) / rect.width) * worldW;
      const worldY = ((e.clientY - rect.top) / rect.height) * worldH;
      aimAtWorldPoint(worldX, worldY);
    }
    function onMouseDown(e) {
      if (e.button !== 0) return;
      sendInput({ action: "shoot" });
    }
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mousedown", onMouseDown);

    // ---------------- touch controls (mobile) ----------------
    let lastMoveSentAt = 0;
    const stopMoveJoystick = setupJoystick(moveZone, moveZone.querySelector(".arc-stick-knob"), 40, (dx, dy) => {
      const now = performance.now();
      if (now - lastMoveSentAt < MOVE_THROTTLE_MS && !(dx === 0 && dy === 0)) return;
      lastMoveSentAt = now;
      sendInput({ action: "move", forward: -dy, turn: dx });
    });
    let lastAimStickAt = 0;
    const stopAimJoystick = setupJoystick(aimZone, aimZone.querySelector(".arc-stick-knob"), 40, (dx, dy) => {
      if (dx === 0 && dy === 0) return; // released - keep last aim direction
      const now = performance.now();
      if (now - lastAimStickAt < AIM_THROTTLE_MS) return;
      lastAimStickAt = now;
      sendInput({ action: "aim", angle: Math.atan2(dy, dx) });
    });
    let fireHoldInterval = null;
    function startFireHold(e) {
      e.preventDefault();
      sendInput({ action: "shoot" });
      if (fireHoldInterval) clearInterval(fireHoldInterval);
      fireHoldInterval = setInterval(() => sendInput({ action: "shoot" }), FIRE_HOLD_INTERVAL_MS);
    }
    function stopFireHold() {
      if (fireHoldInterval) { clearInterval(fireHoldInterval); fireHoldInterval = null; }
    }
    fireBtn.addEventListener("pointerdown", startFireHold);
    fireBtn.addEventListener("pointerup", stopFireHold);
    fireBtn.addEventListener("pointercancel", stopFireHold);
    fireBtn.addEventListener("pointerleave", stopFireHold);

    // ---------------- HUD ----------------
    function renderHud(state) {
      hud.innerHTML = state.players.map((p) => `
        <li class="arc-hud-chip ${p.alive ? "" : "arc-hud-chip--dead"}">
          <span class="arc-hud-dot" style="background:${p.color}"></span>
          <span class="arc-hud-name">${escapeHtml(p.name)}${p.userId === myUid ? " (du)" : ""}</span>
          <span class="arc-hud-lives">${p.alive ? "❤️".repeat(Math.max(0, p.lives)) : "💀"}</span>
        </li>
      `).join("");
    }

    // ---------------- render ----------------
    function drawTank(p) {
      const flashOn = p.hitFlash;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.globalAlpha = p.alive ? (p.invulnerable ? 0.6 : 1) : 0.25;

      if (p.invulnerable && p.alive) {
        ctx.save();
        ctx.strokeStyle = "rgba(124,108,242,0.8)";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.arc(0, 0, 26, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }

      ctx.save();
      ctx.rotate(p.angle);
      ctx.fillStyle = flashOn ? "#ffffff" : p.color;
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(-18, -14, 36, 28, 6) : ctx.rect(-18, -14, 36, 28);
      ctx.fill(); ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.rotate(p.turretAngle);
      ctx.fillStyle = flashOn ? "#ffffff" : "#2b2f3a";
      ctx.fillRect(0, -4, 26, 8);
      ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      ctx.restore();

      if (!p.alive) return;
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.font = "bold 12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(p.name, p.x, p.y - 30);
      ctx.restore();
    }

    function render(state) {
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#20242f";
      ctx.fillRect(0, 0, w, h);

      ctx.fillStyle = "#454b5c";
      for (const [x1, y1, x2, y2] of state.walls) {
        ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      }

      for (const pr of state.projectiles) {
        ctx.save();
        ctx.fillStyle = "#ffcf5c";
        ctx.shadowColor = "#ffcf5c";
        ctx.shadowBlur = 6;
        ctx.beginPath(); ctx.arc(pr.x, pr.y, 5, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }

      for (const p of state.players) drawTank(p);

      if (state.phase === "countdown") {
        countdownEl.hidden = false;
        countdownEl.textContent = state.countdownSecondsLeft > 0 ? String(state.countdownSecondsLeft) : "LOS!";
      } else {
        countdownEl.hidden = true;
      }
    }

    function setState(state) {
      lastState = state;
      worldW = state.world.width; worldH = state.world.height;
      if (canvas.width !== worldW || canvas.height !== worldH) {
        canvas.width = worldW; canvas.height = worldH;
      }
      renderHud(state);
      render(state);
    }

    function destroy() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mousedown", onMouseDown);
      stopMoveJoystick();
      stopAimJoystick();
      stopFireHold();
      fireBtn.removeEventListener("pointerdown", startFireHold);
      fireBtn.removeEventListener("pointerup", stopFireHold);
      fireBtn.removeEventListener("pointercancel", stopFireHold);
      fireBtn.removeEventListener("pointerleave", stopFireHold);
    }

    return {
      setState,
      destroy,
      // Read-only introspection for automated testing (mirrors TimLiner's
      // _debugState()/EstimateGame's _debugLastState()) - not used by the
      // UI itself.
      _debugLastState() { return lastState; },
      _debugSendInput(payload) { sendInput(payload); },
    };
  }

  window.TankBattle = { mount };
})();
