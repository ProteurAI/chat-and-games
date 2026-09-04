"""Multiplayer minigame engines + session/lobby management.

Every game is a small "engine" class exposing a fixed interface:

    game_type, name, emoji, min_players, max_players  (class attrs)
    tick_interval                                      (seconds, or None for turn-based games)
    init_state(players) -> state
    apply_input(state, user_id, payload) -> bool changed   (mutates state)
    tick(state) -> None                                     (mutates state; only called if tick_interval is set)
    check_finished(state) -> Optional[{"winner_user_id": int|None, "reason": str}]
    reset(state) -> None                                    (optional; enables a "rematch" button)

To add a new game later: write a new engine class implementing the interface
above and register it in GAME_ENGINES. GameSession/GameManager below are
generic and don't need to change.
"""

import asyncio
import random
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


GAME_ENGINES = {
    "pong": PongEngine,
    "tictactoe": TicTacToeEngine,
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
            "max_players": self.engine.max_players,
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
        if len(session.players) >= session.engine.max_players:
            await self._start_session(session)
        else:
            await self.broadcast_lobby()

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
        await self.send_to_session(session, {
            "type": "game_over",
            "session_id": session.id,
            "reason": result.get("reason"),
            "winner_user_id": result.get("winner_user_id"),
            "winner_name": winner_name,
        })
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
        session.players = [p for p in session.players if p["ws"] is not ws]

        if leaving_mid_game:
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
