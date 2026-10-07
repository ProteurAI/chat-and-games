// GoldRush - prospecting (phase 9): finding the rich ground the way a
// prospector does - with samples, a pan and a notebook. No detector, no
// heatmap, no gold number over the ground.
//
//   PROBENSET   (equipment, needs the gold pan): six sample bags, a small
//               scoop, twelve numbered survey flags, a notebook.
//   SAMPLE      [R] with hand or shovel at the crosshair: a real, small dig
//               (SAMPLE_DEF, ~0,6-1,3 l by material) at exactly that spot -
//               the ground is used up there like any dig (goldrush-mining.js),
//               its material, fine gold and pieces go into a bag (a
//               MaterialBatch - counted by the processing ledger).
//   TEST PAN    at the wash trough the bags are panned one by one - the gold
//               pan's normal work, only quick (a small load: SAMPLE_PAN_S).
//               What stays in the pan goes into the pouch like any wash; the
//               notebook gets the line: where, how deep, which ground, litres,
//               kilograms, the gold recovered and mg per litre. Plain text - a
//               single litre is a single litre (one flake changes it a lot).
//   NOTEBOOK    the last NOTES samples (saved).
//   FLAGS       [F] at the ground under the crosshair (at most MAX_FLAGS in
//               all), [F] at a flag takes it out again. GoldRush 9.1: ONE
//               numbering - a flag set at a sample's spot (SAMPLE_FLAG_R) is
//               that sample's flag and carries its number (Probe 7 ->
//               Fähnchen 7); anywhere else it is a FREE flag: lettered A-L,
//               blue cloth (never a number, never mistaken for a sample).
//               A sample taken near a flag is noted with it ("bei Probe 7",
//               "Fähnchen B").
//   RESET       "Alle Fähnchen einsammeln" (the flags only) and
//               "Prospektion zurücksetzen" (notebook, numbering, flags and
//               their links - the next sample is #1). Neither gives any
//               material back: a sample used its ground for good; bags not
//               washed yet keep their material and are numbered from 1.
//
// The ground's gold is what goldrush-resources.js put there (geology 2: the
// buried paleochannels are 2-4 x the claim's grade) - samples only tell you
// what a litre held. Everything is saved (doc.prospect).

import { MaterialBatch, STAGE, batchFromDig } from "./goldrush-material.js";
import { MAT } from "./goldrush-materials.js";

export const BAGS = 6;
export const NOTES = 20;
export const MAX_FLAGS = 12;
export const FLAG_R = 1.6;                          // m: a sample this close to a flag is noted with it
export const SAMPLE_FLAG_R = 1.2;                   // m: [F] this close to a sample's spot sets THAT sample's flag (9.1)
export const FREE_LABELS = "ABCDEFGHIJKL";          // free flags (no sample): lettered, never numbered
export const SAMPLE_PAN_S = { perL: 2.2, min: 2.4, max: 4 };   // the quick test pan (s of swirling)
// the sample scoop: a small, deep bite (one litre at full efficiency) - no luck, no bonus
export const SAMPLE_DEF = {
  id: "sample", label: "Probe", reach: 2.4,
  materialEfficiency: [1.0, 0.82, 0.72, 0],
  loosenedBonus: [1, 1.15, 1.2, 1],
  cementEfficiency: 0.55,
  rubbleEfficiency: 0.5,
  hardnessLimit: 3.5,
  kernel: { type: "scoop", a: 0.11, b: 0.085, vol: 0.00115, tMax: 0.14, edge: 0.4, tilt: 0.2, settleMargin: 0.5 },
  rockDamage: 0,
};
const MAT_NAME = ["Erde", "feste Erde", "Kies", "Fels"];
const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const num = (v, d = 1) => v.toFixed(d).replace(".", ",");

// a flag's name: a sample's flag by its number, a free one by its letter
export function flagLabel(f) { return f.kind === "free" ? FREE_LABELS[f.n - 1] || "?" : String(f.n); }
export function flagName(f) { return f.kind === "free" ? `Fähnchen ${flagLabel(f)}` : `bei Probe ${f.n}`; }

// where on the claim (no coordinates - a prospector's words): a flag, else the mountain's flank / the flat ground
export function placeName(x, z, base, flag) {
  if (flag && typeof flag === "object") return flagName(flag);
  if (flag) return `Fähnchen ${flag}`;
  const dx = x - 0, dz = z + 6, a = Math.atan2(dx, -dz);                    // 0 = north (towards -z), clockwise
  const dir = ["Nord", "Nordost", "Ost", "Südost", "Süd", "Südwest", "West", "Nordwest"][((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
  if (base > 0.4) return `Berg, ${dir}flanke`;
  if (x < -9.3 && z > -9.5) return "Camp-Lagerplatz";
  return `Ebene ${dir}`;
}

export class ProspectSystem {
  /**
   * @param saved  doc.prospect (v8) or null
   * @param ctx    { ledger, economy, terrain, nextId: () => int }
   */
  constructor(THREE, scene, world, saved, ctx) {
    this.THREE = THREE;
    this.scene = scene;
    this.world = world;
    this.ctx = ctx;
    const s = saved || {};
    this.bags = (Array.isArray(s.bags) ? s.bags : []).slice(0, BAGS).map((b) => ({
      n: int(b.n), x: +b.x || 0, z: +b.z || 0, depth: +b.depth || 0, flag: int(b.flag), mat: int(b.mat) % 4, place: String(b.place || ""),
      batch: MaterialBatch.from(b.batch) || new MaterialBatch({ stage: STAGE.RAW }),
    })).filter((b) => b.batch.volumeMl > 0 || b.batch.goldUg > 0);
    this.notes = (Array.isArray(s.notes) ? s.notes : []).slice(-NOTES).filter((q) => q && typeof q === "object").map((q) => ({
      n: int(q.n), place: String(q.place || ""), depth: +q.depth || 0, mat: int(q.mat) % 4, ml: int(q.ml), g: int(q.g), ug: int(q.ug), pieces: int(q.pieces), t: int(q.t), flag: int(q.flag),
      ...(Number.isFinite(q.x) && Number.isFinite(q.z) ? { x: +q.x, z: +q.z } : {}),
    }));
    // flags: { n, x, z, kind } - "sample" (n = the sample's number) or "free" (n = 1..12, shown as a letter).
    // A phase-9 flag (no kind) was a free survey flag: it stays one (lettered from now on).
    this.flags = [];
    for (const f of Array.isArray(s.flags) ? s.flags : []) {
      if (!f || !Number.isFinite(f.x) || !Number.isFinite(f.z) || !(f.n >= 1) || this.flags.length >= MAX_FLAGS) continue;
      const kind = f.kind === "sample" ? "sample" : "free";
      if (kind === "free" && f.n > MAX_FLAGS) continue;
      if (this.flags.some((o) => o.kind === kind && o.n === int(f.n))) continue;
      this.flags.push({ n: int(f.n), x: +f.x, z: +f.z, kind });
    }
    this.next = Math.max(1, int(s.next) || 1, ...this.notes.map((q) => q.n + 1), ...this.bags.map((b) => b.n + 1));
    this.stats = { samples: int(s.stats && s.stats.samples), washed: int(s.stats && s.stats.washed), resets: int(s.stats && s.stats.resets) };
    this._rev = -1;
    this._atlasKey = "";
    this._build();
  }

  get full() { return this.bags.length >= BAGS; }
  get count() { return this.bags.length; }

  // ---- samples

  /**
   * A sample dig is done (mining result r at the hit): the material into a new bag.
   * -> { ok, bag } (the dig's finds are carried in the bag - not found now)
   */
  take(r, hit, base, playMs) {
    if (this.full || !r.ok || r.kind !== "dig" || !(r.removedVolume > 0)) return { ok: false };
    const batch = batchFromDig(r, "sample", this.ctx.nextId());
    const L = this.ctx.ledger;
    L.inUg += batch.goldUg; L.inFineUg += batch.fineUg; L.inG += batch.massG; L.inMl += batch.volumeMl; L.inFinds += batch.finds.length;
    const flag = this.flagNear(hit.x, hit.z);
    let mat = 0, best = -1;
    for (let m = 0; m < 4; m++) if (batch.comp[m] > best) { best = batch.comp[m]; mat = m; }
    const bag = { n: this.next++, x: +hit.x.toFixed(2), z: +hit.z.toFixed(2), depth: +Math.max(0, base - hit.y).toFixed(2), flag: flag && flag.kind === "sample" ? flag.n : 0, mat, place: placeName(hit.x, hit.z, base, flag), batch, t: int(playMs) };
    this.bags.push(bag);
    this.stats.samples++;
    return { ok: true, bag };
  }

  // the oldest bag (what the trough pans next)
  nextBag() { return this.bags[0] || null; }

  // the bag goes into the pan (goldrush-processing.js fillPan): it leaves the list, its line waits for the result
  popBag() { return this.bags.shift() || null; }

  // the test pan is done: a line in the notebook
  noteResult(bag, got) {
    const ml = bag.batch.volumeMl || bag.ml || 0;
    const q = { n: bag.n, place: bag.place, depth: bag.depth, mat: bag.mat, ml: int(bag.ml != null ? bag.ml : ml), g: int(bag.g != null ? bag.g : bag.batch.massG), ug: int(got.ug), pieces: int(got.pieces), t: int(bag.t), flag: bag.flag };
    if (Number.isFinite(bag.x) && Number.isFinite(bag.z)) { q.x = bag.x; q.z = bag.z; }
    this.notes.push(q);
    if (this.notes.length > NOTES) this.notes.splice(0, this.notes.length - NOTES);
    this.stats.washed++;
    return q;
  }

  // the line as text (notebook / HUD): no colours, no verdict - numbers
  static line(q) {
    const l = q.ml / 1000, mg = q.ug / 1000, per = l > 0 ? mg / l : 0;
    return {
      head: `Probe ${q.n} · ${q.place}`,
      where: `${num(q.depth, 2)} m tief · ${MAT_NAME[q.mat] || "Erde"}`,
      amount: `${num(l, 2)} l · ${num(q.g / 1000, 2)} kg`,
      gold: `${num(mg, mg < 10 ? 2 : 1)} mg Gold${q.pieces ? ` (${q.pieces} ${q.pieces === 1 ? "Stück" : "Stücke"})` : ""}`,
      grade: `${num(per, per < 10 ? 2 : 1)} mg/l`,
      perL: per,
    };
  }

  view() {
    const flagged = (n) => this.flags.some((f) => f.kind === "sample" && f.n === n);
    return {
      bags: this.bags.map((b) => ({ n: b.n, place: b.place, depth: b.depth, mat: MAT_NAME[b.mat], ml: b.batch.volumeMl, g: b.batch.massG, flagged: flagged(b.n) })),
      notes: this.notes.slice().reverse().map((q) => ({ ...q, ...ProspectSystem.line(q), flagged: flagged(q.n) })),
      flags: this.flags.map((f) => ({ ...f, label: flagLabel(f) })), max: { bags: BAGS, flags: MAX_FLAGS, notes: NOTES },
      next: this.next, free: this.flags.filter((f) => f.kind === "free").length, sampleFlags: this.flags.filter((f) => f.kind === "sample").length,
    };
  }

  goldUg() { let u = 0; for (const b of this.bags) u += b.batch.goldUg; return u; }
  massG() { let g = 0; for (const b of this.bags) g += b.batch.massG; return g; }
  volumeMl() { let v = 0; for (const b of this.bags) v += b.batch.volumeMl; return v; }

  // ---- flags

  flagNear(x, z, r = FLAG_R) {
    let best = null, bd = r;
    for (const f of this.flags) { const d = Math.hypot(f.x - x, f.z - z); if (d < bd) { bd = d; best = f; } }
    return best;
  }

  // the nearest sample spot (a bag not washed yet, or a notebook line that knows its spot) without its flag
  sampleSpotNear(x, z, r = SAMPLE_FLAG_R) {
    let best = null, bd = r;
    for (const s of [...this.bags, ...this.notes]) {
      if (!Number.isFinite(s.x) || !Number.isFinite(s.z) || this.flags.some((f) => f.kind === "sample" && f.n === s.n)) continue;
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  /**
   * [F] at a ground point: take out a flag right there; else at a sample's spot set THAT sample's flag (its
   * number), anywhere else a free flag (the lowest free letter).
   * -> { kind: "set"|"removed"|"full", n, flag: "sample"|"free", label }
   */
  toggleFlag(x, z) {
    const at = this.flagNear(x, z, 0.55);
    if (at) { this.flags.splice(this.flags.indexOf(at), 1); this._rebuild(); return { kind: "removed", n: at.n, flag: at.kind, label: flagLabel(at) }; }
    if (this.flags.length >= MAX_FLAGS) return { kind: "full", n: 0 };
    const s = this.sampleSpotNear(x, z);
    let f;
    if (s) f = { n: s.n, x: +s.x.toFixed(2), z: +s.z.toFixed(2), kind: "sample" };           // right at the sample's hole
    else {
      let n = 1;
      while (this.flags.some((o) => o.kind === "free" && o.n === n)) n++;
      f = { n, x: +x.toFixed(2), z: +z.toFixed(2), kind: "free" };
    }
    this.flags.push(f);
    this.flags.sort((a, b) => (a.kind === b.kind ? a.n - b.n : a.kind === "sample" ? -1 : 1));
    this._rebuild();
    return { kind: "set", n: f.n, flag: f.kind, label: flagLabel(f) };
  }

  /** ALLE FÄHNCHEN EINSAMMELN: every flag out of the ground - the notebook and the numbering stay. -> how many */
  collectFlags() {
    const n = this.flags.length;
    this.flags = [];
    this._rebuild();
    return n;
  }

  /**
   * PROSPEKTION ZURÜCKSETZEN: the notebook, the numbering, every flag and every link between them - the next
   * sample is #1. Nothing else: the ground a sample used stays used (that is the terrain's), and a bag not
   * washed yet keeps its material (the ledger's) - those bags (and a sample in the pan right now, `inPan`)
   * just take the first numbers of the new series. -> { notes, flags, kept, next }
   */
  reset(inPan = null) {
    const out = { notes: this.notes.length, flags: this.flags.length, kept: 0, next: 1 };
    this.notes = [];
    this.flags = [];
    let n = 1;
    const renumber = (b) => {
      b.n = n++;
      b.flag = 0;
      const base = this.ctx.terrain && Number.isFinite(b.x) ? this.ctx.terrain.getBaseHeightAt(b.x, b.z) : 0;
      if (Number.isFinite(b.x)) b.place = placeName(b.x, b.z, base, null);
    };
    if (inPan) renumber(inPan);
    for (const b of this.bags) renumber(b);
    out.kept = n - 1;
    this.next = out.next = n;
    this.stats.resets++;
    this._rebuild();
    return out;
  }

  // ---- the flags in the world: a stake and a small numbered pennant each - two meshes for all of them

  // the cloths: one atlas (4 x 4 slots, one per flag in the ground) - a sample's flag orange with its
  // number, a free flag blue with its letter. Painted again only when the set of labels changes.
  _paintAtlas() {
    const key = this.flags.map((f) => f.kind[0] + flagLabel(f)).join(",");
    if (key === this._atlasKey) return;
    this._atlasKey = key;
    const g = this._atlasCtx;
    for (let i = 0; i < 16; i++) {
      const x = (i % 4) * 64, y = Math.floor(i / 4) * 64, f = this.flags[i];
      g.fillStyle = f && f.kind === "free" ? "#3f6f9a" : "#d8692a"; g.fillRect(x, y, 64, 64);
      g.fillStyle = "rgba(0,0,0,0.12)"; for (let k = 0; k < 6; k++) g.fillRect(x, y + k * 11, 64, 2);       // the weave
      if (!f) continue;
      const label = flagLabel(f);
      g.fillStyle = "#fff4e2"; g.textAlign = "center"; g.textBaseline = "middle";
      g.font = `bold ${label.length >= 3 ? 22 : label.length === 2 ? 28 : 34}px system-ui, sans-serif`;
      g.fillText(label, x + 26, y + 34);
      if (f.kind === "free") { g.fillStyle = "rgba(255,244,226,0.75)"; g.fillRect(x + 4, y + 52, 44, 3); }     // a free flag: a stripe, no number
    }
    if (this.tex) this.tex.needsUpdate = true;
  }

  _build() {
    const THREE = this.THREE;
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    this._atlasCtx = c.getContext("2d");
    this._paintAtlas();
    const tex = (this.tex = new THREE.CanvasTexture(c));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    this.stakeMat = new THREE.MeshStandardMaterial({ color: 0x9a7650, roughness: 0.85 });
    this.clothMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, side: THREE.DoubleSide });
    this.stakeGeo = new THREE.BufferGeometry();
    this.clothGeo = new THREE.BufferGeometry();
    this.stakes = new THREE.Mesh(this.stakeGeo, this.stakeMat);
    this.cloths = new THREE.Mesh(this.clothGeo, this.clothMat);
    this.stakes.name = "goldrush-flags"; this.cloths.name = "goldrush-flags";
    for (const m of [this.stakes, this.cloths]) { m.castShadow = true; m.frustumCulled = false; this.scene.add(m); }
    this._rebuild();
  }

  // (re)build both meshes: on a change, and when the ground under a flag moved (terrain revision)
  _rebuild() {
    if (this._atlasCtx) this._paintAtlas();
    const THREE = this.THREE, P = [], N = [], I = [], CP = [], CN = [], CU = [], CI = [];
    const H = 0.78, w = 0.012;
    for (const f of this.flags) {
      const y0 = this.world.groundAt(f.x, f.z) - 0.12, b = P.length / 3;
      // a square stake: four sides
      const corners = [[-w, -w], [w, -w], [w, w], [-w, w]];
      for (let s = 0; s < 4; s++) {
        const [ax, az] = corners[s], [bx, bz] = corners[(s + 1) % 4], nx = (ax + bx) / (2 * w), nz = (az + bz) / (2 * w);
        const v = P.length / 3;
        P.push(f.x + ax, y0, f.z + az, f.x + bx, y0, f.z + bz, f.x + bx, y0 + H + 0.12, f.z + bz, f.x + ax, y0 + H + 0.12, f.z + az);
        for (let q = 0; q < 4; q++) N.push(nx, 0, nz);
        I.push(v, v + 1, v + 2, v, v + 2, v + 3);
      }
      void b;
      // the pennant: a small cloth with its label (its slot in the atlas = its place in the list), a slight sag
      const i = this.flags.indexOf(f), u0 = (i % 4) / 4, v0 = 1 - (Math.floor(i / 4) + 1) / 4, cb = CP.length / 3, top = y0 + H + 0.1;
      const ang = (f.n * 1.3) % (Math.PI * 2), dx = Math.cos(ang) * 0.2, dz = Math.sin(ang) * 0.2;
      CP.push(f.x, top, f.z, f.x + dx, top - 0.02, f.z + dz, f.x + dx, top - 0.14, f.z + dz, f.x, top - 0.13, f.z);
      for (let q = 0; q < 4; q++) CN.push(-dz * 5, 0, dx * 5);
      CU.push(u0, v0 + 0.25, u0 + 0.25, v0 + 0.25, u0 + 0.25, v0, u0, v0);
      CI.push(cb, cb + 1, cb + 2, cb, cb + 2, cb + 3);
    }
    const set = (geo, pos, nor, idx, uv) => {
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
      if (uv) geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeBoundingSphere();
    };
    set(this.stakeGeo, P, N, I);
    set(this.clothGeo, CP, CN, CI, CU);
    this.stakes.visible = this.cloths.visible = this.flags.length > 0;
    this._rev = this.ctx.terrain ? this.ctx.terrain.revision : -1;
  }

  // per frame (cheap): the flags follow the ground when it changed
  update() {
    const t = this.ctx.terrain;
    if (this.flags.length && t && t.revision !== this._rev) this._rebuild();
  }

  serialize() {
    return {
      bags: this.bags.map((b) => ({ n: b.n, x: b.x, z: b.z, depth: b.depth, flag: b.flag, mat: b.mat, place: b.place, t: b.t, batch: b.batch.serialize() })),
      notes: this.notes.map((q) => ({ ...q })), flags: this.flags.map((f) => ({ ...f })), next: this.next, stats: { ...this.stats },
    };
  }

  dispose() {
    this.scene.remove(this.stakes); this.scene.remove(this.cloths);
    this.stakeGeo.dispose(); this.clothGeo.dispose(); this.stakeMat.dispose(); this.clothMat.dispose(); this.tex.dispose();
  }
}

export { MAT_NAME, MAT };
