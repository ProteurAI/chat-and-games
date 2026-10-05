// GoldRush - pushing the wheelbarrow (phase 8): the barrow is a world object
// with its own motion, never a camera attachment. Your input says what you
// want (push / brake / reverse, steer, where you look); the barrow answers
// with its own speed, turn rate and wheel - and you stand behind its grips.
//
//   speed      eased towards what you ask for: a full barrow gets going
//              slowly and needs room to stop; downhill it pulls, uphill it
//              drags (the top speed is the game's own speedFactor - the
//              balance of the phases before is untouched)
//   turning    a turn rate that builds up, pivoting round the front wheel;
//              heavy loads turn sluggishly, standing still turns slowest
//   looking    you look up to LOOK_FREE off its line without moving it; look
//              further and it follows, gradually; never further than LOOK_MAX
//   ground     the wheel rides the ground as it is (dug pits included), rough
//              ground costs speed and shakes it; a wheel that would climb a
//              wall, a prop in the way or ground you cannot stand on stops it
//   take/park  hands reach -> grips taken -> legs leave the ground, and back:
//              short and responsive (no cinematic)
//
// No physics engine: a few ground samples and a damped spring per frame.

import { BARROW } from "./goldrush-mechmodels.js";

export const PUSH = {
  gripAhead: 0.3,      // m: the grips this far in front of your eyes (horizontal) - within arm's reach
  handsY: 0.96,        // m: ... this high above the ground you stand on (handles at the hip, the tray tilted ~24 deg)
  lookFree: 0.4,       // rad: look this far off the barrow's line before it starts to follow
  lookMax: 0.72,       // rad: and no further (a quick flick springs back to here) ...
  lookHard: 0.84,      // rad: ... and never, not even for a frame, further than this
  reverse: 0.55,       // m/s backing up (at most)
  takeS: 0.34,         // s: reach + lift
  parkS: 0.36,         // s: lower + let go
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
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
    const load = clamp(bw.massKg / bw.fullKg, 0, 1);
    // the ground: the slope along the heading and how rough it is under the wheel
    const f0x = -Math.sin(bw.yaw), f0z = -Math.cos(bw.yaw), dir = this.v >= -0.02 ? 1 : -1;
    // > 0: the way it rolls goes uphill (smoothed over ~0.1 s: the ground's small undulations must
    // not make the speed twitch frame to frame)
    this.grade += (bw.gradeAhead() * dir - this.grade) * (1 - Math.exp(-dt * 9));
    const grade = this.grade;
    const r = bw.roughness();
    this.rough += (r - this.rough) * (1 - Math.exp(-dt * 6));
    // what you ask for: a speed and a turn
    const vmax = bw.walkSpeed * bw.speedFactor(grade) * (1 - 0.22 * this.rough);
    const fwd = clamp(input.fwd || 0, -1, 1), turn = clamp(input.turn || 0, -1, 1);
    const target = fwd >= 0 ? fwd * vmax : fwd * Math.min(PUSH.reverse, vmax * 0.6);
    // pushing / braking: a full barrow gets going slowly and needs room to stop
    const accel = (2.9 - 1.9 * load) * (grade > 0 ? 1 - Math.min(0.6, grade * (0.5 + 1.3 * load)) : 1);
    const brake = 5.2 - 3.5 * load;
    const dv = target - this.v;
    const speeding = Math.sign(dv) === Math.sign(this.v) || Math.abs(this.v) < 0.03;
    let a = clamp(dv * 7, -(speeding ? accel : brake), speeding ? accel : brake);
    // downhill it pulls (more the heavier it is); rough ground and an uphill drag slow it
    if (grade < 0 && Math.abs(this.v) > 0.05) a += -grade * 9.81 * (0.08 + 0.26 * load) * Math.sign(this.v);
    a -= Math.sign(this.v) * this.rough * (0.35 + 0.9 * load) * Math.min(1, Math.abs(this.v) * 4);
    this.v += a * dt;
    if (Math.abs(this.v) > vmax * 1.15) this.v = Math.sign(this.v) * vmax * 1.15;
    if (Math.abs(this.v) < 0.004 && Math.abs(target) < 0.001) this.v = 0;
    // turning: steering, and following your look once it is far off the barrow's line
    const off = wrap(camYaw - bw.yaw);
    let wWant = -turn * 1.25;
    if (Math.abs(off) > PUSH.lookFree) wWant += (off - Math.sign(off) * PUSH.lookFree) * 2.8;
    const wMax = (1.55 - 0.8 * load) * (0.5 + 0.5 * Math.min(1, Math.abs(this.v) / 0.8));
    wWant = clamp(wWant, -wMax, wMax);
    const alpha = 6.0 - 3.8 * load;
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

// how far your look may be off the barrow's line (the camera is clamped to it): `soft` springs back
// to PUSH.lookMax, the hard limit holds at once
export function clampLook(camYaw, barrowYaw, soft = true) {
  const off = wrap(camYaw - barrowYaw), m = soft ? PUSH.lookMax : PUSH.lookHard;
  return barrowYaw + clamp(off, -m, m);
}
