// ============================================================================
// Operation Smartphone - shared mobile UX building blocks, used by app.js
// and every game module instead of each game inventing its own touch/chat
// handling. Loaded before app.js and before any game module.
//
// Exposes on window:
//   MobileGameChat  - the ONE game-chat drawer, shared by every game
//   VirtualJoystick  - analog stick factory (Tank Battle, Dodge Arena)
//   TouchDPad        - 4-way directional pad factory (Light Cycles)
//   MobileUX         - small shared helpers (haptics, viewport, touch-target)
// ============================================================================

(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // MobileGameChat - the single game-chat drawer implementation.
  //
  // Root cause of the old "chat gets stuck on mobile" bug: the drawer was
  // sized with a plain CSS percentage (min(70%, 480px)) of the LAYOUT
  // viewport, which most mobile browsers do NOT shrink when the on-screen
  // keyboard opens (they resize the VISUAL viewport instead and just let
  // the keyboard cover whatever's underneath). Once the keyboard covered
  // the drawer's own close button, there was no other way to dismiss it
  // (no backdrop, no swipe, no Escape) - the player was genuinely stuck.
  //
  // Fixed by: tracking window.visualViewport directly to keep the drawer
  // sized/positioned against the ACTUAL visible area (so the header/close
  // button can never end up under the keyboard), and by adding THREE
  // independent, redundant ways to close it (backdrop tap, swipe-down on
  // the header, Escape) so no single failure mode can trap the player
  // again. State is a single `open` boolean behind a closure, mutated
  // only by open()/close() - never a scattered classList toggle from
  // multiple call sites - and init() is idempotent so remounting a game
  // modal can never double-register listeners or stack backdrops.
  // ---------------------------------------------------------------------
  const MobileGameChat = (function () {
    let panel, backdrop, toggleBtn, closeBtn, header, badge, messagesBox, inputEl;
    let open = false;
    let unread = 0;
    let initialized = false;
    let hideBackdropTimer = null;

    function isMobileLayout() {
      return !window.matchMedia("(min-width: 900px)").matches;
    }

    function applyViewportOffset() {
      if (!open || !isMobileLayout() || !window.visualViewport) return;
      const vv = window.visualViewport;
      // How much of the layout viewport's bottom is currently covered by
      // the keyboard (or any other visual-viewport-shrinking chrome).
      const bottomInset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      panel.style.setProperty("--kb-inset", `${bottomInset}px`);
      panel.style.maxHeight = `${Math.max(180, Math.min(vv.height * 0.85, 560))}px`;
    }

    function lockScroll() { document.body.classList.add("scroll-locked"); }
    function unlockScroll() { document.body.classList.remove("scroll-locked"); }

    function updateBadge() {
      if (!badge) return;
      if (unread > 0) { badge.textContent = String(unread); badge.hidden = false; }
      else badge.hidden = true;
    }

    function doOpen() {
      if (open || !panel) return;
      open = true;
      clearTimeout(hideBackdropTimer);
      backdrop.hidden = false;
      // Force layout before adding .open so the transform transition
      // actually plays instead of starting from its own end state.
      void backdrop.offsetHeight;
      panel.classList.add("open");
      backdrop.classList.add("open");
      unread = 0;
      updateBadge();
      if (isMobileLayout()) lockScroll();
      applyViewportOffset();
      if (messagesBox) messagesBox.scrollTop = messagesBox.scrollHeight;
    }

    function doClose() {
      if (!open || !panel) return;
      open = false;
      panel.classList.remove("open");
      backdrop.classList.remove("open");
      panel.style.transform = "";
      panel.style.maxHeight = "";
      panel.style.removeProperty("--kb-inset");
      unlockScroll();
      if (inputEl) inputEl.blur();
      // Keep the backdrop in the DOM (pointer-events aware) until its own
      // fade-out transition has actually finished, THEN set hidden - never
      // leave a zero-opacity-but-still-hit-testable layer behind.
      clearTimeout(hideBackdropTimer);
      hideBackdropTimer = setTimeout(() => { if (!open) backdrop.hidden = true; }, 300);
    }

    function toggle() { if (open) doClose(); else doOpen(); }

    function bump() {
      if (open || !isMobileLayout()) return;
      unread++;
      updateBadge();
    }

    // ---- swipe-to-close: drag the header down past a threshold ----
    let dragStartY = null, dragY = 0, dragPointerId = null;
    function onHeaderDown(e) {
      if (!isMobileLayout()) return;
      // Never start a drag/capture from the close button itself - pointer
      // capture on an ancestor can suppress the button's own synthesized
      // click in some browsers, which would make the ONE guaranteed close
      // path (the button) flaky exactly when it matters most.
      if (e.target.closest && e.target.closest("#game-chat-close-btn")) return;
      dragStartY = e.clientY;
      dragY = 0;
      dragPointerId = e.pointerId;
      try { header.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    function onHeaderMove(e) {
      if (dragStartY === null || e.pointerId !== dragPointerId) return;
      dragY = Math.max(0, e.clientY - dragStartY);
      panel.style.transform = dragY > 0 ? `translateY(${dragY}px)` : "";
    }
    function onHeaderUp(e) {
      if (dragStartY === null || (e && e.pointerId !== dragPointerId)) return;
      const dragged = dragY;
      dragStartY = null;
      dragPointerId = null;
      panel.style.transform = "";
      if (dragged > 70) doClose();
    }

    function onKeyDown(e) {
      if (e.key === "Escape" && open) doClose();
    }

    function init(elements) {
      if (initialized) return; // never double-register, even if called again
      initialized = true;
      panel = elements.panel;
      toggleBtn = elements.toggleBtn;
      closeBtn = elements.closeBtn;
      header = elements.header;
      badge = elements.badge;
      messagesBox = elements.messagesBox;
      inputEl = elements.inputEl;

      backdrop = document.createElement("div");
      backdrop.className = "game-chat-backdrop";
      backdrop.hidden = true;
      panel.insertAdjacentElement("beforebegin", backdrop);

      backdrop.addEventListener("click", doClose);
      toggleBtn.addEventListener("click", doOpen);
      closeBtn.addEventListener("click", doClose);
      header.addEventListener("pointerdown", onHeaderDown);
      header.addEventListener("pointermove", onHeaderMove);
      header.addEventListener("pointerup", onHeaderUp);
      header.addEventListener("pointercancel", onHeaderUp);
      document.addEventListener("keydown", onKeyDown);

      if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", applyViewportOffset);
        window.visualViewport.addEventListener("scroll", applyViewportOffset);
      }
      window.addEventListener("orientationchange", () => setTimeout(applyViewportOffset, 250));
    }

    // Called whenever a game modal is opened/closed, so a leftover open
    // drawer or scroll-lock from a previous game can never bleed into the
    // next one.
    function reset() {
      open = false;
      unread = 0;
      clearTimeout(hideBackdropTimer);
      if (panel) { panel.classList.remove("open"); panel.style.transform = ""; panel.style.maxHeight = ""; panel.style.removeProperty("--kb-inset"); }
      if (backdrop) { backdrop.classList.remove("open"); backdrop.hidden = true; }
      unlockScroll();
      updateBadge();
    }

    return { init, open: doOpen, close: doClose, toggle, bump, isOpen: () => open, reset };
  })();

  // ---------------------------------------------------------------------
  // VirtualJoystick - analog stick used by Tank Battle (x2) and Dodge
  // Arena. A shared, single implementation instead of copy-pasted per
  // game, with a deadzone and a global blur/visibilitychange safety net:
  // if a pointer is lost without a matching pointerup (app switch,
  // notification, incoming call - a real pointercancel is already handled
  // per-instance, but window blur/tab hide often DON'T fire pointercancel
  // at all), every live joystick snaps back to neutral so a game input
  // can never get stuck "on" indefinitely.
  // ---------------------------------------------------------------------
  const VirtualJoystick = (function () {
    const instances = new Set();

    function create(zoneEl, knobEl, opts) {
      opts = opts || {};
      const maxR = opts.maxRadius || 40;
      const deadzone = opts.deadzone != null ? opts.deadzone : 0.12;
      const onChange = opts.onChange || function () {};
      let active = false, pointerId = null, cx = 0, cy = 0;

      function applyDeadzone(nx, ny) {
        const mag = Math.hypot(nx, ny);
        if (mag < deadzone) return { x: 0, y: 0 };
        const scale = (mag - deadzone) / (1 - deadzone) / mag;
        return { x: nx * scale, y: ny * scale };
      }

      function start(e) {
        if (active) return;
        active = true; pointerId = e.pointerId;
        const rect = zoneEl.getBoundingClientRect();
        cx = rect.left + rect.width / 2; cy = rect.top + rect.height / 2;
        try { zoneEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        // Deliberately not calling move() here - a fresh touch-down is
        // centered (0,0) in the overwhelming majority of cases, and
        // routing that through onChange would start a caller-side send
        // throttle clock before the player's first real drag, sometimes
        // swallowing it.
        e.preventDefault();
      }
      function move(e) {
        if (!active || e.pointerId !== pointerId) return;
        let dx = e.clientX - cx, dy = e.clientY - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > maxR) { dx = (dx / dist) * maxR; dy = (dy / dist) * maxR; }
        knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
        const norm = applyDeadzone(dx / maxR, dy / maxR);
        onChange(norm.x, norm.y);
        e.preventDefault();
      }
      function reset() {
        active = false; pointerId = null;
        knobEl.style.transform = "translate(0,0)";
        onChange(0, 0);
      }
      function end(e) {
        if (e && e.pointerId !== pointerId) return;
        reset();
      }

      zoneEl.addEventListener("pointerdown", start);
      zoneEl.addEventListener("pointermove", move);
      zoneEl.addEventListener("pointerup", end);
      zoneEl.addEventListener("pointercancel", end);

      const instance = {
        reset,
        destroy() {
          zoneEl.removeEventListener("pointerdown", start);
          zoneEl.removeEventListener("pointermove", move);
          zoneEl.removeEventListener("pointerup", end);
          zoneEl.removeEventListener("pointercancel", end);
          instances.delete(instance);
        },
      };
      instances.add(instance);
      return instance;
    }

    function resetAll() { for (const inst of instances) inst.reset(); }
    window.addEventListener("blur", resetAll);
    document.addEventListener("visibilitychange", () => { if (document.hidden) resetAll(); });

    return { create, resetAll };
  })();

  // ---------------------------------------------------------------------
  // TouchDPad - simple 4-way directional pad (Light Cycles). Each button
  // just reports its direction on press; direction-reversal rules (no
  // instant 180) are already enforced server-side (see LightCyclesEngine),
  // exactly like the existing arrow-key handler already relies on - the
  // pad doesn't need to duplicate that logic.
  // ---------------------------------------------------------------------
  const TouchDPad = {
    create(container, onDirection) {
      container.innerHTML = "";
      container.className = "touch-dpad";
      const dirs = [
        { dir: "up", label: "▲" },
        { dir: "left", label: "◀" },
        { dir: "right", label: "▶" },
        { dir: "down", label: "▼" },
      ];
      const cleanups = [];
      for (const d of dirs) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `touch-dpad-btn touch-dpad-btn--${d.dir}`;
        btn.textContent = d.label;
        btn.setAttribute("aria-label", `Richtung ${d.dir}`);
        const handler = (e) => { e.preventDefault(); onDirection(d.dir); };
        btn.addEventListener("pointerdown", handler);
        cleanups.push(() => btn.removeEventListener("pointerdown", handler));
        container.appendChild(btn);
      }
      return { destroy() { cleanups.forEach((fn) => fn()); container.innerHTML = ""; } };
    },
  };

  // ---------------------------------------------------------------------
  // MobileUX - small shared helpers.
  // ---------------------------------------------------------------------
  const MobileUX = {
    isCoarsePointer() {
      return window.matchMedia("(pointer: coarse)").matches;
    },
    // Dezent, feature-detected haptic feedback - never throws, never
    // required for correctness (purely a nice-to-have polish layer).
    vibrate(pattern) {
      try {
        if (navigator.vibrate) navigator.vibrate(pattern);
      } catch (err) { /* ignore - haptics are best-effort only */ }
    },
  };

  window.MobileGameChat = MobileGameChat;
  window.VirtualJoystick = VirtualJoystick;
  window.TouchDPad = TouchDPad;
  window.MobileUX = MobileUX;
})();
