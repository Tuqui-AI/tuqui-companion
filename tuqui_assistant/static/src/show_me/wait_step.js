import { rpcBus } from "@web/core/network/rpc";
import { CONTROLS, OWN_PANEL, RECORDS, nameOf, recordName, sectionOf } from "@tuqui_assistant/screen/screen_targets";

/**
 * «Esperar en silencio»: while Tuqui waits for the person to do a step,
 * this host notes what the person does: what reaches the server, which screen they open,
 * the controls they click and the fields they change. It tells Tuqui what happened, with
 * the screen as it is then, as a consultant sitting next to them would notice: once they
 * stop, and at once when something was saved, confirmed or deleted. Tuqui checks it with
 * the data and decides.
 * Nothing here knows any task or judges anything: it notes and takes a picture.
 *
 * Measured on recorded tasks before writing it: the calls alone cannot tell a right
 * import from a wrong one (they are identical), the screen after them can; and a
 * picture taken on every call catches the person half-way (a duplicated tax still at
 * 3%, a draft saved but not confirmed), so it reports only when they stop.
 */

// Quiet time after the last thing the person did (a call that changes data, a screen
// opened, a control clicked, a field changed) before Tuqui is told. Not measured on
// people yet: scripted runs have no pauses.
export const QUIET_MS = 3000;
// A call that changed data is told almost at once, like a consultant sitting next to the
// person: by the time they stop, a wrong save is already done. The short wait only lets a
// call that belongs to the same click (a wizard saved, then run) start first.
export const SETTLE_MS = 800;
// A wait with nothing done for this long ends: the person moved on.
export const IDLE_MS = 15 * 60 * 1000;
// Most times Tuqui is woken for one step. Every report is a model turn, and when the
// step is not done yet Tuqui arms the same wait again: this bounds the model turns a
// step can cost. Counted per step (the same waiting line), not per wait, or the re-arms
// would reset it and it would never be reached.
export const MAX_WAKES = 10;
// A screen still loading is not what the person sees yet: the picture waits for the server's
// answers to land, up to this many short waits (a request that never answers must not hold it).
const MAX_LOADING_WAITS = 12;
// The web client's own generic reads: they open and fill screens, never change data.
// Odoo's framework methods, not a list of business methods.
export const FRAMEWORK_READS = new Set([
    "get_views",
    "web_search_read",
    "web_read",
    "web_read_group",
    "read",
    "search_read",
    "search_count",
    "read_group",
    "onchange",
    "name_search",
    "web_name_search",
    "fields_get",
    "has_group",
    "has_access",
]);
// What a person clicks to do something: a step that only opens a menu or ticks a box
// leaves no trace on the server, so the click itself is what happened. The controls a
// mark can land on, the rows and cards, and the items of an open menu.
const CLICKABLE = `${CONTROLS}, ${RECORDS}, .dropdown-item, .o_select_menu_item`;
const TYPED = "input:not([type=checkbox]):not([type=radio]), textarea, select";
// The boxes whose value can go to Tuqui: never a password, since what is read here
// reaches the model and stays in the conversation.
const READABLE_INPUT = "input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=password])";
// What the server takes: enough for a form or a list, not a page dump.
const MAX_SCREEN_CHARS = 4000;
// Of what happened it takes 20 lines of up to 500 characters, and refuses more.
const MAX_HAPPENED = 20;
const MAX_LINE_CHARS = 400;
const MAX_IDS = 10;

const squash = (text) => (text || "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

/**
 * Whether a call that went through changed data, as opposed to only opening something.
 * Odoo answers a call that opens a screen or a wizard with an action to run, and a call
 * that saved, confirmed or deleted with data (the record, true). A property of the
 * answer, not a list of methods. Closing a wizard is the end of what it did: it counts.
 */
export function changedData(result) {
    const type = result && typeof result === "object" ? result.type : null;
    return !(typeof type === "string" && type.startsWith("ir.actions.") && type !== "ir.actions.act_window_close");
}

/** Whether a call counts: not one of the web client's reads, nor this module's own. */
export function counts({ model, method } = {}) {
    return Boolean(method) && !FRAMEWORK_READS.has(method) && !String(model || "").startsWith("tuqui.");
}

/**
 * What the person sees: the topmost dialog, or the action, with the values typed in
 * its fields (innerText leaves out what is in inputs) and the notifications on screen.
 * A menu the person opened (filters, actions) is drawn outside the action, so it goes
 * apart: without it, an open menu reads as nothing happened.
 */
export function readScreen(doc = document) {
    const top = [...doc.querySelectorAll(".modal-content")].pop() || doc.querySelector(".o_action_manager") || doc.body;
    const notes = [...doc.querySelectorAll(".o_notification")].map((n) => squash(n.innerText)).filter(Boolean);
    const menus = [...doc.querySelectorAll(".o-dropdown--menu, .o_popover")]
        .filter((m) => !m.closest(OWN_PANEL))
        .map((m) => squash(m.innerText))
        .filter(Boolean);
    const values = [...top.querySelectorAll(`.o_field_widget ${READABLE_INPUT}, .o_field_widget textarea`)]
        .filter((el) => el.value)
        .map((el) => {
            const label = el.id && doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            return `${squash(label?.innerText) || el.closest(".o_field_widget").getAttribute("name")}: ${el.value}`;
        });
    const text = [
        notes.length ? `NOTIFICATIONS: ${notes.join(" | ")}` : "",
        menus.length ? `OPEN MENU: ${menus.join(" | ")}` : "",
        squash(top.innerText),
        values.length ? `FIELD VALUES: ${values.join(" | ")}` : "",
    ].filter(Boolean);
    return text.join("\n").slice(0, MAX_SCREEN_CHARS);
}

/** Where the person is: the path and the breadcrumb. Opening another record or screen
 *  changes it, while the web client only reads: a step that only moves still counts. */
export function readWhere(doc = document) {
    const crumbs = squash(doc.querySelector(".o_breadcrumb")?.innerText).replace(/\n/g, " / ");
    return `${doc.location?.pathname || ""}|${crumbs}`;
}

/** A control as the person sees it: its visible name, and its section when it has one. */
export function describeControl(el) {
    const name = el.matches(RECORDS) ? recordName(el) : nameOf(el);
    const section = sectionOf(el);
    // No template inside a template: Odoo's minifier drops the space in the inner one.
    const where = section ? " (" + section + ")" : "";
    return `«${name || el.tagName.toLowerCase()}»${where}`;
}

/**
 * One wait at a time. `notify` sends the `step-event` to the chat. The bus, the screen
 * and the place are injectable for tests.
 */
export function makeWaitSession({
    notify,
    bus = rpcBus,
    read = readScreen,
    where = readWhere,
    // Only what a person does counts, not what a script dispatches; injectable for tests.
    byPerson = (ev) => ev.isTrusted,
    quietMs = QUIET_MS,
    settleMs = SETTLE_MS,
    idleMs = IDLE_MS,
    maxWakes = MAX_WAKES,
}) {
    let wait = null;
    // The step the waits are for, and how many times Tuqui was woken for it.
    let step = null;
    let wakes = 0;

    function stop() {
        if (!wait) {
            return;
        }
        bus.removeEventListener("RPC:REQUEST", wait.onRequest);
        bus.removeEventListener("RPC:RESPONSE", wait.onResponse);
        document.removeEventListener("pointerdown", wait.onInput, true);
        document.removeEventListener("keydown", wait.onInput, true);
        document.removeEventListener("click", wait.onClick, true);
        document.removeEventListener("change", wait.onChange, true);
        clearTimeout(wait.quietTimer);
        clearTimeout(wait.idleTimer);
        clearTimeout(wait.whereTimer);
        wait = null;
    }

    // A chat that cannot be told (the panel reconnecting, its origin changed) ends the wait:
    // nobody reads what it notes, and the error would pop up on every click from a timer.
    function tell(payload) {
        try {
            notify(payload);
            return true;
        } catch {
            stop();
            return false;
        }
    }

    // Stops before telling the chat: a chat that is gone must not leave the wait listening.
    function finish(current, outcome, extra = {}) {
        stop();
        tell({ proposal_id: current.proposalId, outcome, happened: [...current.happened], ...extra });
    }

    // The person stopped (or the server said no): Tuqui gets what happened and the screen,
    // and decides; if the step is not done yet, Tuqui arms another. Until it does, the wait
    // keeps noting without telling: a person who knows the next step does it while Tuqui
    // answers, and that belongs to the step Tuqui marks next.
    function report(current) {
        if (wait !== current || !current.fresh || current.reported) {
            return;
        }
        if (current.loading > 0 && current.loadingWaits < MAX_LOADING_WAITS) {
            current.loadingWaits++;
            armReport(current, settleMs);
            return;
        }
        if (wakes >= maxWakes) {
            finish(current, "idle");
            return;
        }
        wakes++;
        clearTimeout(current.quietTimer);
        if (!tell({ proposal_id: current.proposalId, outcome: "happened", happened: current.happened, screen: read() })) {
            return;
        }
        current.happened = [];
        current.dataChanged = false;
        current.reported = true;
    }

    // At most what the server takes: the latest of what happened, each line cut to size.
    function note(current, line) {
        current.happened = [...current.happened, line.slice(0, MAX_LINE_CHARS)].slice(-MAX_HAPPENED);
    }

    // Tell Tuqui once the person has been still for `delay`.
    function armReport(current, delay) {
        clearTimeout(current.quietTimer);
        current.quietTimer = setTimeout(() => report(current), delay);
    }

    function armQuiet(current) {
        armReport(current, quietMs);
    }

    function armIdle(current) {
        clearTimeout(current.idleTimer);
        // Once told, nobody waits for it: it ends without a word.
        current.idleTimer = setTimeout(() => wait === current && (current.reported ? stop() : finish(current, "idle")), idleMs);
    }

    /** Start waiting for `proposalId`; a wait already running is replaced. `waitingLine`
     *  names the step: another line is another step, and its count of wakes starts over. */
    function start(proposalId, waitingLine = "") {
        // What the person did after the last report, while Tuqui answered: this step's own.
        const before = wait?.reported ? wait.happened.map((line) => `before this step: ${line}`) : [];
        const changedBefore = Boolean(wait?.reported && wait.dataChanged);
        stop();
        if (waitingLine !== step) {
            step = waitingLine;
            wakes = 0;
        }
        const current = {
            proposalId,
            happened: before.slice(-MAX_HAPPENED),
            dataChanged: false,
            reported: false,
            calls: new Map(),
            // Requests of any kind still waiting for the server: the screen is still drawing.
            loading: 0,
            loadingWaits: 0,
            fresh: false,
            quietTimer: null,
            idleTimer: null,
            whereTimer: null,
            where: where(),
        };
        // Any answer from the server may come with another screen: look once it is drawn.
        const noteWhere = () => {
            clearTimeout(current.whereTimer);
            current.whereTimer = setTimeout(() => {
                const now = where();
                if (wait !== current || now === current.where) {
                    return;
                }
                current.where = now;
                note(current, `opened: ${now.split("|")[1] || now}`);
                current.fresh = true;
                armIdle(current);
                armQuiet(current);
            }, 300);
        };
        current.onRequest = ({ detail }) => {
            current.loading++;
            const params = detail?.data?.params || {};
            if (!counts(params)) {
                return;
            }
            // The ids it acts on, as sent: Tuqui reads those records with the data (an unlink leaves none to read here).
            const ids = params.args?.[0];
            const on = Array.isArray(ids) && ids.length && ids.every(Number.isInteger) ? ` on ids ${ids.slice(0, MAX_IDS).join(", ")}` : "";
            current.calls.set(detail.data.id, { label: `${params.model}.${params.method}`, on });
            // The person is still at it: telling Tuqui now would catch them half-way.
            clearTimeout(current.quietTimer);
            armIdle(current);
        };
        current.onResponse = ({ detail }) => {
            current.loading = Math.max(0, current.loading - 1);
            noteWhere();
            const call = current.calls.get(detail?.data?.id);
            if (!call) {
                return;
            }
            current.calls.delete(detail.data.id);
            const error = detail.error && (detail.error.data?.message || detail.error.message || "error");
            const outcome = error ? "failed: " + String(error).slice(0, 300) : "succeeded";
            note(current, `${call.label} ${outcome}${call.on}`);
            current.fresh = true;
            const changed = !error && changedData(detail.result);
            current.dataChanged ||= changed;
            if (error) {
                // An error is how it ended: no reason to wait for the person to stop.
                report(current);
            } else {
                armReport(current, changed ? settleMs : quietMs);
            }
        };
        // What the person does on screen is noted like a call, then the same quiet.
        const noteAction = (line) => {
            note(current, line);
            current.fresh = true;
            armIdle(current);
            armQuiet(current);
        };
        current.onClick = (ev) => {
            const el = byPerson(ev) && ev.target.closest?.(CLICKABLE);
            // A field counts once its value changes, not when the person clicks into it.
            if (el && !el.closest(OWN_PANEL) && !el.matches(TYPED)) {
                noteAction(`clicked: ${describeControl(el)}`);
            }
        };
        // A field counts once its value changed, not key by key; a ticked box is noted by its click.
        current.onChange = (ev) => {
            const el = ev.target;
            if (!byPerson(ev) || el.closest?.(OWN_PANEL) || !el.matches?.(TYPED)) {
                return;
            }
            noteAction(el.type === "file" ? `picked a file in ${describeControl(el)}` : `typed in ${describeControl(el)}`);
        };
        // Touching the screen or typing means the person is not done: Tuqui waits. Enter in
        // a one-line box sends what was typed (a search becomes a filter and the box is
        // emptied, so no change event follows): that is something done.
        current.onInput = (ev) => {
            const el = ev.target;
            const sent = ev.key === "Enter" && byPerson(ev) && el.matches?.(READABLE_INPUT);
            if (sent && el.value.trim() && !el.closest(OWN_PANEL)) {
                noteAction(`typed «${el.value.trim().slice(0, 80)}» and pressed Enter in ${describeControl(el)}`);
            } else if (current.fresh) {
                armQuiet(current);
            }
        };
        bus.addEventListener("RPC:REQUEST", current.onRequest);
        bus.addEventListener("RPC:RESPONSE", current.onResponse);
        document.addEventListener("pointerdown", current.onInput, true);
        document.addEventListener("keydown", current.onInput, true);
        document.addEventListener("click", current.onClick, true);
        document.addEventListener("change", current.onChange, true);
        wait = current;
        armIdle(current);
        if (before.length) {
            current.fresh = true;
            // A change of data in between may already be this step done: tell it now.
            if (changedBefore) {
                armReport(current, settleMs);
            }
        }
    }

    return {
        start,
        /** The person wrote in the chat: their message rules, the wait ends without a word.
         *  With an id, only that wait: a cancel that crossed a newer wait leaves it alone. */
        cancel(proposalId) {
            if (!proposalId || wait?.proposalId === proposalId) {
                stop();
            }
        },
        get waiting() {
            return wait && !wait.reported ? wait.proposalId : null;
        },
        /** The chat on the other side is gone. */
        dispose: stop,
    };
}
