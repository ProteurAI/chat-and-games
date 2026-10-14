# Chat & Games – Regeln für Coding-Agents

Hauptprojekt: **GoldRush** (`static/games/goldrush/`, three.js r176 vendored, kein Bundler). Dieselben Regeln
wie in `CLAUDE.md`; Stand und Invarianten in `docs/GOLDRUSH_STATE.md`, Phasen in `docs/GOLDRUSH_ROADMAP.md`,
Architektur je Phase in `docs/goldrush.md`, Asset-Lizenzen in `static/games/goldrush/ASSETS.md`.

## Harte Regeln
- Simulation authoritative; `MaterialBatch`, Geologie, Gold-/Massenerhaltung, Backpressure und Save schützen.
- Visual State abgeleitet, nie gespeichert. Keine Offline-Erträge.
- Desktop = Premium-Qualität, Mobile = reduzierte Tiers.
- Assets nur eigen / CC0 / sauber lizenziert royalty-free / commissioned, Lizenz dokumentieren.
- Langfristig: größerer abbaubarer Berg → Open Pit → Tunnel – nichts verbauen.
- Eine größere Teilaufgabe pro Thread, nur der beauftragte Scope; am Phasenende `docs/GOLDRUSH_STATE.md` aktualisieren.
- Kein `reset --hard`, kein Force-Push; logische Commits, normaler Push; `goldrush-opus-review.zip*` nie committen.

## Commands
- Start: `python -m uvicorn backend.main:app --port 8000`
- Unit: `python -m unittest tests.test_multiscreen_engine tests.test_kopfkicker_physics tests.test_goldrush_dev tests.test_session_log`
- E2E (Playwright, nacheinander): `PYTHONIOENCODING=utf-8 python tests/e2e/goldrush_e2e.py [--browser webkit]`
- Visual QA: `python tests/e2e/goldrush_visualqa.py capture|compare|perf|shovel --out DIR`
