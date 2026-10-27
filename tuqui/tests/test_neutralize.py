"""A database duplicated for testing comes out disconnected from Tuqui."""

from odoo.modules.neutralize import get_neutralization_queries
from odoo.tests import TransactionCase, tagged


@tagged("post_install", "-at_install", "tuqui")
class TestTuquiNeutralize(TransactionCase):
    def _neutralize(self):
        # Raw SQL, like the real neutralize: the writes of the test must be in the table first.
        self.env.flush_all()
        for query in get_neutralization_queries(["tuqui"]):
            self.env.cr.execute(query)
        self.env.invalidate_all()

    def test_copy_is_disconnected_and_reconnects_as_a_new_client(self):
        OAuthClient = self.env["tuqui.oauth.client"].sudo()
        client = OAuthClient._get_or_create_singleton()[0]
        client.write({"state": "active", "workspace_id_external": "prod-workspace"})
        production_client_id = client.client_id
        self.env["tuqui.activation.nonce"].sudo()._issue(
            client_id=production_client_id,
            client_secret_plaintext="secret",
            acting_user_login="admin",
        )
        ICP = self.env["ir.config_parameter"].sudo()
        ICP.set_param("tuqui.oauth.signing_key", "production-key")

        self._neutralize()

        self.assertFalse(OAuthClient.search([]))
        self.assertFalse(self.env["tuqui.activation.nonce"].sudo().search([]))
        self.assertFalse(ICP.get_param("tuqui.oauth.signing_key"))
        # Tuqui finds a workspace by client_id, so a copy that kept production's
        # would answer for it after reconnecting.
        new_client = OAuthClient._get_or_create_singleton()[0]
        self.assertNotEqual(new_client.client_id, production_client_id)
        self.assertEqual(new_client.state, "pending")
