"""GoldRush FP2.0A visual QA: the first-person arms and tools in action - stills per state and short motion sequences.

The loop is paused and stepped at a fixed rate (`stepFrames`), a frame is captured every step while a stroke runs; the frames are
tagged with the controller's state / phase, so the sheets show windup / contact / recovery as the game plays them.

  stills    per scene one PNG: idle (empty hands), hand dig (reach / contact / pull), shovel (idle / windup / thrust contact /
            scoop / recovery), pickaxe (idle / windup / swing contact / recovery), looking down, the steep flank, beside a boulder,
            camp and plant light
  seq       a contact sheet of a whole stroke per tool (every captured frame, tagged)
  --root    run on an old revision (git worktree) for the before pictures

    python tests/e2e/goldrush_fpqa.py --out DIR --tag after [--root OLD_REV_DIR] [--quality high] [--size 1280x720]
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
from goldrush_visualqa import open_mine, dev, HIDE_UI  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
G, GR = Q.G, "window.__goldrush"
ARG = lambda k, d: type(d)(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d
if "--root" in sys.argv:
    kopfkicker_e2e.ROOT = Path(sys.argv[sys.argv.index("--root") + 1])

HAND = f"() => {{ const h = {GR}.hand(); return {{ state: h.state, phase: h.phase, cycle: h.cycle, tool: h.tool }}; }}"


def settle(A, n=6, dt=0.05):
    G(A, f"([n, dt]) => {GR}.stepFrames(n, dt)", [n, dt])
    time.sleep(0.15)


def stroke(A, d, name, tool, frames=44, dt=0.04, crop=None):
    """one stroke with a frame per step; returns [(index, state, phase)] and saves the frames"""
    seq = []
    G(A, f"() => {{ {GR}.input().digHeld = true; }}")
    for i in range(frames):
        G(A, f"([dt]) => {GR}.stepFrames(1, dt)", [dt])
        h = G(A, HAND)
        f = d / f"{name}_{i:02d}.png"
        A.screenshot(path=str(f))
        seq.append({"i": i, "state": h["state"], "phase": h["phase"], "cycle": h["cycle"]})
        if i > 6 and h["state"] == "idle":
            break
    G(A, f"() => {{ {GR}.input().digHeld = false; }}")
    settle(A, 8, 0.05)
    return seq


def sheet(d, name, seq, cols=6):
    from PIL import Image, ImageDraw
    ims = [(s, Image.open(d / f"{name}_{s['i']:02d}.png").convert("RGB")) for s in seq]
    if not ims:
        return
    w, h = ims[0][1].size
    sw, sh = w // 3, h // 3
    rows = (len(ims) + cols - 1) // cols
    sh_img = Image.new("RGB", (cols * sw, rows * (sh + 16)), (16, 16, 16))
    for k, (s, im) in enumerate(ims):
        x, y = (k % cols) * sw, (k // cols) * (sh + 16)
        sh_img.paste(im.resize((sw, sh)), (x, y + 16))
        ImageDraw.Draw(sh_img).text((x + 4, y + 2), f"{s['i']} {s['state']}/{s['phase']}", fill=(255, 255, 255))
    sh_img.save(d / f"sheet_{name}.png")


def main():
    out, tag, quality, size = Path(ARG("--out", "fpqa")), ARG("--tag", "after"), ARG("--quality", "high"), ARG("--size", "1280x720")
    d = out / tag
    d.mkdir(parents=True, exist_ok=True)
    meta = {"tag": tag, "quality": quality, "seqs": {}}
    proc, base, tmp = start_server()
    try:
        user = login(base, "VisualQA")
        with sync_playwright() as p:
            b = p.chromium.launch(args=GPU_ARGS)
            ctx, A = open_mine(b, base, user, size, quality=quality)
            G(A, f"() => {GR}.grant('shovel')")
            G(A, f"() => {GR}.grant('pickaxe')")
            G(A, HIDE_UI.replace("'.gr-root > :not(canvas) { visibility: hidden !important; }'", "'.gr-root > :not(canvas) { visibility: hidden !important; }'"))
            G(A, f"() => {GR}.setPaused(true)")
            dev(A, "vo.bm.face")
            st0 = G(A, f"() => {GR}.state()")
            G(A, f"(a) => {GR}.aimAt(a)", {"x": st0["x"], "z": st0["z"], "yaw": st0["yaw"], "pitch": st0["pitch"] - 0.25})
            G(A, f"() => {GR}.setPaused(true)")
            # ---- empty hands
            G(A, f"() => {GR}.equipNow('hand')")
            settle(A, 20, 0.05)
            A.screenshot(path=str(d / "01_hands_idle.png"))
            meta["seqs"]["hand"] = stroke(A, d, "02_hand_dig", "hand", 40)
            sheet(d, "02_hand_dig", meta["seqs"]["hand"])
            # ---- shovel
            G(A, f"() => {GR}.equipNow('shovel')")
            settle(A, 20, 0.05)
            A.screenshot(path=str(d / "03_shovel_idle.png"))
            meta["seqs"]["shovel"] = stroke(A, d, "04_shovel", "shovel", 60)
            sheet(d, "04_shovel", meta["seqs"]["shovel"])
            # ---- pickaxe
            G(A, f"() => {GR}.equipNow('pickaxe')")
            settle(A, 20, 0.05)
            A.screenshot(path=str(d / "05_pickaxe_idle.png"))
            meta["seqs"]["pickaxe"] = stroke(A, d, "06_pickaxe", "pickaxe", 50)
            sheet(d, "06_pickaxe", meta["seqs"]["pickaxe"])
            # ---- looking down, with the shovel
            G(A, f"() => {GR}.equipNow('shovel')")
            G(A, f"(a) => {GR}.aimAt(a)", {"x": st0["x"], "z": st0["z"], "yaw": st0["yaw"], "pitch": -1.25})
            settle(A, 20, 0.05)
            A.screenshot(path=str(d / "07_look_down.png"))
            # ---- steep flank (the mountain face), shovel stroke
            dev(A, "vo.bm.face")
            G(A, f"() => {GR}.setPaused(true)")
            settle(A, 10, 0.05)
            meta["seqs"]["flank"] = stroke(A, d, "08_flank", "shovel", 60)
            sheet(d, "08_flank", meta["seqs"]["flank"])
            # ---- beside a boulder (the first one, stand 1.4 m away and dig next to it)
            r = G(A, f"() => {{ const g = {GR}.game(), r = g.rocks.rocks[0]; return {{ x: r.x, z: r.z, r: r.r }}; }}")
            sx, sz = r["x"] + 1.5, r["z"] + 1.1
            yaw = math.atan2(-(r["x"] + 0.3 - sx), -(r["z"] + 0.3 - sz))
            G(A, f"(a) => {GR}.aimAt(a)", {"x": sx, "z": sz, "yaw": yaw, "pitch": -0.55})
            settle(A, 10, 0.05)
            meta["seqs"]["boulder"] = stroke(A, d, "09_boulder", "shovel", 60)
            sheet(d, "09_boulder", meta["seqs"]["boulder"])
            # ---- camp / plant light (empty hands and shovel idle)
            dev(A, "vo.bm.camp")
            G(A, f"() => {GR}.setPaused(true)")
            settle(A, 20, 0.05)
            A.screenshot(path=str(d / "10_camp_shovel.png"))
            dev(A, "vo.bm.plant")
            G(A, f"() => {GR}.setPaused(true)")
            settle(A, 20, 0.05)
            A.screenshot(path=str(d / "11_plant_shovel.png"))
            meta["errors"] = errors(A)[:6]
            meta["rigged"] = G(A, f"() => {GR}.game().hands.rigged")
            b.close()
    finally:
        proc.terminate()
    json.dump(meta, open(d / "meta.json", "w", encoding="utf-8"), indent=1)
    print("rigged:", meta["rigged"], "errors:", meta["errors"])
    for k, v in meta["seqs"].items():
        ph = []
        for s in v:
            key = f"{s['state']}/{s['phase']}"
            if not ph or ph[-1] != key:
                ph.append(key)
        print(k, " -> ".join(ph))


if __name__ == "__main__":
    main()
