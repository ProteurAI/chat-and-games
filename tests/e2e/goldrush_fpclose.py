"""GoldRush FP2.0B: close-ups of the first-person hands (frozen poses, tight camera) - fingers, thumb, grips, materials.

    python tests/e2e/goldrush_fpclose.py --out DIR --tag after [--root OLD_REV_DIR]

Writes close_*.png: both hands open / half closed / fist (view space, near the camera), the shovel D-grip and shaft grip, the
pickaxe grip - each as the hands.update() poses it, then cropped and enlarged around the hands.
"""

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

# freeze both hands in one pose (hands.debugPose), then render one frame through the game's own path
POSE = """([pose, tool, toolPose]) => {
  const g = window.__goldrush.game(), h = g.hands;
  h.debugPose = pose; h.debugToolPose = toolPose || null;
  if (pose && pose.fov) { h.camera.fov = pose.fov; h.camera.updateProjectionMatrix(); }
  for (let i = 0; i < 3; i++) h.update(0.016, g.tools.view(), { camera: g.camera, sunDir: g.world.sun.position.clone().normalize(), sunVisible: true, walk: 0, bob: 0 });
  if (pose && pose.thumb) for (const gl of [h.right, h.left]) { gl.thumb.rotation.set(...pose.thumb); gl._curl(pose.c, 0.9); gl.root.updateMatrix(); gl._arm(h.aspectK); }
  g.render();
  return true; }"""

POSES = {
    "open": {"p": [0.13, -0.10, -0.40], "r": [0.35, 0.4, -0.2], "c": 0.0},
    "half": {"p": [0.13, -0.10, -0.40], "r": [0.35, 0.4, -0.2], "c": 0.5},
    "fist": {"p": [0.13, -0.10, -0.40], "r": [0.35, 0.4, -0.2], "c": 0.97},
    "reach": {"p": [0.08, -0.14, -0.50], "r": [0.4, 0.35, -0.15], "c": 0.12},
    "grip": {"p": [0.13, -0.10, -0.40], "r": [0.35, 0.4, -0.2], "c": 0.97, "thumb": [-0.55, 0.4, -0.9]},
    "grip_side": {"p": [0.13, -0.10, -0.40], "r": [0.35, 1.3, -0.2], "c": 0.97, "thumb": [-0.55, 0.4, -0.9]},
    "grip_under": {"p": [0.13, -0.10, -0.40], "r": [-0.9, 0.4, 0.2], "c": 0.97, "thumb": [-0.55, 0.4, -0.9]},
    "palm": {"p": [0.10, -0.10, -0.36], "r": [0.9, 0.1, 1.9], "c": 0.25},
}


def crop(f, box):
    from PIL import Image
    im = Image.open(f)
    w, h = im.size
    im.crop((int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h))).save(f)


def main():
    out, tag = Path(ARG("--out", "fpclose")), ARG("--tag", "after")
    d = out / tag
    d.mkdir(parents=True, exist_ok=True)
    proc, base, tmp = start_server()
    try:
        user = login(base, "VisualQA")
        with sync_playwright() as p:
            b = p.chromium.launch(args=GPU_ARGS)
            ctx, A = open_mine(b, base, user, ARG("--size", "1920x1080"), quality=ARG("--quality", "high"))
            G(A, f"() => {GR}.grant('shovel')")
            G(A, f"() => {GR}.grant('pickaxe')")
            G(A, HIDE_UI)
            G(A, f"() => {GR}.setPaused(true)")
            dev(A, "vo.bm.face")
            G(A, f"() => {GR}.equipNow('hand')")
            for name, pose in POSES.items():
                G(A, POSE, [pose, "hand", None])
                time.sleep(0.2)
                A.screenshot(path=str(d / f"close_{name}.png"))
                crop(d / f"close_{name}.png", (0.12, 0.45, 0.88, 1.0))
            # tool grips: idle pose of the tool, hands on it
            G(A, "() => { const g = window.__goldrush.game(), h = g.hands; h.camera.fov = g.camera.fov; h.camera.updateProjectionMatrix(); }")
            for tool in ("shovel", "pickaxe"):
                G(A, f"() => {GR}.equipNow('{tool}')")
                keys = G(A, f"() => {GR}.toolKeys()")[tool]
                G(A, POSE, [None, tool, keys["rest"]])
                time.sleep(0.2)
                A.screenshot(path=str(d / f"close_{tool}_rest.png"))
                crop(d / f"close_{tool}_rest.png", (0.15, 0.45, 1.0, 1.0))
            print("errors:", errors(A)[:6])
            b.close()
    finally:
        proc.terminate()


if __name__ == "__main__":
    main()
