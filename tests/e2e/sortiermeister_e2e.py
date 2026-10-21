"""Sortiermeister - short end-to-end check (real server from a temp copy, real browser clients).

A desktop host (mouse drag) and a phone (touch, arrow buttons) play a 5-round match; a solo game checks the
1-player start. Per round: five numbered cards, direction + category shown, no value / true order in the state
before the reveal, reordering by drag and by arrows, EINLOGGEN, reveal (cards land in the true order, verdict
colours), the points the page shows == points computed here from the same order, next round; end screen with
the totals, "nochmal spielen". Console errors and the start page are checked too.

    python tests/e2e/sortiermeister_e2e.py [--shots DIR] [--browser webkit]
"""

import json
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
import qa_safety  # noqa: E402,F401
from games_regression import client, errors, wait, modal_open  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ARG = lambda k, d: type(d)(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d
RESULTS = []


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""), flush=True)


def score(places):
    """places: true rank per position (as placed)"""
    per = [2 if p == r else 1 if abs(p - r) == 1 else 0 for p, r in enumerate(places)]
    return sum(per) + (3 if all(x == 2 for x in per) else 0)


def card_order(page):
    return page.evaluate("() => [...document.querySelectorAll('.sm-list .sm-card')].map((e) => ({ id: +e.dataset.id, top: parseFloat(e.style.top), label: e.querySelector('.sm-label').textContent })).sort((a, b) => a.top - b.top).map((x) => x.id)")


def drag_first_to_last(page):
    first = page.evaluate("() => { const l = [...document.querySelectorAll('.sm-list .sm-card')].sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)); const r = l[0].querySelector('.sm-label').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }")
    page.mouse.move(first["x"], first["y"])
    page.mouse.down()
    for i in range(1, 13):
        page.mouse.move(first["x"], first["y"] + i * 32, steps=2)
    page.mouse.up()
    time.sleep(0.3)


def true_order_from(state_rr):
    return [c["id"] for c in state_rr["correct"]]


def play_match(A, B, shots, rounds):
    totals = {A.user["user"]["id"]: 0, B.user["user"]["id"]: 0} if B else {A.user["user"]["id"]: 0}
    pages = [A] + ([B] if B else [])
    for rnd in range(1, rounds + 1):
        for p in pages:
            ok_ = wait(lambda: p.evaluate("() => document.querySelectorAll('.sm-list .sm-card').length") == 5 and not p.evaluate("() => document.querySelector('.sm-list--reveal')"), 8)
            if not ok_:
                ok(f"round {rnd}: five cards on {p.user['user']['name']}", False); return totals
        st = A.evaluate("() => window.__gs")
        ok(f"round {rnd}: question, category and direction shown", A.evaluate("() => !!document.querySelector('.sm-question').textContent && !!document.querySelector('.sm-cat') && !!document.querySelector('.sm-direction')"))
        ok(f"round {rnd}: five cards numbered 1-5, nothing but the labels before the reveal",
           A.evaluate("() => [...document.querySelectorAll('.sm-list .sm-num')].map((e) => e.textContent).join('') === '12345'") and "value" not in json.dumps(st) and "correct" not in json.dumps(st),
           json.dumps(st)[:200])
        if rnd == 1:
            if shots:
                A.screenshot(path=str(shots / "sort_desktop_sorting.png"))
                if B:
                    B.screenshot(path=str(shots / "sort_phone_sorting.png"))
            before = card_order(A)
            drag_first_to_last(A)
            after = card_order(A)
            ok("desktop: dragging the first card to the bottom reorders the list", after == before[1:] + before[:1], f"{before} -> {after}")
            if B:
                b0 = card_order(B)
                B.tap(".sm-list .sm-card:nth-child(1) .sm-arrow[data-dir='1']") if False else B.evaluate("() => { const l = [...document.querySelectorAll('.sm-list .sm-card')].sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)); l[0].querySelector('.sm-arrow[data-dir=\"1\"]').click(); }")
                time.sleep(0.3)
                b1 = card_order(B)
                ok("phone: the arrow button moves a card down", b1 == [b0[1], b0[0]] + b0[2:], f"{b0} -> {b1}")
        mine = {}
        for p in pages:
            mine[p.user["user"]["id"]] = card_order(p)
            p.click("[data-role='lock']")
        for p in pages:
            ok_ = wait(lambda: p.evaluate("() => !!document.querySelector('.sm-list--reveal')"), 8)
            if not ok_:
                ok(f"round {rnd}: reveal on {p.user['user']['name']}", False); return totals
        time.sleep(5.2)                                     # the cards slide, then show their verdicts
        gs = A.evaluate("() => window.__gs")
        rr = gs["roundResult"]
        true_ids = true_order_from(rr)
        rank_of = {iid: r for r, iid in enumerate(true_ids)}
        for p in pages:
            uid = p.user["user"]["id"]
            expect = score([rank_of[i] for i in mine[uid]])
            got = next(r for r in rr["results"] if r["userId"] == uid)["points"]
            shown = p.evaluate("() => (document.querySelector('.sm-pts') || {}).textContent || ''")
            ok(f"round {rnd}: {p.user['user']['name']} points {got} == expected {expect} and shown ('{shown.strip()}')", got == expect and f"+{expect}" in shown, f"{shown}")
            totals[uid] += expect
        ok(f"round {rnd}: cards landed in the true order with verdict colours",
           A.evaluate("() => { const l = [...document.querySelectorAll('.sm-card--reveal')]; return l.length === 5 && l.every((e) => e.classList.contains('sm-card--verdict')) && l.every((e) => ['good', 'near', 'bad'].includes(e.dataset.verdict)); }")
           and card_order(A) == true_ids, f"{card_order(A)} vs {true_ids}")
        ok(f"round {rnd}: the real values and the explanation are shown", A.evaluate("() => [...document.querySelectorAll('.sm-value')].every((e) => e.textContent.length > 0) && !document.querySelector('.sm-explain').hidden"))
        if rnd == 1 and shots:
            A.screenshot(path=str(shots / "sort_desktop_reveal.png"))
            if B:
                B.screenshot(path=str(shots / "sort_phone_reveal.png"))
        for p in pages:
            p.click("[data-role='next']")
        time.sleep(0.4)
    return totals


def main():
    shots = Path(ARG("--shots", "")) if "--shots" in sys.argv else None
    if shots:
        shots.mkdir(parents=True, exist_ok=True)
    engine = ARG("--browser", "chromium")
    proc, base, tmp = start_server()
    try:
        ua, ub = login(base, "Anna"), login(base, "Ben")
        with sync_playwright() as p:
            b = getattr(p, engine).launch()
            ctxA, A = client(b, base, ua, 1280, 860, False)
            ctxB, B = client(b, base, ub, 390, 844, True)
            # home page still works
            ok("start page / chat still loads", A.evaluate("() => !!document.getElementById('games-panel')"))
            A.evaluate("() => ws.send(JSON.stringify({ type: 'game_create', game_type: 'sortiermeister', options: { rounds: 5 } }))")
            sid = wait(lambda: A.evaluate("() => myGameSessionId"), 5)
            ok("host created a Sortiermeister lobby", bool(sid))
            wait(lambda: B.evaluate("(sid) => gameSessions.some((s) => s.id === sid)", sid), 5)
            if B.evaluate("() => innerWidth < 900"):
                B.click("#mobile-games-btn"); time.sleep(0.4)
            B.evaluate("() => renderGamesPanel()")
            B.click("#games-panel-lobby-list .game-lobby-item button:has-text('Beitreten')")
            time.sleep(0.6)
            A.evaluate("() => renderGamesPanel()")
            A.click("#games-panel-lobby-list button:has-text('Jetzt starten')")
            ok("game opens on both screens", wait(lambda: modal_open(A) and modal_open(B), 8))
            time.sleep(0.8)
            ok("phone: dialog inside the viewport, no horizontal overflow", B.evaluate("() => { const r = document.querySelector('.game-modal').getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1; }"))
            totals = play_match(A, B, shots, 5)
            ok("game over: end screen with the podium on both screens", wait(lambda: A.evaluate("() => !!document.querySelector('.mg-endscreen')") and B.evaluate("() => !!document.querySelector('.mg-endscreen')"), 15))
            lb = A.evaluate("() => window.__over && window.__over.details && window.__over.details.leaderboard")
            ok("end screen totals == the sum of the round points", lb and all(e["score"] == totals[e["userId"]] for e in lb), f"{lb} vs {totals}")
            if shots:
                A.screenshot(path=str(shots / "sort_desktop_end.png"))
            A.click("[data-role='rematch']")
            ok("'Nochmal spielen' starts a fresh game (round 1, scores 0)", wait(lambda: A.evaluate("() => (window.__gs || {}).phase === 'sorting' && window.__gs.roundIndex === 1 && window.__gs.players.every((p) => p.score === 0)"), 8))
            ok("rematch: five cards again", wait(lambda: A.evaluate("() => document.querySelectorAll('.sm-list .sm-card').length") == 5, 6))
            ok("no console errors (host)", not errors(A), str(errors(A))[:200])
            ok("no console errors (phone)", not errors(B), str(errors(B))[:200])
            # solo game
            A.evaluate("() => closeGameModal()")
            time.sleep(0.5)
            ctxC, C = client(b, base, login(base, "Cleo"), 1280, 860, False)
            C.evaluate("() => ws.send(JSON.stringify({ type: 'game_create', game_type: 'sortiermeister', options: { rounds: 5 } }))")
            wait(lambda: C.evaluate("() => myGameSessionId"), 5)
            C.evaluate("() => renderGamesPanel()")
            started = False
            try:
                C.click("#games-panel-lobby-list button:has-text('Jetzt starten')", timeout=4000)
                started = wait(lambda: modal_open(C), 6)
            except Exception as e:
                print("solo start:", str(e)[:100])
            ok("solo: one player can start and sees the cards", bool(started) and bool(wait(lambda: C.evaluate("() => document.querySelectorAll('.sm-list .sm-card').length") == 5, 6)))
            if started:
                t = play_match(C, None, None, 1)
                ok("solo: a round completes and scores", any(v >= 0 for v in t.values()))
            ok("no console errors (solo)", not errors(C), str(errors(C))[:200])
            b.close()
    finally:
        proc.terminate()
    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed")
    if failed:
        print("FAILED:", *[f"{n} {d}" for n, _, d in failed], sep="\n  ")
        sys.exit(1)


if __name__ == "__main__":
    main()
