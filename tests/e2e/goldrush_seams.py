"""GoldRush terrain seam check (Earth 2.0A/B/C): no cracks between LOD tiles, none along tile borders.

Everything but the terrain's tiles is hidden, the background is pure magenta, tone mapping and fog are off, and the camera looks
straight DOWN onto the dug terrain (so the whole view is terrain) from positions over the tile borders, with every LOD mix the
tiles can take (all fine, all coarse, checker, stripes, random). The terrain is opaque: a magenta pixel is a hole - a crack
between two tiles / two LOD levels, or a missing triangle. Result: magenta pixels per case; every case must be 0.

    python tests/e2e/goldrush_seams.py [--size 960x540] [--quality medium]
"""

import json
import os
import random
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from goldrush_e2e import GPU_ARGS, errors  # noqa: E402
import goldrush_quality_e2e as Q  # noqa: E402
from goldrush_visualqa import open_mine, HIDE_UI  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
G, GR = Q.G, "window.__goldrush"
ARG = lambda k, d: type(d)(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d

JS_PREP = """() => {
  const g = window.__goldrush.game(), S = g.world.scene, T = g.terrain, THREE = T.THREE;
  window.__seam = { hidden: [], bg: S.background, fog: S.fog, env: S.environment, tm: g.renderer.toneMapping };
  S.traverse((o) => { if ((o.isMesh || o.isPoints || o.isLine || o.isSprite) && !(o.name || '').startsWith('terrain-chunk') && o.visible) { window.__seam.hidden.push(o); o.visible = false; } });
  S.fog = null; S.environment = null; S.background = new THREE.Color(1, 0, 1);
  g.renderer.toneMapping = THREE.NoToneMapping;
  return T.view.tiles.length;
}"""
JS_LOD = """([mode, seed]) => {
  const V = window.__goldrush.game().terrain.view; let r = seed;
  const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647;
  V.opts.force = null; V.forceCoarse = false;
  for (const t of V.tiles) t.lod = mode === 'fine' ? 0 : mode === 'coarse' ? 1 : mode === 'checker' ? (t.cx + t.cz) % 2 : mode === 'stripes' ? t.cx % 2 : rnd() < 0.5 ? 0 : 1;
  V._applyLod(true);
  if (!V._seamKeep) { V._seamKeep = V.update; V.update = () => {}; }       // (keep this pattern: no per-frame LOD choice)
  return V.tiles.map((t) => t.lod).join('');
}"""
JS_COUNT = """([c, t]) => {
  const g = window.__goldrush.game(), S = g.world.scene, cam = g.camera, r = g.renderer;
  cam.position.set(c[0], c[1], c[2]); cam.up.set(0, 0, -1); cam.lookAt(t[0], t[1], t[2]); cam.updateMatrixWorld();
  g.terrain.view.flush(r);
  r.setRenderTarget(null);
  r.render(S, cam);
  const gl = r.getContext(), W = r.domElement.width, H = r.domElement.height, px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let mag = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] > 200 && px[i + 1] < 60 && px[i + 2] > 200) mag++;
  cam.up.set(0, 1, 0);
  return { mag, tot: W * H };
}"""


def main():
    size = ARG("--size", "960x540")
    proc, base, tmp = start_server()
    cases, tiles, errs = [], 0, None
    try:
        user = login(base, "VisualQA")
        with sync_playwright() as p:
            b = p.chromium.launch(args=GPU_ARGS)
            ctx, A = open_mine(b, base, user, size, quality=ARG("--quality", "medium"))
            G(A, HIDE_UI)
            G(A, f"() => {GR}.setPaused(true)")
            # some digging first (the heights are not the pristine pile any more, imprints exist)
            G(A, f"() => {GR}.grant('shovel')")
            G(A, f"() => {GR}.equipNow('shovel')")
            for i in range(10):
                G(A, f"(a) => {GR}.aimAt(a)", {"x": -1.0 + 0.3 * (i % 5), "z": 6.0 - 0.9 * (i // 5), "yaw": 0.0, "pitch": -0.9})
                G(A, f"() => {GR}.act({{ tool: 'shovel' }})")
            tiles = G(A, JS_PREP)
            # tile borders are at x = -15 + 3.75 k, z = -21 + 3.75 k
            cams = [("center", [0, 12, -6], [0, 0, -6]), ("border_x", [-3.75, 9, -6], [-3.75, 0, -6]), ("border_x2", [3.75, 9, -9.75], [3.75, 0, -9.75]),
                    ("border_z", [3.75, 9, -2.25], [3.75, 0, -2.25]), ("corner", [0, 9, -13.5], [0, 0, -13.5]), ("dug", [-1.0, 5, 3.0], [-1.0, 0, 3.0]),
                    ("steep", [0.4, 8, -9], [0.4, 0, -9])]
            rng = random.Random(7)
            for mode in ["fine", "coarse", "checker", "stripes", "rand1", "rand2", "rand3", "rand4"]:
                pat = G(A, JS_LOD, [mode, rng.randint(1, 2 ** 30)])
                for name, c, t in cams:
                    cases.append({"mode": mode, "cam": name, "lods": pat, **G(A, JS_COUNT, [c, t])})
            errs = errors(A)[:4]
            b.close()
    finally:
        proc.terminate()
    bad = [c for c in cases if c["mag"] > 0]
    print(f"tiles {tiles}, cases {len(cases)}, with holes {len(bad)}")
    for c in bad[:10]:
        print("  HOLE", c["mode"], c["cam"], c["mag"], "px", c["lods"])
    print("magenta total:", sum(c["mag"] for c in cases), "errors:", errs)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
