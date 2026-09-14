"""Party Mode - a lightweight, code-joined group that persists across
multiple game sessions.

Deliberately has ZERO coupling to games.py's GameSession/GameManager: a
party is just "these people are grouped together, with a running points
tally" - starting a game still goes through the exact same game_create/
game_join/game_start_now flow every other game already uses (see main.py's
websocket handler). This module only adds a courtesy notification so party
members immediately see "X started <Game>, join?" instead of having to
notice it in the general lobby list, plus a simple opt-in points tally
reported by the client after a match ends (see PARTY_PLACEMENT_POINTS).

Reusing the proven, already-tested GameManager for every actual game rule
was a deliberate risk-reduction choice - Party Mode adding a bug here can
never break UNO/Schaetzmeister/etc., since this module never touches their
state at all.
"""

import random
import string

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I - avoids ambiguous codes
CODE_LENGTH = 5
MAX_MEMBERS = 24


class PartyManager:
    def __init__(self, cm):
        self.cm = cm
        self.parties: dict[str, dict] = {}

    # ---------- internal helpers ----------

    def _new_code(self):
        for _ in range(50):
            code = "".join(random.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
            if code not in self.parties:
                return code
        raise RuntimeError("could not allocate a unique party code")

    def _party_for_ws(self, ws):
        for party in self.parties.values():
            if any(m["ws"] is ws for m in party["members"]):
                return party
        return None

    def _public(self, party):
        return {
            "code": party["code"],
            "hostUserId": party["members"][0]["user_id"] if party["members"] else None,
            "members": [{"userId": m["user_id"], "name": m["name"]} for m in party["members"]],
            "scores": party["scores"],
        }

    async def _broadcast(self, party):
        payload = {"type": "party_update", "party": self._public(party)}
        for m in party["members"]:
            await self.cm.send_to(m["ws"], payload)

    # ---------- public actions (called from main.py's websocket loop) ----------

    async def create_party(self, user, ws):
        existing = self._party_for_ws(ws)
        if existing:
            await self._remove_member(existing, ws)
        code = self._new_code()
        party = {"code": code, "members": [{"user_id": user["id"], "name": user["name"], "ws": ws}], "scores": {}}
        self.parties[code] = party
        await self._broadcast(party)

    async def join_party(self, user, ws, code):
        code = (code or "").strip().upper()
        party = self.parties.get(code)
        if not party:
            await self.cm.send_to(ws, {"type": "party_error", "message": "Unbekannter Party-Code."})
            return
        current = self._party_for_ws(ws)
        if current is party:
            return
        if len(party["members"]) >= MAX_MEMBERS:
            await self.cm.send_to(ws, {"type": "party_error", "message": "Diese Party ist bereits voll."})
            return
        if current:
            await self._remove_member(current, ws)

        existing_member = next((m for m in party["members"] if m["user_id"] == user["id"]), None)
        if existing_member:
            existing_member["ws"] = ws  # same user rejoining on a fresh connection
        else:
            party["members"].append({"user_id": user["id"], "name": user["name"], "ws": ws})
        await self._broadcast(party)

    async def leave_party(self, ws):
        party = self._party_for_ws(ws)
        if not party:
            return
        await self._remove_member(party, ws)

    async def _remove_member(self, party, ws):
        party["members"] = [m for m in party["members"] if m["ws"] is not ws]
        if not party["members"]:
            self.parties.pop(party["code"], None)
            return
        await self._broadcast(party)

    async def handle_disconnect(self, ws):
        await self.leave_party(ws)

    async def notify_game_started(self, ws, session_id, game_type, game_name, emoji):
        """Called from main.py right after a game_create succeeds - lets
        every OTHER party member see a direct "join now" prompt instead of
        having to spot it in the general lobby list themselves."""
        party = self._party_for_ws(ws)
        if not party:
            return
        started_by_uid = next((m["user_id"] for m in party["members"] if m["ws"] is ws), None)
        payload = {
            "type": "party_game_started", "session_id": session_id, "game_type": game_type,
            "game_name": game_name, "emoji": emoji, "started_by": started_by_uid,
        }
        for m in party["members"]:
            if m["ws"] is ws:
                continue
            await self.cm.send_to(m["ws"], payload)

    async def report_score(self, user, ws, points):
        """Client-reported placement points for the party's simple evening
        tally - see PARTY_PLACEMENT_POINTS in the frontend for how a raw
        game result becomes a point value. Deliberately client-computed
        from data the client already legitimately has (its own game_over
        payload) rather than requiring this module to understand every
        single game engine's own result shape - Party Mode has no
        authority over any game's actual rules or scoring, only over the
        simple cross-game tally show in the Party view."""
        party = self._party_for_ws(ws)
        if not party:
            return
        if not isinstance(points, (int, float)) or isinstance(points, bool):
            return
        points = max(0, min(1000, int(points)))
        uid = str(user["id"])
        party["scores"][uid] = party["scores"].get(uid, 0) + points
        await self._broadcast(party)
