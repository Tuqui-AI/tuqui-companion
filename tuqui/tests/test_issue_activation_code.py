"""Tests for issue_activation_code: the activation code without the browser redirect."""

import json

from odoo import SUPERUSER_ID
from odoo.exceptions import AccessError
from odoo.tests import HttpCase, TransactionCase, tagged

_COMPANION_URL = "https://erp.example.com"


def _setup_activation_data(cls):
    cls.env["ir.config_parameter"].sudo().set_param("web.base.url", _COMPANION_URL)
    cls.client = cls.env["tuqui.oauth.client"].sudo()._get_or_create_singleton()[0]
    cls.client.write({"state": "pending", "activation_pending": False})
    cls.env["tuqui.activation.nonce"].sudo().search([]).unlink()
    cls.database_uuid = cls.env["ir.config_parameter"].sudo().get_param("database.uuid")
    cls.admin_user = cls.env["res.users"].create(
        {
            "name": "Tuqui Issue Code Admin",
            "login": "tuqui_issue_code_admin",
            "password": "tuqui_issue_code_admin",
            "group_ids": [(6, 0, [cls.env.ref("base.group_user").id, cls.env.ref("base.group_system").id])],
        }
    )


@tagged("post_install", "-at_install", "tuqui")
class TestIssueActivationCode(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        _setup_activation_data(cls)
        cls.internal_user = cls.env["res.users"].create(
            {
                "name": "Tuqui Issue Code Internal",
                "login": "tuqui_issue_code_internal",
                "group_ids": [(6, 0, [cls.env.ref("base.group_user").id])],
            }
        )

    def _nonces(self):
        return self.env["tuqui.activation.nonce"].sudo().search([])

    def test_issues_a_code_an_admin_can_hand_to_tuqui(self):
        result = self.env["tuqui.oauth.client"].with_user(self.admin_user).issue_activation_code()

        self.assertEqual(result["status"], "issued")
        self.assertEqual(result["companion_url"], _COMPANION_URL)
        self.assertEqual(result["database_uuid"], self.database_uuid)
        row = self._nonces()
        self.assertEqual(row.nonce, result["nonce"])
        self.client.invalidate_recordset()
        self.assertEqual(row.client_id, self.client.client_id)
        self.assertTrue(self.client.verify_secret(row.client_secret_plaintext))
        self.assertEqual(row.event_signing_key, self.client.event_signing_key)
        self.assertEqual(row.acting_user_login, self.admin_user.login)

    def test_refuses_an_internal_user_who_is_not_admin(self):
        with self.assertRaises(AccessError):
            self.env["tuqui.oauth.client"].with_user(self.internal_user).issue_activation_code()
        self.assertFalse(self._nonces())

    def test_an_active_connection_answers_active_and_rotates_nothing(self):
        self.client.write({"state": "active"})
        before = (self.client.client_id, self.client.client_secret_hash, self.client.event_signing_key)

        result = self.env["tuqui.oauth.client"].with_user(self.admin_user).issue_activation_code()

        self.assertEqual(result, {"status": "active", "database_uuid": self.database_uuid})
        self.client.invalidate_recordset()
        self.assertEqual(
            (self.client.client_id, self.client.client_secret_hash, self.client.event_signing_key),
            before,
        )
        self.assertFalse(self._nonces())

    def test_a_second_call_reuses_the_outstanding_code(self):
        client_model = self.env["tuqui.oauth.client"].with_user(self.admin_user)
        first = client_model.issue_activation_code()
        self.client.invalidate_recordset()
        secret_hash = self.client.client_secret_hash

        second = client_model.issue_activation_code()

        self.assertEqual(second["nonce"], first["nonce"])
        self.client.invalidate_recordset()
        self.assertEqual(self.client.client_secret_hash, secret_hash)

    def test_the_superuser_can_call_it(self):
        """The provisioning system calls it over JSON-RPC as ``__system__`` (uid 1)."""
        result = self.env["tuqui.oauth.client"].with_user(SUPERUSER_ID).issue_activation_code()

        self.assertEqual(result["status"], "issued")
        self.assertEqual(self._nonces().acting_user_login, self.env.ref("base.user_root").login)


@tagged("post_install", "-at_install", "tuqui")
class TestIssueActivationCodeExchange(HttpCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        _setup_activation_data(cls)

    def test_the_code_redeems_at_exchange_like_the_one_from_start(self):
        result = self.env["tuqui.oauth.client"].with_user(self.admin_user).issue_activation_code()

        resp = self.url_open(
            "/tuqui/activation/exchange",
            data=json.dumps({"nonce": result["nonce"]}),
            headers={"X-Odoo-Database": self.env.cr.dbname, "Content-Type": "application/json"},
        )

        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.client.invalidate_recordset()
        self.assertEqual(body["client_id"], self.client.client_id)
        self.assertTrue(self.client.verify_secret(body["client_secret"]))
        self.assertEqual(body["event_signing_key"], self.client.event_signing_key)
        self.assertEqual(body["acting_user_login"], self.admin_user.login)
        self.assertEqual(body["companion_url"], _COMPANION_URL)
        self.assertTrue(self.client.activation_pending)
