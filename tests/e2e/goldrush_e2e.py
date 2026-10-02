"""End-to-end check of GoldRush phase 1 (3D foundation + diggable mound)
against the real server, run from a temp copy - the real database is never
touched. Chromium uses the real GPU where there is one (ANGLE/D3D11).

    python tests/e2e/goldrush_e2e.py [--shots DIR] [--browser webkit] [--perf | --perf-only]

    --perf        also measures FPS / frame time in all target viewports
    --perf-only   only that measurement

Requires: pip install playwright pillow && python -m playwright install chromium
"""

import io
import json
import math
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from games_regression import RECORDER, open_games_drawer  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):       # Windows consoles: the check names contain ⛏️ / €
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

RESULTS = []
GPU_ARGS = ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--js-flags=--expose-gc"]
NOISE = ("favicon", "WebSocket connection", 'Viewport argument key "interactive-widget"')

# a browser without WebGL: every webgl/webgl2 context request fails
NO_WEBGL = """(() => {
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...a) { return /webgl/i.test(String(type)) ? null : orig.call(this, type, ...a); };
})();"""

READY = "() => !!(window.__goldrush && document.querySelector('.gr-loading') && document.querySelector('.gr-loading').hidden)"
START = "() => { const s = document.querySelector('.gr-start'); return !!(s && !s.hidden); }"
# the logged-in player's save key (phase 5: one mine per account) - tests use grKey() / grKey('.backup')
GRKEY = ("window.grKey = (suffix = '') => { let id = 'guest'; try { const u = JSON.parse(localStorage.getItem('instachat_user') || 'null');"
         " if (u && u.id != null) id = 'u' + u.id; } catch (e) { /* none */ } return 'goldrush.save.' + id + suffix; };")

# stand in front of the mound's foot (measured along a line towards its
# centre) and look down until the hand reaches the flank
AIM_AT_MOUND = """({ ang, back, maxd }) => {
  const G = window.__goldrush, cx = 0, cz = -6;
  const dx = Math.sin(ang), dz = Math.cos(ang);
  let foot = null;
  for (let d = 15; d > 0; d -= 0.05) if (G.heightAt(cx + dx * d, cz + dz * d) > 0.35) { foot = d; break; }
  if (foot == null) return null;
  const x = cx + dx * (foot + back), z = cz + dz * (foot + back), yaw = Math.atan2(dx, dz);
  for (let pt = -0.1; pt > -1.25; pt -= 0.05) if (G.pose({ x, z, yaw, pitch: pt }) && G.state().targetDist <= (maxd || 9)) return { x, z, yaw, pitch: pt };
  return null;
}"""

# n digs like a player holding the button at one spot: re-aim, and step in
# when the hole has moved out of reach
DIG_HERE = """({ ang, n }) => {
  const G = window.__goldrush, cx = 0, cz = -6;
  const dx = Math.sin(ang), dz = Math.cos(ang), yaw = Math.atan2(dx, dz);
  let st = G.state(), x = st.x, z = st.z, done = 0, tries = 0, ms = 0;
  for (let i = 0; i < n && tries < 400; i++) {
    let ok = false;
    for (let pt = -0.1; pt > -1.25 && !ok; pt -= 0.05) ok = G.pose({ x, z, yaw, pitch: pt });
    if (!ok) { x -= dx * 0.15; z -= dz * 0.15; tries++; i--; continue; }
    const r = G.digAtCrosshair(1);
    done += r.done; ms += r.ms;
  }
  return { done, perDig: done ? ms / done : 0 };
}"""

GEOMETRY_OK = """() => {
  const t = window.__goldrush.terrain();
  let bad = 0, verts = 0;
  for (const ch of t.chunks) {
    for (const name of ['position', 'normal', 'color']) {
      const a = ch.geom.attributes[name].array;
      for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) bad++;
      if (name === 'position') verts += a.length / 3;
    }
    const s = ch.geom.boundingSphere;
    if (!s || !Number.isFinite(s.radius) || !Number.isFinite(s.center.x)) bad++;
  }
  return { ok: bad === 0 && t.validate(), bad, verts };
}"""

# open GoldRush and press "Abbrechen" on the loading screen after `delay`
# ms; returns the load progress (%) at that moment, -1 if it had finished
CANCEL_WHILE_LOADING = """(delay) => new Promise((res) => {
  launchGameByType('goldrush');
  let t0 = null;
  const tick = () => {
    // phase 5: the start screen first - continue (or start) the mine, then leave while it loads
    if (t0 == null) {
      const st = document.querySelector('.gr-start');
      if (!st || st.hidden) { setTimeout(tick, 4); return; }
      const c = st.querySelector('[data-act=start-continue]');
      (c && !c.hidden ? c : st.querySelector('[data-act=start-new]')).click();
      t0 = performance.now();
    }
    const b = document.querySelector('.gr-loading-cancel'), l = document.querySelector('.gr-loading');
    if (b && performance.now() - t0 >= delay) {
      if (l.hidden || l.classList.contains('is-done')) { res(-1); return; }
      const pct = +l.querySelector('.gr-progress').getAttribute('aria-valuenow');
      b.click();
      res(pct);
      return;
    }
    setTimeout(tick, 4);
  };
  tick();
})"""

FRAME_REC = """() => {
  const r = window.__frames = { t: [], on: true };
  let last = performance.now();
  const tick = (now) => { if (!r.on) return; r.t.push(now - last); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}"""

FRAME_STOP = """() => {
  const r = window.__frames; r.on = false;
  const t = r.t.slice(2).sort((a, b) => a - b);
  if (!t.length) return null;
  const avg = t.reduce((a, b) => a + b, 0) / t.length;
  return { frames: t.length, avg: +avg.toFixed(2), p95: +t[Math.floor(t.length * 0.95)].toFixed(2), max: +t[t.length - 1].toFixed(2) };
}"""

CONTRAST = r"""(sel) => {
  const parse = (c) => {
    let m = c.match(/rgba?\(([^)]+)\)/);
    if (m) { const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    m = c.match(/color\(srgb ([^)]+)\)/);
    if (m) { const p = m[1].split(/[\s\/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1]; }
    return [0, 0, 0, 0];
  };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const el = document.querySelector(sel);
  const fg = parse(getComputedStyle(el).color);
  // the first painted background up the tree (text itself sits on its card/chip)
  let e = el, bg = [0, 0, 0, 0];
  while (e && e !== document.documentElement) { bg = parse(getComputedStyle(e).backgroundColor); if (bg[3] > 0) break; e = e.parentElement; }
  // translucent chips sit on the 3D scene: judge them against a dark and a light backdrop
  const over = (c, base) => [0, 1, 2].map((i) => c[i] * c[3] + base[i] * (1 - c[3]));
  const worst = [[40, 34, 28], [225, 205, 170]].map((b) => { const B = over(bg, b), L1 = lum(fg), L2 = lum(B); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); });
  return { ratio: +Math.min(...worst).toFixed(2), fg: getComputedStyle(el).color, bg: getComputedStyle(e || el).backgroundColor };
}"""

VIEWPORTS = [
    ("1366x768", dict(viewport={"width": 1366, "height": 768})),
    ("1440x900", dict(viewport={"width": 1440, "height": 900})),
    ("1920x1080", dict(viewport={"width": 1920, "height": 1080})),
    ("390x844", dict(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True)),
    ("412x915", dict(viewport={"width": 412, "height": 915}, device_scale_factor=2.625, is_mobile=True, has_touch=True)),
    ("430x932", dict(viewport={"width": 430, "height": 932}, device_scale_factor=3, is_mobile=True, has_touch=True)),
    ("844x390", dict(viewport={"width": 844, "height": 390}, device_scale_factor=3, is_mobile=True, has_touch=True)),
    ("915x412", dict(viewport={"width": 915, "height": 412}, device_scale_factor=2.625, is_mobile=True, has_touch=True)),
]
PHONE = dict(VIEWPORTS[3][1])


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def wait_for(fn, timeout=10, step=0.05):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return v
        time.sleep(step)
    return None


def client(browser, base, user, ctx_kw, extra_init=()):
    ctx = browser.new_context(**ctx_kw)
    ctx.add_init_script(f"localStorage.setItem('instachat_token', {json.dumps(user['token'])});"
                        f"localStorage.setItem('instachat_user', {json.dumps(json.dumps(user['user']))});")
    ctx.add_init_script(RECORDER)
    ctx.add_init_script(GRKEY)
    for s in extra_init:
        ctx.add_init_script(s)
    page = ctx.new_page()
    page.errors = []
    page.warnings = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    page.on("console", lambda m: page.errors.append(m.text) if m.type == "error" else (page.warnings.append(m.text) if m.type == "warning" else None))
    page.goto(base + "/")
    page.wait_for_function("() => typeof ws !== 'undefined' && ws && ws.readyState === 1", timeout=15000)
    return ctx, page


def errors(page):
    return [e for e in page.errors if not any(n in e for n in NOISE)]


def gr_open(page, via_library=False):
    if via_library:            # games panel -> "Alle Spiele" -> GoldRush "Spielen"
        open_games_drawer(page)
        page.click("#open-games-library-btn")
        page.click("#game-type-list .game-type-item:has-text('GoldRush') .game-type-play-btn")
    else:
        page.evaluate("() => launchGameByType('goldrush')")


def gr_ready(page, timeout=60000, choice="auto"):
    """Through the start screen (continue the player's mine - or start one), until the world is up.
    choice: "auto" | "continue" | "new" | None (leave the start screen to the caller)"""
    page.wait_for_function(f"() => ({READY})() || ({START})()", timeout=timeout)
    if page.evaluate(START) and choice:
        has = page.is_visible(".gr-start [data-act=start-continue]")
        if choice == "continue" or (choice == "auto" and has):
            page.click(".gr-start [data-act=start-continue]")
        else:
            page.click(".gr-start [data-act=start-new]")
            if has:                                        # a mine exists: the destructive question
                page.wait_for_selector(".gr-dialog:not([hidden]) [data-act='dlg:new']", timeout=5000)
                page.click(".gr-dialog [data-act='dlg:new']")
    page.wait_for_function(READY, timeout=timeout)


def gr_start(page):
    """Desktop: 'Loslegen' (pointer lock). Touch: already running."""
    if page.is_visible(".gr-pause"):
        page.click(".gr-pause [data-act=resume]")
    return wait_for(lambda: page.evaluate("() => window.__goldrush && window.__goldrush.state().running"), 5)


def gr_pause(page):
    if page.evaluate("() => window.__goldrush.state().paused"):
        return
    if page.evaluate("() => window.__goldrush.state().free"):
        page.keyboard.press("Escape")               # free-mouse mode (no pointer lock in this browser)
    else:
        page.evaluate("() => document.exitPointerLock && document.exitPointerLock()")
    wait_for(lambda: page.evaluate("() => window.__goldrush.state().paused"), 3)


def gr_close(page):
    """The way a player leaves: pause menu (desktop) or the HUD button (touch)."""
    if page.evaluate("() => !document.querySelector('.gr-root')"):
        return True
    if page.evaluate("() => !!document.pointerLockElement"):
        gr_pause(page)
    if page.is_visible(".gr-pause"):
        page.click(".gr-pause [data-act=exit]")
    elif page.is_visible(".gr-panel"):
        page.click(".gr-panel [data-act=exit]")
    elif page.is_visible(".gr-dialog"):
        page.click(".gr-dialog [data-act='dlg:exit']")
    elif page.is_visible(".gr-start"):                  # phase 5: still on the start screen -> "Zurück"
        page.click(".gr-start [data-act=exit]")
    else:
        page.click(".gr-hud [data-act=exit]")
    return wait_for(lambda: page.evaluate("() => !document.querySelector('.gr-root') && !document.documentElement.classList.contains('goldrush-active')"), 5)


def st(page):
    return page.evaluate("() => window.__goldrush.state()")


def idle(page):
    return page.evaluate("() => window.__idle()")


def heap_mb(page):
    return page.evaluate("() => { if (window.gc) { window.gc(); window.gc(); } return performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null; }")


def shot(page, shots, name):
    if shots:
        page.screenshot(path=str(shots / f"goldrush_{name}.png"))


def canvas_variance(page):
    """Is there a rendered 3D scene (not a blank/black canvas)?"""
    from PIL import Image, ImageStat
    img = Image.open(io.BytesIO(page.locator(".gr-canvas").screenshot())).convert("L").resize((160, 90))
    return ImageStat.Stat(img).stddev[0]


def touch(cdp, kind, points):
    cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [
        {"x": x, "y": y, "id": i, "radiusX": 6, "radiusY": 6, "force": 1} for (i, x, y) in points]})


# ------------------------------------------------------------------ tests

def desktop_suite(browser, base, user, shots, engine):
    ctx, A = client(browser, base, user, dict(viewport={"width": 1440, "height": 900}))
    listeners0 = A.evaluate("() => window.__listeners()")
    idle0 = idle(A)

    # ---- TEST 1: open from the library -> loading -> world
    A.evaluate("""() => {
      window.__load = { seen: false, max: 0, steps: [] };
      new MutationObserver(() => {
        const l = document.querySelector('.gr-loading'); if (!l) return;
        const bar = l.querySelector('.gr-progress'), step = l.querySelector('[data-role=load-step]');
        if (!l.hidden) window.__load.seen = true;
        window.__load.max = Math.max(window.__load.max, +bar.getAttribute('aria-valuenow'));
        const s = step.textContent; if (s && window.__load.steps[window.__load.steps.length - 1] !== s) window.__load.steps.push(s);
      }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    }""")
    gr_open(A, via_library=True)
    # phase 5: a start screen first - a first visit has no mine, so starting one is the main action
    A.wait_for_selector(".gr-start:not([hidden])", timeout=8000)
    first = A.evaluate("""() => ({ cont: !document.querySelector('.gr-start [data-act=start-continue]').hidden, label: document.querySelector('.gr-start [data-act=start-new]').textContent,
      main: document.querySelector('.gr-start [data-act=start-new]').classList.contains('gr-btn-gold'), mine: !document.querySelector('[data-role=start-mine]').hidden })""")
    ok("T1 first visit: the start screen offers 'Neue Mine starten' as the main action (no empty 'Fortsetzen')",
       not first["cont"] and first["label"] == "Neue Mine starten" and first["main"] and not first["mine"], str(first))
    t0 = time.time()
    A.click(".gr-start [data-act=start-new]")
    A.wait_for_selector(".gr-loading", timeout=5000)
    brand = A.inner_text(".gr-loading-inner")
    gr_ready(A)
    load_s = time.time() - t0
    load = A.evaluate("() => window.__load")
    ok("T1 loading screen '⛏️ GoldRush – Mine wird vorbereitet …' with real progress steps",
       "GoldRush" in brand and "Mine wird vorbereitet" in brand and load["seen"] and load["max"] == 100 and len(load["steps"]) >= 5,
       f"{load_s:.2f}s steps={load['steps']}")
    info = A.evaluate("() => window.__goldrush.info()")
    hud = A.evaluate("""() => ({ brand: document.querySelector('.gr-brand').innerText.replace(/\\s+/g, ' ').trim(),
      money: document.querySelector('.gr-money').innerText, tool: document.querySelector('.gr-tool').innerText.trim(),
      one: document.querySelectorAll('.gr-root').length, chat: getComputedStyle(document.querySelector('.gr-root')).position })""")
    var = canvas_variance(A)
    ok("T1 the world renders (64 terrain chunks, >100k triangles, a real image)",
       info["chunks"] == 64 and info["triangles"] > 100000 and info["drawCalls"] > 40 and var > 12,
       f"{info['drawCalls']} calls, {info['triangles']} tris, level {info['level']}, dpr {info['dpr']}, var {var:.1f}, gpu {info['gpu']}")
    ok("T1 HUD: ⛏️ GoldRush, € 0,00, Hand - immersive fullscreen layer",
       hud["brand"] == "⛏️ GoldRush" and hud["money"].replace(" ", " ") == "€ 0,00" and hud["tool"] == "Hand" and hud["one"] == 1 and hud["chat"] == "fixed", str(hud))
    ok("T1 three.js is the vendored r176", A.evaluate("() => window.__goldrush.three") == "176")
    shot(A, shots, "desktop_start")

    # ---- TEST 4: WASD + mouse look (pointer lock)
    started = gr_start(A)
    free = st(A)["free"]
    ok("T4 'Loslegen' takes the pointer lock (or, where the browser has none, runs with the free mouse) and starts the loop",
       started and (st(A)["locked"] or free), "free-mouse mode" if free else "pointer lock")
    s0 = st(A)
    A.keyboard.down("w")
    time.sleep(1.0)
    A.keyboard.up("w")
    time.sleep(0.3)
    s1 = st(A)
    walked = math.hypot(s1["x"] - s0["x"], s1["z"] - s0["z"])
    A.keyboard.down("Shift")
    A.keyboard.down("s")
    time.sleep(0.6)
    A.keyboard.up("s")
    A.keyboard.up("Shift")
    time.sleep(0.3)
    s2 = st(A)
    A.keyboard.down("d")
    time.sleep(0.5)
    A.keyboard.up("d")
    time.sleep(0.3)
    s3 = st(A)
    ok("T4 W walks forward (~3.4 m/s), Shift+S sprints back, D strafes right",
       2.4 < walked < 4.3 and s2["z"] > s1["z"] + 2.0 and s3["x"] > s2["x"] + 1.0,
       f"W {walked:.2f} m, back {s2['z'] - s1['z']:.2f} m, strafe {s3['x'] - s2['x']:.2f} m")
    A.mouse.move(700, 450)
    y0 = st(A)
    if free:
        A.mouse.down(button="right")                # free mouse: drag with the right button to look
    for i in range(10):
        A.mouse.move(700 + (i + 1) * 20, 450 + (i + 1) * 4)
        time.sleep(0.02)
    if free:
        A.mouse.up(button="right")
    time.sleep(0.15)
    y1 = st(A)
    ok("T4 mouse turns the view (yaw right, pitch down)",
       y1["yaw"] < y0["yaw"] - 0.2 and y1["pitch"] < y0["pitch"], f"yaw {y0['yaw']:.2f}->{y1['yaw']:.2f} pitch {y0['pitch']:.2f}->{y1['pitch']:.2f}")

    # ---- TEST 5: pointer lock release and re-acquire
    A.keyboard.press("Escape")
    released = wait_for(lambda: not st(A)["locked"], 3)
    if not released:            # headless Chromium may not route Esc to the lock: release like the browser would
        A.evaluate("() => document.exitPointerLock()")
        released = wait_for(lambda: not st(A)["locked"], 3)
    s = st(A)
    ok("T5 Esc releases the pointer lock -> paused, pause card visible, loop stopped",
       released and s["paused"] and not s["running"] and A.is_visible(".gr-pause"), str({k: s[k] for k in ("locked", "paused", "running")}))
    chat_open = A.evaluate("() => document.querySelector('.gr-root') && document.documentElement.classList.contains('goldrush-active')")
    ok("T5 Esc stays inside GoldRush (the app's own Esc handler does not close/navigate)", chat_open)
    time.sleep(1.4)             # Chromium refuses a re-lock right after an Esc exit
    A.click(".gr-pause [data-act=resume]")
    relocked = wait_for(lambda: (st(A)["locked"] or free) and st(A)["running"], 4)
    if not relocked and A.is_visible(".gr-pause"):
        A.click(".gr-pause [data-act=resume]")
        relocked = wait_for(lambda: (st(A)["locked"] or free) and st(A)["running"], 4)
    ok("T5 'Weiterspielen' re-acquires the lock (free mouse: simply resumes)", relocked)

    # ---- TEST 7: raycast
    aim = A.evaluate(AIM_AT_MOUND, {"ang": 0.0, "back": 1.3})
    cross = A.evaluate("() => document.querySelector('.gr-crosshair').dataset.state")
    sky = A.evaluate("(a) => window.__goldrush.pose({ x: a.x, z: a.z, yaw: a.yaw, pitch: 0.6 })", aim)
    far = A.evaluate("(a) => window.__goldrush.pose({ x: a.x, z: a.z + 4.5, yaw: a.yaw, pitch: a.pitch })", aim)
    away = A.evaluate("(a) => window.__goldrush.pose({ x: a.x, z: a.z, yaw: a.yaw + Math.PI, pitch: -0.6 })", aim)
    ok("T7 raycast: flank in reach -> target (crosshair 'dig'); sky / >2.4 m / flat ground behind -> none",
       aim and cross == "dig" and not sky and not far and not away, f"aim {aim} sky {sky} far {far} away {away}")

    # real input: hold LMB -> the hand's pace (phase 3: ~2.4 strokes per second, a slow start)
    A.evaluate(AIM_AT_MOUND, {"ang": 0.0, "back": 1.3, "maxd": 1.7})
    d0 = st(A)["digs"]
    rev0 = st(A)["revision"]
    h0 = A.evaluate("(a) => window.__goldrush.heightAt(a.x, a.z - 1.6)", aim)
    A.mouse.down()
    t0 = time.time()
    time.sleep(2.5)
    A.mouse.up()
    dt = time.time() - t0
    d1 = st(A)["digs"]
    rate = (d1 - d0) / dt
    ok("T7 holding the left mouse button digs at the hand's pace (2-3 strokes per second) and changes the terrain",
       2.0 <= rate <= 3.1 and st(A)["revision"] > rev0, f"{d1 - d0} digs in {dt:.2f}s = {rate:.2f}/s, h {h0:.3f}")

    # ---- TEST 8: 100 digs the way a player does them (button held, view
    # sweeping over the flank, stepping in) - frame times meanwhile
    A.evaluate(FRAME_REC)
    time.sleep(1.5)
    calm = A.evaluate(FRAME_STOP)
    A.evaluate(AIM_AT_MOUND, {"ang": -0.3, "back": 1.3, "maxd": 1.7})
    A.mouse.move(720, 450)
    d0 = st(A)["digs"]
    A.evaluate(FRAME_REC)
    A.mouse.down()
    if free:
        A.mouse.down(button="right")
    t0, k, my = time.time(), 0, 450
    while st(A)["digs"] - d0 < 100 and time.time() - t0 < 75:          # phase 3: the hand does ~2.4 strokes/s
        k += 1
        phase = k % 60
        if not st(A)["target"]:
            my += 6                                                   # lost the flank: look a bit lower ...
            if k % 8 == 0:                                            # ... and step in
                A.keyboard.down("w")
                time.sleep(0.12)
                A.keyboard.up("w")
        A.mouse.move(570 + 8 * (phase if phase < 30 else 60 - phase), my)   # sweep left/right
        time.sleep(0.05)
    A.mouse.up()
    if free:
        A.mouse.up(button="right")
    busy = A.evaluate(FRAME_STOP)
    n100 = st(A)["digs"] - d0
    per_dig = A.evaluate("() => { const t0 = performance.now(); const r = window.__goldrush.digAtCrosshair(5); return r.done ? r.ms / r.done : null; }")
    size100 = A.evaluate("() => window.__goldrush.save()")
    # Playwright's WebKit on Windows renders WebGL in software (~15 FPS): its
    # single worst frame says nothing about the game, p95 still has to hold
    strict = engine == "chromium"
    ok("T8 100 digs while playing: no frame drops (p95 frame time at the calm level)",
       n100 >= 100 and busy and busy["p95"] < max(34, calm["p95"] * 1.6) and (not strict or busy["max"] < max(120, calm["max"] * 2.5)),
       f"{n100} digs in {time.time() - t0:.1f}s, calm {calm} busy {busy}, one dig {per_dig and round(per_dig, 2)} ms, save {size100} B")
    shot(A, shots, "desktop_after100")

    # ---- TEST 9: 500 digs - still valid geometry, no NaN (strokes on stone
    # move nothing and don't count, so keep going until 500 did)
    for k in range(40):
        if st(A)["digs"] >= 500:
            break
        ang = -2.4 + (k % 10) * 0.52 + (k // 10) * 0.17
        if A.evaluate(AIM_AT_MOUND, {"ang": ang, "back": 1.3}):
            A.evaluate(DIG_HERE, {"ang": ang, "n": 20})
    total = st(A)["digs"]
    geo = A.evaluate(GEOMETRY_OK)
    size500 = A.evaluate("() => window.__goldrush.save()")
    ok("T9 500+ digs: heights/normals/colours finite, within floor limits, bounds valid",
       total >= 500 and geo["ok"], f"digs {total}, {geo}, save {size500} B")
    info = A.evaluate("() => window.__goldrush.info()")
    ok("T9 particles/fragments stay within their pools", info["particles"] <= 260 and info["fragments"] <= 40, f"{info['particles']} / {info['fragments']}")
    A.evaluate("() => window.__goldrush.pose({ x: 3, z: 9, yaw: 0.3, pitch: -0.05 })")
    time.sleep(0.3)
    shot(A, shots, "desktop_after500")

    # ---- TEST 10/11: save + reload keeps terrain, position, seed
    probe_pts = [[-0.5 + 0.25 * i, 0.9 + 0.2 * (i % 5)] for i in range(12)]
    A.evaluate("() => window.__goldrush.pose({ x: 2.2, z: 7.4, yaw: 0.4, pitch: -0.12 })")
    before = A.evaluate("""(pts) => { const G = window.__goldrush, s = G.state(); G.save();
      return { seed: s.seed, x: s.x, z: s.z, yaw: s.yaw, digs: s.digs, sig: G.baseSignature(),
               h: pts.map(([x, z]) => G.heightAt(x, z)) }; }""", probe_pts)
    gr_close(A)
    gr_open(A)
    gr_ready(A)
    after = A.evaluate("""(pts) => { const G = window.__goldrush, s = G.state();
      return { seed: s.seed, x: s.x, z: s.z, yaw: s.yaw, digs: s.digs, sig: G.baseSignature(), h: pts.map(([x, z]) => G.heightAt(x, z)) }; }""", probe_pts)
    dh = max(abs(a - b) for a, b in zip(before["h"], after["h"]))
    ok("T10 close + reopen: dug terrain identical (mm), same seed and mound",
       after["seed"] == before["seed"] and after["sig"] == before["sig"] and dh < 0.0015 and after["digs"] == before["digs"], f"max dh {dh * 1000:.2f} mm")
    ok("T11 player position and view survive", abs(after["x"] - before["x"]) < 0.01 and abs(after["z"] - before["z"]) < 0.01 and abs(after["yaw"] - before["yaw"]) < 0.01)
    gr_close(A)
    A.reload()
    A.wait_for_function("() => typeof ws !== 'undefined' && ws && ws.readyState === 1", timeout=15000)
    gr_open(A)
    gr_ready(A)
    again = A.evaluate("""(pts) => { const G = window.__goldrush, s = G.state();
      return { seed: s.seed, h: pts.map(([x, z]) => G.heightAt(x, z)) }; }""", probe_pts)
    dh2 = max(abs(a - b) for a, b in zip(before["h"], again["h"]))
    ok("T10 ... also after a full page reload", again["seed"] == before["seed"] and dh2 < 0.0015, f"max dh {dh2 * 1000:.2f} mm")
    doc = A.evaluate("() => JSON.parse(localStorage.getItem(grKey()))")
    ok("T10 save document: current version, seed, money as integer cents, only the hand owned, timestamps, compact terrain, the player's own (settings on the device)",
       doc["saveVersion"] == 5 and doc["worldSeed"] == before["seed"] and isinstance(doc["economy"]["cashCents"], int) and doc["tools"]["owned"] == ["hand"]
       and doc["createdAt"] <= doc["updatedAt"] and doc["terrain"] and "settings" not in doc and doc.get("owner", {}).get("id") == str(user["user"]["id"]),
       f"{len(json.dumps(doc))} B, terrain keys {list(doc['terrain'].keys())}")

    # ---- TEST 13: LOW / MEDIUM / HIGH without reload
    gr_start(A)
    gr_pause(A)
    A.click(".gr-pause [data-act=settings]")
    A.evaluate("() => { document.querySelector('.gr-canvas').__marker = 1; window.__goldrush.__marker = 1; }")
    levels = {}
    for q in ("low", "medium", "high", "auto"):
        A.click(f".gr-seg [data-q={q}]")
        time.sleep(0.25)
        A.evaluate("() => window.__goldrush.pose({})")
        levels[q] = A.evaluate("""() => { const G = window.__goldrush, i = G.info(), t = G.terrain();
          return { level: i.level, dpr: i.dpr, calls: i.drawCalls, tris: i.triangles, stride: t.stride,
                   same: document.querySelector('.gr-canvas').__marker === 1 && G.__marker === 1,
                   checked: document.querySelector('.gr-seg [aria-checked=true]').dataset.q }; }""")
    ok("T13 quality switches instantly, same canvas/game (no reload), LOW halves terrain triangles",
       all(v["same"] for v in levels.values()) and levels["low"]["level"] == "low" and levels["high"]["level"] == "high"
       and levels["low"]["stride"] == 2 and levels["medium"]["stride"] == 1 and levels["low"]["tris"] < levels["medium"]["tris"]
       and levels["high"]["dpr"] >= levels["low"]["dpr"] and levels["auto"]["checked"] == "auto",
       json.dumps(levels))
    A.click(".gr-panel [data-act=close-settings]")

    # ---- TEST 14: resize
    sizes = []
    for w, h in ((1366, 768), (1920, 1080), (1000, 700), (1440, 900)):
        A.set_viewport_size({"width": w, "height": h})
        time.sleep(0.35)
        sizes.append(A.evaluate("""() => { const c = document.querySelector('.gr-canvas'), G = window.__goldrush.info();
          return { cw: c.width, ch: c.height, w: c.clientWidth, h: c.clientHeight, dpr: G.dpr }; }"""))
    ok("T14 resize: drawing buffer follows the window at the capped pixel ratio",
       all(abs(s["cw"] - round(s["w"] * s["dpr"])) <= 1 and abs(s["ch"] - round(s["h"] * s["dpr"])) <= 1 for s in sizes)
       and [s["w"] for s in sizes] == [1366, 1920, 1000, 1440], str(sizes))

    # ---- TEST 16: tab hidden / visible
    gr_start(A)
    upd0 = A.evaluate("() => JSON.parse(localStorage.getItem(grKey())).updatedAt")
    A.evaluate("() => window.__goldrush.digAtCrosshair(0)")
    A.evaluate("""() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange')); }""")
    hid = st(A)
    rafs = idle(A)
    upd1 = A.evaluate("() => JSON.parse(localStorage.getItem(grKey())).updatedAt")
    A.evaluate("""() => { delete document.hidden; delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange')); }""")
    vis = wait_for(lambda: st(A)["running"], 3)
    ok("T16 hidden tab: loop stops (no frames), state is saved; visible again: loop resumes",
       not hid["running"] and rafs["rafPerSec"] <= 2 and upd1 > upd0 and vis, f"raf/s {rafs['rafPerSec']}, saved {upd1 > upd0}")

    # WebGL context loss -> message -> recovery
    if engine == "chromium":
        A.evaluate("() => window.__goldrush.loseContext()")
        lost = wait_for(lambda: A.is_visible(".gr-dialog") and "Grafikverbindung wurde unterbrochen." in A.inner_text(".gr-dialog"), 3)
        back = wait_for(lambda: not A.is_visible(".gr-dialog"), 5)
        time.sleep(0.4)
        var2 = canvas_variance(A)
        ok("GL context loss: 'Grafikverbindung wurde unterbrochen.' then the scene comes back", lost and back and var2 > 12, f"var {var2:.1f}")

    # ---- TEST 17: light / dark HUD
    themes = {}
    for theme in ("light", "dark"):
        A.evaluate("(t) => document.documentElement.setAttribute('data-theme', t)", theme)
        gr_pause(A)
        time.sleep(0.2)
        themes[theme] = {"chip": A.evaluate(CONTRAST, ".gr-brand"), "money": A.evaluate(CONTRAST, ".gr-money"),
                         "card": A.evaluate(CONTRAST, ".gr-pause .gr-card-title")}
        shot(A, shots, f"desktop_pause_{theme}")
    ok("T17 HUD / pause card follow the theme with readable contrast (>= 4.5) in light and dark",
       themes["light"]["chip"]["bg"] != themes["dark"]["chip"]["bg"]
       and all(v["ratio"] >= 4.5 for t in themes.values() for v in t.values()), json.dumps({t: {k: v["ratio"] for k, v in d.items()} for t, d in themes.items()}))
    A.evaluate("() => document.documentElement.setAttribute('data-theme', 'light')")

    # ---- TEST 2: close -> nothing keeps running
    gr_close(A)
    time.sleep(0.3)
    after_close = idle(A)
    gone = A.evaluate("() => ({ root: !!document.querySelector('.gr-root'), hook: 'undefined' !== typeof window.__goldrush, cls: document.documentElement.classList.contains('goldrush-active'), lock: !!document.pointerLockElement })")
    listeners1 = A.evaluate("() => window.__listeners()")
    ok("T2 closed: no render loop, no timers, no listeners, no DOM, no pointer lock",
       after_close["rafPerSec"] <= 1 and after_close["intervals"] <= idle0["intervals"] and listeners1 == listeners0
       and not any(gone.values()), f"{after_close} listeners {listeners0}->{listeners1} {gone}")

    # ---- TEST 3: 20x open/close (+ closing while still loading)
    heap0 = heap_mb(A)
    aborts = []
    for i in range(20):
        if i % 4 == 3:
            # leave while the loading screen is still up ("Abbrechen"), at
            # different moments of the load
            pct = A.evaluate(CANCEL_WHILE_LOADING, [0, 15, 40, 80, 130][len(aborts) % 5])
            aborts.append(pct)
            if pct < 0:
                gr_ready(A)
                gr_close(A)
        else:
            gr_open(A)
            gr_ready(A)
            gr_close(A)
        wait_for(lambda: A.evaluate("() => !document.querySelector('.gr-root')"), 5)
    time.sleep(0.8)
    heap1 = heap_mb(A)
    left = A.evaluate("() => ({ roots: document.querySelectorAll('.gr-root').length, canvases: document.querySelectorAll('canvas.gr-canvas').length, listeners: window.__listeners(), cls: document.documentElement.classList.contains('goldrush-active') })")
    loop = idle(A)
    too_many = [w for w in A.warnings if "Too many active WebGL contexts" in w or "CONTEXT_LOST" in w]
    ok("T3 20x open/close (4 of them while loading): no leftover DOM, canvas, listener, loop, GL context",
       sum(1 for a in aborts if a >= 0) >= 3 and left["roots"] == 0 and left["canvases"] == 0 and left["listeners"] == listeners0 and not left["cls"]
       and loop["rafPerSec"] <= 1 and loop["intervals"] <= idle0["intervals"] and not too_many,
       f"cancelled at {aborts} % | {left} {loop} warnings {too_many[:2]}")
    if heap0 is not None:                        # performance.memory is Chromium-only
        ok("T3 memory stays flat over 20 cycles", heap1 - heap0 < 25, f"{heap0:.1f} -> {heap1:.1f} MB")

    # exactly one instance
    A.evaluate("() => { launchGameByType('goldrush'); launchGameByType('goldrush'); import('/games/goldrush/goldrush.js').then((m) => m.open()); }")
    gr_ready(A)
    time.sleep(0.3)
    ok("only ever one GoldRush instance", A.evaluate("() => document.querySelectorAll('.gr-root').length") == 1)

    # ---- TEST 12: corrupt save
    gr_close(A)
    good = A.evaluate("() => localStorage.getItem(grKey())")
    seed_good = json.loads(good)["worldSeed"]
    A.evaluate("(g) => { localStorage.setItem(grKey(), '{\"saveVersion\":1,\"worldSeed\":12,\"terr'); localStorage.setItem(grKey('.backup'), g); }", good)
    gr_open(A)
    gr_ready(A)
    note = wait_for(lambda: A.is_visible(".gr-notice") and A.inner_text(".gr-notice"), 3)
    ok("T12 corrupt save + valid backup -> backup is loaded, player is told",
       note and "Sicherung" in note and st(A)["seed"] == seed_good, str(note))
    gr_close(A)
    # digs saved against another mound generator must not land on this mound
    A.evaluate("() => { const d = JSON.parse(localStorage.getItem(grKey())); d.terrain.gen = 999; localStorage.setItem(grKey(), JSON.stringify(d)); }")
    gr_open(A)
    gr_ready(A)
    note2 = wait_for(lambda: A.is_visible(".gr-notice") and A.inner_text(".gr-notice"), 3)
    ok("T12 save from another mound generator -> fresh mound, player told, seed + position kept",
       note2 and "neu aufgeschüttet" in note2 and st(A)["seed"] == seed_good and st(A)["revision"] == 0, str(note2))
    gr_close(A)
    A.evaluate("() => { localStorage.setItem(grKey(), 'x{broken'); localStorage.setItem(grKey('.backup'), '[]'); }")
    gr_open(A)
    A.wait_for_selector(".gr-dialog:not([hidden])", timeout=8000)
    dlg = A.inner_text(".gr-dialog")
    ok("T12 corrupt save without backup -> dialog 'Spielstand beschädigt' with new mine / back", "Spielstand beschädigt" in dlg and "Neue Mine starten" in dlg, dlg[:90])
    A.click(".gr-dialog [data-act='dlg:exit']")
    ok("T12 'Zurück' leaves GoldRush, the broken save is untouched",
       wait_for(lambda: A.evaluate("() => !document.querySelector('.gr-root')"), 3) and A.evaluate("() => localStorage.getItem(grKey())") == "x{broken")
    gr_open(A)
    A.wait_for_selector(".gr-dialog:not([hidden])", timeout=8000)
    A.click(".gr-dialog [data-act='dlg:new']")
    gr_ready(A)
    q = A.evaluate("() => ({ corrupt: localStorage.getItem(grKey('.corrupt')), seed: window.__goldrush.state().seed, digs: window.__goldrush.state().digs })")
    ok("T12 'Neue Mine starten' -> fresh mine, the broken text is kept aside", q["corrupt"] and "broken" in q["corrupt"] and q["digs"] == 0, str(q)[:120])

    # settings -> "Neue Mine starten …": a destructive question first
    gr_start(A)
    A.evaluate(AIM_AT_MOUND, {"ang": 0.0, "back": 1.3})
    A.evaluate(DIG_HERE, {"ang": 0.0, "n": 5})
    seed_before = st(A)["seed"]
    gr_pause(A)
    A.click(".gr-pause [data-act=settings]")
    A.click(".gr-panel [data-act=new-mine]")
    A.wait_for_selector(".gr-dialog:not([hidden]) [data-act='dlg:new']", timeout=5000)
    confirm_shown = "Neue Mine starten?" in A.inner_text(".gr-dialog")
    A.click(".gr-dialog [data-act='dlg:new']")
    gr_ready(A)
    ok("a new mine needs a confirmation and starts a new mine (new seed, nothing dug)", confirm_shown and st(A)["digs"] == 0 and st(A)["seed"] != seed_before)

    # ---- TEST 20 (part): the chat still works after GoldRush
    gr_close(A)
    A.fill("#message-input", "Nach GoldRush noch da")
    A.keyboard.press("Enter")
    sent = wait_for(lambda: A.evaluate("() => [...document.querySelectorAll('#messages .msg .bubble')].some((m) => m.innerText.includes('Nach GoldRush noch da'))"), 5)
    ok("T20 chat works normally after leaving GoldRush (send + receive)", sent)
    errs = errors(A)
    ok("desktop: no JS errors", not errs, "; ".join(errs[:3]))
    ctx.close()


def touch_suite(browser, base, user, shots):
    ctx, M = client(browser, base, user, PHONE)
    cdp = ctx.new_cdp_session(M)
    gr_open(M, via_library=True)
    gr_ready(M)
    s = st(M)
    ok("T6 phone: touch layout (stick + GRABEN), runs without a click-to-start",
       s["touch"] and s["running"] and M.is_visible(".gr-dig-btn") and not M.is_visible(".gr-pause"), str({k: s[k] for k in ("touch", "running", "level")}))
    shot(M, shots, "phone_start")
    aim = M.evaluate(AIM_AT_MOUND, {"ang": 0.2, "back": 1.6})
    s0 = st(M)
    dig = M.locator(".gr-dig-btn").bounding_box()
    dx, dy = dig["x"] + dig["width"] / 2, dig["y"] + dig["height"] / 2
    sx, sy = 90, 700            # left thumb: stick
    lx, ly = 300, 300           # right thumb: look
    touch(cdp, "touchStart", [(1, dx, dy)])
    touch(cdp, "touchStart", [(1, dx, dy), (2, sx, sy)])
    touch(cdp, "touchStart", [(1, dx, dy), (2, sx, sy), (3, lx, ly)])
    t0 = time.time()
    k = 0
    while time.time() - t0 < 2.0:
        k += 1
        touch(cdp, "touchMove", [(1, dx, dy), (2, sx + 4, sy - min(48, 8 * k)), (3, lx - 3 * k, ly)])
        time.sleep(0.05)
    mid = st(M)
    look_px = 3 * k                 # how far the look finger travelled (touch look: 0.0052 rad/px)
    touch(cdp, "touchEnd", [(1, dx, dy), (2, sx + 4, sy - 48)])
    touch(cdp, "touchEnd", [(1, dx, dy)])
    touch(cdp, "touchEnd", [])
    time.sleep(0.3)
    s1 = st(M)
    moved = math.hypot(mid["x"] - s0["x"], mid["z"] - s0["z"])
    scroll = M.evaluate("() => ({ y: scrollY, top: document.scrollingElement.scrollTop, scale: visualViewport ? visualViewport.scale : 1 })")
    ok("T6 three fingers at once: stick walks, right side looks, GRABEN digs",
       aim and moved > 0.25 and abs(mid["yaw"] - s0["yaw"]) > 0.5 * look_px * 0.0052 and s1["digs"] - s0["digs"] >= 3,
       f"moved {moved:.2f} m, yaw {s0['yaw']:.2f}->{mid['yaw']:.2f} for {look_px} px of finger travel, digs +{s1['digs'] - s0['digs']}")
    ok("T6 no page scroll / zoom from the gestures, stick released cleanly",
       scroll["y"] == 0 and scroll["top"] == 0 and scroll["scale"] == 1 and not M.evaluate("() => document.querySelector('.gr-stick').classList.contains('is-active')")
       and not M.evaluate("() => document.querySelector('.gr-dig-btn').classList.contains('is-active')"), str(scroll))

    # ---- TEST 15: portrait <-> landscape
    res = {}
    for name, (w, h) in (("landscape", (844, 390)), ("portrait", (390, 844))):
        M.set_viewport_size({"width": w, "height": h})
        time.sleep(0.5)
        res[name] = M.evaluate("""() => {
          const inside = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5 && r.width > 0; };
          const c = document.querySelector('.gr-canvas'), i = window.__goldrush.info();
          return { buf: Math.abs(c.width - Math.round(c.clientWidth * i.dpr)) <= 1 && c.clientWidth === innerWidth && c.clientHeight === innerHeight,
                   hud: ['.gr-brand', '.gr-money', '.gr-hud [data-act=exit]', '.gr-dig-btn', '.gr-tool'].every(inside), dpr: i.dpr, running: window.__goldrush.state().running };
        }""")
        shot(M, shots, f"phone_{name}")
    ok("T15 portrait <-> landscape: canvas fills the screen, HUD + GRABEN stay on screen, game keeps running",
       all(v["buf"] and v["hud"] and v["running"] for v in res.values()), json.dumps(res))

    # touch exit via the HUD button
    M.click(".gr-hud [data-act=exit]")
    ok("phone: the ✕ button leaves GoldRush", wait_for(lambda: M.evaluate("() => !document.querySelector('.gr-root')"), 4))
    errs = errors(M)
    ok("phone: no JS errors", not errs, "; ".join(errs[:3]))
    ctx.close()


def fallback_and_motion_suite(browser, base, user, shots):
    # ---- TEST 18: no WebGL
    ctx, N = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[NO_WEBGL])
    gr_open(N)
    N.wait_for_selector(".gr-dialog:not([hidden])", timeout=8000)
    text = N.inner_text(".gr-dialog")
    shot(N, shots, "no_webgl")
    N.click(".gr-dialog [data-act='dlg:exit']")
    back = wait_for(lambda: N.evaluate("() => !document.querySelector('.gr-root') && !document.documentElement.classList.contains('goldrush-active')"), 3)
    ok("T18 no WebGL -> 'GoldRush benötigt WebGL auf diesem Gerät.' and a clean way back to the chat",
       "GoldRush benötigt WebGL auf diesem Gerät." in text and back and not errors(N), text[:80])
    ctx.close()

    # ---- TEST 19: reduced motion
    ctx, R = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}, reduced_motion="reduce"))
    gr_open(R)
    gr_ready(R)
    gr_start(R)
    R.evaluate("() => window.__goldrush.pose({ x: 10, z: 14, yaw: 0, pitch: 0 })")
    R.keyboard.down("w")
    offs = []
    for _ in range(14):
        time.sleep(0.05)
        s = st(R)
        offs.append(round(s["camY"] - s["y"], 4))
    R.keyboard.up("w")
    gr_pause(R)
    R.click(".gr-pause [data-act=settings]")
    ui = R.evaluate("() => ({ disabled: document.querySelector('[data-role=headbob]').disabled, note: !document.querySelector('[data-role=bob-note]').hidden, rm: document.querySelector('[data-role=reduced]').checked && document.querySelector('[data-role=reduced]').disabled })")
    anim = R.evaluate("() => getComputedStyle(document.querySelector('.gr-crosshair span')).transitionDuration")
    ok("T19 prefers-reduced-motion: no head bob / dig kick, setting locked with a note",
       st(R)["reducedMotion"] and all(o == 0 for o in offs) and ui["disabled"] and ui["note"] and ui["rm"], f"cam offsets {set(offs)} {ui} transition {anim}")
    R.click(".gr-panel [data-act=close-settings]")
    gr_close(R)
    ctx.close()

    # control: with motion allowed, walking does bob the camera
    ctx, B = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}))
    gr_open(B)
    gr_ready(B)
    gr_start(B)
    B.evaluate("() => window.__goldrush.pose({ x: 10, z: 14, yaw: 0, pitch: 0 })")
    B.keyboard.down("w")
    offs = []
    for _ in range(14):
        time.sleep(0.05)
        s = st(B)
        offs.append(round(s["camY"] - s["y"], 4))
    B.keyboard.up("w")
    ok("T19 (control) with motion allowed the subtle head bob is there (< 3 cm)", any(o != 0 for o in offs) and max(abs(o) for o in offs) < 0.03, str(sorted(set(offs))[:4]))
    # the in-game switch does the same without the system setting, and is saved
    gr_pause(B)
    B.click(".gr-pause [data-act=settings]")
    B.click(".gr-panel [data-role=reduced]")
    B.click(".gr-panel [data-act=close-settings]")
    gr_start(B)
    B.evaluate("() => window.__goldrush.pose({ x: 10, z: 14, yaw: 0, pitch: 0 })")
    B.keyboard.down("w")
    offs = []
    for _ in range(14):
        time.sleep(0.05)
        s = st(B)
        offs.append(round(s["camY"] - s["y"], 4))
    B.keyboard.up("w")
    B.evaluate("() => window.__goldrush.save()")
    saved = B.evaluate("() => JSON.parse(localStorage.getItem('goldrush.settings')).reducedMotion")      # device settings (phase 5)
    ok("T19 in-game 'Reduzierte Bewegung' switch: bob off, HUD animations off, saved",
       st(B)["reducedMotion"] and all(o == 0 for o in offs) and saved is True and B.evaluate("() => document.querySelector('.gr-root').classList.contains('gr-reduced')"),
       f"offsets {set(offs)} saved {saved}")
    gr_close(B)
    ctx.close()


def perf_suite(browser, base, user, shots):
    rows = []
    for name, kw in VIEWPORTS:
        ctx, P = client(browser, base, user, kw)
        gr_open(P)
        gr_ready(P)
        gr_start(P)
        P.evaluate("() => window.__goldrush.pose({ x: 0.6, z: 10.2, yaw: 0, pitch: 0.12 })")
        time.sleep(1.0)
        P.evaluate(FRAME_REC)
        time.sleep(3.0)
        f = P.evaluate(FRAME_STOP)
        i = P.evaluate("() => window.__goldrush.info()")
        rows.append((name, f, i))
        shot(P, shots, f"vp_{name}")
        print(f"  {name:>9}: {1000 / f['avg']:.0f} FPS  avg {f['avg']} ms  p95 {f['p95']} ms  max {f['max']} ms | "
              f"{i['level']} dpr {i['dpr']} fov {i['fov']} calls {i['drawCalls']} tris {i['triangles']}", flush=True)
        gr_close(P)
        ctx.close()
    ok("perf: every target viewport runs at >= 30 FPS (desktop >= 55)",
       all((1000 / f["avg"]) >= (55 if "x" in n and int(n.split("x")[0]) >= 1366 else 30) for n, f, _ in rows))
    return rows


def main():
    shots = None
    if "--shots" in sys.argv:
        shots = Path(sys.argv[sys.argv.index("--shots") + 1])
        shots.mkdir(parents=True, exist_ok=True)
    engine = sys.argv[sys.argv.index("--browser") + 1] if "--browser" in sys.argv else "chromium"
    proc, base, tmp = start_server()
    try:
        user = login(base, "Goldi")
        with sync_playwright() as p:
            browser = getattr(p, engine).launch(args=GPU_ARGS if engine == "chromium" else [])
            if "--perf-only" not in sys.argv:
                desktop_suite(browser, base, user, shots, engine)
                if engine == "chromium":        # CDP multi-touch
                    touch_suite(browser, base, user, shots)
                fallback_and_motion_suite(browser, base, user, shots)
            if "--perf" in sys.argv or "--perf-only" in sys.argv:
                perf_suite(browser, base, user, shots)
            browser.close()
    finally:
        proc.terminate()

    fails = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(fails)}/{len(RESULTS)} checks passed")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
