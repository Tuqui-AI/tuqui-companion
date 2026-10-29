/** @odoo-module **/

/**
 * No service worker while this screen is shown inside Tuqui's panel.
 *
 * With one, the second record opened in the frame loops between `/odoo/...`
 * and `/web/login` (measured, cause unknown). Decided here because the
 * request for the worker arrives without the panel cookie.
 */

import { patch } from "@web/core/utils/patch";
import { WebClient } from "@web/webclient/webclient";

import { framing } from "./no_tours_when_framed";

patch(WebClient.prototype, {
    registerServiceWorker() {
        if (!framing.isFramed()) {
            return super.registerServiceWorker(...arguments);
        }
        navigator.serviceWorker?.getRegistrations?.().then((registrations) => {
            for (const registration of registrations) {
                registration.unregister();
            }
        });
    },
});
