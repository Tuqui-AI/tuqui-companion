/**
 * What the person can touch on screen, as a short list the assistant picks from.
 *
 * The assistant never names a DOM node. It gets `[{id, role, name, ...}]` and
 * answers with an `id`; this module keeps the id → element map. A name the
 * screen does not have cannot be pointed at, because it is not in the list.
 *
 * No Odoo imports on purpose: the same file runs in the web client, in the Hoot
 * tests and in the capture script of the benchmark.
 */

export const CONTROLS = [
    "button",
    // Anything styled as a button is clickable: Odoo's "Upload your file" is a label
    // wrapping a hidden file input, "Agregar Vendedores" of a kanban x2many a div.
    ".btn",
    "a[href]",
    "[role=button]",
    "[role=tab]",
    "[role=menuitem]",
    // A filter, a grouping or a measure in a search or view dropdown.
    "[role=menuitemcheckbox]",
    "[role=menuitemradio]",
    "[role=checkbox]",
    "[role=switch]",
    "input:not([type=hidden])",
    "select",
    "textarea",
].join(",");

export const OWN_PANEL = ".o-tuqui-panel";
// The assistant's own UI, Odoo's chat windows and its passing notifications are not
// part of the screen.
const NOT_THE_SCREEN = `${OWN_PANEL}, .o-mail-ChatWindow, .o-mail-ChatHub, .o_notification_manager`;
// The app's own menus, a way to a screen and not a step on it: Odoo tags each entry
// with its menu, plus the app tiles and the home button.
export const APP_MENUS = "[data-menu-xmlid], .o_app.o_menuitem, .o_menu_toggle";
// The action types Tuqui may open or click: screens, never code, a URL or a report.
export const SCREEN_ACTIONS = new Set(["ir.actions.act_window", "ir.actions.client"]);
const MAX_TARGETS = 300;
// What Odoo draws over the page (an open dropdown, a popover) is rendered at the end
// of it, and is what the person is looking at: read first, a crowded screen never
// leaves it out of the list.
const DRAWN_OVER = ".o-overlay-container";
const MAX_NAME = 80;
const MAX_RECORDS = 40;

let current = new Map();

function clean(text) {
    // Odoo pads empty checkbox labels with a zero-width space.
    return (text || "").replace(/[\u200b\u200c\u200d\ufeff]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

function isVisible(el) {
    if (!el.isConnected || el.closest('[inert], [aria-hidden="true"]')) {
        return false;
    }
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) {
        return false;
    }
    const style = getComputedStyle(el);
    return style.visibility === "visible" && style.display !== "none";
}

/** The box `el` scrolls in: what does not scroll with it can be scrolled away from it. */
function scrollerOf(el) {
    for (let node = el.parentElement; node; node = node.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) {
            return node;
        }
    }
    return el.ownerDocument.documentElement;
}

/**
 * Whether `cover` stays put while `el` scrolls: a sticky header, a fixed bar, a passing
 * notification. Scrolling to `el`, which marking it does, takes it out from under them.
 */
function staysPut(cover, el) {
    const scroller = scrollerOf(el);
    if (!scroller.contains(cover)) {
        return true;
    }
    for (let node = cover; node && !node.contains(el); node = node.parentElement) {
        if (["sticky", "fixed"].includes(getComputedStyle(node).position)) {
            return true;
        }
    }
    return false;
}

/**
 * Whether something else sits on top of `el`, so a click there would not reach it: the
 * link of a many2one that only shows on hover, under its input. Only judged inside the
 * viewport, and not for what stays put: a control further down, or under a fixed bar, is
 * reached by scrolling to it; one under Tuqui's own panel, by docking the panel aside.
 */
function isCovered(el) {
    const box = el.getBoundingClientRect();
    const view = el.ownerDocument.defaultView;
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    if (!view || x < 0 || y < 0 || x > view.innerWidth || y > view.innerHeight) {
        return false;
    }
    const top = el.ownerDocument.elementFromPoint(x, y);
    return Boolean(top) && !el.contains(top) && !top.contains(el) && !staysPut(top, el);
}

/** The topmost open dialog if there is one: what is behind it cannot be touched. */
export function screenRoot(doc) {
    const dialogs = doc.querySelectorAll(".modal.show .modal-content, .o_dialog .modal-content");
    return dialogs.length ? dialogs[dialogs.length - 1] : doc.body;
}

/** Whether a link leaves this Odoo or this tab: Settings' «Documentación» opens odoo.com. */
export function leaves(el) {
    const link = el.closest("a[href]");
    if (!link) {
        return false;
    }
    if (link.target && link.target !== "_self") {
        return true;
    }
    // A relative href ("/odoo/…", "#") stays here; an absolute or protocol-relative
    // one ("//odoo.com/…") leaves when its host differs.
    const href = link.getAttribute("href");
    return /^([a-z][a-z0-9+.-]*:)?\/\//i.test(href) && new URL(href, window.location.href).host !== window.location.host;
}

/** Whether the person can see and reach `el` now: visible, and not behind a dialog. */
export function isOnScreen(el) {
    return isVisible(el) && screenRoot(el.ownerDocument).contains(el);
}

function labelText(label) {
    // The "?" of a field tooltip is a <sup> inside the label, not part of its name.
    const tooltip = [...label.querySelectorAll("sup")].map((sup) => sup.innerText).join("");
    return clean(tooltip ? label.innerText.replace(tooltip, "") : label.innerText);
}

/**
 * The first label for `el` that has text. A settings checkbox has two: an empty
 * one next to the box and the setting's title, so the first one is not enough.
 */
function labelFor(el) {
    const labels = el.id ? [...el.ownerDocument.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`)] : [];
    const wrapping = el.closest("label");
    for (const label of wrapping ? [...labels, wrapping] : labels) {
        const text = labelText(label);
        if (text) {
            return text;
        }
    }
    return "";
}

export function nameOf(el) {
    return clean(
        el.getAttribute("aria-label") ||
            labelFor(el) ||
            (el.matches("input, select, textarea") ? "" : clean(el.innerText)) ||
            el.getAttribute("title") ||
            el.dataset.tooltip ||
            el.getAttribute("placeholder") ||
            columnOf(el)
    );
}

/** The header of the column `el` sits in: how a person names an empty field of a row. */
function columnOf(el) {
    const cell = el.closest("td[name]");
    const column = cell && CSS.escape(cell.getAttribute("name"));
    return column ? cell.closest("table")?.querySelector(`thead th[data-name="${column}"]`)?.innerText || "" : "";
}

function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) {
        return explicit;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "label" || el.matches(".btn:not(a, input)")) {
        return "button";
    }
    if (tag === "a") {
        return "link";
    }
    if (tag === "input") {
        return ["checkbox", "radio"].includes(el.type) ? el.type : "textbox";
    }
    return { select: "combobox", textarea: "textbox" }[tag] || tag;
}

const SECTIONS = ".o_setting_box, .o_settings_container, .app_settings_block, .o_notebook .tab-pane, .o_group";

/** Where the control sits, in the words the screen uses: an app's menu, a settings block, a tab. */
export function sectionOf(el) {
    // A top-bar menu belongs to the open app: "Configuración" of Contacts does not
    // lead to the configuration of Inventory.
    if (el.closest(".o_main_navbar .o_menu_sections")) {
        return clean(el.ownerDocument.querySelector(".o_main_navbar .o_menu_brand")?.innerText);
    }
    // A control inside a row or a card belongs to that record: a list with an «Aplicar» per
    // row has one per product, told apart by the row («Mesa plegable»), then by the block.
    const record = el.parentElement?.closest(RECORDS);
    const outer = blockName(el);
    if (record) {
        return outer ? `${recordName(record)} · ${outer}` : recordName(record);
    }
    return outer;
}

/** The nearest block that has a name: an untitled group inside a tab belongs to the tab. */
function blockName(el) {
    for (let block = el; (block = block.parentElement?.closest(SECTIONS)); ) {
        const title = block.querySelector(":scope > h2, :scope > .o_setting_right_pane .o_form_label, :scope > .o_horizontal_separator");
        // A tab's content has no name of its own: only the open tab is drawn, named by its header.
        const tab = block.matches(".tab-pane") && block.closest(".o_notebook")?.querySelector(".nav-link.active");
        const name = clean(block.dataset.string || title?.textContent || tab?.innerText);
        if (name) {
            return name;
        }
    }
    return "";
}

/**
 * Read the visible controls of the screen without remembering them: what
 * `collectTargets` lists, plus the element behind each id.
 */
export function readTargets(doc = document) {
    const root = screenRoot(doc);
    const found = new Map();
    const targets = [];
    const controls = [...root.querySelectorAll(CONTROLS)];
    const over = controls.filter((el) => el.closest(DRAWN_OVER));
    for (const el of [...over, ...controls.filter((el) => !el.closest(DRAWN_OVER))]) {
        if (targets.length >= MAX_TARGETS) {
            break;
        }
        if (el.closest(NOT_THE_SCREEN) || !isVisible(el) || isCovered(el)) {
            continue;
        }
        const name = nameOf(el);
        if (!name) {
            continue;
        }
        const id = `t${targets.length + 1}`;
        const target = { id, role: roleOf(el), name };
        const field = el.closest(".o_field_widget[name]")?.getAttribute("name");
        if (field) {
            target.field = field;
        }
        // The label says "Confirm"; the method (`action_post`) is what the agent can
        // run instead of writing the state by hand. Only an object button names a
        // method: an action button's name is an action id or xmlid. And only one in the
        // header of the form on screen runs on that form's record: a line's button or a
        // dialog's runs on another model, and a smart button only navigates.
        const ownHeader = el.closest(".o_form_statusbar") && !el.closest(".modal, .o_dialog");
        const method = ownHeader && el.matches("button[name][type=object]") ? el.getAttribute("name") : "";
        if (method) {
            target.method = method;
        }
        const section = sectionOf(el);
        if (section && section !== name) {
            target.section = section;
        }
        if (el.disabled || el.getAttribute("aria-disabled") === "true") {
            target.disabled = true;
        }
        // Whether a box is ticked decides whether "tick it" is the right advice.
        if (el.matches("input[type=checkbox], input[type=radio]") || el.getAttribute("aria-checked")) {
            target.checked = el.matches("input") ? el.checked : el.getAttribute("aria-checked") === "true";
        }
        // A way to another screen or out of this Odoo is not a step on this one: the
        // list Tuqui reads leaves it out, and the walk still takes it.
        if (el.closest(APP_MENUS) || leaves(el)) {
            target.nav = true;
        }
        found.set(id, el);
        targets.push(target);
    }
    // The rows and cards too: without them a guide asks to search for what is already listed.
    for (const { target, el } of readRecords(doc, Math.min(MAX_RECORDS, MAX_TARGETS - targets.length))) {
        found.set(target.id, el);
        targets.push(target);
    }
    return { targets, elements: found };
}

/**
 * Make `elements` the list `elementFor` answers from. Only the list the chat was
 * sent may be remembered: ids are positions, so a newer read renumbers them.
 */
export function rememberTargets(elements) {
    current = elements;
}

/**
 * Collect the visible controls of the screen and remember them for `elementFor`.
 * Each call replaces the previous list: an id is only valid for the screen it
 * was read from.
 */
export function collectTargets(doc = document) {
    const { targets, elements } = readTargets(doc);
    rememberTargets(elements);
    return targets;
}

const fold = (text) => (text || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();

// A list row or a kanban card is not a control, but a guide names it by its text
// ("open the Supervielle mapping"): it can be marked when no control has the name.
export const RECORDS = ".o_data_row, .o_kanban_record:not(.o_kanban_ghost)";

/** A row or card as the person reads it: its text. */
export function recordName(record) {
    return clean(record.innerText);
}

/** The first `limit` records on the screen, named by their text: a row is marked on its first cell with text. */
function readRecords(doc, limit) {
    const records = [];
    for (const record of screenRoot(doc).querySelectorAll(RECORDS)) {
        if (records.length >= limit) {
            break;
        }
        if (record.closest(NOT_THE_SCREEN)) {
            continue;
        }
        const name = recordName(record);
        // The first cell with text: a sorted list starts with an empty drag handle that opens nothing.
        const el = name && ([...record.querySelectorAll(".o_data_cell")].find((cell) => clean(cell.innerText)) || record);
        if (el && isVisible(el)) {
            const target = { id: `r${records.length + 1}`, role: "record", name };
            const section = sectionOf(record);
            if (section && section !== name) {
                target.section = section;
            }
            records.push({ target, el });
        }
    }
    return records;
}

/**
 * The cells of `field` in the rows on screen: in a list the field of a row is its cell
 * (a click there edits it), not the row's first column. Named and placed by their row.
 */
function fieldCells(doc, field) {
    if (!field) {
        return [];
    }
    // Each kind of record on its own: RECORDS is a list, and a prefix would only bind to its last part.
    const inRecords = RECORDS.split(",").map((record) => `${record.trim()} [name="${CSS.escape(field)}"]`);
    return [...screenRoot(doc).querySelectorAll(inRecords.join(","))]
        .filter((el) => isVisible(el) && !el.closest(NOT_THE_SCREEN))
        .map((el) => ({ target: { role: "cell", name: clean(el.innerText), field, section: recordName(el.closest(RECORDS)) }, el }));
}

/**
 * Whether the matches are parts of one widget, not several controls: same section,
 * and all within two levels of their closest common container. Odoo's search box is
 * a magnifier button and an input that both answer to "Search…"; the same button on
 * two dashboard cards sits in different cards, much further apart.
 */
function oneWidget(found) {
    if (found.length < 2 || new Set(found.map(({ target }) => target.section || "")).size > 1) {
        return false;
    }
    const depth = (el, container) => {
        let steps = 0;
        for (let node = el; node && node !== container; node = node.parentElement) {
            steps++;
        }
        return steps;
    };
    let common = found[0].el.parentElement;
    while (common && !found.every(({ el }) => common.contains(el))) {
        common = common.parentElement;
    }
    return Boolean(common) && found.every(({ el }) => depth(el, common) <= 2);
}

const area = (el) => {
    const box = el.getBoundingClientRect();
    return box.width * box.height;
};

/**
 * The controls on the screen right now that answer to `name` (and `section`, when
 * given), read fresh: no list remembered from an earlier turn, so it holds after a
 * walk or a navigation. The same name is matched whole first, and only if nothing
 * has it whole, as part of a longer name (a guide may say "Importar" for
 * "Importar extracto"). A list row or a kanban card counts too, by its text, after
 * the controls with the same kind of match. Parts of one widget (a search box's
 * button and input) count as one.
 *
 * @returns {{ found: {target: object, el: Element}[], elsewhere: string[] }}
 *   `found`: the matches in `section` (all of them without one). `elsewhere`: the
 *   sections that have the name, when `section` filtered every match out.
 */
export function findByName(name, section = "", doc = document, field = "") {
    const wanted = fold(name);
    if (!wanted && !field) {
        return { found: [], elsewhere: [] };
    }
    const { targets, elements } = readTargets(doc);
    const read = targets.map((target) => ({ target, el: elements.get(target.id) }));
    const controls = read.filter(({ target }) => target.role !== "record");
    const records = read.filter(({ target }) => target.role === "record");
    const whole = (list) => list.filter(({ target }) => wanted && fold(target.name) === wanted);
    const part = (list) => list.filter(({ target }) => wanted && fold(target.name).includes(wanted));
    // The field, when the name was a guess: the label on screen may differ from the
    // field's string the data says (Odoo 19 labels sale_ok «Ventas»).
    const byField = [...controls.filter(({ target }) => field && target.field === field), ...fieldCells(doc, field)];
    // A control's whole name, then a record's, then part of a name: a row called
    // "Supervielle" is closer than a button "Import Supervielle".
    const byName = [whole(controls), whole(records), part(controls), part(records), byField].find((list) => list.length) || [];
    // Two controls may share a label (a price type «Descuento» and the «Descuento» percent):
    // the field it names says which one.
    const ofField = byName.filter(({ el, target }) => field && (target.field === field || el.closest(`[name="${CSS.escape(field)}"]`)));
    const named = ofField.length ? ofField : byName;
    const place = fold(section);
    // The closest section first: a row named by its start beats rows that only carry the
    // same words further in (a date every row of a list shows).
    const placeOf = ({ target }) => fold(target.section);
    let found = place
        ? [
              named.filter((item) => placeOf(item) === place),
              named.filter((item) => placeOf(item).startsWith(place)),
              named.filter((item) => placeOf(item).includes(place)),
          ].find((list) => list.length) || []
        : named;
    if (!found.length && ofField.length === 1) {
        // The field is exact and the section a guess: one control of that field is the one.
        found = ofField;
    }
    const over = found.filter(({ el }) => el.closest(DRAWN_OVER));
    if (found.length > 1 && over.length === 1) {
        // An open dropdown is what the person is looking at: its entry beats the page beneath.
        found = over;
    }
    if (oneWidget(found)) {
        // One widget read as several controls: the person sees one thing, mark its biggest part.
        found = [found.reduce((best, item) => (area(item.el) > area(best.el) ? item : best))];
    }
    return {
        found,
        elsewhere: place && !found.length ? [...new Set(named.map(({ target }) => target.section || ""))] : [],
    };
}

/**
 * The element behind an id of the last remembered list, or null if it left the
 * screen. With `expected` (the name and role the chat chose), an id that now names
 * another control falls back to the one control on screen with that name and role:
 * ids are positions, and the screen may have been re-read since the turn started.
 */
/** Whether the remembered control `id` is still there, but behind an open dialog. */
export function isBehindDialog(id) {
    const el = current.get(id);
    return Boolean(el) && isVisible(el) && !screenRoot(document).contains(el);
}

export function elementFor(id, { name, role } = {}) {
    // On screen, not just visible: a control behind an open dialog cannot be reached.
    // The root once per call: the fallback below tries every remembered control.
    const root = screenRoot(document);
    const is = (el) =>
        el && isVisible(el) && root.contains(el) && (!name || nameOf(el) === name) && (!role || roleOf(el) === role);
    const el = current.get(id);
    if (is(el)) {
        return el;
    }
    if (!name) {
        return null;
    }
    const same = [...current.values()].filter(is);
    return same.length === 1 ? same[0] : null;
}
