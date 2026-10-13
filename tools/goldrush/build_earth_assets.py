"""Build GoldRush's Earth B0 runtime assets from their CC0 sources (Poly Haven) - reproducible, offline afterwards.

Downloads (once, into a cache) the 1k JPG maps of five ground textures and one HDRI, then writes the runtime files
the game loads (static/games/goldrush/assets/):

  earth/<layer>_albedo_<res>.jpg   base colour, sRGB
  earth/<layer>_normal_<res>.jpg   tangent-space normal, OpenGL convention (+Y up)
  earth/<layer>_orh_<res>.jpg      R = ambient occlusion, G = roughness, B = height (displacement, stretched 0..1)
  earth/manifest.json              layers, sources, authors, licence, real-world size, tile size used
  hdri/goegap_1k.hdr               environment lighting (Radiance HDR, unchanged)

res = 1024 (desktop) and 512 (mobile / low). No ICC profiles (raw values for the GPU). All sources are CC0
(https://polyhaven.com/license) - no attribution required; it is kept in the manifest and ASSETS.md anyway.

    python tools/goldrush/build_earth_assets.py [--cache DIR]
"""

import io
import json
import os
import sys
import urllib.request

from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "static", "games", "goldrush", "assets")
CACHE = sys.argv[sys.argv.index("--cache") + 1] if "--cache" in sys.argv else os.path.join(os.environ.get("TEMP", "/tmp"), "goldrush_asset_cache")
PH = "https://dl.polyhaven.org/file/ph-assets"

# layer -> Poly Haven asset; tile = the world size of one texture repeat in metres (the real scan size, clamped to
# 1.3-2.6 m so that every layer reads at a believable scale and the texel densities stay close)
LAYERS = [
    ("crust", "dry_ground_rocks", "weathered crust - dry, sun-baked surface with fine pebbles", 2.6),
    ("loose", "brown_mud_dry", "loose fresh dirt - crumbly, small clods", 1.3),
    ("compact", "dirt_floor", "compact clay / compact soil - dense, smoother", 2.07),
    ("gravel", "ganges_river_pebbles", "alluvial gravel - rounded pebbles in a sandy matrix", 2.16),
    ("rock", "dry_riverbed_rock", "rock - weathered, cracked stone (outcrops, stone lenses, rubble)", 2.0),
]
HDRI = ("goegap", "Goegap (Namaqualand) - clear, dry, sunny; used for image-based lighting only")


def get(url, name):
    os.makedirs(CACHE, exist_ok=True)
    p = os.path.join(CACHE, name)
    if not os.path.exists(p):
        print("download", url, flush=True)
        req = urllib.request.Request(url, headers={"User-Agent": "GoldRush-asset-build/1.0"})
        with urllib.request.urlopen(req, timeout=120) as r:
            data = r.read()
        open(p, "wb").write(data)
    return p


def info(asset):
    req = urllib.request.Request(f"https://api.polyhaven.com/info/{asset}", headers={"User-Agent": "GoldRush-asset-build/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def save_jpg(img, path, q=90):
    img.save(path, "JPEG", quality=q, subsampling=0 if q >= 90 else 2)


def main():
    os.makedirs(os.path.join(OUT, "earth"), exist_ok=True)
    os.makedirs(os.path.join(OUT, "hdri"), exist_ok=True)
    manifest = {"version": 1, "format": "jpg (KTX2 planned once a Basis encoder is part of the build)", "resolutions": [1024, 512],
                "channels": {"albedo": "sRGB base colour", "normal": "tangent space, OpenGL (+Y)", "orh": "R ambient occlusion, G roughness, B height 0..1"},
                "licence": "CC0 1.0 (Poly Haven, https://polyhaven.com/license)", "layers": []}
    for key, asset, role, tile in LAYERS:
        meta = info(asset)
        maps = {}
        for m, suffix in (("diff", "diff"), ("nor", "nor_gl"), ("arm", "arm"), ("disp", "disp")):
            maps[m] = Image.open(get(f"{PH}/Textures/jpg/1k/{asset}/{asset}_{suffix}_1k.jpg", f"{asset}_{suffix}_1k.jpg"))
        diff = maps["diff"].convert("RGB")
        nor = maps["nor"].convert("RGB")
        arm = maps["arm"].convert("RGB")
        disp = maps["disp"].convert("L")
        lo, hi = disp.getextrema()
        disp = disp.point(lambda v: int(round((v - lo) * 255 / max(1, hi - lo))))      # 0..1 per layer (scaled in the shader)
        a, r, _ = arm.split()
        orh = Image.merge("RGB", (a, r, disp))
        for res in (1024, 512):
            sz = (res, res)
            save_jpg(diff.resize(sz, Image.LANCZOS), os.path.join(OUT, "earth", f"{key}_albedo_{res}.jpg"))
            save_jpg(nor.resize(sz, Image.LANCZOS), os.path.join(OUT, "earth", f"{key}_normal_{res}.jpg"), 92)
            save_jpg(orh.resize(sz, Image.LANCZOS), os.path.join(OUT, "earth", f"{key}_orh_{res}.jpg"))
        manifest["layers"].append({"key": key, "role": role, "tile_m": tile, "source": f"https://polyhaven.com/a/{asset}", "asset": asset,
                                   "name": meta.get("name"), "authors": list((meta.get("authors") or {}).keys()),
                                   "scan_size_m": round((meta.get("dimensions") or [0])[0] / 1000, 2), "licence": "CC0 1.0"})
        print("layer", key, asset, flush=True)
    hdr = get(f"{PH}/HDRIs/hdr/1k/{HDRI[0]}_1k.hdr", f"{HDRI[0]}_1k.hdr")
    open(os.path.join(OUT, "hdri", f"{HDRI[0]}_1k.hdr"), "wb").write(open(hdr, "rb").read())
    hm = info(HDRI[0])
    manifest["hdri"] = {"file": f"hdri/{HDRI[0]}_1k.hdr", "role": HDRI[1], "source": f"https://polyhaven.com/a/{HDRI[0]}", "name": hm.get("name"),
                        "authors": list((hm.get("authors") or {}).keys()), "licence": "CC0 1.0"}
    json.dump(manifest, open(os.path.join(OUT, "earth", "manifest.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    print("ok")


if __name__ == "__main__":
    main()
