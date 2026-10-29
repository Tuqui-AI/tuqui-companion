import { describe, expect, test } from "@odoo/hoot";
import { animationFrame } from "@odoo/hoot-mock";
import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import {
    contains,
    defineModels,
    fields,
    getService,
    models,
    mountView,
    patchWithCleanup,
} from "@web/../tests/web_test_helpers";

/**
 * The "New" button of the Tuqui triggers list opens the card wizard, and each
 * card opens the automation form with its trigger (and the agent) preset.
 *
 * How to run: see `.github/workflows/js-tests.yml`, with the tag
 * `[@tuqui_automation]`.
 */

class BaseAutomation extends models.Model {
    _name = "base.automation";

    name = fields.Char();

    _records = [{ id: 1, name: "Lead changes stage" }];
}

// base_automation depends on mail, whose patches need its models.
defineMailModels();
defineModels([BaseAutomation]);

const LIST_ARCH = `<list js_class="tuqui_trigger_list"><field name="name"/></list>`;

describe("tuqui trigger wizard", () => {
    test("New opens three cards, and a card presets the form", async () => {
        await mountView({
            type: "list",
            resModel: "base.automation",
            arch: LIST_ARCH,
            context: { default_tuqui_agent_id: "agent-1" },
        });
        patchWithCleanup(getService("action"), {
            doAction(action) {
                expect.step([action.res_model, action.context]);
                return Promise.resolve(true);
            },
        });

        await contains(".o_list_button_add").click();
        await animationFrame();
        expect(".o_tuqui_trigger_card").toHaveCount(3);

        await contains(".o_tuqui_trigger_card[data-trigger='on_create_or_write']").click();
        await animationFrame();
        expect(".o_tuqui_trigger_card").toHaveCount(0);
        expect.verifySteps([
            [
                "base.automation",
                {
                    tuqui_preset_trigger: "on_create_or_write",
                    tuqui_trigger_form: 1,
                    default_tuqui_agent_id: "agent-1",
                },
            ],
        ]);
    });

    test("without an agent, the form gets only the trigger", async () => {
        await mountView({ type: "list", resModel: "base.automation", arch: LIST_ARCH });
        patchWithCleanup(getService("action"), {
            doAction(action) {
                expect.step(action.context);
                return Promise.resolve(true);
            },
        });

        await contains(".o_list_button_add").click();
        await contains(".o_tuqui_trigger_card[data-trigger='on_time']").click();
        expect.verifySteps([{ tuqui_preset_trigger: "on_time", tuqui_trigger_form: 1 }]);
    });
});
