import ast
import json
import logging
from datetime import timedelta

import psycopg2
from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError
from odoo.fields import Domain
from odoo.service.model import PG_CONCURRENCY_EXCEPTIONS_TO_RETRY
from odoo.tools import SQL, html2plaintext, split_every

from . import search_relevant_text as text

_logger = logging.getLogger(__name__)

# What a new configuration starts with, for the models that need more than the
# form's defaults. The chatter: messages are written once, and what is indexed is
# what people wrote and the mails that arrived, on any document and in Discuss
# (shown in the domain widget, so its count is what the backfill will read).
MODEL_DEFAULTS = {
    "mail.message": {"domain": "[('message_type', 'in', ['comment', 'email'])]", "append_only": True},
}

# Models whose ``_search`` drops ids in Python, with no document to scope them
# through: searching one would load every id the user sees before ranking. A
# list and not "the model overrides _search": helpdesk.ticket overrides it only
# to order, and must stay searchable.
UNSEARCHABLE_MODELS = frozenset({"ir.attachment", "mail.activity", "mail.scheduled.message"})

TEXT_FIELD_TYPES = ("char", "text", "html")

# Fingerprint of the rule that turns text into index entries, derived from the
# rule itself (see ``search_relevant_text``).
NORMALIZATION_VERSION = text.NORMALIZATION_VERSION

# Records read and indexed per step of the cron. Overridable per database with
# the ``base_search_relevant.batch_size`` config parameter.
DEFAULT_BATCH_SIZE = 500

# Past a couple hundred thousand characters a document is an attachment pasted
# into a field, and its tail adds nothing a search would miss. Also keeps the
# tsvector far below its 1 MB limit.
MAX_TEXT_CHARS = 200_000

# How far before the last watermark each freshness pass starts: ``write_date``
# is when a transaction started, not when it committed. Unchanged rows in the
# margin are skipped by write_date, so it costs a scan, not a reindex.
SYNC_MARGIN = timedelta(hours=1)

# The same margin for ``sync_cursor``: a row can commit below an id a pass
# already saw. Bounded in time, not in ids (a bulk import commits thousands at
# once): the cursor only moves to the id a pass reached at least this long ago.
SYNC_ID_MARGIN = timedelta(minutes=30)

# The cron runs every five minutes. A watermark older than this means it is not
# running (failing, deactivated by Odoo after repeated failures, or starved),
# and searches stop claiming a complete answer.
STALE_AFTER = timedelta(minutes=30)

# Rows deleted per step when an archived model's index is dropped.
CLEANUP_BATCH_SIZE = 20_000

# Deleted records never leak — the user's own search drops ids that no longer
# exist — so purging their rows is housekeeping, done once a day.
PURGE_INTERVAL = timedelta(days=1)


class SearchRelevantConfig(models.Model):
    """A model an administrator enabled for relevance search, and its indexing state.

    Only an administrator enables a model; a consumer may suggest, never enable.
    Enabling does not touch the model's table: it sets where the backfill starts
    and wakes the cron. An optional ``domain`` narrows what is indexed.

    The cron keeps the index honest:

    * **Backfill** — ids below ``backfill_cursor`` are pending, newest first.
    * **Freshness** — records written since the last pass (minus ``SYNC_MARGIN``)
      are re-indexed, and one written out of the ``domain`` loses its row.
      ``append_only`` walks by id instead, and never sees an edit. Searches
      match live only what was created after ``sync_cursor``.
    * **Deletions** — once a day, rows of deleted or out-of-domain records go.
    * **Layout** — rows of an older layout are not searched, so a field taken
      out stops matching at once, not when the backfill gets to it.
    """

    _name = "search.relevant.config"
    _description = "Relevance Search: Enabled Model"
    _order = "model"
    _rec_name = "model"

    active = fields.Boolean(
        default=True,
        help="Archiving a model stops its search at once; the cron then deletes its index rows in the background.",
    )
    model_id = fields.Many2one(
        "ir.model",
        string="Model",
        required=True,
        ondelete="cascade",
        domain=[("transient", "=", False), ("abstract", "=", False)],
    )
    model = fields.Char(related="model_id.model", string="Model Name", store=True, index=True, readonly=True)
    field_ids = fields.Many2many(
        "ir.model.fields",
        string="Indexed fields",
        domain="[('model_id', '=', model_id), ('ttype', 'in', ('char', 'text', 'html')), ('store', '=', True)]",
        help="Up to four text fields whose content is searched. Changing them re-indexes the model in the background.",
    )
    domain = fields.Char(
        help="Optional Odoo domain that limits which records are indexed. Empty indexes every record of the model. "
        "Example, to index only the chatter messages of tasks: "
        "[('message_type', '=', 'comment'), ('model', '=', 'project.task')]",
    )
    chatter_models = fields.Char(
        readonly=True,
        copy=False,
        help="Only for the chatter: the documents that have messages, kept current by the cron. A message is "
        "searched through its document, so whoever may read the document finds it.",
    )
    append_only = fields.Boolean(
        string="Records are never edited",
        help="Index new records only. The freshness pass then walks by id, which reads the primary key instead of "
        "scanning the whole table for recent writes. On a table of millions of rows, like the chatter, that scan "
        "is most of what the index costs. The price: a change to a record already indexed is not picked up, and "
        "its old text keeps matching until the model is re-indexed.",
    )
    state = fields.Selection(
        [("indexing", "Indexing"), ("ready", "Ready")],
        compute="_compute_state",
    )
    backfill_cursor = fields.Integer(
        readonly=True,
        copy=False,
        help="Records with an id below this one are not indexed yet. Zero means the backfill is done.",
    )
    backfill_total = fields.Integer(readonly=True, copy=False)
    backfill_done = fields.Integer(readonly=True, copy=False)
    backfill_progress = fields.Float(compute="_compute_state", string="Progress")
    backfill_reached = fields.Datetime(
        readonly=True,
        copy=False,
        help="While indexing: records created on or after this date are already indexed.",
    )
    sync_watermark = fields.Datetime(
        string="Last freshness pass",
        readonly=True,
        copy=False,
        help="Everything written before this moment is in the index.",
    )
    sync_cursor = fields.Integer(
        readonly=True,
        copy=False,
        help="Every id up to this one is indexed, left to the backfill, or outside the domain. Searches read the "
        "records above it live.",
    )
    sync_reached = fields.Integer(
        readonly=True,
        copy=False,
        help="The highest id a pass had walked to at sync_reached_at. It becomes sync_cursor once SYNC_ID_MARGIN "
        "has passed, so a transaction that commits late still falls above the cursor.",
    )
    sync_reached_at = fields.Datetime(readonly=True, copy=False)
    layout = fields.Integer(default=1, readonly=True, copy=False)
    layout_fields = fields.Char(
        readonly=True,
        copy=False,
        help="Indexed fields in weight-label order (A, B, …) for the current layout.",
    )
    # No default on purpose: rows that exist before this column (indexed by an
    # earlier rule) must read as outdated, and the cron re-indexes them.
    normalization = fields.Char(readonly=True, copy=False)
    cleanup_pending = fields.Boolean(
        readonly=True,
        copy=False,
        help="Archived, and its index rows are still being deleted by the cron.",
    )
    last_purge_at = fields.Datetime(readonly=True, copy=False)
    document_count = fields.Integer(compute="_compute_document_count", string="Indexed records")

    _model_unique = models.Constraint(
        "UNIQUE (model_id)",
        "This model is already enabled for search (it may be archived).",
    )

    # ─── Computes & constraints ─────────────────────────────────────────

    @api.depends("backfill_cursor", "backfill_total", "backfill_done")
    def _compute_state(self):
        for config in self:
            config.state = "indexing" if config.backfill_cursor else "ready"
            if not config.backfill_cursor:
                config.backfill_progress = 100.0
            elif config.backfill_total:
                config.backfill_progress = min(100.0 * config.backfill_done / config.backfill_total, 99.9)
            else:
                config.backfill_progress = 0.0

    def _compute_document_count(self):
        counts = {}
        ids = tuple(config_id for config_id in self.ids if isinstance(config_id, int))
        if ids:
            self.env.cr.execute(
                SQL(
                    "SELECT config_id, count(*) FROM search_relevant_document WHERE config_id IN %s GROUP BY config_id",
                    ids,
                )
            )
            counts = dict(self.env.cr.fetchall())
        for config in self:
            config.document_count = counts.get(config.id, 0)

    @api.onchange("model_id")
    def _onchange_model_id(self):
        """Preselect the record name: it is what people remember a record by."""
        if not self.model_id or self.model_id.model not in self.env:
            return
        model = self.env[self.model_id.model]
        names = [name for name in (model._rec_name, "description") if name]
        fields_ = [model._fields.get(name) for name in dict.fromkeys(names)]
        chosen = [field.name for field in fields_ if field and field.type in TEXT_FIELD_TYPES and field.store]
        if chosen:
            self.field_ids = self.env["ir.model.fields"].search([("model", "=", model._name), ("name", "in", chosen)])
        for name, value in MODEL_DEFAULTS.get(model._name, {}).items():
            if not self[name]:
                self[name] = value

    @api.constrains("model_id", "field_ids", "domain")
    def _check_model_and_fields(self):
        _ = self.env._
        for config in self:
            model_name = config.model_id.model
            if model_name not in self.env:
                raise ValidationError(_("Model %s is not loaded in this database.", model_name))
            model = self.env[model_name]
            if (
                model._abstract
                or model._transient
                or not model._auto
                or model._table_query
                or model._name == "search.relevant.document"
            ):
                raise ValidationError(_("%s is not a regular database model and cannot be searched.", model_name))
            if model_name in UNSEARCHABLE_MODELS:
                raise ValidationError(_("%s cannot be searched.", model_name))
            if not model._log_access:
                # Without write_date the index could never learn about changes.
                raise ValidationError(
                    _("%s does not track modification dates, so its index could not stay current.", model_name)
                )
            if not config.field_ids:
                raise ValidationError(_("Choose at least one field to index for %s.", model_name))
            if len(config.field_ids) > len(text.WEIGHTS):
                # One weight label per field is what lets a search skip the
                # fields a user cannot read, and PostgreSQL has four.
                raise ValidationError(_("At most %s fields can be indexed per model.", len(text.WEIGHTS)))
            for field_rec in config.field_ids:
                field = model._fields.get(field_rec.name)
                if field_rec.model != model_name or field is None:
                    raise ValidationError(_("Field %s does not belong to %s.", field_rec.name, model_name))
                if (
                    field.type not in TEXT_FIELD_TYPES
                    or not field.store
                    or not field.column_type
                    or field.inherited
                    or field.company_dependent
                ):
                    raise ValidationError(
                        _(
                            "Field %(field)s cannot be indexed: only text, char and HTML fields stored in the %(model)s table can.",
                            field=field.name,
                            model=model_name,
                        )
                    )
            config._check_domain()

    def _check_domain(self):
        """The domain must read as a list and the model must accept it.

        Checked on write, not in the cron: a bad domain would fail every run,
        and Odoo deactivates a cron that keeps failing.
        """
        self.ensure_one()
        _ = self.env._
        if not self.domain:
            return
        model_name = self.model_id.model
        try:
            parsed = ast.literal_eval(self.domain)
        except (SyntaxError, ValueError) as error:
            raise ValidationError(_("The domain is not valid: %s", error)) from error
        if not isinstance(parsed, list):
            raise ValidationError(_("The domain must be a list, like [('field', '=', value)]."))
        try:
            Domain(parsed).validate(self.env[model_name])
        except (KeyError, TypeError, ValueError, NotImplementedError) as error:
            raise ValidationError(
                _("%(model)s does not accept this domain: %(error)s", model=model_name, error=error)
            ) from error

    # ─── CRUD ─────────────────────────────────────────────────────────────

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            model_name = self.env["ir.model"].browse(vals.get("model_id")).model
            for name, value in MODEL_DEFAULTS.get(model_name, {}).items():
                vals.setdefault(name, value)
        configs = super().create(vals_list)
        configs.filtered("active")._start_indexing()
        return configs

    def write(self, vals):
        if "model_id" in vals and any(config.model_id.id != vals["model_id"] for config in self):
            raise UserError(self.env._("The model of an enabled search cannot be changed. Create a new one instead."))
        res = super().write(vals)
        if "field_ids" in vals:
            for config in self:
                config.write({"layout": config.layout + 1, "layout_fields": config._expected_layout_fields()})
        if "domain" in vals:
            # The next cron run purges the rows the new domain leaves out. No
            # layout bump: the text of the records that stay is still right.
            self.write({"last_purge_at": False})
        if "active" in vals:
            if vals["active"]:
                self._start_indexing()
            else:
                self._stop_indexing()
        elif "field_ids" in vals or "domain" in vals:
            self.filtered("active")._start_indexing()
        return res

    def action_reindex(self):
        self.filtered("active")._start_indexing()

    def unlink(self):
        """Deleting a configuration whose index still has rows is refused.

        The cascade would delete millions of rows in one statement inside the
        user's request. Archive instead: the cron empties the index in batches
        (:meth:`_cleanup_batch`). Uninstalling the module drops the table.
        """
        if not self.env.context.get("module_uninstall"):
            for config in self.filtered(lambda config: config._has_documents()):
                raise UserError(
                    self.env._(
                        "%s is still indexed. Archive it first: the index is deleted in the background, "
                        "and the configuration can be deleted once it is empty.",
                        config.model,
                    )
                )
        return super().unlink()

    def _has_documents(self):
        """Whether any index row is left, without counting them all."""
        self.ensure_one()
        return bool(
            self.env.execute_query(SQL("SELECT 1 FROM search_relevant_document WHERE config_id = %s LIMIT 1", self.id))
        )

    # ─── Lifecycle ────────────────────────────────────────────────────────

    def _start_indexing(self):
        """Point the backfill at the newest record and wake the cron.

        Existing rows are kept: rows of the current layout stay searchable while
        the backfill overwrites them; rows of an older layout are ignored by
        searches until then, and rows of records deleted meanwhile go with the
        daily purge.
        """
        if not self:
            return
        cr = self.env.cr
        now = cr.now()
        for config in self:
            # MAX(id), not count(*): this runs inside the admin's click, and
            # counting millions of rows there cannot be cancelled. The cron
            # counts them on its first step (:meth:`_count_backfill`).
            ((max_id,),) = self.env.execute_query(
                SQL(
                    "SELECT COALESCE(MAX(t.id), 0) FROM %s t WHERE %s",
                    SQL.identifier(config._source_table()),
                    config._in_domain(SQL.identifier("t", "id")),
                )
            )
            config.write(
                {
                    # Everything that exists now is the backfill's job; anything
                    # written from now on is the freshness pass's.
                    "backfill_cursor": max_id + 1 if max_id else 0,
                    "backfill_total": 0,
                    "backfill_done": 0,
                    "backfill_reached": now if max_id else False,
                    "sync_watermark": config.sync_watermark or now,
                    # Everything at or below max_id is the backfill's job, so the
                    # cursor may start there with no margin of its own.
                    "sync_cursor": max_id,
                    "sync_reached": max_id,
                    "sync_reached_at": now,
                    "normalization": NORMALIZATION_VERSION,
                    "layout_fields": config.layout_fields or config._expected_layout_fields(),
                    "cleanup_pending": False,
                }
            )
        self._wake_cron()

    def _stop_indexing(self):
        """Stop searching now, in this transaction; the cron deletes the rows in
        batches (``_cleanup_batch``)."""
        self.write(
            {
                "backfill_cursor": 0,
                "backfill_done": 0,
                "backfill_reached": False,
                "sync_watermark": False,
                "sync_cursor": 0,
                "sync_reached": 0,
                "sync_reached_at": False,
                "cleanup_pending": True,
            }
        )
        self._wake_cron()

    def _cleanup_batch(self, batch_size):
        """Delete up to ``batch_size`` rows of an archived model. Returns ``(count, more)``."""
        self.ensure_one()
        self.env.cr.execute(
            SQL(
                """
                DELETE FROM search_relevant_document
                 WHERE id IN (SELECT id FROM search_relevant_document WHERE config_id = %s LIMIT %s)
                """,
                self.id,
                batch_size,
            )
        )
        deleted = self.env.cr.rowcount
        more = deleted >= batch_size
        if not more:
            self.cleanup_pending = False
        return deleted, more

    def _wake_cron(self):
        cron = self.env.ref("base_search_relevant.ir_cron_search_relevant_index", raise_if_not_found=False)
        if not cron:
            return
        cron = cron.sudo()
        # Only ever switch it on here. The cron switches itself off when no
        # model is enabled; writing active=False from a user request would wait
        # on the row lock of a run in progress.
        if not cron.active:
            cron.active = True
        cron._trigger()

    # ─── Freshness ────────────────────────────────────────────────────────

    def _is_stale(self):
        """Whether the last freshness pass is too old to call an answer complete.

        What makes a search answer ``partial`` when the cron stopped.
        """
        self.ensure_one()
        return not self.sync_watermark or self.env.cr.now() - self.sync_watermark > STALE_AFTER

    # ─── What is indexed ─────────────────────────────────────────────────

    def _source_table(self):
        self.ensure_one()
        return self.env[self.model]._table

    def _parent_fields(self):
        """``(model field, id field)`` this model points another record with, or ``None``.

        Taken from the ORM: a stored ``many2one_reference`` and the char field
        it names (``mail.message.res_id`` → ``model``).
        """
        self.ensure_one()
        model = self.env[self.model]
        for name in sorted(model._fields):
            field = model._fields[name]
            if field.type == "many2one_reference" and field.store and field.model_field in model._fields:
                return field.model_field, name
        return None

    def _chatter_models(self):
        """The documents a message of the index may hang from: the ones the cron
        last found (``chatter_models``), or found now if it has not run yet."""
        self.ensure_one()
        found = json.loads(self.chatter_models) if self.chatter_models else self._documents_with_chatter()
        return [name for name in found if name in self.env]

    def _documents_with_chatter(self):
        """Every model that has messages and a chatter to search them through.

        A skip scan of ``mail_message``'s index on ``model``: one probe per
        distinct model, about 80 ms over 12 million messages. It says which
        models have messages, never whose, so it runs as the superuser.
        """
        self.env.cr.execute(
            """
            WITH RECURSIVE found(model) AS (
                SELECT min(model) FROM mail_message
                 UNION ALL
                SELECT (SELECT min(model) FROM mail_message WHERE model > found.model)
                  FROM found WHERE found.model IS NOT NULL
            )
            SELECT model FROM found WHERE model IS NOT NULL
            """
        )
        return [
            name
            for (name,) in self.env.cr.fetchall()
            if name in self.env
            and name not in UNSEARCHABLE_MODELS | {"mail.message"}
            and isinstance(self.env[name], self.pool["mail.thread"])
        ]

    def _prepare_run(self):
        """What a cron run settles before indexing: the layout, and for the
        chatter the documents it hangs from."""
        self._rebuild_outdated()
        # Only the chatter is searched through other records: its documents.
        if self.model == "mail.message":
            self._refresh_chatter_models()

    def _refresh_chatter_models(self):
        """Keep ``chatter_models`` current: a document that gets its first
        message becomes searchable on the next cron run."""
        found = json.dumps(self._documents_with_chatter())
        if self.chatter_models != found:
            self.chatter_models = found

    def _has_domain(self):
        """Whether only part of the model is indexed."""
        self.ensure_one()
        return bool(self.domain)

    def _domain_query(self, parsed=None):
        """The records the configured domain allows, as a ``Query``, or ``None``.

        As the superuser, archived included: the domain only says which records
        are indexed; each search still reads with the user's permissions.
        """
        self.ensure_one()
        if parsed is None:
            parsed = ast.literal_eval(self.domain) if self.domain else None
        domain = Domain(parsed) if parsed is not None else None
        if domain is None:
            return None
        return self.env[self.model].sudo().with_context(active_test=False)._search(domain)

    def _in_domain(self, column):
        """SQL asking whether ``column`` (an id of the model) is indexed at all."""
        query = self._domain_query()
        return SQL("TRUE") if query is None else SQL("%s IN %s", column, query.subselect())

    def _out_of_domain(self, column):
        """SQL asking the opposite of :meth:`_in_domain`.

        ``NOT EXISTS``, not ``NOT IN``: NOT IN cannot become an anti-join (NULL
        semantics) and is re-checked per row over millions of rows; ids are never
        NULL, so the answer is the same. ``select()``, not ``subselect()``: the
        latter may return a constant or the ids, with no ``id`` column to join.
        """
        query = self._domain_query()
        if query is None:
            return SQL("FALSE")
        return SQL("NOT EXISTS (SELECT 1 FROM (%s) indexable WHERE indexable.id = %s)", query.select(), column)

    # ─── Text extraction ─────────────────────────────────────────────────

    def _expected_layout_fields(self):
        """The configured fields in weight-label order: record name first, then by name."""
        self.ensure_one()
        model = self.env[self.model]
        names = sorted(self.field_ids.mapped("name"), key=lambda name: (name != model._rec_name, name))
        return ",".join(name for name in names if name in model._fields)

    def _weight_map(self):
        """``{field name: weight label}`` of the layout the index rows were built with.

        Stored, not recomputed: a field deleted by cascade never goes through
        ``write``, and recomputing would shift the labels of the fields after it.
        """
        self.ensure_one()
        names = (self.layout_fields or self._expected_layout_fields()).split(",")
        return {name: weight for weight, name in zip(text.WEIGHTS, names, strict=False) if name}

    def _layout_intact(self):
        """Whether the indexed rows still describe exactly the configured fields."""
        self.ensure_one()
        return bool(self.layout_fields) and self.layout_fields == self._expected_layout_fields()

    def _indexed_fields(self):
        """Field objects of the layout that still exist, in weight-label order."""
        self.ensure_one()
        model = self.env[self.model]
        configured = set(self.field_ids.mapped("name"))
        return [model._fields[name] for name in self._weight_map() if name in configured and name in model._fields]

    def _field_text(self, field, value):
        """Plain text for one field value. **Extension point.**

        Used both when indexing (the raw value; a ``dict`` for translations) and
        when reading for the user, so matched text is indexed text. Override to
        clean a model's text, e.g. quoted replies in ``mail.message.body``.
        """
        if not value:
            return ""
        if isinstance(value, dict):
            # Translations: every language is searchable.
            value = "\n".join(dict.fromkeys(v for v in value.values() if v))
        if field.type == "html":
            return html2plaintext(value, include_references=False)
        return str(value)

    def _text_parts(self, values, fields_=None):
        """``[(weight, text)]`` for one record (``{field_name: value}``).

        ``fields_`` restricts the parts to some of the indexed fields (the ones a
        user can read) without changing their weight labels.
        """
        self.ensure_one()
        indexed = self._indexed_fields()
        weights = self._weight_map()
        wanted = {field.name for field in (fields_ if fields_ is not None else indexed)}
        parts, budget = [], MAX_TEXT_CHARS
        for field in indexed:
            weight = weights[field.name]
            if field.name not in wanted or budget <= 0:
                continue
            content = self._field_text(field, values.get(field.name))[:budget]
            if content:
                parts.append((weight, content))
                budget -= len(content)
        return parts

    def _marker(self):
        """A lexeme only this model's current-layout rows carry.

        All models share one GIN index; the lexeme keeps other models' postings
        out (a partner search for "odoo" next to tasks: 137k TIDs → 14k, 16 →
        10 ms). The colon keeps it out of reach of any query term.
        """
        self.ensure_one()
        return f"search:config:{self.id}:{self.layout}"

    def _upsert_documents(self, rows):
        """Index ``rows``: ``(res_id, write_date, {field: raw value})`` tuples.

        A record without any searchable text gets no row (and loses the one it
        had): an empty row would only weigh.
        """
        self.ensure_one()
        if not rows:
            return
        # Ascending ids: a stable lock order if two runs ever overlap.
        rows = sorted(rows, key=lambda row: row[0])
        marker = self._marker()
        entries, empty = [], []
        for res_id, write_date, values in rows:
            vector = text.build_tsvector(self._text_parts(values), extra_lexemes=[marker])
            if vector is None:
                empty.append(res_id)
            else:
                entries.append((res_id, write_date, vector))
        cr = self.env.cr
        if empty:
            cr.execute(
                SQL("DELETE FROM search_relevant_document WHERE config_id = %s AND res_id = ANY(%s)", self.id, empty)
            )
        if not entries:
            return
        try:
            with cr.savepoint(flush=False):
                self._insert_entries(entries)
        except PG_CONCURRENCY_EXCEPTIONS_TO_RETRY:
            # Odoo retries the whole transaction; skipping would keep the old row.
            raise
        except psycopg2.Error:
            # One bad record must not stop the backfill at this batch forever
            # (Odoo deactivates a cron that keeps failing). Retry one by one and
            # skip what still fails.
            for entry in entries:
                try:
                    with cr.savepoint(flush=False):
                        self._insert_entries([entry])
                except PG_CONCURRENCY_EXCEPTIONS_TO_RETRY:
                    raise
                except psycopg2.Error as error:
                    _logger.warning(
                        "search.relevant: could not index %s,%s: %s", self.model, entry[0], error.pgerror or error
                    )

    def _insert_entries(self, entries):
        self.env.cr.execute(
            SQL(
                """
                INSERT INTO search_relevant_document (config_id, res_id, layout, source_write_date, indexed_at, tsv)
                SELECT %(config)s, v.res_id, %(layout)s, v.write_date, %(now)s, v.tsv
                  FROM unnest(%(ids)s::int[], %(dates)s::timestamp[], %(vectors)s::tsvector[]) AS v(res_id, write_date, tsv)
                ON CONFLICT (config_id, res_id) DO UPDATE
                   SET layout = EXCLUDED.layout,
                       source_write_date = EXCLUDED.source_write_date,
                       indexed_at = EXCLUDED.indexed_at,
                       tsv = EXCLUDED.tsv
                 -- A pass that read the record before a newer write must not undo it.
                 -- A NULL write_date (old data) counts as the oldest, not as unknown.
                 WHERE COALESCE(search_relevant_document.source_write_date, '-infinity')
                       <= COALESCE(EXCLUDED.source_write_date, '-infinity')
                """,
                config=self.id,
                layout=self.layout,
                now=self.env.cr.now(),
                ids=[entry[0] for entry in entries],
                dates=[entry[1] for entry in entries],
                vectors=[entry[2] for entry in entries],
            )
        )

    def _select_source(self, where, order, limit):
        """Read id, dates and the indexed columns straight from the table.

        SQL, not the ORM: the indexer runs as superuser over the whole table and
        must not trigger computes or load every column. The ``domain`` is part of
        every read.
        """
        self.ensure_one()
        indexed_fields = self._indexed_fields()
        # Pending ORM writes of this transaction would be invisible to the SQL below.
        self.env[self.model].flush_model(["write_date", *(field.name for field in indexed_fields)])
        columns = [SQL.identifier("t", field.name) for field in indexed_fields]
        rows = self.env.execute_query(
            SQL(
                "SELECT t.id, t.write_date, t.create_date, %s FROM %s t WHERE (%s) AND (%s) ORDER BY %s LIMIT %s",
                SQL(", ").join(columns),
                SQL.identifier(self._source_table()),
                where,
                self._in_domain(SQL.identifier("t", "id")),
                order,
                limit,
            )
        )
        names = [field.name for field in indexed_fields]
        return [(row[0], row[1], row[2], dict(zip(names, row[3:], strict=True))) for row in rows]

    # ─── Indexing steps ──────────────────────────────────────────────────

    def _backfill_remaining(self):
        """Records the backfill still has to index, as it counted them.

        An estimate: an exact count scans the table on every run, and this only
        feeds the progress the cron reports.
        """
        self.ensure_one()
        if not self.backfill_cursor:
            return 0
        return max(self.backfill_total - self.backfill_done, 1)

    def _backfill_window(self, batch_size):
        """How many ids one backfill step looks at: about two batches of matches.

        Scaled by the density seen so far: the sparser the ``domain``, the wider
        the window. Too narrow only costs another step.
        """
        self.ensure_one()
        if not self.backfill_total:
            return 2 * batch_size
        remaining = max(self.backfill_total - self.backfill_done, 1)
        return 2 * batch_size * max(self.backfill_cursor // remaining, 1)

    def _backfill_batch(self, batch_size):
        """Index the next ``batch_size`` records below the cursor, newest first.

        Walks a bounded range of ids: unbounded, a selective ``domain`` over
        unindexed columns makes PostgreSQL read the whole table backwards, row
        by row.
        """
        self.ensure_one()
        if not self.backfill_cursor:
            return 0
        if not self.backfill_total:
            self._count_backfill()
        floor = max(self.backfill_cursor - self._backfill_window(batch_size), 0)
        rows = self._select_source(
            SQL("t.id >= %s AND t.id < %s", floor, self.backfill_cursor),
            SQL("t.id DESC"),
            batch_size,
        )
        self._upsert_documents([(res_id, write_date, values) for res_id, write_date, _create, values in rows])
        # A full batch stopped inside the window; a short one covered it whole.
        cursor = rows[-1][0] if len(rows) >= batch_size else floor
        indexed = self.backfill_done + len(rows)
        if cursor and indexed >= self.backfill_total:
            cursor = self._backfill_skip_ahead(cursor)
        if not cursor:
            # Fresh statistics for the planner once the backfill has filled the table.
            self.env.cr.execute("ANALYZE search_relevant_document")
        oldest = min((create for _id, _write, create, _values in rows if create), default=None)
        self.write(
            {
                "backfill_cursor": cursor,
                "backfill_done": indexed,
                "backfill_reached": False if not cursor else (oldest or self.backfill_reached),
            }
        )
        return len(rows)

    def _count_backfill(self):
        """Count the records the backfill has to index, in the cron and once.

        Feeds the progress, the window and (with a ``domain``) the population,
        never where the backfill ends (:meth:`_backfill_skip_ahead`).
        """
        self.ensure_one()
        ((total,),) = self.env.execute_query(
            SQL(
                "SELECT count(*) FROM %s t WHERE t.id < %s AND %s",
                SQL.identifier(self._source_table()),
                self.backfill_cursor,
                self._in_domain(SQL.identifier("t", "id")),
            )
        )
        self.backfill_total = total

    def _backfill_skip_ahead(self, cursor):
        """Where the backfill goes on once it has indexed everything it counted.

        The count is a lower bound: a record written *into* the ``domain`` after
        enabling adds one below the cursor. Stopping on the count would leave old
        records unindexed under ``complete`` coverage, and no other pass would
        pick them up. So the table answers: the newest record still below the
        cursor and in the ``domain``; ``0`` is the only end.
        """
        self.ensure_one()
        ((pending,),) = self.env.execute_query(
            SQL(
                "SELECT COALESCE(MAX(t.id), 0) FROM %s t WHERE t.id < %s AND %s",
                SQL.identifier(self._source_table()),
                cursor,
                self._in_domain(SQL.identifier("t", "id")),
            )
        )
        return pending + 1 if pending else 0

    def _sync_batch(self, batch_size, after=None):
        """Re-index records written since the last pass.

        Returns ``(count, more, last)``; pass ``last`` back as ``after`` to go on
        with the same pass. Walking by ``(write_date, id)`` instead of relying on
        the NOT EXISTS alone matters for records without searchable text: they
        keep no row, so they would be selected again forever.
        """
        self.ensure_one()
        if self.append_only:
            return self._sync_new_batch(batch_size, after)
        now = self.env.cr.now()
        since = (self.sync_watermark or now) - SYNC_MARGIN
        if after is None:
            self._drop_left_domain(since)
        rows = self._select_source(
            SQL(
                """
                t.write_date >= %s AND (%s OR (t.write_date, t.id) > (%s, %s)) AND NOT EXISTS (
                    SELECT 1 FROM search_relevant_document d
                     WHERE d.config_id = %s AND d.res_id = t.id
                       AND d.source_write_date = t.write_date AND d.layout = %s
                )
                """,
                since,
                after is None,
                after[0] if after else since,
                after[1] if after else 0,
                self.id,
                self.layout,
            ),
            SQL("t.write_date, t.id"),
            batch_size,
        )
        self._upsert_documents([(res_id, write_date, values) for res_id, write_date, _create, values in rows])
        more = len(rows) >= batch_size
        if not more:
            self._finish_sync(now, self._max_id())
        last = (rows[-1][1], rows[-1][0]) if rows else after
        return len(rows), more, last

    def _sync_new_batch(self, batch_size, after=None):
        """Index what was added since the last pass, walking by id (``append_only``).

        Returns ``(count, more, last)`` like :meth:`_sync_batch`, with ``last``
        the ``(id, ceiling)`` to pass back. The ceiling is fixed at the start, so
        the pass always ends. No ``_drop_left_domain``: these records are never
        written; a changed ``domain`` goes with ``_purge_deleted``.
        """
        self.ensure_one()
        now = self.env.cr.now()
        if after is None:
            ceiling = self._max_id()
            start = self.sync_cursor
        else:
            start, ceiling = after
        rows = self._select_source(
            SQL(
                """
                t.id > %s AND t.id <= %s AND NOT EXISTS (
                    SELECT 1 FROM search_relevant_document d
                     WHERE d.config_id = %s AND d.res_id = t.id AND d.layout = %s
                )
                """,
                start,
                ceiling,
                self.id,
                self.layout,
            ),
            SQL("t.id"),
            batch_size,
        )
        self._upsert_documents([(res_id, write_date, values) for res_id, write_date, _create, values in rows])
        if len(rows) >= batch_size:
            return len(rows), True, (rows[-1][0], ceiling)
        self._finish_sync(now, ceiling)
        return len(rows), False, None

    @api.model
    def _edit_config(self, model_name):
        """The active configuration of ``model_name``, searched on every write, without cache.

        ``active`` is explicit: the writer's context may carry ``active_test=False``.
        """
        return self.search([("model", "=", model_name), ("active", "=", True)], limit=1)

    def _write_dates(self, records):
        """``{id: write_date}`` of ``records`` as stored, before a write moves it."""
        self.ensure_one()
        records.flush_recordset(["write_date"])
        return dict(
            self.env.execute_query(
                SQL(
                    "SELECT id, write_date FROM %s WHERE id = ANY(%s)",
                    SQL.identifier(self._source_table()),
                    records.ids,
                )
            )
        )

    def _reindex_edited(self, records, written, before):
        """Re-index ``records`` now, after a write to the fields ``written``.

        For a model the freshness pass does not re-read (``append_only``): an
        edit, or Odoo's "delete" of a message (its body emptied), would keep
        its old words in the index for good. A record left without text, or
        out of the ``domain``, loses its row.

        Any other write (starring, pinning, moving a message to another
        document) keeps the text but moves ``write_date`` past the row, which
        then stops answering (see ``_chatter_scope``): the rows that were up to
        date (``before``, see ``_touch_documents``) only take the new date,
        nothing is read nor tokenized.

        In a savepoint: a failing index must not fail the write, and the row it
        leaves is older than its record, so it never answers. Concurrency
        errors go up, for Odoo to retry the request.
        """
        self.ensure_one()
        # Outside the savepoint: an error of the write itself is not ours to hide.
        self.env.flush_all()
        try:
            with self.env.cr.savepoint(flush=False):
                if written & set(self.field_ids.mapped("name")):
                    self._reindex_ids(records.ids)
                else:
                    self._touch_documents(before)
        except PG_CONCURRENCY_EXCEPTIONS_TO_RETRY:
            raise
        except Exception:
            _logger.exception("search.relevant: could not re-index %s %s", records._name, records.ids)

    def _reindex_ids(self, ids):
        """Read and index ``ids`` again; the ones gone from the source lose their row."""
        self.ensure_one()
        for batch in split_every(self._batch_size(), sorted(ids), list):
            rows = self._select_source(SQL("t.id = ANY(%s)", batch), SQL("t.id"), len(batch))
            self._upsert_documents([(res_id, write_date, values) for res_id, write_date, _create, values in rows])
            gone = set(batch) - {row[0] for row in rows}
            if gone:
                self.env.execute_query(
                    SQL(
                        "DELETE FROM search_relevant_document WHERE config_id = %s AND res_id = ANY(%s)",
                        self.id,
                        sorted(gone),
                    )
                )

    def _touch_documents(self, before):
        """Give the rows of ``before`` (``{id: write_date before the write}``) the
        ``write_date`` of their record: its text did not change.

        Only a row that had that date holds the text of the record. An older one
        (an earlier re-index that failed) may hold words already removed, and is
        indexed again instead: taking the new date would make them answer.
        A record out of the ``domain`` keeps its old date, so its row stops answering.
        """
        self.ensure_one()
        for batch in split_every(self._batch_size(), sorted(before), list):
            previous = SQL(
                "unnest(%s::int[], %s::timestamp[]) AS p(id, written)", batch, [before[res_id] for res_id in batch]
            )
            stale = self.env.execute_query(
                SQL(
                    """
                    SELECT d.res_id
                      FROM search_relevant_document d
                      JOIN %(previous)s ON p.id = d.res_id
                     WHERE d.config_id = %(config)s AND d.source_write_date IS DISTINCT FROM p.written
                    """,
                    previous=previous,
                    config=self.id,
                )
            )
            self.env.execute_query(
                SQL(
                    """
                    UPDATE search_relevant_document d
                       SET source_write_date = t.write_date
                      FROM %(table)s t, %(previous)s
                     WHERE d.config_id = %(config)s AND p.id = d.res_id
                       AND d.source_write_date IS NOT DISTINCT FROM p.written
                       AND t.id = d.res_id AND %(indexed)s
                    """,
                    table=SQL.identifier(self._source_table()),
                    previous=previous,
                    config=self.id,
                    indexed=self._in_domain(SQL.identifier("t", "id")),
                )
            )
            if stale:
                self._reindex_ids([res_id for (res_id,) in stale])

    def _max_id(self):
        ((max_id,),) = self.env.execute_query(
            SQL("SELECT COALESCE(MAX(t.id), 0) FROM %s t", SQL.identifier(self._source_table()))
        )
        return max_id

    def _finish_sync(self, now, ceiling):
        """Close a finished freshness pass: move the watermark, and promote the
        id ``ceiling`` it reached once ``SYNC_ID_MARGIN`` has passed.

        Invariant: every id at or below ``sync_cursor`` is indexed as some pass
        read it, left to the backfill, or outside the domain. It assumes no
        transaction holds an id longer than ``SYNC_ID_MARGIN``: one that does
        commits below the cursor, and only the ``write_date`` pass finds it
        (never, under ``append_only``).
        """
        values = {"sync_watermark": now}
        if not self.sync_reached_at or now - self.sync_reached_at >= SYNC_ID_MARGIN:
            # Everything below ``sync_reached`` has had SYNC_ID_MARGIN to commit,
            # and this pass read it. Promoting today's ceiling would leave no margin.
            values["sync_cursor"] = max(self.sync_reached, self.sync_cursor)
            values["sync_reached"] = max(ceiling, self.sync_reached)
            values["sync_reached_at"] = now
        self.write(values)

    def _drop_left_domain(self, since):
        """Drop the rows of records written out of the ``domain``. Returns how many.

        Over the window the freshness pass already walks. A domain change (no
        write) goes with ``_purge_deleted``.
        """
        self.ensure_one()
        if not self._has_domain():
            return 0
        self.env[self.model].flush_model(["write_date"])
        self.env.execute_query(
            SQL(
                """
                DELETE FROM search_relevant_document d
                 USING %(table)s t
                 WHERE d.config_id = %(config)s AND t.id = d.res_id
                   AND t.write_date >= %(since)s AND %(outside)s
                """,
                table=SQL.identifier(self._source_table()),
                config=self.id,
                since=since,
                outside=self._out_of_domain(SQL.identifier("t", "id")),
            )
        )
        return self.env.cr.rowcount

    def _purge_deleted(self):
        """Drop rows whose record no longer exists, or no longer matches the
        ``domain``. Returns how many. Daily, or on the next run after a domain
        change.
        """
        self.ensure_one()
        self.env.execute_query(
            SQL(
                """
                DELETE FROM search_relevant_document d
                 WHERE d.config_id = %s
                   AND (NOT EXISTS (SELECT 1 FROM %s t WHERE t.id = d.res_id) OR %s)
                """,
                self.id,
                SQL.identifier(self._source_table()),
                self._out_of_domain(SQL.identifier("d", "res_id")),
            )
        )
        purged = self.env.cr.rowcount
        self.last_purge_at = self.env.cr.now()
        return purged

    def _rebuild_outdated(self):
        """Re-index, under a new layout, the models whose rows no longer match:
        built by an earlier rule, or with a field that has since disappeared."""
        outdated = self.filtered(
            lambda config: config.normalization != NORMALIZATION_VERSION or not config._layout_intact()
        )
        for config in outdated:
            config.write({"layout": config.layout + 1, "layout_fields": config._expected_layout_fields()})
        outdated._start_indexing()

    @api.model
    def _batch_size(self):
        param = self.env["ir.config_parameter"].sudo().get_param("base_search_relevant.batch_size")
        try:
            return max(int(param), 1) if param else DEFAULT_BATCH_SIZE
        except ValueError:
            return DEFAULT_BATCH_SIZE

    @api.model
    def _run_isolated(self, config, step, failed):
        """Run one step of one model in its own savepoint: a model that fails is
        logged and skipped until the next run, and the others go on."""
        if config.id in failed:
            return None
        try:
            with self.env.cr.savepoint():
                return step()
        except Exception:
            _logger.exception("search.relevant: indexing %s failed; the other models go on", config.model)
            self.env.invalidate_all()
            failed.add(config.id)
            return None

    @api.model
    def _cron_index(self):
        """Keep every enabled model's index complete and current.

        While a backfill has records left, ``_commit_progress`` reports them and
        Odoo runs the job again right away; then it falls back to its interval.
        With no model enabled it deactivates itself; enabling one wakes it.
        """
        IrCron = self.env["ir.cron"]
        # A model whose module is being uninstalled is still configured but no
        # longer loaded; its configuration goes away with the module.
        configs = self.search([]).filtered(lambda config: config.model in self.env)
        archived = self.with_context(active_test=False).search([("active", "=", False), ("cleanup_pending", "=", True)])
        if not configs and not archived:
            IrCron._commit_progress(deactivate=True)
            return

        failed = set()

        def isolated(config, step):
            return self._run_isolated(config, step, failed)

        for config in configs:
            isolated(config, config._prepare_run)

        batch_size = self._batch_size()
        pending = {config.id: config._backfill_remaining() for config in configs}
        more = set()  # (step, config id) that stopped with work left

        def remaining():
            return sum(pending[config_id] for config_id in pending if config_id not in failed) + len(more)

        time_left = IrCron._commit_progress(remaining=remaining())

        # Freshness first: a record someone just wrote is what they are most
        # likely to look for, and a long backfill must not delay it.
        for config in configs:
            last = None
            while time_left:
                result = isolated(config, lambda config=config, last=last: config._sync_batch(batch_size, last))
                if result is None:
                    more.discard(("sync", config.id))
                    break
                processed, has_more, last = result
                (more.add if has_more else more.discard)(("sync", config.id))
                time_left = IrCron._commit_progress(processed, remaining=remaining())
                if not has_more:
                    break

        now = self.env.cr.now()
        for config in configs:
            if time_left and (not config.last_purge_at or config.last_purge_at <= now - PURGE_INTERVAL):
                purged = isolated(config, config._purge_deleted)
                if purged:
                    _logger.info("search.relevant: purged %s deleted %s records from the index", purged, config.model)
                time_left = IrCron._commit_progress(purged or 0, remaining=remaining())

        for config in archived:
            while time_left:
                result = isolated(config, lambda config=config: config._cleanup_batch(CLEANUP_BATCH_SIZE))
                if result is None:
                    more.discard(("cleanup", config.id))
                    break
                deleted, has_more = result
                (more.add if has_more else more.discard)(("cleanup", config.id))
                time_left = IrCron._commit_progress(deleted, remaining=remaining())
                if not has_more:
                    break

        for config in configs:
            while time_left and config.backfill_cursor:
                processed = isolated(config, lambda config=config: config._backfill_batch(batch_size))
                if processed is None:
                    break
                pending[config.id] = 0 if not config.backfill_cursor else max(pending[config.id] - processed, 0)
                time_left = IrCron._commit_progress(processed, remaining=remaining())

        self._flush_pending_index()
        if not configs and not any(archived.mapped("cleanup_pending")):
            IrCron._commit_progress(deactivate=True)

    @api.model
    def _flush_pending_index(self):
        """Move the GIN pending list into the index, at the end of each cron run.

        Searches scan the pending list linearly. Turning ``fastupdate`` off made
        writes 60% slower (244 → 389 ms per batch of 500) with no visible search
        gain; one flush per run keeps both cheap.
        """
        self.env.cr.execute("SELECT gin_clean_pending_list('search_relevant_document_tsv_gin'::regclass)")
