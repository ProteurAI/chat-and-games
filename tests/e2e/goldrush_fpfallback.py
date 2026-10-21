"""GoldRush FP2.0B: the rigged arms' safety nets - the game must stay playable whatever happens to fp_arms.glb or the GL context.

  404           the GLB is missing                 -> procedural gloves, one console warning, dig works
  corrupt       the GLB is garbage (HTTP 200)      -> same
  truncated     half of a valid GLB                -> same
  no-clips      a GLB without the curl clips       -> same (the loader checks the clips)
  context loss  normal GLB, the GL context is lost and restored while the shovel is held -> the rigged hands come back and draw,
                a stroke after the restore digs (the simulation did not care)

Each case: hands.rigged, the console (a warning, no error / page error), a real stroke at the crosshair (the ground changed), and
the hands region of the canvas is not empty (variance).

    python tests/e2e/goldrush_fpfallback.py [--quality medium]
"""

import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from goldrush_e2e import GPU_ARGS, client, errors  # noqa: E402
from goldrush_tools_e2e import seeded  # noqa: E402
import goldrush_quality_e2e as Q  # noqa: E402
from goldrush_visualqa import HIDE_UI, dev  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
G, GR = Q.G, "window.__goldrush"
ARG = lambda k, d: type(d)(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d
RESULTS = []


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    print(("  ok   " if cond else "  FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def region_variance(A):
    """variance of the lower-right screenshot region (where the hands are) - a blank / flat picture would be ~0"""
    import io
    from PIL import Image
    im = Image.open(io.BytesIO(A.screenshot())).convert("L")
    w, h = im.size
    px = list(im.crop((int(w * 0.45), int(h * 0.62), int(w * 0.95), int(h * 0.98))).resize((100, 60)).getdata())
    m = sum(px) / len(px)
    return sum((v - m) ** 2 for v in px) / len(px)


def case(b, base, user, name, route, quality, restore=False):
    print(f"[{name}]", flush=True)
    ctx, A = client(b, base, user, dict(viewport={"width": 1280, "height": 720}), extra_init=[seeded()])
    if route:
        ctx.route("**/assets/fp/fp_arms.glb", route)
    Q.fresh(A, 4242)
    G(A, f"(q) => {GR}.setQuality(q)", quality)
    G(A, f"() => {GR}.grant('shovel')")
    G(A, f"() => {GR}.equipNow('shovel')")
    G(A, HIDE_UI)
    time.sleep(1.2)
    G(A, f"() => {GR}.setPaused(true)")
    G(A, f"() => {GR}.stepFrames(3, 0.016)")
    time.sleep(0.3)
    rigged = G(A, f"() => {GR}.game().hands.rigged")
    warn = [w for w in A.warnings if "first-person arms" in w or "fp_arms" in w]
    return ctx, A, rigged, warn


def stroke_ok(A):
    """strokes at the crosshair (the loop paused and stepped): the terrain's volume changed"""
    G(A, f"() => {GR}.setPaused(true)")
    dev(A, "vo.bm.face")                                   # (a spot with ground in reach)
    G(A, f"() => {GR}.setPaused(true)")
    st = G(A, f"() => {GR}.state()")
    G(A, f"(a) => {GR}.aimAt(a)", {"x": st["x"], "z": st["z"], "yaw": st["yaw"], "pitch": -0.3})
    G(A, f"() => {GR}.stepFrames(10, 0.02)")
    v0 = G(A, f"() => {GR}.volume()")["delta"]
    G(A, f"() => {{ {GR}.input().digHeld = true; }}")
    G(A, f"() => {GR}.stepFrames(120, 0.02)")
    G(A, f"() => {{ {GR}.input().digHeld = false; }}")
    G(A, f"() => {GR}.stepFrames(30, 0.02)")
    v1 = G(A, f"() => {GR}.volume()")["delta"]
    return v1 != v0


def main():
    quality = ARG("--quality", "medium")
    proc, base, tmp = start_server()
    glb = None
    try:
        user = login(base, "VisualQA")
        glb = (open(os.path.join(os.path.dirname(__file__), "..", "..", "static", "games", "goldrush", "assets", "fp", "fp_arms.glb"), "rb")).read()
        with sync_playwright() as p:
            b = p.chromium.launch(args=GPU_ARGS)
            cases = {
                "404": lambda route: route.fulfill(status=404, body="not found"),
                "corrupt": lambda route: route.fulfill(status=200, content_type="model/gltf-binary", body=b"this is not a glb file at all" * 40),
                "truncated": lambda route: route.fulfill(status=200, content_type="model/gltf-binary", body=glb[: len(glb) // 2]),
                "no-clips": lambda route: route.fulfill(status=200, content_type="model/gltf-binary", body=strip_clips(glb)),
            }
            for name, fn in cases.items():
                ctx, A, rigged, warn = case(b, base, user, name, fn, quality)
                ok(f"{name}: falls back to the procedural gloves", rigged is False, f"rigged={rigged}")
                errs = [e for e in errors(A) if "Failed to load resource" not in e]          # (the 404 itself is logged by the browser)
                ok(f"{name}: one console warning, no error", len(warn) >= 1 and not errs, f"warnings {len(warn)}, errors {errs[:2]}")
                ok(f"{name}: hands are drawn", region_variance(A) > 8, f"variance {region_variance(A):.1f}")
                ok(f"{name}: a stroke digs", stroke_ok(A))
                ctx.close()
            # normal GLB + context loss / restore
            ctx, A, rigged, warn = case(b, base, user, "context loss", None, quality)
            ok("normal: rigged arms", rigged is True)
            v_before = region_variance(A)
            lost = G(A, f"() => {GR}.loseContext()")
            time.sleep(1.8)                                   # (lost, then restored 0.4 s later by the hook)
            still = G(A, f"() => {GR}.game().hands.rigged")
            ok("context loss: the game recovers (no dialog) and keeps the rigged hands", lost and not A.is_visible(".gr-dialog") and still is True)
            G(A, f"() => {GR}.setPaused(true)")
            G(A, f"() => {GR}.stepFrames(3, 0.016)")
            time.sleep(0.5)
            v_after = region_variance(A)
            ok("context loss: the rigged hands are drawn again", v_after > 8, f"variance before {v_before:.1f}, after {v_after:.1f}")
            ok("context loss: a stroke after the restore digs", stroke_ok(A))
            ok("context loss: no console error", not errors(A), str(errors(A)[:3]))
            ctx.close()
            b.close()
    finally:
        proc.terminate()
    bad = [n for n, c in RESULTS if not c]
    print(f"\n{len(RESULTS) - len(bad)}/{len(RESULTS)} ok" + (f"  FAILED: {bad}" if bad else ""))
    sys.exit(1 if bad else 0)


def strip_clips(glb):
    """the same GLB without its animations (the loader must notice and fall back)"""
    import struct
    n = struct.unpack_from("<I", glb, 12)[0]
    js = json.loads(glb[20:20 + n])
    js["animations"] = []
    j = json.dumps(js, separators=(",", ":")).encode()
    j += b" " * ((4 - len(j) % 4) % 4)
    rest = glb[20 + n:]
    total = 12 + 8 + len(j) + len(rest)
    return struct.pack("<4sII", b"glTF", 2, total) + struct.pack("<I4s", len(j), b"JSON") + j + rest


if __name__ == "__main__":
    main()
