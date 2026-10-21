"""Sortiermeister - party game: put five things into the right order.

Implements the engine interface documented at the top of games.py, same
pattern as majority_game.py (all players play every round at the same time,
the server owns questions, scoring and secrecy).

Round: a question with five items shown in a shuffled order. Every player
drags them into the order they think is right and locks it in
("EINLOGGEN"). Then the real order is revealed.

Scoring per round (per item that was put at position p whose true place is r):
  |p - r| == 0 -> 2 points,  |p - r| == 1 -> 1 point,  otherwise 0
  all five exactly right -> +3 bonus  (a round is worth 0..13)

The question bank is backend/data/sort_questions.json, listed in the
CORRECT order (values strictly monotone, validated at import). SECURITY:
the values and the true order never reach a client before the reveal -
public_state() is the one choke point; during sorting only the shuffled
labels and "who has locked in" booleans go out.
"""

import json
import random
import time
from pathlib import Path

QUESTIONS_PATH = Path(__file__).resolve().parent / "data" / "sort_questions.json"

VALID_CATEGORIES = {
    "tiere": "Tiere", "technik": "Technik", "essen": "Essen & Trinken", "geografie": "Geografie",
    "geschichte": "Geschichte", "film": "Film & Popkultur", "sport": "Sport", "alltag": "Alltag",
    "at_de": "Österreich & Deutschland", "absurd": "Absurde Fakten",
}
ITEMS_PER_ROUND = 5
MIN_QUESTION_BANK_SIZE = 80
VALID_ROUNDS = (5, 10, 15)
DEFAULT_ROUNDS = 10
SORT_SECONDS = 75
SUBMIT_GRACE_SECONDS = 1.5
REVEAL_SECONDS = 45          # everybody can skip with "Weiter" once all have seen it
POINTS_EXACT, POINTS_NEAR, BONUS_ALL = 2, 1, 3
RECENT_HISTORY_CAP = 40


def validate_question_bank(raw):
    """Returns the cleaned list; raises ValueError listing every problem."""
    errors, seen_ids, seen_text, out = [], set(), set(), []
    if not isinstance(raw, list):
        raise ValueError("sort_questions.json must contain a JSON array")
    for i, q in enumerate(raw):
        where = f"#{i}"
        if not isinstance(q, dict):
            errors.append(f"{where}: not an object"); continue
        qid, cat, text, direction = q.get("id"), q.get("category"), q.get("question"), q.get("direction")
        items = q.get("items")
        if not isinstance(qid, str) or not qid or qid in seen_ids:
            errors.append(f"{where}: missing / duplicate id {qid!r}")
        seen_ids.add(qid)
        if cat not in VALID_CATEGORIES:
            errors.append(f"{where} ({qid}): unknown category {cat!r}")
        if not isinstance(text, str) or not text.strip() or text in seen_text:
            errors.append(f"{where} ({qid}): missing / duplicate question")
        seen_text.add(text)
        if not isinstance(direction, str) or not direction.strip():
            errors.append(f"{where} ({qid}): missing direction")
        if not isinstance(q.get("explanation"), str) or not q["explanation"].strip():
            errors.append(f"{where} ({qid}): missing explanation")
        if not isinstance(items, list) or len(items) != ITEMS_PER_ROUND:
            errors.append(f"{where} ({qid}): needs exactly {ITEMS_PER_ROUND} items"); continue
        labels = [it.get("label") if isinstance(it, dict) else None for it in items]
        vals = [it.get("value") if isinstance(it, dict) else None for it in items]
        if any(not isinstance(l, str) or not l.strip() for l in labels) or len(set(labels)) != ITEMS_PER_ROUND:
            errors.append(f"{where} ({qid}): item labels must be distinct non-empty strings")
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in vals):
            errors.append(f"{where} ({qid}): item values must be numbers"); continue
        asc = all(a < b for a, b in zip(vals, vals[1:]))
        desc = all(a > b for a, b in zip(vals, vals[1:]))
        if not (asc or desc):
            errors.append(f"{where} ({qid}): values must be strictly monotone in the listed (correct) order: {vals}")
        out.append(q)
    if errors:
        raise ValueError(f"sort_questions.json validation failed ({len(errors)} problem(s)):\n  " + "\n  ".join(errors[:30]))
    if len(out) < MIN_QUESTION_BANK_SIZE:
        raise ValueError(f"sort_questions.json has only {len(out)} questions, need at least {MIN_QUESTION_BANK_SIZE}")
    return out


def _load():
    with open(QUESTIONS_PATH, encoding="utf-8") as f:
        qs = validate_question_bank(json.load(f))
    print(f"[sort_game] Question bank loaded OK. Total Questions: {len(qs)}")
    return qs


QUESTIONS = _load()
QUESTION_BY_ID = {q["id"]: q for q in QUESTIONS}


def score_order(order):
    """order: list of true ranks (0..4) in the order the player placed the items.
    -> (points per position, bonus, total)"""
    per = []
    for pos, rank in enumerate(order):
        d = abs(pos - rank)
        per.append(POINTS_EXACT if d == 0 else POINTS_NEAR if d == 1 else 0)
    bonus = BONUS_ALL if all(p == POINTS_EXACT for p in per) else 0
    return per, bonus, sum(per) + bonus


def _pick_questions(n, recent):
    pool = [q["id"] for q in QUESTIONS if q["id"] not in recent]
    if len(pool) < n:
        pool = [q["id"] for q in QUESTIONS]
    random.shuffle(pool)
    # spread the categories a little: no more than two of a kind in a row
    chosen = []
    rest = pool[:]
    while len(chosen) < n and rest:
        for qid in rest:
            cats = [QUESTION_BY_ID[c]["category"] for c in chosen[-2:]]
            if not (len(cats) == 2 and cats[0] == cats[1] == QUESTION_BY_ID[qid]["category"]):
                chosen.append(qid); rest.remove(qid); break
        else:
            chosen.append(rest.pop(0))
    return chosen


def _sanitize_options(options):
    options = options if isinstance(options, dict) else {}
    rounds = options.get("rounds")
    return {"rounds": rounds if rounds in VALID_ROUNDS else DEFAULT_ROUNDS}


def _active_uids(state):
    return [u for u in state["player_order"] if state["active"].get(u)]


def _start_round(state, idx, now):
    state["round_index"] = idx
    q = QUESTION_BY_ID[state["rounds"][idx]]
    state["current"] = q
    # display order: a shuffle of the correct order that is never the correct order itself
    ids = list(range(ITEMS_PER_ROUND))
    for _ in range(20):
        random.shuffle(ids)
        if ids != list(range(ITEMS_PER_ROUND)):
            break
    state["shown"] = ids                    # shown[k] = true rank of the item displayed at slot k (= its id k)
    state["submissions"] = {u: None for u in _active_uids(state)}
    state["ready"] = []
    state["all_submitted_at"] = None
    state["round_result"] = None
    state["phase"] = "sorting"
    state["phase_deadline"] = now + SORT_SECONDS


def _finalize_round(state):
    q, shown = state["current"], state["shown"]
    results = []
    for u in state["player_order"]:
        if not state["active"].get(u):
            continue
        order = state["submissions"].get(u)
        submitted = order is not None
        if submitted:
            ranks = [shown[i] for i in order]
            per, bonus, total = score_order(ranks)
        else:
            per, bonus, total = [0] * ITEMS_PER_ROUND, 0, 0
        state["total_scores"][u] = state["total_scores"].get(u, 0) + total
        st = state["stats"].setdefault(u, {"perfect": 0, "best": 0, "played": 0})
        if submitted:
            st["played"] += 1
            if bonus:
                st["perfect"] += 1
            st["best"] = max(st["best"], total)
        results.append({"userId": int(u), "submitted": submitted, "order": list(order) if submitted else None,
                        "perPosition": per, "bonus": bonus, "points": total})
    # the truth, in the correct order: which display id sits where
    correct = []
    for rank in range(ITEMS_PER_ROUND):
        item_id = shown.index(rank)
        it = q["items"][rank]
        entry = {"id": item_id, "label": it["label"], "value": it["value"]}
        if "text" in it:
            entry["text"] = it["text"]
        correct.append(entry)
    state["round_result"] = {
        "questionId": q["id"], "question": q["question"], "category": q["category"], "direction": q["direction"],
        "unit": q.get("unit", ""), "correct": correct, "explanation": q["explanation"], "results": results,
    }
    state["history"].append(state["round_result"])


def _build_endscreen(state):
    act = _active_uids(state)
    board = sorted(({"userId": int(u), "name": state["player_names"].get(u, "?"), "score": state["total_scores"].get(u, 0)} for u in act),
                   key=lambda e: -e["score"])
    fun = {}
    perfect = max(((u, state["stats"].get(u, {}).get("perfect", 0)) for u in act), key=lambda t: t[1], default=None)
    if perfect and perfect[1] > 0:
        fun["perfect"] = {"userId": int(perfect[0]), "name": state["player_names"].get(perfect[0], "?"), "label": "🎯 Sortiermeister", "detail": f"{perfect[1]}x alle fünf richtig"}
    best = max(((u, state["stats"].get(u, {}).get("best", 0)) for u in act), key=lambda t: t[1], default=None)
    if best and best[1] > 0:
        fun["best"] = {"userId": int(best[0]), "name": state["player_names"].get(best[0], "?"), "label": "⭐ Beste Runde", "detail": f"{best[1]} Punkte in einer Runde"}
    return {"leaderboard": board, "funStats": fun, "totalRounds": len(state["rounds"]), "maxPerRound": ITEMS_PER_ROUND * POINTS_EXACT + BONUS_ALL}


def _advance_or_finish(state, now):
    nxt = state["round_index"] + 1
    if nxt >= len(state["rounds"]):
        state["phase"] = "finished"
        state["phase_deadline"] = None
    else:
        _start_round(state, nxt, now)


class SortGameEngine:
    game_type = "sortiermeister"
    name = "Sortiermeister"
    emoji = "🔢"
    min_players = 1
    max_players = 16
    manual_start = True
    tick_interval = 1.0

    @staticmethod
    def init_state(players, options=None):
        opts = _sanitize_options(options)
        uids = [str(p["user_id"]) for p in players]
        state = {
            "options": opts, "player_order": uids,
            "player_names": {str(p["user_id"]): p["name"] for p in players},
            "active": {u: True for u in uids}, "total_scores": {u: 0 for u in uids},
            "stats": {u: {"perfect": 0, "best": 0, "played": 0} for u in uids},
            "rounds": _pick_questions(opts["rounds"], set()), "recent_question_ids": [],
            "round_index": -1, "current": None, "shown": [], "submissions": {}, "ready": [],
            "all_submitted_at": None, "round_result": None, "phase": "sorting", "phase_deadline": None, "history": [],
        }
        state["recent_question_ids"] = list(state["rounds"])
        _start_round(state, 0, time.time())
        return state

    @staticmethod
    def apply_input(state, user_id, payload):
        uid = str(user_id)
        if not state["active"].get(uid) or not isinstance(payload, dict):
            return False
        action = payload.get("action")
        if state["phase"] == "sorting" and action == "submit":
            if state["submissions"].get(uid, 0) is None:       # (0 = not a player of this round)
                order = payload.get("order")
                if (isinstance(order, list) and len(order) == ITEMS_PER_ROUND and all(isinstance(i, int) and not isinstance(i, bool) for i in order)
                        and sorted(order) == list(range(ITEMS_PER_ROUND))):
                    state["submissions"][uid] = list(order)
                    return True
            return False
        if state["phase"] == "reveal" and action == "next":
            if uid not in state["ready"]:
                state["ready"].append(uid)
                return True
        return False

    @staticmethod
    def tick(state):
        now = time.time()
        phase = state["phase"]
        if phase == "sorting":
            eligible = [u for u in state["submissions"] if state["active"].get(u)]
            all_in = bool(eligible) and all(state["submissions"][u] is not None for u in eligible)
            if all_in and state["all_submitted_at"] is None:
                state["all_submitted_at"] = now
            grace = state["all_submitted_at"] is not None and now - state["all_submitted_at"] >= SUBMIT_GRACE_SECONDS
            if grace or (state["phase_deadline"] is not None and now >= state["phase_deadline"]):
                _finalize_round(state)
                state["phase"] = "reveal"
                state["phase_deadline"] = now + REVEAL_SECONDS
                state["ready"] = []
        elif phase == "reveal":
            act = set(_active_uids(state))
            everyone_ready = bool(act) and act <= set(state["ready"])
            if everyone_ready or (state["phase_deadline"] is not None and now >= state["phase_deadline"]):
                _advance_or_finish(state, now)

    @staticmethod
    def check_finished(state):
        if state["phase"] != "finished":
            return None
        end = _build_endscreen(state)
        return {"winner_user_id": end["leaderboard"][0]["userId"] if end["leaderboard"] else None, "reason": "sortiermeister_finished", "details": end}

    @staticmethod
    def on_player_left(state, user_id):
        uid = str(user_id)
        if uid in state["active"]:
            state["active"][uid] = False

    @staticmethod
    def reset(state):
        act = _active_uids(state)
        recent = set(state.get("recent_question_ids", []))
        state["rounds"] = _pick_questions(state["options"]["rounds"], recent)
        state["recent_question_ids"] = (state.get("recent_question_ids", []) + state["rounds"])[-RECENT_HISTORY_CAP:]
        state["total_scores"] = {u: 0 for u in act}
        state["stats"] = {u: {"perfect": 0, "best": 0, "played": 0} for u in act}
        state["history"] = []
        _start_round(state, 0, time.time())

    @staticmethod
    def public_state(state, viewer_user_id):
        uid, now, phase = str(viewer_user_id), time.time(), state["phase"]
        base = {
            "phase": phase, "roundIndex": state["round_index"] + 1, "totalRounds": len(state["rounds"]),
            "players": [{"userId": int(u), "name": state["player_names"].get(u, "?"), "active": state["active"].get(u, False), "score": state["total_scores"].get(u, 0)}
                        for u in state["player_order"]],
            "secondsLeft": max(0, round(state["phase_deadline"] - now)) if state["phase_deadline"] else 0,
        }
        q = state["current"]
        if q is not None and phase == "sorting":
            elig = [u for u in state["submissions"] if state["active"].get(u)]
            mine = state["submissions"].get(uid)
            base.update({
                "questionId": q["id"], "question": q["question"], "category": q["category"], "categoryLabel": VALID_CATEGORIES[q["category"]],
                "direction": q["direction"],
                "items": [{"id": k, "label": q["items"][state["shown"][k]]["label"]} for k in range(ITEMS_PER_ROUND)],
                "submissionStatus": {u: (state["submissions"][u] is not None) for u in elig},
                "mySubmitted": mine is not None, "myOrder": mine,
            })
        elif phase == "reveal" and state["round_result"] is not None:
            rr = dict(state["round_result"])
            rr["categoryLabel"] = VALID_CATEGORIES.get(rr["category"], rr["category"])
            base["roundResult"] = rr
            base["ready"] = [int(u) for u in state["ready"]]
        elif phase == "finished":
            base["endscreen"] = _build_endscreen(state)
        return base
