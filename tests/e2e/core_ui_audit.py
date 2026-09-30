"""Core UI audit / regression: screenshots of every core surface across
viewports and both themes, plus layout assertions (no horizontal page
overflow, header + composer inside the viewport, primary controls with a
real size, no console errors).

    python tests/e2e/core_ui_audit.py [--shots DIR] [--quick] [--browser webkit]

Runs the real server from a temp copy (never touches the real database)
and seeds a realistic conversation: grouped messages, a long message,
a link, an image, a snap, a poll, reactions.
"""

import io
import json
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from kopfkicker_e2e import WS_SPY, login, start_server  # noqa: E402

RESULTS = []

MOBILE = [(360, 800), (375, 667), (390, 844), (393, 852), (412, 915), (430, 932)]
LANDSCAPE = [(667, 375), (844, 390), (852, 393), (915, 412), (932, 430)]
TABLET = [(768, 1024), (1024, 768)]
DESKTOP = [(1280, 720), (1366, 768), (1440, 900), (1920, 1080), (2560, 1440)]


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    if not cond or "-v" in sys.argv:
        print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def png(color=(90, 140, 220)):
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (640, 420), color)
    d = ImageDraw.Draw(img)
    d.ellipse((220, 90, 420, 290), fill=(255, 210, 120))
    d.rectangle((0, 330, 640, 420), fill=(40, 120, 70))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def context(browser, base, user, w, h, theme="light", mobile=None):
    mobile = (w < 900 or h < 500) if mobile is None else mobile
    kw = dict(viewport={"width": w, "height": h})
    if mobile:
        kw.update(device_scale_factor=2, is_mobile=True, has_touch=True)
    ctx = browser.new_context(**kw)
    if user:
        ctx.add_init_script(f"localStorage.setItem('instachat_token', {json.dumps(user['token'])});"
                            f"localStorage.setItem('instachat_user', {json.dumps(json.dumps(user['user']))});")
    ctx.add_init_script(f"localStorage.setItem('cg_theme', '{theme}');")
    ctx.add_init_script(WS_SPY)
    page = ctx.new_page()
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    page.on("console", lambda m: page.errors.append(m.text) if m.type == "error" else None)
    page.goto(base + "/")
    if user:
        page.wait_for_function("() => typeof ws !== 'undefined' && ws && ws.readyState === 1", timeout=10000)
        page.wait_for_function("() => document.querySelectorAll('#messages .msg, #messages .empty-state, #messages [class*=empty]').length > 0 || currentChannelId", timeout=10000)
    return ctx, page


def seed(base, page_a, page_b, tmp):
    """A realistic conversation between two users."""
    send = lambda page, payload: page.evaluate("(p) => ws.send(JSON.stringify(Object.assign({channel_id: currentChannelId}, p)))", payload)  # noqa: E731
    send(page_a, {"type": "message", "content": "Hey! Wer ist heute Abend dabei? 🎮"})
    time.sleep(0.05)
    send(page_a, {"type": "message", "content": "Ich dachte an Kritzelmeister und danach KopfKicker"})
    time.sleep(0.05)
    send(page_b, {"type": "message", "content": "Bin dabei! Link zu den Regeln: https://example.com/regeln"})
    time.sleep(0.05)
    send(page_b, {"type": "message", "content": "Das hier ist eine absichtlich sehr lange Nachricht, um zu prüfen, wie der Chat mit mehrzeiligen Texten umgeht, ob die Zeilenlänge angenehm lesbar bleibt und nichts über den Rand hinausläuft. Außerdem ein sehr langes Wort: Donaudampfschifffahrtsgesellschaftskapitänsmützenhalterung."})
    time.sleep(0.05)
    for kind in ("image", "snap"):
        f = tmp / f"audit_{kind}.png"
        f.write_bytes(png((90, 140, 220) if kind == "image" else (200, 90, 140)))
        up = page_a.evaluate("""async (b64) => {
            const bin = atob(b64); const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            const fd = new FormData(); fd.append('file', new Blob([arr], {type: 'image/png'}), 'a.png');
            const r = await fetch('/api/upload', {method: 'POST', headers: {'X-Auth-Token': localStorage.getItem('instachat_token')}, body: fd});
            return r.json(); }""", __import__("base64").b64encode(f.read_bytes()).decode())
        send(page_a, {"type": f"{kind}_message", "image_path": up["image_path"]})
        time.sleep(0.05)
    send(page_b, {"type": "poll_create", "question": "Welches Spiel zuerst?", "options": ["Kritzelmeister", "KopfKicker", "Wer bin ich?"]})
    time.sleep(0.3)
    ids = page_a.evaluate("() => [...document.querySelectorAll('#messages [data-message-id], #messages [data-id]')].map((e) => +(e.dataset.messageId || e.dataset.id)).filter(Boolean)")
    if ids:
        send(page_b, {"type": "reaction", "message_id": ids[0], "emoji": "🔥"})
        send(page_a, {"type": "reaction", "message_id": ids[0], "emoji": "😂"})
    send(page_a, {"type": "message", "content": "Perfekt 👍"})
    time.sleep(0.4)


# WCAG text contrast of every visible, uncovered text node against the
# background it is actually painted on (semi-transparent layers and element
# opacity composited). Exempt like WCAG does: disabled controls, emoji,
# gradient-clipped text; text on images/gradients can't be computed and is
# counted as skipped.
CONTRAST_JS = r"""async () => {
    // measure the resting state: let finite entrance animations (fades) end
    const finite = document.getAnimations().filter((a) => a.effect && a.effect.getComputedTiming().iterations !== Infinity);
    await Promise.race([Promise.all(finite.map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 2000))]);
    const parse = (c) => {
        let m = c.match(/^rgba?\(([^)]+)\)$/);
        if (m) { const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
        m = c.match(/^color\(srgb ([^)]+)\)$/);
        if (m) { const p = m[1].split(/[\s\/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1]; }
        return null;
    };
    const over = (t, b) => { const a = t[3] + b[3] * (1 - t[3]); if (!a) return [0, 0, 0, 0];
        return [0, 1, 2].map((i) => (t[i] * t[3] + b[i] * b[3] * (1 - t[3])) / a).concat([a]); };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const ratio = (x, y) => { const a = lum(x), b = lum(y); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
    const EMOJI = /^[\p{Extended_Pictographic}‍️\s]+$/u;
    const path = (e) => { const one = (n) => n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") +
        (typeof n.className === "string" && n.className.trim() ? "." + n.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
        return (e.parentElement ? one(e.parentElement) + " > " : "") + one(e); };
    const out = { checked: 0, skipped: 0, fails: [] };
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const t = walker.currentNode, txt = t.nodeValue.trim(), el = t.parentElement;
        if (!txt || !el || EMOJI.test(txt) || seen.has(el)) continue;
        seen.add(el);
        if (el.closest("svg, script, style, noscript, [aria-hidden='true'], .sr-only, .visually-hidden, :disabled, [aria-disabled='true']")) continue;
        if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        const range = document.createRange(); range.selectNodeContents(t);
        const r = [...range.getClientRects()].find((q) => q.width > 1 && q.height > 1);
        if (!r) continue;
        const cx = r.left + Math.min(r.width / 2, 8), cy = r.top + r.height / 2;
        if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) continue;
        const top = document.elementFromPoint(cx, cy);
        if (!top || !(top === el || el.contains(top) || top.contains(el))) { out.skipped++; continue; }   // covered
        const cs = getComputedStyle(el);
        if (cs.webkitBackgroundClip === "text" || cs.backgroundClip === "text" || parse(cs.webkitTextFillColor || cs.color)?.[3] === 0) continue;
        let fg = parse(cs.color); if (!fg) { out.skipped++; continue; }
        let op = 1; for (let a = el; a; a = a.parentElement) op *= parseFloat(getComputedStyle(a).opacity);
        fg = [fg[0], fg[1], fg[2], fg[3] * op];
        const chain = []; let complex = false;
        for (let a = el; a; a = a.parentElement) {
            const s = getComputedStyle(a);
            if (s.backgroundImage !== "none") { complex = true; break; }
            const c = parse(s.backgroundColor);
            if (c && c[3] > 0) { chain.push(c); if (c[3] >= 1) break; }
        }
        if (complex) { out.skipped++; continue; }
        let bg = [255, 255, 255, 1];
        for (let i = chain.length - 1; i >= 0; i--) bg = over(chain[i], bg);
        const cr = ratio(over(fg, bg), bg);
        const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10) || 400;
        const need = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
        out.checked++;
        if (cr < need - 0.01) out.fails.push({ text: txt.slice(0, 32), ratio: +cr.toFixed(2), need, fg: cs.color,
            bg: "rgb(" + bg.slice(0, 3).map(Math.round).join(",") + ")", path: path(el) });
    }
    return out;
}"""


def contrast_checks(page, label):
    res = page.evaluate(CONTRAST_JS)
    fails = res["fails"]
    ok(f"{label}: text contrast (WCAG AA, {res['checked']} texts)", not fails and res["checked"] > 0,
       " | ".join(f"{f['path']} '{f['text']}' {f['ratio']}<{f['need']} fg {f['fg']} bg {f['bg']}" for f in fails[:6]))


def layout_checks(page, label, mobile):
    m = page.evaluate("""() => {
        const vis = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
            return { x: r.left, y: r.top, w: r.width, h: r.height, b: r.bottom, r: r.right, shown: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0 }; };
        return {
            vw: window.innerWidth, vh: window.innerHeight,
            overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
            docScrollY: document.scrollingElement.scrollHeight > window.innerHeight + 1,
            // same compound query as the CSS mobile shell (landscape phones included)
            header: vis(document.querySelector(matchMedia('(max-width: 899px), (max-height: 480px) and (pointer: coarse)').matches ? '#mobile-header' : '.chat-header')),
            composer: vis(document.getElementById('message-form')),
            input: vis(document.getElementById('message-input')),
            send: vis(document.getElementById('send-btn')),
            messages: vis(document.getElementById('messages')),
        };
    }""")
    ok(f"{label}: no horizontal page overflow", not m["overflowX"])
    ok(f"{label}: page itself doesn't scroll (only the message list does)", not m["docScrollY"])
    for k in ("header", "composer", "input", "send", "messages"):
        v = m[k]
        good = v and v["shown"] and v["x"] >= -0.5 and v["y"] >= -0.5 and v["r"] <= m["vw"] + 0.5 and v["b"] <= m["vh"] + 0.5
        ok(f"{label}: {k} fully visible", good, json.dumps(v))
    if m["composer"] and m["messages"]:
        ok(f"{label}: composer sits at the bottom", m["vh"] - m["composer"]["b"] < 60 and m["composer"]["y"] >= m["messages"]["b"] - 1,
           f"composer {m['composer']['y']:.0f}-{m['composer']['b']:.0f} / vh {m['vh']}")
    if m["send"]:
        ok(f"{label}: send button touch size", m["send"]["h"] >= (40 if mobile else 32) and m["send"]["w"] >= (40 if mobile else 32), json.dumps(m["send"]))


def main():
    shots = None
    if "--shots" in sys.argv:
        shots = Path(sys.argv[sys.argv.index("--shots") + 1])
        shots.mkdir(parents=True, exist_ok=True)
    quick = "--quick" in sys.argv

    def shot(page, name):
        if shots:
            page.screenshot(path=str(shots / f"{name}.png"))

    proc, base, tmp = start_server()
    try:
        ua, ub = login(base, "Tim"), login(base, "Sarah")
        with sync_playwright() as p:
            engine = sys.argv[sys.argv.index("--browser") + 1] if "--browser" in sys.argv else "chromium"
            browser = getattr(p, engine).launch()
            # seed once
            ca, a = context(browser, base, ua, 1440, 900)
            cb, b = context(browser, base, ub, 1440, 900)
            seed(base, a, b, tmp)
            cb.close()
            ca.close()

            for theme in ("light", "dark"):
                # ---------------- login ----------------
                for (w, h) in ((1440, 900), (390, 844)):
                    ctx, page = context(browser, base, None, w, h, theme)
                    page.wait_for_selector("#login-form")
                    shot(page, f"{theme}_login_{w}x{h}")
                    ok(f"{theme} login {w}x{h}: no horizontal overflow", not page.evaluate("() => document.documentElement.scrollWidth > innerWidth + 1"))
                    contrast_checks(page, f"{theme} login {w}x{h}")
                    ctx.close()

                # ---------------- chat across viewports ----------------
                sizes = [(1440, 900), (390, 844)] if quick else DESKTOP + TABLET + MOBILE + LANDSCAPE
                for (w, h) in sizes:
                    ctx, page = context(browser, base, ua, w, h, theme)
                    page.wait_for_timeout(500)
                    label = f"{theme} chat {w}x{h}"
                    layout_checks(page, label, w < 900 or h < 500)
                    pin = page.evaluate("""async () => { await document.fonts.ready; await new Promise((r) => setTimeout(r, 200));
                        const b = document.getElementById('messages');
                        return { gap: +(b.scrollHeight - b.scrollTop - b.clientHeight).toFixed(1), sh: b.scrollHeight, st: +b.scrollTop.toFixed(1), ch: b.clientHeight, stuck: b._stuck }; }""")
                    ok(f"{label}: message list pinned to the newest message", pin["gap"] < 4, json.dumps(pin))
                    if (w, h) in ((1440, 900), (1024, 768), (390, 844), (844, 390)):
                        contrast_checks(page, label)
                    shot(page, f"{theme}_chat_{w}x{h}")
                    # WebKit reports the (Chrome-Android-only) interactive-widget
                    # viewport key as "not recognized and ignored" - a parser
                    # notice, not an app error
                    errs = [e for e in page.errors if "favicon" not in e and 'Viewport argument key "interactive-widget"' not in e]
                    ok(f"{label}: no console errors", not errs, "; ".join(errs[:2]))
                    ctx.close()

                # ---------------- desktop surfaces ----------------
                ctx, page = context(browser, base, ua, 1440, 900, theme)
                page.wait_for_timeout(300)
                page.evaluate("() => openGamesLibrary()")
                page.wait_for_timeout(300)
                shot(page, f"{theme}_desktop_library")
                contrast_checks(page, f"{theme} desktop library")
                page.evaluate("() => { document.getElementById('games-library-overlay').hidden = true; }")
                page.evaluate("() => { createParty(); openPartyOverlay(); }")
                page.wait_for_timeout(500)
                shot(page, f"{theme}_desktop_party")
                contrast_checks(page, f"{theme} desktop party")
                page.evaluate("() => { leaveParty(); document.getElementById('party-overlay').hidden = true; }")
                page.click("#poll-btn")
                page.wait_for_timeout(200)
                shot(page, f"{theme}_desktop_poll_composer")
                contrast_checks(page, f"{theme} desktop poll composer")
                page.click("#poll-close-btn")
                page.evaluate("() => launchGameByType('whoami')")
                page.wait_for_timeout(300)
                shot(page, f"{theme}_desktop_modal_whoami_options")
                contrast_checks(page, f"{theme} desktop game options modal")
                page.keyboard.press("Escape")
                page.evaluate("() => document.querySelectorAll('.modal-overlay').forEach((m) => { if (m.id !== 'game-modal' && m.id !== 'snap-modal') m.remove(); })")

                # ---------------- system states ----------------
                for st in ("reconnecting", "offline", "restored"):
                    page.evaluate("(s) => setConnState(s)", st)
                    page.wait_for_timeout(150)
                    shot(page, f"{theme}_desktop_conn_{st}")
                    contrast_checks(page, f"{theme} desktop connection banner '{st}'")
                    geo = page.evaluate("""() => { const b = document.getElementById('conn-banner'), t = b.querySelector('.conn-banner-text');
                        if (!t || b.hidden) return null; const rb = b.getBoundingClientRect(), rt = t.getBoundingClientRect();
                        return { bannerH: Math.round(rb.height), textH: Math.round(rt.height), text: t.textContent,
                                 inside: rt.top >= rb.top - 1 && rt.bottom <= rb.bottom + 1 && rt.left >= rb.left - 1 && rt.right <= rb.right + 1,
                                 announced: !t.closest('[aria-hidden="true"]') && b.getAttribute('role') === 'status' }; }""")
                    ok(f"{theme} connection banner '{st}': text on one line inside the bar, announced",
                       geo and geo["inside"] and geo["textH"] < 30 and geo["bannerH"] < 64 and geo["announced"], json.dumps(geo))
                page.evaluate("() => setConnState('online')")
                for typ in ("success", "warning", "error"):
                    page.evaluate("(t) => toast('Testmeldung (' + t + ')', t)", typ)
                page.wait_for_timeout(400)
                shot(page, f"{theme}_desktop_toasts")
                contrast_checks(page, f"{theme} desktop toasts")
                page.evaluate("() => { window.__dlg = confirmDialog({ title: 'Spiel verlassen?', text: 'Die anderen müssen dann pausieren.', confirmLabel: 'Verlassen', danger: true }); }")
                page.wait_for_timeout(350)
                shot(page, f"{theme}_desktop_confirm_dialog")
                contrast_checks(page, f"{theme} desktop confirm dialog")
                page.keyboard.press("Escape")
                ok(f"{theme} confirm dialog: Escape resolves false", page.evaluate("() => window.__dlg.then((v) => v === false)"))
                ctx.close()

                # ---------------- mobile surfaces ----------------
                ctx, page = context(browser, base, ua, 390, 844, theme)
                page.wait_for_timeout(300)
                page.click("#mobile-menu-btn")
                page.wait_for_timeout(450)
                shot(page, f"{theme}_mobile_channel_drawer")
                contrast_checks(page, f"{theme} mobile channel drawer")
                page.click("#drawer-backdrop", position={"x": 380, "y": 420})   # the visible strip right of the drawer
                page.wait_for_timeout(450)
                page.click("#mobile-games-btn")
                page.wait_for_timeout(450)
                shot(page, f"{theme}_mobile_games_drawer")
                contrast_checks(page, f"{theme} mobile games drawer")
                page.click("#games-panel-close-btn")
                page.wait_for_timeout(400)
                page.click("#poll-btn")
                page.wait_for_timeout(200)
                shot(page, f"{theme}_mobile_poll_composer")
                page.click("#poll-close-btn")
                page.focus("#message-input")
                page.wait_for_timeout(200)
                shot(page, f"{theme}_mobile_composer_focus")
                ctx.close()

            browser.close()
    finally:
        proc.terminate()

    fails = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(fails)}/{len(RESULTS)} checks passed")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
