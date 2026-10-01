"""End-to-end check of GoldRush phase 4: the early-game loop - dig, find,
carry gold in the pouch, sell it at the assay station, buy supplies (shovel,
pickaxe, two upgrades each) - its balance (canonical strategy benchmark),
the phase-3 polish, save v4 and the camp UI on desktop and phones. Tests
1-56. Runs the server from a temp copy (the real database is never touched)
on a fixed world seed.

    python tests/e2e/goldrush_camp_e2e.py [--shots DIR] [--quick] [--full-bench] [--browser webkit]

    --quick       24 seeds x 90 min per strategy (default 40), long run 3,000 actions
    --full-bench  100 seeds x 90 min per strategy (the canonical numbers; ~1 h)

Requires: pip install playwright pillow && python -m playwright install chromium
"""

import io
import json
import math
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from goldrush_bench import run_seed as bench_seed, summarize4  # noqa: E402
from goldrush_e2e import GPU_ARGS, PHONE, client, errors, gr_close, gr_open, gr_ready, gr_start, heap_mb, wait_for  # noqa: E402
from goldrush_tools_e2e import ACT_N, LEDGER, SHAPE, SPOT, open_game, seeded, select, tools  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SEED = 4242
RESULTS = []
QUICK = "--quick" in sys.argv
FULL = "--full-bench" in sys.argv
FIX = Path(__file__).parent / "fixtures"
SHOVEL, PICKAXE = 1100, 4800


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def G(page, js, arg=None):
    return page.evaluate(js, arg) if arg is not None else page.evaluate(js)


def eco(page):
    return G(page, "() => window.__goldrush.economy()")


def fresh(page, seed=SEED):
    gr_close(page)
    page.evaluate("(s) => { for (const k of ['goldrush.save', 'goldrush.save.backup', 'goldrush.save.corrupt']) localStorage.removeItem(k); localStorage.setItem('goldrush.testSeed', String(s)); }", seed)
    open_game(page)


def reopen(page):
    gr_close(page)
    open_game(page)


def pouch(page):
    e = eco(page)
    return {"cents": e["pouchCents"], "ug": e["pouchUg"], "count": e["pouchSummary"]["count"], "classes": e["pouch"]}


def gather(page, n=200, seed=3):
    """dig n hand strokes on a fresh patch, finds straight into the pouch"""
    sp = G(page, SPOT, {"want": None, "reach": 2.1, "start": 0.37 + seed * 0.07, "fresh": True})
    return G(page, ACT_N, {"n": n, "tool": None, "spot": sp, "jitter": 0.35, "seed": seed})


def debug_find(page, cls, ug):
    sp = G(page, SPOT, {"want": None, "reach": 2.0, "start": 0.3, "fresh": False})
    G(page, "(s) => window.__goldrush.pose(s)", sp)
    return G(page, "([c, u]) => window.__goldrush.debugFind(c, u)", [cls, ug])


def landed(page, timeout=8):
    return wait_for(lambda: G(page, "() => window.__goldrush.pending().length === 0 && window.__goldrush.loot().active === 0"), timeout)


def resume(page):
    """back into the game after a sheet closed. Esc - and now and then Chrome
    refusing a pointer re-lock right after the last one (it wants ~1 s) -
    leaves the game on its "click to play" overlay: click it like a player
    would, again if the browser still says no."""
    for _ in range(8):
        time.sleep(0.2)
        if not G(page, "() => window.__goldrush.state().paused"):
            return True
        if page.is_visible(".gr-pause"):
            page.click(".gr-pause [data-act=resume]")
        time.sleep(0.3)
    return not G(page, "() => window.__goldrush.state().paused")


def shot(page, shots, name):
    if shots:
        page.screenshot(path=str(shots / f"gr4_{name}.png"))


def pixel_luma(page, x, y, r=6, ry=None):
    from PIL import Image
    ry = r if ry is None else ry
    img = Image.open(io.BytesIO(page.screenshot(clip={"x": x - r, "y": y - ry, "width": 2 * r, "height": 2 * ry}))).convert("L")
    px = list(img.getdata())
    return sum(px) / len(px)


# ======================================================================
# phase-3 polish (1-6)
# ======================================================================

def polish(A, shots):
    sp = G(A, SPOT, {"want": "dirt", "reach": 2.0, "start": 0.7, "fresh": True})
    G(A, ACT_N, {"n": 300, "tool": None, "spot": sp, "jitter": 0.35, "seed": 11})
    xz = G(A, "(s) => { const G = window.__goldrush; G.aimAt(s); const p = G.state(); return { x: p.x - Math.sin(s.yaw) * 1.3, z: p.z - Math.cos(s.yaw) * 1.3 }; }", sp)
    shape = G(A, SHAPE, {"x": xz["x"], "z": xz["z"], "R": 1.4})
    ok("1 300 hand strokes: the ground stays organic - a shallow hollow, no shaft, no needle, nothing steeper than the crust allows",
       shape["valid"] and shape["maxDeg"] <= 62.5 and shape["deepest"] < 0.5 and shape["looseOver"] <= 2, str(shape))
    # 2: fresh excavation looks different, and fades
    sp2 = G(A, SPOT, {"want": "dirt", "reach": 1.9, "start": 0.15, "fresh": True})
    G(A, "(s) => window.__goldrush.pose(s)", sp2)
    time.sleep(0.3)
    vw = A.viewport_size
    # a band across the hollow and its rim, clear of the reticle: the soil
    # turns darker / moister (a gravelly floor would turn cleaner instead)
    cx, cy = vw["width"] // 2, vw["height"] // 2 - 20
    band = lambda: pixel_luma(A, cx, cy, 32, 8)
    before = band()
    G(A, ACT_N, {"n": 25, "tool": None, "spot": sp2, "jitter": 0.0, "seed": 4})
    G(A, "(s) => window.__goldrush.pose(s)", sp2)
    time.sleep(0.3)
    fresh_l = band()
    shot(A, shots, "fresh_dirt")
    G(A, "() => window.__goldrush.advanceClock(400)")
    time.sleep(0.3)
    old_l = band()
    ok("2 freshly dug ground is visibly different (darker, moist soil) and fades back after a few minutes",
       fresh_l < before - 4 and old_l > fresh_l + 3, f"untouched {before:.1f} -> fresh {fresh_l:.1f} -> later {old_l:.1f}")
    # 3: hand variation leaves the rate alone, but strokes differ
    sp3 = G(A, SPOT, {"want": "dirt", "reach": 2.0, "start": 0.55, "fresh": False})
    G(A, "(s) => window.__goldrush.pose(s)", sp3)
    c0 = G(A, "() => window.__goldrush.tools().cycles")
    vars_ = []
    A.mouse.down()
    t0 = time.time()
    while time.time() - t0 < 6:
        v = G(A, "() => window.__goldrush.handVar()")
        if v["v"] and (not vars_ or vars_[-1][0] != v["cycle"]):
            vars_.append((v["cycle"], v["side"], round(v["v"]["dx"], 4), round(v["v"]["roll"], 4)))
        time.sleep(0.05)
    A.mouse.up()
    rate = (G(A, "() => window.__goldrush.tools().cycles") - c0) / 6.0
    sides = [s for _, s, _, _ in vars_]
    repeats = sum(1 for i in range(1, len(sides)) if sides[i] == sides[i - 1])
    ok("3 the hands vary (contact point, angle, now and then the same hand twice) without changing the pace (2-3 strokes/s)",
       2.0 <= rate <= 3.1 and len({(dx, ro) for _, _, dx, ro in vars_}) >= max(3, len(vars_) - 1) and 0 <= repeats < len(sides) // 2,
       f"{rate:.2f}/s, {len(vars_)} strokes, same-hand repeats {repeats}")
    # 4: reticle states
    sp4 = G(A, SPOT, {"want": "dirt", "reach": 2.0, "start": 0.6, "fresh": False})
    G(A, "(s) => window.__goldrush.pose(s)", sp4)
    time.sleep(0.4)
    dirt = {**G(A, "() => window.__goldrush.reticle()"), "x": G(A, "() => window.__goldrush.hudState().crosshair")}
    st = G(A, SPOT, {"want": "stone", "reach": 2.2, "start": 0.45, "fresh": False, "core": True})
    G(A, "(s) => window.__goldrush.pose(s)", st)
    time.sleep(0.4)
    stone = {**G(A, "() => window.__goldrush.reticle()"), "x": G(A, "() => window.__goldrush.hudState().crosshair")}
    G(A, "() => window.__goldrush.pose({ x: 0.6, z: 13, yaw: 0, pitch: -0.4 })")
    time.sleep(0.3)
    far = {**G(A, "() => window.__goldrush.reticle()"), "x": G(A, "() => window.__goldrush.hudState().crosshair")}
    ok("4 reticle: a quiet thin ring on diggable dirt, a small grey mark on stone, nothing out of range",
       dirt["x"] == "dig" and dirt["visible"] and dirt["opacity"] <= 0.25 and dirt["scale"] <= 0.15
       and stone["x"] == "hard" and stone["scale"] <= 0.08 and far["x"] in ("far", "idle") and not far["visible"],
       f"dirt {dirt} stone {stone} far {far}")
    # 5: the shovel's dump is readable (held, tipped far over)
    G(A, "() => window.__goldrush.devUnlock(true)")
    select(A, "shovel")
    sp5 = G(A, SPOT, {"want": "dirt", "reach": 2.3, "start": 0.2, "fresh": False})
    G(A, "(s) => window.__goldrush.pose(s)", sp5)
    rolls, dump_t = [], []
    A.mouse.down()
    t0 = time.time()
    while time.time() - t0 < 2.4:
        h = G(A, "() => { const G = window.__goldrush; const h = G.hand(); return [h.phase, G.toolRoll()]; }")
        if h[0] == "dump":
            rolls.append(h[1]); dump_t.append(time.time())
        time.sleep(0.02)
    A.mouse.up()
    span = (dump_t[-1] - dump_t[0]) if dump_t else 0
    ok("5 the shovel's dump reads well: the blade is swung aside and tipped right over (>= 80 deg) and held ~0.38 s",
       rolls and max(rolls) >= 1.4 and span >= 0.25, f"max roll {max(rolls) if rolls else None:.2f} rad, dump seen {span:.2f} s")
    shot(A, shots, "shovel_dump")
    select(A, "hand")
    G(A, "() => window.__goldrush.devUnlock(false)")
    # 6: every boulder cracks its own way
    seeds = G(A, "() => window.__goldrush.rockSeeds()")
    ok("6 rock cracks vary: each boulder has its own crack seed (cellular crack network, no regular pattern)",
       len(seeds) >= 6 and len(set(round(s, 3) for s in seeds)) == len(seeds), str(seeds[:6]))


# ======================================================================
# gold pouch (7-11), selling (12-16), shop (18-30)
# ======================================================================

def loop(A, shots):
    fresh(A)
    e0 = eco(A)
    ok("18 a new player: € 0,00, an empty pouch, only the hand", e0["cashCents"] == 0 and e0["pouchCents"] == 0 and tools(A)["owned"] == ["hand"], str(tools(A)["owned"]))
    # 7: a pickup goes into the pouch, not into the cash
    c = debug_find(A, 4, 5200)
    landed(A)
    p = pouch(A)
    ok("7 a picked-up piece lands in the gold pouch - the cash stays at € 0,00", p["cents"] == c and eco(A)["cashCents"] == 0 and p["classes"]["tinyGoldPiece"]["count"] == 1,
       f"pouch {p['cents']} ct, cash {eco(A)['cashCents']}")
    hud = G(A, "() => window.__goldrush.hudState()")
    ok("7b the HUD shows cash and, compactly under it, the pouch's value", hud["money"] == "€ 0,00" and hud["pouch"] and "≈" in hud["pouch"], str(hud))
    # 8: several classes add up per class and in total
    vals = [(1, 180), (2, 450), (3, 1600), (5, 21000)]
    want = c
    for cls, ug in vals:
        want += debug_find(A, cls, ug)
        landed(A)
    p = pouch(A)
    by = p["classes"]
    ok("8 several classes: counts, mass and value per class and the totals are exact",
       p["cents"] == want and by["traceGold"]["count"] == 1 and by["fineGold"]["count"] == 1 and by["goldFlake"]["count"] == 1 and by["smallNugget"]["count"] == 1
       and p["ug"] == 5200 + 180 + 450 + 1600 + 21000, f"{p['cents']} == {want}, {p['ug']} ug")
    shot(A, shots, "pouch_hud")
    # 9: save / reload: the pouch is identical
    G(A, "() => window.__goldrush.save()")
    reopen(A)
    p2 = pouch(A)
    ok("9 save / reload: the pouch comes back identical", p2 == p, f"{p2['cents']} / {p['cents']}")
    # 10: a pending nugget across a reload lands in the pouch exactly once
    n0 = pouch(A)["classes"]["smallNugget"]["count"]
    cn = debug_find(A, 5, 15500)
    G(A, "() => window.__goldrush.save()")
    A.reload()
    A.wait_for_function("() => typeof ws !== 'undefined' && ws && ws.readyState === 1", timeout=15000)
    open_game(A)
    p3 = pouch(A)
    ok("10 a nugget still in the air when the tab died: after reloading it is in the pouch - exactly once",
       p3["classes"]["smallNugget"]["count"] == n0 + 1 and p3["cents"] == p2["cents"] + cn and eco(A)["pending"] == [], f"{p2['cents']} + {cn} = {p3['cents']}")
    # 11: leaving with a piece in the air
    c11 = debug_find(A, 3, 2000)
    gr_close(A)
    open_game(A)
    p4 = pouch(A)
    ok("11 leaving with a piece in the air: it is in the pouch afterwards - nothing lost, nothing twice", p4["cents"] == p3["cents"] + c11 and eco(A)["pending"] == [], f"{p3['cents']} + {c11} = {p4['cents']}")

    # ---------------- selling
    G(A, "() => window.__goldrush.goToStation('assay')")
    time.sleep(0.3)
    ui = G(A, "() => window.__goldrush.uiState()")
    ok("16a at the gold buyer: a quiet prompt '[E] Gold verkaufen'", ui["near"] == "assay" and ui["prompt"] == "[E] Gold verkaufen", str(ui))
    shot(A, shots, "assay_exterior")
    A.keyboard.press("KeyE")
    time.sleep(0.4)
    ui = G(A, "() => window.__goldrush.uiState()")
    locked = G(A, "() => window.__goldrush.state().locked")
    ok("16b E opens the sell view: game input off, the mouse is free (pointer lock released)", ui["open"] == "assay" and not ui["inputEnabled"] and not locked, str(ui))
    shot(A, shots, "sell_ui")
    cash0 = eco(A)["cashCents"]
    sold0 = eco(A)["sold"]["sales"]
    value = pouch(A)["cents"]
    # 14: double click
    A.click("[data-act=sell-all]")
    A.click("[data-act=sell-all]", force=True)
    time.sleep(0.3)
    shot(A, shots, "sale_in_progress")
    # 15: save in the middle of the sale animation
    mid = G(A, "() => window.__goldrush.uiState().sale")
    G(A, "() => window.__goldrush.save()")
    saved = json.loads(G(A, "() => localStorage.getItem('goldrush.save')"))["economy"]
    time.sleep(2.0)
    e = eco(A)
    ok("13 SELL ALL: the cash rises by exactly the pouch's value, the pouch is empty, the sale is counted",
       e["cashCents"] == cash0 + value and e["pouchCents"] == 0 and e["sold"]["totalCashCents"] >= value, f"cash {cash0} -> {e['cashCents']} (+{value})")
    ok("14 a double click on 'Alles verkaufen' is ONE sale", e["sold"]["sales"] == sold0 + 1, f"sales {sold0} -> {e['sold']['sales']}")
    ok("15 a save during the sale animation already holds the finished sale (cash booked, pouch empty) - no loss, no double",
       mid and saved["cashCents"] == cash0 + value and saved["pouchSummary"]["totalGoldUg"] == 0, f"anim {mid}, saved cash {saved['cashCents']}")
    shot(A, shots, "cash_after_sale")
    hud_after = G(A, "() => window.__goldrush.hudState()")
    # 12: an empty pouch sells nothing
    r = G(A, "() => window.__goldrush.sell()")
    ok("12 selling an empty pouch changes nothing", not r["ok"] and eco(A)["cashCents"] == e["cashCents"] and eco(A)["sold"]["sales"] == e["sold"]["sales"], str(r))
    # 16: Esc closes the sheet first (not the pause menu over it); the close button takes the mouse back
    A.keyboard.press("Escape")
    time.sleep(0.3)
    ui = G(A, "() => window.__goldrush.uiState()")
    pause_visible = A.is_visible(".gr-pause")
    settings_visible = A.is_visible(".gr-panel")
    ok("16c Esc closes the sell view first (no settings panel over it); input is back", ui["open"] is None and ui["inputEnabled"] and not settings_visible, f"{ui} pause={pause_visible}")
    gr_start(A)
    G(A, "() => window.__goldrush.goToStation('assay')")
    A.keyboard.press("KeyE")
    time.sleep(0.3)
    A.click("[data-sheet=assay] [data-act=close-station]")
    # (a browser without pointer lock - headless WebKit - plays on in free-mouse mode)
    back = lambda: (lambda s: (s["locked"] or s["free"]) and s["running"] and not s["paused"])(G(A, "() => window.__goldrush.state()"))
    ok("16d closing with the button: back to the game, the mouse is captured again (or free-mouse mode where there is no lock)",
       wait_for(back, 3) and G(A, "() => window.__goldrush.uiState().inputEnabled"),
       f"{G(A, '() => window.__goldrush.uiState()')} {G(A, '() => { const s = window.__goldrush.state(); return { locked: s.locked, free: s.free, paused: s.paused }; }')}")
    print("  cash after first sales:", hud_after.get("money"), flush=True)

    # ---------------- the shop
    G(A, "() => window.__goldrush.goToStation('supply')")
    time.sleep(0.3)
    shot(A, shots, "supply_exterior")
    A.keyboard.press("KeyE")
    time.sleep(0.4)
    view = G(A, "() => window.__goldrush.shopView()")
    shovel = next(i for i in view["items"] if i["id"] == "shovel")
    shot(A, shots, "shop_ui")
    A.keyboard.press("Digit2")
    ok("19 the shovel is not yours until bought: key 2 does nothing, the shop shows its price and how far you are",
       tools(A)["equipped"] == "hand" and shovel["state"] == "available" and not shovel["affordable"] and shovel["missing"] == SHOVEL - eco(A)["cashCents"],
       f"{shovel['state']} missing {shovel['missing']}")
    shot(A, shots, "shovel_locked")
    cash = eco(A)["cashCents"]
    r = G(A, "() => window.__goldrush.buy('shovel')")
    ok("20 not enough cash: the purchase is refused, nothing changes", not r["ok"] and r["reason"] == "cash" and eco(A)["cashCents"] == cash and tools(A)["owned"] == ["hand"], str(r))
    row_text = A.inner_text("[data-item=shovel] .gr-shop-state")
    ok("20b the shop says what is missing, quietly (no red error)", "benötigt" in row_text and "/" in row_text, row_text)
    # 21/22/29: exactly enough, once, even when clicked fast
    G(A, f"() => window.__goldrush.setCash({SHOVEL})")
    G(A, "() => { window.__goldrush.closeStation(); return window.__goldrush.openStation('supply'); }")
    time.sleep(0.3)
    shot(A, shots, "shovel_affordable")
    btn = A.locator("[data-buy=shovel]")
    for _ in range(4):
        try:
            btn.click(timeout=300, force=True)
        except Exception:
            pass
    time.sleep(0.4)
    e = eco(A)
    shot(A, shots, "shovel_purchase")
    ok("21 exactly enough cash: the purchase goes through, the shovel is yours (and in your hands)",
       "shovel" in tools(A)["owned"] and e["cashCents"] == 0 and wait_for(lambda: tools(A)["equipped"] == "shovel", 2), f"cash {e['cashCents']}")
    ok("22 the price is taken exactly once", e["shop"]["spentCents"] == SHOVEL and len(e["shop"]["purchases"]) == 1, str(e["shop"]))
    ok("29 rapid clicks on 'Kaufen': one purchase", len(e["shop"]["purchases"]) == 1 and e["shop"]["toolPurchases"] == 1, str(e["shop"]["purchases"]))
    rack = G(A, "() => window.__goldrush.shopView().items.find((i) => i.id === 'shovel').state")
    ok("21b bought: the shop marks it owned; the shovel is gone from the rack in the shed", rack == "owned", rack)
    G(A, "() => window.__goldrush.closeStation()")
    # 30: never below zero
    r = G(A, "() => window.__goldrush.buy('shovel.blade')")
    neg = G(A, "() => window.__goldrush.setCash(-500)")
    ok("30 a negative balance is impossible (refused purchase, clamped cash)", not r["ok"] and r["reason"] == "cash" and neg == 0 and eco(A)["cashCents"] == 0, f"{r} cash {neg}")
    # 23: reload keeps it
    reopen(A)
    ok("23 after a reload the shovel is still yours", "shovel" in tools(A)["owned"] and tools(A)["saved"]["owned"] == ["hand", "shovel"], str(tools(A)["saved"]))
    # 24: pickaxe unlock condition
    G(A, "() => window.__goldrush.setCash(99999)")
    pk = next(i for i in G(A, "() => window.__goldrush.shopView()")["items"] if i["id"] == "pickaxe")
    r = G(A, "() => window.__goldrush.buy('pickaxe')")
    hard_before = G(A, "() => window.__goldrush.flags().hardSeen")
    rk = G(A, SPOT, {"want": None, "reach": 2.3, "start": 0.33, "fresh": False, "rock": True})
    G(A, "(s) => window.__goldrush.pose(s)", rk)
    pk2 = next(i for i in G(A, "() => window.__goldrush.shopView()")["items"] if i["id"] == "pickaxe")
    ok("24 the pickaxe unlocks with the shovel AND after meeting stone / a boulder (seen in reach) - no levels, no XP",
       not hard_before and pk["state"] == "locked" and not r["ok"] and r["reason"] == "locked" and pk2["state"] == "available", f"{pk['state']} -> {pk2['state']} {pk2['needs']}")
    shot(A, shots, "pickaxe_locked")
    # 25/26/27/28: buying the pickaxe and upgrades
    r = G(A, "() => window.__goldrush.buy('pickaxe')")
    ok("25 buying the pickaxe", r["ok"] and "pickaxe" in tools(A)["owned"], str(r))
    defs0 = {d["id"]: d for d in G(A, "() => window.__goldrush.toolDefs()")}
    sp = G(A, SPOT, {"want": "dirt", "reach": 2.3, "start": 0.83, "fresh": True, "uniform": True})
    k0 = G(A, ACT_N, {"n": 4, "tool": "shovel", "spot": sp, "jitter": 0})
    r1 = G(A, "() => window.__goldrush.buy('shovel.blade')")
    r2 = G(A, "() => window.__goldrush.buy('shovel.handle')")
    r3 = G(A, "() => window.__goldrush.buy('pickaxe.tip')")
    r4 = G(A, "() => window.__goldrush.buy('pickaxe.head')")
    ok("26 buying upgrades", all(x["ok"] for x in (r1, r2, r3, r4)) and eco(A)["shop"]["upgradePurchases"] == 4, str([r1, r2, r3, r4]))
    shot(A, shots, "tool_upgrade")
    defs1 = {d["id"]: d for d in G(A, "() => window.__goldrush.toolDefs()")}
    sp2 = G(A, SPOT, {"want": "dirt", "reach": 2.3, "start": 0.91, "fresh": True, "uniform": True})
    k1 = G(A, ACT_N, {"n": 4, "tool": "shovel", "spot": sp2, "jitter": 0})
    kb = k0["pureKg"][0] / max(1, k0["pureN"][0])
    ka = k1["pureKg"][0] / max(1, k1["pureN"][0])
    vol = defs1["shovel"]["kernel"]["vol"] / defs0["shovel"]["kernel"]["vol"]
    cyc = defs1["shovel"]["cycle"][0] / defs0["shovel"]["cycle"][0]
    dmg = defs1["pickaxe"]["rockDamage"] / defs0["pickaxe"]["rockDamage"]
    swing = defs1["pickaxe"]["cycle"][3] / defs0["pickaxe"]["cycle"][3]
    total = (ka / kb) / cyc
    ok("27 upgrade effects match their definitions: blade +10 % per scoop (measured), handle ~7 % more scoops, pickaxe +25 % x +40 % damage with a slower swing - all together the shovel ~1.2x, no 3x",
       abs(vol - 1.1) < 1e-6 and 1.05 <= ka / kb <= 1.16 and 0.9 <= cyc <= 0.95 and abs(dmg - 1.75) < 1e-6 and swing > 1.0 and total < 1.35,
       f"vol x{vol:.3f}, kg/scoop {kb:.2f} -> {ka:.2f} (x{ka / kb:.3f}), cycle x{cyc:.3f}, rock damage x{dmg:.2f}, swing x{swing:.3f}, shovel overall x{total:.2f}")
    reopen(A)
    t = tools(A)
    look = G(A, "() => ({ rim: window.__goldrush.toolDefs().find((d) => d.id === 'shovel').upgrades })")
    ok("28 upgrades survive a reload and still apply", sorted(t["saved"]["upgrades"]) == ["pickaxe.head", "pickaxe.tip", "shovel.blade", "shovel.handle"] and len(look["rim"]) == 2, str(t["saved"]))


# ======================================================================
# mobile (17, 44-48)
# ======================================================================

def mobile(browser, base, user, shots):
    for name, vp in (("portrait", dict(PHONE)), ("landscape", dict(viewport={"width": 844, "height": 390}, device_scale_factor=3, is_mobile=True, has_touch=True))):
        ctx, M = client(browser, base, user, vp, extra_init=[seeded()])
        open_game(M)
        G(M, "() => window.__goldrush.debugFind(4, 4000)")
        landed(M)
        G(M, "() => window.__goldrush.goToStation('assay')")
        time.sleep(0.4)
        ctx_btn = M.is_visible(".gr-ctx-btn")
        label = M.inner_text(".gr-ctx-btn") if ctx_btn else None
        M.tap(".gr-ctx-btn")
        time.sleep(0.4)
        sheet = G(M, """() => { const c = document.querySelector('[data-sheet=assay] .gr-sheet-card').getBoundingClientRect();
          const btns = [...document.querySelectorAll('[data-sheet=assay] button')].filter((b) => b.offsetParent).map((b) => b.getBoundingClientRect());
          return { inside: c.left >= -1 && c.right <= innerWidth + 1 && c.top >= -1 && c.bottom <= innerHeight + 1, minH: Math.min(...btns.map((b) => b.height)), w: c.width, h: c.height }; }""")
        shot(M, shots, f"mobile_sell_{name}")
        if name == "portrait":
            ok("17/46 mobile sell: the context button 'VERKAUFEN' opens a bottom sheet inside the screen with 44 px targets",
               ctx_btn and label == "VERKAUFEN" and sheet["inside"] and sheet["minH"] >= 44, f"{label} {sheet}")
        # 47: a swipe on the sheet does not turn the camera
        yaw0 = G(M, "() => window.__goldrush.state().yaw")
        box = M.locator("[data-sheet=assay] .gr-sheet-card").bounding_box()
        cdp = ctx.new_cdp_session(M)
        x0, y0 = box["x"] + box["width"] / 2, box["y"] + 30
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x0, "y": y0, "id": 1}]})
        for k in range(1, 8):
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x0 + k * 25, "y": y0, "id": 1}]})
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        time.sleep(0.2)
        yaw1 = G(M, "() => window.__goldrush.state().yaw")
        if name == "portrait":
            ok("47 touch on the sheet never turns the camera behind it", abs(yaw1 - yaw0) < 1e-6, f"{yaw0} -> {yaw1}")
        M.tap("[data-sheet=assay] [data-act=close-station]")
        time.sleep(0.3)
        # 48: controls back: a swipe on the world turns the camera
        yaw2 = G(M, "() => window.__goldrush.state().yaw")
        vw = M.viewport_size
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": vw["width"] * 0.7, "y": vw["height"] * 0.3, "id": 2}]})
        for k in range(1, 8):
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": vw["width"] * 0.7 + k * 15, "y": vw["height"] * 0.3, "id": 2}]})
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        time.sleep(0.3)
        yaw3 = G(M, "() => window.__goldrush.state().yaw")
        ui = G(M, "() => window.__goldrush.uiState()")
        if name == "portrait":
            ok("48 closing the sheet gives the controls back (input on, a swipe turns the camera)", ui["open"] is None and ui["inputEnabled"] and abs(yaw3 - yaw2) > 0.01, f"{ui} yaw {yaw2:.3f} -> {yaw3:.3f}")
        # shop sheet
        G(M, "() => window.__goldrush.goToStation('supply')")
        time.sleep(0.3)
        M.tap(".gr-ctx-btn")
        time.sleep(0.4)
        shop = G(M, """() => { const card = document.querySelector('[data-sheet=supply] .gr-sheet-card'), c = card.getBoundingClientRect();
          const btns = [...document.querySelectorAll('[data-sheet=supply] button')].filter((b) => b.offsetParent).map((b) => b.getBoundingClientRect().height);
          return { inside: c.left >= -1 && c.right <= innerWidth + 1 && c.top >= -1 && c.bottom <= innerHeight + 1, scrolls: card.scrollHeight > card.clientHeight, minH: Math.min(...btns), rows: document.querySelectorAll('[data-sheet=supply] .gr-shop-item').length, w: Math.round(c.width), h: Math.round(c.height) }; }""")
        shot(M, shots, f"mobile_shop_{name}")
        ok(f"{'44' if name == 'portrait' else '45'} mobile shop ({name}): a sheet inside the screen, every item reachable (scrolls), 44 px targets",
           shop["inside"] and shop["rows"] == 6 and shop["minH"] >= 44, str(shop))
        M.tap("[data-sheet=supply] [data-act=close-station]")
        errs = errors(M)
        ok(f"mobile {name}: no page errors", not errs, str(errs[:3]))
        gr_close(M)
        ctx.close()


# ======================================================================
# save (49-53)
# ======================================================================

def saves(A):
    def load(doc):
        gr_close(A)
        A.evaluate("(d) => { localStorage.setItem('goldrush.save', JSON.stringify(d)); localStorage.removeItem('goldrush.save.backup'); }", doc)
        open_game(A)
        G(A, "() => window.__goldrush.save()")
        return json.loads(G(A, "() => localStorage.getItem('goldrush.save')"))
    v1 = {"saveVersion": 1, "worldSeed": 77, "createdAt": 1, "updatedAt": 2, "money": 3.5, "tool": "hand",
          "player": {"x": 0.6, "z": 10.2, "yaw": 0, "pitch": 0.1}, "stats": {"digs": 12}, "terrain": None}
    d = load(v1)
    ok("49 a phase-1 save (v1) loads: € 3,50 as cash, written as v4", d["saveVersion"] == 4 and d["economy"]["cashCents"] == 350 and d["tools"]["owned"] == ["hand"], str(d["economy"]["cashCents"]))
    fx2 = json.loads((FIX / "goldrush_save_v2.json").read_text(encoding="utf-8"))
    d = load(fx2["doc"])
    h = G(A, "() => window.__goldrush.hashes()")
    ok("50 a real phase-2 save (v2) loads: the same ground, € 1,20 as cash, written as v4", d["saveVersion"] == 4 and d["economy"]["cashCents"] == fx2["phase2"]["money"] and h["height"] == fx2["phase2"]["hashes"]["height"],
       f"cash {d['economy']['cashCents']}")
    fx3 = json.loads((FIX / "goldrush_save_v3.json").read_text(encoding="utf-8"))
    d = load(fx3["doc"])
    h = G(A, "() => window.__goldrush.hashes()")
    ok("51 a real phase-3 save (v3) loads: its cash stays exactly (gold sold back then is NOT turned back into gold), the pouch starts empty, the ground is the same",
       d["saveVersion"] == 4 and d["economy"]["cashCents"] == fx3["doc"]["economy"]["moneyCents"] and d["economy"]["pouchSummary"]["totalGoldUg"] == 0
       and d["economy"]["sold"]["legacyUg"] == fx3["doc"]["economy"]["inventory"]["totalGoldUg"] and h["height"] == fx3["phase2"]["hashes"]["height"],
       f"cash {fx3['doc']['economy']['moneyCents']} -> {d['economy']['cashCents']}, legacy gold {d['economy']['sold']['legacyUg']} ug")
    # 52: a v4 save reloads deterministically
    fresh(A)
    gather(A, 120, 5)
    G(A, "() => window.__goldrush.flushLoot()")
    G(A, "() => window.__goldrush.sell()")
    G(A, "() => window.__goldrush.setCash(2000)")
    G(A, "() => window.__goldrush.buy('shovel')")
    debug_find(A, 3, 1500)
    landed(A)
    G(A, "() => window.__goldrush.save()")
    h1 = G(A, "() => window.__goldrush.hashes()")
    e1 = eco(A)
    reopen(A)
    h2 = G(A, "() => window.__goldrush.hashes()")
    e2 = eco(A)
    same = {k: h1[k] == h2[k] for k in ("height", "qh", "slices", "carried", "rocks", "tools", "money")}
    ok("52 a v4 save reloads exactly: ground, slices, boulders, tools, cash, pouch, shop history",
       all(same.values()) and e1["pouch"] == e2["pouch"] and e1["shop"] == e2["shop"] and e1["sold"] == e2["sold"], str(same))
    # 53: a broken main save falls back to the backup
    G(A, "() => window.__goldrush.save()")
    gather(A, 10, 6)
    G(A, "() => window.__goldrush.save()")                    # previous good one becomes the backup
    gr_close(A)
    A.evaluate("() => localStorage.setItem('goldrush.save', '{\"saveVersion\":4,\"worldSeed\":4242,\"econ')")
    gr_open(A)
    gr_ready(A)
    notice = wait_for(lambda: A.is_visible(".gr-notice") and "Sicherung" in A.inner_text(".gr-notice"), 6)
    gr_start(A)
    e3 = eco(A)
    ok("53 a corrupt v4 save: the backup is loaded (cash, tools kept), the player is told", notice and e3["shop"]["toolPurchases"] == 1 and "shovel" in tools(A)["owned"], str(e3["cashCents"]))


# ======================================================================
# economy (31-43)
# ======================================================================

def economy(browser, base, user):
    seeds = 100 if FULL else (24 if QUICK else 40)
    ctx, A = client(browser, base, user, dict(viewport={"width": 960, "height": 600}), extra_init=[seeded()])
    sums, runs = {}, {}
    t0 = time.time()
    for st in ("A", "B", "C", "D"):
        rs = [bench_seed(A, 1001 + n * 7, 90, "hand", st) for n in range(seeds)]
        runs[st] = rs
        sums[st] = summarize4(rs)
    print(f"  benchmark: {seeds} seeds x 90 min x 4 strategies in {time.time() - t0:.0f} s", flush=True)
    m = lambda d: d.get("median")
    for st, s in sums.items():
        print(f"  [{st}] first sale {m(s['firstSale_s'])} s | " + " | ".join(f"{k} {m(v) and round(m(v) / 60, 1)} min" for k, v in s["bought_s"].items() if v.get("n")) +
              f" | earned 90 min {m(s['earned_cents']['5400'])} ct | kg 90 min {m(s['kg']['5400'])}", flush=True)
    A_, B_, C_, D_ = sums["A"], sums["B"], sums["C"], sums["D"]
    ok(f"31 the canonical early-game simulation ran: {seeds} seeds x 90 min x 4 strategies, real resource map, walking, sales trips, purchases",
       all(s["seeds"] == seeds for s in sums.values()), f"{seeds} seeds")
    sh = A_["bought_s"]["shovel"]
    ok("32 straight for the shovel: bought after ~15-25 min (median), not within minutes (P10 >= 10 min), nobody stuck (P90 <= 32 min)",
       sh["n"] == seeds and 15 * 60 <= sh["median"] <= 25 * 60 and sh["p10"] >= 10 * 60 and sh["p90"] <= 32 * 60,
       f"P10 {sh['p10'] / 60:.1f} / median {sh['median'] / 60:.1f} / P90 {sh['p90'] / 60:.1f} min")
    pk, gap = C_["bought_s"]["pickaxe"], C_["shovelToPickaxe_s"]
    ok("33 shovel -> pickaxe: the pickaxe after ~35-60 min in total, typically 15-30 min of shovel work later (never within 10 min)",
       pk["n"] >= seeds * 0.9 and 35 * 60 <= pk["median"] <= 60 * 60 and gap["p10"] >= 10 * 60 and 15 * 60 <= gap["median"] <= 30 * 60,
       f"pickaxe median {pk['median'] / 60:.1f} min, gap P10 {gap['p10'] / 60:.1f} / median {gap['median'] / 60:.1f} min")
    pkB = B_["bought_s"]["pickaxe"]
    ok("34 shovel -> blade upgrade -> pickaxe: everything within the 90 minutes for most players, the pickaxe later than in C",
       pkB["n"] >= seeds * 0.85 and pkB["median"] > pk["median"], f"B pickaxe median {pkB['median'] / 60:.1f} min vs C {pk['median'] / 60:.1f}")
    own60 = D_["owned"]["3600"]
    all6 = "shovel+pickaxe+pickaxe.head+pickaxe.tip+shovel.blade+shovel.handle"
    ok("35 upgrade-heavy: after 60 minutes a normal run does NOT own everything yet (something left to save for)",
       own60.get(all6, 0) <= seeds * 0.25, str(own60))
    # richest / poorest seeds (strategy A shovel timing)
    shovel_t = sorted((r["bought"].get("shovel") or 9e9, r["seed"]) for r in runs["A"])
    fastest, slowest = shovel_t[0], shovel_t[-1]
    rich_d = max(runs["D"], key=lambda r: r["earned"])
    ok("36 the luckiest seed does not skip the early game: shovel not before ~8 min, and not everything within 30 minutes",
       fastest[0] >= 8 * 60 and len([k for k, v in rich_d["bought"].items() if v <= 1800]) < 6, f"fastest shovel {fastest[0] / 60:.1f} min (seed {fastest[1]}), richest D run bought by 30 min: {[k for k, v in rich_d['bought'].items() if v <= 1800]}")
    ok("37 the poorest seed is no dead end: even its shovel comes within ~40 minutes", slowest[0] <= 40 * 60, f"slowest shovel {slowest[0] / 60:.1f} min (seed {slowest[1]})")
    fs = A_["firstSale_s"]
    ok("38 first sale typically within the first 2-6 minutes", fs["n"] == seeds and 120 <= fs["median"] <= 360, f"P10 {fs['p10']:.0f} / median {fs['median']:.0f} / P90 {fs['p90']:.0f} s")
    rows = {st: {k: (v.get("p10"), v.get("median"), v.get("p90")) for k, v in s["earned_cents"].items()} for st, s in sums.items()}
    print("  cash earned (P10/median/P90 ct):", json.dumps(rows), flush=True)
    mono = all(all((s["earned_cents"][a].get("median") or 0) <= (s["earned_cents"][b].get("median") or 0) for a, b in zip(("600", "1200", "1800", "2700", "3600"), ("1200", "1800", "2700", "3600", "5400"))) for s in sums.values())
    ok("39 money after 10 / 20 / 30 / 45 / 60 / 90 minutes reported (P10 / median / P90); it grows steadily", mono, json.dumps(rows["B"]))
    own = {st: s["owned"] for st, s in sums.items()}
    print("  owned at 30/60/90 min:", json.dumps(own), flush=True)
    hand_only_60 = sum(v for k, v in C_["owned"]["3600"].items() if k == "hand only")
    ok("40 equipment after 30 / 60 / 90 minutes: at 30 min the shovel (no pickaxe yet), at 60 min no one is still on bare hands",
       sum(v for k, v in C_["owned"]["1800"].items() if "pickaxe" in k) <= seeds * 0.2 and hand_only_60 == 0, json.dumps(own["C"]))
    kg60, kg90 = B_["kg"]["3600"], B_["kg"]["5400"]
    share = B_["pileShareRemoved_pct"]
    print(f"  mountain: kg 60 min {kg60}, 90 min {kg90}, share removed after 90 min {share}", flush=True)
    ok("41 a typical 60-minute player has moved a few tonnes - a small dent", kg60["median"] < 12000, f"{kg60['median']:.0f} kg")
    ok("42 a typical 90-minute player: still well under 2 % of the mountain", share["median"] < 2.0, f"{share['median']:.2f} % (P90 {share['p90']:.2f} %)")
    ok("43 nobody 'solves' the mountain early: even the busiest 90-minute run leaves > 97 % of it", share["max"] < 3.0, f"max {share['max']:.2f} %")
    gr_close(A)
    ctx.close()
    return sums


# ======================================================================
# long run (54-56)
# ======================================================================

def long_run(browser, base, user, shots, engine):
    ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
    open_game(A)
    G(A, "() => window.__goldrush.devUnlock(true)")
    G(A, "() => window.__goldrush.setQuality(window.__goldrush.state().level)")
    snap = lambda: {**A.evaluate("() => { const i = window.__goldrush.info(); return { geometries: i.geometries, textures: i.textures, objects: i.sceneObjects }; }"),
                    "heap": heap_mb(A), "dom": A.evaluate("() => document.getElementsByTagName('*').length"), "listeners": A.evaluate("() => window.__listeners()")}
    # 55 / 56: open / close the sheets 20 times each (the baseline is taken
    # after the first round: the lists are rendered into the sheet once)
    base_l = A.evaluate("() => window.__listeners()")
    for i in range(20):
        if i == 1:
            base_dom = A.evaluate("() => document.getElementsByTagName('*').length")
        G(A, "() => window.__goldrush.goToStation('supply')")
        A.keyboard.press("KeyE")
        A.wait_for_selector("[data-sheet=supply]:not([hidden])", timeout=3000)
        if i % 2:
            A.click("[data-sheet=supply] [data-act=close-station]")
        else:
            A.keyboard.press("Escape")
        resume(A)
    shop_ok = {"listeners": A.evaluate("() => window.__listeners()") - base_l, "dom": A.evaluate("() => document.getElementsByTagName('*').length") - base_dom, "ui": G(A, "() => window.__goldrush.uiState()")}
    ok("55 20x shop open / close (button and Esc): no listener / DOM growth, nothing stuck open, input back",
       shop_ok["listeners"] == 0 and abs(shop_ok["dom"]) <= 40 and shop_ok["ui"]["open"] is None and shop_ok["ui"]["inputEnabled"], str(shop_ok))
    dbg = 0
    for i in range(20):
        if i == 1:
            base_dom = A.evaluate("() => document.getElementsByTagName('*').length")
        if i % 4 == 0:
            dbg += debug_find(A, 2, 500) is not None
            landed(A)
        G(A, "() => window.__goldrush.goToStation('assay')")
        A.keyboard.press("KeyE")
        A.wait_for_selector("[data-sheet=assay]:not([hidden])", timeout=3000)
        if A.is_enabled("[data-act=sell-all]"):
            A.click("[data-act=sell-all]")
            time.sleep(0.1)
        A.click("[data-sheet=assay] [data-act=close-station]")
        resume(A)
    sell_ok = {"listeners": A.evaluate("() => window.__listeners()") - base_l, "dom": A.evaluate("() => document.getElementsByTagName('*').length") - base_dom,
               "ui": G(A, "() => window.__goldrush.uiState()"), "sales": eco(A)["sold"]["sales"]}
    ok("56 20x sell open / close (with sales, the animation cut short): no listener / DOM growth, no animation left running",
       sell_ok["listeners"] == 0 and abs(sell_ok["dom"]) <= 60 and not sell_ok["ui"]["sale"] and sell_ok["ui"]["open"] is None and sell_ok["sales"] >= 5, str(sell_ok))
    # 54: 10,000 actions, hundreds of pickups, 100 sales, purchases
    total = 3000 if QUICK else 10000
    done = k = sales = 0
    first = mid = None
    t0 = time.time()
    G(A, "() => window.__goldrush.setCash(0)")
    rk = G(A, SPOT, {"want": None, "reach": 2.3, "start": 0.33, "fresh": False, "rock": True})
    G(A, "(s) => window.__goldrush.pose(s)", rk)                     # has seen a boulder: the pickaxe can unlock
    plan = ["shovel", "shovel.blade", "pickaxe", "shovel.handle", "pickaxe.tip", "pickaxe.head"]
    while done < total:
        sp = G(A, SPOT, {"want": None, "reach": 2.25, "start": (k * 0.0731) % 1, "fresh": False})
        tool = ["hand", "shovel", "hand", "pickaxe", "shovel"][k % 5]
        k += 1
        r = G(A, ACT_N, {"n": 100, "tool": tool, "spot": sp, "jitter": 0.6, "seed": k})
        done += r["n"]
        if k % 10 == 0:
            select(A, tool)
            G(A, "(s) => window.__goldrush.pose(s)", sp)
            A.mouse.down(); time.sleep(1.0); A.mouse.up(); time.sleep(0.5)
        for _ in range(3 if not QUICK else 1):
            dbg += G(A, "() => window.__goldrush.debugFind(3, 1200)") is not None
        landed(A, 4)
        for _ in range(max(1, (100 if not QUICK else 30) // max(1, total // 100))):
            if G(A, "() => window.__goldrush.sell().ok"):
                sales += 1
        if plan:
            r = G(A, "(id) => window.__goldrush.buy(id)", plan[0])
            if r["ok"] or r["reason"] == "owned":
                plan.pop(0)
        G(A, "() => window.__goldrush.setCash(window.__goldrush.economy().cashCents + 900)")
        if first is None and k >= 10:
            G(A, "() => window.__goldrush.flushLoot()")
            first = snap()
        if mid is None and k >= 20 and k % 10 == 0 and done >= total // 2:
            G(A, "() => window.__goldrush.flushLoot()")
            mid = snap()
    G(A, "() => window.__goldrush.flushLoot()")
    time.sleep(1.0)
    last = snap()
    e = eco(A)
    idle = A.evaluate("() => window.__idle()")
    led = G(A, LEDGER)
    print(f"  long run: {done} actions, {e['stats']['finds']} finds into the pouch, {e['sold']['sales']} sales, purchases {[p['id'] for p in e['shop']['purchases']]} in {time.time() - t0:.0f} s; {first} -> {mid} -> {last}", flush=True)
    ok(f"54 long run: {done} actions + hundreds of pickups + {e['sold']['sales']} sales + purchases / upgrades - nothing keeps growing, ledger balanced",
       done >= total and e["sold"]["sales"] >= (25 if QUICK else 100) and len(e["shop"]["purchases"]) >= 3
       and (first["heap"] is None or last["heap"] - first["heap"] < 40) and last["geometries"] == mid["geometries"] and last["textures"] == mid["textures"]
       and last["textures"] - first["textures"] <= 1 and last["dom"] - first["dom"] <= 6 and last["listeners"] == first["listeners"] and last["objects"] - first["objects"] <= 2
       and (30 if engine == "chromium" else 1) <= idle["rafPerSec"] <= 130 and led["withGold"] + dbg == led["discovered"] + led["carried"],
       f"{first} -> {mid} -> {last} raf={idle['rafPerSec']} ledger={led} debug finds={dbg}")
    errs = errors(A)
    ok("long run without page errors", not errs, str(errs[:3]))
    gr_close(A)
    ctx.close()


def main():
    shots = None
    if "--shots" in sys.argv:
        shots = Path(sys.argv[sys.argv.index("--shots") + 1])
        shots.mkdir(parents=True, exist_ok=True)
    engine = sys.argv[sys.argv.index("--browser") + 1] if "--browser" in sys.argv else "chromium"
    proc, base, tmp = start_server()
    try:
        user = login(base, "Goldi")
        with sync_playwright() as p:
            browser = getattr(p, engine).launch(args=GPU_ARGS if engine == "chromium" else [])
            ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
            open_game(A)
            polish(A, shots)
            loop(A, shots)
            saves(A)
            errs = errors(A)
            ok("desktop part ran without page errors", not errs, str(errs[:3]))
            gr_close(A)
            ctx.close()
            if engine == "chromium":
                mobile(browser, base, user, shots)
            economy(browser, base, user)
            long_run(browser, base, user, shots, engine)
            browser.close()
    finally:
        proc.terminate()
    fails = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(fails)}/{len(RESULTS)} checks passed")
    for f in fails:
        print("FAILED:", f[0], f[2][:300])
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
