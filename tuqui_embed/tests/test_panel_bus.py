"""The bus serves an open panel without going through ir.http: idle still ends it."""

import time

import requests
from odoo.addons.bus.tests.common import WebsocketCase
from odoo.addons.bus.websocket import CloseCode
from odoo.http import root
from odoo.tests import new_test_user, tagged

from .test_panel_session import FRAME_NAVIGATION, PARAM, TUQUI


@tagged("post_install", "-at_install")
class TestPanelBus(WebsocketCase):
    def setUp(self):
        super().setUp()
        self.enterContext(self.allow_requests(all_requests=True))

    def _panel_sid(self):
        self.env["ir.config_parameter"].sudo().set_param(PARAM, TUQUI)
        member = new_test_user(self.env, login="panel_bus_member", groups="base.group_user")
        token = self.env["tuqui.embed.pass"].with_user(member).issue()
        resp = requests.get(
            f"{self.base_url()}/tuqui_embed/enter",
            params={"token": token, "next": "/odoo"},
            headers=FRAME_NAVIGATION,
            allow_redirects=False,
            timeout=30,
        )
        return resp.cookies.get("tuqui_panel_sid")

    def _socket(self, sid):
        websocket = self.websocket_connect(cookie=f"session_id={sid}")
        self.subscribe(websocket, ["a_channel"], self.env["bus.bus"]._bus_last_id())
        return websocket

    def test_an_idle_panel_session_closes_its_websocket(self):
        sid = self._panel_sid()
        websocket = self._socket(sid)
        session = root.session_store.get(sid)
        session["tuqui_embed_seen"] = time.time() - 3601
        root.session_store.save(session)
        # The web client updates its presence every minute.
        self.subscribe(websocket, wait_for_dispatch=False)
        self.assert_close_with_code(websocket, CloseCode.SESSION_EXPIRED)

    def test_presence_updates_do_not_keep_the_panel_session_alive(self):
        sid = self._panel_sid()
        seen = time.time() - 600
        session = root.session_store.get(sid)
        session["tuqui_embed_seen"] = seen
        root.session_store.save(session)
        self._socket(sid)
        self.assertEqual(root.session_store.get(sid)["tuqui_embed_seen"], seen)
