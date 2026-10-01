"""GoldRush canonical economy benchmark (phase 3).

Plays a simulated first-time player (tests/e2e/goldrush_bench.js) on many
world seeds and reports the distribution - P10 / median / P90 / min / max -
of: time to the first find, the first flake (or better), the first tiny
piece (or better), the first nugget, and the money after 1 / 5 / 10 / 20 /
30 minutes. Runs the server from a temp copy (the real database is never
touched).

    python tests/e2e/goldrush_bench.py [--seeds 60] [--minutes 30] [--tool hand] [--json out.json]

Requires: pip install playwright && python -m playwright install chromium
"""

import json
import os
import statistics
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from goldrush_e2e import GPU_ARGS, gr_close, gr_open, gr_ready  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BOT = open(os.path.join(os.path.dirname(__file__), "goldrush_bench.js"), encoding="utf-8").read()
CHECK = [60, 300, 600, 1200, 1800]


def arg(name, default):
    if name in sys.argv:
        return type(default)(sys.argv[sys.argv.index(name) + 1])
    return default


def pct(values, p):
    v = sorted(values)
    if not v:
        return None
    k = (len(v) - 1) * p
    lo, hi = int(k), min(len(v) - 1, int(k) + 1)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)


def dist(values, unit=""):
    got = [v for v in values if v is not None]
    missing = len(values) - len(got)
    if not got:
        return {"n": 0, "missing": missing}
    return {"p10": round(pct(got, 0.1), 2), "median": round(statistics.median(got), 2), "p90": round(pct(got, 0.9), 2),
            "min": round(min(got), 2), "max": round(max(got), 2), "n": len(got), "missing": missing}


def run_seed(page, seed, minutes, tool):
    page.evaluate("(s) => { localStorage.removeItem('goldrush.save'); localStorage.removeItem('goldrush.save.backup'); localStorage.setItem('goldrush.testSeed', String(s)); }", seed)
    gr_open(page)
    gr_ready(page)
    page.evaluate("() => window.__goldrush.setPaused(true)")
    page.add_script_tag(content=BOT)
    if tool != "hand":
        # (the game is paused: no lower / raise animation - straight into the hands)
        ok = page.evaluate("(t) => { window.__goldrush.devUnlock(true); return window.__goldrush.equipNow(t); }", tool)
        assert ok, f"tool {tool} not usable"
    page.evaluate("([s, t]) => window.__grBench.init(s, { tool: t })", [seed, tool])
    end = minutes * 60
    t = 0
    while t < end:
        t = min(end, t + 120)
        page.evaluate("(u) => window.__grBench.run(u)", t)
    res = page.evaluate("() => window.__grBench.result()")
    res["seed"] = seed
    page.evaluate("() => { localStorage.removeItem('goldrush.save'); }")
    gr_close(page)
    page.evaluate("() => { localStorage.removeItem('goldrush.save'); localStorage.removeItem('goldrush.save.backup'); }")
    return res


def summarize(results):
    out = {
        "seeds": len(results),
        "firstFind_s": dist([r["first"]["find"] for r in results]),
        "firstFlake_s": dist([r["first"]["flake"] for r in results]),
        "firstTiny_s": dist([r["first"]["tiny"] for r in results]),
        "firstNugget_s": dist([r["first"]["nugget"] for r in results]),
        "money_cents": {str(c): dist([r["money"].get(str(c), r["money"].get(c)) for r in results]) for c in CHECK},
        "biggestNugget_cents": dist([r["biggestNuggetCents"] or None for r in results]),
        "nuggets_per_run": dist([r["nuggets"] for r in results]),
        "kg_per_run": dist([r["kg"] for r in results]),
        "actions_per_run": dist([r["actions"] for r in results]),
        "blocked_share": dist([r["blocked"] / max(1, r["actions"]) for r in results]),
    }
    return out


def main():
    seeds = arg("--seeds", 60)
    minutes = arg("--minutes", 30)
    tool = arg("--tool", "hand")
    first_seed = arg("--first", 1001)
    proc, base, tmp = start_server()
    results = []
    t0 = time.time()
    try:
        user = login(base, "Benchy")
        with sync_playwright() as p:
            b = p.chromium.launch(args=GPU_ARGS)
            ctx = b.new_context(viewport={"width": 960, "height": 600})
            ctx.add_init_script(f"localStorage.setItem('instachat_token', {json.dumps(user['token'])}); localStorage.setItem('instachat_user', {json.dumps(json.dumps(user['user']))});")
            page = ctx.new_page()
            page.goto(base + "/")
            page.wait_for_function("() => typeof ws !== 'undefined' && ws && ws.readyState === 1", timeout=15000)
            for n in range(seeds):
                seed = first_seed + n * 7
                r = run_seed(page, seed, minutes, tool)
                results.append(r)
                f = r["first"]
                print(f"seed {seed}: find {f['find']} flake {f['flake']} tiny {f['tiny']} nugget {f['nugget']} | money {r['money']} | {r['actions']} actions {r['kg']} kg blocked {r['blocked']}", flush=True)
            b.close()
    finally:
        proc.terminate()
    summary = summarize(results)
    summary["tool"] = tool
    summary["minutes"] = minutes
    summary["wall_s"] = round(time.time() - t0, 1)
    print(json.dumps(summary, indent=1))
    out = arg("--json", "")
    if out:
        with open(out, "w", encoding="utf-8") as f:
            json.dump({"summary": summary, "runs": results}, f, indent=1)
    return summary


if __name__ == "__main__":
    main()
