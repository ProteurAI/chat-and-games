// ============================================================================
// Sortiermeister - party game for Chat & Games: put five things in order.
//
// Server-authoritative like majority-game.js: questions, shuffles, scoring and
// the secrecy of the true order come from backend/sort_game.py through the
// existing game_state / game_over events; this module renders what it is given
// and sends {action:"submit", order:[ids]} / {action:"next"} through the same
// game_input channel every other multiplayer game uses.
//
// Input: drag a card (mouse, touch, pen - pointer events) or use the arrow
// buttons. Before the reveal no value and no true order is in the state.
//
// window.SortGame.mount(stageEl, opts) -> { setState(state), showGameOver(data), destroy() }
// window.SortGame.openHostOptionsModal(onConfirm)
// ============================================================================

(function () {
  "use strict";

  const ROW = 78;           // px per slot (card height 66 + gap 12) - the slots are absolutely positioned
  const SOUND_KEY = "majority_sound_enabled";
  const CAT_EMOJI = { tiere: "🐾", technik: "💻", essen: "🍔", geografie: "🌍", geschichte: "🏛️", film: "🎬", sport: "⚽", alltag: "🏠", at_de: "🥨", absurd: "🤪" };

  function soundEnabled() { try { return localStorage.getItem(SOUND_KEY) !== "0"; } catch (e) { return true; } }
  function setSoundEnabled(v) { try { localStorage.setItem(SOUND_KEY, v ? "1" : "0"); } catch (e) { /* ignore */ } }
  let audioCtx = null;
  function beep(freq, dur, type, gain) {
    if (!soundEnabled()) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
      osc.type = type || "sine"; osc.frequency.value = freq; g.gain.value = gain != null ? gain : 0.05;
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
      osc.connect(g); g.connect(audioCtx.destination); osc.start(); osc.stop(audioCtx.currentTime + dur);
    } catch (e) { /* best-effort only */ }
  }
  const sfx = {
    pick: () => beep(420, 0.05, "sine", 0.03),
    drop: () => beep(520, 0.07, "sine", 0.04),
    lock: () => { beep(480, 0.1, "sine", 0.045); setTimeout(() => beep(640, 0.1, "sine", 0.045), 90); },
    good: () => beep(760, 0.12, "sine", 0.05),
    near: () => beep(520, 0.1, "triangle", 0.04),
    bad: () => beep(200, 0.14, "sawtooth", 0.025),
    win: () => { beep(523, 0.12, "sine", 0.06); setTimeout(() => beep(659, 0.12, "sine", 0.06), 120); setTimeout(() => beep(784, 0.22, "sine", 0.06), 240); },
  };
  function haptic(p) { if (window.MobileUX && typeof window.MobileUX.vibrate === "function") window.MobileUX.vibrate(p); }
  function escapeHtml(str) { const d = document.createElement("div"); d.textContent = str == null ? "" : String(str); return d.innerHTML; }
  const reducedMotion = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  // "1.420", "0,31", years without a thousands dot; an item may bring its own text
  function formatValue(item, unit) {
    if (item.text) return item.text;
    const v = item.value;
    if (unit === "" && Number.isInteger(v) && v >= 1000 && v <= 2100) return String(v);
    const abs = Math.abs(v);
    const s = v.toLocaleString("de-DE", { maximumFractionDigits: abs >= 100 ? 0 : abs >= 1 ? 2 : 3 });
    return unit ? `${s} ${unit}` : s;
  }

  function openHostOptionsModal(onConfirm) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal mg-options-modal">
        <div class="modal-head"><h2>🔢 Sortiermeister erstellen</h2><button type="button" class="icon-btn" data-role="close">✕</button></div>
        <div class="mg-options-body">
          <p class="mg-waiting-text">Fünf Dinge pro Runde – bring sie in die richtige Reihenfolge. Allein oder mit der ganzen Runde.</p>
          <div class="mg-options-group">
            <div class="mg-options-label">Runden</div>
            <div class="mg-options-chips" data-role="rounds">
              <button type="button" class="mg-chip" data-value="5">5</button>
              <button type="button" class="mg-chip mg-chip--active" data-value="10">10</button>
              <button type="button" class="mg-chip" data-value="15">15</button>
            </div>
          </div>
        </div>
        <div class="mg-options-actions"><button type="button" class="ghost-btn" data-role="cancel">Abbrechen</button><button type="button" class="primary-btn" data-role="confirm">Spiel erstellen</button></div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('[data-role="close"]').addEventListener("click", close);
    overlay.querySelector('[data-role="cancel"]').addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    const group = overlay.querySelector(".mg-options-chips");
    group.addEventListener("click", (e) => {
      const btn = e.target.closest(".mg-chip");
      if (!btn) return;
      for (const c of group.querySelectorAll(".mg-chip")) c.classList.remove("mg-chip--active");
      btn.classList.add("mg-chip--active");
    });
    overlay.querySelector('[data-role="confirm"]').addEventListener("click", () => {
      const rounds = parseInt(group.querySelector(".mg-chip--active").dataset.value, 10);
      close();
      onConfirm({ rounds });
    });
  }

  function mount(stageEl, opts) {
    const { me, sendInput, sendRematch, isHost } = opts;
    stageEl.innerHTML = `
      <div class="mg-root sm-root">
        <div class="mg-topbar">
          <span class="mg-round-info" data-role="round-info"></span>
          <button type="button" class="icon-btn mg-sound-toggle" title="Sound an/aus" aria-label="Sound an/aus">${soundEnabled() ? "🔊" : "🔇"}</button>
        </div>
        <div class="mg-stage sm-stage"></div>
      </div>`;
    const stage = stageEl.querySelector(".mg-stage");
    const roundInfo = stageEl.querySelector('[data-role="round-info"]');
    const soundBtn = stageEl.querySelector(".mg-sound-toggle");
    soundBtn.addEventListener("click", () => { setSoundEnabled(!soundEnabled()); soundBtn.textContent = soundEnabled() ? "🔊" : "🔇"; });

    let lastState = null, renderKey = null, order = [], locked = false, timers = [], cleanupDrag = null;
    const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; };
    function clearTimers() { for (const t of timers) clearTimeout(t); timers = []; }
    const playerName = (uid) => { const p = lastState && lastState.players.find((pl) => pl.userId === uid); return p ? p.name : "?"; };

    // ------------------------------------------------------------ sorting
    function renderSorting(state) {
      const itemById = new Map(state.items.map((it) => [it.id, it]));
      if (state.mySubmitted && state.myOrder) { order = state.myOrder.slice(); locked = true; }
      else { order = state.items.map((it) => it.id); locked = false; }
      stage.innerHTML = `
        <div class="sm-head">
          <span class="sm-cat">${CAT_EMOJI[state.category] || "❓"} ${escapeHtml(state.categoryLabel)}</span>
          <h2 class="sm-question">${escapeHtml(state.question)}</h2>
          <div class="sm-direction"><span>1</span> ${escapeHtml(state.direction)} <span>5</span></div>
        </div>
        <div class="sm-list" data-role="list" style="height:${ROW * 5 - 12}px"></div>
        <div class="sm-actions">
          <button type="button" class="primary-btn sm-lock" data-role="lock">EINLOGGEN</button>
          <div class="mg-turn-meta"><span data-role="timer">${state.secondsLeft}</span>s</div>
        </div>
        <ul class="mg-status-list" data-role="status"></ul>`;
      const list = stage.querySelector('[data-role="list"]');
      const cards = new Map();
      for (const it of state.items) {
        const el = document.createElement("div");
        el.className = "sm-card";
        el.dataset.id = String(it.id);
        el.innerHTML = `<span class="sm-num"></span><span class="sm-label">${escapeHtml(itemById.get(it.id).label)}</span>
          <span class="sm-move"><button type="button" class="sm-arrow" data-dir="-1" aria-label="nach oben">▲</button><button type="button" class="sm-arrow" data-dir="1" aria-label="nach unten">▼</button></span>
          <span class="sm-grip" aria-hidden="true">⠿</span>`;
        list.appendChild(el);
        cards.set(it.id, el);
      }
      const lockBtn = stage.querySelector('[data-role="lock"]');

      function layout(dragId, dragTop) {
        order.forEach((id, pos) => {
          const el = cards.get(id);
          el.querySelector(".sm-num").textContent = String(pos + 1);
          if (id === dragId) { el.style.top = dragTop + "px"; return; }
          el.style.top = pos * ROW + "px";
        });
      }
      function applyLocked() {
        list.classList.toggle("sm-list--locked", locked);
        lockBtn.disabled = locked;
        lockBtn.textContent = locked ? "✓ EINGELOGGT" : "EINLOGGEN";
      }
      layout();
      applyLocked();

      function move(id, delta) {
        if (locked) return;
        const i = order.indexOf(id), j = i + delta;
        if (j < 0 || j >= order.length) return;
        order.splice(i, 1); order.splice(j, 0, id);
        layout(); sfx.drop(); haptic(8);
      }
      for (const [id, el] of cards) {
        for (const b of el.querySelectorAll(".sm-arrow")) b.addEventListener("click", (e) => { e.stopPropagation(); move(id, parseInt(b.dataset.dir, 10)); });
        el.addEventListener("pointerdown", (e) => {
          if (locked || e.button > 0 || e.target.closest(".sm-arrow")) return;
          e.preventDefault();
          const startY = e.clientY, startTop = order.indexOf(id) * ROW;
          el.setPointerCapture(e.pointerId);
          el.classList.add("sm-card--drag");
          sfx.pick(); haptic(6);
          const onMove = (ev) => {
            const top = Math.max(0, Math.min(ROW * 4, startTop + (ev.clientY - startY)));
            const target = Math.max(0, Math.min(4, Math.round(top / ROW)));
            const cur = order.indexOf(id);
            if (target !== cur) { order.splice(cur, 1); order.splice(target, 0, id); sfx.pick(); }
            layout(id, top);
          };
          const onUp = () => {
            el.removeEventListener("pointermove", onMove);
            el.removeEventListener("pointerup", onUp);
            el.removeEventListener("pointercancel", onUp);
            el.classList.remove("sm-card--drag");
            layout(); sfx.drop(); haptic(8);
            cleanupDrag = null;
          };
          el.addEventListener("pointermove", onMove);
          el.addEventListener("pointerup", onUp);
          el.addEventListener("pointercancel", onUp);
          cleanupDrag = onUp;
        });
      }
      lockBtn.addEventListener("click", () => {
        if (locked) return;
        locked = true;
        applyLocked();
        sendInput({ action: "submit", order: order.slice() });
        sfx.lock(); haptic(15);
      });
      updateTickOnly(state);
    }

    // ------------------------------------------------------------ reveal
    function renderReveal(state) {
      const rr = state.roundResult;
      if (!rr) { stage.innerHTML = `<div class="mg-question-card"><p class="mg-waiting-text">Auswertung läuft …</p></div>`; return; }
      const mine = (rr.results || []).find((r) => r.userId === me.id);
      const start = mine && mine.submitted ? mine.order : rr.correct.map((c) => c.id);          // where my cards were
      const myPos = new Map(start.map((id, p) => [id, p]));
      const submitted = !!(mine && mine.submitted);
      stage.innerHTML = `
        <div class="sm-head sm-head--reveal">
          <span class="sm-cat">${CAT_EMOJI[rr.category] || "❓"} ${escapeHtml(rr.categoryLabel || "")}</span>
          <h2 class="sm-question">${escapeHtml(rr.question)}</h2>
          <div class="sm-direction"><span>1</span> ${escapeHtml(rr.direction)} <span>5</span></div>
        </div>
        <div class="sm-list sm-list--reveal" style="height:${ROW * 5 - 12}px"></div>
        <div class="sm-score-line" data-role="points"></div>
        <p class="sm-explain" data-role="explain" hidden>${escapeHtml(rr.explanation)}</p>
        <div class="sm-others" data-role="others" hidden></div>
        <div class="sm-actions"><button type="button" class="primary-btn" data-role="next">${state.roundIndex >= state.totalRounds ? "ERGEBNIS" : "WEITER"}</button>
          <div class="mg-turn-meta" data-role="ready"></div></div>`;
      const list = stage.querySelector(".sm-list");
      const els = rr.correct.map((c, rank) => {
        const p = myPos.get(c.id), d = submitted ? Math.abs(p - rank) : 9;
        const el = document.createElement("div");
        el.className = "sm-card sm-card--reveal";
        el.dataset.id = String(c.id);
        el.dataset.verdict = !submitted ? "none" : d === 0 ? "good" : d === 1 ? "near" : "bad";
        el.style.top = p * ROW + "px";
        el.innerHTML = `<span class="sm-num">${submitted ? p + 1 : "?"}</span><span class="sm-label">${escapeHtml(c.label)}</span>
          <span class="sm-valbox"><span class="sm-value">${escapeHtml(formatValue(c, rr.unit))}</span>
          <span class="sm-tip">${submitted ? (d === 0 ? "genau richtig" : `Platz ${p + 1} statt ${rank + 1}`) : ""}</span></span>`;
        list.appendChild(el);
        return { el, c, rank, p, d };
      });
      const calm = reducedMotion();
      // the cards slide from where I put them to where they belong, one after the other, then show their verdict
      els.forEach(({ el, rank, d }, k) => {
        later(() => {
          el.style.transitionDelay = "0ms";
          el.style.top = rank * ROW + "px";
          el.querySelector(".sm-num").textContent = String(rank + 1);
          el.classList.add("sm-card--landed");
        }, (calm ? 0 : 700) + k * (calm ? 0 : 260));
        later(() => {
          el.classList.add("sm-card--verdict");
          if (d === 0) sfx.good(); else if (d === 1) sfx.near(); else if (submitted) sfx.bad();
          if (d === 0) haptic(10);
        }, (calm ? 0 : 700) + k * (calm ? 0 : 260) + (calm ? 0 : 520));
      });
      const total = (calm ? 0 : 700) + 4 * (calm ? 0 : 260) + (calm ? 0 : 700);
      later(() => {
        const pts = stage.querySelector('[data-role="points"]');
        if (!submitted) pts.innerHTML = `<span class="sm-pts sm-pts--none">Nicht eingeloggt – 0 Punkte</span>`;
        else {
          pts.innerHTML = `<span class="sm-pts ${mine.points >= 10 ? "sm-pts--great" : mine.points >= 5 ? "sm-pts--ok" : ""}">+${mine.points} ${mine.points === 1 ? "Punkt" : "Punkte"}</span>${mine.bonus ? `<span class="sm-bonus">🎯 Alle fünf richtig! +${mine.bonus} Bonus</span>` : ""}`;
          if (mine.bonus) sfx.win();
        }
        stage.querySelector('[data-role="explain"]').hidden = false;
        const others = stage.querySelector('[data-role="others"]');
        const sorted = (state.players || []).filter((p) => p.active).slice().sort((a, b) => b.score - a.score);
        const gained = new Map((rr.results || []).map((r) => [r.userId, r]));
        others.innerHTML = sorted.map((p) => {
          const g = gained.get(p.userId);
          return `<div class="sm-other ${p.userId === me.id ? "sm-other--me" : ""}"><span class="sm-other-name">${escapeHtml(p.name)}</span>
            <span class="sm-other-gain">${g && g.submitted ? "+" + g.points : "–"}</span><span class="sm-other-total">${p.score}</span></div>`;
        }).join("");
        others.hidden = false;
      }, total);
      const nextBtn = stage.querySelector('[data-role="next"]');
      nextBtn.addEventListener("click", () => { nextBtn.disabled = true; nextBtn.textContent = "✓ bereit"; sendInput({ action: "next" }); });
      updateTickOnly(state);
    }

    function computeRenderKey(s) {
      if (s.phase === "sorting") return ["sorting", s.roundIndex, s.questionId].join("|");
      if (s.phase === "reveal") return ["reveal", s.roundIndex].join("|");
      return s.phase;
    }

    function fullRender(state) {
      clearTimers();
      if (cleanupDrag) cleanupDrag();
      renderKey = computeRenderKey(state);
      if (state.phase === "sorting") renderSorting(state);
      else if (state.phase === "reveal") renderReveal(state);
      roundInfo.textContent = `Runde ${state.roundIndex} / ${state.totalRounds}`;
    }

    function updateTickOnly(state) {
      for (const t of stage.querySelectorAll('[data-role="timer"]')) t.textContent = String(state.secondsLeft);
      const status = stage.querySelector('[data-role="status"]');
      if (status && state.submissionStatus) {
        const ids = Object.keys(state.submissionStatus);
        status.innerHTML = ids.length > 1 ? ids.map((u) => `<li>${escapeHtml(playerName(parseInt(u, 10)))} ${state.submissionStatus[u] ? "✓" : "…"}</li>`).join("") : "";
      }
      const ready = stage.querySelector('[data-role="ready"]');
      if (ready && state.phase === "reveal") {
        const act = (state.players || []).filter((p) => p.active).length;
        ready.textContent = act > 1 ? `${(state.ready || []).length} / ${act} bereit · ${state.secondsLeft}s` : "";
      }
      roundInfo.textContent = `Runde ${state.roundIndex} / ${state.totalRounds}`;
    }

    function setState(state) {
      if (!state) return;
      lastState = state;
      if (state.phase === "finished") return;
      if (computeRenderKey(state) !== renderKey) fullRender(state);
      else updateTickOnly(state);
    }

    // ------------------------------------------------------------ end
    function renderEndscreen(end) {
      clearTimers();
      const podium = end.leaderboard.slice(0, 3), rest = end.leaderboard.slice(3), medals = ["🥇", "🥈", "🥉"], fs = end.funStats || {};
      const max = (end.totalRounds || 10) * (end.maxPerRound || 13);
      stage.innerHTML = `
        <div class="mg-question-card mg-endscreen">
          <div class="mg-endscreen-title">🔢 SORTIERMEISTER 🔢</div>
          <ol class="mg-podium-list">${podium.map((p, i) => `<li class="mg-podium-entry"><span class="mg-podium-medal">${medals[i]}</span><span class="mg-podium-name">${escapeHtml(p.name)}</span><span class="mg-podium-score">${p.score} / ${max}</span></li>`).join("")}</ol>
          ${rest.length ? `<ol class="mg-rest-list" start="4">${rest.map((p) => `<li><span>${escapeHtml(p.name)}</span><span>${p.score} Punkte</span></li>`).join("")}</ol>` : ""}
          <div class="mg-fun-stats">
            ${fs.perfect ? `<div class="mg-fun-stat"><strong>${fs.perfect.label}</strong><span>${escapeHtml(fs.perfect.name)} – ${escapeHtml(fs.perfect.detail)}</span></div>` : ""}
            ${fs.best ? `<div class="mg-fun-stat"><strong>${fs.best.label}</strong><span>${escapeHtml(fs.best.name)} – ${escapeHtml(fs.best.detail)}</span></div>` : ""}
          </div>
          <div class="mg-endscreen-actions">
            ${isHost ? `<button type="button" class="primary-btn" data-role="rematch">NOCHMAL SPIELEN</button>` : ""}
            <button type="button" class="ghost-btn" data-role="leave">SPIEL VERLASSEN</button>
          </div>
        </div>`;
      const r = stage.querySelector('[data-role="rematch"]');
      if (r) r.addEventListener("click", () => { renderKey = null; sendRematch(); });
      const l = stage.querySelector('[data-role="leave"]');
      if (l) l.addEventListener("click", () => { opts.closeGame && opts.closeGame(); });
      sfx.win();
    }

    function showGameOver(data) {
      if (data && data.details) { renderEndscreen(data.details); return; }
      clearTimers();
      const reason = data && data.reason === "opponent_left" ? "Ein Mitspieler hat das Spiel verlassen - die Partie wurde beendet." : "Die Partie wurde beendet.";
      stage.innerHTML = `<div class="mg-question-card mg-endscreen"><div class="mg-endscreen-title">Spiel beendet</div><p>${escapeHtml(reason)}</p>
        <div class="mg-endscreen-actions"><button type="button" class="ghost-btn" data-role="leave">SPIEL VERLASSEN</button></div></div>`;
      const l = stage.querySelector('[data-role="leave"]');
      if (l) l.addEventListener("click", () => { opts.closeGame && opts.closeGame(); });
    }

    function destroy() { clearTimers(); if (cleanupDrag) cleanupDrag(); }

    return { setState, showGameOver, destroy, _debugLastState() { return lastState; }, _debugOrder() { return order.slice(); } };
  }

  window.SortGame = { mount, openHostOptionsModal, formatValue };
})();
