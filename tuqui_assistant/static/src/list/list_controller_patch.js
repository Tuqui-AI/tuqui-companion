/** @odoo-module **/
import { patch } from "@web/core/utils/patch";
import { ListController } from "@web/views/list/list_controller";
import { useViewSelection } from "@tuqui_assistant/search/view_selection";

patch(ListController.prototype, {
    setup() {
        super.setup(...arguments);
        useViewSelection();
    },
});
