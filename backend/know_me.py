"""Kennst du mich? - multiplayer "how well do you know each other" party game.

Implements the same engine interface documented at the top of games.py
(init_state/apply_input/tick/check_finished/reset/on_player_left/
public_state) so it plugs into the existing generic GameSession/GameManager
unchanged - see games.py for how engines are wired up and registered.

Three round types, mixed within one match:
  - "choice": a rotating TARGET player secretly picks one of several
    options: everyone else then guesses what they picked.
  - "scale": same target/guesser shape, but the target picks a 1-10 value.
  - "group_vote": no target - every active player votes for WHICH other
    player (or themselves) best fits a prompt; the plurality wins.

The question bank lives in backend/data/know_me_questions.json, kept
strictly separate from this file's game-flow/scoring logic (same split as
estimate_game.py/who_am_i.py). Loaded and validated once at import time.

SECURITY: this is exactly as sensitive as UNO's hand or Wer-bin-ich's
identity assignment. During a choice/scale round's guessing phase, the
target's secret pick must never reach a guesser's client, and no guesser's
individual submission may reach the target or any other guesser, until the
server-computed reveal. public_state() below is the one choke point that
filters what each socket receives - the raw state["target_answer"] and
state["submissions"] dicts are never sent as-is.
"""

import random
import time
from pathlib import Path
import json

QUESTIONS_PATH = Path(__file__).resolve().parent / "data" / "know_me_questions.json"

VALID_MODES = {"choice", "scale", "group_vote"}
VALID_TONES = {"casual", "funny", "spicy"}
TONE_META = {
    "casual": {"label": "Locker", "emoji": "🙂"},
    "funny": {"label": "Lustig", "emoji": "😂"},
    "spicy": {"label": "Frech", "emoji": "🌶"},
}
MIN_QUESTION_BANK_SIZE = 300


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
        raise ValueError("know_me_questions.json must contain a JSON array")

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

        tone = q.get("tone")
        if tone not in VALID_TONES:
            errors.append(f"{prefix}: invalid tone '{tone}'")
            continue

        cleaned = {"id": qid, "mode": mode, "question": text, "tone": tone}

        if mode == "choice":
            answers = q.get("answers")
            if not isinstance(answers, list) or not (3 <= len(answers) <= 5):
                errors.append(f"{prefix}: choice needs 3-5 answers, got {answers!r}")
                continue
            if any(not isinstance(a, str) or not a.strip() for a in answers):
                errors.append(f"{prefix}: choice has an empty/invalid answer")
                continue
            cleaned["answers"] = [a.strip() for a in answers]

        elif mode == "scale":
            lo, hi = q.get("min"), q.get("max")
            min_label, max_label = (q.get("minLabel") or "").strip(), (q.get("maxLabel") or "").strip()
            if not isinstance(lo, int) or not isinstance(hi, int) or lo >= hi:
                errors.append(f"{prefix}: scale needs integer min < max, got min={lo!r} max={hi!r}")
                continue
            if not min_label or not max_label:
                errors.append(f"{prefix}: scale needs non-empty minLabel/maxLabel")
                continue
            cleaned.update({"min": lo, "max": hi, "minLabel": min_label, "maxLabel": max_label})

        # group_vote needs nothing beyond question/tone.

        seen_ids.add(qid)
        seen_text.add(norm_text)
        questions.append(cleaned)

    if errors:
        raise ValueError(
            f"know_me_questions.json validation failed ({len(errors)} problem(s)):\n"
            + "\n".join(errors[:50])
            + ("\n... (truncated)" if len(errors) > 50 else "")
        )
    if len(questions) < MIN_QUESTION_BANK_SIZE:
        raise ValueError(
            f"know_me_questions.json has only {len(questions)} valid questions, "
            f"need at least {MIN_QUESTION_BANK_SIZE}"
        )
    return questions


def _load_question_bank():
    with open(QUESTIONS_PATH, encoding="utf-8") as f:
        raw = json.load(f)
    questions = validate_question_bank(raw)
    by_mode = {}
    for q in questions:
        by_mode[q["mode"]] = by_mode.get(q["mode"], 0) + 1
    print(f"[know_me] Question bank loaded OK. Total Questions: {len(questions)}")
    print(f"[know_me]   Choice: {by_mode.get('choice', 0)}")
    print(f"[know_me]   Scale: {by_mode.get('scale', 0)}")
    print(f"[know_me]   Group Vote: {by_mode.get('group_vote', 0)}")
    return questions


QUESTION_BANK = _load_question_bank()
QUESTIONS_BY_MODE = {mode: [q for q in QUESTION_BANK if q["mode"] == mode] for mode in VALID_MODES}


# ---------- round-plan generation ----------

MODE_MIX_RATIOS = {"choice": 0.4, "scale": 0.3, "group_vote": 0.3}


def _mode_quota(rounds):
    raw = {m: rounds * ratio for m, ratio in MODE_MIX_RATIOS.items()}
    floored = {m: int(v) for m, v in raw.items()}
    remainder = rounds - sum(floored.values())
    fracs_desc = sorted(raw.keys(), key=lambda m: (raw[m] - floored[m]), reverse=True)
    for m in fracs_desc[:remainder]:
        floored[m] += 1
    return floored


def _debunch_types(types):
    """Best-effort: avoid 3 identical round types in a row, mirroring
    estimate_game.py's _debunch_categories - run a few passes since a single
    left-to-right swap pass can leave (or even create) a violation further
    down the list that only a follow-up pass catches."""
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


def _build_round_plan(rounds, tone):
    quota = _mode_quota(rounds)
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
        candidates = [q for q in pool if q["id"] not in used_ids and (tone_set is None or q["tone"] in tone_set)]
        if not candidates:
            candidates = [q for q in pool if q["id"] not in used_ids]
        if not candidates:
            candidates = pool  # bank exhausted for this mode (extreme edge case) - allow repeats rather than crash
        q = random.choice(candidates)
        used_ids.add(q["id"])
        plan.append({"type": mode, "question_id": q["id"]})
    return plan


# ---------- timing / scoring constants ----------

TARGET_ANSWER_SECONDS = 20
GUESS_SECONDS = 20
REVEAL_SECONDS = 6
STANDINGS_SECONDS = 5
SUBMIT_GRACE_SECONDS = 0.6
STANDINGS_EVERY_N_ROUNDS = 3

DEFAULT_ROUNDS = 10
VALID_ROUNDS = {5, 10, 15, 20}
DEFAULT_TONE = "mixed"
VALID_TONES_OPTION = {"mixed", "casual", "funny", "spicy"}

CHOICE_CORRECT_POINTS = 500
CHOICE_TARGET_POINTS_PER_WRONG = 100
SCALE_BUCKET_POINTS = [500, 350, 250, 150, 75]  # index = |delta| (0..4); 5+ = 0
GROUP_VOTE_MAJORITY_POINTS = 300


def _sanitize_options(options):
    options = options if isinstance(options, dict) else {}
    rounds = options.get("rounds")
    if rounds not in VALID_ROUNDS:
        rounds = DEFAULT_ROUNDS
    tone = options.get("tone")
    if tone not in VALID_TONES_OPTION:
        tone = DEFAULT_TONE
    return {"rounds": rounds, "tone": tone}


def _scale_points(delta):
    d = abs(delta)
    if d >= len(SCALE_BUCKET_POINTS):
        return 0
    return SCALE_BUCKET_POINTS[d]


def _active_uids(state):
    return [uid for uid in state["player_order"] if state["active"].get(uid)]


def _start_round(state, idx, now):
    state["round_index"] = idx
    spec = state["rounds"][idx]
    q = QUESTION_BY_ID[spec["question_id"]]
    state["current_round_type"] = spec["type"]
    state["current_question"] = q
    state["round_result"] = None
    state["round_skipped"] = False

    if spec["type"] in ("choice", "scale"):
        target_uid = _next_target(state)
        state["current_target_uid"] = target_uid
        state["target_answer"] = None
        state["submissions"] = {}
        state["all_submitted_at"] = None
        if target_uid is None:
            # No active player left to be the target (extreme edge case,
            # e.g. everyone but one disconnected) - skip straight to the
            # next round rather than stall on an impossible phase.
            state["phase"] = "reveal"
            state["round_skipped"] = True
        else:
            state["phase"] = "target_answer"
            state["phase_deadline"] = now + TARGET_ANSWER_SECONDS
    else:
        state["current_target_uid"] = None
        state["target_answer"] = None
        state["submissions"] = {uid: None for uid in _active_uids(state)}
        state["all_submitted_at"] = None
        state["phase"] = "guessing"
        state["phase_deadline"] = now + GUESS_SECONDS


def _next_target(state):
    queue = state["target_rotation_queue"]
    for _ in range(len(queue)):
        uid = queue.pop(0)
        queue.append(uid)
        if state["active"].get(uid):
            return uid
    return None


def _finalize_choice_or_scale(state):
    q = state["current_question"]
    target_uid = state["current_target_uid"]
    answer = state["target_answer"]
    guessers = [uid for uid in _active_uids(state) if uid != target_uid]

    results = []
    if q["mode"] == "choice":
        wrong_count = 0
        for uid in guessers:
            val = state["submissions"].get(uid)
            if val is None:
                results.append({"userId": int(uid), "submitted": False, "value": None, "correct": False, "points": 0})
                continue
            correct = val == answer
            points = CHOICE_CORRECT_POINTS if correct else 0
            if not correct:
                wrong_count += 1
            state["total_scores"][uid] = state["total_scores"].get(uid, 0) + points
            st = state["stats"].setdefault(uid, _new_stats())
            st["choice_guesses"] += 1
            if correct:
                st["choice_correct"] += 1
            results.append({"userId": int(uid), "submitted": True, "value": val, "correct": correct, "points": points})
        target_points = CHOICE_TARGET_POINTS_PER_WRONG * wrong_count
        state["total_scores"][target_uid] = state["total_scores"].get(target_uid, 0) + target_points
        st = state["stats"].setdefault(target_uid, _new_stats())
        st["times_target"] += 1
        st["times_misjudged"] += wrong_count
    else:  # scale
        target_points = 0
        for uid in guessers:
            val = state["submissions"].get(uid)
            if val is None:
                results.append({"userId": int(uid), "submitted": False, "value": None, "delta": None, "points": 0})
                continue
            delta = val - answer
            points = _scale_points(delta)
            state["total_scores"][uid] = state["total_scores"].get(uid, 0) + points
            st = state["stats"].setdefault(uid, _new_stats())
            st["scale_guesses"] += 1
            if delta == 0:
                st["scale_exact"] += 1
            results.append({"userId": int(uid), "submitted": True, "value": val, "delta": delta, "points": points})
        st = state["stats"].setdefault(target_uid, _new_stats())
        st["times_target"] += 1

    round_result = {
        "type": q["mode"],
        "questionId": q["id"], "question": q["question"], "tone": q["tone"],
        "targetUserId": int(target_uid), "targetName": state["player_names"].get(target_uid, "?"),
        "answer": answer,
        "results": results,
        "targetPoints": target_points,
    }
    if q["mode"] == "choice":
        round_result["answers"] = q["answers"]
    else:
        round_result.update({"min": q["min"], "max": q["max"], "minLabel": q["minLabel"], "maxLabel": q["maxLabel"]})

    state["round_result"] = round_result
    state["history"].append(round_result)


def _finalize_group_vote(state):
    q = state["current_question"]
    voters = _active_uids(state)
    votes = {uid: state["submissions"].get(uid) for uid in voters}

    counts = {}
    for uid, target in votes.items():
        if target is None:
            continue
        counts[target] = counts.get(target, 0) + 1

    max_count = max(counts.values()) if counts else 0
    winners = [uid for uid, c in counts.items() if c == max_count] if max_count > 0 else []

    vote_entries = []
    for uid in voters:
        target = votes.get(uid)
        submitted = target is not None
        points = GROUP_VOTE_MAJORITY_POINTS if (submitted and target in winners) else 0
        if points:
            state["total_scores"][uid] = state["total_scores"].get(uid, 0) + points
        vote_entries.append({
            "userId": int(uid), "submitted": submitted,
            "votedFor": int(target) if submitted else None, "points": points,
        })
        if submitted:
            st = state["stats"].setdefault(target, _new_stats())
            st["group_vote_received"] += 1

    round_result = {
        "type": "group_vote",
        "questionId": q["id"], "question": q["question"], "tone": q["tone"],
        "voteCounts": {str(k): v for k, v in counts.items()},
        "winners": [int(w) for w in winners],
        "votes": vote_entries,
    }
    state["round_result"] = round_result
    state["history"].append(round_result)


def _new_stats():
    return {
        "choice_guesses": 0, "choice_correct": 0,
        "scale_guesses": 0, "scale_exact": 0,
        "times_target": 0, "times_misjudged": 0,
        "group_vote_received": 0,
    }


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
    best_reader = None  # most exact scale hits
    biggest_mystery = None  # most-misjudged as target in choice rounds
    group_magnet = None  # most group-vote-received

    for uid in active_uids:
        st = state["stats"].get(uid)
        if not st:
            continue
        if st["scale_exact"] > 0 and (best_reader is None or st["scale_exact"] > best_reader["value"]):
            best_reader = {"userId": int(uid), "name": state["player_names"].get(uid, "?"), "value": st["scale_exact"]}
        if st["times_misjudged"] > 0 and (biggest_mystery is None or st["times_misjudged"] > biggest_mystery["value"]):
            biggest_mystery = {"userId": int(uid), "name": state["player_names"].get(uid, "?"), "value": st["times_misjudged"]}
        if st["group_vote_received"] > 0 and (group_magnet is None or st["group_vote_received"] > group_magnet["value"]):
            group_magnet = {"userId": int(uid), "name": state["player_names"].get(uid, "?"), "value": st["group_vote_received"]}

    if best_reader:
        fun_stats["mindReader"] = {"userId": best_reader["userId"], "name": best_reader["name"],
                                    "label": "🎯 Gedankenleser", "detail": f"{best_reader['value']} exakte Treffer"}
    if biggest_mystery:
        fun_stats["bigMystery"] = {"userId": biggest_mystery["userId"], "name": biggest_mystery["name"],
                                    "label": "🕵️ Das große Rätsel", "detail": f"{biggest_mystery['value']}x falsch eingeschätzt"}
    if group_magnet:
        fun_stats["groupMagnet"] = {"userId": group_magnet["userId"], "name": group_magnet["name"],
                                     "label": "👑 Gruppenmagnet", "detail": f"{group_magnet['value']}x gewählt"}

    return {"leaderboard": leaderboard, "funStats": fun_stats, "totalRounds": len(state["rounds"])}


class KnowMeEngine:
    game_type = "knowme"
    name = "Kennst du mich?"
    emoji = "❤️"
    min_players = 3
    max_players = 12
    manual_start = True
    tick_interval = 1.0

    @staticmethod
    def init_state(players, options=None):
        opts = _sanitize_options(options)
        uids = [str(p["user_id"]) for p in players]

        rotation = list(uids)
        random.shuffle(rotation)

        state = {
            "options": opts,
            "player_order": uids,
            "player_names": {str(p["user_id"]): p["name"] for p in players},
            "active": {uid: True for uid in uids},
            "total_scores": {uid: 0 for uid in uids},
            "stats": {uid: _new_stats() for uid in uids},
            "target_rotation_queue": rotation,
            "rounds": _build_round_plan(opts["rounds"], opts["tone"]),
            "round_index": -1,
            "current_round_type": None,
            "current_question": None,
            "current_target_uid": None,
            "target_answer": None,
            "submissions": {},
            "all_submitted_at": None,
            "round_result": None,
            "round_skipped": False,
            "phase": "target_answer",
            "phase_deadline": None,
            "history": [],
        }
        _start_round(state, 0, time.time())
        return state

    @staticmethod
    def apply_input(state, user_id, payload):
        uid = str(user_id)
        if state["phase"] in ("finished",):
            return False
        if not state["active"].get(uid):
            return False
        action = payload.get("action")

        if state["phase"] == "target_answer":
            if uid != state["current_target_uid"] or action != "submit_target":
                return False
            q = state["current_question"]
            value = payload.get("value")
            if q["mode"] == "choice":
                if not isinstance(value, int) or not (0 <= value < len(q["answers"])):
                    return False
            else:
                if not isinstance(value, int) or not (q["min"] <= value <= q["max"]):
                    return False
            state["target_answer"] = value
            now = time.time()
            state["phase"] = "guessing"
            state["phase_deadline"] = now + GUESS_SECONDS
            state["submissions"] = {u: None for u in _active_uids(state) if u != uid}
            state["all_submitted_at"] = None
            return True

        if state["phase"] == "guessing":
            if uid not in state["submissions"] or state["submissions"][uid] is not None:
                return False
            q = state["current_question"]
            if q["mode"] == "choice":
                if action != "submit_guess":
                    return False
                value = payload.get("value")
                if not isinstance(value, int) or not (0 <= value < len(q["answers"])):
                    return False
            elif q["mode"] == "scale":
                if action != "submit_guess":
                    return False
                value = payload.get("value")
                if not isinstance(value, int) or not (q["min"] <= value <= q["max"]):
                    return False
            else:  # group_vote
                if action != "submit_vote":
                    return False
                value = payload.get("target_user_id")
                value = str(value) if value is not None else None
                if value not in state["submissions"]:
                    return False
            state["submissions"][uid] = value
            return True

        return False

    @staticmethod
    def tick(state):
        now = time.time()
        phase = state["phase"]

        if phase == "target_answer":
            if state["phase_deadline"] is not None and now >= state["phase_deadline"]:
                # Target never answered in time - skip this round entirely
                # rather than fabricate a fake answer (matches the "kurze
                # Grace Period... Runde ueberspringen" disconnect spec).
                state["round_skipped"] = True
                state["phase"] = "reveal"
                state["phase_deadline"] = now + REVEAL_SECONDS

        elif phase == "guessing":
            eligible = list(state["submissions"].keys())
            all_in = bool(eligible) and all(state["submissions"][u] is not None for u in eligible if state["active"].get(u))
            if all_in and state["all_submitted_at"] is None:
                state["all_submitted_at"] = now
            grace_elapsed = state["all_submitted_at"] is not None and now - state["all_submitted_at"] >= SUBMIT_GRACE_SECONDS
            timed_out = state["phase_deadline"] is not None and now >= state["phase_deadline"]
            if grace_elapsed or timed_out:
                if state["current_round_type"] == "group_vote":
                    _finalize_group_vote(state)
                else:
                    _finalize_choice_or_scale(state)
                state["phase"] = "reveal"
                state["phase_deadline"] = now + REVEAL_SECONDS

        elif phase == "reveal":
            if state["phase_deadline"] is not None and now >= state["phase_deadline"]:
                _advance_after_reveal(state, now)

        # phase == "standings": handled below (separate branch, same tick call)
        if phase == "standings":
            if state["phase_deadline"] is not None and now >= state["phase_deadline"]:
                _advance_to_next_round_or_finish(state, now)

    @staticmethod
    def check_finished(state):
        if state["phase"] != "finished":
            return None
        endscreen = _build_endscreen(state)
        winner_uid = endscreen["leaderboard"][0]["userId"] if endscreen["leaderboard"] else None
        return {"winner_user_id": winner_uid, "reason": "knowme_finished", "details": endscreen}

    @staticmethod
    def on_player_left(state, user_id):
        uid = str(user_id)
        if uid not in state["active"]:
            return
        state["active"][uid] = False
        if state["phase"] == "finished":
            return

        if uid == state["current_target_uid"] and state["phase"] == "target_answer":
            state["round_skipped"] = True
            state["phase"] = "reveal"
            state["phase_deadline"] = time.time() + REVEAL_SECONDS
        # else: if they were mid-guessing/voting, tick()'s "all_in" check
        # already re-derives eligibility from state["active"] fresh every
        # time, so a departed guesser/voter is simply never waited on again.

    @staticmethod
    def reset(state):
        opts = state["options"]
        active_uids = _active_uids(state)
        fresh = KnowMeEngine.init_state(
            [{"user_id": int(uid), "name": state["player_names"][uid]} for uid in active_uids],
            opts,
        )
        state.clear()
        state.update(fresh)

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
                 "score": state["total_scores"].get(u, 0)}
                for u in state["player_order"]
            ],
            "secondsLeft": max(0, round(state["phase_deadline"] - now)) if state["phase_deadline"] else 0,
            "roundSkipped": state.get("round_skipped", False),
        }

        q = state["current_question"]
        if q is not None and phase in ("target_answer", "guessing"):
            target_uid = state["current_target_uid"]
            base.update({
                "questionId": q["id"], "question": q["question"], "tone": q["tone"],
            })
            if q["mode"] in ("choice", "scale"):
                base["targetUserId"] = int(target_uid) if target_uid else None
                base["targetName"] = state["player_names"].get(target_uid, "?") if target_uid else None
                base["isTarget"] = uid == target_uid
                if q["mode"] == "choice":
                    base["answers"] = q["answers"]
                else:
                    base.update({"min": q["min"], "max": q["max"], "minLabel": q["minLabel"], "maxLabel": q["maxLabel"]})

                if phase == "target_answer":
                    pass  # nothing further to reveal - guessers just wait
                else:  # guessing
                    eligible = [u for u in state["submissions"].keys() if state["active"].get(u)]
                    base["submissionStatus"] = {u: (state["submissions"][u] is not None) for u in eligible}
                    if uid != target_uid:
                        base["myGuess"] = state["submissions"].get(uid)
                        base["mySubmitted"] = state["submissions"].get(uid) is not None
            else:  # group_vote
                base["players_votable"] = [
                    {"userId": int(u), "name": state["player_names"].get(u, "?")}
                    for u in _active_uids(state)
                ]
                eligible = [u for u in state["submissions"].keys() if state["active"].get(u)]
                base["submissionStatus"] = {u: (state["submissions"][u] is not None) for u in eligible}
                base["myVote"] = state["submissions"].get(uid)
                base["mySubmitted"] = state["submissions"].get(uid) is not None

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
        elif phase == "reveal" and state.get("round_skipped"):
            base["roundResult"] = None

        elif phase == "finished":
            base["endscreen"] = _build_endscreen(state)

        return base


def _advance_after_reveal(state, now):
    round_num = state["round_index"] + 1  # 1-based count of rounds completed
    is_last = round_num >= len(state["rounds"])
    show_standings = (round_num % STANDINGS_EVERY_N_ROUNDS == 0) or is_last
    if show_standings and not is_last:
        state["phase"] = "standings"
        state["phase_deadline"] = now + STANDINGS_SECONDS
    else:
        _advance_to_next_round_or_finish(state, now)


def _advance_to_next_round_or_finish(state, now):
    next_idx = state["round_index"] + 1
    if next_idx >= len(state["rounds"]):
        state["phase"] = "finished"
        state["phase_deadline"] = None
    else:
        _start_round(state, next_idx, now)


# Populated after class definition to avoid a forward-reference issue with
# the module-level QUESTION_BANK list comprehension above.
QUESTION_BY_ID = {q["id"]: q for q in QUESTION_BANK}
