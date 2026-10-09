# GoldRush – interne Design- und Architekturnotizen

Interne Notizen für die Weiterentwicklung (Prompt 6–12). Nicht für Spieler.
Liegt bewusst außerhalb von `static/`, wird also nicht ausgeliefert.

## Module (Stand Prompt 10)

| Bereich | Datei(en) |
|---|---|
| Einstieg, Startscreen, Menüs, Dialoge | `static/games/goldrush/goldrush.js` |
| Spiel, Loop, Spieler, Kauf | `goldrush-engine.js` |
| Spielstände (pro Konto), Migrationen, Dev-Snapshot | `goldrush-save.js` (`GoldRushSaveService`, Version 9) |
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
| Loses Material in Schaufel / Eimer / Schubkarre / Sieb (Phase 8: behälterbezogen) | `goldrush-heap.js` (`GridLoad`, `bladeShape` / `bucketShape` / `trayShape` / `screenShape`, `LOOSE_MAT`) |
| Schubkarre schieben (Phase 8) | `goldrush-wheelbarrow-controller.js` (`PushController`, `PUSH`, `clampLook`) |
| Goldankauf-Bude, Ausrüstungs-Schuppen (Phase 8) | `goldrush-buildings.js` (`buildAssayBooth`, `buildSupplyShack`, `boardTexture`); Waage / Verkauf in `goldrush-stations.js` |
| Autorierte Modelle .glb / .gltf (Phase 8, optional) | `goldrush-assets.js` (`model`, `modelOr`, `instance`), `models/manifest.json`, GLTFLoader in `static/vendor/three/addons/` |
| Geologie 2.0: Paläorinnen, Camp-Auffüllung, Versionsnummer (Phase 9) | `goldrush-resources.js` (`GEOLOGY_VERSION`, `GEO`, `CHANNEL`, `CAMP_FILL`, `channelAt`, `campFillAt`) |
| Prospektion: Probenbeutel, Notizbuch, Fähnchen (Phase 9; 9.1: eine Nummerierung, Einsammeln, Reset) | `goldrush-prospect.js` (`ProspectSystem`, `SAMPLE_DEF`) |
| Bergauftrag (Fortschritt am Berg, Freigaben) (Phase 9) | `goldrush-contract.js` (`MountainContract`, `MOUNTAIN_FLOOR`, `CONTRACT_STEPS`); Tafel in `goldrush-stations.js` |
| Aufgabetrichter + Förderband, Trommelsieb, Abraumhalde (Phase 9) | `goldrush-plant.js` (`Conveyor`, `Trommel`, `SpoilHeap`), `goldrush-transfer.js` (`Belt`), `goldrush-material.js` (`trommelSplit`) |
| Modelle der Anlage (Phase 9) | `goldrush-plantmodels.js` (`PlantModels`, Layout-Konstanten `INTAKE`, `BELT`, `TROMMEL`, `OVERSIZE`, `SPOIL`) |
| Kompaktbagger (Phase 9) | `goldrush-excavator.js` (`Excavator`, `EXC_DEF`), Modell / Rig `goldrush-excavatormodel.js` (`ExcavatorRig`, `rigFromScene`) |
| Haufen: Rohmaterial, Überkorn, Tailings-Auslauf / -Zone, Abraum (Prompt 10) | `goldrush-stockpile.js` (`StockpileSystem`, `Stockpile`, `PILE_TYPES`, `PILE_SITES`) |
| Kompakt-Radlader (Prompt 10) | `goldrush-loader.js` (`Loader`, `LOADER_HOME`, `DRIVE`), Modell / Rig `goldrush-loadermodel.js` (`LoaderRig`, `LDR`, `loaderRigFromScene`) |
| Waschanlage: Verteilerkasten, drei Rinnen, Konzentratwanne (Prompt 10) | `goldrush-washplant.js` (`WashPlant`, `WP`); die Rinne gibt ab (`Sluice.wp`) |
| Bergseiten-Abbaugerät (Prompt 10) | `goldrush-autominer.js` (`AutoMiner`, `MINER`, `MINER_DEF`, `MINER_HOME`), Modell / Rig `goldrush-autominermodel.js` (`AutoMinerRig`, `AM`); Platzierung in `goldrush-engine.js` (`_placeStart` / `_placeUpdate` / `_placeEnd`) |
| Empfänger-Tabelle (alles, worin gekippt wird) (Prompt 10) | `ProcessingSystem.receivers()` in `goldrush-processing.js` |
| Entwickler-/QA-Werkzeuge | `goldrush-dev*.js` (siehe unten; Phase 6 / 7 / 7A / 7B / 8 / 9 / 10: `goldrush-devcommands6.js`, `goldrush-devcommands7.js`, `goldrush-devcommands7a.js`, `goldrush-devcommands7b.js`, `goldrush-devcommands8.js`, `goldrush-devcommands9.js`, `goldrush-devcommands10.js`) |

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
[E] „Mit Waschschale waschen“ (7B) → schwenken → Gold in den Beutel. Gleiche
Physik wie die Pfanne (`panLoad`, Ledger: Eimer → Schale → Beutel + Tailings,
µg-genau), nur schlechter: 1,4 l pro Ladung (Rest < 0,3 l geht mit), 3,2 s/l
(≈ 4,5 s pro Ladung, Untergrenze 3 s), 48 % Feingold-Recovery (Pfanne 58 %).
Sobald die Goldpfanne gekauft ist, ersetzt sie die Schale; eine angefangene
Ladung behält ihr Werkzeug (`pan.tool`, gespeichert).

**Sichtbare Funde beim Graben in Behälter (7A, in 7B ersetzt).** In 7A wurden
Flitter, Flocken und Nuggets auch beim Graben in Eimer / Schubkarre sofort am
Grabort entdeckt; seit Phase 7B nimmt der Behälter-Anteil seine Stücke mit
(siehe „Behälter-Ledger (Phase 7B)“ unten).

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

## Material-Realität, Processing-UX, Behälter-Ledger (Phase 7B)

**Warum beim Füllen „+ €“ kam (7A).** `collect()` hat in 7A die sichtbaren
Funde eines Digs immer sofort entdeckt (Loot → Beutel) und nur Material +
Feingold in Eimer / Schubkarre gelegt. Das war keine Doppelbuchung (die Stücke
wurden aus der Batch entfernt), aber falsch: der Behälter verlor seine Stücke,
und das Geld kam beim Füllen statt beim Waschen.

**Verbindliche Behälter-Logik (7B).** Direkt graben: sichtbare Funde sofort,
Feingold in den Abraum (`ledger.spoilFineUg`). Graben in einen Behälter: der
Teil des Digs, der hineinpasst (`dig.take(room)`), nimmt seine diskreten Funde
und sein Feingold mit – sie gehen nicht in den Beutel, erst Waschen / Sieben /
Rinne bringt sie heraus (`economy.recover`). Nur der Überlauf-Teil wird wie
direktes Graben behandelt (seine Stücke werden entdeckt, sein Feingold geht in
den Abraum). Die Aufteilung ist die von `MaterialBatch.take()`: Volumen, Massen
und Feingold anteilig in ganzen Einheiten, Stücke `floor(n · f)` in Reihenfolge.
Neu im Ledger: `inFinds` (Stücke, die in Behälter gingen, Dev-Material
eingeschlossen). Gold rein = Beutel + Behälter + Processing + Tailings + Abraum,
auf das µg; kein Stück zweimal (geprüft mit identischen Zellen A direkt /
B Eimer / C Schubkarre, Teil-Füllung, Überlauf mit Stücken, Save / Reload vor
und nach dem Waschen – `tests/e2e/goldrush_material_e2e.py --only ledger`).

**Methoden-Leiter nach dem Fix:** unverändert gegenüber 7A (48 Seeds, gleiche
Tabelle oben: Referenz-Schaufel 1,16 / 1,41 / 1,51), weil Waschen alle
mitgenommenen Stücke zurückholt – der Wert kommt nur später an. Keine
Neukalibrierung, kein Bonusgold.

**Loses Material statt Kugeln** (`goldrush-heap.js`, `LooseLoad`): eine
Polar-Gitter-Oberfläche aus mehreren Schüttkegeln (Böschungswinkel, Rauschen
auf Umriss und Höhe, planare UVs, Vertex-Farben nach Zusammensetzung) plus ein
instanziertes Mesh mit Krümeln / Klumpen / Kieseln / Steinen (`LOOSE_MAT`). Zwei
Draws pro Ladung, feste Puffer – eine neue Füllung schreibt nur Vertex-Daten und
Instanz-Matrizen um (Signatur-Cache), nichts wird nachträglich erzeugt.
Schaufel: lockere, gehäufte Schicht (Erde Krümel, feste Erde Klumpen, Kies viele
Kiesel), läuft dem Blatt beim Schwung nach und rutscht beim Abwerfen zur
Spitze. Eimer: Füllhöhe nach Litern (Rand an der Wand, Mitte leicht gehäuft).
Schubkarre: wachsender unregelmäßiger Haufen, bis zu 4 Kegel, voll eine Hand
breit über dem Rand (die Wanne hat keinen Deckel mehr). Classifier: der Haufen
sinkt beim Rütteln (das Feine fällt durch), am Ende liegt nur der Grobanteil
(`COARSE`) da und rutscht ab. Goldpfanne: Kreisen kippt und dreht die Pfanne,
Wasser und Material folgen verzögert (Feder `_slosh`); Stufen schlammig →
helle Erde geht → weniger, kleinere Steine → Schwarzsand sammelt sich auf der
tiefen Seite → Gold (wertabhängig wie 7A, das Popup bleibt).

**Processing-UX:** am Trog „[E] Mit Waschschale waschen“ (mit Pfanne „Mit
Goldpfanne waschen“), einmaliger Hinweis beim ersten vollen Eimer am Waschplatz
(nur solange noch nie gewaschen wurde). Die Holzschale liegt am vorderen
Trogrand, zum Spieler gekippt, helleres Holz – kein Leuchten, kein Marker.
Schubkarre am Waschplatz: Pfanne direkt aus der Karre bleibt möglich (kein
Lock), die Ansage nennt aber den besseren Weg (`barrowBetter()`: Vorratstrichter
→ Trichter der Waschrinne → „erst sieben“), `secondary: true`.

**Geologie / Terrain (Shader v7):** mineralisierte Zonen als zusammenhängender
Rostschleier, dunkle Schwermineral-Bänder im Streichen, wenige dünne
Quarzäderchen in warmem Altweiß (kein Konfetti), die Zone kiesig; Pile-Kiesel
erdig grau-braun statt weiß. Nahbereich: leichte Schichtung, Rinnen und
Bruchlinien an steilen Flächen, Kies sammelt sich am Fuß, Mikrorelief überall
(stärker an steilen Flächen). Frische Schnitte nur noch leicht dunkler und
feucht (keine „verbrannten“ Flecken). Gameplay-Geometrie unverändert.

**Camp:** der Wassertank (vorher ein schwarzer Zylinder – Metall ohne
Umgebungslicht) bekommt verzinkte, genietete Platten mit Roststreifen
(Canvas-Textur), ein flaches Kegeldach mit Luke, zwei Bänder, Boden und den
Auslass mit Ventil am Rohr zum Trog; die Welt-Metalle bekommen die
Umgebungs-Reflexion. +2 Draw Calls (gebacken pro Material).

**Session-Token im Access-Log:** der Browser öffnet `/ws?token=…`; uvicorn
schrieb die Zeile mit Token in die (Render-)Logs. `backend/log_redact.py`
hängt einen Filter an die uvicorn-Logger (und ihre Handler), der den Wert jedes
Query-Parameters `token` vor dem Formatieren durch `***` ersetzt. WebSocket und
Auth unverändert. Test: `python -m unittest tests.test_session_log -v`
(WebSocket geht, falsches Token weiter 4401, Log ohne Token, andere Zeilen
unverändert; ohne Filter schlägt er fehl).

**Draw Calls / Frames:** alle 7B-Ladungen gleichzeitig sichtbar (volle
Schubkarre, Eimer, Sieb): Camp-Ansicht 103 (Handy 95), Mine 114 (96), 60 fps.
10 000 Schöpf-Zyklen, 20× Eimer / Karre füllen + leeren, 8 Sieb-Ladungen am
Stück: keine neue Geometrie / Textur / Objekt, kein Heap-Wachstum.

**Bekannt (seit vor 7B):** WebKit (Playwright, Windows) behält im GPU-Prozess
~55 MB pro geschlossener Spielsitzung (7A und 7B gleich gemessen; den Kontext zu
schließen gibt nichts frei) und hängt nach ~60–90 Sitzungen in einem Browser. Die
Camp-Suite startet WebKit deshalb pro Benchmark-Strategie neu. Ob Safari das
auch tut, ist offen.

**Save:** keine neue Version (v7); neu und optional nur `ledger.inFinds`.
Alte Saves: Behälter-Inhalte ohne Stücke bleiben gültig.

**Dev-Pack 7B** (`goldrush-devcommands7b.js`): Preset „Phase 7B Material-QA“
(Schaufel, Spitzhacke, Eimer, Pfanne, Classifier, Schubkarre, € 50, Gold-Ledger
an), dann unter Material → „Material-QA (7B)“: Scoop Erde / Kies, Eimer 25 / 50 /
100 %, Eimer mit bekanntem Fund (genau ein Flitter, nur Waschen holt ihn),
Schubkarre 10 / 40 / 85 l, Classifier Start / Mitte / Ende, Pfanne wenig / viel
Feingold, Pay-Streak / Quarz. Diagnose → „Gold-Ledger (7B)“ (nur Devtools):
Behälter-Input (Stücke, Feingold), jetzt in Behältern, direkt geborgen,
Processing gewonnen, Tailings und ob die Behälter-Bilanz auf das µg aufgeht.

## Premium Vertical Slice (Phase 8)

Prompt 8 war ein Qualitätspass, keine neue Progression (Förderband / Trommel
→ Prompt 9). Keine neuen Shop-Items, keine Preisänderung, Save bleibt v7.

**Schubkarre – die Ursachen.** `Wheelbarrow.follow(player)` setzte die Karre
jeden Frame vor den Spieler und drehte sie mit dem Blick (`yaw = player.yaw`);
`processing._barrowHands()` projizierte die Welt-Griffe in die Hand-Kamera und
`Glove._arm()` skalierte den Unterarm auf jede Länge (`arm.scale.y = len`).
Beides ist weg:

- `goldrush-wheelbarrow-controller.js` (`PushController`; Lenkung, Anfahren und
  Gelände seit Phase 9 überarbeitet – „Schubkarren-Handling“ dort): Eingabe = Wunsch
  (W/S schieben, bremsen, rückwärts; A/D lenken; Blick), die Karre antwortet
  mit eigener Geschwindigkeit `v`, Drehrate `w`, Radwinkel `spin`, Neigung.
  Beschleunigung `2,9 − 1,9·Last`, Bremsen `5,2 − 3,5·Last` m/s², maximale
  Drehrate `(1,55 − 0,8·Last)` rad/s (im Stand halb), Drehträgheit
  `6 − 3,8·Last`; bergauf weniger Kraft, bergab zieht sie (mehr mit Last),
  raues Gelände kostet Tempo und rüttelt. Die Steigung wird geglättet
  (~0,1 s) – das Mikrorelief lässt das Tempo nicht zucken. Endtempo bleibt
  `WALK · speedFactor()` (unverändert, der Benchmark nutzt ihn).
- Blick: bis 0,4 rad neben der Karre frei, darüber dreht sie sich mit
  (ratenbegrenzt); weich zurück auf 0,72 rad, hart nie über 0,84 rad.
- Gelände: das Rad fährt auf dem verformten Boden (Gruben inklusive). Steiler
  als ~32° (`MAX_GRADE`, gemessen über 20 cm voraus – pro Frame-Schritt war
  nie etwas zu steil, der alte Check griff praktisch nie) stoppt sie; eine
  6-cm-Kante und der Weg aus einer Grube zurück auf Fußhöhe gehen immer.
  Laderampe (Steigung 0,40) leer ~2,7 statt 3,2 m/s, voll ~1,4 statt 2,3.
- Arme: Unterarm 0,28 m, Oberarm 0,31 m, Zwei-Gelenk-IK von der Schulter
  (`ARM`, `Glove._arm`) – nie gestreckt; außer Reichweite behält die Hand den
  Griff und der Arm zeigt zur Schulter. An der Karre sitzen die Hände auf
  den Welt-Griffen (Hand-Pass mit der Projektion der Welt-Kamera), die
  Schultern am Körper, der zur Karre schaut. Greifen: Hände → Griffe → Beine
  heben ab; Abstellen: Griffe runter → Beine stehen → loslassen (< 0,4 s).

**Linke Hand war eine rechte.** `_gripMatrix` spiegelte die linke Hand mit
`Mx · M · Mx` (Determinante +1): an der linken Position saß ein rechter
Handschuh, Daumen auf der falschen Seite – bei Schaufel, Spitzhacke, Eimer,
Karre und Pfanne. Jetzt `Mx · M` (echte Spiegelung, `scale.x = −1`).

**Goldpfanne / Waschschale halten** (`_rimMatrix`, `HELD_GRIPS.pan/bowl` mit
`rim`): Handfläche außen an der Wand unter dem Rand, Finger die Wand hinab,
Daumen über den Rand (`PAN_THUMB`). Gekrümmte Finger stachen durch den Boden –
sie bleiben gestreckt. Test: keine Finger- / Daumenspitze im Gefäß (9 mm Haut).

**Gold in der Pfanne:** keine Goldener-Schnitt-Sichel mehr. Schwarzsand ist
eine unregelmäßige Ablagerung (eigene Geometrie `sandDisc`) in der tiefen Ecke
(Boden an der fernen Wand); das Gold liegt darauf in 2–3 Ansammlungen, pro
Ladung anders (Seed aus der Batch-ID), große Stücke am tiefsten Punkt, einzelne
Streuer. Anzahl weiter wertabhängig (`_flakeCount`). Rein visuell.

**Behälterbezogenes loses Material** (`GridLoad`): festes Gitter über der
Öffnung, Form-Funktion pro Behälter (Höhe, Material da?, Dicke), Vertex-Alpha
(ausgefranste Ränder), ein instanziertes Klumpen-Mesh nur auf sichtbarem
Material. Schaufel: flache Schicht im gewölbten Blatt. Eimer: an der Wand
begrenzt, fast eben auf echter Füllhöhe. Schubkarre: Innenform der konischen
Mulde – kleiner Haufen, dann über den Boden verteilt, voll breit an den Wänden,
nie über den Rand. Classifier: dünne Schicht über das Sieb, beim Rütteln
Löcher, am Ende nur Grobes. (Bug-Fix: `sn` rechnete `noise2·2−1`, obwohl
`noise2` schon −1..1 liefert – Relief und Lochmaske waren nach unten verzerrt.)

**Fester Fels:** Bruchzustand pro Säule (`terrain.crack` 0..16, `rubble` cm).
Spitzhacke: `strikeStone()` – +4 Risspunkte im Zentrum (weniger nach außen,
Radius 0,26 m), bei 16 bricht die Säule (12 cm Geröll), angerissene Nachbarn
(≥ 40 %) brechen mit → ein Fleck von ~0,4 m. Also: Hieb 1–3 Risse 25 / 50 /
75 % plus kleine Splitter (0,12 kg), Hieb 4 bricht (~0,95 kg). Geröll ist
Stein, den jedes Werkzeug abbaut (`rubbleEfficiency`), darunter ist der Fels
wieder ganz. Gebucht als Stein (Masse exakt, Volumen exakt, kein Gold). Save:
optionale Felder `crack` / `rubble` (RLE) im Terrain, v7.

| Material | Hand | Schaufel | Spitzhacke |
|---|---|---|---|
| Erde | 100 % | 100 % | 25 % |
| feste Erde | 45 % (gelockert 90 %) | 55 % (gelockert 94 %) | 35 %, lockert 14 cm |
| Kies | 20 % (gelockert 32 %) | 50 % (gelockert 80 %) | 30 %, lockert |
| fester Fels | blockiert, Hinweis „Spitzhacke“ | rutscht ab (Kratzen), Hinweis | Risse sichtbar, 4. Hieb bricht |
| Fels-Geröll | 18 % | 55 % | 90 % |
| Pay-Streak (zementiert) | blockiert, Hinweis | 8 % (rutscht) | 100 %, lockert → dann normal |
| Felsbrocken | prallt ab | prallt ab | Stufen intakt → beschädigt → stark → gebrochen |

Kein normales Bergmaterial weist alle Werkzeuge ab. Echter Grundfels (später
Maschinen) müsste anders aussehen und beim ersten Kontakt erklärt werden.

**Werkzeuge / Hände:** drei dezente Hieb-Varianten pro Werkzeug, kurzer
Hit-Stop auf hartem Grund, materialabhängiger Rückstoß der Hacke, der
Abwurf-Sound so schwer wie die Ladung, Ärmel als dunklere Arbeitsjacke.

**Stationen** (`goldrush-buildings.js`): Goldankauf als Assay-Bude (Pultdach,
Bretterwände, warme Innenseite, massive Theke, Messingwaage als Fokus, Regale
mit Probengläsern / Tiegeln, Kassette, Kassenbuch, Laterne; GOLDANKAUF in
Goldschrift auf dem Dachbrett und auf der Thekenfront). Verkauf: Beutel und
Gold auf die linke Schale, Balken neigt sich, Messinggewichte, pendelt aus,
Guthaben zählt danach hoch. Ausrüstung als offener Schuppen (Theke im
offenen Teil, Werkzeug am Gestell, Regale, Eimer, Stiele, Kisten, Säcke,
tiefe Blechtraufe; der alte Kasten in `goldrush-world.js` ist weg). Shop-Sheet
als Bergbau-Ladentheke (Bretter, Schild, Katalogzeilen, Preisschilder) – Logik
unverändert.

**Berg / Camp / Licht:** Rinnen mit Kiesbett, hellere Rippen, rötere Bänder an
steilen Flächen, trockene / feuchte Flecken; Schuttfächer am Fuß statt eines
Konfetti-Rings, Felsausbisse; aus der Nähe körnige Erde mit Klumpen und Grus
(blendet mit der Entfernung aus). Karrenspur Berg → Waschplatz; gewaschene
Steine als gerundete Kiesel. Licht: Himmels-Probe als Umgebungslicht für alle
Standardmaterialien, flaches Hemisphären-Licht tiefer.

**HUD – wo ist mein Material:** Zeile unter dem Goldbeutel: Eimer, Karre,
Konzentrat (Classifier-Wanne + Rinnen-Schale) – nur was man besitzt, das
gerade getragene / geschobene hervorgehoben (mit kg), voll in Gold; einmal
gebaut, nur Texte ändern sich. Der Chip darunter zeigt nur noch Maschinen in
der Nähe (Vorratstrichter / Rinne). Handy: nur Icons und Zahlen.

**Autorierte Modelle (optional):** `AssetManager.model(url)` lädt .glb / .gltf
mit dem GLTFLoader von three r176 (gleicher npm-Tarball, SHA-1 geprüft),
gecacht, mit Fortschritt und Dispose. Nur in `models/manifest.json` gelistete
Dateien werden geholt (kein 404 für fehlende); sonst `null` → `modelOr()` baut
das prozedurale Modell. Workflow: `static/games/goldrush/ASSETS.md`.

**Messwerte** (`goldrush_premium_e2e.py --only perf`, AMD-iGPU, 1366×768 bzw.
emuliertes Handy): Goldankauf-Bude 97 Draw Calls (Handy 70), Ausrüstung 95
(78), Camp 100 (71), Mine 113 (97), volle Schubkarre schieben 113 (88) –
überall 59–60 fps. 20× Karre 0 → 85 l, 14 Greif-/Schiebe-/Abstell-Zyklen,
10 000 Schaufelladungen: keine neue Geometrie / Textur / kein Objekt, kein
Heap-Wachstum. Die Arm-Meshes werden beim Laden einmal ohne Culling gezeichnet
(sonst +2 Geometrien beim ersten Schieben).

**Dev-Pack 8** (`goldrush-devcommands8.js`): Preset „Phase 8 Premium-QA“
(Ausrüstung, die Karre vor dir), unter Welt: Schubkarre leer / halb / voll,
Hang + raue Strecke, Erde / feste Erde / Kies / eingebetteter Fels, Felsbrocken,
Pay-Streak, Classifier beladen, Goldankauf, Ausrüstung, Camp-Überblick.

**Tests:** `tests/e2e/goldrush_premium_e2e.py` (`--only barrow,barrowterrain,
stone,matrix,loads,glb,hands,pangold,hud,sound,stable,perf,dev`; die 17 festen
Review-Ansichten mit `--shots DIR --tag NAME`). Die Karrentests laufen
pausiert: nur `walk()` treibt die Zeit (die echte Schleife bremste die Karre
zwischen zwei Aufrufen und machte die Messung lastabhängig); unter WebKit
startet die Suite den Browser pro Teil neu. Ältere Suiten angepasst, wo sich
das Verhalten bewusst geändert hat: T33 (`goldrush_tools_e2e.py`) prüft
Splittern → Bruch statt „langsam abtragen“, die 7B-Stabilität misst
`GridLoad`-Kennzahlen statt `LooseLoad`-Parameter, die Phase-6-Schiebetests
rechnen mit dem Anfahren (W7: leer > 7 m in 3 s; bis zum Trichter 2,6 s
schieben); der Test-Hook `proc().held` meldet „barrow“, solange die Hände an
der Karre sind.


## Mechanisierter Claim (Phase 9)

Aus dem kleinen Hand-Claim wird die erste mechanisierte Goldmine – auf drei
Achsen: **Abbau** (Kompaktbagger, Hydraulikhammer), **Transport**
(Aufgabetrichter + Förderband) und **Verarbeitung** (Trommelsieb,
Hochleistungsrinne). Dazu Geologie 2.0, Prospektion und der Bergauftrag.
Save **v8**. Keine Offline-Erträge: alles läuft nur, solange GoldRush aktiv ist.

**Gold-Audit (vor dem Umbau).** Räumlich / deterministisch war und ist: das
Material pro Säule, die Golddichte `goldDensityAt` (Seed + Position + Original-
oberfläche), jede 1-cm-Scheibe (Fund, Feingold `fineUg = 6000·g`, Masse) und
ihr Verbrauch (`terrain.used` – einmal bezahlt, nie wieder). Rein visuell sind
nur: wo die Flitter in der Pfanne liegen, der Schwarzsand, die Oberflächen
loser Ladungen, Glitzern, Färbungen, Effekte. Der Satz „Goldverteilung ist
rein visuell“ im Prompt-8-Bericht meinte **nur die Anordnung der Flitter in
der Pfanne**, nicht die Verteilung im Boden. Das eigentliche Problem war
geologisch: die Kies-„Pay Layer“ um das alte Bodenniveau (plus Kies-Faktor)
machte jedes Loch auf Bodenhöhe – auch vor dem Camp – zur besten Goldfarm.

**Geologie 2.0** (`goldrush-resources.js`, `GEOLOGY_VERSION = 2`): keine Pay
Layer mehr. Ein neutraler Grundgehalt mit regionaler Variation (`GEO`), Kies
etwas reicher als Erde (`mf 0,88 / 1 / 1,15`), der obere Berg etwas ärmer
(`mountain 0,94`, weich von 0,3 bis 2,2 m Originalhöhe). Dazu 2–4
**Paläorinnen** pro Seed (`CHANNEL`): gekrümmte, begrabene alte Bachbetten
über den Claim, teils unter dem Berg, Breite 1,4–3,4 m, Sohle −1,25…−0,3 m,
Mächtigkeit 0,35–0,8 m, Kieslinsen, arme und reiche Abschnitte, Lücken.
Der **Camp-Vorplatz** ist aufgeschütteter, verdichteter Fremdboden
(`CAMP_FILL`, ~0,55 m tief, Gehalt 0,008): kaum Gold, darunter natürlicher
Boden; sichtbar als graueres, gepresstes Kies mit Fahrspuren. Unter
Gebäuden / Stationen wird nicht gegraben (Dig-Area unverändert). Nichts hängt
an y = 0. `GEO.scale 1,9` hebt den Gehalt insgesamt (das Phase-7-Einkommen
kam zu ~45 % aus der Pay Layer), `G_MAX 2,6` deckelt eine Scheibe. Starter-
Zone bleibt fair (Band 0,21–0,29). Zementierte Streaks und Taschen bleiben.

`tests/e2e/goldrush_geology_bench.py` (12 Seeds, Gold pro 10 l, relativ zum
Claim-Mittel): Camp-Aufschüttung **0,05×**, Starter 0,77×, unterer Berg
0,78×, **oberer Berg 0,79×**, Paläorinne arm **1,8×** / mittel 2,6× / reich
**3,6×**, Streaks 2,4×, Taschen 2,6×; unter der Aufschüttung 1,0×.

**Migration v7 → v8:** `geology: { version: 2, from: 1 }`. Verbrauchte
Scheiben bleiben verbraucht, jede MaterialBatch (Eimer, Karre, Trichter,
Rinne, Wanne …) behält exakt ihr Gold – nur unberührter Boden folgt der neuen
Geologie. Einmaliger Hinweis beim Laden („Der Claim wurde neu vermessen …“).

**Prospektion** (`goldrush-prospect.js`, Item „Probenset“ €45): `R` nimmt eine
echte Probe (0,5–1,5 l, eigener kleiner Kernel, ins Ledger gebucht) aus dem
Material unter dem Fadenkreuz, max. 6 Beutel. Am Waschplatz eine schnelle
Testpfanne (2,4–4 s). Ergebnis: Masse, Volumen, Gold in mg und **mg/l**,
Material, Ort – sachlich, keine Ampelfarben. `N` öffnet das Probenbuch
(letzte 20 Einträge), `F` setzt / entfernt nummerierte Markierungsfähnchen
(max. 12, eine Probe innerhalb 1,6 m trägt die Nummer). Keine Heatmap, kein
Golddetektor, keine Dichte im HUD.

**Bergauftrag** (`goldrush-contract.js`): misst nur den **ursprünglichen
Berg** über `MOUNTAIN_FLOOR` (0,06 m): `V0 = Σ max(0, h0 − F)·A`, abgetragen
= `V0 − Σ max(0, h − F)·A` (Gruben unter dem Boden zählen nicht, Aufschüttung
zählt nicht als Berg). Tonnen aus der echten geschnittenen Masse
(`mountainKg`). Anzeige exakt in m³, t und % (2 Nachkommastellen) auf dem
Brett BERGAUFTRAG neben dem Camp (`E`), im Pausenmenü und in der Shop-Sperre
(„Bergauftrag: X % des Bergs abgetragen (jetzt Y %)“). Freischaltungen
brauchen **Geld und Bergfortschritt**:

| Item | Preis | Voraussetzung |
|---|---|---|
| Probenset | €45 | Goldpfanne |
| Förderband mit Aufgabetrichter | €1.300 | Vorratstrichter, Berg ≥ 0,9 % |
| Trommelsieb | €1.500 | Förderband, Berg ≥ 1,1 % |
| Hochleistungsrinne | €1.000 | Trommelsieb |
| Kompaktbagger | €2.000 | Förderband, Berg ≥ 1,45 % |
| Hydraulikhammer | €2.400 | Kompaktbagger, Berg ≥ 2,0 % |

**Anlage** (`goldrush-plant.js`, Modelle `goldrush-plantmodels.js`, Transfer
über `goldrush-transfer.js`):

- **Aufgabetrichter** am Bergfuß (−14,35 / −9,35), 240 l, Schubkarre / Eimer /
  Bagger kippen hinein. Füllung als echte Oberfläche, Hebel STOP / AUTO / AN
  am Posten, Generator daneben.
- **Förderband** (`Belt`): 24 Zellen à 900 ml, 0,42 m/s ≈ 64 l/min bis zum
  Kopf über dem Vorratstrichter. Zustände **AUS / WARTET / LEER (starved) /
  LÄUFT / STAU (blocked)**; Rückstau: ist das Ziel voll, steht das Band mit
  Material. AUTO läuft, solange die Rinne läuft. Die echte Beladung liegt als
  niedriges Materialbett pro Zelle (nach Material gefärbt, ein, zwei Klumpen
  obenauf): wenig Material → getrennte Abschnitte, viel → ein durchgehendes
  Band; nichts davon ist für Gold oder Masse maßgeblich.
- **Trommelsieb** am Bandkopf: 60 l/min, exakte Aufteilung
  (`trommelSplit`, `TROMMEL_TUNING`: Überkornanteil Erde 5 %, feste Erde 14 %,
  Kies 42 %, Fels 92 %; Lehm-/Lockerfaktor). Gold folgt den Strömen
  (Unterkorn → Vorratstrichter → Dosierer → Rinne; Überkorn → Haufen). Wasser
  aus dem Tank. Überkorn liegt als wachsender Haufen nördlich der Rutsche
  (bis ~7 m³, dann wartet die Trommel) und lässt sich mit Karre oder Bagger
  zur **Abraumhalde** fahren – das Gold darin ist nicht verloren, nur
  unverarbeitet.
- **Warum die Trommel am Bandkopf sitzt** (statt hinter dem Dosierer, wie
  zunächst skizziert): so puffert der Vorratstrichter nur noch Feines, der
  Dosierer dosiert gleichmäßig nur Feines in die Rinne, Steine erreichen
  Trichter und Rinne nie, und die Phase-7-Kette Trichter → Dosierer → Rinne
  bleibt unverändert. Hinter dem Dosierer müsste die Trommel ihr Überkorn
  neben der Rinne loswerden – dort ist kein Platz für einen Haufen. Alle
  Einzelfunde dieses Bodens sind kleiner als die Siebmaschen und gehen mit dem
  Unterkorn (Test: jedes Stück im Unterkorn); das Überkorn bleibt aufnehmbar
  (Schubkarre / Bagger, zurück in den Aufgabetrichter oder auf die Halde).
- **Hochleistungsrinne**: 20 → 32 l/min (Dosierer mit), Riffel fassen 640
  statt 240 l, Fang 0,62 statt 0,65 (mit Moosmatte 0,72 statt 0,75) – mehr
  Durchsatz, etwas weniger Feingold pro Liter; der Kasten wird sichtbar
  breiter.
- **Abraumhalde** (−18,5 / −15,5): gebucht als Tailing (Masse und Gold
  exakt), Kegel wächst mit dem Volumen.

**Kompaktbagger** (`goldrush-excavator.js`, Modell
`goldrush-excavatormodel.js`): Rig mit Gelenken (Laufwerk, Oberwagen, Kabine
links, Ausleger, Stiel, Werkzeug), Front +X, planare IK. Ein autoriertes
`models/excavator.glb` mit denselben Knotennamen ersetzt das prozedurale Modell
(Tabelle in `ASSETS.md`). Einsteigen an der Kabinenseite (`E`), Aussteigen `E`
(neben der Kabine, sonst die andere Seite). **W/S** fahren, **A/D** drehen (Ketten laufen sichtbar), Maus
schwenkt / zielt; **Primär** = Löffel füllen (assistiert: ansetzen → Zähne
greifen → einrollen → Schnitt wird abgetragen → Löffel voll → anheben),
**Sekundär / `Q` / KIPPEN** = auskippen (Teilmenge, wenn das Ziel nicht alles
fasst), `T` wechselt Löffel ↔ Hammer. Löffel 45 l, gehäuft bis ~43 l pro
Schnitt aus genau diesen Zellen (echte MaterialBatch, kein Zusatzgold);
gemessen (pausiert, nur die echten Phasenzeiten) **474 l/min = 5,2×** die
Schaufel (91 l/min) inklusive Schwenken zum Aufgabetrichter. Ziele: Aufgabetrichter, Schubkarre,
Vorratstrichter, Abraumhalde. Intakter fester Fels: der Löffel kratzt
(Wirkung 0), Geröll 90 %, Zement 55 %. **Hydraulikhammer**: jeder Schlag reißt
festen Fels an vier Punkten mit der Phase-8-Bruchlogik (`strikeStone`, kein
zweites Felssystem), Felsbrocken nehmen 5 Schadenspunkte; danach nimmt der
Löffel das Geröll. Steigung max. 28°,
Absatz max. 38°, keine Decks / Gebäude. Handy: Steuerkreuz + SCHAUFELN /
KIPPEN / AUSSTEIGEN. Die Ketten drücken beim Fahren ihr Profil in den Boden
(`TrackMarks`: fester Pool von 200 Instanzen, die ältesten werden ersetzt;
abgegrabener Boden nimmt sie mit; kosmetisch, nicht gespeichert).

**Schubkarren-Handling** (menschliche QA nach Prompt 8: zu langsam, schwer zu
lenken, Kurven zäh). Regel: *schwer ≠ schlecht steuerbar.* Gewicht zeigt sich
über Anfahren, Bremsweg, Steigung und Rückmeldung – nicht über die Lenkung.

- Lenken = gewünschte Richtung (`HANDLING` in `goldrush-wheelbarrow-controller.js`):
  A / D und der Blick. Bis 0,1 rad Blickabweichung bleibt die Karre ruhig,
  darüber zieht sie progressiv (`2,4·e + 5·e²` rad/s); im Rollen richtet sie
  sich sanft auf die Blicklinie aus (kein Schräglaufen). Im Stand ohne
  Fahrbefehl darf man sich umsehen: Ruhezone 0,35 rad, darüber folgt sie
  halb so stark.
- Kurvenradius wächst mit dem Tempo (`0,7 m + 0,45 s · v`); langsam schwenken
  die Griffe um das Rad (kein Drehen auf der Stelle um die Mitte). Die Drehrate
  baut sich mit 10 − 4·Last rad/s² auf.
- Anfahren 3,2 − 1,5·Last m/s², Bremsen 5,2 − 3,0·Last; Endtempo voll 0,72
  statt 0,66 × Gehtempo (der Benchmark rechnet mit derselben Formel).
- Gelände: Kanten bis 10 cm (statt 6) rollt sie hinauf, die Steigung wird über
  0,6 m gemessen (ein Klumpen ist kein Hang), Rauheit kostet höchstens 10 %
  Tempo (statt 22 %).
- Rückmeldung: Griffe tauchen beim Anfahren ab und heben sich beim Bremsen
  (`surge`, stärker voll), die Ansicht
  nickt leicht beim Anfahren / Anhalten (nicht bei reduzierter Bewegung),
  ein voller Rahmen knarzt und rumpelt (`barrow_load`).

| leer / 50 % / voll | Phase 8 | Phase 9 |
|---|---|---|
| Endtempo eben | 3,14 / 2,69 / 2,24 m/s | 3,17 / 2,81 / 2,45 m/s |
| 0 → 90 % Tempo | 1,07 / 1,33 / 2,03 s | 0,95 / 1,08 / 1,30 s |
| Bremsweg aus dem Endtempo | 1,05 / 1,12 / 1,48 m | 1,05 / 1,13 / 1,36 m |
| 90°-Kurve in Fahrt (A / D) | 1,37 / 1,57 / 2,27 s | 1,15 / 1,27 / 1,42 s |
| 90°-Kurve per Blick (45°) | 1,55 / 1,60 / 2,27 s | 1,15 / 1,27 / 1,42 s |
| Lenk-Latenz (halbe Drehrate) | 0,10 / 0,13 / 0,23 s | 0,07 / 0,07 / 0,08 s |
| Kleinster Radius bei 1 m/s | 0,80 / 0,91 / 1,33 m | 0,90 / 1,05 / 1,25 m |
| 8 % bergauf | 3,00 / 2,49 / 2,00 m/s | 3,03 / 2,59 / 2,18 m/s |

(`measureHandling()` – der Controller auf ebenem Boden bzw. 8 % Steigung mit
festen Eingaben; Phase 8 mit demselben Verfahren am alten Controller.) Im
Spiel: volle Karre über Abbaudellen von 5–10 cm ohne Stillstand (≥ 2,3 m/s),
der Blick 0,5 rad (≈ 29°) zur Seite → 96° Kurve in 1,5 s; rückwärts aus der Parkbox 1,3 m in 2,5 s. DevTools → „Schubkarre –
Handling-Kurs (9)“ (`goldrush-barrowcourse.js`): Hütchen für Gerade, 90°-Kurve,
S-Kurve, Abbauspuren und Parkbox auf freiem, ebenem Boden, dazu ein milder Hang
am Bergfuß; Ladung leer / 50 % / voll; „Handling-Messwerte“ zeigt die Tabelle
oben. Nicht gespeichert.

**Bewegung mit Gewicht** (rein visuell; Phasendauern, Banddurchsatz und
Trommelleistung unverändert): der Oberwagen schwenkt mit Trägheit (beschleunigt
mit 3,2 rad/s² auf 1,35 rad/s und bremst rechtzeitig ab, kein Einrasten); beim
Einrollen beißen die Zähne zuerst (langsamer Beginn, Zittern im Boden), die
Last zieht den Ausleger beim Anheben kurz nach unten, nach dem Kippen federt er
nach (gedämpft). Das Band läuft in ~1 s an und rollt aus, Rollen und
Bandtextur folgen; die Trommel dreht in ~1,5 s hoch und läuft aus, ihr Rahmen
vibriert im Betrieb leicht (mehr unter Last); das Wasser sprüht nur, solange
sie dreht.

**Speicherstand v8:** `geology`, `prospect` (Beutel, Buch, Fähnchen),
Förderband (Modus, Trichter-Batch, Bandzellen), Trommel (Zulauf,
Überkorn-Batch), Halde, Bagger (Position, Richtung, Pose, Werkzeug,
Löffel-Batch). Laden mitten in der Kette, mitten im Baggerschnitt (Löffel im
Schnitt) und mitten im Felsbrechen (die ersten Risse) ist exakt – Material,
Gold, Risse, Pose; die laufende Armbewegung beginnt aus der gespeicherten Pose
neu (Schnitt und Kippen sind atomar, es geht nichts doppelt oder verloren).
Neue Mine: alles leer, Geologie 2. Der Dev-Snapshot einer mechanisierten Mine
kommt exakt zurück (Test).

**Ledger:** jeder neue Halter (Aufgabetrichter, Bandzellen, Trommel-Zulauf,
Überkorn, Löffel, Probenbeutel) steht in `goldInContainers` /
`massInContainers`; Halde = Tailing. `inUg = Behälter + gewonnen + Tailing`
gilt über die volle Kette (Test `chain`: Bagger → Aufgabetrichter → Band →
Trommel → Vorratstrichter → Dosierer → Rinne → Konzentrat → Pfanne → Beutel,
zwei Save / Reloads unterwegs; jedes Einzelstück genau einmal – 132 von 132).

**Welt / Look / Audio:** Aufschüttung mit Fahrspuren vor dem Camp, nasser
Boden unter Trommel und Vorratstrichter (wird mit der Laufzeit dunkler),
Kettenabdrücke des Baggers, Diesel-
Generator mit Kabel zum Posten, Bandgerüst mit Tragrollen, Ober- und
Untertrum, Antrieb mit Schutz am Kopf, Trommel auf Laufringen und
Tragrollen, Sprühbalken mit Zuleitung vom Tank, Unterkorn-Vorhang,
Überkorn-Rutsche; Werkzeugständer mit Hammer beim Bagger. Synthetische Klänge: Band,
Trommel (läuft / leer), Diesel, Ketten, Hydraulik, Löffel, Kippen, Hammer,
Start / Stopp.

**Leistung** (`goldrush_mechanized_e2e.py --only perf`): Mine mit Anlage und
Bagger 175 Draw Calls, Anlage 129, Aufgabetrichter 93, Kabine 101 – 59–60 fps;
Bagger nach Merge pro Gelenk 25 Draw Calls; Maschinen-Wurzeln (auch Spuren und
Nässe) in `warmMachines` (GPU-Warm-up) – beim ersten Anblick keine neue
Geometrie / Textur / kein neues Programm. Band, Trommel und Spuren arbeiten mit
festen Instanz-Puffern (keine Objekte pro Tick).

**Dev-Pack 9** (`goldrush-devcommands9.js`): Preset **„PHASE 9 MECHANIZED
CLAIM“** (alle Phase-9-Items, Anlage gebaut, Band auf AUTO, Bagger am
Trichter) und Sprünge PROSPECTING TEST, MINE INTAKE, PROCESSING PLANT,
EXCAVATOR, RICH CHANNEL, NORMAL MOUNTAIN, CONTRACT BOARD, dazu „Bagger mit
Hydraulikhammer“ (steht an freiliegendem Fels) und „Abraumhalde“; Trichter
voll / leer, „Kette blockieren“ (Vorratstrichter voll, Dosierer STOP),
Überkornhaufen, Baggerlöffel voll; Info „Anlage & Bergauftrag“.

**Benchmark** (`goldrush_bench.py --strategy A9…E9`, simulierte Zeit, 1500 min):
A9 Auftrag zuerst, B9 Prospektor, C9 Geld zuerst, D9 ausgewogen, E9 Camp-Farmer.

Finaler Lauf: 40 Seeds je Strategie (1001 + 7k), Stand 3f48b91, 200 × 1500 min
in simulierter Zeit. Kaufzeit-Median in Minuten (P10–P90; gekauft von 40, wenn
nicht alle):

| Strategie | Förderband | Trommel | Hochleistungsrinne | Bagger | Hammer |
|---|---|---|---|---|---|
| A9 | 647 (580–698) · 39 | 796 (703–885) · 39 | 1211 (1078–1295) · 33 | 1086 (965–1223) · 39 | 1331 (1203–1432) · 32 |
| B9 | 797 (700–912) | 893 (798–1007) · 38 | 954 (851–1034) · 38 | 1063 (977–1139) · 38 | 1226 (1100–1327) · 37 |
| C9 | 1070 (949–1338) · 34 | 1164 (1051–1420) · 32 | 1173 (1076–1318) · 30 | 1257 (1177–1377) · 26 | 1398 (1297–1477) · 19 |
| **D9** | **744 (653–826)** · 39 | **875 (774–970)** · 39 | **954 (845–1064)** · 39 | **1044 (935–1161)** · 39 | **1168 (1071–1267)** · 34 |
| E9 | 913 (698–1277) · 31 | 1110 (873–1419) · 29 | 1129 (917–1422) · 28 | 1189 (988–1376) · 16 | 1324 (1172–1466) · 15 |
| Ziel | 650–780 | 760–900 | 820–980 | 850–1050 | 1050–1250 |

Frühe Ausrüstung (alle Strategien ähnlich): Pfanne 82–113, Schubkarre
158–198, Classifier 190–232, Rinne 255–318, Vorratstrichter 385–484,
Dosierer 493–600 min.

| Median | 660 min | 900 min | 1200 min | 1500 min |
|---|---|---|---|---|
| D9 verdient | € 5.018 | € 7.845 | € 13.465 | € 19.406 |
| D9 Berg | 1,14 % (12,4 m³) | 1,62 % | 2,54 % (27,9 m³) | 3,61 % (39,4 m³, 57,5 t) |
| A9 Berg | 1,15 % | 2,06 % | 4,59 % | 8,00 % (88,1 m³, 135 t) |
| B9 / C9 / E9 Berg | 0,68 / 0,23 / 0,65 % | 1,14 / 0,61 / 0,93 % | 2,08 / 1,24 / 1,31 % | 3,09 / 2,14 / 1,83 % |
| D9 gewaschen / Rinne / Band / Trommel | 9.072 / 3.944 / 0 / 0 l | 13.835 / 6.837 / 1.973 / 364 l | 22.816 / 15.023 / 11.517 / 9.998 l | 32.416 / 24.615 / 22.892 / 21.262 l |

- Strategien gepaart je Seed (verdient bei 1500 min / D9): B9 1,11× (vorn auf
  33 / 40 Seeds) – wer reiche Rinnen sucht und findet, verdient mehr; C9
  0,92×, A9 0,77× (räumt dafür 2–3× so viel Berg ab: bis 8 % nach 25 h),
  **E9 (Camp-/Boden-Farmer) 0,85×, bester Verdiener auf 3 / 40 Seeds** – die
  Ebene vor dem Camp ist keine Goldfarm mehr. Einkommen D9: 11,8 €/min
  (600–900 min) → 20,1 €/min (1200–1500 min) mit den Maschinen.
- Der Berg bleibt riesig: nach 20 h 1,2–4,6 %, nach 25 h 1,8–8,0 %
  (Strategie-Median), D9 3,6 %.
- Maschinen (gemessen): Schaufel 91 l/min, Bagger 474 l/min (5,2×), Band
  64 l/min Nennleistung, Trommel 60 l/min Rohzulauf, Hochleistungsrinne
  32 l/min. Im Benchmark liefen Band / Trommel bei 1500 min 83–95 % ihrer
  Laufzeit im Rückstau und 0–5 % leer, das Unterkorn floss mit ~30 l/min:
  **Engpass ist die Rinne** (32 l/min) – Bagger und Band liefern mehr, als die
  Waschanlage schafft; der Rest geht (A9) auf die Halde oder der Bagger wartet
  (D9 Median 6 h Wartezeit über 25 h). Genau das ist der Ansatz für die nächste
  Stufe (größere Waschanlage).

**Tests:** `tests/e2e/goldrush_mechanized_e2e.py` (`--only geology,prospect,
contract,conveyor,trommel,excavator,chain,save,dev,handling,perf,mobile,shots`;
die 24 Pflichtansichten aus Abschnitt 30 des Prompts plus Zusatzansichten mit
`--shots DIR --tag NAME`; `--browser webkit` ohne perf / shots / mobile).


## GoldRush 9.1 – Gold-Audit und Prospektions-Reset

Human-QA nach Phase 9: „seit Geologie 2.0 findet man nur noch einen Bruchteil
des Goldes“. Bewiesen statt geraten – mit `tests/e2e/goldrush_gold_ab.py`:

* **`geology`**: Das `MaterialField` von PRE-P9 (`9aec716`, über eine
  Playwright-Route geladen) wird auf **demselben Terrain-Objekt** gebaut wie das
  aktuelle. Beide lesen exakt dieselben Säulen und Scheiben. Pro Zone 1600
  Proben à 10 l (2 × 2 Säulen × 16 Scheiben) über 40 Seeds, dazu das
  Claim-Budget jeder 2. Säule.
* **`early`**: **Derselbe** Bot (der Bench-Bot von `9aec716`, Strategie M:
  Hand → Schaufel → Eimer → Pfanne) spielt 120 min auf beiden Ständen, minütlich
  abgefragt. Gestartet wird am normalen Startbereich oder neben dem Waschplatz.

**Was passiert war (P9 gegen PRE-P9, identische Voxel, € pro 10 l Gesamtgold):**
Es wurde **kein** Gold gelöscht. Das Budget ohne Camp lag bei 1,25×, erreichbar
(Berg + offener Boden) bei 1,52×, im Berg bei 1,90×. Der Starter-Hang lag bei
1,17×, der Berg bei 1,7–2,2×, sichtbare Stücke im Berg bei 2×. Das frühe Spiel
am normalen Start war gleichauf (1,00–1,03×), ebenso die sichtbaren Funde und
die längste Pause ohne sichtbares Stück.

Den „Bruchteil“ gab es an genau einer Stelle: im **Boden neben Camp und
Waschplatz** – dem bequemsten Grabplatz und in PRE-P9 dank der Pay Layer der
reichste Oberflächenboden der Karte:

* oberste 30 cm: **€16,07 → €0,35 / 10 l (2 %)**, sichtbare Stücke 0,72 → 0,02
* derselbe Bot neben dem Waschplatz: **0,40× (30 min)**, 0,66× (60 min),
  0,63× (120 min)
* längste Pause ohne jedes Stück: 1 → 7 min

Dazu kam der Verlust des „überall auf Bodenhöhe reich“: die oberen 30 cm des
flachen Claims lagen bei 0,79×. Das war Absicht (Ground Zero ist kein Jackpot
mehr), wurde aber nirgends erklärt.

**Kalibrierung 9.1** (`GEOLOGY_VERSION 3`):

* **Der Berg wird gewöhnlicher Boden.** `mf 0,88 / 1 / 1,15 → 0,97 / 1 / 1,04`:
  Die Erde der Flanken ist nicht mehr viel ärmer als der Kies der Ebene, das war
  ein Rest des alten Bodenniveau-Vorteils. Dazu `mountain 0,94 → 0,98` und
  `deep 0,2 → 0,06`; der Tiefenbonus machte die zuerst gegrabene Oberfläche zur
  ärmsten Schicht.
* **Ergebnis gegen normalen Claim-Boden** (ohne Rinnen, Streaks, Taschen):
  oberer Berg 1,00×, untere Flanken 0,88× (vorher etwa 0,8×).
* **Starter-Band:** `STARTER.gMax 0,29 → 0,23`. Ohne diese Grenze hätte die
  angehobene Oberfläche das frühe Spiel um +54 % (30 min) verschoben.
* **Camp-Aufschüttung:** unverändert wertlos, sie wird jetzt aber **gesagt**.
  Der erste Stich in die Aufschüttung meldet einmal pro Mine „Aufgeschütteter
  Lagerplatz – verdichteter Fremdboden, kaum Gold; gewachsener Boden etwa einen
  halben Meter tiefer; der Berg lohnt sich“ (`economy.flags.fillSeen`, wird
  gespeichert). Danach kommt höchstens alle 2 min ein kurzer Tipp.
* **Bestehende Minen:** Eine Geologie-2-Mine folgt still Geologie 3. Verbrauchte
  Scheiben bleiben verbraucht, Behälter behalten ihr Gold.

| PRE-P9 → 9.1, € / 10 l (alles Gold) | PRE-P9 | P9 | **9.1** | sichtbare Stücke / 10 l (PRE → 9.1) |
|---|---|---|---|---|
| Starter-Hang | 8,37 | 9,82 | **9,67** | 0,32 → 0,38 |
| unterer Berg (0,4–2 m) | 5,34 | 9,18 | **10,04** | 0,20 → 0,41 |
| oberer Berg (> 2 m) | 5,24 | 11,50 | **11,79** | 0,20 → 0,45 |
| zufällige Bergpositionen | 6,16 | 10,94 | **11,16** | 0,23 → 0,45 |
| Claim-Boden (oberster Meter) | 14,08 | 13,31 | **13,27** | 0,60 → 0,56 |
| alter Ground Zero / Camp (oberster Meter) | 14,76 | 6,63 | **6,55** | 0,62 → 0,28 |
| … davon oberste 30 cm (Aufschüttung) | 16,07 | 0,35 | **0,35** | 0,72 → 0,02 |
| Paläorinne arm / mittel / reich | – | 22,9 / 34,1 / 52,2 | **21,6 / 32,8 / 50,8** | 1,1 / 1,9 / 4,1 |
| Streak-Kern / Tasche | 15,1 / 20,5 | 25,6 / 38,5 | **25,7 / 38,2** | 1,9 / 2,6 |

Claim-Budget 9.1 gegenüber PRE-P9 (€ pro m³):

* alles ohne Camp: 976 → **1205 (1,23×)**
* Berg: 596 → 1145
* offener flacher Boden: 1259 → 1215
* unter dem Berg: 1937 → 1394
* Camp: 1422 → 644

Das Budget liegt bewusst über „neutral“. Gut 60 % des PRE-P9-Goldes lagen in
der Pay Layer auf Bodenhöhe, der Berg hatte 596 €/m³. Ein Rückschnitt auf das
PRE-P9-Budget hätte den Hauptauftrag (den Berg) wieder ärmer gemacht als das
frühe Spiel.

Frühes Spiel, derselbe Bot am normalen Start, Median über 40 Seeds:

| Spielzeit | € PRE-P9 → 9.1 | Verhältnis |
|---|---|---|
| 30 min | 29,5 → 34,9 | 1,21× |
| 60 min | 114 → 125 | 1,16× |
| 120 min | 348 → 371 | 1,10× |

* sichtbare Stücke: 1,24× / 1,03× / 1,04×
* Gold pro Pfanne: 1,04× (60 min), 1,12× (120 min)
* Gold pro Eimer: 1,04× (60 min), 1,10× (120 min)
* längste Pause ohne sichtbares Stück unverändert (5–6 / 12 min)
* P10 der schwächsten Seeds nach 60 min: €79 → €106

**Prospektion 9.1** (`goldrush-prospect.js`): **eine** Nummerierung.

* `F` an der Stelle einer Probe (≤ 1,2 m, auch einer schon ausgewaschenen) setzt
  **ihr** Fähnchen mit ihrer Nummer: orange, Probe 7 → Fähnchen 7, auch zwei-
  und dreistellig.
* `F` anderswo setzt ein **freies** Fähnchen: blau, Buchstabe A–L, nie eine
  Zahl.
* Eine Probe neben einem Fähnchen heißt „bei Probe 7“ bzw. „Fähnchen B“.
* Das Notizbuch zeigt ⚑ an markierten Proben und „nächste: Probe n“.
* Unten im Notizbuch stehen zwei Knöpfe:
  * **Alle Fähnchen einsammeln:** nur die Fähnchen.
  * **Prospektion zurücksetzen …** (mit Rückfrage): löscht Notizbuch,
    Nummerierung, alle Fähnchen und ihre Verknüpfungen, die nächste Probe ist
    #1. Gelände, Ledger, Bergauftrag, Geld und Goldbeutel bleiben unberührt.
    Entnommenes Material bleibt entnommen. Noch nicht ausgewaschene Beutel und
    eine Probe in der Pfanne behalten ihr Material und heißen dann Probe 1…k.
* Speicher bleibt v8: Fähnchen haben `kind` („sample“ / „free“), Notizbuchzeilen
  ihre Stelle. Fähnchen eines Phase-9-Stands laden als freie Fähnchen.

**Tests:** `tests/e2e/goldrush_hotfix91_e2e.py` (Geologie 3, Fill-Hinweis,
Fähnchen und Proben, Einsammeln, Reset, Save/Reload, wartende Beutel, Altstand,
Knöpfe und Rückfrage). Die Benchmarks laufen mit `tests/e2e/goldrush_gold_ab.py`
(`geology` / `early` / `report`).


## Arbeitsmine (Prompt 10)

Aus dem mechanisierten Claim wird eine kleine Arbeitsmine. Der Engpass von
Phase 9 (Bagger ~474 l/min, Band ~64, Trommel 60, Hochleistungsrinne 32 l/min)
wird gelöst, ohne einen größeren Bagger: **Abbau → Haufen → Logistik →
Aufbereitung → Tailings.**

```
Berg ─Bagger→ ROHHAUFEN ─Lader→ Aufgabetrichter (420 l) ─Band (~137 l/min)→ Trommel (120 l/min)
   Trommel ─Überkorn→ Überkornband → ÜBERKORNHAUFEN (Südende am Zaun) ─Lader→ Abraumhalde
   Trommel ─Unterkorn→ Vorratstrichter ─Dosierer (120 l/min)→ VERTEILERKASTEN → 3 Rinnen à 40 l/min
   Rinnen ─Konzentrat (Reinigen)→ KONZENTRATWANNE ─Eimer→ Waschtrog ─Pfanne→ Goldbeutel
   Rinnen ─Tailings→ TAILINGS-AUSLAUF ─Lader / Bagger / Karre→ TAILINGS-ZONE
```

**Haufen** (`goldrush-stockpile.js`): Jeder Ort ist ein Höhenfeld mit 25-cm-Zellen.
Material rutscht über acht Nachbarn auf den Schüttwinkel seiner Art (Rohmaterial
0,74, Überkorn 0,92, Tailings 0,14 als flacher nasser Fächer, Abraum 0,72),
jede Zelle mit eigenem Zufallsanteil. Damit entstehen breite, unregelmäßige
Haufen statt Kegel. Maßgeblich ist der `MaterialBuffer` (FIFO-Schichten): Er
hält Gold, Masse und Funde. `fit()` skaliert das Feld genau auf sein Volumen,
auch nach jedem `settle()`. Tailings- und Abraumhaufen buchen beim Ablegen auf
`tail` und beim Aufnehmen zurück in die Behälter. Rohmaterial und Überkorn zählen
als Behälter im Ledger. Gezeichnet wird als `GridLoad` (Oberfläche plus
instanzierte Brocken); die Brocken von Haufen in über 26 m Entfernung ruhen (LOD).
Die Farbe des losen Materials ergibt sich nach Volumen, nicht nach Masse.
Schaut man auf einen Haufen, steht dort z. B. „RAW PAY DIRT 6,0 m³“, ohne Goldwert.

**Radlader** (`goldrush-loader.js`, gekauft ab ~1200 min): Knicklenkung
(Kurvenrate v·sin γ / (lf·cos γ + lr)), schwerer als die Karre (Anfahren,
Ausrollen, Steigung), 260-l-Schaufel. Linksklick senkt die Schaufel. Wer in einen
Haufen fährt, füllt sie stückweise (je kräftiger geschoben, desto schneller);
voll hebt sie sich von selbst. Gewachsenen Berg gräbt der Lader nicht (eine
Wand-Erkennung stoppt die Schaufel), das bleibt Sache des Baggers. Kippen
(Rechtsklick / Q) geht über die **Empfänger-Tabelle** `receivers()`, dieselbe,
die die Schubkarre fragt: Aufgabetrichter, Rohhaufen, Tailings-Zone,
Abraumhalde. Tailings-Auslauf und Überkornhaufen sind keine Kippziele, nur
Grabquellen. Gekippt wird teilweise, wenn der Empfänger voll ist; der Rest bleibt
in der Schaufel. Die Meldung erscheint einmal pro Schaufel.

**Anlagen-Upgrades** (sichtbar, echte Zahlen):
* *Förderband-Ausbau*: zweiter Antrieb, Leitbleche, ein Aufsatz auf dem
  Aufgabetrichter. 0,62 m/s × 1,3 l pro Zelle ≈ 137 l/min, der Trichter fasst
  420 l, also passt eine volle Laderschaufel.
* *Trommel-Ausbau*: zweiter Antrieb und Sprühbalken, 120 l/min; die Trommel
  dreht sichtbar schneller.

Die Upgrade-Teile werden mit den Maschinenteilen pro Material zusammengebacken
und kosten keinen Draw Call extra.

**Überkornband**: Die Trommelrutsche fällt auf ein kurzes Band, das am Zaun
entlang nach Süden läuft. Sein Kopf wirft das Überkorn am Südende des Streifens
ab, also dort, wo der Lader von der offenen Zone B hineinfährt. Reicht der Haufen
bis an den Kopf (1,65 m), steht das Band; ist sein Aufgabestück voll, wartet die
Trommel. Ein Phase-9-Überkornpuffer landet beim Laden am neuen Abwurfpunkt.

**Waschanlage** (`goldrush-washplant.js`): Die Hochleistungsrinne wird die erste
von drei breiten Rinnen. Ein Verteilerkasten (150 l) über den Köpfen ersetzt
ihren kleinen Trichter; der Dosierer öffnet auf 120 l/min. Der Kasten verteilt
reihum auf die Rinnen, die frei sind. Jede Rinne schafft 40 l/min, hält etwa
**77 % des Feingolds** und jedes Stück. Mit dem Recovery-Ausbau (Streckmetall
über Moosmatten, sichtbar) sind es 84 %. Überladene Matten halten weniger.
Reinigen (Wasser aus) bürstet alle drei Matten zugleich aus: Nuggets gehen in den
Beutel, das schwarze Konzentrat (Massenanteil 0,4 %) in die **Konzentratwanne**
an der Anlage. Von dort holt man es mit dem Eimer, trägt es zum Waschtrog und
wäscht es als Schwerkonzentrat in der Pfanne. Die Anlage zahlt nichts selbst aus.
Rinnen-Effekte (Wasser, Auslaufschleier, Schaum, Kies, Konzentratschicht) sind
für alle drei Rinnen je ein Mesh; die zweite und dritte Rinne sind statisch
zusammengebacken.

**Tailings und Rückstau** (Human-QA C): Jede Rinne wirft ihre Tailings über ihr
Ende auf den Auslauf-Haufen. Reicht der Haufen bis ans Rinnenende (0,6 m), wartet
die Rinne. Die Hysterese hält sie zu, bis gut 12 cm geräumt sind. Warten alle
Rinnen, füllt sich der Kasten, der Dosierer stoppt, der Vorratstrichter läuft
voll, die Trommel wartet, das Band steht. Es geht nichts verloren. Der Auslauf
fasst etwa 6 m³ (Rinne allein: rund 3 h bei 32 l/min; Waschanlage: gut 1 h).
Geräumt wird mit dem Lader (≈ 26 s pro 260 l auf die Tailings-Zone), dem Bagger
oder der Schaufel in die Karre.

**Bergseiten-Abbaugerät** (`goldrush-autominer.js`, Modell `goldrush-autominermodel.js`):
die erste Maschine, die den Berg selbst abbaut. Manueller Abbau → Bagger →
stationärer automatischer Abbau.
* **Ein fester Abschnitt statt Idle-Automation:** Das Gerät steht am Fuß der
  Flanke und arbeitet nur einen Kasten vor sich ab: 2,4 m breit, 1,5–3,4 m
  voraus, bis 2,0 m über seinem Boden, nie darunter. Es nimmt von oben nach unten
  zuerst den höchsten erreichbaren Punkt und arbeitet sich so stufenweise in die
  Flanke. Die Flanke darüber rutscht im Schüttwinkel nach (Terrain-Physik wie
  beim Bagger, sichtbare Arbeitsfront). Darum hat jeder Stand ein Budget:
  Abschnittsvolumen beim Aufstellen × 1,3. Danach meldet es **ABBAUBEREICH
  ERSCHÖPFT** und muss versetzt werden.
* **Aufstellen:** gekauft steht es in der Nordwest-Ecke. Dort [E] startet den
  Platzierungsmodus: Ein Geist folgt dem Fadenkreuz auf dem Boden, zur Bergmitte
  ausgerichtet ([R] dreht in 22,5°-Schritten). Grün heißt gültig, rot zeigt den
  Grund: zu nah am Zaun, etwas im Weg, Plattform, Haufen, zu steil (> 14°),
  zu uneben, kein Berg im Arbeitsbereich (< 0,8 m³), nur Fels, Arbeitsbereich
  nicht frei, kein Anschluss. Klick stellt auf, [E] bricht ab. Versetzen geht
  nur im Stillstand ([E] am Heck) oder wenn der Abschnitt erschöpft ist (Pult).
  Kein freies Teleportieren.
* **Anschluss:** Das Austragsband am Heck schwenkt (±80°), ist 0,22 rad
  angestellt (Spitze ~1,9 m hoch) und wirft gut 3,1 m hinter dem Gerät ab: Der
  Aufgabetrichter muss unter der Spitze liegen (2,6–3,6 m), oder die Spitze
  zeigt auf den Rohhaufen.
  Ohne Aufgabetrichter (Förderband) oder Rohhaufen in Reichweite ist der Platz
  ungültig; die Position zählt also.
* **Takt** (Spielgefühl): Kopf fährt an und nimmt kurz zurück (Anticipation),
  Kontakt mit Ruck, Widerstand mit Vibration je Material (Kies schüttelt mehr,
  dreht langsamer), dann der Schnitt: echter Abbau über `mining().action` mit
  `MINER_DEF` – jede 1-cm-Scheibe einmal, ihr Feingold und ihre Stücke in die
  Batch des Bisses, der Bergauftrag zählt mit. Danach Nachlauf, der Biss fällt
  aufs interne Band (Staub, Brocken), Ausschwingen. ~8 l pro Biss, gemessen
  80–82 l/min Arbeitsrate (Erde schneller, Kies langsamer).
* **Rückstau:** Das interne Band (60 l) gibt mit 150 l/min in den Trichter bzw.
  auf den Rohhaufen. Ist der Trichter voll (Band, Trommel oder Waschanlage
  stehen) oder reicht der Haufen bis an die Spitze, hält das Austragsband. Das
  interne Band füllt sich, der Kopf wird langsamer und wartet („wartet –
  Austrag voll“). Nichts geht verloren. Gibt es wieder Platz, läuft es von selbst
  weiter.
* **Fels:** Intakter Fels blockiert den Kopf, Geröll (Spitzhacke, Hammer)
  nimmt er. Bleibt nur Fels: **HARTGESTEIN – ABBAUKOPF BLOCKIERT**. Kein zweites
  Gesteinssystem, es gilt die Bruchlogik aus Phase 8.
* **Kein Offline-Ertrag:** Es arbeitet nur in Frames bzw. `tickSim`, nie im
  Pausenmenü, nie bei geschlossenem Spiel.
* **Speicherstand 9:** aufgestellt ja/nein, Lage und Ausrichtung, an/aus,
  Status, Budget und schon Abgebautes, die Bandladung (MaterialBuffer im
  Ledger), Statistik. Ein Biss ist atomar.
* **Shop:** 3.000 €, freigegeben ab 3 % Bergauftrag, braucht Bagger und
  Förderband. Upgrades gibt es noch nicht; die Basismaschine geht vor.
* **Modell:** Raupen, Deck mit Hydraulikaggregat, Ausleger mit Teleskop-Stiel
  und Schneidtrommel (Pickel), internes Band, schwenkbares Austragsband. Ein
  einziges Skinned-Mesh mit Vertexfarben, jedes bewegte Teil an seinem Bone:
  1 Draw Call. Töne: Hydraulik-Brummen, Pickel-Anschlag, Schneid-Rattern,
  Abschalten.

**Sehr seltene Großnuggets** (`goldrush-resources.js` `JACKPOT`, Geologie 4):
Gewöhnliche Nuggets bleiben bei 1–4 €. Darüber gibt es vier eigene Stufen:

| Stufe | Wert | am Berg je m³ | je 35-h-Claim (110–160 m³) |
|---|---|---|---|
| Großer Nugget | 5–12 € | 0,038 | ~5 |
| Seltener Nugget | 12–30 € | 0,010 | ~1,3 |
| Außergewöhnlicher Nugget | 30–50 € | 0,0023 | ~0,3 |
| Legendärer Nugget | 50–86 € | 0,0005 | ~0,07 |

* **Echte Orte im Boden, kein Würfel pro Schlag.** Jeder 1-cm-Voxel hat einen
  eigenen Hash (Seed + Lage); ob dort ein Großnugget liegt und wie schwer er
  ist, steht fest, bevor jemand gräbt, und wird wie jede Scheibe einmal
  verbraucht. Eine zweite Geologie auf demselben Seed findet dieselben Stücke.
* **Eigene, steile Seltenheit, nicht die Golddichte.** Ein „Host“-Faktor sagt,
  wo große Stücke liegen können: Kies (1,8×), Erde (0,55×), die reichen
  Abschnitte einer Paläorinne (quadratisch mit ihrer Güte), Taschen, Streaks,
  Gangzonen, etwas tiefer etwas mehr. In der Aufschüttung des Lagerplatzes und
  im Kern der Startflanken ist er 0. Die vergrabenen Rinnen unter der Ebene
  haben etwa doppelt so viele wie der Berg.
* **Budget neutral.** Das erwartete Gold der Großnuggets eines Voxels kommt von
  seinem Feingold herunter. Gemessen mit `goldrush_gold_ab.py geology --ref HEAD`
  (20 Seeds, identische Voxel): Claim 1234,64 → 1234,64 €/m³, Berg 1173,09 →
  1172,97 €/m³. Umverteilt werden < 0,05 %.
* **Sichtbar nach Masse** (`findSize`): über 4 € wächst der Radius mit der
  vierten Wurzel des Werts – 10 € ~1,3×, 30 € ~1,65×, 80 € ~2,1× ein 4-€-Nugget.
  Klar größer, kein Comic-Klumpen. Die Pfanne (Blick aus ~30 cm) zeigt Nuggets
  als eigene Klumpen in 0,65facher Größe, die großen mit Quadratwurzel.
* **Fundmoment je Stufe** (`engine._bigFind`), egal wo das Stück herauskommt
  (Boden, Pfanne, Sieb, Matten, Trommelfalle):
  * 5–12 €: der Nugget-Klang etwas voller, ein etwas größerer Glanz.
  * 12–30 €: ein eigener kurzer Klang (zwei warme Glockentöne).
  * ab 30 €: ein kurzer Stinger (vier steigende Glockentöne über einem warmen
    Grundton), dezenter Goldrand am Hinweis, **„Großer Goldfund – € XX“**.
  * Aus dem Boden länger hochgehalten (1,35× / 1,8×). Kein Blitz, keine Münzen,
    kein Lichtquellen-Effekt.
* **Verarbeitung.** Pfanne und Sieb behalten jedes Stück. Rinne und Waschanlage
  halten jedes Stück in den Riffeln; Reinigen pickt es in den Beutel. Die
  **Trommel** hat 40-mm-Löcher (wie gezeichnet): Ein Nugget ab ~10 €
  (`SCREEN_CATCH_UG` 100.000 µg) passt nicht durch. Er läuft ans Trommelende und
  fällt in die **Nuggetfalle**: ein vergitterter Kasten in Brusthöhe unter der
  Rutsche (`TRAP`), nie auf den Überkornhaufen. Hinweis „Nuggetfalle an der
  Trommel“ plus ein dumpfes Klonk. Dort `[E] Nuggetfalle leeren` → Beutel.
* **Ledger, genau einmal.** Jedes Stück behält seinen Schlüssel (Voxel bzw.
  `dev:…`). Die Falle zählt als Halter der Trommel im Ledger und im
  Speicherstand (`processing.trommel.trap`). Teilübergaben bewegen Stücke nur
  ganz. Gezählt werden Statistiken je Stufe (`economy.stats.bigNuggets`,
  `bigNuggetCents`) beim Weg in den Beutel.
* **Geologie 4:** Minen von Geologie 2 und 3 laufen ohne Hinweis weiter.
  Unberührter Boden folgt der neuen Verteilung, Gegrabenes und Behälter bleiben
  genau so.

**Die Mine im Gebrauch** (geordnete Bereiche statt Maschinen im leeren Sand):
* Abbau am Berg, Rohhaufen davor, Aufgabe an der Bergflanke, Waschanlage am
  Tank, Tailings-Auslauf und -Zone östlich davon, Überkorn am Westzaun, der
  Abstellplatz des Laders nördlich vom Rohhaufen.
* **Reifenspuren**: Die vier Räder des Laders drücken alle ~0,45 m ihr Profil in
  den Boden (Chevron-Stollen, ein fester Pool von 480 Abdrücken, ein Draw Call).
  So entstehen Fahrspuren genau dort, wo man fährt: Abstellplatz → Rohhaufen →
  Aufgabe, Auslauf → Tailings-Zone. Wo sich der Boden ändert (gegraben,
  aufgeschüttet, geräumt), verschwinden die Abdrücke. Sie werden nicht gespeichert.
* **Abstellplatz**: festgefahrener Boden mit den beiden Fahrrinnen und einem
  Ölfleck unter dem Motor; ein flaches Decal außerhalb des Grab-Quadrats (kein
  Collider, keine Höhe).
* **Nasse Bereiche**: an den Rinnenenden, am Verteilerkasten und unter der
  Konzentratwanne, sobald die Waschanlage steht; unter Trommelrutsche und
  Überkornband (die gewaschenen Steine tropfen), sobald die Trommel steht. Sie
  gehören zu den nassen Gruppen der Rinne, also kein Draw Call extra.
* Rohre, Stützen, Pfade und Karrenspuren aus Phase 7–9 bleiben.

**Spielgefühl und Ton**:
* Schieber, Wasserventil, Band- und Dosiererhebel: Die rechte Hand lässt das
  Werkzeug kurz los, greift hin und kommt zurück (0,6 s). Das Werkzeug bleibt
  derweil in der linken Hand.
* Lader: Diesel mit Turbo-Pfeifen unter Last, große Stollenreifen auf Kies, die
  Schaufelkante beim Einstechen.
* Waschanlage: drei Rinnen Wasser und ein plätschernder Kasten, räumlich gedämpft
  und nicht dauerhaft laut.
* Sprung und Landung: Stiefel auf Kies.

**Human-QA** (nach 9.1):
* **A** Schubkarre rückwärts: 60 % des Vorwärtstempos, eigene Beschleunigung,
  lenkt rückwärts, auch voll.
* **B** Ein Kipp-Pfad für alle Trichter (Verteilerkasten / Rinnentrichter,
  Vorratstrichter auf der Rampe, Aufgabetrichter an der Bergflanke) über
  `receivers()`, Teiltransfer exakt.
* **C** siehe oben.
* **D** Shop-Stufen:
  * Schaufel: großes Blatt (+28 %, sichtbar größer), verstärkte Kante, Eschenstiel,
    Profi-Schaufel (Glasfaserstiel), zusammen etwa +52 %.
  * Zinkeimer 19 l.
  * Schubkarre: Kugellager & Gummigriffe, breiter Luftreifen, Aufsatzbretter (110 l).
  * Ein Upgrade darf andere voraussetzen (`requires.upgrades`).
* **E** Springen (Leertaste; die undokumentierte Tastatur-Grabfunktion auf
  der Leertaste entfällt):
  * etwa 38 cm, 60 ms Ansatz, wenig Luftkontrolle (Schwung bleibt), schwereres Fallen
  * Landung mit Knick der Sicht und Tempoabzug, 0,32 s Ruhe danach (kein Bunny-Hop)
  * nur vom Boden aus, kein Doppelsprung
  * nicht mit der Karre, nicht in Maschinen, nicht bei der Arbeit; ein Tastendruck
    dort wird verworfen, nicht aufgehoben
* **F** Sieb und Matte haben die Phasen Geste → Ausklingen → Ergebnis → [E] →
  wieder Blick. Mausbewegungen in der Zwischenzeit werden verworfen, danach
  0,2 s stumm, also kein Kamerasprung.
* **G** Der Prospektions-Reset aus 9.1 bleibt (Test).

**Kauf-Reihenfolge und Freigaben** (Tafel: zwei Spalten mit sieben Stufen):

| Kauf | Preis | Freigabe |
|---|---|---|
| Radlader | 2.800 € | Bagger, 2,3 % Bergauftrag |
| Förderband-Ausbau | 1.600 € | Förderband und Radlader |
| Trommel-Ausbau | 1.800 € | Trommel und Radlader |
| Waschanlage | 3.200 € | Trommel, Radlader, Hochleistungsrinne |
| Bergseiten-Abbaugerät | 3.000 € | Bagger, Förderband, 3 % Bergauftrag |
| Streckmetall-Riffel & Moosmatten | 9.500 € | Waschanlage, 8 % Bergauftrag |

**Speicherstand 9**: Haufen (Höhenfeld als Int16-RLE mit Raster-Prüfung, Buffer,
Statistik), Radlader (Lage, Arme, Schaufel), Waschanlage (Rinnen-Riffel, Last,
Wanne), Überkornband und Upgrades, das Abbaugerät, die Nuggetfalle der Trommel,
die Großnugget-Statistik. Ein v8-Stand lädt seinen Überkornpuffer und die
Abraumsummen auf die Haufen, nichts wird doppelt gebucht.

**Entwicklertools** (`goldrush-devcommands10.js`):
* Preset **PHASE 10 WORKING MINE** und die Orte LOADER COURSE, RAW STOCKPILE,
  PROCESSING PLANT, TAILINGS, EXCAVATION FACE, CAMP OVERVIEW.
* Füllstände: Lader leer / voll, Rohhaufen klein / groß / arm / reich, Überkorn,
  Waschanlage läuft / blockiert, Konzentrat bereit, Auslauf niedrig / voll,
  Tailings-Zone, volle Karre.
* Volle Karre vor jedem Kippziel, Rückwärtskurs.
* Sieb- und Mattenergebnis, alle Werkzeug-Upgrades an / aus, Sprungtest und
  Sprung-Messwerte, „Kette & Engpass“ (l/min, wartet / leer in %).
* Gruppe **Abbaugerät (10)**: ABBAUGERÄT, besitzen (geparkt), gute Bergflanke,
  Material auf dem Band, Rückstau, Hartgestein, Abschnitt fast erschöpft,
  versetzen.
* Gruppe **Großnuggets (10)**: ein gewöhnlicher Nugget (2,50 €) und 10 / 30 /
  50 / 80 € – im Boden am Fadenkreuz (einmal graben), im Aufgabetrichter (ab
  10 € landet er in der Nuggetfalle), im Eimer am Waschplatz (Pfanne / Sieb),
  direkt in der Falle; der Blick auf die NUGGETFALLE; die Statistik je Stufe.

Das beweist den lokalen Produktionspfad, nicht das Live-Rendering auf Render.com.

**Performance**:
* Die ganze Mine im Blick (Waschanlage läuft, Lader, Haufen, Band, Trommel,
  Überkornband): Ziel unter 250 Draw Calls; gemessen 244 bei 60 fps (p95
  16,7 ms), Handy (emuliert) 170 Draw Calls bei 60 fps.
* 16 s Arbeitsbetrieb (Anlage läuft, Lader fährt): Geometrien, Texturen,
  Programme und JS-Heap bleiben gleich. Reifenspuren sind ein fester Pool, das
  Pad ein Decal, die nassen Flächen stecken in den Gruppen der Rinne.
* Zusammengebacken werden die Schubkarre (17 → 6), der Dosierer, die Lader-Achsen
  (je beide Räder in einem Mesh) und die Rinnen der Waschanlage.

**Benchmark** (`goldrush_bench.py --strategy A10…E10 --minutes 2100`, simulierte
Zeit): A10 Auftrag zuerst, B10 Prospektor, C10 Betreiber (Lader und Anlage gleich
nach dem Bagger), D10 ausgewogen, E10 Geld zuerst (jedes kleine Upgrade vor den
Maschinen).

**Stand Early Release (09.10.):** Die Zahlen unten stammen aus dem Lauf **vor** dem
Bergseiten-Abbaugerät und den Großnuggets. Der finale A10–E10-Lauf mit beiden
(40 Seeds × 2100 min) wurde für das Release nach 18 Seeds angehalten und wird
zusammen mit der vollen Regression nachgeholt. Das Budget der Großnuggets ist
separat gemessen (Gold-A/B, oben).

Finaler Lauf: 40 Seeds je Strategie (1001 + 7k), 200 × 2100 min. C10 Block 0
brach nach einem Browser-Timeout ab und wurde nachgerechnet; fünf seiner Seeds
weichen dabei ab (1006 + 7k), deshalb ist C10 nur auf 35 Seeds gepaart.
Kaufzeit-Median in Minuten (P10–P90; gekauft von 40, wenn nicht alle):

| Strategie | Radlader | Förderband-Ausbau | Trommel-Ausbau | Waschanlage | Recovery-Ausbau |
|---|---|---|---|---|---|
| A10 | 1399 (1279–1546) · 39 | 1468 (1335–1625) · 39 | 1531 (1417–1690) · 39 | 1667 (1524–1837) · 38 | 1786 (1639–1964) · 37 |
| B10 | 1318 (1204–1407) | 1354 (1246–1438) | 1413 (1292–1504) | 1532 (1379–1642) | 1883 (1789–2004) · 38 |
| C10 | 1179 (1129–1360) | 1219 (1131–1442) | 1292 (1159–1509) | 1410 (1262–1605) · 38 | 1786 (1682–1899) · 37 |
| **D10** | **1261 (1157–1471)** | **1327 (1181–1505)** · 39 | **1401 (1238–1569)** · 39 | **1541 (1347–1675)** · 39 | **1827 (1738–1916)** · 36 |
| E10 | 1655 (1458–1825) · 34 | 1665 (1486–1881) · 34 | 1667 (1511–1903) · 33 | 1766 (1628–2009) · 32 | 2056 (1993–2090) · 9 |
| alle 200 | 1327 | 1381 | 1448 | 1578 | 1833 |
| Ziel | 1200–1350 | 1300–1500 | 1300–1500 | 1450–1700 | 1700–1950 |

D10 und der Median über alle 200 Seeds treffen jedes Fenster. C10 kauft
absichtlich früh, E10 spät, A10 steckt das Geld zuerst in den Berg.

| Median | 1200 min | 1500 min | 1800 min | 2100 min |
|---|---|---|---|---|
| D10 verdient | € 14.108 | € 21.524 | € 42.400 | € 68.022 |
| D10 Berg | 2,56 % (27,8 m³) | 5,07 % (55,5 m³) | 7,77 % (84,9 m³) | 10,25 % (113,4 m³, 177 t) |
| A10 / B10 / C10 / E10 Berg | 4,73 / 2,02 / 2,92 / 1,04 % | 7,88 / 4,56 / 5,54 / 1,81 % | 10,91 / 7,10 / 8,32 / 4,33 % | 13,88 / 10,07 / 10,90 / 6,97 % |
| D10 gewaschen gesamt / davon Waschanlage | 15.359 / 0 l | 25.364 / 0 l | 50.486 / 23.410 l | 76.638 / 49.585 l |
| D10 Band | 12.349 l | 24.526 l | 53.450 l | 84.398 l |
| D10 Rohhaufen / Auslauf / Tailings-Zone / Überkorn | 0 / 2.335 / 13.450 / 1.266 l | 14.777 / 1.644 / 23.590 / 956 l | 14.545 / 2.056 / 47.380 / 1.000 l | 14.100 / 1.669 / 74.392 / 1.241 l |

- **Strategien gepaart je Seed** (verdient bei 2100 min, bezogen auf A10):
  B10 1,22×, C10 1,32×, D10 1,24×, E10 0,80×. Wer die Anlage früh ausbaut,
  verdient am meisten; wer zuerst spart, bleibt zurück.
- **Einkommen D10:** 24 €/min (1200–1500) → 70 €/min (1500–1800) → 85 €/min
  (1800–2100). Der Sprung kommt mit der Waschanlage.
- **Maschinen:**
  * Bagger 474 l/min (unverändert).
  * Band ~137 l/min, Trommel 120 l/min Rohzulauf.
  * Waschanlage 3 × 40 l/min, gemessen 101–103 l pro Laufminute. Der Bagger
    schafft damit rund das Vierfache der Anlage.
  * Lader effektiv 466–603 l pro Minute im Führerhaus (Aufgabe, Tailings,
    Überkorn).
- **Engpass ist jetzt die Waschanlage:**
  * Band 59–73 % der Laufzeit im Rückstau (Phase 9: 83–95 %), 6–11 % leer.
  * Trommel 38–63 % im Rückstau, 5–10 % leer.
  * Waschanlage nie blockiert: der Lader räumt den Auslauf 14–21-mal.
  * Der Rohhaufen hält sich bei ~14 m³ (die Haufen-Grenze des Bots), der Bagger
    wartet.
- **Goldbilanz:** in = Behälter + gewonnen + Tailings, in allen 200 Seeds auf
  0 µg genau.
- **Der Berg bleibt groß:** nach 35 h 7–14 % abgetragen (Strategie-Median),
  D10 10,3 %.

**Tests:**
* `tests/e2e/goldrush_workingmine_e2e.py` (`--only barrow,tailings,upgrades,
  jump,work,prospect,piles,loader,plant,wash,chain,save,area,miner,nuggets,dev,perf`;
  Ansichten mit `--shots DIR`; `--browser webkit` ohne perf).
* Der Produktionspfad der Entwicklertools (nur echte UI, keine Test-Hooks)
  läuft in `tests/e2e/goldrush_dev_e2e.py`.

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
3. **Der Berg ist endlich** (seit Phase 9 als Bergauftrag sichtbar und
   exakt gemessen – rund 1.100 m³ über dem alten Boden; nach 180 min sind
   < 1,5 % abgetragen, nach 660 min mit der ersten Automation ~1 %, nach
   1500 min mit dem ersten Bagger nur wenige Prozent).
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
