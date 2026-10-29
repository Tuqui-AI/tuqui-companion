import { Component } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { _t } from "@web/core/l10n/translation";
import { useService } from "@web/core/utils/hooks";

/**
 * "When should your agent be triggered?": one card per kind of trigger. Each
 * card opens the automation form with that trigger preset (and the agent, when
 * it comes from Tuqui). Same pattern as Odoo 20's agent trigger dialog.
 */
export class TuquiTriggerAddDialog extends Component {
    static template = "tuqui_automation.TriggerAddDialog";
    static components = { Dialog };
    static props = {
        agentId: { type: [String, Boolean], optional: true },
        close: Function,
    };

    setup() {
        this.action = useService("action");
    }

    get cards() {
        return [
            {
                trigger: "on_create",
                icon: "fa-plus-circle",
                title: _t("After Creation"),
                description: _t("Runs whenever a new record is added."),
            },
            {
                trigger: "on_create_or_write",
                icon: "fa-pencil",
                title: _t("When a Field Changes"),
                description: _t("Runs when one of the fields you choose changes."),
            },
            {
                trigger: "on_time",
                icon: "fa-calendar",
                title: _t("Based on a Date Field"),
                description: _t("Runs once per record, when a date is reached."),
            },
        ];
    }

    openForm(trigger) {
        const context = { tuqui_preset_trigger: trigger, tuqui_trigger_form: 1 };
        if (this.props.agentId) {
            context.default_tuqui_agent_id = this.props.agentId;
        }
        this.props.close();
        return this.action.doAction({
            type: "ir.actions.act_window",
            name: _t("New Tuqui Trigger"),
            res_model: "base.automation",
            views: [[false, "form"]],
            target: "current",
            context,
        });
    }
}
