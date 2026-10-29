/** @odoo-module **/
import { beforeEach, describe, expect, test } from "@odoo/hoot";
import { defineModels, fields, getService, models, mountView } from "@web/../tests/web_test_helpers";
import { contextKey } from "@tuqui_assistant/panel/panel";

/**
 * `setViewContext` with a selection: what reaches the SPA when the user ticks rows in a list.
 *
 * El contrato: la selección viaja ENTERA, sin tope. Tuqui no la imprime en el
 * prompt cuando es larga y la entrega con `odoo_get_selected_ids`, así que un
 * corte acá solo convertiría una selección completa en una parcial.
 *
 * `count` es la selección REAL, y tiene que coincidir con los ids que viajan.
 *
 * Cómo correrlos: ver el encabezado de `apply_proposal.test.js`.
 */

// `setViewContext` gets the view's payload as an ARGUMENT (WithSearch and the
// list build it), so these tests mount a small form only to have the service and
// pass payloads by hand. The real list is mounted in `list_context.test.js`.
class Partner extends models.Model {
    _name = "res.partner";

    name = fields.Char();

    _records = [{ id: 1, name: "Acme" }];
}

defineModels([Partner]);

const FORM_ARCH = `<form><field name="name"/></form>`;

/** Publica una selección de `n` filas y devuelve el contexto que quedó. */
async function contextForSelectionOf(assistant, n) {
    assistant.setViewContext(
        {},
        {
            model: "res.partner",
            modelLabel: "Contactos",
            resIds: Array.from({ length: n }, (_, i) => i + 1),
            isDomainSelected: false,
            count: n,
            domain: [],
            filters: [],
        }
    );
    return assistant.state.context;
}

describe("setViewContext — selection", () => {
    let assistant;
    beforeEach(async () => {
        await mountView({ type: "form", resModel: "res.partner", resId: 1, arch: FORM_ARCH });
        assistant = getService("tuquiAssistant");
    });

    test("una selección chica viaja entera", async () => {
        const ctx = await contextForSelectionOf(assistant, 80);
        expect(ctx.kind).toBe("selection");
        expect(ctx.resIds.length).toBe(80);
        expect(ctx.count).toBe(80);
        expect(!!ctx.truncated).toBe(false);
    });

    test("una selección grande también viaja entera: nunca se corta", async () => {
        // Antes se cortaba en 200 y Tuqui la daba por parcial: el modelo se
        // negaba a actuar sobre una selección que el usuario sí había hecho.
        for (const n of [200, 201, 2500]) {
            const ctx = await contextForSelectionOf(assistant, n);
            expect(!!ctx.truncated).toBe(false);
            expect(ctx.count).toBe(n);
            expect(ctx.resIds.length).toBe(n);
            expect(ctx.resIds.at(-1)).toBe(n);
        }
    });

    test("'seleccionar todos los que matchean' manda el dominio, no ids", async () => {
        assistant.setViewContext(
            {},
            {
                model: "res.partner",
                modelLabel: "Contactos",
                resIds: [],
                isDomainSelected: true,
                count: 260,
                domain: [["name", "ilike", "Contacto"]],
                filters: [],
            }
        );
        const ctx = assistant.state.context;
        expect(ctx.allMatching).toBe(true);
        expect(ctx.resIds).toEqual([]);
        // El dominio ES la selección acá: sin él el assistant sabe que son
        // "todos los del filtro" pero no puede reproducir el conjunto.
        expect(ctx.domain).toEqual([["name", "ilike", "Contacto"]]);
        expect(!!ctx.truncated).toBe(false);
    });
});

describe("la selección se re-publica cuando cambia QUÉ está tildado", () => {
    // El efecto que publica el contexto se re-dispara mirando una lista de
    // dependencias. Con `selection.length` ahí, destildar una fila y tildar otra
    // dejaba el largo igual → no se re-publicaba → el assistant seguía viendo la
    // que sacaste. Con el cap en 50 eso moría en una negativa (llegaba cortada);
    // con la selección entera, el prompt manda trabajar inline y el desfasaje
    // termina en una escritura sobre el registro equivocado, en silencio.

    test("la clave de deduplicación del panel también mira los ids", () => {
        // If the panel deduplicated by count, the list would publish again and the
        // panel would still drop it. The list side is in `list_context.test.js`.
        const key = (resIds) => contextKey({ kind: "selection", model: "res.partner", count: 3, resIds });
        expect(key([1, 2, 3])).not.toBe(key([1, 2, 4]));
    });
});
