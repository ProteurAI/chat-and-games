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
    public_state(state, viewer_user_id) -> dict              (optional; for games with hidden information,
                                                              e.g. a player's own hand or ship layout. When
                                                              defined, GameManager sends each player their OWN
                                                              filtered view instead of the one shared `state` -
                                                              other players' private data is never put on that
                                                              player's websocket in the first place. Omit this
                                                              method for fully-public games like Pong.)

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


# ---------- Battleship (Schiffe versenken, 2 players) ----------

BS_GRID = 10
BS_SHIP_SIZES = [5, 4, 3, 3, 2]


def _bs_generate_ships():
    occupied = [[False] * BS_GRID for _ in range(BS_GRID)]
    ships = []
    for size in BS_SHIP_SIZES:
        while True:
            horizontal = random.choice([True, False])
            if horizontal:
                x = random.randint(0, BS_GRID - size)
                y = random.randint(0, BS_GRID - 1)
                cells = [(x + i, y) for i in range(size)]
            else:
                x = random.randint(0, BS_GRID - 1)
                y = random.randint(0, BS_GRID - size)
                cells = [(x, y + i) for i in range(size)]
            if all(not occupied[c[0]][c[1]] for c in cells):
                for c in cells:
                    occupied[c[0]][c[1]] = True
                ships.append(cells)
                break
    return ships


def _bs_parse_cell(cell_str):
    if not isinstance(cell_str, str) or len(cell_str) < 2:
        return None
    col = cell_str[0].upper()
    if col < "A" or col > "J":
        return None
    try:
        row = int(cell_str[1:])
    except ValueError:
        return None
    if not (1 <= row <= BS_GRID):
        return None
    return (ord(col) - ord("A"), row - 1)


class BattleshipEngine:
    game_type = "battleship"
    name = "Schiffe versenken"
    emoji = "🚢"
    min_players = 2
    max_players = 2
    manual_start = False  # fixed exactly-2 game, same auto-start pattern as Pong/Tic-Tac-Toe
    tick_interval = None

    @staticmethod
    def init_state(players):
        uids = [str(p["user_id"]) for p in players]
        return {
            "players_order": uids,
            "ships": {uid: _bs_generate_ships() for uid in uids},
            "shots_fired": {uid: {} for uid in uids},  # uid's own shots against their opponent
            "turn": uids[0],
        }

    @staticmethod
    def apply_input(state, user_id, payload):
        uid = str(user_id)
        if state["turn"] != uid:
            return False
        cell = _bs_parse_cell(payload.get("cell"))
        if cell is None:
            return False
        key = f"{cell[0]},{cell[1]}"
        if key in state["shots_fired"][uid]:
            return False

        opponent_uid = next(u for u in state["players_order"] if u != uid)
        hit_ship = next((ship for ship in state["ships"][opponent_uid] if cell in ship), None)

        if hit_ship is None:
            state["shots_fired"][uid][key] = "miss"
            state["turn"] = opponent_uid
        else:
            state["shots_fired"][uid][key] = "hit"
            ship_keys = [f"{c[0]},{c[1]}" for c in hit_ship]
            if all(state["shots_fired"][uid].get(k) == "hit" for k in ship_keys):
                for k in ship_keys:
                    state["shots_fired"][uid][k] = "sunk"
            # a hit (including a sink) grants the same player another shot
        return True

    @staticmethod
    def tick(state):
        pass

    @staticmethod
    def check_finished(state):
        for uid in state["players_order"]:
            opponent_uid = next(u for u in state["players_order"] if u != uid)
            shots_against_uid = state["shots_fired"][opponent_uid]
            all_cells = [f"{c[0]},{c[1]}" for ship in state["ships"][uid] for c in ship]
            if all(shots_against_uid.get(k) == "sunk" for k in all_cells):
                return {"winner_user_id": int(opponent_uid), "reason": "all_sunk"}
        return None

    @staticmethod
    def public_state(state, viewer_user_id):
        uid = str(viewer_user_id)
        opponent_uid = next((u for u in state["players_order"] if u != uid), None)
        return {
            "grid_size": BS_GRID,
            "turn": state["turn"],
            "own_ships": [[list(c) for c in ship] for ship in state["ships"].get(uid, [])],
            "incoming_shots": state["shots_fired"].get(opponent_uid, {}),
            "outgoing_shots": state["shots_fired"].get(uid, {}),
        }


# ---------- UNO (2-6 players, full 108-card deck, official rules) ----------

UNO_COLORS = ["red", "yellow", "green", "blue"]
UNO_ACTION_VALUES = ("skip", "reverse", "draw2")


def _build_uno_deck():
    deck = []
    cid = 0
    for color in UNO_COLORS:
        deck.append({"id": cid, "color": color, "value": "0"}); cid += 1
        for n in range(1, 10):
            for _ in range(2):
                deck.append({"id": cid, "color": color, "value": str(n)}); cid += 1
        for value in UNO_ACTION_VALUES:
            for _ in range(2):
                deck.append({"id": cid, "color": color, "value": value}); cid += 1
    for _ in range(4):
        deck.append({"id": cid, "color": None, "value": "wild"}); cid += 1
    for _ in range(4):
        deck.append({"id": cid, "color": None, "value": "wild4"}); cid += 1
    return deck  # 4 * (1 + 18 + 2 + 2 + 2) + 4 + 4 = 4*25 + 8 = 108


def _uno_is_playable(card, top_color, top_value):
    if card["value"] in ("wild", "wild4"):
        return True
    return card["color"] == top_color or card["value"] == top_value


def _uno_next_index(state, steps):
    n = len(state["players_order"])
    return (state["turn_index"] + steps * state["direction"]) % n


def _uno_finish_turn(state, steps):
    state["turn_index"] = _uno_next_index(state, steps)
    state["has_drawn"] = False


def _uno_draw_cards(state, uid, n):
    drawn = []
    for _ in range(n):
        if not state["draw_pile"]:
            if len(state["discard_pile"]) <= 1:
                break  # deck fully exhausted (extreme edge case) - nothing left to reshuffle
            top = state["discard_pile"][-1]
            rest = state["discard_pile"][:-1]
            random.shuffle(rest)
            state["draw_pile"] = rest
            state["discard_pile"] = [top]
        card = state["draw_pile"].pop()
        state["hands"][uid].append(card)
        drawn.append(card)
    return drawn


def _uno_close_uno_window(state, acting_uid):
    # The moment the rightful next player begins validly acting, any earlier
    # "must call UNO" vulnerability for someone else is no longer catchable -
    # matches "bevor der naechste Spieler seinen Zug beginnt".
    for uid in list(state["must_call_uno"]):
        if uid != acting_uid:
            state["must_call_uno"].discard(uid)


class UnoEngine:
    game_type = "uno"
    name = "UNO"
    emoji = "🎴"
    min_players = 2
    max_players = 6
    manual_start = True  # variable 2-6 players -> host-triggered start, per the central start-button rule
    tick_interval = None

    @staticmethod
    def init_state(players):
        uids = [str(p["user_id"]) for p in players]
        deck = _build_uno_deck()
        random.shuffle(deck)

        hands = {uid: [] for uid in uids}
        for _ in range(7):
            for uid in uids:
                hands[uid].append(deck.pop())

        # The opening discard card may never be a Wild Draw Four - reshuffle
        # it back in and re-draw until it isn't.
        top = deck.pop()
        while top["value"] == "wild4":
            deck.append(top)
            random.shuffle(deck)
            top = deck.pop()

        state = {
            "players_order": uids,
            "hands": hands,
            "draw_pile": deck,
            "discard_pile": [top],
            "current_color": top["color"],  # None only if top is a plain Wild -> player 0 must choose
            "direction": 1,
            "turn_index": 0,
            "has_drawn": False,
            "must_call_uno": set(),
            "pending_stack": None,  # None, or {"type": "draw2"|"wild4", "count": int}
            "winner": None,
        }

        if top["value"] == "skip":
            state["turn_index"] = _uno_next_index(state, 1)
        elif top["value"] == "reverse":
            state["direction"] = -1
        elif top["value"] == "draw2":
            # Same resolution as any in-game +2: the next player must stack
            # another +2 or take the pile, rather than an immediate draw.
            state["pending_stack"] = {"type": "draw2", "count": 2}
            state["turn_index"] = _uno_next_index(state, 1)
        # top["value"] == "wild": current_color stays None; the first player
        # must send a "choose_start_color" action before anything else.

        return state

    @staticmethod
    def apply_input(state, user_id, payload):
        uid = str(user_id)
        if state["winner"] is not None:
            return False

        action = payload.get("action")

        # "call_uno" / "catch" may be sent by any player at any time,
        # regardless of whose turn it currently is.
        if action == "call_uno":
            if uid in state["must_call_uno"]:
                state["must_call_uno"].discard(uid)
                return True
            return False

        if action == "catch":
            target = str(payload.get("target_user_id"))
            if target != uid and target in state["must_call_uno"]:
                state["must_call_uno"].discard(target)
                _uno_draw_cards(state, target, 2)
                return True
            return False

        current_uid = state["players_order"][state["turn_index"]]
        if current_uid != uid:
            return False

        if state["current_color"] is None:
            if action == "choose_start_color" and payload.get("color") in UNO_COLORS:
                state["current_color"] = payload["color"]
                return True
            return False

        _uno_close_uno_window(state, uid)

        hand = state["hands"][uid]
        top_value = state["discard_pile"][-1]["value"]
        top_color = state["current_color"]
        stack = state["pending_stack"]

        if stack is not None:
            # A +2/+4 chain is running: the only legal moves are stacking
            # another card of the SAME type, or taking the whole pile.
            # +2 and +4 chains never mix (checked via stack["type"]).
            if action == "play":
                card = next((c for c in hand if c["id"] == payload.get("card_id")), None)
                if card is None or card["value"] != stack["type"]:
                    return False
                chosen_color = payload.get("chosen_color")
                if card["value"] == "wild4" and chosen_color not in UNO_COLORS:
                    return False

                hand.remove(card)
                state["discard_pile"].append(card)
                state["current_color"] = chosen_color if card["value"] == "wild4" else card["color"]
                stack["count"] += 2 if card["value"] == "draw2" else 4

                if len(hand) == 1:
                    state["must_call_uno"].add(uid)
                else:
                    state["must_call_uno"].discard(uid)

                if not hand:
                    state["winner"] = uid
                    return True

                _uno_finish_turn(state, 1)
                return True

            if action == "draw":
                _uno_draw_cards(state, uid, stack["count"])
                state["pending_stack"] = None
                _uno_finish_turn(state, 1)
                return True

            return False

        playable = [c for c in hand if _uno_is_playable(c, top_color, top_value)]

        if action == "draw":
            if playable or state["has_drawn"]:
                return False
            drawn = _uno_draw_cards(state, uid, 1)
            state["has_drawn"] = True
            if not (drawn and _uno_is_playable(drawn[0], top_color, top_value)):
                _uno_finish_turn(state, 1)
            return True

        if action == "pass":
            if not state["has_drawn"]:
                return False
            _uno_finish_turn(state, 1)
            return True

        if action == "play":
            card = next((c for c in hand if c["id"] == payload.get("card_id")), None)
            if card is None or not _uno_is_playable(card, top_color, top_value):
                return False
            chosen_color = payload.get("chosen_color")
            if card["value"] in ("wild", "wild4") and chosen_color not in UNO_COLORS:
                return False

            hand.remove(card)
            state["discard_pile"].append(card)
            state["current_color"] = chosen_color if card["value"] in ("wild", "wild4") else card["color"]

            if len(hand) == 1:
                state["must_call_uno"].add(uid)
            else:
                state["must_call_uno"].discard(uid)

            if not hand:
                state["winner"] = uid
                return True

            if card["value"] == "skip":
                _uno_finish_turn(state, 2)
            elif card["value"] == "reverse":
                state["direction"] *= -1
                _uno_finish_turn(state, 1 if len(state["players_order"]) > 2 else 0)
            elif card["value"] == "draw2":
                # Starts a new +2 chain instead of an immediate draw - the
                # next player must stack or take the (currently 2-card) pile.
                state["pending_stack"] = {"type": "draw2", "count": 2}
                _uno_finish_turn(state, 1)
            elif card["value"] == "wild4":
                state["pending_stack"] = {"type": "wild4", "count": 4}
                _uno_finish_turn(state, 1)
            else:
                _uno_finish_turn(state, 1)
            return True

        return False

    @staticmethod
    def tick(state):
        pass

    @staticmethod
    def check_finished(state):
        if state["winner"] is not None:
            return {"winner_user_id": int(state["winner"]), "reason": "out_of_cards"}
        return None

    @staticmethod
    def public_state(state, viewer_user_id):
        uid = str(viewer_user_id)
        return {
            "players_order": state["players_order"],
            "hand": state["hands"].get(uid, []),
            "hand_counts": {u: len(h) for u, h in state["hands"].items()},
            "top_card": state["discard_pile"][-1] if state["discard_pile"] else None,
            "current_color": state["current_color"],
            "turn_index": state["turn_index"],
            "direction": state["direction"],
            "has_drawn": state["has_drawn"] if state["players_order"][state["turn_index"]] == uid else False,
            "must_call_uno": list(state["must_call_uno"]),
            "draw_pile_count": len(state["draw_pile"]),
            "awaiting_start_color": state["current_color"] is None,
            "pending_stack": state["pending_stack"],
        }

    @staticmethod
    def reset(state):
        fresh = UnoEngine.init_state([{"user_id": int(uid)} for uid in state["players_order"]])
        state.clear()
        state.update(fresh)


# ---------- Mensch aergere Dich nicht (2-4 players, fully public state) ----------
#
# Per-piece position is a single integer "steps" value:
#   -1        -> still waiting in the yard
#   0..39     -> steps taken along the shared 40-cell ring since entering
#                (absolute ring cell = (LUDO_ENTRY[color] + steps) % 40)
#   40..43    -> steps into the color's own private 4-cell home stretch
#   44        -> home (finished)
# No hidden information at all here, so (unlike Battleship/UNO) this engine
# does not define public_state - the one shared `state` goes to everyone.

LUDO_COLORS = ["red", "blue", "yellow", "green"]
LUDO_ENTRY = {"red": 0, "blue": 10, "yellow": 20, "green": 30}
LUDO_HOME_STEPS = 44


class LudoEngine:
    game_type = "ludo"
    name = "Mensch ärgere dich nicht"
    emoji = "🎲"
    min_players = 2
    max_players = 4
    manual_start = True  # variable 2-4 players, same pattern as Light Cycles/UNO
    tick_interval = None

    @staticmethod
    def init_state(players):
        player_colors = {}
        for i, p in enumerate(players):
            player_colors[str(p["user_id"])] = LUDO_COLORS[i]
        pieces = {color: [{"steps": -1} for _ in range(4)] for color in LUDO_COLORS}
        return {
            "players_order": [str(p["user_id"]) for p in players],
            "player_colors": player_colors,
            "active_colors": LUDO_COLORS[: len(players)],
            "pieces": pieces,
            "turn_index": 0,
            "dice": None,
            "dice_owner": None,
            "dice_had_moves": False,
            "awaiting_move": False,
            "movable_pieces": [],
            "winner": None,
            "last_event": None,
        }

    @staticmethod
    def _own_ring_occupied(pieces, entry, abs_pos, exclude_idx):
        for j, p in enumerate(pieces):
            if j == exclude_idx:
                continue
            if 0 <= p["steps"] <= 39 and (entry + p["steps"]) % 40 == abs_pos:
                return True
        return False

    @staticmethod
    def _own_home_occupied(pieces, home_steps, exclude_idx):
        for j, p in enumerate(pieces):
            if j == exclude_idx:
                continue
            if p["steps"] == home_steps:
                return True
        return False

    @staticmethod
    def _available_moves(state, color, roll):
        pieces = state["pieces"][color]
        entry = LUDO_ENTRY[color]
        moves = []
        for i, piece in enumerate(pieces):
            steps = piece["steps"]
            if steps == LUDO_HOME_STEPS:
                continue
            if steps == -1:
                if roll == 6 and not LudoEngine._own_ring_occupied(pieces, entry, entry, i):
                    moves.append({"piece": i, "new_steps": 0})
                continue
            new_steps = steps + roll
            if new_steps > LUDO_HOME_STEPS:
                continue
            if new_steps <= 39:
                abs_pos = (entry + new_steps) % 40
                if LudoEngine._own_ring_occupied(pieces, entry, abs_pos, i):
                    continue
            elif new_steps <= 43:
                if LudoEngine._own_home_occupied(pieces, new_steps, i):
                    continue
            moves.append({"piece": i, "new_steps": new_steps})
        return moves

    @staticmethod
    def _advance_turn(state):
        # Deliberately does NOT clear state["dice"]/"dice_owner" - the just
        # -rolled value must stay visible (attributed to whoever rolled it,
        # via dice_owner) until the next roll overwrites it, even when that
        # roll turns out to have no legal move and the turn passes in the
        # same instant. Clearing it here used to silently wipe the number
        # before the single post-input broadcast ever went out, so a roll
        # with no usable move (the common "need a 6" case) was never seen
        # by anyone.
        n = len(state["players_order"])
        state["turn_index"] = (state["turn_index"] + 1) % n
        state["awaiting_move"] = False
        state["movable_pieces"] = []

    @staticmethod
    def apply_input(state, user_id, payload):
        uid = str(user_id)
        if state["winner"] is not None:
            return False
        if not state["players_order"] or state["players_order"][state["turn_index"]] != uid:
            return False
        color = state["player_colors"].get(uid)
        if color is None:
            return False
        action = payload.get("action")

        if action == "roll":
            if state["awaiting_move"]:
                return False
            state["dice"] = random.randint(1, 6)
            state["dice_owner"] = uid
            state["last_event"] = None
            moves = LudoEngine._available_moves(state, color, state["dice"])
            state["dice_had_moves"] = bool(moves)
            if moves:
                state["awaiting_move"] = True
                # Sent to everyone (this game has no hidden info at all) so
                # the frontend can highlight exactly which of the current
                # player's pieces are legally clickable, using the same
                # rule-check the server just ran - no separate copy of the
                # move-legality rules needs to live in the frontend too.
                state["movable_pieces"] = [m["piece"] for m in moves]
            else:
                state["movable_pieces"] = []
                if state["dice"] != 6:
                    LudoEngine._advance_turn(state)
            # else: rolled a 6 with no usable move -> same player rolls again
            # (awaiting_move stays False, dice stays visible until next roll)
            return True

        if action == "move":
            if not state["awaiting_move"]:
                return False
            moves = LudoEngine._available_moves(state, color, state["dice"])
            move = next((m for m in moves if m["piece"] == payload.get("piece_index")), None)
            if move is None:
                return False

            piece = state["pieces"][color][move["piece"]]
            piece["steps"] = move["new_steps"]
            state["last_event"] = None
            if move["new_steps"] <= 39:
                abs_pos = (LUDO_ENTRY[color] + move["new_steps"]) % 40
                for other_color in state["active_colors"]:
                    if other_color == color:
                        continue
                    for op in state["pieces"][other_color]:
                        if 0 <= op["steps"] <= 39 and (LUDO_ENTRY[other_color] + op["steps"]) % 40 == abs_pos:
                            op["steps"] = -1
                            state["last_event"] = {"type": "capture", "color": color, "victim_color": other_color}

            state["awaiting_move"] = False
            state["movable_pieces"] = []

            if all(p["steps"] == LUDO_HOME_STEPS for p in state["pieces"][color]):
                state["winner"] = uid
                return True

            rolled_six = state["dice"] == 6
            if not rolled_six:
                LudoEngine._advance_turn(state)
            # else: same player continues and must roll again - dice/dice_owner
            # are left as-is (showing the 6 they just used) until that next roll
            return True

        return False

    @staticmethod
    def tick(state):
        pass

    @staticmethod
    def check_finished(state):
        if state["winner"] is not None:
            return {"winner_user_id": int(state["winner"]), "reason": "all_home"}
        return None

    @staticmethod
    def on_player_left(state, user_id):
        uid = str(user_id)
        if uid not in state["players_order"]:
            return
        idx = state["players_order"].index(uid)
        state["players_order"].remove(uid)
        if not state["players_order"]:
            return
        n = len(state["players_order"])
        if idx < state["turn_index"]:
            state["turn_index"] -= 1
        elif idx == state["turn_index"]:
            state["turn_index"] %= n
            state["dice"] = None
            state["dice_owner"] = None
            state["dice_had_moves"] = False
            state["awaiting_move"] = False
            state["movable_pieces"] = []
        # the departed player's pieces are simply left in place, frozen -
        # their color is never taken again since players_order no longer
        # includes them.


GAME_ENGINES = {
    "pong": PongEngine,
    "tictactoe": TicTacToeEngine,
    "lightcycles": LightCyclesEngine,
    "buzzer": BuzzerEngine,
    "battleship": BattleshipEngine,
    "uno": UnoEngine,
    "ludo": LudoEngine,
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

    async def _send_state(self, session, msg_type, extra=None):
        """Broadcast the current engine state as `msg_type`. For engines that
        define public_state(), each player gets their OWN filtered view sent
        directly to their socket (their private data, e.g. an UNO hand or
        Battleship ship layout, never touches another player's connection at
        all); other engines just get the one shared state as before."""
        extra = extra or {}
        engine = session.engine
        if hasattr(engine, "public_state"):
            for p in session.players:
                payload = {
                    "type": msg_type,
                    "session_id": session.id,
                    "state": engine.public_state(session.state, p["user_id"]),
                    **extra,
                }
                await self.cm.send_to(p["ws"], payload)
        else:
            await self.send_to_session(session, {
                "type": msg_type, "session_id": session.id, "state": session.state, **extra,
            })

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
        await self._send_state(session, "game_started", {
            "game_type": session.game_type,
            "players": [{"id": p["user_id"], "name": p["name"]} for p in session.players],
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
                await self._send_state(session, "game_state")
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
        await self._send_state(session, "game_state")
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
        await self._send_state(session, "game_started", {
            "game_type": session.game_type,
            "players": [{"id": p["user_id"], "name": p["name"]} for p in session.players],
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
