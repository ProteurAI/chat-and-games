// GoldRush - the compact wheel loader (Prompt 10): the machine that moves the
// stockpiles - raw pay dirt from the excavator's pile to the plant's intake,
// oversize and tailings out of the way. It never digs the mountain.
//
//   DRIVING     articulated steering: the front frame turns on the joint (A / D,
//               + = left), the rear follows on the arc (heading rate = v sin g /
//               (lf cos g + lr)). Released, the joint eases back towards straight
//               (an assisted centre - keys are no steering wheel). W / S throttle
//               and brake: it speeds up and stops with its weight (empty quicker
//               than full), climbs up to ~22 deg, slower uphill, a little faster
//               down; props, machines and fences stop it. Four wheels follow the
//               ground (and the piles: it can nose onto a low one).
//   CAMERA      the operator's seat on the rear frame; you look around within
//               limits (it never hangs on the bucket).
//   BUCKET      assisted: [Linksklick] lowers it flat onto the ground (DIG) or
//               curls and lifts it (CARRY). In DIG, drive into a stockpile: the
//               bucket's mouth takes what lies above its floor - as fast as you
//               push in (no instant fill), the face resists, the wheels slow;
//               full, it curls and lifts on its own. [Rechtsklick / Q] at a
//               receiver (the plant's intake, a stockpile site): it raises the
//               arms as high as needed, tilts forward and pours - progressively,
//               as much as fits (the rest stays in the bucket) - then rolls back.
//               Against intact ground (the mountain) it stops: the excavator digs.
//   MATERIAL    the bucket is a container (one MaterialBatch, BUCKET_ML): its
//               gold counts in the processing ledger; what it takes from a pile
//               is exactly that pile's material (geology kept), what it pours
//               leaves it exactly.
//
// Saved: where it stands, its heading and joint, the arms' pose, the load, the
// mode, whether you sit in it. Every pour / take is a transaction of its own:
// saving in between never doubles or loses anything.

import { MaterialBatch, STAGE } from "./goldrush-material.js";
import { LoaderRig, LDR, loaderRigFromScene, tyreMarkTex, parkPadTex } from "./goldrush-loadermodel.js";
import { TrackMarks } from "./goldrush-excavatormodel.js";
import { transfer } from "./goldrush-transfer.js";

export const LOADER_HOME = { x: -11.2, z: -25.2, heading: Math.PI / 2 };   // delivered: the parking strip north of the raw pile
export const BUCKET_ML = 260000;                                             // ~260 l (the benchmark's figure - docs)
export const DRIVE = {
  fwd: [3.4, 2.7],          // m/s top speed forward: empty, full
  back: [2.0, 1.6],
  acc: [1.7, 1.05],         // m/s2 under throttle
  brake: [3.4, 2.5],        // m/s2 braking (S against the motion)
  coast: 1.1,               // m/s2 rolling out (no throttle)
  steer: [0.9, 0.7],        // rad/s the joint turns (empty, full)
  centre: 0.55,             // rad/s it eases back when released
  maxGrade: Math.tan((22 * Math.PI) / 180), maxDrop: Math.tan((30 * Math.PI) / 180),
};
// the arms' stations (arm angle, absolute bucket angle in the front frame) and how fast they move
export const ARMS = {
  carry: { boom: -0.52, phi: 0.5 },
  dig: { boom: LoaderRig.boomForPinY(-LDR.floorY + 0.015), phi: 0.0 },
  boomRate: 0.62, tiltRate: 1.25,
  dumpPhi: -0.95,           // fully tipped
};
const FILL_LPS = 150;       // l/s at most, pushing hard into a tall face
const MOUTH = { hw: 0.86, depth: 0.74 };
const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const approach = (v, t, d) => (v < t ? Math.min(t, v + d) : Math.max(t, v - d));

export class Loader {
  /**
   * @param saved doc.processing.loader (v9) or null
   * @param ctx   { ledger, nextId, piles(), receivers(), assets, envMap, soilTex, warm() }
   */
  constructor(THREE, scene, world, saved, ctx) {
    this.THREE = THREE;
    this.scene = scene;
    this.world = world;
    this.ctx = ctx;
    this.kind = "loader";
    const s = saved || {};
    this.x = Number.isFinite(s.x) ? s.x : LOADER_HOME.x;
    this.z = Number.isFinite(s.z) ? s.z : LOADER_HOME.z;
    this.heading = Number.isFinite(s.heading) ? s.heading : LOADER_HOME.heading;
    this.steer = Number.isFinite(s.steer) ? clamp(s.steer, -LDR.steerMax, LDR.steerMax) : 0;
    this.boom = Number.isFinite(s.boom) ? s.boom : ARMS.carry.boom;
    this.phi = Number.isFinite(s.phi) ? s.phi : ARMS.carry.phi;
    this.mode = ["carry", "dig", "dump"].includes(s.mode) ? s.mode : "carry";
    if (this.mode === "dump") this.mode = "carry";                         // a pour is never resumed from a save
    this.bucket = { batch: MaterialBatch.from(s.bucket) || new MaterialBatch({ stage: STAGE.RAW }), capacityMl: BUCKET_ML };
    this.inCab = !!s.inCab;
    const st = s.stats || {};
    this.stats = { takes: int(st.takes), tookMl: int(st.tookMl), pours: int(st.pours), pouredMl: int(st.pouredMl), intakeMl: int(st.intakeMl), driveM: int(st.driveM), blocked: int(st.blocked), wall: int(st.wall) };
    this.v = 0;                       // m/s along the rear frame (+ forward)
    this.spin = [0, 0, 0, 0];         // wheel turns (FL, FR, RL, RR)
    this.task = null;                 // { kind: "dump", recv, phase: raise | tip | back, t }
    this.time = 0;
    this.face = 0;                    // m3 right in front of the lip (the pile's resistance)
    this.pushing = false;
    this.settle = 0; this.settleT = 0;  // the arms bounce a little when the load comes on / goes off (visual)
    this.rig = new LoaderRig(THREE, { envMap: ctx.envMap || null, soilTex: ctx.soilTex || null });
    this.root = this.rig.root;
    scene.add(this.root);
    this.colliders = [{ type: "circle", x: 0, z: 0, r: 1.05 }, { type: "circle", x: 0, z: 0, r: 0.95 }];
    for (const c of this.colliders) world.colliders.push(c);
    // its tyres' imprints (cosmetic, not saved: where it went today), its parking pad (a flat decal)
    this.marks = new TrackMarks(THREE, scene, 480, { size: [0.44, LDR.wheelW], tex: tyreMarkTex(THREE), name: "goldrush-loader-marks" });
    this._markD = 0; this._pruneT = 0;
    this.pad = parkPad(THREE, scene);
    this._v = new THREE.Vector3(); this._w = new THREE.Vector3();
    this._fit();
    this._pose();
    this._load();
    if (ctx.assets) ctx.assets.modelOr(new URL("./models/loader.glb", import.meta.url).href, () => null).then((sc) => { if (sc && !this.disposed) this._useAuthored(sc); }).catch(() => {});
  }

  _useAuthored(sc) {
    const rig = loaderRigFromScene(this.THREE, sc, this.rig);
    if (!rig) return;
    this.scene.remove(this.root);
    this.rig = rig;
    this.root = rig.root;
    this.scene.add(this.root);
    this._fit();
    this._pose();
    if (this.ctx.warm) this.ctx.warm();
  }

  get volumeMl() { return this.bucket.batch.volumeMl; }
  get room() { return Math.max(0, BUCKET_ML - this.bucket.batch.volumeMl); }
  get loadFrac() { return this.bucket.batch.volumeMl / BUCKET_ML; }
  get busy() { return !!this.task; }
  get dumping() { return !!this.task && this.task.kind === "dump"; }
  goldUg() { return this.bucket.batch.goldUg; }
  massG() { return this.bucket.batch.massG; }

  // the front frame's heading (it turns on the joint)
  get frontHeading() { return this.heading + this.steer; }

  // ---------------------------------------------------------------- the ground under it

  _wheelsXZ(out) {
    const c = Math.cos(this.heading), s = Math.sin(this.heading), cf = Math.cos(this.frontHeading), sf = Math.sin(this.frontHeading), hw = LDR.track / 2;
    const rx = this.x - c * LDR.lr, rz = this.z + s * LDR.lr, fx = this.x + cf * LDR.lf, fz = this.z - sf * LDR.lf;
    out[0] = fx + sf * hw; out[1] = fz + cf * hw;      // FL (left = -z local: +sin / +cos of the heading)
    out[2] = fx - sf * hw; out[3] = fz - cf * hw;      // FR
    out[4] = rx + s * hw; out[5] = rz + c * hw;        // RL
    out[6] = rx - s * hw; out[7] = rz - c * hw;        // RR
    return out;
  }

  // the root sits on the axles' mean height; pitch from front vs rear, roll from left vs right
  _fit() {
    const p = this._wheelsXZ(this._wp || (this._wp = new Float32Array(8))), g = (i) => this.world.groundAt(p[i * 2], p[i * 2 + 1]);
    const fl = g(0), fr = g(1), rl = g(2), rr = g(3);
    this.y = (fl + fr + rl + rr) / 4;
    this.root.position.set(this.x, this.y, this.z);
    this.root.rotation.set(0, this.heading, 0);
    const pitch = Math.atan2((fl + fr) / 2 - (rl + rr) / 2, LDR.lf + LDR.lr), roll = Math.atan2((fl + rl) / 2 - (fr + rr) / 2, LDR.track);
    this.root.rotation.z = clamp(pitch, -0.45, 0.45);
    this.root.rotation.x = clamp(-roll, -0.35, 0.35);
    this.root.updateMatrixWorld(true);
    const c = Math.cos(this.heading), s = Math.sin(this.heading), cf = Math.cos(this.frontHeading), sf = Math.sin(this.frontHeading);
    this.colliders[0].x = this.x - c * 0.9; this.colliders[0].z = this.z + s * 0.9;
    this.colliders[1].x = this.x + cf * 1.45; this.colliders[1].z = this.z - sf * 1.45;
  }

  // may it go to (nx, nz) with this heading / joint? (the grade ahead of the leading axle, the claim's decks)
  _canGo(nx, nz, nh, dir) {
    const w = this.world;
    const f = dir >= 0 ? nh + this.steer : nh, c = Math.cos(f), s = Math.sin(f), ahead = dir >= 0 ? LDR.lf + 0.55 : -(LDR.lr + 0.55);
    const ax = nx + c * ahead, az = nz - s * ahead;
    if (w.decks.length && w.deckAt(ax, az) > -Infinity) return false;
    const h0 = w.groundAt(nx, nz), h1 = w.groundAt(ax, az), d = Math.abs(ahead) || 1;
    const grade = (h1 - h0) / d;
    return grade <= DRIVE.maxGrade && grade >= -DRIVE.maxDrop;
  }

  /**
   * One step of driving: fwd -1..1 (W / S), turn -1..1 (A / D, + = right). -> { moved, blocked }
   * The bucket's work (digging into a pile) shapes the speed: the face resists.
   */
  drive(dt, fwd, turn) {
    const f = Math.min(1, this.loadFrac), lerp = (ab) => ab[0] + (ab[1] - ab[0]) * f;
    // the joint: towards the key's side, eased back when released
    const want = -turn * LDR.steerMax;
    const rate = turn ? lerp(DRIVE.steer) : DRIVE.centre;
    const s0 = this.steer;
    this.steer = approach(this.steer, turn ? want : 0, rate * dt);
    const dSteer = this.steer - s0;
    // throttle / brake / coast
    const vmax = fwd >= 0 ? lerp(DRIVE.fwd) : lerp(DRIVE.back);
    let target = fwd * vmax;
    // the pile's face in front of a lowered bucket: it pushes back (and a full bucket stops at it)
    if (this.face > 0 && this.v > 0) {
      const k = clamp(this.face / 0.09, 0, 1);
      const cap = this.room < 4000 ? 0.06 : 1.1 * (1 - 0.75 * k);
      target = Math.min(target, cap);
    }
    // the slope: uphill it pulls less, downhill a little more
    const grade = this._grade || 0;
    const slope = clamp(1 - grade * 1.6 * Math.sign(this.v || fwd || 1), 0.45, 1.25);
    target *= slope;
    let a;
    if (fwd !== 0 && Math.sign(target) === Math.sign(this.v || target)) a = lerp(DRIVE.acc) * (this.v * target < 0 ? 1.4 : 1);
    else if (fwd !== 0) a = lerp(DRIVE.brake);
    else a = DRIVE.coast + (this.face > 0 ? 1.5 : 0);
    if (Math.abs(this.v) > Math.abs(target) && Math.sign(this.v) === Math.sign(target)) a = Math.max(a, lerp(DRIVE.brake) * 0.6);
    this.v = approach(this.v, target, a * dt);
    let moved = 0, blocked = false;
    // the articulated kinematics: the rear axle runs along the rear heading; the heading turns on the arc
    const h0 = this.heading;
    if (Math.abs(this.v) > 1e-4 || Math.abs(dSteer) > 1e-6) {
      const d = this.v * dt, L = LDR.lf * Math.cos(this.steer) + LDR.lr;
      let nh = this.heading + (d * Math.sin(this.steer)) / L;
      // steering on the spot turns both frames a little (the rear swings the other way)
      if (Math.abs(this.v) < 0.3) nh -= dSteer * 0.32 * (1 - Math.abs(this.v) / 0.3);
      nh = wrapA(nh);
      const c0 = Math.cos(h0), s0r = Math.sin(h0), c1 = Math.cos(nh), s1 = Math.sin(nh);
      const rx = this.x - c0 * LDR.lr + c0 * d, rz = this.z + s0r * LDR.lr - s0r * d;     // the rear axle moved
      const nx = rx + c1 * LDR.lr, nz = rz - s1 * LDR.lr;                                  // the joint from it
      if (Math.abs(this.v) > 1e-4 && !this._canGo(nx, nz, nh, this.v)) { blocked = true; this.v = 0; }
      else {
        // props / machines / fences: both circles (the colliders of the loader itself out of the way)
        const mine = this.colliders, cols = this.world.colliders;
        for (const c of mine) { const i = cols.indexOf(c); if (i >= 0) cols.splice(i, 1); }
        const cf = Math.cos(nh + this.steer), sf = Math.sin(nh + this.steer);
        const pr = { x: nx - c1 * 0.9, z: nz + s1 * 0.9 }, pf = { x: nx + cf * 1.45, z: nz - sf * 1.45 };
        this.world.collide(pr, 1.0);
        this.world.collide(pf, 0.9);
        for (const c of mine) cols.push(c);
        const push = Math.max(Math.hypot(pr.x - (nx - c1 * 0.9), pr.z - (nz + s1 * 0.9)), Math.hypot(pf.x - (nx + cf * 1.45), pf.z - (nz - sf * 1.45)));
        if (push > 0.02) { blocked = true; this.v *= -0.15; }
        else {
          moved = Math.hypot(nx - this.x, nz - this.z);
          this.x = nx; this.z = nz; this.heading = nh;
          this.stats.driveM += moved;
        }
      }
    }
    if (blocked) this.stats.blocked++;
    // the wheels turn with their own path (the inner ones less on an arc)
    const dd = this.v * dt;
    for (let i = 0; i < 4; i++) {
      const side = i % 2 ? -1 : 1, front = i < 2;
      const k = 1 - side * (front ? 0.5 : 0.35) * Math.sin(this.steer) * (LDR.track / (LDR.lf + LDR.lr));
      this.spin[i] += (dd * k) / LDR.wheelR;
    }
    this._fit();
    // the tyres' imprints: all four, every ~0.45 m (the rear ones run inside the front ones on an arc)
    if ((this._markD += moved) >= 0.45) {
      this._markD = 0;
      const p = this._wp;
      for (let i = 0; i < 4; i++) this.marks.add(p[i * 2], this.world.groundAt(p[i * 2], p[i * 2 + 1]), p[i * 2 + 1], i < 2 ? this.frontHeading : this.heading);
    }
    // the grade along the rear heading (for the next step's pull)
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    this._grade = (this.world.groundAt(this.x + c * 1.2, this.z - s * 1.2) - this.world.groundAt(this.x - c * 1.2, this.z + s * 1.2)) / 2.4;
    return { moved, blocked };
  }

  // ---------------------------------------------------------------- the arms and the bucket

  /** [Linksklick]: lower to DIG / curl and lift to CARRY */
  toggleDig() {
    if (this.task) return null;
    this.mode = this.mode === "dig" ? "carry" : "dig";
    return this.mode;
  }

  /** [Rechtsklick / Q] at a receiver { kind, at: {x, y, z}, top, pile?, holder? } -> whether it starts */
  startDump(recv) {
    if (this.task || this.volumeMl <= 0 || !recv) return false;
    this.task = { kind: "dump", recv, phase: "raise", t: 0, poured: 0, rest: 0 };
    this.mode = "carry";
    return true;
  }

  // the arm angle that brings the lip above `top` (world y) with the bucket level, plus clearance
  _boomForTop(top) {
    const clear = top - this.y + 0.35 - LDR.lip[1];
    return clamp(LoaderRig.boomForPinY(clear), ARMS.dig.boom, 0.78);
  }

  /** per frame: the arms, the bucket, the work -> events (take / pour / wall / full) */
  update(dt, input = null, ev = null) {
    this.time += dt;
    // imprints whose ground was dug, heaped or cleared away go (twice a second, only while there are any)
    if (this.marks.used && (this._pruneT -= dt) <= 0) { this._pruneT = 0.5; this.marks.prune((x, z) => this.world.groundAt(x, z)); }
    const T = this.task;
    let boomT, phiT;
    if (T && T.kind === "dump") {
      T.t += dt;
      if (T.phase === "raise") {
        boomT = this._boomForTop(T.recv.top); phiT = ARMS.carry.phi * 0.6;
        if (Math.abs(this.boom - boomT) < 0.02 && Math.abs(this.phi - phiT) < 0.05) { T.phase = "tip"; T.t = 0; }
      } else if (T.phase === "tip") {
        boomT = this._boomForTop(T.recv.top);
        // it tips progressively (slower at first: the load breaks loose, then pours)
        phiT = ARMS.dumpPhi;
        const pourFrom = -0.15;
        if (this.phi < pourFrom) {
          const share = clamp((pourFrom - this.phi) / (pourFrom - ARMS.dumpPhi), 0, 1);
          const want = Math.round(BUCKET_ML * 1.15 * share) - T.poured;
          if (want > 0) {
            const r = this._pour(T.recv, want);
            T.poured += r.ml > 0 ? r.ml : want;
            if (r.ml > 0 && ev) ev("pour", { ml: r.ml, kind: T.recv.kind, recv: T.recv });
            if (r.full) T.full = true;
          }
        }
        if (Math.abs(this.phi - ARMS.dumpPhi) < 0.03 || (T.full && this.phi < -0.55)) {
          T.phase = "back"; T.t = 0;
          this.settle = 1; this.settleT = 0;
          this.stats.pours++;
          if (ev) ev("poured", { ml: T.pouredMl || 0, rest: this.volumeMl, full: !!T.full, kind: T.recv.kind });
        }
      } else {
        boomT = ARMS.carry.boom; phiT = ARMS.carry.phi;
        if (Math.abs(this.boom - boomT) < 0.03 && Math.abs(this.phi - phiT) < 0.05) this.task = null;
      }
    } else {
      const st = ARMS[this.mode] || ARMS.carry;
      boomT = st.boom; phiT = st.phi;
    }
    // the hydraulics: rates, eased near the end (no snap), heavier with a full bucket
    const k = 1 - 0.25 * Math.min(1, this.loadFrac);
    const db = boomT - this.boom, dp = phiT - this.phi;
    this.boom += Math.sign(db) * Math.min(Math.abs(db), ARMS.boomRate * k * dt * Math.min(1, 0.25 + Math.abs(db) * 4));
    this.phi += Math.sign(dp) * Math.min(Math.abs(dp), ARMS.tiltRate * k * dt * Math.min(1, 0.25 + Math.abs(dp) * 4));
    this.armsMoving = Math.abs(db) > 0.01 || Math.abs(dp) > 0.01;
    this._pose();
    // digging: a lowered bucket in a pile takes what lies above its floor, as fast as it is pushed in
    this.face = 0;
    this.pushing = false;
    if (!this.task && this.mode === "dig" && Math.abs(this.boom - ARMS.dig.boom) < 0.12) this._dig(dt, input, ev);
    if (this.settleT < 2) this.settleT += dt;
  }

  _dig(dt, input, ev) {
    const lip = this.rig.lipWorld(this._v), fh = this.frontHeading, dx = Math.cos(fh), dz = -Math.sin(fh);
    const back = { x: lip.x - dx * (MOUTH.depth - 0.04), z: lip.z - dz * (MOUTH.depth - 0.04) };
    const lipY = lip.y + 0.03;
    // intact ground ahead (the mountain, a bank): the bucket's edge runs into it - it stops
    const ahead = this.world.groundBelowAt(lip.x + dx * 0.25, lip.z + dz * 0.25);
    if (ahead - lipY > 0.16 && this.v >= 0) {
      this.face = 0.2;
      this.wall = true;
      if (ev && this.v > 0.1) ev("wall", {});
      return;
    }
    this.wall = false;
    const piles = this.ctx.piles ? this.ctx.piles() : null;
    if (!piles) return;
    const pile = piles.at(lip.x, lip.z, 0.4) || piles.at(back.x, back.z, 0.4);
    if (!pile || pile.volumeMl <= 0) return;
    this.face = pile.aboveLip(lip.x - dx * 0.05, lip.z - dz * 0.05, dx, dz, MOUTH.hw, 0.4, lipY);
    const fwd = input ? input.fwd : 0;
    if (this.room <= 0) { if (this.face > 0 && ev) ev("full", {}); return; }
    if (this.v < 0.02 && !(fwd > 0)) return;
    this.pushing = fwd > 0 && this.face > 0;
    // the push: speed into the face (and a little crowding with the wheels spinning against it)
    const push = clamp(this.v / 0.9, 0, 1) * 0.85 + (fwd > 0 ? 0.15 : 0);
    const maxMl = Math.min(this.room, FILL_LPS * 1000 * push * dt);
    if (maxMl < 50) return;
    const got = pile.cut(back.x, back.z, dx, dz, MOUTH.hw, MOUTH.depth + 0.12, lipY, maxMl);
    if (got.volumeMl > 0) {
      this.bucket.batch.absorb(got);
      this.stats.takes++; this.stats.tookMl += got.volumeMl;
      this._load();
      if (ev) ev("take", { ml: got.volumeMl, pile: pile.id });
      // full: it curls and lifts on its own (the weight comes on: the arms dip once)
      if (this.room < 4000) { this.mode = "carry"; this.settle = -0.8; this.settleT = 0; if (ev) ev("filled", { ml: this.volumeMl, pile: pile.id }); }
    }
  }

  // pour up to ml into the receiver -> { ml, full }
  _pour(recv, ml) {
    const b = this.bucket.batch;
    if (b.volumeMl <= 0) return { ml: 0, full: false };
    let moved = 0, full = false;
    const want = Math.min(ml, b.volumeMl);
    if (recv.pile) {
      const lip = this.rig.lipWorld(this._w);
      moved = recv.pile.dumpFrom(this.bucket, want, lip.x, lip.z, 0.75);
      if (moved < want && recv.pile.room <= 0) full = true;
    } else if (recv.holder) {
      moved = transfer(this.bucket, recv.holder, want, this.ctx.nextId ? this.ctx.nextId() : 0);
      if (moved < want) full = true;
      if (recv.kind === "intake") this.stats.intakeMl += moved;
      if (moved > 0 && recv.R && recv.R.done) recv.R.done(moved, true); // the receiver's own bookkeeping (quiet: the pour's end tells it once)
    }
    if (moved > 0) {
      if (this.task) this.task.pouredMl = (this.task.pouredMl || 0) + moved;
      this.stats.pouredMl += moved;
      this._load();
    }
    return { ml: moved, full };
  }

  // the visible pose: articulation, arms (with the load's bounce on top - never saved), bucket, wheels
  _pose() {
    let boom = this.boom;
    if (this.settleT < 1.6 && this.settle) boom += this.settle * 0.03 * Math.sin(this.settleT * 13) * Math.exp(-this.settleT * 4);
    const p = this._p || (this._p = { steer: 0, boom: 0, tilt: 0, spin: this.spin, steerWheel: 0 });
    p.steer = this.steer; p.boom = boom; p.tilt = LoaderRig.tiltFor(this.phi, this.boom); p.spin = this.spin;
    p.steerWheel = (this.steer / LDR.steerMax) * 2.4;
    this.rig.setPose(p);
  }

  _load() {
    const b = this.bucket.batch;
    this.rig.setLoad(b.volumeMl / BUCKET_ML, b.comp, b.stage === STAGE.TAILINGS ? [0.6, 0.57, 0.52] : null);
  }

  // ---------------------------------------------------------------- tests / benchmark (no animation)

  /** take from a pile right now (the transaction of a full push) -> ml */
  takeNow(pile, ml = BUCKET_ML) {
    const lip = this.rig.lipWorld(this._v), fh = this.frontHeading, dx = Math.cos(fh), dz = -Math.sin(fh);
    const got = pile.cut(lip.x - dx * 0.7, lip.z - dz * 0.7, dx, dz, MOUTH.hw, 1.5, -Infinity, Math.min(ml, this.room));
    if (got.volumeMl > 0) { this.bucket.batch.absorb(got); this.stats.takes++; this.stats.tookMl += got.volumeMl; this._load(); }
    return got.volumeMl;
  }

  /** pour into a receiver right now -> { ml, full } */
  pourNow(recv, ml = Infinity) { return this._pour(recv, Math.min(ml, this.volumeMl)); }

  // ---------------------------------------------------------------- placement, saving

  place(x, z, heading = this.heading, steer = 0) {
    this.x = x; this.z = z; this.heading = heading; this.steer = steer; this.v = 0;
    this._fit();
    this._pose();
  }

  // where you stand when you get out: left of the cab (its steps), on free ground
  exitSpot() {
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    for (const side of [1, -1]) for (const d of [1.55, 2.0, 2.5]) {
      const x = this.x - c * 0.4 + s * side * d, z = this.z + s * 0.4 + c * side * d;
      const p = { x, z };
      this.world.collide(p, 0.3);
      if (Math.hypot(p.x - x, p.z - z) < 0.05) return p;
    }
    return { x: this.x - c * 3.2, z: this.z + s * 3.2 };
  }

  eye(out) { this.root.updateMatrixWorld(true); return this.rig.eyeWorld(out); }

  serialize() {
    return { x: +this.x.toFixed(3), z: +this.z.toFixed(3), heading: +this.heading.toFixed(4), steer: +this.steer.toFixed(4), boom: +this.boom.toFixed(4), phi: +this.phi.toFixed(4),
      mode: this.mode === "dig" ? "dig" : "carry", bucket: this.bucket.batch.serialize(), inCab: !!this.inCab, stats: { ...this.stats } };
  }

  dispose() {
    this.disposed = true;
    for (const c of this.colliders) { const i = this.world.colliders.indexOf(c); if (i >= 0) this.world.colliders.splice(i, 1); }
    this.scene.remove(this.root);
    this.rig.dispose();
    this.marks.dispose();
    this.scene.remove(this.pad);
    this.pad.geometry.dispose(); this.pad.material.map.dispose(); this.pad.material.dispose();
  }
}

// the parking pad: compacted gravel where it stands delivered and is parked, its tyres' ruts in it, worn paint
// either side (one flat decal on the camp ground north of the raw pile - outside the diggable square)
export const PARK_PAD = { x: LOADER_HOME.x, z: LOADER_HOME.z - 0.9, w: 4.4, d: 6.4 };
function parkPad(THREE, scene) {
  const g = new THREE.PlaneGeometry(PARK_PAD.w, PARK_PAD.d);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.MeshStandardMaterial({ map: parkPadTex(THREE), transparent: true, depthWrite: false, roughness: 0.96,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  const pad = new THREE.Mesh(g, m);
  pad.name = "goldrush-loader-pad";
  pad.position.set(PARK_PAD.x, 0.007, PARK_PAD.z);
  pad.renderOrder = 1;
  pad.receiveShadow = true;
  scene.add(pad);
  return pad;
}
