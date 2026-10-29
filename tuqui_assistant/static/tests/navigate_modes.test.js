/** @odoo-module **/
import { after, describe, expect, test } from "@odoo/hoot";
import { markup } from "@odoo/owl";
import {
    defineModels,
    fields,
    getService,
    models,
    mountView,
    onRpc,
    patchWithCleanup,
} from "@web/../tests/web_test_helpers";
import { assets } from "@web/core/assets";
import { registry } from "@web/core/registry";
import { browseContext } from "@tuqui_assistant/search/view_context";

/**
 * `navigate`: every mode of `odoo_open_view` lands on the screen it names, or
 * says why not and stays put. The server only validated the request; whether it
 * opens is decided here, by Odoo's own `doAction`.
 *
 * How to run: see the header of `apply_proposal.test.js`.
 */

class Partner extends models.Model {
    _name = "res.partner";

    name = fields.Char();
    color = fields.Integer({ aggregator: "sum" });

    _records = [{ id: 1, name: "Acme", color: 3 }];
}

defineModels([Partner]);

// base_setup.action_general_configuration as /web/action/load serves it.
const SETTINGS = {
    id: 30,
    type: "ir.actions.act_window",
    res_model: "res.config.settings",
    views: [[false, "form"]],
    context: "{'module' : 'general_settings', 'bin_size': False}",
};

function mountForm() {
    return mountView({ type: "form", resModel: "res.partner", resId: 1, arch: `<form><field name="name"/></form>` });
}

/**
 * Navigate with `payload` and keep what reached doAction. `loaded` stands in for
 * loadAction; `served` is what /web/action/load answers, prepared by Odoo itself.
 */
async function navigateWith(payload, { menuPatch, loaded = {}, served } = {}) {
    await mountForm();
    if (menuPatch) {
        patchWithCleanup(getService("menu"), menuPatch);
    }
    const actions = [];
    const loads = [];
    const action = getService("action");
    if (served) {
        onRpc("/web/action/load", () => served);
    } else {
        patchWithCleanup(action, {
            loadAction: async (request) => {
                loads.push(request);
                return loaded[request];
            },
        });
    }
    patchWithCleanup(action, { doAction: async (request, options) => actions.push({ request, options }) });
    const ok = await getService("tuquiAssistant").navigate(payload);
    return { ok, actions, loads };
}

describe("navigate", () => {
    test("record opens that record's form", async () => {
        const { ok, actions } = await navigateWith({ model: "res.partner", mode: "record", resId: 1 });
        expect(ok).toBe(true);
        expect(actions[0].request).toMatchObject({ res_model: "res.partner", res_id: 1 });
        expect(actions[0].request.views).toEqual([[false, "form"]]);
    });

    test("a mode this host does not know opens nothing, not an empty form", async () => {
        const { ok, actions } = await navigateWith({ model: "res.partner", mode: "compare", resId: 1 });
        expect(ok).toBe(false);
        expect(actions).toHaveLength(0);
    });

    test("record without an id does not move the screen", async () => {
        const { ok, actions } = await navigateWith({ model: "res.partner", mode: "record" });
        expect(ok).toBe(false);
        expect(actions).toHaveLength(0);
    });

    test("browse a pivot carries the view keys it was read with", async () => {
        const { ok, actions } = await navigateWith({
            model: "res.partner",
            mode: "browse",
            viewType: "pivot",
            domain: [],
            groupBy: ["name"],
            context: { pivot_measures: ["color"], pivot_row_groupby: ["name"], active_test: false },
        });
        expect(ok).toBe(true);
        const { request, options } = actions[0];
        expect(request.views[0]).toEqual([false, "pivot"]);
        expect(options.viewType).toBe("pivot");
        expect(request.context).toEqual({
            pivot_measures: ["color"],
            pivot_row_groupby: ["name"],
            group_by: ["name"],
        });
    });

    test("a view type this Odoo does not have is refused without navigating", async () => {
        patchWithCleanup(assets, { loadBundle: async () => {} });
        const { ok, actions } = await navigateWith({ model: "res.partner", mode: "browse", viewType: "nonexistent" });
        expect(ok).toBe(false);
        expect(actions).toHaveLength(0);
    });

    test("a js_class opens as its view type, once the lazy views bundle is loaded", async () => {
        // Pivot and graph are not registered until Odoo loads its lazy bundle.
        const views = registry.category("views");
        const bundles = [];
        patchWithCleanup(assets, {
            loadBundle: async (name) => {
                bundles.push(name);
                views.add("tuqui_lazy_pivot", { ...views.get("pivot") });
            },
        });
        after(() => views.remove("tuqui_lazy_pivot"));
        const { ok, actions } = await navigateWith({
            model: "res.partner",
            mode: "browse",
            viewType: "tuqui_lazy_pivot",
        });
        expect(ok).toBe(true);
        expect(bundles).toEqual(["web.assets_backend_lazy"]);
        expect(actions[0].request.views[0]).toEqual([false, "pivot"]);
        expect(actions[0].options.viewType).toBe("pivot");
    });

    test("the section beats the module the Settings action carries", async () => {
        const { ok, actions } = await navigateWith(
            { mode: "action", xmlid: "base_setup.action_general_configuration", section: "account" },
            { served: SETTINGS }
        );
        expect(ok).toBe(true);
        expect(actions[0].request.context).toEqual({ module: "account", bin_size: false });
        expect(actions[0].request.views).toEqual([[false, "form"]]);
    });

    test("an action opened by xmlid keeps its help as markup", async () => {
        const served = {
            id: 31,
            type: "ir.actions.act_window",
            res_model: "res.partner",
            views: [[false, "list"]],
            help: "<p>Create a contact</p>",
        };
        const { ok, actions } = await navigateWith({ mode: "action", xmlid: "contacts.action_contacts" }, { served });
        expect(ok).toBe(true);
        expect(actions[0].request.help).toBeInstanceOf(markup("").constructor);
        expect(String(actions[0].request.help)).toBe("<p>Create a contact</p>");
    });

    test("a bare client-action tag is not an xmlid, and nothing runs", async () => {
        const { ok, actions, loads } = await navigateWith({ mode: "action", xmlid: "reload" });
        expect(ok).toBe(false);
        expect(loads).toHaveLength(0);
        expect(actions).toHaveLength(0);
    });

    test("action by menu opens the menu's action", async () => {
        const action = { type: "ir.actions.act_window", res_model: "res.partner", views: [[false, "list"]] };
        const { ok, actions, loads } = await navigateWith(
            { mode: "action", menuId: 7 },
            {
                menuPatch: { getMenu: (id) => (id === 7 ? { id: 7, actionID: 33 } : undefined), setCurrentMenu: () => {} },
                loaded: { 33: { ...action, _originalAction: JSON.stringify(action) } },
            }
        );
        expect(ok).toBe(true);
        expect(loads).toEqual([33]);
        expect(actions[0].request.res_model).toBe("res.partner");
        // A menu starts over from its app, as clicking it in Odoo does.
        expect(actions[0].options.clearBreadcrumbs).toBe(true);
    });

    test("an action opened by xmlid stacks on the breadcrumbs", async () => {
        const served = { id: 32, type: "ir.actions.act_window", res_model: "res.partner", views: [[false, "list"]] };
        const { ok, actions } = await navigateWith({ mode: "action", xmlid: "contacts.action_contacts" }, { served });
        expect(ok).toBe(true);
        expect(actions[0].options.clearBreadcrumbs).not.toBe(true);
    });

    test("the action goes to doAction as loaded, not the prepared copy", async () => {
        // doAction prepares it again: a prepared copy would get a second search view.
        const original = { type: "ir.actions.act_window", res_model: "res.partner", views: [[false, "list"]] };
        const prepared = {
            ...original,
            jsId: "action_9",
            views: [[false, "list"], [false, "search"]],
            _originalAction: JSON.stringify(original),
        };
        const { ok, actions } = await navigateWith(
            { mode: "action", menuId: 7 },
            {
                menuPatch: { getMenu: () => ({ id: 7, actionID: 35 }), setCurrentMenu: () => {} },
                loaded: { 35: prepared },
            }
        );
        expect(ok).toBe(true);
        expect(actions[0].request).toEqual(original);
    });

    test("an action Odoo could not copy opens from its request, with the section", async () => {
        // Without `_originalAction` the loaded action is the prepared copy only.
        const prepared = {
            type: "ir.actions.act_window",
            res_model: "res.config.settings",
            jsId: "action_9",
            views: [[false, "form"]],
            context: {},
        };
        const { ok, actions } = await navigateWith(
            { mode: "action", xmlid: "base_setup.action_general_configuration", section: "account" },
            { loaded: { "base_setup.action_general_configuration": prepared } }
        );
        expect(ok).toBe(true);
        expect(actions[0].request).toBe("base_setup.action_general_configuration");
        expect(actions[0].options.additionalContext).toEqual({ module: "account" });
    });

    test("an action context that does not evaluate is told, and nothing opens", async () => {
        const original = {
            type: "ir.actions.act_window",
            res_model: "res.config.settings",
            views: [[false, "form"]],
            context: "{'module': not_a_name}",
        };
        const { ok, actions } = await navigateWith(
            { mode: "action", xmlid: "x.settings", section: "account" },
            { loaded: { "x.settings": { ...original, _originalAction: JSON.stringify(original) } } }
        );
        expect(ok).toBe(false);
        expect(actions).toHaveLength(0);
    });

    test("a menu this user does not have is refused", async () => {
        const { ok, actions } = await navigateWith({ mode: "action", menuId: 99 }, { menuPatch: { getMenu: () => undefined } });
        expect(ok).toBe(false);
        expect(actions).toHaveLength(0);
    });

    test("a menu whose action is a URL is refused", async () => {
        const { ok, actions } = await navigateWith(
            { mode: "action", menuId: 7 },
            {
                menuPatch: { getMenu: () => ({ id: 7, actionID: 34 }), setCurrentMenu: () => {} },
                loaded: { 34: { type: "ir.actions.act_url", url: "https://example.com" } },
            }
        );
        expect(ok).toBe(false);
        expect(actions).toHaveLength(0);
    });
});

describe("navigate never runs code", () => {
    test("an xmlid that names a server action is not run", async () => {
        await mountForm();
        onRpc("/web/action/load", () => ({
            id: 99,
            type: "ir.actions.server",
            name: "Delete everything",
            binding_type: "action",
        }));
        let ran = false;
        onRpc("/web/action/run", () => {
            ran = true;
            return false;
        });
        await getService("tuquiAssistant").navigate({ mode: "action", xmlid: "x.delete_everything" });
        expect(ran).toBe(false);
    });
});

describe("browseContext", () => {
    test("keeps the view keys and drops the rest of the context", () => {
        const context = browseContext(["stage_id"], {
            graph_measure: "color",
            graph_mode: "pie",
            cohort_interval: "week",
            active_test: false,
            default_name: "x",
            allowed_company_ids: [2],
            pivot_measures: { nested: true },
        });
        expect(context).toEqual({
            graph_measure: "color",
            graph_mode: "pie",
            cohort_interval: "week",
            group_by: ["stage_id"],
        });
    });
});
