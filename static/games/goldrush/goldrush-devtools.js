// GoldRush - developer tools (QA mode): the panel.
//
// Opened from the pause menu or the settings ("Entwicklertools"). The
// SERVER decides whether this account may use it (goldrush-devaccess.js);
// the panel itself is drawn from the command registry
// (goldrush-devregistry.js) - categories, buttons, toggles, item lists -
// so a later phase only registers commands, it never touches this file.
//
// Safety: before the first command that changes a mine, the mine as it was
// is kept as a developer snapshot (GoldRushSaveService.writeDevSnapshot);
// "Mine vor Entwicklertest wiederherstellen" brings exactly that back. A
// changed mine is marked devModified (informative). Every command runs as:
// available? -> confirm? -> snapshot -> run (validates, then changes) ->
// save; an exception rolls the mine back to the document from before.
// Loaded only on demand - a normal player never fetches this module.

import { devRegistry } from "./goldrush-devregistry.js";
import * as actions from "./goldrush-devactions.js";
import { DevAccess } from "./goldrush-devaccess.js";
import { DevHud } from "./goldrush-devhud.js";
import { SAVE_VERSION } from "./goldrush-save.js";
import { formatEuro, formatMass } from "./goldrush-economy.js";
// command packs (DEV_PACKS): phase 1-5, phase 6. A later phase adds one import line here.
import "./goldrush-devcommands.js";
import "./goldrush-devcommands6.js";
import "./goldrush-devcommands7.js";

const DEV_ERROR = actions.DEV_ERROR;
const CLOSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>`;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const FOCUSABLE = "button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";
const when = (ms) => (ms ? new Date(ms).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "–");
const TOOL_NAME = { hand: "Hand", shovel: "Schaufel", pickaxe: "Spitzhacke" };

export class GoldRushDevTools {
  constructor(shell) {
    this.shell = shell;
    this.access = new DevAccess(shell.api, shell.saves.player);
    this.state = { matKind: "paydirt", toggles: {} };
    this.cat = "quick";
    this.isOpen = false;          // the panel (unlocked) is up
    this.active = false;          // the overlay (panel or access dialog) is up
    this.hud = null;
    this._modalResolve = null;
    this._busy = false;
    this._build();
  }

  get game() { return this.shell.game; }
  get saves() { return this.shell.saves; }
  get unlocked() { return this.access.unlocked; }
  ctx() { return { game: this.game, shell: this.shell, saves: this.saves, tools: this, actions, state: this.state }; }

  // ------------------------------------------------------------ DOM

  _build() {
    const el = (this.el = document.createElement("div"));
    el.className = "gr-dev is-locked";
    el.hidden = true;
    el.innerHTML = `
      <div class="gr-dev-card" role="dialog" aria-modal="true" aria-labelledby="gr-dev-title">
        <div class="gr-dev-head">
          <div>
            <div class="gr-dev-title" id="gr-dev-title">Entwicklertools <span class="gr-dev-badge">DEV</span></div>
            <div class="gr-dev-sub">Nur für Entwicklung und QA.</div>
          </div>
          <button type="button" class="gr-sheet-close" data-dev="close" aria-label="Entwicklertools schließen">${CLOSE}</button>
        </div>
        <div class="gr-dev-scroll">
          <div class="gr-dev-status" data-role="status"></div>
          <div class="gr-dev-tabs" role="tablist" aria-label="Kategorien" data-role="tabs"></div>
          <div class="gr-dev-body" role="tabpanel" data-role="body"></div>
        </div>
        <div class="gr-dev-toast" role="status" aria-live="polite" data-role="toast"></div>
      </div>
      <div class="gr-dev-modal" hidden>
        <div class="gr-card gr-dev-modal-card" role="alertdialog" aria-modal="true" aria-labelledby="gr-dev-m-title" aria-describedby="gr-dev-m-text">
          <div class="gr-card-title" id="gr-dev-m-title" data-role="m-title"></div>
          <p class="gr-card-text" id="gr-dev-m-text" data-role="m-text"></p>
          <form class="gr-dev-code" data-role="m-form" hidden novalidate>
            <label class="gr-dev-label" for="gr-dev-code">Code</label>
            <input id="gr-dev-code" class="gr-dev-input" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="128" />
            <div class="gr-dev-error" data-role="m-error" role="alert"></div>
          </form>
          <div class="gr-actions" data-role="m-actions"></div>
        </div>
      </div>
      <input type="file" accept="application/json,.json" data-role="file" hidden />`;
    this.shell.root.appendChild(el);
    const q = (s) => el.querySelector(s);
    this.$ = { card: q(".gr-dev-card"), status: q("[data-role=status]"), tabs: q("[data-role=tabs]"), body: q("[data-role=body]"), toast: q("[data-role=toast]"),
      modal: q(".gr-dev-modal"), mTitle: q("[data-role=m-title]"), mText: q("[data-role=m-text]"), mForm: q("[data-role=m-form]"), mInput: q("#gr-dev-code"),
      mError: q("[data-role=m-error]"), mActions: q("[data-role=m-actions]"), file: q("[data-role=file]") };
    this._off = [];
    const on = (t, type, fn) => { t.addEventListener(type, fn); this._off.push(() => t.removeEventListener(type, fn)); };
    on(el, "click", (e) => this._click(e));
    on(el, "change", (e) => this._change(e));
    on(el, "submit", (e) => this._submit(e));
    on(el, "keydown", (e) => this._trap(e));
    on(this.$.file, "change", () => this._fileChosen());
  }

  // ------------------------------------------------------------ enter / leave

  /** from: "pause" | "settings" - where to go back to */
  async enter(from) {
    this.from = from;
    this.active = true;
    this.el.hidden = false;
    this.el.classList.add("is-locked");
    if (!this.access.available) {
      await this._message("Entwicklertools", "Entwicklertools gibt es nur für angemeldete Chat-&-Games-Konten.");
      return this._leave();
    }
    let st;
    try { st = await this.access.status(); } catch (e) { st = null; }
    if (!this.active) return;
    if (!st) { await this._message("Entwicklertools", "Keine Verbindung zum Server."); return this._leave(); }
    if (!st.configured) { await this._message("Entwicklerzugang", "Entwicklerzugang ist auf diesem Server nicht konfiguriert."); return this._leave(); }
    if (!st.unlocked && !(await this._accessDialog())) return this._leave();
    if (!this.active || !this.game) return this._leave();
    this.shell.devStateChanged();
    this._openPanel();
  }

  _openPanel() {
    this.isOpen = true;
    this.el.classList.remove("is-locked");
    this.ensureSnapshot();
    this.render();
    const first = this.$.tabs.querySelector("[aria-selected=true]") || this.$.card.querySelector(FOCUSABLE);
    if (first) first.focus({ preventScroll: true });
  }

  close() {
    if (!this.active) return;
    this._leave();
  }

  // the panel goes away without going anywhere (the mine is being replaced)
  hide() {
    this._resolveModal("cancel");
    this.isOpen = false;
    this.active = false;
    this.el.hidden = true;
  }

  _leave() {
    this._resolveModal("cancel");
    const was = this.active;
    this.isOpen = false;
    this.active = false;
    this.el.hidden = true;
    if (was) this.shell.devReturn(this.from);
  }

  // Escape: a question first, then the panel
  escape() {
    if (!this.$.modal.hidden) { this._resolveModal("cancel"); return; }
    this.close();
  }

  // keep Tab inside the top layer (question, else panel)
  _trap(e) {
    if (e.key !== "Tab") return;
    const layer = !this.$.modal.hidden ? this.$.modal : this.$.card;
    const list = [...layer.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    if (e.shiftKey && (i <= 0)) { e.preventDefault(); list[list.length - 1].focus(); }
    else if (!e.shiftKey && (i === list.length - 1 || i < 0)) { e.preventDefault(); list[0].focus(); }
  }

  // ------------------------------------------------------------ questions

  _modal({ title, text, buttons, form = false }) {
    this._resolveModal("cancel");
    const $ = this.$;
    $.mTitle.textContent = title;
    $.mText.textContent = text || "";
    $.mText.hidden = !text;
    $.mForm.hidden = !form;
    $.mError.textContent = "";
    $.mInput.value = "";
    $.mActions.innerHTML = "";
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = b.ghost ? "ghost-btn" : b.danger ? "primary-btn danger-btn" : "primary-btn";
      btn.dataset.devModal = b.id;
      btn.textContent = b.label;
      $.mActions.appendChild(btn);
    }
    $.modal.hidden = false;
    this._modalFocus = document.activeElement;
    const focus = form ? $.mInput : $.mActions.lastElementChild;
    if (focus) focus.focus({ preventScroll: true });
    return new Promise((resolve) => { this._modalResolve = resolve; });
  }

  _resolveModal(id) {
    const r = this._modalResolve;
    this._modalResolve = null;
    this.$.modal.hidden = true;
    this.$.mInput.value = "";                                  // the code is never kept
    if (r) {
      r(id);
      const back = this._modalFocus;
      if (back && this.isOpen && back.isConnected) back.focus({ preventScroll: true });
    }
  }

  _message(title, text) { return this._modal({ title, text, buttons: [{ id: "ok", label: "OK" }] }); }

  confirm({ title, text, ok = "OK", cancel = "Abbrechen", danger = false }) {
    return this._modal({ title, text, buttons: [{ id: "cancel", label: cancel, ghost: true }, { id: "ok", label: ok, danger }] }).then((id) => id === "ok");
  }

  // ENTWICKLERZUGANG: the code goes to the server once; wrong -> one plain message
  _accessDialog() {
    const p = this._modal({ title: "Entwicklerzugang", text: "", form: true, buttons: [{ id: "cancel", label: "Abbrechen", ghost: true }, { id: "unlock", label: "Freischalten" }] });
    this._unlocking = false;
    return p.then((id) => id === "unlocked");
  }

  async _tryUnlock() {
    if (this._unlocking) return;
    const $ = this.$, code = $.mInput.value;
    this._unlocking = true;
    $.mError.textContent = "";
    for (const b of $.mActions.querySelectorAll("button")) b.disabled = true;
    const r = await this.access.unlock(code);
    $.mInput.value = "";
    this._unlocking = false;
    for (const b of $.mActions.querySelectorAll("button")) b.disabled = false;
    if (!this._modalResolve) return;
    if (r.ok) { this._resolveModal("unlocked"); return; }
    $.mError.textContent = r.error || "Code nicht gültig.";
    $.mInput.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------ events

  _click(e) {
    const m = e.target.closest("[data-dev-modal]");
    if (m) {
      e.preventDefault();
      if (m.dataset.devModal === "unlock") this._tryUnlock();
      else this._resolveModal(m.dataset.devModal);
      return;
    }
    if (!this.isOpen || this._busy) return;
    const d = e.target.closest("[data-dev]");
    if (d) {
      const a = d.dataset.dev;
      if (a === "close") this.close();
      else if (a === "save") this.runCommand("save.now");
      else if (a === "restore") this.runCommand("save.restore");
      else if (a === "snapshot") this.runCommand("save.snapshot");
      return;
    }
    const tab = e.target.closest("[data-dev-cat]");
    if (tab) { this.cat = tab.dataset.devCat; this.render(); const t = this.$.tabs.querySelector(`[data-dev-cat="${this.cat}"]`); if (t) t.focus({ preventScroll: true }); return; }
    const c = e.target.closest("[data-dev-cmd]");
    if (c) { this.runCommand(c.dataset.devCmd); return; }
    const row = e.target.closest("[data-dev-row]");
    if (row) { const [cmd, item, act] = row.dataset.devRow.split("|"); this.runRow(cmd, item, act); return; }
    const ch = e.target.closest("[data-dev-choice]");
    if (ch) { const [cmd, opt] = ch.dataset.devChoice.split("|"); const c2 = devRegistry.get(cmd); if (c2) { c2.set(this.ctx(), opt); this.render(); } return; }
    const f = e.target.closest("[data-dev-file]");
    if (f) { this._fileCmd = f.dataset.devFile; this.$.file.value = ""; this.$.file.click(); }
  }

  _change(e) {
    const t = e.target.closest("[data-dev-toggle]");
    if (!t || !this.isOpen) return;
    const cmd = devRegistry.get(t.dataset.devToggle);
    if (cmd) { cmd.set(this.ctx(), t.checked); this.render(); }
  }

  _submit(e) {
    e.preventDefault();
    if (e.target === this.$.mForm) { this._tryUnlock(); return; }
    const f = e.target.closest("[data-dev-form]");
    if (!f || !this.isOpen) return;
    const input = f.querySelector("input");
    this.runCommand(f.dataset.devForm, input ? input.value : "");
  }

  async _fileChosen() {
    const file = this.$.file.files && this.$.file.files[0];
    const id = this._fileCmd;
    this._fileCmd = null;
    if (!file || !id) return;
    if (file.size > 8 * 1024 * 1024) { this.toast("Die Datei ist zu groß.", true); return; }
    let text = "";
    try { text = await file.text(); } catch (e) { this.toast("Die Datei konnte nicht gelesen werden.", true); return; }
    this.runCommand(id, text);
  }

  // ------------------------------------------------------------ running commands

  async runCommand(id, arg) {
    const cmd = devRegistry.get(id);
    if (!cmd) return null;
    return this._run(cmd, { run: cmd.run, cheat: !!cmd.cheat, confirm: cmd.confirm, available: cmd.available }, arg);
  }

  async runRow(cmdId, itemId, actId) {
    const cmd = devRegistry.get(cmdId);
    if (!cmd) return null;
    const row = cmd.rows(this.ctx()).find((r) => r.id === itemId);
    const a = row && row.actions.find((x) => x.id === actId);
    if (!a) return null;
    return this._run(cmd, { run: a.run, cheat: a.cheat !== false, confirm: a.confirm, available: null }, null);
  }

  async _run(cmd, how, arg) {
    const g = this.game;
    if (!g || !this.isOpen || this._busy) return null;
    const ctx = this.ctx();
    const ok = how.available ? how.available(ctx) : true;
    if (ok !== true) { this.toast(typeof ok === "string" ? ok : DEV_ERROR, true); return null; }
    if (how.confirm && !(await this.confirm(how.confirm))) return null;
    if (this.game !== g) return null;
    this._busy = true;
    let res = null, before = null;
    try {
      if (how.cheat) { this.ensureSnapshot(); before = g.buildDoc(); }
      res = await how.run(ctx, arg);
    } catch (e) {
      console.error("[goldrush dev]", cmd.id, e);
      res = { ok: false, error: DEV_ERROR, broken: true };
    }
    this._busy = false;
    if (!res || res.cancelled) { this.render(); return res; }
    if (res.ok === false) {
      // nothing half-done: a command that broke midway takes the whole mine back
      if (res.broken && before && this.game === g) this.shell.devReloadMine(before, "Entwickleraktion konnte nicht ausgeführt werden – die Mine ist unverändert.", true);
      else { this.toast(res.error || DEV_ERROR, true); this.render(); }
      return res;
    }
    if (res.replaced || this.game !== g) return res;            // the mine itself was replaced (restore, import, reload)
    if (how.cheat) this.markModified(g);
    if (how.cheat) g.save("dev");
    g._stationTick(0);
    if (!g.running) g.render();
    this.shell.devStateChanged();
    this.toast(res.text || "Erledigt.");
    this.render();
    return res;
  }

  markModified(g) {
    if (!g.devModified) { g.devModified = true; g.devModifiedAt = Date.now(); }
    g.dirty = true;
  }

  toast(text, error = false) {
    const t = this.$.toast;
    t.textContent = text;
    t.classList.toggle("is-error", !!error);
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { if (this.$) t.textContent = ""; }, 5000);
  }

  // ------------------------------------------------------------ snapshot / save tools (used by the commands)

  // this mine's snapshot (seed + creation time match), or null
  snapshot() {
    const g = this.game, s = this.saves.devSnapshot();
    return s && g && s.seed === g.doc.worldSeed && s.createdAt === g.doc.createdAt ? s : null;
  }

  // a clean mine: keep it as it is now (a mine that was already changed keeps its first snapshot)
  ensureSnapshot() {
    const g = this.game;
    if (!g || g.devModified) return false;
    try { this.saves.writeDevSnapshot(g.buildDoc()); this._snapAt = Date.now(); return true; } catch (e) { return false; }
  }

  async snapshotNow() {
    const g = this.game;
    if (this.snapshot() && !(await this.confirm({ title: "Dev-Snapshot ersetzen?", text: "Die vorhandene Sicherung wird durch den aktuellen Stand ersetzt.", ok: "Ersetzen" }))) return { ok: false, cancelled: true };
    try { this.saves.writeDevSnapshot(g.buildDoc()); } catch (e) { return { ok: false, error: "Die Sicherung konnte nicht gespeichert werden." }; }
    return { ok: true, text: "Neuer Dev-Snapshot aus dem aktuellen Stand." };
  }

  async restoreSnapshot() {
    const snap = this.snapshot();
    if (!snap) return { ok: false, error: "Keine Sicherung dieser Mine vorhanden." };
    const yes = await this.confirm({ title: "Mine vor Entwicklertest wiederherstellen?", text: "Alle Änderungen seit Aktivierung des Entwicklermodus werden verworfen.", ok: "Wiederherstellen", danger: true });
    if (!yes) return { ok: false, cancelled: true };
    this.shell.devReloadMine(snap.doc, "Die Mine ist wieder so wie vor dem Entwicklertest.", true);
    return { ok: true, replaced: true };
  }

  exportSave() {
    const g = this.game;
    g.save("export");
    const json = this.saves.export();
    if (!json) return { ok: false, error: "Kein Spielstand zum Exportieren." };
    const d = new Date(), pad = (v) => String(v).padStart(2, "0");
    const name = `goldrush-mine-${this.saves.player.key}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.lastExport = { name, bytes: json.length };
    return { ok: true, text: `Exportiert: ${name}` };
  }

  async importSave(text) {
    const r = this.saves.parseImport(text);
    if (!r.ok) return { ok: false, error: `Die Datei ist kein gültiger GoldRush-Spielstand (${r.error}).` };
    const yes = await this.confirm({ title: "Spielstand importieren?", text: "Deine aktuelle Mine wird durch die Datei ersetzt.", ok: "Importieren", danger: true });
    if (!yes) return { ok: false, cancelled: true };
    const doc = { ...r.doc, devModified: true, devModifiedAt: Date.now() };
    this.shell.devReloadMine(doc, "Spielstand importiert.", true);
    return { ok: true, replaced: true };
  }

  saveInfo() {
    const g = this.game, e = g.economy, s = this.saves, m = e.stats.massG, snap = this.snapshot();
    const kg = (m.dirt + m.compactDirt + m.gravel + m.stone) / 1000;
    const items = [...g.tools.ownedList().map((t) => TOOL_NAME[t] || t), ...[...g.tools.upgrades].sort(), ...g.processing.ownedList()];
    const min = Math.floor(e.stats.playTimeMs / 60000);
    return [
      ["Save-Version", String(SAVE_VERSION)], ["User-ID", s.player.id], ["World Seed", String(g.doc.worldSeed)],
      ["Spielzeit", min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`], ["Kontostand", formatEuro(e.cashCents)],
      ["Goldbeutel", `≈ ${formatEuro(e.pouchCents)} · ${formatMass(e.pouchUg)}`], ["Bewegte Masse", kg >= 1000 ? `${(kg / 1000).toFixed(2).replace(".", ",")} t` : `${Math.round(kg)} kg`],
      ["Items", items.join(", ")], ["Save-Größe", `${(s.bytes() / 1024).toFixed(1).replace(".", ",")} KB`],
      ["devModified", g.devModified ? `ja (seit ${when(g.devModifiedAt)})` : "nein"], ["Dev-Snapshot", snap ? `vorhanden (${when(snap.at)})` : "keiner"],
    ];
  }

  techInfo() {
    const g = this.game, i = g.info(), eng = this.shell.engine;
    return [
      ["three.js", eng ? `r${eng.THREE_REVISION}` : "–"], ["Qualität", `${i.level} · DPR ${i.dpr} · FOV ${i.fov}°`], ["GPU", i.gpu || "–"],
      ["Bild", `${i.fps} FPS · ${i.frameMs} ms`], ["Draw Calls / Dreiecke", `${i.drawCalls} / ${i.triangles.toLocaleString("de-DE")}`],
      ["Geometrien / Texturen / Programme", `${i.geometries} / ${i.textures} / ${i.programs}`], ["Terrain", `${i.chunks} Chunks · ${i.terrainTriangles.toLocaleString("de-DE")} Dreiecke`],
      ["Heap", i.heapMB != null ? `${i.heapMB} MB` : "–"],
    ];
  }

  // ------------------------------------------------------------ debug overlays

  setToggle(name, on) {
    this.state.toggles[name] = !!on;
    this._applyHud();
  }

  _applyHud() {
    const any = Object.values(this.state.toggles).some(Boolean);
    if (!this.hud && !any) return;
    if (!this.hud) this.hud = new DevHud(this.shell.root);
    this.hud.apply(this.game, any ? this.state.toggles : {});
  }

  // a new game instance (reload / restore / new mine): the overlays follow it
  attachGame() { if (this.hud) this._applyHud(); }

  // ------------------------------------------------------------ drawing

  render() {
    if (!this.isOpen || !this.game) return;
    this._renderStatus();
    this._renderTabs();
    this._renderBody();
  }

  _renderStatus() {
    const g = this.game, snap = this.snapshot();
    this.$.status.innerHTML = `
      <div class="gr-dev-mode"><b>ENTWICKLERMODUS AKTIV</b>${g.devModified ? '<span class="gr-dev-flag">DEV-MODIFIED</span>' : ""}</div>
      <p class="gr-dev-note">${snap ? "Vor dem ersten Cheat wurde eine Sicherung deiner Mine erstellt." : "Für diese Mine gibt es keine Entwicklersicherung."}${snap ? ` <span class="gr-dev-dim">(${esc(when(snap.at))})</span>` : ""}</p>
      <div class="gr-dev-row">
        <button type="button" class="gr-dev-btn" data-dev="save">Aktuellen Teststand speichern</button>
        <button type="button" class="gr-dev-btn gr-dev-btn--danger" data-dev="restore" ${snap ? "" : "disabled"}>Mine vor Entwicklertest wiederherstellen</button>
        ${g.devModified ? '<button type="button" class="gr-dev-btn" data-dev="snapshot">Neuen Dev-Snapshot aus aktuellem Stand erstellen</button>' : ""}
      </div>`;
  }

  _renderTabs() {
    const box = this.$.tabs;
    box.innerHTML = "";
    for (const c of devRegistry.categories) {
      if (!devRegistry.list(c.id).length) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "gr-dev-tab";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(c.id === this.cat));
      b.dataset.devCat = c.id;
      b.textContent = c.label;
      box.appendChild(b);
    }
  }

  _renderBody() {
    const ctx = this.ctx(), box = this.$.body;
    const scroll = box.parentElement.scrollTop;
    const groups = [];
    for (const cmd of devRegistry.list(this.cat)) {
      const name = cmd.group || "";
      let g = groups[groups.length - 1];
      if (!g || g.name !== name) groups.push((g = { name, cmds: [] }));
      g.cmds.push(cmd);
    }
    box.innerHTML = groups.map((g) => `<div class="gr-dev-group">${g.name ? `<div class="gr-dev-group-title">${esc(g.name)}</div>` : ""}${g.cmds.map((c) => this._cmdHtml(c, ctx)).join("")}</div>`).join("");
    box.parentElement.scrollTop = scroll;
  }

  _cmdHtml(cmd, ctx) {
    let why = true;
    try { why = cmd.available ? cmd.available(ctx) : true; } catch (e) { why = DEV_ERROR; }
    const dis = why !== true ? ` disabled aria-describedby="gr-dev-why-${esc(cmd.id)}"` : "";
    const hint = why !== true ? `<div class="gr-dev-hint gr-dev-why" id="gr-dev-why-${esc(cmd.id)}">${esc(why)}</div>` : cmd.hint ? `<div class="gr-dev-hint">${esc(cmd.hint)}</div>` : "";
    const danger = cmd.confirm && cmd.confirm.danger ? " gr-dev-btn--danger" : "";
    switch (cmd.kind) {
      case "toggle":
        return `<label class="gr-dev-toggle"><input type="checkbox" data-dev-toggle="${esc(cmd.id)}" ${cmd.value(ctx) ? "checked" : ""} /><span>${esc(cmd.label)}</span></label>${cmd.hint ? `<div class="gr-dev-hint">${esc(cmd.hint)}</div>` : ""}`;
      case "choice": {
        const cur = cmd.value(ctx);
        return `<div class="gr-dev-label">${esc(cmd.label)}</div><div class="gr-dev-choices" role="radiogroup" aria-label="${esc(cmd.label)}">${cmd.options(ctx).map((o) =>
          `<button type="button" class="gr-dev-choice" role="radio" aria-checked="${o.id === cur}" data-dev-choice="${esc(cmd.id)}|${esc(o.id)}">${esc(o.label)}</button>`).join("")}</div>`;
      }
      case "input": {
        const i = cmd.input || {};
        const fid = `gr-dev-in-${cmd.id.replace(/[^a-z0-9]/gi, "-")}`;
        return `<form class="gr-dev-form" data-dev-form="${esc(cmd.id)}" novalidate><label class="gr-dev-label" for="${fid}">${esc(i.label || cmd.label)}</label>
          <div class="gr-dev-inline"><input id="${fid}" class="gr-dev-input" type="text" inputmode="${esc(i.inputmode || "text")}" placeholder="${esc(i.placeholder || "")}" autocomplete="off" maxlength="20" ${why !== true ? "disabled" : ""} />
          <button type="submit" class="gr-dev-btn"${dis}>${esc(i.button || cmd.label)}</button></div></form>${hint}`;
      }
      case "file":
        return `<button type="button" class="gr-dev-btn" data-dev-file="${esc(cmd.id)}"${dis}>${esc(cmd.label)}</button>${hint}`;
      case "info":
        return `<div class="gr-dev-label">${esc(cmd.label)}</div><dl class="gr-dev-info">${cmd.view(ctx).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
      case "items": {
        const rows = cmd.rows(ctx);
        return `<ul class="gr-dev-items">${rows.map((r) => `<li class="gr-dev-item">
          <div class="gr-dev-item-main"><span class="gr-dev-item-name">${esc(r.label)}</span><span class="gr-dev-state is-${esc(String(r.status).toLowerCase())}">${esc(r.status)}</span>${r.sub ? `<span class="gr-dev-item-sub">${esc(r.sub)}</span>` : ""}</div>
          <div class="gr-dev-item-acts">${r.actions.map((a) => `<button type="button" class="gr-dev-btn gr-dev-btn--sm" data-dev-row="${esc(cmd.id)}|${esc(r.id)}|${esc(a.id)}" aria-label="${esc(r.label)}: ${esc(a.label)}">${esc(a.label)}</button>`).join("")}</div>
        </li>`).join("")}</ul>`;
      }
      default:
        return `<button type="button" class="gr-dev-btn${danger}" data-dev-cmd="${esc(cmd.id)}"${dis}>${esc(cmd.label)}</button>${hint}`;
    }
  }

  // ------------------------------------------------------------ teardown

  dispose() {
    this._resolveModal("cancel");
    clearTimeout(this._toastT);
    for (const off of this._off.splice(0)) off();
    if (this.hud) { this.hud.dispose(); this.hud = null; }
    this.el.remove();
    this.$ = null;
  }
}
