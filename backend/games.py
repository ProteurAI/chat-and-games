"""Multiplayer minigame engines + session/lobby management.

Every game is a small "engine" class exposing a fixed interface:

    game_type, name, emoji, min_players, max_players  (class attrs)
    manual_start                                        (bool; False = auto-start once max_players joined,
                                                           True = session waits in the lobby until the host
                                                           explicitly starts it, once min_players have joined)
    tick_interval                                       (seconds, or None for turn-based games)
    init_state(players) -> state
    apply_input(state, user_id, payload) -> bool changed   (mutates state)
    tick(state) -> None                                     (mutates state; only called if tick_interval is set)
    check_finished(state) -> Optional[{"winner_user_id": int|None, "reason": str, "details": optional dict}]
    reset(state) -> None                                    (optional; enables a "rematch" button)
    on_player_left(state, user_id) -> None                  (optional; lets a >2-player game keep running
                                                              when one participant disconnects mid-match
                                                              instead of ending the whole session for everyone)

To add a new game later: write a new engine class implementing the interface
above and register it in GAME_ENGINES. GameSession/GameManager below are
generic and don't need to change.
"""

import asyncio
import random
import time
import uuid


# ---------- Pong ----------

PONG_WIDTH = 100
PONG_HEIGHT = 60
PADDLE_HALF = 8
PADDLE_X_LEFT = 4
PADDLE_X_RIGHT = 96
PADDLE_SPEED = 3.2
BALL_SPEED = 1.6
MAX_BALL_SPEED = 3.4
WIN_SCORE = 5


def _reset_ball(state, direction=None):
    state["ball"] = {
        "x": PONG_WIDTH / 2,
        "y": PONG_HEIGHT / 2,
        "vx": BALL_SPEED * (direction if direction is not None else random.choice([-1, 1])),
        "vy": BALL_SPEED * random.choice([-0.6, 0.6]),
    }


class PongEngine:
    game_type = "pong"
    name = "Pong"
    emoji = "🏓"
    min_players = 2
    max_players = 2
    manual_start = False
    tick_interval = 1 / 30

    @staticmethod
    def init_state(players):
        uids = [str(p["user_id"]) for p in players]
        state = {
            "width": PONG_WIDTH,
            "height": PONG_HEIGHT,
            "paddle_half": PADDLE_HALF,
            "paddle_x_left": PADDLE_X_LEFT,
            "paddle_x_right": PADDLE_X_RIGHT,
            "sides": {uids[0]: "left", uids[1]: "right"},
            "paddles": {uids[0]: PONG_HEIGHT / 2, uids[1]: PONG_HEIGHT / 2},
            "input": {uids[0]: 0, uids[1]: 0},
            "score": {uids[0]: 0, uids[1]: 0},
        }
        _reset_ball(state)
        return state

    @staticmethod
    def apply_input(state, user_id, payload):
        uid = str(user_id)
        if uid not in state["input"]:
            return False
        state["input"][uid] = {"up": -1, "down": 1, "stop": 0}.get(payload.get("direction"), 0)
        return False

    @staticmethod
    def tick(state):
        for uid, direction in state["input"].items():
            new_y = state["paddles"][uid] + direction * PADDLE_SPEED
            state["paddles"][uid] = max(PADDLE_HALF, min(PONG_HEIGHT - PADDLE_HALF, new_y))

        ball = state["ball"]
        ball["x"] += ball["vx"]
        ball["y"] += ball["vy"]

        if ball["y"] <= 0:
            ball["y"] = 0
            ball["vy"] = abs(ball["vy"])
        elif ball["y"] >= PONG_HEIGHT:
            ball["y"] = PONG_HEIGHT
            ball["vy"] = -abs(ball["vy"])

        left_uid = next(u for u, s in state["sides"].items() if s == "left")
        right_uid = next(u for u, s in state["sides"].items() if s == "right")

        if ball["vx"] < 0 and ball["x"] <= PADDLE_X_LEFT:
            paddle_y = state["paddles"][left_uid]
            if paddle_y - PADDLE_HALF <= ball["y"] <= paddle_y + PADDLE_HALF:
                ball["x"] = PADDLE_X_LEFT
                offset = (ball["y"] - paddle_y) / PADDLE_HALF
                ball["vx"] = min(abs(ball["vx"]) * 1.04, MAX_BALL_SPEED)
                ball["vy"] = max(-2.4, min(2.4, ball["vy"] + offset * 0.8))
            else:
                state["score"][right_uid] += 1
                _reset_ball(state, direction=1)

        elif ball["vx"] > 0 and ball["x"] >= PADDLE_X_RIGHT:
            paddle_y = state["paddles"][right_uid]
            if paddle_y - PADDLE_HALF <= ball["y"] <= paddle_y + PADDLE_HALF:
                ball["x"] = PADDLE_X_RIGHT
                offset = (ball["y"] - paddle_y) / PADDLE_HALF
                ball["vx"] = -min(abs(ball["vx"]) * 1.04, MAX_BALL_SPEED)
                ball["vy"] = max(-2.4, min(2.4, ball["vy"] + offset * 0.8))
            else:
                state["score"][left_uid] += 1
                _reset_ball(state, direction=-1)

    @staticmethod
    def check_finished(state):
        for uid, score in state["score"].items():
            if score >= WIN_SCORE:
                return {"winner_user_id": int(uid), "reason": "score"}
        return None


# ---------- Tic-Tac-Toe ----------

_TTT_LINES = [
    (0, 1, 2), (3, 4, 5), (6, 7, 8),
    (0, 3, 6), (1, 4, 7), (2, 5, 8),
    (0, 4, 8), (2, 4, 6),
]


def _ttt_winner(board):
    for a, b, c in _TTT_LINES:
        if board[a] and board[a] == board[b] == board[c]:
            return board[a]
    return None


class TicTacToeEngine:
    game_type = "tictactoe"
    name = "Tic-Tac-Toe"
    emoji = "⭕"
    min_players = 2
    max_players = 2
    manual_start = False
    tick_interval = None

    @staticmethod
    def init_state(players):
        uids = [str(p["user_id"]) for p in players]
        return {
            "board": [None] * 9,
            "symbols": {uids[0]: "X", uids[1]: "O"},
            "turn": uids[0],
            "winner": None,
        }

    @staticmethod
    def apply_input(state, user_id, payload):
        uid = str(user_id)
        if state["winner"] is not None or state["turn"] != uid:
            return False
        idx = payload.get("cell_index")
        if not isinstance(idx, int) or not (0 <= idx < 9) or state["board"][idx] is not None:
            return False
        state["board"][idx] = state["symbols"][uid]
        winner_symbol = _ttt_winner(state["board"])
        if winner_symbol:
            state["winner"] = winner_symbol
        elif all(cell is not None for cell in state["board"]):
            state["winner"] = "draw"
        else:
            state["turn"] = next(u for u in state["symbols"] if u != uid)
        return True

    @staticmethod
    def tick(state):
        pass

    @staticmethod
    def check_finished(state):
        winner = state["winner"]
        if winner == "draw":
            return {"winner_user_id": None, "reason": "draw"}
        if winner in ("X", "O"):
            uid = next(u for u, s in state["symbols"].items() if s == winner)
            return {"winner_user_id": int(uid), "reason": "line"}
        return None

    @staticmethod
    def reset(state):
        uids = list(state["symbols"].keys())
        state["symbols"] = {uids[0]: state["symbols"][uids[1]], uids[1]: state["symbols"][uids[0]]}
        state["board"] = [None] * 9
        state["winner"] = None
        state["turn"] = next(u for u, s in state["symbols"].items() if s == "X")


# ---------- Light Cycles (Tron-style, 2-4 players) ----------

LC_GRID_SIZE = 30
LC_COLORS = ["red", "blue", "green", "yellow"]
# (x, y, initial_dir) per player slot, ordered so the 2-player case lands on
# maximally-separated diagonal corners rather than two adjacent ones.
LC_START_CONFIG = [
    (2, 2, "right"),
    (LC_GRID_SIZE - 3, LC_GRID_SIZE - 3, "left"),
    (LC_GRID_SIZE - 3, 2, "down"),
    (2, LC_GRID_SIZE - 3, "up"),
]
_LC_DELTAS = {"up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0)}
_LC_OPPOSITE = {"up": "down", "down": "up", "left": "right", "right": "left"}


class LightCyclesEngine:
    game_type = "lightcycles"
    name = "Light Cycles"
    emoji = "🏍️"
    min_players = 2
    max_players = 4
    manual_start = True
    tick_interval = 1 / 8

    @staticmethod
    def init_state(players):
        state = {"grid_size": LC_GRID_SIZE, "players": {}, "trail": []}
        for i, p in enumerate(players):
            uid = str(p["user_id"])
            x, y, d = LC_START_CONFIG[i]
            color = LC_COLORS[i]
            state["players"][uid] = {"x": x, "y": y, "dir": d, "pending_dir": d, "alive": True, "color": color}
            state["trail"].append([x, y, color])
        return state

    @staticmethod
    def apply_input(state, user_id, payload):
        uid = str(user_id)
        p = state["players"].get(uid)
        if not p or not p["alive"]:
            return False
        new_dir = payload.get("direction")
        if new_dir not in _LC_DELTAS or _LC_OPPOSITE[new_dir] == p["dir"]:
            return False  # invalid direction, or a 180 turn straight into the own trail
        p["pending_dir"] = new_dir
        return False

    @staticmethod
    def tick(state):
        occupied = {(c[0], c[1]) for c in state["trail"]}
        next_positions = {}
        for uid, p in state["players"].items():
            if not p["alive"]:
                continue
            p["dir"] = p["pending_dir"]
            dx, dy = _LC_DELTAS[p["dir"]]
            next_positions[uid] = (p["x"] + dx, p["y"] + dy)

        size = state["grid_size"]
        cell_counts = {}
        for pos in next_positions.values():
            cell_counts[pos] = cell_counts.get(pos, 0) + 1

        for uid, (nx, ny) in next_positions.items():
            p = state["players"][uid]
            out_of_bounds = nx < 0 or ny < 0 or nx >= size or ny >= size
            crashed = out_of_bounds or (nx, ny) in occupied or cell_counts[(nx, ny)] > 1
            if crashed:
                p["alive"] = False
            else:
                p["x"], p["y"] = nx, ny
                state["trail"].append([nx, ny, p["color"]])

    @staticmethod
    def check_finished(state):
        alive = [uid for uid, p in state["players"].items() if p["alive"]]
        if len(alive) == 1:
            return {"winner_user_id": int(alive[0]), "reason": "last_standing"}
        if len(alive) == 0:
            return {"winner_user_id": None, "reason": "draw"}
        return None

    @staticmethod
    def on_player_left(state, user_id):
        p = state["players"].get(str(user_id))
        if p:
            p["alive"] = False


# ---------- Buzzer ----------

BUZZER_MIN_DELAY = 2.0
BUZZER_MAX_DELAY = 6.0


class BuzzerEngine:
    game_type = "buzzer"
    name = "Buzzer"
    emoji = "🔔"
    min_players = 2
    max_players = 4
    manual_start = True
    tick_interval = 1 / 20

    @staticmethod
    def init_state(players):
        uids = [str(p["user_id"]) for p in players]
        return {
            "phase": "countdown",  # countdown -> signal
            "signal_at": time.time() + random.uniform(BUZZER_MIN_DELAY, BUZZER_MAX_DELAY),
            "players_order": uids,
            "results": {uid: {"clicked_at": None, "reaction_ms": None, "disqualified": False} for uid in uids},
        }

    @staticmethod
    def apply_input(state, user_id, payload):
        uid = str(user_id)
        if payload.get("action") != "buzz":
            return False
        r = state["results"].get(uid)
        if r is None or r["clicked_at"] is not None:
            return False
        now = time.time()
        r["clicked_at"] = now
        # Compare against the authoritative deadline directly (not the
        # tick-driven "phase" field) so a click landing in the gap between
        # the true random deadline and the next tick noticing it is never
        # unfairly judged a false start.
        if now < state["signal_at"]:
            r["disqualified"] = True
        else:
            r["reaction_ms"] = round((now - state["signal_at"]) * 1000)
        return True

    @staticmethod
    def tick(state):
        if state["phase"] == "countdown" and time.time() >= state["signal_at"]:
            state["phase"] = "signal"

    @staticmethod
    def check_finished(state):
        results = state["results"]
        valid_clicks = [(uid, r) for uid, r in results.items() if r["clicked_at"] is not None and not r["disqualified"]]
        all_clicked = all(r["clicked_at"] is not None for r in results.values()) if results else True

        if not valid_clicks and not all_clicked:
            return None

        winner_uid = min(valid_clicks, key=lambda item: item[1]["reaction_ms"])[0] if valid_clicks else None

        ranking = []
        for uid in state["players_order"]:
            r = results[uid]
            ranking.append({
                "user_id": int(uid),
                "reaction_ms": r["reaction_ms"],
                "disqualified": r["disqualified"],
            })
        ranking.sort(key=lambda e: (e["disqualified"], e["reaction_ms"] is None, e["reaction_ms"] or 0))

        return {
            "winner_user_id": int(winner_uid) if winner_uid is not None else None,
            "reason": "buzzer",
            "details": {"ranking": ranking},
        }

    @staticmethod
    def reset(state):
        uids = state["players_order"]
        state["phase"] = "countdown"
        state["signal_at"] = time.time() + random.uniform(BUZZER_MIN_DELAY, BUZZER_MAX_DELAY)
        state["results"] = {uid: {"clicked_at": None, "reaction_ms": None, "disqualified": False} for uid in uids}

    @staticmethod
    def on_player_left(state, user_id):
        uid = str(user_id)
        state["results"].pop(uid, None)
        if uid in state["players_order"]:
            state["players_order"].remove(uid)


GAME_ENGINES = {
    "pong": PongEngine,
    "tictactoe": TicTacToeEngine,
    "lightcycles": LightCyclesEngine,
    "buzzer": BuzzerEngine,
}


# ---------- session / lobby management ----------

class GameSession:
    def __init__(self, session_id, engine, host):
        self.id = session_id
        self.engine = engine
        self.game_type = engine.game_type
        self.status = "waiting"  # waiting | playing | over
        self.players = [host]  # [{"user_id", "name", "ws"}]
        self.state = None
        self.task = None

    def player_ids(self):
        return {p["user_id"] for p in self.players}

    def has_ws(self, ws):
        return any(p["ws"] is ws for p in self.players)

    def lobby_summary(self):
        return {
            "id": self.id,
            "game_type": self.game_type,
            "game_name": self.engine.name,
            "emoji": self.engine.emoji,
            "players": [{"id": p["user_id"], "name": p["name"]} for p in self.players],
            "player_count": len(self.players),
            "min_players": self.engine.min_players,
            "max_players": self.engine.max_players,
            "manual_start": self.engine.manual_start,
            "status": self.status,
        }


class GameManager:
    """Owns all active game sessions. `cm` is the chat ConnectionManager,
    reused only for its `send_to`/`broadcast_all` helpers so every websocket
    write goes through the same per-connection lock (chat + game messages
    can otherwise race on the same socket)."""

    def __init__(self, cm):
        self.cm = cm
        self.sessions: dict[str, GameSession] = {}

    def game_types(self):
        return [
            {"game_type": t, "name": e.name, "emoji": e.emoji, "max_players": e.max_players}
            for t, e in GAME_ENGINES.items()
        ]

    def public_lobby(self):
        return [s.lobby_summary() for s in self.sessions.values() if s.status in ("waiting", "playing")]

    async def broadcast_lobby(self):
        await self.cm.broadcast_all({"type": "games_update", "games": self.public_lobby()})

    async def send_to_session(self, session, payload):
        for p in session.players:
            await self.cm.send_to(p["ws"], payload)

    def _active_session_for_ws(self, ws):
        for s in self.sessions.values():
            if s.status in ("waiting", "playing") and s.has_ws(ws):
                return s
        return None

    async def create_session(self, user, ws, game_type):
        engine = GAME_ENGINES.get(game_type)
        if not engine or self._active_session_for_ws(ws):
            return
        session_id = uuid.uuid4().hex[:10]
        host = {"user_id": user["id"], "name": user["name"], "ws": ws}
        session = GameSession(session_id, engine, host)
        self.sessions[session_id] = session
        await self.cm.send_to(ws, {"type": "game_joined", "session_id": session_id, "game_type": game_type})
        await self.broadcast_lobby()

    async def join_session(self, user, ws, session_id):
        if self._active_session_for_ws(ws):
            return
        session = self.sessions.get(session_id)
        if not session or session.status != "waiting" or user["id"] in session.player_ids():
            return
        if len(session.players) >= session.engine.max_players:
            return
        session.players.append({"user_id": user["id"], "name": user["name"], "ws": ws})
        await self.cm.send_to(ws, {"type": "game_joined", "session_id": session_id, "game_type": session.game_type})
        if not session.engine.manual_start and len(session.players) >= session.engine.max_players:
            await self._start_session(session)
        else:
            await self.broadcast_lobby()

    async def start_now(self, user, ws, session_id):
        session = self.sessions.get(session_id)
        if not session or session.status != "waiting" or not session.has_ws(ws):
            return
        if session.players[0]["user_id"] != user["id"]:
            return  # only the host may start the round
        if len(session.players) < session.engine.min_players:
            return
        await self._start_session(session)

    async def _start_session(self, session):
        session.status = "playing"
        session.state = session.engine.init_state(session.players)
        await self.send_to_session(session, {
            "type": "game_started",
            "session_id": session.id,
            "game_type": session.game_type,
            "players": [{"id": p["user_id"], "name": p["name"]} for p in session.players],
            "state": session.state,
        })
        await self.broadcast_lobby()
        if session.engine.tick_interval:
            session.task = asyncio.create_task(self._run_ticks(session))

    async def _run_ticks(self, session):
        try:
            while session.status == "playing":
                await asyncio.sleep(session.engine.tick_interval)
                if session.status != "playing":
                    break
                session.engine.tick(session.state)
                await self.send_to_session(session, {
                    "type": "game_state", "session_id": session.id, "state": session.state,
                })
                result = session.engine.check_finished(session.state)
                if result:
                    await self._finish_session(session, result)
                    break
        except asyncio.CancelledError:
            pass

    async def handle_input(self, user, ws, session_id, payload):
        session = self.sessions.get(session_id)
        if not session or session.status != "playing" or not session.has_ws(ws):
            return
        changed = session.engine.apply_input(session.state, user["id"], payload)
        if session.engine.tick_interval:
            return  # the tick loop drives broadcasts + finish-checks for this game
        if not changed:
            return
        await self.send_to_session(session, {
            "type": "game_state", "session_id": session.id, "state": session.state,
        })
        result = session.engine.check_finished(session.state)
        if result:
            await self._finish_session(session, result)

    async def _finish_session(self, session, result):
        session.status = "over"
        if session.task:
            session.task.cancel()
            session.task = None
        winner_name = None
        if result.get("winner_user_id") is not None:
            winner = next((p for p in session.players if p["user_id"] == result["winner_user_id"]), None)
            winner_name = winner["name"] if winner else None
        payload = {
            "type": "game_over",
            "session_id": session.id,
            "reason": result.get("reason"),
            "winner_user_id": result.get("winner_user_id"),
            "winner_name": winner_name,
        }
        if result.get("details") is not None:
            payload["details"] = result["details"]
        await self.send_to_session(session, payload)
        await self.broadcast_lobby()

    async def handle_rematch(self, user, ws, session_id):
        session = self.sessions.get(session_id)
        if not session or session.status != "over" or not session.has_ws(ws):
            return
        if not hasattr(session.engine, "reset"):
            return
        session.engine.reset(session.state)
        session.status = "playing"
        await self.send_to_session(session, {
            "type": "game_started",
            "session_id": session.id,
            "game_type": session.game_type,
            "players": [{"id": p["user_id"], "name": p["name"]} for p in session.players],
            "state": session.state,
        })
        if session.engine.tick_interval:
            session.task = asyncio.create_task(self._run_ticks(session))

    async def _remove_player(self, session, ws):
        if not session.has_ws(ws):
            return
        was_public = session.status in ("waiting", "playing")
        leaving_mid_game = session.status == "playing"
        leaving_uid = next((p["user_id"] for p in session.players if p["ws"] is ws), None)
        session.players = [p for p in session.players if p["ws"] is not ws]

        if leaving_mid_game:
            if session.state is not None and hasattr(session.engine, "on_player_left"):
                session.engine.on_player_left(session.state, leaving_uid)

            if len(session.players) < session.engine.min_players:
                # Not enough players left to meaningfully continue (always
                # true for a fixed-2-player game like Pong/Tic-Tac-Toe) ->
                # end the match now instead of leaving it stuck.
                if session.task:
                    session.task.cancel()
                    session.task = None
                session.status = "over"
                if session.players:
                    remaining = session.players[0]
                    await self.send_to_session(session, {
                        "type": "game_over",
                        "session_id": session.id,
                        "reason": "opponent_left",
                        "winner_user_id": remaining["user_id"],
                        "winner_name": remaining["name"],
                    })
            # else: enough players remain for a >2-player game (Light Cycles,
            # Buzzer) - the still-running tick loop picks up the engine state
            # change from on_player_left above and resolves the match
            # normally via check_finished on its next tick.

        if not session.players:
            self.sessions.pop(session.id, None)

        if was_public:
            await self.broadcast_lobby()

    async def leave_session(self, user, ws, session_id):
        session = self.sessions.get(session_id)
        if session:
            await self._remove_player(session, ws)

    async def handle_disconnect(self, ws):
        for session in [s for s in self.sessions.values() if s.has_ws(ws)]:
            await self._remove_player(session, ws)
