"""GoldRush FP2.0B motion QA: whole sequences, not stills - several strokes in a row per tool, tool switches, looking down, the steep
flank, beside a boulder. Per simulated frame (1/60 s steps) the page reports the tool's and hands' view-space numbers; this script
turns them into checks and writes filmstrips (every few frames) plus an animated GIF per scenario.

  checks (per scenario): pose pops (a position / rotation jump no smooth motion makes), the tool leaving the view, the grip error
  (a hand off its grip), the elbow angles, an arm in front of the lens, the contact gap (shovel), strokes completed.

    python tests/e2e/goldrush_fpmotion.py --out DIR --tag after [--root OLD_REV_DIR] [--only shovel,pick] [--size 1280x720]
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

DT = 1 / 60

# one simulated frame, then everything the checks need (view space of the hands' camera)
STEP = """([n, dt]) => {
  const g = window.__goldrush.game(), h = g.hands, T3 = h.THREE, out = [];
  const P = new T3.Vector3(), q = new T3.Quaternion(), e = new T3.Euler();
  const ndc = (v) => { P.copy(v).project(h.camera); return [P.x, P.y, P.z]; };
  for (let i = 0; i < n; i++) {
    window.__goldrush.stepFrames(1, dt);
    const v = g.tools.view(), tm = h.toolModel, r = { phase: v.phase, state: v.state, cycle: v.cycle, tool: v.tool, u: v.u, kick: g.player.kick };
    if (tm && h.toolRoot.visible) {
      h.toolRoot.updateMatrixWorld(true);
      r.tp = h.toolRoot.position.toArray(); r.tq = h.toolRoot.quaternion.toArray();
      const b = new T3.Box3().setFromObject(tm);
      let x0 = 9, x1 = -9, y0 = 9, y1 = -9;
      for (const cx of [b.min.x, b.max.x]) for (const cy of [b.min.y, b.max.y]) for (const cz of [b.min.z, b.max.z]) { const n3 = ndc(new T3.Vector3(cx, cy, cz)); x0 = Math.min(x0, n3[0]); x1 = Math.max(x1, n3[0]); y0 = Math.min(y0, n3[1]); y1 = Math.max(y1, n3[1]); }
      const ix = Math.max(0, Math.min(1, x1) - Math.max(-1, x0)), iy = Math.max(0, Math.min(1, y1) - Math.max(-1, y0));
      r.vis = (ix * iy) / Math.max(1e-6, (x1 - x0) * (y1 - y0));
      const tip = tm.localToWorld(tm.userData.tip.clone()); r.tipNdc = ndc(tip).slice(0, 2);
    }
    r.hands = [h.right, h.left].map((gl) => {
      gl.root.updateMatrix();
      const W = new T3.Vector3(0, -0.004, 0.035).applyMatrix4(gl.root.matrix), E = gl._e.clone(), U = gl._u.clone();
      const a = W.clone().sub(E).normalize(), c = U.clone().sub(E).normalize();
      const seg = (A, B) => { const ab = B.clone().sub(A), t = Math.max(0, Math.min(1, -A.dot(ab) / ab.lengthSq())); return A.clone().addScaledVector(ab, t).length(); };
      return { w: W.toArray(), wn: ndc(W).slice(0, 2), elbow: Math.acos(Math.max(-1, Math.min(1, a.dot(c)))) * 57.2958, reach: gl.info.reach,
        lens: Math.min(seg(W, E), seg(E, U)), ez: E.z, root: gl.root.position.toArray(), rq: gl.root.quaternion.toArray() };
    });
    r.grip = h.gripError();
    r.contact = h.contactInfo ? { ...h.contactInfo } : null;
    out.push(r);
  }
  return out; }"""

BOOKMARKS = {}


def stroke_run(A, d, name, strokes, shot_every=3, max_steps=900, tool=None, gif=True, crop=(0.0, 0.18, 1.0, 1.0)):
    """hold the dig button for `strokes` strokes, a frame every step; returns the per-frame list"""
    rows, shots = [], []
    cyc0 = G(A, f"() => {GR}.tools().cycles")
    G(A, f"() => {{ {GR}.input().digHeld = true; }}")
    for i in range(max_steps):
        r = G(A, STEP, [1, DT])[0]
        r["i"] = i
        rows.append(r)
        if i % shot_every == 0:
            f = d / f"{name}_{len(shots):03d}.png"
            A.screenshot(path=str(f))
            shots.append((i, f, r))
        if r["cycle"] - cyc0 >= strokes:           # the last stroke has started: let go, it runs to its end
            break
    G(A, f"() => {{ {GR}.input().digHeld = false; }}")
    for k in range(120):                        # let the last stroke finish
        r = G(A, STEP, [1, DT])[0]
        r["i"] = len(rows)
        rows.append(r)
        if r["state"] == "idle":
            break
    filmstrip(d, name, shots, crop)
    return rows


def filmstrip(d, name, shots, crop, cols=8, tw=300):
    from PIL import Image, ImageDraw
    if not shots:
        return
    ims = []
    for i, f, r in shots:
        im = Image.open(f).convert("RGB")
        w, h = im.size
        im = im.crop((int(crop[0] * w), int(crop[1] * h), int(crop[2] * w), int(crop[3] * h)))
        im = im.resize((tw, int(tw * im.size[1] / im.size[0])))
        ims.append((i, r, im))
    th = ims[0][2].size[1]
    rows = (len(ims) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tw, rows * (th + 14)), (14, 14, 14))
    for k, (i, r, im) in enumerate(ims):
        x, y = (k % cols) * tw, (k // cols) * (th + 14)
        sheet.paste(im, (x, y + 14))
        ImageDraw.Draw(sheet).text((x + 3, y + 1), f"{i} {r['state']}/{r['phase']}", fill=(255, 255, 255))
    sheet.save(d / f"film_{name}.png")
    gif = [im.resize((tw * 2 // 1, int(th * 2))) for _, _, im in ims]
    gif[0].save(d / f"anim_{name}.gif", save_all=True, append_images=gif[1:], duration=int(1000 * DT * 3), loop=0)
    for _, f, _ in shots:                          # (keep the disk small: the sheet and the gif are what is looked at)
        try:
            os.remove(f)
        except OSError:
            pass


def analyse(rows, tool):
    """numbers from the per-frame rows"""
    res = {"frames": len(rows), "strokes": (rows[-1]["cycle"] - rows[0]["cycle"] + (1 if rows[0]["state"] == "action" else 0)) if rows else 0}
    pops, rots, minvis, grip, elbows, lens, gaps = [], [], 1.0, 0.0, [999, -1], 9.0, []
    prev = None
    popat = []
    for r in rows:
        if r.get("vis") is not None:
            minvis = min(minvis, r["vis"])
        grip = max(grip, r.get("grip", 0) or 0)
        for h in r["hands"]:
            elbows = [min(elbows[0], h["elbow"]), max(elbows[1], h["elbow"])]
            lens = min(lens, h["lens"])
        if r.get("contact") and r["contact"]["phase"] in ("scoop", "recoil") and r["contact"]["w"] > 0.9:
            gaps.append(r["contact"]["gap"])
        if prev is not None and "tp" in r and "tp" in prev and r["tool"] == prev["tool"]:
            dp = math.dist(r["tp"], prev["tp"])
            a, b = prev["tq"], r["tq"]
            dot = abs(sum(x * y for x, y in zip(a, b)))
            dr = 2 * math.acos(min(1, dot))
            pops.append(dp)
            rots.append(dr)
            popat.append((r["i"], r["phase"], dp, dr))
        prev = r
    # a pop: a one-frame step that is a spike on BOTH sides (more than twice either neighbour step and big enough to read on screen).
    # A stop (the blade meets the ground: big steps before, none after) or a start is motion, not a pop.
    big = []
    for k in range(1, len(popat) - 1):
        i, ph, dp, dr = popat[k]
        nbp = max(popat[k - 1][2], popat[k + 1][2])
        nbr = max(popat[k - 1][3], popat[k + 1][3])
        if (dp > 0.02 and dp > 2 * nbp + 0.01) or (dr > 0.12 and dr > 2 * nbr + 0.06):
            big.append({"i": i, "phase": ph, "dpos": round(dp, 4), "drot": round(dr, 3)})
    res.update({"maxStepPos": round(max(pops), 4) if pops else 0, "maxStepRot": round(max(rots), 3) if rots else 0, "pops": big[:12], "popCount": len(big),
                "minToolVisible": round(minvis, 3), "maxGripErr": round(grip, 4), "elbowDeg": [round(elbows[0], 1), round(elbows[1], 1)],
                "minLensDist": round(lens, 3), "contactGapMax": round(max(gaps), 4) if gaps else None, "contactGapN": len(gaps)})
    res["outOfReach"] = sum(1 for r in rows for h in r["hands"] if not h["reach"])
    # the tip leaving the screen: how many frames with the tip outside |ndc| < 1
    res["tipOut"] = sum(1 for r in rows if r.get("tipNdc") and (abs(r["tipNdc"][0]) > 1 or abs(r["tipNdc"][1]) > 1))
    return res


def main():
    out, tag, quality, size = Path(ARG("--out", "fpmotion")), ARG("--tag", "after"), ARG("--quality", "medium"), ARG("--size", "1280x720")
    only = ARG("--only", "").split(",") if "--only" in sys.argv else None
    d = out / tag
    d.mkdir(parents=True, exist_ok=True)
    report = {"tag": tag, "quality": quality, "scenes": {}}
    want = lambda n: only is None or n in only
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
            aim = lambda pitch, x=None, z=None, yaw=None: G(A, f"(a) => {GR}.aimAt(a)", {"x": st0["x"] if x is None else x, "z": st0["z"] if z is None else z, "yaw": st0["yaw"] if yaw is None else yaw, "pitch": pitch})
            settle = lambda n=12: G(A, f"([n, dt]) => {GR}.stepFrames(n, dt)", [n, DT])

            def scene(name, tool, strokes, pitch=-0.3, pos=None, **kw):
                if not want(name):
                    return
                G(A, f"() => {GR}.equipNow('{tool}')")
                aim(pitch, *(pos or ()))
                G(A, f"() => {GR}.setPaused(true)")
                settle(30)
                rows = stroke_run(A, d, name, strokes, **kw)
                report["scenes"][name] = analyse(rows, tool)
                json.dump(rows, open(d / f"rows_{name}.json", "w"))
                print(name, json.dumps(report["scenes"][name]), flush=True)

            scene("shovel", "shovel", 8, pitch=-0.3, shot_every=4)
            scene("pick", "pickaxe", 6, pitch=-0.3, shot_every=3)
            scene("hand", "hand", 8, pitch=-0.3, shot_every=3)
            scene("shovel_down", "shovel", 4, pitch=-1.2, shot_every=4)
            scene("pick_down", "pickaxe", 4, pitch=-1.2, shot_every=3)
            if want("switch"):
                # hand -> shovel -> pickaxe -> hand: two strokes each, switched the way a player does (lower / raise)
                rows = []
                G(A, f"() => {GR}.equipNow('hand')")
                aim(-0.3)
                settle(20)
                shots = []
                for t in ("hand", "shovel", "pickaxe", "hand"):
                    G(A, f"(t) => {GR}.selectTool(t)", t)
                    for _ in range(40):                         # lower + raise (0.18 + 0.24 s)
                        r = G(A, STEP, [1, DT])[0]
                        r["i"] = len(rows)
                        rows.append(r)
                        if len(rows) % 4 == 0:
                            f = d / f"switch_{len(shots):03d}.png"
                            A.screenshot(path=str(f))
                            shots.append((len(rows), f, r))
                    rows += stroke_run(A, d, f"switch_{t}_{len(rows)}", 2, shot_every=6)
                filmstrip(d, "switch", shots, (0.0, 0.18, 1.0, 1.0))
                report["scenes"]["switch"] = analyse(rows, "switch")
                print("switch", json.dumps(report["scenes"]["switch"]), flush=True)
            if want("flank") or want("boulder"):
                dev(A, "vo.bm.face")
                G(A, f"() => {GR}.setPaused(true)")
                settle(10)
            scene("flank", "shovel", 5, pitch=-0.25, shot_every=4)
            if want("boulder"):
                r = G(A, f"() => {{ const g = {GR}.game(), r = g.rocks.rocks[0]; return {{ x: r.x, z: r.z, r: r.r }}; }}")
                sx, sz = r["x"] + 1.5, r["z"] + 1.1
                yaw = math.atan2(-(r["x"] + 0.3 - sx), -(r["z"] + 0.3 - sz))
                scene("boulder", "shovel", 5, pitch=-0.55, pos=(sx, sz, yaw), shot_every=4)
                scene("boulder_pick", "pickaxe", 4, pitch=-0.55, pos=(sx, sz, yaw), shot_every=3)
            report["errors"] = errors(A)[:6]
            b.close()
    finally:
        proc.terminate()
    json.dump(report, open(d / "report.json", "w", encoding="utf-8"), indent=1)
    print("errors:", report["errors"])


if __name__ == "__main__":
    main()
