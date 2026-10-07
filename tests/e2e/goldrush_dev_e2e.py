"""End-to-end check of GoldRush prompt 5.5: the developer / QA tools.

Server-side developer access (GOLDRUSH_DEV_CODE - a random code per run,
never the real one), the panel in the pause menu / settings, the developer
snapshot and restore, devModified, every command group (presets, cash,
gold pouch, equipment, material, teleports, debug views, save tools),
user separation, new mine, phones. Tests 1-48. Runs its own servers from
temp copies (the real database is never touched): one with the code (info
logging on, to prove the code never reaches a log), one without.

    python tests/e2e/goldrush_dev_e2e.py [--shots DIR] [--browser webkit]

Requires: pip install playwright && python -m playwright install chromium
"""

import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from goldrush_e2e import CURRENT_SAVE, GPU_ARGS, PHONE, client, errors, gr_close, gr_open, gr_ready, gr_start, wait_for  # noqa: E402
from goldrush_tools_e2e import open_game, seeded  # noqa: E402
from goldrush_process_e2e import bare_context, bucket_here, dig_spot, fill_bucket, kit, start_screen, ui_login, ui_logout  # noqa: E402
from kopfkicker_e2e import ROOT, free_port, login  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

RESULTS = []
GR = "window.__goldrush"
CODE = "qa-" + secrets.token_hex(8)                  # this run's developer code (never the real one)
PHASE5_ITEMS = ["shovel", "pickaxe", "shovel.blade", "shovel.handle", "pickaxe.tip", "pickaxe.head", "bucket", "pan", "classifier", "pan.riffles", "bucket.large"]
LAND = dict(PHONE, viewport={"width": 844, "height": 390})


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def G(page, js, arg=None):
    return page.evaluate(js, arg) if arg is not None else page.evaluate(js)


def shot(page, shots, name):
    if shots:
        page.screenshot(path=str(shots / f"gr55_{name}.png"))


# ---------------------------------------------------------------- servers

def start_dev_server(code, log_path):
    """like kopfkicker_e2e.start_server, with/without the developer code and info logging into a file"""
    tmp = Path(tempfile.mkdtemp(prefix="gr_dev_e2e_"))
    shutil.copytree(ROOT / "backend", tmp / "backend", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(ROOT / "static", tmp / "static")
    shutil.copy(ROOT / "config.json", tmp / "config.json")
    env = {k: v for k, v in os.environ.items() if not k.startswith("GOLDRUSH_DEV")}
    if code:
        env["GOLDRUSH_DEV_CODE"] = code
    port = free_port()
    log = open(log_path, "wb")
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", str(port), "--log-level", "info"],
                            cwd=tmp, stdout=log, stderr=subprocess.STDOUT, env=env)
    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            urllib.request.urlopen(base + "/", timeout=0.5)
            break
        except Exception:
            time.sleep(0.1)
    return proc, base, tmp, log


def http(base, path, method="GET", body=None, headers=None):
    req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        r = urllib.request.urlopen(req)
        return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


# ---------------------------------------------------------------- panel helpers

def ds(page):
    return G(page, f"() => {GR}.devState()")


def eco(page):
    return G(page, f"() => {GR}.economy()")


def proc(page):
    return G(page, f"() => {GR}.proc()")


def pause_menu(page):
    """desktop: the pause card (as after Esc)"""
    if not page.is_visible(".gr-pause"):
        if G(page, "() => !!document.pointerLockElement"):
            G(page, "() => document.exitPointerLock()")
        else:
            page.keyboard.press("Escape")
        page.wait_for_selector(".gr-pause:not([hidden])", timeout=5000)


def dev_entry(page, touch=False):
    """open 'Entwicklertools' (desktop: pause menu; touch: settings)"""
    if touch:
        page.tap(".gr-hud [data-act=settings]")
        page.wait_for_selector(".gr-panel:not([hidden])", timeout=5000)
        page.tap(".gr-panel [data-act=dev]")
    else:
        pause_menu(page)
        page.click(".gr-pause [data-act=dev]")
    page.wait_for_function("() => { const d = document.querySelector('.gr-dev'); return d && !d.hidden && (!document.querySelector('.gr-dev-modal').hidden || !d.classList.contains('is-locked')); }", timeout=10000)


def unlock(page, code, touch=False):
    page.wait_for_selector(".gr-dev-modal:not([hidden]) #gr-dev-code", timeout=5000)
    page.fill("#gr-dev-code", code)
    if touch:
        page.tap("[data-dev-modal=unlock]")
    else:
        page.keyboard.press("Enter")


def open_panel(page, touch=False):
    dev_entry(page, touch)
    if page.is_visible(".gr-dev-modal #gr-dev-code"):
        unlock(page, CODE, touch)
    page.wait_for_selector(".gr-dev:not(.is-locked) .gr-dev-card", timeout=8000)


def close_panel(page):
    page.click("[data-dev=close]")
    page.wait_for_function("() => document.querySelector('.gr-dev').hidden", timeout=5000)


def tab(page, cat, touch=False):
    (page.tap if touch else page.click)(f".gr-dev-tab[data-dev-cat={cat}]")
    page.wait_for_selector(f".gr-dev-tab[data-dev-cat={cat}][aria-selected=true]", timeout=3000)


def _clear_toast(page):
    G(page, "() => { const t = document.querySelector('[data-role=toast]'); if (t) t.textContent = ''; }")


def do(page, sel, confirm=None, touch=False, wait=True):
    """click a panel control, answer its question (confirm: 'ok' | 'cancel'), wait for the result line"""
    _clear_toast(page)
    (page.tap if touch else page.click)(sel)
    if confirm:
        page.wait_for_selector(".gr-dev-modal:not([hidden]) [data-dev-modal=ok]", timeout=5000)
        (page.tap if touch else page.click)(f"[data-dev-modal={confirm}]")
    if wait:
        wait_for(lambda: bool(G(page, "() => { const t = document.querySelector('[data-role=toast]'); return t && t.textContent; }")), 6)
    return G(page, "() => { const t = document.querySelector('[data-role=toast]'); return t ? { text: t.textContent, error: t.classList.contains('is-error') } : null; }")


def cmd(page, cid, **kw):
    return do(page, f"[data-dev-cmd='{cid}']", **kw)


def row(page, item, act, **kw):
    return do(page, f"[data-dev-row='equipment.items|{item}|{act}']", **kw)


def wait_ready(page):
    page.wait_for_function("() => window.__goldrush && window.__goldrush.state && document.querySelector('.gr-loading').hidden !== false", timeout=60000)
    wait_for(lambda: G(page, "() => !!(window.__goldrush && window.__goldrush.state())"), 30)


def fingerprint(page):
    return G(page, f"""() => {{ const g = {GR}, e = g.economy(), h = g.hashes(), p = g.proc();
      return {{ cash: e.cashCents, pouch: e.pouchSummary.totalGoldUg, tools: JSON.stringify(h.tools), height: h.height, slices: h.slices, rocks: h.rocks,
        digs: e.stats.totalDigs, equipment: JSON.stringify(p.owned), bucket: JSON.stringify(p.bucket && p.bucket.batch), tub: JSON.stringify(p.tub), ledger: JSON.stringify(p.ledger),
        flags: JSON.stringify(e.flags) }}; }}""")


# ======================================================================
# 1-6: server-side developer access
# ======================================================================

def access(browser, base, base_off, shots, tmp):
    # 1: not logged in -> no unlock (API) and no access object (UI module)
    s1, b1 = http(base, "/api/goldrush/dev/unlock", "POST", {"code": CODE})
    s2, _ = http(base, "/api/goldrush/dev/status")
    user = login(base, "DevAnna")
    ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
    guest = G(A, "async () => { const m = await import('/games/goldrush/goldrush-devaccess.js'); return new m.DevAccess(null, { id: 'guest' }).available; }")
    ok("1 not logged in: no developer unlock (401 without a session, no access for a guest)", s1 == 401 and s2 == 401 and guest is False and "token" not in b1, f"unlock {s1} status {s2} guest {guest}")

    open_game(A, start=False)
    loaded0 = G(A, "() => performance.getEntriesByType('resource').some((r) => /goldrush-dev(tools|commands|actions|hud|registry)\\.js/.test(r.name))")
    ok("a normal player never loads the developer tools (no module fetched, no per-frame hook)", not loaded0 and G(A, f"() => {GR}.devState().loaded === false && !{GR}.devState().devHook"))
    # 2: wrong code
    dev_entry(A)
    shot(A, shots, "access_dialog")
    unlock(A, "falsch-123")
    A.wait_for_function("() => document.querySelector('[data-role=m-error]').textContent.length > 0", timeout=6000)
    err = A.inner_text("[data-role=m-error]")
    st2 = http(base, "/api/goldrush/dev/status", headers={"X-Auth-Token": user["token"]})
    ok("2 wrong code: no access, one plain message ('Code nicht gültig.'), the panel stays closed",
       err.strip() == "Code nicht gültig." and A.is_visible(".gr-dev.is-locked") and not A.is_visible(".gr-dev-card") and '"unlocked":false' in st2[1].replace(" ", ""), err)
    shot(A, shots, "access_wrong")
    # 3: right code
    unlock(A, CODE)
    A.wait_for_selector(".gr-dev:not(.is-locked) .gr-dev-card", timeout=8000)
    d = ds(A)
    ok("3 right code: unlocked - the developer panel opens ('ENTWICKLERMODUS AKTIV')", d["open"] and d["unlocked"] and "ENTWICKLERMODUS AKTIV" in A.inner_text("[data-role=status]"), str({k: d[k] for k in ("open", "unlocked")}))
    shot(A, shots, "panel_desktop")
    # 4: the code is nowhere on the client side
    in_static = [str(p.relative_to(tmp)) for p in (tmp / "static").rglob("*") if p.is_file() and CODE.encode() in p.read_bytes()]
    fetched = []
    for path in ["/", "/app.js", "/games/goldrush/goldrush.js", "/games/goldrush/goldrush-devtools.js", "/games/goldrush/goldrush-devaccess.js", "/games/goldrush/goldrush-devcommands.js"]:
        s, body = http(base, path)
        if CODE in body:
            fetched.append(path)
    client_side = G(A, """(code) => { const all = [];
      for (const st of [localStorage, sessionStorage]) for (let i = 0; i < st.length; i++) all.push(st.key(i), st.getItem(st.key(i)));
      return { storage: all.some((v) => String(v).includes(code)), dom: document.documentElement.outerHTML.includes(code), input: document.querySelector('#gr-dev-code').value }; }""", CODE)
    console = [m for m in A.errors + A.warnings if CODE in m]
    ok("4 the code is not in the delivered frontend (static files, HTML, JS), not in the browser (storage, DOM, console)",
       not in_static and not fetched and not client_side["storage"] and not client_side["dom"] and client_side["input"] == "" and not console, f"{in_static} {fetched} {client_side} {console}")
    close_panel(A)
    label = A.inner_text(".gr-pause .gr-dev-open")
    ok("unlocked: the menu entry says 'Entwicklertools ✓' with a small DEV badge", label.strip() == "Entwicklertools ✓" and A.is_visible(".gr-pause [data-role=dev-badge]"), label)
    gr_close(A)
    ctx.close()

    # 5: a server without GOLDRUSH_DEV_CODE
    user_off = login(base_off, "DevOff")
    s5, b5 = http(base_off, "/api/goldrush/dev/unlock", "POST", {"code": CODE}, {"X-Auth-Token": user_off["token"]})
    ctx5, C = client(browser, base_off, user_off, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
    open_game(C, start=False)
    dev_entry(C)
    C.wait_for_selector(".gr-dev-modal:not([hidden])", timeout=6000)
    msg = C.inner_text(".gr-dev-modal [data-role=m-text]")
    no_input = not C.is_visible("#gr-dev-code")
    shot(C, shots, "not_configured")
    C.click("[data-dev-modal=ok]")
    ok("5 GOLDRUSH_DEV_CODE missing: unlock switched off ('Entwicklerzugang ist auf diesem Server nicht konfiguriert.', no code field, 503)",
       s5 == 503 and "nicht konfiguriert" in msg and no_input and "token" not in b5, f"{s5} {msg}")
    gr_close(C)
    ctx5.close()

    # 6: a new browser session asks for the code again
    ctx6, D = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}))
    open_game(D, start=False)
    dev_entry(D)
    asks = D.is_visible(".gr-dev-modal #gr-dev-code")
    label6 = D.inner_text(".gr-pause .gr-dev-open") if D.is_visible(".gr-pause") else ""
    D.click("[data-dev-modal=cancel]")
    ok("6 new browser session: the developer unlock is needed again (nothing kept but a session token in sessionStorage)", asks, label6)
    gr_close(D)
    ctx6.close()
    return user


# ======================================================================
# 7-12: snapshot, devModified, restore; 13-18 economy; 19-22 equipment
# ======================================================================

def snapshot_and_commands(browser, base, user, shots):
    ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
    gr_open(A)
    gr_ready(A, choice="new")
    gr_start(A)
    # a normal mine with some history: shovel bought, ground dug
    G(A, f"() => {{ {GR}.setCash(1100); {GR}.buy('shovel'); {GR}.equipNow('shovel'); }}")
    sp = dig_spot(A, 0.3)
    G(A, f"(s) => {{ {GR}.aimAt(s); for (let i = 0; i < 12; i++) {GR}.act({{ visuals: false }}); }}", sp)
    G(A, f"() => {{ {GR}.flushLoot(); {GR}.save(); }}")
    before = fingerprint(A)
    # 7: unlock -> snapshot of exactly this mine
    open_panel(A)
    d7 = ds(A)
    raw = json.loads(G(A, "(k) => localStorage.getItem(k)", G(A, "() => grKey('.devSnapshot')")))
    snap_cash = raw["doc"]["economy"]["cashCents"]
    ok("7 a normal mine + developer mode: a snapshot of exactly this mine is made (cash, ground, tools; not devModified)",
       d7["snapshot"] and snap_cash == before["cash"] and not d7["devModified"] and raw["doc"]["worldSeed"] == G(A, f"() => {GR}.state().seed") and "devModified" not in raw["doc"]
       and "Vor dem ersten Cheat wurde eine Sicherung deiner Mine erstellt." in A.inner_text("[data-role=status]"), f"snapshot cash {snap_cash} vs {before['cash']}")
    # 8: + € 1000 -> the save changes, the snapshot does not
    snap_at = d7["snapshot"]["at"]
    tab(A, "economy")
    cmd(A, "economy.add100000")
    saved = json.loads(G(A, "() => localStorage.getItem(grKey())"))
    d8 = ds(A)
    ok("8 + € 1.000: the mine is saved with it (devModified), the snapshot stays as it was",
       saved["economy"]["cashCents"] == before["cash"] + 100000 and saved.get("devModified") is True and d8["snapshot"]["at"] >= snap_at and d8["snapshot"]["cash"] == before["cash"],
       f"saved {saved['economy']['cashCents']} snapshot {d8['snapshot']['cash']}")
    # 13-17: cash commands, exactly
    c0 = eco(A)["cashCents"]
    for name, sel, add in (("13 + € 1", "economy.add100", 100), ("14 + € 10", "economy.add1000", 1000), ("15 + € 100", "economy.add10000", 10000), ("16 + € 1.000", "economy.add100000", 100000)):
        cmd(A, sel)
        c1 = eco(A)["cashCents"]
        ok(f"{name}: exactly {add} ct more (integer cents, HUD shows it)", c1 == c0 + add and A.inner_text(".gr-money").strip().startswith("€"), f"{c0} -> {c1}")
        c0 = c1
    sets = []
    for text, want in (("250", 25000), ("12,50", 1250), ("1.000", 100000), ("0", 0)):
        A.fill("[data-dev-form='economy.set'] input", text)
        do(A, "[data-dev-form='economy.set'] button")
        sets.append((text, eco(A)["cashCents"], want))
    ok("17 'Cash setzen': € 250 / 12,50 / 1.000 / 0 are set to the cent", all(got == want for _, got, want in sets), str(sets))
    G(A, f"() => {GR}.setCash(4321)")
    bad = []
    for text in ("abc", "-5", "NaN", "Infinity", "1e9", "99999999", "1,234", "", "5000000"):
        A.fill("[data-dev-form='economy.set'] input", text)
        t = do(A, "[data-dev-form='economy.set'] button")
        bad.append((text, t and t["error"], eco(A)["cashCents"]))
    ok("18 invalid cash input (text, negative, NaN, Infinity, 1e9, > € 1.000.000, 3 decimals, empty): refused, cash unchanged",
       all(e and c == 4321 for _, e, c in bad), str(bad))
    # 29: gold pouch test items (real pouch entries, they sell)
    p0 = eco(A)["pouch"]
    for k in ("fine", "flake", "tiny", "nugget"):
        cmd(A, f"pouch.{k}")
    p1 = eco(A)
    classes = {c: p1["pouch"][c]["count"] - p0[c]["count"] for c in ("fineGold", "goldFlake", "tinyGoldPiece", "smallNugget")}
    worth = p1["pouchSummary"]["estimatedSaleCents"]
    cash_before = p1["cashCents"]
    sale = G(A, f"() => {GR}.sell()")
    cash_after = eco(A)["cashCents"]
    cmd(A, "pouch.fine")
    cmd(A, "pouch.empty")
    ok("29 gold pouch test items: fine gold, flake, tiny piece, nugget land in their classes, sell at the camp price; 'Goldbeutel leeren' empties it",
       all(v == 1 for v in classes.values()) and sale["ok"] and cash_after == cash_before + worth and eco(A)["pouchSummary"]["totalGoldUg"] == 0, f"{classes} worth {worth}")
    # 9 / 19-22: equipment
    tab(A, "equipment")
    cmd(A, "equipment.reset", confirm="ok")
    t0 = G(A, f"() => {GR}.tools().owned")
    row(A, "shovel", "give")
    d19 = ds(A)
    ok("19 'Besitz geben' shovel: owned, in the belt, the shop says OWNED", "shovel" in G(A, f"() => {GR}.tools().owned") and "shovel" in d19["models"]["slots"]
       and next(r for r in G(A, f"() => {GR}.devRows()") if r["id"] == "shovel")["status"] == "owned" and t0 == ["hand"], str(d19["models"]["slots"]))
    cmd(A, "equipment.reset", confirm="ok")
    row(A, "pickaxe", "give")
    tools20 = G(A, f"() => {GR}.tools().owned")
    ok("20 pickaxe from a bare hand: it comes with what it needs (shovel, 'stone seen') - consistent, usable", tools20 == ["hand", "shovel", "pickaxe"] and eco(A)["flags"]["hardSeen"] and "pickaxe" in ds(A)["models"]["slots"], str(tools20))
    for it in ("bucket", "pan", "classifier"):
        if next(r for r in G(A, f"() => {GR}.devRows()") if r["id"] == it)["status"] != "owned":
            row(A, it, "give")
    d21 = ds(A)
    ok("21 processing equipment: bucket, gold pan, classifier owned AND on the claim (models visible), shop OWNED",
       proc(A)["owned"] == ["bucket", "pan", "classifier"] and d21["models"]["bucket"] and d21["models"]["pan"] and d21["models"]["classifier"], str(d21["models"]))
    cmd(A, "equipment.all")
    rows = G(A, f"() => {GR}.devRows()")
    shop = G(A, f"() => {GR}.shopView()")
    d22 = ds(A)
    ok("9 / 22 'Alle aktuellen Items geben': every item of the shop registry owned - tools usable, upgrades built in (riffles, large bucket), shop all OWNED",
       all(r["status"] == "owned" for r in rows) and len(rows) == len(shop["items"]) >= len(PHASE5_ITEMS) and all(i["state"] == "owned" for i in shop["items"])
       and d22["models"]["riffles"] and d22["models"]["bucketScale"] > 1 and proc(A)["capacityMl"] == 14000 and sorted(d22["models"]["slots"]) == ["hand", "pickaxe", "shovel"],
       f"{[r['id'] for r in rows if r['status'] != 'owned']} {d22['models']}")
    shot(A, shots, "panel_equipment")
    # 23-28: material
    tab(A, "material")
    cap = proc(A)["capacityMl"]
    vols = []
    for pct in (0, 25, 50, 100):
        cmd(A, f"material.bucket{pct}")
        vols.append(proc(A)["bucket"]["batch"]["volumeMl"])
    ok("23-26 bucket empty / 25 % / 50 % / full: exactly that share of its capacity", vols == [0, round(cap * 0.25), round(cap * 0.5), cap], f"{vols} of {cap}")
    do(A, "[data-dev-choice='material.kind|gravel']", wait=False)
    cmd(A, "material.bucket50")
    gb = proc(A)["bucket"]["batch"]
    ok("material type: 'Kies' fills gravel only (MaterialBatch masses by density)", gb["comp"][2] > 0 and gb["comp"][0] == gb["comp"][1] == gb["comp"][3] == 0 and gb["source"] == "dev", str(gb["comp"]))
    cmd(A, "material.paydirt")
    pb = proc(A)["bucket"]
    L = proc(A)["ledger"]
    pieces = max(1, round(3 * cap / 10000)) + (1 if cap >= 5000 else 0) + (1 if cap >= 9500 else 0)
    ok("27 'Goldhaltiges Testmaterial': a full, deterministic batch marked 'dev' (fine gold + pieces), booked in the ledger as test input",
       pb["batch"]["volumeMl"] == cap and pb["batch"]["source"] == "dev" and pb["batch"]["fineUg"] == cap * 25 and len(pb["batch"]["finds"]) == pieces and L.get("devInUg", 0) >= pb["goldUg"],
       f"{pb['batch']['fineUg']} ug, {len(pb['batch']['finds'])} pieces, devIn {L.get('devInUg')}")
    cmd(A, "material.concentrate")
    pan = proc(A)["pan"]
    ok("28 'Konzentrat-Testladung': 2,5 l concentrate straight into the pan", pan["volumeMl"] == 2500 and pan["stage"] == "concentrate" and pan["fineUg"] == 100000, f"{pan['volumeMl']} {pan['stage']}")
    shot(A, shots, "panel_material")
    cmd(A, "material.bucketWash")
    # 30 / 31: the real pan and classifier take dev material (at the wash place)
    tab(A, "world")
    cmd(A, "world.tp.wash")
    close_panel(A)
    pouch0 = eco(A)["pouchSummary"]["totalGoldUg"]
    w = G(A, f"() => {{ const r = {GR}.useStation(); return {{ r, work: {GR}.proc().work }}; }}")
    work = G(A, f"() => {GR}.procWork(30)")
    got = G(A, f"() => {GR}.procCollect()")
    p30 = proc(A)
    ok("30 the gold pan takes the dev load: worked at the trough, gold into the pouch (63 % x riffles of the fine gold + every piece), ledger exact",
       w["work"] == "pan" and work["done"] and got["ok"] and got["fineUg"] == int(100000 * 0.63 * 1.12) and eco(A)["pouchSummary"]["totalGoldUg"] > pouch0
       and p30["ledger"]["inUg"] == p30["inContainersUg"] + p30["ledger"]["recoveredUg"] + p30["ledger"]["tailUg"], f"{got}")
    G(A, f"() => {GR}.pose({{ x: -15.9, z: 4.8, yaw: Math.PI / 2, pitch: -0.6 }})")
    s31 = G(A, f"() => {GR}.procAct('sieve-load')")
    G(A, f"() => {GR}.procWork(30)")
    p31 = proc(A)
    ok("31 the classifier takes the dev bucket: sieved, concentrate in the tub, stones to the tailings, ledger exact (gold + mass)",
       s31["ok"] and p31["tub"]["volumeMl"] > 0 and p31["ledger"]["inUg"] == p31["inContainersUg"] + p31["ledger"]["recoveredUg"] + p31["ledger"]["tailUg"]
       and p31["ledger"]["inG"] == p31["inContainersG"] + p31["ledger"]["tailG"], f"tub {p31['tub']['volumeMl']} ml")
    # 12: a dev-modified mine reloads as it is
    open_panel(A)
    tab(A, "save")
    fp = fingerprint(A)
    cmd(A, "save.reload", wait=False)
    wait_for(lambda: G(A, f"() => !!(window.__goldrush && {GR}.state && {GR}.state().seed)"), 60)
    gr_start(A)
    fp2 = fingerprint(A)
    ok("12 a dev-modified mine reloads exactly as it was (cash, items, ground, processing), still devModified",
       fp2 == fp and ds(A)["devModified"], str({k: (fp[k], fp2[k]) for k in fp if fp[k] != fp2[k]})[:300])
    # 10: restore the snapshot - exactly the mine from before the first command
    open_panel(A)
    shot(A, shots, "panel_status_modified")
    A.click("[data-dev=restore]")
    A.wait_for_selector(".gr-dev-modal:not([hidden]) [data-dev-modal=ok]", timeout=5000)
    q = A.inner_text(".gr-dev-modal [data-role=m-text]")
    shot(A, shots, "restore_question")
    A.click("[data-dev-modal=ok]")
    wait_for(lambda: G(A, f"() => !!(window.__goldrush && {GR}.state && {GR}.state().seed)"), 60)
    gr_start(A)
    after = fingerprint(A)
    diff = {k: (before[k], after[k]) for k in before if before[k] != after[k]}
    ok("10 'Mine vor Entwicklertest wiederherstellen' (question: 'Alle Änderungen seit Aktivierung des Entwicklermodus werden verworfen.'): exactly the old cash, items, ground, processing, stats - not devModified",
       not diff and q.strip() == "Alle Änderungen seit Aktivierung des Entwicklermodus werden verworfen." and not ds(A)["devModified"], str(diff)[:300])
    errs = [e for e in errors(A) if "403" not in e]
    ok("snapshot / commands part ran without page errors", not errs, str(errs[:3]))
    gr_close(A)
    ctx.close()


# ======================================================================
# 33-37 teleports, debug views, save tools, accessibility
# ======================================================================

def world_and_tools(browser, base, user, shots):
    ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}))
    open_game(A, start=False)
    open_panel(A)
    tab(A, "quick")
    cmd(A, "quick.phase5")
    tab(A, "world")
    res = {}
    for tid in ("spawn", "supply", "assay", "wash", "mound"):
        cmd(A, f"world.tp.{tid}")
        st = G(A, f"() => ({{ pos: {GR}.positionCheck(), station: {GR}.uiState().near, inter: {GR}.proc().interaction, aim: {GR}.aim().state, v: {GR}.state() }})")
        res[tid] = st
    good = all(r["pos"]["ok"] for r in res.values())
    ok("33 teleport spawn: a valid standing point (inside the claim, on the ground, nothing overlapping, standing still)", res["spawn"]["pos"]["ok"] and abs(res["spawn"]["pos"]["x"] - 0.6) < 0.01, str(res["spawn"]["pos"]))
    ok("34 teleport shop: in front of the supply counter (its prompt is there)", res["supply"]["pos"]["ok"] and res["supply"]["station"] == "supply", str(res["supply"]["station"]))
    ok("35 teleport gold buyer: in front of the assay table", res["assay"]["pos"]["ok"] and res["assay"]["station"] == "assay", str(res["assay"]["station"]))
    ok("36 teleport wash place: at the trough, the pan is there to use", res["wash"]["pos"]["ok"] and (res["wash"]["inter"] or {}).get("id", "").startswith("pan"), str(res["wash"]["inter"]))
    ok("37 teleport mining area: at the mound, a diggable face in reach - no position is invalid", res["mound"]["pos"]["ok"] and res["mound"]["aim"] == "dig" and good, str(res["mound"]["pos"]))
    # debug views: only while switched on (at the wash place: containers in view)
    cmd(A, "world.tp.wash")
    hook0 = ds(A)["devHook"]
    tab(A, "diag")
    for t in ("debug.perf", "debug.material", "debug.interaction"):
        A.click(f"[data-dev-toggle='{t}']")
    tab(A, "world")
    A.click("[data-dev-toggle='debug.resource']")
    A.click("[data-dev-toggle='debug.terrain']")
    close_panel(A)
    gr_start(A)
    time.sleep(1.0)
    hud = A.inner_text(".gr-devhud")
    d_on = ds(A)
    shot(A, shots, "debug_overlays")
    pause_menu(A)
    open_panel(A)
    tab(A, "diag")
    for t in ("debug.perf", "debug.material", "debug.interaction"):
        A.click(f"[data-dev-toggle='{t}']")
    tab(A, "world")
    A.click("[data-dev-toggle='debug.resource']")
    A.click("[data-dev-toggle='debug.terrain']")
    d_off = ds(A)
    ok("debug views (resource heatmap, material, terrain, interaction, performance HUD): off by default, drawn only while on, gone when off",
       not hook0 and d_on["devHook"] and d_on["heatmap"] and all(k in hud for k in ("PERFORMANCE", "MATERIAL", "TERRAIN", "INTERACTION", "RESOURCE", "Draw Calls", "Feingold"))
       and not d_off["devHook"] and not d_off["heatmap"] and not A.is_visible(".gr-devhud"), hud[:200])
    # save tools
    tab(A, "save")
    info = dict(zip(A.locator(".gr-dev-info dt").all_inner_texts(), A.locator(".gr-dev-info dd").all_inner_texts()))
    ok("save info: version, user id, seed, play time, cash, pouch, moved mass, items, size, devModified - no token / password / secret",
       all(k in info for k in ("Save-Version", "User-ID", "World Seed", "Spielzeit", "Kontostand", "Goldbeutel", "Bewegte Masse", "Items", "Save-Größe", "devModified"))
       and info["Save-Version"] == str(CURRENT_SAVE) and info["User-ID"] == str(user["user"]["id"]) and user["token"] not in A.inner_text(".gr-dev-body") and CODE not in A.inner_text(".gr-dev-body"), str(info)[:300])
    with A.expect_download() as dl:
        A.click("[data-dev-cmd='save.export']")
    path = dl.value.path()
    exported = json.loads(Path(path).read_text(encoding="utf-8"))
    ok("save export: a JSON file of this mine (valid current-version document, no token inside)", exported["saveVersion"] == CURRENT_SAVE and exported["devModified"] is True and user["token"] not in Path(path).read_text(encoding="utf-8"), dl.value.suggested_filename)
    # import: a broken file is refused, the mine untouched
    fp = fingerprint(A)
    bad = Path(tempfile.mkdtemp()) / "broken.json"
    bad.write_text('{"saveVersion": 5, "worldSeed": "x"}', encoding="utf-8")
    _clear_toast(A)
    with A.expect_file_chooser() as fc:
        A.click("[data-dev-file='save.import']")
    fc.value.set_files(str(bad))
    wait_for(lambda: bool(G(A, "() => document.querySelector('[data-role=toast]').textContent")), 5)
    t_bad = G(A, "() => document.querySelector('[data-role=toast]').textContent")
    ok("save import: an invalid file is refused with a message - the mine is unchanged", "kein gültiger" in t_bad and fingerprint(A) == fp, t_bad)
    # accessibility: Tab stays in the panel, Esc closes a question first, then the panel
    focus_in = []
    for _ in range(40):
        A.keyboard.press("Tab")
        focus_in.append(G(A, "() => !!document.activeElement.closest('.gr-dev-card')"))
    tab(A, "equipment")
    A.click("[data-dev-cmd='equipment.reset']")
    A.wait_for_selector(".gr-dev-modal:not([hidden])", timeout=4000)
    A.keyboard.press("Escape")
    q_closed = G(A, "() => document.querySelector('.gr-dev-modal').hidden")
    still = ds(A)["open"]
    A.keyboard.press("Escape")
    time.sleep(0.2)
    ok("keyboard: Tab stays inside the panel (focus trap), Esc closes the question first, then the panel; the question changed nothing",
       all(focus_in) and q_closed and still and not ds(A)["active"] and len(G(A, f"() => {GR}.tools().owned")) == 3, f"{sum(focus_in)}/{len(focus_in)}")
    errs = [e for e in errors(A) if "403" not in e]
    ok("world / tools part ran without page errors", not errs, str(errs[:3]))
    gr_close(A)
    ctx.close()


# ======================================================================
# 38-42: users and new mine; 32: a normal mine is untouched
# ======================================================================

def users_and_new_mine(browser, base, shots):
    ctx, U = bare_context(browser, base)
    U.evaluate("() => localStorage.setItem('goldrush.testSeed', '4242')")
    a = ui_login(U, "DevAnton")
    start_screen(U)
    U.click(".gr-start [data-act=start-new]")
    gr_ready(U, choice=None)
    open_panel(U)
    tab(U, "quick")
    cmd(U, "quick.all")
    tab(U, "economy")
    cmd(U, "economy.add100000")
    close_panel(U)
    keyA = G(U, "() => grKey()")
    gr_close(U)
    rawA, snapA = G(U, "(k) => [localStorage.getItem(k), localStorage.getItem(k + '.devSnapshot')]", keyA)
    createdA = json.loads(snapA)["doc"]["createdAt"]
    ui_logout(U)
    b = ui_login(U, "DevBerta")
    s = start_screen(U)
    U.click(".gr-start [data-act=start-new]")
    gr_ready(U, choice=None)
    eb = eco(U)
    ok("38 user A used developer mode -> user B on the same browser: no snapshot of A, none of A's cash or items",
       not s["cont"] and eb["cashCents"] == 0 and G(U, f"() => {GR}.tools().owned") == ["hand"] and G(U, f"() => {GR}.devState().snapshot") is None
       and G(U, "() => grKey('.devSnapshot')") != keyA + ".devSnapshot", f"B cash {eb['cashCents']}")
    open_panel(U)                                   # B unlocks on its own account
    tab(U, "economy")
    cmd(U, "economy.add1000")
    close_panel(U)
    snapB = G(U, "() => localStorage.getItem(grKey('.devSnapshot'))")
    rawA2, snapA2 = G(U, "(k) => [localStorage.getItem(k), localStorage.getItem(k + '.devSnapshot')]", keyA)
    ok("39 user B's developer snapshot / cheats: A's mine and A's snapshot stay byte for byte the same", snapB and rawA2 == rawA and snapA2 == snapA and json.loads(snapB)["doc"]["owner"]["tag"] != json.loads(snapA)["doc"]["owner"]["tag"])
    gr_close(U)
    ui_logout(U)
    ui_login(U, "DevAnton")
    # 11: A's restore can only ever bring back A's mine; the keys of the browser
    start_screen(U)
    tag = U.is_visible("[data-role=start-dev]")
    shot(U, shots, "start_dev_modified")
    U.click(".gr-start [data-act=start-continue]")
    gr_ready(U, choice=None)
    snap_created = G(U, f"() => {GR}.devState().snapshot && {GR}.devState().snapshot.createdAt")
    keys = G(U, "() => Object.keys(localStorage).filter((k) => k.startsWith('goldrush.save'))")
    import re
    ok("11 a restore only reaches the player's own snapshot (A sees A's, never B's); keys hold ids only",
       snap_created == createdA and all(re.match(r"^goldrush\.save\.(u\d+(\.(backup|prev|corrupt|devSnapshot))?|orphan\.[0-9a-f]{8})$", k) for k in keys), str(keys))
    ok("the start screen marks a test mine: 'DEV-MODIFIED' next to 'Deine Mine'", tag)
    # 42 prep: a device setting
    G(U, f"() => {GR}.setQuality('low')")
    # 40: new mine from a dev-modified mine
    if not U.is_visible(".gr-panel"):
        pause_menu(U)
        U.click(".gr-pause [data-act=settings]")
    U.click(".gr-panel [data-act=new-mine]")
    U.wait_for_selector(".gr-dialog:not([hidden]) [data-act='dlg:new']", timeout=5000)
    U.click(".gr-dialog [data-act='dlg:new']")
    wait_for(lambda: G(U, f"() => !!(window.__goldrush && {GR}.state && {GR}.state().seed)"), 60)
    e40 = eco(U)
    d40 = G(U, f"() => {GR}.devState()")
    saved = json.loads(G(U, "() => localStorage.getItem(grKey())"))
    ok("40 'Neue Mine' from a dev-modified mine: a clean new mine (no devModified, no dev snapshot, € 0, only the hand)",
       e40["cashCents"] == 0 and not d40["devModified"] and d40["snapshot"] is None and "devModified" not in saved and G(U, f"() => {GR}.tools().owned") == ["hand"]
       and G(U, "() => localStorage.getItem(grKey('.devSnapshot'))") is None, f"{e40['cashCents']} {d40['devModified']}")
    ok("42 the device settings survive the new mine (quality)", G(U, f"() => {GR}.state().quality") == "low")
    # 32: a normal mine - digging, bucket, pan exactly as in phase 5, no dev input anywhere
    gr_start(U)
    kit(U)
    sp = dig_spot(U, 0.3)
    bucket_here(U, sp)
    fill_bucket(U, sp, ml=3000)
    G(U, f"() => {GR}.procBucketToWash()")
    G(U, f"() => {GR}.pose({{ x: -16.12, z: 2.0, yaw: Math.PI / 2, pitch: -0.5 }})")
    G(U, f"() => {{ {GR}.procAct('pan-fill'); {GR}.procWork(30); {GR}.procCollect(); }}")
    p = proc(U)
    ok("32 a normal mine keeps phase-5 conservation exactly (no test input in its ledger)",
       "devInUg" not in p["ledger"] and p["ledger"]["inUg"] == p["inContainersUg"] + p["ledger"]["recoveredUg"] + p["ledger"]["tailUg"] and p["ledger"]["panLoads"] == 1, str(p["ledger"])[:200])
    gr_close(U)
    # 41: continue as normal
    s41 = start_screen(U)
    U.click(".gr-start [data-act=start-continue]")
    gr_ready(U, choice=None)
    ok("41 'Fortsetzen' continues the new mine normally (not marked)", s41["cont"] and not U.is_visible("[data-role=start-dev]") and not ds(U)["devModified"] and proc(U)["ledger"]["panLoads"] == 1)
    errs = [e for e in errors(U) if "403" not in e and "WebSocket" not in e]
    ok("users / new-mine part ran without page errors", not errs, str(errs[:3]))
    gr_close(U)
    ctx.close()


# ======================================================================
# 43-48: phones
# ======================================================================

def layout(page):
    return G(page, """() => { const c = document.querySelector('.gr-dev-card').getBoundingClientRect(), s = document.querySelector('.gr-dev-scroll');
      const btns = [...document.querySelectorAll('.gr-dev-card button')].filter((b) => b.offsetParent).map((b) => b.getBoundingClientRect().height);
      return { inside: c.left >= -1 && c.right <= innerWidth + 1 && c.top >= -1 && c.bottom <= innerHeight + 1, hover: document.documentElement.scrollWidth <= innerWidth + 1,
        noX: s.scrollWidth <= s.clientWidth + 1, minH: Math.min(...btns), w: Math.round(c.width), h: Math.round(c.height), scrolls: s.scrollHeight > s.clientHeight }; }""")


def mobile(browser, base, user, shots):
    for name, vp in (("portrait", PHONE), ("landscape", LAND)):
        ctx, M = client(browser, base, user, dict(vp))
        open_game(M)
        open_panel(M, touch=True)
        L = layout(M)
        shot(M, shots, f"mobile_panel_{name}")
        ok(f"{'43' if name == 'portrait' else '44'} phone {name}: the panel fits the screen (sheet), no horizontal overflow, 44 px targets", L["inside"] and L["noX"] and L["hover"] and L["minH"] >= 44, str(L))
        if name == "portrait":
            tab(M, "material", touch=True)
            moved = G(M, "() => { const s = document.querySelector('.gr-dev-scroll'); s.scrollTop = 400; return s.scrollTop; }")
            ok("45 phone: the panel scrolls (long categories reachable)", moved > 0 and layout(M)["scrolls"], f"scrollTop {moved}")
            tab(M, "equipment", touch=True)
            M.tap("[data-dev-cmd='equipment.reset']")
            M.wait_for_selector(".gr-dev-modal:not([hidden])", timeout=4000)
            box = G(M, "() => { const c = document.querySelector('.gr-dev-modal-card').getBoundingClientRect(); return { inside: c.left >= 0 && c.right <= innerWidth && c.top >= 0 && c.bottom <= innerHeight, minH: Math.min(...[...document.querySelectorAll('.gr-dev-modal-card button')].map((b) => b.getBoundingClientRect().height)) }; }")
            shot(M, shots, "mobile_question")
            M.tap("[data-dev-modal=cancel]")
            ok("46 phone: questions sit inside the screen with 44 px buttons; 'Abbrechen' changes nothing", box["inside"] and box["minH"] >= 44 and G(M, "() => document.querySelector('.gr-dev-modal').hidden"), str(box))
            tab(M, "economy", touch=True)
            M.tap("[data-dev-form='economy.set'] input")
            M.fill("[data-dev-form='economy.set'] input", "75,50")
            fs = G(M, "() => parseFloat(getComputedStyle(document.querySelector('[data-dev-form=\\'economy.set\\'] input')).fontSize)")
            do(M, "[data-dev-form='economy.set'] button", touch=True)
            ok("47 phone: own cash input (decimal keyboard, 16 px - no zoom) sets € 75,50", eco(M)["cashCents"] == 7550 and fs >= 16, f"font {fs}")
            tab(M, "world", touch=True)
            cmd(M, "world.tp.wash", touch=True)
            pos = G(M, f"() => {GR}.positionCheck()")
            M.tap("[data-dev=close]")
            M.wait_for_function("() => document.querySelector('.gr-dev').hidden", timeout=4000)
            M.wait_for_selector(".gr-panel:not([hidden])", timeout=4000)
            M.tap(".gr-panel [data-act=close-settings]")
            time.sleep(0.4)
            st = G(M, f"() => {GR}.state()")
            ctrl = G(M, "() => ({ stick: getComputedStyle(document.querySelector('.gr-stick')).display !== 'none', dig: getComputedStyle(document.querySelector('.gr-dig-btn')).display !== 'none' })")
            shot(M, shots, "mobile_after_teleport")
            ok("48 phone: teleport (wash place) to a valid spot, back in the game: running, controls there", pos["ok"] and st["running"] and not st["paused"] and ctrl["stick"] and ctrl["dig"], f"{pos['ok']} {st['running']} {ctrl}")
        if M.is_visible(".gr-dev-card"):
            M.tap("[data-dev=close]")
            M.wait_for_function("() => document.querySelector('.gr-dev').hidden", timeout=4000)
        errs = [e for e in errors(M) if "403" not in e]
        ok(f"phone {name}: no page errors", not errs, str(errs[:3]))
        gr_close(M)
        ctx.close()


# ======================================================================

# ======================================================================
# PROD (Prompt 10, section 0): the live path - no test hooks at all
# ======================================================================

def production_path(p, base, shots):
    """GoldRush's developer tools the way a tester on the live server gets there: a browser that does not
    announce automation (navigator.webdriver false -> the game exposes no test hooks), only clicks in the real
    UI - games library -> GoldRush -> Neue Mine -> pause -> Entwicklertools -> code -> panel -> Cash / Items /
    Presets - checked on what the screen shows"""
    b = p.chromium.launch(args=GPU_ARGS + ["--disable-blink-features=AutomationControlled"])
    user = login(base, "DevLive")
    ctx = b.new_context(viewport={"width": 1366, "height": 768})
    ctx.add_init_script(f"localStorage.setItem('instachat_token', {json.dumps(user['token'])});"
                        f"localStorage.setItem('instachat_user', {json.dumps(json.dumps(user['user']))});")
    P = ctx.new_page()
    errs = []
    P.on("pageerror", lambda e: errs.append(str(e)))
    P.goto(base + "/")
    P.wait_for_function("() => typeof ws !== 'undefined' && ws && ws.readyState === 1", timeout=15000)
    gr_open(P, via_library=True)
    P.wait_for_selector(".gr-start:not([hidden]) [data-act=start-new]", timeout=60000)
    P.click(".gr-start [data-act=start-new]")
    P.wait_for_selector(".gr-hud:not([hidden])", timeout=60000)
    P.wait_for_function("() => document.querySelector('.gr-loading').hidden", timeout=60000)
    env = P.evaluate("() => ({ webdriver: navigator.webdriver, hooks: typeof window.__goldrush })")
    # the pause card (desktop: the game waits for a click - that IS the pause menu with the entry)
    if not P.is_visible(".gr-pause"):
        P.click(".gr-hud [data-act=settings]")
    entry = ".gr-pause [data-act=dev]" if P.is_visible(".gr-pause [data-act=dev]") else ".gr-panel [data-act=dev]"
    P.wait_for_selector(entry, timeout=8000)
    P.click(entry)
    P.wait_for_selector(".gr-dev-modal:not([hidden]) #gr-dev-code", timeout=10000)
    diag = P.inner_text(".gr-dev-modal [data-role=m-text]")
    if shots:
        P.screenshot(path=str(shots / "gr55_prod_diagnosis.png"))
    P.fill("#gr-dev-code", "falsch-123")
    P.keyboard.press("Enter")
    P.wait_for_function("() => document.querySelector('[data-role=m-error]').textContent.length > 0", timeout=8000)
    P.wait_for_function("() => /Fehlversuche: 1 von/.test(document.querySelector('.gr-dev-modal [data-role=m-text]').textContent)", timeout=8000)
    after_wrong = P.inner_text(".gr-dev-modal [data-role=m-text]")
    if shots:
        P.screenshot(path=str(shots / "gr55_prod_wrong.png"))
    P.check("[data-role=m-show]")
    shown = P.evaluate("() => document.querySelector('#gr-dev-code').type")
    P.fill("#gr-dev-code", CODE)
    P.keyboard.press("Enter")
    P.wait_for_selector(".gr-dev:not(.is-locked) .gr-dev-card", timeout=10000)

    def act(sel, confirm=False):
        P.evaluate("() => { const t = document.querySelector('[data-role=toast]'); if (t) t.textContent = ''; }")
        P.click(sel)
        if confirm:
            try:
                P.wait_for_selector(".gr-dev-modal:not([hidden]) [data-dev-modal=ok]", timeout=2500)
                P.click("[data-dev-modal=ok]")
            except Exception:
                pass
        P.wait_for_function("() => { const t = document.querySelector('[data-role=toast]'); return t && t.textContent.length > 0; }", timeout=15000)
        return P.inner_text("[data-role=toast]")

    def tab_(cat):
        P.click(f".gr-dev-tab[data-dev-cat={cat}]")
        P.wait_for_selector(f".gr-dev-tab[data-dev-cat={cat}][aria-selected=true]", timeout=4000)

    tab_("economy")
    cash = act("[data-dev-cmd='economy.add100000']")
    tab_("equipment")
    item = act("[data-dev-row='equipment.items|shovel|give']")
    tab_("quick")
    preset = act("[data-dev-cmd='quick.phase9']", confirm=True)
    if shots:
        P.screenshot(path=str(shots / "gr55_prod_panel.png"))
    P.click("[data-dev=close]")
    P.wait_for_function("() => document.querySelector('.gr-dev').hidden", timeout=8000)
    money = P.inner_text(".gr-money")
    ok("PROD no test hooks on this path (navigator.webdriver false, no window.__goldrush): only the real UI", env["webdriver"] is False and env["hooks"] == "undefined", str(env))
    ok("PROD the code dialog explains itself in one screenshot: account, page, server, code source, account list, attempts, versions, next step",
       all(s in diag for s in ("DIAGNOSE", "Angemeldet als DevLive", "Seite geöffnet über:", "Antwortender Server:", "Code auf dem Server: Umgebungsvariable GOLDRUSH_DEV_CODE",
                               "Kontoliste GOLDRUSH_DEV_USER_IDS", "Fehlversuche: 0 von 6", "Version: Client v4 = Server v4", "→ Nächster Schritt: Code eingeben")), diag[:400])
    ok("PROD a wrong code: 'Code nicht gültig.' and the checklist counts the attempt (Fehlversuche: 1 von 6) - 'Code anzeigen' shows what was typed",
       "Fehlversuche: 1 von 6" in after_wrong and "Groß-/Kleinschreibung" in after_wrong and shown == "text", after_wrong[-200:])
    ok("PROD Pause -> Entwicklertools -> code -> panel -> Cash (+ € 1.000) -> Items (Schaufel) -> Preset PHASE 9 - all through the real UI",
       "1.000,00" in cash and item and preset and money.strip() not in ("", "€ 0,00"), f"cash {cash!r} item {item!r} preset {preset[:60]!r} HUD {money!r}")
    ok("PROD no page errors on the live path", not errs, str(errs[:3]))
    ctx.close()
    b.close()


def main():
    shots = None
    if "--shots" in sys.argv:
        shots = Path(sys.argv[sys.argv.index("--shots") + 1])
        shots.mkdir(parents=True, exist_ok=True)
    engine = sys.argv[sys.argv.index("--browser") + 1] if "--browser" in sys.argv else "chromium"
    logdir = Path(tempfile.mkdtemp(prefix="gr_dev_logs_"))
    on, base, tmp, log_on = start_dev_server(CODE, logdir / "server_on.log")
    off, base_off, tmp_off, log_off = start_dev_server(None, logdir / "server_off.log")
    try:
        with sync_playwright() as p:
            browser = getattr(p, engine).launch(args=GPU_ARGS if engine == "chromium" else [])
            user = access(browser, base, base_off, shots, tmp)
            snapshot_and_commands(browser, base, user, shots)
            world_and_tools(browser, base, user, shots)
            users_and_new_mine(browser, base, shots)
            if engine == "chromium":
                mobile(browser, base, login(base, "DevMobil"), shots)
            browser.close()
            if engine == "chromium":
                production_path(p, base, shots)
    finally:
        on.terminate()
        off.terminate()
        on.wait(10)
        off.wait(10)
        log_on.close()
        log_off.close()
    logs = (logdir / "server_on.log").read_text(encoding="utf-8", errors="replace") + (logdir / "server_off.log").read_text(encoding="utf-8", errors="replace")
    ok("4b the server log has every developer request (info level) but never the code", "/api/goldrush/dev/unlock" in logs and CODE not in logs, f"{len(logs)} chars")
    fails = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(fails)}/{len(RESULTS)} checks passed")
    for f in fails:
        print("FAILED:", f[0], f[2][:300])
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
