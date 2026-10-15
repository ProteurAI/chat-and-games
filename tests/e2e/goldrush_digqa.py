"""GoldRush Earth 2.0B visual QA: what a dig looks like, close up - fixed scenes, before / after pairs.

  capture   one mine (seed 4242), HIGH quality, the loop paused; every scene is dug with the real stroke path
            (the `act` hook: kernel, mass, gold as in play) and photographed with `camLook`:
              shovel1   one shovel scoop on flat ground, close
              shovelN   four scoops side by side
              pick      three pickaxe strikes
              flank     scoops into the steeper mountain flank
              side      the fresh cut seen from the side (low camera)
              repeat    one spot worked over six times
              mid       the multi-dig seen from about 6 m
              slump     the moment after a scoop on the flank: frames at 0.1 / 0.4 / 1.2 s (crumbs, settle)
            plus per scene: the engine's terrain numbers (mass / volume unchanged check) and frame statistics
  compare   BEFORE | AFTER side by side of every scene (same file names in both folders)
  perf      the dig spike: time of N strokes (act + flush) and the frame statistics, unpaused

    python tests/e2e/goldrush_digqa.py capture --out DIR --tag before [--quality high] [--size 1600x900]
    python tests/e2e/goldrush_digqa.py compare --out DIR [--a before --b after]
    python tests/e2e/goldrush_digqa.py perf --out DIR --tag after
"""

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
import kopfkicker_e2e  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
G, GR = Q.G, "window.__goldrush"
ARG = lambda k, d: type(d)(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d
if "--root" in sys.argv:                                  # a game revision checked out elsewhere (git worktree): the "before" run
    kopfkicker_e2e.ROOT = Path(sys.argv[sys.argv.index("--root") + 1])

# --- helpers run in the page -------------------------------------------------------------------------------------
JS_STROKE = """([x, z, yaw, pitch, tool]) => {
  const w = window.__goldrush, g = w.game();
  w.aimAt({ x, z, yaw, pitch });
  const a = w.aim();
  const r = w.act({ tool });
  const nn = a && a.x != null ? g.terrain.getNormalAt(a.x, a.z) : null;
  return { aim: a, n: nn && [nn.x, nn.y, nn.z], r: r && { kind: r.kind, massKg: r.massKg, cells: r.cells } };
}"""
JS_LOOK = """([x, y, z, tx, ty, tz, fov, calm]) => {
  const w = window.__goldrush, g = w.game();
  if (calm) { g.effects.clear(); }
  g.world.earth.update(g.terrain.clock, 1.0);          // StateTex (fresh) as a frame would have updated it
  return w.camLook({ x, y, z, tx, ty, tz, fov });
}"""
JS_NUMBERS = """() => { const w = window.__goldrush, g = w.game(), t = g.terrain; return { vol: t.volumeDelta(), pile: t.pileVolume(), ok: t.validate(), stats: t.view.stats, lod: t.view.lodCounts() }; }"""


def look(A, d, name, c, t, fov=50, calm=True):
    G(A, JS_LOOK, [c[0], c[1], c[2], t[0], t[1], t[2], fov, calm])
    time.sleep(0.25)
    A.screenshot(path=str(d / f"{name}.png"))


def cam_for(hit, dist, elev_deg, az_deg):
    e, a = math.radians(elev_deg), math.radians(az_deg)
    return [hit[0] + dist * math.cos(e) * math.sin(a), hit[1] + dist * math.sin(e), hit[2] + dist * math.cos(e) * math.cos(a)]


def stroke(A, spot, tool):
    r = G(A, JS_STROKE, [spot["x"], spot["z"], spot["yaw"], spot["pitch"], tool])
    a = r["aim"]
    return r, ([a["x"], a["y"], a["z"]] if a and a.get("x") is not None else None)


def cam_normal(hit, n, dist, side):
    """a camera above the surface point along its normal, tilted to the side (for slopes: looks at the face, not through it)"""
    sx, sz = -n[2], n[0]
    sl = math.hypot(sx, sz) or 1.0
    sx, sz = sx / sl, sz / sl
    return [hit[0] + n[0] * dist + sx * dist * side, hit[1] + n[1] * dist, hit[2] + n[2] * dist + sz * dist * side]


def capture():
    out, tag, quality, size = Path(ARG("--out", "vqa")), ARG("--tag", "before"), ARG("--quality", "high"), ARG("--size", "1600x900")
    d = out / tag
    d.mkdir(parents=True, exist_ok=True)
    meta = {"tag": tag, "quality": quality, "size": size, "scenes": {}}
    proc, base, tmp = start_server()
    try:
        user = login(base, "VisualQA")
        with sync_playwright() as p:
            b = p.chromium.launch(args=GPU_ARGS)
            ctx, A = open_mine(b, base, user, size, quality=quality)
            G(A, f"() => {GR}.grant('shovel')")
            G(A, f"() => {GR}.grant('pickaxe')")
            G(A, HIDE_UI)
            G(A, f"() => {GR}.setPaused(true)")
            dev(A, "vo.bm.face")
            st0 = G(A, f"() => {GR}.state()")

            def spot(dx, dz, yaw, pitch, base_x=None, base_z=None):
                return {"x": (base_x if base_x is not None else st0["x"]) + dx, "z": (base_z if base_z is not None else st0["z"]) + dz, "yaw": yaw, "pitch": pitch}

            num = lambda n: meta["scenes"].setdefault(n, {}).update({"numbers": G(A, JS_NUMBERS)})

            # ---- flat ground in front of the camp side (low risk of stone): the original shovel scene
            flat = dict(x=-3.0, z=6.0, yaw=0.0, pitch=-0.9)
            G(A, f"() => {GR}.equipNow('shovel')")
            numbers0 = G(A, JS_NUMBERS)
            r, hit = stroke(A, flat, "shovel")
            print("shovel1", r, flush=True)
            if hit:
                look(A, d, "01_shovel1_near", cam_for(hit, 0.85, 38, 25), hit)
                look(A, d, "01_shovel1_mid", cam_for(hit, 2.2, 28, -20), hit)
            num("shovel1")
            # ---- four scoops side by side
            hits = [hit] if hit else []
            for i, off in enumerate([0.32, 0.64, 0.96]):
                r, h2 = stroke(A, dict(flat, x=flat["x"] + off), "shovel")
                if h2: hits.append(h2)
            if hits:
                c = [sum(h[i] for h in hits) / len(hits) for i in range(3)]
                look(A, d, "02_shovelN_near", cam_for(c, 1.3, 35, 15), c)
                look(A, d, "02_shovelN_side", cam_for(c, 1.6, 9, 80), c)
                look(A, d, "07_mid", cam_for(c, 6.0, 22, -25), c, 50)
            num("shovelN")
            # ---- pickaxe: three strikes
            G(A, f"() => {GR}.equipNow('pickaxe')")
            pk = dict(x=2.5, z=6.0, yaw=0.0, pitch=-0.9)
            ph = []
            for off in [0, 0.28, 0.14]:
                r, h2 = stroke(A, dict(pk, x=pk["x"] + off, z=pk["z"] + (0.2 if off == 0.14 else 0)), "pickaxe")
                print("pick", r, flush=True)
                if h2: ph.append(h2)
            if ph:
                c = [sum(h[i] for h in ph) / len(ph) for i in range(3)]
                look(A, d, "03_pick_near", cam_for(c, 0.55, 45, 20), c)
            num("pick")
            # ---- the steeper flank (the bookmark's face): scoops into it
            G(A, f"() => {GR}.equipNow('shovel')")
            dev(A, "vo.bm.face")
            sf = G(A, f"() => {GR}.state()")
            fh, fn = [], None
            for off, pit in [(0.0, -0.22), (0.35, -0.22), (0.0, -0.05)]:
                r, h2 = stroke(A, dict(x=sf["x"], z=sf["z"], yaw=sf["yaw"] + off, pitch=pit), "shovel")
                print("flank", r, flush=True)
                if h2:
                    fh.append(h2)
                    fn = fn or r.get("n")
            if fh and fn:
                c = fh[0]
                look(A, d, "04_flank_near", cam_normal(c, fn, 0.9, 0.55), c, 55)
                look(A, d, "05_side_cut", cam_normal(c, fn, 1.3, 1.6), c, 50)
                G(A, f"() => {GR}.game().effects.clear()")
            num("flank")
            # ---- one spot worked over six times
            rep = dict(x=-6.0, z=6.0, yaw=0.0, pitch=-0.9)
            rh = None
            for _ in range(6):
                r, h2 = stroke(A, rep, "shovel")
                rh = h2 or rh
            if rh:
                look(A, d, "06_repeat_near", cam_for(rh, 1.0, 36, 30), rh)
            num("repeat")
            # ---- slump: a scoop and the frames right after (particles + settle)
            sl = dict(x=sf["x"] - 0.5, z=sf["z"], yaw=sf["yaw"], pitch=-0.2)
            r, sh = stroke(A, sl, "shovel")
            if sh and r.get("n"):
                for lbl, adv in [("a_0.1s", 0.1), ("b_0.4s", 0.3), ("c_1.2s", 0.8)]:
                    G(A, f"(s) => {{ const g = {GR}.game(); for (let i = 0; i < Math.round(s / 0.05); i++) {{ g.effects.update(0.05); g.world.earth.update(g.terrain.clock, 0.05); }} }}", adv)
                    look(A, d, f"08_slump_{lbl}", cam_normal(sh, r["n"], 1.0, 0.6), sh, 55, calm=False)
            # ---- the same ground after a save / reload of the terrain: the imprints are gone (never saved), the cut's edge
            # (crest / cavity from the heights) and the worked-ground state must still read
            G(A, f"() => {{ const g = {GR}.game(); g.terrain.deserialize(g.terrain.serialize()); g.effects.clear(); }}")
            if rh:
                look(A, d, "09_reload_repeat", cam_for(rh, 1.0, 36, 30), rh)
            if hits:
                c = [sum(h[i] for h in hits) / len(hits) for i in range(3)]
                look(A, d, "09_reload_shovelN", cam_for(c, 1.3, 35, 15), c)
            meta["errors"] = errors(A)[:6]
            meta["numbers0"] = numbers0
            meta["numbers_end"] = G(A, JS_NUMBERS)
            b.close()
    finally:
        proc.terminate()
    json.dump(meta, open(d / "meta.json", "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    print("errors:", meta["errors"])


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


def perf():
    """dig cost: N strokes timed in the page (act + the flush the next frame does) and the frame statistics
    unpaused while digging (fps, calls, tris, textures, heap)."""
    out, size, quality = Path(ARG("--out", "vqa")), ARG("--size", "1600x900"), ARG("--quality", "high")
    tag, n = ARG("--tag", "perf"), ARG("--n", 40)
    proc, base, tmp = start_server()
    res = {}
    try:
        user = login(base, "VisualQA")
        with sync_playwright() as p:
            b = p.chromium.launch(args=GPU_ARGS)
            ctx, A = open_mine(b, base, user, size, quality=quality)
            G(A, f"() => {GR}.grant('shovel')")
            G(A, f"() => {GR}.equipNow('shovel')")
            G(A, HIDE_UI)
            dev(A, "vo.bm.face")
            G(A, f"() => {GR}.setPaused(false)")
            time.sleep(3.0)
            res["idle"] = G(A, f"() => {GR}.renderStats()")
            js = """async (n) => {
              const w = window.__goldrush, g = w.game(), raf = () => new Promise((r) => requestAnimationFrame(r));
              const st = w.state(), ms = [], gaps = [];
              let last = performance.now();
              for (let i = 0; i < n; i++) {
                w.aimAt({ x: st.x + (i % 8) * 0.3 - 1, z: st.z, yaw: st.yaw, pitch: -0.4 });
                const t0 = performance.now(); w.act({ tool: 'shovel' }); const t1 = performance.now();
                await raf(); await raf();
                ms.push([t1 - t0, performance.now() - t1]);
              }
              const worst = ms.reduce((m, x) => Math.max(m, x[1]), 0);
              ms.sort((a, b) => a[0] - b[0]);
              return { actMedian: ms[ms.length >> 1][0], actMax: ms[ms.length - 1][0], worstTwoFrames: worst, stats: g.terrain.view.stats };
            }"""
            res["dig"] = G(A, js, n)
            time.sleep(1.5)
            res["after"] = G(A, f"() => {GR}.renderStats()")
            res["errors"] = errors(A)[:4]
            b.close()
    finally:
        proc.terminate()
    (out / tag).mkdir(parents=True, exist_ok=True)
    json.dump(res, open(out / tag / "digperf.json", "w", encoding="utf-8"), indent=1, default=str)
    print(json.dumps({k: res[k] for k in ("dig",)}, default=str)[:600])
    keep = ("fps", "frameMs", "calls", "tris", "textures", "geometries", "programs", "heapMB")
    print("idle ", {k: res["idle"].get(k) for k in keep})
    print("after", {k: res["after"].get(k) for k in keep})
    print("errors:", res["errors"])


if __name__ == "__main__":
    {"capture": capture, "compare": compare, "perf": perf}[sys.argv[1] if len(sys.argv) > 1 else "capture"]()
