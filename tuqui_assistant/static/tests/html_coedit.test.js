/** @odoo-module **/
import { describe, expect, test } from "@odoo/hoot";
import { click, delay, press } from "@odoo/hoot-dom";
import { animationFrame } from "@odoo/hoot-mock";
import {
    defineModels,
    fields,
    getService,
    models,
    mountView,
    patchWithCleanup,
} from "@web/../tests/web_test_helpers";
import { getMountedHtmlField } from "@tuqui_assistant/form/html_field_patch";
import { sameHtml, sanitizeHtml } from "@tuqui_assistant/services/tuqui_assistant_service";

/**
 * Html field co-edit from the assistant, against a real HtmlField.
 *
 * What it checks: the html travels as text (including what was typed without
 * leaving the field), the context says where the person is and what they
 * selected, and an html proposal is cleaned, respects the base it was computed
 * on and is applied through the editor (it lands in its history: Ctrl+Z undoes it).
 *
 * How to run them: see the header of `apply_proposal.test.js`.
 */

class Partner extends models.Model {
    _name = "res.partner";

    name = fields.Char();
    txt = fields.Html();
    tags = fields.Json();

    _records = [
        { id: 1, name: "Acme", txt: "<p>first</p><p>second</p>", tags: ["a", "b"] },
        {
            id: 2,
            name: "Links",
            txt: '<h2>A</h2><p>see <a href="https://odoo.com" target="_blank">odoo</a></p><h2>B</h2><p>b</p>',
        },
        { id: 3, name: "Long", txt: `<p>${"x".repeat(2500)}</p>` },
        { id: 4, name: "Qweb", txt: '<p t-if="x">a</p><p>b</p>' },
        {
            id: 5,
            name: "Video",
            txt:
                '<div class="media_iframe_video" data-oe-expression="https://www.youtube.com/embed/abc">' +
                '<iframe src="https://www.youtube.com/embed/abc"></iframe></div><p>b</p>',
        },
        { id: 6, name: "Logo", txt: '<p><img src="https://cdn.example/logo.png"></p><p>b</p>' },
        { id: 7, name: "Inline logo", txt: '<p>Logo <img src="https://cdn.example/logo.png"> text</p><p>b</p>' },
    ];
}

defineModels([Partner]);

const FORM_ARCH = `
    <form>
        <field name="name"/>
        <field name="tags" invisible="1"/>
        <field name="txt"/>
    </form>`;

// `txt` lives in a page that is not rendered: no editor mounted.
const FORM_ARCH_NO_EDITOR = `
    <form>
        <notebook>
            <page string="Main"><field name="name"/></page>
            <page string="Notes"><field name="txt"/></page>
        </notebook>
    </form>`;

const FORM_ARCH_READONLY_HTML = `
    <form>
        <field name="name"/>
        <field name="txt" readonly="1"/>
    </form>`;

async function mountPartnerForm(arch = FORM_ARCH, resId = 1) {
    await mountView({ type: "form", resModel: "res.partner", resId, arch });
    await animationFrame();
    const assistant = getService("tuquiAssistant");
    return { assistant, record: assistant.getActiveRecord() };
}

/** Warnings the assistant shows, captured from the notification service. */
function captureWarnings() {
    const warnings = [];
    patchWithCleanup(getService("notification"), {
        add(message, options) {
            if (options?.type === "warning") {
                warnings.push(String(message));
            }
            return () => {};
        },
    });
    return warnings;
}

function editorOf(record) {
    return getMountedHtmlField(record, "txt").editor;
}

/** Selects `[from, to)` of the text of the `index`-th paragraph of the editor. */
function selectInParagraph(editor, index, from, to) {
    const text = editor.editable.querySelectorAll("p")[index].firstChild;
    editor.shared.selection.setSelection({
        anchorNode: text,
        anchorOffset: from,
        focusNode: text,
        focusOffset: to,
    });
}

describe("contexto: html como texto, campos html y foco", () => {
    test("el html viaja como string, un json con array como array, y se listan los campos html", async () => {
        const { assistant } = await mountPartnerForm();
        const ctx = assistant.getContextPayload();
        expect(typeof ctx.fields.txt).toBe("string");
        expect(ctx.fields.txt).toBe("<p>first</p><p>second</p>");
        expect(ctx.fields.tags).toEqual(["a", "b"]);
        expect(ctx.htmlFields).toEqual(["txt"]);
        expect(ctx.focus).toBe(undefined);
    });

    test("lo tipeado en el editor viaja sin salir del campo", async () => {
        const { assistant, record } = await mountPartnerForm();
        const editor = editorOf(record);
        await click(".odoo-editor-editable");
        editor.editable.querySelector("p").append(" typed");
        editor.shared.history.commit();
        expect(assistant.getContextPayload().fields.txt).toInclude("first typed");
        // The record still has the old value: the field commits on blur.
        expect(String(record.data.txt)).not.toInclude("typed");
    });

    test("el foco dice el campo, y en un html la selección y el bloque", async () => {
        const { assistant, record } = await mountPartnerForm();
        await click("div[name=name] input");
        expect(assistant.getContextPayload().focus).toEqual({ field: "name", type: "char" });

        await click(".odoo-editor-editable");
        const editor = editorOf(record);
        selectInParagraph(editor, 1, 0, 3);
        expect(assistant.getContextPayload().focus).toEqual({
            field: "txt",
            type: "html",
            selection: { text: "sec", collapsed: false, block: "second" },
        });

        selectInParagraph(editor, 0, 2, 2);
        expect(assistant.getContextPayload().focus.selection).toEqual({
            text: "",
            collapsed: true,
            block: "first",
        });
    });

    test("un campo html de sólo lectura no se lista como editable", async () => {
        const { assistant } = await mountPartnerForm(FORM_ARCH_READONLY_HTML);
        expect(assistant.getContextPayload().htmlFields).toEqual([]);
    });

    test("una selección más larga que el tope se marca cortada", async () => {
        const { assistant, record } = await mountPartnerForm(FORM_ARCH, 3);
        await click(".odoo-editor-editable");
        selectInParagraph(editorOf(record), 0, 0, 2500);
        const selection = assistant.getContextPayload().focus.selection;
        expect(selection.truncated).toBe(true);
        expect(selection.text.length).toBe(2000);
    });

    test("cambiar de campo re-publica el contexto aunque ningún valor cambie", async () => {
        const { assistant } = await mountPartnerForm();
        const before = assistant.state.context.revision;
        await click("div[name=name] input");
        expect(assistant.refreshRecordContext()).toBe(true);
        expect(assistant.state.context.revision).toBe(before + 1);
    });
});

describe("limpieza del html propuesto", () => {
    test("saca handlers, javascript: y tags activos, y deja el resto", () => {
        const dirty =
            '<p onclick="x()">ok <a href=" javascript:alert(1)">link</a></p>' +
            '<img src="x" onerror="window.__pwned=1"><script>window.__pwned=2</script>' +
            '<iframe src="https://example.com"></iframe><object></object><embed>' +
            '<a href="https://odoo.com">safe</a>';
        const clean = sanitizeHtml(dirty);
        expect(clean).not.toInclude("onclick");
        expect(clean).not.toInclude("onerror");
        expect(clean).not.toInclude("javascript:");
        expect(clean).not.toInclude("<script");
        expect(clean).not.toInclude("<iframe");
        expect(clean).not.toInclude("<object");
        expect(clean).not.toInclude("<embed");
        expect(clean).toInclude('<a href="https://odoo.com">safe</a>');
        expect(clean).toInclude('<img src="x">');
    });

    test("conserva lo que conserva Odoo: target y contenteditable", () => {
        const html = '<p><a href="https://odoo.com" target="_blank">x</a></p><div contenteditable="false">y</div>';
        const clean = sanitizeHtml(html);
        expect(clean).toInclude('target="_blank"');
        expect(clean).toInclude('contenteditable="false"');
    });

    test("un html con handler aplicado al editor no ejecuta nada", async () => {
        const { assistant, record } = await mountPartnerForm();
        window.__tuquiPwned = 0;
        await assistant.applyProposal({
            txt: '<p>first</p><img src="x" onerror="window.__tuquiPwned=1">',
        });
        await animationFrame();
        expect(editorOf(record).editable.innerHTML).not.toInclude("onerror");
        expect(window.__tuquiPwned).toBe(0);
    });

    test("sin editor montado, un html con handler no se ejecuta al limpiarlo", async () => {
        const { assistant, record } = await mountPartnerForm(FORM_ARCH_NO_EDITOR);
        expect(getMountedHtmlField(record, "txt")).toBe(null);
        try {
            const result = await assistant.applyProposal({
                txt: '<p>ok</p><img src="data:," onerror="window.__tuquiXss = 1">',
            });
            // Give the browser time to load the image and fire its error.
            await delay(50);
            expect(result.status).toBe("applied");
            expect(window.__tuquiXss).toBe(undefined);
            expect(String(record.data.txt)).toInclude("<p>ok</p>");
            expect(String(record.data.txt)).not.toInclude("onerror");
        } finally {
            delete window.__tuquiXss;
        }
    });

    test("sin editor montado, el chequeo de vacío tampoco ejecuta el handler", async () => {
        const { assistant, record } = await mountPartnerForm(FORM_ARCH_NO_EDITOR);
        const before = String(record.data.txt);
        try {
            // DOMPurify drops `foreignobject` with its content: only the empty check sees the img.
            const result = await assistant.applyProposal({
                txt: '<foreignobject><img src="data:," onerror="window.__tuquiXss = 1"></foreignobject>',
            });
            await delay(50);
            expect(result.skipped).toEqual([{ field: "txt", reason: "sanitized_empty" }]);
            expect(window.__tuquiXss).toBe(undefined);
            expect(String(record.data.txt)).toBe(before);
        } finally {
            delete window.__tuquiXss;
        }
    });
});

describe("aplicar html a través del editor", () => {
    test("queda en el editor y en el record, y Ctrl+Z lo deshace", async () => {
        const { assistant, record } = await mountPartnerForm();
        const editor = editorOf(record);
        const ok = await assistant.applyProposal({ txt: "<p>first</p><p>second</p><p>added</p>" });
        expect(ok.status).toBe("applied");
        expect(editor.editable.querySelectorAll("p").length).toBe(3);
        expect(String(record.data.txt)).toInclude("added");
        expect(record.dirty).toBe(true);

        await click(".odoo-editor-editable");
        await press(["ctrl", "z"]);
        await animationFrame();
        expect(editor.editable.innerHTML).not.toInclude("added");
        expect(editor.editable.querySelectorAll("p").length).toBe(2);
    });

    test("sólo re-crea los bloques que cambian", async () => {
        const { assistant, record } = await mountPartnerForm();
        const editor = editorOf(record);
        const firstBefore = editor.editable.querySelector("p");
        await assistant.applyProposal({ txt: "<p>first</p><p>changed</p>" });
        expect(editor.editable.querySelector("p")).toBe(firstBefore);
        expect(editor.editable.querySelectorAll("p")[1].textContent).toBe("changed");
    });

    test("editar una sección no toca un link con target de otra sección", async () => {
        const { assistant, record } = await mountPartnerForm(FORM_ARCH, 2);
        const editor = editorOf(record);
        const linkParagraph = editor.editable.querySelectorAll("p")[0];
        const base = assistant.getContextPayload().fields.txt;
        const ok = await assistant.applyProposal(
            { txt: base.replace("<p>b</p>", "<p>b edited</p>") },
            { htmlBase: { txt: base } }
        );
        expect(ok.status).toBe("applied");
        expect(editor.editable.querySelectorAll("p")[0]).toBe(linkParagraph);
        expect(String(record.data.txt)).toInclude('target="_blank"');
        expect(String(record.data.txt)).toInclude("b edited");
    });

    test("sin editor montado va por el record, limpio", async () => {
        const { assistant, record } = await mountPartnerForm(FORM_ARCH_NO_EDITOR);
        expect(getMountedHtmlField(record, "txt")).toBe(null);
        const ok = await assistant.applyProposal({
            txt: '<p>new</p><img src="x" onerror="window.__tuquiPwned=1">',
        });
        expect(ok.status).toBe("applied");
        expect(String(record.data.txt)).toBe('<p>new</p><img src="x">');
    });

    test("si el campo cambió desde la base de la propuesta, no aplica", async () => {
        const { assistant, record } = await mountPartnerForm();
        const editor = editorOf(record);
        const warnings = captureWarnings();
        const ok = await assistant.applyProposal(
            { txt: "<p>from an old base</p>" },
            { htmlBase: { txt: "<p>old</p>" } }
        );
        expect(ok.status).toBe("rejected");
        expect(editor.editable.innerHTML).not.toInclude("old base");
        expect(warnings.length).toBe(1);

        const base = assistant.getContextPayload().fields.txt;
        const applied = await assistant.applyProposal(
            { txt: base + "<p>on the current base</p>" },
            { htmlBase: { txt: base } }
        );
        expect(applied.status).toBe("applied");
        expect(editor.editable.innerHTML).toInclude("on the current base");
    });

    test("una segunda edición en el mismo turno trae de base la primera propuesta, aunque el editor la haya normalizado", async () => {
        const { assistant, record } = await mountPartnerForm();
        const editor = editorOf(record);
        const base = assistant.getContextPayload().fields.txt;
        // A loose top-level text and a handler: both change on the way in.
        const first = base + 'loose text<p onclick="x()">clicked</p>';
        expect((await assistant.applyProposal({ txt: first }, { htmlBase: { txt: base } })).status).toBe("applied");
        expect(String(record.data.txt)).not.toBe(first);

        const second = first + "<p>second edit</p>";
        expect((await assistant.applyProposal({ txt: second }, { htmlBase: { txt: first } })).status).toBe("applied");
        expect(editor.editable.innerHTML).toInclude("second edit");

        // Once the person types, that base is no longer the field.
        await click(".odoo-editor-editable");
        editor.editable.querySelector("p").append(" typed");
        editor.shared.history.commit();
        const third = second + "<p>third edit</p>";
        expect((await assistant.applyProposal({ txt: third }, { htmlBase: { txt: second } })).status).toBe("rejected");
        expect(editor.editable.innerHTML).not.toInclude("third edit");
    });

    test("la base se compara contra lo tipeado sin salir del campo", async () => {
        const { assistant, record } = await mountPartnerForm();
        const editor = editorOf(record);
        const base = assistant.getContextPayload().fields.txt;
        await click(".odoo-editor-editable");
        editor.editable.querySelector("p").append(" typed");
        editor.shared.history.commit();
        const ok = await assistant.applyProposal(
            { txt: base + "<p>added</p>" },
            { htmlBase: { txt: base } }
        );
        expect(ok.status).toBe("rejected");
        expect(editor.editable.innerHTML).toInclude("typed");
        expect(editor.editable.innerHTML).not.toInclude("added");
    });
});

describe("reemplazar la selección", () => {
    test("reemplaza sólo lo seleccionado, y Ctrl+Z lo deshace", async () => {
        const { assistant, record } = await mountPartnerForm();
        const editor = editorOf(record);
        await click(".odoo-editor-editable");
        selectInParagraph(editor, 1, 0, 6);
        const ok = await assistant.applyProposal(
            {},
            { selection: { field: "txt", html: "<strong>SECOND</strong>", expectedText: "second" } }
        );
        expect(ok.status).toBe("applied");
        const paragraphs = editor.editable.querySelectorAll("p");
        expect(paragraphs[0].textContent).toBe("first");
        expect(paragraphs[1].innerHTML).toBe("<strong>SECOND</strong>");
        expect(String(record.data.txt)).toInclude("SECOND");

        await press(["ctrl", "z"]);
        await animationFrame();
        expect(editor.editable.querySelectorAll("p")[1].textContent).toBe("second");
    });

    test("si lo seleccionado ya no es lo que vio el modelo, no aplica", async () => {
        const { assistant, record } = await mountPartnerForm();
        const editor = editorOf(record);
        await click(".odoo-editor-editable");
        selectInParagraph(editor, 1, 0, 3);
        const warnings = captureWarnings();
        const ok = await assistant.applyProposal(
            {},
            { selection: { field: "txt", html: "<p>X</p>", expectedText: "second" } }
        );
        expect(ok.status).toBe("rejected");
        expect(editor.editable.querySelectorAll("p")[1].textContent).toBe("second");
        expect(warnings.length).toBe(1);
    });

    test("si la selección supera el tope, no aplica aunque el texto coincida con lo que vio el modelo", async () => {
        const { assistant, record } = await mountPartnerForm(FORM_ARCH, 3);
        const editor = editorOf(record);
        await click(".odoo-editor-editable");
        selectInParagraph(editor, 0, 0, 2500);
        const seen = assistant.getContextPayload().focus.selection.text;
        const warnings = captureWarnings();
        const ok = await assistant.applyProposal(
            {},
            { selection: { field: "txt", html: "<p>short</p>", expectedText: seen } }
        );
        expect(ok.status).toBe("rejected");
        expect(warnings.length).toBe(1);
        expect(editor.editable.textContent.length).toBe(2500);
    });

    test("con el cursor sin seleccionar nada, no aplica", async () => {
        const { assistant, record } = await mountPartnerForm();
        const editor = editorOf(record);
        await click(".odoo-editor-editable");
        selectInParagraph(editor, 1, 2, 2);
        const ok = await assistant.applyProposal(
            {},
            { selection: { field: "txt", html: "<p>X</p>", expectedText: "" } }
        );
        expect(ok.status).toBe("rejected");
        expect(editor.editable.innerHTML).not.toInclude("X");
    });
});

describe("la limpieza no toca lo que la edición no cambió", () => {
    for (const [label, arch] of [
        ["con editor", FORM_ARCH],
        ["sin editor", FORM_ARCH_NO_EDITOR],
    ]) {
        test(`un t-if de otro bloque sobrevive (${label})`, async () => {
            const { assistant, record } = await mountPartnerForm(arch, 4);
            const base = assistant.getContextPayload().fields.txt;
            expect(base).toInclude('t-if="x"');
            const ok = await assistant.applyProposal(
                { txt: base.replace(">b<", ">b edited<") },
                { htmlBase: { txt: base } }
            );
            expect(ok.status).toBe("applied");
            expect(String(record.data.txt)).toInclude('t-if="x"');
            expect(String(record.data.txt)).toInclude("b edited");
        });
    }

    test("un iframe de video de otro bloque sobrevive (con editor)", async () => {
        const { assistant, record } = await mountPartnerForm(FORM_ARCH, 5);
        const base = assistant.getContextPayload().fields.txt;
        const ok = await assistant.applyProposal(
            { txt: base.replace(">b<", ">b edited<") },
            { htmlBase: { txt: base } }
        );
        expect(ok.status).toBe("applied");
        expect(String(record.data.txt)).toInclude("<iframe");
        expect(String(record.data.txt)).toInclude("b edited");
    });

    test("un script nuevo en el bloque editado igual se limpia", async () => {
        const { assistant, record } = await mountPartnerForm(FORM_ARCH, 4);
        const base = assistant.getContextPayload().fields.txt;
        await assistant.applyProposal({
            txt: base.replace("<p>b</p>", '<p>b<img src="x" onerror="window.__tuquiPwned=1"></p><script>1</script>'),
        });
        expect(String(record.data.txt)).not.toInclude("onerror");
        expect(String(record.data.txt)).not.toInclude("<script");
        expect(String(record.data.txt)).toInclude('t-if="x"');
    });

    test("sameHtml no da igual cuando la diferencia es justo lo que la limpieza saca", () => {
        expect(sameHtml("<p>a</p><script>1</script>", "<p>a</p>")).toBe(false);
        expect(sameHtml("<p>a</p>", "<p>a</p>")).toBe(true);
        expect(sameHtml("<p>a</p>\n<p>b</p>", "<p>a</p><p>b</p>")).toBe(true);
    });

    for (const [label, arch] of [
        ["con editor", FORM_ARCH],
        ["sin editor", FORM_ARCH_NO_EDITOR],
    ]) {
        test(`una propuesta que la limpieza deja vacía no vacía el campo (${label})`, async () => {
            const { assistant, record } = await mountPartnerForm(arch);
            const warnings = captureWarnings();
            const ok = await assistant.applyProposal({ txt: "<script>window.__tuquiPwned=1</script>" });
            expect(ok.status).toBe("rejected");
            expect(warnings.length).toBe(1);
            expect(String(record.data.txt)).toInclude("first");
        });
    }

    test("si falla la selección, no se aplica el resto del mismo payload", async () => {
        const { assistant, record } = await mountPartnerForm();
        await click(".odoo-editor-editable");
        selectInParagraph(editorOf(record), 1, 0, 3);
        const warnings = captureWarnings();
        const ok = await assistant.applyProposal(
            { name: "Changed" },
            { selection: { field: "txt", html: "<p>X</p>", expectedText: "other" } }
        );
        expect(ok.status).toBe("rejected");
        expect(warnings.length).toBe(1);
        expect(record.data.name).toBe("Acme");
    });
});

describe("apply-result de la coedición", () => {
    test("aplicado por el editor: applied con el campo", async () => {
        const { assistant } = await mountPartnerForm();
        const base = assistant.getContextPayload().fields.txt;
        const result = await assistant.applyProposal(
            { txt: base + "<p>added</p>" },
            { htmlBase: { txt: base } }
        );
        expect(result.status).toBe("applied");
        expect(result.applied).toEqual(["txt"]);
        expect(result.skipped).toEqual([]);
    });

    test("aplicado sin editor: applied con el campo", async () => {
        const { assistant } = await mountPartnerForm(FORM_ARCH_NO_EDITOR);
        const result = await assistant.applyProposal({ txt: "<p>new</p>" });
        expect(result.status).toBe("applied");
        expect(result.applied).toEqual(["txt"]);
    });

    test("htmlBase vieja: skip changed_by_user, y rejected si no entró nada", async () => {
        const { assistant } = await mountPartnerForm();
        const result = await assistant.applyProposal(
            { txt: "<p>x</p>" },
            { htmlBase: { txt: "<p>old</p>" } }
        );
        expect(result.status).toBe("rejected");
        expect(result.applied).toEqual([]);
        expect(result.skipped).toEqual([{ field: "txt", reason: "changed_by_user" }]);
        expect(result.message).toInclude("changed");
    });

    test("htmlBase vieja con otro campo que sí entra: partial", async () => {
        const { assistant, record } = await mountPartnerForm();
        const result = await assistant.applyProposal(
            { name: "Acme SA", txt: "<p>x</p>" },
            { htmlBase: { txt: "<p>old</p>" } }
        );
        expect(result.status).toBe("partial");
        expect(result.applied).toEqual(["name"]);
        expect(result.skipped).toEqual([{ field: "txt", reason: "changed_by_user" }]);
        expect(record.data.name).toBe("Acme SA");
    });

    test("la limpieza deja vacía la propuesta: skip sanitized_empty", async () => {
        const { assistant } = await mountPartnerForm();
        const result = await assistant.applyProposal({ txt: "<script>1</script>" });
        expect(result.status).toBe("rejected");
        expect(result.skipped).toEqual([{ field: "txt", reason: "sanitized_empty" }]);
    });

    test("la selección ya no coincide: rejected selection_changed", async () => {
        const { assistant, record } = await mountPartnerForm();
        await click(".odoo-editor-editable");
        selectInParagraph(editorOf(record), 1, 0, 3);
        const result = await assistant.applyProposal(
            { name: "Changed" },
            { selection: { field: "txt", html: "<p>X</p>", expectedText: "second" } }
        );
        expect(result.status).toBe("rejected");
        expect(result.reason).toBe("selection_changed");
        expect(result.applied).toEqual([]);
        expect(record.data.name).toBe("Acme");
    });

    test("la selección supera el tope: rejected selection_too_long", async () => {
        const { assistant, record } = await mountPartnerForm(FORM_ARCH, 3);
        await click(".odoo-editor-editable");
        selectInParagraph(editorOf(record), 0, 0, 2500);
        const seen = assistant.getContextPayload().focus.selection.text;
        const result = await assistant.applyProposal(
            {},
            { selection: { field: "txt", html: "<p>short</p>", expectedText: seen } }
        );
        expect(result.status).toBe("rejected");
        expect(result.reason).toBe("selection_too_long");
    });

    test("selección sobre un campo sin editor: rejected sin reason, con el campo en skipped", async () => {
        const { assistant } = await mountPartnerForm(FORM_ARCH_NO_EDITOR);
        const result = await assistant.applyProposal(
            {},
            { selection: { field: "txt", html: "<p>X</p>", expectedText: "first" } }
        );
        expect(result.status).toBe("rejected");
        expect(result.reason).toBe(undefined);
        expect(result.skipped).toEqual([{ field: "txt", reason: "not_in_form" }]);
    });

    test("selección que la limpieza deja vacía: rejected sin reason, sanitized_empty en skipped", async () => {
        const { assistant, record } = await mountPartnerForm();
        await click(".odoo-editor-editable");
        selectInParagraph(editorOf(record), 1, 0, 6);
        const result = await assistant.applyProposal(
            {},
            { selection: { field: "txt", html: "<script>1</script>", expectedText: "second" } }
        );
        expect(result.status).toBe("rejected");
        expect(result.reason).toBe(undefined);
        expect(result.skipped).toEqual([{ field: "txt", reason: "sanitized_empty" }]);
        expect(editorOf(record).editable.querySelectorAll("p")[1].textContent).toBe("second");
    });

    test("selección aplicada: applied con el campo, y suma lo del resto del payload", async () => {
        const { assistant, record } = await mountPartnerForm();
        await click(".odoo-editor-editable");
        selectInParagraph(editorOf(record), 1, 0, 6);
        const result = await assistant.applyProposal(
            { name: "Acme SA" },
            { selection: { field: "txt", html: "<b>SECOND</b>", expectedText: "second" } }
        );
        expect(result.status).toBe("applied");
        expect(result.applied).toEqual(["txt", "name"]);
    });

    test("selección para otro registro: rejected other_record, sin tocar la selección", async () => {
        const { assistant, record } = await mountPartnerForm();
        await click(".odoo-editor-editable");
        selectInParagraph(editorOf(record), 1, 0, 6);
        const result = await assistant.applyProposal(
            {},
            {
                selection: { field: "txt", html: "<b>SECOND</b>", expectedText: "second" },
                target: { model: "res.partner", resId: 2 },
            }
        );
        expect(result.status).toBe("rejected");
        expect(result.reason).toBe("other_record");
        expect(editorOf(record).editable.innerHTML).not.toInclude("SECOND");
    });
});

describe("una propuesta sólo carga recursos del mismo origen", () => {
    const EVIL = "evil.example";
    const PNG = "data:image/png;base64,iVBORw0KGgo=";

    /** Nothing in the page points to EVIL, and the browser did not request it. */
    async function expectNothingLoadedFromEvil() {
        await delay(50);
        expect(document.querySelector(`[src*="${EVIL}"], [srcset*="${EVIL}"], [style*="${EVIL}"]`)).toBe(null);
        const requested = performance.getEntriesByType("resource").map((entry) => entry.name);
        expect(requested.some((name) => name.includes(EVIL))).toBe(false);
    }

    for (const [label, arch] of [
        ["con editor", FORM_ARCH],
        ["sin editor", FORM_ARCH_NO_EDITOR],
    ]) {
        test(`una img de otro origen no entra, y un link externo sí (${label})`, async () => {
            const { assistant, record } = await mountPartnerForm(arch);
            const ok = await assistant.applyProposal({
                txt:
                    `<p>first</p><p>second</p><p>x<img src="https://${EVIL}/x.png?leak=1"></p>` +
                    `<p><a href="https://${EVIL}/page">link</a></p>`,
            });
            expect(ok.status).toBe("applied");
            const value = String(record.data.txt);
            expect(value).not.toInclude("<img");
            expect(value).toInclude(`href="https://${EVIL}/page"`);
            await expectNothingLoadedFromEvil();
        });

        test(`una img del mismo Odoo o data:image queda (${label})`, async () => {
            const { assistant, record } = await mountPartnerForm(arch);
            const sameOrigin = `${window.location.origin}/web/image/2`;
            const ok = await assistant.applyProposal({
                txt:
                    '<p>first</p><p>second</p><p>a<img src="/web/image/1"></p>' +
                    `<p>b<img src="${PNG}"></p><p>c<img src="${sameOrigin}"></p>`,
            });
            expect(ok.status).toBe("applied");
            const value = String(record.data.txt);
            expect(value).toInclude('src="/web/image/1"');
            expect(value).toInclude(`src="${PNG}"`);
            expect(value).toInclude(`src="${sameOrigin}"`);
        });

        test(`un url() de otro origen en style se va, y el resto del style queda (${label})`, async () => {
            const { assistant, record } = await mountPartnerForm(arch);
            const ok = await assistant.applyProposal({
                txt: `<p>first</p><p>second</p><p style="background:url(https://${EVIL}/bg.png);color:red">s</p>`,
            });
            expect(ok.status).toBe("applied");
            const value = String(record.data.txt);
            expect(value).not.toInclude(EVIL);
            expect(value).toInclude("color: red");
            await expectNothingLoadedFromEvil();
        });

        test(`una img de otro origen que ya estaba y no cambió no se toca (${label})`, async () => {
            const { assistant, record } = await mountPartnerForm(arch, 6);
            const base = assistant.getContextPayload().fields.txt;
            const ok = await assistant.applyProposal(
                { txt: base.replace("<p>b</p>", `<p>b<img src="https://${EVIL}/x.png"></p>`) },
                { htmlBase: { txt: base } }
            );
            expect(ok.status).toBe("applied");
            const value = String(record.data.txt);
            expect(value).toInclude('src="https://cdn.example/logo.png"');
            expect(value).not.toInclude(EVIL);
            // Only the new one counts.
            expect(ok.message).toInclude("Removed 1 image(s)");
        });

        test(`lo quitado se avisa y no deja un párrafo vacío (${label})`, async () => {
            const { assistant, record } = await mountPartnerForm(arch);
            const warnings = captureWarnings();
            const ok = await assistant.applyProposal({
                txt: `<p><img src="https://${EVIL}/x.png"></p><p>ok</p>`,
            });
            expect(ok.status).toBe("applied");
            expect(ok.message).toInclude("Removed 1 image(s)");
            expect(warnings.some((text) => text.includes("another site"))).toBe(true);
            const value = String(record.data.txt);
            expect(value).toInclude("ok");
            expect(value).not.toInclude("<img");
            expect(value).not.toMatch(/<p>\s*<\/p>/);
        });

        test(`un <style> no entra, ni con @import ni con reglas (${label})`, async () => {
            const { assistant, record } = await mountPartnerForm(arch);
            const ok = await assistant.applyProposal({
                txt:
                    `<p>first</p><p>second</p><style>@import url("https://${EVIL}/s.css");</style>` +
                    `<style>.zz{background:url(https://${EVIL}/bg.png)}</style><p class="zz">x</p>`,
            });
            expect(ok.status).toBe("applied");
            const value = String(record.data.txt);
            expect(value).not.toInclude("<style");
            expect(value).not.toInclude(EVIL);
            expect(value).toInclude("x</p>");
            await expectNothingLoadedFromEvil();
        });

        test(`un url() de otro origen en un atributo SVG se va (${label})`, async () => {
            const { assistant, record } = await mountPartnerForm(arch);
            const ok = await assistant.applyProposal({
                txt:
                    '<p>first</p><p>second</p><svg width="10" height="10">' +
                    `<rect width="10" height="10" fill="url(https://${EVIL}/g.svg#g)" stroke="red"/>` +
                    `<path d="M0 0L10 10" mask="url(https://${EVIL}/m.svg#m)"` +
                    ` marker-start="url(https://${EVIL}/k.svg#k)"/>` +
                    "</svg>",
            });
            expect(ok.status).toBe("applied");
            expect(String(record.data.txt)).not.toInclude(EVIL);
            expect(document.querySelector(`[fill*="${EVIL}"], [mask*="${EVIL}"], [marker-start*="${EVIL}"]`)).toBe(
                null
            );
            await expectNothingLoadedFromEvil();
        });

        test(`una variable CSS con una URL no llega a un image-set (${label})`, async () => {
            const { assistant, record } = await mountPartnerForm(arch);
            const ok = await assistant.applyProposal({
                txt:
                    `<p>first</p><p>second</p><p style="--x:'https://${EVIL}/a.png'">` +
                    '<span style="background-image:image-set(var(--x) 1x)">a</span></p>' +
                    `<p style="--u:https://${EVIL}/b.png;color:red">` +
                    '<span style="background-image:image-set(var(--u) 1x)">b</span></p>',
            });
            expect(ok.status).toBe("applied");
            const value = String(record.data.txt);
            expect(value).not.toInclude(EVIL);
            expect(value).not.toInclude("image-set");
            expect(value).toInclude("color: red");
            await expectNothingLoadedFromEvil();
        });

        test(`una img externa que ya estaba en el bloque que cambia queda y no se cuenta (${label})`, async () => {
            const { assistant, record } = await mountPartnerForm(arch, 7);
            const base = assistant.getContextPayload().fields.txt;
            const ok = await assistant.applyProposal(
                { txt: base.replace("text</p>", "text2</p>") },
                { htmlBase: { txt: base } }
            );
            expect(ok.status).toBe("applied");
            const value = String(record.data.txt);
            expect(value).toInclude('src="https://cdn.example/logo.png"');
            expect(value).toInclude("text2");
            expect(ok.message).not.toInclude("another site");
        });

        test(`una propuesta que el filtro deja vacía dice por qué (${label})`, async () => {
            const { assistant, record } = await mountPartnerForm(arch);
            const ok = await assistant.applyProposal({ txt: `<p><img src="https://${EVIL}/x.png"></p>` });
            expect(ok.status).toBe("rejected");
            expect(ok.skipped).toEqual([{ field: "txt", reason: "sanitized_empty" }]);
            expect(ok.message).toInclude("another site");
            expect(String(record.data.txt)).toInclude("first");
            await expectNothingLoadedFromEvil();
        });

        test(`sin nada de otro origen no hay aviso (${label})`, async () => {
            const { assistant } = await mountPartnerForm(arch);
            const ok = await assistant.applyProposal({
                txt: '<p><img src="/web/image/1"></p><p>ok</p>',
            });
            expect(ok.status).toBe("applied");
            expect(ok.message).not.toInclude("another site");
        });
    }

    test("tampoco entra al reemplazar la selección", async () => {
        const { assistant, record } = await mountPartnerForm();
        await click(".odoo-editor-editable");
        selectInParagraph(editorOf(record), 1, 0, 6);
        const ok = await assistant.applyProposal(
            {},
            {
                selection: {
                    field: "txt",
                    html: `<b>SECOND</b><img src="https://${EVIL}/x.png"><img src="/web/image/1">`,
                    expectedText: "second",
                },
            }
        );
        expect(ok.status).toBe("applied");
        const value = String(record.data.txt);
        expect(value).toInclude("SECOND");
        expect(value).toInclude('src="/web/image/1"');
        expect(value).not.toInclude(EVIL);
        expect(ok.message).toInclude("Removed 1 image(s)");
        await expectNothingLoadedFromEvil();
    });

    test("tampoco entra al cuerpo que se propone para el chatter", async () => {
        const { assistant } = await mountPartnerForm();
        let body = null;
        patchWithCleanup(getService("action"), {
            doAction: async (action) => {
                body = action.context.default_body;
            },
        });
        const result = await assistant.proposeChatter({
            body:
                `<p style="background:url(https://${EVIL}/bg.png)">hola</p>` +
                `<img src="https://${EVIL}/x.png"><img src="/web/image/1">`,
            target: { model: "res.partner", resId: 1 },
        });
        expect(result.status).toBe("opened");
        expect(body).toInclude("hola");
        expect(body).toInclude('src="/web/image/1"');
        expect(body).not.toInclude(EVIL);
        // The style url() and the img.
        expect(result.message).toInclude("Removed 2 image(s)");
    });

    test("el cuerpo del chatter sin nada de otro origen no trae aviso", async () => {
        const { assistant } = await mountPartnerForm();
        patchWithCleanup(getService("action"), { doAction: async () => {} });
        const result = await assistant.proposeChatter({
            body: '<p>hola<img src="/web/image/1"></p>',
            target: { model: "res.partner", resId: 1 },
        });
        expect(result.status).toBe("opened");
        expect(result.message).not.toInclude("another site");
    });

    test("srcset, poster y SVG también se filtran; el mismo origen queda", () => {
        const clean = sanitizeHtml(
            `<picture><source srcset="https://${EVIL}/a.png 1x, /web/image/1 2x">` +
                '<img src="/web/image/1" srcset="/web/image/1 1x, /web/image/2 2x"></picture>' +
                `<video poster="https://${EVIL}/p.png" src="/web/content/3"></video>` +
                `<svg><image href="https://${EVIL}/i.png"></image></svg>`
        );
        expect(clean).not.toInclude(EVIL);
        expect(clean).toInclude('srcset="/web/image/1 1x, /web/image/2 2x"');
        expect(clean).toInclude('src="/web/content/3"');
    });

    test("en SVG se van el <style> y todo atributo con un url() de otro origen", () => {
        const clean = sanitizeHtml(
            `<svg><style>rect{fill:url(https://${EVIL}/s.svg#a)}</style>` +
                `<rect fill="url(https://${EVIL}/g.svg#g)" stroke="red" filter="url(#local)"/>` +
                `<path clip-path="url(https://${EVIL}/c.svg#c)" marker-end="url(https://${EVIL}/k.svg#k)"/></svg>`
        );
        expect(clean).not.toInclude(EVIL);
        expect(clean).not.toInclude("<style");
        expect(clean).toInclude('stroke="red"');
        expect(clean).toInclude('filter="url(#local)"');
    });
});
