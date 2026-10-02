// GoldRush - developer commands of phase 1-5 (QA tools). Registered into the
// registry (goldrush-devregistry.js); the panel draws whatever is there. A
// later phase adds its own pack next to this one (see DEV_PACKS in
// goldrush-devtools.js) - nothing here needs to change for that.
//
// ctx (from the panel): { game, shell, saves, tools, actions, state }
//   tools    the panel (snapshot / restore / save helpers, confirm)
//   actions  goldrush-devactions.js
//   state    panel state that is not part of the mine (selected material, toggles)

import { registerDevCommand as reg } from "./goldrush-devregistry.js";
import { DEV_MATERIALS, POUCH_TESTS, TELEPORTS } from "./goldrush-devactions.js";
import { formatEuro } from "./goldrush-economy.js";

const ok = (text) => ({ ok: true, text });
const needBucket = (ctx) => (ctx.game.processing.bucket ? true : "Erst einen Eimer besitzen (Ausrüstung).");
const needPan = (ctx) => (ctx.game.processing.owned.has("pan") ? true : "Erst eine Goldpfanne besitzen (Ausrüstung).");
const done = (r, text) => (r.ok ? ok(text) : r);

// the phase snapshots (fixed on purpose: "phase 4 complete" stays what it was)
const PHASE4 = ["shovel", "pickaxe", "shovel.blade", "shovel.handle", "pickaxe.tip", "pickaxe.head"];
const PHASE5 = [...PHASE4, "bucket", "pan", "classifier", "pan.riffles", "bucket.large"];

// ---------------------------------------------------------------- 1 SCHNELLTEST

reg({
  id: "quick.fresh", category: "quick", label: "Frische Mine", hint: "Wie ein neues Spiel: neuer Berg, € 0, nur die Hand, leerer Goldbeutel.",
  confirm: { title: "Frische Mine anlegen?", text: "Der aktuelle Teststand wird gelöscht und durch eine neue Mine ersetzt. Auch die Entwicklersicherung dieser Mine wird verworfen.", ok: "Frische Mine", danger: true },
  run: (ctx) => { ctx.shell.devFreshMine(); return { ok: true, replaced: true }; },
});
reg({
  id: "quick.early", category: "quick", label: "Early Game", cheat: true, hint: "Schaufel in der Hand, € 5, sonst nichts.",
  run: (ctx) => done(ctx.actions.setLoadout(ctx.game, { items: ["shovel"], cashCents: 500, equip: "shovel" }), "Early Game: Schaufel, € 5."),
});
reg({
  id: "quick.phase4", category: "quick", label: "Phase 4 komplett", cheat: true, hint: "Schaufel, Spitzhacke, alle vier Werkzeug-Upgrades, € 20.",
  run: (ctx) => done(ctx.actions.setLoadout(ctx.game, { items: PHASE4, cashCents: 2000, equip: "shovel", hard: true }), "Phase 4 komplett."),
});
reg({
  id: "quick.phase5", category: "quick", label: "Phase 5 Processing", cheat: true,
  hint: "Alle Werkzeuge, Eimer, Goldpfanne, Sieb, beide Upgrades, € 20 – der Eimer steht voll Testmaterial am Waschplatz.",
  run: (ctx) => {
    const g = ctx.game, A = ctx.actions;
    const r = A.setLoadout(g, { items: PHASE5, cashCents: 2000, equip: "shovel", hard: true });
    if (!r.ok) return r;
    A.bucketToWash(g);
    return done(A.fillBucket(g, 1, "paydirt"), "Phase 5: alles da, der Eimer steht voll am Waschplatz.");
  },
});
reg({
  id: "quick.all", category: "quick", label: "Alle aktuellen Items freischalten", cheat: true, hint: "Alles, was der Shop gerade kennt – auch Inhalte späterer Phasen.",
  run: (ctx) => { const r = ctx.actions.giveAll(ctx.game); return ok(`${r.granted} Item(s) freigeschaltet${r.skipped.length ? ` · nicht unterstützt: ${r.skipped.join(", ")}` : ""}.`); },
});

// ---------------------------------------------------------------- 2 WIRTSCHAFT

for (const [cents, label] of [[100, "+ € 1"], [1000, "+ € 10"], [10000, "+ € 100"], [100000, "+ € 1.000"]]) {
  reg({ id: `economy.add${cents}`, category: "economy", group: "Kontostand", label, cheat: true, run: (ctx) => done(ctx.actions.addCash(ctx.game, cents), `Kontostand: ${formatEuro(ctx.game.economy.cashCents)}`) });
}
reg({
  id: "economy.set", category: "economy", group: "Kontostand", kind: "input", label: "Cash setzen", cheat: true,
  input: { label: "Betrag in €", placeholder: "z. B. 250 oder 12,50", inputmode: "decimal", button: "Setzen" },
  run: (ctx, value) => {
    const cents = ctx.actions.parseEuro(value);
    if (cents == null) return { ok: false, error: "Ungültiger Betrag – erlaubt sind € 0 bis € 1.000.000 (höchstens 2 Nachkommastellen)." };
    return done(ctx.actions.setCash(ctx.game, cents), `Kontostand: ${formatEuro(cents)}`);
  },
});
reg({ id: "economy.zero", category: "economy", group: "Kontostand", label: "Cash auf € 0", cheat: true, run: (ctx) => done(ctx.actions.setCash(ctx.game, 0), "Kontostand: € 0,00") });
for (const [kind, t] of Object.entries(POUCH_TESTS)) {
  reg({ id: `pouch.${kind}`, category: "economy", group: "Goldbeutel", label: `+ ${t.label}`, cheat: true, run: (ctx) => done(ctx.actions.addPouch(ctx.game, kind), `${t.label} im Goldbeutel.`) });
}
reg({ id: "pouch.empty", category: "economy", group: "Goldbeutel", label: "Goldbeutel leeren", cheat: true, run: (ctx) => done(ctx.actions.emptyPouch(ctx.game), "Goldbeutel ist leer.") });

// ---------------------------------------------------------------- 3 AUSRÜSTUNG

const STATUS = { locked: "LOCKED", available: "AVAILABLE", owned: "OWNED" };
reg({
  id: "equipment.items", category: "equipment", kind: "items", label: "Items",
  rows: (ctx) => ctx.actions.itemRows(ctx.game).map((it) => ({
    id: it.id, label: it.label, status: STATUS[it.status] || it.status, sub: `${it.id} · ${it.kind} · ${formatEuro(it.price)}`,
    actions: !it.supported ? [] : [
      ...(it.status === "locked" ? [{ id: "unlock", label: "Freischalten", run: (c) => done(c.actions.unlockItem(c.game, it.id), `${it.label}: kaufbar.`) }] : []),
      ...(it.status !== "owned" ? [{ id: "give", label: "Besitz geben", run: (c) => done(c.actions.giveItem(c.game, it.id), `${it.label}: in deinem Besitz.`) }] : []),
      ...(it.status === "owned" ? [{ id: "remove", label: "Entfernen", run: (c) => done(c.actions.removeItem(c.game, it.id), `${it.label} entfernt.`) }] : []),
    ],
  })),
});
reg({
  id: "equipment.all", category: "equipment", label: "Alle aktuellen Items geben", cheat: true,
  run: (ctx) => { const r = ctx.actions.giveAll(ctx.game); return ok(`${r.granted} Item(s) gegeben.`); },
});
reg({
  id: "equipment.reset", category: "equipment", label: "Alle Ausrüstung zurücksetzen", cheat: true, hint: "Zurück auf die Hand. Was in Eimer, Pfanne und Sieb liegt, wird als Abraum gebucht.",
  confirm: { title: "Alle Ausrüstung zurücksetzen?", text: "Werkzeuge, Upgrades, Eimer, Goldpfanne und Sieb werden entfernt – nur die Hand bleibt.", ok: "Zurücksetzen", danger: true },
  run: (ctx) => done(ctx.actions.resetItems(ctx.game), "Nur noch die Hand."),
});

// ---------------------------------------------------------------- 4 MATERIAL / PROCESSING

reg({
  id: "material.kind", category: "material", group: "Eimer", kind: "choice", label: "Testmaterial",
  options: () => Object.entries(DEV_MATERIALS).map(([id, m]) => ({ id, label: m.label })),
  value: (ctx) => ctx.state.matKind,
  set: (ctx, id) => { if (DEV_MATERIALS[id]) ctx.state.matKind = id; },
});
for (const [pct, label] of [[0, "Eimer leer"], [25, "Eimer 25 %"], [50, "Eimer 50 %"], [100, "Eimer voll"]]) {
  reg({
    id: `material.bucket${pct}`, category: "material", group: "Eimer", label, cheat: true, available: needBucket,
    run: (ctx) => done(ctx.actions.fillBucket(ctx.game, pct / 100, ctx.state.matKind), pct ? `Eimer ${pct} % ${DEV_MATERIALS[ctx.state.matKind].label}.` : "Eimer ist leer."),
  });
}
reg({
  id: "material.paydirt", category: "material", group: "Eimer", label: "Goldhaltiges Testmaterial", cheat: true, available: needBucket,
  hint: "Ein voller Eimer reiches Mischmaterial (Entwickler-Batch, nicht aus dem Berg) – sichtbar viel Gold für Pfanne und Sieb.",
  run: (ctx) => done(ctx.actions.fillBucket(ctx.game, 1, "paydirt"), "Eimer voll goldhaltigem Testmaterial."),
});
reg({ id: "material.bucketHere", category: "material", group: "Eimer", label: "Eimer herholen", cheat: true, available: needBucket, run: (ctx) => done(ctx.actions.bucketHere(ctx.game), "Der Eimer steht neben dir.") });
reg({ id: "material.bucketWash", category: "material", group: "Eimer", label: "Eimer zum Waschplatz", cheat: true, available: needBucket, run: (ctx) => done(ctx.actions.bucketToWash(ctx.game), "Der Eimer steht am Waschplatz.") });
reg({
  id: "material.concentrate", category: "material", group: "Goldpfanne", label: "Konzentrat-Testladung", cheat: true, available: needPan,
  hint: "2,5 l reiches Konzentrat direkt in die Pfanne – am Trog sofort schwenken und das Gold sehen.",
  run: (ctx) => done(ctx.actions.concentrateLoad(ctx.game), "Konzentrat liegt in der Pfanne – am Waschplatz schwenken."),
});
reg({ id: "material.tailings", category: "material", group: "Abraum", label: "Tailings leeren", cheat: true, run: (ctx) => done(ctx.actions.clearTailings(ctx.game), "Tailings geleert.") });

// ---------------------------------------------------------------- 5 WELT

for (const t of TELEPORTS) {
  reg({ id: `world.tp.${t.id}`, category: "world", group: "Teleport", label: t.label, cheat: true, run: (ctx) => done(ctx.actions.teleport(ctx.game, t.id), `Teleport: ${t.label}.`) });
}
reg({ id: "debug.resource", category: "world", group: "Debug-Ansichten", kind: "toggle", label: "Resource Debug", hint: "Goldgehalt der Oberfläche als Farbbänder (Heatmap), Material und Gold unter dem Fadenkreuz.", value: (ctx) => !!ctx.state.toggles.resource, set: (ctx, on) => ctx.tools.setToggle("resource", on) });
reg({ id: "debug.terrain", category: "world", group: "Debug-Ansichten", kind: "toggle", label: "Terrain Debug", hint: "Höhe, Neigung, Material, Chunk unter dem Fadenkreuz.", value: (ctx) => !!ctx.state.toggles.terrain, set: (ctx, on) => ctx.tools.setToggle("terrain", on) });

// ---------------------------------------------------------------- 6 SAVE / QA

reg({ id: "save.now", category: "save", label: "Jetzt speichern", run: (ctx) => { const b = ctx.game.save("dev"); return b ? ok(`Gespeichert (${(b / 1024).toFixed(1).replace(".", ",")} KB).`) : { ok: false, error: "Speichern hat nicht geklappt." }; } });
reg({ id: "save.reload", category: "save", label: "Save neu laden", hint: "Speichert und lädt die Mine frisch aus dem Speicher – prüft, was ein Neustart sieht.", run: (ctx) => { ctx.shell.devReloadMine(null, "Spielstand neu geladen."); return { ok: true, replaced: true }; } });
reg({ id: "save.snapshot", category: "save", label: "Dev-Snapshot erstellen", hint: "Sicherung aus dem aktuellen Stand (ersetzt die vorhandene).", run: (ctx) => ctx.tools.snapshotNow() });
reg({ id: "save.restore", category: "save", label: "Dev-Snapshot wiederherstellen", available: (ctx) => (ctx.tools.snapshot() ? true : "Keine Sicherung dieser Mine vorhanden."), run: (ctx) => ctx.tools.restoreSnapshot() });
reg({ id: "save.info", category: "save", kind: "info", label: "Save-Info", view: (ctx) => ctx.tools.saveInfo() });
reg({ id: "save.export", category: "save", group: "Export / Import", label: "Save exportieren", hint: "Lädt den Spielstand als JSON-Datei herunter.", run: (ctx) => ctx.tools.exportSave() });
reg({ id: "save.import", category: "save", group: "Export / Import", kind: "file", label: "Save importieren", cheat: true, hint: "Ersetzt deine aktuelle Mine durch die Datei (wird geprüft).", run: (ctx, text) => ctx.tools.importSave(text) });

// ---------------------------------------------------------------- 7 DIAGNOSE

reg({ id: "debug.perf", category: "diag", group: "Anzeigen", kind: "toggle", label: "Performance HUD", hint: "FPS, Frame-Zeit, Draw Calls, Dreiecke, Geometrien, Texturen, Objekte.", value: (ctx) => !!ctx.state.toggles.perf, set: (ctx, on) => ctx.tools.setToggle("perf", on) });
reg({ id: "debug.material", category: "diag", group: "Anzeigen", kind: "toggle", label: "Material Debug", hint: "Volumen, Masse, Feingold, Stufe und Batch-ID von Eimer, Pfanne, Sieb und Wanne in deiner Nähe.", value: (ctx) => !!ctx.state.toggles.material, set: (ctx, on) => ctx.tools.setToggle("material", on) });
reg({ id: "debug.interaction", category: "diag", group: "Anzeigen", kind: "toggle", label: "Interaction Debug", hint: "Was [E] gerade tun würde, Ziel, Reichweite, Position.", value: (ctx) => !!ctx.state.toggles.interaction, set: (ctx, on) => ctx.tools.setToggle("interaction", on) });
reg({ id: "diag.info", category: "diag", kind: "info", label: "Technik", view: (ctx) => ctx.tools.techInfo() });
