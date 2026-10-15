"""GoldRush Earth 2.0C1 smoke: wetness (source -> wet -> dry, terrain and rocks), rock level-of-detail popping, dark multi-dig.

  wet     the wash place's sources fill the wet map (rise), the ground there darkens without going black, a source put on a
          pile boulder darkens the rock, and with the sources gone the map dries (50 % / 90 % times)
  lod     one scenery cluster seen from a fixed camera at its three levels: the picture difference between neighbouring levels
          is the size of the pop (mean absolute grey difference over the whole frame, and over the cluster's box)
  dark    the same spot dug six times: the darkest pixels of the crater (1st / 5th percentile, share of near-black pixels)

    python tests/e2e/goldrush_c1_smoke.py [--out DIR]
"""

import io
import json
import math
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from goldrush_e2e import GPU_ARGS, errors  # noqa: E402
import goldrush_quality_e2e as Q  # noqa: E402
from goldrush_visualqa import open_mine, dev, HIDE_UI  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
G, GR = Q.G, "window.__goldrush"
ARG = lambda k, d: type(d)(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d

JS_LOOK = """([x, y, z, tx, ty, tz, fov]) => {
  const w = window.__goldrush, g = w.game();
  g.effects.clear();
  g.world.earth.update(g.terrain.clock, 1.0);
  return w.camLook({ x, y, z, tx, ty, tz, fov });
}"""
JS_WET = """() => { const e = window.__goldrush.game().world.earth; let mx = 0, n = 0; for (const v of e.wetData) { if (v > mx) mx = v; if (v > 20) n++; } return { max: mx, wet: n, sources: e.wetSources.length }; }"""
JS_STEP = """(s) => { const g = window.__goldrush.game(), e = g.world.earth; for (let t = 0; t < s; t += 0.5) e.update(g.terrain.clock, 0.5); return true; }"""


def grey(png):
    from PIL import Image
    import numpy as np
    return np.asarray(Image.open(io.BytesIO(png)).convert("L")).astype(float)


def shot(A):
    time.sleep(0.25)
    return A.screenshot()


def around(p, dist, elev, az):
    e, a = math.radians(elev), math.radians(az)
    return [p[0] + dist * math.cos(e) * math.sin(a), p[1] + dist * math.sin(e), p[2] + dist * math.cos(e) * math.cos(a)]


def main():
    out = Path(ARG("--out", "c1smoke"))
    out.mkdir(parents=True, exist_ok=True)
    res = {}
    proc, base, tmp = start_server()
    try:
        user = login(base, "VisualQA")
        with sync_playwright() as p:
            b = p.chromium.launch(args=GPU_ARGS)
            ctx, A = open_mine(b, base, user, "1600x900", quality="high")
            G(A, f"() => {GR}.grant('shovel')")
            G(A, HIDE_UI)
            G(A, f"() => {GR}.setPaused(true)")

            # ---------------- dark multi-dig: six scoops at one spot
            import numpy as np
            G(A, f"() => {GR}.equipNow('shovel')")
            rep = {"x": -6.0, "z": 6.0, "yaw": 0.0, "pitch": -0.9}
            hit = None
            for _ in range(6):
                G(A, f"(a) => {GR}.aimAt(a)", rep)
                r = G(A, f"() => {{ const a = {GR}.aim(); {GR}.act({{ tool: 'shovel' }}); return a; }}")
                hit = [r["x"], r["y"], r["z"]] if r and r.get("x") is not None else hit
            cam = around(hit, 1.0, 36, 30)
            G(A, JS_LOOK, [cam[0], cam[1], cam[2], hit[0], hit[1], hit[2], 50])
            png = shot(A)
            (out / "dark_repeat.png").write_bytes(png)
            g = grey(png)
            h, w = g.shape
            c = g[int(h * 0.22):int(h * 0.55), int(w * 0.28):int(w * 0.64)]
            res["dark"] = {"p1": float(np.percentile(c, 1)), "p5": float(np.percentile(c, 5)), "min": float(c.min()), "mean": float(c.mean()), "share_below_8": float((c < 8).mean())}

            if "--dark" in sys.argv:
                print(json.dumps(res)); b.close(); return
            # ---------------- wetness
            dev(A, "vo.bm.sluice")
            G(A, f"() => {GR}.setPaused(true)")
            G(A, "() => { const e = window.__goldrush.game().world.earth; e.setWetSources([]); return true; }")
            G(A, JS_STEP, 400)
            res["wet_dry_start"] = G(A, JS_WET)
            ground = G(A, f"() => {GR}.game().world.groundHeightAt(-17.6, 2.9)")
            camw = [-15.4, 1.5, 3.2]
            G(A, JS_LOOK, [*camw, -17.6, ground, 2.9, 60])
            dry_png = shot(A)
            G(A, "() => { const g = window.__goldrush.game(); g.processing._wetSync(); return true; }")
            rise = []
            for s in (1, 3, 10):
                G(A, JS_STEP, s if s == 1 else (s - (1 if s == 3 else 3)))
                rise.append({"s": s, **G(A, JS_WET)})
            res["wet_rise"] = rise
            G(A, JS_LOOK, [*camw, -17.6, ground, 2.9, 60])
            wet_png = shot(A)
            (out / "wet_wash_dry.png").write_bytes(dry_png)
            (out / "wet_wash_wet.png").write_bytes(wet_png)
            gd, gw = grey(dry_png), grey(wet_png)
            res["wet_ground"] = {"mean_dry": float(gd.mean()), "mean_wet": float(gw.mean()), "wet_p1": float(np.percentile(gw, 1)), "dry_p1": float(np.percentile(gd, 1)), "share_below_6_wet": float((gw < 6).mean()), "share_below_6_dry": float((gd < 6).mean())}
            # a source on a pile boulder: the rock darkens
            rock = G(A, f"() => {{ const r = {GR}.game().rocks.rocks[0]; return {{ x: r.x, y: r.y, z: r.z, r: r.r }}; }}")
            tgt = [rock["x"], rock["y"] + 0.3 * rock["r"], rock["z"]]
            cr = around(tgt, 2.2 + rock["r"], 25, 30)
            G(A, "() => { const e = window.__goldrush.game().world.earth; e.setWetSources([]); return true; }")
            G(A, JS_STEP, 300)
            G(A, JS_LOOK, [*cr, *tgt, 55])
            r_dry = grey(shot(A))
            (out / "wet_rock_dry.png").write_bytes(shot(A))
            G(A, "([x, z]) => { const g = window.__goldrush.game(), e = g.world.earth; e.setWetSources([{ x, z, r: 1.6, level: 1 }]); return true; }", [rock["x"], rock["z"]])
            G(A, JS_STEP, 20)
            G(A, JS_LOOK, [*cr, *tgt, 55])
            png = shot(A)
            (out / "wet_rock_wet.png").write_bytes(png)
            r_wet = grey(png)
            hh, ww = r_dry.shape
            box = (slice(int(hh * 0.3), int(hh * 0.7)), slice(int(ww * 0.3), int(ww * 0.7)))
            res["wet_rock"] = {"centre_mean_dry": float(r_dry[box].mean()), "centre_mean_wet": float(r_wet[box].mean()), "wet_p1": float(np.percentile(r_wet[box], 1))}
            # drying: the sources gone
            G(A, "() => { const e = window.__goldrush.game().world.earth; e.setWetSources([]); return true; }")
            peak = G(A, JS_WET)["max"]
            dry = []
            t = 0
            t50 = t90 = None
            while t < 400:
                G(A, JS_STEP, 10)
                t += 10
                m = G(A, JS_WET)["max"]
                if t50 is None and m <= peak * 0.5: t50 = t
                if t90 is None and m <= peak * 0.1: t90 = t
                if t in (60, 120, 240):
                    dry.append({"s": t, "max": m})
            res["wet_dry"] = {"peak": peak, "t50": t50, "t90": t90, "samples": dry}

            # ---------------- level-of-detail popping of a scenery cluster
            def cluster_shot(lv, c0, tgt, fov=50):
                G(A, "([i, lv]) => { const S = window.__goldrush.game().world.sceneryLod; S.clusters[i].v = lv; window.__goldrush.game().world._sceneryIndex(); return S.count; }", [c0, lv])
                cam2 = around(tgt, 20.0, 12, 200)
                G(A, f"([x, y, z, tx, ty, tz, fov]) => {{ const w = {GR}, g = w.game(); g.effects.clear(); return w.camLook({{ x, y, z, tx, ty, tz, fov }}); }}", [*cam2, *tgt, fov])
                return grey(shot(A))
            lod = {}
            for ci, (x, z) in {0: (-21.5, -26), 4: (9.5, 17.5), 5: (-9, 18.2)}.items():
                gy = G(A, f"([x, z]) => {GR}.game().world.groundHeightAt(x, z)", [x, z])
                tgt = [x, gy + 0.3, z]
                imgs = [cluster_shot(lv, ci, tgt) for lv in (0, 1, 2)]
                G(A, "([i]) => { const w = window.__goldrush.game().world; w.sceneryLod.clusters[i].v = 0; w._sceneryIndex(); return true; }", [ci])
                d01, d12 = np.abs(imgs[0] - imgs[1]), np.abs(imgs[1] - imgs[2])
                lod[f"cluster{ci}"] = {"mean_0v1": float(d01.mean()), "mean_1v2": float(d12.mean()), "px_over_25_0v1": int((d01 > 25).sum()), "px_over_25_1v2": int((d12 > 25).sum())}
            res["lod_pop"] = lod
            res["errors"] = errors(A)[:6]
            b.close()
    finally:
        proc.terminate()
    (out / "c1smoke.json").write_text(json.dumps(res, indent=1))
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
