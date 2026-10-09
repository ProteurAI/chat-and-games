"""End-to-end check of GoldRush phase 6: primitive mechanisation and the dig feel.

  core dig feel   particle layers per material and tool, pools, reduced motion,
                  quality = visual density only, 10,000 impacts, sounds, the
                  visual-only trickle
  wheelbarrow     tests W1-W14 (buy, save, load, conservation, capacity, push,
                  mass, deformed ground, park, reload, dump, no duplicate, new
                  mine, developer snapshot)
  sluice          tests S1-S19 (install, bucket / barrow input, hopper, water,
                  throughput, gold + tailings conservation, determinism, runs
                  while you walk away, no offline progress, clean out, heavy
                  concentrate -> pan, save / reload mid-process, upgrades, phone)
  plus save v6 migration, the phase-6 developer pack and preset, performance,
  long runs, the phase-6 economy (benchmark, strategies A6-D6, 360 min).

Runs the server from temp copies (the real database is never touched).

    python tests/e2e/goldrush_mech_e2e.py [--shots DIR] [--quick] [--full-bench] [--no-bench] [--browser webkit]

    --quick       3 seeds per strategy (default 6), shorter long runs
    --full-bench  100 seeds x 360 min per strategy (the canonical numbers; hours)
    --only        a comma list of parts: dig,barrow,sluice,save,mobile,dev,perf,bench
"""

import json
import tempfile
import math
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from goldrush_bench import run_seed as bench_seed, summarize4  # noqa: E402
from goldrush_e2e import GPU_ARGS, PHONE, client, errors, gr_close, gr_open, gr_pause, gr_ready, gr_start, heap_mb, wait_for  # noqa: E402
from goldrush_tools_e2e import AUDIO_LEVELS, SPOT, open_game, seeded  # noqa: E402
from goldrush_process_e2e import drag  # noqa: E402
import goldrush_dev_e2e as DEV  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

QUICK = "--quick" in sys.argv
FULL = "--full-bench" in sys.argv
ONLY = set(sys.argv[sys.argv.index("--only") + 1].split(",")) if "--only" in sys.argv else None
RESULTS = []
GR = "window.__goldrush"
PHASE5 = ["shovel", "pickaxe", "shovel.blade", "shovel.handle", "pickaxe.tip", "pickaxe.head", "bucket", "pan", "classifier", "pan.riffles", "bucket.large"]
SLUICE_AT = (-20.55, -2.1)
FEED = (-20.82, -1.12)
CLEAN = (-19.2, -1.26)
HOPPER = (SLUICE_AT[0] - 0.27, SLUICE_AT[1])
DEVBATCH = "async ([kind, ml]) => { const m = await import('/games/goldrush/goldrush-devactions.js'); return m.devBatch(kind, ml); }"


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def G(page, js, arg=None):
    return page.evaluate(js, arg) if arg is not None else page.evaluate(js)


def shot(page, shots, name):
    if shots:
        page.screenshot(path=str(shots / f"gr6_{name}.png"))


def proc(page):
    return G(page, f"() => {GR}.proc()")


def eco(page):
    return G(page, f"() => {GR}.economy()")


def ledger_ok(page):
    p = proc(page)
    L = p["ledger"]
    return L["inUg"] == p["inContainersUg"] + L["recoveredUg"] + L["tailUg"] and L["inG"] == p["inContainersG"] + L["tailG"], L, p


def fresh(page, seed=4242):
    gr_close(page)
    page.evaluate("(s) => { for (const k of [grKey(), grKey('.backup'), grKey('.corrupt'), grKey('.prev'), grKey('.devSnapshot')]) localStorage.removeItem(k); localStorage.setItem('goldrush.testSeed', String(s)); }", seed)
    open_game(page)


def kit(page, items=PHASE5 + ["wheelbarrow", "sluice"], cash=2000000):
    G(page, f"(ids) => {{ const g = {GR}; g.setCash({cash}); for (const id of ids) g.buy(id); g.equipNow('shovel'); g.setCash(0); }}", items)


def use(page):
    """[E] here and now: the station from the player's current pose, then use it"""
    G(page, f"() => {GR}.stationNow()")
    return G(page, f"() => {GR}.useStation()")


def cleanout(page):
    """water off, brush the riffles out (the game's work at full pace): mat empty, the concentrate in the tray"""
    G(page, f"() => {GR}.procWater(false)")
    r = G(page, f"() => {GR}.procAct('sluice-clean')")
    return G(page, f"() => {GR}.procWork(10)") if r and r.get("ok") else None


def install(page):
    G(page, f"() => {GR}.procInstallSluice()")


def hopper_batch(page, kind, ml):
    """a deterministic test batch straight into the hopper (booked as test input)"""
    return G(page, f"""async ([kind, ml]) => {{ const m = await import('/games/goldrush/goldrush-devactions.js'); const pr = {GR}.procObj();
      return pr.devSetHopper(ml ? m.devBatch(kind, ml) : null); }}""", [kind, ml])


def barrow_batch(page, kind, ml):
    return G(page, f"""async ([kind, ml]) => {{ const m = await import('/games/goldrush/goldrush-devactions.js'); const pr = {GR}.procObj();
      return pr.devSetBarrow(ml ? m.devBatch(kind, ml) : null); }}""", [kind, ml])


def dig_spot(page, start=0.3, want="dirt"):
    return G(page, SPOT, {"want": want, "reach": 2.0, "start": start, "fresh": True})


def park_beside(page, sp):
    """the barrow parked beside the player at a dig spot, its tray within reach"""
    G(page, f"""(s) => {{ const g = {GR}; g.pose(s); const st = g.state(), rx = Math.cos(st.yaw), rz = -Math.sin(st.yaw), fx = -Math.sin(st.yaw), fz = -Math.cos(st.yaw);
      const tx = st.x + rx * 1.15 - fx * 0.2, tz = st.z + rz * 1.15 - fz * 0.2; return g.procBarrowPlace(tx + fx * 0.61, tz + fz * 0.61, st.yaw); }}""", sp)


def scoop(page, sp):
    return G(page, f"(s) => {{ {GR}.aimAt(s); return {GR}.act({{ visuals: !!s.visuals }}); }}", sp)


def take_barrow(page):
    """stand behind the barrow's grips (facing its way) and take it"""
    b = proc(page)["barrow"]
    G(page, f"(b) => {GR}.pose({{ x: b.x + Math.sin(b.yaw) * 2.15, z: b.z + Math.cos(b.yaw) * 2.15, yaw: b.yaw, pitch: -0.3 }})", b)
    return G(page, f"() => {GR}.procAct('barrow-take')")


# ======================================================================
# CORE DIG FEEL
# ======================================================================

def set_reduced(page, on):
    page.evaluate("(on) => { const e = document.querySelector('[data-role=reduced]'); e.checked = on; e.dispatchEvent(new Event('change', { bubbles: true })); }", on)
    return G(page, f"() => {GR}.state().reducedMotion")


def dig_feel(A, shots):
    fresh(A)
    G(A, f"() => {{ const g = {GR}; g.grant('shovel'); g.grant('pickaxe'); }}")
    sp = dig_spot(A, 0.3)
    G(A, f"(s) => {GR}.pose(s)", sp)
    # profiles: one pickaxe hit per material from a clear state
    prof = {}
    for mat, name in enumerate(["dirt", "compact", "gravel", "stone"]):
        G(A, f"() => {GR}.fxClear()")
        s0 = G(A, f"(m) => {GR}.fxImpact(m, 'pickaxe', 1, 0)", mat)
        s1 = G(A, f"() => {GR}.fxUpdate(0.9)")
        prof[name] = {"dust": s0["dust"], "debris": s0["debris"], "chunks": s0["chunks"], "flat": s0["flat"], "bounced": s1["bounced"], "size": round(s0["sizeDebris"], 4)}
    ok("dig feel: four material profiles - dirt the most dust, compact the most heavy clods, gravel the most pebbles (they click and bounce), stone flat sharp chips and hardly any dust",
       prof["dirt"]["dust"] > prof["compact"]["dust"] > prof["stone"]["dust"] and prof["gravel"]["dust"] < prof["dirt"]["dust"]
       and prof["compact"]["chunks"] > prof["dirt"]["chunks"] and prof["gravel"]["debris"] > prof["dirt"]["debris"] and prof["gravel"]["bounced"] > prof["dirt"]["bounced"]
       and prof["stone"]["flat"] >= prof["stone"]["debris"] and prof["dirt"]["flat"] == 0, json.dumps(prof))
    # tools: same material, a different identity
    tools = {}
    for tool in ("hand", "shovel", "pickaxe"):
        G(A, f"() => {GR}.fxClear()")
        st = G(A, f"(t) => {GR}.fxImpact(0, t, 1, 0)", tool)
        tools[tool] = {"n": st["dust"] + st["debris"] + st["chunks"], "speed": round(st["speed"], 2), "chunks": st["chunks"]}
    ok("dig feel: the tools differ beyond throughput - the shovel throws the most (a wide scoop), the pickaxe the fastest pieces (a sharp strike), the hand a few crumbs",
       tools["shovel"]["n"] > tools["pickaxe"]["n"] > tools["hand"]["n"] and tools["pickaxe"]["speed"] > tools["shovel"]["speed"] > tools["hand"]["speed"], json.dumps(tools))
    # micro debris lies a while, then it is gone
    G(A, f"() => {GR}.fxClear()")
    G(A, f"() => {GR}.fxImpact(2, 'shovel', 1, 0)")
    lying = G(A, f"() => {GR}.fxUpdate(2.0)")["lying"]
    gone = G(A, f"() => {GR}.fxUpdate(13)")
    ok("micro debris: pieces lie on the ground for a few seconds, then sink away (nothing stays)", lying > 0 and gone["debris"] + gone["chunks"] + gone["lying"] == 0, f"lying {lying} -> {gone}")
    # quality: the density only
    dens = {}
    for q in ("low", "medium", "high"):
        G(A, f"(q) => {GR}.setQuality(q)", q)
        G(A, f"() => {GR}.fxClear()")
        st = G(A, f"() => {GR}.fxImpact(0, 'shovel', 1, 0)")
        dens[q] = st["dust"] + st["debris"] + st["chunks"]
    runs = {}
    for q in ("low", "high"):
        fresh(A)
        G(A, f"(q) => {{ {GR}.grant('shovel'); {GR}.equipNow('shovel'); {GR}.setQuality(q); }}", q)
        sp = dig_spot(A, 0.31)
        runs[q] = [(round(x["massKg"], 6), x["finds"]) for x in (scoop(A, dict(sp, visuals=True)) for _ in range(6)) if x]
    G(A, f"() => {GR}.setQuality('medium')")
    ok("quality levels change only the visual density (LOW < MEDIUM < HIGH pieces) - the same digs take exactly the same material and finds",
       dens["low"] < dens["medium"] < dens["high"] and runs["low"] == runs["high"] and len(runs["low"]) == 6, f"{dens} same={runs['low'] == runs['high']}")
    # an impulse on contact; reduced motion: none
    G(A, f"() => {{ {GR}.grant('pickaxe'); {GR}.equipNow('pickaxe'); }}")
    sp = dig_spot(A, 0.35)
    G(A, f"(s) => {GR}.pose(s)", sp)
    on = G(A, f"() => {GR}.contact()")
    rm = set_reduced(A, True)
    G(A, f"(s) => {GR}.pose(s)", sp)
    off = G(A, f"() => {GR}.contact()")
    set_reduced(A, False)
    ok("impact feel: a subtle camera impulse + tool recoil per hit; with reduced motion both are off", on["kick"] > 0 and on["kick"] <= 0.03 and on["shake"] > 0 and rm and off["kick"] == 0 and off["shake"] == 0,
       f"on {on['kick']:.4f}/{on['shake']:.3f}, reduced {off['kick']}/{off['shake']}")
    # 10,000 impacts: the pools never grow, nothing leaks
    G(A, f"() => {GR}.fxClear()")
    G(A, f"() => {GR}.fxImpact(0, 'shovel', 50, 1 / 60)")
    G(A, f"() => {GR}.fxUpdate(14)")
    time.sleep(0.3)
    i0 = G(A, f"() => {GR}.info()")
    h0 = heap_mb(A)
    peak = {"dust": 0, "frags": 0}
    for k in range(20):
        G(A, f"(k) => {GR}.fxImpact(k % 4, ['hand', 'shovel', 'pickaxe'][k % 3], 500, 1 / 60)", k)
        f = G(A, f"() => {GR}.fxStats()")
        peak["dust"] = max(peak["dust"], f["dust"])
        peak["frags"] = max(peak["frags"], f["debris"] + f["chunks"] + f["trickle"])
    pools = G(A, f"() => {GR}.fxStats().pools")
    G(A, f"() => {GR}.fxUpdate(14)")
    G(A, f"(s) => {GR}.pose(s)", sp)
    time.sleep(0.3)
    i1 = G(A, f"() => {GR}.info()")
    h1 = heap_mb(A)
    ok("10,000 impacts: the pools never exceed their fixed size, no geometry / texture / object / heap growth", peak["dust"] <= pools["dust"] and peak["frags"] <= pools["frags"]
       and i1["geometries"] == i0["geometries"] and i1["textures"] == i0["textures"] and i1["sceneObjects"] == i0["sceneObjects"] and (h0 is None or h1 - h0 < 8),
       f"peak {peak} of {pools['dust']}/{pools['frags']}, geo {i0['geometries']}->{i1['geometries']}, heap {h0}->{h1}")
    # trickle after a steep fresh cut: visual only
    fresh(A)
    G(A, f"() => {{ {GR}.grant('shovel'); {GR}.equipNow('shovel'); }}")
    sp = dig_spot(A, 0.5)
    tr0 = G(A, f"() => {GR}.fxStats().trickles")
    n = 0
    for n in range(1, 61):
        G(A, f"(s) => {GR}.aimAt(s)", sp)
        G(A, f"() => {GR}.contact()")
        if G(A, f"() => {GR}.fxUpdate(0.05).trickle") > 0 or G(A, f"() => {GR}.fxStats().trickles") > tr0:
            break
    G(A, f"() => {GR}.fxUpdate(1.0)")
    G(A, f"() => {GR}.flushLoot()")                      # finds still flying to the pouch would land during the window
    h_before = G(A, f"() => [{GR}.hashes(), {GR}.economy().earnedCents, {GR}.state().revision, {GR}.volume().delta]")
    G(A, f"() => {GR}.fxUpdate(3)")
    h_after = G(A, f"() => [{GR}.hashes(), {GR}.economy().earnedCents, {GR}.state().revision, {GR}.volume().delta]")
    tr1 = G(A, f"() => {GR}.fxStats().trickles")
    ok("a fresh steep cut trickles a moment later - visual only: the ground, the mass and the gold stay untouched", tr1 > tr0 and h_before == h_after, f"trickles {tr0} -> {tr1} after {n} contacts")
    # sounds: every new kind audible, none clipping (the worst of several renders)
    kinds = ["hand_dirt", "hand_gravel", "shovel_dirt", "shovel_gravel", "pickaxe_compact", "pickaxe_stone", "rock_break", "material_slide",
             "bucket_fill", "wheelbarrow_dump", "sluice_water", "sluice_feed", "sluice_cleanout"]
    lv = {}
    for _ in range(3 if QUICK else 6):
        r = G(A, AUDIO_LEVELS, kinds)
        if r is None:
            break
        for k, v in r.items():
            lv.setdefault(k, []).append(v)
    if not lv:
        print("  (no OfflineAudioContext in this browser - sound levels not measured here)")
    else:
        ok("audio: every phase-6 sound (tool x material, slide, bucket, barrow, sluice) audible and below clipping in the worst of several renders",
           len(lv) == len(kinds) and all(max(v) < -1.0 and min(v) > -40 for v in lv.values()), json.dumps({k: [min(v), max(v)] for k, v in lv.items()}))
    # screenshots: the dig set
    if shots:
        fresh(A)
        G(A, f"() => {{ {GR}.grant('shovel'); {GR}.grant('pickaxe'); }}")
        for n, (tool, mat) in enumerate([("hand", "dirt"), ("hand", "gravel"), ("shovel", "dirt"), ("shovel", "gravel"), ("pickaxe", "compactDirt"), ("pickaxe", "stone")]):
            sp = G(A, SPOT, {"want": mat, "reach": 1.7, "start": 0.08 + n * 0.15, "fresh": True})
            if not sp:
                print(f"  (no {mat} spot for the {tool} screenshot)")
                continue
            G(A, f"(t) => {GR}.equipNow(t)", tool)
            G(A, f"(s) => {GR}.pose(s)", sp)
            G(A, f"() => {GR}.fxClear()")
            m = ["dirt", "compactDirt", "gravel", "stone"].index(mat)
            G(A, f"(a) => {GR}.fxImpact(a[0], a[1], 2, 0)", [m, tool])
            G(A, f"() => {GR}.fxUpdate(0.14)")
            G(A, f"(s) => {GR}.pose(s)", sp)
            shot(A, shots, f"dig_{tool}_{mat}")
        G(A, f"() => {GR}.equipNow('shovel')")
        sp = dig_spot(A, 0.5)
        for i in range(10):
            scoop(A, sp)
        G(A, f"() => {GR}.fxClear()")
        G(A, f"(s) => {GR}.pose(s)", dict(sp, pitch=sp["pitch"] + 0.1))
        shot(A, shots, "fresh_excavation")
        G(A, f"(s) => {{ {GR}.aimAt(s); for (let i = 0; i < 8; i++) {GR}.contact(); }}", sp)
        G(A, f"() => {GR}.fxUpdate(0.7)")
        G(A, f"(s) => {GR}.pose(s)", dict(sp, pitch=sp["pitch"] + 0.1))
        shot(A, shots, "material_slide")


# ======================================================================
# WHEELBARROW W1-W14
# ======================================================================

def wheelbarrow(A, shots):
    fresh(A)
    G(A, f"() => {{ const g = {GR}; g.setCash(100000); for (const id of ['shovel', 'bucket']) g.buy(id); g.equipNow('shovel'); }}")
    price = next(i for i in G(A, f"() => {GR}.shopView().items") if i["id"] == "wheelbarrow")["price"]
    c0 = eco(A)["cashCents"]
    r = G(A, f"() => {GR}.buy('wheelbarrow')")
    b = proc(A)["barrow"]
    ok("W1 buy the wheelbarrow: paid exactly its price, it stands next to the shed (a real object on the ground)", r["ok"] and eco(A)["cashCents"] == c0 - price and b and abs(b["y"] - b["ground"]) < 1e-6 and not b["pushing"],
       f"price {price}, at {b and (round(b['x'], 2), round(b['z'], 2))}")
    G(A, f"() => {GR}.save()")
    saved = json.loads(G(A, "() => localStorage.getItem(grKey())"))
    ok("W2 ownership in the save (v6+): owned, position, orientation, (empty) load", saved["saveVersion"] >= 6 and "wheelbarrow" in saved["processing"]["owned"] and saved["processing"]["wheelbarrow"]["batch"]["volumeMl"] == 0
       and abs(saved["processing"]["wheelbarrow"]["x"] - b["x"]) < 1e-9, str(saved["processing"]["wheelbarrow"])[:160])
    # W3 / W4: dig into the parked barrow
    sp = dig_spot(A, 0.3)
    park_beside(A, sp)
    into = {"ml": 0, "g": 0, "ug": 0, "massG": 0, "vol": 0}
    for i in range(14):
        s = dict(sp, yaw=sp["yaw"] + (i % 5) * 0.03)
        r = scoop(A, s)
        if r and r.get("massKg"):
            into["ml"] += r.get("intoMl") or 0; into["g"] += r.get("intoG") or 0; into["ug"] += r.get("intoUg") or 0
    p = proc(A)
    ok("W3 dig next to the parked barrow: the material goes into it (not the bucket)", p["barrow"]["batch"]["volumeMl"] > 5000 and p["bucket"]["batch"]["volumeMl"] == 0, f"{p['barrow']['batch']['volumeMl']} ml")
    lok, L, _ = ledger_ok(A)
    ok("W4 conservation: what left the ground into the barrow is exactly its load (volume, mass, gold); the ledger balances",
       p["barrow"]["batch"]["volumeMl"] == into["ml"] and p["barrow"]["massG"] == into["g"] and p["barrow"]["goldUg"] == into["ug"] and lok, f"{into} vs {p['barrow']['batch']['volumeMl']} / {p['barrow']['massG']} / {p['barrow']['goldUg']}")
    # W5: capacity
    spill = 0
    for i in range(160):
        s = dict(sp, yaw=sp["yaw"] + ((i // 6) % 7) * 0.05)
        r = scoop(A, s)
        if r and r.get("spilledMl"):
            spill += r["spilledMl"]
        if proc(A)["barrow"]["batch"]["volumeMl"] >= 85000 and spill > 0:
            break
    p = proc(A)
    ok("W5 capacity: it fills to its 85 l and no further - what does not fit is spoil", p["barrow"]["batch"]["volumeMl"] == p["barrow"]["capacityMl"] == 85000 and spill > 0, f"{p['barrow']['batch']['volumeMl']} ml, spill {spill}")
    shot(A, shots, "barrow_full")
    # W6 / W7: push it; the load slows you (a clear lane north of the shed)
    full_kg = p["barrow"]["massG"] / 1000
    G(A, f"() => {GR}.procBarrowPlace(-4, 13, Math.PI / 2)")
    r = take_barrow(A)
    G(A, f"() => {GR}.setPaused(false)")
    w0 = G(A, f"() => {GR}.state()")
    w = G(A, f"() => {GR}.walk(3.0, 0, 1)")
    p = proc(A)
    d_full = math.hypot(w["x"] - w0["x"], w["z"] - w0["z"])
    held = p["held"]
    ok("W6 take the grips and push: it rolls ahead of you on its wheel (on the ground), your hands on the grips", r["ok"] and p["barrow"]["pushing"] and held == "barrow" and abs(p["barrow"]["y"] - p["barrow"]["ground"]) < 1e-6 and d_full > 4,
       f"{d_full:.2f} m in 3 s, held {held}")
    shot(A, shots, "barrow_pushing")
    G(A, f"() => {GR}.procAct('barrow-park')")
    barrow_batch(A, "dirt", 0)
    G(A, f"() => {GR}.procBarrowPlace(-4, 13, Math.PI / 2)")
    take_barrow(A)
    w0 = G(A, f"() => {GR}.state()")
    w = G(A, f"() => {GR}.walk(3.0, 0, 1)")
    d_empty = math.hypot(w["x"] - w0["x"], w["z"] - w0["z"])
    # (phase 8: the barrow gets going from standstill - taking hold, then accelerating - so 3 s cover a little
    # less than 3 s of walking; a full one also starts and stops more slowly)
    ok("W7 the load matters: empty it pushes almost like walking, full (~%d kg) clearly slower - no stamina bar" % full_kg, d_full < d_empty * 0.8 and d_empty > 7, f"empty {d_empty:.2f} m vs full {d_full:.2f} m")
    G(A, f"() => {GR}.procAct('barrow-park')")
    # W8: over dug-up ground into the mound - the wheel stays on the (changed) ground, the frame
    # never tips absurdly, and where wheel and grips would be a whole frame apart in height it stops
    sp = dig_spot(A, 0.2)
    for i in range(60):
        scoop(A, dict(sp, yaw=sp["yaw"] + ((i // 5) % 6 - 3) * 0.08, pitch=sp["pitch"] - (i % 3) * 0.04))
    st = G(A, f"(s) => {{ {GR}.pose(s); return {GR}.state(); }}", sp)
    fx, fz = -math.sin(st["yaw"]), -math.cos(st["yaw"])
    G(A, f"(a) => {GR}.procBarrowPlace(a[0], a[1], a[2])", [st["x"] - fx * 3.5, st["z"] - fz * 3.5, st["yaw"]])
    barrow_batch(A, "gravel", 60000)
    take_barrow(A)
    track = []
    for k in range(30):
        G(A, f"() => {GR}.walk(0.2, 0, 1)")
        b = proc(A)["barrow"]
        s = G(A, f"() => {GR}.state()")
        track.append((b["x"], b["z"], b["y"] - b["ground"], b["theta"], b["ground"] - G(A, f"(a) => {GR}.heightAt(a[0], a[1])", [s["x"], s["z"]])))
    stuck = all(math.hypot(track[-1][0] - t[0], track[-1][1] - t[1]) < 0.02 for t in track[-5:])
    good = all(abs(dy) < 1e-6 and math.isfinite(th) and abs(th) < 1.0 and abs(dh) < 1.0 for _, _, dy, th, dh in track)
    jumps = max(math.hypot(track[i][0] - track[i - 1][0], track[i][1] - track[i - 1][1]) for i in range(1, len(track)))
    ok("W8 deformed ground: the wheel follows the dug-up ground (never floats / sinks), the frame stays sane; up the mound it simply stops - no jumps, no climbing walls",
       good and stuck and jumps < 1.0, f"last theta {track[-1][3]:.2f}, wheel above you {track[-1][4]:.2f} m, stuck={stuck}, max step {jumps:.2f}")
    shot(A, shots, "barrow_at_face")
    # W9: parked on open ground - it stays and blocks the way (you walk into its tray and stop)
    G(A, f"() => {GR}.procAct('barrow-park')")
    G(A, f"() => {GR}.procBarrowPlace(-4, 13, Math.PI / 2)")
    b0 = proc(A)["barrow"]
    tray = (b0["x"] + 0.61, b0["z"])
    G(A, f"(t) => {GR}.pose({{ x: t[0] + 2.5, z: t[1], yaw: Math.PI / 2, pitch: 0 }})", list(tray))
    G(A, f"() => {GR}.walk(1.5, 0, 1)")
    s = G(A, f"() => {GR}.state()")
    b1 = proc(A)["barrow"]
    gap = math.hypot(s["x"] - tray[0], s["z"] - tray[1])
    ok("W9 parked: it stays where it was set down and you cannot walk through it", not b1["pushing"] and (b1["x"], b1["z"]) == (b0["x"], b0["z"]) and gap > 0.6, f"stopped {gap:.2f} m from its tray")
    # W10: save / reload - same place, same load
    before = proc(A)["barrow"]
    G(A, f"() => {GR}.save()")
    gr_close(A)
    open_game(A)
    after = proc(A)["barrow"]
    ok("W10 save / reload: the same position, orientation and load (to the ml / mg / µg)", after and abs(after["x"] - before["x"]) < 1e-9 and abs(after["z"] - before["z"]) < 1e-9 and after["yaw"] == before["yaw"]
       and after["batch"] == before["batch"], f"{before['x']:.3f},{before['z']:.3f} -> {after['x']:.3f},{after['z']:.3f}")
    # W11 / W12: dump into the hopper; never two
    G(A, f"() => {{ const g = {GR}; g.setCash(200000); g.buy('pan'); g.buy('sluice'); }}")
    install(A)
    G(A, f"(h) => {GR}.procBarrowPlace(h[0], h[1] - 1.75, Math.PI)", list(HOPPER))
    barrow_batch(A, "paydirt", 40000)
    take_barrow(A)
    G(A, f"() => {GR}.walk(2.6, 0, 1)")                   # (phase 8: it takes hold and gets going - pushed until it stands at the hopper)
    inter = proc(A)["interaction"]
    gold0 = proc(A)["barrow"]["goldUg"]
    G(A, f"() => {GR}.setPaused(false)")
    r = use(A)
    dumping = proc(A)["barrow"]["dumping"]
    time.sleep(0.5)
    shot(A, shots, "barrow_dumping")
    wait_for(lambda: not proc(A)["barrow"]["dumping"], 4)
    p = proc(A)
    lok, L, _ = ledger_ok(A)
    ok("W11 dump at the sluice: the tray tips over the wheel (a visible moment), the load goes into the hopper - exactly", inter and inter["id"] == "barrow-dump" and r and dumping
       and p["sluice"]["hopper"]["volumeMl"] == 40000 and p["barrow"]["batch"]["volumeMl"] == 0 and lok, f"hopper {p['sluice']['hopper']['volumeMl']} ml, {inter}")
    n_models = G(A, f"() => {GR}.procObj().scene.children.filter((o) => o.name === 'goldrush-wheelbarrow').length")
    hop0 = p["sluice"]["hopper"]
    G(A, f"() => {GR}.save()")
    gr_close(A)
    open_game(A)
    p2 = proc(A)
    n_models2 = G(A, f"() => {GR}.procObj().scene.children.filter((o) => o.name === 'goldrush-wheelbarrow').length")
    lok2, _, _ = ledger_ok(A)
    ok("W12 no duplicate: one barrow model, after a dump and a reload the gold is where it went - not twice, not lost", n_models == n_models2 == 1 and p2["sluice"]["hopper"] == hop0 and p2["barrow"]["goldUg"] == 0 and lok2,
       f"models {n_models}/{n_models2}, hopper {p2['sluice']['hopper']['fineUg']} ug fine")
    # W13: new mine
    gr_close(A)
    gr_open(A)
    gr_ready(A, choice="new")
    p = proc(A)
    ok("W13 'Neue Mine': no wheelbarrow, no sluice, nothing of phase 6 left", p["barrow"] is None and p["sluice"] is None and p["owned"] == [], str(p["owned"]))


# ======================================================================
# SLUICE S1-S18
# ======================================================================

def sluice(A, shots):
    fresh(A)
    kit(A, PHASE5 + ["wheelbarrow"])
    G(A, f"() => {{ {GR}.setCash(100000); }}")
    r = G(A, f"() => {GR}.buy('sluice')")
    p = proc(A)
    G(A, f"(f) => {GR}.pose({{ x: f[0], z: f[1], yaw: 0, pitch: -0.35 }})", list(FEED))
    shot(A, shots, "sluice_delivered")
    inter = proc(A)["interaction"]
    G(A, f"() => {GR}.setPaused(false)")
    use(A)
    time.sleep(1.1)
    mid = G(A, f"() => {{ const s = {GR}.procObj().sluice; return {{ building: s.build >= 0, kit: s.kit.visible, model: s.model.visible }}; }}")
    shot(A, shots, "sluice_building")
    wait_for(lambda: proc(A)["sluice"]["state"] == "ready", 5)
    ok("S1 buy + install: delivered as a stack of boards at its place, [E] 'Waschrinne aufbauen' - the boards go, the sluice rises (a short moment), then it stands", r["ok"] and p["sluice"]["state"] == "delivered"
       and inter and inter["id"] == "sluice-build" and mid == {"building": True, "kit": False, "model": True} and proc(A)["sluice"]["state"] == "ready", f"{inter} mid-build {mid}")
    G(A, f"() => {GR}.setPaused(true)")
    # S2: bucket into the hopper
    sp = dig_spot(A, 0.3)
    G(A, f"(s) => {{ const g = {GR}; g.aimAt(s); const st = g.state(); g.procPlaceBucket(st.x + Math.cos(s.yaw) * 0.55, st.z - Math.sin(s.yaw) * 0.55); }}", sp)
    for i in range(12):
        scoop(A, dict(sp, yaw=sp["yaw"] + (i % 4) * 0.04))
    bk = proc(A)["bucket"]
    G(A, f"() => {{ const b = {GR}.procObj().bucket; b.carried = true; }}")
    G(A, f"(f) => {GR}.pose({{ x: f[0], z: f[1], yaw: 0, pitch: -0.35 }})", list(FEED))
    inter = proc(A)["interaction"]
    use(A)
    p = proc(A)
    ok("S2 bucket into the hopper: [E] 'Eimer in den Trichter kippen' - its whole load, exactly", inter and inter["id"] == "bucket-hopper" and p["sluice"]["hopper"]["volumeMl"] == bk["batch"]["volumeMl"]
       and p["sluice"]["hopper"]["fineUg"] == bk["batch"]["fineUg"] and p["bucket"]["batch"]["volumeMl"] == 0, f"{inter} bucket {bk['batch']['volumeMl']} ml -> hopper {p['sluice']['hopper']['volumeMl']} ml")
    G(A, f"() => {{ const b = {GR}.procObj().bucket; b.carried = false; }}")
    # S3 / S4: barrow input, hopper capacity
    G(A, f"(h) => {GR}.procBarrowPlace(h[0], h[1] - 1.75, Math.PI)", list(HOPPER))
    barrow_batch(A, "paydirt", 85000)
    take_barrow(A)
    G(A, f"() => {GR}.walk(2.6, 0, 1)")                   # (phase 8: it takes hold and gets going - pushed until it stands at the hopper)
    hv0 = proc(A)["sluice"]["hopper"]["volumeMl"]
    use(A)
    G(A, f"() => {GR}.walk(1.6, 0, 0)")                   # the tip plays out (frames, standing still)
    p = proc(A)
    ok("S3 wheelbarrow into the hopper: tipped in, the same pour as the bucket (generic transfer)", p["sluice"]["hopper"]["volumeMl"] > hv0, f"{hv0} -> {p['sluice']['hopper']['volumeMl']}")
    inter = proc(A)["interaction"]
    ok("S4 hopper capacity: it takes its 50 l, the rest stays in the barrow - and then the prompt says so (set it down)",
       p["sluice"]["hopper"]["volumeMl"] == p["sluice"]["capacityMl"] == 50000 and p["barrow"]["batch"]["volumeMl"] == 85000 - (50000 - hv0) and inter["id"] == "barrow-park" and "voll" in inter["action"], str(inter))
    use(A)                          # park
    # S5: water on / off
    G(A, f"(f) => {GR}.pose({{ x: f[0], z: f[1], yaw: 0, pitch: -0.35 }})", list(FEED))
    i1 = proc(A)["interaction"]
    use(A)
    on = proc(A)["sluice"]["running"]
    G(A, f"(f) => {GR}.pose({{ x: f[0], z: f[1], yaw: 0, pitch: -0.35 }})", list(FEED))
    i2 = proc(A)["interaction"]
    use(A)
    off = proc(A)["sluice"]["running"]
    ok("S5 water on / off at the hopper: [E] Wasser anstellen / abstellen", i1["id"] == "sluice-start" and on and i2["id"] == "sluice-stop" and not off, f"{i1['action']} / {i2['action']}")
    # S6-S8: throughput, conservation
    G(A, f"() => {GR}.procWater(true)")
    h0 = proc(A)["sluice"]["hopper"]["volumeMl"]
    G(A, f"() => {GR}.procTick(60)")
    p = proc(A)
    done = h0 - p["sluice"]["hopper"]["volumeMl"]
    ok("S6 throughput: 10 l per minute through the box (game time, in 0,5-l steps)", 9500 <= done <= 10500, f"{done} ml in 60 s")
    G(A, f"() => {GR}.procTick(400)")
    G(A, f"() => {GR}.walk(0.1, 0, 0)")                   # a frame: the heap is drawn
    lok, L, p = ledger_ok(A)
    ok("S7 gold conservation: hopper + riffles + tray + everything else + recovered + tailings == what went in, to the µg", lok, json.dumps({k: L[k] for k in ("inUg", "recoveredUg", "tailUg")}))
    out = G(A, f"() => {GR}.procObj().piles.get('tailOut').volumeMl")             # (Prompt 10: the outlet pile)
    ok("S8 tailings conservation: mass in == containers + tailings (to the gram); the heap grows at the outlet", L["inG"] == p["inContainersG"] + L["tailG"] and out > 2000 and p["sluice"]["tailMl"] > 2000, f"heap {p['sluice']['tailMl']} ml, outlet pile {out} ml")
    G(A, f"() => {GR}.pose({{ x: -17.2, z: 0.0, yaw: 0.75, pitch: -0.42 }})")
    time.sleep(0.6)
    shot(A, shots, "sluice_running")
    # S9: deterministic - after a clean out the same 30 l leave the same gold in the riffles, twice
    caps = []
    for _ in range(2):
        cleanout(A)
        hopper_batch(A, "paydirt", 30000)
        G(A, f"() => {GR}.procWater(true)")
        G(A, f"() => {GR}.procTick(200)")
        caps.append(proc(A)["sluice"]["riffles"]["fineUg"])
    lok, _, _ = ledger_ok(A)
    ok("S9 recovery is deterministic: the same material leaves the same gold in the riffles - no dice; the ledger balances", caps[0] == caps[1] > 0 and lok, f"{caps}")
    # S10: runs while you are elsewhere (real frames)
    hopper_batch(A, "paydirt", 40000)
    G(A, f"() => {GR}.procWater(true)")
    G(A, f"() => {{ {GR}.pose({{ x: 0.6, z: 10.2, yaw: 0, pitch: 0 }}); {GR}.setPaused(false); }}")
    v0 = proc(A)["sluice"]["hopper"]["volumeMl"]
    time.sleep(6)
    v1 = proc(A)["sluice"]["hopper"]["volumeMl"]
    ok("S10 it keeps washing while you are away at the mound (the game running)", v0 - v1 >= 500, f"{v0 - v1} ml in ~6 s real time")
    # S11: no offline progress (the pause menu, then the game closed)
    gr_pause(A)
    v2 = proc(A)["sluice"]["hopper"]["volumeMl"]
    time.sleep(2.5)
    v3 = proc(A)["sluice"]["hopper"]["volumeMl"]
    gr_close(A)
    saved = json.loads(G(A, "() => localStorage.getItem(grKey())"))["processing"]["sluice"]
    time.sleep(3)
    open_game(A, start=False)
    v4 = proc(A)["sluice"]["hopper"]["volumeMl"]
    ok("S11 no offline progress: paused / closed it does not wash - after reopening exactly what was saved (no catch-up)", v2 == v3 and v4 == saved["hopper"]["volumeMl"] and saved["running"], f"{v2}/{v3} saved {saved['hopper']['volumeMl']} reopened {v4}")
    # S12: clean out
    G(A, f"() => {GR}.procTick(300)")
    nuggets = G(A, f"""async () => {{ const m = await import('/games/goldrush/goldrush-devactions.js'); const pr = {GR}.procObj();
      const b = m.devBatch('paydirt', 900); b.finds = [{{ cls: 5, ug: 14000, key: 't:n1' }}, {{ cls: 3, ug: 1200, key: 't:f1' }}]; return pr.devRiffles(b, 0); }}""")
    p = proc(A)
    rif = p["sluice"]["riffles"]
    want_nuggets = sum(f["ug"] for f in rif["finds"] if f["cls"] == 5)
    pouch0 = eco(A)["pouchUg"]
    G(A, f"(c) => {GR}.pose({{ x: c[0], z: c[1], yaw: 0, pitch: -0.5 }})", list(CLEAN))
    i1 = proc(A)["interaction"]
    use(A)
    i2 = proc(A)["interaction"]
    use(A)
    work = proc(A)["work"]
    w = G(A, f"() => {GR}.procWork(10)")
    p = proc(A)
    pouch1 = eco(A)["pouchUg"]
    ok("S12 clean out: water off, [E] 'Riffelmatte reinigen', a few seconds of brushing; the nuggets are picked out into the pouch, the rest goes to the concentrate tray, the mat is empty",
       i1["id"] == "sluice-stop" and i2["id"] == "sluice-clean" and work == "clean" and p["sluice"]["riffles"]["volumeMl"] == 0 and p["sluice"]["loadMl"] == 0
       and pouch1 - pouch0 == want_nuggets >= 14000 and p["sluice"]["tray"]["fineUg"] >= rif["fineUg"], f"{i1['id']} {i2['id']} work {work} riffles {p['sluice']['riffles']['volumeMl']} load {p['sluice']['loadMl']} pouch +{pouch1 - pouch0} of {want_nuggets} tray {p['sluice']['tray']['fineUg']} vs {rif['fineUg']}")
    # S13: concentrate -> pan
    G(A, f"() => {GR}.pose({{ x: -16.12, z: 2.0, yaw: Math.PI / 2, pitch: -0.5 }})")
    i = proc(A)["interaction"]
    f = G(A, f"() => {GR}.procAct('pan-fill')")
    pan = proc(A)["pan"]
    G(A, f"() => {GR}.procWork(30)")
    c = G(A, f"() => {GR}.procCollect()")
    ok("S13 the heavy concentrate is panned (heavy stage: ~0,94 of its fine gold, quick) - the gold pan stays the last step",
       i["id"] == "pan-fill" and "Schwerkonzentrat" in i["action"] and pan["stage"] == "heavy" and c["ok"] and c["fineUg"] == math.floor(pan["fineUg"] * min(0.96, 0.94 * (1 + 0.12 * 0.15))), f"{c}")
    while proc(A)["sluice"]["tray"]["volumeMl"] > 0:
        G(A, f"() => {{ {GR}.procAct('pan-fill'); {GR}.procWork(30); {GR}.procCollect(); }}")
    # S14-S17: save / reload mid-process
    hopper_batch(A, "paydirt", 45000)
    G(A, f"() => {GR}.procWater(true)")
    G(A, f"() => {GR}.procTick(95)")
    p = proc(A)
    tot0 = p["inContainersUg"] + p["ledger"]["recoveredUg"] + p["ledger"]["tailUg"]
    G(A, f"() => {GR}.save()")
    saved = json.loads(G(A, "() => localStorage.getItem(grKey())"))["processing"]["sluice"]
    ok("S14 save mid-process: hopper, riffles, tray, load, heap and the running water are in the save", saved["running"] and saved["hopper"]["volumeMl"] == p["sluice"]["hopper"]["volumeMl"]
       and saved["riffles"]["fineUg"] == p["sluice"]["riffles"]["fineUg"] and saved["loadMl"] == p["sluice"]["loadMl"], f"hopper {saved['hopper']['volumeMl']}")
    gr_close(A)
    open_game(A, start=False)
    p2 = proc(A)
    tot1 = p2["inContainersUg"] + p2["ledger"]["recoveredUg"] + p2["ledger"]["tailUg"]
    ok("S15 reload mid-process: the same hopper / riffles / tray / running state", p2["sluice"]["hopper"] == p["sluice"]["hopper"] and p2["sluice"]["riffles"] == p["sluice"]["riffles"] and p2["sluice"]["running"],
       f"{p2['sluice']['hopper']['volumeMl']} ml")
    lok2, L2, _ = ledger_ok(A)
    ok("S16 / S17 no duplicate, no loss: all gold (containers + recovered + tailings) the same after the reload, the ledger balances", tot0 == tot1 and lok2,
       f"{tot0} vs {tot1}; ledger before {p['ledger']} containers {p['inContainersUg']}/{p['inContainersG']} - after {L2} containers {p2['inContainersUg']}/{p2['inContainersG']}")
    # S18: upgrades
    G(A, f"() => {{ const g = {GR}; g.setCash(1000000); g.buy('sluice.hopper'); g.buy('sluice.mat'); }}")
    cleanout(A)
    p = proc(A)
    hopper_batch(A, "paydirt", 30000)
    G(A, f"() => {GR}.procWater(true)")
    G(A, f"() => {GR}.procTick(200)")
    cap_mat = proc(A)["sluice"]["riffles"]["fineUg"]
    lok, _, _ = ledger_ok(A)
    ok("S18 upgrades: the large hopper takes 90 l, the moss mat keeps more fine gold of the same material (0,75 instead of 0,65)",
       p["sluice"]["capacityMl"] == 90000 and abs(p["sluice"]["efficiency"] - 0.75) < 0.02 and cap_mat > caps[0] * 1.1 and lok, f"{caps[0]} -> {cap_mat}, efficiency {p['sluice']['efficiency']:.3f}")
    G(A, f"() => {GR}.save()")
    size = G(A, f"() => {GR}.saveBytes()")
    ok("a phase-6 save with barrow, sluice, riffles and tray stays small", size < 60000, f"{size} B")


# ======================================================================
# SAVE v6 migration, developer pack
# ======================================================================

def saves(A):
    gr_close(A)
    v5 = {"saveVersion": 5, "worldSeed": 77, "createdAt": 1, "updatedAt": 2, "player": {"x": 0.6, "z": 10.2, "yaw": 0, "pitch": 0.1},
          "tools": {"owned": ["hand", "shovel"], "equipped": "shovel", "upgrades": []}, "economy": {"cashCents": 4321, "moneyCents": 4321},
          "terrain": None, "resources": None, "rocks": None, "processing": {"owned": ["bucket"], "bucket": None, "ledger": {}}}
    A.evaluate("(d) => { localStorage.setItem(grKey(), JSON.stringify(d)); localStorage.removeItem(grKey('.backup')); }", v5)
    open_game(A)
    G(A, f"() => {GR}.save()")
    d = json.loads(G(A, "() => localStorage.getItem(grKey())"))
    ok("save v6+: a phase-5 document (v5) loads as it was (cash, tools, bucket), gains nothing of phase 6 (or 7), is written as the current version",
       d["saveVersion"] >= 6 and d["processing"].get("bulkHopper") is None and d["economy"]["cashCents"] == 4321 and d["processing"]["owned"] == ["bucket"] and d["processing"]["wheelbarrow"] is None and d["processing"]["sluice"] is None, str(d["processing"]["owned"]))


def mech_state(page):
    p = proc(page)
    b, s = p["barrow"], p["sluice"]
    return {"barrow": b and {"x": round(b["x"], 6), "z": round(b["z"], 6), "yaw": b["yaw"], "batch": b["batch"]},
            "sluice": s and {k: s[k] for k in ("state", "running", "hopper", "riffles", "tray", "loadMl", "tailMl", "capacityMl")}, "ledger": p["ledger"], "owned": p["owned"]}


def dev_pack(browser, shots):
    logdir = Path(tempfile.mkdtemp(prefix="gr6_dev_"))
    on, base, tmp, log = DEV.start_dev_server(DEV.CODE, logdir / "server.log")
    try:
        user = login(base, "Dev6")
        ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
        open_game(A)
        # W14: a normal phase-6 mine (barrow with dug material, a sluice that ran) -> developer mode makes its snapshot
        kit(A)
        install(A)
        sp = dig_spot(A, 0.3)
        park_beside(A, sp)
        for i in range(10):
            scoop(A, dict(sp, yaw=sp["yaw"] + (i % 5) * 0.03))
        hopper_batch(A, "paydirt", 30000)
        G(A, f"() => {GR}.procWater(true)")
        G(A, f"() => {GR}.procTick(70)")
        G(A, f"() => {{ {GR}.flushLoot(); {GR}.save(); }}")
        before = mech_state(A)
        DEV.open_panel(A)
        snap = DEV.ds(A)["snapshot"]
        DEV.tab(A, "material")
        DEV.cmd(A, "barrow.fill100")
        DEV.cmd(A, "sluice.hopper0")
        changed = mech_state(A)
        A.click("[data-dev=restore]")
        A.wait_for_selector(".gr-dev-modal:not([hidden]) [data-dev-modal=ok]", timeout=5000)
        A.click("[data-dev-modal=ok]")
        wait_for(lambda: G(A, f"() => !!(window.__goldrush && {GR}.state && {GR}.state().seed && {GR}.proc().barrow)"), 60)
        gr_start(A)
        after = mech_state(A)
        diff = {k: (before[k], after[k]) for k in before if before[k] != after[k]}
        chips = G(A, "() => ['.gr-wallet', '.gr-pouch', '.gr-load', '.gr-objective', '.gr-work', '.gr-prompt', '.gr-money'].map((q) => document.querySelectorAll(q).length)")
        ok("W14 developer snapshot / restore: barrow (place, load) and sluice (state, hopper, riffles, tray, water) come back exactly as before the developer test; the restarted HUD has each chip once",
           snap and changed != before and not diff and not DEV.ds(A)["devModified"] and chips == [1] * 7, f"{str(diff)[:240]} chips {chips}")
        # the phase-6 preset
        DEV.open_panel(A)
        DEV.tab(A, "quick")
        t0 = time.time()
        r = DEV.cmd(A, "quick.phase6")
        p = proc(A)
        ok("dev: preset 'Phase 6 Mechanisierung' - all phase 1-5 items, the wheelbarrow and a built sluice, a full barrow in front of the hopper, the hopper half full, you behind the barrow",
           r and not r["error"] and all(x in p["owned"] for x in ("bucket", "pan", "classifier", "wheelbarrow", "sluice")) and p["sluice"]["state"] == "ready" and p["barrow"]["batch"]["volumeMl"] == 85000
           and p["sluice"]["hopper"]["volumeMl"] == p["sluice"]["capacityMl"] // 2 and eco(A)["cashCents"] == 20000, f"{r} {p['owned']}")
        DEV.close_panel(A)
        G(A, f"() => {GR}.setPaused(false)")
        took = G(A, f"() => {GR}.procAct('barrow-take')")
        G(A, f"() => {GR}.walk(1.0, 0, 1)")
        inter = proc(A)["interaction"]
        ok("dev: from the preset in seconds: take the barrow, a step, the hopper prompt (tip it in / the hopper is full)", took["ok"] and inter and inter["id"] in ("barrow-dump", "barrow-park"),
           f"{inter and inter['action']} after {time.time() - t0:.1f} s")
        G(A, f"() => {GR}.procAct('barrow-park')")
        # the phase-6 actions
        DEV.open_panel(A)
        DEV.tab(A, "material")
        ids = G(A, "() => [...document.querySelectorAll('[data-dev-cmd]')].map((b) => b.dataset.devCmd)")
        need = ["barrow.give", "barrow.fill0", "barrow.fill25", "barrow.fill50", "barrow.fill100", "barrow.paydirt", "barrow.here", "sluice.unlock", "sluice.hopper0", "sluice.hopperFull",
                "sluice.paydirt", "sluice.start", "sluice.cleanReady"]
        ok("dev: the phase-6 actions are in the panel (barrow give / empty / 25 / 50 / full / pay dirt / bring here; sluice unlock / hopper empty, full / test pay dirt / start / clean-out ready)",
           all(n in ids for n in need), str([n for n in need if n not in ids]))
        DEV.cmd(A, "barrow.fill50")
        b50 = proc(A)["barrow"]["batch"]["volumeMl"]
        DEV.cmd(A, "sluice.hopper0")
        DEV.cmd(A, "sluice.paydirt")
        h = proc(A)["sluice"]["hopper"]["volumeMl"]
        DEV.cmd(A, "sluice.start")
        run = proc(A)["sluice"]["running"]
        DEV.cmd(A, "sluice.cleanReady")
        s = proc(A)["sluice"]
        info = dict(zip(A.locator(".gr-dev-info dt").all_inner_texts(), A.locator(".gr-dev-info dd").all_inner_texts()))
        shot(A, shots, "dev_phase6")
        lok, _, _ = ledger_ok(A)
        ok("dev: barrow 50 %, hopper empty / test pay dirt, water on, clean-out ready; the sluice output debug shows its numbers; the ledger still balances (test material is booked)",
           b50 == 42500 and h == s["capacityMl"] and run and s["loadMl"] >= 240000 and not s["running"] and "Riffel" in info and "Durchsatz" in info and lok, str(info)[:240])
        DEV.cmd(A, "barrow.here")
        b = proc(A)["barrow"]
        st = G(A, f"() => {GR}.state()")
        ok("dev: 'Schubkarre herholen' - it stands next to you", math.hypot(b["x"] - st["x"], b["z"] - st["z"]) < 3, f"{math.hypot(b['x'] - st['x'], b['z'] - st['z']):.2f} m")
        DEV.tab(A, "world")
        DEV.cmd(A, "world.tp.sluice")
        pos = G(A, f"() => {GR}.positionCheck()")
        st = G(A, f"() => {GR}.state()")
        ok("dev: teleport to the sluice (a valid spot at its hopper)", pos["ok"] and math.hypot(st["x"] - FEED[0], st["z"] - FEED[1]) < 0.3, str(pos)[:120])
        DEV.tab(A, "equipment")
        rows = G(A, "() => [...document.querySelectorAll('[data-dev-row]')].map((b) => b.dataset.devRow)")
        ok("dev: the item list includes the phase-6 items (wheelbarrow, sluice, its two upgrades) automatically", all(any(f"|{i}|" in r for r in rows) for i in ("wheelbarrow", "sluice", "sluice.hopper", "sluice.mat")),
           str([r for r in rows if "sluice" in r or "wheel" in r])[:200])
        errs = [e for e in errors(A) if "403" not in e]
        ok("dev part ran without page errors", not errs, str(errs[:3]))
        DEV.close_panel(A)
        gr_close(A)
        ctx.close()
    finally:
        on.terminate()
        on.wait(10)
        log.close()


# ======================================================================
# PHONE (S19)
# ======================================================================

def mobile(browser, base, user, shots):
    ctx, M = client(browser, base, user, dict(PHONE), extra_init=[seeded()])
    cdp = ctx.new_cdp_session(M)
    fresh(M)
    kit(M)
    install(M)
    G(M, f"(h) => {GR}.procBarrowPlace(h[0], h[1] - 1.75, Math.PI)", list(HOPPER))
    barrow_batch(M, "paydirt", 30000)
    b = proc(M)["barrow"]
    G(M, f"(b) => {GR}.pose({{ x: b.x + Math.sin(b.yaw) * 2.15, z: b.z + Math.cos(b.yaw) * 2.15, yaw: b.yaw, pitch: -0.3 }})", b)
    time.sleep(0.5)
    labels = [M.inner_text(".gr-ctx-btn") if M.is_visible(".gr-ctx-btn") else ""]
    M.tap(".gr-ctx-btn")
    pushing = proc(M)["barrow"]["pushing"]
    time.sleep(0.3)
    busy_push = M.evaluate("() => document.querySelector('.gr-dig-btn').classList.contains('is-busy')")
    G(M, f"() => {GR}.walk(1.2, 0, 1)")
    time.sleep(0.4)
    labels.append(M.inner_text(".gr-ctx-btn") if M.is_visible(".gr-ctx-btn") else "")
    shot(M, shots, "mobile_pushing")
    M.tap(".gr-ctx-btn")
    wait_for(lambda: not proc(M)["barrow"]["dumping"], 4)
    time.sleep(0.4)
    labels.append(M.inner_text(".gr-ctx-btn") if M.is_visible(".gr-ctx-btn") else "")
    M.tap(".gr-ctx-btn")                                   # park
    time.sleep(0.3)
    busy_parked = M.evaluate("() => document.querySelector('.gr-dig-btn').classList.contains('is-busy')")
    G(M, f"(f) => {GR}.pose({{ x: f[0], z: f[1], yaw: 0, pitch: -0.35 }})", list(FEED))
    time.sleep(0.5)
    labels.append(M.inner_text(".gr-ctx-btn") if M.is_visible(".gr-ctx-btn") else "")
    M.tap(".gr-ctx-btn")
    running = proc(M)["sluice"]["running"]
    G(M, f"() => {GR}.procTick(120)")
    G(M, f"(c) => {GR}.pose({{ x: c[0], z: c[1], yaw: 0, pitch: -0.5 }})", list(CLEAN))
    time.sleep(0.4)
    M.tap(".gr-ctx-btn")                                   # water off
    time.sleep(0.4)
    labels.append(M.inner_text(".gr-ctx-btn") if M.is_visible(".gr-ctx-btn") else "")
    M.tap(".gr-ctx-btn")                                   # clean
    vw = M.viewport_size
    cx, cy = vw["width"] / 2, vw["height"] / 2
    t0 = time.time()
    phase = lambda: G(M, f"() => {GR}.workState().phase")
    while proc(M)["work"] == "clean" and phase() == "gesture" and time.time() - t0 < 40:
        drag(cdp, [(cx + (90 if k % 2 else -90), cy) for k in range(24)], 0.03)
    # (Prompt 10, human QA F: the cleaned mat's result waits - 'FERTIG' ends it)
    wait_for(lambda: phase() == "result", 4)
    time.sleep(0.3)
    labels.append(M.inner_text(".gr-ctx-btn") if M.is_visible(".gr-ctx-btn") else "")
    M.tap(".gr-ctx-btn")
    wait_for(lambda: proc(M)["work"] is None, 3)
    p = proc(M)
    shot(M, shots, "mobile_sluice")
    ok("S19 phone: one big context button for everything - GREIFEN, AUSKIPPEN, ABSTELLEN, WASSER AN, REINIGEN; a finger brushes the mat out; the dig button rests while the hands are on the barrow",
       pushing and running and labels[:2] == ["GREIFEN", "AUSKIPPEN"] and labels[2] == "ABSTELLEN" and labels[3] == "WASSER AN" and labels[4] == "REINIGEN" and labels[5] == "FERTIG"
       and p["work"] is None and p["sluice"]["tray"]["volumeMl"] > 0 and busy_push and not busy_parked, f"{labels} busy {busy_push}/{busy_parked} tray {p['sluice']['tray']['volumeMl']}")
    errs = errors(M)
    ok("phone part ran without page errors", not errs, str(errs[:3]))
    gr_close(M)
    ctx.close()


# ======================================================================
# PERFORMANCE / LONG RUN
# ======================================================================

FRAME_REC = """() => { const r = window.__frames = { t: [], on: true }; let last = performance.now();
  const tick = (now) => { if (!r.on) return; r.t.push(now - last); last = now; requestAnimationFrame(tick); }; requestAnimationFrame(tick); }"""
FRAME_STOP = """() => { const r = window.__frames; r.on = false; const t = r.t.slice(2).sort((a, b) => a - b);
  const avg = t.reduce((a, b) => a + b, 0) / t.length; return { fps: +(1000 / avg).toFixed(1), p95: +t[Math.floor(t.length * 0.95)].toFixed(2) }; }"""


def perf(browser, base, user, shots):
    out = {}
    for name, vp in (("desktop", dict(viewport={"width": 1366, "height": 768})), ("phone", dict(PHONE))):
        ctx, A = client(browser, base, user, vp, extra_init=[seeded()])
        fresh(A)
        kit(A)
        install(A)
        hopper_batch(A, "paydirt", 50000)
        G(A, f"() => {GR}.procWater(true)")
        G(A, f"() => {{ {GR}.pose({{ x: -17.2, z: 0.0, yaw: 0.75, pitch: -0.42 }}); {GR}.setPaused(false); }}")
        time.sleep(0.8)
        A.evaluate(FRAME_REC); time.sleep(3); f1 = A.evaluate(FRAME_STOP)
        i1 = G(A, f"() => {GR}.info()")
        G(A, f"(h) => {GR}.procBarrowPlace(-12, 6, Math.PI / 2)", list(HOPPER))
        barrow_batch(A, "gravel", 80000)
        G(A, f"() => {{ {GR}.pose({{ x: -12 + 2.15, z: 6, yaw: Math.PI / 2, pitch: -0.3 }}); {GR}.procAct('barrow-take'); }}")
        time.sleep(0.5)
        A.evaluate(FRAME_REC); time.sleep(3); f2 = A.evaluate(FRAME_STOP)
        i2 = G(A, f"() => {GR}.info()")
        out[name] = {"sluice": f1, "push": f2, "calls": [i1["drawCalls"], i2["drawCalls"]], "tris": [i1["triangles"], i2["triangles"]]}
        print(f"  perf {name}: {out[name]}", flush=True)
        gr_close(A)
        ctx.close()
    ok("performance: 60 fps at the running sluice and pushing a full barrow (desktop and emulated phone), draw calls bounded",
       all(v["sluice"]["fps"] >= 55 and v["push"]["fps"] >= 55 for v in out.values()) and all(max(v["calls"]) < 200 for v in out.values()), json.dumps(out))
    # long run: hours of feeding and washing (game time), many clean outs
    ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
    fresh(A)
    kit(A)
    install(A)
    G(A, f"() => {GR}.procWater(true)")
    snap = lambda: {**G(A, f"() => {{ const i = {GR}.info(); return {{ geometries: i.geometries, textures: i.textures, objects: i.sceneObjects }}; }}"), "heap": heap_mb(A)}
    s0 = snap()
    rounds = 20 if QUICK else 60
    for k in range(rounds):
        hopper_batch(A, "paydirt" if k % 2 else "gravel", 50000)
        G(A, f"() => {GR}.procTick(320)")
        if k % 4 == 3:
            G(A, f"() => {{ {GR}.procWater(false); {GR}.procAct('sluice-clean'); {GR}.procWork(10); {GR}.procWater(true); }}")
            G(A, f"() => {{ let n = 0; while (n++ < 30 && {GR}.procAct('pan-fill').ok) {{ {GR}.procWork(30); {GR}.procCollect(); }} }}")
    time.sleep(0.4)
    s1 = snap()
    lok, L, p = ledger_ok(A)
    ok(f"long run: {rounds} hopper loads ({rounds * 50} l) washed, clean outs, panning - geometry / textures / objects / heap stable, the ledger exact",
       s1["geometries"] <= s0["geometries"] + 2 and s1["textures"] == s0["textures"] and s1["objects"] == s0["objects"] and (s0["heap"] is None or s1["heap"] - s0["heap"] < 15) and lok,
       f"{s0} -> {s1}, processed {p['sluice']['stats']['processedMl']} ml")
    gr_close(A)
    ctx.close()


# ======================================================================
# ECONOMY (benchmark: strategies A6-D6, 360 min)
# ======================================================================

def economy(browser, base, user):
    seeds = 100 if FULL else (3 if QUICK else 6)
    ctx, A = client(browser, base, user, dict(viewport={"width": 960, "height": 600}), extra_init=[seeded()])
    runs, sums = {}, {}
    t0 = time.time()
    for st in ("A6", "B6", "C6", "D6"):
        runs[st] = [bench_seed(A, 1001 + n * 7, 360, "hand", st) for n in range(seeds)]
        sums[st] = summarize4(runs[st])
        b = sums[st]["bought_s"]
        med = lambda k: (b[k].get("median") or 0) / 60
        print(f"  [{st}] wheelbarrow {med('wheelbarrow'):.0f} | sluice {med('sluice'):.0f} | hopper {med('sluice.hopper'):.0f} | mat {med('sluice.mat'):.0f} min | earned 180/240/300/360 "
              + " / ".join(str(round((sums[st]['earned_cents'][str(c)].get('median') or 0) / 100)) for c in (10800, 14400, 18000, 21600)), flush=True)
    ok(f"the phase-6 benchmark ran: {seeds} seeds x 360 min x 4 strategies (mining, barrow, pushing, sluice, clean outs, panning, selling, shopping)",
       all(s["seeds"] == seeds for s in sums.values()), f"{time.time() - t0:.0f} s")
    every = [r for rs in runs.values() for r in rs]

    def median_min(values):
        v = sorted(x / 60 for x in values if x is not None)
        return v[len(v) // 2] if v else None

    wb = median_min([r["bought"].get("wheelbarrow") for r in every])
    sl = median_min([r["bought"].get("sluice") for r in every])
    up = median_min([min(r["bought"].get("sluice.hopper", 1e9), r["bought"].get("sluice.mat", 1e9)) for r in every if "sluice.hopper" in r["bought"] or "sluice.mat" in r["bought"]])
    ok("wheelbarrow after ~3 h (median over all strategies' runs 160-225 min; B6 earlier, C6 later by choice)", wb and 160 <= wb <= 225, f"{wb:.0f} min")
    ok("sluice after ~4 h (median 215-285 min; C6 earlier by choice)", sl and 215 <= sl <= 285, f"{sl:.0f} min")
    ok("the first sluice upgrade after ~4,5-5,5 h (median 260-345 min)", up and 260 <= up <= 345, f"{up and round(up)} min")
    # no strategy dominates: the same seeds, compared seed by seed (earned + pouch after 6 h)
    worth = {st: [(r["snap"]["21600"]["earned"] + r["snap"]["21600"].get("pouch", 0)) for r in rs] for st, rs in runs.items()}
    ratio = {}
    for a in worth:
        for b in worth:
            if a < b:
                rr = sorted(x / y for x, y in zip(worth[a], worth[b]) if y)
                ratio[f"{a}/{b}"] = round(rr[len(rr) // 2], 3)
    # the canonical check is the 100-seed run (--full-bench, <= 20 %); a few seeds are a smoke check only
    lim = 1.2 if FULL else 1.6
    ok(f"no strategy dominates: seed by seed, no strategy is more than {round((lim - 1) * 100)} % ahead of another after 6 h (median ratio{'' if FULL else f'; {seeds} seeds: smoke check, canonical = --full-bench'})",
       all(1 / lim <= v <= lim for v in ratio.values()), str(ratio))
    # mechanisation pays, but no 5x: cash per minute at 5-6 h vs the end of phase 5 (150-180 min of the same runs)
    late = sorted((r["snap"]["21600"]["earned"] - r["snap"]["18000"]["earned"]) / 60 for r in every)
    early = sorted((r["snap"]["10800"]["earned"] - r["snap"]["9000"]["earned"]) / 30 for r in every)
    lm, em = late[len(late) // 2], early[len(early) // 2]
    ok("mechanisation pays, but no 5x: cash per minute at 5-6 h is 1,3x-3,5x that of 2,5-3 h (median over all runs)", em > 0 and 1.3 <= lm / em <= 3.5, f"{em / 100:.2f} -> {lm / 100:.2f} EUR/min ({lm / em:.2f}x)")
    pile = {st: sums[st]["pileShareRemoved_pct"].get("median") for st in sums}
    ok("the mountain after 6 h: still almost all there (< 3 % moved)", all(v is not None and v < 3 for v in pile.values()), str({k: round(v, 2) for k, v in pile.items()}))
    gr_close(A)
    ctx.close()
    return sums


def main():
    shots = None
    if "--shots" in sys.argv:
        shots = Path(sys.argv[sys.argv.index("--shots") + 1])
        shots.mkdir(parents=True, exist_ok=True)
    engine = sys.argv[sys.argv.index("--browser") + 1] if "--browser" in sys.argv else "chromium"
    proc_, base, tmp = start_server()
    try:
        user = login(base, "Rinne6")
        with sync_playwright() as p:
            browser = getattr(p, engine).launch(args=GPU_ARGS if engine == "chromium" else [])
            want = lambda part: not ONLY or part in ONLY
            ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
            if want("dig"):
                dig_feel(A, shots)
            if want("barrow"):
                wheelbarrow(A, shots)
            if want("sluice"):
                sluice(A, shots)
            if want("save"):
                saves(A)
            errs = errors(A)
            ok("desktop part ran without page errors", not errs, str(errs[:3]))
            gr_close(A)
            ctx.close()
            if engine == "chromium":
                if want("mobile"):
                    mobile(browser, base, user, shots)
                if want("dev"):
                    dev_pack(browser, shots)
                if want("perf"):
                    perf(browser, base, user, shots)
            if want("bench") and "--no-bench" not in sys.argv:
                economy(browser, base, user)
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
