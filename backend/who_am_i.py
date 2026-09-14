"""Wer bin ich? - multiplayer "sticky note on your forehead" party game.

Implements the same engine interface documented at the top of games.py
(init_state/apply_input/tick/check_finished/reset/on_player_left/
public_state) so it plugs into the existing generic GameSession/GameManager
unchanged - see games.py for how engines are wired up and registered.

The identity bank lives in backend/data/who_am_i_identities.json, kept
strictly separate from this file's game-flow/scoring logic (same split as
estimate_game.py/estimate_questions.json). It is loaded and validated once
at import time (validate_identity_bank) so a broken or incomplete bank fails
loudly at server startup instead of surfacing as a confusing runtime error
mid-game.

SECURITY: this is the single most important property of the whole engine.
The server always knows player_id -> identity, but a player's OWN identity
must never reach their OWN client before they either guess it correctly or
the match ends. public_state() below is the one choke point that decides
what each player's websocket receives: for every player in the game, their
own not-yet-solved identity is replaced with `None` in THEIR OWN payload
(every other player's identity - and their own AFTER solving - passes
through normally). The raw `state["identities"]` dict is never sent as-is;
GameManager only ever calls public_state(state, viewer_user_id) per socket.
"""

import random
import re
import time
from pathlib import Path
import json

IDENTITIES_PATH = Path(__file__).resolve().parent / "data" / "who_am_i_identities.json"

VALID_TYPES = {"real", "fictional"}
VALID_CATEGORIES = {
    "film": {"label": "Film & Serien", "emoji": "🎬"},
    "music": {"label": "Musik", "emoji": "🎵"},
    "sport": {"label": "Sport", "emoji": "⚽"},
    "famous": {"label": "Berühmte Personen", "emoji": "🌍"},
    "history": {"label": "Geschichte", "emoji": "🏛"},
    "fiction": {"label": "Fiktive Figuren", "emoji": "🧙"},
    "tv": {"label": "TV & Unterhaltung", "emoji": "📺"},
    "popculture": {"label": "Internet / Popkultur", "emoji": "💻"},
    "politics": {"label": "Politik / Geschichte (Staatsfiguren)", "emoji": "👑"},
}
MIN_IDENTITY_BANK_SIZE = 300


def _norm(s):
    """Case/whitespace/punctuation-insensitive comparison key for name and
    alias matching - deliberately simple (no fuzzy/edit-distance matching)
    per the explicit "kein extrem lockeres fuzzy matching" requirement."""
    s = (s or "").lower().strip()
    s = re.sub(r"[.'’\-]", "", s)
    s = re.sub(r"\s+", " ", s)
    return s


def validate_identity_bank(raw):
    """Checks the raw (already-JSON-parsed) identity list for the invariants
    the game logic below relies on. Returns the cleaned list of identity
    dicts on success; raises ValueError (listing every problem found, not
    just the first) on failure."""
    errors = []
    seen_ids = set()
    seen_names = {}
    seen_aliases = {}
    identities = []

    if not isinstance(raw, list):
        raise ValueError("who_am_i_identities.json must contain a JSON array")

    for i, item in enumerate(raw):
        prefix = f"[index {i}, id={item.get('id') if isinstance(item, dict) else '?'}]"
        if not isinstance(item, dict):
            errors.append(f"{prefix}: not an object")
            continue

        ident_id = item.get("id")
        if not isinstance(ident_id, str) or not ident_id:
            errors.append(f"{prefix}: missing/invalid id")
            continue
        if ident_id in seen_ids:
            errors.append(f"{prefix}: duplicate id '{ident_id}'")
            continue

        name = (item.get("name") or "").strip()
        if not name:
            errors.append(f"{prefix}: missing name")
            continue
        name_key = _norm(name)
        if name_key in seen_names:
            errors.append(f"{prefix}: duplicate/near-duplicate name '{name}' (clashes with {seen_names[name_key]})")
            continue

        category = item.get("category")
        if category not in VALID_CATEGORIES:
            errors.append(f"{prefix}: invalid category '{category}'")
            continue

        difficulty = item.get("difficulty")
        if difficulty not in (1, 2, 3):
            errors.append(f"{prefix}: invalid difficulty {difficulty!r} (must be 1, 2 or 3)")
            continue

        typ = item.get("type")
        if typ not in VALID_TYPES:
            errors.append(f"{prefix}: invalid type '{typ}'")
            continue

        aliases = item.get("aliases")
        if aliases is None:
            aliases = []
        if not isinstance(aliases, list) or not all(isinstance(a, str) for a in aliases):
            errors.append(f"{prefix}: aliases must be an array of strings")
            continue

        # Every alias must resolve unambiguously to THIS entry - it may not
        # collide with another entry's name or alias (that would make a
        # player's typed guess ambiguous about which identity they meant).
        alias_conflict = False
        for a in aliases:
            a_key = _norm(a)
            if a_key == name_key:
                continue
            if a_key in seen_names and seen_names[a_key] != name:
                errors.append(f"{prefix}: alias '{a}' collides with another entry's name '{seen_names[a_key]}'")
                alias_conflict = True
                break
            if a_key in seen_aliases and seen_aliases[a_key] != name:
                errors.append(f"{prefix}: alias '{a}' collides with another entry's alias (owned by '{seen_aliases[a_key]}')")
                alias_conflict = True
                break
        if alias_conflict:
            continue

        seen_ids.add(ident_id)
        seen_names[name_key] = name
        for a in aliases:
            seen_aliases[_norm(a)] = name

        identities.append({
            "id": ident_id,
            "name": name,
            "aliases": aliases,
            "category": category,
            "difficulty": difficulty,
            "type": typ,
        })

    if errors:
        raise ValueError(
            f"who_am_i_identities.json validation failed ({len(errors)} problem(s)):\n"
            + "\n".join(errors[:50])
            + ("\n... (truncated)" if len(errors) > 50 else "")
        )
    if len(identities) < MIN_IDENTITY_BANK_SIZE:
        raise ValueError(
            f"who_am_i_identities.json has only {len(identities)} valid identities, "
            f"need at least {MIN_IDENTITY_BANK_SIZE}"
        )
    return identities


def _load_identity_bank():
    with open(IDENTITIES_PATH, encoding="utf-8") as f:
        raw = json.load(f)
    identities = validate_identity_bank(raw)
    by_category = {}
    for ident in identities:
        by_category[ident["category"]] = by_category.get(ident["category"], 0) + 1
    print(f"[who_am_i] Identity bank loaded OK. Total identities: {len(identities)}")
    for cat in VALID_CATEGORIES:
        print(f"[who_am_i]   {VALID_CATEGORIES[cat]['label']} ({cat}): {by_category.get(cat, 0)}")
    return identities


IDENTITY_BANK = _load_identity_bank()
IDENTITY_BY_ID = {i["id"]: i for i in IDENTITY_BANK}


def public_identity_bank():
    """The full bank, safe to expose over REST for client-side autocomplete
    search - this is the LIST of possible identities, not the secret
    player_id -> identity assignment, so it carries no per-match secrecy at
    all. Used by the frontend's guess-autocomplete (see who-am-i.js)."""
    return IDENTITY_BANK


def resolve_guess(text):
    """Normalized exact match (name or alias) against the full bank - the
    deliberately-not-fuzzy matcher backing a typed final guess. Returns the
    identity dict, or None if nothing matches unambiguously."""
    if not isinstance(text, str):
        return None
    key = _norm(text)
    if not key:
        return None
    for ident in IDENTITY_BANK:
        if _norm(ident["name"]) == key:
            return ident
        for a in ident["aliases"]:
            if _norm(a) == key:
                return ident
    return None


# ---------- identity selection ----------

def pick_identities(bank, n, difficulty, categories):
    """Picks `n` DISTINCT identities for one match, filtered by category and
    (if not "mixed") difficulty. Degrades gracefully (never raises) exactly
    like estimate_game.select_questions - a host can legally narrow
    categories down to just one, so the difficulty/category filters are
    best-effort, topped up from the wider pool rather than coming up short."""
    category_set = set(categories) & set(VALID_CATEGORIES)
    if not category_set:
        category_set = set(VALID_CATEGORIES)

    base = [i for i in bank if i["category"] in category_set]
    if len(base) < n:
        base = list(bank)

    if difficulty == "mixed":
        pool = list(base)
    else:
        diff_key = {"easy": 1, "medium": 2, "hard": 3}[difficulty]
        pool = [i for i in base if i["difficulty"] == diff_key]
        if len(pool) < n:
            pool = list(base)

    random.shuffle(pool)
    return pool[:n]


# ---------- match flow constants ----------

ASK_SECONDS = 30
VOTE_SECONDS = 15
VOTE_RESULT_SECONDS = 4
SUBMIT_GRACE_SECONDS = 0.6
MAX_QUESTIONS_PER_TURN = 3

DEFAULT_MAX_ROUNDS = 15
VALID_MAX_ROUNDS = {10, 15, 0}  # 0 = unbegrenzt
DEFAULT_DIFFICULTY = "mixed"
VALID_DIFFICULTIES = {"mixed", "easy", "medium", "hard"}

START_POTENTIAL = 1500
QUESTION_PENALTY = 50
WRONG_GUESS_PENALTY = 150
MIN_SOLVED_SCORE = 100
BONUS_WITHIN_5 = 300
BONUS_WITHIN_8 = 150


def _sanitize_options(options):
    options = options if isinstance(options, dict) else {}
    difficulty = options.get("difficulty")
    if difficulty not in VALID_DIFFICULTIES:
        difficulty = DEFAULT_DIFFICULTY
    categories = options.get("categories")
    if not isinstance(categories, list):
        categories = list(VALID_CATEGORIES.keys())
    else:
        categories = [c for c in categories if isinstance(c, str) and c in VALID_CATEGORIES]
        if not categories:
            categories = list(VALID_CATEGORIES.keys())
    max_rounds = options.get("maxRounds")
    if max_rounds not in VALID_MAX_ROUNDS:
        max_rounds = DEFAULT_MAX_ROUNDS
    custom_terms = options.get("customTerms")
    if not isinstance(custom_terms, list):
        custom_terms = []
    else:
        custom_terms = [t.strip() for t in custom_terms if isinstance(t, str) and t.strip()][:16]
    return {"difficulty": difficulty, "categories": categories, "maxRounds": max_rounds, "customTerms": custom_terms}


def _make_custom_identity(text, idx):
    return {
        "id": f"custom_{idx:03d}",
        "name": text[:60],
        "aliases": [],
        "category": "custom",
        "difficulty": 2,
        "type": "real",
    }


def _next_asker_index(state, after_index):
    order = state["player_order"]
    n = len(order)
    for step in range(1, n + 1):
        idx = (after_index + step) % n
        uid = order[idx]
        if state["active"].get(uid) and not state["solved"].get(uid):
            return idx
    return None


def _score_for_solve(questions_asked, wrong_guesses):
    base = max(MIN_SOLVED_SCORE, START_POTENTIAL - QUESTION_PENALTY * questions_asked - WRONG_GUESS_PENALTY * wrong_guesses)
    if questions_asked <= 5:
        bonus = BONUS_WITHIN_5
    elif questions_asked <= 8:
        bonus = BONUS_WITHIN_8
    else:
        bonus = 0
    return base + bonus


def _start_asking(state, asker_index, now, fresh_turn=True):
    state["current_asker_index"] = asker_index
    state["phase"] = "asking"
    state["phase_deadline"] = now + ASK_SECONDS
    if fresh_turn:
        state["question_number_this_turn"] = 0
    state["current_question_text"] = None
    state["votes"] = {}
    state["vote_result"] = None


def _end_turn(state, now):
    """Centralizes every "this player's turn is over" transition: advances
    rounds_played, finds the next unsolved active asker, and either starts
    their "asking" phase or ends the match (nobody left to ask, or the
    host's max-round cap was hit)."""
    state["rounds_played"] += 1
    max_rounds = state["options"]["maxRounds"]
    if max_rounds and state["rounds_played"] >= max_rounds:
        state["phase"] = "finished"
        state["phase_deadline"] = None
        return
    next_idx = _next_asker_index(state, state["current_asker_index"])
    if next_idx is None:
        state["phase"] = "finished"
        state["phase_deadline"] = None
        return
    _start_asking(state, next_idx, now, fresh_turn=True)


def _eligible_voters(state, asker_uid):
    return [uid for uid in state["player_order"] if state["active"].get(uid) and uid != asker_uid]


class WhoAmIEngine:
    game_type = "whoami"
    name = "Wer bin ich?"
    emoji = "🎭"
    min_players = 2
    max_players = 8
    manual_start = True
    tick_interval = 1.0

    @staticmethod
    def init_state(players, options=None):
        opts = _sanitize_options(options)
        uids = [str(p["user_id"]) for p in players]

        pool = list(IDENTITY_BANK)
        for i, term in enumerate(opts["customTerms"]):
            pool.append(_make_custom_identity(term, i + 1))

        chosen = pick_identities(pool, len(uids), opts["difficulty"], opts["categories"])
        # pick_identities degrades gracefully but can still come up short if
        # the (bank + custom terms) pool has fewer entries than players -
        # extremely unlikely (416 bank entries, max 8 players) but topped up
        # here defensively so init_state never raises mid-lobby-start.
        while len(chosen) < len(uids):
            chosen.append(_make_custom_identity(f"Unbekannt {len(chosen) + 1}", len(chosen) + 1))
        random.shuffle(chosen)

        identities = {uid: chosen[i] for i, uid in enumerate(uids)}

        state = {
            "options": opts,
            "player_order": uids,
            "player_names": {str(p["user_id"]): p["name"] for p in players},
            "active": {uid: True for uid in uids},
            "identities": identities,
            "solved": {uid: False for uid in uids},
            "solved_order": [],
            "questions_asked_count": {uid: 0 for uid in uids},
            "wrong_guesses_count": {uid: 0 for uid in uids},
            "final_score": {uid: None for uid in uids},
            "current_asker_index": None,
            "question_number_this_turn": 0,
            "rounds_played": 0,
            "phase": "asking",
            "phase_deadline": None,
            "current_question_text": None,
            "votes": {},
            "vote_result": None,
            "last_guess_result": None,
            "guess_event_seq": 0,
            "history": [],
        }
        start_idx = random.randrange(len(uids))
        _start_asking(state, start_idx, time.time(), fresh_turn=True)
        return state

    @staticmethod
    def apply_input(state, user_id, payload):
        uid = str(user_id)
        if state["phase"] == "finished":
            return False
        if not state["active"].get(uid):
            return False
        action = payload.get("action")
        now = time.time()

        if state["phase"] == "asking":
            current_uid = state["player_order"][state["current_asker_index"]]
            if current_uid != uid:
                return False

            if action == "ask_question":
                text = (payload.get("text") or "").strip()
                if not text or len(text) > 200:
                    return False
                state["questions_asked_count"][uid] += 1
                state["question_number_this_turn"] += 1
                state["current_question_text"] = text
                state["phase"] = "voting"
                state["phase_deadline"] = now + VOTE_SECONDS
                voters = _eligible_voters(state, uid)
                state["votes"] = {v: None for v in voters}
                state["vote_result"] = None
                return True

            if action == "final_guess":
                ident = None
                ident_id = payload.get("identityId")
                if isinstance(ident_id, str):
                    ident = IDENTITY_BY_ID.get(ident_id)
                    if ident is None:
                        for term_idx, term in enumerate(state["options"]["customTerms"]):
                            if f"custom_{term_idx + 1:03d}" == ident_id:
                                ident = _make_custom_identity(term, term_idx + 1)
                                break
                if ident is None:
                    guess_text = payload.get("guessText")
                    ident = resolve_guess(guess_text) if guess_text else None
                    if ident is None and isinstance(guess_text, str) and guess_text.strip():
                        for term_idx, term in enumerate(state["options"]["customTerms"]):
                            if _norm(term) == _norm(guess_text):
                                ident = _make_custom_identity(term, term_idx + 1)
                                break
                if ident is None:
                    return False

                own = state["identities"][uid]
                correct = ident["id"] == own["id"]
                state["guess_event_seq"] += 1

                if correct:
                    state["solved"][uid] = True
                    state["solved_order"].append(uid)
                    score = _score_for_solve(state["questions_asked_count"][uid], state["wrong_guesses_count"][uid])
                    state["final_score"][uid] = score
                    state["last_guess_result"] = {
                        "seq": state["guess_event_seq"], "userId": int(uid), "correct": True,
                        "identityId": own["id"], "identityName": own["name"], "score": score,
                    }
                else:
                    state["wrong_guesses_count"][uid] += 1
                    state["last_guess_result"] = {
                        "seq": state["guess_event_seq"], "userId": int(uid), "correct": False,
                        "guessedText": ident["name"],
                    }

                _end_turn(state, now)
                return True

            return False

        if state["phase"] == "voting":
            if action != "vote":
                return False
            if uid not in state["votes"] or state["votes"][uid] is not None:
                return False
            choice = payload.get("choice")
            if choice not in ("yes", "no", "unclear"):
                return False
            state["votes"][uid] = choice
            return True

        return False

    @staticmethod
    def tick(state):
        now = time.time()
        phase = state["phase"]

        if phase == "asking":
            if state["phase_deadline"] is not None and now >= state["phase_deadline"]:
                _end_turn(state, now)

        elif phase == "voting":
            voters = list(state["votes"].keys())
            all_in = bool(voters) and all(state["votes"][v] is not None for v in voters)
            timed_out = state["phase_deadline"] is not None and now >= state["phase_deadline"]
            # No artificial extra grace period beyond the vote deadline itself
            # is needed here (unlike Schaetzmeister's guess phase) - votes are
            # single-tap and the deadline is already generous (15s).
            if all_in or timed_out:
                yes = sum(1 for v in voters if state["votes"][v] == "yes")
                no = sum(1 for v in voters if state["votes"][v] == "no")
                unclear = sum(1 for v in voters if state["votes"][v] == "unclear")
                total = yes + no + unclear
                if total == 0:
                    result = "unclear"
                else:
                    counts = {"yes": yes, "no": no, "unclear": unclear}
                    best = max(counts.values())
                    winners = [k for k, v in counts.items() if v == best]
                    result = winners[0] if len(winners) == 1 else "unclear"

                asker_uid = state["player_order"][state["current_asker_index"]]
                state["vote_result"] = {"result": result, "yesCount": yes, "noCount": no, "unclearCount": unclear}
                state["history"].append({
                    "turn": state["rounds_played"] + 1,
                    "askerId": int(asker_uid),
                    "question": state["current_question_text"],
                    "result": result,
                    "yesCount": yes, "noCount": no, "unclearCount": unclear,
                })
                state["phase"] = "vote_result"
                state["phase_deadline"] = now + VOTE_RESULT_SECONDS

        elif phase == "vote_result":
            if state["phase_deadline"] is not None and now >= state["phase_deadline"]:
                result = state["vote_result"]["result"] if state["vote_result"] else "unclear"
                asked_this_turn = state["question_number_this_turn"]
                if result == "yes" and asked_this_turn < MAX_QUESTIONS_PER_TURN:
                    _start_asking(state, state["current_asker_index"], now, fresh_turn=False)
                else:
                    _end_turn(state, now)

        # phase == "finished": nothing to do, check_finished() ends the session

    @staticmethod
    def check_finished(state):
        if state["phase"] != "finished":
            return None
        endscreen = _build_endscreen(state)
        winner_uid = None
        if endscreen["leaderboard"]:
            top = endscreen["leaderboard"][0]
            if top["solved"]:
                winner_uid = top["userId"]
        return {"winner_user_id": winner_uid, "reason": "whoami_finished", "details": endscreen}

    @staticmethod
    def on_player_left(state, user_id):
        uid = str(user_id)
        if uid not in state["active"]:
            return
        state["active"][uid] = False
        if state["phase"] == "finished":
            return

        current_uid = None
        if state["current_asker_index"] is not None:
            current_uid = state["player_order"][state["current_asker_index"]]

        if uid == current_uid and state["phase"] in ("asking", "voting", "vote_result"):
            _end_turn(state, time.time())
        elif state["phase"] == "voting" and uid in state["votes"]:
            # Their pending vote (if any) simply stops being waited on - the
            # tick() "all voters in" check re-derives `voters` from
            # state["votes"].keys() fresh every time, and a departed voter's
            # None entry would otherwise stall "all_in" forever, so drop it.
            state["votes"].pop(uid, None)

    @staticmethod
    def reset(state):
        fresh = WhoAmIEngine.init_state(
            [{"user_id": int(uid), "name": state["player_names"][uid]} for uid in state["player_order"] if state["active"].get(uid)],
            state["options"],
        )
        state.clear()
        state.update(fresh)

    @staticmethod
    def public_state(state, viewer_user_id):
        uid = str(viewer_user_id)
        now = time.time()
        phase = state["phase"]

        players = []
        for u in state["player_order"]:
            solved_u = state["solved"].get(u, False)
            is_self = u == uid
            identity_payload = None
            if (not is_self) or solved_u:
                ident = state["identities"][u]
                identity_payload = {
                    "id": ident["id"], "name": ident["name"],
                    "category": ident["category"], "difficulty": ident["difficulty"], "type": ident["type"],
                }
            players.append({
                "userId": int(u),
                "name": state["player_names"].get(u, "?"),
                "active": state["active"].get(u, False),
                "solved": solved_u,
                "isSelf": is_self,
                "identity": identity_payload,
                "questionsAsked": state["questions_asked_count"].get(u, 0),
                "wrongGuesses": state["wrong_guesses_count"].get(u, 0),
                "score": state["final_score"].get(u),
            })

        current_asker_id = None
        if state["current_asker_index"] is not None and phase != "finished":
            current_asker_id = int(state["player_order"][state["current_asker_index"]])

        base = {
            "phase": phase,
            "roundsPlayed": state["rounds_played"],
            "maxRounds": state["options"]["maxRounds"],
            "players": players,
            "currentAskerId": current_asker_id,
            "isMyTurn": current_asker_id is not None and current_asker_id == int(uid),
            "questionNumberThisTurn": state["question_number_this_turn"],
            "maxQuestionsPerTurn": MAX_QUESTIONS_PER_TURN,
            "currentQuestion": state["current_question_text"],
            "secondsLeft": max(0, round(state["phase_deadline"] - now)) if state["phase_deadline"] else 0,
            "history": state["history"][-25:],
        }

        if phase == "voting":
            voters = list(state["votes"].keys())
            base["votingOpen"] = uid in state["votes"] and state["votes"][uid] is None
            base["voteStatus"] = {v: (state["votes"][v] is not None) for v in voters}
            base["myVote"] = state["votes"].get(uid)
            base["voterIds"] = [int(v) for v in voters]
        elif phase == "vote_result":
            base["voteResult"] = state["vote_result"]

        lgr = state.get("last_guess_result")
        if lgr is not None:
            if lgr["correct"]:
                base["lastGuessResult"] = lgr
            else:
                base["lastGuessResult"] = {
                    "seq": lgr["seq"], "userId": lgr["userId"], "correct": False, "guessedText": lgr["guessedText"],
                }

        if phase == "finished":
            base["endscreen"] = _build_endscreen(state)

        return base


def _build_endscreen(state):
    entries = []
    for uid in state["player_order"]:
        solved_u = state["solved"].get(uid, False)
        score = state["final_score"].get(uid) if solved_u else 0
        entries.append({
            "userId": int(uid),
            "name": state["player_names"].get(uid, "?"),
            "identity": {"name": state["identities"][uid]["name"], "id": state["identities"][uid]["id"]},
            "solved": solved_u,
            "score": score or 0,
            "questionsAsked": state["questions_asked_count"].get(uid, 0),
        })
    entries.sort(key=lambda e: (-int(e["solved"]), -e["score"]))
    return {"leaderboard": entries, "roundsPlayed": state["rounds_played"], "maxRounds": state["options"]["maxRounds"]}
