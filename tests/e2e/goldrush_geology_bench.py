"""GoldRush geology benchmark (phase 9): how much gold the ground really holds, by zone, over many seeds.

It reads the authoritative resource voxels (goldrush-resources.js MaterialField.voxel: fine gold + the
discrete pieces of every 1 cm slice) - no digging, no dice - for columns of each zone, 1 m deep below the
ORIGINAL surface, and reports gold per 10 l (total and what a raw pan wash brings back, at EUR 100 / g):

  mountainUpper   the upper mountain (original height > 2 m)          - overburden, may be a bit poorer
  mountainLower   the mountain's lower flanks (0.4 - 2 m)
  claim           ordinary flat claim ground away from the camp       - the neutral baseline
  camp            the apron in front of the camp (fill since phase 9) - must not be a gold farm
  starter         the starter zone (held in a fair band)
  channelPoor / channelRich   paleochannel gravel (phase 9), its poorer / richer quarter by grade
  streak          inside a mineralised streak (core > 0.3)
  pocket          inside a gold pocket (> 0.3 of its peak)

Per zone: mean, and the spread of the per-column means (P10 / P50 / P90) - a zone is its distribution,
not one number - plus ratios to `claim`.

    python tests/e2e/goldrush_geology_bench.py [--seeds 20] [--first 1] [--out FILE.json]
"""

import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from goldrush_e2e import GPU_ARGS, client  # noqa: E402
from goldrush_tools_e2e import open_game, seeded  # noqa: E402
from goldrush_mech_e2e import fresh  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ARG = lambda k, d: type(d)(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d
SEEDS = ARG("--seeds", 20)
FIRST = ARG("--first", 1)
OUT = ARG("--out", "")
PAN_RAW = 0.58                      # goldrush-material.js PAN_RECOVERY.raw (fine gold); pieces come back whole

ZONES = r"""() => {
  const g = window.__goldrush, t = g.terrain(), f = t.field, vps = t.vps, cell = t.cell, vox = {};
  const ORIGIN = -2.5, VH = 0.01, SLICE_L = cell * cell * VH * 1000;
  const mc = t.moundCenter, st = f.starter;
  const camp = (x, z) => (f.campFillAt ? f.campFillAt(x, z) > 0.5 : (x < -9.5 && z > -8 && z < 9.5));
  const zones = {};
  const add = (name, ug, n, colKey) => {
    const Z = zones[name] || (zones[name] = { ug: 0, slices: 0, cols: {} });
    Z.ug += ug; Z.slices += n;
    const c = Z.cols[colKey] || (Z.cols[colKey] = [0, 0]);
    c[0] += ug; c[1] += n;
  };
  for (let j = 14; j < vps - 14; j += 3) for (let i = 14; i < vps - 14; i += 3) {
    const k = j * vps + i, x = t.x0 + i * cell, z = t.z0 + j * cell, base = t.base[k];
    if (!t.inDigArea(x, z)) continue;
    const top = Math.ceil((base - ORIGIN) / VH - 0.5) - 1;
    const sw = f.starterWeight(x, base - 0.3, z, base);
    let colZone = null;
    if (sw > 0.5) colZone = "starter";
    else if (camp(x, z) && base < 0.15) colZone = "camp";
    else if (base > 2.0) colZone = "mountainUpper";
    else if (base > 0.4) colZone = "mountainLower";
    else if (base < 0.12) colZone = "claim";
    for (let d = 0; d < 100; d++) {
      const iy = top - d, y = ORIGIN + (iy + 0.5) * VH;
      const v = f.voxel(i, j, iy, vox);
      if (v.mat === 3) continue;                                   // stone holds no gold
      const ug = v.fineUg + (v.cls ? v.massUg : 0), key = `${i}:${j}`;
      // the special bodies first (they say more than the column's zone)
      const ch = f.channelAt ? f.channelAt(x, y, z) : null;
      if (ch && ch.w > 0.5) add(ch.rich > 0.6 ? "channelRich" : ch.rich < 0.35 ? "channelPoor" : "channelMid", ug, 1, key);
      else if (f.streakAt(x, y, z) > 0.3) add("streak", ug, 1, key);
      else if (f.pocketAt ? f.pocketAt(x, y, z) > 0.3 : false) add("pocket", ug, 1, key);
      else if (colZone === "camp") add(d < 50 ? "campTop" : "campBelow", ug, 1, key);          // the fill / what lies under it
      else if (colZone) add(colZone, ug, 1, key);
    }
  }
  const out = {};
  for (const [name, Z] of Object.entries(zones)) {
    const cols = Object.values(Z.cols).filter((c) => c[1] >= 20).map((c) => (c[0] / (c[1] * SLICE_L)) * 10);
    cols.sort((a, b) => a - b);
    const q = (p) => (cols.length ? cols[Math.min(cols.length - 1, Math.floor(p * cols.length))] : 0);
    out[name] = { per10l: Z.slices ? (Z.ug / (Z.slices * SLICE_L)) * 10 : 0, cols: cols.length, p10: q(0.1), p50: q(0.5), p90: q(0.9), litres: Z.slices * SLICE_L };
  }
  return out;
}"""


CHANNELS = r"""() => {
  const t = window.__goldrush.terrain(), f = t.field;
  if (!f.channels) return null;
  let cover = 0, under = 0, dig = 0;
  for (let k = 0; k < t.vps * t.vps; k++) {
    const i = k % t.vps, j = (k - i) / t.vps, x = t.x0 + i * t.cell, z = t.z0 + j * t.cell;
    if (!t.inDigArea(x, z)) continue;
    dig++;
    if (f.chIdx[k] >= 0 && f.chD[k] < 1) { cover++; if (t.base[k] > 0.4) under++; }
  }
  return { n: f.channels.length, cover: +(cover / dig).toFixed(3), underMountain: +(under / Math.max(1, cover)).toFixed(2),
    beds: f.channels.map((c) => +c.bed.toFixed(2)), widths: f.channels.map((c) => +c.w0.toFixed(1)) };
}"""


def main():
    proc, base, tmp = start_server()
    rows = []
    try:
        user = login(base, "GeoBench")
        with sync_playwright() as p:
            b = p.chromium.launch(args=GPU_ARGS)
            ctx, A = client(b, base, user, dict(viewport={"width": 960, "height": 600}), extra_init=[seeded()])
            open_game(A)
            for seed in range(FIRST, FIRST + SEEDS):
                fresh(A, seed)
                t0 = time.time()
                z = A.evaluate(ZONES)
                meta = A.evaluate(CHANNELS)
                rows.append({"seed": seed, "zones": z, "channels": meta})
                print(f"  channels {meta}", flush=True)
                print(f"seed {seed} ({time.time() - t0:.1f} s): " + ", ".join(f"{k} {v['per10l'] / 10000:.2f}" for k, v in sorted(z.items())), flush=True)
            b.close()
    finally:
        proc.terminate()
    # the summary: per zone, over the seeds (mean of seed means; spread of the columns pooled)
    names = sorted({k for r in rows for k in r["zones"]})
    summary = {}
    for n in names:
        vals = [r["zones"][n]["per10l"] for r in rows if n in r["zones"] and r["zones"][n]["litres"] > 5]
        if not vals:
            continue
        vals.sort()
        mean = sum(vals) / len(vals)
        summary[n] = {"seeds": len(vals), "meanUg10l": round(mean), "seedP10": round(vals[int(0.1 * (len(vals) - 1))]), "seedP90": round(vals[int(0.9 * (len(vals) - 1))]),
                      "colP10": round(sum(r["zones"][n]["p10"] for r in rows if n in r["zones"]) / len(vals)),
                      "colP50": round(sum(r["zones"][n]["p50"] for r in rows if n in r["zones"]) / len(vals)),
                      "colP90": round(sum(r["zones"][n]["p90"] for r in rows if n in r["zones"]) / len(vals))}
    claim = summary.get("claim", {}).get("meanUg10l") or 1
    E = 10000                                   # 100 ug = 1 ct -> 10 000 ug = EUR 1
    print("\nzone            EUR / 10 l (all gold)   raw pan ~   ratio to claim   seed P10-P90     column P10 / P50 / P90")
    for n, s in summary.items():
        print(f"{n:15s} {s['meanUg10l'] / E:8.2f}              {s['meanUg10l'] / E * PAN_RAW:6.2f}       {s['meanUg10l'] / claim:5.2f}         "
              f"{s['seedP10'] / E:5.2f}-{s['seedP90'] / E:5.2f}     {s['colP10'] / E:.2f} / {s['colP50'] / E:.2f} / {s['colP90'] / E:.2f}")
    if OUT:
        json.dump({"summary": summary, "rows": rows}, open(OUT, "w"), indent=1)


if __name__ == "__main__":
    main()
