"""End-to-end check of GoldRush phase 7B: material reality, processing UX, the bucket ledger audit.

  ledger    the same dig cells three times - A straight to spoil, B into a bucket, C into a wheelbarrow:
            every visible piece is found exactly once (now when direct / overflow, later by washing when it
            went into the container), fine gold the same, gold in == pouch + containers + processing + tailings
            + spoil to the microgram; a partly full container and the overflowing dig; save / reload before
            and after processing
  shots     human QA screenshots (--shots DIR; scratch only)
  stable    10 000 scoop / release cycles, bucket / barrow filled and emptied 20 times, a long classifier run:
            no new geometry, mesh, texture or heap growth; the fill rises with the litres, the heap grows, the
            classifier's heap sinks and leaves the coarse part
  ux        "[E] Mit Waschschale waschen", the one-time hint, the bowl in view; a barrow at the wash place:
            the classifier / the sluice's hopper first, the pan straight from it still possible
  mobile    the basic wash on the phone
  perf      draw calls / frame rate with every 7B load on show (desktop, phone)
  dev       the 7B pack: preset "Phase 7B Material-QA", every QA button, the gold ledger view (devtools only)
  bench     the method ladder per active minute after the fix (direct / bucket + bowl / + pan / + classifier)

Runs the server from temp copies (the real database is never touched).

    python tests/e2e/goldrush_material_e2e.py [--shots DIR] [--quick] [--browser webkit] [--only parts]
"""

import json
import os
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from goldrush_bench import run_seed as bench_seed  # noqa: E402
from goldrush_e2e import GPU_ARGS, client, errors  # noqa: E402
from goldrush_tools_e2e import SPOT, seeded  # noqa: E402
import goldrush_quality_e2e as Q  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

QUICK = "--quick" in sys.argv
ONLY = set(sys.argv[sys.argv.index("--only") + 1].split(",")) if "--only" in sys.argv else None
RESULTS = []
GR = "window.__goldrush"
G, proc, eco, fresh, reopen, at_trough = Q.G, Q.proc, Q.eco, Q.fresh, Q.reopen, Q.at_trough


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def pouch_ug(page):
    return eco(page)["pouchSummary"]["totalGoldUg"]


# ======================================================================
# LEDGER - the same cells: direct, bucket, wheelbarrow
# ======================================================================

def setup(page, mode):
    """a fresh mine (seed 4242), the shovel, and the container of this run (none / bucket / wheelbarrow)"""
    fresh(page, 4242)
    G(page, f"() => {{ const g = {GR}; g.grant('shovel'); g.equipNow('shovel'); if ('{mode}' !== 'direct') g.procGrant('bucket'); if ('{mode}' === 'barrow') g.procGrant('wheelbarrow'); }}")


def place(page, mode):
    """the container right beside the player, where the bench bot puts it"""
    if mode == "bucket":
        G(page, f"""() => {{ const g = {GR}, s = g.state(), y = s.yaw; g.procPlaceBucket(s.x + Math.cos(y) * 0.55 + Math.sin(y) * 0.25, s.z - Math.sin(y) * 0.55 + Math.cos(y) * 0.25); }}""")
    elif mode == "barrow":
        G(page, f"""() => {{ const g = {GR}, s = g.state(), y = s.yaw, rx = Math.cos(y), rz = -Math.sin(y), fx = -Math.sin(y), fz = -Math.cos(y);
          const tx = s.x + rx * 1.15 - fx * 0.2, tz = s.z + rz * 1.15 - fz * 0.2; g.procBarrowPlace(tx + fx * 0.61, tz + fz * 0.61, y); }}""")


def dig_run(page, mode, n):
    """n shovel digs at the same deterministic spots; per dig: what came out of the ground and where it went"""
    setup(page, mode)
    rows = []
    p0, s0 = pouch_ug(page), proc(page)["ledger"]["spoilFineUg"]
    for k in range(n):
        G(page, SPOT, {"want": "dirt", "reach": 2.0, "start": 0.2 + (k % 6) * 0.15, "fresh": True})
        place(page, mode)
        r = G(page, f"() => {GR}.act({{ visuals: false, tool: 'shovel' }})") or {}
        if not r.get("ok") or r.get("blocked"):
            continue
        rows.append({"vol": r["volumeMl"], "fine": r["fineUg"], "finds": r["digFinds"], "found": r["keys"], "intoMl": r["intoMl"], "spilledMl": r["spilledMl"],
                     "intoFinds": r["intoFinds"], "intoUg": r["intoUg"]})
    p = proc(page)
    box = p["bucket"] if mode == "bucket" else (p["barrow"] if mode == "barrow" else None)
    return {"rows": rows, "pouch": pouch_ug(page) - p0, "pouch0": p0, "pouchAll": pouch_ug(page), "spoil": p["ledger"]["spoilFineUg"] - s0, "ledger": p["ledger"], "box": box,
            "pending": len(G(page, f"() => {GR}.economy().pending")), "goldIn": sum(r["fine"] + sum(f["ug"] for f in r["finds"]) for r in rows)}


def process_run(page, mode, run):
    """save / reload with the full container, wash it all at the trough, save / reload again -> checks"""
    name = "B bucket" if mode == "bucket" else "C wheelbarrow"
    key = "bucket" if mode == "bucket" else "barrow"
    before = proc(page)[key]
    reopen(page)
    after = proc(page)[key]
    ok(f"LEDGER {name} save / reload before processing: the container comes back with the same pieces (keys), fine gold and volume - nothing new in the pouch",
       before["batch"] == after["batch"] and pouch_ug(page) == run["pouchAll"], f"{len(after['batch']['finds'])} pieces, {after['batch']['fineUg']} ug fine")
    if mode == "bucket":
        G(page, f"() => {GR}.procBucketToWash()")
    else:
        G(page, f"() => {GR}.procBarrowPlace(-15.2, 5.6, Math.PI / 2)")
    at_trough(page)
    got = []
    for _ in range(90):
        if not G(page, f"() => {GR}.procAct('pan-fill').ok"):
            break
        G(page, f"() => {GR}.procWork(30)")
        got.append(G(page, f"() => {GR}.procCollect()"))
    lok, L, p = Q.ledger_ok(page)
    pieces = sum(c.get("pieces", 0) for c in got)
    total = pouch_ug(page)
    ok(f"LEDGER {name} processing brings the carried pieces out: each once into the pouch (washed), the rest in the tailings - gold in == pouch + tailings + spoil",
       lok and pieces == len(after["batch"]["finds"]) and p[key]["batch"]["volumeMl"] == 0 and total - run["pouch0"] + L["tailUg"] + run["spoil"] == run["goldIn"],
       f"{len(got)} bowl loads, {pieces} pieces, pouch {total - run['pouch0']} + tailings {L['tailUg']} + spoil {run['spoil']} = in {run['goldIn']}")
    reopen(page)
    ok(f"LEDGER {name} save / reload after processing: pouch and ledger unchanged (nothing paid twice)", pouch_ug(page) == total and proc(page)["ledger"] == L, f"{pouch_ug(page)} ug")


def ledger(A, shots):
    n = 10 if QUICK else 14
    d = dig_run(A, "direct", n)
    allkeys = [f["key"] for r in d["rows"] for f in r["finds"]]
    ok("LEDGER A direct mining: every piece is found right at the dig (into the pouch), all the fine gold goes to the spoil heap",
       [k for r in d["rows"] for k in r["found"]] == allkeys and d["pouch"] == sum(f["ug"] for r in d["rows"] for f in r["finds"]) and d["spoil"] == sum(r["fine"] for r in d["rows"]),
       f"{len(allkeys)} pieces {d['pouch']} ug, spoil {d['spoil']} ug")
    for mode, digs in (("bucket", n), ("barrow", 58 if QUICK else 64)):
        run = dig_run(A, mode, digs)
        box = run["box"]["batch"]
        found = [k for r in run["rows"] for k in r["found"]]
        carried = [f["key"] for f in box["finds"]]
        dug = [f["key"] for r in run["rows"] for f in r["finds"]]
        full = [r for r in run["rows"] if r["spilledMl"] == 0 and r["intoMl"] == r["vol"]]
        over = [r for r in run["rows"] if r["intoMl"] > 0 and r["spilledMl"] > 0]
        spoil_digs = [r for r in run["rows"] if r["intoMl"] == 0]
        name = "B bucket" if mode == "bucket" else "C wheelbarrow"
        if mode == "bucket":
            cells = lambda rr: [(r["vol"], r["fine"], tuple(f["key"] for f in r["finds"])) for r in rr]
            ok("LEDGER identical cells: the same digs take exactly the same volume, fine gold and pieces with a bucket beside you as without (A = B)",
               cells(d["rows"]) == cells(run["rows"]), f"{len(d['rows'])} digs, {len(allkeys)} pieces")
            ok("LEDGER fine gold unchanged by the container: A's spoil == B's bucket fine gold + B's spoil (the same digs)",
               d["spoil"] == box["fineUg"] + run["spoil"], f"A spoil {d['spoil']}, B bucket {box['fineUg']} + spoil {run['spoil']}")
        ok(f"LEDGER {name}: a dig that fits takes its pieces into the container - nothing found at the dig, no '+ EUR' while filling",
           full and all(not r["found"] and r["intoFinds"] == len(r["finds"]) for r in full), f"{len(full)} digs into it, pieces carried {sum(r['intoFinds'] for r in full)}")
        ok(f"LEDGER {name}: no piece twice - carried and found are disjoint and together exactly what was dug",
           not (set(carried) & set(found)) and sorted(carried + found) == sorted(dug) and len(set(dug)) == len(dug), f"carried {len(carried)}, found {len(found)}, dug {len(dug)}")
        ok(f"LEDGER {name}: the overflowing dig splits exactly (volume in + spilled == dug, its pieces carried or found); after it everything is spoil",
           len(over) == 1 and over[0]["intoMl"] + over[0]["spilledMl"] == over[0]["vol"] and over[0]["intoFinds"] + len(over[0]["found"]) == len(over[0]["finds"]) and spoil_digs
           and all(len(r["found"]) == len(r["finds"]) for r in spoil_digs),
           f"overflow {over and {k: over[0][k] for k in ('vol', 'intoMl', 'spilledMl', 'intoFinds')}}; then {len(spoil_digs)} digs to spoil")
        L = run["ledger"]
        ok(f"LEDGER {name}: gold in == pouch + container + spoil, to the microgram (the ledger's input is the container's content)",
           run["goldIn"] == run["pouch"] + run["box"]["goldUg"] + run["spoil"] and L["inUg"] == run["box"]["goldUg"] and L["inFinds"] == len(carried) and run["pending"] == 0,
           f"in {run['goldIn']} = pouch {run['pouch']} + container {run['box']['goldUg']} + spoil {run['spoil']}")
        process_run(A, mode, run)
    # an overflowing dig WITH pieces (a dig of 1,6 l with 3 pieces, 0,8 l of room): the share that fits takes
    # floor(3 x 0,5) = 1 piece, the other 2 are found now; fine gold split in proportion - exact
    setup(A, "bucket")
    G(A, SPOT, {"want": "dirt", "reach": 2.0, "start": 0.3, "fresh": True})
    place(A, "bucket")
    res = G(A, f"""async () => {{
      const g = {GR}, pr = g.procObj(), s = g.state(), m = await import('/games/goldrush/goldrush-devactions.js');
      pr.devSetBucket(m.devBatch('dirt', pr.capacityMl - 800));
      const b0 = pr.bucket.batch.serialize(), spoil0 = pr.ledger.spoilFineUg;
      const finds = [{{ cls: 3, massUg: 1500, key: 'x:1:1' }}, {{ cls: 4, massUg: 4200, key: 'x:1:2' }}, {{ cls: 2, massUg: 400, key: 'x:1:3' }}];
      const r = {{ ok: true, kind: 'dig', removedVolume: 0.0016, massByMat: [2.1, 0, 0, 0], fineUg: 9000, finds, findCount: 3 }};
      const out = pr.collect(r, {{ x: s.x, z: s.z }}, 'shovel');
      const b1 = pr.bucket.batch.serialize();
      return {{ into: out.intoMl, spilled: out.spilledMl, found: out.finds.map((f) => f.key), carried: b1.finds.map((f) => f.key).filter((k) => k.startsWith('x:')),
        fineIn: b1.fineUg - b0.fineUg, spoil: pr.ledger.spoilFineUg - spoil0, full: b1.volumeMl === pr.capacityMl }};
    }}""")
    ok("LEDGER overflow with pieces: of a 1,6 l dig only 0,8 l fit - 1 of its 3 pieces goes in, 2 are found now; its fine gold split 50 / 50 (container / spoil), nothing lost",
       res["into"] == 800 and res["spilled"] == 800 and len(res["carried"]) == 1 and len(res["found"]) == 2 and not set(res["carried"]) & set(res["found"])
       and res["fineIn"] + res["spoil"] == 9000 and res["fineIn"] == 4500 and res["full"], json.dumps(res))
    errs = errors(A)
    ok("LEDGER part without page errors", not errs, str(errs[:3]))


# ======================================================================
# SHOTS - human QA (scratch only)
# ======================================================================

def snap(page, shots, name):
    """the current frame as it is (no pause - pausing ends a pan / sieve you are working at)"""
    time.sleep(0.12)
    page.screenshot(path=str(shots / f"gr7b_{name}.png"))


def scoop_shot(page, shots, name, want):
    """a real shovel stroke (mouse held) frozen while the load sits on the blade"""
    G(page, SPOT, {"want": want, "reach": 2.0, "start": 0.35, "fresh": True})
    page.mouse.move(683, 384)
    page.mouse.down()
    t0, got = time.time(), None
    while time.time() - t0 < 3.0:
        h = G(page, f"() => {GR}.hand()")
        if h["phase"] in ("scoop", "dump") and h["load"] > 0.55:
            G(page, f"() => {GR}.setPaused(true)")
            got = h
            break
        time.sleep(0.01)
    page.screenshot(path=str(shots / f"gr7b_{name}.png"))
    G(page, f"() => {GR}.setPaused(false)")
    page.mouse.up()
    return got


def world_look(page, shots, name, cam, frames=0.15):
    Q.look(page, shots, "_tmp", cam, frames)
    os.replace(shots / "gr7a__tmp.png", shots / f"gr7b_{name}.png")


def visual(A, shots):
    if not shots:
        return
    fresh(A)
    G(A, f"() => {{ const g = {GR}; g.grant('shovel'); g.grant('pickaxe'); for (const id of ['bucket', 'classifier', 'wheelbarrow']) g.procGrant(id); g.equipNow('shovel'); g.setPaused(false); }}")
    scoop_shot(A, shots, "01_dirt_scoop", "dirt")
    scoop_shot(A, shots, "02_gravel_scoop", "gravel")
    # the bucket at the wash place, a quarter / full
    for name, ml in (("03_bucket_25", 2500), ("04_bucket_100", 10000)):
        Q.bucket_batch(A, "paydirt", ml)
        world_look(A, shots, name, {"x": -15.75, "y": 0.95, "z": 3.95, "tx": -16.15, "ty": 0.12, "tz": 3.5})
    G(A, f"() => {GR}.procObj().devSetBucket(null)")
    # the barrow at the wash place: 15 / 50 / 100 %
    for name, ml in (("05_barrow_15", 12750), ("06_barrow_50", 42500), ("07_barrow_100", 85000)):
        G(A, f"""async (ml) => {{ const m = await import('/games/goldrush/goldrush-devactions.js'); const g = {GR}; g.procBarrowPlace(-15.2, 5.6, Math.PI / 2); g.procObj().devSetBarrow(m.devBatch('paydirt', ml)); }}""", ml)
        world_look(A, shots, name, {"x": -13.4, "y": 2.1, "z": 7.1, "tx": -15.3, "ty": 0.45, "tz": 5.5})
    G(A, f"() => {{ {GR}.procObj().devSetBarrow(null); {GR}.procBarrowPlace(-15.2, 9.2, -Math.PI / 2); }}")
    # the classifier: loaded, half shaken, the coarse remainder
    Q.bucket_batch(A, "paydirt", 10000)
    G(A, f"() => {{ const g = {GR}; g.pose({{ x: -15.9, z: 4.8, yaw: Math.PI / 2, pitch: -0.62 }}); g.stationNow(); g.procAct('sieve-load'); }}")
    cam = {"x": -16.3, "y": 1.5, "z": 5.35, "tx": -16.95, "ty": 0.62, "tz": 4.8}
    world_look(A, shots, "08_classifier_before", cam)
    G(A, f"() => {{ const g = {GR}; g.pose({{ x: -15.9, z: 4.8, yaw: Math.PI / 2, pitch: -0.62 }}); g.procAct('sieve-work'); g.procWork(1.7); }}")
    world_look(A, shots, "09_classifier_middle", cam)
    G(A, f"() => {{ const g = {GR}; g.procAct('sieve-work'); g.procWork(30); }}")
    world_look(A, shots, "10_classifier_coarse", cam, 0.05)
    G(A, f"() => {GR}.walk(2.0, 0, 0)")
    # the gold pan: start, muddy, black sand, the gold
    G(A, f"() => {{ const g = {GR}; g.procGrant('pan'); }}")
    Q.bucket_batch(A, "paydirt", 10000)
    Q.at_trough(A)
    G(A, f"() => {GR}.procAct('pan-fill')")
    G(A, f"() => {GR}.procWork(0.3)")
    G(A, f"() => {GR}.walk(0.05, 0, 0)")
    snap(A, shots, "11_pan_start")
    for name, t in (("12_pan_mid", 3.0), ("13_pan_black_sand", 4.0)):
        G(A, f"(t) => {GR}.procWork(t)", t)
        G(A, f"() => {GR}.walk(0.05, 0, 0)")
        snap(A, shots, name)
    G(A, f"() => {GR}.procWork(30)")
    G(A, f"() => {GR}.walk(0.05, 0, 0)")
    snap(A, shots, "14_pan_final_gold")
    G(A, f"() => {GR}.procCollect()")
    # the basic wash prompt: no pan yet, a full bucket at the wash place
    fresh(A)
    G(A, f"() => {{ const g = {GR}; g.grant('shovel'); g.procGrant('bucket'); g.equipNow('shovel'); }}")
    Q.bucket_batch(A, "paydirt", 10000)
    G(A, f"() => {GR}.pose({{ x: -15.6, z: 2.6, yaw: 1.35, pitch: -0.45 }})")
    G(A, f"() => {GR}.walk(0.3, 0, 0)")
    snap(A, shots, "15_basic_wash_prompt")
    # geology and terrain close-ups
    sp = G(A, Q.STREAKSPOT, 0)
    if sp:
        world_look(A, shots, "16_mineralized_close", {"x": sp["px"], "y": sp["h"] + 0.9, "z": sp["pz"], "tx": sp["x"], "ty": sp["h"], "tz": sp["z"]})
    mp = G(A, Q.MATSPOT, 0)
    if mp:
        world_look(A, shots, "17_terrain_close", {"x": mp["px"], "y": mp["h"] + 0.8, "z": mp["pz"], "tx": mp["x"], "ty": mp["h"], "tz": mp["z"]})
        for _ in range(8):
            Q.aim_point(A, mp)
            G(A, f"() => {GR}.act({{ visuals: false, tool: 'shovel' }})")
        h = G(A, f"(p) => {GR}.heightAt(p[0], p[1])", [mp["x"], mp["z"]])
        world_look(A, shots, "18_fresh_cut_close", {"x": mp["px"], "y": h + 0.85, "z": mp["pz"], "tx": mp["x"], "ty": h, "tz": mp["z"]})


# ======================================================================
# STABLE - the loose loads never grow: 10 000 scoops, fills, a long classifier run
# ======================================================================

STATS = f"""() => {{ const g = {GR}, i = g.info(); let n = 0; g.procObj().scene.traverse(() => n++);
  return {{ geo: i.geometries, tex: i.textures, obj: i.sceneObjects, calls: i.drawCalls, nodes: n, heap: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null }}; }}"""


def stable(A):
    fresh(A)
    Q.kit(A, ["shovel", "bucket", "pan", "classifier", "wheelbarrow"])
    G(A, f"() => {GR}.walk(0.3, 0, 0)")
    s0 = G(A, STATS)
    # 10 000 scoop / release cycles on the blade: load builds, slides to the tip, leaves - all four materials
    r = G(A, f"""() => {{
      const M = {GR}.procObj().hands.models, L = M.bladeLoad, geo = L.geo, arr = geo.attributes.position.array, lumps = L.lumps, t0 = performance.now();
      let maxN = 0, shapes = new Set(), flat = 0;
      for (let c = 0; c < 10000; c++) {{
        for (const [ld, sl] of [[0.25, 0], [0.6, 0], [1, 0], [1, 0.35], [0.7, 0.7], [0.2, 1], [0, 0]]) {{
          M.setLoad(ld, sl, ((c % 7) - 3) * 0.002, ((c % 5) - 2) * 0.003, c % 4);
          maxN = Math.max(maxN, lumps.count);
          if (ld === 1 && sl === 0 && c < 4) {{ shapes.add(L._sig); flat = Math.max(flat, L.p.h / Math.min(L.p.rx, L.p.rz)); }}
        }}
      }}
      return {{ ms: performance.now() - t0, same: L.geo === geo && geo.attributes.position.array === arr && L.lumps === lumps, maxN, max: L.max, off: !L.visible, shapes: shapes.size, flat }};
    }}""")
    G(A, f"() => {GR}.walk(0.3, 0, 0)")
    s1 = G(A, STATS)
    ok("STABLE 10 000 scoop / release cycles: the blade's load keeps its buffers (no new geometry, mesh or texture), lumps within their pool, gone when empty",
       r["same"] and r["maxN"] <= r["max"] and r["off"] and (s1["geo"], s1["tex"], s1["obj"], s1["nodes"]) == (s0["geo"], s0["tex"], s0["obj"], s0["nodes"]),
       f"{r['ms']:.0f} ms, lumps <= {r['maxN']}/{r['max']}, {s0} -> {s1}")
    ok("STABLE the scoop is a loose heap, not a ball: per material its own pour, flatter than it is wide",
       r["shapes"] == 4 and r["flat"] < 0.75, f"{r['shapes']} shapes, height/width {r['flat']:.2f}")
    # the bucket 0..10 l and the barrow 0..85 l, filled and emptied 20 times
    r = G(A, f"""() => {{
      const pr = {GR}.procObj(), M = pr.models, B = pr.worldBucket, w = pr.barrow, MM = pr.mech, comp = [5000, 2000, 2500, 600];
      const bl = B.userData.load, wl = w.group.userData.load, bg = bl.geo, wg = wl.geo, nb = B.children.length, nw = w.group.children.length;
      const tops = [], barrow = [];
      for (let c = 0; c < 20; c++) for (let k = 0; k <= 100; k++) {{
        M.setBucketFill(B, k * 100, comp);
        MM.setBarrowFill(w.group, k / 100, comp);
        if (c === 0 && k % 25 === 0 && k) {{
          let top = -1; const a = bl.geo.attributes.position.array; for (let i = 1; i < a.length; i += 3) top = Math.max(top, a[i]);
          tops.push(top);
          barrow.push({{ rx: wl.p.rx, h: wl.p.h, y0: wl.p.y0, lobes: wl.p.lobes, lumps: wl.lumps.count }});
        }}
      }}
      M.setBucketFill(B, 0, null); MM.setBarrowFill(w.group, 0, null);
      return {{ same: bl.geo === bg && wl.geo === wg && B.children.length === nb && w.group.children.length === nw, tops, barrow, off: !bl.visible && !wl.visible }};
    }}""")
    G(A, f"() => {GR}.walk(0.3, 0, 0)")
    s2 = G(A, STATS)
    tops, bw = r["tops"], r["barrow"]
    ok("STABLE bucket / barrow filled and emptied 20 times: no extra meshes or geometry, the same two draws each",
       r["same"] and r["off"] and (s2["geo"], s2["tex"], s2["nodes"]) == (s0["geo"], s0["tex"], s0["nodes"]), f"{s0} -> {s2}")
    ok("STABLE the bucket's fill rises with the litres (25 / 50 / 75 / 100 %)", all(b > a for a, b in zip(tops, tops[1:])), str([round(t, 3) for t in tops]))
    ok("STABLE the barrow's heap grows: wider, higher, more mounds and lumps (25 -> 100 %), its base lifts once it fills the tray",
       all(b["rx"] > a["rx"] and b["h"] + b["y0"] > a["h"] + a["y0"] and b["lumps"] >= a["lumps"] for a, b in zip(bw, bw[1:])) and bw[-1]["lobes"] > bw[0]["lobes"] and bw[-1]["y0"] > bw[0]["y0"],
       json.dumps([{k: round(v, 3) for k, v in x.items()} for x in bw]))
    # the classifier: a heap that sinks while shaken, the coarse part left at the end; 8 loads in a row
    looks, heap0 = [], G(A, f"() => {GR}.procObj().cls.userData.heapLoad.geo.uuid")
    for k in range(4 if QUICK else 8):
        Q.bucket_batch(A, "paydirt", 10000)
        G(A, f"() => {{ const g = {GR}; g.pose({{ x: -15.9, z: 4.8, yaw: Math.PI / 2, pitch: -0.62 }}); g.procAct('sieve-load'); }}")
        row = []
        for t in (0, 1.2, 30):
            if t:
                G(A, f"(t) => {GR}.procWork(t)", t)
            row.append(G(A, f"""() => {{ const pr = {GR}.procObj(), H = pr.cls.userData.heapLoad, c = H.p ? H.p.comp : [0, 0, 0, 0], m = c[0] + c[1] + c[2] + c[3] || 1;
              return {{ vis: H.visible, h: H.p ? H.p.h : 0, coarse: (c[2] + c[3]) / m, prog: pr.sieve.progress }}; }}"""))
        looks.append(row)
        G(A, f"() => {{ const pr = {GR}.procObj(); pr._devTail(pr.tub); pr.tub = pr._batch('concentrate'); pr._fills(); }}")
        G(A, f"() => {GR}.walk(2.2, 0, 0)")
    s3 = G(A, STATS)
    st0, mid, end = looks[0]
    lok, L, p = Q.ledger_ok(A)
    ok("STABLE classifier: the heap sinks as the fines go through (lower at half time), at the end only the coarse part lies there",
       st0["vis"] and mid["vis"] and mid["h"] < st0["h"] and end["vis"] and end["coarse"] > st0["coarse"] + 0.15, json.dumps(looks[0]))
    ok(f"STABLE classifier long run ({len(looks)} loads): the same heap buffers, no growth in geometry / textures / objects / heap, the ledger exact",
       G(A, f"() => {GR}.procObj().cls.userData.heapLoad.geo.uuid") == heap0 and (s3["geo"], s3["tex"], s3["obj"]) == (s0["geo"], s0["tex"], s0["obj"])
       and (s0["heap"] is None or s3["heap"] - s0["heap"] < 15) and lok, f"{s0} -> {s3}")
    errs = errors(A)
    ok("STABLE part without page errors", not errs, str(errs[:3]))


# ======================================================================
# UX - the basic wash, the barrow at the wash place
# ======================================================================

def drop_at_wash(page):
    """carry the bucket to the wash place and set it down with [E] (the engine's own path) -> (station, tip)"""
    G(page, f"() => {{ const g = {GR}, pr = g.procObj(); pr.bucket.carried = true; pr._sync(); g.pose({{ x: -15.6, z: 3.6, yaw: 1.4, pitch: -0.4 }}); }}")
    G(page, f"() => {GR}.walk(0.1, 0, 0)")
    sid = G(page, f"() => {{ const s = {GR}.stationNow(); return s && s.id; }}")
    G(page, "() => { const t = document.querySelector('.gr-tip'); if (t) t.textContent = ''; }")
    G(page, f"() => {GR}.useStation()")
    return sid, G(page, "() => { const t = document.querySelector('.gr-tip'); return t ? t.textContent : ''; }")


def ux(A):
    fresh(A)
    Q.kit(A, ["shovel", "bucket"])
    Q.bucket_batch(A, "paydirt", 10000)
    st = at_trough(A)
    ok("UX basic wash: with a bucket at the wash place [E] reads 'Mit Waschschale waschen'", st and st.get("id") == "pan-fill" and st.get("action") == "Mit Waschschale waschen", str(st))
    # the first full bucket set down at the wash place: one short hint, once
    sid1, tip1 = drop_at_wash(A)
    sid2, tip2 = drop_at_wash(A)
    ok("UX the first full bucket at the wash place: one short hint where to wash ('Mit Waschschale waschen'), not again",
       sid1 == "bucket-wash" and "Mit Waschschale waschen" in tip1 and sid2 == "bucket-wash" and tip2 == "", f"{sid1}: {tip1!r} / {sid2}: {tip2!r}")
    # the bowl sits on the trough's near rim, tipped towards you (in view, no marker)
    bowl = G(A, f"""() => {{ const pr = {GR}.procObj(), b = pr.restBowl, m = b.children[0].material;
      return {{ x: b.position.x, y: b.position.y, tilt: b.rotation.z, emissive: m.emissive ? m.emissive.getHex() : 0, color: m.color.getHex() }}; }}""")
    ok("UX the wash bowl reads as a thing to use: on the near rim, tipped to you, lighter wood - no glow",
       bowl["x"] > -16.95 + 0.15 and bowl["tilt"] < -0.2 and bowl["emissive"] == 0, json.dumps(bowl))
    # the barrow at the wash place: the classifier first, the pan straight from the barrow stays possible
    G(A, f"() => {GR}.procObj().devSetBucket(null)")
    Q.kit(A, ["wheelbarrow"])
    G(A, f"""async () => {{ const m = await import('/games/goldrush/goldrush-devactions.js'); const g = {GR}; g.procBarrowPlace(-15.2, 5.6, Math.PI / 2); g.procObj().devSetBarrow(m.devBatch('paydirt', 40000)); }}""")
    plain = at_trough(A)
    Q.kit(A, ["pan", "classifier"])
    better = at_trough(A)
    sieve = G(A, f"() => {{ const g = {GR}; g.pose({{ x: -15.9, z: 4.8, yaw: Math.PI / 2, pitch: -0.5 }}); return g.stationNow(); }}")
    ok("UX barrow at the wash place: without a classifier the pan fills from it plainly; with one the prompt says 'besser: erst sieben' (secondary), the screen takes it",
       plain.get("id") == "pan-fill" and "Schubkarre" in plain["action"] and "besser" not in plain["action"] and better.get("id") == "pan-fill" and "besser: erst sieben" in better["action"]
       and better.get("secondary") and sieve.get("id") == "sieve-load" and "Schubkarre" in sieve["action"], f"{plain} / {better} / {sieve}")
    at_trough(A)
    f = G(A, f"() => {GR}.procAct('pan-fill')")
    ok("UX ... and filling the pan straight from the barrow still works (no hard lock)", f.get("ok") and proc(A)["pan"]["volumeMl"] > 0, str(f))
    G(A, f"() => {{ {GR}.procWork(30); {GR}.procCollect(); }}")
    Q.kit(A, ["sluice"])
    G(A, f"() => {GR}.procObj().devInstallSluice()")
    sl = at_trough(A)
    ok("UX with the sluice built, the better way for a barrow load is its hopper", sl.get("id") == "pan-fill" and "Trichter der Waschrinne" in sl["action"], str(sl))
    lok, L, p = Q.ledger_ok(A)
    ok("UX the ledger stays exact", lok, str({k: L[k] for k in ("inUg", "recoveredUg", "tailUg")}))
    errs = errors(A)
    ok("UX part without page errors", not errs, str(errs[:3]))


# ======================================================================
# DEV - the 7B pack: the material QA preset, the gold ledger view
# ======================================================================

def dev_pack(browser):
    import goldrush_dev_e2e as DEV
    from goldrush_tools_e2e import open_game
    logdir = Path(tempfile.mkdtemp(prefix="gr7b_devpack_"))
    on, base, tmp, log = DEV.start_dev_server(DEV.CODE, logdir / "server.log")
    try:
        user = login(base, "Dev7B")
        ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
        open_game(A)
        t0 = time.time()
        DEV.open_panel(A)
        ids = []
        for cat in ("quick", "material", "diag"):
            DEV.tab(A, cat)
            ids += G(A, "() => [...document.querySelectorAll('[data-dev-cmd], [data-dev-toggle]')].map((b) => b.dataset.devCmd || b.dataset.devToggle)")
        want = ["quick.phase7b", "qa7b.scoopDirt", "qa7b.scoopGravel", "qa7b.bucket25", "qa7b.bucket50", "qa7b.bucket100", "qa7b.bucketKnown", "qa7b.barrow10", "qa7b.barrow40", "qa7b.barrow85",
                "qa7b.sieveStart", "qa7b.sieveMid", "qa7b.sieveEnd", "qa7b.panLow", "qa7b.panHigh", "qa7b.streak", "debug.ledger"]
        ok("DEV the 7B actions are in the panel (preset, scoops, bucket 25 / 50 / 100 %, known find, barrow 10 / 40 / 85 l, classifier start / mid / end, pan low / high, streak, ledger view)",
           all(w in ids for w in want), str([w for w in want if w not in ids]))
        DEV.tab(A, "quick")
        r = DEV.cmd(A, "quick.phase7b")
        p = proc(A)
        hud = G(A, "() => { const h = document.querySelector('.gr-devhud'); return h && !h.hidden ? h.textContent : ''; }")
        ok("DEV preset 'Phase 7B Material-QA': shovel, pickaxe, bucket, pan, classifier, barrow; the gold ledger view on and balanced",
           r and not r["error"] and all(x in p["owned"] for x in ("bucket", "pan", "classifier", "wheelbarrow")) and "GOLD-LEDGER" in hud and "Bilanz Behälter OK" in hud, hud[:200])
        DEV.tab(A, "material")
        res = {}
        for cid in want[1:-1]:
            L0 = proc(A)["ledger"]
            res[cid] = DEV.cmd(A, cid)
            if cid == "qa7b.bucketKnown":
                DEV.close_panel(A)
                b = proc(A)["bucket"]["batch"]
                got = []
                for _ in range(6):
                    if not G(A, f"() => {GR}.procAct('pan-fill').ok"):
                        break
                    G(A, f"() => {GR}.procWork(30)")
                    got.append(G(A, f"() => {GR}.procCollect()"))
                lok, L, pp = Q.ledger_ok(A)
                hud = ""
                G(A, f"() => {GR}.setPaused(false)")
                for _ in range(30):                       # the overlay redraws 4x a second from the game's frames
                    hud = G(A, "() => document.querySelector('.gr-devhud').textContent")
                    if f"in Behälter gegraben  {L['inFinds']} Stück" in hud and "jetzt in Behältern    0 µg" in hud:
                        break
                    time.sleep(0.1)
                ok("DEV 'Eimer mit bekanntem Fund': exactly one known piece in the bucket; washing brings it out once, the ledger view stays balanced",
                   len(b["finds"]) == 1 and b["finds"][0]["key"] == "dev:known:0" and sum(c.get("pieces", 0) for c in got) == 1 and lok and "Bilanz Behälter OK" in hud
                   and L["inFinds"] - L0["inFinds"] == 1 and f"in Behälter gegraben  {L['inFinds']} Stück" in hud and "jetzt in Behältern    0 µg" in hud, f"{len(got)} loads; {hud[:400]}")
                DEV.open_panel(A)
                DEV.tab(A, "material")
            if cid == "qa7b.sieveMid":
                res["midProg"] = proc(A)["sieve"]["progress"]
            if cid in ("qa7b.panLow", "qa7b.panHigh"):
                res[cid + ":fine"] = proc(A)["pan"]["fineUg"]
                DEV.close_panel(A)
                G(A, f"() => {{ {GR}.procAct('pan-work'); {GR}.procWork(30); {GR}.procCollect(); }}")
                DEV.open_panel(A)
                DEV.tab(A, "material")
        DEV.close_panel(A)
        bad = {k: v for k, v in res.items() if isinstance(v, dict) and v.get("error")}
        ok("DEV every 7B QA button runs (scoop dirt / gravel, buckets, barrow loads, classifier stages, pans, streak) - all of it in under 2 minutes",
           not bad and 0.45 <= res.get("midProg", 0) < 1 and res["qa7b.panHigh:fine"] > res["qa7b.panLow:fine"] * 4 and time.time() - t0 < 120,
           f"{time.time() - t0:.0f} s, errors {bad}, mid {res.get('midProg')}, pan fine {res.get('qa7b.panLow:fine')} / {res.get('qa7b.panHigh:fine')}")
        errs = errors(A)
        ok("DEV part without page errors", not errs, str(errs[:3]))
        Q.close(A)
        ctx.close()
    finally:
        on.terminate()
    log.close()
    text = (logdir / "server.log").read_text(encoding="utf-8", errors="replace")
    ok("DEV the server log has no dev code and no session token", DEV.CODE not in text and "token=" not in text.replace("token=***", ""), f"{len(text)} chars")


# ======================================================================
# MOBILE / PERF
# ======================================================================

def mobile(browser, base, user):
    from goldrush_e2e import PHONE
    ctx, P = client(browser, base, user, dict(PHONE), extra_init=[seeded()])
    fresh(P)
    Q.kit(P, ["shovel", "bucket"])
    Q.bucket_batch(P, "paydirt", 10000)
    sid, tip = drop_at_wash(P)
    at_trough(P)
    G(P, f"() => {GR}.walk(0.2, 0, 0)")
    label = P.inner_text(".gr-ctx-btn") if P.is_visible(".gr-ctx-btn") else None
    P.tap(".gr-ctx-btn")
    time.sleep(0.4)
    p = proc(P)
    ok("MOBILE the basic wash on the phone: the hint says WASCHEN (no [E]), one context button, tapping starts the bowl",
       "WASCHEN tippen" in tip and "[E]" not in tip and label and "WASCHEN" in label.upper() and p["work"] == "pan" and p["panTool"] == "bowl", f"{sid}: {tip!r} / {label}")
    errs = errors(P)
    ok("MOBILE part without page errors", not errs, str(errs[:3]))
    Q.close(P)
    ctx.close()


def perf(browser, base, user):
    import goldrush_mech_e2e as M6
    from goldrush_e2e import PHONE
    out = {}
    for name, vp in (("desktop", dict(viewport={"width": 1366, "height": 768})), ("phone", dict(PHONE))):
        ctx, A = client(browser, base, user, vp, extra_init=[seeded()])
        fresh(A)
        Q.kit(A, ["shovel", "pickaxe", "bucket", "classifier", "wheelbarrow", "pan"])
        # every 7B load on show at once: a full barrow, a full bucket, a loaded screen
        G(A, f"""async () => {{ const m = await import('/games/goldrush/goldrush-devactions.js'); const g = {GR}, pr = g.procObj();
          g.procBarrowPlace(-15.2, 5.6, Math.PI / 2); pr.devSetBarrow(m.devBatch('paydirt', 85000)); }}""")
        Q.bucket_batch(A, "paydirt", 10000)
        G(A, f"() => {{ const g = {GR}; g.pose({{ x: -15.9, z: 4.8, yaw: Math.PI / 2, pitch: -0.62 }}); g.procAct('sieve-load'); g.procWork(1.0); g.procStop(); }}")
        Q.bucket_batch(A, "paydirt", 10000)
        for view, pose in (("wash", {"x": -13.6, "z": 6.4, "yaw": 1.05, "pitch": -0.18}), ("mine", {"x": 0.0, "z": 8.0, "yaw": 0.0, "pitch": -0.1})):
            G(A, f"(p) => {{ {GR}.pose(p); {GR}.setPaused(false); }}", pose)
            time.sleep(0.8)
            A.evaluate(M6.FRAME_REC)
            time.sleep(2.5)
            f1 = A.evaluate(M6.FRAME_STOP)
            i1 = G(A, f"() => {GR}.info()")
            out[f"{name}:{view}"] = {"fps": f1["fps"], "p95": f1["p95"], "calls": i1["drawCalls"], "tris": i1["triangles"]}
        print(f"  perf {name}: {json.dumps({k: v for k, v in out.items() if k.startswith(name)})}", flush=True)
        Q.close(A)
        ctx.close()
    ok("PERF the camp with every 7B load on show (barrow full, bucket, screen) < 190 draw calls, the mine < 140; 60 fps desktop and the emulated phone",
       all(v["calls"] < (190 if k.endswith("wash") else 140) and v["fps"] >= 55 for k, v in out.items()), json.dumps(out))


# ======================================================================
# BENCH - the method ladder after the fix
# ======================================================================

def bench(browser, base, user):
    ctx, A = client(browser, base, user, dict(viewport={"width": 960, "height": 600}), extra_init=[seeded()])
    kits = {"direct": ["shovel", "shovel.blade", "shovel.handle"], "bowl": ["shovel", "bucket", "shovel.blade", "shovel.handle"],
            "pan": ["shovel", "bucket", "pan", "shovel.blade", "shovel.handle"], "classifier": ["shovel", "bucket", "pan", "classifier", "shovel.blade", "shovel.handle"]}
    per = {k: [bench_seed(A, 1001 + n * 7, 40, "shovel", "kit", v)["perMinCents"] for n in range(4 if QUICK else 6)] for k, v in kits.items()}
    mean = lambda v: sum(v) / len(v)
    r = {k: mean(per[k]) / mean(per["direct"]) for k in ("bowl", "pan", "classifier")}
    ok("BENCH after the container fix processing still pays per active minute: bowl > direct, pan more, classifier more again (target ~1,15-1,3 / 1,25-1,45 / 1,35-1,55)",
       1.05 <= r["bowl"] <= 1.4 and r["bowl"] * 1.08 <= r["pan"] <= 1.6 and r["pan"] <= r["classifier"] <= 1.7, json.dumps({k: round(v, 2) for k, v in r.items()}))
    Q.close(A)
    ctx.close()


def main():
    shots = None
    if "--shots" in sys.argv:
        shots = Path(sys.argv[sys.argv.index("--shots") + 1])
        shots.mkdir(parents=True, exist_ok=True)
    engine = sys.argv[sys.argv.index("--browser") + 1] if "--browser" in sys.argv else "chromium"
    want = lambda part: not ONLY or part in ONLY
    proc_, base, tmp = start_server()
    try:
        user = login(base, "Material7B")
        with sync_playwright() as p:
            browser = getattr(p, engine).launch(args=GPU_ARGS if engine == "chromium" else [])
            ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
            if want("ledger"):
                ledger(A, shots)
            if want("shots"):
                visual(A, shots)
            if want("stable"):
                stable(A)
            if want("ux"):
                ux(A)
            Q.close(A)
            ctx.close()
            if engine == "chromium":
                if want("mobile"):
                    mobile(browser, base, user)
                if want("perf"):
                    perf(browser, base, user)
                if want("dev"):
                    dev_pack(browser)
            if want("bench") and "--no-bench" not in sys.argv:
                bench(browser, base, user)
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
