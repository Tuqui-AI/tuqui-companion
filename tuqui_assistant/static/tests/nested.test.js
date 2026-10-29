import { describe, expect, test } from "@odoo/hoot";
import { isTuquiPanel } from "@tuqui_assistant/nested/nested";

/**
 * Which Odoo hides the assistant: only the one Tuqui shows in its panel, by the
 * mark `tuqui_embed` puts on the panel session. Being in a frame is not enough.
 */
describe("the assistant inside Tuqui's panel", () => {
    test("hides on the panel session's mark", () => {
        expect(isTuquiPanel({ tuqui_embed_panel: true })).toBe(true);
    });

    test("stays everywhere else, also without tuqui_embed", () => {
        expect(isTuquiPanel({ tuqui_embed_panel: false })).toBe(false);
        expect(isTuquiPanel({})).toBe(false);
        expect(isTuquiPanel(undefined)).toBe(false);
    });
});
