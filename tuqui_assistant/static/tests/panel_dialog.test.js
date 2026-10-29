/** @odoo-module **/
import { beforeEach, describe, expect, test } from "@odoo/hoot";
import { animationFrame } from "@odoo/hoot-mock";
import { Component, xml } from "@odoo/owl";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { MainComponentsContainer } from "@web/core/main_components_container";
import {
    defineModels,
    fields,
    getService,
    models,
    mountViewInDialog,
    mountWithCleanup,
    onRpc,
} from "@web/../tests/web_test_helpers";

/**
 * El panel con un diálogo de Odoo abierto.
 *
 * El panel vive en $zindex-sticky para no tapar dropdowns ni popovers. Los
 * diálogos viven en overlay items a $zindex-modal y su `.modal` cubre toda la
 * pantalla: sin la regla de `panel.scss`, el panel se ve pero no se puede tocar
 * (por ejemplo, con "Redactar correo electrónico" abierto).
 *
 * Cómo correrlos: ver el encabezado de `apply_proposal.test.js`.
 */

class Partner extends models.Model {
    _name = "res.partner";
    name = fields.Char();
    _records = [{ id: 1, name: "Acme" }];
}
// A wizard with no name field: Odoo names its records "model,id".
class SmsConfirmation extends models.Model {
    _name = "confirm.stock.sms";
    _rec_name = false;
    note = fields.Char();
    _records = [{ id: 4, display_name: "confirm.stock.sms,4", note: "x" }];
}
defineModels([Partner, SmsConfirmation]);

class TestPopover extends Component {
    static template = xml`<div class="o-test-popover">popover</div>`;
}

const zIndex = (selector) => Number(getComputedStyle(document.querySelector(selector)).zIndex);

describe("panel con un diálogo abierto", () => {
    let assistant;

    beforeEach(async () => {
        onRpc("tuqui.assistant.sso.nonce", "embed_bootstrap", () => ({
            connected: false,
            base_url: null,
            slug: null,
        }));
        await mountWithCleanup(MainComponentsContainer);
        assistant = getService("tuquiAssistant");
        assistant.toggleVisibility();
        await animationFrame();
    });

    test("sin diálogo, el panel queda debajo de los popovers", async () => {
        getService("popover").add(document.body, TestPopover);
        await animationFrame();
        expect(zIndex(".o-tuqui-panel")).toBeLessThan(
            zIndex(".o-overlay-item:has(.o-test-popover)")
        );
    });

    test("con un diálogo, el panel sube por encima y se puede tocar", async () => {
        getService("dialog").add(ConfirmationDialog, { body: "¿Seguro?" });
        await animationFrame();
        expect(zIndex(".o-tuqui-panel")).toBeGreaterThan(
            zIndex(".o-overlay-item:has(.o_dialog)")
        );
    });

    test("los popovers siguen por encima del panel aunque haya un diálogo", async () => {
        getService("dialog").add(ConfirmationDialog, { body: "¿Seguro?" });
        await animationFrame();
        getService("popover").add(document.body, TestPopover);
        await animationFrame();
        expect(zIndex(".o-overlay-item:has(.o-test-popover)")).toBeGreaterThan(
            zIndex(".o-tuqui-panel")
        );
    });

    test("al cerrar el diálogo, el panel vuelve abajo", async () => {
        const close = getService("dialog").add(ConfirmationDialog, { body: "¿Seguro?" });
        await animationFrame();
        close();
        await animationFrame();
        getService("popover").add(document.body, TestPopover);
        await animationFrame();
        expect(".o_dialog").toHaveCount(0);
        expect(zIndex(".o-tuqui-panel")).toBeLessThan(
            zIndex(".o-overlay-item:has(.o-test-popover)")
        );
    });
});

describe("el contexto de un diálogo", () => {
    const config = { getDisplayName: () => "Redactar correo electrónico" };

    // El composer de correo es un registro sin guardar: no tiene nombre ni id, y
    // el chip del SPA mostraba "mail.compose.message #false".
    test("un registro sin guardar se nombra con el título del diálogo", async () => {
        await mountViewInDialog({
            type: "form",
            resModel: "res.partner",
            arch: `<form><field name="name"/></form>`,
            config,
        });
        const ctx = getService("tuquiAssistant").getContextPayload();
        expect(ctx.resId).toBe(false);
        expect(ctx.displayName).toBe("Redactar correo electrónico");
    });

    // Validating a delivery opens Odoo's SMS confirmation: the chip read «confirm.stock.sms #4».
    test("un asistente guardado sin nombre propio también se nombra con el título", async () => {
        await mountViewInDialog({
            type: "form",
            resModel: "confirm.stock.sms",
            resId: 4,
            arch: `<form><field name="note"/></form>`,
            config,
        });
        expect(getService("tuquiAssistant").getContextPayload().displayName).toBe("Redactar correo electrónico");
    });

    test("un registro guardado sigue usando su propio nombre", async () => {
        await mountViewInDialog({
            type: "form",
            resModel: "res.partner",
            resId: 1,
            arch: `<form><field name="name"/></form>`,
            config,
        });
        expect(getService("tuquiAssistant").getContextPayload().displayName).toBe("Acme");
    });
});
