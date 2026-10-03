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
// Phase 5 (processing, 120-180 min):
//   T     tool upgrades first: all six phase-4 items, then bucket, pan, classifier
//   P     pan first: shovel -> bucket -> pan, then pickaxe / upgrades, classifier
//   K     classifier as early as possible: shovel -> bucket -> pan -> classifier
//   M     balanced: shovel, pickaxe, blade -> bucket, pan -> handle -> classifier
// With the pickaxe the bot breaks up hard ground (compact / gravel) before
// shovelling it, like a player who learned what the pickaxe is for.
// With bucket + gold pan it PROCESSES: the bucket stands next to it, every
// dig goes in until it is full, it carries it to the wash place (slower
// when full), sieves it (classifier), pans every load (each at the game's
// own minimum time + 15 %: a person, not a machine), takes the gold out,
// sells / shops from there when due, walks back and sets the bucket down
// again - all with the game's real transactions.
// Phase 6 (primitive mechanisation, up to 360 min):
//   A6    the old upgrades first (all of phase 1-5), then wheelbarrow, sluice, its upgrades
//   B6    wheelbarrow as early as possible (after bucket + pan)
//   C6    sluice as early as possible (right after the pan), then the barrow, then the usual order
//   D6    balanced
// With the wheelbarrow it digs into the barrow (parked next to it), pushes
// the full barrow (slower with the load - the game's own speed factor) to
// the sluice hopper and tips it in (water on), or - no sluice / hopper full
// - to the wash place and screens + pans the rest by hand. A sluice without a
// barrow is fed by the bucket (carried to the hopper). The sluice runs
// on in SIMULATED time while the bot does anything else (procTick); once the
// riffles are full it stops the water, cleans out (the game's work, +15 %)
// and pans the heavy concentrate. A new sluice is built on the way back
// from the shop. Pushing, dumping, parking all cost their seconds.
// Phase 7 (first automation, up to 660 min):
//   A7    the old upgrades first (all of phase 1-6), then bulk hopper, feeder, their upgrades
//   B7    bulk hopper right after the sluice
//   C7    bulk hopper and feeder right after the sluice
//   D7    balanced
// With the bulk hopper the bot pushes a full barrow to the ramp's foot and up
// it (the game's own speed factor at the ramp's grade), tips it in and - no
// feeder yet - walks to the control post and pulls the slide gate (the sluice
// hopper fills while there is room). With the feeder on AUTO it only keeps
// the water on and cleans the riffles out; the bulk hopper feeds the sluice on
// its own in simulated time while the bot digs.
// No timers, no pity: whatever the ground holds is what it finds.
//
// window.__grBench.init(seed, opts) / .run(untilSeconds) / .result()

(function () {
  const G = window.__goldrush;
  const WALK = 3.4, TRIP = 4.6;                    // m/s digging around / walking to the camp (partly sprinting)
  const SWITCH = 0.42;                             // lower + raise a tool
  const CHECK = [60, 300, 600, 1200, 1800, 2700, 3600, 5400, 7200, 9000, 10800, 12600, 14400, 16200, 18000, 19800, 21600, 25200, 28800, 32400, 36000, 39600];
  const WASH_SPOT = { x: -16.15, z: 3.5 };
  const HOPPER_SPOT = { x: -20.82, z: -4.9 };          // behind a barrow in front of the sluice hopper
  const HOPPER_FEED = { x: -20.82, z: -1.12 };         // at the hopper with a bucket
  const RAMP_FOOT = { x: -20.82, z: -10.0 };           // phase 7: behind a barrow at the loading ramp (Zone B, west)
  const RAMP_UP = 4.25 + 0.4, RAMP_GRADE = 0.4;        // up to the bulk hopper's rim
  const CONTROL = { x: -22.45, z: -2.72 };             // the control post (slide gate / lever)
  const PLATFORM = { x: -20.82, z: -4.55 };
  const BARROW_WASH = { x: -15.2, z: 5.6, yaw: Math.PI / 2 };   // parked at the wash place (feeds screen + pan)
  const BARROW_FULL_KG = 153;
  const MOUND = { x: 0, z: -6 };
  const SLOW = 1.15;                               // real work vs the game's minimum time per load
  const PICKUP = { 1: 0.4, 2: 0.4, 3: 1.0, 4: 1.1, 5: 1.4 };
  const PLANS = {
    none: [], A: ["shovel"], B: ["shovel", "shovel.blade", "pickaxe"], C: ["shovel", "pickaxe", "shovel.blade", "shovel.handle"],
    D: ["shovel", "shovel.blade", "shovel.handle", "pickaxe", "pickaxe.tip", "pickaxe.head"],
    T: ["shovel", "shovel.blade", "shovel.handle", "pickaxe", "pickaxe.tip", "pickaxe.head", "bucket", "pan", "classifier", "pan.riffles", "bucket.large"],
    P: ["shovel", "bucket", "pan", "pickaxe", "shovel.blade", "shovel.handle", "classifier", "pan.riffles", "bucket.large", "pickaxe.tip", "pickaxe.head"],
    K: ["shovel", "bucket", "pan", "classifier", "pan.riffles", "bucket.large", "pickaxe", "shovel.blade", "shovel.handle", "pickaxe.tip", "pickaxe.head"],
    M: ["shovel", "pickaxe", "shovel.blade", "bucket", "pan", "shovel.handle", "classifier", "pan.riffles", "bucket.large", "pickaxe.tip", "pickaxe.head"],
    A6: ["shovel", "pickaxe", "shovel.blade", "bucket", "pan", "shovel.handle", "classifier", "pan.riffles", "bucket.large", "pickaxe.tip", "pickaxe.head",
      "wheelbarrow", "sluice", "sluice.hopper", "sluice.mat"],
    B6: ["shovel", "bucket", "pan", "wheelbarrow", "pickaxe", "shovel.blade", "shovel.handle", "classifier", "sluice", "pan.riffles", "bucket.large",
      "sluice.hopper", "sluice.mat", "pickaxe.tip", "pickaxe.head"],
    C6: ["shovel", "bucket", "pan", "sluice", "wheelbarrow", "pickaxe", "shovel.blade", "classifier", "shovel.handle", "sluice.hopper", "pan.riffles",
      "bucket.large", "sluice.mat", "pickaxe.tip", "pickaxe.head"],
    D6: ["shovel", "pickaxe", "shovel.blade", "bucket", "pan", "shovel.handle", "wheelbarrow", "classifier", "sluice", "pan.riffles", "bucket.large",
      "sluice.hopper", "sluice.mat", "pickaxe.tip", "pickaxe.head"],
    A7: ["shovel", "pickaxe", "shovel.blade", "bucket", "pan", "shovel.handle", "classifier", "pan.riffles", "bucket.large", "pickaxe.tip", "pickaxe.head",
      "wheelbarrow", "sluice", "sluice.hopper", "sluice.mat", "bulkhopper", "feeder", "bulk.extension", "feeder.fine"],
    B7: ["shovel", "pickaxe", "shovel.blade", "bucket", "pan", "shovel.handle", "wheelbarrow", "classifier", "sluice", "bulkhopper", "pan.riffles", "bucket.large",
      "sluice.hopper", "feeder", "bulk.extension", "sluice.mat", "feeder.fine", "pickaxe.tip", "pickaxe.head"],
    C7: ["shovel", "pickaxe", "shovel.blade", "bucket", "pan", "shovel.handle", "wheelbarrow", "classifier", "sluice", "bulkhopper", "feeder", "pan.riffles",
      "bucket.large", "sluice.hopper", "feeder.fine", "sluice.mat", "bulk.extension", "pickaxe.tip", "pickaxe.head"],
    D7: ["shovel", "pickaxe", "shovel.blade", "bucket", "pan", "shovel.handle", "wheelbarrow", "classifier", "sluice", "pan.riffles", "bucket.large",
      "sluice.hopper", "bulkhopper", "pickaxe.tip", "feeder", "sluice.mat", "bulk.extension", "pickaxe.head", "feeder.fine"],
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
      this.procOn = false; this.bk = null; this.bucketMl = 0; this.capMl = 10000; this.procRounds = 0; this.procTime = 0; this.pans = 0;
      this.mechOn = false; this.bw = null; this.mechRounds = 0; this.mechTime = 0; this.cleanouts = 0; this.dumps = 0; this.ticked = this.t;
      this.bulkDumps = 0; this.gates = 0;
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

    // the sluice works on while the bot does anything else (simulated time)
    _tick() {
      const dt = this.t - this.ticked;
      if (dt > 0) G.procTick(dt);
      this.ticked = this.t;
    },

    _check() {
      for (const c of CHECK) {
        if (this.money[c] != null || this.t < c) continue;
        const e = G.economy();
        this.money[c] = this.cents;
        this.snap[c] = { cash: e.cashCents, pouch: e.pouchCents, earned: e.sold.totalCashCents, owned: G.tools().owned.slice(), upgrades: (G.tools().saved.upgrades || []).slice(), equipment: G.proc().owned.slice(), kg: Math.round(this.kg) };
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

    _trip(buy, from = null) {
      const st = G.economy();
      const assay = { x: -12.4, z: 9.25 }, supply = { x: -18.75, z: 10.35 };
      const o = from || this;
      const d = Math.hypot(assay.x - this.x, assay.z - this.z), d0 = Math.hypot(assay.x - o.x, assay.z - o.z);
      let dt = d0 / TRIP + 1.0;                                 // walk over, step up to the table
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
        const pr = G.proc();
        this.procOn = pr.owned.includes("bucket") && pr.owned.includes("pan");
        this.mechOn = this.procOn && pr.owned.includes("wheelbarrow");
        this.capMl = pr.capacityMl;
        if (pr.sluice && pr.sluice.state !== "ready") { G.procInstallSluice(); dt += 12 + 2.4; }     // over to the tank, build it
        // phase 7: build the bulk hopper / mount the feeder at the control post, the lever on AUTO
        if ((pr.bulk && pr.bulk.state !== "ready") || (pr.feeder && pr.feeder.state !== "ready")) {
          const r = G.procInstallAuto();
          dt += 14 + (pr.bulk && pr.bulk.state !== "ready" ? 2.6 : 0) + (pr.feeder && pr.feeder.state !== "ready" ? 1.8 : 0);
          if (r.feeder) { G.procFeederMode("auto"); dt += 1.5; }
        }
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

    _maybeTrip(from = null) {
      if (this.strategy === "none") return false;
      const e = G.economy();
      const pouch = e.pouchCents;
      if (!e.flags.firstSaleSeen) {
        if (pouch >= 100 || (this.t >= 300 && pouch > 0)) { this._trip(false, from); return true; }     // curious: what is it worth?
        return false;
      }
      const next = this._next();
      if (next) {
        if (next.state === "locked" && next.needs.every((n) => n.met || n.text.startsWith("auf Stein"))) this._seekStone();
        const it = this._next();
        if (it && it.state === "available" && e.cashCents + pouch >= it.price) { this._trip(true, from); return true; }
      }
      if (pouch >= 300 && this.t - this.lastTrip >= 600) { this._trip(false, from); return true; }     // now and then: cash in, see where you stand
      return false;
    },

    // processing: the bucket stands next to the bot (re-placed when it moved away)
    _ensureBucket() {
      const near = this.bk && Math.hypot(this.bk.x - this.x, this.bk.z - this.z) < 1.9;
      if (near) return;
      const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw), fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      this.bk = { x: this.x + rx * 0.55 - fx * 0.25, z: this.z + rz * 0.55 - fz * 0.25 };
      G.procPlaceBucket(this.bk.x, this.bk.z);
      this.t += 1.0;
    },

    // ---------------- phase 6: the wheelbarrow next to the bot, a full one goes to the sluice / wash place

    _ensureBarrow() {
      if (this.bw && Math.hypot(this.bw.x - this.x, this.bw.z - this.z) < 1.9) return;
      const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw), fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      // its tray beside the bot, pointing the way the bot looks
      const yaw = this.yaw, tray = { x: this.x + rx * 1.15 - fx * 0.2, z: this.z + rz * 1.15 - fz * 0.2 };
      const wheel = { x: tray.x + fx * 0.61, z: tray.z + fz * 0.61 };
      G.procBarrowPlace(wheel.x, wheel.z, yaw);
      this.bw = { x: this.x, z: this.z };
      this.t += 2.0;
    },

    // up the loading ramp: the game's factor at its grade (a full barrow: the slowest it goes)
    _pushUp(d, kg) {
      const load = Math.min(1, kg / BARROW_FULL_KG);
      const f = Math.max(0.42, (0.96 - 0.3 * load) * (1 - Math.min(0.5, RAMP_GRADE) * (0.45 + 0.9 * load)));
      return d / (WALK * f);
    },

    // pushing speed with a load (the game's own factor; slopes on the way averaged out)
    _push(d, kg) {
      const f = Math.max(0.42, 0.96 - 0.3 * Math.min(1, kg / BARROW_FULL_KG));
      return d / (WALK * f);
    },

    _panAll(maxLoads = 40) {
      let dt = 0;
      for (let i = 0; i < maxLoads; i++) {
        const f = G.procAct("pan-fill");
        if (!f.ok) break;
        const w = G.procWork(30);
        if (!w.done) break;
        G.procCollect();
        dt += 1.5 + w.t * SLOW + 1.0;
        this.pans++;
      }
      return dt;
    },

    // the barrow parked at the wash place: screen (when owned) and pan it empty, the tub in between
    _manualFromBarrow() {
      let dt = 0;
      G.procBarrowPlace(BARROW_WASH.x, BARROW_WASH.z, BARROW_WASH.yaw);
      const hasCls = G.proc().owned.includes("classifier");
      for (let guard = 0; guard < 60; guard++) {
        const p = G.proc();
        if (!p.barrow || p.barrow.batch.volumeMl <= 0) break;
        if (hasCls && p.tub.volumeMl < 29500 - 14000) {
          const r = G.procAct("sieve-load");
          if (!r.ok) break;
          const w = G.procWork(30);
          dt += 2.5 + w.t * SLOW + 1.2;
        } else {
          dt += this._panAll(hasCls ? 12 : 1);
        }
        this.t += dt; dt = 0; this._tick();
      }
      dt += this._panAll();
      return dt;
    },

    _cleanout() {
      let dt = 0;
      G.procWater(false);
      const c = G.procAct("sluice-clean");
      if (!c.ok) { G.procWater(true); return 0; }
      const w = G.procWork(30);
      dt += 1.5 + 1.0 + w.t * SLOW + 2.0;
      G.procWater(true);
      this.cleanouts++;
      dt += 6 / WALK + this._panAll();                          // to the trough, pan the heavy concentrate
      return dt;
    },

    // phase 7: a full barrow up the ramp into the bulk hopper; no feeder: pull the slide gate
    _bulkCycle(p0) {
      const kg = p0.barrow.massG / 1000;
      let dt = 2.0 + this._push(Math.hypot(RAMP_FOOT.x - this.x, RAMP_FOOT.z - this.z), kg) + this._pushUp(RAMP_UP, kg);
      this.t += dt; this.mechTime += dt; this._tick(); dt = 0;
      const moved = G.procPour("barrow", "bulk");
      if (moved > 0) { this.dumps++; this.bulkDumps++; dt += 3.0; }
      let at = PLATFORM;
      const p1 = G.proc();
      const sl = p1.sluice && p1.sluice.state === "ready";
      if (sl && !p1.sluice.running) { dt += 1.5 + Math.hypot(HOPPER_FEED.x - at.x, HOPPER_FEED.z - at.z) / WALK; at = HOPPER_FEED; G.procWater(true); }
      if (!(p1.feeder && p1.feeder.state === "ready") && sl) {
        // down to the control post: the gate fills the sluice hopper (it closes by itself)
        dt += Math.hypot(CONTROL.x - at.x, CONTROL.z - at.z) / WALK + 1.5; at = CONTROL;
        if (G.procAct("bulk-gate").ok) this.gates++;
      }
      this.t += dt; this.mechTime += dt; this._tick(); dt = 0;
      if (G.proc().sluice && G.proc().sluice.loadMl >= 240000) dt += this._cleanout();
      // what did not fit (the bulk hopper full): to the wash place, by hand
      const left = G.proc().barrow.batch.volumeMl;
      if (left > 1500) {
        dt += this._push(RAMP_UP + Math.hypot(WASH_SPOT.x - RAMP_FOOT.x, WASH_SPOT.z - RAMP_FOOT.z), left * 1.4 / 1000) + 2.0;
        this.t += dt; this.mechTime += dt; this._tick(); dt = 0;
        dt += this._manualFromBarrow();
        at = WASH_SPOT;
      } else if (at === PLATFORM) at = RAMP_FOOT;
      if (G.proc().sluice && G.proc().sluice.tray.volumeMl > 0) dt += this._panAll();
      this.t += dt; this.mechTime += dt; this.mechRounds++; this._tick();
      this.bucketMl = 0;
      this._check();
      if (!this._maybeTrip(at)) {
        const back = 2.0 + this._push(Math.hypot(at.x - this.x, at.z - this.z) + (at === RAMP_FOOT ? RAMP_UP : 0), 0);
        this.t += back; this.mechTime += back;
      }
      this._tick();
      this.bw = null;
      this._ensureBarrow();
      G.aimAt({ x: this.x, z: this.z, yaw: this.yaw, pitch: this.pitch });
    },

    // a full barrow: push it to the hopper (and tip it), or to the wash place
    _mechCycle() {
      const p0 = G.proc();
      if (p0.bulk && p0.bulk.state === "ready") return this._bulkCycle(p0);
      const kg = p0.barrow.massG / 1000;
      const sl = p0.sluice && p0.sluice.state === "ready";
      const dest = sl ? HOPPER_SPOT : WASH_SPOT;
      let dt = 2.0 + this._push(Math.hypot(dest.x - this.x, dest.z - this.z), kg);
      this.t += dt; this.mechTime += dt; this._tick(); dt = 0;
      if (sl) {
        const moved = G.procPour("barrow", "hopper");
        if (moved > 0) { this.dumps++; dt += 3.0; }
        if (!G.proc().sluice.running) { G.procWater(true); dt += 1.5; }
        this.t += dt; this.mechTime += dt; this._tick(); dt = 0;
        if (G.proc().sluice.loadMl >= 240000) dt += this._cleanout();
        // what did not fit: to the wash place, by hand
        const left = G.proc().barrow.batch.volumeMl;
        if (left > 1500) dt += this._push(Math.hypot(WASH_SPOT.x - HOPPER_SPOT.x, WASH_SPOT.z - HOPPER_SPOT.z), left * 1.4 / 1000) + 2.0;
        this.t += dt; this.mechTime += dt; this._tick(); dt = 0;
        if (left > 1500) dt += this._manualFromBarrow();
      } else dt += this._manualFromBarrow();
      // heavy concentrate waiting in the tray (a cleanout earlier): pan it
      if (G.proc().sluice && G.proc().sluice.tray.volumeMl > 0) dt += this._panAll();
      this.t += dt; this.mechTime += dt; this.mechRounds++; this._tick();
      this.bucketMl = 0;
      this._check();
      const from = sl ? HOPPER_SPOT : WASH_SPOT;
      if (!this._maybeTrip(from)) {
        const back = 2.0 + this._push(Math.hypot(from.x - this.x, from.z - this.z), 0);
        this.t += back; this.mechTime += back;
      }
      this._tick();
      this.bw = null;
      this._ensureBarrow();
      G.aimAt({ x: this.x, z: this.z, yaw: this.yaw, pitch: this.pitch });
    },

    // a sluice but no barrow (yet): the full bucket goes into the hopper (water on);
    // the riffles are cleaned out once loaded, the heavy concentrate panned
    _bucketToHopper(p0) {
      const kg = p0.bucket.massG / 1000, carry = WALK * (1 - 0.15 * Math.min(1.4, kg / 16));
      let dt = 1.0 + Math.hypot(HOPPER_FEED.x - this.x, HOPPER_FEED.z - this.z) / carry + 1.5;    // pick it up, carry it over, tip it in
      G.procPour("bucket", "hopper");
      this.dumps++;
      if (!G.proc().sluice.running) { G.procWater(true); dt += 1.5; }
      this.t += dt; this.procTime += dt; this._tick(); dt = 0;
      if (G.proc().sluice.loadMl >= 240000) dt += this._cleanout();
      if (G.proc().sluice.tray.volumeMl > 0) dt += this._panAll();
      this.t += dt; this.procTime += dt; this.procRounds++; this._tick();
      this.bucketMl = 0;
      this._check();
      if (!this._maybeTrip(HOPPER_FEED)) {
        const back = Math.hypot(HOPPER_FEED.x - this.x, HOPPER_FEED.z - this.z) / WALK + 1.0;
        this.t += back; this.procTime += back;
      }
      this._tick();
      this.bk = null;
      this._ensureBucket();
      G.aimAt({ x: this.x, z: this.z, yaw: this.yaw, pitch: this.pitch });
    },

    // a full bucket: carry it to the wash place, sieve, pan everything, back
    // (or into the sluice hopper when there is a sluice with room)
    _procCycle() {
      const p0 = G.proc();
      const sl0 = p0.sluice && p0.sluice.state === "ready" ? p0.sluice : null;
      if (sl0 && sl0.hopper.volumeMl + p0.bucket.batch.volumeMl <= sl0.capacityMl) return this._bucketToHopper(p0);
      const kg = p0.bucket.massG / 1000, carry = WALK * (1 - 0.15 * Math.min(1.4, kg / 16));
      const d = Math.hypot(WASH_SPOT.x - this.x, WASH_SPOT.z - this.z);
      let dt = 1.0 + d / carry + 1.0;                           // pick it up, carry it over, set it down
      G.procBucketToWash();
      if (p0.owned.includes("classifier")) {
        const r = G.procAct("sieve-load");
        if (r.ok) { const w = G.procWork(30); dt += 1.2 + 1.0 + w.t * SLOW + 1.2; }     // to the screen, tip it, shake, to the trough
      }
      for (let i = 0; i < 24; i++) {
        const f = G.procAct("pan-fill");
        if (!f.ok) break;
        const w = G.procWork(30);
        if (!w.done) break;
        G.procCollect();
        dt += 1.5 + w.t * SLOW + 1.0;                           // fill the pan, swirl, take the gold out
        this.pans++;
      }
      this.t += dt; this.procTime += dt; this.procRounds++;
      this.bucketMl = 0;
      this._check();
      if (!this._maybeTrip(WASH_SPOT)) {                        // sell / shop from here, or straight back
        const back = Math.hypot(WASH_SPOT.x - this.x, WASH_SPOT.z - this.z) / WALK + 1.0;
        this.t += back; this.procTime += back;
      }
      this.bk = null;
      this._ensureBucket();
      G.aimAt({ x: this.x, z: this.z, yaw: this.yaw, pitch: this.pitch });
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
          // towards the mound until something is in reach (it is huge - on the way there is
          // always a face); right at its middle and still nothing: look round
          if (this._scan(this.yaw)) { this.state = "dig"; this.t += 0.3; continue; }
          if (this.digs === 0) {
            // the first walk from the claim entrance: straight ahead (as calibrated in phase 4)
            this._move(0.25, this.yaw);
            if (this.walked > 40) { this.yaw += 0.5; this.walked = 0; }
            continue;
          }
          const dx = MOUND.x - this.x, dz = MOUND.z - this.z;
          if (Math.hypot(dx, dz) > 4) this.yaw = Math.atan2(-dx, -dz) + (r() - 0.5) * 0.4;
          else if (this.walked > 6) { this.yaw += 0.9; this.walked = 0; }
          this._move(0.25, this.yaw);
          continue;
        }
        this._tick();
        if (this.mechOn) this._ensureBarrow();
        else if (this.procOn) this._ensureBucket();
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
        if (this.mechOn) {
          this.bucketMl += res.intoMl || 0;
          if (this.bucketMl >= 85000 - 200 || res.spilledMl > 0) { this._mechCycle(); continue; }
        } else if (this.procOn) {
          this.bucketMl += res.intoMl || 0;
          if (this.bucketMl >= this.capMl - 50 || res.spilledMl > 0) { this._procCycle(); continue; }
        }
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
        procRounds: this.procRounds, procTime: +this.procTime.toFixed(1), pans: this.pans, ledger: G.proc().ledger, equipment: G.proc().owned,
        mechRounds: this.mechRounds, mechTime: +this.mechTime.toFixed(1), cleanouts: this.cleanouts, dumps: this.dumps,
        sluice: G.proc().sluice ? { processedMl: G.proc().sluice.stats.processedMl, cleanouts: G.proc().sluice.stats.cleanouts, tailMl: G.proc().sluice.tailMl } : null,
        bulk: G.proc().bulk ? { inMl: G.proc().bulk.stats.inMl, outMl: G.proc().bulk.stats.outMl, loads: G.proc().bulk.stats.loads, left: G.proc().bulk.volumeMl } : null,
        feeder: G.proc().feeder ? { moved: G.proc().feeder.moved, mode: G.proc().feeder.mode } : null,
        bulkDumps: this.bulkDumps, gates: this.gates, activeProcTime: +(this.procTime + this.mechTime).toFixed(1), pouchCents: e.pouchCents,
        containersUg: G.proc().inContainersUg,
        firstSale: this.firstSaleT != null ? +this.firstSaleT.toFixed(1) : null,
        removedM3: e.stats.volumeMl / 1e6,
        cash: e.cashCents, earned: e.sold.totalCashCents, spent: e.shop.spentCents, sales: e.sold.sales, largestSale: e.sold.largestSaleCents,
      };
    },
  };
  window.__grBench = B;
})();
