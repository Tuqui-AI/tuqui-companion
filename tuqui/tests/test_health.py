"""Contract of the public ``/tuqui/health`` endpoint.

``/tuqui/health`` is ``auth='none'`` — Tuqui pings it pre-auth during cold-start
detect to confirm the module is present and negotiate the protocol. This suite
pins the body it advertises, and (per F2) asserts that ``db_name`` is NOT in it:
the database name is a sensitive fingerprint and must not be exposed on a public
endpoint. The assertion doubles as a regression guard so nobody reintroduces it.

What an optional module adds to the body is tested in that module — here, only
what ``tuqui`` answers on its own.
"""

from odoo.addons.tuqui.models.tuqui_health import TuquiHealth
from odoo.tests import HttpCase, TransactionCase, tagged


@tagged("post_install", "-at_install", "tuqui")
class TestTuquiHealth(HttpCase):
    """The health probe is public and advertises a stable contract."""

    def _db_headers(self):
        return {"X-Odoo-Database": self.env.cr.dbname}

    def test_health_is_public_and_advertises_contract(self):
        resp = self.url_open("/tuqui/health", headers=self._db_headers())
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertIs(body["ok"], True)
        self.assertEqual(body["module"], "tuqui")
        self.assertEqual(body["protocol_version"], "2.0")
        self.assertTrue(body["module_version"])
        self.assertTrue(body["odoo_version"])
        for cap in ("rpc.execute_kw", "access_log"):
            self.assertIn(cap, body["capabilities"])
        self.assertEqual(
            set(body), {"ok", "module", "module_version", "protocol_version", "odoo_version", "capabilities"}
        )
        # F2: the database name must NOT be exposed on the public endpoint.
        self.assertNotIn("db_name", body)


@tagged("post_install", "-at_install", "tuqui")
class TestTuquiHealthReport(TransactionCase):
    """What ``tuqui`` alone answers, with no module extending it.

    It cannot be asserted over HTTP: the two modules of this repo are installed
    together, so the running registry always carries the override. Calling the
    class method of this module skips the inheritance and asks exactly the
    question — what a client database with only ``tuqui`` gets.
    """

    def test_alone_it_knows_nothing_about_ranked_search(self):
        report = self.env["tuqui.health"]
        capabilities = TuquiHealth._capabilities(report)
        self.assertIn("rpc.execute_kw", capabilities)
        self.assertIn("access_log", capabilities)
        self.assertNotIn("search_relevant", capabilities)
