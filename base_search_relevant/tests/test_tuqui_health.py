"""What this module adds to ``/tuqui/health``.

The backend picks the search engine from the capabilities the probe
advertises: without ``search_relevant`` it uses its own lexical cascade.
"""

from odoo.tests import HttpCase, tagged


@tagged("post_install", "-at_install", "base_search_relevant")
class TestHealthWithRankedSearch(HttpCase):
    def _db_headers(self):
        return {"X-Odoo-Database": self.env.cr.dbname}

    def _body(self):
        self.env.flush_all()
        resp = self.url_open("/tuqui/health", headers=self._db_headers())
        self.assertEqual(resp.status_code, 200, resp.text)
        return resp.json()

    def test_the_capability_is_advertised(self):
        body = self._body()
        self.assertIn("search_relevant", body["capabilities"])
        # tuqui.search takes options={"chatter": True} and answers with via.
        self.assertIn("search_relevant.chatter", body["capabilities"])
        # Still everything the base module advertises — this extends, not replaces.
        self.assertIn("rpc.execute_kw", body["capabilities"])
        self.assertIn("access_log", body["capabilities"])
