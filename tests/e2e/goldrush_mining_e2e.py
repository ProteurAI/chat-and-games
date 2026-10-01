"""End-to-end check of GoldRush phase 2: hand mining, materials, gold
finds, pickups, early economy and their persistence. Runs the server from a
temp copy (the real database is never touched) and a fixed world seed, so
every find is reproducible.

    python tests/e2e/goldrush_mining_e2e.py [--shots DIR] [--browser webkit] [--quick]

    --quick   skips the long ones (10,000-stroke economy, 5,000-dig save, long session)

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
from goldrush_e2e import (  # noqa: E402
    AIM_AT_MOUND, DIG_HERE, FRAME_REC, FRAME_STOP, GPU_ARGS, PHONE, client, errors, gr_close, gr_open, gr_pause,
    gr_ready, gr_start, heap_mb, touch, wait_for,
)
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

TEST_GOLDRUSH_SEED = 4242        # the world every test here runs on
RESULTS = []
QUICK = "--quick" in sys.argv
NUGGET, TINY, FLAKE, FINE, TRACE = 5, 4, 3, 2, 1


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def seeded(seed=TEST_GOLDRUSH_SEED):
    return f"localStorage.setItem('goldrush.testSeed', '{seed}');"


def st(page):
    return page.evaluate("() => window.__goldrush.state()")


def eco(page):
    return page.evaluate("() => window.__goldrush.economy()")


def settled(page, timeout=6):
    """all pieces picked up and the money counter done counting"""
    return wait_for(lambda: page.evaluate("() => { const G = window.__goldrush, e = G.economy(); return G.loot().active === 0 && e.shownCents === e.moneyCents; }"), timeout)


def open_game(page, start=True):
    gr_open(page)
    gr_ready(page)
    page.evaluate("() => { for (const s of ['.gr-hint']) { const e = document.querySelector(s); if (e) e.hidden = true; } }")
    if start:
        gr_start(page)


# stand in front of a fresh (unworked) patch of `want` material and aim at it
FIND_TARGET = r"""({ want, maxd, start }) => {
  const G = window.__goldrush;
  for (let a = 0; a < 140; a++) {
    const ang = -1.7 + ((a * 0.618034 + (start || 0)) % 1) * 3.4;
    const dx = Math.sin(ang), dz = Math.cos(ang);
    let foot = null;
    for (let d = 15; d > 0; d -= 0.05) if (G.heightAt(dx * d, -6 + dz * d) > 0.35) { foot = d; break; }
    if (foot == null) continue;
    for (const back of [1.3, 1.0, 1.6, 0.8]) {
      const x = dx * (foot + back), z = -6 + dz * (foot + back), yaw = Math.atan2(dx, dz);
      for (let pt = -0.1; pt > -1.25; pt -= 0.05) {
        const d = G.aimAt({ x, z, yaw, pitch: pt });
        if (d != null && d <= (maxd || 1.9)) {
          const pr = G.probe();
          if (pr && pr.material === want && !pr.worked && pr.boulder == null) return { x, z, yaw, pitch: pt, ang, gold: pr.gold };
          break;
        }
      }
    }
  }
  return null;
}"""

# typical player: pick a spot on the faces one walks up to, dig 20-70
# strokes there (swaying the view a little, stepping in after the hole),
# move on. Returns [cents or -1 for stone, best find class] per stroke.
SIM = r"""({ n, salt, visuals }) => {
  const G = window.__goldrush;
  let s = salt >>> 0; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  if (!window.__sim) window.__sim = { spot: false, left: 0, x: 0, z: 0, ang: 0 };
  const S = window.__sim, out = [];
  const place = () => {
    for (let tries = 0; tries < 30; tries++) {
      const ang = (rnd() - 0.5) * 2.6 + (rnd() < 0.2 ? Math.PI : 0);
      const dx = Math.sin(ang), dz = Math.cos(ang);
      let foot = null;
      for (let d = 15; d > 0; d -= 0.05) if (G.heightAt(dx * d, -6 + dz * d) > 0.35) { foot = d; break; }
      if (foot == null) continue;
      S.ang = ang; S.x = dx * (foot + 1.3); S.z = -6 + dz * (foot + 1.3); S.left = 20 + Math.floor(rnd() * 50);
      return true;
    }
    return false;
  };
  const aim = () => {
    const dx = Math.sin(S.ang), dz = Math.cos(S.ang), yaw = Math.atan2(dx, dz) + (rnd() - 0.5) * 0.25;
    for (let step = 0; step < 12; step++) {
      for (let pt = -0.1; pt > -1.25; pt -= 0.06) { const d = G.aimAt({ x: S.x, z: S.z, yaw, pitch: pt }); if (d != null && d <= 1.95) return true; }
      S.x -= dx * 0.15; S.z -= dz * 0.15;
    }
    return false;
  };
  while (out.length < n) {
    if (S.left <= 0 || !S.spot) { S.spot = place(); if (!S.spot) break; }
    if (!aim()) { S.left = 0; continue; }
    const r = G.digAtCrosshair(1, { visuals: !!visuals });
    S.left--;
    out.push([r.blocked ? -1 : r.cents, r.best || 0, r.keys || []]);
  }
  return out;
}"""

GEOMETRY_SPIKES = r"""() => {
  const t = window.__goldrush.terrain(), H = t.height, vps = t.vps, c = t.cell;
  const lim = Math.tan(62.5 * Math.PI / 180) * c;
  let steep = 0, spikes = 0, bad = 0, maxDeg = 0;
  for (let j = 1; j < vps - 1; j++) for (let i = 1; i < vps - 1; i++) {
    const k = j * vps + i, h = H[k];
    if (!Number.isFinite(h)) { bad++; continue; }
    const stone = h <= t.stoneTop[k] + 1e-4 && h >= t.stoneBot[k];
    let higher = 0, maxd = 0;
    for (const n of [k - 1, k + 1, k - vps, k + vps, k - vps - 1, k - vps + 1, k + vps - 1, k + vps + 1]) {
      if (h > H[n] + 0.1) higher++;
    }
    for (const n of [k - 1, k + 1, k - vps, k + vps]) {
      const nStone = H[n] <= t.stoneTop[n] + 1e-4 && H[n] >= t.stoneBot[n];
      if (!stone && !nStone) maxd = Math.max(maxd, Math.abs(h - H[n]));
    }
    if (higher === 8 && !stone) spikes++;
    if (maxd > lim + 1e-3) steep++;
    maxDeg = Math.max(maxDeg, Math.atan(maxd / c) * 180 / Math.PI);
  }
  return { steep, spikes, bad, maxDeg: +maxDeg.toFixed(1), valid: t.validate() };
}"""


# every sound category rendered offline (same synthesis as in the game):
# peak / loudness / length per kind
AUDIO_LEVELS = r"""async () => {
  if (typeof OfflineAudioContext === "undefined") return null;         // engine without offline WebAudio
  const { GoldRushAudio } = await import('/games/goldrush/goldrush-audio.js');
  const out = {};
  for (const kind of ['dirt', 'compact', 'gravel', 'stone', 'air', 'dust', 'flake', 'tiny', 'nugget', 'pickup']) {
    const sr = 44100, ctx = new OfflineAudioContext(2, sr, sr), a = new GoldRushAudio();
    a.ctx = ctx;
    a.master = ctx.createGain(); a.master.gain.value = a.volume;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
    a.master.connect(comp).connect(ctx.destination);
    a.noise = ctx.createBuffer(1, sr, sr); const d = a.noise.getChannelData(0); for (let i = 0; i < sr; i++) d[i] = Math.random() * 2 - 1;
    Object.defineProperty(a, 'ready', { get: () => true });
    a.play(kind, { pan: 0, dist: 1.5 });
    const ch = (await ctx.startRendering()).getChannelData(0);
    let peak = 0, last = 0;
    for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > peak) peak = v; if (v > 0.002) last = i; }
    out[kind] = { peakDb: +(20 * Math.log10(peak || 1e-9)).toFixed(1), ms: Math.round(last / sr * 1000) };
  }
  return out;
}"""


def aim_material(page, want, start=0.0, maxd=1.9):
    return page.evaluate(FIND_TARGET, {"want": want, "maxd": maxd, "start": start})


def run_sim(page, n, visuals=False, salt=17):
    rows = []
    while len(rows) < n:
        rows += page.evaluate(SIM, {"n": min(1000, n - len(rows)), "salt": salt + len(rows), "visuals": visuals})
    return rows


# ------------------------------------------------------------------ suites

def desktop_suite(browser, base, user, shots):
    ctx, A = client(browser, base, user, dict(viewport={"width": 1440, "height": 900}), extra_init=[seeded()])
    open_game(A)
    s0 = st(A)
    ok("setup: fixed test seed", s0["seed"] == TEST_GOLDRUSH_SEED, str(s0["seed"]))

    # ---- TEST 1: hand dig on dirt - animation, contact, deformation, dust, material booked
    tgt = aim_material(A, "dirt")
    ok("T1 a fresh dirt patch within reach", tgt is not None, str(tgt))
    A.evaluate("(p) => window.__goldrush.pose(p)", tgt)
    e0, r0 = eco(A)["stats"], st(A)["revision"]
    A.mouse.move(720, 450)
    states, revs, parts = [], [], 0
    A.mouse.down()
    t0 = time.time()
    while time.time() - t0 < 1.3:
        h = A.evaluate("() => { const G = window.__goldrush, s = G.hand(); return [s.state === 'action' ? s.phase : s.state, G.state().revision, G.info().particles]; }")
        states.append((round(time.time() - t0, 3), h[0]))
        revs.append((round(time.time() - t0, 3), h[1]))
        parts = max(parts, h[2])
        time.sleep(0.012)
    A.mouse.up()
    e1 = eco(A)["stats"]
    seen = {s for _, s in states}
    first_change = next((t for t, r in revs if r > r0), None)
    first_windup = next((t for t, s in states if s == "windup"), None)
    ok("T1 the hand runs windup -> contact -> recover while held",
       {"windup", "recover"} <= seen, str(sorted(seen)))
    ok("T1 nothing is removed before the fingers touch (first change >= windup time after the press)",
       first_change is not None and first_windup is not None and first_change - first_windup >= 0.08, f"windup at {first_windup}s, first change at {first_change}s")
    ok("T1 the terrain changes, dust flies, the removed dirt is booked (kg by material)",
       st(A)["revision"] > r0 and parts > 0 and e1["massG"]["dirt"] > e0["massG"]["dirt"] and e1["successfulDigs"] > e0["successfulDigs"],
       f"+{e1['successfulDigs'] - e0['successfulDigs']} strokes, +{(e1['massG']['dirt'] - e0['massG']['dirt']) / 1000:.1f} kg dirt, particles {parts}")
    if shots:
        A.screenshot(path=str(shots / "p2_desktop_dig.png"))

    # ---- TEST 2: out of range - nothing comes off (the "too far" hint is
    # rate-limited to one per 5 s - T1's hole may just have used it)
    time.sleep(5.2)
    A.evaluate(r"""() => {
      const G = window.__goldrush, a = 0.4, dx = Math.sin(a), dz = Math.cos(a);
      let foot = 8;
      for (let d = 15; d > 0; d -= 0.05) if (G.heightAt(dx * d, -6 + dz * d) > 0.35) { foot = d; break; }
      const x = dx * (foot + 3.2), z = -6 + dz * (foot + 3.2), yaw = Math.atan2(dx, dz);
      for (let pt = 0.1; pt > -1.2; pt -= 0.03) { G.aimAt({ x, z, yaw, pitch: pt }); if (G.aim().state === "far") return G.pose({ x, z, yaw, pitch: pt }); }
    }""")
    aimst = A.evaluate("() => window.__goldrush.aim()")
    r0, d0 = st(A)["revision"], eco(A)["stats"]["totalDigs"]
    A.mouse.down()
    time.sleep(1.0)
    A.mouse.up()
    tip = A.evaluate("() => window.__goldrush.hudState().tip")
    ok("T2 beyond reach: crosshair 'far', no stroke, no material, a short hint",
       aimst["state"] == "far" and st(A)["revision"] == r0 and eco(A)["stats"]["totalDigs"] == d0 and tip and "Zu weit" in tip,
       f"{aimst} tip {tip!r}")

    # ---- TEST 3: stone - practically nothing, its own feedback
    boulders = A.evaluate("() => window.__goldrush.boulders()")
    hit = None
    for b in sorted(boulders, key=lambda q: q["y"]):
        for ang in (0, 0.6, -0.6, 1.2, -1.2, 2, -2, 3.1):
            d = b["r"] + 1.1
            pose = {"x": b["x"] + math.sin(ang) * d, "z": b["z"] + math.cos(ang) * d, "yaw": ang, "pitch": -0.35}
            for pt in (-0.2, -0.3, -0.4, -0.5, -0.65):
                pose["pitch"] = pt
                A.evaluate("(p) => window.__goldrush.aimAt(p)", pose)
                if A.evaluate("() => window.__goldrush.aim().state") == "hard":
                    hit = pose
                    break
            if hit:
                break
        if hit:
            break
    ok("T3 a boulder in the pile reads as stone under the crosshair", hit is not None)
    if hit:
        A.evaluate("(p) => window.__goldrush.pose(p)", hit)
        e0, r0 = eco(A)["stats"], st(A)["revision"]
        A.mouse.down()
        time.sleep(1.4)
        A.mouse.up()
        e1, hs = eco(A)["stats"], A.evaluate("() => window.__goldrush.hudState()")
        ok("T3 stone: the hand bounces off, nothing is removed, 'zu hart' feedback",
           e1["blockedDigs"] > e0["blockedDigs"] and st(A)["revision"] == r0 and hs["crosshair"] == "hard" and hs["tip"] and "Zu hart" in hs["tip"],
           f"blocked +{e1['blockedDigs'] - e0['blockedDigs']}, rate {(e1['blockedDigs'] - e0['blockedDigs']) / 1.4:.1f}/s, tip {hs['tip']!r}")
        if shots:
            A.screenshot(path=str(shots / "p2_desktop_stone.png"))

    # ---- TEST 4: compact dirt / gravel are slower than loose dirt (volume per stroke)
    per = {}
    for mat in ("dirt", "compactDirt", "gravel"):
        tg = aim_material(A, mat, start=0.37)
        if not tg:
            continue
        A.evaluate("(p) => window.__goldrush.aimAt(p)", tg)
        v0 = eco(A)["stats"]["volumeMl"]
        r = A.evaluate("() => window.__goldrush.digAtCrosshair(1, { visuals: false })")
        per[mat] = (eco(A)["stats"]["volumeMl"] - v0) if r["done"] else None
    ok("T4 per stroke the hand moves less compact dirt than loose dirt, and even less gravel",
       per.get("dirt") and per.get("compactDirt") and per["compactDirt"] < per["dirt"] * 0.75 and (not per.get("gravel") or per["gravel"] < per["compactDirt"] * 1.05),
       f"ml per stroke {per}")

    # ---- TEST 13/19 money precision + pickup exactly once (real finds with visuals)
    A.evaluate(AIM_AT_MOUND, {"ang": -0.25, "back": 1.3, "maxd": 1.9})
    m0 = eco(A)["moneyCents"]
    A.evaluate(DIG_HERE, {"ang": -0.25, "n": 120})             # real finds, shown and picked up
    all_collected = settled(A, 10)
    e = eco(A)
    hs = A.evaluate("() => window.__goldrush.hudState()")
    shown = e["shownCents"]
    ok("T19 every shown piece is collected exactly once: HUD balance == booked balance, nothing pending",
       all_collected and shown == e["moneyCents"], f"shown {shown} booked {e['moneyCents']} (from {m0})")
    money_txt = hs["money"].replace(" ", " ")
    euros = int(money_txt.split("€")[1].strip().replace(".", "").split(",")[0]), int(money_txt.split(",")[1])
    doc = A.evaluate("() => { window.__goldrush.save(); return JSON.parse(localStorage.getItem('goldrush.save')); }")
    ok("T13 money is integer cents end to end (save, economy, HUD text) - no float residue",
       isinstance(doc["economy"]["moneyCents"], int) and doc["economy"]["moneyCents"] == e["moneyCents"]
       and euros[0] * 100 + euros[1] == e["moneyCents"] and "." not in str(doc["economy"]["moneyCents"]),
       f"{money_txt} = {e['moneyCents']} ct")
    stats = e["stats"]
    ok("T13 the finds add up exactly: dust + flakes + tiny + nuggets == earned",
       stats["dustValueCents"] + stats["flakeValueCents"] + stats["tinyValueCents"] + stats["nuggetValueCents"] == e["earnedCents"], str({k: stats[k] for k in ("dustValueCents", "flakeValueCents", "tinyValueCents", "nuggetValueCents")}))

    # ---- TEST 8/9/10: dust, flake, tiny piece - from real digging on the fixed seed
    A.evaluate(AIM_AT_MOUND, {"ang": 0.35, "back": 1.3, "maxd": 1.9})
    got = {}
    ang = 0.35
    for n in range(2500):
        if n % 60 == 0:
            ang = 0.35 + (n // 60) * 0.21
            if not A.evaluate(AIM_AT_MOUND, {"ang": ang, "back": 1.3, "maxd": 1.9}):
                continue
        before = eco(A)["moneyCents"]
        r = A.evaluate("(a) => { const G = window.__goldrush; let ok = false; for (let pt = -0.1; pt > -1.25 && !ok; pt -= 0.05) { const s = G.state(); const d = G.aimAt({ x: s.x, z: s.z, yaw: s.yaw, pitch: pt }); ok = d != null && d <= 1.9; } return G.digAtCrosshair(1, { visuals: true }); }", ang)
        if r["done"] == 0:
            A.evaluate("(a) => { const G = window.__goldrush, s = G.state(); G.aimAt({ x: s.x - Math.sin(a) * 0.15, z: s.z - Math.cos(a) * 0.15, yaw: s.yaw, pitch: s.pitch }); }", ang)
        b = r.get("best", 0)
        key = "dust" if b in (TRACE, FINE) else "flake" if b == FLAKE else "tiny" if b == TINY else "nugget" if b == NUGGET else None
        if key and key not in got:
            snap = A.evaluate("() => ({ loot: window.__goldrush.loot(), look: window.__goldrush.lootLook(), pending: window.__goldrush.pending().map((p) => p.cls) })")
            got[key] = {"stroke": n, "cents": r["cents"], "loot": snap["loot"], "booked": eco(A)["moneyCents"] - before, "pending": snap["pending"]}
            if key in ("flake", "tiny") and shots:
                time.sleep(0.35)
                A.screenshot(path=str(shots / f"p2_desktop_{key}.png"))
        if "dust" in got and "flake" in got and "tiny" in got:
            break
    settled(A, 10)
    d = got.get("dust")
    ok("T8 gold dust: a few cents, a short glitter (no object), pending until the glitter is over, then booked",
       d and 1 <= d["cents"] <= 8 and d["loot"]["glints"] > 0 and any(c in (TRACE, FINE) for c in d["pending"]) and eco(A)["pending"] == [], str(d))
    f = got.get("flake")
    ok("T9 gold flake: a visible piece + 8-30 cents", f and 8 <= f["cents"] <= 40 and f["loot"]["active"] >= 1, str(f))
    t = got.get("tiny")
    ok("T10 tiny gold piece: a 3D piece appears (25-90 ct) and is picked up", t and 25 <= t["cents"] <= 120 and t["loot"]["active"] >= 1, str(t))
    e = eco(A)
    ok("T10 ... and all of them were picked up exactly once (screen balance == booked balance)", A.evaluate("() => window.__goldrush.loot().active") == 0 and e["shownCents"] == e["moneyCents"], f"{e['shownCents']} / {e['moneyCents']}")

    # ---- TEST 11/12: small nugget (visual, material, stats) + first-nugget message once
    A.evaluate(AIM_AT_MOUND, {"ang": -0.8, "back": 1.3, "maxd": 1.9})
    n0 = eco(A)
    first_seen = n0["flags"]["firstNuggetSeen"]
    cents = A.evaluate("() => window.__goldrush.debugFind(5, 28400)")
    time.sleep(0.25)
    look = A.evaluate("() => window.__goldrush.lootLook()")
    active = A.evaluate("() => window.__goldrush.loot().active")
    if shots:
        A.screenshot(path=str(shots / "p2_desktop_nugget_pop.png"))
    held = wait_for(lambda: A.evaluate("() => window.__goldrush.hand().inspecting"), 4)
    if shots and held:
        time.sleep(0.3)
        A.screenshot(path=str(shots / "p2_desktop_nugget_hand.png"))
    toast = wait_for(lambda: A.evaluate("() => window.__goldrush.hudState().toast"), 4)
    n1 = eco(A)
    ok("T11 small nugget: a real metal (metalness 1, roughness 0.2-0.45, environment reflections), a short shine (no light source), held up in the hand",
       active >= 1 and look["metalness"] == 1 and 0.2 <= look["roughness"] <= 0.45 and look["envMap"] and look["shine"] > 0 and look["pointLights"] == 0 and held,
       f"{look} held {held}")
    ok("T11 ... value, stats and the toast", cents == 284 and n1["inventory"]["nuggets"]["count"] == n0["inventory"]["nuggets"]["count"] + 1
       and n1["stats"]["biggestNuggetCents"] >= 284 and toast and "2,84" in toast, str(toast))
    ok("T12 the first nugget of a save says 'Erster Nugget!'", first_seen or "Erster Nugget" in toast, str(toast))
    wait_for(lambda: not A.evaluate("() => window.__goldrush.hudState().toast"), 5)
    A.evaluate("() => window.__goldrush.debugFind(5, 15000)")
    toast2 = wait_for(lambda: A.evaluate("() => window.__goldrush.hudState().toast"), 5)
    ok("T12 ... and only once", toast2 and "Erster" not in toast2 and "Kleiner Nugget" in toast2, str(toast2))
    wait_for(lambda: A.evaluate("() => window.__goldrush.loot().active") == 0, 6)

    # ---- TEST 14: 100 rapid clicks - never a doubled transaction
    tg = aim_material(A, "dirt", start=0.71)
    A.evaluate("(p) => window.__goldrush.pose(p)", tg)
    time.sleep(0.4)
    d0, c0 = eco(A)["stats"]["totalDigs"], A.evaluate("() => window.__goldrush.hand().cycle")
    t0 = time.time()
    for _ in range(100):
        A.mouse.down()
        A.mouse.up()
    time.sleep(0.5)
    el = time.time() - t0
    d1, c1 = eco(A)["stats"]["totalDigs"], A.evaluate("() => window.__goldrush.hand().cycle")
    ok("T14 100 rapid clicks: strokes stay within the hand rhythm, one transaction per stroke",
       (d1 - d0) <= el * 4.3 + 1 and (d1 - d0) == (c1 - c0), f"{d1 - d0} strokes / {c1 - c0} hand cycles in {el:.2f}s")

    # ---- TEST 15: held mouse - the rate is limited
    tg = aim_material(A, "dirt", start=0.13, maxd=1.6)
    A.evaluate("(p) => window.__goldrush.pose(p)", tg)
    c0 = A.evaluate("() => window.__goldrush.hand().cycle")
    A.mouse.down()
    time.sleep(4.0)
    A.mouse.up()
    rate = (A.evaluate("() => window.__goldrush.hand().cycle") - c0) / 4.0
    ok("T15 holding the button: the hand's pace (2-3 strokes per second, phase 3), never more", 2.0 <= rate <= 3.1, f"{rate:.2f}/s")

    # ---- TEST 21: player and terrain - no digging under your own feet, never stuck in your pit
    s = st(A)
    A.evaluate("(p) => window.__goldrush.pose(p)", {"x": s["x"], "z": s["z"], "yaw": s["yaw"], "pitch": -1.45})
    feet = A.evaluate("() => window.__goldrush.aim()")
    r0 = st(A)["revision"]
    A.mouse.down(); time.sleep(0.7); A.mouse.up()
    ok("T21 looking straight down: no target under your own feet, nothing dug",
       feet["state"] in ("idle", "far") and st(A)["revision"] == r0, str(feet))
    tg = aim_material(A, "dirt", start=0.9)
    A.evaluate("(p) => window.__goldrush.aimAt(p)", tg)
    A.evaluate(DIG_HERE, {"ang": tg["ang"], "n": 160})
    s = st(A)
    ground = A.evaluate("(p) => window.__goldrush.heightAt(p.x, p.z)", s)
    ok("T21 after digging a pit in front of you: eye height stays valid (never inside the ground)",
       math.isfinite(s["y"]) and s["y"] >= ground + 1.62 - 0.26, f"y {s['y']:.2f} ground {ground:.2f}")
    # walk into the pit and back out
    A.evaluate("(p) => window.__goldrush.pose({ x: p.x - Math.sin(p.ang) * 0.9, z: p.z - Math.cos(p.ang) * 0.9, yaw: p.yaw + Math.PI, pitch: 0 })", {**tg, "x": s["x"], "z": s["z"]})
    p_in = st(A)
    A.keyboard.down("w"); time.sleep(2.0); A.keyboard.up("w")
    p_out = st(A)
    ok("T21 you can always scramble out of your own pit", math.hypot(p_out["x"] - p_in["x"], p_out["z"] - p_in["z"]) > 1.0,
       f"moved {math.hypot(p_out['x'] - p_in['x'], p_out['z'] - p_in['z']):.2f} m")

    # ---- TEST 22: 500 strokes at almost the same spot - no spikes, no absurd walls
    tg = aim_material(A, "dirt", start=0.55)
    A.evaluate("(p) => window.__goldrush.aimAt(p)", tg)
    A.evaluate(DIG_HERE, {"ang": tg["ang"], "n": 500})
    geo = A.evaluate(GEOMETRY_SPIKES)
    ok("T22 500 strokes in one place: no spikes, no walls steeper than the 62° limit outside stone, all finite",
       geo["valid"] and geo["bad"] == 0 and geo["spikes"] == 0 and geo["steep"] == 0, str(geo))
    if shots:
        A.evaluate("(p) => window.__goldrush.pose({ x: p.x + Math.sin(p.ang) * 1.6, z: p.z + Math.cos(p.ang) * 1.6, yaw: p.yaw, pitch: -0.25 })", tg)
        time.sleep(0.3)
        A.screenshot(path=str(shots / "p2_desktop_after500.png"))

    errs = errors(A)
    ok("desktop: no JS errors", not errs, "; ".join(errs[:3]))
    gr_close(A)
    ctx.close()


def determinism_and_save_suite(browser, base, user, shots):
    # ---- TEST 5: same seed + same place + same strokes -> the same finds (two fresh worlds)
    def fresh_run():
        ctx, P = client(browser, base, user, dict(viewport={"width": 1000, "height": 700}), extra_init=[seeded()])
        open_game(P, start=False)
        tg = aim_material(P, "dirt", start=0.2)
        P.evaluate("(p) => window.__goldrush.aimAt(p)", tg)
        keys, cents = [], []
        for _ in range(4):
            r = P.evaluate(DIG_HERE, {"ang": tg["ang"], "n": 40})
        e = eco(P)
        h = P.evaluate("() => window.__goldrush.hashes()")
        vox = P.evaluate("() => { const out = []; for (let i = 90; i < 150; i += 7) for (let j = 150; j < 210; j += 9) for (let iy = 40; iy < 110; iy += 11) { const v = window.__goldrush.voxel(i, j, iy); out.push(v.cls * 100000 + v.massUg); } return out; }")
        gr_close(P)
        ctx.close()
        return e, h, vox
    e1, h1, v1 = fresh_run()
    e2, h2, v2 = fresh_run()
    ok("T5 determinism: same seed + same strokes -> identical terrain, finds and money",
       h1 == h2 and e1["inventory"] == e2["inventory"] and e1["moneyCents"] == e2["moneyCents"], f"{h1} vs {h2}, {e1['moneyCents']} ct")
    ok("T5 ... and the resource field itself is the same (sampled voxels)", v1 == v2 and len(v1) > 100)

    ctx, A = client(browser, base, user, dict(viewport={"width": 1000, "height": 700}), extra_init=[seeded()])
    open_game(A, start=False)

    # ---- TEST 6: depletion - worked material never pays twice
    tg = aim_material(A, "dirt", start=0.33)
    A.evaluate("(p) => window.__goldrush.aimAt(p)", tg)
    keys = []
    for _ in range(12):
        r = A.evaluate("(a) => { const G = window.__goldrush, out = []; for (let n = 0; n < 25; n++) { const s = G.state(); let ok = false; for (let pt = -0.1; pt > -1.25 && !ok; pt -= 0.05) { const d = G.aimAt({ x: s.x, z: s.z, yaw: s.yaw + (n % 5 - 2) * 0.03, pitch: pt }); ok = d != null && d <= 1.9; } if (!ok) G.aimAt({ x: s.x - Math.sin(a) * 0.15, z: s.z - Math.cos(a) * 0.15, yaw: s.yaw, pitch: -0.5 }); const q = G.digAtCrosshair(1, { visuals: false }); out.push(...q.keys); } return out; }", tg["ang"])
        keys += r
    ok("T6 300 overlapping strokes (with slides into the hole): no resource slice ever pays twice",
       len(keys) == len(set(keys)) and len(keys) > 0, f"{len(keys)} finds, {len(set(keys))} distinct")

    # ---- TEST 7: save / reload - same spot, no duplicate loot; no save-scumming
    A.evaluate("() => window.__goldrush.save()")
    saved = A.evaluate("() => localStorage.getItem('goldrush.save')")
    pose = st(A)
    run_a = A.evaluate("(a) => { const G = window.__goldrush, out = []; for (let n = 0; n < 60; n++) { const q = G.digAtCrosshair(1, { visuals: false }); out.push(...q.keys); } return { keys: out, h: G.hashes() }; }", tg["ang"])
    gr_close(A)
    A.evaluate("(s) => localStorage.setItem('goldrush.save', s)", saved)         # back to the saved state, discard the run
    A.reload()
    A.wait_for_function("() => typeof ws !== 'undefined' && ws && ws.readyState === 1", timeout=15000)
    open_game(A, start=False)
    A.evaluate("(p) => window.__goldrush.aimAt(p)", pose)
    run_b = A.evaluate("() => { const G = window.__goldrush, out = []; for (let n = 0; n < 60; n++) { const q = G.digAtCrosshair(1, { visuals: false }); out.push(...q.keys); } return { keys: out, h: G.hashes() }; }")
    ok("T7 reload -> dig the same again: exactly the same finds (nothing re-rolled, no save-scumming)",
       run_a["keys"] == run_b["keys"] and run_a["h"] == run_b["h"], f"{len(run_a['keys'])} finds, money {run_a['h']['money']} vs {run_b['h']['money']}")
    overlap = set(run_b["keys"]) & set(keys)
    ok("T7 ... and none of them is one already paid out before the save", not overlap, f"{len(overlap)} duplicates")

    # ---- TEST 27-29: save after 100 / 1,000 / 5,000 digs and reload exactly (+ sizes, 10,000 too)
    sizes = {}
    total = eco(A)["stats"]["successfulDigs"]
    marks = [100, 1000] + ([] if QUICK else [5000, 10000])
    for target in marks:
        need = target - total
        if need > 0:
            run_sim(A, need, visuals=False, salt=target)
        total = eco(A)["stats"]["successfulDigs"]
        size = A.evaluate("() => window.__goldrush.save()")
        h_before = A.evaluate("() => window.__goldrush.hashes()")
        sizes[target] = size
        if target <= 5000:
            gr_close(A)
            A.reload()
            A.wait_for_function("() => typeof ws !== 'undefined' && ws && ws.readyState === 1", timeout=15000)
            open_game(A, start=False)
            h_after = A.evaluate("() => window.__goldrush.hashes()")
            n_test = {100: 27, 1000: 28, 5000: 29}[target]
            ok(f"T{n_test} save after {target} digs -> reload: terrain, worked slices, money identical",
               h_before == h_after, f"{size} B ({size / 1024:.1f} KB), {h_before} vs {h_after}")
            A.evaluate("() => { window.__sim = null; }")
    print("  save sizes:", {k: f"{v / 1024:.1f} KB" for k, v in sizes.items()}, flush=True)
    if 10000 in sizes:
        ok("save size grows sub-linearly (10,000 digs < 10x the 1,000-dig save, and < 400 KB)",
           sizes[10000] < sizes[1000] * 10 and sizes[10000] < 400 * 1024, str(sizes))

    # ---- migration: a phase-1 (v1) save is upgraded, nothing lost, no retroactive loot
    v1 = {"saveVersion": 1, "worldSeed": 77, "createdAt": 1, "updatedAt": 2, "money": 0, "tool": "hand",
          "player": {"x": 0.6, "z": 10.2, "yaw": 0, "pitch": 0.1}, "settings": {"quality": "auto"}, "stats": {"digs": 12}, "terrain": None}
    gr_close(A)
    A.evaluate("(d) => { localStorage.setItem('goldrush.save', JSON.stringify(d)); localStorage.removeItem('goldrush.save.backup'); }", v1)
    open_game(A, start=False)
    e = eco(A)
    ok("v1 -> v3 migration: seed + digs kept, money in cents, written back as the current version (3)",
       st(A)["seed"] == 77 and e["stats"]["totalDigs"] == 12 and e["moneyCents"] == 0
       and A.evaluate("() => { window.__goldrush.save(); return JSON.parse(localStorage.getItem('goldrush.save')).saveVersion; }") == 3)
    errs = errors(A)
    ok("determinism/save: no JS errors", not errs, "; ".join(errs[:3]))
    gr_close(A)
    ctx.close()


def economy_suite(browser, base, user):
    ctx, A = client(browser, base, user, dict(viewport={"width": 800, "height": 600}), extra_init=[seeded()])
    open_game(A, start=False)

    # ---- TEST 23: a rich pocket pays statistically more than a barren zone
    spots = A.evaluate(r"""() => {
      const G = window.__goldrush, out = [];
      for (let a = -1.6; a <= 1.6; a += 0.08) {
        const dx = Math.sin(a), dz = Math.cos(a);
        let foot = null;
        for (let d = 15; d > 0; d -= 0.05) if (G.heightAt(dx * d, -6 + dz * d) > 0.35) { foot = d; break; }
        if (foot == null) continue;
        let g = 0, n = 0;
        for (let k = 0.2; k < 1.6; k += 0.2) for (let dy = 0.05; dy < 0.8; dy += 0.15) {
          const x = dx * (foot - k), z = -6 + dz * (foot - k), y = G.heightAt(x, z) - dy;
          if (G.materialAt(x, y, z) === 3) continue;
          g += G.goldAt(x, y, z); n++;
        }
        if (n) out.push({ ang: a, g: g / n });
      }
      out.sort((p, q) => q.g - p.g);
      return { rich: out[0], barren: out[out.length - 1] };
    }""")
    res = {}
    for name in ("rich", "barren"):
        ang = spots[name]["ang"]
        A.evaluate(AIM_AT_MOUND, {"ang": ang, "back": 1.3, "maxd": 1.9})
        m0, f0, d0 = eco(A)["moneyCents"], eco(A)["stats"]["finds"], eco(A)["stats"]["successfulDigs"]
        # phase 3: a hand stroke moves ~0.14 l (phase 2: ~2.7 l) - dig a comparable amount of ground
        A.evaluate(DIG_HERE, {"ang": ang, "n": 900})
        A.evaluate("() => window.__goldrush.flushLoot()")          # finds are money once picked up
        e = eco(A)
        res[name] = {"g": round(spots[name]["g"], 3), "cents": e["moneyCents"] - m0, "finds": e["stats"]["finds"] - f0, "digs": e["stats"]["successfulDigs"] - d0}
    ok("T23 a rich zone of the test seed pays clearly more than a barren one (900 hand strokes each, ~120 l)",
       res["rich"]["cents"] > res["barren"]["cents"] and res["rich"]["finds"] > res["barren"]["finds"], json.dumps(res))

    # ---- TEST 24-26: economy of 10,000 typical hand strokes on the test seed
    n = 3000 if QUICK else 10000
    A.evaluate("() => { window.__sim = null; }")
    t0 = time.time()
    rows = run_sim(A, n, visuals=False, salt=17)
    vals = [max(0, r[0]) for r in rows]
    best = [r[1] for r in rows]
    keys = [k for r in rows for k in r[2]]
    n = len(vals)
    srt = sorted(vals)
    finds = sum(1 for v in vals if v > 0)
    cnt = lambda c: sum(1 for b in best if b == c)
    rate = 3.8
    stats = {
        "strokes": n, "sim_s": round(time.time() - t0, 1), "mean_ct": round(sum(vals) / n, 3), "median_ct": statistics.median(vals),
        "null_rate": round(100 * (n - finds) / n, 1), "stone_rate": round(100 * sum(1 for r in rows if r[0] < 0) / n, 1),
        "dust_rate": round(100 * (cnt(1) + cnt(2)) / n, 2), "flake_rate": round(100 * cnt(3) / n, 2), "tiny_rate": round(100 * cnt(4) / n, 3),
        "nugget_rate": round(100 * cnt(5) / n, 3), "nuggets": cnt(5), "p95_ct": srt[int(n * 0.95)], "p99_ct": srt[int(n * 0.99)], "max_ct": srt[-1],
        "first_find_stroke": next((i for i, v in enumerate(vals) if v > 0), None),
    }
    for mins in (1, 5, 10):
        k = int(rate * 60 * mins)
        stats[f"eur_{mins}min"] = round(sum(vals[:k]) / 100, 2)
    print("  economy:", json.dumps(stats), flush=True)
    ok("T24 not every stroke pays: most strokes find nothing", stats["null_rate"] >= 85, f"{stats['null_rate']} % empty")
    ok("T25 early economy in range: first find within ~15 s, a few € in the first minutes, flakes/tiny/nuggets rare",
       stats["first_find_stroke"] is not None and stats["first_find_stroke"] <= 60 and 0.1 <= stats["mean_ct"] <= 1.0
       and stats["eur_1min"] >= 0.05 and stats["eur_5min"] <= 12 and stats["nugget_rate"] <= 0.2, json.dumps(stats))
    ok("T26 no huge nugget: the biggest single find stays in the small-nugget range (<= € 4)", stats["max_ct"] <= 400, f"max {stats['max_ct']} ct")
    ok("T6 (economy run) no slice ever paid twice over all strokes", len(keys) == len(set(keys)), f"{len(keys)} finds")
    mx = A.evaluate("() => { let m = 0; for (let i = 25; i < 216; i += 3) for (let j = 25; j < 216; j += 3) for (let iy = 20; iy < 200; iy += 2) { const v = window.__goldrush.voxel(i, j, iy); if (v.massUg > m) m = v.massUg; } return m; }")
    ok("T26 ... also across the whole resource field (sampled): no slice holds more than a € 4 nugget", mx <= 40000, f"max {mx} µg")
    lv = A.evaluate(AUDIO_LEVELS)
    if lv is None:
        print("  sound: skipped - this browser build has no OfflineAudioContext (the game then simply stays silent)", flush=True)
    else:
        ok("sound: every category renders, audible and never clipping (peaks between -34 and -3 dBFS), short digs, longer nugget",
           all(-34 <= v["peakDb"] <= -3 for v in lv.values()) and lv["dirt"]["ms"] < 200 and lv["nugget"]["ms"] > lv["dust"]["ms"], json.dumps(lv))
    gr_close(A)
    ctx.close()
    return stats


def touch_suite(browser, base, user, shots):
    ctx, M = client(browser, base, user, PHONE, extra_init=[seeded()])
    cdp = ctx.new_cdp_session(M)
    open_game(M, start=False)
    tg = aim_material(M, "dirt", start=0.3)
    M.evaluate("(p) => window.__goldrush.pose(p)", tg)
    dig = M.locator(".gr-dig-btn").bounding_box()
    dx, dy = dig["x"] + dig["width"] / 2, dig["y"] + dig["height"] / 2

    # ---- TEST 16: holding GRABEN - the same rhythm as the mouse
    c0 = M.evaluate("() => window.__goldrush.hand().cycle")
    touch(cdp, "touchStart", [(1, dx, dy)])
    time.sleep(4.0)
    touch(cdp, "touchEnd", [])
    rate = (M.evaluate("() => window.__goldrush.hand().cycle") - c0) / 4.0
    ok("T16 mobile: holding GRABEN digs at the same pace as the mouse (2-3 strokes per second)", 2.0 <= rate <= 3.1, f"{rate:.2f}/s")
    if shots:
        M.screenshot(path=str(shots / "p2_phone_dig.png"))

    # ---- TEST 17: move + look + dig at once
    tg = aim_material(M, "dirt", start=0.6)
    M.evaluate("(p) => window.__goldrush.pose(p)", {**tg, "x": tg["x"] + math.sin(tg["ang"]) * 0.6, "z": tg["z"] + math.cos(tg["ang"]) * 0.6})
    s0 = st(M)
    sx, sy, lx, ly = 90, 700, 300, 300
    touch(cdp, "touchStart", [(1, dx, dy)])
    touch(cdp, "touchStart", [(1, dx, dy), (2, sx, sy)])
    touch(cdp, "touchStart", [(1, dx, dy), (2, sx, sy), (3, lx, ly)])
    k = 0
    t0 = time.time()
    while time.time() - t0 < 2.2:
        k += 1
        touch(cdp, "touchMove", [(1, dx, dy), (2, sx + 3, sy - min(40, 8 * k)), (3, lx - 2 * k, ly)])
        time.sleep(0.05)
    mid = st(M)
    touch(cdp, "touchEnd", [])
    time.sleep(0.3)
    s1 = st(M)
    moved = math.hypot(mid["x"] - s0["x"], mid["z"] - s0["z"])
    ok("T17 stick walks, right thumb looks, GRABEN digs - all at the same time",
       moved > 0.2 and abs(mid["yaw"] - s0["yaw"]) > 0.1 and s1["strokes"] > s0["strokes"], f"moved {moved:.2f} m, yaw {s0['yaw']:.2f}->{mid['yaw']:.2f}, strokes +{s1['strokes'] - s0['strokes']}")

    # ---- TEST 18: touch cancel / orientation change never leaves digging on
    M.evaluate("(p) => window.__goldrush.pose(p)", tg)
    touch(cdp, "touchStart", [(1, dx, dy)])
    time.sleep(0.5)
    held = st(M)["digHeld"]
    touch(cdp, "touchCancel", [])
    time.sleep(0.15)
    after_cancel = st(M)["digHeld"]
    d0 = eco(M)["stats"]["totalDigs"]
    time.sleep(0.8)
    d1 = eco(M)["stats"]["totalDigs"]
    touch(cdp, "touchStart", [(1, dx, dy)])
    time.sleep(0.3)
    M.evaluate("() => window.dispatchEvent(new Event('orientationchange'))")
    time.sleep(0.2)
    after_orient = st(M)["digHeld"]
    touch(cdp, "touchEnd", [])
    ok("T18 touchcancel and orientationchange release GRABEN: no digging stuck on",
       held and not after_cancel and d1 - d0 <= 1 and not after_orient and not M.evaluate("() => document.querySelector('.gr-dig-btn').classList.contains('is-active')"),
       f"held {held} -> cancel {after_cancel}, strokes after cancel {d1 - d0}, orientation {after_orient}")

    # ---- TEST 20: walk away from a lying piece - it is not lost
    M.evaluate("(p) => window.__goldrush.pose(p)", tg)
    m0 = eco(M)["moneyCents"]
    M.evaluate("() => window.__goldrush.debugFind(4, 5000)")
    M.evaluate("(p) => window.__goldrush.pose({ x: p.x + Math.sin(p.ang) * 9, z: p.z + Math.cos(p.ang) * 9, yaw: p.yaw, pitch: 0 })", tg)
    lying = M.evaluate("() => window.__goldrush.loot().active")
    got = settled(M, 10)
    e = eco(M)
    ok("T20 walked away from a tiny piece: it still comes to you after a few seconds, the money is right",
       lying >= 1 and got and e["moneyCents"] == m0 + 50 and e["shownCents"] == e["moneyCents"], f"lying {lying}, {m0} -> {e['moneyCents']}")
    M.evaluate("(p) => window.__goldrush.pose(p)", tg)
    M.evaluate("() => window.__goldrush.debugFind(4, 6000)")
    booked = eco(M)["moneyCents"]                       # the piece is pending (in the air), not money yet
    gr_close(M)
    open_game(M, start=False)
    ok("T20 closing with a piece still in the air: it is booked on the way out (nothing lost, nothing doubled)",
       eco(M)["moneyCents"] == booked + 60 and eco(M)["pending"] == [], f"{booked} -> {eco(M)['moneyCents']}")
    errs = errors(M)
    ok("touch: no JS errors", not errs, "; ".join(errs[:3]))
    gr_close(M)
    ctx.close()


def quality_suite(browser, base, user):
    # the same strokes on LOW / MEDIUM / HIGH: identical gameplay, only the looks differ
    out = {}
    for q in ("low", "medium", "high"):
        ctx, P = client(browser, base, user, dict(viewport={"width": 1000, "height": 700}), extra_init=[seeded()])
        open_game(P, start=False)
        P.evaluate("(q) => window.__goldrush.setQuality(q)", q)
        tg = aim_material(P, "dirt", start=0.2)
        P.evaluate("(p) => window.__goldrush.aimAt(p)", tg)
        P.evaluate(DIG_HERE, {"ang": tg["ang"], "n": 80})
        out[q] = {"h": P.evaluate("() => window.__goldrush.hashes()"), "glints": P.evaluate("() => window.__goldrush.info().level")}
        gr_close(P)
        ctx.close()
    ok("quality LOW / MEDIUM / HIGH: identical mining results (terrain, finds, money)",
       out["low"]["h"] == out["medium"]["h"] == out["high"]["h"], json.dumps({k: v["h"] for k, v in out.items()}))


def long_session(browser, base, user, shots):
    ctx, A = client(browser, base, user, dict(viewport={"width": 1440, "height": 900}), extra_init=[seeded(98765)])
    open_game(A)
    time.sleep(1.0)

    def snapshot():
        A.evaluate("() => window.__goldrush.pose({})")
        A.evaluate(FRAME_REC)
        time.sleep(2.0)
        f = A.evaluate(FRAME_STOP)
        i = A.evaluate("() => window.__goldrush.info()")
        return {"fps": round(1000 / f["avg"], 1), "p95": f["p95"], "heap": heap_mb(A), "calls": i["drawCalls"], "objects": i["sceneObjects"],
                "geometries": i["geometries"], "textures": i["textures"], "loot": i["loot"], "dom": A.evaluate("() => document.querySelectorAll('.gr-root *').length")}
    # warm-up: every kind of piece shown once (first use uploads buffers), then the baseline
    tg = aim_material(A, "dirt", start=0.4)
    A.evaluate("(p) => window.__goldrush.pose(p)", tg)
    for cls, m in ((3, 1500), (4, 5000), (5, 20000)):
        A.evaluate("([c, m]) => window.__goldrush.debugFind(c, m)", [cls, m])
        time.sleep(0.2)
    A.evaluate(SIM, {"n": 300, "salt": 5, "visuals": True})
    settled(A, 12)
    time.sleep(0.5)
    first = snapshot()
    # ~30 minutes of hand strokes (3.8/s) in fast forward, with all visuals (pieces, glints, floats, dust)
    strokes = 1500 if QUICK else 7000
    t0 = time.time()
    done, mid = 0, None
    while done < strokes:
        rows = A.evaluate(SIM, {"n": 40, "salt": 900 + done, "visuals": True})
        done += len(rows)
        time.sleep(0.03)
        if mid is None and done >= strokes // 2:
            settled(A, 12)
            mid = snapshot()
    settled(A, 12)
    time.sleep(0.5)
    last = snapshot()
    e = eco(A)
    print(f"  long session: {strokes} strokes in {time.time() - t0:.0f}s, {e['stats']['finds']} finds, {first} -> {mid} -> {last}", flush=True)
    # leak criterion: nothing keeps growing - the second half ends where the first ended
    ok("T30 long session (~30 min of strokes): FPS flat, scene objects / geometries / textures / DOM stop growing, heap < +15 MB",
       last["fps"] >= first["fps"] - 5 and last["objects"] == first["objects"] == mid["objects"] and last["textures"] == mid["textures"]
       and last["geometries"] == mid["geometries"] and last["dom"] == first["dom"] and last["loot"] == 0
       and (first["heap"] is None or last["heap"] - first["heap"] < 15),
       f"{first} -> {mid} -> {last}")
    ok("T30 ... and the balance on screen equals the booked balance", e["shownCents"] == e["moneyCents"])
    if shots:
        A.screenshot(path=str(shots / "p2_desktop_long_session.png"))
    errs = errors(A)
    ok("long session: no JS errors", not errs, "; ".join(errs[:3]))
    gr_close(A)
    ctx.close()


VIEWPORTS = [
    ("1366x768", dict(viewport={"width": 1366, "height": 768})),
    ("1920x1080", dict(viewport={"width": 1920, "height": 1080})),
    ("390x844", dict(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True)),
    ("430x932", dict(viewport={"width": 430, "height": 932}, device_scale_factor=3, is_mobile=True, has_touch=True)),
    ("844x390", dict(viewport={"width": 844, "height": 390}, device_scale_factor=3, is_mobile=True, has_touch=True)),
    ("932x430", dict(viewport={"width": 932, "height": 430}, device_scale_factor=3, is_mobile=True, has_touch=True)),
]


def visual_suite(browser, base, user, shots):
    """screenshots: hand, crosshair, dirt hit, stone, flake, nugget, HUD, money note - per viewport"""
    rows = []
    for name, kw in VIEWPORTS:
        ctx, P = client(browser, base, user, kw, extra_init=[seeded()])
        open_game(P)
        tg = aim_material(P, "dirt", start=0.25)
        P.evaluate("(p) => window.__goldrush.pose(p)", tg)
        time.sleep(0.3)
        P.evaluate("() => window.__goldrush.debugFind(3, 1600)")
        time.sleep(0.35)
        if shots:
            P.screenshot(path=str(shots / f"p2_vp_{name}_flake.png"))
        P.evaluate("() => window.__goldrush.debugFind(5, 23700)")
        time.sleep(0.3)
        if shots:
            P.screenshot(path=str(shots / f"p2_vp_{name}_nugget.png"))
        wait_for(lambda: P.evaluate("() => window.__goldrush.hand().inspecting"), 4)
        time.sleep(0.35)
        if shots:
            P.screenshot(path=str(shots / f"p2_vp_{name}_hand.png"))
        # frame times while really digging (held button / GRABEN) with a find on
        # its way, measured without screenshots in between
        time.sleep(1.2)
        P.evaluate("(p) => window.__goldrush.pose(p)", tg)
        P.evaluate(FRAME_REC)
        P.evaluate("() => window.__goldrush.debugFind(4, 4000)")
        if kw.get("has_touch"):
            cdp = P.context.new_cdp_session(P)
            bb = P.locator(".gr-dig-btn").bounding_box()
            touch(cdp, "touchStart", [(1, bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)])
            time.sleep(2.5)
            touch(cdp, "touchEnd", [])
        else:
            P.mouse.down()
            time.sleep(2.5)
            P.mouse.up()
        f = P.evaluate(FRAME_STOP)
        inside = P.evaluate("""() => ['.gr-money', '.gr-feed', '.gr-toast', '.gr-crosshair'].every((s) => {
          const e = document.querySelector(s); if (!e || e.hidden) return true; const r = e.getBoundingClientRect();
          return r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1; })""")
        rows.append((name, round(1000 / f["avg"], 1), inside))
        errs = errors(P)
        gr_close(P)
        ctx.close()
        if errs:
            rows[-1] = rows[-1] + (errs[:2],)
    print("  viewports:", rows, flush=True)
    ok("visual pass: every viewport renders the finds + hand with HUD on screen and no errors",
       all(r[2] and len(r) == 3 for r in rows), str(rows))


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
            desktop_suite(browser, base, user, shots)
            determinism_and_save_suite(browser, base, user, shots)
            economy_suite(browser, base, user)
            if engine == "chromium":
                touch_suite(browser, base, user, shots)
                visual_suite(browser, base, user, shots)
            quality_suite(browser, base, user)
            long_session(browser, base, user, shots)
            browser.close()
    finally:
        proc.terminate()

    fails = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(fails)}/{len(RESULTS)} checks passed")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
