# GoldRush – interne Design- und Architekturnotizen

Interne Notizen für die Weiterentwicklung (Prompt 6–12). Nicht für Spieler.
Liegt bewusst außerhalb von `static/`, wird also nicht ausgeliefert.

## Module (Stand Phase 8)

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
| Loses Material in Schaufel / Eimer / Schubkarre / Sieb (Phase 8: behälterbezogen) | `goldrush-heap.js` (`GridLoad`, `bladeShape` / `bucketShape` / `trayShape` / `screenShape`, `LOOSE_MAT`) |
| Schubkarre schieben (Phase 8) | `goldrush-wheelbarrow-controller.js` (`PushController`, `PUSH`, `clampLook`) |
| Goldankauf-Bude, Ausrüstungs-Schuppen (Phase 8) | `goldrush-buildings.js` (`buildAssayBooth`, `buildSupplyShack`, `boardTexture`); Waage / Verkauf in `goldrush-stations.js` |
| Autorierte Modelle .glb / .gltf (Phase 8, optional) | `goldrush-assets.js` (`model`, `modelOr`, `instance`), `models/manifest.json`, GLTFLoader in `static/vendor/three/addons/` |
| Entwickler-/QA-Werkzeuge | `goldrush-dev*.js` (siehe unten; Phase 6 / 7 / 7A / 7B / 8: `goldrush-devcommands6.js`, `goldrush-devcommands7.js`, `goldrush-devcommands7a.js`, `goldrush-devcommands7b.js`, `goldrush-devcommands8.js`) |

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

- `goldrush-wheelbarrow-controller.js` (`PushController`): Eingabe = Wunsch
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
