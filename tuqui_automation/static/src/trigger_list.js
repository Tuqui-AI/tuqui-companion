import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { ListController } from "@web/views/list/list_controller";
import { listView } from "@web/views/list/list_view";
import { TuquiTriggerAddDialog } from "./trigger_add_dialog/trigger_add_dialog";

/** The "New" button of the Tuqui triggers list opens the card wizard. */
export class TuquiTriggerListController extends ListController {
    setup() {
        super.setup();
        this.dialogService = useService("dialog");
    }

    async createRecord() {
        this.dialogService.add(TuquiTriggerAddDialog, {
            agentId: this.props.context.default_tuqui_agent_id || false,
        });
    }
}

registry.category("views").add("tuqui_trigger_list", {
    ...listView,
    Controller: TuquiTriggerListController,
});

/**
 * `/odoo/tuqui-new-trigger?agent_id=<id>`: where `/tuqui/triggers/new`
 * redirects. Opens the triggers list with the wizard on top.
 */
export async function openNewTuquiTrigger(env, action) {
    const agentId = action.params?.agent_id || false;
    await env.services.action.doAction("tuqui_automation.action_tuqui_triggers", {
        clearBreadcrumbs: true,
    });
    env.services.dialog.add(TuquiTriggerAddDialog, { agentId });
}
openNewTuquiTrigger.path = "tuqui-new-trigger";

registry.category("actions").add("tuqui_automation.new_trigger", openNewTuquiTrigger);
