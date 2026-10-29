/** @odoo-module **/
import { beforeEach, describe, expect, test } from "@odoo/hoot";
import { animationFrame } from "@odoo/hoot-mock";
import { MainComponentsContainer } from "@web/core/main_components_container";
import {
    getService,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
} from "@web/../tests/web_test_helpers";
import { TuquiPanel } from "@tuqui_assistant/panel/panel";

/**
 * The panel tells the SPA whether the card is docked or floating.
 *
 * The SPA shows its menu button only on a docked card and hides it on the small
 * floating one. It cannot work that out from its own width (a docked card on a
 * 1366px screen is narrower than the floating one), so the host has to say it,
 * and say it again whenever it changes.
 */
describe("the panel tells the SPA its layout", () => {
    const BASE = "https://layout.tuqui.example.com";
    let assistant;
    let posted;
    let phone;

    beforeEach(() => {
        posted = [];
        phone = false;
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
        const realMatchMedia = window.matchMedia.bind(window);
        patchWithCleanup(window, {
            matchMedia(query) {
                if (query === "(max-width: 575.98px)") {
                    return { matches: phone, addEventListener() {}, removeEventListener() {} };
                }
                return realMatchMedia(query);
            },
        });
    });

    async function openPanel() {
        await mountWithCleanup(MainComponentsContainer);
        assistant = getService("tuquiAssistant");
        assistant.toggleVisibility();
        await animationFrame();
        const win = document.querySelector(".o-tuqui-iframe").contentWindow;
        win.postMessage = (message, targetOrigin) => posted.push({ message, targetOrigin });
        window.dispatchEvent(
            new MessageEvent("message", {
                data: { source: "tuqui-spa", type: "ready" },
                origin: BASE,
                source: win,
            })
        );
        await animationFrame();
    }

    const layouts = () =>
        posted.filter((p) => p.message.type === "layout").map((p) => p.message.payload.docked);

    test("a floating card says so on ready", async () => {
        await openPanel();
        expect(layouts()).toEqual([false]);
        expect(posted.find((p) => p.message.type === "layout").targetOrigin).toBe(BASE);
    });

    test("expanding and contracting say it again", async () => {
        await openPanel();
        assistant.expand();
        await animationFrame();
        assistant.contract();
        await animationFrame();
        expect(layouts()).toEqual([false, true, false]);
    });

    test("on a phone the card fills the screen, so it counts as docked", async () => {
        phone = true;
        await openPanel();
        expect(layouts()).toEqual([true]);
    });
});
