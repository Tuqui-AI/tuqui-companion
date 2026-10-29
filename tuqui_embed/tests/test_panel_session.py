"""The panel session: minted from a one-time pass, carried in its own cookie.

Each test pins one behaviour measured in Chrome, Firefox and WebKit on Odoo 18,
19 and 20. The headers a browser would send are written by hand, because the
server's decisions hang on them.
"""

import json
import time
from datetime import timedelta

import requests
from odoo import fields
from odoo.exceptions import AccessDenied, UserError
from odoo.http import root
from odoo.service.model import call_kw
from odoo.tests import HttpCase, new_test_user, tagged

PARAM = "tuqui.embed_origins"
TUQUI = "https://tuqui.example"
FRAME_NAVIGATION = {"Sec-Fetch-Dest": "iframe", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "cross-site"}
FROM_THE_FRAME = {"Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin"}


@tagged("post_install", "-at_install")
class TestPanelSession(HttpCase):
    def setUp(self):
        super().setUp()
        # Plain `requests` calls, so that no session of the test opener leaks
        # into them: each test decides exactly which cookies the "browser" sends.
        self.enterContext(self.allow_requests(all_requests=True))
        self.env["ir.config_parameter"].sudo().set_param(PARAM, TUQUI)
        self.member = new_test_user(self.env, login="panel_member", groups="base.group_user")

    # --- helpers --------------------------------------------------------------

    def _pass(self, user=None):
        return self.env["tuqui.embed.pass"].with_user(user or self.member).issue()

    def _enter(self, token, cookies=None, path="/tuqui_embed/enter"):
        return requests.get(
            f"{self.base_url()}{path}",
            params={"token": token, "next": "/odoo"},
            headers={**FRAME_NAVIGATION, **({"Cookie": cookies} if cookies else {})},
            allow_redirects=False,
            timeout=30,
        )

    def _panel_cookie(self, token=None):
        resp = self._enter(token or self._pass())
        return resp.cookies.get("tuqui_panel_sid")

    def _opened(self, token):
        """The uid the pass logged into the panel, or a falsy value if it did not.

        Not "is there a panel cookie": a pass that fails still gets an empty panel
        session, the one /check reads to tell the panel to use the link.
        """
        cookie = self._panel_cookie(token)
        uid = cookie and self._uid(f"tuqui_panel_sid={cookie}")
        return uid if isinstance(uid, int) else None

    def _uid(self, cookie_header, headers=None):
        resp = requests.post(
            f"{self.base_url()}/web/session/get_session_info",
            data=json.dumps({"jsonrpc": "2.0", "method": "call", "params": {}}),
            headers={
                "Content-Type": "application/json",
                "Cookie": cookie_header,
                **(FROM_THE_FRAME if headers is None else headers),
            },
            timeout=30,
        )
        if resp.status_code != 200:
            return resp.status_code
        body = resp.json()
        # A JSON-RPC route answers an exception with HTTP 200 and an `error`.
        if "error" in body:
            return body["error"]["data"]["name"]
        return body["result"].get("uid")

    # --- the pass -------------------------------------------------------------

    def test_a_pass_is_for_the_caller(self):
        self._pass()
        rec = self.env["tuqui.embed.pass"].sudo().search([], order="id desc", limit=1)
        self.assertEqual(rec.user_id, self.member)
        self.assertNotIn("token", rec._fields, "only the hash is stored")

    def test_a_pass_can_be_asked_for_the_way_tuqui_calls_it(self):
        """Tuqui's companion and JSON-RPC transports both send `[[]]` as args
        (an empty recordset first). Measured in the real flow: an `@api.model`
        `issue` failed there with "takes 1 positional argument but 2 were given"."""
        passes = self.env["tuqui.embed.pass"].with_user(self.member)
        token = call_kw(passes, "issue", [[]], {})
        self.assertTrue(isinstance(token, str) and token)

    def test_no_declared_origin_no_pass(self):
        """Then this Odoo does not allow framing and Tuqui hands over the link."""
        self.env["ir.config_parameter"].sudo().set_param(PARAM, False)
        with self.assertRaises(UserError):
            self._pass()

    def test_a_pass_works_once(self):
        token = self._pass()
        self.assertEqual(self._opened(token), self.member.id)
        self.assertFalse(self._opened(token), "a replayed pass opened a second session")

    def test_consuming_is_single_use_on_its_own(self):
        """The redemption checks the pass twice: a look, then the consumption.
        Only the consumption stops two concurrent redemptions from both winning,
        so it is pinned by itself: a test through `/enter` stops at the look."""
        token = self._pass()
        passes = self.env["tuqui.embed.pass"]
        self.assertEqual(passes._consume(token), self.member.id)
        self.assertIsNone(passes._consume(token))

    def test_an_expired_pass_does_not_work(self):
        token = self._pass()
        self.env["tuqui.embed.pass"].sudo().search([]).write(
            {"expires_at": fields.Datetime.now() - timedelta(seconds=1)}
        )
        # The ORM writes lazily; the request reads the database.
        self.env.flush_all()
        self.assertFalse(self._opened(token))

    # --- the cookie -----------------------------------------------------------

    def test_the_panel_session_travels_in_its_own_partitioned_cookie(self):
        resp = self._enter(self._pass())
        set_cookies = resp.raw.headers.getlist("Set-Cookie")
        panel = [c for c in set_cookies if c.startswith("tuqui_panel_sid=")]
        self.assertEqual(len(panel), 1, set_cookies)
        for attribute in ("Secure", "SameSite=None", "Partitioned", "HttpOnly"):
            self.assertIn(attribute, panel[0])
        self.assertFalse(
            [c for c in set_cookies if c.startswith("session_id=")],
            "the panel wrote session_id: in a browser that does not partition it overwrites the normal one",
        )

    def test_the_panel_cookie_is_read_as_that_members_session(self):
        cookie = self._panel_cookie()
        self.assertEqual(self._uid(f"tuqui_panel_sid={cookie}"), self.member.id)

    def test_with_both_cookies_the_normal_session_wins(self):
        """A top-level tab in a browser without partitioning sends both."""
        panel = self._panel_cookie()
        self.authenticate("admin", "admin")
        normal = self.opener.cookies["session_id"]
        both = f"session_id={normal}; tuqui_panel_sid={panel}"
        self.assertEqual(self._uid(both), self.env.ref("base.user_admin").id)

    def test_entering_never_touches_the_normal_session(self):
        """Firefox without partitioning sends the normal cookie INTO the frame.

        Redeeming the pass on it used to turn it into a panel session and rotate
        it away, logging the person out of their normal tab.
        """
        self.authenticate("admin", "admin")
        normal = self.opener.cookies["session_id"]
        resp = self._enter(self._pass(), cookies=f"session_id={normal}")
        self.assertTrue(resp.cookies.get("tuqui_panel_sid"))
        self.assertEqual(self._uid(f"session_id={normal}", headers={}), self.env.ref("base.user_admin").id)

    # --- the limits of a panel session ------------------------------------------

    def test_become_is_never_served_to_a_panel_session(self):
        """Without this, an artifact inside Tuqui escalated the panel session to
        superuser (measured): the partition is keyed on the top-level site."""
        cookie = self._panel_cookie()
        resp = requests.get(
            f"{self.base_url()}/web/become",
            headers={"Cookie": f"tuqui_panel_sid={cookie}", **FROM_THE_FRAME},
            allow_redirects=False,
            timeout=30,
        )
        self.assertEqual(resp.status_code, 403)

    def test_a_cross_site_subresource_is_refused(self):
        cookie = self._panel_cookie()
        image = {"Sec-Fetch-Dest": "image", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Site": "cross-site"}
        self.assertEqual(self._uid(f"tuqui_panel_sid={cookie}", headers=image), "werkzeug.exceptions.Forbidden")

    def test_a_request_without_fetch_metadata_is_refused(self):
        cookie = self._panel_cookie()
        self.assertEqual(self._uid(f"tuqui_panel_sid={cookie}", headers={}), "werkzeug.exceptions.Forbidden")

    # --- framing ----------------------------------------------------------------

    def _framed(self, path, cookie=None):
        return requests.get(
            f"{self.base_url()}{path}",
            headers={**FRAME_NAVIGATION, **({"Cookie": f"tuqui_panel_sid={cookie}"} if cookie else {})},
            allow_redirects=False,
            timeout=30,
        )

    def test_the_declared_origin_may_frame_the_panel(self):
        # The web client with the panel session, and /check, which answers a pass that did not stick.
        for resp in (self._framed("/odoo", self._panel_cookie()), self._framed("/tuqui_embed/check")):
            self.assertEqual(resp.status_code, 200, resp.url)
            self.assertNotIn("X-Frame-Options", resp.headers)
            self.assertIn(f"frame-ancestors 'self' {TUQUI}", resp.headers.get("Content-Security-Policy", ""))

    def test_the_everyday_odoo_is_never_framed_by_tuqui(self):
        """With the normal session, Tuqui would show the Odoo without the panel's limits."""
        self.authenticate("admin", "admin")
        resp = requests.get(
            f"{self.base_url()}/odoo",
            headers={"Cookie": f"session_id={self.opener.cookies['session_id']}"},
            allow_redirects=False,
            timeout=30,
        )
        self.assertEqual(resp.status_code, 200)
        self.assertNotIn(TUQUI, resp.headers.get("Content-Security-Policy", ""))
        self.assertIn("X-Frame-Options", resp.headers)

    def test_without_an_origin_odoo_keeps_its_default(self):
        self.env["ir.config_parameter"].sudo().set_param(PARAM, False)
        resp = self._framed("/tuqui_embed/check")
        self.assertNotIn(TUQUI, resp.headers.get("Content-Security-Policy", ""))

    def test_a_malformed_origin_never_reaches_the_header(self):
        self.env["ir.config_parameter"].sudo().set_param(PARAM, f"{TUQUI}, * https://x.example/path")
        resp = self._framed("/tuqui_embed/check")
        csp = resp.headers.get("Content-Security-Policy", "")
        self.assertNotIn("*", csp)
        self.assertNotIn("/path", csp)
        self.assertNotIn(",", csp)

    # --- a session that did not come from a pass ----------------------------------

    def test_a_session_not_born_from_a_pass_never_serves_from_the_panel_cookie(self):
        """A logout clears the session, mark included, and a login inside the
        panel then landed in the panel cookie with no limits: an artifact could
        escalate it through /web/become. The cookie decides."""
        self.authenticate("admin", "admin")
        login_inside_the_panel = self.opener.cookies["session_id"]
        cookie = f"tuqui_panel_sid={login_inside_the_panel}"
        self.assertEqual(self._uid(cookie), "werkzeug.exceptions.Forbidden")
        resp = requests.get(
            f"{self.base_url()}/web/become",
            headers={"Cookie": cookie, **FROM_THE_FRAME},
            allow_redirects=False,
            timeout=30,
        )
        self.assertEqual(resp.status_code, 403)

    def test_an_expired_panel_session_never_comes_back_as_session_id(self):
        """When a logged-in session expires, Odoo rotates it and writes session_id
        itself, on its error path, without _post_dispatch: a plain Lax cookie
        landing inside Tuqui. The answer to a panel request carries only the
        panel cookie."""
        cookie = self._panel_cookie()
        # A new password invalidates the member's sessions (session token).
        self.member.password = "a-new-password-for-the-test"
        self.env.flush_all()
        resp = requests.get(
            f"{self.base_url()}/odoo",
            headers={"Cookie": f"tuqui_panel_sid={cookie}", **FRAME_NAVIGATION},
            allow_redirects=False,
            timeout=30,
        )
        set_cookies = resp.raw.headers.getlist("Set-Cookie")
        self.assertTrue(set_cookies, "the session did not expire: this test proves nothing")
        self.assertFalse([c for c in set_cookies if c.startswith("session_id=")], set_cookies)

    # --- what a panel session may be navigated to ---------------------------------

    def test_a_framed_navigation_only_reaches_the_web_client(self):
        """ "/web" as a prefix also took /website and /web/session/logout."""
        cookie = self._panel_cookie()
        for path in ("/web/session/logout", "/web/login"):
            resp = requests.get(
                f"{self.base_url()}{path}",
                headers={"Cookie": f"tuqui_panel_sid={cookie}", **FRAME_NAVIGATION},
                allow_redirects=False,
                timeout=30,
            )
            self.assertEqual(resp.status_code, 403, path)

    def test_the_bus_refuses_a_panel_session_from_another_site(self):
        """A WebSocket opened from a page inside Tuqui carries the partitioned cookie."""
        cookie = self._panel_cookie()
        resp = requests.get(
            f"{self.base_url()}/websocket",
            headers={
                "Cookie": f"tuqui_panel_sid={cookie}",
                "Sec-Fetch-Dest": "empty",
                "Sec-Fetch-Mode": "websocket",
                "Sec-Fetch-Site": "cross-site",
                "Connection": "Upgrade",
                "Upgrade": "websocket",
                "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
                "Sec-WebSocket-Version": "13",
                "Origin": TUQUI,
            },
            allow_redirects=False,
            stream=True,
            timeout=30,
        )
        status = resp.status_code
        resp.close()
        self.assertEqual(status, 403)

    def test_entering_as_a_page_is_refused(self):
        """A leaked pass opened in a tab must not become a full session."""
        resp = requests.get(
            f"{self.base_url()}/tuqui_embed/enter",
            params={"token": self._pass(), "next": "/odoo"},
            headers={"Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none"},
            allow_redirects=False,
            timeout=30,
        )
        self.assertEqual(resp.status_code, 403)
        self.assertFalse(resp.cookies.get("tuqui_panel_sid"))

    def test_another_path_to_the_entry_never_redeems_a_pass(self):
        """Odoo routes /tuqui_embed/enter/ (strict_slashes=False) to the same endpoint
        without the cookie isolation; a language prefix gets there through http_routing."""
        self.authenticate("admin", "admin")
        normal = self.opener.cookies["session_id"]
        panel = self._panel_cookie()
        token = self._pass()
        for cookies in (f"session_id={normal}", f"tuqui_panel_sid={panel}"):
            resp = self._enter(token, cookies=cookies, path="/tuqui_embed/enter/")
            self.assertIn("/tuqui_embed/check", resp.headers.get("Location", ""), cookies)
        self.assertEqual(self.env["tuqui.embed.pass"]._consume(token), self.member.id, "the pass was redeemed")
        self.assertEqual(self._uid(f"session_id={normal}", headers={}), self.env.ref("base.user_admin").id)

    def test_a_pass_that_does_not_open_tells_the_panel_to_use_the_link(self):
        resp = self._enter("not-a-pass")
        check = requests.get(
            f"{self.base_url()}{resp.headers['Location']}",
            headers={"Cookie": f"tuqui_panel_sid={resp.cookies.get('tuqui_panel_sid', '')}", **FRAME_NAVIGATION},
            allow_redirects=False,
            timeout=30,
        )
        self.assertEqual(check.status_code, 200)
        self.assertIn("ok:false", check.text)

    def _open_web_client(self, cookie):
        return requests.get(
            f"{self.base_url()}/odoo",
            headers={"Cookie": f"tuqui_panel_sid={cookie}", **FRAME_NAVIGATION},
            allow_redirects=False,
            timeout=30,
        )

    def test_the_panel_never_shows_odoos_login(self):
        """A panel cookie with no session behind it goes to the link, not to /web/login."""
        resp = self._open_web_client(self._enter("not-a-pass").cookies.get("tuqui_panel_sid", ""))
        self.assertEqual(resp.status_code, 303)
        self.assertTrue(resp.headers["Location"].endswith("/tuqui_embed/check"), resp.headers["Location"])

    def test_an_idle_panel_session_ends(self):
        """An hour without use closes it; reopening the panel asks for a new pass anyway."""
        cookie = self._panel_cookie()
        self.assertEqual(self._open_web_client(cookie).status_code, 200)
        session = root.session_store.get(cookie)
        session["tuqui_embed_seen"] = time.time() - 3601
        root.session_store.save(session)

        resp = self._open_web_client(cookie)
        self.assertEqual(resp.status_code, 303)
        self.assertTrue(resp.headers["Location"].endswith("/tuqui_embed/check"), resp.headers["Location"])
        self.assertNotIsInstance(self._uid(f"tuqui_panel_sid={cookie}"), int)

    def test_the_request_that_finds_the_session_idle_no_longer_runs_as_the_member(self):
        cookie = self._panel_cookie()
        self.assertEqual(self._open_web_client(cookie).status_code, 200)
        session = root.session_store.get(cookie)
        session["tuqui_embed_seen"] = time.time() - 3601
        root.session_store.save(session)

        resp = requests.post(
            f"{self.base_url()}/web/dataset/call_kw",
            data=json.dumps(
                {
                    "jsonrpc": "2.0",
                    "method": "call",
                    "params": {"model": "res.partner", "method": "search_count", "args": [[]], "kwargs": {}},
                }
            ),
            headers={"Content-Type": "application/json", "Cookie": f"tuqui_panel_sid={cookie}", **FROM_THE_FRAME},
            timeout=30,
        )
        self.assertEqual(resp.json().get("error", {}).get("data", {}).get("name"), "odoo.http.SessionExpiredException")

    def test_a_panel_session_closed_by_odoo_goes_to_the_link(self):
        """Odoo closes it in its own check (a new password): no login inside the panel either."""
        cookie = self._panel_cookie()
        self.member.password = "a-new-password-for-the-test"
        self.env.flush_all()
        resp = self._open_web_client(cookie)
        self.assertEqual(resp.status_code, 303)
        self.assertTrue(resp.headers["Location"].endswith("/tuqui_embed/check"), resp.headers["Location"])

    def test_a_panel_session_in_use_stays_open(self):
        cookie = self._panel_cookie()
        session = root.session_store.get(cookie)
        session["tuqui_embed_seen"] = time.time() - 600
        root.session_store.save(session)
        self.assertEqual(self._open_web_client(cookie).status_code, 200)

    def test_the_panel_session_is_its_own_device(self):
        """It shows in the user's devices as the panel, revocable there."""
        cookie = self._panel_cookie()
        # Odoo logs the device on the first request after the login, not on it.
        self.assertIsInstance(self._uid(f"tuqui_panel_sid={cookie}"), int)
        devices = self.env["res.device.log"].sudo().search([("user_id", "=", self.member.id)])
        self.assertTrue(devices)
        self.assertEqual(set(devices.mapped("browser")), {"Tuqui panel"})

    # --- who may ask for a pass, and from where -----------------------------------

    def test_a_pass_of_one_member_never_opens_another(self):
        other = new_test_user(self.env, login="panel_other", groups="base.group_user")
        token = self._pass()
        with self.assertRaises(AccessDenied):
            self.env["res.users"].with_user(other)._check_credentials(
                {"type": "tuqui_embed_pass", "login": other.login, "token": token}, {"interactive": True}
            )

    def test_an_undeclared_tuqui_gets_no_pass(self):
        """A preview or a staging that is not declared would frame a blank panel."""
        with self.assertRaises(UserError):
            self.env["tuqui.embed.pass"].with_user(self.member).issue(origin="https://preview.example")
        self.assertTrue(self.env["tuqui.embed.pass"].with_user(self.member).issue(origin=TUQUI))

    def test_the_health_check_tells_tuqui_the_panel_can_open(self):
        capabilities = requests.get(f"{self.base_url()}/tuqui/health", timeout=30).json()["capabilities"]
        self.assertIn("embed.session", capabilities)
        self.env["ir.config_parameter"].sudo().set_param(PARAM, False)
        capabilities = requests.get(f"{self.base_url()}/tuqui/health", timeout=30).json()["capabilities"]
        self.assertNotIn("embed.session", capabilities)

    def _session_info(self, cookie_header, headers):
        return requests.post(
            f"{self.base_url()}/web/session/get_session_info",
            data=json.dumps({"jsonrpc": "2.0", "method": "call", "params": {}}),
            headers={"Content-Type": "application/json", "Cookie": cookie_header, **headers},
            timeout=30,
        ).json()["result"]

    def test_the_panel_session_is_marked_for_the_assistant(self):
        """tuqui_assistant hides itself inside Tuqui's panel by this mark."""
        panel = self._session_info(f"tuqui_panel_sid={self._panel_cookie()}", FROM_THE_FRAME)
        self.assertIs(panel.get("tuqui_embed_panel"), True)
        self.authenticate("admin", "admin")
        normal = self.opener.cookies["session_id"]
        self.assertIs(self._session_info(f"session_id={normal}", {}).get("tuqui_embed_panel"), False)
