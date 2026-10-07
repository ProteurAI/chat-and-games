"""End-to-end check of GoldRush phase 9: the mechanised claim.

  geology   geology 2 (3 since GoldRush 9.1): an explicit version in the save, 2-4 paleochannels per seed (some under
            the mountain), the camp's fill next to barren, the upper mountain ~ the claim (9.1), the channels
            2-4 x the claim, no gold peak at the old ground level; a v7 mine migrates (used slices stay used,
            containers keep their gold, the notice once)
  prospect  a sample is a real small dig at exactly the crosshair (its gold = the used slices' gold), 0.5-1.5 l,
            a quick test pan into the notebook (mass, volume, mg/l - plain numbers), the notebook keeps 20, the
            numbered flags (12 at most) - all saved; no heatmap, nothing tells the gold before washing
  contract  the original mountain, removal measured on the ground (m3 above the floor = the cut's volume), the
            flat claim never counts, tonnes from the cuts, the board repainted, the shop's contract locks, the
            pause card's line
  conveyor  build, dig straight into the intake, barrow / bucket into it, the belt really carries (transit,
            ~64 l/min), OFF / waiting / STARVED / RUNNING / BLOCKED, backpressure without loss
  trommel   the exact split (under + over == in), the gold with the undersize, the oversize recoverable,
            blocked by a full bulk hopper and running on, the drum turning / spray
  highflow  the wide box: 20 l/min, 32 with the feeder, riffles for 640 l, wider
  excavator in and out, the tracks on the ground (forward, turn, the slope limit), the scoop a real batch from
            the cells it took (30-60 l), 4-7 x the shovel, a partial dump into a nearly full intake, no cut into
            intact rock, the breaker cracks it and the bucket takes the rubble, the cab's HUD
  chain     full chain excavator -> intake -> belt -> trommel -> bulk -> feeder -> sluice -> riffles -> pan ->
            pouch with a save / reload halfway: gold and mass exact to the microgram / gram
  save      v8 fields round trip; a new mine starts clean; the dev snapshot exact
  dev       the phase-9 pack: the preset PHASE 9 MECHANIZED CLAIM and its places
  perf      draw calls (mine, plant, intake, cab) within 220, frame rate with everything running, nothing
            uploaded when the machines first come into view (warm pass)
  mobile    a phone: the prospecting buttons in the tool sheet, the cab's buttons (SCHAUFELN / KIPPEN / AUSSTEIGEN)
  handling  the wheelbarrow handling pass: the numbers (0 -> 90 %, stop, quarter turn, latency, radius, slope) for
            empty / half / full, and in the game (paused, walk() only): a full barrow over dug marks without
            stalling, steered by the look, backed out of the course's parking box; the dev course and its readout
  shots     section 30's 24 fixed views (+ extras; the phone's with mobile) (--shots DIR --tag NAME; scratch only)

Runs the server from temp copies (the real database is never touched).

    python tests/e2e/goldrush_mechanized_e2e.py [--shots DIR] [--tag NAME] [--browser webkit] [--only parts]

Under WebKit the browser is relaunched per part (it keeps GPU memory of every closed session and then
stalls); perf, shots and mobile run only in Chromium (no performance.memory, rAF ~24/s).
"""

import json
import math
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from goldrush_e2e import GPU_ARGS, client, errors, gr_open, gr_ready, gr_pause, gr_close, wait_for  # noqa: E402
from goldrush_tools_e2e import seeded  # noqa: E402
import goldrush_quality_e2e as Q  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ONLY = set(sys.argv[sys.argv.index("--only") + 1].split(",")) if "--only" in sys.argv else None
TAG = sys.argv[sys.argv.index("--tag") + 1] if "--tag" in sys.argv else "p9"
RESULTS = []
GR = "window.__goldrush"
G, proc, fresh = Q.G, Q.proc, Q.fresh
PLANT = ["sluice", "bulkhopper", "feeder", "conveyor", "trommel"]


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def grant(page, ids):
    return [G(page, f"(i) => {GR}.grantItem(i)", i) for i in ids]


def plant_up(page, ids=PLANT, water=True):
    grant(page, ids)
    G(page, f"() => {{ const g = {GR}; g.procInstallSluice(); g.procInstallAuto(); g.procInstallPlant(); {'g.procWater(true);' if water else ''} }}")


def ledger(page):
    p = proc(page)
    L = p["ledger"]
    return L["inUg"] - p["inContainersUg"] - L["recoveredUg"] - L["tailUg"], L["inG"] - p["inContainersG"] - L["tailG"], L, p


def frames(page, sec):
    G(page, f"(s) => {GR}.walk(s, 0, 0)", sec)


def reload(page):
    """save, leave through the pause menu, come back to the same mine"""
    G(page, f"() => {GR}.save()")
    G(page, f"() => {GR}.setPaused(false)")
    gr_pause(page)
    gr_close(page)
    gr_open(page)
    gr_ready(page)


def excavator_at_intake(page):
    """the excavator on flat ground next to the intake, you in its cab, facing the mountain - the intake to its
    side (~90 deg: an operator loading a hopper stands like that)"""
    sp = G(page, """() => { const g = window.__goldrush; let best = null;
      for (let x = -14.6; x <= -10.0; x += 0.2) for (let z = -14.0; z <= -4.5; z += 0.2) {
        const h = [[0.8, 0.62], [0.8, -0.62], [-0.8, 0.62], [-0.8, -0.62]].map(([a, b]) => g.heightAt(x + a, z + b));
        const s = Math.max(...h) - Math.min(...h), d = Math.hypot(x + 14.35, z + 9.35);
        if (d < 2.7 || d > 3.6 || s > 0.25) continue;
        const bear = Math.abs(Math.atan2(-(-9.35 - z), -14.35 - x));                  // the intake's bearing from heading 0 (east)
        const score = s + Math.abs(bear - Math.PI / 2) * 0.3;
        if (!best || score < best.score) best = { x, z, s, score }; } return best; }""")
    G(page, f"(s) => {GR}.excPlace(s.x, s.z, 0)", sp)
    G(page, f"() => {GR}.excEnter()")
    return sp


def BREAK_YAWS(page):
    hd = G(page, f"() => {GR}.exc()")["heading"]
    return [hd - math.pi / 2 + d for d in (0, 0.12, -0.12, 0.25, -0.25, 0.4, -0.4)]


def aim_for(page, act, recv=None, yaws=None, pitches=(-0.2, -0.3, -0.4, -0.5, -0.6)):
    for yaw in yaws or [y / 20 for y in range(-62, 63)]:
        for pt in pitches:
            t = G(page, f"([y, p]) => {GR}.excAim(y, p)", [yaw, pt])
            if t and t["act"] == act and (recv is None or t["recv"] == recv):
                return (yaw, pt), t
    return None, None


# ======================================================================
# GEOLOGY
# ======================================================================

ZONE_JS = r"""() => {
  const g = window.__goldrush, t = g.terrain(), f = t.field, vox = {}, out = {};
  const add = (k, ug, n) => { const o = out[k] || (out[k] = [0, 0]); o[0] += ug; o[1] += n; };
  for (let j = 14; j < t.vps - 14; j += 4) for (let i = 14; i < t.vps - 14; i += 4) {
    const k = j * t.vps + i, x = t.x0 + i * t.cell, z = t.z0 + j * t.cell, base = t.base[k];
    if (!t.inDigArea(x, z)) continue;
    const top = Math.ceil((base + 2.5) / 0.01 - 0.5) - 1, fill = f.campFillAt(x, z) > 0.5 && base < 0.15;
    for (let d = 0; d < 100; d += 2) {
      const iy = top - d, y = -2.5 + (iy + 0.5) * 0.01, v = f.voxel(i, j, iy, vox);
      if (v.mat === 3) continue;
      const ug = v.fineUg + (v.cls ? v.massUg : 0), ch = f.channelAt(x, y, z);
      if (ch && ch.w > 0.5) { add("channel", ug, 1); continue; }
      if (f.streakAt(x, y, z) > 0.2 || f.pocketAt(x, y, z) > 0.2) continue;
      if (fill) { if (d < 50) add("fill", ug, 1); continue; }
      if (base > 2.0) add("upper", ug, 1);
      else if (base < 0.12 && f.campFillAt(x, z) < 0.05) { add("claim", ug, 1); add(d < 30 ? "claimTop" : d >= 60 ? "claimDeep" : "claimMid", ug, 1); }
    }
  }
  const r = {};
  for (const [k, [ug, n]] of Object.entries(out)) r[k] = n ? ug / n : 0;
  r.channels = f.channels.length;
  let cover = 0, under = 0;
  for (let k = 0; k < t.vps * t.vps; k++) if (f.chIdx[k] >= 0 && f.chD[k] < 1) { cover++; if (t.base[k] > 0.4) under++; }
  r.under = under; r.sig = f.channels.map((c) => `${c.p0.x.toFixed(2)},${c.bed.toFixed(3)}`).join("|");
  return r;
}"""


def geology(A):
    rows = []
    for seed in (4242, 11, 23, 37, 51, 77):
        fresh(A, seed)
        rows.append(G(A, ZONE_JS))
    doc = G(A, f"() => {{ {GR}.save(); return JSON.parse(localStorage.getItem(grKey())); }}")
    # (GoldRush 9.1: geology 3 - the recalibration; goldrush_hotfix91_e2e.py)
    ok("GEO a new mine records its geology (explicit version, 3 since GoldRush 9.1)", doc.get("geology", {}).get("version") == 3 and doc["saveVersion"] == 8, str(doc.get("geology")))
    ok("GEO 2-4 paleochannels per seed, some under the mountain", all(2 <= r["channels"] <= 4 for r in rows) and sum(1 for r in rows if r["under"] > 0) >= 3, str([(r["channels"], r["under"]) for r in rows]))
    m = lambda k: sum(r.get(k, 0) for r in rows) / len(rows)
    claim = m("claim")
    ok("GEO the camp's fill is next to barren (< 15 % of the claim)", m("fill") < 0.15 * claim, f"fill {m('fill'):.0f} vs claim {claim:.0f} ug/slice")
    ok("GEO the upper mountain ~ the neutral claim (0.85-1.15 x since GoldRush 9.1; it was 0.70-0.95)", 0.85 <= m("upper") / claim <= 1.15, f"{m('upper') / claim:.2f}")
    ok("GEO the channels 2-4 x the claim (mean over seeds)", 2.0 <= m("channel") / claim <= 4.0, f"{m('channel') / claim:.2f}")
    ok("GEO no gold peak at the old ground level: the top 0.3 m of the flat claim not richer than below", m("claimTop") <= 1.15 * m("claimDeep"), f"top {m('claimTop'):.0f} mid {m('claimMid'):.0f} deep {m('claimDeep'):.0f}")
    fresh(A, 4242)
    again = G(A, ZONE_JS)
    ok("GEO deterministic per seed, different between seeds", again["sig"] == rows[0]["sig"] and rows[0]["sig"] != rows[1]["sig"])
    # migration: a v7 mine (geology 1 era) with dug ground and a bucket of material
    fresh(A, 4242)
    G(A, f"() => {{ const g = {GR}; g.grant('shovel'); g.procGrant('bucket'); g.equipNow('shovel'); }}")
    G(A, f"() => {GR}.aimAt({{ x: 0.6, z: 5.0, yaw: 0, pitch: -0.35 }})")
    G(A, f"() => {GR}.procPlaceBucket(1.1, 5.4)")
    for _ in range(4):
        G(A, f"() => {GR}.act({{ visuals: false, tool: 'shovel' }})")
    before = G(A, f"() => {{ const g = {GR}; return {{ h: g.hashes(), bucket: g.procObj().bucket.batch.goldUg, ml: g.procObj().bucket.batch.volumeMl }}; }}")
    G(A, f"() => {GR}.setPaused(false)")
    gr_pause(A); gr_close(A)                                  # (the pause saves: edit the document only once the game is closed)
    G(A, "() => { const d = JSON.parse(localStorage.getItem(grKey())); d.saveVersion = 7; delete d.geology; delete d.prospect; localStorage.setItem(grKey(), JSON.stringify(d)); }")
    gr_open(A); gr_ready(A)
    after = G(A, f"() => {{ const g = {GR}; return {{ h: g.hashes(), bucket: g.procObj().bucket.batch.goldUg, ml: g.procObj().bucket.batch.volumeMl, notice: document.querySelector('.gr-notice') ? document.querySelector('.gr-notice').textContent : '' }}; }}")
    doc = G(A, f"() => {{ {GR}.save(); return JSON.parse(localStorage.getItem(grKey())); }}")
    ok("GEO v7 -> v8: used slices stay used, the bucket keeps exactly its gold", after["h"]["slices"] == before["h"]["slices"] and after["bucket"] == before["bucket"] and after["ml"] == before["ml"], f"{before['bucket']} -> {after['bucket']}")
    ok("GEO v7 -> v8: geology {version 3 (9.1), from 1}, told once", doc["geology"].get("version") == 3 and doc["geology"].get("from") == 1 and doc["geology"].get("noted") is True and "neu vermessen" in after["notice"], str(doc["geology"]))


# ======================================================================
# PROSPECTING
# ======================================================================

SLICE_SUM = r"""([x, z, r]) => {
  // the used-slice index of every column round (x, z) (the sample's kernel stays well inside r)
  const g = window.__goldrush, t = g.terrain(), m = g.mining(), out = [];
  const ci = Math.round((x - t.x0) / t.cell), cj = Math.round((z - t.z0) / t.cell), rr = Math.ceil(r / t.cell);
  for (let j = cj - rr; j <= cj + rr; j++) for (let i = ci - rr; i <= ci + rr; i++) out.push([i, j, m.cidx[j * t.vps + i]]);
  return out;
}"""
GOLD_OF = r"""(cols) => {
  // the gold of the slices that were used up between two cidx snapshots: [i, j, before, after]
  const g = window.__goldrush, f = g.terrain().field, vox = {}; let ug = 0, n = 0;
  for (const [i, j, a, b] of cols) for (let iy = b; iy < a; iy++) { const v = f.voxel(i, j, iy, vox); ug += v.fineUg + (v.cls ? v.massUg : 0); n++; }
  return { ug, n };
}"""


def prospect(A):
    fresh(A, 4242)
    G(A, f"() => {{ const g = {GR}; g.grant('shovel'); g.equipNow('shovel'); }}")
    st = G(A, f"() => {GR}.shopView().items.find((i) => i.id === 'prospectkit')")
    ok("PRO the sample kit is sold after the gold pan (locked before)", st["state"] == "locked" and any("Goldpfanne" in n["text"] for n in st["needs"]), str(st["needs"]))
    grant(A, ["bucket", "pan", "prospectkit"])
    G(A, f"() => {GR}.aimAt({{ x: 0.6, z: 5.0, yaw: 0, pitch: -0.35 }})")
    aim = G(A, f"() => {{ const g = {GR}; g.aimAt({{ x: 0.6, z: 5.0, yaw: 0, pitch: -0.35 }}); return g.aim(); }}")
    hx, hz = aim["x"], aim["z"]
    cols0 = G(A, SLICE_SUM, [hx, hz, 0.45])
    hud0 = G(A, f"() => {GR}.hudState()")
    s = G(A, f"() => {GR}.sampleNow()")
    cols1 = G(A, SLICE_SUM, [hx, hz, 0.45])
    used = [[a[0], a[1], a[2], b[2]] for a, b in zip(cols0, cols1) if a[2] != b[2]]
    gold = G(A, GOLD_OF, used)
    bag = G(A, f"() => {GR}.prospect().bags[0]")
    ok("PRO a sample is a real dig right at the crosshair: its gold = the used slices' gold", s and s["ok"] and gold["ug"] == bag["ug"] and gold["n"] > 0 and abs(s["x"] - hx) < 0.01 and abs(s["z"] - hz) < 0.01, f"bag {bag['ug']} ug, slices {gold['n']} -> {gold['ug']} ug")
    vols = [s["ml"]]
    for _ in range(4):
        r = G(A, f"() => {GR}.sampleNow()")
        if r and r.get("ok"):
            vols.append(r["ml"])
    ok("PRO samples are 0.5-1.5 l", all(500 <= v <= 1500 for v in vols), str(vols))
    hud1 = G(A, f"() => {GR}.hudState()")
    ok("PRO nothing tells the gold before washing (no gold figure in the HUD, no heatmap)", "mg" not in json.dumps(hud1) and not G(A, f"() => {GR}.terrain().heatmap"), str(hud1.get("toast")))
    # wash them at the trough
    G(A, f"() => {GR}.pose({{ x: -16.12, z: 2.0, yaw: Math.PI / 2, pitch: -0.3 }})")
    sn = G(A, f"() => {GR}.stationNow()")
    ok("PRO at the trough: 'Probe n auswaschen'", sn and sn["id"] == "pan-sample", str(sn))
    times, notes = [], []
    pouch0 = G(A, f"() => {GR}.economy().pouchUg")
    for _ in range(len(vols)):
        G(A, f"() => {GR}.procAct('pan-sample')")
        w = G(A, f"() => {GR}.procWork(10)")
        c = G(A, f"() => {GR}.procCollect()")
        times.append(round(w["t"], 2))
        notes.append(c.get("sample"))
    pr = G(A, f"() => {GR}.prospect()")
    ok("PRO the test pan is quick (<= 4 s of swirling a sample)", all(t <= 4.05 for t in times), str(times))
    line = pr["view"]["notes"][0]
    ok("PRO the notebook line: place, depth, ground, litres, kg, mg gold, mg/l - plain numbers", all(k in line for k in ("head", "where", "amount", "gold", "grade")) and "mg/l" in line["grade"] and " l · " in line["amount"] and "kg" in line["amount"], json.dumps(line, ensure_ascii=False))
    pouch1 = G(A, f"() => {GR}.economy().pouchUg")
    ok("PRO what the pan keeps goes into the pouch (= the notebook's gold)", pouch1 - pouch0 == sum(n["ug"] for n in notes), f"{pouch1 - pouch0} vs {sum(n['ug'] for n in notes)}")
    d = ledger(A)
    ok("PRO the ledger stays exact (samples in / recovered / tailings)", d[0] == 0 and d[1] == 0, str(d[:2]))
    G(A, f"() => {GR}.openPanel('notebook')")
    txt = G(A, f"() => {GR}.panelText('notebook')") or ""
    G(A, f"() => {GR}.closeStation()")
    ok("PRO the notebook panel lists the samples (no colours / verdicts)", "Probe" in txt and "mg/l" in txt and "gut" not in txt.lower() and "schlecht" not in txt.lower())
    # flags: numbered, at most 12, take one out
    res = [G(A, f"(p) => {GR}.flagAt(p[0], p[1])", [-6 + k * 1.2, -15.0]) for k in range(13)]
    ok("PRO flags: numbered 1..12, the 13th refused", [r["n"] for r in res[:12]] == list(range(1, 13)) and res[12]["kind"] == "full", str(res[-2:]))
    G(A, f"() => {GR}.flagAt(-6 + 1.2 * 4, -15.0)")
    n_before = len(G(A, f"() => {GR}.prospect()")["notes"])
    reload(A)
    pr2 = G(A, f"() => {GR}.prospect()")
    ok("PRO notebook and flags are saved", len(pr2["notes"]) == n_before and len(pr2["flags"]) == 11 and 5 not in [f["n"] for f in pr2["flags"]], f"{len(pr2['notes'])} notes, {len(pr2['flags'])} flags")
    # the notebook keeps the last 20
    taken = 0
    for k in range(4):
        G(A, f"(k) => {GR}.aimAt({{ x: 0.6 + k * 0.35, z: 5.0, yaw: 0, pitch: -0.35 }})", k)
        for _ in range(6):
            r = G(A, f"() => {GR}.sampleNow()")
            taken += 1 if r and r.get("ok") else 0
        G(A, f"() => {GR}.pose({{ x: -16.12, z: 2.0, yaw: Math.PI / 2, pitch: -0.3 }})")
        for _ in range(6):
            G(A, f"() => {GR}.procAct('pan-sample')"); G(A, f"() => {GR}.procWork(10)"); G(A, f"() => {GR}.procCollect()")
    notes = G(A, f"() => {GR}.prospect()")["notes"]
    ok("PRO the notebook keeps the last 20 samples (the newest)", taken + n_before > 20 and len(notes) == 20 and notes[-1]["n"] == n_before + taken, f"{taken} more taken, {len(notes)} kept, last #{notes[-1]['n']}")


# ======================================================================
# CONTRACT
# ======================================================================

def contract(A):
    fresh(A, 4242)
    c0 = G(A, f"() => {GR}.contract()")
    ok("CON the original mountain is measured (m3 above the floor, ~1 000 m3)", 700 < c0["v0"] < 1600 and c0["pct"] == 0, f"{c0['v0']:.0f} m3")
    G(A, f"() => {{ const g = {GR}; g.grant('shovel'); g.equipNow('shovel'); }}")
    # a cut high on the flank: removal = the cut's volume (it is all above the floor)
    G(A, f"() => {GR}.aimAt({{ x: 0.6, z: 4.6, yaw: 0, pitch: -0.25 }})")
    r = G(A, f"() => {GR}.act({{ visuals: false, tool: 'shovel' }})")
    c1 = G(A, f"() => {GR}.contract()")
    ok("CON removal measured on the ground: the cut's volume above the floor", r["ok"] and abs((c1["removedM3"] - c0["removedM3"]) * 1e6 - r["volumeMl"]) < 30, f"{(c1['removedM3'] - c0['removedM3']) * 1e6:.0f} ml vs cut {r['volumeMl']} ml")
    ok("CON tonnes from the cut's mass", abs(c1["removedKg"] * 1000 - r["massG"]) <= 2, f"{c1['removedKg'] * 1000:.0f} g vs {r['massG']} g")
    # flat claim far from the mountain: digging there never counts
    G(A, f"() => {GR}.aimAt({{ x: 8.0, z: 7.0, yaw: 0, pitch: -1.0 }})")
    y = G(A, f"() => {GR}.aim()")
    r2 = G(A, f"() => {GR}.act({{ visuals: false, tool: 'shovel' }})")
    c2 = G(A, f"() => {GR}.contract()")
    ok("CON digging the flat claim does not count", r2 and r2["ok"] and r2["volumeMl"] > 0 and abs(c2["removedM3"] - c1["removedM3"]) < 1e-7 and c2["mountainG"] == c1["mountainG"], f"aim y {y.get('y')}, cut {r2 and r2.get('volumeMl')} ml")
    sig0 = G(A, f"() => {GR}.boardSig()")
    G(A, f"() => {GR}.aimAt({{ x: 0.6, z: 4.6, yaw: 0, pitch: -0.25 }})")
    for _ in range(60):
        G(A, f"() => {GR}.act({{ visuals: false, tool: 'shovel' }})")
    # (the board is painted in the real frame loop's station tick, not in walk()'s update: wait for real frames)
    G(A, f"() => {GR}.setPaused(false)")
    wait_for(lambda: G(A, f"() => {GR}.boardSig()") != sig0, 3)
    ok("CON the board is repainted when the numbers change", G(A, f"() => {GR}.boardSig()") != sig0)
    items = G(A, f"() => {GR}.shopView().items")
    conv = next(i for i in items if i["id"] == "conveyor")
    ok("CON the conveyor is locked by the contract (0.9 %) - the need says so", conv["state"] == "locked" and any(n.get("contract") and not n["met"] and "Bergauftrag" in n["text"] for n in conv["needs"]), json.dumps(conv["needs"], ensure_ascii=False))
    st = G(A, """async () => { const s = await import('/games/goldrush/goldrush-shop.js'); const it = s.shopItem('conveyor');
      const base = { owned: new Set(['hand', 'shovel']), upgrades: new Set(), equipment: new Set(['bulkhopper', 'sluice', 'pan', 'bucket']), hardSeen: true, cashCents: 1e7 };
      return { below: s.itemStatus(it, { ...base, mountainPct: 0.89 }).state, at: s.itemStatus(it, { ...base, mountainPct: 0.9 }).state,
        steps: ['trommel', 'excavator', 'excavator.breaker'].map((id) => s.shopItem(id).requires.mountainPct) }; }""")
    ok("CON contract steps: conveyor 0.9, trommel 1.1, excavator 1.45, breaker 2.0 % - money AND progress", st["below"] == "locked" and st["at"] == "available" and st["steps"] == [1.1, 1.45, 2.0], str(st))
    G(A, f"() => {GR}.setPaused(false)")
    gr_pause(A)
    line = G(A, "() => document.querySelector('[data-role=pause-contract]').textContent")
    ok("CON the pause card shows the contract", line.startswith("Bergauftrag") and "%" in line and "m³" in line, line)
    G(A, f"() => {GR}.openPanel('contract')")
    txt = G(A, f"() => {GR}.panelText('contract')") or ""
    G(A, f"() => {GR}.closeStation()")
    ok("CON the board's panel: original, removed, remaining, progress, the unlock steps", all(w in txt for w in ("Ursprünglicher Berg", "Abgetragen", "Verbleibend", "Förderband", "Kompaktbagger")))


# ======================================================================
# CONVEYOR
# ======================================================================

def conveyor(A):
    fresh(A, 4242)
    grant(A, ["shovel", "bucket", "pan", "wheelbarrow", "sluice", "bulkhopper", "feeder", "conveyor"])
    G(A, f"() => {{ const g = {GR}; g.equipNow('shovel'); g.procInstallSluice(); g.procInstallAuto(); }}")
    p0 = G(A, f"() => {GR}.plant()")
    ok("CNV delivered as a kit (not built yet)", p0["conveyor"]["state"] == "delivered")
    G(A, f"() => {GR}.pose({{ x: -15.05, z: -10.95, yaw: Math.PI, pitch: -0.3 }})")
    sn = G(A, f"() => {GR}.stationNow()")
    G(A, f"() => {GR}.useStation()")
    frames(A, 3.6)
    ok("CNV [E] at the post builds intake and belt", sn and sn["id"] == "conveyor-build" and G(A, f"() => {GR}.plant()")["conveyor"]["state"] == "ready", str(sn))
    # states: AUTO without water = waiting; on + empty = starved
    st = G(A, f"() => {GR}.plant()")["conveyor"]["status"]["key"]
    G(A, f"() => {GR}.procConveyorMode('stop')")
    frames(A, 0.2)
    off = G(A, f"() => {GR}.plant()")["conveyor"]["status"]["key"]
    G(A, f"() => {GR}.procConveyorMode('on')")
    frames(A, 0.5)
    starved = G(A, f"() => {GR}.plant()")["conveyor"]["status"]["key"]
    ok("CNV states: AUTO waits for the sluice's water, AUS = off, AN + empty = starved", st == "waiting" and off == "off" and starved == "starved", f"{st} / {off} / {starved}")
    # dig straight into it from the mountain's foot
    G(A, f"() => {GR}.procConveyorMode('stop')")
    spot = G(A, f"() => {{ const g = {GR}; for (let x = -13.3; x < -11; x += 0.15) {{ const d = g.aimAt({{ x, z: -9.35, yaw: -Math.PI / 2, pitch: -0.3 }}); if (d != null && d < 2.3 && g.aim().state === 'dig') return x; }} return null; }}")
    r = G(A, f"() => {GR}.act({{ visuals: false, tool: 'shovel' }})")
    ok("CNV standing at the intake, the shovel's dig goes straight into it", spot is not None and r and r["intoMl"] > 0 and G(A, f"() => {GR}.plant()")["conveyor"]["intakeMl"] == r["intoMl"], f"x {spot}, into {r and r.get('intoMl')}")
    # fill it with dev material, then run: transit and rate
    G(A, """async () => { const m = await import('/games/goldrush/goldrush-devactions.js'); const pr = window.__goldrush.procObj(); pr.devSetIntake(m.devBatch('paydirt', 200000)); }""")
    b0 = G(A, f"() => {GR}.plant()")["bulk"]["ml"]
    G(A, f"() => {GR}.procConveyorMode('on')")
    t_first, t = None, 0.0
    while t < 30:
        frames(A, 0.5)
        t += 0.5
        if t_first is None and G(A, f"() => {GR}.plant()")["bulk"]["ml"] > b0:
            t_first = t
    p = G(A, f"() => {GR}.plant()")
    ok("CNV the material travels: it reaches the bulk hopper after ~20 s (belt length / speed)", t_first is not None and 15 <= t_first <= 24, f"first at {t_first} s, lumps on the belt {p['conveyor']['lumps']}")
    m0 = p["bulk"]["ml"]
    frames(A, 30)
    m1 = G(A, f"() => {GR}.plant()")["bulk"]["ml"]
    rate = (m1 - m0) / 1000 / 0.5
    ok("CNV capacity ~64 l/min (measured at the head)", 55 <= rate <= 72, f"{rate:.1f} l/min")
    # backpressure: the bulk hopper full -> blocked, nothing lost, then on again
    G(A, """async () => { const m = await import('/games/goldrush/goldrush-devactions.js'); const pr = window.__goldrush.procObj(); pr.devSetBulk(m.devBatch('paydirt', pr.bulk.capacityMl)); }""")
    frames(A, 3)
    pb = G(A, f"() => {GR}.plant()")
    held = pb["conveyor"]["intakeMl"] + pb["conveyor"]["beltMl"]
    frames(A, 5)
    pb2 = G(A, f"() => {GR}.plant()")
    ok("CNV a full bulk hopper blocks the belt (backpressure): it stops, keeps its load", pb["conveyor"]["status"]["key"] == "blocked" and pb2["conveyor"]["intakeMl"] + pb2["conveyor"]["beltMl"] == held, f"{pb['conveyor']['status']['text']}, held {held}")
    G(A, """() => { const pr = window.__goldrush.procObj(); pr.devSetBulk(null); }""")
    frames(A, 2)
    ok("CNV room again: it runs on by itself", G(A, f"() => {GR}.plant()")["conveyor"]["status"]["key"] == "moving")
    d = ledger(A)
    ok("CNV the ledger exact through all that (gold and mass)", d[0] == 0 and d[1] == 0, str(d[:2]))
    # the barrow tips into it
    G(A, f"() => {GR}.procConveyorMode('stop')")
    G(A, """async () => { const m = await import('/games/goldrush/goldrush-devactions.js'); const pr = window.__goldrush.procObj(); pr.devSetIntake(null); pr.devSetBarrow(m.devBatch('paydirt', 60000)); }""")
    ml = G(A, f"() => {GR}.procPour('barrow', 'intake')")
    ok("CNV the barrow tips into the intake (exact)", ml == 60000 and G(A, f"() => {GR}.plant()")["conveyor"]["intakeMl"] == 60000, str(ml))


# ======================================================================
# TROMMEL + HIGH-FLOW SLUICE
# ======================================================================

def trommel(A):
    fresh(A, 4242)
    plant_up(A, PLANT, water=True)
    G(A, f"() => {GR}.procConveyorMode('on')")
    G(A, """async () => { const m = await import('/games/goldrush/goldrush-devactions.js'); const pr = window.__goldrush.procObj(); pr.devSetIntake(m.devBatch('paydirt', 200000)); }""")
    s0 = G(A, f"() => {GR}.plant()")
    frames(A, 60)
    p = G(A, f"() => {GR}.plant()")
    tr = p["trommel"]
    ok("TRM it screens what the belt brings (running, spray, the drum turns)", tr["status"]["key"] in ("moving", "starved") and tr["stats"]["inMl"] > 30000, f"{tr['status']['text']}, in {tr['stats']['inMl']} ml")
    st = tr["stats"]
    ok("TRM the split is exact: undersize + oversize = what went in (to the litre's ml)", st["underMl"] + st["overMl"] + tr["feedMl"] == st["inMl"], f"{st['underMl']} + {st['overMl']} + feed {tr['feedMl']} vs in {st['inMl']}")
    ok("TRM the gold follows the fine stream: >= 95 % in the undersize, every piece with it", st["underUg"] >= 0.95 * (st["underUg"] + st["overUg"]), f"under {st['underUg']} ug, over {st['overUg']} ug")
    comp = G(A, f"() => {{ const tr = {GR}.procObj().trommel; const c = tr.oversize.comp(); const m = c[0] + c[1] + c[2] + c[3]; return {{ coarse: (c[2] + c[3]) / m, pieces: tr.oversize.pieces }}; }}")
    ok("TRM the oversize is the coarse part (gravel / stone dominate)", comp["coarse"] > 0.55 and comp["pieces"] == 0, str(comp))
    d = ledger(A)
    ok("TRM the ledger exact", d[0] == 0 and d[1] == 0, str(d[:2]))
    # the oversize back into a barrow (recoverable)
    over = G(A, f"() => {GR}.plant()")["trommel"]["overMl"]
    grant(A, ["wheelbarrow"])
    G(A, f"() => {GR}.procBarrowPlace(-21.6, -4.0, Math.PI / 2)")
    r = G(A, f"() => {GR}.procAct('oversize-barrow')")
    p2 = G(A, f"() => {GR}.plant()")
    ok("TRM the oversize is recoverable: shovelled into the barrow, exactly", r["ok"] and r["ml"] == min(over, 85000) and p2["trommel"]["overMl"] == over - r["ml"], f"{r} from {over}")
    # blocked by a full bulk hopper, on again
    G(A, """async () => { const m = await import('/games/goldrush/goldrush-devactions.js'); const pr = window.__goldrush.procObj(); pr.devSetIntake(m.devBatch('paydirt', 200000)); pr.devSetBulk(m.devBatch('paydirt', pr.bulk.capacityMl)); }""")
    frames(A, 70)                                             # (the trommel's feed box fills first, then the belt stops)
    pb = G(A, f"() => {GR}.plant()")
    G(A, """() => { const pr = window.__goldrush.procObj(); pr.devSetBulk(null); }""")
    frames(A, 3)
    ok("TRM a full bulk hopper stops the trommel (and the belt behind it); room -> it runs on", pb["trommel"]["status"]["key"] == "blocked" and pb["conveyor"]["status"]["key"] == "blocked" and G(A, f"() => {GR}.plant()")["trommel"]["status"]["key"] == "moving", f"{pb['trommel']['status']['text']} / {pb['conveyor']['status']['text']}")
    # the high-flow sluice
    before = G(A, f"() => {GR}.plant()")
    grant(A, ["sluice.highflow"])
    frames(A, 0.5)
    hf = G(A, f"() => {GR}.plant()")
    ok("HFS the high-flow sluice: wider box, riffles for 640 l, 32 l/min with the feeder (was 12-14)", hf["sluice"]["highflow"] and hf["sluice"]["width"] > 1.5 and hf["sluice"]["riffleL"] == 640 and hf["feeder"]["rate"] == 32 and before["feeder"]["rate"] in (12, 14), str(hf["sluice"]))
    G(A, f"() => {GR}.procFeederMode ? {GR}.procFeederMode('on') : null")
    G(A, """async () => { const m = await import('/games/goldrush/goldrush-devactions.js'); const pr = window.__goldrush.procObj(); pr.devSetBulk(m.devBatch('paydirt', 200000)); }""")
    frames(A, 4)
    sl0 = G(A, f"() => {GR}.procObj().sluice.stats.processedMl")
    frames(A, 30)
    sl1 = G(A, f"() => {GR}.procObj().sluice.stats.processedMl")
    rate = (sl1 - sl0) / 1000 / 0.5
    ok("HFS it washes ~32 l/min fed evenly", 26 <= rate <= 34, f"{rate:.1f} l/min")


# ======================================================================
# EXCAVATOR
# ======================================================================

def excavator(A):
    fresh(A, 4242)
    plant_up(A, PLANT + ["excavator"], water=False)
    G(A, f"() => {GR}.procConveyorMode('stop')")
    e0 = G(A, f"() => {GR}.exc()")
    ok("EXC delivered by the intake, empty, the bucket on", e0 and e0["ml"] == 0 and e0["attachment"] == "bucket" and not e0["inCab"])
    # get in from its left side with [E]
    c = G(A, f"() => {{ const e = {GR}.exc(); return {{ x: e.x - Math.sin(e.heading) * 1.4, z: e.z - Math.cos(e.heading) * 1.4, yaw: e.heading + Math.PI }}; }}")
    G(A, f"(c) => {GR}.pose({{ x: c.x, z: c.z, yaw: c.yaw, pitch: -0.2 }})", c)
    sn = G(A, f"() => {GR}.stationNow()")
    G(A, f"() => {GR}.useStation()")
    ex = G(A, f"() => {GR}.exc()")
    ok("EXC [E] at the cab gets you in (the view from the seat)", sn and sn["id"] == "exc-enter" and ex["cab"], str(sn))
    hs = G(A, f"() => {GR}.hudState()")
    G(A, f"() => {GR}.walk(0.1, 0, 0)")
    work = G(A, "() => document.querySelector('.gr-work').textContent")
    mats = G(A, "() => document.querySelector('.gr-mat[data-mat=scoop]').textContent")
    ok("EXC the cab's HUD is minimal: the bucket in the material row, the target line, [E] out", "Löffel" in mats and work and "[E] Aussteigen" in (G(A, "() => document.querySelector('.gr-prompt').textContent") or ""), f"{mats} | {work}")
    # driving: forward, turn, the ground under it
    sp = excavator_at_intake(A)
    a = G(A, f"() => {GR}.exc()")
    G(A, f"() => {GR}.excPress('none', 2.0, 1, 0)")
    b = G(A, f"() => {GR}.exc()")
    G(A, f"() => {GR}.excPress('none', 2.0, 0, 1)")
    c2 = G(A, f"() => {GR}.exc()")
    gy = G(A, f"(p) => {GR}.heightAt(p.x, p.z)", {"x": c2["x"], "z": c2["z"]})
    tm = G(A, "() => { const m = window.__goldrush.procObj().excavator.marks; return { used: m.used, vis: m.visibleCount, n: m.n, geo: window.__goldrush.info().geometries }; }")
    ok("EXC driving leaves track imprints (a fixed pool of instances, nothing new per mark)", tm["vis"] >= 8 and tm["used"] <= tm["n"], str(tm))
    ok("EXC W drives it forward on its tracks, A / D turn it, it sits on the ground", Math.hypot(b["x"] - a["x"], b["z"] - a["z"]) > 1.2 if False else math.hypot(b["x"] - a["x"], b["z"] - a["z"]) > 1.2 and abs(c2["heading"] - b["heading"]) > 0.6 and abs(c2["y"] - gy) < 0.35, f"moved {math.hypot(b['x'] - a['x'], b['z'] - a['z']):.2f} m, turned {abs(c2['heading'] - b['heading']):.2f} rad")
    # the slope limit: straight at the mountain's middle - it stops on the flank
    G(A, f"(s) => {GR}.excPlace(s.x, s.z, Math.atan2(-(-6 - s.z), 0 - s.x))", sp)
    G(A, f"() => {GR}.excPress('none', 12, 1, 0)")
    f = G(A, f"() => {GR}.exc()")
    ok("EXC it does not climb the steep flank (stops, ~28 deg max)", math.hypot(f["x"], f["z"] + 6) > 5.0 and abs(f["pitch"]) < 0.55, f"at {f['x']:.1f}, {f['z']:.1f}, pitch {f['pitch']:.2f}")
    # the scoop: a real batch of exactly the cells it took
    excavator_at_intake(A)
    aim, t = aim_for(A, "scoop", yaws=[-1.57, -1.4, -1.75, -1.2, -1.95])
    hx, hz = t["hit"]["x"], t["hit"]["z"]
    CARRIED = "() => { const m = window.__goldrush.mining(); let u = m.carriedFineUg; for (const l of m.carried.values()) for (const it of l) u += it.massUg; return u; }"
    cols0 = G(A, SLICE_SUM, [hx, hz, 1.6])
    c0 = G(A, CARRIED)
    r = G(A, f"() => {GR}.excNow('scoop')")
    cols1 = G(A, SLICE_SUM, [hx, hz, 1.6])
    c1 = G(A, CARRIED)
    used = [[x[0], x[1], x[2], y[2]] for x, y in zip(cols0, cols1) if x[2] != y[2]]
    gold = G(A, GOLD_OF, used)
    e = G(A, f"() => {GR}.exc()")
    ok("EXC the scoop is a real dig: the used slices' gold = the bucket + what slid aside (carried), 30-60 l", r["ok"] and 30000 <= e["ml"] <= 60000 and gold["ug"] == e["ug"] + (c1 - c0), f"bucket {e['ml']} ml {e['ug']} ug + slid {c1 - c0} ug = slices {gold['n']} -> {gold['ug']} ug")
    # 4-7 x the shovel: the excavator's cycle (scoop + dump at the intake, its real phase times) vs the shovel's stroke
    dump_aim, _ = aim_for(A, "dump", "intake")
    G(A, f"(a) => {GR}.excAim(a[0], a[1])", list(dump_aim))
    G(A, f"() => {GR}.excNow('dump')")
    total_ml, total_t = 0, 0.0
    G(A, f"() => {GR}.setPaused(true)")
    for k in range(3):
        aim, _ = aim_for(A, "scoop", yaws=[-1.57, -1.4, -1.75, -1.2, -1.95, -1.05, -2.1])
        G(A, f"(a) => {GR}.excAim(a[0], a[1])", list(aim))
        t0 = 0.0
        G(A, f"() => {GR}.excPress('dig', 0.05)")
        while G(A, f"() => {GR}.exc()")["task"] and t0 < 10:
            G(A, f"() => {GR}.excPress('none', 0.1)"); t0 += 0.1
        ml = G(A, f"() => {GR}.exc()")["ml"]
        G(A, f"(a) => {GR}.excAim(a[0], a[1])", list(dump_aim))
        G(A, f"() => {GR}.excPress('dump', 0.05)")
        while G(A, f"() => {GR}.exc()")["task"] and t0 < 20:
            G(A, f"() => {GR}.excPress('none', 0.1)"); t0 += 0.1
        total_ml += ml
        total_t += t0 + 0.1
    G(A, f"() => {GR}.setPaused(false)")
    exc_lpm = total_ml / 1000 / (total_t / 60)
    shovel = G(A, f"() => {GR}.toolDefs().find((d) => d.id === 'shovel')")
    shovel_lpm = shovel["kernel"]["vol"] * 1000 / (shovel["cycle"][0] / 60)
    ratio = exc_lpm / shovel_lpm
    ok("EXC 4-7 x the manual shovel (litres a minute at a face next to the intake)", 4.0 <= ratio <= 7.0, f"excavator {exc_lpm:.0f} l/min vs shovel {shovel_lpm:.0f} l/min = {ratio:.1f} x")
    # a partial dump: the intake nearly full - only the room goes, the rest stays in the bucket
    aim, _ = aim_for(A, "scoop", yaws=[-1.57, -1.4, -1.75, -1.2, -1.95, -1.05, -2.1])
    G(A, f"(a) => {GR}.excAim(a[0], a[1])", list(aim))
    G(A, f"() => {GR}.excNow('scoop')")
    G(A, """async () => { const m = await import('/games/goldrush/goldrush-devactions.js'); const pr = window.__goldrush.procObj(); pr.devSetIntake(m.devBatch('paydirt', 230000)); }""")
    before = G(A, f"() => {GR}.exc()")["ml"]
    G(A, f"(a) => {GR}.excAim(a[0], a[1])", list(dump_aim))
    rr = G(A, f"() => {GR}.excNow('dump')")
    pl = G(A, f"() => {GR}.plant()")
    ok("EXC partial transfer: a nearly full intake takes its room, the rest stays in the bucket", rr["ok"] and pl["conveyor"]["intakeMl"] == 240000 and rr["rest"] == before - (240000 - 230000), f"{before} -> moved {rr['ml']}, rest {rr['rest']}")
    d = ledger(A)
    ok("EXC the ledger exact (bucket = a container)", d[0] == 0 and d[1] == 0, str(d[:2]))
    # rock: the bucket does not cut intact stone; the breaker cracks it, then the bucket takes the rubble
    stone = G(A, """() => { const g = window.__goldrush, t = g.terrain(); let best = null;
      for (let k = 0; k < t.vps * t.vps; k++) { const h = t.height[k]; if (!(h <= t.stoneTop[k] + 1e-4 && h >= t.stoneBot[k])) continue;
        const i = k % t.vps, j = (k - i) / t.vps, x = t.x0 + i * t.cell, z = t.z0 + j * t.cell; if (!t.inDigArea(x, z)) continue;
        if (!best || h < best.h) best = { x, z, h }; } return best; }""")
    G(A, f"() => {GR}.excExit()")
    grant(A, ["excavator.breaker"])
    G(A, f"(s) => {GR}.excPlace(s.x - 2.9, s.z, 0)", stone)
    G(A, f"() => {GR}.excEnter()")
    G(A, """async () => { const pr = window.__goldrush.procObj(); pr._devTail(pr.excavator.bucket.batch); pr.excavator.bucket.batch = new pr.excavator.bucket.batch.constructor({}); }""")
    rs = G(A, f"(s) => {GR}.excScoopAt(s.x, s.z)", stone)
    ok("EXC intact rock stops the bucket (no cut, nothing taken)", rs is not None and not rs["ok"] and rs.get("blocked"), str(rs))
    G(A, f"() => {GR}.excAttach('breaker')")
    br = G(A, f"(s) => {GR}.excBreakAt(s.x, s.z)", stone)
    rub = G(A, f"(s) => {{ const t = {GR}.terrain(), i = Math.round((s.x - t.x0) / t.cell), j = Math.round((s.z - t.z0) / t.cell); return t.rubble[j * t.vps + i]; }}", stone)
    G(A, f"() => {GR}.excAttach('bucket')")
    rs2 = G(A, f"(s) => {GR}.excScoopAt(s.x, s.z)", stone)
    ok("EXC the breaker cracks it to rubble, then the bucket takes the rubble (as stone)", br and sum(b.get("fractured", 0) for b in br) > 0 and rub > 0 and rs2 and rs2["ok"] and rs2["massByMat"][3] > 0, f"fractured {[b.get('fractured') for b in br]}, rubble {rub} cm, then {rs2 and rs2.get('ml')} ml")
    # out again
    G(A, f"() => {GR}.excExit()")
    ok("EXC [E] gets you out beside the cab", not G(A, f"() => {GR}.exc()")["cab"] and not G(A, f"() => {GR}.exc()")["inCab"])


# ======================================================================
# FULL CHAIN with a save / reload halfway
# ======================================================================

# every discrete find in every MaterialBatch the processing system holds (bucket, barrow, intake, belt cells, trommel,
# bulk, feeder, sluice, tray, pan, bags, excavator, ...) - each batch once, and no find key twice
FINDS_JS = r"""async () => {
  const { MaterialBatch } = await import('/games/goldrush/goldrush-material.js');
  const pr = window.__goldrush.procObj(), seen = new Set(), keys = new Map();
  const SKIP = new Set(['ctx', 'scene', 'world', 'economy', 'terrain', 'mining', 'rocks', 'assets', 'hands', 'game', 'player', 'audio', 'model', 'group',
    'pm', 'rig', 'root', 'THREE', 'camera', 'renderer', 'input', 'hud', 'stations', 'parts', 'colliders', 'collider', 'loads', 'geom', 'lumps']);
  let n = 0, batches = 0;
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || seen.has(o) || depth > 7) return;
    seen.add(o);
    if (o.isObject3D || o.isMaterial || o.isBufferGeometry || o.isTexture || ArrayBuffer.isView(o)) return;
    if (o instanceof MaterialBatch) {
      batches++;
      for (const f of o.finds) { n++; keys.set(f.key, (keys.get(f.key) || 0) + 1); }
      return;
    }
    if (Array.isArray(o)) { if (o.length < 5000) for (const v of o) walk(v, depth + 1); return; }
    for (const k of Object.keys(o)) if (!SKIP.has(k)) walk(o[k], depth + 1);
  };
  walk(pr, 0);
  const dup = [...keys.entries()].filter(([k, c]) => k && c > 1).length;
  return { n, batches, dup };
}"""


def chain(A):
    fresh(A, 4242)
    plant_up(A, PLANT + ["excavator", "sluice.highflow", "pan"], water=True)
    G(A, f"() => {GR}.procConveyorMode('auto')")
    G(A, f"() => {GR}.procFeederMode('auto')")
    pouch0 = G(A, f"() => {GR}.economy().pouchUg")
    finds0 = proc(A)["ledger"]["inFinds"]
    washed0 = G(A, f"() => {GR}.economy().stats.washedPieces")
    excavator_at_intake(A)
    dug, dump = 0, None
    for k in range(5):
        dig, _ = aim_for(A, "scoop", yaws=[-1.57, -1.4, -1.75, -1.2, -1.95, -1.05, -2.1])
        G(A, f"(a) => {GR}.excAim(a[0], a[1])", list(dig))
        r = G(A, f"() => {GR}.excNow('scoop')")
        dug += r["ml"] if r and r.get("ok") else 0
        dump = dump or aim_for(A, "dump", "intake")[0]
        G(A, f"(a) => {GR}.excAim(a[0], a[1])", list(dump))
        G(A, f"() => {GR}.excNow('dump')")
    frames(A, 50)
    mid = G(A, f"() => {{ const g = {GR}, p = g.plant(); return {{ belt: p.conveyor.cells, intake: p.conveyor.intakeMl, feed: p.trommel.feedMl, over: p.trommel.overMl, bulk: p.bulk.ml, hop: p.sluice.hopperMl, riff: g.procObj().sluice.riffles.volumeMl }}; }}")
    # the pause menu saves - from then on nothing moves: that state must come back exactly
    gr_pause(A)
    snap = G(A, f"() => {{ const g = {GR}, p = g.plant(), pr = g.proc(); return {{ belt: p.conveyor.cells, phase: p.conveyor.phase, intake: p.conveyor.intakeUg, beltUg: p.conveyor.beltUg, over: p.trommel.overUg, bulk: p.bulk.ug, cont: pr.inContainersUg, in: pr.ledger.inUg, exc: g.exc().ug }}; }}")
    gr_close(A)
    gr_open(A)
    gr_ready(A)
    G(A, f"() => {GR}.setPaused(true)")
    snap2 = G(A, f"() => {{ const g = {GR}, p = g.plant(), pr = g.proc(); return {{ belt: p.conveyor.cells, phase: p.conveyor.phase, intake: p.conveyor.intakeUg, beltUg: p.conveyor.beltUg, over: p.trommel.overUg, bulk: p.bulk.ug, cont: pr.inContainersUg, in: pr.ledger.inUg, exc: g.exc().ug }}; }}")
    ok("CHN halfway: the whole chain loaded (belt, trommel, bulk, sluice)", dug > 150000 and sum(1 for c in mid["belt"] if c) > 3 and mid["bulk"] > 0, json.dumps(mid)[:300])
    diff = {k: (snap[k], snap2[k]) for k in snap if snap[k] != snap2[k] and k != "phase"}
    ok("CHN save / reload mid-chain: belt cells and their position, intake, oversize, bulk, containers, the bucket exactly back", not diff and abs(snap["phase"] - snap2["phase"]) < 1e-3, json.dumps(diff)[:400] + f" phase {snap['phase']:.4f} / {snap2['phase']:.4f}")
    G(A, f"() => {GR}.setPaused(false)")
    G(A, f"() => {GR}.excExit()")
    frames(A, 210)
    # ... and once more while the sluice is at work (the prompt: "save / reload halfway. Repeat.")
    gr_pause(A)
    LED = f"() => {{ const g = {GR}, p = g.plant(), pr = g.proc(); return {{ belt: p.conveyor.cells, bulk: p.bulk.ug, over: p.trommel.overUg, hop: p.sluice.hopperMl, cont: pr.inContainersUg, contG: pr.inContainersG, led: pr.ledger }}; }}"
    r1 = G(A, LED)
    f1 = A.evaluate(FINDS_JS)
    gr_close(A)
    gr_open(A)
    gr_ready(A)
    G(A, f"() => {GR}.setPaused(true)")
    r2 = G(A, LED)
    f2 = A.evaluate(FINDS_JS)
    diff = {k: (r1[k], r2[k]) for k in r1 if r1[k] != r2[k]}
    ok("CHN a second save / reload while the sluice works: the chain, the containers, the ledger and every piece exactly back", not diff and f1["n"] == f2["n"] and f2["dup"] == 0,
       json.dumps(diff)[:300] + f" pieces {f1['n']} / {f2['n']}")
    G(A, f"() => {GR}.setPaused(false)")
    frames(A, 210)
    # clean the riffles out, pan the heavy concentrate - into the pouch
    G(A, f"() => {GR}.procWater(false)")
    G(A, f"() => {GR}.procAct('sluice-clean')")
    G(A, f"() => {GR}.procWork(12)")
    pans = 0
    while pans < 40:
        f = G(A, f"() => {GR}.procAct('pan-fill')")
        if not f or not f.get("ok"):
            break
        G(A, f"() => {GR}.procWork(30)")
        G(A, f"() => {GR}.procCollect()")
        pans += 1
    d = ledger(A)
    L, p = d[2], d[3]
    pouch1 = G(A, f"() => {GR}.economy().pouchUg")
    ok("CHN conservation at the end: gold in = containers + recovered + tailings (ug), mass too (g)", d[0] == 0 and d[1] == 0, f"in {L['inUg']} = cont {p['inContainersUg']} + rec {L['recoveredUg']} + tail {L['tailUg']}; mass diff {d[1]}")
    ok("CHN the recovered gold is in the pouch (nothing created, nothing lost)", pouch1 - pouch0 == L["recoveredUg"] and L["recoveredUg"] > 0, f"pouch +{pouch1 - pouch0} ug, recovered {L['recoveredUg']} ug, {pans} pans")
    fe = A.evaluate(FINDS_JS)
    pin = L["inFinds"] - finds0
    pout = G(A, f"() => {GR}.economy().stats.washedPieces") - washed0
    ok("CHN every discrete find exactly once: pieces in = pieces still in containers + pieces recovered (none twice, none lost)",
       pin > 0 and pin == fe["n"] + pout and fe["dup"] == 0, f"in {pin} = held {fe['n']} (in {fe['batches']} batches, dup keys {fe['dup']}) + recovered {pout}")


# ======================================================================
# SAVE: v8 fields, a new mine, the dev snapshot
# ======================================================================

def save(A):
    fresh(A, 4242)
    plant_up(A, PLANT + ["excavator", "prospectkit", "sluice.highflow"], water=True)
    G(A, f"() => {GR}.flagAt(-5, -14)")
    doc = G(A, f"() => {{ {GR}.save(); return JSON.parse(localStorage.getItem(grKey())); }}")
    pr = doc["processing"]
    ok("SAV v8: geology, prospect, conveyor, trommel, spoil, excavator in the document", doc["saveVersion"] == 8 and doc["geology"]["version"] == 3 and doc["prospect"]["flags"] and all(pr.get(k) for k in ("conveyor", "trommel", "spoil", "excavator")), str(list(pr.keys())))
    # a new mine: nothing of it
    G(A, f"() => {GR}.setPaused(false)")
    gr_pause(A)
    gr_close(A)
    gr_open(A)
    gr_ready(A, choice="new")
    d2 = G(A, f"() => {{ {GR}.save(); return JSON.parse(localStorage.getItem(grKey())); }}")
    p2 = d2["processing"]
    ok("SAV a new mine starts clean: no plant, no excavator, no prospecting, contract at 0", not d2.get("prospect") and not p2.get("conveyor") and not p2.get("excavator") and not p2.get("trommel") and G(A, f"() => {GR}.contract()")["pct"] == 0 and d2["geology"]["version"] == 3)
    # mid-excavation: saved while the bucket is in the cut (its material taken, the arm half way) - the cut, the
    # bucket, the pose and the ledger come back exactly; the motion itself starts again from that pose
    fresh(A, 4242)
    plant_up(A, PLANT + ["excavator"], water=False)
    G(A, f"() => {GR}.procConveyorMode('stop')")
    excavator_at_intake(A)
    aim, _ = aim_for(A, "scoop", yaws=[-1.57, -1.4, -1.75, -1.2, -1.95, -1.05, -2.1])
    G(A, f"(a) => {GR}.excAim(a[0], a[1])", list(aim))
    G(A, f"() => {GR}.excPress('dig', 0.05)")
    t, ph = 0.0, None
    while t < 6:
        st = G(A, f"() => {GR}.exc()")
        ph = st["task"] and st["task"]["phase"]
        if ph in ("fill", "lift") and st["ml"] > 0:
            break
        G(A, f"() => {GR}.excPress('none', 0.05)")
        t += 0.05
    gr_pause(A)
    s1 = G(A, EXC_STATE)
    gr_close(A)
    gr_open(A)
    gr_ready(A)
    G(A, f"() => {GR}.setPaused(true)")
    s2 = G(A, EXC_STATE)
    diff = {k: (s1[k], s2[k]) for k in s1 if k not in ("pose", "x", "z", "heading", "swing") and s1[k] != s2[k]}
    near = all(abs(s1["pose"][j] - s2["pose"][j]) < 1e-3 for j in ("boom", "stick", "tool")) and all(abs(s1[k] - s2[k]) < 2e-3 for k in ("x", "z", "heading", "swing"))
    ok("SAV mid-excavation: the cut, the loaded bucket, the arm's pose, the cab and the ledger come back exactly", ph in ("fill", "lift") and s1["ml"] > 0 and not diff and near and s2["cab"],
       f"saved in '{ph}': bucket {s1['ml']} ml / {s1['ug']} ug; {json.dumps(diff)[:300]}")
    G(A, f"() => {GR}.setPaused(false)")
    dump, _ = aim_for(A, "dump", "intake")
    G(A, f"(a) => {GR}.excAim(a[0], a[1])", list(dump))
    rd = G(A, f"() => {GR}.excNow('dump')")
    d = ledger(A)
    ok("SAV after that reload the bucket tips into the intake as usual, the ledger exact", rd and rd.get("ok") and G(A, f"() => {GR}.plant()")["conveyor"]["intakeMl"] == s1["ml"] and d[0] == 0 and d[1] == 0, f"{rd} {d[:2]}")
    # the dev snapshot: a mechanised mine (belt loaded and moving, the bucket full, samples, flags) - more work
    # afterwards - "Mine vor Entwicklertest wiederherstellen" brings exactly the snapshot's mine back
    grant(A, ["prospectkit", "pan"])
    G(A, f"() => {GR}.procConveyorMode('on')")
    frames(A, 8)
    aim, _ = aim_for(A, "scoop", yaws=[-1.57, -1.4, -1.75, -1.2, -1.95, -1.05, -2.1])
    G(A, f"(a) => {GR}.excAim(a[0], a[1])", list(aim))
    G(A, f"() => {GR}.excNow('scoop')")
    G(A, f"() => {GR}.flagAt(-5, -14)")
    gr_pause(A)
    f1 = G(A, MECH_FP)
    snap = G(A, f"() => {GR}.devSnapshotWrite()")
    G(A, f"() => {GR}.setPaused(false)")
    G(A, f"(a) => {GR}.excAim(a[0], a[1])", list(dump))
    G(A, f"() => {GR}.excNow('dump')")
    frames(A, 20)
    G(A, f"() => {GR}.flagAt(-3, -15)")
    moved = G(A, MECH_FP) != f1
    G(A, f"() => {GR}.devSnapshotRestore()")
    wait_for(lambda: G(A, f"() => !!(window.__goldrush && {GR}.state && {GR}.state().seed)"), 60)
    G(A, f"() => {GR}.setPaused(true)")
    f2 = G(A, MECH_FP)
    diff = {k: (f1[k], f2[k]) for k in f1 if f1[k] != f2[k]}
    ok("SAV the dev snapshot of a mechanised mine comes back exactly (belt cells, intake, trommel, bulk, bucket, notebook, flags, contract, ledger)",
       snap and moved and not diff, json.dumps(diff)[:400])
    # mid-break: the breaker's first blows cracked the rock - a reload brings exactly those cracks back
    A.evaluate("(i) => window.__goldrush.dev9(i)", "p9.breaker")
    st = G(A, f"() => {GR}.exc()")
    _, tg = aim_for(A, "break", yaws=BREAK_YAWS(A), pitches=(-0.2, -0.3, -0.4, -0.5, -0.6, -0.7, -0.8))
    hx, hz = (tg["hit"]["x"], tg["hit"]["z"]) if tg and tg.get("hit") else (st["x"] + 2.9, st["z"])
    G(A, f"(p) => {GR}.excBreakAt(p[0], p[1])", [hx, hz])
    CRACK = f"(p) => {{ const t = {GR}.terrain(), i0 = Math.round((p[0] - t.x0) / t.cell), j0 = Math.round((p[1] - t.z0) / t.cell), out = []; for (let j = j0 - 3; j <= j0 + 3; j++) for (let i = i0 - 3; i <= i0 + 3; i++) {{ const k = j * t.vps + i; out.push(t.crack[k], t.rubble[k], t.height[k]); }} return out; }}"
    c1 = G(A, CRACK, [hx, hz])
    gr_pause(A)
    gr_close(A)
    gr_open(A)
    gr_ready(A)
    G(A, f"() => {GR}.setPaused(true)")
    c2 = G(A, CRACK, [hx, hz])
    ok("SAV mid-break: the cracks and the rubble of the first blows come back exactly", c1 == c2 and any(v for v in c1[0::3]), f"{sum(1 for v in c1[0::3] if v)} cracked columns")
    G(A, f"() => {GR}.setPaused(false)")
    G(A, f"() => {GR}.excExit()")


EXC_STATE = f"""() => {{ const g = {GR}, e = g.exc(), p = g.proc(), c = g.contract();
  return {{ ml: e.ml, g: e.g, ug: e.ug, x: e.x, z: e.z, heading: e.heading, swing: e.swing, pose: e.pose, cab: e.cab, attachment: e.attachment,
    intake: g.plant().conveyor.intakeMl, cont: p.inContainersUg, contG: p.inContainersG, in: p.ledger.inUg, inG: p.ledger.inG, tail: p.ledger.tailUg,
    pct: c.pct, kg: c.removedKg }}; }}"""
MECH_FP = f"""() => {{ const g = {GR}, pl = g.plant(), e = g.exc(), p = g.proc(), c = g.contract(), pr = g.prospect();
  return {{ belt: JSON.stringify(pl.conveyor.cells), beltUg: pl.conveyor.beltUg, intake: pl.conveyor.intakeUg, intakeMl: pl.conveyor.intakeMl, mode: pl.conveyor.mode,
    feed: pl.trommel.feedMl, over: pl.trommel.overUg, bulk: pl.bulk.ug, bulkMl: pl.bulk.ml, bucket: e.ug, bucketMl: e.ml,
    notes: JSON.stringify(pr.notes), flags: JSON.stringify(pr.flags), pct: c.pct, kg: c.removedKg,
    cont: p.inContainersUg, contG: p.inContainersG, in: p.ledger.inUg, rec: p.ledger.recoveredUg, tail: p.ledger.tailUg, cash: g.economy().cashCents }}; }}"""


# ======================================================================
# DEV PACK
# ======================================================================

def dev(A):
    fresh(A, 4242)
    res = {}
    for cid in ["quick.phase9", "p9.prospect", "p9.intake", "p9.plant", "p9.excavator", "p9.rich", "p9.normal", "p9.board", "p9.spoil", "p9.intakeFull", "p9.oversize", "p9.bucketFull", "p9.blocked", "p9.breaker", "p9.status"]:
        res[cid] = A.evaluate("(i) => window.__goldrush.dev9(i)", cid)
    bad = {k: v for k, v in res.items() if not (v and v.get("ok"))}
    ok("DEV the phase-9 pack: preset PHASE 9 MECHANIZED CLAIM and its places all work", not bad, json.dumps(bad, ensure_ascii=False)[:300])
    st = G(A, f"() => {GR}.plant()")
    A.evaluate("(i) => window.__goldrush.dev9(i)", "p9.breaker")
    _, tgt = aim_for(A, "break", yaws=BREAK_YAWS(A), pitches=(-0.2, -0.3, -0.4, -0.5, -0.6, -0.7, -0.8))
    ok("DEV 'Bagger mit Hydraulikhammer' sets it up at intact rock (the breaker on, the rock in front)", G(A, f"() => {GR}.exc()")["attachment"] == "breaker" and tgt is not None, str(tgt)[:200])
    G(A, f"() => {GR}.excExit()")
    A.evaluate("(i) => window.__goldrush.dev9(i)", "quick.phase9")
    ok("DEV the preset leaves the plant built and running on AUTO", st["conveyor"]["state"] == "ready" and st["trommel"]["state"] == "ready" and st["conveyor"]["mode"] == "auto" and st["sluice"]["running"])
    ok("DEV no page errors", not errors(A), str(errors(A)[:3]))


# ======================================================================
# PERF
# ======================================================================

def perf(A):
    fresh(A, 4242)
    A.evaluate("(i) => window.__goldrush.dev9(i)", "quick.phase9")
    frames(A, 1)
    views = {"mine": {"x": -6.0, "y": 4.0, "z": -2.0, "tx": -15.0, "ty": 1.0, "tz": -8.0}, "plant": {"x": -14.0, "y": 3.0, "z": 0.0, "tx": -20.0, "ty": 2.0, "tz": -4.0},
             "intake": {"x": -11.0, "y": 2.2, "z": -6.0, "tx": -15.0, "ty": 1.0, "tz": -10.0}}
    calls = {}
    for k, cam in views.items():
        G(A, "(c) => { const g = window.__goldrush; g.setPaused(true); g.camLook(c); return true; }", cam)
        calls[k] = G(A, "() => window.__goldrush.drawStats()")["main"]
    G(A, f"() => {GR}.setPaused(false)")
    A.evaluate("(i) => window.__goldrush.dev9(i)", "p9.excavator")
    frames(A, 0.3)
    calls["cab"] = G(A, "() => window.__goldrush.drawStats()")["main"]
    ok("PRF draw calls with the whole plant and the excavator in view stay within 220", all(v <= 220 for v in calls.values()), str(calls))
    # frame rate: the plant running, the excavator digging (real frames)
    G(A, """async () => { const m = await import('/games/goldrush/goldrush-devactions.js'); const pr = window.__goldrush.procObj(); pr.devSetIntake(m.devBatch('paydirt', 200000)); }""")
    G(A, f"() => {GR}.setPaused(false)")
    time.sleep(3)
    fs = G(A, f"() => {GR}.info()")
    ok("PRF frame rate with everything running (>= 50 fps)", fs["fps"] >= 50, f"{fs['fps']} fps, {fs['drawCalls']} calls")
    # nothing new uploaded when the machines first come into view (the warm pass)
    mem0 = G(A, "() => window.__goldrush.info()")
    for cam in views.values():
        G(A, "(c) => { const g = window.__goldrush; g.camLook(c); return true; }", cam)
    mem1 = G(A, "() => window.__goldrush.info()")
    ok("PRF no new geometries / textures / programs when the plant comes into view", mem1["geometries"] <= mem0["geometries"] and mem1["textures"] <= mem0["textures"] and mem1["programs"] <= mem0["programs"], f"{mem0} -> {mem1}")


# ======================================================================
# WHEELBARROW HANDLING (the phase-9 handling pass: heavy, not hard to steer)
# ======================================================================

BW = "() => { const w = window.__goldrush.procObj().barrow; return { x: w.x, z: w.z, yaw: w.yaw, v: w.ctl.v, w: w.ctl.w, pushing: w.pushing, kg: w.massKg }; }"


def take_barrow(page):
    sn = G(page, f"() => {GR}.stationNow()")
    G(page, f"() => {GR}.useStation()")
    G(page, f"() => {GR}.walk(0.5, 0, 0)")
    return sn


def handling(A):
    m = A.evaluate("async () => { const c = await import('/games/goldrush/goldrush-wheelbarrow-controller.js'); return [0, 0.5, 1].map((l) => c.measureHandling(l)); }")
    e, h, f = m
    ok("BAR heavy gets going slower, not painfully: 0 -> 90 % empty <= 1.1 s, full <= 1.5 s", e["t90"] <= 1.1 and f["t90"] <= 1.5 and f["t90"] > e["t90"], f"{e['t90']:.2f} / {h['t90']:.2f} / {f['t90']:.2f} s")
    ok("BAR a full barrow needs more room to stop than an empty one (but under 2 m)", e["stop"] < f["stop"] < 2.0, f"{e['stop']:.2f} / {f['stop']:.2f} m")
    ok("BAR a quarter turn at speed takes <= 1.6 s full (keys or looking 45 deg off), the steering answers within 0.15 s",
       f["turn90"] <= 1.6 and f["turn90look"] <= 1.6 and f["latency"] <= 0.15, f"keys {f['turn90']:.2f} s, look {f['turn90look']:.2f} s, latency {f['latency']:.2f} s")
    ok("BAR slow it turns tight (<= 1.4 m at 1 m/s), the top speed full >= 2.4 m/s, up 8 % >= 2.0 m/s", f["radius"] <= 1.4 and f["vmax"] >= 2.4 and f["slope"] >= 2.0,
       f"radius {f['radius']:.2f} m, {f['vmax']:.2f} m/s, slope {f['slope']:.2f} m/s")
    # in the game: the dev course, a full barrow (85 l of gravel)
    fresh(A, 4242)
    A.evaluate("(i) => window.__goldrush.dev9(i)", "p9.course.load100")
    r = A.evaluate("(i) => window.__goldrush.dev9(i)", "p9.course.build")
    ok("BAR the dev course builds (straight, corner, S, bumps, park, slope) with the readout", r and r.get("ok") and A.evaluate("(i) => window.__goldrush.dev9(i)", "p9.course.metrics")["rows"][1][0] == "Endtempo eben", str(r)[:200])
    # over the dug marks: it keeps rolling
    A.evaluate("(i) => window.__goldrush.dev9(i)", "p9.course.bumps")
    take_barrow(A)
    G(A, f"() => {GR}.setPaused(true)")
    b0 = G(A, BW)
    vs, rough = [], []
    for k in range(40):
        G(A, f"() => {GR}.walk(0.1, 0, 1)")
        vs.append(G(A, BW)["v"])
        rough.append(G(A, "() => window.__goldrush.procObj().barrow.ctl.rough"))
    b1 = G(A, BW)
    dist = math.hypot(b1["x"] - b0["x"], b1["z"] - b0["z"])
    ok("BAR a full barrow rolls over the dug marks without stalling (>= 6 m in 4 s, never below 1.2 m/s once going)", b0["pushing"] and dist >= 6.0 and min(vs[15:]) >= 1.2,
       f"{dist:.1f} m, {b0['kg']:.0f} kg, min speed after 1.5 s {min(vs[15:]):.2f} m/s, roughest ground {max(rough):.2f}")
    # steered by the look: on the straight, going, then the view 0.5 rad to the right for 1.5 s
    G(A, f"() => {GR}.setPaused(false)")
    A.evaluate("(i) => window.__goldrush.dev9(i)", "p9.course.straight")
    take_barrow(A)
    G(A, f"() => {GR}.setPaused(true)")
    G(A, f"() => {GR}.walk(1.2, 0, 1)")
    y0 = G(A, BW)["yaw"]
    for k in range(15):
        b = G(A, BW)
        G(A, f"(y) => {GR}.pose({{ yaw: y }})", b["yaw"] - 0.5)
        G(A, f"() => {GR}.walk(0.1, 0, 1)")
    turned = abs(math.atan2(math.sin(G(A, BW)["yaw"] - y0), math.cos(G(A, BW)["yaw"] - y0)))
    ok("BAR looking 0.5 rad to the side pulls a full barrow round decisively (>= 60 deg in 1.5 s)", turned >= math.radians(60), f"{math.degrees(turned):.0f} deg")
    # backing out of the parking box
    G(A, f"() => {GR}.setPaused(false)")
    A.evaluate("(i) => window.__goldrush.dev9(i)", "p9.course.park")
    take_barrow(A)
    G(A, f"() => {GR}.setPaused(true)")
    p0 = G(A, BW)
    G(A, f"() => {GR}.walk(2.5, 0, -1)")
    p1 = G(A, BW)
    back = -((p1["x"] - p0["x"]) * -math.sin(p0["yaw"]) + (p1["z"] - p0["z"]) * -math.cos(p0["yaw"]))
    ok("BAR S backs a full barrow out of the parking box (>= 0.8 m back in 2.5 s)", back >= 0.8, f"{back:.2f} m")
    G(A, f"() => {GR}.setPaused(false)")
    ok("BAR no page errors", not errors(A), str(errors(A)[:3]))


# ======================================================================
# MOBILE
# ======================================================================

def mobile(browser, base, user, out=None):
    ctx, P = client(browser, base, user, dict(viewport={"width": 844, "height": 390}, is_mobile=True, has_touch=True, device_scale_factor=2), extra_init=[seeded()])
    try:
        fresh(P, 4242)
        grant(P, ["shovel", "bucket", "pan", "prospectkit"])
        frames(P, 0.2)
        P.click(".gr-tool")
        vis = P.is_visible("[data-act=sample]") and P.is_visible("[data-act=flag]") and P.is_visible("[data-act=notebook]")
        if out:
            time.sleep(0.3)
            P.screenshot(path=str(out / f"gr9_{TAG}_24a_mobile_tools.png"))
        P.click(".gr-tool")
        ok("MOB the sample kit's actions in the phone's tool sheet (Probe / Fähnchen / Notizbuch)", vis)
        plant_up(P, PLANT + ["excavator"], water=False)
        excavator_at_intake(P)
        frames(P, 0.3)
        st = P.evaluate("() => ({ dig: document.querySelector('.gr-dig-label').textContent, alt: !document.querySelector('.gr-alt-btn').hidden, ctx: document.querySelector('.gr-ctx-btn').textContent })")
        if out:
            time.sleep(0.3)
            P.screenshot(path=str(out / f"gr9_{TAG}_24b_mobile_cab.png"))
        ok("MOB in the cab: SCHAUFELN, KIPPEN, AUSSTEIGEN", st["dig"] == "SCHAUFELN" and st["alt"] and st["ctx"] == "AUSSTEIGEN", str(st))
        P.click(".gr-ctx-btn")
        frames(P, 0.2)
        ok("MOB AUSSTEIGEN gets you out", not G(P, f"() => {GR}.exc()")["cab"] and P.evaluate("() => document.querySelector('.gr-alt-btn').hidden"))
    finally:
        Q.close(P)
        ctx.close()


# ======================================================================
# SHOTS - the 24 fixed review viewpoints
# ======================================================================

def shots(A, out):
    """section 30's fixed views: 01-24 as listed there (23 before / after, 24 on the phone - see mobile()), 25+ extras"""
    def unpause():
        # a closed panel leaves the pause card up on desktop (no pointer lock here): back to the game
        G(A, "() => { document.querySelector('.gr-pause').hidden = true; window.__goldrush.setPaused(false); }")

    def look(name, cam):
        unpause()
        G(A, "() => window.__goldrush.walk(0.1, 0, 0)")
        G(A, "() => window.__goldrush.setPaused(true)")
        G(A, "(c) => window.__goldrush.camLook(c)", cam)
        time.sleep(0.2)
        A.screenshot(path=str(out / f"gr9_{TAG}_{name}.png"))
        G(A, "() => window.__goldrush.setPaused(false)")

    def here(name, sec=0.2):
        unpause()
        frames(A, sec)
        time.sleep(0.35)                                      # a few real frames: the hands' poses follow there
        G(A, "() => window.__goldrush.setPaused(true)")
        time.sleep(0.2)
        A.screenshot(path=str(out / f"gr9_{TAG}_{name}.png"))
        G(A, "() => window.__goldrush.setPaused(false)")

    dev = lambda i: A.evaluate("(i) => window.__goldrush.dev9(i)", i)
    BATCH = "async ([kind, ml, fn]) => { const m = await import('/games/goldrush/goldrush-devactions.js'); window.__goldrush.procObj()[fn](m.devBatch(kind, ml)); }"
    CAMP = {"x": -4.0, "y": 9.0, "z": 12.0, "tx": -15.0, "ty": 0.5, "tz": -4.0}
    fresh(A, 4242)
    look("23a_camp_before", CAMP)
    look("03_camp_fill", {"x": -6.0, "y": 5.0, "z": 9.0, "tx": -12.0, "ty": 0.0, "tz": 2.0})
    look("31_claim_top", {"x": 0.0, "y": 24.0, "z": 12.0, "tx": 0.0, "ty": 0.0, "tz": -6.0})
    dev("quick.phase9")
    G(A, f"() => {GR}.procConveyorMode('stop')")
    # the prospecting views: a sample of the normal mountain, the rich channel, flags, the result
    dev("p9.normal")
    G(A, f"() => {GR}.sampleNow()")
    here("01_normal_mountain_sample", 0.3)
    dev("p9.rich")
    G(A, f"() => {GR}.sampleNow()")
    here("02_rich_channel", 0.3)
    dev("p9.prospect")
    here("29_prospect_flags", 0.3)
    G(A, f"() => {GR}.pose({{ x: -16.12, z: 2.0, yaw: Math.PI / 2, pitch: -0.3 }})")
    G(A, f"() => {GR}.procAct('pan-sample')")
    G(A, f"() => {GR}.procWork(10)")
    here("30_sample_pan")
    G(A, f"() => {GR}.procCollect()")
    G(A, f"() => {GR}.procAct('pan-sample')")
    G(A, f"() => {GR}.procWork(10)")
    G(A, f"() => {GR}.procCollect()")
    G(A, f"() => {GR}.openPanel('notebook')")
    here("04_sample_result")
    G(A, f"() => {GR}.closeStation()")
    dev("p9.board")
    here("05_contract_board", 0.4)
    G(A, f"() => {GR}.openPanel('contract')")
    here("26_contract_panel")
    G(A, f"() => {GR}.closeStation()")
    G(A, f"() => {GR}.pose({{ x: 6, z: 8, yaw: 0, pitch: 0 }})")
    # the plant: empty and idle, then loaded and running
    BELT_CAM = {"x": -14.5, "y": 2.2, "z": -3.5, "tx": -17.0, "ty": 1.8, "tz": -6.6}
    TROM_CAM = {"x": -17.0, "y": 3.8, "z": -1.0, "tx": -20.6, "ty": 2.6, "tz": -3.6}
    look("06_conveyor_empty", BELT_CAM)
    look("09_trommel_idle", TROM_CAM)
    A.evaluate(BATCH, ["paydirt", 230000, "devSetIntake"])
    G(A, f"() => {GR}.procConveyorMode('auto')")
    frames(A, 25)
    look("07_conveyor_loaded", {"x": -16.0, "y": 3.6, "z": -9.6, "tx": -17.6, "ty": 2.2, "tz": -6.0})
    look("08_conveyor_discharge", {"x": -18.1, "y": 4.3, "z": -2.0, "tx": -19.9, "ty": 3.2, "tz": -3.7})
    look("10_trommel_running", TROM_CAM)
    look("11_trommel_material_water", {"x": -19.0, "y": 3.7, "z": -2.3, "tx": -20.4, "ty": 2.8, "tz": -3.5})
    look("12_underflow", {"x": -19.2, "y": 2.3, "z": -1.4, "tx": -20.8, "ty": 1.9, "tz": -3.4})
    dev("p9.oversize")
    look("13_oversize", {"x": -22.4, "y": 2.3, "z": -9.6, "tx": -22.6, "ty": 0.5, "tz": -4.6})
    look("14_entire_plant", {"x": -12.0, "y": 7.5, "z": 1.5, "tx": -19.0, "ty": 1.5, "tz": -5.5})
    look("22_chain_running", {"x": -11.0, "y": 4.6, "z": -2.0, "tx": -18.0, "ty": 1.6, "tz": -6.0})
    look("27_highflow_sluice", {"x": -17.8, "y": 2.2, "z": 0.2, "tx": -19.6, "ty": 0.8, "tz": -2.1})
    # the excavator: parked, from the seat, digging, loaded, dumping, the face it left
    dev("p9.excavator")
    # a short drive out and back: its tracks print into the ground
    G(A, f"() => {GR}.excPress('none', 2.2, 1, 0)")
    G(A, f"() => {GR}.excPress('none', 1.2, 0, 1)")
    G(A, f"() => {GR}.excPress('none', 2.4, -1, 0)")
    G(A, f"() => {GR}.excExit()")
    e = G(A, f"() => {GR}.exc()")
    G(A, f"(e) => {GR}.pose({{ x: e.x - 3.5, z: e.z + 3.5, yaw: 0, pitch: 0 }})", e)
    look("15_excavator_parked", {"x": e["x"] - 2.6, "y": 2.1, "z": e["z"] + 3.6, "tx": e["x"] + 0.3, "ty": 0.9, "tz": e["z"]})
    dev("p9.excavator")                                        # back on its stand by the intake (the drive moved it), you in the cab
    here("16_operator_view", 0.4)
    aim, _ = aim_for(A, "scoop", yaws=[-1.57, -1.4, -1.75, -1.2])
    dump = None
    if aim:
        G(A, f"(a) => {GR}.excAim(a[0], a[1])", list(aim))
        G(A, f"() => {GR}.excPress('dig', 1.6)")
        e = G(A, f"() => {GR}.exc()")
        look("17_excavator_digging", {"x": e["x"] + 2.0, "y": 2.6, "z": e["z"] + 4.5, "tx": e["x"] + 1.0, "ty": 1.0, "tz": e["z"]})
        G(A, f"() => {GR}.excPress('none', 1.6)")
        e = G(A, f"() => {GR}.exc()")
        tw = G(A, f"() => {GR}.excTeeth()")
        look("18_full_bucket", {"x": tw["x"] + 1.4, "y": tw["y"] + 1.0, "z": tw["z"] + 1.9, "tx": tw["x"], "ty": tw["y"], "tz": tw["z"]})
        dump, _ = aim_for(A, "dump", "intake")                # (the dump target shows only with a loaded bucket)
        here("28_cab_loaded")
        if dump:
            G(A, f"(a) => {GR}.excAim(a[0], a[1])", list(dump))
            G(A, f"() => {GR}.excPress('dump', 1.5)")
            e = G(A, f"() => {GR}.exc()")
            look("19_excavator_dumping", {"x": e["x"] + 1.5, "y": 2.8, "z": e["z"] + 4.8, "tx": -14.0, "ty": 1.0, "tz": -9.6})
            G(A, f"() => {GR}.excPress('none', 2.0)")
        # a dozen more scoops at the same face (onto the spoil heap - the intake is full by now), then the face itself
        last = None
        for k in range(12):
            G(A, f"() => {GR}.excDumpForce('spoil')")
            aim, t = aim_for(A, "scoop", yaws=[-1.57, -1.4, -1.75, -1.2, -1.95])
            if not aim:
                break
            last = t["hit"]
            G(A, f"(a) => {GR}.excAim(a[0], a[1])", list(aim))
            G(A, f"() => {GR}.excNow('scoop')")
        G(A, f"() => {GR}.excDumpForce('spoil')")
        e = G(A, f"() => {GR}.exc()")
        if last:
            dx, dz = last["x"] - e["x"], last["z"] - e["z"]
            dl = math.hypot(dx, dz) or 1
            vx, vz = dx / dl, dz / dl
            # from the side of the cut, a little in front of it: the face, the excavator behind it
            look("20_excavated_face", {"x": last["x"] - vx * 0.8 - vz * 3.2, "y": last["y"] + 1.9, "z": last["z"] - vz * 0.8 + vx * 3.2, "tx": last["x"], "ty": last["y"] - 0.1, "tz": last["z"]})
    G(A, f"() => {GR}.excExit()")
    # the chain blocked: the bulk hopper full, the feeder stopped - the trommel waits, the belt stands loaded
    G(A, f"() => {GR}.procFeederMode('stop')")
    cap = G(A, f"() => {GR}.plant().bulk.cap")
    A.evaluate(BATCH, ["paydirt", cap, "devSetBulk"])
    A.evaluate(BATCH, ["paydirt", 200000, "devSetIntake"])
    frames(A, 45)                                              # the trommel's feed box (30 l) fills too: then the belt stands
    G(A, f"() => {GR}.pose({{ x: -15.05, z: -10.95, yaw: Math.PI, pitch: 0 }})")      # by the control post: its chip tells why
    look("21_chain_blocked", {"x": -13.2, "y": 3.4, "z": -4.2, "tx": -18.8, "ty": 2.0, "tz": -6.2})
    G(A, f"() => {GR}.procFeederMode('auto')")
    look("25_spoil_heap", {"x": -15.2, "y": 2.6, "z": -19.6, "tx": -18.5, "ty": 0.4, "tz": -15.5})
    look("23b_camp_after", CAMP)
    look("24c_mechanised_claim", {"x": 6.0, "y": 14.0, "z": 12.0, "tx": -10.0, "ty": 0.0, "tz": -6.0})


def main():
    out = None
    if "--shots" in sys.argv:
        out = Path(sys.argv[sys.argv.index("--shots") + 1])
        out.mkdir(parents=True, exist_ok=True)
    engine = sys.argv[sys.argv.index("--browser") + 1] if "--browser" in sys.argv else "chromium"
    want = lambda part: not ONLY or part in ONLY
    proc_, base, tmp = start_server()
    try:
        user = login(base, "Mechanized9")
        with sync_playwright() as p:
            launch = lambda: getattr(p, engine).launch(args=GPU_ARGS if engine == "chromium" else [])
            browser = launch()
            ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
            first, errs = True, []
            for part, fn in (("geology", geology), ("prospect", prospect), ("contract", contract), ("conveyor", conveyor), ("trommel", trommel),
                             ("excavator", excavator), ("chain", chain), ("save", save), ("dev", dev), ("handling", handling), ("perf", perf)):
                if not want(part) or (engine != "chromium" and part == "perf"):
                    continue
                if engine == "webkit" and not first:
                    errs += errors(A)
                    Q.close(A)
                    ctx.close()
                    browser.close()
                    browser = launch()
                    ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
                first = False
                try:
                    fn(A)
                except Exception as e:                           # a part that breaks must not hide the others
                    ok(f"{part}: ran without an exception", False, repr(e)[:300])
            if want("shots") and out and engine == "chromium":
                shots(A, out)
            errs += errors(A)
            ok(f"no page errors in the desktop parts ({engine})", not errs, str(errs[:3]))
            Q.close(A)
            ctx.close()
            if want("mobile") and engine == "chromium":
                mobile(browser, base, user, out if want("shots") else None)
            browser.close()
    finally:
        proc_.terminate()
    fails = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(fails)}/{len(RESULTS)} checks passed")
    for f in fails:
        print("FAILED:", f[0], f[2][:300])
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
