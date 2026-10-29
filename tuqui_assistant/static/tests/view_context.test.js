/** @odoo-module **/
import { describe, expect, test } from "@odoo/hoot";
import { animationFrame } from "@odoo/hoot-mock";
import { Component, toRaw, xml } from "@odoo/owl";
import {
    contains,
    defineModels,
    fields,
    getService,
    models,
    mountView,
    mountViewInDialog,
    mountWithCleanup,
    parseViewProps,
    patchWithCleanup,
    toggleMenuItem,
    toggleSearchBarMenu,
} from "@web/../tests/web_test_helpers";
import { registry } from "@web/core/registry";
import { Model, useModel } from "@web/model/model";
import { CallbackRecorder } from "@web/search/action_hook";
import { WithSearch } from "@web/search/with_search/with_search";
import { View } from "@web/views/view";
import { mountMainView } from "@tuqui_assistant/../tests/tuqui_test_helpers";

/**
 * `kind: "view"`: every view with a search model but the form tells the assistant
 * what the user is looking at, with what the view adds to its favorites (lists and
 * kanbans: `list_context.test.js`).
 *
 * How to run: see the header of `apply_proposal.test.js`.
 */

class Partner extends models.Model {
    _name = "res.partner";

    name = fields.Char();
    city = fields.Char();
    color = fields.Integer({ aggregator: "sum" });

    _records = [
        { id: 1, name: "Acme", color: 3 },
        { id: 2, name: "Globex", color: 5 },
    ];
}

defineModels([Partner]);

describe("kind view", () => {
    test("a pivot publishes its model, view type and rows", async () => {
        await mountMainView({
            type: "pivot",
            resModel: "res.partner",
            arch: `<pivot><field name="name" type="row"/><field name="color" type="measure"/></pivot>`,
        });
        const ctx = getService("tuquiAssistant").getContextPayload();
        expect(ctx.kind).toBe("view");
        expect(ctx.model).toBe("res.partner");
        expect(ctx.viewType).toBe("pivot");
        expect(ctx.context.pivot_row_groupby).toEqual(["name"]);
        expect(ctx.context.pivot_measures).toEqual(["color"]);
    });

    test("a filter's own context is the search's, not the view's state", async () => {
        // Planning's filters carry `planning_*` flags: a favorite saves them, but
        // they are not something the pivot shows.
        await mountMainView({
            type: "pivot",
            resModel: "res.partner",
            arch: `<pivot><field name="color" type="measure"/></pivot>`,
            searchViewArch: `<search><filter name="mine" string="Mine" domain="[]" context="{'planning_split_tool': True}"/></search>`,
            context: { search_default_mine: 1 },
        });
        const ctx = getService("tuquiAssistant").getContextPayload();
        expect(ctx.filters).toEqual(["Mine"]);
        expect(ctx.context.pivot_measures).toEqual(["color"]);
        expect("planning_split_tool" in ctx.context).toBe(false);
    });

    test("a graph publishes its measure and grouping", async () => {
        await mountMainView({
            type: "graph",
            resModel: "res.partner",
            arch: `<graph><field name="name"/><field name="color" type="measure"/></graph>`,
        });
        const ctx = getService("tuquiAssistant").getContextPayload();
        expect(ctx.kind).toBe("view");
        expect(ctx.viewType).toBe("graph");
        expect(ctx.context.graph_measure).toBe("color");
        expect(ctx.context.graph_groupbys).toEqual(["name"]);
    });

    test("a pivot row the user expands from the header travels too", async () => {
        await mountMainView({
            type: "pivot",
            resModel: "res.partner",
            arch: `<pivot><field name="color" type="measure"/></pivot>`,
        });
        await contains("tbody .o_pivot_header_cell_closed").click();
        await contains(".o-dropdown--menu .o-dropdown-item:contains(City)").click();
        expect(getService("tuquiAssistant").getContextPayload().context.pivot_row_groupby).toEqual(["city"]);
    });

    test("the search groupBy travels with the view", async () => {
        await mountMainView({
            type: "pivot",
            resModel: "res.partner",
            arch: `<pivot><field name="color" type="measure"/></pivot>`,
            groupBy: ["name"],
        });
        expect(getService("tuquiAssistant").getContextPayload().groupBy).toEqual(["name"]);
    });

    test("a form keeps its own kind", async () => {
        await mountView({
            type: "form",
            resModel: "res.partner",
            resId: 1,
            arch: `<form><field name="name"/></form>`,
        });
        expect(getService("tuquiAssistant").getContextPayload().kind).toBe("record");
    });

    test("a dashlet view keeps the form's record context", async () => {
        // A dashboard's dashlets get no recorders from the action: the page stays
        // the form around them.
        await mountView({
            type: "form",
            resModel: "res.partner",
            resId: 1,
            arch: `<form><field name="name"/></form>`,
        });
        await mountView({
            type: "pivot",
            resModel: "res.partner",
            arch: `<pivot><field name="color" type="measure"/></pivot>`,
        });
        expect(getService("tuquiAssistant").getContextPayload().kind).toBe("record");
    });

    test("a view under the form's search keeps the form's record context", async () => {
        // Knowledge embeds a view in an article's html field with a recorder of its
        // own; the embedded view inherits the form's env, search model included.
        await mountView({
            type: "form",
            resModel: "res.partner",
            resId: 1,
            arch: `<form><field name="name"/></form>`,
        });
        await mountWithCleanup(View, {
            componentEnv: { searchModel: {} },
            props: parseViewProps({
                type: "pivot",
                resModel: "res.partner",
                arch: `<pivot><field name="color" type="measure"/></pivot>`,
                __getGlobalState__: new CallbackRecorder(),
            }),
        });
        expect(getService("tuquiAssistant").getContextPayload().kind).toBe("record");
    });

    test("a view inside a dialog does not take the page context", async () => {
        await mountViewInDialog({
            type: "pivot",
            resModel: "res.partner",
            arch: `<pivot><field name="color" type="measure"/></pivot>`,
        });
        expect(getService("tuquiAssistant").getContextPayload().kind).not.toBe("view");
    });
});

/** Every page context the service writes from now on. */
function recordWrites() {
    const assistant = getService("tuquiAssistant");
    const written = [];
    patchWithCleanup(assistant, {
        setViewContext(owner, payload) {
            super.setViewContext(owner, payload);
            const context = toRaw(assistant.state.context);
            if (written.at(-1) !== context) {
                written.push(context);
            }
        },
    });
    return written;
}

// Activity and hierarchy load through `useModel`: their model does not notify
// after a reload.
class SilentModel extends Model {
    async load(params) {
        this.domain = params.domain;
    }
}

class SilentController extends Component {
    static template = xml`<div class="o_silent_view"/>`;
    static props = ["*"];

    setup() {
        this.model = useModel(SilentModel, {});
    }
}

describe("a new search", () => {
    test("on a pivot is published once, with the rows the pivot reloaded", async () => {
        await mountMainView({
            type: "pivot",
            resModel: "res.partner",
            arch: `<pivot><field name="name" type="row"/><field name="color" type="measure"/></pivot>`,
            searchViewArch: `<search><filter name="by_city" string="City" context="{'group_by': 'city'}"/></search>`,
        });
        const written = recordWrites();

        await toggleSearchBarMenu();
        await toggleMenuItem("City");
        await animationFrame();
        await animationFrame();

        // Never the new grouping with the rows of the old one.
        expect(written.length).toBe(1);
        expect(written[0].groupBy).toEqual(["city"]);
        expect(written[0].context.pivot_row_groupby).toEqual(["city"]);
    });

    test("on a view whose model does not notify is published after its reload", async () => {
        registry.category("views").add("tuqui_silent", { type: "pivot", Controller: SilentController });
        const searchModels = [];
        patchWithCleanup(WithSearch.prototype, {
            setup() {
                super.setup(...arguments);
                searchModels.push(this.searchModel);
            },
        });
        await mountMainView({
            type: "pivot",
            resModel: "res.partner",
            arch: `<pivot js_class="tuqui_silent"/>`,
            searchViewArch: `<search><filter name="acme" string="Acme" domain="[('name', '=', 'Acme')]"/></search>`,
        });
        const written = recordWrites();

        const [searchModel] = searchModels;
        const [acme] = searchModel.getSearchItems((item) => item.name === "acme");
        searchModel.toggleSearchItem(acme.id);
        await animationFrame();
        await animationFrame();

        expect(written.length).toBe(1);
        expect(written[0].jsClass).toBe("tuqui_silent");
        expect(written[0].domain).toEqual([["name", "=", "Acme"]]);
        expect(written[0].filters).toEqual(["Acme"]);
    });
});

describe("page owners and their stack", () => {
    test("a view under a dialog refreshes its entry without taking the page back", async () => {
        await mountView({
            type: "form",
            resModel: "res.partner",
            resId: 1,
            arch: `<form><field name="name"/></form>`,
        });
        const assistant = getService("tuquiAssistant");
        const view = {};
        const dialog = {};
        const quickCreate = { resModel: "res.partner", resId: 2, data: { display_name: "Globex" }, dirty: false };
        assistant.setViewContext(view, { model: "res.partner", viewType: "calendar" });
        assistant.setRecordContext(dialog, quickCreate);
        assistant.setViewContext(view, { model: "res.partner", viewType: "calendar", filters: ["Mine"] });
        expect(assistant.state.context.kind).toBe("record");

        assistant.clearContext(dialog);
        expect(assistant.state.context.kind).toBe("view");
        expect(assistant.state.context.filters).toEqual(["Mine"]);
    });

    test("a form made dirty under a dialog keeps the dialog's page, and gets it back when it closes", async () => {
        // A many2many "Create and edit" dialog's "Save & New" adds the tag to the
        // form below: the form gets dirty while the dialog is still open.
        await mountView({
            type: "form",
            resModel: "res.partner",
            resId: 1,
            arch: `<form><field name="name"/></form>`,
        });
        const assistant = getService("tuquiAssistant");
        const dialog = {};
        const created = { resModel: "res.partner", resId: 2, data: { display_name: "Globex" }, dirty: false };
        assistant.setRecordContext(dialog, created);

        await contains(".o_field_widget[name=name] input").edit("Acme Corp");
        expect(assistant.state.context.resId).toBe(2);

        assistant.clearContext(dialog);
        expect(assistant.state.context.resId).toBe(1);
        expect(assistant.state.context.dirty).toBe(true);
    });

    test("an owner that leaves under a dialog does not get the page back", async () => {
        await mountView({
            type: "form",
            resModel: "res.partner",
            resId: 1,
            arch: `<form><field name="name"/></form>`,
        });
        const assistant = getService("tuquiAssistant");
        const view = {};
        const dialog = {};
        assistant.setViewContext(view, { model: "res.partner", viewType: "calendar" });
        assistant.setRecordContext(dialog, { resModel: "res.partner", resId: 2, data: {}, dirty: false });
        assistant.clearContext(view);

        assistant.clearContext(dialog);
        expect(assistant.state.context.kind).toBe("record");
        expect(assistant.state.context.resId).toBe(1);
    });

    test("a record with no name of its own is named by its owner's title", async () => {
        await mountView({ type: "form", resModel: "res.partner", resId: 1, arch: `<form><field name="name"/></form>` });
        const assistant = getService("tuquiAssistant");
        const wizard = { resModel: "sms.composer", resId: false, data: {}, dirty: false };
        assistant.setRecordContext({ title: () => "Send SMS" }, wizard);
        expect(assistant.state.context.displayName).toBe("Send SMS");
    });

    test("save goes through the page owner's save when it has one", async () => {
        await mountView({ type: "form", resModel: "res.partner", resId: 1, arch: `<form><field name="name"/></form>` });
        const assistant = getService("tuquiAssistant");
        const saves = [];
        const record = {
            resModel: "res.partner",
            resId: 2,
            data: { display_name: "Globex" },
            dirty: true,
            save: async () => saves.push("record"),
        };
        assistant.setRecordContext({ save: async () => saves.push("owner") }, record);
        expect(await assistant.saveRecord()).toBe(true);
        expect(saves).toEqual(["owner"]);
    });

    test("reload goes through the page owner's reload", async () => {
        await mountView({ type: "form", resModel: "res.partner", resId: 1, arch: `<form><field name="name"/></form>` });
        const assistant = getService("tuquiAssistant");
        let reloads = 0;
        assistant.setViewContext({ reload: async () => reloads++ }, { model: "res.partner", viewType: "pivot" });
        expect(await assistant.reloadView()).toBe(true);
        expect(reloads).toBe(1);
    });
});
