// GoldRush - pushing the wheelbarrow (phase 8): the barrow is a world object
// with its own motion, never a camera attachment. Your input says what you
// want (push / brake / reverse, steer, where you look); the barrow answers
// with its own speed, turn rate and wheel - and you stand behind its grips.
//
//   speed      eased towards what you ask for: a full barrow gets going
//              noticeably slower and needs more room to stop; downhill it
//              pulls, uphill it drags (the top speed is the game's own
//              speedFactor - the benchmark uses the same numbers)
//   turning    (phase 9 handling pass - heavy, not hard to steer) what you
//              want is a heading: A / D, and where you look. A small look
//              off its line leaves it calm; a clear one pulls it round,
//              progressively harder the further you look. Slow, it swings
//              round the wheel (the handles sweep - a tight turn, no spin on
//              the spot); faster, the radius grows with the speed. The turn
//              rate builds up quickly (no seconds of syrup) - the load makes
//              it a little lazier, not unsteerable. Rolling, it settles onto
//              your line by itself (no diagonal drift between you and it)
//   looking    the camera never leaves it further than LOOK_MAX (soft)
//   ground     the wheel rides the ground as it is (dug pits included); a lip
//              of up to 10 cm and small bumps cost a little speed and shake it,
//              they do not stop it; the slope is judged over 0.6 m (a clod is
//              not a hill); a wall, a prop in the way or ground you cannot
//              stand on stops it
//   weight     shown, not fought: slower start, longer stop, more drag uphill,
//              the handles dip / lift as it speeds up / brakes (surge), a
//              deeper rumble and the frame creaking under a full load
//   take/park  hands reach -> grips taken -> legs leave the ground, and back:
//              short and responsive (no cinematic)
//
// No physics engine: a few ground samples and a damped spring per frame.

import { BARROW } from "./goldrush-mechmodels.js";

export const PUSH = {
  gripAhead: 0.3,      // m: the grips this far in front of your eyes (horizontal) - within arm's reach
  handsY: 0.96,        // m: ... this high above the ground you stand on (handles at the hip, the tray tilted ~24 deg)
  lookMax: 0.72,       // rad: and no further (a quick flick springs back to here) ...
  lookHard: 0.84,      // rad: ... and never, not even for a frame, further than this
  reverseK: 0.6,       // backing up: this share of the forward top speed (Prompt 10, human QA: 0.55 m/s flat was unusable) ...
  reverseMax: 2.0,     // m/s ... and never more than this
  reverseAccel: 0.85,  // the pull-away backwards: this share of pushing's
  takeS: 0.34,         // s: reach + lift
  parkS: 0.36,         // s: lower + let go
};

// the handling (empty .. full: value - load * xLoad)
export const HANDLING = {
  accel: 3.2, accelLoad: 1.5,      // m/s2 pushing it up to speed (full 1.7; phase 8 was 2.9 / 1.0)
  brake: 5.2, brakeLoad: 3.0,      // m/s2 stopping it (full 2.2: a longer way to stop than empty)
  dead: 0.1,                       // rad: pushing / rolling, a look this little off its line leaves it calm ...
  deadStill: 0.35,                 // rad: ... standing with nothing asked of it, a glance this far (you look about)
  k1: 2.4, k2: 5.0,                // ... beyond, the wanted turn rate k1 e + k2 e^2 (e = the look past the deadzone)
  align: 1.4,                      // rad/s per rad: rolling, it settles onto your line (inside the deadzone)
  pivot: 1.15, pivotLoad: 0.35,    // rad/s: slow / standing, the handles sweep round the wheel (full 0.8)
  r0: 0.7, rv: 0.45,               // m, s: rolling, the tightest radius 0.7 m + 0.45 s x speed
  rollLoad: 0.12,                  // a full load turns that much less at speed
  alpha: 10, alphaLoad: 4,         // rad/s2: how fast the turn rate builds up (full 6)
  rough: 0.1,                      // the top speed lost on very rough ground (phase 8: 0.22)
  roughDrag: 0.15, roughDragLoad: 0.4,   // m/s2 drag there (phase 8: 0.35 / 0.9)
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const NO_MUL = { accel: 1, drag: 1, rough: 1 };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class PushController {
  constructor() {
    this.v = 0;            // m/s along the barrow's heading (< 0: backing up)
    this.w = 0;            // rad/s yaw rate (pivot round the wheel)
    this.spin = 0;         // wheel angle (rad) - distance travelled / radius
    this.grip = 0;         // 0..1 hands on the grips
    this.lift = 0;         // 0..1 handles lifted (legs off the ground)
    this.mode = "parked";  // parked | taking | pushing | parking
    this.t = 0;
    this.rough = 0;        // how rough the ground under the wheel is (0..1, smoothed)
    this.bump = 0;         // the wheel's jolt from rough ground (visual)
    this.blocked = 0;      // s since it last ran into something (feedback)
    this.travel = 0;       // m rolled (wheel squeak / tests)
    this.grade = 0;        // the slope it rolls on (rise per metre in its direction, smoothed)
    this.surge = 0;        // -1..1 the push / brake right now (smoothed: the handles' dip, the camera, the creak)
    this.load = 0;         // 0..1 how full it is (the last step)
  }

  get busy() { return this.mode === "taking" || this.mode === "parking"; }

  take() { this.mode = "taking"; this.t = 0; this.v = 0; this.w = 0; this.grade = 0; }
  park() { if (this.mode !== "parked") { this.mode = "parking"; this.t = 0; this.v = 0; this.w = 0; } }

  // the take / park animation (and nothing else)
  animate(dt) {
    if (this.mode === "taking") {
      this.t += dt;
      this.grip = smooth(this.t / (PUSH.takeS * 0.5));
      this.lift = smooth((this.t - PUSH.takeS * 0.35) / (PUSH.takeS * 0.65));
      if (this.t >= PUSH.takeS) { this.mode = "pushing"; this.grip = 1; this.lift = 1; }
    } else if (this.mode === "parking") {
      this.t += dt;
      this.lift = 1 - smooth(this.t / (PUSH.parkS * 0.62));
      this.grip = 1 - smooth((this.t - PUSH.parkS * 0.55) / (PUSH.parkS * 0.45));
      if (this.t >= PUSH.parkS) { this.mode = "parked"; this.grip = 0; this.lift = 0; }
    } else if (this.mode === "pushing") { this.grip = 1; this.lift = 1; }
    else { this.grip = 0; this.lift = 0; }
  }

  /**
   * One frame of pushing. bw: the Wheelbarrow (x, z = the wheel on the ground,
   * yaw, load, world); input: { fwd -1..1, turn -1..1 }; camYaw: where you
   * look. Moves the barrow if the new place is possible, returns what it did.
   */
  step(dt, bw, input, camYaw) {
    this.animate(dt);
    this.blocked += dt;
    if (this.mode !== "pushing" || bw.dump) { this.v *= Math.exp(-dt * 12); this.w = 0; return { moved: false }; }
    const load = clamp(bw.massKg / bw.fullKg, 0, 1), H = HANDLING;
    this.load = load;
    // the ground: the slope along the heading and how rough it is under the wheel
    const f0x = -Math.sin(bw.yaw), f0z = -Math.cos(bw.yaw), dir = this.v >= -0.02 ? 1 : -1;
    // > 0: the way it rolls goes uphill (smoothed over ~0.1 s: the ground's small undulations must
    // not make the speed twitch frame to frame)
    this.grade += (bw.gradeAhead() * dir - this.grade) * (1 - Math.exp(-dt * 9));
    const grade = this.grade;
    const r = bw.roughness();
    this.rough += (r - this.rough) * (1 - Math.exp(-dt * 6));
    // what you ask for: a speed and a turn
    const hm = bw.handlingMul || NO_MUL;           // Prompt 10: the barrow's upgrades (bearings, tyre)
    const vmax = bw.walkSpeed * bw.speedFactor(grade) * (1 - H.rough * this.rough * hm.rough);
    const fwd = clamp(input.fwd || 0, -1, 1), turn = clamp(input.turn || 0, -1, 1);
    const target = fwd >= 0 ? fwd * vmax : fwd * Math.min(PUSH.reverseMax, vmax * PUSH.reverseK);
    // pushing / braking: a full barrow gets going slower and needs more room to stop (backing up a little slower still)
    const accel = (H.accel - H.accelLoad * load) * (grade > 0 ? 1 - Math.min(0.6, grade * (0.5 + 1.3 * load)) : 1) * (target < 0 ? PUSH.reverseAccel : 1) * hm.accel;
    const brake = H.brake - H.brakeLoad * load;
    const dv = target - this.v;
    const speeding = Math.sign(dv) === Math.sign(this.v) || Math.abs(this.v) < 0.03;
    let a = clamp(dv * 7, -(speeding ? accel : brake), speeding ? accel : brake);
    // downhill it pulls (more the heavier it is); rough ground and an uphill drag slow it
    if (grade < 0 && Math.abs(this.v) > 0.05) a += -grade * 9.81 * (0.08 + 0.26 * load) * Math.sign(this.v);
    a -= Math.sign(this.v) * this.rough * (H.roughDrag + H.roughDragLoad * load) * hm.drag * hm.rough * Math.min(1, Math.abs(this.v) * 4);
    this.v += a * dt;
    if (Math.abs(this.v) > vmax * 1.15) this.v = Math.sign(this.v) * vmax * 1.15;
    if (Math.abs(this.v) < 0.004 && Math.abs(target) < 0.001) this.v = 0;
    // the weight you see and hear: the push / brake, smoothed (0 when it rolls steadily)
    this.surge += (clamp(a / 2.5, -1, 1) - this.surge) * (1 - Math.exp(-dt * 8));
    // turning: what you want is a heading - the keys, and your look (calm when it is a little off its line,
    // decisive when it is clearly off; rolling, it settles onto your line)
    const sv = Math.abs(this.v);
    const wCap = Math.max(H.pivot - H.pivotLoad * load, (sv / (H.r0 + H.rv * sv)) * (1 - H.rollLoad * load));
    const still = fwd === 0 && sv < 0.3;                 // standing, nothing asked of it: you may look about
    const off = wrap(camYaw - bw.yaw), e = Math.abs(off) - (still ? H.deadStill : H.dead);
    let wWant = -turn * wCap;
    if (e > 0) wWant += Math.sign(off) * (H.k1 * e + H.k2 * e * e) * (still ? 0.5 : 1);
    else wWant += off * H.align * Math.min(1, sv / 0.6);
    wWant = clamp(wWant, -wCap, wCap);
    const alpha = H.alpha - H.alphaLoad * load;
    this.w += clamp(wWant - this.w, -alpha * dt, alpha * dt);
    if (Math.abs(this.w) < 0.002 && Math.abs(wWant) < 0.002) this.w = 0;
    // the move: pivot round the wheel, roll along the heading
    const yaw = bw.yaw + this.w * dt, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const nx = bw.x + fx * this.v * dt, nz = bw.z + fz * this.v * dt;
    let moved = true;
    if (!bw.canPlace(nx, nz, yaw)) {
      // try only the roll, then only the turn - else it stands (a little jolt)
      const rx = bw.x + f0x * this.v * dt, rz = bw.z + f0z * this.v * dt;
      if (bw.canPlace(rx, rz, bw.yaw)) { this.w = 0; this._apply(bw, rx, rz, bw.yaw, dt); return { moved: true, turnBlocked: true }; }
      if (Math.abs(this.w) > 0 && bw.canPlace(bw.x, bw.z, yaw)) { this.v = 0; this._apply(bw, bw.x, bw.z, yaw, dt); return { moved: true, rollBlocked: true }; }
      if (Math.abs(this.v) > 0.25 && this.blocked > 0.4) this.bump = Math.min(1, Math.abs(this.v));
      this.v = 0; this.w = 0; this.blocked = 0;
      moved = false;
      return { moved, blocked: true };
    }
    this._apply(bw, nx, nz, yaw, dt);
    return { moved };
  }

  _apply(bw, x, z, yaw, dt) {
    const d = Math.hypot(x - bw.x, z - bw.z) * Math.sign(this.v || 1);
    bw.x = x; bw.z = z; bw.yaw = yaw;
    this.spin += d / BARROW.wheelR;
    this.travel += Math.abs(d);
    // rough ground: the wheel jolts (visual only, decays)
    this.bump = Math.max(this.bump * Math.exp(-dt * 7), this.rough * Math.min(1, Math.abs(this.v) / 1.2) * (0.5 + 0.5 * Math.sin(this.travel * 23)));
  }
}

/**
 * The handling in numbers (the dev course's readout, the tests): the controller driven on flat open
 * ground (and a mild slope) with set inputs, for a load 0..1. -> { vmax, t90 (s to 90 % of top speed),
 * stop (m from top speed), turn90 (s for a quarter turn at speed, the keys), turn90look (s, looking 45 deg
 * off), latency (s to half the wanted turn rate), radius (m, the tightest turn at walking pace), slope
 * (m/s up an 8 % slope) }
 */
export function measureHandling(load, { walkSpeed = 3.4, speedFactor } = {}) {
  const full = 153, kg = 18 + load * (full - 18);
  const sf = speedFactor || ((grade) => {
    const l = Math.min(1, kg / full);
    let f = 0.96 - 0.24 * l;
    if (grade > 0) f *= 1 - Math.min(0.5, grade) * (0.45 + 0.9 * l);
    return Math.max(0.42, Math.min(0.98, f));
  });
  const mk = (grade = 0) => {
    const bw = { x: 0, z: 0, yaw: 0, massKg: kg, fullKg: full, walkSpeed, dump: null, g: grade,
      speedFactor: (gr) => sf(gr), gradeAhead() { return this.g; }, roughness: () => 0, canPlace: () => true, fwd: () => null };
    const c = new PushController();
    c.mode = "pushing"; c.grip = 1; c.lift = 1;
    return { bw, c };
  };
  const dt = 1 / 60, out = { load };
  // top speed, time to 90 %
  let { bw, c } = mk(), t = 0;
  const vmax = walkSpeed * sf(0);
  out.vmax = vmax;
  while (c.v < vmax * 0.9 && t < 10) { c.step(dt, bw, { fwd: 1, turn: 0 }, bw.yaw); t += dt; }
  out.t90 = t;
  for (let i = 0; i < 240; i++) c.step(dt, bw, { fwd: 1, turn: 0 }, bw.yaw);
  // the way to stop from there
  let d = 0;
  for (let i = 0; i < 600 && c.v > 0.01; i++) { c.step(dt, bw, { fwd: 0, turn: 0 }, bw.yaw); d += c.v * dt; }
  out.stop = d;
  // a quarter turn at speed with the keys, and by looking 45 deg off its line (the look follows the turn)
  for (const how of ["keys", "look"]) {
    ({ bw, c } = mk());
    for (let i = 0; i < 300; i++) c.step(dt, bw, { fwd: 1, turn: 0 }, bw.yaw);
    const y0 = bw.yaw;
    let tt = 0, lat = null, wWantMax = 0;
    while (Math.abs(wrap(bw.yaw - y0)) < Math.PI / 2 && tt < 10) {
      const cam = how === "look" ? bw.yaw + 0.785 : bw.yaw;
      c.step(dt, bw, { fwd: 1, turn: how === "keys" ? -1 : 0 }, cam);
      tt += dt;
      wWantMax = Math.max(wWantMax, Math.abs(c.w));
      if (lat == null && Math.abs(c.w) >= 0.5 * (how === "keys" ? 1 : 0.9)) lat = tt;
    }
    out[how === "keys" ? "turn90" : "turn90look"] = tt;
    if (how === "keys") out.latency = lat;
  }
  // the tightest turn at walking pace (1 m/s): radius = v / w once steady
  ({ bw, c } = mk());
  for (let i = 0; i < 300; i++) c.step(dt, bw, { fwd: 1 / vmax, turn: -1 }, bw.yaw);
  out.radius = Math.abs(c.v / (c.w || 1e-6));
  // up a mild slope (8 %)
  ({ bw, c } = mk(0.08));
  for (let i = 0; i < 600; i++) c.step(dt, bw, { fwd: 1, turn: 0 }, bw.yaw);
  out.slope = c.v;
  // backing up (Prompt 10): its top speed, the time to 90 % of it, a quarter turn backing with the keys
  ({ bw, c } = mk());
  t = 0;
  const vb = Math.min(PUSH.reverseMax, vmax * PUSH.reverseK);
  while (-c.v < vb * 0.9 && t < 10) { c.step(dt, bw, { fwd: -1, turn: 0 }, bw.yaw); t += dt; }
  out.t90back = t;
  for (let i = 0; i < 240; i++) c.step(dt, bw, { fwd: -1, turn: 0 }, bw.yaw);
  out.vback = -c.v;
  const yb = bw.yaw;
  let tb = 0;
  while (Math.abs(wrap(bw.yaw - yb)) < Math.PI / 2 && tb < 10) { c.step(dt, bw, { fwd: -1, turn: -1 }, bw.yaw); tb += dt; }
  out.turn90back = tb;
  return out;
}

// how far your look may be off the barrow's line (the camera is clamped to it): `soft` springs back
// to PUSH.lookMax, the hard limit holds at once
export function clampLook(camYaw, barrowYaw, soft = true) {
  const off = wrap(camYaw - barrowYaw), m = soft ? PUSH.lookMax : PUSH.lookHard;
  return barrowYaw + clamp(off, -m, m);
}
