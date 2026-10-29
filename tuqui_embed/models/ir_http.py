import re
import time

from odoo import api, models
from odoo.http import request
from odoo.http.session import logout
from werkzeug.exceptions import Forbidden, abort

from .panel_cookie import PANEL_REQUEST

EMBED_FLAG = "tuqui_embed"
# When the panel session was last used. Past PANEL_IDLE_SECONDS it is closed:
# reopening the panel asks for a new pass anyway.
EMBED_SEEN = "tuqui_embed_seen"
PANEL_IDLE_SECONDS = 3600
SEEN_REFRESH_SECONDS = 300
EMBED_ORIGINS_PARAM = "tuqui.embed_origins"
ORIGINS_KEY = "tuqui.embed_origins"  # WSGI environ key, read before dispatch
# Cross-site navigations the panel session may serve: the web client and the
# panel's own entry, which have no server-side side effects. Exact, not "/web":
# that prefix also takes /website, /web_editor and /web/session/logout.
FRAMED_NAVIGATION_PATHS = ("/odoo",)
FRAMED_NAVIGATION_PREFIXES = ("/odoo/", "/tuqui_embed/")
NEVER_WITH_PANEL_SESSION = ("/web/become", "/web/database")
# An origin goes verbatim into a CSP header, so only `scheme://host[:port]`
# passes: a comma, a space, a path or a wildcard would break or widen the
# policy (a comma-separated value split it into two policies, measured).
# HTTPS only: the panel cookie is Secure, so a plain-HTTP Tuqui could never keep
# it. A *.localhost origin is a secure context and is kept for development.
_ORIGIN_RE = re.compile(r"^(https://[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+|http://([A-Za-z0-9-]+\.)*localhost)(:[0-9]{1,5})?$")


def embed_origins(env):
    """The origins allowed to frame this Odoo; empty means Odoo's default."""
    value = env["ir.config_parameter"].sudo().get_str(EMBED_ORIGINS_PARAM) or ""
    return [origin for origin in value.split() if _ORIGIN_RE.match(origin)]


def panel_session_idle(session, note_use=True):
    """A panel session unused for PANEL_IDLE_SECONDS. ``note_use`` counts this request as use."""
    if not (session.uid and session.get(EMBED_FLAG)):
        return False
    now = time.time()
    seen = session.get(EMBED_SEEN) or now
    if now - seen > PANEL_IDLE_SECONDS:
        return True
    if note_use and (now - seen > SEEN_REFRESH_SECONDS or EMBED_SEEN not in session):
        session[EMBED_SEEN] = now
    return False


def _close_if_idle(req):
    if panel_session_idle(req.session):
        logout(req.session, keep_db=True)
        # As Odoo does after its own logout: this request no longer runs as the user.
        req.env = api.Environment(req.env.cr, None, req.session.context)


def _is_panel_request():
    """It came with the panel cookie, or is the panel's entry: the panel's limits apply.

    Decided by the cookie, not by a mark in the session: a logout clears the
    session, and a login inside the panel after it would otherwise get a
    partitioned session with no limits at all.
    """
    return bool(request and request.httprequest.environ.get(PANEL_REQUEST))


class IrHttp(models.AbstractModel):
    _inherit = "ir.http"

    @classmethod
    def _tuqui_embed_origins(cls):
        return embed_origins(request.env)

    @classmethod
    def _pre_dispatch(cls, rule, args):
        super()._pre_dispatch(rule, args)
        # Only the panel may be framed: the everyday Odoo keeps X-Frame-Options.
        # /tuqui_embed/check answers a pass that did not stick, so without the cookie.
        if _is_panel_request() or request.httprequest.path.startswith("/tuqui_embed/"):
            # Read here and carried on the request, not in _post_dispatch: from 20 on
            # the transaction is already closed there (measured), and this keeps the
            # code the same across versions.
            request.httprequest.environ[ORIGINS_KEY] = cls._tuqui_embed_origins()

    @classmethod
    def _authenticate(cls, endpoint):
        if _is_panel_request():
            _close_if_idle(request)
        super()._authenticate(endpoint)
        if not _is_panel_request():
            return
        session = request.session
        path = request.httprequest.path
        # After Odoo's own check, which may have closed the session too: without one,
        # the web client would send the frame to /web/login. /tuqui_embed/check
        # tells the panel to offer the link instead.
        if not session.uid and (path in FRAMED_NAVIGATION_PATHS or path.startswith("/odoo/")):
            abort(request.redirect("/tuqui_embed/check", local=True))
        if session.uid and not session.get(EMBED_FLAG):
            # Logged in inside the panel, not through a pass: that session never serves.
            logout(session, keep_db=True)
            raise Forbidden()
        headers = request.httprequest.headers
        if path.startswith(NEVER_WITH_PANEL_SESSION):
            raise Forbidden()
        if headers.get("Sec-Fetch-Site") == "same-origin":
            return
        framed_navigation = (
            headers.get("Sec-Fetch-Dest") == "iframe"
            and headers.get("Sec-Fetch-Mode") == "navigate"
            and (path in FRAMED_NAVIGATION_PATHS or path.startswith(FRAMED_NAVIGATION_PREFIXES))
        )
        if not framed_navigation:
            raise Forbidden()

    @classmethod
    def _post_dispatch(cls, response):
        super()._post_dispatch(response)
        headers = getattr(response.headers, "_wrapped__", response.headers)
        cls._tuqui_allow_frame(headers)

    def session_info(self):
        """Tours off when this screen is a frame's navigation.

        With a pending onboarding tour, the web client inside a cross-origin
        iframe kills the browser tab: Odoo's own guard, ``if
        (!window.frameElement)``, holds precisely cross-origin because
        ``frameElement`` is ``null`` there. Both doors are shut
        (``tour_enabled`` and ``current_tour``); the user's stored preference is
        not touched. The client half is ``static/src/no_tours_when_framed.js``,
        needed because a tour started in the everyday Odoo is RESUMED from
        ``localStorage`` inside the frame.
        """
        info = super().session_info()
        # The Odoo shown in Tuqui's panel: tuqui_assistant hides its own
        # assistant there instead of opening Tuqui inside Odoo inside Tuqui.
        info["tuqui_embed_panel"] = _is_panel_request()
        if (request.httprequest.headers.get("Sec-Fetch-Dest") or "").lower() != "iframe":
            return info
        if "tour_enabled" in info:
            info["tour_enabled"] = False
        if "current_tour" in info:
            info["current_tour"] = False
        return info

    @classmethod
    def _tuqui_allow_frame(cls, headers):
        origins = request.httprequest.environ.get(ORIGINS_KEY)
        if not origins:
            return
        headers.remove("X-Frame-Options")
        ancestors = "frame-ancestors 'self' " + " ".join(origins)
        csp = headers.get("Content-Security-Policy")
        if not csp:
            headers["Content-Security-Policy"] = ancestors
        elif "frame-ancestors" in csp:
            headers["Content-Security-Policy"] = re.sub(r"frame-ancestors[^;]*", ancestors, csp)
        else:
            headers["Content-Security-Policy"] = csp.rstrip("; ") + "; " + ancestors
