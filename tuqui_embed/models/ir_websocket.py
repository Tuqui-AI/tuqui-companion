from odoo import models
from odoo.addons.bus.websocket import wsrequest
from odoo.http.session import SessionExpiredException, logout

from .ir_http import panel_session_idle


class IrWebsocket(models.AbstractModel):
    _inherit = "ir.websocket"

    @classmethod
    def _authenticate(cls):
        # The bus never goes through ir.http. Presence updates every minute are not use.
        if panel_session_idle(wsrequest.session, note_use=False):
            logout(wsrequest.session, keep_db=True)
            raise SessionExpiredException()
        super()._authenticate()
