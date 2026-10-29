import json
from urllib.parse import parse_qs, urlparse

from odoo import Command
from odoo.addons.tuqui.controllers.oauth import _issue_access_token
from odoo.tests import HttpCase, tagged

AGENT = "11111111-1111-1111-1111-111111111111"
# Another agent for the link tests, so their rule does not count in the anti-loop one.
LINK_AGENT = "33333333-3333-3333-3333-333333333333"


@tagged("post_install", "-at_install", "tuqui")
class TestTuquiTriggersHttp(HttpCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.designer = cls.env["res.users"].create(
            {
                "name": "Agent Designer",
                "login": "tuqui_http_designer",
                "password": "tuqui_http_designer",
                "group_ids": [
                    Command.set(
                        [
                            cls.env.ref("base.group_user").id,
                            cls.env.ref("base.group_partner_manager").id,
                            cls.env.ref("tuqui_automation.group_tuqui_triggers").id,
                        ]
                    )
                ],
            }
        )
        cls.plain_user = cls.env["res.users"].create(
            {
                "name": "Plain User",
                "login": "tuqui_http_plain",
                "password": "tuqui_http_plain",
                "group_ids": [Command.set([cls.env.ref("base.group_user").id])],
            }
        )
        cls.rule = (
            cls.env["base.automation"]
            .with_user(cls.designer)
            .create(
                {
                    "name": "New partner",
                    "model_id": cls.env["ir.model"]._get("res.partner").id,
                    "trigger": "on_create",
                    "tuqui_agent_id": LINK_AGENT,
                }
            )
            .sudo()
        )

    def tearDown(self):
        # Rules patch the models they watch; Odoo's test checker refuses leftovers.
        self.env["base.automation"]._unregister_hook()
        super().tearDown()

    # ---------- The public webhook of automation rules ----------

    def _post_webhook(self, uuid, record):
        body = json.dumps({"_model": record._name, "_id": record.id})
        return self.url_open(f"/web/hook/{uuid}", data=body, headers={"Content-Type": "application/json"})

    def test_the_public_webhook_does_not_fire_a_tuqui_trigger(self):
        # The designer can read the uuid of its rule, and /web/hook finds a rule
        # by its uuid alone, whatever its trigger or domain.
        uuid = self.rule.with_user(self.designer).read(["webhook_uuid"])[0]["webhook_uuid"]
        partner = self.env["res.partner"].create({"name": "Not created through the rule"})
        response = self._post_webhook(uuid, partner)
        self.assertNotEqual(response.status_code, 200)
        events = self.env["tuqui.event"].sudo().search([("agent_external_id", "=", LINK_AGENT)])
        self.assertFalse(events)

    def test_the_public_webhook_still_runs_a_plain_rule(self):
        partner = self.env["res.partner"].create({"name": "Hooked"})
        partner_model = self.env["ir.model"]._get("res.partner")
        rule = self.env["base.automation"].create(
            {
                "name": "Admin webhook",
                "model_id": partner_model.id,
                "trigger": "on_webhook",
                "action_server_ids": [
                    Command.create(
                        {
                            "name": "Mark",
                            "model_id": partner_model.id,
                            "state": "code",
                            "code": "record.write({'comment': 'hooked'})",
                        }
                    )
                ],
            }
        )
        response = self._post_webhook(rule.webhook_uuid, partner)
        self.assertEqual(response.status_code, 200, response.text)
        partner.invalidate_recordset()
        self.assertIn("hooked", partner.comment or "")

    def _assert_friendly_page(self, response):
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("have access to Tuqui triggers", response.text)
        self.assertIn("Manage agent triggers", response.text)
        self.assertIn('href="/odoo"', response.text)

    # ---------- /tuqui/triggers/new ----------

    def test_new_trigger_redirects_to_the_wizard_with_the_agent(self):
        self.authenticate("tuqui_http_designer", "tuqui_http_designer")
        response = self.url_open(f"/tuqui/triggers/new?agent_id={AGENT}", allow_redirects=False)
        self.assertIn(response.status_code, (302, 303))
        location = urlparse(response.headers["Location"])
        self.assertEqual(location.path, "/odoo/tuqui-new-trigger")
        self.assertEqual(parse_qs(location.query), {"agent_id": [AGENT]})

    def test_new_trigger_without_agent_opens_the_bare_wizard(self):
        self.authenticate("tuqui_http_designer", "tuqui_http_designer")
        response = self.url_open("/tuqui/triggers/new", allow_redirects=False)
        self.assertEqual(urlparse(response.headers["Location"]).path, "/odoo/tuqui-new-trigger")

    def test_new_trigger_asks_to_log_in_without_a_session(self):
        response = self.url_open(f"/tuqui/triggers/new?agent_id={AGENT}", allow_redirects=False)
        self.assertIn(response.status_code, (302, 303))
        self.assertEqual(urlparse(response.headers["Location"]).path, "/web/login")

    def test_new_trigger_without_the_group_shows_a_friendly_page(self):
        self.authenticate("tuqui_http_plain", "tuqui_http_plain")
        response = self.url_open(f"/tuqui/triggers/new?agent_id={AGENT}", allow_redirects=False)
        self._assert_friendly_page(response)

    # ---------- /tuqui/triggers/<id> ----------

    def test_a_rule_link_opens_the_tuqui_form(self):
        self.authenticate("tuqui_http_designer", "tuqui_http_designer")
        response = self.url_open(f"/tuqui/triggers/{self.rule.id}", allow_redirects=False)
        self.assertIn(response.status_code, (302, 303))
        self.assertEqual(urlparse(response.headers["Location"]).path, f"/odoo/tuqui-triggers/{self.rule.id}")

    def test_a_rule_link_without_the_group_shows_a_friendly_page(self):
        self.authenticate("tuqui_http_plain", "tuqui_http_plain")
        response = self.url_open(f"/tuqui/triggers/{self.rule.id}", allow_redirects=False)
        self._assert_friendly_page(response)

    def test_a_rule_link_the_user_cannot_read_shows_a_friendly_page(self):
        foreign = self.env["base.automation"].create(
            {"name": "Admin rule", "model_id": self.env["ir.model"]._get("res.partner").id, "trigger": "on_create"}
        )
        self.authenticate("tuqui_http_designer", "tuqui_http_designer")
        for rule_id in (foreign.id, 0, 999999999):
            response = self.url_open(f"/tuqui/triggers/{rule_id}", allow_redirects=False)
            self._assert_friendly_page(response)

    def test_the_url_opens_the_list_with_the_wizard_and_a_card_opens_the_form(self):
        code = """
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const waitFor = async (selector, count = 1) => {
                for (let i = 0; i < 150; i++) {
                    if (document.querySelectorAll(selector).length === count) {
                        return true;
                    }
                    await sleep(100);
                }
                throw new Error(`${selector} did not show up`);
            };
            (async () => {
                await waitFor(".o_list_view");
                await waitFor(".o_tuqui_trigger_card", 3);
                document.querySelector(".o_tuqui_trigger_card[data-trigger='on_create_or_write']").click();
                await waitFor(".o_form_view .o_field_widget[name='model_id']");
                console.log("test successful");
            })().catch((error) => console.error(error.message));
        """
        self.browser_js(f"/tuqui/triggers/new?agent_id={AGENT}", code, login="tuqui_http_designer")

    # ---------- Anti-loop through /tuqui/rpc ----------

    def test_a_write_from_the_agent_run_does_not_notify_that_agent(self):
        lead_model = self.env["ir.model"]._get("res.partner")
        stage_a, stage_b = self.env["res.partner.industry"].create([{"name": "A"}, {"name": "B"}])
        lead = self.env["res.partner"].create({"name": "Partner", "industry_id": stage_a.id})
        self.env["base.automation"].with_user(self.designer).create(
            {
                "name": "Stage changes",
                "model_id": lead_model.id,
                "trigger": "on_create_or_write",
                "trigger_field_ids": [Command.set(self.env["ir.model.fields"]._get("res.partner", "industry_id").ids)],
                "tuqui_agent_id": AGENT,
            }
        )
        client, _created = self.env["tuqui.oauth.client"].sudo()._get_or_create_singleton()
        client.write({"read_only": False})
        token = _issue_access_token(self.env, client.client_id)
        Event = self.env["tuqui.event"].sudo()

        def write_stage(stage, agent_header):
            headers = {
                "X-Odoo-Database": self.env.cr.dbname,
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "X-Tuqui-Acting-Uid": str(self.designer.id),
            }
            if agent_header:
                headers["X-Tuqui-Agent-Id"] = agent_header
            body = {"model": "res.partner", "method": "write", "args": [[lead.id], {"industry_id": stage.id}]}
            response = self.url_open("/tuqui/rpc", data=json.dumps(body), headers=headers)
            self.assertEqual(response.status_code, 200, response.text)
            return Event.search_count(
                [("res_model", "=", "res.partner"), ("res_id", "=", lead.id), ("agent_external_id", "=", AGENT)]
            )

        self.assertEqual(write_stage(stage_b, AGENT), 0)
        self.assertEqual(write_stage(stage_a, "22222222-2222-2222-2222-222222222222"), 1)
        self.assertEqual(write_stage(stage_b, None), 2)
