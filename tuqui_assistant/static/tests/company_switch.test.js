/** @odoo-module **/
import { describe, expect, test } from "@odoo/hoot";

import { companyInPlay, switchCompany } from "@tuqui_assistant/services/tuqui_assistant_service";

/**
 * The companies on the user's screen, and switching between them.
 * Odoo 18's company service always reloads to switch, hence `switchMode: "reload"`.
 */

const NOGAL = { id: 1, name: "Nogal Muebles" };
const ALGARROBO = { id: 2, name: "Algarrobo Muebles AUX" };

function companyService(activeIds, allowed) {
    const calls = [];
    return {
        calls,
        allowedCompanies: Object.fromEntries(allowed.map((c) => [c.id, c])),
        activeCompanyIds: activeIds,
        get currentCompany() {
            return this.allowedCompanies[activeIds[0]];
        },
        setCompanies(ids, includeChildCompanies) {
            calls.push({ ids, includeChildCompanies });
        },
    };
}

describe("companyInPlay", () => {
    test("only Nogal active: Algarrobo is allowed but not active", () => {
        expect(companyInPlay(companyService([1], [NOGAL, ALGARROBO]))).toEqual({
            current: NOGAL,
            active: [NOGAL],
            available: [ALGARROBO],
            switchMode: "reload",
        });
    });

    test("the active ones are never cut: a missing one would read as no access", () => {
        const many = [];
        for (let i = 1; i <= 25; i++) {
            many.push({ id: i, name: `Company ${i}` });
        }
        const info = companyInPlay(companyService(many.map((c) => c.id), many));
        expect(info.active).toHaveLength(25);
    });

    test("no company service data: no half object", () => {
        expect(companyInPlay(companyService([], []))).toBe(null);
    });
});

describe("switchCompany", () => {
    test("makes the company current and keeps the others active", () => {
        const company = companyService([1], [NOGAL, ALGARROBO]);
        expect(switchCompany(company, 2)).toBe(true);
        expect(company.calls).toEqual([{ ids: [2, 1], includeChildCompanies: false }]);
    });

    test("refuses a company the user is not allowed in", () => {
        const company = companyService([1], [NOGAL]);
        expect(switchCompany(company, 99)).toBe(false);
        expect(company.calls).toEqual([]);
    });
});
