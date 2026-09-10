// ============================================================================
// Schaetzmeister - multiplayer number-guessing trivia game for Chat & Games.
//
// Unlike TimLiner (single-player, purely client-side), this game is fully
// server-authoritative: the question, timer, other players' submitted-or-not
// status, the answer, and all scoring come from the backend engine
// (backend/estimate_game.py) via the existing game_state/game_over websocket
// events - this module only renders what it's given and sends
// {action:"submit_guess", value} through the same game_input channel every
// other multiplayer game already uses. See app.js's openGameModal/
// updateGameState/showGameOver for the three hooks this module plugs into.
//
// window.EstimateGame.mount(stageEl, opts) -> { setState(state), showGameOver(data), destroy() }
// window.EstimateGame.openHostOptionsModal(onConfirm) -> shows the pre-create
//   rounds/difficulty/category picker, calls onConfirm(options) once the host
//   confirms (or nothing if they cancel).
// ============================================================================

(function () {
  "use strict";

  const CATEGORY_META = {
    geography: { label: "Geografie", emoji: "🌍" },
    science: { label: "Wissenschaft & Natur", emoji: "🔬" },
    history: { label: "Geschichte", emoji: "🏛" },
    tech: { label: "Technik & Internet", emoji: "💻" },
    entertainment: { label: "Unterhaltung", emoji: "🎬" },
    sports: { label: "Sport", emoji: "⚽" },
    mobility: { label: "Mobilität & Fahrzeuge", emoji: "🚗" },
    weird: { label: "Verrücktes Wissen", emoji: "🌎" },
  };

  // ---------------------------------------------------------------------
  // Sound - own small dezent effect set + its own localStorage toggle
  // (there is no shared app-wide sound setting to hook into; TimLiner set
  // the precedent of each game owning its own preference).
  // ---------------------------------------------------------------------
  const SOUND_KEY = "estimate_sound_enabled";
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
    submitted: () => beep(520, 0.12, "sine", 0.05),
    tick5: () => beep(340, 0.08, "square", 0.035),
    reveal: () => beep(660, 0.18, "sine", 0.05),
    bullseye: () => { beep(660, 0.12, "sine", 0.06); setTimeout(() => beep(880, 0.18, "sine", 0.06), 100); },
    winner: () => { beep(523, 0.12, "sine", 0.06); setTimeout(() => beep(659, 0.12, "sine", 0.06), 120); setTimeout(() => beep(784, 0.22, "sine", 0.06), 240); },
  };

  // ---------------------------------------------------------------------
  // Number formatting (German convention) for values the backend sends as
  // raw numbers rather than a pre-baked display string (deltas, live
  // guesses, scores) - the question bank's own displayAnswer is already
  // formatted server-side and used as-is.
  // ---------------------------------------------------------------------
  function formatDE(value, decimals) {
    if (value == null || !isFinite(value)) return "-";
    const isInt = Math.abs(value - Math.round(value)) < 1e-9;
    const d = decimals != null ? decimals : (isInt ? 0 : 2);
    const fixed = Math.abs(value).toFixed(d);
    const parts = fixed.split(".");
    const withDots = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    const sign = value < 0 ? "-" : "";
    return sign + withDots + (parts[1] ? "," + parts[1] : "");
  }
  function formatUnitValue(value, unit) {
    const s = formatDE(value);
    return unit ? `${s} ${unit}` : s;
  }
  function formatDelta(delta, unit) {
    if (delta == null) return "-";
    const sign = delta > 0 ? "+" : delta < 0 ? "-" : "±";
    return `${sign}${formatDE(Math.abs(delta))}${unit ? " " + unit : ""}`;
  }
  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str == null ? "" : String(str);
    return d.innerHTML;
  }

  // ---------------------------------------------------------------------
  // Host pre-create options modal (rounds / difficulty / categories).
  // Built and torn down on demand - not part of the always-present shell,
  // since only the host, only before create_session, ever sees it.
  // ---------------------------------------------------------------------
  function openHostOptionsModal(onConfirm) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal est-options-modal">
        <div class="modal-head">
          <h2>🎯 Schätzmeister erstellen</h2>
          <button type="button" class="icon-btn" data-role="close">✕</button>
        </div>
        <div class="est-options-body">
          <div class="est-options-group">
            <div class="est-options-label">Runden</div>
            <div class="est-options-chips" data-role="rounds">
              <button type="button" class="est-chip" data-value="5">5</button>
              <button type="button" class="est-chip est-chip--active" data-value="10">10</button>
              <button type="button" class="est-chip" data-value="15">15</button>
            </div>
          </div>
          <div class="est-options-group">
            <div class="est-options-label">Schwierigkeit</div>
            <div class="est-options-chips" data-role="difficulty">
              <button type="button" class="est-chip est-chip--active" data-value="mixed">Gemischt</button>
              <button type="button" class="est-chip" data-value="easy">Leicht</button>
              <button type="button" class="est-chip" data-value="medium">Mittel</button>
              <button type="button" class="est-chip" data-value="hard">Schwer</button>
            </div>
          </div>
          <div class="est-options-group">
            <div class="est-options-label">Kategorien</div>
            <div class="est-options-cats" data-role="categories">
              ${Object.entries(CATEGORY_META).map(([key, meta]) => `
                <label class="est-cat-check">
                  <input type="checkbox" value="${key}" checked />
                  <span>${meta.emoji} ${escapeHtml(meta.label)}</span>
                </label>
              `).join("")}
            </div>
          </div>
        </div>
        <div class="est-options-actions">
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

    for (const group of overlay.querySelectorAll(".est-options-chips")) {
      group.addEventListener("click", (e) => {
        const btn = e.target.closest(".est-chip");
        if (!btn) return;
        for (const c of group.querySelectorAll(".est-chip")) c.classList.remove("est-chip--active");
        btn.classList.add("est-chip--active");
      });
    }

    overlay.querySelector('[data-role="confirm"]').addEventListener("click", () => {
      const rounds = parseInt(overlay.querySelector('[data-role="rounds"] .est-chip--active').dataset.value, 10);
      const difficulty = overlay.querySelector('[data-role="difficulty"] .est-chip--active').dataset.value;
      const categories = Array.from(overlay.querySelectorAll('.est-cat-check input:checked')).map((i) => i.value);
      close();
      onConfirm({ rounds, difficulty, categories: categories.length ? categories : Object.keys(CATEGORY_META) });
    });
  }

  // ---------------------------------------------------------------------
  // Reveal scale: positions the answer + every submitted guess along a
  // horizontal track, auto-fitting the value range (with padding) and
  // greedily stacking labels into extra rows whenever two markers would
  // otherwise sit close enough to overlap.
  // ---------------------------------------------------------------------
  function buildScale(answer, results, unit) {
    const points = results.filter((r) => r.guess != null).map((r) => ({ x: r.guess, name: r.name, isAnswer: false, rank: r.rank }));
    points.push({ x: answer, name: null, isAnswer: true });
    let min = Math.min(...points.map((p) => p.x));
    let max = Math.max(...points.map((p) => p.x));
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.18;
    min -= pad; max += pad;
    const range = max - min || 1;
    const xPct = (v) => ((v - min) / range) * 100;

    const withPos = points
      .map((p) => ({ ...p, pos: xPct(p.x) }))
      .sort((a, b) => a.pos - b.pos);

    const MIN_GAP = 11; // percent of track width before a label is considered "too close"
    const rowLast = [];
    for (const p of withPos) {
      let row = 0;
      while (rowLast[row] !== undefined && p.pos - rowLast[row] < MIN_GAP) row++;
      rowLast[row] = p.pos;
      p.row = row;
    }
    const maxRow = Math.max(0, ...withPos.map((p) => p.row));

    const markers = withPos.map((p) => {
      const cls = p.isAnswer ? "est-scale-marker est-scale-marker--answer" : "est-scale-marker";
      const label = p.isAnswer ? "✓" : (p.rank === 1 ? "🥇" : p.rank === 2 ? "🥈" : p.rank === 3 ? "🥉" : "");
      return `
        <div class="${cls}" style="left:${p.pos}%;">
          <div class="est-scale-dot"></div>
          <div class="est-scale-label" style="top:${28 + p.row * 22}px;">${label ? label + " " : ""}${p.isAnswer ? "" : escapeHtml(p.name)}</div>
        </div>
      `;
    }).join("");

    const trackHeight = 40 + (maxRow + 1) * 22;
    return `<div class="est-scale" style="height:${trackHeight}px;"><div class="est-scale-track"></div>${markers}</div>`;
  }

  // ---------------------------------------------------------------------
  // Main module: mount() builds a persistent skeleton, setState() re-
  // renders it. The one thing setState is careful NOT to clobber is the
  // number input's live value while the player is still typing during an
  // unchanged guessing round - see the samePhaseAndRound check below.
  // ---------------------------------------------------------------------
  function mount(stageEl, opts) {
    const { me, players, sendInput, sendRematch, isHost } = opts;
    const playerName = (uid) => {
      const p = players.find((pl) => pl.id === uid);
      return p ? p.name : "?";
    };

    stageEl.innerHTML = `
      <div class="est-root">
        <div class="est-topbar">
          <span class="est-brand">🎯 Schätzmeister</span>
          <button type="button" class="icon-btn est-sound-toggle" title="Sound an/aus" aria-label="Sound an/aus">${soundEnabled() ? "🔊" : "🔇"}</button>
        </div>
        <div class="est-stage"></div>
      </div>
    `;
    const stage = stageEl.querySelector(".est-stage");
    const soundBtn = stageEl.querySelector(".est-sound-toggle");
    soundBtn.addEventListener("click", () => {
      setSoundEnabled(!soundEnabled());
      soundBtn.textContent = soundEnabled() ? "🔊" : "🔇";
    });

    let lastState = null;
    let guessingBuilt = false;
    let mySubmittedLocally = false;
    let reconciledServerGuess = false;

    function submitGuess(inputEl, errorEl) {
      const raw = inputEl.value;
      if (!raw || !raw.trim()) {
        errorEl.textContent = "Bitte eine Zahl eingeben.";
        errorEl.hidden = false;
        return;
      }
      sendInput({ action: "submit_guess", value: raw.trim() });
      mySubmittedLocally = true;
      sfx.submitted();
      // Optimistic echo shows exactly what was typed (not a reformatted
      // guess at parsing it) - the server's own parse of the same value
      // lands within a second via updateGuessingTick and replaces this
      // with the authoritative, properly formatted number.
      renderGuessingLocked(lastState.unit, `${raw.trim()}${lastState.unit ? " " + lastState.unit : ""}`);
    }

    function renderGuessingLocked(unit, displayText) {
      const lockedBox = stage.querySelector(".est-locked");
      if (lockedBox) {
        lockedBox.hidden = false;
        lockedBox.querySelector(".est-locked-value").textContent = displayText;
      }
      const form = stage.querySelector(".est-guess-form");
      if (form) form.hidden = true;
    }

    function renderQuestionHeader(state) {
      const cat = state.categoryEmoji ? `${state.categoryEmoji} ${escapeHtml(state.categoryLabel || "")}` : "";
      return `
        <div class="est-round-line">Runde ${state.roundIndex} / ${state.totalRounds}</div>
        <div class="est-category">${cat}</div>
        <h2 class="est-question">${escapeHtml(state.question || "")}</h2>
        ${state.unit ? `<div class="est-unit-hint">Schätzung in ${escapeHtml(state.unit)}</div>` : (state.type === "year" ? `<div class="est-unit-hint">Jahr</div>` : "")}
      `;
    }

    function fullRenderGuessing(state) {
      guessingBuilt = true;
      mySubmittedLocally = !!state.mySubmitted;
      reconciledServerGuess = !!state.mySubmitted;
      const submittedCount = Object.values(state.submissions || {}).filter(Boolean).length;
      const totalCount = Object.keys(state.submissions || {}).length;

      stage.innerHTML = `
        <div class="est-card">
          ${renderQuestionHeader(state)}
          <form class="est-guess-form" ${state.mySubmitted ? "hidden" : ""}>
            <input type="text" inputmode="decimal" autocomplete="off" class="est-input" placeholder="${state.type === "year" ? "z.B. 2005" : "Zahl eingeben"}" />
            <button type="submit" class="primary-btn est-submit-btn">Schätzung abgeben</button>
            <p class="est-input-error" hidden></p>
          </form>
          <div class="est-locked" ${state.mySubmitted ? "" : "hidden"}>
            <p class="est-locked-check">✓ Deine Schätzung: <span class="est-locked-value">${state.myGuess != null ? formatUnitValue(state.myGuess, state.unit) : ""}</span></p>
            <p class="est-locked-wait">Warte auf die anderen Spieler …</p>
          </div>
          <div class="est-timer-row">
            <div class="est-timer" data-role="timer">${state.secondsLeft}</div>
            <div class="est-submit-progress">${submittedCount}/${totalCount} abgegeben</div>
          </div>
          <ul class="est-player-status" data-role="playerlist">
            ${state.players.filter((p) => p.active).map((p) => `
              <li><span>${escapeHtml(p.name)}</span><span class="est-status-mark">${state.submissions && state.submissions[String(p.userId)] ? "✓" : "…"}</span></li>
            `).join("")}
          </ul>
        </div>
      `;

      applyTimerClass(state.secondsLeft);

      const form = stage.querySelector(".est-guess-form");
      const input = stage.querySelector(".est-input");
      const errorEl = stage.querySelector(".est-input-error");
      if (input) input.focus();
      if (form) {
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          errorEl.hidden = true;
          submitGuess(input, errorEl);
        });
      }
    }

    function applyTimerClass(secondsLeft) {
      const timerEl = stage.querySelector('[data-role="timer"]');
      if (!timerEl) return;
      timerEl.textContent = String(secondsLeft);
      timerEl.classList.toggle("est-timer--urgent", secondsLeft <= 5);
      if (secondsLeft === 5) sfx.tick5();
    }

    function updateGuessingTick(state) {
      applyTimerClass(state.secondsLeft);
      const progress = stage.querySelector(".est-submit-progress");
      if (progress) {
        const submittedCount = Object.values(state.submissions || {}).filter(Boolean).length;
        const totalCount = Object.keys(state.submissions || {}).length;
        progress.textContent = `${submittedCount}/${totalCount} abgegeben`;
      }
      const list = stage.querySelector('[data-role="playerlist"]');
      if (list) {
        list.innerHTML = state.players.filter((p) => p.active).map((p) => `
          <li><span>${escapeHtml(p.name)}</span><span class="est-status-mark">${state.submissions && state.submissions[String(p.userId)] ? "✓" : "…"}</span></li>
        `).join("");
      }
      // Once the server confirms our submission, swap the optimistic
      // "what I typed" echo for the authoritative, properly formatted
      // parsed value (also covers the case where submitGuess()'s optimistic
      // path was skipped, e.g. a reconnect mid-round with a prior submit).
      if (state.mySubmitted && !reconciledServerGuess) {
        renderGuessingLocked(state.unit, state.myGuess != null ? formatUnitValue(state.myGuess, state.unit) : "");
        mySubmittedLocally = true;
        reconciledServerGuess = true;
      }
    }

    function fullRenderReveal(state) {
      guessingBuilt = false;
      const results = (state.results || []).slice().sort((a, b) => {
        if (a.rank == null) return 1;
        if (b.rank == null) return -1;
        return a.rank - b.rank;
      });
      const withNames = results.map((r) => ({ ...r, name: playerName(r.user_id) }));
      const medal = (rank) => rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : rank != null ? `${rank}.` : "-";
      const closest = withNames.find((r) => r.submitted);
      const closestLine = closest
        ? `<p class="est-closest-line">${closest.bonusLabel === "VOLLTREFFER" ? `🎯 ${escapeHtml(closest.name)} hat exakt getroffen!` : `${escapeHtml(closest.name)} war nur ${formatDE(Math.abs(closest.delta))}${state.unit ? " " + state.unit : ""} daneben!`}</p>`
        : "";

      stage.innerHTML = `
        <div class="est-card est-reveal-card">
          ${renderQuestionHeader(state)}
          <div class="est-reveal-answer-block">
            <div class="est-reveal-label">RICHTIGE ANTWORT</div>
            <div class="est-reveal-answer">${escapeHtml(state.displayAnswer)}</div>
          </div>
          ${closestLine}
          ${buildScale(state.answer, withNames, state.unit)}
          <ul class="est-reveal-list">
            ${withNames.map((r) => `
              <li class="est-reveal-row ${r.bonusLabel === "VOLLTREFFER" ? "est-reveal-row--bullseye" : ""}">
                <span class="est-reveal-rank">${medal(r.rank)}</span>
                <span class="est-reveal-name">${escapeHtml(r.name)}</span>
                <span class="est-reveal-guess">${r.submitted ? formatUnitValue(r.guess, state.unit) : "keine Abgabe"}</span>
                <span class="est-reveal-delta">${r.submitted ? formatDelta(r.delta, state.unit) : ""}</span>
                <span class="est-reveal-points">${r.submitted ? `+${formatDE(r.roundPoints)}${r.bonusLabel ? ` <small>(${r.bonusLabel})</small>` : ""}` : "+0"}</span>
              </li>
            `).join("")}
          </ul>
          ${state.explanation ? `
            <div class="est-explanation">
              <p>${escapeHtml(state.explanation)}</p>
              ${state.sourceLabel ? `<span class="est-source" title="${escapeHtml(state.sourceUrl || "")}">ℹ️ Quelle: ${escapeHtml(state.sourceLabel)}</span>` : ""}
            </div>
          ` : ""}
        </div>
      `;
      sfx.reveal();
      if (withNames.some((r) => r.bonusLabel === "VOLLTREFFER")) setTimeout(() => sfx.bullseye(), 250);
    }

    function fullRenderStandings(state) {
      guessingBuilt = false;
      const standings = state.standings || [];
      stage.innerHTML = `
        <div class="est-card">
          <div class="est-standings-title">🏆 GESAMTSTAND</div>
          <ol class="est-standings-list">
            ${standings.map((s, i) => `
              <li><span class="est-standings-rank">${i + 1}.</span><span class="est-standings-name">${escapeHtml(s.name)}</span><span class="est-standings-score">${formatDE(s.score)}</span></li>
            `).join("")}
          </ol>
          <p class="est-next-line">Nächste Frage in <span data-role="countdown">${state.secondsLeft}</span> …</p>
        </div>
      `;
    }

    function fullRenderFinished(state) {
      guessingBuilt = false;
      const endscreen = state.endscreen;
      if (!endscreen) {
        stage.innerHTML = `<div class="est-card"><p>Spiel wird ausgewertet …</p></div>`;
        return;
      }
      renderEndscreen(endscreen);
    }

    function renderEndscreen(endscreen) {
      const podium = endscreen.leaderboard.slice(0, 3);
      const medals = ["🥇", "🥈", "🥉"];
      stage.innerHTML = `
        <div class="est-card est-endscreen">
          <div class="est-endscreen-title">🏆 SCHÄTZMEISTER</div>
          <div class="est-podium">
            ${podium.map((p, i) => `
              <div class="est-podium-entry est-podium-entry--${i + 1}">
                <div class="est-podium-medal">${medals[i]}</div>
                <div class="est-podium-name">${escapeHtml(p.name)}</div>
                <div class="est-podium-score">${formatDE(p.score)} Punkte</div>
              </div>
            `).join("")}
          </div>
          ${endscreen.leaderboard.length > 3 ? `
            <ol class="est-standings-list est-standings-list--rest" start="4">
              ${endscreen.leaderboard.slice(3).map((s) => `
                <li><span class="est-standings-name">${escapeHtml(s.name)}</span><span class="est-standings-score">${formatDE(s.score)}</span></li>
              `).join("")}
            </ol>
          ` : ""}
          <div class="est-stats">
            ${endscreen.bestGuess ? `<div class="est-stat"><strong>Beste Schätzung</strong><span>${escapeHtml(endscreen.bestGuess.name)} bei „${escapeHtml(endscreen.bestGuess.question)}“</span></div>` : ""}
            ${endscreen.biggestBullseye ? `<div class="est-stat"><strong>🎯 Größter Volltreffer</strong><span>${escapeHtml(endscreen.biggestBullseye.name)} bei „${escapeHtml(endscreen.biggestBullseye.question)}“ (${escapeHtml(endscreen.biggestBullseye.displayAnswer)})</span></div>` : ""}
          </div>
          <div class="est-endscreen-actions">
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

    function setState(state) {
      if (!state) return;
      const prev = lastState;
      const samePhaseAndRound = prev && prev.phase === state.phase && prev.roundIndex === state.roundIndex && prev.questionId === state.questionId;
      lastState = state;

      if (state.phase === "guessing") {
        if (samePhaseAndRound && guessingBuilt) {
          updateGuessingTick(state);
        } else {
          fullRenderGuessing(state);
        }
      } else if (state.phase === "reveal") {
        if (!(prev && prev.phase === "reveal" && prev.roundIndex === state.roundIndex)) {
          fullRenderReveal(state);
        } else {
          const t = stage.querySelector('[data-role="countdown"]');
          if (t) t.textContent = state.secondsLeft;
        }
      } else if (state.phase === "standings") {
        if (!(prev && prev.phase === "standings" && prev.roundIndex === state.roundIndex)) {
          fullRenderStandings(state);
        } else {
          const t = stage.querySelector('[data-role="countdown"]');
          if (t) t.textContent = state.secondsLeft;
        }
      } else if (state.phase === "finished") {
        fullRenderFinished(state);
      }
    }

    function showGameOver(data) {
      // The normal path: all rounds finished, EstimateEngine.check_finished
      // fired with the full endscreen in `details` - authoritative over
      // whatever phase="finished" public_state snapshot arrived just before it.
      if (data && data.details) {
        renderEndscreen(data.details);
        return;
      }
      // The OTHER way a match can end: the shared GameManager's own
      // min_players safety net (games.py _remove_player) closes the
      // session early - e.g. "opponent_left" when a player count drop
      // takes a 2-player match below min_players. That path is generic
      // across every game and carries no `details`, so without this
      // fallback the player would be left staring at a frozen guessing
      // screen forever. Reuses the same est-card/endscreen-actions shell
      // so it doesn't look like a dead end.
      const reasonText = data && data.reason === "opponent_left"
        ? "Ein Mitspieler hat das Spiel verlassen - die Partie wurde beendet."
        : "Die Partie wurde beendet.";
      stage.innerHTML = `
        <div class="est-card">
          <div class="est-endscreen-title">Spiel beendet</div>
          <p class="est-next-line">${escapeHtml(reasonText)}</p>
          <div class="est-endscreen-actions">
            <button type="button" class="ghost-btn" data-role="leave">SPIEL VERLASSEN</button>
          </div>
        </div>
      `;
      const leaveBtn = stage.querySelector('[data-role="leave"]');
      if (leaveBtn) leaveBtn.addEventListener("click", () => { opts.closeGame && opts.closeGame(); });
    }

    function destroy() {
      // Nothing external to release (no timers/rAF of our own - phase
      // countdowns are server-driven and merely displayed) beyond the DOM,
      // which the caller (closeGameModal) clears itself.
    }

    return {
      setState,
      showGameOver,
      destroy,
      // Read-only introspection for automated testing - not used by the
      // UI itself, safe to leave in (mirrors TimLiner's _debugState()).
      // _debugLastState() in particular is the most direct way to assert
      // the answer/other players' guesses truly never reach the client
      // before reveal: it returns exactly the raw payload this module
      // received, nothing recomputed.
      _debugLastState() { return lastState; },
      _debugSubmit(value) { sendInput({ action: "submit_guess", value }); },
    };
  }

  window.EstimateGame = { mount, openHostOptionsModal };
})();
