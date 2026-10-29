import ast

from odoo import _, api, fields, models
from odoo.exceptions import ValidationError
from odoo.fields import Domain
from odoo.tools import safe_eval

# Triggers a non-admin with the Tuqui group may use. Left out on purpose:
# `on_webhook` (a public URL that fires the agent), `on_change` (runs on every
# keystroke of a form, saved or not), `on_unlink` and the message triggers.
# A domain is evaluated with `user` and `model` in its eval context, as whoever
# triggers the rule (an admin, say), and safe_eval allows method calls: a
# non-admin's domain may only hold literals, `uid` and date arithmetic, checked
# on its source before it is ever evaluated.
DOMAIN_NAMES = {"uid", "datetime", "dateutil", "time"}
DOMAIN_ATTRIBUTES = {
    "datetime",
    "date",
    "time",
    "timedelta",
    "relativedelta",
    "now",
    "today",
    "combine",
    "replace",
    "strftime",
    "min",
    "max",
}
DOMAIN_NODES = (
    ast.Expression,
    ast.List,
    ast.Tuple,
    ast.Constant,
    ast.Name,
    ast.Load,
    ast.UnaryOp,
    ast.USub,
    ast.UAdd,
    ast.Not,
    ast.BinOp,
    ast.Add,
    ast.Sub,
    ast.Call,
    ast.Attribute,
    ast.keyword,
)

ALLOWED_TRIGGERS = (
    "on_create",
    "on_create_or_write",
    "on_stage_set",
    "on_tag_set",
    "on_state_set",
    "on_priority_set",
    "on_user_set",
    "on_archive",
    "on_time",
    "on_time_created",
    "on_time_updated",
)

_CREATING = object()


class BaseAutomation(models.Model):
    """A rule whose only action notifies a Tuqui agent.

    ``tuqui_agent_id`` is a shortcut over the "Notify Tuqui" server action:
    choosing it keeps exactly one such action on the rule, created and updated
    in sudo. That is what lets the ``group_tuqui_triggers`` group manage these
    rules without any right on ``ir.actions.server``.
    """

    _inherit = "base.automation"

    tuqui_agent_id = fields.Selection(
        selection="_tuqui_agent_choices",
        string="Tuqui Agent",
        compute="_compute_tuqui_agent_id",
        inverse="_inverse_tuqui_agent_id",
        store=True,
        readonly=False,
        copy=False,
        help="The Tuqui agent this rule triggers. Its only action notifies that agent.",
    )
    # Screen-only: the last name the default-name onchange wrote.
    tuqui_default_name = fields.Char(store=False)

    @api.model
    def _tuqui_agent_choices(self):
        return self.env["ir.actions.server"]._tuqui_agent_choices()

    # ---------- Agent <-> action ----------

    @api.depends("action_server_ids", "action_server_ids.state", "action_server_ids.tuqui_agent_id")
    def _compute_tuqui_agent_id(self):
        for rule in self:
            actions = rule.sudo().action_server_ids
            if len(actions) == 1 and actions.state == "tuqui_notify":
                rule.tuqui_agent_id = actions.tuqui_agent_id
            elif actions or isinstance(rule.id, int):
                rule.tuqui_agent_id = False
            # else: a rule still being filled in a form keeps the agent picked
            # there; its action only exists once the rule is saved.

    def _inverse_tuqui_agent_id(self):
        Action = self.env["ir.actions.server"].sudo()
        for rule in self:
            actions = rule.sudo().action_server_ids
            notify = actions.filtered(lambda a: a.state == "tuqui_notify")[:1]
            if not rule.tuqui_agent_id:
                notify.unlink()
                continue
            # A rule with an agent has exactly one action, and it is this one.
            # Other actions are never deleted on the user's behalf, not even an admin's.
            if actions - notify:
                raise ValidationError(_("This rule has other actions: remove them before choosing a Tuqui agent."))
            values = {
                "name": rule.name,
                "model_id": rule.model_id.id,
                "tuqui_agent_id": rule.tuqui_agent_id,
            }
            if notify:
                notify.write(values)
            else:
                # Created directly and not through a command on the rule:
                # ir.actions.server refuses sudo commands, so a command would
                # run as the current user, who has no right on it.
                Action.create(
                    {
                        **values,
                        "state": "tuqui_notify",
                        "usage": "base_automation",
                        "base_automation_id": rule.id,
                    }
                )

    def _compute_action_server_ids(self):
        # The action of a Tuqui rule follows the rule's model on write (see
        # `write`); dropping it here would need rights the group lacks.
        tuqui_rules = self.filtered(lambda r: r._origin.id and r._origin._tuqui_notify_action())
        return super(BaseAutomation, self - tuqui_rules)._compute_action_server_ids()

    @api.onchange("trigger", "action_server_ids")
    def _onchange_trigger_or_actions(self):
        # It only reads the actions, to warn, and the group has no right on them.
        return super(BaseAutomation, self.sudo())._onchange_trigger_or_actions()

    def action_open_tuqui_agent(self):
        """Open the rule's agent in Tuqui, in a new tab."""
        self.ensure_one()
        return self._tuqui_notify_action().action_open_tuqui_agent()

    def _tuqui_notify_action(self):
        """The rule's single "Notify Tuqui" action, or an empty recordset."""
        self.ensure_one()
        actions = self.sudo().action_server_ids
        return actions if len(actions) == 1 and actions.state == "tuqui_notify" else actions.browse()

    # ---------- Default name ----------

    @api.onchange("tuqui_agent_id", "model_id", "trigger", "trigger_field_ids", "trg_date_id")
    def _onchange_tuqui_default_name(self):
        # Only a name this onchange wrote itself is replaced: a typed one stays.
        for rule in self:
            suggested = rule._tuqui_default_name()
            if suggested and (not rule.name or rule.name == rule.tuqui_default_name):
                rule.name = suggested
            rule.tuqui_default_name = suggested

    def _tuqui_default_name(self):
        """``Agent · Model · Trigger (fields)``, in the user's language.

        Only for rules with a Tuqui agent. The model joins when it is picked: the
        wizard presets agent and trigger, so the form opens already named.
        """
        self.ensure_one()
        if not (self.tuqui_agent_id and self.trigger):
            return False
        agents = dict(self._fields["tuqui_agent_id"]._description_selection(self.env))
        triggers = dict(self._fields["trigger"]._description_selection(self.env))
        when = triggers.get(self.trigger, self.trigger)
        fields_used = self.trigger_field_ids if self.trigger == "on_create_or_write" else self.trg_date_id
        if fields_used:
            when = f"{when} ({', '.join(fields_used.mapped('field_description'))})"
        parts = [agents.get(self.tuqui_agent_id, self.tuqui_agent_id), self.model_id.name, when]
        return " · ".join(part for part in parts if part)

    # ---------- Presets from the wizard ----------

    @api.depends("model_id")
    def _compute_trigger(self):
        super()._compute_trigger()
        if preset := self.env.context.get("tuqui_preset_trigger"):
            self.trigger = preset

    # ---------- CRUD ----------

    @api.model_create_multi
    def create(self, vals_list):
        # Other inverses write on the rule before the agent's one has created
        # its action: those writes must not be checked yet. A sentinel object
        # and not a flag, so that a client cannot send it in its context.
        creating = self.with_context(tuqui_automation_creating=_CREATING)
        rules = super(BaseAutomation, creating).create(vals_list).with_env(self.env)
        rules._tuqui_check_restricted()
        return rules

    def write(self, vals):
        was_tuqui = self.sudo().filtered("tuqui_agent_id").with_env(self.env)
        if "model_id" in vals:
            for rule in self:
                rule._tuqui_notify_action().write({"model_id": vals["model_id"]})
        res = super().write(vals)
        if "name" in vals:
            for rule in self:
                rule._tuqui_notify_action().write({"name": rule.name})
        if self.env.context.get("tuqui_automation_creating") is not _CREATING:
            (was_tuqui | self)._tuqui_check_restricted(was_tuqui)
        return res

    def copy(self, default=None):
        # The native copy duplicates the actions, and the group has no right on
        # them: a Tuqui trigger is created again with its agent, whose inverse
        # makes the action, and goes through the usual checks.
        if self._tuqui_is_admin() or not self.sudo().filtered("tuqui_agent_id"):
            return super().copy(default)
        vals_list = self.copy_data(default)
        for rule, vals in zip(self, vals_list):
            vals.setdefault("tuqui_agent_id", rule.tuqui_agent_id)
        return self.create(vals_list)

    def unlink(self):
        # The group may delete what it may edit, and nothing else.
        if not self._tuqui_is_admin():
            for rule in self.sudo():
                if rule.trigger not in ALLOWED_TRIGGERS:
                    raise ValidationError(_("Deleting this rule needs Odoo administrator rights."))
        return super().unlink()

    def _update_cron(self):
        # Global state: it has to see every time-based rule, not just the ones
        # the current user can read, and the group has no right on ir.cron.
        return super(BaseAutomation, self.sudo())._update_cron()

    def _update_registry(self):
        # Same reason: re-registering the hooks with only the rules this user
        # can read would unpatch every other automation of the worker.
        return super(BaseAutomation, self.sudo())._update_registry()

    @api.model
    def fields_get(self, allfields=None, attributes=None):
        res = super().fields_get(allfields, attributes)
        tuqui_form = self.env.context.get("tuqui_trigger_form")
        if tuqui_form and "selection" in res.get("trigger", {}) and not self._tuqui_is_admin():
            # Only in the Tuqui menu: users who reach the generic automations
            # through another module keep their full list.
            res["trigger"]["selection"] = [
                option for option in res["trigger"]["selection"] if option[0] in ALLOWED_TRIGGERS
            ]
        return res

    def _execute_webhook(self, payload):
        # /web/hook/<uuid> finds a rule by its uuid alone, whatever its trigger,
        # and the Tuqui group can read the uuid of its rules.
        if self.sudo().tuqui_agent_id:
            raise ValidationError(_("A Tuqui trigger cannot be fired from a URL."))
        return super()._execute_webhook(payload)

    # ---------- What a non-admin may save ----------

    @api.model
    def _tuqui_is_admin(self):
        # env.user, not env.su: the inverse and the hooks run in sudo, and they
        # must not turn a non-admin's save into an admin's one.
        return self.env.user.has_group("base.group_system")

    def _tuqui_check_restricted(self, was_tuqui=None):
        """No rule with an agent is a webhook; for a non-admin, a Tuqui trigger must stay one.

        The second part applies to the rules that have an agent, or had one before this write.
        Rules without an agent are left to whatever else grants access to them
        (another module's group, say): for a user who only has the Tuqui group,
        the record rule already refuses them.

        Called at the end of `create` and `write`, after the agent's inverse
        has run: an `@api.constrains` on stored fields runs inside `_create`,
        before inverses, and would see the rule without its action. Not a
        record rule alone either: in `write`, those are checked before the
        change, so they cannot stop a rule from being turned into another one.
        """
        if not self:
            return
        # Also for an admin: /web/hook never fires a rule with an agent (see
        # `_execute_webhook`), so such a rule would silently never run.
        if any(rule.trigger == "on_webhook" for rule in self.sudo().filtered("tuqui_agent_id")):
            raise ValidationError(
                _(
                    "A Tuqui trigger cannot be fired from a URL. To call the agent from outside, use its webhook in Tuqui."
                )
            )
        if self._tuqui_is_admin():
            return
        was_tuqui = was_tuqui or self.browse()
        for rule in self.sudo():
            if not rule.tuqui_agent_id and rule not in was_tuqui:
                continue
            if not rule.tuqui_agent_id:
                raise ValidationError(_("Without Odoo administrator rights, a Tuqui trigger cannot lose its agent."))
            actions = rule.action_server_ids
            if len(actions) != 1 or actions.state != "tuqui_notify" or actions.tuqui_agent_id != rule.tuqui_agent_id:
                raise ValidationError(_("A Tuqui trigger has exactly one action, and it notifies its agent."))
            if rule.trigger not in ALLOWED_TRIGGERS:
                raise ValidationError(
                    _(
                        "This kind of trigger needs Odoo administrator rights: %s",
                        dict(rule._fields["trigger"]._description_selection(self.env)).get(rule.trigger, rule.trigger),
                    )
                )
            # Never evaluated on a rule with an agent, but it would stay there if
            # an admin later turned the rule into a plain webhook.
            if rule.record_getter != rule.default_get(["record_getter"]).get("record_getter"):
                raise ValidationError(_("The code that fetches a webhook's record needs Odoo administrator rights."))
            if rule.trigger == "on_create_or_write" and not rule.trigger_field_ids:
                raise ValidationError(_("Choose at least one field to watch."))
            rule._tuqui_check_readable()

    def _tuqui_check_readable(self):
        """The current user must be able to read the model and every field used.

        The rule's domains are evaluated in sudo when it fires; without this, a
        trigger could be used to find out about data its author cannot see.
        """
        self.ensure_one()
        model = self.env[self.model_id.model].with_user(self.env.user).sudo(False)
        if model._transient or model._abstract or not model.browse().has_access("read"):
            raise ValidationError(_("You cannot read the model %s.", self.model_id.name))
        fields_used = self.trigger_field_ids | self.trg_date_id | self.trg_selection_field_id.field_id
        for field in fields_used:
            self._tuqui_check_field_path(model, field.name)
        for domain_field in ("filter_domain", "filter_pre_domain"):
            if self[domain_field]:
                self._tuqui_check_domain(model, self[domain_field])

    @api.model
    def _tuqui_check_field_path(self, model, path):
        """Raise unless ``model.env.user`` can read every model and field on ``path``."""
        names = path.split(".")
        for position, name in enumerate(names):
            field = model._fields.get(name)
            if not field:
                if position:
                    # e.g. `date_deadline.month_number`: a date part, not a field.
                    return
                raise ValidationError(_("Field %(field)s does not exist on %(model)s.", field=name, model=model._name))
            if not model.browse().has_access("read") or not model._has_field_access(field, "read"):
                raise ValidationError(_("You cannot read %(model)s.%(field)s.", model=model._name, field=name))
            if not field.relational:
                return
            model = model.env[field.comodel_name]

    @api.model
    def _tuqui_check_domain(self, model, domain):
        self._tuqui_check_domain_source(domain)
        try:
            parsed = Domain(safe_eval.safe_eval(domain, self._get_eval_context_for(model)))
        except Exception as exc:  # noqa: BLE001 - any parse error is a bad domain
            raise ValidationError(_("The domain is not valid: %s", exc)) from exc
        self._tuqui_check_domain_fields(model, parsed)

    @api.model
    def _tuqui_check_domain_source(self, domain):
        try:
            tree = ast.parse(domain.strip(), mode="eval")
        except SyntaxError as exc:
            raise ValidationError(_("The domain is not valid: %s", exc)) from exc
        for node in ast.walk(tree):
            if (
                not isinstance(node, DOMAIN_NODES)
                or (isinstance(node, ast.Name) and node.id not in DOMAIN_NAMES)
                or (isinstance(node, ast.Attribute) and node.attr not in DOMAIN_ATTRIBUTES)
            ):
                raise ValidationError(
                    _("A Tuqui trigger's domain can only compare fields with values, dates and the current user.")
                )

    @api.model
    def _tuqui_check_domain_fields(self, model, domain):
        for condition in domain.iter_conditions():
            self._tuqui_check_field_path(model, condition.field_expr)
            if condition.operator in ("any", "not any", "any!", "not any!"):
                field = model._fields.get(condition.field_expr.split(".")[0])
                if field and field.relational and isinstance(condition.value, (Domain, list, tuple)):
                    self._tuqui_check_domain_fields(model.env[field.comodel_name], Domain(condition.value))

    @api.model
    def _get_eval_context_for(self, model):
        return {
            "datetime": safe_eval.datetime,
            "dateutil": safe_eval.dateutil,
            "time": safe_eval.time,
            "uid": self.env.uid,
            "user": self.env.user,
            "model": model,
        }
