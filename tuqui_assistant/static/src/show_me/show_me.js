import { registry } from "@web/core/registry";
import { delay } from "@web/core/utils/concurrency";
import { createPilot } from "@tuqui_assistant/show_me/pilot_ui";
import { walkMenu } from "@tuqui_assistant/show_me/menu_walk";
import { isReachable, knowMenus, observe } from "@tuqui_assistant/show_me/screen_actions";

/**
 * "Show me how": Tuqui walks the screen to a goal while the person
 * watches. Each step, this page describes what can be done, `ask` gets back the
 * next action (Tuqui's backend asks the judgment model: the key never comes here),
 * a cursor travels there and the page does it. No model writes anything: what may
 * be typed is a phrase of the goal itself.
 *
 * No browser extension: the list is read from the DOM (`screen_actions.js`) and the
 * click is `element.click()` from the page.
 *
 * When the place is in Odoo's menu, Tuqui sends its way (`menu.ids`) and the walk
 * clicks it first, with no model asked (`menu_walk.js`); the model only walks what
 * is left, or what the menu could not reach on this screen.
 */

const MAX_STEPS = 12;
// Counted from the proposal, so docking, moving, clicking and typing are inside it too.
// Ends before Tuqui stops waiting (40 s), so the walk reports how it ended.
const MAX_WALK_MS = 35000;
const QUIET_MS = 350;
const SETTLE_MAX_MS = 8000;
// The loading indicator is not up yet right after the click.
const MIN_SETTLE_MS = 600;
// Odoo shows it about half a second after the click, while the server answers.
const LOADING = ".o_loading_indicator:not(.o-fade-leave)";
// Odoo's menu and action services, set when the web client starts.
let odooServices = null;

/**
 * Resolves once the click's screen has rendered: no server call pending and the
 * DOM quiet for a moment. A quiet DOM alone is not enough: a slow screen (Settings)
 * sits empty while its data loads.
 */
async function settle(signal) {
    const started = performance.now();
    let last = performance.now();
    const observer = new MutationObserver(() => (last = performance.now()));
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    try {
        while (!signal.aborted && performance.now() - started < SETTLE_MAX_MS) {
            await delay(100);
            const quiet = performance.now() - last >= QUIET_MS;
            if (quiet && !document.querySelector(LOADING) && performance.now() - started >= MIN_SETTLE_MS) {
                return;
            }
        }
    } finally {
        observer.disconnect();
    }
}

const CUT = Symbol("cut");

/** `promise`, or CUT as soon as `signal` aborts: no wait outlasts the walk. */
function unlessCut(promise, signal) {
    let onAbort;
    const cut = new Promise((resolve) => {
        onAbort = () => resolve(CUT);
        signal.aborted ? onAbort() : signal.addEventListener("abort", onAbort, { once: true });
    });
    return Promise.race([promise, cut]).finally(() => signal.removeEventListener("abort", onAbort));
}

/** What travels to Tuqui for one action: no element, no function. */
function describeAction({ id, role, name, section, operation, phrase }) {
    return { id, role, name, section, operation, phrase };
}

/**
 * Walk to `goal`. Stops on arrival, on the model's doubt, on no progress, when
 * the person touches the screen, when `signal` aborts or when time runs out.
 * Never throws: a failure ends the walk as stopped, with the steps already taken.
 *
 * @param {string} goal Where to go, in words.
 * @param {(step: object, options: {signal: AbortSignal}) => Promise<{choice: string, confidence: number, go: boolean, arrived: boolean}>} ask
 *   The next move for this screen; `signal` aborts once the walk no longer waits for it.
 * @param {{signal?: AbortSignal, startedAt?: number, menu?: {ids: number[], ends_walk: boolean}, odoo?: {menus: object, action: object}}} [options]
 *   `startedAt`: when the proposal arrived, as `performance.now()`. `menu`: the way
 *   through Odoo's menu to click first; with `ends_walk`, its screen is the destination.
 *   `odoo`: the menu and action services, Odoo's own by default.
 */
export async function showMe(goal, ask, { signal, startedAt = performance.now(), menu, odoo = odooServices } = {}) {
    const history = [];
    const steps = [];
    const visited = new Set();
    const pilot = createPilot();
    let touched = false;
    let rechecked = false;
    let lastScreen = null;
    let modelMs = 0;
    // Every way a walk is cut ends here, and every wait listens to it.
    const stop = new AbortController();
    const cancel = () => stop.abort();
    const timer = setTimeout(cancel, Math.max(0, startedAt + MAX_WALK_MS - performance.now()));
    signal?.aborted ? cancel() : signal?.addEventListener("abort", cancel, { once: true });
    const onTouch = (ev) => ev.isTrusted && ((touched = true), cancel());
    const interrupted = () => stop.signal.aborted;
    const why = () => (touched ? "the person touched the screen" : signal?.aborted ? "the walk was cancelled" : "it ran out of time");
    const wait = (promise) => unlessCut(promise, stop.signal);
    pilot.interrupted = interrupted;
    window.addEventListener("pointerdown", onTouch, true);
    window.addEventListener("keydown", onTouch, true);
    const end = (status, reason) => {
        const cutReason = interrupted() ? why() : null;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        window.removeEventListener("pointerdown", onTouch, true);
        window.removeEventListener("keydown", onTouch, true);
        // Ends what is still running for it: the model's answer and the wait for the screen.
        cancel();
        pilot.remove();
        const seconds = (performance.now() - startedAt) / 1000;
        return { status, reason: cutReason ?? reason, history, steps, seconds, model_seconds: modelMs / 1000, screen: lastScreen };
    };
    const stopped = () => end("stopped");
    /** The cursor goes to `el`, the page clicks it and the screen settles; false once cut. */
    const press = async (el) => {
        el.scrollIntoView({ block: "nearest" });
        if ((await wait(pilot.moveTo(el))) === CUT || interrupted() || (await wait(pilot.click())) === CUT) {
            return false;
        }
        el.click();
        await wait(settle(stop.signal));
        return !interrupted();
    };
    try {
        if (menu?.ids?.length && odoo) {
            const walked = await walkMenu(menu.ids, { ...odoo, press });
            for (const name of walked.clicked) {
                steps.push({ choice: name, target: name, operation: "menu", confidence: 1, ms: 0 });
                history.push({ role: "menuitem", name });
            }
            if (interrupted()) {
                return stopped();
            }
            if (walked.arrived && menu.ends_walk) {
                return end("arrived");
            }
        }
        for (let step = 1; step <= MAX_STEPS; step++) {
            if (interrupted()) {
                return stopped();
            }
            pilot.thinking();
            const { screen, actions } = observe(goal);
            lastScreen = screen;
            const asked = performance.now();
            const decision = await wait(ask({ goal, screen, actions: actions.map(describeAction), history }, { signal: stop.signal }));
            if (decision === CUT) {
                return stopped();
            }
            const action = actions.find((a) => a.id === decision.choice);
            const ms = Math.round(performance.now() - asked);
            modelMs += ms;
            steps.push({ ...decision, target: action?.name, ms });
            pilot.chose();
            if (interrupted()) {
                return stopped();
            }
            if (decision.choice === "done") {
                // `arrived` is the backend's call: a "done" needs more confidence than a click.
                if (decision.arrived) {
                    return end("arrived");
                }
                // A doubtful "done" is often a screen still loading: look once more first.
                if (!rechecked) {
                    rechecked = true;
                    await wait(settle(stop.signal));
                    continue;
                }
                const confidence = Number(decision.confidence) || 0;
                return end("unconfirmed", `it was not sure this is the destination (${confidence.toFixed(2)})`);
            }
            if (decision.choice === "wait") {
                await wait(settle(stop.signal));
                continue;
            }
            // Tuqui's backend decides whether an action is sure enough (`go`): one threshold, there.
            if (decision.choice === "stop" || !decision.go) {
                return end("stopped", decision.choice === "stop" ? "it saw no way forward from this screen" : "it was unsure of the next step");
            }
            if (!action) {
                return end("stopped", `the model picked an action not on this screen (${decision.choice})`);
            }
            const fingerprint = JSON.stringify([screen, action.role, action.name]);
            if (visited.has(fingerprint)) {
                return end("stopped", "no progress: the same action on the same screen");
            }
            visited.add(fingerprint);
            if (action.el) {
                action.el.scrollIntoView({ block: "nearest" });
                if ((await wait(pilot.moveTo(action.el))) === CUT || interrupted()) {
                    return stopped();
                }
                if (!action.el.isConnected || !isReachable(action.el)) {
                    return end("stopped", "the chosen control disappeared or was covered");
                }
                if (action.role !== "search" && (await wait(pilot.click())) === CUT) {
                    return stopped();
                }
            }
            // Typing stops by itself once cut: the pilot checks `interrupted` before each character.
            if ((await wait(action.run(pilot))) === CUT) {
                return stopped();
            }
            history.push({ role: action.role, name: action.name });
            await wait(settle(stop.signal));
        }
        return end("stopped", "it reached the step limit");
    } catch (error) {
        return end("stopped", String(error?.message || error));
    }
}

registry.category("services").add("tuqui_show_me", {
    dependencies: ["menu", "action"],
    start(env, { menu, action }) {
        odooServices = { menus: menu, action };
        knowMenus(menu);
        // Debug-only entry point for the benchmark harness, which brings its own `ask`.
        // `env.debug` throws in 20.0: the debug mode is a plugin, read as `odoo.debug` outside one.
        if (odoo.debug) {
            window.tuquiShowMe = (goal, ask) => showMe(goal, ask);
        }
    },
});
