// ============================================================================
// Mehrheitsmeister - multiplayer "guess what the group will vote for" party
// game for Chat & Games.
//
// Fully server-authoritative, same pattern as know-me.js/who-am-i.js: the
// round plan, vote tallying, majority/unanimous/outsider logic, streaks and
// all scoring come from the backend engine (backend/majority_game.py) via
// the existing game_state/game_over websocket events - this module only
// renders what it's given and sends {action:"submit_vote", value} through
// the same game_input channel every other multiplayer game uses.
//
// SECURITY NOTE: during voting, this module's state never contains any
// vote counts or other players' choices - only submissionStatus booleans
// and the viewer's own vote. Reveal is the one point everything about that
// round becomes public at once - see majority_game.py's public_state().
//
// window.MajorityGame.mount(stageEl, opts) -> { setState(state), showGameOver(data), destroy() }
// window.MajorityGame.openHostOptionsModal(onConfirm)
// ============================================================================

(function () {
  "use strict";

  const MODE_META = {
    classic: { label: "CLASSIC", emoji: "👑", cls: "mg-mode--classic" },
    fifty: { label: "50/50", emoji: "⚡", cls: "mg-mode--fifty" },
    unanimous: { label: "EINSTIMMIG", emoji: "🔥", cls: "mg-mode--unanimous" },
    outsider: { label: "AUSSENSEITER", emoji: "🎭", cls: "mg-mode--outsider" },
  };

  const SOUND_KEY = "majority_sound_enabled";
  function soundEnabled() {
    try { return localStorage.getItem(SOUND_KEY) !== "0"; } catch (e) { return true; }
  }
  function setSoundEnabled(v) {
    try { localStorage.setItem(SOUND_KEY, v ? "1" : "0"); } catch (e) { /* ignore */ }
  }
  let audioCtx = null;
  function beep(freq, dur, type, gain) {
    if (!soundEnabled()) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.type = type || "sine";
      osc.frequency.value = freq;
      g.gain.value = gain != null ? gain : 0.05;
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
      osc.connect(g); g.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + dur);
    } catch (e) { /* best-effort only */ }
  }
  const sfx = {
    submitted: () => beep(480, 0.1, "sine", 0.045),
    reveal: () => beep(600, 0.15, "sine", 0.05),
    unanimous: () => { beep(660, 0.12, "sine", 0.06); setTimeout(() => beep(880, 0.15, "sine", 0.06), 100); setTimeout(() => beep(1046, 0.2, "sine", 0.06), 200); },
    winner: () => { beep(523, 0.12, "sine", 0.06); setTimeout(() => beep(659, 0.12, "sine", 0.06), 120); setTimeout(() => beep(784, 0.22, "sine", 0.06), 240); },
  };
  function haptic(pattern) {
    if (window.MobileUX && typeof window.MobileUX.vibrate === "function") window.MobileUX.vibrate(pattern);
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str == null ? "" : String(str);
    return d.innerHTML;
  }

  // ---------------------------------------------------------------------
  // Host pre-create options modal (rounds / question mood)
  // ---------------------------------------------------------------------
  function openHostOptionsModal(onConfirm) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal mg-options-modal">
        <div class="modal-head">
          <h2>👑 Mehrheitsmeister erstellen</h2>
          <button type="button" class="icon-btn" data-role="close">✕</button>
        </div>
        <div class="mg-options-body">
          <div class="mg-options-group">
            <div class="mg-options-label">Runden</div>
            <div class="mg-options-chips" data-role="rounds">
              <button type="button" class="mg-chip" data-value="5">5</button>
              <button type="button" class="mg-chip mg-chip--active" data-value="10">10</button>
              <button type="button" class="mg-chip" data-value="15">15</button>
              <button type="button" class="mg-chip" data-value="20">20</button>
            </div>
          </div>
          <div class="mg-options-group">
            <div class="mg-options-label">Fragenstimmung</div>
            <div class="mg-options-chips" data-role="tone">
              <button type="button" class="mg-chip" data-value="casual">🙂 Locker</button>
              <button type="button" class="mg-chip" data-value="funny">😂 Lustig</button>
              <button type="button" class="mg-chip" data-value="spicy">🌶 Frech</button>
              <button type="button" class="mg-chip mg-chip--active" data-value="mixed">🎲 Gemischt</button>
            </div>
          </div>
        </div>
        <div class="mg-options-actions">
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

    for (const group of overlay.querySelectorAll(".mg-options-chips")) {
      group.addEventListener("click", (e) => {
        const btn = e.target.closest(".mg-chip");
        if (!btn) return;
        for (const c of group.querySelectorAll(".mg-chip")) c.classList.remove("mg-chip--active");
        btn.classList.add("mg-chip--active");
      });
    }

    overlay.querySelector('[data-role="confirm"]').addEventListener("click", () => {
      const rounds = parseInt(overlay.querySelector('[data-role="rounds"] .mg-chip--active').dataset.value, 10);
      const tone = overlay.querySelector('[data-role="tone"] .mg-chip--active').dataset.value;
      close();
      onConfirm({ rounds, tone });
    });
  }

  const ANSWER_EMOJI_FALLBACK = ["🅰️", "🅱️", "🅲", "🅳", "🅴"];

  // ---------------------------------------------------------------------
  // Main module
  // ---------------------------------------------------------------------
  function mount(stageEl, opts) {
    const { me, players, sendInput, sendRematch, isHost } = opts;

    stageEl.innerHTML = `
      <div class="mg-root">
        <div class="mg-topbar">
          <span class="mg-brand">👑 Mehrheitsmeister</span>
          <span class="mg-round-info" data-role="round-info"></span>
          <button type="button" class="icon-btn mg-sound-toggle" title="Sound an/aus" aria-label="Sound an/aus">${soundEnabled() ? "🔊" : "🔇"}</button>
        </div>
        <div class="mg-stage"></div>
      </div>
    `;
    const stage = stageEl.querySelector(".mg-stage");
    const roundInfo = stageEl.querySelector('[data-role="round-info"]');
    const soundBtn = stageEl.querySelector(".mg-sound-toggle");
    soundBtn.addEventListener("click", () => {
      setSoundEnabled(!soundEnabled());
      soundBtn.textContent = soundEnabled() ? "🔊" : "🔇";
    });

    let lastState = null;
    let renderKey = null;

    function playerName(uid) {
      const p = lastState && lastState.players.find((pl) => pl.userId === uid);
      return p ? p.name : "?";
    }

    function myStreak() {
      const self = lastState && lastState.players.find((p) => p.userId === me.id);
      return self ? self.streak : 0;
    }

    function computeRenderKey(state) {
      const submittedFlag = state.phase === "voting" ? (state.mySubmitted ? "done" : "open") : "";
      return [state.phase, state.roundIndex, state.roundType, submittedFlag].join("|");
    }

    function renderModeBanner(state) {
      const meta = MODE_META[state.roundType] || MODE_META.classic;
      const extra = state.roundType === "outsider" ? `<div class="mg-mode-sub">Diesmal gewinnt NICHT die Mehrheit!</div>` : "";
      return `
        <div class="mg-mode-banner ${meta.cls}">
          <span class="mg-mode-emoji">${meta.emoji}</span>
          <span class="mg-mode-label">${meta.label}</span>
        </div>
        ${extra}
      `;
    }

    function renderStreakChip() {
      const streak = myStreak();
      if (streak < 2) return "";
      return `<div class="mg-streak-chip">🔥 ${streak}er-Serie</div>`;
    }

    function renderVotingArea(state) {
      if (state.mySubmitted) {
        const eligible = Object.keys(state.submissionStatus || {});
        return `
          <div class="mg-question-card mg-question-card--waiting">
            <p class="mg-question-text">${escapeHtml(state.question)}</p>
            <p class="mg-waiting-text">✓ Deine Antwort wurde gespeichert.</p>
            <ul class="mg-status-list">
              ${eligible.map((u) => `<li>${escapeHtml(playerName(parseInt(u, 10)))} ${state.submissionStatus[u] ? "✓" : "…"}</li>`).join("")}
            </ul>
            <div class="mg-turn-meta"><span data-role="timer">${state.secondsLeft}</span>s</div>
          </div>
        `;
      }
      return `
        <div class="mg-question-card">
          <p class="mg-question-text">${escapeHtml(state.question)}</p>
          <div class="mg-answer-cards" data-role="answer-cards">
            ${state.answers.map((a, i) => `<button type="button" class="mg-answer-card" data-index="${i}">${escapeHtml(a)}</button>`).join("")}
          </div>
          <div class="mg-turn-meta"><span data-role="timer">${state.secondsLeft}</span>s</div>
        </div>
      `;
    }

    function renderRevealArea(state) {
      const rr = state.roundResult;
      if (!rr) return `<div class="mg-question-card"><p class="mg-waiting-text">Auswertung läuft …</p></div>`;

      const maxCount = Math.max(1, ...rr.counts);
      const bars = rr.answers.map((a, i) => ({
        label: a, count: rr.counts[i] || 0, isWinner: rr.winningIndices.includes(i),
      })).sort((a, b) => b.count - a.count);

      const unanimousBanner = rr.unanimousHit
        ? `<div class="mg-unanimous-banner">🔥 EINSTIMMIG! 🔥</div>`
        : "";

      const myResult = (rr.results || []).find((r) => r.userId === me.id);
      const myPointsLine = myResult && myResult.submitted
        ? (myResult.points > 0
            ? `<div class="mg-my-points mg-my-points--win">+${myResult.points}${myResult.streakBonus ? ` <small>(inkl. +${myResult.streakBonus} Serie)</small>` : ""}</div>`
            : `<div class="mg-my-points">Daneben</div>`)
        : `<div class="mg-my-points">Keine Antwort abgegeben</div>`;

      const winners = (rr.results || []).filter((r) => r.won).map((r) => playerName(r.userId));
      const losers = (rr.results || []).filter((r) => r.submitted && !r.won).map((r) => playerName(r.userId));

      return `
        <div class="mg-question-card mg-reveal-card">
          <p class="mg-question-text">${escapeHtml(rr.question)}</p>
          ${unanimousBanner}
          <div class="mg-bar-chart">
            ${bars.map((b) => `
              <div class="mg-bar-row ${b.isWinner ? "mg-bar-row--winner" : ""}">
                <span class="mg-bar-name">${b.isWinner ? "👑 " : ""}${escapeHtml(b.label)}</span>
                <div class="mg-bar-track"><div class="mg-bar-fill" style="width:${(b.count / maxCount) * 100}%"></div></div>
                <span class="mg-bar-count">${b.count}</span>
              </div>
            `).join("")}
          </div>
          ${myPointsLine}
          ${winners.length ? `<div class="mg-result-line mg-result-line--win"><strong>RICHTIG:</strong> ${winners.map(escapeHtml).join(", ")}</div>` : ""}
          ${losers.length ? `<div class="mg-result-line mg-result-line--lose"><strong>DANEBEN:</strong> ${losers.map(escapeHtml).join(", ")}</div>` : ""}
        </div>
      `;
    }

    function renderStandingsArea(state) {
      const standings = state.standings || [];
      return `
        <div class="mg-question-card">
          <div class="mg-standings-title">📊 ZWISCHENSTAND</div>
          <ol class="mg-standings-list">
            ${standings.map((s, i) => `<li><span>${i + 1}.</span><span>${escapeHtml(s.name)}</span><span>${s.score}</span></li>`).join("")}
          </ol>
        </div>
      `;
    }

    function fullRender(state) {
      renderKey = computeRenderKey(state);
      let content = "";
      if (state.phase === "voting") content = renderVotingArea(state);
      else if (state.phase === "reveal") {
        content = renderRevealArea(state);
        sfx.reveal();
        if (state.roundResult && state.roundResult.unanimousHit) { setTimeout(() => sfx.unanimous(), 150); haptic([20, 30, 20, 30, 20]); }
      } else if (state.phase === "standings") content = renderStandingsArea(state);

      const showModeBanner = state.phase === "voting";
      stage.innerHTML = `
        ${showModeBanner ? renderModeBanner(state) : ""}
        ${showModeBanner ? renderStreakChip() : ""}
        ${content}
      `;
      roundInfo.textContent = `Runde ${state.roundIndex} / ${state.totalRounds}`;

      for (const btn of stage.querySelectorAll(".mg-answer-card")) {
        btn.addEventListener("click", () => {
          const idx = parseInt(btn.dataset.index, 10);
          for (const b of stage.querySelectorAll(".mg-answer-card")) b.disabled = true;
          btn.classList.add("mg-answer-card--picked");
          sendInput({ action: "submit_vote", value: idx });
          sfx.submitted();
          haptic(15);
        });
      }
    }

    function updateTickOnly(state) {
      const timerEls = stage.querySelectorAll('[data-role="timer"]');
      for (const t of timerEls) t.textContent = String(state.secondsLeft);
      const list = stage.querySelector(".mg-status-list");
      if (list && state.submissionStatus) {
        list.innerHTML = Object.keys(state.submissionStatus).map((u) =>
          `<li>${escapeHtml(playerName(parseInt(u, 10)))} ${state.submissionStatus[u] ? "✓" : "…"}</li>`
        ).join("");
      }
      roundInfo.textContent = `Runde ${state.roundIndex} / ${state.totalRounds}`;
    }

    function setState(state) {
      if (!state) return;
      lastState = state;
      const key = computeRenderKey(state);
      if (key !== renderKey) {
        fullRender(state);
      } else {
        updateTickOnly(state);
      }
    }

    // ---------------------------------------------------------------------
    // Endscreen
    // ---------------------------------------------------------------------
    function renderEndscreen(endscreen) {
      const podium = endscreen.leaderboard.slice(0, 3);
      const rest = endscreen.leaderboard.slice(3);
      const medals = ["🥇", "🥈", "🥉"];
      const fs = endscreen.funStats || {};
      stage.innerHTML = `
        <div class="mg-question-card mg-endscreen">
          <div class="mg-endscreen-title">👑 MEHRHEITSMEISTER 👑</div>
          <ol class="mg-podium-list">
            ${podium.map((p, i) => `
              <li class="mg-podium-entry">
                <span class="mg-podium-medal">${medals[i]}</span>
                <span class="mg-podium-name">${escapeHtml(p.name)}</span>
                <span class="mg-podium-score">${p.score} Punkte</span>
              </li>
            `).join("")}
          </ol>
          ${rest.length ? `
            <ol class="mg-rest-list" start="4">
              ${rest.map((p) => `<li><span>${escapeHtml(p.name)}</span><span>${p.score} Punkte</span></li>`).join("")}
            </ol>
          ` : ""}
          <div class="mg-fun-stats">
            ${fs.herdAnimal ? `<div class="mg-fun-stat"><strong>${fs.herdAnimal.label}</strong><span>${escapeHtml(fs.herdAnimal.name)} - ${escapeHtml(fs.herdAnimal.detail)}</span></div>` : ""}
            ${fs.mindReader ? `<div class="mg-fun-stat"><strong>${fs.mindReader.label}</strong><span>${escapeHtml(fs.mindReader.name)} - ${escapeHtml(fs.mindReader.detail)}</span></div>` : ""}
            ${fs.contrarian ? `<div class="mg-fun-stat"><strong>${fs.contrarian.label}</strong><span>${escapeHtml(fs.contrarian.name)} - ${escapeHtml(fs.contrarian.detail)}</span></div>` : ""}
            ${fs.unanimousChamp ? `<div class="mg-fun-stat"><strong>${fs.unanimousChamp.label}</strong><span>${escapeHtml(fs.unanimousChamp.name)} - ${escapeHtml(fs.unanimousChamp.detail)}</span></div>` : ""}
          </div>
          <div class="mg-endscreen-actions">
            ${isHost ? `<button type="button" class="primary-btn" data-role="rematch">NOCH EINE RUNDE</button>` : ""}
            <button type="button" class="ghost-btn" data-role="leave">SPIEL VERLASSEN</button>
          </div>
        </div>
      `;
      const rematchBtn = stage.querySelector('[data-role="rematch"]');
      if (rematchBtn) rematchBtn.addEventListener("click", () => { sendRematch(); });
      const leaveBtn = stage.querySelector('[data-role="leave"]');
      if (leaveBtn) leaveBtn.addEventListener("click", () => { opts.closeGame && opts.closeGame(); });
      sfx.winner();
    }

    function showGameOver(data) {
      if (data && data.details) {
        renderEndscreen(data.details);
        return;
      }
      const reasonText = data && data.reason === "opponent_left"
        ? "Ein Mitspieler hat das Spiel verlassen - die Partie wurde beendet."
        : "Die Partie wurde beendet.";
      stage.innerHTML = `
        <div class="mg-question-card mg-endscreen">
          <div class="mg-endscreen-title">Spiel beendet</div>
          <p>${escapeHtml(reasonText)}</p>
          <div class="mg-endscreen-actions">
            <button type="button" class="ghost-btn" data-role="leave">SPIEL VERLASSEN</button>
          </div>
        </div>
      `;
      const leaveBtn = stage.querySelector('[data-role="leave"]');
      if (leaveBtn) leaveBtn.addEventListener("click", () => { opts.closeGame && opts.closeGame(); });
    }

    function destroy() {
      // Nothing external to release - phase countdowns are server-driven.
    }

    return {
      setState,
      showGameOver,
      destroy,
      _debugLastState() { return lastState; },
    };
  }

  window.MajorityGame = { mount, openHostOptionsModal };
})();
