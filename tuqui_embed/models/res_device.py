from contextlib import nullcontext
from datetime import datetime

from odoo import api, models
from odoo.http import STORED_SESSION_BYTES
from odoo.tools import SQL

from .ir_http import EMBED_FLAG

PANEL_DEVICE = "Tuqui panel"


class ResDeviceLog(models.Model):
    _inherit = "res.device.log"

    @api.model
    def _update_device(self, request):
        super()._update_device(request)
        session = request.session
        if not (session.uid and session.get(EMBED_FLAG)):
            return
        # Odoo just logged the device only if a trace was touched this second.
        now = int(datetime.now().timestamp())
        if any(now - trace["last_activity"] <= 1 for trace in session.get("_trace", [])):
            self._tuqui_embed_name_device(session)

    @api.model
    def _tuqui_embed_name_device(self, session):
        """Show the panel session as "Tuqui panel" in the user's devices.

        It is a session of its own, revocable there like any other; with the
        browser's name it would read as one more tab of the same browser.
        """
        if self.env.cr.readonly:
            self.env.cr.rollback()
            cursor = self.env.registry.cursor(readonly=False)
        else:
            cursor = nullcontext(self.env.cr)
        with cursor as cr:
            cr.execute(
                SQL(
                    "UPDATE res_device_log SET browser = %s"
                    " WHERE session_identifier = %s AND user_id = %s AND browser IS DISTINCT FROM %s",
                    PANEL_DEVICE,
                    session.sid[:STORED_SESSION_BYTES],
                    session.uid,
                    PANEL_DEVICE,
                )
            )
