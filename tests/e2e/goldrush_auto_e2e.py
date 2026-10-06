"""End-to-end check of GoldRush phase 7: first automation (bulk hopper, motorised feeder) and processing polish.

  bulk hopper   H1-H9  (buy, build with the ramp and the platform, a barrow up the ramp tipping in,
                        capacity / partial transfer, layers kept apart + FIFO, bucket from the platform,
                        the visible fill, the hand slide gate, save / reload, no duplication / loss)
  feeder        F1-F9  (mount, the lever AUS -> AUTO -> AN, rate, backpressure, resume, AUTO only with water,
                        an even feed lets the sluice take 12 / 14 l/min, no offline progress, reload mid-transfer)
  ledger        the whole chain terrain -> barrow -> bulk hopper -> feeder -> sluice -> riffles / tailings ->
                clean out -> tray -> pan -> pouch, exact to the microgram and gram
  plus the polish (water clears after the feed, riffle build-up and clean out, the tailings fan grows,
  wet ground), dig-feel follow-up, save v6 -> v7, the phase-7 developer pack and preset, a new mine,
  the phone, performance, a long automation run, the phase-7 economy (A7-D7, 660 min).

Runs the server from temp copies (the real database is never touched).

    python tests/e2e/goldrush_auto_e2e.py [--shots DIR] [--quick] [--full-bench] [--no-bench] [--browser webkit] [--only parts]

    --only        a comma list of parts: bulk,feeder,chain,polish,save,dev,mobile,perf,bench
    --full-bench  100 seeds x 660 min per strategy (the canonical numbers; hours)
"""

import json
import math
import os
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from goldrush_bench import run_seed as bench_seed  # noqa: E402
from goldrush_e2e import CURRENT_SAVE, GPU_ARGS, PHONE, client, errors, gr_close, gr_open, gr_pause, gr_ready, gr_start, heap_mb, wait_for  # noqa: E402
from goldrush_tools_e2e import AUDIO_LEVELS, open_game, seeded  # noqa: E402
from goldrush_process_e2e import drag  # noqa: E402
import goldrush_dev_e2e as DEV  # noqa: E402
import goldrush_mech_e2e as M6  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

QUICK = "--quick" in sys.argv
FULL = "--full-bench" in sys.argv
ONLY = set(sys.argv[sys.argv.index("--only") + 1].split(",")) if "--only" in sys.argv else None
RESULTS = []
GR = "window.__goldrush"
G, proc, eco, use = M6.G, M6.proc, M6.eco, M6.use
PHASE6 = M6.PHASE5 + ["wheelbarrow", "sluice"]
BULK_AT = (-20.82, -3.45)
CONTROL = (-22.45, -2.72)
PLATFORM = (-20.82, -4.55)
RAMP_FOOT_WHEEL = (-20.82, -8.9)
FEED = M6.FEED
DEVBATCH = "async ([kind, ml]) => { const m = await import('/games/goldrush/goldrush-devactions.js'); return m.devBatch(kind, ml); }"


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def shot(page, shots, name):
    if shots:
        page.screenshot(path=str(shots / f"gr7_{name}.png"))


def look(page, shots, name, cam, frames=0.3):
    """visual QA: the world from a camera (paused game: the next frame does not move it back)"""
    if not shots:
        return
    if frames:
        G(page, f"(t) => {GR}.walk(t, 0, 0)", frames)
    G(page, f"(c) => {GR}.camLook(c)", cam)
    page.screenshot(path=str(shots / f"gr7_{name}.png"))


def ledger_ok(page):
    return M6.ledger_ok(page)


def close(page):
    """leave GoldRush the player's way - a hook pause has no pause menu: resume first (setPaused(true) pitfall)"""
    if G(page, f"() => !!(window.__goldrush && {GR}.state && {GR}.state().paused)") and not page.is_visible(".gr-pause"):
        G(page, f"() => {GR}.setPaused(false)")
    return gr_close(page)


def fresh(page, seed=4242):
    if G(page, f"() => !!(window.__goldrush && {GR}.state && {GR}.state().paused)") and not page.is_visible(".gr-pause"):
        G(page, f"() => {GR}.setPaused(false)")
    M6.fresh(page, seed)


def at_post(page):
    G(page, f"(c) => {GR}.pose({{ x: c[0], z: c[1], yaw: -Math.PI / 2, pitch: -0.2 }})", list(CONTROL))


def kit7(page, extra=(), cash=5000000):
    M6.kit(page, PHASE6 + list(extra), cash=cash)


def automation(page, feeder=True):
    """phase 1-6 kit, a built sluice, the bulk hopper (and the feeder) bought and built (no animation)"""
    kit7(page, ["bulkhopper"] + (["feeder"] if feeder else []))
    M6.install(page)
    return G(page, f"() => {GR}.procInstallAuto()")


def bulk_batch(page, kind, ml):
    return G(page, f"""async ([kind, ml]) => {{ const m = await import('/games/goldrush/goldrush-devactions.js'); const pr = {GR}.procObj();
      return pr.devSetBulk(ml ? m.devBatch(kind, ml) : null); }}""", [kind, ml])


def push_up_ramp(page, kg_batch=("paydirt", 82000)):
    """a loaded barrow at the ramp's foot, taken, pushed up until it stops at the hopper's frame -> track"""
    M6.barrow_batch(page, *kg_batch)
    G(page, f"(w) => {GR}.procBarrowPlace(w[0], w[1], Math.PI)", list(RAMP_FOOT_WHEEL))
    t = M6.take_barrow(page)
    track, first_dump = [], None
    for k in range(70):
        G(page, f"() => {GR}.walk(0.2, 0, 1)")
        b = proc(page)["barrow"]
        it = proc(page)["interaction"]
        track.append((b["z"], b["ground"], b["theta"], b["y"] - b["ground"]))
        if first_dump is None and it and it["id"] == "bulk-dump":
            first_dump = b["z"]
        if len(track) > 6 and abs(track[-1][0] - track[-6][0]) < 0.005:
            break
    return t, track, first_dump


# ======================================================================
# BULK HOPPER H1-H9
# ======================================================================

def bulk(A, shots):
    fresh(A)
    kit7(A)
    G(A, f"() => {GR}.setCash(5000000)")
    price = next(i for i in G(A, f"() => {GR}.shopView().items") if i["id"] == "bulkhopper")["price"]
    c0 = eco(A)["cashCents"]
    r = G(A, f"() => {GR}.buy('bulkhopper')")
    p = proc(A)
    G(A, f"() => {GR}.setPaused(true)")
    look(A, shots, "00_bulk_delivered", {"x": -14.5, "y": 5.5, "z": 1.0, "tx": -20.0, "ty": 0.8, "tz": -4.5})
    M6.install(A)
    at_post(A)
    st = G(A, f"() => {GR}.stationNow()")
    use(A)
    G(A, f"() => {GR}.walk(1.1, 0, 0)")
    mid = G(A, f"() => {{ const b = {GR}.procObj().bulk; return {{ building: b.build >= 0, kit: b.kit.visible, model: b.model.visible, ramp: b.rampModel.visible }}; }}")
    G(A, f"() => {GR}.walk(2.0, 0, 0)")
    p2 = proc(A)
    heights = G(A, f"() => [-10, -9.1, -8, -7, -6, -5, -4.6, -4.2].map((z) => +{GR}.groundAt(-20.82, z).toFixed(3))")
    ok("H1 buy the bulk hopper (needs the sluice): paid its price, delivered as a pallet; at the control post [E] 'Vorratstrichter aufbauen' - it rises with its ramp and platform; the ramp is walkable (0 -> 1,70 m), the platform level",
       r["ok"] and eco(A)["cashCents"] == c0 - price and p["bulk"]["state"] == "delivered" and st and st["id"] == "bulk-build" and mid == {"building": True, "kit": False, "model": True, "ramp": True}
       and p2["bulk"]["state"] == "ready" and p2["bulk"]["decks"] == 2 and heights[0] == 0 and abs(heights[3] - 0.84) < 0.02 and heights[-2] == 1.7 and heights[-1] == 1.7, f"price {price}, {heights}")
    look(A, shots, "01_hopper_empty", {"x": -20.82, "y": 3.4, "z": -4.6, "tx": -20.82, "ty": 1.6, "tz": -3.45}, 0.2)
    # H2: a full barrow up the ramp, tipped in (only once its wheel is at the frame)
    t, track, first = push_up_ramp(A)
    G(A, f"() => {GR}.setPaused(false)")
    good = all(abs(dy) < 1e-6 and abs(th) < 1.0 for _, _, th, dy in track)
    last = track[-1]
    inter = proc(A)["interaction"]
    ok("H2 a full barrow pushed up the ramp: the wheel stays on the planks, it stops at the hopper's frame on the platform - only there 'Schubkarre in den Vorratstrichter kippen'",
       t["ok"] and good and last[1] > 1.65 and first is not None and first > -4.75 and inter and inter["id"] == "bulk-dump", f"stopped at z {last[0]:.2f} (ground {last[1]:.2f}), dump offered from z {first}")
    bw0 = proc(A)["barrow"]
    use(A)
    time.sleep(0.4)
    shot(A, shots, "04_wheelbarrow_dumping")
    wait_for(lambda: not proc(A)["barrow"]["dumping"], 4)
    p = proc(A)
    lok, _, _ = ledger_ok(A)
    ok("H3 the barrow tips into the bulk hopper (a visible tip, material over the rim): all of its load, exactly - volume, mass, gold, pieces",
       p["bulk"]["volumeMl"] == bw0["batch"]["volumeMl"] and p["bulk"]["goldUg"] == bw0["goldUg"] and p["bulk"]["massG"] == bw0["massG"] and p["barrow"]["batch"]["volumeMl"] == 0 and lok,
       f"{p['bulk']['volumeMl']} ml, {p['bulk']['goldUg']} ug")
    G(A, f"() => {GR}.procAct('barrow-park')")
    G(A, f"() => {GR}.setPaused(true)")
    # H4: capacity, partial transfer
    bulk_batch(A, "dirt", 330000)
    M6.barrow_batch(A, "gravel", 80000)
    w0 = proc(A)["barrow"]
    moved = G(A, f"() => {GR}.procPour('barrow', 'bulk')")
    p = proc(A)
    lok, _, _ = ledger_ok(A)
    ok("H4 capacity 360 l: a barrow into an almost full hopper - only what fits goes in, the rest stays in the barrow (nothing lost)",
       p["bulk"]["capacityMl"] == 360000 and p["bulk"]["volumeMl"] == 360000 and moved == 30000 and p["barrow"]["batch"]["volumeMl"] == w0["batch"]["volumeMl"] - 30000 and lok,
       f"moved {moved}, barrow left {p['barrow']['batch']['volumeMl']}")
    # H5: layers kept apart, oldest out first
    bulk_batch(A, "dirt", 0)
    for kind, ml in (("dirt", 60000), ("gravel", 50000), ("paydirt", 70000)):
        M6.barrow_batch(A, kind, ml)
        G(A, f"() => {GR}.procPour('barrow', 'bulk')")
    lay = proc(A)["bulk"]["layers"]
    G(A, f"() => {GR}.procWater(false)")
    M6.hopper_batch(A, "dirt", 0)
    at_post(A)
    gate = G(A, f"() => {{ {GR}.stationNow(); return {GR}.procAct('bulk-gate'); }}")
    G(A, f"() => {GR}.procTick(120)")
    lay2 = proc(A)["bulk"]["layers"]
    hop = proc(A)["sluice"]["hopper"]
    ok("H5 several loads stay separate layers (origin, composition, gold apart); the outlet takes the OLDEST first (dirt), the newest (pay dirt) stays on top",
       len(lay) == 3 and [round(l["ml"] / 1000) for l in lay] == [60, 50, 70] and lay2[0]["ml"] == 10000 and lay2[-1]["ml"] == 70000 and hop["comp"][2] == 0 and hop["volumeMl"] == 50000,
       f"before {[l['ml'] for l in lay]} after {[l['ml'] for l in lay2]}")
    ok("H6 the slide gate by hand (no feeder): pulled at the control post it fills the sluice hopper and closes by itself when that is full",
       gate["ok"] and proc(A)["bulk"]["gateOpen"] is False and hop["volumeMl"] == proc(A)["sluice"]["capacityMl"], f"hopper {hop['volumeMl']}")
    # H7: bucket from the platform
    G(A, f"() => {GR}.procGrant('bucket')")
    G(A, f"""async () => {{ const m = await import('/games/goldrush/goldrush-devactions.js'); const pr = {GR}.procObj(); pr.devSetBucket(m.devBatch('compactDirt', 9000)); pr.bucket.carried = true; }}""")
    G(A, f"(s) => {GR}.pose({{ x: s[0], z: s[1], yaw: Math.PI, pitch: -0.6 }})", list(PLATFORM))
    v0 = proc(A)["bulk"]["volumeMl"]
    st = G(A, f"() => {GR}.stationNow()")
    use(A)
    p = proc(A)
    ok("H7 a bucket emptied from the platform: [E] 'Eimer in den Vorratstrichter kippen' - a layer of its own on top", st and st["id"] == "bucket-bulk" and p["bulk"]["volumeMl"] == v0 + 9000
       and p["bulk"]["layers"][-1]["ml"] == 9000 and p["bucket"]["batch"]["volumeMl"] == 0, str(st))
    G(A, f"() => {{ const b = {GR}.procObj().bucket; b.carried = false; b.x = -16.15; b.z = 3.5; }}")
    # H8: the visible fill - level and colour follow the content
    fills = {}
    for kind, frac in (("dirt", 0.25), ("gravel", 0.5), ("paydirt", 1.0)):
        bulk_batch(A, kind, int(360000 * frac))
        G(A, f"() => {GR}.walk(0.05, 0, 0)")
        fills[kind] = G(A, f"""() => {{ const u = {GR}.procObj().bulk.model.userData, c = u.fill.geometry.attributes.color, n = c.count;
          let r = 0, g = 0, b = 0; for (let i = 0; i < n; i++) {{ r += c.getX(i); g += c.getY(i); b += c.getZ(i); }}
          return {{ y: +u.fill.position.y.toFixed(3), s: +u.fill.scale.x.toFixed(3), rgb: [+(r / n).toFixed(3), +(g / n).toFixed(3), +(b / n).toFixed(3)], pointer: +u.pointer.position.y.toFixed(3), visible: u.fill.visible }}; }}""")
        G(A, f"(s) => {GR}.pose({{ x: s[0], z: s[1], yaw: Math.PI, pitch: -0.8 }})", list(PLATFORM))
        shot(A, shots, {"dirt": "01b_hopper_quarter", "gravel": "02_hopper_half", "paydirt": "03_hopper_full"}[kind])
    ok("H8 the fill is visible: its surface rises and widens with the volume (the funnel), the gauge's pointer climbs, the colour follows the material (dirt brown, gravel grey)",
       all(f["visible"] for f in fills.values()) and fills["dirt"]["y"] < fills["gravel"]["y"] < fills["paydirt"]["y"] and fills["dirt"]["s"] < fills["gravel"]["s"]
       and fills["dirt"]["pointer"] < fills["paydirt"]["pointer"] and fills["gravel"]["rgb"][2] > fills["dirt"]["rgb"][2] + 0.03, json.dumps(fills))
    # H9: save / reload exactly, no duplicate models
    for kind, ml in (("dirt", 0),):
        bulk_batch(A, kind, ml)
    for kind, ml in (("dirt", 40000), ("gravel", 30000)):
        M6.barrow_batch(A, kind, ml)
        G(A, f"() => {GR}.procPour('barrow', 'bulk')")
    G(A, f"() => {GR}.procBarrowPlace(-20.82, -4.5, Math.PI)")            # parked up on the platform
    G(A, f"() => {GR}.setPaused(false)")
    before = proc(A)
    G(A, f"() => {GR}.save()")
    close(A)
    open_game(A, start=False)
    after = proc(A)
    models = G(A, f"() => {GR}.procObj().scene.children.filter((o) => o.name === 'goldrush-ramp').length")
    lok, _, _ = ledger_ok(A)
    bw = after["barrow"]
    ok("H9 save / reload: the hopper, its layers (each ml, ug, g, origin) and the stats come back exactly; one ramp, the decks again; a barrow parked on the platform stands on it; the ledger balances",
       after["bulk"]["layers"] == before["bulk"]["layers"] and after["bulk"]["stats"] == before["bulk"]["stats"] and after["bulk"]["state"] == "ready" and after["bulk"]["decks"] == 2 and models == 1 and lok
       and abs(bw["ground"] - 1.7) < 1e-6 and abs(bw["y"] - bw["ground"]) < 1e-6, f"{len(after['bulk']['layers'])} layers, barrow y {bw['y']:.3f} on {bw['ground']:.3f}")


# ======================================================================
# FEEDER F1-F9
# ======================================================================

def feeder(A, shots):
    fresh(A)
    kit7(A, ["bulkhopper"])
    M6.install(A)
    G(A, f"() => {GR}.procInstallAuto()")
    G(A, f"() => {GR}.setCash(5000000)")
    r = G(A, f"() => {GR}.buy('feeder')")
    G(A, f"() => {GR}.setPaused(true)")
    at_post(A)
    st0 = G(A, f"() => {GR}.stationNow()")
    use(A)
    G(A, f"() => {GR}.walk(2.2, 0, 0)")
    modes = []
    for _ in range(4):
        at_post(A)
        st = G(A, f"() => {GR}.stationNow()")
        use(A)
        modes.append((st["short"], proc(A)["feeder"]["mode"]))
    ok("F1 buy the feeder (needs the bulk hopper), [E] 'Dosierer montieren' at the post; the lever cycles AUS -> AUTO -> AN -> AUS",
       r["ok"] and st0["id"] == "feeder-mount" and proc(A)["feeder"]["state"] == "ready" and [m[1] for m in modes] == ["auto", "on", "stop", "auto"], str(modes))
    # F2: rate (water on, the sluice hopper empty)
    bulk_batch(A, "paydirt", 300000)
    M6.hopper_batch(A, "dirt", 0)
    G(A, f"() => {{ {GR}.procWater(true); {GR}.procFeederMode('on'); }}")
    b0 = proc(A)["bulk"]["volumeMl"]
    G(A, f"() => {GR}.procTick(60)")
    p = proc(A)
    out = b0 - p["bulk"]["volumeMl"]
    ok("F2 rate: 12 l a minute out of the bulk hopper (game time, in 0,25-l steps) - the sluice takes it as it comes (an even feed: 12 l/min through the box)",
       11500 <= out <= 12500 and p["feeder"]["status"]["key"] == "moving" and G(A, f"() => {GR}.procObj().sluice.rateLpm") == 12, f"{out} ml in 60 s")
    look(A, shots, "06_feeder_running", {"x": -21.9, "y": 2.3, "z": -0.9, "tx": -20.8, "ty": 1.3, "tz": -2.9}, 1.5)
    look(A, shots, "07_material_entering_sluice", {"x": -21.6, "y": 2.0, "z": -1.3, "tx": -20.8, "ty": 1.2, "tz": -2.4}, 0.3)
    # F3: backpressure - water off, the sluice hopper fills up, the feeder waits
    G(A, f"() => {GR}.procWater(false)")
    G(A, f"() => {GR}.procTick(400)")
    p = proc(A)
    b1 = p["bulk"]["volumeMl"]
    G(A, f"() => {GR}.procTick(120)")
    p2 = proc(A)
    lok, _, _ = ledger_ok(A)
    ok("F3 backpressure: water off (AN) - the sluice hopper fills to 50 l, then the tray (2,5 l), then the outlet stops: 'wartet – der Trichter der Rinne ist voll', nothing lost or doubled",
       p["sluice"]["hopper"]["volumeMl"] == p["sluice"]["capacityMl"] and p["feeder"]["status"]["key"] == "blocked" and p["feeder"]["trayMl"] >= 2250 and p2["bulk"]["volumeMl"] == b1 and lok,
       f"hopper {p['sluice']['hopper']['volumeMl']}, tray {p['feeder']['trayMl']}, status {p['feeder']['status']['text']}")
    look(A, shots, "05_feeder_waiting", {"x": -21.9, "y": 2.3, "z": -0.9, "tx": -20.8, "ty": 1.3, "tz": -2.9}, 0.3)
    # F4: resume
    G(A, f"() => {GR}.procWater(true)")
    G(A, f"() => {GR}.procTick(60)")
    p3 = proc(A)
    ok("F4 water on again: the sluice works its hopper off, the feeder goes on by itself (no step skipped, none twice)", p3["feeder"]["status"]["key"] == "moving" and p3["bulk"]["volumeMl"] < b1 and ledger_ok(A)[0],
       f"bulk {b1} -> {p3['bulk']['volumeMl']}")
    # F5: AUTO only with water
    G(A, f"() => {{ {GR}.procFeederMode('auto'); {GR}.procWater(false); }}")
    G(A, f"() => {GR}.walk(0.1, 0, 0)")
    v0 = proc(A)["bulk"]["volumeMl"]
    G(A, f"() => {GR}.procTick(90)")
    s_off = proc(A)["feeder"]["status"]
    v1 = proc(A)["bulk"]["volumeMl"]
    G(A, f"() => {GR}.walk(0.1, 0, 0)")
    amber = G(A, f"() => {GR}.procObj().bulk.post.userData.lamp.material === {GR}.procObj().auto.lampWait")
    M6.hopper_batch(A, "dirt", 0)                          # the sluice hopper with room: the feeder can run
    G(A, f"() => {GR}.procWater(true)")
    G(A, f"() => {GR}.procTick(60)")
    v2 = proc(A)["bulk"]["volumeMl"]
    G(A, f"() => {GR}.walk(0.1, 0, 0)")                   # a frame: the lamp
    lamp = G(A, f"() => {GR}.procObj().bulk.post.userData.lamp.material === {GR}.procObj().auto.lampOn")
    ok("F5 AUTO: with the water off it waits ('wartet auf das Wasser', amber lamp), with water it runs (green lamp)", s_off["key"] == "waiting" and v1 == v0 and v2 < v1 and amber and lamp, f"{s_off['text']} v {v0}/{v1}/{v2} lamps {amber}/{lamp}")
    # F6: an even feed - 10 l/min without, 12 with the feeder, 14 with the fine-dosing gate
    G(A, f"() => {GR}.procFeederMode('stop')")
    G(A, f"() => {GR}.procTick(1)")
    r_off = G(A, f"() => {GR}.procObj().sluice.rateLpm")
    G(A, f"() => {{ {GR}.buy('feeder.fine'); {GR}.procFeederMode('on'); }}")
    G(A, f"() => {GR}.procTick(1)")
    r_fine = G(A, f"() => {GR}.procObj().sluice.rateLpm")
    ok("F6 the sluice's rate: 10 l/min fed by hand, 12 with the feeder, 14 with 'Feindosierung' (more it does not take)", r_off == 10 and r_fine == 14 and proc(A)["feeder"]["rateLpm"] == 14, f"{r_off} / {r_fine}")
    # F7: no offline progress
    G(A, f"() => {{ {GR}.procFeederMode('on'); {GR}.procWater(true); {GR}.setPaused(false); }}")
    time.sleep(2.0)
    gr_pause(A)
    a = proc(A)
    time.sleep(2.5)
    b = proc(A)
    close(A)
    saved = json.loads(G(A, "() => localStorage.getItem(grKey())"))["processing"]
    time.sleep(2.0)
    open_game(A, start=False)
    c = proc(A)
    ok("F7 no offline progress: paused nothing moves; closed and reopened it is exactly the saved state (no catch-up)",
       a["bulk"]["volumeMl"] == b["bulk"]["volumeMl"] and a["feeder"]["trayMl"] == b["feeder"]["trayMl"] and c["bulk"]["volumeMl"] == sum(l["volumeMl"] for l in saved["bulkHopper"]["buffer"]["layers"])
       and c["feeder"]["trayMl"] == sum(l["volumeMl"] for l in saved["feeder"]["tray"]["layers"]) and c["feeder"]["mode"] == "on", f"bulk {a['bulk']['volumeMl']}/{b['bulk']['volumeMl']}/{c['bulk']['volumeMl']}")
    # F8 / F9: reload mid-transfer - the tray holds material, the links half a step
    G(A, f"() => {{ {GR}.procWater(false); {GR}.procFeederMode('on'); }}")
    G(A, f"() => {GR}.procTick(37.3)")
    p = proc(A)
    tot0 = p["inContainersUg"] + p["ledger"]["recoveredUg"] + p["ledger"]["tailUg"]
    acc0 = G(A, f"() => [{GR}.procObj().feeder.inLink.acc, {GR}.procObj().feeder.outLink.acc]")
    G(A, f"() => {GR}.save()")
    close(A)
    open_game(A, start=False)
    p2 = proc(A)
    tot1 = p2["inContainersUg"] + p2["ledger"]["recoveredUg"] + p2["ledger"]["tailUg"]
    acc1 = G(A, f"() => [{GR}.procObj().feeder.inLink.acc, {GR}.procObj().feeder.outLink.acc]")
    ok("F8 save mid-transfer: the material on the tray, the hopper layers, the links' step state - all in the save, all back", p2["feeder"]["trayMl"] == p["feeder"]["trayMl"] and p2["bulk"]["layers"] == p["bulk"]["layers"]
       and p2["sluice"]["hopper"] == p["sluice"]["hopper"] and [round(x) for x in acc1] == [round(x) for x in acc0], f"tray {p['feeder']['trayMl']}, acc {acc0}")
    G(A, f"() => {GR}.procTick(600)")
    lok, _, _ = ledger_ok(A)
    ok("F9 after the reload: no duplication, no loss - the same gold in total, the ledger balances, and it goes on", tot0 == tot1 and lok, f"{tot0} vs {tot1}")


# ======================================================================
# THE WHOLE CHAIN (ledger)
# ======================================================================

def chain(A, shots):
    fresh(A)
    automation(A)
    G(A, f"() => {GR}.setPaused(true)")
    # dig into a parked barrow (terrain -> barrow)
    sp = M6.dig_spot(A, 0.3)
    M6.park_beside(A, sp)
    got = {"ml": 0, "ug": 0}
    for i in range(40):
        r = M6.scoop(A, dict(sp, yaw=sp["yaw"] + ((i // 4) % 6 - 3) * 0.05))
        if r and r.get("intoMl"):
            got["ml"] += r["intoMl"]; got["ug"] += r["intoUg"]
    steps = []
    def step(name):
        lok, L, p = ledger_ok(A)
        steps.append((name, lok, p["inContainersUg"] + L["recoveredUg"] + L["tailUg"], L["inUg"]))
    step("dug into the barrow")
    G(A, f"() => {GR}.procPour('barrow', 'bulk')")
    step("barrow -> bulk hopper")
    G(A, f"() => {{ {GR}.procWater(true); {GR}.procFeederMode('auto'); }}")
    G(A, f"() => {GR}.procTick(1800)")
    step("feeder -> sluice -> riffles / tailings")
    G(A, f"() => {GR}.procWater(false)")
    M6.cleanout(A)
    step("clean out -> tray, nuggets -> pouch")
    G(A, f"() => {{ let n = 0; while (n++ < 40 && {GR}.procAct('pan-fill').ok) {{ {GR}.procWork(30); {GR}.procCollect(); }} }}")
    step("tray -> pan -> pouch")
    p = proc(A)
    L = p["ledger"]
    ok("LEDGER the whole chain terrain -> barrow -> bulk hopper -> feeder -> sluice -> riffles / tailings -> clean out -> tray -> pan -> pouch: gold and mass exact after every step",
       all(s[1] for s in steps) and got["ml"] > 20000 and L["recoveredUg"] > 0 and L["tailUg"] > 0 and p["sluice"]["tray"]["volumeMl"] == 0,
       " | ".join(f"{n}: {'ok' if o else 'BROKEN'}" for n, o, _, _ in steps) + f" | dug {got['ml']} ml / {got['ug']} ug, recovered {L['recoveredUg']} ug")
    ok("LEDGER nothing appears as cash on its own: the recovered gold is in the pouch, the cash only changes at the camp", eco(A)["pouchUg"] >= L["recoveredUg"] and eco(A)["cashCents"] == 0,
       f"pouch {eco(A)['pouchUg']} ug, cash {eco(A)['cashCents']}")


# ======================================================================
# POLISH: water, riffles, tailings, wet ground, dig feel
# ======================================================================

def polish(A, shots):
    fresh(A)
    automation(A)
    G(A, f"() => {GR}.setPaused(true)")
    sl = lambda: G(A, f"() => {{ const s = {GR}.procObj().sluice, u = s.model.userData; return {{ silt: s._silt, op: u.water.material.opacity, heavy: u.heavy.material.opacity, specks: u.specks.count, foam: u.foam.visible, heap: u.heap.visible, hs: [u.heap.scale.x, u.heap.scale.y, u.heap.scale.z] }}; }}")
    G(A, f"() => {GR}.procWater(true)")
    G(A, f"() => {GR}.walk(4.0, 0, 0)")
    clear = sl()
    look(A, shots, "08_clear_water", {"x": -19.0, "y": 1.8, "z": -1.15, "tx": -19.2, "ty": 0.75, "tz": -2.1}, 0)
    M6.hopper_batch(A, "paydirt", 40000)
    G(A, f"() => {GR}.walk(3.0, 0, 0)")
    muddy = sl()
    look(A, shots, "09_muddy_water", {"x": -19.0, "y": 1.8, "z": -1.15, "tx": -19.2, "ty": 0.75, "tz": -2.1}, 0)
    M6.hopper_batch(A, "paydirt", 0)
    G(A, f"() => {GR}.walk(1.5, 0, 0)")
    half = sl()
    G(A, f"() => {GR}.walk(9.0, 0, 0)")
    clear2 = sl()
    ok("WATER clear while nothing runs, silty brown as the feed comes (in a moment), clearing again over several seconds when it stops; white water at the riffles",
       clear["silt"] < 0.05 and muddy["silt"] > 0.8 and muddy["op"] > clear["op"] + 0.3 and 0.25 < half["silt"] < 0.85 and clear2["silt"] < 0.1 and clear["foam"], f"{clear['silt']:.2f} -> {muddy['silt']:.2f} -> {half['silt']:.2f} -> {clear2['silt']:.2f}")
    # riffle build-up, clean out
    look(A, shots, "10_riffles_fresh", {"x": -19.0, "y": 1.75, "z": -1.25, "tx": -19.0, "ty": 0.75, "tz": -2.1}, 0)
    fresh_r = sl()
    for k in range(5):
        M6.hopper_batch(A, "paydirt", 50000)
        G(A, f"() => {GR}.procTick(260)")
    G(A, f"() => {GR}.walk(0.1, 0, 0)")
    loaded = sl()
    G(A, f"() => {GR}.procWater(false)")
    look(A, shots, "11_riffles_near_cleanout", {"x": -19.0, "y": 1.75, "z": -1.25, "tx": -19.0, "ty": 0.75, "tz": -2.1}, 0.2)
    M6.cleanout(A)
    G(A, f"() => {GR}.walk(0.1, 0, 0)")
    cleaned = sl()
    tray_specks = G(A, f"() => {GR}.procObj().sluice.traySpecks.count")
    look(A, shots, "11b_tray_after_cleanout", {"x": -16.0, "y": 1.3, "z": 1.5, "tx": -16.3, "ty": 0.45, "tz": 1.12}, 0)
    ok("RIFFLES dark sand builds up behind the bars with the load and fine gold shows as a few specks (no glitter carpet); after the clean out the mat is clean and the tray shows black sand with gold",
       fresh_r["heavy"] == 0 and fresh_r["specks"] == 0 and loaded["heavy"] > 0.7 and 10 <= loaded["specks"] <= 40 and cleaned["heavy"] == 0 and cleaned["specks"] == 0 and tray_specks > 0,
       f"heavy {fresh_r['heavy']} -> {loaded['heavy']:.2f} -> {cleaned['heavy']}, specks {loaded['specks']} -> {cleaned['specks']}, tray {tray_specks}")
    # tailings grow, 300 l vs 10 m3
    shapes = {}
    for m3 in (0.3, 3.0, 10.0):
        G(A, f"(v) => {{ const s = {GR}.procObj().sluice; s.tailMl = Math.round(v * 1e6); s._fill(); }}", m3)
        shapes[m3] = sl()["hs"]
        look(A, shots, {0.3: "12_tailings_low", 3.0: "12b_tailings_mid", 10.0: "13_tailings_high"}[m3], {"x": -13.8, "y": 3.6, "z": 1.6, "tx": -17.3, "ty": 0.3, "tz": -2.4}, 0)
    cols = G(A, f"() => {GR}.procObj().world.colliders.includes({GR}.procObj().sluice.heapCollider)")
    vol = lambda s: 0.603 * s[0] * s[1] * s[2]
    ok("TAILINGS the heap grows visibly: 300 l is a small pile, 3 m3 a heap, 10 m3 a big fan (bigger and higher still) - its volume follows the tailings; once high it is in the way",
       shapes[0.3][1] > 0.3 and shapes[3.0][0] > shapes[0.3][0] * 1.8 and shapes[10.0][1] > shapes[3.0][1] * 1.2 and abs(vol(shapes[3.0]) - 3.0) < 0.3 and cols, json.dumps({k: [round(x, 2) for x in v] for k, v in shapes.items()}))
    # wet ground
    wet = G(A, f"() => {GR}.procObj()._wet.map((m) => [m.userData.which, m.userData.puddle, m.visible])")
    G(A, f"() => {GR}.setQuality('low')")
    G(A, f"() => {GR}.walk(1.2, 0, 0)")
    wet_low = G(A, f"() => {GR}.procObj()._wet.filter((m) => m.visible && m.userData.puddle).length")
    G(A, f"() => {GR}.setQuality('medium')")
    G(A, f"() => {GR}.walk(1.2, 0, 0)")
    look(A, shots, "14_wet_wash_area", {"x": -14.8, "y": 2.6, "z": 0.2, "tx": -17.0, "ty": 0.0, "tz": 2.6}, 0)
    ok("WET GROUND darker patches and a few small puddles at the wash place and - once it has run - at the sluice; LOW quality: no puddles", all(v for _, _, v in wet) and wet_low == 0, f"{len(wet)} patches")
    # dig feel follow-up
    fresh(A)
    G(A, f"() => {{ {GR}.grant('shovel'); {GR}.grant('pickaxe'); }}")
    sp = M6.dig_spot(A, 0.3)
    G(A, f"(s) => {GR}.pose(s)", sp)
    big = []
    for k in range(60):
        G(A, f"() => {GR}.fxClear()")
        big.append(G(A, f"() => {GR}.fxImpact(0, 'shovel', 1, 0).chunks"))
    ok("DIG FEEL dirt: big clods are rare now (about one in 1-2 shovel cuts, never a shower)", sum(big) / len(big) < 1.6 and max(big) <= 3, f"mean {sum(big) / len(big):.2f}, max {max(big)}")
    G(A, f"() => {{ {GR}.equipNow('shovel'); }}")
    G(A, f"(s) => {GR}.pose(s)", sp)
    G(A, f"() => {GR}.fxClear()")
    sp0 = G(A, f"() => {GR}.fxStats().spills")
    G(A, f"() => {GR}.contact()")
    f0 = G(A, f"() => {GR}.fxStats()")
    G(A, f"() => {GR}.walk(0.15, 0, 0)")
    sp1 = G(A, f"() => {GR}.fxStats().spills")
    G(A, f"() => {GR}.walk(0.3, 0, 0)")
    sp2 = G(A, f"() => {GR}.fxStats().spills")
    ok("DIG FEEL the shovel reads as cut -> loosen -> scoop -> the load leaves the blade: the cut throws its pieces, ~0,3 s later a second release of crumbs falls off the blade",
       f0["debris"] + f0["chunks"] > 0 and sp1 == sp0 and sp2 == sp0 + 1, f"{f0['debris'] + f0['chunks']} pieces at the cut, releases {sp0} -> {sp1} (0,15 s) -> {sp2} (0,45 s)")
    if shots:
        for n, (tool, mat, idx) in enumerate([("shovel", "dirt", 0), ("shovel", "gravel", 2), ("pickaxe", "stone", 3)]):
            sp2 = G(A, M6.SPOT, {"want": {"dirt": "dirt", "gravel": "gravel", "stone": "stone"}[mat], "reach": 1.7, "start": 0.1 + n * 0.2, "fresh": True})
            if not sp2:
                continue
            G(A, f"(t) => {GR}.equipNow(t)", tool)
            G(A, f"(s) => {GR}.pose(s)", sp2)
            G(A, f"() => {GR}.fxClear()")
            G(A, f"(a) => {GR}.fxImpact(a[0], a[1], 2, 0)", [idx, tool])
            G(A, f"() => {GR}.fxUpdate(0.14)")
            G(A, f"(s) => {GR}.pose(s)", sp2)
            shot(A, shots, f"{15 + n}_{mat}_impact")


# ======================================================================
# SAVE v7, NEW MINE
# ======================================================================

def saves(A):
    close(A)
    v6 = {"saveVersion": 6, "worldSeed": 77, "createdAt": 1, "updatedAt": 2, "player": {"x": 0.6, "z": 10.2, "yaw": 0, "pitch": 0.1},
          "tools": {"owned": ["hand", "shovel"], "equipped": "shovel", "upgrades": []}, "economy": {"cashCents": 4321, "moneyCents": 4321},
          "terrain": None, "resources": None, "rocks": None,
          "processing": {"owned": ["bucket", "pan", "wheelbarrow", "sluice"], "bucket": None, "ledger": {}, "wheelbarrow": None, "sluice": {"state": "ready", "running": False}}}
    A.evaluate("(d) => { localStorage.setItem(grKey(), JSON.stringify(d)); localStorage.removeItem(grKey('.backup')); }", v6)
    open_game(A)
    G(A, f"() => {GR}.save()")
    d = json.loads(G(A, "() => localStorage.getItem(grKey())"))
    ok("SAVE v7: a phase-6 document (v6) loads as it was (cash, items, the sluice built), gains nothing of phase 7, is written as v7",
       d["saveVersion"] == CURRENT_SAVE >= 7 and d["economy"]["cashCents"] == 4321 and d["processing"]["owned"] == ["bucket", "pan", "wheelbarrow", "sluice"] and d["processing"]["bulkHopper"] is None and d["processing"]["feeder"] is None
       and d["processing"]["sluice"]["state"] == "ready", str(d["processing"]["owned"]))
    # a new mine: nothing of phase 7 left (no hopper, no feeder, no ramp to walk on)
    automation(A)
    close(A)
    gr_open(A)
    gr_ready(A, choice="new")
    p = proc(A)
    ok("NEW MINE: no bulk hopper, no feeder, no ramp / platform decks, no models left", p["bulk"] is None and p["feeder"] is None and G(A, f"() => {GR}.groundAt(-20.82, -4.5)") == 0
       and G(A, f"() => {GR}.procObj().scene.children.filter((o) => o.name === 'goldrush-ramp' || o.name === 'goldrush-bulkhopper').length") == 0, str(p["owned"]))


# ======================================================================
# DEV
# ======================================================================

def dev_pack(browser, shots):
    logdir = Path(tempfile.mkdtemp(prefix="gr7_dev_"))
    on, base, tmp, log = DEV.start_dev_server(DEV.CODE, logdir / "server.log")
    try:
        user = login(base, "Dev7")
        ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
        open_game(A)
        # snapshot / restore: a normal phase-7 mine (hopper with layers, feeder AUTO, material on its tray)
        automation(A)
        for kind, ml in (("dirt", 40000), ("gravel", 30000)):
            M6.barrow_batch(A, kind, ml)
            G(A, f"() => {GR}.procPour('barrow', 'bulk')")
        G(A, f"() => {{ {GR}.procWater(false); {GR}.procFeederMode('on'); }}")
        G(A, f"() => {GR}.procTick(400)")
        G(A, f"() => {{ {GR}.flushLoot(); {GR}.save(); }}")
        state = lambda: (lambda p: {"bulk": p["bulk"]["layers"], "tray": p["feeder"]["trayMl"], "mode": p["feeder"]["mode"], "hopper": p["sluice"]["hopper"], "ledger": p["ledger"]})(proc(A))
        before = state()
        DEV.open_panel(A)
        DEV.tab(A, "material")
        DEV.cmd(A, "bulk.fill100")
        DEV.cmd(A, "feeder.stop")
        changed = state()
        A.click("[data-dev=restore]")
        A.wait_for_selector(".gr-dev-modal:not([hidden]) [data-dev-modal=ok]", timeout=5000)
        A.click("[data-dev-modal=ok]")
        wait_for(lambda: G(A, f"() => !!(window.__goldrush && {GR}.state && {GR}.state().seed && {GR}.proc().bulk)"), 60)
        gr_start(A)
        after = state()
        ok("DEV snapshot / restore: the bulk hopper's layers, the feeder's lever and tray, the sluice hopper come back exactly", changed != before and after == before, str({k: (before[k], after[k]) for k in before if before[k] != after[k]})[:240])
        # the preset: phase 7 in under 2 minutes
        DEV.open_panel(A)
        DEV.tab(A, "quick")
        t0 = time.time()
        r = DEV.cmd(A, "quick.phase7")
        p = proc(A)
        ok("DEV preset 'Phase 7 Automation': every item up to phase 7, all built, bulk hopper half full, feeder on AUTO, water on, a full barrow at the ramp's foot, cash",
           r and not r["error"] and all(x in p["owned"] for x in ("wheelbarrow", "sluice", "bulkhopper", "feeder")) and p["bulk"]["state"] == "ready" and p["feeder"]["state"] == "ready"
           and p["feeder"]["mode"] == "auto" and p["sluice"]["running"] and abs(p["bulk"]["volumeMl"] - 180000) < 1 and p["barrow"]["batch"]["volumeMl"] == 85000 and eco(A)["cashCents"] == 40000, f"{r}")
        DEV.close_panel(A)
        G(A, f"() => {GR}.setPaused(false)")
        took = G(A, f"() => {GR}.procAct('barrow-take')")
        for k in range(60):
            G(A, f"() => {GR}.walk(0.2, 0, 1)")
            it = proc(A)["interaction"]
            if it and it["id"] == "bulk-dump":
                break
        dumped = G(A, f"() => {GR}.procAct('bulk-dump')")
        G(A, f"() => {GR}.walk(1.5, 0, 0)")
        ok("DEV from the preset in well under 2 minutes: take the barrow, push it up the ramp, tip it into the hopper - the feeder is already feeding the sluice",
           took["ok"] and dumped["ok"] and proc(A)["bulk"]["volumeMl"] > 180000 and proc(A)["feeder"]["status"]["key"] in ("moving", "blocked") and time.time() - t0 < 120, f"{time.time() - t0:.1f} s")
        DEV.open_panel(A)
        DEV.tab(A, "material")
        ids = G(A, "() => [...document.querySelectorAll('[data-dev-cmd]')].map((b) => b.dataset.devCmd)")
        need = ["bulk.give", "bulk.fill0", "bulk.fill25", "bulk.fill50", "bulk.fill100", "bulk.paydirt", "feeder.give", "feeder.start", "feeder.stop", "feeder.auto", "auto.downstreamFull", "auto.cleanReady"]
        ok("DEV the phase-7 actions are in the panel (hopper give / empty / 25 / 50 / full / pay dirt; feeder give / START / STOP / AUTO; downstream full; clean-out ready)",
           all(n in ids for n in need), str([n for n in need if n not in ids]))
        DEV.cmd(A, "bulk.fill25")
        b25 = proc(A)["bulk"]["volumeMl"]
        DEV.cmd(A, "feeder.start")
        DEV.cmd(A, "auto.downstreamFull")
        G(A, f"() => {GR}.walk(1.0, 0, 0)")
        pf = proc(A)
        info = dict(zip(A.locator(".gr-dev-info dt").all_inner_texts(), A.locator(".gr-dev-info dd").all_inner_texts()))
        shot(A, shots, "dev_phase7")
        ok("DEV hopper 25 %, START, downstream full -> the feeder waits (backpressure), the automation debug shows it; the ledger still balances",
           b25 == 90000 and pf["feeder"]["mode"] == "on" and pf["feeder"]["status"]["key"] == "blocked" and "Dosierer" in info and "Vorratstrichter" in info and ledger_ok(A)[0],
           f"bulk {b25} ml, feeder {pf['feeder']['mode']} / {pf['feeder']['status']['key']}, info keys {[k for k in info if k in ('Dosierer', 'Vorratstrichter')]}, ledger {ledger_ok(A)[0]}")
        DEV.tab(A, "world")
        DEV.cmd(A, "world.tp.automation")
        pos = G(A, f"() => {GR}.positionCheck()")
        st = G(A, f"() => {GR}.state()")
        ok("DEV teleport to the automation area (the control post)", pos["ok"] and math.hypot(st["x"] - CONTROL[0], st["z"] - CONTROL[1]) < 0.3, str(pos)[:120])
        DEV.tab(A, "equipment")
        rows = G(A, "() => [...document.querySelectorAll('[data-dev-row]')].map((b) => b.dataset.devRow)")
        ok("DEV the item list includes the phase-7 items automatically", all(any(f"|{i}|" in r for r in rows) for i in ("bulkhopper", "feeder", "bulk.extension", "feeder.fine")), "")
        errs = [e for e in errors(A) if "403" not in e]
        ok("dev part ran without page errors", not errs, str(errs[:3]))
        DEV.close_panel(A)
        close(A)
        ctx.close()
    finally:
        on.terminate()
        on.wait(10)
        log.close()


# ======================================================================
# PHONE
# ======================================================================

def mobile(browser, base, user, shots):
    for name, vp in (("portrait", dict(PHONE)), ("landscape", dict(viewport={"width": 844, "height": 390}, device_scale_factor=3, is_mobile=True, has_touch=True))):
        ctx, Mo = client(browser, base, user, vp, extra_init=[seeded()])
        fresh(Mo)
        kit7(Mo, ["bulkhopper", "feeder"])
        M6.install(Mo)
        labels = []
        def lab():
            time.sleep(0.45)
            return Mo.inner_text(".gr-ctx-btn") if Mo.is_visible(".gr-ctx-btn") else ""
        at_post(Mo)
        labels.append(lab()); yaw0 = G(Mo, f"() => {GR}.state().yaw"); Mo.tap(".gr-ctx-btn"); yaw1 = G(Mo, f"() => {GR}.state().yaw")
        time.sleep(3.0)
        at_post(Mo)
        labels.append(lab()); Mo.tap(".gr-ctx-btn")
        time.sleep(2.2)
        at_post(Mo)
        labels.append(lab()); Mo.tap(".gr-ctx-btn")
        mode = proc(Mo)["feeder"]["mode"]
        M6.barrow_batch(Mo, "paydirt", 60000)
        G(Mo, f"(w) => {GR}.procBarrowPlace(w[0], w[1], Math.PI)", list(RAMP_FOOT_WHEEL))
        b = proc(Mo)["barrow"]
        G(Mo, f"(b) => {GR}.pose({{ x: b.x + Math.sin(b.yaw) * 2.15, z: b.z + Math.cos(b.yaw) * 2.15, yaw: b.yaw, pitch: -0.3 }})", b)
        labels.append(lab()); Mo.tap(".gr-ctx-btn")
        for k in range(60):
            G(Mo, f"() => {GR}.walk(0.2, 0, 1)")
            it = proc(Mo)["interaction"]
            if it and it["id"] == "bulk-dump":
                break
        labels.append(lab())
        shot(Mo, shots, f"{19 if name == 'portrait' else 20}_mobile_{name}")
        Mo.tap(".gr-ctx-btn")
        wait_for(lambda: not proc(Mo)["barrow"]["dumping"], 4)
        ok(f"PHONE {name}: one context button for the automation - AUFBAUEN, MONTIEREN, AUTO at the post, GREIFEN, AUSKIPPEN on the platform; tapping it does not turn the camera",
           labels == ["AUFBAUEN", "MONTIEREN", "AUTO", "GREIFEN", "AUSKIPPEN"] and mode == "auto" and yaw0 == yaw1 and proc(Mo)["bulk"]["volumeMl"] == 60000, f"{labels} yaw {yaw0:.3f}/{yaw1:.3f}")
        errs = errors(Mo)
        ok(f"phone {name} part ran without page errors", not errs, str(errs[:3]))
        close(Mo)
        ctx.close()


# ======================================================================
# PERFORMANCE / LONG RUN
# ======================================================================

def perf(browser, base, user, shots):
    out = {}
    for name, vp in (("desktop", dict(viewport={"width": 1366, "height": 768})), ("phone", dict(PHONE))):
        ctx, A = client(browser, base, user, vp, extra_init=[seeded()])
        fresh(A)
        automation(A)
        bulk_batch(A, "paydirt", 300000)
        G(A, f"() => {{ {GR}.procWater(true); {GR}.procFeederMode('on'); }}")
        G(A, f"(t) => {{ {GR}.procObj().sluice.tailMl = 6e6; {GR}.pose({{ x: -17.5, z: 1.2, yaw: 0.6, pitch: -0.3 }}); {GR}.setPaused(false); }}")
        time.sleep(1.0)
        A.evaluate(M6.FRAME_REC); time.sleep(3); f1 = A.evaluate(M6.FRAME_STOP)
        i1 = G(A, f"() => {GR}.info()")
        out[name] = {"automation": f1, "calls": i1["drawCalls"], "tris": i1["triangles"]}
        print(f"  perf {name}: {out[name]}", flush=True)
        close(A)
        ctx.close()
    ok("PERFORMANCE: 60 fps looking at the running automation (hopper, feeder, sluice, a big heap) on desktop and the emulated phone, draw calls bounded",
       all(v["automation"]["fps"] >= 55 for v in out.values()) and all(v["calls"] < 220 for v in out.values()), json.dumps(out))
    ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
    fresh(A)
    automation(A)
    G(A, f"() => {{ {GR}.procWater(true); {GR}.procFeederMode('auto'); }}")
    snap = lambda: {**G(A, f"() => {{ const i = {GR}.info(); return {{ geometries: i.geometries, textures: i.textures, objects: i.sceneObjects }}; }}"), "heap": heap_mb(A)}
    G(A, f"() => {GR}.walk(0.5, 0, 0)")
    s0 = snap()
    rounds = 12 if QUICK else 40
    for k in range(rounds):
        M6.barrow_batch(A, "paydirt" if k % 2 else "gravel", 85000)
        G(A, f"() => {GR}.procPour('barrow', 'bulk')")
        G(A, f"() => {GR}.procTick(420)")
        G(A, f"() => {GR}.walk(0.2, 0, 0)")
        if k % 3 == 2:
            M6.cleanout(A)
            G(A, f"() => {{ {GR}.procWater(true); let n = 0; while (n++ < 30 && {GR}.procAct('pan-fill').ok) {{ {GR}.procWork(30); {GR}.procCollect(); }} }}")
    time.sleep(0.4)
    s1 = snap()
    lok, L, p = ledger_ok(A)
    ok(f"LONG RUN {rounds} barrow loads ({rounds * 85} l) through bulk hopper, feeder and sluice, clean outs, panning - geometry / textures / objects / heap stable, the ledger exact",
       s1["geometries"] <= s0["geometries"] + 2 and s1["textures"] == s0["textures"] and s1["objects"] == s0["objects"] and (s0["heap"] is None or s1["heap"] - s0["heap"] < 15) and lok,
       f"{s0} -> {s1}, washed {p['sluice']['stats']['processedMl']} ml")
    close(A)
    ctx.close()


# ======================================================================
# ECONOMY (A7-D7, 660 min)
# ======================================================================

def economy(browser, base, user):
    seeds = 100 if FULL else (3 if QUICK else 6)
    ctx, A = client(browser, base, user, dict(viewport={"width": 960, "height": 600}), extra_init=[seeded()])
    runs = {}
    t0 = time.time()
    for st in ("A7", "B7", "C7", "D7"):
        runs[st] = [bench_seed(A, 1001 + n * 7, 660, "hand", st) for n in range(seeds)]
    ok(f"the phase-7 benchmark ran: {seeds} seeds x 660 min x 4 strategies", all(len(v) == seeds for v in runs.values()), f"{time.time() - t0:.0f} s")
    every = [r for rs in runs.values() for r in rs]
    med = lambda v: sorted(v)[len(v) // 2] if v else None
    bh = med([r["bought"]["bulkhopper"] / 60 for r in every if "bulkhopper" in r["bought"]])
    fd = med([r["bought"]["feeder"] / 60 for r in every if "feeder" in r["bought"]])
    ok("bulk hopper after ~6,5-7,5 h (median over all runs 370-470 min)", bh and 370 <= bh <= 470, f"{bh and round(bh)} min")
    # phase 7A: the classifier era earns less (the per-minute ladder of the processing tools), the
    # canonical median moved from 482 to 531 min - a few seeds scatter round it (6 seeds: 561)
    ok("feeder after ~8-9,5 h (median 440-590 min)", fd and 440 <= fd <= 590, f"{fd and round(fd)} min")
    worth = {st: [r["snap"]["39600"]["earned"] + r["snap"]["39600"].get("pouch", 0) for r in rs] for st, rs in runs.items()}
    ratio = {}
    for a in worth:
        for b in worth:
            if a < b:
                rr = sorted(x / y for x, y in zip(worth[a], worth[b]) if y)
                ratio[f"{a}/{b}"] = round(rr[len(rr) // 2], 3)
    lim = 1.2 if FULL else 1.6
    ok(f"no path dominates: seed by seed no strategy more than {round((lim - 1) * 100)} % ahead after 11 h{'' if FULL else f' ({seeds} seeds: smoke check, canonical = --full-bench)'}", all(1 / lim <= v <= lim for v in ratio.values()), str(ratio))
    late = med([(r["snap"]["39600"]["earned"] - r["snap"]["36000"]["earned"]) / 60 for r in every])
    p6 = med([(r["snap"]["21600"]["earned"] - r["snap"]["18000"]["earned"]) / 60 for r in every])
    ok("automation pays a little, no explosion: cash per minute at 10-11 h is 1,05x-2x that at 5-6 h", p6 and 1.05 <= late / p6 <= 2.0, f"{p6 / 100:.2f} -> {late / 100:.2f} EUR/min")
    pile = med([100 * r["removedM3"] / r["pileM3"] for r in every])
    ok("the mountain after 11 h: still a huge task (< 3 % moved)", pile < 3, f"{pile:.2f} %")
    close(A)
    ctx.close()


def main():
    shots = None
    if "--shots" in sys.argv:
        shots = Path(sys.argv[sys.argv.index("--shots") + 1])
        shots.mkdir(parents=True, exist_ok=True)
    engine = sys.argv[sys.argv.index("--browser") + 1] if "--browser" in sys.argv else "chromium"
    proc_, base, tmp = start_server()
    try:
        user = login(base, "Auto7")
        with sync_playwright() as p:
            browser = getattr(p, engine).launch(args=GPU_ARGS if engine == "chromium" else [])
            want = lambda part: not ONLY or part in ONLY
            ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
            if want("bulk"):
                bulk(A, shots)
            if want("feeder"):
                feeder(A, shots)
            if want("chain"):
                chain(A, shots)
            if want("polish"):
                polish(A, shots)
            if want("save"):
                saves(A)
            if shots and want("polish"):
                fresh(A)
                automation(A)
                G(A, f"() => {GR}.setPaused(true)")
                look(A, shots, "18_camp_overview", {"x": -9.5, "y": 9.5, "z": 9.0, "tx": -18.5, "ty": 0.5, "tz": -2.5}, 0.3)
            errs = errors(A)
            ok("desktop part ran without page errors", not errs, str(errs[:3]))
            close(A)
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
