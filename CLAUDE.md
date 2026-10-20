# Chat & Games – Regeln für Claude Code

Lokale Chat-App (FastAPI `backend/`, statisches Frontend `static/`) mit Spielen. Hauptprojekt: **GoldRush**
(`static/games/goldrush/`, three.js r176 vendored, kein Bundler).

## Zuerst lesen
- `docs/GOLDRUSH_STATE.md` – aktueller Stand, Invarianten, Performance, Tests, offene Punkte
- `docs/GOLDRUSH_ROADMAP.md` – kommende Phasen
- `docs/goldrush.md` – Architektur je Phase (nur den relevanten Abschnitt)
- `static/games/goldrush/ASSETS.md` – Herkunft und Lizenz aller Assets

## Arbeitsweise
- Eine größere Teilaufgabe pro Thread; kurze, task-spezifische Prompts. Nur den beauftragten Scope;
  die nächste Phase nie ungefragt beginnen.
- Am Ende jeder Phase `docs/GOLDRUSH_STATE.md` aktualisieren (Commit, Stand, Tests, offene Punkte).
- Git: logische Commits, normaler Push. **Kein `reset --hard`, kein Force-Push**, keine History-Umschreibung,
  uncommittete Arbeit nie verwerfen. Vor einer Phase Backup-Branch `backup/pre-goldrush-<phase>`.
- `goldrush-opus-review.zip` (+ `.sha256`) im Root nie committen.

## GoldRush-Invarianten (Details in STATE)
- Simulation ist authoritative: `MaterialBatch`, Geologie, Gold-/Massenerhaltung, Backpressure, Save schützen.
- Visual State ist abgeleitet, nie gespeichert, fließt nie in die Simulation zurück.
- Keine Offline-Erträge. Geld nur als Integer-Cent über `Economy`.
- Langfristig: größerer physisch abbaubarer Berg → Open Pit → Tunnel.
- Desktop setzt die Premium-Visual-Qualität; Mobile nutzt reduzierte Tiers.
- Assets: eigen / CC0 / sauber lizenziert royalty-free / commissioned – Lizenz in `ASSETS.md`; nichts kaufen.

## Commands (Windows, Repo-Root)
- Start: `.\start.ps1` oder `python -m uvicorn backend.main:app --port 8000`
- Unit (kein pytest): `python -m unittest tests.test_multiscreen_engine tests.test_kopfkicker_physics tests.test_goldrush_dev tests.test_session_log`
- E2E: `$env:PYTHONIOENCODING="utf-8"; python tests/e2e/goldrush_e2e.py [--browser webkit]`
  (weitere Suites `tests/e2e/goldrush_*_e2e.py`, meist `--quick`, `--no-bench`, `--only <teile>`)
- Visual QA: `python tests/e2e/goldrush_visualqa.py capture|compare|perf|shovel --out DIR`
- Suites nacheinander, nie parallel; während eines Laufs keine Spieldateien ändern. Benchmarks
  (`tests/e2e/goldrush_bench.py`) nur bei geänderten Spielwerten.

## QA-Sicherheit (Windows-Cursor)
- Automated GoldRush QA/screenshots must never capture or confine the host OS cursor. Prefer headless automation (`tests/e2e/qa_safety.py` forces it; `GOLDRUSH_QA_HEADED=1` only for manual visual QA); in automated browsers (`navigator.webdriver`) GoldRush never takes the Pointer Lock (free-mouse mode).
