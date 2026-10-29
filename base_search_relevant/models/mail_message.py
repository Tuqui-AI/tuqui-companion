from odoo import models


class MailMessage(models.Model):
    _inherit = "mail.message"

    def write(self, vals):
        config = self.env["search.relevant.config"].sudo()._edit_config(self._name) if self else None
        before = config._write_dates(self) if config else None
        result = super().write(vals)
        # The index of the chatter is append_only: an edit, or Odoo's "delete"
        # (an empty body), must re-index the message here or never.
        if config:
            config._reindex_edited(self, set(vals), before)
        return result
