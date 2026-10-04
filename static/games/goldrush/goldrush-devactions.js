// GoldRush - developer actions (QA tools): what the developer commands do to
// a running game. Loaded only with the developer panel.
//
// Rules: validate first, then change, never half: a command that cannot do
// all of it changes nothing (the panel additionally rolls a failed command
// back to the document from before). Everything goes through the game's own
// systems - items through engine._grantItem (what a purchase does), gold
// through the pouch, material as MaterialBatch (source "dev", booked in the
// processing ledger) - so the game never sees a state it could not reach
// itself. None of this changes prices, drop rates, gold density or recovery.

import { DEV_MAX_CASH } from "./goldrush-economy.js";
import { MaterialBatch, STAGE, PAN_CAPACITY_ML } from "./goldrush-material.js";
import { MATERIALS } from "./goldrush-materials.js";
import { FIND } from "./goldrush-resources.js";
import { SHOP_ITEMS, itemStatus, shopItem } from "./goldrush-shop.js";
import { STATIONS } from "./goldrush-stations.js";
import { SPAWN } from "./goldrush-world.js";
import { WASH } from "./goldrush-processing.js";

export const DEV_ERROR = "Entwickleraktion konnte nicht ausgeführt werden.";
const fail = (error) => ({ ok: false, error });

// ------------------------------------------------------------ cash

/** "1000", "1.000", "12,50", "€ 3" -> cents | null (no NaN / Infinity / negatives / > max / > 2 decimals) */
export function parseEuro(text) {
  let s = String(text == null ? "" : text).replace(/€|\s/g, "");
  if (!s || s.length > 16) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= DEV_MAX_CASH ? cents : null;
}

export function addCash(g, cents) {
  if (!Number.isInteger(cents) || cents <= 0) return fail("Ungültiger Betrag.");
  const next = Math.min(DEV_MAX_CASH, g.economy.cashCents + cents);
  if (!g.economy.devSetCash(next)) return fail(DEV_ERROR);
  g.hud.setMoney(next);
  return { ok: true };
}

export function setCash(g, cents) {
  if (!Number.isInteger(cents) || cents < 0 || cents > DEV_MAX_CASH) return fail("Ungültiger Betrag – erlaubt sind € 0 bis € 1.000.000.");
  g.economy.devSetCash(cents);
  g.hud.setMoney(cents);
  return { ok: true };
}

// ------------------------------------------------------------ gold pouch

// one typical piece of each kind (mass in µg, value from the camp price)
export const POUCH_TESTS = {
  fine: { cls: FIND.FINE, ug: 400, label: "Feiner Goldstaub" },
  flake: { cls: FIND.FLAKE, ug: 1500, label: "Goldflitter" },
  tiny: { cls: FIND.TINY, ug: 4500, label: "Kleines Goldstück" },
  nugget: { cls: FIND.NUGGET, ug: 18000, label: "Nugget" },
};

export function addPouch(g, kind) {
  const t = POUCH_TESTS[kind];
  if (!t) return fail(DEV_ERROR);
  const r = g.economy.devAddPouch(t.cls, t.ug);
  if (!r) return fail(DEV_ERROR);
  g.hud.setPouch(g.economy.pouchCents);
  return { ok: true };
}

export function emptyPouch(g) {
  g.economy.devEmptyPouch();
  g.hud.setPouch(0);
  return { ok: true };
}

// ------------------------------------------------------------ items (from the shop registry)

export function shopState(g) {
  const e = g.economy;
  return { owned: g.tools.owned, upgrades: g.tools.upgrades, equipment: g.processing.owned, hardSeen: e.flags.hardSeen, cashCents: e.cashCents };
}

// every item the shop knows, with its state for this mine
export function itemRows(g) {
  const st = shopState(g);
  return SHOP_ITEMS.map((it) => ({ id: it.id, label: it.label, kind: it.kind, price: it.price, status: itemStatus(it, st).state, supported: g.canGrant(it) }));
}

// a requirement id ("shovel", "bucket") -> the shop item that provides it
const provider = (id) => SHOP_ITEMS.find((i) => (i.kind === "tool" && i.tool === id) || i.id === id) || null;

// the items to grant (prerequisites first) so that `id` is unlocked / owned
function plan(g, id, withItem) {
  const out = [], seen = new Set();
  let hard = false;
  const visit = (it, self) => {
    if (!it || seen.has(it.id)) return true;
    seen.add(it.id);
    if (!g.canGrant(it)) return false;
    const r = it.requires || {};
    for (const need of [...(r.tools || []), ...(r.equipment || [])]) if (!visit(provider(need), true)) return false;
    if (r.hard) hard = true;
    if (self && !g.ownsItem(it)) out.push(it);
    return true;
  };
  const it = shopItem(id);
  if (!it) return null;
  if (!visit(it, withItem)) return null;
  return { items: out, hard };
}

function applyPlan(g, p) {
  if (p.hard) g.economy.flags.hardSeen = true;
  for (const it of p.items) g._grantItem(it);
}

export function refreshItems(g) {
  g.processing.applyUpgrades();
  g.ui.onTool && g.ui.onTool(g.toolState());
  g._stationSig = null;
  g._aim();
}

/** the item's requirements met (prerequisites given), the item itself still to buy */
export function unlockItem(g, id) {
  const p = plan(g, id, false);
  if (!p) return fail(DEV_ERROR);
  applyPlan(g, p);
  refreshItems(g);
  return { ok: true };
}

/** the item owned - with everything it needs */
export function giveItem(g, id) {
  const p = plan(g, id, true);
  if (!p) return fail(DEV_ERROR);
  applyPlan(g, p);
  refreshItems(g);
  return { ok: true, granted: p.items.length };
}

/** every item the shop currently knows (later phases' items included automatically) */
export function giveAll(g) {
  const plans = [];
  const skipped = [];
  for (const it of SHOP_ITEMS) {
    if (!g.canGrant(it)) { skipped.push(it.id); continue; }
    plans.push(it.id);
  }
  let granted = 0;
  for (const id of plans) {
    const p = plan(g, id, true);
    if (!p) { skipped.push(id); continue; }
    applyPlan(g, p);
    granted += p.items.length;
  }
  refreshItems(g);
  return { ok: true, granted, skipped };
}

/** back to the hand only: tools, upgrades, equipment (their content to the tailings) */
export function resetItems(g) {
  const t = g.tools;
  t.owned = new Set(["hand"]);
  t.upgrades = new Set();
  equipNow(g, "hand");
  g.stations.setOwned(t.owned);
  g.hands.models.applyUpgrades(t.upgrades);
  for (const id of [...g.processing.owned]) g.processing.devRemove(id);
  refreshItems(g);
  return { ok: true };
}

export function removeItem(g, id) {
  const it = shopItem(id);
  if (!it || !g.ownsItem(it)) return fail(DEV_ERROR);
  // what needs it goes too (no pickaxe upgrade without the pickaxe)
  for (const other of SHOP_ITEMS) {
    const r = other.requires || {};
    const needs = [...(r.tools || []), ...(r.equipment || [])].map(provider);
    if (other !== it && needs.includes(it) && g.ownsItem(other)) removeItem(g, other.id);
  }
  if (it.kind === "tool") { g.tools.owned.delete(it.tool); if (g.tools.equipped === it.tool) equipNow(g, "hand"); g.stations.setOwned(g.tools.owned); }
  else if (it.kind === "upgrade") { g.tools.upgrades.delete(it.id); g.hands.models.applyUpgrades(g.tools.upgrades); g.processing.applyUpgrades(); g.processing.devFitBucket(); }
  else if (it.kind === "equipment") g.processing.devRemove(it.id);
  else return fail(DEV_ERROR);
  refreshItems(g);
  return { ok: true };
}

// the tool in the hands right away (no lower / raise animation)
export function equipNow(g, id) {
  const t = g.tools;
  if (!t.canUse(id)) return false;
  t.equipped = id; t.target = null; t.state = "idle"; t.phase = null;
  return true;
}

/** a whole test state: exactly these items, this cash, an empty pouch */
export function setLoadout(g, { items = [], cashCents = 0, equip = null, hard = false }) {
  if (!items.every((id) => shopItem(id) && g.canGrant(shopItem(id))) || !Number.isInteger(cashCents) || cashCents < 0 || cashCents > DEV_MAX_CASH) return fail(DEV_ERROR);
  resetItems(g);
  for (const id of items) { const p = plan(g, id, true); if (p) applyPlan(g, p); }
  if (hard) g.economy.flags.hardSeen = true;
  g.economy.devSetCash(cashCents);
  g.economy.devEmptyPouch();
  if (equip) equipNow(g, equip);
  g.hud.setMoney(cashCents);
  g.hud.setPouch(0);
  refreshItems(g);
  return { ok: true };
}

// ------------------------------------------------------------ material

const DENS = MATERIALS.map((m) => m.density / 1000);            // g per ml in place
// test material: the mix by volume and its fine gold (µg per ml); the real
// ground averages ~8 µg/ml (phase-5 benchmark) - "paydirt" is a rich test load
export const DEV_MATERIALS = {
  dirt: { label: "Lockere Erde", mix: [1, 0, 0, 0], fine: 8 },
  compactDirt: { label: "Feste Erde", mix: [0, 1, 0, 0], fine: 8 },
  gravel: { label: "Kies", mix: [0, 0, 1, 0], fine: 8 },
  paydirt: { label: "Goldhaltiges Mischmaterial", mix: [0.55, 0.2, 0.2, 0.05], fine: 25, pieces: true },
  // phase 7A: the ground's two extremes for the wash bowl / the pan
  poordirt: { label: "Goldarme Erde", mix: [0.8, 0.15, 0.05, 0], fine: 3 },
  streak: { label: "Mineralisierte Zone (verfestigter Kies)", mix: [0.05, 0.3, 0.6, 0.05], fine: 48, pieces: "streak" },
};

/** a deterministic test batch (marked source "dev": it did not come out of the mountain) */
export function devBatch(kind, ml, stage = STAGE.RAW) {
  const d = DEV_MATERIALS[kind];
  if (!d || !Number.isInteger(ml) || ml < 0) return null;
  const b = new MaterialBatch({ stage, source: "dev" });
  b.volumeMl = ml;
  for (let m = 0; m < 4; m++) b.comp[m] = Math.round(ml * d.mix[m] * DENS[m]);
  b.fineUg = Math.round(ml * d.fine);
  if (d.pieces) {
    const f = ml / 10000;
    const pieces = [];
    // a streak: more flakes, a tiny piece, no nugget (like the ground: flakes, not a nugget farm)
    for (let i = 0; i < Math.max(1, Math.round((d.pieces === "streak" ? 6 : 3) * f)); i++) pieces.push({ cls: FIND.FLAKE, ug: 1200 });
    if (f >= 0.5) pieces.push({ cls: FIND.TINY, ug: 4000 });
    if (f >= 0.95 && d.pieces !== "streak") pieces.push({ cls: FIND.NUGGET, ug: 12000 });
    b.finds = pieces.map((p, i) => ({ ...p, key: `dev:${kind}:${i}` }));
  }
  b.history = [{ op: "dev", kind }];
  return b;
}

const nearWash = (g) => Math.hypot(g.player.x - WASH.bucketSpot.x, g.player.z - WASH.bucketSpot.z) < 6;

/** the bucket holds `fraction` of what it takes, of this material (0 = empty) */
export function fillBucket(g, fraction, kind = "paydirt") {
  const pr = g.processing;
  if (!pr.bucket) return fail("Erst einen Eimer besitzen.");
  if (pr.work) return fail("Erst die Arbeit am Waschplatz beenden.");
  if (!(fraction >= 0 && fraction <= 1) || !DEV_MATERIALS[kind]) return fail(DEV_ERROR);
  const ml = Math.round(pr.capacityMl * fraction);
  const batch = ml > 0 ? devBatch(kind, ml) : null;
  if (ml > 0 && !batch) return fail(DEV_ERROR);
  // at the wash place: the bucket is set down where you work with it
  if (nearWash(g) && !pr.bucket.carried && !pr.bucketAtWash()) pr.devPlaceBucket(WASH.bucketSpot.x, WASH.bucketSpot.z);
  if (!pr.devSetBucket(batch)) return fail(DEV_ERROR);
  g._stationSig = null;
  return { ok: true };
}

/** a rich concentrate load straight into the (empty) pan - swirl it at the trough */
export function concentrateLoad(g) {
  const pr = g.processing;
  if (!pr.owned.has("pan")) return fail("Erst eine Goldpfanne besitzen.");
  if (pr.work) return fail("Erst die Arbeit am Waschplatz beenden.");
  if (pr.pan.batch.volumeMl > 0 || pr.pan.batch.goldUg > 0) return fail("In der Pfanne liegt schon etwas – erst auswaschen.");
  const b = new MaterialBatch({ stage: STAGE.CONCENTRATE, source: "dev" });
  const ml = PAN_CAPACITY_ML, mix = [0.7, 0.2, 0.1, 0];
  b.volumeMl = ml;
  for (let m = 0; m < 4; m++) b.comp[m] = Math.round(ml * mix[m] * DENS[m]);
  b.fineUg = 40 * ml;
  b.finds = [{ cls: FIND.FLAKE, ug: 1400, key: "dev:conc:0" }, { cls: FIND.FLAKE, ug: 1100, key: "dev:conc:1" }, { cls: FIND.TINY, ug: 3800, key: "dev:conc:2" }];
  b.history = [{ op: "dev", kind: "concentrate" }];
  if (!pr.devPanLoad(b)) return fail(DEV_ERROR);
  g._stationSig = null;
  return { ok: true };
}

export function bucketHere(g) {
  const pr = g.processing, p = g.player;
  if (!pr.bucket) return fail("Erst einen Eimer besitzen.");
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
  if (!pr.devPlaceBucket(p.x + fx * 0.6 + rx * 0.35, p.z + fz * 0.6 + rz * 0.35, p.yaw)) return fail(DEV_ERROR);
  g._stationSig = null;
  return { ok: true };
}

export function bucketToWash(g) {
  const pr = g.processing;
  if (!pr.bucket) return fail("Erst einen Eimer besitzen.");
  if (!pr.devPlaceBucket(WASH.bucketSpot.x, WASH.bucketSpot.z)) return fail(DEV_ERROR);
  g._stationSig = null;
  return { ok: true };
}

export function clearTailings(g) {
  g.processing.devClearTailings();
  return { ok: true };
}

// ------------------------------------------------------------ teleport

const stationSpot = (id) => {
  const st = STATIONS.find((s) => s.id === id);
  return { x: st.x, z: st.z, yaw: Math.atan2(-(st.lookX - st.x), -(st.lookZ - st.z)), pitch: -0.15 };
};

// from the claim entrance straight towards the mound until a face is in reach
function miningSpot(g) {
  let last = null;
  for (let d = 0; d <= 30; d += 0.25) {
    last = g.teleport({ x: SPAWN.x, z: SPAWN.z - d, yaw: 0, pitch: -0.42 });
    if (last && last.ok && g.target && g.aimState === "dig") return last;
  }
  return last;
}

export const TELEPORTS = [
  { id: "spawn", label: "Spawn", spot: () => ({ x: SPAWN.x, z: SPAWN.z, yaw: SPAWN.yaw, pitch: SPAWN.pitch }) },
  { id: "supply", label: "Shop (Ausrüstung)", spot: () => stationSpot("supply") },
  { id: "assay", label: "Goldankauf", spot: () => stationSpot("assay") },
  { id: "wash", label: "Waschplatz", spot: () => ({ x: WASH.panSpot.x, z: WASH.panSpot.z, yaw: WASH.panSpot.yaw, pitch: -0.35 }) },
  { id: "mound", label: "Abbaustelle (Berg)", spot: null },
];

export function teleport(g, id) {
  const t = TELEPORTS.find((x) => x.id === id);
  if (!t) return fail(DEV_ERROR);
  const r = t.spot ? g.teleport(t.spot()) : miningSpot(g);
  if (!r || !r.ok) return fail(DEV_ERROR);
  return { ok: true, pos: r };
}
