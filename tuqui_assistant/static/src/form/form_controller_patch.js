/** @odoo-module **/
import { patch } from "@web/core/utils/patch";
import { useLayoutEffect } from "@web/owl2/utils";
import { FormController } from "@web/views/form/form_controller";
import { useService } from "@web/core/utils/hooks";
import { onWillUnmount } from "@odoo/owl";
import { useRecordContextListeners } from "@tuqui_assistant/form/record_context_hook";

/**
 * Publishes the active form record to the assistant service while this
 * FormController is mounted. Mirrors the pattern from Odoo Enterprise's `ai`
 * module (patch on FormController.prototype + access to this.model.root).
 *
 * `this.model.root` is the root record; exposes resModel, resId, data (in-memory
 * values including unsaved changes), and fields.
 */
patch(FormController.prototype, {
    setup() {
        super.setup();
        const assistant = useService("tuquiAssistant");
        const owner = {
            title: () => this.env.config?.getDisplayName?.() || "",
            arch: () => this.archInfo?.xmlDoc,
            // `load()` puts a new root in the model: the page has to follow it.
            reload: async () => {
                await this.model.load();
                return this.model.root;
            },
        };
        // The context is let go only on unmount: dropping it on every change would
        // hand the page from a dialog on top back to this form.
        useLayoutEffect(
            () => {
                assistant.setRecordContext(owner, this.model.root);
            },
            // Include dirty so context is re-pushed to the SPA when the user
            // edits a field (many2one, etc.) — without it the SPA sees stale values.
            () => [this.model.root.resModel, this.model.root.resId, this.model.root.dirty]
        );
        onWillUnmount(() => assistant.clearContext(owner));
        useRecordContextListeners(owner, () => this.rootRef?.());
    },
});
