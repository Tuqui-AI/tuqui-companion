"""Tests for reporting this Odoo's domains to Tuqui.

Tuqui builds the embed's CSP ``frame-ancestors`` from what it knows about us, and
it used to know exactly one name: whatever ``web.base.url`` said at connect time.
One custom domain later the panel is framed by a page that header does not list,
and the browser refuses to connect with nothing to show for it. This report is
how the other names get there.

Two properties carry the weight, and both were learned the hard way in review:

* **The origins come from configuration, never from a request.** A request's
  ``Host`` is chosen by whoever makes the request, so reading it let any user
  with a session name an origin and have it written into the header meant to
  constrain them, and fill the cap so no real domain fitted.
* **Nothing here may raise or stall.** It is a cron now precisely because the
  earlier version ran in the panel's bootstrap, where a slow Tuqui would have
  delayed every page load of every user.
"""

import json
from unittest.mock import patch

import requests
from odoo.tests import TransactionCase, tagged


class _FakeResponse:
    """Tuqui's answer. `origins` is what it says it STORED, which is not always
    what was sent: it truncates at its cap and drops what fails its validation."""

    def __init__(self, status_code=200, origins=None, text=None):
        self.status_code = status_code
        self._payload = {"origins": [] if origins is None else origins}
        self.text = text if text is not None else json.dumps(self._payload)

    def json(self):
        if self.text is not None and not self.text.startswith("{"):
            raise ValueError("not json")
        return self._payload


@tagged("post_install", "-at_install", "tuqui")
class TestFrameOriginReport(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        client, _secret = cls.env["tuqui.oauth.client"].sudo()._get_or_create_singleton()
        client.write({"state": "active", "workspace_id_external": "test-workspace"})
        client._ensure_signing_key()
        cls.client = client
        cls.Client = cls.env["tuqui.oauth.client"]

    def _set_base_url(self, url):
        self.env["ir.config_parameter"].sudo().set_param("web.base.url", url)

    def _run_cron(self, echo=True, **response_kwargs):
        """Run the cron with Tuqui stubbed.

        `echo` makes the stub answer with exactly what was sent, which is the
        ordinary case; a test that cares about a partial store passes `origins`.
        """

        def _fake_post(*args, **kwargs):
            if echo and "origins" not in response_kwargs:
                sent = json.loads(kwargs["data"])["origins"]
                return _FakeResponse(origins=sent, **response_kwargs)
            return _FakeResponse(**response_kwargs)

        with patch.object(requests, "post", side_effect=_fake_post) as post:
            self.Client.sudo()._cron_report_frame_origins()
        return post

    # ---- _origin_of ----

    def test_origin_of_normalizes_what_an_admin_typed(self):
        cases = {
            "https://www.acme.example": "https://www.acme.example",
            # A bare domain is what a website record usually holds.
            "www.acme.example": "https://www.acme.example",
            "https://www.acme.example/": "https://www.acme.example",
            "https://www.acme.example/shop?x=1": "https://www.acme.example",
            "https://WWW.ACME.EXAMPLE": "https://www.acme.example",
            # An on-premise instance really is plain HTTP, and saying so is the
            # whole point of sending the scheme instead of letting it be guessed.
            "http://odoo.empresa.local": "http://odoo.empresa.local",
            "http://localhost:8069": "http://localhost:8069",
            "  https://x.com  ": "https://x.com",
            # Punycode. `frame-ancestors` is ASCII, so an accented domain — an
            # ordinary thing in .ar — was reported every day and authorized never.
            "https://mañana.com.ar": "https://xn--maana-pta.com.ar",
            "niño.com.ar": "https://xn--nio-8ma.com.ar",
        }
        for raw, expected in cases.items():
            self.assertEqual(self.Client._origin_of(raw), expected, raw)

    def test_origin_of_drops_what_it_cannot_read(self):
        for raw in ["", "   ", None, "javascript:alert(1)", "https://", "ftp://x.com"]:
            self.assertIsNone(self.Client._origin_of(raw), raw)

    # ---- _declared_frame_origins ----

    def test_declares_the_base_url(self):
        self._set_base_url("https://acme.saas.example")

        self.assertEqual(self.Client._declared_frame_origins(), ["https://acme.saas.example"])

    def test_declares_every_website_domain_beside_the_base_url(self):
        """The usual hosted shape: one instance, three names.

        Skipped where `website` is not installed, because the module does not
        depend on it and there is nothing to read.

        Nothing is deleted to set this up: Odoo refuses to unlink the default
        website, so clearing the table first turned the test into a UserError.
        The assertions are containment, not equality, which is what this method
        actually promises — it reports the domains it finds, and an instance may
        have websites this test did not create.
        """
        if self.env.get("website") is None:
            self.skipTest("website not installed")
        self._set_base_url("https://acme.saas.example")
        self.env["website"].sudo().create({"name": "Acme", "domain": "https://www.acme.example"})
        self.env["website"].sudo().create({"name": "Globex", "domain": "www.globex.example"})

        origins = self.Client._declared_frame_origins()

        self.assertEqual(origins[0], "https://acme.saas.example", "the canonical URL comes first")
        self.assertIn("https://www.acme.example", origins)
        # Bare in the record, full origin out: what an admin types is not an origin.
        self.assertIn("https://www.globex.example", origins)

    def test_a_domain_named_by_both_sources_is_declared_once(self):
        """The canonical URL is often also a website's domain, and reporting it
        twice would spend one of the ten slots on a duplicate."""
        if self.env.get("website") is None:
            self.skipTest("website not installed")
        self._set_base_url("https://acme.saas.example")
        # Written onto an existing website rather than a fresh one: the default
        # website cannot be deleted, so the setup works with what is there.
        website = self.env["website"].sudo().search([], limit=1)
        if not website:
            self.skipTest("no website record to point at the base url")
        website.domain = "acme.saas.example"

        origins = self.Client._declared_frame_origins()

        self.assertEqual(origins.count("https://acme.saas.example"), 1)

    def test_declares_the_extra_urls_an_admin_set(self):
        """The SaaS internal host is in neither source above, and it is the one
        people log in through."""
        self._set_base_url("https://www.initech.example")
        self.env["ir.config_parameter"].sudo().set_param(
            "tuqui.extra_embed_origins", "https://initech.saas.example, otra.example.com  not a url://"
        )

        origins = self.Client._declared_frame_origins()

        self.assertEqual(origins[0], "https://www.initech.example")
        self.assertIn("https://initech.saas.example", origins)
        self.assertIn("https://otra.example.com", origins)
        self.assertEqual(len(origins), len(set(origins)))

    # ---- the cron ----

    def test_reports_the_whole_declared_list_with_a_signature(self):
        self._set_base_url("https://acme.saas.example")
        post = self._run_cron()

        self.assertEqual(post.call_count, 1)
        self.assertTrue(post.call_args.args[0].endswith("/v1/companion/embed-origins"))
        headers = post.call_args.kwargs["headers"]
        self.assertEqual(headers["X-Tuqui-Client-Id"], self.client.client_id)
        self.assertIn("X-Tuqui-Signature", headers)
        # Full origins with scheme, in a list: a downstream guess would say http
        # for a page the browser loaded over https and match nothing.
        self.assertEqual(post.call_args.kwargs["data"], '{"origins":["https://acme.saas.example"]}')
        self.assertEqual(self.client.sudo().reported_embed_origins, "https://acme.saas.example")

    def test_an_unchanged_list_costs_no_round_trip(self):
        """A daily cron on a steady instance must make no network call at all."""
        self._set_base_url("https://acme.saas.example")
        self._run_cron()
        post = self._run_cron()

        self.assertEqual(post.call_count, 0)

    def test_a_changed_list_is_reported_again(self):
        self._set_base_url("https://acme.saas.example")
        self._run_cron()
        self._set_base_url("https://other.saas.example")
        post = self._run_cron()

        self.assertEqual(post.call_count, 1)
        self.assertEqual(self.client.sudo().reported_embed_origins, "https://other.saas.example")

    def test_what_is_remembered_is_what_tuqui_stored_not_what_was_sent(self):
        """So a domain that did not fit is retried instead of filed as done.

        Remembering the request was the bug: at the cap Tuqui answered 200 and
        the module recorded the origin as reported, so if room freed up later
        that domain was never mentioned again.
        """
        self._set_base_url("https://acme.saas.example")
        self._run_cron(echo=False, origins=[])

        self.assertFalse(self.client.sudo().reported_embed_origins)

        # And the next run tries again, precisely because nothing was remembered.
        post = self._run_cron()
        self.assertEqual(post.call_count, 1)

    def test_a_refusal_is_not_remembered_so_a_later_run_still_lands(self):
        self._set_base_url("https://acme.saas.example")
        post = self._run_cron(echo=False, status_code=400, text="bad origins")

        self.assertEqual(post.call_count, 1)
        self.assertFalse(self.client.sudo().reported_embed_origins)

    def test_an_unreadable_answer_is_not_remembered(self):
        self._set_base_url("https://acme.saas.example")
        self._run_cron(echo=False, text="not json at all")

        self.assertFalse(self.client.sudo().reported_embed_origins)

    def test_tuqui_being_unreachable_does_not_raise(self):
        self._set_base_url("https://acme.saas.example")
        with patch.object(requests, "post", side_effect=requests.ConnectionError("down")):
            self.Client.sudo()._cron_report_frame_origins()  # must not raise

        self.assertFalse(self.client.sudo().reported_embed_origins)

    def test_a_database_with_no_signing_key_does_not_raise(self):
        """``_sign_outbound`` raises for a database activated before signing keys
        existed and whose key Tuqui has not minted yet. A live state with a
        documented fix of its own, and not one a cron may die on."""
        self._set_base_url("https://acme.saas.example")
        self.client.sudo().write({"event_signing_key": False})
        post = self._run_cron()

        self.assertEqual(post.call_count, 0)
        self.assertFalse(self.client.sudo().reported_embed_origins)

    def test_a_disconnected_companion_reports_nothing(self):
        self._set_base_url("https://acme.saas.example")
        self.client.write({"state": "disconnected"})
        post = self._run_cron()

        self.assertEqual(post.call_count, 0)

    def test_disconnecting_forgets_what_was_reported(self):
        """The reported list belongs to the connection.

        Kept across a teardown, the next activation would skip reporting names
        the new connection never declared.
        """
        self._set_base_url("https://acme.saas.example")
        self._run_cron()
        self.assertTrue(self.client.sudo().reported_embed_origins)

        # `action_disconnect` also notifies Tuqui best-effort; stub it so the test
        # is not reaching the network to assert a local write.
        with patch.object(requests, "post", return_value=_FakeResponse()):
            self.client.action_disconnect()

        self.assertFalse(self.client.sudo().reported_embed_origins)

    def test_activating_forgets_too_and_asks_the_cron_to_run(self):
        """Not only on disconnect. A teardown started on Tuqui's side revokes us
        over HTTP and that call can fail: Tuqui ends up with an empty list while
        we still believe we reported everything, so the next connection would
        never re-declare its domains. And without the trigger the first report
        waits for the daily cron, leaving a branded domain blocked for a day.
        """
        self._set_base_url("https://acme.saas.example")
        self._run_cron()
        self.assertTrue(self.client.sudo().reported_embed_origins)

        with patch.object(type(self.Client), "_trigger_frame_origins_report") as trigger:
            self.client.mark_active()

        self.assertFalse(self.client.sudo().reported_embed_origins)
        self.assertEqual(trigger.call_count, 1)
