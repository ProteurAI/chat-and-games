"""GoldRush rock performance (Earth 2.0C1): frame statistics over views that see many rocks, repeated, per quality tier.

Each view is a real (unpaused) 3.5 s run at a fixed player pose: fps, frame ms, GPU ms (where reported), draw calls, triangles,
textures, geometries, heap. Repeats make a single noisy run visible. --root runs an old revision (git worktree).

    python tests/e2e/goldrush_rockperf.py --tier high --repeat 3 --out FILE.json [--root OLD_REV_DIR]
"""

import json
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
import kopfkicker_e2e  # noqa: E402
from goldrush_e2e import GPU_ARGS, errors  # noqa: E402
import goldrush_quality_e2e as Q  # noqa: E402
from goldrush_visualqa import open_mine, dev, HIDE_UI  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
G, GR = Q.G, "window.__goldrush"
ARG = lambda k, d: type(d)(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d
if "--root" in sys.argv:
    kopfkicker_e2e.ROOT = Path(sys.argv[sys.argv.index("--root") + 1])

VIEWS = {
    "spawn": None,                                                   # the bookmark
    "wide": {"x": 0.5, "z": 14.5, "yaw": 0.0, "pitch": 0.08},       # the mound, the fence, the clusters to the sides
    "east": {"x": -4.0, "z": 14.0, "yaw": -1.15, "pitch": 0.05},
    "west": {"x": 6.0, "z": 12.0, "yaw": 1.2, "pitch": 0.05},
}
KEEP = ("fps", "frameMs", "calls", "tris", "textures", "geometries", "programs", "heapMB")


def main():
    tier, rep, out, size = ARG("--tier", "high"), ARG("--repeat", 3), ARG("--out", ""), ARG("--size", "1600x900")
    mobile = "--mobile" in sys.argv
    res = {"tier": tier, "mobile": mobile, "views": {}}
    proc, base, tmp = start_server()
    try:
        user = login(base, "VisualQA")
        with sync_playwright() as p:
            b = p.chromium.launch(args=GPU_ARGS)
            if mobile:
                from goldrush_e2e import client as _client
                from goldrush_tools_e2e import seeded
                ctx, A = _client(b, base, user, dict(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True), extra_init=[seeded()])
                Q.fresh(A, 4242)
                G(A, f"(q) => {GR}.setQuality(q)", tier)
            else:
                ctx, A = open_mine(b, base, user, size, quality=tier)
            G(A, HIDE_UI)
            G(A, f"() => {GR}.gpuTiming(true)")
            for name, pose in VIEWS.items():
                runs = []
                for _ in range(rep):
                    if pose is None:
                        dev(A, "vo.bm.spawn")
                    else:
                        G(A, f"(a) => {GR}.aimAt(a)", pose)
                    G(A, f"() => {GR}.setPaused(false)")
                    time.sleep(3.5)
                    st = G(A, f"() => {GR}.renderStats()")
                    r = {k: st.get(k) for k in KEEP}
                    r["gpuMs"] = (st.get("gpu") or {}).get("total")
                    runs.append(r)
                res["views"][name] = runs
                print(name, [(r["fps"], r["tris"], r["calls"], r["gpuMs"]) for r in runs], flush=True)
            res["errors"] = errors(A)[:4]
            b.close()
    finally:
        proc.terminate()
    if out:
        Path(out).write_text(json.dumps(res, indent=1))
    print("errors:", res["errors"])


if __name__ == "__main__":
    main()
