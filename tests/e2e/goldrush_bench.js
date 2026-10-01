// GoldRush - canonical economy benchmark: a simulated player.
//
// Injected into a running GoldRush page (test hooks, fixed seed) by
// goldrush_bench.py. The bot plays in SIMULATED time - every second it
// "spends" is accounted for:
//   - a moment to look around after spawning, then walking (3.4 m/s) from
//     the claim entrance straight at the mound until something diggable is
//     in reach (real reach of the tool, real raycasts against the world)
//   - every action costs the tool's real cycle time for the material it hit
//     (goldrush-tools.js, with the upgrades it owns: windup + recover;
//     stone: bounce off); switching tools costs the lower/raise time
//   - the crosshair wanders a little while digging, every ~60 actions the
//     player steps aside to a fresh patch (working along the face), stone /
//     boulders / an empty crosshair cost time to re-aim or step closer; when
//     the ground has turned hard (compact / gravel) it walks back to the
//     last soft patch - before it owns a pickaxe
//   - every transaction is the game's own (mining, depletion, finds, the
//     pouch, selling, buying); finds go into the pouch right away (a pickup
//     takes ~1 s, added to the time)
//   - money only exists after a SALES TRIP: walking to the camp (real
//     distance), the scale, maybe the supply counter, walking back
// Strategies (plan = what it saves for, in order):
//   none  never sells (phase-3 style: the gold value it digs up)
//   A     straight for the shovel, then keeps working
//   B     shovel -> blade upgrade -> pickaxe
//   C     shovel -> pickaxe -> both shovel upgrades
//   D     shovel -> both shovel upgrades -> pickaxe -> both pickaxe upgrades
// With the pickaxe the bot breaks up hard ground (compact / gravel) before
// shovelling it, like a player who learned what the pickaxe is for.
// No timers, no pity: whatever the ground holds is what it finds.
//
// window.__grBench.init(seed, opts) / .run(untilSeconds) / .result()

(function () {
  const G = window.__goldrush;
  const WALK = 3.4, TRIP = 4.6;                    // m/s digging around / walking to the camp (partly sprinting)
  const SWITCH = 0.42;                             // lower + raise a tool
  const CHECK = [60, 300, 600, 1200, 1800, 2700, 3600, 5400];
  const PICKUP = { 1: 0.4, 2: 0.4, 3: 1.0, 4: 1.1, 5: 1.4 };
  const PLANS = {
    none: [], A: ["shovel"], B: ["shovel", "shovel.blade", "pickaxe"], C: ["shovel", "pickaxe", "shovel.blade", "shovel.handle"],
    D: ["shovel", "shovel.blade", "shovel.handle", "pickaxe", "pickaxe.tip", "pickaxe.head"],
  };

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
      this.strategy = opts.strategy || "none";
      this.plan = [...(PLANS[this.strategy] || [])];
      this.tool = opts.tool || "hand";                 // the digging tool in the hands
      if (this.tool !== "hand") G.equipNow(this.tool);
      this._defs();
      this.r = rng(seed * 7919 + 13);
      this.t = 1.5;                                    // looking around after spawning
      this.x = 0.6; this.z = 10.2; this.yaw = 0; this.pitch = 0;
      this.actions = 0; this.digs = 0; this.blocked = 0; this.reaims = 0; this.walked = 0; this.picks = 0;
      this.first = { find: null, flake: null, tiny: null, nugget: null };
      this.money = {}; this.snap = {};
      this.nuggets = [];
      this.kg = 0;
      this.trips = 0; this.tripTime = 0; this.lastTrip = 0; this.log = [];
      this.win = { n: 0, hard: 0 }; this.good = null; this.side = this.r() < 0.5 ? -1 : 1; this.returns = 0;
      this.bought = {};
      this.state = "walk";
      return true;
    },

    _defs() {
      const defs = G.toolDefs();
      this.info = {};
      for (const d of defs) this.info[d.id] = d;
      const d = this.info[this.tool];
      this.reach = d.reach;
      this.cycle = d.cycle;                            // [dirt, compact, gravel, stone(bounce)]
      this.airCycle = d.cycle[0] * 0.8;
    },

    get cents() { const e = G.economy(); return e.cashCents + e.pouchCents + e.shop.spentCents; },   // all value dug up so far

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
      for (const c of CHECK) {
        if (this.money[c] != null || this.t < c) continue;
        const e = G.economy();
        this.money[c] = this.cents;
        this.snap[c] = { cash: e.cashCents, pouch: e.pouchCents, earned: e.sold.totalCashCents, owned: G.tools().owned.slice(), upgrades: (G.tools().saved.upgrades || []).slice(), kg: Math.round(this.kg) };
      }
    },

    // ---------------- selling and buying (strategy runs)

    _next() {
      while (this.plan.length && this.bought[this.plan[0]] != null) this.plan.shift();
      if (!this.plan.length) return null;
      return G.shopView().items.find((i) => i.id === this.plan[0]) || null;
    },

    // the player has never come up against stone: the pickaxe stays locked.
    // A player saving for it goes and looks at a boulder (walk + time).
    _seekStone() {
      const rocks = G.rocks().filter((r) => !r.broken).sort((a, b) => Math.hypot(a.x - this.x, a.z - this.z) - Math.hypot(b.x - this.x, b.z - this.z));
      for (const R of rocks.slice(0, 4)) {
        const ang = Math.atan2(R.x, R.z + 6), px = R.x + Math.sin(ang) * 1.6, pz = R.z + Math.cos(ang) * 1.6;
        const yaw = Math.atan2(-(R.x - px), -(R.z - pz));
        for (let pt = 0.3; pt > -1.2; pt -= 0.05) {
          G.aimAt({ x: px, z: pz, yaw, pitch: pt });
          if (G.flags().hardSeen) {
            const d = Math.hypot(px - this.x, pz - this.z);
            this.t += (2 * d) / TRIP + 3;                       // there and back, a look at it
            this.tripTime += (2 * d) / TRIP + 3;
            G.aimAt({ x: this.x, z: this.z, yaw: this.yaw, pitch: this.pitch });
            return true;
          }
        }
      }
      return false;
    },

    _trip(buy) {
      const st = G.economy();
      const assay = { x: -12.4, z: 9.25 }, supply = { x: -18.75, z: 10.35 };
      const d = Math.hypot(assay.x - this.x, assay.z - this.z);
      let dt = d / TRIP + 1.0;                                  // walk over, step up to the table
      const entry = { t: Math.round(this.t), sold: 0, cash: 0, bought: [] };
      if (st.pouchUg > 0) {
        if (!st.flags.firstSaleSeen) this.firstSaleT = this.t + dt + 1.2;
        entry.sold = G.sell().cents; dt += 3.2;                 // the scale, the count, read it
      }
      if (buy) {
        dt += Math.hypot(supply.x - assay.x, supply.z - assay.z) / TRIP + 4.0;   // next door, look at the shelf
        let item = this._next();
        while (item && item.state === "available" && G.economy().cashCents >= item.price) {
          const r = G.buy(item.id);
          if (!r.ok) break;
          this.bought[item.id] = this.t + dt;
          entry.bought.push(item.id);
          dt += 1.5;
          if (item.id === "shovel") { this.tool = "shovel"; dt += SWITCH; }
          item = this._next();
        }
        G.equipNow(this.tool);
        this._defs();
      }
      dt += d / TRIP + 1.5;                                     // back to the spot, find it again
      entry.cash = G.economy().cashCents;
      this.log.push(entry);
      this.t += dt;
      this.tripTime += dt;
      this.trips++;
      this.lastTrip = this.t;
      G.aimAt({ x: this.x, z: this.z, yaw: this.yaw, pitch: this.pitch });
    },

    _maybeTrip() {
      if (this.strategy === "none") return;
      const e = G.economy();
      const pouch = e.pouchCents;
      if (!e.flags.firstSaleSeen) {
        if (pouch >= 100 || (this.t >= 300 && pouch > 0)) this._trip(false);     // curious: what is it worth?
        return;
      }
      const next = this._next();
      if (next) {
        if (next.state === "locked" && next.needs.every((n) => n.met || n.text.startsWith("auf Stein"))) this._seekStone();
        const it = this._next();
        if (it && it.state === "available" && e.cashCents + pouch >= it.price) { this._trip(true); return; }
      }
      if (pouch >= 300 && this.t - this.lastTrip >= 600) this._trip(false);       // now and then: cash in, see where you stand
    },

    // with a pickaxe: hard ground (compact / gravel, not loose yet) gets broken up first
    _loosen() {
      if (!this.bought.pickaxe) return;
      const p = G.probe();
      if (!p || p.boulder != null || p.loose > 0 || !(p.material === "compactDirt" || p.material === "gravel")) return;
      const pc = this.info.pickaxe.cycle;
      this.t += SWITCH;
      for (let i = 0; i < 3; i++) {
        const q = G.act({ visuals: false, tool: "pickaxe" });
        this.picks++;
        this.t += q && q.material != null ? pc[q.material] || pc[0] : pc[0];
        if (q && q.massKg) this.kg += q.massKg;
      }
      this.t += SWITCH;
    },

    // working along the face: mostly on in one direction, now and then the
    // other way. Hard ground (compact / gravel) is slow by hand or shovel -
    // a player feels that and goes back to the last soft patch, then works
    // the other way; with the pickaxe it gets broken up instead (_loosen).
    _patch() {
      const hard = this.win.hard / Math.max(1, this.win.n);
      this.win.n = this.win.hard = 0;
      if (hard < 0.35 || this.bought.pickaxe) this.good = { x: this.x, z: this.z, yaw: this.yaw };
      else if (hard > 0.5 && this.good) {
        const d = Math.hypot(this.good.x - this.x, this.good.z - this.z);
        if (d > 0.3) {
          this.t += d / WALK + 0.6;
          this.x = this.good.x; this.z = this.good.z; this.yaw = this.good.yaw;
          this.side = -this.side;
          this.returns++;
          return;
        }
      }
      if (this.r() < 0.25) this.side = -this.side;
    },

    run(until) {
      const r = this.r;
      let guard = 0;
      while (this.t < until && guard++ < 400000) {
        if (this.state === "walk") {
          // straight at the mound until something is in reach
          if (this._scan(this.yaw)) { this.state = "dig"; this.t += 0.3; continue; }
          this._move(0.25, this.yaw);
          if (this.walked > 40) { this.yaw += 0.5; this.walked = 0; }
          continue;
        }
        this._loosen();
        const res = G.act({ visuals: false, tool: this.tool });
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
        this.win.n++;
        if (res.material !== 0) this.win.hard++;
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
        this._maybeTrip();
        // the hand wanders a little; every ~60 actions a fresh patch next to it
        if (this.digs % 12 === 0) {
          const y = this.yaw + (r() - 0.5) * 0.12, p = this.pitch + (r() - 0.5) * 0.06;
          if (this._aim(this.x, this.z, y, p) > 0) { this.yaw = y; this.pitch = p; } else this._aim(this.x, this.z, this.yaw, this.pitch);
        }
        if (this.digs % 60 === 0) {
          this._patch();
          const side = this.yaw + this.side * Math.PI / 2;
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
        strategy: this.strategy, tool: this.tool, t: +this.t.toFixed(1), actions: this.actions, digs: this.digs, blocked: this.blocked, reaims: this.reaims, picks: this.picks, returns: this.returns,
        kg: +this.kg.toFixed(1), first: this.first, money: this.money, snap: this.snap, nuggets: this.nuggets.length,
        biggestNuggetCents: e.stats.biggestNuggetCents, finds: e.stats.finds, slices: e.stats.slices,
        massG: e.stats.massG, x: +this.x.toFixed(2), z: +this.z.toFixed(2), starter: G.starter(),
        trips: this.trips, tripTime: +this.tripTime.toFixed(1), bought: this.bought, tripLog: this.log,
        firstSale: this.firstSaleT != null ? +this.firstSaleT.toFixed(1) : null,
        removedM3: e.stats.volumeMl / 1e6,
        cash: e.cashCents, earned: e.sold.totalCashCents, spent: e.shop.spentCents, sales: e.sold.sales, largestSale: e.sold.largestSaleCents,
      };
    },
  };
  window.__grBench = B;
})();
