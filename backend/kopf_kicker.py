"""KopfKicker - 2-player realtime arcade head-football.

Implements the same engine interface as every other realtime game here
(see tank_battle.py's module docstring for the general server-authority
model) and reuses backend/realtime_utils.py's circle/wall collision math
directly - the same toolkit Tank Battle and Dodge Arena already use for
"circle vs a pile of AABB walls" and swept (substepped) fast-body
movement, applied here to a bouncing ball instead of projectiles/hazards.

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
SAME session slot (a fresh connection is a fresh, unrelated GameManager
entry). What IS implemented, matching the spirit of the brief's
"Disconnect"/"Reconnect" section: a short in-match GRACE PERIOD after a
player's websocket drops (the match visibly pauses instead of ending
immediately), because on_player_left() only removes them from
session.players - it does NOT itself end the session (unlike every
other game's default "not enough players -> end match" behavior) since
GameManager's generic _remove_player() only force-ends a match when the
remaining player count drops BELOW min_players, and here min_players ==
max_players == 2, which means it WOULD always instantly end the match on
any disconnect through the generic path. To get an actual pause+grace
window instead, KopfKicker keeps its own tick()-driven countdown once a
player is marked inactive (see _start_disconnect_grace/tick()'s
"disconnect_grace" phase) rather than relying on the generic session
teardown at all.
"""

import base64
import binascii
import math
import time

from .realtime_utils import circles_overlap, clamp, step_bouncing_circle

TICK_DT = 1 / 30

# ---------- world / arena ----------

WORLD_W, WORLD_H = 1600, 900
GROUND_Y = 760
GOAL_HEIGHT = 220
GOAL_DEPTH = 70
POST_THICKNESS = 10
ARENA_LEFT, ARENA_RIGHT = 0, WORLD_W

# ---------- player ----------

HEAD_RADIUS = 46
BODY_RADIUS = 24
HEAD_OFFSET = 92    # head-center height above the player's foot line, when standing
BODY_OFFSET = 34    # body-center height above the foot line
PLAYER_RUN_SPEED = 260
PLAYER_ACCEL = 1400
PLAYER_FRICTION = 1400
PLAYER_GRAVITY = 1500
JUMP_VELOCITY = 620
KICK_RANGE = 60
KICK_COOLDOWN = 0.38
KICK_ACTIVE_WINDOW = 0.16
KICK_IMPULSE = 620
KICK_UPWARD = 220
PLAYER_SEPARATION = BODY_RADIUS * 2

# ---------- ball ----------

BALL_RADIUS = 20
BALL_GRAVITY = 1350
BALL_GROUND_RESTITUTION = 0.72
BALL_WALL_RESTITUTION = 0.8
BALL_HEAD_BOUNCE_SPEED = 520
BALL_BODY_BOUNCE_SPEED = 360
BALL_PLAYER_MOMENTUM_TRANSFER = 0.35
MAX_BALL_SPEED = 1450
BALL_SUBSTEPS = 8

# ---------- match ----------

MATCH_SECONDS = 90
KICKOFF_COUNTDOWN_SECONDS = 3
GOAL_PAUSE_SECONDS = 1.8
DISCONNECT_GRACE_SECONDS = 15

PLAYER_COLORS = ["#2f6fd6", "#e8622c"]  # left = blue, right = orange, per spec

ALLOWED_SELFIE_MIME = {"image/webp", "image/jpeg", "image/png"}
MAX_SELFIE_B64_CHARS = 420_000  # base64 of ~300KB is comfortably under this


def _build_walls():
    """Border with an open goal mouth on each side (ball leaving through
    the mouth is a goal, checked separately in tick() - the wall list here
    only supplies the solid bounce surfaces: top, ground, the wall above
    each goal, a crossbar over the goal mouth, and a shallow net backstop
    so a scored ball has somewhere physical to settle instead of flying to
    infinity)."""
    t = 40
    goal_top = GROUND_Y - GOAL_HEIGHT
    walls = [
        (-t, -t, WORLD_W + t, 0),                                   # top
        (-t, GROUND_Y, WORLD_W + t, GROUND_Y + t),                  # ground
        (-t, -t, 0, goal_top),                                      # left wall above goal
        (WORLD_W, -t, WORLD_W + t, goal_top),                       # right wall above goal
        (-t, goal_top - POST_THICKNESS, POST_THICKNESS, goal_top),  # left crossbar
        (WORLD_W - POST_THICKNESS, goal_top - POST_THICKNESS, WORLD_W + t, goal_top),  # right crossbar
        (-GOAL_DEPTH - t, goal_top, -GOAL_DEPTH, GROUND_Y),         # left net backstop
        (WORLD_W + GOAL_DEPTH, goal_top, WORLD_W + GOAL_DEPTH + t, GROUND_Y),  # right net backstop
    ]
    return walls


ARENA_WALLS = _build_walls()
GOAL_TOP_Y = GROUND_Y - GOAL_HEIGHT


def _approach(current, target, rate, dt):
    delta = rate * dt
    if current < target:
        return min(current + delta, target)
    return max(current - delta, target)


def _new_player(uid, x, color, facing):
    return {
        "x": x, "height": 0.0, "vy": 0.0, "vx": 0.0,
        "input_dir": 0, "facing": facing, "grounded": True,
        "last_kick_at": -999.0, "kick_active_until": 0.0, "kick_consumed": True,
        "color": color, "animation": "idle",
        "connected": True,
    }


def _reset_ball(state, direction=None):
    state["ball"] = {
        "x": WORLD_W / 2, "y": GROUND_Y - 260, "vx": 0.0, "vy": 0.0,
        "bounces": 0, "last_touch_uid": None, "last_touch_at": None,
    }


def _reset_positions(state):
    uids = state["player_order"]
    left_x = WORLD_W * 0.28
    right_x = WORLD_W * 0.72
    state["players"][uids[0]]["x"] = left_x
    state["players"][uids[0]]["height"] = 0.0
    state["players"][uids[0]]["vy"] = 0.0
    state["players"][uids[0]]["vx"] = 0.0
    state["players"][uids[0]]["facing"] = 1
    state["players"][uids[1]]["x"] = right_x
    state["players"][uids[1]]["height"] = 0.0
    state["players"][uids[1]]["vy"] = 0.0
    state["players"][uids[1]]["vx"] = 0.0
    state["players"][uids[1]]["facing"] = -1
    _reset_ball(state)


def _start_kickoff(state, now):
    _reset_positions(state)
    state["phase"] = "countdown"
    state["countdown_end_at"] = now + KICKOFF_COUNTDOWN_SECONDS
    state["last_goal"] = None


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
            "countdown_end_at": None,
            "golden_goal": False,
            "last_goal": None,
            "winner_uid": None,
            "disconnect_grace_until": None,
            "disconnected_uid": None,
        }
        for i, uid in enumerate(uids):
            x = WORLD_W * 0.28 if i == 0 else WORLD_W * 0.72
            facing = 1 if i == 0 else -1
            state["players"][uid] = _new_player(uid, x, PLAYER_COLORS[i % len(PLAYER_COLORS)], facing)
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
            if p["grounded"]:
                p["vy"] = -JUMP_VELOCITY
                p["grounded"] = False
            return False

        if action == "kick":
            now = time.time()
            if now - p["last_kick_at"] < KICK_COOLDOWN:
                return False
            p["last_kick_at"] = now
            p["kick_active_until"] = now + KICK_ACTIVE_WINDOW
            p["kick_consumed"] = False
            state["stats"][uid]["kicks"] += 1
            return False

        return False

    @staticmethod
    def tick(state):
        now = time.time()
        phase = state["phase"]

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

        dt = TICK_DT
        walls = ARENA_WALLS

        # --- match clock / golden goal ---
        if state["match_start_at"] is not None and not state["golden_goal"]:
            elapsed = now - state["match_start_at"]
            if elapsed >= MATCH_SECONDS:
                scores = list(state["score"].values())
                if len(set(scores)) == 1:
                    state["golden_goal"] = True
                else:
                    winner = max(state["score"], key=lambda u: state["score"][u])
                    state["phase"] = "goal_pause"
                    state["winner_uid"] = winner
                    state["last_goal"] = {"at": now, "scorer_uid": None, "own_goal": False, "timeout": True}
                    return

        # --- players ---
        for uid, p in state["players"].items():
            target_speed = p["input_dir"] * PLAYER_RUN_SPEED
            rate = PLAYER_ACCEL if p["input_dir"] != 0 else PLAYER_FRICTION
            p["vx"] = _approach(p["vx"], target_speed, rate, dt)
            p["x"] += p["vx"] * dt
            p["x"] = clamp(p["x"], ARENA_LEFT + BODY_RADIUS + 4, ARENA_RIGHT - BODY_RADIUS - 4)

            p["vy"] += PLAYER_GRAVITY * dt
            p["height"] -= p["vy"] * dt
            if p["height"] <= 0:
                p["height"] = 0.0
                p["vy"] = 0.0
                p["grounded"] = True
            else:
                p["grounded"] = False

            if p["input_dir"] != 0:
                p["animation"] = "run"
            elif not p["grounded"]:
                p["animation"] = "jump"
            else:
                p["animation"] = "idle"
            if now < p["kick_active_until"]:
                p["animation"] = "kick"

        # player-vs-player gentle separation (body circles only)
        u0, u1 = state["player_order"]
        p0, p1 = state["players"][u0], state["players"][u1]
        dx = p0["x"] - p1["x"]
        if 0 < abs(dx) < PLAYER_SEPARATION:
            push = (PLAYER_SEPARATION - abs(dx)) / 2
            sign = 1 if dx > 0 else -1
            p0["x"] = clamp(p0["x"] + sign * push, ARENA_LEFT + BODY_RADIUS + 4, ARENA_RIGHT - BODY_RADIUS - 4)
            p1["x"] = clamp(p1["x"] - sign * push, ARENA_LEFT + BODY_RADIUS + 4, ARENA_RIGHT - BODY_RADIUS - 4)

        # --- ball physics: gravity + substepped wall bounce ---
        ball = state["ball"]
        ball["vy"] += BALL_GRAVITY * dt
        speed = math.hypot(ball["vx"], ball["vy"])
        if speed > MAX_BALL_SPEED:
            scale = MAX_BALL_SPEED / speed
            ball["vx"] *= scale
            ball["vy"] *= scale
        _step_ball(ball, dt, walls)

        # --- ball vs players (head first - it's the bigger, primary mechanic) ---
        for uid, p in state["players"].items():
            head_x, head_y = p["x"], GROUND_Y - p["height"] - HEAD_OFFSET
            body_x, body_y = p["x"], GROUND_Y - p["height"] - BODY_OFFSET
            _resolve_ball_vs_circle(ball, head_x, head_y, HEAD_RADIUS, BALL_HEAD_BOUNCE_SPEED, p, uid, state, now)
            _resolve_ball_vs_circle(ball, body_x, body_y, BODY_RADIUS, BALL_BODY_BOUNCE_SPEED, p, uid, state, now)

            # kick: only while the kick window is active and not yet consumed
            if now < p["kick_active_until"] and not p["kick_consumed"]:
                foot_x = p["x"] + p["facing"] * (BODY_RADIUS + 10)
                foot_y = GROUND_Y - p["height"] - 10
                if circles_overlap(ball["x"], ball["y"], BALL_RADIUS, foot_x, foot_y, KICK_RANGE):
                    ball["vx"] = p["facing"] * KICK_IMPULSE + p["vx"] * BALL_PLAYER_MOMENTUM_TRANSFER
                    ball["vy"] = -KICK_UPWARD
                    ball["last_touch_uid"] = uid
                    ball["last_touch_at"] = now
                    p["kick_consumed"] = True

        # --- goal check: ball fully past the goal line, within goal height.
        # Left goal breached -> the RIGHT player (u1) is credited (own-goal
        # labeling happens inside _register_goal, based on last_touch_uid). ---
        goal_scorer = None
        if ball["x"] + BALL_RADIUS < 0 and GOAL_TOP_Y < ball["y"] < GROUND_Y:
            goal_scorer = u1
        elif ball["x"] - BALL_RADIUS > WORLD_W and GOAL_TOP_Y < ball["y"] < GROUND_Y:
            goal_scorer = u0

        if goal_scorer is not None:
            _register_goal(state, goal_scorer, ball.get("last_touch_uid"), now)

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
        state["selfies"].pop(uid, None)
        if state["phase"] in ("countdown", "playing", "goal_pause"):
            state["phase"] = "disconnect_grace"
            state["disconnect_grace_until"] = time.time() + DISCONNECT_GRACE_SECONDS
            state["disconnected_uid"] = uid
        elif state["phase"] == "lobby":
            # nobody to play against - the generic GameManager teardown
            # (min_players == max_players == 2 here) will end the whole
            # session for us the moment this returns.
            pass

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
        _start_kickoff(state, time.time())

    @staticmethod
    def public_state(state, viewer_user_id):
        uid = str(viewer_user_id)
        now = time.time()
        phase = state["phase"]

        seconds_left = None
        if phase == "playing" and not state["golden_goal"] and state["match_start_at"] is not None:
            elapsed = now - state["match_start_at"]
            seconds_left = max(0, math.ceil(MATCH_SECONDS - elapsed))

        countdown_left = None
        if phase == "countdown" and state["countdown_end_at"] is not None:
            countdown_left = max(0.0, state["countdown_end_at"] - now)

        base = {
            "phase": phase,
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
            base["secondsLeft"] = seconds_left
            base["goldenGoal"] = state["golden_goal"]
            base["countdownSecondsLeft"] = math.ceil(countdown_left) if countdown_left else (0 if phase != "countdown" else 0)
            base["ball"] = {"x": state["ball"]["x"], "y": state["ball"]["y"], "vx": state["ball"]["vx"], "vy": state["ball"]["vy"]}
            base["playerState"] = {
                int(u): {
                    "x": p["x"], "height": p["height"], "vx": p["vx"], "vy": p["vy"],
                    "facing": p["facing"], "grounded": p["grounded"], "animation": p["animation"],
                    "kicking": now < p["kick_active_until"],
                }
                for u, p in state["players"].items()
            }

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


def _step_ball(ball, dt, walls):
    step_bouncing_circle(ball, dt, BALL_RADIUS, walls, BALL_SUBSTEPS, None)
    # step_bouncing_circle's reflection is a plain elastic bounce (dot
    # product reflect) - scale the post-bounce speed down a touch so the
    # ball doesn't bounce forever at full energy, but only on ticks where
    # a bounce actually happened this step (tracked via ball["bounces"]
    # incrementing) - approximate by just damping every tick lightly
    # instead, which reads as "ball settles" without extra bookkeeping.
    ball["vx"] *= (1 - (1 - BALL_WALL_RESTITUTION) * 0.06)
    ball["vy"] *= (1 - (1 - BALL_GROUND_RESTITUTION) * 0.06)


def _resolve_ball_vs_circle(ball, cx, cy, radius, bounce_speed, player, uid, state, now):
    if not circles_overlap(ball["x"], ball["y"], BALL_RADIUS, cx, cy, radius):
        return
    dx, dy = ball["x"] - cx, ball["y"] - cy
    dist = math.hypot(dx, dy) or 1.0
    nx, ny = dx / dist, dy / dist
    overlap = (radius + BALL_RADIUS) - dist
    ball["x"] += nx * overlap
    ball["y"] += ny * overlap
    ball["vx"] = nx * bounce_speed + player["vx"] * BALL_PLAYER_MOMENTUM_TRANSFER
    ball["vy"] = ny * bounce_speed - abs(player["vy"]) * 0.15
    ball["last_touch_uid"] = uid
    ball["last_touch_at"] = now


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
