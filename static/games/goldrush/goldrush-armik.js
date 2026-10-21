// GoldRush - the first-person arm's shared geometry: the two-bone IK from the wrist to the shoulder (phase 8), used by BOTH the
// procedural glove (goldrush-hand.js: the fallback) and the rigged arm (goldrush-fprig.js, FP2.0A). The IK is the same maths as
// ever - fixed segment lengths, never stretched; out of reach the wrist keeps its place and the arm points back at the shoulder.
// What differs is only how the solved points are DRAWN (`_applyArm(W, E, U)`): meshes laid between them, or bones set to them.
//
// Nothing here decides gameplay: poses come from the ToolController's phases (goldrush-tools.js) via goldrush-hand.js.

// the arm (m): shoulder -> elbow, elbow -> wrist - fixed, whatever the hand holds
export const ARM = { upper: 0.31, fore: 0.28 };
// where the shoulders are while the hands work in view space (tools, bucket, pan): just below
// and behind the camera, out to the sides (the right one; mirrored for the left)
export const SHOULDER = [0.25, -0.42, 0.14];
// FP2.0B: when the hand is further from the shoulder than the arm is long (a tool held out in both hands) the shoulder follows
// the hand - the body leans in and the shoulder rolls forward - by at most this much, so the arm keeps an elbow instead of
// hanging straight; beyond it, the old rule (the arm points back at the shoulder, never stretched) still applies
export const SHOULDER_SLACK = 0.4;

// the thumb's root rotation (euler XYZ, the right hand; the left one is mirrored): open = the rest pose of the arm GLB
// (tools/goldrush/build_fp_arms.py THUMB_EULER), grip = closed over a handle, rim = (see GRIPS in goldrush-hand.js)
export const THUMB = { open: [-0.2, 0.55, -0.5], grip: [-0.55, 0.4, -0.9] };

export class GloveBase {
  /** side: +1 right, -1 left; restPose: the pose object to start from (cloned by the caller's helper) */
  constructor(THREE, side, restPose) {
    this.THREE = THREE;
    this.side = side;                              // +1 right, -1 left
    this.root = new THREE.Group();                 // the hand's frame (wrist at 0, fingers towards -z, the back of the hand +y); the left one mirrored by scale.x
    this.arm = new THREE.Group();                  // whatever draws the arm
    this.pose = restPose;
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._e = new THREE.Vector3();
    this._u = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._pole = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._m = new THREE.Matrix4();
    this.info = { fore: ARM.fore, upper: ARM.upper, reach: true };
  }

  // bare-hand pose (view space)
  apply(pose, aspectK, extra) {
    const s = this.side, root = this.root;
    root.position.set(pose.p[0] * s * aspectK + extra.x * s, pose.p[1] + extra.y, pose.p[2]);
    root.rotation.set(pose.r[0] + extra.rx, pose.r[1] * s, pose.r[2] * s, "YXZ");
    root.scale.set(s, 1, 1);
    this.thumb.rotation.set(THUMB.open[0], THUMB.open[1], THUMB.open[2]);
    this._curl(pose.c);
    root.updateMatrix();
    this._arm(aspectK);
  }

  // on a tool grip: m = the glove's full matrix (incl. the mirror); thumb: its own pose (a hand on a
  // rim: hooked over it) instead of closed round a handle
  applyMatrix(m, aspectK, curl = 0.95, thumb = null) {
    const root = this.root;
    m.decompose(root.position, root.quaternion, root.scale);
    if (thumb) this.thumb.rotation.set(thumb[0], thumb[1], thumb[2]);
    else this.thumb.rotation.set(THUMB.grip[0], THUMB.grip[1], THUMB.grip[2]);          // thumb closed over the handle
    this._curl(curl, thumb ? (thumb[3] != null ? thumb[3] : 0.9) : 0.9);
    root.updateMatrix();
    this._arm(aspectK);
  }

  /**
   * The arm from the wrist (just inside the cuff) to the shoulder: two-bone IK with fixed lengths. shoulder / pole: view
   * space (default: the view-space shoulder of this side, the elbow out and down).
   */
  _arm(aspectK, shoulder = null, pole = null) {
    const s = this.side, a = ARM.upper, b = ARM.fore;
    const W = this._a.set(0, -0.004, 0.035).applyMatrix4(this.root.matrix);
    const S = shoulder ? this._b.copy(shoulder) : this._b.set(SHOULDER[0] * s * aspectK, SHOULDER[1], SHOULDER[2]);
    const dir = this._d.subVectors(S, W);
    let d = Math.max(1e-6, dir.length());
    dir.multiplyScalar(1 / d);
    if (!shoulder && d > (a + b) * 0.97) {
      const pull = Math.min(d - (a + b) * 0.97, SHOULDER_SLACK);
      S.addScaledVector(dir, -pull);
      d -= pull;
    }
    const E = this._e, U = this._u;
    let reach = true;
    if (d >= a + b - 1e-6) {
      reach = d <= a + b + 1e-3;
      E.copy(W).addScaledVector(dir, b);
      U.copy(E).addScaledVector(dir, a);
    } else {
      // the elbow: the law of cosines at the wrist, bent towards the pole (out and down)
      const dd = Math.max(d, Math.abs(a - b) + 1e-4);
      const cw = Math.max(-1, Math.min(1, (b * b + dd * dd - a * a) / (2 * b * dd))), sw = Math.sqrt(1 - cw * cw);
      const P = pole ? this._pole.copy(pole) : this._pole.set(s * 0.85, -0.6, 0.25);
      P.addScaledVector(dir, -P.dot(dir));
      if (P.lengthSq() < 1e-8) P.set(s, 0, 0).addScaledVector(dir, -dir.x * s);
      P.normalize();
      E.copy(W).addScaledVector(dir, cw * b).addScaledVector(P, sw * b);
      U.subVectors(S, E).normalize().multiplyScalar(a).add(E);
    }
    this._applyArm(W, E, U);
    this.info.fore = W.distanceTo(E);
    this.info.upper = E.distanceTo(U);
    this.info.reach = reach;
  }

  /** draw the solved arm: wrist W, elbow E, shoulder point U (view space) - the subclass's business */
  _applyArm() {}
}
