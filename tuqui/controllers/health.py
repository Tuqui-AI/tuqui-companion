import json

from odoo import http, release
from odoo.http import Response

_PROTOCOL_VERSION = "2.0"


def _module_version(env):
    rec = env["ir.module.module"].sudo().search([("name", "=", "tuqui")], limit=1)
    return rec.installed_version or rec.latest_version or "unknown"


class TuquiHealth(http.Controller):
    """Health probe + capability advertisement.

    Public endpoint (auth='none'). Returns enough metadata for a Tuqui
    backend to decide whether the module is reachable and what protocol
    version / capability set it speaks. What it advertises comes from the
    ``tuqui.health`` model, which the modules that add a capability extend.
    """

    @http.route("/tuqui/health", type="http", auth="none", methods=["GET"], csrf=False)
    def health(self, **_kwargs):
        env = http.request.env
        report = env["tuqui.health"]
        body = {
            "ok": True,
            "module": "tuqui",
            "module_version": _module_version(env),
            "protocol_version": _PROTOCOL_VERSION,
            "odoo_version": release.version,
            "capabilities": report._capabilities(),
        }
        return Response(
            json.dumps(body),
            content_type="application/json",
            status=200,
        )
