"""KopfKicker - 2-player realtime arcade head-football.

Implements the same engine interface as every other realtime game here
(see tank_battle.py's module docstring for the general server-authority
model): the client only ever sends inputs, every position/goal/score/timer
is decided here.

PHYSICS (v2). Everything tunable lives in KOPF_PHYSICS_CONFIG below - no
magic numbers in the step functions. The rules the model is built on:

- Fixed timestep. GameManager calls tick() roughly every 1/30s (that is
  also the snapshot rate), but the physics itself always advances in
  exact 1/60s steps from an accumulator fed by real elapsed time, capped
  at MAX_CATCHUP_STEPS per tick (a stalled server skips time instead of
  spiralling). Game speed therefore no longer depends on how late the
  asyncio loop wakes up, and every timer inside the simulation (kick
  window, cooldown, coyote time, jump buffer) runs on simulated time.
- Energy only comes from players. Static surfaces (floor, walls,
  ceiling, posts, net, a standing player's head/body) can only return
  energy with a loss: impulse response along the contact normal with a
  per-surface restitution < 1, applied only when the ball is actually
  moving INTO the surface, computed against the collider's own velocity
  (so a moving head/body adds energy, a standing one never does).
- Position correction never touches velocity. Pushing an overlapping
  ball out of a collider is a pure position fix.
- One impulse per player per substep: head has priority, the body only
  corrects position if the head already responded.
- Substeps: the ball moves at most ~45% of its radius per substep (1..6
  substeps per 1/60s step), so it can't tunnel through the thin crossbar,
  a head or the floor even at max speed.
- Rest: tiny floor bounces are cut, a grounded ball rolls out under
  rolling friction and finally sleeps (vx=vy=0, no integration, no
  micro-jitter) until a player or kick touches it again.
- Goal detection is separate from the net geometry: the ball fully past
  the goal line inside the mouth is a goal, checked every substep, and
  the phase change stops the simulation immediately (scored once).

The v1 model this replaces set the ball's speed to a FIXED value on every
head/body contact (520 / 360 units/s regardless of incoming speed or of
whether the player moved), bounced perfectly elastically off every wall
(realtime_utils.step_bouncing_circle - shared with Tank Battle/Dodge
Arena, so KopfKicker now has its own stepper instead of changing it) and
damped with a per-30Hz-tick factor. A ball landing on a standing head was
relaunched at 520 forever, two idle players could keep a rally going on
their own, and a resting ball kept jittering on the floor.

Unlike every other game, a KopfKicker match has a mandatory pre-match
phase: both players must submit a selfie (used as their giant player-
sprite head) and mark themselves ready before the host can start the
match. That whole flow - selfie -> ready -> countdown -> playing ->
goal pause -> ... -> over - lives entirely inside this engine's own
state["phase"] machine (init_state() is called as soon as the 2nd player
joins, manual_start=False - see games.py registration), the exact same
"phase state machine driven by tick()+apply_input()" pattern
know_me.py/majority_game.py/drawing_game.py already use for their own
multi-stage rounds.

SELFIES ARE NEVER PERSISTED. They exist ONLY as a data URL string kept in
this in-memory session.state (state["selfies"]) for as long as the
GameSession object exists - never written to SQLite, never touched by
main.py's /api/upload (which writes to disk for permanent chat images;
deliberately not reused here). They're wiped the moment the session is
torn down (GameManager already removes the whole session dict entry on
the last player leaving - see _remove_player in games.py) and are never
folded into a user's profile/avatar. See handle_selfie_set/
handle_request_selfie below for how they're actually moved over the wire:
NOT as part of the generic per-tick public_state() broadcast (which
would resend a base64 image ~10-30x/second to both players for the rest
of the match) but via two small dedicated websocket message types,
exactly mirroring how drawing_game.py keeps live strokes out of its own
generic broadcast.

Real player-reconnect-into-the-same-match isn't attempted here either,
for the same reason documented in drawing_game.py: no game in this
codebase has a mechanism to resume a dropped websocket back into the
SAME session slot. What IS implemented: a short in-match GRACE PERIOD
after a player's websocket drops (the match visibly pauses instead of
ending immediately). min_players == max_players == 2 here, so GameManager's
generic _remove_player() would end the match on any disconnect; the
engine opts out via allow_below_min_players_grace and runs its own
tick()-driven "disconnect_grace" countdown instead. Because the generic
teardown is skipped, this engine is also responsible for ending the
session itself whenever a player leaves outside a running match (lobby)
or nobody is left at all - otherwise the tick task would outlive it.
"""

import base64
import binascii
import math
import time

from .realtime_utils import circle_vs_rect_mtv, clamp

# ============================================================================
# Central physics config. World units: the arena is 1600 x 900 (ground line
# at y=760, y grows downward). Reference values from the design brief were
# given for a ~1000 x 560 world; lengths/speeds/accelerations were scaled
# by ~1.6 where that fit and then tuned against the simulations in
# tests/test_kopfkicker_physics.py - the tests are the spec, not the numbers.
# ============================================================================
KOPF_PHYSICS_CONFIG = {
    "WORLD": {
        "width": 1600, "height": 900, "ground_y": 760,
        "physics_hz": 60,
        "max_catchup_steps": 5,
    },
    "BALL": {
        "radius": 24,
        "gravity": 2100,
        "max_speed": 1900,
        "air_drag": 0.10,                 # 1/s, exponential: v *= exp(-k*dt)
        "max_substep_travel": 0.45,       # * radius per substep
        "max_substeps": 6,
        "restitution": {
            "floor": 0.66, "wall": 0.76, "ceiling": 0.60,
            "post": 0.80, "net": 0.40,
            "head": 0.86, "body": 0.70,
        },
        "floor_tangent_keep": 0.92,       # tangential speed kept on a real floor impact
        "surface_tangent_keep": 0.96,     # same for walls/posts/ceiling/net
        "head_tangent_keep": 0.90,
        "body_tangent_keep": 0.85,
        "floor_rest_speed": 110,          # floor impact speed below which it stops bouncing
        "contact_rest_speed": 60,         # same for every other surface / head / body
        "roll_friction": 0.9,             # 1/s exponential while rolling on the floor
        "roll_decel": 140,                # units/s^2 constant rolling resistance
        "sleep_speed": 14,
        "sleep_vy": 60,
        "kickoff_height": 300,            # above ground, dropped with vx=vy=0
        "impact_event_speed": 320,        # min impact speed for a floor/wall/post event
    },
    "PLAYER": {
        "head_radius": 46, "body_radius": 24,
        "head_offset": 92, "body_offset": 34,   # centers above the foot line
        "run_speed": 480,
        "ground_accel": 4000,
        "ground_decel": 5200,
        "turn_accel": 7000,               # accelerating against current motion
        "air_control": 0.55,
        "gravity": 3400,
        "jump_velocity": 1000,
        "max_fall_speed": 1400,
        "jump_cut": 0.45,                 # vy multiplier when jump is released while rising
        "coyote_time": 0.08,
        "jump_buffer": 0.10,
        "land_anim": 0.12,
        "head_push_bonus": 0.30,          # extra share of a head's own approach speed
        # Share of the player's own velocity that takes part in the contact
        # (a head isn't an infinitely heavy wall - with 1.0 a jumping header
        # launched the ball at max speed into the ceiling every time).
        "velocity_share": {"head": 0.6, "body": 0.75},
        "separation": 48,                 # body-to-body minimum distance
    },
    "KICK": {
        "windup": 0.03,
        "active": 0.11,
        "total": 0.22,
        "cooldown": 0.36,
        "power": 1350,
        "lift": 380,
        "velocity_transfer": 0.40,        # share of the kicker's own vx added
        "reach": 20,                      # hitbox center ahead of the body edge
        "height": 20,                     # hitbox center above the foot line
        "radius": 34,
    },
    "GOAL": {
        "height": 220, "depth": 70, "post_thickness": 10,
    },
    "NETWORK": {
        "snapshot_hz": 30,                # = GameManager tick rate (tick_interval)
        "max_events": 12,
    },
}

_W = KOPF_PHYSICS_CONFIG["WORLD"]
_B = KOPF_PHYSICS_CONFIG["BALL"]
_P = KOPF_PHYSICS_CONFIG["PLAYER"]
_K = KOPF_PHYSICS_CONFIG["KICK"]
_G = KOPF_PHYSICS_CONFIG["GOAL"]
_N = KOPF_PHYSICS_CONFIG["NETWORK"]

TICK_DT = 1 / _N["snapshot_hz"]
PHYSICS_DT = 1 / _W["physics_hz"]
MAX_CATCHUP_STEPS = _W["max_catchup_steps"]

WORLD_W, WORLD_H = _W["width"], _W["height"]
GROUND_Y = _W["ground_y"]
GOAL_HEIGHT = _G["height"]
GOAL_DEPTH = _G["depth"]
POST_THICKNESS = _G["post_thickness"]
GOAL_TOP_Y = GROUND_Y - GOAL_HEIGHT
BALL_RADIUS = _B["radius"]
HEAD_RADIUS = _P["head_radius"]
BODY_RADIUS = _P["body_radius"]
HEAD_OFFSET = _P["head_offset"]
BODY_OFFSET = _P["body_offset"]
# A player's head must never reach into the goal frame, so they stop a
# head-radius (+post) short of each goal line.
PLAYER_MIN_X = HEAD_RADIUS + POST_THICKNESS
PLAYER_MAX_X = WORLD_W - HEAD_RADIUS - POST_THICKNESS

# ---------- match ----------

MATCH_SECONDS = 90
KICKOFF_COUNTDOWN_SECONDS = 3
GOAL_PAUSE_SECONDS = 1.8
DISCONNECT_GRACE_SECONDS = 15

PLAYER_COLORS = ["#2f6fd6", "#e8622c"]  # left = blue, right = orange, per spec

ALLOWED_SELFIE_MIME = {"image/webp", "image/jpeg", "image/png"}
MAX_SELFIE_B64_CHARS = 420_000  # base64 of ~300KB is comfortably under this


def _build_walls():
    """Solid ball surfaces as (rect, kind). The goal mouth itself (between
    crossbar and ground) is deliberately open - there is no invisible wall
    in front of it; a ball fully past the line there is a goal (checked
    separately, see _check_goal). Behind the line only the net backstop,
    which absorbs most of the energy."""
    t = 40
    gt = GOAL_TOP_Y
    return [
        ((-t, -t, WORLD_W + t, 0), "ceiling"),
        ((-t, GROUND_Y, WORLD_W + t, GROUND_Y + t), "floor"),
        ((-t, -t, 0, gt), "wall"),                                        # left wall above goal
        ((WORLD_W, -t, WORLD_W + t, gt), "wall"),                         # right wall above goal
        ((-t, gt - POST_THICKNESS, POST_THICKNESS, gt), "post"),          # left crossbar
        ((WORLD_W - POST_THICKNESS, gt - POST_THICKNESS, WORLD_W + t, gt), "post"),  # right crossbar
        ((-GOAL_DEPTH - t, gt, -GOAL_DEPTH, GROUND_Y), "net"),            # left net backstop
        ((WORLD_W + GOAL_DEPTH, gt, WORLD_W + GOAL_DEPTH + t, GROUND_Y), "net"),     # right net backstop
    ]


ARENA_SURFACES = _build_walls()
ARENA_WALLS = [rect for rect, _kind in ARENA_SURFACES]  # render geometry for the client


def _approach(current, target, delta):
    if current < target:
        return min(current + delta, target)
    return max(current - delta, target)


def _new_player(uid, x, color, facing):
    return {
        "x": x, "height": 0.0, "vy": 0.0, "vx": 0.0,
        "input_dir": 0, "facing": facing, "grounded": True,
        "jump_held": False, "jump_buffer_until": -1.0, "coyote_until": -1.0, "jump_cut_done": True,
        "landed_at": -1.0,
        "kick_requested": False, "last_kick_at": -999.0, "kick_consumed": True,
        "color": color, "animation": "idle",
        "connected": True,
    }


def _clear_player_inputs(p):
    p["input_dir"] = 0
    p["jump_held"] = False
    p["jump_buffer_until"] = -1.0
    p["coyote_until"] = -1.0
    p["jump_cut_done"] = True
    p["kick_requested"] = False
    p["last_kick_at"] = -999.0
    p["kick_consumed"] = True


def _reset_ball(state):
    state["ball"] = {
        "x": WORLD_W / 2, "y": GROUND_Y - _B["kickoff_height"], "vx": 0.0, "vy": 0.0,
        "asleep": False, "last_touch_uid": None, "last_touch_at": None,
    }


def _reset_positions(state):
    uids = state["player_order"]
    for i, uid in enumerate(uids):
        p = state["players"][uid]
        p["x"] = WORLD_W * 0.28 if i == 0 else WORLD_W * 0.72
        p["height"] = 0.0
        p["vy"] = 0.0
        p["vx"] = 0.0
        p["grounded"] = True
        p["facing"] = 1 if i == 0 else -1
        p["animation"] = "idle"
        _clear_player_inputs(p)
    _reset_ball(state)


def _start_kickoff(state, now):
    _reset_positions(state)
    state["phase"] = "countdown"
    state["countdown_end_at"] = now + KICKOFF_COUNTDOWN_SECONDS
    state["last_goal"] = None
    state["accumulator"] = 0.0


def _push_event(state, kind, x, y, strength=0.0):
    state["event_seq"] = state.get("event_seq", 0) + 1
    events = state.setdefault("events", [])
    events.append({"seq": state["event_seq"], "type": kind, "x": round(x, 1), "y": round(y, 1), "strength": round(strength, 2)})
    del events[:-_N["max_events"]]


class KopfKickerEngine:
    game_type = "kopfkicker"
    name = "KopfKicker"
    emoji = "⚽"
    min_players = 2
    max_players = 2
    manual_start = False
    tick_interval = TICK_DT
    # min_players == max_players == 2 here, so GameManager's generic
    # "end the match if below min_players" disconnect handling would
    # ALWAYS fire on any disconnect - opting into our own grace-period
    # handling instead (see games.py's _remove_player and this module's
    # docstring) so "match pauses, opponent has 15s to reconnect" is
    # actually reachable.
    allow_below_min_players_grace = True

    @staticmethod
    def init_state(players, options=None):
        uids = [str(p["user_id"]) for p in players]
        state = {
            "phase": "lobby",  # lobby -> countdown -> playing -> goal_pause -> countdown -> ... -> over
            "player_order": uids,
            "player_names": {str(p["user_id"]): p["name"] for p in players},
            "selfies": {},                        # uid -> data url (never touched by reset())
            "ready": {uid: False for uid in uids},
            "host_uid": uids[0],
            "players": {},
            "ball": None,
            "score": {uid: 0 for uid in uids},
            "stats": {uid: {"goals": 0, "own_goals": 0, "kicks": 0} for uid in uids},
            "match_start_at": None,
            "play_elapsed": 0.0,                 # match clock: counts only while "playing"
            "countdown_end_at": None,
            "golden_goal": False,
            "last_goal": None,
            "winner_uid": None,
            "disconnect_grace_until": None,
            "disconnected_uid": None,
            # fixed-timestep bookkeeping (see module docstring)
            "sim_time": 0.0,
            "physics_step": 0,
            "accumulator": 0.0,
            "last_tick_real": None,
            "events": [],
            "event_seq": 0,
        }
        for i, uid in enumerate(uids):
            x = WORLD_W * 0.28 if i == 0 else WORLD_W * 0.72
            facing = 1 if i == 0 else -1
            state["players"][uid] = _new_player(uid, x, PLAYER_COLORS[i % len(PLAYER_COLORS)], facing)
        _reset_ball(state)
        return state

    @staticmethod
    def apply_input(state, user_id, payload):
        uid = str(user_id)
        action = payload.get("action")

        if action == "ready":
            if state["phase"] != "lobby" or uid not in state["ready"]:
                return False
            if uid not in state["selfies"]:
                return False
            state["ready"][uid] = bool(payload.get("value", True))
            return False

        if action == "start_match":
            if state["phase"] != "lobby" or uid != state["host_uid"]:
                return False
            if not all(state["ready"].get(u) for u in state["player_order"]):
                return False
            if not all(u in state["selfies"] for u in state["player_order"]):
                return False
            state["match_start_at"] = time.time()
            state["play_elapsed"] = 0.0
            _start_kickoff(state, time.time())
            return False

        if action == "back_to_lobby":
            if state["phase"] != "over":
                return False
            state["phase"] = "lobby"
            state["ready"] = {u: False for u in state["player_order"]}
            state["score"] = {u: 0 for u in state["player_order"]}
            state["stats"] = {u: {"goals": 0, "own_goals": 0, "kicks": 0} for u in state["player_order"]}
            state["golden_goal"] = False
            state["winner_uid"] = None
            state["last_goal"] = None
            _reset_positions(state)
            return False

        p = state["players"].get(uid)
        if not p or state["phase"] != "playing":
            return False

        # Inputs only set intent; the next physics step acts on it, on
        # simulated time (so cooldowns/buffers can't be gamed by message
        # timing, and several presses between two steps collapse into one).
        if action == "move":
            d = payload.get("dir")
            try:
                d = int(d)
            except (TypeError, ValueError):
                return False
            p["input_dir"] = clamp(d, -1, 1)
            if p["input_dir"] != 0:
                p["facing"] = 1 if p["input_dir"] > 0 else -1
            return False

        if action == "jump":
            p["jump_held"] = True
            p["jump_buffer_until"] = state["sim_time"] + _P["jump_buffer"]
            return False

        if action == "jump_release":
            p["jump_held"] = False
            return False

        if action == "kick":
            p["kick_requested"] = True
            return False

        return False

    @staticmethod
    def tick(state):
        now = time.time()
        phase = state["phase"]
        last_real = state.get("last_tick_real")
        state["last_tick_real"] = now

        # Nobody left to play (both sockets gone): end right away instead of
        # ticking a dead session - GameManager only stops the task via
        # check_finished for this engine (see module docstring).
        if phase != "over" and not any(p["connected"] for p in state["players"].values()):
            state["phase"] = "over"
            state["winner_uid"] = None
            state["disconnect_reason"] = "opponent_left"
            return

        if phase == "disconnect_grace":
            if state["disconnect_grace_until"] is not None and now >= state["disconnect_grace_until"]:
                # opponent never came back - end the match cleanly rather
                # than hanging forever (see module docstring)
                remaining = [u for u in state["player_order"] if u != state["disconnected_uid"]]
                state["phase"] = "over"
                state["winner_uid"] = remaining[0] if remaining else None
                state["disconnect_reason"] = "opponent_disconnected"
            return

        if phase == "countdown":
            if now >= state["countdown_end_at"]:
                state["phase"] = "playing"
                state["accumulator"] = 0.0
            return

        if phase == "goal_pause":
            if state["last_goal"] and now - state["last_goal"]["at"] >= GOAL_PAUSE_SECONDS:
                if state["winner_uid"] is not None:
                    state["phase"] = "over"
                else:
                    _start_kickoff(state, now)
            return

        if phase != "playing":
            return

        # --- match clock / golden goal. Only real play time counts: the
        # kickoff countdowns and goal celebrations used to eat ~5s of the
        # 90 each. ---
        real_dt = TICK_DT if last_real is None else max(0.0, now - last_real)
        state["play_elapsed"] = state.get("play_elapsed", 0.0) + min(real_dt, 0.25)
        if state["match_start_at"] is not None and not state["golden_goal"]:
            if state["play_elapsed"] >= MATCH_SECONDS:
                scores = list(state["score"].values())
                if len(set(scores)) == 1:
                    state["golden_goal"] = True
                else:
                    winner = max(state["score"], key=lambda u: state["score"][u])
                    state["phase"] = "goal_pause"
                    state["winner_uid"] = winner
                    state["last_goal"] = {"at": now, "scorer_uid": None, "own_goal": False, "timeout": True}
                    return

        # --- fixed-timestep physics with a catch-up cap ---
        state["accumulator"] = state.get("accumulator", 0.0) + real_dt
        steps = 0
        while state["accumulator"] >= PHYSICS_DT and steps < MAX_CATCHUP_STEPS:
            state["accumulator"] -= PHYSICS_DT
            steps += 1
            step_physics(state, PHYSICS_DT, now)
            if state["phase"] != "playing":
                break
        if steps >= MAX_CATCHUP_STEPS and state["accumulator"] >= PHYSICS_DT:
            # server stalled: drop the backlog instead of simulating it
            state["accumulator"] = 0.0

    @staticmethod
    def check_finished(state):
        if state["phase"] != "over":
            return None
        winner = state["winner_uid"]
        return {
            "winner_user_id": int(winner) if winner is not None else None,
            "reason": state.get("disconnect_reason") or "match_over",
        }

    @staticmethod
    def on_player_left(state, user_id):
        uid = str(user_id)
        p = state["players"].get(uid)
        if not p:
            return
        p["connected"] = False
        _clear_player_inputs(p)
        state["selfies"].pop(uid, None)
        if state["phase"] in ("countdown", "playing", "goal_pause"):
            state["phase"] = "disconnect_grace"
            state["disconnect_grace_until"] = time.time() + DISCONNECT_GRACE_SECONDS
            state["disconnected_uid"] = uid
        elif state["phase"] == "lobby":
            # No match to pause - end the session. (The generic teardown is
            # skipped for this engine because of
            # allow_below_min_players_grace, so without this the tick task
            # of an abandoned lobby would keep running forever.)
            remaining = [u for u in state["player_order"] if u != uid]
            state["phase"] = "over"
            state["winner_uid"] = remaining[0] if remaining else None
            state["disconnect_reason"] = "opponent_left"

    @staticmethod
    def reset(state):
        # Rematch: keep selfies + names, reset everything else. Goes
        # straight to kickoff (no back-to-lobby detour) matching the
        # brief's "Rematch soll extrem einfach sein".
        state["ready"] = {u: True for u in state["player_order"]}
        state["score"] = {u: 0 for u in state["player_order"]}
        state["stats"] = {u: {"goals": 0, "own_goals": 0, "kicks": 0} for u in state["player_order"]}
        state["golden_goal"] = False
        state["winner_uid"] = None
        state["disconnect_reason"] = None
        state["match_start_at"] = time.time()
        state["play_elapsed"] = 0.0
        state["last_tick_real"] = None
        _start_kickoff(state, time.time())

    @staticmethod
    def public_state(state, viewer_user_id):
        uid = str(viewer_user_id)
        now = time.time()
        phase = state["phase"]

        seconds_left = None
        if phase in ("countdown", "playing", "goal_pause") and not state["golden_goal"] and state["match_start_at"] is not None:
            seconds_left = max(0, math.ceil(MATCH_SECONDS - state.get("play_elapsed", 0.0)))

        countdown_left = None
        if phase == "countdown" and state["countdown_end_at"] is not None:
            countdown_left = max(0.0, state["countdown_end_at"] - now)

        base = {
            "phase": phase,
            "tick": state.get("physics_step", 0),
            "serverTime": round(now, 4),
            "world": {"width": WORLD_W, "height": WORLD_H, "groundY": GROUND_Y, "goalHeight": GOAL_HEIGHT, "goalDepth": GOAL_DEPTH},
            "walls": ARENA_WALLS,
            "hostUserId": int(state["host_uid"]),
            "isHost": uid == state["host_uid"],
            "players": [
                {
                    "userId": int(u), "name": state["player_names"].get(u, "?"),
                    "hasSelfie": u in state["selfies"], "ready": state["ready"].get(u, False),
                    "connected": state["players"][u]["connected"],
                    "color": state["players"][u]["color"],
                }
                for u in state["player_order"]
            ],
            "score": {int(u): state["score"].get(u, 0) for u in state["player_order"]},
        }

        if phase in ("countdown", "playing", "goal_pause"):
            t = state["sim_time"]
            ball = state["ball"]
            base["secondsLeft"] = seconds_left
            base["goldenGoal"] = state["golden_goal"]
            base["countdownSecondsLeft"] = math.ceil(countdown_left) if countdown_left else 0
            base["ball"] = {
                "x": round(ball["x"], 2), "y": round(ball["y"], 2),
                "vx": round(ball["vx"], 1), "vy": round(ball["vy"], 1), "asleep": ball["asleep"],
            }
            base["playerState"] = {
                int(u): {
                    "x": round(p["x"], 2), "height": round(p["height"], 2),
                    "vx": round(p["vx"], 1), "vy": round(p["vy"], 1),
                    "facing": p["facing"], "grounded": p["grounded"], "animation": p["animation"],
                    "kicking": _kick_elapsed(p, t) is not None,
                    "kickT": _kick_elapsed(p, t),
                    "landT": (t - p["landed_at"]) if 0 <= t - p["landed_at"] < _P["land_anim"] else None,
                }
                for u, p in state["players"].items()
            }
            base["events"] = state.get("events", [])
            base["physics"] = _PHYSICS_FOR_CLIENT

        if phase == "goal_pause" and state["last_goal"]:
            base["lastGoal"] = {
                "scorerUserId": int(state["last_goal"]["scorer_uid"]) if state["last_goal"].get("scorer_uid") is not None else None,
                "ownGoal": state["last_goal"].get("own_goal", False),
                "timeout": state["last_goal"].get("timeout", False),
                "score": {int(u): state["score"].get(u, 0) for u in state["player_order"]},
            }

        if phase == "disconnect_grace":
            base["disconnectedUserId"] = int(state["disconnected_uid"])
            base["disconnectGraceSecondsLeft"] = max(0, math.ceil(state["disconnect_grace_until"] - now)) if state["disconnect_grace_until"] else 0

        if phase == "over":
            base["stats"] = {int(u): state["stats"].get(u, {}) for u in state["player_order"]}

        return base


# What the client needs to draw bodies/hitboxes at the server's exact sizes
# (and for the optional debug overlay) - static, built once.
_PHYSICS_FOR_CLIENT = {
    "ballRadius": BALL_RADIUS, "ballGravity": _B["gravity"],
    "headRadius": HEAD_RADIUS, "bodyRadius": BODY_RADIUS,
    "headOffset": HEAD_OFFSET, "bodyOffset": BODY_OFFSET,
    "kickReach": _K["reach"], "kickHeight": _K["height"], "kickRadius": _K["radius"],
    "kickTotal": _K["total"], "kickWindup": _K["windup"], "kickActive": _K["active"],
    "maxBallSpeed": _B["max_speed"], "physicsHz": _W["physics_hz"], "snapshotHz": _N["snapshot_hz"],
    "landAnim": _P["land_anim"],
}


# ============================================================================
# Physics step (pure functions of `state` + a fixed dt - called only from
# tick() in production, called directly by tests/test_kopfkicker_physics.py)
# ============================================================================

def _kick_elapsed(p, t):
    """Seconds since this player's current kick started, or None when no
    kick animation is running."""
    e = t - p["last_kick_at"]
    return e if 0 <= e < _K["total"] else None


def _kick_active(p, t):
    e = t - p["last_kick_at"]
    return _K["windup"] <= e < _K["windup"] + _K["active"]


def step_physics(state, dt, now=None):
    """Advances the match by exactly one fixed physics step."""
    state["sim_time"] = state.get("sim_time", 0.0) + dt
    state["physics_step"] = state.get("physics_step", 0) + 1
    t = state["sim_time"]
    for uid, p in state["players"].items():
        _step_player(state, uid, p, dt, t)
    _separate_players(state)
    _step_ball(state, dt, t, now if now is not None else time.time())


def _step_player(state, uid, p, dt, t):
    # --- kick request (cooldown on simulated time; one hit per kick) ---
    if p["kick_requested"]:
        p["kick_requested"] = False
        if t - p["last_kick_at"] >= _K["cooldown"]:
            p["last_kick_at"] = t
            p["kick_consumed"] = False
            state["stats"][uid]["kicks"] += 1

    # --- horizontal: acceleration, not instant speed ---
    d = p["input_dir"]
    if d != 0:
        target = d * _P["run_speed"]
        rate = _P["turn_accel"] if p["vx"] * d < 0 else _P["ground_accel"]
    else:
        target = 0.0
        rate = _P["ground_decel"]
    if not p["grounded"]:
        rate *= _P["air_control"]
    p["vx"] = _approach(p["vx"], target, rate * dt)
    p["x"] += p["vx"] * dt
    if p["x"] < PLAYER_MIN_X or p["x"] > PLAYER_MAX_X:
        p["x"] = clamp(p["x"], PLAYER_MIN_X, PLAYER_MAX_X)
        p["vx"] = 0.0

    # --- vertical: coyote time, jump buffer, variable height ---
    if p["grounded"]:
        p["coyote_until"] = t + _P["coyote_time"]
    can_jump = p["grounded"] or t <= p["coyote_until"]
    if p["jump_buffer_until"] >= t and can_jump:
        p["vy"] = -_P["jump_velocity"]
        p["grounded"] = False
        p["jump_buffer_until"] = -1.0
        p["coyote_until"] = -1.0
        p["jump_cut_done"] = False
    if not p["jump_held"] and not p["jump_cut_done"] and p["vy"] < 0:
        p["vy"] *= _P["jump_cut"]
        p["jump_cut_done"] = True

    if not p["grounded"]:
        p["vy"] = min(p["vy"] + _P["gravity"] * dt, _P["max_fall_speed"])
        p["height"] -= p["vy"] * dt
        if p["height"] <= 0.0:
            p["height"] = 0.0
            p["vy"] = 0.0
            p["grounded"] = True
            p["landed_at"] = t
            p["coyote_until"] = t + _P["coyote_time"]
    else:
        # standing: height is exactly 0 and stays there - no per-step
        # gravity-in/push-out cycle, so grounded can never flicker.
        p["height"] = 0.0
        p["vy"] = 0.0

    # --- animation label (visual only) ---
    if _kick_elapsed(p, t) is not None:
        p["animation"] = "kick"
    elif not p["grounded"]:
        p["animation"] = "jump" if p["vy"] < 0 else "fall"
    elif 0 <= t - p["landed_at"] < _P["land_anim"]:
        p["animation"] = "land"
    elif abs(p["vx"]) > 30:
        p["animation"] = "run"
    else:
        p["animation"] = "idle"


def _separate_players(state):
    """Bodies block each other (no walking through), gently, and only
    while they're at a similar height - a jumping player can hop over."""
    u0, u1 = state["player_order"]
    p0, p1 = state["players"][u0], state["players"][u1]
    if abs(p0["height"] - p1["height"]) > BODY_RADIUS * 2:
        return
    dx = p0["x"] - p1["x"]
    gap = _P["separation"]
    if abs(dx) >= gap:
        return
    sign = 1.0 if dx > 0 else -1.0 if dx < 0 else (1.0 if u0 < u1 else -1.0)
    push = (gap - abs(dx)) / 2
    p0["x"] = clamp(p0["x"] + sign * push, PLAYER_MIN_X, PLAYER_MAX_X)
    p1["x"] = clamp(p1["x"] - sign * push, PLAYER_MIN_X, PLAYER_MAX_X)
    # kill only the closing part of their velocities
    if p0["vx"] * -sign > 0:
        p0["vx"] = 0.0
    if p1["vx"] * sign > 0:
        p1["vx"] = 0.0


def _player_colliders(p):
    foot_y = GROUND_Y - p["height"]
    return (
        (p["x"], foot_y - HEAD_OFFSET, HEAD_RADIUS, "head"),
        (p["x"], foot_y - BODY_OFFSET, BODY_RADIUS, "body"),
    )


def _step_ball(state, dt, t, now):
    ball = state["ball"]

    # Sleeping ball: nothing to integrate unless a player reaches it.
    if ball["asleep"]:
        if not _ball_touched_by_player(state, t):
            return
        ball["asleep"] = False

    speed = math.hypot(ball["vx"], ball["vy"])
    max_travel = _B["max_substep_travel"] * BALL_RADIUS
    substeps = int(clamp(math.ceil(speed * dt / max_travel), 1, _B["max_substeps"]))
    sdt = dt / substeps
    drag = math.exp(-_B["air_drag"] * sdt)

    on_floor = False
    for _ in range(substeps):
        ball["vy"] += _B["gravity"] * sdt
        ball["vx"] *= drag
        ball["vy"] *= drag
        ball["x"] += ball["vx"] * sdt
        ball["y"] += ball["vy"] * sdt

        on_floor = _collide_surfaces(state, ball) or on_floor
        _collide_players(state, ball, t, now)
        _clamp_speed(ball)
        if _check_goal(state, ball, now):
            return

    _settle_on_floor(ball, dt, on_floor)


def _clamp_speed(ball):
    speed = math.hypot(ball["vx"], ball["vy"])
    if speed > _B["max_speed"]:  # only ever scale DOWN, never normalize up
        s = _B["max_speed"] / speed
        ball["vx"] *= s
        ball["vy"] *= s


def _bounce(ball, nx, ny, restitution, tangent_keep, cvx=0.0, cvy=0.0, rest_speed=0.0):
    """Impulse response against a collider moving with (cvx, cvy). Returns
    the incoming normal speed (>0) if the ball was moving into the
    collider, else 0 (and leaves the velocity alone). Relative velocity is
    what bounces, so a static collider (cv = 0) can only lose energy."""
    rvx, rvy = ball["vx"] - cvx, ball["vy"] - cvy
    vn = rvx * nx + rvy * ny
    if vn >= 0:
        return 0.0
    tx, ty = rvx - vn * nx, rvy - vn * ny
    if -vn < rest_speed:
        # resting contact: no bounce and no tangential loss (so a ball can
        # still roll off a head or along a wall instead of "sticking")
        new_vn, tangent_keep = 0.0, 1.0
    else:
        new_vn = -vn * restitution
    rvx = tx * tangent_keep + new_vn * nx
    rvy = ty * tangent_keep + new_vn * ny
    ball["vx"], ball["vy"] = rvx + cvx, rvy + cvy
    return -vn


def _collide_surfaces(state, ball):
    touching_floor = False
    for rect, kind in ARENA_SURFACES:
        hit = circle_vs_rect_mtv(ball["x"], ball["y"], BALL_RADIUS, rect)
        if not hit:
            continue
        nx, ny = hit["normal"]
        # 1) position correction only
        ball["x"] += nx * hit["penetration"]
        ball["y"] += ny * hit["penetration"]
        # 2) velocity response only if moving into the surface
        if kind == "floor":
            touching_floor = True
            impact = _bounce(ball, nx, ny, _B["restitution"]["floor"], _B["floor_tangent_keep"], rest_speed=_B["floor_rest_speed"])
        else:
            impact = _bounce(ball, nx, ny, _B["restitution"][kind], _B["surface_tangent_keep"], rest_speed=_B["contact_rest_speed"])
        if impact >= _B["impact_event_speed"]:
            _push_event(state, "post" if kind == "post" else kind, ball["x"] - nx * BALL_RADIUS, ball["y"] - ny * BALL_RADIUS, min(1.0, impact / _B["max_speed"]))
    return touching_floor


def _collide_players(state, ball, t, now):
    for uid, p in state["players"].items():
        responded = False
        for cx, cy, r, part in _player_colliders(p):
            dx, dy = ball["x"] - cx, ball["y"] - cy
            rsum = r + BALL_RADIUS
            dist_sq = dx * dx + dy * dy
            if dist_sq >= rsum * rsum:
                continue
            dist = math.sqrt(dist_sq)
            nx, ny = (dx / dist, dy / dist) if dist > 1e-6 else (0.0, -1.0)
            ball["x"] += nx * (rsum - dist)
            ball["y"] += ny * (rsum - dist)
            if responded:
                continue  # head already responded this substep: position fix only
            share = _P["velocity_share"][part]
            cvx, cvy = p["vx"] * share, p["vy"] * share  # collider velocity (y down, like the ball)
            if part == "head":
                impact = _bounce(ball, nx, ny, _B["restitution"]["head"], _B["head_tangent_keep"], cvx, cvy, _B["contact_rest_speed"])
                if impact > 0:
                    # a head actively moving into the ball adds a bit more
                    approach = cvx * nx + cvy * ny
                    if approach > 0:
                        ball["vx"] += nx * approach * _P["head_push_bonus"]
                        ball["vy"] += ny * approach * _P["head_push_bonus"]
            else:
                impact = _bounce(ball, nx, ny, _B["restitution"]["body"], _B["body_tangent_keep"], cvx, cvy, _B["contact_rest_speed"])
            if impact > 0:
                responded = True
                ball["asleep"] = False
                ball["last_touch_uid"] = uid
                ball["last_touch_at"] = now
                if impact > 150:
                    _push_event(state, part, ball["x"] - nx * BALL_RADIUS, ball["y"] - ny * BALL_RADIUS, min(1.0, impact / _B["max_speed"]))

        # kick hitbox: only inside the active window, one hit per kick
        if not p["kick_consumed"] and _kick_active(p, t):
            fx = p["x"] + p["facing"] * (BODY_RADIUS + _K["reach"])
            fy = GROUND_Y - p["height"] - _K["height"]
            rsum = _K["radius"] + BALL_RADIUS
            if (ball["x"] - fx) ** 2 + (ball["y"] - fy) ** 2 <= rsum * rsum:
                ball["vx"] = p["facing"] * _K["power"] + p["vx"] * _K["velocity_transfer"]
                ball["vy"] = -_K["lift"] + min(0.0, p["vy"]) * 0.3
                ball["asleep"] = False
                ball["last_touch_uid"] = uid
                ball["last_touch_at"] = now
                p["kick_consumed"] = True
                _push_event(state, "kick", ball["x"], ball["y"], 1.0)


def _ball_touched_by_player(state, t):
    ball = state["ball"]
    for p in state["players"].values():
        for cx, cy, r, _part in _player_colliders(p):
            if (ball["x"] - cx) ** 2 + (ball["y"] - cy) ** 2 < (r + BALL_RADIUS) ** 2:
                return True
        if not p["kick_consumed"] and _kick_active(p, t):
            fx = p["x"] + p["facing"] * (BODY_RADIUS + _K["reach"])
            fy = GROUND_Y - p["height"] - _K["height"]
            if (ball["x"] - fx) ** 2 + (ball["y"] - fy) ** 2 <= (_K["radius"] + BALL_RADIUS) ** 2:
                return True
    return False


def _settle_on_floor(ball, dt, on_floor):
    """Rolling + sleep. Only when resting on the floor with a small
    vertical speed: kill vy, apply rolling resistance (dt-correct), and
    put the ball to sleep once it's practically still."""
    resting = on_floor or (GROUND_Y - (ball["y"] + BALL_RADIUS)) < 0.5
    if not resting or abs(ball["vy"]) > _B["sleep_vy"]:
        return
    ball["vy"] = 0.0
    ball["y"] = GROUND_Y - BALL_RADIUS
    vx = ball["vx"] * math.exp(-_B["roll_friction"] * dt)
    vx = _approach(vx, 0.0, _B["roll_decel"] * dt)
    ball["vx"] = vx
    if abs(vx) < _B["sleep_speed"]:
        ball["vx"] = 0.0
        ball["asleep"] = True


def _check_goal(state, ball, now):
    """Ball fully past the goal line inside the mouth -> goal. Checked
    every substep; the phase switch makes it impossible to score twice."""
    if state["phase"] != "playing":
        return False
    if not (GOAL_TOP_Y < ball["y"] < GROUND_Y):
        return False
    u0, u1 = state["player_order"]
    scorer = None
    if ball["x"] + BALL_RADIUS < 0:
        scorer = u1
    elif ball["x"] - BALL_RADIUS > WORLD_W:
        scorer = u0
    if scorer is None:
        return False
    _push_event(state, "goal", ball["x"], ball["y"], 1.0)
    _register_goal(state, scorer, ball.get("last_touch_uid"), now)
    return True


def _register_goal(state, scoring_side_uid, last_toucher_uid, now):
    """scoring_side_uid is the player whose GOAL the ball did NOT go into
    (i.e. the attacking side that benefits); last_toucher_uid is whoever
    touched the ball last, used purely to label an own goal in the UI -
    the scoring side's point always goes to scoring_side_uid regardless."""
    u0, u1 = state["player_order"]
    conceding_uid = u1 if scoring_side_uid == u0 else u0
    own_goal = last_toucher_uid == conceding_uid

    state["score"][scoring_side_uid] = state["score"].get(scoring_side_uid, 0) + 1
    state["stats"][scoring_side_uid]["goals"] += 1
    if own_goal:
        state["stats"][conceding_uid]["own_goals"] += 1

    if state["golden_goal"]:
        state["winner_uid"] = scoring_side_uid
    else:
        state["winner_uid"] = None

    state["last_goal"] = {
        "at": now, "scorer_uid": scoring_side_uid, "own_goal": own_goal, "timeout": False,
    }
    state["phase"] = "goal_pause"


# ---------- selfie side-channel (kept out of the generic per-tick broadcast
# - see module docstring for why) ----------

def _decode_selfie(data_url, mime):
    if mime not in ALLOWED_SELFIE_MIME:
        return None
    if not isinstance(data_url, str) or not data_url.startswith("data:"):
        return None
    if len(data_url) > MAX_SELFIE_B64_CHARS:
        return None
    try:
        header, b64 = data_url.split(",", 1)
    except ValueError:
        return None
    if f"data:{mime}" not in header:
        return None
    try:
        raw = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        return None
    if len(raw) > 320_000:
        return None
    return data_url  # store the already-validated data URL as-is; no re-encoding needed


async def handle_selfie_set(game_manager, user, ws, raw):
    session = game_manager.get_session_for_ws(ws)
    if not session or session.game_type != "kopfkicker":
        return
    state = session.state
    if state is None or state["phase"] != "lobby":
        return
    uid = str(user["id"])
    if uid not in state["player_order"]:
        return
    data_url = _decode_selfie(raw.get("data_url"), raw.get("mime"))
    if data_url is None:
        await game_manager.cm.send_to(ws, {"type": "kopf_selfie_rejected", "reason": "invalid_image"})
        return
    state["selfies"][uid] = data_url
    state["ready"][uid] = False  # changing the photo un-readies until re-confirmed
    await game_manager.cm.send_to(ws, {"type": "kopf_selfie_ack"})
    for p in session.players:
        if p["ws"] is ws:
            continue
        await game_manager.cm.send_to(p["ws"], {"type": "kopf_selfie_photo", "user_id": user["id"], "data_url": data_url})


async def handle_request_selfie(game_manager, user, ws, raw):
    session = game_manager.get_session_for_ws(ws)
    if not session or session.game_type != "kopfkicker":
        return
    state = session.state
    if state is None:
        return
    target_uid = str(raw.get("target_user_id"))
    data_url = state["selfies"].get(target_uid)
    if not data_url:
        return
    await game_manager.cm.send_to(ws, {"type": "kopf_selfie_photo", "user_id": int(target_uid), "data_url": data_url})
