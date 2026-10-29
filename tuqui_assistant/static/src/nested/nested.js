/** @odoo-module **/

import { session } from "@web/session";

/**
 * No Tuqui assistant inside an Odoo that is itself shown inside Tuqui.
 *
 * Tuqui's side panel can show this Odoo (module `tuqui_embed`).
 * Without this, that Odoo brings its own assistant button, which opens Tuqui
 * inside Odoo inside Tuqui. The conversation is already on the other side of
 * the screen: the Odoo in the panel is a view.
 *
 * Decided by the panel session's own mark, `tuqui_embed_panel`, which
 * `tuqui_embed` sets on `session_info`. Not by "am I in a frame": a customer
 * that shows its Odoo inside its own intranet keeps the assistant, and without
 * `tuqui_embed` nothing changes.
 *
 * Only the button and the panel are hidden. Nothing has to be undone in
 * storage: inside a cross-site frame the browser partitions it, so the
 * assistant there starts closed anyway.
 */

export const NESTED_CLASS = "o-tuqui-nested";

export function isTuquiPanel(info = session) {
    return Boolean(info?.tuqui_embed_panel);
}

if (isTuquiPanel()) {
    document.documentElement.classList.add(NESTED_CLASS);
}
