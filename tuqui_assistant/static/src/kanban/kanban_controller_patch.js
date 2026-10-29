/** @odoo-module **/
import { patch } from "@web/core/utils/patch";
import { KanbanController } from "@web/views/kanban/kanban_controller";
import { useViewSelection } from "@tuqui_assistant/search/view_selection";

// Cards ticked with alt+click or a long press are a selection, as in a list.
patch(KanbanController.prototype, {
    setup() {
        super.setup(...arguments);
        useViewSelection();
    },
});
