// GoldRush - HUD feedback: the cash chip (money - changes only when gold
// is sold or something is bought), a compact gold pouch under it
// ("Goldbeutel ≈ € 1,37": what the gold you carry would fetch), a small
// "+ € 0,04" in gold near the crosshair when a find lands in the pouch
// (pooled, a few at most; finds close together are summed up), a compact
// toast for a nugget, short hints ("Zu weit entfernt", rate-limited), a
// quiet objective line for the very start (until the first tool is
// bought) and the interaction prompt of a station ("[E] Gold verkaufen").
// Phase 8: under the pouch a compact material row - where your dirt is right
// now: bucket, wheelbarrow and the concentrate waiting to be panned, each
// only once you own what holds it; the one in your hands is highlighted.

import { formatEuro } from "./goldrush-economy.js";
import { FIND } from "./goldrush-resources.js";

const FLOATS = 4;
const MERGE_MS = 450;
const NUGGET_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 14.5c-.9-2.6.6-5.6 3.3-6.7 1.4-.6 2.3-1.9 4-2.2 2.6-.4 5.4 1.2 6.1 3.8.6 2.1-.2 3.4.4 5.1.8 2.4-1 4.9-3.6 5.2-1.8.2-2.9-.6-4.6-.3-2.3.4-4.8-1.3-5.6-4.9z" fill="currentColor"/><path d="M9.3 9.6c.9-.6 1.9-.7 2.7-.4M15.8 8.2c.6.4 1 1 1.1 1.7" stroke="#fff6d8" stroke-width="1.2" stroke-linecap="round" fill="none" opacity=".75"/></svg>`;
// the material row (phase 8): bucket, wheelbarrow, concentrate (a pan with dark sand)
const MAT_ICONS = {
  bucket: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8.5h14l-1.6 10.6c-.2 1-1 1.6-2 1.6H8.6c-1 0-1.8-.7-2-1.6L5 8.5z" fill="currentColor"/><path d="M5.5 8.5C6 4.8 8.7 3.3 12 3.3s6 1.5 6.5 5.2" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>`,
  barrow: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 9h12.8l-1.8 5.2c-.3.8-1 1.3-1.9 1.3H6.4c-.8 0-1.5-.5-1.8-1.3L3.5 9z" fill="currentColor"/><circle cx="17.6" cy="17.4" r="2.3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M14.8 15.2l2.1 1.4M16.3 9l3.9-3.2M8 15.6l-1.1 4M11.5 15.6l.6 2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  conc: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.8 10.5h18.4c-.6 4.2-4.4 7.3-9.2 7.3s-8.6-3.1-9.2-7.3z" fill="currentColor"/><path d="M8.2 13.3c1.4.9 4.6 1 6.7.1" stroke="#2b2622" stroke-width="2.2" stroke-linecap="round" fill="none"/><circle cx="10.4" cy="13.2" r=".9" fill="#f3cf6a"/><circle cx="13.3" cy="13.6" r=".7" fill="#f3cf6a"/></svg>`,
};
// phase 9: the sample bags (prospecting) and the excavator's bucket
MAT_ICONS.samples = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6.5h8l-.8 2.2c2.6 1.4 4.3 4.2 4.3 7.3 0 2.8-3.4 4.5-7.5 4.5S4.5 18.8 4.5 16c0-3.1 1.7-5.9 4.3-7.3L8 6.5z" fill="currentColor"/><path d="M8.6 4.2h6.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M9 13.5h6M9 16.3h4" stroke="#2b2622" stroke-width="1.3" stroke-linecap="round"/></svg>`;
MAT_ICONS.scoop = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h13.5c1.4 0 2.5 1.1 2.5 2.5v.8c0 4.3-3.5 7.7-7.7 7.7H9.6L4 12.6V7.5z" fill="currentColor"/><path d="M5.5 18.5l1.3 1.6M8.8 18.6l.9 1.8M12 18.6l.6 1.9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const MAT_LABELS = { bucket: "Eimer", barrow: "Karre", conc: "Konzentrat", samples: "Proben", scoop: "Löffel" };
const MAT_IDS = ["scoop", "bucket", "barrow", "samples", "conc"];
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
    // built once (icon, title, value) - a nugget and a message only change texts and what shows,
    // so the page keeps the same nodes however many toasts come and go (phase 7A)
    const ico = (this._toastIco = document.createElement("span"));
    ico.className = "gr-toast-ico";
    ico.innerHTML = NUGGET_ICON;
    const txt = document.createElement("span");
    txt.className = "gr-toast-text";
    this._toastTitle = document.createElement("b");
    this._toastValue = document.createElement("span");
    this._toastValue.className = "gr-toast-value";
    txt.append(this._toastTitle, this._toastValue);
    toast.append(ico, txt);
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
    // where the material is (phase 8): one chip per holder, built once - only their texts and
    // visibility change (the page keeps its nodes however often they update)
    const mats = (this.matsEl = document.createElement("div"));
    mats.className = "gr-mats";
    mats.hidden = true;
    this.matChips = {};
    for (const id of MAT_IDS) {
      const c = document.createElement("div");
      c.className = "gr-mat";
      c.dataset.mat = id;
      c.hidden = true;
      c.innerHTML = `<span class="gr-mat-ico">${MAT_ICONS[id]}</span><span class="gr-mat-label">${MAT_LABELS[id]}</span><span class="gr-mat-value"></span>`;
      mats.appendChild(c);
      this.matChips[id] = { el: c, value: c.querySelector(".gr-mat-value"), sig: "" };
    }
    stack.appendChild(mats);
    // the machines near you (phase 6/7): hopper, riffles, the store and the feeder
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

  /**
   * The material row: m = { bucket, barrow, conc } each null (not shown) or { text, active, full, aria };
   * only what changed is written.
   */
  materials(m) {
    let any = false;
    for (const id of MAT_IDS) {
      const c = this.matChips[id], v = m && m[id];
      const sig = v ? `${v.text}|${v.active ? 1 : 0}|${v.full ? 1 : 0}` : "";
      if (v) any = true;
      if (sig === c.sig) continue;
      c.sig = sig;
      c.el.hidden = !v;
      if (!v) continue;
      c.value.textContent = v.text;
      c.el.classList.toggle("is-active", !!v.active);
      c.el.classList.toggle("is-full", !!v.full);
      c.el.setAttribute("aria-label", v.aria || `${MAT_LABELS[id]} ${v.text}`);
    }
    if (this.matsEl.hidden === any) this.matsEl.hidden = !any;
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
    this._toastIco.hidden = false;
    this._toastTitle.textContent = first ? "Erster Nugget!" : "✨ Kleiner Nugget";
    this._toastValue.textContent = `≈ ${formatEuro(cents)} im Goldbeutel`;
    this._toastValue.hidden = false;
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
    this._toastIco.hidden = true;
    this._toastTitle.textContent = title;
    this._toastValue.textContent = value || "";
    this._toastValue.hidden = !value;
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

  // the tip on screen goes now (the cab's controls once you are out of it)
  clearTip() { this._tipT = 0; this.tipEl.hidden = true; }

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
