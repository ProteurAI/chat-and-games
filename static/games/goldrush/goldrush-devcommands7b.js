// GoldRush - developer commands of phase 7B (material reality, the container ledger):
// one preset that sets up the whole material QA, then one button per check - a scoop of
// dirt / gravel, the bucket at 25 / 50 / 100 %, a bucket with a known piece in it, the
// barrow at 10 / 40 / 85 l, the classifier at start / middle / end, the pan with little /
// much fine gold, the pay streak. Test material is booked as such (ledger: devInUg).
// The gold ledger view itself is a debug overlay (goldrush-devhud.js, "Gold-Ledger").

import { registerDevCommand as reg } from "./goldrush-devregistry.js";
import { DEV_ERROR, devBatch, equipNow, fillBucket, giveItem, setLoadout } from "./goldrush-devactions.js";
import { TUB_ML, WASH } from "./goldrush-processing.js";
import { MAT } from "./goldrush-materials.js";
import { FIND } from "./goldrush-resources.js";
import { materialSpot, toStreak } from "./goldrush-devcommands7a.js";

const ok = (text) => ({ ok: true, text });
const fail = (error) => ({ ok: false, error });
const GROUP = "Material-QA (7B)";
const BARROW_AT = { x: -15.2, z: 5.6, yaw: Math.PI / 2 };          // parked at the wash place, tray towards the trough

const free = (g) => (g.processing.work ? "Erst die Arbeit am Waschplatz beenden." : true);
const own = (g, id) => (g.processing.owned.has(id) || g.tools.owned.has(id) ? { ok: true } : giveItem(g, id));
const look = (g, x, z, tx, ty, tz) => {
  const eye = g.world.groundAt(x, z) + 1.62, d = Math.hypot(tx - x, tz - z) || 1;
  return g.teleport({ x, z, yaw: Math.atan2(-(tx - x), -(tz - z)), pitch: Math.atan2(ty - eye, d) });
};
const ledgerOn = (ctx) => { if (!ctx.state.toggles.ledger) ctx.tools.setToggle("ledger", true); };

// in front of the nearest face of this material, the shovel in hand: one stroke shows the scoop
function scoopAt(ctx, mat, label) {
  const g = ctx.game, r = own(g, "shovel");
  if (!r.ok) return r;
  equipNow(g, "shovel");
  const sp = materialSpot(g, mat);
  if (!sp) return fail(`${label}: in der Nähe keine offene Stelle.`);
  const t = g.teleport({ x: sp.px, z: sp.pz, yaw: sp.yaw, pitch: sp.pitch });
  return t && t.ok ? ok(`Scoop ${label}: Maustaste halten – die Ladung liegt locker auf dem Blatt und rutscht beim Abwerfen zur Spitze.`) : fail(DEV_ERROR);
}

// a bucket at the wash place with this share of pay dirt, you looking at it
function bucketAt(ctx, f) {
  const g = ctx.game, r = own(g, "bucket");
  if (!r.ok) return r;
  const busy = free(g);
  if (busy !== true) return fail(busy);
  g.processing.devPlaceBucket(WASH.bucketSpot.x, WASH.bucketSpot.z, 0.4);
  const fb = fillBucket(g, f, "paydirt");
  if (!fb.ok) return fb;
  look(g, WASH.bucketSpot.x + 1.2, WASH.bucketSpot.z + 0.5, WASH.bucketSpot.x, 0.25, WASH.bucketSpot.z);
  return ok(`Eimer ${Math.round(f * 100)} %: lockeres Material, Füllhöhe nach Litern, Farbe nach Zusammensetzung.`);
}

// the barrow parked at the wash place holding `ml` of pay dirt
function barrowAt(ctx, ml) {
  const g = ctx.game, pr = g.processing, r = own(g, "wheelbarrow");
  if (!r.ok) return r;
  const busy = free(g);
  if (busy !== true) return fail(busy);
  if (!pr.barrow || !pr.devPlaceBarrow(BARROW_AT.x, BARROW_AT.z, BARROW_AT.yaw) || !pr.devSetBarrow(devBatch("paydirt", ml))) return fail(DEV_ERROR);
  pr._fills();
  look(g, BARROW_AT.x + 1.0, BARROW_AT.z + 0.8, BARROW_AT.x - 0.3, 0.45, BARROW_AT.z);
  return ok(`Schubkarre ${ml / 1000} l: ein unregelmäßiger Haufen, der mit der Menge wächst.`);
}

// a full bucket onto the classifier, shaken to `to` (0 start, 0.5 middle, 1 done)
function sieveTo(ctx, to) {
  const g = ctx.game, pr = g.processing;
  for (const id of ["bucket", "classifier"]) { const r = own(g, id); if (!r.ok) return r; }
  const busy = free(g);
  if (busy !== true) return fail(busy);
  g.teleport({ x: WASH.sieveSpot.x, z: WASH.sieveSpot.z, yaw: WASH.sieveSpot.yaw, pitch: -0.62 });
  // start: a fresh load (what lay on the screen goes to the tailings, booked); middle / end go on
  // with the load that is there (or a fresh one)
  if (to <= 0 && pr.sieve.batch.volumeMl > 0) { pr._devTail(pr.sieve.batch); pr.sieve.batch = pr._batch(pr.sieve.batch.stage); pr.sieve.progress = 0; }
  if (pr.sieve.batch.volumeMl > 0 && pr.sieve.progress < to) pr.startWork("sieve");
  else if (pr.sieve.batch.volumeMl <= 0) {
    if (pr.tub.volumeMl >= TUB_ML - 500) return fail("Die Wanne ist voll – erst waschen.");
    pr.devPlaceBucket(WASH.bucketSpot.x, WASH.bucketSpot.z, 0.4);
    const fb = fillBucket(g, 1, "paydirt");
    if (!fb.ok) return fb;
    if (!pr.loadSieve()) return fail(DEV_ERROR);
  }
  let res = null;
  pr.simWork = true;
  for (let i = 0; i < 4000 && pr.work === "sieve" && pr.sieve.progress < to; i++) res = pr.input(0.07, 0.035, 1 / 30) || res;
  pr.simWork = false;
  if (pr.work) pr.stopWork();
  g._stationSig = null;
  if (to >= 1) return ok(`Klassierer Ende: das Grobe bleibt liegen, ${res && res.underMl != null ? `${(res.underMl / 1000).toFixed(1).replace(".", ",")} l ` : ""}Feines in der Wanne.`);
  return ok(to > 0 ? "Klassierer Mitte: das Feine ist zum Teil durch, der Haufen ist flacher. [E] weiter sieben." : "Klassierer Start: ein voller Eimer auf dem Sieb. [E] sieben.");
}

// the pan loaded with 2,5 l of poor / rich ground, you at the trough
function panWith(ctx, kind, label) {
  const g = ctx.game, pr = g.processing, r = own(g, "pan");
  if (!r.ok) return r;
  const busy = free(g);
  if (busy !== true) return fail(busy);
  pr.devBowl = false;
  if (pr.pan.batch.volumeMl > 0 || pr.pan.batch.goldUg > 0) return fail("In der Pfanne liegt schon etwas – erst auswaschen.");
  if (!pr.devPanLoad(devBatch(kind, 2500))) return fail(DEV_ERROR);
  g.teleport({ x: WASH.panSpot.x, z: WASH.panSpot.z, yaw: WASH.panSpot.yaw, pitch: -0.4 });
  g._stationSig = null;
  return ok(`Pfanne ${label}: [E] weiter waschen – schlammig → helle Erde geht → weniger Steine → Schwarzsand → Gold.`);
}

// ---------------------------------------------------------------- SCHNELLTEST
reg({
  id: "quick.phase7b", category: "quick", label: "Phase 7B Material-QA", cheat: true,
  hint: "Schaufel, Spitzhacke, Eimer, Goldpfanne, Klassierer, Schubkarre, € 50; Gold-Ledger an; du am Waschplatz. Dann Material → Material-QA (7B) der Reihe nach – alles in unter 2 Minuten.",
  run: (ctx) => {
    const g = ctx.game, pr = g.processing;
    const r = setLoadout(g, { items: ["shovel", "pickaxe", "bucket", "pan", "classifier", "wheelbarrow"], cashCents: 5000, equip: "shovel", hard: true });
    if (!r.ok) return r;
    pr.devBowl = false;
    pr.devPlaceBucket(WASH.bucketSpot.x, WASH.bucketSpot.z, 0.4);
    if (pr.barrow) pr.devPlaceBarrow(BARROW_AT.x, BARROW_AT.z, BARROW_AT.yaw);
    ledgerOn(ctx);
    g.teleport({ x: WASH.panSpot.x, z: WASH.panSpot.z, yaw: WASH.panSpot.yaw, pitch: -0.4 });
    g._stationSig = null;
    return ok("Phase 7B: Material → Material-QA (7B): Scoop Erde / Kies, Eimer 25 / 50 / 100 %, Eimer mit bekanntem Fund, Schubkarre 10 / 40 / 85 l, Klassierer Start / Mitte / Ende, Pfanne wenig / viel Feingold, Pay-Streak. Gold-Ledger ist an.");
  },
});

// ---------------------------------------------------------------- MATERIAL: Material-QA
reg({ id: "qa7b.scoopDirt", category: "material", group: GROUP, label: "Scoop: Erde", cheat: true, hint: "Vor eine Erdwand, Schaufel in der Hand.",
  run: (ctx) => scoopAt(ctx, MAT.DIRT, "Erde") });
reg({ id: "qa7b.scoopGravel", category: "material", group: GROUP, label: "Scoop: Kies", cheat: true, hint: "Vor eine Kiesstelle, Schaufel in der Hand.",
  run: (ctx) => scoopAt(ctx, MAT.GRAVEL, "Kies") });
for (const f of [0.25, 0.5, 1]) {
  reg({ id: `qa7b.bucket${Math.round(f * 100)}`, category: "material", group: GROUP, label: `Eimer ${Math.round(f * 100)} %`, cheat: true,
    hint: "Eimer am Waschplatz mit Pay Dirt, du schaust hinein.", run: (ctx) => bucketAt(ctx, f) });
}
reg({ id: "qa7b.bucketKnown", category: "material", group: GROUP, label: "Eimer mit bekanntem Fund", cheat: true,
  hint: "5 l goldarme Erde mit genau einem Flitter (2,0 mg) im Eimer am Waschplatz. Er darf nur durch Waschen in den Beutel – der Gold-Ledger zeigt ihn als Behälter-Input.",
  run: (ctx) => {
    const g = ctx.game, pr = g.processing, r = own(g, "bucket");
    if (!r.ok) return r;
    const busy = free(g);
    if (busy !== true) return fail(busy);
    const b = devBatch("poordirt", 5000);
    b.finds = [{ cls: FIND.FLAKE, ug: 2000, key: "dev:known:0" }];
    pr.devPlaceBucket(WASH.bucketSpot.x, WASH.bucketSpot.z, 0.4);
    if (!pr.devSetBucket(b)) return fail(DEV_ERROR);
    ledgerOn(ctx);
    g.teleport({ x: WASH.panSpot.x, z: WASH.panSpot.z, yaw: WASH.panSpot.yaw, pitch: -0.4 });
    g._stationSig = null;
    return ok("Im Eimer: 1 Flitter (2,0 mg). Er kommt nur beim Waschen heraus – einmal. [E] waschen.");
  } });
for (const ml of [10000, 40000, 85000]) {
  reg({ id: `qa7b.barrow${ml / 1000}`, category: "material", group: GROUP, label: `Schubkarre ${ml / 1000} l`, cheat: true,
    hint: "Schubkarre am Waschplatz mit Pay Dirt, du schaust darauf.", run: (ctx) => barrowAt(ctx, ml) });
}
for (const [id, to, label] of [["qa7b.sieveStart", 0, "Klassierer: Start"], ["qa7b.sieveMid", 0.5, "Klassierer: Mitte"], ["qa7b.sieveEnd", 1, "Klassierer: Ende"]]) {
  reg({ id, category: "material", group: GROUP, label, cheat: true, hint: "Ein voller Eimer Pay Dirt auf dem Sieb, bis zu diesem Stand gerüttelt.", run: (ctx) => sieveTo(ctx, to) });
}
reg({ id: "qa7b.panLow", category: "material", group: GROUP, label: "Pfanne: wenig Feingold", cheat: true, hint: "2,5 l goldarme Erde in der Goldpfanne.",
  run: (ctx) => panWith(ctx, "poordirt", "wenig Feingold") });
reg({ id: "qa7b.panHigh", category: "material", group: GROUP, label: "Pfanne: viel Feingold", cheat: true, hint: "2,5 l aus der mineralisierten Zone in der Goldpfanne.",
  run: (ctx) => panWith(ctx, "streak", "viel Feingold") });
reg({ id: "qa7b.streak", category: "material", group: GROUP, label: "Pay-Streak / Quarz ansehen", cheat: true,
  hint: "Zur ersten mineralisierten Zone: Rost, Quarzadern, dunkle Schwermineral-Bänder – dezent, ohne Marker.",
  run: (ctx) => toStreak(ctx.game, 0) });

// ---------------------------------------------------------------- DIAGNOSE: Gold-Ledger
reg({ id: "debug.ledger", category: "diag", group: "Anzeigen", kind: "toggle", label: "Gold-Ledger (7B)",
  hint: "Sichtbare Funde und Feingold, die in Behälter gingen; was jetzt in Behältern ist; direkt geborgen; durch Processing gewonnen; Abraum – und ob die Bilanz auf das µg aufgeht.",
  value: (ctx) => !!ctx.state.toggles.ledger, set: (ctx, on) => ctx.tools.setToggle("ledger", on) });
