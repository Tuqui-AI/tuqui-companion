"""A copy of a connected database registers as a test database of the same workspace.

Spec ``bases-de-prueba-del-workspace``: the neutralize leaves the connection as
``copy_pending``, and the first time the panel opens the copy mints its own
credentials, keeps them, and registers them with Tuqui signed with the key it
inherited.
"""

import hashlib
import hmac
import json
import secrets
from unittest.mock import MagicMock, patch

from odoo.tests import HttpCase, TransactionCase, tagged

_POST = "odoo.addons.tuqui.models.tuqui_oauth_client.requests.post"


def _copy(env):
    client = env["tuqui.oauth.client"].sudo()._get_or_create_singleton()[0]
    client.write({"state": "copy_pending", "workspace_id_external": "prod-workspace"})
    client._ensure_signing_key()
    return client


@tagged("post_install", "-at_install", "tuqui")
class TestTuquiTestCopy(TransactionCase):
    def _register(self, status_code=202, answer="active"):
        response = MagicMock(status_code=status_code)
        response.json.return_value = {"status": answer}
        with patch(_POST, return_value=response) as post, patch.object(self.env.cr, "commit"):
            result = self.env["tuqui.oauth.client"].register_test_copy()
        return result, post

    def test_the_copy_registers_signed_with_the_key_it_inherited(self):
        client = _copy(self.env)
        inherited_id, inherited_key = client.client_id, client.event_signing_key

        result, post = self._register()

        self.assertEqual(result["status"], "registered")
        self.assertEqual(client.state, "test")
        self.assertNotEqual(client.client_id, inherited_id)
        self.assertNotEqual(client.event_signing_key, inherited_key)
        self.assertFalse(client.copy_parent_client_id)
        headers, body = post.call_args.kwargs["headers"], post.call_args.kwargs["data"]
        self.assertEqual(headers["X-Tuqui-Client-Id"], inherited_id)
        timestamp, signature = (part.split("=", 1)[1] for part in headers["X-Tuqui-Signature"].split(","))
        expected = hmac.new(inherited_key.encode(), f"{timestamp}.{body}".encode(), hashlib.sha256).hexdigest()
        self.assertEqual(signature, expected)
        payload = json.loads(body)
        self.assertEqual(payload["client_id"], client.client_id)
        self.assertEqual(payload["event_signing_key"], client.event_signing_key)
        self.assertTrue(client.verify_secret(payload["client_secret"]))

    def test_a_failed_registration_retries_with_exactly_the_same_credentials(self):
        """Tuqui may have received the first one: it only accepts the same credentials again."""
        client = _copy(self.env)
        inherited_id = client.client_id

        with self.assertLogs("odoo.addons.tuqui.models.tuqui_oauth_client", "WARNING"):
            first, first_post = self._register(status_code=502)
        second, post = self._register()

        self.assertEqual(first["status"], "failed")
        self.assertEqual(second["status"], "registered")
        sent = [json.loads(call.kwargs["data"]) for call in (first_post.call_args, post.call_args)]
        for key in ("client_id", "client_secret", "event_signing_key"):
            self.assertEqual(sent[0][key], sent[1][key])
        self.assertEqual(post.call_args.kwargs["headers"]["X-Tuqui-Client-Id"], inherited_id)
        self.assertFalse(client.copy_pending_secret)

    def test_the_copy_stays_pending_until_tuqui_reached_it(self):
        """Tuqui verifies in the background: a copy it never reaches must be able to register again."""
        client = _copy(self.env)

        first, first_post = self._register(answer="pending")

        self.assertEqual(first["status"], "pending")
        self.assertEqual(client.state, "copy_pending")
        self.assertTrue(client.copy_pending_secret)

        second, post = self._register()

        self.assertEqual(second["status"], "registered")
        self.assertEqual(client.state, "test")
        sent = [json.loads(call.kwargs["data"]) for call in (first_post.call_args, post.call_args)]
        for key in ("client_id", "client_secret", "event_signing_key"):
            self.assertEqual(sent[0][key], sent[1][key])

    def test_production_does_not_register(self):
        client = _copy(self.env)
        client.write({"state": "active"})

        result, post = self._register()

        self.assertEqual(result["status"], "not_a_copy")
        post.assert_not_called()

    def test_the_panel_sees_a_copy_and_then_a_connected_test_database(self):
        _copy(self.env)
        Nonce = self.env["tuqui.assistant.sso.nonce"] if "tuqui.assistant.sso.nonce" in self.env else None
        if Nonce is None:
            self.skipTest("tuqui_assistant not installed")
        self.assertTrue(Nonce.embed_bootstrap()["copy_pending"])

        self._register()

        boot = Nonce.embed_bootstrap()
        self.assertFalse(boot["copy_pending"])
        self.assertTrue(boot["connected"])


@tagged("post_install", "-at_install", "tuqui")
class TestTuquiTestCopyToken(HttpCase):
    def _token(self, client, secret):
        return self.url_open(
            "/tuqui/oauth/token",
            data={"grant_type": "client_credentials", "client_id": client.client_id, "client_secret": secret},
            headers={"X-Odoo-Database": self.env.cr.dbname},
        )

    def test_production_credentials_do_not_open_a_copy(self):
        client = _copy(self.env)
        secret = secrets.token_urlsafe(48)
        salt = secrets.token_hex(16)
        client.write({"client_secret_hash": client._hash_secret(secret, salt), "client_secret_salt": salt})

        self.assertEqual(self._token(client, secret).status_code, 401)

    def test_the_copy_credentials_open_it_while_tuqui_verifies(self):
        client = _copy(self.env)
        client.write({"copy_parent_client_id": client.client_id, "copy_parent_signing_key": "k"})
        client._rotate_client_id()
        secret = client._rotate_secret_silent()

        self.assertEqual(self._token(client, secret).status_code, 200)
