import { registry } from "@web/core/registry";
import { session } from "@web/session";
import { isGotaMutation } from "@tuqui_assistant/screen/gota";
import { showMe } from "@tuqui_assistant/show_me/show_me";
import { makeWalkSession, readProposalId } from "@tuqui_assistant/show_me/walk_session";

/**
 * This Odoo shown in Tuqui's side panel: the same messages as the embed, with the
 * roles swapped. There Odoo frames the chat; here the chat frames Odoo.
 *
 *   Odoo → SPA: { source: "tuqui-odoo", type: "hello" }               // no data, so "*" is safe
 *               { source: "tuqui-odoo", type: "context", payload: PageContext }
 *               { source: "tuqui-odoo", type: "show-me-step", id, payload: { goal, screen, actions, history } }
 *               { source: "tuqui-odoo", type: "apply-result", payload: { proposalId, status, ... } }
 *   SPA → Odoo: { source: "tuqui-spa",  type: "ready" }               // fixes the origin
 *               { source: "tuqui-spa",  type: "point", payload: { target, name, role } }
 *               { source: "tuqui-spa",  type: "point", payload: { name, section, proposalId } }   // answered in apply-result
 *               { source: "tuqui-spa",  type: "show-me", payload: { goal, proposalId } }
 *               { source: "tuqui-spa",  type: "show-me-step-result", id, ok, result | error }
 *
 * Only the panel session (`tuqui_embed_panel`, set by `tuqui_embed`) opens it, and
 * only the parent window is heard: `tuqui_embed`'s frame-ancestors already limits
 * who that parent can be. The proposals announced are the walk (`show_me`) and the
 * drop by name (`point`): the chat is not inside this Odoo, so it never edits forms here.
 */

const SETTLE_MS = 400;

export function makeSidePanelHost(assistant, win = window, walk = showMe) {
    let origin = null;
    let posted = null;
    const walks = makeWalkSession({
        post: (id, payload) => win.parent.postMessage({ source: "tuqui-odoo", type: "show-me-step", id, payload }, origin),
        getContext: () => assistant.state.context,
        walk,
    });

    /** Send the screen when it changed, or always when `force`. */
    function post(force = false) {
        // The walk moves its cursor every few ms, and each step already carries the screen.
        if (!origin || walks.walking) {
            return;
        }
        const screen = assistant.readScreen();
        const payload = { capabilities: { apply_result: ["show_me", "point"] }, ...assistant.getContextPayload(screen) };
        const key = JSON.stringify(payload);
        // Same list or not, the elements behind the ids may be new nodes.
        assistant.rememberScreen(screen);
        if (force || key !== posted) {
            win.parent.postMessage({ source: "tuqui-odoo", type: "context", payload }, origin);
            posted = key;
        }
    }

    async function onShowMe(data) {
        const proposalId = readProposalId(data);
        if (!proposalId) {
            return;
        }
        const result = await assistant.settleProposal(proposalId, () => walks.run(data.payload?.goal, proposalId, { menu: data.payload?.menu }));
        win.parent.postMessage({ source: "tuqui-odoo", type: "apply-result", payload: { proposalId, ...result } }, origin);
        post(true);
    }

    async function onPoint(data) {
        const proposalId = readProposalId(data);
        if (!proposalId) {
            assistant.point(data.payload || {});
            return;
        }
        const result = await assistant.settleProposal(proposalId, () => assistant.pointWhenThere(data.payload || {}));
        win.parent.postMessage({ source: "tuqui-odoo", type: "apply-result", payload: { proposalId, ...result } }, origin);
    }

    function onMessage(event) {
        const data = event.data;
        if (event.source !== win.parent || data?.source !== "tuqui-spa") {
            return;
        }
        if (data.type === "ready") {
            // A new ready is a chat that reloaded: a walk it asked for has nobody to answer it.
            walks.dispose("the chat reloaded");
            origin = event.origin;
            post(true);
            return;
        }
        if (!origin || event.origin !== origin) {
            return;
        }
        if (data.type === "point") {
            onPoint(data);
        } else if (data.type === "show-me") {
            onShowMe(data);
        } else if (data.type === "show-me-step-result") {
            walks.onStepResult(data);
        }
    }

    return { onMessage, post };
}

export const sidePanelHostService = {
    dependencies: ["tuquiAssistant"],
    start(env, { tuquiAssistant }) {
        if (!session.tuqui_embed_panel || window.parent === window) {
            return;
        }
        const host = makeSidePanelHost(tuquiAssistant);
        window.addEventListener("message", host.onMessage);
        let timer = null;
        new MutationObserver((records) => {
            // The drop re-aims every 300 ms: counting it would never let the screen settle.
            if (records.every(isGotaMutation)) {
                return;
            }
            clearTimeout(timer);
            timer = setTimeout(() => host.post(), SETTLE_MS);
        }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
        // The SPA's "ready" can arrive before this listener exists: ask for it again.
        window.parent.postMessage({ source: "tuqui-odoo", type: "hello" }, "*");
    },
};

registry.category("services").add("tuquiSidePanelHost", sidePanelHostService);
