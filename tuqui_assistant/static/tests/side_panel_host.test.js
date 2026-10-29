import { describe, expect, test } from "@odoo/hoot";
import { makeSidePanelHost } from "@tuqui_assistant/embed/side_panel_host";

/**
 * This Odoo inside Tuqui's side panel: it sends its screen to the chat beside it
 * and marks what the chat points at, speaking only to the window that frames it.
 *
 * How to run them: see the header of `apply_proposal.test.js`.
 */

const TUQUI = "https://acme.tuqui.example";

function setup({ walk, dirty = false } = {}) {
    const sent = [];
    const pointed = [];
    const win = { parent: { postMessage: (data, origin) => sent.push({ data, origin }) } };
    let targets = [{ id: "t1", name: "Lotes", role: "checkbox" }];
    const assistant = {
        readScreen: () => ({ targets, elements: new Map() }),
        getContextPayload: (screen) => ({ kind: "record", model: "res.config.settings", targets: screen.targets }),
        rememberScreen: () => {},
        point: (payload) => pointed.push(payload),
        pointWhenThere: async (payload) => ({ status: "marked", places: [payload.section || ""], applied: [], skipped: [], message: "" }),
        state: { context: { kind: "record", dirty } },
        settleProposal: (proposalId, run) => run(),
    };
    const host = makeSidePanelHost(assistant, win, walk);
    const from = (data, origin = TUQUI, source = win.parent) => host.onMessage({ source, origin, data: { source: "tuqui-spa", ...data } });
    return { host, sent, pointed, from, setTargets: (t) => (targets = t), win };
}

describe("the screen, to the chat beside it", () => {
    test("nothing is sent before the chat says it is ready", () => {
        const { host, sent } = setup();
        host.post(true);
        expect(sent).toEqual([]);
    });

    test("on ready it sends the screen to that origin, announcing the walk and the drop by name", () => {
        const { sent, from } = setup();
        from({ type: "ready" });
        expect(sent).toHaveLength(1);
        expect(sent[0].origin).toBe(TUQUI);
        expect(sent[0].data.type).toBe("context");
        expect(sent[0].data.payload.capabilities).toEqual({ apply_result: ["show_me", "point"] });
        expect(sent[0].data.payload.targets[0].name).toBe("Lotes");
    });

    test("a screen that did not change is not sent again; one that did, is", () => {
        const { host, sent, from, setTargets } = setup();
        from({ type: "ready" });
        host.post();
        expect(sent).toHaveLength(1);
        setTargets([{ id: "t1", name: "Números de serie", role: "checkbox" }]);
        host.post();
        expect(sent).toHaveLength(2);
    });
});

describe("the drop, from the chat beside it", () => {
    test("a point from the parent marks the control", () => {
        const { pointed, from } = setup();
        from({ type: "ready" });
        from({ type: "point", payload: { target: "t1", name: "Lotes", role: "checkbox" } });
        expect(pointed).toEqual([{ target: "t1", name: "Lotes", role: "checkbox" }]);
    });

    test("a point by name is answered with what the screen had", async () => {
        const { pointed, sent, from } = setup();
        from({ type: "ready" });
        from({ type: "point", payload: { name: "Lotes", section: "Trazabilidad", proposalId: "p9" } });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(pointed).toEqual([]);
        const result = sent.find((m) => m.data.type === "apply-result");
        expect(result.origin).toBe(TUQUI);
        expect(result.data.payload).toEqual({
            proposalId: "p9",
            status: "marked",
            places: ["Trazabilidad"],
            applied: [],
            skipped: [],
            message: "",
        });
    });

    test("another window, or another origin than the ready one, is not heard", () => {
        const { pointed, sent, from } = setup();
        from({ type: "ready" }, TUQUI, {});
        expect(sent).toEqual([]);
        from({ type: "ready" });
        from({ type: "point", payload: { target: "t1" } }, "https://attacker.example");
        expect(pointed).toEqual([]);
    });
});

describe("the walk, asked by the chat beside it", () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

    test("each step goes to the chat, and how it ended comes back as apply-result", async () => {
        const walk = async (goal, ask) => {
            const decision = await ask({ goal, screen: {}, actions: [], history: [] });
            return { status: "arrived", reason: "", steps: [{ target: decision.choice, operation: "click", confidence: 0.9 }] };
        };
        const { sent, from } = setup({ walk });
        from({ type: "ready" });
        from({ type: "show-me", payload: { goal: "los lotes", proposalId: "p1" } });
        await tick();
        const step = sent.find((m) => m.data.type === "show-me-step");
        expect(step.origin).toBe(TUQUI);
        expect(step.data.payload).toEqual({ goal: "los lotes", screen: {}, actions: [], history: [], proposal_id: "p1" });
        from({ type: "show-me-step-result", id: step.data.id, ok: true, result: { choice: "a3" } });
        await tick();
        const result = sent.find((m) => m.data.type === "apply-result");
        expect(result.data.payload).toEqual({
            proposalId: "p1",
            status: "arrived",
            applied: [],
            skipped: [],
            message: null,
            steps: [{ choice: "a3", operation: "click", confidence: 0.9 }],
        });
    });

    test("a form with unsaved changes is not walked: the walk would save it", async () => {
        let walked = false;
        const { sent, from } = setup({ dirty: true, walk: async () => ((walked = true), { status: "arrived", steps: [] }) });
        from({ type: "ready" });
        from({ type: "show-me", payload: { goal: "g", proposalId: "p2" } });
        await tick();
        expect(walked).toBe(false);
        expect(sent.find((m) => m.data.type === "apply-result").data.payload.status).toBe("stopped");
    });

    test("a walk from another origin is not run", async () => {
        let walked = false;
        const { from } = setup({ walk: async () => ((walked = true), { status: "arrived", steps: [] }) });
        from({ type: "ready" });
        from({ type: "show-me", payload: { goal: "g", proposalId: "p3" } }, "https://attacker.example");
        await tick();
        expect(walked).toBe(false);
    });
});
