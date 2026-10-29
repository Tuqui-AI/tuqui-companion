import { showMe } from "@tuqui_assistant/show_me/show_me";

// How long one step of a walk waits for Tuqui's answer before the walk stops.
const STEP_TIMEOUT_MS = 15000;

/** The id the SPA puts on a proposal. Anything else is an old SPA: no answer. */
export function readProposalId(data) {
    const id = data?.payload?.proposalId ?? data?.proposalId;
    return typeof id === "string" && id.length > 0 && id.length <= 128 ? id : null;
}

/** The menu's way as Tuqui sent it, or undefined when it is not one. */
function readMenu(menu) {
    const ids = Array.isArray(menu?.ids) ? menu.ids : [];
    return ids.length && ids.every(Number.isInteger) ? { ids, ends_walk: menu.ends_walk === true } : undefined;
}

const stopped = (message) => ({ status: "stopped", applied: [], skipped: [], message, steps: [] });

/**
 * The walks of `odoo_show_me` on this screen, whoever hosts the chat: the embed's
 * panel (`panel.js`) or Tuqui's side panel (`side_panel_host.js`). One walk at a
 * time; each step is asked to the chat through `post(id, payload)`, which asks
 * Tuqui's backend, so the judgment key is never in this Odoo.
 */
export function makeWalkSession({ post, getContext, isHidden = () => false, walk = showMe, timeoutMs = STEP_TIMEOUT_MS }) {
    let controller = null;
    let count = 0;
    const steps = new Map();

    function ask(payload, { signal } = {}) {
        const id = `s${++count}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => answer({ ok: false, error: "Tuqui did not answer the step" }), timeoutMs);
            // The walk no longer waits for this step: stop waiting for it too.
            const onAbort = () => answer({ ok: false, error: "the walk no longer waits for this step" });
            function answer(data) {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                steps.delete(id);
                data.ok ? resolve(data.result) : reject(new Error(String(data.error || "step failed")));
            }
            steps.set(id, answer);
            signal?.addEventListener("abort", onAbort, { once: true });
            try {
                post(id, payload);
            } catch (error) {
                steps.get(id)({ ok: false, error: error.message });
            }
        });
    }

    /** Why a walk cannot start now, as its result; null when it can. */
    function refusal() {
        // The walk is there to be watched, and hiding the chat stops it anyway.
        if (isHidden()) {
            return stopped("the chat is minimized: open it to watch the walk");
        }
        // Leaving a form with unsaved changes saves them: the walk would write.
        const context = getContext();
        if (context?.kind === "record" && context.dirty) {
            return stopped("the form has unsaved changes: save or discard them first");
        }
        // Two pilots on one screen would click over each other.
        return controller ? stopped("another walk is in progress") : null;
    }

    /** Walk this screen to `goal`, through `menu` first when Tuqui sent one, and say how it ended, as an `apply-result`. */
    async function run(goal, proposalId, { startedAt, menu } = {}) {
        const refused = refusal();
        if (refused) {
            return refused;
        }
        controller = new AbortController();
        try {
            // Each step names its walk: Tuqui answers only for a walk it started for this person.
            const result = await walk(String(goal || ""), (step, options) => ask({ ...step, proposal_id: proposalId }, options), {
                signal: controller.signal,
                startedAt,
                menu: readMenu(menu),
            });
            return {
                status: result.status,
                applied: [],
                skipped: [],
                message: result.reason || null,
                // Each answer of the judgment model, so the walk can be read back from the conversation.
                steps: result.steps.map((s) => ({
                    choice: String(s.target || s.choice || ""),
                    operation: String(s.operation || ""),
                    confidence: Math.round(Number(s.confidence || 0) * 100) / 100,
                })),
            };
        } finally {
            controller = null;
        }
    }

    return {
        run,
        refusal,
        get walking() {
            return controller !== null;
        },
        onStepResult: (data) => steps.get(data.id)?.(data),
        abort: () => controller?.abort(),
        /** End the walk and every step still waiting: the chat on the other side is gone. */
        dispose(reason) {
            controller?.abort();
            for (const answer of [...steps.values()]) {
                answer({ ok: false, error: reason });
            }
        },
    };
}
