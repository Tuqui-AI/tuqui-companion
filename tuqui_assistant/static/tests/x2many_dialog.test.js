/** @odoo-module **/
import { describe, expect, test } from "@odoo/hoot";
import { queryAll, waitUntil } from "@odoo/hoot-dom";
import { animationFrame } from "@odoo/hoot-mock";
import {
    contains,
    defineModels,
    fields,
    getService,
    MockServer,
    models,
    mountView,
    onRpc,
} from "@web/../tests/web_test_helpers";

/**
 * The dialog of a one2many line is the page while it is open: Odoo draws it with a
 * FormRenderer and no FormController, so without its own patch the assistant kept
 * reading the form below while the user edited the line.
 *
 * How to run: see the header of `apply_proposal.test.js`.
 */

class Line extends models.Model {
    _name = "tuqui.line";

    name = fields.Char();
    qty = fields.Integer();
    partner_id = fields.Many2one({ relation: "res.partner" });
}

class Tag extends models.Model {
    _name = "tuqui.tag";

    name = fields.Char();

    _records = [{ id: 1, name: "Blue" }];
}

class Partner extends models.Model {
    _name = "res.partner";

    name = fields.Char();
    line_ids = fields.One2many({ relation: "tuqui.line", relation_field: "partner_id" });
    tag_ids = fields.Many2many({ relation: "tuqui.tag" });

    _records = [{ id: 1, name: "Acme", line_ids: [], tag_ids: [1] }];
}

defineModels([Partner, Line, Tag]);

const ARCH = `
    <form>
        <field name="name"/>
        <field name="line_ids">
            <list><field name="name"/></list>
            <form><field name="name"/></form>
        </field>
    </form>`;

describe("a one2many line in its dialog", () => {
    test("is the page while the dialog is open, and gives it back to the form when saved", async () => {
        await mountView({ type: "form", resModel: "res.partner", resId: 1, arch: ARCH });
        const assistant = getService("tuquiAssistant");
        expect(assistant.state.context.model).toBe("res.partner");

        await contains(".o_field_x2many_list_row_add button").click();
        expect(assistant.state.context.kind).toBe("record");
        expect(assistant.state.context.model).toBe("tuqui.line");
        expect(assistant.state.context.lineOf).toEqual({ model: "res.partner", resId: 1, displayName: "Acme" });

        await contains(".modal .o_field_widget[name=name] input").edit("First line");
        expect(await assistant.saveRecord()).toBe(true);
        // The dialog closes and the list below renders the new line on the next frames.
        await waitUntil(() => queryAll(".modal").length === 0);
        await animationFrame();

        // Saved into the form below, which is the page again and still has to be saved.
        expect(".modal").toHaveCount(0);
        expect(".o_data_row").toHaveCount(1);
        expect(assistant.state.context.model).toBe("res.partner");
        expect(assistant.state.context.dirty).toBe(true);
    });
});

describe("a field focused in a line's dialog", () => {
    test("is noted for the assistant, as in a form", async () => {
        await mountView({
            type: "form",
            resModel: "res.partner",
            resId: 1,
            arch: `
                <form>
                    <field name="name"/>
                    <field name="line_ids">
                        <list><field name="name"/></list>
                        <form><field name="name"/><field name="qty"/></form>
                    </field>
                </form>`,
        });
        const assistant = getService("tuquiAssistant");
        await contains(".o_field_x2many_list_row_add button").click();
        await contains(".modal .o_field_widget[name=qty] input").click();
        expect(assistant.getContextPayload().focus).toEqual({ field: "qty", type: "integer" });
    });
});

describe("a reload while an x2many dialog is open", () => {
    test("is told, and the form reloads when the dialog closes", async () => {
        await mountView({ type: "form", resModel: "res.partner", resId: 1, arch: ARCH });
        const assistant = getService("tuquiAssistant");
        await contains(".o_field_x2many_list_row_add button").click();
        MockServer.env["res.partner"].write([1], { name: "Acme (written by Tuqui)" });

        expect(await assistant.reloadView()).toBe(false);
        await animationFrame();
        expect(".o_notification").toHaveText(/reloads when you close it/);

        // The line's dialog has a name field too: once it closes, only the form's is left.
        const names = () => queryAll(".o_field_widget[name=name] input").map((input) => input.value);
        expect(names()).toInclude("Acme");
        await contains(".modal .o_form_button_cancel").click();
        await waitUntil(() => names().join() === "Acme (written by Tuqui)");
        expect(assistant.state.context.model).toBe("res.partner");
        expect(assistant.getContextPayload().fields.name).toBe("Acme (written by Tuqui)");
    });
});

describe("a many2many record in its dialog", () => {
    test("is the page without lineOf, and saving it writes it to the database", async () => {
        onRpc("tuqui.tag", "web_save", () => expect.step("tag written"));
        await mountView({
            type: "form",
            resModel: "res.partner",
            resId: 1,
            arch: `
                <form>
                    <field name="name"/>
                    <field name="tag_ids">
                        <list><field name="name"/></list>
                        <form><field name="name"/></form>
                    </field>
                </form>`,
        });
        const assistant = getService("tuquiAssistant");

        await contains(".o_field_widget[name=tag_ids] .o_data_row .o_data_cell").click();
        expect(assistant.state.context.model).toBe("tuqui.tag");
        expect(assistant.state.context.resId).toBe(1);
        expect("lineOf" in assistant.state.context).toBe(false);

        await contains(".modal .o_field_widget[name=name] input").edit("Navy");
        expect(await assistant.saveRecord()).toBe(true);
        expect.verifySteps(["tag written"]);
        await animationFrame();
        expect(".o_notification").toHaveText(/Form saved/);
    });
});
