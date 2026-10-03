# GoldRush – interne Design- und Architekturnotizen

Interne Notizen für die Weiterentwicklung (Prompt 6–12). Nicht für Spieler.
Liegt bewusst außerhalb von `static/`, wird also nicht ausgeliefert.

## Module (Stand Phase 7)

| Bereich | Datei(en) |
|---|---|
| Einstieg, Startscreen, Menüs, Dialoge | `static/games/goldrush/goldrush.js` |
| Spiel, Loop, Spieler, Kauf | `goldrush-engine.js` |
| Spielstände (pro Konto), Migrationen, Dev-Snapshot | `goldrush-save.js` (`GoldRushSaveService`, Version 7) |
| Geld, Goldbeutel, Verkauf | `goldrush-economy.js` |
| Shop-Registry (Items, Preise, Voraussetzungen) | `goldrush-shop.js` (`SHOP_ITEMS`) |
| Gelände, Ressourcen, Abbau | `goldrush-terrain.js`, `goldrush-resources.js`, `goldrush-mining.js` |
| Material-Kette SOURCE → TRANSPORT → PROCESS → OUTPUT | `goldrush-material.js` (`MaterialBatch`, `pour`, `sluiceSplit`), `goldrush-processing.js` (`ProcessingSystem`) |
| Schubkarre (Phase 6) | `goldrush-wheelbarrow.js` (`Wheelbarrow`) |
| Waschrinne / Sluice (Phase 6) | `goldrush-sluice.js` (`Sluice`) |
| Modelle Schubkarre / Rinne | `goldrush-mechmodels.js` (`MechModels`) |
| Material-Transfer zwischen Maschinen (Phase 7) | `goldrush-transfer.js` (`MaterialBuffer`, `transfer`, `TransferLink`, `stepChain`) |
| Vorratstrichter, Dosierer (Phase 7) | `goldrush-automation.js` (`BulkHopper`, `Feeder`) |
| Modelle Vorratstrichter / Rampe / Dosierer | `goldrush-automodels.js` (`AutoModels`, nutzt die Materialien von `MechModels`) |
| Begehbare Aufbauten (Rampe, Plattform) | `goldrush-world.js` (`addDeck` / `deckAt`, in `groundAt` eingerechnet) |
| Grab-Gefühl: Partikel pro Material und Werkzeug | `goldrush-vfx.js` (`DigEffects`, `DIG_PROFILES`, `DIG_TOOLS`) |
| Entwickler-/QA-Werkzeuge | `goldrush-dev*.js` (siehe unten; Phase 6 / 7: `goldrush-devcommands6.js`, `goldrush-devcommands7.js`) |

## Materialfluss und Maschinen (Phase 6)

Alles, was Material hält, ist ein **Halter** `{ batch: MaterialBatch, capacityMl }`
(Eimer, Schubkarre, Trichter, Riffel, Konzentratschale, Wanne, Pfanne).
Umfüllen läuft immer über `pour(from, to, maxMl, id)` aus `goldrush-material.js`
– ganzzahlig in ml / g / µg, nichts entsteht, nichts verschwindet. Der Ledger
im `ProcessingSystem` muss jederzeit aufgehen:

- Gold: `inUg == Gold in allen Behältern + recoveredUg + tailUg`
- Masse: `inG == Masse in allen Behältern + tailG`

Eine neue Maschine (spätere Prompts) braucht:

1. einen Shop-Eintrag in `SHOP_ITEMS` (`kind: "equipment"`, Voraussetzungen),
2. ihre ID in `EQUIP` (`goldrush-processing.js`); `grant()` legt sie an,
   `serialize()` / der Konstruktor speichern und laden sie,
3. ihre Halter in `goldrush-processing.js` (`pourBetween`, `goldInContainers`,
   `massInContainers`), damit der Ledger sie mitzählt,
4. Interaktionen in `interaction()` / `act()` (Priorität dort beachten:
   schieben → tragen → Maschine → Pfanne → Sieb → aufnehmen),
5. Verarbeitung nur im Spiel-Loop (`update(dt)`) oder im Sim-Hook
   `tickSim(sec)` – **kein Offline-Fortschritt**, kein direktes Geld: Gold
   landet als Finds im Goldbeutel oder als Konzentrat, das noch gewaschen wird,
6. eine Save-Migration (`SAVE_VERSION` + `migrate` in `goldrush-save.js`),
7. ein eigenes Dev-Paket (wie `goldrush-devcommands6.js`),
8. ihre Modell-Wurzeln in `warmMachines()` und `warmPending` in `grant()`
   (`goldrush-processing.js`): Teile, die erst später sichtbar werden (Halde,
   Füllung, Partikel), gehen so vorab einmal durch die GPU – kein Ruckler beim
   ersten Anblick.

Die Waschrinne arbeitet in Schritten von 0,5 l (`STEP_ML`), 10 l/min
(`FEED_LPM`); `sluiceSplit` trennt deterministisch in Schwerkonzentrat
(Riffel) und Abraum (Halde). Rückhalt Feingold 0,65 (Moosmatte 0,75),
bei überladenen Riffeln (> 240 l seit der letzten Reinigung) fällt er bis auf
die Hälfte. Nuggets bleiben in den Riffeln und kommen beim Reinigen in den
Goldbeutel; das Schwerkonzentrat wird in der Pfanne fertig gewaschen
(Rückhalt ~0,94).

Phase-6-Ökonomie (Benchmark `tests/e2e/goldrush_bench.py --strategy A6|B6|C6|D6 --minutes 360`):
Schubkarre 300 €, Waschrinne 480 €, Großer Trichter 380 €, Moosmatte 850 €.
100 Seeds je Strategie (A6 alte Upgrades zuerst, B6 Schubkarre früh, C6
Waschrinne früh, D6 ausgewogen): Schubkarre Median 174 min (A6 205, B6 144,
C6 239, D6 167), Waschrinne 246 min (C6 189), erstes Rinnen-Upgrade 306 min;
Bargeld pro Minute 4,6 € (150–180 min) → 11,0 € (300–360 min); Seed für Seed
liegt keine Strategie mehr als 16 % vorn. Nach 360 min ist weniger als 1,1 %
des Bergs bewegt. Kein Offline-Fortschritt: die Rinne wäscht nur, solange das
Spiel läuft.

Neue Item-Arten (z. B. Maschinen) bekommen ihre Besitz-Logik an einer Stelle:
`GoldRushGame.canGrant / ownsItem / _grantItem` (genutzt von Kauf **und**
Entwicklertools).

## Automation und Transfer-Schicht (Phase 7) – die Schnittstelle für Prompt 8

Phase 7 bringt die erste Automation: **Vorratstrichter** (360 l, Aufsatzbretter
540 l) am Kopf der Waschrinne, befüllt über eine Holzrampe aus dem Westteil
von Zone B, und **Dosierer** (Rüttelrinne mit Motor) darunter. Kette:
Schubkarre / Eimer → Vorratstrichter → (Dosierer) → Trichter der Rinne → Rinne.

`goldrush-transfer.js` ist die kleine, generische Grundlage – kein ECS:

- **Halter** (`volumeOf` / `roomOf` / `takeFrom` / `putInto` / `goldOf` / `massOf`):
  entweder ein Batch-Halter `{ batch, capacityMl }` (Eimer, Schubkarre,
  Rinnen-Trichter) oder ein `MaterialBuffer`.
- **`MaterialBuffer`** = INPUT + BUFFER + OUTPUT in einem: jede Eingabe bleibt
  eine eigene Schicht (Herkunft, Zusammensetzung, Gold getrennt, höchstens 24
  – darüber werden ältere zusammengelegt), entnommen wird von unten, die
  älteste zuerst (FIFO). `serialize()` / Konstruktor für den Spielstand.
- **`transfer(from, to, maxMl, id)`** – ein Umfüllvorgang, exakt, bei vollem
  Ziel nur der passende Teil; der Rest bleibt, wo er war.
- **`TransferLink`** – Motor / Schieber zwischen OUTPUT und INPUT mit
  `rateLpm`, bewegt ganze Schritte (`stepMl`). Zustände `moving` / `blocked`
  (Ziel voll = **Backpressure**) / `starved` (Quelle leer) / `off`. Einziger
  Zustand ist der Schritt-Akku (gespeichert) – kein Rückstau, der später
  „ausbricht“, nichts doppelt, nichts verloren.
- **`stepChain(links, dt, nextId)`** – eine Kette von Links stromabwärts
  zuerst, in Schritten ≤ 0,5 s: unabhängig von Bildrate und Simulation.

**Ein Förderband (Prompt 8)** ist damit: ein `MaterialBuffer` (das Band;
Kapazität = Länge × Beladung pro Meter) + ein `TransferLink` mit der
Bandgeschwindigkeit in den nächsten Eingang. Eine Kette Lader → Trichter →
Band → Trommel wird mit `stepChain` vorgerückt; wenn das Ende voll ist, staut
sich alles zurück und läuft von selbst weiter. Vorratstrichter und Rinne müssen
dafür nicht angefasst werden: Ein Band kann `bulk.buffer` als Quelle oder
`sluice.hopper` als Ziel nehmen. Zu tun pro neuer Maschine wie in Phase 6
(Shop-Eintrag, `EQUIP`, Ledger-Summen `goldInContainers` / `massInContainers`,
Interaktion, Save-Migration, Dev-Paket) – plus ihr Platz in `stepChain`.

Regeln, die die Automation einhält: läuft nur im Spiel-Loop
(`ProcessingSystem.update`) oder im Sim-Hook `tickSim` (1-s-Schritte, Rinne
zuerst, dann was sie nachfüllt) – **kein Offline-Fortschritt**; Gold wird nur
bewegt (Ledger exakt); ein gleichmäßig dosierender Dosierer lässt die Rinne
12 statt 10 l/min verarbeiten (`Sluice.steadyLpm`, Feindosierung 14, höchstens
`STEADY_MAX_LPM`) – Stöße überlasten sie, eine gleichmäßige Aufgabe nicht.

Phase-7-Ökonomie (Benchmark `tests/e2e/goldrush_bench.py --strategy A7|B7|C7|D7 --minutes 660`,
100 Seeds je Strategie): Vorratstrichter 1.050 €, Dosierer 1.200 €, Aufsatzbretter
1.000 €, Feindosierung 1.400 €. Vorratstrichter Median 380 min (A7 446, D7 394),
Dosierer 482 min, erstes Phase-7-Upgrade 539 min; Bargeld pro Minute 10,7 €
(300–360 min) → 13,1 € (600–660 min); Seed für Seed liegt keine Strategie mehr
als 5 % vorn. Nach 660 min sind 16,4 m³ (24 t) bewegt – 1,5 % des Bergs: für
Förderbänder, Lader und Bagger bleibt Spielraum um Größenordnungen.

Bedienung: Kontrollpfosten westlich des Auslasses – ohne Dosierer „Schieber
ziehen“ (füllt den Rinnen-Trichter, schließt von selbst), mit Dosierer der
Hebel AUS → AUTO (läuft, solange das Wasser an ist) → AN → AUS; Kontrolllampe
grün / bernstein / aus. Status-Chip in der Nähe: Vorrat · Dosierer · Rinne · Riffel.

## Entwicklertools (QA-Modus, Prompt 5.5)

- **Zugang nur serverseitig:** Umgebungsvariable `GOLDRUSH_DEV_CODE`
  (Render → Environment; nie im Repo, nie im Frontend, nie im Log). Ohne
  Variable sind die Tools aus. Optional `GOLDRUSH_DEV_USER_IDS="1,7"` als
  Allowlist. Backend: `backend/goldrush_dev.py`. Nach dem Freischalten gibt es
  ein kurzlebiges Dev-Token (8 h, nur im Server-Speicher; im Browser nur in
  `sessionStorage`).
- **Öffnen:** GoldRush → Pause (Esc) oder Einstellungen → „Entwicklertools“.
- **Sicherheitsnetz:** Vor dem ersten Cheat wird die Mine als Dev-Snapshot
  gesichert (`goldrush.save.u<id>.devSnapshot`); „Mine vor Entwicklertest
  wiederherstellen“ bringt genau diesen Stand zurück. Eine geänderte Mine
  trägt `devModified: true` (nur informativ – wichtig für spätere Cloud-Saves
  und Multiplayer).
- **Neue Befehle registrieren** (keine UI-Änderung nötig):

  ```js
  import { registerDevCommand } from "./goldrush-devregistry.js";

  // aus goldrush-devcommands6.js
  registerDevCommand({
    id: "sluice.hopper0", category: "material", group: "Waschrinne",
    label: "Trichter leer", cheat: true,
    available: (ctx) => (ctx.game.processing.sluice ? true : "Erst eine Waschrinne besitzen."),
    run: (ctx) => (ctx.game.processing.devSetHopper(null) ? { ok: true, text: "Trichter ist leer." } : { ok: false, error: "…" }),
  });
  ```

  Das neue Paket wird in `goldrush-devtools.js` mit einer Import-Zeile
  eingebunden (DEV_PACKS). Arten: `button`, `input`, `file`, `toggle`,
  `choice`, `items`, `info` (Details im Kopf von `goldrush-devregistry.js`).
  „Alle aktuellen Items freischalten“ liest `SHOP_ITEMS` – neue Shop-Items
  sind automatisch dabei.
- **Regel:** Dev-Befehle prüfen zuerst und ändern dann (oder gar nicht); sie
  laufen über die Systeme des Spiels (Kauf-Logik, Goldbeutel, MaterialBatch
  mit `source: "dev"` im Ledger). Sie ändern nie Preise, Fundraten,
  Goldgehalt oder Recovery.

## Langfristige Vision (noch NICHT umgesetzt)

Diese Punkte sind Zielrichtung für spätere Prompts. Nichts davon ist gebaut;
neue Systeme dürfen ihnen nicht widersprechen.

1. **Narrativer Grund:** Es gibt einen Grund, warum der gesamte Berg weg muss.
2. **Story-Hook:** Ein gigantischer Charakter namens **TIM** verdonnert den
   Protagonisten dazu, den massiven Berg vollständig abzubauen. Gold ist das
   Mittel, um bessere Werkzeuge und Maschinen zu finanzieren – das
   übergeordnete Ziel ist: **den Berg entfernen.**
3. **Der Berg ist endlich** (das Haufenvolumen wird bereits gemessen; nach
   180 min sind < 1,5 % abgetragen, nach 360 min mit Schubkarre und
   Waschrinne < 1,1 %, nach 660 min mit der ersten Automation ~1,5 % –
   rund 1.100 m³).
4. **Open Pit:** Nach dem vollständigen Abbau geht die Mine unter das
   ursprüngliche Bodenniveau weiter. (Technisch vorbereitet: die
   Abbaugrenze `FLOOR_Y` ist vom Ursprung des Ressourcen-Rasters
   `SLICE_ORIGIN_Y` entkoppelt – nirgends gilt „Boden = 0 ist das Ende“.)
5. **Später eventuell Underground / Tunnel.**
6. **Später Character Selection.**
7. Dabei können **stilisierte Figuren**, teilweise basierend auf realen
   Personen, verwendet werden.
8. **Multiplayer-Minen / Lobby**, perspektivisch bis ungefähr **10 Spieler**.
9. Multiplayer als **gemeinsamer Claim / gemeinsame Mine**.
10. **Keines dieser Systeme ist jetzt implementiert.**

Was Phase 5/5.5 dafür schon richtig macht: Spielstände gehören einem Konto
(Besitzer-Fingerprint), Dev-Änderungen sind am Spielstand markiert
(`devModified`), der Entwicklerzugang hängt am Konto und am Server – nicht am
Gerät –, und die Item-/Befehls-Registries sind datengetrieben.
