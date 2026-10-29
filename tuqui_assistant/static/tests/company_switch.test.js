/** @odoo-module **/
import { describe, expect, test } from "@odoo/hoot";
import { patchWithCleanup } from "@web/../tests/web_test_helpers";
import { user } from "@web/core/user";

import { companyInPlay, switchCompany } from "@tuqui_assistant/services/tuqui_assistant_service";

/**
 * The companies on the user's screen, and switching between them.
 *
 * A new record opens in the CURRENT company whatever the request names. Asked
 * for a sale order in a company that was not active, the assistant opened it in
 * the active one and said nothing. The two scenarios below are the ones that
 * reproduced it: only Nogal active, and both active.
 */

const NOGAL = { id: 1, name: "Nogal Muebles" };
const ALGARROBO = { id: 2, name: "Algarrobo Muebles AUX" };

function withCompanies(active, allowed) {
    const activations = [];
    patchWithCleanup(user, {
        get activeCompany() {
            return active[0];
        },
        get activeCompanies() {
            return active;
        },
        allowedCompanies: allowed,
        activateCompanies(ids, options) {
            activations.push({ ids, options });
        },
    });
    return activations;
}

describe("companyInPlay", () => {
    test("only Nogal active: Algarrobo is allowed but not active", () => {
        withCompanies([NOGAL], [NOGAL, ALGARROBO]);
        expect(companyInPlay()).toEqual({
            current: NOGAL,
            active: [NOGAL],
            available: [ALGARROBO],
            switchMode: "live",
        });
    });

    test("both active: nothing left to switch to", () => {
        withCompanies([NOGAL, ALGARROBO], [NOGAL, ALGARROBO]);
        expect(companyInPlay()).toEqual({
            current: NOGAL,
            active: [NOGAL, ALGARROBO],
            available: [],
            switchMode: "live",
        });
    });

    test("many companies: the list is cut and says so", () => {
        const many = [NOGAL];
        for (let i = 10; i < 40; i++) {
            many.push({ id: i, name: `Company ${i}` });
        }
        withCompanies([NOGAL], many);
        const info = companyInPlay();
        expect(info.available).toHaveLength(20);
        expect(info.availableTotal).toBe(30);
    });

    test("the active ones are never cut: a missing one would read as no access", () => {
        const many = [];
        for (let i = 1; i <= 25; i++) {
            many.push({ id: i, name: `Company ${i}` });
        }
        withCompanies(many, many);
        expect(companyInPlay().active).toHaveLength(25);
    });

    test("no current company: no half object", () => {
        withCompanies([], []);
        expect(companyInPlay()).toBe(null);
    });
});

describe("switchCompany", () => {
    test("makes the company current, keeps the others active, and does not reload", () => {
        const activations = withCompanies([NOGAL], [NOGAL, ALGARROBO]);
        expect(switchCompany(ALGARROBO.id)).toBe(true);
        expect(activations).toEqual([
            { ids: [ALGARROBO.id, NOGAL.id], options: { includeChildCompanies: false, reload: false } },
        ]);
    });

    test("refuses a company the user is not allowed in", () => {
        const activations = withCompanies([NOGAL], [NOGAL]);
        expect(switchCompany(99)).toBe(false);
        expect(activations).toEqual([]);
    });
});
