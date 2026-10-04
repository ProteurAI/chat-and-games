"""GoldRush developer access (QA tools) - unlocked on the server, never in the client.

The developer code lives ONLY in the environment variable GOLDRUSH_DEV_CODE of
the server (Render: Environment). It is never sent to a browser, never
written to a log and never stored client-side. Without the variable the
developer tools are switched off.

Optional: GOLDRUSH_DEV_USER_IDS="1,7" - only these user ids may unlock (with
the right code). Not set: any logged-in user with the right code.

Render "Secret Files" work too: a file named GOLDRUSH_DEV_CODE (Render puts it
in /etc/secrets/) is read when the variable is not set.

Diagnosis: when the code is NOT configured, the (authenticated) status says
which server answered (Render's own service name / id, instance, commit,
external URL - all public metadata) and whether the variable is missing,
empty or present under a near-miss name (spaces, lower case) - never the
code, a hash of it, other variables or any token.

Flow: a logged-in user (X-Auth-Token, as everywhere) posts the code ->
compared here in constant time -> a short-lived developer session token
(random, kept in this process's memory, bound to that user). The browser
keeps it in sessionStorage only, so a new browser session (or a server
restart) asks for the code again. The tools themselves run in the browser
on the player's own local mine - this only decides who sees them.
"""

import asyncio
import hmac
import os
import secrets
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException

router = APIRouter()

ROUTE_VERSION = 2                  # 2: the status carries a diagnosis when not configured (phase 7A)
ENV_KEY = "GOLDRUSH_DEV_CODE"
SECRET_FILES = (Path("/etc/secrets") / ENV_KEY,)     # Render secret file (dashboard: Environment -> Secret Files)

SESSION_SECONDS = 8 * 3600         # a working day; the code is asked for again after that
FAIL_WINDOW = 600                  # failed attempts counted over 10 minutes ...
FAIL_LIMIT = 6                     # ... at most this many, then a pause
ATTEMPT_DELAY = 0.35               # every attempt takes a moment (no rapid guessing)

_sessions: dict[str, tuple[int, float]] = {}      # token -> (user id, expiry)
_fails: dict[int, list[float]] = {}               # user id -> times of failed attempts

_get_current_user = None


def init(get_current_user):
    """main.py hands over its auth dependency (no circular import)."""
    global _get_current_user
    _get_current_user = get_current_user


def _current_user(x_auth_token: Optional[str] = Header(default=None)) -> dict:
    return _get_current_user(x_auth_token)


def _code_source() -> tuple[str, Optional[str]]:
    """(code, where from: "env" | "secretFile" | None) - the code itself never leaves this module"""
    v = os.environ.get(ENV_KEY, "").strip()
    if v:
        return v, "env"
    for f in SECRET_FILES:
        try:
            v = f.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if v:
            return v, "secretFile"
    return "", None


def _code() -> str:
    return _code_source()[0]


def _diagnosis() -> dict:
    """why it is not configured, and which server says so - public metadata and booleans only"""
    present = ENV_KEY in os.environ
    near = any(k != ENV_KEY and k.strip().upper() == ENV_KEY for k in os.environ)
    commit = os.environ.get("RENDER_GIT_COMMIT", "")
    return {
        "variable": "empty" if present else ("nearMiss" if near else "missing"),
        "secretFile": any(f.exists() for f in SECRET_FILES),
        "service": os.environ.get("RENDER_SERVICE_NAME") or None,
        "serviceId": os.environ.get("RENDER_SERVICE_ID") or None,
        "instance": os.environ.get("RENDER_INSTANCE_ID") or None,
        "commit": commit[:7] or None,
        "externalUrl": os.environ.get("RENDER_EXTERNAL_URL") or None,
    }


def _allowed(user_id: int) -> bool:
    raw = os.environ.get("GOLDRUSH_DEV_USER_IDS", "").strip()
    if not raw:
        return True
    ids = {p.strip() for p in raw.split(",") if p.strip()}
    return str(user_id) in ids


def _session(token: Optional[str], user_id: int) -> Optional[float]:
    """seconds left of a valid developer session of this user, or None"""
    now = time.time()
    for t, (_, exp) in list(_sessions.items()):
        if exp <= now:
            del _sessions[t]
    if not token:
        return None
    s = _sessions.get(token)
    if not s or s[0] != user_id:
        return None
    return s[1] - now


@router.get("/api/goldrush/dev/status")
async def dev_status(user: dict = Depends(_current_user), x_goldrush_dev: Optional[str] = Header(default=None)):
    configured = bool(_code())
    left = _session(x_goldrush_dev, user["id"]) if configured else None
    out = {"configured": configured, "unlocked": left is not None, "expiresIn": int(left) if left else 0, "routeVersion": ROUTE_VERSION}
    if not configured:
        out["diagnosis"] = _diagnosis()
    return out


@router.post("/api/goldrush/dev/unlock")
async def dev_unlock(payload: dict, user: dict = Depends(_current_user)):
    code = _code()
    if not code:
        raise HTTPException(status_code=503, detail="Entwicklerzugang ist auf diesem Server nicht konfiguriert.")
    uid = user["id"]
    now = time.time()
    recent = [t for t in _fails.get(uid, []) if now - t < FAIL_WINDOW]
    _fails[uid] = recent
    await asyncio.sleep(ATTEMPT_DELAY)
    if len(recent) >= FAIL_LIMIT:
        raise HTTPException(status_code=429, detail="Zu viele Versuche. Bitte warte ein paar Minuten.")
    given = payload.get("code") if isinstance(payload, dict) else None
    given = given.strip() if isinstance(given, str) else ""
    ok = hmac.compare_digest(given.encode("utf-8"), code.encode("utf-8")) and _allowed(uid)
    if not ok:
        recent.append(now)
        raise HTTPException(status_code=403, detail="Code nicht gültig.")
    _fails.pop(uid, None)
    token = secrets.token_urlsafe(32)
    _sessions[token] = (uid, now + SESSION_SECONDS)
    return {"token": token, "expiresIn": SESSION_SECONDS}


@router.post("/api/goldrush/dev/lock")
async def dev_lock(user: dict = Depends(_current_user), x_goldrush_dev: Optional[str] = Header(default=None)):
    s = _sessions.get(x_goldrush_dev or "")
    if s and s[0] == user["id"]:
        del _sessions[x_goldrush_dev]
    return {"ok": True}
