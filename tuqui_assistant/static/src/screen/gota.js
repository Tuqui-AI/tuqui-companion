import { TourPointer } from "@web_tour/js/tour_pointer/tour_pointer";
import { createPointerState } from "@web_tour/js/tour_pointer/tour_pointer_state";
import { isOnScreen } from "@tuqui_assistant/screen/screen_targets";

/**
 * The drop («la gota»): Odoo's own tour pointer, in Tuqui's green, on the control
 * the assistant marked.
 *
 * Inheriting the pointer instead of drawing one keeps what took Odoo years to get
 * right: how it places itself, flips when it does not fit, and says "scroll down"
 * when the control is out of view. See gota.xml for the two template changes.
 */
export class Gota extends TourPointer {
    static template = "tuqui_assistant.Gota";
}

// The pointer does not follow a control that moves (a panel opening, a list
// loading): it is re-pointed at this interval while the mark is up.
const FOLLOW_MS = 300;
// A mark nobody followed stops meaning anything: the conversation moved on, and a
// drop left on screen reads as a step still pending.
export const GOTA_TTL_MS = 30000;
// The pointer aims at the middle of its anchor, and a field box spans half the
// form: its middle is empty space. On a wide control it aims at the value instead,
// where the person reads and clicks.
const WIDE = 120;
const AIM = 24;
const OPEN_LISTS = ".o-autocomplete--dropdown-menu, .o-dropdown--menu, .o_popover";
const canvas = document.createElement("canvas").getContext("2d");

/** How wide the value shown in `el` is, from its left edge. */
function valueWidth(el) {
    if (el.matches("input, textarea")) {
        const style = getComputedStyle(el);
        canvas.font = style.font;
        return parseFloat(style.paddingLeft) + canvas.measureText(el.value || el.placeholder || "").width;
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().width;
}

/** What the pointer aims at: the control itself, or its value when the control is wide. */
function aimAt(el, aim) {
    const box = el.getBoundingClientRect();
    if (box.width <= WIDE) {
        return el;
    }
    Object.assign(aim.style, {
        left: `${box.left}px`,
        top: `${box.top}px`,
        width: `${Math.max(AIM, Math.min(valueWidth(el), box.width))}px`,
        height: `${box.height}px`,
    });
    if (!aim.isConnected) {
        document.body.appendChild(aim);
    }
    return aim;
}

let current = null;

/** Whether a DOM change is the drop moving itself, not the screen changing. */
export function isGotaMutation(record) {
    const own = (node) => node.nodeType === Node.ELEMENT_NODE && node.closest?.(".o_tour_pointer, .o_tuqui_gota_aim");
    const nodes = [...record.addedNodes, ...record.removedNodes];
    return own(record.target) || (nodes.length > 0 && nodes.every(own));
}

/** Take the mark down, if there is one. */
export function hideGota() {
    current?.stop();
    current = null;
}

/** Whether the nearest container that scrolls sideways hides part of `el`. */
function isCutOffSideways(el) {
    for (let box = el.parentElement; box; box = box.parentElement) {
        if (box.scrollWidth > box.clientWidth && getComputedStyle(box).overflowX !== "visible") {
            const edge = box.getBoundingClientRect();
            const view = el.getBoundingClientRect();
            return view.left < edge.left || view.right > edge.right;
        }
    }
    return false;
}

/**
 * Mark `el`. One mark at a time: a new one replaces the previous. The mark goes
 * away after GOTA_TTL_MS, when the person clicks the control or its label, or when the control leaves
 * the screen (another view, hidden, behind a dialog): a mark left floating would
 * point at nothing. Another record in the same form is taken down by the service.
 */
export function showGota(overlay, el) {
    hideGota();
    // Only when out of view: a scroll closes the list of options the person may be choosing from.
    const view = el.getBoundingClientRect();
    if (view.top < 0 || view.bottom > window.innerHeight) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    const pointer = createPointerState();
    const remove = overlay.add(Gota, { pointerState: pointer.state, bounce: true }, { sequence: 1100 });
    // Always below the control, tip up: the shape of the drop says "here".
    const step = { content: "", tooltipPosition: "bottom" };
    const aim = document.createElement("div");
    aim.className = "o_tuqui_gota_aim position-fixed pe-none";
    // Re-aimed only when the control moved, its value changed or a list opened or
    // closed around it (the pointer places itself clear of an open list): every
    // re-aim re-renders the pointer.
    let placed = "";
    const reaim = () => {
        const box = el.getBoundingClientRect();
        const lists = document.querySelectorAll(OPEN_LISTS).length;
        const where = `${box.left},${box.top},${box.width},${box.height},${el.value ?? el.textContent},${lists}`;
        if (where !== placed) {
            placed = where;
            // Odoo's pointer only re-places itself when it re-renders, and pointing again at the
            // same anchor changes nothing it watches: letting go of the anchor first makes it.
            pointer.setState({ anchor: null });
            pointer.pointTo(aimAt(el, aim), step);
        }
    };
    const follow = setInterval(() => {
        if (!isOnScreen(el)) {
            return hideGota();
        }
        // The panel docking aside narrows a wide list: a row button can end past its edge.
        if (isCutOffSideways(el)) {
            el.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
        reaim();
    }, FOLLOW_MS);
    // A setting's box is usually ticked through its label, not on the box itself.
    const onPointerDown = (ev) =>
        (el.contains(ev.target) || [...(el.labels || [])].some((label) => label.contains(ev.target))) && hideGota();
    document.addEventListener("pointerdown", onPointerDown, true);
    reaim();
    const expire = setTimeout(hideGota, GOTA_TTL_MS);
    current = {
        stop() {
            clearTimeout(expire);
            clearInterval(follow);
            aim.remove();
            document.removeEventListener("pointerdown", onPointerDown, true);
            pointer.destroy();
            remove();
        },
    };
}
