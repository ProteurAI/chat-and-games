"""Dodge Arena - 2-8 player realtime last-one-standing dodging game.

Same engine interface / server-authority model as every other realtime
game here (see tank_battle.py's docstring) - free 8-directional movement,
an escalating wave of bouncing hazard balls, contact with one eliminates
a player. Eliminated players stay connected as spectators (their
"alive": false is broadcast, not a disconnect) until the round ends.
"""

import math
import random
import time

from .realtime_utils import circles_overlap, clamp, make_border_walls, resolve_circle_vs_walls, step_bouncing_circle

TICK_DT = 1 / 30

WORLD_SIZE = 800
PLAYER_RADIUS = 16
BALL_RADIUS = 14

PLAYER_MAX_SPEED = 220
PLAYER_ACCEL = 900
PLAYER_FRICTION = 900

COUNTDOWN_SECONDS = 3
SPAWN_INVULN_SECONDS = 1.0
BALL_SUBSTEPS = 6
MIN_SPAWN_DIST_FROM_PLAYER = 160

PLAYER_COLORS = ["#e6394d", "#2f6fd6", "#2fa84f", "#e8b32c", "#7C6CF2", "#e8622c", "#2ec4c0", "#c94fae"]

# (elapsed_seconds_threshold, target_ball_count, spawn_speed) - see the
# module docstring in the task spec: fair start, escalating, chaotic end.
# Beyond the last defined wave, ESCALATION_STEP below keeps extrapolating
# forever (capped) rather than flatlining, so a long-running match still
# keeps getting harder.
ESCALATION_WAVES = [
    (0, 2, 90),
    (10, 4, 110),
    (20, 6, 130),
    (30, 8, 150),
    (40, 10, 170),
]
ESCALATION_STEP_SECONDS = 15
ESCALATION_STEP_BALLS = 1
MAX_BALLS = 16
MAX_SPEED_MULTIPLIER = 2.0
SPEED_RAMP_SECONDS = 120  # time to reach MAX_SPEED_MULTIPLIER


def _build_arena():
    walls = make_border_walls(WORLD_SIZE, WORLD_SIZE)
    pad = 90
    block = 46
    # four small corner blocks - just enough cover/interest without
    # creating any unfair dead-end pockets (all are well clear of corners).
    for cx, cy in ((pad, pad), (WORLD_SIZE - pad, pad), (pad, WORLD_SIZE - pad), (WORLD_SIZE - pad, WORLD_SIZE - pad)):
        walls.append((cx - block / 2, cy - block / 2, cx + block / 2, cy + block / 2))
    return walls


ARENA_WALLS = _build_arena()


def _wave_target(elapsed):
    target_count, speed = ESCALATION_WAVES[0][1], ESCALATION_WAVES[0][2]
    for threshold, count, spd in ESCALATION_WAVES:
        if elapsed >= threshold:
            target_count, speed = count, spd
    last_threshold = ESCALATION_WAVES[-1][0]
    if elapsed > last_threshold:
        extra_steps = int((elapsed - last_threshold) // ESCALATION_STEP_SECONDS)
        target_count = min(MAX_BALLS, target_count + extra_steps * ESCALATION_STEP_BALLS)
    return target_count, speed


def _speed_multiplier(elapsed):
    ratio = clamp(elapsed / SPEED_RAMP_SECONDS, 0.0, 1.0)
    return 1.0 + ratio * (MAX_SPEED_MULTIPLIER - 1.0)


def _random_spawn_point(state):
    alive_positions = [(p["x"], p["y"]) for p in state["players"].values() if p["alive"]]
    for _ in range(20):
        x = random.uniform(60, WORLD_SIZE - 60)
        y = random.uniform(60, WORLD_SIZE - 60)
        if all((x - ax) ** 2 + (y - ay) ** 2 >= MIN_SPAWN_DIST_FROM_PLAYER ** 2 for ax, ay in alive_positions):
            return x, y
    return random.uniform(60, WORLD_SIZE - 60), random.uniform(60, WORLD_SIZE - 60)


def _player_spawn_points(n):
    cx, cy = WORLD_SIZE / 2, WORLD_SIZE / 2
    radius = WORLD_SIZE * 0.34
    return [(cx + radius * math.cos(2 * math.pi * i / n - math.pi / 2), cy + radius * math.sin(2 * math.pi * i / n - math.pi / 2)) for i in range(n)]


class DodgeArenaEngine:
    game_type = "dodgearena"
    name = "Dodge Arena"
    emoji = "💥"
    min_players = 2
    max_players = 8
    manual_start = True
    tick_interval = TICK_DT

    @staticmethod
    def init_state(players, options=None):
        uids = [str(p["user_id"]) for p in players]
        spawns = _player_spawn_points(len(uids))
        state = {
            "phase": "countdown",
            "countdown_end_at": time.time() + COUNTDOWN_SECONDS,
            "match_start_at": None,
            "world": {"size": WORLD_SIZE},
            "walls": ARENA_WALLS,
            "players": {},
            "player_order": uids,
            "player_names": {str(p["user_id"]): p["name"] for p in players},
            "balls": [],
            "next_ball_id": 1,
            "winner_uid": None,
            "joint_winner_uids": None,
        }
        for i, uid in enumerate(uids):
            sx, sy = spawns[i]
            state["players"][uid] = {
                "x": sx, "y": sy, "vx": 0.0, "vy": 0.0,
                "input_dx": 0.0, "input_dy": 0.0,
                "alive": True, "color": PLAYER_COLORS[i % len(PLAYER_COLORS)],
                "invuln_until": 0.0, "eliminated_at": None,
            }
        return state

    @staticmethod
    def apply_input(state, user_id, payload):
        uid = str(user_id)
        p = state["players"].get(uid)
        if not p or not p["alive"] or state["phase"] != "playing":
            return False
        if payload.get("action") != "move":
            return False
        dx, dy = payload.get("dx"), payload.get("dy")
        try:
            dx, dy = float(dx), float(dy)
        except (TypeError, ValueError):
            return False
        if not (math.isfinite(dx) and math.isfinite(dy)):
            return False
        mag = math.hypot(dx, dy)
        if mag > 1.0:
            dx, dy = dx / mag, dy / mag
        p["input_dx"], p["input_dy"] = dx, dy
        return False

    @staticmethod
    def tick(state):
        now = time.time()

        if state["phase"] == "countdown":
            if now >= state["countdown_end_at"]:
                state["phase"] = "playing"
                state["match_start_at"] = now
                for p in state["players"].values():
                    p["invuln_until"] = now + SPAWN_INVULN_SECONDS
            return

        if state["phase"] != "playing":
            return

        dt = TICK_DT
        elapsed = now - state["match_start_at"]
        walls = state["walls"]

        # --- players: accelerate toward input direction, wall push-out ---
        for p in state["players"].values():
            if not p["alive"]:
                continue
            target_vx = p["input_dx"] * PLAYER_MAX_SPEED
            target_vy = p["input_dy"] * PLAYER_MAX_SPEED
            p["vx"] = _approach(p["vx"], target_vx, PLAYER_ACCEL if p["input_dx"] else PLAYER_FRICTION, dt)
            p["vy"] = _approach(p["vy"], target_vy, PLAYER_ACCEL if p["input_dy"] else PLAYER_FRICTION, dt)
            p["x"] += p["vx"] * dt
            p["y"] += p["vy"] * dt
            p["x"], p["y"] = resolve_circle_vs_walls(p["x"], p["y"], PLAYER_RADIUS, walls)

        # --- hazard escalation: top up ball count for the current wave ---
        target_count, spawn_speed = _wave_target(elapsed)
        while len(state["balls"]) < target_count:
            bx, by = _random_spawn_point(state)
            ang = random.uniform(0, 2 * math.pi)
            state["balls"].append({
                "id": state["next_ball_id"],
                "x": bx, "y": by,
                "vx": math.cos(ang) * spawn_speed, "vy": math.sin(ang) * spawn_speed,
                "bounces": 0,
                "base_speed": spawn_speed,  # intrinsic magnitude before the global speed_mult ramp below
            })
            state["next_ball_id"] += 1

        speed_mult = _speed_multiplier(elapsed)
        for ball in state["balls"]:
            # Nudge the ball's speed MAGNITUDE toward base_speed*speed_mult
            # (direction is left entirely to physics/bounces) - clamped to
            # a small per-tick change so a bounce's fresh direction this
            # same tick is never overridden by a jarring speed snap.
            cur_speed = math.hypot(ball["vx"], ball["vy"])
            if cur_speed > 1e-6:
                target_speed = ball["base_speed"] * speed_mult
                scale = clamp(target_speed / cur_speed, 0.98, 1.02)
                ball["vx"] *= scale
                ball["vy"] *= scale
            step_bouncing_circle(ball, dt, BALL_RADIUS, walls, BALL_SUBSTEPS, None)

        # --- eliminations: collected atomically so simultaneous hits are
        # detected as a joint/draw finish instead of order-dependent bias ---
        alive_before = [uid for uid, p in state["players"].items() if p["alive"]]
        newly_eliminated = set()
        for uid in alive_before:
            p = state["players"][uid]
            if now < p["invuln_until"]:
                continue
            for ball in state["balls"]:
                if circles_overlap(p["x"], p["y"], PLAYER_RADIUS, ball["x"], ball["y"], BALL_RADIUS):
                    newly_eliminated.add(uid)
                    break

        for uid in newly_eliminated:
            state["players"][uid]["alive"] = False
            state["players"][uid]["eliminated_at"] = now

        remaining = [uid for uid in alive_before if uid not in newly_eliminated]
        if newly_eliminated:
            if not remaining and len(alive_before) >= 2:
                state["phase"] = "over"
                state["winner_uid"] = None
                state["joint_winner_uids"] = alive_before
            elif len(remaining) == 1 and len(alive_before) >= 2:
                state["phase"] = "over"
                state["winner_uid"] = remaining[0]

    @staticmethod
    def check_finished(state):
        if state["phase"] != "over":
            return None
        if state["winner_uid"] is not None:
            return {"winner_user_id": int(state["winner_uid"]), "reason": "last_standing"}
        details = {"jointWinnerUserIds": [int(u) for u in (state["joint_winner_uids"] or [])]}
        return {"winner_user_id": None, "reason": "draw", "details": details}

    @staticmethod
    def on_player_left(state, user_id):
        uid = str(user_id)
        p = state["players"].get(uid)
        if p:
            p["alive"] = False
            p["eliminated_at"] = time.time()

    @staticmethod
    def reset(state):
        players = [{"user_id": int(uid), "name": state["player_names"].get(uid, "?")} for uid in state["player_order"]]
        fresh = DodgeArenaEngine.init_state(players)
        state.clear()
        state.update(fresh)

    @staticmethod
    def public_state(state, viewer_user_id):
        now = time.time()
        seconds_left = max(0.0, state["countdown_end_at"] - now) if state["phase"] == "countdown" else 0.0
        alive_count = sum(1 for p in state["players"].values() if p["alive"])
        return {
            "phase": state["phase"],
            "world": state["world"],
            "walls": state["walls"],
            "countdownSecondsLeft": math.ceil(seconds_left) if seconds_left > 0 else 0,
            "aliveCount": alive_count,
            "winnerUserId": int(state["winner_uid"]) if state["winner_uid"] is not None else None,
            "jointWinnerUserIds": [int(u) for u in state["joint_winner_uids"]] if state["joint_winner_uids"] else None,
            "players": [
                {
                    "userId": int(uid),
                    "name": state["player_names"].get(uid, "?"),
                    "x": p["x"], "y": p["y"], "color": p["color"],
                    "alive": p["alive"], "invulnerable": now < p["invuln_until"],
                }
                for uid in state["player_order"] for p in [state["players"][uid]]
            ],
            "balls": [{"id": b["id"], "x": b["x"], "y": b["y"]} for b in state["balls"]],
        }


def _approach(current, target, rate, dt):
    delta = rate * dt
    if current < target:
        return min(current + delta, target)
    return max(current - delta, target)
