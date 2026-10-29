/** @odoo-module **/
import { registry } from "@web/core/registry";
import { markup, proxy } from "@odoo/owl";
import { loadBundle } from "@web/core/assets";
import { cookie } from "@web/core/browser/cookie";
import { _t } from "@web/core/l10n/translation";
import {
    deserializeDate,
    deserializeDateTime,
    serializeDate,
    serializeDateTime,
} from "@web/core/l10n/dates";
import { evaluateBooleanExpr } from "@web/core/py_js/py";
import { makeContext } from "@web/core/context";
import { user } from "@web/core/user";
import { delay } from "@web/core/utils/concurrency";
import { closestBlock } from "@html_editor/utils/blocks";
import { getMountedHtmlField } from "@tuqui_assistant/form/html_field_patch";
import {
    APP_MENUS,
    elementFor,
    findByName,
    isBehindDialog,
    isOnScreen,
    readTargets,
    recordName,
    rememberTargets,
    SCREEN_ACTIONS,
} from "@tuqui_assistant/screen/screen_targets";
import { hideGota, showGota } from "@tuqui_assistant/screen/gota";
import { browseContext } from "@tuqui_assistant/search/view_context";
import { menuOf, tuquiMayClick } from "@tuqui_assistant/show_me/menu_walk";

// On the dialog the chat itself opened (the chatter composer): it leaves the page
// with the dialog, so nothing has to take it off.
export const CHAT_DIALOG = "o-tuqui-chat-dialog";

/** Mark the newest dialog as the chat's: on a phone it goes over the panel (panel.scss). */
function markChatDialog() {
    const dialogs = document.querySelectorAll(".o-overlay-item .o_dialog");
    dialogs[dialogs.length - 1]?.classList.add(CHAT_DIALOG);
}

// Luxon es un global en Odoo, no un import ESM — igual que en
// web/static/src/core/l10n/dates.js.
const { DateTime } = luxon;

// Guard de tamaño para ids de campos x2many enviados como contexto al SPA.
const MAX_X2MANY_IDS = 50;

// Size caps for the focus context: selected text and the block around the caret.
const MAX_SELECTION_TEXT = 2000;
const MAX_SELECTION_BLOCK = 500;

/**
 * Estado compartido + puente (bridge) entre el panel del asistente y lo que el
 * usuario está mirando en Odoo.
 *
 * Contexto etiquetado (`state.context.kind`):
 *   - null         → sin contexto (dashboard, settings…): chat general.
 *   - "record"     → form abierto, 1 registro. Habilita propose-then-apply.
 *   - "selection"  → a list with N records ticked (read-only).
 *   - "view"       → any other view with a search (list, kanban, pivot, graph,
 *                    calendar…): domain, filters, grouping and what the view
 *                    itself shows (read-only).
 *
 * Apply in-memory (`record._update`) **solo** existe para "record" (el único con
 * un record de form en memoria). Escribir sobre varios es un bulk write por el
 * gateway del companion (gateado por chat-permission-system) — vía distinta, no
 * se mezcla acá. Ver docs/embed-protocol.md.
 */

/**
 * Serializa los valores en memoria de un record OWL a un objeto JSON-safe para
 * mandar como contexto al SPA. NO se puede `JSON.stringify(record.data)` directo:
 * los x2many son StaticList que referencian de vuelta al controller → ciclo →
 * `JSON.stringify` TIRA "Converting circular structure to JSON" y el catch de
 * abajo dejaba `fields={}` (se perdían TODOS los campos, hasta los escalares).
 * Serializamos por tipo, cada campo en su propio try (un campo no serializable
 * no tira abajo el resto):
 *   - many2one / many2one_reference → { id, display_name } | false
 *   - one2many / many2many → { count, ids } (guard de tamaño: ids capeados, sin filas)
 *   - date → ISO "YYYY-MM-DD"; datetime → ISO; binary → "<binary>"
 *   - html → string; with a mounted editor, its live content (see liveHtmlValue)
 *   - Markup/String → string; array → array
 *   - resto (char/text/int/float/bool/selection/…) → tal cual
 */
function serializeRecordFields(record) {
    const fields = record.fields || {};
    const data = record.data || {};
    const out = {};
    for (const name of Object.keys(data)) {
        // Skip Studio-generated display-only HTML banner fields (x_dynamic_message*):
        // readonly messages with no value for the AI context.
        if (name.startsWith("x_dynamic_message")) {
            continue;
        }
        const type = fields[name]?.type;
        const val = data[name];
        try {
            if (val === false || val === null || val === undefined) {
                out[name] = val ?? false;
            } else if (type === "many2one" || type === "many2one_reference") {
                out[name] =
                    val.id !== undefined
                        ? { id: val.id, display_name: val.display_name ?? null }
                        : false;
            } else if (type === "one2many" || type === "many2many") {
                const ids = (val.currentIds || []).filter((x) => typeof x === "number");
                out[name] = { count: val.count ?? ids.length, ids: ids.slice(0, MAX_X2MANY_IDS) };
            } else if (type === "date") {
                out[name] = typeof val.toISODate === "function" ? val.toISODate() : String(val);
            } else if (type === "datetime") {
                out[name] = typeof val.toISO === "function" ? val.toISO() : String(val);
            } else if (type === "binary") {
                out[name] = "<binary>";
            } else if (type === "html") {
                out[name] = liveHtmlValue(record, name);
            } else if (val instanceof String) {
                // Markup is a String subclass: spreading it sent one key per character.
                out[name] = String(val);
            } else if (Array.isArray(val)) {
                out[name] = Array.from(val);
            } else if (typeof val === "object") {
                out[name] = { ...val };
            } else {
                out[name] = val;
            }
        } catch {
            out[name] = null;
        }
    }
    return out;
}

/**
 * Detecta si un elemento de un valor x2many YA es una tupla-comando web de Odoo
 * (`[op, id, vals]`, op numérico 0..6) en vez de un objeto plano de valores.
 * El frontend de Odoo (`StaticList._applyCommands`) SOLO entiende tuplas-comando:
 * `[[0, false, {vals}]]` para CREATE, `[[1, id, {vals}]]` UPDATE, etc. Un objeto
 * plano `{product_id: 1}` como "comando" tiene `command[0] === undefined`, no
 * matchea ningún case y `_applyCommands` no tiene `default` → NO-OP SILENCIOSO
 * (la línea nunca se crea y `_update` igual resuelve "ok"). Ver record.js
 * `_preprocessX2manyChanges` + static_list.js `_applyCommands`.
 */
function isX2manyCommandTuple(el) {
    return Array.isArray(el) && typeof el[0] === "number";
}

/**
 * Normaliza el valor de UN campo x2many a tuplas-comando web de Odoo, tolerando
 * la forma "amigable" (lista de objetos planos) que un LLM tiende a mandar:
 *   - `[{product_id: 1, product_uom_qty: 2}]`  → `[[0, false, {product_id: 1, …}]]`
 *     (cada objeto plano se vuelve un CREATE, op 0).
 *   - `[[0, false, {…}]]` (ya tuplas)          → se deja igual.
 *   - listas mixtas                            → se normaliza elemento por elemento.
 *   - ids sueltos `[1, 2]` (atajo LINK m2m)    → `[[4, 1], [4, 2]]` (op 4 = LINK).
 * Devuelve el valor tal cual si no es un array (no se entromete con otras formas).
 * CREATE=0, LINK=4 son los códigos del web command set de Odoo (orm_service.js).
 */
function normalizeX2manyValue(value) {
    if (!Array.isArray(value)) {
        return value;
    }
    return value.map((el) => {
        if (isX2manyCommandTuple(el)) {
            return el; // ya es [op, id, vals]
        }
        if (el && typeof el === "object" && !Array.isArray(el)) {
            // Objeto plano de valores → CREATE (agregar línea nueva).
            return [0, false, el];
        }
        if (typeof el === "number") {
            // Id suelto → LINK (vincular registro existente, típico m2m).
            return [4, el];
        }
        return el; // forma desconocida: no la tocamos (que falle visible, no en silencio)
    });
}

// Enough to recognise a closed tab by what it holds, without paying for all of it.
const TAB_CONTENTS_MAX = 50;

/**
 * What a closed tab holds, read from the form's arch: a closed notebook page is not
 * rendered, so the screen alone cannot say that "Términos de pago" is behind
 * "Ventas y compras". A form page lists its fields, a settings app its settings.
 */
function tabContents(xmlDoc, record, tab, hidden) {
    const key = tab.getAttribute("name") || tab.dataset.key;
    if (!key || !xmlDoc?.querySelector || tab.matches(".active, .selected, [aria-selected=true]")) {
        return [];
    }
    const node = xmlDoc.querySelector(`page[name="${CSS.escape(key)}"], app[name="${CSS.escape(key)}"]`);
    if (!node) {
        return [];
    }
    const labels = new Set();
    for (const item of node.querySelectorAll("setting, field:not(setting field):not(field field)")) {
        const field = item.tagName === "setting" ? item.querySelector("field") : item;
        if (hidden?.has(field?.getAttribute("name"))) {
            continue;
        }
        const label = item.getAttribute("string") || record?.fields?.[field?.getAttribute("name")]?.string;
        if (label) {
            labels.add(label);
        }
        if (labels.size >= TAB_CONTENTS_MAX) {
            break;
        }
    }
    return [...labels];
}

/**
 * Los campos que el ARCH deja fuera de la pantalla, leídos ocurrencia por
 * ocurrencia.
 *
 * POR QUÉ HACE FALTA, Y ES EL BORDE QUE MÁS ENGAÑA. `activeFields[campo].invisible`
 * trae SÓLO el modificador del propio nodo `<field>`. El `invisible` de un
 * `<group>`, una `<page>` o un `<div>` que lo contiene se compila a un `t-if` del
 * template y **nunca toca `activeFields`** — así que el evaluador de Odoo dice
 * que el campo se ve, el valor viaja, y el campo no está en el DOM. Como el
 * contrato de este mapa es "un campo ausente es normal", el modelo lee *visible*
 * sobre algo que la persona no tiene delante: exactamente la falla que este
 * contexto existe para evitar. Medido sobre 324 modelos: **20,19% de los campos
 * top-level** están en esa situación.
 *
 * EL ORDEN DE LA CUENTA ES EL QUE IMPORTA, y es la parte que se puede hacer mal
 * sin que se note: por CADA ocurrencia se pregunta si la esconde su propio
 * modificador **o** alguno de sus ancestros, y recién después se combinan las
 * ocurrencias entre sí. Calcular los dos ejes por separado —el AND de los
 * propios por un lado, el AND de los ancestros por el otro, y un OR al final—
 * deja pasar el patrón más común de Odoo: el mismo campo puesto dos veces, una
 * como `<field invisible="1"/>` técnico y otra adentro de un contenedor
 * condicional. Ahí ninguna de las dos se dibuja y ninguno de los dos ejes lo
 * marca. En los formularios del core de la 19 hay 20 campos así — `qr_code` en
 * los pagos, tres de gastos, tres de configuración del PdV, `pricelist_id` en
 * ventas — y en todos la mentira sale justo del lado peligroso.
 *
 * `field:not(field field)` es el mismo idioma que usa Odoo (`form_controller.js`,
 * el barrido de `footer`) para saltear lo que vive dentro de otro `<field>`: un
 * x2many embebido trae su propia vista, y sus campos no son de este formulario.
 *
 * Sólo `invisible`: un `readonly` o un `required` puestos en un ancestro **no se
 * propagan ni al render**, así que para esos dos el mapa ya estaba bien.
 *
 * @param {Object} xmlDoc  el arch del formulario (`archInfo.xmlDoc`)
 * @param {Object} record  el record OWL, para evaluar la condición
 * @returns {Set<string>}
 */
function camposOcultosSegunElArch(xmlDoc, record) {
    const ocultos = new Set();
    if (!xmlDoc?.querySelectorAll || !record) {
        return ocultos;
    }
    const ctx = record.evalContextWithVirtualIds || {};
    /** Por campo: cuántas veces aparece en el arch y cuántas están escondidas. */
    const cuenta = new Map();
    for (const nodo of xmlDoc.querySelectorAll("field:not(field field)")) {
        const nombre = nodo.getAttribute?.("name");
        if (!nombre) {
            continue;
        }
        // Arranca en el PROPIO nodo, no en su padre: para esta ocurrencia da lo
        // mismo que la esconda su modificador o el del `<group>` de arriba.
        let escondida = false;
        let el = nodo;
        while (el && !escondida) {
            const expr = el.getAttribute?.("invisible");
            try {
                if (expr && evaluateBooleanExpr(expr, ctx)) {
                    escondida = true;
                }
            } catch {
                // Una condición que no se puede evaluar no esconde nada: el
                // default es dejar pasar, como antes de este chequeo.
            }
            el = el.parentElement;
        }
        const previo = cuenta.get(nombre) || { veces: 0, escondidas: 0 };
        cuenta.set(nombre, {
            veces: previo.veces + 1,
            escondidas: previo.escondidas + (escondida ? 1 : 0),
        });
    }
    // UN CAMPO QUE APARECE DOS VECES ESTÁ OCULTO SÓLO SI LAS DOS ESTÁN OCULTAS,
    // y esto no es un detalle: el patrón de dos ramas mutuamente excluyentes
    // —el mismo campo en dos `<div>` con condiciones opuestas— es común en los
    // formularios de Odoo. Marcarlo con que UNA esté escondida daba el campo por
    // invisible cuando la persona lo tiene delante en la otra rama, y de paso
    // hacía descartar una propuesta legítima.
    //
    // Es la misma regla que usa Odoo al fusionar dos nodos del mismo campo:
    // `patchActiveFields` combina el `invisible` con AND (utils.js:174).
    for (const [nombre, { veces, escondidas }] of cuenta) {
        if (veces > 0 && escondidas === veces) {
            ocultos.add(nombre);
        }
    }
    return ocultos;
}

/**
 * ¿Se puede confiar en el estado que reporta este record?
 *
 * Los tres evaluadores se llaman con `?.()`, y eso degrada en silencio HACIA EL
 * LADO PELIGROSO: si una versión de Odoo renombra sólo `_isInvisible`, el mapa no
 * queda vacío — queda sin ningún `invisible`, que es indistinguible de "todos los
 * campos se ven". Por eso se chequea una vez y se dice, en vez de inferirlo del
 * vacío del otro lado.
 */
function evaluadoresDisponibles(record) {
    return (
        typeof record?._isInvisible === "function" &&
        typeof record?._isReadonly === "function" &&
        typeof record?._isRequired === "function"
    );
}

/**
 * El ESTADO de los campos del formulario abierto: cuáles se ven, cuáles se
 * pueden escribir, cuáles son obligatorios.
 *
 * POR QUÉ HACE FALTA. Hasta acá el asistente recibía los VALORES de los campos y
 * nada de su estado, así que sabía qué dice cada campo pero no cuáles están en la
 * pantalla. De ahí salieron tres fallas distintas que son la misma: marcó un
 * campo que la configuración de ese registro tenía oculto; dijo "te lo señalé"
 * sobre una marca que no podía caer; y propuso escribir en campos de sólo
 * lectura, porque el único chequeo posible era la definición ESTÁTICA del campo y
 * la mitad de los readonly de Odoo son condicionales.
 *
 * Odoo ya resuelve las tres preguntas contra el registro concreto —con sus
 * condiciones evaluadas— y lo único que faltaba era transportarlo.
 *
 * SÓLO VIAJAN LAS EXCEPCIONES. Un formulario tiene decenas de campos y casi todos
 * son visibles, editables y opcionales; mandar tres booleanos por cada uno
 * engordaría cada mensaje para no decir nada. Un campo ausente de este mapa es un
 * campo normal.
 *
 * @param {Object} record  el record OWL del formulario abierto
 * @returns {Object} `{campo: {invisible?, readonly?, required?}}`, sólo con lo anómalo
 */
function serializeFieldState(record, ocultosSegunElArch = new Set()) {
    const activos = record?.activeFields || {};
    const out = {};
    for (const name of Object.keys(activos)) {
        try {
            const estado = {};
            // Métodos internos de Odoo (`_isInvisible` y compañía). Se usan igual
            // porque son los que EVALÚAN la condición contra este registro, que es
            // justamente el dato que no se puede reconstruir desde afuera. Cada
            // campo va en su propio try: si una versión los renombra, se pierde el
            // estado de los campos y no el contexto entero.
            // El OR con lo que dice el arch es lo que hace honesto a este mapa:
            // el evaluador de Odoo no ve los ancestros, y al fusionar dos nodos
            // del mismo campo pierde de vista que las dos ocurrencias podían
            // estar escondidas por motivos distintos.
            if (record._isInvisible?.(name) || ocultosSegunElArch.has(name)) {
                estado.invisible = true;
            }
            if (record._isReadonly?.(name)) {
                estado.readonly = true;
            }
            if (record._isRequired?.(name)) {
                estado.required = true;
            }
            if (Object.keys(estado).length) {
                out[name] = estado;
            }
        } catch {
            // Un campo que no se puede evaluar no tira abajo el resto.
        }
    }
    return out;
}

/**
 * Normaliza una propuesta `{campo: valor}` ya validada contra los campos del
 * form: para cada campo one2many/many2many, convierte la forma amigable (lista
 * de objetos planos) a tuplas-comando que `record._update` sí aplica. Pura (sin
 * dependencias de OWL) → testeable en aislamiento. No muta la entrada.
 *
 * @param {Object} known   propuesta filtrada {campo: valor}
 * @param {Object} fieldDefs  `record.fields` (defs con `.type`)
 * @returns {Object} nueva propuesta con los x2many normalizados a tuplas-comando
 */
function normalizeProposalX2many(known, fieldDefs) {
    const defs = fieldDefs || {};
    const out = {};
    for (const [name, value] of Object.entries(known)) {
        const type = defs[name]?.type;
        if (type === "one2many" || type === "many2many") {
            out[name] = normalizeX2manyValue(value);
        } else {
            out[name] = value;
        }
    }
    return out;
}

/**
 * Parsea a Luxon el valor propuesto para un campo `date` / `datetime`.
 *
 * Por qué hace falta: el modelo OWL guarda las fechas como objetos Luxon
 * — `parseServerValue` (web/static/src/model/relational_model/utils.js) hace
 * literalmente `value ? deserializeDate(value) : false` — y el widget las
 * renderiza con `value.toFormat()`. Un string crudo metido por `record._update`
 * NO revienta ahí: revienta después, al renderizar, con `value.toFormat is not
 * a function`, un OwlError que se lleva puesto el formulario entero. Es el mismo
 * agujero que ya estaba tapado para los m2o (id pelado → `{id}`), en el campo de
 * al lado: coercionábamos las relaciones y no las fechas.
 *
 * Aceptamos las DOS formas que llegan en la práctica:
 *   - formato servidor de Odoo ("2026-09-30", "2026-09-30 14:30:00"), que es lo
 *     que manda un modelo que conoce Odoo y lo único que parsean los helpers;
 *   - ISO 8601 con "T" y offset ("2026-09-30T14:30:00+02:00"), que es lo que el
 *     modelo VE: nuestro propio serializador de salida emite `toISO()` para los
 *     datetime, así que lo natural es que lo devuelva en esa forma.
 *
 * No unificamos cambiando el formato de SALIDA: el SPA y el modelo están fuera
 * de nuestro control y pueden mandar cualquiera de las dos igual. Ser tolerante
 * acá cubre los dos casos; cambiar la salida no cubre ninguno.
 *
 * @param {*} value valor propuesto
 * @param {"date"|"datetime"} type tipo del campo
 * @returns {DateTime|false|null} el objeto Luxon; `false` para limpiar el campo;
 *   `null` si no se pudo parsear — el llamador descarta el campo y lo dice, en
 *   vez de meter un DateTime inválido que el form pinta como "Invalid DateTime".
 */
function coerceDateValue(value, type) {
    // Limpiar el campo es legítimo, y viaja como false/null/"".
    if (value === false || value === null || value === undefined) {
        return false;
    }
    // Ya es un DateTime: no llega así por postMessage, pero sí desde un test.
    if (typeof value?.toFormat === "function") {
        return value.isValid ? value : null;
    }
    if (typeof value !== "string") {
        return null;
    }
    const raw = value.trim();
    if (!raw) {
        return false;
    }
    // Exigir una fecha completa adelante. Luxon es MÁS permisivo de lo que sirve
    // acá: `fromSQL("14:30")` devuelve HOY a las 14:30, y `"2026"` se lee como la
    // hora 20:26 de hoy. Sin este guard, "poné la reunión a las 14:30" entra como
    // un valor plausible y equivocado — que es peor que rebotar, porque el aviso
    // de "no pude leer la fecha" nunca aparece y el usuario ve un dato creíble.
    if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) {
        return null;
    }
    if (type === "date") {
        // Un campo date no tiene hora ni zona. Si viene un datetime nos quedamos
        // con la fecha TAL COMO ESTÁ ESCRITA, sin convertir: pasar por la zona
        // local puede correrla un día (las 23:00Z, en UTC-3, son el día anterior).
        const parsed = deserializeDate(raw.split(/[T ]/)[0]);
        return parsed.isValid ? parsed : null;
    }
    const fromServer = deserializeDateTime(raw);
    if (fromServer.isValid) {
        return fromServer;
    }
    // ISO con "T". Un string sin offset se interpreta en UTC, la misma convención
    // que `deserializeDateTime` (el servidor manda UTC); uno con offset ya trae
    // el instante y Luxon lo respeta.
    const fromIso = DateTime.fromISO(raw, { zone: "utc" });
    return fromIso.isValid ? fromIso.setZone("default") : null;
}

/**
 * Coerce los valores dentro de las `vals` de un comando CREATE/UPDATE de un
 * x2many a la forma que el record OWL del sub-modelo entiende. Dos tipos:
 *
 * **Relaciones.** `StaticList._applyCommands` (case CREATE) crea el datapoint de
 * la línea con `new Record(..., command[2])`, y `parseServerValue` para un
 * many2one acepta `[id, name]` o `{id, display_name}` pero un **entero pelado lo
 * devuelve tal cual** (no lo reconoce como m2o seteado). Un LLM manda
 * `{"product_id": 1}` (id pelado) → la línea queda SIN producto y el onchange ve
 * un producto vacío (no calcula name/price). Convertimos cada valor de un sub-
 * campo many2one/many2one_reference de `<int>` a `{id: <int>}` para que el m2o
 * quede seteado y el onchange del padre resuelva el resto (name, precio, totales).
 *
 * **Fechas.** Una línea nueva con fecha (`{"x_fecha_entrega": "2026-09-30"}`) se
 * aplica con `line._update(campo)` y cae en el MISMO agujero que los escalares
 * del record padre: string crudo → `value.toFormat is not a function` al
 * renderizar. Ver `coerceDateValue`.
 *
 * `subFields` son las defs de campo del SUB-modelo (las del StaticList del x2many).
 * Sin ellas (no resolubles) devolvemos las vals sin tocar (best-effort, no rompe).
 *
 * `badKeys` (opcional) recolecta los sub-campos fecha que no se pudieron parsear;
 * se descartan de las vals en vez de meter un DateTime inválido en la línea. Se
 * pasa por parámetro para que la función siga siendo pura (sin notificaciones ni
 * dependencias de OWL) y testeable en aislamiento.
 */
function coerceCommandVals(vals, subFields, badKeys) {
    if (!vals || typeof vals !== "object" || Array.isArray(vals) || !subFields) {
        return vals;
    }
    const out = {};
    for (const [k, v] of Object.entries(vals)) {
        const t = subFields[k]?.type;
        if ((t === "many2one" || t === "many2one_reference") && typeof v === "number") {
            out[k] = { id: v };
        } else if (t === "date" || t === "datetime") {
            // A FORMATO SERVIDOR, no a Luxon. Las vals de un comando las vuelve a
            // parsear Odoo: el case UPDATE de `_applyCommands` hace
            // `record._parseServerValues(changes)` y el CREATE por `_update` pasa
            // por `_setData` → lo mismo. `parseServerValue` llama a
            // `deserializeDate`, o sea `DateTime.fromSQL(...)`, y con un objeto
            // Luxon adentro eso da `Invalid DateTime` — sin tirar: la celda queda
            // en "Invalid DateTime" y al guardar se manda ese literal al server.
            // Normalizamos igual (parse + re-serialize) porque el modelo puede
            // mandar ISO con "T", que `deserializeDate` tampoco parsea.
            const parsed = coerceDateValue(v, t);
            if (parsed === null) {
                badKeys?.push(k);
            } else if (parsed === false) {
                out[k] = false;
            } else {
                out[k] = t === "date" ? serializeDate(parsed) : serializeDateTime(parsed);
            }
        } else {
            out[k] = v;
        }
    }
    return out;
}

/**
 * Aplica coerceCommandVals a cada comando CREATE(0)/UPDATE(1) de un valor x2many
 * ya normalizado a tuplas-comando. Deja intactos LINK/DELETE/UNLINK (no llevan
 * vals que coercer) y cualquier forma que no sea tupla.
 */
function coerceX2manyCommandVals(commands, subFields, badKeys) {
    if (!Array.isArray(commands) || !subFields) {
        return commands;
    }
    return commands.map((cmd) => {
        if (Array.isArray(cmd) && (cmd[0] === 0 || cmd[0] === 1) && cmd[2] && typeof cmd[2] === "object") {
            return [cmd[0], cmd[1], coerceCommandVals(cmd[2], subFields, badKeys)];
        }
        return cmd;
    });
}

/**
 * Separa los comandos x2many de un valor (ya normalizado a tuplas) en:
 *   - `creates`: comandos CREATE (op 0) → se aplican vía `list.addNewRecord` +
 *     `line._update(campo)` para que dispare el ONCHANGE de la línea (sin eso, el
 *     producto queda sin name/precio: el onchange del padre NO computa la línea
 *     nueva — verificado en runtime). `vals` = el objeto de valores del comando.
 *   - `rest`: el resto (UPDATE/DELETE/UNLINK/LINK/SET) → se mandan tal cual a
 *     `record._update` (esos sí los maneja bien `_applyCommands`).
 * Si el valor no es un array de tuplas, va entero a `rest` (no nos arriesgamos).
 */
function splitX2manyCreates(value) {
    const creates = [];
    const rest = [];
    if (!Array.isArray(value)) {
        return { creates, rest: value };
    }
    for (const cmd of value) {
        if (Array.isArray(cmd) && cmd[0] === 0 && cmd[2] && typeof cmd[2] === "object") {
            creates.push(cmd[2]); // las vals del CREATE
        } else {
            rest.push(cmd);
        }
    }
    return { creates, rest };
}

/**
 * Cuenta los registros vivos de un campo x2many en un record OWL (para el
 * chequeo "honesto": ¿la propuesta realmente agregó la línea?). El StaticList
 * expone `.count` y, defensivamente, `.records`/`.currentIds`. Devuelve null si
 * no se puede leer (no es x2many, o no hay valor) → el caller no infiere nada.
 */
function x2manyCount(record, name) {
    try {
        const val = record?.data?.[name];
        if (!val) {
            return null;
        }
        if (typeof val.count === "number") {
            return val.count;
        }
        if (Array.isArray(val.records)) {
            return val.records.length;
        }
        if (Array.isArray(val.currentIds)) {
            return val.currentIds.length;
        }
    } catch {
        // sin lectura confiable: no afirmamos nada sobre si tomó o no.
    }
    return null;
}

/**
 * Dada la propuesta NORMALIZADA, devuelve los campos x2many con al menos un
 * comando CREATE (op 0), y cuántos — esos son los que TIENEN que hacer crecer
 * el `count` en exactamente esa cantidad. Sirve para el chequeo honesto
 * post-apply: pedimos N líneas nuevas, si no aparecieron N fue un no-op.
 *
 * LINK (op 4) queda AFUERA a propósito, por dos razones independientes:
 *
 *   1. Re-linkear una fila que ya está en la lista es un no-op LEGÍTIMO: lo
 *      que se pidió (que el registro quede vinculado) es verdad antes y
 *      después. Contarlo como "no se aplicó" es una falsa alarma, y el aviso
 *      le dice al usuario que revise algo que está bien.
 *   2. Para el caso que sí es un error —LINK a un id inexistente— el modelo
 *      falla visible por su propio camino, así que el guard no compra nada.
 *
 * Con CREATE no hay ambigüedad: "tiene que haber una fila nueva por cada
 * comando" es cierto siempre, y por eso el oráculo puede ser cuantitativo
 * (`after >= before + adds`) en vez del `after > before` que dejaba pasar
 * "pedí 3 líneas, entró 1".
 */
function x2manyFieldsExpectingGrowth(normalized, fieldDefs) {
    const defs = fieldDefs || {};
    const fields = [];
    for (const [name, value] of Object.entries(normalized)) {
        const type = defs[name]?.type;
        if ((type === "one2many" || type === "many2many") && Array.isArray(value)) {
            const adds = value.filter((c) => Array.isArray(c) && c[0] === 0).length;
            if (adds > 0) {
                fields.push({ name, adds });
            }
        }
    }
    return fields;
}

// Attributes DOMPurify drops by default but the editor's SanitizePlugin and the
// server keep.
const DOMPURIFY_ADD_ATTR = ["target", "contenteditable", "t-field", "t-out", "t-esc"];

/**
 * Cleans HTML BEFORE the client inserts it when no editor does it: the chatter
 * composer body and html fields without a mounted editor. The server cleans on
 * save, but what reaches the DOM runs first (an `<img onerror>` runs when it is
 * rendered). Uses DOMPurify (part of the `web` bundle): it removes scripts,
 * iframes, `on*` handlers and `javascript:` URLs.
 * Returns "" when it cannot clean (it does not risk injecting).
 * `drops.count`, when given, adds what `dropCrossOriginLoads` removed; `keep`
 * is passed to it.
 */
function sanitizeHtml(html, drops = null, keep = null) {
    if (typeof html !== "string" || !html.trim() || !window.DOMPurify) {
        return "";
    }
    try {
        const clean = window.DOMPurify.sanitize(html, {
            ADD_ATTR: DOMPURIFY_ADD_ATTR,
            FORBID_TAGS: ["style"],
        });
        // Parsed in an inert template: nothing loads while it is filtered.
        const template = document.createElement("template");
        template.innerHTML = clean;
        const removed = dropCrossOriginLoads(template.content, keep);
        if (drops) {
            drops.count += removed;
        }
        return template.innerHTML;
    } catch {
        return "";
    }
}

/**
 * Whether the browser may load `url` by itself from a proposal: same origin as
 * this Odoo (relative paths included) or an inline `data:image/...`.
 */
function isSameOriginLoad(url) {
    const value = String(url || "").trim();
    if (/^data:/i.test(value)) {
        return /^data:image\//i.test(value);
    }
    try {
        return new URL(value, window.location.origin).origin === window.location.origin;
    } catch {
        return false;
    }
}

// srcset descriptors ("2x", "480w"): everything else in it is a URL.
const SRCSET_DESCRIPTOR = /^\d+(\.\d+)?[wxh]$/i;
const CSS_URL = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/gi;
const CSS_STRING = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;

const SVG_NS = "http://www.w3.org/2000/svg";

/** Whether `url` may load: same origin, or already in the field (`keep`, see `loadUrlsIn`). */
function isAllowedLoad(url, keep = null) {
    return isSameOriginLoad(url) || Boolean(keep && keep.has(String(url || "").trim()));
}

/** Decodes CSS escapes (`\75rl(` is `url(`): SVG presentation attributes are parsed as CSS. */
function decodeCssEscapes(value) {
    return value.replace(/\\(?:([0-9a-f]{1,6})\s?|(.))/gi, (_, hex, char) => {
        if (char !== undefined) {
            return char;
        }
        const code = parseInt(hex, 16);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd";
    });
}

/** The URLs a CSS value loads: `url(...)`, and the plain strings of an `image-set(...)`. */
function cssUrls(value) {
    const urls = [...value.matchAll(CSS_URL)].map((m) => m[1] ?? m[2] ?? m[3]);
    if (/image-set\(/i.test(value)) {
        urls.push(...[...value.matchAll(CSS_STRING)].map((m) => m[1] ?? m[2]));
    }
    return urls.map((url) => url.replace(/\\(.)/g, "$1"));
}

// A custom property is re-tokenized where it is used: a string or a URL in it
// can end up loaded (`image-set(var(--x))`), and an escape can hide a `url(`.
const RISKY_CUSTOM_PROPERTY = /["'\\:]|url\(|image-set\(/i;

/** Whether a CSS value (as the CSSOM serializes it) only loads what `isAllowedLoad` allows. */
function cssLoadsSameOrigin(property, value, keep = null) {
    if (property.startsWith("--") && RISKY_CUSTOM_PROPERTY.test(value)) {
        return false;
    }
    // Its strings may come from a custom property defined anywhere.
    if (/image-set\(/i.test(value) && /var\(/i.test(value)) {
        return false;
    }
    return cssUrls(value).every((url) => isAllowedLoad(url, keep));
}

// Attributes whose value is a URL the browser loads by itself; `href` too on
// the SVG elements in `SVG_HREF_LOADS` (a link does not load).
const LOAD_ATTRIBUTES = ["src", "poster", "background"];
const SVG_HREF_LOADS = ["image", "use", "feImage"];

/**
 * The URLs the html (a node, or a string or Markup) already loads: the proposal may repeat
 * them (an external image already in the field) since loading them again sends
 * nothing new. Only identical URLs pass; `<style>` and custom properties never do.
 */
function loadUrlsIn(source) {
    const urls = new Set();
    let root = source;
    // Not `instanceof Node`: the editable may live in an iframe (another realm).
    if (typeof source?.querySelectorAll !== "function") {
        // Parsed in an inert template: nothing of it loads here.
        const template = document.createElement("template");
        template.innerHTML = String(source || "");
        root = template.content;
    }
    for (const el of root.querySelectorAll("*")) {
        const svgHrefLoads = el.namespaceURI === SVG_NS && SVG_HREF_LOADS.includes(el.localName);
        for (const { name, value } of el.attributes) {
            if (name === "href" || name === "xlink:href") {
                // A link was never loaded: it does not let the same URL load.
                if (svgHrefLoads) {
                    urls.add(value.trim());
                }
                continue;
            }
            if (LOAD_ATTRIBUTES.includes(name)) {
                urls.add(value.trim());
            } else if (name === "srcset") {
                for (const token of value.split(/[\s,]+/)) {
                    urls.add(token);
                }
            }
            for (const url of cssUrls(decodeCssEscapes(value))) {
                urls.add(url.trim());
            }
        }
        if (el.style) {
            for (const property of el.style) {
                for (const url of cssUrls(el.style.getPropertyValue(property))) {
                    urls.add(url.trim());
                }
            }
        }
    }
    urls.delete("");
    return urls;
}

/**
 * Removes from a cleaned, inert fragment every reference the browser would
 * load by itself from another origin: with a prompt injection the model could
 * leak data in such a URL as soon as the proposal is applied, before saving.
 * An `<img>` with a foreign `src` is removed whole; elsewhere only the
 * attribute or the CSS declaration goes. Links (`href`) do not load: kept.
 * `<style>` elements always go: their rules can load anything.
 * `keep` (from `loadUrlsIn`): URLs that were already in the field and may stay.
 * Returns how many things it removed (elements, attributes, style attributes).
 */
function dropCrossOriginLoads(fragment, keep = null) {
    const allowed = (url) => isAllowedLoad(url, keep);
    let removed = 0;
    for (const el of [...fragment.querySelectorAll("*")]) {
        if (el.localName === "style") {
            el.remove();
            removed++;
            continue;
        }
        if (el.hasAttribute("src") && !allowed(el.getAttribute("src"))) {
            removed++;
            if (el.localName === "img") {
                const parent = el.parentElement;
                el.remove();
                // A wrapper left empty (`<p><img></p>`) would stay as a blank line.
                // Table cells stay: removing one shifts the columns.
                if (
                    parent &&
                    !["td", "th"].includes(parent.localName) &&
                    !parent.textContent.trim() &&
                    !parent.firstElementChild
                ) {
                    parent.remove();
                }
                continue;
            }
            el.removeAttribute("src");
        }
        for (const name of ["poster", "background"]) {
            if (el.hasAttribute(name) && !allowed(el.getAttribute(name))) {
                el.removeAttribute(name);
                removed++;
            }
        }
        if (el.hasAttribute("srcset")) {
            const urls = el
                .getAttribute("srcset")
                .split(/[\s,]+/)
                .filter((token) => token && !SRCSET_DESCRIPTOR.test(token));
            if (!urls.every(allowed)) {
                el.removeAttribute("srcset");
                removed++;
            }
        }
        // SVG <image>, <use>, <feImage> load their href.
        if (el.namespaceURI === SVG_NS && SVG_HREF_LOADS.includes(el.localName)) {
            for (const name of ["href", "xlink:href"]) {
                if (el.hasAttribute(name) && !allowed(el.getAttribute(name))) {
                    el.removeAttribute(name);
                    removed++;
                }
            }
        }
        // Any other attribute with a CSS load: SVG presentation attributes
        // (`fill`, `mask`, `filter`, `marker-*`...) take `url(...)`.
        for (const { name, value } of [...el.attributes]) {
            if (name === "style") {
                continue;
            }
            const decoded = decodeCssEscapes(value);
            if (/url\(|image-set\(/i.test(decoded) && !cssLoadsSameOrigin(name, decoded, keep)) {
                el.removeAttribute(name);
                removed++;
            }
        }
        // The CSSOM parses the attribute as the live document will, escapes included.
        if (el.hasAttribute("style")) {
            let styleDropped = false;
            for (const property of [...el.style]) {
                if (!cssLoadsSameOrigin(property, el.style.getPropertyValue(property), keep)) {
                    styleDropped = true;
                    // Also the shorthand it may come from (`background`), so no
                    // leftover longhands stay behind.
                    el.style.removeProperty(property.split("-")[0]);
                    el.style.removeProperty(property);
                }
            }
            if (styleDropped) {
                removed++;
            }
            if (!el.getAttribute("style").trim()) {
                el.removeAttribute("style");
            }
        }
    }
    return removed;
}

/** The notice for what `dropCrossOriginLoads` removed from a proposal ("" if nothing). */
function droppedLoadsNote(count) {
    if (!count) {
        return "";
    }
    return String(
        _t(
            "Removed %s image(s) or resource(s) from another site: only images and files from this Odoo can be added.",
            count
        )
    );
}

// Caps the allowed-but-inactive list in the context: a database with dozens of
// companies would otherwise fill the prompt with names nobody asked for.
// The active ones are never cut: a missing one reads as "no access".
const MAX_COMPANIES = 20;

/**
 * The companies in play on this screen, for the page context.
 *
 * A new record opens in the CURRENT company whatever the request names, so
 * without this the assistant created a sale order in the active company when
 * the user had asked for another one, and said nothing.
 * `switchMode: "live"` tells the backend this host can switch in place.
 */

export function companyInPlay() {
    const current = user.activeCompany;
    if (!current?.id || !current?.name) {
        return null;
    }
    const pick = (c) => ({ id: c.id, name: c.name });
    const valid = (c) => Boolean(c?.id && c?.name);
    const active = (user.activeCompanies || []).filter(valid).map(pick);
    const activeIds = new Set(active.map((c) => c.id));
    const available = Object.values(user.allowedCompanies || {})
        .filter((c) => valid(c) && !activeIds.has(c.id))
        .map(pick);
    const info = {
        current: pick(current),
        active,
        available: available.slice(0, MAX_COMPANIES),
        switchMode: "live",
    };
    if (available.length > MAX_COMPANIES) {
        info.availableTotal = available.length;
    }
    return info;
}

/**
 * Make `companyId` the current company, keeping the other active ones.
 *
 * `reload: false` is what Odoo itself does when a form needs a company that is
 * not active (form_controller): the switcher listens to the change and redraws,
 * and the page, with the assistant panel in it, stays put.
 */
export function switchCompany(companyId) {
    const allowed = Object.values(user.allowedCompanies || {});
    if (!allowed.some((c) => c.id === companyId)) {
        return false;
    }
    const others = (user.activeCompanies || []).map((c) => c.id).filter((id) => id !== companyId);
    user.activateCompanies([companyId, ...others], { includeChildCompanies: false, reload: false });
    return true;
}

// Proposal kinds this host takes (announced in `capabilities`). All are answered with
// `apply-result` but `wait_step`, which answers later with a `step-event`.
export const APPLY_RESULT_KINDS = ["form_changes", "form_html", "chatter", "show_me", "point", "wait_step"];

// The `navigate` modes this host opens (announced in `capabilities`).
export const NAVIGATE_MODES = ["record", "new", "browse", "action"];

// How long a mark by name keeps looking before it says the name is not on screen: a
// view just opened draws its controls up to a second later.
const POINT_PATIENCE_MS = 3000;
// The dropdowns of a view that hold controls rather than ways elsewhere, while closed:
// the search options (filters, group by), measures, optional columns, actions.
const CLOSED_VIEW_MENUS = '.o_control_panel button[aria-expanded="false"], .o_optional_columns_dropdown button[aria-expanded="false"]';
// Each one opens for a moment in front of the person: a few, not every toggle on the page.
const MAX_MENUS_OPENED = 6;
const POINT_LOOK_MS = 200;

// How many proposal results are kept to answer a replayed `proposalId`.
const MAX_PROPOSAL_RESULTS = 50;

/**
 * Builds the outcome of a proposal, as the SPA receives it in `apply-result`.
 * `applied` means "on screen, unsaved". `reason` is set when the proposal was
 * rejected as a whole (other record, no form open, unsupported kind…).
 */
function proposalResult({ applied = [], skipped = [], notes = [], reason = null, wrote = null }) {
    const anyWrite = wrote ?? applied.length > 0;
    // A proposal that changed nothing and names nothing it dropped was empty:
    // answering "applied" would let the model say it did something.
    if (!anyWrite && !skipped.length && !reason) {
        reason = "invalid_proposal";
    }
    let status = "applied";
    if (reason || skipped.length) {
        status = anyWrite ? "partial" : "rejected";
    }
    const result = { status, applied, skipped, message: notes.join(" ") };
    if (reason) {
        result.reason = reason;
    }
    return result;
}

/**
 * True when the proposal names a record other than `model`/`resId`. No target
 * (old SPA): false. A target without `resId` was a new record when the turn
 * started, and saving it mid-turn gives it one: only the model can be compared.
 */
function isOtherRecord(target, model, resId) {
    if (!target || typeof target !== "object") {
        return false;
    }
    if (target.model !== model) {
        return true;
    }
    return Boolean(target.resId) && target.resId !== (resId || false);
}

/**
 * On-screen value of an html field, as a string. While the person is typing in
 * the editor (changes the HtmlField only passes to the record when leaving the
 * field), it sends the live editor content; otherwise, the record value. Without
 * pending changes it reads the record on purpose: the editor normalizes the HTML
 * when it mounts, so reading it would change the value with nobody touching
 * anything (and that would look like a conflict).
 */
function liveHtmlValue(record, name) {
    const field = getMountedHtmlField(record, name);
    if (field?.isDirty) {
        try {
            return field.editor.getContent();
        } catch {
            // Fall back to the record value.
        }
    }
    const value = record.data?.[name];
    return value ? String(value) : "";
}

// Metadata the editor stamps on the content when saving it.
const EDITOR_METADATA_ATTRIBUTES = ["data-oe-version", "data-last-history-steps"];

/** Same node, ignoring the editor's metadata attributes. */
function sameNode(a, b) {
    if (a.isEqualNode(b)) {
        return true;
    }
    if (a.nodeType !== Node.ELEMENT_NODE || b.nodeType !== Node.ELEMENT_NODE) {
        return false;
    }
    const [ca, cb] = [a.cloneNode(true), b.cloneNode(true)];
    for (const attribute of EDITOR_METADATA_ATTRIBUTES) {
        ca.removeAttribute(attribute);
        cb.removeAttribute(attribute);
    }
    return ca.isEqualNode(cb);
}

/**
 * Sets `html` as the content of `container`, touching only the top-level nodes
 * that change: the equal prefix and suffix stay as they are (with their `t-if`,
 * video iframes, etc.). Only the inserted nodes go through `sanitizeFragment`,
 * so cleaning does not flatten what the edit did not touch. With an editor, the
 * rest of the field is not re-created, the history step is small and the caret
 * stays where it was if it was not in the edited part.
 *
 * `reference` is the clean version of the content (`editor.getElContent()`):
 * the live editor DOM has its own attributes that the saved value does not, so
 * the comparison uses it. If it does not match node by node, the comparison
 * uses `container` itself (at worst everything is replaced).
 *
 * `container` can be a DocumentFragment (`template.content`).
 */
function replaceChangedChildren(container, html, sanitizeFragment, reference = null) {
    const template = container.ownerDocument.createElement("template");
    template.innerHTML = html;
    const next = [...template.content.childNodes];
    // Editor-only nodes (the selection placeholder) are not in the saved value.
    const prev = [...container.childNodes].filter(
        (node) => !(node.nodeType === Node.ELEMENT_NODE && node.hasAttribute("data-selection-placeholder"))
    );
    const refNodes =
        reference && reference.childNodes.length === prev.length ? [...reference.childNodes] : prev;
    let start = 0;
    while (start < prev.length && start < next.length && sameNode(refNodes[start], next[start])) {
        start++;
    }
    let end = 0;
    while (
        end < prev.length - start &&
        end < next.length - start &&
        sameNode(refNodes[prev.length - 1 - end], next[next.length - 1 - end])
    ) {
        end++;
    }
    const inserted = template.content.ownerDocument.createDocumentFragment();
    inserted.replaceChildren(...next.slice(start, next.length - end));
    sanitizeFragment(inserted);
    const before = end ? prev[prev.length - end] : null;
    for (const node of prev.slice(start, prev.length - end)) {
        node.remove();
    }
    container.insertBefore(inserted, before);
}

/** Parses `html` into an inert fragment and cleans it with `sanitizeFragment`. */
function cleanFragment(doc, html, sanitizeFragment) {
    const template = doc.createElement("template");
    template.innerHTML = html;
    sanitizeFragment(template.content);
    return template.content;
}

function isEmptyFragment(fragment) {
    return !fragment.textContent.trim() && !fragment.querySelector("*");
}

/**
 * `sanitizeFragment` for when there is no editor: DOMPurify via `sanitizeHtml`.
 * Uncleaned HTML never enters the live document: a `template` content is inert,
 * while a `div` of `document` would load an `<img>` and run its `onerror`.
 */
function sanitizeFragmentWithoutEditor(fragment, drops = null, keep = null) {
    const holder = document.createElement("template");
    holder.content.append(fragment.cloneNode(true));
    const clean = sanitizeHtml(holder.innerHTML, drops, keep);
    const template = document.createElement("template");
    template.innerHTML = clean;
    fragment.replaceChildren(...template.content.childNodes);
}

/**
 * The html left in a field without an editor: the current value with only the
 * changed blocks replaced by their clean version. Built inside an inert
 * `template`, never in the live document.
 */
function mergeHtmlWithoutEditor(currentHtml, proposedHtml, drops = null) {
    const template = document.createElement("template");
    template.innerHTML = String(currentHtml || "");
    const keep = loadUrlsIn(template.content);
    replaceChangedChildren(template.content, proposedHtml, (fragment) =>
        sanitizeFragmentWithoutEditor(fragment, drops, keep)
    );
    return template.innerHTML;
}

/** Collapses spaces to compare texts that come from different paths. */
function normalizeText(text) {
    return String(text || "").replace(/[\s\u200b\u00a0]+/g, " ").trim();
}

/** Canonical HTML (re-serialized by the browser) to compare two values. */
function canonicalHtml(html) {
    try {
        const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
        return (doc.body?.innerHTML || "").replace(/>\s+</g, "><").trim();
    } catch {
        return String(html || "");
    }
}

function sameHtml(a, b) {
    return String(a || "") === String(b || "") || canonicalHtml(a) === canonicalHtml(b);
}

const BLOCK_TAGS = new Set([
    "P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6",
    "BLOCKQUOTE", "PRE", "TR", "TABLE", "SECTION", "ARTICLE",
]);

/** Plain text of a fragment, with a line break between blocks. */
function fragmentText(node) {
    let out = "";
    for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
            out += child.textContent;
        } else if (child.nodeName === "BR") {
            out += "\n";
        } else if (child.nodeType === Node.ELEMENT_NODE) {
            out += fragmentText(child);
            if (BLOCK_TAGS.has(child.nodeName)) {
                out += "\n";
            }
        }
    }
    return out;
}

/**
 * Saved selection of an html field editor: the editor keeps it even when the
 * focus moves to the panel. `text` is the selected text (empty for a caret) and
 * `block` the text of the block around the caret. null without an editor.
 */
function readEditorSelection(field) {
    try {
        const selection = field.editor.shared.selection.getEditableSelection();
        if (!selection?.anchorNode || !field.editor.editable.contains(selection.anchorNode)) {
            return null;
        }
        const collapsed = Boolean(selection.isCollapsed);
        const text = collapsed ? "" : fragmentText(selection.cloneContents()).trim();
        const block = closestBlock(selection.anchorNode);
        const blockText =
            block && block !== field.editor.editable ? normalizeText(block.textContent) : "";
        const out = {
            text: text.slice(0, MAX_SELECTION_TEXT),
            collapsed,
            block: blockText.slice(0, MAX_SELECTION_BLOCK),
        };
        if (text.length > MAX_SELECTION_TEXT) {
            // The model only sees the start: replacing it would delete text it never read.
            out.truncated = true;
        }
        return out;
    } catch {
        return null;
    }
}

export const tuquiAssistantService = {
    // `action` is needed to open the standard composer (doAction) from proposeChatter.
    dependencies: ["notification", "orm", "action", "overlay", "menu"],
    start(env, { notification, orm, action, overlay, menu }) {
        // Persist panel UI state across Ctrl+R, per-tab (sessionStorage is tab-scoped).
        // panelOpen / minimized / expanded survive reload; context
        // are ephemeral (rebuilt from the current Odoo view on mount).
        const _SESSION_KEY = "tuqui_panel_state";
        let _savedState = {};
        try {
            _savedState = JSON.parse(sessionStorage.getItem(_SESSION_KEY) || "{}");
        } catch {
            _savedState = {};
        }

        // If another tab had the panel open and the user clicked an external link
        // from the chat (triggering "external-link-opening"), the panel wrote a
        // short-lived signal to localStorage. Consume it here: auto-open the panel
        // so the new tab resumes the conversation. The signal is cleared immediately
        // to avoid affecting unrelated tabs opened later.
        const _OPEN_SIGNAL_KEY = "tuqui_open_signal";
        const _OPEN_SIGNAL_TTL = 5000;
        let _openSignalFresh = false;
        try {
            const raw = localStorage.getItem(_OPEN_SIGNAL_KEY);
            if (raw) {
                localStorage.removeItem(_OPEN_SIGNAL_KEY);
                const signal = JSON.parse(raw);
                if (Date.now() - (signal.at || 0) < _OPEN_SIGNAL_TTL) {
                    _openSignalFresh = true;
                }
            }
        } catch {
            // Private browsing or malformed value — ignore.
        }

        // True only for the FIRST panel mount of this page load: when the session
        // was already active at reload (Ctrl+R with panel open) or when an external-
        // link signal triggered the open. Consumed on first call so a deliberate
        // close → reopen always starts a fresh chat instead of resuming.
        let _resumeOnFirstMount = Boolean(_savedState.panelOpen) || _openSignalFresh;
        function consumeResumeOnOpen() {
            const v = _resumeOnFirstMount;
            _resumeOnFirstMount = false;
            return v;
        }

        const state = proxy({
            panelOpen: Boolean(_savedState.panelOpen) || _openSignalFresh,
            minimized: Boolean(_savedState.minimized),
            expanded: Boolean(_savedState.expanded),
            context: null,
        });

        function _saveState() {
            try {
                sessionStorage.setItem(
                    _SESSION_KEY,
                    JSON.stringify({
                        // Hidden is saved as CLOSED. In this tab hiding keeps the
                        // iframe alive on purpose (a remount spends a second
                        // single-use SSO nonce → 401), but a reload unmounts it
                        // anyway, and coming back up mounting a card the user put
                        // away would spend that nonce on every page load for
                        // nothing. The conversation still comes back: the path is
                        // in localStorage.
                        // The three flags are saved as ONE state, not three
                        // independent ones: `expanded` on a panel saved as
                        // closed is a combination that cannot happen live, and
                        // whoever reads it back has to guess what it meant.
                        panelOpen: state.panelOpen && !state.minimized,
                        minimized: false,
                        expanded: state.panelOpen && !state.minimized && state.expanded,
                    })
                );
            } catch {
                // Private browsing or quota exceeded — silently skip.
            }
        }

        /**
         * What the service asks of whoever holds the page (a form, a line's dialog,
         * a view). Every member is optional: a plain `{}` only holds a context.
         *
         * @typedef {Object} PageOwner
         * @property {() => string} [title] the title on screen, for a record with no
         *   name of its own (a wizard)
         * @property {() => Element|undefined} [arch] the form arch (`archInfo.xmlDoc`)
         *   the record is drawn with: it tells which fields are on screen
         * @property {() => Promise<boolean>} [save] saves the record, when its own
         *   `save()` is not how the screen saves it (a line saves through its dialog)
         * @property {() => Promise<Object|undefined>} [reload] reads the data again;
         *   resolves to the record on screen when the reload replaced it
         */

        // The page and the pages under it, as { owner, record, context,
        // reloadOnReturn }. The last
        // entry is the page: `activeRecord` and `state.context` are its record and
        // context. An entry below sits under a dialog (the mail composer over a
        // form) and gets the page back when the dialog closes. Non-reactive: the
        // records are model objects, not UI state.
        let activeRecord = null;
        let _pages = [];

        /** The page's entry, or null on a screen without one (home, settings…). */
        function _page() {
            return _pages.at(-1) || null;
        }

        /** Whether `owner` may update the page: no owner means the caller does not care. */
        function _isPageOwner(owner) {
            return !owner || _page()?.owner === owner;
        }

        // --- Contexto vivo: revisión + snapshots ---------------------------------
        // `_revision` es un contador monotónico del contexto de formulario. Sube
        // cuando cambia el record publicado y cuando los valores EN MEMORIA cambian
        // (on-blur, debounced desde quien tiene la página). Viaja en el payload y vuelve
        // en la propuesta como `baseRevision`: con eso sabemos sobre qué valores
        // razonó el assistant y detectamos conflicto en vez de pisar en silencio.
        let _revision = 0;
        // Firma de los últimos valores publicados: evita re-publicar (y quemar una
        // revisión) cuando el usuario sale de un campo sin haber editado nada.
        let _lastFieldsSig = null;
        // Snapshots de lo publicado, por revisión. Ring chico: el SPA propone sobre
        // la última revisión o una muy cercana; guardar más es memoria al pedo.
        const _MAX_SNAPSHOTS = 10;
        const _snapshots = new Map();

        // Last form field that had the focus. It survives the focus moving to the
        // panel: the person clicks the field and then talks to the assistant.
        let _lastFocus = null;

        /**
         * JSON signature of the in-memory values (and of the focus), or null if
         * it cannot be serialized. The focus is included so that moving to another
         * field or selecting text publishes the context again when leaving it.
         */
        function _fieldsSignature(record) {
            if (!record) {
                return null;
            }
            try {
                return JSON.stringify([serializeRecordFields(record), _serializeFocus(record)]);
            } catch {
                return null;
            }
        }

        /** Called by the page's owner on each `focusin` on a field. */
        function noteFocusedField(owner, fieldName) {
            if (!activeRecord || !_isPageOwner(owner) || !fieldName) {
                return;
            }
            if (!activeRecord.fields?.[fieldName]) {
                return;
            }
            _lastFocus = { record: activeRecord, field: fieldName };
        }

        function _serializeFocus(record) {
            if (!_lastFocus || _lastFocus.record !== record) {
                return null;
            }
            const name = _lastFocus.field;
            const type = record.fields?.[name]?.type;
            if (!type) {
                return null;
            }
            const focus = { field: name, type };
            if (type === "html") {
                const field = getMountedHtmlField(record, name);
                const selection = field && readEditorSelection(field);
                if (selection) {
                    focus.selection = selection;
                }
            }
            return focus;
        }

        /** Html fields the person has in front of them in the form. */
        function _htmlFieldNames(record, hidden) {
            const fields = record.fields || {};
            return Object.keys(record.activeFields || {}).filter((name) => {
                if (fields[name]?.type !== "html" || name.startsWith("x_dynamic_message")) {
                    return false;
                }
                if (hidden.has(name)) {
                    return false;
                }
                try {
                    return !record._isInvisible?.(name) && !record._isReadonly?.(name);
                } catch {
                    return true;
                }
            });
        }

        function _rememberSnapshot(revision, fields) {
            _snapshots.set(revision, fields);
            while (_snapshots.size > _MAX_SNAPSHOTS) {
                _snapshots.delete(_snapshots.keys().next().value);
            }
        }

        /** The title on screen for the page (the dialog's title, or the action's name). */
        function _pageTitle() {
            try {
                return _page()?.owner.title?.() || "";
            } catch {
                return "";
            }
        }

        /** The form arch the page's record is drawn with. */
        function _pageArch() {
            return _page()?.owner.arch?.();
        }

        /** The record's own name; Odoo's stand-in for a model without one ("model,id") is not a name. */
        function _ownName(record) {
            const name = record.data?.display_name || record.data?.name || "";
            return name === `${record.resModel},${record.resId}` ? "" : name;
        }

        /**
         * Whether `record` is a one2many line: saving it puts it into the record of
         * the form below, which the user still has to save. Odoo gives every x2many
         * record a parent; only a line keeps the inverse field to it
         * (`relationField`), and a many2many record saves to the database.
         */
        function _isLine(record) {
            return Boolean(record?._parentRecord && record.config?.relationField);
        }

        function _makeRecordContext(record) {
            const context = {
                kind: "record",
                model: record.resModel,
                resId: record.resId,
                // A wizard (the mail composer, the SMS confirmation of a delivery) has no
                // name of its own, saved or not: the title the person reads is the dialog's.
                displayName: _ownName(record) || _pageTitle(),
                dirty: Boolean(record.dirty),
                revision: _revision,
            };
            if (_isLine(record)) {
                const parent = record._parentRecord;
                context.lineOf = { model: parent.resModel, resId: parent.resId, displayName: _ownName(parent) };
            }
            return context;
        }

        /**
         * Writes `owner`'s entry and says whether it is the page. A new owner (a
         * dialog opening over a form) goes on top. An owner below the page is under
         * a dialog: its entry is refreshed and the page stays the dialog's (a form
         * that a dialog's "Save & New" makes dirty, a calendar after a quick create).
         */
        function _takesPage(owner, record, context) {
            let entry = _pages.find((e) => e.owner === owner);
            if (!entry) {
                entry = { owner };
                _pages.push(entry);
            }
            Object.assign(entry, { record, context });
            return entry === _page();
        }

        function setRecordContext(owner, record) {
            // A record below the page gets its context rebuilt when it comes back.
            if (!_takesPage(owner, record || null, null)) {
                return;
            }
            // Another record in the same form: OWL reuses the nodes, so the mark would
            // stay up on the new record's control.
            if (activeRecord && record && (activeRecord.resModel !== record.resModel || activeRecord.resId !== record.resId)) {
                hideGota();
            }
            activeRecord = record || null;
            // Record nuevo → revisión nueva, y la firma arranca de sus valores
            // actuales (un focusout inmediato sin edición no debe re-publicar).
            _revision += 1;
            _lastFieldsSig = _fieldsSignature(activeRecord);
            state.context = record ? _makeRecordContext(record) : null;
        }

        /**
         * Re-publica el contexto del form si los valores EN MEMORIA cambiaron.
         * La llaman el form y el diálogo de un x2many al salir de un campo
         * (`focusout`, debounced, `useRecordContextListeners`):
         * el assistant tiene que ver lo que el usuario está escribiendo sin guardar,
         * pero sin una revisión por tecla — eso infla el contexto de cada turno
         * (costo de LLM y ruido) sin agregar valor.
         *
         * No-op si no hay form abierto, si el llamador no tiene la página (p.ej. el
         * form de abajo mientras hay un diálogo arriba) o si nada cambió.
         *
         * @param {PageOwner} [owner] quien llama; si no tiene la página, no hace nada
         * @returns {boolean} true si publicó una revisión nueva
         */
        function refreshRecordContext(owner) {
            if (!activeRecord || !_isPageOwner(owner)) {
                return false;
            }
            const sig = _fieldsSignature(activeRecord);
            if (sig === null || sig === _lastFieldsSig) {
                return false;
            }
            _lastFieldsSig = sig;
            _revision += 1;
            state.context = _makeRecordContext(activeRecord);
            return true;
        }

        /**
         * The selection a list adds to its view, or null when nothing is ticked.
         *
         * Ticking rows (some, or "select all N") is the explicit gesture to act on
         * a set, so only then the set travels: every id, or the domain for "select
         * all". Tuqui keeps a long list out of the prompt and hands it over through
         * `odoo_get_selected_ids`, so a cap here would only turn a whole selection
         * into a partial one.
         */
        function _selectionContext({ model, modelLabel, domain }, { resIds = [], isDomainSelected, count }) {
            const selection = { kind: "selection", model, modelLabel };
            if (isDomainSelected) {
                return { ...selection, count, resIds: [], allMatching: true, domain: domain || [] };
            }
            if (resIds.length) {
                return {
                    ...selection,
                    count: resIds.length,
                    resIds,
                };
            }
            return null;
        }

        /**
         * Context for every view but the form (list, kanban, pivot, graph,
         * calendar, custom view types). `payload`:
         *   { model, modelLabel, viewType, jsClass, domain, groupBy, filters,
         *     context?, range?, resIds?, isDomainSelected?, count? }
         * `modelLabel` is the model as the user reads it (the action's breadcrumb,
         * "Contactos"); `context` holds the view keys of its favorite context
         * (`pivot_*`, `graph_*`, …); `range` {start, end} is the dates a calendar
         * shows. A list or a kanban with records ticked becomes a selection
         * (`_selectionContext`).
         *
         * Takes the page like `setRecordContext` (`_takesPage`): switching views in
         * one action can mount the new view before the old one unmounts, and the old
         * one's `clearContext` then only drops its entry below the page.
         */
        function setViewContext(owner, { resIds, isDomainSelected, count, ...view }) {
            view.modelLabel ||= "";
            const context = _selectionContext(view, { resIds, isDomainSelected, count }) || { kind: "view", ...view };
            // One gesture fires several sources (the search, then the data model):
            // the same state is written once.
            const entry = _pages.find((e) => e.owner === owner);
            if (entry?.context && JSON.stringify(entry.context) === JSON.stringify(context)) {
                return;
            }
            if (!_takesPage(owner, null, context)) {
                return;
            }
            activeRecord = null;
            state.context = context;
        }

        /** `owner` lets the page go: the entry below it, if any, gets it back. */
        function clearContext(owner) {
            if (!owner) {
                // No owner (legacy / manual call): clear everything.
                _pages = [];
                activeRecord = null;
                state.context = null;
                return;
            }
            const wasPage = _page()?.owner === owner;
            // An owner that unmounts under a dialog leaves too: closing the dialog
            // must not give the page back to a dead component.
            _pages = _pages.filter((e) => e.owner !== owner);
            if (!wasPage) {
                return;
            }
            const back = _page();
            activeRecord = back?.record || null;
            if (!back) {
                state.context = null;
                return;
            }
            // Volver al form de abajo es contexto nuevo para el SPA: revisión
            // nueva y firma re-sincronizada con lo que el record tiene AHORA
            // (el diálogo pudo haberlo cambiado).
            _revision += 1;
            _lastFieldsSig = _fieldsSignature(back.record);
            // Re-build from the live record so dirty reflects current state.
            state.context = back.record ? _makeRecordContext(back.record) : back.context;
            if (back.reloadOnReturn) {
                back.reloadOnReturn = false;
                // After the dialog's unmount: the reload renders the form again.
                Promise.resolve().then(reloadView);
            }
        }


        // The systray icon is a SWITCH: it shows the panel, and if the panel is
        // already in front of you it puts it away. It used to always open a new
        // chat (CTO item #4), which made the icon the one control that could
        // destroy what you were reading — and with the bubble gone it is also the
        // only way back, so it has to be able to bring the conversation back
        // untouched. Starting a new chat lives inside the panel, where the rest
        // of the conversation controls are.
        //
        // Never remounts the iframe while the panel is open: a remount would
        // spend a second single-use SSO nonce → 401. Hiding is CSS only.
        function toggleVisibility() {
            if (!state.panelOpen) {
                state.panelOpen = true;
                state.minimized = false;
            } else {
                state.minimized = !state.minimized;
            }
            _saveState();
        }

        // Hide / show the card. Does NOT close the panel: the iframe stays mounted
        // (the card is hidden via CSS, not unmounted) — a remount would spend a
        // second single-use SSO nonce → 401. See panel.xml.
        function minimize() {
            state.minimized = true;
            _saveState();
        }
        function restore() {
            state.minimized = false;
            _saveState();
        }
        // Takes the panel down for real, like closing one of Odoo's chat windows:
        // the iframe unmounts and the next open starts a new chat (see
        // consumeResumeOnOpen). Minimizing is what keeps the conversation.
        function close() {
            state.panelOpen = false;
            state.minimized = false;
            state.expanded = false;
            _saveState();
        }
        function expand() {
            state.expanded = true;
            _saveState();
        }
        function contract() {
            state.expanded = false;
            _saveState();
        }

        /**
         * SSO embebido: mintea un nonce single-use atado
         * al usuario Odoo logueado y devuelve { nonce, client_id } para pasárselo
         * al iframe. El SPA lo canjea contra Tuqui por un token de sesión corto,
         * así no hay login dentro del iframe. Devuelve null si el companion no
         * está activado (sin client_id) → el SPA muestra "usuario no vinculado".
         */
        async function getSsoAuth() {
            try {
                return await orm.call("tuqui.assistant.sso.nonce", "issue_for_current_user", []);
            } catch {
                return null;
            }
        }

        /**
         * Bootstrap del embed resuelto desde companion: devuelve
         * `{ connected, base_url, slug }`. La base sale de `tuqui.base_url`
         * (default tuqui.com) y el slug del workspace activado en el oauth client
         * — ya no hay `tuqui_assistant.spa_url`. Lee vía un método sudo porque
         * `tuqui.oauth.client` es admin-only.
         */
        async function getEmbedBootstrap() {
            try {
                return await orm.call("tuqui.assistant.sso.nonce", "embed_bootstrap", []);
            } catch {
                return { connected: false, base_url: null, slug: null };
            }
        }

        /** What the person can touch on screen right now, with the element behind each id. */
        function readScreen() {
            const { targets, elements } = readTargets();
            const xmlDoc = _pageArch();
            let hidden = null;
            for (const target of targets) {
                const tab = target.role === "tab" && elements.get(target.id);
                if (tab && !hidden) {
                    hidden = camposOcultosSegunElArch(xmlDoc, activeRecord);
                }
                const contents = tab ? tabContents(xmlDoc, activeRecord, tab, hidden) : [];
                if (contents.length) {
                    target.contains = contents;
                }
            }
            return { targets, elements };
        }

        /** The page context plus the screen's targets. */
        function getContextPayload(screen = readScreen()) {
            return { ...pageContextPayload(), targets: screen.targets };
        }

        /** Make `screen` the list `point` resolves ids against: the one the chat was sent. */
        function rememberScreen(screen) {
            rememberTargets(screen.elements);
        }

        /**
         * Registers this copy as a test database. Only when the panel opens: it
         * waits on Tuqui, which a page load must not.
         */
        async function registerTestCopy() {
            try {
                return await orm.call("tuqui.assistant.sso.nonce", "register_test_copy", []);
            } catch {
                return { status: "failed" };
            }
        }

        /**
         * Contexto a mandarle al SPA (PageContext). Para "record" incluye los
         * valores en memoria (`fields`, escalares por tipo; con cambios sin guardar).
         * Para "selection"/"view" manda ids/dominio/count — NO las filas (guard
         * de tamaño): el detalle lo pide Tuqui por el gateway si lo necesita.
         *
         * CRÍTICO: el resultado se manda por `postMessage`, que serializa con el
         * structured clone algorithm — y ese algoritmo NO puede clonar Proxies.
         * `state.context` es `reactive(...)`, así que sus valores ANIDADOS
         * (`domain`, `filters`, `resIds`) son arrays Proxy: un `{...state.context}`
         * los copia tal cual (siguen siendo Proxy) y `postMessage` tira
         * `DataCloneError`. El form no lo sufría porque su `fields` se reconstruye
         * como objeto plano (serializeRecordFields) y el resto son escalares — pero
         * list/selection mandaban arrays reactivos y el `postMessage` reventaba en
         * silencio (el catch de `_postContext`), así que NUNCA llegaba el contexto
         * de lista/kanban al SPA. Devolvemos un objeto PLANO (deep copy) para que
         * cualquier estructura reactiva quede aplanada, sin importar el `kind`.
         */
        function pageContextPayload() {
            if (!state.context) {
                // Sin registro/lista abiertos (home, dashboard, settings…): NO
                // devolvemos null. Un sentinel {kind:"none"} hace que el SPA mande
                // SIEMPRE un odoo_context, así el backend trata el turno como embed
                // y expone open_odoo_view (navegar desde el home). Ver _build_odoo_
                // context_note (rama kind=="none") y el panel (_postContext on open).
                const none = { kind: "none" };
                const company = companyInPlay();
                if (company) {
                    none.company = company;
                }
                return none;
            }
            const ctx = { ...state.context };
            const company = companyInPlay();
            if (company) {
                ctx.company = company;
            }
            if (ctx.kind === "record" && activeRecord) {
                ctx.dirty = Boolean(activeRecord.dirty);
                // Qué se ve, qué se puede escribir y qué es obligatorio. Sin esto
                // el asistente conoce los valores pero no la pantalla.
                //
                // VA ANTES DE `fields`, Y ES A PROPÓSITO. El consumidor serializa
                // este objeto entero y lo CORTA en 8000 caracteres (`prompts.py`,
                // `payload_truncated`). En un account.move o un sale.order los
                // valores solos se acercan a ese tope, así que la última clave es
                // la primera en desaparecer — y sería justo el estado, que es lo
                // único que no se puede reconstruir del otro lado. Puesto antes,
                // lo que se pierde es la cola de los VALORES, igual que antes de
                // que este mapa existiera. Ocupa poco: sólo viajan las
                // excepciones.
                const ocultos = camposOcultosSegunElArch(_pageArch(), activeRecord);
                ctx.fieldState = serializeFieldState(activeRecord, ocultos);
                // Sólo viaja la excepción: si el mapa NO es confiable se dice, y
                // del otro lado el prompt deja de leer "ausente" como "normal".
                if (!evaluadoresDisponibles(activeRecord)) {
                    ctx.fieldStateUnavailable = true;
                }
                ctx.htmlFields = _htmlFieldNames(activeRecord, ocultos);
                const focus = _serializeFocus(activeRecord);
                if (focus) {
                    ctx.focus = focus;
                }
                ctx.fields = serializeRecordFields(activeRecord);
            }
            // Aplanar a JSON puro: arranca los Proxies reactivos (domain/filters/
            // resIds) que romperían el structured clone de postMessage. Los datos
            // que llevan son JSON-safe (arrays/strings/números/booleanos), así que
            // un round-trip por JSON es seguro y suficiente.
            try {
                const flat = JSON.parse(JSON.stringify(ctx));
                if (flat.kind === "record" && flat.fields) {
                    // Guardamos EXACTAMENTE lo que ve el SPA en esta revisión: es la
                    // base contra la que `applyProposal` mide el conflicto cuando la
                    // propuesta vuelve con su `baseRevision`.
                    _rememberSnapshot(flat.revision, flat.fields);
                }
                return flat;
            } catch {
                // Defensa: si algo no fuese serializable, devolvé al menos la
                // identidad mínima en vez de nada (mejor contexto parcial que cero).
                return { kind: ctx.kind, model: ctx.model };
            }
        }

        // Last html the assistant applied, per field. Its next proposal in the same
        // turn comes with that html as `htmlBase`, while the field holds the
        // editor-normalized version of it.
        let _lastAppliedHtml = null;

        function _rememberAppliedHtml(name, proposed) {
            if (!_lastAppliedHtml || _lastAppliedHtml.record !== activeRecord) {
                _lastAppliedHtml = { record: activeRecord, byField: {} };
            }
            _lastAppliedHtml.byField[name] = {
                proposed,
                live: liveHtmlValue(activeRecord, name),
            };
        }

        /**
         * Is `base` what the field holds now? The on-screen value counts, and so
         * does the last html the assistant applied, as long as the person has not
         * touched the field since then.
         */
        function _htmlBaseMatches(name, base) {
            const live = liveHtmlValue(activeRecord, name);
            if (sameHtml(live, base)) {
                return true;
            }
            const applied =
                _lastAppliedHtml?.record === activeRecord && _lastAppliedHtml.byField[name];
            return Boolean(applied && sameHtml(applied.proposed, base) && sameHtml(applied.live, live));
        }

        /**
         * `drops.count`, when given, adds what `dropCrossOriginLoads` removed.
         * What the editor loads when this is called may stay (see `loadUrlsIn`).
         */
        function _editorSanitizer(editor, drops = null) {
            const keep = loadUrlsIn(editor.editable);
            return (fragment) => {
                editor.shared.sanitize.sanitize(fragment);
                const removed = dropCrossOriginLoads(fragment, keep);
                if (drops) {
                    drops.count += removed;
                }
            };
        }

        /**
         * Replaces the content of an html editor inside its history (Ctrl+Z
         * undoes it) and makes the HtmlField pass it to the record (dirty form).
         */
        async function _applyHtmlThroughEditor(field, html, drops = null) {
            const editor = field.editor;
            let reference = null;
            try {
                reference = editor.getElContent();
            } catch {
                // Compare against the live DOM.
            }
            replaceChangedChildren(editor.editable, html, _editorSanitizer(editor, drops), reference);
            editor.shared.history.commit();
            await field.commitChanges();
        }

        /**
         * Replaces the saved selection of the `field` editor with `html`, like
         * the native Odoo AI: only if the selected text is still what the model
         * saw (`expectedText`).
         */
        async function _applySelectionProposal(selection) {
            const notes = [];
            const say = (text, type = "warning") => {
                notes.push(text);
                notification.add(text, { type });
            };
            // Whole-proposal reasons go in `reason`; per-field ones in `skipped`.
            const reject = (reason, text, type) => {
                say(text, type);
                return proposalResult({ notes, reason });
            };
            const skip = (fieldName, reason, text) => {
                say(text);
                return proposalResult({ notes, skipped: [{ field: fieldName || "", reason }] });
            };
            const { field: name, html, expectedText } = selection || {};
            const field = name && getMountedHtmlField(activeRecord, name);
            if (!field) {
                return skip(
                    name,
                    "not_in_form",
                    _t("Could not replace the selection: the field %s is not open for editing.", name || "?")
                );
            }
            const editor = field.editor;
            const current = readEditorSelection(field);
            if (current?.truncated) {
                return reject(
                    "selection_too_long",
                    _t("Not applied: the selection is too long to replace from the assistant. Select a smaller part.")
                );
            }
            if (!current || current.collapsed || normalizeText(current.text) !== normalizeText(expectedText)) {
                return reject(
                    "selection_changed",
                    _t("Not applied: the selected text changed. Select it again and ask again.")
                );
            }
            let clean = null;
            const drops = { count: 0 };
            try {
                clean = cleanFragment(
                    editor.document,
                    typeof html === "string" ? html : "",
                    _editorSanitizer(editor, drops)
                );
            } catch {
                // Treated as empty below.
            }
            if (!clean || isEmptyFragment(clean)) {
                if (drops.count) {
                    say(droppedLoadsNote(drops.count));
                }
                return skip(
                    name,
                    "sanitized_empty",
                    _t("Could not replace the selection: nothing is left of the proposal once cleaned.")
                );
            }
            try {
                editor.shared.dom.insert(clean);
                editor.shared.history.commit();
                await field.commitChanges();
            } catch (e) {
                refreshRecordContext();
                return reject("error", _t("Could not apply changes: %s", e.message || e), "danger");
            }
            refreshRecordContext();
            if (drops.count) {
                say(droppedLoadsNote(drops.count));
            }
            const done = _t("Selection replaced in the form (unsaved). Review and Save or Discard.");
            notes.push(done);
            notification.add(done, { type: "success" });
            return proposalResult({ applied: [name], notes });
        }

        /**
         * Applies a proposal to the open form. A `selection` proposal goes first;
         * if it does not apply, nothing else of the same payload is applied.
         */
        async function applyProposal(changes, options) {
            const hasChanges = changes && typeof changes === "object" && Object.keys(changes).length > 0;
            if (!options?.selection) {
                return _applyFormChanges(changes, options);
            }
            if (!activeRecord || isOtherRecord(options.target, activeRecord.resModel, activeRecord.resId)) {
                // Same whole-proposal rejection as any other apply.
                return _applyFormChanges({}, options);
            }
            const selectionResult = await _applySelectionProposal(options.selection);
            if (selectionResult.status !== "applied" || !hasChanges) {
                return selectionResult;
            }
            const rest = await _applyFormChanges(changes, options);
            return {
                ...rest,
                status: rest.status === "applied" ? "applied" : "partial",
                applied: [...selectionResult.applied, ...rest.applied],
                message: [selectionResult.message, rest.message].filter(Boolean).join(" "),
            };
        }

        /**
         * Aplica una propuesta { campo: valor, ... } al form abierto, en memoria.
         * Requiere modo "record" (hay activeRecord). Origen: panel (fallback) o
         * iframe del SPA (tool propose_odoo_form_changes vía postMessage).
         *
         * Returns `{status, applied, skipped, message}` (see `proposalResult`):
         * every toast shown is also part of `message`.
         */
        async function _applyFormChanges(changes, options) {
            const notes = [];
            const warn = (text, type = "warning") => {
                notes.push(text);
                notification.add(text, { type });
            };
            const isObject = changes && typeof changes === "object" && !Array.isArray(changes);
            // The whole-proposal reason rides in `reason`; `skipped` stays for per-field ones.
            const rejectAll = (reason) => proposalResult({ notes, reason });
            if (!activeRecord) {
                warn(_t("Open a form (1 record) to apply changes from here."));
                return rejectAll("no_record");
            }
            // A proposal computed for another record (the person navigated meanwhile).
            if (isOtherRecord(options?.target, activeRecord.resModel, activeRecord.resId)) {
                warn(_t("Not applied: the proposal was for another record. Go back to it and ask again."));
                return rejectAll("other_record");
            }
            if (!isObject) {
                warn(_t("The proposal must be an object { field: value }."), "danger");
                return rejectAll("invalid_proposal");
            }
            const skipped = [];
            // Validar contra los campos del form: descartar inexistentes / readonly
            // antes de _update. Una propuesta con campos ajenos (p.ej. {email_from,
            // subject} sobre un res.partner) reventaba _update con un error JS sin
            // atrapar; ahora se ignoran y, si no queda nada válido, se avisa y corta.
            const fieldDefs = activeRecord.fields || {};
            const enPantalla = activeRecord.activeFields || {};
            // Un campo que el arch deja fuera de la pantalla está igual en
            // `activeFields`: escribirlo deja un cambio que la persona no puede
            // ver ni revisar antes de guardar, igual que un campo de otra vista.
            const ocultosSegunElArch = camposOcultosSegunElArch(_pageArch(), activeRecord);
            const known = {};
            const dropped = [];
            for (const [name, value] of Object.entries(changes)) {
                // Primero que el campo EXISTA Y ESTÉ EN ESTE FORMULARIO. Son dos
                // conjuntos distintos: `fields` es el fields_get de TODAS las
                // vistas de la acción —lista y buscador incluidos— así que trae
                // campos que este form no muestra. Escribir uno de esos deja un
                // cambio que la persona no puede ver ni revisar antes de guardar,
                // que es exactamente lo que este chequeo existe para evitar.
                //
                // Y es lo mismo que hacía reventar al evaluador de abajo: lee
                // `activeFields[campo]` sin chequear que exista, tiraba TypeError,
                // el catch lo tapaba y el chequeo caía al readonly ESTÁTICO justo
                // en los campos que no están en pantalla.
                // El `invisible` PROPIO del campo cuenta igual que el del grupo
                // que lo contiene: en los dos casos la persona no lo tiene
                // delante, y escribirlo deja un cambio que no puede revisar. El
                // arch resuelve los dos; se le pregunta igual al evaluador de
                // Odoo, que es el único que ve lo que no salió del arch de este
                // formulario (el `invisible` que hereda un x2many, por ejemplo).
                let fueraDeLaVista = ocultosSegunElArch.has(name);
                try {
                    fueraDeLaVista = fueraDeLaVista || Boolean(activeRecord._isInvisible?.(name));
                } catch {
                    // Un campo que no se puede evaluar no se descarta por eso.
                }
                if (!fieldDefs[name] || !(name in enPantalla) || fueraDeLaVista) {
                    dropped.push(name);
                    skipped.push({ field: name, reason: "not_in_form" });
                    continue;
                }
                // El readonly se pregunta EVALUADO contra este registro, no en la
                // definición del campo. La mitad de los readonly de Odoo son
                // condicionales —"sólo lectura si el pedido está confirmado"— y la
                // definición estática los da como editables: la propuesta pasaba el
                // filtro y `_update` la aplicaba sobre un campo que la persona no
                // puede tocar. Se cae al chequeo estático si el método no está.
                let soloLectura = fieldDefs[name].readonly === true;
                try {
                    if (activeRecord._isReadonly) {
                        soloLectura = activeRecord._isReadonly(name);
                    }
                } catch {
                    // Queda el chequeo estático.
                }
                if (soloLectura) {
                    dropped.push(name);
                    skipped.push({ field: name, reason: "readonly" });
                } else {
                    known[name] = value;
                }
            }
            if (dropped.length) {
                warn(_t("Skipped fields that cannot be edited in this form: %s", dropped.join(", ")));
            }
            // Conflicto de contexto vivo: la propuesta razonó sobre los valores de
            // `baseRevision`. Si el usuario cambió alguno de esos campos DESPUÉS, no
            // lo pisamos en silencio — lo sacamos de la propuesta y lo decimos, para
            // que vuelva a pedir sobre el valor actual. Sin `baseRevision` (SPA viejo)
            // o con la revisión ya fuera del ring, no hay contra qué comparar: se
            // aplica como antes.
            const baseRevision = options?.baseRevision;
            const htmlBase = options?.htmlBase && typeof options.htmlBase === "object" ? options.htmlBase : {};
            const stale = [];
            if (typeof baseRevision === "number" && _snapshots.has(baseRevision)) {
                const snapshot = _snapshots.get(baseRevision);
                const current = serializeRecordFields(activeRecord);
                for (const name of Object.keys(known)) {
                    if (!(name in snapshot)) {
                        continue; // no viajó en ese contexto: nada con qué comparar
                    }
                    if (fieldDefs[name]?.type === "html" && name in htmlBase) {
                        // Its own base is more precise (and survives a chain of edits in one turn).
                        continue;
                    }
                    if (JSON.stringify(current[name]) !== JSON.stringify(snapshot[name])) {
                        stale.push(name);
                    }
                }
            }
            for (const name of stale) {
                delete known[name];
                skipped.push({ field: name, reason: "changed_by_user" });
            }
            if (stale.length) {
                warn(
                    _t(
                        "Not applied because you changed them after the proposal: %s. Ask again to work on the current value.",
                        stale.join(", ")
                    )
                );
                if (!Object.keys(known).length) {
                    // Todo lo propuesto quedó obsoleto. Ya dijimos por qué; el
                    // mensaje genérico de abajo ("ningún campo aplica al form")
                    // sería falso — los campos aplican, el valor cambió.
                    return proposalResult({ skipped, notes });
                }
            }
            if (!Object.keys(known).length) {
                warn(_t("No field from the proposal can be applied to the open form."));
                return proposalResult({ skipped, notes });
            }
            // Html fields: always cleaned, compared against the base Tuqui used
            // for the edit (`htmlBase`) and, with a mounted editor, applied
            // through it (see `_applyHtmlThroughEditor`).
            const htmlThroughEditor = {};
            const proposedHtml = {};
            const htmlConflicts = [];
            const htmlEmptied = [];
            // What the same-origin filter removed from the html actually inserted.
            const drops = { count: 0 };
            // What it removed from the proposals left empty.
            const emptiedDrops = { count: 0 };
            for (const name of Object.keys(known)) {
                if (fieldDefs[name]?.type !== "html") {
                    continue;
                }
                if (name in htmlBase && !_htmlBaseMatches(name, htmlBase[name])) {
                    htmlConflicts.push(fieldDefs[name].string || name);
                    skipped.push({ field: name, reason: "changed_by_user" });
                    delete known[name];
                    continue;
                }
                const raw = known[name] ? String(known[name]) : "";
                const field = getMountedHtmlField(activeRecord, name);
                // Cleaning happens node by node when applying; this only catches a
                // proposal that cleaning would empty (the field would be wiped).
                let emptied = false;
                const emptyDrops = { count: 0 };
                if (raw.trim()) {
                    try {
                        emptied = isEmptyFragment(
                            field
                                ? cleanFragment(
                                      field.editor.document,
                                      raw,
                                      _editorSanitizer(field.editor, emptyDrops)
                                  )
                                : cleanFragment(document, raw, (fragment) =>
                                      sanitizeFragmentWithoutEditor(
                                          fragment,
                                          emptyDrops,
                                          loadUrlsIn(liveHtmlValue(activeRecord, name))
                                      )
                                  )
                        );
                    } catch {
                        emptied = true;
                    }
                }
                if (emptied) {
                    // Only to say why: nothing of it is applied.
                    emptiedDrops.count += emptyDrops.count;
                    htmlEmptied.push(fieldDefs[name].string || name);
                    skipped.push({ field: name, reason: "sanitized_empty" });
                    delete known[name];
                    continue;
                }
                proposedHtml[name] = raw;
                if (field) {
                    htmlThroughEditor[name] = { field, html: raw };
                    delete known[name];
                } else {
                    known[name] = mergeHtmlWithoutEditor(liveHtmlValue(activeRecord, name), raw, drops);
                }
            }
            if (htmlEmptied.length) {
                warn(
                    _t(
                        "Not applied: nothing is left of the proposal for %s once cleaned. Ask again.",
                        htmlEmptied.join(", ")
                    )
                );
                if (emptiedDrops.count) {
                    warn(droppedLoadsNote(emptiedDrops.count));
                }
            }
            if (htmlConflicts.length) {
                warn(
                    _t(
                        "Not applied: %s changed while the assistant was editing it. Ask again to work on the current value.",
                        htmlConflicts.join(", ")
                    )
                );
            }
            if (!Object.keys(known).length && !Object.keys(htmlThroughEditor).length) {
                if (!htmlConflicts.length && !htmlEmptied.length) {
                    warn(_t("No field from the proposal can be applied to the open form."));
                }
                return proposalResult({ skipped, notes });
            }
            // Normalizar x2many a tuplas-comando web: el LLM suele mandar la forma
            // amigable `[{product_id:1,…}]` (lista de objetos planos), pero
            // `record._update` → `StaticList._applyCommands` SOLO entiende
            // `[[0,false,{…}]]` (CREATE). Un objeto plano es un NO-OP silencioso
            // (no matchea ningún case, sin `default`) → la línea nunca se agrega y
            // `_update` igual resuelve "ok". Toleramos AMBAS formas. Ver helpers arriba.
            const normalized = normalizeProposalX2many(known, fieldDefs);
            // Coerce las vals de cada comando CREATE/UPDATE: los m2o pelados (id
            // entero) a `{id}` — si no, la línea nueva queda SIN el m2o (p.ej. sin
            // producto) y el onchange no calcula name/precio/totales — y las fechas
            // a Luxon, que si no revientan el render igual que en el record padre.
            // Las defs del sub-modelo salen del StaticList vivo del x2many (`.fields`).
            const unparsedLineDates = [];
            for (const [name, value] of Object.entries(normalized)) {
                const type = fieldDefs[name]?.type;
                if (type === "one2many" || type === "many2many") {
                    const subFields = activeRecord.data?.[name]?.fields;
                    normalized[name] = coerceX2manyCommandVals(value, subFields, unparsedLineDates);
                }
            }
            if (unparsedLineDates.length) {
                for (const name of new Set(unparsedLineDates)) {
                    skipped.push({ field: name, reason: "invalid_date" });
                }
                warn(
                    _t(
                        "Could not read the date for these line fields: %s. The lines go in without them.",
                        [...new Set(unparsedLineDates)].join(", ")
                    )
                );
            }
            // Las líneas NUEVAS (comando CREATE) NO se aplican con
            // `_update({campo:[[0,false,vals]]})`: por ese camino la línea se crea
            // pero su ONCHANGE no dispara → queda sin name/precio (p.ej. producto en
            // blanco) — verificado en runtime. Se aplican aparte con
            // `list.addNewRecord()` + `line._update(campo)` (lo que hace la grilla al
            // elegir un producto: dispara el onchange de la línea y resuelve
            // name/precio/totales). Separamos CREATE del resto (UPDATE/DELETE/LINK),
            // que sí van bien por `_update`.
            const updatePayload = {};
            const createsByField = {}; // { campo: [vals, …] }
            const unparsedDates = [];
            for (const [name, value] of Object.entries(normalized)) {
                const type = fieldDefs[name]?.type;
                if (type === "one2many" || type === "many2many") {
                    const { creates, rest } = splitX2manyCreates(value);
                    // Una línea cuyas vals quedaron VACÍAS tras descartar lo
                    // ilegible no es una línea: agregarla mete una fila en blanco
                    // en la grilla y encima el guard de crecimiento la da por
                    // buena. Si no quedó nada que poner, no hay línea que crear.
                    const usable = creates.filter((v) => v && Object.keys(v).length);
                    if (usable.length) {
                        createsByField[name] = usable;
                    }
                    // Solo mandamos por _update el resto si quedó algún comando.
                    if (Array.isArray(rest) ? rest.length : rest != null) {
                        updatePayload[name] = rest;
                    }
                    if (!usable.length && !(name in updatePayload)) {
                        skipped.push({ field: name, reason: "empty_lines" });
                    }
                } else if (type === "many2one" && typeof value === "number" && value > 0) {
                    // Wrap bare integer IDs for many2one fields so OWL resolves the
                    // display_name. Passing a raw integer leaves the field visually
                    // empty even though the ID is set.
                    updatePayload[name] = { id: value };
                } else if (type === "date" || type === "datetime") {
                    // El modelo OWL guarda fechas como Luxon; un string crudo revienta
                    // el render del form entero. Ver `coerceDateValue`.
                    const parsed = coerceDateValue(value, type);
                    if (parsed === null) {
                        unparsedDates.push(name);
                        skipped.push({ field: name, reason: "invalid_date" });
                    } else {
                        updatePayload[name] = parsed;
                    }
                } else {
                    updatePayload[name] = value;
                }
            }
            if (unparsedDates.length) {
                warn(
                    _t(
                        "Could not read the date for: %s. Ask again with a date like 2026-09-30.",
                        unparsedDates.join(", ")
                    )
                );
            }
            if (
                !Object.keys(updatePayload).length &&
                !Object.keys(createsByField).length &&
                !Object.keys(htmlThroughEditor).length
            ) {
                if (!unparsedDates.length && !unparsedLineDates.length) {
                    // Sin fechas ilegibles no dijimos NADA todavía, y salir mudo
                    // es peor que el verde falso que había antes: el usuario pidió
                    // algo y no pasa nada en pantalla.
                    warn(_t("No field from the proposal can be applied to the open form."));
                }
                // Todo lo que quedaba eran fechas ilegibles. Ya dijimos cuáles; cortamos
                // acá para no llegar a `_update` con un payload vacío y cantar un
                // "aplicado" verde. No hace falta re-publicar el contexto: a diferencia
                // del camino de `notApplied`, acá NO se escribió nada en el record.
                return proposalResult({ skipped, notes });
            }
            // Snapshot del count de los x2many que esperamos que CREZCAN (CREATE/LINK),
            // para el chequeo honesto post-apply: si pedimos agregar una línea y el
            // count no sube, fue un no-op y NO mostramos el "aplicado" verde a secas.
            const growthExpected = x2manyFieldsExpectingGrowth(normalized, fieldDefs);
            const countsBefore = {};
            for (const { name } of growthExpected) {
                countsBefore[name] = x2manyCount(activeRecord, name);
            }
            // What actually reached the form, for the result: `pending` is what
            // has not landed yet when something throws.
            const written = new Set();
            const pending = new Set([
                ...Object.keys(htmlThroughEditor),
                ...Object.keys(updatePayload),
                ...Object.keys(createsByField),
            ]);
            let wroteLines = false;
            try {
                // 0) Html with a mounted editor: through the editor, not `_update`.
                //    With the editor focused `_update` does not repaint it and the
                //    editor overwrites it on blur; this way it also lands in its
                //    history (Ctrl+Z).
                for (const [name, { field, html }] of Object.entries(htmlThroughEditor)) {
                    await _applyHtmlThroughEditor(field, html, drops);
                    _rememberAppliedHtml(name, proposedHtml[name]);
                    written.add(name);
                    pending.delete(name);
                }
                // 1) Escalares + m2o + comandos x2many que NO son CREATE → _update
                //    (lo serializamos por el mutex del modelo, como antes).
                if (Object.keys(updatePayload).length) {
                    await activeRecord.model.mutex.exec(() => activeRecord._update(updatePayload));
                    for (const name of Object.keys(updatePayload)) {
                        written.add(name);
                        if (!(name in createsByField)) {
                            pending.delete(name);
                        }
                        if (name in proposedHtml) {
                            _rememberAppliedHtml(name, proposedHtml[name]);
                        }
                    }
                }
                // 2) Líneas nuevas: una por una vía `list.addNewRecord` + `line._update`
                //    (dispara el onchange de la línea → resuelve name/precio/totales).
                //    OJO: `addNewRecord` YA toma el `model.mutex` por dentro. NO lo
                //    envolvemos en otro `mutex.exec` (sería deadlock: el exec interno
                //    esperaría al externo que espera al interno). El `line._update`
                //    posterior se llama directo (await secuencial), igual que la grilla.
                for (const [fieldName, valsList] of Object.entries(createsByField)) {
                    const list = activeRecord.data?.[fieldName];
                    if (!list || typeof list.addNewRecord !== "function") {
                        // Fallback defensivo: sin la API de StaticList, mandamos el
                        // CREATE crudo por _update (al menos agrega la fila, aunque el
                        // onchange no encadene). Mejor eso que perder la línea.
                        await activeRecord.model.mutex.exec(() =>
                            activeRecord._update({ [fieldName]: valsList.map((v) => [0, false, v]) })
                        );
                        written.add(fieldName);
                        pending.delete(fieldName);
                        continue;
                    }
                    for (const vals of valsList) {
                        const line = await list.addNewRecord({
                            activeFields: list.activeFields,
                            context: {},
                            mode: "edit",
                        });
                        wroteLines = true;
                        // Aplicar cada campo de la línea (dispara su onchange). `_update`
                        // toma el mutex por dentro, así que lo llamamos directo.
                        for (const [k, v] of Object.entries(vals)) {
                            // Acá SÍ va Luxon: `_update` → `_applyChanges` asigna
                            // crudo, sin pasar por `parseServerValue`. Es el único
                            // camino de los tres que NO re-parsea, y por eso la
                            // conversión vive acá y no en `coerceCommandVals`.
                            const t = list.fields?.[k]?.type;
                            const value = t === "date" || t === "datetime" ? coerceDateValue(v, t) : v;
                            if (value === null) {
                                continue; // ya reportada al normalizar
                            }
                            await line._update({ [k]: value });
                        }
                    }
                    written.add(fieldName);
                    pending.delete(fieldName);
                }
            } catch (e) {
                warn(_t("Could not apply changes: %s", e.message || e), "danger");
                // Re-publicar IGUAL, por la misma razón que abajo: los escalares se
                // aplican ANTES que las líneas nuevas, así que cuando revienta una
                // línea lo de arriba ya entró al formulario. Sin esto el contexto
                // queda en la revisión previa y la próxima propuesta sobre esa
                // misma baseRevision lee nuestro propio cambio como una edición del
                // usuario. Es el gemelo del camino de `notApplied` — y desde que el
                // guard mira sólo CREATE, el que de verdad se recorre.
                refreshRecordContext();
                // Html that already landed was filtered: the model must know it.
                if (drops.count) {
                    warn(droppedLoadsNote(drops.count));
                }
                for (const name of pending) {
                    skipped.push({ field: name, reason: "error" });
                }
                return proposalResult({
                    applied: [...written].filter((name) => !pending.has(name)),
                    skipped,
                    notes,
                    wrote: written.size > 0 || wroteLines,
                });
            }
            if (drops.count) {
                warn(droppedLoadsNote(drops.count));
            }
            // Chequeo honesto: ¿aparecieron TODAS las líneas nuevas que se pidieron?
            // Se compara contra `before + adds`, no contra `before`: con el `after >
            // before` de antes, pedir 3 líneas y que entre 1 pasaba como éxito.
            // Un faltante = la línea no se aplicó (forma inválida, vals que el
            // sub-modelo rechaza, etc.). Avisamos en vez del verde feliz.
            const notApplied = [];
            // Fields where some of the asked lines did land: they are also reported
            // as applied, or a retry would add those lines a second time.
            const partlyAdded = [];
            for (const { name, adds } of growthExpected) {
                const before = countsBefore[name];
                const after = x2manyCount(activeRecord, name);
                if (typeof before === "number" && typeof after === "number" && after < before + adds) {
                    notApplied.push(name);
                    if (after > before) {
                        partlyAdded.push(name);
                        notes.push(
                            String(_t("%(field)s: %(added)s of %(asked)s new lines added.", {
                                field: name,
                                added: after - before,
                                asked: adds,
                            }))
                        );
                    }
                }
            }
            if (notApplied.length) {
                warn(
                    // Single string literal (no `+` concat) so Odoo's i18n
                    // extractor captures the full msgid. Same runtime output.
                    _t(
                        "Changes applied, but could not add line(s) for: %s. Check the form — a required field may be missing (e.g. the product). Do not assume the line was added.",
                        notApplied.join(", ")
                    )
                );
                // Re-publicar IGUAL antes de salir: el aviso dice "Changes
                // applied, but…", o sea que los escalares del mismo payload SÍ
                // entraron. Sin esto el contexto se queda en la revisión previa y
                // la próxima propuesta sobre esa misma baseRevision lee nuestro
                // propio cambio como una edición del usuario, y contesta que no
                // aplica por conflicto. Es exactamente lo que el comentario de
                // abajo dice que el re-publish evita — sólo que este camino se
                // iba antes de llegar ahí.
                refreshRecordContext();
                for (const name of notApplied) {
                    skipped.push({ field: name, reason: "line_not_added" });
                }
                const applied = [...written].filter(
                    (name) => !notApplied.includes(name) || partlyAdded.includes(name)
                );
                return proposalResult({ applied, skipped, notes });
            }
            // Re-publicar: los valores que acabamos de aplicar son el nuevo estado
            // sobre el que el assistant tiene que razonar. Sin esto, una segunda
            // propuesta sobre la misma `baseRevision` leería su propio cambio como
            // conflicto del usuario.
            refreshRecordContext();
            warn(_t("Changes applied to the form (unsaved). Review and Save or Discard."), "success");
            return proposalResult({ applied: [...written], skipped, notes });
        }

        /**
         * Propone contenido para el chatter del registro abierto: abre el
         * compositor ESTÁNDAR de Odoo (mail.compose.message) pre-cargado en un
         * diálogo (target:"new"). El usuario revisa y hace clic en Enviar — NUNCA
         * se publica en silencio (el dispatch humano es estructural). Mirror del
         * `openFullComposer` del AI de Odoo Enterprise.
         *
         * GUARDRAILS (no se confía en el SPA):
         *   - Requiere contexto "record" (model + resId). Si no hay form abierto,
         *     avisa y corta (no se puede mandar al chatter de "nada").
         *   - Default a NOTA INTERNA (mail.mt_note). Solo mode==="message" usa
         *     mail.mt_comment (mensaje a seguidores).
         *   - body se trata como HTML y se sanitiza defensivamente.
         *
         * @param {{mode?: string, body?: string, subject?: string, target?: object}} payload
         * @returns {Promise<{status: "opened"|"rejected", applied: [], skipped: [], message: string, reason?: string}>}
         */
        /**
         * Refresca lo que quedó viejo después de postear desde el composer.
         *
         * Hacen falta las DOS cosas, y con una sola no alcanza: `model.load()`
         * relee el registro pero NO el chatter, que es un componente aparte con
         * su propio store — verificado contra un Odoo real, el mensaje quedaba
         * en la base y el hilo seguía diciendo "The conversation is empty".
         * Odoo hace lo mismo en su composer nativo: refetch del thread y reload
         * de la vista de atrás (ver mail/static/src/chatter/web/chatter_patch.js,
         * onCloseFullComposerCallback).
         *
         * `mail.store` se toma acá y no como dependencia declarada porque este
         * addon no depende de `mail`: si no está instalado, no hay chatter que
         * refrescar y el reload de la vista alcanza.
         */
        async function refreshAfterChatterPost(model, resId) {
            try {
                const thread = env.services["mail.store"]?.["mail.thread"]?.insert({ model, id: resId });
                await thread?.fetchNewMessages();
            } catch (e) {
                // El mensaje YA se posteó; no poder refrescar es cosmético.
                console.warn("[tuqui_assistant] Could not refresh the chatter:", e);
            }
            await reloadView();
        }

        async function proposeChatter({ mode, body, subject, target } = {}) {
            const ctx = state.context;
            const reject = (reason, text, type = "warning") => {
                notification.add(text, { type });
                return proposalResult({ reason, notes: [text] });
            };
            if (!ctx || ctx.kind !== "record" || !ctx.model || !ctx.resId) {
                return reject("no_record", _t("Open a form (1 record) to post to the chatter."));
            }
            if (isOtherRecord(target, ctx.model, ctx.resId)) {
                return reject(
                    "other_record",
                    _t("Not opened: the message was for another record. Go back to it and ask again.")
                );
            }
            // Default a nota interna; solo "message" notifica a seguidores.
            const isMessage = mode === "message";
            const drops = { count: 0 };
            const safeBody = sanitizeHtml(body, drops);
            const composerContext = {
                default_model: ctx.model,
                default_res_ids: [ctx.resId],
                default_body: safeBody,
                default_subtype_xmlid: isMessage ? "mail.mt_comment" : "mail.mt_note",
                default_composition_mode: "comment",
                // Without it, Odoo marks `partner_ids` required while the
                // recipients block stays hidden in a note: posting fails with no
                // visible culprit. The native chatter passes it for the same reason.
                is_full_composer: true,
            };
            if (typeof subject === "string" && subject.trim()) {
                composerContext.default_subject = subject;
            }
            try {
                await action.doAction(
                    {
                        type: "ir.actions.act_window",
                        name: isMessage ? _t("Send message") : _t("Log note"),
                        res_model: "mail.compose.message",
                        view_mode: "form",
                        views: [[false, "form"]],
                        target: "new",
                        context: composerContext,
                    },
                    {
                        // El composer es un DIÁLOGO aparte: postea y se cierra, y el
                        // chatter de atrás no se entera — el mensaje sólo aparece si
                        // se recarga la página.
                        //
                        // Odoo avisa en `args` si el usuario NO posteó: {dismiss:true}
                        // al cerrar con la X o Escape, {special:true} con Discard.
                        // Mismo criterio que su composer nativo.
                        onClose: (args) => {
                            if (args?.dismiss || args?.special) {
                                return;
                            }
                            refreshAfterChatterPost(ctx.model, ctx.resId);
                        },
                    }
                );
                markChatDialog();
            } catch (e) {
                return reject(
                    "error",
                    _t("Could not open the chatter composer: %s", e.message || e),
                    "danger"
                );
            }
            // Opened, not posted: posting is the person's call.
            const notes = [String(_t("The composer is open in the form. The person decides whether to post it."))];
            if (drops.count) {
                const dropped = droppedLoadsNote(drops.count);
                notification.add(dropped, { type: "warning" });
                notes.push(dropped);
            }
            return {
                status: "opened",
                applied: [],
                skipped: [],
                message: notes.join(" "),
            };
        }

        // Results by `proposalId`, oldest first: a replayed proposal (the SPA
        // re-plays the turn's frames on reconnect) is answered, not re-applied.
        // The promise is stored, so a duplicate that arrives mid-apply waits for it.
        const _proposalResults = new Map();

        function settleProposal(proposalId, run) {
            if (_proposalResults.has(proposalId)) {
                return _proposalResults.get(proposalId);
            }
            const outcome = Promise.resolve()
                .then(run)
                .catch((e) =>
                    proposalResult({ reason: "error", notes: [String(e?.message || e)] })
                );
            _proposalResults.set(proposalId, outcome);
            while (_proposalResults.size > MAX_PROPOSAL_RESULTS) {
                _proposalResults.delete(_proposalResults.keys().next().value);
            }
            return outcome;
        }

        /**
         * Recarga los datos de la vista abierta (form o lista) sin recargar la
         * página. La pide el SPA después de un turno que escribió en Odoo por
         * atrás (`odoo_write`, `odoo_create`, `message_post`…): el dato ya cambió
         * en la base pero la vista sigue mostrando lo viejo, y el usuario lee al
         * assistant decir "listo" arriba de datos que no se movieron.
         *
         * REGLA DURA: si el registro está sucio NO recargamos. Recargar tira los
         * cambios sin guardar — perder lo que alguien estaba escribiendo es mucho
         * peor que mostrar un dato viejo un rato. Ahí avisamos y decide él.
         *
         * @returns {Promise<boolean>} true si efectivamente recargó
         */
        /**
         * Guarda el formulario abierto — el mismo Guardar que apretaría el usuario.
         * Lo pide el SPA cuando el usuario dice "guardá" (tool `save_odoo_form`).
         *
         * NO es un atajo para que el assistant confirme sus propias propuestas: el
         * propose-then-apply existe para que el usuario revise antes de que algo se
         * escriba, y guardar por él le saca justo eso. La tool del backend se lo
         * dice al modelo; acá guardamos igual porque quien decide es el usuario.
         *
         * La validación es de Odoo: campos requeridos, constraints y reglas de
         * acceso siguen aplicando, y un guardado rechazado se ve en Odoo.
         *
         * @returns {Promise<boolean>} true si guardó
         */
        async function saveRecord() {
            if (!activeRecord) {
                notification.add(_t("Open a form (1 record) to save it from here."), {
                    type: "warning",
                });
                return false;
            }
            if (!activeRecord.dirty) {
                notification.add(_t("Nothing to save — the form has no pending changes."), {
                    type: "info",
                });
                return false;
            }
            // An x2many record saves through its dialog: a line into the form below,
            // a many2many record to the database.
            const owner = _page()?.owner || {};
            const intoForm = _isLine(activeRecord);
            let saved = false;
            try {
                saved = owner.save ? await owner.save() : await activeRecord.save();
            } catch (e) {
                notification.add(_t("Could not save: %s", e.message || e), { type: "danger" });
                return false;
            }
            if (!saved) {
                // Odoo ya avisó: el único camino por el que `save()` devuelve false
                // es `_checkValidity({ displayNotification: true })`, que muestra
                // "Missing required fields" y marca los campos en rojo. Un toast
                // nuestro encima decía lo mismo, más vago y tapando el panel.
                // Devolvemos false igual: es la señal interna, no un aviso.
                return false;
            }
            // Guardado: el registro dejó de estar sucio y los computados cambiaron.
            refreshRecordContext();
            notification.add(
                intoForm ? _t("Line saved into the form. Save the form to keep it.") : _t("Form saved."),
                { type: "success" }
            );
            return true;
        }

        /**
         * Reads the page's data again after a write behind it. True means a form
         * reloaded, or a view started its search again: the view reloads on its own
         * when the search runs, and Odoo gives nothing to wait for that load.
         *
         * @returns {Promise<boolean>}
         */
        async function reloadView() {
            const page = _page();
            if (!page?.owner.reload) {
                // An x2many record's dialog cannot reload: the form under it does,
                // when the dialog closes.
                const below = _pages.slice(0, -1).reverse().find((e) => e.owner.reload);
                if (below) {
                    below.reloadOnReturn = true;
                    notification.add(
                        _t("Data changed in Odoo while this dialog is open: the form below reloads when you close it."),
                        { type: "info" }
                    );
                }
                return false; // sin vista publicada (home, settings…): nada que recargar
            }
            if (activeRecord?.dirty) {
                notification.add(
                    _t(
                        "Data changed in Odoo, but the form has unsaved changes so it was not reloaded. Save or discard to see the new values."
                    ),
                    { type: "warning" }
                );
                return false;
            }
            let reloaded;
            try {
                reloaded = await page.owner.reload();
            } catch (e) {
                // Un reload fallido no es un error del usuario: el dato está en la
                // base y se ve al refrescar a mano. Consola, sin toast.
                console.warn("[tuqui_assistant] Could not reload the view:", e);
                return false;
            }
            // El reload de un form REEMPLAZA el root del modelo: el record que
            // teníamos publicado queda DESCONECTADO, con los valores de antes. Si no
            // lo re-apuntamos, el contexto sigue mostrando lo viejo y —peor— la
            // próxima propuesta se aplica sobre un datapoint que ya no está
            // renderizado: nada cambia en pantalla y `applyProposal` igual devuelve
            // true. Ese "ok silencioso" es justo lo que esta feature no puede
            // introducir. Una vista no tiene record publicado y no devuelve nada.
            if (reloaded) {
                page.record = reloaded;
                if (page === _page()) {
                    activeRecord = reloaded;
                }
            }
            // Re-publicar: lo que se acaba de releer es el contexto nuevo sobre el
            // que el assistant tiene que razonar en el próximo turno.
            refreshRecordContext();
            return true;
        }

        /**
         * Navigates Odoo from the embedded chat (`odoo_open_view`, validated by
         * the server first). Writes nothing: every mode goes through Odoo's own
         * `doAction`, which checks access like any screen the user opens. A
         * request that cannot land is told to the user and returns false, so
         * the screen never moves to something other than what was asked.
         *
         *   - "record": the form of one record (`resId`).
         *   - "browse": `model` over `domain` in any registered view type, with
         *     `groupBy` and the view keys of `context` (the format `kind: "view"`
         *     reports). A set has no form: form → list.
         *   - "action": an existing window or client action by `xmlid`, or by
         *     `menuId` among the menus Odoo loaded for this user, with `section`
         *     (Settings) as `context.module`. Anything else is refused.
         *   - "new": an empty form with `defaults` as default_<field>.
         *
         * Any other mode is refused, as is a mode missing from the payload.
         *
         * @param {Object} payload
         * @returns {Promise<boolean>}
         */
        async function navigate(payload = {}) {
            const { model, mode, viewType, domain, groupBy, context, defaults, title, resId } = payload;
            // A mode this host does not know must not fall through to an empty form.
            if (!NAVIGATE_MODES.includes(mode)) {
                notification.add(_t("This Odoo cannot open that kind of screen, so it was not opened."), {
                    type: "warning",
                });
                return false;
            }
            if (mode === "action") {
                return navigateToAction(payload);
            }
            if (typeof model !== "string" || !model.trim()) {
                notification.add(_t("Cannot navigate: missing Odoo model to open."), { type: "danger" });
                return false;
            }
            if (mode === "record") {
                if (!(Number.isInteger(resId) && resId > 0)) {
                    notification.add(_t("Cannot open the record: missing its id."), { type: "danger" });
                    return false;
                }
                return openWindow(
                    { name: title || model, res_model: model, res_id: resId, views: [[false, "form"]] },
                    { viewType: "form" },
                    (error) => _t("Could not open the record in Odoo: %s", error)
                );
            }
            if (mode === "browse") {
                const asked = typeof viewType === "string" && viewType ? viewType : "list";
                const type = await _viewTypeOf(asked);
                if (!type) {
                    notification.add(_t("This Odoo has no %s view, so it was not opened.", asked), {
                        type: "warning",
                    });
                    return false;
                }
                const vt = type === "form" ? "list" : type;
                return openWindow(
                    {
                        name: title || model,
                        res_model: model,
                        // The view asked for opens first; list and form stay to switch to.
                        views: [...new Set([vt, "list", "form"])].map((type) => [false, type]),
                        domain: Array.isArray(domain) ? domain : [],
                        context: browseContext(groupBy, context),
                    },
                    { viewType: vt },
                    (error) => _t("Could not open the view in Odoo: %s", error)
                );
            }
            const ctx = {};
            if (defaults && typeof defaults === "object" && !Array.isArray(defaults)) {
                for (const [name, value] of Object.entries(defaults)) {
                    ctx[`default_${name}`] = value;
                }
            }
            return openWindow(
                { name: title || model, res_model: model, views: [[false, "form"]], view_id: false, context: ctx },
                {},
                (error) => _t("Could not open the new form in Odoo: %s", error)
            );
        }

        /**
         * The view type `name` opens as, or null when this Odoo has none. A js_class
         * ("crm_kanban") opens as its type; pivot and graph live in a bundle Odoo
         * loads only when one first opens (`View.loadView`), so it is loaded first.
         */
        async function _viewTypeOf(name) {
            const views = registry.category("views");
            if (!views.contains(name)) {
                const dark = cookie.get("color_scheme") === "dark";
                try {
                    await loadBundle(dark ? "web.assets_backend_lazy_dark" : "web.assets_backend_lazy");
                } catch {
                    return null;
                }
            }
            return views.get(name, null)?.type || null;
        }

        /** Tells the user why a navigation failed; returns false for the caller to return. */
        function navigationFailed(failureMessage, error) {
            notification.add(failureMessage(error.message || error), { type: "danger" });
            return false;
        }

        async function runAction(request, options, failureMessage) {
            try {
                await action.doAction(request, options);
            } catch (e) {
                return navigationFailed(failureMessage, e);
            }
            return true;
        }

        function openWindow(windowAction, options, failureMessage) {
            return runAction(
                { type: "ir.actions.act_window", target: "current", context: {}, ...windowAction },
                options,
                failureMessage
            );
        }

        async function navigateToAction({ xmlid, menuId, section }) {
            let request = xmlid;
            let menu;
            const menus = env.services.menu;
            if (Number.isInteger(menuId)) {
                menu = menus.getMenu(menuId);
                // The menus Odoo loaded are the ones this user can see.
                if (!menu?.actionID) {
                    notification.add(_t("That menu is not available to you in this Odoo."), { type: "warning" });
                    return false;
                }
                request = menu.actionID;
            } else if (typeof xmlid !== "string" || !xmlid.includes(".")) {
                // An xmlid is "module.name". A bare client-action tag ("reload",
                // "soft_reload") Odoo runs locally, and it reloads the page.
                notification.add(_t("Cannot navigate: missing the screen to open."), { type: "danger" });
                return false;
            }
            const failureMessage = menu
                ? (error) => _t("Could not open that menu in Odoo: %s", error)
                : (error) => _t("Could not open that screen in Odoo: %s", error);
            let loaded;
            try {
                loaded = await action.loadAction(request);
            } catch (e) {
                return navigationFailed(failureMessage, e);
            }
            // doAction would run a server action or follow a URL: only screens open.
            if (!SCREEN_ACTIONS.has(loaded?.type)) {
                notification.add(_t("That is not a screen, so Tuqui did not open it."), { type: "warning" });
                return false;
            }
            // As in Odoo: a menu starts over from its app; any other action stacks on
            // the breadcrumbs, so the user can go back to where they were.
            const options = menu
                ? { clearBreadcrumbs: true, onActionReady: () => menus.setCurrentMenu(menu) }
                : {};
            // doAction prepares the action again: hand it the one as loaded, not the
            // prepared copy (a second pass adds another search view to `views`). An
            // action Odoo could not serialize opens from its request instead.
            let target = request;
            if (loaded._originalAction) {
                target = JSON.parse(loaded._originalAction);
                // The JSON copy loses the markup of the help, as when Odoo restores an action.
                if (typeof target.help === "string") {
                    target.help = markup(target.help);
                }
            }
            if (section && typeof target === "object") {
                // The Settings action carries its own `module`, which beats an additional context.
                try {
                    target.context = makeContext([target.context, { module: section }], user.context);
                } catch (e) {
                    return navigationFailed(failureMessage, e);
                }
            } else if (section) {
                options.additionalContext = { module: section };
            }
            return runAction(target, options, failureMessage);
        }

        /**
         * Put the drop on a control of the last list sent to the chat. The id was
         * checked against that list by the chat; if the control left the screen
         * since, or the id now names another control, there is nothing honest to
         * point at.
         */
        function point({ target, name, role } = {}) {
            const el = elementFor(target, { name, role });
            if (!el) {
                const notice = isBehindDialog(target)
                    ? _t("What Tuqui marked is behind the open dialog: close it to see it.")
                    : _t("What Tuqui marked is no longer on this screen.");
                notification.add(notice, { type: "warning" });
                return false;
            }
            markStep(el);
            return true;
        }

        /** The floating panel covers part of the screen, and the person may need any of it
         *  while doing the step: docked aside, it makes room instead. */
        function markStep(el) {
            expand();
            showGota(overlay, el);
        }

        /**
         * Put the drop on the control named `name` (in `section`, when the name
         * repeats) on the screen as it is now, and say what was found: the chat asks
         * by name because ids are positions, and the screen may have moved since it
         * last saw them (a walk, a navigation, a turn that started on Odoo's home).
         *
         * @returns {{status: "marked"|"missing"|"ambiguous"|"navigation", places: string[], applied: [], skipped: []}}
         *   `places`: the section of what was marked, of each match, or (missing) where
         *   the name is when `section` matched none of them.
         */
        /**
         * Whether a menu entry is the person's to click: Tuqui clicks only what opens a
         * screen (an app, a dropdown, a window or client action), so an entry that runs
         * something else, or one Odoo's menu service does not know, is a step to mark.
         */
        function personsClick(el) {
            const entry = el.closest("[data-menu-xmlid]");
            return Boolean(entry) && !tuquiMayClick(menuOf(entry, menu));
        }

        function pointByName({ name, section, field } = {}) {
            const { found, elsewhere } = findByName(name, section, document, field);
            const answer = (status, places) => ({ status, places, applied: [], skipped: [], message: "" });
            const sections = [...new Set(found.map(({ target }) => target.section || ""))];
            // Two controls with the same name in the same named section look the same to
            // the person too: the first one is as good as the other.
            if (found.length === 1 || (found.length > 1 && section && sections.length === 1)) {
                // A menu of the app leads to a screen: getting there is not a step to mark,
                // unless only the person may click it.
                if (found[0].el.closest(APP_MENUS) && !personsClick(found[0].el)) {
                    return answer("navigation", [found[0].target.section || ""]);
                }
                markStep(found[0].el);
                return answer("marked", [found[0].target.section || ""]);
            }
            if (found.length > 1) {
                return answer("ambiguous", sections);
            }
            return answer("missing", elsewhere);
        }

        /**
         * `pointByName` once the control is there, opening `open` (a record) first
         * when given: "missing" is only answered after a short look.
         */
        async function pointWhenThere(payload = {}) {
            const { model, resId } = payload.open || {};
            if (typeof model === "string" && Number.isInteger(resId)) {
                await navigate({ model, mode: "record", resId });
            }
            let found = pointByName(payload);
            // The entries of a card's ⋮ («Import File» on a bank) exist only while it is open,
            // and once open they are looked for in that menu alone: a name the menu does not
            // hold must not land on a control elsewhere on the page.
            const cardMenu = found.status === "missing" && openCardMenu(payload.section);
            const look = cardMenu ? () => pointInMenu(payload) : () => pointByName(payload);
            if (cardMenu) {
                await delay(POINT_LOOK_MS);
                found = look();
            }
            for (let waited = 0; found.status === "missing" && waited < POINT_PATIENCE_MS; waited += POINT_LOOK_MS) {
                await delay(POINT_LOOK_MS);
                found = look();
            }
            if (cardMenu && found.status !== "marked") {
                cardMenu.click(); // left as it was
            }
            if (found.status === "missing" && !cardMenu) {
                return (await pointInClosedMenus(payload)) || found;
            }
            return found;
        }

        /**
         * `pointInMenu` in each closed dropdown of the view in turn (the search options,
         * the measures, the optional columns, the actions), leaving open the one that holds
         * the control and closing the others as they were: what is in a closed dropdown is
         * not on the page until it opens, and the person would have to guess which one.
         * The top bar's menus are not here: getting to a screen is a walk, not a step.
         */
        async function pointInClosedMenus(payload) {
            const toggles = [...document.querySelectorAll(CLOSED_VIEW_MENUS)].filter(isOnScreen).slice(0, MAX_MENUS_OPENED);
            for (const toggle of toggles) {
                toggle.click();
                await delay(POINT_LOOK_MS);
                const found = pointInMenu(payload);
                if (found.status === "marked") {
                    return found;
                }
                if (toggle.getAttribute("aria-expanded") === "true") {
                    toggle.click();
                }
            }
            return null;
        }

        /** Open the ⋮ of the one card on screen named `section`; its toggle, or null. */
        function openCardMenu(section) {
            const wanted = (section || "").trim().toLowerCase();
            if (!wanted) {
                return null;
            }
            const cards = [...document.querySelectorAll(".o_kanban_record")].filter(
                (card) => isOnScreen(card) && recordName(card).toLowerCase().includes(wanted)
            );
            const toggle = cards.length === 1 && cards[0].querySelector(".o_dropdown_kanban .dropdown-toggle");
            if (!toggle) {
                return null;
            }
            toggle.click();
            return toggle;
        }

        /**
         * `pointByName` within the dropdown open last, and nowhere else. When the name is not
         * there, the answer says what the menu holds: the model cannot see a closed ⋮, and
         * asked for the ⋮ itself it gets the entry to ask for next.
         */
        function pointInMenu({ name, field } = {}) {
            const menu = [...document.querySelectorAll(".o-dropdown--menu")].at(-1);
            const found = menu ? findByName(name, "", document, field).found.filter(({ el }) => menu.contains(el)) : [];
            const answer = (status, message = "") => ({ status, places: [], applied: [], skipped: [], message });
            if (found.length === 1) {
                markStep(found[0].el);
                return answer("marked");
            }
            if (found.length) {
                return answer("ambiguous");
            }
            const { targets, elements } = readTargets(document);
            const inMenu = (el) => menu?.contains(el) && !el.closest(".o_kanban_colorpicker");
            const entries = targets.filter((t) => inMenu(elements.get(t.id))).map((t) => t.name);
            return answer("missing", entries.length ? `That card's ⋮ holds: ${entries.join(", ")}.` : "");
        }

        return {
            state,
            point,
            pointByName,
            pointWhenThere,
            readScreen,
            rememberScreen,
            setRecordContext,
            refreshRecordContext,
            setViewContext,
            clearContext,
            toggleVisibility,
            minimize,
            restore,
            close,
            expand,
            contract,
            applyProposal,
            proposeChatter,
            settleProposal,
            navigate,
            reloadView,
            saveRecord,
            getEmbedBootstrap,
            registerTestCopy,
            getSsoAuth,
            getContextPayload,
            noteFocusedField,
            getActiveRecord: () => activeRecord,
            consumeResumeOnOpen,
        };
    },
};

registry.category("services").add("tuquiAssistant", tuquiAssistantService);

// Helpers puros de normalización x2many, exportados para test en aislamiento
// (sin montar el servicio OWL). Ver static/tests/proposal_normalize.test.js.
export {
    normalizeX2manyValue,
    normalizeProposalX2many,
    x2manyFieldsExpectingGrowth,
    isX2manyCommandTuple,
    coerceDateValue,
    coerceCommandVals,
    coerceX2manyCommandVals,
    splitX2manyCreates,
    sanitizeHtml,
    sameHtml,
    mergeHtmlWithoutEditor,
};
