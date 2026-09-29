// ============================================================================
// MultiScreen geometry (client side). Mirrors backend/multiscreen/geometry.py
// EXACTLY - same rotation convention, same local coordinate system - but
// only the parts a screen needs to draw its own piece of the shared world
// and to turn a swipe into a world direction. Adjacency, passages, walls and
// validation are never recomputed here: the server sends them.
//
// Tile: {x, y, w, h, rotation, localW, localH} in world units (~mm).
// rotation = how far the screen's own "up" is turned clockwise from world up.
// Local = the screen as its owner sees it: origin top-left, x right, y down.
// ============================================================================
(function () {
  "use strict";

  const DIRS = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
  const SIDE_DIR = { top: "up", right: "right", bottom: "down", left: "left" };
  const DIR_SIDE = { up: "top", right: "right", down: "bottom", left: "left" };

  function worldToLocal(t, wx, wy) {
    const u = wx - t.x, v = wy - t.y;
    switch (t.rotation) {
      case 90: return [v, t.w - u];
      case 180: return [t.w - u, t.h - v];
      case 270: return [t.h - v, u];
      default: return [u, v];
    }
  }

  function localToWorld(t, lx, ly) {
    let u, v;
    switch (t.rotation) {
      case 90: u = t.w - ly; v = lx; break;
      case 180: u = t.w - lx; v = t.h - ly; break;
      case 270: u = ly; v = t.h - lx; break;
      default: u = lx; v = ly;
    }
    return [t.x + u, t.y + v];
  }

  function worldVecToLocal(rotation, dx, dy) {
    switch (rotation) {
      case 90: return [dy, -dx];
      case 180: return [-dx, -dy];
      case 270: return [-dy, dx];
      default: return [dx, dy];
    }
  }

  function localVecToWorld(rotation, dx, dy) {
    switch (rotation) {
      case 90: return [-dy, dx];
      case 180: return [-dx, -dy];
      case 270: return [dy, -dx];
      default: return [dx, dy];
    }
  }

  function vecToDir(v) {
    const x = Math.round(v[0]), y = Math.round(v[1]);
    for (const [k, d] of Object.entries(DIRS)) if (d[0] === x && d[1] === y) return k;
    return null;
  }
  function localDirToWorld(rotation, dir) { return vecToDir(localVecToWorld(rotation, ...DIRS[dir])); }
  function worldDirToLocal(rotation, dir) { return vecToDir(worldVecToLocal(rotation, ...DIRS[dir])); }
  // Which edge of MY screen a world-side of my tile is.
  function worldSideToLocalSide(rotation, side) { return DIR_SIDE[worldDirToLocal(rotation, SIDE_DIR[side])]; }

  function pointInside(t, wx, wy, eps) {
    eps = eps || 0;
    return wx >= t.x - eps && wx <= t.x + t.w + eps && wy >= t.y - eps && wy <= t.y + t.h + eps;
  }

  // Canvas matrix that makes "draw in world units" land on this screen:
  // screen(px) = offset + scale * local(world). Returns the 6 numbers for
  // ctx.setTransform(a, b, c, d, e, f).
  function worldMatrix(t, scale, ox, oy) {
    let m;
    switch (t.rotation) {
      case 90: m = [0, 1, -t.y, -1, 0, t.x + t.w]; break;
      case 180: m = [-1, 0, t.x + t.w, 0, -1, t.y + t.h]; break;
      case 270: m = [0, -1, t.y + t.h, 1, 0, -t.x]; break;
      default: m = [1, 0, -t.x, 0, 1, -t.y];
    }
    // lx = m0*wx + m1*wy + m2 ; ly = m3*wx + m4*wy + m5
    return [scale * m[0], scale * m[3], scale * m[1], scale * m[4], scale * m[2] + ox, scale * m[5] + oy];
  }

  window.MSGeometry = {
    DIRS, worldToLocal, localToWorld, worldVecToLocal, localVecToWorld,
    localDirToWorld, worldDirToLocal, worldSideToLocalSide, pointInside, worldMatrix,
  };
})();
