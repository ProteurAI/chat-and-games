"""GoldRush visual QA (Visual Overhaul A + Earth B0): fixed camera bookmarks, captures, before / after pairs.

  capture   one mine (seed 4242), a fixed quality tier, every visual bookmark (goldrush-devvisual.js
            VISUAL_BOOKMARKS) captured without the HUD, with frame statistics per view
            (draw calls, triangles, frame time, GPU time where the browser reports it)
  compare   side by side BEFORE | AFTER of every bookmark (same file names in both folders)
  shovel    shovel contact motion QA: a series of strokes on different ground, a frame every ~0.1 s around
            each contact plus the projected tool edge vs the real hit point (contact accuracy in pixels)

Runs the server from a temp copy (the real database is never touched).

    python tests/e2e/goldrush_visualqa.py capture --out DIR --tag before [--quality high] [--size 1600x900] [--browser webkit]
    python tests/e2e/goldrush_visualqa.py compare --out DIR [--a before --b after]
    python tests/e2e/goldrush_visualqa.py shovel --out DIR [--strokes 24]
"""

import json
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from goldrush_e2e import GPU_ARGS, client, errors  # noqa: E402
from goldrush_tools_e2e import seeded  # noqa: E402
import goldrush_quality_e2e as Q  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
G, GR = Q.G, "window.__goldrush"
ARG = lambda k, d: type(d)(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d
BOOKMARKS = ["spawn", "face", "mid", "summit", "camp", "plant", "sluice", "pan", "piles"]
HIDE_UI = "() => { let s = document.getElementById('gr-vqa-style'); if (!s) { s = document.createElement('style'); s.id = 'gr-vqa-style'; s.textContent = '.gr-root > :not(canvas) { visibility: hidden !important; }'; document.head.appendChild(s); } }"
STATS = """() => { const g = window.__goldrush, i = g.info(), f = g.renderStats ? g.renderStats() : null;
  return { info: i, frame: f, fov: i && i.fov, level: i && i.level }; }"""


def dev(page, cid, arg=None):
    return page.evaluate("async ([id, a]) => await window.__goldrush.dev9(id, a)", [cid, arg])


def open_mine(b, base, user, size, seed=4242, quality="high"):
    w, h = (int(x) for x in size.split("x"))
    ctx, A = client(b, base, user, dict(viewport={"width": w, "height": h}), extra_init=[seeded()])
    Q.fresh(A, seed)
    G(A, f"(q) => {GR}.setQuality(q)", quality)
    return ctx, A


def capture():
    out, tag, quality, size = Path(ARG("--out", "vqa")), ARG("--tag", "before"), ARG("--quality", "high"), ARG("--size", "1600x900")
    engine = ARG("--browser", "chromium")
    d = out / tag
    d.mkdir(parents=True, exist_ok=True)
    meta = {"tag": tag, "quality": quality, "size": size, "browser": engine, "views": {}}
    proc, base, tmp = start_server()
    try:
        user = login(base, "VisualQA")
        with sync_playwright() as p:
            b = getattr(p, engine).launch(args=GPU_ARGS if engine == "chromium" else [])
            ctx, A = open_mine(b, base, user, size, quality=quality)
            for n, bm in enumerate(BOOKMARKS, 1):
                r = dev(A, f"vo.bm.{bm}")
                G(A, f"() => {GR}.setPaused(false)")
                G(A, HIDE_UI)
                time.sleep(2.0)                                   # real frames: water, glints, settled quality
                st = G(A, STATS)
                A.screenshot(path=str(d / f"{n:02d}_{bm}.png"))
                meta["views"][bm] = {"result": r, "stats": st}
                print(f"{bm}: {r and (r.get('text') or r.get('error'))}", flush=True)
            meta["errors"] = errors(A)[:6]
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


def tune():
    """calibration: the same views under several light / grade settings (vo.set), one contact sheet per view.
    --configs FILE: JSON list of {"name": ..., <vo.set fields>}; --views spawn,face,..."""
    from PIL import Image, ImageDraw
    out, tag, size = Path(ARG("--out", "vqa")), ARG("--tag", "tune"), ARG("--size", "1280x720")
    views = ARG("--views", "spawn,face,camp,plant").split(",")
    configs = json.load(open(ARG("--configs", "configs.json"), encoding="utf-8"))
    d = out / tag
    d.mkdir(parents=True, exist_ok=True)
    proc, base, tmp = start_server()
    try:
        user = login(base, "VisualQA")
        with sync_playwright() as p:
            b = p.chromium.launch(args=GPU_ARGS)
            ctx, A = open_mine(b, base, user, size, quality=ARG("--quality", "high"))
            G(A, HIDE_UI)
            for v in views:
                dev(A, f"vo.bm.{v}")
                G(A, f"() => {GR}.setPaused(false)")
                time.sleep(1.2)
                shots = []
                for c in configs:
                    vals = {k: x for k, x in c.items() if k not in ("name", "cmd")}
                    r = dev(A, c["cmd"]) if c.get("cmd") else None          # a debug view toggle (e.g. vo.albedo)
                    if vals or not c.get("cmd"):
                        r = dev(A, "vo.set", json.dumps(vals))
                    time.sleep(0.5)
                    f = d / f"{v}_{c['name']}.png"
                    A.screenshot(path=str(f))
                    shots.append((c["name"], f))
                    print(v, c["name"], r and r.get("text"), flush=True)
                ims = [Image.open(f).convert("RGB") for _, f in shots]
                w, h = ims[0].size
                cols = min(3, len(ims))
                rows = (len(ims) + cols - 1) // cols
                sw, sh = w // 2, h // 2
                sheet = Image.new("RGB", (cols * sw, rows * (sh + 22)), (16, 16, 16))
                for i, ((name, _), im) in enumerate(zip(shots, ims)):
                    x, y = (i % cols) * sw, (i // cols) * (sh + 22)
                    sheet.paste(im.resize((sw, sh)), (x, y + 22))
                    ImageDraw.Draw(sheet).text((x + 6, y + 5), name, fill=(255, 255, 255))
                sheet.save(d / f"sheet_{v}.png")
            print("errors:", errors(A)[:4])
            b.close()
    finally:
        proc.terminate()


def perf():
    """frame statistics per quality tier on a few bookmarks: fps / frame time, GPU time per pass
    (EXT_disjoint_timer_query_webgl2), draw calls, triangles, textures, geometries, render-target memory.
    --mobile: phone emulation (390x844 @3, touch) with --cpu N throttling (CDP)."""
    out, size, mobile, cpu = Path(ARG("--out", "vqa")), ARG("--size", "1600x900"), "--mobile" in sys.argv, ARG("--cpu", 1)
    tiers = ARG("--tiers", "low,medium,high").split(",")
    views = ARG("--views", "spawn,mid,plant,piles").split(",")
    res = {"size": size, "mobile": mobile, "cpu": cpu, "tiers": {}}
    proc, base, tmp = start_server()
    try:
        user = login(base, "VisualQA")
        with sync_playwright() as p:
            b = p.chromium.launch(args=GPU_ARGS)
            if mobile:
                from goldrush_e2e import client as _client
                ctx, A = _client(b, base, user, dict(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True), extra_init=[seeded()])
                Q.fresh(A, 4242)
            else:
                ctx, A = open_mine(b, base, user, size)
            if cpu > 1:
                cdp = ctx.new_cdp_session(A)
                cdp.send("Emulation.setCPUThrottlingRate", {"rate": cpu})
            G(A, HIDE_UI)
            for q in tiers:
                G(A, f"(q) => {GR}.setQuality(q)", q)
                G(A, f"() => {GR}.gpuTiming(true)")
                res["tiers"][q] = {}
                for v in views:
                    dev(A, f"vo.bm.{v}")
                    G(A, f"() => {GR}.setPaused(false)")
                    time.sleep(3.5)
                    st = G(A, f"() => {GR}.renderStats()")
                    keep = {k: st.get(k) for k in ("fps", "frameMs", "calls", "postCalls", "tris", "textures", "geometries", "programs", "targetsMB", "gpu", "dpr", "buffer", "samples", "ao", "fxaa", "heapMB")}
                    keep["earthMB"] = st["earth"]["arraysMB"]
                    res["tiers"][q][v] = keep
                    print(q, v, keep, flush=True)
            res["errors"] = errors(A)[:4]
            b.close()
    finally:
        proc.terminate()
    tag = ARG("--tag", "perf_mobile" if mobile else "perf")
    (out / tag).mkdir(parents=True, exist_ok=True)
    json.dump(res, open(out / tag / "perf.json", "w", encoding="utf-8"), indent=1)
    print("errors:", res["errors"])


def shovel():
    """the shovel's world contact (C-lite) at ~5 fps: the loop paused, frames stepped at 0.2 s, dig held; for every
    strike the first frame after its contact is captured and measured (the blade tip vs the real hit point)."""
    import math
    out, n, size = Path(ARG("--out", "vqa")), ARG("--strikes", 20), ARG("--size", "1280x720")
    d = out / "shovel"
    d.mkdir(parents=True, exist_ok=True)
    W, H = (int(x) for x in size.split("x"))
    proc, base, tmp = start_server()
    rows, ok = [], 0
    try:
        user = login(base, "VisualQA")
        with sync_playwright() as p:
            b = p.chromium.launch(args=GPU_ARGS)
            ctx, A = open_mine(b, base, user, size, quality=ARG("--quality", "high"))
            G(A, f"() => {GR}.grant('shovel')")
            G(A, f"() => {GR}.equipNow('shovel')")
            dev(A, "vo.bm.face")
            st0 = G(A, f"() => {GR}.state()")
            G(A, HIDE_UI)
            G(A, f"() => {GR}.setPaused(true)")
            G(A, f"() => {GR}.contactLog(true)")
            for s in range(n):
                # a little different ground every few strikes (turn / look further or nearer)
                if s % 4 == 0:
                    k = s // 4
                    G(A, f"(a) => {GR}.aimAt(a)", {"x": st0["x"], "z": st0["z"], "yaw": st0["yaw"] + [0, 0.35, -0.35, 0.18, -0.18][k % 5], "pitch": st0["pitch"] - 0.12 - 0.05 * (k % 3)})
                G(A, f"() => {{ {GR}.input().digHeld = true; }}")
                got = None
                for f in range(40):
                    G(A, f"() => {GR}.stepFrames(1, 0.2)")
                    if s < 2:
                        A.screenshot(path=str(d / f"seq{s + 1}_{f:02d}.png"))
                    if G(A, f"() => {GR}.contactLog().length") > s:
                        got = G(A, f"() => {GR}.contactNow()")
                        A.screenshot(path=str(d / f"s{s + 1:02d}_contact.png"))
                        break
                info = (got or {}).get("info") or {}
                # the blade tip and the contact point on the screen (each through its own pass's camera)
                tn, hn = (got or {}).get("tipNdc"), (got or {}).get("hitNdc")
                px = math.hypot((tn[0] - hn[0]) * W / 2, (tn[1] - hn[1]) * H / 2) if tn and hn else None
                good = bool(info) and px is not None and px <= 12 and (got or {}).get("clip") == 1
                ok += good
                rows.append({"strike": s + 1, "contact": bool(info), "clip": (got or {}).get("clip"), "hitDist": info.get("hitDist"), "need": info.get("need"),
                             "turnDeg": info.get("turnDeg"), "slide": info.get("slide"), "gapFull_m": info.get("gapFull"), "gap_px": round(px, 1) if px is not None else None, "ok": good})
                print(rows[-1], flush=True)
            G(A, f"() => {{ {GR}.input().digHeld = false; }}")
            log = G(A, f"() => {GR}.contactLog()")
            errs = errors(A)[:4]
            b.close()
    finally:
        proc.terminate()
    res = {"strikes": n, "ok": ok, "rows": rows, "log": log, "errors": errs}
    json.dump(res, open(d / "shovel.json", "w", encoding="utf-8"), indent=1)
    print(f"contact OK {ok}/{n}; errors: {errs}")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "capture"
    {"capture": capture, "compare": compare, "tune": tune, "shovel": shovel, "perf": perf}[mode]()
