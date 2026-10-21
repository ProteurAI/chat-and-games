// GoldRush - FP2.0B: the first-person tool CLIPS. What the ToolController does is unchanged (its phases and their durations are
// gameplay: goldrush-tools.js); this module only says how the tool MOVES inside one controller phase - a few waypoints per phase,
// each with its own easing, so an action reads as windup / downswing / contact / pull / recovery instead of one lerp per phase.
//
//   - A clip is data: per tool, per controller phase, a list of waypoints [u, target, ease, arc?]. u = how far through the phase
//     (0..1, the controller's own `u`), target = a TOOL_KEYS key name (or [name, dp, dr]: that key with a small offset),
//     ease = the speed curve to get there, arc = a bulge (p / r) laid over the segment so the path curves like a swing.
//   - The first segment of a phase starts where the previous phase ENDED (its last waypoint) - not where the last frame happened
//     to be drawn - so a phase boundary never pops, at any frame rate.
//   - Nothing here decides a hit, an amount, gold or a duration. The tool follows the phases it is given.

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

// speed curves (t 0..1 -> 0..1)
export const EASES = {
  lin: (t) => t,
  in: (t) => t * t,
  in3: (t) => t * t * t,                                          // a heavy start: the downswing gathers speed
  out: (t) => 1 - (1 - t) * (1 - t),
  out3: (t) => 1 - (1 - t) * (1 - t) * (1 - t),
  inout: (t) => t * t * (3 - 2 * t),
  inout5: (t) => t * t * t * (t * (6 * t - 15) + 10),             // slower at both ends than inout: a heavy lift that hangs at the top
};

// the waypoints. A waypoint's target is a TOOL_KEYS key of the tool ("rest", "windup", ...) or [key, dp, dr].
// The `pre*` poses (the anticipation: a small dip before the lift) and `carry` are derived from rest / dump below.
export const CLIPS = {
  shovel: {
    // wind-in: a short dip and lean into the handle, then the controlled lift (blade up, pulled back)
    windup: [[0.26, ["rest", [0.004, -0.022, 0.03], [0.07, 0, -0.02]], "out"], [1, "windup", "inout"]],
    // the downswing: the speed builds all the way to the contact (the blade arrives at full speed), on a slightly lifted arc
    thrust: [[1, "thrust", "in3", { p: [0, 0.03, 0.01], r: [-0.05, 0, 0] }]],
    // contact is read for a moment (the blade rests on the point, pressed in a little), then the handle is pressed down: the load comes up
    scoop: [[0.34, ["thrust", [0, -0.01, -0.012], [-0.02, 0, 0]], "out"], [1, "scoop", "inout"]],
    // carried aside and tipped (held a moment - the load slides off), then brought back; arrives at rest before the recovery phase
    dump: [[0.46, "dump", "inout5"], [0.6, ["dump", [0.005, 0.004, 0], [0.03, 0, 0.05]], "inout"], [1, "rest", "inout"]],
    // the last settle of the weight on the grip (the pose is already near rest here)
    recover: [[0.5, ["rest", [0, 0.007, 0.004], [-0.025, 0, 0]], "out"], [1, "rest", "inout"]],
    recoil: [[0.5, "recoil", "out3"], [1, ["recoil", [0.004, 0.004, 0.004], [-0.02, 0, 0.02]], "inout"]],
  },
  pickaxe: {
    // the lift: a small dip first, then the heavy swing up over the shoulder (hangs at the top); stays in the view (FP2.0B)
    raise: [[0.2, ["rest", [0, -0.03, 0.03], [0.1, 0, 0]], "out"], [1, "raise", "inout5"]],
    // the downswing: accelerates all the way, on an arc; the point meets the ground at full speed
    swing: [[1, "swing", "in", { p: [-0.015, 0.035, -0.02], r: [0.08, 0, 0] }]],
    // the recoil: thrown back at once, then let down slowly (the weight of the head)
    recoil: [[0.4, "recoil", "out3"], [1, ["recoil", [0.006, 0.01, 0.006], [-0.05, 0, 0]], "inout"]],
    recover: [[1, "rest", "inout5"]],
  },
};

const resolved = new WeakMap();
function resolve(keys, tool) {
  const all = resolved.get(keys) || {};
  if (all[tool]) return all[tool];
  const res = {};
  for (const [phase, wps] of Object.entries(CLIPS[tool] || {})) {
    res[phase] = wps.map(([u, to, e, arc]) => {
      const name = Array.isArray(to) ? to[0] : to, k = keys[tool][name], dp = Array.isArray(to) ? to[1] : null, dr = Array.isArray(to) ? to[2] : null;
      if (!k) throw new Error(`fpclips: ${tool} has no key ${name}`);
      return { u, pose: { p: [k.p[0] + (dp ? dp[0] : 0), k.p[1] + (dp ? dp[1] : 0), k.p[2] + (dp ? dp[2] : 0)], r: [k.r[0] + (dr ? dr[0] : 0), k.r[1] + (dr ? dr[1] : 0), k.r[2] + (dr ? dr[2] : 0)] },
        ease: EASES[e] || EASES.inout, arc: arc || null };
    });
  }
  all[tool] = res;
  resolved.set(keys, all);
  return res;
}

/** does this tool have a clip for the controller phase? */
export const hasClip = (tool, phase) => !!(CLIPS[tool] && CLIPS[tool][phase]);

/** the pose the phase ENDS in (its last waypoint) - the next phase starts from it, so a boundary never pops */
export function endPose(keys, tool, phase) {
  const c = resolve(keys, tool)[phase];
  return c ? c[c.length - 1].pose : null;
}

/** sample the phase at u (0..1) starting from `from` ({p, r}); writes {p, r} into out */
export function sampleClip(keys, tool, phase, from, u, out) {
  const wps = resolve(keys, tool)[phase];
  u = clamp01(u);
  let a = from, ua = 0, b = wps[0];
  for (let i = 0; i < wps.length; i++) {
    b = wps[i];
    if (u <= b.u || i === wps.length - 1) break;
    a = b.pose;
    ua = b.u;
  }
  const t = clamp01((u - ua) / Math.max(1e-6, b.u - ua)), e = b.ease(t), bulge = b.arc ? Math.sin(Math.PI * t) : 0;
  for (let i = 0; i < 3; i++) {
    out.p[i] = a.p[i] + (b.pose.p[i] - a.p[i]) * e + (b.arc ? b.arc.p[i] * bulge : 0);
    out.r[i] = a.r[i] + (b.pose.r[i] - a.r[i]) * e + (b.arc ? b.arc.r[i] * bulge : 0);
  }
  return out;
}
