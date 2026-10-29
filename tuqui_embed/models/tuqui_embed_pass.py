import hashlib
import secrets
from datetime import timedelta

from odoo import api, fields, models
from odoo.exceptions import AccessDenied, UserError

from .ir_http import embed_origins

PASS_TTL_SECONDS = 90


def _digest(token):
    return hashlib.sha256((token or "").encode()).hexdigest()


class TuquiEmbedPass(models.Model):
    """A one-time pass that opens this Odoo inside Tuqui's side panel.

    Tuqui asks for it over RPC with the member's own credentials, so the pass
    is always for the calling user. The browser redeems it once, within
    ``PASS_TTL_SECONDS``, at ``/tuqui_embed/enter``; only its hash is stored.
    """

    _name = "tuqui.embed.pass"
    _description = "Tuqui panel pass"

    token_hash = fields.Char(required=True, index=True)
    user_id = fields.Many2one("res.users", required=True, ondelete="cascade")
    expires_at = fields.Datetime(required=True)
    consumed_at = fields.Datetime()

    def issue(self, origin=None):
        """Mint a pass for the calling user. Called by Tuqui over RPC.

        NOT ``@api.model``, on purpose: both of Tuqui's transports send
        ``execute_kw(model, "issue", [[]])`` (an empty recordset first), which
        an ``@api.model`` method rejects as one argument too many. Called on an
        empty recordset it works through either.

        Refused when the Tuqui asking is not a declared origin (``origin``, the
        one the panel runs on): this Odoo would not let that page frame it, and
        Tuqui hands over the link instead of a blank panel.
        """
        user = self.env.user
        if self.env.su or user.share or not user.active:
            raise AccessDenied()
        origins = embed_origins(self.env)
        if not origins or (origin and origin not in origins):
            raise UserError(self.env._("This Tuqui is not a declared origin in tuqui.embed_origins."))
        token = secrets.token_urlsafe(32)
        self.sudo().create(
            {
                "token_hash": _digest(token),
                "user_id": user.id,
                "expires_at": fields.Datetime.now() + timedelta(seconds=PASS_TTL_SECONDS),
            }
        )
        return token

    @api.model
    def _peek_login(self, token):
        rec = self.sudo().search(
            [
                ("token_hash", "=", _digest(token)),
                ("consumed_at", "=", False),
                ("expires_at", ">", fields.Datetime.now()),
            ],
            limit=1,
        )
        return rec.user_id.login if rec else None

    @api.model
    def _consume(self, token):
        """Atomic: two concurrent redemptions cannot both win."""
        # The current time comes from Python, not from `now()`: Postgres
        # freezes `now()` at the start of the transaction.
        now = fields.Datetime.now()
        self.env.cr.execute(
            """UPDATE tuqui_embed_pass SET consumed_at = %s
               WHERE token_hash = %s AND consumed_at IS NULL AND expires_at > %s
               RETURNING user_id""",
            [now, _digest(token), now],
        )
        row = self.env.cr.fetchone()
        return row[0] if row else None

    @api.autovacuum
    def _gc_old_passes(self):
        """A pass is useless once expired: keep a day of them, for the record."""
        self.sudo().search([("expires_at", "<", fields.Datetime.now() - timedelta(days=1))]).unlink()
