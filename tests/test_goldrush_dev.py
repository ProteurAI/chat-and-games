"""GoldRush developer access (backend/goldrush_dev.py) - the code source and the
diagnosis of a server that says "not configured" (phase 7A). No server, no
browser: the module's environment is replaced by a plain dict per test.

    python -m unittest tests.test_goldrush_dev -v

What must hold: the code comes from GOLDRUSH_DEV_CODE (trimmed) or a Render
secret file; the diagnosis names the answering server (Render's public
metadata) and why it is not configured - and never contains the code, a hash
of it, any other variable or token.
"""

import asyncio
import hashlib
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from backend import goldrush_dev as gd  # noqa: E402

SECRET = "qa-SeCrEt-7a-4711"


class DevAccessDiagnosis(unittest.TestCase):
    def setUp(self):
        self._os, self._files, self._delay = gd.os, gd.SECRET_FILES, gd.ATTEMPT_DELAY
        self.tmp = Path(tempfile.mkdtemp(prefix="grdev_"))
        gd.SECRET_FILES = (self.tmp / "GOLDRUSH_DEV_CODE",)

    def tearDown(self):
        gd.os, gd.SECRET_FILES, gd.ATTEMPT_DELAY = self._os, self._files, self._delay
        gd._fails.clear()
        gd._sessions.clear()

    def env(self, **kv):
        gd.os = types.SimpleNamespace(environ=dict(kv))

    def status(self):
        return asyncio.run(gd.dev_status(user={"id": 1}, x_goldrush_dev=None))

    def test_code_from_the_variable_trimmed(self):
        self.env(GOLDRUSH_DEV_CODE=f"  {SECRET}\n", RENDER_SERVICE_ID="srv-abc123", RENDER_GIT_COMMIT="9aec716d15b8")
        self.assertEqual(gd._code_source(), (SECRET, "env"))
        st = self.status()
        self.assertTrue(st["configured"])
        self.assertEqual(st["routeVersion"], gd.ROUTE_VERSION)
        # phase 9: the diagnosis comes always - the server that checks the code, where its code comes from
        d = st["diagnosis"]
        self.assertEqual((d["variable"], d["source"], d["quoted"], d["allowlist"], d["accountAllowed"], d["serviceId"], d["commit"]),
                         ("set", "env", False, False, True, "srv-abc123", "9aec716"))
        text = json.dumps(st)
        self.assertNotIn(SECRET, text)
        self.assertNotIn(hashlib.sha256(SECRET.encode()).hexdigest()[:12], text)
        self.assertNotIn(str(len(SECRET)), json.dumps({k: v for k, v in d.items() if k not in ("serviceId", "commit")}))

    def unlock(self, code, uid=1):
        gd._fails.clear()
        gd.ATTEMPT_DELAY = 0
        try:
            return asyncio.run(gd.dev_unlock({"code": code}, user={"id": uid}))
        except gd.HTTPException as e:
            return {"status": e.status_code, "detail": e.detail}

    def test_quoted_value_is_accepted_and_reported(self):
        self.env(GOLDRUSH_DEV_CODE=f'"{SECRET}"')
        self.assertEqual(gd._code_source(), (SECRET, "env"))
        self.assertTrue(self.status()["diagnosis"]["quoted"])
        self.assertIn("token", self.unlock(SECRET))
        self.assertIn("token", self.unlock(f'"{SECRET}"'))
        self.assertEqual(self.unlock(SECRET + "x")["status"], 403)

    def test_allowlist_is_checked_first_with_its_own_message(self):
        self.env(GOLDRUSH_DEV_CODE=SECRET, GOLDRUSH_DEV_USER_IDS="7, 9")
        d = self.status()["diagnosis"]                            # user 1: not on the list
        self.assertTrue(d["allowlist"])
        self.assertFalse(d["accountAllowed"])
        right, wrong = self.unlock(SECRET, uid=1), self.unlock("nope", uid=1)
        self.assertEqual(right["status"], 403)
        self.assertEqual(right, wrong)                            # says nothing about the code
        self.assertIn("nicht freigegeben", right["detail"])
        self.assertNotIn("Code nicht gültig", right["detail"])
        self.assertIn("token", self.unlock(SECRET, uid=9))
        self.assertEqual(self.unlock("nope", uid=9), {"status": 403, "detail": "Code nicht gültig."})

    def test_unicode_forms_compare_equal(self):
        self.env(GOLDRUSH_DEV_CODE="T\u00e9st-\uff23ode")          # composed e-acute, a full-width C
        self.assertIn("token", self.unlock("Te\u0301st-Code"))       # decomposed e-acute, an ASCII C

    def test_code_from_a_render_secret_file(self):
        self.env()
        (self.tmp / "GOLDRUSH_DEV_CODE").write_text(SECRET + "\n", encoding="utf-8")
        self.assertEqual(gd._code_source(), (SECRET, "secretFile"))
        self.assertTrue(self.status()["configured"])

    def test_missing_names_the_server_and_leaks_nothing(self):
        self.env(RENDER_SERVICE_NAME="instachat", RENDER_SERVICE_ID="srv-abc123", RENDER_INSTANCE_ID="inst-9",
                 RENDER_GIT_COMMIT="c1be4686408b38f5664c79395d213e374a9d7e17", RENDER_EXTERNAL_URL="https://instachat-20cm.onrender.com",
                 TEAM_PASSWORD="team-secret", OTHER_TOKEN="tok-123")
        st = self.status()
        self.assertFalse(st["configured"])
        d = st["diagnosis"]
        self.assertEqual(d["variable"], "missing")
        self.assertEqual((d["service"], d["serviceId"], d["instance"], d["commit"], d["externalUrl"]),
                         ("instachat", "srv-abc123", "inst-9", "c1be468", "https://instachat-20cm.onrender.com"))
        text = json.dumps(st)
        for s in ("team-secret", "tok-123", "TEAM_PASSWORD", "OTHER_TOKEN"):
            self.assertNotIn(s, text)

    def test_empty_and_near_miss(self):
        self.env(GOLDRUSH_DEV_CODE="   ")
        self.assertEqual(self.status()["diagnosis"]["variable"], "empty")
        self.env(**{"goldrush_dev_code": SECRET, "GOLDRUSH_DEV_CODE ": SECRET})       # wrong case / a trailing space
        st = self.status()
        self.assertFalse(st["configured"])
        self.assertEqual(st["diagnosis"]["variable"], "nearMiss")
        text = json.dumps(st)
        self.assertNotIn(SECRET, text)
        self.assertNotIn(hashlib.sha256(SECRET.encode()).hexdigest()[:12], text)
        self.assertNotIn("goldrush_dev_code", text)                                   # not even the near-miss key's name

    def test_empty_secret_file_is_reported(self):
        self.env()
        (self.tmp / "GOLDRUSH_DEV_CODE").write_text("  \n", encoding="utf-8")
        d = self.status()["diagnosis"]
        self.assertEqual(d["variable"], "missing")
        self.assertTrue(d["secretFile"])


if __name__ == "__main__":
    unittest.main()
