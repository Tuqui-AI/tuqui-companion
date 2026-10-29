/** @odoo-module **/
import { onWillUnmount } from "@odoo/owl";
import { useLayoutEffect } from "@web/owl2/utils";
import { useService } from "@web/core/utils/hooks";
import { patch } from "@web/core/utils/patch";
import { X2ManyFieldDialog } from "@web/views/fields/relational_utils";
import { useRecordContextListeners } from "@tuqui_assistant/form/record_context_hook";

/**
 * The dialog of an x2many record is the page while it is open: the record is the
 * one the assistant reads and proposes on. Odoo draws it with a FormRenderer and
 * no FormController, so the form patch never sees it. Saving a one2many line puts
 * it into the form below; a many2many record is written to the database.
 */
patch(X2ManyFieldDialog.prototype, {
    setup() {
        super.setup(...arguments);
        const assistant = useService("tuquiAssistant");
        const owner = {
            // The dialog shares its form's config: its own title is the one on screen.
            title: () => this.title,
            arch: () => this.archInfo?.xmlDoc,
            // Tuqui's save is the dialog's, which knows where the record goes, and closes it.
            save: () => this.save({ saveAndNew: false }),
        };
        // "Save & New" puts a new line in `this.record` and renders again.
        useLayoutEffect(
            () => {
                assistant.setRecordContext(owner, this.record);
            },
            () => [this.record, this.record.resId, this.record.dirty]
        );
        onWillUnmount(() => assistant.clearContext(owner));
        useRecordContextListeners(owner, () => this.modalRef?.());
    },
});
