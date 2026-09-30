// GoldRush - versioned local save.
//
// localStorage first: the hosted backend (Render free tier + SQLite on an
// ephemeral disk) can't promise persistence, a cloud save can come later
// on top of the same document. One JSON document per browser:
//
//   { saveVersion: 2, worldSeed, createdAt, updatedAt, tool,
//     player: { x, z, yaw, pitch }, settings: {...},
//     economy: { moneyCents, earnedCents, inventory, stats, flags },
//     terrain: { gen, cols, cell, unit, encoding, changed, data },
//     resources: { unit, encoding, changed, slices, level } }
//
// The terrain is stored as quantised height deltas against the seeded
// original mound (millimetres, Int16), run-length encoded - untouched
// ground costs almost nothing, no matter how often it was dug. The worked
// resource slices are stored the same way, relative to the terrain (see
// goldrush-mining.js) - zero almost everywhere.
// Every write keeps the previous good document as a backup.
//
// Versions: 1 = phase 1 (money as a float, no resources); 2 = integer
// cents, gold inventory + statistics, worked resource slices. Older
// documents are upgraded on load (migrate) and written back as 2.

export const SAVE_VERSION = 2;
export const SAVE_KEY = "goldrush.save";
export const BACKUP_KEY = "goldrush.save.backup";
export const CORRUPT_KEY = "goldrush.save.corrupt";

function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function write(key, value) { localStorage.setItem(key, value); }
function remove(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }

const finite = (v) => typeof v === "number" && Number.isFinite(v);

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
    if (!e || typeof e !== "object" || !Number.isInteger(e.moneyCents) || e.moneyCents < 0) return "Geldstand ungültig";
    const r = doc.resources;
    if (r != null && (typeof r.slices !== "string" || typeof r.level !== "string")) return "Ressourcendaten ungültig";
  } else if (!finite(doc.money)) return "Geldstand ungültig";
  return null;
}

// -> { status: "none" | "ok" | "backup" | "corrupt", doc, error }
export function loadSave() {
  const raw = read(SAVE_KEY);
  if (raw == null) return { status: "none", doc: null };
  let error;
  try {
    const doc = JSON.parse(raw);
    error = validate(doc);
    if (!error) return { status: "ok", doc: migrate(doc) };
  } catch (e) {
    error = "nicht lesbar";
  }
  // main document broken: try the previous good one
  const bak = read(BACKUP_KEY);
  if (bak != null) {
    try {
      const doc = JSON.parse(bak);
      if (!validate(doc)) return { status: "backup", doc: migrate(doc), error };
    } catch (e) { /* fall through */ }
  }
  return { status: "corrupt", doc: null, error };
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
  return doc;
}

// -> bytes written; throws if the browser refuses (quota, private mode)
export function writeSave(doc) {
  const json = JSON.stringify(doc);
  const current = read(SAVE_KEY);
  if (current != null && current !== json) {
    try { if (!validate(JSON.parse(current))) write(BACKUP_KEY, current); } catch (e) { /* never back up garbage */ }
  }
  write(SAVE_KEY, json);
  return json.length;
}

// keep the broken document aside (support/debugging) and start fresh
export function quarantineCorrupt() {
  const raw = read(SAVE_KEY);
  if (raw != null) { try { write(CORRUPT_KEY, raw); } catch (e) { /* ignore */ } }
  remove(SAVE_KEY);
}

export function resetSave() {
  remove(SAVE_KEY);
  remove(BACKUP_KEY);
  remove(CORRUPT_KEY);
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

export function decodeInt16Rle(b64, length) {
  const bin = atob(b64);
  const out = new Int16Array(length);
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
