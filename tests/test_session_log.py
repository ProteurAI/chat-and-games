"""The session token never reaches the server log (backend/log_redact.py).

The browser opens its WebSocket as /ws?token=<session token>; uvicorn logs that
request line. The filter must turn the value into *** and change nothing else.

    python -m unittest tests.test_session_log -v

1. the filter itself: a query string's `token` is redacted (first / middle /
   last parameter, encoded), other parameters and look-alikes stay, uvicorn's
   own formatters still get their arguments in the right shape
2. a real server (uvicorn from temp copies, log level info): log in, open the
   WebSocket with the token, receive the presence message, call an API route -
   the log has the WebSocket line and the API line, but not the token
"""

import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import log_redact  # noqa: E402

TOKEN = "f3a9c1d2e4b5a6978877665544332211"


def record(msg, args):
    return logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, msg, args, None)


class Redaction(unittest.TestCase):
    def test_query_parameter(self):
        r = log_redact.redact
        self.assertEqual(r(f"/ws?token={TOKEN}"), "/ws?token=***")
        self.assertEqual(r(f"/ws?token={TOKEN}&room=1"), "/ws?token=***&room=1")
        self.assertEqual(r(f"/x?a=1&token={TOKEN}"), "/x?a=1&token=***")
        self.assertEqual(r(f"/x?a=1&TOKEN={TOKEN}&b=2"), "/x?a=1&TOKEN=***&b=2")
        self.assertEqual(r("/ws?token=a%2Bb%3D"), "/ws?token=***")
        self.assertEqual(r(f'1.2.3.4 - "WebSocket /ws?token={TOKEN}" [accepted]'), '1.2.3.4 - "WebSocket /ws?token=***" [accepted]')

    def test_everything_else_stays(self):
        r = log_redact.redact
        for s in ("/api/channels", "/x?csrftoken=abc", "/x?x_token=abc", "/static/token=1.js", "GET / HTTP/1.1", ""):
            self.assertEqual(r(s), s)

    def test_filter_keeps_the_record_shape(self):
        f = log_redact.RedactTokenFilter()
        rec = record('%s - "%s %s HTTP/%s" %d', ("127.0.0.1:5000", "GET", f"/ws?token={TOKEN}", "1.1", 101))
        self.assertTrue(f.filter(rec))
        self.assertEqual(rec.args, ("127.0.0.1:5000", "GET", "/ws?token=***", "1.1", 101))
        self.assertNotIn(TOKEN, rec.getMessage())
        rec = record('%s - "WebSocket %s" [accepted]', (("127.0.0.1", 5000), f"/ws?token={TOKEN}"))
        f.filter(rec)
        self.assertEqual(rec.args[0], ("127.0.0.1", 5000))
        self.assertNotIn(TOKEN, rec.getMessage())
        rec = record("%(path)s", ({"path": f"/ws?token={TOKEN}"},))
        f.filter(rec)
        self.assertEqual(rec.getMessage(), "/ws?token=***")
        rec = record(f"plain /ws?token={TOKEN}", ())
        f.filter(rec)
        self.assertEqual(rec.getMessage(), "plain /ws?token=***")

    def test_uvicorn_access_formatter(self):
        from uvicorn.logging import AccessFormatter
        rec = record('%s - "%s %s HTTP/%s" %d', ("127.0.0.1:5000", "GET", f"/ws?token={TOKEN}&a=1", "1.1", 200))
        log_redact.RedactTokenFilter().filter(rec)
        out = AccessFormatter('%(client_addr)s - "%(request_line)s" %(status_code)s', use_colors=False).format(rec)
        self.assertIn("/ws?token=***&a=1", out)
        self.assertNotIn(TOKEN, out)

    def test_install_is_idempotent(self):
        name = "test.redact.idempotent"
        log_redact.install((name,))
        log_redact.install((name,))
        self.assertEqual(sum(isinstance(f, log_redact.RedactTokenFilter) for f in logging.getLogger(name).filters), 1)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class RealServer(unittest.TestCase):
    """uvicorn with its default logging (as on Render), the log captured to a file"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="tokenlog_"))
        shutil.copytree(ROOT / "backend", cls.tmp / "backend", ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copytree(ROOT / "static", cls.tmp / "static")
        shutil.copy(ROOT / "config.json", cls.tmp / "config.json")
        cls.port = free_port()
        cls.logf = open(cls.tmp / "server.log", "wb")
        env = dict(os.environ, PYTHONIOENCODING="utf-8")
        cls.proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", str(cls.port), "--log-level", "info"],
                                    cwd=cls.tmp, stdout=cls.logf, stderr=subprocess.STDOUT, env=env)
        cls.base = f"http://127.0.0.1:{cls.port}"
        for _ in range(150):
            try:
                urllib.request.urlopen(cls.base + "/", timeout=0.5)
                break
            except Exception:
                time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        try:
            cls.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cls.proc.kill()
        cls.logf.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def log_text(self):
        time.sleep(0.4)
        self.logf.flush()
        return (self.tmp / "server.log").read_bytes().decode("utf-8", "replace")

    def test_websocket_works_and_the_token_stays_out_of_the_log(self):
        from websockets.sync.client import connect
        cfg = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
        req = urllib.request.Request(self.base + "/api/login", data=json.dumps({"code": cfg["team_password"], "name": "LogCheck"}).encode(),
                                     headers={"Content-Type": "application/json"})
        token = json.loads(urllib.request.urlopen(req).read())["token"]
        self.assertGreater(len(token), 8)
        # the WebSocket, exactly as the browser opens it
        with connect(f"ws://127.0.0.1:{self.port}/ws?token={token}", open_timeout=5) as ws:
            msg = json.loads(ws.recv(timeout=5))
            self.assertEqual(msg.get("type"), "presence")
            self.assertIn("LogCheck", msg.get("online", []))
        # a wrong token still gets the 4401 close (the auth is unchanged)
        with connect(f"ws://127.0.0.1:{self.port}/ws?token=wrong-{TOKEN}", open_timeout=5) as ws:
            with self.assertRaises(Exception):
                ws.recv(timeout=5)
            self.assertEqual(ws.close_code, 4401)
        # an ordinary API call and a page with a token-like parameter
        api = urllib.request.Request(self.base + "/api/channels", headers={"X-Auth-Token": token})
        self.assertEqual(urllib.request.urlopen(api).status, 200)
        urllib.request.urlopen(self.base + f"/?token={token}&lang=de").read()
        text = self.log_text()
        self.assertNotIn(token, text, "the session token is in the server log")
        self.assertNotIn(TOKEN, text)
        self.assertIn("/ws?token=***", text)                                # the WebSocket line is still logged
        self.assertIn('"GET /api/channels HTTP/1.1" 200', text)             # other request lines are untouched
        self.assertIn("/?token=***&lang=de", text)
        self.assertIn("Application startup complete", text)                # and the server's own messages


if __name__ == "__main__":
    unittest.main()
