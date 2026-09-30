// GoldRush - sound. No sample files: every sound is synthesised here with
// WebAudio (own work, nothing to license), from filtered noise and a few
// inharmonic partials:
//   dirt / compact / gravel  - a noise "scrape" plus a spray of tiny grains
//                              (crumbling soil, clicking pebbles)
//   stone                    - a short dull knock: the hand does not get in
//   gold                     - quiet metallic ticks (inharmonic partials),
//                              brighter and longer the bigger the piece
// Every call varies pitch, filter and loudness a little, and sounds are
// panned / attenuated by where they happen. The AudioContext is created on
// the first user gesture (autoplay rules) and closed on exit.

const rv = (a, b) => a + Math.random() * (b - a);

// per sound: make-up gain so the short, band-limited noises reach a sane
// level (measured offline: peaks around -12 dBFS for digging, quieter glitter)
const LEVEL = { dirt: 23, compact: 20, gravel: 24, stone: 15, air: 21, dust: 16, flake: 20, tiny: 11, nugget: 15, pickup: 44 };

export class GoldRushAudio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.volume = 0.75;
  }

  // call from a user gesture (click / key / touch)
  unlock() {
    if (!this.enabled) return;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ctx = (this.ctx = new AC());
        this.master = ctx.createGain();
        this.master.gain.value = this.volume;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.ratio.value = 4;
        this.master.connect(comp).connect(ctx.destination);
        const len = ctx.sampleRate;                   // 1 s of white noise, reused by everything
        this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    } catch (e) { this.ctx = null; }
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (this.master) this.master.gain.value = this.enabled ? this.volume : 0;
  }

  get ready() { return !!(this.enabled && this.ctx && this.ctx.state === "running"); }

  _out(pan, dist, level = 1) {
    const c = this.ctx, g = c.createGain();
    g.gain.value = level / (1 + 0.35 * Math.max(0, dist));
    if (c.createStereoPanner) {
      const p = c.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p).connect(this.master);
    } else g.connect(this.master);
    return g;
  }

  _noise(dest, t0, dur, { type = "bandpass", f = 1000, q = 1, gain = 0.2, attack = 0.003 }) {
    const c = this.ctx, src = c.createBufferSource();
    src.buffer = this.noise;
    const flt = c.createBiquadFilter();
    flt.type = type;
    flt.frequency.value = f;
    flt.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + dur);
    src.connect(flt).connect(g).connect(dest);
    src.start(t0, Math.random() * 0.8, attack + dur + 0.02);
  }

  _tone(dest, t0, freq, dur, gain, { type = "sine", to = 0, attack = 0.002 } = {}) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + dur);
    o.connect(g).connect(dest);
    o.start(t0);
    o.stop(t0 + attack + dur + 0.02);
  }

  _grains(dest, t0, n, spread, f0, f1, q, g0, g1) {
    for (let i = 0; i < n; i++) {
      this._noise(dest, t0 + Math.random() * spread, rv(0.004, 0.011), { type: "bandpass", f: rv(f0, f1), q, gain: rv(g0, g1), attack: 0.001 });
    }
  }

  // metallic tick: inharmonic partials of a small piece of gold
  _ting(dest, t0, f, gain, decay, ratios = [1, 2.76, 5.4]) {
    ratios.forEach((r, i) => this._tone(dest, t0, f * r, decay / (1 + i * 0.6), gain / (1 + i * 1.3)));
  }

  // kind: dirt | compact | gravel | stone | air | dust | flake | tiny | nugget | pickup
  play(kind, { pan = 0, dist = 1.5, strength = 1 } = {}) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + 0.005, out = this._out(pan, dist, LEVEL[kind] || 1), s = strength;
    switch (kind) {
      case "dirt":
        this._noise(out, t, rv(0.09, 0.13), { f: rv(750, 1150), q: 0.9, gain: 0.3 * s });
        this._grains(out, t + 0.01, 8 + Math.floor(Math.random() * 4), 0.08, 1800, 3600, 2, 0.05 * s, 0.12 * s);
        this._tone(out, t, rv(85, 105), 0.05, 0.1 * s, { to: 55 });
        break;
      case "compact":
        this._noise(out, t, rv(0.07, 0.1), { f: rv(480, 700), q: 1.1, gain: 0.28 * s });
        this._grains(out, t + 0.01, 4 + Math.floor(Math.random() * 3), 0.06, 1100, 2200, 2, 0.05 * s, 0.1 * s);
        this._tone(out, t, rv(70, 88), 0.06, 0.15 * s, { to: 48 });
        break;
      case "gravel":
        this._noise(out, t, rv(0.08, 0.11), { f: rv(1300, 1900), q: 0.7, gain: 0.18 * s });
        this._grains(out, t, 12 + Math.floor(Math.random() * 6), 0.1, 2400, 5200, 6, 0.06 * s, 0.16 * s);
        break;
      case "stone":
        this._noise(out, t, 0.045, { type: "lowpass", f: rv(600, 800), q: 0.8, gain: 0.34 * s, attack: 0.0015 });
        this._tone(out, t, rv(140, 165), 0.08, 0.22 * s, { to: 110 });
        this._noise(out, t, 0.012, { f: rv(2100, 2700), q: 3, gain: 0.1 * s, attack: 0.001 });
        break;
      case "air":
        this._noise(out, t, 0.11, { f: rv(420, 560), q: 0.7, gain: 0.05, attack: 0.03 });
        break;
      case "dust":
        for (let i = 0; i < 3 + Math.floor(Math.random() * 3); i++) this._tone(out, t + rv(0, 0.09), rv(5200, 8800), rv(0.05, 0.09), rv(0.014, 0.026));
        break;
      case "flake":
        this._ting(out, t, rv(2300, 2800), 0.06, 0.12);
        this._noise(out, t, 0.008, { f: 5000, q: 2, gain: 0.03, attack: 0.001 });
        break;
      case "tiny":
        this._ting(out, t, rv(1650, 1950), 0.08, 0.2);
        this._ting(out, t + rv(0.07, 0.1), rv(1650, 1950) * 1.03, 0.045, 0.14);
        break;
      case "nugget":
        this._noise(out, t, 0.03, { type: "lowpass", f: 900, q: 0.8, gain: 0.12, attack: 0.002 });
        this._ting(out, t + 0.01, rv(1150, 1300), 0.1, 0.36, [1, 2.4, 3.9, 6.1]);
        for (let i = 0; i < 3; i++) this._tone(out, t + 0.06 + i * rv(0.05, 0.08), rv(2600, 4200), 0.45, 0.018);
        break;
      case "pickup":
        this._noise(out, t, 0.02, { f: rv(2600, 3400), q: 2, gain: 0.06, attack: 0.002 });
        this._tone(out, t + 0.004, rv(1700, 1950), 0.06, 0.025);
        break;
      default: break;
    }
  }

  dispose() {
    try { if (this.ctx) this.ctx.close(); } catch (e) { /* ignore */ }
    this.ctx = null;
  }
}
