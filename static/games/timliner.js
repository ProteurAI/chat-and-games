// ============================================================================
// TimLiner - a self-contained single-player "draw a track, ride it" physics
// game for Chat & Games, inspired functionally by linerider.com but built
// from scratch: own rider graphic, own physics, own file format, own UI.
//
// No multiplayer, no server game-state, no WebSocket traffic of its own -
// everything here is client-only. app.js just calls TimLiner.mount(stageEl)
// when the player clicks "Spielen" and TimLiner.destroy() when the game
// modal closes; the shared chat panel next to it is untouched (see
// initGameChatPanel/renderMessage in app.js - this file never talks to it).
//
// Organized into the sections the spec asked for: World/Camera, Track model,
// spatial Grid, Undo/Redo History, Physics (rider + collision), Renderer,
// Editor (tools/pointer/keyboard), Playback, Persistence, Sound, and the UI
// that wires them together. Plain objects/closures throughout - no build
// step, no classes needed for this to stay readable.
// ============================================================================

(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------
  const LINE_TYPES = { PHYSICS: "physics", BOOST: "boost", SCENERY: "scenery" };
  const LINE_COLORS = { physics: "#2f6fd6", boost: "#e6394d", scenery: "#2fa84f" };
  const FIXED_DT = 1 / 60;
  const SUBSTEPS = 8;
  const SUB_DT = FIXED_DT / SUBSTEPS;
  const GRAVITY = 1600; // world units / s^2
  const AIR_DAMPING = 0.9995; // per substep, keeps numerical drift from adding energy
  const GROUND_FRICTION = 0.985; // tangential velocity retained per contact resolution
  const BOOST_IMPULSE = 26; // extra tangential speed per substep of boost contact
  const MAX_SPEED = 2600;
  const RIDER_RADIUS = 7; // collision radius of each rider point, world units
  const CONSTRAINT_ITERATIONS = 4;
  const MIN_SAMPLE_DIST = 6; // world units between freehand points before a new one is recorded
  const ERASER_RADIUS = 14;
  const SELECT_RADIUS = 10;
  const GRID_CELL = 220;
  const MAX_UNDO = 200;
  const ONBOARDING_KEY = "timliner_onboarding_seen";
  const STORAGE_KEY = "timliner_tracks";
  const SOUND_KEY = "timliner_sound_enabled";

  let uid = 1;
  function nextId() { return uid++; }

  // ---------------------------------------------------------------------
  // World / Camera - screen <-> world mapping lives ONLY here, so every
  // other system (editor, renderer, physics) works in world units and never
  // has to know about zoom, pan, canvas size, or devicePixelRatio.
  // ---------------------------------------------------------------------
  function createCamera() {
    return {
      x: 0, y: 0, zoom: 1,
      viewW: 800, viewH: 600,
      worldToScreen(wx, wy) {
        return {
          x: (wx - this.x) * this.zoom + this.viewW / 2,
          y: (wy - this.y) * this.zoom + this.viewH / 2,
        };
      },
      screenToWorld(sx, sy) {
        return {
          x: (sx - this.viewW / 2) / this.zoom + this.x,
          y: (sy - this.viewH / 2) / this.zoom + this.y,
        };
      },
      zoomAt(sx, sy, factor) {
        const before = this.screenToWorld(sx, sy);
        this.zoom = Math.min(6, Math.max(0.08, this.zoom * factor));
        const after = this.screenToWorld(sx, sy);
        this.x += before.x - after.x;
        this.y += before.y - after.y;
      },
      pan(dxScreen, dyScreen) {
        this.x -= dxScreen / this.zoom;
        this.y -= dyScreen / this.zoom;
      },
      centerOn(wx, wy, leadX) {
        this.x = wx + (leadX || 0);
        this.y = wy;
      },
    };
  }

  // ---------------------------------------------------------------------
  // Track model - the only data that gets saved/exported. Every line is an
  // independent 2-point segment (freehand strokes are just many of them);
  // this keeps collision, undo, and erasing all simple and uniform instead
  // of needing separate polyline vs. segment logic.
  // ---------------------------------------------------------------------
  function createTrack() {
    return {
      lines: [], // {id, type, x1,y1,x2,y2}
      start: { x: 0, y: -40, angle: 0 },
    };
  }

  function addLine(track, type, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    if (dx * dx + dy * dy < 0.01) return null; // reject zero-length
    const line = { id: nextId(), type, x1, y1, x2, y2 };
    track.lines.push(line);
    return line;
  }

  function removeLineById(track, id) {
    const idx = track.lines.findIndex((l) => l.id === id);
    if (idx === -1) return null;
    return track.lines.splice(idx, 1)[0];
  }

  function trackToJSON(track, name) {
    return {
      version: 1,
      name: name || "Unbenannte Strecke",
      start: { x: track.start.x, y: track.start.y, angle: track.start.angle || 0 },
      lines: track.lines.map((l) => ({
        type: l.type,
        points: [{ x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }],
      })),
    };
  }

  function validateTrackJSON(data) {
    if (!data || typeof data !== "object") return false;
    if (!data.start || typeof data.start.x !== "number" || typeof data.start.y !== "number") return false;
    if (!Array.isArray(data.lines)) return false;
    for (const l of data.lines) {
      if (!l || typeof l !== "object") return false;
      if (![LINE_TYPES.PHYSICS, LINE_TYPES.BOOST, LINE_TYPES.SCENERY].includes(l.type)) return false;
      if (!Array.isArray(l.points) || l.points.length !== 2) return false;
      for (const p of l.points) {
        if (typeof p.x !== "number" || typeof p.y !== "number" || !isFinite(p.x) || !isFinite(p.y)) return false;
      }
    }
    return true;
  }

  function trackFromJSON(data) {
    const track = createTrack();
    track.start = { x: data.start.x, y: data.start.y, angle: data.start.angle || 0 };
    for (const l of data.lines) {
      addLine(track, l.type, l.points[0].x, l.points[0].y, l.points[1].x, l.points[1].y);
    }
    return track;
  }

  // ---------------------------------------------------------------------
  // Spatial grid - buckets line ids by cell so physics only tests segments
  // actually near a rider point instead of the whole track every substep.
  // Rebuilt whenever the track changes (cheap - only happens in edit mode
  // or once when Play starts), never rebuilt mid-simulation.
  // ---------------------------------------------------------------------
  function createGrid() {
    return { cell: GRID_CELL, map: new Map(), byId: new Map() };
  }
  function gridKey(cx, cy) { return cx + "," + cy; }
  function gridCellsForLine(grid, l) {
    const minX = Math.floor(Math.min(l.x1, l.x2) / grid.cell);
    const maxX = Math.floor(Math.max(l.x1, l.x2) / grid.cell);
    const minY = Math.floor(Math.min(l.y1, l.y2) / grid.cell);
    const maxY = Math.floor(Math.max(l.y1, l.y2) / grid.cell);
    const keys = [];
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) keys.push(gridKey(cx, cy));
    }
    return keys;
  }
  function rebuildGrid(grid, lines) {
    grid.map.clear();
    grid.byId.clear();
    for (const l of lines) {
      if (l.type === LINE_TYPES.SCENERY) continue; // never collides, skip entirely
      grid.byId.set(l.id, l);
      for (const key of gridCellsForLine(grid, l)) {
        let arr = grid.map.get(key);
        if (!arr) { arr = []; grid.map.set(key, arr); }
        arr.push(l.id);
      }
    }
  }
  function queryNear(grid, x, y, radius) {
    const minX = Math.floor((x - radius) / grid.cell);
    const maxX = Math.floor((x + radius) / grid.cell);
    const minY = Math.floor((y - radius) / grid.cell);
    const maxY = Math.floor((y + radius) / grid.cell);
    const seen = new Set();
    const out = [];
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        const arr = grid.map.get(gridKey(cx, cy));
        if (!arr) continue;
        for (const id of arr) {
          if (seen.has(id)) continue;
          seen.add(id);
          out.push(grid.byId.get(id));
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Undo / redo - each entry is a diff {added:[lines], removed:[lines]}.
  // Freehand strokes and eraser drags are committed as ONE entry each
  // (collected during the gesture, pushed on pointerup), so one Ctrl+Z
  // undoes "that stroke", not one tiny segment at a time.
  // ---------------------------------------------------------------------
  function createHistory() {
    return { undo: [], redo: [] };
  }
  function historyPush(hist, entry) {
    if (!entry.added.length && !entry.removed.length) return;
    hist.undo.push(entry);
    if (hist.undo.length > MAX_UNDO) hist.undo.shift();
    hist.redo.length = 0;
  }
  function historyUndo(hist, track) {
    const entry = hist.undo.pop();
    if (!entry) return false;
    for (const l of entry.added) removeLineById(track, l.id);
    for (const l of entry.removed) track.lines.push(l);
    hist.redo.push(entry);
    return true;
  }
  function historyRedo(hist, track) {
    const entry = hist.redo.pop();
    if (!entry) return false;
    for (const l of entry.removed) removeLineById(track, l.id);
    for (const l of entry.added) track.lines.push(l);
    hist.undo.push(entry);
    return true;
  }

  // ---------------------------------------------------------------------
  // Geometry helpers
  // ---------------------------------------------------------------------
  function segClosestPoint(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 1e-9 ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    return { x: x1 + dx * t, y: y1 + dy * t, t };
  }
  // returns intersection point of segment (ax,ay)-(bx,by) and (cx,cy)-(dx,dy), or null
  function segIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
    const d1x = bx - ax, d1y = by - ay;
    const d2x = dx - cx, d2y = dy - cy;
    const denom = d1x * d2y - d1y * d2x;
    if (Math.abs(denom) < 1e-9) return null;
    const t = ((cx - ax) * d2y - (cy - ay) * d2x) / denom;
    const u = ((cx - ax) * d1y - (cy - ay) * d1x) / denom;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { x: ax + d1x * t, y: ay + d1y * t, t };
  }

  // ---------------------------------------------------------------------
  // Rider / Physics - a small Verlet point system (sledBack, sledFront,
  // hip, shoulder) held together by distance constraints instead of a
  // rigid body. Deliberately simple: stable riding + collision first,
  // expressive tumbling falls out of the same system for free once a
  // constraint breaks contact, without needing a separate "crash" animation.
  // ---------------------------------------------------------------------
  const RIDER_SHAPE = {
    sledLen: 46,
    sledToHip: 24,
    hipToShoulder: 26,
    sledFrontToHip: 30,
    shoulderToSledFront: 40,
  };

  function createRider() {
    return { points: {}, crashed: false, crashedAt: 0, speed: 0, groundedSubsteps: 0 };
  }

  function placeRiderAt(rider, x, y, angle) {
    const a = angle || 0;
    const ca = Math.cos(a), sa = Math.sin(a);
    function pt(lx, ly) {
      // lx forward(+)/back(-) along sled, ly down(+)/up(-)
      const wx = x + lx * ca - ly * sa;
      const wy = y + lx * sa + ly * ca;
      return { x: wx, y: wy, px: wx, py: wy };
    }
    rider.points.sledBack = pt(-RIDER_SHAPE.sledLen / 2, 0);
    rider.points.sledFront = pt(RIDER_SHAPE.sledLen / 2, 0);
    rider.points.hip = pt(0, -RIDER_SHAPE.sledToHip);
    rider.points.shoulder = pt(6, -RIDER_SHAPE.sledToHip - RIDER_SHAPE.hipToShoulder);
    rider.crashed = false;
    rider.crashedAt = 0;
    rider.speed = 0;
    rider.groundedSubsteps = 0;
  }

  const RIDER_CONSTRAINTS = [
    ["sledBack", "sledFront", RIDER_SHAPE.sledLen, 1.0],
    ["sledBack", "hip", Math.hypot(RIDER_SHAPE.sledLen / 2, RIDER_SHAPE.sledToHip), 0.6],
    ["sledFront", "hip", RIDER_SHAPE.sledFrontToHip, 0.6],
    ["hip", "shoulder", RIDER_SHAPE.hipToShoulder, 0.5],
    ["sledFront", "shoulder", RIDER_SHAPE.shoulderToSledFront, 0.35],
  ];

  function verletIntegrate(p, ax, ay, dt) {
    const vx = (p.x - p.px) * AIR_DAMPING;
    const vy = (p.y - p.py) * AIR_DAMPING;
    const nx = p.x + vx + ax * dt * dt;
    const ny = p.y + vy + ay * dt * dt;
    p.px = p.x; p.py = p.y;
    p.x = nx; p.y = ny;
  }

  function solveConstraints(points) {
    for (let it = 0; it < CONSTRAINT_ITERATIONS; it++) {
      for (const [aKey, bKey, restLen, stiffness] of RIDER_CONSTRAINTS) {
        const a = points[aKey], b = points[bKey];
        let dx = b.x - a.x, dy = b.y - a.y;
        let dist = Math.hypot(dx, dy) || 0.0001;
        const diff = ((dist - restLen) / dist) * stiffness * 0.5;
        const ox = dx * diff, oy = dy * diff;
        a.x += ox; a.y += oy;
        b.x -= ox; b.y -= oy;
      }
    }
  }

  // Resolves collision for a single point against nearby segments. Uses a
  // swept test (previous->current movement vs. each segment) to catch fast
  // tunneling, plus a resting-proximity test for slow/settled contact.
  function collidePoint(p, grid, boostAccum) {
    const nearby = queryNear(grid, p.x, p.y, RIDER_RADIUS + 40);
    if (!nearby.length) return;
    let contactType = null;
    for (const l of nearby) {
      const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
      const len = Math.hypot(dx, dy) || 0.0001;
      // Normal points "up" (away from the direction gravity pulls things
      // onto the line) for a line drawn left-to-right, matching the usual
      // "draw left-to-right = track surface faces the sky" convention:
      // start->end determines which side is collidable.
      const nx = dy / len, ny = -dx / len;

      // 1) swept crossing test (previous position -> new position)
      const hit = segIntersect(p.px, p.py, p.x, p.y, l.x1, l.y1, l.x2, l.y2);
      let resolved = false;
      if (hit) {
        const side = (p.px - l.x1) * nx + (p.py - l.y1) * ny;
        if (side >= 0) {
          p.x = hit.x + nx * RIDER_RADIUS * 0.6;
          p.y = hit.y + ny * RIDER_RADIUS * 0.6;
          resolved = true;
        }
      }

      // 2) resting-proximity test
      if (!resolved) {
        const cp = segClosestPoint(p.x, p.y, l.x1, l.y1, l.x2, l.y2);
        const ddx = p.x - cp.x, ddy = p.y - cp.y;
        const dist = Math.hypot(ddx, ddy);
        if (dist < RIDER_RADIUS) {
          const side = ddx * nx + ddy * ny >= 0 ? 1 : -1;
          if (side > 0) {
            const push = RIDER_RADIUS - dist;
            p.x += nx * push;
            p.y += ny * push;
            resolved = true;
          }
        }
      }

      if (!resolved) continue;

      // velocity response: kill the normal component, keep + slightly
      // dampen the tangential one (friction); boost lines add impulse.
      let vx = p.x - p.px, vy = p.y - p.py;
      const vn = vx * nx + vy * ny;
      if (vn < 0) { vx -= vn * nx; vy -= vn * ny; }
      const tx = dx / len, ty = dy / len;
      let vt = vx * tx + vy * ty;
      vt *= GROUND_FRICTION;
      let outVx = tx * vt, outVy = ty * vt;
      if (l.type === LINE_TYPES.BOOST) {
        const dir = vt >= 0 ? 1 : -1;
        outVx += tx * dir * BOOST_IMPULSE;
        outVy += ty * dir * BOOST_IMPULSE;
        contactType = LINE_TYPES.BOOST;
      } else if (contactType !== LINE_TYPES.BOOST) {
        contactType = LINE_TYPES.PHYSICS;
      }
      const speed = Math.hypot(outVx, outVy);
      if (speed > MAX_SPEED) { outVx = (outVx / speed) * MAX_SPEED; outVy = (outVy / speed) * MAX_SPEED; }
      p.px = p.x - outVx;
      p.py = p.y - outVy;
    }
    if (contactType) boostAccum.contact = contactType;
    return contactType;
  }

  function physicsSubstep(rider, grid) {
    const pts = rider.points;
    for (const key in pts) verletIntegrate(pts[key], 0, GRAVITY, SUB_DT);
    solveConstraints(pts);
    let anyContact = false;
    const accum = {};
    for (const key in pts) {
      const c = collidePoint(pts[key], grid, accum);
      if (c) anyContact = true;
    }
    solveConstraints(pts);
    if (anyContact) rider.groundedSubsteps++; else rider.groundedSubsteps = 0;

    // crash: head/shoulder slamming into a segment hard, or losing all
    // rigidity (sled badly overstretched from a violent impact)
    const sledDist = Math.hypot(pts.sledFront.x - pts.sledBack.x, pts.sledFront.y - pts.sledBack.y);
    if (!rider.crashed) {
      const shoulderSpeed = Math.hypot(pts.shoulder.x - pts.shoulder.px, pts.shoulder.y - pts.shoulder.py);
      if (sledDist > RIDER_SHAPE.sledLen * 1.9) rider.crashed = true;
      if (shoulderSpeed > 90 && anyContact) {
        // only a crash if the shoulder itself is the thing making contact
        const shoulderNear = queryNear(grid, pts.shoulder.x, pts.shoulder.y, RIDER_RADIUS + 2);
        if (shoulderNear.length) rider.crashed = true;
      }
    }
  }

  function physicsStep(rider, grid, dt) {
    const steps = Math.round(dt / SUB_DT);
    for (let i = 0; i < steps; i++) physicsSubstep(rider, grid);
    const p = rider.points.sledBack;
    rider.speed = Math.hypot(p.x - p.px, p.y - p.py) / dt;
  }

  // ---------------------------------------------------------------------
  // Renderer
  // ---------------------------------------------------------------------
  function drawGrid(ctx, camera, colorMinor) {
    const step = 100;
    const topLeft = camera.screenToWorld(0, 0);
    const botRight = camera.screenToWorld(camera.viewW, camera.viewH);
    const startX = Math.floor(topLeft.x / step) * step;
    const startY = Math.floor(topLeft.y / step) * step;
    ctx.strokeStyle = colorMinor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = startX; x < botRight.x; x += step) {
      const a = camera.worldToScreen(x, topLeft.y);
      const b = camera.worldToScreen(x, botRight.y);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    for (let y = startY; y < botRight.y; y += step) {
      const a = camera.worldToScreen(topLeft.x, y);
      const b = camera.worldToScreen(botRight.x, y);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }

  function drawLines(ctx, camera, lines, selectedId, hoverId) {
    for (const l of lines) {
      const a = camera.worldToScreen(l.x1, l.y1);
      const b = camera.worldToScreen(l.x2, l.y2);
      ctx.strokeStyle = LINE_COLORS[l.type];
      ctx.lineWidth = l.type === LINE_TYPES.SCENERY ? 2.5 : 4.5;
      ctx.lineCap = "round";
      if (l.id === selectedId) {
        ctx.save();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = (l.type === LINE_TYPES.SCENERY ? 2.5 : 4.5) + 5;
        ctx.globalAlpha = 0.35;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.restore();
      } else if (l.id === hoverId) {
        ctx.save();
        ctx.globalAlpha = 0.25;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = (l.type === LINE_TYPES.SCENERY ? 2.5 : 4.5) + 4;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.restore();
      }
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  function drawStartMarker(ctx, camera, start) {
    const s = camera.worldToScreen(start.x, start.y);
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(start.angle || 0);
    ctx.fillStyle = "rgba(244,124,72,0.18)";
    ctx.beginPath(); ctx.arc(0, 0, 22, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#F47C48";
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(0, 0, 22, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#F47C48";
    ctx.beginPath();
    ctx.moveTo(-6, 6); ctx.lineTo(10, 0); ctx.lineTo(-6, -6); ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Custom minimalist rider-on-a-sled graphic (own design, no external
  // assets): rounded sled plank, simple body/head, a scarf that trails
  // behind based on current speed/direction.
  function drawRider(ctx, camera, rider) {
    const p = rider.points;
    const sled = camera.worldToScreen(p.sledBack.x, p.sledBack.y);
    const sledF = camera.worldToScreen(p.sledFront.x, p.sledFront.y);
    const hip = camera.worldToScreen(p.hip.x, p.hip.y);
    const shoulder = camera.worldToScreen(p.shoulder.x, p.shoulder.y);
    const z = camera.zoom;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // sled plank - a small filled "stadium" shape (flat back, rounded
    // front) rather than a thin stroked line, so it clearly reads as a
    // sled and not a circle even at small zoom levels.
    {
      const sdx = sledF.x - sled.x, sdy = sledF.y - sled.y;
      const angle = Math.atan2(sdy, sdx);
      const halfLen = Math.hypot(sdx, sdy) / 2;
      const midX = (sled.x + sledF.x) / 2, midY = (sled.y + sledF.y) / 2;
      const thick = 5 * z;
      ctx.save();
      ctx.translate(midX, midY);
      ctx.rotate(angle);
      ctx.fillStyle = "#8a5c36";
      ctx.beginPath();
      ctx.moveTo(-halfLen, -thick);
      ctx.lineTo(halfLen - thick, -thick);
      ctx.arc(halfLen - thick, 0, thick, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(-halfLen, thick);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#5a3d26";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
    }

    // legs (hip -> sled contact point, midway front/back)
    const footX = (sled.x + sledF.x) / 2, footY = (sled.y + sledF.y) / 2;
    ctx.strokeStyle = "#2b2f3a";
    ctx.lineWidth = 5 * z;
    ctx.beginPath(); ctx.moveTo(hip.x, hip.y); ctx.lineTo(footX, footY); ctx.stroke();

    // scarf: a few segments trailing opposite of velocity
    const vx = p.shoulder.x - p.shoulder.px, vy = p.shoulder.y - p.shoulder.py;
    const speed = Math.hypot(vx, vy);
    const dirX = speed > 0.01 ? vx / speed : 1, dirY = speed > 0.01 ? vy / speed : 0;
    const flutter = Math.min(1, speed / 12);
    ctx.strokeStyle = "#F47C48";
    ctx.lineWidth = 4.5 * z;
    let sx = shoulder.x, sy = shoulder.y;
    for (let i = 1; i <= 3; i++) {
      const wobble = Math.sin(Date.now() / 90 + i) * 4 * flutter;
      const nx = sx - dirX * 9 * z + -dirY * wobble;
      const ny = sy - dirY * 9 * z + dirX * wobble;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(nx, ny); ctx.stroke();
      sx = nx; sy = ny;
    }

    // torso
    ctx.strokeStyle = "#3457c9";
    ctx.lineWidth = 7 * z;
    ctx.beginPath(); ctx.moveTo(hip.x, hip.y); ctx.lineTo(shoulder.x, shoulder.y); ctx.stroke();

    // arm (shoulder -> a point ahead near sled front, simple gesture)
    ctx.strokeStyle = "#3457c9";
    ctx.lineWidth = 4.5 * z;
    const armX = shoulder.x + (sledF.x - shoulder.x) * 0.55;
    const armY = shoulder.y + (sledF.y - shoulder.y) * 0.55;
    ctx.beginPath(); ctx.moveTo(shoulder.x, shoulder.y); ctx.lineTo(armX, armY); ctx.stroke();

    // head
    ctx.fillStyle = "#f2c9a0";
    ctx.beginPath(); ctx.arc(shoulder.x, shoulder.y - 8 * z, 7 * z, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.15)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // little cap
    ctx.fillStyle = "#F47C48";
    ctx.beginPath();
    ctx.arc(shoulder.x, shoulder.y - 8 * z, 7.5 * z, Math.PI, 0);
    ctx.fill();

    ctx.restore();
  }

  // ---------------------------------------------------------------------
  // Public module: everything below wires the systems above into a mounted
  // DOM instance. Kept intentionally on the instance object (not module
  // globals) so mount()/destroy() can't leak state between sessions if the
  // player opens TimLiner more than once.
  // ---------------------------------------------------------------------
  function mount(stageEl) {
    const state = {
      camera: createCamera(),
      track: createTrack(),
      grid: createGrid(),
      history: createHistory(),
      rider: createRider(),
      mode: "edit", // 'edit' | 'play' | 'paused'
      tool: "pencil",
      lineType: LINE_TYPES.PHYSICS,
      followCamera: true,
      selectedId: null,
      hoverId: null,
      currentStroke: null, // {points:[{x,y}], addedLines:[]}
      panLast: null,
      spaceHeld: false,
      playElapsed: 0,
      soundEnabled: (function () { const v = localStorage.getItem(SOUND_KEY); return v === null ? true : v === "1"; })(),
      dpr: window.devicePixelRatio || 1,
      raf: null,
      lastFrameTime: null,
      accumulator: 0,
    };

    // ---- DOM ----
    const root = document.createElement("div");
    root.className = "tl-root";
    root.innerHTML = `
      <div class="tl-toolbar" role="toolbar" aria-label="Werkzeuge">
        <div class="tl-tool-group" data-role="tools">
          <button type="button" class="tl-tool-btn" data-tool="pencil" title="Freihand zeichnen (Q)" aria-label="Freihand zeichnen">${ICONS.pencil}</button>
          <button type="button" class="tl-tool-btn" data-tool="line" title="Gerade Linie (W)" aria-label="Gerade Linie">${ICONS.line}</button>
          <button type="button" class="tl-tool-btn" data-tool="eraser" title="Radieren (E)" aria-label="Radieren">${ICONS.eraser}</button>
          <button type="button" class="tl-tool-btn" data-tool="select" title="Auswählen (V)" aria-label="Auswählen">${ICONS.select}</button>
          <button type="button" class="tl-tool-btn" data-tool="pan" title="Verschieben (Leertaste halten oder H)" aria-label="Verschieben">${ICONS.pan}</button>
        </div>
        <div class="tl-sep"></div>
        <div class="tl-tool-group" data-role="colors">
          <button type="button" class="tl-color-btn tl-color-physics" data-line-type="physics" title="Blaue Fahrbahn (1)" aria-label="Fahrbahn"></button>
          <button type="button" class="tl-color-btn tl-color-boost" data-line-type="boost" title="Rote Boost-Linie (2)" aria-label="Boost"></button>
          <button type="button" class="tl-color-btn tl-color-scenery" data-line-type="scenery" title="Grüne Dekoration (3)" aria-label="Dekoration"></button>
        </div>
        <div class="tl-sep"></div>
        <div class="tl-tool-group">
          <button type="button" class="tl-tool-btn" data-action="undo" title="Rückgängig (Ctrl+Z)" aria-label="Rückgängig">${ICONS.undo}</button>
          <button type="button" class="tl-tool-btn" data-action="redo" title="Wiederholen (Ctrl+Y)" aria-label="Wiederholen">${ICONS.redo}</button>
        </div>
        <div class="tl-sep"></div>
        <div class="tl-tool-group">
          <button type="button" class="tl-tool-btn" data-action="zoom-out" title="Verkleinern" aria-label="Verkleinern">${ICONS.minus}</button>
          <button type="button" class="tl-tool-btn" data-action="zoom-in" title="Vergrößern" aria-label="Vergrößern">${ICONS.plus}</button>
        </div>
      </div>

      <div class="tl-canvas-wrap">
        <canvas class="tl-canvas"></canvas>
        <div class="tl-side">
          <button type="button" class="tl-side-btn" data-action="new-track" title="Neue Strecke">${ICONS.file} <span>Neue Strecke</span></button>
          <button type="button" class="tl-side-btn" data-action="my-tracks" title="Meine Strecken">${ICONS.folder} <span>Meine Strecken</span></button>
          <button type="button" class="tl-side-btn" data-action="save" title="Speichern">${ICONS.save} <span>Speichern</span></button>
          <button type="button" class="tl-side-btn" data-action="export" title="Exportieren">${ICONS.download} <span>Export</span></button>
          <button type="button" class="tl-side-btn" data-action="import" title="Importieren">${ICONS.upload} <span>Import</span></button>
          <button type="button" class="tl-side-btn" data-action="sound" title="Sound an/aus">${ICONS.sound} <span>Sound</span></button>
          <button type="button" class="tl-side-btn" data-action="help" title="Hilfe">${ICONS.help} <span>Hilfe</span></button>
        </div>
        <div class="tl-mode-badge" data-role="mode-badge">BEARBEITEN</div>
        <button type="button" class="tl-follow-btn" data-action="follow" title="Kamera folgt Fahrer" hidden>${ICONS.camera} Folgen</button>
        <div class="tl-onboarding" data-role="onboarding" hidden></div>
        <input type="file" class="tl-file-input" accept="application/json" hidden />
      </div>

      <div class="tl-playback">
        <button type="button" class="tl-play-btn" data-action="playback-reset" title="Zurücksetzen (⏮)" aria-label="Zurücksetzen">${ICONS.rewind}</button>
        <button type="button" class="tl-play-btn tl-play-btn--primary" data-action="playback-toggle" title="Play/Pause (Enter)" aria-label="Play/Pause">${ICONS.play}</button>
        <button type="button" class="tl-play-btn" data-action="playback-stop" title="Stop / Bearbeiten (Esc)" aria-label="Stop">${ICONS.stop}</button>
        <span class="tl-playback-time" data-role="time">00:00</span>
        <span class="tl-playback-crash" data-role="crash-msg" hidden>💥 Gestürzt</span>
        <div class="tl-playback-spacer"></div>
        <button type="button" class="tl-play-btn tl-play-btn--again" data-action="again" title="Nochmal">↺ Nochmal</button>
      </div>
    `;
    stageEl.appendChild(root);

    const canvas = root.querySelector(".tl-canvas");
    const ctx = canvas.getContext("2d");
    const modeBadge = root.querySelector('[data-role="mode-badge"]');
    const timeLabel = root.querySelector('[data-role="time"]');
    const crashMsg = root.querySelector('[data-role="crash-msg"]');
    const followBtn = root.querySelector(".tl-follow-btn");
    const fileInput = root.querySelector(".tl-file-input");
    const onboardingBox = root.querySelector('[data-role="onboarding"]');

    // ---- sizing ----
    function resize() {
      const rect = root.querySelector(".tl-canvas-wrap").getBoundingClientRect();
      state.dpr = window.devicePixelRatio || 1;
      state.camera.viewW = rect.width;
      state.camera.viewH = rect.height;
      canvas.width = Math.max(1, Math.round(rect.width * state.dpr));
      canvas.height = Math.max(1, Math.round(rect.height * state.dpr));
      canvas.style.width = rect.width + "px";
      canvas.style.height = rect.height + "px";
    }
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(root.querySelector(".tl-canvas-wrap"));
    resize();

    // start camera centered on the track's start marker
    state.camera.x = state.track.start.x;
    state.camera.y = state.track.start.y - 80;

    // ---------------------------------------------------------------
    // Theme colors (reads the app's own CSS custom properties so this
    // never needs a second theme system)
    // ---------------------------------------------------------------
    function themeColor(varName, fallback) {
      const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
      return v || fallback;
    }
    function paletteBg() { return themeColor("--bg-app", "#F6F7FB"); }
    function paletteGrid() {
      const dark = document.documentElement.getAttribute("data-theme") === "dark";
      return dark ? "rgba(255,255,255,0.045)" : "rgba(20,24,40,0.05)";
    }

    // ---------------------------------------------------------------
    // Undo helpers around the current in-progress stroke/erase gesture
    // ---------------------------------------------------------------
    function beginStroke() { state.currentStroke = { added: [], removed: [] }; }
    function commitStroke() {
      if (state.currentStroke) historyPush(state.history, state.currentStroke);
      state.currentStroke = null;
      rebuildGridFromTrack();
    }
    function rebuildGridFromTrack() { rebuildGrid(state.grid, state.track.lines); }

    function addLineTracked(x1, y1, x2, y2) {
      const line = addLine(state.track, state.lineType, x1, y1, x2, y2);
      if (line && state.currentStroke) state.currentStroke.added.push(line);
      return line;
    }
    function eraseNear(wx, wy) {
      const toRemove = state.track.lines.filter((l) => {
        const cp = segClosestPoint(wx, wy, l.x1, l.y1, l.x2, l.y2);
        return Math.hypot(cp.x - wx, cp.y - wy) <= ERASER_RADIUS / state.camera.zoom;
      });
      for (const l of toRemove) {
        removeLineById(state.track, l.id);
        if (state.currentStroke) state.currentStroke.removed.push(l);
      }
    }
    function lineNear(wx, wy, radius) {
      let best = null, bestDist = Infinity;
      for (const l of state.track.lines) {
        const cp = segClosestPoint(wx, wy, l.x1, l.y1, l.x2, l.y2);
        const d = Math.hypot(cp.x - wx, cp.y - wy);
        if (d < radius && d < bestDist) { bestDist = d; best = l; }
      }
      return best;
    }

    // ---------------------------------------------------------------
    // Pointer / editor input
    // ---------------------------------------------------------------
    let dragging = false;
    let lineToolStart = null;
    let lastPoint = null;
    let selectDragLine = null;
    let selectDragOffset = null;
    let startMarkerDrag = false;

    function isTypingElsewhere() {
      const ae = document.activeElement;
      if (!ae) return false;
      const tag = ae.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || ae.isContentEditable;
    }

    function effectiveTool() {
      if (state.spaceHeld) return "pan";
      return state.tool;
    }

    function pointerWorld(e) {
      const rect = canvas.getBoundingClientRect();
      return state.camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    }

    canvas.style.touchAction = "none";
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    canvas.addEventListener("pointerdown", (e) => {
      if (state.mode !== "edit") return;
      canvas.setPointerCapture(e.pointerId);
      const w = pointerWorld(e);
      const tool = e.button === 2 ? "pan" : effectiveTool();

      // start-marker drag: check first, small hit radius around the marker
      const distToStart = Math.hypot(w.x - state.track.start.x, w.y - state.track.start.y);
      if (tool === "select" && distToStart < 24 / state.camera.zoom) {
        startMarkerDrag = true;
        dragging = true;
        return;
      }

      if (tool === "pencil") {
        dragging = true;
        beginStroke();
        lastPoint = w;
        addPolylinePoint(w, true);
      } else if (tool === "line") {
        dragging = true;
        lineToolStart = w;
      } else if (tool === "eraser") {
        dragging = true;
        beginStroke();
        eraseNear(w.x, w.y);
      } else if (tool === "pan") {
        dragging = true;
        state.panLast = { x: e.clientX, y: e.clientY };
      } else if (tool === "select") {
        const hit = lineNear(w.x, w.y, SELECT_RADIUS / state.camera.zoom);
        state.selectedId = hit ? hit.id : null;
        if (hit) {
          selectDragLine = hit;
          selectDragOffset = w;
          dragging = true;
        }
      }
    });

    canvas.addEventListener("pointermove", (e) => {
      const w = pointerWorld(e);
      if (state.mode !== "edit") return;

      if (!dragging) {
        if (effectiveTool() === "select") {
          const hit = lineNear(w.x, w.y, SELECT_RADIUS / state.camera.zoom);
          state.hoverId = hit ? hit.id : null;
        }
        return;
      }

      if (startMarkerDrag) {
        state.track.start.x = w.x;
        state.track.start.y = w.y;
        return;
      }

      const tool = e.buttons === 2 ? "pan" : effectiveTool();
      if (tool === "pencil" && lastPoint) {
        addPolylinePoint(w, false);
      } else if (tool === "eraser") {
        eraseNear(w.x, w.y);
      } else if (tool === "pan" && state.panLast) {
        state.camera.pan(e.clientX - state.panLast.x, e.clientY - state.panLast.y);
        state.panLast = { x: e.clientX, y: e.clientY };
      } else if (tool === "select" && selectDragLine && selectDragOffset) {
        const dx = w.x - selectDragOffset.x, dy = w.y - selectDragOffset.y;
        selectDragLine.x1 += dx; selectDragLine.y1 += dy;
        selectDragLine.x2 += dx; selectDragLine.y2 += dy;
        selectDragOffset = w;
      } else if (tool === "line" && lineToolStart) {
        // preview handled in render loop via lineToolStart/current pointer
      }
      state.lastPointerWorld = w;
    });

    function addPolylinePoint(w, first) {
      if (first) { lastPoint = w; return; }
      const dx = w.x - lastPoint.x, dy = w.y - lastPoint.y;
      const distScreen = Math.hypot(dx, dy) * state.camera.zoom;
      if (distScreen < MIN_SAMPLE_DIST) return;
      addLineTracked(lastPoint.x, lastPoint.y, w.x, w.y);
      lastPoint = w;
    }

    function endPointerGesture(e) {
      if (state.mode !== "edit") { dragging = false; return; }
      const tool = effectiveTool();
      if (startMarkerDrag) {
        startMarkerDrag = false;
      } else if (tool === "line" && lineToolStart && state.lastPointerWorld) {
        beginStroke();
        addLineTracked(lineToolStart.x, lineToolStart.y, state.lastPointerWorld.x, state.lastPointerWorld.y);
        commitStroke();
        lineToolStart = null;
      } else if (tool === "pencil" || tool === "eraser") {
        commitStroke();
      } else if (tool === "select") {
        if (selectDragLine) rebuildGridFromTrack();
        selectDragLine = null;
        selectDragOffset = null;
      }
      dragging = false;
      state.panLast = null;
    }
    canvas.addEventListener("pointerup", endPointerGesture);
    canvas.addEventListener("pointercancel", endPointerGesture);
    canvas.addEventListener("pointerleave", (e) => {
      if (e.buttons === 0) endPointerGesture(e);
    });

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      state.camera.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
    }, { passive: false });

    // ---------------------------------------------------------------
    // Toolbar wiring
    // ---------------------------------------------------------------
    function setTool(tool) {
      state.tool = tool;
      root.querySelectorAll(".tl-tool-btn[data-tool]").forEach((b) => {
        b.classList.toggle("active", b.dataset.tool === tool);
      });
    }
    function setLineType(type) {
      state.lineType = type;
      root.querySelectorAll(".tl-color-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.lineType === type);
      });
    }
    setTool("pencil");
    setLineType(LINE_TYPES.PHYSICS);

    root.querySelector('[data-role="tools"]').addEventListener("click", (e) => {
      const btn = e.target.closest(".tl-tool-btn[data-tool]");
      if (btn) setTool(btn.dataset.tool);
    });
    root.querySelector('[data-role="colors"]').addEventListener("click", (e) => {
      const btn = e.target.closest(".tl-color-btn");
      if (btn) setLineType(btn.dataset.lineType);
    });
    root.querySelector(".tl-toolbar").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      if (btn.dataset.action === "undo") doUndo();
      else if (btn.dataset.action === "redo") doRedo();
      else if (btn.dataset.action === "zoom-in") state.camera.zoomAt(state.camera.viewW / 2, state.camera.viewH / 2, 1.25);
      else if (btn.dataset.action === "zoom-out") state.camera.zoomAt(state.camera.viewW / 2, state.camera.viewH / 2, 1 / 1.25);
    });

    function doUndo() {
      if (state.mode !== "edit") return;
      if (historyUndo(state.history, state.track)) { state.selectedId = null; rebuildGridFromTrack(); }
    }
    function doRedo() {
      if (state.mode !== "edit") return;
      if (historyRedo(state.history, state.track)) { state.selectedId = null; rebuildGridFromTrack(); }
    }

    // ---------------------------------------------------------------
    // Playback
    // ---------------------------------------------------------------
    function enterPlay() {
      if (!state.track.lines.length) { toastLocal("Zeichne zuerst eine Strecke."); return; }
      rebuildGridFromTrack();
      placeRiderAt(state.rider, state.track.start.x, state.track.start.y, state.track.start.angle);
      state.mode = "play";
      state.playElapsed = 0;
      crashMsg.hidden = true;
      modeBadge.textContent = "FAHREN";
      modeBadge.classList.add("play");
      followBtn.hidden = false;
      updatePlayIcon();
    }
    function pausePlay() {
      if (state.mode !== "play") return;
      state.mode = "paused";
      updatePlayIcon();
    }
    function resumePlay() {
      if (state.mode !== "paused") return;
      state.mode = "play";
      updatePlayIcon();
    }
    function stopToEdit() {
      state.mode = "edit";
      modeBadge.textContent = "BEARBEITEN";
      modeBadge.classList.remove("play");
      followBtn.hidden = true;
      crashMsg.hidden = true;
      updatePlayIcon();
    }
    function resetRider() {
      placeRiderAt(state.rider, state.track.start.x, state.track.start.y, state.track.start.angle);
      state.playElapsed = 0;
      crashMsg.hidden = true;
      if (state.mode === "paused") state.mode = "play";
      updatePlayIcon();
    }
    function updatePlayIcon() {
      const btn = root.querySelector('[data-action="playback-toggle"]');
      btn.innerHTML = state.mode === "play" ? ICONS.pause : ICONS.play;
    }

    root.querySelector(".tl-playback").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === "playback-reset") resetRider();
      else if (action === "playback-toggle") {
        if (state.mode === "edit") enterPlay();
        else if (state.mode === "play") pausePlay();
        else if (state.mode === "paused") resumePlay();
      } else if (action === "playback-stop") stopToEdit();
      else if (action === "again") resetRider();
    });
    root.querySelector(".tl-follow-btn").addEventListener("click", () => {
      state.followCamera = !state.followCamera;
      followBtn.classList.toggle("active", state.followCamera);
    });
    followBtn.classList.add("active");

    // ---------------------------------------------------------------
    // Side panel: new track / save / load / import / export / sound / help
    // ---------------------------------------------------------------
    function toastLocal(text) {
      if (window.toast) window.toast(text);
    }

    // Custom, non-blocking replacements for window.confirm()/prompt(): a
    // native dialog would freeze the WHOLE page's JS (including the chat
    // panel's WebSocket message handling) for as long as it's open, which
    // is worth avoiding on a page that hosts live chat right next to this.
    function confirmDialogAsync(message, confirmLabel) {
      return new Promise((resolve) => {
        const overlay = openOverlayDialog(`
          <h3>Bestätigen</h3>
          <p class="tl-confirm-message">${escapeHtmlLocal(message)}</p>
          <div class="tl-dialog-actions">
            <button type="button" class="ghost-btn" data-role="cancel">Abbrechen</button>
            <button type="button" class="primary-btn" data-role="confirm">${confirmLabel || "Bestätigen"}</button>
          </div>
        `);
        let settled = false;
        const finish = (val) => { if (settled) return; settled = true; overlay.remove(); resolve(val); };
        overlay.addEventListener("click", (e) => { if (e.target === overlay) finish(false); });
        overlay.querySelector('[data-role="confirm"]').addEventListener("click", () => finish(true));
        overlay.querySelector('[data-role="cancel"]').addEventListener("click", () => finish(false));
      });
    }

    function promptDialogAsync(title, initialValue) {
      return new Promise((resolve) => {
        const overlay = openOverlayDialog(`
          <h3>${escapeHtmlLocal(title)}</h3>
          <input type="text" class="tl-text-input" data-role="value-input" maxlength="60" />
          <div class="tl-dialog-actions">
            <button type="button" class="ghost-btn" data-role="cancel">Abbrechen</button>
            <button type="button" class="primary-btn" data-role="confirm">OK</button>
          </div>
        `);
        const input = overlay.querySelector('[data-role="value-input"]');
        input.value = initialValue || "";
        input.focus();
        input.select();
        let settled = false;
        const finish = (val) => { if (settled) return; settled = true; overlay.remove(); resolve(val); };
        overlay.addEventListener("click", (e) => { if (e.target === overlay) finish(null); });
        overlay.querySelector('[data-role="confirm"]').addEventListener("click", () => finish(input.value.trim() || null));
        overlay.querySelector('[data-role="cancel"]').addEventListener("click", () => finish(null));
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") finish(input.value.trim() || null);
          e.stopPropagation();
        });
      });
    }

    root.querySelector(".tl-side").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === "new-track") {
        const ok = await confirmDialogAsync("Aktuelle Strecke löschen und neue Strecke beginnen?", "Neue Strecke");
        if (ok) {
          state.track = createTrack();
          state.history = createHistory();
          state.selectedId = null;
          state.camera.x = 0; state.camera.y = -80;
          stopToEdit();
          rebuildGridFromTrack();
        }
      } else if (action === "save") openSaveDialog();
      else if (action === "my-tracks") openTrackListDialog();
      else if (action === "export") exportTrack();
      else if (action === "import") fileInput.click();
      else if (action === "sound") toggleSound(btn);
      else if (action === "help") openHelpDialog();
    });

    function toggleSound(btn) {
      state.soundEnabled = !state.soundEnabled;
      localStorage.setItem(SOUND_KEY, state.soundEnabled ? "1" : "0");
      btn.classList.toggle("active", state.soundEnabled);
    }
    root.querySelector('[data-action="sound"]').classList.toggle("active", state.soundEnabled);

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files[0];
      fileInput.value = "";
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!validateTrackJSON(data)) throw new Error("invalid");
        state.track = trackFromJSON(data);
        state.history = createHistory();
        state.selectedId = null;
        rebuildGridFromTrack();
        stopToEdit();
        toastLocal(`Strecke „${data.name || "Import"}“ importiert.`);
      } catch (err) {
        toastLocal("Diese Datei konnte nicht importiert werden.");
      }
    });

    function exportTrack() {
      const data = trackToJSON(state.track, "Meine Strecke");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = (data.name || "strecke").replace(/[^a-z0-9_\-]+/gi, "_") + ".json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    // ---- tiny in-canvas dialogs (scoped to this component, not a global modal) ----
    function openOverlayDialog(innerHTML) {
      const overlay = document.createElement("div");
      overlay.className = "tl-dialog-overlay";
      overlay.innerHTML = `<div class="tl-dialog">${innerHTML}</div>`;
      root.appendChild(overlay);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
      return overlay;
    }

    function openSaveDialog() {
      const overlay = openOverlayDialog(`
        <h3>Strecke speichern</h3>
        <label class="tl-field-label">Name der Strecke</label>
        <input type="text" class="tl-text-input" data-role="name-input" maxlength="60" placeholder="z. B. Meine erste Rampe" />
        <div class="tl-dialog-actions">
          <button type="button" class="ghost-btn" data-role="cancel">Abbrechen</button>
          <button type="button" class="primary-btn" data-role="confirm">💾 Speichern</button>
        </div>
      `);
      const input = overlay.querySelector('[data-role="name-input"]');
      input.focus();
      const submit = () => {
        const name = input.value.trim() || "Unbenannte Strecke";
        saveTrackLocal(name);
        overlay.remove();
        toastLocal(`„${name}“ gespeichert.`);
      };
      overlay.querySelector('[data-role="confirm"]').addEventListener("click", submit);
      overlay.querySelector('[data-role="cancel"]').addEventListener("click", () => overlay.remove());
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); e.stopPropagation(); });
    }

    function loadAllSavedTracks() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
      } catch (err) { return []; }
    }
    function persistAllSavedTracks(arr) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
    }
    function saveTrackLocal(name) {
      const all = loadAllSavedTracks();
      const data = trackToJSON(state.track, name);
      all.unshift({ id: "t" + Date.now(), name, updatedAt: Date.now(), data });
      persistAllSavedTracks(all.slice(0, 100));
    }

    function openTrackListDialog() {
      const all = loadAllSavedTracks();
      const rows = all.length
        ? all.map((t) => `
            <div class="tl-track-row" data-id="${t.id}">
              <div class="tl-track-row-info">
                <div class="tl-track-row-name" data-role="name">${escapeHtmlLocal(t.name)}</div>
                <div class="tl-track-row-date">${new Date(t.updatedAt).toLocaleString("de-DE")}</div>
              </div>
              <div class="tl-track-row-actions">
                <button type="button" class="ghost-btn" data-role="rename">Umbenennen</button>
                <button type="button" class="ghost-btn" data-role="delete">Löschen</button>
                <button type="button" class="primary-btn" data-role="open">Öffnen</button>
              </div>
            </div>`).join("")
        : `<p class="tl-empty-hint">Noch keine gespeicherten Strecken.</p>`;
      const overlay = openOverlayDialog(`
        <h3>Meine Strecken</h3>
        <div class="tl-track-list">${rows}</div>
        <div class="tl-dialog-actions">
          <button type="button" class="ghost-btn" data-role="cancel">Schließen</button>
        </div>
      `);
      overlay.querySelector('[data-role="cancel"]').addEventListener("click", () => overlay.remove());
      overlay.querySelectorAll(".tl-track-row").forEach((row) => {
        const id = row.dataset.id;
        row.querySelector('[data-role="open"]').addEventListener("click", () => {
          const all2 = loadAllSavedTracks();
          const found = all2.find((t) => t.id === id);
          if (found && validateTrackJSON(found.data)) {
            state.track = trackFromJSON(found.data);
            state.history = createHistory();
            state.selectedId = null;
            rebuildGridFromTrack();
            stopToEdit();
            overlay.remove();
          }
        });
        row.querySelector('[data-role="delete"]').addEventListener("click", async () => {
          const ok = await confirmDialogAsync("Diese gespeicherte Strecke wirklich löschen?", "Löschen");
          if (!ok) return;
          persistAllSavedTracks(loadAllSavedTracks().filter((t) => t.id !== id));
          row.remove();
        });
        row.querySelector('[data-role="rename"]').addEventListener("click", async () => {
          const nameEl = row.querySelector('[data-role="name"]');
          const current = nameEl.textContent;
          const name = await promptDialogAsync("Neuer Name", current);
          if (!name) return;
          const all2 = loadAllSavedTracks();
          const found = all2.find((t) => t.id === id);
          if (found) { found.name = name; persistAllSavedTracks(all2); nameEl.textContent = name; }
        });
      });
    }

    function escapeHtmlLocal(str) {
      const d = document.createElement("div");
      d.textContent = str;
      return d.innerHTML;
    }

    function openHelpDialog() {
      openOverlayDialog(`
        <h3>So funktioniert TimLiner</h3>
        <ol class="tl-help-list">
          <li>Strecke zeichnen</li>
          <li>Blaue Linien tragen den Schlitten</li>
          <li>Rote Linien beschleunigen</li>
          <li>Grüne Linien sind Dekoration</li>
          <li>Play drücken</li>
          <li>Strecke testen und verbessern</li>
        </ol>
        <h3>Tastenkürzel</h3>
        <ul class="tl-help-shortcuts">
          <li><kbd>Q</kbd> Freihand</li>
          <li><kbd>W</kbd> Linie</li>
          <li><kbd>E</kbd> Radierer</li>
          <li><kbd>V</kbd> Auswahl</li>
          <li><kbd>H</kbd> / Leertaste Verschieben</li>
          <li><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> Linienfarbe</li>
          <li><kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd> Rückgängig / Wiederholen</li>
          <li><kbd>Enter</kbd> Play/Pause</li>
          <li><kbd>Esc</kbd> Zurück zum Bearbeiten</li>
          <li><kbd>Entf</kbd> Ausgewählte Linie löschen</li>
        </ul>
        <div class="tl-dialog-actions">
          <button type="button" class="primary-btn" data-role="cancel">Verstanden</button>
        </div>
      `).querySelector('[data-role="cancel"]').addEventListener("click", (e) => e.target.closest(".tl-dialog-overlay").remove());
    }

    // ---------------------------------------------------------------
    // Onboarding (first-ever open only)
    // ---------------------------------------------------------------
    if (!localStorage.getItem(ONBOARDING_KEY)) {
      onboardingBox.hidden = false;
      onboardingBox.innerHTML = `
        <div class="tl-onboard-card">
          <p>1. Zeichne hier deine Strecke.</p>
          <p>2. Blaue Linien tragen deinen Fahrer.</p>
          <p>3. Drücke Play und schau, was passiert.</p>
          <button type="button" class="primary-btn" data-role="dismiss">Los geht's</button>
        </div>
      `;
      onboardingBox.querySelector('[data-role="dismiss"]').addEventListener("click", () => {
        onboardingBox.hidden = true;
        localStorage.setItem(ONBOARDING_KEY, "1");
      });
    }

    // ---------------------------------------------------------------
    // Keyboard shortcuts (scoped: only active while this instance is
    // mounted, and always ignored while the user is typing anywhere else
    // on the page - e.g. the chat input right next to this game).
    // ---------------------------------------------------------------
    function onKeyDown(e) {
      if (isTypingElsewhere()) return;
      if (e.code === "Space") { state.spaceHeld = true; e.preventDefault(); return; }
      if (state.mode === "edit") {
        if (e.key === "q" || e.key === "Q") setTool("pencil");
        else if (e.key === "w" || e.key === "W") setTool("line");
        else if (e.key === "e" || e.key === "E") setTool("eraser");
        else if (e.key === "v" || e.key === "V") setTool("select");
        else if (e.key === "h" || e.key === "H") setTool("pan");
        else if (e.key === "1") setLineType(LINE_TYPES.PHYSICS);
        else if (e.key === "2") setLineType(LINE_TYPES.BOOST);
        else if (e.key === "3") setLineType(LINE_TYPES.SCENERY);
        else if (e.ctrlKey && !e.shiftKey && (e.key === "z" || e.key === "Z")) { doUndo(); e.preventDefault(); }
        else if ((e.ctrlKey && e.shiftKey && (e.key === "z" || e.key === "Z")) || (e.ctrlKey && (e.key === "y" || e.key === "Y"))) { doRedo(); e.preventDefault(); }
        else if ((e.key === "Delete" || e.key === "Backspace") && state.selectedId != null) {
          const line = removeLineById(state.track, state.selectedId);
          if (line) { historyPush(state.history, { added: [], removed: [line] }); rebuildGridFromTrack(); }
          state.selectedId = null;
          e.preventDefault();
        }
      }
      if (e.key === "Enter" || e.key === "p" || e.key === "P") {
        if (state.mode === "edit") enterPlay();
        else if (state.mode === "play") pausePlay();
        else if (state.mode === "paused") resumePlay();
      } else if (e.key === "Escape") {
        stopToEdit();
      }
    }
    function onKeyUp(e) {
      if (e.code === "Space") state.spaceHeld = false;
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // ---------------------------------------------------------------
    // Touch: 1 finger draws (when pencil active) via pointer events above
    // (Pointer Events unify mouse/touch/pen already); 2-finger pan/pinch
    // needs its own handling since that's not a single "pointer" gesture.
    // ---------------------------------------------------------------
    let pinchLastDist = null;
    let pinchLastMid = null;
    canvas.addEventListener("touchmove", (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const [a, b] = e.touches;
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const mid = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
        const rect = canvas.getBoundingClientRect();
        if (pinchLastDist != null) {
          state.camera.zoomAt(mid.x - rect.left, mid.y - rect.top, dist / pinchLastDist);
          state.camera.pan(mid.x - pinchLastMid.x, mid.y - pinchLastMid.y);
        }
        pinchLastDist = dist;
        pinchLastMid = mid;
        dragging = false; // a 2-finger gesture should not also be drawing
      }
    }, { passive: false });
    canvas.addEventListener("touchend", (e) => {
      if (e.touches.length < 2) { pinchLastDist = null; pinchLastMid = null; }
    });

    // ---------------------------------------------------------------
    // Sound (procedural, no external audio files)
    // ---------------------------------------------------------------
    let audioCtx = null;
    function beep(freq, dur, type, gain) {
      if (!state.soundEnabled) return;
      try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        osc.type = type || "sine";
        osc.frequency.value = freq;
        g.gain.value = gain || 0.05;
        g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
        osc.connect(g); g.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + dur);
      } catch (err) { /* ignore - sound is best-effort only */ }
    }

    // ---------------------------------------------------------------
    // Main loop - fixed timestep physics, rAF-driven rendering
    // ---------------------------------------------------------------
    let wasCrashed = false;
    function frame(now) {
      state.raf = requestAnimationFrame(frame);
      if (state.lastFrameTime == null) state.lastFrameTime = now;
      const frameDt = Math.min((now - state.lastFrameTime) / 1000, 0.25);
      state.lastFrameTime = now;

      if (state.mode === "play") {
        state.accumulator += frameDt;
        while (state.accumulator >= FIXED_DT) {
          physicsStep(state.rider, state.grid, FIXED_DT);
          state.accumulator -= FIXED_DT;
          state.playElapsed += FIXED_DT;
        }
        if (state.rider.crashed && !wasCrashed) { beep(120, 0.35, "sawtooth", 0.07); crashMsg.hidden = false; }
        else if (!state.rider.crashed) crashMsg.hidden = true;
        wasCrashed = state.rider.crashed;

        if (state.followCamera) {
          const p = state.rider.points.hip;
          const vx = p.x - p.px;
          const lead = Math.max(-120, Math.min(120, vx * 6));
          const targetX = p.x + lead, targetY = p.y - 40;
          state.camera.x += (targetX - state.camera.x) * 0.08;
          state.camera.y += (targetY - state.camera.y) * 0.08;
        }
        const secs = Math.floor(state.playElapsed);
        timeLabel.textContent = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
      }

      render();
    }

    function render() {
      const dpr = state.dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = paletteBg();
      ctx.fillRect(0, 0, state.camera.viewW, state.camera.viewH);
      drawGrid(ctx, state.camera, paletteGrid());

      if (state.mode === "edit" && lineToolStart && dragging && state.lastPointerWorld) {
        const a = state.camera.worldToScreen(lineToolStart.x, lineToolStart.y);
        const b = state.camera.worldToScreen(state.lastPointerWorld.x, state.lastPointerWorld.y);
        ctx.save();
        ctx.strokeStyle = LINE_COLORS[state.lineType];
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 4.5;
        ctx.setLineDash([8, 6]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.restore();
      }

      drawLines(ctx, state.camera, state.track.lines, state.selectedId, state.hoverId);
      if (state.mode === "edit") drawStartMarker(ctx, state.camera, state.track.start);
      drawRider(ctx, state.camera, state.rider);
    }

    resetRider();
    state.raf = requestAnimationFrame(frame);

    // ---------------------------------------------------------------
    // Instance handle returned to app.js
    // ---------------------------------------------------------------
    return {
      destroy() {
        if (state.raf) cancelAnimationFrame(state.raf);
        resizeObserver.disconnect();
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
        root.remove();
      },
      // Read-only introspection for debugging/automated testing - not used
      // by the UI itself, safe to leave in.
      _debugState() {
        return {
          mode: state.mode,
          tool: state.tool,
          lineType: state.lineType,
          lineCount: state.track.lines.length,
          lines: state.track.lines.map((l) => ({ id: l.id, type: l.type, x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2 })),
          start: { x: state.track.start.x, y: state.track.start.y },
          camera: { x: state.camera.x, y: state.camera.y, zoom: state.camera.zoom, viewW: state.camera.viewW, viewH: state.camera.viewH },
          selectedId: state.selectedId,
          rider: {
            crashed: state.rider.crashed,
            sledBack: { x: state.rider.points.sledBack.x, y: state.rider.points.sledBack.y },
            sledFront: { x: state.rider.points.sledFront.x, y: state.rider.points.sledFront.y },
            hip: { x: state.rider.points.hip.x, y: state.rider.points.hip.y },
          },
          speed: state.rider.speed,
        };
      },
      _debugImportTrackJSON(json) { // test hook: bypasses the file-picker dialog
        state.track = trackFromJSON(json);
        state.history = createHistory();
        rebuildGridFromTrack();
      },
      _debugExportTrackJSON() {
        return trackToJSON(state.track, "debug");
      },
    };
  }

  // ---------------------------------------------------------------------
  // Icons - small inline SVGs (own artwork, not emoji, not third-party)
  // ---------------------------------------------------------------------
  const ICONS = {
    pencil: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4.5l5 5L8 21H3v-5z"/></svg>',
    line: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="5" cy="19" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="5" r="1.6" fill="currentColor" stroke="none"/><path d="M5 19L19 5"/></svg>',
    eraser: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13l-7 7H6l-3-3a1 1 0 010-1.4L13 5l7 7z"/><path d="M9 20h11"/></svg>',
    select: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l6 17 2-7 7-2z"/></svg>',
    pan: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12V6a1.5 1.5 0 013 0v5M11 11V4a1.5 1.5 0 013 0v7M14 11.5V6a1.5 1.5 0 013 0v8M17 13v-2a1.5 1.5 0 013 0v4a7 7 0 01-7 7h-1a7 7 0 01-6-3.4L4 14a1.5 1.5 0 012.6-1.5L8 14"/></svg>',
    undo: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 016 6v0a6 6 0 01-6 6H8"/></svg>',
    redo: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 00-6 6v0a6 6 0 006 6h6"/></svg>',
    minus: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    file: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>',
    folder: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>',
    save: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>',
    download: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>',
    upload: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3m0 0l-4 4m4-4l4 4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>',
    sound: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 5V4L8 9z"/><path d="M16.5 8.5a5 5 0 010 7"/></svg>',
    help: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.5 2.5 0 014.8.9c0 1.7-2.3 2-2.3 3.4"/><circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none"/></svg>',
    rewind: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M11 12l9-6v12zM2 12l9-6v12z"/></svg>',
    play: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7 5l13 7-13 7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
    stop: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>',
    camera: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8a2 2 0 012-2h1l1.2-1.6a1 1 0 01.8-.4h6a1 1 0 01.8.4L17 6h1a2 2 0 012 2v9a2 2 0 01-2 2H6a2 2 0 01-2-2z"/><circle cx="12" cy="13" r="3.2"/></svg>',
  };

  window.TimLiner = { mount, LINE_TYPES };
})();
