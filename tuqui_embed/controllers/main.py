import json
import logging
import time
from urllib.parse import quote

from markupsafe import Markup
from odoo import http
from odoo.exceptions import AccessDenied
from odoo.http import request

from ..models.ir_http import EMBED_FLAG, EMBED_SEEN
from ..models.panel_cookie import ENTER_REQUEST

_logger = logging.getLogger(__name__)


def _authenticate(credential):
    return request.session.authenticate(request.env, credential)


def _safe_next(target):
    return target if target and target.startswith("/") and not target.startswith("//") else "/odoo"


class TuquiEmbedSession(http.Controller):
    # It writes (the pass is consumed, a session is created): Odoo serves GET
    # read-only by default and retries, which works but hides that it writes.
    @http.route("/tuqui_embed/enter", type="http", auth="none", methods=["GET"], readonly=False)
    def enter(self, token=None, next=None, **kw):
        # Only redeem where panel_cookie stripped the session cookies: any other path
        # routed here (a trailing slash, a language prefix) would reuse a session.
        environ = request.httprequest.environ
        isolated = environ.get(ENTER_REQUEST)
        if token and not isolated:
            path = (environ.get("REQUEST_URI") or request.httprequest.path).split("?")[0]
            _logger.info("Panel pass not redeemed: %s is not the panel entry", path)
        login = isolated and request.env["tuqui.embed.pass"]._peek_login(token)
        if login:
            try:
                _authenticate({"type": "tuqui_embed_pass", "login": login, "token": token})
                request.session[EMBED_FLAG] = True
                request.session[EMBED_SEEN] = time.time()
                request.env["res.device.log"].sudo()._tuqui_embed_name_device(request.session)
            except AccessDenied:
                # Lost the race to another redemption, or expired in between:
                # /check tells the panel to fall back to the link.
                pass
        return request.redirect("/tuqui_embed/check?next=" + quote(_safe_next(next)), local=True)

    @http.route("/tuqui_embed/check", type="http", auth="none", methods=["GET"])
    def check(self, next=None, **kw):
        # The cookie only comes back if the browser kept it: this is the one
        # place that can tell the panel "it did not stick, use the other door".
        if request.session.uid and request.session.get(EMBED_FLAG):
            return request.redirect(_safe_next(next), local=True)
        origins = request.env["ir.http"]._tuqui_embed_origins()
        script = "".join("parent.postMessage({type:'tuqui_embed',ok:false}, %s);" % json.dumps(o) for o in origins)
        return request.make_response(
            Markup("<!doctype html><meta charset=utf-8><p>No se pudo abrir Odoo acá.</p><script>%s</script>")
            % Markup(script)
        )
