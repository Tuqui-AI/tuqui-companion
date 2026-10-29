/** @odoo-module **/
import { beforeEach, describe, expect, test } from "@odoo/hoot";
import { advanceTime, animationFrame } from "@odoo/hoot-mock";
import { MainComponentsContainer } from "@web/core/main_components_container";
import {
    defineModels,
    fields,
    getService,
    models,
    mountView,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
} from "@web/../tests/web_test_helpers";
import { TuquiPanel } from "@tuqui_assistant/panel/panel";

/**
 * The result of a proposal goes back to the SPA (`apply-result`), so the
 * assistant knows whether its change is on screen before it says "done".
 *
 * How to run them: see the header of `apply_proposal.test.js`.
 */

class Partner extends models.Model {
    _name = "res.partner";
    name = fields.Char();
    email = fields.Char();
    _records = [
        { id: 1, name: "Acme", email: "acme@example.com" },
        { id: 2, name: "Beta" },
    ];
}
defineModels([Partner]);

const FORM_ARCH = `<form><field name="name"/><field name="email"/></form>`;

async function mountPartnerForm(resId = 1) {
    await mountView({ type: "form", resModel: "res.partner", resId, arch: FORM_ARCH });
    return getService("tuquiAssistant");
}

describe("target of a form proposal", () => {
    test("a proposal for another record is rejected and touches nothing", async () => {
        const assistant = await mountPartnerForm(1);
        const result = await assistant.applyProposal(
            { name: "For Beta" },
            { target: { model: "res.partner", resId: 2 } }
        );
        expect(result.status).toBe("rejected");
        expect(result.reason).toBe("other_record");
        expect(result.applied).toEqual([]);
        expect(result.skipped).toEqual([]);
        expect(result.message).toInclude("another record");
        await animationFrame();
        expect(".o_field_widget[name=name] input").toHaveValue("Acme");
        expect(assistant.getActiveRecord().dirty).toBe(false);
    });

    test("another model with the same id is another record too", async () => {
        const assistant = await mountPartnerForm(1);
        const result = await assistant.applyProposal(
            { name: "X" },
            { target: { model: "crm.lead", resId: 1 } }
        );
        expect(result.reason).toBe("other_record");
    });

    test("a proposal for the open record is applied", async () => {
        const assistant = await mountPartnerForm(1);
        const result = await assistant.applyProposal(
            { name: "Acme SA" },
            { target: { model: "res.partner", resId: 1 } }
        );
        expect(result.status).toBe("applied");
        expect(result.applied).toEqual(["name"]);
        expect(result.skipped).toEqual([]);
    });

    test("a new record saved mid-turn is still the proposal's record", async () => {
        // The turn started on a new form (no resId) and the assistant saved it.
        const assistant = await mountPartnerForm(1);
        const result = await assistant.applyProposal(
            { name: "Acme SA" },
            { target: { model: "res.partner", resId: false } }
        );
        expect(result.status).toBe("applied");
    });

    test("an empty proposal is not reported as applied", async () => {
        const assistant = await mountPartnerForm(1);
        const result = await assistant.applyProposal({}, { target: { model: "res.partner", resId: 1 } });
        expect(result.status).toBe("rejected");
        expect(result.reason).toBe("invalid_proposal");
    });

    test("without target (old SPA) it applies as before", async () => {
        const assistant = await mountPartnerForm(1);
        const result = await assistant.applyProposal({ name: "Acme SA" });
        expect(result.status).toBe("applied");
    });

    test("with no form open it is rejected with a reason", async () => {
        await mountWithCleanup(MainComponentsContainer);
        const result = await getService("tuquiAssistant").applyProposal({ name: "X" });
        expect(result.status).toBe("rejected");
        expect(result.reason).toBe("no_record");
    });
});

describe("chatter proposal", () => {
    let assistant;
    let opened;
    beforeEach(async () => {
        assistant = await mountPartnerForm(1);
        opened = 0;
        patchWithCleanup(getService("action"), {
            doAction: async () => {
                opened++;
            },
        });
    });

    test("opens the composer and says opened, not posted", async () => {
        const result = await assistant.proposeChatter({
            body: "<p>Hola</p>",
            target: { model: "res.partner", resId: 1 },
        });
        expect(result.status).toBe("opened");
        expect(opened).toBe(1);
    });

    test("while its composer is open, the page knows the chat opened that dialog", async () => {
        // On a phone the panel covers the screen: this mark keeps the composer above it.
        let options;
        patchWithCleanup(getService("action"), {
            doAction: async (_action, opts) => {
                options = opts;
            },
        });
        await assistant.proposeChatter({ body: "<p>Hola</p>", target: { model: "res.partner", resId: 1 } });
        expect(document.documentElement).toHaveClass("o-tuqui-chat-dialog");
        options.onClose({ dismiss: true });
        expect(document.documentElement).not.toHaveClass("o-tuqui-chat-dialog");
    });

    test("a message for another record is rejected and opens nothing", async () => {
        const result = await assistant.proposeChatter({
            body: "<p>Hola</p>",
            target: { model: "res.partner", resId: 2 },
        });
        expect(result.status).toBe("rejected");
        expect(result.reason).toBe("other_record");
        expect(opened).toBe(0);
    });
});

describe("idempotency by proposalId", () => {
    test("a proposalId already settled is not run again: its result is repeated", async () => {
        await mountWithCleanup(MainComponentsContainer);
        const assistant = getService("tuquiAssistant");
        let runs = 0;
        const run = async () => {
            runs++;
            return { status: "applied", applied: ["name"], skipped: [], message: "" };
        };
        const first = await assistant.settleProposal("p-1", run);
        const again = await assistant.settleProposal("p-1", run);
        expect(runs).toBe(1);
        expect(again).toEqual(first);
    });

    test("a duplicate that arrives mid-apply waits for the same result", async () => {
        await mountWithCleanup(MainComponentsContainer);
        const assistant = getService("tuquiAssistant");
        let runs = 0;
        let release;
        const run = () => {
            runs++;
            return new Promise((resolve) => (release = resolve));
        };
        const a = assistant.settleProposal("p-2", run);
        const b = assistant.settleProposal("p-2", run);
        // settleProposal starts `run` on a microtask.
        await Promise.resolve();
        release({ status: "applied", applied: [], skipped: [], message: "" });
        expect(await a).toEqual(await b);
        expect(runs).toBe(1);
    });

    test("the memory is bounded: an old proposalId runs again", async () => {
        await mountWithCleanup(MainComponentsContainer);
        const assistant = getService("tuquiAssistant");
        let runs = 0;
        const run = async () => {
            runs++;
            return { status: "applied", applied: [], skipped: [], message: "" };
        };
        await assistant.settleProposal("old", run);
        for (let i = 0; i < 50; i++) {
            await assistant.settleProposal(`p-${i}`, async () => ({ status: "applied" }));
        }
        await assistant.settleProposal("old", run);
        expect(runs).toBe(2);
    });

    test("a run that throws settles as rejected, not as a hang", async () => {
        await mountWithCleanup(MainComponentsContainer);
        const result = await getService("tuquiAssistant").settleProposal("p-err", () => {
            throw new Error("boom");
        });
        expect(result.status).toBe("rejected");
        expect(result.reason).toBe("error");
    });
});

describe("the panel answers apply-result", () => {
    const BASE = "https://results.tuqui.example.com";
    let assistant;
    let posted;
    let applyCalls;

    beforeEach(async () => {
        posted = [];
        applyCalls = [];
        onRpc("tuqui.assistant.sso.nonce", "embed_bootstrap", () => ({
            connected: true,
            base_url: BASE,
            slug: "acme",
        }));
        onRpc("tuqui.assistant.sso.nonce", "issue_for_current_user", () => ({
            nonce: "n1",
            client_id: "cid",
        }));
        patchWithCleanup(TuquiPanel.prototype, {
            get embedUrl() {
                return "about:blank";
            },
        });
        await mountWithCleanup(MainComponentsContainer);
        assistant = getService("tuquiAssistant");
        patchWithCleanup(assistant, {
            async applyProposal(changes, options) {
                applyCalls.push({ changes, options });
                return { status: "applied", applied: Object.keys(changes), skipped: [], message: "ok" };
            },
        });
        assistant.toggleVisibility();
        await animationFrame();
        const win = document.querySelector(".o-tuqui-iframe").contentWindow;
        win.postMessage = (message, targetOrigin) => posted.push({ message, targetOrigin });
    });

    async function spaSends(data, origin = BASE) {
        window.dispatchEvent(
            new MessageEvent("message", {
                data: { source: "tuqui-spa", ...data },
                origin,
                source: document.querySelector(".o-tuqui-iframe").contentWindow,
            })
        );
        await animationFrame();
    }

    const results = () => posted.filter((p) => p.message.type === "apply-result");

    test("an apply with proposalId is answered with its result", async () => {
        const target = { model: "res.partner", resId: 1 };
        await spaSends({
            type: "apply",
            payload: { proposalId: "p-1", changes: { name: "X" }, baseRevision: 3, target },
        });
        expect(applyCalls).toEqual([{ changes: { name: "X" }, options: { baseRevision: 3, target } }]);
        expect(results()).toEqual([
            {
                message: {
                    source: "tuqui-odoo",
                    type: "apply-result",
                    payload: {
                        proposalId: "p-1",
                        status: "applied",
                        applied: ["name"],
                        skipped: [],
                        message: "ok",
                    },
                },
                targetOrigin: BASE,
            },
        ]);
    });

    test("a replayed proposalId is not applied twice, and the same result is repeated", async () => {
        const msg = { type: "apply", payload: { proposalId: "p-dup", changes: { name: "X" } } };
        await spaSends(msg);
        await spaSends(msg);
        expect(applyCalls).toHaveLength(1);
        expect(results()).toHaveLength(2);
        expect(results()[1].message.payload).toEqual(results()[0].message.payload);
    });

    test("a walk asked for while the panel is minimized is not run", async () => {
        assistant.minimize();
        await animationFrame();
        await spaSends({ type: "show-me", payload: { proposalId: "p-walk", goal: "Llevame al inventario" } });
        const [result] = results();
        expect(result.message.payload.status).toBe("stopped");
        expect(result.message.payload.message).toInclude("minimized");
        expect(posted.some((p) => p.message.type === "show-me-step")).toBe(false);
    });

    test("without proposalId (old SPA) it applies and answers nothing", async () => {
        await spaSends({ type: "apply", payload: { changes: { name: "X" } } });
        expect(applyCalls).toHaveLength(1);
        expect(results()).toHaveLength(0);
    });

    test("a form kind it does not know is rejected as unsupported, untouched", async () => {
        await spaSends({
            type: "apply",
            payload: { proposalId: "p-html", kind: "some_future_kind", changes: { name: "X" } },
        });
        expect(applyCalls).toHaveLength(0);
        expect(results()[0].message.payload).toEqual({
            proposalId: "p-html",
            status: "rejected",
            applied: [],
            skipped: [],
            reason: "unsupported",
            message: results()[0].message.payload.message,
        });
    });

    test("an html co-edit is answered as form_html, with or without the kind", async () => {
        const htmlBase = { comment: "<p>a</p>" };
        await spaSends({
            type: "apply",
            payload: { proposalId: "p-h1", changes: { comment: "<p>b</p>" }, htmlBase },
        });
        await spaSends({
            type: "apply",
            payload: {
                proposalId: "p-h2",
                kind: "form_html",
                changes: {},
                selection: { field: "comment", html: "<p>c</p>", expectedText: "a" },
            },
        });
        expect(applyCalls).toHaveLength(2);
        expect(applyCalls[0].options.htmlBase).toEqual(htmlBase);
        expect(applyCalls[1].options.selection.field).toBe("comment");
        expect(results().map((r) => r.message.payload.status)).toEqual(["applied", "applied"]);
    });

    test("a message type it does not know, with proposalId, is unsupported", async () => {
        await spaSends({ type: "some-new-proposal", payload: { proposalId: "p-new" } });
        expect(results()).toHaveLength(1);
        expect(results()[0].message.payload.reason).toBe("unsupported");
    });

    test("a point with proposalId is looked for by name and answered with what was found", async () => {
        patchWithCleanup(assistant, {
            pointWhenThere: async (payload) => ({ status: "ambiguous", places: ["A", "B"], applied: [], skipped: [], message: "", asked: payload }),
        });
        await spaSends({ type: "point", payload: { proposalId: "p-pt", name: "Importar" } });
        const [answer] = results();
        expect(answer.message.payload.status).toBe("ambiguous");
        expect(answer.message.payload.places).toEqual(["A", "B"]);
        expect(answer.message.payload.asked.name).toBe("Importar");
    });

    test("a message from another origin gets no answer", async () => {
        await spaSends(
            { type: "apply", payload: { proposalId: "p-x", changes: { name: "X" } } },
            "https://evil.example.com"
        );
        expect(applyCalls).toHaveLength(0);
        expect(results()).toHaveLength(0);
    });

    test("a chatter with no form open is answered rejected", async () => {
        await spaSends({ type: "chatter", payload: { proposalId: "p-chat", body: "<p>x</p>" } });
        expect(results()[0].message.payload.status).toBe("rejected");
        expect(results()[0].message.payload.reason).toBe("no_record");
    });

    test("auth and every context announce what the host answers", async () => {
        await spaSends({ type: "ready" });
        await animationFrame();
        const capabilities = {
            apply_result: ["form_changes", "form_html", "chatter", "show_me", "point", "wait_step"],
            navigate: ["record", "new", "browse", "action"],
            menu_button: true,
        };
        const auth = posted.find((p) => p.message.type === "auth");
        expect(auth.message.payload.capabilities).toEqual(capabilities);
        const contexts = posted.filter((p) => p.message.type === "context");
        expect(contexts.length).toBeGreaterThan(0);
        for (const ctx of contexts) {
            expect(ctx.message.payload.capabilities).toEqual(capabilities);
        }
    });
});
