from odoo import models


class IrActionsServer(models.Model):
    _inherit = "ir.actions.server"

    def _tuqui_notify_trigger_ref(self):
        """Tell the agent which automation rule fired, when one did.

        Any rule, not only the ones made with the Tuqui form: an admin rule
        with a "Notify Tuqui" action gets the same key.
        """
        rule = self.sudo().base_automation_id
        trigger_ref = super()._tuqui_notify_trigger_ref()
        if not rule:
            return trigger_ref
        return {**trigger_ref, "automation": {"id": rule.id, "name": rule.name}}
