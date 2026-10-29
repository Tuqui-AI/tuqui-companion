from odoo import api, models

from .ir_http import embed_origins


class TuquiHealth(models.AbstractModel):
    _inherit = "tuqui.health"

    @api.model
    def _capabilities(self):
        """``embed.session``: Tuqui may open this Odoo in its panel with a pass."""
        capabilities = super()._capabilities()
        if embed_origins(self.env):
            capabilities.append("embed.session")
        return capabilities
