// GoldRush - find feedback in the HUD: a small "+ € 0,04" near the
// crosshair (pooled, a few at most; finds close together are summed up),
// a compact toast for a nugget ("Erster Nugget!" once per save), short
// hints ("Zu weit entfernt", rate-limited) and the money counter, which
// counts up when a piece is actually picked up.

import { formatEuro } from "./goldrush-economy.js";
import { FIND } from "./goldrush-resources.js";

const FLOATS = 4;
const MERGE_MS = 450;
const NUGGET_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 14.5c-.9-2.6.6-5.6 3.3-6.7 1.4-.6 2.3-1.9 4-2.2 2.6-.4 5.4 1.2 6.1 3.8.6 2.1-.2 3.4.4 5.1.8 2.4-1 4.9-3.6 5.2-1.8.2-2.9-.6-4.6-.3-2.3.4-4.8-1.3-5.6-4.9z" fill="currentColor"/><path d="M9.3 9.6c.9-.6 1.9-.7 2.7-.4M15.8 8.2c.6.4 1 1 1.1 1.7" stroke="#fff6d8" stroke-width="1.2" stroke-linecap="round" fill="none" opacity=".75"/></svg>`;

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
    const sub = (this.sub = document.createElement("div"));
    sub.className = "gr-money-sub";
    sub.hidden = true;
    moneyEl.insertAdjacentElement("afterend", sub);
    this.shown = 0;
    this.target = 0;
    this.session = 0;
    this._text = "";
    this._tips = new Map();
    this._toastT = 0;
    this._tipT = 0;
    this.now = 0;
  }

  setMoney(cents) {
    this.shown = this.target = cents;
    this._paint();
  }

  // a piece (or dust) was picked up: the counter climbs, a small value floats
  collected(cents, cls) {
    this.target += cents;
    this.session += cents;
    this.sub.hidden = false;
    this.sub.textContent = `Diese Sitzung + ${formatEuro(this.session)}`;
    if (cls !== FIND.NUGGET) this._float(cents);
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
    val.textContent = `+ ${formatEuro(cents)}`;
    txt.append(title, val);
    t.append(ico, txt);
    t.classList.toggle("is-first", !!first);
    t.hidden = false;
    t.classList.remove("is-on");
    void t.offsetWidth;
    t.classList.add("is-on");
    this._toastT = first ? 3.4 : 2.4;
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
    if (this.shown !== this.target) {
      const d = this.target - this.shown;
      const step = Math.max(1, Math.ceil(Math.abs(d) * Math.min(1, dt * 9)));
      this.shown += Math.sign(d) * Math.min(Math.abs(d), step);
      this._paint();
    }
    for (const f of this.floats) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) { f.el.hidden = true; f.el.classList.remove("is-on"); }
    }
    if (this._toastT > 0 && (this._toastT -= dt) <= 0) this.toast.hidden = true;
    if (this._tipT > 0 && (this._tipT -= dt) <= 0) this.tipEl.hidden = true;
  }

  _paint() {
    const text = formatEuro(this.shown);
    if (text !== this._text) {
      this._text = text;
      this.moneyEl.textContent = text;
      this.moneyEl.classList.remove("is-up");
      void this.moneyEl.offsetWidth;
      this.moneyEl.classList.add("is-up");
    }
  }

  // show the real balance right away (exit, flush)
  settle(cents) { this.target = cents; this.shown = cents; this._paint(); }

  get floatsVisible() { return this.floats.filter((f) => f.life > 0).length; }

  dispose() {
    this.feed.remove();
    this.toast.remove();
    this.tipEl.remove();
    this.sub.remove();
  }
}
