"""Build GoldRush's boulder shapes (Earth 2.0C) from CC0 scans - reproducible, offline afterwards.

Downloads (once, into a cache) the glTF geometry of a few Poly Haven rock scans (CC0 1.0), throws away their
textures / UVs / materials (the game shades rocks itself: the Earth B0 rock layer, the geology tint, the contact with the
ground), decimates each to two levels of detail, normalises it and writes ONE small GLB plus a manifest:

  static/games/goldrush/assets/rocks/rocks.glb        nodes rock<N>_lod0 (about 1600 triangles) / rock<N>_lod1 (about 400) / rock<N>_lod2 (about 32, for pebbles)
  static/games/goldrush/assets/rocks/manifest.json    shapes, sources, authors, licence, triangle counts

Each shape is centred on its bounding box and scaled so the mean horizontal half extent is about 1.05 (the old
icosahedron's size: gameplay radius r scales it), the height squashed into 0.5 .. 0.7 half extent. Smooth vertex normals.

    pip install trimesh fast-simplification numpy
    python tools/goldrush/build_rock_assets.py [--cache DIR]
"""

import json
import os
import sys
import urllib.request
from pathlib import Path

import numpy as np
import trimesh
import fast_simplification

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "static" / "games" / "goldrush" / "assets" / "rocks"
CACHE = Path(sys.argv[sys.argv.index("--cache") + 1]) if "--cache" in sys.argv else ROOT / ".rock_cache"

# Poly Haven asset id (the authors are read from the API into the manifest)
SHAPES = [
    ("namaqualand_boulder_05", "see polyhaven.com"),
    ("namaqualand_boulder_03", "see polyhaven.com"),
    ("namaqualand_boulder_04", "see polyhaven.com"),
    ("namaqualand_boulder_02", "see polyhaven.com"),
    ("namaqualand_boulder_06", "see polyhaven.com"),
    ("rock_07", "see polyhaven.com"),
]
LODS = [1600, 400, 32]


_op = urllib.request.build_opener()
_op.addheaders = [("User-Agent", "Mozilla/5.0 goldrush-asset-build")]
urllib.request.install_opener(_op)


def get(url, dst):
    if not dst.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        print("download", url, flush=True)
        urllib.request.urlretrieve(url, dst)
    return dst


def fetch(aid):
    info = json.load(urllib.request.urlopen(f"https://api.polyhaven.com/files/{aid}"))
    g = info["gltf"]["1k"]["gltf"]
    gltf = get(g["url"], CACHE / aid / f"{aid}.gltf")
    for name, f in g["include"].items():
        if name.endswith(".bin"):
            get(f["url"], CACHE / aid / name)
    authors = json.load(urllib.request.urlopen(f"https://api.polyhaven.com/info/{aid}"))
    return gltf, authors


def load_mesh(gltf_path):
    d = json.loads(Path(gltf_path).read_text())
    for k in ("images", "textures", "materials", "samplers"):
        d.pop(k, None)
    for m in d["meshes"]:
        for p in m["primitives"]:
            p.pop("material", None)
            p["attributes"] = {k: v for k, v in p["attributes"].items() if k in ("POSITION", "NORMAL")}
    tmp = Path(gltf_path).with_name("stripped.gltf")
    tmp.write_text(json.dumps(d))
    sc = trimesh.load(str(tmp), force="scene")
    m = trimesh.util.concatenate([g for g in sc.dump()])
    return m


def build():
    OUT.mkdir(parents=True, exist_ok=True)
    scene = trimesh.Scene()
    manifest = {"about": "Boulder shapes for GoldRush (Earth 2.0C): decimated geometry of CC0 scans; shaded in-game (no textures shipped)",
                "licence": "CC0 1.0 (https://polyhaven.com/license) - public domain, no attribution required; kept here anyway",
                "lods": LODS, "shapes": []}
    for n, (aid, author) in enumerate(SHAPES):
        gltf, info = fetch(aid)
        m = load_mesh(gltf)
        m.merge_vertices(digits_vertex=5)
        m.update_faces(m.nondegenerate_faces())
        m.remove_unreferenced_vertices()
        # y up (glTF); centre on the bounding box, bottom flat-ish is the game's business (it embeds the rock)
        b0, b1 = m.bounds
        m.apply_translation(-(b0 + b1) / 2)
        ext = m.extents
        s = 2.1 / (ext[0] + ext[2])                     # mean horizontal half extent -> 1.05
        m.apply_scale(s)
        hy = m.extents[1] / 2
        sy = min(0.7, max(0.5, hy)) / hy
        m.vertices[:, 1] *= sy
        tris = []
        for l, target in enumerate(LODS):
            v, f = fast_simplification.simplify(np.asarray(m.vertices, dtype=np.float32), np.asarray(m.faces, dtype=np.int32), target_count=target, agg=7)
            lm = trimesh.Trimesh(v, f, process=False)
            lm.vertex_normals                           # (computed, smooth)
            scene.add_geometry(lm, node_name=f"rock{n}_lod{l}", geom_name=f"rock{n}_lod{l}")
            tris.append(int(len(f)))
        manifest["shapes"].append({"index": n, "id": aid, "url": f"https://polyhaven.com/a/{aid}", "authors": list(info.get("authors", {}).keys()) or [author],
                                   "triangles": tris, "half_extents": [round(float(x) / 2, 3) for x in m.extents]})
        print(aid, tris, [round(float(x) / 2, 2) for x in m.extents], flush=True)
    scene.export(str(OUT / "rocks.glb"))
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print("wrote", OUT / "rocks.glb", (OUT / "rocks.glb").stat().st_size, "bytes")


if __name__ == "__main__":
    build()
