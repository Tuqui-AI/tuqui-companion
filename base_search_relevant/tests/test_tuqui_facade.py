"""The Tuqui side of the relevance search: the RPC contract, and nothing else.

The engine and everything it guarantees (permissions, ranking, coverage) are
tested in ``test_search_relevant``. What is pinned here is that
``tuqui.search.search_relevant`` still answers with the name, the signature and
the shape the Tuqui backend calls, that the call reaches the engine with the
caller's own environment, and that it is reachable through ``/tuqui/rpc`` on
the most restricted path. The gate that classifies
the method as a read is tested in ``tuqui``.
"""

import json
from unittest.mock import patch

from odoo.addons.tuqui.tests.test_rpc import _rotate_oauth_secret
from odoo.tests import HttpCase, TransactionCase, tagged


@tagged("post_install", "-at_install", "base_search_relevant")
class TestTuquiSearchFacade(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.partner = cls.env["res.partner"].create({"name": "Quenapox azulino industrial"})
        fields_ = cls.env["ir.model.fields"].search([("model", "=", "res.partner"), ("name", "=", "name")])
        cls.config = cls.env["search.relevant.config"].create(
            {"model_id": cls.env["ir.model"]._get_id("res.partner"), "field_ids": [(6, 0, fields_.ids)]}
        )
        while cls.config.backfill_cursor:
            cls.config._backfill_batch(1000)

    def test_the_contract_answers_what_the_engine_answers(self):
        answer = self.env["tuqui.search"].search_relevant("res.partner", "quenapox azulino", limit=5)
        self.assertEqual(answer["engine"], "companion_fts")
        self.assertEqual(answer["terms"], ["quenapox", "azulino"])
        self.assertEqual(answer["coverage"]["state"], "complete")
        self.assertEqual([record["id"] for record in answer["records"]], [self.partner.id])
        self.assertEqual(
            answer, self.env["search.relevant"].search_relevant("res.partner", "quenapox azulino", limit=5)
        )

    def test_the_call_reaches_the_engine_with_the_callers_environment(self):
        """Same environment: the engine runs as the calling user and with the
        caller's context — the language among it, which is what decides the
        words that only name the kind of record."""
        engine = type(self.env["search.relevant"])
        original = engine.search_relevant
        seen = {}

        def spy(records, model, query, domain=None, limit=None, chatter=False):
            seen.update(
                uid=records.env.uid, lang=records.env.context.get("lang"), args=(model, query, domain, limit, chatter)
            )
            return original(records, model, query, domain=domain, limit=limit, chatter=chatter)

        with patch.object(engine, "search_relevant", spy):
            env = self.env(context={"lang": "en_US"})
            env["tuqui.search"].search_relevant("res.partner", "quenapox", domain=[("active", "=", True)], limit=3)
            # Without options the chatter stays out: what a backend that predates it expects.
            self.assertEqual(seen["args"], ("res.partner", "quenapox", [("active", "=", True)], 3, False))
            env["tuqui.search"].search_relevant("res.partner", "quenapox", options={"chatter": True})
            self.assertTrue(seen["args"][4])
        self.assertEqual(seen["uid"], self.env.uid)
        self.assertEqual(seen["lang"], "en_US")


@tagged("post_install", "-at_install", "base_search_relevant")
class TestTuquiSearchThroughTheGateway(HttpCase):
    """The contract answers through ``/tuqui/rpc`` as a read-only member.

    The gateway itself — auth, policy, audit — is covered in ``tuqui``. What
    this pins is that the method this module adds survives the most restricted
    path there is and runs as the acting member.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.client_id, cls.client_secret = _rotate_oauth_secret(cls.env)
        cls.member = cls.env["res.users"].create(
            {
                "name": "Tuqui Search Member",
                "login": "tuqui_search_member",
                "group_ids": [(6, 0, [cls.env.ref("base.group_user").id])],
            }
        )

    def _db_headers(self):
        return {"X-Odoo-Database": self.env.cr.dbname}

    def _token(self):
        resp = self.url_open(
            "/tuqui/oauth/token",
            data={
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            },
            headers=self._db_headers(),
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        return resp.json()["access_token"]

    def test_a_read_only_member_reaches_the_contract(self):
        partner = self.env["res.partner"].create({"name": "Gateway quenapox azulino"})
        fields_ = self.env["ir.model.fields"].search([("model", "=", "res.partner"), ("name", "=", "name")])
        config = (
            self.env["search.relevant.config"]
            .sudo()
            .create({"model_id": self.env["ir.model"]._get_id("res.partner"), "field_ids": [(6, 0, fields_.ids)]})
        )
        while config.backfill_cursor:
            config._backfill_batch(1000)
        self.env["tuqui.oauth.client"].sudo()._get_singleton().write({"read_only": True})
        self.env.flush_all()

        resp = self.url_open(
            "/tuqui/rpc",
            data=json.dumps(
                {
                    "model": "tuqui.search",
                    "method": "search_relevant",
                    "args": ["res.partner", "quenapox azulino"],
                    "kwargs": {"limit": 5},
                }
            ),
            headers={
                **self._db_headers(),
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._token()}",
                "X-Tuqui-Acting-Uid": str(self.member.id),
            },
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        data = resp.json()["data"]
        self.assertEqual(data["engine"], "companion_fts")
        self.assertEqual(data["coverage"]["state"], "complete")
        self.assertEqual([record["id"] for record in data["records"]], [partner.id])

        log = self.env["tuqui.access.log"].sudo().search([("method", "=", "search_relevant")], order="id desc", limit=1)
        self.assertEqual(log.operation_type, "read")
        self.assertEqual(log.acting_user_id, self.member)
