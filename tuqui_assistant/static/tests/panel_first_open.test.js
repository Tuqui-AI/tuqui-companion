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
import { user } from "@web/core/user";
import { TuquiPanel } from "@tuqui_assistant/panel/panel";

/**
 * First open of the panel: the SSO nonce is minted when the panel OPENS, in
 * parallel with the iframe load, not when the SPA says "ready". Still ONE per
 * open: the nonce is single-use, and a second one gets spent twice → 401 → the
 * SPA logs the user out.
 *
 * The iframe points to `about:blank`: it inherits the page origin, so its
 * `postMessage` can be spied on and the test does not need a running SPA.
 *
 * How to run them: see the header of `apply_proposal.test.js`.
 */

class Partner extends models.Model {
    _name = "res.partner";
    name = fields.Char();
    _records = [{ id: 1, name: "Acme" }];
}
defineModels([Partner]);

// Same value as EMBED_HANDSHAKE_TIMEOUT_MS in panel.js.
const HANDSHAKE_TIMEOUT_MS = 12000;

describe("SSO nonce on first open", () => {
    const BASE = "https://sso.tuqui.example.com";
    let assistant;
    let issued;
    let nonces;
    let posted;

    beforeEach(async () => {
        issued = 0;
        // What each nonce request returns, in order. `null` = it failed.
        nonces = [{ nonce: "n1", client_id: "cid" }, { nonce: "n2", client_id: "cid" }];
        posted = [];
        onRpc("tuqui.assistant.sso.nonce", "embed_bootstrap", () => ({
            connected: true,
            base_url: BASE,
            slug: "acme",
        }));
        onRpc("tuqui.assistant.sso.nonce", "issue_for_current_user", () => nonces[issued++]);
        patchWithCleanup(TuquiPanel.prototype, {
            get embedUrl() {
                return "about:blank";
            },
        });
        await mountWithCleanup(MainComponentsContainer);
        assistant = getService("tuquiAssistant");
    });

    async function open() {
        assistant.toggleVisibility();
        await animationFrame();
        const win = document.querySelector(".o-tuqui-iframe").contentWindow;
        win.postMessage = (message, targetOrigin) => posted.push({ message, targetOrigin });
    }

    async function spaSaysReady() {
        window.dispatchEvent(
            new MessageEvent("message", {
                data: { source: "tuqui-spa", type: "ready" },
                origin: BASE,
                source: document.querySelector(".o-tuqui-iframe").contentWindow,
            })
        );
        await animationFrame();
    }

    const authsPosted = () => posted.filter((p) => p.message.type === "auth");
    const noncesPosted = () => authsPosted().map((p) => p.message.payload.nonce);

    test("is requested on open, without waiting for the SPA's ready", async () => {
        await open();
        expect(issued).toBe(1);
        expect(authsPosted()).toHaveLength(0);

        await spaSaysReady();
        expect(issued).toBe(1);
        expect(authsPosted()).toEqual([
            {
                message: {
                    source: "tuqui-odoo",
                    type: "auth",
                    payload: {
                        client_id: "cid",
                        nonce: "n1",
                        capabilities: {
                            apply_result: ["form_changes", "form_html", "chatter", "show_me", "point", "wait_step"],
                            navigate: ["record", "new", "browse", "action"],
                            menu_button: true,
                        },
                        lang: user.lang,
                    },
                },
                targetOrigin: BASE,
            },
        ]);
    });

    test("several ready messages do not spend a second nonce", async () => {
        // The SPA says ready more than once (the gate, the chat page, re-renders).
        await open();
        await spaSaysReady();
        await spaSaysReady();
        await spaSaysReady();
        expect(issued).toBe(1);
        expect(authsPosted()).toHaveLength(1);
    });

    test("a ready that arrives while the nonce is in flight waits for it", async () => {
        let release;
        nonces[0] = new Promise((resolve) => (release = resolve));
        await open();
        await spaSaysReady();
        await spaSaysReady();
        expect(authsPosted()).toHaveLength(0);

        release({ nonce: "n1", client_id: "cid" });
        await animationFrame();
        expect(issued).toBe(1);
        expect(noncesPosted()).toEqual(["n1"]);
    });

    test("when the nonce did not come, the next ready mints a fresh one", async () => {
        nonces[0] = null;
        await open();
        await spaSaysReady();
        expect(authsPosted()).toHaveLength(0);

        await spaSaysReady();
        expect(issued).toBe(2);
        expect(noncesPosted()).toEqual(["n2"]);
    });

    test("a ready after the handshake timeout mints a fresh nonce", async () => {
        // The pre-minted nonce may be past its TTL by then: posting it would 401.
        await open();
        await advanceTime(HANDSHAKE_TIMEOUT_MS);
        await spaSaysReady();
        expect(issued).toBe(2);
        expect(noncesPosted()).toEqual(["n2"]);
    });

    test("a failure to open is not shown again on the next open", async () => {
        await open();
        window.dispatchEvent(
            new MessageEvent("message", {
                data: { source: "tuqui-spa", type: "error" },
                origin: BASE,
                source: document.querySelector(".o-tuqui-iframe").contentWindow,
            })
        );
        await animationFrame();
        expect(".o-tuqui-blocked").toHaveText(/Tuqui could not open/);
        // Closed (a restored state, or 20.0's close button) and opened again.
        assistant.state.panelOpen = false;
        await animationFrame();
        await open();
        // The reset runs in an effect after the render: one more frame to show it.
        await animationFrame();
        expect(".o-tuqui-blocked").toHaveCount(0);
    });

    test("hiding and showing again does not request another nonce", async () => {
        // Hiding does not unmount the iframe: the session it redeemed stays alive.
        await open();
        await spaSaysReady();
        assistant.minimize();
        await animationFrame();
        assistant.toggleVisibility();
        await animationFrame();
        await spaSaysReady();
        expect(issued).toBe(1);
        expect(authsPosted()).toHaveLength(1);
    });
});

describe("without Tuqui connected", () => {
    test("opening the panel requests no nonce: there is no iframe to use it", async () => {
        let issued = 0;
        onRpc("tuqui.assistant.sso.nonce", "embed_bootstrap", () => ({
            connected: false,
            base_url: null,
            slug: null,
        }));
        onRpc("tuqui.assistant.sso.nonce", "issue_for_current_user", () => {
            issued++;
            return null;
        });
        await mountWithCleanup(MainComponentsContainer);
        getService("tuquiAssistant").toggleVisibility();
        await animationFrame();
        await animationFrame();
        expect(".o-tuqui-iframe").toHaveCount(0);
        expect(issued).toBe(0);
    });
});
