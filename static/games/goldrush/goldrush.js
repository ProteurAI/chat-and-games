// GoldRush - entry point (ES module, loaded on demand by app.js).
//
// Owns the immersive layer: the start screen (continue / new mine), the
// loading screen, HUD, pause/settings, dialogs, the WebGL fallback. The
// heavy part (three.js + the game itself) is fetched while the start
// screen is up and built only once the player chose a mine. At most ONE
// GoldRush runs at a time; open() while it is open returns that instance.
// Every save goes through the save service, per player (goldrush-save.js).

import { GoldRushSaveService } from "./goldrush-save.js";
import { formatEuro, formatMass } from "./goldrush-economy.js";
import { webglAvailable } from "./goldrush-renderer.js";

let current = null;

export function isOpen() { return !!current; }

// user: { id, name } of the logged-in Chat & Games account (app.js);
// api: the app's authenticated fetch (only the developer access uses it)
export function open({ onExit, user, api } = {}) {
  if (current) return current;
  current = new GoldRushShell(onExit, user, api);
  current.start();
  return current;
}

const ICONS = {
  pause: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/></svg>`,
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>`,
  hand: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 11V5.5a1.5 1.5 0 013 0V10m0-1V4a1.5 1.5 0 013 0v6m0-4.5a1.5 1.5 0 013 0V12m0-3a1.5 1.5 0 013 0v5c0 4-2.7 7-6.5 7-2.4 0-4-1-5.3-2.8L4.7 14a1.6 1.6 0 012.4-2L8 13" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`,
  shovel: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.5 3.2l3.3 3.3M19.2 4.9l-8.4 8.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><path d="M10.8 13.3l-1.6-1.6c-.5-.5-1.3-.5-1.8 0L4.3 14.8c-1.6 1.6-1.6 4.2 0 5.8s4.2 1.6 5.8 0l3.1-3.1c.5-.5.5-1.3 0-1.8l-1.6-1.6" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" fill="none"/></svg>`,
  pickaxe: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.2 9.8L4 20" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" fill="none"/><path d="M4.5 7.5c3.9-3.7 10-4.4 14.6-1.6l-1.4 1.4c-.1-.1-3.6-2.5-8.6-.6M16.5 19.5c3.7-3.9 4.4-10 1.6-14.6l-1.4 1.4c.1.1 2.5 3.6.6 8.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`,
  bucket: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l-1.6 11.2a1.6 1.6 0 01-1.6 1.3H8.2a1.6 1.6 0 01-1.6-1.3L5 8z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" fill="none"/><path d="M5.6 8c0-3.2 2.9-5 6.4-5s6.4 1.8 6.4 5" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M6.4 12.5h11.2" stroke="currentColor" stroke-width="1.3" opacity=".6"/></svg>`,
  pan: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.8 10.5c0 3.8 4.1 6.5 9.2 6.5s9.2-2.7 9.2-6.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"/><ellipse cx="12" cy="10.5" rx="9.2" ry="2.6" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="10" cy="13.6" r="1" fill="#c7922f"/><circle cx="13.2" cy="14.2" r=".8" fill="#c7922f"/></svg>`,
  wheelbarrow: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 9.5h12l-1.6 5.2H6.1z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/><circle cx="17.6" cy="17.4" r="2.3" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M14 14.7l2.3 1.6M6.4 14.7L4.6 19M3.5 9.5L1.5 7.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>`,
  sluice: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 8.5l19 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"/><path d="M2.5 11.5l19 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/><path d="M6 9.4l-.6 2.4M10 10.5l-.6 2.4M14 11.5l-.6 2.4M18 12.6l-.6 2.4" stroke="currentColor" stroke-width="1.2" opacity=".7"/><path d="M4 12v7M19.5 16v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M2.5 5.5h4v3" stroke="currentColor" stroke-width="1.4" fill="none" opacity=".75"/></svg>`,
  bulkhopper: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 4.5h17l-6 8h-5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/><path d="M10.5 12.5v3h3v-3M5 4.5V21M19 4.5V21" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/><path d="M6.5 7h11" stroke="currentColor" stroke-width="1.1" opacity=".6"/></svg>`,
  feeder: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9.5l15 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><path d="M3 12.5l15 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/><circle cx="8" cy="18" r="2.3" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M19.5 15.5v4M21.5 14.5v4M6 6.5l1.5 1M9.5 5.5l1 1.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/></svg>`,
  classifier: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8.5h18l-1.5 4H4.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/><path d="M6 8.5l1 4M10 8.5l.4 4M14 8.5l-.4 4M18 8.5l-1 4" stroke="currentColor" stroke-width="1" opacity=".65"/><path d="M5 12.5v7M19 12.5v7M7 16h10v3.5H7z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none"/></svg>`,
  // phase 9
  prospectkit: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20.5V4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M5.2 4.8h8.6l-2 2.7 2 2.7H5.2" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none"/><path d="M13.5 13.5h5.5l-.7 6.2c-.1.5-.5.8-1 .8h-2.1c-.5 0-.9-.3-1-.8z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none"/></svg>`,
  conveyor: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.5L19 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="4.6" cy="18.6" r="1.6" stroke="currentColor" stroke-width="1.4" fill="none"/><circle cx="19.2" cy="9.4" r="1.6" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M7 15.3l1-2M11 13l1-2M15 10.6l1-2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M2 6h5l-1.5 3h-2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="none"/></svg>`,
  trommel: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5l15 3v5l-15-3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/><ellipse cx="4" cy="11" rx="1.3" ry="2.5" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M8 9.5v4.5M12 10.3v4.5M16 11.1v4.5" stroke="currentColor" stroke-width="1" opacity=".7"/><path d="M6 17.5l1 2.5M10 18l.5 2.5M20 17l1.5 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  excavator: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="16.5" width="11" height="3.4" rx="1.7" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M4 16.5v-4h6.5l1.2 4M6 12.5V9h3.4l1.1 3.5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none"/><path d="M10.8 11.5l5.2-6.3 4 5.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M20 10.8c1.4.9 1.5 3.2 0 4.2l-2.6-2.3z" fill="currentColor"/></svg>`,
};

// what the dig button says per tool
const ACTION = { hand: "GRABEN", shovel: "SCHAUFELN", pickaxe: "HACKEN" };
const CLASS_LABEL = { traceGold: "Goldstaub", fineGold: "Feiner Goldstaub", goldFlake: "Goldflitter", tinyGoldPiece: "Kleine Goldstücke", smallNugget: "Nuggets", washedGold: "Waschgold (Feingold)" };
const SHOP_GROUPS = [["tool", null, "Werkzeug"], ["upgrade", "shovel", "Für die Schaufel"], ["upgrade", "pickaxe", "Für die Spitzhacke"],
  ["equipment", null, "Verarbeitung & Transport"], ["upgrade", "bucket", "Für den Eimer"], ["upgrade", "pan", "Für die Goldpfanne"], ["upgrade", "sluice", "Für die Waschrinne"],
  ["upgrade", "bulkhopper", "Für den Vorratstrichter"], ["upgrade", "feeder", "Für den Dosierer"], ["upgrade", "excavator", "Für den Bagger"]];
// where a bought piece of equipment is now (the claim, not an inventory)
const EQUIP_WHERE = { bucket: "Steht vor dem Schuppen – stell ihn neben dich und grab hinein.", pan: "Liegt am Waschplatz beim Wassertank.", classifier: "Steht am Waschplatz über der Wanne.",
  wheelbarrow: "Steht neben dem Schuppen – an den Griffen greifen [E] und losschieben.", sluice: "Die Bretter liegen beim Wassertank – dort [E]: Waschrinne aufbauen.",
  bulkhopper: "Die Teile liegen am Kopf der Waschrinne – am Kontrollpfosten [E]: Vorratstrichter aufbauen.", feeder: "Die Kiste steht am Kontrollpfosten – dort [E]: Dosierer montieren.",
  prospectkit: "Beutel, Fähnchen und Notizbuch hast du dabei: [R] Probe nehmen · [F] Fähnchen · [N] Notizbuch.",
  conveyor: "Die Teile liegen am Westfuß des Bergs – dort [E]: Aufgabetrichter und Förderband aufbauen.",
  trommel: "Die Trommel liegt neben dem Vorratstrichter – an der Schalttafel [E]: Trommelsieb aufbauen.",
  excavator: "Der Bagger steht am Westfuß des Bergs neben dem Aufgabetrichter – [E] einsteigen." };

const fmtMoney = (v) => `€ ${v.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const TOOL_NAME = { hand: "Hand", shovel: "Schaufel", pickaxe: "Spitzhacke", bucket: "Eimer", pan: "Goldpfanne", classifier: "Sieb", wheelbarrow: "Schubkarre", sluice: "Waschrinne", bulkhopper: "Vorratstrichter", feeder: "Dosierer",
  prospectkit: "Probenset", conveyor: "Förderband", trommel: "Trommelsieb", excavator: "Bagger" };
const MAT_WORD = ["Erde", "feste Erde", "Kies", "Fels"];

// "1 h 12 min" / "8 min" / "< 1 min"
function fmtPlay(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "< 1 min";
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

// "640 kg" / "3,2 t"
const fmtKg = (kg) => (kg >= 1000 ? `${(kg / 1000).toFixed(1).replace(".", ",")} t` : `${kg} kg`);

function newSeed() {
  const a = new Uint32Array(1);
  try { crypto.getRandomValues(a); } catch (e) { a[0] = Math.floor(Math.random() * 2 ** 31); }
  return a[0] & 0x7fffffff;
}

class GoldRushShell {
  constructor(onExit, user, api) {
    this.onExit = onExit || (() => {});
    this.api = typeof api === "function" ? api : null;
    this.saves = new GoldRushSaveService(user);
    this.devtools = null;                                  // developer / QA tools: loaded on first use (goldrush-devtools.js)
    this.settings = this.saves.loadSettings();           // device settings: a new mine keeps them
    this.touch = window.matchMedia("(pointer: coarse)").matches;
    let dbg = false;
    try { dbg = localStorage.getItem("goldrush.debug") === "1" || /[?&]goldrush-debug\b/.test(location.search); } catch (e) { /* ignore */ }
    this.debug = dbg;
    this.game = null;
    this.closed = false;
    this._off = [];
    this._build();
  }

  on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._off.push(() => target.removeEventListener(type, fn, opts));
  }

  // ------------------------------------------------------------ DOM

  _build() {
    const root = (this.root = document.createElement("div"));
    root.className = "gr-root" + (this.touch ? " gr-touch" : " gr-desktop");
    root.setAttribute("role", "application");
    root.setAttribute("aria-label", "GoldRush");
    root.innerHTML = `
      <canvas class="gr-canvas" tabindex="-1"></canvas>
      <div class="gr-hud" hidden>
        <div class="gr-hud-top">
          <div class="gr-chip gr-brand"><span aria-hidden="true">⛏️</span><span>GoldRush</span></div>
          <div class="gr-hud-right">
            <div class="gr-chip gr-money" aria-label="Guthaben">${fmtMoney(0)}</div>
            <button type="button" class="gr-hud-btn" data-act="settings" aria-label="Pause und Einstellungen">${ICONS.pause}</button>
            <button type="button" class="gr-hud-btn" data-act="exit" aria-label="GoldRush verlassen">${ICONS.close}</button>
          </div>
        </div>
        <button type="button" class="gr-chip gr-tool" aria-label="Werkzeug: Hand – Werkzeuge zeigen" aria-expanded="false" data-act="tools"><span class="gr-tool-ico">${ICONS.hand}</span><span class="gr-tool-name">Hand</span></button>
        <div class="gr-belt" role="toolbar" aria-label="Werkzeuge">
          <button type="button" class="gr-slot" data-tool="hand"><span class="gr-slot-key">1</span><span class="gr-slot-ico">${ICONS.hand}</span><span class="gr-slot-label">Hand</span></button>
          <button type="button" class="gr-slot" data-tool="shovel"><span class="gr-slot-key">2</span><span class="gr-slot-ico">${ICONS.shovel}</span><span class="gr-slot-label">Schaufel</span><span class="gr-lock" aria-hidden="true">🔒</span></button>
          <button type="button" class="gr-slot" data-tool="pickaxe"><span class="gr-slot-key">3</span><span class="gr-slot-ico">${ICONS.pickaxe}</span><span class="gr-slot-label">Spitzhacke</span><span class="gr-lock" aria-hidden="true">🔒</span></button>
          <span class="gr-belt-pro" data-role="belt-pro" hidden>
            <button type="button" class="gr-slot gr-slot-pro" data-act="sample" aria-label="Probe nehmen (R)"><span class="gr-slot-key">R</span><span class="gr-slot-label">Probe</span></button>
            <button type="button" class="gr-slot gr-slot-pro" data-act="flag" aria-label="Fähnchen stecken oder ziehen (F)"><span class="gr-slot-key">F</span><span class="gr-slot-label">Fähnchen</span></button>
            <button type="button" class="gr-slot gr-slot-pro" data-act="notebook" aria-label="Notizbuch (N)"><span class="gr-slot-key">N</span><span class="gr-slot-label">Notizbuch</span></button>
          </span>
        </div>
        <div class="gr-crosshair" aria-hidden="true"><span></span></div>
        <div class="gr-hint">WASD bewegen · Maus umsehen · Linksklick halten: graben · 1 2 3 Werkzeug · E: Eimer, Waschplatz, Camp · Esc: Pause</div>
        <div class="gr-notice" role="status" hidden></div>
      </div>
      <div class="gr-stick" aria-hidden="true"><div class="gr-stick-knob"></div></div>
      <button type="button" class="gr-dig-btn" aria-label="Graben (gedrückt halten)"><span class="gr-dig-ico">${ICONS.hand}</span><span class="gr-dig-label">GRABEN</span></button>
      <button type="button" class="gr-ctx-btn" data-act="use-station" hidden></button>
      <button type="button" class="gr-alt-btn" aria-label="Löffel abkippen (gedrückt halten)" hidden>KIPPEN</button>
      <div class="gr-sheet" data-sheet="assay" hidden role="dialog" aria-modal="true" aria-label="Goldankauf">
        <div class="gr-sheet-card">
          <div class="gr-sheet-head">
            <div><div class="gr-sheet-title">Goldankauf</div><div class="gr-sheet-sub">Dein Gold wird gewogen und zum festen Camp-Preis angekauft.</div></div>
            <button type="button" class="gr-sheet-close" data-act="close-station" aria-label="Schließen">${ICONS.close}</button>
          </div>
          <div class="gr-scale" aria-live="polite">
            <div class="gr-scale-cell"><span class="gr-scale-label">Gewicht</span><span class="gr-scale-value" data-role="weigh">–</span></div>
            <div class="gr-scale-cell"><span class="gr-scale-label">Wert</span><span class="gr-scale-value gr-scale-gold" data-role="worth">–</span></div>
          </div>
          <ul class="gr-sell-list" data-role="sell-list"></ul>
          <div class="gr-sell-foot">
            <div class="gr-sell-cash" data-role="sell-cash"></div>
            <button type="button" class="gr-btn-gold" data-act="sell-all">Alles verkaufen</button>
          </div>
        </div>
      </div>
      <div class="gr-sheet" data-sheet="supply" hidden role="dialog" aria-modal="true" aria-label="Ausrüstung">
        <div class="gr-sheet-card">
          <div class="gr-sheet-head">
            <div><div class="gr-sheet-title">Ausrüstung</div><div class="gr-sheet-sub" data-role="shop-cash"></div></div>
            <button type="button" class="gr-sheet-close" data-act="close-station" aria-label="Schließen">${ICONS.close}</button>
          </div>
          <div class="gr-shop-list" data-role="shop-list"></div>
        </div>
      </div>
      <div class="gr-sheet" data-sheet="contract" hidden role="dialog" aria-modal="true" aria-label="Bergauftrag">
        <div class="gr-sheet-card gr-sheet-paper">
          <div class="gr-sheet-head">
            <div><div class="gr-sheet-title">Bergauftrag</div><div class="gr-sheet-sub">Claim 01 – der ganze Berg muss weg.</div></div>
            <button type="button" class="gr-sheet-close" data-act="close-station" aria-label="Schließen">${ICONS.close}</button>
          </div>
          <div class="gr-contract" data-role="contract"></div>
        </div>
      </div>
      <div class="gr-sheet" data-sheet="notebook" hidden role="dialog" aria-modal="true" aria-label="Notizbuch">
        <div class="gr-sheet-card gr-sheet-paper">
          <div class="gr-sheet-head">
            <div><div class="gr-sheet-title">Notizbuch</div><div class="gr-sheet-sub" data-role="nb-sub"></div></div>
            <button type="button" class="gr-sheet-close" data-act="close-station" aria-label="Schließen">${ICONS.close}</button>
          </div>
          <div class="gr-notebook" data-role="notebook"></div>
          <div class="gr-nb-actions">
            <button type="button" class="ghost-btn" data-act="nb-collect">Alle Fähnchen einsammeln</button>
            <button type="button" class="ghost-btn gr-reset" data-act="nb-reset">Prospektion zurücksetzen …</button>
          </div>
        </div>
      </div>
      <div class="gr-overlay gr-pause" hidden>
        <div class="gr-card">
          <div class="gr-card-title">Pausiert</div>
          <p class="gr-card-text" data-role="pause-text">Klicke, um weiterzugraben.</p>
          <p class="gr-card-text gr-contract-line" data-role="pause-contract" hidden></p>
          <div class="gr-keys"><span><b>WASD</b> bewegen</span><span><b>Maus</b> umsehen</span><span><b>Linksklick</b> graben</span><span><b>1 2 3</b> Werkzeug</span><span><b>E</b> Eimer · Waschplatz · Goldankauf · Ausrüstung</span><span><b>R F N</b> Probe · Fähnchen · Notizbuch</span><span><b>Shift</b> schneller</span><span><b>Esc</b> Pause</span></div>
          <div class="gr-actions">
            <button type="button" class="primary-btn primary-btn--lg" data-act="resume">Weiterspielen</button>
            <button type="button" class="ghost-btn" data-act="settings">Einstellungen</button>
            <button type="button" class="ghost-btn" data-act="exit">Verlassen</button>
          </div>
          <div class="gr-dev-entry">
            <button type="button" class="ghost-btn gr-dev-open" data-act="dev"><span data-role="dev-label">Entwicklertools</span></button>
            <span class="gr-dev-badge" data-role="dev-badge" hidden>DEV</span><span class="gr-dev-flag" data-role="dev-flag" hidden>DEV-MODIFIED</span>
          </div>
        </div>
      </div>
      <div class="gr-panel" hidden role="dialog" aria-modal="true" aria-label="GoldRush Einstellungen">
        <div class="gr-card gr-settings">
          <div class="gr-card-title">Einstellungen</div>
          <div class="gr-field">
            <div class="gr-label">Grafikqualität</div>
            <div class="gr-seg" role="radiogroup" aria-label="Grafikqualität">
              <button type="button" role="radio" data-q="auto">Auto</button>
              <button type="button" role="radio" data-q="low">Niedrig</button>
              <button type="button" role="radio" data-q="medium">Mittel</button>
              <button type="button" role="radio" data-q="high">Hoch</button>
            </div>
            <div class="gr-sub" data-role="q-note"></div>
          </div>
          <label class="gr-toggle"><input type="checkbox" data-role="headbob" /><span>Kopfbewegung beim Laufen</span></label>
          <label class="gr-toggle"><input type="checkbox" data-role="reduced" /><span>Reduzierte Bewegung <em>(kein Wippen, kein Rückstoß, keine HUD-Animationen)</em></span></label>
          <div class="gr-sub" data-role="bob-note" hidden>Dein System wünscht reduzierte Bewegung – sie ist hier immer an.</div>
          <label class="gr-toggle"><input type="checkbox" data-role="sound" /><span>Sound <em>(vorläufige Platzhalter-Klänge)</em></span></label>
          <label class="gr-toggle" data-role="vibration-row" hidden><input type="checkbox" data-role="vibration" /><span>Vibration <em>(dezent, bei Treffern und Funden)</em></span></label>
          <div class="gr-dev-entry" data-role="dev-entry">
            <button type="button" class="ghost-btn gr-dev-open" data-act="dev"><span data-role="dev-label">Entwicklertools</span></button>
            <span class="gr-dev-badge" data-role="dev-badge" hidden>DEV</span><span class="gr-dev-flag" data-role="dev-flag" hidden>DEV-MODIFIED</span>
          </div>
          <div class="gr-danger-zone" data-role="danger-zone">
            <button type="button" class="ghost-btn gr-reset" data-act="new-mine">Neue Mine starten …</button>
            <div class="gr-sub">Löscht deinen Fortschritt und schüttet einen neuen Berg auf. Diese Einstellungen bleiben.</div>
          </div>
          <div class="gr-actions gr-actions--end">
            <button type="button" class="ghost-btn" data-act="exit">GoldRush verlassen</button>
            <button type="button" class="primary-btn" data-act="close-settings">Zurück zum Spiel</button>
          </div>
        </div>
      </div>
      <div class="gr-start" hidden>
        <div class="gr-start-inner">
          <div class="gr-loading-brand"><span aria-hidden="true">⛏️</span><span>GoldRush</span></div>
          <p class="gr-start-tag" data-role="start-tag">Ein Claim, ein riesiger Berg – und erst einmal nur deine Hände.</p>
          <div class="gr-start-card" data-role="start-mine" hidden>
            <div class="gr-start-card-title">Deine Mine <span class="gr-dev-flag" data-role="start-dev" hidden>DEV-MODIFIED</span></div>
            <dl class="gr-start-stats" data-role="start-stats"></dl>
          </div>
          <div class="gr-start-card gr-start-legacy" data-role="start-legacy" hidden>
            <div class="gr-start-card-title">Eine ältere Mine auf diesem Gerät</div>
            <p class="gr-start-note">Sie stammt aus der Zeit, bevor Spielstände einem Konto gehörten. Ist es deine, übernimm sie – danach gehört sie nur dir und wird niemandem sonst angeboten.</p>
            <dl class="gr-start-stats" data-role="legacy-stats"></dl>
            <button type="button" class="gr-btn-gold gr-btn-wide" data-act="legacy-take">Diese Mine übernehmen</button>
          </div>
          <div class="gr-start-actions">
            <button type="button" class="gr-btn-gold gr-btn-wide" data-act="start-continue" hidden>Fortsetzen</button>
            <button type="button" class="gr-btn-wide" data-act="start-new">Neue Mine starten</button>
            <div class="gr-start-row">
              <button type="button" class="gr-btn-quiet" data-act="start-settings">Einstellungen</button>
              <button type="button" class="gr-btn-quiet" data-act="exit">Zurück</button>
            </div>
          </div>
        </div>
      </div>
      <div class="gr-loading" hidden>
        <div class="gr-loading-inner">
          <div class="gr-loading-brand"><span class="gr-pick" aria-hidden="true">⛏️</span><span>GoldRush</span></div>
          <div class="gr-loading-text" data-role="load-text">Mine wird vorbereitet …</div>
          <div class="gr-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>
          <div class="gr-loading-step" data-role="load-step"></div>
          <button type="button" class="gr-loading-cancel" data-act="exit">Abbrechen</button>
        </div>
      </div>
      <div class="gr-overlay gr-dialog" hidden role="alertdialog" aria-modal="true">
        <div class="gr-card">
          <div class="gr-card-title" data-role="dlg-title"></div>
          <p class="gr-card-text" data-role="dlg-text"></p>
          <div class="gr-actions" data-role="dlg-actions"></div>
        </div>
      </div>
      <pre class="gr-debug" hidden></pre>`;
    document.body.appendChild(root);
    document.documentElement.classList.add("goldrush-active");
    const q = (s) => root.querySelector(s);
    this.el = {
      canvas: q(".gr-canvas"), hud: q(".gr-hud"), money: q(".gr-money"), crosshair: q(".gr-crosshair"), hint: q(".gr-hint"),
      notice: q(".gr-notice"), stick: q(".gr-stick"), knob: q(".gr-stick-knob"), digBtn: q(".gr-dig-btn"),
      pause: q(".gr-pause"), pauseText: q("[data-role=pause-text]"), panel: q(".gr-panel"), loading: q(".gr-loading"), start: q(".gr-start"),
      loadText: q("[data-role=load-text]"), loadStep: q("[data-role=load-step]"), progress: q(".gr-progress"),
      dialog: q(".gr-dialog"), debug: q(".gr-debug"), tool: q(".gr-tool"), belt: q(".gr-belt"),
      digLabel: q(".gr-dig-label"), digIco: q(".gr-dig-ico"), toolIco: q(".gr-tool-ico"), toolName: q(".gr-tool-name"),
      ctx: q(".gr-ctx-btn"), sheets: { assay: q("[data-sheet=assay]"), supply: q("[data-sheet=supply]"), contract: q("[data-sheet=contract]"), notebook: q("[data-sheet=notebook]") },
      altBtn: q(".gr-alt-btn"), beltPro: q("[data-role=belt-pro]"), contract: q("[data-role=contract]"), notebook: q("[data-role=notebook]"), nbSub: q("[data-role=nb-sub]"), pauseContract: q("[data-role=pause-contract]"),
      weigh: q("[data-role=weigh]"), worth: q("[data-role=worth]"), sellList: q("[data-role=sell-list]"), sellCash: q("[data-role=sell-cash]"),
      sellBtn: q("[data-act=sell-all]"), shopList: q("[data-role=shop-list]"), shopCash: q("[data-role=shop-cash]"),
    };
    this._openSheet = null;
    this._near = null;
    // phase 9: the excavator's second action on a phone (dump) - held like the dig button
    const alt = (on) => (e) => { if (!this.game) return; e.preventDefault(); this.game.input.altHeld = on; this.el.altBtn.classList.toggle("is-active", on); };
    this.on(this.el.altBtn, "pointerdown", alt(true));
    for (const t of ["pointerup", "pointercancel", "pointerleave"]) this.on(this.el.altBtn, t, alt(false));
    this.on(root, "click", (e) => {
      // a click on the sale while it runs: straight to the result
      if (this._sale && e.target.closest("[data-sheet=assay]") && !e.target.closest("[data-act=close-station]")) { this._sale.skip = true; return; }
      const buy = e.target.closest("[data-buy]");
      if (buy) { this._buy(buy.dataset.buy, buy); return; }
      const slot = e.target.closest("[data-tool]");
      if (slot && this.game) {
        this.game.selectTool(slot.dataset.tool);
        this._toolSheet(false);
        return;
      }
      if (this.touch && this._sheetOpen && !e.target.closest(".gr-tool")) this._toolSheet(false);
      const b = e.target.closest("[data-act]");
      if (b) this._act(b.dataset.act);
      const qb = e.target.closest("[data-q]");
      if (qb) {
        if (this.game) this.game.setQualitySetting(qb.dataset.q);
        else this._setSetting("quality", qb.dataset.q);
        this._syncSettings();
      }
    });
    this.on(root.querySelector("[data-role=headbob]"), "change", (e) => {
      if (this.game) { this.game.settings.headBob = e.target.checked; this.game.persistSettings(); } else this._setSetting("headBob", e.target.checked);
    });
    this.on(root.querySelector("[data-role=sound]"), "change", (e) => { if (this.game) this.game.setSound(e.target.checked); else this._setSetting("sound", e.target.checked); });
    this.on(root.querySelector("[data-role=vibration]"), "change", (e) => { if (this.game) this.game.setVibration(e.target.checked); else this._setSetting("vibration", e.target.checked); });
    this.on(root.querySelector("[data-role=reduced]"), "change", (e) => {
      if (this.game) this.game.setReducedMotion(e.target.checked); else this._setSetting("reducedMotion", e.target.checked);
      this._syncSettings();
    });
    this.on(window, "keydown", (e) => {
      if (e.key === "Escape" && this.devtools && this.devtools.active) { e.preventDefault(); e.stopPropagation(); this.devtools.escape(); return; }
      if (e.key === "Escape" && this._openSheet) { e.preventDefault(); e.stopPropagation(); this._closeStation(false); return; }
      if (e.key === "Escape" && !this.el.panel.hidden) { e.preventDefault(); this._closeSettings(); }
    }, true);
  }

  // ------------------------------------------------------------ flow

  async start() {
    if (!webglAvailable()) {
      this._fallback("GoldRush benötigt WebGL auf diesem Gerät.", "Dein Browser oder Gerät stellt gerade keine 3D-Grafik bereit. Aktiviere die Hardwarebeschleunigung oder probiere einen anderen Browser.");
      return;
    }
    // the engine is fetched in the background while the player looks at the start screen
    this.enginePromise = import("./goldrush-engine.js").catch(() => null);
    this.enginePromise.then((mod) => { if (mod && !this.closed) this.engine = mod; });
    let res = this.saves.peek();
    if (res.status === "corrupt") {
      const choice = await this._ask("Spielstand beschädigt",
        `Dein GoldRush-Spielstand konnte nicht gelesen werden (${res.error}). Du kannst neu beginnen – der alte Stand wird zur Sicherheit beiseitegelegt.`,
        [{ id: "exit", label: "Zurück", ghost: true }, { id: "new", label: "Neue Mine starten" }]);
      if (this.closed) return;
      if (choice !== "new") { this.close(); return; }
      this.saves.quarantineCorrupt();
      this._launch(null);
      return;
    }
    if (res.status === "backup") this.pendingNotice = "Der letzte Spielstand war beschädigt – die Sicherung wurde geladen.";
    if (this.saves.notice) this.pendingNotice = this.saves.notice;
    // a v4 mine brings its settings along once (they live on the device now)
    if (res.settings && !this.saves.hasSettings()) { this.settings = { ...this.settings, ...res.settings }; this.saves.saveSettings(this.settings); }
    this.found = res;
    this._showStart();
  }

  // ---- the start screen: continue the mine, start a new one, settings, back
  _showStart() {
    const el = this.el, res = this.found, has = !!(res && res.doc);
    const lg = has ? null : this.saves.legacy();
    this.legacyOffer = lg;
    el.loading.hidden = true;
    el.start.hidden = false;
    const mineCard = this.root.querySelector("[data-role=start-mine]");
    mineCard.hidden = !has;
    if (has) this._fillStats(this.root.querySelector("[data-role=start-stats]"), res.summary);
    this.root.querySelector("[data-role=start-dev]").hidden = !(has && res.summary && res.summary.devModified);
    const lgCard = this.root.querySelector("[data-role=start-legacy]");
    lgCard.hidden = !lg;
    if (lg) this._fillStats(this.root.querySelector("[data-role=legacy-stats]"), lg.summary);
    const cont = el.start.querySelector("[data-act=start-continue]"), fresh = el.start.querySelector("[data-act=start-new]");
    cont.hidden = !has;
    // no mine yet: starting one IS the main action (no empty "continue")
    fresh.className = has || lg ? "gr-btn-quiet gr-btn-wide" : "gr-btn-gold gr-btn-wide";
    fresh.textContent = has ? "Neue Mine" : "Neue Mine starten";
    this.root.querySelector("[data-role=start-tag]").textContent = has
      ? "Dein Claim wartet – der Berg ist noch lange nicht abgetragen."
      : "Ein Claim, ein riesiger Berg – und erst einmal nur deine Hände.";
    const first = has ? cont : lg ? lgCard.querySelector("button") : fresh;
    if (!this.touch) first.focus({ preventScroll: true });
  }

  _fillStats(dl, sum) {
    dl.innerHTML = "";
    if (!sum) return;
    const gear = [...sum.tools, ...sum.equipment].map((t) => TOOL_NAME[t] || t).join(" · ");
    const rows = [["Spielzeit", fmtPlay(sum.playMs)], ["Kontostand", formatEuro(sum.cashCents)], ["Goldbeutel", sum.pouchCents ? `≈ ${formatEuro(sum.pouchCents)}` : "leer"],
      ["Ausrüstung", gear], ["Bewegt", `${fmtKg(sum.kgMoved)} Erde`]];
    for (const [k, v] of rows) {
      const dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = k; dd.textContent = v;
      dl.append(dt, dd);
    }
  }

  async _startNew() {
    if (this.found && this.found.doc) {
      const ok = await this._confirmNewMine(this.found.summary);
      if (!ok || this.closed) return;
      this.saves.reset();
      this.found = null;
      this._launch(null, true);
      return;
    }
    this._launch(null);
  }

  // destructive: one clear question, saying what goes
  async _confirmNewMine(sum) {
    const what = sum ? ` (${fmtPlay(sum.playMs)} Spielzeit, ${formatEuro(sum.cashCents)}, ${[...sum.tools, ...sum.equipment].map((t) => TOOL_NAME[t] || t).join(", ")})` : "";
    const choice = await this._ask("Neue Mine starten?",
      `Dein aktueller GoldRush-Fortschritt${what} wird gelöscht und durch eine neue Mine ersetzt.`,
      [{ id: "cancel", label: "Abbrechen", ghost: true }, { id: "new", label: "Neue Mine", danger: true }]);
    return choice === "new";
  }

  _takeLegacy() {
    const r = this.saves.migrateLegacy();
    if (!r.ok) { this.found = this.saves.peek(); this._showStart(); return; }
    if (r.settings && !this.saves.hasSettings()) { this.settings = { ...this.settings, ...r.settings }; this.saves.saveSettings(this.settings); }
    this.pendingNotice = "Die Mine gehört jetzt deinem Konto.";
    this._launch(r.doc);
  }

  // the chosen mine (null = a new one) -> loading screen -> the game;
  // replaces = a mine was just given up: always a fresh seed
  async _launch(doc, replaces = false) {
    const el = this.el;
    el.start.hidden = true;
    el.loading.hidden = false;
    el.loading.classList.remove("is-done");
    this._progress(0.06, "Mine wird vorbereitet …");
    this._progress(0.1, "Grafik-Engine wird geladen …");
    const engine = await this.enginePromise;
    if (this.closed) return;
    if (!engine) { this._fallback("GoldRush konnte nicht geladen werden.", "Bitte prüfe deine Verbindung und versuche es gleich noch einmal."); return; }
    this.engine = engine;
    // a new mine: a fresh seed (tests may pin the very first one, never a replacement)
    if (!doc) doc = engine.newWorldDoc((replaces ? null : this._testSeed()) ?? newSeed());
    const game = (this.game = new engine.GoldRushGame(this._bridge(), doc, { touch: this.touch, debug: this.debug, settings: this.settings }));
    try {
      await game.init((p, text) => this._progress(p, text));
    } catch (e) {
      if (e === engine.ABORTED || this.closed) return;          // left while loading: close() already cleaned up
      console.error("[goldrush] start failed", e);
      game.dispose();
      this.game = null;
      if (!this.closed) this._fallback("GoldRush konnte nicht gestartet werden.", "Die 3D-Grafik ließ sich auf diesem Gerät nicht einrichten.");
      return;
    }
    if (this.closed) { game.dispose(); return; }
    game.save("start");                                         // the mine exists now (a new one, or migrated) - for this player only
    el.loading.classList.add("is-done");
    setTimeout(() => { if (this.el) this.el.loading.hidden = true; }, 420);
    el.hud.hidden = false;
    if (this.debug) el.debug.hidden = false;
    this._syncSettings();
    this._renderTools(game.toolState());
    if (this.pendingNotice || game.loadNotice) this.notice(this.pendingNotice || game.loadNotice);
    this.pendingNotice = null;
    if (this.devtools) this.devtools.attachGame();
    this.devStateChanged();
    this._checkDevSession();
    if (this.touch) {
      game.setPaused(false);
      if (window.matchMedia("(orientation: portrait)").matches) setTimeout(() => { if (!this.closed) this.notice("Tipp: Für mehr Übersicht das Gerät drehen."); }, 1800);
    } else {
      el.pauseText.textContent = "Klicke, um zu starten. Die Maus steuert dann den Blick.";
      el.pause.querySelector("[data-act=resume]").textContent = "Loslegen";
      el.pause.hidden = false;
      this._hintT = setTimeout(() => { if (this.el) this.el.hint.classList.add("is-faded"); }, 9000);
    }
    this._exposeTestHooks();
  }

  _bridge() {
    const el = this.el;
    return {
      root: this.root, canvas: el.canvas, stick: el.stick, knob: el.knob, digBtn: el.digBtn, moneyEl: el.money,
      writeSave: (doc) => this.saves.save(doc),
      saveSettings: (st) => { this.settings = { ...st }; this.saves.saveSettings(this.settings); },
      setCrosshair: (state) => { if (el.crosshair.dataset.state !== state) el.crosshair.dataset.state = state; },
      // the hands are on the bucket's bail / the barrow's grips: the dig button rests (the hint says why)
      setHandsBusy: (on) => { el.digBtn.classList.toggle("is-busy", on); el.digBtn.setAttribute("aria-disabled", on ? "true" : "false"); },
      onDig: () => {
        el.crosshair.classList.remove("is-pulse");
        void el.crosshair.offsetWidth;                // restart the tiny pulse
        el.crosshair.classList.add("is-pulse");
        el.tool.classList.add("is-working");
        el.digBtn.classList.add("is-stroke");
        clearTimeout(this._toolT);
        this._toolT = setTimeout(() => { if (this.el) { el.tool.classList.remove("is-working"); el.digBtn.classList.remove("is-stroke"); } }, 120);
      },
      showPauseOverlay: (show, failed) => {
        el.pauseText.textContent = failed
          ? "Die Maussteuerung wurde vom Browser nicht freigegeben. Klicke noch einmal ins Spiel."
          : "Klicke, um weiterzugraben.";
        this._pauseContract();
        el.pause.querySelector("[data-act=resume]").textContent = "Weiterspielen";
        el.pause.hidden = !show;
      },
      showGlLost: (show) => {
        if (show) this._showDialog("Grafikverbindung wurde unterbrochen.", "Die 3D-Grafik wird wiederhergestellt, sobald der Browser es erlaubt. Dein Fortschritt ist gespeichert.",
          [{ id: "exit", label: "GoldRush verlassen", ghost: true }]);
        else this._hideDialog();
      },
      notice: (t) => this.notice(t),
      setDebug: (t) => { el.debug.textContent = t; },
      toggleDebug: () => { el.debug.hidden = !el.debug.hidden; },
      panelOpen: () => !el.panel.hidden || !!this._openSheet || !!(this.devtools && this.devtools.active),
      openStation: (id, view) => this._showStation(id, view),
      onStation: (s) => {
        this._near = s;
        const label = !s ? "" : s.kind === "station" ? (s.id === "assay" ? "VERKAUFEN" : s.id === "contract" ? "AUFTRAG" : "AUSRÜSTUNG") : s.short || "";
        el.ctx.hidden = !label || !this.touch;
        el.ctx.textContent = label;
      },
      onQuality: () => this._syncSettings(),
      onTool: (st) => this._renderTools(st),
      // phase 9: in the excavator's cab - the dig button scoops (or hammers), KIPPEN dumps
      setCab: (on, breaker) => {
        el.altBtn.hidden = !(on && this.touch);
        if (on) { el.digIco.innerHTML = ICONS.excavator; el.digLabel.textContent = breaker ? "HAMMER" : "SCHAUFELN"; el.digBtn.setAttribute("aria-label", breaker ? "Hammern" : "Schaufeln (Bagger)"); el.digBtn.classList.remove("is-busy"); }
        else if (this.game) this._renderTools(this.game.toolState());
      },
    };
  }

  // toolbelt (desktop: always there; touch: a compact sheet behind the tool chip)
  _renderTools(st) {
    const el = this.el;
    if (!el || !st) return;
    for (const b of el.belt.querySelectorAll("[data-tool]")) {
      const t = st.order.find((o) => o.id === b.dataset.tool);
      const active = t.id === st.equipped;
      b.classList.toggle("is-active", active);
      b.classList.toggle("is-locked", !t.usable);
      b.setAttribute("aria-pressed", String(active));
      b.setAttribute("aria-label", `${t.label} (${t.key})${t.usable ? "" : " – noch nicht freigeschaltet"}`);
    }
    const cur = st.order.find((o) => o.id === st.equipped) || st.order[0];
    el.toolIco.innerHTML = ICONS[cur.id];
    el.toolName.textContent = cur.label;
    el.tool.setAttribute("aria-label", `Werkzeug: ${cur.label} – Werkzeuge zeigen`);
    el.digIco.innerHTML = ICONS[cur.id];
    el.digLabel.textContent = ACTION[cur.id];
    el.digBtn.setAttribute("aria-label", `${ACTION[cur.id].charAt(0)}${ACTION[cur.id].slice(1).toLowerCase()} (gedrückt halten)`);
    // the chip is a switch only when there is something to switch to
    el.tool.classList.toggle("has-choice", st.order.filter((o) => o.usable).length > 1 || !!st.prospect);
    // phase 9: the prospecting kit's three actions
    if (el.beltPro.hidden === !!st.prospect) el.beltPro.hidden = !st.prospect;
  }

  // the pause card: how far the mountain contract has come (phase 9)
  _pauseContract() {
    const g = this.game, el = this.el;
    if (!el || !el.pauseContract) return;
    const line = g && g.contract ? g.contract.line() : "";
    el.pauseContract.textContent = line;
    el.pauseContract.hidden = !line;
  }

  _toolSheet(open) {
    if (!this.el) return;
    this._sheetOpen = !!open && this.touch;
    this.el.belt.classList.toggle("is-open", this._sheetOpen);
    this.el.tool.setAttribute("aria-expanded", String(this._sheetOpen));
  }

  _act(act) {
    const g = this.game;
    if (act === "exit") { this.close(); return; }
    if (act === "start-continue") { if (this.found && this.found.doc) this._launch(this.found.doc); return; }
    if (act === "start-new") { this._startNew(); return; }
    if (act === "start-settings") { this._openSettings(); return; }
    if (act === "legacy-take") { this._takeLegacy(); return; }
    if (act === "new-mine") { this._newMineInGame(); return; }
    if (act === "resume") {
      if (!g) return;
      if (this.touch) { g.setPaused(false); this.el.pause.hidden = true; } else g.input.requestLock();
      return;
    }
    if (act === "settings") { this._openSettings(); return; }
    if (act === "dev") { this._openDev(!this.el.panel.hidden ? "settings" : "pause"); return; }
    if (act === "use-station") { if (!g) return; if (g.processing.work) g._workAction(); else if (this._near) g.useStation(); return; }
    if (act === "close-station") { this._closeStation(true); return; }
    if (act === "sell-all") { this._sellAll(); return; }
    if (act === "tools") { if (this.touch) this._toolSheet(!this._sheetOpen); return; }
    // phase 9: prospecting from the belt (the phone's way to R / F / N)
    if (act === "sample" || act === "flag" || act === "notebook") {
      this._toolSheet(false);
      if (!g || g.paused && !this.touch) return;
      if (act === "sample") g.sample(); else if (act === "flag") g.flagAtCrosshair(); else g.openNotebook();
      return;
    }
    // GoldRush 9.1: the notebook's two actions
    if (act === "nb-collect" || act === "nb-reset") { this._notebookAction(act); return; }
    if (act === "close-settings") { this._closeSettings(); return; }
    if (act.startsWith("dlg:")) { const r = this._dlgResolve; this._hideDialog(); if (r) r(act.slice(4)); else if (act === "dlg:exit") this.close(); }
  }

  // ------------------------------------------------------------ camp: selling + supplies

  _showStation(id, view) {
    this._openSheet = id;
    for (const [k, el] of Object.entries(this.el.sheets)) el.hidden = k !== id;
    this.el.ctx.hidden = true;
    if (id === "assay") this._renderSell(view);
    else if (id === "contract") this._renderContract(view);
    else if (id === "notebook") this._renderNotebook(view);
    else this._renderShop(view);
    const f = this.el.sheets[id].querySelector(id === "assay" ? "[data-act=sell-all]" : ".gr-sheet-close");
    if (f && !this.touch) f.focus({ preventScroll: true });
  }

  _closeStation(resume) {
    if (!this._openSheet) return;
    if (this._sale) { this._sale.skip = true; this._saleStep(performance.now()); }
    this._openSheet = null;
    for (const el of Object.values(this.el.sheets)) el.hidden = true;
    if (this.game) this.game.closeStation(resume);
    if (this._near && this.touch) this.el.ctx.hidden = false;
  }

  // phase 9: the mountain contract - the order, the numbers, what the progress unlocks
  _renderContract(v) {
    const box = this.el.contract;
    box.innerHTML = "";
    const add = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; e.textContent = text; box.appendChild(e); return e; };
    add("p", "gr-contract-order", "Der Berg auf diesem Claim muss vollständig abgetragen werden. Das Gold, das darin steckt, bezahlt Werkzeug und Maschinen – je tiefer das Loch im Berg, desto größere Maschinen werden freigegeben.");
    const dl = document.createElement("dl");
    dl.className = "gr-contract-stats";
    for (const [k, val] of [["Ursprünglicher Berg", `${v.text.v0} · ≈ ${v.text.t0}`], ["Abgetragen", `${v.text.removed} · ${v.text.t}`], ["Verbleibend", v.text.remaining], ["Fortschritt", v.text.pct]]) {
      const dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = k; dd.textContent = val;
      dl.append(dt, dd);
    }
    box.appendChild(dl);
    const bar = add("div", "gr-contract-bar", "");
    const fill = document.createElement("i");
    fill.style.width = `${Math.max(0.6, Math.min(100, v.pct)).toFixed(2)}%`;
    bar.appendChild(fill);
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", `${v.text.pct} des Bergs abgetragen`);
    add("div", "gr-shop-group", "Freigaben nach Fortschritt");
    const ul = document.createElement("ul");
    ul.className = "gr-contract-steps";
    for (const s of v.steps) {
      const li = document.createElement("li");
      li.className = s.met ? "is-met" : "";
      li.textContent = `${s.met ? "✓" : "○"} ${s.label} – ab ${s.pctText} abgetragen`;
      ul.appendChild(li);
    }
    box.appendChild(ul);
    add("p", "gr-contract-note", "Gezählt wird nur, was vom ursprünglichen Berg abgetragen ist – nicht das Graben in der Ebene oder auf dem Lagerplatz.");
  }

  // GoldRush 9.1: collect every flag (the notebook stays) / reset prospecting (asked first)
  async _notebookAction(act) {
    const g = this.game;
    if (!g || !g.processing.prospect) return;
    if (act === "nb-collect") {
      const r = g.collectFlags();
      if (r) g.hud.message(r.collected ? `${r.collected} ${r.collected === 1 ? "Fähnchen" : "Fähnchen"} eingesammelt` : "Keine Fähnchen gesteckt", "Das Notizbuch bleibt, wie es ist.");
    } else {
      const pg = g.processing.prospect, kept = pg.bags.length + (g.processing.pan.sample ? 1 : 0);
      const text = "Löscht das Notizbuch, alle Fähnchen und die Nummerierung – die nächste Probe ist wieder Probe 1."
        + " Das Gelände bleibt, wie es ist: entnommenes Material kommt nicht zurück, Gold wächst nicht nach."
        + (kept ? ` ${kept} noch nicht ausgewaschene ${kept === 1 ? "Probe behält ihr Material und heißt dann Probe 1" : `Proben behalten ihr Material und heißen dann Probe 1–${kept}`}.` : "");
      const id = await this._ask("Prospektion zurücksetzen?", text, [{ id: "cancel", label: "Abbrechen", ghost: true }, { id: "reset-prospect", label: "Zurücksetzen", danger: true }]);
      if (id !== "reset-prospect" || this.closed || this.game !== g) return;
      const r = g.resetProspect();
      if (r) g.hud.message("Prospektion zurückgesetzt", `Nächste Probe: Probe ${r.next}.`);
    }
    if (this._openSheet === "notebook") this._renderNotebook(g.processing.prospect.view());
  }

  // phase 9: the prospecting notebook - the last samples as plain lines (no colours, no verdict)
  _renderNotebook(v) {
    const box = this.el.notebook;
    box.innerHTML = "";
    this.el.nbSub.textContent = `${v.notes.length} / ${v.max.notes} Einträge · ${v.bags.length} / ${v.max.bags} Beutel gefüllt · ${v.flags.length} / ${v.max.flags} Fähnchen · nächste: Probe ${v.next}`;
    if (v.bags.length) {
      const h = document.createElement("div");
      h.className = "gr-shop-group";
      h.textContent = "Noch nicht ausgewaschen";
      box.appendChild(h);
      for (const b of v.bags) {
        const row = document.createElement("div");
        row.className = "gr-nb-row is-pending";
        row.textContent = `Probe ${b.n}${b.flagged ? " ⚑" : ""} · ${b.place} · ${b.depth.toFixed(2).replace(".", ",")} m tief · ${b.mat} · ${(b.ml / 1000).toFixed(2).replace(".", ",")} l`;
        box.appendChild(row);
      }
    }
    const h = document.createElement("div");
    h.className = "gr-shop-group";
    h.textContent = "Ausgewaschen (neueste zuerst)";
    box.appendChild(h);
    if (!v.notes.length) {
      const p = document.createElement("p");
      p.className = "gr-nb-empty";
      p.textContent = "Noch keine Probe ausgewaschen. [R] nimmt eine Probe unter dem Fadenkreuz, am Waschtrog wäschst du sie aus.";
      box.appendChild(p);
      return;
    }
    for (const q of v.notes) {
      const row = document.createElement("div");
      row.className = "gr-nb-row";
      const a = document.createElement("div"), b = document.createElement("div");
      a.className = "gr-nb-head"; b.className = "gr-nb-data";
      a.textContent = `${q.head}${q.flagged ? ` · ⚑ Fähnchen ${q.n}` : ""} · ${q.where}`;
      b.textContent = `${q.amount} → ${q.gold} · ${q.grade}`;
      row.append(a, b);
      box.appendChild(row);
    }
  }

  _renderSell(v) {
    const el = this.el;
    el.sellList.innerHTML = "";
    const rows = v.classes.filter((c) => c.count > 0);
    if (!rows.length) {
      const li = document.createElement("li");
      li.className = "gr-sell-empty";
      li.textContent = v.first ? "Noch kein Gold im Beutel. Grab am Berg – jeder Fund landet zuerst hier im Goldbeutel." : "Dein Goldbeutel ist leer.";
      el.sellList.appendChild(li);
    }
    for (const c of rows) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="gr-sell-name"></span><span class="gr-sell-count"></span><span class="gr-sell-mass"></span><span class="gr-sell-value"></span>`;
      li.children[0].textContent = CLASS_LABEL[c.id] || c.id;
      li.children[1].textContent = `${c.count}×`;
      li.children[2].textContent = formatMass(c.ug);
      li.children[3].textContent = formatEuro(c.cents);
      el.sellList.appendChild(li);
    }
    el.weigh.textContent = v.ug ? formatMass(v.ug) : "–";
    el.worth.textContent = v.ug ? `≈ ${formatEuro(v.cents)}` : "–";
    el.sellCash.textContent = `Kontostand ${formatEuro(v.cash)}`;
    el.sellBtn.disabled = !v.ug;
    el.sellBtn.textContent = v.ug ? `Alles verkaufen · ${formatEuro(v.cents)}` : "Nichts zu verkaufen";
  }

  // SELL ALL: the transaction happens at once (game.sell), the scale only shows it:
  // weight settles -> value counts up -> cash. Tap / click skips to the end.
  _sellAll() {
    const g = this.game;
    if (!g || this._sale) return;
    const before = g.economy.cashCents;
    const r = g.sell();
    if (!r.ok) { this._renderSell(g.sellView()); return; }
    this.el.sellBtn.disabled = true;
    this.el.sellList.classList.add("is-selling");
    const reduced = g.reducedMotion;
    const dur = reduced ? 0.35 : Math.min(1.8, Math.max(0.8, 0.8 + Math.log10(1 + r.cents) * 0.3));
    this._sale = { r, before, after: g.economy.cashCents, t0: performance.now(), dur, skip: false };
    this._saleRaf = requestAnimationFrame((t) => this._saleStep(t));
  }

  _saleStep(now) {
    const s = this._sale;
    if (!s || !this.el) return;
    const u = s.skip ? 1 : Math.min(1, (now - s.t0) / 1000 / s.dur);
    // weight: settles with a small wobble in the first half; value: counts up in the second
    const wU = Math.min(1, u / 0.5), vU = Math.max(0, Math.min(1, (u - 0.45) / 0.4)), cU = Math.max(0, (u - 0.85) / 0.15);
    const wob = u >= 1 ? 1 : 1 - Math.exp(-5 * wU) * Math.cos(11 * wU);
    this.el.weigh.textContent = formatMass(Math.max(0, Math.round(s.r.ug * Math.min(1.08, wob))));
    this.el.worth.textContent = formatEuro(Math.round(s.r.cents * vU * vU * (3 - 2 * vU)));
    this.el.sellCash.textContent = `Kontostand ${formatEuro(Math.round(s.before + (s.after - s.before) * Math.min(1, cU)))}`;
    if (u < 1) { this._saleRaf = requestAnimationFrame((t) => this._saleStep(t)); return; }
    cancelAnimationFrame(this._saleRaf);
    this._sale = null;
    this.el.sellList.classList.remove("is-selling");
    this.el.weigh.textContent = formatMass(s.r.ug);
    this.el.worth.textContent = formatEuro(s.r.cents);
    this.el.sellCash.textContent = `Verkauft für ${formatEuro(s.r.cents)} · Kontostand ${formatEuro(s.after)}`;
    this.el.sellList.innerHTML = `<li class="gr-sell-empty">Dein Goldbeutel ist leer. Bei der Ausrüstung nebenan kannst du dein Geld ausgeben.</li>`;
    this.el.sellBtn.disabled = true;
    this.el.sellBtn.textContent = "Verkauft";
  }

  _renderShop(v) {
    const el = this.el;
    el.shopCash.textContent = `Kontostand ${formatEuro(v.cash)}` + (v.pouch > 0 ? ` · im Goldbeutel ≈ ${formatEuro(v.pouch)} (erst verkaufen)` : "");
    el.shopList.innerHTML = "";
    for (const [kind, tool, title] of SHOP_GROUPS) {
      const items = v.items.filter((it) => it.kind === kind && (tool == null || it.tool === tool));
      if (!items.length) continue;
      const h = document.createElement("div");
      h.className = "gr-shop-group";
      h.textContent = title;
      el.shopList.appendChild(h);
      for (const it of items) el.shopList.appendChild(this._shopRow(it, v.cash));
    }
  }

  _shopRow(it, cash) {
    const row = document.createElement("div");
    row.className = `gr-shop-item is-${it.state}` + (it.affordable ? " is-affordable" : "");
    row.dataset.item = it.id;
    const ico = it.kind === "equipment" ? ICONS[it.id] || ICONS.bucket : ICONS[it.tool] || ICONS.shovel;
    row.innerHTML = `<div class="gr-shop-ico">${ico}${it.kind === "upgrade" ? '<span class="gr-shop-plus">+</span>' : ""}</div>
      <div class="gr-shop-main"><div class="gr-shop-name"></div><div class="gr-shop-text"></div><div class="gr-shop-state"></div></div>
      <div class="gr-shop-buy"><div class="gr-shop-price"></div></div>`;
    row.querySelector(".gr-shop-name").textContent = it.label;
    row.querySelector(".gr-shop-text").textContent = it.text;
    row.querySelector(".gr-shop-price").textContent = it.state === "owned" ? "" : formatEuro(it.price);
    const state = row.querySelector(".gr-shop-state"), buyBox = row.querySelector(".gr-shop-buy");
    if (it.state === "owned") {
      state.textContent = it.kind === "upgrade" ? "✓ Eingebaut" : "✓ In deinem Besitz";
    } else if (it.state === "locked") {
      state.textContent = "🔒 " + it.needs.map((n) => `${n.met ? "✓" : "○"} ${n.text}`).join(" · ");
    } else {
      // how close you are: € 6,42 / € 10,00 - a quiet line, no progress bar spam
      const have = Math.min(cash, it.price);
      state.innerHTML = it.affordable ? "Bereit zum Kauf" : `<span class="gr-shop-progress"><i style="width:${Math.round((have / it.price) * 100)}%"></i></span>${formatEuro(cash)} / ${formatEuro(it.price)} · noch ${formatEuro(it.missing)} benötigt`;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "gr-btn-gold gr-btn-sm";
      b.dataset.buy = it.id;
      b.textContent = "Kaufen";
      b.disabled = !it.affordable;
      buyBox.appendChild(b);
    }
    return row;
  }

  // BUY: one transaction (game.buy); a second click finds the item owned
  _buy(id, btn) {
    const g = this.game;
    if (!g || this._buying) return;
    this._buying = true;
    if (btn) btn.disabled = true;
    const r = g.buy(id);
    this._renderShop(g.shopView());
    if (r.ok) {
      const row = this.el.shopList.querySelector(`[data-item="${id}"]`);
      if (row) { row.classList.add("is-bought"); }
      const it = g.shopView().items.find((x) => x.id === id);
      g._afterClose = () => g.hud.message(`${it ? it.label : "Ausrüstung"} gekauft`, it && it.kind === "tool" ? "Liegt jetzt in deinen Händen." : it && it.kind === "equipment" ? EQUIP_WHERE[it.id] : "Ab sofort eingebaut.");
    }
    this._buying = false;
    return r;
  }

  _openSettings() {
    this.el.panel.hidden = false;
    this.el.pause.hidden = true;
    // before a mine is chosen: only the device settings, no new-mine button
    this.root.querySelector("[data-role=danger-zone]").hidden = !this.game;
    this.root.querySelector("[data-role=dev-entry]").hidden = !this.game;
    this.el.panel.querySelector("[data-act=close-settings]").textContent = this.game ? "Zurück zum Spiel" : "Fertig";
    if (this.game) { this.game.setPaused(true); this.game.input.exitLock(); }
    this._syncSettings();
    const first = this.el.panel.querySelector(".gr-seg button[aria-checked=true]") || this.el.panel.querySelector("button");
    if (first) first.focus({ preventScroll: true });
  }

  _closeSettings() {
    this.el.panel.hidden = true;
    if (!this.game) { const b = this.el.start.querySelector("[data-act=start-settings]"); if (b && !this.el.start.hidden && !this.touch) b.focus({ preventScroll: true }); return; }
    if (this.touch) this.game.setPaused(false);
    else { this.el.pauseText.textContent = "Klicke, um weiterzugraben."; this.el.pause.hidden = false; }
  }

  // the panel reflects the device settings (and, in a running mine, what the game made of them)
  _syncSettings() {
    const g = this.game;
    const s = g ? g.settings : this.settings;
    const sysRM = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const reduced = g ? g.reducedMotion : sysRM || !!s.reducedMotion;
    for (const b of this.root.querySelectorAll("[data-q]")) b.setAttribute("aria-checked", String(b.dataset.q === s.quality));
    const names = { low: "Niedrig", medium: "Mittel", high: "Hoch" };
    this.root.querySelector("[data-role=q-note]").textContent = s.quality === "auto"
      ? (g ? `Auto nutzt gerade: ${names[g.level]} – passt sich an, wenn es ruckelt.` : "Auto wählt beim Start passend zu deinem Gerät.") : "Gilt sofort, ohne Neustart.";
    const bob = this.root.querySelector("[data-role=headbob]");
    bob.checked = !!s.headBob && !reduced;
    bob.disabled = reduced;
    const rm = this.root.querySelector("[data-role=reduced]");
    rm.checked = reduced;
    rm.disabled = g ? g.systemReducedMotion : sysRM;
    this.root.querySelector("[data-role=bob-note]").hidden = !(g ? g.systemReducedMotion : sysRM);
    this.root.querySelector("[data-role=sound]").checked = s.sound !== false;
    const canVibrate = this.touch && typeof navigator.vibrate === "function";
    this.root.querySelector("[data-role=vibration-row]").hidden = !canVibrate;
    this.root.querySelector("[data-role=vibration]").checked = s.vibration !== false;
    this.root.classList.toggle("gr-reduced", reduced);
  }

  _setSetting(key, value) {
    this.settings = { ...this.settings, [key]: value };
    this.saves.saveSettings(this.settings);
  }

  // settings -> "Neue Mine starten …": confirm, then a fresh mine right away
  async _newMineInGame() {
    const g = this.game;
    if (!g) return;
    g.flushLoot();
    g.save("before-new-mine");
    const ok = await this._confirmNewMine(this._liveSummary());
    if (!ok || this.closed || this.game !== g) return;
    this._swapMine(null, { reset: true });
  }

  /**
   * The running mine makes way for another one: `doc` (written first when
   * `write`), a new mine (`reset`), or - doc null - the mine as it is stored
   * now (reload). The old game saves and hands its GL context back
   * (forceContextLoss): the next one gets a fresh canvas.
   */
  _swapMine(doc, { reset = false, write = false, notice = null } = {}) {
    const g = this.game;
    if (!g) return;
    if (this.devtools) this.devtools.hide();
    this.el.panel.hidden = true;
    this.el.hud.hidden = true;
    this.el.pause.hidden = true;
    for (const el of Object.values(this.el.sheets)) el.hidden = true;
    this._openSheet = null;
    g.dispose();
    this.game = null;
    if (window.__goldrush) delete window.__goldrush;
    const fresh = document.createElement("canvas");
    fresh.className = "gr-canvas";
    fresh.tabIndex = -1;
    this.el.canvas.replaceWith(fresh);
    this.el.canvas = fresh;
    this.pendingNotice = notice;
    if (reset) {
      this.saves.reset();
      this.found = null;
      this._launch(null, true);
      return;
    }
    if (doc && write) { try { this.saves.save(doc); } catch (e) { /* the launch saves it again */ } }
    if (!doc) doc = this.saves.load().doc;
    this._launch(doc || null);
  }

  // ------------------------------------------------------------ developer / QA tools

  // pause menu / settings -> "Entwicklertools": the server decides (goldrush-devtools.js)
  async _openDev(from) {
    const g = this.game;
    if (!g || this._devLoading) return;
    this._devLoading = true;
    let mod = null;
    try { mod = await import("./goldrush-devtools.js"); } catch (e) { mod = null; }
    this._devLoading = false;
    if (this.closed || this.game !== g) return;
    if (!mod) { this.notice("Die Entwicklertools konnten nicht geladen werden."); return; }
    if (!this.devtools) this.devtools = new mod.GoldRushDevTools(this);
    this.el.panel.hidden = true;
    this.el.pause.hidden = true;
    g.setPaused(true);
    g.input.exitLock();
    this.devtools.enter(from);
  }

  // the panel closed: back where it was opened
  devReturn(from) {
    this.devStateChanged();
    if (!this.game) return;
    if (from === "settings") { this._openSettings(); return; }
    if (this.touch) { this.game.setPaused(false); return; }
    this.el.pauseText.textContent = "Klicke, um weiterzugraben.";
    this.el.pause.querySelector("[data-act=resume]").textContent = "Weiterspielen";
    this.el.pause.hidden = false;
    const b = this.el.pause.querySelector("[data-act=dev]");
    if (b) b.focus({ preventScroll: true });
  }

  devReloadMine(doc, notice, write = false) { this._swapMine(doc, { write, notice }); }

  devFreshMine() { this._swapMine(null, { reset: true, notice: "Frische Mine angelegt." }); }

  // DEV / DEV-MODIFIED next to the entry (pause menu, settings)
  devStateChanged() {
    if (!this.root) return;
    const on = !!((this.devtools && this.devtools.unlocked) || this._devSession);
    const mod = !!(this.game && this.game.devModified);
    for (const el of this.root.querySelectorAll("[data-role=dev-label]")) el.textContent = on ? "Entwicklertools ✓" : "Entwicklertools";
    for (const el of this.root.querySelectorAll("[data-role=dev-badge]")) el.hidden = !on;
    for (const el of this.root.querySelectorAll(".gr-dev-entry [data-role=dev-flag]")) el.hidden = !mod;
  }

  // a developer session of this browser tab (unlocked earlier): ask the server once whether it still holds
  async _checkDevSession() {
    if (this._devChecked || !this.api) return;
    this._devChecked = true;
    let has = false;
    try { const s = JSON.parse(sessionStorage.getItem("goldrush.devSession") || "null"); has = !!(s && s.user === this.saves.player.id); } catch (e) { has = false; }
    if (!has) return;
    try {
      const { DevAccess } = await import("./goldrush-devaccess.js");
      const st = await new DevAccess(this.api, this.saves.player).status();
      this._devSession = !!st.unlocked;
    } catch (e) { this._devSession = false; }
    this.devStateChanged();
  }

  _liveSummary() {
    const g = this.game;
    if (!g) return null;
    const e = g.economy, m = e.stats.massG;
    return { playMs: e.stats.playTimeMs, cashCents: e.cashCents, pouchCents: e.pouchCents, tools: g.tools.ownedList(), equipment: g.processing ? g.processing.ownedList() : [],
      kgMoved: Math.round((m.dirt + m.compactDirt + m.gravel + m.stone) / 1000) };
  }

  // fixed world seed for automated tests (goldrush.testSeed), never in normal play
  _testSeed() {
    if (!(this.debug || navigator.webdriver)) return null;
    try {
      const v = localStorage.getItem("goldrush.testSeed");
      return v != null && /^\d+$/.test(v) ? Number(v) : null;
    } catch (e) { return null; }
  }

  notice(text) {
    const n = this.el.notice;
    n.textContent = text;
    n.hidden = false;
    clearTimeout(this._noticeT);
    this._noticeT = setTimeout(() => { n.hidden = true; }, 6000);
  }

  _progress(p, text) {
    const pct = Math.round(Math.max(0, Math.min(1, p)) * 100);
    this.el.progress.querySelector("span").style.width = `${pct}%`;
    this.el.progress.setAttribute("aria-valuenow", String(pct));
    if (text) this.el.loadStep.textContent = text;
  }

  _fallback(title, text) {
    this.el.loading.hidden = true;
    this._showDialog(title, text, [{ id: "exit", label: "Zurück zum Chat" }]);
  }

  _ask(title, text, buttons) {
    return new Promise((resolve) => { this._dlgResolve = resolve; this._showDialog(title, text, buttons); });
  }

  _showDialog(title, text, buttons) {
    const d = this.el.dialog;
    d.querySelector("[data-role=dlg-title]").textContent = title;
    d.querySelector("[data-role=dlg-text]").textContent = text;
    const box = d.querySelector("[data-role=dlg-actions]");
    box.innerHTML = "";
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = b.ghost ? "ghost-btn" : b.danger ? "primary-btn danger-btn" : "primary-btn";
      btn.dataset.act = `dlg:${b.id}`;
      btn.textContent = b.label;
      box.appendChild(btn);
    }
    d.hidden = false;
    const last = box.lastElementChild;
    if (last) last.focus({ preventScroll: true });
  }

  _hideDialog() {
    this.el.dialog.hidden = true;
    this._dlgResolve = null;
  }

  // test / debug handle - only for automated tests (webdriver) or ?goldrush-debug
  _exposeTestHooks() {
    if (!(this.debug || navigator.webdriver)) return;
    const g = this.game;
    window.__goldrush = {
      state: () => ({
        x: g.player.x, y: g.player.y, z: g.player.z, yaw: g.player.yaw, pitch: g.player.pitch, camY: g.camera.position.y,
        paused: g.paused, running: g.running, locked: g.input.locked, free: g.input.free, level: g.level, quality: g.settings.quality,
        digs: g.digs, strokes: g.economy.stats.totalDigs, money: g.money, moneyCents: g.economy.moneyCents, seed: g.doc.worldSeed,
        target: !!g.target, targetDist: g.target ? g.target.distance : null, aim: g.aimState, digHeld: g.input.digHeld, revision: g.terrain.revision,
        headBob: g.settings.headBob, reducedMotion: g.reducedMotion, touch: this.touch,
      }),
      info: () => g.info(),
      pose: ({ x, z, yaw, pitch }) => {
        const p = g.player;
        if (x != null) p.x = x;
        if (z != null) p.z = z;
        if (yaw != null) p.yaw = yaw;
        if (pitch != null) p.pitch = pitch;
        p.vx = p.vz = 0;
        p.y = g.world.groundAt(p.x, p.z) + 1.62;
        g._updateCamera();
        g._aim();
        g.render();
        return !!g.target;
      },
      // n mining transactions at the crosshair (no hand animation); visuals:false = booked right away
      digAtCrosshair: (n = 1, opts = {}) => {
        let done = 0, cents = 0, finds = 0, blocked = 0, best = 0;
        const t0 = performance.now(), keys = [];
        for (let i = 0; i < n; i++) {
          const r = g.strokeAtCrosshair(opts);
          if (!r) continue;
          if (r.blocked) blocked++;
          else if (r.massKg > 0) { done++; cents += r.cents; finds += r.finds; best = Math.max(best, r.best || 0); if (r.keys) keys.push(...r.keys); }
        }
        const ms = performance.now() - t0;
        if (opts.visuals !== false) g.render();
        return { done, blocked, cents, finds, best, keys, ms, perDig: done ? ms / done : 0, last: g.lastStroke };
      },
      economy: () => ({ ...g.economy.serialize(), sessionCents: g.economy.sessionCents, shownCents: g.hud.shown, pouchCents: g.economy.pouchCents, pouchUg: g.economy.pouchUg, shownPouch: g.hud.pouch.shown }),
      // the camp (selling / buying): what the UI does, without the UI
      sell: () => g.sell(),
      buy: (id) => g.buy(id),
      sellView: () => g.sellView(),
      shopView: () => g.shopView(),
      openStation: (id) => g.openStation(id),
      closeStation: () => { this._closeStation(false); return !g.uiOpen; },
      uiState: () => ({ open: this._openSheet, uiOpen: g.uiOpen, near: g.station ? g.station.id : null, inputEnabled: g.input.enabled, ctx: !this.el.ctx.hidden, sale: !!this._sale,
        prompt: this.root.querySelector(".gr-prompt").hidden ? null : this.root.querySelector(".gr-prompt").textContent,
        objective: this.root.querySelector(".gr-objective").hidden ? null : this.root.querySelector(".gr-objective").textContent }),
      // stand in front of a station, facing it
      goToStation: (id) => { const st = this.engine.STATIONS.find((x) => x.id === id); const yaw = Math.atan2(-(st.lookX - st.x), -(st.lookZ - st.z)); const p = g.player; p.x = st.x; p.z = st.z; p.yaw = yaw; p.pitch = -0.15; p.vx = p.vz = 0; p.y = g.world.groundAt(p.x, p.z) + 1.62; g._updateCamera(); g._stationTick(0.6); g.render(); return g.station ? g.station.id : null; },
      setCash: (cents) => { g.economy.cashCents = Math.max(0, Math.round(cents)); g.hud.setMoney(g.economy.cashCents); return g.economy.cashCents; },
      flags: () => ({ ...g.economy.flags }),
      // phase 5: processing (bucket / classifier / gold pan) - the real transactions, without walking
      proc: () => {
        const pr = g.processing, b = pr.bucket;
        return { owned: pr.ownedList(), work: pr.work, panDone: pr.panDone, panTool: pr.pan.tool, washTool: pr.washTool(), carrying: pr.carrying, capacityMl: pr.capacityMl, recoveryMul: pr.recoveryMul,
          bucket: b ? { x: b.x, z: b.z, carried: b.carried, atWash: pr.bucketAtWash(), batch: b.batch.serialize(), massG: b.batch.massG, goldUg: b.batch.goldUg } : null,
          tub: { ...pr.tub.serialize(), massG: pr.tub.massG, goldUg: pr.tub.goldUg }, pan: { ...pr.pan.batch.serialize(), progress: pr.pan.progress, need: pr.pan.need, goldUg: pr.pan.batch.goldUg },
          sieve: { ...pr.sieve.batch.serialize(), progress: pr.sieve.progress }, ledger: { ...pr.ledger }, inContainersUg: pr.goldInContainers(), inContainersG: pr.massInContainers(),
          speed: pr.speedFactor(), interaction: pr.interaction(g.player), station: g.station ? { id: g.station.id, kind: g.station.kind, action: g.station.action } : null,
          held: g.hands.held || (g.hands.barrow && g.hands.barrow.handsOn > 0 ? "barrow" : null), mining: g.mining.stats(),
          barrow: pr.barrow ? { x: pr.barrow.x, z: pr.barrow.z, yaw: pr.barrow.yaw, pushing: pr.barrow.pushing, dumping: !!pr.barrow.dump, batch: pr.barrow.batch.serialize(),
            massG: pr.barrow.batch.massG, goldUg: pr.barrow.batch.goldUg, capacityMl: pr.barrow.capacityMl, theta: pr.barrow.theta, atWash: pr.barrowAtWash(),
            y: pr.barrow.group.position.y, ground: g.world.groundAt(pr.barrow.x, pr.barrow.z), fill: pr.barrow.group.userData.fill.visible } : null,
          sluice: pr.sluice ? { state: pr.sluice.state, building: pr.sluice.build >= 0, running: pr.sluice.running, processing: pr.sluice.processing, capacityMl: pr.sluice.capacityMl,
            hopper: pr.sluice.hopper.batch.serialize(), riffles: pr.sluice.riffles.serialize(), tray: pr.sluice.tray.batch.serialize(), loadMl: pr.sluice.loadMl, tailMl: pr.sluice.tailMl,
            efficiency: pr.sluice.efficiency(), stats: { ...pr.sluice.stats }, goldUg: pr.sluice.goldUg(), heap: pr.sluice.model.userData.heap.visible } : null,
          bulk: pr.bulk ? { state: pr.bulk.state, building: pr.bulk.build >= 0, volumeMl: pr.bulk.volumeMl, capacityMl: pr.bulk.capacityMl, goldUg: pr.bulk.goldUg(), massG: pr.bulk.massG(),
            fineUg: pr.bulk.buffer.fineUg, pieces: pr.bulk.buffer.pieces, layers: pr.bulk.buffer.layers.map((l) => ({ id: l.id, ml: l.volumeMl, ug: l.goldUg, g: l.massG, source: l.source })),
            gateOpen: pr.bulk.gateOpen, gate: pr.bulk.gate.state, stats: { ...pr.bulk.stats }, fill: pr.bulk.model.userData.fill.visible, decks: g.world.decks.length } : null,
          feeder: pr.feeder ? { state: pr.feeder.state, building: pr.feeder.build >= 0, mode: pr.feeder.mode, running: pr.feeder.running, status: pr.feeder.status(), rateLpm: pr.feeder.rateLpm,
            trayMl: pr.feeder.tray.volumeMl, trayUg: pr.feeder.tray.goldUg, inState: pr.feeder.inLink.state, outState: pr.feeder.outLink.state, moved: pr.feeder.outLink.moved, rateNow: pr.feeder.outLink.rateNow } : null };
      },
      // phase 6: the sluice runs for `s` seconds of game time (no frames drawn)
      procTick: (sec) => g.processing.tickSim(sec),
      procObj: () => g.processing,
      // phase 8: the barrow's push state, the arms as drawn, a column's stone state, authored models
      barrowState: () => (g.processing.barrow ? g.processing.barrow.state() : null),
      armReport: () => g.hands.armReport(),
      stoneAt: (x, z) => { const t = g.terrain, i = Math.round((x - t.x0) / t.cell), j = Math.round((z - t.z0) / t.cell); return t.stoneState(j * t.vps + i); },
      assetModel: async (url, fallback = false) => {
        if (fallback) { const T = g.assets.THREE, o = await g.assets.modelOr(url, () => { const m = new T.Mesh(new T.BoxGeometry(0.1, 0.1, 0.1)); m.name = "procedural"; return m; }); let n = 0; o.traverse((x) => { if (x.isMesh) n++; }); return { name: o.name, meshes: n }; }
        const m = await g.assets.model(url);
        if (!m) return null;
        let n = 0; m.scene.traverse((x) => { if (x.isMesh) n++; });
        return { meshes: n, cached: !!g.assets.get(`glb:${url}`), instance: !!g.assets.instance(url) };
      },
      // phase 6: dig feel - impacts straight into the effects (no mining), their stats; a real contact
      fxClear: () => { g.effects.clear(); return g.effects.stats(); },
      // phase 7A: the luminance band of the fragments in the air / lying (no black lumps, no white sparks)
      fxColors: () => {
        const e = g.effects, c = e.frags.instanceColor && e.frags.instanceColor.array;
        let lo = 9, hi = 0, n = 0;
        if (c) e.fragState.forEach((f, i) => { if (!f.on) return; const l = 0.2126 * c[i * 3] + 0.7152 * c[i * 3 + 1] + 0.0722 * c[i * 3 + 2]; lo = Math.min(lo, l); hi = Math.max(hi, l); n++; });
        return { lo: n ? lo : null, hi: n ? hi : null, n };
      },
      fxImpact: (mat, tool, n = 1, dt = 0) => {
        g._aim();
        const hit = g.target || { x: g.player.x, y: g.world.groundAt(g.player.x, g.player.z), z: g.player.z - 1, normal: { x: 0, y: 1, z: 0 } };
        for (let i = 0; i < n; i++) { g.effects.impact(hit, mat, tool, g._toolDir(), 1); if (dt) g.effects.update(dt); }
        return g.effects.stats();
      },
      fxUpdate: (sec, step = 1 / 60) => { for (let t = 0; t < sec; t += step) g.effects.update(step); return g.effects.stats(); },
      fxStats: () => ({ ...g.effects.stats(), pools: g.effects.pools(), impacts: g.effects.impacts, trickles: g.effects.trickles, spills: g.effects.spills || 0 }),
      contact: () => { g.player.kick = 0; g.hands.shake = 0; g._contact(); return { kick: g.player.kick, shake: g.hands.shake, stroke: g.lastStroke }; },
      procPour: (from, to) => g.processing.pourBetween(from, to),
      procWater: (on) => (g.processing.sluice ? g.processing.sluice.setWater(!!on) : false),
      procBarrowPlace: (x, z, yaw) => { const ok = g.processing.devPlaceBarrow(x, z, yaw); g._stationSig = null; return ok; },
      procInstallSluice: () => g.processing.devInstallSluice(),
      // phase 7: the bulk hopper built, the feeder mounted (no animation), the lever, the ground / decks there
      procInstallAuto: () => { const pr = g.processing; const a = pr.devInstallBulk(); const b = pr.feeder ? pr.devInstallFeeder() : null; g._stationSig = null; return { bulk: a, feeder: b }; },
      procFeederMode: (mode) => g.processing.devFeederMode(mode),
      groundAt: (x, z) => g.world.groundAt(x, z),
      // walk: `sec` seconds of the real movement code with the stick / keys held at (mx, my)
      walk: (sec, mx = 0, my = 1, turn = 0) => {
        const input = g.input, steps = Math.round(sec * 60);
        for (let i = 0; i < steps; i++) {
          input.move.x = mx; input.move.y = my;
          if (turn) input.look.x += turn / 60;
          g.update(1 / 60);
          g.processing.update(1 / 60, g.player);
        }
        input.move.x = input.move.y = 0;
        g.render();
        const p = g.player;
        return { x: p.x, z: p.z, yaw: p.yaw, vx: p.vx, vz: p.vz };
      },
      procGrant: (id) => { const ok = g.processing.grant(id); g._stationSig = null; return ok; },
      procPlaceBucket: (x, z) => { const b = g.processing.bucket; if (!b) return false; b.carried = false; b.x = x; b.z = z; g.processing._sync(); return true; },
      procBucketToWash: () => { const b = g.processing.bucket; if (!b) return false; b.carried = true; return g.processing.act("bucket-wash", g.player).ok; },
      procAct: (id) => g.processing.act(id, g.player),
      procEmptyBucket: () => g.processing.emptyBucket(),
      // work for `seconds` at full pace (as if swirling / shaking steadily), in frame-sized steps
      procWork: (seconds, step = 1 / 30) => {
        const pr = g.processing;
        let ev = null, t = 0;
        pr.simWork = true;
        while (pr.work && t < seconds - 1e-9) { const dt = Math.min(step, seconds - t); ev = pr.input(dt * 2.2, dt * 1.1, dt) || ev; t += dt; if (pr.update) pr.update(dt); if (pr.panDone) break; }
        pr.simWork = false;
        const out = { ev: ev && typeof ev === "object" ? { ...ev } : ev, t, progress: pr.work === "sieve" ? pr.sieve.progress : pr.pan.progress, done: pr.panDone, work: pr.work };
        if (!pr.work) g._leaveWork();
        return out;
      },
      procCollect: () => { const r = g.processing.finishPan(); g._leaveWork(); return r; },
      procStop: () => { g._leaveWork(); return true; },
      useStation: () => g.useStation(),
      // visual QA: the world seen from anywhere (no hands; the next frame puts the camera back on the player)
      camLook: ({ x, y, z, tx, ty, tz, fov }) => {
        const c = g.camera, f0 = c.fov;
        if (fov) { c.fov = fov; c.updateProjectionMatrix(); }
        c.position.set(x, y, z); c.lookAt(tx, ty, tz); c.updateMatrixWorld();
        g.renderer.render(g.world.scene, c);
        if (fov) { c.fov = f0; c.updateProjectionMatrix(); }
        return true;
      },
      // what [E] would do right here, now (without waiting for a frame: tests pose the player and act at once)
      stationNow: () => { g._stationTick(0); return g.station ? { id: g.station.id, kind: g.station.kind, action: g.station.action, short: g.station.short || "", secondary: !!g.station.secondary } : null; },
      workAction: () => { g._workAction(); return g.processing.work; },
      // phase-3 polish probes: this stroke's hand variation, the tool's roll, the boulders' crack seeds
      handVar: () => ({ side: g.hands._activeSide, v: g.hands._var ? { ...g.hands._var } : null, cycle: g.tools.cycles }),
      toolRoll: () => g.hands.toolRoot.rotation.z,
      rockSeeds: () => g.rocks.meshes.flatMap((m) => Array.from(m.geometry.attributes.aSeed.array)),
      reticle: () => ({ visible: g.reticle.visible, opacity: +g.reticle.material.opacity.toFixed(3), scale: +g.reticle.scale.x.toFixed(3) }),
      fresh: () => {
        const t = g.terrain, cols = t.freshAt.reduce((n, f) => n + (f > -1e4 ? 1 : 0), 0);
        const verts = t.chunks.reduce((n, c) => n + c.geom.attributes.aFresh.array.reduce((m, f) => m + (f > -1e4 ? 1 : 0), 0), 0);
        return { clock: t.clock, uTime: g.world.terrainUniforms.uTime.value, cols, verts };
      },
      advanceClock: (s) => { g.terrain.clock += s; g.world.terrainUniforms.uTime.value = g.terrain.clock; g.render(); return g.terrain.clock; },
      probe: () => g.probe(),
      aim: () => ({ state: g.aimState, material: g.target ? g.target.material : null, distance: g.target ? g.target.distance : g.farTarget ? g.farTarget.distance : null, y: g.target ? g.target.y : null,
        x: g.target ? g.target.x : null, z: g.target ? g.target.z : null }),
      hand: () => ({ state: g.tools.state, phase: g.tools.phase, cycle: g.tools.cycles, inspecting: !!g.hands.inspecting, dirt: g.hands.dirt, tool: g.tools.equipped, view: g.tools.view(),
        soil: g.hands.models.soil.visible, load: g.hands.load, loadT: g.hands.loadT, crumbs: g.hands.models.crumbs ? g.hands.models.crumbs.count : 0, shake: g.hands.shake, kick: g.player.kick, shown: g.hands.tool }),
      // tool models: size / materials, and how far each glove sits from its grip (m)
      toolCheck: () => {
        const out = {};
        for (const id of ["shovel", "pickaxe"]) {
          const m = g.hands.models[id];
          let verts = 0, meshes = 0;
          const mats = new Set();
          m.traverse((o) => { if (o.isMesh) { meshes++; verts += o.geometry.attributes.position.count; mats.add(o.material.type + (o.material.map ? "+map" : "") + (o.material.envMap ? "+env" : "")); } });
          out[id] = { verts, meshes, mats: [...mats] };
        }
        out.gripError = g.hands.gripError();
        out.tool = g.hands.tool;
        return out;
      },
      mining: () => g.mining,
      economyObj: () => g.economy,
      // tools: state, switching, the debug/test-only unlock
      tools: () => ({ ...g.toolState(), state: g.tools.state, phase: g.tools.phase, blocked: g.tools.blocked, cycles: g.tools.cycles, saved: g.tools.serialize() }),
      selectTool: (id) => g.selectTool(id),
      // tests / benchmark only: the tool in the hands right away (no lower / raise), if usable
      equipNow: (id) => { if (!g.tools.canUse(id)) return false; g.tools.equipped = id; g.tools.target = null; g.tools.state = "idle"; g.tools.phase = null; g._aim(); g.ui.onTool && g.ui.onTool(g.toolState()); return true; },
      devUnlock: (on = true) => { g.setDevUnlock(on); return g.toolState(); },
      toolDefs: () => JSON.parse(JSON.stringify(this.engine.TOOL_INFO([...g.tools.upgrades]))),
      toolPose: (pose) => { g.hands.debugToolPose = pose; g.hands.update(0, g.tools.view(), { camera: g.camera, sunDir: g.world.sun.position.clone().normalize(), sunVisible: true, walk: 0, bob: 0 }); g.render(); },
      grips: () => this.engine.GRIPS,
      toolKeys: () => this.engine.TOOL_KEYS,
      rocks: () => g.rocks.rocks.map((r) => ({ index: r.index, x: r.x, y: r.y, z: r.z, r: r.r, hp: r.hp, maxHp: r.maxHp, broken: r.broken, stage: g.rocks.stage(r.index), gap: g.rocks.floatGap(r.index), moved: r.moved, collider: r.collider ? r.collider.r : null })),
      rockStats: () => ({ ...g.rocks.stats, rubble: g.rocks.rubble.count }),
      volume: () => ({ delta: g.terrain.volumeDelta(), pile: g.terrain.pileVolume() }),
      lastStroke: () => g.lastStroke,
      // one full transaction at the crosshair with the tool in the hands (or opts.tool), no animation
      act: (opts = {}) => g.strokeAtCrosshair(opts),
      // what a later shop will do: the tool becomes really yours (saved as owned)
      grant: (id) => g.grantTool(id),
      starter: () => ({ ...g.terrain.field.starter }),
      // phase 7A: the mineralised streaks of this mine (geometry only - tests, developer tools)
      streaks: () => (g.terrain.field.streaks || []).map((s) => ({ i: s.i, x: s.x, y: s.y, z: s.z, len: s.len, w: s.w, th: s.th, strike: s.strike, slope: s.slope })),
      streakAt: (x, y, z) => g.terrain.field.streakAt(x, y, z),
      cementedAt: (x, y, z) => g.terrain.field.cementedAt(x, y, z),
      setPaused: (v) => { g.setPaused(!!v); return g.paused; },
      miningStats: () => g.mining.stats(),
      pending: () => [...g.economy.pending.values()].map((p) => ({ ...p })),
      loot: () => ({ active: g.loot.active, glints: g.loot.activeGlints, floats: g.hud.floatsVisible, specks: g.loot.activeSpecks,
        pieces: g.loot.items.filter((it) => it.state !== "free").map((it) => ({ cls: it.cls, cents: it.cents, size: it.size, scale: it.mesh.scale.x })) }),
      flushLoot: () => { g.flushLoot(); return g.economy.moneyCents; },
      // phase 7A visual QA: a find of this class shown 1,1 m in front of you (looks only - no id, nothing booked)
      lootSample: (cls, cents) => {
        const p = g.player, fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), x = p.x + fx * 1.1, z = p.z + fz * 1.1;
        g.loot.spawn([{ id: null, cls, cents, massUg: cents * 100, key: "qa:look" }], { x, y: g.world.groundAt(x, z) + 0.02, z, normal: { x: -fx * 0.3, y: 0.95, z: -fz * 0.3 } });
        return g.loot.active;
      },
      materialAt: (x, y, z) => g.terrain.field.materialAt(x, y, z),
      goldAt: (x, y, z) => { const f = g.terrain.field, m = f.materialAt(x, y, z); return f.goldDensityAt(x, y, z, m, g.terrain.getBaseHeightAt(x, z) - y); },
      voxel: (i, j, iy) => ({ ...g.terrain.field.voxel(i, j, iy, {}) }),
      worked: (x, z) => { const t = g.terrain, i = Math.round((x - t.x0) / t.cell), j = Math.round((z - t.z0) / t.cell); return { slice: g.mining.cidx[j * t.vps + i], level: g.mining.consumed[j * t.vps + i], height: t.height[j * t.vps + i] }; },
      boulders: () => g.rocks.rocks.map((r) => ({ x: r.x, y: r.y, z: r.z, r: r.r, broken: r.broken })),
      // debug/test only: a find of class cls at the crosshair, discovered like a real one (pending until collected)
      debugFind: (cls, massUg) => {
        g._aim();
        const hit = g.target;
        if (!hit) return null;
        const f = { cls, massUg, x: hit.x, y: hit.y, z: hit.z, key: "debug" };
        const disc = g.economy.discover([f], 1);
        if (disc.firstNugget) disc.items[0].first = true;
        g.loot.spawn(disc.items, hit);
        return disc.cents;
      },
      handPose: (pose) => { g.hands.debugPose = pose; g.hands.update(0, { camera: g.camera, sunDir: g.world.sun.position.clone().normalize(), sunVisible: true, walk: 0, bob: 0 }); g.render(); },
      lootLook: () => { const m = g.loot.goldMat; return { metalness: m.metalness, roughness: m.roughness, envMap: !!m.envMap, color: m.color.getHexString(), shine: g.loot.shine, pointLights: g.world.scene.children.filter((o) => o.isPointLight).length }; },
      hudState: () => {
        const q = (sel) => this.root.querySelector(sel);
        return {
          toast: q(".gr-toast").hidden ? null : q(".gr-toast").textContent, tip: q(".gr-tip").hidden ? null : q(".gr-tip").textContent,
          floats: [...this.root.querySelectorAll(".gr-float")].filter((e) => !e.hidden).map((e) => e.textContent),
          money: q(".gr-money").textContent, pouch: q(".gr-pouch") && !q(".gr-pouch").hidden ? q(".gr-pouch-value").textContent : null,
          crosshair: q(".gr-crosshair").dataset.state || "idle",
        };
      },
      // exact fingerprints of the world state (save/reload tests)
      hashes: () => {
        const h = (arr, scale) => { let v = 0; for (let k = 0; k < arr.length; k++) v = (Math.imul(v, 31) + Math.round(arr[k] * scale)) | 0; return v; };
        const rocks = g.rocks.rocks.map((r) => `${Math.round(r.x * 1000)},${Math.round(r.y * 1000)},${Math.round(r.z * 1000)},${r.hp},${r.broken ? 1 : 0}`).join(";");
        return { height: h(g.terrain.height, 1000), qh: h(g.terrain.qh, 1), slices: h(g.mining.cidx, 1), money: g.economy.moneyCents, finds: g.economy.stats.finds, pending: g.economy.pending.size, carried: g.mining.carriedCount, rocks, tools: g.tools.serialize(), seed: g.doc.worldSeed };
      },
      drawStats: () => g.drawStats(),
      sceneStats: () => {
        const out = { world: {}, hands: 0, shadowCasters: 0 };
        g.world.scene.traverseVisible((o) => {
          if (!o.isMesh && !o.isPoints) return;
          const key = o.name || o.geometry.type || o.type;
          out.world[key] = (out.world[key] || 0) + 1;
          if (o.castShadow) out.shadowCasters++;
        });
        g.hands.scene.traverseVisible((o) => { if (o.isMesh) out.hands++; });
        const r = g.renderer, sm = r.shadowMap.autoUpdate;
        r.info.reset(); r.render(g.world.scene, g.camera); out.worldCalls = r.info.render.calls;
        r.shadowMap.autoUpdate = false;
        r.info.reset(); r.render(g.world.scene, g.camera); out.worldCallsNoShadow = r.info.render.calls;
        r.shadowMap.autoUpdate = sm;
        r.info.reset(); r.autoClear = false; g.hands.render(r); r.autoClear = true; out.handCalls = r.info.render.calls;
        return out;
      },
      // like pose(), without drawing a frame (fast loops in tests / the economy simulation)
      aimAt: ({ x, z, yaw, pitch }) => {
        const p = g.player;
        p.x = x; p.z = z; p.yaw = yaw; p.pitch = pitch; p.vx = p.vz = 0;
        p.y = g.world.groundAt(x, z) + 1.62;
        g._updateCamera();
        g._aim();
        return g.target ? g.target.distance : null;
      },
      terrainOk: () => g.terrain.validate(),
      terrain: () => g.terrain,
      heightAt: (x, z) => g.terrain.getHeightAt(x, z),
      baseSignature: () => { let h = 0; const b = g.terrain.base; for (let k = 0; k < b.length; k += 97) h = (h * 31 + Math.round(b[k] * 1000)) | 0; return h; },
      save: () => g.save("test"),
      saveBytes: () => this.saves.bytes(),
      saveKeys: () => ({ ...this.saves.keys }),
      setQuality: (v) => { g.setQualitySetting(v); this._syncSettings(); return g.level; },
      loseContext: () => { const ext = g.renderer.getContext().getExtension("WEBGL_lose_context"); if (ext) { ext.loseContext(); setTimeout(() => ext.restoreContext(), 400); } return !!ext; },
      sampleAt: (x, y, z) => g.terrain.field.sample(x, y, z, {}),
      three: this.engine.THREE_REVISION,
      backupKey: this.saves.keys.backup,
      // developer tools (QA mode)
      devState: () => {
        const d = this.devtools, snap = this.saves.devSnapshot();
        return { loaded: !!d, active: !!(d && d.active), open: !!(d && d.isOpen), unlocked: !!(d && d.unlocked), devModified: g.devModified,
          snapshot: snap ? { at: snap.at, seed: snap.seed, createdAt: snap.createdAt, cash: snap.doc.economy ? snap.doc.economy.cashCents : null } : null,
          cat: d ? d.cat : null, toggles: d ? { ...d.state.toggles } : {}, devHook: !!g.devHook, heatmap: !!g.terrain.heatmap,
          toast: d && d.$ ? d.$.toast.textContent : null, position: g.positionCheck(),
          models: { bucket: !!g.processing.bucket && (g.processing.worldBucket.visible || g.processing.carrying), pan: g.processing.restPan.visible || g.processing.work === "pan",
            classifier: g.processing.cls.visible, riffles: g.processing.restPan.userData.riffles.visible, bucketScale: g.processing.bucketScale,
            slots: [...this.el.belt.querySelectorAll("[data-tool]")].filter((b) => !b.classList.contains("is-locked")).map((b) => b.dataset.tool) } };
      },
      devRun: (id, arg) => (this.devtools ? this.devtools.runCommand(id, arg) : null),
      devRows: () => (this.devtools ? JSON.parse(JSON.stringify(this.devtools.ctx().actions.itemRows(g))) : null),
      positionCheck: () => g.positionCheck(),
      // ---- phase 9: prospecting, the mountain contract
      sampleNow: () => g.sampleNow(),
      sampleKey: () => g.sample(),
      flagNow: () => g.flagAtCrosshair(),
      flagAt: (x, z) => (g.processing.prospect ? g.processing.prospect.toggleFlag(x, z) : null),
      // GoldRush 9.1: the notebook's actions (as the buttons do them, without the question)
      flagsCollect: () => g.collectFlags(),
      prospectReset: () => g.resetProspect(),
      fillSeen: () => !!g.economy.flags.fillSeen,
      prospect: () => {
        const pg = g.processing.prospect;
        if (!pg) return null;
        return { view: JSON.parse(JSON.stringify(pg.view())), bags: pg.bags.map((b) => ({ n: b.n, ml: b.batch.volumeMl, g: b.batch.massG, ug: b.batch.goldUg, fineUg: b.batch.fineUg, pieces: b.batch.finds.length, place: b.place, flag: b.flag })),
          flags: pg.flags.map((f) => ({ ...f })), notes: pg.notes.map((q) => ({ ...q })), stats: { ...pg.stats }, inPan: g.processing.pan.sample ? { ...g.processing.pan.sample } : null,
          meshes: { stakes: pg.stakes.visible, tris: pg.clothGeo.index ? pg.clothGeo.index.count / 3 : 0 } };
      },
      contract: () => { const v = g.contract.view(); return { v0: v.v0, removedM3: v.removedM3, remainingM3: v.remainingM3, pct: v.pct, removedKg: v.removedKg, massKg0: v.massKg0, text: v.text, steps: v.steps, line: g.contract.line(), mountainG: g.economy.stats.mountainG }; },
      openPanel: (id) => g.openStation(id),
      panelText: (id) => { const s = this.root.querySelector(`[data-sheet=${id}]`); return s && !s.hidden ? s.textContent : null; },
      boardSig: () => g.stations._boardSig,
      // the plant (intake + belt, trommel, spoil heap)
      procInstallPlant: () => { const pr = g.processing; const c = pr.devInstallConveyor(); const t = pr.trommel ? pr.devInstallTrommel() : null; g._stationSig = null; return { conveyor: c, trommel: t }; },
      procConveyorMode: (m) => g.processing.devConveyorMode(m),
      exc: () => {
        const ex = g.processing.excavator;
        if (!ex) return null;
        return { x: ex.x, z: ex.z, y: ex.y, heading: ex.heading, swing: ex.swing, pose: { ...ex.pose }, inCab: ex.inCab, cab: g.cab === ex, attachment: ex.attachment, ml: ex.volumeMl, g: ex.massG(), ug: ex.goldUg(),
          room: ex.room, task: ex.task ? { kind: ex.task.kind, phase: ex.task.phase } : null, stats: { ...ex.stats }, v: ex.v, pitch: ex.root.rotation.z, roll: ex.root.rotation.x };
      },
      grantItem: (id) => g.devGrant(id),
      excTeeth: () => { const ex = g.processing.excavator; if (!ex) return null; ex.root.updateMatrixWorld(true); const v = ex.rig.teethWorld(ex.root.position.clone()); return { x: v.x, y: v.y, z: v.z }; },
      // the developer snapshot the way the dev tools take / restore it (goldrush-devtools.js ensureSnapshot / restoreSnapshot)
      devSnapshotWrite: () => { this.saves.writeDevSnapshot(g.buildDoc()); return !!this.saves.devSnapshot(); },
      devSnapshotRestore: () => { const s = this.saves.devSnapshot(); if (!s) return false; this.devReloadMine(s.doc, null, true); return true; },
      // a phase-9 developer command run straight from its pack (tests: no unlock flow needed)
      dev9: async (id, arg) => {
        const reg = await import("./goldrush-devregistry.js");
        await import("./goldrush-devcommands9.js");
        const c = reg.devRegistry.get(id);
        if (!c) return { ok: false, error: "unknown" };
        const ctx = { game: g, shell: this, saves: this.saves, tools: null, actions: null, state: {} };
        const r = c.kind === "info" ? { ok: true, rows: c.view(ctx) } : c.run(ctx, arg);
        return JSON.parse(JSON.stringify(r || null));
      },
      excEnter: () => g.enterCab(),
      excExit: () => g.exitCab(),
      excPlace: (x, z, heading) => { const ex = g.processing.excavator; if (!ex) return null; ex.place(x, z, heading); return { x: ex.x, z: ex.z, y: ex.y }; },
      // look from the cab (yaw / pitch of the view) and say what the crosshair is on
      excAim: (yaw, pitch) => {
        if (!g.cab) return null;
        const p = g.player, ex = g.cab;
        p.yaw = yaw; p.pitch = pitch;
        ex.viewAz = Math.atan2(Math.sin(p.yaw + Math.PI / 2 - ex.heading), Math.cos(p.yaw + Math.PI / 2 - ex.heading));
        ex.swing = ex.viewAz; ex.pose.swing = ex.swing; ex.rig.setPose(ex.pose);
        const eye = ex.eye(new g.camera.position.constructor());
        g.camera.position.copy(eye); g.camera.rotation.y = yaw; g.camera.rotation.x = pitch; g.camera.updateMatrixWorld();
        const t = g._cabAim();
        return { ok: t.ok, act: t.act, state: t.state, text: t.text, recv: t.recv ? t.recv.kind : null, hit: t.hit ? { x: t.hit.x, y: t.hit.y, z: t.hit.z, boulder: t.hit.boulder } : null };
      },
      // the transaction at the crosshair now (no animation): scoop / dump / break
      excNow: (what) => {
        const ex = g.cab;
        if (!ex) return null;
        const t = g._cabTgt;
        if (!t || !t.ok) return { ok: false, text: t ? t.text : "" };
        if (what === "scoop" && t.act === "scoop") return ex.scoopNow(t.recv ? { kind: "oversize", at: t.recv.at } : { kind: "ground", hit: { ...t.hit } });
        if (what === "dump" && t.act === "dump") return ex.dumpNow({ kind: t.recv.kind, at: { ...t.recv.at } });
        if (what === "break" && t.act === "break") return ex.breakNow({ hit: { ...t.hit } });
        return { ok: false, text: t.text };
      },
      // ---- the benchmark's excavator (no animation; the bot pays the seconds): the ground at (x, z) as a hit
      excHitAt: (x, z) => { const t = g.terrain; return { x, y: t.getHeightAt(x, z), z, normal: t.getNormalAt(x, z), diggable: t.inDigArea(x, z), boulder: null, distance: 3 }; },
      // diggable spots in reach of the excavator where it stands, the highest first (it digs a face from the top)
      excTargets: (n = 8, minUp = -0.9, minY = -Infinity) => {
        const ex = g.processing.excavator;
        if (!ex) return [];
        const t = g.terrain, out = [];
        for (let a = -1.1; a <= 1.1; a += 0.22) for (let r = 2.0; r <= 3.7; r += 0.3) {
          const h = ex.heading + a, x = ex.x + Math.cos(h) * r, z = ex.z - Math.sin(h) * r;
          if (!t.inDigArea(x, z)) continue;
          const y = t.getHeightAt(x, z), hit = { x, y, z };
          if (y < minY) continue;
          const rel = ex.rel(hit);
          if (rel.y + 0.56 < minUp || !ex.reachable(rel)) continue;
          const i = Math.round((x - t.x0) / t.cell), j = Math.round((z - t.z0) / t.cell), k = j * t.vps + i;
          const stone = y <= t.stoneTop[k] + 1e-4 && y >= t.stoneBot[k] && !(t.rubble[k] > 0);
          out.push({ x, z, y, up: rel.y + 0.56, r: rel.r, a, stone, base: t.base[k] });
        }
        out.sort((p, q) => (q.stone ? -1 : 0) - (p.stone ? -1 : 0) || q.up - p.up);
        return out.slice(0, n);
      },
      // a stand for the excavator near the intake: flat, free, facing the mountain, with the most ground to dig in reach
      excFindStand: (maxD = 7.5) => {
        const ex = g.processing.excavator, t = g.terrain, mc = t.moundCenter, cols = g.world.colliders;
        if (!ex) return null;
        const x0 = ex.x, z0 = ex.z, h0 = ex.heading;
        let best = null;
        const span = Math.max(7.5, maxD);
        for (let x = -14.5; x <= -14.35 + span; x += 0.5) for (let z = -9.35 - span; z <= -9.35 + span; z += 0.5) {
          const dI = Math.hypot(x + 14.35, z + 9.35);
          if (dI < 2.6 || dI > maxD) continue;
          const hd = Math.atan2(-(mc.z - z), mc.x - x);
          const c = Math.cos(hd), s = Math.sin(hd), hs = [[0.8, 0.62], [0.8, -0.62], [-0.8, 0.62], [-0.8, -0.62]].map(([a, b]) => g.world.groundAt(x + c * a + s * b, z - s * a + c * b));
          if (Math.max(...hs) - Math.min(...hs) > 0.42) continue;
          let free = true;
          for (const k of cols) { if (k === ex.collider) continue; const d = k.type === "circle" ? Math.hypot(x - k.x, z - k.z) - k.r : Math.max(Math.abs(x - k.x) - (k.hw || 0), Math.abs(z - k.z) - (k.hd || 0)); if (d < 1.15) { free = false; break; } }
          if (!free || (g.world.decks.length && g.world.deckAt(x, z) > -Infinity)) continue;
          ex.place(x, z, hd);
          let score = 0;
          for (let a = -1.0; a <= 1.0; a += 0.4) for (let r = 2.1; r <= 3.6; r += 0.5) {
            const px = x + Math.cos(hd + a) * r, pz = z - Math.sin(hd + a) * r;
            if (!t.inDigArea(px, pz)) continue;
            const up = t.getHeightAt(px, pz) - (ex.y || 0);
            if (up > -0.6) score += Math.min(2.2, up + 0.6);
          }
          score -= dI * 0.25;
          if (!best || score > best.score) best = { x, z, heading: hd, score, dIntake: dI };
        }
        ex.place(x0, z0, h0);
        return best;
      },
      excScoopAt: (x, z) => { const ex = g.processing.excavator; if (!ex) return null; const t = g.terrain; return ex.scoopNow({ kind: "ground", hit: { x, y: t.getHeightAt(x, z), z, normal: t.getNormalAt(x, z), diggable: t.inDigArea(x, z), boulder: null, distance: 3 } }); },
      excBreakAt: (x, z) => { const ex = g.processing.excavator; if (!ex) return null; const t = g.terrain; return ex.breakNow({ hit: { x, y: t.getHeightAt(x, z), z, normal: t.getNormalAt(x, z), diggable: true, boulder: null, distance: 3 } }); },
      // a dump / an oversize scoop wherever the receiver is (the bot pays the drive there and back)
      excDumpForce: (kind) => { const ex = g.processing.excavator; if (!ex || ex.task || ex.volumeMl <= 0) return null; return ex._tip({ kind }); },
      excScoopOversize: () => { const ex = g.processing.excavator; if (!ex || ex.task || ex.breaker) return null; return ex._cut({ kind: "oversize" }); },
      excAttach: (kind) => { const ex = g.processing.excavator; if (!ex || ex.task || ex.volumeMl > 0) return false; ex.attachment = kind === "breaker" ? "breaker" : "bucket"; ex.rig.setAttachment(ex.attachment); ex.standSync(); return true; },
      // hold a button for one frame, then let the machine work for `sec` (frames, like walk)
      excPress: (button, sec = 3, fwd = 0, turn = 0) => {
        const input = g.input, steps = Math.round(sec * 60);
        for (let i = 0; i < steps; i++) {
          input.digHeld = button === "dig" && i === 0; input.altHeld = button === "dump" && i === 0;
          input.move.y = fwd; input.move.x = turn;
          g.update(1 / 60);
          g.processing.update(1 / 60, g.player);
        }
        input.digHeld = input.altHeld = false; input.move.x = input.move.y = 0;
        g.render();
        return g.processing.excavator ? { task: g.processing.excavator.task ? g.processing.excavator.task.kind : null, ml: g.processing.excavator.volumeMl } : null;
      },
      plant: () => {
        const pr = g.processing, cv = pr.conveyor, tr = pr.trommel, sp = pr.spoil, bk = pr.bulk, sl = pr.sluice;
        return {
          conveyor: cv ? { state: cv.state, mode: cv.mode, status: cv.status(), intakeMl: cv.intake.volumeMl, intakeUg: cv.intake.goldUg, beltMl: cv.belt.volumeMl, beltUg: cv.belt.goldUg, beltState: cv.belt.state, phase: cv.belt.phase,
            cells: cv.belt.cells.map((c) => (c ? c.volumeMl : 0)), rateLpm: cv.belt.rateLpm, stats: { ...cv.stats }, lumps: cv.model.userData.lumps.count } : null,
          trommel: tr ? { state: tr.state, status: tr.status(), feedMl: tr.feed.volumeMl, overMl: tr.oversize.volumeMl, overUg: tr.oversize.goldUg, overG: tr.oversize.massG, stats: { ...tr.stats }, pileScale: tr.pile.visible ? [tr.pile.scale.x, tr.pile.scale.y, tr.pile.scale.z] : null } : null,
          spoil: sp ? sp.serialize() : null,
          bulk: bk ? { ml: bk.volumeMl, ug: bk.goldUg(), cap: bk.capacityMl } : null,
          sluice: sl ? { rate: sl.rateLpm, highflow: !!sl.highflow, capture: sl.capture, riffleL: sl.riffleL, hopperMl: sl.hopper.batch.volumeMl, running: sl.running, width: sl.model.userData.box.scale.z } : null,
          feeder: pr.feeder ? { rate: pr.feeder.rateLpm, status: pr.feeder.status().key } : null,
        };
      },
    };
  }

  // ------------------------------------------------------------ close

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.devtools) { this.devtools.dispose(); this.devtools = null; }
    if (this.game) { this.game.dispose(); this.game = null; }
    for (const off of this._off.splice(0)) off();
    clearTimeout(this._noticeT);
    clearTimeout(this._toolT);
    clearTimeout(this._hintT);
    if (this._saleRaf) cancelAnimationFrame(this._saleRaf);
    this._sale = null;
    if (this._dlgResolve) { const r = this._dlgResolve; this._dlgResolve = null; r("exit"); }
    this.root.remove();
    this.root = null;
    this.el = null;
    document.documentElement.classList.remove("goldrush-active");
    if (window.__goldrush) delete window.__goldrush;
    if (current === this) current = null;
    try { this.onExit(); } catch (e) { /* ignore */ }
  }
}
