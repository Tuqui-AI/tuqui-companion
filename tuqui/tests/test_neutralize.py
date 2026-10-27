"""A database duplicated for testing comes out disconnected from Tuqui."""

from unittest.mock import patch

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

    def test_a_connected_copy_waits_to_register_as_a_test_database(self):
        OAuthClient = self.env["tuqui.oauth.client"].sudo()
        client = OAuthClient._get_or_create_singleton()[0]
        client.write({"state": "active", "workspace_id_external": "prod-workspace"})
        production_client_id = client.client_id
        production_key = client._ensure_signing_key()
        self.env["tuqui.activation.nonce"].sudo()._issue(
            client_id=production_client_id,
            client_secret_plaintext="secret",
            event_signing_key=production_key,
            acting_user_login="admin",
        )
        ICP = self.env["ir.config_parameter"].sudo()
        ICP.set_str("tuqui.oauth.signing_key", "production-key")
        Event = self.env["tuqui.event"].sudo()
        values = {"agent_external_id": "agent-1", "res_model": "res.partner", "res_id": 1}
        pending = Event.create(values)
        sent = Event.create(dict(values, state="sent"))

        self._neutralize()

        copy = OAuthClient._get_singleton()
        self.assertEqual(copy.state, "copy_pending")
        # Kept only to sign the copy's own registration (register_test_copy).
        self.assertEqual(copy.client_id, production_client_id)
        self.assertEqual(copy.event_signing_key, production_key)
        self.assertFalse(self.env["tuqui.activation.nonce"].sudo().search([]))
        self.assertFalse(ICP.get_str("tuqui.oauth.signing_key"))
        self.assertFalse(pending.exists())
        self.assertTrue(sent.exists(), "delivery history stays")
        # Nothing the copy enqueues leaves it signed as production.
        late = Event.enqueue("agent-1", "res.partner", 1)
        with patch("odoo.addons.tuqui.models.tuqui_event.requests.post") as post:
            late._deliver(auto_commit=False)
        post.assert_not_called()
        self.assertEqual(late.state, "pending")

    def test_a_copy_of_a_database_never_connected_starts_clean(self):
        OAuthClient = self.env["tuqui.oauth.client"].sudo()
        OAuthClient._get_or_create_singleton()

        self._neutralize()

        self.assertFalse(OAuthClient.search([]))

    def test_a_copy_of_a_copy_mid_registration_mints_its_own_credentials(self):
        """Kept, the source's pending secret would register this copy as the source."""
        OAuthClient = self.env["tuqui.oauth.client"].sudo()
        client = OAuthClient._get_or_create_singleton()[0]
        client.write({"state": "copy_pending", "workspace_id_external": "prod-workspace"})
        client.write(
            {"copy_parent_client_id": client.client_id, "copy_parent_signing_key": client._ensure_signing_key()}
        )
        client._rotate_client_id()
        client.write({"copy_pending_secret": client._rotate_secret_silent()})
        source_client_id = client.client_id

        self._neutralize()

        copy = OAuthClient._get_singleton()
        self.assertEqual(copy.state, "copy_pending")
        self.assertFalse(copy.copy_parent_client_id)
        self.assertFalse(copy.copy_parent_signing_key)
        self.assertFalse(copy.copy_pending_secret)
        # Its registration then signs as the source and sends new credentials.
        with patch("odoo.addons.tuqui.models.tuqui_oauth_client.requests.post") as post, patch.object(
            self.env.cr, "commit"
        ):
            post.return_value.status_code = 202
            post.return_value.json.return_value = {"status": "pending"}
            OAuthClient.register_test_copy()
        self.assertEqual(post.call_args.kwargs["headers"]["X-Tuqui-Client-Id"], source_client_id)
        self.assertNotEqual(copy.client_id, source_client_id)
