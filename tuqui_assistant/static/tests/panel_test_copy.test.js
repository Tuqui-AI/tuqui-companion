/** @odoo-module **/
import { beforeEach, describe, expect, test } from "@odoo/hoot";
import { advanceTime, animationFrame } from "@odoo/hoot-mock";
import { MainComponentsContainer } from "@web/core/main_components_container";
import {
    defineModels,
    fields,
    getService,
    models,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
} from "@web/../tests/web_test_helpers";
import { TuquiPanel } from "@tuqui_assistant/panel/panel";

/**
 * A copy of a connected database registers as a test database when the panel
 * opens. Never while the page loads: the panel is mounted on every backend page
 * and its bootstrap holds the web client until it answers.
 *
 * How to run them: see the header of `apply_proposal.test.js`.
 */

class Partner extends models.Model {
    _name = "res.partner";
    name = fields.Char();
    _records = [{ id: 1, name: "Acme" }];
}
defineModels([Partner]);

describe("test database copy", () => {
    let booted;
    let registered;
    let verified;
    let answer;
    let answers;

    beforeEach(async () => {
        booted = 0;
        registered = 0;
        verified = false;
        answer = { status: "pending" };
        answers = [];
        onRpc("tuqui.assistant.sso.nonce", "embed_bootstrap", () => {
            booted++;
            return verified
                ? { connected: true, copy_pending: false, base_url: "https://tuqui.example.com", slug: "acme" }
                : { connected: false, copy_pending: true, base_url: "https://tuqui.example.com", slug: false };
        });
        onRpc("tuqui.assistant.sso.nonce", "register_test_copy", () => {
            registered++;
            const given = answers.shift() || answer;
            verified = given.status === "registered";
            return given;
        });
        onRpc("tuqui.assistant.sso.nonce", "issue_for_current_user", () => null);
        patchWithCleanup(TuquiPanel.prototype, {
            get embedUrl() {
                return "about:blank";
            },
        });
        await mountWithCleanup(MainComponentsContainer);
    });

    async function open() {
        getService("tuquiAssistant").toggleVisibility();
        // bootstrap, registration and bootstrap again, one after the other
        for (let i = 0; i < 4; i++) {
            await animationFrame();
        }
    }

    test("loading a page does not register it", async () => {
        expect(booted).toBe(1);
        expect(registered).toBe(0);
    });

    test("opening the panel registers it, and says it is connecting", async () => {
        await open();
        expect(registered).toBe(1);
        expect(".o-tuqui-disconnected").toHaveText(/copy of one connected/);
        expect(".o-tuqui-disconnected").toHaveText(/connecting it as a test database/i);
    });

    test("a refused registration says so", async () => {
        answer = { status: "failed", error: "HTTP 409" };
        await open();
        expect(".o-tuqui-disconnected").toHaveText(/could not connect/i);
    });

    test("the open panel asks again until Tuqui verified it", async () => {
        answers = [{ status: "pending" }, { status: "registered" }];
        await open();
        expect(".o-tuqui-iframe").toHaveCount(0);

        await advanceTime(3000);
        for (let i = 0; i < 4; i++) {
            await animationFrame();
        }
        expect(registered).toBe(2);
        expect(".o-tuqui-iframe").toHaveCount(1);
    });

    test("once Tuqui verified it, the panel opens connected", async () => {
        answer = { status: "registered" };
        await open();
        expect(registered).toBe(1);
        expect(".o-tuqui-iframe").toHaveCount(1);
    });
});
