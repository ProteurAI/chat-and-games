"""Regression run over EVERY game in the registry, with real browser
clients against the real server (temp copy - the real database is never
touched): a desktop host (1440x900) plus phones (390x844, 412x915).

Per game: lobby via the UI (phones join from the games drawer), NO
auto-start just because the lobby is full, host starts manually, the
primary interaction through the actual UI (and proof the input reached the
server), game chat on the phone (open, send, arrives, close), layout
(modal inside the viewport, primary control visible and not covered, no
horizontal overflow), landscape for action games, leave + cleanup, no
console errors. Plus TimLiner (solo), Party (join by code, start from the
party, win a game -> party points, second game) and a listener-leak check.

    python tests/e2e/games_regression.py [--shots DIR] [--games pong,uno,...] [--no-party] [--browser webkit]
"""

import json
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from kopfkicker_e2e import WS_SPY, login, start_server  # noqa: E402

RESULTS = []


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""), flush=True)


# records the newest game_state / game_over per page, and global listeners
RECORDER = """
(() => {
  window.__gs = null; window.__over = null;
  const Native = window.WebSocket;
  const origAdd = Native.prototype.addEventListener;
  window.WebSocket = class extends Native {
    constructor(...a) {
      super(...a);
      origAdd.call(this, 'message', (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'game_state' || m.type === 'game_started') window.__gs = m.state;
          if (m.type === 'game_over') window.__over = m;
        } catch (e) {}
      });
    }
  };
  const counts = {};
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
  const key = (t, type) => (t === window ? 'w:' : t === document ? 'd:' : t === window.visualViewport ? 'v:' : null) && ((t === window ? 'w:' : t === document ? 'd:' : 'v:') + type);
  EventTarget.prototype.addEventListener = function (type, fn, o) { const k = key(this, type); if (k) counts[k] = (counts[k] || 0) + 1; return add.call(this, type, fn, o); };
  EventTarget.prototype.removeEventListener = function (type, fn, o) { const k = key(this, type); if (k) counts[k] = (counts[k] || 0) - 1; return rem.call(this, type, fn, o); };
  window.__listeners = () => Object.values(counts).reduce((a, b) => a + b, 0);
  // running intervals + animation frames: a closed game must not keep a
  // loop alive (CPU/battery over an evening of games)
  const live = new Set(); const si = window.setInterval, ci = window.clearInterval;
  window.setInterval = function (...a) { const id = si.apply(this, a); live.add(id); return id; };
  window.clearInterval = function (id) { live.delete(id); return ci.call(this, id); };
  let frames = 0; const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) { frames++; return raf.call(this, cb); };
  window.__idle = () => new Promise((r) => { const f0 = frames; setTimeout(() => r({ intervals: live.size, rafPerSec: frames - f0 }), 1000); });
})();
"""

PHONE = dict(device_scale_factor=2, is_mobile=True, has_touch=True)


def client(browser, base, user, w, h, phone):
    kw = dict(viewport={"width": w, "height": h})
    if phone:
        kw.update(PHONE)
    ctx = browser.new_context(**kw)
    ctx.add_init_script(f"localStorage.setItem('instachat_token', {json.dumps(user['token'])});"
                        f"localStorage.setItem('instachat_user', {json.dumps(json.dumps(user['user']))});")
    ctx.add_init_script(WS_SPY)
    ctx.add_init_script(RECORDER)
    page = ctx.new_page()
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    page.on("console", lambda m: page.errors.append(m.text) if m.type == "error" else None)
    page.goto(base + "/")
    page.wait_for_function("() => typeof ws !== 'undefined' && ws && ws.readyState === 1 && currentChannelId", timeout=15000)
    page.user = user
    return ctx, page


def errors(page):
    # WebKit reports the (Chrome-Android-only) interactive-widget viewport
    # key as "not recognized and ignored" - a parser notice, not an app error
    return [e for e in page.errors if "favicon" not in e and "WebSocket connection" not in e
            and 'Viewport argument key "interactive-widget"' not in e]


def sent_actions(page, since=0):
    return page.evaluate("(n) => window.__sent.slice(n)", since)


def sent_count(page):
    return page.evaluate("() => window.__sent.length")


def wait(fn, timeout=8.0, step=0.1):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            v = fn()
        except Exception:
            v = None
        if v:
            return v
        time.sleep(step)
    return None


def modal_open(page):
    return page.evaluate("() => !document.getElementById('game-modal').hidden")


def visible_unobstructed(page, selector):
    """Element exists, has size, lies inside the viewport and is the topmost
    thing at its own centre (nothing covers it)."""
    return page.evaluate("""(sel) => {
        const el = [...document.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().width > 0);
        if (!el) return { ok: false, why: 'missing' };
        const r = el.getBoundingClientRect();
        const inside = r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
        const cx = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), cy = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
        const top = document.elementFromPoint(cx, cy);
        // the regular game-over message may legitimately sit on top
        const covered = !(top && (top === el || el.contains(top) || top.closest('#game-overlay-msg:not([hidden])')));
        return { ok: r.width > 0 && r.height > 0 && inside && !covered, why: { inside, covered, rect: [r.left, r.top, r.width, r.height], top: top && (top.id || top.className) } };
    }""", selector)


def no_h_overflow(page):
    return page.evaluate("() => document.documentElement.scrollWidth <= innerWidth + 1")


def modal_inside(page):
    return page.evaluate("""() => { const r = document.querySelector('#game-modal .game-modal').getBoundingClientRect();
        return r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && r.width > 200; }""")


def my_turn_page(pages, selector, text=("Du bist dran", "Wähle die Startfarbe")):
    for p in pages:
        t = p.evaluate("(s) => { const e = document.querySelector(s); return e ? e.textContent : ''; }", selector)
        if any(x in t for x in text):
            return p
    return None


# ---------------------------------------------------------------- primary interactions
def act_pong(A, phones):
    n = sent_count(A)
    A.keyboard.down("ArrowUp"); time.sleep(0.25); A.keyboard.up("ArrowUp")
    desk = any(m.get("direction") == "up" for m in sent_actions(A, n))
    B = phones[0]
    n2 = sent_count(B)
    B.evaluate("""() => { const c = document.getElementById('pong-canvas'); const r = c.getBoundingClientRect();
        const ev = (t, y) => c.dispatchEvent(new PointerEvent(t, { pointerId: 3, bubbles: true, clientX: r.left + r.width * 0.9, clientY: y, pointerType: 'touch' }));
        ev('pointerdown', r.top + r.height * 0.5); ev('pointermove', r.top + r.height * 0.1); }""")
    time.sleep(0.3)
    touch = any("direction" in m for m in sent_actions(B, n2))
    return desk and touch, f"keyboard {desk} touch {touch}"


def act_ttt(A, phones):
    pages = [A] + phones
    p = wait(lambda: my_turn_page(pages, "#ttt-turn-indicator"), 5)
    if not p:
        return False, "no player has the turn"
    p.click(".ttt-cell >> nth=4")
    board = wait(lambda: (A.evaluate("() => window.__gs && window.__gs.board") or [None] * 9)[4], 3)
    return bool(board), f"cell 4 -> {board}"


def act_lightcycles(A, phones):
    n = sent_count(A)
    for k in ("ArrowUp", "ArrowLeft"):
        A.keyboard.press(k)
    desk = any("direction" in m for m in sent_actions(A, n))
    B = phones[0]
    n2 = sent_count(B)
    B.evaluate("""() => { const b = document.querySelector('.touch-dpad-btn--up') || document.querySelector('.touch-dpad-btn');
        if (b) b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })); }""")
    time.sleep(0.2)
    pad = any("direction" in m for m in sent_actions(B, n2))
    return desk and pad, f"keys {desk} dpad {pad}"


def act_buzzer(A, phones):
    B = phones[0]
    armed = wait(lambda: B.evaluate("() => document.getElementById('buzzer-btn').classList.contains('armed')"), 12, 0.05)
    if not armed:
        return False, "never armed"
    n = sent_count(B)
    B.click("#buzzer-btn")
    over = wait(lambda: A.evaluate("() => window.__over"), 6)
    if over:
        return True, f"game over {over.get('reason')}"
    diag = B.evaluate("""() => { const b = document.getElementById('buzzer-btn'), gs = window.__gs || {};
        return { cls: b && b.className, disabled: b && b.disabled, session: myGameSessionId, ws: ws && ws.readyState,
                 phase: gs.phase, results: gs.results }; }""")
    return False, f"no game over; sent {sent_actions(B, n)[:3]} state {json.dumps(diag)[:500]}"


def act_battleship(A, phones):
    pages = [A] + phones
    p = wait(lambda: my_turn_page(pages, "#bs-turn-indicator"), 6)
    if not p:
        return False, "no turn"
    n = sent_count(p)
    p.click(".bs-cell.bs-target >> nth=12")
    time.sleep(0.4)
    shot = any("cell" in m for m in sent_actions(p, n))
    return shot, "shot sent"


def act_uno(A, phones):
    pages = [A] + phones
    p = wait(lambda: my_turn_page(pages, "#uno-turn-banner"), 6)
    if not p:
        return False, "no turn"
    if "Startfarbe" in p.inner_text("#uno-turn-banner"):
        p.click("#uno-color-picker button >> nth=0")
        time.sleep(0.4)
        p = wait(lambda: my_turn_page(pages, "#uno-turn-banner", ("Du bist dran",)), 5)
        if not p:
            return False, "no turn after start colour"
    n = sent_count(p)
    p.click("#uno-draw-pile")
    time.sleep(0.4)
    acts = [m.get("action") for m in sent_actions(p, n)]
    return "draw" in acts, str(acts)


def act_ludo(A, phones):
    pages = [A] + phones
    p = wait(lambda: my_turn_page(pages, "#ludo-turn-banner"), 6)
    if not p:
        return False, "no turn"
    p.click("#ludo-roll-btn")
    dice = wait(lambda: A.evaluate("() => window.__gs && window.__gs.dice"), 4)
    return bool(dice), f"dice {dice}"


def act_estimate(A, phones):
    got = []
    for p in [A] + phones:
        vis = wait(lambda: p.evaluate("() => { const i = document.querySelector('.est-input'); return i && i.offsetParent !== null; }"), 12)
        if not vis:
            continue
        n = sent_count(p)
        p.fill(".est-input", "42")
        p.click(".est-submit-btn")
        time.sleep(0.3)
        got.append(any(m.get("action") == "submit_guess" for m in sent_actions(p, n)))
    return len(got) == 1 + len(phones) and all(got), str(got)


def act_tankbattle(A, phones):
    n = sent_count(A)
    A.keyboard.down("w"); time.sleep(0.3); A.keyboard.up("w")
    A.keyboard.press("Space")
    acts = {m.get("action") for m in sent_actions(A, n)}
    B = phones[0]
    n2 = sent_count(B)
    B.evaluate("""() => { const b = document.querySelector('.arc-fire-btn');
        if (b) { b.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 9, bubbles: true, pointerType: 'touch' }));
                 b.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, bubbles: true, pointerType: 'touch' })); } }""")
    time.sleep(0.3)
    fire = any(m.get("action") == "shoot" for m in sent_actions(B, n2))
    return "move" in acts and fire, f"desktop {sorted(a for a in acts if a)} phone fire {fire}"


def act_dodgearena(A, phones):
    n = sent_count(A)
    A.keyboard.down("d"); time.sleep(0.3); A.keyboard.up("d")
    acts = {m.get("action") for m in sent_actions(A, n)}
    return "move" in acts, str(sorted(a for a in acts if a))


def act_whoami(A, phones):
    pages = [A] + phones
    asker = wait(lambda: next((p for p in pages if p.evaluate("() => !!document.querySelector('.wai-question-input')")), None), 10)
    if not asker:
        return False, "no question input"
    asker.fill(".wai-question-input", "Bin ich eine echte Person?")
    asker.click(".wai-ask-btn")
    voter = wait(lambda: next((p for p in pages if p is not asker and p.evaluate("() => !!document.querySelector('.wai-vote-btn:not([disabled])')")), None), 8)
    if not voter:
        return False, "nobody could vote"
    n = sent_count(voter)
    voter.click(".wai-vote-btn--yes")
    time.sleep(0.3)
    voted = any(m.get("action") == "vote" for m in sent_actions(voter, n))
    return voted, "asked + voted"


def act_cards(A, phones, selectors, action_prefix):
    got = 0
    for p in [A] + phones:
        sel = wait(lambda: next((s for s in selectors if p.evaluate("(s) => { const e = document.querySelector(s); return !!(e && e.offsetParent !== null && !e.disabled); }", s)), None), 12)
        if not sel:
            continue
        n = sent_count(p)
        p.click(f"{sel} >> nth=0")
        time.sleep(0.3)
        if any(str(m.get("action", "")).startswith(action_prefix) for m in sent_actions(p, n)):
            got += 1
    return got >= 2, f"{got} players answered"


def act_knowme(A, phones):
    return act_cards(A, phones, [".km-choice-card", ".km-scale-btn", ".km-vote-card"], "submit_")


def act_majority(A, phones):
    return act_cards(A, phones, [".mg-answer-card"], "submit_vote")


def act_kritzelmeister(A, phones):
    pages = [A] + phones
    drawer = wait(lambda: next((p for p in pages if p.evaluate("() => { const e = document.querySelector('.dg-word-card'); return !!(e && e.offsetParent !== null); }")), None), 12)
    if not drawer:
        return False, "no word choice"
    drawer.click(".dg-word-card >> nth=0")
    guesser = wait(lambda: next((p for p in pages if p is not drawer and p.evaluate("() => { const i = document.querySelector('.dg-guess-input'); return !!(i && i.offsetParent !== null); }")), None), 10)
    if not guesser:
        return False, "no guess input"
    n = sent_count(guesser)
    guesser.fill(".dg-guess-input", "Banane")
    guesser.click(".dg-guess-submit")
    time.sleep(0.4)
    return any(m.get("action") == "guess" for m in sent_actions(guesser, n)), "word chosen + guessed"


def act_kopfkicker(A, phones):
    return all(p.evaluate("() => !!document.querySelector('.kk-lobby:not([hidden])')") for p in [A] + phones), "selfie lobby on all"


GAMES = [
    # key, players, options, control selector (primary), act, action game?
    ("pong", 2, None, "#pong-canvas", act_pong, True),
    ("tictactoe", 2, None, ".ttt-cell", act_ttt, False),
    ("lightcycles", 2, None, "#lc-canvas", act_lightcycles, True),
    ("buzzer", 2, None, "#buzzer-btn", act_buzzer, False),
    ("battleship", 2, None, ".bs-cell", act_battleship, False),
    ("uno", 3, None, "#uno-draw-pile", act_uno, False),
    ("ludo", 3, None, "#ludo-roll-btn", act_ludo, False),
    ("estimate", 3, {"rounds": 5}, ".est-root", act_estimate, False),
    ("tankbattle", 2, None, "canvas", act_tankbattle, True),
    ("dodgearena", 2, None, "canvas", act_dodgearena, True),
    ("whoami", 2, {"difficulty": "mixed", "maxRounds": 15, "categories": ["music", "sport"], "customTerms": []}, ".wai-root", act_whoami, False),
    ("knowme", 3, None, ".km-root", act_knowme, False),
    ("majority", 3, None, ".mg-root", act_majority, False),
    ("kritzelmeister", 3, None, ".dg-root", act_kritzelmeister, False),
    ("kopfkicker", 2, None, ".kk-lobby", act_kopfkicker, True),
]


def open_games_drawer(p):
    if p.evaluate("() => innerWidth < 900 || innerHeight < 500"):
        if not p.evaluate("() => document.getElementById('games-panel').classList.contains('open')"):
            p.click("#mobile-games-btn")
            time.sleep(0.35)


def close_games_drawer(p):
    if p.evaluate("() => document.getElementById('games-panel').classList.contains('open')"):
        p.click("#games-panel-close-btn")
        time.sleep(0.35)


def run_game(key, nplayers, options, control, act, action_game, A, phones_all, shots):
    phones = phones_all[: nplayers - 1]
    pages = [A] + phones
    for p in pages:
        p.evaluate("() => { window.__gs = null; window.__over = null; }")
        p.errors.clear()
    label = f"[{key}]"

    # --- host creates (UI path for estimate: quick-start card + options modal) ---
    if key == "estimate":
        A.evaluate("() => renderGamesPanel()")
        A.click("#games-panel-categories .gp-card:has-text('Schätzmeister') .gp-card-play")
        A.wait_for_selector(".modal-overlay [data-role='confirm']", timeout=4000)
        A.click(".modal-overlay [data-role='confirm']")
    else:
        A.evaluate("([t, o]) => ws.send(JSON.stringify(Object.assign({ type: 'game_create', game_type: t }, o ? { options: o } : {})))", [key, options])
    sid = wait(lambda: A.evaluate("() => myGameSessionId"), 5)
    if not sid:
        ok(f"{label} host created a lobby", False)
        return

    # --- phones join from the games drawer ---
    for p in phones:
        wait(lambda: p.evaluate("(sid) => gameSessions.some((s) => s.id === sid)", sid), 5)
        open_games_drawer(p)
        p.evaluate("() => renderGamesPanel()")
        try:
            p.click("#games-panel-lobby-list .game-lobby-item button:has-text('Beitreten')", timeout=4000)
        except Exception as e:
            ok(f"{label} {p.user['user']['name']} joins from the games drawer", False, str(e)[:120])
            return
        time.sleep(0.6)
        if modal_open(p):
            # the game started right away (full lobby of an own-lobby game):
            # the app itself must have closed the games sheet underneath
            ok(f"{label} game opening closes the games drawer", not p.evaluate("() => document.getElementById('games-panel').classList.contains('open')"))
        else:
            close_games_drawer(p)
    joined = wait(lambda: A.evaluate("(sid) => (gameSessions.find((s) => s.id === sid) || {}).player_count", sid) == nplayers, 5)
    ok(f"{label} {nplayers} players in the lobby", joined)

    if key == "kopfkicker":
        started = wait(lambda: all(modal_open(p) for p in pages), 6)
        ok(f"{label} own lobby (selfie/ready) opens", started)
    else:
        time.sleep(0.8)
        ok(f"{label} no auto-start when the lobby is full", not any(modal_open(p) for p in pages))
        A.evaluate("() => renderGamesPanel()")
        A.click("#games-panel-lobby-list button:has-text('Jetzt starten')")
        started = wait(lambda: all(modal_open(p) for p in pages), 8)
        ok(f"{label} host starts manually -> game on every screen", started)
    if not started:
        return
    time.sleep(0.8)

    # --- layout on every screen ---
    for p in pages:
        who = p.user["user"]["name"]
        ok(f"{label} {who}: game dialog inside the viewport, no horizontal overflow", modal_inside(p) and no_h_overflow(p))
    ctl = visible_unobstructed(pages[1] if control not in (".est-root", ".wai-root", ".km-root", ".mg-root", ".dg-root", ".kk-lobby") else pages[1], control)
    ok(f"{label} phone: primary control visible and not covered", ctl["ok"], json.dumps(ctl["why"]))
    if shots:
        A.screenshot(path=str(shots / f"{key}_desktop.png"))
        for i, p in enumerate(phones):
            p.screenshot(path=str(shots / f"{key}_phone{i + 1}.png"))

    # --- primary interaction through the UI ---
    try:
        res, detail = act(A, phones)
    except Exception as e:
        res, detail = False, f"exception {str(e)[:160]}"
    ok(f"{label} primary interaction", res, detail)

    # --- game chat on the phone (header button, never floating) ---
    B = phones[0]
    if not B.evaluate("() => !!window.__over"):
        in_header = B.evaluate("() => !!document.querySelector('#game-modal .modal-head #game-chat-toggle') && getComputedStyle(document.getElementById('game-chat-toggle')).display !== 'none'")
        ok(f"{label} phone: chat button lives in the game header", in_header)
        B.click("#game-chat-toggle")
        opened = wait(lambda: B.evaluate("() => document.getElementById('game-chat-panel').classList.contains('open')"), 2)
        text = f"chat aus {key} {int(time.time() * 1000) % 100000}"
        n = sent_count(B)
        if opened:
            B.fill("#game-chat-input", text)
            B.press("#game-chat-input", "Enter")
        arrived = wait(lambda: text in A.inner_text("#messages") and text in A.inner_text("#game-chat-messages"), 4)
        if opened and not arrived:
            diag = B.evaluate("""() => ({ input: document.getElementById('game-chat-input').value, ws: ws && ws.readyState,
                conn: connState, online: navigator.onLine, toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent) })""")
            late = wait(lambda: text in A.inner_text("#messages"), 6)
            print(f"  DIAG [{key}] game chat: sent {sent_actions(B, n)[:3]} B {json.dumps(diag)} arrived later on A: {bool(late)}"
                  f" | A main {text in A.inner_text('#messages')} A game {text in A.inner_text('#game-chat-messages')}", flush=True)
        B.click("#game-chat-close-btn")
        closed = wait(lambda: B.evaluate("() => !document.getElementById('game-chat-panel').classList.contains('open') && !document.body.classList.contains('scroll-locked')"), 2)
        ok(f"{label} game chat: open, send, arrives in chat + game chat, closes cleanly", opened and arrived and closed, f"open {opened} arrived {arrived} closed {closed}")

    # --- landscape for action games ---
    if action_game and key != "kopfkicker":
        for (w, h) in ((844, 390), (915, 412)):
            B.set_viewport_size({"width": w, "height": h})
            B.evaluate("() => window.dispatchEvent(new Event('orientationchange'))")
            time.sleep(0.5)
            c = visible_unobstructed(B, control)
            ok(f"{label} landscape {w}x{h}: arena visible, dialog fits", c["ok"] and modal_inside(B) and no_h_overflow(B), json.dumps(c["why"]))
            if shots:
                B.screenshot(path=str(shots / f"{key}_landscape_{w}.png"))
        B.set_viewport_size({"width": 390, "height": 844})
        B.evaluate("() => window.dispatchEvent(new Event('orientationchange'))")
        time.sleep(0.4)
        ok(f"{label} back to portrait: still one set of controls", B.evaluate("() => document.querySelectorAll('#game-stage canvas').length") >= 1)

    # --- leave + cleanup ---
    for p in [B] + [p for p in pages if p is not B]:
        if modal_open(p):
            p.click("#game-close-btn")
            wait(lambda: not modal_open(p), 3)
    gone = wait(lambda: not A.evaluate("(sid) => gameSessions.some((s) => s.id === sid && s.status !== 'over')", sid), 5)
    ok(f"{label} everyone left: dialogs closed, no open session left", gone and not any(modal_open(p) for p in pages))
    clean = all(p.evaluate("() => !document.body.classList.contains('scroll-locked') && document.querySelectorAll('.modal-overlay:not([hidden])').length === 0") for p in pages)
    ok(f"{label} no leftover overlay / scroll lock", clean)
    errs = [f"{p.user['user']['name']}: {e}" for p in pages for e in errors(p)]
    ok(f"{label} no console errors", not errs, "; ".join(errs[:3]))


def run_timliner(A, B, shots):
    for p, name in ((A, "desktop"), (B, "phone")):
        p.errors.clear()
        p.evaluate("() => launchGameByType('timliner')")
        opened = wait(lambda: modal_open(p) and p.evaluate("() => !!document.querySelector('#game-stage canvas')"), 5)
        ok(f"[timliner] {name}: opens with canvas", opened)
        if opened:
            p.evaluate("""() => { const c = document.querySelector('#game-stage canvas'); const r = c.getBoundingClientRect();
                const ev = (t, x, y) => c.dispatchEvent(new PointerEvent(t, { pointerId: 1, bubbles: true, clientX: r.left + x, clientY: r.top + y, pointerType: 'touch', isPrimary: true }));
                ev('pointerdown', 40, 60); ev('pointermove', 120, 90); ev('pointermove', 200, 120); ev('pointerup', 200, 120); }""")
            time.sleep(0.3)
            ok(f"[timliner] {name}: dialog inside viewport", modal_inside(p) and no_h_overflow(p))
            if shots:
                p.screenshot(path=str(shots / f"timliner_{name}.png"))
            p.click("#game-close-btn")
            wait(lambda: not modal_open(p), 3)
        ok(f"[timliner] {name}: no console errors", not errors(p), "; ".join(errors(p)[:2]))


def run_party(A, B, shots):
    for p in (A, B):
        p.evaluate("() => { window.__gs = null; window.__over = null; }")
    # A starts a party from the games panel
    A.evaluate("() => renderGamesPanel()")
    A.click("#gp-party-start-btn")
    code = wait(lambda: A.evaluate("() => currentParty && currentParty.code"), 5)
    ok("[party] host creates a party with a code", bool(code), str(code))
    # B opens the party overlay from the games drawer and joins by code
    open_games_drawer(B)
    B.evaluate("() => renderGamesPanel()")
    B.click("#gp-party-start-btn")
    # clicking "start" on B while not in a party creates one - leave it and join A's instead
    wait(lambda: B.evaluate("() => !!currentParty"), 3)
    B.evaluate("() => leaveParty()")
    wait(lambda: B.evaluate("() => !currentParty"), 3)
    B.evaluate("() => openPartyOverlay()")
    B.fill("#party-join-code", code)
    B.click("#party-join-form button[type=submit]")
    members = wait(lambda: A.evaluate("() => currentParty && currentParty.members.length") == 2, 5)
    ok("[party] second player joins by code", members)
    if shots:
        A.screenshot(path=str(shots / "party_host.png"))
        B.screenshot(path=str(shots / "party_phone.png"))
    # start Tic-Tac-Toe from the party
    A.click(".party-game-btn:has-text('Tic-Tac-Toe')")
    banner = wait(lambda: B.evaluate("() => !!document.getElementById('party-join-game-btn')"), 5)
    ok("[party] members get a join banner", banner)
    B.click("#party-join-game-btn")
    start_btn = wait(lambda: A.evaluate("() => { const b = document.getElementById('party-pending-start-btn'); return b && !b.disabled; }"), 5)
    ok("[party] host sees the pending game and starts it manually", start_btn)
    A.click("#party-pending-start-btn")
    started = wait(lambda: modal_open(A) and modal_open(B), 6)
    ok("[party] game starts for both", started)
    # play to a win: whoever starts takes 0,1,2
    first = wait(lambda: my_turn_page([A, B], "#ttt-turn-indicator"), 5)
    second = B if first is A else A
    moves = {id(first): [0, 1, 2], id(second): [3, 4]}
    for _ in range(6):
        if A.evaluate("() => !!window.__over"):
            break
        p = wait(lambda: my_turn_page([A, B], "#ttt-turn-indicator"), 4)
        if not p or not moves[id(p)]:
            break
        p.click(f".ttt-cell >> nth={moves[id(p)].pop(0)}")
        time.sleep(0.35)
    over = wait(lambda: A.evaluate("() => window.__over"), 4)
    ok("[party] game played to a result", bool(over), str(over and over.get("reason")))
    points = wait(lambda: A.evaluate("() => currentParty && Object.values(currentParty.scores || {}).some((v) => v > 0)"), 5)
    ok("[party] result counts as party points", points)
    for p in (A, B):
        if modal_open(p):
            p.click("#game-close-btn")
    A.evaluate("() => openPartyOverlay()")
    back = wait(lambda: A.evaluate("() => !document.getElementById('party-overlay').hidden && !!document.querySelector('.party-score-list')"), 4)
    ok("[party] back in the party: score list shown", back)
    # second game from the party
    A.click(".party-game-btn:has-text('Buzzer')")
    wait(lambda: B.evaluate("() => !!document.getElementById('party-join-game-btn')"), 5)
    B.evaluate("() => openPartyOverlay()")
    B.click("#party-join-game-btn")
    wait(lambda: A.evaluate("() => { const b = document.getElementById('party-pending-start-btn'); return b && !b.disabled; }"), 5)
    A.click("#party-pending-start-btn")
    ok("[party] second game from the same party starts", wait(lambda: modal_open(A) and modal_open(B), 6))
    for p in (A, B):
        if modal_open(p):
            p.click("#game-close-btn")
    A.evaluate("() => leaveParty()")
    B.evaluate("() => leaveParty()")
    for p in (A, B):
        p.evaluate("() => closePartyOverlay()")
    errs = errors(A) + errors(B)
    ok("[party] no console errors", not errs, "; ".join(errs[:3]))


def main():
    shots = None
    if "--shots" in sys.argv:
        shots = Path(sys.argv[sys.argv.index("--shots") + 1])
        shots.mkdir(parents=True, exist_ok=True)
    only = None
    if "--games" in sys.argv:
        only = set(sys.argv[sys.argv.index("--games") + 1].split(","))
    proc, base, tmp = start_server()
    try:
        users = [login(base, n) for n in ("Ana", "Ben", "Cem")]
        with sync_playwright() as pw:
            engine = sys.argv[sys.argv.index("--browser") + 1] if "--browser" in sys.argv else "chromium"
            browser = getattr(pw, engine).launch()
            ca, A = client(browser, base, users[0], 1440, 900, False)
            cb, B = client(browser, base, users[1], 390, 844, True)
            cc, C = client(browser, base, users[2], 412, 915, True)
            listeners0 = A.evaluate("() => window.__listeners()")
            idle0 = {p.user["user"]["name"]: p.evaluate("() => window.__idle()") for p in (A, B, C)}
            for (key, n, opts, control, act, action_game) in GAMES:
                if only and key not in only:
                    continue
                try:
                    run_game(key, n, opts, control, act, action_game, A, [B, C], shots)
                except Exception as e:
                    ok(f"[{key}] run", False, f"exception {str(e)[:200]}")
                    for p in (A, B, C):
                        try:
                            if modal_open(p):
                                p.click("#game-close-btn")
                        except Exception:
                            pass
                time.sleep(0.3)
                if "-v" in sys.argv:
                    print(f"  idle after {key}: " + json.dumps({p.user["user"]["name"]: p.evaluate("() => window.__idle()") for p in (A, B, C)}), flush=True)
            if not only or "timliner" in only:
                run_timliner(A, B, shots)
            listeners1 = A.evaluate("() => window.__listeners()")
            ok("host: window/document listeners don't pile up over all games", listeners1 - listeners0 <= 6, f"{listeners0} -> {listeners1}")
            idle1 = {p.user["user"]["name"]: p.evaluate("() => window.__idle()") for p in (A, B, C)}
            ok("every page idle after all games: no animation loop or interval left running",
               all(idle1[k]["rafPerSec"] <= 2 and idle1[k]["intervals"] <= idle0[k]["intervals"] for k in idle1), f"{idle0} -> {idle1}")
            if "--no-party" not in sys.argv and (not only or "party" in only):
                run_party(A, B, shots)
            browser.close()
    finally:
        proc.terminate()
    fails = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(fails)}/{len(RESULTS)} checks passed")
    for f in fails:
        print("  FAILED:", f[0], "|", f[2][:200])
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
