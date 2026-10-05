# three.js (vendored)

- Version: **0.176.0** (r176), `build/three.module.min.js` + `build/three.core.min.js`
- Source: npm package `three@0.176.0` — https://registry.npmjs.org/three/-/three-0.176.0.tgz
- Tarball SHA-1 (npm `dist.shasum`): `a30c1974e46db5745e4f96dd9ee2028d71e16ecf`
- License: MIT (see `LICENSE`, copyright three.js authors)

Used only by GoldRush (`static/games/goldrush/`), loaded as an ES module on
demand. To update: replace both files from the new npm tarball, update this
note, and run `tests/e2e/goldrush_e2e.py`.

## Addons (phase 8, GoldRush authored models)

- `addons/loaders/GLTFLoader.js` and `addons/utils/BufferGeometryUtils.js` from the same
  tarball (`package/examples/jsm/...`, SHA-1 checked as above), unchanged except the import
  of `'three'`, which points at `../../three.module.min.js`.
- Loaded on demand by `goldrush-assets.js` (`AssetManager.model`) only when an authored
  `.glb` / `.gltf` is asked for - nothing is fetched from a CDN at runtime.
