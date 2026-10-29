import { describe, expect, test } from "@odoo/hoot";
import { advanceTime, animationFrame } from "@odoo/hoot-mock";
import { TuquiPanel } from "@tuqui_assistant/panel/panel";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import {
    contains,
    defineModels,
    fields,
    getService,
    models,
    mountView,
    patchWithCleanup,
} from "@web/../tests/web_test_helpers";
import { collectTargets, elementFor, findByName } from "@tuqui_assistant/screen/screen_targets";
import { GOTA_TTL_MS } from "@tuqui_assistant/screen/gota";

/**
 * The drop: what the screen lists as touchable, and the mark on one of those ids.
 *
 * Each test is a trap measured on a real Odoo before this rewrite: a field behind
 * a closed tab, the save button that only exists with unsaved changes, a hidden
 * file input, a dialog covering the form, the assistant's own panel.
 *
 * How to run them: see the header of `apply_proposal.test.js`.
 */

class Partner extends models.Model {
    _name = "res.partner";

    name = fields.Char({ string: "Name" });
    email = fields.Char({ string: "Email" });
    payment_term = fields.Char({ string: "Payment Terms" });
    ref = fields.Char({ string: "Reference" });
    document = fields.Binary({ string: "Document" });
    is_vip = fields.Boolean({ string: "VIP" });

    _records = [{ id: 1, name: "Acme", email: "sales@acme.example", is_vip: true }];
}

defineModels([Partner]);

const ARCH = `
    <form>
        <sheet>
            <group>
                <field name="name"/>
                <field name="email"/>
                <field name="document"/>
                <field name="is_vip"/>
            </group>
            <notebook>
                <page name="contacts" string="Contacts"><group><field name="name" string="Contact name"/></group></page>
                <page name="sales" string="Sales &amp; Purchase"><group><field name="payment_term"/><field name="ref" invisible="1"/></group></page>
            </notebook>
        </sheet>
    </form>`;

const mountPartner = () => mountView({ type: "form", resModel: "res.partner", resId: 1, arch: ARCH });
const named = (name) => collectTargets().find((t) => t.name === name);

describe("screen targets", () => {
    test("a field is listed by the label a person reads, with its field name", async () => {
        await mountPartner();
        expect(named("Email")).toEqual({ id: named("Email").id, role: "textbox", name: "Email", field: "email" });
    });

    test("a field behind a closed tab is not listed, and the tab says it holds it", async () => {
        await mountPartner();
        expect(named("Payment Terms")).toBe(undefined);
        const tabs = getService("tuquiAssistant").getContextPayload().targets.filter((t) => t.role === "tab");
        // "Reference" sits in that tab too, but invisible: opening it would not show it.
        expect(tabs.find((t) => t.name === "Sales & Purchase").contains).toEqual(["Payment Terms"]);
        // The open tab's fields are on screen already.
        expect(tabs.find((t) => t.name === "Contacts").contains).toBe(undefined);
    });

    test("the save button is listed only once there is something to save", async () => {
        await mountPartner();
        expect(named("Save manually")).toBe(undefined);
        await contains(".o_field_widget[name=email] input").edit("billing@acme.example");
        await animationFrame();
        expect(named("Save manually").role).toBe("button");
    });

    test("a hidden file input is not listed; the button that opens it is", async () => {
        await mountPartner();
        const listed = collectTargets().map((t) => elementFor(t.id));
        expect(listed.some((el) => el.matches("input[type=file]"))).toBe(false);
        expect(collectTargets().some((t) => t.field === "document" && t.role === "button")).toBe(true);
    });

    test("with a dialog open, only the dialog can be touched", async () => {
        await mountPartner();
        getService("dialog").add(ConfirmationDialog, { body: "Archive?", confirm: () => {} });
        await animationFrame();
        expect(named("Email")).toBe(undefined);
        expect(named("Ok").role).toBe("button");
    });

    test("a checkbox says whether it is ticked", async () => {
        // Measured on 29/09: a setting that was already on got marked as "tick it",
        // and the person following the drop switched it off.
        await mountPartner();
        expect(named("VIP").checked).toBe(true);
        await contains(".o_field_widget[name=is_vip] input").click();
        expect(named("VIP").checked).toBe(false);
    });

    test("with two labels for one control, the one with text names it", async () => {
        // Odoo's settings put an empty label next to the box and the title in a second one.
        await mountPartner();
        const box = document.createElement("div");
        box.innerHTML = `<input type="checkbox" id="gs1"><label for="gs1"></label><label for="gs1">Print GS1 barcodes</label>`;
        document.querySelector(".o_form_view").appendChild(box);
        expect(named("Print GS1 barcodes").role).toBe("checkbox");
        box.remove();
    });

    test("the assistant's own panel is not part of the screen", async () => {
        await mountPartner();
        const panel = document.createElement("div");
        panel.className = "o-tuqui-panel";
        panel.innerHTML = "<button>Open in Tuqui</button>";
        document.body.appendChild(panel);
        expect(named("Open in Tuqui")).toBe(undefined);
        panel.remove();
    });

    test("a header button says the method it runs; an action button does not", async () => {
        await mountView({
            type: "form",
            resModel: "res.partner",
            resId: 1,
            arch: `
                <form>
                    <header>
                        <button name="action_confirm" string="Confirm" type="object"/>
                        <button name="42" string="Credit Note" type="action"/>
                        <button name="sale.action_report_saleorder" string="Print" type="action"/>
                    </header>
                    <sheet>
                        <div class="oe_button_box" name="button_box">
                            <button name="action_view_orders" string="Orders" type="object" class="oe_stat_button"/>
                        </div>
                        <button name="action_in_sheet" string="Recompute" type="object"/>
                        <group><field name="name"/></group>
                    </sheet>
                </form>`,
        });
        expect(named("Confirm").method).toBe("action_confirm");
        expect(named("Credit Note").method).toBe(undefined);
        expect(named("Print").method).toBe(undefined);
        expect(named("Name").method).toBe(undefined);
        // Outside the header: a smart button navigates, a sheet button may run on a line.
        expect(named("Orders").method).toBe(undefined);
        expect(named("Recompute").method).toBe(undefined);
    });

    test("a dialog's header button does not name its method", async () => {
        await mountPartner();
        // A form opened in a dialog runs on another model than the one behind it.
        const dialog = document.createElement("div");
        dialog.className = "o_dialog";
        dialog.innerHTML = `<div class="modal-content"><div class="o_form_statusbar">
            <button name="action_apply" type="object">Apply</button></div></div>`;
        document.body.appendChild(dialog);
        expect(named("Apply")).not.toBe(undefined);
        expect(named("Apply").method).toBe(undefined);
        dialog.remove();
    });

    test("an id stops pointing once its control left the screen", async () => {
        await mountPartner();
        const { id } = named("Email");
        elementFor(id).remove();
        expect(elementFor(id)).toBe(null);
    });
});

describe("the drop", () => {
    test("marks the control, and goes away when the person clicks it", async () => {
        await mountPartner();
        expect(getService("tuquiAssistant").point({ target: named("Email").id })).toBe(true);
        await animationFrame();
        expect(".o_tuqui_gota").toHaveCount(1);
        await contains(".o_field_widget[name=email] input").click();
        expect(".o_tuqui_gota").toHaveCount(0);
    });

    test("does not mark a control left behind an open dialog", async () => {
        await mountPartner();
        const email = named("Email");
        getService("dialog").add(ConfirmationDialog, { body: "Archive?", confirm: () => {} });
        await animationFrame();
        expect(getService("tuquiAssistant").point({ target: email.id })).toBe(false);
        await animationFrame();
        expect(".o_tuqui_gota").toHaveCount(0);
        // It is still there, behind: the person is told to close the dialog.
        expect(".o_notification").toHaveText(/behind the open dialog/);
    });

    // e2e 12/10: Tuqui marked again the field the person was choosing from; the scroll to
    // centre it closed their open list of options.
    test("a control already in view is marked without moving the page", async () => {
        await mountPartner();
        let scrolled = 0;
        patchWithCleanup(Element.prototype, {
            scrollIntoView() {
                scrolled++;
            },
        });
        getService("tuquiAssistant").pointByName({ name: "Email" });
        await animationFrame();
        expect(".o_tuqui_gota").toHaveCount(1);
        expect(scrolled).toBe(0);
    });

    test("goes away on its own after a while", async () => {
        await mountPartner();
        getService("tuquiAssistant").point({ target: named("Email").id });
        await animationFrame();
        expect(".o_tuqui_gota").toHaveCount(1);
        await advanceTime(GOTA_TTL_MS);
        await animationFrame();
        expect(".o_tuqui_gota").toHaveCount(0);
    });

    test("draws nothing for an id the screen did not list", async () => {
        await mountPartner();
        expect(getService("tuquiAssistant").point({ target: "t999" })).toBe(false);
        await animationFrame();
        expect(".o_tuqui_gota").toHaveCount(0);
    });

    test("points up from below the control, even on a wide field", async () => {
        await mountPartner();
        getService("tuquiAssistant").point({ target: named("Email").id });
        await animationFrame();
        expect(".o_tuqui_gota").toHaveClass("o_bottom");
    });

    test("a read the chat was not sent does not move the ids it holds", async () => {
        await mountPartner();
        const email = named("Email");
        const extra = document.createElement("button");
        extra.textContent = "Added first";
        document.querySelector(".o_form_view").prepend(extra);
        getService("tuquiAssistant").readScreen();
        expect(getService("tuquiAssistant").point({ target: email.id, name: "Email", role: "textbox" })).toBe(true);
        await animationFrame();
        expect(".o_tuqui_gota").toHaveCount(1);
        extra.remove();
    });

    test("follows the control by name and role when a newer list moved its id", async () => {
        // The person opened something while the agent was thinking, and a newer
        // list renumbered the screen: the id the agent chose is somebody else now.
        await mountPartner();
        const email = named("Email");
        const extra = document.createElement("button");
        extra.textContent = "Added first";
        document.querySelector(".o_form_view").prepend(extra);
        collectTargets();
        expect(getService("tuquiAssistant").point({ target: email.id, name: "Email", role: "textbox" })).toBe(true);
        await animationFrame();
        expect(".o_tuqui_gota").toHaveCount(1);
        extra.remove();
    });

    test("draws nothing when no control on screen has that name and role", async () => {
        await mountPartner();
        const { id } = named("Email");
        expect(getService("tuquiAssistant").point({ target: id, name: "Fax", role: "textbox" })).toBe(false);
        await animationFrame();
        expect(".o_tuqui_gota").toHaveCount(0);
    });
});

describe("the drop by name, on the screen as it is now", () => {
    // Two cards (sections) that repeat a button, as a dashboard does.
    const CARDS = `
        <div class="o_setting_box" data-string="Banco Uno"><button type="button">Importar</button><button type="button">Importar extracto</button></div>
        <div class="o_setting_box" data-string="Banco Dos"><button type="button">Importar</button></div>`;
    const withCards = () => {
        const box = document.createElement("div");
        box.innerHTML = CARDS;
        document.querySelector(".o_form_view").prepend(box);
        return box;
    };

    test("marks a control nobody listed before: it reads the screen when asked", async () => {
        await mountPartner();
        const answer = getService("tuquiAssistant").pointByName({ name: "email" });
        expect(answer.status).toBe("marked");
        await animationFrame();
        expect(".o_tuqui_gota").toHaveCount(1);
    });

    // 14/10, ticket 118094: Tuqui marked a many2one's «Enlace interno», which shows only on
    // hover under the field's input: nobody can click it.
    test("a control covered by something else is not on screen", async () => {
        await mountPartner();
        const box = document.createElement("div");
        box.innerHTML = `
            <div style="position: relative; width: 200px; height: 40px">
                <button type="button" style="position: absolute; inset: 0">Enlace interno</button>
                <div style="position: absolute; inset: 0; background: white">encima</div>
            </div>`;
        document.querySelector(".o_form_view").prepend(box);
        expect(getService("tuquiAssistant").pointByName({ name: "Enlace interno" }).status).toBe("missing");
        box.remove();
    });

    // 14/10, ticket 118094: Odoo's «Faltan algunos campos obligatorios» sat on the «Aplicar» of
    // the first rows, and Tuqui could no longer point at the one the person needed.
    test("a passing notification does not hide what is under it", async () => {
        await mountPartner();
        const box = document.createElement("div");
        box.innerHTML = `
            <div style="position: relative; width: 200px; height: 40px">
                <button type="button" style="position: absolute; inset: 0">Aplicar</button>
                <div class="o_notification_manager" style="position: fixed; inset: 0; z-index: 10; background: white">
                    <div class="o_notification">Faltan algunos campos obligatorios</div>
                </div>
            </div>`;
        document.querySelector(".o_form_view").prepend(box);
        expect(getService("tuquiAssistant").pointByName({ name: "Aplicar" }).status).toBe("marked");
        box.remove();
    });

    // 14/10, ticket 118094: a new row scrolled the list to its end, the first rows went under
    // the sticky header, and their «Aplicar» dropped out of the list. Scrolling reaches them.
    test("what scrolled under a sticky header is still on screen", async () => {
        await mountPartner();
        const box = document.createElement("div");
        box.innerHTML = `
            <div class="o-test-scroller" style="height: 60px; overflow: auto">
                <div style="position: sticky; top: 0; height: 30px; background: white; z-index: 1">cabecera</div>
                <div style="height: 200px"><button type="button" style="height: 20px">Aplicar fila</button></div>
            </div>`;
        document.querySelector(".o_form_view").prepend(box);
        box.querySelector(".o-test-scroller").scrollTop = 20;
        expect(getService("tuquiAssistant").pointByName({ name: "Aplicar fila" }).status).toBe("marked");
        box.remove();
    });

    // 14/10, ticket 118094: the «Aplicar» of each row sat under the floating panel, where nobody
    // could touch it. The panel docks to the side, which makes room, and the mark goes on.
    test("what sits under Tuqui's own panel is marked, and the panel makes room", async () => {
        await mountPartner();
        const service = getService("tuquiAssistant");
        const box = document.createElement("div");
        box.innerHTML = `
            <div style="position: relative; width: 200px; height: 40px">
                <button type="button" style="position: absolute; inset: 0">Cerrar detalle</button>
                <div class="o-tuqui-panel" style="position: fixed; inset: 0; z-index: 10; background: white"></div>
            </div>`;
        document.querySelector(".o_form_view").prepend(box);
        expect(service.state.expanded).toBe(false);
        expect(service.pointByName({ name: "Cerrar detalle" }).status).toBe("marked");
        expect(service.state.expanded).toBe(true);
        box.remove();
    });

    // 15/10: the floating panel stayed over the price list rule while the person had to type in
    // a field under it. Guiding a step docks the panel aside, so none of the screen is under it.
    test("guiding a step docks the panel aside, even when the step is not under it", async () => {
        await mountPartner();
        const service = getService("tuquiAssistant");
        expect(service.state.expanded).toBe(false);
        expect(service.pointByName({ name: "email" }).status).toBe("marked");
        expect(service.state.expanded).toBe(true);
    });

    // 15/10: Tuqui marked «Nuevo» by its id from the list sent to the chat, and that path never
    // docked the panel.
    test("a step marked by its id docks the panel aside too", async () => {
        await mountPartner();
        const service = getService("tuquiAssistant");
        expect(service.state.expanded).toBe(false);
        expect(service.point({ target: named("Email").id })).toBe(true);
        expect(service.state.expanded).toBe(true);
    });

    // 15/10, Reabastecimiento: marking «Automatizar» docked the panel, the list got narrower and
    // the button ended past its right edge; the drop was drawn over the panel.
    test("a control the list cuts off sideways after it was marked is scrolled back into view", async () => {
        await mountPartner();
        const box = document.createElement("div");
        box.innerHTML = `
            <div class="wide" style="overflow-x: auto; width: 1000px">
                <div style="width: 900px; position: relative; height: 40px">
                    <button type="button" style="position: absolute; left: 800px">Automatizar</button>
                </div>
            </div>`;
        document.querySelector(".o_form_view").prepend(box);
        const scroller = box.querySelector(".wide");
        expect(getService("tuquiAssistant").pointByName({ name: "Automatizar" }).status).toBe("marked");
        scroller.style.width = "300px";
        await advanceTime(1000);
        await animationFrame();
        expect(scroller.scrollLeft).toBeGreaterThan(0);
        box.remove();
    });

    // 14/10, ticket 118094: the panel docked aside and the list moved left, but the drop stayed
    // where the control had been, over the panel.
    test("the drop follows a control that moves", async () => {
        await mountPartner();
        const box = document.createElement("div");
        box.innerHTML = `<button type="button" style="margin-left: 0">Mover</button>`;
        document.querySelector(".o_form_view").prepend(box);
        getService("tuquiAssistant").pointByName({ name: "Mover" });
        await advanceTime(1000);
        await animationFrame();
        const centerX = (el) => { const b = el.getBoundingClientRect(); return b.left + b.width / 2; };
        const button = box.querySelector("button");
        expect(Math.abs(centerX(document.querySelector(".o_tuqui_gota")) - centerX(button))).toBeLessThan(30);
        button.style.marginLeft = "300px";
        await advanceTime(1000);
        await animationFrame();
        await animationFrame();
        expect(Math.abs(centerX(document.querySelector(".o_tuqui_gota")) - centerX(button))).toBeLessThan(30);
        box.remove();
    });

    // 15/10: Tuqui walked the person through «Más» → «Más» with a drop per menu, where the drop
    // does worst (menus open and close). A menu of the app is a way to a screen, not a step.
    test("a menu of the app is not marked: it is answered as navigation", async () => {
        await mountPartner();
        patchWithCleanup(getService("menu"), { getAll: () => [{ xmlid: "stock.menu_stock_warehouse_mgmt", actionModel: false }] });
        const box = document.createElement("div");
        box.innerHTML = `<a href="#" data-menu-xmlid="stock.menu_stock_warehouse_mgmt">Operaciones</a>`;
        document.querySelector(".o_form_view").prepend(box);
        expect(getService("tuquiAssistant").pointByName({ name: "Operaciones" }).status).toBe("navigation");
        await animationFrame();
        expect(".o_tuqui_gota").toHaveCount(0);
        box.remove();
    });

    test("a way to another screen or out of Odoo is flagged, for the list Tuqui reads to leave it out", async () => {
        await mountPartner();
        const box = document.createElement("div");
        box.innerHTML = `<a href="#" data-menu-xmlid="stock.menu_stock_warehouse_mgmt">Operaciones</a>
            <a href="https://www.odoo.com/documentation" target="_blank">Documentación</a>`;
        document.querySelector(".o_form_view").prepend(box);
        expect(named("Operaciones").nav).toBe(true);
        expect(named("Documentación").nav).toBe(true);
        expect(named("Email").nav).toBe(undefined);
        box.remove();
    });

    test("says it is not there, and marks nothing", async () => {
        await mountPartner();
        expect(getService("tuquiAssistant").pointByName({ name: "Fax" })).toEqual({
            status: "missing",
            places: [],
            applied: [],
            skipped: [],
            message: "",
        });
        await animationFrame();
        expect(".o_tuqui_gota").toHaveCount(0);
    });

    test("a repeated name is not guessed: it says where each one is", async () => {
        await mountPartner();
        const box = withCards();
        const answer = getService("tuquiAssistant").pointByName({ name: "Importar" });
        expect(answer.status).toBe("ambiguous");
        expect(answer.places).toEqual(["Banco Uno", "Banco Dos"]);
        await animationFrame();
        expect(".o_tuqui_gota").toHaveCount(0);
        box.remove();
    });

    test("with the section, it marks the one in that section", async () => {
        await mountPartner();
        const box = withCards();
        const answer = getService("tuquiAssistant").pointByName({ name: "Importar", section: "banco dos" });
        expect(answer).toMatchObject({ status: "marked", places: ["Banco Dos"] });
        box.remove();
    });

    test("a section that does not have it says where it is instead", async () => {
        await mountPartner();
        const box = withCards();
        const answer = getService("tuquiAssistant").pointByName({ name: "Importar", section: "Caja" });
        expect(answer).toMatchObject({ status: "missing", places: ["Banco Uno", "Banco Dos"] });
        box.remove();
    });

    test("the whole name wins over a longer one that contains it", async () => {
        await mountPartner();
        const box = withCards();
        box.lastElementChild.remove(); // only "Banco Uno": "Importar" and "Importar extracto"
        expect(getService("tuquiAssistant").pointByName({ name: "Importar" })).toMatchObject({ status: "marked" });
        await animationFrame();
        expect(".o_tuqui_gota").toHaveCount(1);
        box.remove();
    });

    // Measured on Odoo 19: the search box is a magnifier button and an input that both
    // answer to "Buscar…", and a list row is not a control (07/10).
    const place = (html) => {
        const box = document.createElement("div");
        box.innerHTML = html;
        document.querySelector(".o_form_view").prepend(box);
        return box;
    };

    test("the parts of one widget are one: it marks the biggest, the search input", async () => {
        await mountPartner();
        const box = place(`<div class="o_searchview"><button type="button" aria-label="Buscar…"><i class="oi oi-search"></i></button>
            <div class="o_searchview_input_container"><input type="text" placeholder="Buscar…" style="width: 300px"/></div></div>`);
        const { found } = findByName("Buscar…");
        expect(found.length).toBe(1);
        expect(found[0].el.tagName).toBe("INPUT");
        expect(getService("tuquiAssistant").pointByName({ name: "Buscar…" })).toMatchObject({ status: "marked" });
        box.remove();
    });

    test("the same name in two separate places is still two, even without a section", async () => {
        await mountPartner();
        const card = `<div class="o_kanban_record"><div><div><button type="button">Importar</button></div></div></div>`;
        const box = place(`${card}${card}`);
        expect(getService("tuquiAssistant").pointByName({ name: "Importar" })).toMatchObject({ status: "ambiguous" });
        box.remove();
    });

    test("an entry of an open dropdown beats the same name on the page beneath", async () => {
        // Odoo 19: Inventario > Operaciones open, «Recepciones» is a menu entry and a dashboard card's title.
        await mountPartner();
        const box = place(`<div class="o_kanban_record"><a href="#">Recepciones</a></div>`);
        const overlay = document.createElement("div");
        overlay.className = "o-overlay-container";
        overlay.innerHTML = `<div class="o-dropdown--menu"><a role="menuitem" class="dropdown-item" data-menu-xmlid="stock.in_picking" href="#">Recepciones</a></div>`;
        document.body.append(overlay);
        const { found } = findByName("Recepciones");
        overlay.remove();
        box.remove();
        expect(found.map(({ el }) => el.dataset.menuXmlid)).toEqual(["stock.in_picking"]);
    });

    for (const [what, xmlid, actionModel, status] of [
        ["runs a server action", "stock.in_picking", "ir.actions.server", "marked"],
        ["the menu service does not know", "", "ir.actions.act_window", "marked"],
        ["opens a screen", "stock.in_picking", "ir.actions.act_window", "navigation"],
    ]) {
        test(`a menu entry that ${what} is ${status}`, async () => {
            // Tuqui clicks only what opens a screen; Odoo 19's «Recepciones» runs a
            // server action, so the walk leaves it on screen and its click is the person's step.
            await mountPartner();
            patchWithCleanup(getService("menu"), { getAll: () => [{ xmlid: "stock.in_picking", actionModel }] });
            const overlay = document.createElement("div");
            overlay.className = "o-overlay-container";
            overlay.innerHTML = `<div class="o-dropdown--menu"><a role="menuitem" class="dropdown-item" data-menu-xmlid="${xmlid}" href="#">Recepciones</a></div>`;
            document.body.append(overlay);
            const answer = getService("tuquiAssistant").pointByName({ name: "Recepciones" });
            overlay.remove();
            expect(answer).toMatchObject({ status });
        });
    }

    test("a list row is marked by its text when no control has that name", async () => {
        await mountPartner();
        const box = place(`<table><tbody><tr class="o_data_row"><td class="o_data_cell">Sample Statement</td></tr>
            <tr class="o_data_row"><td class="o_data_cell">Supervielle</td></tr></tbody></table>`);
        const { found } = findByName("Supervielle");
        expect(found.map(({ target, el }) => [target.role, el.textContent])).toEqual([["record", "Supervielle"]]);
        expect(getService("tuquiAssistant").pointByName({ name: "Supervielle" })).toMatchObject({ status: "marked" });
        box.remove();
    });

    // Measured on Odoo 19 (12/10): sorted lists start with an empty drag-handle cell, and a
    // click there does not open the record; the mark pointed at it.
    // Measured e2e (12/10): with «Equipo de pruebas» already in the list, Tuqui asked to
    // search for it: the screen it read had the buttons and no rows.
    test("the rows on screen are listed too, by their text, so Tuqui sees what is already there", async () => {
        await mountPartner();
        const box = place(`<table><tbody><tr class="o_data_row"><td class="o_data_cell">Equipo de pruebas</td><td class="o_data_cell">Marc Demo</td></tr></tbody></table>`);
        expect(collectTargets().find((t) => t.role === "record")).toMatchObject({ name: "Equipo de pruebas Marc Demo" });
        // Listed and still one match by name: the row is not counted twice.
        expect(getService("tuquiAssistant").pointByName({ name: "Equipo de pruebas Marc Demo" })).toMatchObject({ status: "marked" });
        box.remove();
    });

    test("a row is marked on its first cell with text, not on the drag handle", async () => {
        await mountPartner();
        const box = place(`<table><tbody><tr class="o_data_row"><td class="o_data_cell o_handle_cell"><span class="o_row_handle"></span></td>
            <td class="o_data_cell">Equipo de pruebas</td></tr></tbody></table>`);
        const { found } = findByName("Equipo de pruebas");
        expect(found[0].el.textContent).toBe("Equipo de pruebas");
        box.remove();
    });

    test("a row named exactly so wins over a button that only contains the name", async () => {
        await mountPartner();
        const box = place(`<button type="button">Importar Supervielle</button>
            <table><tbody><tr class="o_data_row"><td class="o_data_cell">Supervielle</td></tr></tbody></table>`);
        expect(findByName("Supervielle").found.map(({ target }) => target.role)).toEqual(["record"]);
        box.remove();
    });

    // Measured on Odoo 19 (12/10): a tab's content carries no name of its own,
    // so "Agregar Vendedores" in the open "Miembros" tab was missing for that section;
    // and that link is a div styled as a button, with no role.
    test("a control in the open tab is found by the tab's name, even inside a group", async () => {
        await mountPartner();
        expect(getService("tuquiAssistant").pointByName({ name: "Contact name", section: "Contacts" })).toMatchObject({
            status: "marked",
            places: ["Contacts"],
        });
    });

    test("anything styled as a button is a control, named by its text", async () => {
        await mountPartner();
        const add = document.createElement("div");
        add.className = "btn btn-link";
        add.textContent = "Agregar Vendedores";
        document.querySelector(".o_notebook .tab-pane").append(add);
        expect(named("Agregar Vendedores")).toMatchObject({ role: "button", section: "Contacts" });
    });

    // e2e 12/10: marking on a record opened in the same call, Tuqui guessed «Se puede vender»
    // and Odoo 19 labels that box «Ventas»; the field it knew from the data is sale_ok.
    test("with no control of that name, the field it names is marked", async () => {
        await mountPartner();
        expect(getService("tuquiAssistant").pointByName({ name: "Se puede vender", field: "email" })).toMatchObject({
            status: "marked",
        });
        expect(getService("tuquiAssistant").pointByName({ name: "Se puede vender" })).toMatchObject({ status: "missing" });
    });

    // 15/10, price list rule: «Descuento» is both a price type option and the percent field.
    // Tuqui named the field (percent_price) and a section the screen does not have, and the
    // field never broke the tie: nothing was marked.
    test("two controls with the same name: the field it names says which one", async () => {
        await mountView({
            type: "form",
            resModel: "res.partner",
            resId: 1,
            arch: `<form><sheet><group><field name="email"/><field name="ref" string="Email"/></group></sheet></form>`,
        });
        const service = getService("tuquiAssistant");
        expect(service.pointByName({ name: "Email" }).status).toBe("ambiguous");
        for (const section of ["", "no section"]) {
            const { found } = findByName("Email", section, document, "ref");
            expect(found.map(({ el }) => el.closest("[name]").getAttribute("name"))).toEqual(["ref"]);
        }
        expect(service.pointByName({ name: "Email", field: "ref", section: "Crear reglas" }).status).toBe("marked");
    });

    test("part of a longer name only counts when nothing has the whole name", async () => {
        await mountPartner();
        const box = withCards();
        expect(getService("tuquiAssistant").pointByName({ name: "extracto" })).toMatchObject({
            status: "marked",
            places: ["Banco Uno"],
        });
        box.remove();
    });
});

describe("the panel keeps the latest reading of the screen", () => {
    test("when the list did not change, it still keeps the new nodes for point", () => {
        // A re-render can swap the nodes and leave the same list: point must not
        // resolve against nodes that left the page.
        const screen = { targets: [{ id: "t1", role: "button", name: "Ok" }] };
        const remembered = [];
        const posted = [];
        const panel = {
            ui: { connected: true, embedReady: true },
            _postedTargets: JSON.stringify(screen.targets),
            tuquiAssistant: { readScreen: () => screen, rememberScreen: (s) => remembered.push(s) },
            _postContext: (s) => posted.push(s),
        };
        TuquiPanel.prototype._postContextIfScreenChanged.call(panel);
        expect(posted).toEqual([]);
        expect(remembered).toEqual([screen]);
    });
});

// Measured e2e (12/10): Tuqui said it opened a record and Odoo showed a list, since
// browse could not open one record. With its id, its form opens.
describe("opening a screen for the user", () => {
    const opened = async (payload) => {
        await mountPartner();
        const actions = [];
        patchWithCleanup(getService("action"), {
            doAction: async (request, options) => actions.push({ request, options }),
        });
        await getService("tuquiAssistant").navigate(payload);
        return actions[0];
    };

    test("mode record opens that record's form", async () => {
        const { request, options } = await opened({ model: "res.partner", mode: "record", resId: 1 });
        expect(request).toMatchObject({ res_model: "res.partner", res_id: 1 });
        expect(request.views[0]).toEqual([false, "form"]);
        expect(options.viewType).toBe("form");
    });

    test("without one, a form asked for in browse still opens the filtered list", async () => {
        const { request } = await opened({ model: "res.partner", mode: "browse", viewType: "form", domain: [] });
        expect(request.res_id).toBe(undefined);
        expect(request.views[0]).toEqual([false, "list"]);
    });
});

// Measured on Odoo 19 (12/10): a form opened by the chat draws its fields
// between 300 ms and 1 s later, and a mark sent meanwhile found nothing.
describe("the drop by name, once it is there", () => {
    // Each look schedules the next one only once the last resolved: the clock moves a look at a time.
    const waitFor = async (ms) => {
        for (let passed = 0; passed < ms; passed += 200) {
            await advanceTime(200);
            await animationFrame();
        }
    };

    test("a control that is not drawn yet is looked for again while the screen loads", async () => {
        await mountPartner();
        let answer = null;
        getService("tuquiAssistant").pointWhenThere({ name: "Teléfono" }).then((a) => (answer = a));
        await waitFor(400);
        expect(answer).toBe(null);
        const late = document.createElement("button");
        late.textContent = "Teléfono";
        document.querySelector(".o_form_view").prepend(late);
        await waitFor(400);
        expect(answer.status).toBe("marked");
    });

    test("one that never shows up is answered missing after a short while", async () => {
        await mountPartner();
        let answer = null;
        getService("tuquiAssistant").pointWhenThere({ name: "Fax" }).then((a) => (answer = a));
        await waitFor(1000);
        expect(answer).toBe(null);
        await waitFor(3000);
        expect(answer.status).toBe("missing");
    });

    // Measured on Odoo 19 (16/10): «Import File» of a bank lives in the ⋮ of its
    // card on the accounting dashboard, and exists only while that menu is open.
    test("an entry of a card's ⋮ is marked once the ⋮ is opened; one the ⋮ does not hold closes it, even if named elsewhere", async () => {
        await mountPartner();
        const box = document.createElement("div");
        box.innerHTML = `<div class="o_kanban_record"><div><span>Banco Uno</span></div>
            <div class="o_dropdown_kanban"><button type="button" class="btn o-dropdown dropdown-toggle">⋮</button></div></div>`;
        document.querySelector(".o_form_view").prepend(box);
        let menu = null;
        box.querySelector(".dropdown-toggle").addEventListener("click", () => {
            if (menu) {
                menu.remove();
                menu = null;
                return;
            }
            menu = document.createElement("div");
            // Odoo's open menu is `dropdown-menu d-block`: Bootstrap hides a bare `dropdown-menu`.
            menu.className = "o-dropdown--menu dropdown-menu d-block";
            menu.innerHTML = `<a class="dropdown-item" href="#">Import File</a>`;
            // Inside the fixture: Hoot's own UI covers whatever is appended to the body.
            document.querySelector(".o_form_view").prepend(menu);
        });
        const service = getService("tuquiAssistant");
        let answer = null;
        service.pointWhenThere({ name: "Import File", section: "Banco Uno" }).then((a) => (answer = a));
        await waitFor(400);
        expect(answer.status).toBe("marked");
        expect(menu).not.toBe(null);
        menu.remove();
        menu = null;

        // Seen on the demo (16/10): asked for «Actions menu» of a bank card, the drop opened
        // the card's ⋮ and then marked the ⚙ «Actions menu» at the top of the page. The
        // answer now says what the ⋮ holds, so the model can ask for the entry.
        const elsewhere = document.createElement("button");
        elsewhere.textContent = "Actions menu";
        document.querySelector(".o_form_view").append(elsewhere);
        answer = null;
        service.pointWhenThere({ name: "Actions menu", section: "Banco Uno" }).then((a) => (answer = a));
        await waitFor(4000);
        expect(answer.status).toBe("missing");
        expect(answer.message).toInclude("Import File");
        expect(menu).toBe(null);
        box.remove();
        elsewhere.remove();
    });

    // In production the drop missed controls that live in a closed dropdown of the
    // view («Agrupar por», the measures, the actions): they are not on the page until it opens.
    test("a control in a closed dropdown of the view is marked with that dropdown open; the others are left closed", async () => {
        await mountPartner();
        const bar = document.createElement("div");
        bar.className = "o_control_panel";
        const menus = { Filtros: "Mis oportunidades", "Agrupar por": "Etapa" };
        const opened = [];
        for (const [label, entry] of Object.entries(menus)) {
            const toggle = document.createElement("button");
            toggle.textContent = label;
            toggle.setAttribute("aria-expanded", "false");
            let menu = null;
            toggle.addEventListener("click", () => {
                if (menu) {
                    menu.remove();
                    menu = null;
                    toggle.setAttribute("aria-expanded", "false");
                    return;
                }
                opened.push(label);
                menu = document.createElement("div");
                menu.className = "o-dropdown--menu dropdown-menu d-block";
                menu.innerHTML = `<span role="menuitem" class="dropdown-item">${entry}</span>`;
                document.querySelector(".o_form_view").prepend(menu);
                toggle.setAttribute("aria-expanded", "true");
            });
            bar.append(toggle);
        }
        document.querySelector(".o_form_view").prepend(bar);
        let answer = null;
        getService("tuquiAssistant").pointWhenThere({ name: "Etapa" }).then((a) => (answer = a));
        await waitFor(4000);
        expect(answer.status).toBe("marked");
        expect(opened).toEqual(["Filtros", "Agrupar por"]);
        expect([...bar.children].map((t) => t.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
        bar.remove();
    });

    // e2e 12/10: Tuqui opened a record and forgot to mark its step; now one message
    // opens the record and marks the control on it.
    test("with a record to open, it opens that record's form first, then marks", async () => {
        await mountPartner();
        const actions = [];
        patchWithCleanup(getService("action"), {
            doAction: async (request) => actions.push(request),
        });
        const answer = await getService("tuquiAssistant").pointWhenThere({ name: "Email", open: { model: "res.partner", resId: 1 } });
        expect(actions[0]).toMatchObject({ res_model: "res.partner", res_id: 1 });
        expect(answer.status).toBe("marked");
    });
});

// 13/10, ticket 118094: «Aplicar» repeats once per row of the physical inventory, and the
// mark could not tell the Mesa plegable row from the others.
describe("a button inside a row", () => {
    const ROWS = `
        <table><tbody>
            <tr class="o_data_row"><td class="o_data_cell">Mesa plegable</td><td><button type="button">Aplicar</button></td></tr>
            <tr class="o_data_row"><td class="o_data_cell">Silla ergonómica</td><td><button type="button">Aplicar</button></td></tr>
        </tbody></table>`;

    // 14/10, ticket 118094: marking the Mesa plegable row put the click on its date, which
    // opened a calendar instead of the counted quantity.
    test("a field of a row is its cell, told apart by the row", async () => {
        await mountPartner();
        const box = document.createElement("div");
        box.innerHTML = `
            <table><tbody>
                <tr class="o_data_row"><td class="o_data_cell" name="date">31 dic</td><td class="o_data_cell" name="product_id">Mesa plegable</td><td class="o_data_cell" name="inventory_quantity">0,00</td></tr>
                <tr class="o_data_row"><td class="o_data_cell" name="date">31 dic</td><td class="o_data_cell" name="product_id">Silla ergonómica</td><td class="o_data_cell" name="inventory_quantity">0,00</td></tr>
            </tbody></table>`;
        document.querySelector(".o_form_view").prepend(box);
        const answer = getService("tuquiAssistant").pointByName({ name: "Cantidad contada", field: "inventory_quantity", section: "Mesa plegable" });
        expect(answer.status).toBe("marked");
        expect(answer.places[0].startsWith("31 dic Mesa plegable")).toBe(true);
        // 14/10: the row itself matched as the field and, being bigger, won: the drop sat under
        // the middle of the row, on another column.
        const { found } = findByName("Cantidad contada", "Mesa plegable", document, "inventory_quantity");
        expect(found.map(({ el }) => el.tagName)).toEqual(["TD"]);
        box.remove();
    });

    // 14/10, ticket 118094: the row Odoo had just added started with «31 dic», a date every
    // row carries, so «31 dic» picked the other rows' «Producto» and never the new one.
    test("a row that starts with the section wins over rows that only contain it", async () => {
        await mountPartner();
        const box = document.createElement("div");
        box.innerHTML = `
            <table><tbody>
                <tr class="o_data_row"><td class="o_data_cell" name="location_id">WH/Stock</td><td class="o_data_cell" name="product_id">Silla ergonómica</td><td class="o_data_cell" name="date">31 dic</td></tr>
                <tr class="o_data_row"><td class="o_data_cell" name="date">31 dic</td><td class="o_data_cell" name="product_id"><input type="text"/></td></tr>
            </tbody></table>`;
        document.querySelector(".o_form_view").prepend(box);
        const answer = getService("tuquiAssistant").pointByName({ name: "Producto", field: "product_id", section: "31 dic" });
        expect(answer.status).toBe("marked");
        expect(answer.places[0].startsWith("31 dic")).toBe(true);
        box.remove();
    });

    // 14/10, ticket 118094: the empty «Producto» of a new row had no name of its own, so it was
    // left out of what Tuqui could point at. A person reads it by its column.
    test("an empty field of a row is named by its column", async () => {
        await mountPartner();
        const box = document.createElement("div");
        box.innerHTML = `
            <table>
                <thead><tr><th data-name="product_id">Producto</th></tr></thead>
                <tbody><tr class="o_data_row"><td class="o_data_cell" name="product_id"><input type="text"/></td></tr></tbody>
            </table>`;
        document.querySelector(".o_form_view").prepend(box);
        expect(getService("tuquiAssistant").pointByName({ name: "Producto" }).status).toBe("marked");
        box.remove();
    });

    test("belongs to its row: the row's name tells it apart", async () => {
        await mountPartner();
        const box = document.createElement("div");
        box.innerHTML = ROWS;
        document.querySelector(".o_form_view").prepend(box);
        const service = getService("tuquiAssistant");
        const both = service.pointByName({ name: "Aplicar" });
        expect(both.status).toBe("ambiguous");
        expect(both.places.some((p) => p.startsWith("Mesa plegable"))).toBe(true);
        expect(service.pointByName({ name: "Aplicar", section: "Mesa plegable" })).toMatchObject({ status: "marked" });
        box.remove();
    });
});
