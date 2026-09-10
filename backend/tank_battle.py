"""Tank Battle - 2-4 player realtime topdown arena shooter.

Implements the same engine interface as every other game in games.py
(init_state/apply_input/tick/check_finished/reset/on_player_left) and
plugs into the existing GameSession/GameManager unchanged. Physics run
server-side at a fixed 30Hz tick (matching Pong's precedent) - the client
only ever sends "move"/"aim"/"shoot" inputs and renders whatever the
server broadcasts; there is no client-trusted position, damage or
elimination anywhere (see the module docstring in games.py for why).
"""

import math
import random
import time

from .realtime_utils import (
    angle_diff_lerp_input, circles_overlap,
    make_border_walls, resolve_circle_vs_walls, step_bouncing_circle,
)

TICK_DT = 1 / 30

WORLD_W, WORLD_H = 960, 640
TANK_RADIUS = 20
PROJECTILE_RADIUS = 5

TANK_MAX_SPEED = 200          # forward, units/s
TANK_REVERSE_SPEED = 120
TANK_ACCEL = 420
TANK_FRICTION = 380            # deceleration applied when no forward input
TANK_TURN_SPEED = 3.0          # rad/s

SHOT_SPEED = 480
SHOT_COOLDOWN = 0.8
MAX_ACTIVE_SHOTS = 2
MAX_PROJECTILE_BOUNCES = 1     # "prallt 1x ab, beim zweiten Wandkontakt zerstoert"
PROJECTILE_SUBSTEPS = 8
PROJECTILE_LIFETIME = 4.0      # seconds - safety net against a shot bouncing forever in an open layout

SPAWN_INVULN_SECONDS = 1.5
COUNTDOWN_SECONDS = 3
LIVES_STANDARD = 3

PLAYER_COLORS = ["#e6394d", "#2f6fd6", "#2fa84f", "#e8b32c"]


def _rect(x1, y1, x2, y2):
    return (x1, y1, x2, y2)


def _build_arena(name):
    border = make_border_walls(WORLD_W, WORLD_H)
    if name == "cross":
        inner = [
            _rect(WORLD_W / 2 - 14, 90, WORLD_W / 2 + 14, 260),
            _rect(WORLD_W / 2 - 14, WORLD_H - 260, WORLD_W / 2 + 14, WORLD_H - 90),
            _rect(120, WORLD_H / 2 - 14, 340, WORLD_H / 2 + 14),
            _rect(WORLD_W - 340, WORLD_H / 2 - 14, WORLD_W - 120, WORLD_H / 2 + 14),
        ]
        spawns = [
            (70, 70, 0.8), (WORLD_W - 70, 70, 2.35),
            (70, WORLD_H - 70, -0.8), (WORLD_W - 70, WORLD_H - 70, -2.35),
        ]
    else:  # "corners"
        inner = [
            _rect(200, 150, 340, 200), _rect(200, 150, 250, 320),
            _rect(WORLD_W - 340, 150, WORLD_W - 200, 200), _rect(WORLD_W - 250, 150, WORLD_W - 200, 320),
            _rect(200, WORLD_H - 200, 340, WORLD_H - 150), _rect(200, WORLD_H - 320, 250, WORLD_H - 200),
            _rect(WORLD_W - 340, WORLD_H - 200, WORLD_W - 200, WORLD_H - 150),
            _rect(WORLD_W - 250, WORLD_H - 320, WORLD_W - 200, WORLD_H - 200),
            _rect(WORLD_W / 2 - 60, WORLD_H / 2 - 18, WORLD_W / 2 + 60, WORLD_H / 2 + 18),
        ]
        spawns = [
            (90, 90, 0.8), (WORLD_W - 90, 90, 2.35),
            (90, WORLD_H - 90, -0.8), (WORLD_W - 90, WORLD_H - 90, -2.35),
        ]
    return {"name": name, "walls": border + inner, "spawns": spawns}


ARENAS = {"cross": _build_arena("cross"), "corners": _build_arena("corners")}


class TankBattleEngine:
    game_type = "tankbattle"
    name = "Tank Battle"
    emoji = "🛡️"
    min_players = 2
    max_players = 4
    manual_start = True
    tick_interval = TICK_DT

    @staticmethod
    def init_state(players, options=None):
        arena_name = random.choice(list(ARENAS.keys()))
        arena = ARENAS[arena_name]
        uids = [str(p["user_id"]) for p in players]
        spawn_order = arena["spawns"][:]
        random.shuffle(spawn_order)

        state = {
            "phase": "countdown",  # countdown -> playing -> over
            "countdown_end_at": time.time() + COUNTDOWN_SECONDS,
            "arena": arena_name,
            "walls": arena["walls"],
            "world": {"width": WORLD_W, "height": WORLD_H},
            "players": {},
            "player_order": uids,
            "player_names": {str(p["user_id"]): p["name"] for p in players},
            "projectiles": [],
            "next_projectile_id": 1,
            "winner_uid": None,
        }
        for i, uid in enumerate(uids):
            sx, sy, sa = spawn_order[i % len(spawn_order)]
            state["players"][uid] = {
                "x": sx, "y": sy, "angle": sa, "turret_angle": sa,
                "vx": 0.0, "vy": 0.0, "speed": 0.0,
                "input_forward": 0.0, "input_turn": 0.0,
                "lives": LIVES_STANDARD, "alive": True,
                "color": PLAYER_COLORS[i % len(PLAYER_COLORS)],
                "last_shot_at": 0.0, "invuln_until": 0.0,
                "hit_flash_until": 0.0,
            }
        return state

    @staticmethod
    def apply_input(state, user_id, payload):
        uid = str(user_id)
        p = state["players"].get(uid)
        if not p or not p["alive"] or state["phase"] != "playing":
            return False
        action = payload.get("action")

        if action == "move":
            forward, turn = angle_diff_lerp_input(payload.get("forward"), payload.get("turn"))
            p["input_forward"] = forward
            p["input_turn"] = turn
            return False

        if action == "aim":
            angle = payload.get("angle")
            try:
                angle = float(angle)
            except (TypeError, ValueError):
                return False
            if not math.isfinite(angle):
                return False
            p["turret_angle"] = angle % (2 * math.pi)
            return False

        if action == "shoot":
            now = time.time()
            if now - p["last_shot_at"] < SHOT_COOLDOWN:
                return False
            active = sum(1 for pr in state["projectiles"] if pr["owner"] == uid)
            if active >= MAX_ACTIVE_SHOTS:
                return False
            spawn_dist = TANK_RADIUS + PROJECTILE_RADIUS + 6
            ta = p["turret_angle"]
            state["projectiles"].append({
                "id": state["next_projectile_id"],
                "owner": uid,
                "x": p["x"] + math.cos(ta) * spawn_dist,
                "y": p["y"] + math.sin(ta) * spawn_dist,
                "vx": math.cos(ta) * SHOT_SPEED,
                "vy": math.sin(ta) * SHOT_SPEED,
                "bounces": 0,
                "spawned_at": now,
            })
            state["next_projectile_id"] += 1
            p["last_shot_at"] = now
            return False

        return False

    @staticmethod
    def tick(state):
        now = time.time()

        if state["phase"] == "countdown":
            if now >= state["countdown_end_at"]:
                state["phase"] = "playing"
                # Spawn-shield window starts counting from the moment the
                # round actually begins, not from init_state() - it would
                # otherwise silently expire during the 3-2-1 countdown,
                # during which no input/damage is processed anyway.
                for p in state["players"].values():
                    p["invuln_until"] = now + SPAWN_INVULN_SECONDS
            return

        if state["phase"] != "playing":
            return

        dt = TICK_DT
        walls = state["walls"]

        # --- tanks: accelerate/turn, wall push-out, tank-vs-tank separation ---
        for uid, p in state["players"].items():
            if not p["alive"]:
                continue
            p["angle"] = (p["angle"] + p["input_turn"] * TANK_TURN_SPEED * dt) % (2 * math.pi)

            target_speed = p["input_forward"] * (TANK_MAX_SPEED if p["input_forward"] >= 0 else TANK_REVERSE_SPEED)
            if abs(target_speed) > 1e-6:
                accel = TANK_ACCEL * dt
                if p["speed"] < target_speed:
                    p["speed"] = min(p["speed"] + accel, target_speed)
                else:
                    p["speed"] = max(p["speed"] - accel, target_speed)
            else:
                decel = TANK_FRICTION * dt
                if p["speed"] > 0:
                    p["speed"] = max(0.0, p["speed"] - decel)
                elif p["speed"] < 0:
                    p["speed"] = min(0.0, p["speed"] + decel)

            p["x"] += math.cos(p["angle"]) * p["speed"] * dt
            p["y"] += math.sin(p["angle"]) * p["speed"] * dt
            p["x"], p["y"] = resolve_circle_vs_walls(p["x"], p["y"], TANK_RADIUS, walls)

        alive_uids = [u for u, p in state["players"].items() if p["alive"]]
        for i, ua in enumerate(alive_uids):
            for ub in alive_uids[i + 1:]:
                pa, pb = state["players"][ua], state["players"][ub]
                dx, dy = pa["x"] - pb["x"], pa["y"] - pb["y"]
                dist_sq = dx * dx + dy * dy
                min_dist = TANK_RADIUS * 2
                if 0 < dist_sq < min_dist * min_dist:
                    dist = math.sqrt(dist_sq)
                    push = (min_dist - dist) / 2
                    nx, ny = dx / dist, dy / dist
                    pa["x"] += nx * push; pa["y"] += ny * push
                    pb["x"] -= nx * push; pb["y"] -= ny * push

        # --- projectiles: substepped bounce movement, then hit-tests ---
        surviving_projectiles = []
        for pr in state["projectiles"]:
            if now - pr["spawned_at"] > PROJECTILE_LIFETIME:
                continue
            destroyed = step_bouncing_circle(pr, dt, PROJECTILE_RADIUS, walls, PROJECTILE_SUBSTEPS, MAX_PROJECTILE_BOUNCES)
            if destroyed:
                continue

            hit_uid = None
            for uid, p in state["players"].items():
                if not p["alive"] or uid == pr["owner"] or now < p["invuln_until"]:
                    continue
                if circles_overlap(pr["x"], pr["y"], PROJECTILE_RADIUS, p["x"], p["y"], TANK_RADIUS):
                    hit_uid = uid
                    break
            if hit_uid is not None:
                target = state["players"][hit_uid]
                target["lives"] -= 1
                target["hit_flash_until"] = now + 0.35
                if target["lives"] <= 0:
                    target["alive"] = False
                continue  # projectile consumed on hit, never survives

            surviving_projectiles.append(pr)
        state["projectiles"] = surviving_projectiles

        # --- win condition ---
        still_alive = [u for u, p in state["players"].items() if p["alive"]]
        if len(still_alive) <= 1 and state["phase"] == "playing":
            state["phase"] = "over"
            state["winner_uid"] = still_alive[0] if len(still_alive) == 1 else None

    @staticmethod
    def check_finished(state):
        if state["phase"] != "over":
            return None
        winner = state["winner_uid"]
        return {
            "winner_user_id": int(winner) if winner is not None else None,
            "reason": "last_standing" if winner is not None else "draw",
        }

    @staticmethod
    def on_player_left(state, user_id):
        uid = str(user_id)
        p = state["players"].get(uid)
        if p:
            p["alive"] = False

    @staticmethod
    def reset(state):
        players = [{"user_id": int(uid), "name": state["player_names"].get(uid, "?")} for uid in state["player_order"]]
        fresh = TankBattleEngine.init_state(players)
        state.clear()
        state.update(fresh)

    @staticmethod
    def public_state(state, viewer_user_id):
        now = time.time()
        seconds_left = max(0.0, state["countdown_end_at"] - now) if state["phase"] == "countdown" else 0.0
        return {
            "phase": state["phase"],
            "arena": state["arena"],
            "world": state["world"],
            "walls": state["walls"],
            "countdownSecondsLeft": math.ceil(seconds_left) if seconds_left > 0 else 0,
            "winnerUserId": int(state["winner_uid"]) if state["winner_uid"] is not None else None,
            "players": [
                {
                    "userId": int(uid),
                    "name": state["player_names"].get(uid, "?"),
                    "x": p["x"], "y": p["y"], "angle": p["angle"], "turretAngle": p["turret_angle"],
                    "color": p["color"], "lives": p["lives"], "alive": p["alive"],
                    "invulnerable": now < p["invuln_until"],
                    "hitFlash": now < p["hit_flash_until"],
                }
                for uid, p in ((u, state["players"][u]) for u in state["player_order"])
            ],
            "projectiles": [
                {"id": pr["id"], "x": pr["x"], "y": pr["y"], "owner": int(pr["owner"])}
                for pr in state["projectiles"]
            ],
        }
