"""GoldRush canonical economy benchmark.

Plays a simulated player (tests/e2e/goldrush_bench.js) on many world seeds
and reports the distribution - P10 / median / P90 / min / max:

  without a strategy (phase 3): time to the first find / flake / tiny piece /
  nugget and the gold value dug up after 1 / 5 / 10 / 20 / 30 minutes
  with --strategy A|B|C|D (phase 4): a whole early game with sales trips to
  the camp and real purchases - first sale, when the shovel / pickaxe /
  upgrades are bought, cash and cash earned after 10 / 20 / 30 / 45 / 60 /
  90 minutes, what is owned at 30 / 60 / 90 minutes, how much of the
  mountain was moved

Runs the server from a temp copy (the real database is never touched).

    python tests/e2e/goldrush_bench.py [--seeds 60] [--minutes 30] [--tool hand] [--strategy B] [--json out.json]

Requires: pip install playwright && python -m playwright install chromium
"""

import json
import os
import statistics
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from goldrush_e2e import GPU_ARGS, GRKEY, gr_close, gr_open, gr_ready  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BOT = open(os.path.join(os.path.dirname(__file__), "goldrush_bench.js"), encoding="utf-8").read()
CHECK = [60, 300, 600, 1200, 1800]
CHECK4 = [600, 1200, 1800, 2700, 3600, 5400, 7200, 9000, 10800, 14400, 18000, 21600, 25200, 28800, 32400, 36000, 39600]
ITEMS = ["shovel", "pickaxe", "shovel.blade", "shovel.handle", "pickaxe.tip", "pickaxe.head", "bucket", "pan", "classifier", "pan.riffles", "bucket.large",
         "wheelbarrow", "sluice", "sluice.hopper", "sluice.mat", "bulkhopper", "feeder", "bulk.extension", "feeder.fine"]
OWNED_AT = (1800, 3600, 5400, 7200, 10800, 14400, 18000, 21600, 28800, 36000, 39600)


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


def run_seed(page, seed, minutes, tool, strategy=None):
    page.evaluate("(s) => { localStorage.removeItem(grKey()); localStorage.removeItem(grKey('.backup')); localStorage.setItem('goldrush.testSeed', String(s)); }", seed)
    gr_open(page)
    gr_ready(page)
    page.evaluate("() => window.__goldrush.setPaused(true)")
    page.add_script_tag(content=BOT)
    if tool != "hand":
        # (the game is paused: no lower / raise animation - straight into the hands)
        ok = page.evaluate("(t) => { window.__goldrush.devUnlock(true); return window.__goldrush.equipNow(t); }", tool)
        assert ok, f"tool {tool} not usable"
    pile = page.evaluate("() => window.__goldrush.volume().pile")
    page.evaluate("([s, t, st]) => window.__grBench.init(s, { tool: t, strategy: st })", [seed, tool, strategy])
    end = minutes * 60
    t = 0
    while t < end:
        t = min(end, t + 120)
        page.evaluate("(u) => window.__grBench.run(u)", t)
    res = page.evaluate("() => window.__grBench.result()")
    res["seed"] = seed
    res["pileM3"] = pile
    page.evaluate("() => { localStorage.removeItem(grKey()); }")
    gr_close(page)
    page.evaluate("() => { localStorage.removeItem(grKey()); localStorage.removeItem(grKey('.backup')); }")
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


def summarize4(results):
    """strategy runs: milestones, money, equipment, mountain"""
    def at(c, key):
        return [((r["snap"].get(str(c)) or r["snap"].get(c) or {}).get(key)) for r in results]
    out = {
        "seeds": len(results),
        "firstSale_s": dist([r["firstSale"] for r in results]),
        "bought_s": {i: dist([r["bought"].get(i) for r in results]) for i in ITEMS},
        "shovelToPickaxe_s": dist([(r["bought"].get("pickaxe") - r["bought"]["shovel"]) if r["bought"].get("pickaxe") and r["bought"].get("shovel") else None for r in results]),
        "cash_cents": {str(c): dist(at(c, "cash")) for c in CHECK4},
        "earned_cents": {str(c): dist(at(c, "earned")) for c in CHECK4},
        "owned": {},
        "kg": {str(c): dist(at(c, "kg")) for c in OWNED_AT},
        "procRounds": dist([r.get("procRounds") for r in results]),
        "pans": dist([r.get("pans") for r in results]),
        "panToClassifier_s": dist([(r["bought"].get("classifier") - r["bought"]["pan"]) if r["bought"].get("classifier") and r["bought"].get("pan") else None for r in results]),
        "pileShareRemoved_pct": dist([100 * r["removedM3"] / r["pileM3"] for r in results]),
        "trips": dist([r["trips"] for r in results]),
        "tripTime_s": dist([r["tripTime"] for r in results]),
        "biggestNugget_cents": dist([r["biggestNuggetCents"] or None for r in results]),
        "firstNugget_s": dist([r["first"]["nugget"] for r in results]),
    }
    for c in OWNED_AT:
        combos = {}
        for r in results:
            sn = r["snap"].get(str(c)) or r["snap"].get(c)
            if not sn:
                continue
            key = "+".join([t for t in sn.get("owned", []) if t != "hand"] + sn.get("upgrades", []) + sn.get("equipment", [])) or "hand only"
            combos[key] = combos.get(key, 0) + 1
        out["owned"][str(c)] = dict(sorted(combos.items(), key=lambda kv: -kv[1]))
    worth = [r["earned"] + 0 for r in results]
    out["richest"] = max(results, key=lambda r: r["earned"])["seed"]
    out["poorest"] = min(results, key=lambda r: r["earned"])["seed"]
    out["earned_total"] = dist(worth)
    return out


def main():
    seeds = arg("--seeds", 60)
    minutes = arg("--minutes", 30)
    tool = arg("--tool", "hand")
    strategy = arg("--strategy", "")
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
            ctx.add_init_script(GRKEY)
            page = ctx.new_page()
            page.goto(base + "/")
            page.wait_for_function("() => typeof ws !== 'undefined' && ws && ws.readyState === 1", timeout=15000)
            for n in range(seeds):
                seed = first_seed + n * 7
                r = run_seed(page, seed, minutes, tool, strategy or None)
                results.append(r)
                f = r["first"]
                if strategy:
                    print(f"seed {seed} [{strategy}]: sale {r['firstSale']} bought {r['bought']} cash {r['cash']} earned {r['earned']} trips {r['trips']} kg {r['kg']}", flush=True)
                else:
                    print(f"seed {seed}: find {f['find']} flake {f['flake']} tiny {f['tiny']} nugget {f['nugget']} | money {r['money']} | {r['actions']} actions {r['kg']} kg blocked {r['blocked']}", flush=True)
            b.close()
    finally:
        proc.terminate()
    summary = summarize4(results) if strategy else summarize(results)
    summary["strategy"] = strategy or None
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
