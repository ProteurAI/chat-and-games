// GoldRush - input. Desktop: pointer lock + WASD + left mouse (hold) to
// dig; where a browser refuses pointer lock, "free mouse" mode: drag with
// the right button to look, the rest stays the same. Touch: a floating move stick where the left thumb lands, drag to
// look with the right thumb, a big hold-to-dig button - all three at once
// (every pointer is tracked by its id). Everything registered here is
// removed again in detach().

const LOOK_MOUSE = 0.0021;       // rad per px
const LOOK_TOUCH = 0.0052;
const STICK_RADIUS = 52;         // px

export class GoldRushInput {
  constructor({ root, canvas, touch, stickEl, knobEl, digBtn, onLockChange }) {
    this.root = root;
    this.canvas = canvas;
    this.touch = touch;
    this.stickEl = stickEl;
    this.knobEl = knobEl;
    this.digBtn = digBtn;
    this.onLockChange = onLockChange || (() => {});
    this.keys = new Set();
    this.move = { x: 0, y: 0 };          // strafe (+right), forward (+ahead), -1..1
    this.look = { x: 0, y: 0 };          // accumulated radians since the last take()
    this.digHeld = false;
    this.altHeld = false;                // phase 9: the right button (locked) / the phone's second action - the excavator's dump
    this.sprint = false;
    this.locked = false;
    this.everLocked = false;             // the browser has granted the lock at least once
    this.free = false;                   // no pointer lock available: look by right-button drag
    this.allLook = false;                // every touch drag is "look" (work at the wash place)
    this.dragLook = false;
    this.enabled = true;
    this.pointers = new Map();           // pointerId -> { role, x0, y0, x, y }
    this._off = [];
  }

  on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._off.push(() => target.removeEventListener(type, fn, opts));
  }

  attach() {
    const d = document;
    // desktop
    this.on(window, "keydown", (e) => this._key(e, true));
    this.on(window, "keyup", (e) => this._key(e, false));
    this.on(window, "blur", () => this.releaseAll());
    this.on(d, "pointerlockchange", () => {
      this.locked = d.pointerLockElement === this.canvas;
      if (this.locked) this.everLocked = true;
      if (!this.locked) this.digHeld = false;
      this.onLockChange(this.locked);
    });
    this.on(d, "pointerlockerror", () => this.onLockChange(false, true));
    this.on(d, "mousemove", (e) => {
      // free mouse: own deltas from the cursor position (movementX is not
      // reliable outside pointer lock in every engine)
      const fx = this._mx == null ? 0 : e.clientX - this._mx, fy = this._my == null ? 0 : e.clientY - this._my;
      this._mx = e.clientX;
      this._my = e.clientY;
      if (!this.enabled) return;
      if (this.locked) {
        this.look.x += e.movementX * LOOK_MOUSE;
        this.look.y += e.movementY * LOOK_MOUSE;
      } else if (this.free && this.dragLook) {
        this.look.x += fx * LOOK_MOUSE;
        this.look.y += fy * LOOK_MOUSE;
      }
    });
    this.on(this.canvas, "mousedown", (e) => {
      if (this.touch || !this.enabled) return;
      if (this.free) {
        if (e.button === 0) this.digHeld = true;
        if (e.button === 2) this.dragLook = true;
        return;
      }
      if (e.button === 2 && this.locked) { this.altHeld = true; return; }
      if (e.button !== 0) return;
      if (!this.locked) { this.requestLock(); return; }
      this.digHeld = true;
    });
    this.on(d, "mouseup", (e) => {
      if (this.touch) return;
      if (e.button === 0) this.digHeld = false;
      if (e.button === 2) { this.dragLook = false; this.altHeld = false; }
    });
    this.on(this.canvas, "contextmenu", (e) => e.preventDefault());
    // touch (pointer events, every finger by id)
    if (this.touch) {
      this.on(this.root, "pointerdown", (e) => this._down(e), { passive: false });
      this.on(this.root, "pointermove", (e) => this._moveP(e), { passive: false });
      this.on(this.root, "pointerup", (e) => this._up(e));
      this.on(this.root, "pointercancel", (e) => this._up(e));
      this.on(this.root, "touchmove", (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });   // no page scroll / zoom
    }
  }

  detach() {
    for (const off of this._off.splice(0)) off();
    this.releaseAll();
    if (document.pointerLockElement === this.canvas) { try { document.exitPointerLock(); } catch (e) { /* ignore */ } }
  }

  requestLock() {
    if (this.touch || document.pointerLockElement === this.canvas) return;
    try {
      const p = this.canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => this.onLockChange(false, true));
    } catch (e) {
      this.onLockChange(false, true);
    }
  }

  exitLock() {
    if (document.pointerLockElement === this.canvas) { try { document.exitPointerLock(); } catch (e) { /* ignore */ } }
  }

  releaseAll() {
    this.keys.clear();
    this.digHeld = false;
    this.altHeld = false;
    this.dragLook = false;
    this.sprint = false;
    this.pointers.clear();
    this.move.x = this.move.y = 0;
    this._stickVisual(null);
    if (this.digBtn) this.digBtn.classList.remove("is-active");
  }

  // consumed once per frame by the game
  takeLook() {
    const l = { x: this.look.x, y: this.look.y };
    this.look.x = this.look.y = 0;
    return l;
  }

  _key(e, down) {
    if (!this.enabled) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
    const k = e.code;
    // browsers normally swallow Esc to end pointer lock themselves; where it
    // does reach the page, it must pause the same way
    if (k === "Escape" && down && this.locked) { this.exitLock(); return; }
    if (k === "Escape" && down && this.free) { this.releaseAll(); this.onLockChange(false); return; }
    if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight", "Space"].includes(k)) {
      if (down) this.keys.add(k); else this.keys.delete(k);
      this.sprint = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
      if (k === "Space") this.digHeld = down && this.locked;      // keyboard dig while locked
      e.preventDefault();
      this._fromKeys();
    }
  }

  _fromKeys() {
    if (this.touch && this.pointers.size) return;
    const k = this.keys;
    this.move.y = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
    this.move.x = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
  }

  // ------------------------------------------------------------ touch

  _down(e) {
    if (!this.enabled || e.pointerType === "mouse") return;
    if (e.target.closest && e.target.closest(".gr-hud-btn, .gr-panel, .gr-dialog, .gr-tool, .gr-belt, .gr-sheet, .gr-ctx-btn, .gr-alt-btn")) return;   // HUD buttons / tool sheet keep their own taps
    e.preventDefault();
    const r = this.root.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let role;
    if (this.digBtn && (e.target === this.digBtn || this.digBtn.contains(e.target))) role = "dig";
    // working (panning / sieving): every finger swirls / shakes - no walking
    else if (!this.allLook && x < r.width * 0.45 && y > r.height * 0.3 && ![...this.pointers.values()].some((p) => p.role === "stick")) role = "stick";
    else role = "look";
    this.pointers.set(e.pointerId, { role, x0: x, y0: y, x, y });
    try { this.root.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (role === "dig") { this.digHeld = true; this.digBtn.classList.add("is-active"); }
    if (role === "stick") this._stickVisual({ x, y, dx: 0, dy: 0 });
  }

  _moveP(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    const r = this.root.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (p.role === "look") {
      this.look.x += (x - p.x) * LOOK_TOUCH;
      this.look.y += (y - p.y) * LOOK_TOUCH;
    } else if (p.role === "stick") {
      let dx = x - p.x0, dy = y - p.y0;
      const d = Math.hypot(dx, dy);
      if (d > STICK_RADIUS) { dx = (dx / d) * STICK_RADIUS; dy = (dy / d) * STICK_RADIUS; }
      const nx = dx / STICK_RADIUS, ny = dy / STICK_RADIUS;
      const mag = Math.hypot(nx, ny), dead = 0.12;
      const k = mag < dead ? 0 : (mag - dead) / (1 - dead) / (mag || 1);
      this.move.x = nx * k;
      this.move.y = -ny * k;
      this.sprint = mag > 0.97;
      this._stickVisual({ x: p.x0, y: p.y0, dx, dy });
    }
    p.x = x;
    p.y = y;
  }

  _up(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    if (p.role === "dig") { this.digHeld = false; this.digBtn.classList.remove("is-active"); }
    if (p.role === "stick") { this.move.x = this.move.y = 0; this.sprint = false; this._stickVisual(null); }
  }

  _stickVisual(s) {
    if (!this.stickEl) return;
    if (!s) { this.stickEl.classList.remove("is-active"); this.knobEl.style.transform = ""; return; }
    this.stickEl.classList.add("is-active");
    this.stickEl.style.left = `${s.x}px`;
    this.stickEl.style.top = `${s.y}px`;
    this.knobEl.style.transform = `translate(${s.dx}px, ${s.dy}px)`;
  }
}
