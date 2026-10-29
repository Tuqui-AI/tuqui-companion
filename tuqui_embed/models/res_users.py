from odoo import models
from odoo.exceptions import AccessDenied


class ResUsers(models.Model):
    _inherit = "res.users"

    def _check_credentials(self, credential, env):
        if credential.get("type") != "tuqui_embed_pass":
            return super()._check_credentials(credential, env)
        # The pass is consumed here, so a replay fails even if it gets this far,
        # and it must belong to the user being logged in.
        uid = self.env["tuqui.embed.pass"]._consume(credential.get("token"))
        if not uid or uid != self.env.uid:
            raise AccessDenied()
        # The pass was requested with the member's API key, which already skips
        # 2FA: the panel session gets that same trust level.
        return {"uid": uid, "auth_method": "tuqui_embed_pass", "mfa": "skip"}
