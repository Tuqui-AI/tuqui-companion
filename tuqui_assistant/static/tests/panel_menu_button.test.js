/** @odoo-module **/
import { after, beforeEach, describe, expect, test } from "@odoo/hoot";
import { click } from "@odoo/hoot-dom";
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
 * The logo in the panel header is the SPA's conversations menu: the
 * panel declares it, so the SPA drops its own button, the logo asks the SPA to
 * toggle the menu, and the first two opens show the logo turning into the menu
 * icon so people learn it is there.
 */
describe("the logo is the conversations menu", () => {
    const BASE = "https://menu.tuqui.example.com";
    let assistant;
    let posted;

    beforeEach(async () => {
        posted = [];
        localStorage.removeItem("tuqui_menu_hint_shown");
        after(() => localStorage.removeItem("tuqui_menu_hint_shown"));
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
    });

    async function openAndGreet() {
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

    const hinting = () =>
        document.querySelector(".o-tuqui-menu-toggle").classList.contains("o-tuqui-menu-hint");

    test("the context tells the SPA the header has the menu button", async () => {
        await openAndGreet();
        const context = posted.find((p) => p.message.type === "context");
        expect(context.message.payload.capabilities.menu_button).toBe(true);
    });

    test("the logo asks the SPA to open or close its menu", async () => {
        await openAndGreet();
        await click(".o-tuqui-menu-toggle");
        await animationFrame();
        expect(posted.filter((p) => p.message.type === "toggle-menu")).toEqual([
            { message: { source: "tuqui-odoo", type: "toggle-menu" }, targetOrigin: BASE },
        ]);
    });

    test("the name still opens Tuqui, not the menu", async () => {
        const opened = [];
        patchWithCleanup(window, { open: (url) => opened.push(url) });
        await openAndGreet();
        await click(".o-tuqui-title");
        expect(opened.length).toBe(1);
        expect(posted.filter((p) => p.message.type === "toggle-menu")).toEqual([]);
    });

    test("the logo shows it is the menu on the first two opens only", async () => {
        const seen = [];
        for (let open = 0; open < 3; open++) {
            await openAndGreet();
            seen.push(hinting());
            assistant.close();
            await animationFrame();
        }
        expect(seen).toEqual([true, true, false]);
    });
});
