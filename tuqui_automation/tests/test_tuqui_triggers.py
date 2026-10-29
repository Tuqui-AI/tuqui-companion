from unittest.mock import patch

from lxml import etree
from odoo import Command
from odoo.exceptions import AccessError, ValidationError
from odoo.tests import Form, TransactionCase, tagged, users
from odoo.tools.safe_eval import safe_eval

AGENT = "11111111-1111-1111-1111-111111111111"
OTHER_AGENT = "22222222-2222-2222-2222-222222222222"


@tagged("post_install", "-at_install", "tuqui")
class TestTuquiTriggers(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.lead_model = cls.env["ir.model"]._get("res.partner")
        cls.group = cls.env.ref("tuqui_automation.group_tuqui_triggers")
        contacts = cls.env.ref("base.group_partner_manager")
        cls.designer = cls.env["res.users"].create(
            {
                "name": "Agent Designer",
                "login": "tuqui_trigger_designer",
                "group_ids": [Command.set([cls.env.ref("base.group_user").id, contacts.id, cls.group.id])],
            }
        )
        cls.admin = cls.env["res.users"].create(
            {
                "name": "Odoo Admin",
                "login": "tuqui_trigger_admin",
                "group_ids": [Command.set([cls.env.ref("base.group_system").id, contacts.id])],
            }
        )
        cls.stage_new, cls.stage_won = cls.env["res.partner.industry"].create([{"name": "Fresh"}, {"name": "Closed"}])
        cls.lead = cls.env["res.partner"].create({"name": "Watched partner", "industry_id": cls.stage_new.id})
        # A rule an admin made, with a code action: not a Tuqui trigger.
        cls.foreign_rule = cls.env["base.automation"].create(
            {
                "name": "Admin rule",
                "model_id": cls.lead_model.id,
                "trigger": "on_create",
                "action_server_ids": [
                    Command.create(
                        {"name": "Code", "model_id": cls.lead_model.id, "state": "code", "code": "records.name"}
                    )
                ],
            }
        )
        cls.code_action = cls.foreign_rule.action_server_ids

    def tearDown(self):
        # Rules patch the models they watch; Odoo's test checker refuses leftovers.
        self.env["base.automation"]._unregister_hook()
        super().tearDown()

    def _stage_rule_values(self, **overrides):
        values = {
            "name": "Lead changes stage",
            "model_id": self.lead_model.id,
            "trigger": "on_create_or_write",
            "trigger_field_ids": [Command.set(self.env["ir.model.fields"]._get("res.partner", "industry_id").ids)],
            "tuqui_agent_id": AGENT,
        }
        values.update(overrides)
        return values

    def _create_as_designer(self, **overrides):
        return self.env["base.automation"].with_user(self.designer).create(self._stage_rule_values(**overrides))

    def _lead_events(self, lead=None):
        # Filtered by agent: the database may already have other rules on leads.
        lead = lead or self.lead
        return (
            self.env["tuqui.event"]
            .sudo()
            .search(
                [
                    ("res_model", "=", "res.partner"),
                    ("res_id", "=", lead.id),
                    ("agent_external_id", "in", (AGENT, OTHER_AGENT)),
                ]
            )
        )

    def _assert_refused(self, call):
        """Refused either by the ACL or by the rule check: both leave nothing behind."""
        try:
            with self.env.cr.savepoint():
                call()
        except (AccessError, ValidationError):
            self.env.invalidate_all()
            return
        self.fail("The call was not refused")

    # ---------- The happy path ----------

    def test_designer_creates_a_stage_rule_and_moving_the_lead_queues_an_event(self):
        rule = self._create_as_designer()
        self.assertEqual(rule.tuqui_agent_id, AGENT)
        action = rule.sudo().action_server_ids
        self.assertEqual(len(action), 1)
        self.assertEqual(
            (action.state, action.tuqui_agent_id, action.usage), ("tuqui_notify", AGENT, "base_automation")
        )

        self.lead.with_user(self.designer).write({"industry_id": self.stage_won.id})
        events = self._lead_events()
        self.assertEqual(len(events), 1)
        payload = events._payload()
        self.assertEqual(payload["agent_id"], AGENT)
        self.assertEqual(payload["automation"], {"id": rule.id, "name": "Lead changes stage"})

    def test_writing_another_field_does_not_queue(self):
        self._create_as_designer()
        self.lead.with_user(self.designer).write({"comment": "<p>unrelated</p>"})
        self.assertFalse(self._lead_events())

    def test_the_designer_sees_only_tuqui_rules(self):
        rule = self._create_as_designer()
        visible = self.env["base.automation"].with_user(self.designer).search([])
        self.assertIn(rule, visible)
        self.assertNotIn(self.foreign_rule, visible)
        self.assertTrue(all(visible.mapped("tuqui_agent_id")))

    def test_changing_the_agent_updates_the_same_action(self):
        rule = self._create_as_designer()
        action = rule.sudo().action_server_ids
        rule.with_user(self.designer).write({"tuqui_agent_id": OTHER_AGENT, "name": "Renamed"})
        self.assertEqual(rule.sudo().action_server_ids, action)
        self.assertEqual((action.tuqui_agent_id, action.name), (OTHER_AGENT, "Renamed"))

    def test_the_designer_can_delete_its_rule(self):
        rule = self._create_as_designer()
        action = rule.sudo().action_server_ids
        rule.with_user(self.designer).unlink()
        self.assertFalse(action.exists())

    def test_on_time_rule_is_created_by_the_designer_and_activates_the_cron(self):
        cron = self.env.ref("base_automation.ir_cron_data_base_automation_check")
        cron.active = False
        self.env["base.automation"].search(
            [("trigger", "in", ("on_time", "on_time_created", "on_time_updated"))]
        ).active = False
        rule = self._create_as_designer(
            trigger="on_time",
            trigger_field_ids=[Command.clear()],
            trg_date_id=self.env["ir.model.fields"]._get("res.partner", "create_date").id,
            trg_date_range=1,
            trg_date_range_type="day",
            trg_date_range_mode="after",
        )
        self.assertEqual(rule.trigger, "on_time")
        self.assertTrue(cron.active)

    def test_the_form_presets_the_trigger_and_the_agent(self):
        Automation = self.env["base.automation"].with_user(self.designer)
        context = {"tuqui_preset_trigger": "on_create", "default_tuqui_agent_id": AGENT, "tuqui_trigger_form": 1}
        with Form(Automation.with_context(**context)) as form:
            form.name = "From the wizard"
            form.model_id = self.lead_model
            self.assertEqual(form.trigger, "on_create")
            self.assertEqual(form.tuqui_agent_id, AGENT)
        rule = form.record
        self.assertEqual((rule.trigger, rule.tuqui_agent_id), ("on_create", AGENT))
        self.assertEqual(rule.sudo().action_server_ids.state, "tuqui_notify")

    def _agent_choices(self):
        return patch(
            "odoo.addons.tuqui.models.ir_actions_server.IrActionsServer._tuqui_agent_choices",
            return_value=[(AGENT, "Contact sorter")],
        )

    def test_the_form_names_the_rule_after_agent_model_and_trigger(self):
        Automation = self.env["base.automation"].with_user(self.designer)
        context = {
            "tuqui_preset_trigger": "on_create_or_write",
            "default_tuqui_agent_id": AGENT,
            "tuqui_trigger_form": 1,
        }
        industry = self.env["ir.model.fields"]._get("res.partner", "industry_id")
        with self._agent_choices(), Form(Automation.with_context(**context)) as form:
            # Named on open, from the wizard's presets, before any model.
            self.assertEqual(form.name, f"Contact sorter · {self._trigger_label('on_create_or_write')}")
            form.model_id = self.lead_model
            form.trigger_field_ids.add(industry)
            self.assertEqual(
                form.name,
                f"Contact sorter · {self.lead_model.name} · {self._trigger_label('on_create_or_write')} ({industry.field_description})",
            )
            # Changing the watched field follows, because the name is still the suggested one.
            form.trigger_field_ids.remove(industry.id)
            form.trigger_field_ids.add(self.env["ir.model.fields"]._get("res.partner", "category_id"))
            self.assertIn(self.env["ir.model.fields"]._get("res.partner", "category_id").field_description, form.name)

    def test_a_typed_name_is_never_replaced(self):
        Automation = self.env["base.automation"].with_user(self.designer)
        context = {"tuqui_preset_trigger": "on_create", "default_tuqui_agent_id": AGENT, "tuqui_trigger_form": 1}
        with self._agent_choices(), Form(Automation.with_context(**context)) as form:
            form.model_id = self.lead_model
            form.name = "My own name"
            form.trigger = "on_create_or_write"
            form.trigger_field_ids.add(self.env["ir.model.fields"]._get("res.partner", "industry_id"))
            self.assertEqual(form.name, "My own name")

    def _trigger_label(self, trigger):
        return dict(self.env["base.automation"]._fields["trigger"]._description_selection(self.env))[trigger]

    # ---------- Code hidden in the rule ----------

    def test_a_domain_cannot_run_code(self):
        system = self.env.ref("base.group_system")
        evil = f"[('id', '=', user.write({{'group_ids': [(4, {system.id})]}}) and 0)]"
        self._assert_refused(lambda: self._create_as_designer(filter_domain=evil))
        self.assertFalse(self.designer.has_group("base.group_system"))
        rule = self._create_as_designer()
        for field in ("filter_domain", "filter_pre_domain"):
            self._assert_refused(lambda field=field: rule.with_user(self.designer).write({field: evil}))
        self._assert_refused(
            lambda: rule.with_user(self.designer).write(
                {"filter_domain": "[('id', 'in', model.sudo().search([]).ids)]"}
            )
        )
        self.assertFalse(self.designer.has_group("base.group_system"))

    def test_a_domain_can_use_dates_and_uid(self):
        relative = (
            "[('create_date', '>=', (datetime.datetime.now() - dateutil.relativedelta.relativedelta(days=7))"
            ".strftime('%Y-%m-%d')), ('user_id', '=', uid)]"
        )
        self.assertTrue(self._create_as_designer(filter_domain=relative))

    def test_the_designer_cannot_set_code_to_fetch_records(self):
        self._assert_refused(lambda: self._create_as_designer(record_getter="model.browse(1)"))

    def test_the_designer_cannot_delete_a_rule_it_cannot_edit(self):
        webhook = self.env["base.automation"].create(
            {"name": "Admin trigger", "model_id": self.lead_model.id, "trigger": "on_unlink", "tuqui_agent_id": AGENT}
        )
        self._assert_refused(lambda: webhook.with_user(self.designer).unlink())
        self.assertTrue(webhook.exists())

    def test_the_designer_is_only_offered_allowed_triggers(self):
        Automation = self.env["base.automation"].with_context(tuqui_trigger_form=1)
        selection = dict(Automation.with_user(self.designer).fields_get(["trigger"])["trigger"]["selection"])
        self.assertIn("on_create_or_write", selection)
        for trigger in ("on_webhook", "on_change", "on_unlink", "on_message_received"):
            self.assertNotIn(trigger, selection)
        admin_selection = dict(Automation.with_user(self.admin).fields_get(["trigger"])["trigger"]["selection"])
        self.assertIn("on_webhook", admin_selection)

    # ---------- The permission hole ----------

    def test_the_designer_cannot_read_or_write_a_foreign_rule(self):
        rule = self.foreign_rule.with_user(self.designer)
        with self.assertRaises(AccessError):
            rule.read(["name"])
        with self.assertRaises(AccessError):
            rule.write({"name": "Hijacked"})

    def test_the_designer_cannot_create_or_edit_server_actions(self):
        Action = self.env["ir.actions.server"].with_user(self.designer)
        with self.assertRaises(AccessError):
            Action.create({"name": "Mine", "model_id": self.lead_model.id, "state": "code", "code": "1"})
        with self.assertRaises(AccessError):
            self.code_action.with_user(self.designer).write({"name": "Hijacked"})

    def test_the_designer_cannot_turn_its_notify_action_into_something_else(self):
        rule = self._create_as_designer()
        action = rule.sudo().action_server_ids.with_user(self.designer)
        with self.assertRaises(AccessError):
            action.write({"state": "object_write", "update_path": "name", "value": "x"})
        with self.assertRaises(AccessError):
            rule.with_user(self.designer).write(
                {"action_server_ids": [Command.update(action.id, {"state": "object_write"})]}
            )

    def test_the_designer_cannot_add_another_action_to_its_rule(self):
        rule = self._create_as_designer().with_user(self.designer)
        self._assert_refused(lambda: rule.write({"action_server_ids": [Command.link(self.code_action.id)]}))
        self.assertEqual(self.code_action.base_automation_id, self.foreign_rule)
        more = {"name": "More", "model_id": self.lead_model.id, "state": "code", "code": "records.name"}
        self._assert_refused(lambda: rule.write({"action_server_ids": [Command.create(more)]}))
        self.assertEqual(len(rule.sudo().action_server_ids), 1)

    def test_the_designer_cannot_create_a_rule_with_a_foreign_action(self):
        self._assert_refused(lambda: self._create_as_designer(action_server_ids=[Command.link(self.code_action.id)]))
        self.assertEqual(self.code_action.base_automation_id, self.foreign_rule)

    def test_the_designer_cannot_use_forbidden_triggers(self):
        rule = self._create_as_designer()
        for trigger in ("on_webhook", "on_change", "on_unlink"):
            with self.subTest(trigger=trigger), self.assertRaises(ValidationError):
                rule.with_user(self.designer).write({"trigger": trigger})
        with self.assertRaises(ValidationError):
            self._create_as_designer(trigger="on_webhook", trigger_field_ids=[Command.clear()])

    def test_the_designer_cannot_remove_the_agent(self):
        rule = self._create_as_designer()
        with self.assertRaises(ValidationError):
            rule.with_user(self.designer).write({"tuqui_agent_id": False})
        self._assert_refused(
            lambda: self.env["base.automation"]
            .with_user(self.designer)
            .create({"name": "No agent", "model_id": self.lead_model.id, "trigger": "on_create"})
        )

    def test_a_field_change_rule_needs_a_watched_field(self):
        with self.assertRaises(ValidationError):
            self._create_as_designer(trigger_field_ids=[Command.clear()])

    def test_the_designer_cannot_use_fields_it_cannot_read(self):
        # `res.users.presence_ids` is restricted to administrators.
        user_model = self.env["ir.model"]._get("res.users")
        with self.assertRaises(ValidationError):
            self._create_as_designer(
                model_id=user_model.id,
                trigger="on_create",
                trigger_field_ids=[Command.clear()],
                filter_domain="[('presence_ids', '!=', False)]",
            )
        with self.assertRaises(ValidationError):
            self._create_as_designer(filter_domain="[('user_id.presence_ids', '!=', False)]")
        with self.assertRaises(ValidationError):
            self._create_as_designer(filter_pre_domain="[('user_id', 'any', [('presence_ids', '!=', False)])]")
        with self.assertRaises(ValidationError):
            self._create_as_designer(
                model_id=user_model.id,
                trigger_field_ids=[Command.set(self.env["ir.model.fields"]._get("res.users", "presence_ids").ids)],
            )
        # A readable domain is fine.
        self._create_as_designer(filter_domain="[('user_id.name', '!=', False)]")

    def test_the_designer_cannot_target_a_model_it_cannot_read(self):
        with self.assertRaises(ValidationError):
            self._create_as_designer(
                model_id=self.env["ir.model"]._get("ir.config_parameter").id,
                trigger="on_create",
                trigger_field_ids=[Command.clear()],
            )

    def test_another_module_granting_automations_is_left_alone(self):
        """A non-admin who edits automations through another module's group
        (like the AI apps do) keeps doing so: the Tuqui checks only touch
        Tuqui triggers."""
        other = self.env["res.groups"].create({"name": "Other automation module"})
        self.env["ir.model.access"].create(
            [
                {
                    "name": f"other {model}",
                    "model_id": self.env["ir.model"]._get(model).id,
                    "group_id": other.id,
                    "perm_read": True,
                    "perm_write": True,
                    "perm_create": True,
                    "perm_unlink": True,
                }
                for model in ("base.automation", "ir.actions.server")
            ]
        )
        other_user = self.env["res.users"].create(
            {
                "name": "Other module user",
                "login": "tuqui_trigger_other",
                "group_ids": [Command.set([self.env.ref("base.group_user").id, other.id])],
            }
        )
        rule = (
            self.env["base.automation"]
            .with_user(other_user)
            .create(
                {
                    "name": "Plain rule",
                    "model_id": self.lead_model.id,
                    "trigger": "on_unlink",
                    "action_server_ids": [
                        Command.create({"name": "Log", "model_id": self.lead_model.id, "state": "object_write"})
                    ],
                }
            )
        )
        self.assertFalse(rule.tuqui_agent_id)
        rule.with_user(other_user).write({"name": "Still plain", "trigger": "on_create"})
        selection = dict(
            self.env["base.automation"].with_user(other_user).fields_get(["trigger"])["trigger"]["selection"]
        )
        self.assertIn("on_webhook", selection)

    # ---------- Admins ----------

    @users("tuqui_trigger_admin")
    def test_an_admin_can_do_everything(self):
        Automation = self.env["base.automation"]
        self.assertIn(self.foreign_rule, Automation.search([]))
        rule = Automation.create(self._stage_rule_values())
        rule.write({"trigger": "on_unlink"})
        rule.write(
            {
                "action_server_ids": [
                    Command.create(
                        {"name": "Code", "model_id": self.lead_model.id, "state": "code", "code": "records.name"}
                    )
                ]
            }
        )
        # Two actions: it is no longer a Tuqui trigger, and that is allowed.
        self.assertFalse(rule.tuqui_agent_id)
        rule.write({"trigger": "on_webhook", "record_getter": "model.browse(1)"})
        self.foreign_rule.write({"name": "Edited by admin"})

    def test_a_rule_with_an_agent_is_never_a_webhook_even_for_an_admin(self):
        Automation = self.env["base.automation"].with_user(self.admin)
        self._assert_refused(
            lambda: Automation.create(
                self._stage_rule_values(trigger="on_webhook", trigger_field_ids=[Command.clear()])
            )
        )
        rule = Automation.create(self._stage_rule_values())
        self._assert_refused(lambda: rule.write({"trigger": "on_webhook"}))
        self.assertEqual(rule.trigger, "on_create_or_write")

    def test_an_admin_writes_domains_as_in_plain_odoo(self):
        Automation = self.env["base.automation"].with_user(self.admin)
        for overrides in (
            {"filter_domain": "[('name', '=', user.company_id.name)]"},
            {"filter_pre_domain": "[('name', '=', model.search([], limit=1).name)]"},
            {"record_getter": "model.browse(1)"},
        ):
            with self.subTest(**overrides):
                rule = Automation.create(self._stage_rule_values(**overrides))
                self.assertEqual(rule.tuqui_agent_id, AGENT)

    def test_the_designer_can_change_the_trigger_and_copy_its_rule(self):
        rule = self._create_as_designer()
        with Form(rule.with_user(self.designer).with_context(tuqui_trigger_form=1)) as form:
            form.trigger = "on_create"
        self.assertEqual(rule.trigger, "on_create")
        copy = rule.with_user(self.designer).copy()
        self.assertEqual(copy.tuqui_agent_id, AGENT)
        action = copy.sudo().action_server_ids
        self.assertEqual((action.state, action.tuqui_agent_id), ("tuqui_notify", AGENT))
        self.assertNotEqual(action, rule.sudo().action_server_ids)
        self._assert_refused(lambda: self.foreign_rule.with_user(self.designer).copy())

    def test_an_agent_on_a_rule_with_other_actions_is_refused_even_for_an_admin(self):
        with self.assertRaises(ValidationError):
            self.foreign_rule.with_user(self.admin).write({"tuqui_agent_id": AGENT})
        self.assertEqual(self.foreign_rule.action_server_ids, self.code_action)

    def test_an_existing_notify_rule_gets_its_agent_computed(self):
        rule = self.env["base.automation"].create(
            {
                "name": "Old Notify Tuqui rule",
                "model_id": self.lead_model.id,
                "trigger": "on_create",
                "action_server_ids": [
                    Command.create(
                        {
                            "name": "Notify",
                            "model_id": self.lead_model.id,
                            "state": "tuqui_notify",
                            "tuqui_agent_id": AGENT,
                        }
                    )
                ],
            }
        )
        self.assertEqual(rule.tuqui_agent_id, AGENT)
        self.assertIn(rule, self.env["base.automation"].with_user(self.designer).search([]))

    # ---------- Screens ----------

    def _form_modifiers(self, **context):
        """The agent field and the actions page of the rule form, as the designer gets it."""
        view = self.env["base.automation"].with_user(self.designer).with_context(**context).get_view(view_type="form")
        arch = etree.fromstring(view["arch"])
        field = arch.xpath("//field[@name='tuqui_agent_id']")[0]
        page = arch.xpath("//page[@name='actions']")
        return field, page[0] if page else None

    @staticmethod
    def _eval(node, attribute, tuqui_agent_id, context):
        expression = node.get(attribute) if node is not None else None
        return bool(expression and safe_eval(expression, {"tuqui_agent_id": tuqui_agent_id, "context": context}))

    def test_the_tuqui_form_always_asks_for_the_agent_and_never_shows_the_actions(self):
        context = {"tuqui_trigger_form": 1}
        field, _page = self._form_modifiers(**context)
        self.assertFalse(self._eval(field, "invisible", False, context))
        self.assertTrue(self._eval(field, "required", False, context))
        # The designer does not even get the page; an admin gets it hidden.
        admin_view = (
            self.env["base.automation"].with_user(self.admin).with_context(**context).get_view(view_type="form")
        )
        page = etree.fromstring(admin_view["arch"]).xpath("//page[@name='actions']")[0]
        for agent in (False, AGENT):
            self.assertTrue(self._eval(page, "invisible", agent, context))

    def test_the_native_form_shows_the_agent_only_on_a_rule_that_has_it(self):
        admin_view = self.env["base.automation"].with_user(self.admin).get_view(view_type="form")
        arch = etree.fromstring(admin_view["arch"])
        field = arch.xpath("//field[@name='tuqui_agent_id']")[0]
        # The group around the field and its "Open in Tuqui" button decides.
        box = field.xpath("ancestor::group[@invisible][1]")[0]
        page = arch.xpath("//page[@name='actions']")[0]
        self.assertTrue(self._eval(box, "invisible", False, {}))
        self.assertFalse(self._eval(box, "invisible", AGENT, {}))
        self.assertFalse(self._eval(field, "required", False, {}))
        self.assertFalse(self._eval(page, "invisible", False, {}))
        self.assertTrue(self._eval(page, "invisible", AGENT, {}))

    def test_the_tuqui_search_filter_finds_rules_that_notify_tuqui(self):
        multi_step = self.env["base.automation"].create(
            {
                "name": "Code, then notify",
                "model_id": self.lead_model.id,
                "trigger": "on_create",
                "action_server_ids": [
                    Command.create(
                        {"name": "Code", "model_id": self.lead_model.id, "state": "code", "code": "records.name"}
                    ),
                    Command.create(
                        {
                            "name": "Notify",
                            "model_id": self.lead_model.id,
                            "state": "tuqui_notify",
                            "tuqui_agent_id": AGENT,
                        }
                    ),
                ],
            }
        )
        self.assertFalse(multi_step.tuqui_agent_id)
        search_arch = etree.fromstring(self.env["base.automation"].get_view(view_type="search")["arch"])
        domain = safe_eval(search_arch.xpath("//filter[@name='tuqui']")[0].get("domain"))
        found = self.env["base.automation"].with_user(self.admin).with_context(active_test=False).search(domain)
        self.assertIn(multi_step, found)
        self.assertNotIn(self.foreign_rule, found)

    def test_the_rule_button_opens_its_agent_in_tuqui(self):
        self.env["ir.config_parameter"].sudo().set_param("tuqui.base_url", "https://tuqui.com")
        client = self.env["tuqui.oauth.client"].sudo()._get_or_create_singleton()[0]
        client.write({"workspace_id_external": "acme-sa"})
        rule = self._create_as_designer().with_user(self.designer)
        action = rule.action_open_tuqui_agent()
        self.assertEqual((action["type"], action["target"]), ("ir.actions.act_url", "new"))
        self.assertEqual(action["url"], f"https://tuqui.com/w/acme-sa/agents/{AGENT}/edit?tab=channels")

    # ---------- Anti-loop ----------

    def test_a_write_by_the_same_agent_does_not_queue_but_another_agent_does(self):
        self._create_as_designer()
        lead = self.lead.with_user(self.designer)
        lead.with_context(tuqui_agent_run_id=AGENT).write({"industry_id": self.stage_won.id})
        self.assertFalse(self._lead_events())
        lead.with_context(tuqui_agent_run_id=OTHER_AGENT).write({"industry_id": self.stage_new.id})
        self.assertEqual(len(self._lead_events()), 1)
