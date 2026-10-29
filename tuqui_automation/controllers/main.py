from urllib.parse import urlencode

from odoo import _, http
from odoo.http import request

TRIGGERS_GROUP = "tuqui_automation.group_tuqui_triggers"


class TuquiTriggersController(http.Controller):
    """Entry points from Tuqui. Without access they explain, instead of Odoo's error."""

    @http.route("/tuqui/triggers/new", type="http", auth="user", methods=["GET"])
    def new_trigger(self, agent_id=None, **_kwargs):
        """The trigger wizard, with the agent picked.

        Only a redirect. The wizard is a client action, and the agent id only
        pre-fills the form: saving still goes through the rule's own checks.
        """
        if not request.env.user.has_group(TRIGGERS_GROUP):
            return self._no_access()
        query = {"agent_id": agent_id} if agent_id and len(agent_id) <= 128 else {}
        url = "/odoo/tuqui-new-trigger"
        if query:
            url = f"{url}?{urlencode(query)}"
        return request.redirect(url, local=True)

    @http.route("/tuqui/triggers/<int:rule_id>", type="http", auth="user", methods=["GET"])
    def open_trigger(self, rule_id, **_kwargs):
        """One rule, in the Tuqui triggers form."""
        if not request.env.user.has_group(TRIGGERS_GROUP):
            return self._no_access()
        # search() and not browse(): it applies the record rules.
        rule = request.env["base.automation"].with_context(active_test=False).search([("id", "=", rule_id)])
        if not rule:
            return self._no_access()
        if not rule.tuqui_agent_id:
            # Readable, but no longer a Tuqui trigger: the native form.
            return request.redirect(f"/odoo/automations/{rule.id}", local=True)
        return request.redirect(f"/odoo/tuqui-triggers/{rule.id}", local=True)

    def _no_access(self):
        values = {
            "title": _("You don't have access to Tuqui triggers"),
            "message": _(
                "Ask an Odoo administrator for the «Manage agent triggers» permission (Settings › Users › Tuqui). "
                "Only rules that notify a Tuqui agent are covered by it."
            ),
            "back_label": _("Back to Odoo"),
        }
        return request.render("tuqui_automation.triggers_no_access", values)
