"""QA safety: automated browser runs must never capture or confine the host's mouse cursor (Windows!).

Imported by the GoldRush e2e helpers. It makes every Playwright `BrowserType.launch(...)` in this process headless unless
GOLDRUSH_QA_HEADED=1 is set for a deliberate, manual visual-QA session. Even then the game never takes the pointer lock in an
automated browser (goldrush-input.js: navigator.webdriver -> free-mouse mode). A leftover lock is released at the end of a
run (`release_cursor`). Nothing here touches processes it did not start.
"""

import os

from playwright.sync_api import BrowserType

HEADED = os.environ.get("GOLDRUSH_QA_HEADED") == "1"

if not getattr(BrowserType, "_gr_safe", False):
    _launch = BrowserType.launch

    def _safe_launch(self, *a, **kw):
        if not HEADED:
            kw["headless"] = True
        else:
            kw.setdefault("args", [])
            print("[qa_safety] headed visual QA: pointer lock stays disabled in the game (navigator.webdriver)", flush=True)
        return _launch(self, *a, **kw)

    BrowserType.launch = _safe_launch
    BrowserType._gr_safe = True


def release_cursor(page):
    """exit a pointer lock if one is held (never raises)"""
    try:
        page.evaluate("() => { if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock(); }")
    except Exception:
        pass
