// GoldRush - developer commands of phase 9 (the mechanised claim): one preset with
// the whole plant built and running, then the places to look at - a prospecting
// line across a paleochannel, the mine intake, the processing plant, the
// excavator at a face (you in the cab), the richest channel ground, ordinary
// mountain ground, the contract board - and a few fills (intake, bucket,
// oversize). A pack of its own (goldrush-devregistry.js); every command goes
// through the game's own systems (dev material is booked in like a dig).

import { registerDevCommand as reg } from "./goldrush-devregistry.js";
import { DEV_ERROR, devBatch, equipNow, giveItem, setLoadout } from "./goldrush-devactions.js";
import { INTAKE, INTAKE_SPOT, TROMMEL, SPOIL } from "./goldrush-plant.js";
import { BULK_AT } from "./goldrush-automation.js";
import { BOARD } from "./goldrush-stations.js";
import { EXC_HOME } from "./goldrush-excavator.js";
import { MAT } from "./goldrush-materials.js";
import { BarrowCourse } from "./goldrush-barrowcourse.js";
import { measureHandling } from "./goldrush-wheelbarrow-controller.js";

const ok = (text) => ({ ok: true, text });
const fail = (error) => ({ ok: false, error });
const GROUP = "Mechanisierter Claim (9)";
export const PHASE9_ITEMS = ["shovel", "pickaxe", "shovel.blade", "bucket", "pan", "classifier", "wheelbarrow", "sluice", "bulkhopper", "feeder", "prospectkit", "conveyor", "trommel", "sluice.highflow", "excavator", "excavator.breaker"];

const own = (g, id) => (g.processing.owned.has(id) || g.tools.owned.has(id) || g.tools.upgrades.has(id) ? { ok: true } : giveItem(g, id));
const outOfCab = (g) => { if (g.cab) g.exitCab(); };
const look = (g, x, z, tx, ty, tz) => {
  outOfCab(g);
  const eye = g.world.groundAt(x, z) + 1.62, d = Math.hypot(tx - x, tz - z) || 1;
  const r = g.teleport({ x, z, yaw: Math.atan2(-(tx - x), -(tz - z)), pitch: Math.atan2(ty - eye, d) });
  g._stationSig = null;
  return r && r.ok;
};

// the plant stands and runs: sluice, bulk hopper, feeder (AUTO), conveyor + trommel (AUTO), water on
function buildPlant(g) {
  const pr = g.processing;
  for (const id of ["sluice", "bulkhopper", "feeder", "conveyor", "trommel"]) { const r = own(g, id); if (!r.ok) return r; }
  pr.devInstallSluice(); pr.devInstallBulk(); pr.devInstallFeeder(); pr.devFeederMode("auto");
  pr.devInstallConveyor(); pr.devInstallTrommel(); pr.devConveyorMode("auto");
  pr.sluice.setWater(true);
  g._stationSig = null;
  return { ok: true };
}

// an open, fairly flat spot for the excavator facing the mountain near the intake (or wherever it fits)
function excavatorSpot(g) {
  const t = g.terrain, ex = g.processing.excavator, cols = g.world.colliders;
  let best = null;
  for (let x = -14.6; x <= -10.0; x += 0.2) for (let z = -14.0; z <= -4.5; z += 0.2) {
    const h = [[0.8, 0.62], [0.8, -0.62], [-0.8, 0.62], [-0.8, -0.62]].map(([a, b]) => g.world.groundAt(x + a, z + b));
    const s = Math.max(...h) - Math.min(...h), di = Math.hypot(x - INTAKE.x, z - INTAKE.z);
    if (di < 2.7 || di > 3.8 || s > 0.3) continue;
    // free of props, posts, lamps, machines (its own footprint ~1.1 m)
    let free = true;
    for (const c of cols) {
      if (ex && c === ex.collider) continue;
      const d = c.type === "circle" ? Math.hypot(x - c.x, z - c.z) - c.r : Math.max(Math.abs(x - c.x) - (c.hw || 0), Math.abs(z - c.z) - (c.hd || 0));
      if (d < 1.15) { free = false; break; }
    }
    if (!free) continue;
    // the intake to its side (~90 deg from heading 0 = east): how an operator loading a hopper stands
    const bear = Math.abs(Math.atan2(-(INTAKE.z - z), INTAKE.x - x)), score = s + Math.abs(bear - Math.PI / 2) * 0.3;
    if (!best || score < best.score) best = { x, z, s, score };
  }
  return best;
}

// intact rock the excavator can reach: an exposed stone column at the mountain's foot, the machine 2.9 m from it
// on the flat claim (west / east / north / south of it, facing it), the one nearest the plant
const DIRS = [[-2.9, 0, 0], [2.9, 0, Math.PI], [0, -2.9, -Math.PI / 2], [0, 2.9, Math.PI / 2]];
function rockSpot(g) {
  const t = g.terrain, cols = g.world.colliders, ex = g.processing.excavator;
  let best = null;
  for (let k = 0; k < t.vps * t.vps; k++) {
    const h = t.height[k];
    if (!(h <= t.stoneTop[k] + 1e-4 && h >= t.stoneBot[k])) continue;
    const i = k % t.vps, j = (k - i) / t.vps, x = t.x0 + i * t.cell, z = t.z0 + j * t.cell;
    if (!t.inDigArea(x, z)) continue;
    for (const [dx, dz, heading] of DIRS) {
      const sx = x + dx, sz = z + dz, g0 = g.world.groundAt(sx, sz);
      if (!t.inDigArea(sx, sz) || g0 > 0.25 || h - g0 < 0.05 || h - g0 > 1.4) continue;
      const hs = [[0.8, 0.62], [0.8, -0.62], [-0.8, 0.62], [-0.8, -0.62]].map(([a, b]) => g.world.groundAt(sx + a, sz + b));
      if (Math.max(...hs) - Math.min(...hs) > 0.3) continue;
      let free = true;
      for (const c of cols) {
        if (ex && c === ex.collider) continue;
        const d = c.type === "circle" ? Math.hypot(sx - c.x, sz - c.z) - c.r : Math.max(Math.abs(sx - c.x) - (c.hw || 0), Math.abs(sz - c.z) - (c.hd || 0));
        if (d < 1.15) { free = false; break; }
      }
      if (!free || (g.world.decks.length && g.world.deckAt(sx, sz) > -Infinity)) continue;
      const score = Math.hypot(sx - INTAKE.x, sz - INTAKE.z);
      if (!best || score < best.score) best = { x, z, h, sx, sz, heading, score };
    }
  }
  return best;
}

// the excavator there, you in its cab looking at the face
function toExcavator(ctx, { breaker = false } = {}) {
  const g = ctx.game, pr = g.processing;
  const r = own(g, "excavator");
  if (!r.ok) return r;
  if (breaker) { const b = own(g, "excavator.breaker"); if (!b.ok) return b; }
  const ex = pr.excavator;
  if (!ex) return fail(DEV_ERROR);
  outOfCab(g);
  const rock = breaker ? rockSpot(g) : null;
  const sp = rock ? { x: rock.sx, z: rock.sz, heading: rock.heading } : excavatorSpot(g) || { x: EXC_HOME.x + 3.5, z: EXC_HOME.z };
  ex.place(sp.x, sp.z, sp.heading || 0);
  if (ex.breaker !== breaker && !ex.task) { ex.attachment = breaker ? "breaker" : "bucket"; ex.rig.setAttachment(ex.attachment); ex.standSync(); }
  if (!g.enterCab()) return fail("Der Bagger lässt sich gerade nicht besteigen.");
  g.player.yaw = (sp.heading || 0) - Math.PI / 2; g.player.pitch = rock ? -0.42 : -0.3;
  return ok(breaker ? "Im Bagger mit Hydraulikhammer: auf Fels zielen, Klick – danach den Löffel anbauen (am Stand: T) und das Geröll aufnehmen." : "Im Bagger: W / S fahren, A / D drehen, Linksklick graben, Rechtsklick / Q in den Aufgabetrichter kippen, E aussteigen.");
}

// the richest paleochannel ground that comes close to the surface (or the ground above the best stretch)
function channelSpot(g, rich = true) {
  const t = g.terrain, f = t.field;
  if (!f.channelAt) return null;
  let best = null;
  for (let j = 14; j < t.vps - 14; j += 2) for (let i = 14; i < t.vps - 14; i += 2) {
    const k = j * t.vps + i;
    if (f.chIdx[k] < 0 || f.chD[k] > 0.6) continue;
    const x = t.x0 + i * t.cell, z = t.z0 + j * t.cell;
    if (!t.inDigArea(x, z) || (f.campFillAt && f.campFillAt(x, z) > 0.2)) continue;
    const h = t.height[k];
    for (const d of [0.06, 0.15, 0.35, 0.6]) {
      const c = f.channelAt(x, h - d, z, k);
      if (!c || c.w < 0.5) continue;
      // the channel's gravel right at the surface first (a sample there shows it), deeper ones only if none is
      const score = (rich ? c.rich : 1 - Math.abs(c.rich - 0.5)) * c.w - (d > 0.15 ? 1 + d : d) * 0.8;
      if (!best || score > best.score) best = { x, z, h, d, score, rich: c.rich, w: c.w };
      break;
    }
  }
  return best;
}

// ordinary mountain ground: high on the pile, no channel, no streak, loose dirt at the face
function normalMountain(g) {
  const t = g.terrain, f = t.field, mc = t.moundCenter;
  for (let r = 3; r <= 12; r += 0.5) for (let a = 0.3; a < Math.PI * 2; a += 0.15) {
    const x = mc.x + Math.cos(a) * r, z = mc.z + Math.sin(a) * r;
    if (!t.inDigArea(x, z)) continue;
    const i = Math.round((x - t.x0) / t.cell), j = Math.round((z - t.z0) / t.cell), k = j * t.vps + i, h = t.height[k];
    if (t.base[k] < 1.2 || (f.chIdx && f.chIdx[k] >= 0) || f.streakAt(x, h - 0.2, z) > 0.05 || f.materialAt(x, h - 0.02, z) !== MAT.DIRT) continue;
    const px = x + Math.cos(a) * 1.6, pz = z + Math.sin(a) * 1.6;
    return { x, z, h, px, pz };
  }
  return null;
}

// ---------------------------------------------------------------- SCHNELLTEST
reg({
  id: "quick.phase9", category: "quick", label: "PHASE 9 MECHANIZED CLAIM", cheat: true,
  hint: "Alle Werkzeuge und Maschinen bis Phase 9 (Probenset, Förderband, Trommel, Hochleistungsrinne, Bagger, Hammer), € 200; die Anlage steht und läuft auf AUTO, Wasser an; du stehst am Aufgabetrichter. Weiter: Welt → Mechanisierter Claim (9).",
  run: (ctx) => {
    const g = ctx.game;
    outOfCab(g);
    const r = setLoadout(g, { items: PHASE9_ITEMS, cashCents: 20000, equip: "shovel", hard: true });
    if (!r.ok) return r;
    const b = buildPlant(g);
    if (!b.ok) return b;
    const sp = excavatorSpot(g);
    if (sp && g.processing.excavator) g.processing.excavator.place(sp.x, sp.z, 0);
    return look(g, INTAKE.x + 2.4, INTAKE.z + 2.6, INTAKE.x, 1.0, INTAKE.z) ? ok("Phase 9: die Anlage läuft (AUTO, Wasser an). Grab in den Aufgabetrichter oder steig in den Bagger.") : fail(DEV_ERROR);
  },
});

// ---------------------------------------------------------------- WELT: the places
reg({ id: "p9.prospect", category: "world", group: GROUP, label: "PROSPECTING TEST", cheat: true,
  hint: "Probenset, eine Linie aus drei Fähnchen quer über eine alte Rinne; [R] Probe nehmen, am Waschtrog auswaschen, [N] Notizbuch.",
  run: (ctx) => {
    const g = ctx.game, r = own(g, "prospectkit");
    if (!r.ok) return r;
    const sp = channelSpot(g, false);
    if (!sp) return fail("Keine Rinne nahe der Oberfläche gefunden.");
    const pg = g.processing.prospect, t = g.terrain, f = t.field, k = Math.round((sp.z - t.z0) / t.cell) * t.vps + Math.round((sp.x - t.x0) / t.cell);
    // across the channel: perpendicular to its run right here (two points on its curve round this spot)
    const ch = f.channels[f.chIdx[k]], u = f.chT[k], a = {}, b = {};
    f._channelPoint(ch, Math.max(0, u - 0.02), a); f._channelPoint(ch, Math.min(1, u + 0.02), b);
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1, px = -dz / L, pz = dx / L;
    for (const fl of [...pg.flags]) pg.toggleFlag(fl.x, fl.z);
    for (const s of [-2.2, 0, 2.2]) pg.toggleFlag(sp.x + px * s, sp.z + pz * s);
    equipNow(g, "shovel");
    return look(g, sp.x + px * -2.2 - pz * 1.6, sp.z + pz * -2.2 + px * 1.6, sp.x + px * -2.2, sp.h - 0.2, sp.z + pz * -2.2) ? ok("Drei Fähnchen quer über eine Rinne: an jedem [R] eine Probe, dann am Waschtrog auswaschen und im Notizbuch [N] vergleichen.") : fail(DEV_ERROR);
  } });
reg({ id: "p9.intake", category: "world", group: GROUP, label: "MINE INTAKE", cheat: true,
  run: (ctx) => { const b = buildPlant(ctx.game); if (!b.ok) return b; return look(ctx.game, INTAKE_SPOT.x + 1.6, INTAKE_SPOT.z - 1.2, INTAKE.x, 0.9, INTAKE.z) ? ok("Aufgabetrichter mit Förderband: hier hineingraben, Schubkarre / Bagger kippen. Am Pfosten: AUS / AUTO / AN.") : fail(DEV_ERROR); } });
reg({ id: "p9.plant", category: "world", group: GROUP, label: "PROCESSING PLANT", cheat: true,
  run: (ctx) => { const b = buildPlant(ctx.game); if (!b.ok) return b; return look(ctx.game, BULK_AT.x + 4.2, BULK_AT.z + 3.3, TROMMEL.feedX - 0.8, 2.4, TROMMEL.z) ? ok("Trommel über dem Vorratstrichter, Überkornhaufen am Zaun, Hochleistungsrinne darunter.") : fail(DEV_ERROR); } });
reg({ id: "p9.excavator", category: "world", group: GROUP, label: "EXCAVATOR", cheat: true, run: (ctx) => { const b = buildPlant(ctx.game); if (!b.ok) return b; return toExcavator(ctx); } });
reg({ id: "p9.breaker", category: "world", group: GROUP, label: "Bagger mit Hydraulikhammer", cheat: true, run: (ctx) => { const b = buildPlant(ctx.game); if (!b.ok) return b; return toExcavator(ctx, { breaker: true }); } });
reg({ id: "p9.rich", category: "world", group: GROUP, label: "RICH CHANNEL", cheat: true,
  hint: "Die reichste Stelle einer alten Rinne nahe der Oberfläche (Kies, Schwersand) – eine Probe hier zeigt den Unterschied.",
  run: (ctx) => {
    const g = ctx.game, sp = channelSpot(g, true);
    if (!sp) return fail("Keine reiche Rinne nahe der Oberfläche gefunden.");
    own(g, "shovel"); equipNow(g, "shovel");
    return look(g, sp.x + 1.4, sp.z + 0.6, sp.x, sp.h - 0.1, sp.z) ? ok(`Reiche Rinne (${Math.round(sp.rich * 100)} % der Spanne), ${sp.d.toFixed(2).replace(".", ",")} m unter der Oberfläche.`) : fail(DEV_ERROR);
  } });
reg({ id: "p9.normal", category: "world", group: GROUP, label: "NORMAL MOUNTAIN", cheat: true,
  run: (ctx) => {
    const g = ctx.game, sp = normalMountain(g);
    if (!sp) return fail("Keine gewöhnliche Bergstelle gefunden.");
    own(g, "shovel"); equipNow(g, "shovel");
    return look(g, sp.px, sp.pz, sp.x, sp.h - 0.1, sp.z) ? ok("Gewöhnlicher Berg (oberer Teil ein wenig ärmer als der Claim).") : fail(DEV_ERROR);
  } });
reg({ id: "p9.board", category: "world", group: GROUP, label: "CONTRACT BOARD", cheat: true,
  run: (ctx) => (look(ctx.game, BOARD.x + 2.4, BOARD.z + 0.6, BOARD.x, 1.5, BOARD.z) ? ok("Der Bergauftrag: [E] liest ihn.") : fail(DEV_ERROR)) });
reg({ id: "p9.spoil", category: "world", group: GROUP, label: "Abraumhalde", cheat: true,
  run: (ctx) => { const r = own(ctx.game, "excavator"); if (!r.ok) return r; return look(ctx.game, SPOIL.x + 5.5, SPOIL.z + 2.5, SPOIL.x, 0.6, SPOIL.z) ? ok("Die Abraumhalde: hierher kippt der Bagger, was nicht gewaschen wird.") : fail(DEV_ERROR); } });

// ---------------------------------------------------------------- MATERIAL: fills (dev material, booked like a dig)
reg({ id: "p9.intakeFull", category: "material", group: GROUP, label: "Aufgabetrichter voll (240 l)", cheat: true,
  run: (ctx) => { const g = ctx.game, b = buildPlant(g); if (!b.ok) return b; return g.processing.devSetIntake(devBatch("paydirt", 240000)) ? ok("240 l Erde im Aufgabetrichter.") : fail(DEV_ERROR); } });
// the chain blocked: the bulk hopper full, the feeder stopped - the trommel waits, its feed box fills, the belt stands loaded
reg({ id: "p9.blocked", category: "material", group: GROUP, label: "Kette blockieren (Vorratstrichter voll)", cheat: true,
  run: (ctx) => {
    const g = ctx.game, b = buildPlant(g);
    if (!b.ok) return b;
    const pr = g.processing;
    pr.devFeederMode("stop");
    if (!pr.devSetBulk(devBatch("paydirt", pr.bulk.capacityMl)) || !pr.devSetIntake(devBatch("paydirt", 200000))) return fail(DEV_ERROR);
    return look(g, -13.2, -4.2, -18.8, 2.0, -6.2) ? ok("Vorratstrichter voll, Dosierer STOP: die Trommel wartet, in ~30 s steht das Band beladen (Lampen gelb). Dosierer AUTO löst es.") : fail(DEV_ERROR);
  } });
reg({ id: "p9.intakeEmpty", category: "material", group: GROUP, label: "Aufgabetrichter leer", cheat: true,
  run: (ctx) => (ctx.game.processing.conveyor && ctx.game.processing.devSetIntake(null) ? ok("Aufgabetrichter leer.") : fail("Erst das Förderband besitzen.")) });
reg({ id: "p9.oversize", category: "material", group: GROUP, label: "Überkornhaufen (1,5 m³)", cheat: true,
  run: (ctx) => { const g = ctx.game, b = buildPlant(g); if (!b.ok) return b; return g.processing.devSetOversize(devBatch("gravel", 1500000)) ? ok("1,5 m³ Überkorn am Zaun – mit Schubkarre oder Bagger abtragen.") : fail(DEV_ERROR); } });
reg({ id: "p9.bucketFull", category: "material", group: GROUP, label: "Baggerlöffel voll (40 l)", cheat: true,
  run: (ctx) => {
    const g = ctx.game, r = own(g, "excavator");
    if (!r.ok) return r;
    const ex = g.processing.excavator, batch = devBatch("paydirt", 40000);
    if (!ex || ex.task || !batch) return fail(DEV_ERROR);
    g.processing._devTail(ex.bucket.batch);
    batch.id = g.processing.nextBatch++;
    g.processing._devIn(batch);
    ex.bucket.batch = batch;
    ex._load();
    return ok("40 l im Löffel.");
  } });

// ---------------------------------------------------------------- INFO
reg({ id: "p9.status", category: "material", group: GROUP, kind: "info", label: "Anlage & Bergauftrag",
  view: (ctx) => {
    const g = ctx.game, pr = g.processing, cv = pr.conveyor, tr = pr.trommel, ex = pr.excavator, v = g.contract.view();
    const rows = [["Bergauftrag", `${v.text.pct} · ${v.text.removed} · ${v.text.t}`]];
    if (cv) rows.push(["Förderband", `${cv.mode.toUpperCase()} · ${cv.status().text} · Aufgabe ${Math.round(cv.volumeMl / 1000)} / 240 l · ${Math.round(cv.stats.outMl / 1000)} l gefördert`]);
    if (tr) rows.push(["Trommel", `${tr.status().text} · Unterkorn ${Math.round(tr.stats.underMl / 1000)} l · Überkorn ${Math.round(tr.stats.overMl / 1000)} l (Haufen ${(tr.overMl / 1e6).toFixed(2)} m³)`]);
    if (pr.sluice) rows.push(["Rinne", `${pr.sluice.rateLpm} l/min${pr.sluice.highflow ? " (Hochleistung)" : ""} · Riffel ${Math.round(pr.sluice.riffleLoad * 100)} %`]);
    if (ex) rows.push(["Bagger", `${ex.attachment === "breaker" ? "Hammer" : `Löffel ${Math.round(ex.volumeMl / 1000)} l`} · ${ex.stats.scoops} Löffel · ${Math.round(ex.stats.dugMl / 1000)} l gegraben · ${Math.round(ex.stats.spoilMl / 1000)} l auf der Halde`]);
    if (pr.spoil) rows.push(["Abraumhalde", `${(pr.spoil.ml / 1e6).toFixed(2)} m³`]);
    return rows;
  } });

// ---------------------------------------------------------------- SCHUBKARRE: the handling course (phase 9 handling pass)
// six stations on open ground (cones), the barrow empty / half / full of gravel at the start of each, the numbers
const COURSE = "Schubkarre – Handling-Kurs (9)";
const courseLoad = { k: 1 };                                   // of a full barrow (85 l of gravel, ~153 kg)
function course(g) {
  if (g._barrowCourse) return g._barrowCourse;
  const c = new BarrowCourse(g), r = c.build();
  if (!r.ok) { c.dispose(); return null; }
  g._barrowCourse = c;
  return c;
}
function toStation(ctx, id, text) {
  const g = ctx.game, pr = g.processing;
  for (const t of ["wheelbarrow", "shovel"]) { const r = own(g, t); if (!r.ok) return r; }
  outOfCab(g);
  if (pr.work) return fail("Erst die Arbeit am Waschplatz beenden.");
  const c = course(g);
  if (!c) return fail("Kein freier, ebener Platz für den Kurs gefunden.");
  const at = c.start(id);
  if (!at) return fail(id === "slope" ? "Keinen milden Hang (6–12 %) am Bergfuß gefunden." : DEV_ERROR);
  const w = pr.barrow;
  if (!w) return fail(DEV_ERROR);
  if (w.pushing) w.park();
  const ml = Math.round(courseLoad.k * 85000);
  if (!pr.devPlaceBarrow(at.x, at.z, at.yaw) || !pr.devSetBarrow(ml ? devBatch("gravel", ml) : null)) return fail(DEV_ERROR);
  pr._fills && pr._fills();
  const cc = w.gripsCenter({}), fx = -Math.sin(at.yaw), fz = -Math.cos(at.yaw);
  g.teleport({ x: cc.x - fx * 0.7, z: cc.z - fz * 0.7, yaw: at.yaw, pitch: -0.4 });
  g._stationSig = null;
  return ok(`${text} – Karre ${courseLoad.k === 0 ? "leer" : courseLoad.k === 1 ? "voll (85 l Kies)" : `${Math.round(courseLoad.k * 100)} %`}. [E] greifen · W / S · A / D oder der Blick lenkt.`);
}
reg({ id: "p9.course.build", category: "world", group: COURSE, label: "Kurs aufbauen (neu)", cheat: true,
  hint: "Hütchen auf freiem, ebenem Boden: Gerade, 90°-Kurve, S-Kurve, Unebenheiten (echte Abbauspuren), Parkbox; dazu ein milder Hang am Bergfuß.",
  run: (ctx) => {
    const g = ctx.game;
    if (g._barrowCourse) { g._barrowCourse.dispose(); g._barrowCourse = null; }
    const c = course(g);
    if (!c) return fail("Kein freier, ebener Platz für den Kurs gefunden.");
    return toStation(ctx, "straight", `Kurs steht (${c.cones} Hütchen, Stationen: ${Object.keys(c.stations).length})`);
  } });
for (const [k, label] of [[0, "leer"], [0.5, "50 %"], [1, "voll"]]) {
  reg({ id: `p9.course.load${Math.round(k * 100)}`, category: "world", group: COURSE, label: `Ladung ${label}`, cheat: true,
    run: (ctx) => {
      courseLoad.k = k;
      const pr = ctx.game.processing, w = pr.barrow;
      if (w && !w.pushing && !w.dump) { pr.devSetBarrow(k ? devBatch("gravel", Math.round(k * 85000)) : null); pr._fills && pr._fills(); }
      return ok(`Ladung für die Stationen: ${label}.`);
    } });
}
for (const [id, label, text] of [["straight", "1 Gerade (14 m)", "Gerade: anfahren, Endtempo, vor dem letzten Hütchenpaar bremsen"],
  ["corner", "2 90°-Kurve", "90°-Kurve: rechts herum, A / D oder einfach in die Kurve schauen"],
  ["s", "3 S-Kurve", "S-Kurve: durch die drei versetzten Tore"],
  ["slope", "4 Leichte Steigung", "Milder Hang am Bergfuß: bergauf zieht die Last"],
  ["bumps", "5 Unebenheiten", "Abbauspuren quer über der Spur: drüberrollen, nicht stehen bleiben"],
  ["park", "6 Rückwärts ausparken", "Parkbox: mit S rückwärts heraus, dann wenden"]]) {
  reg({ id: `p9.course.${id}`, category: "world", group: COURSE, label, cheat: true, run: (ctx) => toStation(ctx, id, text) });
}
const f1 = (v) => v.toFixed(1).replace(".", ","), f2 = (v) => v.toFixed(2).replace(".", ",");
reg({ id: "p9.course.metrics", category: "world", group: COURSE, kind: "info", label: "Handling-Messwerte",
  view: () => {
    const m = [0, 0.5, 1].map((l) => measureHandling(l)), row = (name, fn) => [name, m.map(fn).join(" / ")];
    return [["", "leer / 50 % / voll"],
      row("Endtempo eben", (x) => `${f1(x.vmax)} m/s`), row("0 → 90 % Tempo", (x) => `${f1(x.t90)} s`),
      row("Bremsweg aus dem Endtempo", (x) => `${f1(x.stop)} m`), row("90°-Kurve mit A / D", (x) => `${f1(x.turn90)} s`),
      row("90°-Kurve per Blick (45°)", (x) => `${f1(x.turn90look)} s`), row("Lenk-Latenz (halbe Drehrate)", (x) => `${f2(x.latency)} s`),
      row("Kleinster Radius bei 1 m/s", (x) => `${f1(x.radius)} m`), row("Tempo 8 % bergauf", (x) => `${f1(x.slope)} m/s`)];
  } });

