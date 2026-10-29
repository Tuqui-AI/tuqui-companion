/** @odoo-module **/
import { isObject } from "@web/core/utils/objects";

// The keys a view adds to its favorite context (`useSetupAction({getContext})`),
// a prefix list shared with the Tuqui server. In Odoo 19 pivot, graph and cohort
// add them; gantt, grid, map and planning keep their state elsewhere. Reading and
// opening a view use only these, so what the agent reads in one turn is what it
// can pass back in the next.
const VIEW_KEY = /^(pivot|graph|cohort|gantt|planning|grid|map)_[a-z0-9_]+$/;

const scalar = (value) => value === null || ["string", "number", "boolean"].includes(typeof value);
const plain = (value) => scalar(value) || (Array.isArray(value) && value.every(scalar));

/**
 * The view keys of `context`, without anything else the search or the action
 * carry.
 *
 * @param {Object} [context]
 * @returns {Object}
 */
export function viewContextKeys(context) {
    const picked = {};
    if (!isObject(context)) {
        return picked;
    }
    for (const [key, value] of Object.entries(context)) {
        if (VIEW_KEY.test(key) && plain(value)) {
            picked[key] = value;
        }
    }
    return picked;
}

/**
 * The action context that opens a view as `kind: "view"` reported it.
 *
 * @param {string[]} [groupBy]
 * @param {Object} [context] view keys, e.g. `pivot_row_groupby`
 * @returns {Object}
 */
export function browseContext(groupBy, context) {
    const result = viewContextKeys(context);
    if (Array.isArray(groupBy) && groupBy.length && groupBy.every((g) => typeof g === "string" && g)) {
        result.group_by = groupBy;
    }
    return result;
}
