"""End-to-end check of GoldRush phase 7A: gameplay integration + visual quality pass.

  access    the developer access: a server without the code says WHY (which server answered, the
            variable missing / empty / misspelled) and never leaks a secret; 404 / 500 / no connection /
            a page that is not the status are told apart from "not configured"
  wash      the free wooden wash bowl: bucket -> bowl -> pouch from the first bucket on, exact recovery,
            tailings, the ledger, determinism, save mid-cycle, the gold pan replaces it and is clearly better;
            visible finds go into the bucket with their dig (phase 7B: carried, washing brings them out once)
  geology   mineralised streaks: same seed same streaks, never in the starter zone, hand / shovel stopped,
            the pickaxe loosens, then the shovel; no luck multiplier; the ledger; save / reload; more gold
            in a streak, taken from the rest of the pile
  gold      the visual scale: dust and fine gold are specks, a flake stays small, only a nugget is a nugget
  dig       particles: fixed pools, quality only changes the looks, 10 000 impacts without growth, colours
            in a believable band, the shovel's load builds up on the blade and leaves it
  save      continue identical, a new mine fresh, the save version unchanged
  dev       the 7A pack and preset (+ snapshot / restore of the bowl and the streak state)
  mobile    the bowl at the trough on the phone (portrait / landscape)
  perf      draw calls of the full phase-7 scene, frame rate, first look without upload, a long run
  shots     26 visual QA screenshots (--shots DIR; scratch only)
  bench     the early game with the bowl (6 seeds): pan timing, the feedback gaps; value per active
            minute of each way of working (dig to spoil / bucket + bowl / + pan / + classifier)

Runs the server from temp copies (the real database is never touched).

    python tests/e2e/goldrush_quality_e2e.py [--shots DIR] [--quick] [--no-bench] [--browser webkit] [--only parts]
"""

import json
import math
import os
import statistics
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from goldrush_bench import run_seed as bench_seed  # noqa: E402
from goldrush_e2e import CURRENT_SAVE, GPU_ARGS, PHONE, client, errors, gr_close, gr_start, heap_mb, wait_for  # noqa: E402
from goldrush_tools_e2e import open_game, seeded  # noqa: E402
import goldrush_dev_e2e as DEV  # noqa: E402
import goldrush_mech_e2e as M6  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

QUICK = "--quick" in sys.argv
ONLY = set(sys.argv[sys.argv.index("--only") + 1].split(",")) if "--only" in sys.argv else None
RESULTS = []
GR = "window.__goldrush"
WASH_PAN = {"x": -16.12, "z": 2.0, "yaw": math.pi / 2}
LOOT = "async () => await import('/games/goldrush/goldrush-loot.js')"


def G(page, js, arg=None):
    return page.evaluate(js, arg) if arg is not None else page.evaluate(js)


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def shot(page, shots, name):
    if shots:
        page.screenshot(path=str(shots / f"gr7a_{name}.png"))


def look(page, shots, name, cam, frames=0.25):
    if not shots:
        return
    if frames:
        G(page, f"(t) => {GR}.walk(t, 0, 0)", frames)
    # paused (no menu): the loop stops, so no frame paints over the camera view before the shot
    was = G(page, f"() => {GR}.state().paused")
    G(page, f"() => {GR}.setPaused(true)")
    G(page, f"(c) => {GR}.camLook(c)", cam)
    time.sleep(0.15)
    page.screenshot(path=str(shots / f"gr7a_{name}.png"))
    if not was:
        G(page, f"() => {GR}.setPaused(false)")


def proc(page):
    return G(page, f"() => {GR}.proc()")


def eco(page):
    return G(page, f"() => {GR}.economy()")


def close(page):
    if G(page, f"() => !!(window.__goldrush && {GR}.state && {GR}.state().paused)") and not page.is_visible(".gr-pause"):
        G(page, f"() => {GR}.setPaused(false)")
    return gr_close(page)


def fresh(page, seed=4242):
    if G(page, f"() => !!(window.__goldrush && {GR}.state && {GR}.state().paused)") and not page.is_visible(".gr-pause"):
        G(page, f"() => {GR}.setPaused(false)")
    M6.fresh(page, seed)


def reopen(page):
    """save, leave, come back (Continue)"""
    G(page, f"() => {{ {GR}.flushLoot(); {GR}.save(); }}")
    close(page)
    open_game(page)


def kit(page, items, cash=0):
    """tools granted (the pickaxe is only for sale after stone was hit), equipment bought"""
    G(page, f"""(ids) => {{ const g = {GR}; g.setCash(5000000);
      for (const id of ids) {{ if (id === 'shovel' || id === 'pickaxe') g.grant(id); else g.buy(id); }}
      g.equipNow(ids.includes('shovel') ? 'shovel' : 'hand'); g.setCash({cash}); }}""", items)


def bucket_batch(page, kind, ml, at_wash=True):
    return G(page, f"""async ([kind, ml, wash]) => {{ const m = await import('/games/goldrush/goldrush-devactions.js'); const pr = {GR}.procObj();
      if (wash) pr.devPlaceBucket(-16.15, 3.5, 0.4); return pr.devSetBucket(ml ? m.devBatch(kind, ml) : null); }}""", [kind, ml, at_wash])


def at_trough(page):
    G(page, f"(p) => {GR}.pose({{ x: p.x, z: p.z, yaw: p.yaw, pitch: -0.5 }})", WASH_PAN)
    return G(page, f"() => {GR}.stationNow()")


# a streak's best cemented surface cell and a stand 1,5 m outward from it, looking at it
STREAKSPOT = """(i) => {
  const g = window.__goldrush, S = g.streaks()[i];
  if (!S) return null;
  let best = null;
  for (let u = -S.len; u <= S.len; u += 0.125) for (let v = -S.w; v <= S.w; v += 0.125) {
    const x = S.x + u * Math.cos(S.strike) - v * Math.sin(S.strike), z = S.z + u * Math.sin(S.strike) + v * Math.cos(S.strike);
    const h = g.heightAt(x, z), val = g.streakAt(x, h - 0.01, z);
    if (val > 0.45 && (!best || val > best.val)) best = { x, z, h, val };
  }
  if (!best) return null;
  const dx = best.x - 0, dz = best.z + 6, d = Math.hypot(dx, dz) || 1, px = best.x + dx / d * 1.5, pz = best.z + dz / d * 1.5;
  return { ...best, px, pz };
}"""

# aim from a stand at a world point (yaw / pitch computed); -> the hit distance or null
AIMPT = """([px, pz, x, y, z]) => {
  const g = window.__goldrush, eye = g.groundAt(px, pz) + 1.62, d = Math.hypot(x - px, z - pz);
  return g.aimAt({ x: px, z: pz, yaw: Math.atan2(-(x - px), -(z - pz)), pitch: Math.atan2(y - eye, d) });
}"""

# a surface point of material `mat` on the pile (scanning rings round the starter) and a stand in front of it
MATSPOT = """(mat) => {
  const g = window.__goldrush, s = g.starter();
  for (let r = 1.5; r <= 16; r += 0.4) for (let a = 0; a < Math.PI * 2; a += 0.1) {
    const x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r, h = g.heightAt(x, z);
    if (h == null || h < 0.25 || g.materialAt(x, h - 0.006, z) !== mat || g.cementedAt(x, h - 0.01, z)) continue;
    const dx = x, dz = z + 6, d = Math.hypot(dx, dz) || 1, px = x + dx / d * 1.6, pz = z + dz / d * 1.6;
    return { x, z, h, px, pz };
  }
  return null;
}"""


def aim_point(page, sp, h=None):
    return G(page, AIMPT, [sp["px"], sp["pz"], sp["x"], (G(page, f"(p) => {GR}.heightAt(p[0], p[1])", [sp["x"], sp["z"]]) if h is None else h), sp["z"]])


def ledger_ok(page):
    return M6.ledger_ok(page)


def fingerprint(page):
    """the dev suite's fingerprint, its JSON parts compared by content (optional ledger fields such as
    bowlLoads / devInUg appear in the order they were first used - a reload lists them in a fixed order)"""
    fp = DEV.fingerprint(page)
    for k, v in fp.items():
        if isinstance(v, str) and v[:1] in "{[":
            try:
                fp[k] = json.dumps(json.loads(v), sort_keys=True)
            except ValueError:
                pass
    return fp


# ======================================================================
# ACCESS - the developer access tells its failures apart
# ======================================================================

def dev_message(page):
    """open Entwicklertools -> the message shown (then OK)"""
    DEV.dev_entry(page)
    page.wait_for_selector(".gr-dev-modal:not([hidden]) [data-role=m-text]:not([hidden])", timeout=8000)
    t = G(page, "() => document.querySelector('.gr-dev-modal [data-role=m-text]').textContent")
    page.click("[data-dev-modal=ok]")
    time.sleep(0.2)                      # back in the pause menu (where it came from)
    return t


def access(browser):
    logdir = Path(tempfile.mkdtemp(prefix="gr7a_dev_"))
    # a server without the code - its Render metadata as on Render (public, not secret)
    os.environ.update({"RENDER_SERVICE_NAME": "instachat-qa", "RENDER_SERVICE_ID": "srv-qa7a", "RENDER_GIT_COMMIT": "abcdef1234567", "RENDER_EXTERNAL_URL": "https://instachat-qa.onrender.com"})
    try:
        off, base_off, tmp_off, log_off = DEV.start_dev_server(None, logdir / "off.log")
    finally:
        for k in ("RENDER_SERVICE_NAME", "RENDER_SERVICE_ID", "RENDER_GIT_COMMIT", "RENDER_EXTERNAL_URL"):
            os.environ.pop(k, None)
    user = None
    try:
        user = login(base_off, "Access7A")
        s, body = DEV.http(base_off, "/api/goldrush/dev/status", headers={"X-Auth-Token": user["token"]})
        st = json.loads(body) if s == 200 else {}
        d = st.get("diagnosis") or {}
        ok("ACCESS no GOLDRUSH_DEV_CODE: the status says configured=false with a diagnosis - which server answered (service, id, commit, address), the variable missing",
           s == 200 and st.get("configured") is False and st.get("routeVersion") == 3 and d.get("variable") == "missing" and d.get("service") == "instachat-qa"
           and d.get("serviceId") == "srv-qa7a" and d.get("commit") == "abcdef1" and d.get("externalUrl") == "https://instachat-qa.onrender.com", body[:240])
        vals = json.dumps([v for v in d.values()])
        ok("ACCESS the diagnosis carries no secret / hash / token / other variables (only booleans and Render's public metadata)",
           "token" not in body and "TEAM_PASSWORD" not in body and "hash" not in vals
           # route version 3 (phase 9): + where the code comes from, quotes, the allowlist and this account on it - booleans / names only
           and set(d) == {"variable", "secretFile", "source", "quoted", "allowlist", "accountAllowed", "service", "serviceId", "instance", "commit", "externalUrl"}
           and all(isinstance(d[k], bool) for k in ("secretFile", "quoted", "allowlist", "accountAllowed")) and d["source"] in (None, "env", "secretFile"), body[:200])
        ctx, A = client(browser, base_off, user, dict(viewport={"width": 1280, "height": 720}), extra_init=[seeded()])
        open_game(A)
        t = dev_message(A)
        ok("ACCESS the player sees 'nicht konfiguriert' with the page's origin, the answering server and what is missing",
           "nicht konfiguriert" in t and f"Seite geöffnet über: {base_off}" in t and "instachat-qa" in t and "srv-qa7a" in t and "GOLDRUSH_DEV_CODE fehlt" in t, t[:300])
        # failures that are NOT "not configured"
        cases = [("404", lambda r: r.fulfill(status=404, body='{"detail":"Not Found"}', content_type="application/json"), "kennt den Entwicklerzugang nicht"),
                 ("500", lambda r: r.fulfill(status=500, body="boom", content_type="text/plain"), "HTTP 500"),
                 ("network", lambda r: r.abort(), "Keine Verbindung"),
                 ("html page", lambda r: r.fulfill(status=200, body="<!doctype html><title>x</title>", content_type="text/html"), "kennt den Entwicklerzugang nicht")]
        seen = {}
        for name, handler, want in cases:
            A.route("**/api/goldrush/dev/status", handler)
            t = dev_message(A)
            A.unroute("**/api/goldrush/dev/status")
            seen[name] = (want in t and "nicht konfiguriert" not in t, t[:90])
        ok("ACCESS 404 / 500 / no connection / a page that is no status: each its own message, never 'nicht konfiguriert'", all(v[0] for v in seen.values()), str(seen))
        errs = [e for e in errors(A) if "Failed to load resource" not in e and "net::ERR" not in e]
        ok("ACCESS part without page errors", not errs, str(errs[:3]))
        close(A)
        ctx.close()
    finally:
        off.terminate()
        log_off.close()
    # the dev requests carry the session only in the X-Auth-Token header, which uvicorn never logs.
    # (Known, outside GoldRush: the app's websocket URL /ws?token=... shows up in uvicorn's INFO access log.)
    lines = (logdir / "off.log").read_text(encoding="utf-8", errors="replace").splitlines()
    ws_lines = [l for l in lines if "WebSocket /ws?token=" in l]
    leaked = [l for l in lines if user and user["token"] in l and l not in ws_lines] + [l for l in lines if "GOLDRUSH_DEV_CODE=" in l or "x-auth-token" in l.lower()]
    ok("ACCESS the server log holds no dev code and no session token from the developer requests", user and not leaked and any("/api/goldrush/dev/status" in l for l in lines),
       f"{len(leaked)} leaking lines; app websocket access lines with the token (pre-existing, not GoldRush): {len(ws_lines)}")


# ======================================================================
# WASH - the free wooden wash bowl
# ======================================================================

def wash(A, shots):
    fresh(A)
    st = at_trough(A)
    ok("WASH B1 the wash place shows the bowl from the start; without a bucket it tells you what it is for", st and st.get("id") == "pan-none" and "Waschschale" in st.get("action", ""), str(st))
    kit(A, ["shovel", "bucket"])
    bucket_batch(A, "paydirt", 10000)
    st = at_trough(A)
    ok("WASH B1 with a bucket at the wash place: [E] 'Waschschale aus dem Eimer füllen' - no gold pan needed", st and st.get("id") == "pan-fill" and "Waschschale" in st.get("action", ""), str(st))
    load_before = G(A, f"() => {GR}.procObj().bucket.batch.serialize()")
    f = G(A, f"() => {GR}.procAct('pan-fill')")
    p = proc(A)
    load = G(A, f"() => {GR}.procObj().pan.batch.serialize()")
    ok("WASH B1 a small load (1,4 l) goes into the bowl, the rest stays in the bucket - exactly", f.get("ok") and p["panTool"] == "bowl" and load["volumeMl"] == 1400
       and p["bucket"]["batch"]["volumeMl"] == load_before["volumeMl"] - 1400, f"{load['volumeMl']} ml, bucket {p['bucket']['batch']['volumeMl']}")
    shot(A, shots, "16_basic_wash_start")
    w1 = G(A, f"() => {GR}.procWork(2.6)")
    G(A, f"() => {GR}.walk(0.05, 0, 0)")
    shot(A, shots, "17_muddy_wash")
    w2 = G(A, f"() => {GR}.procWork(30)")
    G(A, f"() => {GR}.walk(0.05, 0, 0)")
    shot(A, shots, "18_gold_reveal")
    t_bowl = w1["t"] + w2["t"]
    ok("WASH B4 a few seconds of swirling (no progress bar on its own): 1,4 l in ~4,5 s", w2.get("done") and 3.5 <= t_bowl <= 6.0, f"{t_bowl:.1f} s")
    c = G(A, f"() => {GR}.procCollect()")
    exp_fine = load["fineUg"] * 48 // 100
    ok("WASH B2 recovery: 0,48 of the fine gold and every visible piece - nothing invented, the rest in the tailings",
       c.get("ok") and c["tool"] == "bowl" and c["fineUg"] == exp_fine and c["pieces"] == len(load["finds"]), f"fine {c['fineUg']} vs {exp_fine}, pieces {c['pieces']}")
    lok, L, p = ledger_ok(A)
    ok("WASH B2 ledger: bucket -> bowl -> pouch + tailings, exact to the microgram", lok and L.get("bowlLoads") == 1, str({k: L[k] for k in ("inUg", "recoveredUg", "tailUg")}))
    # determinism: the same load in another mine gives the same gold
    fresh(A)
    kit(A, ["shovel", "bucket"])
    bucket_batch(A, "paydirt", 10000)
    at_trough(A)
    G(A, f"() => {GR}.procAct('pan-fill')")
    G(A, f"() => {GR}.procWork(30)")
    c2 = G(A, f"() => {GR}.procCollect()")
    ok("WASH B2 deterministic: the same load, the same gold (no dice)", c2["fineUg"] == c["fineUg"] and c2["ug"] == c["ug"], f"{c2['ug']} vs {c['ug']}")
    # save mid-cycle
    G(A, f"() => {GR}.procAct('pan-fill')")
    G(A, f"() => {GR}.procWork(2.0)")
    mid = G(A, f"() => {{ const pr = {GR}.procObj(); return {{ tool: pr.pan.tool, prog: pr.pan.progress, batch: pr.pan.batch.serialize(), inUg: pr.ledger.inUg }}; }}")
    G(A, f"() => {GR}.procStop && {GR}.procStop()")
    doc = G(A, f"() => {{ {GR}.save(); return JSON.parse(localStorage.getItem(grKey())); }}")
    reopen(A)
    back = G(A, f"() => {{ const pr = {GR}.procObj(); return {{ tool: pr.pan.tool, prog: pr.pan.progress, batch: pr.pan.batch.serialize(), inUg: pr.ledger.inUg }}; }}")
    ok("WASH save mid-cycle: the bowl's load, its progress and the tool come back exactly (save v%d)" % CURRENT_SAVE,
       doc["saveVersion"] == CURRENT_SAVE and doc["processing"]["pan"]["tool"] == "bowl" and back["tool"] == "bowl" and abs(back["prog"] - mid["prog"]) < 0.002
       and json.dumps(back["batch"], sort_keys=True) == json.dumps(mid["batch"], sort_keys=True), f"{mid['prog']:.3f} -> {back['prog']:.3f}")
    at_trough(A)
    G(A, f"() => {GR}.procAct('pan-work')")
    G(A, f"() => {GR}.procWork(30)")
    G(A, f"() => {GR}.procCollect()")
    lok, L, p = ledger_ok(A)
    ok("WASH after the reload: finished, no duplication / loss - the ledger balances, the input unchanged", lok and L["inUg"] == mid["inUg"], str(L["inUg"]))
    # the gold pan replaces the bowl - and is clearly better
    fresh(A)
    kit(A, ["shovel", "bucket"])
    bucket_batch(A, "paydirt", 10000)
    at_trough(A)
    G(A, f"() => {GR}.procAct('pan-fill')")
    bl = G(A, f"() => {GR}.procObj().pan.batch.serialize()")
    wb = G(A, f"() => {GR}.procWork(30)")
    cb = G(A, f"() => {GR}.procCollect()")
    kit(A, ["pan"])
    bucket_batch(A, "paydirt", 10000)
    st = at_trough(A)
    G(A, f"() => {GR}.procAct('pan-fill')")
    pl = G(A, f"() => {GR}.procObj().pan.batch.serialize()")
    wp = G(A, f"() => {GR}.procWork(30)")
    cp = G(A, f"() => {GR}.procCollect()")
    per_l_b, per_l_p = cb["ug"] / (bl["volumeMl"] / 1000), cp["ug"] / (pl["volumeMl"] / 1000)
    ok("WASH B3 the gold pan replaces the bowl ('Goldpfanne aus dem Eimer füllen'): 2,5 l a load, 0,58 of the fine gold",
       "Goldpfanne" in st.get("action", "") and cp["tool"] == "pan" and pl["volumeMl"] == 2500 and cp["fineUg"] == pl["fineUg"] * 58 // 100, str(st))
    # the bowl's loads are small and quick (a few seconds each), the pan's big and thorough: per
    # minute of play the pan wins through the gold it keeps (BENCH: value per active minute)
    loads_b = G(A, "async () => { const m = await import('/games/goldrush/goldrush-material.js'); const n = (cap, rest) => { let v = 10000, k = 0; while (v > 0) { v -= Math.min(v, cap); if (v < rest) v = 0; k++; } return k; }; return [n(m.BOWL_CAPACITY_ML, m.BOWL_REST_ML), n(m.PAN_CAPACITY_ML, 60)]; }")
    ok("WASH B3 the pan is clearly better: ~20 % more gold per litre, about twice the gold per load, a 10 l bucket in 4 loads instead of 7",
       per_l_p > per_l_b * 1.15 and cp["ug"] > cb["ug"] * 1.8 and loads_b == [7, 4], f"per l {per_l_p:.0f} vs {per_l_b:.0f} ug, per load {cp['ug']} vs {cb['ug']}, loads {loads_b}, s {wb['t']:.1f} / {wp['t']:.1f}")
    # the rest of a bucket goes along with the last bowl load (no 0,2 l mini load)
    fresh(A)
    kit(A, ["shovel", "bucket"])
    bucket_batch(A, "paydirt", 10000)
    at_trough(A)
    vols = []
    for _ in range(10):
        if not G(A, f"() => {GR}.procAct('pan-fill').ok"):
            break
        vols.append(G(A, f"() => {GR}.procObj().pan.batch.volumeMl"))
        G(A, f"() => {GR}.procWork(30)")
        G(A, f"() => {GR}.procCollect()")
    ok("WASH a full 10 l bucket is seven bowl loads (the last takes the 1,6 l rest), nothing left behind", vols == [1400] * 6 + [1600] and proc(A)["bucket"]["batch"]["volumeMl"] == 0, str(vols))
    # phase 7B: a dig that fits into the bucket takes its visible pieces along - nothing is shown at
    # the dig (no '+ EUR' while filling), the bucket carries material + fine gold + the pieces
    fresh(A)
    kit(A, ["shovel", "bucket"])
    shown, carried, into = 0, 0, 0
    for k in range(120):
        sp = G(A, M6.SPOT, {"want": "dirt", "reach": 2.0, "start": 0.2 + (k % 6) * 0.15, "fresh": True})
        if not sp:
            continue
        G(A, f"() => {{ const s = {GR}.state(); const yaw = s.yaw; {GR}.procPlaceBucket(s.x + Math.cos(yaw) * 0.55, s.z - Math.sin(yaw) * 0.55); }}")
        r = G(A, f"() => {GR}.act({{ visuals: true, tool: 'shovel' }})") or {}
        if (r.get("intoMl") or 0) > 0 and not r.get("spilledMl"):
            into += 1
            shown += r.get("finds") or 0
            carried += r.get("intoFinds") or 0
        if carried >= 3 or proc(A)["bucket"]["batch"]["volumeMl"] >= proc(A)["capacityMl"] - 1500:
            break
    pb = proc(A)["bucket"]
    b = pb["batch"]
    ok("WASH (7B) visible finds go into the bucket with their dig: none shown at the dig, the bucket holds them with the material + fine gold",
       into > 0 and carried > 0 and shown == 0 and len(b["finds"]) == carried and b["fineUg"] > 0, f"{into} digs into the bucket, {shown} finds shown, bucket pieces {len(b['finds'])}, fine {b['fineUg']} ug")
    G(A, f"() => {GR}.flushLoot()")
    lok, L, p = ledger_ok(A)
    ok("WASH the ledger stays exact with the pieces carried (bucket = its fine gold + its pieces)",
       lok and L["inUg"] == pb["goldUg"] == L["inFineUg"] + sum(f["ug"] for f in b["finds"]) and L["inFinds"] == len(b["finds"]), str({k: L[k] for k in ("inUg", "inFineUg", "inFinds")}))
    # ... and the bowl brings each of them out once
    at_trough(A)
    pieces, pouch0 = 0, eco(A)["pouchSummary"]["totalGoldUg"]
    for _ in range(12):
        if not G(A, f"() => {GR}.procAct('pan-fill').ok"):
            G(A, f"() => {GR}.procBucketToWash()")
            if not G(A, f"() => {GR}.procAct('pan-fill').ok"):
                break
        G(A, f"() => {GR}.procWork(30)")
        pieces += G(A, f"() => {GR}.procCollect()").get("pieces", 0)
    lok, L, p = ledger_ok(A)
    ok("WASH (7B) washing the bucket brings every carried piece out exactly once (the ledger exact)",
       lok and pieces == len(b["finds"]) and p["bucket"]["batch"]["volumeMl"] == 0, f"{pieces} of {len(b['finds'])} pieces, pouch +{eco(A)['pouchSummary']['totalGoldUg'] - pouch0} ug")


# ======================================================================
# GEOLOGY - mineralised streaks
# ======================================================================

def geology(A, shots):
    fresh(A, 4242)
    s1 = G(A, f"() => {GR}.streaks()")
    starter = G(A, f"() => {GR}.starter()")
    fresh(A, 4242)
    s2 = G(A, f"() => {GR}.streaks()")
    fresh(A, 777)
    s3 = G(A, f"() => {GR}.streaks()")
    ok("GEO deterministic: the same seed, the same streaks; another seed, other ones", s1 == s2 and s1 != s3 and len(s1) >= 4, f"{len(s1)} / {len(s3)}")
    dmin = min(math.hypot(s["x"] - starter["x"], s["z"] - starter["z"]) for s in s1)
    ok("GEO never in the starter zone (the first metres stay fair), one near its rim to be met early", dmin > 6.5 and dmin < 12, f"nearest {dmin:.1f} m")
    fresh(A, 4242)
    kit(A, ["shovel", "pickaxe"])
    sp = G(A, STREAKSPOT, 0)
    ok("GEO the first streak comes up to the surface somewhere (it can be seen and found)", sp is not None and sp["val"] > 0.45, str(sp and round(sp["val"], 2)))
    if not sp:
        return
    # dense in the streak's core, taken from elsewhere (more gold than the ground around it)
    g_in = G(A, f"(p) => {GR}.goldAt(p[0], p[1], p[2])", [sp["x"], sp["h"] - 0.05, sp["z"]])
    g_out = G(A, f"(p) => {GR}.goldAt(p[0] + 2.5, p[1], p[2])", [sp["x"], sp["h"] - 0.05, sp["z"]])
    ok("GEO a streak holds more gold than the ground beside it", g_in > g_out + 0.12, f"{g_in:.2f} vs {g_out:.2f}")
    look(A, shots, "09_mineralized_zone", {"x": sp["px"], "y": sp["h"] + 1.2, "z": sp["pz"], "tx": sp["x"], "ty": sp["h"], "tz": sp["z"]}, 0.2)
    res = {}
    for tool in ("hand", "shovel", "pickaxe"):
        G(A, f"(t) => {GR}.equipNow(t)", tool)
        aim_point(A, sp)
        res[tool] = G(A, f"(t) => {GR}.act({{ visuals: true, tool: t }})", tool)
    hand, shov, pick = res["hand"], res["shovel"], res["pickaxe"]
    shot(A, shots, "10_pickaxe_opening_mineralized")
    ok("GEO C2 bare hands bounce off the cemented streak ('verfestigter Kies')", hand and hand.get("blocked") and hand.get("cemented"), str(hand and {k: hand.get(k) for k in ("kind", "cemented", "streak")}))
    ok("GEO C2 the shovel only scrapes it (a fraction of a normal bite)", shov and shov.get("ok") and (shov.get("volumeMl") or 0) < 600, str(shov and shov.get("volumeMl")))
    pr = G(A, f"() => {GR}.probe()")
    ok("GEO C2 the pickaxe breaks it up and loosens it", pick and pick.get("ok") and not pick.get("blocked") and pr and pr.get("loose", 0) > 0, str(pr and {k: pr.get(k) for k in ("material", "loose", "cemented")}))
    G(A, "() => window.__goldrush.equipNow('shovel')")
    vols = []
    for _ in range(3):
        aim_point(A, sp)
        r = G(A, f"() => {GR}.act({{ visuals: false, tool: 'shovel' }})")
        vols.append(r.get("volumeMl") or 0)
    ok("GEO C2 then the shovel takes the loosened streak material in full bites (the tools work together)", max(vols) >= 900, str(vols))
    defs = G(A, f"() => {GR}.toolDefs()")
    ok("GEO no luck multiplier: the tools carry no gold / luck stats", all(not any(("luck" in k.lower() or "gold" in k.lower()) for k in d.keys()) for d in defs), "")
    # every find out of the streak is the ground's own (its slice holds it), the ledger exact through the bowl
    G(A, f"() => {GR}.procGrant('bucket')")
    G(A, f"(p) => {GR}.procPlaceBucket(p[0], p[1])", [sp["px"] + 0.5, sp["pz"]])
    keys = []
    for _ in range(12):
        G(A, f"(t) => {GR}.equipNow(t)", "pickaxe")
        aim_point(A, sp)
        r = G(A, f"() => {GR}.act({{ visuals: false, tool: 'pickaxe' }})") or {}
        keys += r.get("keys") or []
        G(A, f"(t) => {GR}.equipNow(t)", "shovel")
        aim_point(A, sp)
        r = G(A, f"() => {GR}.act({{ visuals: false, tool: 'shovel' }})") or {}
        keys += r.get("keys") or []
    real = all(G(A, f"(k) => {{ const [i, j, y] = k.split(':').map(Number); return {GR}.voxel(i, j, y).cls > 0; }}", k) for k in keys if k.count(":") == 2)
    inb = proc(A)["bucket"]["batch"]
    G(A, f"() => {GR}.procBucketToWash()")
    at_trough(A)
    for _ in range(30):
        if not G(A, f"() => {GR}.procAct('pan-fill').ok"):
            break
        G(A, f"() => {GR}.procWork(30)")
        G(A, f"() => {GR}.procCollect()")
    lok, L, p = ledger_ok(A)
    ok("GEO every find is a slice's own (no spawn at the strike); streak material through the bowl: the ledger exact", real and lok and inb["volumeMl"] > 0, f"{len(keys)} finds, {inb['volumeMl']} ml")
    found = eco(A)["flags"].get("streaksFound", [])
    reopen(A)
    pr2 = None
    G(A, f"(t) => {GR}.equipNow(t)", "shovel")
    aim_point(A, sp)
    pr2 = G(A, f"() => {GR}.probe()")
    ok("GEO save / reload: the streak counts as found, the dug / loosened ground stays as it was", 0 in found and 0 in eco(A)["flags"].get("streaksFound", []) and pr2 is not None, str(found))


# ======================================================================
# GOLD - the visual scale
# ======================================================================

def gold(A, shots):
    m = G(A, """async () => { const m = await import('/games/goldrush/goldrush-loot.js'); const r = m.findSize, L = m.FIND_LOOK;
      return { trace: [r(1, 1, 0), r(1, 3, 1)], fine: [r(2, 3, 0), r(2, 8, 1)], flake: [r(3, 8, 0), r(3, 30, 1)], tiny: [r(4, 25, 0), r(4, 90, 1)], nugget: [r(5, 100, 0), r(5, 400, 1)],
        kinds: [L[1].kind, L[2].kind, L[3].kind, L[4].kind, L[5].kind] }; }""")
    ok("GOLD D1-D4 class -> size: dust / fine gold specks (< 4 mm drawn), a flake < 7 mm, a tiny piece < 1 cm, a nugget (EUR 1-4) 1-1,7 cm",
       m["trace"][1] < 0.004 and m["fine"][1] < 0.004 and m["flake"][0] > m["fine"][1] and m["flake"][1] < 0.007 and m["tiny"][1] < 0.01 and m["nugget"][0] > m["tiny"][1] and m["nugget"][1] <= 0.017
       and m["kinds"][:2] == ["speck", "speck"], json.dumps(m))
    ok("GOLD the size grows with the value inside a class (EUR 1 nugget < EUR 4 nugget)", m["nugget"][0] < m["nugget"][1] and m["flake"][0] < m["flake"][1], "")
    # in the game: dig until pieces fly; none of them bigger than its class allows; dust is specks
    fresh(A)
    kit(A, ["shovel"])
    seen, specks = [], 0
    for k in range(60):
        sp = G(A, M6.SPOT, {"want": "dirt", "reach": 2.0, "start": 0.2 + (k % 6) * 0.15, "fresh": True})
        if not sp:
            continue
        r = G(A, f"() => {GR}.act({{ visuals: true, tool: 'shovel' }})")
        lo = G(A, f"() => {GR}.loot()")
        specks = max(specks, lo["specks"])
        seen += lo["pieces"]
        G(A, f"() => {GR}.walk(0.05, 0, 0)")
    limit = {3: 0.0069, 4: 0.0095, 5: 0.017}
    ok("GOLD no cent find is drawn like a nugget: every flying piece within its class size; dust shows as specks", seen and all(p["size"] <= limit[p["cls"]] for p in seen) and specks > 0,
       f"{len(seen)} pieces, max {max([p['size'] for p in seen] or [0]):.4f}, specks {specks}")
    look_ok = G(A, f"() => {GR}.lootLook()")
    ok("GOLD M the gold is metal (metalness 1, the environment and the sun light it), warm, not neon, not self-lit", look_ok["metalness"] == 1 and look_ok["envMap"] and look_ok["pointLights"] == 0 and look_ok["roughness"] >= 0.25, str(look_ok))
    G(A, f"() => {GR}.flushLoot()")


# ======================================================================
# DIG - particles and the shovel's load
# ======================================================================

def dig(A, shots):
    fresh(A)
    kit(A, ["shovel", "pickaxe"])
    G(A, f"() => {GR}.fxClear()")
    pools0 = G(A, f"() => {GR}.fxStats().pools")
    i0 = G(A, f"() => {GR}.info()")
    for mat in (0, 1, 2, 3):
        G(A, f"(m) => {GR}.fxImpact(m, 'shovel', 2500, 1 / 60)", mat)
    pools1 = G(A, f"() => {GR}.fxStats().pools")
    G(A, f"() => {GR}.walk(0.2, 0, 0)")
    i1 = G(A, f"() => {GR}.info()")
    st = G(A, f"() => {GR}.fxStats()")
    ok("DIG 10 000 impacts: fixed pools, nothing grows (geometries / textures / objects)", pools0 == pools1 and i1["geometries"] == i0["geometries"] and i1["textures"] == i0["textures"] and i1["sceneObjects"] == i0["sceneObjects"]
       and st["debris"] + st["chunks"] + st["trickle"] <= pools0["fragLimit"], f"{i0['geometries']}/{i1['geometries']} frags {st['debris'] + st['chunks']}")
    band = {}
    for mat in (0, 1, 2, 3):
        G(A, f"() => {GR}.fxClear()")
        G(A, f"(m) => {GR}.fxImpact(m, 'shovel', 6, 1 / 60)", mat)
        band[mat] = G(A, f"() => {GR}.fxColors()")
    ok("DIG G colours from the ground but in a band: no black lumps in brown earth, no white sparks in gravel", all(b["n"] and b["lo"] >= 0.045 and b["hi"] <= 0.21 for b in band.values()),
       json.dumps({k: [round(v["lo"] or 0, 3), round(v["hi"] or 0, 3)] for k, v in band.items()}))
    # dirt: mostly fine crumbs, big clods rare; stone: sharp, bigger splinters
    clods = []
    for _ in range(20):
        G(A, f"() => {GR}.fxClear()")
        s = G(A, f"() => {GR}.fxImpact(0, 'shovel', 1, 0)")
        clods.append(s["chunks"])
    G(A, f"() => {GR}.fxClear()")
    sd = G(A, f"() => {GR}.fxImpact(0, 'shovel', 1, 0)")
    G(A, f"() => {GR}.fxClear()")
    ss = G(A, f"() => {GR}.fxImpact(3, 'pickaxe', 1, 0)")
    ok("DIG G dirt: fine crumbs, a clod now and then; stone: chips and bigger splinters", statistics.mean(clods) <= 1.0 and sd["sizeDebris"] < 0.011 and ss["sizeChunks"] > sd["sizeDebris"] * 1.8,
       f"clods/cut {statistics.mean(clods):.2f}, dirt crumb {sd['sizeDebris']:.4f}, stone splinter {ss['sizeChunks']:.4f}")
    # quality changes the looks only: the same cut at LOW and at HIGH removes the same
    out = {}
    for q in ("low", "high"):
        fresh(A)
        kit(A, ["shovel"])
        G(A, f"(q) => {GR}.setQuality(q)", q)
        sp = G(A, M6.SPOT, {"want": "dirt", "reach": 2.0, "start": 0.4, "fresh": True})
        r = G(A, f"() => {GR}.act({{ visuals: true, tool: 'shovel' }})")
        out[q] = (r.get("volumeMl"), r.get("keys"), G(A, f"() => {GR}.fxStats().pools.fragLimit"))
    G(A, f"() => {GR}.setQuality('auto')")
    ok("DIG quality is visual only: LOW and HIGH dig exactly the same (volume, finds), only the particle budget differs", out["low"][:2] == out["high"][:2] and out["low"][2] < out["high"][2], str({k: (v[0], v[2]) for k, v in out.items()}))
    # the shovel's load: it builds up while scooping, sits on the blade, leaves it on the dump
    fresh(A)
    kit(A, ["shovel"])
    A.mouse.move(683, 384)                                 # first: with the pointer lock granted a move turns the view
    G(A, M6.SPOT, {"want": "dirt", "reach": 2.0, "start": 0.3, "fresh": True})
    A.mouse.down()
    trace = []
    t0 = time.time()
    # real time: sampled until the load was seen leaving the blade (at most 3 s - slow under load / with shots)
    while time.time() - t0 < 3.0:
        h = G(A, f"() => {GR}.hand()")
        trace.append((round(time.time() - t0, 2), h["phase"], round(h["load"], 2), h["crumbs"], h["soil"]))
        sc = [x[2] for x in trace if x[1] == "scoop"]
        if sc and h["phase"] == "dump" and h["load"] < max(sc) * 0.5:
            break
        time.sleep(0.02)
    A.mouse.up()
    if shots:
        # the screenshots on strokes of their own (a shot takes a moment - it would break the trace's timing)
        time.sleep(0.6)
        A.mouse.move(683, 384)
        G(A, M6.SPOT, {"want": "dirt", "reach": 2.0, "start": 0.45, "fresh": True})     # the first cut moved the face out of reach
        A.mouse.down()
        t1 = time.time()
        while time.time() - t1 < 4.0 and not os.path.exists(shots / "gr7a_06_shovel_release.png"):
            h = G(A, f"() => {GR}.hand()")
            if h["phase"] == "scoop" and h["load"] > 0.5 and not os.path.exists(shots / "gr7a_05_shovel_scoop_loaded.png"):
                shot(A, shots, "05_shovel_scoop_loaded")
            elif h["phase"] == "dump" and 0.02 < h["load"] < 0.6:
                shot(A, shots, "06_shovel_release")
            time.sleep(0.01)
        A.mouse.up()
    scoop = [x for x in trace if x[1] == "scoop"]
    dump = [x for x in trace if x[1] == "dump"]
    ok("DIG F the scoop reads: the load builds up on the blade while scooping, with crumbs on it, and leaves it on the dump",
       scoop and dump and max(x[2] for x in scoop) > min(x[2] for x in scoop) and max(x[3] for x in scoop) > 0 and min(x[2] for x in dump) < max(x[2] for x in scoop) * 0.6,
       str([x for x in trace if x[1] in ("scoop", "dump")][:8]))
    errs = errors(A)
    ok("DIG part without page errors", not errs, str(errs[:3]))


# ======================================================================
# SAVE - continue, new mine
# ======================================================================

def saves(A):
    fresh(A)
    kit(A, ["shovel", "pickaxe", "bucket"])
    bucket_batch(A, "streak", 9000)
    at_trough(A)
    G(A, f"() => {GR}.procAct('pan-fill')")
    G(A, f"() => {GR}.procWork(1.5)")
    G(A, f"() => {GR}.procStop && {GR}.procStop()")
    sp = G(A, STREAKSPOT, 0)
    G(A, f"(t) => {GR}.equipNow(t)", "pickaxe")
    aim_point(A, sp)
    G(A, f"() => {GR}.act({{ visuals: false, tool: 'pickaxe' }})")
    before = fingerprint(A)
    reopen(A)
    after = fingerprint(A)
    ok("SAVE continue: identical - terrain, slices, tools, the bucket, the bowl's load, the ledger, the flags (streaks found)", before == after, str({k: (before[k], after[k]) for k in before if before[k] != after[k]})[:300])
    G(A, f"() => {GR}.save()")
    doc = G(A, "() => JSON.parse(localStorage.getItem(grKey()))")
    ok("SAVE no new save version needed (still v%d): the bowl's tool and the streak flags are optional fields older saves simply lack" % CURRENT_SAVE,
       doc["saveVersion"] == CURRENT_SAVE and doc["processing"]["pan"]["tool"] == "bowl" and isinstance(doc["economy"]["flags"].get("streaksFound"), list), "")
    fresh(A)
    p, e = proc(A), eco(A)
    ok("SAVE a new mine starts fresh: no bucket, an empty bowl, no streak found", not p["owned"] and p["panTool"] == "pan" and not e["flags"].get("streaksFound"), str((p["owned"], e["flags"].get("streaksFound"))))


# ======================================================================
# DEV - the 7A pack
# ======================================================================

def dev_pack(browser, shots):
    logdir = Path(tempfile.mkdtemp(prefix="gr7a_devpack_"))
    on, base, tmp, log = DEV.start_dev_server(DEV.CODE, logdir / "server.log")
    try:
        user = login(base, "Dev7A")
        ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
        open_game(A)
        DEV.open_panel(A)
        ids = G(A, "() => [...document.querySelectorAll('[data-dev-cmd]')].map((b) => b.dataset.devCmd)")
        DEV.tab(A, "material")
        ids += G(A, "() => [...document.querySelectorAll('[data-dev-cmd]')].map((b) => b.dataset.devCmd)")
        DEV.tab(A, "world")
        ids += G(A, "() => [...document.querySelectorAll('[data-dev-cmd]')].map((b) => b.dataset.devCmd)")
        want = ["quick.phase7a", "wash.bowlTest", "bucket.poor", "bucket.paydirt7a", "bucket.streak", "gold.trace", "gold.fine", "gold.flake", "gold.tiny", "gold.nugget", "geo.streak", "geo.pickaxe", "geo.materials", "world.tp.camp"]
        ok("DEV the 7A actions are in the panel (bowl test, buckets poor / pay dirt / streak, gold samples, streak, pickaxe test, material preview, camp)", all(w in ids for w in want), str([w for w in want if w not in ids]))
        DEV.tab(A, "quick")
        t0 = time.time()
        r = DEV.cmd(A, "quick.phase7a")
        p, e = proc(A), eco(A)
        DEV.close_panel(A)
        st = G(A, f"() => {GR}.stationNow()")
        ok("DEV preset 'Phase 7A Qualitätstest': shovel + pickaxe + bucket (no pan), the bucket full of pay dirt at the wash place, you at the trough: [E] Waschschale",
           r and not r["error"] and "bucket" in p["owned"] and "pan" not in p["owned"] and p["bucket"]["batch"]["volumeMl"] == p["capacityMl"] and e["cashCents"] == 5000
           and st and st.get("id") == "pan-fill" and "Waschschale" in st.get("action", ""), str(st))
        G(A, f"() => {GR}.procAct('pan-fill')")
        w = G(A, f"() => {GR}.procWork(30)")
        c = G(A, f"() => {GR}.procCollect()")
        ok("DEV from the preset a wash in seconds (bucket loop checked in well under 2 minutes)", c.get("ok") and c["tool"] == "bowl" and time.time() - t0 < 120, f"{time.time() - t0:.1f} s")
        # snapshot / restore covers the bowl and the streak state
        G(A, f"() => {GR}.procAct('pan-fill')")
        G(A, f"() => {GR}.procWork(1.2)")
        G(A, f"() => {GR}.procStop && {GR}.procStop()")
        G(A, f"() => {{ {GR}.flushLoot(); {GR}.save(); }}")
        DEV.open_panel(A)
        DEV.tab(A, "save")
        DEV.cmd(A, "save.snapshot", confirm="ok")          # the preset's first cheat already made one: replace it
        snap = fingerprint(A)
        DEV.tab(A, "material")
        DEV.cmd(A, "bucket.poor")
        DEV.close_panel(A)
        G(A, f"() => {{ {GR}.procAct('pan-work'); {GR}.procWork(30); {GR}.procCollect(); }}")
        changed = fingerprint(A)
        DEV.open_panel(A)
        A.click("[data-dev=restore]")
        A.wait_for_selector(".gr-dev-modal:not([hidden]) [data-dev-modal=ok]", timeout=5000)
        A.click("[data-dev-modal=ok]")
        wait_for(lambda: G(A, f"() => !!(window.__goldrush && {GR}.state && {GR}.state().seed)"), 60)
        gr_start(A)
        back = fingerprint(A)
        ok("DEV snapshot / restore: the bowl's load and the bucket come back exactly", changed != snap and back == snap, str({k: (snap[k], back[k]) for k in snap if snap[k] != back[k]})[:240])
        # gold samples book nothing; the streak teleport / pickaxe test / material preview work
        pouch0 = eco(A)["pouchCents"]
        DEV.open_panel(A)
        DEV.tab(A, "material")
        for gid in ("gold.trace", "gold.flake", "gold.tiny", "gold.nugget"):
            DEV.cmd(A, gid)
        DEV.close_panel(A)
        G(A, f"() => {GR}.walk(0.4, 0, 0)")
        shot(A, shots, "dev_gold_samples")
        G(A, f"() => {GR}.flushLoot()")
        ok("DEV gold samples are looks only: shown, nothing booked", eco(A)["pouchCents"] == pouch0, f"{pouch0} -> {eco(A)['pouchCents']}")
        DEV.open_panel(A)
        DEV.tab(A, "world")
        r1 = DEV.cmd(A, "geo.pickaxe")
        DEV.close_panel(A)
        pr = G(A, f"() => {GR}.probe()")
        ok("DEV 'Spitzhacken-Geologie-Test': pickaxe in hand, in front of a streak (cemented under the crosshair)", r1 and not r1["error"] and G(A, f"() => {GR}.hand().tool") == "pickaxe" and pr and pr.get("streak", 0) > 0.2,
           f"{r1} {pr and pr.get('streak')}")
        DEV.open_panel(A)
        DEV.tab(A, "world")
        mats = [DEV.cmd(A, "geo.materials") for _ in range(4)]
        DEV.close_panel(A)
        ok("DEV 'Material-Vorschau' walks through dirt -> compact -> gravel -> stone", sum(1 for m in mats if m and not m["error"]) >= 3, str([m and m["text"][:40] for m in mats]))
        errs = errors(A)
        ok("DEV part without page errors", not errs, str(errs[:3]))
        close(A)
        ctx.close()
    finally:
        on.terminate()
        log.close()


# ======================================================================
# MOBILE - the bowl on the phone
# ======================================================================

def mobile(browser, base, user, shots):
    for name, vp in (("portrait", dict(PHONE)), ("landscape", dict(PHONE, viewport={"width": PHONE["viewport"]["height"], "height": PHONE["viewport"]["width"]}))):
        ctx, P = client(browser, base, user, vp, extra_init=[seeded()])
        fresh(P)
        kit(P, ["shovel", "bucket"])
        bucket_batch(P, "paydirt", 10000)
        at_trough(P)
        G(P, f"() => {GR}.walk(0.2, 0, 0)")
        label = P.inner_text(".gr-ctx-btn") if P.is_visible(".gr-ctx-btn") else None
        P.tap(".gr-ctx-btn")
        time.sleep(0.4)
        hint = G(P, "() => { const w = document.querySelector('.gr-work'); return w && !w.hidden ? w.textContent : ''; }")
        p = proc(P)
        shot(P, shots, f"{25 if name == 'portrait' else 26}_mobile_{name}")
        ok(f"MOBILE {name}: one context button WASCHEN at the trough; tapping starts the bowl, the hint says how (finger circles)",
           label and "WASCHEN" in label.upper() and p["work"] == "pan" and p["panTool"] == "bowl" and "Schale" in hint, f"{label} / {hint}")
        errs = errors(P)
        ok(f"MOBILE {name} without page errors", not errs, str(errs[:3]))
        close(P)
        ctx.close()


# ======================================================================
# PERF - draw calls, frame rate, first look, long run
# ======================================================================

def perf(browser, base, user, shots):
    import goldrush_auto_e2e as P7
    out = {}
    for name, vp in (("desktop", dict(viewport={"width": 1366, "height": 768})), ("phone", dict(PHONE))):
        ctx, A = client(browser, base, user, vp, extra_init=[seeded()])
        fresh(A)
        P7.automation(A)
        P7.bulk_batch(A, "paydirt", 300000)
        G(A, f"() => {{ {GR}.procWater(true); {GR}.procFeederMode('on'); }}")
        G(A, f"(t) => {{ {GR}.procObj().sluice.tailMl = 6e6; {GR}.pose({{ x: -17.5, z: 1.2, yaw: 0.6, pitch: -0.3 }}); {GR}.setPaused(false); }}")
        time.sleep(1.0)
        A.evaluate(M6.FRAME_REC); time.sleep(3); f1 = A.evaluate(M6.FRAME_STOP)
        i1 = G(A, f"() => {GR}.info()")
        out[name] = {"fps": f1["fps"], "p95": f1["p95"], "calls": i1["drawCalls"], "tris": i1["triangles"]}
        print(f"  perf {name}: {out[name]}", flush=True)
        close(A)
        ctx.close()
    ok("PERF O the full phase-7 scene (camp dressing included) in < 190 draw calls (was 218), 60 fps desktop and the emulated phone",
       all(v["calls"] < 190 and v["fps"] >= 55 for v in out.values()), json.dumps(out))
    # first look: a full turn round the camp, a bowl wash, a streak strike, gold - nothing uploaded on the way
    ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
    fresh(A)
    kit(A, ["shovel", "pickaxe", "bucket"])
    G(A, f"() => {GR}.walk(0.3, 0, 0)")
    i0 = G(A, f"() => {GR}.info()")
    for k in range(8):
        G(A, f"(y) => {GR}.pose({{ x: -14.0, z: 5.5, yaw: y, pitch: -0.1 }})", k * math.pi / 4)
        G(A, f"() => {GR}.walk(0.15, 0, 0)")
    bucket_batch(A, "paydirt", 6000)
    at_trough(A)
    G(A, f"() => {{ {GR}.procAct('pan-fill'); {GR}.procWork(30); }}")
    G(A, f"() => {GR}.walk(0.2, 0, 0)")
    G(A, f"() => {GR}.procCollect()")
    i1 = G(A, f"() => {GR}.info()")
    ok("PERF O3 first look: the camp all round, the dressing, the bowl in the hands - no texture uploaded on the way (geometry ±2)", i1["textures"] == i0["textures"] and i1["geometries"] <= i0["geometries"] + 2,
       f"tex {i0['textures']}->{i1['textures']} geo {i0['geometries']}->{i1['geometries']}")
    # a long run: 40 buckets through the bowl, digging in between
    s0 = {"g": i1["geometries"], "t": i1["textures"], "o": i1["sceneObjects"], "h": heap_mb(A)}
    rounds = 12 if QUICK else 40
    for k in range(rounds):
        bucket_batch(A, "paydirt" if k % 2 else "streak", 10000)
        for _ in range(8):
            if not G(A, f"() => {GR}.procAct('pan-fill').ok"):
                break
            G(A, f"() => {GR}.procWork(30)")
            G(A, f"() => {GR}.procCollect()")
        G(A, f"() => {GR}.walk(0.1, 0, 0)")
    time.sleep(0.3)
    i2 = G(A, f"() => {GR}.info()")
    s1 = {"g": i2["geometries"], "t": i2["textures"], "o": i2["sceneObjects"], "h": heap_mb(A)}
    lok, L, p = ledger_ok(A)
    ok(f"PERF long run: {rounds} buckets through the bowl - geometry / textures / objects / heap stable, the ledger exact",
       s1["g"] <= s0["g"] + 2 and s1["t"] == s0["t"] and s1["o"] == s0["o"] and (s0["h"] is None or s1["h"] - s0["h"] < 15) and lok, f"{s0} -> {s1}, bowl loads {L.get('bowlLoads')}")
    close(A)
    ctx.close()


# ======================================================================
# SHOTS - visual QA (scratch only)
# ======================================================================

def visual(A, shots):
    if not shots:
        return
    fresh(A)
    kit(A, ["shovel", "pickaxe", "bucket"])
    G(A, f"() => {GR}.setPaused(false)")
    names = {0: "01_dirt_hit", 1: "02_compact_hit", 2: "03_gravel_hit", 3: "04_stone_hit"}
    for mat, name in names.items():
        sp = G(A, MATSPOT, mat)
        if not sp:
            continue
        tool = "pickaxe" if mat == 3 else "shovel"
        G(A, f"(t) => {GR}.equipNow(t)", tool)
        aim_point(A, sp)
        G(A, f"(t) => {GR}.act({{ visuals: true, tool: t }})", tool)
        G(A, f"() => {GR}.walk(0.09, 0, 0)")
        shot(A, shots, name)
    sp = G(A, MATSPOT, 0)
    if sp:
        G(A, f"(t) => {GR}.equipNow(t)", "shovel")
        for _ in range(10):
            aim_point(A, sp)
            G(A, f"() => {GR}.act({{ visuals: false, tool: 'shovel' }})")
        G(A, f"() => {GR}.walk(0.2, 0, 0)")
        h = G(A, f"(p) => {GR}.heightAt(p[0], p[1])", [sp["x"], sp["z"]])
        look(A, shots, "07_fresh_cut_closeup", {"x": sp["px"], "y": h + 0.9, "z": sp["pz"], "tx": sp["x"], "ty": h, "tz": sp["z"]}, 0)
    look(A, shots, "08_terrain_blend", {"x": -11.0, "y": 3.0, "z": 9.5, "tx": -8.0, "ty": 0.3, "tz": 2.0})
    # gold scale: samples in front of you (looks only), caught in the air / on the ground
    for cls, cents, name, t in ((1, 2, "11_trace_gold", 0.12), (3, 15, "12_flake", 0.75), (4, 50, "13_tiny_nugget", 0.8), (5, 250, "14_nugget_eur1_4", 0.75)):
        G(A, f"() => {GR}.pose({{ x: -12.5, z: 6.2, yaw: 0.9, pitch: -0.62 }})")
        G(A, f"() => {GR}.walk(0.1, 0, 0)")
        G(A, f"(a) => {GR}.lootSample(a[0], a[1])", [cls, cents])
        G(A, f"(t) => {GR}.walk(t, 0, 0)", t)
        shot(A, shots, name)
        G(A, f"() => {GR}.flushLoot()")
    # wash place, camp, wet ground, paths, mountains
    bucket_batch(A, "paydirt", 10000)
    look(A, shots, "15_bucket_at_wash_area", {"x": -14.6, "y": 1.9, "z": 4.2, "tx": -16.4, "ty": 0.3, "tz": 3.2})
    look(A, shots, "19_wash_area_overview", {"x": -13.2, "y": 2.6, "z": 5.6, "tx": -17.2, "ty": 0.3, "tz": 2.4})
    look(A, shots, "20_camp_overview", {"x": -9.5, "y": 9.5, "z": 9.0, "tx": -18.5, "ty": 0.5, "tz": -2.5})
    look(A, shots, "21_wet_soil", {"x": -15.2, "y": 2.2, "z": 0.6, "tx": -17.0, "ty": 0.0, "tz": 2.2})
    look(A, shots, "22_paths_tracks", {"x": -12.5, "y": 4.8, "z": 12.5, "tx": -17.0, "ty": 0.0, "tz": 5.0})
    look(A, shots, "23_distant_mountains", {"x": -6.0, "y": 2.2, "z": 9.0, "tx": -40.0, "ty": 8.0, "tz": -40.0})
    G(A, f"() => {{ {GR}.setCash(23000); {GR}.goToStation('supply'); }}")
    G(A, f"() => {GR}.openStation('supply')")
    time.sleep(0.6)
    shot(A, shots, "24_shop")
    G(A, f"() => {GR}.closeStation && {GR}.closeStation()")


# ======================================================================
# BENCH - the early game with the bowl
# ======================================================================

def economy(browser, base, user):
    seeds = 3 if QUICK else 6
    ctx, A = client(browser, base, user, dict(viewport={"width": 960, "height": 600}), extra_init=[seeded()])
    runs = [bench_seed(A, 1001 + n * 7, 120, "hand", "P") for n in range(seeds)]
    med = lambda v: sorted(v)[len(v) // 2]
    pan = med([r["bought"].get("pan", 9e9) / 60 for r in runs])
    ok(f"BENCH P (shovel -> bucket -> pan, {seeds} seeds): the bowl is used from the bucket on, the pan still bought after ~1 h (50-95 min)", all(r["bowlLoads"] > 0 for r in runs) and 50 <= pan <= 95, f"pan {pan:.0f} min, bowl loads {[r['bowlLoads'] for r in runs]}")
    gap, strict = med([r["longestGap"] for r in runs]), med([r["longestGapStrict"] for r in runs])
    ok("BENCH E feedback: in the first 45 minutes no stretch of 5 minutes without anything to notice (median longest gap)", gap < 300, f"longest gap {gap} s, strict (flakes+ / wash / streak / sale / buy) {strict} s")
    # value per active minute (walks, carrying, swirling included) of each way of working, the same
    # seeds; baseline: digging to spoil with the full shovel (blade + handle). Small sample: loose
    # limits here - the 48-seed numbers are in docs/goldrush.md
    kits = {"direct": ["shovel", "shovel.blade", "shovel.handle"], "bowl": ["shovel", "bucket", "shovel.blade", "shovel.handle"],
            "pan": ["shovel", "bucket", "pan", "shovel.blade", "shovel.handle"], "classifier": ["shovel", "bucket", "pan", "classifier", "shovel.blade", "shovel.handle"]}
    per = {k: [bench_seed(A, 1001 + n * 7, 40, "shovel", "kit", v)["perMinCents"] for n in range(4 if QUICK else 6)] for k, v in kits.items()}
    mean = lambda v: sum(v) / len(v)
    r = {k: mean(per[k]) / mean(per["direct"]) for k in ("bowl", "pan", "classifier")}
    ok("BENCH processing pays per active minute despite carrying and washing: bucket + bowl > digging to spoil, the pan more, the classifier more again (target ~1,15-1,3 / 1,25-1,45 / 1,35-1,55)",
       1.05 <= r["bowl"] <= 1.4 and r["bowl"] * 1.08 <= r["pan"] <= 1.6 and r["pan"] <= r["classifier"] <= 1.7, json.dumps({k: round(v, 2) for k, v in r.items()}))
    close(A)
    ctx.close()


def main():
    shots = None
    if "--shots" in sys.argv:
        shots = Path(sys.argv[sys.argv.index("--shots") + 1])
        shots.mkdir(parents=True, exist_ok=True)
    engine = sys.argv[sys.argv.index("--browser") + 1] if "--browser" in sys.argv else "chromium"
    want = lambda part: not ONLY or part in ONLY
    proc_, base, tmp = start_server()
    try:
        user = login(base, "Quality7A")
        with sync_playwright() as p:
            browser = getattr(p, engine).launch(args=GPU_ARGS if engine == "chromium" else [])
            if want("access") and engine == "chromium":
                access(browser)
            ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
            for part, fn in (("wash", wash), ("geology", geology), ("gold", gold), ("dig", dig)):
                if want(part):
                    fn(A, shots)
            if want("save"):
                saves(A)
            if want("shots"):
                visual(A, shots)
            errs = errors(A)
            ok("desktop part ran without page errors", not errs, str(errs[:3]))
            close(A)
            ctx.close()
            if engine == "chromium":
                if want("mobile"):
                    mobile(browser, base, user, shots)
                if want("dev"):
                    dev_pack(browser, shots)
                if want("perf"):
                    perf(browser, base, user, shots)
            if want("bench") and "--no-bench" not in sys.argv:
                economy(browser, base, user)
            browser.close()
    finally:
        proc_.terminate()
    fails = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(fails)}/{len(RESULTS)} checks passed")
    for f in fails:
        print("FAILED:", f[0], f[2][:300])
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
