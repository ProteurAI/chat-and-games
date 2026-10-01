// GoldRush - canonical economy benchmark: a simulated first-time player.
//
// Injected into a running GoldRush page (test hooks, fixed seed) by
// goldrush_bench.py. The bot plays like a newcomer with bare hands, in
// SIMULATED time - every second it "spends" is accounted for:
//   - a moment to look around after spawning, then walking (3.4 m/s) from
//     the claim entrance straight at the mound until something diggable is
//     in reach (real reach of the tool, real raycasts against the world)
//   - every action costs the tool's real cycle time for the material it hit
//     (goldrush-tools.js: windup + recover; stone: bounce off)
//   - the crosshair wanders a little while digging, every ~60 actions the
//     player steps aside to a fresh patch, stone / boulders / an empty
//     crosshair cost time to re-aim or step closer
//   - every transaction is the game's own (mining, depletion, finds); the
//     finds are collected right away (a pickup takes ~1 s, added to the time)
// No timers, no pity: whatever the ground holds is what it finds.
//
// window.__grBench.init(seed, opts) / .run(untilSeconds) / .result()

(function () {
  const G = window.__goldrush;
  const WALK = 3.4;
  const CHECK = [60, 300, 600, 1200, 1800];
  const PICKUP = { 1: 0.4, 2: 0.4, 3: 1.0, 4: 1.1, 5: 1.4 };

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const B = {
    init(seed, opts = {}) {
      const tool = opts.tool || "hand";
      const info = G.toolDefs().find((d) => d.id === tool);
      this.tool = tool;
      this.reach = info.reach;
      this.cycle = info.cycle;                         // [dirt, compact, gravel, stone(bounce)]
      this.airCycle = info.cycle[0] * 0.8;
      this.r = rng(seed * 7919 + 13);
      this.t = 1.5;                                    // looking around after spawning
      this.x = 0.6; this.z = 10.2; this.yaw = 0; this.pitch = 0;
      this.actions = 0; this.digs = 0; this.blocked = 0; this.reaims = 0; this.steps = 0; this.walked = 0;
      this.first = { find: null, flake: null, tiny: null, nugget: null };
      this.money = {};
      this.nuggets = [];
      this.kg = 0;
      this.state = "walk";
      return true;
    },

    _aim(x, z, yaw, pitch) {
      const d = G.aimAt({ x, z, yaw, pitch });
      if (d == null || d > this.reach - 0.05) return null;
      const a = G.aim();
      return a.state === "dig" ? d : (a.state === "hard" ? -1 : null);
    },

    // a pitch at this spot that puts the crosshair on diggable ground in reach
    _scan(yaw) {
      for (let pt = -0.15; pt > -1.25; pt -= 0.06) {
        const d = this._aim(this.x, this.z, yaw, pt);
        if (d != null && d > 0) { this.yaw = yaw; this.pitch = pt; return true; }
      }
      return false;
    },

    _move(dist, dirYaw) {
      this.x += -Math.sin(dirYaw) * dist;
      this.z += -Math.cos(dirYaw) * dist;
      this.t += Math.abs(dist) / WALK;
      this.walked += Math.abs(dist);
    },

    _reaim() {
      this.reaims++;
      this.t += 0.35;
      if (this._scan(this.yaw)) return true;
      for (let k = 0; k < 8; k++) {
        this._move(0.2, this.yaw);
        this.t += 0.1;
        if (this._scan(this.yaw)) return true;
      }
      // nothing here: turn a little and try again
      this.yaw += (this.r() - 0.5) * 0.9;
      this.t += 0.6;
      return this._scan(this.yaw);
    },

    _check() {
      for (const c of CHECK) if (this.money[c] == null && this.t >= c) this.money[c] = this.cents;
    },

    get cents() { return G.economy().moneyCents; },

    run(until) {
      const r = this.r;
      let guard = 0;
      while (this.t < until && guard++ < 200000) {
        if (this.state === "walk") {
          // straight at the mound until something is in reach
          if (this._scan(this.yaw)) { this.state = "dig"; this.t += 0.3; continue; }
          this._move(0.25, this.yaw);
          if (this.walked > 40) { this.yaw += 0.5; this.walked = 0; }
          continue;
        }
        const res = G.act({ visuals: false });
        this.actions++;
        if (!res || !res.ok) {
          this.t += this.airCycle;
          if (!this._reaim()) this.state = "walk";
          continue;
        }
        if (res.blocked || res.kind === "rock") {
          this.blocked++;
          this.t += this.cycle[3];
          // try somewhere else on the face
          this.yaw += (r() < 0.5 ? -1 : 1) * (0.25 + r() * 0.3);
          this.t += 0.5;
          if (!this._scan(this.yaw)) this._reaim();
          this._check();
          continue;
        }
        this.digs++;
        this.kg += res.massKg;
        this.t += this.cycle[res.material] || this.cycle[0];
        if (res.finds) {
          const at = this.t + (PICKUP[res.best] || 0.5);
          if (this.first.find == null) this.first.find = at;
          if (res.best >= 3 && this.first.flake == null) this.first.flake = at;
          if (res.best >= 4 && this.first.tiny == null) this.first.tiny = at;
          if (res.best >= 5) { if (this.first.nugget == null) this.first.nugget = at; this.nuggets.push(at); }
        }
        this._check();
        // the hand wanders a little; every ~60 actions a fresh patch next to it
        if (this.digs % 12 === 0) {
          const y = this.yaw + (r() - 0.5) * 0.12, p = this.pitch + (r() - 0.5) * 0.06;
          if (this._aim(this.x, this.z, y, p) > 0) { this.yaw = y; this.pitch = p; } else this._aim(this.x, this.z, this.yaw, this.pitch);
        }
        if (this.digs % 60 === 0) {
          const side = this.yaw + (r() < 0.5 ? -1 : 1) * Math.PI / 2;
          this._move(0.6, side);
          this.t += 0.6;
          if (!this._scan(this.yaw)) this._reaim();
        }
      }
      this._check();
      return { t: this.t, actions: this.actions, cents: this.cents };
    },

    result() {
      const e = G.economy();
      return {
        tool: this.tool, t: +this.t.toFixed(1), actions: this.actions, digs: this.digs, blocked: this.blocked, reaims: this.reaims,
        kg: +this.kg.toFixed(1), first: this.first, money: this.money, nuggets: this.nuggets.length,
        biggestNuggetCents: e.stats.biggestNuggetCents, inventory: e.inventory, finds: e.stats.finds, slices: e.stats.slices,
        massG: e.stats.massG, x: +this.x.toFixed(2), z: +this.z.toFixed(2), starter: G.starter(),
      };
    },
  };
  window.__grBench = B;
})();
