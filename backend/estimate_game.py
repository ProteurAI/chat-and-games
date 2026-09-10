"""Schaetzmeister - multiplayer number-guessing trivia game engine.

Implements the same engine interface documented at the top of games.py
(init_state/apply_input/tick/check_finished/reset/on_player_left/
public_state) so it plugs into the existing generic GameSession/GameManager
unchanged - see games.py for how engines are wired up and registered.

The question bank lives in backend/data/estimate_questions.json, kept
strictly separate from this file's game-flow/scoring logic. It is loaded
and validated once at import time (see validate_question_bank) so a broken
or incomplete question bank fails loudly at server startup instead of
surfacing as a confusing runtime error mid-game.

SECURITY: the correct answer, explanation and other players' guesses are
never put into `state` fields that reach a client before the reveal phase -
public_state() below is the single choke point that decides what each
player's websocket receives, filtered by `state["phase"]`. During
"guessing", only questionId/question/category/unit/type/secondsLeft and
each player's own submitted-or-not status go out; `answer` never leaves
this module before phase is "reveal" or later.
"""

import json
import math
import random
import re
import time
from pathlib import Path

QUESTIONS_PATH = Path(__file__).resolve().parent / "data" / "estimate_questions.json"

VALID_TYPES = {"number", "year", "percentage"}
VALID_CATEGORIES = {
    "geography": {"label": "Geografie", "emoji": "🌍"},
    "science": {"label": "Wissenschaft & Natur", "emoji": "🔬"},
    "history": {"label": "Geschichte", "emoji": "🏛"},
    "tech": {"label": "Technik & Internet", "emoji": "💻"},
    "entertainment": {"label": "Unterhaltung", "emoji": "🎬"},
    "sports": {"label": "Sport", "emoji": "⚽"},
    "mobility": {"label": "Mobilität & Fahrzeuge", "emoji": "🚗"},
    "weird": {"label": "Verrücktes Wissen", "emoji": "🌎"},
}
MIN_QUESTION_BANK_SIZE = 150


def validate_question_bank(raw):
    """Checks the raw (already-JSON-parsed) question list for the
    invariants the game logic below relies on. Returns the cleaned list of
    question dicts on success; raises ValueError (listing every problem
    found, not just the first) on failure."""
    errors = []
    seen_ids = set()
    seen_text = set()
    questions = []

    if not isinstance(raw, list):
        raise ValueError("estimate_questions.json must contain a JSON array")

    for i, q in enumerate(raw):
        prefix = f"[index {i}, id={q.get('id') if isinstance(q, dict) else '?'}]"
        if not isinstance(q, dict):
            errors.append(f"{prefix}: not an object")
            continue

        qid = q.get("id")
        if not isinstance(qid, str) or not qid:
            errors.append(f"{prefix}: missing/invalid id")
            continue
        if qid in seen_ids:
            errors.append(f"{prefix}: duplicate id '{qid}'")
            continue

        text = (q.get("question") or "").strip()
        if not text:
            errors.append(f"{prefix}: missing question text")
            continue
        norm_text = text.lower()
        if norm_text in seen_text:
            errors.append(f"{prefix}: duplicate question text")
            continue

        category = q.get("category")
        if category not in VALID_CATEGORIES:
            errors.append(f"{prefix}: invalid category '{category}'")
            continue

        qtype = q.get("type")
        if qtype not in VALID_TYPES:
            errors.append(f"{prefix}: invalid type '{qtype}'")
            continue

        answer = q.get("answer")
        if isinstance(answer, bool) or not isinstance(answer, (int, float)):
            errors.append(f"{prefix}: answer is not numeric")
            continue
        answer = float(answer)
        if not math.isfinite(answer):
            errors.append(f"{prefix}: answer is NaN/Infinity")
            continue
        if qtype == "year" and not (1000 <= answer <= 2100):
            errors.append(f"{prefix}: implausible year answer {answer}")
            continue

        difficulty = q.get("difficulty")
        if difficulty not in (1, 2, 3):
            errors.append(f"{prefix}: invalid difficulty {difficulty!r} (must be 1, 2 or 3)")
            continue

        explanation = (q.get("explanation") or "").strip()
        if not explanation:
            errors.append(f"{prefix}: missing explanation")
            continue

        display_answer = (q.get("displayAnswer") or "").strip()
        if not display_answer:
            errors.append(f"{prefix}: missing displayAnswer")
            continue

        unit = q.get("unit")
        if unit is None:
            unit = ""

        # All checks for this entry passed - only now do id/text count as
        # "seen" (a rejected entry must not block a later, valid duplicate id).
        seen_ids.add(qid)
        seen_text.add(norm_text)
        questions.append({
            "id": qid,
            "category": category,
            "type": qtype,
            "question": text,
            "answer": answer,
            "unit": unit,
            "displayAnswer": display_answer,
            "difficulty": difficulty,
            "explanation": explanation,
            "sourceLabel": q.get("sourceLabel") or "",
            "sourceUrl": q.get("sourceUrl") or "",
            "verifiedAsOf": q.get("verifiedAsOf") or "",
        })

    if errors:
        raise ValueError(
            f"estimate_questions.json validation failed ({len(errors)} problem(s)):\n"
            + "\n".join(errors[:50])
            + ("\n... (truncated)" if len(errors) > 50 else "")
        )
    if len(questions) < MIN_QUESTION_BANK_SIZE:
        raise ValueError(
            f"estimate_questions.json has only {len(questions)} valid questions, "
            f"need at least {MIN_QUESTION_BANK_SIZE}"
        )
    return questions


def _load_question_bank():
    with open(QUESTIONS_PATH, encoding="utf-8") as f:
        raw = json.load(f)
    return validate_question_bank(raw)


QUESTION_BANK = _load_question_bank()


# ---------- question selection ----------

DIFFICULTY_KEY = {"easy": 1, "medium": 2, "hard": 3}
MIX_RATIOS = {1: 0.3, 2: 0.5, 3: 0.2}  # leicht/mittel/schwer split for a "mixed" match


def _difficulty_quota(rounds):
    raw = {d: rounds * ratio for d, ratio in MIX_RATIOS.items()}
    floored = {d: int(v) for d, v in raw.items()}
    remainder = rounds - sum(floored.values())
    fracs_desc = sorted(raw.keys(), key=lambda d: (raw[d] - floored[d]), reverse=True)
    for d in fracs_desc[:remainder]:
        floored[d] += 1
    return floored


def _take_category_interleaved(items, n):
    """Rounds-robins across categories present in `items` so a run of picks
    doesn't cluster on one category (e.g. five geography questions in a
    row) - see the module-level selection docstring in games.py's spec."""
    by_cat = {}
    for q in items:
        by_cat.setdefault(q["category"], []).append(q)
    cats = list(by_cat.keys())
    random.shuffle(cats)
    picked = []
    i = 0
    while len(picked) < n and any(by_cat.values()):
        cat = cats[i % len(cats)]
        bucket = by_cat.get(cat)
        if bucket:
            picked.append(bucket.pop())
        i += 1
    return picked


def _debunch_categories(questions):
    """Best-effort pass: if 3 questions of the same category ended up
    consecutive after shuffling, swap the third with a later question of a
    different category. Not a hard guarantee, just avoids obvious clumps."""
    result = list(questions)
    for i in range(2, len(result)):
        if result[i]["category"] == result[i - 1]["category"] == result[i - 2]["category"]:
            for j in range(i + 1, len(result)):
                if result[j]["category"] != result[i - 1]["category"]:
                    result[i], result[j] = result[j], result[i]
                    break
    return result


def select_questions(pool, rounds, difficulty, categories, recent_ids):
    """Picks `rounds` questions for one match: filtered by category and
    (if not "mixed") difficulty, spread across categories, avoiding
    `recent_ids` where the pool allows it. Degrades gracefully (see the
    fallbacks below) rather than ever raising, since a host can legally
    narrow categories down to just one or two."""
    category_set = set(categories) & set(VALID_CATEGORIES)
    if not category_set:
        category_set = set(VALID_CATEGORIES)

    base = [q for q in pool if q["category"] in category_set]
    if len(base) < rounds:
        base = list(pool)  # category filter too narrow for the requested round count

    pool_now = [q for q in base if q["id"] not in recent_ids]
    if len(pool_now) < rounds:
        pool_now = list(base)  # not enough fresh questions - allow recent repeats rather than come up short

    if difficulty == "mixed":
        quota = _difficulty_quota(rounds)
    else:
        quota = {DIFFICULTY_KEY[difficulty]: rounds}

    by_diff = {1: [], 2: [], 3: []}
    for q in pool_now:
        by_diff[q["difficulty"]].append(q)
    for d in by_diff:
        random.shuffle(by_diff[d])

    chosen = []
    chosen_ids = set()
    for d, n in quota.items():
        avail = [q for q in by_diff[d] if q["id"] not in chosen_ids]
        picked = _take_category_interleaved(avail, n)
        chosen.extend(picked)
        chosen_ids.update(q["id"] for q in picked)

    if len(chosen) < rounds:
        # a difficulty tier (or a narrow category filter) came up short -
        # top up from whatever's left in the filtered pool so we still hit
        # `rounds` whenever the pool has enough questions at all.
        leftovers = [q for q in pool_now if q["id"] not in chosen_ids]
        random.shuffle(leftovers)
        for q in leftovers:
            if len(chosen) >= rounds:
                break
            chosen.append(q)
            chosen_ids.add(q["id"])

    random.shuffle(chosen)
    chosen = _debunch_categories(chosen)
    return chosen[:rounds]


# ---------- guess parsing ----------

_GUESS_CHARS_RE = re.compile(r"^-?[0-9 .,]+$")


def parse_guess_number(raw):
    """Robustly parses a user-typed number: plain integers/decimals, a
    leading minus, a dot OR comma as the decimal separator, and dots,
    commas or spaces used as thousands separators (e.g. "8.848", "8 848"
    and "8848" must all read as 8848; "8.848,86" and "8,848.86" must both
    read as 8848.86). Returns None for anything that isn't a clean,
    finite, sanely-sized number (letters, NaN/Infinity spellings, empty
    strings, absurdly long input)."""
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        val = float(raw)
        return val if math.isfinite(val) else None
    if not isinstance(raw, str):
        return None

    s = raw.strip()
    if not s or len(s) > 32 or not _GUESS_CHARS_RE.match(s):
        return None

    negative = s.startswith("-")
    if negative:
        s = s[1:]
    s = s.replace(" ", "")
    if not s:
        return None

    last_dot = s.rfind(".")
    last_comma = s.rfind(",")

    if last_dot != -1 and last_comma != -1:
        if last_comma > last_dot:
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif last_comma != -1:
        if s.count(",") == 1 and len(s) - last_comma - 1 <= 2:
            s = s.replace(",", ".")
        else:
            s = s.replace(",", "")
    elif last_dot != -1:
        if s.count(".") == 1 and len(s) - last_dot - 1 <= 2:
            pass
        else:
            s = s.replace(".", "")

    try:
        val = float(s)
    except ValueError:
        return None
    if not math.isfinite(val):
        return None
    if negative:
        val = -val
    if abs(val) > 1e12:
        return None
    return val


# ---------- scoring ----------

PLACEMENT_POINTS = [1000, 750, 500, 350, 250, 180, 120, 80, 50, 25]
EXACT_EPSILON = 1e-9


def _bonus_for_number(error_ratio, exact):
    if exact:
        return 750, "VOLLTREFFER"
    if error_ratio < 0.01:
        return 500, "<1%"
    if error_ratio < 0.05:
        return 300, "<5%"
    if error_ratio < 0.10:
        return 150, "<10%"
    if error_ratio < 0.20:
        return 75, "<20%"
    return 0, None


def _bonus_for_year(diff_years, exact):
    if exact:
        return 500, "VOLLTREFFER"
    d = abs(diff_years)
    if d <= 1:
        return 400, "1 Jahr daneben"
    if d <= 2:
        return 300, "2 Jahre daneben"
    if d <= 5:
        return 150, "3-5 Jahre daneben"
    if d <= 10:
        return 75, "6-10 Jahre daneben"
    return 0, None


def _new_stats():
    return {"rounds_played": 0, "sum_rank": 0, "best_bonus": 0, "best_bonus_round_idx": None, "exact_hits": []}


# ---------- round/match flow constants ----------

GUESS_SECONDS = 20
REVEAL_SECONDS = 9
STANDINGS_SECONDS = 5
SUBMIT_GRACE_SECONDS = 1.0

DEFAULT_ROUNDS = 10
VALID_ROUNDS = {5, 10, 15}
DEFAULT_DIFFICULTY = "mixed"
VALID_DIFFICULTIES = {"mixed", "easy", "medium", "hard"}
RECENT_HISTORY_CAP = 60


def _sanitize_options(options):
    options = options if isinstance(options, dict) else {}
    rounds = options.get("rounds")
    if rounds not in VALID_ROUNDS:
        rounds = DEFAULT_ROUNDS
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
    return {"rounds": rounds, "difficulty": difficulty, "categories": categories}


def _start_round(state, idx):
    state["round_index"] = idx
    state["phase"] = "guessing"
    now = time.time()
    state["guess_deadline"] = now + GUESS_SECONDS
    state["phase_deadline"] = state["guess_deadline"]
    state["submissions"] = {uid: None for uid in state["player_order"] if state["active"].get(uid)}
    state["all_submitted_at"] = None
    state["round_results"] = None


def _finalize_round(state):
    q = state["questions"][state["round_index"]]
    answer = q["answer"]
    qtype = q["type"]

    entries = []
    missed_uids = []
    for uid in state["player_order"]:
        if not state["active"].get(uid):
            continue
        guess = state["submissions"].get(uid)
        if guess is None:
            missed_uids.append(uid)
            continue
        metric = abs(guess - answer)
        entries.append({"uid": uid, "guess": guess, "metric": metric})

    entries.sort(key=lambda e: e["metric"])

    results = []
    for i, e in enumerate(entries):
        if i == 0 or e["metric"] != entries[i - 1]["metric"]:
            rank = i + 1
        else:
            rank = results[-1]["rank"]
        placement_points = PLACEMENT_POINTS[rank - 1] if 1 <= rank <= len(PLACEMENT_POINTS) else 0

        if qtype == "year":
            exact = e["metric"] < 0.5
            bonus, bonus_label = _bonus_for_year(e["metric"], exact)
        else:
            exact = e["metric"] < EXACT_EPSILON
            error_ratio = 1.0 if exact else (e["metric"] / abs(answer) if abs(answer) > EXACT_EPSILON else 1.0)
            bonus, bonus_label = _bonus_for_number(error_ratio, exact)

        round_points = placement_points + bonus
        state["total_scores"][e["uid"]] = state["total_scores"].get(e["uid"], 0) + round_points

        results.append({
            "user_id": int(e["uid"]), "guess": e["guess"], "delta": e["guess"] - answer,
            "rank": rank, "placementPoints": placement_points, "bonus": bonus,
            "bonusLabel": bonus_label, "roundPoints": round_points, "submitted": True,
        })

        st = state["stats"].setdefault(e["uid"], _new_stats())
        st["rounds_played"] += 1
        st["sum_rank"] += rank
        if bonus > st["best_bonus"]:
            st["best_bonus"] = bonus
            st["best_bonus_round_idx"] = state["round_index"]
        if exact:
            st["exact_hits"].append(state["round_index"])

    for uid in missed_uids:
        results.append({
            "user_id": int(uid), "guess": None, "delta": None, "rank": None,
            "placementPoints": 0, "bonus": 0, "bonusLabel": None, "roundPoints": 0, "submitted": False,
        })
        st = state["stats"].setdefault(uid, _new_stats())
        st["rounds_played"] += 1
        st["sum_rank"] += len(entries) + 1  # worse than everyone who submitted this round

    round_result = {
        "questionId": q["id"], "question": q["question"], "category": q["category"],
        "type": qtype, "unit": q["unit"], "answer": answer, "displayAnswer": q["displayAnswer"],
        "explanation": q["explanation"], "sourceLabel": q["sourceLabel"], "sourceUrl": q["sourceUrl"],
        "results": results,
    }
    state["round_results"] = round_result
    state["history"].append(round_result)


def _build_endscreen(state):
    active_uids = [uid for uid in state["player_order"] if state["active"].get(uid)]
    leaderboard = sorted(
        (
            {"userId": int(uid), "name": state["player_names"].get(uid, "?"), "score": state["total_scores"].get(uid, 0)}
            for uid in active_uids
        ),
        key=lambda e: -e["score"],
    )

    best_guess = None
    biggest_bullseye = None
    avg_placement = {}

    for uid in active_uids:
        st = state["stats"].get(uid)
        if not st or st["rounds_played"] == 0:
            continue
        avg_placement[uid] = round(st["sum_rank"] / st["rounds_played"], 2)

        if st["best_bonus"] > 0 and (best_guess is None or st["best_bonus"] > best_guess["bonus"]):
            round_idx = st["best_bonus_round_idx"]
            rr = state["history"][round_idx]
            guess_val = next((r["guess"] for r in rr["results"] if r["user_id"] == int(uid)), None)
            best_guess = {
                "userId": int(uid), "name": state["player_names"].get(uid, "?"), "bonus": st["best_bonus"],
                "question": rr["question"], "guess": guess_val, "displayAnswer": rr["displayAnswer"],
            }

        for round_idx in st["exact_hits"]:
            rr = state["history"][round_idx]
            if biggest_bullseye is None or abs(rr["answer"]) > abs(biggest_bullseye["_answerValue"]):
                biggest_bullseye = {
                    "userId": int(uid), "name": state["player_names"].get(uid, "?"),
                    "question": rr["question"], "displayAnswer": rr["displayAnswer"],
                    "_answerValue": rr["answer"],
                }

    if biggest_bullseye is not None:
        biggest_bullseye.pop("_answerValue", None)

    return {
        "leaderboard": leaderboard,
        "bestGuess": best_guess,
        "biggestBullseye": biggest_bullseye,
        "avgPlacement": avg_placement,
        "totalRounds": state["options"]["rounds"],
    }


class EstimateEngine:
    game_type = "estimate"
    name = "Schätzmeister"
    emoji = "🎯"
    min_players = 2
    max_players = 10
    manual_start = True
    tick_interval = 1.0

    @staticmethod
    def init_state(players, options=None):
        opts = _sanitize_options(options)
        uids = [str(p["user_id"]) for p in players]
        state = {
            "options": opts,
            "player_order": uids,
            "player_names": {str(p["user_id"]): p["name"] for p in players},
            "active": {uid: True for uid in uids},
            "total_scores": {uid: 0 for uid in uids},
            "stats": {uid: _new_stats() for uid in uids},
            "recent_question_ids": [],
            "questions": [],
            "round_index": -1,
            "phase": "guessing",
            "phase_deadline": None,
            "guess_deadline": None,
            "submissions": {},
            "all_submitted_at": None,
            "round_results": None,
            "history": [],
        }
        state["questions"] = select_questions(
            QUESTION_BANK, opts["rounds"], opts["difficulty"], opts["categories"], set()
        )
        state["recent_question_ids"] = [q["id"] for q in state["questions"]]
        _start_round(state, 0)
        return state

    @staticmethod
    def apply_input(state, user_id, payload):
        uid = str(user_id)
        if state["phase"] != "guessing":
            return False
        if not state["active"].get(uid):
            return False
        if uid not in state["submissions"]:
            return False
        if state["submissions"][uid] is not None:
            return False  # already submitted this round - no take-backs/edits
        if payload.get("action") != "submit_guess":
            return False

        value = parse_guess_number(payload.get("value"))
        if value is None:
            return False

        q = state["questions"][state["round_index"]]
        if q["type"] == "year":
            value = float(round(value))

        state["submissions"][uid] = value
        return True

    @staticmethod
    def tick(state):
        now = time.time()
        phase = state["phase"]

        if phase == "guessing":
            active_uids = [uid for uid in state["player_order"] if state["active"].get(uid)]
            all_in = bool(active_uids) and all(state["submissions"].get(uid) is not None for uid in active_uids)
            if all_in and state["all_submitted_at"] is None:
                state["all_submitted_at"] = now
            grace_elapsed = state["all_submitted_at"] is not None and now - state["all_submitted_at"] >= SUBMIT_GRACE_SECONDS
            timed_out = state["guess_deadline"] is not None and now >= state["guess_deadline"]
            if grace_elapsed or timed_out:
                _finalize_round(state)
                state["phase"] = "reveal"
                state["phase_deadline"] = now + REVEAL_SECONDS

        elif phase == "reveal":
            if state["phase_deadline"] is not None and now >= state["phase_deadline"]:
                state["phase"] = "standings"
                state["phase_deadline"] = now + STANDINGS_SECONDS

        elif phase == "standings":
            if state["phase_deadline"] is not None and now >= state["phase_deadline"]:
                if state["round_index"] + 1 >= len(state["questions"]):
                    state["phase"] = "finished"
                    state["phase_deadline"] = None
                else:
                    _start_round(state, state["round_index"] + 1)

        # phase == "finished": nothing to do, check_finished() ends the session

    @staticmethod
    def check_finished(state):
        if state["phase"] != "finished":
            return None
        endscreen = _build_endscreen(state)
        winner_uid = endscreen["leaderboard"][0]["userId"] if endscreen["leaderboard"] else None
        return {"winner_user_id": winner_uid, "reason": "estimate_finished", "details": endscreen}

    @staticmethod
    def on_player_left(state, user_id):
        uid = str(user_id)
        if uid in state["active"]:
            state["active"][uid] = False
        # No further bookkeeping needed: _finalize_round / the "all active
        # submitted" tick check both re-derive the active set from
        # state["active"] fresh every time, so a departed player is simply
        # never waited on again, starting with the very next tick.

    @staticmethod
    def reset(state):
        opts = state["options"]
        recent = set(state.get("recent_question_ids", []))
        active_uids = [uid for uid in state["player_order"] if state["active"].get(uid)]

        fresh_questions = select_questions(QUESTION_BANK, opts["rounds"], opts["difficulty"], opts["categories"], recent)

        state["total_scores"] = {uid: 0 for uid in active_uids}
        state["stats"] = {uid: _new_stats() for uid in active_uids}
        state["questions"] = fresh_questions
        state["recent_question_ids"] = (state.get("recent_question_ids", []) + [q["id"] for q in fresh_questions])[-RECENT_HISTORY_CAP:]
        state["history"] = []
        _start_round(state, 0)

    @staticmethod
    def public_state(state, viewer_user_id):
        uid = str(viewer_user_id)
        phase = state["phase"]
        now = time.time()
        idx = state["round_index"]
        q = state["questions"][idx] if 0 <= idx < len(state["questions"]) else None

        base = {
            "phase": phase,
            "roundIndex": idx + 1,
            "totalRounds": len(state["questions"]),
            "players": [
                {
                    "userId": int(u),
                    "name": state["player_names"].get(u, "?"),
                    "active": state["active"].get(u, False),
                    "totalScore": state["total_scores"].get(u, 0),
                }
                for u in state["player_order"]
            ],
        }

        if phase == "guessing" and q is not None:
            seconds_left = max(0, round(state["guess_deadline"] - now)) if state["guess_deadline"] else 0
            base.update({
                "questionId": q["id"],
                "category": q["category"],
                "categoryLabel": VALID_CATEGORIES[q["category"]]["label"],
                "categoryEmoji": VALID_CATEGORIES[q["category"]]["emoji"],
                "question": q["question"],
                "unit": q["unit"],
                "type": q["type"],
                "secondsLeft": seconds_left,
                "submissions": {
                    u: (state["submissions"].get(u) is not None)
                    for u in state["player_order"] if state["active"].get(u)
                },
                "myGuess": state["submissions"].get(uid),
                "mySubmitted": state["submissions"].get(uid) is not None,
            })
        elif phase in ("reveal", "standings") and state["round_results"] is not None:
            rr = state["round_results"]
            base.update({
                "questionId": rr["questionId"],
                "category": rr["category"],
                "categoryLabel": VALID_CATEGORIES[rr["category"]]["label"],
                "categoryEmoji": VALID_CATEGORIES[rr["category"]]["emoji"],
                "question": rr["question"],
                "unit": rr["unit"],
                "type": rr["type"],
                "answer": rr["answer"],
                "displayAnswer": rr["displayAnswer"],
                "explanation": rr["explanation"],
                "sourceLabel": rr["sourceLabel"],
                "sourceUrl": rr["sourceUrl"],
                "results": rr["results"],
                "secondsLeft": max(0, round(state["phase_deadline"] - now)) if state["phase_deadline"] else 0,
            })
            if phase == "standings":
                base["standings"] = sorted(
                    (
                        {"userId": int(u), "name": state["player_names"].get(u, "?"), "score": state["total_scores"].get(u, 0)}
                        for u in state["player_order"] if state["active"].get(u)
                    ),
                    key=lambda e: -e["score"],
                )
        elif phase == "finished":
            base["endscreen"] = _build_endscreen(state)

        return base
