// GoldRush - central asset manager. Phase 1 builds its textures
// procedurally; GLB models, texture files and audio of later phases go
// through here: one cache per game instance, real loading progress,
// errors reported instead of thrown into the render loop, everything
// disposed with the game.

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

  dispose() {
    for (const e of this.cache.values()) {
      const v = e.value;
      if (v && typeof v.dispose === "function") { try { v.dispose(); } catch (err) { /* ignore */ } }
    }
    this.cache.clear();
    this.listeners.clear();
  }
}
