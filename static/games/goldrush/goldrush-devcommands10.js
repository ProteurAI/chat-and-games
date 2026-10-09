// GoldRush - developer commands of Prompt 10 (the working mine): one preset with
// the whole chain standing (excavator -> raw pile -> loader -> intake -> belt ->
// trommel -> wash plant -> concentrate tub, the oversize stacker, the tailings
// outlet), the places to look at (LOADER COURSE, RAW STOCKPILE, PROCESSING PLANT,
// TAILINGS, EXCAVATION FACE, CAMP OVERVIEW), fills (loader, piles, the plant
// running / blocked, the tub), a full barrow in front of every tip target, the
// sieve's and the mat's result state, the shop upgrades, the jump. Its own pack
// (goldrush-devregistry.js); every command goes through the game's own systems,
// dev material is booked in like a dig. None of this proves the live render on
// Render.com - it is the local production path.
// Big nuggets (Prompt 10, group "Großnuggets (10)"): an ordinary one and EUR 10 / 30 / 50 / 80 - in the ground at
// the crosshair (dig it: the find moment), in the intake (the chain - from EUR 10 the trommel's trap), in the bucket
// (pan or sieve), straight in the trap; each with its own key, booked in like a dig.

import { registerDevCommand as reg, devRegistry } from "./goldrush-devregistry.js";
import { DEV_ERROR, devBatch, equipNow, giveItem, removeItem, setLoadout, fillBucket } from "./goldrush-devactions.js";
import { PHASE9_ITEMS } from "./goldrush-devcommands9.js";
import { INTAKE, TROMMEL, TRAP } from "./goldrush-plant.js";
import { FIND, jackpotTier, JACKPOT_LABEL } from "./goldrush-resources.js";
import { roomOf } from "./goldrush-transfer.js";
import { formatEuro, centsForMass } from "./goldrush-economy.js";
import { OVER_DROP } from "./goldrush-plantmodels.js";
import { PILE_SITES, m3Text } from "./goldrush-stockpile.js";
import { SLUICE_AT } from "./goldrush-sluice.js";
import { WASH, TUB_ML } from "./goldrush-processing.js";
import { MAT } from "./goldrush-materials.js";
import { JUMP } from "./goldrush-engine.js";
import { STAGE } from "./goldrush-material.js";
import { MINER, MINER_HOME } from "./goldrush-autominer.js";

const ok = (text) => ({ ok: true, text });
const fail = (error) => ({ ok: false, error });
const GROUP = "Arbeitsmine (10)";
const TIPS = "Kippziele (10)";
const QA = "Human-QA (10)";
const MINE = "Abbaugerät (10)";
const NUG = "Großnuggets (10)";
export const PHASE10_ITEMS = [...PHASE9_ITEMS, "loader", "conveyor.fast", "trommel.fast", "washplant", "autominer"];
export const TOOL_UPGRADES10 = ["shovel.wide", "shovel.blade", "shovel.handle", "shovel.pro", "bucket.large", "bucket.xl", "barrow.bearings", "barrow.wheel", "barrow.tray"];

const own = (g, id) => (g.processing.owned.has(id) || g.tools.owned.has(id) || g.tools.upgrades.has(id) ? { ok: true } : giveItem(g, id));
const outOfCab = (g) => { if (g.cab) g.exitCab(); };
const parkBarrow = (g) => { const w = g.processing.barrow; if (w && w.pushing) w.park(); };
const look = (g, x, z, tx, ty, tz) => {
  outOfCab(g);
  parkBarrow(g);
  const eye = g.world.groundAt(x, z) + 1.62, d = Math.hypot(tx - x, tz - z) || 1;
  const r = g.teleport({ x, z, yaw: Math.atan2(-(tx - x), -(tz - z)), pitch: Math.atan2(ty - eye, d) });
  g._stationSig = null;
  return r && r.ok;
};
const free = (g, x, z, r, skip = null) => {
  for (const c of g.world.colliders) {
    if (skip && skip.includes(c)) continue;
    const d = c.type === "circle" ? Math.hypot(x - c.x, z - c.z) - c.r : Math.max(Math.abs(x - c.x) - (c.hw || 0), Math.abs(z - c.z) - (c.hd || 0));
    if (d < r) return false;
  }
  return true;
};

// the working mine stands: the phase-9 plant, the plant upgrades, the wash plant; feeder / belt AUTO, water on
function buildMine(g) {
  const pr = g.processing;
  for (const id of ["sluice", "bulkhopper", "feeder", "conveyor", "trommel", "sluice.highflow", "loader", "conveyor.fast", "trommel.fast", "washplant"]) { const r = own(g, id); if (!r.ok) return r; }
  pr.devInstallSluice(); pr.devInstallBulk(); pr.devInstallFeeder(); pr.devFeederMode("auto");
  pr.devInstallConveyor(); pr.devInstallTrommel(); pr.devConveyorMode("auto");
  pr.devInstallWashplant();
  pr.sluice.setWater(true);
  g._stationSig = null;
  return { ok: true };
}

// the loader in front of a pile's open side (facing it, ~4 m off its drop point), on free flat ground
function loaderAt(g, id) {
  const pr = g.processing, ld = pr.loader, P = pr.piles.get(id);
  if (!ld || !P) return null;
  const d = P.site.drop, mine = ld.colliders || [];
  let best = null;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 16) for (const r of [4.2, 5.0, 5.8]) {
    const x = d.x + Math.cos(a) * r, z = d.z + Math.sin(a) * r;
    if (P.inside(x, z, 0.4) || !free(g, x, z, 1.4, mine) || (g.world.decks.length && g.world.deckAt(x, z) > -Infinity)) continue;
    const hs = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([u, v]) => g.world.groundAt(x + u * 1.2, z + v * 1.2));
    if (Math.max(...hs) - Math.min(...hs) > 0.3) continue;
    const score = r + Math.abs(g.world.groundAt(x, z));
    if (!best || score < best.score) best = { x, z, heading: Math.atan2(-(d.z - z), d.x - x), score };
  }
  if (!best) return null;
  ld.place(best.x, best.z, best.heading, 0);
  return best;
}

// the excavator at a face of the mountain with the raw pile within its swing (it digs onto it)
function faceSpot(g) {
  const t = g.terrain, ex = g.processing.excavator, raw = PILE_SITES.raw, cols = ex ? [ex.collider] : [];
  let best = null;
  for (let x = raw.x0 - 1; x <= raw.x1 + 4; x += 0.4) for (let z = raw.z1 - 1; z <= raw.z1 + 6; z += 0.4) {
    if (!t.inDigArea(x, z) || g.world.groundAt(x, z) > 0.4 || !free(g, x, z, 1.25, cols)) continue;
    const hs = [[0.8, 0.62], [0.8, -0.62], [-0.8, 0.62], [-0.8, -0.62]].map(([a, b]) => g.world.groundAt(x + a, z + b));
    if (Math.max(...hs) - Math.min(...hs) > 0.3) continue;
    // the mountain rising in front: the heading towards the mound's centre, ground 0.6 m higher 3 m that way
    const mc = t.moundCenter, hd = Math.atan2(-(mc.z - z), mc.x - x), fx = Math.cos(hd), fz = -Math.sin(hd);
    const rise = g.world.groundAt(x + fx * 3.2, z + fz * 3.2) - g.world.groundAt(x, z);
    if (rise < 0.5) continue;
    const dr = Math.hypot(raw.drop.x - x, raw.drop.z - z), score = Math.abs(dr - 4.5) + Math.abs(rise - 1.2) * 0.5;
    if (!best || score < best.score) best = { x, z, heading: hd, score };
  }
  return best;
}

// a full barrow placed so that the receiver `rid` takes it (tray at its rim / on its site), you behind the grips
function barrowTo(ctx, rid, label) {
  const g = ctx.game, pr = g.processing;
  const b = buildMine(g);
  if (!b.ok) return b;
  for (const t of ["wheelbarrow", "shovel"]) { const r = own(g, t); if (!r.ok) return r; }
  if (pr.work) return fail("Erst die Arbeit am Waschplatz beenden.");
  outOfCab(g);
  parkBarrow(g);
  const R = pr.receivers().find((r) => r.id === rid);
  if (!R) return fail(`${label} steht noch nicht.`);
  const w = pr.barrow, c = {};
  let best = null;
  const at = R.at;
  for (let a = 0; a < Math.PI * 2 && !best; a += Math.PI / 12) for (const d of [1.0, 1.4, 1.9, 2.4, 3.0]) {
    const yaw = Math.atan2(Math.cos(a), Math.sin(a)) + Math.PI;           // facing the target from that side
    const x = at.x + Math.cos(a) * d, z = at.z + Math.sin(a) * d;
    if (!pr.devPlaceBarrow(x, z, Math.atan2(-(at.x - x), -(at.z - z)))) continue;
    w.trayCenter(c);
    const hit = pr._barrowReceiver(w, c);
    const gc = w.gripsCenter({}), fx = -Math.sin(w.yaw), fz = -Math.cos(w.yaw), px = gc.x - fx * 0.7, pz = gc.z - fz * 0.7;
    if (hit && hit.id === rid && free(g, px, pz, 0.36, w.collider ? [w.collider] : [])) { best = { x, z, yaw: w.yaw, px, pz }; break; }
    void yaw;
  }
  if (!best) return fail(`Kein freier Anfahrpunkt an ${label} gefunden.`);
  pr.devPlaceBarrow(best.x, best.z, best.yaw);
  if (!pr.devSetBarrow(devBatch("paydirt", Math.min(w.capacityMl, 85000)))) return fail(DEV_ERROR);
  pr._fills && pr._fills();
  g.teleport({ x: best.px, z: best.pz, yaw: best.yaw, pitch: -0.45 });
  g._stationSig = null;
  return ok(`Volle Schubkarre vor ${label}: [E] greifen, dann [E] kippen (Teilmenge, wenn er voll wird).`);
}

// a work's result state (the gesture done, the motion settled): the sieve / the mat
function toResult(g, kind) {
  const pr = g.processing;
  pr.simWork = true;
  for (let i = 0; i < 6000 && pr.work === kind && pr.workPhase === "gesture"; i++) pr.input(0.07, 0.035, 1 / 30);
  pr.simWork = false;
  pr.tickWork(1);
  g._enterWork();
  return pr.work === kind && pr.workPhase === "result";
}

// ---------------------------------------------------------------- SCHNELLTEST
reg({
  id: "quick.phase10", category: "quick", label: "PHASE 10 WORKING MINE", cheat: true,
  hint: "Alles bis Prompt 10 (Radlader, Förderband- und Trommel-Ausbau, Waschanlage), € 500; Rohhaufen 6 m³, Überkorn 1 m³, Konzentrat in der Wanne; die Anlage läuft (AUTO, Wasser an); du stehst am Radlader vor dem Rohhaufen. Weiter: Welt → Arbeitsmine (10).",
  run: (ctx) => {
    const g = ctx.game, pr = g.processing;
    outOfCab(g);
    const r = setLoadout(g, { items: PHASE10_ITEMS, cashCents: 50000, equip: "shovel", hard: true });
    if (!r.ok) return r;
    const b = buildMine(g);
    if (!b.ok) return b;
    if (!pr.devSetPile("raw", devBatch("paydirt", 6000000), 1.6) || !pr.devSetPile("oversize", devBatch("gravel", 1000000), 0.6) || !pr.devSetConc(devBatch("paydirt", 6000, STAGE.HEAVY))) return fail(DEV_ERROR);
    const fs = faceSpot(g);
    if (fs && pr.excavator) pr.excavator.place(fs.x, fs.z, fs.heading);
    minerAt(g, true);                                                  // the hillside miner at the flank by the intake, working (before the loader parks)
    const lp = loaderAt(g, "raw");
    if (!lp) return fail("Kein freier Platz für den Radlader am Rohhaufen gefunden.");
    const ld = pr.loader, c = Math.cos(ld.heading), s = Math.sin(ld.heading);
    return look(g, ld.x - c * 0.4 - s * 2.6, ld.z + s * 0.4 - c * 2.6, ld.x + c * 1.5, 1.1, ld.z - s * 1.5) ? ok("Phase 10: die Kette steht und läuft. [E] in den Radlader: Linksklick Schaufel absenken, in den Rohhaufen fahren, zum Aufgabetrichter, Rechtsklick / Q kippen.") : fail(DEV_ERROR);
  },
});

// ---------------------------------------------------------------- WELT: the places
reg({ id: "p10.loaderCourse", category: "world", group: GROUP, label: "LOADER COURSE", cheat: true,
  hint: "Im Radlader vor dem Rohhaufen, Schaufel unten: hineinfahren, voll heben, zum Aufgabetrichter, kippen – die Runde Rohhaufen → Trichter.",
  run: (ctx) => {
    const g = ctx.game, pr = g.processing, b = buildMine(g);
    if (!b.ok) return b;
    if (pr.piles.get("raw").volumeMl < 1500000 && !pr.devSetPile("raw", devBatch("paydirt", 6000000), 1.6)) return fail(DEV_ERROR);
    outOfCab(g); parkBarrow(g);
    if (!loaderAt(g, "raw")) return fail("Kein freier Platz für den Radlader am Rohhaufen gefunden.");
    pr.devSetLoader(null);
    if (!g.enterCab(false, "loader")) return fail("Der Radlader lässt sich gerade nicht besteigen.");
    if (pr.loader.mode !== "dig") pr.loader.toggleDig();
    return ok("Im Radlader: W / S fahren, A / D knicken, die Schaufel ist unten – langsam in den Haufen schieben. Rechtsklick / Q kippt am Aufgabetrichter.");
  } });
reg({ id: "p10.raw", category: "world", group: GROUP, label: "RAW STOCKPILE", cheat: true,
  run: (ctx) => {
    const g = ctx.game, pr = g.processing, b = buildMine(g);
    if (!b.ok) return b;
    if (pr.piles.get("raw").volumeMl < 1500000 && !pr.devSetPile("raw", devBatch("paydirt", 6000000), 1.6)) return fail(DEV_ERROR);
    const d = PILE_SITES.raw.drop;
    return look(g, d.x + 5.5, d.z + 5.2, d.x, 0.8, d.z) ? ok(`Der Rohhaufen (${m3Text(pr.piles.get("raw").volumeMl)}): hierher kippt der Bagger, hier holt der Lader.`) : fail(DEV_ERROR);
  } });
reg({ id: "p10.plant", category: "world", group: GROUP, label: "PROCESSING PLANT", cheat: true,
  run: (ctx) => { const g = ctx.game, b = buildMine(g); if (!b.ok) return b; return look(g, SLUICE_AT.x + 5.2, SLUICE_AT.z + 3.4, SLUICE_AT.x + 0.6, 1.0, SLUICE_AT.z - 0.4) ? ok("Trommel (ausgebaut) über dem Vorratstrichter, darunter die Waschanlage: Verteilerkasten, drei Rinnen, Konzentratwanne. Links am Zaun das Überkornband.") : fail(DEV_ERROR); } });
reg({ id: "p10.tailings", category: "world", group: GROUP, label: "TAILINGS", cheat: true,
  run: (ctx) => {
    const g = ctx.game, pr = g.processing, b = buildMine(g);
    if (!b.ok) return b;
    const out = PILE_SITES.tailOut;
    return look(g, out.x1 + 2.4, out.z1 + 3.4, (out.x0 + out.x1) / 2 - 0.6, 0.3, (out.z0 + out.z1) / 2) ? ok(`Tailings-Auslauf (${m3Text(pr.piles.get("tailOut").volumeMl)}) unter den Rinnen, die Tailings-Zone dahinter (${m3Text(pr.piles.get("tailings").volumeMl)}): mit Lader oder Schubkarre umsetzen.`) : fail(DEV_ERROR);
  } });
reg({ id: "p10.face", category: "world", group: GROUP, label: "EXCAVATION FACE", cheat: true,
  run: (ctx) => {
    const g = ctx.game, pr = g.processing, b = buildMine(g);
    if (!b.ok) return b;
    const r = own(g, "excavator");
    if (!r.ok) return r;
    outOfCab(g); parkBarrow(g);
    const fs = faceSpot(g);
    if (!fs) return fail("Keine Abbaufront mit dem Rohhaufen in Reichweite gefunden.");
    pr.excavator.place(fs.x, fs.z, fs.heading);
    if (!g.enterCab()) return fail("Der Bagger lässt sich gerade nicht besteigen.");
    g.player.yaw = fs.heading - Math.PI / 2; g.player.pitch = -0.3;
    return ok("Im Bagger an der Abbaufront: Linksklick graben, dann zum Rohhaufen schwenken und Rechtsklick / Q kippen.");
  } });
reg({ id: "p10.camp", category: "world", group: GROUP, label: "CAMP OVERVIEW", cheat: true,
  run: (ctx) => { const g = ctx.game, b = buildMine(g); if (!b.ok) return b; return look(g, -7.5, 10.5, -17.5, 0.5, -7.0) ? ok("Der Claim als Arbeitsmine: Camp, Waschanlage, Anlage, Rohhaufen, Halden.") : fail(DEV_ERROR); } });

// ---------------------------------------------------------------- MATERIAL: fills (dev material, booked like a dig)
const fill = (id, label, run) => reg({ id, category: "material", group: GROUP, label, cheat: true, run });
fill("p10.loaderEmpty", "Radlader: Schaufel leer", (ctx) => { const g = ctx.game, r = own(g, "loader"); if (!r.ok) return r; return g.processing.devSetLoader(null) ? ok("Schaufel leer.") : fail(DEV_ERROR); });
fill("p10.loaderFull", "Radlader: Schaufel voll (260 l)", (ctx) => { const g = ctx.game, r = own(g, "loader"); if (!r.ok) return r; return g.processing.devSetLoader(devBatch("paydirt", 260000)) ? ok("260 l Rohmaterial in der Schaufel.") : fail(DEV_ERROR); });
fill("p10.rawLow", "Rohhaufen klein (2 m³)", (ctx) => (ctx.game.processing.devSetPile("raw", devBatch("paydirt", 2000000), 1.0) ? ok("Rohhaufen 2 m³.") : fail(DEV_ERROR)));
fill("p10.rawBig", "Rohhaufen groß (12 m³)", (ctx) => (ctx.game.processing.devSetPile("raw", devBatch("paydirt", 12000000), 2.2) ? ok("Rohhaufen 12 m³.") : fail(DEV_ERROR)));
fill("p10.rawPoor", "Rohhaufen arm (4 m³ goldarme Erde)", (ctx) => (ctx.game.processing.devSetPile("raw", devBatch("poordirt", 4000000), 1.4) ? ok("Rohhaufen 4 m³ goldarme Erde.") : fail(DEV_ERROR)));
fill("p10.rawRich", "Rohhaufen reich (4 m³ Mineralzone)", (ctx) => (ctx.game.processing.devSetPile("raw", devBatch("streak", 4000000), 1.4) ? ok("Rohhaufen 4 m³ aus einer mineralisierten Zone.") : fail(DEV_ERROR)));
fill("p10.oversize", "Überkornhaufen (2 m³)", (ctx) => { const g = ctx.game, b = buildMine(g); if (!b.ok) return b; return g.processing.devSetPile("oversize", devBatch("gravel", 2000000), 0.6) ? ok("2 m³ Überkorn am Südende des Überkornbands – der Lader holt es von der offenen Seite.") : fail(DEV_ERROR); });
fill("p10.washRun", "Waschanlage läuft (Vorratstrichter voll)", (ctx) => {
  const g = ctx.game, pr = g.processing, b = buildMine(g);
  if (!b.ok) return b;
  if (!pr.devSetBulk(devBatch("paydirt", pr.bulk.capacityMl)) || !pr.devSetPile("tailOut", null)) return fail(DEV_ERROR);
  return look(g, SLUICE_AT.x + 4.4, SLUICE_AT.z + 3.6, SLUICE_AT.x + 0.8, 0.8, SLUICE_AT.z + 0.4) ? ok("Der Dosierer gibt in den Verteilerkasten auf, drei Rinnen waschen (bis 120 l/min).") : fail(DEV_ERROR);
});
fill("p10.washBlocked", "Waschanlage blockiert (Auslauf voll)", (ctx) => {
  const g = ctx.game, pr = g.processing, b = buildMine(g);
  if (!b.ok) return b;
  if (!pr.devSetBulk(devBatch("paydirt", pr.bulk.capacityMl)) || !pr.devFillOutlet()) return fail(DEV_ERROR);
  return look(g, SLUICE_AT.x + 5.4, SLUICE_AT.z + 3.0, SLUICE_AT.x + 3.0, 0.4, SLUICE_AT.z + 0.2) ? ok("Der Tailings-Auslauf steht bis an die Rinnen: sie warten, der Verteilerkasten füllt sich, der Dosierer stoppt. Mit dem Lader den Auslauf räumen.") : fail(DEV_ERROR);
});
fill("p10.conc", "Konzentrat bereit (8 l in der Wanne)", (ctx) => { const g = ctx.game, b = buildMine(g); if (!b.ok) return b; return g.processing.devSetConc(devBatch("paydirt", 8000, STAGE.HEAVY)) ? ok("8 l Schwerkonzentrat in der Wanne an der Waschanlage: mit dem Eimer abholen, am Waschtrog auswaschen.") : fail(DEV_ERROR); });
fill("p10.outletLow", "Tailings-Auslauf niedrig (0,3 m³)", (ctx) => { const g = ctx.game, b = buildMine(g); if (!b.ok) return b; return g.processing.devSetPile("tailOut", devBatch("gravel", 300000, STAGE.TAILINGS), 0.5) ? ok("0,3 m³ am Auslauf.") : fail(DEV_ERROR); });
fill("p10.outletFull", "Tailings-Auslauf voll", (ctx) => { const g = ctx.game, b = buildMine(g); if (!b.ok) return b; return g.processing.devFillOutlet() ? ok("Der Auslauf steht bis an die Rinnen.") : fail(DEV_ERROR); });
fill("p10.tailZone", "Tailings-Zone (3 m³)", (ctx) => (ctx.game.processing.devSetPile("tailings", devBatch("gravel", 3000000, STAGE.TAILINGS), 1.6) ? ok("3 m³ in der Tailings-Zone.") : fail(DEV_ERROR)));
fill("p10.barrowFull", "Schubkarre voll (am Waschplatz)", (ctx) => {
  const g = ctx.game, pr = g.processing, r = own(g, "wheelbarrow");
  if (!r.ok) return r;
  parkBarrow(g);
  if (!pr.devPlaceBarrow(WASH.barrowDrop.x, WASH.barrowDrop.z, WASH.barrowDrop.yaw) || !pr.devSetBarrow(devBatch("paydirt", pr.barrow.capacityMl))) return fail(DEV_ERROR);
  pr._fills && pr._fills();
  return ok(`Schubkarre voll (${Math.round(pr.barrow.capacityMl / 1000)} l).`);
});

// ---------------------------------------------------------------- KIPPZIELE: a full barrow at each
for (const [rid, label] of [["hopper", "dem Verteilerkasten / Rinnentrichter"], ["bulk", "dem Vorratstrichter (Rampe)"], ["intake", "dem Aufgabetrichter (Bergflanke)"],
  ["pile:raw", "dem Rohhaufen"], ["pile:tailings", "der Tailings-Zone"], ["pile:spoil", "der Abraumhalde"]]) {
  reg({ id: `p10.tip.${rid.replace(":", "-")}`, category: "world", group: TIPS, label: `Karre voll vor ${label.replace(/^(dem|der) /, "")}`, cheat: true, run: (ctx) => barrowTo(ctx, rid, label) });
}
reg({ id: "p10.reverse", category: "world", group: TIPS, label: "Rückwärtskurs (Karre voll)", cheat: true,
  hint: "Die Parkbox des Handling-Kurses mit voller Karre: mit S rückwärts heraus (55–65 % des Vorwärtstempos), dann wenden.",
  run: (ctx) => {
    const load = devRegistry.get("p9.course.load100"), park = devRegistry.get("p9.course.park");
    if (!load || !park) return fail(DEV_ERROR);
    load.run(ctx);
    return park.run(ctx);
  } });

// ---------------------------------------------------------------- HUMAN QA: result states, upgrades, the jump
reg({ id: "p10.sieveResult", category: "material", group: QA, label: "Sieb: Ergebniszustand", cheat: true,
  hint: "Ein voller Eimer gesiebt bis zum Ende: das Ergebnis steht, die Maus dreht die Kamera nicht – [E] / Klick: fertig.",
  run: (ctx) => {
    const g = ctx.game, pr = g.processing;
    for (const id of ["bucket", "classifier"]) { const r = own(g, id); if (!r.ok) return r; }
    outOfCab(g); parkBarrow(g);
    if (pr.work) g._leaveWork();
    if (pr.tub.volumeMl >= TUB_ML - 12000) return fail("Die Wanne ist voll – erst waschen.");
    g.teleport({ x: WASH.sieveSpot.x, z: WASH.sieveSpot.z, yaw: WASH.sieveSpot.yaw, pitch: -0.62 });
    if (pr.sieve.batch.volumeMl <= 0) {
      pr.devPlaceBucket(WASH.bucketSpot.x, WASH.bucketSpot.z, 0.4);
      const fb = fillBucket(g, 1, "paydirt");
      if (!fb.ok) return fb;
      if (!pr.loadSieve()) return fail(DEV_ERROR);
    } else pr.startWork("sieve");
    return toResult(g, "sieve") ? ok("Sieb im Ergebnis: Konzentrat in der Wanne, das Grobe liegt oben. [E] / Klick beendet – erst dann schaut die Maus wieder.") : fail(DEV_ERROR);
  } });
reg({ id: "p10.matResult", category: "material", group: QA, label: "Rinnenmatte: Ergebniszustand", cheat: true,
  hint: "Die Riffel beladen, Wasser aus, die Matte ausgebürstet: das Ergebnis steht – [E] / Klick: fertig.",
  run: (ctx) => {
    const g = ctx.game, pr = g.processing, b = buildMine(g);
    if (!b.ok) return b;
    outOfCab(g); parkBarrow(g);
    if (pr.work) g._leaveWork();
    pr.devRiffles(devBatch("paydirt", 3000, STAGE.HEAVY), 400000);
    pr.sluice.setWater(false);
    const c = pr._slSpots().clean;
    g.teleport({ x: c.x, z: c.z, yaw: c.yaw, pitch: -0.82 });
    if (!pr.sluice.canClean()) return fail("In den Riffeln liegt nichts (oder die Konzentratwanne ist voll).");
    pr.startWork("clean");
    return toResult(g, "clean") ? ok("Matten gereinigt: das Konzentrat liegt in der Wanne an der Anlage. [E] / Klick beendet.") : fail(DEV_ERROR);
  } });
reg({ id: "p10.upgradesAll", category: "equipment", group: QA, label: "Alle Werkzeug-Upgrades (Schaufel, Eimer, Karre)", cheat: true,
  hint: "Großes Blatt, verstärkte Kante, Eschenstiel, Profi-Schaufel; Eimer 14 → 19 l; Karre: Kugellager, Luftreifen, Aufsatzbretter (110 l).",
  run: (ctx) => {
    const g = ctx.game;
    for (const id of ["shovel", "bucket", "wheelbarrow"]) { const r = own(g, id); if (!r.ok) return r; }
    for (const id of TOOL_UPGRADES10) { const r = own(g, id); if (!r.ok) return r; }
    equipNow(g, "shovel");
    return ok("Alle Werkzeug-Upgrades eingebaut – sichtbar an Schaufel, Eimer und Schubkarre.");
  } });
reg({ id: "p10.upgradesNone", category: "equipment", group: QA, label: "Werkzeug-Upgrades entfernen", cheat: true,
  run: (ctx) => {
    const g = ctx.game;
    for (const id of [...TOOL_UPGRADES10].reverse()) if (g.tools.upgrades.has(id)) removeItem(g, id);
    return ok("Schaufel, Eimer und Karre wieder im Grundzustand.");
  } });
reg({ id: "p10.jump", category: "world", group: QA, label: "Sprungtest", cheat: true,
  hint: "Freier, ebener Boden mit einer niedrigen Kante: Leertaste springt (~38 cm), nur vom Boden, kein Doppelsprung, kurz Ruhe nach der Landung.",
  run: (ctx) => {
    const g = ctx.game;
    const d = PILE_SITES.raw.drop;
    if (g.processing.piles.get("raw").volumeMl < 800000) g.processing.devSetPile("raw", devBatch("paydirt", 2000000), 1.0);
    return look(g, d.x + 4.6, d.z + 3.2, d.x, 0.5, d.z) ? ok("Leertaste: springen – an den Haufen heran und hinauf. Mit der Schubkarre, in Maschinen und beim Waschen nicht.") : fail(DEV_ERROR);
  } });
reg({ id: "p10.jumpInfo", category: "world", group: QA, kind: "info", label: "Sprung-Messwerte",
  view: (ctx) => {
    const p = ctx.game.player, J = JUMP, air = (2 * J.v0 / J.g) * (0.5 + 0.5 / Math.sqrt(J.fallK));
    return [["Sprunghöhe (Auslegung)", `${Math.round(J.h * 100)} cm`], ["Absprung", `${J.v0.toFixed(2).replace(".", ",")} m/s, ${Math.round(J.prep * 1000)} ms Ansatz`],
      ["Flugzeit (eben, ca.)", `${air.toFixed(2).replace(".", ",")} s`], ["Ruhe nach der Landung", `${Math.round(J.cool * 1000)} ms`],
      ["Letzter Sprung", p.lastJump ? `${Math.round(p.lastJump.height * 100)} cm · Aufprall ${String(p.lastJump.impact).replace(".", ",")} m/s` : "–"], ["Sprünge / Landungen", `${p.jumps} / ${p.lands}`]];
  } });

// ---------------------------------------------------------------- the automatic hillside miner
// owned, set down at the best stand by the intake (else by the raw pile), on or off
function minerAt(g, on) {
  const pr = g.processing;
  if (!pr.autominer) { const r = own(g, "autominer"); if (!r.ok) return null; }
  const am = pr.autominer;
  if (!am) return null;
  if (am.placed && am.status !== "exhausted" && am.status !== "rock") { am.setOn(on); return { x: am.x, z: am.z, heading: am.heading }; }
  const sp = am.findSpot("intake") || am.findSpot(null);
  if (!sp || !am.place(sp.x, sp.z, sp.heading).ok) return null;
  am.setOn(on);
  return sp;
}
// looking at it from its left side (the panel), the face beyond
const minerLook = (g) => {
  const am = g.processing.autominer, F = am._frame(), f = F.at(2.2, 0);
  // its left side (the panel) first, else the right, else from behind - wherever nothing stands
  for (const [ax, az] of [[0.4, -4.2], [0.4, 4.2], [-2.8, -3.2], [-2.8, 3.2], [-4.2, 0], [0.4, -6.0]]) {
    const p = F.at(ax, az);
    if (free(g, p.x, p.z, 0.7) && !(g.world.decks.length && g.world.deckAt(p.x, p.z) > -Infinity)) return look(g, p.x, p.z, f.x, am.y + 0.9, f.z);
  }
  return look(g, F.at(0.4, -4.2).x, F.at(0.4, -4.2).z, f.x, am.y + 0.9, f.z);
};
reg({ id: "p10.miner", category: "world", group: MINE, label: "ABBAUGERÄT", cheat: true,
  hint: "Das Bergseiten-Abbaugerät an der Flanke beim Aufgabetrichter, es läuft: Kopf fährt an, schneidet, wirft aufs Band, das Band gibt in den Trichter.",
  run: (ctx) => {
    const g = ctx.game, b = buildMine(g);
    if (!b.ok) return b;
    if (!minerAt(g, true)) return fail("Kein gültiger Platz für das Abbaugerät gefunden.");
    return minerLook(g) ? ok(`Abbaugerät: ${g.processing.autominer.statusText()}. Am Bedienpult (links) [E]: an / aus; aus und hinten [E]: versetzen.`) : fail(DEV_ERROR);
  } });
reg({ id: "p10.minerOwn", category: "material", group: MINE, label: "Abbaugerät besitzen (geparkt)", cheat: true,
  hint: "Das Gerät steht geliefert in der Nordwest-Ecke: davor [E] – aufstellen (Vorschau grün / rot, Klick, R dreht).",
  run: (ctx) => {
    const g = ctx.game, b = buildMine(g);
    if (!b.ok) return b;
    const r = own(g, "autominer");
    if (!r.ok) return r;
    const am = g.processing.autominer;
    if (am.placed) { am.setOn(false); am.placed = false; am.x = MINER_HOME.x; am.z = MINER_HOME.z; am.heading = MINER_HOME.heading; am.status = "parked"; am._fit(); am.recv = null; }
    return look(g, am.x - 3.6, am.z + 1.2, am.x, am.y + 0.8, am.z) ? ok("Abbaugerät geliefert – [E]: aufstellen.") : fail(DEV_ERROR);
  } });
reg({ id: "p10.minerSpot", category: "world", group: MINE, label: "Gute Bergflanke", cheat: true,
  hint: "Das Gerät auf den besten Platz am Fuß der Flanke (Austrag in den Aufgabetrichter), aus.",
  run: (ctx) => {
    const g = ctx.game, b = buildMine(g);
    if (!b.ok) return b;
    const am = g.processing.autominer || (own(g, "autominer").ok && g.processing.autominer);
    if (!am) return fail(DEV_ERROR);
    am.setOn(false);
    const sp = am.findSpot("intake") || am.findSpot(null);
    if (!sp || !am.place(sp.x, sp.z, sp.heading).ok) return fail("Kein gültiger Platz gefunden.");
    return minerLook(g) ? ok(`Abbaugerät steht: ${sp.m3.toFixed(1).replace(".", ",")} m³ im Abschnitt, Austrag ${sp.recv === "intake" ? "Aufgabetrichter" : "Rohhaufen"}.`) : fail(DEV_ERROR);
  } });
reg({ id: "p10.minerBelt", category: "material", group: MINE, label: "Material auf dem Band (50 l)", cheat: true,
  run: (ctx) => {
    const g = ctx.game, pr = g.processing;
    if (!minerAt(g, false)) return fail(DEV_ERROR);
    const am = pr.autominer, B = devBatch("paydirt", 50000);
    B.id = pr.nextBatch++;
    pr._devIn(B);
    for (const l of am.buffer.layers) pr._devTail(l);
    am.buffer.layers = [];
    am.buffer.put(B);
    am._load();
    return ok("50 l Rohmaterial auf dem Band des Abbaugeräts.");
  } });
reg({ id: "p10.minerBack", category: "material", group: MINE, label: "Rückstau (Trichter voll)", cheat: true,
  hint: "Band aus, Aufgabetrichter voll, das Gerät läuft: sein Band füllt sich, der Kopf wird langsamer und wartet.",
  run: (ctx) => {
    const g = ctx.game, pr = g.processing, b = buildMine(g);
    if (!b.ok) return b;
    if (!minerAt(g, true) || pr.autominer.recv.kind !== "intake") return fail("Das Gerät steht nicht am Aufgabetrichter.");
    pr.devConveyorMode("stop");
    if (!pr.devSetIntake(devBatch("paydirt", pr.conveyor.capacityMl))) return fail(DEV_ERROR);
    return minerLook(g) ? ok("Trichter voll, Band steht: das Abbaugerät füllt sein Band, wird langsamer und wartet – Förderband wieder an: es läuft von selbst weiter.") : fail(DEV_ERROR);
  } });
reg({ id: "p10.minerRock", category: "material", group: MINE, label: "Hartgestein im Abschnitt", cheat: true,
  hint: "Unter der Oberfläche des Abschnitts liegt fester Fels: der Kopf blockiert – Spitzhacke / Hammer brechen ihn, dann nimmt er das Geröll.",
  run: (ctx) => {
    const g = ctx.game, pr = g.processing, t = g.terrain;
    if (!minerAt(g, false)) return fail(DEV_ERROR);
    const am = pr.autominer, A = MINER.area;
    let n = 0;
    am.constructor.samples(am.x, am.z, am.heading, am.M.area, (x, z) => {
      const i = Math.round((x - t.x0) / t.cell), j = Math.round((z - t.z0) / t.cell);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const k = (j + dj) * t.vps + (i + di), h = t.height[k];
        if (h <= am.y + A.floor + 0.06) continue;
        t.stoneTop[k] = h + 0.5; t.stoneBot[k] = Math.max(am.y + A.floor - 0.2, h - 3); t.rubble[k] = 0; n++;
      }
    });
    t._refresh(0, t.vps - 1, 0, t.vps - 1);
    t.revision++;
    am.setOn(true);
    return minerLook(g) ? ok(`Hartgestein in ${n} Zellen des Abschnitts: ${am.statusText()}.`) : fail(DEV_ERROR);
  } });
reg({ id: "p10.minerNearlyDone", category: "material", group: MINE, label: "Abschnitt fast erschöpft", cheat: true,
  hint: "Echte Schnitte im Schnelldurchlauf, bis kaum noch Berg im Abschnitt ist (das Material geht auf den Rohhaufen).",
  run: (ctx) => {
    const g = ctx.game, pr = g.processing;
    if (!minerAt(g, false)) return fail(DEV_ERROR);
    const am = pr.autominer, raw = pr.piles.get("raw");
    for (let k = 0; k < 4000; k++) {
      if (am.survey().m3 < 0.35) break;
      const r = am.cutNow();
      raw.dumpFrom(am.buffer, Infinity, raw.site.drop.x, raw.site.drop.z, 0.8);
      if (!r && !am.survey().best) break;
    }
    am._load();
    am.setOn(true);
    return minerLook(g) ? ok(`Noch ${am.survey().m3.toFixed(2).replace(".", ",")} m³ im Abschnitt – gleich: ABBAUBEREICH ERSCHÖPFT.`) : fail(DEV_ERROR);
  } });
reg({ id: "p10.minerMove", category: "world", group: MINE, label: "Abbaugerät versetzen", cheat: true,
  hint: "Das Gerät hält an, die Platzierung beginnt: auf den Fuß der Flanke zielen, grün: Klick.",
  run: (ctx) => {
    const g = ctx.game, pr = g.processing;
    if (!minerAt(g, false)) return fail(DEV_ERROR);
    minerLook(g);
    pr.autominer.unplace();
    g._placeStart("autominer", true);
    return ok("Platzierung: Ziel auf den Boden am Fuß der Flanke, grün = gültig, Klick: aufstellen, R: drehen, E: abbrechen.");
  } });

// ---------------------------------------------------------------- BIG NUGGETS: QA pieces of every tier
const NUGS = [["Gewöhnlicher Nugget (€ 2,50)", 25000, "ord"], ["Nugget € 10", 100000, "10"], ["Nugget € 30", 300000, "30"], ["Nugget € 50", 500000, "50"], ["Nugget € 80", 800000, "80"]];
let nugSeq = 0;
const nugKey = (tag) => `dev:nug${tag}:${Date.now().toString(36)}:${++nugSeq}`;
// a dev batch of poor dirt (ml) holding the one piece; booked in by the caller (pr._devIn)
const nugBatch = (ug, tag, ml) => { const b = devBatch("poordirt", ml); b.finds.push({ cls: FIND.NUGGET, ug, key: nugKey(tag) }); b.history = [{ op: "dev", kind: "nugget" }]; return b; };
const tierText = (ug) => { const q = jackpotTier(ug); return q >= 0 ? JACKPOT_LABEL[q] : "gewöhnlicher Nugget"; };
const trapLook = (g) => look(g, TRAP.x - 0.05, TRAP.z - 1.45, TRAP.x, TRAP.y - 0.05, TRAP.z);      // (north of it, between the ramp and the stacker)
for (const [label, ug, tag] of NUGS) {
  reg({ id: `p10.nug.ground.${tag}`, category: "material", group: NUG, label: `${label} im Boden (Fadenkreuz)`, cheat: true,
    hint: "Liegt direkt unter der Oberfläche am Fadenkreuz: einmal graben (Hand, Schaufel, Spitzhacke) – der Fund springt heraus wie jeder andere.",
    run: (ctx) => {
      const g = ctx.game;
      outOfCab(g); parkBarrow(g);
      g._aim();
      const hit = g.target;
      if (!hit || !hit.diggable || hit.distance > 4 || hit.pile) return fail("Fadenkreuz auf grabbaren Boden in Reichweite richten.");
      return g.mining.devPlant(hit.x, hit.z, FIND.NUGGET, ug, nugKey(tag)) ? ok(`${label} (${tierText(ug)}) liegt unter der Oberfläche am Fadenkreuz – einmal graben.`) : fail(DEV_ERROR);
    } });
  reg({ id: `p10.nug.intake.${tag}`, category: "material", group: NUG, label: `${label} in den Aufgabetrichter`, cheat: true,
    hint: "Mit 20 l goldarmer Erde in den Aufgabetrichter: das Band bringt ihn zur Trommel – ab € 10 bleibt er in der Nuggetfalle, kleinere gehen mit dem Feinen in die Rinnen.",
    run: (ctx) => {
      const g = ctx.game, pr = g.processing, b = buildMine(g);
      if (!b.ok) return b;
      // (a full intake: the piece lies on top of its load - the newest layer, out last)
      const cv = pr.conveyor, full = roomOf(cv.intake) < 20000, top = cv.intake.layers[cv.intake.layers.length - 1], B = nugBatch(ug, tag, full ? 0 : 20000);
      if (full && !top) return fail(DEV_ERROR);
      B.id = pr.nextBatch++;
      pr._devIn(B);
      if (full) top.finds.push(...B.finds); else cv.intake.put(B);
      cv._fillSig = null;
      return ok(`${label} im Aufgabetrichter – ${ug >= 100000 ? "die Trommel hält ihn in der Nuggetfalle zurück" : "er geht mit dem Feinen durchs Sieb in die Rinnen (Matten reinigen)"}.`);
    } });
  reg({ id: `p10.nug.bucket.${tag}`, category: "material", group: NUG, label: `${label} im Eimer (Waschplatz)`, cheat: true,
    hint: "Der Eimer am Waschplatz, halb voll goldarmer Erde, darin der Nugget: in die Pfanne oder aufs Sieb.",
    run: (ctx) => {
      const g = ctx.game, pr = g.processing;
      const r = own(g, "bucket");
      if (!r.ok) return r;
      outOfCab(g); parkBarrow(g);
      if (pr.work) g._leaveWork();
      pr.devPlaceBucket(WASH.bucketSpot.x, WASH.bucketSpot.z, 0.4);
      const fb = fillBucket(g, 0.5, "poordirt");
      if (!fb.ok) return fb;
      const B = nugBatch(ug, tag, 0);
      pr._devIn(B);
      pr.bucket.batch.finds.push(...B.finds);
      pr._fills && pr._fills();
      return ok(`${label} im Eimer am Waschplatz – auswaschen oder sieben.`);
    } });
  if (ug >= 100000) reg({ id: `p10.nug.trap.${tag}`, category: "material", group: NUG, label: `${label} in der Nuggetfalle`, cheat: true,
    hint: "Liegt in der Falle unter dem Trommelende (zu groß fürs Sieb): davor stehen, [E] nimmt ihn heraus.",
    run: (ctx) => {
      const g = ctx.game, pr = g.processing, b = buildMine(g);
      if (!b.ok) return b;
      const B = nugBatch(ug, tag, 0);
      pr._devIn(B);
      pr.trommel.trap.push(...B.finds);
      pr.trommel._trapSig = null;
      return trapLook(g) ? ok(`${label} in der Nuggetfalle der Trommel – [E] nimmt ihn heraus.`) : fail(DEV_ERROR);
    } });
}
reg({ id: "p10.nug.trapLook", category: "world", group: NUG, label: "NUGGETFALLE (Trommel)", cheat: true,
  run: (ctx) => { const g = ctx.game, b = buildMine(g); if (!b.ok) return b; return trapLook(g) ? ok("Die Nuggetfalle unter dem Trommelende.") : fail(DEV_ERROR); } });
reg({ id: "p10.nug.stats", category: "material", group: NUG, kind: "info", label: "Großnuggets",
  view: (ctx) => {
    const g = ctx.game, st = g.economy.stats, tr = g.processing.trommel, n = st.bigNuggets || [0, 0, 0, 0];
    const rows = JACKPOT_LABEL.map((l, q) => [l, `${n[q]}`]);
    rows.push(["Wert der Großnuggets", formatEuro(st.bigNuggetCents || 0)], ["Größter Nugget", st.biggestNuggetCents ? `${formatEuro(st.biggestNuggetCents)} (${tierText(st.biggestNuggetUg)})` : "–"]);
    if (tr) rows.push(["Nuggetfalle", tr.trap.length ? tr.trap.map((f) => formatEuro(centsForMass(f.ug))).join(" · ") : "leer"]);
    return rows;
  } });

// ---------------------------------------------------------------- INFO: the chain and its bottleneck
const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)} %` : "–");
reg({ id: "p10.status", category: "material", group: GROUP, kind: "info", label: "Kette & Engpass",
  view: (ctx) => {
    const g = ctx.game, pr = g.processing, cv = pr.conveyor, tr = pr.trommel, wp = pr.washplant, ld = pr.loader, ex = pr.excavator, rows = [];
    for (const P of pr.piles.list()) if (P.volumeMl > 0) rows.push([P.def.name, `${P.def.label} ${m3Text(P.volumeMl)}`]);
    if (ex) rows.push(["Bagger", `${Math.round(ex.stats.dugMl / 1000)} l gegraben · ${ex.stats.scoops} Löffel`]);
    const am = pr.autominer;
    if (am) rows.push(["Abbaugerät", `${am.statusText()} · ${Math.round(am.stats.dugMl / 1000)} l abgebaut · ${Math.round(am.stats.outMl / 1000)} l ausgetragen · wartet ${pct(am.stats.waitS, am.stats.runS)} · Abschnitt ${am.placed ? `${am.survey().m3.toFixed(1).replace(".", ",")} m³` : "–"}`]);
    if (ld) rows.push(["Radlader", `Schaufel ${Math.round(ld.volumeMl / 1000)} / 260 l · ${ld.mode === "dig" ? "unten" : "oben"} · ${Math.round(ld.stats.tookMl / 1000)} l aufgenommen · ${Math.round(ld.stats.intakeMl / 1000)} l in den Trichter`]);
    if (cv) rows.push(["Förderband", `${cv.fast ? "ausgebaut · " : ""}${Math.round(cv.belt.rateLpm)} l/min · Trichter ${Math.round(cv.volumeMl / 1000)} / ${Math.round(cv.capacityMl / 1000)} l · blockiert ${pct(cv.stats.blockedS, cv.stats.runS)} · leer ${pct(cv.stats.starvedS, cv.stats.runS)}`]);
    if (tr) rows.push(["Trommel", `${tr.lpm} l/min · ${tr.status().text} · wartet ${pct(tr.stats.blockedS, tr.stats.runS)} · leer ${pct(tr.stats.starvedS, tr.stats.runS)} · Überkornband ${Math.round(tr.overBelt.volumeMl / 1000)} l`]);
    if (wp && wp.installed) rows.push(["Waschanlage", `${wp.rateLpm} / ${wp.maxLpm} l/min · Recovery ${Math.round(wp.capture * 100)} % · Matten ${Math.round(wp.maxRiffleLoad() * 100)} % · blockiert ${pct(wp.stats.blockedS, wp.stats.runS)} · Wanne ${(wp.conc.batch.volumeMl / 1000).toFixed(1).replace(".", ",")} l`]);
    else if (pr.sluice) rows.push(["Rinne", `${pr.sluice.rateLpm} l/min · Riffel ${Math.round(pr.sluice.riffleLoad * 100)} %`]);
    void MAT; void INTAKE; void TROMMEL; void OVER_DROP;
    return rows;
  } });
