"""Mobile layout assertions for "Wer bin ich?" (static/games/who-am-i.js).

Mounts the real game module inside the real #game-modal markup + the real
static/style.css in headless Chromium (Playwright), feeds it synthetic
server states for every phase, and checks bounding boxes instead of
eyeballing screenshots:

- every other-player card is fully inside the visible game area (no
  clipping by any ancestor, not scrolled out of view) on first paint
- player name + identity text are not clipped inside the card
- no overlap between turn banner / own card / other cards / action panel
- the own card and the other cards keep the exact same boxes when the
  phase switches (asking -> waiting for answers -> vote result)

Usage:
    python tests/ui/whoami_mobile_layout.py            # run assertions
    python tests/ui/whoami_mobile_layout.py --shots D  # + save screenshots to D

Requires: pip install playwright && python -m playwright install chromium
"""

import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "static"


def _modal_markup():
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    start = html.index('<div id="game-modal"')
    end = html.index('<div id="toast"')
    return html[start:end].replace('class="modal-overlay" hidden', 'class="modal-overlay"')


HARNESS = """<!DOCTYPE html>
<html lang="de" data-theme="light"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
<link rel="stylesheet" href="/style.css" />
</head><body>
%MODAL%
<script>window.api = async () => ({ identities: [{ id: "x", name: "Stevie Wonder", aliases: [] }] });</script>
<script src="/games/who-am-i.js"></script>
<script>
  document.querySelector(".game-modal").classList.add("whoami-mode");
  document.getElementById("game-modal-title").textContent = "🎭 Wer bin ich?";
  window.__mount = (players) => {
    const stage = document.getElementById("game-stage");
    window.__inst = window.WhoAmI.mount(stage, {
      me: { id: 1 }, players, isHost: true,
      sendInput: () => {}, sendRematch: () => {}, closeGame: () => {},
    });
  };
</script>
</body></html>"""

VIEWPORTS = [(375, 667), (390, 844), (393, 852), (430, 932), (360, 800), (412, 915)]

NAMES = [
    ("Tim", None),
    ("TMM", "Stevie Wonder"),
    ("Maximilian-Alexander", "Arnold Schwarzenegger"),
    ("Lea", "Hermine Granger"),
    ("Jonas", "Leonardo DiCaprio"),
    ("Sophie", "Königin Elisabeth II."),
    ("Ben", "Pikachu"),
    ("Charlotte", "Cristiano Ronaldo"),
]


def make_state(n, phase, me_turn=True, voted=False, me_solved=False, history=2):
    players = []
    for i in range(n):
        name, ident = NAMES[i]
        is_self = i == 0
        solved = is_self and me_solved
        identity = None
        if not is_self:
            identity = {"id": f"id{i}", "name": ident, "category": "music", "difficulty": "easy", "type": "person"}
        elif solved:
            identity = {"id": "id0", "name": "Albert Einstein", "category": "history", "difficulty": "easy", "type": "person"}
        players.append({
            "userId": i + 1, "name": name, "active": True, "solved": solved, "isSelf": is_self,
            "identity": identity, "questionsAsked": 1, "wrongGuesses": 0, "score": None,
        })
    asker = 1 if me_turn else 2
    hist = [{"askerId": 1 + (k % n), "question": f"Bin ich eine echte Person? ({k + 1})", "result": "yes"} for k in range(history)]
    s = {
        "phase": phase, "roundsPlayed": 1, "maxRounds": 15, "players": players,
        "currentAskerId": asker, "isMyTurn": asker == 1, "questionNumberThisTurn": 1, "maxQuestionsPerTurn": 3,
        "currentQuestion": "Bin ich ein Musiker, der vor 1960 geboren wurde?", "secondsLeft": 42, "history": hist,
    }
    if phase == "voting":
        voters = [p["userId"] for p in players if p["userId"] != asker]
        s["votingOpen"] = (asker != 1) and not voted
        s["voteStatus"] = {str(v): (v == 1 and voted) for v in voters}
        s["myVote"] = "yes" if voted else None
        s["voterIds"] = voters
    if phase == "vote_result":
        s["voteResult"] = {"result": "yes", "yesCount": max(1, n - 1), "noCount": 0, "unclearCount": 0}
    if me_solved:
        s["lastGuessResult"] = {"seq": 1, "userId": 1, "correct": True, "guessedText": "Albert Einstein"}
    return s


STATES = {
    "ich-dran-frage": dict(phase="asking", me_turn=True),
    "warte-auf-antworten": dict(phase="voting", me_turn=True),
    "antwort-ergebnis": dict(phase="vote_result", me_turn=True),
    "anderer-dran": dict(phase="asking", me_turn=False),
    "abstimmen": dict(phase="voting", me_turn=False),
    "abgestimmt-warten": dict(phase="voting", me_turn=False, voted=True),
    "selbst-erraten": dict(phase="asking", me_turn=False, me_solved=True),
    "langer-verlauf": dict(phase="asking", me_turn=True, history=12),
}

JS_MEASURE = """() => {
  const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, b: r.bottom, r: r.right }; };
  const content = document.querySelector(".game-content");
  const view = R(content);
  // every ancestor that clips (overflow != visible) between a node and the modal
  function clipBoxes(el) {
    const out = [];
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") out.push({ cls: a.className, box: R(a) });
    }
    return out;
  }
  const textClip = (el) => el ? { sh: el.scrollHeight, ch: el.clientHeight, sw: el.scrollWidth, cw: el.clientWidth, text: el.textContent.trim() } : null;
  const others = [...document.querySelectorAll(".wai-card--other")].map((c) => ({
    box: R(c), clips: clipBoxes(c), cardSh: c.scrollHeight, cardCh: c.clientHeight,
    name: textClip(c.querySelector(".wai-card-name")), ident: textClip(c.querySelector(".wai-card-identity")),
  }));
  return {
    view, scrollTop: content.scrollTop, docOverflowX: document.documentElement.scrollWidth > window.innerWidth,
    banner: R(document.querySelector(".wai-turn-banner")),
    own: R(document.querySelector(".wai-card--own")),
    othersWrap: R(document.querySelector(".wai-others-row")),
    action: R(document.querySelector(".wai-action-card")),
    history: R(document.querySelector(".wai-history")),
    others,
  };
}"""


def overlap(a, b):
    if not a or not b:
        return False
    return a["x"] < b["r"] - 0.5 and b["x"] < a["r"] - 0.5 and a["y"] < b["b"] - 0.5 and b["y"] < a["b"] - 0.5


def inside(inner, outer, tol=0.5):
    return (inner["x"] >= outer["x"] - tol and inner["r"] <= outer["r"] + tol
            and inner["y"] >= outer["y"] - tol and inner["b"] <= outer["b"] + tol)


def check(m, label, must_be_visible):
    errs = []
    if m["docOverflowX"]:
        errs.append("page scrolls horizontally")
    for i, c in enumerate(m["others"]):
        tag = f"other#{i + 1} '{c['ident']['text'] if c['ident'] else '?'}'"
        for clip in c["clips"]:
            # .game-content (and on desktop the dialog) are the scroll
            # containers - being below their fold is scrolling, not clipping;
            # the first-paint rule below covers that on phones.
            if "game-content" in clip["cls"] or "game-modal" in clip["cls"]:
                continue
            if not inside(c["box"], clip["box"]):
                errs.append(f"{tag} clipped by .{clip['cls'].split()[0] if clip['cls'] else '?'} card={c['box']} clip={clip['box']}")
                break
        if must_be_visible and not inside(c["box"], m["view"]):
            errs.append(f"{tag} not fully visible on first paint (card y={c['box']['y']:.0f}-{c['box']['b']:.0f}, view {m['view']['y']:.0f}-{m['view']['b']:.0f})")
        if c["cardSh"] > c["cardCh"] + 1:
            errs.append(f"{tag} content taller than card ({c['cardSh']} > {c['cardCh']})")
        for key in ("name", "ident"):
            t = c[key]
            if t and (t["sh"] > t["ch"] + 1 or t["sw"] > t["cw"] + 1):
                errs.append(f"{tag} {key} text clipped ({t})")
        if c["ident"] and c["box"]["h"] < 44:
            errs.append(f"{tag} card too small (h={c['box']['h']:.0f})")
    blocks = [("banner", m["banner"]), ("own", m["own"]), ("others", m["othersWrap"]), ("action", m["action"]), ("history", m["history"])]
    for i in range(len(blocks)):
        for j in range(i + 1, len(blocks)):
            if overlap(blocks[i][1], blocks[j][1]):
                errs.append(f"{blocks[i][0]} overlaps {blocks[j][0]}")
    for i in range(len(m["others"])):
        for j in range(i + 1, len(m["others"])):
            if overlap(m["others"][i]["box"], m["others"][j]["box"]):
                errs.append(f"other#{i + 1} overlaps other#{j + 1}")
    return [f"[{label}] {e}" for e in errs]


def main():
    shots = None
    if "--shots" in sys.argv:
        shots = Path(sys.argv[sys.argv.index("--shots") + 1])
        shots.mkdir(parents=True, exist_ok=True)
    harness = HARNESS.replace("%MODAL%", _modal_markup())
    failures, runs = [], 0

    with sync_playwright() as p:
        browser = p.chromium.launch()

        def open_page(w, h):
            ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=2, is_mobile=True, has_touch=True)
            page = ctx.new_page()

            def route(r):
                path = r.request.url.split("://", 1)[1].split("/", 1)[1].split("?")[0]
                if path in ("", "index.html"):
                    return r.fulfill(body=harness, content_type="text/html")
                f = STATIC / path
                if f.is_file():
                    ctype = "text/css" if path.endswith(".css") else "application/javascript"
                    return r.fulfill(body=f.read_bytes(), content_type=ctype)
                return r.abort()

            page.route("**/*", route)
            page.goto("http://wai.test/")
            page.wait_for_timeout(400)  # let the dialog's modal-in transform finish before measuring
            return ctx, page

        def render(page, state):
            page.evaluate("(s) => { const players = s.players.map((p) => ({ id: p.userId, name: p.name })); "
                          "document.querySelector('.game-content').scrollTop = 0; window.__mount(players); window.__inst.setState(s); }",
                          state)
            page.wait_for_timeout(30)

        sizes = [(w, h, True) for w, h in VIEWPORTS] + [(w, h, False) for w, h in [(667, 375), (844, 390), (932, 430)]]
        for w, h, portrait in sizes:
            ctx, page = open_page(w, h)
            for n in (2, 3, 4, 5, 8):
                boxes = {}
                for name, kw in STATES.items():
                    render(page, make_state(n, **kw))
                    m = page.evaluate(JS_MEASURE)
                    label = f"{w}x{h} {n}P {name}"
                    runs += 1
                    failures += check(m, label, True)
                    boxes[name] = (m["own"], [c["box"] for c in m["others"]])
                    if shots and (n in (2, 4, 8)) and name != "langer-verlauf":
                        page.screenshot(path=str(shots / f"{w}x{h}_{n}P_{name}.png"))
                # State switches must not move/resize the own card or the other cards.
                ref_own, ref_others = boxes["ich-dran-frage"]
                for name in ("warte-auf-antworten", "antwort-ergebnis", "anderer-dran", "abstimmen", "abgestimmt-warten"):
                    own, others = boxes[name]
                    same = (abs(own["y"] - ref_own["y"]) < 1 and abs(own["h"] - ref_own["h"]) < 1
                            and all(abs(a["y"] - b["y"]) < 1 and abs(a["h"] - b["h"]) < 1 for a, b in zip(others, ref_others)))
                    if not same:
                        failures.append(f"[{w}x{h} {n}P] layout jumped between ich-dran-frage and {name}")
            # Scrolled down while typing, then the question is sent -> the new
            # phase must start at the top again with the cards visible.
            render(page, make_state(2, "asking", me_turn=True, history=12))
            page.evaluate("() => { const c = document.querySelector('.game-content'); c.scrollTop = c.scrollHeight; }")
            page.evaluate("(s) => window.__inst.setState(s)", make_state(2, "voting", me_turn=True, history=12))
            page.wait_for_timeout(30)
            runs += 1
            failures += check(page.evaluate(JS_MEASURE), f"{w}x{h} 2P scrolled-then-asked", True)
            if shots and portrait:
                # Final guess dialog + endscreen + options modal
                render(page, make_state(2, "asking", me_turn=True))
                page.click('[data-role="open-guess"]')
                page.fill(".wai-guess-input", "Stev")
                page.wait_for_timeout(400)
                page.screenshot(path=str(shots / f"{w}x{h}_2P_final-raten.png"))
                page.click('.wai-guess-overlay [data-role="cancel"]')
                page.evaluate("() => window.__inst.showGameOver({ details: { leaderboard: ["
                              "{ name: 'Tim', identity: { name: 'Albert Einstein' }, solved: true, score: 120, questionsAsked: 7 },"
                              "{ name: 'TMM', identity: { name: 'Stevie Wonder' }, solved: false, score: 0, questionsAsked: 9 }] } })")
                page.screenshot(path=str(shots / f"{w}x{h}_2P_ergebnis.png"))
                render(page, make_state(2, "asking", me_turn=True, history=6))
                page.click(".wai-history summary")
                page.evaluate("() => { const c = document.querySelector('.game-content'); c.scrollTop = c.scrollHeight; }")
                page.screenshot(path=str(shots / f"{w}x{h}_2P_verlauf-offen.png"))
                page.evaluate("() => window.WhoAmI.openHostOptionsModal(() => {})")
                page.wait_for_timeout(400)
                page.screenshot(path=str(shots / f"{w}x{h}_start-optionen.png"))
            ctx.close()

        # Desktop sanity: same assertions minus the first-paint visibility rule.
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        page = ctx.new_page()
        page.route("**/*", lambda r: r.fulfill(body=harness, content_type="text/html") if r.request.url.endswith("/")
                   else r.fulfill(body=(STATIC / r.request.url.split("wai.test/")[1]).read_bytes(),
                                  content_type="text/css" if r.request.url.endswith(".css") else "application/javascript"))
        page.goto("http://wai.test/")
        page.wait_for_timeout(400)
        for n in (2, 4, 8):
            for name, kw in STATES.items():
                render(page, make_state(n, **kw))
                runs += 1
                failures += check(page.evaluate(JS_MEASURE), f"desktop 1280x800 {n}P {name}", False)
                if shots and name in ("ich-dran-frage", "warte-auf-antworten"):
                    page.screenshot(path=str(shots / f"desktop_{n}P_{name}.png"))
        ctx.close()
        browser.close()

    for f in failures:
        print("FAIL", f)
    print(f"{runs} layout checks, {len(failures)} failures")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
