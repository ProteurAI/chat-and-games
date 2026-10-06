"""End-to-end check of GoldRush phase 8: the premium vertical-slice pass.

  barrow    the push controller: take hold (hands, then lift), a steady straight push (no jitter, the wheel
            on the ground, its turn = the distance), not on the camera (a look aside leaves it, a far look
            turns it gradually, the view clamped), reverse, empty vs full (acceleration, braking, turning,
            top speed), the pile's foot and a dug pit, set down (lower, then let go); the arms at fixed
            lengths with the fists on the grips throughout
  stone     embedded rock: hand / shovel stopped, the pickaxe cracks it visibly and breaks it at the 4th
            hit, the shovel then takes the rubble; exact volume and stone mass; save / reload keeps it
  matrix    no dead material: dirt, compact, gravel and stone each give way to some tool
  loads     container shapes on fixed buffers: the tray (a pile, spread, a broad load, never over the
            rim), the classifier (spread, holed, stones left)
  glb       the optional authored-model path (a .gltf through the vendored loader; a missing one -> fallback)
  hands     every grip with the right hand right and the left hand left (a true mirror: shovel, pickaxe, bucket,
            barrow, pan); the pan and the wash bowl held from outside - no finger or thumb inside the vessel
  pangold   the gold in the pan: in drifts in the low corner on the black sand (no ring / arc), different load
            by load, the amount still following the gold's value
  hud       the material row: bucket, barrow, concentrate - only what you own, the one in your hands
            highlighted, a full one marked
  sound     the new sounds audible, none clipping
  stable    many barrow cycles, 10 000 blade loads: no growth
  mobile/perf/dev   the phone, draw calls / frame rate of the new camp and the barrow, the phase-8 dev pack
  shots     the 17 fixed review viewpoints (--shots DIR --tag before|after; scratch only) - the same
            cameras before and after the pass, so the two sets compare one to one

Runs the server from temp copies (the real database is never touched).

    python tests/e2e/goldrush_premium_e2e.py [--shots DIR] [--tag NAME] [--quick] [--browser webkit] [--only parts]
"""

import json
import math
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from goldrush_e2e import GPU_ARGS, client, errors  # noqa: E402
from goldrush_tools_e2e import SPOT, seeded  # noqa: E402
import goldrush_quality_e2e as Q  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

QUICK = "--quick" in sys.argv
ONLY = set(sys.argv[sys.argv.index("--only") + 1].split(",")) if "--only" in sys.argv else None
TAG = sys.argv[sys.argv.index("--tag") + 1] if "--tag" in sys.argv else "after"
RESULTS = []
GR = "window.__goldrush"
G, proc, fresh = Q.G, Q.proc, Q.fresh

ASSAY = (-12.4, 10.75)                 # goldrush-stations.js: the gold buyer's table
SHED = (-18.2, 13.2)                   # goldrush-world.js: the equipment shed
BARROW_SPOT = (-8.0, 5.0)              # open, flat camp ground for the push shots


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


# ======================================================================
# SHOTS - the fixed review viewpoints
# ======================================================================

def shot(page, shots, name):
    page.screenshot(path=str(shots / f"gr8_{TAG}_{name}.png"))


def look(page, shots, name, cam):
    """the world from a fixed camera (paused: no later frame paints over it)"""
    G(page, f"() => {GR}.walk(0.15, 0, 0)")
    was = G(page, f"() => {GR}.state().paused")
    G(page, f"() => {GR}.setPaused(true)")
    G(page, f"(c) => {GR}.camLook(c)", cam)
    time.sleep(0.15)
    shot(page, shots, name)
    if not was:
        G(page, f"() => {GR}.setPaused(false)")


def cam_at(page, target, dist, bearing, height=1.65, ty=1.0):
    """a camera `dist` m from target (x, z) in the direction `bearing` (rad, 0 = +z), eye height over the ground there"""
    x, z = target[0] + math.sin(bearing) * dist, target[1] + math.cos(bearing) * dist
    h = G(page, f"(p) => {GR}.groundAt ? {GR}.groundAt(p[0], p[1]) : 0", [x, z]) or 0
    th = G(page, f"(p) => {GR}.groundAt ? {GR}.groundAt(p[0], p[1]) : 0", list(target)) or 0
    return {"x": x, "y": h + height, "z": z, "tx": target[0], "ty": th + ty, "tz": target[1]}


def take_barrow(page, ml, yaw=math.pi / 2):
    """the barrow parked on open ground with `ml` of pay dirt, you behind it at the grips, holding it"""
    G(page, f"""async ([x, z, yaw, ml]) => {{ const g = {GR}, m = await import('/games/goldrush/goldrush-devactions.js'), pr = g.procObj();
      g.procBarrowPlace(x, z, yaw); pr.devSetBarrow(ml ? m.devBatch('paydirt', ml) : null);
      const w = pr.barrow, c = w.gripsCenter({{}}), fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      g.pose({{ x: c.x - fx * 0.75, z: c.z - fz * 0.75, yaw, pitch: -0.3 }}); const s = g.stationNow(); g.useStation(); return s; }}""",
      [BARROW_SPOT[0], BARROW_SPOT[1], yaw, ml])


def visual(A, shots):
    fresh(A)
    G(A, f"() => {{ const g = {GR}; g.grant('shovel'); g.grant('pickaxe'); for (const id of ['bucket', 'pan', 'classifier', 'wheelbarrow']) g.procGrant(id); g.equipNow('shovel'); g.setPaused(false); }}")
    # 1-3 pushing the barrow: empty, full, the arms on the grips
    take_barrow(A, 0)
    G(A, f"() => {GR}.walk(1.2, 0, 1)")
    shot(A, shots, "01_barrow_empty_push")
    G(A, f"() => {GR}.procAct('barrow-park')")
    take_barrow(A, 85000)
    G(A, f"() => {GR}.walk(1.2, 0, 1)")
    shot(A, shots, "02_barrow_full_push")
    G(A, f"() => {{ const g = {GR}, s = g.state(); g.pose({{ x: s.x, z: s.z, yaw: s.yaw, pitch: -0.62 }}); }}")
    G(A, f"() => {GR}.walk(0.4, 0, 1)")
    shot(A, shots, "03_barrow_arms_grips")
    G(A, f"() => {GR}.procAct('barrow-park')")
    # 4 the full load seen from beside / above
    G(A, f"() => {GR}.walk(0.3, 0, 0)")
    w = proc(A)["barrow"]
    look(A, shots, "04_barrow_full_load", {"x": w["x"] + 1.3, "y": w["ground"] + 1.75, "z": w["z"] + 1.0, "tx": w["x"] + 0.35, "ty": w["ground"] + 0.45, "tz": w["z"]})
    G(A, f"() => {{ {GR}.procObj().devSetBarrow(null); {GR}.procBarrowPlace(-15.2, 9.2, -Math.PI / 2); }}")
    # 5-6 the classifier loaded / half shaken
    Q.bucket_batch(A, "paydirt", 10000)
    G(A, f"() => {{ const g = {GR}; g.pose({{ x: -15.9, z: 4.8, yaw: Math.PI / 2, pitch: -0.62 }}); g.stationNow(); g.procAct('sieve-load'); }}")
    cls = {"x": -16.3, "y": 1.5, "z": 5.35, "tx": -16.95, "ty": 0.62, "tz": 4.8}
    look(A, shots, "05_classifier_loaded", cls)
    G(A, f"() => {GR}.procWork(1.6)")
    look(A, shots, "06_classifier_mid", cls)
    G(A, f"() => {GR}.procWork(30)")
    G(A, f"() => {GR}.walk(2.0, 0, 0)")
    # 7-8 embedded stone: the shovel, then the pickaxe (first person, right after the hit)
    for name, tool in (("07_stone_shovel", "shovel"), ("08_stone_pickaxe", "pickaxe")):
        G(A, f"(t) => {GR}.equipNow(t)", tool)
        sp = G(A, SPOT, {"want": "stone", "reach": 1.9, "start": 0.4, "core": True})
        if not sp:
            sp = G(A, SPOT, {"want": "stone", "reach": 1.9, "start": 0.1})
        for _ in range(3 if tool == "pickaxe" else 1):
            G(A, f"(t) => {GR}.act({{ visuals: true, tool: t }})", tool)
            G(A, f"() => {GR}.walk(0.25, 0, 0)")
        shot(A, shots, name)
    G(A, f"() => {GR}.equipNow('shovel')")
    # 9-12 the gold buyer and the equipment shop: from ~20 m and close
    look(A, shots, "09_goldbuyer_20m", cam_at(A, ASSAY, 19.0, 2.6, 1.7, 1.2))
    look(A, shots, "10_goldbuyer_close", cam_at(A, ASSAY, 4.2, 2.9, 1.65, 1.0))
    look(A, shots, "11_shop_20m", cam_at(A, SHED, 19.0, 2.45, 1.7, 1.4))
    look(A, shots, "12_shop_close", cam_at(A, SHED, 5.5, 2.95, 1.65, 1.3))
    # 13-14 the mountain close and from the middle distance; 15 the camp
    mp = G(A, Q.MATSPOT, 0)
    if mp:
        look(A, shots, "13_mountain_close", {"x": mp["px"], "y": mp["h"] + 0.8, "z": mp["pz"], "tx": mp["x"], "ty": mp["h"], "tz": mp["z"]})
    look(A, shots, "14_mountain_medium", {"x": 0.0, "y": 2.6, "z": 9.5, "tx": 0.0, "ty": 1.6, "tz": -6.0})
    look(A, shots, "15_camp_overview", {"x": -4.0, "y": 6.5, "z": 15.0, "tx": -15.0, "ty": 0.5, "tz": 5.5})
    # 16-17 the tools in the hands (first person, looking at the ground ahead)
    for name, tool in (("16_shovel_close", "shovel"), ("17_pickaxe_close", "pickaxe")):
        G(A, f"(t) => {GR}.equipNow(t)", tool)
        G(A, f"() => {GR}.pose({{ x: -6.0, z: 7.0, yaw: 2.4, pitch: -0.35 }})")
        G(A, f"() => {GR}.walk(0.5, 0, 0)")
        shot(A, shots, name)
    errs = errors(A)
    ok("SHOTS without page errors", not errs, str(errs[:3]))


# ======================================================================
# BARROW - the push controller and the arms
# ======================================================================

BS = f"() => {GR}.barrowState()"
AR = f"() => {GR}.armReport()"
STATS = f"""() => {{ const g = {GR}, i = g.info(); let n = 0; g.procObj().scene.traverse(() => n++);
  return {{ geo: i.geometries, tex: i.textures, obj: i.sceneObjects, nodes: n, heap: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null }}; }}"""


def arms_ok(rep, reach=None):
    segs = rep["segments"]
    good = all(abs(s - 0.28) < 1e-3 for s in segs[0::2]) and all(abs(s - 0.31) < 1e-3 for s in segs[1::2]) and rep["gripErr"] < 1e-3
    return good and (reach is None or all(rep["reach"]) == reach)


def push_series(page, seconds, my=1.0, mx=0.0, turn=0.0, step=0.1):
    """push for `seconds` (W = my, A/D = mx, looking round at `turn` rad/s), a sample every `step` s"""
    out = []
    t = 0.0
    while t < seconds - 1e-9:
        G(page, f"([s, mx, my, tu]) => {GR}.walk(s, mx, my, tu)", [step, mx, my, turn])
        s = G(page, BS)
        s["arms"] = G(page, AR)
        s["cam"] = G(page, f"() => {GR}.state().yaw")
        s["ground"] = G(page, f"(p) => {GR}.groundAt(p[0], p[1])", [s["x"], s["z"]])
        out.append(s)
        t += step
    return out


def barrow(A):
    fresh(A)
    # paused: only walk() moves the clock - the real frame loop would brake the barrow between two calls
    # (no input there) and make every measurement depend on how busy the machine is
    G(A, f"() => {{ const g = {GR}; g.grant('shovel'); for (const id of ['bucket', 'wheelbarrow']) g.procGrant(id); g.equipNow('shovel'); g.setPaused(true); }}")
    # take hold: hands reach -> grips taken -> legs leave the ground; fast
    take_barrow(A, 0)
    seq = []
    for _ in range(8):
        G(A, f"() => {GR}.walk(0.05, 0, 0)")
        seq.append(G(A, BS))
    gi = next((i for i, s in enumerate(seq) if s["grip"] >= 0.999), None)
    li = next((i for i, s in enumerate(seq) if s["lift"] >= 0.999), None)
    ok("BARROW take hold: the hands reach the grips first, then the legs leave the ground - under half a second",
       gi is not None and li is not None and gi <= li and seq[-1]["mode"] == "pushing" and seq[0]["lift"] < 0.5, str([(round(s["grip"], 2), round(s["lift"], 2), s["mode"]) for s in seq]))
    # straight push: steady, no jitter, the wheel on the ground, its turn follows the distance
    s0 = G(A, BS)
    run = push_series(A, 3.0)
    yaws = [s["yaw"] for s in run]
    vs = [s["v"] for s in run]
    on_ground = all(abs(s["wheelY"] - s["ground"]) < 1e-4 for s in run)
    spin_ok = abs((run[-1]["spin"] - s0["spin"]) * 0.19 - (run[-1]["travel"] - s0["travel"])) < 0.02 * max(1, run[-1]["travel"])
    top = max(vs)
    k_top = next(i for i, v in enumerate(vs) if v >= 0.92 * top)
    rising = all(b >= a - 0.005 for a, b in zip(vs[:k_top + 1], vs[1:k_top + 1]))
    steady = max(vs[k_top:]) - min(vs[k_top:]) < 0.1 * top
    # frame by frame at full speed: the speed may follow the ground, but never flip back and forth
    fr = push_series(A, 1.0, step=1 / 60)
    dv = [b["v"] - a["v"] for a, b in zip(fr, fr[1:])]
    flips = sum(1 for a, b in zip(dv, dv[1:]) if a * b < 0 and abs(a) > 1e-3 and abs(b) > 1e-3)
    ok("BARROW a straight push is steady: speed rises without a wobble, then holds (no frame-to-frame jitter); the heading stays put, the wheel rolls on the ground (its turn = the distance)",
       max(yaws) - min(yaws) < 1e-3 and rising and steady and flips <= 6 and on_ground and spin_ok,
       f"v {vs[0]:.2f}->{top:.2f} (reached at {(k_top + 1) * 0.1:.1f} s, then +-{(max(vs[k_top:]) - min(vs[k_top:])) / 2:.3f}), {flips} reversals in 60 frames, yaw spread {max(yaws) - min(yaws):.4f}, travel {run[-1]['travel'] - s0['travel']:.2f} m")
    ok("BARROW the arms keep their lengths (forearm 0,28 m, upper arm 0,31 m) and the fists stay on the grips while pushing",
       all(arms_ok(s["arms"]) for s in run), str(run[-1]["arms"]))
    # look round: a little does not move the barrow, a lot turns it after you, gradually; the camera stays within reach
    G(A, f"() => {GR}.walk(1.5, 0, 0)")
    y0 = G(A, BS)["yaw"]
    G(A, f"() => {GR}.walk(0.3, 0, 0, 1.0)")
    small = G(A, BS)["yaw"] - y0
    cam_small = G(A, f"() => {GR}.state().yaw") - y0
    G(A, f"() => {GR}.walk(0.6, 0, 0, -1.0)")
    y1 = G(A, BS)["yaw"]
    big = push_series(A, 1.0, my=0.0, turn=1.6)
    flick = push_series(A, 0.1, my=0.0, turn=40.0, step=0.05)
    rates = [abs(b["yaw"] - a["yaw"]) / 0.1 for a, b in zip(big, big[1:])]
    off = max(abs(math.atan2(math.sin(s["cam"] - s["yaw"]), math.cos(s["cam"] - s["yaw"]))) for s in big + flick)
    ok("BARROW not on the camera: a glance aside (0,3 rad) leaves it where it is; looking far off turns it after you gradually (rate-limited), never instantly; even a fast flick leaves the view at most ~48 deg off it",
       abs(small) < 1e-3 and abs(cam_small) > 0.25 and 0 < max(rates) < 1.7 and abs(big[-1]["yaw"] - y1) > 0.15 and off < 0.86,
       f"glance: barrow {small:.4f}, view {cam_small:.2f}; far look: rates max {max(rates):.2f} rad/s, turned {big[-1]['yaw'] - y1:.2f}; view off at most {off:.2f}")
    # reverse
    G(A, f"() => {GR}.walk(0.8, 0, -1)")
    ok("BARROW backing up works (S)", G(A, BS)["v"] < -0.1, str(round(G(A, BS)["v"], 2)))
    G(A, f"() => {GR}.walk(1.0, 0, 0)")
    # empty vs full: acceleration, braking, turning
    feel = {}
    for name, ml in (("empty", 0), ("full", 85000)):
        G(A, f"() => {GR}.procAct('barrow-park')")
        G(A, f"() => {GR}.walk(0.5, 0, 0)")
        take_barrow(A, ml)
        G(A, f"() => {GR}.walk(0.5, 0, 0)")
        acc = push_series(A, 0.6)
        v06 = acc[-1]["v"]
        push_series(A, 2.4)
        vtop = G(A, BS)["v"]
        b = push_series(A, 0.5, my=0.0)
        decel = (vtop - b[0]["v"]) / 0.1
        G(A, f"() => {GR}.walk(1.5, 0, 0)")
        tu = push_series(A, 0.8, my=0.0, turn=2.0)
        feel[name] = {"v06": round(v06, 2), "vtop": round(vtop, 2), "decel": round(decel, 2), "turn": round(abs(tu[-1]["yaw"] - tu[0]["yaw"]) / 0.7, 2)}
    e, f = feel["empty"], feel["full"]
    # (phase 9 handling pass: heavy is not hard to steer - the weight is in the push, the stop and the slope;
    # a full barrow turns only a little more lazily)
    ok("BARROW full is more than a slower walk: slower to get going, needs more room to stop, turns a little more lazily (and a lower top speed)",
       f["v06"] < e["v06"] * 0.75 and f["decel"] < e["decel"] * 0.7 and f["turn"] < e["turn"] * 0.95 and f["vtop"] < e["vtop"], json.dumps(feel))
    # the wheel on dug ground: a pit dug ahead - the wheel drops into it
    G(A, f"() => {GR}.procAct('barrow-park')")
    G(A, f"() => {GR}.walk(0.5, 0, 0)")
    errs = errors(A)
    ok("BARROW part without page errors", not errs, str(errs[:3]))


def place_take(page, x, z, yaw):
    """the barrow (as it is) parked at the wheel position x/z heading yaw, you behind its grips, holding it"""
    G(page, f"""([x, z, yaw]) => {{ const g = {GR}, pr = g.procObj(); g.procBarrowPlace(x, z, yaw);
      const w = pr.barrow, c = w.gripsCenter({{}}), fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      g.pose({{ x: c.x - fx * 0.75, z: c.z - fz * 0.75, yaw, pitch: -0.3 }}); g.stationNow(); g.useStation(); }}""", [x, z, yaw])
    G(page, f"() => {GR}.walk(0.5, 0, 0)")


def barrow_terrain(A):
    """the wheel on the ground as it is: through a dug pit, against the pile's flank, up the loading ramp"""
    fresh(A)
    G(A, f"() => {{ const g = {GR}; g.grant('shovel'); for (const id of ['bucket', 'wheelbarrow']) g.procGrant(id); g.equipNow('shovel'); g.setPaused(true); }}")
    # a pit dug into the flat apron in front of the pile: the wheel rolls down into it and out again
    pit = {"px": -10.45, "pz": 4.5, "x": -9.25, "z": 4.5}
    g0 = G(A, f"(p) => {GR}.groundAt(p[0], p[1])", [pit["x"], pit["z"]])
    for _ in range(10):
        Q.aim_point(A, pit)
        G(A, f"() => {GR}.act({{ visuals: false, tool: 'shovel' }})")
    g1 = G(A, f"(p) => {GR}.groundAt(p[0], p[1])", [pit["x"], pit["z"]])
    place_take(A, -11.3, 4.5, -math.pi / 2)
    run = push_series(A, 2.6, step=0.05)
    on_ground = all(abs(s["wheelY"] - s["ground"]) < 1e-4 for s in run)
    near = [s for s in run if math.hypot(s["x"] - pit["x"], s["z"] - pit["z"]) < 0.2]
    past = run[-1]["x"] > pit["x"] + 0.5
    ok("BARROW the wheel rides the dug ground: across a fresh pit it drops in with the ground (not the old surface) and rolls out again",
       g1 < g0 - 0.03 and near and min(s["wheelY"] for s in near) < g0 - 0.02 and on_ground and past,
       f"ground {g0:.3f} -> {g1:.3f}, wheel lowest {min((s['wheelY'] for s in near), default=None)}, out past it {past} (x {run[-1]['x']:.2f})")
    ok("BARROW on rough / dug ground the arms keep their lengths and the fists their grips", all(arms_ok(s["arms"]) for s in run), str(run[-1]["arms"]))
    G(A, f"() => {GR}.procAct('barrow-park')")
    G(A, f"() => {GR}.walk(0.5, 0, 0)")
    # straight at the pile's flank (~35-40 deg): it stops at the foot - the wheel does not climb a wall
    place_take(A, -9.03, 5.6, math.atan2(-7.0, 9.0))
    run = push_series(A, 4.0)
    stop = run[-1]
    ok("BARROW against the pile's flank it stops at the foot (no climbing a slope steeper than ~32 deg), the wheel on the ground, no jump",
       stop["v"] == 0 and max(s["ground"] for s in run) < 0.2 and all(abs(s["wheelY"] - s["ground"]) < 1e-4 for s in run)
       and max(math.hypot(b["x"] - a["x"], b["z"] - a["z"]) for a, b in zip(run, run[1:])) < 0.4,
       f"stopped at ground {stop['ground']:.3f} m, v {stop['v']}")
    G(A, f"() => {GR}.procAct('barrow-park')")
    G(A, f"() => {GR}.walk(0.5, 0, 0)")
    # up the loading ramp (grade 0,40) to the bulk hopper: slower than on the flat, a full one much slower
    import goldrush_auto_e2e as AU
    AU.automation(A, feeder=False)
    G(A, f"() => {GR}.setPaused(true)")
    up = {}
    for name, ml in (("empty", 0), ("full", 85000)):
        G(A, f"""async (ml) => {{ const m = await import('/games/goldrush/goldrush-devactions.js'); {GR}.procObj().devSetBarrow(ml ? m.devBatch('paydirt', ml) : null); }}""", ml)
        place_take(A, AU.RAMP_FOOT_WHEEL[0], AU.RAMP_FOOT_WHEEL[1] - 3.0, math.pi)
        run = push_series(A, 7.0)
        flat = [s["v"] for s in run if s["ground"] < 0.01]
        ramp = [s for s in run if 0.9 < s["ground"] < 1.6]
        up[name] = {"flat": round(max(flat, default=0), 2), "ramp": round(max((s["v"] for s in ramp), default=0), 2),
                    "top": round(max(s["ground"] for s in run), 2), "onGround": all(abs(s["wheelY"] - s["ground"]) < 1e-4 for s in run)}
        G(A, f"() => {GR}.procAct('barrow-park')")
        G(A, f"() => {GR}.walk(0.5, 0, 0)")
    e, f = up["empty"], up["full"]
    ok("BARROW up the loading ramp (grade 0,40): the wheel on the planks, slower uphill than on the flat - a full barrow much slower (it still makes it up)",
       e["onGround"] and f["onGround"] and 0 < e["ramp"] < e["flat"] * 0.9 and 0 < f["ramp"] < f["flat"] * 0.8 and f["ramp"] < e["ramp"] * 0.7 and e["top"] > 1.5 and f["top"] > 1.5,
       json.dumps(up))
    # set down: the handles go down onto the legs, then the hands let go
    place_take(A, -9.0, 6.5, -math.pi / 2)
    G(A, f"() => {GR}.procAct('barrow-park')")
    seq = []
    for _ in range(10):
        G(A, f"() => {GR}.walk(0.05, 0, 0)")
        seq.append(G(A, BS))
    li = next((i for i, s in enumerate(seq) if s["lift"] <= 0.001), None)
    gi = next((i for i, s in enumerate(seq) if s["grip"] <= 0.001), None)
    s = seq[-1]
    ok("BARROW set down: the handles go down onto the legs first, then the hands let go - under half a second",
       s["mode"] == "parked" and li is not None and gi is not None and li <= gi, str([(round(x["lift"], 2), round(x["grip"], 2), x["mode"]) for x in seq]))
    errs = errors(A)
    ok("BARROW terrain part without page errors", not errs, str(errs[:3]))


# ======================================================================
# STONE - embedded rock: a few pick hits break it, then any tool works it
# ======================================================================

def stone_hits(page, tool, n):
    out = []
    for _ in range(n):
        r = G(page, f"(t) => {{ const g = {GR}; const a = g.act({{ visuals: false, tool: t }}); const p = g.probe(); return {{ kind: a && a.kind, kg: a && a.massKg, ml: (a && a.volumeMl) || 0, rem: (a && a.removed) || 0, stoneKg: (a && a.massByMat) ? a.massByMat[3] : 0, mat: a && a.material, blocked: a && a.blocked, crack: p && p.crack, rubble: p && p.rubble, at: p && p.at }}; }}", tool)
        out.append(r)
    return out


def stone(A):
    fresh(A)
    G(A, f"() => {{ const g = {GR}; g.grant('shovel'); g.grant('pickaxe'); g.setPaused(false); }}")
    sp = G(A, SPOT, {"want": "stone", "reach": 1.9, "start": 0.4, "core": True})
    ok("STONE a solid stone face in reach (the test seed)", sp is not None, str(sp))
    if not sp:
        return
    vol0 = G(A, f"() => {GR}.volume().delta")
    stone0 = G(A, f"() => {GR}.economy().stats.massG.stone")
    hand = stone_hits(A, "hand", 2)
    shovel = stone_hits(A, "shovel", 2)
    ok("STONE intact rock: hand and shovel are stopped (no removal, the crack does not move)",
       all(h["blocked"] for h in hand + shovel) and all((h["crack"] or 0) == 0 for h in hand + shovel), str(hand + shovel))
    picks = stone_hits(A, "pickaxe", 6)
    cracks = [p["crack"] for p in picks]
    broke = next((i for i, p in enumerate(picks) if p["rubble"]), None)
    ok("STONE the pickaxe: every hit shows - the crack grows (25 / 50 / 75 %) and the patch breaks into rubble at the 4th hit (never a 100-hit grind)",
       broke is not None and broke <= 4 and all(b > a for a, b in zip(cracks[:broke], cracks[1:broke])) and cracks[0] > 0, str(picks))
    kg_before = sum(p["kg"] or 0 for p in picks[:broke])
    ok("STONE the breaking hit takes a real bite (the rubble comes away), the hits before only chips",
       picks[broke]["kg"] > 3 * max(p["kg"] or 0 for p in picks[:broke]) and kg_before < 0.6, f"chips {kg_before:.2f} kg, break {picks[broke]['kg']:.2f} kg")
    # the shovel on the rubble: now it works
    G(A, f"() => {GR}.equipNow('shovel')")
    sh = stone_hits(A, "shovel", 2)
    ok("STONE after the break the shovel takes the rubble (it skidded off the intact rock before)", any((s["kg"] or 0) > 0.3 and not s["blocked"] for s in sh), str(sh))
    # mass: what came off is exactly what left the ground; the stone booked as stone
    vol1 = G(A, f"() => {GR}.volume().delta")
    stone1 = G(A, f"() => {GR}.economy().stats.massG.stone")
    all_hits = hand + shovel + picks + sh
    removed_ml = sum(h["rem"] for h in all_hits) * 1e6
    stone_kg = sum(h["stoneKg"] for h in all_hits)
    rubble_mat = [h["mat"] for h in picks[broke + 1:] + sh]
    ok("STONE exact: the terrain lost exactly the volume the strokes report, every gram of the rock is booked as stone - the broken rubble too (it is reported, sounds and looks like stone)",
       abs(-(vol1 - vol0) * 1e6 - removed_ml) < 0.5 and abs((stone1 - stone0) / 1000 - stone_kg) < 0.005 and stone_kg > 0.5 and all(m == 3 for m in rubble_mat),
       f"terrain {-(vol1 - vol0) * 1e6:.1f} ml vs strokes {removed_ml:.1f} ml; stone {stone1 - stone0} g vs {stone_kg * 1000:.0f} g; rubble strokes report {rubble_mat}")
    # save / reload keeps the crack and the rubble: every column round the break, as it was
    at = picks[broke]["at"]
    AROUND = f"""(p) => {{ const out = []; for (let j = -5; j <= 5; j++) for (let i = -5; i <= 5; i++) out.push({GR}.stoneAt(p.x + i * 0.125, p.z + j * 0.125)); return out; }}"""
    before = G(A, AROUND, at)
    Q.reopen(A)
    G(A, f"() => {GR}.setPaused(false)")
    after = G(A, AROUND, at)
    n_rub = sum(1 for c in before if c["rubble"] > 0)
    n_crk = sum(1 for c in before if 0 < c["crack"] < 1)
    ok("STONE save / reload: round the break every column comes back as it was - broken rubble still rubble, half-cracked rock still cracked",
       before == after and n_rub > 0 and n_crk > 0, f"{n_rub} rubble / {n_crk} cracked columns of {len(before)}; same after reload: {before == after}")
    errs = errors(A)
    ok("STONE part without page errors", not errs, str(errs[:3]))


def matrix(A):
    """no dead state: every material can be worked by some tool, every refusal says why"""
    fresh(A)
    G(A, f"() => {{ const g = {GR}; g.grant('shovel'); g.grant('pickaxe'); g.setPaused(false); }}")
    rows = {}
    for mat in ("dirt", "compactDirt", "gravel", "stone"):
        sp = G(A, SPOT, {"want": mat, "reach": 1.9, "start": 0.3, "fresh": True, "core": mat == "stone"})
        if not sp:
            rows[mat] = None
            continue
        row = {}
        for tool in ("hand", "shovel", "pickaxe"):
            G(A, f"(s) => {GR}.aimAt(s)", {"x": sp["x"], "z": sp["z"], "yaw": sp["yaw"], "pitch": sp["pitch"]})
            r = G(A, f"(t) => {{ const a = {GR}.act({{ visuals: false, tool: t }}); const p = {GR}.probe(); return a && {{ kg: +a.massKg.toFixed(3), blocked: a.blocked, crack: p && p.crack, rubble: p && p.rubble }}; }}", tool)
            row[tool] = r
        rows[mat] = row
    dead = [m for m, r in rows.items() if r and not any((v and ((v["kg"] or 0) > 0 or (v["crack"] or 0) > 0 or v["rubble"])) for v in r.values())]
    ok("MATRIX no dead material: dirt, compact earth, gravel and embedded stone each give way to at least one tool (removal or visible cracking)",
       not dead and all(rows.values()), json.dumps(rows)[:600])
    st = rows.get("stone") or {}
    ok("MATRIX stone: hand and shovel blocked, the pickaxe makes visible progress", st and st["hand"]["blocked"] and st["shovel"]["blocked"] and st["pickaxe"]["crack"] > 0, json.dumps(st))


# ======================================================================
# LOADS - container shapes on fixed buffers
# ======================================================================

def loads(A):
    fresh(A)
    Q.kit(A, ["shovel", "bucket", "pan", "classifier", "wheelbarrow"])
    G(A, f"() => {GR}.walk(0.3, 0, 0)")
    s0 = G(A, STATS)
    r = G(A, f"""() => {{
      const pr = {GR}.procObj(), w = pr.barrow, MM = pr.mech, L = w.group.userData.load, geo = L.geo, arr = geo.attributes.position.array, comp = [5000, 2000, 2500, 600];
      const fills = [];
      for (let c = 0; c < 20; c++) for (let k = 0; k <= 100; k++) {{
        MM.setBarrowFill(w.group, k / 100, comp);
        if (c === 0 && (k === 12 || k === 47 || k === 100)) {{
          const a = L.geo.attributes.position.array, col = L.geo.attributes.color.array;
          let top = -1, edgeTop = -1, vis = 0;
          for (let v = 0; v < a.length / 3; v++) {{
            if (col[v * 4 + 3] < 0.5) continue;
            vis++;
            const x = a[v * 3], y = a[v * 3 + 1], z = a[v * 3 + 2];
            top = Math.max(top, y);
            if (Math.abs(x) > 0.31 || z < 0.15 || z > 1.0) edgeTop = Math.max(edgeTop, y);
          }}
          fills.push({{ k, top: +top.toFixed(3), edgeTop: +edgeTop.toFixed(3), vis, lumps: L.lumps.count }});
        }}
      }}
      MM.setBarrowFill(w.group, 0, null);
      return {{ same: L.geo === geo && geo.attributes.position.array === arr, fills, off: !L.visible }};
    }}""")
    G(A, f"() => {GR}.walk(0.3, 0, 0)")
    s1 = G(A, STATS)
    fl = r["fills"]
    rim = 0.33 + 0.3
    ok("LOADS barrow filled 0..85 l 20 times: the same buffers, no new geometry / texture / object",
       r["same"] and r["off"] and (s1["geo"], s1["tex"], s1["nodes"]) == (s0["geo"], s0["tex"], s0["nodes"]), f"{s0} -> {s1}")
    ok("LOADS the tray load: a small pile, then spread, full a broad load a hand's breadth over the rim, never hanging over the rim at the walls",
       fl[0]["vis"] < fl[1]["vis"] < fl[2]["vis"] and fl[2]["top"] < rim + 0.16 and fl[2]["top"] > rim and fl[2]["edgeTop"] <= rim + 0.02, json.dumps(fl))
    # classifier: spread across the screen, then the coarse remainder
    Q.bucket_batch(A, "paydirt", 10000)
    G(A, f"() => {{ const g = {GR}; g.pose({{ x: -15.9, z: 4.8, yaw: Math.PI / 2, pitch: -0.62 }}); g.procAct('sieve-load'); }}")
    cl = []
    for t in (0, 1.6, 30):
        if t:
            G(A, f"(t) => {GR}.procWork(t)", t)
            G(A, f"() => {GR}.walk(0.1, 0, 0)")
        cl.append(G(A, f"() => {{ const H = {GR}.procObj().cls.userData.heapLoad; return {{ vis: H.stats.visibleVerts, maxY: +H.stats.maxY.toFixed(3), lumps: H.stats.lumps, n: H.nx * H.nz }}; }}"))
    ok("LOADS classifier: spread shallow across the screen (no mound: under 6 cm), thinner and holed while shaken, at the end mostly stones",
       cl[0]["vis"] > cl[0]["n"] * 0.35 and cl[0]["maxY"] < 0.075 and cl[1]["vis"] < cl[0]["vis"] and cl[2]["vis"] < cl[0]["vis"] * 0.5 and cl[2]["lumps"] >= 5, json.dumps(cl))
    errs = errors(A)
    ok("LOADS part without page errors", not errs, str(errs[:3]))


# ======================================================================
# GLB - the optional authored-model path
# ======================================================================

def glb_data_url():
    import base64
    import struct
    buf = struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)
    gltf = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": "tri"}],
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
            "buffers": [{"byteLength": len(buf), "uri": "data:application/octet-stream;base64," + base64.b64encode(buf).decode()}],
            "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(buf)}],
            "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [0, 0, 0], "max": [1, 1, 0]}]}
    return "data:model/gltf+json;base64," + base64.b64encode(json.dumps(gltf).encode()).decode()


def glb(A):
    fresh(A)
    url = glb_data_url()
    m = G(A, f"(u) => {GR}.assetModel(u)", url)
    ok("GLB an authored model (.gltf) loads through the asset manager (vendored r176 GLTFLoader, no CDN), cached, placeable", m and m["meshes"] == 1 and m["cached"] and m["instance"], str(m))
    miss = G(A, f"() => {GR}.assetModel('/games/goldrush/models/not-there.glb')")
    fb = G(A, f"() => {GR}.assetModel('/games/goldrush/models/not-there.glb', true)")
    ok("GLB a missing optional model is no error: null, and modelOr builds the procedural fallback", miss is None and fb and fb["name"] == "procedural", f"{miss} / {fb}")
    errs = errors(A)
    ok("GLB part without page errors", not errs, str(errs[:3]))


# ======================================================================
# HANDS - left is left, nothing inside the pan
# ======================================================================

HANDS = f"""() => {{ const H = {GR}.procObj().hands, r = H.right.root, l = H.left.root; r.updateMatrix(); l.updateMatrix();
  return {{ detR: +r.matrix.determinant().toFixed(3), detL: +l.matrix.determinant().toFixed(3) }}; }}"""

# fingertips, finger joints and thumb tips of both gloves in the held vessel's frame: how deep inside (m)
# its inner volume, with a fingertip's radius as skin (measured after real frames: the hands are posed there)
INSIDE = r"""async (tool) => {
  const pm = await import('/games/goldrush/goldrush-processmodels.js'), G = window.__goldrush;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
  const H = G.procObj().hands, grp = H.heldGroup, T = H.THREE, P = pm.PAN, B = pm.BOWL, SK = 0.009;
  if (!grp) return null;
  const inv = new T.Matrix4().copy(grp.matrixWorld).invert();
  const inside = (p) => {
    const r = Math.hypot(p.x, p.z), V = tool === 'bowl' ? { r0: B.r0, r1: B.r1, h: B.h, base: B.base } : { r0: P.r0, r1: P.r1, h: P.h, base: 0 };
    if (p.y > V.base + V.h) return 0;
    const floor = r <= V.r0 ? V.base : V.base + (r - V.r0) * V.h / (V.r1 - V.r0), rimR = V.r0 + (V.r1 - V.r0) * Math.max(0, p.y - V.base) / V.h;
    return p.y > floor - SK && r < rimR + SK ? Math.min(p.y - floor + SK, rimR + SK - r) : 0;
  };
  let worst = 0;
  for (const g of [H.right, H.left]) {
    const pts = [];
    for (const f of g.fingers) { const s2 = f.mid.children[0]; pts.push(f.mid.localToWorld(new T.Vector3(0, 0, s2.position.z * 2.2)), f.mid.localToWorld(new T.Vector3(0, 0, 0))); }
    const tm = g.thumbMid; pts.push(tm.localToWorld(new T.Vector3(0, 0, tm.children[0].position.z * 2.2)));
    for (const p of pts) worst = Math.max(worst, inside(p.applyMatrix4(inv)));
  }
  return +worst.toFixed(4);
}"""


def hands(A):
    fresh(A)
    G(A, f"() => {{ const g = {GR}; g.grant('shovel'); g.grant('pickaxe'); for (const id of ['bucket', 'pan', 'wheelbarrow']) g.procGrant(id); g.setPaused(false); }}")
    dets = {}
    for tool in ("shovel", "pickaxe"):
        G(A, f"(t) => {GR}.equipNow(t)", tool)
        G(A, f"() => {GR}.pose({{ x: -6.0, z: 7.0, yaw: 2.4, pitch: -0.35 }})")
        G(A, f"() => {GR}.walk(0.4, 0, 0)")
        time.sleep(0.2)
        dets[tool] = G(A, HANDS)
    Q.bucket_batch(A, "paydirt", 6000, False)
    G(A, f"() => {{ const g = {GR}, b = g.procObj().bucket; g.pose({{ x: b.x + 0.9, z: b.z, yaw: Math.PI / 2, pitch: -0.5 }}); g.stationNow(); g.procAct('bucket-pick'); }}")
    time.sleep(0.3)
    dets["bucket"] = G(A, HANDS)
    G(A, f"() => {GR}.procAct('bucket-drop')")
    take_barrow(A, 30000)
    time.sleep(0.3)
    dets["barrow"] = G(A, HANDS)
    G(A, f"() => {GR}.procAct('barrow-park')")
    G(A, f"() => {GR}.walk(0.4, 0, 0)")
    deep = {}
    for tool in ("pan", "bowl"):
        G(A, f"(b) => {{ {GR}.procObj().devBowl = b; }}", tool == "bowl")
        Q.bucket_batch(A, "paydirt", 10000)
        Q.at_trough(A)
        G(A, f"() => {GR}.procAct('pan-fill')")
        G(A, f"() => {GR}.procWork(2.0)")
        if tool == "pan":
            dets["pan"] = G(A, HANDS)
        mid = G(A, INSIDE, tool)
        G(A, f"() => {GR}.procWork(30)")
        end = G(A, INSIDE, tool)
        deep[tool] = (mid, end)
        G(A, f"() => {GR}.procCollect()")
        G(A, f"() => {GR}.walk(0.3, 0, 0)")
    G(A, f"() => {{ {GR}.procObj().devBowl = false; }}")
    ok("HANDS every grip: the right glove is a right hand, the left one a true mirror (left hand left - thumb on its own side): shovel, pickaxe, bucket, barrow, pan",
       all(d["detR"] > 0.99 and d["detL"] < -0.99 for d in dets.values()) and len(dets) == 5, json.dumps(dets))
    ok("HANDS the gold pan and the wash bowl are held from outside: no fingertip, finger joint or thumb inside the vessel (mid-wash and at the end, 9 mm skin)",
       all(v is not None and v == 0 for pair in deep.values() for v in pair), json.dumps(deep))
    errs = errors(A)
    ok("HANDS part without page errors", not errs, str(errs[:3]))


# ======================================================================
# PANGOLD - drifts on the black sand, never a geometric arc
# ======================================================================

FLAKES = r"""() => {
  const pr = window.__goldrush.procObj(), P = pr._washHand().userData, F = P.flakes, T = pr.THREE, m = new T.Matrix4(), v = new T.Vector3();
  const pts = [];
  for (let i = 0; i < F.count; i++) { F.getMatrixAt(i, m); v.setFromMatrixPosition(m); pts.push([+v.x.toFixed(4), +v.z.toFixed(4)]); }
  return { n: F.count, want: pr._flakeCount(), pts, sand: P.sand && P.sand.visible, seed: pr._panStart && pr._panStart.seed };
}"""


def pangold(A):
    fresh(A)
    G(A, f"() => {{ const g = {GR}; g.grant('shovel'); for (const id of ['bucket', 'pan']) g.procGrant(id); g.setPaused(false); }}")
    loads = []
    for kind in ("paydirt", "paydirt", "dirt"):
        Q.bucket_batch(A, kind, 10000)
        Q.at_trough(A)
        G(A, f"() => {GR}.procAct('pan-fill')")
        G(A, f"() => {GR}.procWork(30)")
        r = G(A, FLAKES)
        r["cents"] = G(A, f"() => {GR}.procCollect()").get("cents", 0)
        G(A, f"() => {GR}.walk(0.3, 0, 0)")
        loads.append(r)
    stats = []
    for r in loads:
        pts = r["pts"]
        rs = [math.hypot(x, z) for x, z in pts]
        mean = sum(rs) / max(1, len(rs))
        sd = (sum((q - mean) ** 2 for q in rs) / max(1, len(rs))) ** 0.5
        far = sum(1 for x, z in pts if z < 0.012) / max(1, len(pts))
        inb = all(q <= 0.11 * 0.96 for q in rs)
        stats.append({"n": r["n"], "want": r["want"], "cents": r["cents"], "radialSd": round(sd, 4), "far": round(far, 2), "inBottom": inb, "sand": r["sand"]})
    a, b, c = loads
    ok("PANGOLD the gold lies in drifts on the black sand in the low corner (the far side of the bottom), never a ring or an arc: the specks spread radially as well (sd > 6 mm), every one on the bottom",
       all(st["n"] >= 3 and st["far"] >= 0.85 and st["inBottom"] and st["radialSd"] > 0.006 and st["sand"] for st in stats[:2]), json.dumps(stats))
    ok("PANGOLD each load lies differently (not one stamped pattern); the amount still follows the gold's value (as many specks as the pan reveals)",
       a["pts"] != b["pts"] and all(r["n"] == r["want"] for r in loads), f"seeds {[r['seed'] for r in loads]}, counts {[(r['n'], r['want']) for r in loads]}")


# ======================================================================
# HUD - where the material is
# ======================================================================

ROW = """() => Object.fromEntries([...document.querySelectorAll('.gr-mat')].map((c) => [c.dataset.mat, c.hidden ? null : { text: c.querySelector('.gr-mat-value').textContent, active: c.classList.contains('is-active'), full: c.classList.contains('is-full') }]))"""


def hud(A):
    fresh(A)
    G(A, f"() => {{ const g = {GR}; g.grant('shovel'); g.equipNow('shovel'); g.setPaused(false); }}")
    time.sleep(0.3)
    none = G(A, ROW)
    nodes0 = G(A, "() => document.querySelectorAll('.gr-root *').length")
    G(A, f"() => {GR}.procGrant('bucket')")
    Q.bucket_batch(A, "paydirt", 6200, False)
    time.sleep(0.3)
    bucket = G(A, ROW)
    for id in ("pan", "classifier", "wheelbarrow"):
        G(A, f"(i) => {GR}.procGrant(i)", id)
    G(A, f"""async () => {{ const m = await import('/games/goldrush/goldrush-devactions.js'), pr = {GR}.procObj(); pr.devSetBarrow(m.devBatch('paydirt', 85000)); pr.tub.absorb(m.devBatch('paydirt', 1800)); }}""")
    G(A, f"() => {{ const g = {GR}, b = g.procObj().bucket; g.pose({{ x: b.x + 0.9, z: b.z, yaw: Math.PI / 2, pitch: -0.3 }}); g.stationNow(); g.procAct('bucket-pick'); }}")
    time.sleep(0.4)
    carry = G(A, ROW)
    G(A, f"() => {GR}.procAct('bucket-drop')")
    take_barrow(A, 85000)
    time.sleep(0.4)
    push = G(A, ROW)
    G(A, f"() => {GR}.procAct('barrow-park')")
    time.sleep(0.3)
    nodes1 = G(A, "() => document.querySelectorAll('.gr-root *').length")
    ok("HUD material row: nothing before you own a container; the bucket once bought (its litres)", all(v is None for v in none.values()) and bucket["bucket"] and bucket["bucket"]["text"].startswith("6,2/10 l") and bucket["barrow"] is None and bucket["conc"] is None,
       f"{none} / {bucket}")
    ok("HUD material row: bucket, barrow and the concentrate ready to pan side by side - the one in your hands highlighted (with its weight), a full one marked",
       carry["bucket"]["active"] and "kg" in carry["bucket"]["text"] and carry["barrow"]["text"].startswith("85/85 l") and carry["barrow"]["full"] and carry["conc"]["text"] == "1,8 l"
       and push["barrow"]["active"] and "kg" in push["barrow"]["text"] and not push["bucket"]["active"], f"{carry} / {push}")
    ok("HUD material row: built once - updating it adds no page nodes", abs(nodes1 - nodes0) <= 6, f"{nodes0} -> {nodes1}")


# ======================================================================
# SOUND / DEV / PERF
# ======================================================================

def sound(A):
    from goldrush_tools_e2e import AUDIO_LEVELS
    kinds = ["barrow_take", "barrow_roll", "barrow_bump", "stone_scrape", "rock_chip", "rock_fracture", "dump", "sell"]
    lv = A.evaluate(AUDIO_LEVELS, kinds)
    if lv is None:
        print("  sound: no OfflineAudioContext here - levels not measured", flush=True)
        return
    ok("SOUND the new feedback sounds (barrow take / roll / bump, stone scrape, rock chip / fracture) are audible and none clips",
       all(-40 <= v <= -0.5 for v in lv.values()), json.dumps(lv))


def dev_pack(browser):
    import tempfile
    import goldrush_dev_e2e as DEV
    from goldrush_tools_e2e import open_game
    logdir = Path(tempfile.mkdtemp(prefix="gr8_devpack_"))
    on, base, tmp, log = DEV.start_dev_server(DEV.CODE, logdir / "server.log")
    try:
        user = login(base, "Dev8")
        ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
        open_game(A)
        t0 = time.time()
        DEV.open_panel(A)
        ids = []
        for cat in ("quick", "world"):
            DEV.tab(A, cat)
            ids += G(A, "() => [...document.querySelectorAll('[data-dev-cmd], [data-dev-toggle]')].map((b) => b.dataset.devCmd || b.dataset.devToggle)")
        want = ["quick.phase8", "p8.barrowEmpty", "p8.barrowHalf", "p8.barrowFull", "p8.barrowRough", "p8.dirt", "p8.compact", "p8.gravel", "p8.stone",
                "p8.boulder", "p8.streak", "p8.classifier", "p8.goldbuyer", "p8.shop", "p8.camp"]
        ok("DEV the phase-8 actions are in the panel (preset, barrow empty / half / full / slope, materials, stone, boulder, streak, classifier, gold buyer, shop, camp)",
           all(w in ids for w in want), str([w for w in want if w not in ids]))
        DEV.tab(A, "quick")
        r = DEV.cmd(A, "quick.phase8")
        p = proc(A)
        ok("DEV preset 'Phase 8 Premium-QA': the kit and the barrow in front of you", r and not r["error"] and all(x in p["owned"] for x in ("bucket", "pan", "classifier", "wheelbarrow")), str(r))
        DEV.tab(A, "world")
        res = {cid: DEV.cmd(A, cid) for cid in want[1:]}
        DEV.close_panel(A)
        bad = {k: v for k, v in res.items() if not v or v.get("error")}
        ok("DEV every phase-8 button runs - all of it in well under 2 minutes", not bad and time.time() - t0 < 120, f"{time.time() - t0:.0f} s, errors {bad}")
        errs = errors(A)
        ok("DEV part without page errors", not errs, str(errs[:3]))
        Q.close(A)
        ctx.close()
    finally:
        on.terminate()


def perf(browser, base, user):
    import goldrush_mech_e2e as M6
    from goldrush_e2e import PHONE
    out = {}
    views = (("booth", {"x": -9.2, "z": 3.4, "yaw": 0.42, "pitch": -0.05}), ("shop", {"x": -15.2, "z": 5.0, "yaw": 0.4, "pitch": 0.0}),
             ("camp", {"x": -6.0, "z": 3.0, "yaw": 0.75, "pitch": -0.12}), ("mine", {"x": 0.0, "z": 8.0, "yaw": 0.0, "pitch": -0.1}))
    for name, vp in (("desktop", dict(viewport={"width": 1366, "height": 768})), ("phone", dict(PHONE))):
        ctx, A = client(browser, base, user, vp, extra_init=[seeded()])
        fresh(A)
        Q.kit(A, ["shovel", "pickaxe", "bucket", "classifier", "wheelbarrow", "pan"])
        G(A, f"""async () => {{ const m = await import('/games/goldrush/goldrush-devactions.js'); const g = {GR}, pr = g.procObj();
          g.procBarrowPlace(-15.2, 5.6, Math.PI / 2); pr.devSetBarrow(m.devBatch('paydirt', 85000)); }}""")
        for view, pose in views:
            G(A, f"(p) => {{ {GR}.pose(p); {GR}.setPaused(false); }}", pose)
            time.sleep(0.8)
            A.evaluate(M6.FRAME_REC)
            time.sleep(2.5)
            f1 = A.evaluate(M6.FRAME_STOP)
            i1 = G(A, f"() => {GR}.info()")
            out[f"{name}:{view}"] = {"fps": f1["fps"], "p95": f1["p95"], "calls": i1["drawCalls"], "tris": i1["triangles"]}
        # pushing the full barrow
        take_barrow(A, 85000)
        G(A, f"() => {GR}.setPaused(false)")
        A.evaluate(M6.FRAME_REC)
        G(A, f"() => {GR}.walk(2.0, 0, 1)")
        time.sleep(1.5)
        f1 = A.evaluate(M6.FRAME_STOP)
        out[f"{name}:push"] = {"fps": f1["fps"], "p95": f1["p95"], "calls": G(A, f"() => {GR}.info()")["drawCalls"]}
        print(f"  perf {name}: {json.dumps({k: v for k, v in out.items() if k.startswith(name)})}", flush=True)
        Q.close(A)
        ctx.close()
    ok("PERF the redesigned camp, the stations, the mine and pushing the barrow: under 200 draw calls, 60 fps desktop and the emulated phone",
       all(v["calls"] < 200 and v["fps"] >= 55 for v in out.values()), json.dumps(out))


def stability(A):
    """a long session of the new things: no growth"""
    fresh(A)
    Q.kit(A, ["shovel", "pickaxe", "bucket", "wheelbarrow"])
    G(A, f"() => {GR}.walk(0.3, 0, 0)")
    s0 = G(A, STATS)
    for k in range(6 if QUICK else 14):
        take_barrow(A, 0 if k % 2 else 85000)
        G(A, f"() => {GR}.walk(0.8, 0, 1, {0.3 if k % 3 else -0.3})")
        G(A, f"() => {GR}.procAct('barrow-park')")
        G(A, f"() => {GR}.walk(0.5, 0, 0)")
    r = G(A, f"""() => {{ const M = {GR}.procObj().hands.models, L = M.bladeLoad, geo = L.geo;
      for (let c = 0; c < 10000; c++) M.setLoad([0.3, 1, 0.6, 0][c % 4], [0, 0, 0.6, 1][c % 4], 0, 0, c % 4);
      return {{ same: L.geo === geo }}; }}""")
    G(A, f"() => {GR}.walk(0.5, 0, 0)")
    s1 = G(A, STATS)
    ok("STABLE barrow taken / pushed / set down many times, 10 000 blade loads: no geometry, texture, object or heap growth",
       r["same"] and (s1["geo"], s1["tex"], s1["obj"]) == (s0["geo"], s0["tex"], s0["obj"]) and (s0["heap"] is None or s1["heap"] - s0["heap"] < 15), f"{s0} -> {s1}")


def main():
    shots = None
    if "--shots" in sys.argv:
        shots = Path(sys.argv[sys.argv.index("--shots") + 1])
        shots.mkdir(parents=True, exist_ok=True)
    engine = sys.argv[sys.argv.index("--browser") + 1] if "--browser" in sys.argv else "chromium"
    want = lambda part: not ONLY or part in ONLY
    proc_, base, tmp = start_server()
    try:
        user = login(base, "Premium8")
        with sync_playwright() as p:
            launch = lambda: getattr(p, engine).launch(args=GPU_ARGS if engine == "chromium" else [])
            browser = launch()
            ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
            first = True
            for part, fn in (("barrow", barrow), ("barrowterrain", barrow_terrain), ("stone", stone), ("matrix", matrix), ("loads", loads),
                             ("glb", glb), ("hands", hands), ("pangold", pangold), ("hud", hud), ("sound", sound), ("stable", stability)):
                if not want(part):
                    continue
                if engine == "webkit" and not first:
                    # WebKit (Playwright, Windows) keeps GPU memory of every closed session and then stalls
                    # (clicks hang) - a fresh browser per part, as the camp suite does per strategy
                    Q.close(A)
                    ctx.close()
                    browser.close()
                    browser = launch()
                    ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
                first = False
                fn(A)
            if want("shots") and shots:
                visual(A, shots)
            Q.close(A)
            ctx.close()
            if engine == "chromium":
                if want("perf"):
                    perf(browser, base, user)
                if want("dev"):
                    dev_pack(browser)
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
