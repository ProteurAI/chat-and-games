// GoldRush - developer access (QA tools): asks the SERVER, never decides here.
//
// The developer code exists only on the server (env GOLDRUSH_DEV_CODE, see
// backend/goldrush_dev.py). This module sends what the developer typed to
// /api/goldrush/dev/unlock once and keeps the short-lived session token the
// server hands back - in sessionStorage only (gone with the browser session),
// never the code itself. Loaded on demand: a normal player never fetches it.

const STORE = "goldrush.devSession";
export const ROUTE_VERSION = 4;          // backend/goldrush_dev.py ROUTE_VERSION (the status's shape)

// what can go wrong when asking the server - "not configured" is only ever the
// server's own answer, never a guess from a failed request
export const DEV_ERROR = {
  NOT_CONFIGURED: "NOT_CONFIGURED", AUTH_ERROR: "AUTH_ERROR", NETWORK_ERROR: "NETWORK_ERROR",
  ENDPOINT_NOT_FOUND: "ENDPOINT_NOT_FOUND", SERVER_ERROR: "SERVER_ERROR",
  REJECTED: "REJECTED",                  // the server answered no (wrong code 403, too many tries 429): its own text
};

/** a failed request -> one of DEV_ERROR (the app's api() marks network / auth errors and the HTTP status) */
export function classifyDevError(e) {
  if (!e) return DEV_ERROR.SERVER_ERROR;
  if (e.authError || e.status === 401) return DEV_ERROR.AUTH_ERROR;
  if (e.name === "SyntaxError") return DEV_ERROR.ENDPOINT_NOT_FOUND;        // a 200 that is no JSON: some page, not the developer status
  if (e.network) return DEV_ERROR.NETWORK_ERROR;
  if (e.status === 404 || e.status === 405) return DEV_ERROR.ENDPOINT_NOT_FOUND;
  if (e.status === 503 && /nicht konfiguriert/.test(e.message || "")) return DEV_ERROR.NOT_CONFIGURED;
  if (e.status >= 500) return DEV_ERROR.SERVER_ERROR;
  return e.status ? DEV_ERROR.REJECTED : DEV_ERROR.NETWORK_ERROR;
}

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

  /**
   * -> { configured, unlocked, error?, diagnosis?, routeVersion } (the server's view; a stale token is dropped).
   * error: a DEV_ERROR when the question itself failed - then `configured` is unknown (null), not false.
   */
  async status() {
    if (!this.available) return { configured: false, unlocked: false, error: DEV_ERROR.AUTH_ERROR };
    let r;
    const had = !!(this._token() || this._mem);              // a session this browser tab still holds
    try {
      r = await this.api("/api/goldrush/dev/status", { headers: this._headers() });
    } catch (e) {
      return { configured: null, unlocked: false, error: classifyDevError(e), status: e && e.status, message: e && e.message };
    }
    // a 200 that is not the developer status (an old server, a proxy page): not "not configured"
    if (!r || typeof r.configured !== "boolean") return { configured: null, unlocked: false, error: DEV_ERROR.ENDPOINT_NOT_FOUND };
    this.configured = r.configured;
    this.unlocked = !!r.unlocked;
    if (!this.unlocked) { this._keep(null); this._mem = null; }
    // (route version 3, phase 9: the diagnosis comes always - which server answered, how it is set up)
    const out = { configured: this.configured, unlocked: this.unlocked, routeVersion: r.routeVersion || 1, diagnosis: r.diagnosis || null };
    // the server no longer knows this tab's session: it restarted (a free instance sleeps) or another instance answered
    out.staleSession = had && !this.unlocked;
    this.diagnosis = out.diagnosis;
    if (!r.configured) out.error = DEV_ERROR.NOT_CONFIGURED;
    return out;
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
      const kind = classifyDevError(e);
      return { ok: false, kind, error: e && e.message ? e.message : "Code nicht gültig." };
    }
  }

  async lock() {
    if (this.available && (this._token() || this._mem)) { try { await this.api("/api/goldrush/dev/lock", { method: "POST", headers: this._headers() }); } catch (e) { /* ignore */ } }
    this._keep(null);
    this._mem = null;
    this.unlocked = false;
  }
}
