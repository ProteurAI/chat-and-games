// ============================================================================
// MultiScreen Snake - renderer + input for ONE screen of the shared table.
// The server (backend/multiscreen/snake.py) owns the snake; this draws the
// part of it that lies on this phone (the engine already set up the world
// transform and clipping - everything here is in world units) and forwards
// swipes. Between snapshots (15/s) the head is extrapolated along its
// direction for at most ~120ms so motion is smooth; the next snapshot wins.
// ============================================================================
(function () {
  "use strict";

  const G = window.MSGeometry;
  const ENTRY_SIDE = { right: "left", left: "right", up: "bottom", down: "top" };

  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }

  function create(api) {
    let gs = null, recv = 0;
    let lastSeq = null;
    const effects = [];           // {kind, x, y, born}
    let controlBannerAt = -10, speedBannerAt = -10, goAt = -10, lastCount = null;
    let ui = null;

    function me() { return api.myDeviceId(); }

    function onState(state, recvT) {
      gs = state;
      recv = recvT;
      const now = performance.now() / 1000;
      const events = state.events || [];
      if (lastSeq == null) { lastSeq = events.length ? events[events.length - 1].seq : 0; return; }
      for (const ev of events) {
        if (ev.seq <= lastSeq) continue;
        lastSeq = ev.seq;
        if (ev.type === "handoff" && ev.to === me()) {
          controlBannerAt = now;
          api.sound.handoff();
          api.vibrate(35);
        } else if (ev.type === "prepare" && ev.deviceId === me()) {
          api.sound.prepare();
          api.vibrate(10);
        } else if (ev.type === "food") {
          effects.push({ kind: "food", x: ev.x, y: ev.y, born: now });
          if (state.activeDeviceId === me()) api.sound.food();
        } else if (ev.type === "crash") {
          effects.push({ kind: "crash", x: ev.x, y: ev.y, born: now });
          api.sound.crash();
          api.vibrate(state.activeDeviceId === me() ? [90, 40, 90] : 30);
        } else if (ev.type === "speed_up") {
          speedBannerAt = now;
        } else if (ev.type === "go") {
          goAt = now;
          lastCount = null;
          api.sound.go();
        } else if (ev.type === "game_over") {
          api.sound.over();
        }
      }
      while (effects.length > 12) effects.shift();
    }

    // ---- snake path, extrapolated to "now" ----
    function currentPath(now) {
      const path = gs.snake.path.map((p) => [p[0], p[1]]);
      if (path.length < 2) return path;
      const moving = gs.phase === "playing" && !gs.paused;
      const adv = moving ? Math.min(Math.max(0, now - recv), 0.12) * gs.snake.speed : 0;
      if (adv <= 0) return path;
      const d = G.DIRS[gs.snake.dir];
      path[0] = [path[0][0] + d[0] * adv, path[0][1] + d[1] * adv];
      // shorten the tail by the same amount
      let cut = adv;
      while (cut > 0 && path.length >= 2) {
        const a = path[path.length - 1], b = path[path.length - 2];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L > cut) { const k = cut / L; path[path.length - 1] = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]; break; }
        cut -= L;
        path.pop();
      }
      return path;
    }

    function draw(ctx, view, now) {
      if (!gs) return;
      const dpr = view.dpr;
      const state = api.state();
      // intro: one light wave sweeping across the whole table
      if (gs.phase === "intro" && state) {
        const b = state.layout.bounds;
        const p = Math.min(1, (gs.phaseElapsed + (gs.paused ? 0 : now - recv)) / (gs.phaseDuration || 1.8));
        const span = b[2] - b[0] + 120;
        const x = b[0] - 60 + span * p;
        const grad = ctx.createLinearGradient(x - 45, 0, x + 45, 0);
        grad.addColorStop(0, "rgba(140,255,210,0)");
        grad.addColorStop(0.5, "rgba(170,255,225,0.55)");
        grad.addColorStop(1, "rgba(140,255,210,0)");
        ctx.fillStyle = grad;
        ctx.fillRect(x - 45, b[1] - 10, 90, b[3] - b[1] + 20);
        return;
      }
      // food: a glowing energy fruit
      if (gs.food) {
        const f = gs.food;
        const pulse = 1 + Math.sin(now * 5) * 0.08;
        const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, 9 * pulse);
        g.addColorStop(0, "rgba(255,200,120,0.55)");
        g.addColorStop(1, "rgba(255,160,80,0)");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(f.x, f.y, 9 * pulse, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#ffb755";
        ctx.beginPath(); ctx.arc(f.x, f.y, 3.4 * pulse, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.beginPath(); ctx.arc(f.x - 1.1, f.y - 1.1, 1, 0, Math.PI * 2); ctx.fill();
      }
      // snake
      const path = currentPath(now);
      if (path.length >= 2) {
        const r = gs.snake.radius;
        const crashed = gs.phase === "crashed";
        const blink = gs.phase === "respawn" && Math.floor(now * 6) % 2 === 0;
        const head = path[0], tail = path[path.length - 1];
        const grad = ctx.createLinearGradient(head[0], head[1], tail[0], tail[1]);
        grad.addColorStop(0, crashed ? "#ffb4a8" : "#d9ffe8");
        grad.addColorStop(1, crashed ? "#b0443a" : "#2fae7b");
        ctx.save();
        ctx.globalAlpha = blink ? 0.45 : 1;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.shadowColor = crashed ? "rgba(255,90,80,0.5)" : "rgba(120,255,190,0.35)";
        ctx.shadowBlur = 10 * dpr;
        ctx.strokeStyle = grad;
        ctx.lineWidth = r * 2;
        ctx.beginPath();
        ctx.moveTo(head[0], head[1]);
        for (let i = 1; i < path.length; i++) ctx.lineTo(path[i][0], path[i][1]);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = crashed ? "#ffd0c8" : "#effff5";
        ctx.beginPath(); ctx.arc(head[0], head[1], r * 1.08, 0, Math.PI * 2); ctx.fill();
        const d = G.DIRS[gs.snake.dir];
        const px = -d[1], py = d[0];
        ctx.fillStyle = "#0d2a1e";
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.arc(head[0] + d[0] * r * 0.35 + px * s * r * 0.45, head[1] + d[1] * r * 0.35 + py * s * r * 0.45, r * 0.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      // effects
      for (let i = effects.length - 1; i >= 0; i--) {
        const e = effects[i];
        const age = now - e.born;
        const life = e.kind === "crash" ? 0.9 : 0.5;
        if (age > life) { effects.splice(i, 1); continue; }
        const k = age / life;
        ctx.save();
        ctx.strokeStyle = e.kind === "crash" ? `rgba(255,90,80,${1 - k})` : `rgba(255,210,140,${1 - k})`;
        ctx.lineWidth = e.kind === "crash" ? 2 : 1.4;
        ctx.beginPath(); ctx.arc(e.x, e.y, 4 + k * (e.kind === "crash" ? 30 : 16), 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    }

    // ---- DOM overlays in this screen's own orientation ----
    function uiLayer(stageUi) {
      if (!ui || !ui.isConnected) {
        ui = document.createElement("div");
        ui.className = "ms-snake-ui";
        ui.innerHTML = `<div class="ms-hud" data-role="hud"></div><div class="ms-center" data-role="center"></div>
          <div class="ms-prepare" data-role="prepare" hidden></div><div class="ms-results-wrap" data-role="results"></div>`;
        stageUi.appendChild(ui);
      }
      return ui;
    }
    function setHtml(el, html) { if (el._html !== html) { el._html = html; el.innerHTML = html; } }

    function uiUpdate(stageUi, view, now) {
      if (!gs) return;
      const layer = uiLayer(stageUi);
      const active = gs.activeDeviceId === me();
      const target = gs.handoffTargetDeviceId === me();
      const stageEl = stageUi.parentElement;
      stageEl.classList.toggle("ms-stage--active", active && ["playing", "countdown", "respawn"].includes(gs.phase) && !gs.paused);
      stageEl.classList.toggle("ms-stage--prepare", target && !gs.paused);

      const hearts = "♥".repeat(Math.max(0, gs.lives)) + "<span class=\"ms-hud-lost\">" + "♥".repeat(Math.max(0, gs.maxLives - gs.lives)) + "</span>";
      setHtml(layer.querySelector('[data-role="hud"]'), gs.phase === "intro" ? "" : `<span class="ms-hud-score">${gs.score}</span><span class="ms-hud-lives">${hearts}</span>`);

      // center: synchronized countdown on every screen, short control banner
      let center = "";
      const quiet = !!gs.paused || !!gs.stats;   // pause card / results own the screen
      const elapsed = gs.phaseElapsed + (gs.paused ? 0 : now - recv);
      if (gs.phase === "countdown") {
        const n = Math.max(1, Math.ceil((gs.phaseDuration || 3) - elapsed));
        if (n !== lastCount) { lastCount = n; api.sound.tick(); }
        center = `<div class="ms-count">${n}</div>`;
      } else if (gs.phase === "playing" && now - goAt < 0.7) {
        center = `<div class="ms-count ms-count--go">GO!</div>`;
      } else if (gs.phase === "crashed" && !gs.stats) {
        center = `<div class="ms-banner ms-banner--crash">${gs.lives > 0 ? `💥 Leben verloren – noch ${gs.lives}` : "💥"}</div>`;
      } else if (gs.phase === "respawn") {
        center = `<div class="ms-banner">Bereit …</div>`;
      }
      if (!center && !quiet && active && (now - controlBannerAt < 1.1 || (now - goAt >= 0.7 && now - goAt < 1.8)) && gs.phase === "playing") center = `<div class="ms-banner ms-banner--you">DU STEUERST 🐍</div>`;
      if (!center && !quiet && now - speedBannerAt < 1.0) center = `<div class="ms-banner ms-banner--speed">SPEED UP!</div>`;
      setHtml(layer.querySelector('[data-role="center"]'), center);

      // "get ready" pill at the edge of THIS screen the snake will come in through
      const prep = layer.querySelector('[data-role="prepare"]');
      const tile = api.myTile();
      if (target && tile && gs.phase === "playing" && !gs.paused) {
        const side = G.worldSideToLocalSide(tile.rotation, ENTRY_SIDE[gs.snake.dir]);
        prep.hidden = false;
        prep.className = `ms-prepare ms-prepare--${side}`;
        setHtml(prep, `🐍 → DEIN DISPLAY · BEREIT MACHEN${gs.bufferedFor === me() ? " ✓" : ""}`);
      } else {
        prep.hidden = true;
      }

      const res = layer.querySelector('[data-role="results"]');
      if (gs.stats) setHtml(res, resultsHtml(gs.stats)); else setHtml(res, "");
      if (gs.stats && !res._bound) {
        res._bound = true;
        res.addEventListener("click", (e) => {
          const b = e.target.closest("[data-act]");
          if (!b) return;
          const a = b.dataset.act;
          if (a === "restart" || a === "back_to_setup") api.hostAction(a);
          else if (a === "close") api.closeSession();
          else if (a === "chat") api.minimize && api.minimize();
          else if (a === "leave") api.leave();
        });
      }
      if (!gs.stats) res._bound = false;
    }

    function resultsHtml(st) {
      const fun = [];
      if (st.topController) fun.push(`<div class="ms-fun"><span>🐍 MEIST AM STEUER</span><b>${esc(api.nameOf(st.topController.deviceId))}</b><small>${st.topController.seconds.toFixed(0)} Sekunden</small></div>`);
      if (st.fastestReaction) fun.push(`<div class="ms-fun"><span>⚡ SCHNELLREAKTION</span><b>${esc(api.nameOf(st.fastestReaction.deviceId))}</b><small>${st.fastestReaction.seconds.toFixed(2)} s nach der Übergabe</small></div>`);
      if (st.crossings) fun.push(`<div class="ms-fun"><span>🌍 WELTENBUMMLER</span><b>${st.crossings}</b><small>Bildschirmwechsel</small></div>`);
      if (st.foods) fun.push(`<div class="ms-fun"><span>🥕 SAMMLER</span><b>${st.foods}</b><small>Foods</small></div>`);
      if (st.closestSave && st.closestSave.distance < 9) fun.push(`<div class="ms-fun"><span>😮‍💨 KNAPPSTE RETTUNG</span><b>${esc(api.nameOf(st.closestSave.deviceId))}</b><small>${st.closestSave.distance.toFixed(0)} mm vor dem Aus</small></div>`);
      const host = api.isHost();
      const control = Object.entries(st.control || {}).filter(([, s]) => s >= 0.5).sort((a, b) => b[1] - a[1])
        .map(([id, s]) => `${esc(api.nameOf(id))} <b>${Math.round(s)}s</b>`).join(" · ");
      return `<div class="ms-results">
        <div class="ms-results-title">GAME OVER</div>
        <div class="ms-results-score">${st.score}<small>gemeinsame Punkte</small></div>
        <div class="ms-results-stats">
          <span>Länge <b>${st.maxLengthCells}</b></span><span>Längste Kette <b>${st.chainBest}</b></span><span>Zeit <b>${Math.round(st.playTime)}s</b></span>
        </div>
        <div class="ms-fun-list">${fun.join("")}</div>
        ${control ? `<div class="ms-results-control">Am Steuer: ${control}</div>` : ""}
        <div class="ms-results-actions">
          ${host ? `<button type="button" class="primary-btn" data-act="restart">🔁 NOCHMAL</button><button type="button" class="ghost-btn" data-act="back_to_setup">✎ HANDYS NEU ANORDNEN</button><button type="button" class="ghost-btn" data-act="close">BEENDEN</button>` : `<span class="ms-results-wait">Der Host entscheidet, wie es weitergeht.</span>`}
          <button type="button" class="ghost-btn" data-act="chat">💬 ZUM CHAT</button>
          ${host ? "" : `<button type="button" class="ghost-btn" data-act="leave">VERLASSEN</button>`}
        </div>
      </div>`;
    }

    function onInputDir(dir) {
      if (!gs || gs.paused) return;
      const who = me();
      if (gs.activeDeviceId !== who && gs.handoffTargetDeviceId !== who) return;
      api.sendInput({ dir });
    }

    function destroy() {
      if (ui) ui.remove();
      ui = null;
    }

    return { onState, draw, ui: uiUpdate, onInputDir, destroy };
  }

  window.MultiScreenGames = window.MultiScreenGames || {};
  window.MultiScreenGames.snake = { create };
})();
