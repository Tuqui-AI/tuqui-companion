/** @odoo-module **/
import { patch } from "@web/core/utils/patch";
import { HtmlField } from "@html_editor/fields/html_field";
import { onWillDestroy, toRaw } from "@odoo/owl";

/**
 * Mounted html editors, per record and field name. The assistant service reads
 * the live content and the saved selection from here, and applies proposals
 * through the editor so they land in its undo history. Keyed by the raw record:
 * the form controller and the field see different reactive proxies of it.
 */
const htmlFieldsByRecord = new WeakMap();

function registerHtmlField(field) {
    const record = toRaw(field.props.record);
    const name = field.props.name;
    let byName = htmlFieldsByRecord.get(record);
    if (!byName) {
        byName = new Map();
        htmlFieldsByRecord.set(record, byName);
    }
    byName.set(name, field);
}

function unregisterHtmlField(field) {
    const byName = htmlFieldsByRecord.get(toRaw(field.props.record));
    const name = field.props.name;
    if (byName?.get(name) === field) {
        byName.delete(name);
    }
}

/**
 * The HtmlField component of `record[name]` with a usable editor, or null
 * (readonly field, code view, editor not loaded yet or already destroyed).
 */
export function getMountedHtmlField(record, name) {
    const raw = record && toRaw(record);
    const field = raw && htmlFieldsByRecord.get(raw)?.get(name);
    if (!field || toRaw(field.props.record) !== raw || field.props.name !== name) {
        return null;
    }
    const editor = field.editor;
    if (!editor || editor.isDestroyed || !editor.editable?.isConnected) {
        return null;
    }
    if (field.props.readonly || field.state?.showCodeView) {
        return null;
    }
    return field;
}

patch(HtmlField.prototype, {
    setup() {
        super.setup(...arguments);
        onWillDestroy(() => unregisterHtmlField(this));
    },
    onEditorLoad(editor) {
        super.onEditorLoad(...arguments);
        registerHtmlField(this);
    },
});
