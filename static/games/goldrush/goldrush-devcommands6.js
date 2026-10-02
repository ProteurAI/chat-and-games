// GoldRush - developer commands of phase 6 (wheelbarrow, sluice). A pack of
// its own, registered like phase 1-5 (goldrush-devregistry.js) - the panel
// did not change for it. Test material is a MaterialBatch marked "dev",
// booked in the processing ledger as test input (devactions.devBatch).

import { registerDevCommand as reg } from "./goldrush-devregistry.js";
import { DEV_MATERIALS, devBatch, giveItem, setLoadout, fillBucket } from "./goldrush-devactions.js";
import { SLUICE_TUNING } from "./goldrush-material.js";
import { SLUICE_AT, SLUICE_SPOTS, FEED_LPM } from "./goldrush-sluice.js";
import { FIND } from "./goldrush-resources.js";

const ok = (text) => ({ ok: true, text });
const fail = (error) => ({ ok: false, error });
const needBarrow = (ctx) => (ctx.game.processing.barrow ? true : "Erst eine Schubkarre besitzen.");
const needSluice = (ctx) => (ctx.game.processing.sluice ? true : "Erst eine Waschrinne besitzen.");
const PHASE6 = ["shovel", "pickaxe", "shovel.blade", "shovel.handle", "pickaxe.tip", "pickaxe.head", "bucket", "pan", "classifier", "pan.riffles", "bucket.large", "wheelbarrow", "sluice"];

// the barrow parked south of the hopper, facing it: take it, push 1 m, tip it
const BARROW_AT_HOPPER = { x: SLUICE_AT.x - 0.27, z: SLUICE_AT.z - 1.75, yaw: Math.PI };

function fillBarrow(g, fraction, kind) {
  const pr = g.processing, w = pr.barrow;
  if (!w) return fail("Erst eine Schubkarre besitzen.");
  if (w.pushing || w.dump) return fail("Erst die Schubkarre abstellen.");
  const ml = Math.round(w.capacityMl * fraction);
  const b = ml > 0 ? devBatch(kind, ml) : null;
  if (!pr.devSetBarrow(b)) return fail("Entwickleraktion konnte nicht ausgeführt werden.");
  g._stationSig = null;
  return ok(ml ? `Schubkarre ${Math.round(fraction * 100)} % ${DEV_MATERIALS[kind].label}.` : "Schubkarre ist leer.");
}

function installSluice(g) {
  if (!g.processing.sluice) { const r = giveItem(g, "sluice"); if (!r.ok) return r; }
  g.processing.devInstallSluice();
  return ok("Waschrinne steht.");
}

// ---------------------------------------------------------------- SCHNELLTEST
reg({
  id: "quick.phase6", category: "quick", label: "Phase 6 Mechanisierung", cheat: true,
  hint: "Alles aus Phase 1–5, Schubkarre und aufgebaute Waschrinne, € 200 – die Karre steht voll Testmaterial vor dem Trichter, der Trichter ist halb voll, du stehst dahinter.",
  run: (ctx) => {
    const g = ctx.game, pr = g.processing;
    const r = setLoadout(g, { items: PHASE6, cashCents: 20000, equip: "shovel", hard: true });
    if (!r.ok) return r;
    installSluice(g);
    pr.devPlaceBarrow(BARROW_AT_HOPPER.x, BARROW_AT_HOPPER.z, BARROW_AT_HOPPER.yaw);
    fillBarrow(g, 1, "paydirt");
    pr.devSetHopper(devBatch("paydirt", Math.round(pr.sluice.capacityMl / 2)));
    pr.sluice.setWater(false);
    fillBucket(g, 0, "paydirt");
    const w = pr.barrow, f = w.fwd();
    g.teleport({ x: w.x - f.x * 2.15, z: w.z - f.z * 2.15, yaw: w.yaw, pitch: -0.3 });
    return ok("Phase 6: Schubkarre voll vor dem Trichter – [E] greifen, ein Stück schieben, [E] auskippen.");
  },
});

// ---------------------------------------------------------------- AUSRÜSTUNG / MATERIAL: Schubkarre
reg({ id: "barrow.give", category: "material", group: "Schubkarre", label: "Schubkarre geben", cheat: true,
  available: (ctx) => (ctx.game.processing.barrow ? "Schon vorhanden." : true), run: (ctx) => { const r = giveItem(ctx.game, "wheelbarrow"); return r.ok ? ok("Schubkarre steht neben dem Schuppen.") : r; } });
for (const [pct, label] of [[0, "Schubkarre leer"], [25, "Schubkarre 25 %"], [50, "Schubkarre 50 %"], [100, "Schubkarre voll"]]) {
  reg({ id: `barrow.fill${pct}`, category: "material", group: "Schubkarre", label, cheat: true, available: needBarrow, run: (ctx) => fillBarrow(ctx.game, pct / 100, ctx.state.matKind) });
}
reg({ id: "barrow.paydirt", category: "material", group: "Schubkarre", label: "Pay Dirt einfüllen", cheat: true, available: needBarrow,
  hint: "Eine volle Karre goldhaltiges Testmaterial (Entwickler-Batch).", run: (ctx) => fillBarrow(ctx.game, 1, "paydirt") });
reg({ id: "barrow.here", category: "material", group: "Schubkarre", label: "Schubkarre herholen", cheat: true, available: needBarrow,
  run: (ctx) => {
    const g = ctx.game, p = g.player, fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
    // set down beside you, pointing the way you look: a step sideways and it is in reach of its grips
    const x = p.x + fx * 1.0 + rx * 1.2, z = p.z + fz * 1.0 + rz * 1.2;
    if (!g.processing.devPlaceBarrow(x + fx * 0.8, z + fz * 0.8, p.yaw)) return fail("Erst die Schubkarre abstellen.");
    g._stationSig = null;
    return ok("Die Schubkarre steht neben dir.");
  } });

// ---------------------------------------------------------------- MATERIAL: Waschrinne
reg({ id: "sluice.unlock", category: "material", group: "Waschrinne", label: "Waschrinne freischalten (aufgebaut)", cheat: true,
  available: (ctx) => (ctx.game.processing.sluice && ctx.game.processing.sluice.installed ? "Steht schon." : true), run: (ctx) => installSluice(ctx.game) });
reg({ id: "sluice.hopper0", category: "material", group: "Waschrinne", label: "Trichter leer", cheat: true, available: needSluice,
  run: (ctx) => (ctx.game.processing.devSetHopper(null) ? ok("Trichter ist leer.") : fail("Entwickleraktion konnte nicht ausgeführt werden.")) });
reg({ id: "sluice.hopperFull", category: "material", group: "Waschrinne", label: "Trichter voll", cheat: true, available: needSluice,
  run: (ctx) => { const sl = ctx.game.processing.sluice; return ctx.game.processing.devSetHopper(devBatch(ctx.state.matKind, sl.capacityMl)) ? ok(`Trichter voll: ${DEV_MATERIALS[ctx.state.matKind].label}.`) : fail("Entwickleraktion konnte nicht ausgeführt werden."); } });
reg({ id: "sluice.paydirt", category: "material", group: "Waschrinne", label: "Test-Paydirt in die Waschrinne", cheat: true, available: needSluice,
  hint: "Der Trichter voll goldhaltigem Testmaterial.", run: (ctx) => { const sl = ctx.game.processing.sluice; return ctx.game.processing.devSetHopper(devBatch("paydirt", sl.capacityMl)) ? ok("Trichter voll Pay Dirt.") : fail("Entwickleraktion konnte nicht ausgeführt werden."); } });
reg({ id: "sluice.start", category: "material", group: "Waschrinne", label: "Processing starten (Wasser an)", cheat: true,
  available: (ctx) => { const sl = ctx.game.processing.sluice; return !sl ? "Erst eine Waschrinne besitzen." : !sl.installed ? "Erst aufbauen." : sl.running ? "Läuft schon." : true; },
  run: (ctx) => { ctx.game.processing.sluice.setWater(true); return ok("Wasser an – die Rinne läuft, solange Material im Trichter ist."); } });
reg({ id: "sluice.cleanReady", category: "material", group: "Waschrinne", label: "Cleanout bereit machen", cheat: true, available: needSluice,
  hint: "Riffel voll beladen (Testkonzentrat mit Gold und zwei Nuggets), Wasser aus – an der Rinne [E]: reinigen.",
  run: (ctx) => {
    const pr = ctx.game.processing, sl = pr.sluice, h = devBatch("paydirt", 900);
    h.fineUg = 260000;
    h.finds = [{ cls: FIND.FLAKE, ug: 1500, key: "dev:riffle:0" }, { cls: FIND.TINY, ug: 4200, key: "dev:riffle:1" }, { cls: FIND.NUGGET, ug: 14000, key: "dev:riffle:2" }, { cls: FIND.NUGGET, ug: 9000, key: "dev:riffle:3" }];
    if (!pr.devRiffles(h, SLUICE_TUNING.riffleL * 1000)) return fail("Entwickleraktion konnte nicht ausgeführt werden.");
    sl.setWater(false);
    return ok("Riffelmatte voll – an der Rinne reinigen.");
  } });
reg({ id: "sluice.debug", category: "material", group: "Waschrinne", kind: "info", label: "Sluice Output Debug",
  view: (ctx) => {
    const sl = ctx.game.processing.sluice;
    if (!sl) return [["Waschrinne", "nicht vorhanden"]];
    const l = (ml) => `${(ml / 1000).toFixed(1).replace(".", ",")} l`;
    return [
      ["Zustand", `${sl.state}${sl.build >= 0 ? " (Aufbau)" : ""} · Wasser ${sl.running ? "an" : "aus"}${sl.processing ? " · wäscht" : ""}`],
      ["Trichter", `${l(sl.hopper.batch.volumeMl)} / ${l(sl.capacityMl)} · ${sl.hopper.batch.goldUg.toLocaleString("de-DE")} µg Gold`],
      ["Durchsatz", `${FEED_LPM} l/min · Rückhalt Feingold ${Math.round(sl.efficiency() * 100)} %`],
      ["Riffel", `${Math.round(sl.riffleLoad * 100)} % beladen · ${l(sl.riffles.volumeMl)} · ${sl.riffles.goldUg.toLocaleString("de-DE")} µg · ${sl.riffles.finds.length} Stück(e)`],
      ["Konzentratschale", `${l(sl.tray.batch.volumeMl)} · ${sl.tray.batch.goldUg.toLocaleString("de-DE")} µg`],
      ["Abraum (Halde)", l(sl.tailMl)],
      ["Gesamt", `${l(sl.stats.processedMl)} gewaschen · ${sl.stats.cleanouts} Reinigungen`],
    ];
  } });

// ---------------------------------------------------------------- WELT
reg({ id: "world.tp.sluice", category: "world", group: "Teleport", label: "Waschrinne", cheat: true,
  run: (ctx) => {
    const r = ctx.game.teleport({ x: SLUICE_SPOTS.feed.x, z: SLUICE_SPOTS.feed.z, yaw: SLUICE_SPOTS.feed.yaw, pitch: -0.35 });
    return r && r.ok ? ok("Teleport: Waschrinne.") : fail("Entwickleraktion konnte nicht ausgeführt werden.");
  } });

