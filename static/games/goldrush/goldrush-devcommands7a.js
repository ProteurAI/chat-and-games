// GoldRush - developer commands of phase 7A (quality gate): the wooden wash
// bowl, the mineralised streaks (geology), the gold's visual scale, the camp.
// A pack of its own, registered like the others (goldrush-devregistry.js).
// Gold samples are LOOKS only: shown like a find, booked nowhere.

import { registerDevCommand as reg } from "./goldrush-devregistry.js";
import { devBatch, equipNow, fillBucket, giveItem, setLoadout } from "./goldrush-devactions.js";
import { WASH } from "./goldrush-processing.js";
import { MAT } from "./goldrush-materials.js";
import { FIND } from "./goldrush-resources.js";

const ok = (text) => ({ ok: true, text });
const fail = (error) => ({ ok: false, error });
const DEV_ERROR = "Entwickleraktion konnte nicht ausgeführt werden.";
const needBucket = (ctx) => (ctx.game.processing.bucket ? true : "Erst einen Eimer besitzen.");

// a surface point of streak i where it shows best, and a spot 1,4 m in front of it facing it
function streakSpot(g, i) {
  const f = g.terrain.field, T = g.terrain, s = (f.streaks || [])[i];
  if (!s) return null;
  let best = null;
  for (let u = -s.len; u <= s.len; u += 0.125) {
    for (let v = -s.w; v <= s.w; v += 0.125) {
      const x = s.x + u * Math.cos(s.strike) - v * Math.sin(s.strike), z = s.z + u * Math.sin(s.strike) + v * Math.cos(s.strike);
      const h = T.getHeightAt(x, z), val = f.streakAt(x, h - 0.02, z);
      if (val > 0 && (!best || val > best.val)) best = { x, z, h, val };
    }
  }
  if (!best) { const h = T.getHeightAt(s.x, s.z); best = { x: s.x, z: s.z, h, val: 0 }; }
  // stand downhill of it (towards the mound's outside)
  const mc = T.moundCenter, dx = best.x - mc.x, dz = best.z - mc.z, d = Math.hypot(dx, dz) || 1;
  const px = best.x + (dx / d) * 1.4, pz = best.z + (dz / d) * 1.4;
  const eye = g.world.groundAt(px, pz) + 1.62;
  return { ...best, px, pz, yaw: Math.atan2(-(best.x - px), -(best.z - pz)), pitch: Math.atan2(best.h - eye, 1.4), depth: Math.max(0, s.y + s.th - best.h) };
}

function toStreak(g, i) {
  const sp = streakSpot(g, i);
  if (!sp) return fail("Diese Mine hat keine mineralisierte Zone.");
  const r = g.teleport({ x: sp.px, z: sp.pz, yaw: sp.yaw, pitch: sp.pitch });
  if (!r || !r.ok) return fail(DEV_ERROR);
  g._stationSig = null;
  return ok(sp.val > 0.3 ? `Mineralisierte Zone ${i + 1}: sie steht hier an der Oberfläche an (rostig, Quarz, dunkler Schwersand).`
    : `Mineralisierte Zone ${i + 1}: liegt hier unter der Oberfläche – graben, bis der harte Kies kommt.`);
}

// the nearest face of this material (scanning the pile around you)
function materialSpot(g, mat) {
  const f = g.terrain.field, T = g.terrain, p = g.player;
  let best = null;
  for (let r = 1.5; r <= 14 && !best; r += 0.5) {
    for (let a = 0; a < Math.PI * 2; a += 0.12) {
      const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
      if (!T.inDigArea(x, z)) continue;
      const h = T.getHeightAt(x, z);
      if (h < 0.15 || f.materialAt(x, h - 0.006, z) !== mat) continue;
      best = { x, z, h };
      break;
    }
  }
  if (!best) return null;
  const mc = T.moundCenter, dx = best.x - mc.x, dz = best.z - mc.z, d = Math.hypot(dx, dz) || 1;
  const px = best.x + (dx / d) * 1.5, pz = best.z + (dz / d) * 1.5, eye = g.world.groundAt(px, pz) + 1.62;
  return { px, pz, yaw: Math.atan2(-(best.x - px), -(best.z - pz)), pitch: Math.atan2(best.h - eye, 1.5) };
}

// a find shown in front of you (looks only: no id - nothing is booked)
function showFind(g, cls, cents) {
  const p = g.player, fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
  const x = p.x + fx * 1.1, z = p.z + fz * 1.1, y = g.world.groundAt(x, z) + 0.02;
  g.loot.spawn([{ id: null, cls, cents, massUg: cents * 100, key: "dev:look" }], { x, y, z, normal: { x: -fx * 0.3, y: 0.95, z: -fz * 0.3 } });
  return true;
}

// ---------------------------------------------------------------- SCHNELLTEST
reg({
  id: "quick.phase7a", category: "quick", label: "Phase 7A Qualitätstest", cheat: true,
  hint: "Schaufel, Spitzhacke, Eimer (keine Goldpfanne), € 50 – der Eimer voll Pay Dirt am Waschplatz, du davor: Waschschale testen. Dann: Pay-Streak, Goldgrößen, Material-Vorschau (Welt / Material).",
  run: (ctx) => {
    const g = ctx.game, pr = g.processing;
    const r = setLoadout(g, { items: ["shovel", "pickaxe", "bucket"], cashCents: 5000, equip: "shovel", hard: true });
    if (!r.ok) return r;
    pr.devBowl = false;
    pr.devPlaceBucket(WASH.bucketSpot.x, WASH.bucketSpot.z, 0.4);
    pr.devSetBucket(devBatch("paydirt", pr.capacityMl));
    g.teleport({ x: WASH.panSpot.x, z: WASH.panSpot.z, yaw: WASH.panSpot.yaw, pitch: -0.4 });
    g._stationSig = null;
    return ok("Phase 7A: [E] Waschschale aus dem Eimer füllen, schwenken, Gold einsammeln. Weiter: Welt → Pay-Streak, Material → Goldgrößen.");
  },
});

// ---------------------------------------------------------------- MATERIAL: Waschschale
reg({ id: "wash.bowlTest", category: "material", group: "Waschschale (7A)", label: "Basic-Wash-Test", cheat: true,
  hint: "Eimer voll Pay Dirt am Waschplatz, du davor; gewaschen wird mit der Waschschale (auch wenn eine Goldpfanne da ist).",
  run: (ctx) => {
    const g = ctx.game, pr = g.processing;
    if (!pr.bucket) { const r = giveItem(g, "bucket"); if (!r.ok) return r; }
    if (pr.work) return fail("Erst die Arbeit am Waschplatz beenden.");
    pr.devBowl = true;
    pr.devPlaceBucket(WASH.bucketSpot.x, WASH.bucketSpot.z, 0.4);
    pr.devSetBucket(devBatch("paydirt", pr.capacityMl));
    g.teleport({ x: WASH.panSpot.x, z: WASH.panSpot.z, yaw: WASH.panSpot.yaw, pitch: -0.4 });
    g._stationSig = null;
    return ok("Waschschale: [E] füllen, kreisen, einsammeln.");
  } });
reg({ id: "wash.forceBowl", category: "material", group: "Waschschale (7A)", kind: "toggle", label: "Waschschale statt Goldpfanne",
  hint: "Nur für den Test: auch mit Goldpfanne wird in der Holzschale gewaschen (nicht gespeichert).",
  value: (ctx) => !!ctx.game.processing.devBowl, set: (ctx, on) => { ctx.game.processing.devBowl = !!on; ctx.game._stationSig = null; } });
for (const [id, kind, label] of [["bucket.poor", "poordirt", "Eimer: goldarme Erde"], ["bucket.paydirt7a", "paydirt", "Eimer: Pay Dirt"], ["bucket.streak", "streak", "Eimer: mineralisierte Zone (reich)"]]) {
  reg({ id, category: "material", group: "Waschschale (7A)", label, cheat: true, available: needBucket,
    run: (ctx) => { const r = fillBucket(ctx.game, 1, kind); return r.ok ? ok(`${label}.`) : r; } });
}

// ---------------------------------------------------------------- MATERIAL: Goldgrößen (Sichtprobe)
for (const [id, cls, cents, label] of [["gold.trace", FIND.TRACE, 2, "Goldstaub (2 ct)"], ["gold.fine", FIND.FINE, 6, "Feines Gold (6 ct)"],
  ["gold.flake", FIND.FLAKE, 15, "Flitter (15 ct)"], ["gold.tiny", FIND.TINY, 50, "Kleines Goldstück (50 ct)"], ["gold.nugget", FIND.NUGGET, 250, "Nugget (€ 2,50)"]]) {
  reg({ id, category: "material", group: "Goldgrößen (Sichtprobe)", label, hint: "Zeigt einen Fund dieser Klasse vor dir – nur zum Ansehen, es wird nichts gebucht.",
    run: (ctx) => (showFind(ctx.game, cls, cents) ? ok(`Sichtprobe: ${label} – nichts gebucht.`) : fail(DEV_ERROR)) });
}

// ---------------------------------------------------------------- WELT: Geologie
reg({ id: "geo.streak", category: "world", group: "Geologie (7A)", label: "Pay-Streak: hin und zeigen", cheat: true,
  hint: "Zur nächsten mineralisierten Zone (der Reihe nach) – dorthin, wo sie am besten zu sehen ist.",
  run: (ctx) => { const n = (ctx.game.terrain.field.streaks || []).length || 1; ctx.state.streakI = ((ctx.state.streakI ?? -1) + 1) % n; return toStreak(ctx.game, ctx.state.streakI); } });
reg({ id: "geo.pickaxe", category: "world", group: "Geologie (7A)", label: "Spitzhacken-Geologie-Test", cheat: true,
  hint: "Schaufel und Spitzhacke geben, Spitzhacke in die Hand, vor die erste mineralisierte Zone: Hand / Schaufel prallen ab, die Spitzhacke lockert, dann schaufeln.",
  run: (ctx) => {
    const g = ctx.game;
    for (const id of ["shovel", "pickaxe"]) if (!g.tools.owned.has(id)) { const r = giveItem(g, id); if (!r.ok) return r; }
    equipNow(g, "pickaxe");
    return toStreak(g, 0);
  } });
reg({ id: "geo.materials", category: "world", group: "Geologie (7A)", label: "Material-Vorschau (Erde → Feste Erde → Kies → Stein)", cheat: true,
  hint: "Der Reihe nach zur nächsten Stelle mit diesem Material an der Oberfläche.",
  run: (ctx) => {
    const order = [[MAT.DIRT, "Lockere Erde"], [MAT.COMPACT, "Feste Erde"], [MAT.GRAVEL, "Kies"], [MAT.STONE, "Stein"]];
    ctx.state.matI = ((ctx.state.matI ?? -1) + 1) % order.length;
    const [mat, label] = order[ctx.state.matI], sp = materialSpot(ctx.game, mat);
    if (!sp) return fail(`${label}: in der Nähe keine offene Stelle.`);
    const r = ctx.game.teleport({ x: sp.px, z: sp.pz, yaw: sp.yaw, pitch: sp.pitch });
    return r && r.ok ? ok(`Material-Vorschau: ${label}.`) : fail(DEV_ERROR);
  } });
reg({ id: "world.tp.camp", category: "world", group: "Teleport", label: "Camp (Überblick)", cheat: true,
  run: (ctx) => { const r = ctx.game.teleport({ x: -13.6, z: 6.4, yaw: 1.05, pitch: -0.18 }); return r && r.ok ? ok("Teleport: Camp.") : fail(DEV_ERROR); } });
