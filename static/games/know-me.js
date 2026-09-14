// ============================================================================
// Kennst du mich? - multiplayer "how well do you know each other" party game
// for Chat & Games.
//
// Fully server-authoritative, same pattern as estimate-game.js/who-am-i.js:
// the round plan, target rotation, timers, and all scoring come from the
// backend engine (backend/know_me.py) via the existing game_state/game_over
// websocket events - this module only renders what it's given and sends
// {action, ...} through the same game_input channel every other multiplayer
// game uses.
//
// SECURITY NOTE: during a choice/scale round's guessing phase, the target's
// secret pick and every other guesser's individual submission are NEVER in
// the payload this module receives - see know_me.py's public_state(). Only
// booleans ("who has submitted") are available before reveal. Never try to
// infer/cache a value client-side across phases.
//
// window.KnowMe.mount(stageEl, opts) -> { setState(state), showGameOver(data), destroy() }
// window.KnowMe.openHostOptionsModal(onConfirm)
// ============================================================================

(function () {
  "use strict";

  const TONE_META = {
    casual: { label: "Locker", emoji: "🙂" },
    funny: { label: "Lustig", emoji: "😂" },
    spicy: { label: "Frech", emoji: "🌶" },
  };

  const SOUND_KEY = "knowme_sound_enabled";
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
    exact: () => { beep(660, 0.12, "sine", 0.06); setTimeout(() => beep(880, 0.2, "sine", 0.06), 110); },
    round: () => beep(400, 0.08, "sine", 0.04),
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
      <div class="modal km-options-modal">
        <div class="modal-head">
          <h2>❤️ Kennst du mich? erstellen</h2>
          <button type="button" class="icon-btn" data-role="close">✕</button>
        </div>
        <div class="km-options-body">
          <div class="km-options-group">
            <div class="km-options-label">Runden</div>
            <div class="km-options-chips" data-role="rounds">
              <button type="button" class="km-chip" data-value="5">5</button>
              <button type="button" class="km-chip km-chip--active" data-value="10">10</button>
              <button type="button" class="km-chip" data-value="15">15</button>
              <button type="button" class="km-chip" data-value="20">20</button>
            </div>
          </div>
          <div class="km-options-group">
            <div class="km-options-label">Fragenstimmung</div>
            <div class="km-options-chips" data-role="tone">
              <button type="button" class="km-chip" data-value="casual">🙂 Locker</button>
              <button type="button" class="km-chip" data-value="funny">😂 Lustig</button>
              <button type="button" class="km-chip" data-value="spicy">🌶 Frech</button>
              <button type="button" class="km-chip km-chip--active" data-value="mixed">🎲 Gemischt</button>
            </div>
          </div>
        </div>
        <div class="km-options-actions">
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

    for (const group of overlay.querySelectorAll(".km-options-chips")) {
      group.addEventListener("click", (e) => {
        const btn = e.target.closest(".km-chip");
        if (!btn) return;
        for (const c of group.querySelectorAll(".km-chip")) c.classList.remove("km-chip--active");
        btn.classList.add("km-chip--active");
      });
    }

    overlay.querySelector('[data-role="confirm"]').addEventListener("click", () => {
      const rounds = parseInt(overlay.querySelector('[data-role="rounds"] .km-chip--active').dataset.value, 10);
      const tone = overlay.querySelector('[data-role="tone"] .km-chip--active').dataset.value;
      close();
      onConfirm({ rounds, tone });
    });
  }

  // ---------------------------------------------------------------------
  // Main module
  // ---------------------------------------------------------------------
  function mount(stageEl, opts) {
    const { me, players, sendInput, sendRematch, isHost } = opts;

    stageEl.innerHTML = `
      <div class="km-root">
        <div class="km-topbar">
          <span class="km-brand">❤️ Kennst du mich?</span>
          <span class="km-round-info" data-role="round-info"></span>
          <button type="button" class="icon-btn km-sound-toggle" title="Sound an/aus" aria-label="Sound an/aus">${soundEnabled() ? "🔊" : "🔇"}</button>
        </div>
        <div class="km-stage"></div>
      </div>
    `;
    const stage = stageEl.querySelector(".km-stage");
    const roundInfo = stageEl.querySelector('[data-role="round-info"]');
    const soundBtn = stageEl.querySelector(".km-sound-toggle");
    soundBtn.addEventListener("click", () => {
      setSoundEnabled(!soundEnabled());
      soundBtn.textContent = soundEnabled() ? "🔊" : "🔇";
    });

    let lastState = null;
    let renderKey = null;

    function playerName(uid) {
      const p = lastState && lastState.players.find((pl) => pl.userId === uid);
      if (p) return p.name;
      const pp = players.find((pl) => pl.id === uid);
      return pp ? pp.name : "?";
    }

    function computeRenderKey(state) {
      const submittedFlag = state.phase === "guessing" ? (state.mySubmitted ? "done" : "open") : "";
      return [state.phase, state.roundIndex, state.roundType, state.isTarget, submittedFlag].join("|");
    }

    function renderTopBanner(state) {
      if (state.phase !== "target_answer" && state.phase !== "guessing") return "";
      if (state.roundType === "group_vote") {
        return `<div class="km-turn-banner">${TONE_META[state.tone] ? TONE_META[state.tone].emoji : ""} Alle stimmen ab</div>`;
      }
      if (state.isTarget) return `<div class="km-turn-banner km-turn-banner--me">DU BIST DRAN</div>`;
      return `<div class="km-turn-banner">${escapeHtml(state.targetName || "")} ist dran …</div>`;
    }

    function renderTargetAnswerArea(state) {
      const q = state;
      if (state.isTarget) {
        let inputHtml = "";
        if (state.roundType === "choice") {
          inputHtml = `
            <div class="km-choice-cards" data-role="answer-cards">
              ${q.answers.map((a, i) => `<button type="button" class="km-choice-card" data-index="${i}">${escapeHtml(a)}</button>`).join("")}
            </div>
          `;
        } else {
          inputHtml = renderScaleButtons(q.min, q.max, "target-scale");
        }
        return `
          <div class="km-question-card">
            <p class="km-question-text">${escapeHtml(q.question)}</p>
            ${state.roundType === "scale" ? `<div class="km-scale-labels"><span>${q.min} · ${escapeHtml(q.minLabel)}</span><span>${q.max} · ${escapeHtml(q.maxLabel)}</span></div>` : ""}
            ${inputHtml}
            <div class="km-turn-meta"><span data-role="timer">${state.secondsLeft}</span>s</div>
          </div>
        `;
      }
      return `
        <div class="km-question-card km-question-card--waiting">
          <p class="km-waiting-text">${escapeHtml(state.targetName || "")} überlegt sich die Antwort …</p>
          <div class="km-turn-meta"><span data-role="timer">${state.secondsLeft}</span>s</div>
        </div>
      `;
    }

    function renderScaleButtons(min, max, role) {
      const buttons = [];
      for (let v = min; v <= max; v++) buttons.push(v);
      return `
        <div class="km-scale-grid" data-role="${role}">
          ${buttons.map((v) => `<button type="button" class="km-scale-btn" data-value="${v}">${v}</button>`).join("")}
        </div>
      `;
    }

    function renderGuessingArea(state) {
      const submissionStatus = state.submissionStatus || {};
      const statusEntries = Object.keys(submissionStatus).map((uid) => ({
        userId: parseInt(uid, 10), name: playerName(parseInt(uid, 10)), submitted: submissionStatus[uid],
      }));

      if (state.roundType === "group_vote") {
        if (state.mySubmitted) {
          return `
            <div class="km-question-card km-question-card--waiting">
              <p class="km-question-text">${escapeHtml(state.question)}</p>
              <p class="km-waiting-text">Du hast abgestimmt. Warte auf die anderen …</p>
              <ul class="km-status-list">${statusEntries.map((s) => `<li>${escapeHtml(s.name)} ${s.submitted ? "✓" : "…"}</li>`).join("")}</ul>
              <div class="km-turn-meta"><span data-role="timer">${state.secondsLeft}</span>s</div>
            </div>
          `;
        }
        return `
          <div class="km-question-card">
            <p class="km-question-text">${escapeHtml(state.question)}</p>
            <div class="km-vote-cards" data-role="vote-cards">
              ${(state.players_votable || []).map((p) => `<button type="button" class="km-vote-card" data-uid="${p.userId}">${escapeHtml(p.name)}</button>`).join("")}
            </div>
            <div class="km-turn-meta"><span data-role="timer">${state.secondsLeft}</span>s</div>
          </div>
        `;
      }

      // choice / scale guessing
      if (state.isTarget) {
        return `
          <div class="km-question-card km-question-card--waiting">
            <p class="km-waiting-text">Die anderen versuchen dich einzuschätzen …</p>
            <ul class="km-status-list">${statusEntries.map((s) => `<li>${escapeHtml(s.name)} ${s.submitted ? "✓" : "…"}</li>`).join("")}</ul>
            <div class="km-turn-meta"><span data-role="timer">${state.secondsLeft}</span>s</div>
          </div>
        `;
      }
      if (state.mySubmitted) {
        return `
          <div class="km-question-card km-question-card--waiting">
            <p class="km-waiting-text">Antwort gespeichert. Warte auf die anderen …</p>
            <ul class="km-status-list">${statusEntries.map((s) => `<li>${escapeHtml(s.name)} ${s.submitted ? "✓" : "…"}</li>`).join("")}</ul>
            <div class="km-turn-meta"><span data-role="timer">${state.secondsLeft}</span>s</div>
          </div>
        `;
      }
      let inputHtml;
      if (state.roundType === "choice") {
        inputHtml = `
          <div class="km-choice-cards" data-role="answer-cards">
            ${state.answers.map((a, i) => `<button type="button" class="km-choice-card" data-index="${i}">${escapeHtml(a)}</button>`).join("")}
          </div>
        `;
      } else {
        inputHtml = renderScaleButtons(state.min, state.max, "guess-scale");
      }
      return `
        <div class="km-question-card">
          <p class="km-question-echo">Was glaubst du, hat ${escapeHtml(state.targetName || "")} gewählt?</p>
          <p class="km-question-text">${escapeHtml(state.question)}</p>
          ${state.roundType === "scale" ? `<div class="km-scale-labels"><span>${state.min} · ${escapeHtml(state.minLabel)}</span><span>${state.max} · ${escapeHtml(state.maxLabel)}</span></div>` : ""}
          ${inputHtml}
          <div class="km-turn-meta"><span data-role="timer">${state.secondsLeft}</span>s</div>
        </div>
      `;
    }

    function renderRevealArea(state) {
      if (state.roundSkipped || !state.roundResult) {
        return `<div class="km-question-card"><p class="km-waiting-text">Diese Runde wurde übersprungen.</p></div>`;
      }
      const rr = state.roundResult;
      if (rr.type === "group_vote") {
        const counts = rr.voteCounts || {};
        const maxCount = Math.max(1, ...Object.values(counts).map(Number));
        const rows = state.players
          .filter((p) => counts[String(p.userId)] != null)
          .map((p) => ({ ...p, count: counts[String(p.userId)] || 0 }))
          .sort((a, b) => b.count - a.count);
        const winnerNames = (rr.winners || []).map((w) => playerName(w));
        return `
          <div class="km-question-card km-reveal-card">
            <p class="km-question-text">${escapeHtml(rr.question)}</p>
            <div class="km-bar-chart">
              ${rows.map((r) => `
                <div class="km-bar-row ${rr.winners.includes(r.userId) ? "km-bar-row--winner" : ""}">
                  <span class="km-bar-name">${escapeHtml(r.name)}</span>
                  <div class="km-bar-track"><div class="km-bar-fill" style="width:${(r.count / maxCount) * 100}%"></div></div>
                  <span class="km-bar-count">${r.count}</span>
                </div>
              `).join("")}
            </div>
            ${winnerNames.length ? `<p class="km-winner-line">😂 ${winnerNames.map(escapeHtml).join(" & ")}</p>` : `<p class="km-winner-line">Keine klare Mehrheit</p>`}
          </div>
        `;
      }

      // choice / scale reveal
      const isChoice = rr.type === "choice";
      const answerDisplay = isChoice ? rr.answers[rr.answer] : `${rr.answer} / ${rr.max}`;
      const results = (rr.results || []).slice().sort((a, b) => (b.points || 0) - (a.points || 0));
      return `
        <div class="km-question-card km-reveal-card">
          <p class="km-reveal-lead">${escapeHtml(rr.targetName)} hat gewählt …</p>
          <div class="km-reveal-answer">${escapeHtml(String(answerDisplay))}</div>
          <ul class="km-reveal-results">
            ${results.map((r) => {
              const name = playerName(r.userId);
              if (!r.submitted) return `<li><span>${escapeHtml(name)}</span><span class="km-reveal-nosubmit">keine Antwort</span></li>`;
              if (isChoice) {
                return `<li><span>${escapeHtml(name)}</span><span class="${r.correct ? "km-reveal-correct" : "km-reveal-wrong"}">${r.correct ? "✓ RICHTIG" : "✗"}</span><span class="km-reveal-points">+${r.points}</span></li>`;
              }
              const deltaText = r.delta === 0 ? "🎯 exakt" : (r.delta > 0 ? `+${r.delta}` : `${r.delta}`);
              return `<li><span>${escapeHtml(name)}</span><span class="km-reveal-value">${r.value} (${deltaText})</span><span class="km-reveal-points">+${r.points}</span></li>`;
            }).join("")}
          </ul>
          <p class="km-target-points-line">${escapeHtml(rr.targetName)} bekommt <strong>+${rr.targetPoints}</strong> Punkte${isChoice ? " dafür, schwer einschätzbar zu sein" : ""}.</p>
        </div>
      `;
    }

    function renderStandingsArea(state) {
      const standings = state.standings || [];
      return `
        <div class="km-question-card">
          <div class="km-standings-title">📊 ZWISCHENSTAND</div>
          <ol class="km-standings-list">
            ${standings.map((s, i) => `<li><span>${i + 1}.</span><span>${escapeHtml(s.name)}</span><span>${s.score}</span></li>`).join("")}
          </ol>
        </div>
      `;
    }

    function fullRender(state) {
      renderKey = computeRenderKey(state);
      let content = "";
      if (state.phase === "target_answer") content = renderTargetAnswerArea(state);
      else if (state.phase === "guessing") content = renderGuessingArea(state);
      else if (state.phase === "reveal") { content = renderRevealArea(state); sfx.reveal(); }
      else if (state.phase === "standings") { content = renderStandingsArea(state); sfx.round(); }

      stage.innerHTML = `${renderTopBanner(state)}${content}`;
      roundInfo.textContent = `Runde ${state.roundIndex} / ${state.totalRounds}`;

      wireInputHandlers(state);
    }

    function wireInputHandlers(state) {
      for (const btn of stage.querySelectorAll(".km-choice-card")) {
        btn.addEventListener("click", () => {
          const idx = parseInt(btn.dataset.index, 10);
          for (const b of stage.querySelectorAll(".km-choice-card")) b.disabled = true;
          btn.classList.add("km-choice-card--picked");
          if (state.phase === "target_answer") sendInput({ action: "submit_target", value: idx });
          else sendInput({ action: "submit_guess", value: idx });
          sfx.submitted();
          haptic(15);
        });
      }
      for (const btn of stage.querySelectorAll(".km-scale-btn")) {
        btn.addEventListener("click", () => {
          const val = parseInt(btn.dataset.value, 10);
          for (const b of stage.querySelectorAll(".km-scale-btn")) b.disabled = true;
          btn.classList.add("km-scale-btn--picked");
          if (state.phase === "target_answer") sendInput({ action: "submit_target", value: val });
          else sendInput({ action: "submit_guess", value: val });
          sfx.submitted();
          haptic(15);
        });
      }
      for (const btn of stage.querySelectorAll(".km-vote-card")) {
        btn.addEventListener("click", () => {
          const uid = parseInt(btn.dataset.uid, 10);
          for (const b of stage.querySelectorAll(".km-vote-card")) b.disabled = true;
          btn.classList.add("km-vote-card--picked");
          sendInput({ action: "submit_vote", target_user_id: uid });
          sfx.submitted();
          haptic(15);
        });
      }
    }

    function updateTickOnly(state) {
      const timerEls = stage.querySelectorAll('[data-role="timer"]');
      for (const t of timerEls) t.textContent = String(state.secondsLeft);
      const list = stage.querySelector(".km-status-list");
      if (list && state.submissionStatus) {
        const entries = Object.keys(state.submissionStatus).map((uid) => ({
          name: playerName(parseInt(uid, 10)), submitted: state.submissionStatus[uid],
        }));
        list.innerHTML = entries.map((e) => `<li>${escapeHtml(e.name)} ${e.submitted ? "✓" : "…"}</li>`).join("");
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
        <div class="km-question-card km-endscreen">
          <div class="km-endscreen-title">🏆 KENNST DU MICH?</div>
          <ol class="km-podium-list">
            ${podium.map((p, i) => `
              <li class="km-podium-entry">
                <span class="km-podium-medal">${medals[i]}</span>
                <span class="km-podium-name">${escapeHtml(p.name)}</span>
                <span class="km-podium-score">${p.score} Punkte</span>
              </li>
            `).join("")}
          </ol>
          ${rest.length ? `
            <ol class="km-rest-list" start="4">
              ${rest.map((p) => `<li><span>${escapeHtml(p.name)}</span><span>${p.score} Punkte</span></li>`).join("")}
            </ol>
          ` : ""}
          <div class="km-fun-stats">
            ${fs.mindReader ? `<div class="km-fun-stat"><strong>${fs.mindReader.label}</strong><span>${escapeHtml(fs.mindReader.name)} - ${escapeHtml(fs.mindReader.detail)}</span></div>` : ""}
            ${fs.bigMystery ? `<div class="km-fun-stat"><strong>${fs.bigMystery.label}</strong><span>${escapeHtml(fs.bigMystery.name)} - ${escapeHtml(fs.bigMystery.detail)}</span></div>` : ""}
            ${fs.groupMagnet ? `<div class="km-fun-stat"><strong>${fs.groupMagnet.label}</strong><span>${escapeHtml(fs.groupMagnet.name)} - ${escapeHtml(fs.groupMagnet.detail)}</span></div>` : ""}
          </div>
          <div class="km-endscreen-actions">
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
        <div class="km-question-card km-endscreen">
          <div class="km-endscreen-title">Spiel beendet</div>
          <p>${escapeHtml(reasonText)}</p>
          <div class="km-endscreen-actions">
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

  window.KnowMe = { mount, openHostOptionsModal };
})();
