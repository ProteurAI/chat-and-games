# GoldRush – Roadmap (kommende große Phasen)

Reihenfolge: **Earth 2.0A → 2.0B → 2.0C → First Person 2.0 → Material in Motion → Hero Machines →
Water 2.0 → World Cohesion.**

Der Zuschnitt unten ist der Ausgangspunkt; den verbindlichen Umfang setzt der jeweilige Phasen-Prompt.
Jede Phase: eigener Thread, Backup-Branch auf den Startcommit, Vorher/Nachher auf den festen
Visual-QA-Bookmarks, Regression, `docs/GOLDRUSH_STATE.md` aktualisieren. Die Invarianten aus STATE
gelten überall (Simulation authoritative, Visual abgeleitet, keine Offline-Erträge).

1. **Earth 2.0A – Terrain-Renderer.** GPU-Heightfield aus der `qh`-Wahrheit (HeightTex), kachelbar /
   sparse, CDLOD- bzw. Clipmap-fähig. Übernimmt das Earth-B0-Material ohne neuen Shader: die
   Vertex-Attribute (`aGeo`, `aEarth`, `aMat`) wandern in Texturen. KTX2-Pipeline, sobald ein Encoder
   verfügbar ist. Die CPU-Simulation bleibt die Wahrheit.
2. **Earth 2.0B – Graben sichtbar.** Abdrücke, Abbruchkanten, Nachrutschen als abgeleitete Darstellung;
   echte Fels-Assets statt Ikosaeder-Brocken; Nässe aus echten Quellen (Rinne, Waschplatz, Anlage).
3. **Earth 2.0C – Maßstab.** Größerer, physisch abbaubarer Berg (Richtung 10–50× Volumen) mit
   regionalen Geologie-Texturen und Hintergrund-Massiv; Vorbereitung für Open Pit. Das ändert Gameplay
   und Wirtschaft: eigene Entscheidung, Benchmarks, Save-Migration.
4. **First Person 2.0.** Erstellte, geriggte Arme und Handschuhe, Animationssatz, neue Werkzeugmodelle;
   der Weltkontakt aus C-lite wird auf Spitzhacke, Eimer, Pfanne und Schubkarre verallgemeinert.
5. **Material in Motion.** Haufen-Renderer 2.0 (ersetzt `GridLoad` / `LooseLoad`), Schütt-System
   (Schaufel, Eimer, Karre, Lader, Band), Grab-Debris – immer aus `MaterialBatch` abgeleitet.
6. **Hero Machines.** Erstellte Modelle (GLB) für Bagger, Radlader und Anlage (Plant-Kit) hinter den
   bestehenden Rig-Schnittstellen; Leistung und Simulation unverändert.
7. **Water 2.0.** Wasser in Rinne, Waschplatz und Waschanlage (Oberfläche, Fluss, Spritzer), Nässe in
   StateTex – ohne Fluid-Simulation.
8. **World Cohesion.** Fernsicht und Umgebung, Camp und Wege, Vegetation, Gesamtabgleich von Licht,
   Material und Klang; die feste Lichtstimmung bleibt, bis anders entschieden.

Langfristige Produktrichtung (nicht terminiert): größerer Berg → Open Pit → Tunnel; Story und
Multiplayer siehe `docs/goldrush.md` „Langfristige Vision“.
