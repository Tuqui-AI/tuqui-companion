/** @odoo-module **/
import { useScope } from "@odoo/owl";
import { useEnv, useLayoutEffect } from "@web/owl2/utils";

/**
 * Adds the controller's selection to the view context `WithSearch` publishes: the
 * search does not know which records are ticked. With records ticked (or "select
 * all") the page context becomes a selection; with none, it stays the view.
 * Call it from the setup of a controller whose `model.root` is a dynamic list.
 */
export function useViewSelection() {
    const controller = useScope().component;
    const env = useEnv();
    // A grouped root counts its groups; "select all" is about its records.
    const total = (root) => (root.isGrouped ? root.recordCount : root.count);
    useLayoutEffect(
        () => {
            const root = controller.model.root;
            env.__tuquiViewExtra__?.({
                resIds: root.selection.map((r) => r.resId),
                isDomainSelected: root.isDomainSelected,
                count: total(root),
            });
        },
        () => {
            const root = controller.model.root;
            return [
                // The ids, not their number: untick one record and tick another and
                // the length stays, the context is not published again, and the
                // assistant writes on the record the user unticked.
                root.selection.map((r) => r.resId).join(","),
                root.isDomainSelected,
                // Only "select all" reads the count: a reload must not publish again.
                root.isDomainSelected ? total(root) : null,
            ];
        }
    );
}
