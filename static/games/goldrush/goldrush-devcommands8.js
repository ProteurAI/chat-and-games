// GoldRush - developer commands of phase 8 (the premium vertical-slice pass): one
// preset, then one button per thing to look at - the wheelbarrow empty / half /
// full and on a rough slope, every ground material and the embedded stone, a
// boulder, the mineralised streak, a loaded classifier, the gold buyer, the
// equipment shop, the camp. A pack of its own (goldrush-devregistry.js).

import { registerDevCommand as reg } from "./goldrush-devregistry.js";
import { DEV_ERROR, devBatch, equipNow, giveItem, setLoadout } from "./goldrush-devactions.js";
import { MOUND_CENTER } from "./goldrush-world.js";
import { MAT } from "./goldrush-materials.js";
import { materialSpot, toStreak } from "./goldrush-devcommands7a.js";
import { sieveTo } from "./goldrush-devcommands7b.js";
import { SHED } from "./goldrush-stations.js";

const ok = (text) => ({ ok: true, text });
const fail = (error) => ({ ok: false, error });
const GROUP = "Premium-QA (8)";
const BARROW_SPOT = { x: -8.0, z: 5.0, yaw: Math.PI / 2 };          // open, flat camp ground
const ASSAY = { x: -12.4, z: 10.75 };

const own = (g, id) => (g.processing.owned.has(id) || g.tools.owned.has(id) ? { ok: true } : giveItem(g, id));
const look = (g, x, z, tx, ty, tz) => {
  const eye = g.world.groundAt(x, z) + 1.62, d = Math.hypot(tx - x, tz - z) || 1;
  const r = g.teleport({ x, z, yaw: Math.atan2(-(tx - x), -(tz - z)), pitch: Math.atan2(ty - eye, d) });
  g._stationSig = null;
  return r && r.ok;
};

// the barrow at (x, z) heading yaw with `ml` of pay dirt, you behind its grips - [E] takes it
function barrowAt(ctx, ml, at = BARROW_SPOT) {
  const g = ctx.game, pr = g.processing, r = own(g, "wheelbarrow");
  if (!r.ok) return r;
  if (pr.work) return fail("Erst die Arbeit am Waschplatz beenden.");
  const w = pr.barrow;
  if (!w) return fail(DEV_ERROR);
  if (w.pushing) w.park();
  if (!pr.devPlaceBarrow(at.x, at.z, at.yaw) || !pr.devSetBarrow(ml ? devBatch("paydirt", ml) : null)) return fail(DEV_ERROR);
  pr._fills && pr._fills();
  const c = w.gripsCenter({}), fx = -Math.sin(at.yaw), fz = -Math.cos(at.yaw);
  g.teleport({ x: c.x - fx * 0.7, z: c.z - fz * 0.7, yaw: at.yaw, pitch: -0.45 });
  g._stationSig = null;
  return ok(`Schubkarre ${ml / 1000} l: [E] greifen · W schieben, S bremsen / zurück, A / D lenken, umsehen dreht sie erst spät mit.`);
}

// a spot at the foot of the pile, the barrow pointing up the slope (rough, dug ground on the way)
function roughRoute(ctx) {
  const g = ctx.game, mc = MOUND_CENTER, t = g.terrain;
  let best = null;
  for (let a = 0; a < Math.PI * 2; a += 0.2) {
    for (let r = 4; r < 13; r += 0.25) {
      const x = mc.x + Math.cos(a) * r, z = mc.z + Math.sin(a) * r;
      if (t.getHeightAt(x, z) > 0.45) continue;
      // the wheel at the foot, heading up the flank
      const sx = mc.x + Math.cos(a) * (r + 2.6), sz = mc.z + Math.sin(a) * (r + 2.6);
      const b = g.world.bounds;
      if (sx < b.minX + 1 || sx > b.maxX - 1 || sz < b.minZ + 1 || sz > b.maxZ - 1) break;
      if (!best || Math.abs(a - 2.6) < Math.abs(best.a - 2.6)) best = { a, x, z };
      break;
    }
  }
  if (!best) return fail("Keine freie Stelle am Fuß des Bergs gefunden.");
  return barrowAt(ctx, 60000, { x: best.x, z: best.z, yaw: Math.atan2(Math.cos(best.a), Math.sin(best.a)) });
}

function materialAt(ctx, mat, label) {
  const g = ctx.game, sp = materialSpot(g, mat);
  if (!sp) return fail(`${label}: in der Nähe keine offene Stelle.`);
  const r = g.teleport({ x: sp.px, z: sp.pz, yaw: sp.yaw, pitch: sp.pitch });
  g._stationSig = null;
  return r && r.ok ? ok(`${label}: Hand, Schaufel und Spitzhacke probieren.`) : fail(DEV_ERROR);
}

// ---------------------------------------------------------------- SCHNELLTEST
reg({
  id: "quick.phase8", category: "quick", label: "Phase 8 Premium-QA", cheat: true,
  hint: "Schaufel, Spitzhacke, Eimer, Goldpfanne, Classifier, Schubkarre, € 50; die Schubkarre leer vor dir. Dann Welt → Premium-QA (8): Karre leer / halb / voll / Hang, Materialien, Fels, Felsbrocken, Pay-Streak, Classifier, Goldankauf, Ausrüstung, Camp.",
  run: (ctx) => {
    const g = ctx.game;
    const r = setLoadout(g, { items: ["shovel", "pickaxe", "bucket", "pan", "classifier", "wheelbarrow"], cashCents: 5000, equip: "shovel", hard: true });
    if (!r.ok) return r;
    const b = barrowAt(ctx, 0);
    return b.ok ? ok("Phase 8: Schubkarre vor dir ([E] greifen). Weiter unter Welt → Premium-QA (8).") : b;
  },
});

// ---------------------------------------------------------------- WELT: Premium-QA
reg({ id: "p8.barrowEmpty", category: "world", group: GROUP, label: "Schubkarre leer", cheat: true, run: (ctx) => barrowAt(ctx, 0) });
reg({ id: "p8.barrowHalf", category: "world", group: GROUP, label: "Schubkarre halb (42 l)", cheat: true, run: (ctx) => barrowAt(ctx, 42500) });
reg({ id: "p8.barrowFull", category: "world", group: GROUP, label: "Schubkarre voll (85 l)", cheat: true, run: (ctx) => barrowAt(ctx, 85000) });
reg({ id: "p8.barrowRough", category: "world", group: GROUP, label: "Schubkarre: Hang + raue Strecke", cheat: true,
  hint: "60 l in der Karre am Fuß des Bergs, die Nase den Hang hinauf: bergauf schwer, bergab zieht sie.", run: (ctx) => roughRoute(ctx) });
for (const [id, mat, label] of [["p8.dirt", MAT.DIRT, "Lockere Erde"], ["p8.compact", MAT.COMPACT, "Feste Erde"], ["p8.gravel", MAT.GRAVEL, "Kies"], ["p8.stone", MAT.STONE, "Fels im Berg"]]) {
  reg({ id, category: "world", group: GROUP, label, cheat: true,
    hint: mat === MAT.STONE ? "Schaufel rutscht ab; die Spitzhacke lässt ihn reißen – nach ein paar Hieben bricht er zu Geröll." : undefined,
    run: (ctx) => { if (mat === MAT.STONE) { const r = own(ctx.game, "pickaxe"); if (!r.ok) return r; equipNow(ctx.game, "pickaxe"); } return materialAt(ctx, mat, label); } });
}
reg({ id: "p8.boulder", category: "world", group: GROUP, label: "Felsbrocken", cheat: true,
  run: (ctx) => {
    const g = ctx.game, p = g.player, list = g.rocks.rocks.filter((r) => !r.broken);
    if (!list.length) return fail("Kein ganzer Felsbrocken mehr.");
    list.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    const rk = list[0], mc = MOUND_CENTER, dx = rk.x - mc.x, dz = rk.z - mc.z, d = Math.hypot(dx, dz) || 1, s = rk.r + 1.2;
    return look(g, rk.x + (dx / d) * s, rk.z + (dz / d) * s, rk.x, rk.y + rk.r * 0.4, rk.z) ? ok("Felsbrocken: die Spitzhacke beschädigt ihn sichtbar, bis er bricht.") : fail(DEV_ERROR);
  } });
reg({ id: "p8.streak", category: "world", group: GROUP, label: "Pay-Streak (mineralisiert)", cheat: true, run: (ctx) => toStreak(ctx.game, 0) });
reg({ id: "p8.classifier", category: "world", group: GROUP, label: "Classifier beladen", cheat: true, run: (ctx) => sieveTo(ctx, 0) });
reg({ id: "p8.goldbuyer", category: "world", group: GROUP, label: "Goldankauf (aus 8 m)", cheat: true,
  run: (ctx) => (look(ctx.game, ASSAY.x + 3.2, ASSAY.z - 7.4, ASSAY.x, 1.4, ASSAY.z) ? ok("Goldankauf.") : fail(DEV_ERROR)) });
reg({ id: "p8.shop", category: "world", group: GROUP, label: "Ausrüstung (aus 8 m)", cheat: true,
  run: (ctx) => (look(ctx.game, SHED.x + 3.0, SHED.z - 8.2, SHED.x - 0.4, 1.5, SHED.z - 1.6) ? ok("Ausrüstung.") : fail(DEV_ERROR)) });
reg({ id: "p8.camp", category: "world", group: GROUP, label: "Camp-Überblick", cheat: true,
  run: (ctx) => (look(ctx.game, -6.0, 3.0, -15.0, 1.0, 9.0) ? ok("Camp-Überblick.") : fail(DEV_ERROR)) });
