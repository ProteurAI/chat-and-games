"""Chat core regression: every chat feature with two real clients (desktop
host + phone), system states (reconnect, offline, refresh, logout),
security basics and stress/lifecycle checks. Real server from a temp copy.

    python tests/e2e/chat_regression.py [--browser webkit]
"""

import base64
import io
import json
import os
import re
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from games_regression import RECORDER, errors, modal_open, wait  # noqa: E402
from kopfkicker_e2e import WS_SPY, login, start_server  # noqa: E402

RESULTS = []


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""), flush=True)


def client(browser, base, user, w, h, phone):
    kw = dict(viewport={"width": w, "height": h})
    if phone:
        kw.update(device_scale_factor=2, is_mobile=True, has_touch=True)
    ctx = browser.new_context(**kw)
    if user:
        ctx.add_init_script(f"if (!sessionStorage.getItem('loggedOutOnce')) {{ localStorage.setItem('instachat_token', {json.dumps(user['token'])});"
                            f"localStorage.setItem('instachat_user', {json.dumps(json.dumps(user['user']))}); }}")
    ctx.add_init_script(WS_SPY)
    ctx.add_init_script(RECORDER)
    page = ctx.new_page()
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    page.on("console", lambda m: page.errors.append(m.text) if m.type == "error" else None)
    page.goto(base + "/")
    page.wait_for_function("() => typeof ws !== 'undefined' && ws && ws.readyState === 1 && currentChannelId && !document.querySelector('.chat-loading')", timeout=15000)
    return ctx, page


def send(page, text):
    page.fill("#message-input", text)
    page.press("#message-input", "Enter")


def texts(page):
    return page.evaluate("() => [...document.querySelectorAll('#messages .msg')].map((m) => m.querySelector('.bubble').innerText)")


def last_msg(page):
    return page.evaluate("""() => { const m = [...document.querySelectorAll('#messages .msg')].pop(); if (!m) return null;
        return { id: +m.dataset.messageId, cont: m.classList.contains('msg--cont'), text: m.querySelector('.bubble').innerText, html: m.querySelector('.bubble').innerHTML }; }""")


def png_b64(color):
    from PIL import Image
    img = Image.new("RGB", (320, 240), color)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def upload(page, color):
    return page.evaluate("""async (b64) => {
        const bin = atob(b64); const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const fd = new FormData(); fd.append('file', new Blob([arr], { type: 'image/png' }), 'a.png');
        const r = await fetch('/api/upload', { method: 'POST', headers: { 'X-Auth-Token': localStorage.getItem('instachat_token') }, body: fd });
        return (await r.json()).image_path; }""", png_b64(color))


def listeners(page):
    return page.evaluate("() => window.__listeners()")


def main():
    proc, base, tmp = start_server()
    try:
        ua, ub = login(base, "Ana"), login(base, "Ben")
        with sync_playwright() as pw:
            engine = sys.argv[sys.argv.index("--browser") + 1] if "--browser" in sys.argv else "chromium"
            browser = getattr(pw, engine).launch()
            ca, A = client(browser, base, ua, 1440, 900, False)
            cb, B = client(browser, base, ub, 390, 844, True)

            # ---------------- send / receive / grouping ----------------
            send(A, "Hallo Ben!")
            ok("message arrives on the other client", wait(lambda: "Hallo Ben!" in texts(B), 4))
            send(A, "Noch eine Nachricht direkt hinterher")
            wait(lambda: "Noch eine Nachricht direkt hinterher" in texts(B), 4)
            ok("same author within minutes -> grouped (no repeated header)", last_msg(B)["cont"])
            send(B, "Hi Ana 👋")
            ok("reply arrives, starts a new group", wait(lambda: "Hi Ana 👋" in texts(A), 4) and not last_msg(A)["cont"])
            ok("sent text leaves the composer empty", A.input_value("#message-input") == "")

            # ---------------- multi-line + links + injection ----------------
            A.fill("#message-input", "Zeile 1")
            A.press("#message-input", "Shift+Enter")
            A.type("#message-input", "Zeile 2")
            ok("Shift+Enter = new line, not send", "\n" in A.input_value("#message-input"))
            A.press("#message-input", "Enter")
            ok("multi-line message keeps its line break", wait(lambda: last_msg(B) and last_msg(B)["text"] == "Zeile 1\nZeile 2", 4), repr(last_msg(B)))
            send(A, "Regeln: https://example.com/spiel?x=1. Bis gleich")
            wait(lambda: "example.com" in (last_msg(B) or {}).get("text", ""), 4)
            link = B.evaluate("() => { const a = [...document.querySelectorAll('#messages .bubble a')].pop(); return a && { href: a.href, target: a.target, rel: a.rel, text: a.textContent }; }")
            ok("URLs become safe links (new tab, noopener, trailing dot excluded)",
               link and link["href"] == "https://example.com/spiel?x=1" and link["target"] == "_blank" and "noopener" in link["rel"], str(link))
            evil = '<img src=x onerror="window.__xss=1"><b>fett</b><script>window.__xss=2</script> javascript:alert(1)'
            send(A, evil)
            wait(lambda: "fett" in (last_msg(B) or {}).get("text", ""), 4)
            m = last_msg(B)
            ok("HTML in messages is shown as text, never executed", m["text"] == evil and "<img" not in m["html"].replace("&lt;img", "")
               and not B.evaluate("() => window.__xss") and "<a" not in m["html"], m["html"][:120])

            # ---------------- reactions (touch: tap message -> bar) ----------------
            target = last_msg(B)["id"]
            B.click(f"#messages .msg[data-message-id='{target}'] .bubble")
            ok("phone: tapping a message shows the reaction bar", wait(lambda: B.evaluate(f"() => document.querySelector(\".msg[data-message-id='{target}']\").classList.contains('msg--actions')"), 2))
            B.click(f"#messages .msg[data-message-id='{target}'] .reaction-quickbar button >> nth=3")
            pill = wait(lambda: A.evaluate(f"() => {{ const p = document.querySelector(\".msg[data-message-id='{target}'] .reaction-pill\"); return p && p.textContent; }}"), 4)
            ok("reaction reaches the other client", pill and "🔥 1" in pill, str(pill))
            A.click(f"#messages .msg[data-message-id='{target}'] .reaction-pill")
            ok("tapping a pill joins the reaction", wait(lambda: "🔥 2" in B.evaluate(f"() => document.querySelector(\".msg[data-message-id='{target}'] .reaction-pill\").textContent"), 4))
            A.click(f"#messages .msg[data-message-id='{target}'] .reaction-pill")
            ok("tapping it again removes it", wait(lambda: "🔥 1" in B.evaluate(f"() => document.querySelector(\".msg[data-message-id='{target}'] .reaction-pill\").textContent"), 4))

            # ---------------- poll ----------------
            A.click("#poll-btn")
            A.fill("#poll-question", "Pizza oder Pasta?")
            A.fill("#poll-options input >> nth=0", "Pizza")
            A.fill("#poll-options input >> nth=1", "Pasta")
            A.click("#poll-submit")
            ok("poll appears for the other client", wait(lambda: B.evaluate("() => [...document.querySelectorAll('.poll-question')].some((q) => q.textContent === 'Pizza oder Pasta?')"), 4))
            B.click(".poll:last-of-type .poll-option >> nth=0")
            ok("vote updates everyone (100% · 1 Stimme)", wait(lambda: A.evaluate("() => { const p = [...document.querySelectorAll('.poll')].pop(); return p.textContent.includes('100%') && p.textContent.includes('1 Stimme'); }"), 4))

            # ---------------- snap: per-viewer view-once ----------------
            path = upload(A, (200, 80, 140))
            A.evaluate("(p) => ws.send(JSON.stringify({ type: 'snap_message', channel_id: currentChannelId, image_path: p }))", path)
            snapsel = ".snap-frame"
            ok("snap arrives blurred for the viewer", wait(lambda: B.evaluate(f"() => {{ const s = [...document.querySelectorAll('{snapsel}')].pop(); return s && s.classList.contains('snap-blurred'); }}"), 4))
            ok("...and blurred for the sender too", A.evaluate(f"() => [...document.querySelectorAll('{snapsel}')].pop().classList.contains('snap-blurred')"))
            B.click(f"{snapsel} >> nth=-1")
            ok("viewer taps -> sharp for them", wait(lambda: not B.evaluate(f"() => [...document.querySelectorAll('{snapsel}')].pop().classList.contains('snap-blurred')"), 2))
            ok("no global unlock: still blurred for the sender", A.evaluate(f"() => [...document.querySelectorAll('{snapsel}')].pop().classList.contains('snap-blurred')"))
            time.sleep(8.6)
            ok("after the view time it's blurred again, marked as seen", B.evaluate(f"() => {{ const s = [...document.querySelectorAll('{snapsel}')].pop(); return s.classList.contains('snap-blurred') && s.textContent.includes('Bereits angesehen'); }}"))
            B.reload()
            B.wait_for_function("() => typeof ws !== 'undefined' && ws && ws.readyState === 1 && document.querySelectorAll('#messages .msg').length > 3", timeout=15000)
            ok("...and stays seen after a reload", B.evaluate(f"() => {{ const s = [...document.querySelectorAll('{snapsel}')].pop(); return s.classList.contains('snap-blurred') && !s.classList.contains('snap-clickable'); }}"))

            # ---------------- channels: live list + unread ----------------
            A.fill("#new-channel-input", "Turnier <b>2026</b>")
            A.press("#new-channel-input", "Enter")
            ok("new channel is sanitised and selected", wait(lambda: A.evaluate("() => document.querySelector('.channel-item.active .channel-item-name').textContent") == "turnier--b-2026--b", 4))
            ok("other client sees the new channel live (no reload)", wait(lambda: B.evaluate("() => channels.some((c) => c.name === 'turnier--b-2026--b')"), 4))
            send(A, "Anmeldung fürs Turnier läuft")
            ok("unread badge for a channel you're not in", wait(lambda: B.evaluate("() => { const b = [...document.querySelectorAll('.channel-item')].find((x) => x.textContent.includes('turnier')); return b && b.querySelector('.count-badge') && b.querySelector('.count-badge').textContent === '1'; }"), 4))
            ok("phone: unread dot on the menu button", B.evaluate("() => !document.getElementById('mobile-unread-dot').hidden"))
            B.click("#mobile-menu-btn")
            time.sleep(0.4)
            B.click(".channel-item:has-text('turnier')")
            ok("opening it shows the message and clears the badge", wait(lambda: "Anmeldung fürs Turnier läuft" in texts(B) and not B.evaluate("() => document.querySelector('.channel-item.active .count-badge')"), 4))
            ok("drawer closes after picking a channel", not B.evaluate("() => document.getElementById('left-sidebar').classList.contains('open')"))

            # ---------------- channel switch race (slow history for #allgemein) ----------------
            gen_id = B.evaluate("() => channels.find((c) => c.name === 'allgemein').id")
            tur_id = B.evaluate("() => channels.find((c) => c.name !== 'allgemein').id")

            # the history of #allgemein answers slowly (deterministic, in the page)
            B.evaluate(f"""() => {{ window.__origFetch = window.__origFetch || window.fetch;
                window.fetch = (u, o) => String(u).includes('/api/channels/{gen_id}/messages')
                  ? new Promise((r) => setTimeout(r, 900)).then(() => window.__origFetch(u, o)) : window.__origFetch(u, o); }}""")
            B.evaluate(f"() => {{ selectChannel({gen_id}); setTimeout(() => selectChannel({tur_id}), 50); }}")
            B.wait_for_timeout(1600)
            ok("fast channel switch: the slower old response never paints over the new channel",
               B.evaluate(f"() => currentChannelId === {tur_id}") and texts(B) and all("Hallo Ben" not in t for t in texts(B)) and "Anmeldung fürs Turnier läuft" in texts(B), str(texts(B)[-2:]))
            B.evaluate("() => { window.fetch = window.__origFetch; }")
            B.evaluate(f"() => selectChannel({gen_id})")
            A.evaluate(f"() => selectChannel({gen_id})")
            wait(lambda: "Hallo Ben!" in texts(B), 5)

            # ---------------- reconnect: banner + missed messages ----------------
            n_before = len(texts(B))
            B.evaluate("() => ws.close()")
            banner = wait(lambda: B.evaluate("() => { const b = document.getElementById('conn-banner'); return !b.hidden && b.textContent; }"), 2)
            ok("drop -> 'Verbindung wird wiederhergestellt' banner", banner and "wiederhergestellt" in banner, str(banner))
            send(A, "Während du weg warst")
            restored = wait(lambda: B.evaluate("() => { const b = document.getElementById('conn-banner'); return !b.hidden && b.textContent.includes('Wieder verbunden'); }"), 6)
            ok("reconnect -> short 'Wieder verbunden'", restored)
            ok("missed message is fetched after reconnect, no duplicates",
               wait(lambda: texts(B).count("Während du weg warst") == 1, 5) and len(texts(B)) == n_before + 1, f"{n_before} -> {len(texts(B))}")
            ok("banner disappears again by itself", wait(lambda: B.evaluate("() => document.getElementById('conn-banner').hidden"), 4))

            # ---------------- offline: nothing is lost ----------------
            cb.set_offline(True)
            B.evaluate("() => window.dispatchEvent(new Event('offline'))")
            ok("offline banner", wait(lambda: "offline" in B.inner_text("#conn-banner"), 3))
            B.fill("#message-input", "Das soll nicht verloren gehen")
            B.press("#message-input", "Enter")
            time.sleep(0.4)
            ok("sending offline keeps the text and tells the user", B.input_value("#message-input") == "Das soll nicht verloren gehen"
               and B.evaluate("() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('nicht gesendet'))"))
            cb.set_offline(False)
            B.evaluate("() => window.dispatchEvent(new Event('online'))")
            ok("back online -> reconnects", wait(lambda: B.evaluate("() => ws && ws.readyState === 1"), 8))
            B.press("#message-input", "Enter")
            ok("...and the kept text can be sent", wait(lambda: "Das soll nicht verloren gehen" in texts(A), 5) and B.input_value("#message-input") == "")

            # ---------------- new-messages pill ----------------
            for i in range(14):
                A.evaluate(f"() => ws.send(JSON.stringify({{ type: 'message', channel_id: currentChannelId, content: 'Füllnachricht {i}' }}))")
            wait(lambda: "Füllnachricht 13" in texts(B), 5)
            B.evaluate("() => { const m = document.getElementById('messages'); m.scrollTop = 0; m.dispatchEvent(new Event('scroll')); }")
            time.sleep(0.2)
            send(A, "Neue Nachricht unten")
            pill = wait(lambda: not B.evaluate("() => document.getElementById('new-messages-pill').hidden"), 3)
            ok("scrolled up: new message shows a pill instead of jumping", pill and B.evaluate("() => document.getElementById('messages').scrollTop") < 50)
            B.click("#new-messages-pill")
            ok("pill jumps to the newest message", wait(lambda: B.evaluate("() => { const m = document.getElementById('messages'); return m.scrollHeight - m.scrollTop - m.clientHeight < 5; }"), 2))

            # ---------------- phone keyboard (visual viewport shrinks) ----------------
            B.focus("#message-input")
            B.set_viewport_size({"width": 390, "height": 480})
            time.sleep(0.4)
            kb = B.evaluate("""() => { const r = document.getElementById('message-form').getBoundingClientRect(); const h = document.querySelector('.mobile-header').getBoundingClientRect();
                return { formBottom: r.bottom, vh: innerHeight, headerTop: h.top }; }""")
            ok("keyboard open: composer stays above it, header stays visible", kb["formBottom"] <= kb["vh"] + 1 and kb["headerTop"] >= -1, str(kb))
            kbpin = B.evaluate("""() => { const m = document.getElementById('messages'); const last = [...m.querySelectorAll('.msg')].pop();
                return { gap: Math.round(m.scrollHeight - m.scrollTop - m.clientHeight), lastVisible: last.getBoundingClientRect().bottom <= m.getBoundingClientRect().bottom + 2 }; }""")
            ok("keyboard open: the newest message stays in view", kbpin["gap"] < 5 and kbpin["lastVisible"], str(kbpin))
            B.set_viewport_size({"width": 390, "height": 844})
            time.sleep(0.3)

            # ---------------- security: malformed ws traffic ----------------
            A.evaluate("""() => {
                const bad = [
                  { type: 'message', channel_id: currentChannelId, content: 123 },
                  { type: 'message', channel_id: 'x', content: 'hi' },
                  { type: 'poll_create', channel_id: currentChannelId, question: 'Q', options: [1, 2, 3] },
                  { type: 'poll_create', channel_id: currentChannelId, question: 'Q', options: 'abc' },
                  { type: 'image_message', channel_id: currentChannelId, image_path: '../../config.json' },
                  { type: 'snap_message', channel_id: currentChannelId, image_path: 'javascript:alert(1)' },
                  { type: 'reaction', message_id: 1, emoji: 'x'.repeat(200) },
                  { type: 'poll_vote', message_id: 1, option_id: 999999 },
                  { type: 'game_input', session_id: 5, payload: 'nope' },
                  { type: 'ms_join', code: { a: 1 }, deviceId: [] },
                ];
                for (const b of bad) ws.send(JSON.stringify(b));
                ws.send('this is not json');
                ws.send(JSON.stringify([1, 2, 3]));
                ws.send('x'.repeat(70000));
            }""")
            time.sleep(0.5)
            send(A, "Verbindung lebt noch")
            ok("malformed messages are ignored, the connection survives", wait(lambda: "Verbindung lebt noch" in texts(B), 4) and A.evaluate("() => ws.readyState === 1"))
            ok("no bogus message rendered from bad input", not any(t in ("123", "hi") for t in texts(B)) and not B.evaluate("() => document.querySelector('#messages img[src*=\"config.json\"], #messages img[src^=\"javascript\"]')"))

            # ---------------- uploads: every allowed type round-trips ----------------
            # (the stored name must match what image/snap messages are validated against)
            from PIL import Image
            for fmt, mime, ext in (("JPEG", "image/jpeg", "jpg"), ("WEBP", "image/webp", "webp"), ("GIF", "image/gif", "gif")):
                buf = io.BytesIO()
                Image.new("RGB", (64, 48), (30, 120, 200)).save(buf, fmt)
                name = A.evaluate("""async ([b64, mime]) => { const bin = atob(b64); const arr = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
                    const fd = new FormData(); fd.append('file', new Blob([arr], { type: mime }), 'photo');
                    const r = await fetch('/api/upload', { method: 'POST', headers: { 'X-Auth-Token': localStorage.getItem('instachat_token') }, body: fd });
                    return (await r.json()).image_path; }""", [base64.b64encode(buf.getvalue()).decode(), mime])
                A.evaluate("(p) => ws.send(JSON.stringify({ type: 'image_message', channel_id: currentChannelId, image_path: p }))", name)
                shown = wait(lambda: B.evaluate("(p) => !!document.querySelector(`#messages img[src$='${p}']`)", name), 4)
                ok(f"{fmt} upload: stable .{ext} name, accepted as chat image", bool(re.match(rf"^[0-9a-f]{{32}}\.{ext}$", name or "")) and shown, str(name))

            # ---------------- theme 10x + persistence ----------------
            first = A.evaluate("() => document.documentElement.dataset.theme")
            for _ in range(10):
                A.click("#theme-toggle")
            ok("theme toggles cleanly 10x", A.evaluate("() => document.documentElement.dataset.theme") == first)
            A.click("#theme-toggle")
            flipped = A.evaluate("() => document.documentElement.dataset.theme")
            A.reload()
            A.wait_for_function("() => typeof ws !== 'undefined' && ws && ws.readyState === 1", timeout=15000)
            ok("theme choice survives a refresh", A.evaluate("() => document.documentElement.dataset.theme") == flipped)
            ok("refresh: still logged in, chat loads", wait(lambda: len(texts(A)) > 5, 6))

            # ---------------- keyboard basics (desktop) ----------------
            A.focus("#message-input")
            A.keyboard.press("Tab")
            ok("Tab from the composer reaches the send button", A.evaluate("() => document.activeElement.id") == "send-btn")
            A.click("#open-games-library-btn")
            A.keyboard.press("Escape")
            ok("Escape closes the games library", A.evaluate("() => document.getElementById('games-library-overlay').hidden"))
            ok("icon-only buttons all have an accessible name", A.evaluate("""() => [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null && !b.textContent.trim() && !b.getAttribute('aria-label')).map((b) => b.id || b.className)""") == [])

            # ---------------- stress + listener lifecycle ----------------
            base_b = listeners(B)
            for _ in range(20):
                B.click("#mobile-menu-btn"); time.sleep(0.05)
                B.click("#sidebar-close-btn"); time.sleep(0.05)
            for _ in range(20):
                B.click("#mobile-games-btn"); time.sleep(0.05)
                B.click("#games-panel-close-btn"); time.sleep(0.05)
            time.sleep(0.4)
            ok("20x channel drawer + 20x games drawer: nothing stuck open, no scroll lock",
               B.evaluate("() => !document.querySelector('.left-sidebar.open, .games-panel.open, .drawer-backdrop.open') && !document.body.classList.contains('scroll-locked')"))
            ids = A.evaluate("() => channels.map((c) => c.id)")
            base_a = listeners(A)
            for i in range(20):
                A.evaluate(f"() => selectChannel({ids[i % len(ids)]})")
                time.sleep(0.08)
            time.sleep(0.8)
            ok("20x channel switch: ends on the right channel", A.evaluate(f"() => currentChannelId === {ids[19 % len(ids)]} && !document.querySelector('.chat-loading')"))
            for _ in range(10):
                A.evaluate("() => launchGameByType('timliner')")
                wait(lambda: modal_open(A), 3)
                A.click("#game-close-btn")
                wait(lambda: not modal_open(A), 3)
            time.sleep(0.3)
            ok("10x game open/close: window/document listeners don't grow", listeners(A) - base_a <= 4, f"{base_a} -> {listeners(A)}")
            ok("drawers 40x: window/document listeners don't grow", listeners(B) - base_b <= 2, f"{base_b} -> {listeners(B)}")
            # game chat 20x inside a running game
            A.evaluate("() => ws.send(JSON.stringify({ type: 'game_create', game_type: 'tictactoe' }))")
            sid = wait(lambda: A.evaluate("() => myGameSessionId"), 4)
            B.evaluate(f"() => joinGame('{sid}')")
            wait(lambda: A.evaluate(f"() => (gameSessions.find((s) => s.id === '{sid}') || {{}}).player_count === 2"), 4)
            A.evaluate(f"() => startGameNow('{sid}')")
            wait(lambda: modal_open(B), 5)
            for _ in range(20):
                B.click("#game-chat-toggle"); time.sleep(0.05)
                B.click("#game-chat-close-btn"); time.sleep(0.05)
            time.sleep(0.5)
            ok("20x game chat open/close: closed, no backdrop, no scroll lock", B.evaluate(
                "() => !document.getElementById('game-chat-panel').classList.contains('open') && !document.querySelector('.game-chat-backdrop.open') && !document.body.classList.contains('scroll-locked')"))
            for p in (B, A):
                if modal_open(p):
                    p.click("#game-close-btn")

            # ---------------- logout / login ----------------
            B.click("#mobile-menu-btn")
            time.sleep(0.3)
            B.click("#logout-btn")
            B.wait_for_selector(".dialog-overlay", timeout=3000)
            B.keyboard.press("Escape")
            ok("logout asks first; Escape cancels", B.evaluate("() => !document.querySelector('.dialog-overlay') && !document.getElementById('app').hidden"))
            B.click("#logout-btn")
            B.evaluate("() => sessionStorage.setItem('loggedOutOnce', '1')")
            B.click(".dialog-overlay [data-act='ok']")
            B.wait_for_selector("#login-form", timeout=8000)
            ok("logout returns to the login screen", B.evaluate("() => !document.getElementById('login-screen').hidden"))
            B.fill("#login-name", "Ben")
            B.fill("#login-code", "falsch")
            B.click("#login-submit")
            ok("wrong code: clear, friendly error", wait(lambda: B.evaluate("() => { const e = document.getElementById('login-error'); return !e.hidden && e.textContent; }"), 4) == "Der Zugangscode stimmt nicht.")
            cfg = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "config.json"), encoding="utf-8"))
            B.fill("#login-code", cfg["team_password"])
            B.click("#login-submit")
            ok("login works again", wait(lambda: B.evaluate("() => !document.getElementById('app').hidden && ws && ws.readyState === 1"), 8))

            errs = [e for e in errors(A) + errors(B) if "net::ERR_INTERNET_DISCONNECTED" not in e and "Failed to load resource" not in e]
            ok("no console errors on either client", not errs, "; ".join(errs[:4]))
            browser.close()
    finally:
        proc.terminate()
    fails = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(fails)}/{len(RESULTS)} checks passed")
    for f in fails:
        print("  FAILED:", f[0], "|", f[2][:240])
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
