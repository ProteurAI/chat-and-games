"""Stale / invalid login sessions: a token the server no longer knows must
lead once, cleanly and without any reconnect loop, back to the login - a
temporary network problem must NOT. Includes the production case: the
database is reset by a restart/redeploy while browsers still hold old
tokens. Real server from a temp copy (the real database is never touched),
restarted in place for the restart cases.

    python tests/e2e/session_regression.py [--browser webkit]
"""

import json
import os
import secrets
import sqlite3
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from games_regression import RECORDER, wait  # noqa: E402
from kopfkicker_e2e import login, start_server  # noqa: E402

RESULTS = []
EXPIRED = "Deine Sitzung ist abgelaufen. Bitte melde dich erneut an."
PREFS = {"cg_theme": "dark", "ms_px_per_mm": "6", "ms_device_id": "devKEEPME01", "cg_games_panel_collapsed": "1"}
NOISE = ("Failed to load resource", "WebSocket connection", "favicon", 'Viewport argument key "interactive-widget"')


# the app's own window/document listeners - Playwright adds its own input
# listeners (and a "__playwright_global_listeners_check__") on navigations it
# starts itself, but not on a reload the page triggers, so those don't count
APP_LISTENERS = """() => {
  const pw = new Set(['__playwright_global_listeners_check__', 'click', 'auxclick', 'dblclick', 'contextmenu', 'mousedown', 'mouseup',
                      'mousemove', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'touchcancel']);
  return Object.entries(window.__counts || {}).filter(([k]) => !pw.has(k.slice(2))).reduce((a, [, v]) => a + v, 0);
}"""
RECORDER_WITH_COUNTS = RECORDER.replace("window.__listeners = () => Object.values(counts).reduce((a, b) => a + b, 0);",
                                        "window.__listeners = () => Object.values(counts).reduce((a, b) => a + b, 0); window.__counts = counts;")


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""), flush=True)


# every toast the page ever showed, across reloads (reported to Python)
TOAST_SPY = """
document.addEventListener('DOMContentLoaded', () => {
  const region = document.getElementById('toast');
  if (!region) return;
  new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes)
    if (n.nodeType === 1) window.__reportToast(n.textContent || ''); }).observe(region, { childList: true });
});
"""


def restart_server(proc, base, tmp, wipe_db):
    """Stop the server and start it again on the same port and folder -
    optionally with a fresh, empty database (what a redeploy on an
    ephemeral disk does)."""
    port = int(base.rsplit(":", 1)[1])
    proc.terminate()
    proc.wait(10)
    if wipe_db:
        for f in (tmp / "data").glob("instachat.db*"):
            f.unlink()
    for _ in range(30):
        new = subprocess.Popen([sys.executable, "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", str(port),
                                "--log-level", "warning"], cwd=tmp, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            try:
                urllib.request.urlopen(base + "/", timeout=0.5)
                return new
            except Exception:
                if new.poll() is not None:
                    break
                time.sleep(0.1)
        time.sleep(0.3)   # port still held by the old process: try again
    raise RuntimeError("server did not come back")


def db_exec(tmp, sql, args=()):
    conn = sqlite3.connect(tmp / "data" / "instachat.db")
    conn.execute(sql, args)
    conn.commit()
    conn.close()


class Client:
    def __init__(self, browser, base, w=1440, h=900, phone=False):
        kw = dict(viewport={"width": w, "height": h})
        if phone:
            kw.update(device_scale_factor=3, is_mobile=True, has_touch=True)
        self.ctx = browser.new_context(**kw)
        self.toasts, self.errors, self.ws_opened, self.r401, self.navs = [], [], [], [], 0
        self.ctx.expose_function("__reportToast", lambda t: self.toasts.append(t))
        self.ctx.add_init_script(RECORDER_WITH_COUNTS)
        self.ctx.add_init_script(TOAST_SPY)
        self.page = p = self.ctx.new_page()
        p.on("pageerror", lambda e: self.errors.append(str(e)))
        p.on("console", lambda m: self.errors.append(m.text) if m.type == "error" else None)
        p.on("websocket", lambda w: self.ws_opened.append(w.url))
        p.on("response", lambda r: self.r401.append(r.url) if r.status == 401 else None)
        p.on("framenavigated", lambda f: setattr(self, "navs", self.navs + 1) if f == p.main_frame else None)
        self.base = base
        p.goto(base + "/")
        p.wait_for_selector("#login-form")

    def store(self, token, user, prefs=True):
        """Put a (stale) session into the browser, exactly once, then reload."""
        self.page.evaluate("""([t, u, prefs]) => { localStorage.setItem('instachat_token', t); localStorage.setItem('instachat_user', JSON.stringify(u));
            for (const [k, v] of Object.entries(prefs)) localStorage.setItem(k, v); }""", [token, user, PREFS if prefs else {}])
        self.reset_counters()
        self.page.reload()

    def reset_counters(self):
        self.toasts.clear(); self.errors.clear(); self.ws_opened.clear(); self.r401.clear()
        self.navs = 0

    def ls(self, key):
        return self.page.evaluate("(k) => localStorage.getItem(k)", key)

    def on_login(self):
        return self.page.evaluate("() => !document.getElementById('login-screen').hidden && document.getElementById('app').hidden")

    def in_app(self):
        return self.page.evaluate("() => !document.getElementById('app').hidden && typeof ws !== 'undefined' && !!ws && ws.readyState === 1 && channels.length > 0")

    def notice(self):
        return self.page.evaluate("() => { const b = document.getElementById('login-error'); return b.hidden ? null : { text: b.textContent, info: b.classList.contains('login-error--info') }; }")

    def real_errors(self):
        return [e for e in self.errors if not any(n in e for n in NOISE)]

    def log_in(self, name, code):
        self.page.fill("#login-name", name)
        self.page.fill("#login-code", code)
        self.page.click("#login-submit")


def expect_back_to_login(c, label, settle=5.0, startup=True):
    """The one outcome for a rejected session. startup=True: the stale
    token was found when the page opened (no websocket attempt at all)."""
    reached = wait(c.on_login, 15)
    ws_at_login, navs_at_login = len(c.ws_opened), c.navs
    time.sleep(settle)   # anything looping would show up in this window
    n = c.notice()
    ok(f"{label}: back on the login screen", reached, str(n))
    ok(f"{label}: exactly the friendly notice, once (no technical 'token' text, no toast)",
       n and n["text"] == EXPIRED and n["info"] and not c.toasts and "token" not in json.dumps(c.toasts).lower(), f"{n} toasts {c.toasts}")
    ok(f"{label}: stale token removed from the browser", c.ls("instachat_token") is None and c.ls("instachat_user") is None)
    ok(f"{label}: theme, games panel and MultiScreen settings kept",
       all(c.ls(k) == v for k, v in PREFS.items()), json.dumps({k: c.ls(k) for k in PREFS}))
    ok(f"{label}: no reconnect loop (nothing after the login appeared" + (", no websocket attempt at all)" if startup else ")"),
       len(c.ws_opened) == ws_at_login and c.navs == navs_at_login and (ws_at_login == 0 or not startup),
       f"ws {ws_at_login} -> {len(c.ws_opened)} navigations {navs_at_login} -> {c.navs}")
    ok(f"{label}: no 'Verbinde …' left on screen", not c.page.evaluate("() => /Verbinde/.test(document.getElementById('conn-banner').textContent) && !document.getElementById('conn-banner').hidden"))


def main():
    engine = sys.argv[sys.argv.index("--browser") + 1] if "--browser" in sys.argv else "chromium"
    cfg = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "config.json"), encoding="utf-8"))
    code = cfg["team_password"]
    proc, base, tmp = start_server()
    try:
        with sync_playwright() as pw:
            browser = getattr(pw, engine).launch()

            # ---------------- A: valid token ----------------
            ua = login(base, "Ana")
            a = Client(browser, base)
            a.store(ua["token"], ua["user"])
            ok("A valid token: app opens, websocket connects, channels load", wait(a.in_app, 10))
            ok("A valid token: no notice, no errors", not a.toasts and not a.real_errors(), f"{a.toasts} {a.real_errors()}")

            # ---------------- B: completely invalid token ----------------
            b = Client(browser, base)
            b.store("das-ist-kein-token", {"id": 999, "name": "Geist"})
            expect_back_to_login(b, "B invalid token")

            # ---------------- C: token that was valid, then revoked server-side ("expired") ----------------
            uc = login(base, "Cara")
            c = Client(browser, base)
            c.store(uc["token"], uc["user"])
            wait(c.in_app, 10)
            db_exec(tmp, "UPDATE users SET token = ? WHERE name = ?", (secrets.token_urlsafe(24), "Cara"))
            c.reset_counters()
            c.page.reload()
            expect_back_to_login(c, "C expired / revoked token")

            # ---------------- D: well-formed token the server has never seen ----------------
            d = Client(browser, base)
            stale_d = secrets.token_urlsafe(24)
            d.store(stale_d, {"id": 4242, "name": "Dora"})
            expect_back_to_login(d, "D unknown session")

            # ---------------- J: logging in again right afterwards ----------------
            d.log_in("Dora", code)
            ok("J new login right after: chat, channels and websocket work", wait(d.in_app, 10))
            new_token = d.ls("instachat_token")
            ok("J new login: a fresh token is stored, the notice is gone", new_token and new_token != stale_d and d.notice() is None)
            d.page.fill("#message-input", "wieder da")
            d.page.press("#message-input", "Enter")
            ok("J new login: sending works", wait(lambda: "wieder da" in d.page.inner_text("#messages"), 4))

            # ---------------- E: temporary network loss keeps the session ----------------
            tok_a = a.ls("instachat_token")
            a.reset_counters()
            a.ctx.set_offline(True)
            a.page.evaluate("() => window.dispatchEvent(new Event('offline'))")
            ok("E offline: offline banner, still in the app", wait(lambda: "offline" in a.page.inner_text("#conn-banner"), 3) and not a.on_login())
            time.sleep(2.5)
            a.ctx.set_offline(False)
            a.page.evaluate("() => window.dispatchEvent(new Event('online'))")
            ok("E back online: reconnects with the same token, no logout", wait(a.in_app, 10) and a.ls("instachat_token") == tok_a and not a.on_login())
            a.page.evaluate("() => ws.close()")
            ok("E websocket drop: reconnects, token kept", wait(lambda: a.page.evaluate("() => ws && ws.readyState === 1 && connState === 'online'"), 10)
               and a.ls("instachat_token") == tok_a)
            ok("E no session notice / logout for network trouble", not a.on_login() and not [t for t in a.toasts if "Sitzung" in t], str(a.toasts))

            # ---------------- F: server restart, database kept -> session survives ----------------
            a.reset_counters()
            proc = restart_server(proc, base, tmp, wipe_db=False)
            ok("F server restart (database kept): reconnects, still logged in",
               wait(lambda: a.page.evaluate("() => ws && ws.readyState === 1 && connState === 'online'"), 20) and a.ls("instachat_token") == tok_a and not a.on_login())

            # ---------------- H: session invalidated while the app is open (REST path) ----------------
            uh = login(base, "Hanna")
            h = Client(browser, base, 390, 844, phone=True)
            h.store(uh["token"], uh["user"])
            wait(h.in_app, 10)
            h.page.evaluate("() => ws.send(JSON.stringify({ type: 'game_create', game_type: 'tictactoe' }))")
            lobby = wait(lambda: h.page.evaluate("() => myGameSessionId"), 5)
            db_exec(tmp, "DELETE FROM users WHERE name = ?", ("Hanna",))
            h.reset_counters()
            h.page.evaluate("() => selectChannel(channels[channels.length - 1].id)")   # any REST call
            expect_back_to_login(h, "H session dropped while the app is open", startup=False)
            ok("H no stuck game or chat state (fresh page, no open game)", h.page.evaluate("() => document.getElementById('game-modal').hidden && !myGameSessionId") and lobby)
            gone = wait(lambda: not any(s.get("id") == lobby for s in json.loads(urllib.request.urlopen(
                urllib.request.Request(base + "/api/games", headers={"X-Auth-Token": ua["token"]})).read())["sessions"]), 5)
            ok("H its open lobby was cleaned up on the server", gone)

            # ---------------- I: ten invalid-session events at once ----------------
            ui = login(base, "Ida")
            i = Client(browser, base)
            i.store(ui["token"], ui["user"])
            wait(i.in_app, 10)
            db_exec(tmp, "DELETE FROM users WHERE name = ?", ("Ida",))
            i.reset_counters()
            i.page.evaluate("() => { for (let k = 0; k < 10; k++) api('/api/me').catch(() => {}); for (let k = 0; k < 10; k++) handleInvalidSession('test ' + k); }")
            expect_back_to_login(i, "I 10x invalid session at once", settle=3, startup=False)
            ok("I handled once: a single reload, at most ten 401s, no toasts", i.navs <= 1 and len(i.r401) <= 10 and not i.toasts, f"navs {i.navs} 401s {len(i.r401)}")
            l0, idle0 = i.page.evaluate(APP_LISTENERS), i.page.evaluate("() => window.__idle()")
            fresh = Client(browser, base)
            l1, idle1 = fresh.page.evaluate(APP_LISTENERS), fresh.page.evaluate("() => window.__idle()")
            ok("I no listener or timer growth (same as a fresh login page)", l0 == l1 and idle0 == idle1, f"{l0}/{idle0} vs fresh {l1}/{idle1}")
            fresh.ctx.close()

            # ---------------- G + production case: redeploy wipes the database ----------------
            ug = login(base, "Gustav")
            g = Client(browser, base)
            g.store(ug["token"], ug["user"])
            wait(g.in_app, 10)
            g.reset_counters()
            a.reset_counters()
            proc = restart_server(proc, base, tmp, wipe_db=True)
            expect_back_to_login(g, "G restart with a fresh database (app open)", settle=6, startup=False)
            expect_back_to_login(a, "G same for a second open browser", settle=0, startup=False)
            # the production report: a browser that was closed comes back with its old token
            p = Client(browser, base)
            p.page.evaluate("""([t, u]) => { localStorage.setItem('instachat_token', t); localStorage.setItem('instachat_user', JSON.stringify(u)); }""",
                            [ug["token"], ug["user"]])
            p.page.evaluate("(prefs) => { for (const [k, v] of Object.entries(prefs)) localStorage.setItem(k, v); }", PREFS)
            p.reset_counters()
            p.page.reload()
            expect_back_to_login(p, "PROD old session in the browser after a redeploy -> reload")
            p.log_in("Gustav", code)
            ok("PROD log in again: chat & games work normally", wait(p.in_app, 10))
            p.page.fill("#message-input", "alles gut")
            p.page.press("#message-input", "Enter")
            ok("PROD sending works after the new login", wait(lambda: "alles gut" in p.page.inner_text("#messages"), 4))
            p.page.evaluate("() => launchGameByType('timliner')")
            ok("PROD a game opens after the new login", wait(lambda: not p.page.evaluate("() => document.getElementById('game-modal').hidden"), 4))

            # ---------------- wrong login code stays a normal error ----------------
            w = Client(browser, base)
            w.log_in("Walter", "falsch")
            err = wait(w.notice, 4)
            ok("wrong code: red error, not the session notice", err and err["text"] == "Der Zugangscode stimmt nicht." and not err["info"], str(err))

            # ---------------- logout goes through the same cleanup ----------------
            p.page.click("#game-close-btn")
            p.reset_counters()
            p.page.click("#logout-btn")
            p.page.click(".dialog-overlay [data-act='ok']")
            ok("logout: login screen, token removed, preferences kept, no session notice",
               wait(p.on_login, 6) and p.ls("instachat_token") is None and p.ls("cg_theme") == "dark" and p.notice() is None)
            time.sleep(2)
            ok("logout: no reconnect afterwards", len(p.ws_opened) == 0, str(p.ws_opened))

            errs = [e for cl in (a, b, c, d, h, i, g, p, w) for e in cl.real_errors()]
            ok("no JavaScript errors anywhere", not errs, "; ".join(errs[:3]))
            browser.close()
    finally:
        proc.terminate()
    fails = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(fails)}/{len(RESULTS)} checks passed")
    for f in fails:
        print("  FAILED:", f[0], "|", f[2][:240])
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
