"""Pure physics tests for KopfKicker (backend/kopf_kicker.py) - no browser,
no server, just the engine's fixed-timestep step function.

    python -m unittest tests.test_kopfkicker_physics -v

The simulation helpers print a short log with -v so tuning changes can be
compared run to run (drop apexes, wall-decay speeds, idle-match energy).
"""

import asyncio
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from backend import kopf_kicker as kk  # noqa: E402

CFG = kk.KOPF_PHYSICS_CONFIG
DT = kk.PHYSICS_DT
G = CFG["BALL"]["gravity"]
R = kk.BALL_RADIUS
REST_Y = kk.GROUND_Y - R
VERBOSE = "-v" in sys.argv or "--verbose" in sys.argv


def log(*a):
    if VERBOSE:
        print("   ", *a)


def new_state(sandbox=False, players_far=False):
    s = kk.KopfKickerEngine.init_state([{"user_id": 1, "name": "L"}, {"user_id": 2, "name": "R"}])
    s["phase"] = "sandbox" if sandbox else "playing"  # sandbox = no goals registered
    s["golden_goal"] = True
    kk._reset_positions(s)
    if players_far:
        s["players"]["1"]["x"] = kk.PLAYER_MIN_X
        s["players"]["2"]["x"] = kk.PLAYER_MAX_X
    return s


def left(s):
    return s["players"]["1"]


def right(s):
    return s["players"]["2"]


def set_ball(s, **kw):
    s["ball"].update({"vx": 0.0, "vy": 0.0, "asleep": False})
    s["ball"].update(kw)


def press(s, uid, action, **extra):
    """apply_input only accepts inputs while playing - sandbox states
    (goals disabled) flip to playing just for the call."""
    phase = s["phase"]
    s["phase"] = "playing"
    kk.KopfKickerEngine.apply_input(s, uid, {"action": action, **extra})
    s["phase"] = phase


def energy(ball):
    """Mechanical energy per unit mass: kinetic + potential above rest."""
    return 0.5 * (ball["vx"] ** 2 + ball["vy"] ** 2) + G * (REST_Y - ball["y"])


def speed(ball):
    return math.hypot(ball["vx"], ball["vy"])


def step(s, n=1):
    for _ in range(n):
        kk.step_physics(s, DT, now=1000.0)


def seconds(t):
    return int(round(t / DT))


# Every static surface may only keep energy with a loss. Numerically the
# position correction can hand back at most ~one substep of gravity
# travel (g * v * sdt^2 order) - this tolerance is that, not a fudge for
# real energy creation (which is orders of magnitude larger).
ENERGY_TOL = G * 1.5


class BallDropTest(unittest.TestCase):
    def test_drop_from_200_bounces_a_few_times_then_sleeps(self):
        s = new_state(sandbox=True, players_far=True)
        drop = 320  # ~200 units of the 1000x560 reference world
        set_ball(s, x=800, y=REST_Y - drop)
        apexes, going_up, apex = [], False, 0.0
        slept_at = None
        for i in range(seconds(6)):
            step(s)
            b = s["ball"]
            h = REST_Y - b["y"]
            if b["vy"] < 0:
                going_up, apex = True, max(apex, h)
            elif going_up:
                apexes.append(round(apex, 1))
                going_up, apex = False, 0.0
            if b["asleep"] and slept_at is None:
                slept_at = i * DT
        log("drop apexes:", apexes, "asleep at", slept_at)
        visible = [a for a in apexes if a >= 10]
        self.assertGreaterEqual(len(visible), 3, apexes)
        self.assertLessEqual(len(apexes), 8, apexes)
        for a, b in zip(apexes, apexes[1:]):
            self.assertLess(b, a * 0.6, apexes)  # clearly smaller every time
        self.assertIsNotNone(slept_at)
        self.assertLess(slept_at, 4.0)
        # asleep = truly still, no micro jitter
        x, y = s["ball"]["x"], s["ball"]["y"]
        step(s, 120)
        self.assertEqual((s["ball"]["x"], s["ball"]["y"]), (x, y))


class WallDecayTest(unittest.TestCase):
    def test_side_wall_bounces_lose_speed_every_time(self):
        s = new_state(sandbox=True, players_far=True)
        s["players"]["1"]["x"] = s["players"]["2"]["x"] = 800  # out of the way, mid field
        set_ball(s, x=1300, y=200, vx=1300, vy=-900)
        speeds_at_wall = []
        prev_vx = s["ball"]["vx"]
        for _ in range(seconds(8)):
            step(s)
            vx = s["ball"]["vx"]
            if prev_vx * vx < 0 and abs(prev_vx) > 50:
                speeds_at_wall.append((round(abs(prev_vx)), round(abs(vx))))
            prev_vx = vx
        log("wall/net contacts (in -> out |vx|):", speeds_at_wall)
        self.assertGreaterEqual(len(speeds_at_wall), 2)
        for vin, vout in speeds_at_wall:
            self.assertLess(vout, vin * 0.82 + 1)  # walls 0.76, crossbar corner 0.80
        outs = [o for _i, o in speeds_at_wall]
        self.assertTrue(all(b < a for a, b in zip(outs, outs[1:])), outs)


class NoEnergyCreationTest(unittest.TestCase):
    """Static colliders: mechanical energy must never go up."""

    def _assert_no_gain(self, s, secs, label):
        worst = 0.0
        e_prev = energy(s["ball"])
        contacts = 0
        for _ in range(seconds(secs)):
            before = s["ball"]["last_touch_at"], s.get("event_seq", 0)
            step(s)
            if (s["ball"]["last_touch_at"], s.get("event_seq", 0)) != before:
                contacts += 1
            e = energy(s["ball"])
            worst = max(worst, e - e_prev)
            e_prev = e
        log(f"{label}: worst single-step energy gain {worst:.0f} (tol {ENERGY_TOL:.0f}), contacts {contacts}")
        self.assertLessEqual(worst, ENERGY_TOL, label)

    def test_static_surfaces_and_players_never_add_energy(self):
        launches = [
            dict(x=800, y=300, vx=-1500, vy=-200),   # into left wall above goal
            dict(x=400, y=400, vx=-1800, vy=-600),   # up into crossbar area
            dict(x=448, y=300, vx=0, vy=0),          # onto a standing head
            dict(x=470, y=250, vx=-200, vy=600),     # glancing head hit
            dict(x=700, y=700, vx=-1200, vy=0),      # into a standing body
            dict(x=200, y=650, vx=-1500, vy=0),      # into the goal -> net (sandbox)
            dict(x=800, y=100, vx=900, vy=1200),     # floor at speed
        ]
        for launch in launches:
            s = new_state(sandbox=True)
            set_ball(s, **launch)
            self._assert_no_gain(s, 6, str(launch))

    def test_single_static_head_impact_never_speeds_ball_up(self):
        for angle_deg in range(-80, 81, 20):
            s = new_state(sandbox=True)
            p = left(s)
            hx, hy = p["x"], kk.GROUND_Y - kk.HEAD_OFFSET
            a = math.radians(angle_deg)
            # start just outside the head, aimed at its center at 900 u/s
            dist = kk.HEAD_RADIUS + R + 2
            nx, ny = math.sin(a), -math.cos(a)
            set_ball(s, x=hx + nx * dist, y=hy + ny * dist, vx=-nx * 900, vy=-ny * 900)
            e0 = energy(s["ball"])
            step(s, 3)
            self.assertLessEqual(energy(s["ball"]), e0 + ENERGY_TOL, angle_deg)


class MovingPlayerTest(unittest.TestCase):
    def test_running_player_transfers_energy(self):
        s = new_state(sandbox=True)
        p = left(s)
        set_ball(s, x=p["x"] + 160, y=REST_Y)
        s["ball"]["asleep"] = True
        p["input_dir"] = 1
        max_speed = 0.0
        for _ in range(seconds(1)):
            step(s)
            max_speed = max(max_speed, s["ball"]["vx"])
        log("run into resting ball -> ball vx", round(max_speed))
        self.assertGreater(max_speed, CFG["PLAYER"]["run_speed"])  # faster than the player: energy came from him

    def test_jumping_header_beats_static_head(self):
        def header(jump):
            s = new_state(sandbox=True)
            p = left(s)
            set_ball(s, x=p["x"] + 6, y=kk.GROUND_Y - kk.HEAD_OFFSET - 170, vy=300)
            if jump:
                press(s, 1, "jump")
            best = 0.0
            for _ in range(seconds(0.5)):
                step(s)
                best = max(best, -s["ball"]["vy"])
            return best
        static, moving = header(False), header(True)
        log("header upward speed static/jumping:", round(static), round(moving))
        self.assertGreater(moving, static * 1.3)


class KickTest(unittest.TestCase):
    def _ball_in_front(self, s, p):
        set_ball(s, x=p["x"] + p["facing"] * (kk.BODY_RADIUS + CFG["KICK"]["reach"] + 10), y=REST_Y)
        s["ball"]["asleep"] = True

    def test_kick_is_strong_and_hits_once(self):
        s = new_state(sandbox=True)
        p = left(s)
        self._ball_in_front(s, p)
        press(s, 1, "kick")
        kicks_seen = 0
        seq = s["event_seq"]
        best = 0.0
        for _ in range(seconds(0.4)):
            step(s)
            best = max(best, speed(s["ball"]))
            for ev in s["events"]:
                if ev["seq"] > seq:
                    seq = ev["seq"]
                    kicks_seen += ev["type"] == "kick"
        log("kick ball speed", round(best), "kick hits", kicks_seen)
        self.assertEqual(kicks_seen, 1)
        self.assertTrue(p["kick_consumed"])
        self.assertGreater(best, 1200)
        self.assertEqual(s["stats"]["1"]["kicks"], 1)

    def test_kick_clearly_stronger_than_running_into_ball(self):
        s = new_state(sandbox=True)
        p = left(s)
        set_ball(s, x=p["x"] + 160, y=REST_Y)
        p["input_dir"] = 1
        body = 0.0
        for _ in range(seconds(0.8)):
            step(s)
            body = max(body, speed(s["ball"]))
        s2 = new_state(sandbox=True)
        self._ball_in_front(s2, left(s2))
        press(s2, 1, "kick")
        kick = 0.0
        for _ in range(seconds(0.3)):
            step(s2)
            kick = max(kick, speed(s2["ball"]))
        log("body push", round(body), "vs kick", round(kick))
        self.assertGreater(kick, body * 1.4)

    def test_kick_spam_respects_cooldown(self):
        s = new_state(sandbox=True)
        p = left(s)
        self._ball_in_front(s, p)
        top = 0.0
        for _ in range(seconds(2)):
            press(s, 1, "kick")
            press(s, 1, "kick")
            step(s)
            top = max(top, speed(s["ball"]))
        allowed = math.floor(2 / CFG["KICK"]["cooldown"]) + 1
        log("kicks in 2s of spam:", s["stats"]["1"]["kicks"], "allowed", allowed, "top speed", round(top))
        self.assertLessEqual(s["stats"]["1"]["kicks"], allowed)
        self.assertLessEqual(top, CFG["BALL"]["max_speed"] + 1e-6)


class TunnelingTest(unittest.TestCase):
    V = CFG["BALL"]["max_speed"]

    def test_floor_at_max_speed(self):
        s = new_state(sandbox=True, players_far=True)
        set_ball(s, x=800, y=REST_Y - 60, vy=self.V)
        for _ in range(seconds(0.3)):
            step(s)
            self.assertLessEqual(s["ball"]["y"], REST_Y + 1.0)

    def test_crossbar_at_max_speed(self):
        s = new_state(sandbox=True, players_far=True)
        s["players"]["1"]["x"] = 800
        bar_y = kk.GOAL_TOP_Y - kk.POST_THICKNESS / 2
        # flat shot at the crossbar's height, straight at it
        set_ball(s, x=200, y=bar_y, vx=-self.V)
        crossed = False
        for _ in range(seconds(0.3)):
            step(s)
            if s["ball"]["x"] < kk.POST_THICKNESS - 2 and abs(s["ball"]["y"] - bar_y) < R / 2:
                crossed = True
        self.assertFalse(crossed)
        self.assertGreater(s["ball"]["vx"], 0)  # came back

    def test_head_at_max_speed(self):
        s = new_state(sandbox=True)
        p = left(s)
        hy = kk.GROUND_Y - kk.HEAD_OFFSET
        set_ball(s, x=p["x"] + 300, y=hy, vx=-self.V)
        for _ in range(seconds(0.3)):
            step(s)
            self.assertGreater(s["ball"]["x"], p["x"])  # never passes through the head
        self.assertGreater(s["ball"]["vx"], 0)


class GoalTest(unittest.TestCase):
    def test_fast_ball_scores_exactly_once(self):
        s = new_state()
        s["players"]["1"]["x"] = 800
        s["players"]["2"]["x"] = 900
        set_ball(s, x=150, y=kk.GROUND_Y - 80, vx=-CFG["BALL"]["max_speed"])
        for _ in range(seconds(1)):
            if s["phase"] == "playing":
                step(s)
        self.assertEqual(s["phase"], "goal_pause")
        self.assertEqual(s["score"], {"1": 0, "2": 1})
        before = dict(s["score"])
        for _ in range(20):
            kk.KopfKickerEngine.tick(s)  # goal pause ticks can't re-score
        self.assertEqual(s["score"], before)

    def test_ball_in_net_is_damped(self):
        s = new_state(sandbox=True, players_far=True)
        s["players"]["1"]["x"] = 800
        set_ball(s, x=-30, y=kk.GROUND_Y - 100, vx=-1200)
        vx_back = None
        prev = -1200
        for _ in range(seconds(1)):
            step(s)
            if prev < 0 <= s["ball"]["vx"] and vx_back is None:
                vx_back = s["ball"]["vx"]
            prev = s["ball"]["vx"]
        log("net: 1200 in ->", round(vx_back or 0), "back")
        self.assertIsNotNone(vx_back)
        self.assertLess(vx_back, 1200 * 0.5)


class IdleMatchTest(unittest.TestCase):
    """Nobody touches anything. The ball must calm down on its own."""

    SCENARIOS = {
        "kickoff": dict(),
        "fast-into-left-player": dict(x=800, y=640, vx=-900, vy=-250),
        "onto-left-head": dict(x=452, y=300),
        "high-lob-toward-right": dict(x=500, y=500, vx=700, vy=-1100),
        "rally-between-players": dict(x=600, y=620, vx=900, vy=-200),
    }

    def test_idle_ball_loses_energy_and_rests(self):
        for name, ball in self.SCENARIOS.items():
            s = new_state()
            if ball:
                set_ball(s, **ball)
            e0 = max(energy(s["ball"]), 1.0)
            contacts, goals, trace, asleep_at = 0, 0, [], None
            last_touch = s["ball"]["last_touch_at"]
            for i in range(seconds(20)):
                step(s)
                if s["ball"]["last_touch_at"] != last_touch:
                    contacts += 1
                    last_touch = s["ball"]["last_touch_at"]
                if s["phase"] != "playing":
                    goals += 1
                    break
                if s["ball"]["asleep"] and asleep_at is None:
                    asleep_at = round(i * DT, 1)
                if i % seconds(5) == seconds(5) - 1:
                    trace.append(f"{(i + 1) * DT:.0f}s:{speed(s['ball']):.0f}")
                if i == seconds(10):
                    e10 = energy(s["ball"])
                    self.assertLess(e10, e0 * 0.15, f"{name}: {e10:.0f} vs {e0:.0f}")
            log(f"idle {name}: speed {' '.join(trace)} asleep@{asleep_at} player-contacts={contacts} goal={bool(goals)}")
            if not goals:
                self.assertTrue(s["ball"]["asleep"], name)
                self.assertLess(asleep_at, 15, name)


class PlayerMovementTest(unittest.TestCase):
    def test_acceleration_is_fast_but_not_instant(self):
        s = new_state(sandbox=True)
        p = left(s)
        p["input_dir"] = 1
        step(s)
        self.assertLess(p["vx"], CFG["PLAYER"]["run_speed"] * 0.5)
        step(s, seconds(0.15))
        self.assertGreaterEqual(p["vx"], CFG["PLAYER"]["run_speed"] * 0.95)
        p["input_dir"] = 0
        step(s)
        self.assertGreater(p["vx"], 0)  # not a mathematical instant stop
        step(s, seconds(0.15))
        self.assertEqual(p["vx"], 0)

    def test_direction_change_is_short_and_continuous(self):
        s = new_state(sandbox=True)
        p = left(s)
        p["input_dir"] = 1
        step(s, seconds(0.3))
        p["input_dir"] = -1
        vxs = []
        for _ in range(seconds(0.3)):
            step(s)
            vxs.append(p["vx"])
        flip = next(i for i, v in enumerate(vxs) if v <= -CFG["PLAYER"]["run_speed"] * 0.95)
        log("direction flip frames:", flip, "first vx after flip:", round(vxs[0]))
        self.assertGreater(vxs[0], 0)  # still moving right on the first frame
        self.assertLess(flip * DT, 0.2)
        steps = [abs(b - a) for a, b in zip(vxs, vxs[1:])]
        self.assertLess(max(steps), CFG["PLAYER"]["run_speed"] * 0.5)

    def test_jump_buffer_fires_on_landing(self):
        s = new_state(sandbox=True)
        p = left(s)
        p.update(grounded=False, height=12.0, vy=500.0)
        press(s, 1, "jump")
        jumped = False
        for _ in range(seconds(0.12)):
            step(s)
            if p["vy"] < 0:
                jumped = True
                break
        self.assertTrue(jumped)

    def test_jump_pressed_too_early_is_dropped(self):
        s = new_state(sandbox=True)
        p = left(s)
        p.update(grounded=False, height=260.0, vy=0.0)
        press(s, 1, "jump")
        press(s, 1, "jump_release")
        for _ in range(seconds(0.6)):
            step(s)
        self.assertTrue(p["grounded"])
        self.assertEqual(p["vy"], 0)

    def test_coyote_time(self):
        def jump_after_leaving_ground(delay):
            s = new_state(sandbox=True)
            p = left(s)
            step(s)  # grounded -> coyote window armed
            p.update(grounded=False, height=4.0, vy=30.0)  # just walked off an edge
            step(s, seconds(delay))
            press(s, 1, "jump")
            step(s)
            return p["vy"] < 0
        self.assertTrue(jump_after_leaving_ground(0.04))
        # the jump buffer (0.1s) would still fire on landing - look at the
        # immediate step only: after the coyote window it can't jump mid-air
        s = new_state(sandbox=True)
        p = left(s)
        step(s)
        p.update(grounded=False, height=200.0, vy=0.0)
        step(s, seconds(0.12))
        press(s, 1, "jump")
        step(s)
        self.assertGreaterEqual(p["vy"], 0)

    def test_variable_jump_height(self):
        def apex(hold_steps):
            s = new_state(sandbox=True)
            p = left(s)
            press(s, 1, "jump")
            best = 0.0
            for i in range(seconds(0.8)):
                if i == hold_steps:
                    press(s, 1, "jump_release")
                step(s)
                best = max(best, p["height"])
            return best
        tap, hold = apex(5), apex(10_000)
        log("jump apex tap/hold:", round(tap), round(hold))
        self.assertLess(tap, hold * 0.7)
        self.assertGreater(tap, 30)

    def test_players_block_each_other(self):
        s = new_state(sandbox=True)
        left(s)["input_dir"] = 1
        right(s)["input_dir"] = -1
        step(s, seconds(2))
        self.assertGreaterEqual(right(s)["x"] - left(s)["x"], CFG["PLAYER"]["separation"] - 0.01)

    def test_players_stay_out_of_the_goal_frame(self):
        s = new_state(sandbox=True)
        left(s)["input_dir"] = -1
        step(s, seconds(3))
        self.assertGreaterEqual(left(s)["x"] - kk.HEAD_RADIUS, kk.POST_THICKNESS - 1e-6)


class TimestepAndLifecycleTest(unittest.TestCase):
    def test_catch_up_is_capped(self):
        s = new_state()
        s["last_tick_real"] = kk.time.time() - 2.0  # server stalled for 2s
        before = s["physics_step"]
        kk.KopfKickerEngine.tick(s)
        self.assertLessEqual(s["physics_step"] - before, kk.MAX_CATCHUP_STEPS)
        self.assertLess(s["accumulator"], kk.PHYSICS_DT)

    def test_leaving_the_lobby_ends_the_session(self):
        s = kk.KopfKickerEngine.init_state([{"user_id": 1, "name": "L"}, {"user_id": 2, "name": "R"}])
        kk.KopfKickerEngine.on_player_left(s, 2)
        self.assertIsNotNone(kk.KopfKickerEngine.check_finished(s))

    def test_everyone_gone_during_grace_ends_immediately(self):
        s = new_state()
        kk.KopfKickerEngine.on_player_left(s, 2)
        self.assertEqual(s["phase"], "disconnect_grace")
        kk.KopfKickerEngine.on_player_left(s, 1)
        kk.KopfKickerEngine.tick(s)
        self.assertIsNotNone(kk.KopfKickerEngine.check_finished(s))

    def test_kickoff_resets_inputs(self):
        s = new_state()
        p = left(s)
        press(s, 1, "move", dir=1)
        press(s, 1, "jump")
        press(s, 1, "kick")
        kk._start_kickoff(s, 0)
        self.assertEqual((p["input_dir"], p["jump_held"], p["kick_requested"]), (0, False, False))
        self.assertEqual((s["ball"]["vx"], s["ball"]["vy"]), (0.0, 0.0))

    def test_match_clock_golden_goal_and_end(self):
        """90s of PLAY (countdowns/goal pauses don't count), a tie goes to
        golden goal, the golden goal ends the match."""
        clock = [5000.0]
        real_time = kk.time.time
        kk.time.time = lambda: clock[0]
        try:
            E = kk.KopfKickerEngine
            s = E.init_state([{"user_id": 1, "name": "L"}, {"user_id": 2, "name": "R"}])
            s["selfies"] = {"1": "x", "2": "x"}
            s["ready"] = {"1": True, "2": True}
            E.apply_input(s, 1, {"action": "start_match"})

            def run(secs):
                for _ in range(int(secs * 30)):
                    clock[0] += 1 / 30
                    E.tick(s)

            run(kk.KICKOFF_COUNTDOWN_SECONDS + 0.1)
            self.assertEqual(s["phase"], "playing")
            self.assertEqual(E.public_state(s, 1)["secondsLeft"], 90)
            run(40)
            s["ball"].update(x=150, y=kk.GROUND_Y - 80, vx=-1800, vy=0, asleep=False)  # goal for R
            run(1)
            self.assertEqual(s["phase"], "goal_pause")
            left_at_goal = E.public_state(s, 1)["secondsLeft"]
            run(kk.GOAL_PAUSE_SECONDS + kk.KICKOFF_COUNTDOWN_SECONDS + 0.2)
            self.assertEqual(s["phase"], "playing")
            # paused meanwhile (only the 0.2s of play after kickoff may show)
            self.assertIn(E.public_state(s, 1)["secondsLeft"], (left_at_goal, left_at_goal - 1))
            s["ball"].update(x=1450, y=kk.GROUND_Y - 80, vx=1800, vy=0, asleep=False)  # 1:1
            run(1)
            run(kk.GOAL_PAUSE_SECONDS + kk.KICKOFF_COUNTDOWN_SECONDS + 0.2)
            run(52)
            self.assertTrue(s["golden_goal"])
            self.assertEqual(s["phase"], "playing")
            s["ball"].update(x=150, y=kk.GROUND_Y - 80, vx=-1800, vy=0, asleep=False)
            run(1)
            self.assertEqual(s["winner_uid"], "2")
            run(kk.GOAL_PAUSE_SECONDS + 0.2)
            self.assertEqual(E.check_finished(s)["winner_user_id"], 2)
        finally:
            kk.time.time = real_time

    def test_ten_rematches_one_loop_and_no_zombies(self):
        """GameManager-level: ten finished matches + rematches never leave
        more than one tick task alive, and an abandoned lobby's task ends."""
        from backend.games import GameManager

        class FakeCM:
            async def send_to(self, ws, payload):
                pass

            async def broadcast_all(self, payload):
                pass

        async def scenario():
            gm = GameManager(FakeCM())
            a, b = object(), object()
            await gm.create_session({"id": 1, "name": "A"}, a, "kopfkicker")
            sid = next(iter(gm.sessions))
            await gm.join_session({"id": 2, "name": "B"}, b, sid)
            session = gm.sessions[sid]
            tasks = []
            for _ in range(10):
                tasks.append(session.task)
                session.state["phase"] = "over"
                session.state["winner_uid"] = "1"
                await asyncio.sleep(kk.TICK_DT * 3)
                self.assertEqual(session.status, "over")
                await gm.handle_rematch({"id": 1, "name": "A"}, a, sid)
                await asyncio.sleep(0)
                alive = [t for t in tasks + [session.task] if t is not None and not t.done()]
                self.assertEqual(len(alive), 1)
            # back to an abandoned lobby: both leave -> task must end
            session.state["phase"] = "lobby"
            await gm.leave_session({"id": 2}, b, sid)
            await asyncio.sleep(kk.TICK_DT * 3)
            await gm.leave_session({"id": 1}, a, sid)
            await asyncio.sleep(kk.TICK_DT * 3)
            self.assertTrue(session.task is None or session.task.done())
            self.assertNotIn(sid, gm.sessions)

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
