from odoo import models


class ResConfigSettings(models.TransientModel):
    """The entry point to the index configuration, inside the Tuqui block."""

    _inherit = "res.config.settings"

    def action_tuqui_open_search_configs(self):
        # The screen is this module's; the button sits in the Tuqui block
        # because Settings is the only Tuqui surface an administrator navigates.
        return self.env["ir.actions.act_window"]._for_xml_id("base_search_relevant.action_search_relevant_config")
