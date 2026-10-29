/** @odoo-module **/
import { describe, expect, getFixture, test } from "@odoo/hoot";
import { advanceTime, animationFrame } from "@odoo/hoot-mock";
import { EventBus } from "@odoo/owl";
import { MainComponentsContainer } from "@web/core/main_components_container";
import { rpcBus } from "@web/core/network/rpc";
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
import {
    IDLE_MS,
    MAX_WAKES,
    QUIET_MS,
    SETTLE_MS,
    changedData,
    counts,
    makeWaitSession,
    readScreen,
} from "@tuqui_assistant/show_me/wait_step";

/**
 * «Esperar en silencio»: what this host notes while Tuqui waits, and when it
 * tells the chat what happened. Deciding whether the step is done is Tuqui's, with the
 * data: nothing here judges.
 *
 * How to run them: see the header of `apply_proposal.test.js`.
 */

describe.current.tags("desktop");

// What Odoo answers to a call that only opens a screen or a wizard.
const OPENS = { type: "ir.actions.act_window", res_model: "account.statement.import" };

function session({ where = () => "/odoo|Home", byPerson = () => true } = {}) {
    const bus = new EventBus();
    const events = [];
    const waits = makeWaitSession({
        bus,
        read: () => "SCREEN",
        where,
        byPerson,
        notify: (payload) => events.push(payload),
    });
    // What Tuqui was told: the reports, not the idle ends.
    const told = () => events.filter((e) => e.outcome === "happened");
    let id = 0;
    async function call(model, method, { args = [], error = null, result = true } = {}) {
        const data = { id: ++id, params: { model, method, args } };
        bus.trigger("RPC:REQUEST", { data });
        await animationFrame();
        bus.trigger("RPC:RESPONSE", { data, ...(error ? { error } : { result }) });
        await animationFrame();
    }
    return { waits, events, told, call, bus };
}

describe("wait in silence: what counts", () => {
    test("the web client's reads and this module's calls do not count; the rest does", () => {
        expect(counts({ model: "res.partner", method: "web_read" })).toBe(false);
        expect(counts({ model: "res.partner", method: "onchange" })).toBe(false);
        expect(counts({ model: "res.partner", method: "has_access" })).toBe(false);
        expect(counts({ model: "tuqui.assistant.sso.nonce", method: "embed_bootstrap" })).toBe(false);
        expect(counts({ model: "res.partner", method: "web_save" })).toBe(true);
        expect(counts({ model: "account.statement.import", method: "import_file_button" })).toBe(true);
    });

    test("reading the same screen never tells Tuqui anything", async () => {
        const { waits, told, call } = session();
        waits.start("p1");
        await call("res.partner", "web_search_read");
        await advanceTime(QUIET_MS * 3);
        expect(told()).toEqual([]);
    });

    test("opening another screen counts, though the web client only reads to show it", async () => {
        let here = "/odoo/action-799|Mapeos de Hojas de Estados";
        const { waits, told, call } = session({ where: () => here });
        waits.start("p1");
        here = "/odoo/action-799/6|Mapeos de Hojas de Estados / Supervielle";
        await call("account.statement.import.sheet.mapping", "web_read");
        await advanceTime(300 + QUIET_MS);
        expect(told().length).toBe(1);
        expect(told()[0].happened).toEqual(["opened: Mapeos de Hojas de Estados / Supervielle"]);
    });
});

describe("wait in silence: what the person does on screen", () => {
    function screen(html) {
        const fixture = getFixture();
        fixture.innerHTML = html;
        return fixture;
    }

    test("a click on a control counts, named as the person sees it, with its section", async () => {
        const fixture = screen(`<div class="o_group" data-string="Acciones"><button type="button">Eliminar</button></div>`);
        const { waits, told } = session();
        waits.start("p1");
        fixture.querySelector("button").click();
        await advanceTime(QUIET_MS);
        expect(told().length).toBe(1);
        expect(told()[0].happened).toEqual(["clicked: «Eliminar» (Acciones)"]);
    });

    test("ticking a row counts: a step that leaves no trace on the server", async () => {
        const fixture = screen(`<table><tr class="o_data_row"><td><input type="checkbox"/></td><td>SUP: supervielle_octubre.csv</td></tr></table>`);
        const { waits, told } = session();
        waits.start("p1");
        fixture.querySelector("input").click();
        await advanceTime(QUIET_MS);
        expect(told()[0].happened.length).toBe(1);
        expect(told()[0].happened[0]).toMatch(/^clicked: /);
    });

    test("clicking into a field is not something done: only its new value is", async () => {
        const fixture = screen(`<label for="nm">Nombre</label><input id="nm" type="text"/>`);
        const { waits, told } = session();
        waits.start("p1");
        fixture.querySelector("input").click();
        await advanceTime(QUIET_MS);
        expect(told()).toEqual([]);
    });

    test("a field counts once its value changed, by its label", async () => {
        const fixture = screen(`<label for="nm">Nombre</label><input id="nm" type="text"/>`);
        const { waits, told } = session();
        waits.start("p1");
        const input = fixture.querySelector("input");
        input.value = "Ganancias EXENTO";
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await advanceTime(QUIET_MS);
        expect(told()[0].happened).toEqual(["typed in «Nombre»"]);
    });

    test("a search sent with Enter counts, though the box is emptied right after", async () => {
        // Odoo turns the text into a filter and empties the box: no change event, no
        // other screen, and the search itself is a read (e2e «reactivar usuaria», 09/10).
        const fixture = screen(`<input type="text" placeholder="Buscar…"/>`);
        const { waits, told } = session();
        waits.start("p1");
        const input = fixture.querySelector("input");
        input.value = "Marcela";
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        input.value = "";
        await advanceTime(QUIET_MS);
        expect(told().length).toBe(1);
        expect(told()[0].happened).toEqual(["typed «Marcela» and pressed Enter in «Buscar…»"]);
    });

    test("Enter in a password box never carries what was typed", async () => {
        // Odoo asks for the password before creating an API key: it goes to the model otherwise.
        const fixture = screen(`<input type="password" placeholder="Contraseña"/>`);
        const { waits, events } = session();
        waits.start("p1");
        const input = fixture.querySelector("input");
        input.value = "MiClave";
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await advanceTime(QUIET_MS);
        expect(JSON.stringify(events)).not.toInclude("MiClave");
    });

    test("a click in Tuqui's own panel does not count", async () => {
        const fixture = screen(`<div class="o-tuqui-panel"><button type="button">Enviar</button></div>`);
        const { waits, told } = session();
        waits.start("p1");
        fixture.querySelector("button").click();
        await advanceTime(QUIET_MS * 2);
        expect(told()).toEqual([]);
    });

    test("a click a script makes, not the person, does not count", async () => {
        const fixture = screen(`<button type="button">Guardar</button>`);
        const { waits, told } = session({ byPerson: (ev) => ev.isTrusted });
        waits.start("p1");
        fixture.querySelector("button").click(); // dispatched by the test: not trusted
        await advanceTime(QUIET_MS * 2);
        expect(told()).toEqual([]);
    });
});

describe("wait in silence: how many times it wakes Tuqui for one step", () => {
    test("Tuqui re-arming the same step keeps counting: past MAX_WAKES it is idle", async () => {
        const { waits, events, call } = session();
        for (let i = 0; i < MAX_WAKES; i++) {
            waits.start(`p${i}`, "Esperando que guardes el mapeo");
            await call("res.partner", "web_save");
            await advanceTime(QUIET_MS);
        }
        expect(events.map((e) => e.outcome)).toEqual(Array(MAX_WAKES).fill("happened"));
        waits.start("p-last", "Esperando que guardes el mapeo");
        await call("res.partner", "web_save");
        await advanceTime(QUIET_MS);
        expect(events.at(-1)).toEqual({ proposal_id: "p-last", outcome: "idle", happened: ["res.partner.web_save succeeded"] });
    });

    test("another step starts its own count", async () => {
        const { waits, events, call } = session();
        for (let i = 0; i < MAX_WAKES; i++) {
            waits.start(`p${i}`, "Esperando que guardes el mapeo");
            await call("res.partner", "web_save");
            await advanceTime(QUIET_MS);
        }
        waits.start("next", "Esperando que importes el extracto");
        await call("account.statement.import", "import_file_button");
        await advanceTime(QUIET_MS);
        expect(events.at(-1).outcome).toBe("happened");
    });
});

describe("wait in silence: when it tells Tuqui", () => {
    test("once the person has been still for QUIET_MS after a call: what happened and the screen", async () => {
        const { waits, events, call } = session();
        waits.start("p1");
        await call("account.journal", "import_account_statement", { result: OPENS });
        await advanceTime(QUIET_MS - 100);
        expect(events).toEqual([]);
        await advanceTime(200);
        expect(events).toEqual([
            { proposal_id: "p1", outcome: "happened", happened: ["account.journal.import_account_statement succeeded"], screen: "SCREEN" },
        ]);
    });

    test("a call that changed data is told almost at once: a consultant sees the save as it lands", async () => {
        const { waits, told, call } = session();
        waits.start("p1");
        await call("res.partner", "web_save", { args: [[7]], result: [{ id: 7 }] });
        await advanceTime(SETTLE_MS - 100);
        expect(told()).toEqual([]);
        await advanceTime(200);
        expect(told().length).toBe(1);
    });

    test("a wizard saved and then run in the same click is one report, after the run", async () => {
        const { waits, told, call } = session();
        waits.start("p1");
        await call("account.statement.import", "web_save", { result: [{ id: 3 }] });
        await call("account.statement.import", "import_file_button", { result: OPENS });
        await advanceTime(SETTLE_MS + 100);
        expect(told()).toEqual([]);
        await advanceTime(QUIET_MS);
        expect(told().length).toBe(1);
        expect(told()[0].happened.length).toBe(2);
    });

    test("whether a call changed data is read from Odoo's answer, not from a list of methods", () => {
        expect(changedData(true)).toBe(true);
        expect(changedData([{ id: 7 }])).toBe(true);
        expect(changedData(OPENS)).toBe(false);
        expect(changedData({ type: "ir.actions.client", tag: "reload" })).toBe(false);
        expect(changedData({ type: "ir.actions.act_window_close" })).toBe(true);
    });

    // 13/10, ticket 118861: Tuqui got the picture while Ajustes was still loading and asked
    // the person to open the screen they were already on.
    test("the picture waits for a screen that is still loading", async () => {
        const { waits, told, bus } = session();
        waits.start("p1");
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
        const fixture = getFixture();
        fixture.innerHTML = `<button type="button">Ajustes</button>`;
        fixture.querySelector("button").click();
        const data = { id: 77, params: { model: "res.config.settings", method: "web_read", args: [] } };
        bus.trigger("RPC:REQUEST", { data });
        await advanceTime(QUIET_MS + 2 * SETTLE_MS);
        expect(told()).toEqual([]);
        bus.trigger("RPC:RESPONSE", { data, result: [] });
        await advanceTime(SETTLE_MS + 400);
        expect(told().length).toBe(1);
    });

    test("touching the screen or typing puts it off", async () => {
        const { waits, told, call } = session();
        waits.start("p1");
        await call("account.journal", "import_account_statement", { result: OPENS });
        await advanceTime(QUIET_MS - 500);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
        await advanceTime(QUIET_MS - 500);
        expect(told().length).toBe(0);
        await advanceTime(600);
        expect(told().length).toBe(1);
    });

    test("a new call while the person is at it puts it off", async () => {
        const { waits, told, call } = session();
        waits.start("p1");
        await call("account.journal", "open_action_with_context", { result: OPENS });
        await advanceTime(QUIET_MS - 500);
        await call("account.move", "action_register_payment", { result: OPENS });
        await advanceTime(QUIET_MS - 500);
        expect(told().length).toBe(0);
        await advanceTime(600);
        expect(told().length).toBe(1);
        expect(told()[0].happened.length).toBe(2);
    });

    test("an error is told right away, without waiting", async () => {
        const { waits, told, call } = session();
        waits.start("p1");
        await call("account.move", "action_post", { error: { message: "Odoo said no", data: { message: "The entry is not balanced" } } });
        expect(told().length).toBe(1);
        expect(told()[0].happened).toEqual(["account.move.action_post failed: The entry is not balanced"]);
    });

    test("it says which records a call acted on, so Tuqui can read them", async () => {
        const { waits, told, call } = session();
        waits.start("p1");
        await call("res.users", "action_unarchive", { args: [[7]] });
        await advanceTime(QUIET_MS);
        expect(told()[0].happened).toEqual(["res.users.action_unarchive succeeded on ids 7"]);
    });

    test("telling Tuqui ends the wait: the next one is Tuqui's to arm", async () => {
        const { waits, told, call } = session();
        waits.start("p1");
        await call("res.partner", "web_save");
        await advanceTime(QUIET_MS);
        expect(waits.waiting).toBe(null);
        await call("res.partner", "web_save");
        await advanceTime(QUIET_MS * 2);
        expect(told().length).toBe(1);
    });

    // 16/10: a person who knows the next step does it while Tuqui is still answering.
    test("after telling Tuqui it keeps noting: the next step starts with that, told at once if data changed", async () => {
        const { waits, told, call } = session();
        waits.start("p1", "Esperando que importes");
        await call("account.statement.import", "import_file_button");
        await advanceTime(QUIET_MS);
        expect(told().length).toBe(1);
        await call("account.bank.statement.line", "write", { args: [[7]] });
        await advanceTime(QUIET_MS * 2);
        expect(told().length).toBe(1);
        waits.start("p2", "Esperando que concilies");
        await advanceTime(SETTLE_MS + 100);
        expect(told().length).toBe(2);
        expect(told()[1].proposal_id).toBe("p2");
        expect(told()[1].happened).toEqual(["before this step: account.bank.statement.line.write succeeded on ids 7"]);
    });

    test("what happened is cut to the latest lines the server takes", async () => {
        const { waits, told, call } = session();
        waits.start("p1");
        for (let i = 0; i < 25; i++) {
            await call("sale.order", "action_confirm", { result: OPENS });
        }
        await advanceTime(QUIET_MS);
        expect(told()[0].happened.length).toBe(20);
    });
});

describe("wait in silence: when it ends", () => {
    test("the person wrote (wait-cancel): it ends without a word", async () => {
        const { waits, events, call } = session();
        waits.start("p1");
        waits.cancel();
        await call("res.partner", "web_save");
        await advanceTime(IDLE_MS + QUIET_MS);
        expect(events).toEqual([]);
    });

    test("a call still running puts it off: an import takes its time", async () => {
        const { waits, told, call, bus } = session();
        waits.start("p1");
        await call("account.journal", "import_account_statement", { result: OPENS });
        await advanceTime(QUIET_MS - 500);
        bus.trigger("RPC:REQUEST", { data: { id: 99, params: { model: "account.statement.import", method: "import_file_button", args: [] } } });
        await advanceTime(QUIET_MS);
        expect(told()).toEqual([]);
    });

    test("a cancel for another wait leaves the current one listening", async () => {
        const { waits } = session();
        waits.start("p2");
        waits.cancel("p1");
        expect(waits.waiting).toBe("p2");
        waits.cancel("p2");
        expect(waits.waiting).toBe(null);
    });

    test("a new wait lets go of the one before: no listener is left behind", () => {
        const live = new Set();
        const bus = { addEventListener: (t, f) => live.add(f), removeEventListener: (t, f) => live.delete(f) };
        const waits = makeWaitSession({ bus, notify: () => {} });
        waits.start("p1");
        waits.start("p2");
        expect(live.size).toBe(2);
        waits.cancel();
        expect(live.size).toBe(0);
    });

    test("a new wait replaces the one before", async () => {
        const { waits, told, call } = session();
        waits.start("p1");
        await call("res.partner", "web_save");
        waits.start("p2");
        await advanceTime(QUIET_MS);
        expect(told()).toEqual([]);
        await call("res.partner", "web_save");
        await advanceTime(QUIET_MS);
        expect(told().map((e) => e.proposal_id)).toEqual(["p2"]);
    });

    // Seen on Odoo 19 (16/10): after changing tuqui.base_url the panel was not
    // connected yet, and every click on the screen raised «Tuqui is not connected».
    test("a chat that cannot be told ends the wait, without an error on screen", async () => {
        const bus = new EventBus();
        let tries = 0;
        const waits = makeWaitSession({
            bus,
            read: () => "SCREEN",
            where: () => "/odoo|Home",
            byPerson: () => true,
            notify: () => {
                tries++;
                throw new Error("Tuqui is not connected");
            },
        });
        const save = async (id) => {
            const data = { id, params: { model: "res.partner", method: "web_save", args: [] } };
            bus.trigger("RPC:REQUEST", { data });
            await animationFrame();
            bus.trigger("RPC:RESPONSE", { data, result: true });
            await animationFrame();
        };
        waits.start("p1");
        await save(1);
        await advanceTime(QUIET_MS);
        expect(tries).toBe(1);
        expect(waits.waiting).toBe(null);
        await save(2);
        await advanceTime(IDLE_MS + QUIET_MS);
        expect(tries).toBe(1);
    });

    test("15 minutes without calls: idle", async () => {
        const { waits, events } = session();
        waits.start("p1");
        await advanceTime(IDLE_MS - 1000);
        expect(events).toEqual([]);
        await advanceTime(1000);
        expect(events).toEqual([{ proposal_id: "p1", outcome: "idle", happened: [] }]);
    });
});

describe("wait in silence: the picture", () => {
    test("it carries the values typed in fields, by their label, and the notifications", () => {
        const fixture = getFixture();
        fixture.innerHTML = `
            <div class="o_action_manager"><div class="o_form_view">
                <label for="rev">Reversión de</label>
                <div class="o_field_widget" name="reversed_entry_id"><input id="rev" value="FA-E 00002-00000005"/></div>
                <div class="o_field_widget" name="ref"><input value="Venta cancelada"/></div>
            </div></div>
            <div class="o_notification">Se importaron 3 movimientos</div>`;
        const picture = readScreen(fixture.ownerDocument);
        expect(picture).toInclude("Reversión de: FA-E 00002-00000005");
        expect(picture).toInclude("ref: Venta cancelada");
        expect(picture).toInclude("NOTIFICATIONS: Se importaron 3 movimientos");
    });

    test("it never carries a password", () => {
        const fixture = getFixture();
        fixture.innerHTML = `
            <div class="o_action_manager"><div class="o_form_view">
                <div class="o_field_widget" name="smtp_user"><input value="facturas@acme.com"/></div>
                <div class="o_field_widget" name="smtp_pass"><input type="password" value="s3cr3t-smtp"/></div>
            </div></div>`;
        const picture = readScreen(fixture.ownerDocument);
        expect(picture).toInclude("smtp_user: facturas@acme.com");
        expect(picture).not.toInclude("s3cr3t-smtp");
    });

    test("it carries a menu the person opened, which lives outside the action", () => {
        const fixture = getFixture();
        fixture.innerHTML = `
            <div class="o_action_manager"><div class="o_list_view">Usuarios internos</div></div>
            <div class="o-overlay-container"><div class="o-dropdown--menu">Filtros Usuarios inactivos</div></div>
            <div class="o-tuqui-panel"><div class="o-dropdown--menu">Tuqui own menu</div></div>`;
        const picture = readScreen(fixture.ownerDocument);
        expect(picture).toInclude("OPEN MENU: Filtros Usuarios inactivos");
        expect(picture).not.toInclude("Tuqui own menu");
    });
});

class Partner extends models.Model {
    _name = "res.partner";
    name = fields.Char();
    _records = [{ id: 1, name: "Acme" }];
}
defineModels([Partner]);

describe("wait in silence: the panel", () => {
    const BASE = "https://wait.tuqui.example.com";

    async function openPanel() {
        const posted = [];
        onRpc("tuqui.assistant.sso.nonce", "embed_bootstrap", () => ({ connected: true, base_url: BASE, slug: "acme" }));
        onRpc("tuqui.assistant.sso.nonce", "issue_for_current_user", () => ({ nonce: "n1", client_id: "cid" }));
        patchWithCleanup(TuquiPanel.prototype, {
            get embedUrl() {
                return "about:blank";
            },
        });
        await mountWithCleanup(MainComponentsContainer);
        getService("tuquiAssistant").toggleVisibility();
        await animationFrame();
        const frame = document.querySelector(".o-tuqui-iframe").contentWindow;
        frame.postMessage = (message) => posted.push(message);
        const spaSends = async (data) => {
            window.dispatchEvent(new MessageEvent("message", { data: { source: "tuqui-spa", ...data }, origin: BASE, source: frame }));
            await animationFrame();
        };
        return { posted, spaSends };
    }

    test("wait-step listens and, once the person stops, tells the chat what happened as a step-event", async () => {
        const { posted, spaSends } = await openPanel();
        await spaSends({ type: "wait-step", payload: { proposalId: "w1", waiting_line: "Esperando", done_line: "Listo" } });
        const data = { id: 900, params: { model: "res.partner", method: "web_save", args: [[1]] } };
        // As Odoo's rpc fires them: its loading indicator reads `settings`.
        rpcBus.trigger("RPC:REQUEST", { data, url: "/web/dataset/call_kw", settings: {} });
        await animationFrame();
        rpcBus.trigger("RPC:RESPONSE", { data, settings: {}, result: true });
        await animationFrame();
        await advanceTime(QUIET_MS);
        await animationFrame();
        const told = posted.filter((m) => m.type === "step-event").map((m) => m.payload);
        expect(told.length).toBe(1);
        expect(told[0].proposal_id).toBe("w1");
        expect(told[0].outcome).toBe("happened");
        expect(told[0].happened).toEqual(["res.partner.web_save succeeded on ids 1"]);
        expect(typeof told[0].screen).toBe("string");
        // A wait is not a proposal with a verdict: no apply-result.
        expect(posted.filter((m) => m.type === "apply-result")).toEqual([]);
    });

    test("wait-cancel ends the wait: nothing is told after it", async () => {
        const { posted, spaSends } = await openPanel();
        await spaSends({ type: "wait-step", payload: { proposalId: "w2" } });
        await spaSends({ type: "wait-cancel", payload: { proposalId: "w2" } });
        const data = { id: 901, params: { model: "res.partner", method: "web_save", args: [] } };
        rpcBus.trigger("RPC:REQUEST", { data, url: "/web/dataset/call_kw", settings: {} });
        await animationFrame();
        rpcBus.trigger("RPC:RESPONSE", { data, settings: {}, result: true });
        await animationFrame();
        await advanceTime(QUIET_MS * 2);
        expect(posted.filter((m) => m.type === "step-event")).toEqual([]);
    });
});
