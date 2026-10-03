// GoldRush - developer commands of phase 7 (bulk hopper, feeder). A pack of
// its own, registered like phase 1-6 (goldrush-devregistry.js) - the panel
// did not change for it. Test material is a MaterialBatch marked "dev",
// booked in the processing ledger as test input (devactions.devBatch).

import { registerDevCommand as reg } from "./goldrush-devregistry.js";
import { DEV_MATERIALS, devBatch, giveItem, setLoadout } from "./goldrush-devactions.js";
import { SLUICE_TUNING } from "./goldrush-material.js";
import { AUTO_SPOTS, RAMP } from "./goldrush-automation.js";
import { FIND } from "./goldrush-resources.js";

const ok = (text) => ({ ok: true, text });
const fail = (error) => ({ ok: false, error });
const DEV_ERROR = "Entwickleraktion konnte nicht ausgeführt werden.";
const needBulk = (ctx) => (ctx.game.processing.bulk ? true : "Erst einen Vorratstrichter besitzen.");
const needFeeder = (ctx) => (ctx.game.processing.feeder ? true : "Erst einen Dosierer besitzen.");
const PHASE7 = ["shovel", "pickaxe", "shovel.blade", "shovel.handle", "pickaxe.tip", "pickaxe.head", "bucket", "pan", "classifier", "pan.riffles", "bucket.large",
  "wheelbarrow", "sluice", "bulkhopper", "feeder"];

function installBulk(g) {
  if (!g.processing.bulk) { const r = giveItem(g, "bulkhopper"); if (!r.ok) return r; }
  g.processing.devInstallSluice();
  g.processing.devInstallBulk();
  g._stationSig = null;
  return ok("Vorratstrichter steht.");
}

function installFeeder(g) {
  if (!g.processing.feeder) { const r = giveItem(g, "feeder"); if (!r.ok) return r; }
  installBulk(g);
  g.processing.devInstallFeeder();
  g._stationSig = null;
  return ok("Dosierer montiert.");
}

function fillBulk(g, fraction, kind) {
  const pr = g.processing, bk = pr.bulk;
  if (!bk) return fail("Erst einen Vorratstrichter besitzen.");
  const ml = Math.round(bk.capacityMl * fraction);
  if (!pr.devSetBulk(ml > 0 ? devBatch(kind, ml) : null)) return fail(DEV_ERROR);
  g._stationSig = null;
  return ok(ml ? `Vorratstrichter ${Math.round(fraction * 100)} % ${DEV_MATERIALS[kind].label}.` : "Vorratstrichter ist leer.");
}

function setMode(g, mode, text) {
  const fd = g.processing.feeder;
  if (!fd) return fail("Erst einen Dosierer besitzen.");
  if (!fd.installed) installFeeder(g);
  if (!g.processing.devFeederMode(mode)) return fail(DEV_ERROR);
  g._stationSig = null;
  return ok(text);
}

// ---------------------------------------------------------------- SCHNELLTEST
reg({
  id: "quick.phase7", category: "quick", label: "Phase 7 Automation", cheat: true,
  hint: "Alles bis Phase 7 aufgebaut, € 400 – Vorratstrichter halb voll, Dosierer auf AUTO, Wasser an; eine volle Schubkarre steht unten an der Rampe, du dahinter.",
  run: (ctx) => {
    const g = ctx.game, pr = g.processing;
    const r = setLoadout(g, { items: PHASE7, cashCents: 40000, equip: "shovel", hard: true });
    if (!r.ok) return r;
    installFeeder(g);
    fillBulk(g, 0.5, "paydirt");
    pr.devSetHopper(devBatch("paydirt", 15000));
    pr.sluice.setWater(true);
    pr.devFeederMode("auto");
    // the barrow at the ramp's foot, pointing up it (south)
    pr.devSetBarrow(devBatch("paydirt", pr.barrow.capacityMl));
    pr.devPlaceBarrow(AUTO_SPOTS.rampFoot.x, RAMP.foot + 0.2, Math.PI);
    const w = pr.barrow, f = w.fwd();
    g.teleport({ x: w.x - f.x * 2.15, z: w.z - f.z * 2.15, yaw: w.yaw, pitch: -0.3 });
    g._stationSig = null;
    return ok("Phase 7: Karre voll unten an der Rampe – [E] greifen, hochschieben, [E] in den Vorratstrichter kippen. Der Dosierer läuft auf AUTO.");
  },
});

// ---------------------------------------------------------------- MATERIAL: Vorratstrichter
reg({ id: "bulk.give", category: "material", group: "Vorratstrichter", label: "Vorratstrichter geben (aufgebaut)", cheat: true,
  available: (ctx) => (ctx.game.processing.bulk && ctx.game.processing.bulk.installed ? "Steht schon." : true), run: (ctx) => installBulk(ctx.game) });
for (const [pct, label] of [[0, "Vorratstrichter leer"], [25, "Vorratstrichter 25 %"], [50, "Vorratstrichter 50 %"], [100, "Vorratstrichter voll"]]) {
  reg({ id: `bulk.fill${pct}`, category: "material", group: "Vorratstrichter", label, cheat: true, available: needBulk, run: (ctx) => fillBulk(ctx.game, pct / 100, ctx.state.matKind) });
}
reg({ id: "bulk.paydirt", category: "material", group: "Vorratstrichter", label: "Vorratstrichter: Pay Dirt", cheat: true, available: needBulk,
  hint: "Der Vorratstrichter voll goldhaltigem Testmaterial (Entwickler-Batch).", run: (ctx) => fillBulk(ctx.game, 1, "paydirt") });

// ---------------------------------------------------------------- MATERIAL: Dosierer
reg({ id: "feeder.give", category: "material", group: "Dosierer", label: "Dosierer geben (montiert)", cheat: true,
  available: (ctx) => (ctx.game.processing.feeder && ctx.game.processing.feeder.installed ? "Ist schon montiert." : true), run: (ctx) => installFeeder(ctx.game) });
reg({ id: "feeder.start", category: "material", group: "Dosierer", label: "Dosierer START", cheat: true, available: needFeeder, run: (ctx) => setMode(ctx.game, "on", "Dosierer läuft (AN).") });
reg({ id: "feeder.stop", category: "material", group: "Dosierer", label: "Dosierer STOP", cheat: true, available: needFeeder, run: (ctx) => setMode(ctx.game, "stop", "Dosierer ist aus.") });
reg({ id: "feeder.auto", category: "material", group: "Dosierer", label: "Dosierer AUTO", cheat: true, available: needFeeder, run: (ctx) => setMode(ctx.game, "auto", "Dosierer auf AUTO – läuft, solange das Wasser an ist.") });
reg({ id: "auto.downstreamFull", category: "material", group: "Dosierer", label: "Downstream voll simulieren", cheat: true,
  hint: "Der Trichter der Rinne voll Testmaterial, das Wasser aus: der Dosierer staut zurück und wartet.",
  available: (ctx) => (ctx.game.processing.sluice ? true : "Erst eine Waschrinne besitzen."),
  run: (ctx) => {
    const pr = ctx.game.processing, sl = pr.sluice;
    if (!sl.installed) pr.devInstallSluice();
    if (!pr.devSetHopper(devBatch(ctx.state.matKind, sl.capacityMl))) return fail(DEV_ERROR);
    sl.setWater(false);
    ctx.game._stationSig = null;
    return ok("Trichter der Rinne voll, Wasser aus – der Dosierer wartet.");
  } });
reg({ id: "auto.cleanReady", category: "material", group: "Dosierer", label: "Cleanout bereit machen", cheat: true,
  available: (ctx) => (ctx.game.processing.sluice ? true : "Erst eine Waschrinne besitzen."),
  hint: "Riffel voll beladen (Testkonzentrat mit Gold und zwei Nuggets), Wasser aus – an der Rinne [E]: reinigen.",
  run: (ctx) => {
    const pr = ctx.game.processing, sl = pr.sluice, h = devBatch("paydirt", 900);
    if (!sl.installed) pr.devInstallSluice();
    h.fineUg = 260000;
    h.finds = [{ cls: FIND.FLAKE, ug: 1500, key: "dev7:riffle:0" }, { cls: FIND.TINY, ug: 4200, key: "dev7:riffle:1" }, { cls: FIND.NUGGET, ug: 14000, key: "dev7:riffle:2" }, { cls: FIND.NUGGET, ug: 9000, key: "dev7:riffle:3" }];
    if (!pr.devRiffles(h, SLUICE_TUNING.riffleL * 1000)) return fail(DEV_ERROR);
    sl.setWater(false);
    ctx.game._stationSig = null;
    return ok("Riffelmatte voll – an der Rinne reinigen.");
  } });
reg({ id: "auto.debug", category: "material", group: "Dosierer", kind: "info", label: "Automation Debug",
  view: (ctx) => {
    const pr = ctx.game.processing, bk = pr.bulk, fd = pr.feeder, sl = pr.sluice;
    const l = (ml) => `${(ml / 1000).toFixed(1).replace(".", ",")} l`;
    if (!bk) return [["Vorratstrichter", "nicht vorhanden"]];
    const rows = [
      ["Vorratstrichter", `${bk.state}${bk.build >= 0 ? " (Aufbau)" : ""} · ${l(bk.volumeMl)} / ${l(bk.capacityMl)} · ${bk.buffer.layers.length} Schicht(en) · ${bk.goldUg().toLocaleString("de-DE")} µg`],
      ["Schieber", bk.feeder ? "vom Dosierer gesteuert" : `${bk.gateOpen ? "offen" : "zu"} · ${bk.gate.state}`],
    ];
    if (fd) {
      const st = fd.status();
      rows.push(["Dosierer", `${fd.state} · ${fd.mode.toUpperCase()} · ${st.text}`]);
      rows.push(["Rüttelrinne", `${l(fd.tray.volumeMl)} · ein ${fd.inLink.state} · aus ${fd.outLink.state} · gemessen ${fd.outLink.rateNow.toFixed(1).replace(".", ",")} l/min`]);
    }
    if (sl) rows.push(["Waschrinne", `${l(sl.hopper.batch.volumeMl)} / ${l(sl.capacityMl)} · Wasser ${sl.running ? "an" : "aus"} · ${sl.rateLpm} l/min · Riffel ${Math.round(sl.riffleLoad * 100)} %`]);
    rows.push(["Gesamt", `${l(bk.stats.inMl)} eingefüllt · ${fd ? l(fd.outLink.moved) : l(bk.stats.outMl)} dosiert`]);
    return rows;
  } });

// ---------------------------------------------------------------- WELT
reg({ id: "world.tp.automation", category: "world", group: "Teleport", label: "Automation (Kontrollpfosten)", cheat: true,
  run: (ctx) => {
    const s = AUTO_SPOTS.control;
    const r = ctx.game.teleport({ x: s.x, z: s.z, yaw: s.yaw, pitch: -0.15 });
    return r && r.ok ? ok("Teleport: Kontrollpfosten der Automation.") : fail(DEV_ERROR);
  } });
