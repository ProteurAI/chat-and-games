"""GoldRush FP2.0B heap / resource check: where does the JS heap go when the first-person rig is loaded, and does repeated use leak?

Each run launches a fresh browser (so nothing is shared), loads the seeded mine, and reads - after a FORCED garbage collection (CDP
HeapProfiler.collectGarbage, so uncollected garbage is not counted as "used") - the retained JS heap and three.js' own resource counts
(geometries / textures / programs). Then it digs, switches tools and digs again, reading the same numbers after each step.

    python tests/e2e/goldrush_fpheap.py --out DIR --tag fp2b [--root REV_DIR] [--runs 3] [--quality low] [--strokes-s 12] [--rounds 3]
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

INFO = """() => { const g = window.__goldrush.game(), i = g.renderer.info;
  return { geo: i.memory.geometries, tex: i.memory.textures, prog: (i.programs || []).length, rigged: !!(g.hands && g.hands.rigged),
           tris: i.render.triangles, calls: i.render.calls }; }"""


def sample(A, cdp, label):
    raw = cdp.send("Runtime.getHeapUsage")["usedSize"]                # (before any forced GC: what a plain performance.memory reading sees)
    for _ in range(3):
        cdp.send("HeapProfiler.collectGarbage")
    heap = cdp.send("Runtime.getHeapUsage")
    r = G(A, INFO)
    r.update({"label": label, "rawMB": round(raw / 1048576, 1), "heapMB": round(heap["usedSize"] / 1048576, 1), "totalMB": round(heap["totalSize"] / 1048576, 1)})
    return r


def one_run(base, user, quality, secs, rounds):
    out = []
    with sync_playwright() as p:
        b = p.chromium.launch(args=GPU_ARGS + ["--enable-precise-memory-info", "--js-flags=--expose-gc"])
        ctx, A = open_mine(b, base, user, "1280x720", quality=quality)
        cdp = ctx.new_cdp_session(A)
        cdp.send("HeapProfiler.enable")
        G(A, f"() => {GR}.grant('shovel')")
        G(A, f"() => {GR}.grant('pickaxe')")
        G(A, HIDE_UI)
        time.sleep(4)
        out.append(sample(A, cdp, "loaded"))
        st = G(A, f"() => {GR}.state()")
        for rd in range(rounds):
            for tool in ("hand", "shovel", "pickaxe"):
                G(A, f"(t) => {GR}.selectTool(t)", tool)
                time.sleep(0.7)
                G(A, f"(a) => {GR}.aimAt(a)", {"x": st["x"], "z": st["z"], "yaw": st["yaw"], "pitch": -0.5})
                G(A, f"() => {{ {GR}.input().digHeld = true; }}")
                time.sleep(secs)
                G(A, f"() => {{ {GR}.input().digHeld = false; }}")
                time.sleep(0.5)
            out.append(sample(A, cdp, f"round{rd + 1}"))
        b.close()
    return out


def main():
    out, tag = Path(ARG("--out", "fpheap")), ARG("--tag", "now")
    out.mkdir(parents=True, exist_ok=True)
    runs, quality, secs, rounds = ARG("--runs", 3), ARG("--quality", "low"), ARG("--strokes-s", 12.0), ARG("--rounds", 3)
    proc, base, tmp = start_server()
    res = []
    try:
        user = login(base, "VisualQA")
        for i in range(runs):
            r = one_run(base, user, quality, secs, rounds)
            res.append(r)
            print(f"run {i + 1}:", " | ".join(f"{s['label']} heap {s['heapMB']} geo {s['geo']} tex {s['tex']} prog {s['prog']}" for s in r), flush=True)
    finally:
        proc.terminate()
    json.dump(res, open(out / f"heap_{tag}.json", "w"), indent=1)
    loaded = [r[0]["heapMB"] for r in res]
    last = [r[-1]["heapMB"] for r in res]
    print(f"{tag} {quality}: raw (no forced GC) after load {[r[0]['rawMB'] for r in res]}")
    print(f"{tag} {quality}: retained heap after load {loaded} (median {sorted(loaded)[len(loaded) // 2]}), after use {last}; "
          f"rigged {res[0][0]['rigged']}; growth load->last {[round(b - a, 1) for a, b in zip(loaded, last)]}")


if __name__ == "__main__":
    main()
