// GoldRush - HUD feedback: the cash chip (money - changes only when gold
// is sold or something is bought), a compact gold pouch under it
// ("Goldbeutel ≈ € 1,37": what the gold you carry would fetch), a small
// "+ € 0,04" in gold near the crosshair when a find lands in the pouch
// (pooled, a few at most; finds close together are summed up), a compact
// toast for a nugget, short hints ("Zu weit entfernt", rate-limited), a
// quiet objective line for the very start (until the first tool is
// bought) and the interaction prompt of a station ("[E] Gold verkaufen").

import { formatEuro } from "./goldrush-economy.js";
import { FIND } from "./goldrush-resources.js";

const FLOATS = 4;
const MERGE_MS = 450;
const NUGGET_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 14.5c-.9-2.6.6-5.6 3.3-6.7 1.4-.6 2.3-1.9 4-2.2 2.6-.4 5.4 1.2 6.1 3.8.6 2.1-.2 3.4.4 5.1.8 2.4-1 4.9-3.6 5.2-1.8.2-2.9-.6-4.6-.3-2.3.4-4.8-1.3-5.6-4.9z" fill="currentColor"/><path d="M9.3 9.6c.9-.6 1.9-.7 2.7-.4M15.8 8.2c.6.4 1 1 1.1 1.7" stroke="#fff6d8" stroke-width="1.2" stroke-linecap="round" fill="none" opacity=".75"/></svg>`;
const POUCH_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4.5h6l-1.4 2.6c3.4 1.3 5.9 4.6 5.9 8.2 0 3.3-2.8 4.7-7.5 4.7S4.5 18.6 4.5 15.3c0-3.6 2.5-6.9 5.9-8.2L9 4.5z" fill="currentColor"/><path d="M9.6 7.3h4.8" stroke="#fff3d0" stroke-width="1.3" stroke-linecap="round"/></svg>`;

// a value that counts towards its target (no timers of its own)
class Counter {
  constructor(v = 0) { this.shown = v; this.target = v; }
  set(v) { this.shown = this.target = v; }
  step(dt) {
    if (this.shown === this.target) return false;
    const d = this.target - this.shown;
    const step = Math.max(1, Math.ceil(Math.abs(d) * Math.min(1, dt * 9)));
    this.shown += Math.sign(d) * Math.min(Math.abs(d), step);
    return true;
  }
}

export class GoldRushHud {
  constructor(root, moneyEl, { reducedMotion = false } = {}) {
    this.root = root;
    this.moneyEl = moneyEl;
    this.reducedMotion = reducedMotion;
    const hud = root.querySelector(".gr-hud");
    const feed = (this.feed = document.createElement("div"));
    feed.className = "gr-feed";
    feed.setAttribute("aria-live", "polite");
    this.floats = [];
    for (let i = 0; i < FLOATS; i++) {
      const el = document.createElement("span");
      el.className = "gr-float";
      el.hidden = true;
      feed.appendChild(el);
      this.floats.push({ el, cents: 0, born: 0, life: 0 });
    }
    hud.appendChild(feed);
    const toast = (this.toast = document.createElement("div"));
    toast.className = "gr-toast";
    toast.hidden = true;
    toast.setAttribute("role", "status");
    hud.appendChild(toast);
    const tip = (this.tipEl = document.createElement("div"));
    tip.className = "gr-tip";
    tip.hidden = true;
    hud.appendChild(tip);
    // the gold pouch, right under the cash
    const pouch = (this.pouchEl = document.createElement("div"));
    pouch.className = "gr-chip gr-pouch";
    pouch.setAttribute("aria-label", "Goldbeutel");
    pouch.innerHTML = `<span class="gr-pouch-ico">${POUCH_ICON}</span><span class="gr-pouch-label">Goldbeutel</span><span class="gr-pouch-value"></span>`;
    pouch.hidden = true;
    this.pouchValue = pouch.querySelector(".gr-pouch-value");
    const stack = (this.stack = document.createElement("div"));
    stack.className = "gr-wallet";
    moneyEl.parentElement.insertBefore(stack, moneyEl);
    stack.append(moneyEl, pouch);
    // the bucket you work with (phase 5): "Eimer 6,2 / 10 l" while it is near / in your hand
    const load = (this.loadEl = document.createElement("div"));
    load.className = "gr-chip gr-load";
    load.hidden = true;
    stack.appendChild(load);
    const obj = (this.objEl = document.createElement("div"));
    obj.className = "gr-objective";
    obj.hidden = true;
    stack.appendChild(obj);
    // what to do while panning / sieving (bottom centre, quiet)
    const work = (this.workEl = document.createElement("div"));
    work.className = "gr-work";
    work.hidden = true;
    hud.appendChild(work);
    const prompt = (this.promptEl = document.createElement("div"));
    prompt.className = "gr-prompt";
    prompt.hidden = true;
    hud.appendChild(prompt);
    this.cash = new Counter(0);
    this.pouch = new Counter(0);
    this._text = "";
    this._ptext = "";
    this._tips = new Map();
    this._toastT = 0;
    this._tipT = 0;
    this._cashDelay = 0;
    this._cashNext = null;
    this.now = 0;
  }

  // ---- compatibility for tests: the cash counter
  get shown() { return this.cash.shown; }
  get target() { return this.cash.target; }

  setMoney(cents) { this.cash.set(cents); this._paint(); }

  // cash counts up to a new value (after `delay` s, e.g. when a sale's scale settled)
  cashTo(cents, delay = 0) {
    if (delay > 0) { this._cashDelay = delay; this._cashNext = cents; return; }
    this.cash.target = cents;
  }

  setPouch(cents, animate = false) {
    if (animate) this.pouch.target = cents; else this.pouch.set(cents);
    if (cents > 0) this.pouchEl.hidden = false;
    this._paintPouch();
  }

  // a find landed in the pouch: a small gold value floats, the pouch climbs
  collected(cents, cls) {
    this.pouch.target += cents;
    this.pouchEl.hidden = false;
    if (cls !== FIND.NUGGET) this._float(cents);
  }

  objective(text) {
    const t = text || "";
    if (t === this._obj) return;
    this._obj = t;
    this.objEl.textContent = t;
    this.objEl.hidden = !t;
  }

  // bucket chip (null hides it)
  load(text) {
    const t = text || "";
    if (t === this._load) return;
    this._load = t;
    this.loadEl.textContent = t;
    this.loadEl.hidden = !t;
  }

  work(text) {
    const t = text || "";
    if (t === this._work) return;
    this._work = t;
    this.workEl.textContent = t;
    this.workEl.hidden = !t;
  }

  prompt(text, key = "E") {
    const t = text ? `${key ? `[${key}] ` : ""}${text}` : "";
    if (t === this._prompt) return;
    this._prompt = t;
    this.promptEl.textContent = t;
    this.promptEl.hidden = !t;
  }

  _float(cents) {
    const last = this.floats.reduce((a, b) => (b.born > a.born ? b : a));
    let f;
    if (last.life > 0 && this.now - last.born < MERGE_MS) { f = last; f.cents += cents; }
    else {
      f = this.floats.reduce((a, b) => (b.born < a.born ? b : a));          // the oldest one is reused
      f.cents = cents;
    }
    f.born = this.now;
    f.life = 1.1;
    f.el.textContent = `+ ${formatEuro(f.cents)}`;
    f.el.hidden = false;
    f.el.classList.remove("is-on");
    void f.el.offsetWidth;                                                // restart the animation
    f.el.classList.add("is-on");
  }

  nugget(cents, first) {
    const t = this.toast;
    t.innerHTML = "";
    const ico = document.createElement("span");
    ico.className = "gr-toast-ico";
    ico.innerHTML = NUGGET_ICON;
    const txt = document.createElement("span");
    txt.className = "gr-toast-text";
    const title = document.createElement("b");
    title.textContent = first ? "Erster Nugget!" : "✨ Kleiner Nugget";
    const val = document.createElement("span");
    val.className = "gr-toast-value";
    val.textContent = `≈ ${formatEuro(cents)} im Goldbeutel`;
    txt.append(title, val);
    t.append(ico, txt);
    t.classList.toggle("is-first", !!first);
    t.hidden = false;
    t.classList.remove("is-on");
    void t.offsetWidth;
    t.classList.add("is-on");
    this._toastT = first ? 3.4 : 2.4;
  }

  // a short message in the toast slot (first sale, a purchase)
  message(title, value) {
    const t = this.toast;
    t.innerHTML = "";
    const txt = document.createElement("span");
    txt.className = "gr-toast-text";
    const b = document.createElement("b");
    b.textContent = title;
    txt.append(b);
    if (value) { const v = document.createElement("span"); v.className = "gr-toast-value"; v.textContent = value; txt.append(v); }
    t.append(txt);
    t.classList.remove("is-first");
    t.hidden = false;
    t.classList.remove("is-on");
    void t.offsetWidth;
    t.classList.add("is-on");
    this._toastT = 2.6;
  }

  // short hint under the crosshair; each key at most every `every` seconds
  tip(key, text, every = 4) {
    const last = this._tips.get(key);
    if (last != null && this.now - last < every * 1000) return false;
    this._tips.set(key, this.now);
    this.tipEl.textContent = text;
    this.tipEl.hidden = false;
    this.tipEl.classList.remove("is-on");
    void this.tipEl.offsetWidth;
    this.tipEl.classList.add("is-on");
    this._tipT = 1.8;
    return true;
  }

  // per game frame (no timers of its own)
  update(dt) {
    this.now += dt * 1000;
    if (this._cashDelay > 0 && (this._cashDelay -= dt) <= 0) { this.cash.target = this._cashNext; this._cashNext = null; }
    if (this.cash.step(dt)) this._paint();
    if (this.pouch.step(dt)) this._paintPouch();
    for (const f of this.floats) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) { f.el.hidden = true; f.el.classList.remove("is-on"); }
    }
    if (this._toastT > 0 && (this._toastT -= dt) <= 0) this.toast.hidden = true;
    if (this._tipT > 0 && (this._tipT -= dt) <= 0) this.tipEl.hidden = true;
  }

  _paint() {
    const text = formatEuro(this.cash.shown);
    if (text !== this._text) {
      this._text = text;
      this.moneyEl.textContent = text;
      this.moneyEl.classList.remove("is-up");
      void this.moneyEl.offsetWidth;
      this.moneyEl.classList.add("is-up");
    }
  }

  _paintPouch() {
    const text = `≈ ${formatEuro(this.pouch.shown)}`;
    if (text === this._ptext) return;
    this._ptext = text;
    this.pouchValue.textContent = text;
  }

  // show the real balances right away (exit, flush)
  settle(cents, pouchCents) {
    this._cashDelay = 0;
    this.cash.set(cents);
    this._paint();
    if (pouchCents != null) this.setPouch(pouchCents);
  }

  get floatsVisible() { return this.floats.filter((f) => f.life > 0).length; }

  dispose() {
    this.feed.remove();
    this.toast.remove();
    this.tipEl.remove();
    this.promptEl.remove();
    this.workEl.remove();
    // the wallet stack: the cash counter belongs to the shell and goes back where it was, the
    // rest (pouch, load, objective) goes - a game restarted in place (a restore) builds its own
    if (this.stack.parentElement) this.stack.parentElement.insertBefore(this.moneyEl, this.stack);
    this.stack.remove();
  }
}
