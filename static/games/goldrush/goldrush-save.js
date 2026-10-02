// GoldRush - saves: one mine per player, versioned, behind one service.
//
// GoldRushSaveService is the ONLY place that touches storage. Gameplay
// modules hand it a document (engine.buildDoc()) and get one back; they
// never call localStorage themselves. Storage itself is a small backend
// (get / set / remove / keys) - today the browser's localStorage, later a
// cloud backend can sit next to it without the game changing.
//
// WHOSE MINE: every save belongs to one Chat & Games account. The key is
// the account's stable internal id (users.id from /api/login - never a
// token, a password or an e-mail):
//
//   goldrush.save.u<id>            the mine
//   goldrush.save.u<id>.backup     the previous good document
//   goldrush.save.u<id>.prev       the mine before the last "Neue Mine"
//   goldrush.save.u<id>.corrupt    a document that could not be read
//   goldrush.save.u<id>.devSnapshot  developer tools: the mine before the first QA command
//   goldrush.settings              device settings (quality, sound, motion)
//
// The hosted server (Render free tier, SQLite on an ephemeral disk) may
// start over with an empty user table: ids are then handed out again, to
// whoever logs in first. So a save also carries its owner as { id, tag }
// (tag = a short hash of the account name - the login handle; not
// reversible into anything secret) and is only loaded for that owner. A
// save found under the right id but with someone else's tag is parked
// (goldrush.save.orphan.<tag>) and handed back to its owner when they log
// in again, under whatever id they have by then. User B never sees user
// A's mine.
//
// LEGACY: before phase 5 there was one save per browser (goldrush.save).
// The first player without a mine of their own is offered to take it over;
// taking it moves it to their key and marks the legacy slot as migrated
// (goldrush.legacy) - it is never given to a second player.
//
// Document (v6):
//   { saveVersion: 5, worldSeed, createdAt, updatedAt, owner: { id, tag },
//     tools: { owned: ["hand", ...], equipped, upgrades: [...] },
//     player: { x, z, yaw, pitch },
//     economy: { cashCents, earnedCents, pouch, sold, shop, milestones,
//                stats, processing stats, flags, nextId, pending },
//     terrain: { gen, cols, cell, unit, encoding, changed, data, loose },
//     resources: { unit, encoding, changed, slices, level, carried, carriedFine },
//     rocks: { v, count, list },
//     processing: { owned, nextBatch, bucket, pan, classifier, tub, ledger, wheelbarrow, sluice },
//     devModified?, devModifiedAt? }  (only once a developer / QA command changed the mine)
//
// The terrain is stored as integer height deltas against the seeded
// original mound (0.1 mm), run-length encoded - untouched ground costs
// almost nothing, no matter how often it was dug. The used-up resource
// slices are stored the same way, relative to the terrain (see
// goldrush-mining.js) - zero almost everywhere. Boulders only when they
// moved or took damage (goldrush-rocks.js). Material on its way through
// the processing chain is a handful of batches (goldrush-material.js).
// Every write keeps the previous good document as a backup.
//
// Versions: 1 = phase 1 (money as a float, no resources); 2 = integer
// cents, gold inventory + statistics, worked resource slices (5 cm);
// 3 = owned tools, pending finds, 0.1 mm terrain, 1 cm slices, boulders;
// 4 = gold is not money: a gold pouch, selling at the assay station, the
// supply shop (tool upgrades, purchases, milestones); 5 = the save belongs
// to a player (owner), settings live outside the mine, physical gold
// processing (bucket, pan, classifier, material batches, fine gold); 6 =
// primitive mechanisation (a wheelbarrow and a sluice box with their loads,
// the sluice's riffles, concentrate tray and tailings).
// Older documents are upgraded on load step by step (1 -> 2 -> ... -> 6)
// and written back as 6. A new mine owns only the hand and has € 0,00.

export const SAVE_VERSION = 6;
const PREFIX = "goldrush.save";
const LEGACY_KEY = "goldrush.save";
const LEGACY_BACKUP_KEY = "goldrush.save.backup";
const LEGACY_MARK_KEY = "goldrush.legacy";
const SETTINGS_KEY = "goldrush.settings";
export const DEFAULT_SETTINGS = Object.freeze({ quality: "auto", headBob: true, reducedMotion: false, sound: true, vibration: true });

const finite = (v) => typeof v === "number" && Number.isFinite(v);

// browser storage (the only backend today); every call may throw in a
// locked-down browser - reads then see nothing, writes report the failure
export const localBackend = {
  get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
  set(key, value) { localStorage.setItem(key, value); },
  remove(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } },
  keys(prefix) {
    const out = [];
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(prefix)) out.push(k); } } catch (e) { /* ignore */ }
    return out;
  },
};

// 32-bit FNV-1a of the account name -> 8 hex digits (owner fingerprint)
export function ownerTag(name) {
  const s = String(name || "").normalize("NFC");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// the player GoldRush runs for: { id, name } from the app's login
// (app.js passes it; the stored login is the fallback); no login = guest
export function currentPlayer(user, backend = localBackend) {
  let u = user;
  if (!u || u.id == null) { try { u = JSON.parse(backend.get("instachat_user") || "null"); } catch (e) { u = null; } }
  const id = u && u.id != null ? String(u.id) : "";
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return { id: "guest", key: "guest", tag: "guest", name: "" };
  return { id, key: `u${id}`, tag: ownerTag(u.name), name: String(u.name || "") };
}

export function validate(doc) {
  if (!doc || typeof doc !== "object") return "kein Objekt";
  if (!finite(doc.saveVersion) || doc.saveVersion < 1) return "saveVersion fehlt";
  if (doc.saveVersion > SAVE_VERSION) return "Spielstand stammt aus einer neueren Version";
  if (!Number.isInteger(doc.worldSeed)) return "worldSeed fehlt";
  const p = doc.player;
  if (!p || !finite(p.x) || !finite(p.z) || !finite(p.yaw) || !finite(p.pitch)) return "Spielerposition ungültig";
  if (doc.terrain != null) {
    const t = doc.terrain;
    if (!Number.isInteger(t.cols) || !finite(t.cell) || typeof t.data !== "string") return "Geländedaten ungültig";
  }
  if (doc.saveVersion >= 2) {
    const e = doc.economy;
    const cash = e && (e.cashCents != null ? e.cashCents : e.moneyCents);
    if (!e || typeof e !== "object" || !Number.isInteger(cash) || cash < 0) return "Geldstand ungültig";
    const r = doc.resources;
    if (r != null && (typeof r.slices !== "string" || typeof r.level !== "string")) return "Ressourcendaten ungültig";
    if (e.pending != null && !Array.isArray(e.pending)) return "Funddaten ungültig";
  } else if (!finite(doc.money)) return "Geldstand ungültig";
  if (doc.saveVersion >= 3) {
    const t = doc.tools;
    if (!t || !Array.isArray(t.owned) || !t.owned.every((id) => typeof id === "string")) return "Werkzeugdaten ungültig";
    if (doc.rocks != null && (typeof doc.rocks !== "object" || !Array.isArray(doc.rocks.list))) return "Felsdaten ungültig";
  }
  if (doc.saveVersion >= 4) {
    const e = doc.economy, t = doc.tools;
    if (e.pouch != null && typeof e.pouch !== "object") return "Goldbeutel ungültig";
    if (t.upgrades != null && (!Array.isArray(t.upgrades) || !t.upgrades.every((id) => typeof id === "string"))) return "Werkzeug-Upgrades ungültig";
  }
  if (doc.saveVersion >= 5) {
    const pr = doc.processing;
    if (pr != null && (typeof pr !== "object" || (pr.owned != null && !Array.isArray(pr.owned)))) return "Verarbeitungsdaten ungültig";
    if (doc.owner != null && (typeof doc.owner !== "object" || typeof doc.owner.tag !== "string")) return "Besitzerdaten ungültig";
  }
  if (doc.saveVersion >= 6 && doc.processing != null) {
    const pr = doc.processing;
    if (pr.wheelbarrow != null && (typeof pr.wheelbarrow !== "object" || !finite(pr.wheelbarrow.x) || !finite(pr.wheelbarrow.z))) return "Schubkarrendaten ungültig";
    if (pr.sluice != null && typeof pr.sluice !== "object") return "Waschrinnendaten ungültig";
  }
  return null;
}

// upgrade old documents step by step (never throw away progress)
export function migrate(doc) {
  if (doc.saveVersion === 1) {
    const cents = Math.max(0, Math.round((doc.money || 0) * 100));
    const digs = Math.max(0, Math.round((doc.stats && doc.stats.digs) || 0));
    doc = {
      ...doc,
      saveVersion: 2,
      economy: {
        moneyCents: cents, earnedCents: cents,
        stats: { totalDigs: digs, successfulDigs: digs },
        flags: { firstNuggetSeen: false },
      },
      // no worked slices in v1: everything above today's surface counts as
      // worked (so nothing dug before hands out loot now)
      resources: null,
      migratedFrom: 1,
    };
    delete doc.money;
    delete doc.stats;
  }
  if (doc.saveVersion === 2) {
    // phase 3: tools (only the hand - nothing was ever bought), no pending
    // finds (v2 booked them at the dig), boulders where the seed put them
    // (they settle onto the saved ground when the game loads)
    doc = {
      ...doc,
      saveVersion: 3,
      tools: { owned: ["hand"], equipped: "hand" },
      economy: { ...doc.economy, pending: [] },
      rocks: null,
      migratedFrom: doc.migratedFrom || 2,
    };
    delete doc.tool;
  }
  if (doc.saveVersion === 3) {
    // phase 4: gold is no longer money on pickup. The cash of a phase-3
    // save stays exactly as it is (that gold was sold automatically back
    // then - it is NOT turned back into gold); the pouch starts empty.
    const e = doc.economy || {};
    const inv = e.inventory || {};
    const legacyUg = ["dust", "flakes", "tinyPieces", "nuggets"].reduce((a, k) => a + (inv[k] && Number.isFinite(inv[k].ug) ? Math.max(0, Math.round(inv[k].ug)) : 0), 0);
    const cash = Number.isInteger(e.moneyCents) ? e.moneyCents : 0;
    doc = {
      ...doc,
      saveVersion: 4,
      tools: { ...(doc.tools || { owned: ["hand"], equipped: "hand" }), upgrades: [] },
      economy: {
        ...e,
        cashCents: cash,
        moneyCents: cash,
        pouch: null,
        sold: { totalGoldUg: legacyUg, totalCashCents: Number.isInteger(e.earnedCents) ? e.earnedCents : cash, sales: 0, largestSaleCents: 0, legacyUg },
        shop: null,
        milestones: null,
      },
      migratedFrom: doc.migratedFrom || 3,
    };
    delete doc.economy.inventory;
  }
  if (doc.saveVersion === 4) {
    // phase 5: the mine belongs to a player (stamped on the next write),
    // the settings move out to the device (taken over once by the caller),
    // nothing on its way through processing yet. Everything else - cash,
    // pouch, tools, upgrades, ground - stays exactly as it is.
    doc = { ...doc, saveVersion: 5, processing: null, migratedFrom: doc.migratedFrom || 4 };
  }
  if (doc.saveVersion === 5) {
    // phase 6: no wheelbarrow, no sluice yet - everything else exactly as it was
    doc = { ...doc, saveVersion: 6, migratedFrom: doc.migratedFrom || 5 };
  }
  return doc;
}

// the start screen's few lines about a mine (no world needed)
export function summarize(doc) {
  if (!doc) return null;
  const e = doc.economy || {}, st = e.stats || {}, pouch = e.pouchSummary || {};
  const g = st.massG || {};
  const kg = ((g.dirt || 0) + (g.compactDirt || 0) + (g.gravel || 0) + (g.stone || 0)) / 1000;
  const cash = Number.isInteger(e.cashCents) ? e.cashCents : Number.isInteger(e.moneyCents) ? e.moneyCents : 0;
  const tools = doc.tools && Array.isArray(doc.tools.owned) ? doc.tools.owned.filter((t) => typeof t === "string") : ["hand"];
  const equipment = doc.processing && Array.isArray(doc.processing.owned) ? doc.processing.owned.filter((t) => typeof t === "string") : [];
  return {
    playMs: Math.max(0, Math.round(st.playTimeMs || 0)), cashCents: Math.max(0, cash), pouchCents: Math.max(0, Math.round(pouch.estimatedSaleCents || 0)),
    tools, equipment, kgMoved: Math.max(0, Math.round(kg)), seed: doc.worldSeed, updatedAt: doc.updatedAt || 0,
    devModified: !!doc.devModified,
  };
}

export class GoldRushSaveService {
  /**
   * @param user     { id, name } of the logged-in account (app.js), or null
   * @param backend  storage (localBackend; a cloud backend later)
   */
  constructor(user, backend = localBackend) {
    this.backend = backend;
    this.player = currentPlayer(user, backend);
    const k = `${PREFIX}.${this.player.key}`;
    this.keys = { main: k, backup: `${k}.backup`, prev: `${k}.prev`, corrupt: `${k}.corrupt`, devSnapshot: `${k}.devSnapshot` };
    this.notice = null;                   // what load() had to do (shown once by the shell)
  }

  _parse(raw) {
    if (raw == null) return { doc: null, error: null };
    try {
      const doc = JSON.parse(raw);
      const error = validate(doc);
      return error ? { doc: null, error } : { doc, error: null };
    } catch (e) { return { doc: null, error: "nicht lesbar" }; }
  }

  _mine(doc) { return !doc.owner || !doc.owner.tag || this.player.tag === "guest" || doc.owner.tag === this.player.tag; }

  // a save of someone else under this player's id (the server handed the id
  // out again): set it aside for its owner, out of this player's way
  _park(raw, doc) {
    const okey = `${PREFIX}.orphan.${doc.owner.tag}`;
    const other = this._parse(this.backend.get(okey)).doc;
    if (!other || (other.updatedAt || 0) <= (doc.updatedAt || 0)) {
      try { this.backend.set(okey, raw); } catch (e) { return false; }       // never drop it if it cannot be parked
    }
    this.backend.remove(this.keys.main);
    this.backend.remove(this.keys.backup);
    return true;
  }

  // this player's mine stored elsewhere: parked as an orphan, or under the
  // id they had before the server started over -> back under their id now
  _rehome() {
    if (this.player.tag === "guest") return null;
    const cands = [];
    const orphan = `${PREFIX}.orphan.${this.player.tag}`;
    const o = this._parse(this.backend.get(orphan));
    if (o.doc) cands.push({ key: orphan, doc: o.doc });
    for (const key of this.backend.keys(`${PREFIX}.u`)) {
      if (key === this.keys.main || /\.(backup|prev|corrupt|devSnapshot)$/.test(key)) continue;
      const r = this._parse(this.backend.get(key));
      if (r.doc && r.doc.owner && r.doc.owner.tag === this.player.tag) cands.push({ key, doc: r.doc });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => (b.doc.updatedAt || 0) - (a.doc.updatedAt || 0));
    const pick = cands[0];
    try { this.backend.set(this.keys.main, this.backend.get(pick.key)); } catch (e) { return null; }
    this.backend.remove(pick.key);
    if (pick.key !== orphan) this.backend.remove(`${pick.key}.backup`);
    return pick.doc;
  }

  /**
   * This player's mine: { status: "none" | "ok" | "backup" | "corrupt", doc, error, settings }
   * (settings: a v4 document's own settings, for the device on first use)
   */
  load() {
    let raw = this.backend.get(this.keys.main);
    let main = this._parse(raw);
    if (main.doc && !this._mine(main.doc)) {
      if (!this._park(raw, main.doc)) return { status: "corrupt", doc: null, error: "Spielstand gehört zu einem anderen Konto" };
      raw = null; main = { doc: null, error: null };
    }
    if (raw == null) {
      const back = this._rehome();
      if (!back) return { status: "none", doc: null };
      this.notice = "Deine Mine wurde gefunden und deinem Konto zugeordnet.";
      return this._finish(back, "ok");
    }
    if (main.doc) return this._finish(main.doc, "ok");
    // main document broken: try the previous good one
    const bak = this._parse(this.backend.get(this.keys.backup));
    if (bak.doc && this._mine(bak.doc)) return { ...this._finish(bak.doc, "backup"), error: main.error };
    return { status: "corrupt", doc: null, error: main.error };
  }

  _finish(doc, status) {
    const settings = doc.saveVersion < 5 && doc.settings ? { ...doc.settings } : null;
    const out = migrate(doc);
    delete out.settings;
    return { status, doc: out, settings };
  }

  // the start screen: is there a mine, and what is in it (no migration needed)
  peek() {
    const r = this.load();
    return { ...r, summary: r.doc ? summarize(r.doc) : null };
  }

  // -> bytes written; throws if the browser refuses (quota, private mode)
  save(doc) {
    const out = { ...doc, owner: { id: this.player.id, tag: this.player.tag } };
    delete out.settings;
    const json = JSON.stringify(out);
    const current = this.backend.get(this.keys.main);
    if (current != null && current !== json) {
      const c = this._parse(current);
      if (c.doc && this._mine(c.doc)) this.backend.set(this.keys.backup, current);     // never back up garbage or a stranger's mine
    }
    this.backend.set(this.keys.main, json);
    return json.length;
  }

  // keep the broken document aside (support/debugging) and start fresh
  quarantineCorrupt() {
    const raw = this.backend.get(this.keys.main);
    if (raw != null) { try { this.backend.set(this.keys.corrupt, raw); } catch (e) { /* ignore */ } }
    this.backend.remove(this.keys.main);
  }

  // "Neue Mine": this player's mine is gone (the last one kept aside, one
  // deep - no visible save slots); other players are not touched
  reset() {
    const cur = this._parse(this.backend.get(this.keys.main));
    if (cur.doc && this._mine(cur.doc)) { try { this.backend.set(this.keys.prev, this.backend.get(this.keys.main)); } catch (e) { /* ignore */ } }
    this.backend.remove(this.keys.main);
    this.backend.remove(this.keys.backup);
    this.backend.remove(this.keys.corrupt);
    this.backend.remove(this.keys.devSnapshot);          // the old mine's developer snapshot goes with it
  }

  // ---- developer tools (QA): one snapshot of this player's mine as it was
  // before the first developer command. It belongs to that mine (seed +
  // creation time) and is never offered as a mine of its own.
  devSnapshot() {
    let s = null;
    try { s = JSON.parse(this.backend.get(this.keys.devSnapshot) || "null"); } catch (e) { return null; }
    if (!s || typeof s !== "object" || !s.doc) return null;
    const error = validate(s.doc);
    if (error || !this._mine(s.doc)) return null;
    return { at: Number.isFinite(s.at) ? s.at : 0, doc: s.doc, seed: s.doc.worldSeed, createdAt: s.doc.createdAt };
  }

  writeDevSnapshot(doc) {
    const out = { ...doc, owner: { id: this.player.id, tag: this.player.tag } };
    delete out.settings;
    this.backend.set(this.keys.devSnapshot, JSON.stringify({ v: 1, at: Date.now(), doc: out }));
    return true;
  }

  clearDevSnapshot() { this.backend.remove(this.keys.devSnapshot); }

  // ---- the browser-wide save from before phase 5
  legacy() {
    const mark = this.backend.get(LEGACY_MARK_KEY);
    if (mark) return null;
    let r = this._parse(this.backend.get(LEGACY_KEY));
    if (!r.doc) r = this._parse(this.backend.get(LEGACY_BACKUP_KEY));
    if (!r.doc || (r.doc.owner && r.doc.owner.tag)) return null;
    return { doc: r.doc, summary: summarize(migrate(JSON.parse(JSON.stringify(r.doc)))) };
  }

  // take it over - once: it moves to this player and the legacy slot is
  // marked, so no other player is offered the same mine again
  migrateLegacy() {
    if (this.backend.get(this.keys.main) != null) return { ok: false, reason: "has-save" };
    const lg = this.legacy();
    if (!lg) return { ok: false, reason: "none" };
    const settings = lg.doc.settings ? { ...lg.doc.settings } : null;
    const doc = migrate(lg.doc);
    delete doc.settings;
    this.save(doc);
    this.backend.set(LEGACY_MARK_KEY, JSON.stringify({ migratedTo: this.player.tag, id: this.player.id, at: Date.now() }));
    this.backend.remove(LEGACY_KEY);
    this.backend.remove(LEGACY_BACKUP_KEY);
    return { ok: true, doc, settings };
  }

  // ---- export / import (a later cloud save or a manual backup)
  export() {
    const r = this.load();
    return r.doc ? JSON.stringify({ ...r.doc, saveVersion: SAVE_VERSION }) : null;
  }

  // check a document before it replaces anything (developer import): validated, migrated, not saved
  parseImport(json) {
    if (typeof json === "string" && json.length > 8 * 1024 * 1024) return { ok: false, error: "Datei zu groß" };
    const r = this._parse(typeof json === "string" ? json : JSON.stringify(json));
    if (!r.doc) return { ok: false, error: r.error || "leer" };
    const doc = migrate(r.doc);
    delete doc.settings;
    return { ok: true, doc };
  }

  import(json) {
    const r = this._parse(typeof json === "string" ? json : JSON.stringify(json));
    if (!r.doc) return { ok: false, error: r.error || "leer" };
    const doc = migrate(r.doc);
    delete doc.settings;
    this.save(doc);
    return { ok: true };
  }

  // ---- device settings (not part of a mine: a new mine keeps them)
  loadSettings() {
    try { return { ...DEFAULT_SETTINGS, ...(JSON.parse(this.backend.get(SETTINGS_KEY) || "null") || {}) }; } catch (e) { return { ...DEFAULT_SETTINGS }; }
  }

  hasSettings() { return this.backend.get(SETTINGS_KEY) != null; }

  saveSettings(s) {
    const out = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = s && s[k] != null ? s[k] : DEFAULT_SETTINGS[k];
    try { this.backend.set(SETTINGS_KEY, JSON.stringify(out)); return true; } catch (e) { return false; }
  }

  bytes() { return (this.backend.get(this.keys.main) || "").length; }
}

// ---------------------------------------------------------------------------
// Int16 array <-> base64 of a run-length + zigzag-varint byte stream:
//   repeat { zeroRun, valueCount, value * valueCount }
// ---------------------------------------------------------------------------

export function encodeInt16Rle(arr) {
  const bytes = [];
  const varint = (v) => { while (v > 127) { bytes.push((v & 127) | 128); v >>>= 7; } bytes.push(v); };
  let k = 0;
  const n = arr.length;
  while (k < n) {
    let z = 0;
    while (k < n && arr[k] === 0) { z++; k++; }
    const start = k;
    while (k < n && arr[k] !== 0) k++;
    // tolerate short zero gaps inside a changed area (cheaper than a new run)
    varint(z);
    varint(k - start);
    for (let q = start; q < k; q++) { const v = arr[q]; varint(v >= 0 ? v * 2 : -v * 2 - 1); }
  }
  let bin = "";
  const CH = 0x8000;
  for (let q = 0; q < bytes.length; q += CH) bin += String.fromCharCode.apply(null, bytes.slice(q, q + CH));
  return btoa(bin);
}

// any integer array (Int32 heights in 0.1 mm, Uint8 states, Int16) - same stream format
export const encodeIntRle = (arr) => encodeInt16Rle(arr);

export function decodeIntRle(b64, length) { return decodeInt16Rle(b64, length, Int32Array); }

export function decodeInt16Rle(b64, length, Type = Int16Array) {
  const bin = atob(b64);
  const out = new Type(length);
  let p = 0, k = 0;
  const varint = () => {
    let v = 0, shift = 0, b;
    do {
      if (p >= bin.length) throw new Error("truncated");
      b = bin.charCodeAt(p++);
      v |= (b & 127) << shift;
      shift += 7;
    } while (b & 128);
    return v >>> 0;
  };
  while (p < bin.length) {
    k += varint();
    const count = varint();
    if (k + count > length) throw new Error("overflow");
    for (let q = 0; q < count; q++) {
      const z = varint();
      out[k++] = z & 1 ? -((z + 1) >>> 1) : z >>> 1;
    }
  }
  return out;
}
