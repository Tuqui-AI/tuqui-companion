/** @odoo-module **/

/**
 * Do not resume tours while this screen is shown inside another site.
 *
 * A tour inside a cross-origin iframe throws SecurityError in a loop and kills
 * the tab. Odoo's guard, `!window.frameElement`, is `null` cross-origin, so it
 * does not hold; `window.top !== window.self` does. A tour started in the
 * everyday Odoo is resumed here from `localStorage`, so the server half alone
 * is not enough. A deliberate `startTour` still works (see `startedHere`), and
 * the user's progress in `localStorage` is kept.
 */

import { patch } from "@web/core/utils/patch";
import { tourState } from "@web_tour/tour_service/tour_state";

/**
 * It lives on an object — rather than as a loose function — so the test can
 * substitute it. The patch is applied ALWAYS and the decision is taken on every
 * call: that way it does not depend on the frame's state at import time, which
 * is precisely what cannot be simulated in a test.
 */
export const framing = {
    /** Is this page inside a frame? Holds cross-origin too. */
    isFramed() {
        try {
            return window.top !== window.self;
        } catch {
            // Reading `window.top` cross-origin does not throw, but if it ever
            // did, being framed is the conservative answer.
            return true;
        }
    },
};

/** Whether a tour was started ON PURPOSE in this page, as opposed to found
 *  half-finished in `localStorage` from another one. */
let startedHere = false;

patch(tourState, {
    setCurrentTour(tourName) {
        // The only caller is `startTour`. Reaching here means somebody asked
        // for this tour, in this page, right now.
        startedHere = true;
        return super.setCurrentTour(tourName);
    },
    getCurrentTour() {
        if (framing.isFramed() && !startedHere) {
            return null;
        }
        return super.getCurrentTour();
    },
    clear() {
        // The tour is over: the next read is an automatic resume again.
        startedHere = false;
        return super.clear();
    },
});
