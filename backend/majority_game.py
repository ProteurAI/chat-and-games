"""Mehrheitsmeister - multiplayer "guess what the majority will vote for"
party game.

Implements the same engine interface documented at the top of games.py
(init_state/apply_input/tick/check_finished/reset/on_player_left/
public_state) so it plugs into the existing generic GameSession/GameManager
unchanged - see games.py for how engines are wired up and registered.

Four round types, mixed within one match:
  - "classic": everyone votes on 3-5 options; whoever picked a tied-top
    option scores.
  - "fifty": exactly 2 options, same majority-wins shape, faster/higher-
    stakes feel.
  - "unanimous": if EVERY active voter picks the same single option, it's
    a big bonus for everyone; otherwise falls back to normal majority
    scoring at a reduced rate.
  - "outsider": the rule is reversed - the WINNING answer is the rarest
    one that still got at least two votes (a single vote never counts,
    so you can't just pick something absurd on purpose).

The question bank lives in backend/data/majority_questions.json, kept
strictly separate from this file's game-flow/scoring logic (same split as
estimate_game.py/who_am_i.py/know_me.py). Loaded and validated once at
import time.

SECURITY: this is exactly as sensitive as UNO's hand or the other party
games' secret submissions. Before reveal, a player's own vote is theirs to
see back, but nobody else's vote - and no vote TALLY - may reach any
client. public_state() below is the one choke point that filters what each
socket receives; during voting only booleans ("who has submitted") go out.
"""

import random
import time
from pathlib import Path
import json

QUESTIONS_PATH = Path(__file__).resolve().parent / "data" / "majority_questions.json"

VALID_MODES = {"classic", "fifty", "unanimous", "outsider"}
VALID_TONES = {"casual", "funny", "spicy"}
VALID_CATEGORIES = {
    "food": "Essen & Trinken", "travel": "Reisen & Urlaub", "film": "Film & Unterhaltung",
    "music": "Musik", "sport": "Sport", "tech": "Technik & Alltag", "money": "Geld & Luxus",
    "relationships": "Beziehungen & Freundschaft", "home": "Alltag", "fantasy": "Fantasie & Superkräfte",
    "crazy": "Verrückte Situationen", "party": "Party & Freizeit", "mobility": "Mobilität",
    "world": "Welt & Leben", "family": "Familie", "absurd": "Komplett absurd",
}
MIN_QUESTION_BANK_SIZE = 600
OUTSIDER_MIN_PLAYERS = 5


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
        raise ValueError("majority_questions.json must contain a JSON array")

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

        mode = q.get("mode")
        if mode not in VALID_MODES:
            errors.append(f"{prefix}: invalid mode '{mode}'")
            continue

        category = q.get("category")
        if category not in VALID_CATEGORIES:
            errors.append(f"{prefix}: invalid category '{category}'")
            continue

        tone = q.get("tone")
        if tone not in VALID_TONES:
            errors.append(f"{prefix}: invalid tone '{tone}'")
            continue

        answers = q.get("answers")
        if not isinstance(answers, list):
            errors.append(f"{prefix}: answers must be a list")
            continue
        n = len(answers)
        if mode == "fifty" and n != 2:
            errors.append(f"{prefix}: fifty needs exactly 2 answers, got {n}")
            continue
        if mode == "classic" and not (3 <= n <= 5):
            errors.append(f"{prefix}: classic needs 3-5 answers, got {n}")
            continue
        if mode == "unanimous" and not (2 <= n <= 5):
            errors.append(f"{prefix}: unanimous needs 2-5 answers, got {n}")
            continue
        if mode == "outsider" and not (3 <= n <= 5):
            errors.append(f"{prefix}: outsider needs 3-5 answers, got {n}")
            continue
        if any(not isinstance(a, str) or not a.strip() for a in answers):
            errors.append(f"{prefix}: an answer is empty/invalid")
            continue
        if len(set(a.strip().lower() for a in answers)) != n:
            errors.append(f"{prefix}: duplicate answer options within one question")
            continue

        seen_ids.add(qid)
        seen_text.add(norm_text)
        questions.append({
            "id": qid, "mode": mode, "category": category, "tone": tone,
            "question": text, "answers": [a.strip() for a in answers],
        })

    if errors:
        raise ValueError(
            f"majority_questions.json validation failed ({len(errors)} problem(s)):\n"
            + "\n".join(errors[:50])
            + ("\n... (truncated)" if len(errors) > 50 else "")
        )
    if len(questions) < MIN_QUESTION_BANK_SIZE:
        raise ValueError(
            f"majority_questions.json has only {len(questions)} valid questions, "
            f"need at least {MIN_QUESTION_BANK_SIZE}"
        )
    return questions


def _load_question_bank():
    with open(QUESTIONS_PATH, encoding="utf-8") as f:
        raw = json.load(f)
    questions = validate_question_bank(raw)
    by_mode = {}
    by_cat = {}
    for q in questions:
        by_mode[q["mode"]] = by_mode.get(q["mode"], 0) + 1
        by_cat[q["category"]] = by_cat.get(q["category"], 0) + 1
    print(f"[majority_game] Question bank loaded OK. Total Questions: {len(questions)}")
    print(f"[majority_game]   Classic: {by_mode.get('classic', 0)}")
    print(f"[majority_game]   50/50: {by_mode.get('fifty', 0)}")
    print(f"[majority_game]   Unanimous: {by_mode.get('unanimous', 0)}")
    print(f"[majority_game]   Outsider: {by_mode.get('outsider', 0)}")
    for cat in VALID_CATEGORIES:
        print(f"[majority_game]   {VALID_CATEGORIES[cat]} ({cat}): {by_cat.get(cat, 0)}")
    return questions


QUESTION_BANK = _load_question_bank()
QUESTIONS_BY_MODE = {mode: [q for q in QUESTION_BANK if q["mode"] == mode] for mode in VALID_MODES}
QUESTION_BY_ID = {q["id"]: q for q in QUESTION_BANK}


# ---------- round-plan generation ----------

MODE_MIX_RATIOS = {"classic": 0.45, "fifty": 0.25, "unanimous": 0.15, "outsider": 0.15}


def _mode_quota(rounds, allow_outsider):
    ratios = dict(MODE_MIX_RATIOS)
    if not allow_outsider:
        ratios["classic"] += ratios.pop("outsider")
    raw = {m: rounds * ratio for m, ratio in ratios.items()}
    floored = {m: int(v) for m, v in raw.items()}
    remainder = rounds - sum(floored.values())
    fracs_desc = sorted(raw.keys(), key=lambda m: (raw[m] - floored[m]), reverse=True)
    for m in fracs_desc[:remainder]:
        floored[m] += 1
    return floored


def _debunch_types(types):
    """Best-effort multi-pass: avoid 3 identical round types in a row -
    same technique as know_me.py's _debunch_types."""
    result = list(types)
    for _pass in range(4):
        changed = False
        for i in range(2, len(result)):
            if result[i] == result[i - 1] == result[i - 2]:
                for j in range(i + 1, len(result)):
                    if result[j] != result[i - 1]:
                        result[i], result[j] = result[j], result[i]
                        changed = True
                        break
        if not changed:
            break
    return result


def _build_round_plan(rounds, tone, num_players, recent_ids):
    allow_outsider = num_players >= OUTSIDER_MIN_PLAYERS
    quota = _mode_quota(rounds, allow_outsider)
    types = []
    for m, n in quota.items():
        types.extend([m] * n)
    random.shuffle(types)
    types = _debunch_types(types)

    tone_set = None if tone == "mixed" else {tone}
    used_ids = set()
    plan = []
    for mode in types:
        pool = QUESTIONS_BY_MODE[mode]
        candidates = [q for q in pool if q["id"] not in used_ids and q["id"] not in recent_ids and (tone_set is None or q["tone"] in tone_set)]
        if not candidates:
            candidates = [q for q in pool if q["id"] not in used_ids and (tone_set is None or q["tone"] in tone_set)]
        if not candidates:
            candidates = [q for q in pool if q["id"] not in used_ids]
        if not candidates:
            candidates = pool  # bank exhausted for this mode (extreme edge case)
        q = random.choice(candidates)
        used_ids.add(q["id"])
        plan.append({"type": mode, "question_id": q["id"]})
    return plan


# ---------- timing / scoring constants ----------

VOTE_SECONDS = 20
REVEAL_SECONDS = 7
STANDINGS_SECONDS = 3
SUBMIT_GRACE_SECONDS = 1.0
STANDINGS_EVERY_N_ROUNDS = 3

DEFAULT_ROUNDS = 10
VALID_ROUNDS = {5, 10, 15, 20}
DEFAULT_TONE = "mixed"
VALID_TONES_OPTION = {"mixed", "casual", "funny", "spicy"}
RECENT_HISTORY_CAP = 80

CLASSIC_POINTS = 500
FIFTY_POINTS = 400
UNANIMOUS_FULL_POINTS = 800
UNANIMOUS_FALLBACK_POINTS = 300
OUTSIDER_POINTS = 600
STREAK_BONUS = {2: 50, 3: 100, 4: 150}
STREAK_BONUS_CAP = 200


def _streak_bonus(streak):
    if streak < 2:
        return 0
    return STREAK_BONUS.get(streak, STREAK_BONUS_CAP)


def _sanitize_options(options):
    options = options if isinstance(options, dict) else {}
    rounds = options.get("rounds")
    if rounds not in VALID_ROUNDS:
        rounds = DEFAULT_ROUNDS
    tone = options.get("tone")
    if tone not in VALID_TONES_OPTION:
        tone = DEFAULT_TONE
    return {"rounds": rounds, "tone": tone}


def _active_uids(state):
    return [uid for uid in state["player_order"] if state["active"].get(uid)]


def _new_stats():
    return {"majority_hits": 0, "majority_rounds": 0, "best_streak": 0, "unanimous_participations": 0, "outsider_hits": 0}


def _start_round(state, idx, now):
    state["round_index"] = idx
    spec = state["rounds"][idx]
    q = QUESTION_BY_ID[spec["question_id"]]
    state["current_round_type"] = spec["type"]
    state["current_question"] = q
    state["round_result"] = None
    state["submissions"] = {uid: None for uid in _active_uids(state)}
    state["all_submitted_at"] = None
    state["phase"] = "voting"
    state["phase_deadline"] = now + VOTE_SECONDS


def _tally(state):
    q = state["current_question"]
    voters = _active_uids(state)
    votes = {uid: state["submissions"].get(uid) for uid in voters}
    counts = [0] * len(q["answers"])
    for uid, idx in votes.items():
        if idx is not None:
            counts[idx] += 1
    return votes, counts


def _finalize_round(state):
    q = state["current_question"]
    rtype = state["current_round_type"]
    votes, counts = _tally(state)
    total_votes = sum(counts)

    unanimous_hit = False
    winning_indices = []
    points_per_winner = 0

    if rtype == "unanimous":
        distinct_chosen = {idx for idx in votes.values() if idx is not None}
        if total_votes > 0 and len(distinct_chosen) == 1:
            unanimous_hit = True
            winning_indices = list(distinct_chosen)
            points_per_winner = UNANIMOUS_FULL_POINTS
        else:
            max_count = max(counts) if counts else 0
            winning_indices = [i for i, c in enumerate(counts) if c == max_count and max_count > 0]
            points_per_winner = UNANIMOUS_FALLBACK_POINTS
    elif rtype == "outsider":
        eligible_counts = [c for c in counts if c >= 2]
        if eligible_counts:
            min_count = min(eligible_counts)
            winning_indices = [i for i, c in enumerate(counts) if c == min_count]
            points_per_winner = OUTSIDER_POINTS
    else:  # classic / fifty
        max_count = max(counts) if counts else 0
        winning_indices = [i for i, c in enumerate(counts) if c == max_count and max_count > 0]
        points_per_winner = CLASSIC_POINTS if rtype == "classic" else FIFTY_POINTS

    voter_results = []
    for uid in state["player_order"]:
        if not state["active"].get(uid):
            continue
        idx = votes.get(uid)
        submitted = idx is not None
        won = submitted and idx in winning_indices
        base_points = points_per_winner if won else 0

        streak_before = state["streaks"].get(uid, 0)
        if won and base_points > 0:
            new_streak = streak_before + 1
        else:
            new_streak = 0
        bonus = _streak_bonus(new_streak) if won and base_points > 0 else 0
        state["streaks"][uid] = new_streak

        round_points = base_points + bonus
        state["total_scores"][uid] = state["total_scores"].get(uid, 0) + round_points

        st = state["stats"].setdefault(uid, _new_stats())
        if won and base_points > 0:
            st["majority_hits"] += 1
        if submitted:
            st["majority_rounds"] += 1
        if new_streak > st["best_streak"]:
            st["best_streak"] = new_streak
        if rtype == "unanimous" and unanimous_hit and submitted:
            st["unanimous_participations"] += 1
        if rtype == "outsider" and won:
            st["outsider_hits"] += 1

        voter_results.append({
            "userId": int(uid), "submitted": submitted, "value": idx,
            "won": won, "points": round_points, "streak": new_streak, "streakBonus": bonus,
        })

    round_result = {
        "type": rtype, "questionId": q["id"], "question": q["question"], "tone": q["tone"], "category": q["category"],
        "answers": q["answers"], "counts": counts, "winningIndices": winning_indices,
        "unanimousHit": unanimous_hit, "totalVotes": total_votes, "results": voter_results,
    }
    state["round_result"] = round_result
    state["history"].append(round_result)


def _build_endscreen(state):
    active_uids = _active_uids(state)
    leaderboard = sorted(
        (
            {"userId": int(uid), "name": state["player_names"].get(uid, "?"), "score": state["total_scores"].get(uid, 0)}
            for uid in active_uids
        ),
        key=lambda e: -e["score"],
    )

    fun_stats = {}
    herd_animal = None  # most majority_hits
    mind_reader = None  # best_streak
    contrarian = None  # fewest majority_hits among those who played majority_rounds > 0
    unanimous_champ = None  # most unanimous_participations

    for uid in active_uids:
        st = state["stats"].get(uid)
        if not st:
            continue
        if st["majority_hits"] > 0 and (herd_animal is None or st["majority_hits"] > herd_animal["value"]):
            herd_animal = {"userId": int(uid), "name": state["player_names"].get(uid, "?"), "value": st["majority_hits"]}
        if st["best_streak"] > 0 and (mind_reader is None or st["best_streak"] > mind_reader["value"]):
            mind_reader = {"userId": int(uid), "name": state["player_names"].get(uid, "?"), "value": st["best_streak"]}
        if st["majority_rounds"] > 0 and (contrarian is None or st["majority_hits"] < contrarian["value"]):
            contrarian = {"userId": int(uid), "name": state["player_names"].get(uid, "?"), "value": st["majority_hits"]}
        if st["unanimous_participations"] > 0 and (unanimous_champ is None or st["unanimous_participations"] > unanimous_champ["value"]):
            unanimous_champ = {"userId": int(uid), "name": state["player_names"].get(uid, "?"), "value": st["unanimous_participations"]}

    if herd_animal:
        fun_stats["herdAnimal"] = {"userId": herd_animal["userId"], "name": herd_animal["name"], "label": "👑 Herdentier", "detail": f"{herd_animal['value']}x die Mehrheit getroffen"}
    if mind_reader:
        fun_stats["mindReader"] = {"userId": mind_reader["userId"], "name": mind_reader["name"], "label": "🔮 Gedankenleser", "detail": f"Längste Serie: {mind_reader['value']}"}
    if contrarian:
        fun_stats["contrarian"] = {"userId": contrarian["userId"], "name": contrarian["name"], "label": "🎭 Querdenker", "detail": f"Nur {contrarian['value']}x mit der Mehrheit"}
    if unanimous_champ:
        fun_stats["unanimousChamp"] = {"userId": unanimous_champ["userId"], "name": unanimous_champ["name"], "label": "🔥 Einstimmig", "detail": f"{unanimous_champ['value']}x dabei"}

    return {"leaderboard": leaderboard, "funStats": fun_stats, "totalRounds": len(state["rounds"])}


class MajorityGameEngine:
    game_type = "majority"
    name = "Mehrheitsmeister"
    emoji = "👑"
    min_players = 3
    max_players = 16
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
            "streaks": {uid: 0 for uid in uids},
            "stats": {uid: _new_stats() for uid in uids},
            "recent_question_ids": [],
            "rounds": [],
            "round_index": -1,
            "current_round_type": None,
            "current_question": None,
            "submissions": {},
            "all_submitted_at": None,
            "round_result": None,
            "phase": "voting",
            "phase_deadline": None,
            "history": [],
        }
        state["rounds"] = _build_round_plan(opts["rounds"], opts["tone"], len(uids), set())
        state["recent_question_ids"] = [r["question_id"] for r in state["rounds"]]
        _start_round(state, 0, time.time())
        return state

    @staticmethod
    def apply_input(state, user_id, payload):
        uid = str(user_id)
        if state["phase"] != "voting":
            return False
        if not state["active"].get(uid):
            return False
        if uid not in state["submissions"] or state["submissions"][uid] is not None:
            return False
        if payload.get("action") != "submit_vote":
            return False
        idx = payload.get("value")
        q = state["current_question"]
        if not isinstance(idx, int) or not (0 <= idx < len(q["answers"])):
            return False
        state["submissions"][uid] = idx
        return True

    @staticmethod
    def tick(state):
        now = time.time()
        phase = state["phase"]

        if phase == "voting":
            eligible = list(state["submissions"].keys())
            active_eligible = [u for u in eligible if state["active"].get(u)]
            all_in = bool(active_eligible) and all(state["submissions"][u] is not None for u in active_eligible)
            if all_in and state["all_submitted_at"] is None:
                state["all_submitted_at"] = now
            grace_elapsed = state["all_submitted_at"] is not None and now - state["all_submitted_at"] >= SUBMIT_GRACE_SECONDS
            timed_out = state["phase_deadline"] is not None and now >= state["phase_deadline"]
            if grace_elapsed or timed_out:
                _finalize_round(state)
                state["phase"] = "reveal"
                state["phase_deadline"] = now + REVEAL_SECONDS

        elif phase == "reveal":
            if state["phase_deadline"] is not None and now >= state["phase_deadline"]:
                round_num = state["round_index"] + 1
                is_last = round_num >= len(state["rounds"])
                show_standings = (round_num % STANDINGS_EVERY_N_ROUNDS == 0) and not is_last
                if show_standings:
                    state["phase"] = "standings"
                    state["phase_deadline"] = now + STANDINGS_SECONDS
                else:
                    _advance_or_finish(state, now)

        elif phase == "standings":
            if state["phase_deadline"] is not None and now >= state["phase_deadline"]:
                _advance_or_finish(state, now)

    @staticmethod
    def check_finished(state):
        if state["phase"] != "finished":
            return None
        endscreen = _build_endscreen(state)
        winner_uid = endscreen["leaderboard"][0]["userId"] if endscreen["leaderboard"] else None
        return {"winner_user_id": winner_uid, "reason": "majority_finished", "details": endscreen}

    @staticmethod
    def on_player_left(state, user_id):
        uid = str(user_id)
        if uid not in state["active"]:
            return
        state["active"][uid] = False
        # tick()'s "all active submitted" check re-derives active_eligible
        # fresh every time, so a departed voter is simply never waited on
        # again starting with the very next tick - no further bookkeeping
        # needed here, matching the pattern in every other party game engine.

    @staticmethod
    def reset(state):
        opts = state["options"]
        active_uids = _active_uids(state)
        recent = set(state.get("recent_question_ids", []))

        fresh_rounds = _build_round_plan(opts["rounds"], opts["tone"], len(active_uids), recent)

        state["total_scores"] = {uid: 0 for uid in active_uids}
        state["streaks"] = {uid: 0 for uid in active_uids}
        state["stats"] = {uid: _new_stats() for uid in active_uids}
        state["rounds"] = fresh_rounds
        state["recent_question_ids"] = (state.get("recent_question_ids", []) + [r["question_id"] for r in fresh_rounds])[-RECENT_HISTORY_CAP:]
        state["history"] = []
        _start_round(state, 0, time.time())

    @staticmethod
    def public_state(state, viewer_user_id):
        uid = str(viewer_user_id)
        now = time.time()
        phase = state["phase"]

        base = {
            "phase": phase,
            "roundIndex": state["round_index"] + 1,
            "totalRounds": len(state["rounds"]),
            "roundType": state["current_round_type"],
            "players": [
                {"userId": int(u), "name": state["player_names"].get(u, "?"), "active": state["active"].get(u, False),
                 "score": state["total_scores"].get(u, 0), "streak": state["streaks"].get(u, 0)}
                for u in state["player_order"]
            ],
            "secondsLeft": max(0, round(state["phase_deadline"] - now)) if state["phase_deadline"] else 0,
        }

        q = state["current_question"]
        if q is not None and phase == "voting":
            eligible = [u for u in state["submissions"].keys() if state["active"].get(u)]
            base.update({
                "questionId": q["id"], "question": q["question"], "tone": q["tone"], "category": q["category"],
                "answers": q["answers"],
                "submissionStatus": {u: (state["submissions"][u] is not None) for u in eligible},
                "myVote": state["submissions"].get(uid),
                "mySubmitted": state["submissions"].get(uid) is not None,
            })
        elif phase in ("reveal", "standings") and state["round_result"] is not None:
            base["roundResult"] = state["round_result"]
            if phase == "standings":
                base["standings"] = sorted(
                    (
                        {"userId": int(u), "name": state["player_names"].get(u, "?"), "score": state["total_scores"].get(u, 0)}
                        for u in _active_uids(state)
                    ),
                    key=lambda e: -e["score"],
                )
        elif phase == "finished":
            base["endscreen"] = _build_endscreen(state)

        return base


def _advance_or_finish(state, now):
    next_idx = state["round_index"] + 1
    if next_idx >= len(state["rounds"]):
        state["phase"] = "finished"
        state["phase_deadline"] = None
    else:
        _start_round(state, next_idx, now)
