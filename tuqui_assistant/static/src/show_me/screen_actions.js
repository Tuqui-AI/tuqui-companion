import { delay } from "@web/core/utils/concurrency";
import { leaves, readTargets, recordName, screenRoot } from "@tuqui_assistant/screen/screen_targets";
import { menuOf, tuquiMayClick } from "@tuqui_assistant/show_me/menu_walk";

/**
 * What the walk can do on the current screen, as a list the model picks from: click a
 * control, open a record, type a phrase of the request into a search box, scroll.
 * Each action carries its own `run`, bound to the real element: the model only returns
 * an id, never a selector. Navigation only: nothing here types into a field,
 * ticks a box or saves.
 */

const MAX_RECORDS = 40;
const MAX_TEXT = 2000;
const MAX_SECTIONS = 60;
// The titles that split a long screen in parts: Settings blocks are <h2> (Odoo 19),
// form groups use the separator. What is out of view, the visible text cannot tell.
const SECTION_TITLES = "h1, h2, h3, .o_horizontal_separator";
const MAX_PHRASE_WORDS = 4;
const MAX_PHRASES = 24;
// Articles and prepositions: a phrase that starts or ends on one is not a search.
const MIN_EDGE_WORD = 3;
const TYPE_MS = 400;
// An allowlist, not a denylist: anything not known to only navigate stays out.
const NAVIGATING_ROLES = new Set(["link", "tab", "menuitem", "option"]);
// A view button runs a server method, even a smart button, and leaving a form saves it.
const ACTS_ON_SERVER = '[type="object"], [type="action"]';
// Odoo's menus, wherever they are drawn (top bar, dropdown, burger, home menu):
// every entry names the menu it opens.
const MENU_ENTRY = "[data-menu-xmlid]";
// What opens a menu without being an entry: the apps button, the burger on a phone,
// the "more" of the top bar's sections.
const MENU_OPENERS = ".o_menu_toggle, .o_mobile_menu_toggle, .o_menu_sections_more .dropdown-toggle";
// Everything else in the top bar, the burger and what Odoo draws over the page is
// not a way between screens: Tuqui's own button, the user menu with "Log out",
// "Save current search" (it creates a filter).
const MENUS_AND_OVERLAYS = ".o_main_navbar, .o_burger_menu, .o-overlay-container, .o_popover, .o-dropdown--menu";
// Buttons inside the view that only move between screens.
const NAVIGATION_BUTTONS = ".o_control_panel .breadcrumb, .o_cp_switch_buttons, .o_pager, .o_notebook_headers";
// Opening a dropdown (a card's menu, "Actions") changes nothing: what it shows is judged one by one.
const DROPDOWN_TOGGLE = ".dropdown-toggle";
// Chatter actions, and field widgets other than their links, edit the record.
const EDITS_IN_PLACE = ".o-mail-Chatter, .o_priority, .o_statusbar_status";

const squash = (text) => (text || "").replace(/\s+/g, " ").trim();

// Tuqui's own panel floats over the screen: what it covers is still the walk's to
// click (the page clicks it, not the pointer), so it is not a cover.
const OWN_PANEL = ".o-tuqui-panel";

/** Whether a click at the middle of `el` reaches it, and not a dialog or overlay on top. */
export function isReachable(el) {
    const box = el.getBoundingClientRect();
    // What is over the control once the panel is set aside: a dialog under the
    // panel still covers it.
    const top = document
        .elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        .find((node) => !node.closest(OWN_PANEL));
    return Boolean(top) && (el === top || el.contains(top) || top.contains(el));
}

/** The topmost dialog when one is open; otherwise the action, not the chat windows around it. */
function screenArea() {
    const dialog = screenRoot(document);
    return dialog !== document.body ? dialog : document.querySelector(".o_action_manager") || document.body;
}

/** The text a person sees now: only what is inside the viewport, as browser-use/jev-ultrafast does. */
function visibleText(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const words = [];
    let length = 0;
    for (let node = walker.nextNode(); node && length < MAX_TEXT; node = walker.nextNode()) {
        const value = squash(node.textContent);
        if (!value || node.parentElement.closest("script, style, .o-tuqui-walk-pilot")) {
            continue;
        }
        range.selectNodeContents(node);
        const box = range.getBoundingClientRect();
        if (box.width > 0 && box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth) {
            words.push(value);
            length += value.length;
        }
    }
    return words.join(" ").slice(0, MAX_TEXT);
}

/** Whether `el` is inside the window right now, not only rendered further down. */
function inView(el) {
    const box = el.getBoundingClientRect();
    return box.bottom > 0 && box.top < innerHeight;
}

/**
 * The titles of every part of the screen, seen or not: the visible text only covers
 * the window, and an option further down (a setting) is no control either.
 */
function sections(root) {
    const found = [];
    for (const el of root.querySelectorAll(SECTION_TITLES)) {
        const name = squash(el.innerText).slice(0, 80);
        const box = el.getBoundingClientRect();
        if (name && box.width > 0 && box.height > 0 && !found.some((s) => s.name === name)) {
            found.push({ name, el, seen: inView(el) });
        }
        if (found.length >= MAX_SECTIONS) {
            break;
        }
    }
    return found;
}

/** The part of the screen that scrolls: Odoo scrolls one of a few known containers, not the window. */
function scroller(root) {
    const known = ".modal-body, .o_content, .o_form_sheet_bg, .o_form_renderer, .o_list_renderer, .o_kanban_renderer";
    for (const el of [root, ...root.querySelectorAll(known)]) {
        const overflow = getComputedStyle(el).overflowY;
        if (["auto", "scroll"].includes(overflow) && el.scrollHeight > el.clientHeight + 2) {
            return el;
        }
    }
    return null;
}

// Odoo's menu service, once the walk's service starts: what each menu entry runs.
let odooMenus = null;

/** Hand the walk Odoo's menu service, to tell the entries Tuqui may click. */
export function knowMenus(menus) {
    odooMenus = menus;
}

/** Whether a click on `el` only moves between screens: nothing saved, nothing run. */
function navigates(el, role) {
    if (el.closest(ACTS_ON_SERVER) || el.closest(EDITS_IN_PLACE) || leaves(el)) {
        return false;
    }
    const entry = el.closest(MENU_ENTRY);
    if (entry) {
        return tuquiMayClick(menuOf(entry, odooMenus));
    }
    if (el.closest(MENU_OPENERS)) {
        return true;
    }
    if (el.closest(MENUS_AND_OVERLAYS)) {
        return false;
    }
    if (el.closest(".o_field_widget")) {
        return el.matches("a[href]");
    }
    return role === "button" ? Boolean(el.closest(NAVIGATION_BUTTONS) || el.matches(DROPDOWN_TOGGLE)) : NAVIGATING_ROLES.has(role);
}

/** Every run of 1 to 4 words of the request: what may be typed, without a model writing it. */
function phrases(goal) {
    const words = goal.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);
    const found = new Set();
    for (let start = 0; start < words.length; start++) {
        for (let size = 1; size <= MAX_PHRASE_WORDS && start + size <= words.length; size++) {
            found.add(words.slice(start, start + size).join(" "));
        }
    }
    const short = (phrase) => phrase.split(" ").some((w, i, all) => (i === 0 || i === all.length - 1) && w.length < MIN_EDGE_WORD);
    // A record's name is what a search finds, so a phrase with a capital or a digit
    // past the first word (a name, a number) goes before the cut, longest first.
    const named = (phrase) => /(^|\s)[\p{Lu}\p{N}]/u.test(phrase) && phrase !== words[0];
    const rank = (phrase) => (named(phrase) ? 10 : 0) + phrase.split(" ").length;
    return [...found]
        .filter((phrase) => !short(phrase))
        .sort((a, b) => rank(b) - rank(a))
        .slice(0, MAX_PHRASES);
}

/** Types like a person: one character at a time, each one an `input` Odoo reacts to. */
async function type(el, value, pilot) {
    el.focus();
    const typed = await pilot.type(value, (text) => {
        el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The person started typing too: what is in the box is theirs now.
    if (!typed) {
        return;
    }
    // The search autocomplete renders its items after the input.
    await delay(TYPE_MS);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

/** The screen in words, for the model, and the actions it can pick, each with the element it acts on. */
export function observe(goal) {
    // Read, never remember: the remembered list is the one the chat was sent, and
    // the drop resolves its ids against it.
    const { targets, elements } = readTargets();
    const area = screenArea();
    const actions = [];
    const add = (action) => actions.push({ id: `a${actions.length + 1}`, ...action });
    const parts = sections(area);
    // Going to a part of the screen that is out of view puts its title at the top:
    // the walk's own scroll only brings it to the bottom edge, with its content still
    // out of view, and the model cannot see it has arrived. First in the list: the
    // server caps the options, and a long screen has many controls.
    for (const part of parts.filter((p) => !p.seen)) {
        add({ role: "section", name: `go to section "${part.name}"`, el: part.el, run: () => part.el.scrollIntoView({ block: "start" }) });
    }
    for (const t of targets) {
        const el = elements.get(t.id);
        if (t.disabled || !navigates(el, t.role)) {
            continue;
        }
        add({ role: t.role, name: t.name, section: t.section, el, run: () => el.click() });
    }
    // A card's menu only shows while the pointer is over the card, so the screen's list
    // leaves it out; opening it changes nothing, and what it holds is judged like the rest.
    for (const toggle of area.querySelectorAll(".o_kanban_record .o_dropdown_kanban .dropdown-toggle")) {
        const card = toggle.closest(".o_kanban_record");
        if (inView(card)) {
            // Named like the card's own buttons, so the walk and the drop call the card the same.
            add({ role: "button", name: "card menu", section: recordName(card), el: toggle, run: () => toggle.click() });
        }
    }
    const records = area.querySelectorAll(".o_kanban_record:not(.o_kanban_ghost), .o_data_row");
    for (const record of [...records].slice(0, MAX_RECORDS)) {
        // A list row opens from a field cell, not from the row or its checkbox.
        const el = record.matches(".o_data_row") ? record.querySelector(".o_data_cell[name]") : record;
        const name = squash(record.innerText).slice(0, 80);
        if (el && name) {
            add({ role: "record", name, el, run: () => el.click() });
        }
    }
    for (const t of targets.filter((t) => t.role === "searchbox")) {
        const el = elements.get(t.id);
        for (const phrase of phrases(goal)) {
            add({ role: "search", name: `type "${phrase}" in ${t.name}`, phrase, el, run: (pilot) => type(el, phrase, pilot) });
        }
    }
    const scrolling = scroller(area);
    const scroll = (operation, name, sign) =>
        add({ role: "scroll", operation, name, run: (pilot) => pilot.scroll().then(() => scrolling.scrollBy({ top: sign * scrolling.clientHeight * 0.8, behavior: "smooth" })) });
    if (scrolling && scrolling.scrollTop + scrolling.clientHeight < scrolling.scrollHeight - 2) {
        scroll("scroll_down", "Scroll down", 1);
    }
    if (scrolling?.scrollTop > 0) {
        scroll("scroll_up", "Scroll up", -1);
    }
    const text = (selector) => [...document.querySelectorAll(selector)].map((el) => squash(el.innerText)).filter(Boolean);
    const screen = {
        app: text(".o_main_navbar .o_menu_brand").join("") || "home",
        breadcrumbs: text(".o_breadcrumb .breadcrumb-item, .o_breadcrumb .o_last_breadcrumb_item").join(" > "),
        active_tab: text(".o_notebook .nav-link.active").join(" | "),
        visible_text: visibleText(area),
        // Every part of the screen, with the ones out of view marked.
        sections: parts.map((p) => (p.seen ? p.name : `${p.name} (out of view)`)).join(" | "),
    };
    return { screen, actions };
}
