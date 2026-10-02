# GoldRush – interne Design- und Architekturnotizen

Interne Notizen für die Weiterentwicklung (Prompt 6–12). Nicht für Spieler.
Liegt bewusst außerhalb von `static/`, wird also nicht ausgeliefert.

## Module (Stand Phase 6)

| Bereich | Datei(en) |
|---|---|
| Einstieg, Startscreen, Menüs, Dialoge | `static/games/goldrush/goldrush.js` |
| Spiel, Loop, Spieler, Kauf | `goldrush-engine.js` |
| Spielstände (pro Konto), Migrationen, Dev-Snapshot | `goldrush-save.js` (`GoldRushSaveService`, Version 6) |
| Geld, Goldbeutel, Verkauf | `goldrush-economy.js` |
| Shop-Registry (Items, Preise, Voraussetzungen) | `goldrush-shop.js` (`SHOP_ITEMS`) |
| Gelände, Ressourcen, Abbau | `goldrush-terrain.js`, `goldrush-resources.js`, `goldrush-mining.js` |
| Material-Kette SOURCE → TRANSPORT → PROCESS → OUTPUT | `goldrush-material.js` (`MaterialBatch`, `pour`, `sluiceSplit`), `goldrush-processing.js` (`ProcessingSystem`) |
| Schubkarre (Phase 6) | `goldrush-wheelbarrow.js` (`Wheelbarrow`) |
| Waschrinne / Sluice (Phase 6) | `goldrush-sluice.js` (`Sluice`) |
| Modelle Schubkarre / Rinne | `goldrush-mechmodels.js` (`MechModels`) |
| Grab-Gefühl: Partikel pro Material und Werkzeug | `goldrush-vfx.js` (`DigEffects`, `DIG_PROFILES`, `DIG_TOOLS`) |
| Entwickler-/QA-Werkzeuge | `goldrush-dev*.js` (siehe unten; Phase 6: `goldrush-devcommands6.js`) |

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
7. ein eigenes Dev-Paket (wie `goldrush-devcommands6.js`).

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
   Waschrinne < 1,1 % – rund 1.100 m³).
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
