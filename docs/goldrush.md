# GoldRush – interne Design- und Architekturnotizen

Interne Notizen für die Weiterentwicklung (Prompt 6–12). Nicht für Spieler.
Liegt bewusst außerhalb von `static/`, wird also nicht ausgeliefert.

## Module (Stand Phase 7A)

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
| Waschschale (Phase 7A) | `goldrush-processing.js` (`pan.tool = "bowl"`), Werte `BOWL_*` in `goldrush-material.js`, Modell in `goldrush-processmodels.js` |
| Geologie: mineralisierte Pay-Streaks (Phase 7A) | `goldrush-resources.js` (`STREAK`, `streakAt`, `cementedAt`), `toolEfficiency(…, cemented)` in `goldrush-tools.js` |
| Gold-Größenklassen (Phase 7A) | `goldrush-loot.js` (`FIND_LOOK`, `findSize`) |
| Camp-Dressing, Wege (Phase 7A) | `goldrush-campdressing.js` (`CampDressing`, `PATHS`) |
| Statische Teile zusammenbacken (Draw Calls) | `goldrush-merge.js` (`mergeStatic`) |
| Entwickler-/QA-Werkzeuge | `goldrush-dev*.js` (siehe unten; Phase 6 / 7 / 7A: `goldrush-devcommands6.js`, `goldrush-devcommands7.js`, `goldrush-devcommands7a.js`) |

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

## Gameplay-Integration und Qualitätspass (Phase 7A)

**Waschschale – der primitive Wasch-Loop ab dem ersten Eimer.** Am Trog liegt
von Anfang an eine Holzschale (kein Shop-Item). Eimer am Waschplatz abstellen →
[E] „Waschschale aus dem Eimer füllen“ → schwenken → Gold in den Beutel. Gleiche
Physik wie die Pfanne (`panLoad`, Ledger: Eimer → Schale → Beutel + Tailings,
µg-genau), nur schlechter: 1,4 l pro Ladung (Rest < 0,3 l geht mit), 3,2 s/l
(≈ 4,5 s pro Ladung, Untergrenze 3 s), 48 % Feingold-Recovery (Pfanne 58 %).
Sobald die Goldpfanne gekauft ist, ersetzt sie die Schale; eine angefangene
Ladung behält ihr Werkzeug (`pan.tool`, gespeichert).

**Sichtbare Funde verschwinden nicht im Eimer.** Beim Graben in Eimer oder
Schubkarre werden Flitter, Flocken und Nuggets sofort am Grabort entdeckt
(Loot, Beutel) – wie beim Graben ohne Eimer. In den Behälter gehen nur das
Material und sein Feingold, das nur Waschen zurückholt. Gold wird dadurch
nicht mehr oder weniger, es kommt nur früher sichtbar an. (`collect()` in
`goldrush-processing.js`; Dev-Material darf weiter Stücke enthalten.)

**Methoden-Leiter: Wert pro aktiver Spielminute.** Gemessen mit
`tests/e2e/goldrush_bench.py --kit …` (festes Kit, nichts gekauft, normale
Verkaufswege, alle Lauf-, Trage- und Waschzeiten): 48 Seeds × 40 min an den
Startflächen, Verhältnis der Erwartungswerte zu „direkt graben“ (Material als
Abraum, nur sichtbare Funde) mit derselben Schaufel:

| Methode | Basis-Schaufel | + Blatt | + Blatt + Stiel (Referenz) | Ziel |
|---|---|---|---|---|
| direkt graben | 1,00 (257 ct/min) | 1,00 (276) | 1,00 (296) | 1,00 |
| Eimer + Waschschale | 1,34 | 1,24 | **1,16** | 1,15–1,30 |
| Eimer + Goldpfanne | 1,63 | 1,51 | **1,41** | 1,25–1,45 |
| Classifier + Pfanne | 1,75 | 1,62 | **1,51** | 1,35–1,55 |

Referenz ist die voll ausgebaute Schaufel: Verarbeiten muss sich auch gegen das
beste direkte Graben lohnen, und mit ihr wird die Pfanne in den kanonischen
Strategien meist benutzt. Verarbeitung ist durch die Waschzeit begrenzt –
Schaufel-Upgrades machen nur das direkte Graben schneller, daher die Spalten.
Feingold (≈ 82 ct/l an den Startflächen) ist der Großteil des Goldes im
Material; sichtbare Stücke ≈ 2,7 ct/l. Der Classifier nimmt aus reiner Erde
nur ein Sechstel heraus (`COARSE`), aus Kies fast zwei Drittel – auf Kies
lohnt er sich deutlich mehr als in der Tabelle. Konzentrat: 63 % Recovery,
3,3 s/l (Phase 5: 68 % / 2,7 s – damals 1,98x gegen die Basis-Schaufel).

**Geologie: mineralisierte Pay-Streaks.** Pro Seed 6 geneigte Platten aus
verfestigtem Kies / Lehm (`STREAK`), deterministisch, nie in der Startzone,
eine nahe ihrem Rand (≈ 8–12 m vom Start) und an der Oberfläche sichtbar.
Hand: prallt ab. Schaufel: kratzt nur (8 % Wirkung). Spitzhacke: bricht sie auf
und lockert sie (`terrain.loose`, gespeichert) – danach nimmt die Schaufel das
gelockerte Material in vollen Bissen. Mehr Gold steckt darin (+0,42 Dichte im
Kern, vor allem Feingold und Flocken; Nugget-Chancen nur die des Umgebungsbodens
plus wenig – keine Nugget-Farm), dafür liegt im übrigen Boden 1,5 % weniger
(`redist 0.985`): Gesamtgold des Bergs gleich (−0,6 … +0,4 % je Seed gegenüber
Phase 7, über das Volumen gemessen). Gemessen am ersten Streak gegen den Boden
direkt daneben (6 Seeds): 1,7x Gold pro Liter (0,8 % des Bergvolumens) – wer
wäscht, gewinnt dort pro aktiver Minute etwa so viel mehr; nur die sichtbaren
Stücke beim Graben 1,3x. Sichtbar an der Oberfläche: Rostfärbung, Quarzäderchen, dunkle
Schwermineral-Streifen (Terrain-Shader) – nie das Gold selbst. Erstkontakt pro
Streak: Meldung „Mineralisierte Zone“ (`economy.flags.streaksFound`).

**Gold-Optik passt zum Wert** (`FIND_LOOK`): Staub / Feingold = ein paar
winzige Punkte (2–3 mm gezeichnet, ein instanzierter Draw), Flocke 4,5–7 mm,
kleines Stück 6–9,5 mm, erst ein Nugget (1–4 €) 10,5–16,5 mm. Größe innerhalb
der Klasse logarithmisch nach Wert. Größere Klassen (tiefe Schichten) später
einfach als neue Einträge.

**Kanonischer Benchmark 7A** (100 Seeds je Strategie, gegen Phase 7 bzw. 5):
Schale ab dem Eimer → die Pfanne kommt 6 % (A7–D7, M) bzw. 13 % (P/K, Eimer
direkt nach der Schaufel) früher, Wert nach 60 min +4 % bzw. +23 %. Die
Classifier-Ära verdient weniger als in Phase 5 (gewollte Leiter), dazu bleibt
der Bot länger in der fair geklemmten Startzone (er wäscht statt seitlich
weiterzugraben) und gräbt die Streaks kaum an (−1,5 % Gold im übrigen Boden):
Schubkarre ±2 %, Waschrinne +5 % (A7 +10 %), Vorratstrichter +7…11 %, Dosierer
+10…11 % später, Wert nach 660 min −10…−15 %; die Rate im Spätspiel (Rinne +
Automation) ist dieselbe. Phase 5 (180 min): P/K liegen gepaart 17–19 % vor T
(Phase 5: ~10 %), A7 vor B7–D7 5–7 %. Längste Strecke ohne jede Rückmeldung in
den ersten 45 min: Median 33 s (Fund / Flitter, Beutel wächst); ohne Staub und
Flitter (erst ab Flocke, Waschergebnis, Streak, Verkauf, Kauf) Median 4,7 min,
P90 6,9 min – die Handphase vor der Schaufel.

**Optik:** Schaufel-Ladung baut sich beim Schöpfen auf dem Blatt auf und
verlässt es beim Auskippen (Krümel); Partikel je Material in einem Farbband
(keine schwarzen Brocken in brauner Erde, keine weißen Funken im Kies);
Terrain-Shader: Materialgrenzen über Weltrauschen (keine Rechteck-Teppiche),
zwei Detail-Samples gegen Kachelung, Krümel-Relief auf bearbeitetem Boden
(stärker an steilen frischen Kanten), unberührter flacher Rand in der Farbe des
Campbodens; Camp-Dressing (Wege, Schubkarrenspuren, Säcke, Bretter, Schlauch,
Steinhaufen, Laufroste, Drainage, Sandhaufen – alles gemerged, ohne Kollision);
Licht etwas wärmer, Fernberge mit eingemalter Atmosphäre (nah wärmer, fern
kühler und blasser).

**Draw Calls:** statische Teile gebauter Maschinen (Rinne, Vorratstrichter,
Rampe) werden nach dem Aufbau pro Material zusammengebacken (`mergeStatic`),
ebenso Trog / Rohr / Schild des Waschplatzes, Wanne / Beine / Rahmen des
Classifiers und die statischen Welt-Props (Zaun, Schuppen, Fässer, Tank,
Lampen, Markierungen der Maschinenzonen, Felsen außerhalb des Bergs – je mit
ihrem eigenen Schattenwurf, `keepShadow`); die nassen Bodenflecken als 4 statt
8 Meshes. Volle Phase-7-Szene (Automation läuft), Desktop: Maschinen-Ansicht
218 → 123, Camp-Überblick 303 → 190, Mine 135 → 117; Handy 205 → 114 /
195 → 141 / 94 → 101 (ein kartenweit gebackenes Mesh wird gezeichnet, sobald
ein Teil im Bild ist). Was sich bewegt oder umschaltet, bleibt einzeln (Gate,
Hebel, Füllungen, Wasser, Schubkarre). Neue Maschinenmodelle in
`warmMachines()` bzw. über `ctx.warm()` registrieren.

**Save:** keine neue Version (v7). Neu und optional: `processing.pan.tool`,
`ledger.bowlLoads`, `economy.flags.streaksFound`; gelockerte Streak-Flächen über
das bestehende `terrain.loose`. Ältere Saves bekommen in unberührtem Boden die
neue Geologie (Gold wird aus dem Seed berechnet, abgebaute Slices bleiben
abgebaut – keine Duplikation).

**Dev-Pack 7A** (`goldrush-devcommands7a.js`): Preset „Phase 7A Qualitätstest“
(Schaufel + Spitzhacke + Eimer voll Pay Dirt am Waschplatz, du am Trog),
Basic-Wash-Test, Waschschale statt Pfanne (Schalter), Eimer goldarm / Pay Dirt /
mineralisiert, Goldproben Staub / Feingold / Flocke / kleines Stück / Nugget
(nur Optik), Pay-Streak hin und zeigen, Spitzhacken-Geologie-Test,
Material-Vorschau, Teleport Camp. Suite: `tests/e2e/goldrush_quality_e2e.py`.

**Entwicklerzugang – Diagnose (Teil A):** Ist der Code nicht konfiguriert,
liefert der (angemeldete) Status `routeVersion: 2` und eine Diagnose: welcher
Server antwortet (Render-Name, Service-ID, Instanz, Commit, externe Adresse –
öffentliche Metadaten) und ob die Variable fehlt, leer ist oder unter einem
ähnlichen Namen existiert; Render-„Secret Files“ (`/etc/secrets/GOLDRUSH_DEV_CODE`)
werden auch gelesen. Nie Code, Hash, andere Variablen oder Tokens. Das
Frontend unterscheidet NOT_CONFIGURED / AUTH_ERROR / NETWORK_ERROR /
ENDPOINT_NOT_FOUND / SERVER_ERROR und zeigt die Seiten-Origin neben der Adresse
des antwortenden Servers. Häufigste Live-Ursache: die Seite läuft über eine
andere Adresse (anderer Render-Dienst) als der, an dem die Variable gesetzt ist –
Service-ID im Dialog mit dem Dashboard vergleichen.

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
