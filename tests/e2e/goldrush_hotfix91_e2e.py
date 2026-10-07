"""End-to-end check of GoldRush 9.1: the gold abundance audit and the prospecting reset.

  geology   geology 3 (the 9.1 calibration): a new mine records it, a geology-2 mine follows it silently
            (used slices stay used, containers keep their gold, no notice); the mountain is ordinary ground
            (upper and lower flanks ~ the neutral claim), the camp's fill still next to barren, the
            paleochannels still 2-4 x the claim, no gold peak at the old ground level; the camp's fill is
            told once when you dig into it (and remembered)
  prospect  ONE numbering: a flag set at a sample's spot is that sample's flag and carries its number (also
            two- and three-digit ones, also at a washed sample's spot), a flag anywhere else is a free one -
            lettered A-L, blue (never a number); a sample next to a flag is noted with it; "Alle Fähnchen
            einsammeln" takes the flags only; "Prospektion zurücksetzen" clears the notebook, the numbering,
            the flags and their links - the next sample is #1 - and nothing else (ground, ledger, contract,
            cash and pouch unchanged; bags not washed yet keep their material and take the first numbers;
            a sample in the pan too); after a reset -> save -> reload: notebook empty, no flags, next #1; a
            phase-9 save's flags load as free flags; the notebook's buttons and the question (cancel / reset)

Runs the server from temp copies (the real database is never touched). The PRE-P9 / P9 comparison itself is
a benchmark (tests/e2e/goldrush_gold_ab.py, goldrush_early_ab.py), not part of this suite.

    python tests/e2e/goldrush_hotfix91_e2e.py [--browser webkit] [--only parts] [--shots DIR]
"""

import json
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from goldrush_e2e import GPU_ARGS, client, errors, gr_open, gr_ready, gr_pause, gr_close  # noqa: E402
from goldrush_tools_e2e import seeded  # noqa: E402
import goldrush_quality_e2e as Q  # noqa: E402
from goldrush_mechanized_e2e import grant, ledger, reload  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ONLY = set(sys.argv[sys.argv.index("--only") + 1].split(",")) if "--only" in sys.argv else None
SHOTS = Path(sys.argv[sys.argv.index("--shots") + 1]) if "--shots" in sys.argv else None
RESULTS = []
GR = "window.__goldrush"
G, fresh = Q.G, Q.fresh
WASH = "{ x: -16.12, z: 2.0, yaw: Math.PI / 2, pitch: -0.3 }"


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def shot(page, name):
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / f"g91_{name}.png"))


# ======================================================================
# GEOLOGY 3
# ======================================================================

# per zone the mean gold of a 1 cm slice (fine gold + pieces) - ordinary ground only (channels / streaks /
# pockets apart), the top metre of the flat, the mountain's body above the contract floor
ZONES = r"""() => {
  const g = window.__goldrush, t = g.terrain(), f = t.field, vox = {}, out = {};
  const add = (k, ug, n) => { const o = out[k] || (out[k] = [0, 0]); o[0] += ug; o[1] += n; };
  for (let j = 14; j < t.vps - 14; j += 4) for (let i = 14; i < t.vps - 14; i += 4) {
    const k = j * t.vps + i, x = t.x0 + i * t.cell, z = t.z0 + j * t.cell, base = t.base[k];
    if (!t.inDigArea(x, z)) continue;
    const top = Math.ceil((base - f.floorY) / 0.01 - 0.5) - 1, fill = f.campFillAt(x, z) > 0.5 && base < 0.15;
    const depthN = base > 0.4 ? Math.floor((base - 0.06) / 0.01) : 100;
    if (f.starterWeight(x, base - 0.3, z, base) > 0.5) continue;
    for (let d = 0; d < depthN; d += 3) {
      const iy = top - d, y = f.floorY + (iy + 0.5) * 0.01, v = f.voxel(i, j, iy, vox);
      if (v.mat === 3) continue;
      const ug = v.fineUg + (v.cls ? v.massUg : 0), ch = f.channelAt(x, y, z);
      if (ch && ch.w > 0.5) { add("channel", ug, 1); continue; }
      if (f.streakAt(x, y, z) > 0.2 || f.pocketAt(x, y, z) > 0.2) continue;
      if (fill) { if (d < 50) add("fill", ug, 1); continue; }
      if (base > 2.0) add("upper", ug, 1);
      else if (base > 0.4) add("lower", ug, 1);
      else if (base < 0.12 && f.campFillAt(x, z) < 0.05) { add("claim", ug, 1); add(d < 30 ? "claimTop" : d >= 60 ? "claimDeep" : "claimMid", ug, 1); }
    }
  }
  const r = {};
  for (const [k, [ug, n]] of Object.entries(out)) r[k] = n ? ug / n : 0;
  return r;
}"""


def geology(A):
    rows = []
    for seed in (4242, 11, 23, 37, 51, 77):
        fresh(A, seed)
        rows.append(G(A, ZONES))
    doc = G(A, f"() => {{ {GR}.save(); return JSON.parse(localStorage.getItem(grKey())); }}")
    ok("GEO a new mine records geology 3 (the 9.1 calibration)", doc.get("geology", {}).get("version") == 3, str(doc.get("geology")))
    m = lambda k: sum(r.get(k, 0) for r in rows) / len(rows)
    claim = m("claim")
    ok("GEO the mountain is ordinary ground: upper 0.85-1.15 x the neutral claim", 0.85 <= m("upper") / claim <= 1.15, f"{m('upper') / claim:.2f}")
    ok("GEO ... and its lower flanks 0.8-1.15 x (no longer the poorest ground of the claim)", 0.8 <= m("lower") / claim <= 1.15, f"{m('lower') / claim:.2f}")
    ok("GEO the camp's fill stays next to barren (< 15 % of the claim)", m("fill") < 0.15 * claim, f"fill {m('fill'):.0f} vs claim {claim:.0f} ug/slice")
    ok("GEO the paleochannels stay 2-4 x the claim (prospecting pays)", 2.0 <= m("channel") / claim <= 4.0, f"{m('channel') / claim:.2f}")
    ok("GEO no gold peak at the old ground level (top 0.3 m of the flat not richer than below)", m("claimTop") <= 1.15 * m("claimDeep"), f"top {m('claimTop'):.0f} mid {m('claimMid'):.0f} deep {m('claimDeep'):.0f}")
    # a geology-2 mine (phase 9): dug ground and a bucket of material - loads on geology 3 without a notice
    fresh(A, 4242)
    G(A, f"() => {{ const g = {GR}; g.grant('shovel'); g.procGrant('bucket'); g.equipNow('shovel'); }}")
    G(A, f"() => {GR}.aimAt({{ x: 0.6, z: 5.0, yaw: 0, pitch: -0.35 }})")
    G(A, f"() => {GR}.procPlaceBucket(1.1, 5.4)")
    for _ in range(4):
        G(A, f"() => {GR}.act({{ visuals: false, tool: 'shovel' }})")
    before = G(A, f"() => {{ const g = {GR}; return {{ h: g.hashes(), bucket: g.procObj().bucket.batch.goldUg, ml: g.procObj().bucket.batch.volumeMl }}; }}")
    G(A, f"() => {GR}.setPaused(false)")
    gr_pause(A); gr_close(A)
    G(A, "() => { const d = JSON.parse(localStorage.getItem(grKey())); d.geology = { version: 2 }; localStorage.setItem(grKey(), JSON.stringify(d)); }")
    gr_open(A); gr_ready(A)
    after = G(A, f"() => {{ const g = {GR}; return {{ h: g.hashes(), bucket: g.procObj().bucket.batch.goldUg, ml: g.procObj().bucket.batch.volumeMl, notice: document.querySelector('.gr-notice') ? document.querySelector('.gr-notice').textContent : '' }}; }}")
    doc = G(A, f"() => {{ {GR}.save(); return JSON.parse(localStorage.getItem(grKey())); }}")
    ok("GEO a geology-2 mine follows geology 3: used slices stay used, the bucket keeps exactly its gold, no notice",
       after["h"]["slices"] == before["h"]["slices"] and after["bucket"] == before["bucket"] and after["ml"] == before["ml"] and doc["geology"].get("version") == 3
       and "neu vermessen" not in after["notice"], f"{doc['geology']} notice {after['notice'][:60]!r}")
    # the camp's fill: told once when you dig into it
    fresh(A, 4242)
    G(A, f"() => {{ const g = {GR}; g.grant('shovel'); g.equipNow('shovel'); }}")
    G(A, f"() => {GR}.aimAt({{ x: 0.6, z: 5.0, yaw: 0, pitch: -0.35 }})")
    for _ in range(3):
        G(A, f"() => {GR}.contact()")                          # the tool's real contact (the player's stroke)
    mount_seen = G(A, f"() => {GR}.fillSeen()")
    spot = G(A, """() => { const g = window.__goldrush, f = g.terrain().field;
      for (let x = -12.0; x < -10.5; x += 0.25) for (let z = -4; z < 6; z += 0.5) if (f.campFillAt(x, z) > 0.9 && g.terrain().inDigArea(x, z) && g.terrain().inDigArea(x, z + 1.3)) return { x, z }; return null; }""")
    G(A, f"(s) => {GR}.aimAt({{ x: s.x, z: s.z + 1.28, yaw: 0, pitch: -0.9 }})", spot)
    G(A, f"() => {GR}.contact()")
    msg = G(A, f"() => JSON.stringify({GR}.hudState())")
    seen = G(A, f"() => {GR}.fillSeen()")
    shot(A, "fill_message")
    reload(A)
    kept = G(A, f"() => {GR}.fillSeen()")
    ok("GEO digging into the camp's fill tells it once ('Aufgeschütteter Lagerplatz', kaum Gold) - not in the mountain - and remembers it",
       not mount_seen and seen and kept and "Aufgeschütteter Lagerplatz" in msg, f"mountain {mount_seen} fill {seen} kept {kept} {msg[:160]}")


# ======================================================================
# PROSPECTING: one numbering, collect, reset
# ======================================================================

def pv(A):
    return G(A, f"() => {GR}.prospect()")


def take(A, x, z, n=1):
    """n samples at the spot (x, z): look at it from 1.28 m south, pitch down (the hit ~2 m away: in the scoop's reach)"""
    G(A, f"(p) => {GR}.aimAt({{ x: p[0], z: p[1] + 1.28, yaw: 0, pitch: -0.9 }})", [x, z])
    got = []
    for _ in range(n):
        r = G(A, f"() => {GR}.sampleNow()")
        if r and r.get("ok"):
            got.append(r)
    return got


def wash_all(A):
    G(A, f"() => {GR}.pose({WASH})")
    for _ in range(8):
        if not pv(A)["bags"]:
            break
        G(A, f"() => {GR}.procAct('pan-sample')"); G(A, f"() => {GR}.procWork(10)"); G(A, f"() => {GR}.procCollect()")


def atlas_kind(A, slot):
    """the cloth colour of an atlas slot: 'orange' (a sample's flag) / 'blue' (a free flag)"""
    c = G(A, f"(s) => {{ const d = {GR}.procObj().prospect._atlasCtx.getImageData((s % 4) * 64 + 58, Math.floor(s / 4) * 64 + 5, 1, 1).data; return [d[0], d[1], d[2]]; }}", slot)
    return "orange" if c[0] > c[2] else "blue"


def prospect(A):
    fresh(A, 4242)
    grant(A, ["shovel", "bucket", "pan", "prospectkit"])
    G(A, f"() => {{ const g = {GR}; g.equipNow('shovel'); }}")
    s1 = take(A, -2.0, 4.6)[0]
    r1 = G(A, f"(p) => {GR}.flagAt(p[0], p[1])", [s1["x"] + 0.35, s1["z"] - 0.2])
    ok("FLAG [F] at a sample's spot sets THAT sample's flag: Probe 1 -> Fähnchen 1 (at the hole)",
       r1["kind"] == "set" and r1["flag"] == "sample" and r1["n"] == s1["n"] == 1 and r1["label"] == "1", str(r1))
    rA = G(A, f"() => {GR}.flagAt(2.5, 6.0)")
    rB = G(A, f"() => {GR}.flagAt(3.5, 6.0)")
    ok("FLAG [F] anywhere else: a free flag, lettered A, B (no number)", rA["flag"] == "free" and rA["label"] == "A" and rB["label"] == "B", f"{rA} {rB}")
    v = pv(A)["view"]
    slots = {f["label"]: i for i, f in enumerate(v["flags"])}
    ok("FLAG a sample's flag and a free one look different (orange with its number / blue with its letter)",
       atlas_kind(A, slots["1"]) == "orange" and atlas_kind(A, slots["A"]) == "blue" and atlas_kind(A, slots["B"]) == "blue", str(slots))
    s2 = take(A, s1["x"] + 0.9, s1["z"] - 0.4)[0]
    s3 = take(A, 2.5, 6.4)[0]
    ok("FLAG a sample next to a flag is noted with it ('bei Probe 1' / 'Fähnchen A')", s2["place"] == "bei Probe 1" and s3["place"] == "Fähnchen A", f"{s2['place']} / {s3['place']}")
    # a washed sample's spot can still get its flag; numbers past 12 too
    wash_all(A)
    G(A, f"() => {{ const g = {GR}; g.equipNow('shovel'); }}")
    r3 = G(A, f"(p) => {GR}.flagAt(p[0], p[1])", [s3["x"] - 0.3, s3["z"] + 0.1])
    more = []
    for k in range(4):
        more += take(A, -4.0 + k * 1.6, 5.2, 3)
        if len(pv(A)["bags"]) >= 6:
            wash_all(A)
            G(A, f"() => {{ const g = {GR}; g.equipNow('shovel'); }}")
    big = max(more, key=lambda r: r["n"])
    rbig = G(A, f"(p) => {GR}.flagAt(p[0], p[1])", [big["x"] + 0.2, big["z"]])
    v = pv(A)["view"]
    slot = next((i for i, f in enumerate(v["flags"]) if f["kind"] == "sample" and f["n"] == big["n"]), -1)
    ok("FLAG a washed sample's spot gets its flag too (its number), and a sample past 12 carries its own number",
       r3.get("flag") == "sample" and r3.get("n") == s3["n"] and rbig.get("flag") == "sample" and rbig.get("label") == str(big["n"]) and big["n"] > 12 and slot >= 0 and atlas_kind(A, slot) == "orange",
       f"{r3} {rbig} big #{big['n']} at {big['x']},{big['z']} flags {[(f['kind'], f['label'], f['x'], f['z']) for f in v['flags']]}")
    line = next((q for q in v["notes"] if q["n"] == s3["n"]), None)
    ok("FLAG the notebook shows which samples carry their flag ('⚑ Fähnchen n')", line and line["flagged"], str(line and line["head"]))
    # ---- collect: the flags only
    before = {"notes": v["notes"], "next": v["next"], "h": G(A, f"() => {GR}.hashes()"), "led": ledger(A)[:2]}
    rc = G(A, f"() => {GR}.flagsCollect()")
    v2 = pv(A)["view"]
    ok("COLLECT 'Alle Fähnchen einsammeln': every flag out, the notebook and the numbering stay",
       rc["collected"] == len(v["flags"]) and not v2["flags"] and [(q["n"], q["ug"], q["ml"]) for q in v2["notes"]] == [(q["n"], q["ug"], q["ml"]) for q in before["notes"]]
       and v2["next"] == before["next"] and not any(q["flagged"] for q in v2["notes"]), f"{rc} next {v2['next']}")
    # ---- reset with nothing waiting: notebook, numbering, flags - nothing else
    G(A, f"(p) => {GR}.flagAt(p[0], p[1])", [s3["x"], s3["z"]])
    G(A, f"() => {GR}.flagAt(6.0, 9.0)")
    wash_all(A)
    G(A, f"() => {{ const g = {GR}; g.equipNow('shovel'); }}")
    eco0 = Q.eco(A)
    st0 = {"h": G(A, f"() => {GR}.hashes()"), "led": ledger(A), "pct": G(A, f"() => {GR}.contract().pct"), "cash": eco0["cashCents"], "pouch": eco0["pouchUg"]}
    rr = G(A, f"() => {GR}.prospectReset()")
    v3 = pv(A)["view"]
    eco1 = Q.eco(A)
    st1 = {"h": G(A, f"() => {GR}.hashes()"), "led": ledger(A), "pct": G(A, f"() => {GR}.contract().pct"), "cash": eco1["cashCents"], "pouch": eco1["pouchUg"]}
    ok("RESET clears the notebook, every flag and the numbering: next sample #1", rr["ok"] and not v3["notes"] and not v3["flags"] and v3["next"] == 1 and rr["next"] == 1, f"{rr}")
    ok("RESET changes nothing else: ground (used slices, heights), ledger, contract, cash, pouch",
       st1["h"]["slices"] == st0["h"]["slices"] and st1["h"]["height"] == st0["h"]["height"] and st1["led"][:2] == st0["led"][:2] and st1["led"][2] == st0["led"][2]
       and st1["pct"] == st0["pct"] and st1["cash"] == st0["cash"] and st1["pouch"] == st0["pouch"], f"{st0['led'][:2]} -> {st1['led'][:2]}")
    s_new = take(A, 1.5, 5.6)[0]
    ok("RESET the next sample is Probe 1 again (from new ground - the old holes stay holes)", s_new["n"] == 1, str(s_new["n"]))
    # ---- save -> reload after a reset
    G(A, f"() => {GR}.prospectReset()")
    wash_all(A)
    G(A, f"() => {GR}.prospectReset()")
    reload(A)
    v4 = pv(A)["view"]
    ok("RESET -> save -> reload: notebook empty, no flags, next sample #1", not v4["notes"] and not v4["flags"] and v4["next"] == 1 and not v4["bags"], f"next {v4['next']}")
    # ---- reset with bags not washed yet (and one in the pan): they keep their material, take the first numbers
    G(A, f"() => {{ const g = {GR}; g.equipNow('shovel'); }}")
    got = take(A, -1.0, 5.8, 3)
    G(A, f"() => {GR}.pose({WASH})")
    G(A, f"() => {GR}.procAct('pan-sample')")                    # the first bag into the pan (not done)
    bags0 = pv(A)["bags"]
    led0 = ledger(A)
    pan_n0 = G(A, f"() => {GR}.procObj().pan.sample && {GR}.procObj().pan.sample.n")
    rr = G(A, f"() => {GR}.prospectReset()")
    bags1 = pv(A)["bags"]
    pan_n1 = G(A, f"() => {GR}.procObj().pan.sample && {GR}.procObj().pan.sample.n")
    led1 = ledger(A)
    ok("RESET with samples waiting: the one in the pan becomes Probe 1, the bags 2.., material and gold untouched, next after them",
       len(got) == 3 and pan_n0 == got[0]["n"] and pan_n1 == 1 and [b["n"] for b in bags1] == [2, 3] and [(b["ug"], b["ml"], b["g"]) for b in bags1] == [(b["ug"], b["ml"], b["g"]) for b in bags0]
       and rr["kept"] == 3 and rr["next"] == 4 and led1[:2] == led0[:2] and led1[0] == 0 and led1[1] == 0, f"{rr} bags {[b['n'] for b in bags1]} pan {pan_n0}->{pan_n1}")
    G(A, f"() => {GR}.procWork(10)"); c = G(A, f"() => {GR}.procCollect()")
    wash_all(A)
    v5 = pv(A)["view"]
    ok("RESET ... and they wash out as Probe 1, 2, 3 (the ledger exact)", sorted(q["n"] for q in v5["notes"]) == [1, 2, 3] and ledger(A)[:2] == (0, 0), str([q["n"] for q in v5["notes"]]))
    # ---- a phase-9 save's flags (no kind) load as free flags
    G(A, f"() => {GR}.setPaused(false)")
    gr_pause(A); gr_close(A)
    G(A, "() => { const d = JSON.parse(localStorage.getItem(grKey())); d.prospect.flags = [{ n: 1, x: 2, z: 9 }, { n: 4, x: 3, z: 9 }]; localStorage.setItem(grKey(), JSON.stringify(d)); }")
    gr_open(A); gr_ready(A)
    fl = pv(A)["view"]["flags"]
    ok("LEGACY a phase-9 save's numbered flags load as free flags (A, D) - never mixed up with samples", [(f["kind"], f["label"]) for f in fl] == [("free", "A"), ("free", "D")], str(fl))
    ui(A)


def ui(A):
    """the notebook's buttons and the question, as a player uses them"""
    G(A, f"() => {GR}.flagAt(5.0, 9.5)")
    G(A, f"() => {GR}.setPaused(false)")
    G(A, f"() => {GR}.openPanel('notebook')")
    A.wait_for_selector("[data-sheet=notebook]:not([hidden]) [data-act=nb-collect]", timeout=5000)
    shot(A, "notebook")
    sub0 = A.inner_text("[data-role=nb-sub]")
    A.click("[data-sheet=notebook] [data-act=nb-collect]")
    A.wait_for_function("() => /0 \\/ 12 Fähnchen/.test(document.querySelector('[data-role=nb-sub]').textContent)", timeout=4000)
    n_flags = len(pv(A)["view"]["flags"])
    notes0 = len(pv(A)["view"]["notes"])
    A.click("[data-sheet=notebook] [data-act=nb-reset]")
    A.wait_for_selector(".gr-dialog:not([hidden]) [data-act='dlg:reset-prospect']", timeout=4000)
    q = A.inner_text(".gr-dialog [data-role=dlg-text]")
    shot(A, "reset_question")
    A.click(".gr-dialog [data-act='dlg:cancel']")
    A.wait_for_function("() => document.querySelector('.gr-dialog').hidden", timeout=3000)
    notes1 = len(pv(A)["view"]["notes"])
    A.click("[data-sheet=notebook] [data-act=nb-reset]")
    A.wait_for_selector(".gr-dialog:not([hidden]) [data-act='dlg:reset-prospect']", timeout=4000)
    A.click(".gr-dialog [data-act='dlg:reset-prospect']")
    A.wait_for_function("() => /nächste: Probe 1/.test(document.querySelector('[data-role=nb-sub]').textContent)", timeout=4000)
    sub2 = A.inner_text("[data-role=nb-sub]")
    shot(A, "after_reset")
    G(A, f"() => {GR}.closeStation()")
    ok("UI the notebook: 'Alle Fähnchen einsammeln' takes the flags (the notebook stays)", n_flags == 0 and notes0 > 0, f"{sub0} -> {n_flags} flags, {notes0} notes")
    ok("UI 'Prospektion zurücksetzen …' asks first (what goes, what stays: no material back, no gold regrows); 'Abbrechen' changes nothing",
       "Probe 1" in q and "Material" in q and "Gold" in q and notes1 == notes0, q[:160])
    ok("UI confirmed: the notebook is empty, next 'Probe 1'", "0 / 20 Einträge" in sub2 and "nächste: Probe 1" in sub2, sub2)


def main():
    engine = sys.argv[sys.argv.index("--browser") + 1] if "--browser" in sys.argv else "chromium"
    want = lambda part: not ONLY or part in ONLY
    proc_, base, tmp = start_server()
    try:
        user = login(base, "Hotfix91")
        with sync_playwright() as p:
            browser = getattr(p, engine).launch(args=GPU_ARGS if engine == "chromium" else [])
            ctx, A = client(browser, base, user, dict(viewport={"width": 1366, "height": 768}), extra_init=[seeded()])
            for part, fn in (("geology", geology), ("prospect", prospect)):
                if not want(part):
                    continue
                try:
                    fn(A)
                except Exception as e:                           # a part that breaks must not hide the others
                    ok(f"{part}: ran without an exception", False, repr(e)[:300])
            errs = errors(A)
            ok(f"no page errors ({engine})", not errs, str(errs[:3]))
            Q.close(A)
            ctx.close()
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
