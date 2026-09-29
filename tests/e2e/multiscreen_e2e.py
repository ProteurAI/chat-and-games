"""End-to-end check of MultiScreen / Table Mode with three real browser
"phones" against the real server (run from a temp copy - the real database
is never touched).

    python tests/e2e/multiscreen_e2e.py [--shots DIR]

Requires: pip install playwright pillow && python -m playwright install chromium
"""

import json
import os
import random
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
from kopfkicker_e2e import WS_SPY, login, start_server  # noqa: E402

from backend.multiscreen import geometry as geo  # noqa: E402

RESULTS = []


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


PHONES = {
    "iphone": dict(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True),
    "android": dict(viewport={"width": 412, "height": 915}, device_scale_factor=2.6, is_mobile=True, has_touch=True),
}


def phone(browser, base, user, kind):
    ctx = browser.new_context(**PHONES[kind])
    ctx.add_init_script(f"localStorage.setItem('instachat_token', {json.dumps(user['token'])});"
                        f"localStorage.setItem('instachat_user', {json.dumps(json.dumps(user['user']))});")
    ctx.add_init_script(WS_SPY)
    page = ctx.new_page()
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    page.on("console", lambda m: page.errors.append(m.text) if m.type == "error" else None)
    page.goto(base + "/")
    page.wait_for_function("() => typeof ws !== 'undefined' && ws && ws.readyState === 1", timeout=10000)
    return ctx, page


def st(page):
    return page.evaluate("() => { const s = window.MultiScreen._debug(); return s.state; }")


def gs(page):
    return page.evaluate("() => window.MultiScreen._debug().gameState")


def wait_for(fn, timeout=10, step=0.05):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return v
        time.sleep(step)
    return None


def bright_spot(page):
    """Is there a bright yellowish dot (test-wave light) on this screen?"""
    return page.evaluate("""() => {
        const c = document.querySelector('.ms-canvas');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < d.length; i += 4 * 7) if (d[i] > 235 && d[i + 1] > 220 && d[i + 2] > 180) return true;
        return false;
    }""")


def snake_pixels_near(page, wx, wy):
    """Sample the canvas around a world point (via this screen's own
    transform) - True if something snake-coloured is drawn there."""
    return page.evaluate("""([wx, wy]) => {
        const S = window.MultiScreen._debug();
        const t = S.state.layout.tiles.find((x) => x.deviceId === S.deviceId);
        if (!t) return null;
        const c = document.querySelector('.ms-canvas');
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cssW = c.clientWidth, cssH = c.clientHeight;
        const s = Math.min(cssW / t.localW, cssH / t.localH);
        const ox = (cssW - t.localW * s) / 2, oy = (cssH - t.localH * s) / 2;
        const l = window.MSGeometry.worldToLocal(t, wx, wy);
        const px = Math.round((ox + l[0] * s) * dpr), py = Math.round((oy + l[1] * s) * dpr);
        if (px < 0 || py < 0 || px >= c.width || py >= c.height) return false;
        const R = Math.round(3 * s * dpr);
        const d = c.getContext('2d').getImageData(Math.max(0, px - R), Math.max(0, py - R), 2 * R, 2 * R).data;
        let hits = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 150 && d[i + 1] > d[i] + 10) hits++;
        return hits > 4;
    }""", [wx, wy])


def swipe(page, direction):
    page.evaluate("""(dir) => {
        const el = document.querySelector('.ms-stage');
        const r = el.getBoundingClientRect();
        const x = r.width / 2, y = r.height / 2;
        const v = { up: [0, -60], down: [0, 60], left: [-60, 0], right: [60, 0] }[dir];
        const mk = (type, px, py) => new PointerEvent(type, { pointerId: 7, bubbles: true, clientX: px, clientY: py, pointerType: 'touch' });
        el.dispatchEvent(mk('pointerdown', x, y));
        el.dispatchEvent(mk('pointermove', x + v[0], y + v[1]));
        el.dispatchEvent(mk('pointerup', x + v[0], y + v[1]));
    }""", direction)


def main():
    shots = None
    if "--shots" in sys.argv:
        shots = Path(sys.argv[sys.argv.index("--shots") + 1])
        shots.mkdir(parents=True, exist_ok=True)

    def shot(page, name):
        if shots:
            page.screenshot(path=str(shots / f"{name}.png"))

    proc, base, tmp = start_server()
    try:
        users = [login(base, n) for n in ("TIM", "SARAH", "MAX")]
        with sync_playwright() as p:
            browser = p.chromium.launch()
            (ca, A), (cb, B), (cc, C) = phone(browser, base, users[0], "iphone"), phone(browser, base, users[1], "iphone"), phone(browser, base, users[2], "android")
            pages = {"TIM": A, "SARAH": B, "MAX": C}

            # ---------------- geometry parity JS <-> Python ----------------
            rng = random.Random(4)
            mism = 0
            for rot in geo.ROTATIONS:
                t = geo.Tile("X", 12.5, -30, 68, 150, rot)
                for _ in range(20):
                    wx, wy = t.x + rng.random() * t.w, t.y + rng.random() * t.h
                    js = A.evaluate("([t, x, y]) => window.MSGeometry.worldToLocal(t, x, y)", [t.to_public() | {"rotation": rot}, wx, wy])
                    py = geo.world_to_local(t, wx, wy)
                    mism += abs(js[0] - py[0]) > 1e-6 or abs(js[1] - py[1]) > 1e-6
                for d in ("up", "right", "down", "left"):
                    mism += A.evaluate("([r, d]) => window.MSGeometry.localDirToWorld(r, d)", [rot, d]) != geo.local_dir_to_world(rot, d)
            ok("client transforms match the server exactly (all 4 rotations)", mism == 0, f"{mism} mismatches")

            # ---------------- create + join ----------------
            A.evaluate("() => launchGameByType('mssnake')")
            A.wait_for_selector(".ms-entry [data-role='create']", timeout=5000)
            shot(A, "01_entry")
            A.click(".ms-entry [data-role='create']")
            code = wait_for(lambda: (st(A) or {}).get("code"))
            ok("host gets a 6-character join code", code and len(code) == 6, code)
            B.evaluate("() => window.MultiScreen.openEntry('snake')")
            B.fill("#ms-code-input", code)
            B.click(".ms-join-row .ghost-btn")
            # MAX joins through the games panel's open-table list instead of typing
            C.wait_for_function("() => window.MultiScreen.lobby().some((l) => l.joinable)", timeout=5000)
            C.evaluate("() => renderGamesPanel()")
            joined_via_panel = C.evaluate("""() => {
                const b = [...document.querySelectorAll('#games-panel-lobby-list button')].find((x) => x.textContent === 'Beitreten');
                if (!b) return false; b.click(); return true; }""")
            ok("third phone joins from the games panel list", joined_via_panel)
            wait_for(lambda: len((st(A) or {}).get("devices", [])) == 3)
            s = st(A)
            devs = {d["name"]: d for d in s["devices"]}
            ok("3 devices, numbered and coloured", sorted(d["number"] for d in s["devices"]) == [1, 2, 3] and len({d["color"] for d in s["devices"]}) == 3)
            ok("auto layout: a valid row with 2 passages", not [x for x in s["layout"]["problems"] if x["severity"] == "error"] and len(s["layout"]["passages"]) == 2,
               json.dumps(s["layout"]["problems"]))
            ok("different phone sizes -> different tile sizes (quick calibration)", devs["MAX"]["localH"] != devs["TIM"]["localH"],
               f"TIM {devs['TIM']['localW']}x{devs['TIM']['localH']} MAX {devs['MAX']['localW']}x{devs['MAX']['localH']}")
            A.wait_for_selector(".ms-editor .ms-tile", timeout=5000)
            ok("host editor shows 3 tiles + green passage lines", A.eval_on_selector_all(".ms-editor .ms-tile", "e => e.length") == 3
               and A.eval_on_selector_all(".ms-editor .ms-passage:not(.ms-passage--narrow)", "e => e.length") == 2)
            ok("guests see their big identity card", "SARAH" in B.inner_text(".ms-identity--big") and "Handy 2" in B.inner_text(".ms-identity--big"))
            shot(A, "02_host_editor")
            shot(B, "03_guest_identity")

            # ---------------- templates / rotate / island ----------------
            A.click("[data-template='L']")
            wait_for(lambda: st(A)["placements"][devs["MAX"]["deviceId"]]["y"] > 0)
            s = st(A)
            ok("L template is valid", not [x for x in s["layout"]["problems"] if x["severity"] == "error"])
            A.click(f".ms-tile[data-id='{devs['MAX']['deviceId']}']")
            A.click("[data-role='rotate']")
            wait_for(lambda: st(A)["placements"][devs["MAX"]["deviceId"]]["rotation"] == 90)
            ok("tap + ⟳ rotates a tile by 90°", st(A)["placements"][devs["MAX"]["deviceId"]]["rotation"] == 90)
            shot(A, "04_editor_rotated")
            # drag MAX far away -> island
            box = A.eval_on_selector(f".ms-tile[data-id='{devs['MAX']['deviceId']}']", "e => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }")
            A.mouse.move(*box)
            A.mouse.down()
            A.mouse.move(box[0] + 120, box[1] - 5, steps=8)
            A.mouse.up()
            island = wait_for(lambda: [x for x in st(A)["layout"]["problems"] if x["code"] == "island"], 4)
            ok("dragged-away phone is reported as not connected", island and "MAX" in island[0]["message"], island and island[0]["message"])
            ok("start is blocked while invalid", A.is_disabled("[data-role='test']"))
            shot(A, "05_editor_island")
            A.click("[data-template='row']")
            wait_for(lambda: not [x for x in st(A)["layout"]["problems"] if x["severity"] == "error"] and all(v["rotation"] == 0 for v in st(A)["placements"].values()))

            # ---------------- precision calibration on SARAH ----------------
            B.click("[data-role='calib']")
            B.wait_for_selector(".ms-calib", timeout=3000)
            shot(B, "06_calibration")
            B.evaluate("() => { const s = document.querySelector('.ms-calib [data-role=slider]'); s.value = '6.0'; s.dispatchEvent(new Event('input')); }")
            B.click(".ms-calib [data-role='ok']")
            cal = wait_for(lambda: next(d for d in st(A)["devices"] if d["name"] == "SARAH")["calibrated"], 4)
            sarah = next(d for d in st(A)["devices"] if d["name"] == "SARAH")
            ok("bank-card calibration -> real mm size", cal and abs(sarah["localW"] - 390 / 6.0) < 0.6, f"{sarah['localW']}x{sarah['localH']}")
            A.click("[data-template='row']")   # re-flow the row for the new size
            time.sleep(0.4)
            # SARAH's phone lies upside down on the table (rotated 180 deg)
            sid = devs["SARAH"]["deviceId"]
            A.click(f".ms-tile[data-id='{sid}']")
            A.click("[data-role='rotate']")
            wait_for(lambda: st(A)["placements"][sid]["rotation"] == 90)
            A.click("[data-role='rotate']")
            ok("SARAH rotated 180° and the layout is still valid",
               wait_for(lambda: st(A)["placements"][sid]["rotation"] == 180 and not [x for x in st(A)["layout"]["problems"] if x["severity"] == "error"], 4))
            ROT = {d["name"]: 0 for d in st(A)["devices"]}
            ROT["SARAH"] = 180

            def world_to_local_dir(name, world_dir):
                return geo.world_dir_to_local(ROT[name], world_dir)

            # ---------------- layout test modes ----------------
            A.click("[data-role='test']")
            for pg in pages.values():
                pg.wait_for_selector(".ms-stage:not([hidden])", timeout=5000)
            ok("LAYOUT TESTEN puts every phone on the stage", True)
            colors = [pg.eval_on_selector(".ms-test-color", "e => getComputedStyle(e).backgroundColor") for pg in pages.values()]
            ok("colour test: each phone its own colour + name", len(set(colors)) == 3 and "MAX" in C.inner_text(".ms-test-color"), str(colors))
            for n, pg in pages.items():
                shot(pg, f"07_color_{n}")
            A.click("[data-mode='edges']")
            B.wait_for_selector(".ms-edge--left", timeout=3000)
            left, right = B.inner_text(".ms-edge--left"), B.inner_text(".ms-edge--right")
            ok("edge test on the upside-down phone: TIM on her RIGHT, MAX on her LEFT", "TIM" in right and "MAX" in left, f"{left} | {right}")
            ok("edge test: the world-up arrow points down on the upside-down phone",
               "rotate(180deg)" in B.eval_on_selector(".ms-world-up span", "e => e.getAttribute('style')"))
            ok("edge test: TIM's left edge is a wall", "Wand" in A.inner_text(".ms-edge--left"))
            for n, pg in pages.items():
                shot(pg, f"08_edges_{n}")
            A.click("[data-mode='wave']")
            seen, order = set(), []
            t0 = time.time()
            while time.time() - t0 < 8 and len(seen) < 3:
                for n, pg in pages.items():
                    if bright_spot(pg):
                        seen.add(n)
                        if not order or order[-1] != n:
                            order.append(n)
                time.sleep(0.05)
            ok("wave: the light point travels across all three screens", seen == {"TIM", "SARAH", "MAX"}, " → ".join(order))
            for n, pg in pages.items():
                shot(pg, f"09_wave_{n}")
            A.click("[data-mode='seam']")
            time.sleep(0.3)
            for n, pg in pages.items():
                shot(pg, f"10_seam_{n}")
            A.click(".ms-hostbar [data-role='ok']")
            ok("PASST locks the layout (ready on every phone)", wait_for(lambda: all(st(pg)["phase"] == "ready" for pg in pages.values()), 4))
            shot(A, "11_ready_host")
            shot(C, "11_ready_guest")

            # ---------------- snake ----------------
            A.click(".ms-hostbar [data-role='start']")
            playing = wait_for(lambda: (gs(A) or {}).get("phase") == "playing", 10)
            ok("intro wave + synchronized countdown -> playing", playing)
            g = gs(A)
            active_name = next(d["name"] for d in st(A)["devices"] if d["deviceId"] == g["activeDeviceId"])
            ap = pages[active_name]
            time.sleep(0.15)
            head = gs(A)["snake"]["path"][0]
            ok("the head is drawn on the controlling phone", snake_pixels_near(ap, *head), f"{active_name} head {head}")
            others_draw = [n for n, pg in pages.items() if pg is not ap and snake_pixels_near(pg, *head)]
            ok("... and on no other phone", not others_draw, str(others_draw))
            ok("controller has the subtle active glow", ap.evaluate("() => document.querySelector('.ms-stage').classList.contains('ms-stage--active')"))
            ok("no chat UI anywhere during the game", all(not pg.is_visible("#game-chat-toggle") and not pg.is_visible(".ms-head") for pg in pages.values()))
            # steer: swipe perpendicular on the active phone (in ITS own orientation)
            cur = gs(A)["snake"]["dir"]
            local_turn = "up" if geo.world_dir_to_local(ROT[active_name], cur) in ("left", "right") else "left"
            expect = geo.local_dir_to_world(ROT[active_name], local_turn)
            swipe(ap, local_turn)
            turned = wait_for(lambda: gs(A)["snake"]["dir"] == expect, 2)
            ok(f"swipe '{local_turn}' on {active_name}'s glass (rot {ROT[active_name]}) -> world '{expect}'", turned, f"{cur} -> {gs(A)['snake']['dir']}")
            back_world = {"up": "down", "down": "up", "left": "right", "right": "left"}[gs(A)["snake"]["dir"]]
            swipe(ap, world_to_local_dir(active_name, back_world))
            time.sleep(0.4)
            ok("a 180° swipe is ignored", gs(A)["snake"]["dir"] != back_world)
            # drive it into a neighbour: put the snake on a course to cross (server-side turn via the controller)
            crossed = None
            for _ in range(3):
                g = gs(A)
                if g["phase"] != "playing":
                    wait_for(lambda: gs(A)["phase"] == "playing", 6)
                    g = gs(A)
                active = g["activeDeviceId"]
                tile = next(t for t in st(A)["layout"]["tiles"] if t["deviceId"] == active)
                hx = g["snake"]["path"][0][0]
                want = "right" if hx < tile["x"] + tile["w"] / 2 else "left"
                if g["snake"]["dir"] != want:
                    name = next(d["name"] for d in st(A)["devices"] if d["deviceId"] == active)
                    if g["snake"]["dir"] == {"right": "left", "left": "right"}[want]:
                        swipe(pages[name], world_to_local_dir(name, "up")); time.sleep(0.25)
                    swipe(pages[name], world_to_local_dir(name, want))
                crossed = wait_for(lambda: gs(A)["activeDeviceId"] != active and gs(A)["phase"] == "playing", 5)
                if crossed:
                    break
            g = gs(A)
            new_name = next(d["name"] for d in st(A)["devices"] if d["deviceId"] == g["activeDeviceId"])
            ok("snake crosses to the next phone and control hands off", crossed, f"now {new_name}, crossings {g['events'][-1]}")
            time.sleep(0.12)
            if shots:
                for n, pg in pages.items():
                    shot(pg, f"12_game_{n}")
            ok("new controller glows, old one doesn't", pages[new_name].evaluate("() => document.querySelector('.ms-stage').classList.contains('ms-stage--active')")
               and not pages[active_name].evaluate("() => document.querySelector('.ms-stage').classList.contains('ms-stage--active')") if new_name != active_name else True)

            # ---------------- disconnect / reconnect ----------------
            victim = next(n for n in pages if n != "TIM")
            vp = pages[victim]
            vp.evaluate("() => { window.__blockReconnect = true; ws.close(); }")
            pause = wait_for(lambda: (gs(A) or {}).get("paused"), 4)
            ok("a phone drops -> the whole table pauses", pause and any(r["kind"] == "lost" for r in pause["reasons"]))
            A.wait_for_selector(".ms-pause", timeout=3000)
            ok("everyone sees who is missing", victim in A.inner_text(".ms-pause"), A.inner_text(".ms-pause"))
            shot(A, "13_pause_lost")
            frozen = gs(A)["snake"]["path"][0]
            time.sleep(0.6)
            ok("the world stands still while paused", gs(A)["snake"]["path"][0] == frozen)
            # app.js reconnects on its own (1s backoff) and MultiScreen re-attaches
            back_ok = wait_for(lambda: not ((gs(A) or {}).get("paused") or {}).get("reasons"), 8)
            ok("reconnect: same tile, game resumes after 3-2-1", back_ok and wait_for(lambda: not (gs(A) or {}).get("paused"), 6))

            # ---------------- orientation flip ----------------
            vp.set_viewport_size({"width": PHONES["iphone" if victim == "SARAH" else "android"]["viewport"]["height"],
                                  "height": PHONES["iphone" if victim == "SARAH" else "android"]["viewport"]["width"]})
            vp.evaluate("() => window.dispatchEvent(new Event('orientationchange'))")
            rot = wait_for(lambda: any(r["kind"] == "orientation" for r in ((gs(A) or {}).get("paused") or {}).get("reasons", [])), 4)
            ok("turning a phone mid-game pauses with a clear message", rot and "gedreht" in A.inner_text(".ms-pause"))
            shot(A, "14_pause_rotated")
            vp.set_viewport_size(PHONES["iphone" if victim == "SARAH" else "android"]["viewport"])
            vp.evaluate("() => window.dispatchEvent(new Event('orientationchange'))")
            ok("turning it back resumes", wait_for(lambda: not (gs(A) or {}).get("paused"), 8))

            # ---------------- small browser-bar change: no pause ----------------
            vs = PHONES["iphone" if victim == "SARAH" else "android"]["viewport"]
            vp.set_viewport_size({"width": vs["width"], "height": vs["height"] - 60})
            time.sleep(0.8)
            ok("browser bar resize doesn't pause or reshape the world", not (gs(A) or {}).get("paused") and st(A)["layout"]["tiles"] == st(B)["layout"]["tiles"])
            vp.set_viewport_size(vs)

            # ---------------- end -> results -> chat -> close ----------------
            A.click(".ms-menu-btn")
            A.click(".ms-menu [data-act='end']")
            A.wait_for_selector(".ms-results", timeout=5000)
            ok("game over: results with shared score on every phone", all(pg.wait_for_selector(".ms-results", timeout=5000) for pg in pages.values()))
            shot(A, "15_results_host")
            shot(C, "15_results_guest")
            B.click(".ms-results [data-act='chat']")
            ok("after the game the chat is reachable again", B.is_visible("#ms-return-bar") and B.is_visible("#message-input"))
            B.click("#ms-return-bar")
            A.click(".ms-results [data-act='close']")
            ok("host closes the table -> every phone leaves MultiScreen", wait_for(lambda: all(pg.evaluate("() => !window.MultiScreen.isOpen()") for pg in pages.values()), 4))

            errors = [e for pg in pages.values() for e in pg.errors if "favicon" not in e and "WebSocket" not in e]
            ok("no JS errors on any phone", not errors, "; ".join(errors[:3]))
            browser.close()
    finally:
        proc.terminate()

    fails = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(fails)}/{len(RESULTS)} checks passed")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
