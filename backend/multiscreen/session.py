"""MultiScreen sessions: devices, join code, layout, calibration, setup
tests, the game loop, pausing and reconnect.

Deliberately NO coupling to games.py's GameManager (same reasoning as
party.py): a MultiScreen session is device-based, not user-based - one
person may bring two screens - and it must survive a dropped connection
of any single screen (the table world would have a hole), which the
generic game sessions structurally can't (a fresh socket there is a fresh,
unrelated player). Everything else is reused: auth, the one websocket per
client, ConnectionManager.send_to for every write, the games panel UI.

Device identity: each browser keeps a random device id (localStorage).
Reconnecting = sending ms_join with the same code + device id from the
same user; the device keeps its tile, rotation, calibration and the game
state resumes (after a synchronized 3-2-1).

Phases: setup (connect + arrange) -> test (colour / edges / wave / seam)
-> ready (layout locked, sizes frozen) -> game. Only the host arranges,
tests and starts. The tick task exists only while a game runs.
"""

import asyncio
import random
import re
import time

from . import geometry as geo
from .game_api import public_catalog, registry

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 6
MAX_DEVICES = 12
GRACE_SECONDS = 20
RESUME_COUNTDOWN = 3.0
EMPTY_SESSION_TTL = 60
SETUP_DISCONNECT_TTL = 90
DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,40}$")
TEST_MODES = ("color", "edges", "wave", "seam")

# 12 clearly distinguishable, colour-blind-friendlier-ordered device colours
DEVICE_COLORS = ["#F47C48", "#7C6CF2", "#22A06B", "#4C9FD8", "#E0B429", "#D8618C",
                 "#5FB8A8", "#C0392B", "#8BC34A", "#3F51B5", "#A1887F", "#00ACC1"]


def _num(v, lo, hi, default=None):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if f != f or f in (float("inf"), float("-inf")):
        return default
    return max(lo, min(hi, f))


def sanitize_device_info(raw):
    """Only what the table needs - no user agent, no model, nothing personal."""
    raw = raw if isinstance(raw, dict) else {}
    w = _num(raw.get("cssWidth"), 120, 5000, 390)
    h = _num(raw.get("cssHeight"), 120, 5000, 844)
    caps = raw.get("capabilities") if isinstance(raw.get("capabilities"), dict) else {}
    safe = raw.get("safeArea") if isinstance(raw.get("safeArea"), dict) else {}
    return {
        "cssWidth": round(w, 1), "cssHeight": round(h, 1),
        "dpr": _num(raw.get("dpr"), 0.5, 5, 1),
        "orientation": "landscape" if w > h else "portrait",
        "pxPerMm": _num(raw.get("pxPerMm"), 1.5, 30, None),
        "safeArea": {k: _num(safe.get(k), 0, 200, 0) for k in ("top", "right", "bottom", "left")},
        "capabilities": {k: bool(caps.get(k)) for k in ("touch", "pointer", "wakeLock", "fullscreen", "vibrate")},
    }


class Device:
    def __init__(self, device_id, user, ws, number, color):
        self.device_id = device_id
        self.user_id = user["id"]
        self.name = user["name"]
        self.ws = ws
        self.connected = True
        self.left = False
        self.number = number
        self.color = color
        self.info = sanitize_device_info({})
        self.frozen = None          # {"w", "h", "orientation"} once the layout is locked
        self.hidden = False
        self.disconnected_at = None

    def live_size(self):
        return geo.device_local_size(self.info["cssWidth"], self.info["cssHeight"], self.info["pxPerMm"])

    def size(self):
        if self.frozen:
            return self.frozen["w"], self.frozen["h"]
        return self.live_size()

    def to_public(self):
        w, h = self.size()
        return {
            "deviceId": self.device_id, "userId": self.user_id, "name": self.name,
            "number": self.number, "color": self.color, "connected": self.connected, "left": self.left,
            "orientation": self.frozen["orientation"] if self.frozen else self.info["orientation"],
            "liveOrientation": self.info["orientation"],
            "calibrated": bool(self.info["pxPerMm"]), "localW": w, "localH": h,
            "capabilities": self.info["capabilities"], "hidden": self.hidden,
        }


class Session:
    def __init__(self, code, game_key):
        self.code = code
        self.game_key = game_key
        self.devices = {}               # device_id -> Device (insertion order = join order)
        self.host_id = None
        self.placements = {}            # device_id -> {"x", "y", "rotation"}
        self.phase = "setup"            # setup | test | ready | game
        self.test = None                # {"mode", "startedAt", "path"}
        self.game = None
        self.task = None
        self.cleanup_task = None
        self.pause_reasons = {}         # key -> {"kind", "deviceId", "name", ...}
        self.host_paused = False
        self.resume_until = 0.0         # wall clock end of the 3-2-1 after a pause
        self.grace_until = {}           # device_id -> wall clock deadline
        self.tick = 0
        self.notice = None              # short one-off message for everyone
        self.results = None

    @property
    def game_cls(self):
        return registry()[self.game_key]

    def effective_host(self):
        h = self.devices.get(self.host_id)
        if h and h.connected:
            return h.device_id
        for d in self.devices.values():
            if d.connected and not d.left:
                return d.device_id
        return self.host_id

    def names(self):
        return {d.device_id: d.name if sum(1 for o in self.devices.values() if o.user_id == d.user_id) == 1
                else f"{d.name} ({d.number})" for d in self.devices.values()}

    def build_world(self):
        tiles = []
        for dev_id, pl in self.placements.items():
            dev = self.devices.get(dev_id)
            if not dev:
                continue
            w, h = dev.size()
            tiles.append(geo.Tile(dev_id, pl["x"], pl["y"], w, h, pl["rotation"]))
        return geo.TableWorld(tiles, self.game_cls.min_passage)


class MultiScreenManager:
    def __init__(self, cm):
        self.cm = cm
        self.sessions = {}      # code -> Session
        self.ws_index = {}      # ws -> (code, device_id)

    # ------------------------------------------------------------------ helpers

    def _new_code(self):
        for _ in range(100):
            code = "".join(random.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
            if code not in self.sessions:
                return code
        raise RuntimeError("could not allocate a MultiScreen code")

    def _lookup(self, ws):
        entry = self.ws_index.get(ws)
        if not entry:
            return None, None
        s = self.sessions.get(entry[0])
        if not s:
            self.ws_index.pop(ws, None)
            return None, None
        return s, s.devices.get(entry[1])

    def _is_host(self, s, dev):
        return dev is not None and s.effective_host() == dev.device_id

    async def _error(self, ws, message):
        await self.cm.send_to(ws, {"type": "ms_error", "message": message})

    def public_state(self, s):
        world = s.build_world()
        names = s.names()
        game_cls = s.game_cls
        now = time.time()
        return {
            "code": s.code,
            "game": {"key": game_cls.key, "name": game_cls.name, "emoji": game_cls.emoji, "subtitle": game_cls.subtitle,
                     "minDevices": game_cls.min_devices, "maxDevices": game_cls.max_devices},
            "phase": s.phase,
            "hostDeviceId": s.effective_host(),
            "devices": [d.to_public() for d in s.devices.values()],
            "placements": s.placements,
            "layout": world.to_public(names=names, min_devices=game_cls.min_devices),
            "test": s.test,
            "paused": self._pause_public(s, now),
            "notice": s.notice,
            "serverTime": round(now, 3),
        }

    def _pause_public(self, s, now):
        if not s.pause_reasons and not s.host_paused and now >= s.resume_until:
            return None
        reasons = list(s.pause_reasons.values())
        if s.host_paused:
            reasons.append({"kind": "host", "name": s.devices[s.effective_host()].name if s.effective_host() in s.devices else ""})
        grace = [max(0, round(t - now, 1)) for t in s.grace_until.values()]
        return {
            "reasons": reasons,
            "resumeIn": round(max(0.0, s.resume_until - now), 2) if not reasons else None,
            "graceLeft": min(grace) if grace else None,
            "hostPrompt": any(r["kind"] in ("lost", "left") and r.get("expired") for r in reasons),
        }

    async def broadcast_state(self, s):
        payload = {"type": "ms_state", "state": self.public_state(s)}
        for d in list(s.devices.values()):
            if d.connected and d.ws is not None:
                await self.cm.send_to(d.ws, payload)
        s.notice = None

    async def broadcast_game(self, s):
        if not s.game:
            return
        state = s.game.build_state()
        now = time.time()
        state["serverTime"] = round(now, 3)
        state["tick"] = s.tick
        state["paused"] = self._pause_public(s, now)
        base = {"type": "ms_game_state", "state": state}
        for d in list(s.devices.values()):
            if not (d.connected and d.ws is not None):
                continue
            extra = s.game.build_device_state(d.device_id)
            await self.cm.send_to(d.ws, dict(base, device=extra) if extra else base)
        s.game.dirty = False

    async def broadcast_lobby(self):
        await self.cm.broadcast_all({"type": "ms_lobby", "sessions": self.public_lobby(), "catalog": public_catalog()})

    def public_lobby(self):
        out = []
        for s in self.sessions.values():
            host = s.devices.get(s.effective_host())
            connected = sum(1 for d in s.devices.values() if d.connected)
            if not connected:
                continue
            out.append({
                "code": s.code, "hostName": host.name if host else "?", "game": s.game_cls.name, "emoji": s.game_cls.emoji,
                "devices": connected, "maxDevices": s.game_cls.max_devices, "phase": s.phase,
                "joinable": s.phase != "game" and len(s.devices) < min(MAX_DEVICES, s.game_cls.max_devices),
                "userIds": sorted({d.user_id for d in s.devices.values()}),
            })
        return out

    # ------------------------------------------------------------------ join / leave

    async def create(self, user, ws, raw):
        game_key = raw.get("game")
        device_id = raw.get("deviceId")
        if game_key not in registry():
            await self._error(ws, "Unbekanntes MultiScreen-Spiel.")
            return
        if not isinstance(device_id, str) or not DEVICE_ID_RE.match(device_id):
            await self._error(ws, "Ungültige Geräte-ID.")
            return
        await self.leave(ws, quiet=True)
        s = Session(self._new_code(), game_key)
        self.sessions[s.code] = s
        dev = Device(device_id, user, ws, 1, DEVICE_COLORS[0])
        dev.info = sanitize_device_info(raw.get("device"))
        s.devices[device_id] = dev
        s.host_id = device_id
        self.ws_index[ws] = (s.code, device_id)
        self._auto_place(s, dev)
        await self.broadcast_state(s)
        await self.broadcast_lobby()

    async def join(self, user, ws, raw):
        code = str(raw.get("code") or "").strip().upper()
        device_id = raw.get("deviceId")
        s = self.sessions.get(code)
        if not s:
            await self._error(ws, "Unbekannter MultiScreen-Code.")
            await self.cm.send_to(ws, {"type": "ms_closed", "code": code, "reason": "unknown"})
            return
        if not isinstance(device_id, str) or not DEVICE_ID_RE.match(device_id):
            await self._error(ws, "Ungültige Geräte-ID.")
            return
        existing = s.devices.get(device_id)
        if existing and existing.user_id != user["id"]:
            await self._error(ws, "Dieses Gerät gehört in dieser Runde zu jemand anderem.")
            return
        current = self.ws_index.get(ws)
        if current and current != (code, device_id):
            await self.leave(ws, quiet=True)

        if existing:
            # reconnect: same tile, rotation, calibration, game state
            if existing.ws is not None and existing.ws is not ws:
                self.ws_index.pop(existing.ws, None)
            existing.ws = ws
            existing.connected = True
            existing.left = False
            existing.hidden = False
            existing.disconnected_at = None
            if raw.get("device"):
                self._apply_device_info(s, existing, raw.get("device"))
            self.ws_index[ws] = (code, device_id)
            if s.cleanup_task:
                s.cleanup_task.cancel()
                s.cleanup_task = None
            self._clear_reason(s, f"lost:{device_id}")
            self._clear_reason(s, f"left:{device_id}")
            s.grace_until.pop(device_id, None)
            await self.broadcast_state(s)
            if s.game:
                await self.broadcast_game(s)
            await self.broadcast_lobby()
            return

        if s.phase == "game":
            await self._error(ws, "Hier läuft gerade ein Spiel - tritt nach der Runde bei.")
            return
        if len(s.devices) >= min(MAX_DEVICES, s.game_cls.max_devices):
            await self._error(ws, "Diese Runde ist voll.")
            return
        used = {d.number for d in s.devices.values()}
        number = next(n for n in range(1, MAX_DEVICES + 1) if n not in used)
        dev = Device(device_id, user, ws, number, DEVICE_COLORS[(number - 1) % len(DEVICE_COLORS)])
        dev.info = sanitize_device_info(raw.get("device"))
        s.devices[device_id] = dev
        self.ws_index[ws] = (code, device_id)
        if s.phase == "setup":
            self._auto_place(s, dev)
        await self.broadcast_state(s)
        await self.broadcast_lobby()

    def _auto_place(self, s, dev):
        """New screens are laid out as a row to the right, vertically
        centred - the most common table shape works without any editing."""
        w, h = dev.size()
        if not s.placements:
            s.placements[dev.device_id] = {"x": 0.0, "y": 0.0, "rotation": 0}
            return
        world = s.build_world()
        x1, y1, x2, y2 = world.bounds
        s.placements[dev.device_id] = {"x": round(x2, 2), "y": round((y1 + y2) / 2 - h / 2, 2), "rotation": 0}

    async def leave(self, ws, quiet=False):
        s, dev = self._lookup(ws)
        self.ws_index.pop(ws, None)
        if not s or not dev:
            return
        if s.phase == "game" and s.game and not s.game.over:
            # the world has a hole now: pause, host decides right away
            dev.connected = False
            dev.left = True
            dev.ws = None
            s.pause_reasons[f"left:{dev.device_id}"] = {"kind": "left", "deviceId": dev.device_id, "name": dev.name, "expired": True}
            self._maybe_pause_changed(s)
        else:
            self._remove_device(s, dev.device_id)
        if not any(d.connected for d in s.devices.values()):
            self._schedule_cleanup(s)
        if s.code in self.sessions:
            await self.broadcast_state(s)
            if s.game:
                await self.broadcast_game(s)
        if not quiet:
            await self.cm.send_to(ws, {"type": "ms_closed", "code": s.code, "reason": "left"})
        await self.broadcast_lobby()

    def _remove_device(self, s, device_id):
        s.devices.pop(device_id, None)
        s.placements.pop(device_id, None)
        s.grace_until.pop(device_id, None)
        for key in [k for k, r in s.pause_reasons.items() if r.get("deviceId") == device_id]:
            s.pause_reasons.pop(key)
        if s.host_id == device_id:
            s.host_id = next(iter(s.devices), None)
        if s.phase in ("test", "ready"):
            s.phase = "setup"
            s.test = None
            self._unfreeze(s)
        if not s.devices:
            self._drop_session(s)

    async def handle_disconnect(self, ws):
        s, dev = self._lookup(ws)
        self.ws_index.pop(ws, None)
        if not s or not dev or dev.ws is not ws:
            return
        dev.connected = False
        dev.ws = None
        dev.disconnected_at = time.time()
        if s.phase == "game" and s.game and not s.game.over:
            s.pause_reasons[f"lost:{dev.device_id}"] = {"kind": "lost", "deviceId": dev.device_id, "name": dev.name, "expired": False}
            s.grace_until[dev.device_id] = time.time() + GRACE_SECONDS
            self._maybe_pause_changed(s)
        elif s.phase != "game":
            asyncio.ensure_future(self._forget_if_still_gone(s.code, dev.device_id))
        if not any(d.connected for d in s.devices.values()):
            self._schedule_cleanup(s)
        await self.broadcast_state(s)
        if s.game:
            await self.broadcast_game(s)
        await self.broadcast_lobby()

    async def _forget_if_still_gone(self, code, device_id):
        """A screen that drops out during setup and doesn't come back is
        taken off the table after a while (in a running game it's the
        host's call instead, see the grace handling)."""
        await asyncio.sleep(SETUP_DISCONNECT_TTL)
        s = self.sessions.get(code)
        if not s or s.phase == "game":
            return
        dev = s.devices.get(device_id)
        if dev and not dev.connected:
            self._remove_device(s, device_id)
            if s.code in self.sessions:
                await self.broadcast_state(s)
            await self.broadcast_lobby()

    def _schedule_cleanup(self, s):
        if s.cleanup_task:
            return

        async def later():
            await asyncio.sleep(EMPTY_SESSION_TTL)
            if not any(d.connected for d in s.devices.values()):
                self._drop_session(s)
                await self.broadcast_lobby()

        s.cleanup_task = asyncio.ensure_future(later())

    def _drop_session(self, s):
        if s.task:
            s.task.cancel()
            s.task = None
        if s.game:
            s.game.cleanup()
        self.sessions.pop(s.code, None)
        for ws in [w for w, e in self.ws_index.items() if e[0] == s.code]:
            self.ws_index.pop(ws, None)

    async def close_session(self, ws):
        s, dev = self._lookup(ws)
        if not s or not self._is_host(s, dev):
            return
        payload = {"type": "ms_closed", "code": s.code, "reason": "host_closed"}
        for d in list(s.devices.values()):
            if d.connected and d.ws is not None:
                await self.cm.send_to(d.ws, payload)
        self._drop_session(s)
        await self.broadcast_lobby()

    # ------------------------------------------------------------------ device info

    def _apply_device_info(self, s, dev, raw):
        before = (dev.info["orientation"], dev.live_size(), dev.info["pxPerMm"])
        dev.info = sanitize_device_info(raw)
        changed = before != (dev.info["orientation"], dev.live_size(), dev.info["pxPerMm"])
        if dev.frozen:
            # locked layout: browser-bar jitter is ignored (the client
            # letterboxes); a real orientation flip pauses / unlocks
            flipped = dev.info["orientation"] != dev.frozen["orientation"]
            key = f"orientation:{dev.device_id}"
            if s.phase == "game":
                if flipped and key not in s.pause_reasons:
                    s.pause_reasons[key] = {"kind": "orientation", "deviceId": dev.device_id, "name": dev.name}
                    self._maybe_pause_changed(s)
                    return True
                if not flipped and key in s.pause_reasons:
                    self._clear_reason(s, key)
                    return True
                return False
            if flipped and s.phase == "ready":
                s.phase = "setup"
                s.test = None
                self._unfreeze(s)
                s.notice = f"{dev.name} hat das Gerät gedreht - bitte Layout prüfen."
                return True
            return False
        return changed

    async def device_info(self, ws, raw):
        s, dev = self._lookup(ws)
        if not s or not dev:
            return
        if self._apply_device_info(s, dev, raw.get("device")):
            await self.broadcast_state(s)
            if s.game:
                await self.broadcast_game(s)

    async def visibility(self, ws, raw):
        s, dev = self._lookup(ws)
        if not s or not dev:
            return
        dev.hidden = bool(raw.get("hidden"))
        if s.game:
            self._update_controller_visibility(s)
            await self.broadcast_game(s)

    def _update_controller_visibility(self, s):
        ctrl = s.game.controlling_device() if s.game else None
        for key in [k for k in s.pause_reasons if k.startswith("hidden:")]:
            dev_id = key.split(":", 1)[1]
            d = s.devices.get(dev_id)
            if dev_id != ctrl or not d or not d.hidden:
                self._clear_reason(s, key)
        if ctrl and ctrl in s.devices and s.devices[ctrl].hidden and not s.game.over:
            key = f"hidden:{ctrl}"
            if key not in s.pause_reasons:
                s.pause_reasons[key] = {"kind": "hidden", "deviceId": ctrl, "name": s.devices[ctrl].name}
                self._maybe_pause_changed(s)

    # ------------------------------------------------------------------ layout / tests

    async def layout_update(self, ws, raw):
        s, dev = self._lookup(ws)
        if not s or not self._is_host(s, dev) or s.phase not in ("setup", "test", "ready"):
            return
        tiles = raw.get("tiles")
        if not isinstance(tiles, list) or len(tiles) > MAX_DEVICES:
            return
        placements = {}
        for t in tiles:
            if not isinstance(t, dict) or t.get("deviceId") not in s.devices:
                continue
            rot = t.get("rotation")
            if rot not in geo.ROTATIONS:
                continue
            x = _num(t.get("x"), -geo.MAX_COORD, geo.MAX_COORD)
            y = _num(t.get("y"), -geo.MAX_COORD, geo.MAX_COORD)
            if x is None or y is None:
                continue
            placements[t["deviceId"]] = {"x": round(x, 2), "y": round(y, 2), "rotation": rot}
        s.placements = placements
        if s.phase == "ready":
            s.phase = "setup"
            self._unfreeze(s)
        if s.phase == "test" and s.test:
            s.test["path"] = geo.tour_path(s.build_world(), s.effective_host())
        await self.broadcast_state(s)

    async def test(self, ws, raw):
        s, dev = self._lookup(ws)
        if not s or not self._is_host(s, dev) or s.phase not in ("setup", "test", "ready"):
            return
        mode = raw.get("mode")
        if mode == "off":
            s.phase, s.test = "setup", None
            self._unfreeze(s)
        elif mode in TEST_MODES:
            if s.phase == "ready":
                self._unfreeze(s)
            s.phase = "test"
            world = s.build_world()
            start = s.effective_host() if s.effective_host() in world.by_id else None
            s.test = {"mode": mode, "startedAt": round(time.time(), 3), "path": geo.tour_path(world, start)}
        else:
            return
        await self.broadcast_state(s)
        await self.broadcast_lobby()

    async def confirm_layout(self, ws, raw):
        """[PASST]: lock the layout and freeze every screen's size - later
        browser-bar changes must not reshape the world mid-game."""
        s, dev = self._lookup(ws)
        if not s or not self._is_host(s, dev) or s.phase not in ("setup", "test"):
            return
        world = s.build_world()
        errors = [p for p in s.game_cls.validate_layout(world, s.names()) if p["severity"] == "error"]
        if errors:
            await self._error(ws, errors[0]["message"])
            return
        for d in s.devices.values():
            if d.device_id in s.placements:
                w, h = d.live_size()
                d.frozen = {"w": w, "h": h, "orientation": d.info["orientation"]}
        s.phase = "ready"
        s.test = None
        s.notice = "Perfekt – eure gemeinsame Welt ist bereit."
        await self.broadcast_state(s)
        await self.broadcast_lobby()

    def _unfreeze(self, s):
        for d in s.devices.values():
            d.frozen = None

    # ------------------------------------------------------------------ game

    async def start_game(self, ws, raw):
        s, dev = self._lookup(ws)
        if not s or not self._is_host(s, dev) or s.phase not in ("ready", "game"):
            return
        if s.phase == "game" and s.game and not s.game.over:
            return
        if any(not s.devices[d].connected for d in s.placements if d in s.devices):
            await self._error(ws, "Nicht alle Handys der Spielfläche sind verbunden.")
            return
        world = s.build_world()
        errors = [p for p in s.game_cls.validate_layout(world, s.names()) if p["severity"] == "error"]
        if errors:
            await self._error(ws, errors[0]["message"])
            return
        devices = {d.device_id: {"name": d.name, "color": d.color, "number": d.number} for d in s.devices.values()}
        s.game = s.game_cls(world, devices)
        s.game.start()
        s.phase = "game"
        s.pause_reasons, s.host_paused, s.resume_until, s.grace_until = {}, False, 0.0, {}
        s.tick = 0
        await self.broadcast_state(s)
        await self.broadcast_game(s)
        await self.broadcast_lobby()
        if s.task is None or s.task.done():
            s.task = asyncio.ensure_future(self._run(s))

    async def game_input(self, ws, raw):
        s, dev = self._lookup(ws)
        if not s or not dev or not s.game or s.game.over or self._is_paused(s):
            return
        if s.game.handle_input(dev.device_id, raw.get("input") or {}):
            await self.broadcast_game(s)

    async def host_action(self, ws, raw):
        s, dev = self._lookup(ws)
        if not s or not self._is_host(s, dev):
            return
        action = raw.get("action")
        if action == "pause" and s.game and not s.game.over:
            s.host_paused = True
            self._maybe_pause_changed(s)
        elif action == "resume" and s.host_paused:
            s.host_paused = False
            self._maybe_pause_changed(s)
        elif action == "restart" and s.phase == "game":
            s.game = None
            await self.start_game(ws, raw)
            return
        elif action == "end" and s.game:
            s.game.force_over()
            s.pause_reasons, s.host_paused, s.grace_until = {}, False, {}
        elif action == "wait_more":
            for dev_id in list(s.grace_until):
                s.grace_until[dev_id] = time.time() + GRACE_SECONDS
            for r in s.pause_reasons.values():
                if r["kind"] == "lost":
                    r["expired"] = False
        elif action == "reconfigure":
            # never try to bend a running snake onto a new world: back to setup
            gone = [d.device_id for d in s.devices.values() if not d.connected or d.left]
            for dev_id in gone:
                self._remove_device(s, dev_id)
            if s.code not in self.sessions:
                return
            s.game = None
            s.phase = "setup"
            s.test = None
            s.pause_reasons, s.host_paused, s.grace_until = {}, False, {}
            self._unfreeze(s)
        elif action == "back_to_setup" and (not s.game or s.game.over):
            s.game = None
            s.phase = "setup"
            self._unfreeze(s)
        else:
            return
        await self.broadcast_state(s)
        if s.game:
            await self.broadcast_game(s)
        await self.broadcast_lobby()

    def _is_paused(self, s):
        return bool(s.pause_reasons) or s.host_paused or time.time() < s.resume_until

    def _clear_reason(self, s, key):
        if s.pause_reasons.pop(key, None) is not None:
            self._maybe_pause_changed(s)

    def _maybe_pause_changed(self, s):
        """Whenever the last pause reason goes away, everyone gets the same
        3-2-1 before the world moves again."""
        if not s.pause_reasons and not s.host_paused and s.game and not s.game.over:
            s.resume_until = time.time() + RESUME_COUNTDOWN
        if s.game:
            s.game.dirty = True

    async def ping(self, ws, raw):
        await self.cm.send_to(ws, {"type": "ms_pong", "t": raw.get("t"), "serverTime": round(time.time(), 4)})

    async def _run(self, s):
        """Fixed-timestep loop, alive only while a game runs. Game time only
        advances when nothing pauses it."""
        me = asyncio.current_task()
        game = s.game
        dt = 1 / game.tick_hz
        last = time.monotonic()
        acc = 0.0
        try:
            while s.code in self.sessions and s.phase == "game" and s.game is not None:
                await asyncio.sleep(dt)
                if s.game is None:
                    break   # ended/reconfigured while we slept
                if s.game is not game:
                    game, acc = s.game, 0.0
                    dt = 1 / game.tick_hz
                now_m = time.monotonic()
                acc = min(acc + (now_m - last), dt * 5)   # catch-up capped (no spiral of death)
                last = now_m
                now = time.time()
                for dev_id, deadline in list(s.grace_until.items()):
                    r = s.pause_reasons.get(f"lost:{dev_id}")
                    if r and not r["expired"] and now >= deadline:
                        r["expired"] = True
                        game.dirty = True
                        await self.broadcast_state(s)
                self._update_controller_visibility(s)
                steps = 0
                while acc >= dt:
                    acc -= dt
                    steps += 1
                    if not self._is_paused(s) and not game.over:
                        game.update(dt)
                        s.tick += 1
                if steps and (game.dirty or s.tick % game.snapshot_every == 0 or self._is_paused(s)):
                    await self.broadcast_game(s)
                if game.over and not game.dirty:
                    await self.broadcast_game(s)
                    break
        except asyncio.CancelledError:
            pass
        finally:
            if s.task is me:
                s.task = None


async def route(manager, user, ws, raw):
    """Dispatch for every "ms_*" websocket message (called from main.py)."""
    t = raw.get("type")
    handlers = {
        "ms_create": lambda: manager.create(user, ws, raw),
        "ms_join": lambda: manager.join(user, ws, raw),
        "ms_leave": lambda: manager.leave(ws),
        "ms_close": lambda: manager.close_session(ws),
        "ms_device_info": lambda: manager.device_info(ws, raw),
        "ms_visibility": lambda: manager.visibility(ws, raw),
        "ms_layout_update": lambda: manager.layout_update(ws, raw),
        "ms_test": lambda: manager.test(ws, raw),
        "ms_layout_confirm": lambda: manager.confirm_layout(ws, raw),
        "ms_start": lambda: manager.start_game(ws, raw),
        "ms_game_input": lambda: manager.game_input(ws, raw),
        "ms_host": lambda: manager.host_action(ws, raw),
        "ms_ping": lambda: manager.ping(ws, raw),
        "ms_lobby_request": lambda: manager.cm.send_to(ws, {"type": "ms_lobby", "sessions": manager.public_lobby(), "catalog": public_catalog()}),
    }
    h = handlers.get(t)
    if h:
        await h()
