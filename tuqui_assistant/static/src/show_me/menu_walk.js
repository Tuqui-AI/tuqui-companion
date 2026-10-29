import { isOnScreen, SCREEN_ACTIONS } from "@tuqui_assistant/screen/screen_targets";

/**
 * The part of a walk that needs no model: Odoo's own menu, from the app down to the
 * item Tuqui's backend resolved (`odoo_show_me` with `menu`), clicked one entry at a
 * time with the same cursor. Odoo loaded these menus for this user, so an id it does
 * not know is a menu this user does not see.
 */

// What opens the apps (Enterprise's home menu, Community's apps dropdown), and what
// opens the top bar's entries when they do not fit (its "more", the phone's burger).
const APP_OPENERS = [".o_menu_toggle", ".o_navbar_apps_menu .dropdown-toggle"];
const SECTION_OPENERS = [".o_menu_sections_more .dropdown-toggle", ".o_mobile_menu_toggle"];

/** Whether Tuqui may click a menu of Odoo's menu service: it opens a screen, an app or a
 * dropdown. A menu that runs code, opens a URL or prints a report is the person's to
 * click, and one the service does not know could run anything: no. */
export function tuquiMayClick(menu) {
    return Boolean(menu) && (!menu.actionModel || SCREEN_ACTIONS.has(menu.actionModel));
}

/** The menu of Odoo's menu service that an entry on screen (`[data-menu-xmlid]`) stands
 * for. A menu a client created has no xmlid ("") and could be any of them: unknown. */
export function menuOf(entry, menus) {
    const xmlid = entry.dataset.menuXmlid;
    return xmlid ? menus?.getAll().find((menu) => menu.xmlid === xmlid) : undefined;
}

function visibleEntry(xmlid) {
    // The brand names the app on screen, not the way to another one.
    return [...document.querySelectorAll(`[data-menu-xmlid="${CSS.escape(xmlid)}"]`)].find(
        (el) => !el.closest(".o_menu_brand") && isOnScreen(el)
    );
}

function visibleOpener(selectors) {
    for (const selector of selectors) {
        const el = [...document.querySelectorAll(selector)].find(isOnScreen);
        if (el) {
            return el;
        }
    }
    return null;
}

/**
 * Click Odoo's menu down to `ids`, the menu ids from the app to the item.
 *
 * @param {number[]} ids
 * @param {{menus: object, action: object, press: (el: Element) => Promise<boolean>}} odoo
 *   Odoo's menu and action services, and how one entry is clicked: the cursor goes
 *   there, the page clicks, the screen settles. `press` returns false once the walk is cut.
 * @returns {Promise<{clicked: string[], arrived: boolean, reason?: string}>} The
 *   entries clicked, whether the item's screen is the one Odoo has open (or, for an
 *   item Tuqui may not click, whether it is on screen for the person), and why it
 *   stopped short when it did.
 */
export async function walkMenu(ids, { menus, action, press }) {
    const clicked = [];
    const entries = ids.map((id) => menus.getMenu(id));
    const missing = entries.findIndex((entry) => !entry);
    if (missing >= 0) {
        return { clicked, arrived: false, reason: "this user's Odoo does not show that menu" };
    }
    const atHome = Boolean(document.querySelector(".o_home_menu"));
    // Already in the app: its menus are on the top bar.
    const from = !atHome && menus.getCurrentApp()?.id === ids[0] && entries.length > 1 ? 1 : 0;
    for (const [level, entry] of entries.entries()) {
        if (level < from) {
            continue;
        }
        let el = visibleEntry(entry.xmlid);
        // A heading inside a dropdown ("Traslados" under "Operaciones") is a title over
        // its entries, not a click: the next entry is already there.
        const next = entries[level + 1];
        if (!el && next && level > 0 && !entry.actionID && visibleEntry(next.xmlid)) {
            continue;
        }
        if (!el) {
            const opener = visibleOpener(level === 0 ? APP_OPENERS : SECTION_OPENERS);
            if (opener && !(await press(opener))) {
                return { clicked, arrived: false, reason: "cut" };
            }
            el = visibleEntry(entry.xmlid);
        }
        if (!el) {
            return { clicked, arrived: false, reason: `the menu entry "${entry.name}" is not on screen` };
        }
        if (!tuquiMayClick(entry)) {
            return { clicked, arrived: true };
        }
        if (!(await press(el))) {
            return { clicked, arrived: false, reason: "cut" };
        }
        clicked.push(entry.name);
    }
    // An app opens its first screen, not an action of its own: being in it is the arrival.
    if (entries.length === 1) {
        return { clicked, arrived: menus.getCurrentApp()?.id === ids[0] && !document.querySelector(".o_home_menu") };
    }
    const last = entries[entries.length - 1];
    const open = action.currentController?.action?.id;
    return { clicked, arrived: Boolean(last.actionID) && open === last.actionID };
}
