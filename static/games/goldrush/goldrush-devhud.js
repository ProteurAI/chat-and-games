// GoldRush - developer debug overlays (QA tools). Built only while one of
// them is switched on; updated from the game's own frame loop (game.devHook,
// 4x a second) - no loop of its own, nothing at all while everything is off.
// RESOURCE DEBUG reuses the terrain's gold heatmap (the ground's own vertex
// colours, no extra objects).

import { WASH } from "./goldrush-processing.js";

const STAGE_DE = { raw: "roh", concentrate: "Konzentrat", tailings: "Abraum" };
const n0 = (v) => Math.round(v).toLocaleString("de-DE");
const l1 = (ml) => (ml / 1000).toFixed(2).replace(".", ",");

export class DevHud {
  constructor(root) {
    this.el = document.createElement("pre");
    this.el.className = "gr-devhud";
    this.el.setAttribute("aria-hidden", "true");
    this.el.hidden = true;
    root.appendChild(this.el);
    this.on = {};
    this._at = 0;
    this.game = null;
  }

  // the switches for this game (a reloaded mine is a new game)
  apply(game, toggles) {
    this.on = { ...toggles };
    const any = Object.values(this.on).some(Boolean);
    if (this.game && this.game !== game && this.game.devHook) this.game.devHook = null;
    this.game = game;
    if (!game) { this.el.hidden = true; return; }
    if (game.terrain && game.terrain.heatmap !== !!this.on.resource) game.terrain.setHeatmap(!!this.on.resource);
    game.devHook = any ? (now) => this.tick(now) : null;
    this.el.hidden = !any;
    if (any) this.draw();
    if (!game.running) game.render();
  }

  tick(now) {
    if (now - this._at < 250) return;
    this._at = now;
    this.draw();
  }

  draw() {
    const g = this.game;
    if (!g || !g.ready) return;
    const out = [];
    if (this.on.perf) {
      const i = g.info();
      out.push(`PERFORMANCE  ${i.fps} FPS · ${i.frameMs} ms (p95 ${i.p95})`,
        `  Draw Calls ${i.drawCalls} · Dreiecke ${n0(i.triangles)}`,
        `  Geometrien ${i.geometries} · Texturen ${i.textures} · Objekte ${i.sceneObjects} · Partikel ${i.particles}/${i.fragments} · Loot ${i.loot}`);
    }
    const pr = this.on.resource || this.on.terrain ? g.probe() : null;
    if (this.on.resource) {
      out.push(`RESOURCE  Heatmap an: dunkel < 0,08 · grün < 0,2 · gelb < 0,45 · orange darüber · schwarz = Stein · matt = durchgearbeitet`,
        pr ? `  Fadenkreuz: ${pr.material} · Golddichte ${String(pr.gold).replace(".", ",")} · Tiefe ${String(pr.depth).replace(".", ",")} m · ${pr.worked ? "verbraucht" : "frisch"}` : "  Fadenkreuz: –");
    }
    if (this.on.terrain) {
      const t = g.terrain, hit = g.target || g.farTarget;
      if (hit && pr) {
        const d = 0.15, gx = (t.getHeightAt(hit.x + d, hit.z) - t.getHeightAt(hit.x - d, hit.z)) / (2 * d), gz = (t.getHeightAt(hit.x, hit.z + d) - t.getHeightAt(hit.x, hit.z - d)) / (2 * d);
        const slope = Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI;
        const [ci, cj] = pr.cell.split(":").map(Number);
        const cc = t.chunkCells || 1;
        out.push(`TERRAIN  Höhe ${hit.y.toFixed(2)} m · Neigung ${slope.toFixed(0)}° · ${pr.material} (Härte ${pr.hardness}) · Chunk ${Math.floor(ci / cc)}:${Math.floor(cj / cc)} · Zelle ${pr.cell}`);
      } else out.push("TERRAIN  Fadenkreuz auf keinem Boden");
    }
    if (this.on.material) out.push(...this._material(g));
    if (this.on.interaction) {
      const p = g.player, pi = g.processing.interaction(p), st = g.station;
      out.push(`INTERACTION  [E] ${st ? `${st.id} – ${st.action || ""}` : pi ? `${pi.id} – ${pi.action}` : "–"} · Ziel ${g.aimState}${g.target ? ` ${g.target.distance.toFixed(2)} m` : ""}`,
        `  Position x ${p.x.toFixed(2)} z ${p.z.toFixed(2)} · Blick ${(p.yaw * 180 / Math.PI).toFixed(0)}° · ${g.processing.carrying ? "trägt Eimer" : g.processing.work ? `arbeitet (${g.processing.work})` : "frei"}`);
    }
    this.el.textContent = out.join("\n");
  }

  // the containers near you: volume, mass, fine gold, stage, batch id
  _material(g) {
    const pr = g.processing, p = g.player, rows = [];
    const line = (name, b) => `  ${name} #${b.id} ${STAGE_DE[b.stage] || b.stage} · ${l1(b.volumeMl)} l · ${(b.massG / 1000).toFixed(2).replace(".", ",")} kg · Feingold ${n0(b.fineUg)} µg · ${b.finds.length} Stück(e)${b.source ? ` · ${b.source}` : ""}`;
    const near = (x, z, r) => Math.hypot(p.x - x, p.z - z) < r;
    if (pr.bucket && (pr.bucket.carried || near(pr.bucket.x, pr.bucket.z, 3.2))) rows.push(line("Eimer", pr.bucket.batch));
    if (pr.owned.has("pan") && (pr.work === "pan" || near(WASH.panSpot.x, WASH.panSpot.z, 3))) rows.push(line("Pfanne", pr.pan.batch));
    if (pr.owned.has("classifier") && (pr.work === "sieve" || near(WASH.sieveSpot.x, WASH.sieveSpot.z, 3))) { rows.push(line("Sieb", pr.sieve.batch)); rows.push(line("Wanne", pr.tub)); }
    const L = pr.ledger;
    return [`MATERIAL${rows.length ? "" : "  (kein Behälter in der Nähe)"}`, ...rows,
      `  Bilanz: rein ${n0(L.inUg)} µg = Behälter ${n0(pr.goldInContainers())} + gewonnen ${n0(L.recoveredUg)} + Abraum ${n0(L.tailUg)}${L.devInUg ? ` (davon Testmaterial ${n0(L.devInUg)} µg)` : ""}`];
  }

  dispose() {
    if (this.game) { this.game.devHook = null; if (this.game.terrain && this.game.terrain.heatmap) this.game.terrain.setHeatmap(false); }
    this.el.remove();
    this.game = null;
  }
}
