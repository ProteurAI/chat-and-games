// GoldRush - central asset manager. Phase 1 builds its textures
// procedurally; GLB models, texture files and audio of later phases go
// through here: one cache per game instance, real loading progress,
// errors reported instead of thrown into the render loop, everything
// disposed with the game.
//
// Authored models (phase 8): model(url) loads a .glb / .gltf with the
// three.js r176 GLTFLoader vendored in static/vendor/three/addons/ (no CDN,
// loaded the first time a model is asked for). Optional by default: the
// models in models/ are listed in models/manifest.json - one that is not
// listed is never requested (no 404 in the console) and resolves to null, and
// the caller builds its procedural model (modelOr) - so authored vehicles,
// machines, stations or props can be dropped in one at a time. Workflow:
// static/games/goldrush/ASSETS.md.

// where authored models live, and their list (fetched once, the first time a model is asked for)
const MODELS_DIR = new URL("./models/", import.meta.url).href;
const MODELS_MANIFEST = `${MODELS_DIR}manifest.json`;

// every geometry, material and texture under an object (an authored model)
function disposeObject(root) {
  const seen = new Set();
  root.traverse((o) => {
    if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
    for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
      if (seen.has(m)) continue;
      seen.add(m);
      for (const v of Object.values(m)) if (v && v.isTexture && !seen.has(v)) { seen.add(v); v.dispose(); }
      m.dispose();
    }
  });
}

export class AssetManager {
  constructor(THREE) {
    this.THREE = THREE;
    this.cache = new Map();          // key -> { status, value, error, promise }
    this.listeners = new Set();
  }

  onProgress(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  _emit() {
    const all = [...this.cache.values()];
    const done = all.filter((a) => a.status !== "loading").length;
    for (const fn of this.listeners) fn({ done, total: all.length, failed: all.filter((a) => a.status === "error").length });
  }

  // generic: any async factory, cached by key
  load(key, factory) {
    const hit = this.cache.get(key);
    if (hit) return hit.promise;
    const entry = { status: "loading", value: null, error: null, promise: null };
    entry.promise = Promise.resolve()
      .then(factory)
      .then((value) => { entry.status = "ready"; entry.value = value; this._emit(); return value; })
      .catch((error) => { entry.status = "error"; entry.error = error; this._emit(); throw error; });
    this.cache.set(key, entry);
    this._emit();
    return entry.promise;
  }

  // synchronous procedural assets (canvas textures etc.)
  procedural(key, make) {
    const hit = this.cache.get(key);
    if (hit && hit.status === "ready") return hit.value;
    const value = make();
    this.cache.set(key, { status: "ready", value, error: null, promise: Promise.resolve(value) });
    return value;
  }

  texture(url, { srgb = true } = {}) {
    return this.load(`tex:${url}`, () => new Promise((resolve, reject) => {
      new this.THREE.TextureLoader().load(url, (t) => { if (srgb) t.colorSpace = this.THREE.SRGBColorSpace; resolve(t); }, undefined,
        () => reject(new Error(`Textur konnte nicht geladen werden: ${url}`)));
    }));
  }

  json(url) {
    return this.load(`json:${url}`, async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r.json();
    });
  }

  get(key) {
    const e = this.cache.get(key);
    return e && e.status === "ready" ? e.value : null;
  }

  // the authored models that exist (models/manifest.json: { "models": ["barrow.glb", ...] }); an
  // unreadable list counts as "none" - the game always has its procedural models
  modelList() {
    return this.load("json:models", async () => {
      try {
        const r = await fetch(MODELS_MANIFEST, { cache: "no-cache" });
        const doc = r.ok ? await r.json() : null;
        return new Set(Array.isArray(doc && doc.models) ? doc.models.filter((m) => typeof m === "string") : []);
      } catch (e) { return new Set(); }
    });
  }

  /**
   * An authored model: { scene, animations } or null (optional and absent / unreadable).
   * Cached by url; its geometries, materials and textures are disposed with the game.
   */
  model(url, { optional = true } = {}) {
    return this.load(`glb:${url}`, async () => {
      if (optional && !url.startsWith("data:")) {
        // only what the manifest lists is fetched: a model that is not there is no error (and no
        // request), just "use the procedural one"
        const abs = new URL(url, document.baseURI).href;
        const name = abs.startsWith(MODELS_DIR) ? abs.slice(MODELS_DIR.length) : null;
        if (!name || !(await this.modelList()).has(name)) return null;
      }
      const { GLTFLoader } = await import("../../vendor/three/addons/loaders/GLTFLoader.js");
      try {
        const gltf = await new GLTFLoader().loadAsync(url);
        const scene = gltf.scene;
        return { scene, animations: gltf.animations || [], dispose: () => disposeObject(scene) };
      } catch (err) {
        if (optional) return null;
        throw err;
      }
    });
  }

  // a placeable copy of a loaded model (shares its geometry / materials with the cached one) or null
  instance(url) {
    const m = this.get(`glb:${url}`);
    return m ? m.scene.clone(true) : null;
  }

  /** the authored model when there is one, else build() - the procedural fallback */
  async modelOr(url, build) {
    let m = null;
    try { m = await this.model(url); } catch (e) { m = null; }
    return m ? m.scene.clone(true) : build();
  }

  dispose() {
    for (const e of this.cache.values()) {
      const v = e.value;
      if (v && typeof v.dispose === "function") { try { v.dispose(); } catch (err) { /* ignore */ } }
    }
    this.cache.clear();
    this.listeners.clear();
  }
}
