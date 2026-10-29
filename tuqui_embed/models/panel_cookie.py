"""The panel session travels in its own cookie, never in ``session_id``.

Browsers that do not partition third-party cookies would otherwise let the
panel's ``session_id`` overwrite the user's normal one (measured with Firefox
and partitioning off). Odoo only knows how to read ``session_id``, so the one
thing done here, before Odoo parses the request, is: a request that carries the
panel cookie and NOT the normal one is read as that session. When both arrive
(top-level tab in a non-partitioning browser) the normal one wins.

``/tuqui_embed/enter`` sees no session cookie at all, so Odoo starts a fresh
session for the pass. Otherwise, in a browser that sends the normal cookie into
the frame (Firefox with partitioning off: Odoo's cookie has no SameSite and
Firefox does not default to Lax), the pass would be redeemed ON the user's
normal session and rotate it away, logging them out of their normal tab.
"""

import re

from odoo import http

PANEL_COOKIE = "tuqui_panel_sid"
PANEL_REQUEST = "tuqui.panel_cookie"  # WSGI environ key: request used the panel cookie
ENTER_REQUEST = "tuqui.panel_enter"  # WSGI environ key: the entry, with its session cookies stripped
_PANEL_RE = re.compile(r"(?:^|;\s*)%s=([^;]*)" % PANEL_COOKIE)
_NORMAL_RE = re.compile(r"(?:^|;\s*)session_id=")
_SESSION_COOKIES_RE = re.compile(r"(?:^|;\s*)(?:session_id|%s)=[^;]*" % PANEL_COOKIE)
ENTER_PATH = "/tuqui_embed/enter"

_Application = type(http.root)
_original_call = _Application.__call__


def _panel_set_cookie(value):
    """``session_id=…`` as Odoo wrote it, turned into the partitioned panel cookie."""
    parts = [p for p in value.split("; ") if not p.lower().startswith(("samesite", "secure"))]
    parts[0] = PANEL_COOKIE + parts[0][len("session_id") :]
    return "; ".join([*parts, "Secure", "SameSite=None", "Partitioned"])


def _call(self, environ, start_response):
    cookies = environ.get("HTTP_COOKIE", "")
    if environ.get("PATH_INFO") == ENTER_PATH:
        environ["HTTP_COOKIE"] = _SESSION_COOKIES_RE.sub("", cookies).lstrip("; ")
        environ[PANEL_REQUEST] = environ[ENTER_REQUEST] = True
    else:
        panel = _PANEL_RE.search(cookies)
        if not panel or _NORMAL_RE.search(cookies):
            return _original_call(self, environ, start_response)
        environ["HTTP_COOKIE"] = "%s; session_id=%s" % (cookies, panel.group(1))
        environ[PANEL_REQUEST] = True

    # Every answer to a panel request, errors included (Odoo writes the cookie
    # there without passing through _post_dispatch), gives back the panel
    # cookie: a normal session_id must never land inside Tuqui.
    def panel_start_response(status, headers, exc_info=None):
        headers = [
            (name, _panel_set_cookie(value))
            if name.lower() == "set-cookie" and value.startswith("session_id=")
            else (name, value)
            for name, value in headers
        ]
        return start_response(status, headers, exc_info)

    return _original_call(self, environ, panel_start_response)


if not getattr(_original_call, "_tuqui_panel", False):
    _call._tuqui_panel = True
    _Application.__call__ = _call
