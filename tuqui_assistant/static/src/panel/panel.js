/** @odoo-module **/
import { Component, useState, useRef, useEffect, onWillStart, onMounted, onWillUnmount } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { delay } from "@web/core/utils/concurrency";
import { listenSizeChange, MEDIAS_BREAKPOINTS, SIZES, utils as uiUtils } from "@web/core/ui/ui_service";
import { _t } from "@web/core/l10n/translation";
import { user } from "@web/core/user";
import { switchCompany } from "@tuqui_assistant/services/tuqui_assistant_service";
import { APPLY_RESULT_KINDS, NAVIGATE_MODES } from "@tuqui_assistant/services/tuqui_assistant_service";
import { isGotaMutation } from "@tuqui_assistant/screen/gota";
import { makeWalkSession, readProposalId } from "@tuqui_assistant/show_me/walk_session";
import { makeWaitSession } from "@tuqui_assistant/show_me/wait_step";

// Odoo reflows to the docked panel before the walk reads the screen.
const DOCK_MS = 400;

// What the host announces to the SPA, in `auth` and in every `context`.
function hostCapabilities() {
    // `menu_button`: the header carries the SPA's conversations menu (the logo),
    // so the SPA does not draw its own button.
    return { apply_result: [...APPLY_RESULT_KINDS], navigate: [...NAVIGATE_MODES], menu_button: true };
}

// Kind of an `apply`: the SPA's own, or `form_html` for an html co-edit.
function proposalKind(payload) {
    if (payload?.kind) {
        return payload.kind;
    }
    return payload?.htmlBase || payload?.selection ? "form_html" : "form_changes";
}

const MENU_HINT_KEY = "tuqui_menu_hint_shown";
const MENU_HINT_TIMES = 2;
// Matches the length of the o-tuqui-menu-hint animation in panel.scss.
const MENU_HINT_MS = 3200;

// How long we wait for the SPA's greeting before calling the iframe stuck.
// Generous on purpose: a cold start on a bad connection takes a while, and
// treating that as a block would be a wrong diagnosis shown with confidence.
const EMBED_HANDSHAKE_TIMEOUT_MS = 12000;
// How long the screen must stay still before its list of targets is re-read.
const SCREEN_SETTLE_MS = 500;
// Tuqui checks a new copy in the background, usually within seconds: the open
// panel asks again a few times so the copy connects on its first open.
const COPY_RETRY_MS = 3000;
const COPY_RETRIES = 8;

// How far above the bottom edge Odoo's bubble column may end and still count as
// sitting in the corner. Odoo keeps it about 10px up (BUBBLE_OUTER) and lifts it
// 25px more (35px on a phone, 19.0+) while the bus reports connection issues. A
// column dragged elsewhere (19.0+) ends far higher.
const LAUNCHER_CORNER_SLACK = 80;

/**
 * The panel posts the context to the SPA again only when this key changes, so it
 * holds every key that changes what the SPA shows.
 */
export function contextKey(c) {
    if (!c) {
        return "";
    }
    switch (c.kind) {
        case "record":
            // `dirty` flips once; `revision` goes up on every in-memory change.
            return `record:${c.model}:${c.resId}:${c.dirty}:${c.revision}`;
        case "selection":
            // The ids, not their number (as in the list's effect deps), and the
            // domain for "select all", whose count can stay with a new filter.
            return `sel:${c.model}:${c.count}:${(c.resIds || []).join(",")}:${JSON.stringify(c.domain || [])}`;
        case "view":
            // All of it: what changes it comes from the search, the view itself (a
            // pie chart, the next week) or another action on the same model.
            return `view:${JSON.stringify(c)}`;
    }
    return "";
}

/**
 * The size Odoo would report for a viewport of `width`.
 *
 * Asked of Odoo's own table instead of a copy of it: the index into
 * MEDIAS_BREAKPOINTS IS the SIZES value (that is how `utils.getSize` reads it),
 * and the table is not the same across versions — 18.0 has seven bands and puts
 * XXL at 1534, 19.0 has six and puts it at 1400. A mirrored list would give the
 * wrong answer on the other version while looking perfectly right.
 *
 * @returns {number} one of SIZES
 */
export function sizeForWidth(width) {
    // Floored on the way in: the widths this gets come from
    // `getBoundingClientRect`, which is fractional, and Odoo's table leaves a
    // 1px hole between bands (…1199 | 1200…). A width of 1199.4 matched no band
    // at all, `findIndex` returned -1 and a wide screen was reported as the
    // smallest size. The observer samples every frame of the 340ms morph, so on
    // a 1920px screen the remaining room travels 1528→1152 and lands in that
    // hole on the way.
    const floored = Math.floor(width);
    const index = MEDIAS_BREAKPOINTS.findIndex(
        ({ minWidth, maxWidth }) =>
            (minWidth === undefined || floored >= minWidth) &&
            (maxWidth === undefined || floored <= maxWidth)
    );
    return index === -1 ? SIZES.XS : index;
}

/**
 * Panel lateral del asistente Tuqui.
 *
 * Embebe el SPA de Tuqui en un `<iframe>` (modo embed) y reusa TODA su UI
 * (composer, micrófono, artifacts, streaming). NO hay system param ni shell de
 * chat nativo de fallback: la URL del embed se DERIVA del companion.
 *
 *  - La base de Tuqui (`tuqui.base_url`, default `https://tuqui.com`) y el slug
 *    del workspace activado salen de `getEmbedBootstrap()` → `embed_bootstrap`
 *    del modelo, que lee el oauth client del companion. Si el companion no está
 *    `active` (o no hay slug), `connected` es false y el panel muestra un prompt
 *    "conectá Tuqui desde Ajustes" en lugar del iframe — sin fallback.
 *  - Auth: SSO sin login. Al abrir, el panel mintea un nonce single-use atado
 *    al usuario Odoo (`issue_for_current_user`) y al `ready` se lo pasa al iframe
 *    por postMessage; el SPA lo canjea por una sesión.
 *  - Contexto del form baja por postMessage; las propuestas de cambio suben y se
 *    aplican en memoria con el bridge `record._update` (Guardar/Descartar nativo).
 *
 * Protocolo postMessage (alineado con el hook `useEmbedBridge` del SPA):
 *  Odoo → SPA: { source: "tuqui-odoo", type: "auth",     payload: { client_id, nonce } }
 *              { source: "tuqui-odoo", type: "context",  payload: PageContext }
 *              { source: "tuqui-odoo", type: "resume",   payload: { path } }
 *              { source: "tuqui-odoo", type: "layout",   payload: { docked } }
 *              { source: "tuqui-odoo", type: "toggle-menu" }
 *  SPA → Odoo: { source: "tuqui-spa",  type: "ready" }
 *              { source: "tuqui-spa",  type: "error" }   // crashed before "ready": show the block now
 *              { source: "tuqui-spa",  type: "apply",    payload: { changes, rationale } }
 *              { source: "tuqui-spa",  type: "chatter",  payload: { mode, body, subject } }
 *              { source: "tuqui-spa",  type: "navigate", payload: { mode, model, resId, viewType, domain, groupBy, context, defaults, xmlid, menuId, section, title } }
 *              { source: "tuqui-spa",  type: "switch-company", payload: { companyId } }
 *              { source: "tuqui-spa",  type: "reauth" }   // nonce nuevo para renovar la sesión del panel
 *              { source: "tuqui-spa",  type: "reload" }   // releer la vista tras una escritura por atrás
 *              { source: "tuqui-spa",  type: "save" }     // guardar el form abierto (lo pidió el usuario)
 *              { source: "tuqui-spa",  type: "point",    payload: { target, name, role } }  // mark a control of the screen's list
 *              { source: "tuqui-spa",  type: "point",    payload: { name, section, proposalId } }  // find it on screen now, answered in apply-result
 *              { source: "tuqui-spa",  type: "show-me",  payload: { goal, proposalId } }  // walk the screen to goal
 *              { source: "tuqui-spa",  type: "show-me-step-result", id, ok, result | error }
 *              { source: "tuqui-spa",  type: "wait-step", payload: { proposalId, kind: "wait_step", waiting_line, done_line } }  // wait in silence
 *              { source: "tuqui-spa",  type: "wait-cancel", payload: { proposalId } }  // the person wrote: the wait ends
 *  Odoo → SPA: { source: "tuqui-odoo", type: "show-me-step", id, payload: { goal, screen, actions, history } }
 *              { source: "tuqui-odoo", type: "step-event", payload: { proposal_id, outcome: happened | idle, happened, screen? } }
 *              { source: "tuqui-spa",  type: "location", payload: { path } }
 *              { source: "tuqui-spa",  type: "external-link-opening" }
 *
 * El host valida que cada mensaje venga del iframe montado (`ev.source ===
 * iframe.contentWindow`) Y de un origin concreto que matchee el del SPA (nunca
 * "*"). Ver `_handleMessage`.
 */
export class TuquiPanel extends Component {
    static props = {};
    static template = "tuqui_assistant.Panel";

    setup() {
        this._walks = makeWalkSession({
            post: (id, payload) => this._postShowMeStep(id, payload),
            getContext: () => this.state.context,
            isHidden: () => !this.state.panelOpen || this.state.minimized,
        });
        // Keeps listening with the panel minimized: the person works on the screen meanwhile.
        this._waits = makeWaitSession({
            notify: (payload) => this._postToSpa({ type: "step-event", payload }),
        });
        this.tuquiAssistant = useService("tuquiAssistant");
        this.notification = useService("notification");
        this.state = useState(this.tuquiAssistant.state); // { panelOpen, context }
        this.ui = useState({
            // Resolved from the companion (oauth client): whether connected, the
            // Tuqui base URL (tuqui.base_url), and the activated workspace slug.
            // The embed URL is no longer a hardcoded param.
            connected: false,
            // A copy of a connected database, and how its registration went.
            copyPending: false,
            copyStatus: null,
            baseUrl: null,
            slug: null,
            embedReady: false,
            // The iframe mounted and the SPA never said hello. It is the ONLY
            // signal available: a frame blocked by `frame-ancestors` is answered
            // 200, so it fires no `onerror` and leaves no network trace. A missing
            // handshake usually means this domain is not in Tuqui's header, but it
            // can also just be slow, which is why the copy says both.
            embedBlocked: false,
            // The SPA said it crashed before greeting: no reason to wait out the timeout.
            embedFailed: false,
            // Whether Tuqui lets this URL frame the panel, and the main URL to
            // suggest when it does not. Only read once the frame is stuck.
            originAuthorized: true,
            mainOrigin: null,
            // Last SPA path (e.g. /w/:slug/chat/:id), persisted in localStorage so
            // the conversation resumes on page reload or panel reopen. Updated when
            // the SPA posts "location"; used in embedUrl to load the right
            // conversation in the iframe.
            storedPath: null,
            // The logo plays its turn into the menu icon on its own, for the
            // first few opens, so people learn it is the menu.
            menuHint: false,
        });
        this.iframeRef = useRef("iframe");
        this.panelRef = useRef("panel");
        this.uiService = useService("ui");

        const _storageKey = () => this.ui.slug ? `tuqui_embed_path_${this.ui.slug}` : null;

        const loadBootstrap = async ({ registerCopy = false } = {}) => {
            let boot = await this.tuquiAssistant.getEmbedBootstrap();
            // One registration at a time: reopening the panel while it retries joins it.
            if (registerCopy && boot?.copy_pending && !this._registeringCopy) {
                this._registeringCopy = true;
                this.ui.copyStatus = "registering";
                try {
                    let { status } = await this.tuquiAssistant.registerTestCopy();
                    for (let i = 0; i < COPY_RETRIES && ["pending", "busy"].includes(status) && this.state.panelOpen; i++) {
                        await new Promise((resolve) => setTimeout(resolve, COPY_RETRY_MS));
                        ({ status } = await this.tuquiAssistant.registerTestCopy());
                    }
                    this.ui.copyStatus = status;
                } finally {
                    this._registeringCopy = false;
                }
                boot = await this.tuquiAssistant.getEmbedBootstrap();
                if (boot?.connected && this.state.panelOpen) {
                    // The frame mounts only now: its handshake gets the full wait.
                    this._armEmbedWatchdog();
                }
            }
            this.ui.copyPending = Boolean(boot?.copy_pending);
            this.ui.connected = Boolean(boot?.connected);
            this.ui.baseUrl = boot?.base_url || null;
            this.ui.slug = boot?.slug || null;
            this.ui.originAuthorized = boot?.origin_authorized !== false;
            this.ui.mainOrigin = boot?.main_origin || null;
            // Restore the last conversation from localStorage (keyed by slug to
            // avoid cross-workspace contamination). Used in embedUrl so the iframe
            // loads where the user left off instead of starting a new chat.
            if (this.ui.slug) {
                this.ui.storedPath = localStorage.getItem(_storageKey()) || null;
            }
        };
        onWillStart(() => loadBootstrap());
        // Re-check on panel open/close:
        //   - Open: re-verify connection (admin may have disconnected) + reset auth.
        //   - Close: sync storedPath from localStorage so the next open loads the
        //     right conversation. Done on CLOSE (not open) because the iframe is
        //     already unmounted (t-if), so storedPath can change without causing a
        //     src reload. The SPA only posts "location" while mounted → localStorage
        //     is stable at close time.
        // Minimizing or closing keeps the panel mounted: the walk would go on unseen.
        useEffect(
            (open, minimized) => {
                if (!open || minimized) {
                    this._walks.abort();
                }
            },
            () => [this.state.panelOpen, this.state.minimized]
        );
        useEffect(
            () => {
                if (this.state.panelOpen) {
                    this.ui.embedReady = false;
                    this.ui.embedBlocked = false;
                    this.ui.embedFailed = false;
                    this._armEmbedWatchdog();
                    this._authPosted = false;
                    this._menuHintDone = false;
                    this.ui.menuHint = false;
                    this._lastSpaPath = null;
                    // Minted now so it overlaps the iframe load. Single-use: _postAuth
                    // awaits this promise instead of minting a second nonce.
                    this._ssoAuthPromise =
                        this.ui.connected && this.ui.slug
                            ? this.tuquiAssistant.getSsoAuth()
                            : null;
                    void loadBootstrap({ registerCopy: true });
                    if (this._panelObserver && this.panelRef.el) {
                        this._panelObserver.observe(this.panelRef.el);
                    }
                } else {
                    this._clearEmbedWatchdog();
                    // Panel closed → iframe unmounted → safe to update stored path.
                    if (this.ui.slug) {
                        this.ui.storedPath = localStorage.getItem(_storageKey()) || null;
                    }
                    // Reset expanded state; the useEffect on state.expanded removes
                    // the html class automatically.
                    if (this.state.expanded) {
                        this.tuquiAssistant.contract();
                    }
                }
            },
            () => [this.state.panelOpen]
        );

        // postMessage bridge with the SPA iframe.
        this._onMessage = this._handleMessage.bind(this);
        this._phoneQuery = window.matchMedia("(max-width: 575.98px)");
        this._onPhoneChange = () => this._postLayout();
        useEffect(
            () => this._postLayout(),
            () => [this.state.expanded]
        );

        // Odoo stacks its own chat launchers/windows pinned to the bottom-right
        // corner — exactly where our floating card and bubble live, so they overlap.
        // Instead of a fixed gap, measure how much room that cluster takes on the
        // right edge and slide Tuqui left by that much via the --o-tuqui-chat-offset
        // CSS var. With no chat open the cluster is empty → offset 0 → Tuqui sits
        // flush right; when a window or bubble appears Tuqui slides left beside it.
        //
        // NOTE: the .o-mail-ChatHub root is a zero-size STATIC wrapper — it has no
        // position/size of its own; every visible piece inside it is position:fixed
        // (each .o-mail-ChatWindow and the .o-mail-ChatHub-bubbles pile). Measuring
        // the hub returns a 0×0 rect, so the offset never kicked in. Measure
        // the fixed children instead and take the leftmost edge of the whole cluster.
        //
        // The same pass places our launcher bubble: on top of Odoo's own bubble
        // column when it has bubbles in the corner, in its first slot when not.
        // A column dragged away from the corner (19.0+) leaves the slot free.
        const _syncChatOffset = () => {
            let offset = 0;
            let launcherLift = 0;
            const parts = document.querySelectorAll(
                ".o-mail-ChatWindow, .o-mail-ChatHub-bubbles"
            );
            let minLeft = Infinity;
            for (const el of parts) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    minLeft = Math.min(minLeft, rect.left);
                    const inCorner =
                        el.classList.contains("o-mail-ChatHub-bubbles") &&
                        rect.bottom >= window.innerHeight - LAUNCHER_CORNER_SLACK;
                    if (inCorner) {
                        launcherLift = Math.max(0, Math.round(window.innerHeight - rect.top));
                    }
                }
            }
            if (minLeft !== Infinity) {
                offset = Math.max(0, Math.round(window.innerWidth - minLeft) + 12);
            }
            const root = document.documentElement.style;
            root.setProperty("--o-tuqui-chat-offset", `${offset}px`);
            root.setProperty("--o-tuqui-launcher-lift", `${launcherLift}px`);
        };
        // Coalesce bursts of DOM mutations into a single measurement per frame.
        let _offsetRaf = null;
        const _scheduleSyncChatOffset = () => {
            if (_offsetRaf !== null) {
                return;
            }
            _offsetRaf = requestAnimationFrame(() => {
                _offsetRaf = null;
                _syncChatOffset();
            });
        };
        this._chatHubObserver = null;

        // Odoo lays out for the VIEWPORT, not for the room it actually has. The
        // chatter sits beside the form only while `ui.size` is XXL (see
        // `mail/…/chatter/web/form_renderer.js`), and expanding the panel does not
        // change the viewport — it only takes width away through the body padding.
        // The chatter therefore stayed on the side and got squeezed together with
        // the breadcrumb and the pager. Reporting the size of what is LEFT makes
        // Odoo lay out for that instead: the chatter drops below the form, exactly
        // as it would in a narrower window, and every other view follows.
        //
        // The ui service recomputes `size` on every window resize, so this has to
        // run again after it — hence listenSizeChange, which fires once the
        // service has already written its own value.
        //
        // And it cannot be measured once: the card takes 340ms to travel from
        // floating to docked, so a single read right after the click returns the
        // width it is LEAVING. On a 1920px screen that was 392 instead of 768 —
        // 1528px of room instead of 1152 — which reads as XXL and left the
        // chatter on the side, exactly the case this whole thing exists for. A
        // ResizeObserver on the card answers on every frame of the morph, and
        // keeps answering if the width ever changes for another reason.
        // Three things this has to get right, and each one bit:
        //
        //  - `isSmall` is a plain field of the same reactive, not derived from
        //    `size`: the service writes both together and `env.isSmall` reads
        //    that field. Writing only `size` left ~480 call sites across addons
        //    reading a stale boolean that now contradicts the size.
        //  - Nobody re-renders on `size` alone. The chatter redraws on a
        //    debounce hung off the window `resize`, so a value written after the
        //    first frame — which is every value the observer produces while the
        //    card travels — reached no one without saying so.
        //  - The dispatch would loop: the service recomputes from the viewport,
        //    finds a different value, writes it and fires the bus, which calls
        //    this back. Announcing only when OUR value actually changed breaks
        //    the cycle while still re-asserting the value the service just
        //    overwrote.
        let _lastAnnounced = null;
        const _applySize = (size) => {
            const changed = size !== _lastAnnounced;
            _lastAnnounced = size;
            if (this.uiService.size !== size) {
                this.uiService.size = size;
            }
            const small = size <= SIZES.SM;
            if (this.uiService.isSmall !== small) {
                this.uiService.isSmall = small;
            }
            if (changed) {
                window.dispatchEvent(new Event("resize"));
            }
        };

        this._sizeOverridden = false;
        // The gutter belongs to a card that is ON SCREEN, so the three flags have
        // to agree. Today `expanded` cannot outlive a closed panel — the effect
        // on `panelOpen` above calls `contract()`, on close AND on the first
        // render, which is what clears a `{panelOpen: false, expanded: true}`
        // restored from a previous session. But that leaves the invariant
        // resting on the DECLARATION ORDER of two effects: move this one up and
        // the body reserves 354-768px of padding for a card that is not mounted,
        // while `_syncHostSize` measures a null `panelRef.el`. Saying it here
        // costs one term and does not depend on that order.
        const _isCovering = () =>
            this.state.panelOpen && this.state.expanded && !this.state.minimized;
        const _syncHostSize = () => {
            const covering = _isCovering();
            if (!covering) {
                if (this._sizeOverridden) {
                    this._sizeOverridden = false;
                    // Al soltar el override se le devuelve a Odoo SU respuesta,
                    // no una nuestra: `utils.getSize()` sale de las mismas media
                    // queries que el servicio, mientras que `window.innerWidth`
                    // incluye la barra de scroll clásica. A unos píxeles de un
                    // borde de banda los dos números difieren y quedaba escrito
                    // un tamaño que las media queries de Odoo contradicen.
                    _applySize(uiUtils.getSize());
                }
                return;
            }
            // El ancho libre se mide, no se pregunta: Odoo no sabe nada del
            // panel. `documentElement.clientWidth` es el viewport SIN la barra
            // de scroll, que es contra lo que resuelven sus media queries.
            const viewport = document.documentElement.clientWidth || window.innerWidth;
            const panelWidth = this.panelRef.el?.getBoundingClientRect().width || 0;
            this._sizeOverridden = true;
            _applySize(sizeForWidth(Math.max(0, viewport - panelWidth)));
        };

        onMounted(() => {
            window.addEventListener("message", this._onMessage);
            this._phoneQuery.addEventListener("change", this._onPhoneChange);
            this._stopListeningSize = listenSizeChange(_syncHostSize);
            // The bus is not enough: the service compares against the value WE
            // wrote, so when the real size happens to equal the override it
            // never fires — and the panel would keep reporting a stale one.
            window.addEventListener("resize", _syncHostSize);
            this._panelObserver = new ResizeObserver(_syncHostSize);
            if (this.panelRef.el) {
                this._panelObserver.observe(this.panelRef.el);
            }
            // A chat window opening/closing adds or removes nodes under <body>,
            // changing the ChatHub footprint — re-measure on any such mutation.
            _syncChatOffset();
            this._chatHubObserver = new MutationObserver(_scheduleSyncChatOffset);
            this._chatHubObserver.observe(document.body, { childList: true, subtree: true });
            window.addEventListener("resize", _scheduleSyncChatOffset);
            // A tab, a dialog or a settings block changes what can be touched without
            // changing the record, so the context would keep an old list of targets.
            // Re-post it when the list changed, after the screen settles.
            this._screenObserver = new MutationObserver((records) => {
                // The drop re-aims every 300 ms: counting it as a change would keep
                // the screen from ever settling while a mark is up.
                if (!this.ui.connected || !this.ui.embedReady || records.every(isGotaMutation)) {
                    return;
                }
                clearTimeout(this._screenTimer);
                this._screenTimer = setTimeout(() => this._postContextIfScreenChanged(), SCREEN_SETTLE_MS);
            });
            this._screenObserver.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ["class", "style"],
            });
        });
        onWillUnmount(() => {
            // A walk outliving the panel would keep its cursor until a step timed out.
            this._walks.dispose("the panel was closed");
            this._waits.dispose();
            this._screenObserver?.disconnect();
            clearTimeout(this._screenTimer);
            this._clearEmbedWatchdog();
            window.removeEventListener("message", this._onMessage);
            this._phoneQuery.removeEventListener("change", this._onPhoneChange);
            this._stopListeningSize?.();
            window.removeEventListener("resize", _syncHostSize);
            this._panelObserver?.disconnect();
            // Give Odoo its real size back: leaving the override in place would
            // keep the chatter below the form after the panel is gone.
            if (this._sizeOverridden) {
                this._sizeOverridden = false;
                _applySize(uiUtils.getSize());
            }
            document.documentElement.classList.remove("o-tuqui-expanded");
            this._chatHubObserver?.disconnect();
            window.removeEventListener("resize", _scheduleSyncChatOffset);
            if (_offsetRaf !== null) {
                cancelAnimationFrame(_offsetRaf);
            }
            document.documentElement.style.removeProperty("--o-tuqui-chat-offset");
            document.documentElement.style.removeProperty("--o-tuqui-launcher-lift");
        });

        // When the context changes (open record / unsaved edits), re-push it
        // to the iframe if it is already ready.
        useEffect(
            () => {
                if (this.ui.connected && this.ui.embedReady) {
                    this._postContext();
                }
            },
            () => [contextKey(this.state.context)]
        );

        // Manage the split-screen class on <html> via a useEffect so it fires
        // AFTER OWL has updated the DOM (panel already has o-tuqui-expanded class
        // and its expanded layout). If classList.add were called in expand() directly,
        // it would run before OWL's render → body padding kicks in while the panel
        // is still in its small position → layout doesn't reflow correctly on the
        // first expand (Ctrl+R was needed to fix it).
        //
        // The split-screen gutter only makes sense while the card is visible.
        // Hiding the card keeps `expanded` set so showing it again brings the
        // expanded layout back — so the gutter has to be released on hide and
        // re-applied on show. Gating on !minimized (and depending on it) fixes
        // the reserved empty space that lingered when hiding from the expanded
        // state.
        useEffect(
            () => {
                if (_isCovering()) {
                    document.documentElement.classList.add("o-tuqui-expanded");
                } else {
                    document.documentElement.classList.remove("o-tuqui-expanded");
                }
                requestAnimationFrame(() => {
                    // First read after the class lands; the ResizeObserver keeps
                    // reading through the morph. Both go through _applySize,
                    // which announces the change itself.
                    _syncHostSize();
                    window.dispatchEvent(new Event("resize"));
                });
            },
            () => [this.state.panelOpen, this.state.expanded, this.state.minimized]
        );
    }

    // --- iframe (L1) ---

    /**
     * Start the clock that notices an iframe which is never going to talk.
     *
     * A clock and not an `onerror` because the browser **does not tell us**: a
     * frame blocked by `frame-ancestors` is answered 200 and the browser paints
     * its own error page inside it, with no event, nothing in the host's console
     * and nothing the server could log. Seen from here, the only thing that
     * changes is that the SPA's greeting never arrives.
     *
     * Hence the generous threshold: a cold SPA start on a bad connection takes a
     * while, and mistaking that for a block would be worse than waiting too
     * long. This does not race the spinner; it appears once there is nothing
     * left to wait for.
     */
    _armEmbedWatchdog() {
        this._clearEmbedWatchdog();
        this._embedWatchdog = setTimeout(() => {
            this._embedWatchdog = null;
            if (!this.ui.embedReady) {
                this.ui.embedBlocked = true;
                // A late "ready" may come after the pre-minted nonce's TTL: mint then.
                this._ssoAuthPromise = null;
            }
        }, EMBED_HANDSHAKE_TIMEOUT_MS);
    }

    _clearEmbedWatchdog() {
        if (this._embedWatchdog) {
            clearTimeout(this._embedWatchdog);
            this._embedWatchdog = null;
        }
    }

    /**
     * The domain this person is reaching Odoo through.
     *
     * Shown in the stuck-panel message because it is what turns "it does not
     * work" into something actionable: whoever reads it can compare it against
     * the domain Tuqui has registered, and whoever reports it saves us the first
     * question.
     */
    get currentOrigin() {
        return window.location.origin;
    }

    get embedUrl() {
        if (!this.ui.connected || !this.ui.baseUrl || !this.ui.slug) {
            return "";
        }
        const base = this.ui.baseUrl.replace(/\/+$/, "");
        const slug = encodeURIComponent(this.ui.slug);
        // Always load the root embed URL. Deep-linking to a conversation path
        // causes the SPA to try fetching it before authentication (the nonce
        // arrives only after "ready"), so it renders a 404. The stored path is
        // sent as a "resume" postMessage right after the auth message instead.
        return `${base}/embed/${slug}?embed=1`;
    }

    get _spaOrigin() {
        try {
            return new URL(this.ui.baseUrl).origin;
        } catch {
            console.warn("[tuqui_assistant] Invalid baseUrl, cannot derive SPA origin:", this.ui.baseUrl);
            return null;
        }
    }

    // A retry needs a fresh nonce: the pre-minted one may be spent or expired.
    _resetAuth() {
        this._authPosted = false;
        this._ssoAuthPromise = null;
    }

    async _postAuth() {
        // Embedded SSO: mint a nonce bound to the Odoo user and pass it to the
        // iframe; the SPA redeems it for a session token (no login prompt).
        // If the companion is not active, getSsoAuth() → null.
        //
        // Only once per panel open: the SPA posts "ready" multiple times (gate +
        // ChatPage + re-renders) and an extra nonce gets spent twice → 401 on
        // exchange → apiFetch logs the user out. The flag is reset on every open.
        //
        // The lock is set BEFORE the await: two concurrent "ready" events would
        // both pass the check if the flag were set after, each minting its own nonce.
        // Only the first advances; subsequent ones see the flag already set.
        // Reset to false on all error paths to allow a retry.
        if (this._authPosted) {
            return;
        }
        this._authPosted = true;
        const win = this.iframeRef.el?.contentWindow;
        if (!win) {
            this._resetAuth();
            return;
        }
        const auth = await (this._ssoAuthPromise ?? this.tuquiAssistant.getSsoAuth());
        if (!auth?.nonce || !auth?.client_id) {
            this._resetAuth();
            return;
        }
        try {
            win.postMessage(
                {
                    source: "tuqui-odoo",
                    type: "auth",
                    payload: {
                        client_id: auth.client_id,
                        nonce: auth.nonce,
                        capabilities: hostCapabilities(),
                        // The language of whoever is in Odoo: the iframe has no
                        // session yet, and its own detection reads partitioned
                        // storage that lands on English.
                        lang: user.lang,
                    },
                },
                this._spaOrigin
            );
            // After auth, tell the SPA to resume at the last conversation — but
            // only on "restore" opens (page reload with panel already open, or a
            // tab triggered by an external-link signal). Deliberate close → reopen
            // from the systray should start a fresh chat, not resume. The one-time
            // flag is consumed here so any subsequent open in this session starts fresh.
            if (this.ui.storedPath && this.tuquiAssistant.consumeResumeOnOpen()) {
                win.postMessage(
                    { source: "tuqui-odoo", type: "resume", payload: { path: this.ui.storedPath } },
                    this._spaOrigin
                );
            }
        } catch {
            // different origin / iframe not yet navigated: retried on the next "ready"
            this._resetAuth();
        }
    }

    /** The host refused a switch the backend had accepted: the reply already said
     *  the company changed, so the chat has to hear about it too. */
    /**
     * Tell the SPA whether the card is docked or floating. The SPA shows its
     * menu button only on a docked card (expanded, or a phone, where the card
     * fills the screen) and hides it on the small floating one. It
     * cannot tell from its own width: on a 1366px screen the docked card is
     * 354px wide and the floating one 392px. The phone check is the same media
     * query as panel.scss, not `ui.isSmall`, which this panel overrides while
     * docked.
     */
    _postLayout() {
        const win = this.iframeRef.el?.contentWindow;
        if (!win || !this.ui.embedReady) {
            return;
        }
        const docked = this.state.expanded || this._phoneQuery.matches;
        try {
            win.postMessage(
                { source: "tuqui-odoo", type: "layout", payload: { docked } },
                this._spaOrigin
            );
        } catch {
            // different origin / iframe not yet navigated: sent again on "ready".
        }
    }

    _maybeShowMenuHint() {
        // "ready" arrives more than once per open; the hint plays once per open.
        if (this._menuHintDone) {
            return;
        }
        this._menuHintDone = true;
        let shown = 0;
        try {
            shown = Number(localStorage.getItem(MENU_HINT_KEY)) || 0;
            if (shown >= MENU_HINT_TIMES || this.ui.menuHint) {
                return;
            }
            localStorage.setItem(MENU_HINT_KEY, String(shown + 1));
        } catch {
            return;
        }
        this.ui.menuHint = true;
        setTimeout(() => {
            this.ui.menuHint = false;
        }, MENU_HINT_MS);
    }

    /** Ask the SPA to open or close its conversations menu (the logo button). */
    toggleSpaMenu() {
        const win = this.iframeRef.el?.contentWindow;
        if (!win || !this.ui.embedReady) {
            return;
        }
        try {
            win.postMessage({ source: "tuqui-odoo", type: "toggle-menu" }, this._spaOrigin);
        } catch {
            // different origin / iframe not yet navigated: nothing to toggle yet.
        }
    }

    _postSwitchCompanyFailed(companyId) {
        const win = this.iframeRef.el?.contentWindow;
        if (!win) {
            return;
        }
        try {
            win.postMessage(
                { source: "tuqui-odoo", type: "switch-company-failed", payload: { companyId } },
                this._spaOrigin
            );
        } catch (e) {
            console.warn("[tuqui_assistant] Could not post switch-company-failed to iframe:", e);
        }
    }

    _postContextIfScreenChanged() {
        if (!this.ui.connected || !this.ui.embedReady) {
            return;
        }
        const screen = this.tuquiAssistant.readScreen();
        if (JSON.stringify(screen.targets) !== this._postedTargets) {
            this._postContext(screen);
        } else {
            // Same list, so the chat's ids still hold, but the elements behind
            // them may be new nodes: keep the fresh reading for `point`.
            this.tuquiAssistant.rememberScreen(screen);
        }
    }

    _postContext(screen) {
        const win = this.iframeRef.el?.contentWindow;
        if (!win) {
            return;
        }
        // Read only once there is a chat to post to: with the panel closed this
        // used to read the whole screen for nothing.
        screen ??= this.tuquiAssistant.readScreen();
        try {
            // Capabilities first: a consumer that cuts the context by length drops
            // the tail, and this key is small.
            const payload = { capabilities: hostCapabilities(), ...this.tuquiAssistant.getContextPayload(screen) };
            win.postMessage(
                {
                    source: "tuqui-odoo",
                    type: "context",
                    payload,
                },
                this._spaOrigin
            );
            // Only once the chat has the list: `point` resolves its ids against it.
            this.tuquiAssistant.rememberScreen(screen);
            this._postedTargets = JSON.stringify(screen.targets);
        } catch (e) {
            // different origin / iframe not yet navigated: retried on next "ready".
            // Logged (warn, not silent): a DataCloneError here — payload containing a
            // non-cloneable reactive Proxy — once caused list/kanban context to
            // silently never reach the SPA. getContextPayload now returns plain JSON,
            // but if it breaks again it should surface.
            console.warn("[tuqui_assistant] Could not post context to iframe:", e);
        }
    }

    /**
     * Runs a proposal and answers `apply-result` to the SPA.
     *
     * Without `proposalId` (old SPA) it runs as before and answers nothing. A
     * `proposalId` already seen is not run again: its stored result is repeated.
     * A kind this host does not know is rejected as `unsupported`, untouched.
     */
    async _answerProposal(data, kind, run) {
        const proposalId = readProposalId(data);
        if (!proposalId) {
            await run?.();
            return;
        }
        // `apply` carries form kinds, `chatter` carries the chatter one.
        const known =
            run && APPLY_RESULT_KINDS.includes(kind) && (kind === "chatter") === (data.type === "chatter");
        const result = await this.tuquiAssistant.settleProposal(
            proposalId,
            known ? run : () => this._unsupported(kind)
        );
        this._postApplyResult(proposalId, result);
    }

    /**
     * Walks this screen to `goal` (`odoo_show_me`), through `menu` first when Tuqui
     * sent its way, and answers how it ended.
     * Each step asks the SPA, which asks Tuqui's backend: the judgment key is
     * never in this Odoo.
     */
    async _showMe(goal, proposalId, menu) {
        // The walk's time counts from here: Tuqui is already waiting while the panel docks.
        const startedAt = performance.now();
        const refused = this._walks.refusal();
        if (refused) {
            return refused;
        }
        // A floating panel hides part of the screen, and the walk is there to be watched:
        // it docks to the side while walking and goes back as it was.
        const docked = this.state.expanded;
        if (!docked) {
            this.tuquiAssistant.expand();
            await delay(DOCK_MS);
        }
        try {
            return await this._walks.run(goal, proposalId, { startedAt, menu });
        } finally {
            if (!docked) {
                this.tuquiAssistant.contract();
            }
        }
    }

    /** One step of a walk, to the SPA under its id. */
    _postShowMeStep(id, payload) {
        this._postToSpa({ type: "show-me-step", id, payload });
    }

    /** A message to the SPA; throws when there is no chat to take it. */
    _postToSpa(message) {
        const win = this.iframeRef.el?.contentWindow;
        if (!win || !this._spaOrigin) {
            throw new Error("Tuqui is not connected");
        }
        win.postMessage({ source: "tuqui-odoo", ...message }, this._spaOrigin);
    }

    _unsupported(kind) {
        return {
            status: "rejected",
            applied: [],
            skipped: [],
            reason: "unsupported",
            message: _t(
                "This Odoo does not know how to apply this proposal (%s). Update the Tuqui Assistant module.",
                kind || "?"
            ),
        };
    }

    _postApplyResult(proposalId, result) {
        const win = this.iframeRef.el?.contentWindow;
        const spaOrigin = this._spaOrigin;
        if (!win || !spaOrigin) {
            return;
        }
        try {
            win.postMessage(
                { source: "tuqui-odoo", type: "apply-result", payload: { proposalId, ...result } },
                spaOrigin
            );
        } catch (e) {
            console.warn("[tuqui_assistant] Could not post apply-result to iframe:", e);
        }
    }


    _handleMessage(ev) {
        const data = ev.data;
        if (!data || data.source !== "tuqui-spa") {
            return;
        }
        // Security (defence in depth). An attacker can spoof `{source:"tuqui-spa"}`
        // from another window/origin, so checking source alone is NOT enough — both
        // conditions must hold, no shortcuts.
        //
        // 1) The message MUST come from OUR iframe. If the iframe is not mounted
        //    (no companion connected, panel closed), `iframeRef.el` is null →
        //    reject rather than accept blindly (the check used to be skipped when
        //    there was no iframe).
        const frame = this.iframeRef.el;
        if (!frame || ev.source !== frame.contentWindow) {
            return;
        }
        // 2) The origin MUST match the SPA's and be concrete. If `_spaOrigin`
        //    is null (invalid / unresolved baseUrl), discard.
        const spaOrigin = this._spaOrigin;
        if (!spaOrigin || ev.origin !== spaOrigin) {
            return;
        }
        switch (data.type) {
            case "error":
                // Only before the greeting: once the chat is up, its own errors are its own.
                if (!this.ui.embedReady) {
                    this._clearEmbedWatchdog();
                    this.ui.embedFailed = true;
                    this.ui.embedBlocked = true;
                    this._ssoAuthPromise = null;
                }
                break;
            case "reauth":
                // The panel's session lasts a day and renews with a fresh nonce
                // plus the refresh token the iframe keeps: the SPA asks for the
                // nonce a few minutes before it expires.
                this._resetAuth();
                this._postAuth();
                break;
            case "ready":
                this.ui.embedReady = true;
                this.ui.embedBlocked = false;
                this.ui.embedFailed = false;
                this._clearEmbedWatchdog();
                this._postAuth(); // SSO: send nonce + client_id to iframe (before context)
                this._postContext();
                this._maybeShowMenuHint();
                this._postLayout();
                break;
            case "apply":
                // `baseRevision` (opcional): la revisión del contexto sobre la que
                // el SPA razonó. Con eso el servicio detecta si el usuario tocó
                // alguno de esos campos después y no lo pisa en silencio.
                // `target` (opcional): el registro para el que se calculó; si no es
                // el abierto, se rechaza sin tocar nada.
                // `htmlBase` / `selection` (optional): html field co-edit, see
                // docs/embed-protocol.md; its result goes with kind `form_html`.
                this._answerProposal(data, proposalKind(data.payload), () =>
                    this.tuquiAssistant.applyProposal(data.payload?.changes || {}, {
                        baseRevision: data.payload?.baseRevision,
                        target: data.payload?.target,
                        ...(data.payload?.htmlBase && { htmlBase: data.payload.htmlBase }),
                        ...(data.payload?.selection && { selection: data.payload.selection }),
                    })
                );
                break;
            case "chatter":
                // Chatter content proposal: opens the standard Odoo composer
                // pre-filled (user reviews and sends). NEVER posted silently —
                // human dispatch is structural.
                this._answerProposal(data, data.payload?.kind || "chatter", () =>
                    this.tuquiAssistant.proposeChatter(data.payload || {})
                );
                break;
            case "show-me":
                this._answerProposal(data, "show_me", () => this._showMe(data.payload?.goal, readProposalId(data), data.payload?.menu));
                break;
            case "show-me-step-result":
                this._walks.onStepResult(data);
                break;
            case "wait-step":
                // Wait in silence for the person to do a step: no apply-result, the
                // turn already ended; what happens comes back as a `step-event`.
                if (readProposalId(data)) {
                    this._waits.start(readProposalId(data), data.payload?.waiting_line || "");
                }
                break;
            case "wait-cancel":
                this._waits.cancel(readProposalId(data));
                break;
            case "point":
                if (readProposalId(data)) {
                    // By name, on the screen as it is now: the chat waits for what was found.
                    this._answerProposal(data, "point", () => this.tuquiAssistant.pointWhenThere(data.payload || {}));
                } else {
                    // Mark a control the assistant chose from the screen's list of targets.
                    this.tuquiAssistant.point(data.payload || {});
                }
                break;
            case "save":
                // El usuario pidió guardar. Odoo valida; si rechaza, el servicio
                // lo dice en vez de cantar victoria.
                this.tuquiAssistant.saveRecord();
                break;
            case "reload":
                // El turno escribió en Odoo por atrás: los datos de la vista
                // quedaron viejos. Relee sin recargar la página. El servicio se
                // niega si el form está sucio — no le pisamos al usuario lo que
                // está escribiendo por refrescar un dato — y con el diálogo de un
                // x2many abierto recarga el form cuando se cierra. Nadie espera
                // el resultado: en una vista sólo dice que la búsqueda arrancó.
                this.tuquiAssistant.reloadView();
                break;
            case "navigate":
                // Odoo navigation from chat, through doAction (which checks access):
                // a record, an empty form, any view over a domain, or an action. A
                // mode this host does not know is refused. Writes nothing.
                this.tuquiAssistant.navigate(data.payload || {});
                break;
            case "switch-company":
                // Sent only after the backend validated the company. The context
                // is re-posted by hand: switching changes no record, so nothing
                // else would tell the SPA the current company moved.
                if (switchCompany(data.payload?.companyId)) {
                    this._postContext();
                } else {
                    this._postSwitchCompanyFailed(data.payload?.companyId);
                }
                break;
            case "location":
                // The SPA reports its current standalone-equivalent path
                // (`/w/:slug/...`) on every embed route change. Stored so "Open in
                // Tuqui" opens the conversation/view the user is on, not /settings/home.
                // Validated as a safe relative path (starts with "/" but not "//")
                // before trusting it for URL construction.
                // Also persisted to localStorage (keyed by slug) to resume the
                // conversation on page reload or reopen. storedPath is NOT updated
                // here (only on panel-close) to avoid a reactive change causing a
                // src reload while the iframe is mounted.
                {
                    const path = data.payload?.path;
                    if (typeof path === "string" && path.startsWith("/") && !path.startsWith("//")) {
                        this._lastSpaPath = path;
                        if (this.ui.slug) {
                            localStorage.setItem(`tuqui_embed_path_${this.ui.slug}`, path);
                        }
                    }
                }
                break;
            case "external-link-opening":
                // The user clicked an external link in the chat. Write a short-lived
                // signal to localStorage so the new Odoo tab (opened by target="_blank")
                // knows to auto-open the panel and resume this conversation.
                // The signal is consumed and cleared on the next service init; the TTL
                // guards against stale signals in case the user opens a new Odoo tab
                // independently later.
                try {
                    localStorage.setItem("tuqui_open_signal", JSON.stringify({ at: Date.now() }));
                } catch {
                    // Private browsing or quota exceeded — skip silently.
                }
                break;
            default:
                // A proposal type this host does not know: say so, never guess.
                if (readProposalId(data)) {
                    this._answerProposal(data, data.payload?.kind || data.type, null);
                }
                break;
        }
    }

    // --- común ---

    // Labels for icon-only header buttons (title + aria-label for screen readers).
    // Wrapped in _t() so they are translatable.
    get menuLabel() {
        return _t("Conversations");
    }
    get openInTuquiLabel() {
        return _t("Open in Tuqui");
    }
    get minimizeLabel() {
        return _t("Minimize");
    }
    get closeLabel() {
        return _t("Close");
    }
    get restoreLabel() {
        return _t("Open Tuqui");
    }
    get expandLabel() {
        return _t("Expand");
    }
    get contractLabel() {
        return _t("Contract");
    }

    get assistantUrlsDocs() {
        const lang = (user.lang || "").slice(0, 2);
        return `https://docs.tuqui.com/${["es", "fr"].includes(lang) ? lang : "en"}/assistant-urls`;
    }

    // Hides the card via CSS (it does NOT unmount the iframe → no second SSO
    // nonce spent, and the conversation is still there when it comes back). The
    // launcher bubble and the systray icon bring it back.
    minimize() {
        this.tuquiAssistant.minimize();
    }

    restore() {
        this.tuquiAssistant.restore();
    }

    close() {
        this.tuquiAssistant.close();
    }

    expand() {
        this.tuquiAssistant.expand();
    }

    contract() {
        this.tuquiAssistant.contract();
    }

    // Full workspace web app URL to open in a new tab. Opens the user's CURRENT
    // view in the embed (conversation / projects / agents), not the dashboard: the
    // SPA posts its standalone-equivalent path (`_lastSpaPath`, e.g.
    // `/w/:slug/chat/:id`) on every route change. Falls back to `/w/:slug`
    // (→ /chat → workspace home) if no `location` has arrived yet (just mounted).
    // Returns "" when base or slug is missing (companion not connected).
    get _tuquiAppUrl() {
        const base = (this.ui.baseUrl || "").replace(/\/+$/, "");
        if (!base || !this.ui.slug) {
            return "";
        }
        const path = this._lastSpaPath || `/w/${encodeURIComponent(this.ui.slug)}`;
        return `${base}${path}`;
    }

    // "Open in Tuqui" (CTO item #1): opens the workspace web app at the CURRENT
    // view, in a new tab. No-op when base or slug is missing (companion not connected).
    openInTuqui() {
        const url = this._tuquiAppUrl;
        if (!url) {
            this.notification.add(
                _t("Tuqui is not connected: cannot open the app."),
                { type: "warning" }
            );
            return;
        }
        window.open(url, "_blank", "noopener");
    }

}

registry.category("main_components").add("tuqui_assistant.Panel", { Component: TuquiPanel });
