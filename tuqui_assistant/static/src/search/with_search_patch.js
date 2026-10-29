/** @odoo-module **/
import { onMounted, onPatched, onWillUnmount, useSubEnv } from "@odoo/owl";
import { serializeDate } from "@web/core/l10n/dates";
import { useBus, useService } from "@web/core/utils/hooks";
import { patch } from "@web/core/utils/patch";
import { Model } from "@web/model/model";
import { WithSearch } from "@web/search/with_search/with_search";
import { viewContextKeys } from "@tuqui_assistant/search/view_context";

// A change made from the view itself (a pivot row, a graph mode, the calendar's
// next week) does not go through the search model: the view's data model notifies
// it, on every reload and on every such change.
patch(Model.prototype, {
    notify() {
        super.notify(...arguments);
        this.env?.__tuquiViewModel__?.(this);
    },
});

/**
 * The view's own state, in the format of "Save to favorites": each view adds its
 * keys to the favorite context (`useSetupAction({getContext})`), and an action
 * opened with them rebuilds it. Only those keys: the contexts of the active
 * filters, which a favorite also saves, are the search's, not the view's state.
 */
function favoriteContext(searchModel) {
    // A custom view's getContext runs inside Model.notify: a throw must not break the view.
    try {
        const callbacks = searchModel.env.__getContext__?.callbacks || [];
        return viewContextKeys(Object.assign({}, ...callbacks.map((getContext) => getContext())));
    } catch {
        return {};
    }
}

/**
 * The page context of every view with a search model but the form: list, kanban,
 * pivot, graph, calendar, and any other native or custom view type. Of what the
 * view adds to its favorites, only the keys `view_context.js` knows travel. A view
 * adds what the search does not know through `env.__tuquiViewExtra__` (the list,
 * its selection).
 *
 * Only the action's main view is the page: the action service hands it its
 * `__getGlobalState__` recorder, and no other search is above it. A view in a
 * dialog or a dashboard dashlet gets no recorder; a view embedded in a form's html
 * field (Knowledge hands it a recorder of its own) is under the form's search.
 * Neither takes the page from the form or the dashboard around it.
 */
patch(WithSearch.prototype, {
    setup() {
        const nested = Boolean(this.env.searchModel);
        super.setup(...arguments);
        const config = this.env.config;
        const viewType = config?.viewType;
        if (nested || !this.env.__getGlobalState__ || !this.props.resModel || viewType === "form") {
            if (this.env.__tuquiViewModel__) {
                // Nothing under this search reports to the page's view.
                useSubEnv({ __tuquiViewModel__: null, __tuquiViewExtra__: null });
            }
            return;
        }
        const assistant = useService("tuquiAssistant");
        const owner = {
            // Reloads the way the search bar re-runs a search.
            reload: async () => {
                this.searchModel.search();
            },
        };
        let model = null;
        let extra = {};
        let mounted = false;
        // The last new search, while its context is not published yet (0: none),
        // and whether the view's model started reloading for it.
        let searches = 0;
        let pending = 0;
        let reloading = false;
        const publish = () => {
            if (!mounted) {
                return;
            }
            const searchModel = this.searchModel;
            const payload = {
                model: this.props.resModel,
                // The action's breadcrumb ("Contacts"), already translated.
                modelLabel: config.getDisplayName?.() || "",
                viewType: viewType || "",
                // Only a js_class tells something the view type does not.
                jsClass: config.viewSubType !== viewType ? config.viewSubType : undefined,
                domain: searchModel.domain,
                groupBy: searchModel.groupBy,
                // What the user's screen says ("Overdue", "Customer: Acme"), so the
                // assistant can ask back instead of answering workspace-wide.
                filters: searchModel.facets
                    .map((f) => (f.values?.length ? f.values.join(", ") : f.title))
                    .filter(Boolean),
            };
            const context = favoriteContext(searchModel);
            if (Object.keys(context).length) {
                payload.context = context;
            }
            // A calendar keeps no state in favorites: the range on screen is what it shows.
            if (model?.rangeStart) {
                payload.range = { start: serializeDate(model.rangeStart), end: serializeDate(model.rangeEnd) };
            }
            Object.assign(payload, extra);
            assistant.setViewContext(owner, payload);
        };
        const publishSearch = () => {
            pending = 0;
            publish();
        };
        // Until its model has reloaded, the view still shows the old search: a new
        // search is published after the load. Only the load is waited for, not a
        // notify: a model on `useModel` (activity) does not notify after a
        // reload.
        const track = (viewModel) => {
            model = viewModel;
            const load = viewModel.load;
            viewModel.load = async function () {
                const search = pending;
                if (search) {
                    reloading = true;
                }
                const result = await load.apply(this, arguments);
                if (search && search === pending) {
                    publishSearch();
                }
                return result;
            };
        };
        useSubEnv({
            // In Odoo 18 only a calendar's model notifies on its first load, before a
            // model nested in it (a quick create, a <Record>); the others are found
            // on mount.
            __tuquiViewModel__: (viewModel) => {
                if (!model) {
                    track(viewModel);
                }
                if (viewModel === model) {
                    publish();
                }
            },
            __tuquiViewExtra__: (viewExtra) => {
                extra = viewExtra;
                publish();
            },
        });
        useBus(this.searchModel, "update", () => {
            // A new search reloads the view into a new root without a selection:
            // the old one must not travel with the new domain.
            extra = {};
            pending = ++searches;
            reloading = false;
        });
        // The search re-renders the view: a model on `useModel` reloads before it
        // (and is published by then), one with sample data after it. A view whose
        // model did not reload, or without a model, is up to date now.
        onPatched(() => {
            if (pending && !reloading) {
                publishSearch();
            }
        });
        onMounted(() => {
            // The other models notify only after a reload, too late for the first
            // search: the view's model is its controller's, the child this search
            // renders.
            const controller = Object.values(this.__owl__.children)[0]?.component;
            if (!model && controller?.model instanceof Model) {
                track(controller.model);
            }
            mounted = true;
            publish();
        });
        onWillUnmount(() => {
            mounted = false;
            assistant.clearContext(owner);
        });
    },
});
