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


def phone_sees(p, label, what, selectors):
    res = {sel: visible_unobstructed(p, sel) for sel in selectors}
    ok(f"{label} phone: {what} visible, nothing covers it", all(r["ok"] for r in res.values()),
       json.dumps({k: v["why"] for k, v in res.items() if not v["ok"]}))


STICK_JS = """([zone, id, dx, dy]) => { const z = document.querySelector(zone); const r = z.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const ev = (t, x, y) => z.dispatchEvent(new PointerEvent(t, { pointerId: id, bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: 'touch' }));
    ev('pointerdown', cx, cy); ev('pointermove', cx + dx / 2, cy + dy / 2); ev('pointermove', cx + dx, cy + dy); }"""


def keyboard_check(p, label, inp, btn):
    """Phone keyboard up (the viewport shrinks to ~480px): the focused input
    and its submit button stay visible and uncovered."""
    size = p.viewport_size
    p.focus(inp)
    p.set_viewport_size({"width": size["width"], "height": 480})
    time.sleep(0.5)
    a, b = visible_unobstructed(p, inp), visible_unobstructed(p, btn)
    p.set_viewport_size(size)
    time.sleep(0.35)
    ok(f"{label} phone keyboard open: input + submit stay visible", a["ok"] and b["ok"], json.dumps({"input": a["why"], "button": b["why"]}))


END_UI_JS = """() => {
    const e = [...document.querySelectorAll('#game-overlay-msg:not([hidden]), .est-endscreen, .wai-endscreen, .km-endscreen, .mg-endscreen, .dg-endscreen')]
        .find((x) => x.getBoundingClientRect().width > 0);
    if (!e) return { ok: false, why: 'no end screen' };
    const r = e.getBoundingClientRect();
    const text = e.innerText.trim().replace(/\\s+/g, ' ').slice(0, 90);
    const inside = r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.top < innerHeight - 40;
    const c = document.getElementById('game-close-btn').getBoundingClientRect();
    const t = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
    const closable = !!(t && t.closest('#game-close-btn'));
    const title = e.querySelector('#game-overlay-text, [class*=endscreen-title], .wai-endscreen-title, p') || e;
    const tr = title.getBoundingClientRect();
    const onTop = [0.15, 0.5, 0.85].every((f) => { const h = document.elementFromPoint(tr.left + tr.width * f, tr.top + tr.height / 2); return !!(h && e.contains(h)); });
    return { ok: inside && text.length > 3 && closable && onTop, text, rect: [r.left, r.top, r.width, r.height].map(Math.round), closable, onTop };
}"""

CONTROLS_JS = """() => ({ canvases: document.querySelectorAll('#game-stage canvas').length,
    controls: document.querySelectorAll('#game-stage .touch-dpad-btn, #game-stage .arc-stick-zone, #game-stage .arc-fire-btn').length,
    sid: myGameSessionId, open: !document.getElementById('game-modal').hidden })"""


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
    # 180 turn: pressing the opposite direction must not reverse the cycle
    uid = str(B.user["user"]["id"])
    time.sleep(0.4)
    d0 = B.evaluate("(u) => { const s = window.__gs; const p = s && s.players && s.players[u]; return p && p.alive ? p.dir : null; }", uid)
    if d0:
        opp = {"up": "down", "down": "up", "left": "right", "right": "left"}[d0]
        B.evaluate("(d) => { const b = document.querySelector('.touch-dpad-btn--' + d); if (b) b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })); }", opp)
        time.sleep(0.5)
        d1 = B.evaluate("(u) => { const s = window.__gs; const p = s && s.players && s.players[u]; return p ? p.dir : null; }", uid)
        ok("[lightcycles] no 180: the opposite direction is ignored", d1 != opp, f"{d0} -> pressed {opp} -> {d1}")
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
    phone_sees(phones[0], "[battleship]", "target board + own board", ["#bs-track-block .bs-grid", "#bs-own-grid"])
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
    phone_sees(phones[0], "[uno]", "hand + draw pile", ["#uno-hand", "#uno-draw-pile"])
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
    phone_sees(phones[0], "[ludo]", "board + dice", [".ludo-board", "#ludo-roll-btn"])
    p.click("#ludo-roll-btn")
    dice = wait(lambda: A.evaluate("() => window.__gs && window.__gs.dice"), 4)
    return bool(dice), f"dice {dice}"


def act_estimate(A, phones):
    if wait(lambda: phones[0].evaluate("() => { const i = document.querySelector('.est-input'); return !!(i && i.offsetParent !== null); }"), 12):
        phone_sees(phones[0], "[estimate]", "question + timer + input + submit", [".est-question", ".est-timer", ".est-input", ".est-submit-btn"])
    got = []
    for p in [A] + phones:
        vis = wait(lambda: p.evaluate("() => { const i = document.querySelector('.est-input'); return i && i.offsetParent !== null; }"), 12)
        if not vis:
            continue
        if p.viewport_size["width"] < 900 and not any(r[0].startswith("[estimate] phone keyboard") for r in RESULTS):
            keyboard_check(p, "[estimate]", ".est-input", ".est-submit-btn")
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
    phone_sees(B, "[tankbattle]", "move stick + aim stick + fire", ['[data-role="movezone"]', '[data-role="aimzone"]', ".arc-fire-btn"])
    n2 = sent_count(B)
    # multitouch: left thumb drives (pointer 5) while the right thumb fires (pointer 9)
    B.evaluate(STICK_JS, ['[data-role="movezone"]', 5, 0, -34])
    time.sleep(0.15)
    B.evaluate("""() => { const b = document.querySelector('.arc-fire-btn');
        if (b) { b.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 9, bubbles: true, pointerType: 'touch' }));
                 b.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, bubbles: true, pointerType: 'touch' })); } }""")
    time.sleep(0.3)
    sent = sent_actions(B, n2)
    fire = any(m.get("action") == "shoot" for m in sent)
    drive = any(m.get("action") == "move" and m.get("forward") for m in sent)
    B.evaluate("""() => document.querySelector('[data-role="movezone"]').dispatchEvent(new PointerEvent('pointerup', { pointerId: 5, bubbles: true, pointerType: 'touch' }))""")
    ok("[tankbattle] phone multitouch: drive with one thumb while firing with the other", fire and drive, f"fire {fire} drive {drive}")
    return "move" in acts and fire, f"desktop {sorted(a for a in acts if a)} phone fire {fire}"


def act_dodgearena(A, phones):
    n = sent_count(A)
    A.keyboard.down("d"); time.sleep(0.3); A.keyboard.up("d")
    acts = {m.get("action") for m in sent_actions(A, n)}
    B = phones[0]
    phone_sees(B, "[dodgearena]", "joystick", ['[data-role="movezone"]'])
    n2 = sent_count(B)
    B.evaluate(STICK_JS, ['[data-role="movezone"]', 6, 30, 20])
    time.sleep(0.3)
    stick = any(m.get("action") == "move" and (m.get("dx") or m.get("dy")) for m in sent_actions(B, n2))
    B.evaluate("""() => document.querySelector('[data-role="movezone"]').dispatchEvent(new PointerEvent('pointerup', { pointerId: 6, bubbles: true, pointerType: 'touch' }))""")
    ok("[dodgearena] phone joystick moves the player", stick)
    return "move" in acts, str(sorted(a for a in acts if a))


def act_whoami(A, phones):
    pages = [A] + phones
    asker = wait(lambda: next((p for p in pages if p.evaluate("() => !!document.querySelector('.wai-question-input')")), None), 10)
    if not asker:
        return False, "no question input"
    if asker is not A:
        keyboard_check(asker, "[whoami]", ".wai-question-input", ".wai-ask-btn")
    asker.fill(".wai-question-input", "Bin ich eine echte Person?")
    asker.click(".wai-ask-btn")
    voter = wait(lambda: next((p for p in pages if p is not asker and p.evaluate("() => !!document.querySelector('.wai-vote-btn:not([disabled])')")), None), 8)
    if not voter:
        return False, "nobody could vote"
    n = sent_count(voter)
    voter.click(".wai-vote-btn--no")   # "no" ends the turn (a "yes" lets the asker go on)
    time.sleep(0.3)
    voted = any(m.get("action") == "vote" for m in sent_actions(voter, n))
    # keyboard on the phone: its own question when it is its turn
    if asker is A:
        phone_asker = wait(lambda: next((p for p in phones if p.evaluate(
            "() => { const i = document.querySelector('.wai-question-input'); return !!(i && i.offsetParent !== null); }")), None), 12)
        if phone_asker:
            keyboard_check(phone_asker, "[whoami]", ".wai-question-input", ".wai-ask-btn")
        else:
            ok("[whoami] phone keyboard open: input + submit stay visible", False, "the phone never got the question input")
    return voted, "asked + voted"


def act_cards(A, phones, selectors, action_prefix):
    # passes over all players: whoever can answer right now answers (in
    # "Kennst du mich?" the target answers first, the guessers only after)
    pages, answered, t0 = [A] + phones, set(), time.time()
    while len(answered) < 2 and time.time() - t0 < 25:
        for p in pages:
            if id(p) in answered:
                continue
            sel = next((s for s in selectors if p.evaluate("(s) => { const e = document.querySelector(s); return !!(e && e.offsetParent !== null && !e.disabled); }", s)), None)
            if not sel:
                continue
            n = sent_count(p)
            p.click(f"{sel} >> nth=0")
            time.sleep(0.3)
            if any(str(m.get("action", "")).startswith(action_prefix) for m in sent_actions(p, n)):
                answered.add(id(p))
        time.sleep(0.2)
    return len(answered) >= 2, f"{len(answered)} players answered"


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
    draw_phone = drawer if drawer is not A else None
    if draw_phone and wait(lambda: draw_phone.evaluate("() => { const t = document.querySelector('.dg-toolbar'); return !!(t && t.offsetParent !== null); }"), 5):
        phone_sees(draw_phone, "[kritzelmeister]", "drawing canvas + toolbar", [".dg-canvas", ".dg-toolbar"])
    guesser = wait(lambda: next((p for p in pages if p is not drawer and p.evaluate("() => { const i = document.querySelector('.dg-guess-input'); return !!(i && i.offsetParent !== null); }")), None), 10)
    if not guesser:
        return False, "no guess input"
    phone_guesser = guesser if guesser is not A else next((p for p in phones if p is not drawer), None)
    if phone_guesser:
        keyboard_check(phone_guesser, "[kritzelmeister]", ".dg-guess-input", ".dg-guess-submit")
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
    ctl = visible_unobstructed(pages[1], control)
    ok(f"{label} phone 390x844: primary control visible and not covered", ctl["ok"], json.dumps(ctl["why"]))
    if len(phones) >= 2:
        c412, fits = visible_unobstructed(phones[1], control), True        # Cem is 412x915
    else:                                                                  # 2-player game: the same phone at 412x915
        phones[0].set_viewport_size({"width": 412, "height": 915})
        time.sleep(0.4)
        c412, fits = visible_unobstructed(phones[0], control), modal_inside(phones[0]) and no_h_overflow(phones[0])
        phones[0].set_viewport_size({"width": 390, "height": 844})
        time.sleep(0.3)
    ok(f"{label} phone 412x915: dialog fits, primary control visible", c412["ok"] and fits, json.dumps(c412["why"]))
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
        closed = wait(lambda: B.evaluate("() => { const p = document.getElementById('game-chat-panel'); return !p.classList.contains('open') && getComputedStyle(p).visibility === 'hidden' && !document.body.classList.contains('scroll-locked'); }"), 2)
        ok(f"{label} game chat: open, send, arrives in chat + game chat, closes cleanly", opened and arrived and closed, f"open {opened} arrived {arrived} closed {closed}")
        head = B.evaluate("""() => ({ scroll: document.querySelector('#game-modal .game-modal').scrollTop,
            top: Math.round(document.querySelector('#game-modal .modal-head').getBoundingClientRect().top) })""")
        ok(f"{label} game chat used: the dialog header (title, close, chat) is still in view", head["scroll"] == 0 and head["top"] >= 0, json.dumps(head))

    # --- landscape for action games ---
    if action_game and key != "kopfkicker":
        before = B.evaluate(CONTROLS_JS)
        drift = []
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
            time.sleep(0.45)
            now = B.evaluate(CONTROLS_JS)
            if now != before:
                drift.append(now)
        ok(f"{label} portrait -> landscape -> portrait (2x): one set of controls, same running session",
           not drift and before["open"] and before["canvases"] >= 1, f"{before} -> {drift}")

    # --- result / end: everyone else leaves -> the phone gets a clear end screen ---
    if key != "kopfkicker":   # KopfKicker: grace period + own end screen, covered by kopfkicker_e2e
        for p in pages:
            if p is not B and modal_open(p):
                p.click("#game-close-btn")
                wait(lambda: not modal_open(p), 3)
        over = wait(lambda: B.evaluate("() => window.__over"), 6)
        end = wait(lambda: (lambda r: r if r["ok"] else None)(B.evaluate(END_UI_JS)), 3) or B.evaluate(END_UI_JS)
        ok(f"{label} phone: result screen ({(over or {}).get('reason')}), inside the viewport, closable", bool(over) and end["ok"], json.dumps(end))
        if shots:
            B.screenshot(path=str(shots / f"{key}_result_phone.png"))

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


def timliner_gestures(p):
    """Real touch points (CDP) on the TimLiner canvas: two fingers moving =
    pan, spreading = pinch zoom; then a real one-finger stroke followed by a
    second finger. Returns camera snapshots + line counts."""
    # dismiss the first-run hint card like a player would ("Los geht's")
    if p.evaluate("() => { const b = document.querySelector('.tl-onboard-card [data-role=dismiss]'); return !!(b && b.offsetParent !== null); }"):
        p.click(".tl-onboard-card [data-role=dismiss]")
        time.sleep(0.2)
    cdp = p.context.new_cdp_session(p)
    left, top, w, h = p.evaluate("() => { const c = document.querySelector('#game-stage canvas').getBoundingClientRect(); return [c.left, c.top, c.width, c.height]; }")
    at = lambda fx, fy: (left + w * fx, top + h * fy)  # noqa: E731  (fractions of the canvas: its middle band is free of tool bars)
    st = lambda: p.evaluate("() => timLinerInstance._debugState()")  # noqa: E731
    touch = lambda t, pts: cdp.send("Input.dispatchTouchEvent", {"type": t, "touchPoints": [{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(pts)]})  # noqa: E731
    end = lambda: cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})  # noqa: E731
    probe = [at(0.3, 0.4), at(0.7, 0.4), at(0.25, 0.62), at(0.72, 0.5)]
    on_canvas = p.evaluate("(pts) => pts.every(([x, y]) => (document.elementFromPoint(x, y) || {}).tagName === 'CANVAS')", probe)
    s0 = st()
    touch("touchStart", [at(0.3, 0.4), at(0.6, 0.4)])
    for i in range(1, 7):
        touch("touchMove", [at(0.3 + i * 0.02, 0.4 + i * 0.01), at(0.6 + i * 0.02, 0.4 + i * 0.01)])
        time.sleep(0.02)
    s1 = st()
    for i in range(1, 7):
        touch("touchMove", [at(0.42 - i * 0.02, 0.46), at(0.72 + i * 0.0, 0.46 - i * 0.02)])
        time.sleep(0.02)
    s2 = st()
    end()
    time.sleep(0.2)
    after_pan = st()["lineCount"]
    # a real stroke first, then a second finger lands: the stroke is kept,
    # the following two-finger pan adds nothing
    touch("touchStart", [at(0.25, 0.62)])
    for i in range(1, 9):
        touch("touchMove", [at(0.25 + i * 0.04, 0.62 + i * 0.005)])
        time.sleep(0.06)
    drawn = st()["lineCount"]
    touch("touchStart", [at(0.57, 0.66), at(0.72, 0.5)])
    for i in range(1, 5):
        touch("touchMove", [at(0.57 - i * 0.02, 0.66), at(0.72 - i * 0.02, 0.5)])
        time.sleep(0.02)
    end()
    time.sleep(0.2)
    cdp.detach()
    return {"lines": [s0["lineCount"], after_pan], "stroke": [after_pan, drawn, st()["lineCount"]],
            "cam": [s0["camera"], s1["camera"], s2["camera"]], "on_canvas": on_canvas}


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
            if name == "phone" and p.context.browser.browser_type.name == "chromium":
                g = timliner_gestures(p)
                panned = g["cam"][1]["x"] != g["cam"][0]["x"] or g["cam"][1]["y"] != g["cam"][0]["y"]
                zoomed = g["cam"][2]["zoom"] != g["cam"][1]["zoom"]
                ok("[timliner] phone: 1 finger draws, 2 fingers pan, pinch zooms (and draw nothing)",
                   g["lines"][0] >= 1 and panned and zoomed and g["lines"][1] == g["lines"][0], json.dumps(g))
                ok("[timliner] phone: a second finger after a real stroke keeps the stroke, adds nothing",
                   g["stroke"][1] > g["stroke"][0] and g["stroke"][2] == g["stroke"][1], json.dumps(g))
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
