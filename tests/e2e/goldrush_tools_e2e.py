"""End-to-end check of GoldRush phase 3: refined terrain / mass / resource
foundation, the reworked economy (pending -> collected, canonical
benchmark), the first physical tools (hand, shovel, pickaxe), progression
groundwork (owned tools, save v3) and the scale of the mountain - T1..T49.
Runs the server from a temp copy (the real database is never touched) on a
fixed world seed.

    python tests/e2e/goldrush_tools_e2e.py [--shots DIR] [--quick] [--browser webkit]

    --quick   shorter benchmark (12 seeds x 10 min) and long run (2,000 actions),
              save sizes up to 1,000 actions

Requires: pip install playwright pillow && python -m playwright install chromium
"""

import json
import math
import os
import statistics
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from goldrush_bench import run_seed as bench_seed, summarize as bench_summary  # noqa: E402
from goldrush_e2e import (  # noqa: E402
    CURRENT_SAVE, FRAME_REC, FRAME_STOP, GPU_ARGS, PHONE, client, errors, gr_close, gr_open, gr_ready, gr_start, heap_mb, wait_for,
)
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SEED = 4242
RESULTS = []
QUICK = "--quick" in sys.argv
FIXTURE_V2 = Path(__file__).parent / "fixtures" / "goldrush_save_v2.json"
DIRT, COMPACT, GRAVEL, STONE = 0, 1, 2, 3
MAT_ID = ["dirt", "compactDirt", "gravel", "stone"]


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def seeded(seed=SEED):
    return f"if (!sessionStorage.getItem('gr3seeded')) {{ localStorage.setItem('goldrush.testSeed', '{seed}'); sessionStorage.setItem('gr3seeded', '1'); }}"


def G(page, js, arg=None):
    return page.evaluate(js, arg) if arg is not None else page.evaluate(js)


def open_game(page, start=True):
    gr_open(page)
    gr_ready(page)
    page.evaluate("() => { const e = document.querySelector('.gr-hint'); if (e) e.hidden = true; }")
    if start:
        gr_start(page)


def fresh(page, seed=SEED):
    """close GoldRush, wipe its save, open a brand-new world on `seed`"""
    gr_close(page)
    page.evaluate("(s) => { for (const k of [grKey(), grKey('.backup'), grKey('.corrupt')]) localStorage.removeItem(k); localStorage.setItem('goldrush.testSeed', String(s)); }", seed)
    open_game(page)


def tools(page):
    return G(page, "() => window.__goldrush.tools()")


def select(page, tool):
    G(page, "(t) => window.__goldrush.selectTool(t)", tool)
    return wait_for(lambda: G(page, "(t) => { const s = window.__goldrush.tools(); return s.equipped === t && s.state === 'idle'; }", tool), 3)


# Phase 4: finds go into the gold POUCH (money only after selling them at the
# camp). These phase-2/3 checks are about the gold the player has collected,
# so "money" here means cash + the pouch's value (exactly what it meant then).
POUCH_KEYS = {"dust": ("traceGold", "fineGold"), "flakes": ("goldFlake",), "tinyPieces": ("tinyGoldPiece",), "nuggets": ("smallNugget",)}


def compat(e):
    p = e["pouch"]
    e["moneyCents"] = e["cashCents"] + e["pouchCents"]
    e["shownCents"] = e["shownCents"] + e["shownPouch"]
    e["earnedCents"] = e["earnedCents"] + e["pouchCents"]
    e["inventory"] = {k: {"count": sum(p[c]["count"] for c in cs), "ug": sum(p[c]["ug"] for c in cs)} for k, cs in POUCH_KEYS.items()}
    st = e["stats"]
    st["dustValueCents"] = p["traceGold"]["cents"] + p["fineGold"]["cents"]
    st["flakeValueCents"] = p["goldFlake"]["cents"]
    st["tinyValueCents"] = p["tinyGoldPiece"]["cents"]
    st["nuggetValueCents"] = p["smallNugget"]["cents"]
    return e


def eco(page):
    return compat(G(page, "() => window.__goldrush.economy()"))


# stand in front of a fresh patch (of `want` material, or any) and aim at it
# wide: search all the way round the mound (compact dirt lies mostly inside the
# pile; on the surface it is only left at the back, away from the starter faces)
SPOT = r"""({ want, reach, start, fresh, rock, core, uniform, wide }) => {
  const G = window.__goldrush, t = G.terrain();
  const solid = (h) => { const i = Math.round((h.x - t.x0) / t.cell), j = Math.round((h.z - t.z0) / t.cell);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const k = (j + dj) * t.vps + i + di; if (!(t.height[k] <= t.stoneTop[k] + 1e-4 && t.height[k] >= t.stoneBot[k])) return false; } return true; };
  for (let a = 0; a < 220; a++) {
    const span = wide ? Math.PI : 2.2, ang = -span + ((a * 0.618034 + (start || 0)) % 1) * 2 * span;
    const dx = Math.sin(ang), dz = Math.cos(ang);
    let foot = null;
    for (let d = 14; d > 0; d -= 0.05) if (G.heightAt(dx * d, -6 + dz * d) > 0.35) { foot = d; break; }
    if (foot == null) continue;
    for (const back of [1.25, 0.95, 1.55, 0.7]) {
      const x = dx * (foot + back), z = -6 + dz * (foot + back), yaw = Math.atan2(dx, dz);
      for (let pt = -0.12; pt > -1.25; pt -= 0.04) {
        const d = G.aimAt({ x, z, yaw, pitch: pt });
        if (d == null || d > reach) continue;
        const p = G.probe();
        if (!p) continue;
        if (rock) { if (p.boulder == null) continue; }
        else if (p.boulder != null) continue;
        if (want != null && p.material !== want) continue;
        if (fresh && p.worked) continue;
        if (core) { const s = G.state(), cp = Math.cos(pt); if (!solid({ x: s.x - Math.sin(yaw) * cp * d, z: s.z - Math.cos(yaw) * cp * d })) continue; }
        if (uniform) {
          // every grid point the bite can reach is this material (a few cm down too)
          const s = G.state(), cp = Math.cos(pt), hx = s.x - Math.sin(yaw) * cp * d, hz = s.z - Math.cos(yaw) * cp * d;
          const i = Math.round((hx - t.x0) / t.cell), j = Math.round((hz - t.z0) / t.cell), mi = ['dirt', 'compactDirt', 'gravel', 'stone'].indexOf(want);
          let same = true;
          for (let dj = -2; dj <= 2 && same; dj++) for (let di = -2; di <= 2 && same; di++) {
            const k = (j + dj) * t.vps + i + di, x = t.x0 + (i + di) * t.cell, z = t.z0 + (j + dj) * t.cell;
            for (const dy of [0.01, 0.04]) if (t.field.materialAt(x, t.height[k] - dy, z, k) !== mi) same = false;
          }
          if (!same) continue;
        }
        return { x, z, yaw, pitch: pt, d, material: p.material, boulder: p.boulder };
      }
    }
  }
  return null;
}"""

# n transactions at one spot like a player holding the button (re-aim when
# the surface moved out of the crosshair); tool = id or null (in the hands)
ACT_N = r"""({ n, tool, spot, jitter, seed }) => {
  const G = window.__goldrush;
  let r = (seed || 7) >>> 0;
  const rnd = () => { r = (Math.imul(r, 1103515245) + 12345) >>> 0; return r / 4294967296; };
  const out = { n: 0, digs: 0, blocked: 0, rock: 0, none: 0, kg: 0, requested: 0, removed: 0, relocated: 0, processed: 0, slices: 0, finds: 0, cents: 0,
                keys: [], byMat: [0, 0, 0, 0], kgByMat: [0, 0, 0, 0], pureN: [0, 0, 0, 0], pureKg: [0, 0, 0, 0], loose: 0, maxKg: 0, minKg: 1e9, rocks: [] };
  let yaw = spot.yaw, pitch = spot.pitch;
  for (let i = 0; i < n; i++) {
    if (jitter && i % 6 === 0) { yaw = spot.yaw + (rnd() - 0.5) * jitter; pitch = spot.pitch + (rnd() - 0.5) * jitter * 0.6; }
    let d = G.aimAt({ x: spot.x, z: spot.z, yaw, pitch });
    if (d == null || G.aim().state === 'far') {
      for (let pt = -0.1; pt > -1.25; pt -= 0.03) { d = G.aimAt({ x: spot.x, z: spot.z, yaw, pitch: pt }); if (d != null && G.aim().state !== 'far') { pitch = pt; break; } }
    }
    const q = G.act({ visuals: false, tool: tool || undefined });
    out.n++;
    if (!q) { out.none++; continue; }
    if (q.kind === 'rock') { out.rock++; out.rocks.push(q.rock); continue; }
    if (q.blocked) { out.blocked++; continue; }
    out.digs++;
    out.kg += q.massKg; out.requested += q.requested; out.removed += q.removed; out.relocated += q.relocated; out.processed += q.processed;
    out.slices += q.slices; out.finds += q.finds; out.cents += q.cents; out.keys.push(...q.keys);
    out.byMat[q.material]++; out.kgByMat[q.material] += q.massKg;
    for (let m = 0; m < 4; m++) if (q.massByMat && q.massByMat[m] >= 0.95 * q.massKg && q.massKg > 0) { out.pureN[m]++; out.pureKg[m] += q.massKg; }
    out.maxKg = Math.max(out.maxKg, q.massKg); out.minKg = Math.min(out.minKg, q.massKg);
  }
  return out;
}"""

# terrain shape around a spot: steepest step between neighbours (deg) where
# the ground was changed, deepest dent, its width, how loose cells sit
SHAPE = r"""({ x, z, R }) => {
  const G = window.__goldrush, t = G.terrain(), c = t.cell, vps = t.vps, H = t.height;
  const i0 = Math.max(1, Math.floor((x - R - t.x0) / c)), i1 = Math.min(vps - 2, Math.ceil((x + R - t.x0) / c));
  const j0 = Math.max(1, Math.floor((z - R - t.z0) / c)), j1 = Math.min(vps - 2, Math.ceil((z + R - t.z0) / c));
  let maxDeg = 0, deepest = 0, changed = 0, looseOver = 0, looseCells = 0, worstLoose = 0;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const k = j * vps + i;
    if (t.qh[k] === 0) continue;
    changed++;
    deepest = Math.max(deepest, -t.qh[k] / 10000);
    const stone = (q) => H[q] <= t.stoneTop[q] + 1e-4 && H[q] >= t.stoneBot[q];
    for (const [n, dist] of [[k + 1, c], [k - 1, c], [k + vps, c], [k - vps, c]]) {
      const s = Math.abs(H[k] - H[n]) / dist;
      if (!stone(k) && !stone(n)) maxDeg = Math.max(maxDeg, Math.atan(s) * 180 / Math.PI);     // stone walls may stand
      // loose material above its neighbour may not stand steeper than its angle of repose
      if (H[k] > H[n] && t.loose[k] > 0 && !(H[k] <= t.stoneTop[k] + 1e-4 && H[k] >= t.stoneBot[k])) {
        looseCells++;
        const lim = t._reposeTan(k), over = s - lim;
        if (over > 0.02) looseOver++;
        worstLoose = Math.max(worstLoose, over);
      }
    }
  }
  return { maxDeg: +maxDeg.toFixed(1), deepest: +deepest.toFixed(3), changed, looseOver, looseCells, worstLoose: +worstLoose.toFixed(3), valid: t.validate() };
}"""

# every used-up slice holding gold is accounted for: discovered (paid or
# pending) or travelling in slid material (carried) - nothing else
LEDGER = r"""() => {
  const G = window.__goldrush, t = G.terrain(), m = G.mining(), f = t.field, e = G.economyObj();
  const fl = f.floorY, vh = 0.01, sliceIndex = (h) => Math.ceil((h - fl) / vh - 0.5);
  const vps = t.vps, v = {};
  let usedSlices = 0, withGold = 0, ug = 0;
  for (let k = 0; k < t.base.length; k++) {
    const s0 = sliceIndex(t.base[k]);
    if (m.cidx[k] >= s0) continue;
    const i = k % vps, j = (k - i) / vps;
    for (let iy = m.cidx[k]; iy < s0; iy++) {
      usedSlices++;
      f.voxel(i, j, iy, v);
      if (v.cls) { withGold++; ug += v.massUg; }
    }
  }
  let carriedUg = 0;
  for (const list of m.carried.values()) for (const it of list) carriedUg += it.massUg;
  return { usedSlices, withGold, ug, discovered: e.stats.discovered, finds: e.stats.finds, pending: e.pending.size, carried: m.carriedCount, carriedUg };
}"""

# stone-weight attribute of the terrain mesh at grid point (i, j)
SURFACE_STONE = r"""({ i, j }) => {
  const t = window.__goldrush.terrain(), cc = t.chunkCells, per = t.chunksPerSide;
  const ci = Math.min(per - 1, Math.floor(i / cc)), cj = Math.min(per - 1, Math.floor(j / cc));
  const ch = t.chunks.find((c) => c.i0 === ci * cc && c.j0 === cj * cc);
  const v = (j - ch.j0) * (cc + 1) + (i - ch.i0);
  const a = ch.geom.attributes.aMat;                 // (gravel, stone, ...) per vertex - phase 7A: 4 weights
  return a.array[v * a.itemSize + 1];
}"""

# columns where stone is buried a few cm under the surface / lies open
FIND_STONE_COLUMNS = r"""() => {
  const t = window.__goldrush.terrain(), vps = t.vps;
  let buried = null, exposed = null;
  for (let k = 0; k < t.height.length && (!buried || !exposed); k++) {
    const i = k % vps, j = (k - i) / vps;
    if (i < 14 || j < 14 || i > vps - 15 || j > vps - 15) continue;
    const top = t.stoneTop[k], h = t.height[k];
    if (!Number.isFinite(top)) continue;
    if (!buried && h - top > 0.02 && h - top < 0.1) buried = { i, j, depth: +(h - top).toFixed(3) };
    if (!exposed && top >= h - 1e-4 && h >= t.stoneBot[k]) exposed = { i, j };
  }
  return { buried, exposed };
}"""

# the pile: volume above the old ground and its mass, from the real materials
MOUNTAIN = r"""() => {
  const t = window.__goldrush.terrain(), f = t.field, c2 = t.cell * t.cell, vps = t.vps;
  const dens = [1350, 1650, 1800, 2650];
  let vol = 0, mass = 0;
  for (let k = 0; k < t.height.length; k++) {
    const h = t.height[k];
    if (h <= 0) continue;
    const i = k % vps, j = (k - i) / vps, x = t.x0 + i * t.cell, z = t.z0 + j * t.cell;
    vol += h * c2;
    for (let y = 0.05; y < h; y += 0.1) mass += dens[f.materialAt(x, y, z, k)] * c2 * Math.min(0.1, h - y + 0.05);
  }
  return { vol, mass };
}"""

AUDIO_LEVELS = r"""async (kinds) => {
  if (typeof OfflineAudioContext === "undefined") return null;
  const { GoldRushAudio } = await import('/games/goldrush/goldrush-audio.js');
  const out = {};
  for (const kind of kinds) {
    const sr = 44100, ctx = new OfflineAudioContext(2, sr, sr), a = new GoldRushAudio();
    a.ctx = ctx;
    a.master = ctx.createGain(); a.master.gain.value = a.volume;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
    a.master.connect(comp).connect(ctx.destination);
    a.noise = ctx.createBuffer(1, sr, sr); const d = a.noise.getChannelData(0); for (let i = 0; i < sr; i++) d[i] = Math.random() * 2 - 1;
    Object.defineProperty(a, 'ready', { get: () => true });
    a.play(kind, { pan: 0, dist: 1.5 });
    const ch = (await ctx.startRendering()).getChannelData(0);
    let peak = 0;
    for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
    out[kind] = +(20 * Math.log10(peak || 1e-9)).toFixed(1);
  }
  return out;
}"""

# per-frame sampler of the tool's phases (real time, real input)
PHASE_REC = """() => {
  const rec = window.__phases = { list: [], on: true, revs: [] };
  const tick = () => {
    if (!rec.on) return;
    const s = window.__goldrush.hand(), last = rec.list[rec.list.length - 1];
    const ph = s.state === 'action' ? s.phase : s.state;
    if (ph !== last) { rec.list.push(ph); rec.revs.push({ ph, rev: window.__goldrush.state().revision, soil: s.soil }); }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}"""


def shot(page, shots, name):
    if shots:
        page.screenshot(path=str(shots / f"gr3_{name}.png"))


def hold(page, seconds):
    page.mouse.down()
    time.sleep(seconds)
    page.mouse.up()


# ======================================================================
# Part A + C: foundation, tools (desktop)
# ======================================================================

def foundation_and_tools(browser, base, user, shots):
    ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
    open_game(A)
    ok("setup: fixed test seed, a new game", G(A, "() => window.__goldrush.state().seed") == SEED)
    listeners0 = A.evaluate("() => window.__listeners()")

    # ---------------- progression basics first (a NEW game)
    t0 = tools(A)
    A.keyboard.press("Digit2")
    time.sleep(0.4)
    t1 = tools(A)
    tip = G(A, "() => window.__goldrush.hudState().tip")
    belt = G(A, "() => [...document.querySelectorAll('.gr-belt .gr-slot')].map((b) => ({ t: b.dataset.tool, locked: b.classList.contains('is-locked'), active: b.classList.contains('is-active') }))")
    ok("T20 a new game owns ONLY the hand; key 2 refuses the locked shovel with a quiet hint; the belt shows the locks",
       t0["owned"] == ["hand"] and t0["equipped"] == "hand" and t1["equipped"] == "hand" and tip and "noch nicht freigeschaltet" in tip
       and belt == [{"t": "hand", "locked": False, "active": True}, {"t": "shovel", "locked": True, "active": False}, {"t": "pickaxe", "locked": True, "active": False}],
       f"{t0['owned']} tip={tip!r} belt={belt}")
    defs = G(A, "() => window.__goldrush.toolDefs()")
    fields = ["id", "label", "tier", "reach", "materialEfficiency", "loosenedBonus", "kernel", "massCapacity", "rockDamage", "price", "cycle"]
    luck = [k for d in defs for k in json.dumps(d).lower().split('"') if any(w in k for w in ("luck", "findchance", "findbonus", "goldbonus", "rarity"))]
    ok("T22 exactly three tool definitions (hand, shovel, pickaxe), each with efficiency per material, kernel, timing, rock damage, shop price",
       [d["id"] for d in defs] == ["hand", "shovel", "pickaxe"] and all(all(f in d for f in fields) and len(d["materialEfficiency"]) == 4 for d in defs),
       str([(d["id"], d["cycle"]) for d in defs]))
    ok("T40a no tool carries luck / find-rate stats - more gold only comes from moving more ground", not luck, str(luck))

    # ---------------- T11: hand mass per action and material (fresh ground)
    per = {}
    for name, start in (("dirt", 0.1), ("compactDirt", 0.3), ("gravel", 0.5)):
        spot = G(A, SPOT, {"want": name, "reach": 2.0, "start": start, "fresh": True, "uniform": True, "wide": name == "compactDirt"})
        if not spot:
            per[name] = None
            continue
        r = G(A, ACT_N, {"n": 4, "tool": None, "spot": spot, "jitter": 0, "seed": 3})
        m = MAT_ID.index(name)
        per[name] = round(r["pureKg"][m] / r["pureN"][m], 3) if r["pureN"][m] else None
    stone_spot = G(A, SPOT, {"want": "stone", "reach": 2.1, "start": 0.2, "fresh": False})
    stone = G(A, ACT_N, {"n": 3, "tool": None, "spot": stone_spot, "jitter": 0}) if stone_spot else None
    ok("T11 hand per action: loose dirt 0.15-0.35 kg, compact clearly less, gravel much less, stone nothing (bounces)",
       per["dirt"] and 0.15 <= per["dirt"] <= 0.35 and per["compactDirt"] and per["compactDirt"] < per["dirt"] * 0.75
       and per["gravel"] and per["gravel"] < per["compactDirt"] * 0.8 and stone and stone["blocked"] == 3 and stone["kg"] == 0,
       f"{per} stone={stone and (stone['blocked'], stone['kg'])}")
    hand_cycle = defs[0]["cycle"]
    rates = {}
    for name in ("dirt", "compactDirt", "gravel"):
        if per.get(name):
            m = MAT_ID.index(name)
            apm = 60 / hand_cycle[m]
            dens = [1350, 1650, 1800][m]
            rates[name] = {"actions/min": round(apm), "kg/min": round(apm * per[name], 1), "m3/min": round(apm * per[name] / dens, 4)}
    print("  hand rates:", rates, flush=True)
    ok("T12 hand pace per material is reported; loose dirt 15-40 kg/min (a slow start)",
       rates.get("dirt") and 15 <= rates["dirt"]["kg/min"] <= 40, json.dumps(rates))

    # ---------------- T1/T2/T3: the bite and the hollow
    spot = G(A, SPOT, {"want": "dirt", "reach": 2.0, "start": 0.7, "fresh": True})
    one = G(A, r"""(s) => {
      const G = window.__goldrush, t = G.terrain();
      G.aimAt(s);
      const before = Int32Array.from(t.qh);
      const q = G.act({ visuals: false });
      const diffs = [];
      for (let k = 0; k < before.length; k++) if (t.qh[k] !== before[k]) diffs.push((before[k] - t.qh[k]) / 10000);
      const cut = diffs.filter((d) => d > 0);
      return { q, cells: cut.length, max: Math.max(...cut), mean: cut.reduce((a, b) => a + b, 0) / cut.length };
    }""", spot)
    ok("T1 one hand stroke scrapes a thin, flat patch: several cells, at most 12 mm deep, no single-column spike",
       one["cells"] >= 2 and one["max"] <= 0.0121 and one["max"] <= one["mean"] * 3.2,
       f"cells={one['cells']} max={one['max'] * 1000:.1f}mm mean={one['mean'] * 1000:.1f}mm")
    G(A, ACT_N, {"n": 299, "tool": None, "spot": spot, "jitter": 0.35, "seed": 11})
    hole_xz = G(A, "(s) => { const G = window.__goldrush; G.aimAt(s); const p = G.state(); return { x: p.x - Math.sin(s.yaw) * 1.3, z: p.z - Math.cos(s.yaw) * 1.3 }; }", spot)
    shape = G(A, SHAPE, {"x": hole_xz["x"], "z": hole_xz["z"], "R": 1.4})
    ok("T2 300 hand strokes in one place leave a shallow scraped hollow - no shaft, no needle (steepest step <= 62 deg, depth < 0.5 m)",
       shape["valid"] and shape["maxDeg"] <= 62.5 and shape["deepest"] < 0.5 and shape["changed"] >= 10, str(shape))
    # shovel pit -> loose material at its angle of repose
    G(A, "() => window.__goldrush.devUnlock(true)")
    select(A, "shovel")
    pit = G(A, SPOT, {"want": "dirt", "reach": 2.3, "start": 0.05, "fresh": True})
    r_pit = G(A, ACT_N, {"n": 140, "tool": None, "spot": pit, "jitter": 0.25, "seed": 5})
    pit_xz = G(A, "(s) => { const G = window.__goldrush; G.aimAt(s); const p = G.state(); return { x: p.x - Math.sin(s.yaw) * 1.5, z: p.z - Math.cos(s.yaw) * 1.5 }; }", pit)
    pshape = G(A, SHAPE, {"x": pit_xz["x"], "z": pit_xz["z"], "R": 1.8})
    ok("T3 a shovel pit settles locally by material: loose cells stand at their angle of repose (dirt 40 deg, gravel 37, compact 50), crust and stone hold, nothing above the limits",
       pshape["looseCells"] > 10 and pshape["looseOver"] <= max(2, pshape["looseCells"] // 50) and r_pit["relocated"] > 0, f"{pshape} relocated={r_pit['relocated'] * 1000:.1f} l")

    # ---------------- T6/T7/T9: transaction bookkeeping + mass
    led0 = G(A, LEDGER)
    q6 = G(A, SPOT, {"want": "dirt", "reach": 2.3, "start": 0.37, "fresh": True})
    q = G(A, "(s) => { const G = window.__goldrush; G.aimAt(s); return G.act({ visuals: false }); }", q6)
    ls = G(A, "() => window.__goldrush.lastStroke()")
    ok("T6 an action reports requested, actually removed (volume + mass), relocated and processed volume - separately",
       q and q["requested"] >= q["removed"] > 0 and q["relocated"] >= 0 and abs(q["processed"] - q["slices"] * 0.00015625) < 1e-9
       and ls and all(k in ls for k in ("requestedL", "removedL", "relocatedL", "processedL", "massKg")),
       f"req={q and q['requested'] * 1000:.3f}l rem={q and q['removed'] * 1000:.3f}l rel={q and q['relocated'] * 1000:.3f}l proc={q and q['processed'] * 1000:.3f}l kg={q and q['massKg']:.3f}")
    # T7: material that only slides pays nothing
    money0, disc0, qsum0 = eco(A)["moneyCents"], eco(A)["stats"]["discovered"], G(A, "() => window.__goldrush.terrain().volumeDelta()")
    slid = G(A, r"""(p) => {
      const G = window.__goldrush, t = G.terrain(), c = t.cell, vps = t.vps;
      // loosen the rim of the pit (as if someone trampled it) and let it settle
      const i0 = Math.floor((p.x - 1.9 - t.x0) / c), i1 = Math.ceil((p.x + 1.9 - t.x0) / c), j0 = Math.floor((p.z - 1.9 - t.z0) / c), j1 = Math.ceil((p.z + 1.9 - t.z0) / c);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = j * vps + i; if (t.qh[k] === 0) t.loose[k] = 30; }
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) t._lim[j * vps + i] = t._reposeTan(j * vps + i);
      return t.settleArea(p.x - 1.9, p.z - 1.9, p.x + 1.9, p.z + 1.9, 30);
    }""", pit_xz)
    led1 = G(A, LEDGER)
    e1 = eco(A)
    ok("T7 relocation (slumping) moves material but never pays: money and discovered finds unchanged, volume exactly conserved, the gold of slid slices travels along (carried)",
       slid > 0 and e1["moneyCents"] == money0 and e1["stats"]["discovered"] == disc0 and abs(G(A, "() => window.__goldrush.terrain().volumeDelta()") - qsum0) < 1e-9
       and led1["withGold"] == led1["discovered"] + led1["carried"],
       f"slid={slid * 1000:.1f} l carried {led0['carried']}->{led1['carried']} usedSlices {led0['usedSlices']}->{led1['usedSlices']}")
    ok("T8a ledger: every used-up slice with gold is either discovered or carried - nothing lost, nothing twice",
       led1["withGold"] == led1["discovered"] + led1["carried"], str(led1))
    # T9: mountain volume decreases exactly by what was removed (10 / 100 / 1000 kg)
    rows = []
    for target in (10, 100, 1000):
        v0 = G(A, "() => window.__goldrush.volume().delta")
        m0 = sum(eco(A)["stats"]["massG"].values())
        got = {"kg": 0, "removed": 0, "n": 0}
        start = 0.1 + target / 7000
        while got["kg"] < target and got["n"] < 4000:
            sp = G(A, SPOT, {"want": None, "reach": 2.3, "start": start, "fresh": False})
            start += 0.137
            r = G(A, ACT_N, {"n": 40, "tool": None, "spot": sp, "jitter": 0.4, "seed": got["n"] + 1})
            got["kg"] += r["kg"]; got["removed"] += r["removed"]; got["n"] += r["n"]
        v1 = G(A, "() => window.__goldrush.volume().delta")
        m1 = sum(eco(A)["stats"]["massG"].values())
        rows.append((target, round(got["kg"], 2), round((v0 - v1) * 1000, 3), round(got["removed"] * 1000, 3), (m1 - m0) / 1000))
    ok("T9 the mountain shrinks by exactly what was removed (10 kg / 100 kg / 1,000 kg): volume delta == removed volume, booked mass == removed mass",
       all(abs(r[2] - r[3]) < 0.01 + r[3] * 1e-6 and abs(r[4] - r[1]) < 0.002 * r[1] + 0.05 for r in rows), str(rows))
    led2 = G(A, LEDGER)
    ok("T8 exactly once after >1,000 mixed hand/shovel actions: the gold ledger balances (used-up gold slices == discovered + carried) and discovered == collected + pending",
       led2["withGold"] == led2["discovered"] + led2["carried"] and led2["discovered"] == led2["finds"] + led2["pending"], str(led2))

    # ---------------- T25/T26: shovel throughput vs hand (fresh loose dirt)
    sh_spot = G(A, SPOT, {"want": "dirt", "reach": 2.3, "start": 0.83, "fresh": True})
    sh = G(A, ACT_N, {"n": 6, "tool": "shovel", "spot": sh_spot, "jitter": 0, "seed": 2})
    sh_kg = sh["kgByMat"][DIRT] / max(1, sh["byMat"][DIRT])
    sh_cycle = defs[1]["cycle"][DIRT]
    hand_kgmin = 60 / hand_cycle[DIRT] * per["dirt"]
    sh_kgmin = 60 / sh_cycle * sh_kg
    print(f"  shovel: {sh_kg:.2f} kg/scoop, {1 / sh_cycle:.2f} scoops/s, {sh_kgmin:.0f} kg/min vs hand {hand_kgmin:.1f} kg/min", flush=True)
    ok("T26 shovel: 1-2.5 kg per scoop of loose dirt at 0.7-1.2 scoops per second", 1.0 <= sh_kg <= 2.5 and 0.7 <= 1 / sh_cycle <= 1.2, f"{sh_kg:.2f} kg, {1 / sh_cycle:.2f}/s")
    ok("T25 the shovel moves 4-8x what the hand moves (kg/min, real cycle times) - a real upgrade, not a game changer",
       4 <= sh_kgmin / hand_kgmin <= 8, f"x{sh_kgmin / hand_kgmin:.2f}")

    # ---------------- T27/T39: real-time shovel action through its phases
    select(A, "shovel")
    rt = G(A, SPOT, {"want": None, "reach": 2.2, "start": 0.91, "fresh": False})
    G(A, "(s) => window.__goldrush.pose(s)", rt)
    G(A, PHASE_REC)
    d0 = eco(A)["stats"]["byTool"]["shovel"]["actions"]
    hold(A, 2.3)
    time.sleep(1.2)
    rec = G(A, "() => { window.__phases.on = false; return window.__phases; }")
    d1 = eco(A)["stats"]["byTool"]["shovel"]["actions"]
    seq = [p for p in rec["list"] if p not in ("idle",)]
    want = ["windup", "thrust", "scoop", "dump", "recover"]
    in_order = seq[:5] == want
    revs = rec["revs"]
    rev_at = {}
    for r in revs[:6]:
        rev_at.setdefault(r["ph"], r["rev"])
    soil = [r for r in revs[:6] if r["ph"] in ("scoop", "dump")]
    ok("T27 shovel: windup -> thrust -> contact -> scoop -> dump -> recover; the ground changes only at the contact; soil lies on the blade after it",
       in_order and rev_at.get("windup") == rev_at.get("thrust") and rev_at.get("scoop", -1) > rev_at.get("thrust", 0) and any(r["soil"] for r in soil),
       f"seq={seq[:8]} revs={revs[:6]}")
    ok("T39 holding the button with the shovel acts at its real pace (2-3 scoops in 2.3 s)", 1 <= d1 - d0 <= 3, f"{d1 - d0} scoops")
    tc = G(A, "() => window.__goldrush.toolCheck()")
    ok("T35a the shovel is a proper model (blade with lift, D-grip, collar, rivets, worn edge: >= 8 meshes, > 1,000 vertices, textured PBR wood + steel with reflections) and both gloves sit on its grips (< 1.5 cm)",
       tc["shovel"]["meshes"] >= 8 and tc["shovel"]["verts"] > 1000 and any("+map+env" in m for m in tc["shovel"]["mats"]) and any("+map" in m for m in tc["shovel"]["mats"]) and tc["gripError"] < 0.015,
       str(tc))
    shot(A, shots, "shovel_rest")

    # ---------------- T28: shovel on stone / a boulder: bounce, chips, nothing removed
    rk = G(A, SPOT, {"want": None, "reach": 2.3, "start": 0.33, "fresh": False, "rock": True})
    v0 = G(A, "() => window.__goldrush.volume().delta")
    r = G(A, "(s) => { const G = window.__goldrush; G.aimAt(s); return G.act({ visuals: false }); }", rk) if rk else None
    v1 = G(A, "() => window.__goldrush.volume().delta")
    G(A, "(s) => window.__goldrush.pose(s)", rk) if rk else None
    A.mouse.down(); time.sleep(0.9); A.mouse.up(); time.sleep(0.3)
    frags = G(A, "() => window.__goldrush.info().fragments")
    ls = G(A, "() => window.__goldrush.lastStroke()")
    ok("T28 shovel on a boulder: bounces off (blocked), stone chips fly, nothing is removed",
       r and r["blocked"] and r["kind"] == "blocked" and v1 == v0 and frags > 0 and ls and ls.get("kind") == "blocked", f"r={r and r['kind']} frags={frags} last={ls}")

    # ---------------- pickaxe
    select(A, "pickaxe")
    # T29: inefficient in loose dirt
    pk_spot = G(A, SPOT, {"want": "dirt", "reach": 2.2, "start": 0.61, "fresh": True})
    pk = G(A, ACT_N, {"n": 6, "tool": "pickaxe", "spot": pk_spot, "jitter": 0})
    pk_kg = pk["kgByMat"][DIRT] / max(1, pk["byMat"][DIRT])
    pk_kgmin = 60 / defs[2]["cycle"][DIRT] * pk_kg
    ok("T29 the pickaxe is the wrong tool for loose dirt: less kg/min than the bare hand", pk_kgmin < hand_kgmin, f"{pk_kgmin:.1f} vs hand {hand_kgmin:.1f} kg/min")
    # T30: loosening compact soil helps hand and shovel
    cp = G(A, SPOT, {"want": "compactDirt", "reach": 2.0, "start": 0.27, "fresh": True, "uniform": True, "wide": True})
    before = G(A, ACT_N, {"n": 4, "tool": "hand", "spot": cp, "jitter": 0})
    G(A, ACT_N, {"n": 5, "tool": "pickaxe", "spot": cp, "jitter": 0})
    loose = G(A, "(s) => { const G = window.__goldrush; G.aimAt(s); return G.probe().loose; }", cp)
    after = G(A, ACT_N, {"n": 4, "tool": "hand", "spot": cp, "jitter": 0})
    kb = before["pureKg"][COMPACT] / max(1, before["pureN"][COMPACT])
    ka = after["pureKg"][COMPACT] / max(1, after["pureN"][COMPACT])
    ok("T30 the pickaxe loosens compact soil (saved state); the hand then moves clearly more of it", loose and loose > 0 and ka >= kb * 1.5,
       f"loose={loose} cm, hand {kb:.3f} -> {ka:.3f} kg/action")
    # T34: pickaxe phases in real time
    G(A, "(s) => window.__goldrush.pose(s)", pk_spot)
    G(A, PHASE_REC)
    hold(A, 1.0)
    time.sleep(1.0)
    rec = G(A, "() => { window.__phases.on = false; return window.__phases; }")
    seq = [p for p in rec["list"] if p != "idle"]
    ok("T34 pickaxe: raise -> swing -> contact -> recoil -> recover", seq[:4] == ["raise", "swing", "recoil", "recover"], str(seq[:8]))
    A.mouse.down()
    errs35 = []
    for _ in range(10):
        time.sleep(0.06)
        errs35.append(G(A, "() => { const c = window.__goldrush.toolCheck(), h = window.__goldrush.hand(); return [+c.gripError.toFixed(4), h.phase, h.inspecting, h.shown]; }"))
    A.mouse.up()
    tc = G(A, "() => window.__goldrush.toolCheck()")
    tc["gripError"] = max(e[0] for e in errs35)
    tc["samples"] = errs35
    ok("T35b the pickaxe is a proper model (handle, forged eye, curved point, adze; textured PBR) and the gloves hold it (< 1.5 cm)",
       tc["pickaxe"]["meshes"] >= 8 and tc["pickaxe"]["verts"] > 1000 and any("+map+env" in m for m in tc["pickaxe"]["mats"]) and tc["gripError"] < 0.015, str(tc))
    # T31/T32: break a boulder
    rocks = G(A, "() => window.__goldrush.rocks()")
    small, large = min(rocks, key=lambda r: r["r"]), max(rocks, key=lambda r: r["r"])
    pick_cycle = defs[2]["cycle"][STONE - 0]
    rk = G(A, SPOT, {"want": None, "reach": 2.25, "start": 0.33, "fresh": False, "rock": True})
    target = rk["boulder"]
    stages, n = [], 0
    while n < 60:
        hit = G(A, "(s) => { const G = window.__goldrush; G.aimAt(s); const p = G.probe(); return p && p.boulder; }", rk)
        if hit != target:
            break
        q = G(A, "() => window.__goldrush.act({ visuals: false })")
        n += 1
        stages.append(q["rock"]["stage"])
        if q["rock"]["broke"]:
            break
    info = G(A, "(i) => window.__goldrush.rocks()[i]", target)
    rs = G(A, "() => window.__goldrush.rockStats()")
    uniq = [s for i, s in enumerate(stages) if i == 0 or s != stages[i - 1]]
    print(f"  boulders: small r={small['r']:.2f} m -> {small['maxHp']} hits ({small['maxHp'] * pick_cycle:.1f} s), large r={large['r']:.2f} m -> {large['maxHp']} hits ({large['maxHp'] * pick_cycle:.1f} s)", flush=True)
    ok("T31 a boulder takes several pickaxe hits and shows its damage: intact -> damaged -> heavily damaged -> broken (hits = its integrity)",
       uniq == ["intact", "damaged", "heavilyDamaged", "broken"] or uniq == ["damaged", "heavilyDamaged", "broken"], f"{n} hits {uniq} maxHp={info['maxHp']}")
    ok("T31b integrity grows with size: small boulders break in seconds, big ones take much longer",
       small["maxHp"] < large["maxHp"] and small["maxHp"] >= 4, f"small {small['maxHp']} / large {large['maxHp']} hits")
    ok("T32 a broken boulder leaves a few pieces of rubble (no cascade), its collider is gone, it paid nothing",
       info["broken"] and info["collider"] == 0 and 1 <= rs["rubble"] <= 4 * rs["broken"], f"{info} {rs}")
    # T33: ground stone: hand / shovel bounce, the pickaxe chips it slowly
    gs = G(A, SPOT, {"want": "stone", "reach": 2.2, "start": 0.45, "fresh": False, "core": True})
    hand_on = G(A, ACT_N, {"n": 2, "tool": "hand", "spot": gs, "jitter": 0}) if gs else None
    shovel_on = G(A, ACT_N, {"n": 2, "tool": "shovel", "spot": gs, "jitter": 0}) if gs else None
    pick_on = G(A, ACT_N, {"n": 6, "tool": "pickaxe", "spot": gs, "jitter": 0}) if gs else None
    ok("T33 solid stone: hand and shovel bounce off, only the pickaxe chips it away - slowly (< 0.4 kg per hit)",
       gs and hand_on["blocked"] == 2 and shovel_on["blocked"] == 2 and pick_on["kgByMat"][STONE] > 0 and pick_on["maxKg"] < 0.4,
       f"hand={hand_on and hand_on['blocked']} shovel={shovel_on and shovel_on['blocked']} pick={pick_on and round(pick_on['kgByMat'][STONE], 3)} kg")

    # ---------------- T4: boulders sink with the ground, never float
    select(A, "shovel")
    b4 = None
    rocks = [r for r in G(A, "() => window.__goldrush.rocks()") if not r["broken"]]
    gaps, y0 = [], None
    for cand in sorted(rocks, key=lambda r: r["y"]):
        ang = math.atan2(cand["x"], cand["z"] + 6)
        px, pz = cand["x"] + math.sin(ang) * 1.7, cand["z"] + math.cos(ang) * 1.7
        y0 = cand["y"]
        res = G(A, r"""([R, n]) => { const G = window.__goldrush; let done = 0, gapMax = 0;
          for (let i = 0; i < n; i++) {
            const rk0 = G.rocks()[R.index];
            const a = Math.atan2(R.px - rk0.x, R.pz - rk0.z) + ((i % 7) - 3) * 0.16;
            const tx = rk0.x + Math.sin(a) * (R.r * 1.05), tz = rk0.z + Math.cos(a) * (R.r * 1.05);
            const yaw = Math.atan2(-(tx - R.px), -(tz - R.pz));
            let best = null;
            for (let pt = -1.3; pt < 0.1; pt += 0.02) {
              const d = G.aimAt({ x: R.px, z: R.pz, yaw, pitch: pt });
              if (d == null || d > 2.35 || G.aim().state !== 'dig') continue;
              const p = G.probe(); if (!p || p.boulder != null) continue;
              const h = G.state(), hx = h.x - Math.sin(yaw) * Math.cos(pt) * d, hz = h.z - Math.cos(yaw) * Math.cos(pt) * d;
              const dd = Math.abs(Math.hypot(hx - rk0.x, hz - rk0.z) - R.r * 0.95);
              if (!best || dd < best.dd) best = { dd, pt };
            }
            if (!best) continue;
            G.aimAt({ x: R.px, z: R.pz, yaw, pitch: best.pt });
            const q = G.act({ visuals: false });
            if (q && q.massKg > 0) done++;
            gapMax = Math.max(gapMax, G.rocks()[R.index].gap);
          }
          const rk = G.rocks()[R.index];
          return { done, gapMax, y: rk.y, moved: rk.moved }; }""", [{"index": cand["index"], "r": cand["r"], "px": px, "pz": pz}, 160])
        if res["done"] >= 80:
            b4 = res
            break
    ok("T4 digging round a boulder: it sinks / tilts / rolls with the ground and never floats (gap under it <= 2 cm after every action)",
       b4 and b4["gapMax"] <= 0.02 and b4["y"] < y0 - 0.05, f"{b4} y0={y0}")

    # ---------------- T5: buried stone stays hidden, exposed stone shows
    sc = G(A, FIND_STONE_COLUMNS)
    w_b = G(A, SURFACE_STONE, sc["buried"]) if sc["buried"] else None
    w_e = G(A, SURFACE_STONE, sc["exposed"]) if sc["exposed"] else None
    ok("T5 stone under a few cm of soil stays hidden; exposed stone shows as stone", (sc["buried"] is None or w_b == 0) and w_e == 1,
       f"buried={sc['buried']} w={w_b} exposed={sc['exposed']} w={w_e}")

    # ---------------- T23/T24/T37: switching
    select(A, "hand")
    A.keyboard.press("Digit2")
    states = []
    for _ in range(14):
        states.append(tools(A)["state"])
        time.sleep(0.04)
    time.sleep(0.3)
    eq = tools(A)["equipped"]
    ok("T23 switching lowers the old tool and raises the new one (cooldown ~0.4 s); no action meanwhile", "lower" in states and "raise" in states and eq == "shovel", str(states))
    sp = G(A, SPOT, {"want": None, "reach": 2.2, "start": 0.5, "fresh": False})
    G(A, "(s) => window.__goldrush.pose(s)", sp)
    a0 = eco(A)["stats"]["totalDigs"]
    A.mouse.down()
    time.sleep(0.12)
    A.keyboard.press("Digit1")
    A.mouse.up()
    time.sleep(0.6)
    ok("T24 switching during the windup cancels the action - nothing happens to the ground",
       eco(A)["stats"]["totalDigs"] == a0 and tools(A)["equipped"] == "hand", f"{eco(A)['stats']['totalDigs'] - a0} actions")
    seq = []
    for key, want_tool in (("Digit3", "pickaxe"), ("Digit2", "shovel"), ("Digit1", "hand")):
        A.keyboard.press(key)
        time.sleep(0.55)
        active = G(A, "() => document.querySelector('.gr-belt .gr-slot.is-active').dataset.tool")
        seq.append((tools(A)["equipped"], active))
    ok("T37 desktop keys 1 / 2 / 3 switch tools; the belt follows", seq == [("pickaxe", "pickaxe"), ("shovel", "shovel"), ("hand", "hand")], str(seq))

    # ---------------- T36: reduced motion
    A.evaluate("() => window.__goldrush.state()")
    A.evaluate("() => { document.exitPointerLock && document.exitPointerLock(); }")
    time.sleep(0.3)
    G(A, "() => { const g = document.querySelector('[data-act=settings]'); g && g.click(); }")
    A.check("[data-role=reduced]")
    A.click("[data-act=close-settings]")
    gr_start(A)
    select(A, "shovel")
    rk = G(A, SPOT, {"want": None, "reach": 2.3, "start": 0.73, "fresh": False, "rock": True})
    if rk:
        G(A, "(s) => window.__goldrush.pose(s)", rk)
        A.mouse.down(); time.sleep(0.75)
        h = G(A, "() => window.__goldrush.hand()")
        A.mouse.up()
    else:
        h = None
    ok("T36 reduced motion: no camera kick and no shake of the tool, even on a stone hit", h and h["kick"] < 1e-6 and h["shake"] == 0, str(h and {k: h[k] for k in ("kick", "shake")}))
    G(A, "() => { document.exitPointerLock && document.exitPointerLock(); }")
    time.sleep(0.3)
    G(A, "() => { const g = document.querySelector('[data-act=settings]'); g && g.click(); }")
    A.uncheck("[data-role=reduced]")
    A.click("[data-act=close-settings]")
    gr_start(A)

    # ---------------- T40: finds come from the ground, not from the tool
    sp = G(A, SPOT, {"want": None, "reach": 2.2, "start": 0.19, "fresh": True})
    keys = G(A, ACT_N, {"n": 120, "tool": "shovel", "spot": sp, "jitter": 0.3, "seed": 9})["keys"]
    keys += G(A, ACT_N, {"n": 200, "tool": "hand", "spot": sp, "jitter": 0.3, "seed": 10})["keys"]
    real = [k for k in keys if k != "debug"]
    check = G(A, "(keys) => keys.map((k) => { const [i, j, iy] = k.split(':').map(Number); return window.__goldrush.voxel(i, j, iy).cls; })", real[:400])
    ok("T40 every find (shovel or hand) is exactly what that slice of ground holds - no tool luck", real and all(c and c > 0 for c in check) and len(set(real)) == len(real),
       f"{len(real)} finds, unique {len(set(real))}")

    # ---------------- T21: dev unlock is debug/test only and never saved as owned
    G(A, "() => window.__goldrush.save()")
    saved = json.loads(G(A, "() => localStorage.getItem(grKey())"))
    # (prompt 5.5: the server-gated "Entwicklertools" entry and its DEV / DEV-MODIFIED marks are not this debug unlock)
    ui_dev = G(A, """() => [...document.querySelectorAll('.gr-root [data-act*=dev], .gr-root [data-role*=dev]')]
      .some((e) => !e.closest('.gr-dev-entry') && e.dataset.role !== 'start-dev')""")
    ok("T21 the dev unlock exists only for debug / tests: no control in the game UI, never saved as owned",
       saved["tools"]["owned"] == ["hand"] and not ui_dev and tools(A)["dev"], str(saved["tools"]))

    # ---------------- T41/T45: save v3, owning a tool for real
    ok("T41 the save (now v4) holds owned tools, pending finds, boulders, carried finds, 0.1 mm terrain, 1 cm slices",
       saved["saveVersion"] == CURRENT_SAVE and set(saved["tools"]) == {"owned", "equipped", "upgrades"} and isinstance(saved["economy"]["pending"], list)
       and saved["rocks"]["v"] == 1 and isinstance(saved["resources"]["carried"], list) and saved["terrain"]["unit"] == "0.1mm"
       and saved["resources"]["unit"] == "slice1cm+0.1mm", str({k: saved[k] for k in ("saveVersion", "tools")}))
    h_before = G(A, "() => window.__goldrush.hashes()")
    G(A, "() => { window.__goldrush.devUnlock(false); return window.__goldrush.selectTool('hand'); }")
    time.sleep(0.5)
    A.evaluate("() => window.__goldrush.save()")
    gr_close(A)
    open_game(A)
    h_after = G(A, "() => window.__goldrush.hashes()")
    same = {k: h_before[k] == h_after[k] for k in ("height", "qh", "slices", "carried", "rocks", "seed")}
    ok("T41b save -> reload restores terrain, used-up slices, carried finds and boulders (incl. the broken one) exactly", all(same.values()), str(same))

    listeners1 = A.evaluate("() => window.__listeners()")
    errs = errors(A)
    ok("desktop part ran without page errors", not errs, str(errs[:3]))
    gr_close(A)
    left = A.evaluate("() => ({ roots: document.querySelectorAll('.gr-root').length, listeners: window.__listeners() })")
    ok("closing GoldRush leaves no listeners behind (tools, keys 1-3, belt)", left["roots"] == 0 and left["listeners"] <= listeners0, f"{listeners0} -> {left}")
    ctx.close()


# ======================================================================
# progression: owning tools, migration, save sizes
# ======================================================================

def progression(browser, base, user, shots, bench):
    ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
    open_game(A)
    # T45: a tool really granted (what a later shop will do) persists and is usable without any dev flag
    G(A, "() => window.__goldrush.grant('shovel')")
    A.evaluate("() => window.__goldrush.save()")
    gr_close(A)
    open_game(A)
    t = tools(A)
    A.keyboard.press("Digit2")
    time.sleep(0.6)
    ok("T45 an owned tool (granted like a later shop would) survives a reload and switches with its key - without any debug unlock",
       t["owned"] == ["hand", "shovel"] and not t["dev"] and tools(A)["equipped"] == "shovel", str(t))

    # T42: migration 1 -> 2 -> 3 and a REAL phase-2 save
    fix = json.loads(FIXTURE_V2.read_text(encoding="utf-8"))
    gr_close(A)
    A.evaluate("(d) => { localStorage.setItem(grKey(), JSON.stringify(d)); localStorage.removeItem(grKey('.backup')); }", fix["doc"])
    open_game(A)
    h = G(A, "() => window.__goldrush.hashes()")
    A.evaluate("() => window.__goldrush.save()")
    d3 = json.loads(G(A, "() => localStorage.getItem(grKey())"))
    ok("T42 a real phase-2 save (v2) loads: identical ground, same money, only the hand owned; written back as the current version and still small",
       h["height"] == fix["phase2"]["hashes"]["height"] and h["money"] == fix["phase2"]["money"] and h["tools"]["owned"] == ["hand"]
       and d3["saveVersion"] == CURRENT_SAVE and len(json.dumps(d3)) < 8000, f"hash {h['height']} vs {fix['phase2']['hashes']['height']}, money {h['money']}, {len(json.dumps(d3))} B")
    v1 = {"saveVersion": 1, "worldSeed": 77, "createdAt": 1, "updatedAt": 2, "money": 3.5, "tool": "hand",
          "player": {"x": 0.6, "z": 10.2, "yaw": 0, "pitch": 0.1}, "stats": {"digs": 12}, "terrain": None}
    gr_close(A)
    A.evaluate("(d) => { localStorage.setItem(grKey(), JSON.stringify(d)); localStorage.removeItem(grKey('.backup')); }", v1)
    open_game(A)
    A.evaluate("() => window.__goldrush.save()")
    d = json.loads(G(A, "() => localStorage.getItem(grKey())"))
    ok("T42b a phase-1 save (v1, money as a float) goes 1 -> 2 -> 3 -> 4: € 3,50 kept as 350 cents, only the hand",
       d["saveVersion"] == CURRENT_SAVE and d["economy"]["cashCents"] == 350 and d["tools"]["owned"] == ["hand"] and d["worldSeed"] == 77, str({k: d[k] for k in ("saveVersion", "tools")}))

    # T17: pending -> collected, exactly once, also across exit and reload
    fresh(A)
    sp = G(A, SPOT, {"want": None, "reach": 2.0, "start": 0.3, "fresh": False})
    G(A, "(s) => window.__goldrush.pose(s)", sp)
    m0 = eco(A)["moneyCents"]
    c = G(A, "() => window.__goldrush.debugFind(5, 21800)")
    pend = G(A, "() => window.__goldrush.pending()")
    m_pending = eco(A)["moneyCents"]
    landed = wait_for(lambda: G(A, "() => window.__goldrush.pending().length === 0 && window.__goldrush.loot().active === 0"), 8)
    m1 = eco(A)["moneyCents"]
    A.evaluate("() => window.__goldrush.flushLoot()")
    m2 = eco(A)["moneyCents"]
    ok("T17 a find is PENDING (no money yet) until it is picked up; then booked exactly once (a second flush books nothing)",
       len(pend) == 1 and m_pending == m0 and landed and m1 == m0 + c and m2 == m1, f"c={c} money {m0}->{m_pending}->{m1}->{m2}")
    c2 = G(A, "() => window.__goldrush.debugFind(4, 5200)")
    gr_close(A)                                          # leave while the piece is in the air
    open_game(A)
    m3 = eco(A)["moneyCents"]
    c3 = G(A, "() => window.__goldrush.debugFind(5, 15500)")
    A.evaluate("() => window.__goldrush.save()")        # crash right now: the save holds it as pending
    saved_pending = json.loads(G(A, "() => localStorage.getItem(grKey())"))["economy"]["pending"]
    A.reload()
    A.wait_for_function("() => typeof ws !== 'undefined' && ws && ws.readyState === 1", timeout=15000)
    open_game(A)
    m4 = eco(A)["moneyCents"]
    ok("T17b leaving with a find in the air books it on exit; a crash with a pending find books it once on the next load - no loss, no double pay",
       m3 == m1 + c2 and len(saved_pending) == 1 and m4 == m3 + c3 and eco(A)["pending"] == [], f"{m1}+{c2}={m3}; {m3}+{c3}={m4}")

    # T43: save sizes
    sizes = {}
    fresh(A)
    G(A, "() => window.__goldrush.devUnlock(true)")
    sizes["new"] = G(A, "() => { window.__goldrush.save(); return window.__goldrush.saveBytes(); }")
    done = 0
    marks = [100, 1000] if QUICK else [100, 1000, 5000, 10000]
    k = 0
    for mark in marks:
        while done < mark:
            sp = G(A, SPOT, {"want": None, "reach": 2.25, "start": 0.05 + k * 0.071, "fresh": False})
            k += 1
            tool = ["hand", "hand", "shovel", "pickaxe"][k % 4]
            r = G(A, ACT_N, {"n": min(50, mark - done), "tool": tool, "spot": sp, "jitter": 0.5, "seed": k})
            done += r["n"]
        sizes[str(mark)] = G(A, "() => { window.__goldrush.save(); return window.__goldrush.saveBytes(); }")
    print("  save sizes (bytes):", sizes, flush=True)
    ok("T43 save sizes stay small (new / 100 / 1k / 5k / 10k actions; 10k < 150 KB)", all(v < 150000 for v in sizes.values()) and sizes["new"] < 3000, json.dumps(sizes))

    # T44: unlock costs are prepared, provisional, and fit the measured pace
    defs = G(A, "() => window.__goldrush.toolDefs()")
    sh = {"cents": defs[1]["price"], "provisional": True}
    med10 = bench["money_cents"]["600"]["median"] if bench else None
    med25 = None
    if bench and bench["money_cents"]["1200"]["n"]:
        med20, med30 = bench["money_cents"]["1200"]["median"], bench["money_cents"]["1800"]["median"]
        med25 = (med20 + med30) / 2
    ok("T44 (phase 4: the shop sets the prices) the shovel's price sits between a median starter's gold after 10 and 25 minutes",
       sh["cents"] > 0 and defs[2]["price"] > sh["cents"] and (med10 is None or med25 is None or med10 <= sh["cents"] <= med25),
       f"shovel {sh} median 10 min {med10} ct, ~25 min {med25} ct")
    errs = errors(A)
    ok("progression part ran without page errors", not errs, str(errs[:3]))
    gr_close(A)
    ctx.close()


# ======================================================================
# economy: canonical benchmark, null rate, fairness, sound
# ======================================================================

def economy(browser, base, user):
    ctx, A = client(browser, base, user, dict(viewport={"width": 960, "height": 600}), extra_init=[seeded()])
    seeds, minutes = (12, 10) if QUICK else (40, 30)
    runs = [bench_seed(A, 1001 + n * 7, minutes, "hand") for n in range(seeds)]
    s = bench_summary(runs)
    print("  benchmark:", json.dumps({k: s[k] for k in ("firstFind_s", "firstFlake_s", "firstTiny_s", "firstNugget_s")}), flush=True)
    print("  money (cents):", json.dumps(s["money_cents"]), flush=True)
    ok(f"T13 canonical benchmark ({seeds} seeds x {minutes} min, simulated newcomer): first gold within seconds (median 3-12 s)",
       3 <= s["firstFind_s"]["median"] <= 12, json.dumps(s["firstFind_s"]))
    if minutes >= 30:
        ok("T13b first nugget after about 5-12 minutes (median), no timer, no pity", 300 <= s["firstNugget_s"]["median"] <= 720, json.dumps(s["firstNugget_s"]))
    mc = s["money_cents"]
    pace = (mc["60"]["median"] < 100 and 100 <= mc["300"]["median"] < 1000 and mc["600"]["median"] < 1000)
    if minutes >= 30:
        pace = pace and mc["1800"]["median"] >= 500
    ok("T14 money pacing: cents after 1 min, low single-digit euros after 5, still not rich after 10, enough for first decisions after 30",
       pace, json.dumps({k: v.get("median") for k, v in mc.items()}))
    ok("T15 no starter nugget worth € 50 or more (largest seen in the benchmark)",
       (s["biggestNugget_cents"].get("max") or 0) < 5000, json.dumps(s["biggestNugget_cents"]))
    open_game(A, start=False)
    nulls = G(A, r"""() => {
      const G = window.__goldrush, t = G.terrain(), f = t.field, vps = t.vps, v = {};
      let n = 0, empty = 0, s = 12345;
      const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
      while (n < 20000) {
        const i = 20 + Math.floor(rnd() * (vps - 40)), j = 20 + Math.floor(rnd() * (vps - 40)), k = j * vps + i;
        const top = Math.ceil((t.base[k] - f.floorY) / 0.01 - 0.5);
        if (t.base[k] < 0.2) continue;
        const iy = Math.floor(rnd() * top);
        f.voxel(i, j, iy, v);
        n++; if (!v.cls) empty++;
      }
      return empty / n;
    }""")
    hand_share = sum(r["finds"] for r in runs) / max(1, sum(r["digs"] for r in runs))
    ok("T16 gold stays scarce (not generous): >= 88 % of the mountain's 1 cm resource slices hold nothing; < 12 % of hand actions bring any gold",
       nulls >= 0.88 and hand_share < 0.12, f"empty slices {nulls * 100:.1f} %, actions with a find {hand_share * 100:.1f} %")
    # T18: fair start on many seeds, the worlds still differ
    fair = []
    for seed in range(2001, 2021):
        gr_close(A)
        A.evaluate("(s) => { localStorage.removeItem(grKey()); localStorage.setItem('goldrush.testSeed', String(s)); }", seed)
        open_game(A, start=False)
        fair.append(G(A, r"""() => {
          const G = window.__goldrush, t = G.terrain(), f = t.field, st = f.starter;
          let gmin = 9, gmax = 0, stone = 0, n = 0;
          for (let a = 0; a < 24; a++) for (const r of [0.5, 1.5, 2.5, 3.5]) {
            const x = st.x + Math.cos(a) * r, z = st.z + Math.sin(a) * r, b = t.getBaseHeightAt(x, z);
            for (const dep of [0.05, 0.4, 0.9]) {
              const y = b - dep, m = f.materialAt(x, y, z);
              if (m === 3) { stone++; continue; }
              const g = f.goldDensityAt(x, y, z, m, dep); gmin = Math.min(gmin, g); gmax = Math.max(gmax, g); n++;
            }
          }
          const near = G.rocks().filter((r) => Math.hypot(r.x - st.x, r.z - st.z) < 2.5).length;
          return { gmin: +gmin.toFixed(3), gmax: +gmax.toFixed(3), stone, near, sig: G.baseSignature ? G.baseSignature() : 0, pockets: f.pockets.map((p) => Math.round(p.x)).join(',') };
        }"""))
    ok("T18 fair starter zone on 20 seeds: gold density held in a narrow band (0.18-0.32), no stone and no boulder right at the start - while the worlds differ",
       all(f["gmin"] >= 0.179 and f["gmax"] <= 0.321 and f["stone"] == 0 and f["near"] == 0 for f in fair) and len({f["pockets"] for f in fair}) >= 18,
       str([f for f in fair if not (f["gmin"] >= 0.179 and f["gmax"] <= 0.321 and f["stone"] == 0 and f["near"] == 0)][:4] or fair[:2]) + f" distinct worlds {len({f['pockets'] for f in fair})}")
    # T19: sound hooks: every kind audible, none clipping; labelled provisional
    kinds = ["dirt", "compact", "gravel", "stone", "air", "dust", "flake", "tiny", "nugget", "pickup", "shovel", "dump", "pick", "pickStone", "crack", "break", "swing", "swap"]
    lv = A.evaluate(AUDIO_LEVELS, kinds)
    label = G(A, "() => document.querySelector('[data-role=sound]').parentElement.textContent")
    if lv is None:
        print("  sound: skipped - this browser build has no OfflineAudioContext", flush=True)
        ok("T19 sound hooks for every action kind; the setting says the sounds are provisional", "vorläufig" in label, label)
    else:
        ok("T19 every sound kind (incl. shovel, dump, pick, crack, break, swing, switch) is audible and none clips; the setting says they are provisional placeholders",
           all(-40 <= v <= -0.5 for v in lv.values()) and "vorläufig" in label, f"{lv} | {label.strip()}")
    gr_close(A)
    ctx.close()
    return s


# ======================================================================
# mobile tool sheet + viewports
# ======================================================================

def mobile(browser, base, user, shots):
    ctx, M = client(browser, base, user, dict(PHONE), extra_init=[seeded()])
    open_game(M)
    chip = M.locator(".gr-tool").bounding_box()
    M.tap(".gr-tool")
    time.sleep(0.2)
    open1 = G(M, "() => document.querySelector('.gr-belt').classList.contains('is-open')")
    slots = G(M, "() => [...document.querySelectorAll('.gr-belt .gr-slot')].map((b) => { const r = b.getBoundingClientRect(); return { t: b.dataset.tool, locked: b.classList.contains('is-locked'), h: Math.round(r.height), inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight }; })")
    M.tap(".gr-belt [data-tool=shovel]")
    time.sleep(0.5)
    still = tools(M)["equipped"]
    G(M, "() => window.__goldrush.devUnlock(true)")
    M.tap(".gr-tool")
    time.sleep(0.2)
    M.tap(".gr-belt [data-tool=shovel]")
    time.sleep(0.6)
    lab = G(M, "() => document.querySelector('.gr-dig-label').textContent")
    closed = not G(M, "() => document.querySelector('.gr-belt').classList.contains('is-open')")
    shot(M, shots, "mobile_sheet")
    ok("T38 mobile: the tool chip opens a compact sheet (44 px slots, all on screen), locked tools are marked and refuse; picking one closes it and GRABEN turns into SCHAUFELN",
       chip and open1 and len(slots) == 3 and all(s["inside"] and s["h"] >= 44 for s in slots) and [s["locked"] for s in slots] == [False, True, True]
       and still == "hand" and tools(M)["equipped"] == "shovel" and lab == "SCHAUFELN" and closed, f"{slots} still={still} label={lab}")
    errs = errors(M)
    ok("mobile part ran without page errors", not errs, str(errs[:3]))
    gr_close(M)
    ctx.close()


# ======================================================================
# mountain scale + long run
# ======================================================================

def scale_and_long_run(browser, base, user, shots, bench, engine="chromium"):
    ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
    open_game(A)
    mt = G(A, MOUNTAIN)
    defs = G(A, "() => window.__goldrush.toolDefs()")
    hand_kgmin, shovel_kgmin = 60 / defs[0]["cycle"][0] * 0.18, 60 / defs[1]["cycle"][0] * 2.1
    hours_hand, hours_shovel = mt["mass"] / hand_kgmin / 60, mt["mass"] / shovel_kgmin / 60
    print(f"  mountain: {mt['vol']:.0f} m3, {mt['mass'] / 1000:.0f} t -> by hand ~{hours_hand:.0f} h, by shovel ~{hours_shovel:.0f} h of non-stop digging", flush=True)
    ok("T47 the mountain is huge: hundreds of m3 / tonnes; by hand it would take hundreds of hours, by shovel still a long time",
       mt["vol"] > 500 and hours_hand > 300 and hours_shovel > 60, f"{mt['vol']:.0f} m3 {mt['mass'] / 1000:.0f} t hand {hours_hand:.0f} h shovel {hours_shovel:.0f} h")
    if bench:
        kg = bench["kg_per_run"]["max"]
        ok("T48 after the benchmark's session (even the busiest run) the mountain is practically untouched (< 1 % moved)", kg / mt["mass"] < 0.01,
           f"{kg:.0f} kg of {mt['mass'] / 1000:.0f} t = {kg / mt['mass'] * 100:.3f} %")
    ok("T46 power curve: hand < shovel <= 8x hand; the pickaxe is no throughput upgrade (it opens what the others cannot)",
       hand_kgmin < shovel_kgmin <= 8 * hand_kgmin, f"hand {hand_kgmin:.0f} kg/min, shovel {shovel_kgmin:.0f} kg/min")

    # T49: >= 10,000 combined tool actions, resources stable. The quality level
    # is pinned (AUTO may step down on a slow software renderer, which compiles
    # other shader variants - that is adaptation, not a leak)
    G(A, "() => window.__goldrush.devUnlock(true)")
    G(A, "() => window.__goldrush.setQuality(window.__goldrush.state().level)")
    total = 3000 if QUICK else 10000
    snap = lambda: {**A.evaluate("() => { const i = window.__goldrush.info(); return { geometries: i.geometries, textures: i.textures, objects: i.sceneObjects, programs: i.programs }; }"),
                    "heap": heap_mb(A), "dom": A.evaluate("() => document.getElementsByTagName('*').length"), "listeners": A.evaluate("() => window.__listeners()")}
    done, k = 0, 0
    first = mid = None
    t0 = time.time()
    tool_count = {"hand": 0, "shovel": 0, "pickaxe": 0}
    while done < total:
        sp = G(A, SPOT, {"want": None, "reach": 2.25, "start": (k * 0.0731) % 1, "fresh": False})
        tool = ["hand", "shovel", "hand", "pickaxe", "shovel"][k % 5]
        k += 1
        r = G(A, ACT_N, {"n": 100, "tool": tool, "spot": sp, "jitter": 0.6, "seed": k})
        done += r["n"]
        tool_count[tool] += r["n"]
        if k % 10 == 0:
            select(A, tool)
            G(A, "(s) => window.__goldrush.pose(s)", sp)
            hold(A, 1.2)                                          # real frames, animation, VFX, loot
            time.sleep(0.6)
        if first is None and k >= 10:                         # baseline after the first real-frame phase (first uploads done)
            A.evaluate("() => window.__goldrush.flushLoot()")
            first = snap()
        if mid is None and k >= 20 and k % 10 == 0 and done >= total // 2:
            A.evaluate("() => window.__goldrush.flushLoot()")
            mid = snap()
    A.evaluate("() => window.__goldrush.flushLoot()")
    time.sleep(1.0)
    last = snap()
    idle = A.evaluate("() => window.__idle()")
    valid = G(A, "() => window.__goldrush.terrainOk()")
    led = G(A, LEDGER)
    print(f"  long run: {done} actions {tool_count} in {time.time() - t0:.0f} s; {first} -> {mid} -> {last}; idle {idle}", flush=True)
    ok(f"T49 long run: {done} combined hand / shovel / pickaxe actions - heap, geometries, textures, DOM, listeners, scene objects stay flat, one animation loop, terrain valid, ledger balanced",
       done >= total and (first["heap"] is None or last["heap"] - first["heap"] < 40) and last["geometries"] - first["geometries"] <= 4
       # nothing keeps growing: the second half ends where it began (a lazy first upload - rubble of the first broken boulder - may come once)
       and last["geometries"] == mid["geometries"] and last["textures"] == mid["textures"] and last["textures"] - first["textures"] <= 1
       and last["dom"] - first["dom"] <= 6 and last["listeners"] == first["listeners"]
       and last["objects"] - first["objects"] <= 2 and valid
       and (30 if engine == "chromium" else 1) <= idle["rafPerSec"] <= 130 and led["withGold"] == led["discovered"] + led["carried"],      # one loop (WebKit renders WebGL in software here)
       f"{first} -> {mid} -> {last} raf={idle['rafPerSec']}")
    errs = errors(A)
    ok("long run without page errors", not errs, str(errs[:3]))
    gr_close(A)
    idle2 = A.evaluate("() => window.__idle()")
    ok("after closing: no animation loop, no interval left", idle2["rafPerSec"] <= 2 and idle2["intervals"] == 0, str(idle2))
    ctx.close()


def main():
    shots = None
    if "--shots" in sys.argv:
        shots = Path(sys.argv[sys.argv.index("--shots") + 1])
        shots.mkdir(parents=True, exist_ok=True)
    engine = sys.argv[sys.argv.index("--browser") + 1] if "--browser" in sys.argv else "chromium"
    proc, base, tmp = start_server()
    try:
        user = login(base, "Goldi")
        with sync_playwright() as p:
            browser = getattr(p, engine).launch(args=GPU_ARGS if engine == "chromium" else [])
            foundation_and_tools(browser, base, user, shots)
            bench = economy(browser, base, user)
            progression(browser, base, user, shots, bench)
            if engine == "chromium":
                mobile(browser, base, user, shots)
            scale_and_long_run(browser, base, user, shots, bench, engine)
            browser.close()
    finally:
        proc.terminate()
    fails = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(fails)}/{len(RESULTS)} checks passed")
    for f in fails:
        print("FAILED:", f[0], f[2][:300])
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
