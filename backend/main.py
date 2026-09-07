import asyncio
import json
import mimetypes
import os
import random
import re
import uuid
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import db
from . import games as games_module

ROOT_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT_DIR / "static"
UPLOAD_DIR = ROOT_DIR / "data" / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

with open(ROOT_DIR / "config.json", encoding="utf-8") as f:
    CONFIG = json.load(f)

# Erlaubt, das Team-Passwort beim Online-Deployment per Umgebungsvariable zu
# setzen, statt es im Klartext in config.json ins (ggf. oeffentliche) Repo zu committen.
if os.environ.get("TEAM_PASSWORD"):
    CONFIG["team_password"] = os.environ["TEAM_PASSWORD"]

with open(ROOT_DIR / "bingo_config.json", encoding="utf-8") as f:
    BINGO_PHRASES = json.load(f)

MAX_UPLOAD_BYTES = 8 * 1024 * 1024
ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
FREE_SPACE_TEXT = "☕ Kaffeepause"

app = FastAPI(title="InstaChat")

db.init_db(CONFIG.get("default_channels", []))


# ---------- auth ----------

def get_current_user(x_auth_token: Optional[str] = Header(default=None)) -> dict:
    if not x_auth_token:
        raise HTTPException(status_code=401, detail="Kein Token angegeben")
    with db.get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE token = ?", (x_auth_token,)).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Ungueltiges Token")
    return db.row_to_dict(row)


def get_user_by_token(token: Optional[str]) -> Optional[dict]:
    if not token:
        return None
    with db.get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE token = ?", (token,)).fetchone()
    return db.row_to_dict(row) if row else None


# ---------- connection manager (websockets) ----------

class ConnectionManager:
    def __init__(self):
        self.by_channel: dict[int, set[WebSocket]] = {}
        self.current_channel: dict[WebSocket, int] = {}
        self.user_of: dict[WebSocket, dict] = {}
        self.locks: dict[WebSocket, asyncio.Lock] = {}

    async def connect(self, ws: WebSocket, user: dict):
        await ws.accept()
        self.user_of[ws] = user
        self.locks[ws] = asyncio.Lock()

    def disconnect(self, ws: WebSocket):
        ch = self.current_channel.pop(ws, None)
        if ch is not None and ch in self.by_channel:
            self.by_channel[ch].discard(ws)
        self.user_of.pop(ws, None)
        self.locks.pop(ws, None)

    def join_channel(self, ws: WebSocket, channel_id: int):
        old = self.current_channel.get(ws)
        if old is not None and old in self.by_channel:
            self.by_channel[old].discard(ws)
        self.by_channel.setdefault(channel_id, set()).add(ws)
        self.current_channel[ws] = channel_id

    async def send_to(self, ws: WebSocket, payload: dict):
        # A per-connection lock keeps concurrent senders (chat broadcasts vs.
        # the game tick loop, which run as independent asyncio tasks) from
        # writing to the same socket at the same time.
        lock = self.locks.get(ws)
        if lock is None:
            return
        async with lock:
            try:
                await ws.send_json(payload)
            except Exception:
                pass

    async def broadcast_channel(self, channel_id: int, payload: dict):
        for ws in list(self.by_channel.get(channel_id, set())):
            await self.send_to(ws, payload)

    async def broadcast_all(self, payload: dict):
        for ws in list(self.user_of.keys()):
            await self.send_to(ws, payload)

    def online_names(self) -> list[str]:
        seen = {}
        for user in self.user_of.values():
            seen[user["id"]] = user["name"]
        return sorted(seen.values(), key=str.lower)


manager = ConnectionManager()
game_manager = games_module.GameManager(manager)


# ---------- serialization ----------

def serialize_message(conn, row) -> dict:
    msg = db.row_to_dict(row)
    user_row = conn.execute("SELECT name FROM users WHERE id = ?", (msg["user_id"],)).fetchone() if msg["user_id"] else None
    msg["user_name"] = user_row["name"] if user_row else None

    reaction_rows = conn.execute(
        "SELECT emoji, user_id FROM reactions WHERE message_id = ?", (msg["id"],)
    ).fetchall()
    grouped: dict[str, list[int]] = {}
    for r in reaction_rows:
        grouped.setdefault(r["emoji"], []).append(r["user_id"])
    msg["reactions"] = [
        {"emoji": emoji, "count": len(uids), "user_ids": uids} for emoji, uids in grouped.items()
    ]

    if msg["type"] == "poll":
        option_rows = conn.execute(
            "SELECT * FROM poll_options WHERE message_id = ? ORDER BY position", (msg["id"],)
        ).fetchall()
        options = []
        for opt in option_rows:
            vote_count = conn.execute(
                "SELECT COUNT(*) AS c FROM poll_votes WHERE option_id = ?", (opt["id"],)
            ).fetchone()["c"]
            options.append({"id": opt["id"], "text": opt["option_text"], "votes": vote_count})
        total = sum(o["votes"] for o in options)
        msg["poll"] = {
            "question": msg["content"],
            "options": options,
            "total_votes": total,
            "my_option_id": None,
        }

    if msg["type"] in ("image", "snap") and msg.get("image_path"):
        msg["image_url"] = f"/uploads/{msg['image_path']}"

    return msg


MENTION_RE = re.compile(r"@([A-Za-z0-9_.\-]{2,32})")


# ---------- REST: auth ----------

@app.post("/api/login")
async def login(payload: dict):
    code = (payload.get("code") or "").strip()
    name = (payload.get("name") or "").strip()
    if code != CONFIG["team_password"]:
        raise HTTPException(status_code=403, detail="Falscher Zugangscode")
    if not (1 <= len(name) <= 32):
        raise HTTPException(status_code=400, detail="Name muss 1-32 Zeichen haben")

    with db.get_conn() as conn:
        existing = conn.execute("SELECT * FROM users WHERE name = ?", (name,)).fetchone()
        if existing:
            token = existing["token"]
            user_id = existing["id"]
        else:
            token = db.new_token()
            cur = conn.execute(
                "INSERT INTO users (name, token, created_at) VALUES (?, ?, ?)",
                (name, token, db.now()),
            )
            user_id = cur.lastrowid

    return {"token": token, "user": {"id": user_id, "name": name}}


@app.get("/api/me")
async def me(user: dict = Depends(get_current_user)):
    return {"id": user["id"], "name": user["name"]}


@app.get("/api/users")
async def list_users(user: dict = Depends(get_current_user)):
    with db.get_conn() as conn:
        rows = conn.execute("SELECT id, name FROM users ORDER BY name COLLATE NOCASE").fetchall()
    return [db.row_to_dict(r) for r in rows]


# ---------- REST: channels ----------

@app.get("/api/channels")
async def list_channels(user: dict = Depends(get_current_user)):
    with db.get_conn() as conn:
        rows = conn.execute("SELECT * FROM channels ORDER BY created_at").fetchall()
    return [db.row_to_dict(r) for r in rows]


@app.post("/api/channels")
async def create_channel(payload: dict, user: dict = Depends(get_current_user)):
    name = (payload.get("name") or "").strip().lower()
    name = re.sub(r"[^a-z0-9\-_]", "-", name).strip("-")
    if not name:
        raise HTTPException(status_code=400, detail="Ungueltiger Kanalname")
    with db.get_conn() as conn:
        existing = conn.execute("SELECT * FROM channels WHERE name = ?", (name,)).fetchone()
        if existing:
            return db.row_to_dict(existing)
        cur = conn.execute(
            "INSERT INTO channels (name, created_at) VALUES (?, ?)", (name, db.now())
        )
        row = conn.execute("SELECT * FROM channels WHERE id = ?", (cur.lastrowid,)).fetchone()
    return db.row_to_dict(row)


@app.get("/api/channels/{channel_id}/messages")
async def get_messages(channel_id: int, limit: int = 50, before_id: Optional[int] = None, user: dict = Depends(get_current_user)):
    with db.get_conn() as conn:
        if before_id:
            rows = conn.execute(
                "SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
                (channel_id, before_id, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?",
                (channel_id, limit),
            ).fetchall()
        messages = []
        for row in reversed(rows):
            full = serialize_message(conn, row)
            if full["type"] == "poll":
                my_vote = conn.execute(
                    "SELECT option_id FROM poll_votes WHERE message_id = ? AND user_id = ?",
                    (full["id"], user["id"]),
                ).fetchone()
                full["poll"]["my_option_id"] = my_vote["option_id"] if my_vote else None
            messages.append(full)
    return messages


# ---------- REST: games ----------

@app.get("/api/games")
async def list_games(user: dict = Depends(get_current_user)):
    return {"game_types": game_manager.game_types(), "sessions": game_manager.public_lobby()}


# ---------- REST: image upload ----------

@app.post("/api/upload")
async def upload_image(file: UploadFile = File(...), user: dict = Depends(get_current_user)):
    content_type = file.content_type or mimetypes.guess_type(file.filename or "")[0]
    if content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail="Nur Bilder erlaubt (png, jpg, gif, webp)")

    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="Bild zu gross (max 8 MB)")

    ext = mimetypes.guess_extension(content_type) or ".bin"
    if ext == ".jpe":
        ext = ".jpg"
    filename = f"{uuid.uuid4().hex}{ext}"
    (UPLOAD_DIR / filename).write_bytes(data)
    return {"image_path": filename, "image_url": f"/uploads/{filename}"}


@app.get("/uploads/{filename}")
async def get_upload(filename: str):
    safe_name = Path(filename).name
    path = UPLOAD_DIR / safe_name
    if not path.exists():
        raise HTTPException(status_code=404, detail="Nicht gefunden")
    return FileResponse(path)


# ---------- REST: bingo ----------

def build_bingo_card() -> list[str]:
    pool = BINGO_PHRASES.copy()
    random.shuffle(pool)
    cells = pool[:24]
    cells.insert(12, FREE_SPACE_TEXT)
    return cells


@app.get("/api/bingo")
async def get_bingo(user: dict = Depends(get_current_user)):
    with db.get_conn() as conn:
        row = conn.execute("SELECT * FROM bingo_cards WHERE user_id = ?", (user["id"],)).fetchone()
        if not row:
            cells = build_bingo_card()
            checked = [i == 12 for i in range(25)]
            conn.execute(
                "INSERT INTO bingo_cards (user_id, cells_json, checked_json, announced_json, created_at) VALUES (?, ?, ?, ?, ?)",
                (user["id"], db.dumps(cells), db.dumps(checked), db.dumps([]), db.now()),
            )
            row = conn.execute("SELECT * FROM bingo_cards WHERE user_id = ?", (user["id"],)).fetchone()
    return {
        "cells": json.loads(row["cells_json"]),
        "checked": json.loads(row["checked_json"]),
    }


def winning_lines(checked: list[bool]) -> list[int]:
    lines = []
    for r in range(5):
        if all(checked[r * 5 + c] for c in range(5)):
            lines.append(r)
    return lines


@app.post("/api/bingo/check")
async def toggle_bingo_cell(payload: dict, user: dict = Depends(get_current_user)):
    cell_index = payload.get("cell_index")
    channel_id = payload.get("channel_id")
    if not isinstance(cell_index, int) or not (0 <= cell_index < 25) or cell_index == 12:
        raise HTTPException(status_code=400, detail="Ungueltiges Feld")

    with db.get_conn() as conn:
        row = conn.execute("SELECT * FROM bingo_cards WHERE user_id = ?", (user["id"],)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Keine Bingo-Karte gefunden, bitte erst laden")
        checked = json.loads(row["checked_json"])
        announced = json.loads(row["announced_json"])
        checked[cell_index] = not checked[cell_index]

        new_wins = [line for line in winning_lines(checked) if line not in announced]
        announced.extend(new_wins)

        conn.execute(
            "UPDATE bingo_cards SET checked_json = ?, announced_json = ? WHERE user_id = ?",
            (db.dumps(checked), db.dumps(announced), user["id"]),
        )

    result = {"checked": checked, "new_bingo": len(new_wins) > 0}

    if new_wins and channel_id:
        text = f"🎉 {user['name']} hat BINGO!"
        with db.get_conn() as conn:
            cur = conn.execute(
                "INSERT INTO messages (channel_id, user_id, type, content, created_at) VALUES (?, ?, 'system', ?, ?)",
                (channel_id, None, text, db.now()),
            )
            msg_row = conn.execute("SELECT * FROM messages WHERE id = ?", (cur.lastrowid,)).fetchone()
            full = serialize_message(conn, msg_row)
        await manager.broadcast_all({"type": "bingo_win", "message": full})

    return result


# ---------- websocket ----------

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: Optional[str] = None):
    user = get_user_by_token(token)
    if not user:
        await ws.close(code=4401)
        return

    await manager.connect(ws, user)
    await manager.broadcast_all({"type": "presence", "online": manager.online_names()})

    try:
        while True:
            raw = await ws.receive_json()
            msg_type = raw.get("type")

            if msg_type == "join":
                channel_id = raw.get("channel_id")
                if isinstance(channel_id, int):
                    manager.join_channel(ws, channel_id)

            elif msg_type == "message":
                channel_id = raw.get("channel_id")
                content = (raw.get("content") or "").strip()
                if not content or not isinstance(channel_id, int):
                    continue
                content = content[:4000]
                with db.get_conn() as conn:
                    cur = conn.execute(
                        "INSERT INTO messages (channel_id, user_id, type, content, created_at) VALUES (?, ?, 'text', ?, ?)",
                        (channel_id, user["id"], content, db.now()),
                    )
                    row = conn.execute("SELECT * FROM messages WHERE id = ?", (cur.lastrowid,)).fetchone()
                    full = serialize_message(conn, row)
                await manager.broadcast_channel(channel_id, {"type": "message", "message": full})

            elif msg_type == "image_message":
                channel_id = raw.get("channel_id")
                image_path = raw.get("image_path")
                if not isinstance(channel_id, int) or not image_path:
                    continue
                with db.get_conn() as conn:
                    cur = conn.execute(
                        "INSERT INTO messages (channel_id, user_id, type, image_path, created_at) VALUES (?, ?, 'image', ?, ?)",
                        (channel_id, user["id"], image_path, db.now()),
                    )
                    row = conn.execute("SELECT * FROM messages WHERE id = ?", (cur.lastrowid,)).fetchone()
                    full = serialize_message(conn, row)
                await manager.broadcast_channel(channel_id, {"type": "message", "message": full})

            elif msg_type == "snap_message":
                channel_id = raw.get("channel_id")
                image_path = raw.get("image_path")
                if not isinstance(channel_id, int) or not image_path:
                    continue
                with db.get_conn() as conn:
                    cur = conn.execute(
                        "INSERT INTO messages (channel_id, user_id, type, image_path, created_at) VALUES (?, ?, 'snap', ?, ?)",
                        (channel_id, user["id"], image_path, db.now()),
                    )
                    row = conn.execute("SELECT * FROM messages WHERE id = ?", (cur.lastrowid,)).fetchone()
                    full = serialize_message(conn, row)
                await manager.broadcast_channel(channel_id, {"type": "message", "message": full})

            elif msg_type == "poll_create":
                channel_id = raw.get("channel_id")
                question = (raw.get("question") or "").strip()[:300]
                options = [o.strip()[:120] for o in raw.get("options", []) if o.strip()]
                if not isinstance(channel_id, int) or not question or not (2 <= len(options) <= 6):
                    continue
                with db.get_conn() as conn:
                    cur = conn.execute(
                        "INSERT INTO messages (channel_id, user_id, type, content, created_at) VALUES (?, ?, 'poll', ?, ?)",
                        (channel_id, user["id"], question, db.now()),
                    )
                    message_id = cur.lastrowid
                    for i, opt in enumerate(options):
                        conn.execute(
                            "INSERT INTO poll_options (message_id, option_text, position) VALUES (?, ?, ?)",
                            (message_id, opt, i),
                        )
                    row = conn.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
                    full = serialize_message(conn, row)
                await manager.broadcast_channel(channel_id, {"type": "message", "message": full})

            elif msg_type == "poll_vote":
                message_id = raw.get("message_id")
                option_id = raw.get("option_id")
                if not isinstance(message_id, int) or not isinstance(option_id, int):
                    continue
                with db.get_conn() as conn:
                    msg_row = conn.execute("SELECT * FROM messages WHERE id = ? AND type = 'poll'", (message_id,)).fetchone()
                    if not msg_row:
                        continue
                    conn.execute(
                        "INSERT INTO poll_votes (message_id, option_id, user_id) VALUES (?, ?, ?) "
                        "ON CONFLICT(message_id, user_id) DO UPDATE SET option_id = excluded.option_id",
                        (message_id, option_id, user["id"]),
                    )
                    full = serialize_message(conn, msg_row)
                    my_vote = conn.execute(
                        "SELECT option_id FROM poll_votes WHERE message_id = ? AND user_id = ?",
                        (message_id, user["id"]),
                    ).fetchone()
                await manager.broadcast_channel(
                    msg_row["channel_id"],
                    {"type": "poll_update", "message_id": message_id, "poll": full["poll"]},
                )

            elif msg_type == "reaction":
                message_id = raw.get("message_id")
                emoji = raw.get("emoji")
                if not isinstance(message_id, int) or not emoji:
                    continue
                with db.get_conn() as conn:
                    msg_row = conn.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
                    if not msg_row:
                        continue
                    existing = conn.execute(
                        "SELECT id FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
                        (message_id, user["id"], emoji),
                    ).fetchone()
                    if existing:
                        conn.execute("DELETE FROM reactions WHERE id = ?", (existing["id"],))
                    else:
                        conn.execute(
                            "INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)",
                            (message_id, user["id"], emoji),
                        )
                    full = serialize_message(conn, msg_row)
                await manager.broadcast_channel(
                    msg_row["channel_id"],
                    {"type": "reaction_update", "message_id": message_id, "reactions": full["reactions"]},
                )

            elif msg_type == "game_create":
                game_type = raw.get("game_type")
                if isinstance(game_type, str):
                    await game_manager.create_session(user, ws, game_type)

            elif msg_type == "game_join":
                session_id = raw.get("session_id")
                if isinstance(session_id, str):
                    await game_manager.join_session(user, ws, session_id)

            elif msg_type == "game_start_now":
                session_id = raw.get("session_id")
                if isinstance(session_id, str):
                    await game_manager.start_now(user, ws, session_id)

            elif msg_type == "game_input":
                session_id = raw.get("session_id")
                if isinstance(session_id, str):
                    await game_manager.handle_input(user, ws, session_id, raw.get("payload") or {})

            elif msg_type == "game_rematch":
                session_id = raw.get("session_id")
                if isinstance(session_id, str):
                    await game_manager.handle_rematch(user, ws, session_id)

            elif msg_type == "game_leave":
                session_id = raw.get("session_id")
                if isinstance(session_id, str):
                    await game_manager.leave_session(user, ws, session_id)

    except WebSocketDisconnect:
        pass
    finally:
        await game_manager.handle_disconnect(ws)
        manager.disconnect(ws)
        await manager.broadcast_all({"type": "presence", "online": manager.online_names()})


@app.middleware("http")
async def no_cache_static_assets(request, call_next):
    # Without this, browsers apply heuristic caching to index.html/app.js/
    # style.css (no explicit Cache-Control was ever set) and can keep
    # serving an old cached copy for a while after a fresh deploy, without
    # even asking the server - two people testing minutes apart can end up
    # running different frontend code against the same live backend.
    # "no-cache" still lets the browser cache the file but forces it to
    # revalidate via the existing ETag/Last-Modified on every load, so a
    # changed file is always picked up (an unchanged one is still a cheap
    # 304, not a full re-download).
    response = await call_next(request)
    if request.url.path in ("/", "/app.js", "/style.css"):
        response.headers["Cache-Control"] = "no-cache"
    return response


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
