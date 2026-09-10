"""Shared math/collision helpers for the continuous-physics multiplayer
games (Tank Battle, Dodge Arena). Both engines model their arenas as a
list of axis-aligned rectangles (including the outer border, so bounds
checking is just "one more wall" - no special-casing) and move circular
bodies (tanks, projectiles, players, hazard balls) through them.

Kept separate from both game files since the exact same "circle vs a pile
of AABB walls, give me the push-out normal" question is asked by: tank
movement, tank-vs-tank separation, projectile bounces, dodge-player
movement, and hazard-ball bounces - five different callers, one answer.
"""

import math


def clamp(value, lo, hi):
    return max(lo, min(hi, value))


def make_border_walls(width, height, thickness=24):
    """The outer arena bounds, expressed as four wall rects so movement/
    bounce code never needs a separate "hit the edge of the world" check."""
    return [
        (-thickness, -thickness, width + thickness, 0),  # top
        (-thickness, height, width + thickness, height + thickness),  # bottom
        (-thickness, -thickness, 0, height + thickness),  # left
        (width, -thickness, width + thickness, height + thickness),  # right
    ]


def circle_vs_rect_mtv(cx, cy, radius, rect):
    """Minimum-translation-vector test: is a circle at (cx,cy) with the
    given radius overlapping `rect` (x1,y1,x2,y2)? Returns None if not,
    otherwise {"normal": (nx,ny), "penetration": depth} where pushing the
    circle by normal*penetration exactly clears the overlap. `normal`
    points FROM the rect TOWARD the circle (the direction to push out
    along / the direction to reflect a bounce across)."""
    x1, y1, x2, y2 = rect
    closest_x = clamp(cx, x1, x2)
    closest_y = clamp(cy, y1, y2)
    dx = cx - closest_x
    dy = cy - closest_y
    dist_sq = dx * dx + dy * dy
    if dist_sq >= radius * radius:
        return None
    dist = math.sqrt(dist_sq)
    if dist > 1e-6:
        return {"normal": (dx / dist, dy / dist), "penetration": radius - dist}
    # Degenerate case: circle center is exactly on/inside the rect
    # boundary (dist==0) - push out along whichever side is closest.
    left, right = cx - x1, x2 - cx
    top, bottom = cy - y1, y2 - cy
    m = min(left, right, top, bottom)
    if m == left:
        return {"normal": (-1.0, 0.0), "penetration": radius + left}
    if m == right:
        return {"normal": (1.0, 0.0), "penetration": radius + right}
    if m == top:
        return {"normal": (0.0, -1.0), "penetration": radius + top}
    return {"normal": (0.0, 1.0), "penetration": radius + bottom}


def resolve_circle_vs_walls(x, y, radius, walls):
    """Simple (non-swept) push-out resolution for slower-moving bodies
    like tanks/players: checked once per tick against every wall, moved
    clear of whichever it's overlapping. Not used for projectiles/hazards,
    which need the stronger substep treatment below to avoid tunneling."""
    for rect in walls:
        hit = circle_vs_rect_mtv(x, y, radius, rect)
        if hit:
            nx, ny = hit["normal"]
            x += nx * hit["penetration"]
            y += ny * hit["penetration"]
    return x, y


def circles_overlap(x1, y1, r1, x2, y2, r2):
    dx, dy = x1 - x2, y1 - y2
    rsum = r1 + r2
    return dx * dx + dy * dy <= rsum * rsum


def step_bouncing_circle(body, dt, radius, walls, substeps, max_bounces):
    """Moves a circular projectile/hazard by its own vx/vy over `dt`,
    split into `substeps` small increments so a wall thinner than one
    tick's full travel distance still can't be tunneled through - each
    substep re-checks for wall overlap and reflects velocity across the
    contact normal (angle of incidence = angle of reflection) rather than
    just flipping an axis, so corner/glancing hits behave correctly too.

    Mutates `body` in place (expects "x","y","vx","vy","bounces" keys).
    Returns True if the body should be destroyed (exceeded max_bounces -
    for hazards that never get destroyed by bouncing, pass max_bounces=None
    and this always returns False)."""
    sub_dt = dt / substeps
    for _ in range(substeps):
        body["x"] += body["vx"] * sub_dt
        body["y"] += body["vy"] * sub_dt
        for rect in walls:
            hit = circle_vs_rect_mtv(body["x"], body["y"], radius, rect)
            if not hit:
                continue
            nx, ny = hit["normal"]
            dot = body["vx"] * nx + body["vy"] * ny
            if dot < 0:  # only reflect if actually moving into the wall
                body["vx"] -= 2 * dot * nx
                body["vy"] -= 2 * dot * ny
                body["bounces"] = body.get("bounces", 0) + 1
                if max_bounces is not None and body["bounces"] > max_bounces:
                    return True
            body["x"] += nx * hit["penetration"]
            body["y"] += ny * hit["penetration"]
    return False


def angle_diff_lerp_input(forward, turn):
    """Sanitizes a client-sent move input pair to a safe numeric range -
    used by both games so a malformed/out-of-range payload can never
    inject NaN/huge values into the physics step."""
    def safe(v):
        try:
            v = float(v)
        except (TypeError, ValueError):
            return 0.0
        if not math.isfinite(v):
            return 0.0
        return clamp(v, -1.0, 1.0)
    return safe(forward), safe(turn)
