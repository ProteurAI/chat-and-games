"""End-to-end check of GoldRush Prompt 10 - the working mine - and its human-QA points.

  barrow    (A) backing up at 55-65 % of the forward speed, steering while backing up, a full barrow too;
            (B) every hopper through the one receiver table: the wash plant's box / the sluice hopper, the bulk
            hopper on the ramp, the intake at the mountain's flank - offered, tipped, exact, partial when full
  tailings  (C) the sluice's tailings onto the OUTLET pile; full -> the sluice backs up (blocked, nothing lost,
            the hopper keeps what waits); the loader carries it onto the tailings zone -> it runs again; shovelled
            from the pile into the barrow; the ledger exact all the way
  upgrades  (D) the shovel's steps (bigger blade +25-30 % real volume, the pro stage +45-55 % in all), the zinc
            bucket (19 l), the barrow's bearings / tyre / sideboards (110 l) - real numbers, visible, kept by a reload
  jump      (E) ~38 cm, only from the ground, no double jump, no bunny hop, momentum kept; never with the barrow,
            in the excavator / the loader, at work
  work      (F) sieve and mat: gesture -> settle -> result -> [E] -> looking again; mouse deltas meanwhile dropped,
            no camera jump after it
  prospect  (G) the 9.1 reset still works (the next sample is #1)
  piles     raw / oversize / tailings / spoil: real material, an irregular shape (not a cone), the name and
            volume when you look at one, exact through a save / reload
  loader    drives (forward / back), articulates, fills progressively in a pile (never at once), never digs the
            grown mountain, tips into the intake (partially when full) and onto piles - not onto the outlet /
            oversize piles; its bucket survives a reload
  plant     the conveyor upgrade (~137 l/min, a 420-l intake) and the trommel upgrade (120 l/min), visible;
            the oversize stacker carries the oversize to the strip's south end - the loader reaches it there
  wash      the wash plant built at its crate: three lanes, 90-140 l/min, ~77 % of the fine gold (84 % with the
            recovery upgrade), every piece; the outlet full -> the lanes wait, the box fills, the feeder stops;
            cleaning out -> the tub -> the bucket -> the pan -> the pouch
  chain     terrain -> excavator -> raw pile -> loader -> intake -> belt -> trommel (+ stacker, oversize pile) ->
            wash plant -> tub -> pan -> pouch, tailings: gold and mass exact, every piece exactly once, through a
            save / reload in the middle; the dev snapshot of the working mine (a loaded loader bucket) exact
  save      v9; a v8 mine (oversize buffer, spoil totals) loads onto its piles; a new mine has none
  area      the mine organised through use: the loader's tyres leave imprints (a fixed pool, gone where the ground
            changes), its parking pad north of the raw pile (outside the diggable square), wet ground at the wash
            plant's lanes / box / tub and under the oversize stacker (in the sluice's wet groups: no extra draw)
  miner     the automatic hillside miner: delivered, set up through the placement mode (ghost, valid / invalid with
            the reason, R turns, click), real cuts of the mountain inside its section only (the batch from there, its
            gold, the contract), its belt -> the intake, backpressure (waits, no loss, starts again), hard rock,
            the section running out, save / reload exact, moved, nothing while paused or closed (no offline work)
  nuggets   the very rare high-value nuggets: their own tiers in the ground (EUR 5-12 / 12-30 / 30-50 / 50-86), the same
            from a second field on the seed (the place, not the stroke), rare (per m3 of mountain, < 1 % of the nuggets),
            the claim's budget kept (< 0,1 % moved), never in the camp's fill or the starter faces; drawn by value (EUR 80
            ~2x EUR 4, not a prop); the trommel's screen keeps one from EUR 10 in its nugget trap (never the oversize):
            exactly once in the ledger, through a save / reload, taken out at the trap -> the pouch, "Großer Goldfund",
            the sting; a EUR 8 one through the screen into the wash plant's riffles -> cleaned out; the pan / the sieve
            keep any size; dug from the ground: the tier's sound and line, held up longer; the statistics by tier
  p1001     GoldRush 10.0.1: the sluice's throughput stages II / III bought in the shop (32 -> 45 -> 60 l/min measured, the
            feeder doses the same - never below the box), kept by a reload; the small hillside miner ("Kleiner
            Schürfkopf"): ~30 l/min of real cuts into the intake, the ledger exact, hard rock stops it, nothing while
            paused, kept by a reload, bought big later the same machine grows
  dev       every Prompt-10 developer command (preset, places, fills, tip targets, result states, upgrades, jump, nuggets)
  perf      the working mine in view under 250 draw calls, ~60 fps; objects / heap flat over a working run; the
            phone (loader cab controls)

Runs the server from temp copies (the real database is never touched).

    python tests/e2e/goldrush_workingmine_e2e.py [--browser webkit] [--only parts] [--shots DIR]
"""

import json
import math
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from goldrush_e2e import GPU_ARGS, PHONE, client, errors, gr_open, gr_ready, wait_for  # noqa: E402
from goldrush_tools_e2e import seeded  # noqa: E402
import goldrush_quality_e2e as Q  # noqa: E402
import goldrush_mech_e2e as M6  # noqa: E402
from goldrush_mechanized_e2e import grant, ledger, plant_up, reload, FINDS_JS  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ONLY = set(sys.argv[sys.argv.index("--only") + 1].split(",")) if "--only" in sys.argv else None
SHOTS = Path(sys.argv[sys.argv.index("--shots") + 1]) if "--shots" in sys.argv else None
RESULTS = []
GR = "window.__goldrush"
G, fresh = Q.G, Q.fresh


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def shot(page, name):
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / f"g10_{name}.png"))


def dev(page, cid, arg=None):
    return page.evaluate("async ([id, a]) => await window.__goldrush.dev9(id, a)", [cid, arg])


def exact(page):
    d = ledger(page)
    return d[0] == 0 and d[1] == 0, f"dUg {d[0]} dG {d[1]}"


def paused(page):
    G(page, f"() => {GR}.setPaused(true)")


MINE = ["sluice", "bulkhopper", "feeder", "conveyor", "trommel", "sluice.highflow", "excavator", "loader"]


def mine_up(page, wash=True, upgrades=True):
    """the phase-9 plant (feeder AUTO, water on), the loader; the plant upgrades and the wash plant"""
    plant_up(page)
    grant(page, ["sluice.highflow", "excavator", "loader"] + (["conveyor.fast", "trommel.fast"] if upgrades else []) + (["washplant"] if wash else []))
    G(page, f"() => {{ const g = {GR}; g.procFeederMode('auto'); {'g.procInstallWash();' if wash else ''} }}")


BATCH = """(o) => { const pr = window.__goldrush.procObj(), L = pr.ledger, B = pr._batch(o.stage || 'raw'); B.volumeMl = o.ml;
  B.comp = [Math.round(o.ml * (o.mix ? o.mix[0] : 0.9)), Math.round(o.ml * (o.mix ? o.mix[1] : 0.45)), Math.round(o.ml * (o.mix ? o.mix[2] : 0.4)), Math.round(o.ml * (o.mix ? o.mix[3] : 0.1))];
  B.fineUg = Math.round(o.ml * (o.fine != null ? o.fine : 0.4));
  L.inUg += B.goldUg; L.inFineUg = (L.inFineUg || 0) + B.fineUg; L.inG += B.massG; L.inMl += B.volumeMl; return B; }"""


def into(page, where, ml, **kw):
    """material booked in like a dig, into a holder (bulk / intake / barrow / pile:<id>)"""
    return G(page, """(o) => { const pr = window.__goldrush.procObj(); const B = (""" + BATCH + """)(o);
      if (o.where === 'bulk') return pr.bulk.buffer.put(B) !== false;
      if (o.where === 'intake') return pr.conveyor.pourIn({ batch: B, capacityMl: Infinity });
      if (o.where === 'barrow') { pr.barrow.batch.absorb(B); return true; }
      if (o.where.startsWith('pile:')) { const P = pr.piles.get(o.where.slice(5)), d = P.site.drop; P.dump(B, d.x, d.z, 0.6); P.settle(); return true; }
      return false; }""", {"where": where, "ml": ml, **kw})


# nothing drains the hoppers while a test watches them (water off, feeder / belt stopped)
STILL = "() => { const pr = window.__goldrush.procObj(); if (pr.sluice) pr.sluice.setWater(false); if (pr.feeder) pr.feeder.setMode('stop'); if (pr.conveyor) pr.conveyor.setMode('stop'); }"


# ======================================================================
# A + B: the barrow - backing up, all three hoppers
# ======================================================================

def barrow(A):
    fresh(A)
    grant(A, ["wheelbarrow", "shovel"])
    paused(A)
    # (A) backing up: grab it on open ground, push, then back
    G(A, f"() => {{ const g = {GR}; g.pose({{ x: 2, z: 13.5, yaw: 0, pitch: -0.4 }}); g.procBarrowPlace(2, 12.25, 0); g.stationNow(); g.useStation(); g.walk(0.5, 0, 0); }}")
    sp = G(A, """() => { const g = window.__goldrush, w = g.procObj().barrow; const out = {};
      g.walk(3.0, 0, 1); out.fwd = Math.abs(w.ctl.v);
      g.walk(1.5, 0, 0);
      const y0 = w.yaw, x0 = w.x, z0 = w.z;
      g.walk(3.0, 0, -1); out.back = Math.abs(w.ctl.v); out.backDir = (w.x - x0) * -Math.sin(y0) + (w.z - z0) * -Math.cos(y0);
      g.walk(1.5, 0, 0);
      const y1 = w.yaw; g.walk(2.5, 1, -1); out.turnBack = Math.abs(Math.atan2(Math.sin(w.yaw - y1), Math.cos(w.yaw - y1)));
      out.pushing = w.pushing; return out; }""")
    ratio = sp["back"] / max(1e-6, sp["fwd"])
    ok("A backing up: 55-65 % of the forward speed (empty)", 0.55 <= ratio <= 0.65, f"fwd {sp['fwd']:.2f} back {sp['back']:.2f} m/s ratio {ratio:.2f}")
    ok("A backing up moves it backwards; steering while backing up turns it", sp["backDir"] < -1.0 and sp["turnBack"] > 0.25, f"moved {sp['backDir']:.2f} m, turned {sp['turnBack']:.2f} rad")
    # full: still manoeuvrable
    G(A, f"() => {{ const g = {GR}; g.stationNow(); g.useStation(); g.walk(0.5, 0, 0); }}")
    into(A, "barrow", 85000, mix=[0.1, 0.1, 1.6, 0.1])
    G(A, f"() => {{ const g = {GR}, w = g.procObj().barrow; g.pose({{ x: w.x + Math.sin(w.yaw) * 1.25, z: w.z + Math.cos(w.yaw) * 1.25, yaw: w.yaw, pitch: -0.4 }}); g.stationNow(); g.useStation(); g.walk(0.5, 0, 0); }}")
    sf = G(A, """() => { const g = window.__goldrush, w = g.procObj().barrow, out = {};
      g.walk(3.0, 0, 1); out.fwd = Math.abs(w.ctl.v); g.walk(1.8, 0, 0);
      const y1 = w.yaw, x0 = w.x, z0 = w.z; g.walk(3.0, 0, -1); out.back = Math.abs(w.ctl.v); out.moved = Math.hypot(w.x - x0, w.z - z0);
      g.walk(1.5, 0, 0); const y2 = w.yaw; g.walk(3.0, 1, -1); out.turn = Math.abs(Math.atan2(Math.sin(w.yaw - y2), Math.cos(w.yaw - y2)));
      out.kg = w.massKg; return out; }""")
    rf = sf["back"] / max(1e-6, sf["fwd"])
    ok("A a full barrow (85 l gravel) backs up at 55-65 % of its own forward speed and still steers (manoeuvrable)", 0.5 <= rf <= 0.68 and sf["moved"] > 1.2 and sf["turn"] > 0.2,
       f"{sf['kg']:.0f} kg fwd {sf['fwd']:.2f} back {sf['back']:.2f} ({rf:.2f}) moved {sf['moved']:.2f} m turned {sf['turn']:.2f}")
    shot(A, "barrow_reverse")
    # (B) all three hoppers: the dev placement in front of each, grab, the offer, tip -> exact (partial when full)
    for rid, cmd, act in (("hopper", "p10.tip.hopper", "barrow-dump"), ("bulk", "p10.tip.bulk", "bulk-dump"), ("intake", "p10.tip.intake", "intake-dump")):
        r = dev(A, cmd)
        G(A, STILL)
        G(A, f"() => {{ const g = {GR}; g.stationNow(); g.useStation(); g.walk(0.4, 0, 0); }}")
        st = None
        for _ in range(12):
            s = G(A, f"() => {GR}.stationNow()")
            if s and s.get("id") == act:
                st = s
                break
            G(A, f"() => {GR}.walk(0.15, 0, 0.35)")
        before = G(A, """(rid) => { const pr = window.__goldrush.procObj(), R = pr.receivers().find((r) => r.id === rid); return { barrow: pr.barrow.batch.volumeMl, recv: R && R.holder ? (R.holder.batch ? R.holder.batch.volumeMl : R.holder.volumeMl) : null, room: R ? R.room : null }; }""", rid)
        if st:
            G(A, f"() => {{ const g = {GR}; g.useStation(); g.walk(2.0, 0, 0); }}")
        after = G(A, """(rid) => { const pr = window.__goldrush.procObj(), R = pr.receivers().find((r) => r.id === rid); return { barrow: pr.barrow.batch.volumeMl, recv: R && R.holder ? (R.holder.batch ? R.holder.batch.volumeMl : R.holder.volumeMl) : null }; }""", rid)
        moved = before["barrow"] - after["barrow"]
        good, det = exact(A)
        ok(f"B the barrow tips into the {rid} through the receiver table: offered ({act}), the load moves exactly", r.get("ok") and st is not None and moved > 0 and after["recv"] - before["recv"] == moved and good,
           f"{(st or {}).get('action')} | moved {moved} ml, receiver +{(after['recv'] or 0) - (before['recv'] or 0)} | {det}")
        shot(A, f"tip_{rid}")
        G(A, f"() => {{ const g = {GR}; g.stationNow(); g.useStation(); g.walk(0.3, 0, 0); }}")
    # partial: the intake nearly full - only what fits goes, the rest stays in the barrow
    dev(A, "p10.tip.intake")
    G(A, STILL)
    G(A, f"() => {GR}.procObj().devSetIntake(null)")
    cap = G(A, f"() => {GR}.procObj().conveyor.capacityMl")
    into(A, "intake", cap - 30000)
    G(A, f"() => {{ const g = {GR}; g.stationNow(); g.useStation(); g.walk(0.4, 0, 0); }}")
    for _ in range(12):
        s = G(A, f"() => {GR}.stationNow()")
        if s and s.get("id") == "intake-dump":
            break
        G(A, f"() => {GR}.walk(0.15, 0, 0.35)")
    b0 = G(A, f"() => {GR}.procObj().barrow.batch.volumeMl")
    G(A, f"() => {{ const g = {GR}; g.procObj().conveyor.setMode('stop'); g.useStation(); g.walk(2.0, 0, 0); }}")
    pv = G(A, f"() => {{ const pr = {GR}.procObj(); return {{ barrow: pr.barrow.batch.volumeMl, intake: pr.conveyor.volumeMl, cap: pr.conveyor.capacityMl }}; }}")
    good, det = exact(A)
    ok("B partial transfer: the intake takes what fits (30 l), the rest stays in the barrow, exact", abs((b0 - pv["barrow"]) - 30000) <= 600 and pv["intake"] >= pv["cap"] - 600 and good,
       f"barrow {b0} -> {pv['barrow']}, intake {pv['intake']} / {pv['cap']} | {det}")


# ======================================================================
# C: tailings - the outlet pile, backpressure, the loader, the barrow
# ======================================================================

def tailings(A):
    fresh(A)
    mine_up(A, wash=False, upgrades=False)
    grant(A, ["wheelbarrow", "shovel"])
    paused(A)
    r = G(A, """() => { const pr = window.__goldrush.procObj(), sl = pr.sluice, L = pr.ledger, out = pr.piles.get('tailOut'); sl.setWater(true);
      let t = 0, blockedAt = null, firstTail = null;
      for (; t < 5 * 3600; t++) {
        if (pr.bulk.buffer.room > 100000) { const B = pr._batch('raw'); B.volumeMl = 100000; B.comp = [90000, 45000, 40000, 10000]; B.fineUg = 3000; L.inUg += B.goldUg; L.inG += B.massG; L.inMl += B.volumeMl; pr.bulk.buffer.put(B); }
        pr.tickSim(1);
        if (firstTail == null && out.volumeMl > 0) firstTail = t;
        if (sl.blockedOut) { blockedAt = t; break; }
      }
      const p0 = sl.stats.processedMl, h0 = sl.hopper.batch.volumeMl; for (let k = 0; k < 120; k++) pr.tickSim(1);
      return { firstTail, blockedAt, outMl: out.volumeMl, held: sl.processedMl, stuck: sl.stats.processedMl - p0, hopper: sl.hopper.batch.volumeMl, h0, blocked: sl.blockedOut, cap: sl.capacityMl }; }""")
    good, det = exact(A)
    ok("C the sluice's tailings land on the OUTLET pile (a real pile) as it washes", r["firstTail"] is not None and r["firstTail"] < 120 and r["outMl"] > 1e6, f"first {r['firstTail']} s, {r['outMl'] / 1e6:.2f} m3")
    ok("C the outlet pile up to the box's end: the sluice backs up (it waits - at most a trickle while the pile settles; nothing is lost; its hopper keeps what waits)",
       r["blockedAt"] is not None and r["stuck"] <= 12000 and r["hopper"] > 0 and good, f"blocked after {r['blockedAt']} s at {r['outMl'] / 1e6:.2f} m3, then {r['stuck']} ml in 2 min (open: ~64 l), hopper {r['hopper']} / {r['cap']} ml | {det}")
    G(A, f"() => {GR}.walk(0.3, 0, 0)")
    G(A, f"() => {GR}.camLook({{ x: -13.0, y: 3.2, z: 2.6, tx: -16.5, ty: 0.3, tz: -1.8 }})")
    shot(A, "outlet_full")
    # the pile in view: its name and volume
    G(A, f"() => {GR}.pose({{ x: -13.0, z: 1.6, yaw: Math.atan2(3.5, 3.4), pitch: -0.35 }})")
    info = G(A, f"() => {GR}.stationNow()")
    ok("C a pile in view names itself: 'TAILINGS x m3' (no gold value)", bool(info) and info.get("id") == "pile-info" and info["action"].startswith("TAILINGS") and "m³" in info["action"] and "€" not in info["action"], str(info))
    # the loader takes it from the outlet onto the tailings zone (real cuts, real pour)
    lr = G(A, """() => { const pr = window.__goldrush.procObj(), ld = pr.loader, out = pr.piles.get('tailOut'), zone = pr.piles.get('tailings'), ev = [];
      const pk = out.peak(); ld.place(pk.x + 4.2, pk.z, Math.PI, 0); if (ld.mode !== 'dig') ld.toggleDig();
      for (let i = 0; i < 180; i++) ld.update(1 / 60, { fwd: 0 }, (k) => ev.push(k));
      const o0 = out.volumeMl, z0 = zone.volumeMl; let steps = 0;
      for (let i = 0; i < 60 * 12 && ld.mode === 'dig'; i++) { ld.drive(1 / 60, 0.6, 0); ld.update(1 / 60, { fwd: 0.6 }, (k) => ev.push(k)); pr.piles.update(1 / 60); steps++; }
      const took = ld.volumeMl;
      const res = ld.pourNow({ kind: 'pile', pile: zone, label: 'Tailings-Zone', top: 0.5, room: zone.room });
      return { took, outLost: o0 - out.volumeMl, zoneGot: zone.volumeMl - z0, ev: [...new Set(ev)], steps, left: ld.volumeMl, res }; }""")
    good, det = exact(A)
    ok("C the loader scoops the outlet pile (progressively) and carries it onto the tailings zone - exact", lr["took"] > 150000 and lr["outLost"] == lr["took"] and lr["zoneGot"] == lr["took"] - lr["left"] and good,
       f"took {lr['took']} ml in {lr['steps'] / 60:.1f} s, zone +{lr['zoneGot']} | {det}")
    # a few more loads (the bench's exact move), then the sluice runs again
    G(A, "() => { const pr = window.__goldrush.procObj(); for (let k = 0; k < 14; k++) pr.benchLoaderMove('tailOut', 'pile:tailings', 260000); }")
    rr = G(A, """() => { const pr = window.__goldrush.procObj(), sl = pr.sluice, p0 = sl.stats.processedMl; for (let k = 0; k < 60; k++) pr.tickSim(1); return { washed: sl.stats.processedMl - p0, blocked: sl.blockedOut, out: pr.piles.get('tailOut').volumeMl }; }""")
    good, det = exact(A)
    ok("C the outlet cleared: the sluice washes again (the backpressure released), the ledger exact", rr["washed"] > 10000 and not rr["blocked"] and good, f"{rr} | {det}")
    # the barrow: shovelled from the outlet pile
    sh = G(A, """() => { const g = window.__goldrush, pr = g.procObj(), out = pr.piles.get('tailOut'), w = pr.barrow; const pk = out.peak();
      g.procBarrowPlace(pk.x + 1.1, pk.z + 1.9, Math.PI / 2); g.equipNow('shovel');
      const w0 = w.batch.volumeMl, o0 = out.volumeMl; let n = 0;
      for (let k = 0; k < 24; k++) { g.aimAt({ x: pk.x + 1.3, z: pk.z, yaw: Math.PI / 2, pitch: -0.75 }); g.contact(); n++; }
      return { took: w.batch.volumeMl - w0, lost: o0 - out.volumeMl, stroke: g.lastStroke() }; }""")
    good, det = exact(A)
    ok("C shovelled from the outlet pile into the barrow next to it (Karre) - exact", sh["took"] > 10000 and sh["took"] == sh["lost"] and good, f"{sh['took']} ml | {det}")
    G(A, f"() => {GR}.camLook({{ x: -10.5, y: 4.0, z: 7.5, tx: -14.0, ty: 0.3, tz: 1.0 }})")
    shot(A, "tailings_transport")


# ======================================================================
# D: the shop's steps - shovel, bucket, barrow
# ======================================================================

STROKES = """() => { const g = window.__goldrush; g.equipNow('shovel'); let kg = 0, n = 0;
  for (let k = 0; k < 10; k++) { const x = -2 + (k % 5) * 1.1, z = 6 + Math.floor(k / 5) * 1.3; g.aimAt({ x, z: z + 1.28, yaw: 0, pitch: -0.9 });
    const r = g.contact(); const s = r.stroke; if (s && s.kind !== 'blocked' && s.massKg > 0) { kg += s.massKg; n++; } }
  return { kg, n, scale: g.procObj ? null : null }; }"""


def upgrades(A):
    res = {}
    for stage, ups in (("base", []), ("wide", ["shovel.wide"]), ("pro", ["shovel.wide", "shovel.blade", "shovel.handle", "shovel.pro"])):
        fresh(A)
        grant(A, ["shovel"] + ups)
        paused(A)
        res[stage] = G(A, STROKES)
    w, p = res["wide"]["kg"] / res["base"]["kg"], res["pro"]["kg"] / res["base"]["kg"]
    ok("D the bigger blade: +25-30 % real volume a stroke (same spots, same ground)", 1.24 <= w <= 1.31, f"{w:.3f}")
    ok("D the pro shovel (bigger blade, edge, handle, pro): +45-55 % over the basic one in all", 1.45 <= p <= 1.56, f"{p:.3f}")
    shop =G(A, f"() => {GR}.shopView().items.filter((i) => ['shovel.wide', 'shovel.pro', 'bucket.xl', 'barrow.bearings', 'barrow.wheel', 'barrow.tray'].includes(i.id)).map((i) => ({{ id: i.id, state: i.state, price: i.price, needs: i.needs }}))")
    ok("D the new steps are in the shop (shovel: bigger blade -> ... -> pro; zinc bucket; barrow bearings / tyre / sideboards)", len(shop) == 6, json.dumps(shop, ensure_ascii=False)[:300])
    pro = next((i for i in shop if i["id"] == "shovel.pro"), {})
    ok("D the pro shovel needs the bigger blade, the edge and the handle first (an upgrade may need upgrades)", pro.get("state") == "owned" or any("Großes Schaufelblatt" in n["text"] for n in pro.get("needs", [])), json.dumps(pro, ensure_ascii=False)[:200])
    # bucket + barrow: real capacities and handling, visible parts
    fresh(A)
    grant(A, ["shovel", "bucket", "wheelbarrow", "shovel.wide", "bucket.large", "bucket.xl", "barrow.bearings", "barrow.wheel", "barrow.tray"])
    paused(A)
    v = G(A, """() => { const g = window.__goldrush, pr = g.procObj(), w = pr.barrow, u = w.group.userData; return { bucket: pr.capacityMl, scale: pr.bucketScale, barrow: w.capacityMl, hm: w.handlingMul, boards: u.boards.visible, tyre: u.tyre.scale.z }; }""")
    ok("D the zinc bucket holds 19 l (14 l -> 18-20 l) and is bigger to see", 18000 <= v["bucket"] <= 20000 and v["scale"] > 1.2, json.dumps(v))
    ok("D the barrow: bearings (rolls easier), a wide pneumatic tyre (bumps cost less), sideboards (110 l) - real numbers, visible",
       v["barrow"] >= 110000 and v["hm"]["accel"] > 1 and v["hm"]["drag"] < 1 and v["hm"]["rough"] < 1 and v["boards"] and v["tyre"] > 1.5, json.dumps(v))
    rough = {}
    for label, cmd in (("up", "p10.upgradesAll"), ("base", "p10.upgradesNone")):
        dev(A, cmd)
        dev(A, "p9.course.load100")
        dev(A, "p9.course.bumps")
        G(A, f"() => {{ const g = {GR}; g.stationNow(); g.useStation(); g.walk(0.4, 0, 0); }}")
        rough[label] = G(A, "() => { const g = window.__goldrush, w = g.procObj().barrow, x0 = w.x, z0 = w.z; g.walk(4.0, 0, 1); const d = Math.hypot(w.x - x0, w.z - z0); g.stationNow(); g.useStation(); g.walk(0.3, 0, 0); return d; }")
    ok("D the tyre / bearings: a full barrow covers more ground over the course's bumps than without them (the controller uses them)", rough["up"] > rough["base"] * 1.03, json.dumps(rough))
    for u in ("barrow.bearings", "barrow.wheel", "barrow.tray", "bucket.large", "bucket.xl", "shovel.wide"):
        G(A, f"(u) => {GR}.grantItem(u)", u)
    reload(A)
    paused(A)
    v2 = G(A, """() => { const g = window.__goldrush, pr = g.procObj(), w = pr.barrow; return { bucket: pr.capacityMl, barrow: w.capacityMl, boards: w.group.userData.boards.visible, ups: g.tools().saved.upgrades }; }""")
    ok("D upgrades survive save / reload (capacities, the visible parts)", v2["bucket"] == v["bucket"] and v2["barrow"] == v["barrow"] and v2["boards"] and "barrow.tray" in v2["ups"], json.dumps(v2))
    if SHOTS:
        for stage, ups in (("base", []), ("pro", ["shovel.wide", "shovel.blade", "shovel.handle", "shovel.pro"])):
            fresh(A)
            Q.kit(A, ["shovel"])
            grant(A, ups)
            G(A, f"() => {GR}.equipNow('shovel')")
            A.mouse.move(683, 384)
            G(A, M6.SPOT, {"want": "dirt", "reach": 2.0, "start": 0.3, "fresh": True})
            A.mouse.down()
            t0 = time.time()
            while time.time() - t0 < 4.0:
                h = G(A, f"() => {GR}.hand()")
                if h["phase"] == "scoop" and h["load"] > 0.5:
                    shot(A, f"shovel_{stage}")
                    break
                time.sleep(0.01)
            A.mouse.up()


# ======================================================================
# E: the jump
# ======================================================================

JT = """(o) => { const g = window.__goldrush; const s0 = g.jumpState(), st0 = g.state(); let peak = -1e9, air = 0, dip = 0;
  if (o.press) g.jump();
  for (let i = 0; i < o.frames; i++) { if (o.again && i === o.again) g.jump(); g.walk(1 / 60, 0, o.my || 0); const s = g.jumpState(); peak = Math.max(peak, s.y); if (s.air) air += 1 / 60; dip = Math.max(dip, s.dip); }
  const s1 = g.jumpState(), st1 = g.state();
  return { h: peak - s0.y, air, jumps: s1.jumps - s0.jumps, lands: s1.lands - s0.lands, dip, d: Math.hypot(st1.x - st0.x, st1.z - st0.z) }; }"""


def jump(A):
    fresh(A)
    paused(A)
    G(A, f"() => {{ {GR}.pose({{ x: 2, z: 14, yaw: 0, pitch: 0 }}); {GR}.walk(0.3, 0, 0); }}")
    r = G(A, JT, {"press": True, "frames": 70})
    ok("E Space: a jump of 30-45 cm from the ground, ~0.5 s in the air, a landing (the view dips)", 0.30 <= r["h"] <= 0.45 and 0.4 <= r["air"] <= 0.65 and r["lands"] == 1 and r["dip"] > 0.02, json.dumps(r))
    r = G(A, JT, {"press": True, "frames": 70, "again": 15})
    ok("E no double jump: a second press in the air does nothing", r["jumps"] == 1, json.dumps(r))
    r = G(A, JT, {"press": True, "frames": 70, "again": 38})
    ok("E no bunny hop: a press right after the landing does nothing (a moment's rest)", r["jumps"] == 1, json.dumps(r))
    G(A, f"() => {GR}.walk(1.0, 0, 1)")
    r = G(A, JT, {"press": True, "frames": 30, "my": 1})
    ok("E the momentum carries on: a running jump covers ground (~walking speed)", r["jumps"] == 1 and r["d"] > 1.2, json.dumps(r))
    G(A, f"() => {GR}.walk(0.6, 0, 0)")
    r = G(A, "() => { const g = window.__goldrush, p = g.jumpState(); return { y: p.y, ground: p.ground, air: p.air }; }")
    G(A, f"() => {GR}.walk(0.2, 0, 0)")
    # a held key repeats nothing (keydown with repeat) - the press is one jump
    A.keyboard.down("Space")
    A.keyboard.down("Space")
    A.keyboard.up("Space")
    # not with the barrow, not in the machines, not at work
    grant(A, ["wheelbarrow", "excavator", "loader", "bucket", "classifier", "sluice", "bulkhopper", "feeder", "conveyor", "trommel", "sluice.highflow"])
    G(A, f"() => {{ const g = {GR}; g.pose({{ x: 2, z: 14, yaw: 0, pitch: -0.3 }}); g.procBarrowPlace(2, 12.75, 0); g.stationNow(); g.useStation(); g.walk(0.4, 0, 0); }}")
    r = G(A, JT, {"press": True, "frames": 40})
    ok("E no jump with the barrow in your hands", r["jumps"] == 0 and r["h"] < 0.02, json.dumps(r))
    G(A, f"() => {{ const g = {GR}; g.stationNow(); g.useStation(); g.walk(0.4, 0, 0); }}")
    for machine in ("excavator", "loader"):
        entered = G(A, f"() => {GR}.excEnter()") if machine == "excavator" else dev(A, "p10.loaderCourse").get("ok")
        r = G(A, "() => { const g = window.__goldrush, s0 = g.jumpState(); g.jump(); g.walk(0.8, 0, 0); const s1 = g.jumpState(); return { jumps: s1.jumps - s0.jumps }; }")
        r2 = G(A, "() => { const g = window.__goldrush; g.excExit(); g.walk(0.5, 0, 0); return g.jumpState(); }")
        ok(f"E no jump in the {machine} (and the press is not kept for later)", entered and r["jumps"] == 0 and not r2["air"] and r2["prep"] <= 0, f"entered {entered} {r}")
    dev(A, "p10.sieveResult")
    r = G(A, "() => { const g = window.__goldrush, s0 = g.jumpState(); g.jump(); g.walk(0.5, 0, 0); g.workAction(); g.walk(0.5, 0, 0); return { jumps: g.jumpState().jumps - s0.jumps, air: g.jumpState().air }; }")
    ok("E no jump at work (the sieve) - and none after it", r["jumps"] == 0 and not r["air"], json.dumps(r))
    if SHOTS:
        G(A, f"() => {{ const g = {GR}; g.pose({{ x: 2, z: 14, yaw: 0, pitch: -0.05 }}); g.walk(0.3, 0, 0); g.jump(); g.walk(0.28, 0, 0.8); }}")
        shot(A, "jump_apex")


# ======================================================================
# F: the work's states - gesture, settle, result, back to looking; no camera jump
# ======================================================================

def work(A):
    fresh(A)
    paused(A)
    grant(A, ["bucket", "classifier"])
    for kind, cmd in (("sieve", "p10.sieveResult"), ("clean", "p10.matResult")):
        r = dev(A, cmd)
        st = G(A, f"() => {GR}.workState()")
        ok(f"F {kind}: the gesture done -> settle -> RESULT (it waits for you)", r.get("ok") and st["work"] == kind and st["phase"] == "result" and st["allLook"], json.dumps(st))
        shot(A, f"{kind}_result")
        y0 = G(A, f"() => {GR}.state().yaw")
        moved = G(A, f"() => {{ const g = {GR}; const a = g.mouseLook(400, 120); g.walk(0.3, 0, 0); return a; }}")
        y1 = G(A, f"() => {GR}.state().yaw")
        ok(f"F {kind}: in the result the mouse turns nothing (its deltas are dropped)", abs(y1 - y0) < 1e-6, f"fed {moved}, yaw {y0:.4f} -> {y1:.4f}")
        G(A, f"() => {GR}.mouseLook(300, 0)")
        a = G(A, f"() => {GR}.workAction()")
        G(A, f"() => {GR}.walk(0.1, 0, 0)")
        y2 = G(A, f"() => {GR}.state().yaw")
        muted = G(A, f"() => {GR}.mouseLook(300, 0)")
        G(A, f"() => {GR}.walk(0.05, 0, 0)")
        y3 = G(A, f"() => {GR}.state().yaw")
        time.sleep(0.3)
        live = G(A, f"() => {GR}.mouseLook(200, 0)")
        G(A, f"() => {GR}.walk(0.05, 0, 0)")
        y4 = G(A, f"() => {GR}.state().yaw")
        ok(f"F {kind}: [E] ends it - no camera jump (what the mouse did meanwhile is dropped, a moment's mute), then looking works again",
           a is None and abs(y2 - y1) < 0.02 and not muted and abs(y3 - y2) < 1e-6 and live and abs(y4 - y3) > 0.05, f"{y1:.3f} {y2:.3f} {y3:.3f} {y4:.3f} muted {muted} live {live}")


# ======================================================================
# G: the 9.1 prospecting reset still works
# ======================================================================

def prospect(A):
    fresh(A)
    grant(A, ["shovel", "pan", "prospectkit"])
    paused(A)
    n = 0
    for k in range(3):
        G(A, f"(k) => {GR}.aimAt({{ x: -2 + k, z: 6, yaw: 0, pitch: -0.9 }})", k)
        s = G(A, f"() => {GR}.sampleNow()")
        n += 1 if s and s.get("ok") else 0
    r = G(A, f"() => {{ const g = {GR}; const r = g.prospectReset ? g.prospectReset() : null; return {{ r, next: g.procObj().prospect ? g.procObj().prospect.nextBag ? g.procObj().prospect.nextBag() : null : null }}; }}")
    G(A, f"() => {GR}.aimAt({{ x: 2, z: 6.5, yaw: 0, pitch: -0.9 }})")
    s = G(A, f"() => {GR}.sampleNow()")
    num = G(A, "() => { const pg = window.__goldrush.procObj().prospect; return pg.bags.map((b) => b.n); }")
    ok("G the prospecting reset (9.1) still works: after it, the next sample is #1 (the bags not washed keep theirs first)", n >= 2 and s and s.get("ok") and 1 in num, f"samples {n}, reset {json.dumps(r)[:120]}, bags {num}")


# ======================================================================
# PILES - real material, irregular shapes, exact through save / reload
# ======================================================================

def piles(A):
    fresh(A)
    mine_up(A)
    paused(A)
    for id_, ml in (("raw", 6000000), ("oversize", 1500000), ("tailings", 2000000), ("spoil", 3000000)):
        into(A, f"pile:{id_}", ml)
    sh = G(A, """() => { const pr = window.__goldrush.procObj(), out = {};
      for (const P of pr.piles.list()) {
        let n = 0, mx = 0, sx = 0, sz = 0, s = 0; const nx = P.nx;
        let all = 0; for (let k = 0; k < P.h.length; k++) { const h = P.h[k]; all += h; if (h > 0.03) { n++; const i = k % nx, j = (k - i) / nx; sx += i * h; sz += j * h; s += h; } mx = Math.max(mx, h); }
        // asymmetry: the shape's heights in the four quadrants round its centre of mass
        const ci = sx / Math.max(1e-9, s), cj = sz / Math.max(1e-9, s), q = [0, 0, 0, 0];
        for (let k = 0; k < P.h.length; k++) { const i = k % nx, j = (k - i) / nx; q[(i > ci ? 1 : 0) + (j > cj ? 2 : 0)] += P.h[k]; }
        out[P.id] = { ml: P.volumeMl, cells: n, peak: +mx.toFixed(2), quad: q.map((v) => +(v / Math.max(1e-9, s)).toFixed(3)), sumM3: +(all * 0.0625).toFixed(3) };
      }
      return out; }""")
    good, det = exact(A)
    off = {k: (v["sumM3"], v["ml"] / 1e6) for k, v in sh.items() if v["ml"] > 0 and abs(v["sumM3"] - v["ml"] / 1e6) >= 0.02}
    ok("PILES every pile holds real material, its height field holds exactly its volume", not off and good, f"off {off} | {det}")
    ok("PILES not a cone: broad (many cells), and its four quarters differ (an irregular, asymmetric heap)",
       all(v["cells"] > 40 and max(v["quad"]) - min(v["quad"]) > 0.03 for v in sh.values() if v["ml"] > 0), json.dumps({k: (v["cells"], v["quad"]) for k, v in sh.items()}))
    ok("PILES the flat tailings fan, the steeper oversize (repose by kind)", sh["tailings"]["peak"] < sh["oversize"]["peak"], f"tailings peak {sh['tailings']['peak']} m, oversize {sh['oversize']['peak']} m")
    G(A, f"() => {GR}.walk(0.3, 0, 0)")
    G(A, f"() => {GR}.camLook({{ x: -3.0, y: 4.0, z: -14.0, tx: -9.6, ty: 0.6, tz: -19.0 }})")
    shot(A, "raw_pile")
    G(A, f"() => {GR}.pose({{ x: -9.6 + 5.0, z: -18.6 + 1.0, yaw: Math.atan2(5.0, 1.0), pitch: -0.25 }})")
    info = G(A, f"() => {GR}.stationNow()")
    ok("PILES 'RAW PAY DIRT 6,0 m3' when you look at the raw pile - no gold value for raw material", bool(info) and info.get("action", "").startswith("RAW PAY DIRT") and "€" not in info.get("action", ""), str(info))
    before = G(A, "() => { const pr = window.__goldrush.procObj(), o = {}; for (const P of pr.piles.list()) o[P.id] = { ml: P.volumeMl, ug: P.buffer.goldUg, g: P.buffer.massG, h: Array.from(P.h).reduce((a, b) => a + b, 0) }; return o; }")
    reload(A)
    paused(A)
    after = G(A, "() => { const pr = window.__goldrush.procObj(), o = {}; for (const P of pr.piles.list()) o[P.id] = { ml: P.volumeMl, ug: P.buffer.goldUg, g: P.buffer.massG, h: Array.from(P.h).reduce((a, b) => a + b, 0) }; return o; }")
    same = all(before[k]["ml"] == after[k]["ml"] and before[k]["ug"] == after[k]["ug"] and before[k]["g"] == after[k]["g"] and abs(before[k]["h"] - after[k]["h"]) < 0.05 for k in before)
    good, det = exact(A)
    ok("PILES save / reload: every pile's material (volume, gold, mass) and its shape exactly back", same and good, det)


# ======================================================================
# LOADER - driving, filling, the mountain, tipping, a reload mid-bucket
# ======================================================================

RUN_LDR = """(o) => { const pr = window.__goldrush.procObj(), ld = pr.loader, ev = [];
  for (let i = 0; i < o.steps; i++) { ld.drive(1 / 60, o.fwd, o.turn || 0); ld.update(1 / 60, { fwd: o.fwd }, (k) => ev.push(k)); pr.piles.update(1 / 60); }
  return { x: ld.x, z: ld.z, h: ld.heading, v: ld.v, ml: ld.volumeMl, mode: ld.mode, wall: !!ld.wall, steer: ld.steer, ev: [...new Set(ev)] }; }"""


def loader(A):
    fresh(A)
    mine_up(A)
    paused(A)
    into(A, "pile:raw", 6000000)
    # driving on open ground (the parking strip)
    G(A, "() => { const ld = window.__goldrush.procObj().loader; ld.place(-2, -27, Math.PI, 0); if (ld.mode === 'dig') ld.toggleDig(); }")
    f = G(A, RUN_LDR, {"steps": 240, "fwd": 1})
    b0 = G(A, RUN_LDR, {"steps": 120, "fwd": 0})
    b = G(A, RUN_LDR, {"steps": 240, "fwd": -1})
    ok("LDR drives: forward ~3 m/s empty, it coasts down (heavy, no instant stop), backing up slower", 2.8 <= f["v"] <= 3.6 and abs(b0["v"]) < 0.6 * f["v"] and -2.2 <= b["v"] <= -1.4, f"fwd {f['v']:.2f} coasting 2 s {b0['v']:.2f} back {b['v']:.2f}")
    G(A, RUN_LDR, {"steps": 90, "fwd": 0})
    h0 = G(A, "() => window.__goldrush.procObj().loader.heading")
    t = G(A, RUN_LDR, {"steps": 180, "fwd": 0.7, "turn": 1})
    ok("LDR articulated steering: the joint bends, the machine turns on its arc", abs(t["steer"]) > 0.4 and abs(math.atan2(math.sin(t["h"] - h0), math.cos(t["h"] - h0))) > 0.5, f"steer {t['steer']:.2f}, turned {t['h'] - h0:.2f}")
    # into the raw pile: progressive fill
    G(A, "() => { const pr = window.__goldrush.procObj(), ld = pr.loader, P = pr.piles.get('raw'), pk = P.peak(); ld.place(pk.x + 5.6, pk.z, Math.PI, 0); if (ld.mode !== 'dig') ld.toggleDig(); }")
    G(A, RUN_LDR, {"steps": 120, "fwd": 0})
    trace = []
    for k in range(20):
        r = G(A, RUN_LDR, {"steps": 30, "fwd": 0.6})
        trace.append(r["ml"])
        if r["mode"] == "carry":
            break
    secs = len(trace) * 0.5
    ok("LDR into the raw pile: the bucket fills step by step (no instant fill), lifts itself when full (~260 l)", r["mode"] == "carry" and r["ml"] >= 240000 and secs >= 2.0 and len(set(trace)) >= 4,
       f"{[t // 1000 for t in trace]} l over {secs} s")
    G(A, f"() => {GR}.camLook({{ x: -5.0, y: 3.2, z: -15.0, tx: -9.0, ty: 0.8, tz: -18.6 }})")
    shot(A, "loader_full")
    # the grown mountain: the bucket finds no pile there, the wall stops it, nothing is taken
    G(A, "() => { const pr = window.__goldrush.procObj(), ld = pr.loader; pr.devSetLoader(null); ld.place(-11.5, -3.0, 0, 0); if (ld.mode !== 'dig') ld.toggleDig(); }")
    G(A, RUN_LDR, {"steps": 90, "fwd": 0})
    w = None
    for k in range(16):
        w = G(A, RUN_LDR, {"steps": 30, "fwd": 0.7})
        if w["wall"]:
            break
    ok("LDR the grown mountain: the loader does not dig it (the wall stops the bucket, nothing taken)", w["wall"] and w["ml"] == 0, json.dumps({k: w[k] for k in ("x", "z", "ml", "wall")}))
    # tipping into the intake (partial when it is nearly full) - the engine's aim, the loader's own pour
    G(A, f"() => {GR}.procObj().conveyor.setMode('stop')")
    G(A, f"() => {GR}.procObj().devSetIntake(null)")
    cap = G(A, f"() => {GR}.procObj().conveyor.capacityMl")
    into(A, "intake", cap - 100000)
    G(A, f"() => {GR}.procObj().devSetLoader(null)")
    G(A, "() => { const pr = window.__goldrush.procObj(); const B = pr._batch('raw'); B.volumeMl = 250000; B.comp = [225000, 112000, 100000, 25000]; B.fineUg = 9000; pr.devSetLoader(B); }")
    tip = G(A, """() => { const g = window.__goldrush, pr = g.procObj(), ld = pr.loader, R = pr.receivers().find((r) => r.id === 'intake');
      const v0 = pr.conveyor.volumeMl, b0 = ld.volumeMl; const res = ld.pourNow({ kind: 'intake', label: R.label, top: R.top, holder: R.holder, fill: R.fill, room: R.room, R });
      return { res, into: pr.conveyor.volumeMl - v0, left: ld.volumeMl, b0, cap: pr.conveyor.capacityMl, now: pr.conveyor.volumeMl }; }""")
    good, det = exact(A)
    ok("LDR tips into the intake through the receiver table - partial: only what fits, the rest stays in the bucket, exact",
       tip["into"] == tip["b0"] - tip["left"] and tip["left"] > 100000 and tip["now"] >= tip["cap"] - 1000 and good, f"{json.dumps(tip)} | {det}")
    # not onto the outlet / oversize piles (they are only taken from)
    G(A, "() => { const pr = window.__goldrush.procObj(), ld = pr.loader, P = pr.piles.get('oversize'); P.dump((() => { const B = pr._batch('raw'); B.volumeMl = 500000; B.comp = [100000, 200000, 300000, 400000]; pr.ledger.inG += B.massG; pr.ledger.inMl += B.volumeMl; return B; })(), -22.72, -8.35, 0.6); P.settle(); }")
    nd = G(A, """() => { const g = window.__goldrush, pr = g.procObj(), ld = pr.loader; ld.place(-22.55, -12.6, -Math.PI / 2, 0);
      if (ld.mode === 'dig') ld.toggleDig(); for (let i = 0; i < 200; i++) ld.update(1 / 60, { fwd: 0 }, () => {});
      const tgt = g.ldrAim ? g.ldrAim() : null; return { tables: pr.receivers().filter((r) => r.pile).map((r) => r.pile.id) }; }""")
    ok("LDR the outlet and the oversize pile are not tip targets (only dug from); raw / tailings / spoil are", "oversize" not in nd["tables"] and "tailOut" not in nd["tables"] and set(["raw", "tailings", "spoil"]) <= set(nd["tables"]), json.dumps(nd))
    # the oversize: from the stacker's head, reached from the open side
    G(A, "() => { const pr = window.__goldrush.procObj(), ld = pr.loader; pr.devSetLoader(null); ld.place(-22.55, -13.2, -Math.PI / 2, 0); if (ld.mode !== 'dig') ld.toggleDig(); }")
    G(A, RUN_LDR, {"steps": 90, "fwd": 0})
    o = None
    for k in range(16):
        o = G(A, RUN_LDR, {"steps": 30, "fwd": 0.7})
        if o["ml"] > 100000 or o["mode"] == "carry":
            break
    ok("LDR reaches the oversize pile at the stacker's head from the open side (Zone B) and scoops it", o["ml"] > 100000, json.dumps({k: o[k] for k in ("x", "z", "ml", "mode")}))
    G(A, f"() => {GR}.camLook({{ x: -19.0, y: 3.8, z: -14.8, tx: -22.5, ty: 0.8, tz: -9.5 }})")
    shot(A, "loader_oversize")
    # a reload mid-bucket: the load, the place, the arms (it stands - a moving one rolls on after the reload)
    G(A, RUN_LDR, {"steps": 180, "fwd": 0})
    s0 = G(A, "() => { const ld = window.__goldrush.procObj().loader; return { ml: ld.volumeMl, ug: ld.bucket.batch.goldUg, x: +ld.x.toFixed(3), z: +ld.z.toFixed(3), mode: ld.mode }; }")
    reload(A)
    paused(A)
    s1 = G(A, "() => { const ld = window.__goldrush.procObj().loader; return { ml: ld.volumeMl, ug: ld.bucket.batch.goldUg, x: +ld.x.toFixed(3), z: +ld.z.toFixed(3), mode: ld.mode }; }")
    good, det = exact(A)
    ok("LDR save / reload with a loaded bucket: the load (gold too), the place exactly back", s0["ml"] == s1["ml"] and s0["ug"] == s1["ug"] and abs(s0["x"] - s1["x"]) < 0.01 and abs(s0["z"] - s1["z"]) < 0.01 and good, f"{s0} -> {s1} | {det}")


# ======================================================================
# PLANT - the conveyor / trommel upgrades, the oversize stacker
# ======================================================================

STONY = """(sec) => { const pr = window.__goldrush.procObj(), cv = pr.conveyor, L = pr.ledger; const s = { b: cv.stats.outMl, t: pr.trommel.stats.inMl, o: pr.trommel.stats.overMl };
  for (let t = 0; t < sec; t++) { if (cv.intake.room > 200000) { const B = pr._batch('raw'); B.volumeMl = 200000; B.comp = [100000, 70000, 70000, 160000]; B.fineUg = 40000; L.inUg += B.goldUg; L.inG += B.massG; L.inMl += B.volumeMl; cv.pourIn({ batch: B, capacityMl: Infinity }); }
    if (pr.bulk.buffer.volumeMl > 300000) { const tk = pr.bulk.buffer.take(150000, pr.nextBatch++); L.tailUg += tk.goldUg; L.tailG += tk.massG; L.tailMl += tk.volumeMl; }
    pr.tickSim(1); }
  const m = sec / 60; return { belt: (cv.stats.outMl - s.b) / 1000 / m, trommel: (pr.trommel.stats.inMl - s.t) / 1000 / m, over: (pr.trommel.stats.overMl - s.o) / 1000, pile: pr.piles.get('oversize').volumeMl, stacker: pr.trommel.overBelt.volumeMl }; }"""


def plant(A):
    fresh(A)
    mine_up(A, wash=False, upgrades=False)
    paused(A)
    G(A, f"() => {GR}.procFeederMode('stop')")
    base = G(A, STONY, 240)
    grant(A, ["conveyor.fast", "trommel.fast"])
    v = G(A, "() => { const pr = window.__goldrush.procObj(), cu = pr.conveyor.model.userData, iu = pr.conveyor.intakeModel.userData, tu = pr.trommel.model.userData; return { rate: pr.conveyor.belt.rateLpm, cap: pr.conveyor.capacityMl, lpm: pr.trommel.lpm, beltUp: cu.up.visible, ext: iu.ext.visible, drumUp: tu.up.visible }; }")
    up = G(A, STONY, 240)
    good, det = exact(A)
    ok("PLANT the conveyor upgrade: 120-160 l/min (was ~64), a 420-l intake (a full loader bucket fits) - a second drive, skirts, the raised intake to see",
       120 <= v["rate"] <= 160 and v["cap"] == 420000 and v["beltUp"] and v["ext"], json.dumps(v))
    ok("PLANT the trommel upgrade: 100-140 l/min (was 60) - a second drive and spray bar to see", 100 <= v["lpm"] <= 140 and v["drumUp"], json.dumps(v))
    ok("PLANT measured with a stony feed: belt / trommel ~60 before, ~120 after the upgrades; the ledger exact",
       base["trommel"] < 65 and up["trommel"] > 100 and up["belt"] > 100 and good, f"before {base['belt']:.0f}/{base['trommel']:.0f}, after {up['belt']:.0f}/{up['trommel']:.0f} l/min | {det}")
    ok("PLANT the oversize rides the stacker to the strip's south end and lands on the OVERSIZE pile there", up["over"] > 50 and up["pile"] > 50000,
       f"oversize {up['over']:.0f} l, pile {up['pile'] / 1000:.0f} l, on the stacker {up['stacker'] / 1000:.1f} l")
    G(A, f"() => {GR}.walk(0.4, 0, 0)")
    G(A, f"() => {GR}.camLook({{ x: -15.0, y: 4.5, z: -7.0, tx: -20.5, ty: 2.2, tz: -3.6 }})")
    shot(A, "plant_upgraded")
    G(A, f"() => {GR}.camLook({{ x: -18.6, y: 3.4, z: -12.5, tx: -22.5, ty: 1.0, tz: -6.5 }})")
    shot(A, "oversize_stacker")


# ======================================================================
# WASH - the wash plant
# ======================================================================

def wash(A):
    fresh(A)
    mine_up(A, wash=False)
    grant(A, ["bucket", "pan", "washplant"])
    paused(A)
    kit = G(A, f"() => {GR}.procObj().washplant.spots.kit")
    G(A, f"(k) => {GR}.pose({{ x: k.x + 1.6, z: k.z + 0.4, yaw: Math.atan2(1.6, 0.4), pitch: -0.3 }})", kit)
    st = G(A, f"() => {GR}.stationNow()")
    G(A, f"() => {{ const g = {GR}; g.useStation(); g.walk(4.5, 0, 0); }}")
    w = G(A, "() => { const pr = window.__goldrush.procObj(), wp = pr.washplant; return { installed: wp.installed, lanes: wp.lanes.length, models: wp.laneModels.length, rate: wp.maxLpm, dist: pr.sluice.capacityMl, feeder: pr.feeder.rateLpm }; }")
    ok("WASH built at its crate ([E]): a distribution box over three lanes (the high-flow box the first), up to 120 l/min, the feeder opens to it",
       st and st.get("id") == "washplant-build" and w["installed"] and w["lanes"] == 3 and w["models"] == 2 and 90 <= w["rate"] <= 140 and w["feeder"] >= w["rate"], f"{st} {w}")
    G(A, f"() => {GR}.camLook({{ x: -23.2, y: 2.6, z: 1.0, tx: -20.3, ty: 1.0, tz: -1.4 }})")
    shot(A, "wash_idle")
    # a run: the box splits evenly, 90-140 l/min, ~77 % of the fine gold, every piece
    r = G(A, """() => { const pr = window.__goldrush.procObj(), L = pr.ledger, wp = pr.washplant, sl = pr.sluice; sl.setWater(true);
      const s0 = wp.stats.processedMl, h0 = wp.stats.heavyUg; let fine = 0, pieces = 0;
      for (let t = 0; t < 600; t++) {
        if (pr.bulk.buffer.room > 100000) { const B = pr._batch('raw'); B.volumeMl = 100000; B.comp = [90000, 45000, 40000, 10000]; B.fineUg = 30000; B.finds = [{ cls: 3, ug: 900, key: 'w' + t }]; fine += B.fineUg; pieces += 900;
          L.inUg += B.goldUg; L.inFinds = (L.inFinds || 0) + 1; L.inG += B.massG; L.inMl += B.volumeMl; pr.bulk.buffer.put(B); }
        pr.tickSim(1); if (pr.piles.get('tailOut').volumeMl > 2e6) pr.benchLoaderMove('tailOut', 'pile:tailings', 600000);
      }
      const lanes = wp.lanes.map((l) => l.processedMl);
      return { lpm: (wp.stats.processedMl - s0) / 1000 / 10, heavy: wp.stats.heavyUg - h0, lanes, riffleUg: wp.riffleUg(), riffleFinds: [0, 1, 2].reduce((a, i) => a + wp.rif(i).finds.length, 0), capture: wp.capture }; }""")
    good, det = exact(A)
    spread = (max(r["lanes"]) - min(r["lanes"])) / max(1, max(r["lanes"]))
    ok("WASH runs at 90-140 l/min fed by the feeder, the box splits evenly over the three lanes", 85 <= r["lpm"] <= 140 and spread < 0.05, f"{r['lpm']:.0f} l/min lanes {r['lanes']}")
    ok("WASH recovery ~75-85 % of the fine gold (no bonus gold), every piece held, the ledger exact", 0.74 <= r["capture"] <= 0.80 and r["riffleFinds"] > 0 and good, f"capture {r['capture']}, finds in the riffles {r['riffleFinds']} | {det}")
    G(A, f"() => {GR}.walk(0.6, 0, 0)")
    G(A, f"() => {GR}.camLook({{ x: -15.2, y: 3.6, z: 2.6, tx: -20.0, ty: 0.8, tz: -1.4 }})")
    shot(A, "wash_running")
    G(A, f"() => {GR}.camLook({{ x: -22.6, y: 2.3, z: -0.2, tx: -20.6, ty: 1.1, tz: -1.3 }})")
    shot(A, "distribution_box")
    G(A, f"() => {GR}.camLook({{ x: -16.4, y: 2.0, z: 0.6, tx: -19.0, ty: 0.75, tz: -1.3 }})")
    shot(A, "recovery_lanes")
    grant(A, ["washplant.recovery"])
    rec = G(A, "() => { const wp = window.__goldrush.procObj().washplant; return { capture: wp.capture, overlay: wp.laneModels[0].userData.mesh.visible }; }")
    ok("WASH the recovery upgrade: expanded metal over moss mats (visible), ~84 % (in 75-85 %)", 0.82 <= rec["capture"] <= 0.86 and rec["overlay"], json.dumps(rec))
    # backpressure: the outlet full -> the lanes wait, the box fills, the feeder stops
    G(A, f"() => {GR}.procObj().devFillOutlet()")
    bp = G(A, """() => { const pr = window.__goldrush.procObj(), wp = pr.washplant, sl = pr.sluice, L = pr.ledger; const p0 = wp.stats.processedMl;
      for (let t = 0; t < 240; t++) { if (pr.bulk.buffer.room > 100000) { const B = pr._batch('raw'); B.volumeMl = 100000; B.comp = [90000, 45000, 40000, 10000]; B.fineUg = 3000; L.inUg += B.goldUg; L.inG += B.massG; L.inMl += B.volumeMl; pr.bulk.buffer.put(B); } pr.tickSim(1); }
      return { washed: wp.stats.processedMl - p0, blocked: wp.blocked, box: sl.hopper.batch.volumeMl, cap: sl.capacityMl, feeder: pr.feeder.status().key }; }""")
    good, det = exact(A)
    ok("WASH backpressure: the outlet pile at the lanes' ends -> they wait, the box fills up, the feeder stops; nothing lost", bp["blocked"] and bp["washed"] == 0 and bp["box"] >= bp["cap"] - 1000 and good, f"{bp} | {det}")
    G(A, f"() => {GR}.walk(0.4, 0, 0)")
    G(A, f"() => {GR}.camLook({{ x: -13.4, y: 3.0, z: 1.6, tx: -17.4, ty: 0.4, tz: -1.4 }})")
    shot(A, "blocked_chain")
    # cleaning out -> the tub; the tub -> the bucket (carried) -> the trough -> the pan -> the pouch
    G(A, "() => { const pr = window.__goldrush.procObj(); pr.devSetPile('tailOut', null); pr.sluice.setWater(false); }")
    cl = G(A, f"() => {{ const g = {GR}, pr = g.procObj(), wp = pr.washplant; const c = wp.spots.clean; g.pose({{ x: c.x, z: c.z, yaw: c.yaw, pitch: -0.6 }}); const st = g.stationNow(); const rif = wp.riffleUg(); const a = g.procAct('sluice-clean'); const w = g.procWork(12); return {{ st: st && st.id, rif, tub: wp.conc.batch.volumeMl, tubUg: wp.conc.batch.goldUg, ok: a && a.ok }}; }}")
    ok("WASH cleaning out (water off): all three mats into the concentrate tub at the plant (its gold, nothing printed)", cl["st"] == "sluice-clean" and cl["tub"] > 0 and cl["tubUg"] > 0 and cl["tubUg"] <= cl["rif"], json.dumps(cl))
    G(A, f"() => {GR}.camLook({{ x: -17.4, y: 1.6, z: 1.4, tx: -18.5, ty: 0.2, tz: 0.2 }})")
    shot(A, "concentrate_tub")
    tub = G(A, f"() => {GR}.procObj().washplant.spots.tub")
    tb = G(A, """(t) => { const g = window.__goldrush, pr = g.procObj(); pr.bucket.carried = true; pr.bucket.batch = pr._batch('raw');
      g.pose({ x: t.x + 1.0, z: t.z + 0.6, yaw: Math.atan2(1.0, 0.6), pitch: -0.4 }); const st = g.stationNow(); const before = pr.washplant.conc.batch.volumeMl;
      if (st && st.id === 'conc-bucket') g.useStation(); return { st: st && st.id, got: pr.bucket.batch.volumeMl, stage: pr.bucket.batch.stage, left: pr.washplant.conc.batch.volumeMl, before }; }""", tub)
    ok("WASH the tub -> your bucket (the concentrate stays concentrate)", tb["st"] == "conc-bucket" and tb["got"] > 0 and tb["stage"] == "heavy" and tb["got"] + tb["left"] == tb["before"], json.dumps(tb))
    pouch0 = G(A, f"() => {GR}.economy().pouchUg")
    rec0 = G(A, f"() => {GR}.procObj().ledger.recoveredUg")
    G(A, f"() => {{ const g = {GR}; g.pose({{ x: -16.12, z: 2.0, yaw: Math.PI / 2, pitch: -0.3 }}); g.procObj().act('bucket-wash', g.procObj().ctx ? null : {{ x: -16.15, z: 3.5 }}); }}")
    G(A, f"() => {{ const b = {GR}.procObj().bucket; if (b.carried) {{ b.carried = false; {GR}.procObj().devPlaceBucket(-16.15, 3.5, 0.4); }} }}")
    pans, stages = 0, set()
    while pans < 12:
        f = G(A, f"() => {{ const g = {GR}; g.pose({{ x: -16.12, z: 2.0, yaw: Math.PI / 2, pitch: -0.3 }}); const r = g.procAct('pan-fill'); return r && r.ok ? g.procObj().pan.batch.stage : null; }}")
        if not f:
            break
        stages.add(f)
        G(A, f"() => {GR}.procWork(30)")
        G(A, f"() => {GR}.procCollect()")
        pans += 1
    pouch1 = G(A, f"() => {GR}.economy().pouchUg")
    rec1 = G(A, f"() => {GR}.procObj().ledger.recoveredUg")
    good, det = exact(A)
    ok("WASH the bucket at the trough is panned as heavy concentrate -> the gold into the pouch (the pan stays the last step); exact",
       pans >= 1 and stages == {"heavy"} and pouch1 - pouch0 == rec1 - rec0 and rec1 > rec0 and good, f"{pans} pans {stages}, pouch +{pouch1 - pouch0} | {det}")


# ======================================================================
# CHAIN - full conservation through a save / reload
# ======================================================================

def chain(A):
    fresh(A)
    mine_up(A)
    grant(A, ["bucket", "pan"])
    paused(A)
    finds0 = G(A, f"() => {GR}.procObj().ledger.inFinds || 0")
    washed0 = G(A, f"() => {GR}.economy().stats.washedPieces")
    # the excavator digs the real ground onto the raw pile
    dev(A, "p10.face")
    G(A, f"() => {GR}.procObj().devSetPile('raw', null)")
    dug = G(A, """() => { const g = window.__goldrush, pr = g.procObj(); let ml = 0, n = 0;
      for (let k = 0; k < 200 && n < 60; k++) {
        const list = g.excTargets(8, -0.9, 0.1).filter((q) => !q.stone);
        if (!list.length) break;
        const q = list[k % list.length], res = g.excScoopAt(q.x, q.z);
        if (res && res.ok) { n++; ml += res.ml; }
        if (pr.excavator.volumeMl >= 28000) pr.benchExcToPile('raw');
      }
      if (pr.excavator.volumeMl > 0) pr.benchExcToPile('raw');
      g.excExit();
      return { n, ml, raw: pr.piles.get('raw').volumeMl }; }""")
    # the loader feeds the intake; the plant runs (belt, trommel + stacker, wash plant); the outlet cleared
    G(A, f"() => {GR}.procObj().sluice.setWater(true)")
    G(A, """() => { const pr = window.__goldrush.procObj();
      for (let t = 0; t < 900; t++) { if (pr.conveyor.intake.room > 260000 && pr.piles.get('raw').volumeMl > 0) pr.benchLoaderMove('raw', 'intake'); pr.tickSim(1);
        if (pr.piles.get('tailOut').volumeMl > 2e6) pr.benchLoaderMove('tailOut', 'pile:tailings', 600000); } }""")
    d0 = ledger(A)
    f1 = A.evaluate(FINDS_JS)
    snap = """() => { const pr = window.__goldrush.procObj(), o = { piles: {}, intake: pr.conveyor.volumeMl, belt: pr.conveyor.belt.volumeMl, feed: pr.trommel.feed.volumeMl, stacker: pr.trommel.overBelt.volumeMl,
      bulk: pr.bulk.volumeMl, box: pr.sluice.hopper.batch.volumeMl, rif: pr.washplant.riffleUg(), tub: pr.washplant.conc.batch.volumeMl, L: { ...pr.ledger } };
      for (const P of pr.piles.list()) o.piles[P.id] = [P.volumeMl, P.buffer.goldUg]; return o; }"""
    s1 = G(A, snap)
    ok("CHN the chain ran: excavator -> raw pile -> loader -> intake -> belt -> trommel (+ stacker) -> wash plant -> tailings", dug["n"] >= 20 and s1["piles"]["raw"][0] < dug["raw"] and s1["L"]["tailMl"] > 0,
       f"dug {dug['n']} scoops {dug['ml'] / 1000:.0f} l, raw {dug['raw'] / 1000:.0f} -> {s1['piles']['raw'][0] / 1000:.0f} l")
    ok("CHN mid-chain: gold in = containers + recovered + tailings, mass too", d0[0] == 0 and d0[1] == 0, f"{d0[0]} / {d0[1]}")
    reload(A)
    paused(A)
    s2 = G(A, snap)
    f2 = A.evaluate(FINDS_JS)
    diff = {k: (s1[k], s2[k]) for k in s1 if s1[k] != s2[k]}
    ok("CHN save / reload in the middle of the chain: every pile, buffer, belt, the stacker, the box, the riffles, the tub and the ledger exactly back", not diff and f1["n"] == f2["n"] and f2["dup"] == 0, json.dumps(diff)[:300])
    # the dev snapshot of the working mine (a loaded loader bucket too): more work afterwards - restoring it brings
    # exactly the snapshot's mine back
    snap2 = snap.replace("L: { ...pr.ledger } };", "L: { ...pr.ledger }, ldr: [pr.loader.volumeMl, pr.loader.bucket.batch.goldUg, +pr.loader.x.toFixed(3), +pr.loader.z.toFixed(3)] };")
    dev(A, "p10.loaderFull")
    paused(A)
    s3 = G(A, snap2)
    wrote = G(A, f"() => {GR}.devSnapshotWrite()")
    G(A, """() => { const pr = window.__goldrush.procObj(); pr.benchLoaderMove('raw', 'intake'); for (let t = 0; t < 120; t++) pr.tickSim(1); }""")
    moved = G(A, snap2) != s3
    G(A, f"() => {GR}.devSnapshotRestore()")
    wait_for(lambda: G(A, f"() => !!(window.__goldrush && {GR}.procObj && {GR}.procObj() && {GR}.procObj().loader)"), 60)
    paused(A)
    s4 = G(A, snap2)
    diff = {k: (s3[k], s4[k]) for k in s3 if s3[k] != s4[k]}
    ok("CHN the dev snapshot of a working mine (loaded loader bucket, piles, plant, wash plant, ledger) comes back exactly after more work",
       wrote and moved and s3["ldr"][0] > 0 and not diff, f"bucket {s3['ldr'][0] / 1000:.0f} l | " + json.dumps(diff)[:300])
    # on: clean out, the tub to the bucket and the pan
    G(A, """() => { const pr = window.__goldrush.procObj(); for (let t = 0; t < 600; t++) { if (pr.conveyor.intake.room > 260000 && pr.piles.get('raw').volumeMl > 0) pr.benchLoaderMove('raw', 'intake'); pr.tickSim(1); if (pr.piles.get('tailOut').volumeMl > 2e6) pr.benchLoaderMove('tailOut', 'pile:tailings', 600000); } }""")
    pouch0 = G(A, f"() => {GR}.economy().pouchUg")
    G(A, f"() => {{ const g = {GR}; g.procWater(false); g.procAct('sluice-clean'); g.procWork(12); }}")
    for _ in range(6):
        if G(A, f"() => {GR}.concToWash()") <= 0:
            break
        for _ in range(12):
            f = G(A, f"() => {GR}.procAct('pan-fill')")
            if not f or not f.get("ok"):
                break
            G(A, f"() => {GR}.procWork(30)")
            G(A, f"() => {GR}.procCollect()")
    d = ledger(A)
    L = d[2]
    pouch1 = G(A, f"() => {GR}.economy().pouchUg")
    ok("CHN at the end: conservation exact (gold and mass), the recovered gold is in the pouch", d[0] == 0 and d[1] == 0 and pouch1 > pouch0, f"{d[0]} / {d[1]}, pouch +{pouch1 - pouch0}")
    fe = A.evaluate(FINDS_JS)
    pin = L["inFinds"] - finds0
    pout = G(A, f"() => {GR}.economy().stats.washedPieces") - washed0
    ok("CHN every piece exactly once: in = held (piles, buffers, riffles, tub, bucket ...) + recovered", pin > 0 and pin == fe["n"] + pout and fe["dup"] == 0, f"in {pin} = held {fe['n']} + recovered {pout}, dup {fe['dup']}")
    G(A, f"() => {GR}.walk(0.4, 0, 0)")
    G(A, f"() => {GR}.camLook({{ x: -6.0, y: 9.0, z: 2.0, tx: -15.0, ty: 0.5, tz: -9.0 }})")
    shot(A, "full_chain")


# ======================================================================
# SAVE - v9, a v8 mine, a new mine
# ======================================================================

def save(A):
    fresh(A)
    paused(A)
    v = G(A, f"() => {{ {GR}.save(); const d = JSON.parse(localStorage.getItem(grKey())); return {{ v: d.saveVersion, piles: !!(d.processing && d.processing.piles), loader: d.processing && d.processing.loader }}; }}")
    ok("SAVE a new mine is saved as v9 - no piles with material, no loader", v["v"] == 9 and not v["loader"], json.dumps(v))
    # a v8 mine with a phase-9 oversize buffer and spoil totals
    mine_up(A, wash=False, upgrades=False)
    paused(A)
    G(A, f"() => {GR}.save()")
    doc = G(A, "() => JSON.parse(localStorage.getItem(grKey()))")
    pr = doc["processing"]
    pr.pop("piles", None)
    pr.pop("loader", None)
    pr.pop("washplant", None)
    owned = [o for o in pr.get("owned", []) if o not in ("loader", "washplant")]
    pr["owned"] = owned
    doc["tools"]["upgrades"] = [u for u in doc["tools"].get("upgrades", []) if u not in ("conveyor.fast", "trommel.fast", "washplant.recovery")]
    over = {"id": 9001, "stage": "raw", "volumeMl": 900000, "comp": [200000, 300000, 500000, 600000], "fineUg": 4000, "finds": [{"cls": 5, "ug": 12000, "key": "v8:nug"}]}
    pr["trommel"]["oversize"] = {"layers": [over]}
    pr["spoil"] = {"ml": 2000000, "g": 3000000, "ug": 9000, "loads": 40}
    led = pr["ledger"]
    led["inUg"] += 16000 + 9000; led["inG"] += 1600000 + 3000000; led["inMl"] += 900000 + 2000000
    led["tailUg"] += 9000; led["tailG"] += 3000000; led["tailMl"] += 2000000
    led["inFinds"] = led.get("inFinds", 0) + 1
    doc["saveVersion"] = 8
    G(A, f"() => {GR}.setPaused(false)")
    Q.close(A)
    G(A, "(d) => { localStorage.setItem(grKey(), JSON.stringify(d)); }", doc)
    gr_open(A)
    gr_ready(A)
    paused(A)
    m = G(A, "() => { const pr = window.__goldrush.procObj(); return { over: pr.piles.get('oversize').volumeMl, overUg: pr.piles.get('oversize').buffer.goldUg, spoil: pr.piles.get('spoil').volumeMl, spoilUg: pr.piles.get('spoil').buffer.goldUg, finds: pr.piles.get('oversize').buffer.layers.reduce((a, l) => a + l.finds.length, 0) }; }")
    G(A, f"() => {GR}.save()")
    v2 = G(A, "() => JSON.parse(localStorage.getItem(grKey())).saveVersion")
    good, det = exact(A)
    ok("SAVE a v8 mine loads: its oversize buffer (with its nugget) onto the oversize pile, the spoil totals onto the spoil pile - nothing booked twice; written back as v9",
       m["over"] == 900000 and m["overUg"] == 4000 + 12000 and m["finds"] == 1 and m["spoil"] == 2000000 and m["spoilUg"] == 9000 and v2 == 9 and good, f"{m} v{v2} | {det}")


# ======================================================================
# NUGGETS - very rare high-value nuggets
# ======================================================================

# the mountain's voxels (every 2nd column, its starter faces included) and the camp's fill: tiers, masses, rarity, the
# budget moved, the host where none may be, the same from a second field on the seed
GEO_JS = r"""async () => {
  const R = await import('/games/goldrush/goldrush-resources.js'), t = window.__goldrush.terrain(), f = t.field, J = R.JACKPOT;
  const f2 = new R.MaterialField(f.seed, t, f.floorY), MEAN = J.tiers.map(([, m0, span, c]) => m0 + span / (c + 1));
  const o = { vox: 0, m3: 0, tiers: [0, 0, 0, 0], nug: 0, bad: [], same: 0, diff: 0, gold: 0, expJ: 0, fill: 0, fillHost: 0, fillJack: 0, starter: 0, starterHost: 0 };
  const v = {}, w = {}, VH = 0.01, O = f.floorY, SL = t.cell * t.cell * VH;
  for (let j = 1; j < t.vps - 1; j += 2) for (let i = 1; i < t.vps - 1; i += 2) {
    const k = j * t.vps + i, x = t.x0 + i * t.cell, z = t.z0 + j * t.cell, base = t.base[k];
    if (!t.inDigArea(x, z)) continue;
    const top = Math.ceil((base - O) / VH - 0.5) - 1, camp = f.campFillAt ? f.campFillAt(x, z) > 0.5 && base < 0.15 : false;
    if (!camp && base < 0.4) continue;
    const lo = camp ? top - 60 : Math.floor((0.06 - O) / VH);
    for (let iy = top; iy > lo; iy--) {
      const r = f.voxel(i, j, iy, v), y = O + (iy + 0.5) * VH;
      if (r.mat === 3) continue;
      if (camp) { if (f.inFill(x, y, z, base)) { o.fill++; if (f.host > 0) o.fillHost++; if (r.jackpot >= 0) o.fillJack++; } continue; }
      if (f.starterWeight(x, y, z, base) >= 0.999) { o.starter++; if (f.host > 0) o.starterHost++; }
      o.vox++;
      o.gold += r.fineUg + (r.cls ? r.massUg : 0);
      o.expJ += f.host * J.tiers.reduce((a, q, n) => a + q[0] * MEAN[n], 0);
      if (r.cls === 5) o.nug++;
      if (r.jackpot >= 0) {
        o.tiers[r.jackpot]++;
        const [, m0, span] = J.tiers[r.jackpot];
        if (r.cls !== 5 || r.massUg < m0 || r.massUg > m0 + span || R.jackpotTier(r.massUg) !== r.jackpot) o.bad.push([i, j, iy, r.jackpot, r.massUg]);
        const r2 = f2.voxel(i, j, iy, w);
        if (r2.jackpot === r.jackpot && r2.massUg === r.massUg && r2.fineUg === r.fineUg) o.same++; else o.diff++;
      }
    }
  }
  o.m3 = o.vox * SL * 4;            // (every 2nd column both ways)
  return o; }"""

SIZES = "async () => { const L = await import('/games/goldrush/goldrush-loot.js'); return [100, 400, 1000, 3000, 5000, 8000].map((c) => L.findSize(5, c, 0.5)); }"

SPLIT = """async () => { const M = await import('/games/goldrush/goldrush-material.js'); const b = new M.MaterialBatch({ stage: 'raw' }); b.volumeMl = 1000; b.comp = [800, 300, 400, 100]; b.fineUg = 500;
  b.finds = [{ cls: 5, ug: 25000, key: 'a' }, { cls: 5, ug: 80000, key: 'b' }, { cls: 5, ug: 300000, key: 'c' }, { cls: 3, ug: 900, key: 'd' }];
  const g0 = b.goldUg, r = M.trommelSplit(b, [1, 2]);
  return { under: r.under.finds.map((f) => f.key), over: r.over.finds.map((f) => f.key), caught: r.caught.map((f) => f.key), sum: r.under.goldUg + r.over.goldUg + r.caught.reduce((a, f) => a + f.ug, 0), g0 }; }"""

# where one piece is: every holder of the processing (batches, the trommel's trap), the economy's pending finds
WHERE_JS = r"""async (key) => {
  const { MaterialBatch } = await import('/games/goldrush/goldrush-material.js');
  const g = window.__goldrush, pr = g.procObj(), seen = new Set(), at = [];
  const SKIP = new Set(['ctx', 'scene', 'world', 'economy', 'terrain', 'mining', 'rocks', 'assets', 'hands', 'game', 'player', 'audio', 'model', 'group',
    'pm', 'rig', 'root', 'THREE', 'camera', 'renderer', 'input', 'hud', 'stations', 'parts', 'colliders', 'collider', 'loads', 'geom', 'lumps']);
  const walk = (o, path, depth) => {
    if (!o || typeof o !== 'object' || seen.has(o) || depth > 8) return;
    seen.add(o);
    if (o.isObject3D || o.isMaterial || o.isBufferGeometry || o.isTexture || ArrayBuffer.isView(o)) return;
    if (o instanceof MaterialBatch) { for (const f of o.finds) if (f.key === key) at.push(path); return; }
    if (Array.isArray(o)) { if (o.length < 5000) o.forEach((q, n) => { if (q && q.key === key && q.ug > 0) at.push(`${path}[${n}]`); else walk(q, `${path}[${n}]`, depth + 1); }); return; }
    for (const k of Object.keys(o)) if (!SKIP.has(k)) walk(o[k], `${path}.${k}`, depth + 1);
  };
  walk(pr, 'pr', 0);
  for (const it of g.economyObj().pending.values()) if (it.key === key) at.push('pending');
  return at; }"""

BIG = "() => { const e = window.__goldrush.economyObj(); return { big: [...e.stats.bigNuggets], cents: e.stats.bigNuggetCents, pouch: e.pouchCents, pouchUg: e.pouchUg, pending: e.pending.size, washed: e.stats.washedPieces }; }"


def nuggets(A):
    fresh(A)
    paused(A)
    # ---- the ground
    o = A.evaluate(GEO_JS)
    n = sum(o["tiers"])
    ok("NUG the ground holds big nuggets of their own tiers (EUR 5-12 / 12-30 / 30-50 / 50-86 by mass), each found again by a second field on the same seed (the place, not a stroke)",
       n > 0 and not o["bad"] and o["diff"] == 0 and o["same"] == n, f"tiers {o['tiers']} in {o['m3']:.0f} m3 (1/4 sampled), bad {o['bad'][:2]}, diff {o['diff']}")
    per = [q * 4 / max(1, o["m3"]) for q in o["tiers"]]
    ok("NUG very rare: per m3 of mountain large 0,01-0,1, rare <= 0,035, EUR 30+ <= 0,01; all of them < 1 % of the mountain's nuggets",
       0.01 <= per[0] <= 0.1 and per[1] <= 0.035 and per[2] + per[3] <= 0.01 and n < 0.01 * o["nug"], f"per m3 {[round(x, 4) for x in per]}, {n} of {o['nug']} nuggets")
    ok("NUG the claim's budget kept: what the big pieces take off the fine gold < 0,1 % of the mountain's gold", o["expJ"] < 0.001 * o["gold"], f"{o['expJ'] / max(1, o['gold']) * 100:.4f} %")
    ok("NUG never in the camp's fill, nor in the starter faces' core (no host there)", o["fill"] > 1000 and o["fillHost"] == 0 and o["fillJack"] == 0 and o["starterHost"] == 0,
       f"fill {o['fill']} voxels host {o['fillHost']} jackpots {o['fillJack']} | starter {o['starter']} host {o['starterHost']}")
    s = A.evaluate(SIZES)
    ok("NUG drawn by value: bigger with every euro, EUR 10 ~1,3x and EUR 80 ~2,2x the radius of a EUR 4 nugget (clearly bigger, no prop)",
       all(s[i] < s[i + 1] for i in range(len(s) - 1)) and 1.15 <= s[2] / s[1] <= 1.45 and 1.9 <= s[5] / s[1] <= 2.5, " ".join(f"{x * 1000:.1f}" for x in s) + " mm")
    sp = A.evaluate(SPLIT)
    ok("NUG the trommel's screen: pieces and nuggets up to ~EUR 10 through it, a bigger one caught whole - never the oversize; gold exact",
       sp["under"] == ["a", "b", "d"] and sp["caught"] == ["c"] and sp["over"] == [] and sp["sum"] == sp["g0"], json.dumps(sp))
    # ---- dug from the ground: the tier's sound at the dig, the line when it is in the hand
    b0 = G(A, BIG)
    G(A, f"() => {GR}.aimAt({{ x: 0.6, z: 5.0, yaw: 0, pitch: -0.9 }})")
    r = dev(A, "p10.nug.ground.80")
    G(A, f"() => {GR}.setPaused(false)")
    G(A, f"() => {{ const g = {GR}; g.aimAt({{ x: 0.6, z: 5.0, yaw: 0, pitch: -0.9 }}); return g.contact(); }}")
    heard = G(A, f"() => {GR}.soundsHeard()")
    time.sleep(6)                              # (real frames: it flies, lands, comes to the hand, is held up)
    nl = G(A, f"() => {GR}.lastNugget()")
    b1 = G(A, BIG)
    paused(A)
    ok("NUG dug from the ground (EUR 80): the sting at the dig, held up, 'Großer Goldfund – € 80,00', legendary in the statistics, nothing pending",
       r.get("ok") and "nugget_jackpot" in heard and nl["loot"] == 3 and (nl["hud"] or {}).get("title") == "Großer Goldfund – € 80,00" and b1["big"][3] == b0["big"][3] + 1 and b1["pending"] == 0,
       f"{r.get('text', r.get('error'))} | heard {heard[-4:]} | {nl} | {b0['big']} -> {b1['big']}")
    # ---- the chain: a EUR 30 nugget into the intake -> the trommel's trap
    mine_up(A)
    paused(A)
    G(A, "() => { const pr = window.__goldrush.procObj(); pr.devSetPile('tailOut', null); }")
    r = dev(A, "p10.nug.intake.30")
    key = G(A, "() => { for (const l of window.__goldrush.procObj().conveyor.intake.layers) for (const f of l.finds) if (f.key.startsWith('dev:nug30')) return f.key; return null; }")
    f0 = A.evaluate(FINDS_JS)
    G(A, "() => { const pr = window.__goldrush.procObj(); pr.sluice.setWater(true); pr.devConveyorMode('auto'); }")
    t = G(A, "(key) => { const pr = window.__goldrush.procObj(); for (let s = 0; s < 400; s++) { pr.tickSim(1); if (pr.trommel.trap.some((f) => f.key === key)) return s; } return -1; }", key)
    where = A.evaluate(WHERE_JS, key)
    hud = G(A, f"() => {GR}.hudState().toast")
    heard = G(A, f"() => {GR}.soundsHeard()")
    G(A, f"() => {GR}.walk(0.2, 0, 0)")
    vis = G(A, "() => { const tn = window.__goldrush.procObj().trommel.model.userData.trapNugget; return { on: tn.visible, r: +tn.scale.x.toFixed(4) }; }")
    f1 = A.evaluate(FINDS_JS)
    good, det = exact(A)
    ok("NUG the chain: a EUR 30 nugget from the intake rides the belt into the trommel and stays in its nugget trap - exactly once, never on the oversize pile; shown there, the clunk, the line; the ledger exact",
       r.get("ok") and key and t >= 0 and where == ["pr.trommel.trap[0]"] and vis["on"] and vis["r"] > 0.02 and "nugget_trap" in heard and "Nuggetfalle" in (hud or "") and good and f1["dup"] == 0 and f1["n"] == f0["n"],
       f"{t} s, at {where}, mesh {vis}, toast {(hud or '')[:50]!r} | {det} | pieces {f0['n']} -> {f1['n']} dup {f1['dup']}")
    reload(A)
    paused(A)
    where2 = A.evaluate(WHERE_JS, key)
    f2 = A.evaluate(FINDS_JS)
    good, det = exact(A)
    ok("NUG the trap through a save / reload: the same piece once, the ledger exact", where2 == ["pr.trommel.trap[0]"] and f2["dup"] == 0 and f2["n"] == f1["n"] and good, f"{where2} | {det}")
    b0 = G(A, BIG)
    trap = G(A, "async () => { const P = await import('/games/goldrush/goldrush-plantmodels.js'); return { x: P.TRAP.x, z: P.TRAP.z, y: P.TRAP.y }; }")
    G(A, "(t) => { const g = window.__goldrush, x = t.x + 0.35, z = t.z - 1.6; g.pose({ x, z, yaw: Math.atan2(-(t.x - x), -(t.z - z)), pitch: -0.05 }); }", trap)
    st = G(A, f"() => {GR}.stationNow()")
    used = G(A, f"() => {GR}.useStation()")
    b1 = G(A, BIG)
    hud = G(A, f"() => {GR}.lastNugget()")
    heard = G(A, f"() => {GR}.soundsHeard()")
    where3 = A.evaluate(WHERE_JS, key)
    good, det = exact(A)
    ok("NUG at the trap: [E] 'Nuggetfalle leeren' -> into the pouch (EUR 30,00), 'Großer Goldfund – € 30,00', the sting, exceptional in the statistics; the trap empty, the ledger exact",
       st and st["id"] == "trommel-trap" and used and b1["pouch"] - b0["pouch"] == 3000 and (hud["hud"] or {}).get("title") == "Großer Goldfund – € 30,00" and "nugget_jackpot" in heard
       and b1["big"][2] == b0["big"][2] + 1 and not where3 and good, f"{st} | pouch +{b1['pouch'] - b0['pouch']} | {hud['hud']} | {heard[-3:]} | {det}")
    reload(A)
    paused(A)
    b2 = G(A, BIG)
    ok("NUG taken once: after a reload the pouch and the statistics the same, the trap empty", b2["pouch"] == b1["pouch"] and b2["big"] == b1["big"] and G(A, "() => window.__goldrush.procObj().trommel.trap.length") == 0, f"{b1} / {b2}")
    # ---- a EUR 8 nugget through the screen: the wash plant's riffles -> cleaned out
    G(A, """() => { const pr = window.__goldrush.procObj(), B = pr._batch('raw'); B.volumeMl = 20000; B.comp = [16000, 6000, 3000, 0]; B.fineUg = 2000;
      B.finds = [{ cls: 5, ug: 80000, key: 'qa:nug8' }]; B.id = pr.nextBatch++; pr._devIn(B); pr.conveyor.intake.put(B); pr.sluice.setWater(true); pr.devConveyorMode('auto'); }""")
    t = G(A, """() => { const pr = window.__goldrush.procObj(), wp = pr.washplant; for (let s = 0; s < 900; s++) { pr.tickSim(1);
      const lanes = [0, 1, 2].map((i) => wp.rif(i)); if (lanes.some((b) => b && b.finds && b.finds.some((f) => f.key === 'qa:nug8'))) return s; } return -1; }""")
    where = A.evaluate(WHERE_JS, "qa:nug8")
    b0 = G(A, BIG)
    G(A, f"() => {{ const g = {GR}; g.procWater(false); g.procAct('sluice-clean'); }}")
    ev = G(A, f"() => {GR}.procWork(12).ev")
    b1 = G(A, BIG)
    good, det = exact(A)
    ok("NUG a EUR 8 nugget goes through the screen with the fines into the wash plant's riffles; cleaning out picks it into the pouch (large in the statistics); the ledger exact",
       t >= 0 and len(where) == 1 and "riffles" in where[0] and ev and ev.get("bestUg") == 80000 and b1["big"][0] == b0["big"][0] + 1 and not A.evaluate(WHERE_JS, "qa:nug8") and good,
       f"{t} s at {where} | ev bestUg {ev and ev.get('bestUg')} | {b0['big']} -> {b1['big']} | {det}")
    # ---- the pan and the sieve keep any size
    b0 = G(A, BIG)
    r = dev(A, "p10.nug.bucket.50")
    for _ in range(8):                         # (a piece goes with its share of the bucket: whole, in one of the pans)
        f = G(A, f"() => {GR}.procAct('pan-fill')")
        if not f or not f.get("ok"):
            break
        G(A, f"() => {GR}.procWork(40)")
        G(A, f"() => {GR}.workAction()")
        if G(A, f"() => {GR}.lastNugget().big") and G(A, BIG)["big"][3] > b0["big"][3]:
            break
    b1 = G(A, BIG)
    hud = G(A, f"() => {GR}.lastNugget()")
    heard = G(A, f"() => {GR}.soundsHeard()")
    good, det = exact(A)
    ok("NUG the pan keeps a EUR 50 nugget: into the pouch, 'Großer Goldfund – € 50,00' and the sting; the ledger exact",
       r.get("ok") and b1["big"][3] == b0["big"][3] + 1 and (hud["hud"] or {}).get("title") == "Großer Goldfund – € 50,00" and "nugget_jackpot" in heard and good,
       f"{b0['big']} -> {b1['big']} | {hud['hud']} | {heard[-3:]} | {det}")
    grant(A, ["classifier"])
    b0 = G(A, BIG)
    r = dev(A, "p10.nug.bucket.30")
    G(A, f"() => {GR}.procAct('sieve-load')")
    ev = G(A, f"() => {GR}.procWork(20).ev")
    b1 = G(A, BIG)
    good, det = exact(A)
    ok("NUG the sieve keeps a EUR 30 nugget on its mesh: picked into the pouch; the ledger exact",
       r.get("ok") and ev and ev.get("kind") == "sieved" and (ev.get("retained") or {}).get("bestUg") == 300000 and b1["big"][2] == b0["big"][2] + 1 and good,
       f"{ev and ev.get('retained')} | {b0['big']} -> {b1['big']} | {det}")
    fe = A.evaluate(FINDS_JS)
    ok("NUG no piece twice anywhere (batches, the trap)", fe["dup"] == 0, json.dumps(fe))
    # the trommel taken away (dev) with a nugget in its trap: booked out with what it held - the ledger exact
    dev(A, "p10.nug.trap.50")
    G(A, "() => window.__goldrush.procObj().devRemove('trommel')")
    good, det = exact(A)
    ok("NUG the trommel removed (dev) with a nugget in its trap and material on its stacker: the ledger exact (the oversize pile stays)", good, det)


# ======================================================================
# P1001 - GoldRush 10.0.1: sluice stages, the small hillside miner
# ======================================================================

FLOW = """(sec) => { const pr = window.__goldrush.procObj(), sl = pr.sluice, B = pr._batch('raw'); B.volumeMl = pr.bulk.capacityMl - pr.bulk.volumeMl;
  B.comp = [Math.round(B.volumeMl * 0.9), Math.round(B.volumeMl * 0.45), Math.round(B.volumeMl * 0.4), Math.round(B.volumeMl * 0.1)]; B.fineUg = Math.round(B.volumeMl * 0.4);
  pr._devIn(B); pr.bulk.buffer.put(B); pr.devFeederMode('auto'); pr.devConveyorMode('stop'); sl.setWater(true); pr.devSetPile('tailOut', null);
  for (let t = 0; t < 20; t++) pr.tickSim(1);
  const p0 = sl.stats.processedMl; for (let t = 0; t < sec; t++) pr.tickSim(1);
  return { lpm: +((sl.stats.processedMl - p0) / 1000 / (sec / 60)).toFixed(1), sluice: sl.rateLpm, feeder: pr.feeder.rateLpm }; }"""
MINI = "() => { const am = window.__goldrush.procObj().autominer; return am ? { small: am.small, bite: am.M.biteMl, placed: am.placed, x: +am.x.toFixed(3), z: +am.z.toFixed(3), on: am.on, status: am.status, stats: { ...am.stats }, ml: am.volumeMl, label: am.label } : null; }"


def patch1001(A):
    fresh(A)
    paused(A)
    plant_up(A)
    grant(A, ["sluice.highflow"])
    G(A, f"() => {GR}.setCash(500000)")
    r0 = G(A, FLOW, 60)
    b2 = G(A, f"() => {GR}.buy('sluice.flow2')")
    r2 = G(A, FLOW, 60)
    b3 = G(A, f"() => {GR}.buy('sluice.flow3')")
    r3 = G(A, FLOW, 60)
    ok("P1001 shop: 'Rinnen-Durchsatz II · 32 → 45 l/min' (EUR 450) and III '45 → 60' (EUR 750) bought; the box measured 32 -> 45 -> 60 l/min",
       b2.get("ok") and b3.get("ok") and 30 <= r0["lpm"] <= 33 and 43 <= r2["lpm"] <= 46 and 57 <= r3["lpm"] <= 61, f"{r0} | {r2} | {r3} | {b2} {b3}")
    ok("P1001 the feeder doses what the box takes at every stage (never below it)", r0["feeder"] >= r0["sluice"] == 32 and r2["feeder"] >= r2["sluice"] == 45 and r3["feeder"] >= r3["sluice"] == 60,
       f"feeder {r0['feeder']}/{r2['feeder']}/{r3['feeder']} sluice {r0['sluice']}/{r2['sluice']}/{r3['sluice']}")
    good, det = exact(A)
    ok("P1001 the sluice stages: the ledger exact", good, det)
    reload(A)
    paused(A)
    rr = G(A, "() => { const pr = window.__goldrush.procObj(); return { up: [...window.__goldrush.tools().saved.upgrades].filter((u) => u.startsWith('sluice.')), sluice: pr.sluice.flowMax, feeder: pr.feeder.rateLpm }; }")
    ok("P1001 save / reload: the stages kept (the box 60, the feeder 60)", "sluice.flow3" in rr["up"] and "sluice.flow2" in rr["up"] and rr["sluice"] == 60 and rr["feeder"] == 60, json.dumps(rr))
    # ---- the small hillside miner
    fresh(A)
    paused(A)
    plant_up(A)
    G(A, f"() => {GR}.procGrant('minerhead')")
    sp = G(A, "() => { const am = window.__goldrush.procObj().autominer, sp = am.findSpot('intake'); if (!sp) return null; const r = am.place(sp.x, sp.z, sp.heading); am.setOn(true); return { ok: r.ok, recv: am.recv ? am.recv.kind : null, m3: am.survey().m3 }; }")
    m0 = G(A, MINI)
    s0 = G(A, "() => { const pr = window.__goldrush.procObj(), e = window.__goldrush.economyObj(); return { inUg: pr.ledger.inUg, mountainG: e.stats.mountainG, intake: pr.conveyor.stats ? pr.conveyor.stats.inMl || 0 : 0, intakeNow: pr.conveyor.volumeMl }; }")
    G(A, "() => { const pr = window.__goldrush.procObj(); pr.devConveyorMode('stop'); for (let t = 0; t < 300; t++) pr.tickSim(1); }")
    m1 = G(A, MINI)
    s1 = G(A, "() => { const pr = window.__goldrush.procObj(), e = window.__goldrush.economyObj(), am = pr.autominer; return { inUg: pr.ledger.inUg, mountainG: e.stats.mountainG, intakeNow: pr.conveyor.volumeMl, m3: am.survey().m3 }; }")
    lpm = (m1["stats"]["dugMl"] - m0["stats"]["dugMl"]) / 1000 / 5
    ok("P1001 the small miner ('Schürfkopf', 3-l bites) set up at the intake cuts the real mountain at 20-35 l/min",
       sp and sp["ok"] and sp["recv"] == "intake" and m0["small"] and m0["bite"] == 3000 and m0["label"] == "Schürfkopf" and 20 <= lpm <= 35 and s1["m3"] < sp["m3"],
       f"{sp} | {lpm:.1f} l/min | section {sp and sp['m3']:.2f} -> {s1['m3']:.2f} m3 | cuts {m1['stats']['cuts']}")
    good, det = exact(A)
    ok("P1001 its batches: gold from the ground, the mountain contract, everything into the intake hopper; the ledger exact",
       s1["inUg"] > s0["inUg"] and s1["mountainG"] > s0["mountainG"] and m1["stats"]["intakeMl"] > 0 and s1["intakeNow"] > s0["intakeNow"] and good,
       f"gold in +{s1['inUg'] - s0['inUg']} ug, mountain +{(s1['mountainG'] - s0['mountainG']) / 1000:.0f} kg, intake +{(s1['intakeNow'] - s0['intakeNow']) / 1000:.0f} l (out {m1['stats']['intakeMl'] / 1000:.0f} l) | {det}")
    # nothing while paused (no offline work)
    G(A, f"() => {GR}.setPaused(true)")
    d0 = G(A, MINI)["stats"]["dugMl"]
    time.sleep(2)
    d1 = G(A, MINI)["stats"]["dugMl"]
    reload(A)
    paused(A)
    m2 = G(A, MINI)
    ok("P1001 nothing while paused or closed; save / reload keeps the small head (placed, its stand, its counters)",
       d1 == d0 and m2 and m2["small"] and m2["placed"] and abs(m2["x"] - m1["x"]) < 1e-3 and m2["stats"]["dugMl"] == m1["stats"]["dugMl"], f"{d0} -> {d1} | {m2}")
    # hard rock stops it
    rock = G(A, """() => { const g = window.__goldrush, pr = g.procObj(), am = pr.autominer, t = g.terrain(), A = am.M.area;
      am.constructor.samples(am.x, am.z, am.heading, A, (x, z) => { const i = Math.round((x - t.x0) / t.cell), j = Math.round((z - t.z0) / t.cell);
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const k = (j + dj) * t.vps + (i + di), h = t.height[k]; if (h <= am.y + A.floor + 0.06) continue; t.stoneTop[k] = h + 0.5; t.stoneBot[k] = Math.max(am.y + A.floor - 0.2, h - 3); t.rubble[k] = 0; } });
      t._refresh(0, t.vps - 1, 0, t.vps - 1); t.revision++; am.setOn(true);
      const d0 = am.stats.dugMl; for (let k = 0; k < 40 && am.status !== 'rock'; k++) am.cutNow(); return { status: am.status, dug: am.stats.dugMl - d0 }; }""")
    ok("P1001 hard rock in its section: the head is blocked (HARTGESTEIN), nothing dug", rock["status"] == "rock", json.dumps(rock))
    # bought big later: the same machine grows (its counters stay)
    G(A, f"() => {GR}.procGrant('autominer')")
    m3 = G(A, MINI)
    good, det = exact(A)
    ok("P1001 the full hillside miner bought later: the same machine grows (8-l bites, counters kept); the ledger exact",
       m3 and not m3["small"] and m3["bite"] == 8000 and m3["stats"]["cuts"] >= m2["stats"]["cuts"] and m3["label"] == "Abbaugerät" and good, f"{m3} | {det}")


# ======================================================================
# DEV - every Prompt-10 developer command
# ======================================================================

DEV10 = ["quick.phase10", "p10.loaderCourse", "p10.raw", "p10.plant", "p10.tailings", "p10.face", "p10.camp", "p10.loaderEmpty", "p10.loaderFull", "p10.rawLow", "p10.rawBig",
         "p10.rawPoor", "p10.rawRich", "p10.oversize", "p10.washRun", "p10.washBlocked", "p10.conc", "p10.outletLow", "p10.outletFull", "p10.tailZone", "p10.barrowFull",
         "p10.tip.hopper", "p10.tip.bulk", "p10.tip.intake", "p10.tip.pile-raw", "p10.tip.pile-tailings", "p10.tip.pile-spoil", "p10.reverse",
         "p10.sieveResult", "p10.matResult", "p10.upgradesAll", "p10.upgradesNone", "p10.jump", "p10.jumpInfo", "p10.status",
         "p10.miner", "p10.minerOwn", "p10.minerSpot", "p10.minerBelt", "p10.minerBack", "p10.minerRock", "p10.minerNearlyDone", "p10.minerMove",
         "p10.nug.intake.ord", "p10.nug.intake.10", "p10.nug.intake.30", "p10.nug.intake.50", "p10.nug.intake.80", "p10.nug.bucket.ord", "p10.nug.bucket.80",
         "p10.nug.trap.10", "p10.nug.trap.30", "p10.nug.trap.50", "p10.nug.trap.80", "p10.nug.trapLook", "p10.nug.stats"]


def devtools(A):
    fresh(A)
    paused(A)
    t0 = time.time()
    bad = []
    for c in DEV10:
        r = dev(A, c)
        if not r or not r.get("ok"):
            bad.append((c, r))
        if c == "quick.phase10":
            shot(A, "dev_preset")
        G(A, f"() => {{ const g = {GR}; if (g.workState().work) g.workAction(); }}")
    good, det = exact(A)
    ok("DEV every Prompt-10 command works (preset PHASE 10 WORKING MINE, LOADER COURSE / RAW STOCKPILE / PROCESSING PLANT / TAILINGS / EXCAVATION FACE / CAMP OVERVIEW, fills, tip targets, result states, upgrades, jump), the ledger exact",
       not bad and good, f"{len(DEV10)} commands in {time.time() - t0:.0f} s; failed {bad[:3]} | {det}")
    r = dev(A, "quick.phase10")
    m = G(A, "() => { const g = window.__goldrush, pr = g.procObj(); return { loader: !!pr.loader, wash: !!(pr.washplant && pr.washplant.installed), raw: pr.piles.get('raw').volumeMl, conc: pr.washplant.conc.batch.volumeMl, running: pr.sluice.running, exc: !!pr.excavator, up: [...g.tools().saved.upgrades].filter((u) => u.includes('.fast')) }; }")
    ok("DEV the preset: loader, wash plant (running), raw pile, concentrate ready, excavator, both plant upgrades - testable in two minutes",
       r.get("ok") and m["loader"] and m["wash"] and m["raw"] > 1e6 and m["conc"] > 0 and m["running"] and m["exc"] and len(m["up"]) == 2, json.dumps(m))


# ======================================================================
# PERF - draw calls, frames; the phone
# ======================================================================

# ======================================================================
# spec 16: the mine organised through use
# ======================================================================

def area(A):
    fresh(A)
    mine_up(A)
    paused(A)
    pad = G(A, """() => { const ld = window.__goldrush.procObj().loader, p = ld.pad; p.geometry.computeBoundingBox();
      const b = p.geometry.boundingBox; return { inScene: !!p.parent && p.parent.type === 'Scene', name: p.name,
        x0: p.position.x + b.min.x, x1: p.position.x + b.max.x, z0: p.position.z + b.min.z, z1: p.position.z + b.max.z, y: p.position.y }; }""")
    ok("AREA the loader's parking pad: a flat decal north of the raw pile, outside the diggable square, the loader's home on it",
       pad["inScene"] and pad["z1"] < -21.0 and pad["x0"] < -11.2 < pad["x1"] and pad["z0"] < -25.2 < pad["z1"] and pad["y"] < 0.02, str(pad))
    # out of the parking spot backwards, round towards the raw pile: imprints, on the ground they lie on
    G(A, "() => { const ld = window.__goldrush.procObj().loader; ld.place(-11.2, -25.2, Math.PI / 2, 0); if (ld.mode === 'dig') ld.toggleDig(); }")
    G(A, RUN_LDR, {"steps": 200, "fwd": -0.7})
    G(A, RUN_LDR, {"steps": 160, "fwd": -0.7, "turn": 0.6})
    m = G(A, """() => { const pr = window.__goldrush.procObj(), M = pr.loader.marks, w = pr.world; let off = 0;
      for (let i = 0; i < M.used; i++) if (!M.gone[i]) off = Math.max(off, Math.abs(w.groundAt(M.pos[i * 3], M.pos[i * 3 + 2]) - M.pos[i * 3 + 1]));
      return { used: M.used, vis: M.visibleCount, n: M.n, off, name: M.mesh.name, geo: window.__goldrush.info().geometries }; }""")
    ok("AREA the loader's tyres leave imprints where it drove (all four wheels, a fixed pool - nothing new per mark), on the ground there",
       m["vis"] >= 24 and m["used"] <= m["n"] and m["off"] < 0.03, str(m))
    G(A, f"() => {GR}.camLook({{ x: -15.5, y: 6.5, z: -16.5, tx: -11.0, ty: 0, tz: -24.0 }})")
    shot(A, "area_pad_tracks")
    # the ground changes under them (a pile heaped over, the terrain dug): they go - not floating, not buried
    gone = G(A, """() => { const pr = window.__goldrush.procObj(), ld = pr.loader, w = pr.world, src = { heightAt: () => 4 };
      w.heightSources.push(src); ld.update(0.6, null, null); const vis = ld.marks.visibleCount; w.heightSources.splice(w.heightSources.indexOf(src), 1); return vis; }""")
    ok("AREA imprints whose ground changed disappear (checked twice a second while there are any)", gone == 0, f"{m['vis']} -> {gone}")
    # wet ground: the wash plant's lanes, box and tub, the trommel's chute and the stacker - in the sluice's groups
    G(A, "() => { const pr = window.__goldrush.procObj(); pr.sluice.stats.processedMl = Math.max(1, pr.sluice.stats.processedMl); pr._wetSync(); }")
    wet = G(A, "() => { const pr = window.__goldrush.procObj(); return { key: pr._wetKey, g: pr._wet.map((x) => [x.userData.which, x.userData.puddle, x.userData.patches, x.visible]) }; }")
    sl = {(w[1]): w[2] for w in wet["g"] if w[0] == "sluice"}
    ok("AREA wet ground at the wash plant (lane ends, box, tub) and under the oversize chute / stacker - in the sluice's wet groups (still four draws)",
       wet["key"] == "wt" and len(wet["g"]) == 4 and sl.get(False) == 9 and sl.get(True) == 3 and all(w[3] for w in wet["g"]), json.dumps(wet))
    G(A, f"() => {GR}.camLook({{ x: -20.0, y: 13, z: 3.5, tx: -20.0, ty: 0, tz: -3.6, fov: 55 }})")
    shot(A, "area_wet_plant")


# ======================================================================
# the automatic hillside miner
# ======================================================================

MINER_JS = "() => window.__goldrush.miner()"
CHK = "(o) => { const r = window.__goldrush.procObj().autominer.check(o.x, o.z, o.h); return { ok: r.ok, reason: r.reason, recv: r.recv ? r.recv.kind : null, m3: r.m3 }; }"
# heights in the section (its box in the machine's frame) and far outside it (>= 7 m off its edges, diggable ground:
# nearer, the face settles into the cut at its angle of repose - the terrain's own physics, like under the excavator)
BOXH = """(o) => { const g = window.__goldrush, am = g.procObj().autominer, t = g.terrain(), F = am._frame(o.x, o.z, o.h), ins = [], out = [];
  for (let ax = 0.2; ax <= 11.2; ax += 0.3) for (let az = -8.8; az <= 8.8; az += 0.3) {
    const p = F.at(ax, az), y = t.getHeightAt(p.x, p.z), off = Math.hypot(Math.max(0, 1.5 - ax, ax - 3.4), Math.max(0, Math.abs(az) - 1.2));
    if (ax >= 1.45 && ax <= 3.45 && Math.abs(az) <= 1.25) ins.push(+y.toFixed(4));
    else if (off >= 7 && t.inDigArea(p.x, p.z)) out.push(+y.toFixed(4));
  }
  return { ins, out }; }"""
CUTS = """(n) => { const pr = window.__goldrush.procObj(), am = pr.autominer, F = am._frame(), raw = pr.piles.get('raw'), out = { n: 0, ml: 0, ug: 0, pieces: 0, inBox: true, mountainKg: 0 };
  const c = Math.cos(am.heading), s = Math.sin(am.heading);
  for (let k = 0; k < n; k++) {
    const r = am.cutNow();
    if (!r) { if (am.buffer.room < 12000) { raw.dumpFrom(am.buffer, Infinity, raw.site.drop.x, raw.site.drop.z, 0.8); continue; } break; }
    if (!r.ok) continue;
    out.n++; out.ml += r.ml; out.ug += r.ug; out.pieces += r.pieces; out.mountainKg += r.mountainKg || 0;
    const dx = r.at.x - am.x, dz = r.at.z - am.z, ax = c * dx - s * dz, az = s * dx + c * dz;
    if (ax < 1.45 || ax > 3.45 || Math.abs(az) > 1.25) out.inBox = false;
    if (am.buffer.room < 12000) raw.dumpFrom(am.buffer, Infinity, raw.site.drop.x, raw.site.drop.z, 0.8);
  }
  out.status = am.status; return out; }"""


def miner(A):
    fresh(A)
    mine_up(A)
    grant(A, ["autominer"])
    paused(A)
    m0 = G(A, MINER_JS)
    ok("MINER bought: delivered to the claim's north-west corner, not set up - it digs nothing until placed", m0 and not m0["placed"] and m0["status"] == "parked" and math.hypot(m0["x"] + 20.2, m0["z"] + 24.6) < 0.2, json.dumps(m0))
    sp = G(A, "() => window.__goldrush.procObj().autominer.findSpot('intake')")
    good = G(A, CHK, {"x": sp["x"], "z": sp["z"], "h": sp["heading"]})
    flat = G(A, CHK, {"x": 4.0, "z": 14.0, "h": 0.0})
    camp = G(A, CHK, {"x": -15.6, "z": 9.0, "h": -1.5})
    away = G(A, CHK, {"x": sp["x"], "z": sp["z"], "h": sp["heading"] + math.pi})
    up = G(A, CHK, {"x": sp["x"] + 3.0 * math.cos(sp["heading"]), "z": sp["z"] - 3.0 * math.sin(sp["heading"]), "h": sp["heading"]})
    east = G(A, "() => { const am = window.__goldrush.procObj().autominer, out = {}; for (let x = 5; x <= 13; x += 1) for (let z = -15; z <= 3; z += 1) { const r = am.check(x, z, Math.atan2(-(-6 - z), -x)); const k = r.ok ? 'OK' : r.reason.split(' – ')[0]; out[k] = (out[k] || 0) + 1; } return out; }")
    ok("MINER placement: valid at the mountain's foot with a receiver (the intake); invalid with the reason - flat ground, the camp, facing away, up the flank, the far side (no receiver in reach)",
       good["ok"] and good["recv"] == "intake" and not flat["ok"] and not camp["ok"] and not away["ok"] and not up["ok"] and "kein Anschluss" in east and "OK" not in east,
       json.dumps({"good": good, "flat": flat["reason"], "camp": camp["reason"], "away": away["reason"], "up": up["reason"], "east": east})[:400])
    # through the real placement mode: [E] at the delivered machine, the ghost under the crosshair, R / click
    G(A, f"(m) => {{ const g = {GR}; g.pose({{ x: m.x - 2.6, z: m.z, yaw: Math.atan2(-(m.x - (m.x - 2.6)), -(m.z - m.z)), pitch: -0.25 }}); }}", m0)
    st = G(A, f"() => {GR}.stationNow()")
    G(A, f"() => {GR}.useStation()")
    pl0 = G(A, f"() => {GR}.placing()")
    ok("MINER [E] at the delivered machine: the placement mode starts (a ghost, the prompt to cancel)", st and st["id"] == "miner-place" and pl0 is not None, f"{st} {pl0}")
    G(A, f"() => {GR}.setPaused(false)")
    A.keyboard.press("KeyR")
    G(A, f"() => {GR}.setPaused(true)")
    rot1 = G(A, "() => window.__goldrush.placingRot ? window.__goldrush.placingRot() : null")
    # stand behind the spot, the crosshair on its ground, the ghost turned like the found stand
    placed = None
    for d in (2.8, 3.2, 3.6, 4.0):
        G(A, """(o) => { const g = window.__goldrush, c = Math.cos(o.h), s = Math.sin(o.h);
          const px = o.x - c * o.d, pz = o.z + s * o.d, gy = g.heightAt(o.x, o.z), ey = g.heightAt(px, pz) + 1.62;
          g.pose({ x: px, z: pz, yaw: Math.atan2(-(o.x - px), -(o.z - pz)), pitch: Math.atan2(gy - ey, o.d) });
          const P = g.placingObj(); P.rot = o.h - Math.atan2(-(-6 - o.z), 0 - o.x); P.at = null; }""", {"x": sp["x"], "z": sp["z"], "h": sp["heading"], "d": d})
        G(A, f"() => {GR}.walk(0.05, 0, 0)")
        pl = G(A, f"() => {GR}.placing()")
        if pl and pl["ok"]:
            G(A, f"() => {{ const g = {GR}; g.input().digHeld = true; g.walk(0.05, 0, 0); g.input().digHeld = false; g.walk(0.05, 0, 0); }}")
            placed = G(A, MINER_JS)
            break
    ok("MINER the ghost green on the found stand, a click sets it down there (stopped, the intake its receiver); R turns the ghost",
       placed and placed["placed"] and not placed["on"] and placed["recv"] == "intake" and G(A, f"() => {GR}.placing()") is None and rot1 is not None and abs(rot1) > 0.3,
       f"{placed} rot {rot1}")
    if not (placed and placed["placed"]):
        G(A, f"() => {GR}.minerSetup()")
        G(A, "() => window.__goldrush.procObj().autominer.setOn(false)")
    m1 = G(A, MINER_JS)
    o = {"x": m1["x"], "z": m1["z"], "h": m1["heading"]}
    # real cuts inside its section only: the mountain lower there, nowhere else; the batch from there; the ledger, the contract
    h0 = G(A, BOXH, o)
    eco0 = G(A, f"() => {GR}.economy().stats.mountainG")
    c = G(A, CUTS, 60)
    h1 = G(A, BOXH, o)
    eco1 = G(A, f"() => {GR}.economy().stats.mountainG")
    lowered = sum(1 for a, b in zip(h0["ins"], h1["ins"]) if b < a - 0.005)
    moved_out = max([abs(a - b) for a, b in zip(h0["out"], h1["out"])] or [0])
    m2 = G(A, MINER_JS)
    good_l, det = exact(A)
    ok("MINER it cuts the real mountain: 60 bites from its section (each inside the box), the ground there lower, far off it untouched; its gold real (fine gold / pieces of exactly those cells)",
       c["n"] >= 40 and c["inBox"] and c["ml"] > 250000 and lowered >= 3 and moved_out < 0.003 and c["ug"] > 0, f"{c} lowered {lowered} cells, outside max {moved_out:.4f} m")
    ok("MINER the mountain contract counts it exactly (its own mountain grams == the contract's increase) - the ledger exact",
       abs((eco1 - eco0) - (m2["stats"]["mountainG"] - m1["stats"]["mountainG"])) <= 2 and eco1 > eco0 and good_l, f"contract +{eco1 - eco0} g, miner +{m2['stats']['mountainG'] - m1['stats']['mountainG']} g | {det}")
    f1 = A.evaluate(FINDS_JS)
    ok("MINER every piece exactly once (in its belt, the raw pile, ...)", f1["dup"] == 0, str(f1)[:200])
    # its belt -> the intake (on, frames): the conveyor's intake fills from it
    G(A, STILL)
    G(A, "() => { const pr = window.__goldrush.procObj(); pr.devSetIntake(null); }")
    G(A, "() => window.__goldrush.procObj().autominer.setOn(true)")
    G(A, "() => { const am = window.__goldrush.procObj().autominer; for (let i = 0; i < 60 * 40; i++) am.update(1 / 60, null); }")
    m3_ = G(A, MINER_JS)
    intake = G(A, "() => window.__goldrush.procObj().conveyor.volumeMl")
    ok("MINER working (frames): the cycle runs (reach - contact - cut - follow - drop - back), its belt discharges into the intake",
       m3_["stats"]["cuts"] > m2["stats"]["cuts"] and m3_["stats"]["intakeMl"] > 0 and intake > 0, f"cuts {m2['stats']['cuts']} -> {m3_['stats']['cuts']}, into the intake {m3_['stats']['intakeMl']} ml, intake {intake}")
    G(A, f"() => {{ const am = {GR}.procObj().autominer, F = am._frame(), p = F.at(0.4, -4.4), f = F.at(2.2, 0); {GR}.camLook({{ x: p.x, y: am.y + 2.2, z: p.z, tx: f.x, ty: am.y + 0.9, tz: f.z }}); }}")
    shot(A, "miner_working")
    # backpressure: the intake full, the belt stopped -> its belt fills, it waits (nothing lost); room again -> it runs on
    G(A, "() => { const pr = window.__goldrush.procObj(); pr.devConveyorMode('stop'); }")
    G(A, """async () => { const m = await import('/games/goldrush/goldrush-devactions.js'); const pr = window.__goldrush.procObj(); pr.devSetIntake(m.devBatch('paydirt', pr.conveyor.capacityMl - pr.conveyor.volumeMl > 0 ? pr.conveyor.capacityMl : 0)); }""")
    G(A, "() => window.__goldrush.procObj().autominer.sim(600)")
    w = G(A, MINER_JS)
    lw, dw = exact(A)
    G(A, "() => { const pr = window.__goldrush.procObj(); pr.devConveyorMode('on'); pr.sluice.setWater(true); }")
    G(A, "() => window.__goldrush.procObj().tickSim(240)")
    w2 = G(A, MINER_JS)
    ok("MINER backpressure: intake full -> its belt fills, it waits (status 'wartet'), nothing lost; room again -> it starts by itself",
       w["status"] == "waiting" and w["ml"] >= 45000 and w["stats"]["waitS"] > 0 and lw and w2["stats"]["cuts"] > w["stats"]["cuts"] and w2["status"] in ("running", "waiting"),
       f"{w['status']} belt {w['ml']} wait {w['stats']['waitS']} s -> cuts {w['stats']['cuts']} -> {w2['stats']['cuts']} {w2['status']} | {dw}")
    # save / reload: where, the state, the belt's load, the dug section - exactly back; no offline work while closed
    G(A, "() => window.__goldrush.procObj().autominer.setOn(true)")
    s1 = G(A, MINER_JS)
    hb = G(A, BOXH, o)
    reload(A)
    paused(A)
    s2 = G(A, MINER_JS)
    ha = G(A, BOXH, o)
    keep = lambda m: {k: m[k] for k in ("placed", "x", "z", "on", "status", "ml", "ug", "recv")} | {"heading": round(m["heading"], 5), "cuts": m["stats"]["cuts"], "dug": m["stats"]["dugMl"]}
    ok("MINER save / reload: placed where it was, on, its status, the belt's load (gold too), its stats; the dug section stays dug (no terrain respawn)",
       keep(s1) == keep(s2) and hb == ha, json.dumps({k: (keep(s1)[k], keep(s2)[k]) for k in keep(s1) if keep(s1)[k] != keep(s2)[k]})[:300])
    time.sleep(2.5)
    s3 = G(A, MINER_JS)
    ok("MINER no work while paused / closed: the reload brought no offline cuts, 2,5 s paused add none", s3["stats"]["cuts"] == s1["stats"]["cuts"] and s3["stats"]["dugMl"] == s1["stats"]["dugMl"], f"{s1['stats']['cuts']} -> {s3['stats']['cuts']}")
    # hard rock in its section: the head is blocked, it says so
    r = dev(A, "p10.minerRock")
    hr = G(A, MINER_JS)
    cut = G(A, "() => window.__goldrush.procObj().autominer.cutNow()")
    ok("MINER hard rock: only intact stone left in its section -> HARTGESTEIN (the head blocked, nothing cut)", r.get("ok") and hr["status"] == "rock" and not hr["on"] and cut is None, f"{r.get('text')} {hr['status']}")
    # moved: stopped -> [E] at its rear: the placement mode; cancelled it stays; set down elsewhere
    G(A, "() => window.__goldrush.procObj().autominer.setOn(false)")
    am = G(A, MINER_JS)
    G(A, """() => { const g = window.__goldrush, am = g.procObj().autominer, F = am._frame(), p = F.at(-3.2, 0); g.pose({ x: p.x, z: p.z, yaw: Math.atan2(-(am.x - p.x), -(am.z - p.z)), pitch: -0.2 }); }""")
    st = G(A, f"() => {GR}.stationNow()")
    G(A, f"() => {GR}.useStation()")
    on_mode = G(A, f"() => {GR}.placing()") is not None
    G(A, f"() => {GR}.stationNow()")
    G(A, f"() => {GR}.useStation()")
    back = G(A, MINER_JS)
    sp2 = G(A, "(o) => { const am = window.__goldrush.procObj().autominer; let best = null; for (const k of ['intake', null]) { const s = am.findSpot(k); if (s && Math.hypot(s.x - o.x, s.z - o.z) > 1.5) { best = s; break; } } return best; }", {"x": am["x"], "z": am["z"]})
    mv = G(A, "(s) => s ? window.__goldrush.procObj().autominer.place(s.x, s.z, s.heading).ok : false", sp2)
    m5 = G(A, MINER_JS)
    ok("MINER moved: stopped, [E] at its rear starts the placement; cancelled it stays where it was; set down on a new stand (its old section stays dug)",
       st and st["id"] == "miner-move" and on_mode and back["placed"] and back["x"] == am["x"] and back["status"] == "stopped" and mv and m5["stats"]["moves"] == am["stats"]["moves"] + 1,
       f"{st} {on_mode} {back['status']} {sp2}")
    # the section runs out: ABBAUBEREICH ERSCHÖPFT
    o2 = {"x": m5["x"], "z": m5["z"], "h": m5["heading"]}
    hx0 = G(A, BOXH, o2)
    ex = G(A, CUTS, 2500)
    hx1 = G(A, BOXH, o2)
    left = G(A, "() => window.__goldrush.procObj().autominer.survey().m3")
    out_max = max([abs(a - b) for a, b in zip(hx0["out"], hx1["out"])] or [0])
    bud = G(A, "() => { const am = window.__goldrush.procObj().autominer; return { budget: am.budgetMl, dug: am.placeDug }; }")
    ok("MINER its section is limited: every bite inside it, at most its budget (its volume x1,3 - the face above slides in), then ABBAUBEREICH ERSCHÖPFT; 7 m off it nothing changed",
       ex["status"] == "exhausted" and left < 0.05 and bud["dug"] <= bud["budget"] + 12000 and out_max < 0.01 and ex["inBox"],
       f"{ex['n']} bites, {ex['ml'] / 1e6:.2f} m3 (budget {bud['budget'] / 1e6:.2f}), left {left:.2f} m3, 7 m off max {out_max:.4f} m, {ex['status']}")
    G(A, f"() => {{ const am = {GR}.procObj().autominer, F = am._frame(), p = F.at(0.2, -5.2), f = F.at(2.4, 0); {GR}.camLook({{ x: p.x, y: am.y + 3.0, z: p.z, tx: f.x, ty: am.y + 0.6, tz: f.z }}); }}")
    shot(A, "miner_section_done")
    good_l, det = exact(A)
    ok("MINER after all of it the ledger exact (gold in = containers + recovered + tailings)", good_l, det)


def perf(browser, base, user):
    out = {}
    for name, vp in (("desktop", dict(viewport={"width": 1366, "height": 768})), ("phone", dict(PHONE))):
        ctx, A = client(browser, base, user, vp, extra_init=[seeded()])
        fresh(A)
        dev(A, "quick.phase10")
        G(A, f"() => {GR}.procObj().devSetPile('tailOut', null)")
        dev(A, "p10.washRun")
        G(A, f"() => {{ const g = {GR}; g.pose({{ x: -12.0, z: 3.5, yaw: Math.atan2(5.5, 6.0), pitch: -0.18 }}); g.setPaused(false); }}")
        time.sleep(1.5)
        A.evaluate(M6.FRAME_REC)
        time.sleep(3)
        f1 = A.evaluate(M6.FRAME_STOP)
        i1 = G(A, f"() => {GR}.info()")
        out[name] = {"fps": f1["fps"], "p95": f1["p95"], "calls": i1["drawCalls"], "tris": i1["triangles"]}
        print(f"  perf {name}: {out[name]}", flush=True)
        if name == "desktop":
            # a longer run (real frames, the plant and the wash plant working, the loader driving): nothing piles up
            MEM = "() => { if (window.gc) window.gc(); const i = window.__goldrush.info(); return { geo: i.geometries, tex: i.textures, prog: i.programs, heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null }; }"
            DRIVE = """() => { const pr = window.__goldrush.procObj(), ld = pr.loader; for (let i = 0; i < 90; i++) { ld.drive(1 / 60, i < 45 ? 0.8 : -0.8, 0.4); ld.update(1 / 60, null, null); } }"""
            # the quality held where it is (AUTO steps down on a loaded machine - every shader rebuilt once: not a leak)
            G(A, f"() => {GR}.setQuality({GR}.info().level)")
            G(A, DRIVE)                                  # warm-up: the tyre marks' pool is uploaded on its first imprint
            time.sleep(1)
            m0 = G(A, MEM)
            for k in range(4):
                G(A, DRIVE)
                time.sleep(4)
            m1 = G(A, MEM)
            ok("PERF memory / objects stable over a 16-s working run after warm-up (geometries, textures, programs; JS heap within 12 MB)",
               m1["geo"] <= m0["geo"] and m1["tex"] <= m0["tex"] and m1["prog"] <= m0["prog"] and (m0["heap"] is None or m1["heap"] - m0["heap"] <= 12), f"{m0} -> {m1}")
        if name == "phone":
            r = dev(A, "p10.loaderCourse")
            lab = A.evaluate("() => { const b = document.querySelector('.gr-dig-label, [class*=dig] .gr-label'); return document.body.innerText.includes('SCHAUFEL'); }")
            shot(A, "phone_loader")
            ok("PHONE the loader from the phone: its own dig button (SCHAUFEL), the cab view", r.get("ok") and lab, str(r)[:120])
        Q.close(A)
        ctx.close()
    ok("PERF the working mine in view (wash plant running, loader, piles, belt, trommel, stacker) under 250 draw calls, ~60 fps desktop and the emulated phone",
       all(v["calls"] < 250 and v["fps"] >= 50 for v in out.values()), json.dumps(out))


def main():
    engine = sys.argv[sys.argv.index("--browser") + 1] if "--browser" in sys.argv else "chromium"
    want = lambda part: not ONLY or part in ONLY
    proc_, base, tmp = start_server()
    try:
        user = login(base, "WorkingMine")
        with sync_playwright() as p:
            browser = getattr(p, engine).launch(args=GPU_ARGS if engine == "chromium" else [])
            ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
            for part, fn in (("barrow", barrow), ("tailings", tailings), ("upgrades", upgrades), ("jump", jump), ("work", work), ("prospect", prospect),
                             ("piles", piles), ("loader", loader), ("plant", plant), ("wash", wash), ("chain", chain), ("save", save), ("area", area), ("miner", miner), ("nuggets", nuggets), ("p1001", patch1001), ("dev", devtools)):
                if not want(part):
                    continue
                try:
                    fn(A)
                except Exception as e:                           # a part that breaks must not hide the others
                    import traceback
                    where = " / ".join(ln.strip() for ln in traceback.format_exc().splitlines() if "workingmine" in ln)
                    ok(f"{part}: ran without an exception", False, repr(e)[:200] + " @ " + where[-220:])
            errs = errors(A)
            ok(f"no page errors ({engine})", not errs, str(errs[:3]))
            Q.close(A)
            ctx.close()
            if want("perf") and engine == "chromium":
                try:
                    perf(browser, base, user)
                except Exception as e:
                    ok("perf: ran without an exception", False, repr(e)[:300])
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
