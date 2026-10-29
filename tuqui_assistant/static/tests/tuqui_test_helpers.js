/** @odoo-module **/
import { mountView } from "@web/../tests/web_test_helpers";
import { CallbackRecorder } from "@web/search/action_hook";

/** Mount `params` as the action's main view: the action service hands it its recorders. */
export function mountMainView(params) {
    return mountView({ ...params, __getGlobalState__: new CallbackRecorder() });
}
