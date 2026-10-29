# Tuqui embebido en Odoo — protocolo de embed (L1)

Contrato entre el módulo Odoo `tuqui_assistant` (host) y el SPA de Tuqui
(iframe).
Decisión de transporte/auth: embed sobre companion, SSO por nonce, sin
login dentro del iframe.

## Idea

El panel lateral de `tuqui_assistant` embebe el SPA de Tuqui en un `<iframe>`
(modo embed) para reusar TODA su UI (composer, micrófono, artifacts, streaming,
InlineApproval). El host y el iframe hablan por `window.postMessage`: el contexto
del formulario abierto baja, las propuestas de cambio suben y se aplican en
memoria con `record._update` (el usuario Guarda/Descarta con Odoo nativo).

## Configuración — derivada del companion (no hay system param)

La URL del embed **no** se configura con un parámetro: se deriva de la conexión
companion. El método `embed_bootstrap` del modelo
`tuqui.assistant.sso.nonce` (RPC, lo llama el panel vía `getEmbedBootstrap()`)
lee el `tuqui.oauth.client` activado y devuelve `{connected, base_url, slug}`:

| Lado | Qué | Dónde |
|---|---|---|
| Odoo | Base de Tuqui a embeber | `tuqui.base_url` del oauth client (default `https://tuqui.com`). |
| Odoo | Workspace a abrir | `workspace_id_external` (slug) capturado al activar el companion. |
| Odoo | Estado de conexión | `connected = state=='active' AND hay slug`. Si es false, el panel muestra un prompt "conectá Tuqui desde Ajustes" — **sin fallback nativo**. |
| Tuqui | Permitir el framing | header CSP `frame-ancestors` en `tuqui_core/main.py` (env `EMBED_FRAME_ANCESTORS`). Reemplaza el viejo `X-Frame-Options: DENY`. |
| Tuqui | Modo embed | ruta `/embed/:slug` + flag `?embed=1` → renderiza el chat sin `AppShell`. |

El host arma el src del iframe como `{base_url}/embed/{slug}?embed=1`
(ver `embedUrl` en `panel.js`).

## Auth — SSO por nonce single-use (sin login en el iframe)

El `localStorage` del iframe está particionado (cross-site), así que no se
loguea adentro. En cambio:

1. Al abrir el panel, en paralelo con la carga del iframe, el host llama
   `issue_for_current_user` (RPC, corre como el usuario logueado) → mintea un
   nonce single-use atado a `odoo_uid = env.uid` y al `client_id` del companion
   (TTL ~90s). El uid sale de la sesión, nunca del caller → un usuario sólo puede
   hacer SSO como sí mismo. Si el `ready` no llega antes del watchdog (12 s), ese
   nonce se descarta y se mintea otro al recibir el `ready`, para no postear uno
   vencido. Un reintento también mintea uno fresco.
2. El host postea `{ source:"tuqui-odoo", type:"auth", payload:{ client_id, nonce } }`
   al iframe (una sola vez por apertura — un nonce de más se gastaría dos veces).
3. El SPA reenvía el nonce a Tuqui; Tuqui lo canjea vía
   `POST /tuqui_assistant/sso/exchange` (auth = el nonce mismo, single-use,
   atómico), recibe `{odoo_uid, client_id}`, lo mapea a un member del workspace y
   mintea un token de sesión corto. Nunca viaja un secreto: el módulo no guarda
   el client secret en plano y el nonce es la única credencial en tránsito.

## Mensajes `postMessage`

Host (Odoo) → SPA (iframe):

```jsonc
{ "source": "tuqui-odoo", "type": "auth", "payload": {
    "client_id": "…", "nonce": "…",
    "capabilities": {
      "apply_result": ["form_changes", "form_html", "chatter", "show_me", "point", "wait_step"],
      "navigate": ["record", "new", "browse", "action"] } } }           // SSO: antes del contexto
{ "source": "tuqui-odoo", "type": "context", "payload": {
    "capabilities": { … },                                            // igual que en auth
    "kind": "record",                                                 // o "selection", "view", "none" (ver «Contexto de una vista»)
    "model": "helpdesk.ticket", "resId": 42, "displayName": "INC-0042",
    "dirty": true, "revision": 7,
    "htmlFields": ["description"],                      // campos html en pantalla
    "focus": { "field": "description", "type": "html",  // último campo con foco (opcional)
               "selection": { "text": "…", "collapsed": false, "block": "…",
                              "truncated": true } },            // `truncated` sólo si se cortó
    "fields": { /* valores en memoria, incl. sin guardar */ },
    "targets": [ { "id": "t27", "role": "checkbox", "name": "Números de serie",
                   "section": "Trazabilidad", "checked": false } ] } }  // lo que se puede tocar (ver «La gota»)
{ "source": "tuqui-odoo", "type": "switch-company-failed",
  "payload": { "companyId": 2 } }                                   // el host no pudo cambiar de compañía
```

SPA (iframe) → Host (Odoo):

```jsonc
{ "source": "tuqui-spa", "type": "ready" }                         // montado; el host responde con auth + context
{ "source": "tuqui-spa", "type": "error" }                         // se cayó antes de "ready": el host lo dice ya, sin esperar el timeout
{ "source": "tuqui-spa", "type": "apply",
  "payload": { "changes": { "campo": "valor" }, "rationale": "…",
               "baseRevision": 7,
               "proposalId": "…",                                   // opcional: pide `apply-result`
               "kind": "form_changes",                              // opcional (default form_changes; form_html con htmlBase/selection)
               "htmlBase": { "description": "<p>…</p>" },         // opcional: base de cada html de `changes`
               "selection": { "field": "description", "html": "…", // opcional: reemplazar la selección
                              "expectedText": "…" },
               "target": { "model": "project.task", "resId": 42 } } } // opcional: registro del turno; aplicar al form en memoria
{ "source": "tuqui-spa", "type": "chatter",
  "payload": { "mode": "…", "body": "…", "subject": "…",
               "proposalId": "…", "kind": "chatter",                // opcionales, como en apply
               "target": { "model": "project.task", "resId": 42 } } } // pre-carga el compositor nativo (nunca publica solo)
{ "source": "tuqui-spa", "type": "navigate",
  "payload": { "mode": "browse", "model": "sale.order", "viewType": "pivot",
               "domain": [], "groupBy": [], "context": { "pivot_measures": ["amount_total"] } } } // abrir una pantalla (ver «Navegar»)
{ "source": "tuqui-spa", "type": "reload" }                        // releer la vista tras una escritura por atrás
{ "source": "tuqui-spa", "type": "save" }                          // guardar el form abierto (lo pidió el usuario)
{ "source": "tuqui-spa", "type": "switch-company",
  "payload": { "companyId": 2 } }                                   // hacer actual otra compañía (recarga la página)
{ "source": "tuqui-spa", "type": "point",
  "payload": { "target": "t27", "name": "Números de serie", "role": "checkbox" } } // marcar un control de `targets`
```

## Contexto vivo y conflicto (`revision` / `baseRevision`)

El contexto del form no se manda una sola vez: se re-manda **mientras el usuario
edita**, para que el assistant trabaje sobre lo que está escribiendo sin guardar.

- **Cadencia:** al salir de un campo (`focusout`) con **debounce de 400 ms** —
  nunca por tecla. Una revisión por tecla infla el contexto de cada turno (costo
  de LLM y ruido) sin agregar valor. El disparador vive en
  `form_controller_patch.js`; el servicio compara contra lo último publicado y
  **no** gasta una revisión si nada cambió.
- **`revision`** (host → SPA): contador monotónico del contexto de formulario.
  Sube al cambiar de record y cada vez que los valores en memoria cambian. El
  host guarda un snapshot de los valores publicados en cada revisión (ring de
  las últimas 10).
- **`baseRevision`** (SPA → host, en `apply`): la revisión sobre la que el SPA
  razonó. El host compara, campo por campo, el valor actual contra el snapshot
  de esa revisión: **si el usuario cambió un campo después de la propuesta, ese
  campo NO se aplica** y el usuario ve por qué. Nunca se pisa en silencio.
  Si el `apply` viene sin `baseRevision` (SPA viejo) o la revisión ya salió del
  ring, no hay contra qué comparar y se aplica como antes.

## Campos html (`htmlFields`, `focus`, `htmlBase`, `selection`)

- **Valor:** un campo html viaja como texto. Si la persona está escribiendo en el
  editor sin haber salido del campo, viaja el contenido vivo del editor.
- **`focus`:** el último campo del form que tuvo el foco, aunque después el foco
  haya pasado al panel. Si es html con editor, `selection` trae el texto
  seleccionado (máx. 2000, vacío si es un cursor; `truncated: true` si se cortó)
  y el texto del bloque donde está el cursor (máx. 500).
- **`htmlFields`:** sólo los campos html que la persona puede editar en pantalla
  (sin los invisibles ni los de sólo lectura).
- **Aplicar html:** sólo se reemplazan los bloques de primer nivel que cambian, y
  sólo esos se limpian antes de insertarse (sin `on*`, sin `javascript:`, sin
  `<script>` ni `<iframe>`): los que la edición no tocó quedan tal cual, con sus
  `t-if` o sus videos. Con el editor montado se aplica a través de él, con su
  limpieza, y queda en su historial (Ctrl+Z). Sin editor, por el record, limpiando
  con DOMPurify. Si la limpieza deja vacía una propuesta que traía contenido, no se
  aplica y se avisa.
  Lo que se inserta tampoco puede cargar nada de otro origen antes de guardar: se
  sacan `src`, `srcset`, `poster`, `background` y los `url()` de `style` que no sean
  del mismo Odoo o `data:image/...` (una `<img>` así se saca entera, y también el
  párrafo que la contenía si queda vacío). Los `href` de los links quedan. Vale
  también para el cuerpo que se propone al chatter. Lo que se quitó se avisa a la
  persona y en el `message` del resultado; el `status` no cambia por eso.
- **`htmlBase`:** el html sobre el que Tuqui calculó la edición. Si el valor en
  pantalla ya no es ese (normalizado), el campo no se aplica y se avisa. Lo último
  que aplicó el assistant cuenta como base mientras la persona no toque el campo,
  para encadenar dos ediciones en un turno. Con `htmlBase` no se mira
  `baseRevision` para ese campo.
- **`selection`:** reemplaza la selección guardada del editor, sólo si su texto
  (con espacios normalizados) sigue siendo `expectedText` y no supera el tope de
  2000 caracteres (si lo supera, el modelo no vio todo lo que se borraría). Si no
  se aplica, tampoco se aplican los `changes` del mismo `apply`.

## Registro destino (`target`)

`target: {model, resId}` en un `apply` o un `chatter` es el registro sobre el que
razonó el turno (`resId` es `false` en un registro nuevo). Si la persona navegó a
otro registro mientras tanto, el host no aplica nada, avisa y (con `proposalId`)
contesta `rejected` con motivo `other_record`. Con `resId: false` solo se compara
el modelo: el registro nuevo pudo guardarse en el mismo turno y ya tener id. Sin
`target` (SPA viejo) se aplica sobre el registro activo, como antes.

## Resultado de una propuesta (`apply-result`)

Si el `apply` o el `chatter` trae `proposalId`, el host contesta cuando termina:

```jsonc
{ "source": "tuqui-odoo", "type": "apply-result", "payload": {
    "proposalId": "…",
    "status": "partial",               // applied | partial | rejected; chatter: opened | rejected
    "applied": ["name"],               // en pantalla, sin guardar
    "skipped": [{ "field": "ref", "reason": "readonly" }],
    "reason": "other_record",          // sólo si se rechazó la propuesta entera
    "message": "…" } }                 // los mismos avisos que vio la persona
```

- **`applied`** quiere decir «en pantalla, sin guardar». **`partial`**: algo
  entró y algo no (por ejemplo, los escalares sí y una línea x2many no).
  **`rejected`**: no cambió nada en pantalla.
- **Chatter:** `opened` quiere decir que el compositor quedó abierto. Publicarlo
  lo decide la persona, y el host no se entera.
- **Recorrido (`show_me`):** `arrived` (llegó), `unconfirmed` (llegó a una
  pantalla que el modelo de juicio no confirmó como destino, ni en una segunda
  mirada) o `stopped` (se frenó antes). Trae además `steps`, cada respuesta del
  modelo (`choice`, `operation`, `confidence`): de ahí sale el camino recorrido, y
  es lo que deja leer el recorrido después desde la conversación. Cada paso que el
  host le pide a Tuqui lleva el `proposal_id` del recorrido.
  El recorrido no arranca sobre un formulario con cambios sin guardar (salir lo
  guardaría), corta solo antes de los 35 s que Tuqui espera, y se corta al
  minimizar o cerrar el panel.
- **Motivos por campo** (`skipped[].reason`): `not_in_form` (no existe o no está
  en pantalla), `readonly`, `changed_by_user` (la persona lo cambió después de
  `baseRevision`, o un html que cambió desde su `htmlBase`), `sanitized_empty`
  (un html con contenido que la limpieza deja vacío), `invalid_date`,
  `empty_lines`, `line_not_added`, `error`.
- **Motivos de la propuesta entera** (`reason`): `other_record`, `no_record` (no
  hay un formulario abierto), `invalid_proposal`, `unsupported`, `error`. Para
  una `selection`: `selection_changed` (lo seleccionado ya no es `expectedText`) y
  `selection_too_long` (pasa el tope de 2000). Si el campo de la selección no
  tiene un editor abierto, o la limpieza deja vacía la propuesta, va `rejected`
  sin `reason`, con el campo en `skipped` (`not_in_form` o `sanitized_empty`).
- **`kind`:** una propuesta con `htmlBase` o `selection` se contesta como
  `form_html` si el SPA no manda otro `kind`. En un
  rechazo entero `skipped` va vacío: el motivo está en `reason`.
- **Sin `proposalId`** (SPA viejo): se aplica como antes y no se contesta.
- **Idempotencia:** un `proposalId` que ya se procesó no se vuelve a aplicar; se
  repite su resultado. Al reconectar, el SPA vuelve a mandar los frames del turno,
  y un doble envío duplicaría líneas. El host recuerda los últimos 50.
- **Lo que no conoce:** un `kind` que no está en `capabilities.apply_result`, o un
  `type` de mensaje desconocido con `proposalId`, se contesta `rejected` con
  motivo `unsupported`, sin tocar nada.
- **`capabilities.apply_result`** (en `auth` y en cada `context`): los `kind` que
  el host sabe contestar. El SPA no espera resultado de un `kind` que no esté ahí.
  Va en cada `context` porque `auth` sale una sola vez por apertura del panel y el
  SPA se puede recargar adentro.
- `targetOrigin` y los chequeos de origen son los mismos que para el resto de los
  mensajes.

## Reload de la vista (`reload`)

Cuando un turno escribe en Odoo **por atrás** (`odoo_write`, `odoo_create`,
`odoo_message_post`…), la base ya cambió pero la vista abierta sigue mostrando
lo viejo: el usuario lee "listo, actualicé los 3 contactos" arriba de tres filas
sin tocar. El SPA cierra ese hueco posteando `reload` al terminar el turno, y el
host relee los datos de la vista sin recargar la página: el form relee su modelo,
y una vista con búsqueda (lista, kanban, pivot…) vuelve a correr la búsqueda,
como la barra de búsqueda.

**Regla dura: un formulario sucio NO se recarga.** Recargar tira los cambios sin
guardar, y perder lo que alguien estaba escribiendo es mucho peor que mostrar un
dato viejo un rato. En ese caso el host avisa y deja que el usuario guarde o
descarte. Después de recargar se re-publica el contexto, así el próximo turno
razona sobre los valores nuevos.

Con el diálogo de un registro de un x2many abierto, el host avisa y recarga el
form de abajo cuando el diálogo se cierra (con la misma regla: si quedó sucio, no
lo recarga). En una vista, la recarga es volver a correr la búsqueda: el host la
arranca y la vista se relee sola, sin una promesa que el host pueda esperar.

## Guardar el formulario (`save`)

`save` aprieta el mismo Guardar que apretaría el usuario, y existe porque
"guardalo" es lo obvio para decirle a un asistente embebido en ese formulario.

Dos cosas que NO cambia:

- **No es un atajo para que el assistant confirme sus propias propuestas.** El
  propose-then-apply existe para que el usuario revise antes de que algo se
  escriba; guardar por él le saca justo eso. La tool del backend se lo prohíbe
  explícitamente al modelo — sólo va cuando el usuario lo pide.
- **La validación sigue siendo de Odoo.** Requeridos, constraints y reglas de
  acceso aplican igual, y un guardado rechazado se reporta como rechazado en vez
  de cantar victoria.

**Un registro de un x2many en su diálogo:** mientras el usuario edita un registro
en el diálogo de un one2many o de un many2many, la página es ese registro y viaja
como `kind:"record"`. Las propuestas aplican a él, y `save` es el Guardar del
diálogo, que lo cierra. Una línea de one2many lleva además `lineOf: {model,
resId, displayName}`, el registro del form de abajo: el Guardar pasa la línea a
ese form, y la línea queda en la base recién cuando el usuario lo guarda. Un
registro de many2many no lleva `lineOf`: el Guardar del diálogo lo escribe en la
base.

**Nota sobre el ciclo de vida de una propuesta:** una propuesta aplicada queda en
el formulario SIN guardar, pero si el usuario **navega a otra pantalla Odoo la
guarda solo** — no la descarta. Así que "no se guarda hasta que vos guardes" es
falso; lo cierto es "hasta que guardes o te vayas de la pantalla". El prompt del
contexto de record se lo dice al modelo, y por eso también le prohíbe llamar a
`open_odoo_view` justo después de proponer: navegar commitea una propuesta que el
usuario todavía no miró.

## Compañías (`company`, `switch-company`)

Un registro nuevo nace en la compañía **actual** de Odoo, diga lo que diga el
pedido. Por eso todo contexto (también `kind:"none"`) lleva las compañías en juego:
`current`, `active` (tildadas), `available` (permitidas no tildadas, tope 20,
`availableTotal` si se cortó) y `switchMode: "reload"`.

En Odoo 18 `company.setCompanies` siempre recarga la página. Por eso el SPA
manda `switch-company` recién cuando terminó la respuesta del turno; el panel
vuelve abierto en la misma conversación (estado en sessionStorage, ruta en
localStorage). Si el formulario abierto tiene cambios sin guardar, no recarga y avisa en Odoo. En los dos casos en que no cambia (formulario sucio, compañía no permitida) le manda al SPA `switch-company-failed`, que lo avisa en el chat.

## La gota (`targets`, `point`)

Todo contexto lleva `targets`: los controles visibles que la persona puede tocar
(hasta 300), cada uno con un id por posición, su rol y el nombre que lee la
persona. Con un diálogo abierto, sólo los del diálogo. Una pestaña cerrada suma
`contains`, los campos que tiene adentro. Cuando la pantalla cambia sin cambiar el
registro (una pestaña, un diálogo), el host re-publica el contexto si la lista
cambió.

`point` llega recién después de que la tool `odoo_point` validó el id contra la
lista del turno. Como los ids son posiciones, el host marca el control de ese id
sólo si sigue teniendo el mismo `name` y `role`. Si no, busca en la pantalla el
único control con ese nombre y rol; si no hay ninguno o hay más de uno, avisa que
lo marcado ya no está en la pantalla. La gota se va sola a los 30 segundos, o antes si la persona hace clic en el control o en su etiqueta, si el control deja de verse o si se pasa a otro registro. La lista contra la que resuelve es la
última que llegó al SPA: leer la pantalla para comparar no la reemplaza.

Del lado de Tuqui la lista vive sólo en el turno: no se guarda con el mensaje.

## Contexto de una vista (`kind:"view"`)

Toda vista con búsqueda que no es un form (lista, kanban, pivot, gráfico,
calendario, y cualquier otro tipo, nativo o custom) publica su contexto desde un
solo lugar, el patch de `WithSearch` (`search/with_search_patch.js`). Publica sólo
la vista principal de la acción: la que recibe del action service el
`__getGlobalState__` y no tiene otra búsqueda arriba. Una vista en un diálogo, en
un dashlet o embebida en el html de un form (Knowledge) no le saca la página al
form. Una búsqueda nueva se publica una vez, cuando la vista terminó de recargar:
nunca el dominio nuevo con el estado que la vista tenía antes.

```jsonc
{ "kind": "view", "model": "sale.order", "modelLabel": "Pedidos", "viewType": "pivot",
  "jsClass": "…",                        // sólo si la vista tiene js_class
  "domain": [ … ], "groupBy": ["user_id"], "filters": ["Mis pedidos"],
  "context": { "pivot_measures": ["amount_total"], "pivot_row_groupby": ["user_id"] },
  "range": { "start": "2026-10-19", "end": "2026-10-25" } }  // sólo en el calendario
```

`context` va en el formato de «Guardar en favoritos»: lo que cada vista
registra para sus favoritos (`useSetupAction({getContext})`), filtrado a las
claves de vista (`pivot_*`, `graph_*`, `cohort_*`, `gantt_*`, `planning_*`,
`grid_*`, `map_*`). El contexto de los filtros activos, que el favorito también
guarda, es de la búsqueda y no viaja. Lo que el agente lee en un turno es lo que
puede devolver en `navigate` para abrir la misma vista.

## Navegar (`navigate`)

`navigate` llega después de que la tool `odoo_open_view` validó el pedido. El
host abre todo con `doAction`, que chequea permisos como cualquier pantalla; si
no puede abrir lo pedido, lo avisa y no mueve la pantalla. Los modos están en
`capabilities.navigate`:

- **`record`:** el form de `resId`.
- **`browse`:** `model` sobre `domain` en `viewType` (cualquier tipo registrado;
  un js_class abre como su tipo, y un form abre como lista), con `groupBy` y el
  `context` de vista que reporta `kind:"view"`.
- **`action`:** una acción de ventana o de cliente por `xmlid` (`módulo.nombre`)
  o por `menuId`, entre los menús que Odoo cargó para el usuario. `section` va
  como `context.module` (Ajustes). Una acción de servidor o una URL no se abren.
  Como en Odoo, un menú arranca de cero desde su app y un `xmlid` se apila en
  los breadcrumbs.
- **`new`:** un form vacío con `defaults` como `default_<campo>`.

## Selección de lista y multi-registro

Cuando el usuario tiene N filas seleccionadas, el contexto baja como
`kind:"selection"` con `count` y **todos** los `resIds`, sin tope. Tuqui no los
imprime en el prompt cuando son más de 25: el agente los pide con
`odoo_get_selected_ids`, por páginas. Un payload con `truncated: true` viene de
una versión anterior del addon, que cortaba en 200. Con «seleccionar todos»
viaja `allMatching: true` y el `domain` en lugar de los ids, y `count` es el
total de registros que matchean: en una vista agrupada, registros, no grupos.

La corrida multi-registro **no pasa por `postMessage`**: el SPA llama a la tool
`run_over_selection`, que persiste un batch del lado de Tuqui y lo corre en
background. Eso es lo que hace que sobreviva a que se cierre el panel; el
resultado de cada registro queda como **nota interna en su chatter**, y el
reporte por registro se consulta con `check_selection_run`. Nada de eso necesita
que el iframe siga vivo.

`targetOrigin`: el host usa `new URL(base_url).origin`. El host valida que cada
mensaje entrante venga del iframe montado (`ev.source === iframe.contentWindow`)
**y** de un origin concreto que matchee el del SPA — nunca acepta `"*"` (si la
base no resuelve, descarta el mensaje). El SPA captura el origin del host de su
primer mensaje.

## Archivos

- **Odoo** (`Tuqui-AI/odoo-addons`, ramas `18.0` y `19.0`):
  `static/src/panel/panel.js` (iframe + listener + SSO/auth post +
  `apply-result`), `services/tuqui_assistant_service.js` (`getEmbedBootstrap`,
  `getSsoAuth`, `getContextPayload`, `applyProposal`→`record._update`,
  `proposeChatter`, `settleProposal`),
  `panel.xml` (iframe vs prompt de conexión),
  `models/tuqui_assistant_sso_nonce.py` (`embed_bootstrap`,
  `issue_for_current_user`, `redeem`), `controllers/sso.py` (`/exchange`).
- **Tuqui** (`tuqui` rama `feat/embed-mode-odoo`): `web/src/hooks/useEmbedBridge.ts`,
  `web/src/pages/EmbedChatPage.tsx`, ruta en `web/src/main.tsx`, CSP en
  `tuqui_core/main.py`, endpoint de canje del embed-token.

## Estado / pendiente (al integrar local)

- [ ] Verificar que el SPA se deja iframear con el CSP nuevo.
- [ ] Inyectar `odooContext` en el turno de Tuqui (que el agente "sepa" el registro abierto).
- [ ] Disparar `postProposalToHost(changes)` desde el resultado de la tool `propose_odoo_form_changes`.
- [ ] Navegación interna de ChatPage (`/w/:slug/...`) en modo embed: mantenerla dentro de `/embed/...`.
