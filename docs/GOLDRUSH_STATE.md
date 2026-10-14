# GoldRush – aktueller Stand (Handoff)

**Stand:** 2026-10-14 · `main` = `origin/main` = `752cc16e70f975eff93384e70f1a400e3f9a6457`
(nach Visual Overhaul A + Earth B0). Nächste Phase laut Roadmap: **Earth 2.0A** – nicht begonnen.

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
| Letztes Backup | `backup/pre-goldrush-visual-overhaul-a` = 9abb6f4 | Branches `backup/pre-goldrush-*` |

## Was gebaut ist

| Phase | Inhalt | `docs/goldrush.md` |
|---|---|---|
| 1–5, 5.5 | 3D-Grundlage, Materialien, Werkzeuge, Gold ≠ Geld, Spielstände pro Konto, Waschen, DevTools | Module, Entwicklertools |
| 6–7B | Schubkarre, Rinne, Transfer-Schicht, Bunker/Aufgeber, Qualitäts- und Material-Pässe | Phase 6 / 7 / 7A / 7B |
| 8 | Premium Vertical Slice (Hände, Schubkarren-Controller, Gebäude) | Phase 8 |
| 9 / 9.1 | Mechanisierter Claim (Band, Trommel, Bagger, Bergauftrag), Gold-Audit | Phase 9, 9.1 |
| 10 / 10.0.1 | Arbeitsmine (Halden, Radlader, Waschanlage, Abbaugerät, Großnuggets), Zwischenstufen | Prompt 10, 10.0.1 |
| VO-A + Earth B0 | Licht, Post-Stack, Himmel/Dunst, PBR-Boden, Schaufelkontakt, Visual-QA | Visual Overhaul A + Earth B0 |

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
* **CPU-Terrain-Mesh bleibt** (Raster, LOD, Simulation unverändert). Für Earth 2.0A: das Material
  hängt an Weltposition, GeoTex und StateTex; die Vertex-Attribute (`aGeo/aEarth/aMat`) müssen beim
  GPU-Heightfield in Texturen wandern.
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

## Teststatus (2026-10-13, Stand 752cc16 – alles grün)

* Chromium: Kern 47, Mining 56, Werkzeuge 63, Camp 65, Processing 49, Dev 64, Phase 6 54, 7 43,
  7A 61, 7B 44, Premium 45, Mechanisiert 95, Hotfix 9.1 26, Working Mine 119.
* WebKit: Kern 39, Werkzeuge 60, Premium 38, Mechanisiert 89, Working Mine 116, Hotfix 26, 7A 40, Dev 51.
* Unit 103, Spiele-Regression 269, UI-Audit 442. Keine Wirtschafts-Benchmarks seit Prompt 10.
* Bekannte Flakes (bestehen beim Wiederholen): T19 Klang „break“ übersteuert selten, W7 Schubkarre
  voll/leer an der 0,8-Grenze, T34 (WebKit), Premium-PERF-Hänger, T7 / T8 / T14 unter Last.

## Offene Punkte

* Aus Prompt 10 noch offen: A10–E10-Benchmark mit Abbaugerät + Großnuggets, 48-Punkte-Bericht.
* KTX2 für die Erd-Texturen (kein Basis-Encoder in der Build-Umgebung).
* Nässe (StateTex G) nur über DevTools – echte Quellen fehlen.
* Fernes Hintergrund-Massiv (optional in VO-A) nicht gebaut; ferne Berge sind flache Kulissen.
* Größte sichtbare Prototyp-Reste: Ikosaeder-Felsbrocken, prozedurale Handschuhe/Arme,
  Box-Maschinen, altes Wasser, kleiner Hügel (~27 m); Camp-Boden etwas orange.
* Platzhalter-Klänge (synthetisch); kein Mobil-Test auf echtem Gerät.
* `goldrush-opus-review.zip` + `.sha256` im Repo-Root: absichtlich untracked, **nie committen**.
