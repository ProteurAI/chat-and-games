# GoldRush – aktueller Stand (Handoff)

**Stand:** 2026-10-21 · nach FP2.0B (First-Person Polish, Bewegung, Kontakt) auf dem Branch `feature/goldrush-fp2-0b` (Start `d299bde` =
Ende FP2.0A auf `feature/goldrush-fp2-0a`, Backup `backup/pre-goldrush-fp2-0b`; FP2.0A + B **nicht nach main gemergt**, main = `e9f87d3`/Earth 2.0C1).
Nächste Phase nur auf Anweisung (Roadmap: Material in Motion).

Diese Datei ist der Einstieg. Details je Phase stehen in `docs/goldrush.md` (nur den jeweiligen
Abschnitt lesen), Asset-Herkunft in `static/games/goldrush/ASSETS.md`, kommende Phasen in
`docs/GOLDRUSH_ROADMAP.md`. **Am Ende jeder Phase diese Datei aktualisieren.**

## Versionen

| Was | Wert | Wo |
|---|---|---|
| Spielstand | v9 | `SAVE_VERSION`, `goldrush-save.js` |
| Geologie | 4 (Großnuggets) | `GEOLOGY_VERSION`, `goldrush-resources.js` |
| Hügel-Generator | 1 | `TERRAIN_GEN`, `goldrush-terrain.js` (ändern nur mit Bump + Migration) |
| three.js | r176, vendored (+ GLTFLoader, BufferGeometryUtils, RGBELoader) | `static/vendor/three/` |
| Letztes Backup | `backup/pre-goldrush-fp2-0b` = d299bde | Branches `backup/pre-goldrush-*` |

## Was gebaut ist

| Phase | Inhalt | `docs/goldrush.md` |
|---|---|---|
| 1–5, 5.5 | 3D-Grundlage, Materialien, Werkzeuge, Gold ≠ Geld, Spielstände pro Konto, Waschen, DevTools | Module, Entwicklertools |
| 6–7B | Schubkarre, Rinne, Transfer-Schicht, Bunker/Aufgeber, Qualitäts- und Material-Pässe | Phase 6 / 7 / 7A / 7B |
| 8 | Premium Vertical Slice (Hände, Schubkarren-Controller, Gebäude) | Phase 8 |
| 9 / 9.1 | Mechanisierter Claim (Band, Trommel, Bagger, Bergauftrag), Gold-Audit | Phase 9, 9.1 |
| 10 / 10.0.1 | Arbeitsmine (Halden, Radlader, Waschanlage, Abbaugerät, Großnuggets), Zwischenstufen | Prompt 10, 10.0.1 |
| VO-A + Earth B0 | Licht, Post-Stack, Himmel/Dunst, PBR-Boden, Schaufelkontakt, Visual-QA | Visual Overhaul A + Earth B0 |
| Earth 2.0A | Terrain-Renderer: HeightTex + Zustandstexturen, statische LOD-Kacheln | Earth 2.0A |
| FP2.0A | Geriggte First-Person-Arme: eigenes Skinned-GLB (Handschuh + Ärmel, Finger-Clips), gemeinsame Arm-IK, prozeduraler Fallback | FP2.0A |
| FP2.0B | First-Person-Polish: neues Handschuh-Mesh (getrennte Finger, Nähte), Clips je Werkzeugphase, Kontakt auch für die Spitzhacke, Gewicht / Trägheit, Material-Polish, Motion-QA | FP2.0B |
| Earth 2.0C | Echte Felsen (CC0-Scans, Rock-Material mit Bodenkontakt), Nässe aus Quellen (Nasskarte), Dig-Detail als Kachel-Pool | Earth 2.0C |
| Earth 2.0B | Graben sichtbar: Werkzeugabdruck (DigDetail), Schnittkanten (StateTex B/A), Nachrutschen (VFX) | Earth 2.0B |

## Visual-Architektur (seit VO-A + Earth B0)

Abgeleitete Darstellungsschicht über der Simulation; nichts davon wird gespeichert.

* **Licht** (`goldrush-atmos.js`, eingefrorene Basis): Sonne 22°, HDRI „Goegap“ (CC0, lokal,
  gedreht, Sonne geklemmt, 22 % Sättigung), Shader-Himmel, Höhen- + Distanzdunst mit
  Sonnen-Inscatter, Tonkurve Khronos PBR Neutral + leichter Grade. FOV 60° (Einstellung 55–75°).
* **Post-Stack** (`goldrush-post.js`): HDR-Ziel mit Tiefe → AO aus Tiefe → Bloom → Ausgabe;
  Hände danach direkt mit derselben Kurve. `installToolClip`: Schaufelblatt wird von der Welttiefe
  geschnitten.
* **Qualitätsstufen** (`QUALITY`, `goldrush-renderer.js`, AUTO wählt):

  | Stufe | Bildweg | AA | AO | Erde |
  |---|---|---|---|---|
  | LOW (Mobil) | direkt auf den Canvas | – | – | 512 px |
  | MEDIUM | HDR + Post | FXAA | ¼ Aufl. | 1024 px (Mobil 512) |
  | HIGH | HDR + Post | MSAA 4× (Mobil 2×) + Alpha-to-Coverage | ½ Aufl. | 1024 px |

* **Earth B0** (`goldrush-earthmat.js`): fünf CC0-Schichten (Kruste, lose Erde, Lehm, Kies, Fels) als
  zwei `DataArrayTexture` (JPG, KTX2 offen); Triplanar, Höhen-Blending, eine Makrovariation.
  Materialwahl nur an der sichtbaren Oberfläche aus `GeoTex` (`goldrush-geotex.js`: MaterialField
  als 3D-Textur, Zeitscheiben-Aufbau, im Warm-up angelegt) + Vertex-Zustand (`aGeo`, `aEarth`, `aMat`)
  + `StateTex` (R frisch, G nass, B/A reserviert). Frisch ×0,78 (nie schwarz), nass ×0,66.
* **Earth 2.0A – Terrain-Renderer** (`goldrush-terrainview.js`, `TerrainView`): Die Simulation (integer `qh`,
  `DiggableTerrain.height`) bleibt die Wahrheit; gezeichnet wird aus einer R32F-HeightTex (teilt sich das
  Float32Array) und RGBA16F-Zustandstexturen (Farbe, Geo, Earth, Mat = die früheren Vertex-Attribute,
  CPU-Quelle `terrain.vis.*`). Render-Kacheln sind statische flache Gitter in Weltkoordinaten, LOD 0/1 je
  Kachel mit Naht-Stitching (21/25 m Hysterese), Schatten über `customDepthMaterial`. Ein Dig lädt ein
  Textur-Teilrechteck hoch (zwei alternierende Sätze, einmal pro Frame vor dem Zeichnen), nie Geometrie.
  Texturzugriff per Weltposition (`uTGrid`) – Grundlage für Regionen / Clipmap in Earth 2.0C.
  Details: `docs/goldrush.md` „Earth 2.0A“. KTX2 bleibt offen.
* **Earth 2.0B – Graben sichtbar** (`goldrush-digdetail.js`, `DigDetail`): feine Relief-/Footprint-Textur (~3 cm) aus
  `terrain.lastBite` gestempelt (Scoop/Pick/Hand, folgt Hängen, gebrochene Kontur, Lippe, zweimal „gesetzt“), im Shader
  als Normal/Cavity/Fresh-Maske; Schnittkante aus den Höhen (`vis.rim` → StateTex B/A); `DigEffects.slump` (Layer 5).
  Rein abgeleitet, nie gespeichert, keine Geometrie. Nicht auf LOW. Details: `docs/goldrush.md` „Earth 2.0B“.
* **Earth 2.0C** (`goldrush-rockset.js`, `goldrush-rockmat.js`, `assets/rocks/rocks.glb`): sechs CC0-Fels-Scans (3 LODs, nur Geometrie)
  ersetzen die Ikosaeder bei Pile-Boulder, Szenerie-Clustern, Outcrops, Kieseln; ein Rock-Material (Earth-Fels-Schicht triplanar,
  Geologie-Tint, Bodenkontakt aus HeightTex). `EarthSystem.setWetSources` + `WET_MAP`: weltadressierte Nasskarte aus Waschplatz/Rinne/
  Anlage, von Terrain **und** Außenboden gelesen. `DigDetail` ist ein Pool aus 6-m-Weltkacheln mit Indirektion (Speicher unabhängig von
  der Weltgröße). Details: `docs/goldrush.md` „Earth 2.0C“, Lizenzen: `ASSETS.md`. Simulation/Platzierung der Spiel-Boulder unverändert.
* **Earth 2.0C1**: Rock-LOD nach Distanz (`World.updateRocks`: Szenerie-Cluster 3 Stufen in einem Mesh per Index-Puffer, Pile-Boulder /
  Outcrops / Kiesel gruppenweise ab 13 m, LOW ab halber Distanz); Felsen lesen die Nasskarte; dunkle Gruben (Gradient-Klemme, Ambient-Floor).
* **FP2.0A** (`assets/fp/fp_arms.glb`, `goldrush-fprig.js`, `goldrush-armik.js`, `tools/goldrush/build_fp_arms.py`): eigene geriggte Arme
  (Knochenkette + Finger-/Daumen-Clips, ~6300 Dreiecke je Arm, eigene Arbeit/CC0), PBR-Material mit Lederrelief; `FirstPersonHands` bleibt der
  Pose-Geber (Grips, Kontaktausrichtung, Phasen des ToolControllers unverändert). Fallback = prozedurale Handschuhe (404/defekte GLB: Warnung).
* **FP2.0B** (`goldrush-fpclips.js`, `build_fp_arms.py`, `goldrush-hand.js`): Mesh neu (vier gespreizte Finger, runder Daumen, flache Stulpe, Lederpaneele mit
  Nähten im Shader, Ärmel olivfarben); Werkzeug-Clips = Wegpunkte je Controller-Phase (Dauern / Gameplay unverändert, jede Phase startet an der Endpose der
  vorigen); Kontakt-Ausrichtung für Schaufel **und** Spitzhacke (`CONTACT_TOOL`); Schulter-Nachgeben (`SHOULDER_SLACK`); Trägheit / Kontakt-Impuls (`MASS`,
  `_jolt`); Daumen-Winkel zentral (`THUMB`). Details: `docs/goldrush.md` „FP2.0B“.
* **QA-Cursor-Sicherheit**: in automatisierten Browsern (`navigator.webdriver`) nimmt GoldRush nie den Pointer Lock (Free-Mouse-Modus;
  `window.__GR_ALLOW_POINTER_LOCK = true` zum Testen des Locks); `tests/e2e/qa_safety.py` erzwingt Headless (`GOLDRUSH_QA_HEADED=1` nur manuell).
* **Schaufel C-lite** (`goldrush-hand.js`, `CONTACT`): Drehung ≤ 34° um die rechte Hand + Schub
  ≤ 0,42 m entlang des Stiels; 20/20 Stiche auf dem Treffpunkt. Spielreichweite unverändert (2,4 m).
* **Grab-Effekte** (`goldrush-vfx.js`): skaliert mit dem echten Volumen, beleuchteter Staub.
* **QA**: DevTools „Visual-QA (VO-A)“ / „Visual-Debug (VO-A)“ (Bookmarks `vo.bm.*`, Debug-Ansichten);
  `tests/e2e/goldrush_visualqa.py capture|compare|tune|perf|shovel` (Seed 4242).

## Invarianten (dauerhaft)

* **Simulation ist authoritative.** Schützen: `MaterialBatch` (Integer-Transfers), Geologie /
  `MaterialField` (deterministisch), Gold- und Massenerhaltung (Ledger), integer `qh`-Terrain,
  Funde / Feingold, Transfer / `TransferLink` / Backpressure, Halden-Kopplung, Save / Migration.
* **Visual State ist abgeleitet:** rekonstruierbar, nie gespeichert, fließt nie in die Simulation
  zurück; darf in Bewegung kurz nachlaufen, konvergiert in Ruhe zur Wahrheit.
* **Keine Offline-Erträge:** Maschinen laufen nur in Frames bzw. `tickSim`.
* Geld nur als Integer-Cent über `Economy`; Speicher nur über `GoldRushSaveService`; GoldRush bleibt
  aus `app.js` heraus. Neue Maschinen: `SHOP_ITEMS`, Ledger-Holder, Migration, eigenes Dev-Pack,
  Modell-Wurzeln in `ProcessingSystem.warmMachines()`.
* Alles, was in `post.rtWorld` zeichnet, setzt vorher `post.toolClip.uGrDepth = null`
  (sonst Feedback-Schleife, WebKit-Fehler). Test-Hooks rendern über den Post-Stack.
* **Produktrichtung:** langfristig ein deutlich größerer, physisch abbaubarer Berg → Open Pit →
  Tunnel. Nichts bauen, das an einem einzelnen 30×30-m-Mesh festklebt.
* **Desktop setzt die Premium-Qualität**, Mobile nutzt reduzierte Tiers.
* **Assets:** eigen / CC0 / sauber lizenziert royalty-free / commissioned; Herkunft + Lizenz in
  `ASSETS.md`; nichts automatisch kaufen. Kein Framework-/Bundler-Wechsel.
* Spielwerte und Preise nur mit Benchmark ändern (`tests/e2e/goldrush_bench.py`, siehe Phasen-Doku).

## Performance (gemessen, 1600×900, AMD-Radeon-iGPU, Chromium/ANGLE)

* LOW 58–60 fps. MEDIUM 60 fps (GPU 7,5–12 ms; mit der ganzen Anlage im Bild 13,5 ms / 52 fps).
  HIGH 43–53 fps (GPU 13–19 ms, MSAA ~4,5 ms) – AUTO wählt hier MEDIUM.
* Post-Kosten: AO ~0,5 ms, Bloom ~0,5 ms, Ausgabe ~0,7 ms. Ziele 24,5 MB (MEDIUM) / 92 MB (HIGH);
  Erd-Arrays 53 MB (1024) / 13 MB (512); GeoTex 4,9 MB. Draw Calls je Ansicht wie vor VO-A
  (+12 Vollbild-Pässe auf MEDIUM/HIGH).
* Mobil-Emulation (390×844, LOW): freie Sicht 60 fps; an Anlage/Halden CPU-gebunden, gepaart ohne
  Mehrkosten gegenüber 9abb6f4; mit 4× CPU-Drosselung 26–55 fps je nach Lauf. Kein echtes Gerät gemessen.

## Teststatus FP2.0B (2026-10-21, Chromium `--quick`)

Unit 103; Kern 47 (erste zwei Läufe T7 2,00 Hübe/s an der Grenze 2–3, einmal zusätzlich T8 Frame-Spitze 50,1 ms – Timing-Flakes wie in FP2.0A; danach zweimal 47/47; eine
Direktmessung des Hand-Dig-Takts ergibt in FP2.0A und FP2.0B identisch 6 Hübe / 2,5 s), Mining 54, Werkzeuge 62, Quality 64, Dev 64, Premium 45 (erster Lauf 44/45, PERF-Schwelle
desktop:mine 56,8 / push 49 fps bei 69–91 Draw Calls – Last-Flake, Wiederholung 45/45), Working Mine 119, Mechanisiert 95; WebKit Kern 39 (erster Lauf 38/39: T7 / T8,
Wiederholung 39/39).
Schaufelkontakt `visualqa.py shovel`: **20/20, 0 px** (wie FP2.0A). Fallback (`goldrush_fpfallback.py`): 404 / defekte / abgeschnittene / clip-lose GLB → prozedurale
Handschuhe, genau eine Warnung, Dig ok; Context-Loss (verloren + wiederhergestellt bei gehaltener Schaufel) → gerigte Hände zurück, Dig ok: 21/21.
Motion-QA (`goldrush_fpmotion.py`, 1/60-s-Schritte, 9 Szenen, 4–8 Hübe je Szene): 0–1 Pose-Sprünge je Szene (vorher: Schaufel-Recover 5 cm / 0,2 rad pro Bild, Spitzhacke 0,10 m /
0,4 rad), Spitzhacke nie aus dem Bild (vorher 20 % der Bilder: Spitze draußen, zeitweise komplett unsichtbar), Griff-Fehler 0, Kontaktlücke Schaufel ≤ 2 cm
(Randfall steil/unten ≤ 6 cm), Spitzhacke ≤ 5 cm (vorher 25–33 cm zu kurz), Ellbogenwinkel 58–180° (180° nur bei voll ausgestrecktem Arm, Schulter-Nachgeben 0,4 m).
**LOW-Heap**: die „48 → 73 MB“ waren Messrauschen (nicht gesammelter Parse-Müll): nach erzwungener GC (`goldrush_fpheap.py`, 3 Läufe je Revision) gehalten Vor-FP 12,7 MB →
FP2.0A 13,0 → FP2.0B 13,0–13,3 MB; roh (ohne GC) schwankt jede Revision 14–25 MB. Nutzung (3 Runden × 3 Werkzeuge): +0,4–0,5 MB, Plateau, Geometrien (232) / Texturen (64)
konstant → kein Leck. Perf (`goldrush_fpperf.py`, 1600×900): Draw Calls / Texturen / Geometrien identisch zu FP2.0A, Dreiecke +3,7 k (+2 %); gepaarte MEDIUM-Läufe
(3× A/B): kein Unterschied außerhalb des Maschinenrauschens (jeder Lauf 42–60 fps je Segment, sustain 60 fps); HIGH schwankt auf dieser iGPU in beiden Revisionen 17–45 fps.
Nicht gelaufen: Phase 6/7/7A/7B, Camp, Processing, Auto, übrige WebKit-Suiten, Spiele-/UI-Regression (Shared Core unverändert).
Grenzen: Hand-Dig-Kontakt bleibt unabhängig vom Fadenkreuz-Abstand (die Hand greift ~0,5 m vor die Kamera, der Staub erscheint am Fadenkreuz); Held-Objekte
(Eimer / Pfanne / Karre) wurden nur über die Suiten und Stichproben geprüft, nicht Bild für Bild; kein Mobil-Gerät.

## Teststatus FP2.0A (2026-10-20, Chromium `--quick --no-bench`)

Unit 103; Kern 47 (ein Suite-Lauf T7/T8-Timing-Flake, zweimal 47/47), Mining 54, Werkzeuge 62, Quality 61, Material 44, Dev 64, Premium 45,
Mechanisiert 95, Working Mine 119; WebKit Kern 39. Schaufelkontakt `visualqa.py shovel`: 20/20, 0 px (wie vorher). Fallback (404 / defekte GLB):
Warnung, Spiel läuft, Dig ok. Perf (1600×900, 2 Läufe, vorher → nachher): MEDIUM 60 fps, Draw Calls 105 → 87 (spawn), Dreiecke +6 k, Texturen +2,
Heap +5 MB; LOW 60 fps, Heap 48 → 73 MB (GLB geparst). Nicht gelaufen: Phase 6/7/7A/7B, Camp, Processing, Auto, übrige WebKit-Suiten.
Offen/Grenzen (alle in FP2.0B behoben): Finger wie Fäustling, keine Clips pro Werkzeugphase, Kamera-Impuls nur der vorhandene Kontakt-Kick, Linkshand-Daumen grob geprüft.

## Teststatus Earth 2.0C1 (2026-10-15, Chromium `--quick --no-bench`)

Unit 103; Kern 47 (ein T8-Flake im Suite-Lauf, zweimal 47/47), Mining 54, Werkzeuge 62, Quality 61, Material 44, Dev 64, Mechanisiert 95,
Mech 54, Working Mine 119, Hotfix 9.1 26; WebKit Kern 39; `goldrush_seams.py` 56 Fälle / 0 Löcher.
Perf 2.0C → C1 (3 Läufe je Ansicht, spawn/wide/east/west): Dreiecke HIGH 201–243 k → 118–161 k, MEDIUM 186–228 k → 111–153 k, LOW(mobil) 144 k →
70 k; Draw Calls gleich; HIGH-GPU-Zeit 23–29 → 16–23 ms (die Maschine lief in dieser Sitzung generell bei ~30 fps HIGH); MEDIUM / LOW 60 fps.
Nässe: Quelle → Anstieg in ~3 s, 50 % trocken nach ~70 s, 90 % nach ~120 s, Fels dunkelt (Mitte 56 → 42 Grauwert). LOD-Pop: mittlere
Grauwertdifferenz zwischen Stufen < 0,013.

## Teststatus Earth 2.0C (2026-10-15, Chromium `--quick --no-bench`)

Unit 103; Kern 47, Mining 54, Werkzeuge 62, Quality 61, Material 44, Dev 64, Mechanisiert 95 (ein PRF-fps-Flake 33 fps beim ersten Lauf,
zweimal 60 fps / 95 grün), Mech 54, Working Mine 119, Hotfix 9.1 26; WebKit Kern 39. `goldrush_seams.py`: 56 Fälle (8 LOD-Muster × 7
Kameras), 0 Löcher. Perf MEDIUM/HIGH (spawn/face/camp/summit): fps und GPU-Zeit wie 2.0B, Draw Calls +2, Dreiecke +~75 k (+50 %),
Texturen +2, Heap +10 MB. Nicht gelaufen: Phase 6/7/7A/7B, Premium, Camp, Processing, Auto, übrige WebKit-Suiten, Spiele-Regression, UI-Audit.

## Teststatus Earth 2.0B (2026-10-15, Chromium `--quick --no-bench`, Branch-Stand)

Unit 103; Kern 47, Mining 54, Werkzeuge 62, Quality 61, Material 44, Dev 64, Mechanisiert 95, Mech 54, Working Mine 119,
Hotfix 9.1 26; WebKit Kern 39 (erster Lauf hing in einem Klick-Timeout – bekannter WebKit-Stall –, Wiederholung grün).
Visual QA: `tests/e2e/goldrush_digqa.py` (neu), vo.bm.* unverändert (Pixeldifferenz < 1/255 im Mittel). Dig-Perf
(40 Scoops, HIGH): Stroke-Median 1,8 → 2,8 ms, Draw Calls / Dreiecke gleich, +2 Texturen, Heap +5 MB, 60 fps.
Nicht gelaufen: Phase 6/7/7A/7B/Premium/Camp/Processing/Auto, WebKit-Nebensuiten, Spiele-Regression, UI-Audit.

## Teststatus (2026-10-14, Earth 2.0A – alles grün, Details unten)

* Chromium: Kern 47, Mining 56, Werkzeuge 63, Camp 65, Processing 49, Dev 64, Phase 6 54, 7 43,
  7A 61, 7B 44, Premium 45, Mechanisiert 95, Hotfix 9.1 26, Working Mine 119.
* WebKit: Kern 39, Werkzeuge 60, Premium 38, Mechanisiert 89, Working Mine 116, Hotfix 26, 7A 40, Dev 51.
* Earth 2.0A (Chromium, `--quick` wo üblich): Kern 47, Mining 54, Werkzeuge 62, Dev 64, Quality 64, Camp 65,
  Processing 58, Material 45, Premium 45, Mechanisiert 95, Working Mine 119, Hotfix 26, Mech 61, Auto 49;
  WebKit Kern 39. Unit 103. Nicht neu gelaufen: übrige WebKit-Suiten, Spiele-Regression, UI-Audit.
* Vorher: Unit 103, Spiele-Regression 269, UI-Audit 442. Keine Wirtschafts-Benchmarks seit Prompt 10.
* Earth 2.0A: Hook-Grabungen (`DIG_HERE`) laufen ~2× schneller (kein Geometrie-Upload) und lassen das Effekt-Backlog
  länger in die Folgeschritte reichen; Mining-Test wartet jetzt mit `calm()` (fps ≥ 40, < 20 Partikel).
* Bekannte Flakes (bestehen beim Wiederholen): PERF-Schwellen (60 fps) in Quality/Material; T19 Klang „break“ übersteuert selten, W7 Schubkarre
  voll/leer an der 0,8-Grenze, T34 (WebKit), Premium-PERF-Hänger, T7 / T8 / T14 unter Last.

## Offene Punkte

* Größerer Berg (Maßstab, Roadmap-Punkt „2.0C Maßstab“) weiter offen; Terrain bisher ein Textur-Satz (30×30 m); Dig-Detail-Fenster fest 96 m. Aus 2.0B offen: echte Fels-Assets, Nässe aus
  Quellen; Abdrücke gehen beim Reload verloren (Kanten bleiben); Pick-Abdruck in Erde ist wegen der kleinen Abtragsmenge dezent.
* Aus Prompt 10 noch offen: A10–E10-Benchmark mit Abbaugerät + Großnuggets, 48-Punkte-Bericht.
* KTX2 für die Erd-Texturen (kein Basis-Encoder in der Build-Umgebung).
* Nässe (StateTex G) nur über DevTools – echte Quellen fehlen.
* Fernes Hintergrund-Massiv (optional in VO-A) nicht gebaut; ferne Berge sind flache Kulissen.
* Größte sichtbare Prototyp-Reste: Box-Maschinen, altes Wasser, kleiner Hügel (~27 m); Camp-Boden etwas orange. (Ikosaeder-Felsen: Earth 2.0C; Handschuhe/Arme: FP2.0A/B.)
* Platzhalter-Klänge (synthetisch); kein Mobil-Test auf echtem Gerät.
* `goldrush-opus-review.zip` + `.sha256` im Repo-Root: absichtlich untracked, **nie committen**.
