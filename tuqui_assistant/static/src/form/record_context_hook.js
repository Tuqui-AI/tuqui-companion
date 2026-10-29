/** @odoo-module **/
import { onWillUnmount, useExternalListener } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";

// Wait before publishing the context again after the user leaves a field. On blur
// and debounced, never per key: a revision per key grows every turn's context
// (LLM cost and noise) and adds nothing.
export const CONTEXT_DEBOUNCE_MS = 400;

/**
 * Keeps the context of `owner`'s record live while the component is mounted.
 * Publishing on `dirty` alone is not enough: it flips once, on the first edit.
 * So the values typed in a field travel when the user leaves it, and the field
 * the user is on is noted for the assistant. The service ignores an owner that
 * does not hold the page (the form under a dialog), and a blur with nothing
 * edited.
 *
 * @param {Object} owner the owner the component holds the page with
 * @param {() => Element|null|undefined} getRoot the element the record is drawn in
 */
export function useRecordContextListeners(owner, getRoot) {
    const assistant = useService("tuquiAssistant");
    let timeout = null;
    // On `document`, capturing: the fields live in varied subtrees (x2many grids,
    // notebooks).
    useExternalListener(
        document,
        "focusout",
        () => {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                timeout = null;
                assistant.refreshRecordContext(owner);
            }, CONTEXT_DEBOUNCE_MS);
        },
        { capture: true }
    );
    // The outermost field widget around the focused element: a cell of a
    // one2many counts as the one2many.
    useExternalListener(
        document,
        "focusin",
        (ev) => {
            const root = getRoot();
            if (!root || !(ev.target instanceof Element) || !root.contains(ev.target)) {
                return;
            }
            let name = null;
            let el = ev.target.closest(".o_field_widget[name]");
            while (el && root.contains(el)) {
                name = el.getAttribute("name");
                el = el.parentElement?.closest(".o_field_widget[name]");
            }
            if (name) {
                assistant.noteFocusedField(owner, name);
            }
        },
        { capture: true }
    );
    onWillUnmount(() => clearTimeout(timeout));
}
