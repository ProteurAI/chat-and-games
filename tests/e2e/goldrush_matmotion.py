"""GoldRush Material in Motion 1A: visual + conservation QA of loose material in motion.

Scenes (each steps real frames, 1/60 s, through the game's own _frame):
  shovel   scoop -> carry -> tip into a bucket beside you (the blade's load, the bucket waits for it)
  bucket   empty / part full / full bucket in hand, then tipped into the sluice hopper (stream, level, stop)
  barrow   a loaded barrow tipped into the hopper
  block    a hopper that is nearly full: partial pour, a full one: no pour

Per frame the page reports: the drawn level of the bucket (shown vs truth), the flow's audit (started == landed + in flight),
particles in flight, draw calls / triangles. The script turns that into checks (no duplicate mass, nothing left after the
stream, no pour without a transfer) and writes filmstrips + GIFs.

    python tests/e2e/goldrush_matmotion.py --out DIR --tag after [--only bucket,shovel] [--quality medium] [--size 1280x720]
"""

import json
import math
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
import qa_safety  # noqa: E402,F401  (headless; no cursor capture)
from goldrush_e2e import GPU_ARGS, errors  # noqa: E402
import goldrush_quality_e2e as Q  # noqa: E402
from goldrush_visualqa import open_mine, dev, HIDE_UI  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
G, GR = Q.G, "window.__goldrush"
ARG = lambda k, d: type(d)(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d
DT = 1 / 60

# one simulated frame, then what the checks need
STEP = """([n, dt]) => {
  const g = window.__goldrush.game(), pr = g.processing, out = [];
  for (let i = 0; i < n; i++) {
    window.__goldrush.stepFrames(1, dt);
    const b = pr.bucket, V = pr.vis, f = pr.flow, a = f.audit(), w = pr.barrow;
    out.push({
      truthMl: b ? b.batch.volumeMl : 0, keep: V.bucket.keep.ml, owe: V.bucket.owe.ml, keepW: V.barrow.keep.ml, oweW: V.barrow.owe.ml,
      hopMl: pr.sluice ? pr.sluice.hopper.batch.volumeMl : 0, barMl: w ? w.batch.volumeMl : 0,
      flying: f.stats.flying, active: f.stats.active, peak: f.stats.peak, audit: a, pourK: pr.pourK, slot: !!pr._pourSlot,
      fillVis: b ? pr.handBucket.userData.load.surface.visible : false, worldFill: b ? pr.worldBucket.userData.load.surface.visible : false,
      info: { calls: g.renderer.info.render.calls, tris: g.renderer.info.render.triangles },
    });
  }
  return out; }"""


def shot(A, d, name):
    f = d / f"{name}.png"
    A.screenshot(path=str(f))
    return f


def film(d, name, shots, cols=8, tw=300, crop=(0.0, 0.15, 1.0, 1.0)):
    from PIL import Image, ImageDraw
    if not shots:
        return
    ims = []
    for i, f, label in shots:
        im = Image.open(f).convert("RGB")
        w, h = im.size
        im = im.crop((int(crop[0] * w), int(crop[1] * h), int(crop[2] * w), int(crop[3] * h)))
        im = im.resize((tw, int(tw * im.size[1] / im.size[0])))
        ims.append((i, label, im))
    th = ims[0][2].size[1]
    rows = (len(ims) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tw, rows * (th + 14)), (14, 14, 14))
    for k, (i, label, im) in enumerate(ims):
        x, y = (k % cols) * tw, (k // cols) * (th + 14)
        sheet.paste(im, (x, y + 14))
        ImageDraw.Draw(sheet).text((x + 3, y + 1), f"{i} {label}", fill=(255, 255, 255))
    sheet.save(d / f"film_{name}.png")
    gif = [im.resize((tw * 2, th * 2)) for _, _, im in ims]
    gif[0].save(d / f"anim_{name}.gif", save_all=True, append_images=gif[1:], duration=int(1000 * DT * 3), loop=0)
    for _, f, _ in shots:
        try:
            os.remove(f)
        except OSError:
            pass


SETUP = """() => {
  const w = window.__goldrush, g = w.game(), pr = g.processing;
  w.grant('shovel');
  if (!pr.bucket) pr.grant('bucket');
  if (!pr.barrow) pr.grant('wheelbarrow');
  if (!pr.sluice) { pr.grant('sluice'); pr.devInstallSluice(); }
  g._stationSig = null;
  return { sluice: !!pr.sluice, feed: pr._slSpots().feed, bucket: !!pr.bucket, barrow: !!pr.barrow };
}"""

# stand at the sluice's feed spot facing the hopper, bucket in the hands holding `ml` of dirt (comp = the dug ground's)
CARRY = """([ml, mat]) => {
  const w = window.__goldrush, g = w.game(), pr = g.processing, f = pr._slSpots().feed, h = pr._slSpots().hopper;
  pr.devSetBucket(null);
  if (ml > 0) {
    const mk = (pr._batch ? pr._batch.bind(pr) : null);
    const b = mk('raw'); const comp = [0, 0, 0, 0]; comp[mat] = Math.round(ml * [1.3, 1.6, 1.75, 2.6][mat]);
    b.volumeMl = ml; b.comp = comp;
    pr.devSetBucket(b);
  }
  pr.bucket.carried = true; pr._sync && pr._sync(); pr._fills();
  const p = g.player; p.x = f.x; p.z = f.z; p.yaw = Math.atan2(-(h.x - f.x), -(h.z - f.z)); p.pitch = -0.32; p.vx = p.vz = 0; p.y = g.world.groundAt(p.x, p.z) + 1.62;
  g._updateCamera(); g._stationTick(0.6); g.render();
  return { station: g.station ? g.station.id : null, interaction: pr.interaction(g.player) };
}"""


def run_bucket(A, d, rows_out, ml_list=(2500, 6000, 10000), mat=0):
    res = {}
    for ml in ml_list:
        name = f"bucket_{ml}"
        info = G(A, CARRY, [ml, mat])
        for _ in range(12):
            G(A, STEP, [1, DT])
        shots = []
        k = 0
        rows = []
        before = G(A, f"() => {{ const b = {GR}.game().processing.bucket; return b.batch.volumeMl; }}")
        sluice0 = G(A, f"() => {GR}.game().processing.sluice.hopper.batch.volumeMl")
        r = G(A, f"() => {GR}.procAct('bucket-hopper')")
        for i in range(150):
            row = G(A, STEP, [1, DT])[0]
            rows.append(row)
            if i % 3 == 0:
                shots.append((i, shot(A, d, f"{name}_{k:03d}"), f"v{row['truthMl'] + row['keep'] - row['owe']:.0f} fly{row['flying']}"))
                k += 1
            if i > 20 and not row["slot"] and row["flying"] == 0 and row["pourK"] == 0:
                break
        film(d, name, shots)
        last = rows[-1]
        res[name] = {"info": info, "act": r, "before": before, "sluice0": sluice0, "frames": len(rows), "peakFlying": max(x["flying"] for x in rows),
                     "audit": last["audit"], "keepEnd": last["keep"], "oweEnd": last["owe"], "hopEnd": last["hopMl"], "truthEnd": last["truthMl"],
                     "maxShownMinusTruth": max(x["truthMl"] + x["keep"] - x["owe"] - x["truthMl"] for x in rows)}
        rows_out[name] = rows
    return res


# ---------------------------------------------------------------- shovel -> bucket (the blade's load, the bucket waits for it)
FACE = """() => {
  const w = window.__goldrush, g = w.game(), pr = g.processing, p = g.player;
  w.equipNow('shovel'); pr.devSetBucket(null); 
  const b = pr.bucket; b.carried = false;
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
  b.x = p.x + fx * 1.15 + rx * 0.5; b.z = p.z + fz * 1.15 + rz * 0.5; b.ry = p.yaw; pr._sync && pr._sync(); pr._fills();
  let used = null;
  for (const pt of [-0.62, -0.55, -0.48, -0.4, -0.3, -0.2]) { p.pitch = pt; g._updateCamera(); g._aim(); if (g.target) { used = pt; break; } }
  g.render();
  return { target: !!g.target, dist: g.target ? g.target.distance : null, pitch: used };
}"""


def run_shovel(A, d, rows_out, strokes=5):
    dev(A, "vo.bm.face")
    G(A, f"() => {GR}.setPaused(true)")
    G(A, HIDE_UI)
    info = G(A, FACE)
    cyc0 = G(A, f"() => {GR}.tools().cycles")
    G(A, f"() => {{ {GR}.input().digHeld = true; }}")
    rows, shots, k = [], [], 0
    for i in range(700):
        row = G(A, STEP, [1, DT])[0]
        v = G(A, f"() => {{ const g = {GR}.game(); return {{ cyc: g.tools.cycles, phase: g.tools.phase, state: g.tools.state, load: g.hands.load, loadT: g.hands.loadT }}; }}")
        row.update(v)
        rows.append(row)
        if i % 3 == 0:
            shots.append((i, shot(A, d, f"shovel_{k:03d}"), f"{row['state']}/{row['phase']} t{row['truthMl']} o{row['owe']:.0f} L{row['load']:.2f}"))
            k += 1
        if row["cyc"] - cyc0 >= strokes:
            break
    G(A, f"() => {{ {GR}.input().digHeld = false; }}")
    for i in range(120):
        row = G(A, STEP, [1, DT])[0]
        rows.append(row)
        if i % 3 == 0:
            shots.append((len(rows), shot(A, d, f"shovel_{k:03d}"), f"end t{row['truthMl']} o{row['owe']:.0f}"))
            k += 1
    film(d, "shovel", shots, crop=(0.0, 0.1, 1.0, 1.0))
    rows_out["shovel"] = rows
    last = rows[-1]
    peak_owe = max(r["owe"] for r in rows)
    # the drawn level (truth - owe) must never exceed the truth, never go negative, and be equal to it at the end
    neg = min(r["truthMl"] - r["owe"] for r in rows)
    return {"info": info, "strokes": strokes, "truthEnd": last["truthMl"], "oweEnd": last["owe"], "peakOwe": peak_owe, "minShown": neg,
            "audit": last["audit"], "frames": len(rows)}


# ---------------------------------------------------------------- barrow -> hopper, and the blocked / partial hopper
BARROW = """([ml, hopFill]) => {
  const w = window.__goldrush, g = w.game(), pr = g.processing, sl = pr.sluice, br = pr.barrow;
  const mk = (ml) => { const b = pr._batch('raw'); b.volumeMl = ml; b.comp = [Math.round(ml * 1.3), 0, 0, 0]; return b; };
  pr.devSetBucket(null);
  pr.devSetBarrow && pr.devSetBarrow(mk(ml));
  if (!pr.devSetBarrow) { br.batch.absorb(mk(ml - br.batch.volumeMl)); }
  sl.hopper.batch.volumeMl = hopFill; sl.hopper.batch.comp = [Math.round(hopFill * 1.3), 0, 0, 0];
  return { barrow: br.batch.volumeMl, hop: sl.hopper.batch.volumeMl, cap: sl.capacityMl };
}"""


def run_block(A, d, rows_out):
    res = {}
    # bucket into a hopper that has room for only part of it, and into a full one
    for name, hop in (("partial", None), ("full", "full")):
        G(A, f"() => {GR}.game().processing.flow.flush()")
        info = G(A, CARRY, [10000, 0])
        cap = G(A, f"() => {GR}.game().processing.sluice.capacityMl")
        fill = cap - 4000 if hop is None else cap
        G(A, f"""(f) => {{ const pr = {GR}.game().processing, h = pr.sluice.hopper.batch; h.volumeMl = f; h.comp = [Math.round(f * 1.3), 0, 0, 0]; pr._fills(); {GR}.game()._stationSig = null; }}""", fill)
        st = G(A, f"() => {{ {GR}.game()._stationTick(0.6); const i = {GR}.game().processing.interaction({GR}.game().player); return i; }}")
        r = G(A, f"() => {GR}.procAct('bucket-hopper')")
        rows = []
        shots = []
        for i in range(120):
            row = G(A, STEP, [1, DT])[0]
            rows.append(row)
            if i % 4 == 0:
                shots.append((i, shot(A, d, f"block_{name}_{i:03d}"), f"v{row['truthMl'] + row['keep']:.0f} fly{row['flying']}"))
        film(d, f"block_{name}", shots)
        res[name] = {"interaction": st, "act": r, "peakFlying": max(x["flying"] for x in rows), "truthEnd": rows[-1]["truthMl"], "keepEnd": rows[-1]["keep"],
                     "audit": rows[-1]["audit"], "hopperEnd": rows[-1]["hopMl"], "cap": cap, "bucketLeft": rows[-1]["truthMl"]}
        rows_out[f"block_{name}"] = rows
    return res


BARROW_SET = """([ml]) => {
  const w = window.__goldrush, g = w.game(), pr = g.processing, h = pr._slSpots().hopper;
  pr.devSetBucket(null);
  const b = pr._batch('raw'); b.volumeMl = ml; b.comp = [Math.round(ml * 1.3), Math.round(ml * 0.3), 0, 0];
  pr.devSetBarrow(b);
  w.procBarrowPlace(h.x, h.z - 1.75, Math.PI);
  pr.sluice.hopper.batch.volumeMl = 0; pr.sluice.hopper.batch.comp = [0, 0, 0, 0];
  g._stationSig = null;
  return { barrow: pr.barrow.batch.volumeMl };
}"""


def run_barrow(A, d, rows_out, ml=40000):
    G(A, f"() => {GR}.game().processing.flow.flush()")
    info = G(A, BARROW_SET, [ml])
    G(A, f"() => {{ const b = {GR}.proc().barrow; {GR}.pose({{ x: b.x + Math.sin(b.yaw) * 2.15, z: b.z + Math.cos(b.yaw) * 2.15, yaw: b.yaw, pitch: -0.3 }}); }}")
    G(A, f"() => {GR}.procAct('barrow-take')")
    G(A, f"() => {GR}.walk(2.6, 0, 1)")
    inter = G(A, f"() => {GR}.proc().interaction")
    before = G(A, f"() => {GR}.game().processing.barrow.batch.volumeMl")
    G(A, f"() => {GR}.stationNow()")
    used = G(A, f"() => {GR}.useStation()")
    rows, shots = [], []
    for i in range(110):
        row = G(A, STEP, [1, DT])[0]
        row["barMl"] = row["barMl"]
        rows.append(row)
        if i % 3 == 0:
            shots.append((i, shot(A, d, f"barrow_{i:03d}"), f"bar{row['barMl']} keep{row['keepW']:.0f} hop{row['hopMl']} fly{row['flying']}"))
    film(d, "barrow", shots)
    rows_out["barrow"] = rows
    last = rows[-1]
    return {"info": info, "interaction": inter, "used": used, "before": before, "barEnd": last["barMl"], "hopEnd": last["hopMl"], "keepEnd": last["keepW"], "peakFlying": max(r["flying"] for r in rows),
            "audit": last["audit"], "peakKeep": max(r["keepW"] for r in rows)}


# ---------------------------------------------------------------- perf: the cost of a pour (frame time, draw calls, triangles, heap)
PERF_STEP = """([n, dt]) => {
  const w = window.__goldrush, g = w.game(), r = g.renderer, out = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    w.stepFrames(1, dt);
    const ms = performance.now() - t0, f = g.processing.flow;
    out.push({ ms, calls: r.info.render.calls, tris: r.info.render.triangles, geos: r.info.memory.geometries, tex: r.info.memory.textures, fly: f ? f.stats.flying : 0, slot: !!g.processing._pourSlot,
      heap: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null });
  }
  return out; }"""


def run_perf(A, d, rows_out, rounds=3):
    res = {}
    idle, pour = [], []
    G(A, "() => { window.gc && window.gc(); }")
    for r in range(rounds):
        G(A, CARRY, [10000, 0])
        idle += G(A, PERF_STEP, [40, DT])[5:]
        G(A, f"() => {GR}.procAct('bucket-hopper')")
        rows = G(A, PERF_STEP, [150, DT])
        pour += [x for x in rows if x["slot"] or x["fly"] > 0]
        G(A, f"() => {GR}.game().processing.sluice.hopper.batch.volumeMl = 0")
    def stat(rows, k):
        v = sorted(x[k] for x in rows)
        return {"med": round(v[len(v) // 2], 2), "p95": round(v[int(len(v) * 0.95)], 2), "max": round(v[-1], 2)} if v else None
    for k in ("ms", "calls", "tris", "geos", "tex"):
        res[k] = {"idle": stat(idle, k), "pour": stat(pour, k)}
    res["heap"] = {"idle": stat(idle, "heap"), "pour": stat(pour, "heap")}
    res["pourFrames"] = len(pour)
    return res


def main():
    out, tag, quality, size = Path(ARG("--out", "matmotion")), ARG("--tag", "after"), ARG("--quality", "medium"), ARG("--size", "1280x720")
    only = ARG("--only", "bucket").split(",")
    d = out / tag
    d.mkdir(parents=True, exist_ok=True)
    proc, base, tmp = start_server()
    meta = {"tag": tag, "quality": quality, "size": size, "results": {}}
    rows_out = {}
    try:
        user = login(base, "VisualQA")
        with sync_playwright() as p:
            b = p.chromium.launch(args=GPU_ARGS)
            ctx, A = open_mine(b, base, user, size, quality=quality)
            G(A, HIDE_UI)
            print("setup", G(A, SETUP))
            G(A, f"() => {GR}.setPaused(true)")
            if "bucket" in only:
                meta["results"]["bucket"] = run_bucket(A, d, rows_out)
            if "block" in only:
                meta["results"]["block"] = run_block(A, d, rows_out)
            if "perf" in only:
                meta["results"]["perf"] = run_perf(A, d, rows_out)
            if "barrow" in only:
                meta["results"]["barrow"] = run_barrow(A, d, rows_out)
            if "shovel" in only:
                meta["results"]["shovel"] = run_shovel(A, d, rows_out)
            meta["errors"] = errors(A)[:8]
            print(json.dumps(meta["results"], indent=1)[:4000])
            print("errors:", meta["errors"])
            b.close()
    finally:
        proc.terminate()
    json.dump(meta, open(d / "meta.json", "w", encoding="utf-8"), indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
