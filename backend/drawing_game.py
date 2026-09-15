"""Kritzelmeister - live drawing-and-guessing multiplayer party game.

Implements the same engine interface documented at the top of games.py
(init_state/apply_input/tick/check_finished/reset/on_player_left/
public_state) so the round flow (drawer rotation, word choice, timer,
guessing, scoring, standings, endscreen) plugs into the existing generic
GameSession/GameManager completely unchanged - same pattern as
majority_game.py/know_me.py/who_am_i.py.

Live drawing itself is deliberately NOT part of that generic state/tick
broadcast path: canvas strokes are high-frequency (a drawer's pointer can
move dozens of times a second) and would make the periodic public_state()
broadcast (sent to up to 12 players) far too large if replayed on every
tick. Instead this module exposes a handful of plain async functions
(handle_stroke_start/handle_stroke_batch/handle_stroke_end/handle_undo/
handle_clear/handle_request_sync) that main.py's websocket loop calls
directly for their own namespaced drawing_* message types - each looks up
the caller's active session via GameManager.get_session_for_ws() (the same
public accessor backend/party.py already uses for its own loosely-coupled
relay) and either mutates the round's authoritative stroke list (kept in
session.state["strokes"], never lost between broadcasts) and relays a
small delta to every OTHER player immediately, or - for handle_request_sync
- sends the full current stroke list back to just the requester. This is
also exactly the mechanism a client uses to reconstruct the canvas after
briefly losing frame-perfect sync (a missed relay, or a fresh websocket
after a reconnect that's still an active session member) - see the module
docstring further down.

SECURITY: the secret word is the single most sensitive piece of state in
this game. It is stored once in session.state and only ever reaches a
websocket in one of exactly two functions below (public_state, and the
guess-scoring path inside apply_input) - and only for the current drawer,
or a guesser who has ALREADY guessed correctly, or every player once the
round is in "reveal". Every other phase strips it down to a length/blank
pattern with a small number of server-chosen revealed letters. Candidate
words offered before a pick is made are similarly drawer-only.

The word bank lives in backend/data/drawing_words.json, loaded and
validated once at import time (see validate_word_bank(), reused verbatim
by validate_drawing_words.py so the two never disagree on what "valid"
means).
"""

import json
import random
import re
import time
from pathlib import Path

WORDS_PATH = Path(__file__).resolve().parent / "data" / "drawing_words.json"

VALID_CATEGORIES = {
    "animals": "Tiere", "food": "Essen & Trinken", "home": "Alltag & Gegenstände",
    "vehicles": "Fahrzeuge", "sport": "Sport", "nature": "Orte & Natur",
    "film": "Film & Popkultur", "jobs": "Berufe", "party": "Freizeit & Party",
    "concepts": "Begriffe & Situationen", "fantasy": "Fantasie", "crazy": "Verrücktes",
    "space": "Weltraum", "music": "Musik",
}
MIN_WORD_BANK_SIZE = 600


def validate_word_bank(raw):
    """Checks the raw (already-JSON-parsed) word list for the invariants
    the game logic below relies on. Returns the cleaned list of word dicts
    on success; raises ValueError (listing every problem found, not just
    the first) on failure. Shared verbatim by validate_drawing_words.py."""
    errors = []
    seen_ids = set()
    seen_words = set()
    words = []

    if not isinstance(raw, list):
        raise ValueError("drawing_words.json must contain a JSON array")

    for i, w in enumerate(raw):
        prefix = f"[index {i}, id={w.get('id') if isinstance(w, dict) else '?'}]"
        if not isinstance(w, dict):
            errors.append(f"{prefix}: not an object")
            continue

        wid = w.get("id")
        if not isinstance(wid, str) or not wid:
            errors.append(f"{prefix}: missing/invalid id")
            continue
        if wid in seen_ids:
            errors.append(f"{prefix}: duplicate id '{wid}'")
            continue

        word_text = (w.get("word") or "").strip()
        if not word_text:
            errors.append(f"{prefix}: missing word text")
            continue
        norm = word_text.lower()
        if norm in seen_words:
            errors.append(f"{prefix}: duplicate word '{word_text}'")
            continue

        category = w.get("category")
        if category not in VALID_CATEGORIES:
            errors.append(f"{prefix}: invalid category '{category}'")
            continue

        difficulty = w.get("difficulty")
        if difficulty not in (1, 2, 3):
            errors.append(f"{prefix}: invalid difficulty '{difficulty}'")
            continue

        aliases = w.get("aliases", [])
        if not isinstance(aliases, list) or any(not isinstance(a, str) or not a.strip() for a in aliases):
            errors.append(f"{prefix}: invalid/empty alias entry")
            continue

        seen_ids.add(wid)
        seen_words.add(norm)
        words.append({
            "id": wid, "word": word_text, "aliases": [a.strip() for a in aliases],
            "category": category, "difficulty": difficulty,
        })

    if errors:
        raise ValueError(
            f"drawing_words.json validation failed ({len(errors)} problem(s)):\n"
            + "\n".join(errors[:50])
            + ("\n... (truncated)" if len(errors) > 50 else "")
        )
    if len(words) < MIN_WORD_BANK_SIZE:
        raise ValueError(
            f"drawing_words.json has only {len(words)} valid words, need at least {MIN_WORD_BANK_SIZE}"
        )
    return words


def _load_word_bank():
    with open(WORDS_PATH, encoding="utf-8") as f:
        raw = json.load(f)
    words = validate_word_bank(raw)
    by_cat = {}
    for w in words:
        by_cat[w["category"]] = by_cat.get(w["category"], 0) + 1
    print(f"[drawing_game] Word bank loaded OK. Total Drawing Words: {len(words)}")
    for cat in VALID_CATEGORIES:
        print(f"[drawing_game]   {VALID_CATEGORIES[cat]} ({cat}): {by_cat.get(cat, 0)}")
    return words


WORD_BANK = _load_word_bank()
WORDS_BY_DIFFICULTY = {d: [w for w in WORD_BANK if w["difficulty"] == d] for d in (1, 2, 3)}


# ---------- round timing / scoring constants ----------

CHOOSE_SECONDS = 10
DEFAULT_DRAW_SECONDS = 80
VALID_DRAW_SECONDS = {60, 80, 100}
CHAOS_DRAW_SECONDS = 20
REVEAL_SECONDS = 5
STANDINGS_SECONDS = 4
ALL_CORRECT_GRACE_SECONDS = 1.0
HINT_1_FRACTION = 0.40
HINT_2_FRACTION = 0.70

DEFAULT_ROUNDS_PER_PLAYER = 2
VALID_ROUNDS_PER_PLAYER = {1, 2, 3}

GUESS_BASE_POINTS = 300
GUESS_TIME_BONUS_MAX = 700
GUESS_FIRST_BONUS = 100
DRAWER_POINTS_PER_GUESSER = 150
DRAWER_BONUS_MAJORITY = 200
DRAWER_BONUS_MAJORITY_FRACTION = 0.75
CHAOS_GUESS_BONUS = 100
CHAOS_DRAWER_BONUS = 100

GUESS_MAX_LEN = 80
MAX_GUESS_FEED = 60
MAX_GUESS_FEED_SENT = 25
GUESS_RATE_WINDOW = 1.0
GUESS_RATE_MAX = 3

ONE_STROKE_BUDGET = 3
SPECIAL_ROUND_TYPES = ["chaos", "one_stroke", "blind"]
SPECIAL_ROUND_MIN_GAP = 4
SPECIAL_ROUND_MAX_GAP = 5

ALLOWED_COLORS = {"#000000", "#e53935", "#1e88e5", "#43a047", "#fdd835", "#fb8c00", "#8e24aa"}
ALLOWED_WIDTHS = {3, 6, 12}
ALLOWED_TOOLS = {"pen", "eraser"}
MAX_POINTS_PER_BATCH = 60
MAX_POINTS_PER_STROKE = 600
MAX_STROKES_PER_ROUND = 500


def _sanitize_options(options):
    options = options if isinstance(options, dict) else {}
    rpp = options.get("rounds_per_player")
    if rpp not in VALID_ROUNDS_PER_PLAYER:
        rpp = DEFAULT_ROUNDS_PER_PLAYER
    ds = options.get("draw_seconds")
    if ds not in VALID_DRAW_SECONDS:
        ds = DEFAULT_DRAW_SECONDS
    return {"rounds_per_player": rpp, "draw_seconds": ds}


# ---------- fair drawer rotation + special-round plan ----------

def _build_drawer_sequence(uids, rounds_per_player):
    """Shuffle the player order exactly once, then repeat that SAME order
    for each of rounds_per_player laps - every player draws exactly
    rounds_per_player times, and turn order stays predictable/fair lap to
    lap rather than being re-rolled (which could cluster someone's turns)."""
    order = list(uids)
    random.shuffle(order)
    sequence = []
    for _ in range(rounds_per_player):
        sequence.extend(order)
    return sequence


def _build_special_round_plan(total_rounds):
    """None for every round by default; every 4th-5th round (never the
    first) gets a random special mode, never the same one twice in a row."""
    plan = [None] * total_rounds
    if total_rounds <= 1:
        return plan
    last_type = None
    since_last = 0
    for i in range(1, total_rounds):
        since_last += 1
        threshold = random.choice([SPECIAL_ROUND_MIN_GAP, SPECIAL_ROUND_MAX_GAP])
        if since_last >= threshold:
            choices = [t for t in SPECIAL_ROUND_TYPES if t != last_type]
            chosen = random.choice(choices)
            plan[i] = chosen
            last_type = chosen
            since_last = 0
    return plan


def _pick_candidates(used_ids):
    """Three candidates per round, one from each difficulty tier when the
    bank still has fresh words left in that tier (falls back to allowing a
    repeat within the SAME match only if a tier is fully exhausted, which
    only happens in an extremely long match)."""
    result = []
    for diff in (1, 2, 3):
        pool = [w for w in WORDS_BY_DIFFICULTY[diff] if w["id"] not in used_ids]
        if not pool:
            pool = WORDS_BY_DIFFICULTY[diff]
        result.append(random.choice(pool))
    random.shuffle(result)
    return result


# ---------- guess normalization / matching ----------

def _normalize_guess(text):
    t = (text or "").strip().lower()
    t = t.replace("ß", "ss")
    t = re.sub(r"[.!?,;:]+$", "", t)
    t = re.sub(r"\s+", " ", t)
    return t


def _word_candidates(word_record):
    return [word_record["word"]] + list(word_record.get("aliases", []))


def _matches_word(normalized, word_record):
    return normalized in {_normalize_guess(c) for c in _word_candidates(word_record)}


def _levenshtein(a, b):
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    return prev[-1]


def _is_near_miss(normalized, word_record):
    if not normalized:
        return False
    for c in _word_candidates(word_record):
        nc = _normalize_guess(c)
        max_dist = 1 if len(nc) <= 8 else 2
        dist = _levenshtein(normalized, nc)
        if 0 < dist <= max_dist:
            return True
    return False


def _check_rate_limit(state, uid, now):
    log = state["guess_timestamps"].setdefault(uid, [])
    log[:] = [t for t in log if now - t < GUESS_RATE_WINDOW]
    if len(log) >= GUESS_RATE_MAX:
        return False
    log.append(now)
    return True


def _word_pattern(word, revealed_positions):
    parts = []
    for i, ch in enumerate(word):
        if ch == " ":
            parts.append("")
        elif i in revealed_positions:
            parts.append(ch.upper())
        else:
            parts.append("_")
    return " ".join(parts)


# ---------- round lifecycle ----------

def _new_stats():
    return {"correct_count": 0, "wrong_count": 0, "first_guess_count": 0, "drawer_rounds": 0, "drawer_success_sum": 0.0}


def _start_round(state, idx, now):
    state["round_index"] = idx
    state["drawer_user_id"] = state["drawer_sequence"][idx]
    state["special_round"] = state["special_round_plan"][idx]
    state["candidate_words"] = _pick_candidates(state["used_word_ids"])
    for w in state["candidate_words"]:
        state["used_word_ids"].append(w["id"])
    state["current_word"] = None
    state["phase"] = "choosing"
    state["choice_deadline"] = now + CHOOSE_SECONDS
    state["guesses"] = []
    state["correct_uids"] = []
    state["all_correct_at"] = None
    state["strokes"] = []
    state["strokes_version"] = 0
    state["revealed_positions"] = []
    state["hint_1_done"] = False
    state["hint_2_done"] = False
    state["one_stroke_budget"] = ONE_STROKE_BUDGET if state["special_round"] == "one_stroke" else None
    state["draw_start_time"] = None
    state["draw_end_time"] = None
    state["scores_at_round_start"] = dict(state["scores"])
    state["round_points_delta"] = {}


def _begin_drawing(state, candidate, now):
    state["current_word"] = candidate
    state["phase"] = "drawing"
    duration = CHAOS_DRAW_SECONDS if state["special_round"] == "chaos" else state["options"]["draw_seconds"]
    state["draw_start_time"] = now
    state["draw_end_time"] = now + duration


def _reveal_hint_letter(state):
    word = state["current_word"]["word"]
    candidates = [i for i, ch in enumerate(word) if ch != " " and i not in state["revealed_positions"]]
    if not candidates:
        return
    state["revealed_positions"].append(random.choice(candidates))


def _process_guess(state, uid, text, now):
    word = state["current_word"]
    normalized = _normalize_guess(text)
    is_correct = bool(normalized) and _matches_word(normalized, word)

    if is_correct:
        state["correct_uids"].append(uid)
        total = state["draw_end_time"] - state["draw_start_time"]
        remaining = max(0.0, state["draw_end_time"] - now)
        frac_remaining = (remaining / total) if total > 0 else 0.0
        points = GUESS_BASE_POINTS + round(GUESS_TIME_BONUS_MAX * frac_remaining)
        is_first = len(state["correct_uids"]) == 1
        if is_first:
            points += GUESS_FIRST_BONUS
        if state["special_round"] == "chaos":
            points += CHAOS_GUESS_BONUS
        state["scores"][uid] = state["scores"].get(uid, 0) + points

        st = state["stats"].setdefault(uid, _new_stats())
        st["correct_count"] += 1
        if is_first:
            st["first_guess_count"] += 1

        active_guessers = [u for u in state["player_order"] if state["active"].get(u) and u != str(state["drawer_user_id"])]
        if active_guessers and all(u in state["correct_uids"] for u in active_guessers) and state["all_correct_at"] is None:
            state["all_correct_at"] = now

        state["guesses"].append({"userId": int(uid), "text": None, "correct": True, "near": False, "at": now})
    else:
        st = state["stats"].setdefault(uid, _new_stats())
        st["wrong_count"] += 1
        near = _is_near_miss(normalized, word)
        state["guesses"].append({"userId": int(uid), "text": text, "correct": False, "near": near, "at": now})

    if len(state["guesses"]) > MAX_GUESS_FEED:
        state["guesses"] = state["guesses"][-MAX_GUESS_FEED:]


def _finalize_drawing_round(state, now, reason):
    drawer_uid = str(state["drawer_user_id"])
    active_guessers = [u for u in state["player_order"] if state["active"].get(u) and u != drawer_uid]
    n_correct = len(state["correct_uids"])
    n_total = len(active_guessers)

    drawer_points = n_correct * DRAWER_POINTS_PER_GUESSER
    if n_total > 0 and (n_correct / n_total) >= DRAWER_BONUS_MAJORITY_FRACTION:
        drawer_points += DRAWER_BONUS_MAJORITY
    if state["special_round"] == "chaos":
        drawer_points += CHAOS_DRAWER_BONUS
    state["scores"][drawer_uid] = state["scores"].get(drawer_uid, 0) + drawer_points

    dst = state["stats"].setdefault(drawer_uid, _new_stats())
    dst["drawer_rounds"] += 1
    dst["drawer_success_sum"] += (n_correct / n_total) if n_total > 0 else 0.0

    word = state["current_word"]
    state["round_history"].append({
        "drawerUserId": int(drawer_uid), "drawerName": state["player_names"].get(drawer_uid, "?"),
        "word": word["word"], "category": word["category"], "difficulty": word["difficulty"],
        "correctCount": n_correct, "totalGuessers": n_total, "drawerPoints": drawer_points,
        "special": state["special_round"], "reason": reason,
    })
    state["round_points_delta"] = {
        u: state["scores"].get(u, 0) - state["scores_at_round_start"].get(u, 0) for u in state["player_order"]
    }

    state["phase"] = "reveal"
    state["phase_deadline"] = now + REVEAL_SECONDS


def _advance_round_or_finish(state, now):
    next_idx = state["round_index"] + 1
    if next_idx >= state["total_rounds"]:
        state["phase"] = "finished"
        state["phase_deadline"] = None
        return
    if state["phase"] == "reveal":
        n_players = len(state["player_order"])
        if n_players and next_idx % n_players == 0:
            state["phase"] = "standings"
            state["phase_deadline"] = now + STANDINGS_SECONDS
            return
    _start_round(state, next_idx, now)


def _build_endscreen(state):
    active_uids = [u for u in state["player_order"] if state["active"].get(u)]
    leaderboard = sorted(
        ({"userId": int(u), "name": state["player_names"].get(u, "?"), "score": state["scores"].get(u, 0)} for u in active_uids),
        key=lambda e: -e["score"],
    )

    fastest = artist = mind_reader = undiscovered = guess_machine = None
    for u in active_uids:
        st = state["stats"].get(u)
        if not st:
            continue
        name = state["player_names"].get(u, "?")
        if st["first_guess_count"] > 0 and (fastest is None or st["first_guess_count"] > fastest["value"]):
            fastest = {"userId": int(u), "name": name, "value": st["first_guess_count"]}
        if st["drawer_rounds"] > 0:
            avg = st["drawer_success_sum"] / st["drawer_rounds"]
            if artist is None or avg > artist["value"]:
                artist = {"userId": int(u), "name": name, "value": avg}
            if undiscovered is None or avg < undiscovered["value"]:
                undiscovered = {"userId": int(u), "name": name, "value": avg}
        total_guesses = st["correct_count"] + st["wrong_count"]
        if total_guesses > 0:
            rate = st["correct_count"] / total_guesses
            if mind_reader is None or rate > mind_reader["value"]:
                mind_reader = {"userId": int(u), "name": name, "value": rate}
        if st["wrong_count"] > 0 and (guess_machine is None or st["wrong_count"] > guess_machine["value"]):
            guess_machine = {"userId": int(u), "name": name, "value": st["wrong_count"]}

    fun_stats = {}
    if fastest:
        fun_stats["fastest"] = {"userId": fastest["userId"], "name": fastest["name"], "label": "⚡ Schnellrater", "detail": f"{fastest['value']}x als Erste(r) richtig"}
    if artist:
        fun_stats["artist"] = {"userId": artist["userId"], "name": artist["name"], "label": "🎨 Künstler", "detail": f"{round(artist['value'] * 100)}% der Rater haben's erkannt"}
    if mind_reader:
        fun_stats["mindReader"] = {"userId": mind_reader["userId"], "name": mind_reader["name"], "label": "🧠 Gedankenleser", "detail": f"{round(mind_reader['value'] * 100)}% Trefferquote"}
    if undiscovered and undiscovered["value"] < 0.5 and (artist is None or undiscovered["userId"] != artist["userId"]):
        fun_stats["undiscovered"] = {"userId": undiscovered["userId"], "name": undiscovered["name"], "label": "😵 Unerkanntes Genie", "detail": "besonders wenige haben's erraten"}
    if guess_machine:
        fun_stats["guessMachine"] = {"userId": guess_machine["userId"], "name": guess_machine["name"], "label": "😂 Ratemaschine", "detail": f"{guess_machine['value']}x danebengetippt"}

    return {"leaderboard": leaderboard, "funStats": fun_stats, "totalRounds": state["total_rounds"]}


class DrawingGameEngine:
    game_type = "kritzelmeister"
    name = "Kritzelmeister"
    emoji = "🎨"
    min_players = 3
    max_players = 12
    manual_start = True
    tick_interval = 0.5

    @staticmethod
    def init_state(players, options=None):
        opts = _sanitize_options(options)
        uids = [str(p["user_id"]) for p in players]
        drawer_sequence = _build_drawer_sequence([p["user_id"] for p in players], opts["rounds_per_player"])
        total_rounds = len(drawer_sequence)

        state = {
            "options": opts,
            "player_order": uids,
            "player_names": {str(p["user_id"]): p["name"] for p in players},
            "active": {uid: True for uid in uids},
            "scores": {uid: 0 for uid in uids},
            "stats": {uid: _new_stats() for uid in uids},
            "drawer_sequence": drawer_sequence,
            "total_rounds": total_rounds,
            "special_round_plan": _build_special_round_plan(total_rounds),
            "used_word_ids": [],
            "round_history": [],
            "guess_timestamps": {},
            "phase": "choosing",
            "phase_deadline": None,
        }
        _start_round(state, 0, time.time())
        return state

    @staticmethod
    def apply_input(state, user_id, payload):
        uid = str(user_id)
        action = payload.get("action")

        if action == "select_word":
            if state["phase"] != "choosing" or state["drawer_user_id"] != user_id:
                return False
            word_id = payload.get("word_id")
            candidate = next((w for w in state["candidate_words"] if w["id"] == word_id), None)
            if not candidate:
                return False
            _begin_drawing(state, candidate, time.time())
            return False

        if action == "guess":
            if state["phase"] != "drawing" or uid == str(state["drawer_user_id"]):
                return False
            if not state["active"].get(uid, False):
                return False
            if uid in state["correct_uids"]:
                return False
            text = (payload.get("text") or "")
            if not isinstance(text, str) or not text.strip():
                return False
            text = text[:GUESS_MAX_LEN]
            if not _check_rate_limit(state, uid, time.time()):
                return False
            _process_guess(state, uid, text, time.time())
            return False

        return False

    @staticmethod
    def tick(state):
        now = time.time()
        phase = state["phase"]

        if phase == "choosing":
            if now >= state["choice_deadline"]:
                _begin_drawing(state, state["candidate_words"][0], now)

        elif phase == "drawing":
            total = state["draw_end_time"] - state["draw_start_time"]
            elapsed = now - state["draw_start_time"]
            frac = (elapsed / total) if total > 0 else 1
            if not state["hint_1_done"] and frac >= HINT_1_FRACTION:
                _reveal_hint_letter(state)
                state["hint_1_done"] = True
            if not state["hint_2_done"] and frac >= HINT_2_FRACTION:
                _reveal_hint_letter(state)
                state["hint_2_done"] = True

            if state["all_correct_at"] is not None and now - state["all_correct_at"] >= ALL_CORRECT_GRACE_SECONDS:
                _finalize_drawing_round(state, now, "all_correct")
            elif now >= state["draw_end_time"]:
                _finalize_drawing_round(state, now, "timeout")

        elif phase in ("reveal", "standings"):
            if state["phase_deadline"] is not None and now >= state["phase_deadline"]:
                _advance_round_or_finish(state, now)

    @staticmethod
    def check_finished(state):
        if state["phase"] != "finished":
            return None
        endscreen = _build_endscreen(state)
        winner_uid = endscreen["leaderboard"][0]["userId"] if endscreen["leaderboard"] else None
        return {"winner_user_id": winner_uid, "reason": "kritzelmeister_finished", "details": endscreen}

    @staticmethod
    def on_player_left(state, user_id):
        uid = str(user_id)
        if uid not in state["active"]:
            return
        state["active"][uid] = False
        if state["phase"] in ("choosing", "drawing") and uid == str(state["drawer_user_id"]):
            # No drawer left to pick a word / keep drawing, and this app
            # has no player-reconnect-into-same-session mechanism for any
            # game (see module docstring) - waiting on them can never
            # resolve, so end this round immediately with no points and
            # move on cleanly instead of stalling everyone else.
            now = time.time()
            word = state["current_word"]
            state["round_history"].append({
                "drawerUserId": int(uid), "drawerName": state["player_names"].get(uid, "?"),
                "word": word["word"] if word else None, "category": word["category"] if word else None,
                "difficulty": word["difficulty"] if word else None,
                "correctCount": len(state["correct_uids"]), "totalGuessers": 0, "drawerPoints": 0,
                "special": state["special_round"], "reason": "drawer_left",
            })
            state["round_points_delta"] = {}
            state["phase"] = "reveal"
            state["phase_deadline"] = now + REVEAL_SECONDS

    @staticmethod
    def reset(state):
        active_uids = [u for u in state["player_order"] if state["active"].get(u)]
        opts = state["options"]
        drawer_sequence = _build_drawer_sequence([int(u) for u in active_uids], opts["rounds_per_player"])
        state["player_order"] = active_uids
        state["scores"] = {u: 0 for u in active_uids}
        state["stats"] = {u: _new_stats() for u in active_uids}
        state["drawer_sequence"] = drawer_sequence
        state["total_rounds"] = len(drawer_sequence)
        state["special_round_plan"] = _build_special_round_plan(state["total_rounds"])
        # keep avoiding this match's words on rematch too, per spec
        state["round_history"] = []
        state["guess_timestamps"] = {}
        _start_round(state, 0, time.time())

    @staticmethod
    def public_state(state, viewer_user_id):
        uid = str(viewer_user_id)
        now = time.time()
        phase = state["phase"]
        is_drawer = uid == str(state["drawer_user_id"])
        am_correct = uid in state["correct_uids"]

        base = {
            "phase": phase,
            "roundIndex": state["round_index"] + 1,
            "totalRounds": state["total_rounds"],
            "isDrawer": is_drawer,
            "drawerUserId": int(state["drawer_user_id"]),
            "drawerName": state["player_names"].get(str(state["drawer_user_id"]), "?"),
            "specialRound": state["special_round"],
            "players": [
                {"userId": int(u), "name": state["player_names"].get(u, "?"), "active": state["active"].get(u, False), "score": state["scores"].get(u, 0)}
                for u in state["player_order"]
            ],
            "strokesVersion": state.get("strokes_version", 0),
        }

        if phase == "choosing":
            base["secondsLeft"] = max(0, round(state["choice_deadline"] - now))
            if is_drawer:
                base["candidateWords"] = [{"id": w["id"], "word": w["word"], "difficulty": w["difficulty"]} for w in state["candidate_words"]]

        elif phase == "drawing":
            base["secondsLeft"] = max(0, round(state["draw_end_time"] - now))
            base["oneStrokeBudget"] = state["one_stroke_budget"]
            base["myCorrect"] = am_correct
            base["correctCount"] = len(state["correct_uids"])
            word = state["current_word"]
            if is_drawer or am_correct:
                base["word"] = word["word"]
            else:
                base["wordPattern"] = _word_pattern(word["word"], state["revealed_positions"])
                base["wordLength"] = len(word["word"].replace(" ", ""))
            if is_drawer:
                base["category"] = word["category"]
            base["guessFeed"] = [
                {"userId": g["userId"], "text": g["text"], "correct": g["correct"], "near": g["near"]}
                for g in state["guesses"][-MAX_GUESS_FEED_SENT:]
            ]

        elif phase == "reveal":
            rh = state["round_history"][-1] if state["round_history"] else None
            if rh:
                base["reveal"] = {
                    "word": rh["word"], "category": rh["category"], "drawerName": rh["drawerName"],
                    "drawerUserId": rh["drawerUserId"], "drawerPoints": rh["drawerPoints"],
                    "correctCount": rh["correctCount"], "totalGuessers": rh["totalGuessers"],
                    "special": rh["special"], "reason": rh["reason"],
                }
                base["roundPointsDelta"] = state["round_points_delta"]

        elif phase == "standings":
            base["standings"] = sorted(
                ({"userId": int(u), "name": state["player_names"].get(u, "?"), "score": state["scores"].get(u, 0)} for u in state["player_order"] if state["active"].get(u)),
                key=lambda e: -e["score"],
            )

        elif phase == "finished":
            base["endscreen"] = _build_endscreen(state)

        return base


# ---------- live stroke relay (bypasses the generic tick/state broadcast -
# see module docstring for why) ----------

def _get_drawing_session(game_manager, ws):
    session = game_manager.get_session_for_ws(ws)
    if not session or session.game_type != "kritzelmeister" or session.status != "playing":
        return None
    return session


async def _relay_to_others(game_manager, session, ws, payload):
    for p in session.players:
        if p["ws"] is ws:
            continue
        await game_manager.cm.send_to(p["ws"], payload)


def _clamp01(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    if v < 0:
        return 0.0
    if v > 1:
        return 1.0
    return v


def _validate_points(raw_points):
    if not isinstance(raw_points, list) or not raw_points:
        return None
    out = []
    for p in raw_points[:MAX_POINTS_PER_BATCH]:
        if isinstance(p, dict):
            x, y = p.get("x"), p.get("y")
        elif isinstance(p, (list, tuple)) and len(p) >= 2:
            x, y = p[0], p[1]
        else:
            continue
        x, y = _clamp01(x), _clamp01(y)
        if x is None or y is None:
            continue
        out.append({"x": x, "y": y})
    return out or None


async def handle_stroke_start(game_manager, user, ws, raw):
    session = _get_drawing_session(game_manager, ws)
    if not session:
        return
    state = session.state
    if state["phase"] != "drawing" or state["drawer_user_id"] != user["id"]:
        return
    if len(state["strokes"]) >= MAX_STROKES_PER_ROUND:
        return
    if state["special_round"] == "one_stroke":
        if not state["one_stroke_budget"]:
            return
        state["one_stroke_budget"] -= 1

    color, width, tool = raw.get("color"), raw.get("width"), raw.get("tool")
    if color not in ALLOWED_COLORS or width not in ALLOWED_WIDTHS or tool not in ALLOWED_TOOLS:
        return
    stroke_id = raw.get("stroke_id")
    if not isinstance(stroke_id, str) or not (1 <= len(stroke_id) <= 40):
        return
    if any(s["id"] == stroke_id for s in state["strokes"]):
        return

    points = _validate_points(raw.get("points")) or []
    state["strokes"].append({"id": stroke_id, "color": color, "width": width, "tool": tool, "points": points, "done": False})
    state["strokes_version"] += 1
    await _relay_to_others(game_manager, session, ws, {
        "type": "drawing_stroke_start", "stroke_id": stroke_id, "color": color, "width": width, "tool": tool, "points": points,
    })


async def handle_stroke_batch(game_manager, user, ws, raw):
    session = _get_drawing_session(game_manager, ws)
    if not session:
        return
    state = session.state
    if state["phase"] != "drawing" or state["drawer_user_id"] != user["id"]:
        return
    stroke_id = raw.get("stroke_id")
    stroke = next((s for s in state["strokes"] if s["id"] == stroke_id and not s["done"]), None)
    if not stroke:
        return
    points = _validate_points(raw.get("points"))
    if not points:
        return
    room = MAX_POINTS_PER_STROKE - len(stroke["points"])
    if room <= 0:
        return
    points = points[:room]
    stroke["points"].extend(points)
    state["strokes_version"] += 1
    await _relay_to_others(game_manager, session, ws, {"type": "drawing_stroke_batch", "stroke_id": stroke_id, "points": points})


async def handle_stroke_end(game_manager, user, ws, raw):
    session = _get_drawing_session(game_manager, ws)
    if not session:
        return
    state = session.state
    if state["drawer_user_id"] != user["id"]:
        return
    stroke_id = raw.get("stroke_id")
    stroke = next((s for s in state["strokes"] if s["id"] == stroke_id), None)
    if not stroke:
        return
    stroke["done"] = True
    state["strokes_version"] += 1
    await _relay_to_others(game_manager, session, ws, {"type": "drawing_stroke_end", "stroke_id": stroke_id})


async def handle_undo(game_manager, user, ws, raw):
    session = _get_drawing_session(game_manager, ws)
    if not session:
        return
    state = session.state
    if state["phase"] != "drawing" or state["drawer_user_id"] != user["id"] or not state["strokes"]:
        return
    state["strokes"].pop()
    state["strokes_version"] += 1
    await game_manager.send_to_session(session, {"type": "drawing_undo"})


async def handle_clear(game_manager, user, ws, raw):
    session = _get_drawing_session(game_manager, ws)
    if not session:
        return
    state = session.state
    if state["phase"] != "drawing" or state["drawer_user_id"] != user["id"]:
        return
    state["strokes"] = []
    state["strokes_version"] += 1
    await game_manager.send_to_session(session, {"type": "drawing_clear"})


async def handle_request_sync(game_manager, user, ws, raw):
    """Any current session member (not just the drawer) may request the
    full current-round stroke history - used right after the game modal
    mounts and whenever a client notices its local strokes_version doesn't
    match the value carried in the regular (lightweight) state broadcast,
    e.g. after a missed relay or a fresh websocket on an already-open tab.
    This is the "reconstruct the canvas" mechanism the brief asks for -
    real player-reconnect-into-the-same-session is a separate, larger
    architectural change no game in this app supports today (see the
    on_player_left note above), so this covers what's actually buildable:
    resynchronizing a still-active member's view of the current drawing."""
    session = game_manager.get_session_for_ws(ws)
    if not session or session.game_type != "kritzelmeister" or session.status != "playing":
        return
    state = session.state
    await game_manager.cm.send_to(ws, {
        "type": "drawing_sync", "strokes": state["strokes"], "strokes_version": state["strokes_version"],
    })
