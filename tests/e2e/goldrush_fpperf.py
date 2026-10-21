"""GoldRush FP2.0B performance: the first-person rig in use - fps / frame time (CPU rAF intervals, GPU passes where the browser reports
them), draw calls, triangles, textures, geometries, heap - per quality tier, for: empty hands idle, shovel idle, repeated strokes with each
tool, tool switching, and a sustained run. Real time (the loop runs), the same bookmark and size for every revision (--root for an old one).

    python tests/e2e/goldrush_fpperf.py --out DIR --tag fp2b [--root REV_DIR] [--tiers low,medium] [--size 1600x900] [--sustain 45]
"""

import json
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
import kopfkicker_e2e  # noqa: E402
from goldrush_e2e import GPU_ARGS  # noqa: E402
import goldrush_quality_e2e as Q  # noqa: E402
from goldrush_visualqa import open_mine, HIDE_UI, dev  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
G, GR = Q.G, "window.__goldrush"
ARG = lambda k, d: type(d)(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d
if "--root" in sys.argv:
    kopfkicker_e2e.ROOT = Path(sys.argv[sys.argv.index("--root") + 1])

FRAMES = """(ms) => new Promise((res) => { const t = []; let last = performance.now(), end = last + ms;
  const f = (now) => { t.push(now - last); last = now; if (now < end) requestAnimationFrame(f); else res(t); }; requestAnimationFrame(f); })"""


def stats(A, secs):
    t = G(A, FRAMES, secs * 1000)[2:]
    t.sort()
    n = len(t)
    st = G(A, f"() => {GR}.renderStats()")
    keep = {k: st.get(k) for k in ("calls", "tris", "textures", "geometries", "programs", "heapMB", "gpu")}
    keep.update({"fps": round(1000 / (sum(t) / n), 1), "frameMs": round(sum(t) / n, 2), "p95Ms": round(t[int(n * 0.95)], 2), "maxMs": round(t[-1], 1)})
    return keep


def main():
    out, tag, size = Path(ARG("--out", "fpperf")), ARG("--tag", "now"), ARG("--size", "1600x900")
    tiers, sustain = ARG("--tiers", "low,medium").split(","), ARG("--sustain", 45)
    res = {"tag": tag, "size": size, "tiers": {}}
    proc, base, tmp = start_server()
    try:
        user = login(base, "VisualQA")
        with sync_playwright() as p:
            b = p.chromium.launch(args=GPU_ARGS)
            ctx, A = open_mine(b, base, user, size)
            G(A, f"() => {GR}.grant('shovel')")
            G(A, f"() => {GR}.grant('pickaxe')")
            G(A, HIDE_UI)
            for q in tiers:
                G(A, f"(q) => {GR}.setQuality(q)", q)
                G(A, f"() => {GR}.gpuTiming(true)")
                dev(A, "vo.bm.face")
                st0 = G(A, f"() => {GR}.state()")
                G(A, f"(a) => {GR}.aimAt(a)", {"x": st0["x"], "z": st0["z"], "yaw": st0["yaw"], "pitch": -0.3})
                G(A, f"() => {GR}.setPaused(false)")
                r = res["tiers"][q] = {}
                for tool in ("hand", "shovel", "pickaxe"):
                    G(A, f"(t) => {GR}.equipNow(t)", tool)
                    time.sleep(2.5)
                    r[f"{tool}_idle"] = stats(A, 4)
                    G(A, f"() => {{ {GR}.input().digHeld = true; }}")
                    time.sleep(0.5)
                    r[f"{tool}_digging"] = stats(A, 8)
                    G(A, f"() => {{ {GR}.input().digHeld = false; }}")
                    time.sleep(0.5)
                    print(q, tool, r[f"{tool}_idle"]["fps"], r[f"{tool}_digging"], flush=True)
                # switching: hand -> shovel -> pickaxe -> hand, a few rounds, the loop running
                G(A, f"() => {{ {GR}.input().digHeld = false; }}")
                t0 = time.time()
                for _ in range(6):
                    for tool in ("shovel", "pickaxe", "hand"):
                        G(A, f"(t) => {GR}.selectTool(t)", tool)
                        time.sleep(0.6)
                r["switching"] = stats(A, 2)
                # sustained use: strokes + a switch every few seconds
                s0 = stats(A, 3)
                end = time.time() + sustain
                k = 0
                G(A, f"() => {{ {GR}.input().digHeld = true; }}")
                while time.time() < end:
                    time.sleep(6)
                    k += 1
                    G(A, f"(t) => {GR}.selectTool(t)", ("shovel", "pickaxe", "hand")[k % 3])
                    st = G(A, f"() => {GR}.state()")
                    G(A, f"(a) => {GR}.aimAt(a)", {"x": st["x"], "z": st["z"], "yaw": st["yaw"], "pitch": -0.3})
                G(A, f"() => {{ {GR}.input().digHeld = false; }}")
                time.sleep(1)
                r["sustain_start"], r["sustain_end"] = s0, stats(A, 3)
                print(q, "sustain", s0, r["sustain_end"], flush=True)
            res["errors"] = [e for e in A.errors][:4]
            b.close()
    finally:
        proc.terminate()
    out.mkdir(parents=True, exist_ok=True)
    json.dump(res, open(out / f"perf_{tag}.json", "w"), indent=1)
    print("errors:", res["errors"])


if __name__ == "__main__":
    main()
