"""End-to-end check of KopfKicker (and a smoke test of the other games)
against the REAL server, driven by two real browser clients.

    python tests/e2e/kopfkicker_e2e.py [--shots DIR] [--skip-rematch]

Runs the server from a throwaway copy of backend/ + static/ in a temp dir,
so test users/messages never touch the real data/instachat.db. Only for
the 10-rematch leak check the COPY gets a 3s match length (+ draws end
the match instead of golden goal) - the rules under test there are the
mount/unmount lifecycle, not the match clock (that one is covered by
tests/test_kopfkicker_physics.py).

Requires: pip install playwright pillow && python -m playwright install chromium
"""

import io
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
RESULTS = []


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def start_server(short_matches=False):
    tmp = Path(tempfile.mkdtemp(prefix="kk_e2e_"))
    shutil.copytree(ROOT / "backend", tmp / "backend", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(ROOT / "static", tmp / "static")
    shutil.copy(ROOT / "config.json", tmp / "config.json")
    if short_matches:
        f = tmp / "backend" / "kopf_kicker.py"
        src = f.read_text(encoding="utf-8")
        src = src.replace("MATCH_SECONDS = 90", "MATCH_SECONDS = 3")
        src = src.replace("                if len(set(scores)) == 1:\n                    state[\"golden_goal\"] = True\n                else:",
                          "                if False:\n                    pass\n                else:")
        f.write_text(src, encoding="utf-8")
    port = free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
        cwd=tmp, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            urllib.request.urlopen(base + "/", timeout=0.5)
            break
        except Exception:
            time.sleep(0.1)
    return proc, base, tmp


def login(base, name):
    cfg = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    req = urllib.request.Request(base + "/api/login", data=json.dumps({"code": cfg["team_password"], "name": name}).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())


def selfie_png(color):
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (400, 400), (230, 230, 240))
    d = ImageDraw.Draw(img)
    d.ellipse((60, 40, 340, 360), fill=color)
    d.ellipse((130, 150, 170, 190), fill="white")
    d.ellipse((230, 150, 270, 190), fill="white")
    d.arc((140, 220, 260, 300), 20, 160, fill="white", width=10)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


# Wraps the WebSocket so tests can (a) count what the client sends and
# (b) add artificial latency in both directions.
WS_SPY = """
(() => {
  window.__sent = [];
  window.__latency = 0;
  const Native = window.WebSocket;
  class Spy extends Native {
    constructor(...a) {
      super(...a);
      const deliver = (type, ev) => {
        const d = window.__latency ? window.__latency + Math.random() * window.__latency * 0.2 : 0;
        const fire = () => { const h = this['__on' + type]; if (h) h.call(this, ev); };
        d ? setTimeout(fire, d) : fire();
      };
      super.onmessage = (ev) => deliver('message', ev);
    }
    set onmessage(fn) { this.__onmessage = fn; }
    get onmessage() { return this.__onmessage; }
    send(data) {
      try { const m = JSON.parse(data); if (m.type === 'game_input') window.__sent.push(m.payload); } catch (e) {}
      const d = window.__latency;
      d ? setTimeout(() => super.send(data), d) : super.send(data);
    }
  }
  window.WebSocket = Spy;
})();
"""


def open_client(browser, base, user, mobile):
    if mobile:
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    else:
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    ctx.add_init_script(f"localStorage.setItem('instachat_token', {json.dumps(user['token'])});"
                        f"localStorage.setItem('instachat_user', {json.dumps(json.dumps(user['user']))});")
    ctx.add_init_script(WS_SPY)
    page = ctx.new_page()
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    page.on("console", lambda m: page.errors.append(m.text) if m.type == "error" else None)
    page.goto(base + "/")
    page.wait_for_function("() => window.WebSocket && typeof ws !== 'undefined' && ws && ws.readyState === 1", timeout=10000)
    return ctx, page


def kk_state(page):
    return page.evaluate("() => kopfKickerInstance && kopfKickerInstance._debugLastState()")


def me_state(page, uid):
    s = kk_state(page)
    return s and s.get("playerState", {}).get(str(uid))


def wait_phase(page, phase, timeout=15):
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = kk_state(page)
        if s and s.get("phase") == phase:
            return True
        time.sleep(0.05)
    return False


def setup_match(pa, pb, tmp):
    pa.evaluate("() => startGame('kopfkicker')")
    pa.wait_for_function("() => myGameSessionId", timeout=5000)
    sid = pa.evaluate("() => myGameSessionId")
    pb.wait_for_timeout(300)
    pb.evaluate("(sid) => joinGame(sid)", sid)
    for page, color in ((pa, (40, 110, 214)), (pb, (232, 98, 44))):
        page.wait_for_selector(".kk-lobby:not([hidden]) [data-role='file-input']", state="attached", timeout=10000)
        f = tmp / f"selfie_{color[0]}.png"
        f.write_bytes(selfie_png(color))
        page.set_input_files(".kk-lobby [data-role='file-input']", str(f))
        page.click("[data-role='use']")
        page.wait_for_selector("text=✅ READY", timeout=5000)
        page.click("text=✅ READY")
    pa.wait_for_selector("[data-role='start']:not([disabled])", timeout=5000)
    pa.click("[data-role='start']")
    return wait_phase(pa, "playing", 10)


def ball_speed(s):
    b = s["ball"]
    return (b["vx"] ** 2 + b["vy"] ** 2) ** 0.5


def main():
    shots = None
    if "--shots" in sys.argv:
        shots = Path(sys.argv[sys.argv.index("--shots") + 1])
        shots.mkdir(parents=True, exist_ok=True)

    proc, base, tmp = start_server()
    try:
        ua, ub = login(base, "KickerAlex"), login(base, "KickerBea")
        uid_a, uid_b = ua["user"]["id"], ub["user"]["id"]
        with sync_playwright() as p:
            browser = p.chromium.launch()
            ca, pa = open_client(browser, base, ua, mobile=False)
            cb, pb = open_client(browser, base, ub, mobile=True)

            ok("match starts (selfie -> ready -> host start -> countdown -> playing)", setup_match(pa, pb, tmp))
            s = kk_state(pa)
            ok("kickoff ball at center, (almost) no horizontal energy", abs(s["ball"]["x"] - 800) < 5 and abs(s["ball"]["vx"]) < 1, str(s["ball"]))
            ok("timer starts at 90 after the countdown", s.get("secondsLeft") in (89, 90), str(s.get("secondsLeft")))
            if shots:
                pa.wait_for_timeout(500)
                pa.screenshot(path=str(shots / "desktop_kickoff.png"))
                pb.screenshot(path=str(shots / "mobile_portrait_kickoff.png"))

            # --- idle: nobody touches anything ---
            speeds = []
            for _ in range(10):
                pa.wait_for_timeout(1000)
                speeds.append(round(ball_speed(kk_state(pa))))
            s = kk_state(pa)
            ok("idle 10s: ball calms down and sleeps on its own", s["ball"]["asleep"] and speeds[-1] == 0, f"speeds/s {speeds}")

            # --- desktop keyboard: acceleration + variable jump height ---
            pa.bring_to_front()
            pa.keyboard.down("d")
            pa.wait_for_timeout(400)
            vx = me_state(pa, uid_a)["vx"]
            pa.keyboard.up("d")
            pa.wait_for_timeout(400)
            ok("keyboard run right -> moves, release -> stops", vx > 300 and abs(me_state(pa, uid_a)["vx"]) < 1, f"vx while held {vx}")

            def jump_apex(hold_ms):
                pa.keyboard.down("Space")
                pa.wait_for_timeout(hold_ms)
                pa.keyboard.up("Space")
                best = 0
                for _ in range(40):
                    best = max(best, me_state(pa, uid_a)["height"])
                    pa.wait_for_timeout(25)
                return best
            tap, hold = jump_apex(30), jump_apex(450)
            ok("variable jump: tap lower than hold", 20 < tap < hold * 0.75, f"tap {tap:.0f} hold {hold:.0f}")

            sent0 = len(pa.evaluate("() => window.__sent"))
            pa.keyboard.press("e")
            pa.wait_for_timeout(200)
            kicks = [m for m in pa.evaluate("() => window.__sent")[sent0:] if m.get("action") == "kick"]
            ok("one key press sends exactly one kick", len(kicks) == 1, str(kicks))

            # --- mobile multitouch: right + jump + kick at the same time ---
            def ptr(page, role, kind, pid):
                page.evaluate("""([role, kind, pid]) => {
                    const el = document.querySelector(`.kk-ctrl-btn[data-role="${role}"]`);
                    el.dispatchEvent(new PointerEvent(kind, { pointerId: pid, bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: pid === 1 }));
                }""", [role, kind, pid])
            pb.bring_to_front()
            ptr(pb, "right", "pointerdown", 1)
            pb.wait_for_timeout(150)
            ptr(pb, "jump", "pointerdown", 2)
            pb.wait_for_timeout(60)
            ptr(pb, "kick", "pointerdown", 3)
            pb.wait_for_timeout(90)
            st = me_state(pa, uid_b)
            ok("multitouch right+jump+kick all active together", st["vx"] > 100 and st["height"] > 5 and st["kicking"], f"vx {st['vx']} h {st['height']} kicking {st['kicking']}")
            ptr(pb, "kick", "pointerup", 3)
            ptr(pb, "jump", "pointerup", 2)
            pb.wait_for_timeout(300)
            st = me_state(pa, uid_b)
            ok("releasing jump+kick keeps running (pointer 1 still down)", st["vx"] > 100, f"vx {st['vx']}")
            if shots:
                pb.screenshot(path=str(shots / "mobile_portrait_running.png"))

            # --- chat opens while running -> everything released ---
            pb.click("#game-chat-toggle")
            pb.wait_for_timeout(350)
            st = me_state(pa, uid_b)
            ok("opening the chat stops a held run", abs(st["vx"]) < 1, f"vx {st['vx']}")
            ptr(pb, "right", "pointerup", 1)  # the finger lifts later - must not matter
            pb.click("#game-chat-close-btn")
            pb.wait_for_timeout(400)
            # (B is at the right edge by now, so check with "left")
            ptr(pb, "left", "pointerdown", 4)
            pb.wait_for_timeout(300)
            st = me_state(pa, uid_b)
            ok("after closing the chat the controls work right away", st["vx"] < -100, f"vx {st['vx']}")
            ptr(pb, "left", "pointerup", 4)

            # --- orientation: portrait -> landscape -> portrait ---
            score_before = kk_state(pb)["score"]
            canvas_portrait = pb.evaluate("() => document.querySelector('.kk-canvas').getBoundingClientRect().width")
            pb.set_viewport_size({"width": 844, "height": 390})
            pb.evaluate("() => window.dispatchEvent(new Event('orientationchange'))")
            pb.wait_for_timeout(600)
            geo = pb.evaluate("""() => {
                const r = (s) => document.querySelector(s).getBoundingClientRect();
                const c = r('.kk-canvas'), m = r('.kk-controls-move'), a = r('.kk-controls-action');
                return { c: [c.left, c.top, c.width, c.height], move: [m.left, m.right], act: [a.left, a.right],
                         buttons: document.querySelectorAll('.kk-ctrl-btn').length };
            }""")
            c = geo["c"]
            ok("landscape: arena bigger than in portrait", c[2] > canvas_portrait * 1.3, f"{canvas_portrait:.0f} -> {c[2]:.0f}px wide")
            ok("landscape: move left of arena, jump/kick right of it, no duplicates",
               geo["move"][1] <= c[0] + 1 and geo["act"][0] >= c[0] + c[2] - 1 and geo["buttons"] == 4, json.dumps(geo))
            if shots:
                pb.screenshot(path=str(shots / "mobile_landscape.png"))
            pb.set_viewport_size({"width": 390, "height": 844})
            pb.evaluate("() => window.dispatchEvent(new Event('orientationchange'))")
            pb.wait_for_timeout(500)
            ok("orientation round trip keeps the match state", kk_state(pb)["score"] == score_before and kk_state(pb)["phase"] in ("playing", "goal_pause", "countdown"))

            # --- latency 100 / 200 ms: still controllable, smooth buffer ---
            for lat in (100, 200):
                pb.evaluate(f"() => window.__latency = {lat}")
                pb.wait_for_timeout(800)
                t0 = time.time()
                ptr(pb, "left", "pointerdown", 20 + lat)
                moved_at = None
                while time.time() - t0 < 2:
                    if me_state(pa, uid_b)["vx"] < -50:
                        moved_at = time.time() - t0
                        break
                    time.sleep(0.01)
                ptr(pb, "left", "pointerup", 20 + lat)
                pb.wait_for_timeout(300)
                ok(f"{lat}ms latency: input reaches the server", moved_at is not None and moved_at < lat / 1000 + 0.25, f"{(moved_at or 0) * 1000:.0f} ms")
            pb.evaluate("() => window.__latency = 0")

            # --- goal: push the ball into B's goal from A's side ---
            pa.bring_to_front()
            s0 = kk_state(pa)["score"]
            scored = False
            t0 = time.time()
            pa.keyboard.down("d")
            while time.time() - t0 < 25 and not scored:
                pa.keyboard.press("e")
                pa.wait_for_timeout(120)
                s = kk_state(pa)
                scored = s["phase"] == "goal_pause"
            pa.keyboard.up("d")
            if scored and shots:
                pa.wait_for_timeout(250)
                pa.screenshot(path=str(shots / "desktop_goal.png"))
            ok("goal registered", scored)
            if scored:
                pa.wait_for_timeout(300)
                s = kk_state(pa)
                total = sum(s["score"].values()) - sum(s0.values())
                ok("exactly one goal counted", total == 1, f"{s0} -> {s['score']}")
                ok("goal -> countdown -> kickoff with ball at center", wait_phase(pa, "countdown", 5) and abs(kk_state(pa)["ball"]["x"] - 800) < 1)
                wait_phase(pa, "playing", 6)
                st = me_state(pa, uid_a)
                ok("kickoff reset positions and stale inputs", abs(st["vx"]) < 1 and st["height"] == 0, str(st))

            errors = [e for e in pa.errors + pb.errors if "favicon" not in e]
            ok("no JS errors in either client during the match", not errors, "; ".join(errors[:3]))
            if shots:
                pa.goto(base + "/?kkdebug")
            ca.close()
            cb.close()
            browser.close()
    finally:
        proc.terminate()

    if "--skip-rematch" not in sys.argv:
        rematch_leak_and_other_games(shots)

    fails = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(fails)}/{len(RESULTS)} checks passed")
    sys.exit(1 if fails else 0)


def rematch_leak_and_other_games(shots):
    proc, base, tmp = start_server(short_matches=True)
    try:
        ua, ub, uc = login(base, "LeakAlex"), login(base, "LeakBea"), login(base, "LeakCem")
        with sync_playwright() as p:
            browser = p.chromium.launch()
            ca, pa = open_client(browser, base, ua, mobile=False)
            cb, pb = open_client(browser, base, ub, mobile=True)
            cc, pc = open_client(browser, base, uc, mobile=False)
            setup_match(pa, pb, tmp)
            pa.evaluate("""() => {
                window.__raf = 0;
                const native = window.requestAnimationFrame.bind(window);
                window.requestAnimationFrame = (cb) => native((t) => { window.__raf++; cb(t); });
            }""")

            def raf_rate():
                a = pa.evaluate("() => window.__raf")
                pa.wait_for_timeout(1000)
                return pa.evaluate("() => window.__raf") - a

            def one_kick_count():
                wait_phase(pa, "playing", 8)
                n0 = len(pa.evaluate("() => window.__sent"))
                pa.bring_to_front()
                pa.keyboard.press("e")
                pa.wait_for_timeout(150)
                return sum(1 for m in pa.evaluate("() => window.__sent")[n0:] if m.get("action") == "kick")

            first_kicks = one_kick_count()
            first_raf = raf_rate()
            heap0 = pa.evaluate("() => performance.memory ? performance.memory.usedJSHeapSize : 0")
            for i in range(10):
                pa.wait_for_selector(".kk-endscreen:not([hidden]) [data-role='rematch']", timeout=15000)
                pa.click(".kk-endscreen [data-role='rematch']")
                wait_phase(pa, "countdown", 5)
            last_kicks = one_kick_count()
            last_raf = raf_rate()
            heap1 = pa.evaluate("() => performance.memory ? performance.memory.usedJSHeapSize : 0")
            pa.wait_for_selector(".kk-endscreen:not([hidden]) [data-role='rematch']", timeout=15000)
            photos = pa.evaluate("() => [...document.querySelectorAll('.kk-endscreen .kk-endscreen-photo')].filter((i) => i.src.startsWith('data:image')).length")
            ok("10 rematches: still one kick message per key press", first_kicks == 1 and last_kicks == 1, f"{first_kicks} -> {last_kicks}")
            ok("10 rematches: render callbacks/s not multiplied", last_raf < first_raf * 1.5, f"{first_raf} -> {last_raf} per s")
            ok("10 rematches: JS heap roughly flat", heap1 < heap0 * 2 + 5e6, f"{heap0 / 1e6:.1f} -> {heap1 / 1e6:.1f} MB")
            ok("10 rematches: both selfies still shown (own one re-fetched after remount)", photos == 2, f"{photos} photos on the endscreen")
            if shots:
                pa.screenshot(path=str(shots / "desktop_after_10_rematches.png"))

            # leaving mid-lobby must not leave a zombie session behind
            pa.evaluate("() => closeGameModal()")
            pb.evaluate("() => closeGameModal()")
            pa.wait_for_timeout(600)
            open_games = pa.evaluate("() => gameSessions.filter((g) => g.game_type === 'kopfkicker').length")
            ok("both left -> no open KopfKicker session remains", open_games == 0, str(open_games))

            # --- smoke: chat + other games still start ---
            pa.evaluate("() => { const i = document.getElementById('message-input'); i.value = 'hallo e2e'; i.form.requestSubmit(); }")
            pb.wait_for_function("() => document.body.innerText.includes('hallo e2e')", timeout=5000)
            ok("normal chat message delivered", True)
            for game, sel, needs_start in (("whoami", ".wai-root", True), ("estimate", ".est-root", True),
                                           ("kritzelmeister", ".game-stage *", True), ("tankbattle", "canvas", True)):
                for pg in (pa, pb, pc):
                    pg.evaluate("() => { if (myGameSessionId) closeGameModal(); }")
                pa.wait_for_timeout(300)
                if game == "whoami":
                    pa.evaluate("() => window.WhoAmI.openHostOptionsModal ? 0 : 0")
                    pa.evaluate("() => { const ws_ = ws; ws_.send(JSON.stringify({ type: 'game_create', game_type: 'whoami', options: { difficulty: 'mixed', maxRounds: 15, categories: ['music'], customTerms: [] } })); }")
                elif game == "estimate":
                    pa.evaluate("() => ws.send(JSON.stringify({ type: 'game_create', game_type: 'estimate', options: {} }))")
                else:
                    pa.evaluate(f"() => startGame('{game}')")
                pa.wait_for_function("() => myGameSessionId", timeout=5000)
                sid = pa.evaluate("() => myGameSessionId")
                pb.wait_for_timeout(300)
                pb.evaluate("(sid) => joinGame(sid)", sid)
                if game == "kritzelmeister":  # needs 3 players
                    pc.wait_for_timeout(200)
                    pc.evaluate("(sid) => joinGame(sid)", sid)
                pb.wait_for_timeout(500)
                if needs_start:
                    pa.evaluate("(sid) => startGameNow(sid)", sid)
                try:
                    pa.wait_for_selector(f"#game-modal:not([hidden]) {sel}", timeout=6000)
                    pb.wait_for_selector(f"#game-modal:not([hidden]) {sel}", timeout=6000)
                    started = True
                except Exception:
                    started = False
                errs = [e for e in pa.errors + pb.errors if "favicon" not in e]
                ok(f"{game} starts for both players", started and not errs, "; ".join(errs[:2]))
                if shots:
                    pb.screenshot(path=str(shots / f"smoke_{game}.png"))
            browser.close()
    finally:
        proc.terminate()


if __name__ == "__main__":
    main()
