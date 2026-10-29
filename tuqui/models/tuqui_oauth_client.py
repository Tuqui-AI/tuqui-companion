import hashlib
import hmac
import json
import logging
import secrets
import time
import urllib.parse
import uuid
from datetime import timedelta

import psycopg2
import requests
from odoo import _, api, fields, models
from odoo.exceptions import AccessError
from odoo.http import request as http_request

_logger = logging.getLogger(__name__)

# A cron has patience a page load does not, but not unlimited: this runs once
# per new origin and a hung socket should not hold the job.
_EMBED_ORIGIN_TIMEOUT_SECONDS = 10

_STATE_SELECTION = [
    ("pending", "Pending activation"),
    ("active", "Active"),
    ("disconnected", "Disconnected"),
    # A copy of a connected database (left by the neutralize) that has not
    # registered with Tuqui yet, and one that did: a test database of the same
    # workspace, where only Tuqui Assistant works, against this copy.
    ("copy_pending", "Copy pending registration"),
    ("test", "Test database"),
]

# States where Tuqui Assistant works in this database.
CONNECTED_STATES = ("active", "test")

# A registration answers right away (Tuqui checks the copy in the background).
_REGISTRATION_TIMEOUT_SECONDS = 15

# Production Tuqui base URL. Hardcoded — clients never point the module at a
# different Tuqui. The ``tuqui.base_url`` ir.config_parameter overrides it only
# for dev/staging (e.g. http://localhost:5173); no seed record is shipped, so
# get_param falls back to this constant in production.
_TUQUI_BASE_URL = "https://tuqui.com"


class TuquiOAuthClient(models.Model):
    """Singleton-style OAuth 2.0 client credentials store for Tuqui.

    One row per Odoo database. The plaintext ``client_secret`` is shown
    exactly once on creation/rotation and never persisted; only its salted
    SHA-256 hash is stored. Rotation invalidates the previous secret.
    """

    _name = "tuqui.oauth.client"
    _description = "Tuqui OAuth Client Credentials"
    _rec_name = "client_id"

    client_id = fields.Char(required=True, readonly=True, copy=False, index=True)
    client_secret_hash = fields.Char(required=True, readonly=True, copy=False)
    client_secret_salt = fields.Char(required=True, readonly=True, copy=False)
    state = fields.Selection(_STATE_SELECTION, default="pending", required=True, readonly=True)
    activated_at = fields.Datetime(readonly=True)
    last_seen_at = fields.Datetime(readonly=True)
    workspace_id_external = fields.Char(
        string="Tuqui Workspace ID",
        readonly=True,
        help="Identifier returned by Tuqui after the first successful handshake.",
    )
    access_count_7d = fields.Integer(
        string="Accesses (last 7 days)",
        compute="_compute_access_count_7d",
        help="Total RPC calls logged in tuqui.access.log during the last 7 days.",
    )
    event_signing_key = fields.Char(
        readonly=True,
        copy=False,
        groups="base.group_system",
        help=(
            "Shared key this Odoo signs outgoing events with (tuqui.event). "
            "Stored in plaintext because signing requires the key itself \u2014 a hash "
            "cannot produce a signature. Handed to Tuqui once, in the same "
            "activation exchange as the client secret, and replaced whenever that "
            "secret is rotated."
        ),
    )
    reported_embed_origins = fields.Char(
        readonly=True,
        copy=False,
        groups="base.group_system",
        help=(
            "Browser origins this Odoo has already told Tuqui it is served at, "
            "space separated. Local memory only — Tuqui holds the real list. "
            "It is here so the report costs one call per new domain ever, "
            "instead of one per panel open."
        ),
    )
    copy_parent_client_id = fields.Char(
        readonly=True,
        copy=False,
        groups="base.group_system",
        help="The client id this copy inherited, kept until it registered as a test database.",
    )
    copy_parent_signing_key = fields.Char(
        readonly=True,
        copy=False,
        groups="base.group_system",
        help=(
            "The signing key this copy inherited. It signs the registration only, "
            "which proves to Tuqui that the copy came from that connection."
        ),
    )
    copy_pending_secret = fields.Char(
        readonly=True,
        copy=False,
        groups="base.group_system",
        help="The secret this copy registers with, kept until Tuqui accepted it so a retry sends the same one.",
    )
    read_only = fields.Boolean(
        default=True,
        help=(
            "Default ON. When enabled, the per-member path of /tuqui/rpc "
            "refuses every mutating call (create, write, unlink, copy and "
            "arbitrary method execution); only reads pass. Reads still run "
            "with the acting user's own Odoo permissions. NOTE: the connection "
            "(workspace-level) path always runs as superuser and is ALWAYS "
            "read-only regardless of this flag. The hardcoded escape-hatch and "
            "private-method blocks apply regardless of this flag."
        ),
    )

    _sql_constraints = [
        ("client_id_unique", "unique(client_id)", "Tuqui client_id must be unique."),
    ]

    # ---------- Singleton helpers ----------

    @api.model
    def _get_singleton(self):
        rec = self.search([], limit=1)
        return rec or self.env["tuqui.oauth.client"]

    @api.model
    def _is_read_only(self) -> bool:
        client = self._get_singleton()
        return bool(client.read_only) if client else False

    @api.model
    def _get_or_create_singleton(self):
        rec = self._get_singleton()
        if rec:
            return rec, None
        plain_secret = secrets.token_urlsafe(48)
        client_id = uuid.uuid4().hex
        salt = secrets.token_hex(16)
        rec = self.create(
            {
                "client_id": client_id,
                "client_secret_hash": self._hash_secret(plain_secret, salt),
                "client_secret_salt": salt,
                "state": "pending",
            }
        )
        return rec, plain_secret

    # ---------- Hashing ----------

    @staticmethod
    def _hash_secret(plain, salt):
        return hashlib.sha256(f"{salt}::{plain}".encode()).hexdigest()

    def _sign_outbound(self, body: str, timestamp: int) -> str:
        """HMAC-SHA256 over ``timestamp.body`` with this database's signing key.

        One implementation for every signed call this module makes — the event
        queue and the agent lookup — because two would be two things to keep
        byte-identical with Tuqui instead of one.

        The timestamp is inside the signed material rather than beside it:
        signing only the body would leave every captured request replayable
        forever.
        """
        self.ensure_one()
        return hmac.new(
            self._outbound_signing_key().encode(),
            f"{timestamp}.{body}".encode(),
            hashlib.sha256,
        ).hexdigest()

    def _ensure_signing_key(self) -> str:
        """Return the outbound signing key, minting one if there is none yet.

        Mints, never rotates. A database that connected before signed events
        existed has no key and no way to agree on one without tearing the
        connection down (activation refuses to run while it is live), so the
        key is created on first demand and handed to Tuqui over the channel it
        already authenticates on — see ``controllers/signing_key.py``.

        Rotating an existing one instead would invalidate whatever is sitting
        in ``tuqui.event`` unsent, which is precisely what the queue exists to
        protect.
        """
        self.ensure_one()
        record = self.sudo()
        if not record.event_signing_key:
            record.write({"event_signing_key": secrets.token_urlsafe(48)})
        return record.event_signing_key

    def _outbound_signing_key(self) -> str:
        """The key this database signs outgoing events with.

        Note the deliberate asymmetry with ``client_secret``. For calls coming
        *in* (Tuqui to Odoo) this database keeps only a salted hash, because
        verifying needs nothing more. For calls going *out* it must keep the key
        itself: there is no way to produce an HMAC from a hash.

        Returns:
            The shared signing key agreed with Tuqui at activation.

        Raises:
            ValueError: if this Odoo was activated before the key existed and
                Tuqui has not asked for one yet. Not a reason to reconnect:
                that rotates the secret, kills the live tokens and walks an
                admin back through a screen where they can pick the wrong
                workspace. Tuqui mints it through
                ``GET /tuqui/companion/signing-key`` on its own health cycle,
                and the event stays queued until it does.
        """
        self.ensure_one()
        key = self.sudo().event_signing_key
        if not key:
            raise ValueError(
                "This Odoo has no Tuqui event signing key yet. Tuqui mints it on its "
                "next health check; the event stays queued until then."
            )
        return key

    def verify_secret(self, plain):
        self.ensure_one()
        if not plain or not self.client_secret_hash:
            return False
        candidate = self._hash_secret(plain, self.client_secret_salt)
        return hmac.compare_digest(candidate, self.client_secret_hash)

    # ---------- Actions ----------

    def _rotate_client_id(self):
        """Give this database a new ``client_id`` before a new activation.

        Tuqui resolves everything this Odoo sends by ``client_id`` and accepts each
        id in one workspace only. A copy of this database carries the same row, so
        without a new id Tuqui refuses the copy's activation, and the id that is
        already public (it rides to the panel iframe) could be registered by
        someone else first. Only called while no connection is active.
        """
        self.ensure_one()
        self.write({"client_id": uuid.uuid4().hex})

    def _rotate_secret_silent(self) -> str:
        """Generate a new ``client_secret`` and return the plaintext.

        Used by activation flows that hand the secret to another system
        (the Tuqui frontend via the nonce exchange) rather than showing
        it to a human. The plaintext is returned exactly once — the
        caller is responsible for routing it without logging or persisting
        beyond the activation handshake.
        """
        self.ensure_one()
        plain_secret = secrets.token_urlsafe(48)
        salt = secrets.token_hex(16)
        self.write(
            {
                "client_secret_hash": self._hash_secret(plain_secret, salt),
                "client_secret_salt": salt,
                # Rotating the secret rotates the signing key with it, so the
                # two are always minted in the same moment. Which is only half
                # of not drifting: a rotation can happen while an older nonce is
                # still redeemable, so the nonce snapshots BOTH and the exchange
                # hands back the pair that was minted together.
                "event_signing_key": secrets.token_urlsafe(48),
            }
        )
        return plain_secret

    @api.model
    def _prepare_activation(self):
        """Return a redeemable activation nonce, or ``False`` if the connection is active.

        The single place that mints activation codes, shared by
        ``/tuqui/activation/start`` and ``issue_activation_code``. Requires an
        Odoo administrator. The singleton is created on first use, a
        still-valid unconsumed nonce is reused instead of rotating the secret
        again, and otherwise the ``client_id``, secret and signing key rotate
        and a new nonce snapshots them with the caller's login.

        Re-activation is allowed from every state but ``active``: a live
        connection must be disconnected explicitly first, so nothing here
        replaces it.
        """
        if not self.env.is_system():
            raise AccessError(_("Only Odoo administrators can activate Tuqui."))
        acting_user_login = self.env.user.login
        client_model = self.sudo()
        nonce_model = self.env["tuqui.activation.nonce"].sudo()

        oauth_client = client_model._get_singleton()
        if oauth_client and oauth_client.state == "active":
            return False

        # Keep the freshly minted secret of a just-created singleton so it is
        # reused below instead of rotated again right away.
        created_secret = None
        if not oauth_client:
            oauth_client, created_secret = client_model._get_or_create_singleton()

        # Rotating on every call would invalidate the secret Tuqui is about to
        # exchange, so a double click or a retry must not break a live handshake.
        existing = nonce_model.search(
            [
                ("client_id", "=", oauth_client.client_id),
                ("consumed_at", "=", False),
                ("expires_at", ">", fields.Datetime.now()),
            ],
            order="id desc",
            limit=1,
        )
        if existing:
            return existing.nonce

        if not created_secret:
            oauth_client._rotate_client_id()
        plain_secret = created_secret or oauth_client._rotate_secret_silent()
        # A just-created singleton has a secret and no key yet; this mints it
        # without rotating anything.
        signing_key = oauth_client._ensure_signing_key()
        nonce, _expires_at = nonce_model._issue(
            client_id=oauth_client.client_id,
            client_secret_plaintext=plain_secret,
            event_signing_key=signing_key,
            acting_user_login=acting_user_login,
        )
        return nonce

    @api.model
    def issue_activation_code(self) -> dict:
        """Issue a single-use activation code without the browser redirect.

        Public counterpart of ``/tuqui/activation/start`` for a provisioning
        system that is already administrator of this database (JSON-RPC
        ``execute_kw``): same nonce, same rotation rules, same admin gate. The
        nonce is redeemed at ``POST /tuqui/activation/exchange`` as usual.

        Returns:
            ``{"status": "issued", "nonce", "companion_url", "database_uuid"}``,
            or ``{"status": "active", "database_uuid"}`` when this database is
            already connected; then nothing is issued or rotated.

        Raises:
            AccessError: if the caller is not an Odoo administrator.
        """
        nonce = self._prepare_activation()
        database_uuid = self.env["ir.config_parameter"].sudo().get_param("database.uuid")
        if not nonce:
            return {"status": "active", "database_uuid": database_uuid}
        return {
            "status": "issued",
            "nonce": nonce,
            "companion_url": self.sudo()._get_companion_url(),
            "database_uuid": database_uuid,
        }

    def action_start_activation(self):
        """Return an ``act_url`` action that opens ``/tuqui/activation/start``.

        The route mints a fresh nonce + secret and redirects the browser
        on to the Tuqui frontend with the nonce in the query string. UI
        glue only — the work happens server-side at the route.
        """
        self.ensure_one()
        return {
            "type": "ir.actions.act_url",
            "url": "/tuqui/activation/start",
            "target": "self",
        }

    def action_disconnect(self):
        """Tear down the connection: rotate the signing key, then flip state.

        Rotating the key invalidates every outstanding access token, and while
        ``state == 'disconnected'`` ``/tuqui/oauth/token`` refuses to mint new
        ones (see ``controllers/oauth.py``). Without the rotation the disconnect
        would be cosmetic — Tuqui would keep calling until its cached token
        expired and then quietly re-authenticate. Re-activation (the redirect
        /exchange) flips state back to 'active'; a new key is minted lazily.
        """
        self.ensure_one()
        # Decide BEFORE the teardown whether this connection was ever real.
        # A client that never activated (still 'pending', no workspace) has
        # nothing for Tuqui to re-probe, so skip the hint entirely.
        was_connected = bool(self.workspace_id_external) or self.state == "active"

        # Local import: the rotation primitive lives with the token-signing code
        # in the controller; importing at module load would couple model and
        # controller import order for no benefit.
        from ..controllers.oauth import rotate_signing_key

        rotate_signing_key(self.env)
        # The reported origins go with the connection. Kept, they would make the
        # next activation skip reporting names the new connection never declared,
        # and Tuqui clears its own list on teardown anyway.
        self.write({"state": "disconnected", "reported_embed_origins": False})

        # Hint Tuqui to re-probe — but only AFTER this transaction COMMITS, via a
        # post-commit callback. Firing it inline (mid-transaction) is a trap: our
        # state='disconnected' write is still uncommitted (Odoo flushes lazily),
        # so Tuqui's synchronous re-probe (a /tuqui/oauth/token call that runs
        # touch_last_seen on THIS row) commits a concurrent update to a row we
        # haven't flushed yet -> psycopg2 SerializationFailure at request-end
        # flush, which `retrying` then re-runs (re-POSTing each time) until it
        # surfaces an RPC_ERROR. It also defeats the hint's purpose: the re-probe
        # would read the still-uncommitted 'active' state and conclude "connected".
        # Post-commit, the row is durably 'disconnected' (the probe gets its 401)
        # and there is no write to conflict with. Best-effort: never raises.
        if was_connected:
            self.env.cr.postcommit.add(self._notify_tuqui_disconnect)

    @api.model
    def register_test_copy(self) -> dict:
        """Register this copy as a test database of the workspace it was copied from.

        Runs the first time the panel opens in a copy the neutralize left as
        ``copy_pending``, never inside ``embed_bootstrap``. The new credentials
        are committed BEFORE calling Tuqui, so a registration Tuqui received is
        never one this database forgot. A retry sends exactly the same ones: Tuqui
        answers it as already registered, and refuses anything else for a copy it
        already verified.

        Returns:
            ``{"status": ...}``: ``registered``, ``pending`` (Tuqui has not reached
            the copy yet), ``busy`` (another request is registering),
            ``not_a_copy``, or ``failed`` with ``error``.
        """
        client = self.sudo()._get_singleton()
        if not client or client.state != "copy_pending":
            return {"status": "not_a_copy"}
        # Two people opening the panel at once must not register two copies.
        try:
            with self.env.cr.savepoint(flush=False):
                self.env.cr.execute("SELECT id FROM tuqui_oauth_client WHERE id = %s FOR UPDATE NOWAIT", [client.id])
        except psycopg2.errors.LockNotAvailable:
            return {"status": "busy"}
        if not client.copy_parent_client_id:
            client.write(
                {
                    "copy_parent_client_id": client.client_id,
                    "copy_parent_signing_key": client.event_signing_key,
                }
            )
            client._rotate_client_id()
            client.write({"copy_pending_secret": client._rotate_secret_silent()})
        secret = client.copy_pending_secret
        self.env.cr.commit()  # pylint: disable=invalid-commit — before Tuqui hears of them, see the docstring

        body = json.dumps(
            {
                "client_id": client.client_id,
                "client_secret": secret,
                "event_signing_key": client.event_signing_key,
                "url": client._get_companion_url(),
                "copy_database_uuid": self.env["ir.config_parameter"].sudo().get_param("database.uuid"),
                "origin": "auto",
            },
            separators=(",", ":"),
        )
        timestamp = int(time.time())
        signature = hmac.new(
            client.copy_parent_signing_key.encode(), f"{timestamp}.{body}".encode(), hashlib.sha256
        ).hexdigest()
        try:
            response = requests.post(
                f"{client._get_tuqui_base_url()}/v1/companion/test-databases",
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "X-Tuqui-Client-Id": client.copy_parent_client_id,
                    "X-Tuqui-Signature": f"t={timestamp},v1={signature}",
                },
                timeout=_REGISTRATION_TIMEOUT_SECONDS,
            )
        except Exception as exc:  # noqa: BLE001 — answered to the panel, which retries
            _logger.warning("Tuqui test database registration failed: %s", exc)
            return {"status": "failed", "error": str(exc)}
        if not 200 <= response.status_code < 300:
            _logger.warning("Tuqui refused the test database registration: HTTP %s", response.status_code)
            return {"status": "failed", "error": f"HTTP {response.status_code}"}
        try:
            answer = response.json().get("status")
        except ValueError:
            answer = None
        # Tuqui reaches the copy in the background. Until it did, this stays a copy
        # that registers again, with the same credentials, the next time.
        if answer not in ("active", "down"):
            return {"status": "pending"}
        client.write(
            {
                "state": "test",
                "copy_parent_client_id": False,
                "copy_parent_signing_key": False,
                "copy_pending_secret": False,
            }
        )
        _logger.info("Registered as a test database of Tuqui workspace %s", client.workspace_id_external)
        return {"status": "registered"}

    def _notify_tuqui_disconnect(self):
        """Best-effort, credential-free disconnect hint to Tuqui.

        POSTs ``{client_id}`` to Tuqui's
        ``/api/onboarding/companion/disconnected`` so Tuqui re-runs its own
        authenticated liveness check and marks the workspace disconnected only
        when that probe gets a 401 (which it now will — see ``action_disconnect``
        ordering). Carries no secret: it's a hint, not an authenticated command.

        NEVER raises. The local teardown is the source of truth; this call only
        nudges Tuqui to notice sooner instead of waiting for its cached token to
        expire. Any failure (network, non-200, Tuqui down) is logged and
        swallowed.
        """
        self.ensure_one()
        try:
            url = self._get_tuqui_base_url().rstrip("/") + "/api/onboarding/companion/disconnected"
            requests.post(url, json={"client_id": self.client_id}, timeout=4)
            _logger.info("Tuqui disconnect hint sent for client_id %s", self.client_id)
        except Exception as exc:  # noqa: BLE001 - best-effort, must never raise
            # Best-effort nudge; Tuqui's health cron is the backstop. Under the
            # test harness (runbot/CI) outbound HTTP is forbidden ("External
            # requests verboten") — expected noise, so log that at DEBUG; a
            # genuine production failure stays a WARNING worth noticing. The hint
            # still fires (so the disconnect tests that assert the POST pass).
            from odoo.tools import config

            level = logging.DEBUG if config["test_enable"] else logging.WARNING
            _logger.log(level, "Tuqui disconnect hint failed for client_id %s: %s", self.client_id, exc)

    @api.model
    def _get_tuqui_base_url(self):
        """Tuqui base URL — hardcoded for clients, overridable for dev.

        Single source of truth for both the "Go to Tuqui" link and the
        activation redirect target (``<base_url>/activate``). Reads the
        ``tuqui.base_url`` ir.config_parameter when set (dev/staging) and
        otherwise falls back to the hardcoded production constant.
        """
        param = self.env["ir.config_parameter"].sudo().get_param("tuqui.base_url", _TUQUI_BASE_URL)
        return (param or _TUQUI_BASE_URL).rstrip("/")

    @api.model
    def _get_activation_frontend_url(self):
        """Where ``/tuqui/activation/start`` redirects the admin's browser.

        Derived from the base URL — one config, not two.
        """
        return f"{self._get_tuqui_base_url()}/activate"

    @api.model
    def _get_companion_url(self) -> str:
        """Canonical public URL of this Odoo instance.

        Reads ``web.base.url`` (Technical > Parameters) so the URL is correct
        behind a TLS-terminating proxy. The proxy terminates HTTPS and forwards
        to Odoo over HTTP, so ``request.httprequest.host_url`` reflects only
        the proxy→Odoo hop (``http://``). ``web.base.url`` holds the
        externally-visible HTTPS URL.

        Falls back to ``request.httprequest.host_url`` for local/dev setups
        where the parameter may be absent or blank.
        """
        base_url = self.env["ir.config_parameter"].sudo().get_param("web.base.url", "")
        if base_url:
            return base_url.rstrip("/")
        return http_request.httprequest.host_url.rstrip("/")

    @api.model
    def _declared_frame_origins(self) -> list[str]:
        """Origins this Odoo is served at, according to its own configuration.

        Deliberately NOT the host of a live request. A request's ``Host`` is
        chosen by whoever makes the request, so reading it would let any user
        with a session name an origin and have Tuqui write it into the CSP header
        meant to constrain them, and fill the cap with values of their choosing
        so no real domain fitted.

        Two sources, both admin-owned:

        * ``web.base.url``, the canonical public URL, which is also what the
          companion registered as its callback.
        * The domain of every published website, which is how a multi-domain
          instance is configured in the first place: Odoo routes by ``Host``
          against these values, so a name that is not here serves no website.

        ``website`` is not a dependency of this module, so the second source is
        read only when the model is present. An instance without it reports one
        origin, which is exactly today's behaviour.

        Returns full origins WITH scheme. The scheme is ours to state and nobody
        else's to guess: a proxy that terminates TLS hands us plain HTTP, so an
        origin inferred downstream from what we see would say ``http`` for a page
        the browser loaded over ``https``, and match nothing.
        """
        origins: list[str] = []

        base_url = self.env["ir.config_parameter"].sudo().get_param("web.base.url", "")
        base_origin = self._origin_of(base_url)
        if base_origin:
            origins.append(base_origin)

        website = self.env.get("website")
        if website is not None:
            # `domain` is free text an admin typed: it may be bare, carry a path,
            # or be empty on a single-website instance. `_origin_of` sorts that out
            # and drops what it cannot read.
            for domain in website.sudo().search([]).mapped("domain"):
                origin = self._origin_of(domain)
                if origin:
                    origins.append(origin)

        # Names neither source knows, typically the SaaS internal host people
        # log in through. Set by an admin in Settings, like `web.base.url`.
        extra = self.env["ir.config_parameter"].sudo().get_param("tuqui.extra_embed_origins", "")
        for value in extra.replace(",", " ").split():
            origin = self._origin_of(value)
            if origin:
                origins.append(origin)

        return list(dict.fromkeys(origins))

    @staticmethod
    def _origin_of(value: str | None) -> str | None:
        """``scheme://host[:port]`` out of a configured URL, or None.

        A bare host gets ``https``, which is the only safe assumption for a value
        an admin typed as a public domain. Anything hostless or unparseable is
        dropped rather than guessed at.
        """
        if not value or not value.strip():
            return None
        candidate = value.strip()
        if "://" not in candidate:
            candidate = f"https://{candidate}"
        try:
            parsed = urllib.parse.urlparse(candidate)
            host = (parsed.hostname or "").lower()
            port = parsed.port
        except ValueError:
            return None
        if not host or parsed.scheme.lower() not in ("http", "https"):
            return None
        # Punycode, because `frame-ancestors` is ASCII. A domain an admin typed
        # with an ñ or an accent — ordinary in .ar — is a perfectly good website
        # domain that Tuqui has no choice but to refuse, so without this it gets
        # reported every single day and authorized never.
        try:
            host = host.encode("idna").decode("ascii")
        except UnicodeError:
            return None
        scheme = parsed.scheme.lower()
        return f"{scheme}://{host}:{port}" if port else f"{scheme}://{host}"

    @api.model
    def _cron_report_frame_origins(self) -> None:
        """Declare this instance's domains to Tuqui when the set changes.

        Runs on a cron and not in the panel's bootstrap. The bootstrap looked
        tempting because it is the moment a browser is present, but it is also
        `onWillStart` of a `main_components` component, so every page load of
        every user would have waited on an HTTP call to another host — and since
        a failure is not remembered, a Tuqui that was down would have made the
        customer's Odoo slow to load for as long as it stayed down. Coupling
        their backend's latency to our availability is a worse bug than the one
        this feature fixes.

        Sends the WHOLE list and lets Tuqui replace what it had. Reporting one
        origin at a time could only ever add, so a domain removed from a website
        stayed authorized forever and kept its slot in the cap; the same went for
        whatever Odoo wrote into `web.base.url` the day an admin logged in over
        an IP or a tunnel (it overwrites the parameter unless
        `web.base.url.freeze` is set). With the full list the row mirrors what we
        declare, so a removal takes effect on its own.

        Silent when nothing changed: the comparison is against a local copy of
        what we last sent, so a steady instance makes no network call at all.
        """
        client = self._get_singleton()
        if not client or client.state not in CONNECTED_STATES or not client.client_id:
            return

        declared = client._declared_frame_origins()
        reported = (client.sudo().reported_embed_origins or "").split()
        if declared == reported:
            return
        client._post_frame_origins(declared)

    def _post_frame_origins(self, origins: list[str]) -> None:
        """Send the list. Remembers it only when Tuqui answers with what stuck.

        What comes back is what Tuqui actually stored, which is not always what
        we sent: it truncates at its cap and drops anything that fails its own
        validation. Remembering the ANSWER rather than the request is what makes
        the next run retry a domain that did not fit, instead of filing it as
        reported and never mentioning it again.

        Nothing here raises. It is a cron, and a Tuqui that is down or slow costs
        a log line and a retry tomorrow.
        """
        self.ensure_one()
        body = json.dumps({"origins": origins}, separators=(",", ":"), sort_keys=True)
        timestamp = int(time.time())
        try:
            # `_sign_outbound` is inside the guard, not only the POST: it raises
            # ValueError on a database activated before signing keys existed and
            # whose key Tuqui has not minted yet. That is a live state with a
            # documented fix of its own, and it must not turn a cron into a
            # traceback.
            signature = self._sign_outbound(body, timestamp)
            response = requests.post(
                f"{self._get_tuqui_base_url()}/v1/companion/embed-origins",
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "X-Tuqui-Client-Id": self.client_id,
                    "X-Tuqui-Signature": f"t={timestamp},v1={signature}",
                },
                timeout=_EMBED_ORIGIN_TIMEOUT_SECONDS,
            )
        except Exception as exc:  # noqa: BLE001 — a cron must not fail on this
            _logger.info("Could not report frame origins to Tuqui: %s", exc)
            return

        if not 200 <= response.status_code < 300:
            _logger.info("Tuqui refused the frame origins: HTTP %s", response.status_code)
            return

        try:
            stored = response.json().get("origins") or []
        except ValueError:
            _logger.info("Tuqui answered the frame origins with a body we could not read")
            return
        if not isinstance(stored, list):
            return
        stored = [o for o in stored if isinstance(o, str)]
        if stored != origins:
            # Not an error, and worth saying out loud: these are the domains whose
            # panel stays blocked, and the difference is invisible from a 200.
            _logger.info(
                "Tuqui stored %s of the %s frame origins reported; missing: %s",
                len(stored),
                len(origins),
                [o for o in origins if o not in stored],
            )
        self.sudo().write({"reported_embed_origins": " ".join(stored)})

    def action_open_tuqui(self):
        """Open the connected Tuqui workspace in a new tab.

        Links straight to ``<base_url>/w/<workspace_id_external>`` when
        the handshake has reported back a workspace identifier. Falls
        back to the bare base URL otherwise — useful even pre-activation
        so the admin can see the destination before clicking Activate.
        """
        self.ensure_one()
        base = self._get_tuqui_base_url()
        if self.workspace_id_external:
            url = "{}/w/{}".format(base, urllib.parse.quote(self.workspace_id_external, safe=""))
        else:
            url = base
        return {
            "type": "ir.actions.act_url",
            "url": url,
            "target": "new",
        }

    @api.model
    def _tuqui_agent_url(self, agent_id):
        """The agent's page in Tuqui, on its channels tab.

        Falls back to the bare base URL while no workspace has been reported.
        """
        base = self._get_tuqui_base_url()
        workspace = self.sudo()._get_singleton().workspace_id_external
        if not workspace or not agent_id:
            return base
        return "{}/w/{}/agents/{}/edit?tab=channels".format(
            base,
            urllib.parse.quote(workspace, safe=""),
            urllib.parse.quote(str(agent_id), safe=""),
        )

    def mark_active(self, workspace_id_external=None):
        self.ensure_one()
        vals = {"state": "active", "activated_at": fields.Datetime.now()}
        if workspace_id_external:
            vals["workspace_id_external"] = workspace_id_external
        # Forgotten here and not only on disconnect. A teardown started on
        # Tuqui's side revokes us over HTTP, and that call can fail: Tuqui then
        # has an empty list and we still think we reported everything, so the
        # next connection never re-declares its domains. Clearing at the moment
        # the connection becomes live costs nothing and does not depend on a
        # request having succeeded.
        vals["reported_embed_origins"] = False
        self.write(vals)
        # Without this the first report waits for the daily cron, so a customer
        # who just connected has a branded domain blocked for up to 24 hours —
        # the whole bug this feature fixes, still broken on day one.
        self._trigger_frame_origins_report()

    def _trigger_frame_origins_report(self) -> None:
        """Ask the cron to run now. Best effort: never breaks the activation."""
        try:
            self.env.ref("tuqui.ir_cron_tuqui_report_frame_origins")._trigger()
        except Exception as exc:  # noqa: BLE001 — activation must not fail on this
            _logger.info("Could not trigger the frame-origins report: %s", exc)

    def touch_last_seen(self):
        self.ensure_one()
        self.write({"last_seen_at": fields.Datetime.now()})

    # ---------- Compute ----------

    def _compute_access_count_7d(self):
        # The domain doesn't depend on the record, so count once and fan out
        # (same shape as res_config_settings._compute_tuqui_status).
        since = fields.Datetime.now() - timedelta(days=7)
        count = self.env["tuqui.access.log"].sudo().search_count([("create_date", ">=", since)])
        for rec in self:
            rec.access_count_7d = count
