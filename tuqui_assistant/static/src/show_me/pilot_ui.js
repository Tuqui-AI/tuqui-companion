import { delay } from "@web/core/utils/concurrency";

/**
 * What the person sees while Tuqui drives: almost nothing new. A regular cursor that
 * travels to each control, and a soft sage light along the bottom of the screen
 * while the screen is being used. Plain DOM above Odoo, never part of the screen
 * the model reads (pointer-events: none), and gone at the end.
 */

const MOVE_MS = 380;
const PRESS_MS = 90;
const TYPE_CHAR_MS = 35;
const FADE_MS = 600;
// The arrow of a regular system cursor: black, white outline.
const ARROW = `<svg width="22" height="22" viewBox="0 0 24 24"><path d="M5 2.5v17.2l4.3-4.1 2.9 6.6 2.6-1.1-2.9-6.5h6z" fill="#000" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;


function node(className, parent, html = "") {
    const el = document.createElement("div");
    el.className = className;
    el.innerHTML = html;
    parent.appendChild(el);
    return el;
}

/** Where the cursor aims: the middle of a small control, the start of a wide one. */
function aim(el) {
    const box = el.getBoundingClientRect();
    return { x: box.left + Math.min(box.width / 2, 40), y: box.top + box.height / 2 };
}

export function createPilot() {
    const layer = node("o-tuqui-walk-pilot", document.body);
    node("o-tuqui-walk-glow", layer);
    const cursor = node("o-tuqui-walk-cursor", layer, ARROW);
    let position = { x: innerWidth / 2, y: innerHeight / 2 };
    const place = ({ x, y }) => (cursor.style.transform = `translate(${x}px, ${y}px)`);
    place(position);
    // Fade in on the next frame, so the transition runs.
    requestAnimationFrame(() => layer.classList.add("o-tuqui-walk-on"));

    return {
        /** The model is reading the screen: the light breathes a little faster. */
        thinking() {
            layer.classList.add("o-tuqui-walk-thinking");
        },
        chose() {
            layer.classList.remove("o-tuqui-walk-thinking");
        },
        async moveTo(el) {
            position = aim(el);
            place(position);
            await delay(MOVE_MS);
        },
        /** A click looks like a person's: the arrow dips for an instant, nothing else. */
        async click() {
            cursor.classList.add("o-tuqui-walk-press");
            await delay(PRESS_MS);
            cursor.classList.remove("o-tuqui-walk-press");
        },
        /**
         * Types `text` one character at a time; `onChar` gets the text so far.
         * Returns false when `interrupted` stopped it halfway.
         */
        async type(text, onChar) {
            for (let i = 1; i <= text.length; i++) {
                if (this.interrupted?.()) {
                    return false;
                }
                onChar(text.slice(0, i));
                await delay(TYPE_CHAR_MS);
            }
            return true;
        },
        async scroll() {
            await delay(PRESS_MS);
        },
        remove() {
            layer.classList.remove("o-tuqui-walk-on", "o-tuqui-walk-thinking");
            setTimeout(() => layer.remove(), FADE_MS);
        },
    };
}
