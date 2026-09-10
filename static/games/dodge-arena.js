// ============================================================================
// Dodge Arena - 2-8 player realtime last-one-standing dodging game.
//
// Same server-authoritative model as Tank Battle (see that file's header
// comment) but much simpler input: just a movement direction, no aiming
// or shooting. Eliminated players stay mounted and keep receiving state
// updates (they're never removed from the session) so they can spectate
// the rest of the round instead of staring at a dead screen.
//
// window.DodgeArena.mount(stageEl, opts) -> { setState(state), destroy() }
// ============================================================================

(function () {
  "use strict";

  const MOVE_KEYS = { w: "up", a: "left", s: "down", d: "right" };
  const MOVE_THROTTLE_MS = 50;

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
      // Deliberately NOT calling move(e) here - see tank-battle.js's
      // identical setupJoystick for why (avoids starting the caller's
      // send-throttle clock before the player's first real drag).
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
      <div class="arc-root arc-dodge">
        <div class="arc-dodge-status">
          <span data-role="alivecount"></span>
          <span class="arc-dodge-outmsg" data-role="outmsg" hidden>Du bist raus - schau weiter zu!</span>
        </div>
        <ul class="arc-hud arc-hud--dodge" data-role="hud"></ul>
        <div class="arc-canvas-wrap">
          <canvas class="arc-canvas" data-role="canvas"></canvas>
          <div class="arc-countdown" data-role="countdown" hidden></div>
          <div class="arc-final-banner" data-role="finalbanner" hidden></div>
          <div class="arc-touch-controls arc-touch-controls--dodge">
            <div class="arc-stick-zone arc-stick-zone--left" data-role="movezone">
              <div class="arc-stick-knob"></div>
            </div>
          </div>
          <p class="arc-hint">WASD ausweichen - nicht getroffen werden!</p>
        </div>
      </div>
    `;

    const canvas = stageEl.querySelector('[data-role="canvas"]');
    const ctx = canvas.getContext("2d");
    const hud = stageEl.querySelector('[data-role="hud"]');
    const countdownEl = stageEl.querySelector('[data-role="countdown"]');
    const finalBanner = stageEl.querySelector('[data-role="finalbanner"]');
    const aliveCountEl = stageEl.querySelector('[data-role="alivecount"]');
    const outMsgEl = stageEl.querySelector('[data-role="outmsg"]');
    const moveZone = stageEl.querySelector('[data-role="movezone"]');

    let worldSize = 800;
    let iWasAlive = true;

    // ---------------- keyboard ----------------
    const pressed = new Set();
    function computeDir() {
      const dx = (pressed.has("d") ? 1 : 0) - (pressed.has("a") ? 1 : 0);
      const dy = (pressed.has("s") ? 1 : 0) - (pressed.has("w") ? 1 : 0);
      return { dx, dy };
    }
    function onKeyDown(e) {
      if (isTypingTarget()) return;
      const k = e.key.toLowerCase();
      if (!MOVE_KEYS[k] || pressed.has(k)) return;
      pressed.add(k);
      const { dx, dy } = computeDir();
      sendInput({ action: "move", dx, dy });
    }
    function onKeyUp(e) {
      const k = e.key.toLowerCase();
      if (!MOVE_KEYS[k] || !pressed.has(k)) return;
      pressed.delete(k);
      const { dx, dy } = computeDir();
      sendInput({ action: "move", dx, dy });
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // ---------------- touch joystick ----------------
    let lastMoveSentAt = 0;
    const stopMoveJoystick = setupJoystick(moveZone, moveZone.querySelector(".arc-stick-knob"), 40, (dx, dy) => {
      const now = performance.now();
      if (now - lastMoveSentAt < MOVE_THROTTLE_MS && !(dx === 0 && dy === 0)) return;
      lastMoveSentAt = now;
      sendInput({ action: "move", dx, dy });
    });

    // ---------------- HUD ----------------
    function renderHud(state) {
      hud.innerHTML = state.players.map((p) => `
        <li class="arc-hud-chip ${p.alive ? "" : "arc-hud-chip--dead"}">
          <span class="arc-hud-dot" style="background:${p.color}"></span>
          <span class="arc-hud-name">${escapeHtml(p.name)}${p.userId === myUid ? " (du)" : ""}</span>
          <span class="arc-hud-status">${p.alive ? "" : "❌"}</span>
        </li>
      `).join("");
      aliveCountEl.textContent = `${state.aliveCount} / ${state.players.length} übrig`;

      const me_ = state.players.find((p) => p.userId === myUid);
      if (me_ && !me_.alive) {
        outMsgEl.hidden = false;
        iWasAlive = false;
      } else {
        outMsgEl.hidden = true;
      }

      if (state.phase === "playing" && state.aliveCount === 2) {
        finalBanner.hidden = false;
        finalBanner.textContent = "🔥 FINALE 2!";
      } else {
        finalBanner.hidden = true;
      }
    }

    // ---------------- render ----------------
    function render(state) {
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#1c2030";
      ctx.fillRect(0, 0, w, h);

      ctx.fillStyle = "#454b5c";
      for (const [x1, y1, x2, y2] of state.walls) {
        ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      }

      // Drawn as a spiky "mine" (not a plain circle) so a hazard is never
      // mistaken for a player token even when a player's color happens to
      // be reddish too - shape, not just color, marks it as dangerous.
      for (const ball of state.balls) {
        ctx.save();
        ctx.translate(ball.x, ball.y);
        ctx.shadowColor = "#ff2d2d";
        ctx.shadowBlur = 14;
        ctx.fillStyle = "#ff2d2d";
        ctx.beginPath();
        const spikes = 8, rOuter = 15, rInner = 9;
        for (let i = 0; i < spikes * 2; i++) {
          const r = i % 2 === 0 ? rOuter : rInner;
          const a = (Math.PI / spikes) * i;
          const px = Math.cos(a) * r, py = Math.sin(a) * r;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = "#3a0a0a";
        ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }

      for (const p of state.players) {
        ctx.save();
        ctx.globalAlpha = p.alive ? 1 : 0.2;
        ctx.translate(p.x, p.y);
        if (p.invulnerable && p.alive) {
          ctx.strokeStyle = "rgba(124,108,242,0.8)";
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 4]);
          ctx.beginPath(); ctx.arc(0, 0, 22, 0, Math.PI * 2); ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.fillStyle = p.color;
        ctx.strokeStyle = "rgba(0,0,0,0.35)";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, 16, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.restore();

        if (p.alive) {
          ctx.save();
          ctx.fillStyle = "rgba(0,0,0,0.55)";
          ctx.font = "bold 12px system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(p.name, p.x, p.y - 26);
          ctx.restore();
        }
      }

      if (state.phase === "countdown") {
        countdownEl.hidden = false;
        countdownEl.textContent = state.countdownSecondsLeft > 0 ? String(state.countdownSecondsLeft) : "LOS!";
      } else {
        countdownEl.hidden = true;
      }
    }

    let lastState = null;
    function setState(state) {
      lastState = state;
      worldSize = state.world.size;
      if (canvas.width !== worldSize || canvas.height !== worldSize) {
        canvas.width = worldSize; canvas.height = worldSize;
      }
      renderHud(state);
      render(state);
    }

    function destroy() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      stopMoveJoystick();
    }

    return {
      setState,
      destroy,
      _debugLastState() { return lastState; },
      _debugSendInput(payload) { sendInput(payload); },
    };
  }

  window.DodgeArena = { mount };
})();
