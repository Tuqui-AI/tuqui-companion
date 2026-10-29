/** @odoo-module **/

import { describe, expect, test } from "@odoo/hoot";
import { patchWithCleanup } from "@web/../tests/web_test_helpers";
import { cookie } from "@web/core/browser/cookie";
import { session } from "@web/session";

import { framedCookie } from "@tuqui_embed/cookies_when_framed";
import { framing } from "@tuqui_embed/no_tours_when_framed";

describe("tuqui_embed: cookies written from JS inside a frame", () => {
    test("Odoo's cookie gets the attributes a cross-site frame keeps", () => {
        expect(framedCookie("color_scheme=dark; path=/; max-age=31536000")).toBe(
            "color_scheme=dark; path=/; max-age=31536000; Secure; SameSite=None; Partitioned"
        );
    });

    test("attributes already present are replaced, not repeated", () => {
        // A `SameSite=Lax` left next to `SameSite=None` is the browser's call,
        // and it does not have to pick ours.
        expect(framedCookie("tz=UTC; path=/; SameSite=Lax; secure")).toBe(
            "tz=UTC; path=/; Secure; SameSite=None; Partitioned"
        );
    });

    test("an attribute-like name is still the cookie, not an attribute", () => {
        expect(framedCookie("secure-mode=1; path=/")).toBe("secure-mode=1; path=/; Secure; SameSite=None; Partitioned");
    });

    test("a delete keeps its max-age=0", () => {
        expect(framedCookie("cids=kill; path=/; max-age=0")).toBe(
            "cids=kill; path=/; max-age=0; Secure; SameSite=None; Partitioned"
        );
    });

    test("inside Tuqui's panel, cookie.set writes the framed cookie", () => {
        patchWithCleanup(session, { tuqui_embed_panel: true });
        patchWithCleanup(framing, { isFramed: () => true });
        cookie.set("color_scheme", "dark");
        expect(document.cookie).toInclude("Partitioned");
    });

    test("in a frame that is not Tuqui's panel, the cookie is left as Odoo writes it", () => {
        patchWithCleanup(session, { tuqui_embed_panel: false });
        patchWithCleanup(framing, { isFramed: () => true });
        cookie.set("color_scheme", "dark");
        expect(cookie.get("color_scheme")).toBe("dark");
        expect(document.cookie).not.toInclude("Partitioned");
    });
});
