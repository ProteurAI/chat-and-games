"""GoldRush gold A/B benchmark (GoldRush 9.1): the ground's gold of two revisions on IDENTICAL seeds,
coordinates, depths and volumes - and the same simulated early game on both.

  geology   The game of this checkout builds the world for a seed; the MaterialField of the reference revision
            (goldrush-resources.js from `git show REF`, served through a Playwright route) is built on the SAME
            terrain object, so both read the very same columns / slices. Per zone 10-litre samples (2 x 2 columns
            x 16 slices): fine gold, discrete finds by class and value, the chance of a visible piece (flake,
            tiny piece, nugget), EUR per 10 l (all gold / what a raw pan brings back); streak / pocket cores and
            paleochannels by grade; the claim-wide budget (every 2nd column: the mountain above the contract
            floor, the flat to 1 m below - open ground / under the mountain -, the camp's apron apart).
            Zones: A starter face, B upper mountain (> 2 m), B2 lower flanks, C ordinary claim ground, D the
            camp's apron (geology 2's fill outline - the old ground zero), E any mountain column.
  early     One simulated player (a bench bot file, e.g. the reference revision's tests/e2e/goldrush_bench.js)
            plays a new mine (hand -> shovel -> bucket -> pan, strategy M) on a game root, polled every
            simulated minute: gold into the pouch, EUR, pieces by class, pans, buckets -> at 30 / 60 / 120 min
            EUR, gold, visible pieces, the longest stretch without one, gold per pan / bucket / active minute.
            --start x,z,yaw,pitch: another start (e.g. -11.2,4.6,0,-0.75: the ground next to the wash place).
  report    the summaries (geology: one file; early: two files, paired by seed).

    python tests/e2e/goldrush_gold_ab.py geology --ref 9aec716 --seeds 40 --out ab.json
    python tests/e2e/goldrush_gold_ab.py early --root <worktree of REF> --bot <its goldrush_bench.js> --seeds 40 --out eg_ref.json
    python tests/e2e/goldrush_gold_ab.py early --bot <the same bot file> --seeds 40 --out eg_now.json
    python tests/e2e/goldrush_gold_ab.py report ab.json      |   report eg_ref.json eg_now.json

(the reference game for `early`: git worktree add --detach <dir> 9aec716 - the server runs from a temp copy)
"""

import json
import os
import re
import statistics
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
import kopfkicker_e2e  # noqa: E402
from goldrush_e2e import GPU_ARGS, client, gr_close, gr_open, gr_ready  # noqa: E402
from goldrush_tools_e2e import open_game, seeded  # noqa: E402
from goldrush_mech_e2e import fresh  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parents[2]
ARG = lambda k, d: type(d)(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d


def module_at(rev):
    """goldrush-resources.js of a revision, its imports pointed at this server's (unchanged) modules"""
    src = subprocess.run(["git", "show", f"{rev}:static/games/goldrush/goldrush-resources.js"], cwd=ROOT, capture_output=True, text=True, encoding="utf-8").stdout
    assert "export class MaterialField" in src, f"no goldrush-resources.js at {rev}"
    return re.sub(r'from "\./(goldrush-[a-z0-9-]+\.js)"', r'from "/games/goldrush/\1"', src)


RUN = r"""async ({ seed, nSamples }) => {
  const P8 = await import('/ab/ref-resources.js');
  const PB = window.__abB ? await import('/ab/b-resources.js') : null;
  const t = window.__goldrush.terrain(), fB0 = t.field, vps = t.vps, cell = t.cell;
  const fA = new P8.MaterialField(seed, t, fB0.floorY);                      // PRE-P9 on the same terrain
  const fB = PB ? new PB.MaterialField(seed, t, fB0.floorY) : fB0;           // P9 (or a candidate)
  const VH = 0.01, ORIGIN = fB0.floorY, SLICE_L = cell * cell * VH * 1000, FLOOR = 0.06;
  // zones are decided once, geometrically, for both (P9's camp apron outline is the "old ground zero" area)
  const campW = (x, z) => (fB0.campFillAt ? fB0.campFillAt(x, z) : 0);
  const rng = (() => { let a = (seed * 2654435761) >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let q = a; q = Math.imul(q ^ (q >>> 15), q | 1); q ^= q + Math.imul(q ^ (q >>> 7), q | 61); return ((q ^ (q >>> 14)) >>> 0) / 4294967296; }; })();
  const zoneOf = (i, j) => {
    const k = j * vps + i, x = t.x0 + i * cell, z = t.z0 + j * cell, base = t.base[k];
    if (!t.inDigArea(x, z)) return null;
    if (fB0.starterWeight(x, base - 0.3, z, base) > 0.5) return "A_starter";
    if (campW(x, z) > 0.5 && base < 0.15) return "D_camp";
    if (base > 2.0) return "B_upper";
    if (base > 0.4) return "B2_lower";
    if (base < 0.12) return "C_claim";
    return null;
  };
  const vA = {}, vB = {};
  // one 10-l sample: columns (i..i+1, j..j+1), 16 slices from slice top-d0 down; -> per field
  const sample = (f, i, j, d0) => {
    const r = { fine: 0, finds: 0, findUg: 0, trace: 0, fineCls: 0, flake: 0, tiny: 0, nugget: 0, visible: 0, slices: 0, ch: 0 };
    for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
      const ii = i + di, jj = j + dj, k = jj * vps + ii, top = Math.ceil((t.base[k] - ORIGIN) / VH - 0.5) - 1;
      for (let s = 0; s < 16; s++) {
        const iy = top - d0 - s;
        const v = f.voxel(ii, jj, iy, f === fA ? vA : vB);
        r.slices++;
        if (v.mat === 3) continue;
        r.fine += v.fineUg;
        if (v.cls) {
          r.finds++; r.findUg += v.massUg;
          if (v.cls === 1) r.trace++; else if (v.cls === 2) r.fineCls++; else if (v.cls === 3) r.flake++; else if (v.cls === 4) r.tiny++; else r.nugget++;
          if (v.cls >= 3) r.visible++;
        }
      }
    }
    return r;
  };
  const out = { zones: {}, channel: { A: [], B: [] }, budget: null };
  // candidates per zone (every column whose 2x2 block lies in one zone)
  const cand = {};
  for (let j = 2; j < vps - 3; j += 2) for (let i = 2; i < vps - 3; i += 2) {
    const z = zoneOf(i, j);
    if (!z || zoneOf(i + 1, j + 1) !== z) continue;
    (cand[z] = cand[z] || []).push([i, j]);
    const k = j * vps + i;
    if (t.base[k] > 0.4) (cand.E_random = cand.E_random || []).push([i, j]);   // any mountain column (incl. starter)
  }
  for (const [z, list] of Object.entries(cand)) {
    const rows = [];
    for (let n = 0; n < nSamples && list.length; n++) {
      const [i, j] = list[Math.floor(rng() * list.length)];
      const k = j * vps + i, base = t.base[k];
      // depth: the mountain from its surface into its body (above the floor); flat ground the top metre
      const maxD = z === "C_claim" || z === "D_camp" ? 84 : Math.max(0, Math.floor((base - FLOOR) / VH) - 16);
      const d0 = Math.floor(rng() * (maxD + 1));
      rows.push({ A: sample(fA, i, j, d0), B: sample(fB, i, j, d0), d0, base: +base.toFixed(2) });
    }
    out.zones[z] = rows;
  }
  // streak cores / pocket cores (both versions have them, same places): 10-l samples there
  out.streak = { A: [], B: [] }; out.pocket = { A: [], B: [] };
  for (const [name, fn] of [["streak", (x, y, z) => fB.streakAt(x, y, z) > 0.3], ["pocket", (x, y, z) => (fB.pocketAt ? fB.pocketAt(x, y, z) > 0.3 : false)]]) {
    let n = 0;
    for (let tries = 0; tries < 40000 && n < nSamples; tries++) {
      const i = 2 + Math.floor(rng() * (vps - 5)), j = 2 + Math.floor(rng() * (vps - 5)), k = j * vps + i, x = t.x0 + i * cell, z = t.z0 + j * cell;
      if (!t.inDigArea(x, z)) continue;
      const top = Math.ceil((t.base[k] - ORIGIN) / VH - 0.5) - 1, d0 = Math.floor(rng() * Math.max(1, (t.base[k] + 0.5) / VH));
      const y = ORIGIN + (top - d0 - 8 + 0.5) * VH;
      if (!fn(x, y, z)) continue;
      out[name].A.push(sample(fA, i, j, d0)); out[name].B.push(sample(fB, i, j, d0)); n++;
    }
  }
  // paleochannel bodies (P9 only): samples centred in channel gravel, the same voxels under PRE-P9
  if (fB.channels) {
    const chs = [];
    for (let j = 2; j < vps - 3; j += 3) for (let i = 2; i < vps - 3; i += 3) {
      const k = j * vps + i, x = t.x0 + i * cell, z = t.z0 + j * cell;
      if (!t.inDigArea(x, z) || fB.chIdx[k] < 0 || fB.chD[k] > 0.5) continue;
      chs.push([i, j]);
    }
    for (let n = 0; n < nSamples && chs.length; n++) {
      const [i, j] = chs[Math.floor(rng() * chs.length)], k = j * vps + i, x = t.x0 + i * cell, z = t.z0 + j * cell;
      const ch = fB.channels[fB.chIdx[k]], top = Math.ceil((t.base[k] - ORIGIN) / VH - 0.5) - 1;
      // the slice at the channel's bed centre
      const yb = ch.bed + ch.tilt * (fB.chT[k] - 0.5);
      const d0 = Math.max(0, Math.round((t.base[k] - yb) / VH) - 8);
      const at = fB.channelAt(x, yb, z, k);
      out.channel.A.push(sample(fA, i, j, d0)); out.channel.B.push(Object.assign(sample(fB, i, j, d0), { rich: at ? +at.rich.toFixed(2) : null }));
    }
  }
  // the claim-wide budget: every 2nd column of the dig area; the mountain above the contract floor, the
  // claim ground to 1 m below its original surface; camp apron separately (it is meant to be poor)
  const bud = { A: { all: 0, mount: 0, flat: 0, open: 0, under: 0, camp: 0, visA: 0 }, B: { all: 0, mount: 0, flat: 0, open: 0, under: 0, camp: 0, visA: 0 }, l: { all: 0, mount: 0, flat: 0, open: 0, under: 0, camp: 0 } };
  for (let j = 1; j < vps - 1; j += 2) for (let i = 1; i < vps - 1; i += 2) {
    const k = j * vps + i, x = t.x0 + i * cell, z = t.z0 + j * cell, base = t.base[k];
    if (!t.inDigArea(x, z)) continue;
    const isCamp = campW(x, z) > 0.5 && base < 0.15;
    const top = Math.ceil((base - ORIGIN) / VH - 0.5) - 1;
    const bottom = Math.min(top - 100, Math.floor((FLOOR - ORIGIN) / VH) - 100);     // 1 m under the flat
    for (let iy = top; iy > bottom; iy--) {
      const y = ORIGIN + (iy + 0.5) * VH, part = isCamp ? "camp" : y > FLOOR ? "mount" : "flat", sub = part === "flat" ? (base < 0.4 ? "open" : "under") : null;
      for (const [key, f, v] of [["A", fA, vA], ["B", fB, vB]]) {
        const r = f.voxel(i, j, iy, v);
        if (r.mat === 3) continue;
        const ug = r.fineUg + (r.cls ? r.massUg : 0);
        bud[key][part] += ug;
        if (sub) bud[key][sub] += ug;
        if (!isCamp) bud[key].all += ug;
        if (r.cls >= 3 && !isCamp) bud[key].visA += 1;
      }
      bud.l[part] += SLICE_L * 4;              // every 2nd column in both directions
      if (sub) bud.l[sub] += SLICE_L * 4;
      if (!isCamp) bud.l.all += SLICE_L * 4;
    }
  }
  for (const key of ["A", "B"]) for (const p of ["all", "mount", "flat", "open", "under", "camp"]) bud[key][p] *= 4;
  bud.A.visA *= 4; bud.B.visA *= 4;
  out.budget = bud;
  out.sliceL = SLICE_L;
  return out;
}"""


def geology():
    seeds, first, out, ref, samples = ARG("--seeds", 40), ARG("--first", 1), ARG("--out", "ab.json"), ARG("--ref", "9aec716"), ARG("--samples", 40)
    refsrc = module_at(ref)
    proc, base, tmp = kopfkicker_e2e.start_server()
    rows = []
    try:
        user = kopfkicker_e2e.login(base, "GoldAb")
        with sync_playwright() as p:
            b = p.chromium.launch(args=GPU_ARGS)
            ctx, A = client(b, base, user, dict(viewport={"width": 800, "height": 500}), extra_init=[seeded()])
            A.route("**/ab/ref-resources.js", lambda r: r.fulfill(status=200, body=refsrc, content_type="text/javascript"))
            open_game(A)
            for seed in range(first, first + seeds):
                fresh(A, seed)
                t0 = time.time()
                r = A.evaluate(RUN, {"seed": seed, "nSamples": samples})
                r["seed"] = seed
                rows.append(r)
                bA, bB = r["budget"]["A"], r["budget"]["B"]
                print(f"seed {seed} ({time.time() - t0:.1f} s): budget now/ref all {bB['all'] / max(1, bA['all']):.2f} mountain {bB['mount'] / max(1, bA['mount']):.2f} camp {bB['camp'] / max(1, bA['camp']):.2f}", flush=True)
                json.dump(rows, open(out, "w"))
            b.close()
    finally:
        proc.terminate()


def report_geology(rows):

    E = 10000.0                     # ug per EUR (100 ug = 1 ct)
    PAN = 0.58                      # raw pan: fine gold share it brings back (pieces whole)
    def agg(samples):
        n = len(samples) or 1
        s = {k: sum(x[k] for x in samples) / n for k in ("fine", "finds", "findUg", "trace", "fineCls", "flake", "tiny", "nugget", "visible")}
        s["total"] = s["fine"] + s["findUg"]
        s["pan"] = s["fine"] * PAN + s["findUg"]
        s["pVis"] = sum(1 for x in samples if x["visible"] > 0) / n
        s["pAny"] = sum(1 for x in samples if x["finds"] > 0) / n
        s["n"] = len(samples)
        return s
    zones = sorted({z for r in rows for z in r["zones"]})
    print(f"{len(rows)} seeds")
    hdr = f"{'zone':10s} {'n':>5s} | {'fine mg A':>9s} {'B':>6s} | {'finds A':>7s} {'B':>5s} | {'vis A':>5s} {'B':>5s} | {'pVis A':>6s} {'B':>5s} | {'EUR tot A':>9s} {'B':>5s} {'B/A':>5s} | {'EUR pan A':>9s} {'B':>5s} | nug/1000l A B"
    print(hdr)
    out = {}
    for z in zones:
        A = agg([s["A"] for r in rows for s in r["zones"].get(z, [])])
        B = agg([s["B"] for r in rows for s in r["zones"].get(z, [])])
        out[z] = {"A": A, "B": B}
        print(f"{z:10s} {A['n']:5d} | {A['fine']/1000:9.2f} {B['fine']/1000:6.2f} | {A['finds']:7.2f} {B['finds']:5.2f} | {A['visible']:5.2f} {B['visible']:5.2f} | {A['pVis']:6.2f} {B['pVis']:5.2f} | "
              f"{A['total']/E:9.3f} {B['total']/E:5.3f} {B['total']/max(1,A['total']):5.2f} | {A['pan']/E:9.3f} {B['pan']/E:5.3f} | {A['nugget']*100:.2f} {B['nugget']*100:.2f}")
    for nm in ("streak", "pocket"):
        if all(nm in r for r in rows):
            sA = agg([s for r in rows for s in r[nm]["A"]]); sB = agg([s for r in rows for s in r[nm]["B"]])
            print(f"{nm:10s} {sA['n']:5d} | {sA['fine']/1000:9.2f} {sB['fine']/1000:6.2f} | {sA['finds']:7.2f} {sB['finds']:5.2f} | {sA['visible']:5.2f} {sB['visible']:5.2f} | {sA['pVis']:6.2f} {sB['pVis']:5.2f} | {sA['total']/E:9.3f} {sB['total']/E:5.3f} {sB['total']/max(1,sA['total']):5.2f}")
    chs = [s for r in rows for s in r["channel"]["B"]]
    for lab, lo, hi in (("ch poor", -1, 0.35), ("ch mid", 0.35, 0.6), ("ch rich", 0.6, 9)):
        S = [s for s in chs if s.get("rich") is not None and lo < s["rich"] <= hi]
        if S: a = agg(S); print(f"{lab:10s} {a['n']:5d} |        P9 {a['fine']/1000:6.2f} | finds {a['finds']:5.2f} vis {a['visible']:5.2f} pVis {a['pVis']:5.2f} | EUR {a['total']/E:6.3f}")
    chA = agg([s for r in rows for s in r["channel"]["A"]]); chB = agg([s for r in rows for s in r["channel"]["B"]])
    print(f"{'channel':10s} {chA['n']:5d} | {chA['fine']/1000:9.2f} {chB['fine']/1000:6.2f} | {chA['finds']:7.2f} {chB['finds']:5.2f} | {chA['visible']:5.2f} {chB['visible']:5.2f} | {chA['pVis']:6.2f} {chB['pVis']:5.2f} | {chA['total']/E:9.3f} {chB['total']/E:5.3f} {chB['total']/max(1,chA['total']):5.2f}")
    PARTS = [p for p in ("all", "mount", "flat", "open", "under", "camp") if p in rows[0]["budget"]["l"]]
    b = {k: {p: sum(r["budget"][k][p] for r in rows) for p in PARTS + ["visA"]} for k in ("A", "B")}
    L = {p: sum(r["budget"]["l"][p] for r in rows) for p in PARTS}
    if "open" in PARTS:
        for k in ("A", "B"): b[k]["reach"] = b[k]["mount"] + b[k]["open"]
        L["reach"] = L["mount"] + L["open"]; PARTS.append("reach")
    print("\nclaim-wide budget (sum over seeds):  EUR per m3          B/A")
    for p in PARTS:
        print(f"  {p:6s} A {b['A'][p] / E / (L[p] / 1000):7.2f}  B {b['B'][p] / E / (L[p] / 1000):7.2f}   {b['B'][p] / b['A'][p]:5.2f}   ({L[p] / 1000 / len(rows):.0f} m3 / seed)")
    print(f"  visible pieces (flake+) excl. camp: A {b['A']['visA'] / len(rows):.0f}  B {b['B']['visA'] / len(rows):.0f} per seed  B/A {b['B']['visA'] / b['A']['visA']:.2f}")


POLL = r"""() => { const G = window.__goldrush, e = G.economy(), p = G.proc(), L = p.ledger, B = window.__grBench;
  const pc = {}; for (const [k, v] of Object.entries(e.pouch || {})) pc[k] = v.count;
  return { t: B.t, cash: e.cashCents, earned: e.earnedCents, pouchCents: e.pouchCents, pouch: pc,
    goldFoundUg: e.stats.goldFoundUg, discovered: e.stats.discovered, volumeMl: e.stats.volumeMl, washedUg: e.stats.washedUg || 0,
    recoveredUg: L.recoveredUg, inUg: L.inUg, panLoads: L.panLoads, buckets: L.buckets, pans: B.pans || 0, owned: G.tools().owned.concat(p.owned || []) }; }"""


def early():
    root, botf, strat, minutes, seeds, first, out, start = ARG("--root", str(ROOT)), ARG("--bot", str(ROOT / "tests" / "e2e" / "goldrush_bench.js")), ARG("--strategy", "M"), ARG("--minutes", 120), ARG("--seeds", 40), ARG("--first", 1), ARG("--out", "eg.json"), ARG("--start", "")
    kopfkicker_e2e.ROOT = Path(root)
    bot = open(botf, encoding="utf-8").read()
    if start:
        x, z, yaw, pitch = [float(v) for v in start.split(",")]
        anchor = "this.x = 0.6; this.z = 10.2; this.yaw = 0; this.pitch = 0;"
        assert anchor in bot, "this bot has no start position to replace"
        bot = bot.replace(anchor, f"this.x = {x}; this.z = {z}; this.yaw = {yaw}; this.pitch = {pitch};")
        bot = re.sub(r"const MOUND = \{ x: [-0-9.]+, z: [-0-9.]+ \};", f"const MOUND = {{ x: {x}, z: {z - 1.2} }};", bot)     # it keeps working there
    proc, base, tmp = kopfkicker_e2e.start_server()
    rows = []
    try:
        user = kopfkicker_e2e.login(base, "GoldAbEarly")
        with sync_playwright() as p:
            b = p.chromium.launch(args=GPU_ARGS)
            ctx, A = client(b, base, user, dict(viewport={"width": 800, "height": 500}), extra_init=[seeded()])
            for seed in range(first, first + seeds):
                t0 = time.time()
                A.evaluate("(s) => { localStorage.removeItem(grKey()); localStorage.removeItem(grKey('.backup')); localStorage.setItem('goldrush.testSeed', String(s)); }", seed)
                gr_open(A)
                gr_ready(A)
                A.evaluate("() => window.__goldrush.setPaused(true)")
                A.add_script_tag(content=bot)
                A.evaluate("([s, st]) => window.__grBench.init(s, { tool: 'hand', strategy: st })", [seed, strat])
                series = []
                for m in range(1, minutes + 1):
                    A.evaluate("(u) => window.__grBench.run(u)", m * 60)
                    s = A.evaluate(POLL)
                    s["m"] = m
                    series.append(s)
                rows.append({"seed": seed, "series": series})
                last = series[-1]
                print(f"seed {seed} ({time.time() - t0:.0f} s): EUR {(last['earned'] + last['pouchCents']) / 100:.2f} gold {last['goldFoundUg'] / 1000:.0f} mg pans {last['panLoads']} buckets {last['buckets']}", flush=True)
                json.dump(rows, open(out, "w"))
                A.evaluate("() => { localStorage.removeItem(grKey()); }")
                gr_close(A)
            b.close()
    finally:
        proc.terminate()


VIS = ("goldFlake", "tinyGoldPiece", "smallNugget")
ANY = ("traceGold", "fineGold") + VIS


def events(series):
    """per minute: new pieces by class (pouch counts only drop at a sale)"""
    prev = {}
    out = []
    for s in series:
        cur = s["pouch"]
        new = {}
        for c in ANY:
            a, b = prev.get(c, 0), cur.get(c, 0)
            new[c] = b - a if b >= a else b
        prev = cur
        out.append(new)
    return out


def at(series, m):
    return next(s for s in series if s["m"] == m)


def metrics(row, m):
    S = [s for s in row["series"] if s["m"] <= m]
    ev = events(row["series"])[:m]
    last = S[-1]
    vis = sum(sum(e[c] for c in VIS) for e in ev)
    anyp = sum(sum(e[c] for c in ANY) for e in ev)
    # longest stretch (minutes) without a visible piece / without any piece reaching the pouch
    def gap(keys):
        best = cur = 0
        for e in ev:
            if sum(e[c] for c in keys) > 0:
                cur = 0
            else:
                cur += 1
                best = max(best, cur)
        return best
    pans = last["panLoads"] or 0
    bk = last["buckets"] or 0
    return {
        "eur": (last["earned"] + last["pouchCents"]) / 100,
        "goldMg": last["goldFoundUg"] / 1000,
        "vis": vis, "any": anyp, "gapVis": gap(VIS), "gapAny": gap(ANY),
        "perPanMg": (last["recoveredUg"] / pans / 1000) if pans else None,
        "perBucketMg": (last["recoveredUg"] / bk / 1000) if bk else None,
        "perMinCt": (last["earned"] + last["pouchCents"]) / m,
        "litres": last["volumeMl"] / 1000,
        "eurPer10l": ((last["goldFoundUg"]) / 10000) / max(0.001, last["volumeMl"] / 10000),
    }


def med(v):
    v = [x for x in v if x is not None]
    return statistics.median(v) if v else float("nan")


def p(v, q):
    v = sorted(x for x in v if x is not None)
    return v[min(len(v) - 1, int(q * (len(v) - 1)))] if v else float("nan")


def report_early(A, B, la="ref", lb="now"):
    seeds = sorted(set(r["seed"] for r in A) & set(r["seed"] for r in B))
    ia, ib = {r["seed"]: r for r in A}, {r["seed"]: r for r in B}
    print(f"{len(seeds)} paired seeds")
    for m in (30, 60, 120):
        MA = [metrics(ia[s], m) for s in seeds]
        MB = [metrics(ib[s], m) for s in seeds]
        print(f"\n== {m} min (median, P10-P90) ==")
        for k, lab, fmt in (("eur", "EUR (earned + pouch)", "{:.2f}"), ("goldMg", "gold into pouch, mg", "{:.0f}"), ("litres", "litres dug", "{:.0f}"),
                            ("eurPer10l", "gold EUR per 10 l dug", "{:.2f}"), ("vis", "visible pieces (flake+)", "{:.0f}"), ("any", "any pieces", "{:.0f}"),
                            ("gapVis", "longest min w/o visible piece", "{:.0f}"), ("gapAny", "longest min w/o any piece", "{:.0f}"),
                            ("perPanMg", "recovered mg per pan", "{:.2f}"), ("perBucketMg", "recovered mg per bucket", "{:.2f}"), ("perMinCt", "ct per active minute", "{:.1f}")):
            a, b = [x[k] for x in MA], [x[k] for x in MB]
            ratio = [y / x for x, y in zip(a, b) if x and y is not None and x is not None]
            print(f"  {lab:32s} {la} {fmt.format(med(a)):>8s} ({fmt.format(p(a, .1))}-{fmt.format(p(a, .9))})   {lb} {fmt.format(med(b)):>8s} ({fmt.format(p(b, .1))}-{fmt.format(p(b, .9))})"
                  + (f"   paired {lb}/{la} {med(ratio):.2f}" if ratio else ""))


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "geology":
        geology()
    elif mode == "early":
        early()
    elif mode == "report":
        files = [a for a in sys.argv[2:] if a.endswith(".json")]
        if len(files) == 1:
            report_geology(json.load(open(files[0])))
        else:
            report_early(json.load(open(files[0])), json.load(open(files[1])), *(sys.argv[4:6] if len(sys.argv) > 5 else ("ref", "now")))
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
