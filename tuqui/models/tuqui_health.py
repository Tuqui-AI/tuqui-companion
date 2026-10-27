from odoo import api, models


class TuquiHealth(models.AbstractModel):
    """What ``/tuqui/health`` publishes, as a seam other modules extend.

    A Tuqui backend reads ``capabilities`` during the handshake to decide what
    this database can do. A module that adds one inherits this model and
    extends the method, so neither the controller nor this module has to know
    which optional modules are installed.
    """

    _name = "tuqui.health"
    _description = "Tuqui Health Report"

    @api.model
    def _capabilities(self):
        """Capability names this database advertises to a Tuqui backend.

        The 2.0 surface is a single generic execute_kw gateway behind a local
        policy engine — new capabilities are added on the Tuqui side by calling
        new ORM methods, without shipping a new module version.
        """
        capabilities = ["rpc.execute_kw", "access_log"]
        if self.env["tuqui.oauth.client"].sudo()._is_read_only():
            capabilities.append("policy.read_only")
        return capabilities
