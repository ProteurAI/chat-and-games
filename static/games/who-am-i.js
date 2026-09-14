// ============================================================================
// Wer bin ich? - multiplayer "sticky note on your forehead" party game for
// Chat & Games.
//
// Fully server-authoritative, same pattern as estimate-game.js: the identity
// assignment, turn order, question/vote timers, vote tallying, final-guess
// judging and scoring all come from the backend engine (backend/who_am_i.py)
// via the existing game_state/game_over websocket events - this module only
// renders what it's given and sends {action, ...} through the same
// game_input channel every other multiplayer game uses.
//
// SECURITY NOTE (read this before touching setState/render*): the server
// NEVER sends a player's own not-yet-solved identity to their own client -
// see who_am_i.py's public_state(). This module must never try to "help" by
// inferring/caching/guessing it client-side (e.g. from an earlier own-card
// render, from the identity bank list, from process of elimination) - the
// own card ALWAYS renders from `player.identity === null` while unsolved,
// full stop.
//
// window.WhoAmI.mount(stageEl, opts) -> { setState(state), showGameOver(data), destroy() }
// window.WhoAmI.openHostOptionsModal(onConfirm)
// ============================================================================

(function () {
  "use strict";

  const CATEGORY_META = {
    film: { label: "Film & Serien", emoji: "🎬" },
    music: { label: "Musik", emoji: "🎵" },
    sport: { label: "Sport", emoji: "⚽" },
    famous: { label: "Berühmte Personen", emoji: "🌍" },
    history: { label: "Geschichte", emoji: "🏛" },
    fiction: { label: "Fiktive Figuren", emoji: "🧙" },
    tv: { label: "TV & Unterhaltung", emoji: "📺" },
    popculture: { label: "Internet / Popkultur", emoji: "💻" },
    politics: { label: "Politik / Staatsfiguren", emoji: "👑" },
  };
  const CARD_COLOR_COUNT = 8;

  // ---------------------------------------------------------------------
  // Sound - own small dezent effect set, same pattern/precedent as
  // estimate-game.js (each game owns its own sound preference).
  // ---------------------------------------------------------------------
  const SOUND_KEY = "whoami_sound_enabled";
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
    question: () => beep(480, 0.1, "sine", 0.045),
    voteResult: () => beep(600, 0.15, "sine", 0.05),
    wrong: () => { beep(220, 0.18, "square", 0.05); setTimeout(() => beep(160, 0.2, "square", 0.05), 130); },
    correct: () => { beep(660, 0.12, "sine", 0.06); setTimeout(() => beep(880, 0.2, "sine", 0.06), 110); },
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
  // Host pre-create options modal (difficulty / categories / max rounds /
  // optional custom terms) - built and torn down on demand, mirrors
  // estimate-game.js's openHostOptionsModal exactly.
  // ---------------------------------------------------------------------
  function openHostOptionsModal(onConfirm) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal wai-options-modal">
        <div class="modal-head">
          <h2>🎭 Wer bin ich? erstellen</h2>
          <button type="button" class="icon-btn" data-role="close">✕</button>
        </div>
        <div class="wai-options-body">
          <div class="wai-options-group">
            <div class="wai-options-label">Schwierigkeit</div>
            <div class="wai-options-chips" data-role="difficulty">
              <button type="button" class="wai-chip wai-chip--active" data-value="mixed">Gemischt</button>
              <button type="button" class="wai-chip" data-value="easy">Leicht</button>
              <button type="button" class="wai-chip" data-value="medium">Mittel</button>
              <button type="button" class="wai-chip" data-value="hard">Schwer</button>
            </div>
          </div>
          <div class="wai-options-group">
            <div class="wai-options-label">Maximale Runden</div>
            <div class="wai-options-chips" data-role="maxrounds">
              <button type="button" class="wai-chip" data-value="10">10</button>
              <button type="button" class="wai-chip wai-chip--active" data-value="15">15</button>
              <button type="button" class="wai-chip" data-value="0">Unbegrenzt</button>
            </div>
          </div>
          <div class="wai-options-group">
            <div class="wai-options-label">Kategorien</div>
            <div class="wai-options-cats" data-role="categories">
              ${Object.entries(CATEGORY_META).map(([key, meta]) => `
                <label class="wai-cat-check">
                  <input type="checkbox" value="${key}" checked />
                  <span>${meta.emoji} ${escapeHtml(meta.label)}</span>
                </label>
              `).join("")}
            </div>
          </div>
          <div class="wai-options-group">
            <label class="wai-cat-check">
              <input type="checkbox" data-role="custom-toggle" />
              <span>Eigene Begriffe verwenden (optional)</span>
            </label>
            <textarea class="wai-custom-terms" data-role="custom-terms" placeholder="Ein Begriff pro Zeile, z.B.:&#10;Chef&#10;Mario&#10;Sherlock Holmes" hidden></textarea>
          </div>
        </div>
        <div class="wai-options-actions">
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

    for (const group of overlay.querySelectorAll(".wai-options-chips")) {
      group.addEventListener("click", (e) => {
        const btn = e.target.closest(".wai-chip");
        if (!btn) return;
        for (const c of group.querySelectorAll(".wai-chip")) c.classList.remove("wai-chip--active");
        btn.classList.add("wai-chip--active");
      });
    }

    const customToggle = overlay.querySelector('[data-role="custom-toggle"]');
    const customTerms = overlay.querySelector('[data-role="custom-terms"]');
    customToggle.addEventListener("change", () => { customTerms.hidden = !customToggle.checked; });

    overlay.querySelector('[data-role="confirm"]').addEventListener("click", () => {
      const difficulty = overlay.querySelector('[data-role="difficulty"] .wai-chip--active').dataset.value;
      const maxRounds = parseInt(overlay.querySelector('[data-role="maxrounds"] .wai-chip--active').dataset.value, 10);
      const categories = Array.from(overlay.querySelectorAll('.wai-cat-check input[type="checkbox"][value]:checked')).map((i) => i.value);
      let customTermsList = [];
      if (customToggle.checked) {
        customTermsList = customTerms.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).slice(0, 16);
      }
      close();
      onConfirm({
        difficulty,
        maxRounds,
        categories: categories.length ? categories : Object.keys(CATEGORY_META),
        customTerms: customTermsList,
      });
    });
  }

  // ---------------------------------------------------------------------
  // Identity search (final-guess autocomplete). Fetched once per mount and
  // cached - it's fully public data (see who_am_i.py: the LIST of possible
  // identities carries no per-match secrecy), so no per-keystroke request
  // is needed, just client-side prefix/substring filtering.
  // ---------------------------------------------------------------------
  let identityBankCache = null;
  async function loadIdentityBank() {
    if (identityBankCache) return identityBankCache;
    try {
      const data = await window.api("/api/whoami/identities");
      identityBankCache = data.identities || [];
    } catch (e) {
      identityBankCache = [];
    }
    return identityBankCache;
  }
  function searchIdentities(bank, query, limit) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const starts = [];
    const contains = [];
    for (const ident of bank) {
      const name = ident.name.toLowerCase();
      const hay = [name, ...(ident.aliases || []).map((a) => a.toLowerCase())];
      let matched = false, atStart = false;
      for (const h of hay) {
        if (h.startsWith(q)) { atStart = true; matched = true; break; }
        if (h.includes(q)) { matched = true; }
      }
      if (!matched) continue;
      (atStart ? starts : contains).push(ident);
    }
    return starts.concat(contains).slice(0, limit || 8);
  }

  function cardColorClass(index) {
    return `wai-card--c${(index % CARD_COLOR_COUNT) + 1}`;
  }

  // ---------------------------------------------------------------------
  // Main module
  // ---------------------------------------------------------------------
  function mount(stageEl, opts) {
    const { me, players, sendInput, sendRematch, isHost } = opts;

    stageEl.innerHTML = `
      <div class="wai-root">
        <div class="wai-topbar">
          <span class="wai-brand">🎭 Wer bin ich?</span>
          <span class="wai-round-info" data-role="round-info"></span>
          <button type="button" class="icon-btn wai-sound-toggle" title="Sound an/aus" aria-label="Sound an/aus">${soundEnabled() ? "🔊" : "🔇"}</button>
        </div>
        <div class="wai-stage"></div>
      </div>
    `;
    const stage = stageEl.querySelector(".wai-stage");
    const roundInfo = stageEl.querySelector('[data-role="round-info"]');
    const soundBtn = stageEl.querySelector(".wai-sound-toggle");
    soundBtn.addEventListener("click", () => {
      setSoundEnabled(!soundEnabled());
      soundBtn.textContent = soundEnabled() ? "🔊" : "🔇";
    });

    let lastState = null;
    let renderKey = null;
    let lastSeenGuessSeq = 0;
    let guessDialogOpen = false;

    function playerName(uid) {
      const s = lastState && lastState.players.find((p) => p.userId === uid);
      if (s) return s.name;
      const p = players.find((pl) => pl.id === uid);
      return p ? p.name : "?";
    }

    function computeRenderKey(state) {
      const votedFlag = state.phase === "voting" ? (state.myVote || (state.votingOpen ? "open" : "closed")) : "";
      return [state.phase, state.currentAskerId, state.questionNumberThisTurn, votedFlag].join("|");
    }

    function renderTurnBanner(state) {
      if (state.currentAskerId == null) return "";
      if (state.isMyTurn) return `<div class="wai-turn-banner wai-turn-banner--me">DU BIST DRAN</div>`;
      const name = playerName(state.currentAskerId);
      const verb = state.phase === "asking" ? "überlegt" : "ist dran";
      return `<div class="wai-turn-banner">${escapeHtml(name)} ${verb} …</div>`;
    }

    function renderOwnCard(state, justRevealed) {
      const self = state.players.find((p) => p.isSelf);
      if (!self) return "";
      const solved = self.solved;
      const flipClass = justRevealed ? "wai-card--flip" : "";
      return `
        <div class="wai-card wai-card--own ${cardColorClass(state.players.indexOf(self))} ${solved ? "wai-card--solved" : ""} ${flipClass}">
          <div class="wai-card-name">${escapeHtml(self.name)}</div>
          ${solved
            ? `<div class="wai-card-identity">${escapeHtml(self.identity.name)}</div><div class="wai-card-solved-badge">✓ Erraten!</div>`
            : `<div class="wai-card-question">❓</div><div class="wai-card-secret">GEHEIM</div><div class="wai-card-prompt">Wer bin ich?</div>`
          }
        </div>
      `;
    }

    function renderOtherCards(state) {
      const others = state.players.filter((p) => !p.isSelf);
      return `
        <div class="wai-others-row">
          ${others.map((p) => {
            const idx = state.players.indexOf(p);
            const isTurn = state.currentAskerId === p.userId;
            return `
              <div class="wai-card wai-card--other ${cardColorClass(idx)} ${p.solved ? "wai-card--solved" : ""} ${isTurn ? "wai-card--turn" : ""} ${!p.active ? "wai-card--inactive" : ""}">
                <div class="wai-card-name">${escapeHtml(p.name)}${!p.active ? " (weg)" : ""}</div>
                <div class="wai-card-identity">${p.identity ? escapeHtml(p.identity.name) : "?"}</div>
                ${p.solved ? `<div class="wai-card-solved-badge">✓</div>` : ""}
              </div>
            `;
          }).join("")}
        </div>
      `;
    }

    function renderAskingArea(state) {
      if (state.isMyTurn) {
        return `
          <div class="wai-action-card">
            <p class="wai-action-label">Stelle eine Ja-/Nein-Frage</p>
            <form class="wai-question-form">
              <input type="text" class="wai-question-input" maxlength="200" autocomplete="off" placeholder="z.B. Bin ich eine echte Person?" />
              <button type="submit" class="primary-btn wai-ask-btn">FRAGE STELLEN</button>
            </form>
            <div class="wai-turn-meta">Frage ${state.questionNumberThisTurn + 1}/${state.maxQuestionsPerTurn} · <span data-role="timer">${state.secondsLeft}</span>s</div>
            <button type="button" class="ghost-btn wai-guess-btn" data-role="open-guess">🎯 ICH WEISS ES</button>
          </div>
        `;
      }
      return `
        <div class="wai-action-card wai-action-card--waiting">
          <p class="wai-waiting-text">${escapeHtml(playerName(state.currentAskerId))} überlegt sich eine Frage …</p>
          <div class="wai-turn-meta"><span data-role="timer">${state.secondsLeft}</span>s</div>
        </div>
      `;
    }

    function renderVotingArea(state) {
      const voterEntries = (state.voterIds || []).map((vid) => ({
        userId: vid, name: playerName(vid), voted: !!(state.voteStatus && state.voteStatus[String(vid)]),
      }));
      const isAsker = state.currentAskerId === me.id;
      if (isAsker) {
        return `
          <div class="wai-action-card">
            <p class="wai-question-echo">Du fragst: „${escapeHtml(state.currentQuestion || "")}“</p>
            <p class="wai-waiting-text">Die anderen antworten …</p>
            <ul class="wai-vote-status-list">
              ${voterEntries.map((v) => `<li>${escapeHtml(v.name)} ${v.voted ? "✓" : "…"}</li>`).join("")}
            </ul>
            <div class="wai-turn-meta"><span data-role="timer">${state.secondsLeft}</span>s</div>
          </div>
        `;
      }
      if (state.votingOpen) {
        return `
          <div class="wai-action-card wai-vote-card">
            <p class="wai-question-echo">${escapeHtml(playerName(state.currentAskerId))} fragt:</p>
            <p class="wai-question-big">„${escapeHtml(state.currentQuestion || "")}“</p>
            <div class="wai-vote-buttons">
              <button type="button" class="wai-vote-btn wai-vote-btn--yes" data-choice="yes">✅ JA</button>
              <button type="button" class="wai-vote-btn wai-vote-btn--no" data-choice="no">❌ NEIN</button>
              <button type="button" class="wai-vote-btn wai-vote-btn--unclear" data-choice="unclear">🤷 UNKLAR</button>
            </div>
            <div class="wai-turn-meta"><span data-role="timer">${state.secondsLeft}</span>s</div>
          </div>
        `;
      }
      return `
        <div class="wai-action-card wai-action-card--waiting">
          <p class="wai-waiting-text">Du hast abgestimmt. Warte auf die anderen …</p>
          <ul class="wai-vote-status-list">
            ${voterEntries.map((v) => `<li>${escapeHtml(v.name)} ${v.voted ? "✓" : "…"}</li>`).join("")}
          </ul>
          <div class="wai-turn-meta"><span data-role="timer">${state.secondsLeft}</span>s</div>
        </div>
      `;
    }

    function renderVoteResultArea(state) {
      const vr = state.voteResult;
      if (!vr) return "";
      const map = { yes: { icon: "✅", label: "JA" }, no: { icon: "❌", label: "NEIN" }, unclear: { icon: "🤷", label: "UNKLAR" } };
      const m = map[vr.result] || map.unclear;
      return `
        <div class="wai-action-card wai-vote-result-card">
          <div class="wai-vote-result-big">${m.icon} ${m.label}</div>
          <div class="wai-vote-result-counts">${vr.yesCount}× Ja · ${vr.noCount}× Nein · ${vr.unclearCount}× Unklar</div>
        </div>
      `;
    }

    function renderHistory(state) {
      if (!state.history || !state.history.length) return "";
      const rows = state.history.slice().reverse().slice(0, 8);
      const map = { yes: "✅", no: "❌", unclear: "🤷" };
      return `
        <details class="wai-history">
          <summary>Verlauf (${state.history.length})</summary>
          <ul class="wai-history-list">
            ${rows.map((h) => `<li><strong>${escapeHtml(playerName(h.askerId))}:</strong> „${escapeHtml(h.question || "")}“ ${map[h.result] || ""}</li>`).join("")}
          </ul>
        </details>
      `;
    }

    function fullRender(state, justRevealed) {
      renderKey = computeRenderKey(state);
      const self = state.players.find((p) => p.isSelf);
      let actionHtml = "";
      if (state.phase === "asking") actionHtml = renderAskingArea(state);
      else if (state.phase === "voting") actionHtml = renderVotingArea(state);
      else if (state.phase === "vote_result") actionHtml = renderVoteResultArea(state);

      stage.innerHTML = `
        ${renderTurnBanner(state)}
        ${renderOwnCard(state, justRevealed)}
        ${renderOtherCards(state)}
        ${actionHtml}
        ${renderHistory(state)}
      `;
      roundInfo.textContent = self ? `Fragen: ${self.questionsAsked}` : "";

      const form = stage.querySelector(".wai-question-form");
      if (form) {
        const input = form.querySelector(".wai-question-input");
        input.focus();
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          const text = input.value.trim();
          if (!text) return;
          sendInput({ action: "ask_question", text });
          sfx.question();
        });
      }
      const guessBtn = stage.querySelector('[data-role="open-guess"]');
      if (guessBtn) guessBtn.addEventListener("click", () => openGuessDialog());

      for (const btn of stage.querySelectorAll(".wai-vote-btn")) {
        btn.addEventListener("click", () => {
          sendInput({ action: "vote", choice: btn.dataset.choice });
          for (const b of stage.querySelectorAll(".wai-vote-btn")) b.disabled = true;
          btn.classList.add("wai-vote-btn--picked");
        });
      }

      if (state.phase === "vote_result") sfx.voteResult();
    }

    function updateTickOnly(state) {
      const timerEls = stage.querySelectorAll('[data-role="timer"]');
      for (const t of timerEls) t.textContent = String(state.secondsLeft);
      if (state.phase === "voting") {
        const list = stage.querySelector(".wai-vote-status-list");
        if (list && state.voteStatus) {
          const isAsker = state.currentAskerId === me.id;
          const voterEntries = (state.voterIds || []).map((vid) => ({
            userId: vid, name: playerName(vid), voted: !!state.voteStatus[String(vid)],
          }));
          list.innerHTML = voterEntries.map((v) => `<li>${escapeHtml(v.name)} ${v.voted ? "✓" : "…"}</li>`).join("");
        }
      }
      const self = state.players.find((p) => p.isSelf);
      roundInfo.textContent = self ? `Fragen: ${self.questionsAsked}` : "";
    }

    function handleGuessResultSideEffects(state) {
      const lgr = state.lastGuessResult;
      if (!lgr || lgr.seq <= lastSeenGuessSeq) return;
      lastSeenGuessSeq = lgr.seq;
      if (lgr.userId === me.id) {
        if (lgr.correct) { sfx.correct(); haptic(40); }
        else { sfx.wrong(); haptic([30, 40, 30]); }
      }
    }

    function setState(state) {
      if (!state) return;
      const prev = lastState;
      lastState = state;
      handleGuessResultSideEffects(state);

      const justRevealed = !!(state.lastGuessResult && state.lastGuessResult.correct
        && state.lastGuessResult.userId === me.id
        && (!prev || !prev.lastGuessResult || prev.lastGuessResult.seq !== state.lastGuessResult.seq));

      const key = computeRenderKey(state);
      if (key !== renderKey || justRevealed) {
        fullRender(state, justRevealed);
      } else {
        updateTickOnly(state);
      }
    }

    // ---------------------------------------------------------------------
    // Final-guess dialog: separate small overlay, own autocomplete search
    // against the (already-fetched) full public identity bank. The dialog
    // never has access to - and never displays - which identity is "mine";
    // it searches the SAME full list every player sees, equally.
    // ---------------------------------------------------------------------
    async function openGuessDialog() {
      if (guessDialogOpen) return;
      guessDialogOpen = true;
      const bank = await loadIdentityBank();

      const overlay = document.createElement("div");
      overlay.className = "modal-overlay wai-guess-overlay";
      overlay.innerHTML = `
        <div class="modal wai-guess-modal">
          <div class="modal-head">
            <h2>Wer glaubst du, bist du?</h2>
            <button type="button" class="icon-btn" data-role="close">✕</button>
          </div>
          <div class="wai-guess-body">
            <input type="text" class="wai-guess-input" autocomplete="off" placeholder="Namen eingeben …" />
            <ul class="wai-guess-suggestions" data-role="suggestions"></ul>
          </div>
          <div class="wai-guess-actions">
            <button type="button" class="ghost-btn" data-role="cancel">Abbrechen</button>
            <button type="button" class="primary-btn" data-role="confirm" disabled>TIPP ABGEBEN</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      let selected = null;
      function close() { overlay.remove(); guessDialogOpen = false; }
      overlay.querySelector('[data-role="close"]').addEventListener("click", close);
      overlay.querySelector('[data-role="cancel"]').addEventListener("click", close);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

      const input = overlay.querySelector(".wai-guess-input");
      const suggestionsEl = overlay.querySelector('[data-role="suggestions"]');
      const confirmBtn = overlay.querySelector('[data-role="confirm"]');
      input.focus();

      function renderSuggestions(list) {
        suggestionsEl.innerHTML = list.map((ident) => `
          <li class="wai-guess-suggestion" data-id="${escapeHtml(ident.id)}">${escapeHtml(ident.name)}</li>
        `).join("");
        for (const li of suggestionsEl.querySelectorAll(".wai-guess-suggestion")) {
          li.addEventListener("click", () => {
            const ident = list.find((i) => i.id === li.dataset.id);
            selected = ident;
            input.value = ident.name;
            confirmBtn.disabled = false;
            suggestionsEl.innerHTML = "";
          });
        }
      }

      input.addEventListener("input", () => {
        selected = null;
        confirmBtn.disabled = true;
        const matches = searchIdentities(bank, input.value, 8);
        renderSuggestions(matches);
      });

      confirmBtn.addEventListener("click", () => {
        if (selected) {
          sendInput({ action: "final_guess", identityId: selected.id });
        } else if (input.value.trim()) {
          sendInput({ action: "final_guess", guessText: input.value.trim() });
        } else {
          return;
        }
        close();
      });
    }

    // ---------------------------------------------------------------------
    // Endscreen
    // ---------------------------------------------------------------------
    function renderEndscreen(endscreen) {
      const podium = endscreen.leaderboard.slice(0, 3);
      const rest = endscreen.leaderboard.slice(3);
      const medals = ["🥇", "🥈", "🥉"];
      stage.innerHTML = `
        <div class="wai-card wai-endscreen">
          <div class="wai-endscreen-title">🏆 WER BIN ICH? – ERGEBNIS</div>
          <ol class="wai-podium-list">
            ${podium.map((p, i) => `
              <li class="wai-podium-entry">
                <span class="wai-podium-medal">${medals[i]}</span>
                <span class="wai-podium-name">${escapeHtml(p.name)}</span>
                <span class="wai-podium-identity">${escapeHtml(p.identity.name)}</span>
                <span class="wai-podium-score">${p.solved ? `${p.score} Punkte` : "Nicht erraten"}</span>
                <span class="wai-podium-questions">${p.solved ? `${p.questionsAsked} Fragen` : ""}</span>
              </li>
            `).join("")}
          </ol>
          ${rest.length ? `
            <ol class="wai-rest-list" start="4">
              ${rest.map((p) => `
                <li>
                  <span>${escapeHtml(p.name)}</span>
                  <span>${escapeHtml(p.identity.name)}</span>
                  <span>${p.solved ? `${p.score} Punkte` : "Nicht erraten"}</span>
                </li>
              `).join("")}
            </ol>
          ` : ""}
          <div class="wai-endscreen-actions">
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
        <div class="wai-card wai-endscreen">
          <div class="wai-endscreen-title">Spiel beendet</div>
          <p>${escapeHtml(reasonText)}</p>
          <div class="wai-endscreen-actions">
            <button type="button" class="ghost-btn" data-role="leave">SPIEL VERLASSEN</button>
          </div>
        </div>
      `;
      const leaveBtn = stage.querySelector('[data-role="leave"]');
      if (leaveBtn) leaveBtn.addEventListener("click", () => { opts.closeGame && opts.closeGame(); });
    }

    function destroy() {
      const overlay = document.querySelector(".wai-guess-overlay");
      if (overlay) overlay.remove();
    }

    return {
      setState,
      showGameOver,
      destroy,
      _debugLastState() { return lastState; },
    };
  }

  window.WhoAmI = { mount, openHostOptionsModal };
})();
