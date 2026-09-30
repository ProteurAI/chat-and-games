"""MultiScreen engine + MultiScreen Snake tests (pure Python, no browser).

    python -m unittest tests.test_multiscreen_engine -v
"""

import asyncio
import math
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from backend.multiscreen import geometry as geo  # noqa: E402
from backend.multiscreen import session as ms  # noqa: E402
from backend.multiscreen.snake import SNAKE_CONFIG, SnakeGame  # noqa: E402

PW, PH = 68.0, 150.0   # a typical portrait phone in world units (mm)


def T(dev, x, y, rot=0, w=PW, h=PH):
    return geo.Tile(dev, x, y, w, h, rot)


def world(*tiles, min_passage=SnakeGame.min_passage):
    return geo.TableWorld(tiles, min_passage)


def neighbors(w, dev, side):
    return sorted(n["neighbor"] for n in w.adjacency[dev][side])


def walk(w, start, direction, steps=400, step=1.0):
    """Move a point straight and record the tiles it passes through, until
    it leaves the playable union."""
    x, y = start
    dx, dy = geo.DIR_VECTORS[direction]
    seen = []
    for _ in range(steps):
        t = w.get_tile_for_point(x, y, prefer=seen[-1] if seen else None)
        if t is None:
            break
        if not seen or seen[-1] != t.device_id:
            seen.append(t.device_id)
        x, y = x + dx * step, y + dy * step
    return seen


class TransformTest(unittest.TestCase):
    def test_round_trip_all_rotations(self):
        for rot in geo.ROTATIONS:
            t = T("A", 30, 40, rot)
            for lx, ly in ((0, 0), (PW, 0), (0, PH), (12.5, 99.0), (PW, PH)):
                wx, wy = geo.local_to_world(t, lx, ly)
                self.assertTrue(geo.point_inside(t, wx, wy, 1e-9), (rot, lx, ly))
                bx, by = geo.world_to_local(t, wx, wy)
                self.assertAlmostEqual(bx, lx, 9)
                self.assertAlmostEqual(by, ly, 9)

    def test_rotated_tile_swaps_world_size(self):
        t = T("A", 0, 0, 90)
        self.assertEqual((t.w, t.h), (PH, PW))

    def test_local_top_left_is_where_the_screen_top_points(self):
        # 90 deg: the screen's top edge faces world right -> its local
        # top-left corner is the tile's world top-RIGHT corner
        self.assertEqual(geo.local_to_world(T("A", 0, 0, 90), 0, 0), (PH, 0))
        self.assertEqual(geo.local_to_world(T("A", 0, 0, 180), 0, 0), (PW, PH))
        self.assertEqual(geo.local_to_world(T("A", 0, 0, 270), 0, 0), (0, PW))

    def test_swipe_directions_follow_rotation(self):
        # TEST 5: on a screen turned 90 deg, a swipe "up" on the glass moves world right
        self.assertEqual(geo.local_dir_to_world(0, "up"), "up")
        self.assertEqual(geo.local_dir_to_world(90, "up"), "right")
        self.assertEqual(geo.local_dir_to_world(90, "right"), "down")
        self.assertEqual(geo.local_dir_to_world(180, "up"), "down")
        self.assertEqual(geo.local_dir_to_world(180, "left"), "right")
        self.assertEqual(geo.local_dir_to_world(270, "up"), "left")
        for rot in geo.ROTATIONS:
            for d in geo.DIR_VECTORS:
                self.assertEqual(geo.world_dir_to_local(rot, geo.local_dir_to_world(rot, d)), d)

    def test_vectors_match_point_transforms(self):
        for rot in geo.ROTATIONS:
            t = T("A", 10, 20, rot)
            a = geo.world_to_local(t, 50, 60)
            b = geo.world_to_local(t, 53, 64)
            v = geo.world_vec_to_local(rot, 3, 4)
            self.assertAlmostEqual(b[0] - a[0], v[0])
            self.assertAlmostEqual(b[1] - a[1], v[1])
            back = geo.local_vec_to_world(rot, *v)
            self.assertAlmostEqual(back[0], 3)
            self.assertAlmostEqual(back[1], 4)


class LayoutTest(unittest.TestCase):
    def test_01_two_portrait_side_by_side(self):
        w = world(T("A", 0, 0), T("B", PW, 0))
        self.assertEqual(neighbors(w, "A", "right"), ["B"])
        self.assertEqual(neighbors(w, "B", "left"), ["A"])
        self.assertEqual(walk(w, (10, 75), "right"), ["A", "B"])
        self.assertEqual(w.validate(), [])

    def test_02_two_stacked(self):
        w = world(T("A", 0, 0), T("B", 0, PH))
        self.assertEqual(neighbors(w, "A", "bottom"), ["B"])
        self.assertEqual(walk(w, (34, 10), "down"), ["A", "B"])

    def test_03_portrait_next_to_landscape(self):
        # landscape phone lying next to a portrait one, top-aligned
        w = world(T("A", 0, 0), T("B", PW, 0, 0, w=PH, h=PW))
        p = w.get_shared_passage("A", "B")[0]
        self.assertEqual((p.side, p.start, p.end), ("right", 0, PW))
        self.assertEqual(walk(w, (10, 30), "right"), ["A", "B"])
        # below B's height the right edge of A is wall
        self.assertEqual(walk(w, (10, 120), "right"), ["A"])

    def test_04_rotated_180(self):
        w = world(T("A", 0, 0), T("B", PW, 0, 180))
        self.assertEqual(walk(w, (10, 30), "right"), ["A", "B"])
        b = w.by_id["B"]
        # entering B from world-left = arriving from B's own RIGHT screen edge
        lx, ly = geo.world_to_local(b, PW + 1, 30)
        self.assertAlmostEqual(lx, PW - 1)
        self.assertAlmostEqual(ly, PH - 30)
        self.assertEqual(geo.world_dir_to_local(180, "right"), "left")

    def test_06_2x2(self):
        w = world(T("A", 0, 0), T("B", PW, 0), T("C", 0, PH), T("D", PW, PH))
        self.assertEqual(neighbors(w, "A", "right"), ["B"])
        self.assertEqual(neighbors(w, "A", "bottom"), ["C"])
        self.assertEqual(neighbors(w, "D", "left"), ["C"])
        self.assertEqual(neighbors(w, "D", "top"), ["B"])
        self.assertEqual(w.adjacency["A"]["top"], [])
        self.assertEqual(walk(w, (10, 10), "right"), ["A", "B"])
        self.assertEqual(walk(w, (PW + 10, 10), "down"), ["B", "D"])
        # the shared corner is NOT a diagonal connection A<->D
        self.assertNotIn("D", w.neighbors("A"))

    def test_07_3x2(self):
        tiles = [T(f"{r}{c}", c * PW, r * PH) for r in range(2) for c in range(3)]
        w = world(*tiles)
        self.assertEqual(w.neighbors("01"), ["00", "02", "11"])
        self.assertEqual(w.neighbors("00"), ["01", "10"])
        self.assertEqual(w.neighbors("11"), ["01", "10", "12"])
        self.assertEqual(sum(len(w.neighbors(t.device_id)) for t in tiles), 14)  # 7 edges, both ways
        self.assertEqual(w.validate(), [])

    def test_08_L_shape_missing_edges_are_walls(self):
        w = world(T("A", 0, 0), T("B", PW, 0), T("C", 2 * PW, 0), T("D", 0, PH))
        self.assertEqual(w.neighbors("B"), ["A", "C"])
        self.assertEqual(walk(w, (PW + 10, 10), "down"), ["B"])   # nothing below B: wall
        self.assertEqual(w.get_boundary_collision(PW + 10, PH + 5, 3), "outside")
        self.assertEqual(w.get_boundary_collision(PW + 10, PH - 1, 3), "wall")
        self.assertEqual(w.validate(), [])

    def test_09_T_shape_branching(self):
        w = world(T("A", 0, 0), T("B", PW, 0), T("C", 2 * PW, 0), T("D", PW, PH))
        self.assertEqual(w.neighbors("B"), ["A", "C", "D"])
        self.assertEqual(neighbors(w, "B", "bottom"), ["D"])

    def test_10_cross(self):
        w = world(T("N", PW, 0), T("W", 0, PH), T("M", PW, PH), T("E", 2 * PW, PH), T("S", PW, 2 * PH))
        self.assertEqual(w.neighbors("M"), ["E", "N", "S", "W"])
        for side, n in (("top", "N"), ("left", "W"), ("right", "E"), ("bottom", "S")):
            self.assertEqual(neighbors(w, "M", side), [n])
        self.assertEqual(w.neighbors("N"), ["M"])

    def test_11_stairs(self):
        h2 = PH / 2
        w = world(T("A", 0, 0), T("B", PW, 0), T("C", PW, PH), T("D", 2 * PW, PH), T("E", 2 * PW, 2 * PH))
        self.assertEqual(w.neighbors("C"), ["B", "D"])
        self.assertEqual(w.neighbors("D"), ["C", "E"])
        self.assertEqual(walk(w, (10, 10), "right"), ["A", "B"])
        self.assertEqual(walk(w, (PW + 10, 10), "down"), ["B", "C"])
        self.assertEqual(w.validate(), [])
        # offset stairs: each step half a phone down
        w2 = world(T("A", 0, 0), T("B", PW, h2), T("C", 2 * PW, PH))
        self.assertEqual(w2.get_shared_passage("A", "B")[0].length, h2)
        self.assertEqual(w2.validate(), [])

    def test_12_partial_edge_only_overlap_is_passage(self):
        w = world(T("A", 0, 0), T("B", PW, 100))
        p = w.get_shared_passage("A", "B")[0]
        self.assertEqual((p.start, p.end), (100, PH))
        self.assertEqual(walk(w, (10, 120), "right"), ["A", "B"])   # inside the overlap
        self.assertEqual(walk(w, (10, 40), "right"), ["A"])         # beside it: wall
        self.assertIn((PW, 0, PW, 100), [tuple(round(v, 6) for v in s) for s in w.walls])

    def test_13_corner_only_is_no_connection(self):
        w = world(T("A", 0, 0), T("B", PW, PH))
        self.assertEqual(w.neighbors("A"), [])
        codes = [p["code"] for p in w.validate()]
        self.assertIn("island", codes)

    def test_near_corner_contact_below_minimum_is_no_connection(self):
        w = world(T("A", 0, 0), T("B", PW, PH - 3))
        self.assertEqual(w.neighbors("A"), [])

    def test_island_message_names_the_device(self):
        w = world(T("A", 0, 0), T("B", PW, 0), T("MAX", 400, 400))
        problems = w.validate(names={"A": "TIM", "B": "SARAH", "MAX": "MAX"})
        island = [p for p in problems if p["code"] == "island"][0]
        self.assertEqual(island["message"], "MAX ist noch nicht mit der gemeinsamen Spielfläche verbunden.")
        self.assertEqual(island["severity"], "error")

    def test_overlap_is_an_error(self):
        w = world(T("A", 0, 0), T("B", PW - 20, 10))
        self.assertEqual([p["code"] for p in w.validate()], ["overlap"])

    def test_narrow_passage_is_a_wall_for_snake(self):
        # 8mm of shared edge: geometrically touching, too narrow for the snake head
        w = world(T("A", 0, 0), T("B", PW, PH - 8))
        self.assertEqual(w.passages, [])
        problems = w.validate()
        self.assertIn("narrow", [p["code"] for p in problems])
        self.assertEqual([p for p in problems if p["code"] == "narrow"][0]["severity"], "warning")
        self.assertIn("island", [p["code"] for p in problems])

    def test_different_sizes_partial_side(self):
        small = T("S", 0, 20, 0, w=60, h=130)
        big = T("B", 60, 0, 0, w=78, h=170)
        w = world(small, big)
        p = w.get_shared_passage("S", "B")[0]
        self.assertEqual((p.start, p.end), (20, 150))

    def test_exit_prediction(self):
        w = world(T("A", 0, 0), T("B", PW, 100))
        self.assertEqual(w.exit_along("A", 10, 120, "right")["target"], "B")
        self.assertEqual(w.exit_along("A", 10, 40, "right")["target"], None)
        self.assertAlmostEqual(w.exit_along("A", 10, 120, "right")["distance"], PW - 10)

    def test_quick_and_precision_sizes(self):
        self.assertEqual(geo.device_local_size(390, 844), (68.0, round(844 * 68 / 390, 2)))
        # 160 css px per inch ~ 6.3 px/mm -> real millimetres
        w, h = geo.device_local_size(390, 844, px_per_mm=6.3)
        self.assertAlmostEqual(w, 61.9, 1)
        self.assertAlmostEqual(h, 134.0, 1)

    def test_tour_visits_every_screen(self):
        w = world(T("A", 0, 0), T("B", PW, 0), T("C", 2 * PW, 0), T("D", PW, PH))
        pts = geo.tour_path(w, "A")
        visited = {w.get_tile_for_point(x, y).device_id for x, y in pts}
        self.assertEqual(visited, {"A", "B", "C", "D"})
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):   # every leg stays on the table
            for k in range(11):
                self.assertTrue(w.contains_point(x1 + (x2 - x1) * k / 10, y1 + (y2 - y1) * k / 10))


# ---------------------------------------------------------------------------
# Snake
# ---------------------------------------------------------------------------

def snake(*tiles, seed=1):
    w = world(*tiles)
    g = SnakeGame(w, {t.device_id: {"name": t.device_id} for t in tiles}, random.Random(seed))
    g.start()
    return g


def run_until(g, cond, secs=30):
    for _ in range(int(secs * 30)):
        g.update(1 / 30)
        if cond():
            return True
    return False


def to_playing(g):
    assert run_until(g, lambda: g.phase == "playing", 10)


def place(g, x, y, d, active):
    """Put the head at (x, y) moving d with a short straight body."""
    dx, dy = geo.DIR_VECTORS[geo.OPPOSITE_DIR[d]]
    g.path = [[x, y], [x + dx * g.length, y + dy * g.length]]
    g.dir, g.queue, g._last_turn = d, [], None
    g.active = active
    g.handoff_target = g.handoff_buffer = None


class SnakeTest(unittest.TestCase):
    CELL = SNAKE_CONFIG["cell"]

    def test_crosses_screens_and_hands_off_control(self):
        g = snake(T("A", 0, 0), T("B", PW, 0))
        to_playing(g)
        place(g, 27, 72, "right", "A")
        prepared = []
        self.assertTrue(run_until(g, lambda: (prepared.append(g.handoff_target) or g.active == "B"), 5))
        self.assertIn("B", prepared)          # got "BEREIT MACHEN" before the handoff
        self.assertGreater(g.path[0][0], PW)  # head centre clearly inside B
        self.assertEqual(g.stats["crossings"], 1)
        # old screen can't steer any more, new one can
        self.assertFalse(g.handle_input("A", {"dir": "up"}))
        self.assertTrue(g.handle_input("B", {"dir": "up"}))

    def test_prepare_not_too_early(self):
        g = snake(T("A", 0, 0), T("B", PW, 0))
        to_playing(g)
        place(g, 9, 72, "right", "A")
        g.update(1 / 30)
        speed = g.speed * self.CELL
        self.assertIsNone(g.handoff_target)                 # ~1.3s away: not yet
        self.assertTrue(run_until(g, lambda: g.handoff_target == "B", 2))
        dist = PW - g.path[0][0]
        self.assertLessEqual(dist / speed, SNAKE_CONFIG["prepare_time"] + 0.05)

    def test_buffered_turn_applies_at_handoff(self):
        g = snake(T("A", 0, 0), T("B", PW, 0))
        to_playing(g)
        place(g, 27, 72, "right", "A")
        self.assertTrue(run_until(g, lambda: g.handoff_target == "B", 3))
        self.assertTrue(g.handle_input("B", {"dir": "down"}))   # B prepares a turn before it has control
        self.assertEqual(g.dir, "right")
        self.assertTrue(run_until(g, lambda: g.dir == "down", 3))
        self.assertEqual(g.active, "B")
        self.assertEqual(g.path[1][0] % self.CELL, 0)            # turned on a grid line

    def test_uninvolved_screen_cannot_steer(self):
        g = snake(T("A", 0, 0), T("B", PW, 0), T("C", 2 * PW, 0))
        to_playing(g)
        place(g, 27, 72, "right", "A")
        self.assertFalse(g.handle_input("C", {"dir": "up"}))

    def test_no_180_even_with_rapid_or_buffered_input(self):
        g = snake(T("A", 0, 0), T("B", PW, 0))
        to_playing(g)
        place(g, 99, 72, "right", "B")
        self.assertFalse(g.handle_input("B", {"dir": "left"}))
        self.assertTrue(g.handle_input("B", {"dir": "up"}))
        self.assertTrue(g.handle_input("B", {"dir": "left"}))   # up, then left = legal U-turn
        self.assertFalse(g.handle_input("B", {"dir": "right"}))  # would reverse the queued left
        self.assertTrue(run_until(g, lambda: g.dir == "left", 1))
        # the two turns happened on different grid points, one lane apart
        self.assertEqual(g.path[1], [99, 63])
        self.assertEqual(g.path[2], [99, 72])
        run_until(g, lambda: False, 0.8)
        self.assertEqual(g.dir, "left")
        self.assertEqual(g.phase, "playing")                     # U-turn is one lane wide: no self hit

    def test_rotated_screen_swipe_maps_to_world(self):
        g = snake(T("A", 0, 0), T("B", PW, 0, 90))
        to_playing(g)
        b = g.world.by_id["B"]
        place(g, PW + 36, 45, "right", "B")
        g.handle_input("B", {"dir": "left"})   # screen turned 90: its "left" is world up
        self.assertEqual(g.queue[0][0], "up")
        self.assertEqual(b.rotation, 90)

    def test_outer_wall_costs_a_life(self):
        g = snake(T("A", 0, 0), T("B", PW, 0))
        to_playing(g)
        place(g, 2 * PW - 20, 72, "right", "B")
        self.assertTrue(run_until(g, lambda: g.phase == "crashed", 3))
        self.assertEqual(g.crash["reason"], "wall")
        self.assertEqual(g.lives, SNAKE_CONFIG["lives"] - 1)

    def test_partial_edge_beside_the_passage_is_deadly(self):
        g = snake(T("A", 0, 0), T("B", PW, 100))
        to_playing(g)
        place(g, 36, 45, "right", "A")          # y=45: beside B's overlap (100..150)
        self.assertTrue(run_until(g, lambda: g.phase == "crashed", 3))
        self.assertLess(g.crash["x"], PW)
        g2 = snake(T("A", 0, 0), T("B", PW, 100))
        to_playing(g2)
        place(g2, 36, 126, "right", "A")        # inside the overlap: passes
        self.assertTrue(run_until(g2, lambda: g2.active == "B", 3))

    def test_self_collision_across_screens(self):
        g = snake(T("A", 0, 0), T("B", PW, 0))
        to_playing(g)
        # head on B moving up; the body behind it loops round and crosses
        # back over into A along y=45 - right in the head's way
        g.path = [[72, 90], [72, 108], [117, 108], [117, 45], [27, 45]]
        g.length = 18 + 45 + 63 + 90
        g.dir, g.queue, g._last_turn, g.active = "up", [], None, "B"
        self.assertTrue(run_until(g, lambda: g.phase == "crashed", 4))
        self.assertEqual(g.crash["reason"], "self")

    def test_food_is_always_valid(self):
        tiles = (T("A", 0, 0), T("B", PW, 60), T("C", PW, 60 + PH))
        g = snake(*tiles, seed=7)
        counts = {}
        for _ in range(300):
            g._spawn_food()
            f = g.food
            self.assertIsNotNone(f)
            self.assertTrue(g.world.contains_point(f["x"], f["y"]))
            self.assertGreaterEqual(g.world.wall_distance(f["x"], f["y"]), g.r + SNAKE_CONFIG["food_radius"])
            self.assertGreaterEqual(g._body_distance(f["x"], f["y"]), g.cell)
            counts[f["deviceId"]] = counts.get(f["deviceId"], 0) + 1
        # balanced, still random: every screen gets a fair share
        self.assertEqual(set(counts), {"A", "B", "C"})
        self.assertLess(max(counts.values()) / min(counts.values()), 2.2, counts)

    def test_food_grows_and_speeds_up_with_cap(self):
        g = snake(T("A", 0, 0), T("B", PW, 0))
        to_playing(g)
        start_len, start_speed = g.length, g.speed
        for i in range(60):
            hx, hy = g.path[0]
            g.food = {"x": hx, "y": hy, "id": 1000 + i, "deviceId": g.active}
            g._check_collisions()
        self.assertEqual(g.score, 60)
        self.assertAlmostEqual(g.length, start_len + 60 * self.CELL)
        self.assertGreater(g.speed, start_speed)
        self.assertLessEqual(g.speed, SNAKE_CONFIG["max_speed"])

    def test_lives_respawn_and_game_over(self):
        g = snake(T("A", 0, 0), T("B", PW, 0))
        to_playing(g)
        g.score = 5
        for life in range(SNAKE_CONFIG["lives"]):
            place(g, 2 * PW - 20, 72, "right", "B")
            self.assertTrue(run_until(g, lambda: g.phase == "crashed", 3))
            if life < SNAKE_CONFIG["lives"] - 1:
                self.assertTrue(run_until(g, lambda: g.phase == "respawn", 3))
                self.assertAlmostEqual(g.length, SNAKE_CONFIG["start_cells"] * self.CELL)
                self.assertTrue(run_until(g, lambda: g.phase == "playing", 3))
        self.assertTrue(run_until(g, lambda: g.over, 3))
        st = g.build_state()["stats"]
        self.assertEqual(st["score"], 5)
        self.assertIn("control", st)

    def test_start_position_has_room(self):
        for tiles in ((T("A", 0, 0), T("B", PW, 0)),
                      (T("A", 0, 0), T("B", PW, 0, 90)),
                      (T("A", 0, 0), T("B", 0, PH), T("C", PW, PH))):
            g = snake(*tiles)
            hx, hy = g.path[0]
            self.assertGreaterEqual(g._free_run(hx, hy, g.dir, 100), 3 * self.CELL)
            for x, y in g.path:
                self.assertTrue(g.world.is_playable_point(x, y, g.r))

    def test_game_time_only_moves_in_update(self):
        g = snake(T("A", 0, 0), T("B", PW, 0))
        to_playing(g)
        before = [list(p) for p in g.path]
        import time
        time.sleep(0.05)   # wall clock passing does nothing
        self.assertEqual(g.path, before)


# ---------------------------------------------------------------------------
# Session: pause, reconnect, orientation, lifecycle (fake sockets)
# ---------------------------------------------------------------------------

class FakeCM:
    def __init__(self):
        self.sent = []

    async def send_to(self, ws, payload):
        self.sent.append((ws, payload))

    async def broadcast_all(self, payload):
        self.sent.append((None, payload))


def last(cm, ws, type_):
    for w, p in reversed(cm.sent):
        if w is ws and p["type"] == type_:
            return p
    return None


INFO = {"cssWidth": 390, "cssHeight": 844, "dpr": 3, "capabilities": {"touch": True}}


class SessionHelpers:
    def setUp(self):
        self.loop = asyncio.new_event_loop()

    def tearDown(self):
        pending = [t for t in asyncio.all_tasks(self.loop) if not t.done()]
        for t in pending:
            t.cancel()
        if pending:
            self.loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
        self.loop.close()

    def run_(self, coro):
        return self.loop.run_until_complete(coro)

    def _setup_two(self):
        cm = FakeCM()
        m = ms.MultiScreenManager(cm)
        a, b = object(), object()
        ua, ub = {"id": 1, "name": "TIM"}, {"id": 2, "name": "SARAH"}
        self.run_(m.create(ua, a, {"game": "snake", "deviceId": "devAAAAAAAA", "device": INFO}))
        code = next(iter(m.sessions))
        self.run_(m.join(ub, b, {"code": code, "deviceId": "devBBBBBBBB", "device": INFO}))
        return cm, m, m.sessions[code], a, b, ua, ub


class SessionTest(SessionHelpers, unittest.TestCase):
    def test_auto_row_layout_is_valid_and_locks(self):
        cm, m, s, a, b, ua, ub = self._setup_two()
        st = last(cm, a, "ms_state")["state"]
        self.assertEqual([p["code"] for p in st["layout"]["problems"] if p["severity"] == "error"], [])
        self.assertEqual(len(st["layout"]["passages"]), 1)
        self.run_(m.confirm_layout(b, {}))           # only the host may lock
        self.assertEqual(s.phase, "setup")
        self.run_(m.confirm_layout(a, {}))
        self.assertEqual(s.phase, "ready")
        self.assertTrue(all(d.frozen for d in s.devices.values()))

    def test_frozen_size_ignores_browser_bar_but_orientation_flip_pauses(self):
        cm, m, s, a, b, ua, ub = self._setup_two()
        self.run_(m.confirm_layout(a, {}))

        async def go():
            await m.start_game(a, {})
            await m.device_info(b, {"device": dict(INFO, cssHeight=790)})    # URL bar
            size_after_bar = s.devices["devBBBBBBBB"].size()
            paused_after_bar = m._is_paused(s)
            await m.device_info(b, {"device": dict(INFO, cssWidth=844, cssHeight=390)})  # rotated
            flipped = dict(s.pause_reasons)
            await m.device_info(b, {"device": INFO})                          # rotated back
            s.task.cancel()
            return size_after_bar, paused_after_bar, flipped
        size, paused_bar, flipped = self.run_(go())
        self.assertEqual(size, geo.device_local_size(390, 844))
        self.assertFalse(paused_bar)
        self.assertIn("orientation:devBBBBBBBB", flipped)
        self.assertNotIn("orientation:devBBBBBBBB", s.pause_reasons)
        self.assertGreater(s.resume_until, 0)   # 3-2-1 before it moves again

    def test_disconnect_pauses_and_reconnect_resumes_same_tile(self):
        cm, m, s, a, b, ua, ub = self._setup_two()
        self.run_(m.confirm_layout(a, {}))
        placement = dict(s.placements["devBBBBBBBB"])

        async def go():
            await m.start_game(a, {})
            await asyncio.sleep(0.2)
            t_before = s.game.time
            await m.handle_disconnect(b)
            paused = m._is_paused(s)
            await asyncio.sleep(0.3)
            frozen_time = s.game.time
            b2 = object()
            await m.join(ub, b2, {"code": s.code, "deviceId": "devBBBBBBBB", "device": INFO})
            resumed_reasons = dict(s.pause_reasons)
            s.task.cancel()
            return t_before, paused, frozen_time, resumed_reasons, b2
        t_before, paused, frozen_time, reasons, b2 = self.run_(go())
        self.assertTrue(paused)
        self.assertAlmostEqual(frozen_time, t_before, delta=0.1)   # world stood still
        self.assertEqual(reasons, {})
        self.assertEqual(s.placements["devBBBBBBBB"], placement)
        self.assertIs(s.devices["devBBBBBBBB"].ws, b2)
        self.assertGreater(s.resume_until, 0)

    def test_grace_expiry_gives_host_the_choice(self):
        cm, m, s, a, b, ua, ub = self._setup_two()
        self.run_(m.confirm_layout(a, {}))
        old = ms.GRACE_SECONDS
        ms.GRACE_SECONDS = 0.1
        try:
            async def go():
                await m.start_game(a, {})
                await m.handle_disconnect(b)
                await asyncio.sleep(0.4)
                prompt = m._pause_public(s, __import__("time").time())["hostPrompt"]
                await m.host_action(a, {"action": "reconfigure"})
                return prompt
            prompt = self.run_(go())
        finally:
            ms.GRACE_SECONDS = old
        self.assertTrue(prompt)
        self.assertEqual(s.phase, "setup")
        self.assertNotIn("devBBBBBBBB", s.devices)
        self.assertIsNone(s.game)

    def test_hidden_controller_pauses(self):
        cm, m, s, a, b, ua, ub = self._setup_two()
        self.run_(m.confirm_layout(a, {}))

        async def go():
            await m.start_game(a, {})
            s.game._set_phase("playing")   # nobody controls during the intro
            ctrl = s.game.active
            ws = a if ctrl == "devAAAAAAAA" else b
            other = b if ws is a else a
            await m.visibility(other, {"hidden": True})
            other_paused = m._is_paused(s)
            await m.visibility(ws, {"hidden": True})
            paused = m._is_paused(s)
            await m.visibility(ws, {"hidden": False})
            s.task.cancel()
            return other_paused, paused
        other_paused, paused = self.run_(go())
        self.assertFalse(other_paused)
        self.assertTrue(paused)
        self.assertFalse(any(k.startswith("hidden:") for k in s.pause_reasons))

    def test_loop_stops_after_game_over_and_empty_session_is_dropped(self):
        cm, m, s, a, b, ua, ub = self._setup_two()
        self.run_(m.confirm_layout(a, {}))
        old = ms.EMPTY_SESSION_TTL
        ms.EMPTY_SESSION_TTL = 0.1
        try:
            async def go():
                await m.start_game(a, {})
                task = s.task
                s.game.force_over()
                await asyncio.sleep(0.2)
                done = task.done()
                await m.handle_disconnect(a)
                await m.handle_disconnect(b)
                await asyncio.sleep(0.3)
                return done
            done = self.run_(go())
        finally:
            ms.EMPTY_SESSION_TTL = old
        self.assertTrue(done)
        self.assertEqual(m.sessions, {})

    def test_foreign_user_cannot_hijack_a_device(self):
        cm, m, s, a, b, ua, ub = self._setup_two()
        c = object()
        self.run_(m.join({"id": 3, "name": "EVE"}, c, {"code": s.code, "deviceId": "devBBBBBBBB", "device": INFO}))
        self.assertIs(s.devices["devBBBBBBBB"].ws, b)
        self.assertIn("jemand anderem", last(cm, c, "ms_error")["message"])

    def test_device_info_is_sanitized(self):
        info = ms.sanitize_device_info({"cssWidth": 1e9, "cssHeight": "abc", "dpr": -3, "userAgent": "x", "pxPerMm": 999})
        self.assertEqual(set(info), {"cssWidth", "cssHeight", "dpr", "orientation", "pxPerMm", "safeArea", "capabilities"})
        self.assertEqual(info["cssWidth"], 5000)
        self.assertEqual(info["pxPerMm"], 30)

    def test_layout_update_host_only_and_validated(self):
        cm, m, s, a, b, ua, ub = self._setup_two()
        before = dict(s.placements)
        self.run_(m.layout_update(b, {"tiles": [{"deviceId": "devAAAAAAAA", "x": 500, "y": 0, "rotation": 0}]}))
        self.assertEqual(s.placements, before)
        self.run_(m.layout_update(a, {"tiles": [{"deviceId": "devAAAAAAAA", "x": 0, "y": 0, "rotation": 45},
                                                {"deviceId": "devBBBBBBBB", "x": "nan", "y": 0, "rotation": 0}]}))
        self.assertEqual(s.placements, {})


# ---------------------------------------------------------------------------
# Tests 14-44 of the original brief that the tests above didn't pin down yet
# ---------------------------------------------------------------------------

def quick(css_w, css_h):
    return geo.device_local_size(css_w, css_h)


def turn_on_line(g, d):
    """Queue a turn from whichever screen may steer right now."""
    return g.handle_input(g.active, {"dir": d})


class AppendixSnakeTest(unittest.TestCase):
    CELL = SNAKE_CONFIG["cell"]

    def test_16_24_different_sizes_quick_mode_there_and_back(self):
        # small iPhone (375x667) next to a big Android (412x915), quick mode
        sw, sh = quick(375, 667)
        bw, bh = quick(412, 915)
        self.assertLess(sh, bh)
        g = snake(T("A", 0, 0, 0, sw, sh), T("B", sw, 0, 0, bw, bh))
        to_playing(g)
        place(g, 27, 54, "right", "A")
        self.assertTrue(run_until(g, lambda: g.active == "B", 3))              # A -> B
        self.assertTrue(turn_on_line(g, "down"))
        self.assertTrue(turn_on_line(g, "left"))                               # U-turn one lane lower
        self.assertTrue(run_until(g, lambda: g.active == "A", 4))              # B -> A: control goes back
        self.assertEqual(g.phase, "playing")
        self.assertEqual(g.stats["crossings"], 2)
        self.assertFalse(g.handle_input("B", {"dir": "up"}))
        self.assertTrue(g.handle_input("A", {"dir": "up"}))

    def test_26_buffered_180_on_the_next_screen_is_ignored(self):
        g = snake(T("A", 0, 0), T("B", PW, 0))
        to_playing(g)
        place(g, 27, 72, "right", "A")
        self.assertTrue(run_until(g, lambda: g.handoff_target == "B", 3))
        self.assertFalse(g.handle_input("B", {"dir": "left"}))   # moving right: left would be a 180
        self.assertIsNone(g.handoff_buffer)
        self.assertTrue(run_until(g, lambda: g.active == "B", 3))
        self.assertEqual(g.dir, "right")
        self.assertEqual(g.phase, "playing")

    def test_27_one_body_across_three_screens_no_double_segments(self):
        tiles = (T("A", 0, 0), T("B", PW, 0), T("C", 2 * PW, 0))
        g = snake(*tiles)
        to_playing(g)
        g.path = [[2 * PW + 27, 72], [9, 72]]
        g.length = 2 * PW + 18
        g.dir, g.queue, g._last_turn, g.active = "right", [], None, "C"
        covered = set()
        (hx, hy), (tx, _) = g.path
        steps = int(hx - tx)
        for k in range(steps + 1):
            x = tx + k
            if any(abs(x - e) < 0.05 for e in (PW, 2 * PW)):
                continue   # exactly on a shared edge: belongs to both borders
            owners = [t.device_id for t in tiles if geo.point_inside(t, x, hy)]
            self.assertEqual(len(owners), 1, (x, owners))          # each body point on exactly ONE phone
            covered.add(owners[0])
            lx, ly = geo.world_to_local(g.world.by_id[owners[0]], x, hy)
            self.assertTrue(0 <= lx <= PW and 0 <= ly <= PH)       # ... and inside that phone's own glass
        self.assertEqual(covered, {"A", "B", "C"})
        run_until(g, lambda: False, 0.3)
        for (ax, ay), (bx, by) in zip(g.path, g.path[1:]):      # still one axis-aligned polyline
            self.assertTrue(abs(ax - bx) < 1e-6 or abs(ay - by) < 1e-6)

    def test_29_food_on_a_remote_screen_is_reachable_through_the_world(self):
        # 2x2 table; head on A, food on D (diagonal - no direct passage):
        # the snake has to travel A -> B -> D
        g = snake(T("A", 0, 0), T("B", PW, 0), T("C", 0, PH), T("D", PW, PH))
        to_playing(g)
        place(g, 27, 72, "right", "A")
        fx, fy = 99.0, 207.0
        self.assertEqual(g.world.get_tile_for_point(fx, fy).device_id, "D")
        g.food = {"x": fx, "y": fy, "id": 999, "deviceId": "D"}
        route, queued = ["A"], False
        for _ in range(30 * 8):
            hx, hy = g.path[0]
            if not queued and g.dir == "right" and fx - self.CELL < hx < fx:
                queued = turn_on_line(g, "down")          # turns exactly on the food's column
            g.update(1 / 30)
            if g.active != route[-1]:
                route.append(g.active)
            if g.score:
                break
        self.assertEqual(g.score, 1, (g.phase, g.crash, g.path[0]))
        self.assertEqual(route, ["A", "B", "D"])

    def test_41_five_minutes_no_drift(self):
        # mixed phones, 30 Hz, 5 minutes of game time with an autopilot that
        # dodges walls; lives are topped up so the run never ends early
        sizes = [quick(375, 667), quick(412, 915), quick(390, 844), quick(360, 800)]
        x, tiles = 0.0, []
        for i, (w, h) in enumerate(sizes):
            tiles.append(T(f"P{i}", x, 0, 0, w, h))
            x += w
        g = snake(*tiles, seed=3)
        dt, steps = 1 / 30, 30 * 300
        sizes_seen = set()
        for n in range(steps):
            g.lives = 99
            if g.phase == "playing" and g.active:
                hx, hy = g.path[0]
                if g._free_run(hx, hy, g.dir, 2 * self.CELL) < 2 * self.CELL and not g.queue:
                    options = [d for d in DIRS_ if g._legal_after(g.dir, d)]
                    best = max(options, key=lambda d: g._free_run(hx, hy, d, 20 * self.CELL))
                    g.handle_input(g.active, {"dir": best})
            g.update(dt)
            self.assertAlmostEqual(g.time, (n + 1) * dt, places=6)        # game time never drifts
            for px, py in g.path:
                self.assertTrue(math.isfinite(px) and math.isfinite(py))
            for (ax, ay), (bx, by) in zip(g.path, g.path[1:]):
                self.assertTrue(abs(ax - bx) < 1e-6 or abs(ay - by) < 1e-6)
            if g.phase == "playing":
                self.assertTrue(geo.point_inside(g.world.by_id[g.active], *g.path[0], eps=0.5))
            if g.food:
                self.assertTrue(g.world.contains_point(g.food["x"], g.food["y"]))
            self.assertLessEqual(g.speed, SNAKE_CONFIG["max_speed"])
            if n % 300 == 0:
                sizes_seen.add(len(__import__("json").dumps(g.build_state())) // 500)
        self.assertGreater(g.stats["playTime"], 60)
        self.assertGreater(g.stats["crossings"], 3)
        self.assertLessEqual(len(g.events), SNAKE_CONFIG["max_events"])
        self.assertLessEqual(max(sizes_seen), 4)   # snapshots stay small (< ~2.5 KB) the whole run


DIRS_ = tuple(geo.DIR_VECTORS)


class AppendixSessionTest(SessionHelpers, unittest.TestCase):
    """Session-level parts of tests 14/15/17/21/39/42 (fake sockets)."""

    def test_14_disconnected_tile_blocks_the_start_and_names_the_phone(self):
        cm, m, s, a, b, ua, ub = self._setup_two()
        self.run_(m.layout_update(a, {"tiles": [{"deviceId": "devAAAAAAAA", "x": 0, "y": 0, "rotation": 0},
                                                {"deviceId": "devBBBBBBBB", "x": 400, "y": 400, "rotation": 0}]}))
        self.run_(m.confirm_layout(a, {}))
        self.assertEqual(s.phase, "setup")
        self.assertIn("SARAH", last(cm, a, "ms_error")["message"])
        self.run_(m.start_game(a, {}))
        self.assertIsNone(s.game)

    def test_15_overlapping_tiles_block_and_are_marked(self):
        cm, m, s, a, b, ua, ub = self._setup_two()
        self.run_(m.layout_update(a, {"tiles": [{"deviceId": "devAAAAAAAA", "x": 0, "y": 0, "rotation": 0},
                                                {"deviceId": "devBBBBBBBB", "x": 30, "y": 20, "rotation": 0}]}))
        problems = last(cm, a, "ms_state")["state"]["layout"]["problems"]
        overlap = [p for p in problems if p["code"] == "overlap"]
        self.assertTrue(overlap)
        self.assertEqual(sorted(overlap[0]["devices"]), ["devAAAAAAAA", "devBBBBBBBB"])   # both tiles get marked red
        self.run_(m.confirm_layout(a, {}))
        self.assertEqual(s.phase, "setup")

    def test_17_21_precision_calibration_sizes_the_tile_and_survives_a_reconnect(self):
        cm, m, s, a, b, ua, ub = self._setup_two()
        self.run_(m.device_info(b, {"device": dict(INFO, pxPerMm=6.3)}))
        want = geo.device_local_size(390, 844, px_per_mm=6.3)
        self.assertEqual(tuple(round(v, 2) for v in s.devices["devBBBBBBBB"].size()), tuple(round(v, 2) for v in want))
        self.run_(m.confirm_layout(a, {}))
        tile_before = s.build_world().by_id["devBBBBBBBB"]

        async def go():
            await m.start_game(a, {})
            await m.handle_disconnect(b)
            await m.join(ub, object(), {"code": s.code, "deviceId": "devBBBBBBBB", "device": dict(INFO, pxPerMm=6.3)})
            s.task.cancel()
        self.run_(go())
        tile_after = s.build_world().by_id["devBBBBBBBB"]
        self.assertEqual((tile_after.x, tile_after.y, tile_after.w, tile_after.h, tile_after.rotation),
                         (tile_before.x, tile_before.y, tile_before.w, tile_before.h, tile_before.rotation))

    def test_39_controller_drops_out_the_snake_stops_at_once(self):
        cm, m, s, a, b, ua, ub = self._setup_two()
        self.run_(m.confirm_layout(a, {}))

        async def go():
            await m.start_game(a, {})
            s.game._set_phase("playing")
            ctrl_ws = a if s.game.active == "devAAAAAAAA" else b
            await asyncio.sleep(0.15)
            await m.handle_disconnect(ctrl_ws)
            paused = m._is_paused(s)
            head = list(s.game.path[0])
            await asyncio.sleep(0.4)
            moved = s.game.path[0] != head
            s.task.cancel()
            return paused, moved
        paused, moved = self.run_(go())
        self.assertTrue(paused)
        self.assertFalse(moved)                      # no snake running blind

    def test_42_ten_rematches_keep_the_layout_and_one_loop(self):
        cm, m, s, a, b, ua, ub = self._setup_two()
        self.run_(m.confirm_layout(a, {}))
        layout = dict(s.placements)

        async def go():
            await m.start_game(a, {})
            live_counts = []
            for _ in range(10):
                s.game.force_over()
                await asyncio.sleep(0.12)                       # the loop notices and ends
                await m.host_action(a, {"action": "restart"})   # [NOCHMAL]
                await asyncio.sleep(0.05)
                runs = [t for t in asyncio.all_tasks() if not t.done() and getattr(t.get_coro(), "__name__", "") == "_run"]
                live_counts.append(len(runs))
            same_layout = s.placements == layout and s.phase == "game" and not s.game.over
            await m.host_action(a, {"action": "end"})
            await asyncio.sleep(0.12)
            await m.host_action(a, {"action": "back_to_setup"})  # [HANDYS NEU ANORDNEN]
            return live_counts, same_layout
        live_counts, same_layout = self.run_(go())
        self.assertEqual(live_counts, [1] * 10)
        self.assertTrue(same_layout)
        self.assertEqual(s.phase, "setup")
        self.assertIsNone(s.game)

    def test_mixed_device_matrix_forms_one_valid_row(self):
        cm, m = FakeCM(), None
        m = ms.MultiScreenManager(cm)
        phones = [(375, 667), (390, 844), (393, 852), (430, 932), (360, 800), (412, 915), (844, 390)]
        sockets = [object() for _ in phones]
        for i, ((w, h), ws) in enumerate(zip(phones, sockets)):
            info = dict(INFO, cssWidth=w, cssHeight=h)
            user = {"id": 10 + i, "name": f"P{i}"}
            if i == 0:
                self.run_(m.create(user, ws, {"game": "snake", "deviceId": f"dev{i:08d}", "device": info}))
                code = next(iter(m.sessions))
            else:
                self.run_(m.join(user, ws, {"code": code, "deviceId": f"dev{i:08d}", "device": info}))
        s = m.sessions[code]
        world = s.build_world()
        errors = [p for p in world.validate() if p["severity"] == "error"]
        self.assertEqual(errors, [])
        self.assertEqual(len(world.tiles), len(phones))
        self.assertEqual(len({tuple(sorted((p.a, p.b))) for p in world.passages}), len(phones) - 1)   # (stored once per side)
        heights = {round(t.h, 1) for t in world.tiles}
        self.assertGreater(len(heights), 3)            # really different screens, not clones
        order = walk(world, (5, 60), "right", steps=4000)   # the row is centre-aligned
        self.assertEqual(len(order), len(phones))     # one straight line crosses every phone


if __name__ == "__main__":
    unittest.main()
