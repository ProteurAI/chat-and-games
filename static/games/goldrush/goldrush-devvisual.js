// GoldRush - developer tools for the visual overhaul (Visual Overhaul A + Earth B0): fixed visual QA
// bookmarks (the same camera in every capture - before / after comparisons never depend on where someone
// happened to stand), and the rendering debug switches of the phase (albedo luminance, earth layers,
// state / geology textures, AO and post on / off, quality LOW / MEDIUM / HIGH).
//
// Bookmarks are derived from the mine itself (its original mound: the summit, its south face), so they land
// on the same spot for the same seed - the QA seed is 4242 (tests/e2e/goldrush_visualqa.py).

import { registerDevCommand as reg } from "./goldrush-devregistry.js";
import { DEV_ERROR, concentrateLoad, giveItem } from "./goldrush-devactions.js";
import { SPAWN, MOUND_CENTER } from "./goldrush-world.js";
import { SLUICE_AT } from "./goldrush-sluice.js";
import { WASH } from "./goldrush-processing.js";
import { PILE_SITES } from "./goldrush-stockpile.js";
import { GRADE, setAlbedoDebug } from "./goldrush-atmos.js";
import { POST } from "./goldrush-post.js";

const ok = (text) => ({ ok: true, text });
const fail = (error) => ({ ok: false, error });
const BOOK = "Visual-QA (VO-A)";
const DEBUG = "Visual-Debug (VO-A)";

// the original mound's summit (scanned once per mine: the highest original surface in the dig area)
function summit(g) {
  if (g._voSummit && g._voSummit.seed === g.doc.worldSeed) return g._voSummit;
  const t = g.terrain;
  let best = { x: MOUND_CENTER.x, z: MOUND_CENTER.z, h: -1 };
  for (let z = MOUND_CENTER.z - 12; z <= MOUND_CENTER.z + 12; z += 0.25) for (let x = MOUND_CENTER.x - 12; x <= MOUND_CENTER.x + 12; x += 0.25) {
    const h = t.getBaseHeightAt(x, z);
    if (h > best.h) best = { x, z, h };
  }
  g._voSummit = { ...best, seed: g.doc.worldSeed };
  return g._voSummit;
}

// the south face: from the summit towards the spawn until the original surface is ~1.3 m high
function southFace(g) {
  const s = summit(g), t = g.terrain;
  const dx = SPAWN.x - s.x, dz = SPAWN.z - s.z, L = Math.hypot(dx, dz) || 1;
  for (let d = 0; d < L; d += 0.1) {
    const x = s.x + (dx / L) * d, z = s.z + (dz / L) * d;
    if (t.getBaseHeightAt(x, z) < 1.3) return { x, z, h: t.getBaseHeightAt(x, z), ux: dx / L, uz: dz / L };
  }
  return { x: MOUND_CENTER.x, z: MOUND_CENTER.z + 9, h: 1, ux: 0, uz: 1 };
}

const yawTo = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));

// one camera: stand at (x, z), look at (tx, ty, tz)
function pose(g, x, z, tx, ty, tz) {
  if (g.cab) g.exitCab();
  if (g.processing.barrow && g.processing.barrow.pushing) g.processing.barrow.park();
  if (g.processing.work) g._leaveWork();
  const eye = g.world.groundAt(x, z) + 1.62;
  const r = g.teleport({ x, z, yaw: yawTo(x, z, tx, tz), pitch: Math.atan2(ty - eye, Math.hypot(tx - x, tz - z) || 1) });
  g._stationSig = null;
  return r && r.ok;
}

async function mine(ctx) {
  const g = ctx.game;
  if (g.processing.owned.has("washplant") && g.processing.washplant && g.processing.washplant.installed) return { ok: true };
  const { devRegistry } = await import("./goldrush-devregistry.js");
  const c = devRegistry.get("quick.phase10");
  return c ? await c.run(ctx) : fail(DEV_ERROR);
}

export const VISUAL_BOOKMARKS = [
  { id: "spawn", label: "SPAWN / CLAIM", run: (g) => pose(g, SPAWN.x, SPAWN.z, SPAWN.x, 1.62 + Math.tan(SPAWN.pitch) * 20, SPAWN.z - 20) },
  { id: "face", label: "MOUNTAIN FACE CLOSE", run: (g) => { const f = southFace(g); return pose(g, f.x + f.ux * 1.7, f.z + f.uz * 1.7, f.x, f.h + 0.25, f.z); } },
  { id: "mid", label: "MOUNTAIN MID-DISTANCE", run: (g) => { const s = summit(g); return pose(g, s.x + 3, s.z + 17, s.x, s.h * 0.55, s.z); } },
  { id: "summit", label: "SUMMIT / ACROSS THE CLAIM", run: (g) => { const s = summit(g); return pose(g, s.x, s.z, s.x - 4, s.h - 1.4, s.z + 18); } },
  { id: "camp", label: "CAMP", run: (g) => pose(g, -7.5, 10.5, -17.5, 0.5, -7.0) },
  { id: "plant", label: "PROCESSING PLANT", mine: true, run: (g) => pose(g, SLUICE_AT.x + 5.2, SLUICE_AT.z + 3.4, SLUICE_AT.x + 0.6, 1.0, SLUICE_AT.z - 0.4) },
  { id: "sluice", label: "SLUICE", mine: true, run: (g) => pose(g, SLUICE_AT.x + 2.6, SLUICE_AT.z + 2.4, SLUICE_AT.x + 1.2, 0.55, SLUICE_AT.z + 0.4) },
  { id: "pan", label: "PAN / PROCESSING", mine: true, run: (g) => panView(g) },
  { id: "piles", label: "OVERSIZE / TAILINGS", mine: true, run: (g) => { const o = PILE_SITES.tailOut; return pose(g, o.x1 + 2.4, o.z1 + 3.4, (o.x0 + o.x1) / 2 - 0.6, 0.3, (o.z0 + o.z1) / 2); } },
];

// the pan at the trough, a concentrate load nearly washed (the gold drift shows, a little water left)
function panView(g) {
  const pr = g.processing;
  if (!pr.owned.has("pan")) { const r = giveItem(g, "pan"); if (!r.ok) return false; }
  if (pr.work) g._leaveWork();
  g.teleport({ x: WASH.panSpot.x, z: WASH.panSpot.z, yaw: WASH.panSpot.yaw, pitch: -0.7 });
  if (pr.pan.batch.volumeMl <= 0 && !concentrateLoad(g).ok) return false;
  pr.pan.progress = 0.93;
  pr.startWork("pan");
  return true;
}

for (const b of VISUAL_BOOKMARKS) {
  reg({ id: `vo.bm.${b.id}`, category: "world", group: BOOK, label: b.label, cheat: true,
    hint: "Fester Kamerapunkt für Vorher/Nachher-Vergleiche (Seed 4242 in den Aufnahmen).",
    run: async (ctx) => {
      const g = ctx.game;
      if (b.mine) { const m = await mine(ctx); if (!m.ok) return m; }
      return b.run(g) ? ok(`${b.label} · FOV ${g.camera.fov.toFixed(1)}° · Qualität ${g.level}`) : fail(DEV_ERROR);
    } });
}

// the lighting / grade baseline, live (calibration; the frozen values live in goldrush-atmos.js / -post.js /
// -world.js): { tm: 0 ACES | 1 AgX | 2 Neutral, exposure, sat, contrast, sun, env, hemi, fog, fogColor: [r, g, b]
// linear, bloom, ao, aoRadius } - anything left out stays; returns the current values
reg({ id: "vo.set", category: "world", group: DEBUG, label: "Licht / Grade setzen (JSON)", kind: "input",
  input: { label: "JSON", placeholder: '{"tm":1,"exposure":1.1}', button: "Setzen" },
  hint: "Kalibrierung live: tm (0 ACES, 1 AgX, 2 Neutral), exposure, sat, contrast, sun, env, hemi, fog, fogColor, bloom, ao, aoRadius.",
  run: (ctx, arg) => {
    const g = ctx.game, w = g.world, a = typeof arg === "string" && arg.trim() ? JSON.parse(arg) : arg || {};
    const num = (k, set) => { if (Number.isFinite(a[k])) set(a[k]); };
    num("tm", (v) => { GRADE.toneMap = v | 0; });
    num("exposure", (v) => { GRADE.exposure = v; g.renderer.toneMappingExposure = v; });
    num("sat", (v) => { GRADE.saturation = v; });
    num("contrast", (v) => { GRADE.contrast = v; });
    num("sun", (v) => { w.sun.intensity = v; });
    num("env", (v) => { w.scene.environmentIntensity = v; });
    num("hemi", (v) => { w.hemi.intensity = v; });
    num("fog", (v) => { w.scene.fog.density = v; });
    num("bloom", (v) => { POST.bloomStrength = v; });
    num("ao", (v) => { POST.aoStrength = v; });
    num("aoRadius", (v) => { POST.aoRadius = v; });
    if (Array.isArray(a.fogColor)) w.scene.fog.color.setRGB(...a.fogColor);
    g.render();
    const cur = { tm: GRADE.toneMap, exposure: GRADE.exposure, sat: GRADE.saturation, contrast: GRADE.contrast, sun: w.sun.intensity, env: w.scene.environmentIntensity,
      hemi: w.hemi.intensity, fog: w.scene.fog.density, fogColor: w.scene.fog.color.toArray().map((x) => +x.toFixed(3)), bloom: POST.bloomStrength, ao: POST.aoStrength, aoRadius: POST.aoRadius };
    return { ok: true, text: JSON.stringify(cur), values: cur };
  } });

// post stack views: 0 final, 1 AO only, 2 no AO / bloom, 3 bloom only, 4 raw (no tone map)
for (const [m, label] of [[0, "Post: fertiges Bild"], [1, "Post: nur AO"], [2, "Post: ohne AO / Bloom"], [3, "Post: nur Bloom"], [4, "Post: roh (ohne Tonemapping)"]]) {
  reg({ id: `vo.post.${m}`, category: "world", group: DEBUG, label, run: (ctx) => { ctx.game.post.debug = m; ctx.game.render(); return ok(label); } });
}
reg({ id: "vo.ao", category: "world", group: DEBUG, label: "AO an / aus", run: (ctx) => { const p = ctx.game.post; p.aoOn = !p.aoOn; ctx.game.render(); return ok(`AO ${p.aoOn ? "an" : "aus"}`); } });
reg({ id: "vo.postOff", category: "world", group: DEBUG, label: "Post-Stack an / aus",
  run: (ctx) => { const g = ctx.game, p = g.post; p.forcedOff = !p.forcedOff; p.enabled = !p.forcedOff && !!g.q.post && p.supported; g.render(); return ok(`Post ${p.enabled ? "an" : "aus"}`); } });
reg({ id: "vo.albedo", category: "world", group: DEBUG, label: "Albedo-Helligkeit (Falschfarben)",
  run: (ctx) => {
    const g = ctx.game;
    g._albedoDbg = !g._albedoDbg;
    const n = setAlbedoDebug([g.world.scene, g.hands.scene], g._albedoDbg);
    g.post.debug = g._albedoDbg ? 4 : 0;
    g.renderer.toneMapping = g._albedoDbg ? 0 : 5;                // NoToneMapping / CustomToneMapping (LOW and the hands)
    g.render();
    return ok(`Albedo-Ansicht ${g._albedoDbg ? "an" : "aus"} (${n} Materialien) · violett <0,02 · blau <0,04 · türkis <0,1 · grün <0,2 · gelbgrün <0,35 · orange <0,6 · rot <0,85 · pink darüber`);
  } });

// Earth B0 views: 0 normal, 1 layers (crust tan, loose orange, compact red, gravel blue-grey, rock dark), 2 material
// identity used (GeoTex / vertex), 3 StateTex (fresh yellow, wet blue), 4 GeoTex raw, 5 vertex material raw
for (const [m, label] of [[0, "Erde: normal"], [1, "Erde: Schichten"], [2, "Erde: Material-ID"], [3, "Erde: StateTex frisch / nass"], [4, "Erde: GeoTex roh"], [5, "Erde: Vertex-Material"]]) {
  reg({ id: `vo.earth.${m}`, category: "world", group: DEBUG, label, run: (ctx) => { ctx.game.world.earth.setDebug(m); ctx.game.render(); return ok(label); } });
}
reg({ id: "vo.wet", category: "world", group: DEBUG, label: "Nasse Stelle am Fadenkreuz (nur Optik)",
  hint: "Test der Nass-Darstellung (StateTex G) - wird nicht gespeichert.",
  run: (ctx) => {
    const g = ctx.game, t = g.target;
    const x = t ? t.x : g.player.x - Math.sin(g.player.yaw) * 2, z = t ? t.z : g.player.z - Math.cos(g.player.yaw) * 2;
    g.world.earth.paintWet(x, z, 1.2);
    g.render();
    return ok(`nass bei ${x.toFixed(1)} / ${z.toFixed(1)}`);
  } });
reg({ id: "vo.dry", category: "world", group: DEBUG, label: "Alles wieder trocken", run: (ctx) => { ctx.game.world.earth.clearWet(); ctx.game.render(); return ok("trocken"); } });
reg({ id: "vo.stats", category: "world", group: DEBUG, label: "Render-Statistik (+ GPU-Zeit)", kind: "info",
  view: (ctx) => {
    const g = ctx.game;
    g.setGpuTiming(true);
    const s = g.renderStats(), gpu = s.gpu ? Object.entries(s.gpu).map(([k, v]) => `${k} ${v}`).join(" · ") : (s.gpuTimer ? "misst …" : "nicht verfügbar");
    return [["Stufe", `${s.level} · Post ${s.post ? `an (MSAA ${s.samples}, AO ${s.ao}${s.fxaa ? ", FXAA" : ""})` : "aus"}`], ["Draw Calls", `${s.calls} + ${s.postCalls} Post`],
      ["Dreiecke", String(s.tris)], ["Frame", `${s.frameMs} ms (${s.fps} fps)`], ["GPU", gpu], ["Texturen / Geometrien / Programme", `${s.textures} / ${s.geometries} / ${s.programs}`],
      ["Render-Targets", `${s.targetsMB} MB`], ["Erde", `${s.earth.res} px · ${s.earth.arraysMB} MB · GeoTex ${s.earth.geoReady ? "fertig" : Math.round(s.earth.geo.progress * 100) + " %"}`],
      ["Umgebung", `${s.env}${s.envError ? " (" + s.envError + ")" : ""}`], ["Puffer", `${s.buffer.join("×")} @ ${s.dpr}`]];
  } });

// quality tiers (forced)
for (const [lv, label] of [["low", "Qualität NIEDRIG"], ["medium", "Qualität MITTEL"], ["high", "Qualität HOCH"]]) {
  reg({ id: `vo.q.${lv}`, category: "world", group: DEBUG, label, run: (ctx) => { ctx.game.setQualitySetting(lv); return ok(`${label} (fest, kein AUTO)`); } });
}
