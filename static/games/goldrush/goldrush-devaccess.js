// GoldRush - developer access (QA tools): asks the SERVER, never decides here.
//
// The developer code exists only on the server (env GOLDRUSH_DEV_CODE, see
// backend/goldrush_dev.py). This module sends what the developer typed to
// /api/goldrush/dev/unlock once and keeps the short-lived session token the
// server hands back - in sessionStorage only (gone with the browser session),
// never the code itself. Loaded on demand: a normal player never fetches it.

const STORE = "goldrush.devSession";

export class DevAccess {
  /**
   * @param api     the app's authenticated fetch (app.js api(path, options))
   * @param player  { id, key } of the save service (the logged-in account)
   */
  constructor(api, player) {
    this.api = typeof api === "function" ? api : null;
    this.player = player;
    this.unlocked = false;
    this.configured = null;
  }

  // a logged-in account and the app's API: otherwise nothing to ask
  get available() { return !!this.api && !!this.player && this.player.id !== "guest"; }

  _token() {
    try {
      const s = JSON.parse(sessionStorage.getItem(STORE) || "null");
      return s && s.user === this.player.id && typeof s.token === "string" ? s.token : null;
    } catch (e) { return null; }
  }

  _keep(token) {
    try {
      if (token) sessionStorage.setItem(STORE, JSON.stringify({ user: this.player.id, token }));
      else sessionStorage.removeItem(STORE);
    } catch (e) { /* private mode: unlock lasts for this page only */ }
  }

  _headers() { const t = this._token() || this._mem; return t ? { "X-GoldRush-Dev": t } : {}; }

  /** -> { configured, unlocked } (the server's view; a stale token is dropped) */
  async status() {
    if (!this.available) return { configured: false, unlocked: false };
    const r = await this.api("/api/goldrush/dev/status", { headers: this._headers() });
    this.configured = !!r.configured;
    this.unlocked = !!r.unlocked;
    if (!this.unlocked) { this._keep(null); this._mem = null; }
    return { configured: this.configured, unlocked: this.unlocked };
  }

  /** -> { ok } | { ok: false, error } - the error text comes from the server */
  async unlock(code) {
    if (!this.available) return { ok: false, error: "Entwicklertools gibt es nur mit Anmeldung." };
    const value = String(code || "").trim();
    if (!value) return { ok: false, error: "Code nicht gültig." };
    try {
      const r = await this.api("/api/goldrush/dev/unlock", { method: "POST", body: JSON.stringify({ code: value }) });
      this._mem = r.token;
      this._keep(r.token);
      this.unlocked = true;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : "Code nicht gültig." };
    }
  }

  async lock() {
    if (this.available && (this._token() || this._mem)) { try { await this.api("/api/goldrush/dev/lock", { method: "POST", headers: this._headers() }); } catch (e) { /* ignore */ } }
    this._keep(null);
    this._mem = null;
    this.unlocked = false;
  }
}
