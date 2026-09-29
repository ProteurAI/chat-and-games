"""The contract every MultiScreen game implements, and the registry.

A game never knows about websockets, devices joining, pausing for a lost
phone, the resume countdown or snapshots - the session (session.py) does
all of that. A game gets:

  - a TableWorld (geometry.py): tiles, passages, walls, adjacency,
    containment/collision queries, exit prediction, culling helpers
  - the devices' display info (name, colour, number) by device id
  - update(dt) calls in its OWN game time (never wall clock), so a pause
    simply means "no update calls" and every timer inside the game
    freezes with it

and returns plain dicts from build_state() / build_device_state().
"""

import random

from .geometry import MIN_SHARED_EDGE


class MultiscreenGame:
    key = ""
    name = ""
    emoji = ""
    subtitle = ""
    min_devices = 2
    max_devices = 12
    min_passage = MIN_SHARED_EDGE   # narrower shared edges are walls for this game
    tick_hz = 30
    snapshot_every = 2              # broadcast every Nth tick (+ immediately when dirty)

    def __init__(self, world, devices, rng=None):
        self.world = world
        self.devices = devices      # device_id -> {"name", "color", "number"}
        self.rng = rng or random.Random()
        self.time = 0.0             # game time: only advances inside update()
        self.dirty = True           # something worth an immediate snapshot happened
        self.over = False

    @classmethod
    def validate_layout(cls, world, names=None):
        return world.validate(min_devices=cls.min_devices, names=names)

    def start(self):
        raise NotImplementedError

    def handle_input(self, device_id, payload):
        """Device-originated input. Must validate everything itself -
        payload comes straight from a client."""
        raise NotImplementedError

    def update(self, dt):
        raise NotImplementedError

    def build_state(self):
        raise NotImplementedError

    def build_device_state(self, device_id):
        """Optional per-device extra (visibility culling hook for games with
        large worlds: send each screen only what intersects its tile, see
        TableWorld.tiles_intersecting). None = shared state is enough."""
        return None

    def controlling_device(self):
        """Device whose visibility/presence matters right now (pauses the
        game if it goes to the background). None = no single controller."""
        return None

    def force_over(self):
        self.over = True
        self.dirty = True

    def cleanup(self):
        pass


def registry():
    from .snake import SnakeGame
    return {SnakeGame.key: SnakeGame}


def public_catalog():
    return [
        {"key": g.key, "name": g.name, "emoji": g.emoji, "subtitle": g.subtitle,
         "minDevices": g.min_devices, "maxDevices": g.max_devices}
        for g in registry().values()
    ]
