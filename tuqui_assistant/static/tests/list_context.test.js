/** @odoo-module **/
import { describe, expect, test, waitFor } from "@odoo/hoot";
import { animationFrame } from "@odoo/hoot-mock";
import { toRaw } from "@odoo/owl";
import {
    contains,
    defineModels,
    fields,
    getService,
    MockServer,
    models,
    patchWithCleanup,
    toggleMenuItem,
    toggleSearchBarMenu,
    webModels,
} from "@web/../tests/web_test_helpers";
import { WithSearch } from "@web/search/with_search/with_search";
import { contextKey } from "@tuqui_assistant/panel/panel";
import { mountMainView } from "@tuqui_assistant/../tests/tuqui_test_helpers";

/**
 * A list and a kanban publish the same view context as a pivot (WithSearch); the
 * list only adds its selection. The panel decides whether to post the context
 * again from `contextKey`, so a change the user makes must change the key.
 *
 * How to run: see the header of `apply_proposal.test.js`.
 */

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    priority = fields.Char();

    _records = [
        { id: 1, name: "Big deal", priority: "3" },
        { id: 2, name: "Small deal", priority: "1" },
        { id: 3, name: "Huge deal", priority: "3" },
    ];
}

// The list controller reads `res.users` on start, so the web models come along.
defineModels([...Object.values(webModels), Lead]);

const SEARCH_ARCH = `<search><filter name="hot" string="Hot" domain="[('priority', '=', '3')]"/></search>`;

describe("a list with nothing selected", () => {
    test("is a view, and changing a filter publishes the new domain and changes the panel key", async () => {
        await mountMainView({
            type: "list",
            resModel: "crm.lead",
            arch: `<list><field name="name"/></list>`,
            searchViewArch: SEARCH_ARCH,
        });
        const assistant = getService("tuquiAssistant");
        expect(assistant.state.context.kind).toBe("view");
        expect(assistant.state.context.viewType).toBe("list");
        expect(assistant.state.context.filters).toEqual([]);
        const before = contextKey(assistant.state.context);

        await toggleSearchBarMenu();
        await toggleMenuItem("Hot");

        expect(assistant.state.context.filters).toEqual(["Hot"]);
        expect(assistant.state.context.domain).toEqual([["priority", "=", "3"]]);
        expect(contextKey(assistant.state.context)).not.toBe(before);
    });

    test("one filter change writes the page context once", async () => {
        // The search publishes, and the list's model publishes the same state again
        // after its load: only the first one is written.
        await mountMainView({
            type: "list",
            resModel: "crm.lead",
            arch: `<list><field name="name"/></list>`,
            searchViewArch: SEARCH_ARCH,
        });
        const assistant = getService("tuquiAssistant");
        const written = [];
        patchWithCleanup(assistant, {
            setViewContext(owner, payload) {
                super.setViewContext(owner, payload);
                written.push(toRaw(assistant.state.context));
            },
        });

        await toggleSearchBarMenu();
        await toggleMenuItem("Hot");
        await animationFrame();

        expect(written.length).toBeGreaterThan(0);
        expect(new Set(written).size).toBe(1);
        expect(written[0].filters).toEqual(["Hot"]);
    });

    test("ticking a row turns it into a selection, and unticking it back into the view", async () => {
        await mountMainView({ type: "list", resModel: "crm.lead", arch: `<list><field name="name"/></list>` });
        const assistant = getService("tuquiAssistant");
        await contains(".o_data_row:first-child .o_list_record_selector input").click();
        expect(assistant.state.context.kind).toBe("selection");
        expect(assistant.state.context.resIds).toEqual([1]);

        await contains(".o_data_row:first-child .o_list_record_selector input").click();
        expect(assistant.state.context.kind).toBe("view");
    });

    test("the selection follows which rows are ticked, not how many", async () => {
        await mountMainView({ type: "list", resModel: "crm.lead", arch: `<list><field name="name"/></list>` });
        const assistant = getService("tuquiAssistant");
        await contains(".o_data_row:nth-child(1) .o_list_record_selector input").click();
        await contains(".o_data_row:nth-child(2) .o_list_record_selector input").click();
        await contains(".o_data_row:nth-child(1) .o_list_record_selector input").click();
        expect(assistant.state.context.resIds).toEqual([2]);
    });

    test("a new search never sends the old selection with the new domain", async () => {
        // With rows ticked Odoo hides the search bar; a search panel or a reload
        // still run a new search, so it is run on the search model.
        const searchModels = [];
        patchWithCleanup(WithSearch.prototype, {
            setup() {
                super.setup(...arguments);
                searchModels.push(this.searchModel);
            },
        });
        await mountMainView({
            type: "list",
            resModel: "crm.lead",
            arch: `<list><field name="name"/></list>`,
            searchViewArch: SEARCH_ARCH,
        });
        const assistant = getService("tuquiAssistant");
        await contains(".o_data_row:first-child .o_list_record_selector input").click();
        expect(assistant.state.context.kind).toBe("selection");
        const published = [];
        patchWithCleanup(assistant, {
            setViewContext(owner, payload) {
                published.push(payload);
                return super.setViewContext(owner, payload);
            },
        });

        const [searchModel] = searchModels;
        const [hot] = searchModel.getSearchItems((item) => item.name === "hot");
        searchModel.toggleSearchItem(hot.id);
        await animationFrame();
        await animationFrame();

        expect(published.length).toBeGreaterThan(0);
        expect(published.every((p) => !p.resIds?.length)).toBe(true);
        expect(assistant.state.context.kind).toBe("view");
        expect(assistant.state.context.domain).toEqual([["priority", "=", "3"]]);
    });

    test("reload re-runs the search, as the search bar does", async () => {
        await mountMainView({ type: "list", resModel: "crm.lead", arch: `<list><field name="name"/></list>` });
        MockServer.env["crm.lead"].write([1], { name: "Bigger deal" });

        expect(await getService("tuquiAssistant").reloadView()).toBe(true);
        await waitFor(".o_data_row:contains(Bigger deal)");
    });
});

describe("a grouped list", () => {
    test("'select all' counts its records, not its groups", async () => {
        await mountMainView({
            type: "list",
            resModel: "crm.lead",
            arch: `<list><field name="name"/></list>`,
            groupBy: ["priority"],
        });
        // With every group folded, the header checkbox selects the whole domain.
        await contains("thead .o_list_record_selector input").click();
        await animationFrame();
        const ctx = getService("tuquiAssistant").state.context;
        expect(ctx.kind).toBe("selection");
        expect(ctx.allMatching).toBe(true);
        expect(ctx.count).toBe(3);
    });
});

describe("a kanban", () => {
    test("publishes the same view context, with its domain", async () => {
        await mountMainView({
            type: "kanban",
            resModel: "crm.lead",
            arch: `<kanban><templates><t t-name="card"><field name="name"/></t></templates></kanban>`,
            searchViewArch: SEARCH_ARCH,
            context: { search_default_hot: 1 },
        });
        const ctx = getService("tuquiAssistant").state.context;
        expect(ctx.kind).toBe("view");
        expect(ctx.viewType).toBe("kanban");
        expect(ctx.filters).toEqual(["Hot"]);
        expect(ctx.domain).toEqual([["priority", "=", "3"]]);
    });
});

describe("contextKey", () => {
    test("a select-all key follows its domain even when the count stays", () => {
        const base = { kind: "selection", model: "crm.lead", count: 2, resIds: [], allMatching: true };
        const a = { ...base, domain: [["priority", "=", "3"]] };
        const b = { ...base, domain: [["priority", "=", "1"]] };
        expect(contextKey(a)).not.toBe(contextKey(b));
    });

    test("a view key follows its js_class", () => {
        const base = { kind: "view", model: "crm.lead", viewType: "kanban", domain: [], filters: [] };
        expect(contextKey(base)).not.toBe(contextKey({ ...base, jsClass: "crm_kanban" }));
    });

    test("a view key follows its grouping", () => {
        const base = { kind: "view", model: "crm.lead", viewType: "pivot", domain: [], filters: [] };
        expect(contextKey({ ...base, groupBy: [] })).not.toBe(contextKey({ ...base, groupBy: ["name"] }));
    });

    test("a view key follows what the user changes from the view itself", () => {
        const base = { kind: "view", model: "crm.lead", viewType: "graph", domain: [], filters: [] };
        const bar = { ...base, context: { graph_mode: "bar" } };
        const pie = { ...base, context: { graph_mode: "pie" } };
        expect(contextKey(bar)).not.toBe(contextKey(pie));
        const week = { ...base, viewType: "calendar", range: { start: "2026-10-18", end: "2026-10-24" } };
        const next = { ...week, range: { start: "2026-10-25", end: "2026-10-31" } };
        expect(contextKey(week)).not.toBe(contextKey(next));
    });
});
