"""MultiScreen Snake - one shared snake crawling across every phone on
the table. Co-op score attack: the whole table plays together.

The snake lives purely in world coordinates: a polyline (head first) on
a world-anchored grid, moving at constant speed, turning only on grid
lines (so parallel body lanes never overlap and a U-turn is always one
full lane wide). It knows nothing about devices except one rule: the
screen the head is on controls it. Walls, passages and partial edges all
come from the TableWorld - a head that touches a wall (a table edge with
no neighbouring phone, or the non-shared part of a partially shared
edge) crashes; a head crossing a real passage just keeps going.

Control handoff: when the head will leave its screen through a passage
within PREPARE seconds, the next screen gets "BEREIT MACHEN" and may
already buffer ONE turn; the moment the head's centre is clearly inside
the new screen, control (and the buffered turn, if still legal) moves
there and the old screen can no longer steer.
"""

import math

from .game_api import MultiscreenGame
from .geometry import DIR_VECTORS, OPPOSITE_DIR, local_dir_to_world, point_inside

SNAKE_CONFIG = {
    "radius": 3.5,            # world units (~mm): the snake is ~7mm thick on every phone
    "cell": 9.0,              # grid lane distance (> diameter: parallel lanes never touch)
    "start_cells": 4,
    "grow_cells": 1,
    "base_speed": 5.0,        # cells / s
    "speed_step": 1.08,
    "speed_every": 3,         # foods per speed-up
    "max_speed": 8.5,         # cells / s - hard cap, stays playable
    "lives": 3,
    "food_radius": 3.4,
    "prepare_time": 1.0,      # s before the head reaches the next screen
    "handoff_margin": 0.8,    # head must be this far inside the new screen
    "intro": 1.8,             # s light sweep across all screens
    "countdown": 3.0,
    "crash_pause": 1.2,
    "respawn_freeze": 1.3,
    "neck_cells": 1.6,        # body this close to the head (along the body) can't be hit
    "self_hit": 0.85,         # * diameter
    "wall_hit": 0.9,          # * radius
    "max_queue": 2,
    "max_events": 12,
}
C = SNAKE_CONFIG
DIRS = tuple(DIR_VECTORS)


def _seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 <= 1e-12:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


class SnakeGame(MultiscreenGame):
    key = "snake"
    name = "MultiScreen Snake"
    emoji = "🐍"
    subtitle = "Eine Schlange. Viele Displays."
    min_devices = 2
    max_devices = 12
    min_passage = 3 * SNAKE_CONFIG["radius"]   # a passage must fit the head with margin
    tick_hz = 30
    snapshot_every = 2                          # 15 snapshots/s (+ immediately on events)

    def __init__(self, world, devices, rng=None):
        super().__init__(world, devices, rng)
        self.cell = C["cell"]
        self.r = C["radius"]
        self.phase = "intro"
        self.phase_time = 0.0
        self.phase_duration = C["intro"]
        self.score = 0
        self.lives = C["lives"]
        self.foods = 0
        self.speed = C["base_speed"]
        self.speed_level = 0
        self.path = []
        self.dir = "right"
        self.length = C["start_cells"] * self.cell
        self.queue = []                 # [(world_dir, device_id)]
        self.active = None
        self.handoff_target = None
        self.handoff_in = None
        self.handoff_buffer = None      # (world_dir, device_id)
        self.food = None
        self.food_seq = 0
        self.food_count = {t.device_id: 0 for t in world.tiles}
        self.crash = None
        self.events = []
        self.event_seq = 0
        self.stats = {
            "crossings": 0, "chainCurrent": 0, "chainBest": 0, "maxLengthCells": C["start_cells"],
            "control": {d: 0.0 for d in world.by_id}, "reaction": {}, "closestSave": None, "playTime": 0.0,
        }
        self._control_since = {}        # device -> game time control arrived (reaction stat)
        self._last_turn = None
        self._reacted = set()

    # ------------------------------------------------------------------ setup

    def start(self):
        self._respawn()
        self._spawn_food()
        self._set_phase("intro", C["intro"])
        self._event("intro")

    def _set_phase(self, phase, duration=None):
        self.phase = phase
        self.phase_time = 0.0
        self.phase_duration = duration
        self.dirty = True

    def _event(self, kind, **data):
        self.event_seq += 1
        self.events.append(dict(seq=self.event_seq, type=kind, t=round(self.time, 3), **data))
        del self.events[:-C["max_events"]]
        self.dirty = True

    def _free_run(self, x, y, direction, limit):
        """How far a head could travel straight from (x, y) before it hits a
        wall (sampled every half radius)."""
        dx, dy = DIR_VECTORS[direction]
        step = self.r / 2
        d = 0.0
        while d < limit:
            nx, ny = x + dx * (d + step), y + dy * (d + step)
            if self.world.get_boundary_collision(nx, ny, self.r * C["wall_hit"]):
                return d
            d += step
        return limit

    def _grid_points(self, tile, clearance):
        c = self.cell
        i0, i1 = math.ceil(tile.x / c), math.floor(tile.right / c)
        j0, j1 = math.ceil(tile.y / c), math.floor(tile.bottom / c)
        for i in range(i0, i1 + 1):
            for j in range(j0, j1 + 1):
                x, y = i * c, j * c
                if point_inside(tile, x, y) and self.world.wall_distance(x, y) >= clearance:
                    yield (x, y)

    def _respawn(self):
        """Start in the screen nearest the middle of the layout, where the
        head has the longest free run ahead and room for the body behind."""
        w = self.world
        bx1, by1, bx2, by2 = w.bounds
        mid = ((bx1 + bx2) / 2, (by1 + by2) / 2)
        tiles = sorted(w.tiles, key=lambda t: math.hypot(t.center[0] - mid[0], t.center[1] - mid[1]))
        body = C["start_cells"] * self.cell
        best = None
        for rank, t in enumerate(tiles[:3]):
            for (x, y) in self._grid_points(t, self.r * 2):
                for d in DIRS:
                    back = OPPOSITE_DIR[d]
                    if self._free_run(x, y, back, body + self.r) < body:
                        continue
                    ahead = self._free_run(x, y, d, 12 * self.cell)
                    if ahead < 3 * self.cell:
                        continue
                    centre = math.hypot(x - t.center[0], y - t.center[1])
                    score = min(ahead, 10 * self.cell) - centre * 0.3 - rank * 40
                    if best is None or score > best[0]:
                        best = (score, x, y, d, t.device_id)
        if best is None:  # tiny/odd layout: middle of the central screen, pointing along its long side
            t = tiles[0]
            x = round(t.center[0] / self.cell) * self.cell
            y = round(t.center[1] / self.cell) * self.cell
            d = "down" if t.h >= t.w else "right"
            best = (0, x, y, d, t.device_id)
        _, x, y, d, dev = best
        bdx, bdy = DIR_VECTORS[OPPOSITE_DIR[d]]
        self.length = C["start_cells"] * self.cell
        self.path = [[x, y], [x + bdx * self.length, y + bdy * self.length]]
        self.dir = d
        self.queue = []
        self.handoff_buffer = None
        self._last_turn = None
        self.speed = C["base_speed"] * (C["speed_step"] ** self.speed_level)
        self._set_active(dev, count=False)

    def _spawn_food(self):
        """Somewhere valid on the table - never in a gap, a wall, the body
        or right at the head; tiles that got few foods so far (and not the
        head's own screen) are preferred, so the snake has to travel."""
        clearance = self.r + C["food_radius"] + 2.5
        head = self.path[0]
        tiles = list(self.world.tiles)
        weights = []
        for t in tiles:
            wgt = 1.0 / (1 + self.food_count.get(t.device_id, 0))
            if len(tiles) > 1 and t.device_id == self.active:
                wgt *= 0.35
            weights.append(wgt)
        order = []
        pool = list(zip(tiles, weights))
        while pool:
            total = sum(w for _, w in pool)
            pick = self.rng.random() * total
            for i, (t, w) in enumerate(pool):
                pick -= w
                if pick <= 0 or i == len(pool) - 1:
                    order.append(t)
                    pool.pop(i)
                    break
        for relax in (1.0, 0.5, 0.0):
            for t in order:
                cands = [p for p in self._grid_points(t, clearance)
                         if math.hypot(p[0] - head[0], p[1] - head[1]) >= 3 * self.cell * relax
                         and self._body_distance(*p) >= 2 * self.cell * relax]
                if cands:
                    x, y = self.rng.choice(cands)
                    self.food_seq += 1
                    self.food = {"x": x, "y": y, "id": self.food_seq, "deviceId": t.device_id}
                    self.food_count[t.device_id] = self.food_count.get(t.device_id, 0) + 1
                    self.dirty = True
                    return
        self.food = None

    # ------------------------------------------------------------------ control

    def controlling_device(self):
        return self.active if self.phase in ("playing", "respawn", "countdown") else None

    def _set_active(self, device_id, count=True):
        if device_id == self.active:
            return
        prev = self.active
        self.active = device_id
        self.handoff_target = None
        self.handoff_in = None
        self._control_since[device_id] = self.time
        self._reacted.discard(device_id)
        if count and prev is not None:
            self.stats["crossings"] += 1
            self.stats["chainCurrent"] += 1
            self.stats["chainBest"] = max(self.stats["chainBest"], self.stats["chainCurrent"])
            self._event("handoff", **{"from": prev, "to": device_id})
            buf = self.handoff_buffer
            if buf and buf[1] == device_id:
                self._enqueue(buf[0], device_id)
        self.handoff_buffer = None
        self.dirty = True

    def _legal_after(self, base, d):
        return d != base and d != OPPOSITE_DIR[base]

    def _enqueue(self, world_dir, device_id):
        base = self.queue[-1][0] if self.queue else self.dir
        if not self._legal_after(base, world_dir) or len(self.queue) >= C["max_queue"]:
            return False
        self.queue.append((world_dir, device_id))
        return True

    def handle_input(self, device_id, payload):
        """payload: {"dir": up|down|left|right} as swiped on THAT screen.
        The screen's rotation turns it into a world direction here, on the
        server - never trusted from the client."""
        d = payload.get("dir") if isinstance(payload, dict) else None
        if d not in DIR_VECTORS or device_id not in self.world.by_id:
            return False
        if self.phase not in ("playing", "respawn", "countdown"):
            return False
        world_dir = local_dir_to_world(self.world.by_id[device_id].rotation, d)
        if device_id == self.active:
            ok = self._enqueue(world_dir, device_id)
            if ok and device_id not in self._reacted and self.time > self._control_since.get(device_id, 0):
                self._reacted.add(device_id)
                if self.stats["crossings"] > 0:
                    rt = self.time - self._control_since[device_id]
                    best = self.stats["reaction"].get(device_id)
                    if best is None or rt < best:
                        self.stats["reaction"][device_id] = round(rt, 3)
            return ok
        if device_id == self.handoff_target:
            # the next screen may prepare ONE turn; latest intention wins,
            # checked for legality again when control actually arrives
            if self._legal_after(self.dir, world_dir):
                self.handoff_buffer = (world_dir, device_id)
                self.dirty = True
                return True
        return False

    # ------------------------------------------------------------------ simulation

    def update(self, dt):
        if self.over:
            return
        self.time += dt
        self.phase_time += dt
        if self.phase == "intro":
            if self.phase_time >= C["intro"]:
                self._set_phase("countdown", C["countdown"])
                self._event("countdown")
            return
        if self.phase == "countdown":
            if self.phase_time >= C["countdown"]:
                self._set_phase("playing")
                self._event("go")
            return
        if self.phase == "crashed":
            if self.phase_time >= C["crash_pause"]:
                if self.lives <= 0:
                    self.over = True
                    self._set_phase("over")
                    self._event("game_over", score=self.score)
                else:
                    self.crash = None
                    self._respawn()
                    if self.food is None or self._body_distance(self.food["x"], self.food["y"]) < self.cell:
                        self._spawn_food()
                    self._set_phase("respawn", C["respawn_freeze"])
                    self._event("respawn")
            return
        if self.phase == "respawn":
            if self.phase_time >= C["respawn_freeze"]:
                self._set_phase("playing")
                self._event("go")
            return
        if self.phase != "playing":
            return

        self.stats["playTime"] += dt
        if self.active in self.stats["control"]:
            self.stats["control"][self.active] += dt
        self._advance(self.speed * self.cell * dt)
        if self.phase == "playing":
            self._update_prepare()

    def _advance(self, distance):
        c = self.cell
        max_sub = self.r / 2
        remaining = distance
        guard = 0
        while remaining > 1e-9 and self.phase == "playing" and guard < 200:
            guard += 1
            hx, hy = self.path[0]
            dx, dy = DIR_VECTORS[self.dir]
            pos = hx if dx else hy
            sgn = dx or dy
            g = pos / c
            on_line = abs(g - round(g)) < 1e-6
            # a second queued turn must wait for the NEXT grid point - two
            # turns on the same point would be a 180 in zero distance
            if self.queue and on_line and (hx, hy) != self._last_turn:
                nd, dev = self.queue.pop(0)
                if self._legal_after(self.dir, nd):
                    self._record_save(dev)
                    self.path.insert(1, [hx, hy])   # corner stays behind, head turns
                    self.dir = nd
                    self._last_turn = (hx, hy)
                    self.dirty = True
                continue
            step = min(remaining, max_sub)
            snap_to = None
            if self.queue:
                nxt = (math.floor(g + 1e-6) + 1) * c if sgn > 0 else (math.ceil(g - 1e-6) - 1) * c
                if on_line and (hx, hy) != self._last_turn:
                    nxt = pos
                to_line = abs(nxt - pos)
                if to_line <= step:
                    step, snap_to = to_line, nxt
            nx, ny = hx + dx * step, hy + dy * step
            if snap_to is not None:
                if dx:
                    nx = snap_to
                else:
                    ny = snap_to
            self.path[0] = [nx, ny]
            remaining -= step
            self._trim()
            if self._check_collisions():
                return
            self._update_active()

    def _trim(self):
        """Cut the body to its length (in world units, not segments)."""
        acc = 0.0
        for i in range(len(self.path) - 1):
            ax, ay = self.path[i]
            bx, by = self.path[i + 1]
            seg = math.hypot(bx - ax, by - ay)
            if acc + seg >= self.length:
                k = (self.length - acc) / seg if seg > 0 else 0
                self.path[i + 1] = [ax + (bx - ax) * k, ay + (by - ay) * k]
                del self.path[i + 2:]
                return
            acc += seg

    def _body_distance(self, px, py, skip=0.0):
        """Distance from a point to the body, ignoring the first `skip`
        units behind the head (the neck)."""
        best = math.inf
        acc = 0.0
        for i in range(len(self.path) - 1):
            ax, ay = self.path[i]
            bx, by = self.path[i + 1]
            seg = math.hypot(bx - ax, by - ay)
            if acc + seg <= skip:
                acc += seg
                continue
            if acc < skip and seg > 0:
                k = (skip - acc) / seg
                ax, ay = ax + (bx - ax) * k, ay + (by - ay) * k
            best = min(best, _seg_dist(px, py, ax, ay, bx, by))
            acc += seg
        return best

    def _check_collisions(self):
        hx, hy = self.path[0]
        hit = self.world.get_boundary_collision(hx, hy, self.r * C["wall_hit"])
        reason = "wall" if hit else None
        if reason is None and self._body_distance(hx, hy, C["neck_cells"] * self.cell) < 2 * self.r * C["self_hit"]:
            reason = "self"
        if reason:
            self.lives -= 1
            self.crash = {"x": round(hx, 2), "y": round(hy, 2), "reason": reason, "deviceId": self.active}
            self.stats["chainCurrent"] = 0
            self.queue = []
            self.handoff_target = None
            self.handoff_buffer = None
            self._set_phase("crashed", C["crash_pause"])
            self._event("crash", reason=reason, x=round(hx, 2), y=round(hy, 2), lives=self.lives)
            return True
        f = self.food
        if f and math.hypot(hx - f["x"], hy - f["y"]) < self.r + C["food_radius"]:
            self.score += 1
            self.foods += 1
            self.length += C["grow_cells"] * self.cell
            self.stats["maxLengthCells"] = max(self.stats["maxLengthCells"], round(self.length / self.cell))
            self._event("food", x=f["x"], y=f["y"], score=self.score, deviceId=self.active)
            if self.foods % C["speed_every"] == 0 and self.speed < C["max_speed"]:
                self.speed_level += 1
                self.speed = min(C["max_speed"], C["base_speed"] * (C["speed_step"] ** self.speed_level))
                self._event("speed_up", level=self.speed_level)
            self._spawn_food()
        return False

    def _update_active(self):
        hx, hy = self.path[0]
        cur = self.world.by_id.get(self.active)
        if cur is not None and point_inside(cur, hx, hy, eps=-C["handoff_margin"]):
            return
        if cur is not None and point_inside(cur, hx, hy):
            # still on (the edge of) the current screen: only switch once the
            # head is clearly inside another one
            for t in self.world.tiles:
                if t.device_id != self.active and point_inside(t, hx, hy, eps=-C["handoff_margin"]):
                    self._set_active(t.device_id)
                    return
            return
        t = self.world.get_tile_for_point(hx, hy)
        if t is not None:
            self._set_active(t.device_id)

    def _update_prepare(self):
        hx, hy = self.path[0]
        ex = self.world.exit_along(self.active, hx, hy, self.dir)
        target, secs = None, None
        if ex["target"] is not None:
            secs = ex["distance"] / (self.speed * self.cell)
            if secs <= C["prepare_time"]:
                target = ex["target"]
        if target != self.handoff_target:
            self.handoff_target = target
            if self.handoff_buffer and self.handoff_buffer[1] != target:
                self.handoff_buffer = None
            if target is not None:
                self._event("prepare", deviceId=target)
            self.dirty = True
        self.handoff_in = round(secs, 2) if target is not None else None

    def _record_save(self, device_id):
        """Closest save: how close the head was to crashing straight on
        when this turn got it out."""
        hx, hy = self.path[0]
        dx, dy = DIR_VECTORS[self.dir]
        clear = None
        d = 0.0
        while d <= 2 * self.cell:
            px, py = hx + dx * d, hy + dy * d
            if self.world.get_boundary_collision(px, py, self.r * C["wall_hit"]) or \
                    self._body_distance(px, py, C["neck_cells"] * self.cell + d) < 2 * self.r * C["self_hit"]:
                clear = d
                break
            d += 0.5
        if clear is None:
            return
        best = self.stats["closestSave"]
        if best is None or clear < best["distance"]:
            self.stats["closestSave"] = {"deviceId": device_id, "distance": round(clear, 1)}

    # ------------------------------------------------------------------ output

    def build_state(self):
        visible = self.phase not in ("intro",)
        return {
            "game": self.key,
            "phase": self.phase,
            "phaseElapsed": round(self.phase_time, 3),
            "phaseDuration": self.phase_duration,
            "time": round(self.time, 3),
            "snake": {
                "path": [[round(x, 2), round(y, 2)] for x, y in self.path] if visible else [],
                "dir": self.dir,
                "radius": self.r,
                "speed": round(self.speed * self.cell, 2),
            },
            "cell": self.cell,
            "food": self.food,
            "score": self.score,
            "lives": self.lives,
            "maxLives": C["lives"],
            "speedLevel": self.speed_level,
            "activeDeviceId": self.active,
            "handoffTargetDeviceId": self.handoff_target,
            "handoffIn": self.handoff_in,
            "bufferedFor": self.handoff_buffer[1] if self.handoff_buffer else None,
            "crash": self.crash,
            "events": list(self.events),
            "stats": self._public_stats() if self.over else None,
        }

    def _public_stats(self):
        s = self.stats
        control = {d: round(v, 1) for d, v in s["control"].items()}
        top = max(control.items(), key=lambda kv: kv[1]) if control else None
        fastest = min(s["reaction"].items(), key=lambda kv: kv[1]) if s["reaction"] else None
        return {
            "score": self.score, "foods": self.foods, "maxLengthCells": s["maxLengthCells"],
            "crossings": s["crossings"], "chainBest": s["chainBest"], "playTime": round(s["playTime"], 1),
            "control": control,
            "topController": {"deviceId": top[0], "seconds": top[1]} if top and top[1] > 0 else None,
            "fastestReaction": {"deviceId": fastest[0], "seconds": fastest[1]} if fastest else None,
            "closestSave": s["closestSave"],
        }
