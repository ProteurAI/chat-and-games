"""GoldRush Earth 2.0C visual QA: the rocks (pile boulders, scenery clusters, outcrops, pebbles) up close and in context.

  capture   one mine (seed 4242), HIGH, loop paused, `camLook` shots:
              boulder1..3   the pile's gameplay boulders (the ones you crack with the pick), close
              dug           the first boulder with the ground dug away around it (it must sink / stay embedded, not float)
              clusterA/B/C  scenery clusters near the camp (one boulder, satellites, a trail of fragments)
              outcrop       the bedded slabs on a flank, flank: a wider look at them
              wide          wide views over the claim
              wet           the wash place and the sluice with their wet ground (real sources)
  compare   BEFORE | AFTER side by side (--root OLD_REV_DIR runs the capture on an old revision)

    python tests/e2e/goldrush_rockqa.py capture --out DIR --tag after [--root OLD_REV_DIR]
    python tests/e2e/goldrush_rockqa.py compare --out DIR [--a before --b after]
"""

import json
import math
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
import kopfkicker_e2e  # noqa: E402
from goldrush_e2e import GPU_ARGS, errors  # noqa: E402
import goldrush_quality_e2e as Q  # noqa: E402
from goldrush_visualqa import open_mine, dev, HIDE_UI, STATS  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
G, GR = Q.G, "window.__goldrush"
ARG = lambda k, d: type(d)(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d
if "--root" in sys.argv:
    kopfkicker_e2e.ROOT = Path(sys.argv[sys.argv.index("--root") + 1])

JS_LOOK = """([x, y, z, tx, ty, tz, fov]) => {
  const w = window.__goldrush, g = w.game();
  g.effects.clear();
  g.world.earth.update(g.terrain.clock, 1.0);
  return w.camLook({ x, y, z, tx, ty, tz, fov });
}"""
JS_ROCKS = """() => { const g = window.__goldrush.game(); return g.rocks.rocks.map((r) => ({ x: r.x, y: r.y, z: r.z, r: r.r })); }"""
JS_OUT = """() => { const g = window.__goldrush.game(), w = g.world, o = w.outcrops && w.outcrops.find((q) => !q.gone);
  if (!o || !o.mesh) return null;
  const mt = o.mesh.matrix.clone(); o.mesh.getMatrixAt(o.slot, mt); const e = mt.elements; const n = g.terrain.getNormalAt(e[12], e[14]); return { x: e[12], y: e[13], z: e[14], n: [n.x, n.y, n.z] }; }"""
JS_WETSYNC = """() => { const g = window.__goldrush.game(); if (g.processing._wetSync) g.processing._wetSync(); for (let i = 0; i < 30; i++) g.world.earth.update(g.terrain.clock, 0.6); }"""


def look(A, d, name, c, t, fov=55):
    G(A, JS_LOOK, [c[0], c[1], c[2], t[0], t[1], t[2], fov])
    time.sleep(0.3)
    A.screenshot(path=str(d / f"{name}.png"))
    st = G(A, STATS)
    f = st.get("frame") or {}
    return {"calls": f.get("calls"), "tris": f.get("tris")}


def around(p, dist, elev, az):
    e, a = math.radians(elev), math.radians(az)
    return [p[0] + dist * math.cos(e) * math.sin(a), p[1] + dist * math.sin(e), p[2] + dist * math.cos(e) * math.cos(a)]


def capture():
    out, tag, size = Path(ARG("--out", "vqa")), ARG("--tag", "after"), ARG("--size", "1600x900")
    d = out / tag
    d.mkdir(parents=True, exist_ok=True)
    meta = {"tag": tag, "views": {}}
    proc, base, tmp = start_server()
    try:
        user = login(base, "VisualQA")
        with sync_playwright() as p:
            b = p.chromium.launch(args=GPU_ARGS)
            ctx, A = open_mine(b, base, user, size, quality=ARG("--quality", "high"))
            G(A, f"() => {GR}.grant('shovel')")
            G(A, HIDE_UI)
            G(A, f"() => {GR}.setPaused(true)")
            rocks = G(A, JS_ROCKS)
            meta["rocks"] = rocks
            for i, r in enumerate(rocks[:3]):
                tgt = [r["x"], r["y"] + 0.3 * r["r"], r["z"]]
                meta["views"][f"boulder{i + 1}"] = look(A, d, f"01_boulder{i + 1}", around(tgt, 2.6 + r["r"], 22, 20 + 70 * i), tgt)
            # dig the ground away around the first boulder with the real stroke path, then look again
            r = rocks[0]
            G(A, f"() => {GR}.equipNow('shovel')")
            for k in range(14):
                ang = k * 0.9
                x, z = r["x"] + math.cos(ang) * (r["r"] * 1.1 + 0.15), r["z"] + math.sin(ang) * (r["r"] * 1.1 + 0.15)
                sx, sz = x + 1.3 * math.cos(ang), z + 1.3 * math.sin(ang)
                yaw = math.atan2(-(x - sx), -(z - sz))
                G(A, f"(a) => {GR}.aimAt(a)", {"x": sx, "z": sz, "yaw": yaw, "pitch": -0.7})
                G(A, f"() => {GR}.act({{ tool: 'shovel' }})")
            G(A, f"() => {{ const g = {GR}.game(); g.rocks.settleIn(-30, -30, 30, 30); }}")
            r1 = G(A, JS_ROCKS)[0]
            tgt = [r1["x"], r1["y"] + 0.3 * r1["r"], r1["z"]]
            meta["views"]["dug"] = look(A, d, "02_dug_rock", around(tgt, 2.4 + r1["r"], 20, 20), tgt)
            meta["dug_rock"] = {"before": r, "after": r1}
            # scenery clusters
            for name, (x, z) in {"clusterA": (9.5, 17.5), "clusterB": (-9, 18.2), "clusterC": (22.2, 7.5)}.items():
                gy = G(A, f"([x, z]) => {GR}.game().world.groundHeightAt(x, z)", [x, z])
                tgt = [x, gy + 0.3, z]
                meta["views"][name] = look(A, d, f"03_{name}", around(tgt, 5.0, 14, 200 if x > 0 else 160), tgt, 50)
            o = G(A, JS_OUT)
            if o:
                tgt = [o["x"], o["y"], o["z"]]
                n = o["n"]
                side = [-n[2], 0, n[0]]
                sl = math.hypot(side[0], side[2]) or 1
                cam1 = [tgt[0] + n[0] * 1.3 + side[0] / sl * 0.7, tgt[1] + n[1] * 1.3, tgt[2] + n[2] * 1.3 + side[2] / sl * 0.7]
                cam2 = [tgt[0] + n[0] * 3.6 + side[0] / sl * 2.0, tgt[1] + n[1] * 3.6, tgt[2] + n[2] * 3.6 + side[2] / sl * 2.0]
                meta["views"]["outcrop"] = look(A, d, "04_outcrop", cam1, tgt)
                meta["views"]["flank"] = look(A, d, "05_flank", cam2, tgt, 55)
            meta["views"]["wide"] = look(A, d, "06_wide", [0.5, 2.4, 14.5], [0, 1.2, -4], 62)
            meta["views"]["wide2"] = look(A, d, "06_wide_east", [-4, 2.2, 14], [16, 0.8, 4], 62)
            # wet ground at the wash place / sluice (real sources)
            dev(A, "vo.bm.sluice")
            G(A, f"() => {GR}.setPaused(true)")
            G(A, JS_WETSYNC)
            meta["views"]["wet"] = look(A, d, "07_wet_sluice", [-17.5, 2.6, 5.5], [-19.5, 0, -0.5], 60)
            meta["views"]["wet3"] = look(A, d, "07_wet_close", [-15.4, 1.5, 3.2], [-17.6, 0.0, 2.9], 60)
            meta["views"]["wet2"] = look(A, d, "07_wet_wash", [-13.5, 2.2, 5.5], [-17, 0, 2.5], 60)
            meta["errors"] = errors(A)[:6]
            b.close()
    finally:
        proc.terminate()
    json.dump(meta, open(d / "meta.json", "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    print("errors:", meta["errors"])
    print(meta["views"])


def compare():
    from PIL import Image, ImageDraw
    out, a, bb = Path(ARG("--out", "vqa")), ARG("--a", "before"), ARG("--b", "after")
    (out / "compare").mkdir(parents=True, exist_ok=True)
    for f in sorted((out / a).glob("*.png")):
        g = out / bb / f.name
        if not g.exists():
            continue
        A, B = Image.open(f).convert("RGB"), Image.open(g).convert("RGB")
        w, h = A.size
        s = Image.new("RGB", (w * 2 + 8, h + 30), (20, 20, 20))
        s.paste(A, (0, 30)); s.paste(B.resize((w, h)), (w + 8, 30))
        dr = ImageDraw.Draw(s)
        dr.text((8, 8), f"{a.upper()}  {f.stem}", fill=(255, 255, 255)); dr.text((w + 16, 8), bb.upper(), fill=(255, 255, 255))
        s.save(out / "compare" / f.name)
        print("pair", f.name)


if __name__ == "__main__":
    {"capture": capture, "compare": compare}[sys.argv[1] if len(sys.argv) > 1 else "capture"]()
