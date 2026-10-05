// GoldRush - sound. No sample files: every sound is synthesised here with
// WebAudio (own work, nothing to license), from filtered noise and a few
// inharmonic partials:
//   dirt / compact / gravel  - a noise "scrape" plus a spray of tiny grains
//                              (crumbling soil, clicking pebbles)
//   stone                    - a short dull knock: the hand does not get in
//   gold                     - quiet metallic ticks (inharmonic partials),
//                              brighter and longer the bigger the piece
//   shovel / pickaxe         - a deeper scoop with falling soil, a dump; the
//                              pick's thunk in soil, a metallic clank on
//                              stone, cracks and a breaking boulder
//   camp                     - gold onto a brass pan, the balance settling,
//                              a pen on the ledger; a crate lid, a soft
//                              thud when something is bought (no till, no
//                              casino sounds)
//   wash place               - water slapping in the pan, the screen's
//                              rattle, a bucket set down / tipped
// Every call varies pitch, filter and loudness a little, and sounds are
// panned / attenuated by where they happen. The AudioContext is created on
// the first user gesture (autoplay rules) and closed on exit.
//
// STATUS: provisional. These are synthesised placeholders with checked
// levels (no clipping, no silence) - nobody has judged them by ear yet.
// Every call site goes through play(kind), so real recordings can replace
// them later without touching the game code.

const rv = (a, b) => a + Math.random() * (b - a);

// per sound: make-up gain so the short, band-limited noises reach a sane
// level (measured offline: peaks around -12 dBFS for digging, quieter glitter)
const LEVEL = {
  dirt: 23, compact: 20, gravel: 24, stone: 15, air: 21, dust: 16, flake: 20, tiny: 11, nugget: 15, pickup: 44,
  shovel: 20, dump: 18, pick: 17, pickStone: 11, crack: 13, break: 14, swing: 12, swap: 16,
  scale: 14, sell: 14, shopOpen: 16, purchase: 14, insufficient: 14,
  splash: 14, rattle: 15, bucket: 16,
  // phase 6: per tool x material, transport and the sluice
  hand_dirt: 22, hand_gravel: 20, shovel_dirt: 19, shovel_gravel: 17, pickaxe_compact: 16, pickaxe_stone: 11, rock_break: 13,
  material_slide: 18, bucket_fill: 15, wheelbarrow_dump: 9, sluice_water: 13, sluice_feed: 15, sluice_cleanout: 14,
  // phase 7: the feeder's vibrating tray, the bulk hopper's slide gate
  feeder_run: 10, gate_open: 12,
  // phase 8: the barrow in your hands, hard rock that answers the pick
  barrow_take: 14, barrow_roll: 12, barrow_bump: 13, stone_scrape: 12, rock_chip: 11, rock_fracture: 12,
};

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

  // kind: hand_dirt | hand_gravel | shovel_dirt | shovel_gravel | pickaxe_compact | pickaxe_stone | rock_break
  //       | material_slide | bucket_fill | wheelbarrow_dump | sluice_water | sluice_feed | sluice_cleanout
  //       | feeder_run | gate_open
  //       | barrow_take | barrow_roll | barrow_bump | stone_scrape | rock_chip | rock_fracture
  //       | dirt | compact | gravel | stone | air | dust | flake | tiny | nugget | pickup
  //       | shovel | dump | pick | pickStone | crack | break | swing | swap
  //       | scale | sell | shopOpen | purchase | insufficient
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
      case "shovel":                                   // blade into soil: a deep scrape + crumbling load
        this._noise(out, t, rv(0.16, 0.2), { f: rv(420, 620), q: 0.8, gain: 0.32 * s, attack: 0.008 });
        this._tone(out, t, rv(62, 75), 0.09, 0.18 * s, { to: 42 });
        this._grains(out, t + 0.05, 10 + Math.floor(Math.random() * 5), 0.16, 1200, 2800, 2, 0.04 * s, 0.1 * s);
        this._noise(out, t, 0.012, { f: rv(3000, 3800), q: 4, gain: 0.05 * s, attack: 0.001 });  // steel edge
        break;
      case "dump":                                     // the load slides off and lands
        this._noise(out, t, rv(0.22, 0.3), { f: rv(500, 750), q: 0.6, gain: 0.16 * s, attack: 0.04 });
        this._grains(out, t + 0.12, 9 + Math.floor(Math.random() * 4), 0.2, 900, 2200, 2, 0.04 * s, 0.08 * s);
        this._tone(out, t + 0.16, rv(55, 70), 0.08, 0.12 * s, { to: 40 });
        break;
      case "pick":                                     // pick point into soil: a dull thunk
        this._tone(out, t, rv(95, 120), 0.07, 0.24 * s, { to: 60 });
        this._noise(out, t, 0.05, { type: "lowpass", f: rv(700, 950), q: 0.9, gain: 0.26 * s, attack: 0.002 });
        this._grains(out, t + 0.015, 5 + Math.floor(Math.random() * 3), 0.07, 1400, 2600, 2, 0.04 * s, 0.09 * s);
        break;
      case "pickStone":                                // steel on rock: a clank with a ring
        this._noise(out, t, 0.03, { type: "highpass", f: rv(1800, 2400), q: 0.7, gain: 0.22 * s, attack: 0.0008 });
        this._ting(out, t, rv(1350, 1600), 0.09 * s, 0.22, [1, 2.31, 3.87, 5.2]);
        this._tone(out, t, rv(160, 190), 0.06, 0.2 * s, { to: 120 });
        break;
      case "crack":                                    // the boulder gives a little
        this._noise(out, t, 0.02, { type: "highpass", f: rv(2500, 3200), q: 0.8, gain: 0.2 * s, attack: 0.0008 });
        this._noise(out, t + 0.012, 0.08, { type: "lowpass", f: rv(500, 700), q: 1, gain: 0.22 * s, attack: 0.002 });
        break;
      case "break":                                    // it breaks: knocks and a spray of chips
        // (0.17: four knocks close together must not add up past 0 dBFS)
        for (let i = 0; i < 4; i++) this._tone(out, t + i * rv(0.03, 0.06), rv(90, 160), 0.1, 0.17 * s, { to: 60 });
        this._noise(out, t, 0.25, { type: "lowpass", f: rv(600, 900), q: 0.7, gain: 0.26 * s, attack: 0.003 });
        this._grains(out, t + 0.04, 14, 0.3, 1600, 4200, 3, 0.05 * s, 0.12 * s);
        break;
      case "swing":                                    // a heavy tool through the air
        this._noise(out, t, rv(0.12, 0.16), { f: rv(380, 520), q: 1.4, gain: 0.08 * s, attack: 0.05 });
        break;
      case "swap":                                     // tool taken up
        this._tone(out, t, rv(180, 220), 0.05, 0.08, { to: 140 });
        this._noise(out, t + 0.02, 0.05, { f: rv(900, 1300), q: 1, gain: 0.05, attack: 0.004 });
        break;
      case "scale":                                    // the brass balance touched: a light ring and a creak
        this._ting(out, t, rv(980, 1080), 0.05 * s, 0.28, [1, 2.7, 4.9]);
        this._noise(out, t + 0.03, 0.12, { f: rv(700, 900), q: 6, gain: 0.03 * s, attack: 0.02 });
        break;
      case "sell":                                     // gold onto the pan, the beam settles, the pen on the ledger
        for (let i = 0; i < 6; i++) this._ting(out, t + i * rv(0.03, 0.05), rv(2200, 3200), 0.035, 0.08);
        this._ting(out, t + 0.28, rv(980, 1060), 0.06, 0.35, [1, 2.7, 4.9]);
        this._noise(out, t + 0.75, 0.22, { f: rv(2600, 3400), q: 1.5, gain: 0.025, attack: 0.03 });   // a few strokes of a pen
        break;
      case "shopOpen":                                 // a crate lid / a wooden hatch
        this._tone(out, t, rv(110, 130), 0.09, 0.14, { to: 80 });
        this._noise(out, t, 0.08, { type: "lowpass", f: rv(500, 700), q: 0.8, gain: 0.12, attack: 0.003 });
        break;
      case "purchase":                                 // something heavy handed over the counter
        this._tone(out, t, rv(85, 100), 0.12, 0.22, { to: 60 });
        this._noise(out, t, 0.06, { type: "lowpass", f: rv(800, 1000), q: 0.8, gain: 0.14, attack: 0.002 });
        this._ting(out, t + 0.12, rv(1400, 1600), 0.03, 0.18);
        break;
      case "insufficient":                             // a soft, dull tick - not an error buzzer
        this._tone(out, t, rv(240, 260), 0.06, 0.08, { to: 200 });
        break;
      case "splash":                                   // water slapping in the pan
        this._noise(out, t, rv(0.18, 0.26), { type: "lowpass", f: rv(900, 1300), q: 0.7, gain: 0.16 * s, attack: 0.02 });
        this._noise(out, t + 0.05, 0.12, { f: rv(2200, 2900), q: 2.5, gain: 0.04 * s, attack: 0.01 });
        break;
      case "rattle":                                   // the screen shaken: pebbles on wire
        for (let i = 0; i < 4; i++) this._noise(out, t + i * rv(0.03, 0.05), 0.04, { f: rv(1800, 2600), q: 3, gain: 0.07 * s });
        break;
      case "bucket":                                   // a tin bucket set down
        this._ting(out, t, rv(420, 480), 0.05 * s, 0.22, [1, 2.3, 3.9]);
        this._noise(out, t, 0.06, { type: "lowpass", f: rv(600, 800), q: 0.8, gain: 0.1 * s });
        break;
      // ---- phase 6: the material speaks for itself, per tool
      case "hand_dirt":                                // fingers in soft soil: a soft scrape, crumbs
        this._noise(out, t, rv(0.07, 0.1), { f: rv(850, 1250), q: 0.8, gain: 0.24 * s });
        this._grains(out, t + 0.01, 5 + Math.floor(Math.random() * 3), 0.07, 1500, 3000, 2, 0.04 * s, 0.09 * s);
        this._tone(out, t, rv(95, 115), 0.04, 0.06 * s, { to: 62 });
        break;
      case "hand_gravel":                              // fingers in gravel: pebbles click against each other
        this._noise(out, t, rv(0.06, 0.09), { f: rv(1500, 2100), q: 0.7, gain: 0.12 * s });
        this._grains(out, t, 10 + Math.floor(Math.random() * 5), 0.09, 2600, 5400, 6, 0.05 * s, 0.13 * s);
        break;
      case "shovel_dirt":                              // the blade into soil: a deep scrape, the load crumbling
        this._noise(out, t, rv(0.16, 0.2), { f: rv(400, 600), q: 0.8, gain: 0.3 * s, attack: 0.008 });
        this._tone(out, t, rv(60, 72), 0.09, 0.16 * s, { to: 42 });
        this._grains(out, t + 0.05, 9 + Math.floor(Math.random() * 4), 0.16, 1100, 2600, 2, 0.04 * s, 0.09 * s);
        this._noise(out, t, 0.012, { f: rv(3000, 3800), q: 4, gain: 0.04 * s, attack: 0.001 });
        break;
      case "shovel_gravel":                            // the blade into gravel: a brighter grind, many pebbles
        this._noise(out, t, rv(0.14, 0.18), { f: rv(900, 1300), q: 0.7, gain: 0.2 * s, attack: 0.006 });
        this._grains(out, t + 0.02, 16 + Math.floor(Math.random() * 6), 0.18, 2200, 5200, 5, 0.05 * s, 0.12 * s);
        this._noise(out, t, 0.014, { f: rv(3200, 4000), q: 4, gain: 0.06 * s, attack: 0.001 });
        break;
      case "pickaxe_compact":                          // the point into firm ground: a dull, heavy thunk
        this._tone(out, t, rv(80, 100), 0.08, 0.24 * s, { to: 52 });
        this._noise(out, t, 0.06, { type: "lowpass", f: rv(550, 800), q: 0.9, gain: 0.26 * s, attack: 0.002 });
        this._grains(out, t + 0.02, 5 + Math.floor(Math.random() * 3), 0.08, 1200, 2400, 2, 0.04 * s, 0.08 * s);
        break;
      case "pickaxe_stone":                            // steel on rock: a clank with a short ring
        this._noise(out, t, 0.03, { type: "highpass", f: rv(1800, 2400), q: 0.7, gain: 0.2 * s, attack: 0.0008 });
        this._ting(out, t, rv(1350, 1600), 0.08 * s, 0.2, [1, 2.31, 3.87, 5.2]);
        this._tone(out, t, rv(160, 190), 0.06, 0.18 * s, { to: 120 });
        this._grains(out, t + 0.02, 4, 0.06, 3000, 6000, 4, 0.03 * s, 0.06 * s);
        break;
      case "rock_break":                               // a boulder gives way: knocks, a rumble, a spray of chips
        for (let i = 0; i < 3; i++) this._tone(out, t + i * rv(0.04, 0.07), rv(80, 140), 0.12, 0.15 * s, { to: 55 });
        this._noise(out, t, 0.3, { type: "lowpass", f: rv(500, 800), q: 0.7, gain: 0.22 * s, attack: 0.004 });
        this._grains(out, t + 0.05, 14, 0.32, 1600, 4200, 3, 0.04 * s, 0.1 * s);
        break;
      case "material_slide":                           // crumbs trickling down a fresh face
        this._noise(out, t, rv(0.35, 0.5), { type: "bandpass", f: rv(1400, 2000), q: 0.8, gain: 0.04 * s, attack: 0.06 });
        this._grains(out, t + 0.03, 6 + Math.floor(Math.random() * 4), 0.45, 1800, 4200, 3, 0.02 * s, 0.05 * s);
        break;
      case "bucket_fill":                              // soil into a tin bucket
        this._noise(out, t, 0.12, { type: "lowpass", f: rv(700, 950), q: 0.8, gain: 0.16 * s, attack: 0.006 });
        this._ting(out, t + 0.01, rv(380, 440), 0.035 * s, 0.18, [1, 2.3, 3.9]);
        this._grains(out, t + 0.03, 5, 0.1, 1200, 2600, 2, 0.03 * s, 0.07 * s);
        break;
      case "wheelbarrow_dump":                         // a barrow load sliding out, landing heavily
        this._noise(out, t, rv(0.45, 0.6), { f: rv(420, 620), q: 0.6, gain: 0.18 * s, attack: 0.08 });
        this._grains(out, t + 0.1, 16, 0.5, 900, 2600, 2, 0.03 * s, 0.07 * s);
        this._tone(out, t + 0.32, rv(52, 64), 0.12, 0.16 * s, { to: 38 });
        break;
      case "sluice_water":                             // water running down the box over the riffles
        this._noise(out, t, rv(0.7, 0.9), { type: "lowpass", f: rv(1100, 1500), q: 0.5, gain: 0.1 * s, attack: 0.2 });
        this._noise(out, t + 0.1, 0.5, { f: rv(2400, 3000), q: 1, gain: 0.025 * s, attack: 0.15 });
        break;
      case "sluice_feed":                              // material into the wooden hopper
        this._noise(out, t, rv(0.25, 0.35), { f: rv(500, 700), q: 0.7, gain: 0.2 * s, attack: 0.03 });
        this._tone(out, t + 0.05, rv(95, 115), 0.08, 0.12 * s, { to: 70 });
        this._grains(out, t + 0.08, 9, 0.3, 1200, 3000, 2, 0.03 * s, 0.07 * s);
        break;
      case "sluice_cleanout":                          // brushing the mat out, water, a few bright ticks of gold
        for (let i = 0; i < 3; i++) this._noise(out, t + i * rv(0.12, 0.18), 0.09, { f: rv(1200, 1800), q: 1.5, gain: 0.08 * s, attack: 0.02 });
        this._noise(out, t + 0.1, 0.4, { type: "lowpass", f: rv(900, 1200), q: 0.6, gain: 0.06 * s, attack: 0.08 });
        for (let i = 0; i < 3; i++) this._ting(out, t + 0.25 + i * rv(0.06, 0.1), rv(2200, 2900), 0.03, 0.1);
        break;
      case "feeder_run":                               // the vibrating tray: a low hum, gravel chattering on steel
        this._tone(out, t, rv(48, 52), rv(1.1, 1.3), 0.11 * s, { attack: 0.15 });
        this._tone(out, t, rv(96, 104), rv(1.0, 1.2), 0.05 * s, { attack: 0.15 });
        this._grains(out, t + 0.05, 14, 1.1, 1500, 3800, 1.5, 0.02 * s, 0.045 * s);
        break;
      case "gate_open":                                // a steel plate scraping open, then material sliding
        this._noise(out, t, 0.22, { f: rv(2200, 2800), q: 3, gain: 0.07 * s, attack: 0.02 });
        this._tone(out, t + 0.02, rv(310, 360), 0.16, 0.06 * s, { to: 250 });
        this._noise(out, t + 0.2, rv(0.6, 0.8), { type: "lowpass", f: rv(700, 900), q: 0.7, gain: 0.14 * s, attack: 0.08 });
        this._grains(out, t + 0.25, 12, 0.6, 900, 2600, 2, 0.03 * s, 0.07 * s);
        break;
      // ---- phase 8: the barrow, hard rock
      case "barrow_take":                              // grips taken, the legs leave the ground: wood in the hands, a steel knock
        this._noise(out, t, 0.05, { type: "lowpass", f: rv(600, 800), q: 0.8, gain: 0.12 * s, attack: 0.004 });
        this._tone(out, t + 0.12, rv(150, 175), 0.07, 0.1 * s, { to: 115 });
        this._ting(out, t + 0.13, rv(520, 600), 0.03 * s, 0.14, [1, 2.4, 4.1]);
        break;
      case "barrow_roll":                              // the tyre on the ground, the frame creaking now and then
        this._noise(out, t, rv(0.5, 0.7), { type: "lowpass", f: rv(240, 340), q: 0.6, gain: 0.12 * s, attack: 0.12 });
        this._grains(out, t + 0.05, 4 + Math.floor(Math.random() * 4), 0.5, 900, 2000, 2, 0.015 * s, 0.035 * s);
        if (Math.random() < 0.45) this._tone(out, t + rv(0.05, 0.3), rv(540, 700), rv(0.08, 0.14), 0.022 * s, { to: rv(480, 560), attack: 0.03 });
        break;
      case "barrow_bump":                              // the wheel against something: a dull knock, the load shifting
        this._tone(out, t, rv(80, 100), 0.1, 0.2 * s, { to: 55 });
        this._noise(out, t, 0.08, { type: "lowpass", f: rv(450, 650), q: 0.8, gain: 0.16 * s, attack: 0.002 });
        this._grains(out, t + 0.05, 5, 0.12, 900, 2000, 2, 0.02 * s, 0.05 * s);
        break;
      case "stone_scrape":                             // a shovel blade skidding on solid rock: steel grinding, no bite
        this._noise(out, t, rv(0.12, 0.16), { f: rv(2400, 3200), q: 2.2, gain: 0.09 * s, attack: 0.004 });
        this._noise(out, t, 0.05, { type: "lowpass", f: rv(500, 700), q: 0.9, gain: 0.14 * s, attack: 0.001 });
        this._ting(out, t, rv(900, 1100), 0.04 * s, 0.12, [1, 2.6, 4.3]);
        break;
      case "rock_chip":                                // the pick bites into rock: a clank, a crack running, chips
        this._noise(out, t, 0.025, { type: "highpass", f: rv(1900, 2500), q: 0.7, gain: 0.18 * s, attack: 0.0008 });
        this._tone(out, t, rv(150, 180), 0.07, 0.17 * s, { to: 110 });
        this._noise(out, t + 0.02, 0.07, { type: "lowpass", f: rv(700, 950), q: 1, gain: 0.14 * s, attack: 0.002 });
        this._grains(out, t + 0.02, 6, 0.1, 2600, 5600, 4, 0.03 * s, 0.07 * s);
        break;
      case "rock_fracture":                            // a rock patch gives way: a crack, knocks, rubble settling
        this._noise(out, t, 0.03, { type: "highpass", f: rv(2200, 2800), q: 0.8, gain: 0.16 * s, attack: 0.0008 });
        for (let i = 0; i < 3; i++) this._tone(out, t + 0.03 + i * rv(0.04, 0.07), rv(85, 135), 0.1, 0.14 * s, { to: 58 });
        this._noise(out, t + 0.02, 0.28, { type: "lowpass", f: rv(550, 800), q: 0.7, gain: 0.18 * s, attack: 0.004 });
        this._grains(out, t + 0.06, 12, 0.3, 1500, 4000, 3, 0.03 * s, 0.08 * s);
        break;
      default: break;
    }
  }

  dispose() {
    try { if (this.ctx) this.ctx.close(); } catch (e) { /* ignore */ }
    this.ctx = null;
  }
}
