"""Keeps the session token out of the server logs.

The browser opens its WebSocket as /ws?token=<session token> (browsers cannot
set headers on a WebSocket), and uvicorn logs every request line - the access
log and the WebSocket "[accepted]" line - with its query string. On Render
those logs are kept and visible to everyone with dashboard access, so the
token was readable there in plain text.

This filter rewrites the value of every `token` query parameter to `***`
before a record is formatted. Nothing else changes: the WebSocket and its
authentication stay as they are, every other log line is untouched.
"""

import logging
import re

# the `token` parameter of a query string (not `x_token=`, `csrftoken=` ...): its value up
# to the next parameter, space or quote
_TOKEN_PARAM = re.compile(r"([?&;]token=)[^&;\s\"'#]*", re.IGNORECASE)

# uvicorn logs request lines through these (the WebSocket handshake through uvicorn.error)
LOGGERS = ("uvicorn.access", "uvicorn.error", "uvicorn", "gunicorn.access", "gunicorn.error")


def redact(text: str) -> str:
    """`/ws?token=abc&x=1` -> `/ws?token=***&x=1`"""
    return _TOKEN_PARAM.sub(r"\1***", text) if "token=" in text.lower() else text


def _clean(value):
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, bytes):
        return redact(value.decode("latin-1")).encode("latin-1")
    return value


class RedactTokenFilter(logging.Filter):
    """A logging filter: the record's message and arguments without the token (always passes)."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact(record.msg)
        args = record.args
        if isinstance(args, tuple):
            record.args = tuple(_clean(a) for a in args)
        elif isinstance(args, dict):
            record.args = {k: _clean(v) for k, v in args.items()}
        return True


_FILTER = RedactTokenFilter()


def install(names=LOGGERS) -> None:
    """Attach the filter to uvicorn's loggers and to every handler they write through
    (idempotent - safe when the app module is imported more than once)."""
    for name in names:
        logger = logging.getLogger(name)
        if _FILTER not in logger.filters:
            logger.addFilter(_FILTER)
        for h in logger.handlers:
            if _FILTER not in h.filters:
                h.addFilter(_FILTER)
