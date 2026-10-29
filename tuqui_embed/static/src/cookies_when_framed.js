/** @odoo-module **/

/**
 * Cookies the web client writes itself survive inside Tuqui's panel.
 *
 * A cross-site frame drops a cookie without `SameSite=None; Secure`, and with
 * third-party cookies blocked it only keeps `Partitioned` ones. Odoo's
 * `cookie.set` writes neither, so Enterprise's `color_scheme` writes
 * `color_scheme=dark` and reloads forever with the OS in dark mode. The session
 * cookie gets the same attributes from the server (`panel_cookie.py`).
 */

import { cookie } from "@web/core/browser/cookie";
import { patch } from "@web/core/utils/patch";
import { session } from "@web/session";

import { framing } from "./no_tours_when_framed";

const FRAMED_ATTRIBUTES = ["Secure", "SameSite=None", "Partitioned"];
const ATTRIBUTE_RE = /^(secure|samesite|partitioned)\b/i;

/** `document.cookie` value with the attributes a cross-site frame needs. */
export function framedCookie(value) {
    const [nameValue, ...attributes] = value.split("; ");
    return [nameValue, ...attributes.filter((part) => !ATTRIBUTE_RE.test(part)), ...FRAMED_ATTRIBUTES].join("; ");
}

patch(cookie, {
    set _cookieMonster(value) {
        // `Secure` outside a secure context makes the browser drop the cookie altogether.
        const framed = session.tuqui_embed_panel && framing.isFramed() && window.isSecureContext;
        super._cookieMonster = framed ? framedCookie(value) : value;
    },
});
